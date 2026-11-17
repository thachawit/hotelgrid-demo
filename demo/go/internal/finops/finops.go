// Package finops: (1) daily reconciliation of the gateway ledger against the provider bill (admin usage/cost
// reports), (2) per-team monthly budgets that the LLM gateway enforces, (3) provider key actions through the admin
// API. The bill is the source of truth; the ledger is attribution. Port of control-plane/finops.mjs.
//
// The ledger itself stays in the control plane (SQLite, queried with SQL by the cost advisor); this service reads and
// writes it through the control plane's /internal/ledger/* endpoints.
package finops

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/events"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/markdown"
	"hotelgrid/internal/pricing"
)

const day = int64(86400000)

type TeamBudget struct {
	MonthlyUsd float64 `json:"monthlyUsd"`
	OnExceeded string  `json:"onExceeded"`
	Owner      string  `json:"owner"`
	Why        string  `json:"why"`
}

type BudgetsCfg struct {
	WarnAt       float64               `json:"warnAt"`
	Teams        map[string]TeamBudget `json:"teams"`
	TeamOrder    []string              `json:"-"`
	APIKeyOwners map[string]string     `json:"apiKeyOwners"`
}

func LoadBudgets(root string) (BudgetsCfg, error) {
	var b BudgetsCfg
	if err := config.Read(root, "config/budgets.json", &b); err != nil {
		return b, err
	}
	var raw struct {
		Teams json.RawMessage `json:"teams"`
	}
	if err := config.Read(root, "config/budgets.json", &raw); err != nil {
		return b, err
	}
	keys, err := config.ObjectKeys(raw.Teams)
	b.TeamOrder = keys
	return b, err
}

type Budget struct {
	Team       string   `json:"team"`
	Budget     float64  `json:"budget"`
	MTD        float64  `json:"mtd"`
	Unrouted   float64  `json:"unrouted"`
	Projected  *float64 `json:"projected"`
	Pct        float64  `json:"pct"`
	Status     string   `json:"status"` // ok | warn | exceeded
	Policy     string   `json:"policy"`
	Owner      string   `json:"owner"`
	Why        string   `json:"why"`
	Blocked5m  int      `json:"blocked5m"`
	Degraded5m int      `json:"degraded5m"`
}

type Day struct {
	Day         string             `json:"day"`
	Ledger      float64            `json:"ledger"`
	Provider    float64            `json:"provider"`
	Diff        float64            `json:"diff"`
	Pct         float64            `json:"pct"`
	GatewayKey  float64            `json:"gatewayKey"`
	Residual    float64            `json:"residual"`
	ByWorkspace map[string]float64 `json:"byWorkspace"`
	Unrouted    map[string]float64 `json:"unrouted"`
	Status      string             `json:"status"` // match | variance
	Partial     bool               `json:"partial"`
}

type Finding struct {
	APIKeyID  string  `json:"apiKeyId"`
	Name      string  `json:"name"`
	Workspace string  `json:"workspace"`
	Status    string  `json:"status,omitempty"`
	CreatedBy string  `json:"createdBy,omitempty"`
	CreatedAt string  `json:"createdAt,omitempty"`
	Team      string  `json:"team"`
	FirstSeen string  `json:"firstSeen"`
	Total14d  float64 `json:"total14d"`
	PerDay    float64 `json:"perDay"`
	Monthly   float64 `json:"monthly"`
}

type Recon struct {
	ID             string             `json:"id"`
	RanAt          int64              `json:"ranAt"`
	Actor          string             `json:"actor"`
	Days           []Day              `json:"days"`
	Findings       []Finding          `json:"findings"`
	Totals         map[string]float64 `json:"totals"`
	MaxResidualPct float64            `json:"maxResidualPct"`
	VarianceDays   int                `json:"varianceDays"`
	Markdown       string             `json:"markdown,omitempty"`
	HTML           string             `json:"html,omitempty"`
}

type Decision struct {
	ID     string `json:"id"`
	Ts     int64  `json:"ts"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// Admin calls the provider's admin API (simulated provider by default).
type Admin struct {
	Base    string
	Headers map[string]string
}

// SimAdmin targets the demo's simulated provider with the finops admin key it knows.
func SimAdmin(simURL string) Admin {
	return Admin{Base: simURL, Headers: map[string]string{"x-api-key": "apikey_admin_finops", "anthropic-version": "2026-10-21"}}
}

// AnthropicAdmin is the OPTIONAL real adapter (PROVIDER_ADMIN=anthropic). The Admin API key is read from the
// environment at call time and only ever sent to the API — never logged or stored. Untested against the live API;
// the usage/cost report endpoints are not in the SDKs, so this is raw HTTP, like the Node adapter it replaces.
func AnthropicAdmin() Admin {
	base := os.Getenv("ANTHROPIC_ADMIN_BASE_URL")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	return Admin{Base: base, Headers: map[string]string{"anthropic-version": "2026-10-21", "user-agent": "hotelgrid-finops-demo/1.0", "x-api-key": os.Getenv("ANTHROPIC_ADMIN_KEY")}}
}

func (a Admin) Call(ctx context.Context, method, path string, params url.Values, body any) (httpx.Upstream, error) {
	u := a.Base + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	r := httpx.FetchJSON(ctx, method, u, body, a.Headers, 15*time.Second)
	if r.Status != 200 {
		msg := ""
		if e := httpx.Map(r.Body["error"]); e != nil {
			msg = httpx.Str(e["message"])
		}
		return r, fmt.Errorf("provider admin %s → %d: %s", path, r.Status, msg)
	}
	return r, nil
}

func (a Admin) paged(ctx context.Context, path string, params url.Values) ([]json.RawMessage, error) {
	var data []json.RawMessage
	page := ""
	for i := 0; i < 20; i++ {
		p := url.Values{}
		for k, v := range params {
			p[k] = v
		}
		if page != "" {
			p.Set("page", page)
		}
		r, err := a.Call(ctx, "GET", path, p, nil)
		if err != nil {
			return nil, err
		}
		var out struct {
			Data     []json.RawMessage `json:"data"`
			HasMore  bool              `json:"has_more"`
			NextPage string            `json:"next_page"`
		}
		if err := r.Decode(&out); err != nil {
			return nil, err
		}
		data = append(data, out.Data...)
		if !out.HasMore {
			break
		}
		page = out.NextPage
	}
	return data, nil
}

// Ledger is the control plane's internal ledger API.
type Ledger struct{ CPURL string }

type BudgetInput struct {
	ThroughYesterday float64 `json:"throughYesterday"`
	Today            float64 `json:"today"`
	Unrouted         float64 `json:"unrouted"`
	Blocked5m        int     `json:"blocked5m"`
	Degraded5m       int     `json:"degraded5m"`
}

func (l Ledger) post(ctx context.Context, path string, body any, out any) error {
	r := httpx.Post(ctx, l.CPURL+path, body, 10*time.Second)
	if r.Status != 200 {
		return fmt.Errorf("ledger %s → %d", path, r.Status)
	}
	if out != nil {
		return r.Decode(out)
	}
	return nil
}

func (l Ledger) BudgetInputs(ctx context.Context, teams []string, monthStart, today, now int64) (map[string]BudgetInput, error) {
	var out struct {
		Teams map[string]BudgetInput `json:"teams"`
	}
	err := l.post(ctx, "/internal/ledger/budget-inputs", map[string]any{"teams": teams, "monthStart": monthStart, "today": today, "now": now}, &out)
	return out.Teams, err
}

type DayTotal struct {
	C float64 `json:"c"`
	N float64 `json:"n"`
}

func (l Ledger) Daily(ctx context.Context, from, to int64, excludeLiveProvider string) (map[string]DayTotal, error) {
	var out struct {
		Days map[string]DayTotal `json:"days"`
	}
	body := map[string]any{"from": from, "to": to}
	if excludeLiveProvider != "" {
		body["excludeLiveProvider"] = excludeLiveProvider
	}
	err := l.post(ctx, "/internal/ledger/daily", body, &out)
	return out.Days, err
}

type Adjustment struct {
	Day       string  `json:"day"`
	Team      string  `json:"team"`
	APIKeyID  string  `json:"apiKeyId"`
	CostUsd   float64 `json:"costUsd"`
	Weight    float64 `json:"weight"`
	Source    string  `json:"source"`
	Note      string  `json:"note"`
	CreatedTs int64   `json:"createdTs"`
}

func (l Ledger) UpsertAdjustments(ctx context.Context, rows []Adjustment) error {
	return l.post(ctx, "/internal/ledger/adjustments", map[string]any{"rows": rows}, nil)
}

func (l Ledger) InsertDecision(ctx context.Context, d Decision, body string) error {
	return l.post(ctx, "/internal/ledger/decisions", map[string]any{"id": d.ID, "ts": d.Ts, "title": d.Title, "status": d.Status, "body": body}, nil)
}

type Service struct {
	Cfg     BudgetsCfg
	Topo    *config.Topology
	Pricing pricing.Pricing
	Runtime string
	Events  *events.Pusher
	Ledger  Ledger
	Admin   Admin
	Now     func() time.Time
	// ExcludeLiveProvider: live ledger rows from this provider are not on the bill being reconciled
	// ("anthropic" when reconciling the simulated bill while real Claude serves guest calls).
	ExcludeLiveProvider string

	mu         sync.Mutex
	budgets    []Budget
	recon      *Recon
	overrides  map[string]float64
	decisions  []Decision
	lastStatus map[string]string
	ledgerDown bool
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func monthStart(t time.Time) int64 {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC).UnixMilli()
}

func daysInMonth(t time.Time) int {
	u := t.UTC()
	return time.Date(u.Year(), u.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// ComputeBudgets: month-to-date spend per team (ledger, weighted, + reconciled adjustments), projection from complete
// days, status ok | warn (≥ warnAt or projected over) | exceeded, and the gateway's recent block/degrade counts.
func (s *Service) ComputeBudgets(ctx context.Context) ([]Budget, error) {
	now := s.now()
	m0, today, nowMs := monthStart(now), config.StartOfTodayUTC(now), now.UnixMilli()
	elapsed := float64(today-m0) / float64(day)
	in, err := s.Ledger.BudgetInputs(ctx, s.Cfg.TeamOrder, m0, today, nowMs)
	if err != nil {
		s.mu.Lock()
		first := !s.ledgerDown
		s.ledgerDown = true
		s.mu.Unlock()
		if first {
			fmt.Printf("[finops] budgets: ledger not reachable yet (%v)\n", err)
		}
		return nil, err
	}
	s.mu.Lock()
	s.ledgerDown = false
	s.mu.Unlock()
	out := make([]Budget, 0, len(s.Cfg.TeamOrder))
	type change struct{ msg, level string }
	var changes []change
	s.mu.Lock()
	if s.lastStatus == nil {
		s.lastStatus = map[string]string{}
	}
	for _, team := range s.Cfg.TeamOrder {
		b := s.Cfg.Teams[team]
		budget := b.MonthlyUsd
		if o, ok := s.overrides[team]; ok {
			budget = o
		}
		x := in[team]
		mtd := x.ThroughYesterday + x.Today
		var projected *float64
		if elapsed >= 1 {
			p := x.ThroughYesterday / elapsed * float64(daysInMonth(now))
			projected = &p
		}
		pct := mtd / budget
		status := "ok"
		switch {
		case pct >= 1:
			status = "exceeded"
		case pct >= s.Cfg.WarnAt || (projected != nil && *projected > budget):
			status = "warn"
		}
		out = append(out, Budget{Team: team, Budget: budget, MTD: mtd, Unrouted: x.Unrouted, Projected: projected, Pct: pct, Status: status,
			Policy: b.OnExceeded, Owner: b.Owner, Why: b.Why, Blocked5m: x.Blocked5m, Degraded5m: x.Degraded5m})
		if last := s.lastStatus[team]; last != "" && last != status {
			proj := ""
			if projected != nil && *projected != 0 {
				proj = fmt.Sprintf(", projected $%.0f", *projected)
			}
			level := "warn"
			if status == "ok" {
				level = "info"
			}
			changes = append(changes, change{fmt.Sprintf("%s budget %s → %s: $%.0f of $%s MTD (%s%%)%s — policy %s", team, last, strings.ToUpper(status), mtd,
				config.Num(budget), config.Num(config.Round(pct*100)), proj, b.OnExceeded), level})
		}
		s.lastStatus[team] = status
	}
	s.budgets = out
	s.mu.Unlock()
	for _, c := range changes {
		s.Events.Say("budget", c.msg, c.level)
	}
	return out, nil
}

// GatewayBudgets is what the LLM gateway enforces (via the control plane's /api/gateway/routes).
func (s *Service) GatewayBudgets() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{}
	for _, b := range s.budgets {
		out[b.Team] = map[string]any{"status": b.Status, "policy": b.Policy, "pct": b.Pct, "owner": b.Owner}
	}
	return out
}

func (s *Service) RaiseBudget(ctx context.Context, team string, monthlyUsd float64, approvedBy string) {
	s.mu.Lock()
	if s.overrides == nil {
		s.overrides = map[string]float64{}
	}
	before := "undefined"
	if o, ok := s.overrides[team]; ok {
		before = config.Num(o)
	} else if b, ok := s.Cfg.Teams[team]; ok {
		before = config.Num(b.MonthlyUsd)
	}
	s.overrides[team] = monthlyUsd
	s.mu.Unlock()
	s.decision(ctx, fmt.Sprintf("%s budget $%s → $%s/month", team, before, config.Num(monthlyUsd)), "approved (L3)",
		fmt.Sprintf("Approved by %s. Reason: unrouted spend found on the provider bill is now attributed to %s.", approvedBy, team))
	_, _ = s.ComputeBudgets(ctx)
	s.Events.Emit("finops", map[string]any{"at": config.NowMs(), "change": "budget"})
}

type usageBucket struct {
	StartingAt string `json:"starting_at"`
	Results    []struct {
		APIKeyID      string `json:"api_key_id"`
		Model         string `json:"model"`
		ServiceTier   string `json:"service_tier"`
		Uncached      int64  `json:"uncached_input_tokens"`
		Output        int64  `json:"output_tokens"`
		CacheRead     int64  `json:"cache_read_input_tokens"`
		CacheCreation struct {
			E5m int64 `json:"ephemeral_5m_input_tokens"`
			E1h int64 `json:"ephemeral_1h_input_tokens"`
		} `json:"cache_creation"`
	} `json:"results"`
}

type costBucket struct {
	StartingAt string `json:"starting_at"`
	Results    []struct {
		Amount      json.RawMessage `json:"amount"` // decimal string in cents
		WorkspaceID *string         `json:"workspace_id"`
	} `json:"results"`
}

type apiKey struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	WorkspaceID *string `json:"workspace_id"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"created_at"`
	CreatedBy   *struct {
		ID string `json:"id"`
	} `json:"created_by"`
}

func cents(raw json.RawMessage) float64 {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	var f float64
	_ = json.Unmarshal(raw, &f)
	return f
}

func prefix10(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

// Reconcile compares the provider bill with the ledger day by day, finds provider keys that bypass the gateway,
// attributes their spend to the owning team (ledger adjustments) and writes runtime/reports/RECON-<day>.md.
func (s *Service) Reconcile(ctx context.Context, days int, actor string) (*Recon, error) {
	if days <= 0 {
		days = 14
	}
	if actor == "" {
		actor = "finops (daily job)"
	}
	const lagMs = 10_000
	now := s.now()
	start := config.StartOfTodayUTC(now) - int64(days)*day
	cutoff := now.UnixMilli() - lagMs
	params := url.Values{"starting_at": {config.ISO(start)}, "ending_at": {config.ISO(cutoff)}, "limit": {"31"}}

	var costRaw, usageRaw []json.RawMessage
	var keysR httpx.Upstream
	var errs [3]error
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		p := url.Values{}
		for k, v := range params {
			p[k] = v
		}
		p["group_by[]"] = []string{"workspace_id", "description"}
		costRaw, errs[0] = s.Admin.paged(ctx, "/v1/organizations/cost_report", p)
	}()
	go func() {
		defer wg.Done()
		p := url.Values{}
		for k, v := range params {
			p[k] = v
		}
		p.Set("bucket_width", "1d")
		p["group_by[]"] = []string{"api_key_id", "model", "service_tier"}
		usageRaw, errs[1] = s.Admin.paged(ctx, "/v1/organizations/usage_report/messages", p)
	}()
	go func() {
		defer wg.Done()
		keysR, errs[2] = s.Admin.Call(ctx, "GET", "/v1/organizations/api_keys", url.Values{"limit": {"100"}}, nil)
	}()
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return nil, e
		}
	}
	var keys struct {
		Data []apiKey `json:"data"`
	}
	if err := keysR.Decode(&keys); err != nil {
		return nil, err
	}
	keyByID := map[string]apiKey{}
	for _, k := range keys.Data {
		keyByID[k.ID] = k
	}
	usageByDay := map[string]usageBucket{}
	for _, raw := range usageRaw {
		var u usageBucket
		if json.Unmarshal(raw, &u) == nil {
			if _, dup := usageByDay[prefix10(u.StartingAt)]; !dup {
				usageByDay[prefix10(u.StartingAt)] = u
			}
		}
	}
	ledgerByDay, err := s.Ledger.Daily(ctx, start, cutoff, s.ExcludeLiveProvider)
	if err != nil {
		return nil, err
	}

	todayStr := config.DayOf(now.UnixMilli())
	var daysOut []Day
	keyTotals := map[string]float64{}
	var keyOrder []string
	for _, raw := range costRaw {
		var cb costBucket
		if err := json.Unmarshal(raw, &cb); err != nil {
			return nil, err
		}
		d := prefix10(cb.StartingAt)
		provider := 0.0
		byWorkspace := map[string]float64{}
		for _, r := range cb.Results {
			usd := cents(r.Amount) / 100
			provider += usd
			ws := "default"
			if r.WorkspaceID != nil {
				ws = *r.WorkspaceID
			}
			byWorkspace[ws] += usd
		}
		byKey := map[string]float64{}
		var byKeyOrder []string
		for _, r := range usageByDay[d].Results {
			usd := s.Pricing.PriceCall(s.Pricing.TierOf(r.Model), pricing.Usage{InputTokens: r.Uncached, OutputTokens: r.Output, CacheReadInputTokens: r.CacheRead,
				CacheCreationInputTokens: r.CacheCreation.E5m + r.CacheCreation.E1h}, r.ServiceTier == "batch")
			if _, ok := byKey[r.APIKeyID]; !ok {
				byKeyOrder = append(byKeyOrder, r.APIKeyID)
			}
			byKey[r.APIKeyID] += usd
		}
		led := ledgerByDay[d].C
		diff := provider - led
		pct := 0.0
		if provider != 0 {
			pct = diff / provider
		}
		gatewayKey := byKey["apikey_gateway_prod"]
		unrouted := map[string]float64{}
		for _, k := range byKeyOrder {
			if k != "apikey_gateway_prod" && byKey[k] > 0.0001 {
				unrouted[k] = byKey[k]
				if _, ok := keyTotals[k]; !ok {
					keyOrder = append(keyOrder, k)
				}
				keyTotals[k] += byKey[k]
			}
		}
		status := "variance"
		if math.Abs(pct) <= 0.01 {
			status = "match"
		}
		daysOut = append(daysOut, Day{Day: d, Ledger: led, Provider: provider, Diff: diff, Pct: pct, GatewayKey: gatewayKey, Residual: gatewayKey - led,
			ByWorkspace: byWorkspace, Unrouted: unrouted, Status: status, Partial: d == todayStr})
	}

	// attribute unrouted spend to the owning team (adjustments), so budgets and dashboards see it
	var adjustments []Adjustment
	findings := []Finding{}
	for _, k := range keyOrder {
		key, ok := keyByID[k]
		if !ok {
			key = apiKey{ID: k, Name: "unknown key"}
		}
		team := "unattributed"
		if o := s.Cfg.APIKeyOwners[k]; strings.HasPrefix(o, "team-") {
			team = o
		}
		var full []Day
		for _, d := range daysOut {
			v, ok := d.Unrouted[k]
			if !ok || v == 0 {
				continue
			}
			w := 1.0
			if d.Day == todayStr {
				w = 1 / s.Topo.Accel
			}
			adjustments = append(adjustments, Adjustment{Day: d.Day, Team: team, APIKeyID: k, CostUsd: v, Weight: w, Source: "reconciliation",
				Note: "found on provider bill; key " + key.Name, CreatedTs: config.NowMs()})
			if !d.Partial {
				full = append(full, d)
			}
		}
		perDay := 0.0
		for _, d := range full {
			perDay += d.Unrouted[k]
		}
		if len(full) > 0 {
			perDay /= float64(len(full))
		}
		firstSeen := todayStr
		if len(full) > 0 {
			firstSeen = full[0].Day
		}
		ws := "Default workspace"
		if key.WorkspaceID != nil {
			ws = *key.WorkspaceID
		}
		f := Finding{APIKeyID: k, Name: key.Name, Workspace: ws, Status: key.Status, CreatedAt: key.CreatedAt, Team: team, FirstSeen: firstSeen,
			Total14d: keyTotals[k], PerDay: perDay, Monthly: perDay * 30}
		if key.CreatedBy != nil {
			f.CreatedBy = key.CreatedBy.ID
		}
		findings = append(findings, f)
	}
	if len(adjustments) > 0 {
		if err := s.Ledger.UpsertAdjustments(ctx, adjustments); err != nil {
			return nil, err
		}
	}
	variance := 0
	totLedger, totProvider, maxRes := 0.0, 0.0, 0.0
	for _, d := range daysOut {
		totLedger += d.Ledger
		totProvider += d.Provider
		if d.Status == "variance" && !d.Partial {
			variance++
		}
		// today's partial row is excluded: ledger rows are stamped at call start, the bill at completion
		if d.Provider != 0 && !d.Partial {
			maxRes = math.Max(maxRes, math.Abs(d.Residual)/d.Provider)
		}
	}
	recon := &Recon{ID: "RECON-" + todayStr, RanAt: config.NowMs(), Actor: actor, Days: daysOut, Findings: findings,
		Totals: map[string]float64{"ledger": totLedger, "provider": totProvider}, MaxResidualPct: maxRes, VarianceDays: variance}
	if recon.Days == nil {
		recon.Days = []Day{}
	}
	recon.Markdown = s.reconMarkdown(recon)
	recon.HTML = markdown.ToHTML(recon.Markdown)
	dir := filepath.Join(s.Runtime, "reports")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, recon.ID+".md"), []byte(recon.Markdown), 0o644)
	s.mu.Lock()
	s.recon = recon
	s.mu.Unlock()
	_, _ = s.ComputeBudgets(ctx)

	var named []string
	for _, f := range findings {
		named = append(named, fmt.Sprintf("%s ≈ $%s/month (%s)", f.Name, config.Num(config.Round(f.Monthly)), f.Team))
	}
	tail := ""
	if len(named) > 0 {
		tail = " — " + strings.Join(named, ", ")
	}
	level := "info"
	if len(findings) > 0 {
		level = "warn"
	}
	s.Events.Say("finops", fmt.Sprintf("Reconciliation %s: bill $%.2f vs ledger $%.2f over %d days; %d day(s) out of tolerance; %d unrouted key(s)%s",
		recon.ID, totProvider, totLedger, days, variance, len(findings), tail), level)
	s.Events.Emit("finops", map[string]any{"at": config.NowMs(), "change": "recon"})
	return recon, nil
}

func usd(n float64) string {
	if math.Abs(n) < 0.005 {
		n = 0
	}
	return fmt.Sprintf("$%.2f", n)
}

func (s *Service) reconMarkdown(r *Recon) string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	f := r.Findings
	prov, led := r.Totals["provider"], r.Totals["ledger"]
	w("# %s — Provider bill vs gateway ledger\n\n", r.ID)
	w("**Run by:** %s · **Window:** last %d days (UTC) · **Tolerance:** ±1 %% per day · **Source of truth:** provider cost report\n\n", r.Actor, len(r.Days))
	w("## Summary\n")
	w("- Bill: **%s** · Ledger: **%s** · Gap: **%s** (%.1f %%).\n", usd(prov), usd(led), usd(prov-led), (prov-led)/prov*100)
	w("- Gateway key vs ledger residual ≤ %.2f %% on every complete day — gateway metering is accurate.\n", r.MaxResidualPct*100)
	if len(f) > 0 {
		w("- The gap is explained by **%d provider key(s) that bypass the gateway**.\n\n", len(f))
		w("## Unrouted keys\n| Key | Name | Workspace | Created by | Owner team | First seen | ~Per day | ~Per month |\n|---|---|---|---|---|---|---|---|\n")
		var rows []string
		for _, x := range f {
			by := x.CreatedBy
			if by == "" {
				by = "?"
			}
			rows = append(rows, fmt.Sprintf("| `%s` | %s | %s | %s | %s | %s | %s | %s |", x.APIKeyID, x.Name, x.Workspace, by, x.Team, x.FirstSeen, usd(x.PerDay), usd(x.Monthly)))
		}
		w("%s\n\n", strings.Join(rows, "\n"))
		w("Why it matters: calls on these keys skip the gateway — no per-call tags, no PII redaction, no budget, no canary or\n")
		w("eval coverage, and they are invisible to the cost advisor. Their spend has been attributed to the owning team\n")
		w("(adjustments) so budgets now see it.\n\n")
	} else {
		w("- No unrouted keys found.\n\n\n")
	}
	w("## Daily detail\n| Day | Bill | Ledger | Gap | Gap %% | Gateway key | Unrouted | Status |\n|---|---|---|---|---|---|---|---|\n")
	var rows []string
	for _, d := range r.Days {
		label := d.Day
		if d.Partial {
			label += " (today, partial)"
		}
		pct := d.Pct * 100
		if math.Abs(d.Pct) < 0.0005 {
			pct = 0
		}
		un := 0.0
		for _, v := range d.Unrouted {
			un += v
		}
		rows = append(rows, fmt.Sprintf("| %s | %s | %s | %s | %.1f %% | %s | %s | %s |", label, usd(d.Provider), usd(d.Ledger), usd(d.Diff), pct, usd(d.GatewayKey), usd(un), d.Status))
	}
	w("%s\n\n", strings.Join(rows, "\n"))
	w("Today's row is partial and in raw demo dollars (demo traffic runs %s× faster than production; the provider report lags a few seconds here, ~5 minutes in production).\n\n", config.Num(s.Topo.Accel))
	w("## Method\n")
	w("1. `GET /v1/organizations/cost_report` (1-day buckets, group by workspace and description) → billed USD per day.\n")
	w("2. Ledger: SUM(cost) per day from the gateway's usage rows.\n")
	w("3. `GET /v1/organizations/usage_report/messages` (group by api_key_id, model, service_tier) priced with the gateway price table → which key the gap belongs to.\n")
	w("4. `GET /v1/organizations/api_keys` → key names, workspaces, creators.\n\n")
	w("## Actions\n")
	if len(f) > 0 {
		var ks, teams []string
		for _, x := range f {
			ks = append(ks, "`"+x.APIKeyID+"`")
			found := false
			for _, t := range teams {
				if t == x.Team {
					found = true
				}
			}
			if !found {
				teams = append(teams, x.Team)
			}
		}
		w("1. **L2:** deactivate %s through the admin API and point the job at the gateway (route `data.review-summaries`, batch pricing).\n", strings.Join(ks, ", "))
		w("2. **L3:** owner of %s reviews the budget — this month's unrouted spend already counts against it.\n", strings.Join(teams, ", "))
		w("3. Policy: new provider keys may only be created in the gateway's workspace; alert on any spend from other workspaces.\n")
	} else {
		w("- None.\n")
	}
	return b.String()
}

// DeactivateKey sets a provider key inactive through the admin API (L2 action, after approval).
func (s *Service) DeactivateKey(ctx context.Context, keyID, approvedBy string) (map[string]any, error) {
	r, err := s.Admin.Call(ctx, "POST", "/v1/organizations/api_keys/"+url.PathEscape(keyID), nil, map[string]any{"status": "inactive"})
	if err != nil {
		return nil, err
	}
	k := r.Body
	name, status := httpx.Str(k["name"]), httpx.Str(k["status"])
	s.mu.Lock()
	if s.recon != nil {
		for i := range s.recon.Findings {
			if s.recon.Findings[i].APIKeyID == keyID {
				s.recon.Findings[i].Status = status
			}
		}
	}
	s.mu.Unlock()
	s.decision(ctx, fmt.Sprintf("Deactivated provider key %s (%s)", name, keyID), "applied (L2)",
		fmt.Sprintf("Approved by %s. The job must call the LLM gateway (route data.review-summaries) from now on.", approvedBy))
	s.Events.Say("finops", fmt.Sprintf("Provider key %s deactivated via admin API (approved by %s); its caller must now use the gateway", name, approvedBy), "warn")
	s.Events.Emit("finops", map[string]any{"at": config.NowMs(), "change": "key"})
	return k, nil
}

func (s *Service) decision(ctx context.Context, title, status, body string) Decision {
	s.mu.Lock()
	d := Decision{ID: fmt.Sprintf("FIN-%d", len(s.decisions)+1), Ts: config.NowMs(), Title: title, Status: status}
	s.decisions = append([]Decision{d}, s.decisions...)
	s.mu.Unlock()
	if err := s.Ledger.InsertDecision(ctx, d, body); err != nil {
		fmt.Printf("[finops] could not record %s in the ledger: %v\n", d.ID, err)
	}
	dir := filepath.Join(s.Runtime, "decisions")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, d.ID+".md"), []byte(fmt.Sprintf("# Decision %s: %s — %s\n\n%s\n", config.DayOf(d.Ts), title, status, body)), 0o644)
	return d
}

// PublicState: what the dashboard shows (the control plane adds infra cost and the notebook status).
func (s *Service) PublicState() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var recon any
	if s.recon != nil {
		cp := *s.recon
		cp.Markdown = ""
		recon = cp
	}
	budgets := s.budgets
	if budgets == nil {
		budgets = []Budget{}
	}
	decisions := s.decisions
	if decisions == nil {
		decisions = []Decision{}
	}
	return map[string]any{"budgets": budgets, "recon": recon, "decisions": decisions, "warnAt": s.Cfg.WarnAt}
}

func (s *Service) Recon() (*Recon, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recon == nil {
		return nil, false
	}
	cp := *s.recon
	return &cp, true
}
