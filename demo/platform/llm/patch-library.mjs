// SIMULATED build-agent knowledge. In real mode a coding agent (Claude Code headless) writes these;
// here each known failure mode maps to the test + patch a competent agent would produce.
// Every entry is checked against the real base source before it is applied.

export const HYPOTHESES = {
  'hvac-peak-guard-inverted': {
    service: 'hvac-optimizer',
    title: 'Peak-tariff guard applied to occupied rooms instead of vacant rooms',
    goal: 'guest-comfort',
    approvalLevel: 'L2',
    severity: 'p2',
    hypothesis: 'computeSetpoint() floors the setpoint at 25 C when `room.occupancy !== "vacant"` during peak hours. ' +
      'The comment and energy contract EC-114 say the floor applies to vacant rooms. Occupied rooms asking for < 25 C get 25 C; ' +
      'vacant rooms are pre-cooled during peak (contract breach).',
    reproPlan: 'Unit test computeSetpoint() for occupied and vacant rooms with site.peakNow = true.',
    testFile: 'regression-peak-guard.test.mjs',
    test: `// Regression test written by the repro agent for {SPEC}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.env.VERSION_FILE)).href);

test('{SPEC}: occupied room during peak keeps the requested setpoint', () => {
  const out = mod.computeSetpoint({ occupancy: 'occupied' }, 22, { peakNow: true });
  assert.equal(out.effective, 22);
});

test('{SPEC}: vacant room during peak is floored to 25 C (energy contract EC-114)', () => {
  const out = mod.computeSetpoint({ occupancy: 'vacant' }, 20, { peakNow: true });
  assert.equal(out.effective, 25);
  assert.equal(out.reason, 'peak-tariff guard');
});
`,
    edits: [
      { find: "if (site.peakNow && room.occupancy !== 'vacant') {", replace: "if (site.peakNow && room.occupancy === 'vacant') {" },
    ],
    change: 'Fix: peak-tariff guard applies to vacant rooms only ({SPEC})',
    golden: [
      { id: 'hv-r01', site: { peakNow: true }, room: { occupancy: 'vacant' }, requested: 20, expect: 25 },
      { id: 'hv-r02', site: { peakNow: true }, room: { occupancy: 'occupied' }, requested: 22, expect: 22 },
    ],
  },

  'hvac-rooms-contract': {
    service: 'hvac-optimizer',
    title: 'hvac-optimizer rejects rooms-svc 2.4 occupancyStatus contract',
    goal: 'reliability',
    approvalLevel: 'L3',
    severity: 'p1',
    hypothesis: 'parseRoom() requires the legacy string field `occupancy`. rooms-svc 2.4.0 replaced it with ' +
      '`occupancyStatus.state`, so every setpoint call throws at sites running rooms 2.4.0. Staging hid this because it ran ' +
      'hvac 1.9.0-rc1, which already reads both shapes (manifest drift).',
    reproPlan: 'Unit test parseRoom() with a rooms-svc 2.4 payload and with a legacy payload.',
    testFile: 'regression-rooms-contract.test.mjs',
    test: `// Contract test written by the repro agent for {SPEC}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.env.VERSION_FILE)).href);

test('{SPEC}: accepts rooms-svc 2.4 occupancyStatus payload', () => {
  const room = mod.parseRoom({ id: '1204', occupancyStatus: { state: 'OCCUPIED', since: '2026-11-14T00:00:00Z' } });
  assert.equal(room.occupancy, 'occupied');
});

test('{SPEC}: still accepts legacy rooms-svc 2.3 payload', () => {
  assert.equal(mod.parseRoom({ id: '1204', occupancy: 'vacant' }).occupancy, 'vacant');
});
`,
    edits: [
      {
        find: "  if (!room || typeof room.occupancy !== 'string') {\n    throw new Error('invalid room payload from rooms-svc: missing field \"occupancy\"');\n  }\n  return { id: room.id, occupancy: room.occupancy.toLowerCase(), guestId: room.guestId };",
        replace: "  // Accept rooms-svc 2.4 contract (occupancyStatus.state) and legacy 2.3 (occupancy).\n  const occ = room?.occupancy ?? room?.occupancyStatus?.state;\n  if (!room || typeof occ !== 'string') {\n    throw new Error('invalid room payload from rooms-svc: missing field \"occupancy\"');\n  }\n  return { id: room.id, occupancy: occ.toLowerCase(), guestId: room.guestId };",
      },
    ],
    change: 'Fix: accept rooms-svc 2.4 occupancyStatus contract ({SPEC})',
    golden: [],
  },

  'assistant-volatile-system-prompt': {
    service: 'guest-assistant',
    title: 'Timestamp in the intent system prompt defeats prompt caching',
    goal: 'ai-unit-cost',
    approvalLevel: 'L2',
    severity: 'p3',
    hypothesis: 'buildIntentRequest() puts `Current time: <ISO timestamp>` inside the cached system block. The prefix changes on ' +
      'every call, so the ~1.5K-token system prompt is re-billed at full input price instead of the cache-read price. ' +
      'Moving the timestamp into the user turn keeps the prefix byte-identical.',
    reproPlan: 'Unit test that two intent requests built at different times share an identical system block.',
    testFile: 'regression-prompt-cache.test.mjs',
    test: `// Regression test written by the repro agent for {SPEC}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.env.VERSION_FILE)).href);

test('{SPEC}: intent system prompt is byte-identical across calls (cacheable prefix)', () => {
  const a = mod.buildIntentRequest('set 22 please', new Date('2026-11-14T08:00:00Z'));
  const b = mod.buildIntentRequest('set 22 please', new Date('2026-11-14T08:00:07Z'));
  assert.equal(a.system[0].text, b.system[0].text);
});

test('{SPEC}: guest text still reaches the model', () => {
  const r = mod.buildIntentRequest('ขอผ้าเช็ดตัวเพิ่มค่ะ', new Date());
  assert.ok(JSON.stringify(r.messages).includes('ขอผ้าเช็ดตัวเพิ่มค่ะ'));
});
`,
    edits: [
      {
        find: 'text: `You are the HotelGrid concierge intent classifier.\\nCurrent time: ${now.toISOString()}\\n\\n${INTENT_INSTRUCTIONS}`,',
        replace: 'text: `You are the HotelGrid concierge intent classifier.\\n\\n${INTENT_INSTRUCTIONS}`,',
      },
      {
        find: "    messages: [{ role: 'user', content: text }],\n    max_tokens: 64,",
        replace: "    messages: [{ role: 'user', content: `Current time: ${now.toISOString()}\\nGuest: ${text}` }],\n    max_tokens: 64,",
      },
    ],
    change: 'Perf: move timestamp out of the cached system prompt ({SPEC})',
    golden: [],
  },
};
