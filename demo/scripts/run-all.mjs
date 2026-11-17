// Runs S1 → S2 → S3 → S4 on the RUNNING demo with autopilot approvals, waiting for each to finish.
// Handy before a presentation:  npm start  (other terminal)  then  node scripts/run-all.mjs
const CP = 'http://127.0.0.1:4000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, body) => (await fetch(CP + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(2000); } return null; }
const doneItems = async (pred) => until(async () => { const s = await j('/api/state'); const w = s.workItems.find(pred); return w && ['done', 'failed', 'needs-human'].includes(w.status) ? w : null; }, 240000);

for (let i = 0; i < 60; i++) { try { await j('/api/state'); break; } catch { await sleep(1000); } }
await sleep(12000);
await j('/api/settings', { autoApprove: true });
console.log('S1 self-heal…');
await j('/api/scenarios/s1/run', {});
console.log('  ', (await doneItems((w) => w.service === 'hvac-optimizer' && w.origin !== 'incident'))?.status);
console.log('S2 bad release…');
await j('/api/scenarios/s2/run', {});
console.log('  ', (await doneItems((w) => w.origin === 'incident'))?.status);
console.log('S3 cost review…');
await j('/api/scenarios/s3/run', {});
console.log('  ', (await until(async () => { const r = await j('/api/scenarios'); return r.s3?.status !== 'running' ? r.s3?.status : null; }, 240000)));
console.log('  ', (await doneItems((w) => w.origin === 'cost'))?.status);
console.log('S4 bill & budgets…');
await j('/api/scenarios/s4/run', {});
console.log('  ', (await until(async () => { const r = await j('/api/scenarios'); return r.s4?.status !== 'running' ? r.s4?.status : null; }, 120000)));
await sleep(8000);
console.log('done');
