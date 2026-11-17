// release-controller: telemetry store + per-site manifests + ring rollouts with canary analysis + auto-rollback with
// impact reports. Go port of the control plane's telemetry.mjs, deploy.mjs, canary.mjs and incidents.mjs.
//
// Services and the LLM gateway POST spans here and poll manifests from here. The control plane (Node) proxies the
// dashboard's deploy/incident/metrics calls here and receives this service's log lines and events on /ingest/events.
//
//	go build -o release-controller ./cmd/release-controller && ./release-controller -root <demo root>
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"hotelgrid/internal/config"
	"hotelgrid/internal/events"
	"hotelgrid/internal/httpx"
	"hotelgrid/internal/release"
	"hotelgrid/internal/telemetry"
)

type server struct {
	c     *release.Controller
	tel   *telemetry.Store
	topo  *config.Topology
	sites []config.Site
}

func qInt(r *http.Request, k string, def int64) int64 {
	if v, err := strconv.ParseInt(r.URL.Query().Get(k), 10, 64); err == nil {
		return v
	}
	return def
}

func writeRaw(w http.ResponseWriter, status int, b []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, 200, map[string]any{"ok": true, "service": "release-controller", "impl": "go", "telemetry": s.tel.Stats()})
	})
	mux.HandleFunc("POST /ingest/spans", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Spans []*telemetry.Span `json:"spans"`
		}
		if err := httpx.ReadJSON(r, &body); err != nil {
			httpx.WriteJSON(w, 400, map[string]any{"error": "invalid JSON body"})
			return
		}
		s.tel.Ingest(body.Spans)
		httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/manifests", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, s.c.ManifestsJSON()) })
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, s.c.StateJSON()) })
	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		now := config.NowMs()
		out := map[string]any{}
		for _, site := range s.sites {
			svcs := map[string]any{}
			for _, svc := range s.topo.ServiceOrder {
				win := s.tel.Window(site.ID, svc, now-30000, now)
				var series []float64
				for _, p := range s.tel.Series(site.ID, svc, 5, now) {
					series = append(series, p.ErrRate)
				}
				svcs[svc] = map[string]any{"n": win.N, "errRate": win.ErrRate, "p95": win.P95, "series": series}
			}
			out[site.ID] = map[string]any{"services": svcs, "kpi": s.tel.KPI(site.ID, now-30000, now), "kpiSeries": s.tel.KPISeries(site.ID, 5, now)}
		}
		httpx.WriteJSON(w, 200, out)
	})
	mux.HandleFunc("GET /api/kpi", func(w http.ResponseWriter, r *http.Request) {
		now := config.NowMs()
		httpx.WriteJSON(w, 200, s.tel.KPI(r.URL.Query().Get("site"), qInt(r, "from", now-60000), qInt(r, "to", now)))
	})
	mux.HandleFunc("GET /api/error-signatures", func(w http.ResponseWriter, r *http.Request) {
		now := config.NowMs()
		httpx.WriteJSON(w, 200, s.tel.ErrorSignatures(r.URL.Query().Get("site"), qInt(r, "from", now-300000), qInt(r, "to", now)))
	})
	mux.HandleFunc("POST /api/versions", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Site, Service, Version, Actor, Reason string }
		if err := httpx.ReadJSON(r, &b); err != nil {
			httpx.WriteJSON(w, 400, map[string]any{"error": "invalid JSON body"})
			return
		}
		ch, err := s.c.SetVersion(b.Site, b.Service, b.Version, b.Actor, b.Reason)
		if err != nil {
			httpx.WriteJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"change": ch})
	})
	mux.HandleFunc("POST /api/releases", func(w http.ResponseWriter, r *http.Request) {
		var req release.RolloutReq
		if err := httpx.ReadJSON(r, &req); err != nil || len(req.Services.Keys) == 0 {
			httpx.WriteJSON(w, 400, map[string]any{"error": "body needs name and services"})
			return
		}
		rel := s.c.StartRollout(req)
		httpx.WriteJSON(w, 200, map[string]any{"ok": true, "id": rel.ID})
	})
	mux.HandleFunc("GET /api/releases/{id}", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := s.c.Release(r.PathValue("id")); ok {
			writeRaw(w, 200, b)
			return
		}
		httpx.WriteJSON(w, 404, map[string]any{"error": "not found"})
	})
	mux.HandleFunc("GET /api/incidents/{id}", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := s.c.Incident(r.PathValue("id")); ok {
			writeRaw(w, 200, b)
			return
		}
		httpx.WriteJSON(w, 404, map[string]any{"error": "not found"})
	})
	mux.HandleFunc("POST /api/freeze/lift", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Actor string }
		_ = httpx.ReadJSON(r, &b)
		s.c.LiftFreeze(b.Actor)
		httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /api/parity", func(w http.ResponseWriter, r *http.Request) {
		var b struct{ On bool }
		_ = httpx.ReadJSON(r, &b)
		httpx.WriteJSON(w, 200, map[string]any{"parityGate": s.c.SetParity(b.On)})
	})
	return mux
}

func main() {
	root := flag.String("root", ".", "demo root (contains config/)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[release-controller] ")

	topo, err := config.LoadTopology(*root)
	if err != nil {
		log.Fatal(err)
	}
	sites, err := config.LoadSites(*root)
	if err != nil {
		log.Fatal(err)
	}
	runtime := os.Getenv("RUNTIME")
	if runtime == "" {
		runtime = filepath.Join(*root, "runtime")
	}
	workspace := os.Getenv("WORKSPACE")
	if workspace == "" {
		workspace = filepath.Join(runtime, "workspace")
	}
	cp := topo.URL("control-plane")
	ev := events.New(cp)
	tel := telemetry.New()
	c := release.New(release.Deps{Topo: topo, Sites: sites.Sites, Rings: sites.Rings, Workspace: workspace, Runtime: runtime, Tel: tel, Events: ev, CPURL: cp})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	evDone := make(chan struct{})
	go func() { ev.Run(ctx); close(evDone) }()
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				tel.Prune(config.NowMs())
			}
		}
	}()

	port := topo.Ports["release-controller"]
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", port), Handler: (&server{c: c, tel: tel, topo: topo, sites: sites.Sites}).routes(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	b, _ := json.Marshal(map[string]any{"sites": len(sites.Sites), "rings": len(sites.Rings), "workspace": workspace})
	log.Printf("listening on :%d %s", port, b)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-evDone
}
