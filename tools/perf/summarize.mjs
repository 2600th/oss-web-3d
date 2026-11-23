// Summarise bench.js results saved by the chrome-devtools MCP
// (evaluate_script with filePath) into a markdown table.
//   node tools/perf/summarize.mjs <dir> [prefix]
// Files are named <prefix>-<tier>-<res>.json, e.g. before-high-1440.json.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? '.';
const prefix = process.argv[3] ?? '';
const CATS = ['shadow', 'scene', 'sky/AP', 'clouds', 'vfx', 'post', 'other'];
const TIERS = ['low', 'medium', 'high', 'ultra'];

const read = (f) => {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(a, b + 1));
};

const rows = [];
for (const f of fs.readdirSync(dir)) {
  const m = new RegExp(`^${prefix}-?(low|medium|high|ultra)-(\\d+)\\.json$`).exec(f);
  if (!m) continue;
  rows.push({ tier: m[1], res: m[2], j: read(f) });
}
rows.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.res - b.res);
const out = [];
out.push(`| tier | canvas | GPU ms (timestamps) | ${CATS.join(' | ')} | passes | draws | tris | flush ms/frame | CPU ms/frame |`);
out.push(`|---|---|---|${CATS.map(() => '---').join('|')}|---|---|---|---|---|`);
for (const { tier, j } of rows) {
  const c = (k) => (j.cats[k] ?? 0).toFixed(2);
  out.push(`| ${tier} | ${j.canvas.join('x')} | **${j.total.toFixed(2)}** | ${CATS.map(c).join(' | ')} | ${j.passes ?? ''} | ${j.drawCalls ?? ''} | ${j.triangles ? (j.triangles / 1e6).toFixed(2) + 'M' : ''} | ${j.wallMs?.toFixed(2) ?? ''} | ${j.cpuMs?.toFixed(2) ?? ''} |`);
}
console.log(out.join('\n'));
