import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.env.VERSION_FILE)).href);
const site = { id: 'test', floors: [12], roomsPerFloor: 4 };

function ctxFor() {
  const state = {};
  mod.init(state, site);
  return { state, site, attrs: () => {} };
}

test('init creates rooms numbered floor + two digits', () => {
  const ctx = ctxFor();
  assert.deepEqual([...ctx.state.rooms.keys()], ['1201', '1202', '1203', '1204']);
});

test('GET /rooms/:id returns 404 for unknown rooms', async () => {
  const res = await mod.routes['GET /rooms/:id'](ctxFor(), { params: { id: '9999' } });
  assert.equal(res.status, 404);
});

test('PUT setpoint stores the value', async () => {
  const ctx = ctxFor();
  const res = await mod.routes['PUT /rooms/:id/setpoint'](ctx, { params: { id: '1201' }, body: { value: 23 } });
  assert.equal(res.status, 200);
  assert.equal(ctx.state.rooms.get('1201').setpoint, 23);
});
