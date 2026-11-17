// Writes go/testdata/node-vectors.json: outputs of the Node helpers that the Go ports must reproduce exactly.
//   node scripts/go-parity-vectors.mjs      (re-run after changing a shared helper; Go tests read the file)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mdToHtml } from '../platform/lib/markdown.mjs';
import { percentile, twoPropZ } from '../platform/lib/stats.mjs';
import { mulberry32, hash01 } from '../platform/lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = `# INC-1 — 2026.11-r2 rolled back at bkk-pilot

**Status:** mitigated · **Release:** REL-2 (rooms-svc@2.4.0, guest-assistant@3.1.0) · **Deploy freeze:** on

## Summary
Canary analysis tripped in 7s; reverted guest-assistant then rooms-svc (consumers first) & <checked>.

| Candidate | Changed | Score | Evidence |
|---|---|---|---|
| rooms-svc@2.4.0 | yes | **0.95** | release note says \`occupancy\` changed; errors mention "occupancy" |
| hvac-optimizer | no | **0.35** | not changed in this release |

> LINE · room 1204: แอร์ไม่เย็น ตั้ง 22 แต่ยังขึ้น 25

- 10:00:01 Deploy freeze on — no new rollouts
  - nested item with [a link](https://example.invalid/x)
1. Fix task: make hvac-optimizer accept the \`occupancyStatus\` contract.
2. Turn on the **manifest parity gate**.

\`\`\`
GET /v1/organizations/cost_report?group_by[]=workspace_id <raw>
\`\`\`
#### Small heading
plain paragraph with **bold** and \`code\`
`;
const rng = mulberry32(42);
const vectors = {
  markdown: { input: md, html: mdToHtml(md) },
  percentile: [[[1, 2, 3, 4, 100], 80], [[5], 95], [[], 95], [[3, 1, 2, 9, 7, 7, 4, 8, 6, 5], 95], [[0.5, 12.25, 3.75], 50]].map(([v, p]) => ({ values: v, p, out: percentile(v, p) })),
  twoPropZ: [[2, 400, 30, 120], [4, 400, 1, 100], [0, 50, 0, 50], [0, 50, 3, 20], [0, 0, 1, 10]].map(([a, b, c, d]) => ({ in: [a, b, c, d], z: twoPropZ(a, b, c, d).z })),
  mulberry32: { seed: 42, out: Array.from({ length: 8 }, () => rng()) },
  hash01: ['abc|assistant.intent', 't-123|factory.build', ''].map((s) => ({ in: s, out: hash01(s) })),
};
fs.mkdirSync(path.join(ROOT, 'go/testdata'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'go/testdata/node-vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log('wrote go/testdata/node-vectors.json');
