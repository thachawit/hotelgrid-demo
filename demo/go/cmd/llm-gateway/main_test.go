package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Reference values computed by the Node helpers (platform/lib/util.mjs hash01, gateway.mjs redact).
func TestHash01MatchesNode(t *testing.T) {
	for in, want := range map[string]float64{
		"abc|assistant.intent": 0.954103515483439,
		"t-123|factory.build":  0.6133357628714293,
		"":                     0.8524420219473541,
	} {
		if got := Hash01(in); math.Abs(got-want) > 1e-15 {
			t.Errorf("Hash01(%q) = %v, Node says %v", in, got, want)
		}
	}
}

func TestRedactMatchesNode(t *testing.T) {
	in := "mail me a.b+c@hotel.co.th or call +66 81 234 5678 / 081-234-5678 room 0412"
	want := "mail me [email] or call [phone] / [phone] room 0412"
	if got := Redact(in); got != want {
		t.Errorf("Redact = %q, want %q", got, want)
	}
}

func testPricing() Pricing {
	return Pricing{BatchDiscount: 0.5, Models: map[string]ModelPrice{
		"large":  {InputPerMTok: 4, OutputPerMTok: 20, CacheReadPerMTok: 0.2, CacheWritePerMTok: 5},
		"medium": {InputPerMTok: 2, OutputPerMTok: 10, CacheReadPerMTok: 0.1, CacheWritePerMTok: 2.5},
	}}
}

func TestPriceCall(t *testing.T) {
	p := testPricing()
	u := Usage{InputTokens: 1_000_000, OutputTokens: 100_000, CacheReadInputTokens: 500_000, CacheCreationInputTokens: 200_000}
	if got := p.PriceCall("large", u, false); math.Abs(got-(4+2+0.1+1)) > 1e-9 {
		t.Errorf("large = %v", got)
	}
	if got := p.PriceCall("large", u, true); math.Abs(got-7.1*0.5) > 1e-9 {
		t.Errorf("large batch = %v", got)
	}
	if got := p.PriceCall("nope", u, false); got != 0 {
		t.Errorf("unknown model = %v", got)
	}
}

// fake sim-llm: records what the gateway forwarded, answers like the simulator.
type fakeProvider struct {
	mu   sync.Mutex
	last map[string]any
	hdr  http.Header
}

func (f *fakeProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	f.last, f.hdr = body, r.Header.Clone()
	f.mu.Unlock()
	writeJSON(w, 200, map[string]any{
		"content": []any{map[string]any{"type": "text", "text": `{"intent":"hvac_too_cold"}`}},
		"usage":   map[string]any{"input_tokens": 1000, "output_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
	})
}

func newTestGateway(t *testing.T, routes map[string]Route, budgets map[string]Budget) (*Gateway, *fakeProvider) {
	t.Helper()
	fp := &fakeProvider{}
	prov := httptest.NewServer(fp)
	t.Cleanup(prov.Close)
	return &Gateway{
		Provider: "sim", ProviderURL: prov.URL + "/v1/messages", ProviderKey: "apikey_gateway_prod",
		CPURL: "http://127.0.0.1:1", TelemetryURL: "http://127.0.0.1:1", Pricing: testPricing(),
		routes: routes, budgets: budgets,
	}, fp
}

func call(t *testing.T, g *Gateway, headers map[string]string, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	g.Handler().ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

const intentBody = `{"system":[{"text":"You are the HotelGrid assistant."}],"messages":[{"role":"user","content":"Room 1204. Guest: too cold, call me 081-234-5678"}],"metadata":{"task":"intent"},"output_config":{"format":"json"}}`

func TestRouteRewriteTagsAndLedgerRow(t *testing.T) {
	g, fp := newTestGateway(t, map[string]Route{
		"assistant.intent": {Model: "large", Effort: "high", Team: "team-guest-ai", CapturePrompt: true, GuestFacing: true},
	}, map[string]Budget{})
	rec, out := call(t, g, map[string]string{"x-route": "assistant.intent", "x-trace-id": "trace-1", "x-site-id": "bkk-pilot", "x-eval-label": "hvac_too_cold"}, intentBody)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if fp.last["model"] != "large" || asMap(fp.last["output_config"])["effort"] != "high" || asMap(fp.last["output_config"])["format"] != "json" {
		t.Errorf("forwarded payload wrong: %v", fp.last)
	}
	if fp.hdr.Get("x-api-key") != "apikey_gateway_prod" || fp.hdr.Get("x-service-tier") != "" {
		t.Errorf("provider headers wrong: %v", fp.hdr)
	}
	gw := asMap(out["_gateway"])
	if gw["arm"] != "control" || gw["route"] != "assistant.intent" || math.Abs(gw["costUsd"].(float64)-0.006) > 1e-12 {
		t.Errorf("_gateway = %v", gw)
	}
	if len(g.usageBuf) != 1 || len(g.spanBuf) != 1 {
		t.Fatalf("buffers: %d usage, %d spans", len(g.usageBuf), len(g.spanBuf))
	}
	row := g.usageBuf[0]
	if row["team"] != "team-guest-ai" || row["site"] != "bkk-pilot" || row["outputLabel"] != "hvac_too_cold" || row["evalLabel"] != "hvac_too_cold" {
		t.Errorf("row tags: %v", row)
	}
	if row["promptText"] != "too cold, call me [phone]" {
		t.Errorf("promptText = %q (want text after Guest:, phone redacted)", row["promptText"])
	}
	if row["systemHash"] != Sha256Hex("You are the HotelGrid assistant.")[:12] {
		t.Errorf("systemHash = %v", row["systemHash"])
	}
}

func TestCanaryArmIsDeterministic(t *testing.T) {
	routes := map[string]Route{"assistant.intent": {Model: "large", Effort: "high", Team: "team-guest-ai", Canary: &Canary{Model: "medium", Effort: "low", Weight: 50}}}
	g, fp := newTestGateway(t, routes, map[string]Budget{})
	// Hash01("abc|assistant.intent") = 0.954 → 95.4 ≥ 50 → control; pick a trace that lands under 50 by search.
	_, out := call(t, g, map[string]string{"x-route": "assistant.intent", "x-trace-id": "abc"}, intentBody)
	if asMap(out["_gateway"])["arm"] != "control" {
		t.Errorf("trace abc should be control, got %v", out["_gateway"])
	}
	var canaryTrace string
	for i := 0; i < 100; i++ {
		id := "t" + strings.Repeat("x", i)
		if Hash01(id+"|assistant.intent")*100 < 50 {
			canaryTrace = id
			break
		}
	}
	_, out = call(t, g, map[string]string{"x-route": "assistant.intent", "x-trace-id": canaryTrace}, intentBody)
	if gw := asMap(out["_gateway"]); gw["arm"] != "canary" || gw["model"] != "medium" || fp.last["model"] != "medium" {
		t.Errorf("trace %s should be canary/medium, got %v", canaryTrace, gw)
	}
}

func TestBudgetBlockDegradeAndGuestFacing(t *testing.T) {
	routes := map[string]Route{
		"data.review-summaries": {Model: "large", Effort: "high", Team: "team-data", Batch: true},
		"factory.build":         {Model: "large", Effort: "xhigh", Team: "team-platform"},
		"assistant.reply":       {Model: "medium", Effort: "medium", Team: "team-guest-ai", GuestFacing: true},
	}
	budgets := map[string]Budget{
		"team-data":     {Status: "exceeded", Policy: "block", Pct: 1.01, Owner: "data-lead"},
		"team-platform": {Status: "exceeded", Policy: "degrade", Pct: 1.1},
		"team-guest-ai": {Status: "exceeded", Policy: "block", Pct: 1.2},
	}
	g, fp := newTestGateway(t, routes, budgets)

	rec, out := call(t, g, map[string]string{"x-route": "data.review-summaries"}, `{"messages":[]}`)
	errObj := asMap(out["error"])
	if rec.Code != 429 || errObj["type"] != "budget_exceeded" || !strings.Contains(str(errObj["message"]), "team-data is over its monthly AI budget (101%). Policy: block. Ask data-lead") {
		t.Errorf("block: %d %v", rec.Code, out)
	}
	if g.usageBuf[0]["arm"] != "budget-blocked" || g.usageBuf[0]["status"] != 429 || len(g.spanBuf) != 0 {
		t.Errorf("blocked row: %v", g.usageBuf[0])
	}
	if fp.last != nil {
		t.Errorf("blocked call reached the provider")
	}

	_, out = call(t, g, map[string]string{"x-route": "factory.build"}, `{"messages":[]}`)
	if gw := asMap(out["_gateway"]); gw["effort"] != "low" || asMap(gw["budget"])["action"] != "degraded" || g.usageBuf[1]["arm"] != "budget-degraded" {
		t.Errorf("degrade: %v / %v", gw, g.usageBuf[1])
	}

	rec, _ = call(t, g, map[string]string{"x-route": "assistant.reply"}, `{"messages":[]}`)
	if rec.Code != 200 {
		t.Errorf("guest-facing route must never be blocked, got %d", rec.Code)
	}
}

func TestBatchRouteGetsServiceTierAndDiscount(t *testing.T) {
	g, fp := newTestGateway(t, map[string]Route{"cost.shadow": {Model: "large", Effort: "high", Team: "team-finops", Batch: true}}, map[string]Budget{})
	_, out := call(t, g, map[string]string{"x-route": "cost.shadow"}, `{"messages":[]}`)
	if fp.hdr.Get("x-service-tier") != "batch" || math.Abs(asMap(out["_gateway"])["costUsd"].(float64)-0.003) > 1e-12 {
		t.Errorf("batch: tier=%q gw=%v", fp.hdr.Get("x-service-tier"), out["_gateway"])
	}
}

func TestUnknownRouteAndUnreachableProvider(t *testing.T) {
	g, _ := newTestGateway(t, map[string]Route{}, map[string]Budget{})
	g.ProviderURL = "http://127.0.0.1:1/v1/messages"
	rec, out := call(t, g, map[string]string{"x-team": "team-x"}, `{"model":"medium","messages":[]}`)
	if rec.Code != 599 || !strings.HasPrefix(str(out["error"]), "upstream unreachable") {
		t.Errorf("unreachable: %d %v", rec.Code, out)
	}
	row, span := g.usageBuf[0], g.spanBuf[0]
	if row["route"] != "unrouted" || row["team"] != "team-x" || row["model"] != "medium" || row["costUsd"] != 0.0 {
		t.Errorf("unrouted row: %v", row)
	}
	if !strings.HasPrefix(str(span["error"]), "upstream unreachable") {
		t.Errorf("span error: %v", span["error"])
	}
}

func TestFlushShipsBuffersToControlPlane(t *testing.T) {
	var mu sync.Mutex
	got := map[string]int{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string][]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		got[r.URL.Path] += len(b["rows"]) + len(b["spans"])
		mu.Unlock()
		w.WriteHeader(200)
	}))
	defer cp.Close()
	g, _ := newTestGateway(t, map[string]Route{"x": {Model: "large", Effort: "high", Team: "t"}}, map[string]Budget{})
	g.CPURL, g.TelemetryURL = cp.URL, cp.URL
	call(t, g, map[string]string{"x-route": "x"}, `{"messages":[]}`)
	call(t, g, map[string]string{"x-route": "x"}, `{"messages":[]}`)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { g.Run(ctx); close(done) }()
	time.Sleep(700 * time.Millisecond)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if got["/ingest/usage"] != 2 || got["/ingest/spans"] != 2 {
		t.Errorf("control plane received %v", got)
	}
}

func TestBadJSON(t *testing.T) {
	g, _ := newTestGateway(t, map[string]Route{}, map[string]Budget{})
	rec, _ := call(t, g, nil, `{nope`)
	if rec.Code != 400 {
		t.Errorf("bad JSON: %d", rec.Code)
	}
}

// LLM_PROVIDER=anthropic: guest-assistant tasks go to the claude-adapter, everything else stays on the simulator;
// rows carry the provider that actually served the call; real calls are never priced as batch.
func TestRealProviderServesGuestTasksOnly(t *testing.T) {
	routes := map[string]Route{
		"assistant.intent": {Model: "large", Effort: "high", Team: "team-guest-ai", GuestFacing: true, Batch: true},
		"factory.triage":   {Model: "large", Effort: "high", Team: "team-platform"},
	}
	g, sim := newTestGateway(t, routes, map[string]Budget{})
	real := &fakeProvider{}
	rs := httptest.NewServer(real)
	t.Cleanup(rs.Close)
	g.RealURL = rs.URL + "/v1/messages"

	_, out := call(t, g, map[string]string{"x-route": "assistant.intent"}, intentBody)
	gw := asMap(out["_gateway"])
	if real.last == nil || sim.last != nil || gw["provider"] != "anthropic" || gw["batch"] != false {
		t.Fatalf("intent should go to the real provider unbatched: real=%v sim=%v gw=%v", real.last != nil, sim.last != nil, gw)
	}
	if real.hdr.Get("x-api-key") != "" || real.hdr.Get("x-service-tier") != "" {
		t.Errorf("the gateway's simulated-bill key must not be sent to the adapter")
	}
	if row := g.usageBuf[0]; row["provider"] != "anthropic" || row["batch"] != false || math.Abs(row["costUsd"].(float64)-0.006) > 1e-12 {
		t.Errorf("row %v", row)
	}
	call(t, g, map[string]string{"x-route": "factory.triage"}, `{"messages":[],"metadata":{"task":"triage"}}`)
	if sim.last == nil || g.usageBuf[1]["provider"] != "sim" {
		t.Errorf("factory agents stay on the simulator: %v", g.usageBuf[1]["provider"])
	}
}
