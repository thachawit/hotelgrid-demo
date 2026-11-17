import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.env.VERSION_FILE)).href);

test('intent request asks for JSON only and marks the system prompt cacheable', () => {
  const req = mod.buildIntentRequest('set 22 please');
  assert.equal(req.system[0].cache_control.type, 'ephemeral');
  assert.match(req.system[0].text, /compact JSON/);
});

test('intent request carries the guest text', () => {
  const req = mod.buildIntentRequest('ขอผ้าเช็ดตัวเพิ่มค่ะ');
  assert.ok(JSON.stringify(req.messages).includes('ขอผ้าเช็ดตัวเพิ่มค่ะ'));
});

test('parseIntent falls back to other on bad JSON', () => {
  assert.equal(mod.parseIntent('not json').intent, 'other');
  assert.equal(mod.parseIntent('{"intent":"hack"}').intent, 'other');
});

test('reply request includes language', () => {
  const req = mod.buildReplyRequest('room_status', { temp: 24 }, 'th');
  assert.ok(req.messages[0].content.includes('"lang":"th"'));
});
