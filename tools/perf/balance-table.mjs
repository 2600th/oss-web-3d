// Markdown tables from balance.js records:
//   node tools/perf/balance-table.mjs runs.json [more.json ...] [--tag after]
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const ti = args.indexOf('--tag');
const tag = ti >= 0 ? args.splice(ti, 2)[1] : null;
const runs = args.flatMap((f) => JSON.parse(readFileSync(f, 'utf8'))).filter((r) => !tag || r.tag === tag);
const by = {};
for (const r of runs) (by[`${r.id}/${r.difficulty}${r.variant ? '/' + r.variant : ''}`] ??= []).push(r);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : '-');
const med = (a) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log('| Sortie / level | Runs | Wins | Win time (median) | Damage taken (mean, all runs) | Min HP (median) | Last phase reached | Failures |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [k, rs] of Object.entries(by)) {
  const wins = rs.filter((r) => r.outcome === 'win');
  const dmg = rs.map((r) => Object.values(r.damage).reduce((a, b) => a + b, 0));
  const fails = {};
  for (const r of rs) if (r.outcome !== 'win') { const c = (r.death ?? r.outcome).replace(/ at .*/, '').replace(/crashed \(.*\)/, 'crashed'); fails[c] = (fails[c] ?? 0) + 1; }
  const last = {};
  for (const r of rs) { const p = (r.phases.at(-1) ?? '-').split('@')[0]; last[p] = (last[p] ?? 0) + 1; }
  console.log(`| ${k} | ${rs.length} | ${wins.length} (${Math.round((100 * wins.length) / rs.length)}%) | ${med(wins.map((r) => r.time))} s | ${avg(dmg)} | ${med(rs.map((r) => r.ex?.minHp ?? r.hp))} | ${Object.entries(last).map(([p, n]) => `${p} x${n}`).join(', ')} | ${Object.entries(fails).map(([c, n]) => `${c} x${n}`).join(', ') || 'none'} |`);
}
console.log();
// damage sources
console.log('| Sortie / level | Damage per run by source | Hostile missiles fired / hit / decoyed | Phase start times (median) |');
console.log('| --- | --- | --- | --- |');
for (const [k, rs] of Object.entries(by)) {
  const dmg = {};
  for (const r of rs) for (const [s, v] of Object.entries(r.damage)) dmg[s] = (dmg[s] ?? 0) + v / rs.length;
  const inb = { fired: 0, hit: 0, decoyed: 0 };
  for (const r of rs) for (const v of Object.values(r.inbound)) for (const f of Object.keys(inb)) inb[f] += v[f];
  const ph = {};
  for (const r of rs) for (const p of r.phases) { const [id, t] = p.split('@'); (ph[id] ??= []).push(+t); }
  console.log(`| ${k} | ${Object.entries(dmg).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${Math.round(v)}`).join(', ')} | ${inb.fired} / ${inb.hit} / ${inb.decoyed} | ${Object.entries(ph).map(([id, ts]) => `${id} ${med(ts)}`).join(', ')} |`);
}
console.log();
// night specifics
const night = Object.entries(by).filter(([k]) => k.startsWith('night'));
if (night.length) {
  console.log('| Sortie / level | First truck down (median s) | Trucks escaped (mean) | Air kills needed | Kills (mean) |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [k, rs] of night) {
    const first = rs.map((r) => r.ex?.kills.find((x) => x.startsWith('T'))).filter(Boolean).map((x) => +x.split('@')[1]);
    console.log(`| ${k} | ${med(first)} | ${(rs.reduce((a, r) => a + (r.ex?.arrived ?? 0), 0) / rs.length).toFixed(1)} | ${rs[0].airTotal ?? '-'} | ${avg(rs.map((r) => r.kills))} |`);
  }
}
