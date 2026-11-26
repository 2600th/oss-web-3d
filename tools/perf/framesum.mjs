// One line per frame.js result file: overall = CPU ms per frame + GPU ms.
//   node tools/perf/framesum.mjs a.json [b.json ...]
import fs from 'node:fs';

const rows = process.argv.slice(2).map((file) => {
  const txt = fs.readFileSync(file, 'utf8');
  const r = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return { file: file.replace(/^.*[\/]/, '').replace(/\.json$/, ''), ...r };
});
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
for (const r of rows) {
  console.log(`${r.file.padEnd(22)} ${r.scenario.padEnd(7)} overall ${r.overall.toFixed(3)}  cpu ${r.cpu.frame.toFixed(3)} (upd ${r.cpu.update} rnd ${r.cpu.render} tail ${r.cpu.tail} async ${r.cpu.async})  gpu ${r.gpu.total}  p95 ${r.interval.p95}  draws ${r.draws} passes ${r.passes}`);
}
if (rows.length > 1) console.log(`${'median'.padEnd(30)} overall ${med(rows.map((r) => r.overall)).toFixed(3)}  cpu ${med(rows.map((r) => r.cpu.frame)).toFixed(3)}  gpu ${med(rows.map((r) => r.gpu.total)).toFixed(3)}`);
