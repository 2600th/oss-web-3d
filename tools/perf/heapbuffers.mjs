// The largest ArrayBuffer backing stores in a .heapsnapshot and a short
// retainer chain for each (who keeps the memory alive).
//   node tools/perf/heapbuffers.mjs file.heapsnapshot [top=30]
import fs from 'node:fs';

const file = process.argv[2];
const top = Number(process.argv[3] ?? 30);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const meta = snap.snapshot.meta;
const F = meta.node_fields;
const N = F.length;
const E = meta.edge_fields.length;
const types = meta.node_types[0];
const etypes = meta.edge_types[0];
const iType = F.indexOf('type');
const iName = F.indexOf('name');
const iSize = F.indexOf('self_size');
const iEdges = F.indexOf('edge_count');
const { nodes, edges, strings } = snap;
const count = nodes.length / N;
// reverse edges: for every node, the list of (from node, edge name)
const firstEdge = new Uint32Array(count + 1);
for (let n = 0, e = 0; n < count; n++) { firstEdge[n] = e; e += nodes[n * N + iEdges] * E; }
firstEdge[count] = edges.length;
const rev = new Map();
const want = [];
for (let n = 0; n < count; n++) {
  if (strings[nodes[n * N + iName]] === 'system / JSArrayBufferData') want.push(n);
}
want.sort((a, b) => nodes[b * N + iSize] - nodes[a * N + iSize]);
const targets = new Set(want.slice(0, top));
// walk retainers up to 4 levels for the top buffers
let frontier = new Set(targets);
const parents = new Map();
for (let depth = 0; depth < 5; depth++) {
  const next = new Set();
  for (let n = 0; n < count; n++) {
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += E) {
      const to = edges[e + 2] / N;
      if (!frontier.has(to)) continue;
      const et = etypes[edges[e]];
      if (et === 'weak') continue;
      const nameOrIdx = edges[e + 1];
      const ename = et === 'element' || et === 'hidden' ? `[${nameOrIdx}]` : strings[nameOrIdx];
      if (!parents.has(to)) parents.set(to, []);
      const list = parents.get(to);
      if (list.length < 2) { list.push([n, ename]); next.add(n); }
    }
  }
  frontier = next;
}
const label = (n) => `${types[nodes[n * N + iType]]}:${strings[nodes[n * N + iName]].slice(0, 50)}`;
const chain = (n, d = 0) => {
  if (d > 4) return '';
  const p = parents.get(n)?.[0];
  if (!p) return '';
  return ` <- ${p[1]} of ${label(p[0])}` + chain(p[0], d + 1);
};
let sum = 0;
for (const n of want) sum += nodes[n * N + iSize];
console.log(`${want.length} ArrayBuffer stores, ${(sum / 1048576).toFixed(1)} MB`);
for (const n of want.slice(0, top)) {
  console.log(`${(nodes[n * N + iSize] / 1048576).toFixed(2).padStart(8)} MB${chain(n)}`);
}
