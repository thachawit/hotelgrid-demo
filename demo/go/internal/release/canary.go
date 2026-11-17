package release

import (
	"strings"

	"hotelgrid/internal/config"
	"hotelgrid/internal/stats"
	"hotelgrid/internal/telemetry"
)

// GateConfig mirrors canary.mjs GATE: compare a site's metrics after a deploy with the same site's pre-deploy baseline.
var GateConfig = struct {
	MinSamples    int
	ErrRateDelta  float64
	ZMin          float64
	P95Ratio      float64
	P95SlackMs    float64
	MismatchDelta float64
	MismatchMinN  int
	BaselineMs    int64
}{15, 0.03, 3, 1.6, 60, 0.15, 10, 60000}

// Evaluate runs the canary gate for one site: 5xx rate (absolute delta + one-sided two-proportion z), p95 latency,
// and the business KPI setpoint_mismatch_rate.
func Evaluate(tel *telemetry.Store, site string, services []string, deployTs, now int64, final bool) *Gate {
	g := GateConfig
	baseFrom, curFrom := deployTs-g.BaselineMs, deployTs+1500
	var checks []Check
	for _, svc := range services {
		b := tel.Window(site, svc, baseFrom, deployTs)
		c := tel.Window(site, svc, curFrom, now)
		z, _, _ := stats.TwoPropZ(float64(b.Err), float64(b.N), float64(c.Err), float64(c.N))
		enough := c.N >= g.MinSamples
		errFail := enough && c.ErrRate-b.ErrRate > g.ErrRateDelta && z > g.ZMin
		latFail := enough && b.N >= g.MinSamples && c.P95 > b.P95*g.P95Ratio+g.P95SlackMs
		verdict := "waiting"
		switch {
		case errFail:
			verdict = "fail:error-rate"
		case latFail:
			verdict = "fail:latency"
		case enough:
			verdict = "pass"
		}
		zr := config.Round(z*10) / 10
		checks = append(checks, Check{
			Kind: "service", Service: svc, Enough: enough,
			Baseline: map[string]any{"n": b.N, "errRate": b.ErrRate, "p95": b.P95},
			Current:  map[string]any{"n": c.N, "errRate": c.ErrRate, "p95": c.P95},
			Z:        &zr, Verdict: verdict, TopError: c.TopError(),
		})
	}
	kb, kc := tel.KPI(site, baseFrom, deployTs), tel.KPI(site, curFrom, now)
	kEnough := kc.SetN >= g.MismatchMinN
	kFail := kEnough && kc.MismatchRate > kb.MismatchRate+g.MismatchDelta
	kv := "waiting"
	if kFail {
		kv = "fail:kpi"
	} else if kEnough {
		kv = "pass"
	}
	checks = append(checks, Check{
		Kind: "kpi", Service: "setpoint_mismatch_rate", Enough: kEnough,
		Baseline: map[string]any{"n": kb.SetN, "rate": kb.MismatchRate},
		Current:  map[string]any{"n": kc.SetN, "rate": kc.MismatchRate},
		Verdict:  kv,
	})
	failed := []string{}
	allWaiting := true
	for _, c := range checks {
		if strings.HasPrefix(c.Verdict, "fail") {
			failed = append(failed, c.Service+" "+c.Verdict)
		}
		if c.Verdict != "waiting" {
			allWaiting = false
		}
	}
	return &Gate{Site: site, At: now, Pass: len(failed) == 0, Failed: failed, Insufficient: allWaiting, Final: final, Checks: checks}
}
