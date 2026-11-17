# HotelGrid Full Factory — technical guide

The overview for readers is `../README.md` (also as `../README.pdf`). This file is the operator's guide.

A local, runnable demo of a software factory that **fixes itself from user comments**, **rolls back bad releases
across services with an impact report**, **runs an AI-cost savings loop**, and **reconciles the provider bill with
its own ledger and enforces team budgets** — on a fictional but realistic
multi-site hotel platform. Zero npm and zero Go-module dependencies; needs Node 22.5+, Go 1.24+ and git.

```bash
cd demo
npm start            # or: node scripts/start.mjs --reset   (fresh repo, ledger, reports)
open http://127.0.0.1:4000
```

`npm start` builds the Go services into `runtime/bin/` first (about a second with a warm Go build cache).
Stop with Ctrl+C. Logs: `runtime/logs/`. Everything the agents produce lands in `runtime/` (git repo, SQLite
ledger, reports) and is recreated by `--reset`.

## The system under test: HotelGrid (fictional)

5 hotel sites (staging, a pilot hotel, 3 more), 5 services, real HTTP between 12 processes — a Node control plane
and HotelGrid services, plus Go services for everything on the hot path or running as a controller:

| Process | Port | Language | Role |
|---|---|---|---|
| control-plane | 4000 | Node | dashboard + API + SSE hub, intake/signals, factory pipeline, cost ledger (SQLite) + advisor; proxies deploy/incident/finops calls to the Go services |
| release-controller | 4300 | **Go** | telemetry store (spans, 2 s metrics, KPIs), per-site manifests, ring rollouts with canary analysis, freeze, parity gate, auto-rollback, culprit scoring, impact reports |
| finops | 4400 | **Go** | team budgets (enforced by the gateway), daily provider-bill vs ledger reconciliation, provider key actions |
| api-gateway | 4001 | Node | edge API for the guest app |
| rooms-svc | 4002 | Node | room state, occupancy, temperature |
| hvac-optimizer | 4003 | Node | effective AC setpoint (comfort vs peak-tariff contract) |
| guest-assistant | 4004 | Node | LLM concierge, English + Thai: intent → action → reply |
| feedback-intake | 4005 | Node | LINE / Slack webhooks → signals (PII redaction, prompt-injection flag) |
| llm-gateway | 4100 | **Go** (Node fallback) | every LLM call: routing, canary arms, tags, pricing, **budget enforcement**, usage → ledger |
| sim-llm | 4200 | Node | simulated model provider (Messages-API shape, token + prompt-cache accounting) **plus its own bill and admin API** (per API key) |
| loadgen | — | **Go** | guest traffic at all sites; unhappy guests complain on LINE |
| ds-notebook | — | Node | data team's nightly job calling the provider **directly with its own key** (bypasses the gateway) |
| claude-adapter | 4210 | **Go** (optional) | only with `LLM_PROVIDER=anthropic`: guest-assistant calls → real Claude through the official Go SDK |

Each site has its own **manifest** (service → version). Services hot-load the version file each site runs from
`runtime/workspace` — a real git repo the agents commit to.

## Four scenarios (top-right buttons)

Toggle **Approvals: human / autopilot** in the header. With *human*, the factory stops at the approval gate and
waits for you to press **Approve** on the work item.

### S1 Self-heal — guest comment → shipped fix
A real bug ships at start: `hvac-optimizer@1.8.0` applies the peak-tariff floor to **occupied** rooms instead of
vacant ones, so guests asking for 22 °C get 25 °C. Watch it happen live:

1. Guests complain on LINE (Thai and English); a KPI alert fires (`setpoint_mismatch_rate`). One complaint carries a
   prompt-injection attempt — flagged and treated as data.
2. Intake clusters them. Triage agent weighs the cluster against goals/owners and trace evidence → `P2 · hvac-optimizer · L2`.
3. Repro agent writes a regression test; it **fails** on 1.8.0 (`node --test`, real).
4. Spec → build agent creates `1.8.1` on a git worktree branch.
5. Validate: tests, policy (diff size / paths), secret scan, AI review, golden set (+ Thai slice when relevant) → PR.
6. Approval (L2) → merge → ring rollout staging → pilot hotel → all sites, each ring canary-gated.
7. Mismatch drops to ~0; guests get a (simulated) LINE reply; the outcome's LLM cost is recorded.

### S2 Bad release — cross-service rollback + impact report
Release `2026.11-r2` = `rooms-svc 2.4.0` (renames `occupancy` → `occupancyStatus`) + `guest-assistant 3.1.0`.
Staging passed only because QA had `hvac-optimizer 1.9.0-rc1` there (manifest drift).

1. Pilot hotel ring → hvac throws `missing field "occupancy"`; edge 5xx climbs.
2. Canary gate (two-proportion z-test + latency + business KPI) trips in seconds.
3. Culprit scoring: loudest service = hvac (unchanged); culprit = **rooms-svc@2.4.0** (time, call path, release-note
   signature).
4. Deploy freeze; rollback **consumers first** (assistant, then rooms); recovery verified.
5. Impact report: timeline, rooms/guests affected, setpoint commands lost, LLM spend on failed traces, linked
   complaints, root cause table, manifest-drift explanation, data risk, next actions (`runtime/reports/INC-*.md`).
6. L1 remediations (staging parity restored, parity gate on) and a fix task through the factory (L3) → hvac learns
   the new contract → freeze lifts. **Retry r2** now ships cleanly.

### S3 Cost review — measure, prove, ship like code
Ledger = 30 days of seeded history (modeled production volumes) + live gateway usage.

1. Advisor (SQL over SQLite + BM25 over `knowledge/` + past decisions) finds:
   - **F1** prompt cache never hits on `assistant.intent` (timestamp in the system prompt) → sent to the factory as a
     code fix (L2). After it ships, the live cache hit rate jumps.
   - **F2** intent classification on the large tier → shadow eval.
   - **F3** CI golden evals not batched → L1 config change, applied.
   - **F4** idle seats + two overlapping AI review tools → recommendation.
2. Shadow eval on golden + replayed production prompts: `medium@low` passes; `small` fails the **Thai slice**
   (matches the 2026-03 decision memo the advisor retrieved).
3. Iso-quality swap proposal (`runtime/reports/COST-*.md`) → approve (L3) → gateway canary 25 → 50 → 100 % with
   online-accuracy watch → promoted; decision memo goes back into the knowledge base.
4. **Force bad canary** pushes `small` through the canary and shows the auto-revert.

### S4 Bill & budgets — the bill is the truth
The ledger only sees calls that go through the gateway. The provider bill sees everything.

1. Daily reconciliation calls the provider admin endpoints (modeled on Anthropic's Usage & Cost Admin API):
   `GET /v1/organizations/cost_report` (billed USD per day) and `GET /v1/organizations/usage_report/messages`
   grouped by `api_key_id` (which key spent it), plus the API key list.
2. Gateway key vs ledger: matches to the cent on every complete day (metering is accurate).
3. Gap of ~8–9 % on the last 9 days → all on `apikey_ds_review_notebook` (Default workspace, created by a data
   analyst) ≈ $670/month with no tags, no PII redaction, no budget. Report: `runtime/reports/RECON-*.md`.
4. That spend is attributed to **team-data** (adjustments) → its $200 budget is already used.
5. L2 action: deactivate the key through the admin API → the notebook gets 401 and is re-pointed to the gateway
   (route `data.review-summaries`, batch pricing) → the gateway now **blocks it with 429 `budget_exceeded`**
   (policy `block`). Owner can approve a budget raise (L3) in the UI.
6. Budgets per team (`config/budgets.json`): warn at 80 % or when the month-end projection exceeds the budget;
   on 100 %: guest-facing = alert only (never block guests), platform = degrade effort, finops/data = block.
7. Infra: a cloud billing export (Langfuse, ledger DB, vector index, GPU, CI) is imported; run-rate =
   API + seats + infra. Advisor F6: the embeddings GPU averages 6 % utilization.

## What is real vs simulated

Real: processes, HTTP, trace propagation, per-site hot-loaded versions, metrics and canary statistics, culprit
scoring, rollback ordering, git worktrees/commits/merges, `node --test` runs, golden-set evals, SQLite ledger and SQL,
BM25 retrieval, bootstrap confidence intervals, prompt-cache semantics and token pricing, reports.

Simulated (labeled in the UI): LLM outputs and quality (`platform/llm/sim-llm.mjs`; the small tier is weaker in
Thai by design), build-agent patches (`platform/llm/patch-library.mjs`), LINE/Slack (local webhooks, no outbound),
online-eval judge (loadgen ground-truth labels), seeded cost history, seat prices, the provider bill and admin API
(endpoint paths, params, daily buckets, cents-as-decimal-strings and pagination follow the public docs; response
field names are modeled), the data-team notebook, the cloud billing export and GPU utilization. Demo traffic runs
12× faster than the modeled production; live ledger rows are weighted 1/12 (reconciliation compares raw dollars).

Prices: Anthropic list prices cached 2026-11-03 (`config/pricing.json`) mapped to tiers large/medium/small; cache
write multiplier and Haiku cache-read are marked as assumptions. Verify before using any number for a decision.

## Commands

```bash
npm test                 # Node platform tests + app tests + Go tests (vet, race detector)
npm run smoke            # fresh headless run of S1, S2 (+ retry), S3, forced bad canary, S4 (stop the demo first)
node scripts/inspect.mjs # terminal snapshot of metrics, manifests, work items, cost
node scripts/finops-check.mjs [--run-s4]   # budgets, reconciliation, notebook, infra
node scripts/api.mjs POST /api/scenarios/s1/run
node scripts/screenshot.mjs ../images overview factory fleet incidents cost   # needs Google Chrome
npm run test:go          # Go only: go vet + go test -race ./...
npm run parity:go        # regenerate Node reference vectors (markdown, stats, RNG) and re-check the Go ports
npm run bench:gateway    # gateway overhead, Node vs Go, against instant stubs (stop the demo first)
npm run test:adapter     # claude-adapter tests (fake Messages API, dummy key; needs the Go SDK module once)
GATEWAY_IMPL=node npm start   # Node LLM gateway instead of the Go one (benchmark baseline)
```

### Go services

Four processes run in Go (`go/`, standard library only): **release-controller**, **finops**, **llm-gateway** and
**loadgen**. The rule: a component moves to Go when Go's strengths matter for it in production (hot path,
long-running controller, high-volume ingest, traffic generation) and it doesn't load JavaScript at runtime.

Stays in Node, on purpose:
- **Service host and HotelGrid services.** Each site hot-loads a JavaScript version module in one process; that is how
  agents ship fixes without restarts. Go can't hot-swap code in-process.
- **Factory pipeline.** The agent layer; Claude's Agent SDK is TypeScript/Python.
- **Cost advisor, RAG and evals.** Python would be the production home.
- **Ledger.** SQLite: the advisor runs SQL on it, and the Go services use `/internal/ledger/*`.
- **Simulators.** Stand-ins for external APIs.

Contracts the Go services keep:
- The same JSON shapes as the Node modules they replace; arrays are never `null`, and there is no HTML escaping.
- Log lines and events reach the dashboard through the control plane (`POST /ingest/events` → SSE).
- Parity tests compare the Go ports with reference outputs of the Node helpers (markdown reports, percentile,
  z-test, mulberry32, `hash01`).

`npm run bench:gateway` measured gateway overhead on this machine, against stubs that answer instantly:

| | p50 / p99, 1 client | req/s, 64 clients | p99, 64 clients | RSS idle → after load |
|---|---|---|---|---|
| Node gateway | 0.22 / 1.34 ms | ~8,000 | 21 ms | 149 → 189 MB |
| Go gateway | 0.13 / 0.33 ms | ~19,000 (client-bound) | 7 ms | 35 → 112 MB |

### Real Claude for guest chat (optional, billed)

```bash
ant auth login            # or export ANTHROPIC_API_KEY=...   (the SDK reads it; this demo never does)
LLM_PROVIDER=anthropic npm start
```

- **What goes to Claude:** guest-assistant calls only (`intent` → `claude-opus-5-5`, `reply` → `claude-sonnet-5-5`,
  per the route table; tiers map through `config/pricing.json`). Factory agents, the advisor and shadow-eval arms
  that need scripted output stay on the simulator. Every ledger row records the provider that actually served it.
- **How:** the Go gateway sends those calls to `claude-adapter` (`go/claude-adapter`, official Go SDK
  `github.com/anthropics/anthropic-sdk-go/v2` v2.10.0). It keeps the cached system prompt (`cache_control`), sets
  effort per route, leaves thinking on (always on for current models) and returns only text. The server-side refusal
  fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is on for the Opus and Sonnet tiers; a
  final refusal becomes a safe answer (`intent: other` / "a staff member will follow up").
- **Separate module:** the adapter is its own Go module, so the default build keeps zero dependencies. In
  production, link the SDK into the gateway.
- **Billing:** real calls are billed by Anthropic at standard price. The demo's synchronous "batch" path stays
  simulated, because the real Batches API is asynchronous. Reconciliation against the simulated bill leaves real
  calls out of the ledger side.
- **Verified without credentials:**
  - unit tests against a fake Messages API (`npm run test:adapter`);
  - an end-to-end run through a local fake API with a dummy key, covering request shape, cache field, fallback beta,
    no demo metadata, provider-labelled ledger rows and online accuracy.

  Never run against the real API while building.

## Going real (not done here — needs your credentials or decisions)

| Demo piece | Real tool | How to swap |
|---|---|---|
| sim-llm for guest chat | Claude API | `LLM_PROVIDER=anthropic npm start` — see *Real Claude for guest chat* below |
| patch-library build agent | Claude Code headless | replace `build` in `control-plane/pipeline.mjs` with `claude -p` in the work item's worktree; keep the same gates |
| llm-gateway | LiteLLM / Portkey | keep the tag headers (`x-route`, `x-signal-id`, `x-stage`, `x-site-id`) as metadata |
| ledger + online scores | Langfuse | send gateway rows as generations with the same tags; read scores back for canaries |
| AI review gate | cubic | call it from the Validate stage; map its verdict onto the gate |
| feedback-intake | LINE OA, Slack app | point their webhooks at `/webhooks/line`, `/webhooks/slack`; add signature checks |
| release-controller (deploy rings, canary, rollback) | Argo Rollouts + Argo CD | rings = clusters/sites; canary analysis = AnalysisTemplate on the same metrics; keep culprit scoring + impact report as a Go service next to it |
| release-controller (telemetry store) | OpenTelemetry → Tempo / Datadog / Sentry | spans already carry trace/parent ids; the canary gate would query the metrics backend instead |
| sim provider bill | Anthropic Usage & Cost Admin API | `PROVIDER_ADMIN=anthropic` + your Admin API key in `ANTHROPIC_ADMIN_KEY` — raw-HTTP adapter `AnthropicAdmin()` in `go/internal/finops` (untested; docs recommend the newer Usage and Cost Analytics API for new integrations) |
| cloud billing export | GCP BigQuery billing export / AWS CUR | load the daily export into the `infra` table; join utilization from monitoring |
| budgets | gateway budgets (LiteLLM/Portkey) + provider spend limits | keep the policy split: never block guest-facing routes |

## Layout

```
app/                    product repo seed (copied to runtime/workspace and git-initialised)
  AGENTS.md             rules the agents follow
  services/<svc>/versions/*.mjs   one module per released version
  services/<svc>/test/  unit tests (agents add regression tests here)
  evals/golden/         assistant intent (EN+TH) and hvac golden sets
config/                 topology, sites/rings, pricing, routing, seats, goals/owners/approval levels
knowledge/              advisor RAG corpus (pricing notes, contracts, playbook, past decisions)
go/                     Go module "hotelgrid" (standard library only)
  cmd/release-controller  telemetry + manifests + rings + canary + rollback + impact reports
  cmd/finops              budgets + bill reconciliation + provider key actions
  cmd/llm-gateway         LLM gateway
  cmd/loadgen             guest traffic generator
  internal/               telemetry, release, finops, pricing, markdown, stats, rng, events (→ control plane), httpx, config
  testdata/node-vectors.json   reference outputs of the Node helpers (parity tests)
platform/
  service-host.mjs      generic service process (per-site version hot-load, spans → release controller, /__meta)
  llm/                  sim provider + provider bill/admin API, Node gateway (fallback), simulated agents, patch library, optional adapters
  control-plane/        server, signals, pipeline, workspace, cost, ledger, scenarios, release-client + finops-client (Go services)
  loadgen/              corpus.json (guest messages EN+TH), ds-notebook (rogue direct-to-provider job)
  ui/                   dashboard (vanilla JS, no build)
scripts/                start, smoke, inspect, api, screenshot, build-golden, go-parity-vectors, bench-gateway
test/                   Node platform tests (Go tests live next to the Go code)
```
