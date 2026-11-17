// Package config loads the demo's shared JSON config (config/*.json) the same way the Node code does,
// keeping JSON object key order where Node relies on it (Object.keys order of services, teams, release services).
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type ServiceDef struct {
	Owner string   `json:"owner"`
	Deps  []string `json:"deps"`
	Tier  string   `json:"tier"`
}

type Topology struct {
	Accel           float64               `json:"accel"`
	Ports           map[string]int        `json:"ports"`
	Services        map[string]ServiceDef `json:"services"`
	ServiceOrder    []string              `json:"-"` // key order of "services" in topology.json
	InitialManifest map[string]string     `json:"initialManifest"`
}

type Site struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Ring          int     `json:"ring"`
	Floors        []int   `json:"floors"`
	RoomsPerFloor int     `json:"roomsPerFloor"`
	PeakNow       bool    `json:"peakNow"`
	RPS           float64 `json:"rps"`
}

type Ring struct {
	ID      int     `json:"id"`
	Name    string  `json:"name"`
	BakeSec float64 `json:"bakeSec"`
}

type Sites struct {
	Sites []Site `json:"sites"`
	Rings []Ring `json:"rings"`
}

func Read(root, rel string, v any) error {
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: %w", rel, err)
	}
	return nil
}

func LoadTopology(root string) (*Topology, error) {
	var t Topology
	if err := Read(root, "config/topology.json", &t); err != nil {
		return nil, err
	}
	var raw struct {
		Services json.RawMessage `json:"services"`
	}
	if err := Read(root, "config/topology.json", &raw); err != nil {
		return nil, err
	}
	keys, err := ObjectKeys(raw.Services)
	if err != nil {
		return nil, err
	}
	t.ServiceOrder = keys
	return &t, nil
}

func LoadSites(root string) (*Sites, error) {
	var s Sites
	return &s, Read(root, "config/sites.json", &s)
}

// URL of a local service by topology name.
func (t *Topology) URL(name string) string { return fmt.Sprintf("http://127.0.0.1:%d", t.Ports[name]) }

// ObjectKeys returns the keys of a JSON object in document order.
func ObjectKeys(raw json.RawMessage) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("not a JSON object")
	}
	var keys []string
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return nil, err
		}
		keys = append(keys, k.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

// OrderedStrings is a JSON object of string values that keeps key order (release "services": {"rooms-svc": "2.4.0", ...}).
type OrderedStrings struct {
	Keys []string
	M    map[string]string
}

func NewOrderedStrings() OrderedStrings { return OrderedStrings{M: map[string]string{}} }

func (o *OrderedStrings) Set(k, v string) {
	if o.M == nil {
		o.M = map[string]string{}
	}
	if _, ok := o.M[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.M[k] = v
}

func (o *OrderedStrings) UnmarshalJSON(b []byte) error {
	keys, err := ObjectKeys(b)
	if err != nil {
		return err
	}
	m := map[string]string{}
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	o.Keys, o.M = keys, m
	return nil
}

func (o OrderedStrings) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.Keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		vb, _ := json.Marshal(o.M[k])
		buf.Write(kb)
		buf.WriteByte(':')
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// ---- JavaScript-compatible formatting (reports and log lines must read the same as the Node versions) ----

// Num formats a float like JavaScript's String(n): 16 → "16", 0.7 → "0.7".
func Num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// Round is JavaScript's Math.round (halves round toward +Infinity).
func Round(x float64) float64 { return math.Floor(x + 0.5) }

// Round2 is Math.round(x * 100) / 100.
func Round2(x float64) float64 { return Round(x*100) / 100 }

// ISO is new Date(ms).toISOString().
func ISO(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

// DayOf is new Date(ms).toISOString().slice(0, 10).
func DayOf(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }

// StartOfTodayUTC in epoch ms.
func StartOfTodayUTC(now time.Time) int64 {
	y, m, d := now.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).UnixMilli()
}

func NowMs() int64 { return time.Now().UnixMilli() }
