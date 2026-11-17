package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/events"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/telemetry"
)

// Timing makes the controller's waits configurable (tests run them in milliseconds).
type Timing struct {
	GateEvery     time.Duration // canary analysis interval while baking
	RollbackStep  time.Duration // pause between rolling back services (consumers first)
	RecoveryPoll  time.Duration // recovery check interval after rollback
	RecoveryTries int
	BakeScale     float64 // multiplies ring bakeSec (1 in production)
}

var DefaultTiming = Timing{GateEvery: 2 * time.Second, RollbackStep: 1500 * time.Millisecond, RecoveryPoll: 2 * time.Second, RecoveryTries: 12, BakeScale: 1}

type Deps struct {
	Topo      *config.Topology
	Sites     []config.Site
	Rings     []config.Ring
	Workspace string // git workspace with services/<svc>/versions/<ver>.mjs (the "artifact registry")
	Runtime   string // reports are written to <runtime>/reports
	Tel       *telemetry.Store
	Events    *events.Pusher
	CPURL     string // control plane, for /internal/* (fix tasks, ledger, signals)
	// Meta returns a version's release-note metadata; default asks the service (GET /__meta/<version>).
	Meta   func(ctx context.Context, service, version string) VersionMeta
	Timing Timing
}

type Controller struct {
	d          Deps
	mu         sync.Mutex
	manifests  map[string]map[string]string
	history    []*ManifestChange
	releases   []*Release
	freeze     *Freeze
	parityGate bool
	incidents  []*Incident
	relSeq     int
	incSeq     int
}

func New(d Deps) *Controller {
	if d.Timing == (Timing{}) {
		d.Timing = DefaultTiming
	}
	if d.Meta == nil {
		d.Meta = func(ctx context.Context, service, version string) VersionMeta {
			var m VersionMeta
			r := httpx.Get(ctx, fmt.Sprintf("%s/__meta/%s", d.Topo.URL(service), version), 3*time.Second)
			if r.OK() {
				_ = r.Decode(&m)
			}
			return m
		}
	}
	c := &Controller{d: d, manifests: map[string]map[string]string{}}
	for _, s := range d.Sites {
		m := map[string]string{}
		for k, v := range d.Topo.InitialManifest {
			m[k] = v
		}
		c.manifests[s.ID] = m
	}
	return c
}

func (c *Controller) say(source, msg, level string) { c.d.Events.Say(source, msg, level) }
func (c *Controller) emit(typ string, data any)     { c.d.Events.Emit(typ, data) }

// ---------------- manifests ----------------

// VersionsOf lists a service's versions in the workspace (os.ReadDir is sorted by name).
func (c *Controller) VersionsOf(svc string) []string {
	entries, err := os.ReadDir(filepath.Join(c.d.Workspace, "services", svc, "versions"))
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".mjs") {
			out = append(out, strings.TrimSuffix(e.Name(), ".mjs"))
		}
	}
	return out
}

// setVersionLocked: caller holds c.mu.
func (c *Controller) setVersionLocked(site, svc, ver string, release *string, actor, reason string) (*ManifestChange, error) {
	found := false
	for _, v := range c.VersionsOf(svc) {
		if v == ver {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("%s@%s not found in workspace", svc, ver)
	}
	m := c.manifests[site]
	if m == nil {
		return nil, fmt.Errorf("unknown site %s", site)
	}
	from := m[svc]
	if from == ver {
		return nil, nil
	}
	m[svc] = ver
	ev := &ManifestChange{Ts: config.NowMs(), Site: site, Service: svc, From: from, To: ver, Release: release, Actor: actor, Reason: reason}
	c.history = append([]*ManifestChange{ev}, c.history...)
	if len(c.history) > 300 {
		c.history = c.history[:300]
	}
	c.emit("manifest", map[string]any{"site": site, "manifest": m, "change": ev})
	return ev, nil
}

func (c *Controller) SetVersion(site, svc, ver, actor, reason string) (*ManifestChange, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.setVersionLocked(site, svc, ver, nil, actor, reason)
}

func (c *Controller) Manifests() map[string]map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return copyManifests(c.manifests)
}

func copyManifests(in map[string]map[string]string) map[string]map[string]string {
	out := make(map[string]map[string]string, len(in))
	for s, m := range in {
		cp := make(map[string]string, len(m))
		for k, v := range m {
			cp[k] = v
		}
		out[s] = cp
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// ConsumersOf: services (topology order) that depend on any of the given services.
func (c *Controller) ConsumersOf(services []string) []string {
	out := []string{}
	for _, svc := range c.d.Topo.ServiceOrder {
		for _, d := range c.d.Topo.Services[svc].Deps {
			if contains(services, d) {
				out = append(out, svc)
				break
			}
		}
	}
	return out
}

// RollbackOrder: consumers before the providers they depend on, among the changed services.
func (c *Controller) RollbackOrder(changed []string) []string {
	out := append([]string(nil), changed...)
	deps := func(s string) []string { return c.d.Topo.Services[s].Deps }
	sort.SliceStable(out, func(i, j int) bool { return contains(deps(out[i]), out[j]) })
	return out
}

type Drift struct {
	Service string   `json:"service"`
	Staging string   `json:"staging"`
	Prod    []string `json:"prod"`
}

func (c *Controller) driftLocked() []Drift {
	out := []Drift{}
	staging := c.manifests["staging"]
	for _, svc := range c.d.Topo.ServiceOrder {
		var prodVs []string
		differs := false
		for _, s := range c.d.Sites {
			if s.Ring <= 0 {
				continue
			}
			v := c.manifests[s.ID][svc]
			if !contains(prodVs, v) {
				prodVs = append(prodVs, v)
			}
			if v != staging[svc] {
				differs = true
			}
		}
		if differs {
			out = append(out, Drift{Service: svc, Staging: staging[svc], Prod: prodVs})
		}
	}
	return out
}

// parityLocked: services the release's changed services interact with must match staging at every target site.
func (c *Controller) parityLocked(changed []string, siteIDs []string) Parity {
	var related []string
	add := func(s string) {
		if _, ok := c.d.Topo.Services[s]; ok && !contains(changed, s) && !contains(related, s) {
			related = append(related, s)
		}
	}
	for _, s := range c.ConsumersOf(changed) {
		add(s)
	}
	for _, s := range changed {
		for _, d := range c.d.Topo.Services[s].Deps {
			add(d)
		}
	}
	p := Parity{OK: true, Problems: []ParityProblem{}}
	for _, site := range siteIDs {
		for _, svc := range related {
			if c.manifests[site][svc] != c.manifests["staging"][svc] {
				p.Problems = append(p.Problems, ParityProblem{Site: site, Service: svc, SiteVersion: c.manifests[site][svc], StagingVersion: c.manifests["staging"][svc]})
			}
		}
	}
	p.OK = len(p.Problems) == 0
	return p
}

// ---------------- freeze / parity ----------------

func (c *Controller) LiftFreeze(actor string) {
	c.mu.Lock()
	c.freeze = nil
	c.emit("freeze", nil)
	c.mu.Unlock()
	if actor != "" {
		c.say("deploy", "Deploy freeze lifted by "+actor, "info")
	}
}

func (c *Controller) SetParity(on bool) bool {
	c.mu.Lock()
	c.parityGate = on
	c.mu.Unlock()
	state := "OFF"
	if on {
		state = "ON"
	}
	c.say("deploy", "Manifest parity gate "+state, "info")
	return on
}

// ---------------- rollout ----------------

type failure struct {
	site string
	gate *Gate
}

// StartRollout records the release and runs its rings in the background. Poll Release(id) until Settled.
func (c *Controller) StartRollout(req RolloutReq) *Release {
	if req.Level == "" {
		req.Level = "L2"
	}
	if req.Actor == "" {
		req.Actor = "engineer"
	}
	c.mu.Lock()
	c.relSeq++
	rel := &Release{ID: fmt.Sprintf("REL-%d", c.relSeq), Name: req.Name, Services: req.Services, Level: req.Level, Actor: req.Actor,
		WorkItemID: req.WorkItemID, Status: "rolling", StartedAt: config.NowMs(), Rings: []*RingRec{}}
	c.releases = append([]*Release{rel}, c.releases...)
	parts := make([]string, 0, len(req.Services.Keys))
	for _, k := range req.Services.Keys {
		parts = append(parts, k+"@"+req.Services.M[k])
	}
	c.emit("release", rel)
	c.mu.Unlock()
	c.say("deploy", fmt.Sprintf(`%s "%s" started: %s (%s, by %s)`, rel.ID, req.Name, strings.Join(parts, ", "), req.Level, req.Actor), "info")
	go c.run(rel, req)
	return rel
}

func (c *Controller) publish(rel *Release) {
	c.mu.Lock()
	c.emit("release", rel)
	c.mu.Unlock()
}

func (c *Controller) run(rel *Release, req RolloutReq) {
	defer func() {
		c.mu.Lock()
		rel.Settled = true
		c.emit("release", rel)
		c.mu.Unlock()
	}()
	changed := req.Services.Keys
	var watched []string
	for _, s := range append(append(append([]string{}, changed...), c.ConsumersOf(changed)...), "api-gateway") {
		if !contains(watched, s) {
			watched = append(watched, s)
		}
	}
	for _, ring := range c.d.Rings {
		var siteIDs []string
		for _, s := range c.d.Sites {
			if s.Ring == ring.ID {
				siteIDs = append(siteIDs, s.ID)
			}
		}
		c.mu.Lock()
		rr := &RingRec{Ring: ring.ID, Name: ring.Name, Sites: siteIDs, Status: "deploying", Gates: []*Gate{}}
		rel.Rings = append(rel.Rings, rr)
		frozen := c.freeze
		if frozen != nil && req.OverrideFreeze && ring.ID == 0 {
			c.mu.Unlock()
			c.say("deploy", fmt.Sprintf("%s proceeds under freeze override: fix for %s", rel.ID, frozen.Incident), "warn")
			c.mu.Lock()
		}
		if frozen != nil && !req.OverrideFreeze {
			rr.Status, rel.Status = "blocked:freeze", "blocked:freeze"
			c.emit("release", rel)
			c.mu.Unlock()
			c.say("deploy", fmt.Sprintf("%s blocked: deploy freeze active (%s)", rel.ID, frozen.Reason), "warn")
			return
		}
		if c.parityGate && ring.ID >= 1 {
			p := c.parityLocked(changed, siteIDs)
			rr.Parity = &p
			if !p.OK {
				rr.Status, rel.Status = "blocked:parity", "blocked:parity"
				c.emit("release", rel)
				c.mu.Unlock()
				var msgs []string
				for _, x := range p.Problems {
					msgs = append(msgs, fmt.Sprintf("%s runs %s@%s, staging ran @%s", x.Site, x.Service, x.SiteVersion, x.StagingVersion))
				}
				c.say("deploy", fmt.Sprintf(`%s blocked by parity gate before ring "%s": %s`, rel.ID, ring.Name, strings.Join(msgs, "; ")), "warn")
				return
			}
		}
		prev := map[string]map[string]string{}
		t0 := config.NowMs()
		var setErr error
		for _, site := range siteIDs {
			prev[site] = map[string]string{}
			for _, svc := range changed {
				prev[site][svc] = c.manifests[site][svc]
				relID := rel.ID
				if _, err := c.setVersionLocked(site, svc, req.Services.M[svc], &relID, req.Actor, ""); err != nil {
					setErr = err
				}
			}
		}
		if setErr != nil {
			rr.Status, rel.Status = "failed", "failed"
			c.emit("release", rel)
			c.mu.Unlock()
			c.say("deploy", fmt.Sprintf("%s failed: %v", rel.ID, setErr), "error")
			return
		}
		bake := ring.BakeSec
		if ring.ID == 1 {
			bake += req.ExtraPilotBakeSec
		}
		rr.DeployedAt, rr.Status = t0, "baking"
		c.emit("release", rel)
		c.mu.Unlock()
		c.say("deploy", fmt.Sprintf("%s ring %d (%s) deployed to %s — baking %ss with canary analysis", rel.ID, ring.ID, ring.Name, strings.Join(siteIDs, ", "), config.Num(bake)), "info")

		bakeMs := int64(bake * 1000 * c.d.Timing.BakeScale)
		var failed *failure
		for config.NowMs()-t0 < bakeMs && failed == nil {
			time.Sleep(c.d.Timing.GateEvery)
			for _, site := range siteIDs {
				g := Evaluate(c.d.Tel, site, watched, t0, config.NowMs(), false)
				c.mu.Lock()
				rr.LastGate = g
				c.mu.Unlock()
				if !g.Pass {
					failed = &failure{site, g}
					break
				}
			}
			c.publish(rel)
		}
		if failed == nil {
			for _, site := range siteIDs {
				g := Evaluate(c.d.Tel, site, watched, t0, config.NowMs(), true)
				c.mu.Lock()
				rr.Gates = append(rr.Gates, g)
				c.mu.Unlock()
				if !g.Pass {
					failed = &failure{site, g}
					break
				}
				if g.Insufficient {
					c.say("canary", site+": not enough samples to judge — passing with warning", "warn")
				}
			}
		}
		if failed != nil {
			c.mu.Lock()
			rr.Status, rel.Status = "failed", "rolled-back"
			if n := len(rr.Gates); n == 0 || rr.Gates[n-1] != failed.gate {
				rr.Gates = append(rr.Gates, failed.gate)
			}
			c.emit("release", rel)
			c.mu.Unlock()
			c.say("canary", fmt.Sprintf("%s gate FAILED at %s: %s", rel.ID, failed.site, strings.Join(failed.gate.Failed, ", ")), "error")
			c.handleGateFailure(rel, siteIDs, prev, failed, t0, changed)
			c.publish(rel)
			return
		}
		c.mu.Lock()
		rr.Status = "passed"
		c.emit("release", rel)
		c.mu.Unlock()
		c.say("canary", fmt.Sprintf("%s ring %d (%s) passed canary analysis", rel.ID, ring.ID, ring.Name), "info")
	}
	c.mu.Lock()
	rel.Status, rel.FinishedAt = "complete", config.NowMs()
	c.emit("release", rel)
	c.mu.Unlock()
	c.say("deploy", rel.ID+" complete on all sites", "info")
}

// ---------------- read models ----------------

func (c *Controller) Release(id string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, r := range c.releases {
		if r.ID == id {
			return mustJSON(r), true
		}
	}
	return nil, false
}

func (c *Controller) Incident(id string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, i := range c.incidents {
		if i.ID == id {
			return mustJSON(i), true
		}
	}
	return nil, false
}

// StateJSON is what the control plane merges into /api/state.
func (c *Controller) StateJSON() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	versions := map[string][]string{}
	for _, svc := range c.d.Topo.ServiceOrder {
		versions[svc] = c.VersionsOf(svc)
	}
	// never null: the Node consumers (factory triage, dashboard) call .slice/.map on these
	rels := append([]*Release{}, c.releases...)
	if len(rels) > 12 {
		rels = rels[:12]
	}
	hist := append([]*ManifestChange{}, c.history...)
	if len(hist) > 40 {
		hist = hist[:40]
	}
	incs := make([]Incident, 0, len(c.incidents))
	for _, i := range c.incidents {
		cp := *i
		if i.Report != nil {
			cp.Report = &Report{Numbers: i.Report.Numbers}
		}
		incs = append(incs, cp)
	}
	return mustJSON(map[string]any{
		"manifests": c.manifests, "drift": c.driftLocked(), "freeze": c.freeze, "parityGate": c.parityGate,
		"releases": rels, "history": hist, "versions": versions, "incidents": incs, "telemetry": c.d.Tel.Stats(),
	})
}

func (c *Controller) ManifestsJSON() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return mustJSON(map[string]any{"sites": c.manifests})
}
