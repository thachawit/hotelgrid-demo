// Prints a compact snapshot of the running demo (for terminals / CI). Usage: node scripts/inspect.mjs [metrics|state|cost|all]
const CP = 'http://127.0.0.1:4000';
const what = process.argv[2] || 'all';
const j = async (p) => (await fetch(CP + p)).json();
const pct = (x) => `${(x * 100).toFixed(1)}%`;

if (what === 'metrics' || what === 'all') {
  const m = await j('/api/metrics');
  for (const [site, v] of Object.entries(m)) {
    const k = v.kpi;
    console.log(`${site.padEnd(18)} mismatch ${pct(k.mismatchRate).padStart(6)} (n=${k.setN}) edge5xx ${pct(k.edgeErrRate)} chats ${k.chatN} | ` +
      Object.entries(v.services).map(([s, x]) => `${s.split('-')[0]}:${x.n}/${pct(x.errRate)}/${Math.round(x.p95)}ms`).join(' '));
  }
}
if (what === 'state' || what === 'all') {
  const s = await j('/api/state');
  console.log('manifests:', Object.entries(s.manifests).map(([k, v]) => `${k}{${Object.entries(v).map(([a, b]) => `${a.split('-')[0]}=${b}`).join(',')}}`).join(' '));
  console.log('freeze:', s.freeze?.reason || 'off', '| parity:', s.parityGate, '| drift:', JSON.stringify(s.drift));
  console.log('clusters:', s.clusters.slice(0, 6).map((c) => `${c.id}:${c.symptom}:${c.signals.length}sig/${c.alerts}al:${c.status}${c.workItem ? `→${c.workItem}` : ''}`).join(' '));
  for (const w of s.workItems.slice(0, 5)) console.log(`  ${w.id} ${w.status} ${w.service || ''} ${w.newVersion || ''} $${w.costUsd.toFixed(4)} — ${w.title}`);
  for (const r of s.releases.slice(0, 4)) console.log(`  ${r.id} ${r.status} ${r.name} rings:${r.rings.map((x) => `${x.ring}:${x.status}`).join(',')}`);
  for (const i of s.incidents.slice(0, 3)) console.log(`  ${i.id} ${i.status} culprit=${i.culprit?.ranking?.[0]?.service} numbers=${JSON.stringify(i.report?.numbers)}`);
  console.log('signals:', s.signals.slice(0, 4).map((x) => `[${x.source}${x.flags?.promptInjection ? ' INJ' : ''}] ${x.text.slice(0, 70)}`).join('\n         '));
  console.log('loadgen:', JSON.stringify(s.loadgen.stats), 'spans:', JSON.stringify(s.telemetry));
}
if (what === 'cost' || what === 'all') {
  const c = await j('/api/cost/summary');
  console.log(`cost: run-rate $${Math.round(c.monthlyRunRate)}/mo, API $${c.dailyApi.toFixed(1)}/day, seats $${c.seatMonthly}/mo`);
  for (const r of c.live) console.log(`  live ${r.route.padEnd(18)} n=${r.n} hit=${pct(r.cacheHitRate)} acc=${r.accuracy == null ? '-' : pct(r.accuracy)} $/call=${r.costPerCall.toFixed(5)}`);
  for (const r of c.byRoute) console.log(`  7d ${r.route.padEnd(18)} $${r.perDay.toFixed(2)}/day`);
}
