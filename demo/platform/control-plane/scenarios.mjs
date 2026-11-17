// Scenario runners used by the UI buttons and the headless smoke test.
import * as rc from './release-client.mjs';
import * as signals from './signals.mjs';
import * as pipeline from './pipeline.mjs';
import * as cost from './cost.mjs';
import * as fin from './finops-client.mjs';
import { say } from './bus.mjs';
import { sleep } from '../lib/util.mjs';

export const running = {};

async function track(name, fn) {
  running[name] = { status: 'running', startedAt: Date.now() };
  try { const r = await fn(); running[name] = { status: 'done', result: r, finishedAt: Date.now() }; return r; }
  catch (e) { running[name] = { status: 'error', error: e.message }; say('scenario', `${name} error: ${e.message}`, { level: 'error' }); throw e; }
}

// S1 — guest complaints about the AC become a shipped fix.
export function selfHeal() {
  return track('s1', async () => {
    say('scenario', 'S1 self-healing: waiting for a ready temperature cluster (guest LINE complaints + KPI alert)…');
    for (let i = 0; i < 90; i++) {
      const cl = signals.clusters.find((c) => c.symptom === 'temperature' && c.status === 'open' && c.ready && !c.workItem)
        || signals.clusters.find((c) => c.symptom === 'temperature' && c.status === 'open' && c.signals.length >= 3 && !c.workItem);
      if (cl) { const wi = pipeline.start(cl.id); say('scenario', `S1 started ${wi.id} from ${cl.id}`); return { workItem: wi.id, cluster: cl.id }; }
      const busy = signals.clusters.find((c) => c.symptom === 'temperature' && c.workItem && c.status !== 'resolved');
      if (busy) return { workItem: busy.workItem, cluster: busy.id, note: 'already in progress' };
      await sleep(1000);
    }
    throw new Error('no temperature cluster formed within 90s (is the hvac bug already fixed?)');
  });
}

// S2 — release train with a contract change hits the pilot hotel.
export function badRelease({ name = '2026.11-r2' } = {}) {
  return track('s2', async () => {
    const fleet = await rc.state();
    if (fleet.freeze) throw new Error(`deploy freeze active: ${fleet.freeze.reason}`);
    if (fleet.manifests.staging['hvac-optimizer'] !== '1.9.0-rc1' && !fleet.parityGate) {
      await rc.setVersion('staging', 'hvac-optimizer', '1.9.0-rc1', { actor: 'team-energy', reason: 'contract testing against rooms-svc 2.4 (pre-release)' });
      say('scenario', 'S2 setup: team-energy deployed hvac-optimizer 1.9.0-rc1 to staging only (pre-release) — this is the drift');
      await sleep(3000);
    }
    say('scenario', `S2: release-eng ships "${name}" = rooms-svc 2.4.0 + guest-assistant 3.1.0 (manifest omits hvac 1.9.0)`);
    const rel = await rc.rollout({ name, services: { 'rooms-svc': '2.4.0', 'guest-assistant': '3.1.0' }, level: 'L3', actor: 'release-eng' });
    return { release: rel.id, status: rel.status };
  });
}

// S3 — AI cost review: advisor findings, free wins, shadow eval, swap proposal, canary.
export function costReview({ autoCanary = pipeline.settings.autoApprove } = {}) {
  return track('s3', async () => {
    await cost.runAdvisor();
    const f1 = cost.state.findings.find((f) => f.id === 'F1');
    if (f1) cost.createCacheFixTask();
    if (cost.state.findings.find((f) => f.id === 'F3')) cost.applyBatch();
    await cost.runShadow();
    const cand = cost.state.report?.candidate;
    if (cand && autoCanary) await cost.startCanary({ model: cand.model, effort: cand.effort, approvedBy: 'autopilot (demo setting)' });
    return { findings: cost.state.findings.map((f) => f.id), report: cost.state.report?.id, candidate: cand };
  });
}

export function badCanary() {
  return track('s3-bad', async () => cost.startCanary({ model: 'small', effort: 'high', approvedBy: 'demo: forced bad candidate', label: 'forced' }));
}

// S4 — reconcile the provider bill against the ledger; find unrouted spend; route it through the gateway; budget bites.
export function billReconcile({ autoAct = pipeline.settings.autoApprove } = {}) {
  return track('s4', async () => {
    say('scenario', 'S4: daily reconciliation — provider cost report vs gateway ledger (last 14 days)');
    const recon = await fin.reconcile({ days: 14, actor: 'finops daily job (scenario S4)' });
    const rogue = recon.findings.find((f) => f.status === 'active');
    if (!rogue) return { recon: recon.id, findings: 0 };
    await cost.runAdvisor();
    if (!autoAct) { say('scenario', `S4: ${rogue.name} found — approve "Deactivate key" in the Bill & budgets tab`); return { recon: recon.id, key: rogue.apiKeyId, waiting: 'approval' }; }
    await fin.deactivateKey(rogue.apiKeyId, 'autopilot (demo setting)');
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const nb = fin.local.notebook;
      if (nb?.mode === 'gateway' && nb.blocked > 0) break;
    }
    const b = (await fin.state()).budgets.find((x) => x.team === rogue.team);
    say('scenario', `S4: ${rogue.name} now goes through the gateway; ${rogue.team} budget ${b?.status} (${Math.round((b?.pct || 0) * 100)}% of $${b?.budget}) — policy ${b?.policy}`);
    return { recon: recon.id, key: rogue.apiKeyId, team: rogue.team, budget: b?.status };
  });
}
