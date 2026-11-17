// Prints the FinOps state (budgets, reconciliation, notebook, infra).  node scripts/finops-check.mjs [--run-s4]
const CP = 'http://127.0.0.1:4000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, body) => (await fetch(CP + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
for (let i = 0; i < 60; i++) { try { await j('/api/finops'); break; } catch { await sleep(1000); } }

function show(f) {
  console.log('notebook:', JSON.stringify(f.notebook));
  for (const b of f.budgets) console.log(`budget ${b.team.padEnd(14)} MTD $${b.mtd.toFixed(1).padStart(7)} / $${b.budget} = ${(b.pct * 100).toFixed(0)}%  projected ${b.projected ? `$${b.projected.toFixed(0)}` : '-'}  ${b.status}  policy=${b.policy}  blocked5m=${b.blocked5m} unrouted=$${b.unrouted.toFixed(1)}`);
  console.log(`infra: $${f.infra.monthly.toFixed(0)}/month — ${f.infra.rows.map((r) => `${r.component} $${r.per_day.toFixed(1)}/d util ${r.util}`).join('; ')}`);
  const r = f.recon;
  if (r) {
    console.log(`recon ${r.id}: bill $${r.totals.provider.toFixed(2)} vs ledger $${r.totals.ledger.toFixed(2)}; max gateway residual ${(r.maxResidualPct * 100).toFixed(3)}%; variance days ${r.varianceDays}`);
    for (const d of r.days) console.log(`  ${d.day} bill $${d.provider.toFixed(2).padStart(8)} ledger $${d.ledger.toFixed(2).padStart(8)} gap ${(d.pct * 100).toFixed(1).padStart(5)}% ${d.status}${d.partial ? ' (partial)' : ''} ${JSON.stringify(Object.fromEntries(Object.entries(d.unrouted).map(([k, v]) => [k, +v.toFixed(2)])))}`);
    console.log('  findings:', JSON.stringify(r.findings.map((x) => ({ key: x.apiKeyId, team: x.team, perDay: +x.perDay.toFixed(2), monthly: +x.monthly.toFixed(0), status: x.status }))));
  }
  console.log('decisions:', JSON.stringify(f.decisions.map((d) => `${d.id} ${d.title} [${d.status}]`)));
}

show(await j('/api/finops'));
if (process.argv.includes('--run-s4')) {
  await j('/api/settings', { autoApprove: true });
  await j('/api/scenarios/s4/run', {});
  for (let i = 0; i < 60; i++) { const s = await j('/api/scenarios'); if (s.s4 && s.s4.status !== 'running') { console.log('\nS4:', JSON.stringify(s.s4)); break; } await sleep(1000); }
  await sleep(6000);
  console.log('\n--- after S4 ---');
  show(await j('/api/finops'));
  const c = await j('/api/cost/state');
  console.log('advisor findings:', c.findings.map((f) => `${f.id} ${f.title} $${Math.round(f.monthlySavingsUsd)}/mo`).join(' | '));
}
