// CPU profile summary from a Chrome trace (chrome-devtools MCP
// `performance_stop_trace({ filePath })`, or DevTools > Performance > save).
// Prints the functions with the most self time and the most inclusive time on
// the busiest thread, in ms per second of trace and as a share of samples.
//   node tools/perf/traceprofile.mjs trace.json [top=40] [filter=substring of url]
import fs from 'node:fs';
import zlib from 'node:zlib';

const [file, topArg, filter] = process.argv.slice(2);
const top = Number(topArg ?? 40);
let raw = fs.readFileSync(file);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
const json = JSON.parse(raw.toString('utf8'));
const events = Array.isArray(json) ? json : json.traceEvents;

// one profile per (pid, id); keep the one with the most samples
const profiles = new Map();
for (const e of events) {
  if (e.name !== 'ProfileChunk') continue;
  const key = `${e.pid}:${e.id}`;
  let p = profiles.get(key);
  if (!p) profiles.set(key, p = { nodes: new Map(), samples: [], deltas: [] });
  const cp = e.args?.data?.cpuProfile;
  for (const n of cp?.nodes ?? []) p.nodes.set(n.id, n);
  if (cp?.samples) { p.samples.push(...cp.samples); p.deltas.push(...(e.args.data.timeDeltas ?? [])); }
}
const prof = [...profiles.values()].sort((a, b) => b.samples.length - a.samples.length)[0];
if (!prof) { console.error('no CPU profile in this trace'); process.exit(1); }

const name = (n) => {
  const c = n.callFrame;
  const url = (c.url ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
  return `${c.functionName || '(anonymous)'}  ${url}${c.lineNumber >= 0 ? ':' + (c.lineNumber + 1) : ''}`;
};
const self = new Map();
const incl = new Map();
let total = 0;
let idle = 0;
for (let i = 0; i < prof.samples.length; i++) {
  const dt = (prof.deltas[i] ?? 0) / 1000;
  const leaf = prof.nodes.get(prof.samples[i]);
  if (!leaf) continue;
  total += dt;
  const fn = leaf.callFrame.functionName;
  if (fn === '(idle)' || fn === '(program)' || fn === '(root)') { idle += dt; continue; }
  self.set(name(leaf), (self.get(name(leaf)) ?? 0) + dt);
  const seen = new Set();
  for (let n = leaf; n; n = prof.nodes.get(n.parent)) {
    const k = name(n);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + dt);
  }
}
const busy = total - idle;
const show = (title, m) => {
  console.log(`\n${title}`);
  const rows = [...m.entries()].filter(([k]) => !filter || k.includes(filter)).sort((a, b) => b[1] - a[1]).slice(0, top);
  for (const [k, v] of rows) console.log(`${(v / total * 1000).toFixed(1).padStart(7)} ms/s ${(v / busy * 100).toFixed(1).padStart(5)} %  ${k}`);
};
console.log(`trace ${(total / 1000).toFixed(2)} s, scripting ${(busy / total * 100).toFixed(1)} % of it (${(busy / total * 1000).toFixed(0)} ms/s)`);
show('self time', self);
show('inclusive time', incl);
