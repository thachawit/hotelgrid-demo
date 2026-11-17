// Simulated model provider with an Anthropic-Messages-like API.
// Real: token accounting, prompt-cache semantics (exact prefix match, TTL), latency by tier/effort.
// Simulated: output quality. Tiers have different error rates per language (small tier is weaker in Thai).
// Also simulates the provider's billing + admin API (provider-billing.mjs): every call is authenticated by API key
// and recorded on the "bill", whether or not it came through the HotelGrid gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, createRouter, reply, estimateTokens, hash01, sha, sleep, isThai } from '../lib/util.mjs';
import * as agents from './sim-agents.mjs';
import { INTENTS } from './intent-lexicon.mjs';
import { priceCall } from '../lib/pricing.mjs';

let billing = null; // provider-billing module, loaded when run as a server

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));

export const PROFILES = {
  large: { en: 0.975, th: 0.965, baseMs: 260, msPerTok: 2.6, minCache: 1024 },
  medium: { en: 0.972, th: 0.958, baseMs: 160, msPerTok: 1.6, minCache: 1024 },
  small: { en: 0.955, th: 0.80, baseMs: 70, msPerTok: 0.8, minCache: 2048 },
};
const EFFORT = { low: { q: -0.005, t: 0.7 }, medium: { q: -0.002, t: 0.85 }, high: { q: 0, t: 1 }, xhigh: { q: 0.001, t: 1.3 }, max: { q: 0.001, t: 1.6 } };
const REASONING_TOKENS = { triage: 600, repro: 900, build: 1800, review: 350, advisor: 500, intent: 0, reply: 0 };

const cache = new Map(); // key -> expiresAt
const CACHE_TTL = 5 * 60 * 1000;

export function intentAccuracy(model, effort, lang) {
  const p = PROFILES[model] || PROFILES.large;
  return Math.min(0.999, p[lang] + (EFFORT[effort]?.q || 0));
}

function simulateIntent(text, model, effort) {
  const truth = agents.classify(text);
  const lang = isThai(text) ? 'th' : 'en';
  const u = hash01(`intent|${text.includes('Guest:') ? text.split('Guest:').pop().trim() : text}`); // shared across models: hard cases are hard for everyone
  if (u < intentAccuracy(model, effort, lang)) return truth;
  const wrong = INTENTS.filter((i) => i !== truth.intent);
  return { intent: wrong[Math.floor(hash01(`wrong|${text}|${model}`) * wrong.length)], temperature: null, item: null };
}

const router = createRouter();
router.post('/v1/messages', async ({ body, headers }) => {
  const keyId = headers['x-api-key'];
  if (billing) { const a = billing.authorize(keyId); if (!a.ok) return reply(a.status, a.body); }
  const model = body.model || 'large';
  const effort = body.output_config?.effort || 'high';
  const prof = PROFILES[model];
  if (!prof) return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: `unknown model ${model}` } });
  const task = body.metadata?.task || 'generic';
  const systemBlocks = Array.isArray(body.system) ? body.system : body.system ? [{ type: 'text', text: body.system }] : [];
  const systemText = systemBlocks.map((b) => b.text).join('\n');
  const cacheable = systemBlocks.some((b) => b.cache_control);
  const sysTok = estimateTokens(systemText);
  const msgTok = (body.messages || []).reduce((a, m) => a + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);

  // prompt caching: exact prefix match on (model, system text)
  let cacheRead = 0, cacheWrite = 0;
  if (cacheable && sysTok >= prof.minCache) {
    const key = sha(`${model}|${systemText}`);
    if ((cache.get(key) || 0) > Date.now()) cacheRead = sysTok;
    else cacheWrite = sysTok;
    cache.set(key, Date.now() + CACHE_TTL);
  }

  let text;
  const userText = (() => { const l = body.messages?.[body.messages.length - 1]; return typeof l?.content === 'string' ? l.content : ''; })();
  if (task === 'intent') text = JSON.stringify(simulateIntent(userText, model, effort));
  else if (task === 'reply') text = agents.reply(body.messages);
  else if (task === 'review-summary') text = 'Summary: guests praise staff and breakfast; recurring issues are AC response time and noise on low floors.';
  else if (agents[task]) text = JSON.stringify(agents[task](agents.extractContext(body.messages)));
  else text = 'OK';

  const outTok = estimateTokens(text) + Math.round((REASONING_TOKENS[task] || 0) * (EFFORT[effort]?.t || 1));
  const ms = Math.min(2500, (prof.baseMs + prof.msPerTok * outTok * 0.25) * (EFFORT[effort]?.t || 1) * (0.85 + hash01(userText + Date.now()) * 0.3));
  await sleep(ms);
  const usage = { input_tokens: sysTok + msgTok - cacheRead - cacheWrite, output_tokens: outTok, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  const serviceTier = headers['x-service-tier'] === 'batch' ? 'batch' : 'standard';
  if (billing) billing.record({ keyId, tier: model, serviceTier, usage, costUsd: priceCall(model, usage, serviceTier === 'batch') });
  return {
    id: `msg_sim_${sha(userText + Date.now()).slice(0, 16)}`,
    type: 'message', role: 'assistant', model, stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage,
    _sim: { task, effort, latencyMs: Math.round(ms) },
  };
});
router.get('/health', () => ({ ok: true, provider: 'sim', models: Object.keys(PROFILES) }));

// ---- admin API (modeled on the Usage & Cost Admin API) ----
function admin(fn) {
  return ({ req, headers, params, body }) => {
    const a = billing.authorize(headers['x-api-key'], { admin: true });
    if (!a.ok) return reply(a.status, a.body);
    try { return fn(new URL(req.url, 'http://x').searchParams, params, body); }
    catch (e) { return reply(e.status || 500, { type: 'error', error: { type: e.status === 404 ? 'not_found_error' : 'invalid_request_error', message: e.message } }); }
  };
}
router.get('/v1/organizations/usage_report/messages', admin((sp) => billing.usageReport(sp)));
router.get('/v1/organizations/cost_report', admin((sp) => billing.costReport(sp)));
router.get('/v1/organizations/api_keys', admin(() => billing.listKeys()));
router.post('/v1/organizations/api_keys/:id', admin((sp, params, body) => billing.updateKey(params.id, body)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  billing = await import('./provider-billing.mjs');
  const runtime = process.env.RUNTIME || path.join(ROOT, 'runtime');
  await billing.init({ dbPath: path.join(runtime, 'data/provider-billing.db'), root: ROOT });
  await serve(topo.ports['sim-llm'], router);
  console.log(`[sim-llm] listening on :${topo.ports['sim-llm']}`);
}
