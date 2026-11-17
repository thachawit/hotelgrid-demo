package finops

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/events"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/pricing"
)

const root = "../../.."

// fixed clock: 2026-11-17 12:00 UTC → month started 16 full days ago
var fixedNow = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

// fake provider admin API: 5 daily buckets (Nov 12–16) + today; notebook key active Nov 14–16 + today.
type fakeProvider struct {
	mu          sync.Mutex
	keyStatus   string
	pagesServed int
}

func (f *fakeProvider) days() []string {
	return []string{"2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"}
}

func (f *fakeProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("x-api-key") != "apikey_admin_finops" {
		httpx.WriteJSON(w, 401, map[string]any{"error": map[string]any{"message": "admin key required"}})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	q := r.URL.Query()
	first := 0
	if p := q.Get("page"); p != "" {
		b, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(p, "page_"))
		first, _ = strconv.Atoi(string(b))
	}
	const limit = 4 // force pagination
	days := f.days()
	end := first + limit
	if end > len(days) {
		end = len(days)
	}
	more := end < len(days)
	next := any(nil)
	if more {
		next = "page_" + base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(end)))
	}
	notebook := func(d string) bool { return d >= "2026-11-14" }
	switch {
	case r.URL.Path == "/v1/organizations/cost_report":
		f.pagesServed++
		var data []any
		for _, d := range days[first:end] {
			// gateway spend $10/day = 1000 cents (+ $2 notebook on its days), amounts are decimal strings in cents
			res := []any{map[string]any{"amount": "1000.000000", "workspace_id": "wrkspc_prod", "currency": "USD"}}
			if notebook(d) {
				res = append(res, map[string]any{"amount": "200.000000", "workspace_id": nil, "currency": "USD"})
			}
			data = append(data, map[string]any{"starting_at": d + "T00:00:00Z", "results": res})
		}
		httpx.WriteJSON(w, 200, map[string]any{"data": data, "has_more": more, "next_page": next})
	case r.URL.Path == "/v1/organizations/usage_report/messages":
		var data []any
		for _, d := range days[first:end] {
			// large tier: $4/MTok in, $20/MTok out. 2.5M input = $10 → gateway; notebook 500k input = $2 (standard tier)
			res := []any{map[string]any{"api_key_id": "apikey_gateway_prod", "model": "claude-opus-5-5", "service_tier": "standard",
				"uncached_input_tokens": 2_500_000, "output_tokens": 0, "cache_read_input_tokens": 0,
				"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}
			if notebook(d) {
				res = append(res, map[string]any{"api_key_id": "apikey_ds_review_notebook", "model": "claude-opus-5-5", "service_tier": "standard",
					"uncached_input_tokens": 500_000, "output_tokens": 0, "cache_read_input_tokens": 0,
					"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}})
			}
			data = append(data, map[string]any{"starting_at": d + "T00:00:00Z", "results": res})
		}
		httpx.WriteJSON(w, 200, map[string]any{"data": data, "has_more": more, "next_page": next})
	case r.URL.Path == "/v1/organizations/api_keys" && r.Method == "GET":
		httpx.WriteJSON(w, 200, map[string]any{"data": []any{
			map[string]any{"id": "apikey_gateway_prod", "name": "llm-gateway-prod", "workspace_id": "wrkspc_prod", "status": "active", "created_by": map[string]any{"id": "user:platform"}},
			map[string]any{"id": "apikey_ds_review_notebook", "name": "review-summaries-notebook", "workspace_id": nil, "status": f.keyStatusOr("active"), "created_at": "2026-11-08T09:12:00Z", "created_by": map[string]any{"id": "user:data-team-analyst"}},
		}, "has_more": false})
	case r.URL.Path == "/v1/organizations/api_keys/apikey_ds_review_notebook" && r.Method == "POST":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.keyStatus = httpx.Str(b["status"])
		httpx.WriteJSON(w, 200, map[string]any{"id": "apikey_ds_review_notebook", "name": "review-summaries-notebook", "status": f.keyStatus})
	default:
		httpx.WriteJSON(w, 404, map[string]any{"error": map[string]any{"message": "no route " + r.URL.Path}})
	}
}

func (f *fakeProvider) keyStatusOr(def string) string {
	if f.keyStatus != "" {
		return f.keyStatus
	}
	return def
}

// fake control-plane ledger: gateway ledger matches the gateway key exactly ($10/day); team spend inputs scripted.
type fakeLedger struct {
	mu          sync.Mutex
	adjustments []Adjustment
	decisions   []map[string]any
	inputs      map[string]BudgetInput
}

func (l *fakeLedger) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch r.URL.Path {
	case "/internal/ledger/daily":
		days := map[string]any{}
		for _, d := range []string{"2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"} {
			days[d] = map[string]any{"c": 10.0, "n": 100}
		}
		httpx.WriteJSON(w, 200, map[string]any{"days": days})
	case "/internal/ledger/adjustments":
		var b struct{ Rows []Adjustment }
		_ = json.NewDecoder(r.Body).Decode(&b)
		l.adjustments = append(l.adjustments, b.Rows...)
		httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	case "/internal/ledger/decisions":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		l.decisions = append(l.decisions, b)
		httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	case "/internal/ledger/budget-inputs":
		httpx.WriteJSON(w, 200, map[string]any{"teams": l.inputs})
	default:
		httpx.WriteJSON(w, 404, map[string]any{"error": "no route"})
	}
}

func newService(t *testing.T) (*Service, *fakeProvider, *fakeLedger, string) {
	t.Helper()
	topo, err := config.LoadTopology(root)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadBudgets(root)
	if err != nil {
		t.Fatal(err)
	}
	pr, err := pricing.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	fp, fl := &fakeProvider{}, &fakeLedger{inputs: map[string]BudgetInput{}}
	ps, ls := httptest.NewServer(fp), httptest.NewServer(fl)
	t.Cleanup(ps.Close)
	t.Cleanup(ls.Close)
	rt := t.TempDir()
	s := &Service{Cfg: cfg, Topo: topo, Pricing: pr, Runtime: rt, Events: &events.Pusher{Quiet: true}, Ledger: Ledger{CPURL: ls.URL},
		Admin: SimAdmin(ps.URL), Now: func() time.Time { return fixedNow }}
	return s, fp, fl, rt
}

func TestBudgetsConfigKeepsTeamOrder(t *testing.T) {
	cfg, err := LoadBudgets(root)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(cfg.TeamOrder, ",") != "team-guest-ai,team-platform,team-finops,team-data" {
		t.Errorf("order = %v", cfg.TeamOrder)
	}
}

func TestBudgetStatusesAndPolicies(t *testing.T) {
	s, _, fl, _ := newService(t)
	fl.inputs = map[string]BudgetInput{
		"team-guest-ai": {ThroughYesterday: 7100, Today: 10},             // over, but alert-only
		"team-platform": {ThroughYesterday: 150, Today: 2},               // 36 %, projected 150/16*30 = 281 < 420 → ok
		"team-finops":   {ThroughYesterday: 40, Today: 1},                // 68 %, projected 75 > 60 → warn
		"team-data":     {ThroughYesterday: 195, Today: 6, Blocked5m: 3}, // 100.5 % → exceeded
	}
	b, err := s.ComputeBudgets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"team-guest-ai": "exceeded", "team-platform": "ok", "team-finops": "warn", "team-data": "exceeded"}
	for _, x := range b {
		if x.Status != want[x.Team] {
			t.Errorf("%s: %s (pct %.3f, projected %v), want %s", x.Team, x.Status, x.Pct, *x.Projected, want[x.Team])
		}
	}
	gb := s.GatewayBudgets()
	if httpx.Map(gb["team-data"])["policy"] != "block" || httpx.Map(gb["team-guest-ai"])["policy"] != "alert-only" {
		t.Errorf("gateway budgets %v", gb)
	}
	// a raise is an L3 decision; status recomputes immediately
	s.RaiseBudget(context.Background(), "team-data", 300, "data lead")
	for _, x := range s.PublicState()["budgets"].([]Budget) {
		// $201 of $300 is 67 %, but the projection from complete days ($195 / 16 × 30 ≈ $366) is still over → warn
		if x.Team == "team-data" && (x.Status != "warn" || x.Budget != 300) {
			t.Errorf("after raise: %+v", x)
		}
	}
	fl.mu.Lock()
	defer fl.mu.Unlock()
	if len(fl.decisions) != 1 || fl.decisions[0]["title"] != "team-data budget $200 → $300/month" {
		t.Errorf("decisions: %v", fl.decisions)
	}
}

func TestReconcileFindsUnroutedKeyAndAttributesSpend(t *testing.T) {
	s, fp, fl, rt := newService(t)
	rc, err := s.Reconcile(context.Background(), 5, "test")
	if err != nil {
		t.Fatal(err)
	}
	if fp.pagesServed < 2 {
		t.Errorf("pagination not followed (%d pages)", fp.pagesServed)
	}
	if len(rc.Days) != 6 || rc.VarianceDays != 3 {
		t.Errorf("days %d variance %d", len(rc.Days), rc.VarianceDays)
	}
	if rc.MaxResidualPct > 1e-9 {
		t.Errorf("gateway key should match the ledger exactly, residual %v", rc.MaxResidualPct)
	}
	if len(rc.Findings) != 1 {
		t.Fatalf("findings %+v", rc.Findings)
	}
	f := rc.Findings[0]
	if f.APIKeyID != "apikey_ds_review_notebook" || f.Team != "team-data" || f.FirstSeen != "2026-11-14" || f.CreatedBy != "user:data-team-analyst" || f.Workspace != "Default workspace" {
		t.Errorf("finding %+v", f)
	}
	if fmt.Sprintf("%.2f %.2f", f.PerDay, f.Monthly) != "2.00 60.00" {
		t.Errorf("perDay %v monthly %v", f.PerDay, f.Monthly)
	}
	fl.mu.Lock()
	adj := append([]Adjustment(nil), fl.adjustments...)
	fl.mu.Unlock()
	if len(adj) != 4 {
		t.Fatalf("adjustments %+v", adj)
	}
	for _, a := range adj {
		wantW := 1.0
		if a.Day == "2026-11-17" {
			wantW = 1 / s.Topo.Accel // today's raw demo dollars are weighted like live ledger rows
		}
		if a.Weight != wantW || a.Team != "team-data" || a.Source != "reconciliation" {
			t.Errorf("adjustment %+v", a)
		}
	}
	md, err := os.ReadFile(filepath.Join(rt, "reports", "RECON-2026-11-17.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# RECON-2026-11-17 — Provider bill vs gateway ledger", "- Bill: **$68.00** · Ledger: **$60.00** · Gap: **$8.00** (11.8 %).",
		"| `apikey_ds_review_notebook` | review-summaries-notebook | Default workspace | user:data-team-analyst | team-data | 2026-11-14 | $2.00 | $60.00 |",
		"| 2026-11-17 (today, partial) |", "1. **L2:** deactivate `apikey_ds_review_notebook`"} {
		if !strings.Contains(string(md), want) {
			t.Errorf("report missing %q\n%s", want, md)
		}
	}
	if st := s.PublicState(); st["recon"].(Recon).Markdown != "" || st["recon"].(Recon).HTML == "" {
		t.Errorf("public recon should drop markdown and keep html")
	}

	k, err := s.DeactivateKey(context.Background(), "apikey_ds_review_notebook", "test")
	if err != nil || k["status"] != "inactive" {
		t.Fatalf("deactivate: %v %v", k, err)
	}
	if r, _ := s.Recon(); r.Findings[0].Status != "inactive" {
		t.Errorf("finding status not updated")
	}
	if _, err := os.Stat(filepath.Join(rt, "decisions", "FIN-1.md")); err != nil {
		t.Errorf("decision memo: %v", err)
	}
}

func TestAdminErrorsSurface(t *testing.T) {
	s, _, _, _ := newService(t)
	s.Admin.Headers["x-api-key"] = "apikey_gateway_prod" // not an admin key
	if _, err := s.Reconcile(context.Background(), 5, "test"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("want 401 error, got %v", err)
	}
}
