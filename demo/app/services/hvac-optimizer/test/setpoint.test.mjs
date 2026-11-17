// Unit tests for hvac-optimizer. Run against a specific version:
//   VERSION_FILE=services/hvac-optimizer/versions/1.8.0.mjs node --test services/hvac-optimizer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.env.VERSION_FILE)).href);

function fakeCtx(room, site = { id: 't', peakNow: false }) {
  const writes = [];
  const attrs = {};
  return {
    site, writes, attrsSeen: attrs,
    attrs: (a) => Object.assign(attrs, a),
    call: async (svc, method, p, body) => {
      if (method === 'GET') return { status: 200, body: room };
      writes.push(body);
      return { status: 200, body: { ok: true } };
    },
  };
}

test('clamps requested setpoint into 18-28 C', () => {
  const room = { occupancy: 'occupied' };
  assert.equal(mod.computeSetpoint(room, 12, { peakNow: false }).effective, 18);
  assert.equal(mod.computeSetpoint(room, 31, { peakNow: false }).effective, 28);
});

test('rounds to the nearest half degree', () => {
  assert.equal(mod.computeSetpoint({ occupancy: 'occupied' }, 22.3, { peakNow: false }).effective, 22.5);
});

test('off-peak requests are honored', () => {
  assert.equal(mod.computeSetpoint({ occupancy: 'occupied' }, 21, { peakNow: false }).effective, 21);
});

test('POST /setpoint writes the effective value to rooms-svc', async () => {
  const ctx = fakeCtx({ id: '1204', occupancy: 'occupied', guestId: 'g1' });
  const res = await mod.routes['POST /setpoint'](ctx, { body: { roomId: '1204', requested: 24 } });
  assert.equal(res.status, 200);
  assert.equal(ctx.writes[0].value, 24);
});

test('rejects payloads without a room id', async () => {
  const res = await mod.routes['POST /setpoint'](fakeCtx({}), { body: { requested: 22 } });
  assert.equal(res.status, 400);
});
