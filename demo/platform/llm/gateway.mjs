// LLM gateway (LiteLLM/Portkey-style), Node version. The default is the Go port (go/cmd/llm-gateway); this one is the
// fallback (GATEWAY_IMPL=node) and the only one with the optional real-Claude provider (LLM_PROVIDER=anthropic).
// - route table (model + effort per route) pulled from the control plane; supports canary arms
// - tags: team, route, caller, site, trace, signal, stage
// - prices each call from config/pricing.json (batch discount when x-batch: true)
// - ships usage rows to the control-plane ledger and a span per call
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, createRouter, reply, fetchJson, hash01, sha, spanId as newSpanId } from '../lib/util.mjs';
import { priceCall } from '../lib/pricing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));
const CP = `http://127.0.0.1:${topo.ports['control-plane']}`;
const RC = `http://127.0.0.1:${topo.ports['release-controller']}`; // telemetry (spans)
const PROVIDER = process.env.LLM_PROVIDER || 'sim';

const routingCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/routing.json'), 'utf8'));
let routes = routingCfg.routes;
let budgets = {}; // team -> { status: ok|warn|exceeded, policy, pct }
setInterval(async () => {
  const r = await fetchJson(`${CP}/api/gateway/routes`, { timeoutMs: 2000 });
  if (r.status === 200 && r.body.routes) { routes = r.body.routes; budgets = r.body.budgets || {}; }
}, 1000);

const redact = (s) => String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/(\+?66|0)[\d\s-]{8,11}\d/g, '[phone]');

async function callProvider(payload, { batch }) {
  if (PROVIDER === 'anthropic') {
    const { callAnthropic } = await import('./providers/anthropic.mjs');
    return callAnthropic(payload, { 'x-api-key': routingCfg.providerKey, ...(batch ? { 'x-service-tier': 'batch' } : {}) });
  }
  // the gateway's own provider key: every call it makes is attributable to it on the provider bill
  return fetchJson(`http://127.0.0.1:${topo.ports['sim-llm']}/v1/messages`, {
    method: 'POST', body: payload, timeoutMs: 20000,
    headers: { 'x-api-key': routingCfg.providerKey, ...(batch ? { 'x-service-tier': 'batch' } : {}) },
  });
}

let usageBuf = [], spanBuf = [];
setInterval(async () => {
  if (usageBuf.length) { const b = usageBuf; usageBuf = []; await fetchJson(`${CP}/ingest/usage`, { method: 'POST', body: { rows: b }, timeoutMs: 5000 }); }
  if (spanBuf.length) { const b = spanBuf; spanBuf = []; await fetchJson(`${RC}/ingest/spans`, { method: 'POST', body: { spans: b }, timeoutMs: 5000 }); }
}, 500);

const router = createRouter();
router.post('/v1/messages', async ({ body, headers }) => {
  const routeName = headers['x-route'] || 'unrouted';
  const rt = routes[routeName] || { model: body.model || 'large', effort: 'high', team: headers['x-team'] || 'unknown' };
  const traceId = headers['x-trace-id'] || sha(Math.random()).slice(0, 32);
  let arm = 'control', model = rt.model, effort = rt.effort;
  if (rt.canary && hash01(`${traceId}|${routeName}`) * 100 < rt.canary.weight) { arm = 'canary'; model = rt.canary.model; effort = rt.canary.effort; }
  if (headers['x-force-model']) { model = headers['x-force-model']; effort = headers['x-force-effort'] || effort; arm = 'forced'; }
  const batch = headers['x-batch'] === 'true' || rt.batch === true;
  const team = rt.team || headers['x-team'] || 'unknown';

  // budget enforcement (policy per team; guest-facing routes are never blocked)
  const bud = budgets[team];
  let budgetAction = null;
  if (bud?.status === 'exceeded' && !rt.guestFacing) {
    if (bud.policy === 'block') budgetAction = 'blocked';
    else if (bud.policy === 'degrade' && effort !== 'low') { effort = 'low'; budgetAction = 'degraded'; }
  }
  const started = Date.now();
  if (budgetAction === 'blocked') {
    usageBuf.push({ ts: started, traceId, team, route: routeName, caller: headers['x-caller'] || null, stage: headers['x-stage'] || null,
      signalId: headers['x-signal-id'] || null, site: headers['x-site-id'] || null, provider: PROVIDER, model, effort, arm: 'budget-blocked', batch,
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, latencyMs: 0, status: 429, systemHash: null, evalLabel: null, outputLabel: null, promptText: null });
    return reply(429, { type: 'error', error: { type: 'budget_exceeded', message: `${team} is over its monthly AI budget (${Math.round((bud.pct || 0) * 100)}%). Policy: block. Ask ${bud.owner || 'the budget owner'} to raise it.` } });
  }
  const payload = { ...body, model, output_config: { ...(body.output_config || {}), effort } };
  const r = await callProvider(payload, { batch });
  const latencyMs = Date.now() - started;
  const usage = r.body?.usage || { input_tokens: 0, output_tokens: 0 };
  const cost = r.status === 200 ? priceCall(model, usage, batch) : 0;

  let outputLabel = null;
  if (body.metadata?.task === 'intent') { try { outputLabel = JSON.parse(r.body.content[0].text).intent; } catch { outputLabel = 'unparseable'; } }
  const sysText = (Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : body.system || '');
  const lastUser = body.messages?.[body.messages.length - 1];

  usageBuf.push({
    ts: started, traceId, team, route: routeName, caller: headers['x-caller'] || null,
    stage: headers['x-stage'] || null, signalId: headers['x-signal-id'] || null, site: headers['x-site-id'] || null,
    provider: PROVIDER, model, effort, arm: budgetAction === 'degraded' ? 'budget-degraded' : arm, batch,
    inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
    costUsd: cost, latencyMs, status: r.status,
    systemHash: sha(sysText).slice(0, 12),
    evalLabel: body.metadata?.task === 'intent' ? headers['x-eval-label'] || null : null, outputLabel,
    promptText: rt.capturePrompt && typeof lastUser?.content === 'string' ? redact(lastUser.content.includes('Guest:') ? lastUser.content.split('Guest:').pop().trim() : lastUser.content) : null,
  });
  spanBuf.push({
    traceId, spanId: newSpanId(), parentId: headers['x-parent-span'] || null, service: 'llm-gateway', version: `${model}/${effort}`,
    site: headers['x-site-id'] || 'factory', method: 'POST', path: '/v1/messages', route: routeName,
    status: r.status, ms: latencyMs, error: r.status >= 500 ? (r.body?.error?.message || r.body?.error || 'provider error') : null,
    attrs: { model, effort, arm, costUsd: cost, cacheRead: usage.cache_read_input_tokens || 0 }, ts: started,
  });
  if (r.status !== 200) return reply(r.status, r.body);
  return { ...r.body, _gateway: { route: routeName, arm, model, effort, costUsd: cost, batch, budget: bud ? { status: bud.status, action: budgetAction } : null } };
});
router.get('/health', () => ({ ok: true, provider: PROVIDER, routes: Object.keys(routes).length }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serve(topo.ports['llm-gateway'], router);
  console.log(`[llm-gateway] listening on :${topo.ports['llm-gateway']} provider=${PROVIDER}`);
}
