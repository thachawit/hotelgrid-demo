package release

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/markdown"
	"hotelgrid/internal/telemetry"
)

// mustJSON marshals like JSON.stringify: no HTML escaping (reports carry <h1>, <table>…).
func mustJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// handleGateFailure: freeze, culprit scoring, consumer-first rollback, recovery check, impact report, L1
// remediations and a follow-up fix task through the factory (port of incidents.mjs handleGateFailure).
func (c *Controller) handleGateFailure(rel *Release, sites []string, prev map[string]map[string]string, failed *failure, deployTs int64, changed []string) *Incident {
	ctx := context.Background()
	site := failed.site
	detectedAt := config.NowMs()
	anomalyStart := deployTs
	var firstErr *telemetry.Span
	for _, s := range c.d.Tel.SpansIn(site, deployTs, detectedAt) {
		if s.Status >= 500 && (firstErr == nil || s.Ts < firstErr.Ts) {
			firstErr = s
		}
	}
	if firstErr != nil {
		anomalyStart = firstErr.Ts
	}
	c.mu.Lock()
	c.incSeq++
	inc := &Incident{ID: fmt.Sprintf("INC-%d", c.incSeq), Status: "mitigating", Site: site, Release: rel.ID, ReleaseName: rel.Name,
		DeployTs: deployTs, AnomalyStart: anomalyStart, DetectedAt: detectedAt, Steps: []Step{}, Gate: failed.gate}
	c.incidents = append([]*Incident{inc}, c.incidents...)
	c.mu.Unlock()
	step := func(title, detail string) {
		c.mu.Lock()
		inc.Steps = append(inc.Steps, Step{Ts: config.NowMs(), Title: title, Detail: detail})
		c.emit("incident", inc)
		c.mu.Unlock()
		msg := inc.ID + ": " + title
		if detail != "" {
			msg += " — " + detail
		}
		c.say("rollback", msg, "warn")
	}

	c.mu.Lock()
	c.freeze = &Freeze{Reason: fmt.Sprintf("%s at %s", inc.ID, site), Since: config.NowMs(), Incident: inc.ID}
	c.emit("freeze", c.freeze)
	c.mu.Unlock()
	step("Deploy freeze on", "no new rollouts until acknowledged")

	changes := make([]ServiceChange, 0, len(changed))
	for _, svc := range changed {
		to := rel.Services.M[svc]
		changes = append(changes, ServiceChange{Service: svc, From: prev[site][svc], To: to, Meta: c.d.Meta(ctx, svc, to)})
	}
	culprit := ScoreCulprits(c.d.Tel, site, deployTs, anomalyStart, detectedAt, changes)
	c.mu.Lock()
	inc.Culprit = culprit
	c.mu.Unlock()
	top := culprit.Ranking[0]
	step("Culprit scored", fmt.Sprintf("%s (score %s, confidence %s); loudest = %s", svcAt(top), config.Num(top.Score), config.Num(culprit.Confidence), loudestName(culprit)))

	order := c.RollbackOrder(changed)
	c.mu.Lock()
	inc.RollbackOrder = order
	c.mu.Unlock()
	for _, svc := range order {
		c.mu.Lock()
		relID := rel.ID
		for _, s := range sites {
			if _, err := c.setVersionLocked(s, svc, prev[s][svc], &relID, "rollback-controller", inc.ID); err != nil {
				c.mu.Unlock()
				c.say("rollback", fmt.Sprintf("%s: rollback of %s at %s failed: %v", inc.ID, svc, s, err), "error")
				c.mu.Lock()
			}
		}
		c.mu.Unlock()
		step("Rolled back "+svc, fmt.Sprintf("%s → %s on %s", rel.Services.M[svc], prev[sites[0]][svc], strings.Join(sites, ", ")))
		time.Sleep(c.d.Timing.RollbackStep)
	}
	c.mu.Lock()
	inc.MitigatedAt = config.NowMs()
	c.mu.Unlock()

	// recovery check: edge error rate back near the pre-deploy baseline
	base := c.d.Tel.Window(site, "api-gateway", deployTs-60000, deployTs)
	var recoveredAt int64
	for i := 0; i < c.d.Timing.RecoveryTries; i++ {
		time.Sleep(c.d.Timing.RecoveryPoll)
		now := config.NowMs()
		w := c.d.Tel.Window(site, "api-gateway", now-4000, now)
		if w.N >= 5 && w.ErrRate <= base.ErrRate+0.01 {
			recoveredAt = now
			break
		}
	}
	c.mu.Lock()
	inc.RecoveredAt = recoveredAt
	c.mu.Unlock()
	if recoveredAt > 0 {
		step("Recovered: edge error rate back to baseline", "")
	} else {
		step(fmt.Sprintf("Recovery not confirmed within %ds — paging owner", int(c.d.Timing.RecoveryPoll.Seconds()*float64(c.d.Timing.RecoveryTries))), "")
	}
	c.mu.Lock()
	if recoveredAt > 0 {
		inc.Status = "mitigated"
	} else {
		inc.Status = "needs-human"
	}
	c.mu.Unlock()

	report := c.buildImpact(ctx, inc, rel, sites, prev, changes)
	dir := filepath.Join(c.d.Runtime, "reports")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, inc.ID+".md"), []byte(report.Markdown), 0o644)
	c.mu.Lock()
	inc.Report = report
	fileCopy := *inc
	r := *report
	r.HTML = ""
	fileCopy.Report = &r
	var jb bytes.Buffer
	enc := json.NewEncoder(&jb)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(fileCopy)
	js := bytes.TrimRight(jb.Bytes(), "\n")
	c.mu.Unlock()
	_ = os.WriteFile(filepath.Join(dir, inc.ID+".json"), js, 0o644)
	step("Impact report written", "runtime/reports/"+inc.ID+".md")

	// L1 remediations (config only), then the code fix goes through the factory.
	c.mu.Lock()
	pilot := c.pilotSite()
	for _, svc := range c.d.Topo.ServiceOrder {
		_, _ = c.setVersionLocked("staging", svc, c.manifests[pilot][svc], nil, "rollback-controller", "L1: restore staging parity after "+inc.ID)
	}
	c.parityGate = true
	c.emit("freeze", c.freeze)
	c.mu.Unlock()
	c.say("rollback", inc.ID+": L1 remediations — staging reset to prod manifest; manifest parity gate ON", "info")

	topMsg := "null"
	if culprit.TopMessage != nil {
		topMsg = *culprit.TopMessage
	}
	res := httpx.Post(ctx, c.d.CPURL+"/internal/tasks", map[string]any{
		"origin": "incident", "symptom": "contract", "siteId": site,
		"text":     fmt.Sprintf("%s: %s contract change broke %s: %s", inc.ID, svcAt(top), loudestName(culprit), topMsg),
		"evidence": map[string]any{"incident": inc.ID, "errorSignatures": []string{"hvac-optimizer: " + topMsg}},
	}, 5*time.Second)
	if wi := httpx.Str(res.Body["workItem"]); res.OK() && wi != "" {
		c.mu.Lock()
		inc.FixTask = wi
		c.mu.Unlock()
		step("Fix task opened", wi+" → factory triage")
	} else if !res.OK() {
		c.say("rollback", fmt.Sprintf("%s: could not open the fix task (control plane returned %d)", inc.ID, res.Status), "error")
	}
	c.mu.Lock()
	c.emit("incident", inc)
	c.mu.Unlock()
	return inc
}

func (c *Controller) pilotSite() string {
	for _, s := range c.d.Sites {
		if s.Ring == 1 {
			return s.ID
		}
	}
	return "staging"
}

func svcAt(r Rank) string {
	if r.Version != nil && *r.Version != "" {
		return r.Service + "@" + *r.Version
	}
	return r.Service
}

func loudestName(c *Culprit) string {
	if c.Loudest == nil {
		return "undefined" // what the Node template printed
	}
	return c.Loudest.Service
}

type signal struct {
	Source  string `json:"source"`
	RoomID  any    `json:"roomId"`
	Text    string `json:"text"`
	Symptom string `json:"symptom"`
}

func keyOf(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return config.Num(x)
	case nil:
		return ""
	default:
		return fmt.Sprint(x)
	}
}

// buildImpact writes the markdown impact report (port of incidents.mjs buildImpact; same wording and tables).
func (c *Controller) buildImpact(ctx context.Context, inc *Incident, rel *Release, sites []string, prev map[string]map[string]string, changes []ServiceChange) *Report {
	c.mu.Lock()
	snap := *inc
	steps := append([]Step(nil), inc.Steps...)
	staging := map[string]string{}
	for k, v := range c.manifests["staging"] {
		staging[k] = v
	}
	current := map[string]string{}
	for k, v := range c.manifests[inc.Site] {
		current[k] = v
	}
	lastRing := "?"
	if n := len(rel.Rings); n > 0 {
		lastRing = fmt.Sprint(rel.Rings[n-1].Ring)
	}
	c.mu.Unlock()

	site := snap.Site
	end := snap.RecoveredAt
	if end == 0 {
		end = snap.MitigatedAt
	}
	if end == 0 {
		end = config.NowMs()
	}
	spans := c.d.Tel.SpansIn(site, snap.AnomalyStart, end)
	var edge, edgeFail int
	rooms, guests := map[string]bool{}, map[string]bool{}
	failedTraces := map[string]bool{}
	var traceOrder []string
	hvacLost, chatsFailed := 0, 0
	for _, s := range spans {
		if s.Status >= 500 && !failedTraces[s.TraceID] {
			failedTraces[s.TraceID] = true
			traceOrder = append(traceOrder, s.TraceID)
		}
		if s.Service == "api-gateway" {
			edge++
			if s.Status >= 500 {
				edgeFail++
				if telemetry.Truthy(s.Attrs["roomId"]) {
					rooms[keyOf(s.Attrs["roomId"])] = true
				}
				if telemetry.Truthy(s.Attrs["guestId"]) {
					guests[keyOf(s.Attrs["guestId"])] = true
				}
			}
		}
		if s.Service == "hvac-optimizer" && s.Status >= 500 {
			hvacLost++
		}
		if s.Service == "guest-assistant" && s.Route == "POST /chat" && s.Status >= 500 {
			chatsFailed++
		}
	}
	llmCost, llmCalls := 0.0, 0
	if len(traceOrder) > 0 {
		r := httpx.Post(ctx, c.d.CPURL+"/internal/ledger/trace-cost", map[string]any{"traceIds": traceOrder}, 5*time.Second)
		if r.OK() {
			if f, ok := r.Body["cost"].(float64); ok {
				llmCost = f
			}
			if f, ok := r.Body["calls"].(float64); ok {
				llmCalls = int(f)
			}
		}
	}
	// link only signals that plausibly relate: same rooms as failed requests, or app-error reports
	var linked []signal
	q := url.Values{"site": {site}, "from": {fmt.Sprint(snap.AnomalyStart)}, "to": {fmt.Sprint(end + 30000)}}
	if r := httpx.Get(ctx, c.d.CPURL+"/internal/signals?"+q.Encode(), 5*time.Second); r.OK() {
		var all []signal
		_ = r.Decode(&all)
		for _, s := range all {
			if rooms[keyOf(s.RoomID)] || s.Symptom == "app-error" {
				linked = append(linked, s)
			}
		}
	}
	var driftNotes []string
	var changedSvcs []string
	for _, ch := range changes {
		changedSvcs = append(changedSvcs, ch.Service)
	}
	for _, svc := range c.ConsumersOf(changedSvcs) {
		if contains(changedSvcs, svc) {
			continue
		}
		pv, ok := prev[site][svc]
		if !ok {
			pv = current[svc]
		}
		if staging[svc] != pv {
			driftNotes = append(driftNotes, fmt.Sprintf("staging ran **%s@%s** while %s ran **%s@%s**", svc, staging[svc], site, svc, pv))
		}
	}
	var migrations []string
	for _, ch := range changes {
		migrations = append(migrations, ch.Meta.Migrations...)
	}
	top := snap.Culprit.Ranking[0]
	sec := func(a, b int64) string {
		if a == 0 || b == 0 {
			return "n/a"
		}
		return config.Num(config.Round(float64(b-a)/1000)) + "s"
	}
	t := func(ts int64) string {
		if ts == 0 {
			return "—"
		}
		return time.UnixMilli(ts).UTC().Format("15:04:05")
	}
	var untouched []string
	for _, s := range c.d.Sites {
		if !contains(sites, s.ID) && s.Ring > 0 {
			untouched = append(untouched, s.ID)
		}
	}
	var svcList []string
	for _, k := range rel.Services.Keys {
		svcList = append(svcList, k+"@"+rel.Services.M[k])
	}
	recovered := "had not recovered when this report was written"
	if snap.RecoveredAt > 0 {
		recovered = "returned to baseline"
	}
	ringLimits := ""
	if len(untouched) > 0 {
		ringLimits = "Ring limits held: " + strings.Join(untouched, ", ") + " never received the release."
	}
	edgePct := 0.0
	if edge > 0 {
		edgePct = config.Round(float64(edgeFail) / float64(edge) * 100)
	}
	var quotes []string
	for i, s := range linked {
		if i == 5 {
			break
		}
		room := keyOf(s.RoomID)
		if room == "" {
			room = "?"
		}
		quotes = append(quotes, fmt.Sprintf("> %s · room %s: %s", strings.ToUpper(s.Source), room, s.Text))
	}
	loudSvc, loudN := "undefined", "undefined"
	if snap.Culprit.Loudest != nil {
		loudSvc, loudN = snap.Culprit.Loudest.Service, fmt.Sprint(snap.Culprit.Loudest.ErrorSpans)
	}
	topMsg := "n/a"
	if snap.Culprit.TopMessage != nil && *snap.Culprit.TopMessage != "" {
		topMsg = *snap.Culprit.TopMessage
	}
	var rankRows []string
	for _, r := range snap.Culprit.Ranking {
		ch := "no"
		if r.Changed {
			ch = "yes"
		}
		rankRows = append(rankRows, fmt.Sprintf("| %s | %s | %s | %s | %d | **%s** | %s |", svcAt(r), ch, config.Num(r.Time), config.Num(r.Path), r.Sig, config.Num(r.Score), strings.Join(r.Evidence, "; ")))
	}
	drift := ""
	if len(driftNotes) > 0 {
		drift = "**Why staging passed — manifest drift:** " + strings.Join(driftNotes, "; ") + ". The prod release did not include the version staging validated against."
	}
	var stepLines []string
	for _, s := range steps {
		l := "- " + t(s.Ts) + " " + s.Title
		if s.Detail != "" {
			l += " — " + s.Detail
		}
		stepLines = append(stepLines, l)
	}
	risk := "- No data migrations in this release; rollback is lossless."
	if len(migrations) > 0 {
		var ms []string
		for _, m := range migrations {
			ms = append(ms, "- "+m)
		}
		risk = strings.Join(ms, "\n")
	}
	next1 := "investigate " + top.Service + "."
	if top.Service == "rooms-svc" {
		next1 = "make hvac-optimizer accept the rooms-svc 2.4 `occupancyStatus` contract (contract test first)."
	}

	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	w("# %s — %s rolled back at %s\n\n", snap.ID, rel.Name, site)
	w("**Status:** %s · **Release:** %s (%s) · **Deploy freeze:** on\n\n", snap.Status, rel.ID, strings.Join(svcList, ", "))
	w("## Summary\n")
	w("Release %s reached the pilot ring and broke setpoint commands at **%s**. Canary analysis tripped in\n", rel.Name, site)
	w("%s; the rollback controller reverted %s (consumers first)\n", sec(snap.DeployTs, snap.DetectedAt), strings.Join(snap.RollbackOrder, " then "))
	w("and the edge error rate %s.\n", recovered)
	w("%s\n\n", ringLimits)
	w("## Timeline (UTC)\n| Event | Time | Since deploy |\n|---|---|---|\n")
	w("| Deployed to ring %s | %s | 0s |\n", lastRing, t(snap.DeployTs))
	w("| First failing span | %s | %s |\n", t(snap.AnomalyStart), sec(snap.DeployTs, snap.AnomalyStart))
	w("| Canary gate tripped | %s | %s |\n", t(snap.DetectedAt), sec(snap.DeployTs, snap.DetectedAt))
	w("| Rollback complete | %s | %s |\n", t(snap.MitigatedAt), sec(snap.DeployTs, snap.MitigatedAt))
	w("| Recovered | %s | %s |\n\n", t(snap.RecoveredAt), sec(snap.DeployTs, snap.RecoveredAt))
	w("Detect %s · mitigate %s · total impact %s.\n\n", sec(snap.AnomalyStart, snap.DetectedAt), sec(snap.DetectedAt, snap.MitigatedAt), sec(snap.AnomalyStart, end))
	w("## Customer impact (%s)\n| Measure | Value |\n|---|---|\n", site)
	w("| Edge requests failed | %d of %d (%s%%) |\n", edgeFail, edge, config.Num(edgePct))
	w("| Rooms affected | %d |\n| Guests affected | %d |\n| Setpoint commands lost | %d |\n| Guest chats failed | %d |\n", len(rooms), len(guests), hvacLost, chatsFailed)
	w("| LLM spend on failed traces | $%.4f over %d calls (demo traffic runs %sx faster than production) |\n", llmCost, llmCalls, config.Num(c.d.Topo.Accel))
	w("| Linked guest / staff signals | %d |\n\n", len(linked))
	w("%s\n\n", strings.Join(quotes, "\n"))
	w("## Root cause\n")
	w("Culprit: **%s** (score %s, confidence %s).\n", svcAt(top), config.Num(top.Score), config.Num(snap.Culprit.Confidence))
	w("Loudest service was **%s** (%s error spans) — a symptom, not the cause.\n", loudSvc, loudN)
	w("Top error: `%s`\n\n", topMsg)
	w("| Candidate | Changed | Time | Call path | Signature | Score | Evidence |\n|---|---|---|---|---|---|---|\n")
	w("%s\n\n", strings.Join(rankRows, "\n"))
	w("%s\n\n", drift)
	w("## Rollback\n%s\n\n", strings.Join(stepLines, "\n"))
	w("## Data risk\n%s\n- Setpoint commands that failed were not applied; rooms kept their previous setpoint.\n\n", risk)
	w("## Next actions\n1. Fix task: %s\n", next1)
	w("2. Turn on the **manifest parity gate** so a release cannot reach a ring whose dependent service versions differ from what staging validated.\n")
	w("3. Add a consumer contract test for rooms-svc payloads to every consumer's CI.\n")
	w("4. Lift the deploy freeze after the fix ships through all rings.\n")
	md := b.String()
	return &Report{
		Markdown: md, HTML: markdown.ToHTML(md), DriftNotes: driftNotes,
		Numbers: ImpactNumbers{EdgeFailed: edgeFail, EdgeTotal: edge, Rooms: len(rooms), Guests: len(guests), HvacLost: hvacLost,
			ChatsFailed: chatsFailed, LLMCost: llmCost, LinkedSignals: len(linked)},
	}
}
