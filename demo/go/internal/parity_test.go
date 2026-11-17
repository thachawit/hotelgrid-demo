package internal_test

// Parity with the Node helpers: vectors in go/testdata/node-vectors.json are produced by
// scripts/go-parity-vectors.mjs from platform/lib/*.mjs. The Go ports must reproduce them exactly.

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"hotelgrid/internal/markdown"
	"hotelgrid/internal/rng"
	"hotelgrid/internal/stats"
)

type vectors struct {
	Markdown struct {
		Input string `json:"input"`
		HTML  string `json:"html"`
	} `json:"markdown"`
	Percentile []struct {
		Values []float64 `json:"values"`
		P      float64   `json:"p"`
		Out    float64   `json:"out"`
	} `json:"percentile"`
	TwoPropZ []struct {
		In [4]float64 `json:"in"`
		Z  float64    `json:"z"`
	} `json:"twoPropZ"`
	Mulberry32 struct {
		Seed uint32    `json:"seed"`
		Out  []float64 `json:"out"`
	} `json:"mulberry32"`
}

func load(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("../testdata/node-vectors.json")
	if err != nil {
		t.Fatalf("%v (run: node scripts/go-parity-vectors.mjs)", err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestMarkdownMatchesNode(t *testing.T) {
	v := load(t)
	if got := markdown.ToHTML(v.Markdown.Input); got != v.Markdown.HTML {
		t.Errorf("markdown differs\n go: %q\nnode: %q", got, v.Markdown.HTML)
	}
}

func TestStatsMatchNode(t *testing.T) {
	v := load(t)
	for _, c := range v.Percentile {
		if got := stats.Percentile(c.Values, c.P); got != c.Out {
			t.Errorf("Percentile(%v, %v) = %v, node %v", c.Values, c.P, got, c.Out)
		}
	}
	for _, c := range v.TwoPropZ {
		z, _, _ := stats.TwoPropZ(c.In[0], c.In[1], c.In[2], c.In[3])
		if math.Abs(z-c.Z) > 1e-12 {
			t.Errorf("TwoPropZ(%v) = %v, node %v", c.In, z, c.Z)
		}
	}
}

func TestMulberry32MatchesNode(t *testing.T) {
	v := load(t)
	r := rng.New(v.Mulberry32.Seed)
	for i, want := range v.Mulberry32.Out {
		if got := r.Float(); got != want {
			t.Errorf("draw %d = %v, node %v", i, got, want)
		}
	}
}
