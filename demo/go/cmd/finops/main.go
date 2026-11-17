// finops: team budgets the LLM gateway enforces + daily reconciliation of the provider bill against the gateway
// ledger + provider key actions. Go port of control-plane/finops.mjs.
//
// Provider admin API: the demo's simulated provider by default; PROVIDER_ADMIN=anthropic switches to the real
// Admin API with a key you put in ANTHROPIC_ADMIN_KEY yourself (never read, printed or stored by this demo).
//
//	go build -o finops ./cmd/finops && ./finops -root <demo root>
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/events"
	"hotelgrid/internal/finops"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/pricing"
)

func routes(s *finops.Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, 200, map[string]any{"ok": true, "service": "finops", "impl": "go"})
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) { httpx.WriteJSON(w, 200, s.PublicState()) })
	mux.HandleFunc("GET /api/budgets/gateway", func(w http.ResponseWriter, r *http.Request) { httpx.WriteJSON(w, 200, s.GatewayBudgets()) })
	mux.HandleFunc("GET /api/recon", func(w http.ResponseWriter, r *http.Request) {
		if rc, ok := s.Recon(); ok {
			httpx.WriteJSON(w, 200, rc)
			return
		}
		httpx.WriteJSON(w, 404, map[string]any{"error": "not run yet"})
	})
	mux.HandleFunc("POST /api/reconcile", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Days  int    `json:"days"`
			Actor string `json:"actor"`
		}
		_ = httpx.ReadJSON(r, &b)
		rc, err := s.Reconcile(r.Context(), b.Days, b.Actor)
		if err != nil {
			s.Events.Say("finops", "Reconciliation failed: "+err.Error(), "error")
			httpx.WriteJSON(w, 502, map[string]any{"error": err.Error()})
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"recon": rc, "state": s.PublicState()})
	})
	mux.HandleFunc("POST /api/keys/{id}/deactivate", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			ApprovedBy string `json:"approvedBy"`
		}
		_ = httpx.ReadJSON(r, &b)
		if b.ApprovedBy == "" {
			b.ApprovedBy = "engineer"
		}
		k, err := s.DeactivateKey(r.Context(), r.PathValue("id"), b.ApprovedBy)
		if err != nil {
			httpx.WriteJSON(w, 502, map[string]any{"error": err.Error()})
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"key": k})
	})
	mux.HandleFunc("POST /api/budgets/{team}/raise", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			MonthlyUsd float64 `json:"monthlyUsd"`
			ApprovedBy string  `json:"approvedBy"`
		}
		_ = httpx.ReadJSON(r, &b)
		if b.MonthlyUsd <= 0 {
			httpx.WriteJSON(w, 400, map[string]any{"error": "monthlyUsd must be > 0"})
			return
		}
		if b.ApprovedBy == "" {
			b.ApprovedBy = "owner"
		}
		s.RaiseBudget(r.Context(), r.PathValue("team"), b.MonthlyUsd, b.ApprovedBy)
		httpx.WriteJSON(w, 200, s.PublicState())
	})
	return mux
}

func main() {
	root := flag.String("root", ".", "demo root (contains config/)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[finops] ")

	topo, err := config.LoadTopology(*root)
	if err != nil {
		log.Fatal(err)
	}
	budgets, err := finops.LoadBudgets(*root)
	if err != nil {
		log.Fatal(err)
	}
	pr, err := pricing.Load(*root)
	if err != nil {
		log.Fatal(err)
	}
	runtime := os.Getenv("RUNTIME")
	if runtime == "" {
		runtime = filepath.Join(*root, "runtime")
	}
	admin := finops.SimAdmin(topo.URL("sim-llm"))
	adminName := "simulated provider"
	if os.Getenv("PROVIDER_ADMIN") == "anthropic" {
		admin, adminName = finops.AnthropicAdmin(), "Anthropic Admin API (PROVIDER_ADMIN=anthropic)"
	}
	cp := topo.URL("control-plane")
	ev := events.New(cp)
	s := &finops.Service{Cfg: budgets, Topo: topo, Pricing: pr, Runtime: runtime, Events: ev, Ledger: finops.Ledger{CPURL: cp}, Admin: admin}
	if os.Getenv("PROVIDER_ADMIN") != "anthropic" && os.Getenv("LLM_PROVIDER") == "anthropic" {
		s.ExcludeLiveProvider = "anthropic" // real Claude calls are on Anthropic's bill, not the simulated one
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	evDone := make(chan struct{})
	go func() { ev.Run(ctx); close(evDone) }()
	go func() { // budgets every 3 s, like the Node module
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		_, _ = s.ComputeBudgets(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_, _ = s.ComputeBudgets(ctx)
			}
		}
	}()

	port := topo.Ports["finops"]
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", port), Handler: routes(s), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Printf("listening on :%d — %d team budgets, provider admin: %s", port, len(budgets.TeamOrder), adminName)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-evDone
}
