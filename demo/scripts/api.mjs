// Tiny CLI for the control-plane API.  node scripts/api.mjs POST /api/scenarios/s1/run '{"x":1}'
const [method = 'GET', p = '/api/state', body] = process.argv.slice(2);
const r = await fetch(`http://127.0.0.1:4000${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ?? (method === 'GET' ? undefined : '{}') });
const text = await r.text();
try { console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 4000)); } catch { console.log(text.slice(0, 4000)); }
