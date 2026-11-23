// "STP1" terrain pack writer (and a node reader for tools and tests).
//
// One file holding several 2D planes, each deflate-compressed on its own so the
// browser can inflate them with DecompressionStream and node with zlib.
//
//   bytes 0..3   'STP1'
//   bytes 4..7   uint32 LE header length H
//   bytes 8..8+H UTF-8 JSON header { ...meta, planes: [{name,w,h,enc,offset,length}] }
//   then         plane payloads (offset is relative to the end of the header)
//
// Encodings (decoders live in src/world/terrain/pack.js, shared with the browser)
//   raw8     bytes as they are
//   delta8   left-neighbour delta per row (smooth 8-bit fields)
//   delta16  uint16, plane predictor (left + up - upleft), zigzag residual, all
//            low bytes followed by all high bytes
import { deflateSync, inflateSync } from 'node:zlib';
import { decodeRaw, parseHeader } from '../../src/world/terrain/pack.js';

export function encodePlane(data, w, h, enc) {
  const n = w * h;
  if (enc === 'raw8') return deflateSync(Buffer.from(data.buffer, data.byteOffset, n), { level: 9 });
  if (enc === 'delta8') {
    const out = Buffer.alloc(n);
    for (let j = 0; j < h; j++) {
      let prev = 0;
      for (let i = 0; i < w; i++) {
        const v = data[j * w + i];
        out[j * w + i] = (v - prev) & 255;
        prev = v;
      }
    }
    return deflateSync(out, { level: 9 });
  }
  if (enc === 'delta16') {
    const out = Buffer.alloc(n * 2);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const l = i > 0 ? data[k - 1] : 0;
        const u = j > 0 ? data[k - w] : 0;
        const ul = i > 0 && j > 0 ? data[k - w - 1] : 0;
        const pred = i > 0 && j > 0 ? l + u - ul : l + u;
        const r = ((data[k] - pred) << 16) >> 16; // wrap to int16
        const zz = ((r << 1) ^ (r >> 15)) & 0xffff;
        out[k] = zz & 255;
        out[n + k] = zz >> 8;
      }
    }
    return deflateSync(out, { level: 9 });
  }
  throw new Error(`unknown encoding ${enc}`);
}

/** planes: [{ name, w, h, enc, data }] -> { buffer, entries } */
export function writePack(meta, planes) {
  const blobs = [];
  const entries = [];
  let offset = 0;
  for (const p of planes) {
    const { data, ...rest } = p;
    const blob = encodePlane(data, p.w, p.h, p.enc);
    entries.push({ ...rest, offset, length: blob.length });
    blobs.push(blob);
    offset += blob.length;
  }
  const header = Buffer.from(JSON.stringify({ ...meta, planes: entries }), 'utf8');
  const head = Buffer.alloc(8);
  head.write('STP1', 0, 'latin1');
  head.writeUInt32LE(header.length, 4);
  return { buffer: Buffer.concat([head, header, ...blobs]), entries };
}

export function readPack(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const { meta, base } = parseHeader(ab);
  const planes = {};
  for (const p of meta.planes) {
    const raw = inflateSync(buf.subarray(base + p.offset, base + p.offset + p.length));
    planes[p.name] = { ...p, data: decodeRaw(raw, p.w, p.h, p.enc) };
  }
  return { meta, planes };
}
