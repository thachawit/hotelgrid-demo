package release

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/events"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/telemetry"
)

const root = "../../.."

func loadCfg(t *testing.T) (*config.Topology, *config.Sites) {
	t.Helper()
	topo, err := config.LoadTopology(root)
	if err != nil {
		t.Fatal(err)
	}
	sites, err := config.LoadSites(root)
	if err != nil {
		t.Fatal(err)
	}
	return topo, sites
}

// workspace with empty version files for every version the tests deploy
func tempWorkspace(t *testing.T, topo *config.Topology, extra map[string][]string) string {
	t.Helper()
	ws := t.TempDir()
	add := func(svc, ver string) {
		dir := filepath.Join(ws, "services", svc, "versions")
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, ver+".mjs"), []byte("export const routes = {};\n"), 0o644)
	}
	for svc, ver := range topo.InitialManifest {
		add(svc, ver)
	}
	for svc, vers := range extra {
		for _, v := range vers {
			add(svc, v)
		}
	}
	return ws
}

// fake control plane: /internal/tasks, /internal/ledger/trace-cost, /internal/signals
type fakeCP struct {
	mu    sync.Mutex
	tasks []map[string]any
}

func (f *fakeCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/internal/tasks":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.mu.Lock()
		f.tasks = append(f.tasks, b)
		f.mu.Unlock()
		httpx.WriteJSON(w, 200, map[string]any{"cluster": "CL-9", "workItem": "WI-7"})
	case "/internal/ledger/trace-cost":
		httpx.WriteJSON(w, 200, map[string]any{"cost": 0.0123, "calls": 4})
	case "/internal/signals":
		httpx.WriteJSON(w, 200, []map[string]any{
			{"source": "line", "roomId": "1001", "text": "App shows an error, room 1001", "symptom": "app-error"},
			{"source": "line", "roomId": "9999", "text": "unrelated: what time is breakfast", "symptom": "other"},
		})
	default:
		httpx.WriteJSON(w, 404, map[string]any{"error": "no route"})
	}
}

func newController(t *testing.T, timing Timing, extra map[string][]string) (*Controller, *telemetry.Store, *fakeCP, string) {
	t.Helper()
	topo, sites := loadCfg(t)
	cp := &fakeCP{}
	srv := httptest.NewServer(cp)
	t.Cleanup(srv.Close)
	tel := telemetry.New()
	rt := t.TempDir()
	c := New(Deps{
		Topo: topo, Sites: sites.Sites, Rings: sites.Rings, Workspace: tempWorkspace(t, topo, extra), Runtime: rt,
		Tel: tel, Events: &events.Pusher{Quiet: true}, CPURL: srv.URL, Timing: timing,
		Meta: func(_ context.Context, svc, ver string) VersionMeta {
			if svc == "rooms-svc" && ver == "2.4.0" {
				return VersionMeta{Breaking: []string{"GET /rooms/:id no longer returns field `occupancy` (use `occupancyStatus`)"}}
			}
			return VersionMeta{}
		},
	})
	return c, tel, cp, rt
}

// Node consumers call history.slice / releases.map: a fresh controller must send [] not null.
func TestFreshStateHasArraysNotNulls(t *testing.T) {
	c, _, _, _ := newController(t, DefaultTiming, nil)
	var st map[string]json.RawMessage
	if err := json.Unmarshal(c.StateJSON(), &st); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"releases", "history", "incidents", "drift"} {
		if string(st[k]) != "[]" {
			t.Errorf("%s = %s, want []", k, st[k])
		}
	}
	if string(st["freeze"]) != "null" || string(st["parityGate"]) != "false" {
		t.Errorf("freeze %s parity %s", st["freeze"], st["parityGate"])
	}
}

func TestRollbackOrderConsumersFirst(t *testing.T) {
	c, _, _, _ := newController(t, DefaultTiming, nil)
	if got := c.RollbackOrder([]string{"rooms-svc", "guest-assistant"}); strings.Join(got, ",") != "guest-assistant,rooms-svc" {
		t.Errorf("order = %v", got)
	}
	if got := c.RollbackOrder([]string{"rooms-svc", "hvac-optimizer"}); strings.Join(got, ",") != "hvac-optimizer,rooms-svc" {
		t.Errorf("order = %v", got)
	}
	if !contains(c.ConsumersOf([]string{"rooms-svc"}), "hvac-optimizer") {
		t.Errorf("hvac-optimizer consumes rooms-svc")
	}
}

func span(trace, id, parent, svc, ver, site string, status int, errMsg string, ts int64, attrs map[string]any) *telemetry.Span {
	if attrs == nil {
		attrs = map[string]any{}
	}
	return &telemetry.Span{TraceID: trace, SpanID: id, ParentID: parent, Service: svc, Version: ver, Site: site, Status: status, Ms: 5, Error: errMsg, Ts: ts, Attrs: attrs}
}

// Port of the Node test "culprit scoring blames the changed provider, not the loudest service".
func TestCulpritBlamesChangedProviderNotLoudest(t *testing.T) {
	tel := telemetry.New()
	t0 := config.NowMs() - 20000
	var spans []*telemetry.Span
	for i := 0; i < 12; i++ {
		tr, ts := "t"+string(rune('a'+i)), t0+2000+int64(i)*200
		spans = append(spans,
			span(tr, "a"+tr, "", "api-gateway", "5.2.0", "test-site", 502, "hvac-optimizer failed (500)", ts, nil),
			span(tr, "h"+tr, "a"+tr, "hvac-optimizer", "1.8.0", "test-site", 500, `Error: invalid room payload from rooms-svc: missing field "occupancy"`, ts, nil),
			span(tr, "r"+tr, "h"+tr, "rooms-svc", "2.4.0", "test-site", 200, "", ts, nil))
	}
	tel.Ingest(spans)
	c := ScoreCulprits(tel, "test-site", t0, t0+2000, t0+5000, []ServiceChange{
		{Service: "rooms-svc", From: "2.3.1", To: "2.4.0", Meta: VersionMeta{Breaking: []string{"GET /rooms/:id no longer returns field `occupancy`"}}},
		{Service: "guest-assistant", From: "3.0.2", To: "3.1.0"},
	})
	if c.Ranking[0].Service != "rooms-svc" {
		t.Fatalf("top = %+v", c.Ranking)
	}
	if c.Loudest.Service == "rooms-svc" {
		t.Errorf("loudest should be a symptom, got %v", c.Loudest)
	}
	for _, r := range c.Ranking {
		if r.Service == "hvac-optimizer" && r.Score >= c.Ranking[0].Score {
			t.Errorf("hvac scored %v ≥ top %v", r.Score, c.Ranking[0].Score)
		}
	}
	if c.Ranking[0].Sig != 1 || !strings.Contains(strings.Join(c.Ranking[0].Evidence, "; "), "release note says `occupancy` changed") {
		t.Errorf("signature evidence missing: %v", c.Ranking[0].Evidence)
	}
	if c.FailingTraces != 12 || c.TopMessage == nil {
		t.Errorf("failing=%d top=%v", c.FailingTraces, c.TopMessage)
	}
}

func TestCanaryGateFlagsErrorRateAndKPI(t *testing.T) {
	tel := telemetry.New()
	now := config.NowMs()
	deploy := now - 20000
	var spans []*telemetry.Span
	for i := 0; i < 200; i++ { // healthy baseline
		ts := deploy - 50000 + int64(i)*200
		spans = append(spans, span("b", "s", "", "api-gateway", "5.2.0", "x", 200, "", ts, nil))
		spans = append(spans, span("b", "s", "", "hvac-optimizer", "1.8.0", "x", 200, "", ts, map[string]any{"mismatch": false}))
		spans[len(spans)-1].Route = "POST /setpoint"
	}
	for i := 0; i < 60; i++ { // after deploy: 30% errors at the edge, mismatches up
		ts := deploy + 2000 + int64(i)*250
		st := 200
		if i%3 == 0 {
			st = 502
		}
		spans = append(spans, span("c", "s", "", "api-gateway", "5.2.0", "x", st, "boom", ts, nil))
		h := span("c", "s", "", "hvac-optimizer", "1.8.0", "x", 200, "", ts, map[string]any{"mismatch": i%2 == 0})
		h.Route = "POST /setpoint"
		spans = append(spans, h)
	}
	tel.Ingest(spans)
	g := Evaluate(tel, "x", []string{"api-gateway", "hvac-optimizer"}, deploy, now, true)
	if g.Pass {
		t.Fatalf("gate passed: %+v", g.Checks)
	}
	got := strings.Join(g.Failed, ",")
	if !strings.Contains(got, "api-gateway fail:error-rate") || !strings.Contains(got, "setpoint_mismatch_rate fail:kpi") {
		t.Errorf("failed = %v", g.Failed)
	}
	if g.Checks[0].TopError != "boom" {
		t.Errorf("topError = %v", g.Checks[0].TopError)
	}
	quiet := Evaluate(telemetry.New(), "x", []string{"api-gateway"}, deploy, now, true)
	if !quiet.Pass || !quiet.Insufficient {
		t.Errorf("no data should pass as insufficient: %+v", quiet)
	}
}

func waitSettled(t *testing.T, c *Controller, id string, d time.Duration) Release {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		b, _ := c.Release(id)
		var r Release
		_ = json.Unmarshal(b, &r)
		if r.Settled {
			return r
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("release %s did not settle", id)
	return Release{}
}

func services(kv ...string) config.OrderedStrings {
	o := config.NewOrderedStrings()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i], kv[i+1])
	}
	return o
}

func TestRolloutCompletesThroughAllRings(t *testing.T) {
	c, _, _, _ := newController(t, Timing{GateEvery: 5 * time.Millisecond, RollbackStep: time.Millisecond, RecoveryPoll: time.Millisecond, RecoveryTries: 1, BakeScale: 0.002}, map[string][]string{"hvac-optimizer": {"1.8.1"}})
	rel := c.StartRollout(RolloutReq{Name: "hvac fix", Services: services("hvac-optimizer", "1.8.1"), Level: "L2", Actor: "factory"})
	r := waitSettled(t, c, rel.ID, 5*time.Second)
	if r.Status != "complete" || len(r.Rings) != 3 {
		t.Fatalf("release = %s, rings %d", r.Status, len(r.Rings))
	}
	for site, m := range c.Manifests() {
		if m["hvac-optimizer"] != "1.8.1" {
			t.Errorf("%s runs hvac %s", site, m["hvac-optimizer"])
		}
	}
	var st struct {
		History []ManifestChange `json:"history"`
	}
	_ = json.Unmarshal(c.StateJSON(), &st)
	if len(st.History) != 5 || st.History[0].Release == nil || *st.History[0].Release != rel.ID {
		t.Errorf("history = %+v", st.History)
	}
	if b, _ := json.Marshal(r.Services); string(b) != `{"hvac-optimizer":"1.8.1"}` {
		t.Errorf("services json = %s", b)
	}
}

func TestFreezeAndParityGateBlock(t *testing.T) {
	c, _, _, _ := newController(t, Timing{GateEvery: 5 * time.Millisecond, RollbackStep: time.Millisecond, RecoveryPoll: time.Millisecond, RecoveryTries: 1, BakeScale: 0.002}, map[string][]string{"rooms-svc": {"2.4.0"}, "hvac-optimizer": {"1.9.0-rc1"}})
	c.mu.Lock()
	c.freeze = &Freeze{Reason: "INC-1 at bkk-pilot", Incident: "INC-1"}
	c.mu.Unlock()
	r := waitSettled(t, c, c.StartRollout(RolloutReq{Name: "r2", Services: services("rooms-svc", "2.4.0")}).ID, 2*time.Second)
	if r.Status != "blocked:freeze" {
		t.Errorf("freeze: %s", r.Status)
	}
	c.LiftFreeze("")
	// staging runs hvac 1.9.0-rc1 (drift), prod runs 1.8.0: parity gate must stop rooms-svc 2.4.0 before ring 1
	if _, err := c.SetVersion("staging", "hvac-optimizer", "1.9.0-rc1", "team-energy", "pre-release"); err != nil {
		t.Fatal(err)
	}
	var st struct {
		Drift []Drift `json:"drift"`
	}
	_ = json.Unmarshal(c.StateJSON(), &st)
	if len(st.Drift) != 1 || st.Drift[0].Service != "hvac-optimizer" {
		t.Errorf("drift = %+v", st.Drift)
	}
	c.SetParity(true)
	r = waitSettled(t, c, c.StartRollout(RolloutReq{Name: "r2", Services: services("rooms-svc", "2.4.0")}).ID, 2*time.Second)
	if r.Status != "blocked:parity" || r.Rings[1].Parity == nil || r.Rings[1].Parity.Problems[0].Service != "hvac-optimizer" {
		t.Errorf("parity: %s %+v", r.Status, r.Rings)
	}
	if c.Manifests()["bkk-pilot"]["rooms-svc"] != "2.3.1" {
		t.Errorf("pilot must not receive the release")
	}
	if _, err := c.SetVersion("staging", "rooms-svc", "9.9.9", "x", ""); err == nil {
		t.Errorf("unknown version must be rejected")
	}
}

// End to end: a release breaks the pilot hotel; the gate trips; consumer-first rollback; report; fix task.
func TestGateFailureRollsBackReportsAndOpensFixTask(t *testing.T) {
	timing := Timing{GateEvery: 100 * time.Millisecond, RollbackStep: 10 * time.Millisecond, RecoveryPoll: 250 * time.Millisecond, RecoveryTries: 30, BakeScale: 0.25} // recovery window is 4 s of edge traffic
	c, tel, cp, rt := newController(t, timing, map[string][]string{"rooms-svc": {"2.4.0"}, "guest-assistant": {"3.1.0"}})
	now := config.NowMs()
	var base []*telemetry.Span
	for i := 0; i < 150; i++ { // healthy pilot baseline before the deploy
		base = append(base, span("b"+string(rune(i)), "e", "", "api-gateway", "5.2.0", "bkk-pilot", 200, "", now-55000+int64(i)*300, nil))
	}
	tel.Ingest(base)

	// traffic generator: while the pilot runs rooms-svc 2.4.0, setpoint calls fail with the contract error
	var stop atomic.Bool
	var n atomic.Int64
	go func() {
		for !stop.Load() {
			bad := c.Manifests()["bkk-pilot"]["rooms-svc"] == "2.4.0"
			i := n.Add(1)
			tr := "tr" + string(rune(i))
			ts := config.NowMs()
			if bad {
				tel.Ingest([]*telemetry.Span{
					span(tr, "a"+tr, "", "api-gateway", "5.2.0", "bkk-pilot", 502, "hvac-optimizer failed (500)", ts, map[string]any{"roomId": "1001", "guestId": "G-1"}),
					span(tr, "h"+tr, "a"+tr, "hvac-optimizer", "1.8.0", "bkk-pilot", 500, `Error: invalid room payload from rooms-svc: missing field "occupancy"`, ts, nil),
					span(tr, "r"+tr, "h"+tr, "rooms-svc", "2.4.0", "bkk-pilot", 200, "", ts, nil),
				})
			} else {
				tel.Ingest([]*telemetry.Span{span(tr, "a"+tr, "", "api-gateway", "5.2.0", "bkk-pilot", 200, "", ts, nil)})
			}
			time.Sleep(15 * time.Millisecond)
		}
	}()
	defer stop.Store(true)

	rel := c.StartRollout(RolloutReq{Name: "2026.11-r2", Services: services("rooms-svc", "2.4.0", "guest-assistant", "3.1.0"), Level: "L3", Actor: "release-eng"})
	r := waitSettled(t, c, rel.ID, 20*time.Second)
	if r.Status != "rolled-back" {
		t.Fatalf("release status %s", r.Status)
	}
	var st struct {
		Incidents []Incident                   `json:"incidents"`
		Manifests map[string]map[string]string `json:"manifests"`
		Freeze    *Freeze                      `json:"freeze"`
		Parity    bool                         `json:"parityGate"`
	}
	_ = json.Unmarshal(c.StateJSON(), &st)
	if len(st.Incidents) != 1 {
		t.Fatalf("incidents = %d", len(st.Incidents))
	}
	inc := st.Incidents[0]
	if inc.Status != "mitigated" || inc.Culprit.Ranking[0].Service != "rooms-svc" || inc.FixTask != "WI-7" {
		t.Errorf("incident: status=%s top=%s fix=%s", inc.Status, inc.Culprit.Ranking[0].Service, inc.FixTask)
	}
	if strings.Join(inc.RollbackOrder, ",") != "guest-assistant,rooms-svc" {
		t.Errorf("rollback order %v", inc.RollbackOrder)
	}
	if st.Manifests["bkk-pilot"]["rooms-svc"] != "2.3.1" || st.Manifests["bkk-riverside"]["rooms-svc"] != "2.3.1" {
		t.Errorf("manifests after rollback: %v", st.Manifests)
	}
	if st.Freeze == nil || !st.Parity {
		t.Errorf("freeze %v parity %v", st.Freeze, st.Parity)
	}
	if inc.Report == nil || inc.Report.Markdown != "" || inc.Report.Numbers.EdgeFailed == 0 || inc.Report.Numbers.Rooms != 1 || inc.Report.Numbers.LinkedSignals != 1 {
		t.Errorf("state report should carry numbers only: %+v", inc.Report)
	}
	md, err := os.ReadFile(filepath.Join(rt, "reports", inc.ID+".md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# INC-1 — 2026.11-r2 rolled back at bkk-pilot", "Culprit: **rooms-svc@2.4.0**", "| LLM spend on failed traces | $0.0123 over 4 calls",
		"Ring limits held: bkk-riverside, phuket-beach, chiangmai-oldtown never received the release.", "> LINE · room 1001: App shows an error, room 1001"} {
		if !strings.Contains(string(md), want) {
			t.Errorf("report missing %q", want)
		}
	}
	full, _ := c.Incident(inc.ID)
	if !strings.Contains(string(full), `<h1>INC-1`) {
		t.Errorf("full incident should carry the HTML report")
	}
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.tasks) != 1 || cp.tasks[0]["origin"] != "incident" || !strings.Contains(httpx.Str(cp.tasks[0]["text"]), "INC-1: rooms-svc@2.4.0 contract change broke") {
		t.Errorf("fix task: %+v", cp.tasks)
	}
}
