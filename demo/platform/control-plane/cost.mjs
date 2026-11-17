// AI cost layer: gateway route table, advisor (SQL + BM25 RAG + LLM summary), shadow eval, iso-quality swap report,
// route canary with online-eval watch and auto-revert, L1 config changes.
import fs from 'node:fs';
import path from 'node:path';
import * as ledger from './ledger.mjs';
import * as signals from './signals.mjs';
import * as rc from './release-client.mjs';
import * as ws from './workspace.mjs';
import { say, emit } from './bus.mjs';
import { fetchJson, sleep, isThai, traceId as newTraceId } from '../lib/util.mjs';
import { bootstrapCI, pairedDiffCI, percentile } from '../lib/stats.mjs';
import { buildIndex } from '../lib/bm25.mjs';
import { pricing, priceCall } from '../lib/pricing.mjs';
import { mdToHtml } from '../lib/markdown.mjs';
import * as fin from './finops-client.mjs';

let cfg, GW;
export let routing;
export const state = { findings: [], advisorMd: null, advisorRunAt: null, shadow: null, report: null, canary: null, decisions: [] };
let reportSeq = 0;

export function init(c) {
  cfg = c;
  GW = `http://127.0.0.1:${cfg.topo.ports['llm-gateway']}`;
  routing = JSON.parse(fs.readFileSync(path.join(cfg.root, 'config/routing.json'), 'utf8'));
  fs.mkdirSync(path.join(cfg.runtime, 'decisions'), { recursive: true });
}
const publish = () => emit('cost', publicState());
export const publicState = () => ({ ...state, routes: routing.routes });

const DAY = 86400000;
const startOfToday = () => new Date(new Date().toISOString().slice(0, 10)).getTime();

// ---------------- dashboard numbers ----------------
export function summary({ liveWindowSec = 300 } = {}) {
  const since30 = startOfToday() - 30 * DAY;
  const daily = ledger.all(`SELECT day, route, SUM(cost_usd*weight) AS cost FROM usage WHERE ts >= ? GROUP BY day, route ORDER BY day`, since30);
  const byTeam = ledger.all(`SELECT team, SUM(cost_usd*weight) AS cost FROM usage WHERE ts >= ? GROUP BY team ORDER BY cost DESC`, since30);
  const byModel = ledger.all(`SELECT model, SUM(cost_usd*weight) AS cost, SUM(calls*weight) AS calls FROM usage WHERE ts >= ? GROUP BY model ORDER BY cost DESC`, since30);
  const byRoute = ledger.all(`SELECT route, SUM(cost_usd*weight) AS cost, SUM(calls*weight) AS calls FROM usage WHERE ts >= ? AND ts < ? GROUP BY route ORDER BY cost DESC`, startOfToday() - 7 * DAY, startOfToday());
  const seats = ledger.all('SELECT * FROM seats');
  const seatMonthly = seats.reduce((a, s) => a + s.seats * s.monthly_price, 0);
  const live = ledger.all(`SELECT route, COUNT(*) AS n, SUM(cost_usd) AS cost, SUM(cache_read) AS cr, SUM(cache_write) AS cw, SUM(input_tokens) AS inp,
      SUM(CASE WHEN eval_label IS NOT NULL THEN 1 ELSE 0 END) AS labeled, SUM(CASE WHEN eval_label IS NOT NULL AND eval_label = output_label THEN 1 ELSE 0 END) AS correct
    FROM usage WHERE source='live' AND ts >= ? GROUP BY route`, Date.now() - liveWindowSec * 1000)
    .map((r) => ({ ...r, cacheHitRate: r.cr + r.cw + r.inp ? r.cr / (r.cr + r.cw + r.inp) : 0, accuracy: r.labeled ? r.correct / r.labeled : null, costPerCall: r.n ? r.cost / r.n : 0 }));
  const outcomes = ledger.all('SELECT * FROM outcomes ORDER BY resolved_ts DESC LIMIT 20');
  // spend found only on the provider bill (reconciliation adjustments)
  const since30Day = new Date(since30).toISOString().slice(0, 10);
  for (const a of ledger.all(`SELECT day, SUM(cost_usd*weight) AS cost FROM adjustments WHERE day >= ? GROUP BY day`, since30Day)) daily.push({ day: a.day, route: 'unrouted (bill only)', cost: a.cost });
  for (const a of ledger.all(`SELECT team, SUM(cost_usd*weight) AS cost FROM adjustments WHERE day >= ? GROUP BY team`, since30Day)) {
    const t = byTeam.find((x) => x.team === a.team);
    if (t) t.cost += a.cost; else byTeam.push({ team: a.team, cost: a.cost });
  }
  byTeam.sort((a, b) => b.cost - a.cost);
  const unrouted7 = ledger.get(`SELECT SUM(cost_usd*weight) AS c FROM adjustments WHERE day >= ? AND day < ?`, new Date(startOfToday() - 7 * DAY).toISOString().slice(0, 10), new Date(startOfToday()).toISOString().slice(0, 10))?.c || 0;
  const infra = ledger.infraSummary();
  const last7 = (byRoute.reduce((a, r) => a + r.cost, 0) + unrouted7) / 7;
  return {
    accel: cfg.topo.accel, api30: byTeam.reduce((a, r) => a + r.cost, 0), seatMonthly, infraMonthly: infra.monthly, unroutedPerDay: unrouted7 / 7,
    monthlyRunRate: last7 * 30 + seatMonthly + infra.monthly, dailyApi: last7,
    daily, byTeam, byModel, byRoute: byRoute.map((r) => ({ ...r, perDay: r.cost / 7 })), seats, live, outcomes,
    routes: routing.routes, pricingSource: pricing.source,
  };
}

// Reprice a route's token totals on another model; cached=true assumes the prompt cache works (writes become reads).
export function repriced(model, t, cached) {
  const p = pricing.models[model];
  const sys = (t.cw || 0) + (t.cr || 0);
  return ((t.inp || 0) * p.inputPerMTok + (t.outp || 0) * p.outputPerMTok + (cached ? sys * p.cacheReadPerMTok : (t.cw || 0) * p.cacheWritePerMTok + (t.cr || 0) * p.cacheReadPerMTok)) / 1e6;
}

// ---------------- advisor ----------------
export async function runAdvisor() {
  const t0 = startOfToday() - 7 * DAY, t1 = startOfToday();
  const routeRows = ledger.all(`SELECT route, model, effort, SUM(calls) AS calls, SUM(cost_usd) AS cost, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
      SUM(cache_read) AS cr, SUM(cache_write) AS cw FROM usage WHERE source='seed' AND ts >= ? AND ts < ? GROUP BY route, model, effort ORDER BY cost DESC`, t0, t1);
  const total7 = routeRows.reduce((a, r) => a + r.cost, 0);
  const idx = buildIndex(path.join(cfg.root, 'knowledge'));
  const idxDecisions = buildIndex(path.join(cfg.runtime, 'decisions'));
  const cite = (q) => [...idx.search(q, 2), ...(idxDecisions.size ? idxDecisions.search(q, 1) : [])].map((d) => `${d.source}#${d.heading}`);
  const snippets = [];
  const findings = [];
  const monthly = (c7) => (c7 / 7) * 30;

  const intent = routeRows.find((r) => r.route === 'assistant.intent');
  const liveIntent = ledger.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT system_hash) AS d, SUM(cache_read) AS cr, SUM(cache_write) AS cw, SUM(input_tokens) AS inp
    FROM usage WHERE source='live' AND route='assistant.intent' AND ts >= ?`, Date.now() - 10 * 60000);
  const hit = liveIntent.n ? liveIntent.cr / ((liveIntent.cr + liveIntent.cw + liveIntent.inp) || 1) : 0;
  if (intent && intent.cw > 0 && hit < 0.2) {
    const p = pricing.models[intent.model];
    const save7 = (intent.cw * (p.cacheWritePerMTok - p.cacheReadPerMTok)) / 1e6 * 0.98;
    const q = 'prompt caching prefix timestamp system prompt cache read';
    findings.push({
      id: 'F1', kind: 'free-win', title: 'Prompt cache never hits on assistant.intent', route: 'assistant.intent',
      evidence: { cacheHitRate: hit, liveCalls: liveIntent.n, distinctSystemHashes: liveIntent.d, cacheWriteTokens7d: intent.cw, share: intent.cost / total7 },
      monthlySavingsUsd: monthly(save7), approvalLevel: 'L2', actionType: 'factory-task',
      action: `Every call writes the ~${Math.round(intent.cw / intent.calls)}-token system prompt to cache (${liveIntent.d} distinct system hashes in ${liveIntent.n} live calls). Make the prefix static; this is a code change, so it goes through the factory.`,
      citations: cite(q),
    });
    snippets.push(...idx.search(q, 2));
  }
  if (intent) {
    const tok = { inp: intent.inp, outp: intent.outp, cw: intent.cw, cr: intent.cr };
    const before = monthly(repriced(intent.model, tok, false) - repriced('medium', tok, false));
    const after = monthly(repriced(intent.model, tok, true) - repriced('medium', tok, true));
    const f1 = findings.some((f) => f.id === 'F1');
    const q = 'small tier intent Thai accuracy decision model swap';
    findings.push({
      id: 'F2', kind: 'tradeoff', title: 'assistant.intent runs on the large tier for a 5-way classification', route: 'assistant.intent',
      evidence: { model: intent.model, effort: intent.effort, cost7d: intent.cost, share: intent.cost / total7, callsPerDay: intent.calls / 7, tokens7d: tok, savingsBeforeF1: before, savingsAfterF1: after },
      monthlySavingsUsd: f1 ? after : before, approvalLevel: 'L3', actionType: 'shadow-eval',
      action: `Shadow-eval medium@low and small against large on the golden set + replayed production prompts, Thai slice separately. A previous small-tier trial failed on Thai.${f1 ? ` Saving counted after F1 to avoid double counting ($${Math.round(before).toLocaleString()}/month if the cache stayed broken).` : ''}`,
      citations: cite(q),
    });
    snippets.push(...idx.search(q, 2));
  }
  const ev = routeRows.find((r) => r.route === 'eval.golden');
  if (ev && !routing.routes['eval.golden'].batch) {
    const q = 'batch discount golden-set runs CI asynchronous';
    findings.push({
      id: 'F3', kind: 'free-win', title: 'CI golden-set evals run synchronously at full price', route: 'eval.golden',
      evidence: { cost7d: ev.cost, callsPerDay: ev.calls / 7 },
      monthlySavingsUsd: monthly(ev.cost * (1 - pricing.batchDiscount)), approvalLevel: 'L1', actionType: 'config-l1',
      action: 'Send eval.golden through the batch path (50% price). Config change only; L1 auto-approve.', citations: cite(q),
    });
    snippets.push(...idx.search(q, 1));
  }
  const seats = ledger.all('SELECT * FROM seats');
  const idle = seats.filter((s) => s.seats > 1 && s.active_30d / s.seats < 0.6);
  const byCat = {};
  seats.forEach((s) => { (byCat[s.category] ||= []).push(s); });
  const overlap = Object.values(byCat).filter((g) => g.length > 1 && g[0].category === 'ai-review').flat().sort((a, b) => a.active_30d / a.seats - b.active_30d / b.seats);
  const seatSave = idle.reduce((a, s) => a + (s.seats - s.active_30d) * s.monthly_price, 0);
  const overlapSave = overlap.length ? overlap[0].seats * overlap[0].monthly_price : 0;
  if (idle.length || overlap.length) {
    const q = 'CodeRabbit cubic overlap Copilot renewal seats cancel';
    findings.push({
      id: 'F4', kind: 'hygiene', title: 'Idle seats and two overlapping AI review tools', route: null,
      evidence: { idle: idle.map((s) => `${s.tool}: ${s.active_30d}/${s.seats} active`), overlap: overlap.map((s) => `${s.tool}: ${s.active_30d}/${s.seats} active`) },
      monthlySavingsUsd: seatSave + overlapSave - (overlap.length && idle.includes(overlap[0]) ? (overlap[0].seats - overlap[0].active_30d) * overlap[0].monthly_price : 0),
      approvalLevel: 'L3', actionType: 'recommendation',
      action: `Right-size ${idle.map((s) => s.tool).join(', ')}; keep ${overlap.at(-1)?.tool || 'one review tool'} and cancel ${overlap[0]?.tool || '-'} (30-day notice). Seat prices are examples.`,
      citations: cite(q),
    });
    snippets.push(...idx.search(q, 1));
  }
  // F5: spend on the provider bill that never went through the gateway (needs a reconciliation run)
  const recon = await fin.recon();
  for (const k of recon?.findings || []) {
    if (k.status !== 'active') continue;
    const q = 'unrouted provider key gateway workspace policy batch nightly job';
    findings.push({
      id: 'F5', kind: 'governance', title: `Provider key "${k.name}" bypasses the gateway`, route: 'data.review-summaries',
      evidence: { apiKeyId: k.apiKeyId, perDay: k.perDay, monthly: k.monthly, team: k.team, firstSeen: k.firstSeen, workspace: k.workspace },
      monthlySavingsUsd: k.monthly * (1 - pricing.batchDiscount), approvalLevel: 'L2', actionType: 'deactivate-key',
      action: `About $${Math.round(k.monthly).toLocaleString()}/month on the bill with no tags, budget or PII redaction (found by ${recon.id}). Deactivate the key and run the nightly job through the gateway on batch pricing; saving shown is the batch discount.`,
      citations: cite(q),
    });
    snippets.push(...idx.search(q, 1));
  }
  // F6: idle infrastructure from the cloud billing export + monitoring
  for (const r of ledger.infraSummary().rows.filter((x) => x.util < 0.1 && x.per_day > 5)) {
    const q = 'GPU idle utilization scale to zero embeddings infrastructure';
    findings.push({
      id: 'F6', kind: 'hygiene', title: `${r.component} averages ${Math.round(r.util * 100)}% utilization`, route: null,
      evidence: { component: r.component, sku: r.sku, perDay: r.per_day, util: r.util, team: r.team },
      monthlySavingsUsd: r.per_day * 30 * 0.8, approvalLevel: 'L3', actionType: 'recommendation',
      action: `${r.sku} costs about $${Math.round(r.per_day * 30)}/month (cloud billing export) at ${Math.round(r.util * 100)}% average utilization (monitoring). Move the embedding job to a scheduled or serverless runner; owner ${r.team}.`,
      citations: cite(q),
    });
    snippets.push(...idx.search(q, 1));
  }
  // cost per outcome
  const outc = ledger.get(`SELECT COUNT(*) AS n, AVG(llm_cost) AS avg FROM outcomes`);

  const ctx = { findings: findings.map(({ evidence, ...f }) => f), snippets: snippets.map((s) => ({ source: s.source, heading: s.heading, text: s.text.slice(0, 400) })) };
  const r = await fetchJson(`${GW}/v1/messages`, {
    method: 'POST', timeoutMs: 30000,
    headers: { 'x-route': 'cost.advisor', 'x-site-id': 'factory', 'x-caller': 'cost-advisor', 'x-trace-id': newTraceId() },
    body: { system: [{ type: 'text', text: 'You are the AI cost advisor. Summarize findings with savings and cite knowledge sources. Return JSON {markdown}.' }],
      messages: [{ role: 'user', content: `<context>${JSON.stringify(ctx)}</context>` }], max_tokens: 1500, metadata: { task: 'advisor' } },
  });
  state.advisorMd = r.status === 200 ? JSON.parse(r.body.content[0].text).markdown : null;
  state.advisorCost = r.body?._gateway?.costUsd || 0;
  state.findings = findings;
  state.advisorRunAt = Date.now();
  state.costPerOutcome = outc;
  state.routeTable = routeRows.map((r2) => ({ ...r2, share: r2.cost / total7, perDay: r2.cost / 7 }));
  say('cost', `Advisor: ${findings.length} findings, est. $${Math.round(findings.reduce((a, f) => a + f.monthlySavingsUsd, 0)).toLocaleString()}/month (SQL over ${routeRows.length} route groups, ${snippets.length} knowledge snippets)`);
  publish();
  return state;
}

// ---------------- F1: cache fix -> factory ----------------
export function createCacheFixTask() {
  const f = state.findings.find((x) => x.id === 'F1');
  const ev = f?.evidence || {};
  const cl = signals.addTask({
    origin: 'cost', symptom: 'ai-cost',
    text: `Cost advisor F1: prompt cache hit rate ${((ev.cacheHitRate || 0) * 100).toFixed(1)}% on assistant.intent; ${ev.distinctSystemHashes || '?'} distinct system prompt hashes in ${ev.liveCalls || '?'} calls`,
    evidence: { cacheHitRate: ev.cacheHitRate ?? 0, distinctSystemHashes: ev.distinctSystemHashes },
  });
  say('cost', `F1 sent to the factory as ${cl.id} (code change, L2)`);
  return cl;
}

// ---------------- F3: batch evals (L1 config) ----------------
export function applyBatch() {
  routing.routes['eval.golden'].batch = true;
  const d = { id: `DEC-${state.decisions.length + 1}`, ts: Date.now(), title: 'eval.golden moved to batch pricing', status: 'applied (L1 auto)', finding: 'F3' };
  state.decisions.unshift(d);
  writeDecision(d, 'CI golden-set evaluations now use the batch path at 50% of standard price. No quality impact; latency of CI evals rises.');
  say('cost', `L1 config change applied: eval.golden → batch (50% price)`);
  publish();
  return d;
}

function writeDecision(d, body) {
  fs.writeFileSync(path.join(cfg.runtime, 'decisions', `${d.id}.md`), `# Decision ${new Date(d.ts).toISOString().slice(0, 10)}: ${d.title} — ${d.status}\n\n${body}\n`);
  ledger.run('INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?)', d.id, d.ts, d.title, d.status, body);
}

// ---------------- F2: shadow eval ----------------
async function loadProdAssistant() {
  const ver = (await rc.state()).manifests['bkk-pilot']['guest-assistant'];
  return { ver, mod: await ws.loadModule(cfg.workspace, 'guest-assistant', ver) };
}

export async function runShadow({ route = 'assistant.intent', candidates = [{ model: 'medium', effort: 'low' }, { model: 'small', effort: 'high' }], replayN = 160 } = {}) {
  const base = { model: routing.routes[route].model, effort: routing.routes[route].effort };
  const { ver, mod } = await loadProdAssistant();
  const golden = fs.readFileSync(path.join(cfg.workspace, 'evals/golden/assistant-intent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .map((c) => ({ id: c.id, text: c.text, label: c.expect.intent, lang: c.lang, src: 'golden' }));
  const seen = new Set(golden.map((g) => g.text));
  const replay = ledger.all(`SELECT prompt_text AS text, eval_label AS label FROM usage WHERE source='live' AND route=? AND prompt_text IS NOT NULL AND eval_label IS NOT NULL ORDER BY ts DESC LIMIT 2000`, route)
    .filter((r) => !seen.has(r.text) && seen.add(r.text)).slice(0, replayN)
    .map((r, i) => ({ id: `rp-${i + 1}`, text: r.text, label: r.label, lang: isThai(r.text) ? 'th' : 'en', src: 'replay' }));
  const cases = [...golden, ...replay];
  const arms = [{ name: `${base.model}@${base.effort} (baseline)`, ...base, baseline: true }, ...candidates.map((c) => ({ name: `${c.model}@${c.effort}`, ...c }))];
  state.shadow = { status: 'running', startedAt: Date.now(), route, assistantVersion: ver, cases: { golden: golden.length, replay: replay.length, thai: cases.filter((c) => c.lang === 'th').length }, arms: [] };
  say('cost', `Shadow eval on ${route}: ${cases.length} cases (${golden.length} golden + ${replay.length} replayed prod prompts, ${state.shadow.cases.thai} Thai) × ${arms.length} arms via batch path`);
  publish();
  const traceId = newTraceId();
  for (const arm of arms) {
    const res = [];
    for (let i = 0; i < cases.length; i += 12) {
      await Promise.all(cases.slice(i, i + 12).map(async (c) => {
        const t = Date.now();
        const r = await fetchJson(`${GW}/v1/messages`, {
          method: 'POST', body: mod.buildIntentRequest(c.text), timeoutMs: 20000,
          headers: { 'x-route': 'cost.shadow', 'x-force-model': arm.model, 'x-force-effort': arm.effort, 'x-batch': 'true', 'x-site-id': 'factory', 'x-caller': 'shadow-eval', 'x-eval-label': c.label, 'x-trace-id': traceId },
        });
        let got = 'error'; try { got = JSON.parse(r.body.content[0].text).intent; } catch {}
        res.push({ id: c.id, lang: c.lang, ok: got === c.label ? 1 : 0, ms: r.body?._sim?.latencyMs ?? Date.now() - t, cost: (r.body?._gateway?.costUsd || 0) / pricing.batchDiscount });
      }));
    }
    res.sort((a, b) => a.id.localeCompare(b.id));
    arm.results = res;
  }
  const baseRes = arms[0].results;
  const key = (r) => r.id;
  for (const arm of arms) {
    const rs = arm.results;
    const th = rs.filter((r) => r.lang === 'th'), en = rs.filter((r) => r.lang === 'en');
    const align = (subset) => { const ids = new Set(subset.map(key)); return [baseRes.filter((r) => ids.has(r.id)).map((r) => r.ok), subset.map((r) => r.ok)]; };
    const [bAll, cAll] = align(rs), [bTh, cTh] = align(th);
    state.shadow.arms.push({
      name: arm.name, model: arm.model, effort: arm.effort, baseline: !!arm.baseline,
      overall: bootstrapCI(rs.map((r) => r.ok)), thai: bootstrapCI(th.map((r) => r.ok)), english: bootstrapCI(en.map((r) => r.ok)),
      diffOverall: arm.baseline ? null : pairedDiffCI(bAll, cAll), diffThai: arm.baseline ? null : pairedDiffCI(bTh, cTh),
      p95ms: percentile(rs.map((r) => r.ms), 95), costPerCall: rs.reduce((a, r) => a + r.cost, 0) / rs.length, n: rs.length,
    });
  }
  const b = state.shadow.arms[0];
  for (const a of state.shadow.arms.slice(1)) {
    a.pass = a.diffOverall.mean >= -0.02 && a.diffThai.mean >= -0.02 && a.diffThai.lo >= -0.05;
    a.savingsPct = 1 - a.costPerCall / b.costPerCall;
    a.why = a.pass ? 'within 2-point margin overall and on Thai slice' :
      `${a.diffThai.mean < -0.02 ? `Thai slice ${(a.diffThai.mean * 100).toFixed(1)} pts` : ''}${a.diffOverall.mean < -0.02 ? ` overall ${(a.diffOverall.mean * 100).toFixed(1)} pts` : ''} below baseline`;
  }
  state.shadow.status = 'done';
  state.shadow.finishedAt = Date.now();
  state.shadow.evalCost = ledger.get(`SELECT SUM(cost_usd) AS c FROM usage WHERE route='cost.shadow' AND trace_id = ?`, traceId)?.c || 0;
  say('cost', `Shadow eval done: ${state.shadow.arms.slice(1).map((a) => `${a.name} ${a.pass ? 'PASS' : 'FAIL'} (${a.why}, ${(a.savingsPct * 100).toFixed(0)}% cheaper/call)`).join('; ')}`);
  buildReport();
  publish();
  return state.shadow;
}

// ---------------- iso-quality swap proposal ----------------
export function buildReport() {
  const sh = state.shadow;
  const f2 = state.findings.find((f) => f.id === 'F2');
  if (!sh || sh.status !== 'done') return null;
  const base = sh.arms[0];
  const winner = sh.arms.slice(1).filter((a) => a.pass).sort((a, b) => b.savingsPct - a.savingsPct)[0];
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const ci = (c) => `${pct(c.mean)} [${pct(c.lo)}, ${pct(c.hi)}]`;
  const dci = (c) => (c ? `${(c.mean * 100).toFixed(1)} [${(c.lo * 100).toFixed(1)}, ${(c.hi * 100).toFixed(1)}]` : '—');
  const monthlyRoute = f2 ? (f2.evidence.cost7d / 7) * 30 : 0;
  const tok = f2?.evidence.tokens7d;
  const m30 = (x) => (x / 7) * 30;
  const cacheFixed = state.findings.some((f) => f.id === 'F1');
  const save = winner && tok ? m30(repriced(base.model, tok, cacheFixed) - repriced(winner.model, tok, cacheFixed)) : 0;
  const saveOther = winner && tok ? m30(repriced(base.model, tok, !cacheFixed) - repriced(winner.model, tok, !cacheFixed)) : 0;
  const id = `COST-${++reportSeq}`;
  const md = `# ${id} — Iso-quality swap proposal: ${sh.route}

**Ask:** ${winner ? `switch \`${sh.route}\` from **${base.name.replace(' (baseline)', '')}** to **${winner.name}**. Est. saving **$${Math.round(save).toLocaleString()}/month** with quality inside the 2-point margin overall and on the Thai slice. Saving is repriced from 7 days of ledger tokens ${cacheFixed ? `**after** the F1 prompt-cache fix (it would be $${Math.round(saveOther).toLocaleString()}/month with the cache still broken)` : 'with the current cache behaviour'}; the shadow eval measured ${pct(winner.savingsPct)} lower cost per call.` : 'no candidate met the quality bar; keep the current model.'}
**Approval:** L3 (service owner team-guest-ai) · ships as a gateway canary 25% → 50% → 100% with online-eval watch and auto-revert.

## Current state
- Route \`${sh.route}\` runs on ${base.name.replace(' (baseline)', '')}; modeled spend ${f2 ? `$${Math.round(monthlyRoute).toLocaleString()}/month (${pct(f2.evidence.share)} of API spend, ${Math.round(f2.evidence.callsPerDay).toLocaleString()} calls/day)` : 'n/a'}.
- Production request builder: guest-assistant@${sh.assistantVersion}.

## Method
- ${sh.cases.golden} golden cases + ${sh.cases.replay} replayed production prompts (PII-redacted at the gateway); ${sh.cases.thai} Thai.
- Same prompts for every arm; labels from the golden set and from production eval labels.
- Paired bootstrap 95% CI on the accuracy difference vs baseline (2,000 resamples).
- Run on the batch path; eval spend $${(sh.evalCost || 0).toFixed(3)} (demo).
- Decision rule (finops-playbook): Δ overall ≥ -2 pts AND Δ Thai ≥ -2 pts AND Thai CI lower bound ≥ -5 pts.

## Results
| Arm | Overall acc [95% CI] | Thai acc [95% CI] | Δ overall pts | Δ Thai pts | p95 latency | Cost/call | Verdict |
|---|---|---|---|---|---|---|---|
${sh.arms.map((a) => `| ${a.name} | ${ci(a.overall)} | ${ci(a.thai)} | ${dci(a.diffOverall)} | ${dci(a.diffThai)} | ${Math.round(a.p95ms)} ms | $${a.costPerCall.toFixed(5)} | ${a.baseline ? 'baseline' : a.pass ? '**PASS**' : `FAIL — ${a.why}`} |`).join('\n')}

Quality numbers come from the demo's model simulator, not from the real referenced models.

## Total cost of ownership
- Migration effort: route-table change only (no code); ~1 engineer-hour for review and monitoring.
- Payback: immediate.
- Lock-in / exit: same provider; revert is one route-table change.
- Data residency (PDPA): unchanged — same provider and region; prompts already redacted at the gateway.

## Risks
- Thai regressions hide inside aggregate accuracy — this is why the Thai slice has its own bar (see 2026-03 small-tier trial).
- Live traffic mix can drift from the golden set — the canary watches online accuracy per language.

## Rollout and rollback
1. Gateway canary 25% for ≥30 labeled calls, then 50%, then 100%.
2. Auto-revert if canary online accuracy falls > 4 pts below control (or Thai > 8 pts).
3. Decision memo filed to the advisor's knowledge base either way.

## Decision needed
Owner: team-guest-ai · Reviewer: team-finops · Approve in the AI Cost tab.
`;
  state.report = { id, route: sh.route, candidate: winner ? { model: winner.model, effort: winner.effort, name: winner.name } : null, monthlySavingsUsd: save, markdown: md, html: mdToHtml(md), createdAt: Date.now() };
  fs.mkdirSync(path.join(cfg.runtime, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(cfg.runtime, 'reports', `${id}.md`), md);
  say('cost', `${id} written: runtime/reports/${id}.md`);
  return state.report;
}

// ---------------- route canary ----------------
function onlineAcc(route, arm, since) {
  const rows = ledger.all(`SELECT eval_label, output_label, prompt_text FROM usage WHERE source='live' AND route=? AND arm=? AND ts >= ? AND eval_label IS NOT NULL`, route, arm, since);
  const th = rows.filter((r) => isThai(r.prompt_text));
  const acc = (xs) => (xs.length ? xs.filter((r) => r.eval_label === r.output_label).length / xs.length : null);
  return { n: rows.length, acc: acc(rows), thN: th.length, thAcc: acc(th) };
}

export async function startCanary({ route = 'assistant.intent', model, effort, approvedBy = 'owner', label }) {
  if (state.canary?.status === 'running') throw new Error('a route canary is already running');
  const rt = routing.routes[route];
  const c = { route, from: { model: rt.model, effort: rt.effort }, to: { model, effort }, steps: [], status: 'running', startedAt: Date.now(), approvedBy, label };
  state.canary = c;
  say('cost', `Route canary ${route}: ${rt.model}@${rt.effort} → ${model}@${effort} approved by ${approvedBy}`);
  publish();
  for (const weight of [25, 50, 100]) {
    const since = Date.now();
    rt.canary = { model, effort, weight };
    const st = { weight, startedAt: since, status: 'watching' };
    c.steps.push(st);
    publish();
    let verdict = null;
    for (let i = 0; i < 45 && !verdict; i++) {
      await sleep(2000);
      const can = onlineAcc(route, 'canary', since), ctl = onlineAcc(route, 'control', since);
      st.canary = can; st.control = ctl;
      if (can.n >= 30 && (weight === 100 || ctl.n >= 20)) {
        const ref = weight === 100 ? c.steps[c.steps.length - 2]?.control || ctl : ctl;
        const drop = (ref.acc ?? can.acc) - can.acc;
        const thDrop = can.thN >= 12 && ref.thAcc != null ? ref.thAcc - can.thAcc : 0;
        verdict = drop > 0.04 || thDrop > 0.08 ? 'revert' : 'promote';
        st.drop = drop; st.thDrop = thDrop;
      }
      publish();
    }
    if (!verdict) verdict = 'promote';
    st.status = verdict;
    if (verdict === 'revert') {
      delete rt.canary;
      c.status = 'reverted';
      say('cost', `Route canary REVERTED at ${weight}%: online accuracy ${(st.canary.acc * 100).toFixed(1)}% vs control ${(((weight === 100 ? c.steps.at(-2)?.control : st.control)?.acc || 0) * 100).toFixed(1)}%${st.thDrop > 0.08 ? `, Thai drop ${(st.thDrop * 100).toFixed(1)} pts` : ''}`, { level: 'warn' });
      const d = { id: `DEC-${state.decisions.length + 1}`, ts: Date.now(), title: `${route} → ${model}@${effort} reverted by canary`, status: 'reverted' };
      state.decisions.unshift(d);
      writeDecision(d, `Online accuracy dropped during the ${weight}% canary step. Overall drop ${(st.drop * 100).toFixed(1)} pts, Thai drop ${(st.thDrop * 100).toFixed(1)} pts. Route restored to ${c.from.model}@${c.from.effort}.`);
      publish();
      return c;
    }
    say('cost', `Route canary ${weight}% healthy (canary acc ${st.canary?.acc != null ? (st.canary.acc * 100).toFixed(1) : '?'}%, n=${st.canary?.n})`);
  }
  rt.model = model; rt.effort = effort; delete rt.canary;
  c.status = 'promoted';
  c.finishedAt = Date.now();
  const d = { id: `DEC-${state.decisions.length + 1}`, ts: Date.now(), title: `${route} → ${model}@${effort}`, status: 'promoted' };
  state.decisions.unshift(d);
  writeDecision(d, `Promoted after shadow eval ${state.report?.id || ''} and a 25/50/100 canary. Estimated saving $${Math.round(state.report?.monthlySavingsUsd || 0)}/month.`);
  say('cost', `Route ${route} now ${model}@${effort} for 100% of traffic`);
  publish();
  return c;
}
