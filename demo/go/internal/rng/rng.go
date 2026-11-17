// Package rng ports util.mjs mulberry32 + pick so a seeded Go loadgen draws the same sequence as the Node one.
package rng

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Mulberry32 is a tiny seeded PRNG returning floats in [0,1). Safe for concurrent use.
type Mulberry32 struct {
	mu sync.Mutex
	a  uint32
}

func New(seed uint32) *Mulberry32 { return &Mulberry32{a: seed} }

func (m *Mulberry32) Float() float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.a += 0x6d2b79f5
	t := m.a
	t = (t ^ (t >> 15)) * (1 | t)
	t = (t + (t^(t>>7))*(61|t)) ^ t
	return float64(t^(t>>14)) / 4294967296.0
}

// Pick mirrors util.mjs pick: arr[floor(rng() * len)].
func Pick[T any](r *Mulberry32, arr []T) T { return arr[int(r.Float()*float64(len(arr)))] }

// Hex returns n random bytes as hex (util.mjs hex). TraceID = Hex(16), SpanID = Hex(8).
func Hex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
