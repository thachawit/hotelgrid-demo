// Tests for the simulated provider bill (admin reports) and the ledger query API the Go finops service uses.
// Budget policy, reconciliation and key actions are tested in Go: go/internal/finops/finops_test.go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as billing from '../platform/llm/provider-billing.mjs';
import * as ledger from '../platform/control-plane/ledger.mjs';
import { gatewayHistory, notebookHistory, startOfTodayUtc, NOTEBOOK, dayOf } from '../platform/lib/seed-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-finops-'));
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/topology.json'), 'utf8'));
await billing.init({ dbPath: path.join(tmp, 'provider.db'), root: ROOT });
const sp = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [].concat(v)) u.append(k, x); return u; };
const DAY = 86400000;
const start = new Date(startOfTodayUtc() - 14 * DAY).toISOString();

test('cost report: daily buckets, amounts in cents, total = gateway + notebook history', async () => {
  const r = billing.costReport(sp({ starting_at: start, limit: 31, 'group_by[]': ['workspace_id', 'description'] }));
  const billed = r.data.reduce((a, b) => a + b.results.reduce((x, y) => x + Number(y.amount) / 100, 0), 0);
  const since = startOfTodayUtc() - 14 * DAY;
  const expected = [...(await gatewayHistory(ROOT)), ...notebookHistory()].filter((x) => x.ts >= since).reduce((a, x) => a + x.costUsd, 0);
  assert.ok(Math.abs(billed - expected) < 0.01, `${billed} vs ${expected}`);
  assert.equal(typeof r.data[0].results[0].amount, 'string');
  assert.ok(r.data[0].results.some((x) => x.description?.includes('Usage - ')));
});

test('usage report groups by api_key_id: notebook key only on its last N days', () => {
  const r = billing.usageReport(sp({ starting_at: start, bucket_width: '1d', limit: 31, 'group_by[]': ['api_key_id', 'model'] }));
  const daysWithNotebook = r.data.filter((b) => b.results.some((x) => x.api_key_id === NOTEBOOK.apiKeyId && x.uncached_input_tokens > 0));
  assert.equal(daysWithNotebook.length, NOTEBOOK.startedDaysAgo);
  assert.ok(r.data.every((b) => b.results.every((x) => 'cache_creation' in x && 'output_tokens' in x)));
});

test('pagination: has_more / next_page walk the buckets', () => {
  const p1 = billing.usageReport(sp({ starting_at: start, bucket_width: '1d' }));
  assert.equal(p1.data.length, 7);
  assert.equal(p1.has_more, true);
  const p2 = billing.usageReport(sp({ starting_at: start, bucket_width: '1d', page: p1.next_page }));
  assert.notEqual(p2.data[0].starting_at, p1.data[0].starting_at);
});

test('deactivating a key makes the provider reject it; admin calls need an admin key', () => {
  assert.equal(billing.authorize(NOTEBOOK.apiKeyId).ok, true);
  assert.equal(billing.authorize(NOTEBOOK.apiKeyId, { admin: true }).status, 403);
  billing.updateKey(NOTEBOOK.apiKeyId, { status: 'inactive' });
  assert.equal(billing.authorize(NOTEBOOK.apiKeyId).status, 401);
  assert.equal(billing.listKeys().data.find((k) => k.id === NOTEBOOK.apiKeyId).status, 'inactive');
});

test('ledger API for the Go finops service: adjustments count toward the owning team', async () => {
  await ledger.init({ dbPath: path.join(tmp, 'ledger.db'), accel: topo.accel, root: ROOT });
  const now = Date.now(), today = startOfTodayUtc();
  const m0 = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  const inputs = () => ledger.budgetInputs({ teams: ['team-data', 'team-guest-ai'], monthStart: m0, today, now })['team-data'];
  const before = inputs();
  const rows = notebookHistory().filter((r) => r.ts >= m0);
  const byDay = {};
  for (const r of rows) byDay[r.day] = (byDay[r.day] || 0) + r.costUsd;
  ledger.upsertAdjustments(Object.entries(byDay).map(([day, costUsd]) => ({ day, team: 'team-data', apiKeyId: NOTEBOOK.apiKeyId, costUsd, weight: 1, source: 'test', note: '' })));
  ledger.upsertAdjustments(Object.entries(byDay).map(([day, costUsd]) => ({ day, team: 'team-data', apiKeyId: NOTEBOOK.apiKeyId, costUsd, weight: 1, source: 'test', note: '' }))); // upsert, not double
  const after = inputs();
  const added = Object.values(byDay).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(after.throughYesterday + after.today - (before.throughYesterday + before.today) - added) < 1e-6);
  assert.ok(Math.abs(after.unrouted - added) < 1e-6);
  const days = ledger.dailyTotals(today - 3 * DAY, now);
  assert.ok(Object.keys(days).length >= 3 && Object.values(days).every((d) => d.c > 0));
  assert.deepEqual(ledger.traceCost([]), { cost: 0, calls: 0 });
  ledger.insertDecision({ id: 'FIN-T', ts: now, title: 't', status: 'applied', body: 'b' });
  assert.equal(ledger.get('SELECT title FROM decisions WHERE id = ?', 'FIN-T').title, 't');
  assert.ok(dayOf(Date.now()).length === 10);
});

test('infra: cloud billing export imported; idle GPU visible', () => {
  const inf = ledger.infraSummary();
  assert.ok(inf.monthly > 0);
  const gpu = inf.rows.find((r) => r.component === 'review-embeddings-gpu');
  assert.ok(gpu && gpu.util < 0.1);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
