// SIMULATED provider-side billing: the source of truth the ledger is reconciled against.
// Records every call the provider serves (by API key), and serves admin endpoints modeled on Anthropic's
// Usage & Cost Admin API (legacy endpoints: /v1/organizations/usage_report/messages, /v1/organizations/cost_report).
// Endpoint paths, query params, bucket rules, pagination (has_more/next_page) and "amount in cents as a decimal
// string" follow the public docs; individual response field names are modeled and not verified.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pricing } from '../lib/pricing.mjs';
import { gatewayHistory, notebookHistory, dayOf } from '../lib/seed-history.mjs';

export const REPORT_LAG_MS = 10_000; // production: usage typically appears within ~5 minutes
const MODEL_ID = Object.fromEntries(Object.entries(pricing.models).map(([tier, p]) => [tier, p.refModel]));
const DISPLAY = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5' };

let db, ins;

export async function init({ dbPath, root }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS billing (ts INTEGER, day TEXT, api_key_id TEXT, workspace_id TEXT, model TEXT, service_tier TEXT, calls INTEGER,
      uncached_input INTEGER, cache_write_5m INTEGER, cache_read INTEGER, output INTEGER, cost_usd REAL);
    CREATE INDEX IF NOT EXISTS billing_ts ON billing(ts);
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT, status TEXT, created_at TEXT, created_by TEXT, admin INTEGER);
  `);
  ins = db.prepare('INSERT INTO billing VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  if (!db.prepare('SELECT COUNT(*) n FROM api_keys').get().n) {
    const k = db.prepare('INSERT INTO api_keys VALUES (?,?,?,?,?,?,?)');
    const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
    k.run('apikey_gateway_prod', 'llm-gateway-prod', 'wrkspc_prod', 'active', daysAgo(240), 'user:platform-admin', 0);
    k.run('apikey_ds_review_notebook', 'review-summaries-notebook', null, 'active', daysAgo(10), 'user:data-team-analyst', 0);
    k.run('apikey_admin_finops', 'finops-admin (read reports)', null, 'active', daysAgo(240), 'user:finops-lead', 1);
  }
  if (!db.prepare('SELECT COUNT(*) n FROM billing').get().n) {
    const rows = [...(await gatewayHistory(root)), ...notebookHistory()];
    db.exec('BEGIN');
    for (const r of rows) {
      ins.run(r.ts, r.day, r.apiKeyId, r.apiKeyId === 'apikey_gateway_prod' ? 'wrkspc_prod' : null, MODEL_ID[r.model], r.batch ? 'batch' : 'standard', r.calls,
        r.usage.input_tokens, r.usage.cache_creation_input_tokens, r.usage.cache_read_input_tokens, r.usage.output_tokens, r.costUsd);
    }
    db.exec('COMMIT');
  }
}

export function authorize(keyId, { admin = false } = {}) {
  const k = keyId && db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
  if (!k || k.status !== 'active') return { ok: false, status: 401, body: { type: 'error', error: { type: 'authentication_error', message: k ? `API key ${keyId} is ${k.status}` : 'invalid x-api-key' } } };
  if (admin && !k.admin) return { ok: false, status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'Admin API key required' } } };
  return { ok: true, key: k };
}

export function record({ keyId, tier, serviceTier, usage, costUsd }) {
  const k = db.prepare('SELECT workspace_id FROM api_keys WHERE id = ?').get(keyId);
  ins.run(Date.now(), dayOf(Date.now()), keyId, k?.workspace_id ?? null, MODEL_ID[tier], serviceTier, 1,
    usage.input_tokens, usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0, usage.output_tokens, costUsd);
}

// ---------------- admin endpoints ----------------
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const WIDTH = { '1d': 86400000, '1h': 3600000, '1m': 60000 };
const LIMITS = { '1d': [7, 31], '1h': [24, 168], '1m': [60, 1440] };

function buckets(sp, width) {
  const start = Date.parse(sp.get('starting_at'));
  if (!Number.isFinite(start)) throw Object.assign(new Error('starting_at is required (RFC 3339)'), { status: 400 });
  const end = sp.get('ending_at') ? Date.parse(sp.get('ending_at')) : Date.now();
  const [def, max] = LIMITS[width];
  const limit = Math.min(Number(sp.get('limit')) || def, max);
  const first = Number(sp.get('page') ? Buffer.from(sp.get('page').replace(/^page_/, ''), 'base64url').toString() : 0);
  const all = [];
  for (let t = Math.floor(start / WIDTH[width]) * WIDTH[width]; t < end; t += WIDTH[width]) all.push(t);
  const slice = all.slice(first, first + limit);
  const more = first + limit < all.length;
  return { slice, has_more: more, next_page: more ? `page_${Buffer.from(String(first + limit)).toString('base64url')}` : null, width: WIDTH[width] };
}

const cutoff = () => Date.now() - REPORT_LAG_MS;

export function usageReport(sp) {
  const width = sp.get('bucket_width') || '1d';
  if (!WIDTH[width]) throw Object.assign(new Error('bucket_width must be 1m, 1h or 1d'), { status: 400 });
  const groups = sp.getAll('group_by[]').filter((g) => ['api_key_id', 'workspace_id', 'model', 'service_tier'].includes(g));
  const keys = sp.getAll('api_key_ids[]'), models = sp.getAll('models[]');
  const b = buckets(sp, width);
  const data = b.slice.map((t0) => {
    const where = ['ts >= ?', 'ts < ?', 'ts <= ?'];
    const params = [t0, t0 + b.width, cutoff()];
    if (keys.length) { where.push(`api_key_id IN (${keys.map(() => '?').join(',')})`); params.push(...keys); }
    if (models.length) { where.push(`model IN (${models.map(() => '?').join(',')})`); params.push(...models); }
    const sel = groups.length ? `${groups.join(', ')}, ` : '';
    const rows = db.prepare(`SELECT ${sel}SUM(uncached_input) ui, SUM(cache_write_5m) cw, SUM(cache_read) cr, SUM(output) o FROM billing WHERE ${where.join(' AND ')} ${groups.length ? `GROUP BY ${groups.join(', ')}` : ''}`).all(...params);
    return {
      starting_at: iso(t0), ending_at: iso(t0 + b.width),
      results: rows.filter((r) => r.ui != null).map((r) => ({
        uncached_input_tokens: r.ui, cache_creation: { ephemeral_5m_input_tokens: r.cw, ephemeral_1h_input_tokens: 0 },
        cache_read_input_tokens: r.cr, output_tokens: r.o, server_tool_use: { web_search_requests: 0 },
        api_key_id: groups.includes('api_key_id') ? r.api_key_id : null, workspace_id: groups.includes('workspace_id') ? r.workspace_id : null,
        model: groups.includes('model') ? r.model : null, service_tier: groups.includes('service_tier') ? r.service_tier : null, context_window: null,
      })),
    };
  });
  return { data, has_more: b.has_more, next_page: b.next_page };
}

export function costReport(sp) {
  const groups = sp.getAll('group_by[]');
  const byWs = groups.includes('workspace_id'), byDesc = groups.includes('description');
  const b = buckets(sp, '1d');
  const tierOf = Object.fromEntries(Object.entries(MODEL_ID).map(([t, id]) => [id, t]));
  const data = b.slice.map((t0) => {
    const rows = db.prepare(`SELECT workspace_id, model, service_tier, SUM(uncached_input) ui, SUM(cache_write_5m) cw, SUM(cache_read) cr, SUM(output) o
      FROM billing WHERE ts >= ? AND ts < ? AND ts <= ? GROUP BY workspace_id, model, service_tier`).all(t0, t0 + 86400000, cutoff());
    const acc = new Map();
    for (const r of rows) {
      const p = pricing.models[tierOf[r.model]];
      const disc = r.service_tier === 'batch' ? pricing.batchDiscount : 1;
      const parts = [['uncached_input_tokens', 'Input Tokens', r.ui * p.inputPerMTok], ['output_tokens', 'Output Tokens', r.o * p.outputPerMTok],
        ['cache_read_input_tokens', 'Cache Read', r.cr * p.cacheReadPerMTok], ['cache_creation.ephemeral_5m_input_tokens', 'Cache Write (5m)', r.cw * p.cacheWritePerMTok]];
      for (const [tokenType, label, usdMicro] of parts) {
        const cents = (usdMicro / 1e6) * disc * 100;
        if (!cents) continue;
        const key = `${byWs ? r.workspace_id : ''}|${byDesc ? `${r.model}|${r.service_tier}|${tokenType}` : ''}`;
        const cur = acc.get(key) || { cents: 0, workspace_id: byWs ? r.workspace_id : null, ...(byDesc ? { description: `${DISPLAY[r.model] || r.model} Usage - ${label}${r.service_tier === 'batch' ? ' (Batch)' : ''}`, model: r.model, service_tier: r.service_tier, token_type: tokenType } : {}) };
        cur.cents += cents;
        acc.set(key, cur);
      }
    }
    return {
      starting_at: iso(t0), ending_at: iso(t0 + 86400000),
      results: [...acc.values()].map(({ cents, ...rest }) => ({ currency: 'USD', amount: cents.toFixed(6), cost_type: 'tokens', context_window: '0-200k', description: null, model: null, service_tier: null, token_type: null, ...rest })),
    };
  });
  return { data, has_more: b.has_more, next_page: b.next_page };
}

export function listKeys() {
  const data = db.prepare('SELECT * FROM api_keys WHERE admin = 0').all().map((k) => ({
    id: k.id, type: 'api_key', name: k.name, workspace_id: k.workspace_id, status: k.status, created_at: k.created_at,
    created_by: { id: k.created_by, type: 'user' }, partial_key_hint: `sk-sim-...${k.id.slice(-4)}`,
  }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

export function updateKey(id, body) {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!k) throw Object.assign(new Error('not found'), { status: 404 });
  if (body.status && ['active', 'inactive'].includes(body.status)) db.prepare('UPDATE api_keys SET status = ? WHERE id = ?').run(body.status, id);
  if (body.name) db.prepare('UPDATE api_keys SET name = ? WHERE id = ?').run(body.name, id);
  return listKeys().data.find((x) => x.id === id);
}
