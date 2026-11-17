package release

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"hotelgrid/internal/config"
	"hotelgrid/internal/telemetry"
)

var backtickRe = regexp.MustCompile("`([^`]+)`")

// ScoreCulprits ranks candidate services for a failed canary (port of incidents.mjs scoreCulprits):
// 0.35 × time proximity of the change + 0.35 × share of failing traces whose call path includes the service
// + 0.3 × release-note signature match (a `field` named in meta.breaking appears in the error messages).
// The loudest service (most error spans) is reported separately: it is usually a symptom, not the cause.
func ScoreCulprits(tel *telemetry.Store, site string, deployTs, anomalyStart, detectedAt int64, changes []ServiceChange) *Culprit {
	spans := tel.SpansIn(site, anomalyStart-2000, detectedAt+1000)
	// group by trace, keeping first-seen order (spans arrive newest first, like the Node Map)
	var traceOrder []string
	byTrace := map[string][]*telemetry.Span{}
	for _, s := range spans {
		if _, ok := byTrace[s.TraceID]; !ok {
			traceOrder = append(traceOrder, s.TraceID)
		}
		byTrace[s.TraceID] = append(byTrace[s.TraceID], s)
	}
	var failing [][]*telemetry.Span
	for _, id := range traceOrder {
		t := byTrace[id]
		for _, s := range t {
			if s.Status >= 500 {
				failing = append(failing, t)
				break
			}
		}
	}
	leafCount := map[string]int{}
	var leafOrder []string
	errorSpanCount := map[string]int{}
	var errOrder []string
	var messages []string
	for _, t := range failing {
		var errs []*telemetry.Span
		parents := map[string]bool{}
		for _, s := range t {
			if s.Status >= 500 {
				errs = append(errs, s)
				parents[s.ParentID] = true
			}
		}
		for _, e := range errs {
			if errorSpanCount[e.Service] == 0 {
				errOrder = append(errOrder, e.Service)
			}
			errorSpanCount[e.Service]++
		}
		leaf := errs[0]
		for _, e := range errs {
			if !parents[e.SpanID] {
				leaf = e
				break
			}
		}
		key := leaf.Service + "@" + leaf.Version
		if leafCount[key] == 0 {
			leafOrder = append(leafOrder, key)
		}
		leafCount[key]++
		if leaf.Error != "" {
			messages = append(messages, leaf.Error)
		}
	}

	inTrace := func(t []*telemetry.Span, svc string) bool {
		for _, s := range t {
			if s.Service == svc {
				return true
			}
		}
		return false
	}
	seen := map[string]bool{}
	var candidates []string
	for _, c := range changes {
		if !seen[c.Service] {
			seen[c.Service] = true
			candidates = append(candidates, c.Service)
		}
	}
	for _, k := range leafOrder {
		svc := strings.SplitN(k, "@", 2)[0]
		if !seen[svc] {
			seen[svc] = true
			candidates = append(candidates, svc)
		}
	}

	ranking := make([]Rank, 0, len(candidates))
	for _, svc := range candidates {
		var ch *ServiceChange
		for i := range changes {
			if changes[i].Service == svc {
				ch = &changes[i]
				break
			}
		}
		timeScore := 0.0
		if ch != nil {
			timeScore = math.Exp(-math.Max(0, float64(anomalyStart-deployTs)) / 120000)
		}
		pathShare := 0.0
		if len(failing) > 0 {
			n := 0
			for _, t := range failing {
				if inTrace(t, svc) {
					n++
				}
			}
			pathShare = float64(n) / float64(len(failing))
		}
		sigHit := ""
		if ch != nil {
			for _, m := range backtickRe.FindAllStringSubmatch(strings.Join(ch.Meta.Breaking, " "), -1) {
				tok := strings.SplitN(m[1], ".", 2)[0]
				for _, msg := range messages {
					if strings.Contains(msg, tok) {
						sigHit = tok
						break
					}
				}
				if sigHit != "" {
					break
				}
			}
		}
		sig := 0
		if sigHit != "" {
			sig = 1
		}
		score := 0.35*timeScore + 0.35*pathShare + 0.3*float64(sig)
		var evidence []string
		if ch != nil {
			evidence = append(evidence, fmt.Sprintf("changed %s → %s %ss before anomaly", ch.From, ch.To, config.Num(config.Round(float64(anomalyStart-deployTs)/1000))))
		} else {
			evidence = append(evidence, "not changed in this release")
		}
		evidence = append(evidence, fmt.Sprintf("on the call path of %s%% of failing traces", config.Num(config.Round(pathShare*100))))
		if sigHit != "" {
			evidence = append(evidence, fmt.Sprintf("release note says `%s` changed; errors mention \"%s\"", sigHit, sigHit))
		}
		leafN := 0
		for _, k := range leafOrder {
			if strings.HasPrefix(k, svc+"@") {
				leafN += leafCount[k]
			}
		}
		if leafN > 0 {
			evidence = append(evidence, fmt.Sprintf("first failing hop in %d/%d traces", leafN, len(failing)))
		}
		var version *string
		if ch != nil {
			v := ch.To
			version = &v
		}
		ranking = append(ranking, Rank{Service: svc, Version: version, Changed: ch != nil, Score: config.Round2(score),
			Time: config.Round2(timeScore), Path: config.Round2(pathShare), Sig: sig, Evidence: evidence})
	}
	sort.SliceStable(ranking, func(i, j int) bool { return ranking[i].Score > ranking[j].Score })

	out := &Culprit{FailingTraces: len(failing), LeafCount: leafCount, Ranking: ranking}
	if len(failing) > 0 {
		id := failing[0][0].TraceID
		out.SampleTrace = &id
	}
	if len(errOrder) > 0 {
		best := errOrder[0]
		for _, s := range errOrder[1:] {
			if errorSpanCount[s] > errorSpanCount[best] {
				best = s
			}
		}
		out.Loudest = &Loudest{Service: best, ErrorSpans: errorSpanCount[best]}
	}
	if len(ranking) > 0 {
		top, second := ranking[0].Score, 0.0
		if len(ranking) > 1 {
			second = ranking[1].Score
		}
		den := top + second
		if den == 0 {
			den = 1
		}
		out.Confidence = config.Round2(top / den)
	}
	if len(messages) > 0 {
		m := messages[0]
		out.TopMessage = &m
	}
	return out
}
