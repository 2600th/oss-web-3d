// Perf regression gate: compare bench.js results against a baseline set and
// the frame budgets; exit 1 on a regression.
//   node tools/perf/regress.mjs <dir> <newPrefix> [basePrefix=after] [tolerance=0.25]
// Files are <prefix>-<tier>-<res>.json as written by bench.js (see README).
// A row regresses when its GPU total exceeds base * (1 + tolerance) + 0.15 ms
// (timestamps are quantised to ~0.07-0.1 ms in Chrome, so tiny totals need an
// absolute slack), or when it breaks the hard budget below.
import fs from 'node:fs';
import path from 'node:path';

const [dir = 'docs/v2/evidence/polish-perf/raw', prefix = 'new', base = 'after', tolArg] = process.argv.slice(2);
const tol = Number(tolArg ?? 0.25);
// Hard budgets, GPU ms on the reference machine (RTX 5090). The brief's target
// is high <= 8 ms at 1440p; we sit near 1.3 ms, so these are set to catch a
// 3-4x blow-up long before a mid-range GPU would feel it.
const BUDGET = { low: 2.5, medium: 3.5, high: 4.5, ultra: 6 };

const read = (f) => {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
};
const set = (p) => {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const m = new RegExp(`^${p}-(low|medium|high|ultra)-(\\d+)\\.json$`).exec(f);
    if (m) out[`${m[1]}-${m[2]}`] = { tier: m[1], j: read(f) };
  }
  return out;
};
const now = set(prefix);
const was = set(base);
if (!Object.keys(now).length) { console.error(`no ${prefix}-*.json in ${dir}`); process.exit(2); }
let bad = 0;
for (const [k, { tier, j }] of Object.entries(now)) {
  const b = was[k]?.j;
  const limit = b ? b.total * (1 + tol) + 0.15 : Infinity;
  const over = j.total > limit;
  const budget = j.total > BUDGET[tier];
  if (over || budget) bad++;
  const worst = b ? Object.entries(j.cats).map(([c, v]) => [c, v - (b.cats[c] ?? 0)]).sort((x, y) => y[1] - x[1])[0] : null;
  console.log(`${(over || budget) ? 'FAIL' : 'ok  '} ${k.padEnd(12)} ${j.total.toFixed(2)} ms` +
    (b ? ` (base ${b.total.toFixed(2)}, limit ${limit.toFixed(2)})` : ' (no base)') +
    (budget ? ` over ${tier} budget ${BUDGET[tier]} ms` : '') +
    (over && worst ? `; largest growth: ${worst[0]} +${worst[1].toFixed(2)} ms` : ''));
}
process.exit(bad ? 1 : 0);
