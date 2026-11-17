// Package stats ports the parts of platform/lib/stats.mjs the canary gate needs.
package stats

import (
	"math"
	"sort"
)

// Percentile mirrors stats.mjs percentile (nearest-rank, no interpolation).
func Percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	s := append([]float64(nil), values...)
	sort.Float64s(s)
	idx := int(math.Ceil(p/100*float64(len(s)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx > len(s)-1 {
		idx = len(s) - 1
	}
	return s[idx]
}

// TwoPropZ: is rate B (new) greater than rate A (baseline)? One-sided z of a two-proportion test.
func TwoPropZ(errA, nA, errB, nB float64) (z, pA, pB float64) {
	if nA == 0 || nB == 0 {
		return 0, 0, 0
	}
	pA, pB = errA/nA, errB/nB
	p := (errA + errB) / (nA + nB)
	se := math.Sqrt(p * (1 - p) * (1/nA + 1/nB))
	if se == 0 {
		if pB > pA {
			return 10, pA, pB
		}
		return 0, pA, pB
	}
	return (pB - pA) / se, pA, pB
}
