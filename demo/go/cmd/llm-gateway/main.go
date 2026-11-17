// LLM gateway, Go port of platform/llm/gateway.mjs. Same HTTP contract, same ledger rows, same spans.
// Usage rows go to the control-plane ledger; spans go to the release controller (telemetry).
// Every model call in HotelGrid goes through here.
//   - route table (model + effort per route) pulled from the control plane every second; canary arms
//   - tags: team, route, caller, site, trace, signal, stage
//   - prices each call from config/pricing.json (batch discount for batch routes / x-batch: true)
//   - team budgets: block (429 budget_exceeded) or degrade (effort=low); guest-facing routes never blocked
//   - ships usage rows to the control-plane ledger and one span per call (buffered, flushed every 500 ms)
//
// Standard library only. Build (from go/):  go build -o llm-gateway ./cmd/llm-gateway   Run:  ./llm-gateway -root <demo root>
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"hotelgrid/internal/httpx"
	"hotelgrid/internal/pricing"
)

// ---------- config ----------

type Canary struct {
	Model  string  `json:"model"`
	Effort string  `json:"effort"`
	Weight float64 `json:"weight"`
}

type Route struct {
	Model         string  `json:"model"`
	Effort        string  `json:"effort"`
	Team          string  `json:"team"`
	Batch         bool    `json:"batch"`
	CapturePrompt bool    `json:"capturePrompt"`
	GuestFacing   bool    `json:"guestFacing"`
	Canary        *Canary `json:"canary,omitempty"`
}

type Budget struct {
	Status string  `json:"status"` // ok | warn | exceeded
	Policy string  `json:"policy"` // alert-only | degrade | block
	Pct    float64 `json:"pct"`
	Owner  string  `json:"owner"`
}

// Pricing types live in internal/pricing (shared with finops).
type (
	ModelPrice = pricing.ModelPrice
	Pricing    = pricing.Pricing
	Usage      = pricing.Usage
)

// ---------- helpers shared with the Node version (must stay bit-compatible) ----------

// Hash01 mirrors util.mjs hash01: first 4 bytes of SHA-1, big-endian, / 2^32. Canary arm assignment depends on it,
// so a trace lands in the same arm whichever gateway handles it.
func Hash01(s string) float64 {
	h := sha1.Sum([]byte(s))
	return float64(binary.BigEndian.Uint32(h[:4])) / 4294967296.0
}

func Sha256Hex(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var (
	emailRe = regexp.MustCompile(`[\w.+-]+@[\w-]+\.[\w.]+`)
	phoneRe = regexp.MustCompile(`(\+?66|0)[\d\s-]{8,11}\d`)
)

// Redact mirrors gateway.mjs redact (emails, Thai phone numbers) before a prompt is stored in the ledger.
func Redact(s string) string {
	return phoneRe.ReplaceAllString(emailRe.ReplaceAllString(s, "[email]"), "[phone]")
}

func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---------- gateway ----------

type Gateway struct {
	Provider     string
	ProviderURL  string // sim-llm /v1/messages
	RealURL      string // claude-adapter /v1/messages; set when LLM_PROVIDER=anthropic (guest-assistant tasks only)
	ProviderKey  string
	CPURL        string // control plane: route table + budgets, usage rows → ledger
	TelemetryURL string // release controller: spans
	Pricing      Pricing

	mu      sync.RWMutex
	routes  map[string]Route
	budgets map[string]Budget

	bufMu    sync.Mutex
	usageBuf []map[string]any
	spanBuf  []map[string]any
}

func (g *Gateway) fetchJSON(ctx context.Context, method, url string, body any, headers map[string]string, timeout time.Duration) httpx.Upstream {
	return httpx.FetchJSON(ctx, method, url, body, headers, timeout)
}

func (g *Gateway) pollRoutes(ctx context.Context) {
	r := g.fetchJSON(ctx, "GET", g.CPURL+"/api/gateway/routes", nil, nil, 2*time.Second)
	if r.Status != 200 || r.Body["routes"] == nil {
		return
	}
	var parsed struct {
		Routes  map[string]Route  `json:"routes"`
		Budgets map[string]Budget `json:"budgets"`
	}
	b, _ := json.Marshal(r.Body)
	if json.Unmarshal(b, &parsed) != nil || parsed.Routes == nil {
		return
	}
	if parsed.Budgets == nil {
		parsed.Budgets = map[string]Budget{}
	}
	g.mu.Lock()
	g.routes, g.budgets = parsed.Routes, parsed.Budgets
	g.mu.Unlock()
}

func (g *Gateway) flush(ctx context.Context) {
	g.bufMu.Lock()
	u, s := g.usageBuf, g.spanBuf
	g.usageBuf, g.spanBuf = nil, nil
	g.bufMu.Unlock()
	if len(u) > 0 {
		g.fetchJSON(ctx, "POST", g.CPURL+"/ingest/usage", map[string]any{"rows": u}, nil, 5*time.Second)
	}
	if len(s) > 0 {
		g.fetchJSON(ctx, "POST", g.TelemetryURL+"/ingest/spans", map[string]any{"spans": s}, nil, 5*time.Second)
	}
}

func (g *Gateway) record(usage, span map[string]any) {
	g.bufMu.Lock()
	g.usageBuf = append(g.usageBuf, usage)
	if span != nil {
		g.spanBuf = append(g.spanBuf, span)
	}
	g.bufMu.Unlock()
}

func writeJSON(w http.ResponseWriter, status int, v any) { httpx.WriteJSON(w, status, v) }

func str(v any) string { s, _ := v.(string); return s }

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }

func (g *Gateway) handleMessages(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body == nil {
		writeJSON(w, 400, map[string]any{"error": "invalid JSON body"})
		return
	}
	h := r.Header.Get
	routeName := h("x-route")
	if routeName == "" {
		routeName = "unrouted"
	}

	g.mu.RLock()
	rt, known := g.routes[routeName]
	g.mu.RUnlock()
	if !known {
		rt = Route{Model: str(body["model"]), Effort: "high", Team: h("x-team")}
		if rt.Model == "" {
			rt.Model = "large"
		}
		if rt.Team == "" {
			rt.Team = "unknown"
		}
	}
	traceID := h("x-trace-id")
	if traceID == "" {
		traceID = randHex(16)
	}
	arm, model, effort := "control", rt.Model, rt.Effort
	if rt.Canary != nil && Hash01(traceID+"|"+routeName)*100 < rt.Canary.Weight {
		arm, model, effort = "canary", rt.Canary.Model, rt.Canary.Effort
	}
	if fm := h("x-force-model"); fm != "" {
		model, arm = fm, "forced"
		if fe := h("x-force-effort"); fe != "" {
			effort = fe
		}
	}
	batch := h("x-batch") == "true" || rt.Batch
	// Provider per call: with LLM_PROVIDER=anthropic, guest-assistant tasks (intent, reply) go to real Claude through
	// the claude-adapter; factory agents, advisor and simulator-only tasks stay on the simulator.
	task := str(asMap(body["metadata"])["task"])
	served, providerURL := "sim", g.ProviderURL
	if g.RealURL != "" && (task == "intent" || task == "reply") {
		served, providerURL = "anthropic", g.RealURL
		batch = false // the real Batches API is asynchronous; this synchronous call is billed at the standard price
	}
	team := rt.Team
	if team == "" {
		team = h("x-team")
	}
	if team == "" {
		team = "unknown"
	}

	// budget enforcement (policy per team; guest-facing routes are never blocked)
	g.mu.RLock()
	bud, hasBud := g.budgets[team]
	g.mu.RUnlock()
	budgetAction := ""
	if hasBud && bud.Status == "exceeded" && !rt.GuestFacing {
		if bud.Policy == "block" {
			budgetAction = "blocked"
		} else if bud.Policy == "degrade" && effort != "low" {
			effort, budgetAction = "low", "degraded"
		}
	}

	started := time.Now().UnixMilli()
	row := map[string]any{
		"ts": started, "traceId": traceID, "team": team, "route": routeName,
		"caller": orNil(h("x-caller")), "stage": orNil(h("x-stage")), "signalId": orNil(h("x-signal-id")), "site": orNil(h("x-site-id")),
		"provider": served, "model": model, "effort": effort, "arm": arm, "batch": batch,
		"inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0, "latencyMs": 0,
		"status": 0, "systemHash": nil, "evalLabel": nil, "outputLabel": nil, "promptText": nil,
	}

	if budgetAction == "blocked" {
		row["arm"], row["status"] = "budget-blocked", 429
		g.record(row, nil)
		owner := bud.Owner
		if owner == "" {
			owner = "the budget owner"
		}
		writeJSON(w, 429, map[string]any{"type": "error", "error": map[string]any{
			"type":    "budget_exceeded",
			"message": fmt.Sprintf("%s is over its monthly AI budget (%d%%). Policy: block. Ask %s to raise it.", team, int(math.Floor(bud.Pct*100+0.5)), owner),
		}})
		return
	}

	// forward: same body, model + effort rewritten by the route table
	payload := make(map[string]any, len(body)+1)
	for k, v := range body {
		payload[k] = v
	}
	payload["model"] = model
	oc := map[string]any{}
	for k, v := range asMap(body["output_config"]) {
		oc[k] = v
	}
	oc["effort"] = effort
	payload["output_config"] = oc
	headers := map[string]string{}
	if served == "sim" {
		headers["x-api-key"] = g.ProviderKey // the gateway's key on the (simulated) provider bill
	}
	if batch {
		headers["x-service-tier"] = "batch"
	}
	timeout := 20 * time.Second
	if served == "anthropic" {
		timeout = 90 * time.Second // real model latency incl. thinking and SDK retries
	}
	res := g.fetchJSON(r.Context(), "POST", providerURL, payload, headers, timeout)
	latencyMs := time.Now().UnixMilli() - started

	var usage Usage
	if u := asMap(res.Body["usage"]); u != nil {
		b, _ := json.Marshal(u)
		_ = json.Unmarshal(b, &usage)
	}
	cost := 0.0
	if res.Status == 200 {
		cost = g.Pricing.PriceCall(model, usage, batch)
	}

	meta := asMap(body["metadata"])
	isIntent := str(meta["task"]) == "intent"
	var outputLabel any
	if isIntent {
		outputLabel = "unparseable"
		if content, ok := res.Body["content"].([]any); ok && len(content) > 0 {
			var parsed map[string]any
			if json.Unmarshal([]byte(str(asMap(content[0])["text"])), &parsed) == nil {
				outputLabel = parsed["intent"]
			}
		}
	}
	sysText := ""
	switch s := body["system"].(type) {
	case string:
		sysText = s
	case []any:
		parts := make([]string, len(s))
		for i, b := range s {
			parts[i] = str(asMap(b)["text"])
		}
		sysText = strings.Join(parts, "\n")
	}
	var promptText any
	if msgs, ok := body["messages"].([]any); ok && rt.CapturePrompt && len(msgs) > 0 {
		if c, ok := asMap(msgs[len(msgs)-1])["content"].(string); ok {
			if i := strings.LastIndex(c, "Guest:"); i >= 0 {
				c = strings.TrimSpace(c[i+len("Guest:"):])
			}
			promptText = Redact(c)
		}
	}
	var evalLabel any
	if isIntent {
		evalLabel = orNil(h("x-eval-label"))
	}
	if budgetAction == "degraded" {
		row["arm"] = "budget-degraded"
	}
	row["inputTokens"], row["outputTokens"] = usage.InputTokens, usage.OutputTokens
	row["cacheRead"], row["cacheWrite"] = usage.CacheReadInputTokens, usage.CacheCreationInputTokens
	row["costUsd"], row["latencyMs"], row["status"] = cost, latencyMs, res.Status
	row["systemHash"] = Sha256Hex(sysText)[:12]
	row["evalLabel"], row["outputLabel"], row["promptText"] = evalLabel, outputLabel, promptText

	var spanErr any
	if res.Status >= 500 {
		spanErr = "provider error"
		if e := res.Body["error"]; e != nil {
			if m := str(asMap(e)["message"]); m != "" {
				spanErr = m
			} else if s, ok := e.(string); ok && s != "" {
				spanErr = s
			} else {
				spanErr = e
			}
		}
	}
	site := h("x-site-id")
	if site == "" {
		site = "factory"
	}
	g.record(row, map[string]any{
		"traceId": traceID, "spanId": randHex(8), "parentId": orNil(h("x-parent-span")), "service": "llm-gateway",
		"version": model + "/" + effort, "site": site, "method": "POST", "path": "/v1/messages", "route": routeName,
		"status": res.Status, "ms": latencyMs, "error": spanErr,
		"attrs": map[string]any{"model": model, "effort": effort, "arm": arm, "costUsd": cost, "cacheRead": usage.CacheReadInputTokens},
		"ts":    started,
	})

	if res.Status != 200 {
		writeJSON(w, res.Status, res.Body)
		return
	}
	var budgetInfo any
	if hasBud {
		budgetInfo = map[string]any{"status": bud.Status, "action": orNil(budgetAction)}
	}
	delete(res.Body, "_provider")
	res.Body["_gateway"] = map[string]any{"route": routeName, "arm": arm, "model": model, "effort": effort, "costUsd": cost, "batch": batch, "budget": budgetInfo, "provider": served}
	writeJSON(w, 200, res.Body)
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/messages", g.handleMessages)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		g.mu.RLock()
		n := len(g.routes)
		g.mu.RUnlock()
		writeJSON(w, 200, map[string]any{"ok": true, "provider": g.Provider, "routes": n, "impl": "go"})
	})
	return mux
}

// Run starts the background loops (route poll 1 s, ledger flush 500 ms) until ctx ends, then flushes once more.
func (g *Gateway) Run(ctx context.Context) {
	poll := time.NewTicker(time.Second)
	flush := time.NewTicker(500 * time.Millisecond)
	defer poll.Stop()
	defer flush.Stop()
	for {
		select {
		case <-ctx.Done():
			g.flush(context.Background())
			return
		case <-poll.C:
			g.pollRoutes(ctx)
		case <-flush.C:
			g.flush(ctx)
		}
	}
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func main() {
	root := flag.String("root", ".", "demo root (contains config/)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[llm-gateway/go] ")

	provider := os.Getenv("LLM_PROVIDER")
	if provider == "" {
		provider = "sim"
	}
	if provider != "sim" && provider != "anthropic" {
		log.Fatalf("LLM_PROVIDER=%s is not supported (use sim or anthropic)", provider)
	}
	var topo struct {
		Ports map[string]int `json:"ports"`
	}
	var routing struct {
		Routes      map[string]Route `json:"routes"`
		ProviderKey string           `json:"providerKey"`
	}
	var prices Pricing
	for path, v := range map[string]any{"config/topology.json": &topo, "config/routing.json": &routing, "config/pricing.json": &prices} {
		if err := readJSON(filepath.Join(*root, path), v); err != nil {
			log.Fatalf("reading %s: %v", path, err)
		}
	}
	realURL := ""
	if provider == "anthropic" {
		realURL = fmt.Sprintf("http://127.0.0.1:%d/v1/messages", topo.Ports["claude-adapter"])
	}
	g := &Gateway{
		Provider:     provider,
		ProviderURL:  fmt.Sprintf("http://127.0.0.1:%d/v1/messages", topo.Ports["sim-llm"]),
		ProviderKey:  routing.ProviderKey,
		CPURL:        fmt.Sprintf("http://127.0.0.1:%d", topo.Ports["control-plane"]),
		TelemetryURL: fmt.Sprintf("http://127.0.0.1:%d", topo.Ports["release-controller"]),
		Pricing:      prices,
		routes:       routing.Routes,
		RealURL:      realURL,
		budgets:      map[string]Budget{},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() { g.Run(ctx); close(done) }()

	addr := fmt.Sprintf("127.0.0.1:%d", topo.Ports["llm-gateway"])
	srv := &http.Server{Addr: addr, Handler: g.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Printf("listening on :%d provider=%s", topo.Ports["llm-gateway"], provider)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-done // final ledger flush so no usage rows are lost on shutdown
}
