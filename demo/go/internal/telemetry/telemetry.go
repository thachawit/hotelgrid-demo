// Package telemetry is the span store + 2-second metric buckets + business KPIs (port of telemetry.mjs).
// It is the "Tempo/Prometheus" of the demo: every service and the LLM gateway POST spans here.
package telemetry

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"unicode/utf8"

	"hotelgrid/internal/stats"
)

const (
	BucketMs = 2000
	RetainMs = 20 * 60 * 1000
	MaxSpans = 80000
)

type Span struct {
	TraceID  string         `json:"traceId"`
	SpanID   string         `json:"spanId"`
	ParentID string         `json:"parentId"`
	Service  string         `json:"service"`
	Version  string         `json:"version"`
	Site     string         `json:"site"`
	Method   string         `json:"method"`
	Path     string         `json:"path"`
	Route    string         `json:"route"`
	Status   int            `json:"status"`
	Ms       float64        `json:"ms"`
	Error    string         `json:"error"`
	Attrs    map[string]any `json:"attrs"`
	Ts       int64          `json:"ts"`
}

// UnmarshalJSON tolerates the shapes Node senders produce: null strings, error as a non-string value.
func (s *Span) UnmarshalJSON(b []byte) error {
	var raw struct {
		TraceID  *string        `json:"traceId"`
		SpanID   *string        `json:"spanId"`
		ParentID *string        `json:"parentId"`
		Service  *string        `json:"service"`
		Version  *string        `json:"version"`
		Site     *string        `json:"site"`
		Method   *string        `json:"method"`
		Path     *string        `json:"path"`
		Route    *string        `json:"route"`
		Status   float64        `json:"status"`
		Ms       float64        `json:"ms"`
		Error    any            `json:"error"`
		Attrs    map[string]any `json:"attrs"`
		Ts       float64        `json:"ts"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	d := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	*s = Span{TraceID: d(raw.TraceID), SpanID: d(raw.SpanID), ParentID: d(raw.ParentID), Service: d(raw.Service),
		Version: d(raw.Version), Site: d(raw.Site), Method: d(raw.Method), Path: d(raw.Path), Route: d(raw.Route),
		Status: int(raw.Status), Ms: raw.Ms, Attrs: raw.Attrs, Ts: int64(raw.Ts)}
	switch e := raw.Error.(type) {
	case nil:
	case string:
		s.Error = e
	default:
		eb, _ := json.Marshal(e)
		s.Error = string(eb)
	}
	if s.Attrs == nil {
		s.Attrs = map[string]any{}
	}
	return nil
}

type agg struct {
	n, err   int
	lat      []float64
	versions map[string]int
	errMsgs  map[string]int
}

type kpiAgg struct {
	setN, mismatch, chatN, chatFail, edgeN, edgeErr int
	reasons                                         map[string]int
}

type Window struct {
	N        int            `json:"n"`
	Err      int            `json:"err"`
	ErrRate  float64        `json:"errRate"`
	P95      float64        `json:"p95"`
	Versions map[string]int `json:"versions"`
	ErrMsgs  map[string]int `json:"errMsgs"`
}

type KPI struct {
	SetN         int            `json:"setN"`
	Mismatch     int            `json:"mismatch"`
	Reasons      map[string]int `json:"reasons"`
	ChatN        int            `json:"chatN"`
	ChatFail     int            `json:"chatFail"`
	EdgeN        int            `json:"edgeN"`
	EdgeErr      int            `json:"edgeErr"`
	MismatchRate float64        `json:"mismatchRate"`
	ChatFailRate float64        `json:"chatFailRate"`
	EdgeErrRate  float64        `json:"edgeErrRate"`
}

type SeriesPoint struct {
	T       int64   `json:"t"`
	N       int     `json:"n"`
	ErrRate float64 `json:"errRate"`
	P95     float64 `json:"p95"`
}

type KPIPoint struct {
	T            int64   `json:"t"`
	MismatchRate float64 `json:"mismatchRate"`
	EdgeErrRate  float64 `json:"edgeErrRate"`
	SetN         int     `json:"setN"`
	EdgeN        int     `json:"edgeN"`
}

type Store struct {
	mu      sync.RWMutex
	spans   []*Span
	traces  map[string][]*Span
	buckets map[string]map[int64]*agg    // "site|service" -> bucket -> agg
	kpis    map[string]map[int64]*kpiAgg // site -> bucket -> agg
}

func New() *Store {
	return &Store{traces: map[string][]*Span{}, buckets: map[string]map[int64]*agg{}, kpis: map[string]map[int64]*kpiAgg{}}
}

func bkt(ts int64) int64 {
	if ts >= 0 {
		return ts / BucketMs * BucketMs
	}
	return (ts - BucketMs + 1) / BucketMs * BucketMs
}

// jsStr renders a JSON attribute the way a JS template literal would (missing → "undefined").
func jsStr(m map[string]any, k string) string {
	v, ok := m[k]
	if !ok {
		return "undefined"
	}
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	default:
		return true
	}
}

// Truthy is exported for the impact report (Set(...).filter(Boolean)).
func Truthy(v any) bool { return truthy(v) }

func truncRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

func (st *Store) Ingest(batch []*Span) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, s := range batch {
		st.spans = append(st.spans, s)
		st.traces[s.TraceID] = append(st.traces[s.TraceID], s)
		if s.Service == "llm-gateway" && s.Site == "factory" {
			continue
		}
		key := s.Site + "|" + s.Service
		m := st.buckets[key]
		if m == nil {
			m = map[int64]*agg{}
			st.buckets[key] = m
		}
		b := bkt(s.Ts)
		a := m[b]
		if a == nil {
			a = &agg{versions: map[string]int{}, errMsgs: map[string]int{}}
			m[b] = a
		}
		a.n++
		if s.Status >= 500 {
			a.err++
			a.errMsgs[truncRunes(s.Error, 140)]++
		}
		if len(a.lat) < 300 {
			a.lat = append(a.lat, s.Ms)
		}
		a.versions[s.Version]++

		km := st.kpis[s.Site]
		if km == nil {
			km = map[int64]*kpiAgg{}
			st.kpis[s.Site] = km
		}
		k := km[b]
		if k == nil {
			k = &kpiAgg{reasons: map[string]int{}}
			km[b] = k
		}
		if s.Service == "hvac-optimizer" && s.Route == "POST /setpoint" && s.Status == 200 {
			k.setN++
			if truthy(s.Attrs["mismatch"]) {
				k.mismatch++
			}
			k.reasons[jsStr(s.Attrs, "occupancy")+":"+jsStr(s.Attrs, "reason")]++
		}
		if s.Service == "guest-assistant" && s.Route == "POST /chat" {
			k.chatN++
			if s.Status >= 500 {
				k.chatFail++
			}
		}
		if s.Service == "api-gateway" {
			k.edgeN++
			if s.Status >= 500 {
				k.edgeErr++
			}
		}
	}
	if len(st.spans) > MaxSpans+2000 {
		drop := len(st.spans) - MaxSpans
		for _, old := range st.spans[:drop] {
			if t := st.traces[old.TraceID]; len(t) > 0 {
				t = t[1:]
				if len(t) == 0 {
					delete(st.traces, old.TraceID)
				} else {
					st.traces[old.TraceID] = t
				}
			}
		}
		st.spans = append([]*Span(nil), st.spans[drop:]...)
	}
}

// Prune drops metric buckets older than the retention window (Node: every 30 s).
func (st *Store) Prune(nowMs int64) {
	cutoff := nowMs - RetainMs
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, m := range st.buckets {
		for b := range m {
			if b < cutoff {
				delete(m, b)
			}
		}
	}
	for _, m := range st.kpis {
		for b := range m {
			if b < cutoff {
				delete(m, b)
			}
		}
	}
}

func (st *Store) Window(site, service string, from, to int64) Window {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := Window{Versions: map[string]int{}, ErrMsgs: map[string]int{}}
	var lat []float64
	for b, a := range st.buckets[site+"|"+service] {
		if b+BucketMs <= from || b > to {
			continue
		}
		out.N += a.n
		out.Err += a.err
		lat = append(lat, a.lat...)
		for v, c := range a.versions {
			out.Versions[v] += c
		}
		for e, c := range a.errMsgs {
			out.ErrMsgs[e] += c
		}
	}
	if out.N > 0 {
		out.ErrRate = float64(out.Err) / float64(out.N)
	}
	out.P95 = stats.Percentile(lat, 95)
	return out
}

// TopError is the most frequent error message (ties: alphabetical).
func (w Window) TopError() any {
	best, bestN := "", 0
	keys := make([]string, 0, len(w.ErrMsgs))
	for k := range w.ErrMsgs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if w.ErrMsgs[k] > bestN {
			best, bestN = k, w.ErrMsgs[k]
		}
	}
	if bestN == 0 || best == "" {
		return nil
	}
	return best
}

func (st *Store) KPI(site string, from, to int64) KPI {
	st.mu.RLock()
	defer st.mu.RUnlock()
	o := KPI{Reasons: map[string]int{}}
	for b, a := range st.kpis[site] {
		if b+BucketMs <= from || b > to {
			continue
		}
		o.SetN += a.setN
		o.Mismatch += a.mismatch
		o.ChatN += a.chatN
		o.ChatFail += a.chatFail
		o.EdgeN += a.edgeN
		o.EdgeErr += a.edgeErr
		for r, c := range a.reasons {
			o.Reasons[r] += c
		}
	}
	if o.SetN > 0 {
		o.MismatchRate = float64(o.Mismatch) / float64(o.SetN)
	}
	if o.ChatN > 0 {
		o.ChatFailRate = float64(o.ChatFail) / float64(o.ChatN)
	}
	if o.EdgeN > 0 {
		o.EdgeErrRate = float64(o.EdgeErr) / float64(o.EdgeN)
	}
	return o
}

func (st *Store) Series(site, service string, minutes int, nowMs int64) []SeriesPoint {
	st.mu.RLock()
	defer st.mu.RUnlock()
	end := bkt(nowMs)
	m := st.buckets[site+"|"+service]
	var out []SeriesPoint
	for t := end - int64(minutes)*60000; t <= end; t += BucketMs * 3 {
		n, errN := 0, 0
		var lat []float64
		for j := int64(0); j < 3; j++ {
			if a := m[t+j*BucketMs]; a != nil {
				n += a.n
				errN += a.err
				lat = append(lat, a.lat...)
			}
		}
		p := SeriesPoint{T: t, N: n, P95: stats.Percentile(lat, 95)}
		if n > 0 {
			p.ErrRate = float64(errN) / float64(n)
		}
		out = append(out, p)
	}
	return out
}

func (st *Store) KPISeries(site string, minutes int, nowMs int64) []KPIPoint {
	st.mu.RLock()
	defer st.mu.RUnlock()
	end := bkt(nowMs)
	m := st.kpis[site]
	var out []KPIPoint
	for t := end - int64(minutes)*60000; t <= end; t += BucketMs * 3 {
		var setN, mm, edgeN, edgeErr int
		for j := int64(0); j < 3; j++ {
			if a := m[t+j*BucketMs]; a != nil {
				setN += a.setN
				mm += a.mismatch
				edgeN += a.edgeN
				edgeErr += a.edgeErr
			}
		}
		p := KPIPoint{T: t, SetN: setN, EdgeN: edgeN}
		if setN > 0 {
			p.MismatchRate = float64(mm) / float64(setN)
		}
		if edgeN > 0 {
			p.EdgeErrRate = float64(edgeErr) / float64(edgeN)
		}
		out = append(out, p)
	}
	return out
}

// SpansIn returns a site's spans with from <= ts <= to, newest first (same scan and early stop as Node).
func (st *Store) SpansIn(site string, from, to int64) []*Span {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*Span
	for i := len(st.spans) - 1; i >= 0; i-- {
		s := st.spans[i]
		if s.Ts < from-5000 {
			break
		}
		if s.Site == site && s.Ts >= from && s.Ts <= to {
			out = append(out, s)
		}
	}
	return out
}

type Signature struct {
	Signature string `json:"signature"`
	Count     int    `json:"count"`
}

func (st *Store) ErrorSignatures(site string, from, to int64) []Signature {
	counts := map[string]int{}
	var order []string
	for _, s := range st.SpansIn(site, from, to) {
		if s.Status >= 500 && s.Error != "" {
			k := s.Service + ": " + s.Error
			if counts[k] == 0 {
				order = append(order, k)
			}
			counts[k]++
		}
	}
	out := make([]Signature, 0, len(order))
	for _, k := range order {
		out = append(out, Signature{k, counts[k]})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}

func (st *Store) Stats() map[string]int {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return map[string]int{"spans": len(st.spans), "traces": len(st.traces)}
}
