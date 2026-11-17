// Stage 01 Signals: store normalized signals, rate-limit, cluster near-duplicates, raise metric alerts.
import * as rc from './release-client.mjs'; // KPIs come from the Go release controller's telemetry store
import { say, emit } from './bus.mjs';
import { similarity } from '../lib/util.mjs';

export const signals = [];
export const clusters = [];
let sSeq = 0, cSeq = 0;
let cfg, onClusterReady = () => {};
const perSiteMinute = new Map();

export function init(c, { clusterReady }) { cfg = c; onClusterReady = clusterReady; setInterval(() => alertWatch().catch(() => {}), 5000); }

const TEMP = /(แอร์|องศา|อุณหภูมิ|ร้อน|\bac\b|aircon|temperature|setpoint|°c|\bhot\b)/i;
const ERR = /(error|ค้าง|went wrong|ไม่ได้|5xx|failing|fail)/i;
const COST = /(cache|cost|token|spend)/i;
function symptom(text) {
  if (COST.test(text)) return 'ai-cost';
  if (ERR.test(text) && !/ไม่เย็น/.test(text)) return 'app-error';
  if (TEMP.test(text)) return 'temperature';
  return 'other';
}

export function add(sig) {
  const key = `${sig.siteId}|${Math.floor(Date.now() / 60000)}`;
  const n = (perSiteMinute.get(key) || 0) + 1;
  perSiteMinute.set(key, n);
  if (n > 40 && sig.source !== 'alert') return { dropped: true, reason: 'rate limit 40/min/site' };
  const s = { id: `SIG-${++sSeq}`, ...sig, symptom: sig.symptom || symptom(sig.text), ts: Date.now() };
  signals.unshift(s);
  if (signals.length > 1000) signals.pop();
  // cluster: same symptom, open, recent; similarity is a tie-breaker for "other"
  let cl = clusters.find((c) => c.status !== 'resolved' && c.symptom === s.symptom && Date.now() - c.lastAt < 15 * 60000 &&
    (s.symptom !== 'other' || c.signals.some((id) => similarity(byId(id)?.text || '', s.text) > 0.25)));
  if (!cl) {
    cl = { id: `CL-${++cSeq}`, symptom: s.symptom, status: 'open', signals: [], sites: [], rooms: [], firstAt: s.ts, lastAt: s.ts, alerts: 0, origin: sig.origin || 'signal', workItem: null };
    clusters.unshift(cl);
  }
  cl.signals.push(s.id);
  cl.lastAt = s.ts;
  if (!cl.sites.includes(s.siteId)) cl.sites.push(s.siteId);
  if (s.roomId && !cl.rooms.includes(s.roomId)) cl.rooms.push(s.roomId);
  if (s.source === 'alert') cl.alerts++;
  if (sig.evidence) cl.evidence = { ...(cl.evidence || {}), ...sig.evidence };
  if (sig.origin && sig.origin !== 'signal') cl.origin = sig.origin;
  s.clusterId = cl.id;
  emit('signal', { signal: s, cluster: cl });
  if (s.flags?.promptInjection) say('intake', `${s.id} flagged: instruction-like text from ${s.source} — kept as data, never as instructions`, { level: 'warn' });
  const ready = cl.origin !== 'signal' || (cl.signals.length >= 3 && (cl.alerts > 0 || cl.rooms.length >= 3));
  if (ready && !cl.workItem) onClusterReady(cl);
  return s;
}

export const byId = (id) => signals.find((s) => s.id === id);
export const clusterById = (id) => clusters.find((c) => c.id === id);
export const signalsIn = (site, from, to) => signals.filter((s) => s.siteId === site && s.ts >= from && s.ts <= to && s.source !== 'alert');

// Metric alerts become signals too (source: alert).
const lastAlert = new Map();
async function alertWatch() {
  for (const site of cfg.sites) {
    const k = await rc.kpi(site.id, Date.now() - 60000);
    if (k.setN >= 12 && k.mismatchRate > 0.2 && Date.now() - (lastAlert.get(`${site.id}|mm`) || 0) > 120000) {
      lastAlert.set(`${site.id}|mm`, Date.now());
      add({ source: 'alert', siteId: site.id, roomId: null, lang: 'en', reporterRole: 'monitor', flags: {}, symptom: 'temperature',
        text: `ALERT setpoint_mismatch_rate ${(k.mismatchRate * 100).toFixed(0)}% at ${site.id} (60s, n=${k.setN}) — occupied rooms not getting requested AC setpoint` });
    }
  }
}

// Tasks created by other systems (incident follow-ups, cost advisor findings) enter the same intake.
export function addTask({ text, siteId = 'factory', symptom: sym, origin, evidence }) {
  const s = add({ source: origin, siteId, roomId: null, lang: 'en', reporterRole: 'system', flags: {}, symptom: sym, text, origin, evidence });
  return clusterById(s.clusterId);
}

export function resolveCluster(id, note) {
  const cl = clusterById(id);
  if (!cl) return;
  cl.status = 'resolved';
  cl.resolvedAt = Date.now();
  cl.resolution = note;
  emit('signal', { cluster: cl });
}
