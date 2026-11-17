// AI cost ledger on SQLite (node:sqlite). One row per live LLM call (weighted by 1/accel) plus seeded history
// aggregated per hour. Also: seats, infra (cloud billing export), reconciliation adjustments, outcomes, decisions.
// The cost advisor queries this with real SQL; the Go services (finops, release-controller) use the small query
// API at the bottom of this file through the control plane's /internal/ledger/* endpoints.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gatewayHistory, dayOf, startOfTodayUtc } from '../lib/seed-history.mjs';
import { writeCloudExport } from '../lib/cloud-export.mjs';

let db;
let insertStmt;

export async function init({ dbPath, accel, root }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY, ts INTEGER, day TEXT, source TEXT, calls INTEGER, weight REAL,
      trace_id TEXT, team TEXT, route TEXT, caller TEXT, stage TEXT, signal_id TEXT, site TEXT,
      provider TEXT, model TEXT, effort TEXT, arm TEXT, batch INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
      cost_usd REAL, latency_ms INTEGER, status INTEGER, system_hash TEXT,
      eval_label TEXT, output_label TEXT, prompt_text TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_route_ts ON usage(route, ts);
    CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
    CREATE INDEX IF NOT EXISTS usage_team_ts ON usage(team, ts);
    CREATE INDEX IF NOT EXISTS usage_signal ON usage(signal_id);
    CREATE INDEX IF NOT EXISTS usage_trace ON usage(trace_id);
    CREATE TABLE IF NOT EXISTS seats (tool TEXT, category TEXT, team TEXT, seats INTEGER, active_30d INTEGER, monthly_price REAL, price_source TEXT);
    CREATE TABLE IF NOT EXISTS infra (day TEXT, service TEXT, sku TEXT, project TEXT, team TEXT, component TEXT, cost_usd REAL, utilization REAL);
    CREATE TABLE IF NOT EXISTS adjustments (day TEXT, team TEXT, api_key_id TEXT, cost_usd REAL, weight REAL, source TEXT, note TEXT, created_ts INTEGER,
      PRIMARY KEY (day, api_key_id));
    CREATE TABLE IF NOT EXISTS outcomes (outcome_id TEXT PRIMARY KEY, kind TEXT, title TEXT, resolved_ts INTEGER, llm_cost REAL, calls INTEGER);
    CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, ts INTEGER, title TEXT, status TEXT, body TEXT);
  `);
  insertStmt = db.prepare(`INSERT INTO usage (ts, day, source, calls, weight, trace_id, team, route, caller, stage, signal_id, site, provider, model, effort, arm, batch,
    input_tokens, output_tokens, cache_read, cache_write, cost_usd, latency_ms, status, system_hash, eval_label, output_label, prompt_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM usage WHERE source = ?').get('seed').n;
  if (!n) await seed({ root });
  if (!db.prepare('SELECT COUNT(*) AS n FROM infra').get().n) {
    const csv = path.join(path.dirname(dbPath), 'cloud-billing-export.csv');
    writeCloudExport(csv); // simulated: the daily export "lands" here
    importInfra(csv);
  }
  return { accel };
}

export function insertLive(rows, weight) {
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      insertStmt.run(r.ts, dayOf(r.ts), 'live', 1, weight, r.traceId ?? null, r.team ?? null, r.route ?? null, r.caller ?? null, r.stage ?? null,
        r.signalId ?? null, r.site ?? null, r.provider ?? null, r.model ?? null, r.effort ?? null, r.arm ?? null, r.batch ? 1 : 0,
        r.inputTokens | 0, r.outputTokens | 0, r.cacheRead | 0, r.cacheWrite | 0, r.costUsd || 0, r.latencyMs | 0, r.status | 0,
        r.systemHash ?? null, r.evalLabel ?? null, r.outputLabel ?? null, r.promptText ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

// ---------------- seeded history (30 days, modeled production volumes) ----------------
async function seed({ root }) {
  const rows = await gatewayHistory(root);
  db.exec('BEGIN');
  for (const r of rows) {
    insertStmt.run(r.ts, r.day, 'seed', r.calls, 1, null, r.team, r.route, null, null, null, null, 'anthropic', r.model, r.effort, 'control', r.batch,
      r.usage.input_tokens, r.usage.output_tokens, r.usage.cache_read_input_tokens, r.usage.cache_creation_input_tokens,
      r.costUsd, r.model === 'large' ? 900 : 450, 200, r.route === 'assistant.intent' || r.route === 'eval.golden' ? 'volatile' : 'stable', null, null, null);
  }
  const seats = JSON.parse(fs.readFileSync(path.join(root, 'config/seats.json'), 'utf8')).seats;
  db.exec('DELETE FROM seats');
  for (const s of seats) db.prepare('INSERT INTO seats VALUES (?,?,?,?,?,?,?)').run(s.tool, s.category, s.team, s.seats, s.active30d, s.monthlyPrice, s.priceSource);
  db.exec('COMMIT');
}

// ---------------- cloud billing export (CSV, GCP-style columns) ----------------
export function importInfra(file) {
  if (!fs.existsSync(file)) return 0;
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  const idx = (k) => cols.indexOf(k);
  const stmt = db.prepare('INSERT INTO infra VALUES (?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  db.exec('DELETE FROM infra');
  for (const l of lines) {
    const c = l.split(',');
    stmt.run(c[idx('usage_start_date')], c[idx('service_description')], c[idx('sku_description')], c[idx('project_id')], c[idx('label_team')], c[idx('label_component')], Number(c[idx('cost')]), Number(c[idx('monitoring_avg_utilization')] || 0));
  }
  db.exec('COMMIT');
  return lines.length;
}

// ---------------- query API for the Go services (/internal/ledger/*) ----------------
const DAY = 86400000;

// Infra cost from the cloud billing export, last 7 days (advisor F6, run-rate, Bill & budgets tab).
export function infraSummary() {
  const since = dayOf(startOfTodayUtc() - 7 * DAY);
  const rows = all(`SELECT component, service, sku, team, project, SUM(cost_usd)/7.0 per_day, AVG(utilization) util FROM infra WHERE day >= ? GROUP BY component ORDER BY per_day DESC`, since);
  const perDay = rows.reduce((a, r) => a + r.per_day, 0);
  return { rows, perDay, monthly: perDay * 30 };
}

// Month-to-date inputs per team for budgets: weighted usage + reconciled adjustments, and recent gateway actions.
export function budgetInputs({ teams, monthStart, today, now }) {
  const q = (team, from, to) => (get('SELECT SUM(cost_usd*weight) c FROM usage WHERE team = ? AND ts >= ? AND ts < ?', team, from, to)?.c || 0)
    + (get('SELECT SUM(cost_usd*weight) c FROM adjustments WHERE team = ? AND day >= ? AND day < ?', team, dayOf(from), dayOf(to + 1))?.c || 0);
  const out = {};
  for (const team of teams) {
    const recent = all(`SELECT arm, COUNT(*) n FROM usage WHERE team = ? AND ts >= ? AND arm IN ('budget-blocked','budget-degraded') GROUP BY arm`, team, now - 5 * 60000);
    out[team] = {
      throughYesterday: q(team, monthStart, today), today: q(team, today, now + 1),
      unrouted: get('SELECT SUM(cost_usd*weight) c FROM adjustments WHERE team = ? AND day >= ?', team, dayOf(monthStart))?.c || 0,
      blocked5m: recent.find((r) => r.arm === 'budget-blocked')?.n || 0, degraded5m: recent.find((r) => r.arm === 'budget-degraded')?.n || 0,
    };
  }
  return out;
}

// Raw (unweighted) ledger cost per UTC day — what the provider bill is compared against. excludeLiveProvider drops
// live calls served by a provider whose bill is not the one being reconciled (real Claude calls are billed by
// Anthropic, not by the simulated provider).
export function dailyTotals(from, to, { excludeLiveProvider = null } = {}) {
  const rows = excludeLiveProvider
    ? all(`SELECT day, SUM(cost_usd) c, SUM(calls) n FROM usage WHERE ts >= ? AND ts <= ? AND NOT (source = 'live' AND provider = ?) GROUP BY day`, from, to, excludeLiveProvider)
    : all('SELECT day, SUM(cost_usd) c, SUM(calls) n FROM usage WHERE ts >= ? AND ts <= ? GROUP BY day', from, to);
  return Object.fromEntries(rows.map((r) => [r.day, { c: r.c, n: r.n }]));
}

// Reconciliation adjustments: spend found only on the provider bill, attributed to the owning team.
export function upsertAdjustments(rows) {
  const stmt = db.prepare(`INSERT INTO adjustments VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(day, api_key_id) DO UPDATE SET
    cost_usd = excluded.cost_usd, weight = excluded.weight, created_ts = excluded.created_ts`);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r.day, r.team, r.apiKeyId, r.costUsd, r.weight, r.source ?? 'reconciliation', r.note ?? '', r.createdTs ?? Date.now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return rows.length;
}

export const insertDecision = ({ id, ts, title, status, body }) => run('INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?)', id, ts, title, status, body ?? '');

// LLM spend on a set of traces (impact report: what the failed requests cost).
export function traceCost(traceIds) {
  let cost = 0, calls = 0;
  for (let i = 0; i < traceIds.length; i += 500) {
    const ids = traceIds.slice(i, i + 500);
    const r = get(`SELECT SUM(cost_usd) AS cost, COUNT(*) AS calls FROM usage WHERE source='live' AND trace_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    cost += r?.cost || 0; calls += r?.calls || 0;
  }
  return { cost, calls };
}
