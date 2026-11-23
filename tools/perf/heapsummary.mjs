// Summarise a V8 .heapsnapshot (e.g. from the chrome-devtools MCP
// take_heapsnapshot, which runs a full GC first): total self size and the
// largest groups by node type / constructor name.
//   node tools/perf/heapsummary.mjs file.heapsnapshot [top=25]
import fs from 'node:fs';

const file = process.argv[2];
const top = Number(process.argv[3] ?? 25);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const meta = snap.snapshot.meta;
const F = meta.node_fields;
const N = F.length;
const types = meta.node_types[0];
const iType = F.indexOf('type');
const iName = F.indexOf('name');
const iSize = F.indexOf('self_size');
const nodes = snap.nodes;
const strings = snap.strings;
const groups = new Map();
let total = 0;
for (let i = 0; i < nodes.length; i += N) {
  const type = types[nodes[i + iType]];
  const size = nodes[i + iSize];
  total += size;
  let name = strings[nodes[i + iName]];
  if (type === 'string' || type === 'concatenated string' || type === 'sliced string') name = '(string)';
  else if (type === 'code') name = '(code)';
  else if (type === 'array') name = '(array) ' + (name.length > 40 ? name.slice(0, 40) : name);
  const key = `${type}: ${name}`;
  const g = groups.get(key) ?? { n: 0, size: 0 };
  g.n++;
  g.size += size;
  groups.set(key, g);
}
const mb = (b) => (b / 1048576).toFixed(1);
console.log(`total self size ${mb(total)} MB, ${nodes.length / N} nodes`);
for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, top)) {
  console.log(`${mb(g.size).padStart(8)} MB  ${String(g.n).padStart(8)}  ${k}`);
}
