// The product repo the agents work in: runtime/workspace (git, main branch = what services load).
// Each work item gets its own git worktree + branch; merge to main happens only after approval.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let WS, WT;
const GIT_ID = ['-c', 'user.name=factory-bot', '-c', 'user.email=factory-bot@hotelgrid.invalid', '-c', 'commit.gpgsign=false'];

export function init({ workspace, runtime }) { WS = workspace; WT = path.join(runtime, 'worktrees'); fs.mkdirSync(WT, { recursive: true }); }

export const git = (cwd, ...args) => execFileSync('git', [...GIT_ID, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '');

export function createWorktree(branch) {
  const dir = path.join(WT, branch.replace(/[^\w.-]/g, '_'));
  if (fs.existsSync(dir)) { try { git(WS, 'worktree', 'remove', '--force', dir); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
  try { git(WS, 'branch', '-D', branch); } catch {}
  git(WS, 'worktree', 'add', '-b', branch, dir, 'main');
  return dir;
}

export const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
export function write(dir, rel, content) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
export const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

export function nextPatchVersion(dir, svc, base) {
  const m = base.match(/^(\d+)\.(\d+)\.(\d+)/);
  let patch = Number(m[3]) + 1;
  while (exists(dir, `services/${svc}/versions/${m[1]}.${m[2]}.${patch}.mjs`) || exists(WS, `services/${svc}/versions/${m[1]}.${m[2]}.${patch}.mjs`)) patch++;
  return `${m[1]}.${m[2]}.${patch}`;
}

// Applies find/replace edits to the base version and writes a new version file with bumped meta.
export function createVersion(dir, svc, base, newVer, edits, change) {
  let src = read(dir, `services/${svc}/versions/${base}.mjs`);
  for (const e of edits) {
    if (!src.includes(e.find)) throw new Error(`edit anchor not found in ${svc}@${base}: ${e.find.slice(0, 60)}`);
    src = src.replace(e.find, e.replace);
  }
  src = src.replace(new RegExp(`(// ${svc}) ${base.replace(/\./g, '\\.')}`), `$1 ${newVer}`);
  src = src.replace(`version: '${base}'`, `version: '${newVer}'`);
  src = src.replace(/released: '[^']+'/, `released: '${new Date().toISOString().slice(0, 10)}'`);
  src = src.replace(/changes: \[/, `changes: ['${change.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', `);
  src = src.replace(/\n {2}prerelease: true,/, '');
  write(dir, `services/${svc}/versions/${newVer}.mjs`, src);
  return `services/${svc}/versions/${newVer}.mjs`;
}

export function diffFiles(dir, a, b) {
  try { return execFileSync('git', ['diff', '--no-index', '--no-color', a, b], { cwd: dir, encoding: 'utf8' }); }
  catch (e) { return e.stdout || ''; } // exit 1 when files differ
}

export function runTests(dir, svc, ver) {
  return new Promise((resolve) => {
    const testDir = path.join(dir, 'services', svc, 'test');
    const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(testDir, f));
    const started = Date.now();
    const p = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd: dir, env: { PATH: process.env.PATH, VERSION_FILE: path.join(dir, 'services', svc, 'versions', `${ver}.mjs`) },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] || 0);
      const failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((t) => !t.includes('/'));
      resolve({ ok: code === 0, pass: num('pass'), fail: num('fail'), failures, ms: Date.now() - started, files: files.map((f) => path.relative(dir, f)), tail: out.split('\n').filter((l) => /^(ok|not ok|# )/.test(l)).slice(-14).join('\n') });
    });
  });
}

export async function loadModule(dir, svc, ver) {
  const f = path.join(dir, 'services', svc, 'versions', `${ver}.mjs`);
  return import(`${pathToFileURL(f).href}?t=${fs.statSync(f).mtimeMs}-${Math.random()}`);
}

export async function goldenHvac(dir, ver) {
  const mod = await loadModule(dir, 'hvac-optimizer', ver);
  const cases = read(dir, 'evals/golden/hvac-setpoint.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  const failures = [];
  for (const c of cases) {
    const got = mod.computeSetpoint(mod.parseRoom ? mod.parseRoom({ id: 'x', ...c.room }) : c.room, c.requested, c.site).effective;
    if (got !== c.expect) failures.push({ id: c.id, expect: c.expect, got });
  }
  return { total: cases.length, passed: cases.length - failures.length, failures };
}

export function appendJsonl(dir, rel, rows) {
  if (!rows?.length) return;
  fs.appendFileSync(path.join(dir, rel), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function commit(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

export function mergeToMain(branch, message) {
  git(WS, 'merge', '--no-ff', '-q', '-m', message, branch);
  return git(WS, 'rev-parse', '--short', 'HEAD');
}

export function removeWorktree(dir) { try { git(WS, 'worktree', 'remove', '--force', dir); } catch {} }

export const log = (n = 15) => git(WS, 'log', '--oneline', '--graph', `-${n}`);
