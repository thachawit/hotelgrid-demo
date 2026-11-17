// HotelGrid Dark Factory dashboard — vanilla JS, polls the control plane and listens to SSE.
const S = { tab: 'overview', state: null, metrics: null, cost: null, costState: null, finops: null, selWI: null, wi: null, selInc: null, inc: null, log: [], diagram: 'full-factory.html' };
const $ = (id) => document.getElementById(id);
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (p, body) => {
  const r = await fetch(p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const t = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '—');
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = (n) => (n == null ? '—' : n >= 1000 ? `$${Math.round(n).toLocaleString()}` : n >= 10 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

const STATUS = {
  good: ['done', 'passed', 'complete', 'promoted', 'mitigated', 'resolved', 'pass', 'applied (L1 auto)'],
  critical: ['failed', 'rolled-back', 'reverted', 'needs-human', 'error', 'fail'],
  serious: ['blocked:freeze', 'blocked:parity'],
  warning: ['approval', 'baking', 'watching', 'mitigating'],
};
function chip(status, label = status) {
  const cls = Object.entries(STATUS).find(([, v]) => v.includes(status))?.[0] || 'info';
  return `<span class="st ${cls}">${e(label)}</span>`;
}

// ---------------- tooltip ----------------
const tip = $('tip');
document.addEventListener('mousemove', (ev) => {
  const el = ev.target.closest?.('[data-tip]');
  if (!el) { tip.classList.add('hidden'); return; }
  tip.innerHTML = el.getAttribute('data-tip');
  tip.classList.remove('hidden');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, ev.clientX + 14)}px`;
  tip.style.top = `${Math.max(8, ev.clientY - h - 12)}px`;
});

// ---------------- charts ----------------
function spark(values, { max = null, color = 'var(--s1)', label = '' } = {}) {
  const W = 110, H = 26;
  const m = max ?? Math.max(0.0001, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * W},${H - 2 - (Math.min(v, m) / m) * (H - 4)}`).join(' ');
  const last = values[values.length - 1] ?? 0;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-tip="<div class='tt'>${e(label)}</div>last 5 min · now ${pct(last)} · peak ${pct(Math.max(0, ...values))}">
    <line x1="0" x2="${W}" y1="${H - 1}" y2="${H - 1}" class="baseline" stroke="var(--axis)"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); }

function stackedBars(days, series, { height = 220, money = true } = {}) {
  // days: [{label, values:{key:number}}], series: [{key,label,color}]
  const W = 900, H = height, L = 46, B = 22, T = 8, R = 4;
  const totals = days.map((d) => series.reduce((a, s) => a + (d.values[s.key] || 0), 0));
  const max = niceMax(Math.max(...totals, 0.0001));
  const bw = (W - L - R) / days.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svg += `<line class="${i ? 'gridline' : 'baseline'}" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="tick" x="${L - 6}" y="${yy + 3}" text-anchor="end">${money ? (v === 0 ? '$0' : usd(v)) : v}</text>`;
  }
  days.forEach((d, i) => {
    const x = L + i * bw + 2, w = Math.max(2, bw - 4);
    let acc = 0;
    const segs = series.filter((s) => (d.values[s.key] || 0) > 0);
    segs.forEach((s, j) => {
      const v = d.values[s.key]; const y1 = y(acc + v), y0 = y(acc);
      const hgt = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
      const top = j === segs.length - 1;
      svg += top
        ? `<path d="M${x},${y0} V${y1 + 4} Q${x},${y1} ${x + 4},${y1} H${x + w - 4} Q${x + w},${y1} ${x + w},${y1 + 4} V${y0} Z" fill="${s.color}"/>`
        : `<rect x="${x}" y="${y1 + (j < segs.length - 1 ? 0 : 0)}" width="${w}" height="${hgt}" fill="${s.color}"/>`;
      acc += v;
    });
    if (i % 5 === 0 || i === days.length - 1) svg += `<text class="tick" x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${e(d.label)}</text>`;
    const tipHtml = `<div class='tt'>${e(d.full || d.label)}</div>${series.map((s) => `<div class='tr'><span><i style='background:${s.color}'></i>${e(s.label)}</span><b>${money ? usd(d.values[s.key] || 0) : d.values[s.key] || 0}</b></div>`).join('')}<div class='tr'><span>Total</span><b>${money ? usd(totals[i]) : totals[i]}</b></div>`;
    svg += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent" data-tip="${e(tipHtml)}"/>`;
  });
  const legend = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${e(s.label)}</span>`).join('')}</div>`;
  return `${legend}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="stacked daily spend">${svg}</svg></div>`;
}

function hbars(rows, { color = 'var(--s1)' } = {}) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return `<div class="list">${rows.map((r) => `<div data-tip="<div class='tt'>${e(r.label)}</div>${usd(r.value)}">
    <div class="small ink2" style="display:flex;justify-content:space-between"><span>${e(r.label)}</span><b style="color:var(--ink)">${usd(r.value)}</b></div>
    <svg viewBox="0 0 300 8" preserveAspectRatio="none" style="width:100%;height:8px;display:block"><rect x="0" y="0" width="${(r.value / max) * 300}" height="8" rx="4" fill="${color}"/></svg></div>`).join('')}</div>`;
}

function ciPlot(arms) {
  // dot + whisker per arm for Overall (s1) and Thai (s2); x from 0.70 to 1.00
  const W = 640, rowH = 46, L = 150, R = 16, T = 22, H = T + arms.length * rowH + 22;
  const lo = 0.7, hi = 1.0;
  const x = (v) => L + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - L - R);
  let svg = '';
  for (let v = lo; v <= hi + 1e-9; v += 0.05) svg += `<line class="gridline" x1="${x(v)}" x2="${x(v)}" y1="${T - 6}" y2="${H - 22}"/><text class="tick" x="${x(v)}" y="${H - 8}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  const base = arms.find((a) => a.baseline);
  if (base) svg += `<line x1="${x(base.thai.mean - 0.02)}" x2="${x(base.thai.mean - 0.02)}" y1="${T - 10}" y2="${H - 22}" stroke="var(--s2)" stroke-dasharray="3 3"/><text class="tick" x="${x(base.thai.mean - 0.02)}" y="${T - 12}" text-anchor="middle">Thai bar (baseline −2 pts)</text>`;
  arms.forEach((a, i) => {
    const cy = T + i * rowH + rowH / 2;
    svg += `<text x="${L - 10}" y="${cy + 4}" text-anchor="end" style="fill:var(--ink);font-size:12px">${e(a.name)}</text>`;
    [['overall', 'var(--s1)', -7, 'Overall'], ['thai', 'var(--s2)', 7, 'Thai slice']].forEach(([k, c, dy, lab]) => {
      const m = a[k];
      const tipHtml = `<div class='tt'>${e(a.name)} · ${lab}</div>${pct(m.mean)} (95% CI ${pct(m.lo)} – ${pct(m.hi)})`;
      svg += `<line x1="${x(m.lo)}" x2="${x(m.hi)}" y1="${cy + dy}" y2="${cy + dy}" stroke="${c}" stroke-width="2"/>`;
      svg += `<circle cx="${x(m.mean)}" cy="${cy + dy}" r="5" fill="${c}" stroke="var(--surface)" stroke-width="2"/>`;
      svg += `<rect x="${L}" y="${cy + dy - 7}" width="${W - L - R}" height="14" fill="transparent" data-tip="${e(tipHtml)}"/>`;
    });
  });
  return `<div class="legend"><span><i style="background:var(--s1)"></i>Overall accuracy</span><span><i style="background:var(--s2)"></i>Thai slice accuracy</span><span class="muted">dot = mean, line = 95% bootstrap CI</span></div>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="shadow eval accuracy with confidence intervals">${svg}</svg></div>`;
}

// ---------------- header ----------------
function renderPills() {
  const s = S.state; if (!s) return;
  const lg = s.loadgen;
  $('pills').innerHTML = [
    `<span class="pill ${s.freeze ? 'bad' : 'good'}"><span class="dot"></span>Deploy freeze: ${s.freeze ? e(s.freeze.reason) : 'off'}${s.freeze ? ' <button id="lift">lift</button>' : ''}</span>`,
    `<span class="pill ${s.parityGate ? 'good' : 'warn'}"><span class="dot"></span>Parity gate: ${s.parityGate ? 'on' : 'off'} <button id="parity">${s.parityGate ? 'turn off' : 'turn on'}</button></span>`,
    `<span class="pill ${s.settings.autoApprove ? 'warn' : ''}"><span class="dot"></span>Approvals: ${s.settings.autoApprove ? 'autopilot' : 'human'} <button id="auto">${s.settings.autoApprove ? 'make human' : 'autopilot'}</button></span>`,
    `<span class="pill"><span class="dot"></span>Traffic: ${lg.paused ? 'paused' : `${lg.stats.sent || 0} req`} <button id="lg">${lg.paused ? 'resume' : 'pause'}</button></span>`,
  ].join('');
  $('lift')?.addEventListener('click', () => api('/api/freeze/lift', {}).then(refresh));
  $('parity').onclick = () => api('/api/parity', { on: !s.parityGate }).then(refresh);
  $('auto').onclick = () => api('/api/settings', { autoApprove: !s.settings.autoApprove }).then(refresh);
  $('lg').onclick = () => api('/api/loadgen', { paused: !lg.paused }).then(refresh);
  const active = s.workItems.filter((w) => !['done', 'failed', 'needs-human'].includes(w.status)).length;
  $('c-factory').textContent = active ? ` ${active}` : '';
  $('c-incidents').textContent = s.incidents.length ? ` ${s.incidents.length}` : '';
  for (const b of document.querySelectorAll('[data-run]')) {
    const sc = s.scenarios[b.dataset.run];
    b.disabled = sc?.status === 'running';
    b.title = b.title.replace(/ \(running\)$/, '') + (sc?.status === 'running' ? ' (running)' : '');
  }
}

// ---------------- overview ----------------
const STAGES = [
  ['01', 'Signals', (s) => s.clusters.filter((c) => c.status !== 'resolved').slice(0, 4).map((c) => ({ id: c.id, label: `${c.id} · ${c.symptom} · ${c.signals.length} signals${c.alerts ? ` · ${c.alerts} alerts` : ''}`, cluster: true }))],
  ['02', 'Triage', (s) => s.workItems.filter((w) => ['triage', 'repro'].includes(w.status))],
  ['03', 'Build', (s) => s.workItems.filter((w) => w.status === 'build')],
  ['04', 'Validate', (s) => s.workItems.filter((w) => ['validate', 'approval'].includes(w.status))],
  ['05', 'Ship & observe', (s) => s.workItems.filter((w) => w.status === 'ship')],
];

function renderOverview() {
  const s = S.state; if (!s) return;
  const m = S.metrics || {};
  const prod = s.sites.filter((x) => x.ring > 0);
  let setN = 0, mm = 0, edgeN = 0, edgeErr = 0;
  for (const site of s.sites) { const k = m[site.id]?.kpi; if (k) { setN += k.setN; mm += k.mismatch; edgeN += k.edgeN; edgeErr += k.edgeErr; } }
  const intent = S.cost?.live?.find((r) => r.route === 'assistant.intent');
  const done = s.workItems.filter((w) => w.status === 'done');
  const tiles = [
    ['Setpoint mismatch (30s, all sites)', pct(setN ? mm / setN : 0), 'occupied rooms not getting the AC they asked for'],
    ['Edge 5xx (30s)', pct(edgeN ? edgeErr / edgeN : 0), `${edgeN} edge requests`],
    ['AI run-rate', S.cost ? `${usd(S.cost.monthlyRunRate)}/mo` : '—', 'API (modeled) + seats'],
    ['Intent prompt-cache hit (5 min)', intent ? pct(intent.cacheHitRate) : '—', intent ? `${usd(intent.costPerCall)} per call` : ''],
    ['Fixes shipped by the factory', String(done.length), done.length ? `avg LLM cost ${usd(done.reduce((a, w) => a + w.costUsd, 0) / done.length)} per fix` : 'none yet'],
  ];
  const strip = STAGES.map(([no, name, fn]) => {
    const items = fn(s);
    return `<div class="stage"><div class="no">${no}</div><h3>${name}</h3>${items.length ? items.map((it) => it.cluster
      ? `<div class="item" data-cluster="${it.id}" title="${e(it.label)}">${e(it.label)}</div>`
      : `<div class="item" data-wi="${it.id}" title="${e(it.title)}">${e(it.id)} · ${e(it.status)} · ${e(it.title)}</div>`).join('') : '<div class="muted small">idle</div>'}</div>`;
  }).join('');
  const feed = S.log.slice(-80).reverse().map((ev) => `<div class="ev lvl-${ev.data.level}"><span class="t">${t(ev.ts)}</span><span class="k">${e(ev.data.source)}</span><span>${e(ev.data.msg)}</span></div>`).join('');
  $('tab-overview').innerHTML = `
    <div class="tiles">${tiles.map(([l, v, n]) => `<div class="tile"><div class="label">${e(l)}</div><div class="value">${v}</div><div class="note">${e(n)}</div></div>`).join('')}</div>
    <h2 style="margin:16px 0 8px">Factory, live</h2>
    <div class="strip">${strip}</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Activity</h2><span class="sub">every agent step, gate, deploy and rollback</span></header><div class="feed timeline">${feed || '<div class="empty">waiting for events…</div>'}</div></div>
      <div class="card"><header><h2>Sites</h2><span class="sub">setpoint mismatch & edge errors, last 5 min</span></header>
        <div class="table-wrap"><table><thead><tr><th>Site</th><th>Ring</th><th>Mismatch</th><th></th><th>Edge 5xx</th><th></th></tr></thead><tbody>
        ${s.sites.map((site) => { const k = m[site.id]; return `<tr><td>${e(site.name)}</td><td>${site.ring}</td><td class="num">${pct(k?.kpi.mismatchRate)}</td><td>${k ? spark(k.kpiSeries.map((x) => x.mismatchRate), { max: 1, color: 'var(--s2)', label: `${site.id} mismatch` }) : ''}</td><td class="num">${pct(k?.kpi.edgeErrRate)}</td><td>${k ? spark(k.kpiSeries.map((x) => x.edgeErrRate), { max: 0.5, color: 'var(--s1)', label: `${site.id} edge 5xx` }) : ''}</td></tr>`; }).join('')}
        </tbody></table></div>
        <p class="small muted">${prod.length} production sites + staging. Traffic is generated; guests who get a bad outcome sometimes complain on LINE.</p>
      </div>
    </div>`;
}

// ---------------- factory ----------------
function diffHtml(d) {
  return e(d || '').split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? `<span class="a">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="r">${l}</span>` : l.startsWith('@@') || l.startsWith('diff') ? `<span class="h">${l}</span>` : l)).join('\n');
}

function renderFactory() {
  const s = S.state; if (!s) return;
  const clusters = s.clusters.map((c) => `<div class="row" data-cluster="${c.id}">
      ${chip(c.status)} <span class="grow"><b>${c.id}</b> · ${e(c.symptom)} · ${c.signals.length} signals · ${c.rooms.length} rooms${c.alerts ? ` · ${c.alerts} alerts` : ''}</span>
      ${c.workItem ? `<span class="small muted">${c.workItem}</span>` : `<button class="btn" data-triage="${c.id}">Triage</button>`}</div>`).join('');
  const items = s.workItems.map((w) => `<div class="row ${S.selWI === w.id ? 'sel' : ''}" data-wi="${w.id}">${chip(w.status)}<span class="grow"><b>${w.id}</b> ${e(w.title)}</span><span class="small muted">${usd(w.costUsd)}</span></div>`).join('');
  const sigs = s.signals.slice(0, 14).map((x) => `<div class="ev"><span class="t">${t(x.ts)}</span><span class="k">${e(x.source)}${x.flags?.promptInjection ? ' ⚠' : ''}</span><span>${x.roomId ? `room ${e(x.roomId)} · ` : ''}${e(x.text)}${x.flags?.promptInjection ? ' <span class="st serious">injection flagged</span>' : ''}</span></div>`).join('');
  $('tab-factory').innerHTML = `
    <div class="grid g-side">
      <div class="grid" style="align-content:start">
        <div class="card"><header><h2>Work items</h2><span class="sub">auto-triage ${s.settings.autoTriage ? 'on' : 'off'}</span><span class="right"><button class="btn" id="autotriage">${s.settings.autoTriage ? 'Turn auto-triage off' : 'Turn auto-triage on'}</button></span></header><div class="list">${items || '<div class="empty">No work yet. Run S1, or press Triage on a cluster.</div>'}</div></div>
        <div class="card"><header><h2>Signal clusters</h2></header><div class="list">${clusters || '<div class="empty">no signals yet</div>'}</div></div>
        <div class="card"><header><h2>Latest signals</h2><span class="sub">LINE, Slack, assistant, alerts — PII redacted at intake</span></header><div class="timeline">${sigs}</div></div>
      </div>
      <div id="wi-detail">${renderWIDetail()}</div>
    </div>`;
  $('autotriage').onclick = () => api('/api/settings', { autoTriage: !s.settings.autoTriage }).then(refresh);
}

function renderWIDetail() {
  const w = S.wi;
  if (!w) return '<div class="card"><div class="empty">Select a work item to see its agent steps, spec, diff, gates and release.</div></div>';
  const steps = w.steps.map((x) => `<div class="ev"><span class="t">${t(x.ts)}</span><span class="k">${e(x.stage)} · ${e(x.kind)}</span><span>${e(x.title)}${x.detail ? `<div class="d">${e(x.detail)}</div>` : ''}</span></div>`).join('');
  const gates = (w.gates || []).map((g) => `<tr><td>${chip(g.ok ? 'pass' : 'fail', g.ok ? 'pass' : 'fail')}</td><td>${e(g.name)}</td><td class="ink2">${e(g.detail)}</td></tr>`).join('');
  return `<div class="grid">
    <div class="card"><header><h2>${e(w.id)} · ${e(w.title)}</h2>${chip(w.status)}
      <span class="right">${w.status === 'approval' ? `<button class="btn primary" data-approve="${w.id}">Approve ${e(w.approvalLevel)}</button>` : ''}</span></header>
      <div class="tiles">
        <div class="tile"><div class="label">Service</div><div class="value" style="font-size:16px">${e(w.service || '—')}</div><div class="note">${e(w.baseVersion || '')}${w.newVersion ? ` → ${e(w.newVersion)}` : ''}</div></div>
        <div class="tile"><div class="label">Approval level</div><div class="value" style="font-size:16px">${e(w.approvalLevel || '—')}</div><div class="note">${e(w.approvedBy ? `approved by ${w.approvedBy}` : w.owner || '')}</div></div>
        <div class="tile"><div class="label">LLM cost for this fix</div><div class="value" style="font-size:16px">${usd(w.costUsd)}</div><div class="note">${(w.tokens || 0).toLocaleString()} tokens via gateway</div></div>
        <div class="tile"><div class="label">PR / release</div><div class="value" style="font-size:16px">${e(w.pr?.id || '—')}</div><div class="note">${e(w.release || w.branch || '')}</div></div>
      </div></div>
    <div class="card"><header><h2>Agent steps</h2><span class="sub">origin: ${e(w.origin)} · cluster ${e(w.clusterId)}</span></header><div class="timeline">${steps}</div></div>
    ${gates ? `<div class="card"><header><h2>04 Validate gates</h2></header><div class="table-wrap"><table><tbody>${gates}</tbody></table></div></div>` : ''}
    ${w.diff ? `<div class="card"><header><h2>Diff</h2><span class="sub">${e(w.branch)} · commit ${e(w.commit || '')}</span></header><pre class="diff">${diffHtml(w.diff)}</pre></div>` : ''}
    ${w.repro ? `<div class="card"><header><h2>Regression test</h2><span class="sub">${e(w.repro.file)} · failed on ${e(w.baseVersion)}, passes on ${e(w.newVersion || '…')}</span></header><pre class="code">${e(w.repro.result.tail)}</pre></div>` : ''}
    ${w.specMd ? `<div class="card"><header><h2>Spec</h2></header><pre class="code" style="white-space:pre-wrap">${e(w.specMd)}</pre></div>` : ''}
  </div>`;
}

// ---------------- fleet ----------------
function renderFleet() {
  const s = S.state; if (!s) return;
  const m = S.metrics || {};
  const svcs = Object.keys(s.topo.services);
  const driftSet = new Set(s.drift.map((d) => d.service));
  const rows = s.sites.map((site) => `<tr><td><b>${e(site.name)}</b><div class="small muted">${e(site.id)} · ring ${site.ring}</div></td>
    ${svcs.map((svc) => { const v = s.manifests[site.id][svc]; const mm = m[site.id]?.services[svc];
      const isNew = v !== s.topo.initialManifest[svc];
      return `<td><span class="ver ${isNew ? 'new' : ''} ${site.id === 'staging' && driftSet.has(svc) ? 'drift' : ''}">${e(v)}</span>
      <div class="small muted">${mm ? `${mm.n} req · ${pct(mm.errRate)} 5xx` : ''}</div>${mm ? spark(mm.series, { max: 0.5, label: `${site.id} ${svc} 5xx rate` }) : ''}</td>`; }).join('')}</tr>`).join('');
  const rel = s.releases.map((r) => `<tr><td><b>${e(r.id)}</b><div class="small muted">${t(r.startedAt)}</div></td><td>${e(r.name)}<div class="small muted">${Object.entries(r.services).map(([a, b]) => `${a}@${b}`).join(', ')} · ${e(r.level)} · ${e(r.actor)}</div></td><td>${chip(r.status)}</td>
    <td>${r.rings.map((g) => `${chip(g.status, `${g.name}: ${g.status}`)}`).join(' ')}${r.rings.find((g) => g.parity && !g.parity.ok) ? `<div class="small">${e(r.rings.find((g) => g.parity && !g.parity.ok).parity.problems.map((p) => `${p.site} runs ${p.service}@${p.site_version}, staging @${p.staging_version}`).join('; '))}</div>` : ''}</td></tr>`).join('');
  const hist = s.history.slice(0, 25).map((h) => `<div class="ev"><span class="t">${t(h.ts)}</span><span class="k">${e(h.site)}</span><span>${e(h.service)} ${e(h.from)} → <b>${e(h.to)}</b> <span class="muted">${e(h.actor)}${h.release ? ` · ${e(h.release)}` : ''}${h.reason ? ` · ${e(h.reason)}` : ''}</span></span></div>`).join('');
  $('tab-fleet').innerHTML = `
    ${s.drift.length ? `<div class="banner">${chip('blocked:parity', 'manifest drift')} <span>Staging differs from production: ${s.drift.map((d) => `${e(d.service)} staging ${e(d.staging)} vs prod ${e(d.prod.join('/'))}`).join('; ')}</span></div>` : ''}
    <div class="card"><header><h2>Sites × services</h2><span class="sub">running version per site (hot-loaded from the workspace repo) · 5xx rate last 5 min</span></header>
      <div class="table-wrap"><table><thead><tr><th>Site</th>${svcs.map((x) => `<th>${e(x)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Releases</h2><span class="sub">rings: staging → pilot hotel → all sites, canary-gated</span></header><div class="table-wrap"><table><tbody>${rel || '<tr><td class="muted">none yet</td></tr>'}</tbody></table></div></div>
      <div class="card"><header><h2>Deploy history</h2><span class="right"><button class="btn" id="gitlog">git log</button></span></header><div class="timeline">${hist || '<div class="empty">no deploys yet</div>'}</div><pre class="code hidden" id="gitlog-out"></pre></div>
    </div>`;
  $('gitlog').onclick = async () => { const r = await api('/api/git/log'); const o = $('gitlog-out'); o.textContent = r.log; o.classList.remove('hidden'); };
}

// ---------------- incidents ----------------
function renderIncidents() {
  const s = S.state; if (!s) return;
  const list = s.incidents.map((i) => `<div class="row ${S.selInc === i.id ? 'sel' : ''}" data-inc="${i.id}">${chip(i.status)}<span class="grow"><b>${i.id}</b> ${e(i.releaseName)} at ${e(i.site)}</span><span class="small muted">${t(i.detectedAt)}</span></div>`).join('');
  const inc = S.inc;
  let detail = '<div class="card"><div class="empty">No incidents. Run S2 to push a bad release train at the pilot hotel.</div></div>';
  if (inc) {
    const n = inc.report?.numbers || {};
    const sec = (a, b) => (a && b ? `${Math.round((b - a) / 1000)}s` : '—');
    detail = `<div class="grid">
      <div class="tiles">
        <div class="tile"><div class="label">Detect</div><div class="value">${sec(inc.anomalyStart, inc.detectedAt)}</div><div class="note">first failing span → gate tripped</div></div>
        <div class="tile"><div class="label">Mitigate</div><div class="value">${sec(inc.detectedAt, inc.mitigatedAt)}</div><div class="note">consumer-first rollback</div></div>
        <div class="tile"><div class="label">Rooms affected</div><div class="value">${n.rooms ?? '—'}</div><div class="note">${n.hvacLost ?? 0} setpoint commands lost</div></div>
        <div class="tile"><div class="label">Edge requests failed</div><div class="value">${n.edgeFailed ?? '—'}</div><div class="note">of ${n.edgeTotal ?? '—'} at ${e(inc.site)}</div></div>
        <div class="tile"><div class="label">Fix task</div><div class="value" style="font-size:16px">${e(inc.fixTask || '—')}</div><div class="note">through the factory</div></div>
      </div>
      <div class="card"><header><h2>Rollback controller</h2>${chip(inc.status)}<span class="sub">order: ${e((inc.rollbackOrder || []).join(' → '))}</span></header>
        <div class="timeline">${inc.steps.map((x) => `<div class="ev"><span class="t">${t(x.ts)}</span><span class="k">step</span><span>${e(x.title)}${x.detail ? `<div class="d">${e(x.detail)}</div>` : ''}</span></div>`).join('')}</div></div>
      ${inc.report ? `<div class="card"><header><h2>Impact report</h2><span class="right"><a class="btn" href="/reports/${inc.id}.md" target="_blank">Markdown</a></span></header><div class="md">${inc.report.html}</div></div>` : ''}
    </div>`;
  }
  $('tab-incidents').innerHTML = `<div class="grid g-side"><div class="card" style="align-self:start"><header><h2>Incidents</h2></header><div class="list">${list || '<div class="empty">none</div>'}</div></div><div>${detail}</div></div>`;
}

// ---------------- cost ----------------
const COST_SERIES = [
  { key: 'intent', label: 'Guest chat: intent', color: 'var(--s1)', match: (r) => r === 'assistant.intent' },
  { key: 'reply', label: 'Guest chat: reply', color: 'var(--s2)', match: (r) => r === 'assistant.reply' },
  { key: 'evals', label: 'CI evals + shadow evals', color: 'var(--s3)', match: (r) => r === 'eval.golden' || r === 'cost.shadow' },
  { key: 'agents', label: 'Factory agents, advisor, data jobs', color: 'var(--s4)', match: (r) => r.startsWith('factory.') || r === 'cost.advisor' || r.startsWith('data.') },
  { key: 'unrouted', label: 'Only on the bill (unrouted keys)', color: 'var(--s5)', match: (r) => r === 'unrouted (bill only)' },
];

function renderCost() {
  const c = S.cost, cs = S.costState;
  if (!c) { $('tab-cost').innerHTML = '<div class="empty">loading cost ledger…</div>'; return; }
  const byDay = {};
  for (const r of c.daily) { const k = COST_SERIES.find((x) => x.match(r.route || ''))?.key; if (!k) continue; (byDay[r.day] ||= {})[k] = ((byDay[r.day] ||= {})[k] || 0) + r.cost; }
  const today = new Date().toISOString().slice(0, 10);
  const days = Object.keys(byDay).sort().map((d) => ({ label: d === today ? 'today' : d.slice(5), full: d === today ? `${d} (live demo traffic, weighted 1/${c.accel})` : d, values: byDay[d] }));
  const intentLive = c.live.find((r) => r.route === 'assistant.intent');
  const outcome = c.outcomes.length ? c.outcomes.reduce((a, o) => a + o.llm_cost, 0) / c.outcomes.length : null;
  const findings = (cs?.findings || []).map((f) => {
    const btn = { 'deactivate-key': `<button class="btn primary" data-fin="deactivate" data-key="${e(f.evidence.apiKeyId)}">Deactivate key → gateway (${f.approvalLevel})</button>`, 'factory-task': `<button class="btn primary" data-cost="fix">Send to factory (${f.approvalLevel})</button>`, 'shadow-eval': `<button class="btn primary" data-cost="shadow">Run shadow eval</button>`, 'config-l1': `<button class="btn primary" data-cost="batch" ${cs.routes['eval.golden']?.batch ? 'disabled' : ''}>${cs.routes['eval.golden']?.batch ? 'Applied (L1)' : 'Apply (L1 auto)'}</button>`, recommendation: '<span class="small muted">recommendation for the cost team</span>' }[f.actionType];
    return `<div class="card"><header><h3>${e(f.id)} · ${e(f.title)}</h3><span class="st ${f.kind === 'free-win' ? 'good' : f.kind === 'tradeoff' ? 'warning' : 'info'}">${e(f.kind)}</span><span class="right"><b>${usd(f.monthlySavingsUsd)}/mo</b></span></header>
      <p class="ink2" style="margin:0 0 8px">${e(f.action)}</p><div class="small muted">Sources: ${f.citations.map((x) => `<code>${e(x)}</code>`).join(' ')}</div><div style="margin-top:8px">${btn}</div></div>`;
  }).join('');
  const sh = cs?.shadow;
  const shadowHtml = sh ? (sh.status === 'running' ? '<div class="empty">shadow eval running on the batch path…</div>' : `${ciPlot(sh.arms)}
      <div class="table-wrap"><table><thead><tr><th>Arm</th><th class="num">Overall</th><th class="num">Thai</th><th class="num">Δ Thai pts [CI]</th><th class="num">p95</th><th class="num">$/call</th><th>Verdict</th></tr></thead><tbody>
      ${sh.arms.map((a) => `<tr><td>${e(a.name)}</td><td class="num">${pct(a.overall.mean)}</td><td class="num">${pct(a.thai.mean)}</td><td class="num">${a.diffThai ? `${(a.diffThai.mean * 100).toFixed(1)} [${(a.diffThai.lo * 100).toFixed(1)}, ${(a.diffThai.hi * 100).toFixed(1)}]` : '—'}</td><td class="num">${Math.round(a.p95ms)} ms</td><td class="num">${a.costPerCall.toFixed(5)}</td><td>${a.baseline ? '<span class="st info">baseline</span>' : chip(a.pass ? 'pass' : 'fail', a.pass ? 'pass' : `fail: ${a.why}`)}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">${sh.cases.golden} golden + ${sh.cases.replay} replayed production prompts, ${sh.cases.thai} Thai. Quality comes from the simulator, not the real referenced models.</p>`) : '<div class="empty">Run S3 or press “Run shadow eval” on F2.</div>';
  const can = cs?.canary;
  const canaryHtml = can ? `<div class="banner">${chip(can.status)} <b>${e(can.route)}</b> ${e(can.from.model)}@${e(can.from.effort)} → ${e(can.to.model)}@${e(can.to.effort)} <span class="muted">approved by ${e(can.approvedBy)}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Step</th><th>Status</th><th class="num">Canary acc (n)</th><th class="num">Control acc (n)</th><th class="num">Thai canary (n)</th></tr></thead><tbody>
      ${can.steps.map((x) => `<tr><td>${x.weight}%</td><td>${chip(x.status)}</td><td class="num">${pct(x.canary?.acc)} (${x.canary?.n ?? 0})</td><td class="num">${pct(x.control?.acc)} (${x.control?.n ?? 0})</td><td class="num">${pct(x.canary?.thAcc)} (${x.canary?.thN ?? 0})</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">no route canary yet</div>';
  const routes = Object.entries(c.routes).map(([k, r]) => `<tr><td><code>${e(k)}</code></td><td>${e(r.model)}@${e(r.effort)}</td><td>${r.canary ? `${e(r.canary.model)}@${e(r.canary.effort)} · ${r.canary.weight}%` : '—'}</td><td>${r.batch ? 'batch (50%)' : 'sync'}</td><td>${e(r.team)}</td></tr>`).join('');
  const seats = c.seats.map((x) => `<tr><td>${e(x.tool)}</td><td>${e(x.category)}</td><td class="num">${x.active_30d}/${x.seats}</td><td class="num">${usd(x.seats * x.monthly_price)}</td><td class="muted">${e(x.price_source)}</td></tr>`).join('');
  $('tab-cost').innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="label">AI run-rate</div><div class="value">${usd(c.monthlyRunRate)}/mo</div><div class="note">API ${usd(c.dailyApi)}/day (7-day) + seats ${usd(c.seatMonthly)} + infra ${usd(c.infraMonthly)}/mo</div></div>
      <div class="tile"><div class="label">API spend, last 30 days</div><div class="value">${usd(c.api30)}</div><div class="note">seeded history + live (weighted 1/${c.accel})</div></div>
      <div class="tile"><div class="label">Intent prompt-cache hit</div><div class="value">${intentLive ? pct(intentLive.cacheHitRate) : '—'}</div><div class="note">live, last 5 min · ${intentLive ? `${usd(intentLive.costPerCall)}/call` : ''}</div></div>
      <div class="tile"><div class="label">Intent online accuracy</div><div class="value">${intentLive?.accuracy != null ? pct(intentLive.accuracy) : '—'}</div><div class="note">judge = loadgen labels (simulated)</div></div>
      <div class="tile"><div class="label">LLM cost per resolved signal</div><div class="value">${outcome != null ? usd(outcome) : '—'}</div><div class="note">${c.outcomes.length} outcomes from the factory</div></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Daily API spend</h2><span class="sub">by workload · hover a day</span></header>${stackedBars(days, COST_SERIES)}</div>
      <div class="card"><header><h2>Spend by team (30 days)</h2></header>${hbars(c.byTeam.map((r) => ({ label: r.team || 'unknown', value: r.cost })))}
        <h4 style="margin:14px 0 6px">Per route, 7-day average</h4><div class="table-wrap"><table><tbody>${c.byRoute.map((r) => `<tr><td><code>${e(r.route)}</code></td><td class="num">${usd(r.perDay)}/day</td><td class="num">${Math.round(r.calls / 7).toLocaleString()} calls/day</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="card" style="margin-top:14px"><header><h2>Cost advisor</h2><span class="sub">${cs?.advisorRunAt ? `ran ${ago(cs.advisorRunAt)} · SQL over the ledger + BM25 over knowledge/ + decisions` : 'not run yet'}</span><span class="right"><button class="btn" data-cost="advisor">Run advisor</button></span></header>
      <div class="grid g2">${findings || '<div class="empty">Run S3 or the advisor.</div>'}</div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Shadow eval · assistant.intent</h2></header>${shadowHtml}</div>
      <div class="card"><header><h2>Swap proposal</h2>${cs?.report ? `<span class="right">${cs.report.candidate && !(can && can.status === 'running') ? `<button class="btn primary" data-cost="canary">Approve (L3) → start canary</button>` : ''}<a class="btn" href="/reports/${cs.report.id}.md" target="_blank">Markdown</a></span>` : ''}</header>
        ${cs?.report ? `<div class="md">${cs.report.html}</div>` : '<div class="empty">appears after the shadow eval</div>'}</div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Route canary</h2><span class="sub">25% → 50% → 100%, auto-revert on online accuracy drop</span></header>${canaryHtml}
        <h4 style="margin:14px 0 6px">Decisions (fed back into the advisor's knowledge)</h4>${(cs?.decisions || []).map((d) => `<div class="ev"><span class="t">${t(d.ts)}</span><span class="k">${e(d.id)}</span><span>${e(d.title)} ${chip(d.status)}</span></div>`).join('') || '<div class="muted small">none yet</div>'}</div>
      <div class="card"><header><h2>Gateway routes</h2></header><div class="table-wrap"><table><thead><tr><th>Route</th><th>Model</th><th>Canary</th><th>Pricing</th><th>Team</th></tr></thead><tbody>${routes}</tbody></table></div>
        <h4 style="margin:14px 0 6px">AI seats</h4><div class="table-wrap"><table><thead><tr><th>Tool</th><th>Category</th><th class="num">Active</th><th class="num">Monthly</th><th>Price source</th></tr></thead><tbody>${seats}</tbody></table></div>
        <p class="small muted">${e(c.pricingSource)}</p></div>
    </div>`;
}

// ---------------- bill & budgets ----------------
function budgetBar(b) {
  const W = 220, H = 12, max = Math.max(1.15, b.pct, b.projected ? b.projected / b.budget : 0);
  const x = (v) => (Math.min(v, max) / max) * W;
  const color = b.status === 'exceeded' ? 'var(--critical)' : b.status === 'warn' ? 'var(--warning)' : 'var(--s1)';
  const tipHtml = `<div class='tt'>${e(b.team)}</div><div class='tr'><span>Month to date</span><b>${usd(b.mtd)}</b></div><div class='tr'><span>Budget</span><b>${usd(b.budget)}</b></div>${b.projected ? `<div class='tr'><span>Projected month-end</span><b>${usd(b.projected)}</b></div>` : ''}${b.unrouted ? `<div class='tr'><span>of which found on bill</span><b>${usd(b.unrouted)}</b></div>` : ''}`;
  return `<svg viewBox="0 0 ${W} ${H + 8}" style="width:${W}px;max-width:100%;height:${H + 8}px;display:block" data-tip="${e(tipHtml)}">
    <rect x="0" y="4" width="${W}" height="${H}" rx="4" fill="var(--surface-2)"/>
    <rect x="0" y="4" width="${x(b.pct)}" height="${H}" rx="4" fill="${color}"/>
    <line x1="${x(1)}" x2="${x(1)}" y1="0" y2="${H + 8}" stroke="var(--ink-2)" stroke-width="2"/>
    ${b.projected ? `<line x1="${x(b.projected / b.budget)}" x2="${x(b.projected / b.budget)}" y1="2" y2="${H + 6}" stroke="var(--ink)" stroke-dasharray="2 2"/>` : ''}</svg>`;
}

function renderFinops() {
  const f = S.finops;
  if (!f) { $('tab-finops').innerHTML = '<div class="empty">loading…</div>'; return; }
  const r = f.recon, nb = f.notebook;
  const st = (s) => ({ ok: 'good', warn: 'warning', exceeded: 'critical' }[s] || 'info');
  const budgets = f.budgets.map((b) => `<tr><td><b>${e(b.team)}</b><div class="small muted">${e(b.why)}</div></td>
    <td class="num">${usd(b.mtd)}<div class="small muted">of ${usd(b.budget)}</div></td><td>${budgetBar(b)}<div class="small muted">${Math.round(b.pct * 100)}% used${b.projected ? ` · projected ${usd(b.projected)}` : ''}</div></td>
    <td><span class="st ${st(b.status)}">${e(b.status)}</span></td><td>${e(b.policy)}${b.blocked5m ? `<div class="small">${b.blocked5m} calls blocked (5 min)</div>` : ''}${b.degraded5m ? `<div class="small">${b.degraded5m} calls degraded (5 min)</div>` : ''}</td>
    <td>${b.status === 'exceeded' ? `<button class="btn" data-fin="raise" data-team="${e(b.team)}" data-usd="${Math.ceil((b.projected || b.mtd * 2) / 50) * 50}">Raise to ${usd(Math.ceil((b.projected || b.mtd * 2) / 50) * 50)} (L3)</button>` : ''}</td></tr>`).join('');
  const tiles = r ? [
    ['Provider bill (14 days + today)', usd(r.totals.provider), 'cost report = source of truth'],
    ['Gateway ledger (14 days + today)', usd(r.totals.ledger), `gateway key residual ≤ ${(r.maxResidualPct * 100).toFixed(2)}% per full day`],
    ['Gap', usd(r.totals.provider - r.totals.ledger), `${((r.totals.provider - r.totals.ledger) / r.totals.provider * 100).toFixed(1)}% · ${r.varianceDays} day(s) over 1%`],
    ['Unrouted keys', String(r.findings.filter((x) => x.status === 'active').length), r.findings.length ? `${usd(r.findings.reduce((a, x) => a + x.monthly, 0))}/month found` : 'none'],
    ['AI infra (cloud export)', `${usd(f.infra.monthly)}/mo`, `${f.infra.rows.length} components`],
  ] : [['Reconciliation', 'not run', 'press Reconcile or S4'], ['AI infra (cloud export)', `${usd(f.infra.monthly)}/mo`, `${f.infra.rows.length} components`]];
  const days = r ? r.days.map((d) => ({ label: d.partial ? 'today' : d.day.slice(5), full: `${d.day}${d.partial ? ' (partial, raw demo $)' : ''} · gap ${(d.pct * 100).toFixed(1)}% · ${d.status}`, values: { ledger: d.ledger, unrouted: Object.values(d.unrouted).reduce((a, b) => a + b, 0), other: Math.max(0, d.diff - Object.values(d.unrouted).reduce((a, b) => a + b, 0)) } })) : [];
  const keys = r ? r.findings.map((k) => `<tr><td><code>${e(k.apiKeyId)}</code><div class="small muted">${e(k.name)}</div></td><td>${e(k.workspace)}</td><td>${e(k.createdBy || '')}</td><td>${e(k.team)}</td><td>${e(k.firstSeen)}</td><td class="num">${usd(k.perDay)}/day<div class="small muted">${usd(k.monthly)}/month</div></td>
    <td>${k.status === 'active' ? `<button class="btn primary" data-fin="deactivate" data-key="${e(k.apiKeyId)}" title="Deactivate via admin API; the job must use the gateway">Deactivate (L2)</button>` : '<span class="st good">deactivated</span>'}</td></tr>`).join('') : '';
  const infra = f.infra.rows.map((x) => `<tr><td><b>${e(x.component)}</b><div class="small muted">${e(x.sku)}</div></td><td>${e(x.team)}</td><td class="num">${usd(x.per_day)}/day</td><td class="num">${usd(x.per_day * 30)}</td>
    <td><svg viewBox="0 0 100 8" preserveAspectRatio="none" style="width:90px;height:8px;display:inline-block;vertical-align:middle" data-tip="${e(`<div class='tt'>${x.component}</div>avg utilization ${Math.round(x.util * 100)}% (monitoring)`)}"><rect width="100" height="8" rx="4" fill="var(--surface-2)"/><rect width="${Math.max(2, x.util * 100)}" height="8" rx="4" fill="${x.util < 0.1 ? 'var(--serious)' : 'var(--s3)'}"/></svg> ${Math.round(x.util * 100)}%${x.util < 0.1 && x.per_day > 5 ? ' <span class="st serious">idle</span>' : ''}</td></tr>`).join('');
  $('tab-finops').innerHTML = `
    <div class="tiles">${tiles.map(([l, v, n]) => `<div class="tile"><div class="label">${e(l)}</div><div class="value">${v}</div><div class="note">${e(n)}</div></div>`).join('')}</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Bill vs ledger, per day</h2><span class="sub">bar height = provider bill</span><span class="right"><button class="btn" data-fin="reconcile">Reconcile now</button></span></header>
        ${r ? stackedBars(days, [{ key: 'ledger', label: 'In ledger (via gateway)', color: 'var(--s1)' }, { key: 'unrouted', label: 'Only on the bill (unrouted keys)', color: 'var(--s5)' }, { key: 'other', label: 'Other gap', color: 'var(--s4)' }], { height: 200 }) : '<div class="empty">Run S4 or “Reconcile now”: pulls the provider cost + usage reports and compares them with the ledger.</div>'}</div>
      <div class="card"><header><h2>Team budgets (this month)</h2><span class="sub">gateway enforces · warn at ${Math.round((f.warnAt || 0.8) * 100)}% · solid line = budget, dashed = projected</span></header>
        <div class="table-wrap"><table><thead><tr><th>Team</th><th class="num">MTD</th><th>Used</th><th>Status</th><th>On 100%</th><th></th></tr></thead><tbody>${budgets}</tbody></table></div></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><header><h2>Provider keys outside the gateway</h2><span class="sub">from the usage report grouped by api_key_id</span></header>
        ${keys ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>Workspace</th><th>Created by</th><th>Owner</th><th>First seen</th><th class="num">Spend</th><th></th></tr></thead><tbody>${keys}</tbody></table></div>` : '<div class="empty">none found yet</div>'}
        <h4 style="margin:14px 0 6px">Data-team notebook (live)</h4>
        ${nb ? `<div class="banner">${nb.mode === 'direct' ? '<span class="st serious">direct to provider — bypassing gateway</span>' : nb.lastStatus === 429 ? '<span class="st critical">via gateway — blocked by budget</span>' : '<span class="st good">via gateway</span>'}
          <span class="small">${nb.sent} calls · ${nb.ok} ok · ${nb.blocked} blocked${nb.lastError ? ` · <span class="muted">${e(nb.lastError)}</span>` : ''}</span></div>` : '<div class="muted small">not reporting</div>'}
        <h4 style="margin:14px 0 6px">FinOps decisions</h4>${f.decisions.map((d) => `<div class="ev"><span class="t">${t(d.ts)}</span><span class="k">${e(d.id)}</span><span>${e(d.title)} ${chip('done', d.status)}</span></div>`).join('') || '<div class="muted small">none yet</div>'}</div>
      <div class="card"><header><h2>AI infrastructure</h2><span class="sub">cloud billing export (7-day avg) + monitoring utilization</span></header>
        <div class="table-wrap"><table><thead><tr><th>Component</th><th>Team</th><th class="num">Cost</th><th class="num">Monthly</th><th>Utilization</th></tr></thead><tbody>${infra}</tbody></table></div></div>
    </div>
    ${r ? `<div class="card" style="margin-top:14px"><header><h2>Reconciliation report</h2><span class="right"><a class="btn" href="/reports/${e(r.id)}.md" target="_blank">Markdown</a></span></header><div class="md">${r.html}</div></div>` : ''}`;
}

// ---------------- diagrams / about ----------------
const DIAGRAMS = [['full-factory.html', 'Full factory'], ['01-factory.html', 'Factory + additions'], ['02-self-healing.html', 'Self-healing sequence'], ['03-rollback.html', 'Auto-rollback sequence'], ['04-ai-cost.html', 'AI cost loop']];
function renderDiagrams() {
  $('tab-diagrams').innerHTML = `<div class="actions" style="margin:0 0 10px">${DIAGRAMS.map(([f, l]) => `<button class="btn ${S.diagram === f ? 'primary' : ''}" data-diagram="${f}">${l}</button>`).join('')}<a class="btn" href="/diagrams/${S.diagram}" target="_blank">Open full page</a></div>
    <iframe class="diagram" src="/diagrams/${S.diagram}" title="architecture diagram"></iframe>`;
}
function renderAbout() {
  $('tab-about').innerHTML = `<div class="grid g2">
    <div class="card"><header><h2>Real in this demo</h2></header><ul>
      <li>9 processes, real HTTP between them, trace ids propagated on every hop</li>
      <li>Per-site manifests; services hot-load the version file each site runs</li>
      <li>Spans, 2-second metric buckets, two-proportion z-test canary gates</li>
      <li>Culprit scoring from traces + release notes; consumer-first rollback</li>
      <li>Git repo per run (<code>runtime/workspace</code>), worktree per work item, real commits and merges</li>
      <li><code>node --test</code> runs: failing regression test before the fix, passing after</li>
      <li>Golden-set evals incl. Thai slice; policy, secret scan</li>
      <li>SQLite cost ledger with real SQL; BM25 retrieval over <code>knowledge/</code>; bootstrap CIs</li>
      <li>Bill reconciliation through admin endpoints (usage report by API key, cost report by day); budget enforcement in the gateway (429 / degrade)</li>
      <li>Prompt-cache semantics (prefix match, minimum size) and token-based pricing</li>
    </ul></div>
    <div class="card"><header><h2>Simulated</h2></header><ul>
      <li>Model outputs and quality (<code>platform/llm/sim-llm.mjs</code>); the small tier is weaker in Thai by design</li>
      <li>Build agent patches come from a patch library; real mode would run Claude Code headless</li>
      <li>LINE / Slack are local webhooks; outbound LINE replies are logged, not sent</li>
      <li>Online-eval judge uses loadgen ground-truth labels</li>
      <li>30 days of seeded cost history; seat prices are examples</li>
      <li>The provider bill and its admin API are simulated (endpoint shapes modeled on Anthropic's Usage &amp; Cost Admin API); the data-team notebook and the cloud billing export are simulated</li>
      <li>Live traffic runs ${S.cost?.accel || 12}× faster than modeled production; ledger rows are weighted to compensate</li>
    </ul><p class="small muted">Prices: ${e(S.cost?.pricingSource || '')}</p></div></div>`;
}

// ---------------- events / refresh ----------------
function render() {
  renderPills();
  if (S.tab === 'overview') renderOverview();
  if (S.tab === 'factory') renderFactory();
  if (S.tab === 'fleet') renderFleet();
  if (S.tab === 'incidents') renderIncidents();
  if (S.tab === 'cost') renderCost();
  if (S.tab === 'finops') renderFinops();
}

async function refresh() {
  try {
    S.state = await api('/api/state');
    if (S.selWI) S.wi = await api(`/api/workitems/${S.selWI}`);
    if (S.selInc) S.inc = await api(`/api/incidents/${S.selInc}`);
    else if (S.state.incidents[0] && S.tab === 'incidents') { S.selInc = S.state.incidents[0].id; S.inc = await api(`/api/incidents/${S.selInc}`); }
    if (!S.log.length) S.log = S.state.log;
    render();
  } catch (err) { console.warn(err); }
}
async function refreshMetrics() { try { S.metrics = await api('/api/metrics'); if (S.tab === 'overview' || S.tab === 'fleet') render(); } catch {} }
async function refreshCost() {
  if (!['cost', 'overview', 'about', 'finops'].includes(S.tab) && S.cost) return;
  try {
    [S.cost, S.costState, S.finops] = await Promise.all([api('/api/cost/summary'), api('/api/cost/state'), api('/api/finops')]);
    const alerts = S.finops.budgets.filter((b) => b.status !== 'ok').length + (S.finops.recon?.findings.filter((k) => k.status === 'active').length || 0);
    $('c-finops').textContent = alerts ? ` ${alerts}` : '';
    if (S.tab === 'cost' || S.tab === 'finops') render();
  } catch {}
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('button, [data-wi], [data-cluster], [data-inc]');
  if (!el) return;
  const d = el.dataset;
  if (d.tab) { S.tab = d.tab; document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab)); document.querySelectorAll('main > section').forEach((x) => x.classList.toggle('hidden', x.id !== `tab-${S.tab}`)); if (S.tab === 'diagrams') renderDiagrams(); if (S.tab === 'about') renderAbout(); await refreshCost(); render(); return; }
  if (d.run) { el.disabled = true; await api(`/api/scenarios/${d.run}/run`, {}); return refresh(); }
  if (d.triage) { ev.stopPropagation(); const r = await api(`/api/clusters/${d.triage}/triage`, {}); S.selWI = r.workItem; return refresh(); }
  if (d.approve) { await api(`/api/workitems/${d.approve}/approve`, { who: 'engineer (UI)' }); return refresh(); }
  if (d.cost) {
    const c = S.costState;
    if (d.cost === 'advisor') await api('/api/cost/advisor', {});
    if (d.cost === 'fix') await api('/api/cost/findings/F1/fix', {});
    if (d.cost === 'batch') await api('/api/cost/findings/F3/apply', {});
    if (d.cost === 'shadow') await api('/api/cost/shadow', {});
    if (d.cost === 'canary' && c?.report?.candidate) await api('/api/cost/canary', { model: c.report.candidate.model, effort: c.report.candidate.effort, approvedBy: 'team-guest-ai (UI)' });
    S.cost = null; return refreshCost();
  }
  if (d.fin) {
    el.disabled = true;
    if (d.fin === 'reconcile') await api('/api/finops/reconcile', { actor: 'finops (UI)' });
    if (d.fin === 'deactivate') await api(`/api/finops/keys/${d.key}/deactivate`, { approvedBy: 'engineer (UI)' });
    if (d.fin === 'raise') await api(`/api/finops/budgets/${d.team}/raise`, { monthlyUsd: Number(d.usd), approvedBy: `${d.team} owner (UI)` });
    S.cost = null; return refreshCost();
  }
  if (d.diagram) { S.diagram = d.diagram; return renderDiagrams(); }
  if (d.wi) { S.selWI = d.wi; S.tab = 'factory'; document.querySelector('[data-tab="factory"]').click(); return refresh(); }
  if (d.cluster && !d.triage) { S.tab = 'factory'; document.querySelector('[data-tab="factory"]').click(); return; }
  if (d.inc) { S.selInc = d.inc; S.inc = await api(`/api/incidents/${d.inc}`); return render(); }
});
$('retry-r2').onclick = () => api('/api/releases', { name: '2026.11-r2 (retry)', services: { 'rooms-svc': '2.4.0', 'guest-assistant': '3.1.0' }, level: 'L3', actor: 'release-eng (UI)' }).then(refresh);

const es = new EventSource('/events');
let pending = null;
const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; refresh(); }, 400); };
es.addEventListener('log', (m) => { const ev = JSON.parse(m.data); if (!S.log.find((x) => x.id === ev.id)) { S.log.push(ev); if (S.log.length > 300) S.log.shift(); } if (S.tab === 'overview') renderOverview(); });
for (const k of ['workitem', 'release', 'incident', 'signal', 'freeze', 'manifest']) es.addEventListener(k, soon);
es.addEventListener('cost', () => { S.cost = null; refreshCost(); });
es.addEventListener('finops', () => { S.cost = null; refreshCost(); });

refresh(); refreshMetrics(); refreshCost();
setInterval(refresh, 3000);
setInterval(refreshMetrics, 3000);
setInterval(refreshCost, 5000);
