// Package events ships log lines and typed events from a Go service to the control plane's event bus
// (POST /ingest/events), which fans them out to the dashboard over SSE. Order is preserved: one sender goroutine,
// batches every 100 ms, bounded buffer, retries while the control plane is starting.
package events

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"hotelgrid/internal/httpx"
)

type Event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type Pusher struct {
	URL   string // control plane base URL; "" = log to stdout only (tests)
	Quiet bool

	mu      sync.Mutex
	pending []Event
	wake    chan struct{}
}

const maxPending = 2000

func New(cpURL string) *Pusher {
	return &Pusher{URL: cpURL, wake: make(chan struct{}, 1), Quiet: os.Getenv("CP_QUIET") == "1"}
}

// Say mirrors bus.mjs say(source, msg, {level}).
func (p *Pusher) Say(source, msg, level string) {
	if level == "" {
		level = "info"
	}
	if p == nil {
		return
	}
	if !p.Quiet {
		fmt.Printf("[%s] %s\n", source, msg)
	}
	p.Emit("log", map[string]any{"source": source, "msg": msg, "level": level})
}

// Emit marshals data immediately (callers may keep mutating the object) and queues it.
func (p *Pusher) Emit(typ string, data any) {
	if p == nil {
		return
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	b := []byte("null")
	if enc.Encode(data) == nil {
		b = bytes.TrimRight(buf.Bytes(), "\n")
	}
	p.mu.Lock()
	p.pending = append(p.pending, Event{Type: typ, Data: b})
	if len(p.pending) > maxPending {
		p.pending = p.pending[len(p.pending)-maxPending:]
	}
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// Run sends batches until ctx ends, then flushes once.
func (p *Pusher) Run(ctx context.Context) {
	if p.URL == "" {
		<-ctx.Done()
		return
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			p.flush(context.Background())
			return
		case <-tick.C:
		case <-p.wake:
			time.Sleep(20 * time.Millisecond) // let a burst of events join the batch
		}
		p.flush(ctx)
	}
}

func (p *Pusher) flush(ctx context.Context) {
	p.mu.Lock()
	batch := p.pending
	p.pending = nil
	p.mu.Unlock()
	if len(batch) == 0 {
		return
	}
	r := httpx.Post(ctx, p.URL+"/ingest/events", map[string]any{"events": batch}, 3*time.Second)
	if r.Status != 200 {
		// control plane not up yet (or restarting): put the batch back in front, keep order
		p.mu.Lock()
		p.pending = append(batch, p.pending...)
		if len(p.pending) > maxPending {
			p.pending = p.pending[len(p.pending)-maxPending:]
		}
		p.mu.Unlock()
	}
}

// Drain returns and clears queued events (tests).
func (p *Pusher) Drain() []Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.pending
	p.pending = nil
	return b
}
