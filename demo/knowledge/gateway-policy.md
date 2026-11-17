# LLM access policy (team-platform, 2026-06)

## One door to the models
All production and analytics LLM traffic goes through the LLM gateway (workspace `wrkspc_prod`). The gateway adds
per-call tags (team, route, site, signal, trace), redacts PII, enforces team budgets and feeds the cost ledger,
evals and canaries. Provider API keys outside the gateway workspace are not allowed for recurring jobs.

## Exceptions
Short experiments may use a personal key in the Default workspace for up to 7 days with finops informed.
Recurring or scheduled jobs (nightly notebooks, backfills) must move to the gateway before their second run.

## Nightly and batch jobs
Nightly jobs (review summaries, backfills, re-scoring) use the gateway batch path at 50% of standard price.
Budget policy for analytics teams is "block" — jobs pause when the monthly budget is used.

## Unrouted spend
The daily reconciliation compares the provider cost report with the ledger. Any spend on keys other than the
gateway key is attributed to the key owner's team and counts against its budget. Action: deactivate the key through
the admin API after the owner is told; the job must be re-pointed to the gateway.

# Infrastructure (AI platform)

## GPU nodes
GPU nodes for embeddings run as scheduled jobs or on a serverless runner, not always-on. Target average utilization
above 40%; anything under 10% for a week is a finops finding (scale to zero or schedule).
