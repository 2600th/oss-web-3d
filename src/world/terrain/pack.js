// Reader for the "STP1" terrain pack written by tools/terrain/pack.mjs: a JSON
// header followed by independently deflated 2D planes. Pure JS so the node
// build tool and tests share `decodeRaw` with the browser.

/** Undo a plane's predictor on already-inflated bytes. */
export function decodeRaw(raw, w, h, enc) {
  const n = w * h;
  if (enc === 'raw8') return new Uint8Array(raw.buffer, raw.byteOffset, n).slice();
  if (enc === 'delta8') {
    const out = new Uint8Array(n);
    for (let j = 0; j < h; j++) {
      let prev = 0;
      for (let i = 0; i < w; i++) {
        prev = (prev + raw[j * w + i]) & 255;
        out[j * w + i] = prev;
      }
    }
    return out;
  }
  if (enc === 'delta16') {
    // uint16, predictor left + up - upleft, zigzag residual, low bytes then high bytes
    const out = new Uint16Array(n);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const zz = raw[k] | (raw[n + k] << 8);
        const r = (zz >>> 1) ^ -(zz & 1);
        const l = i > 0 ? out[k - 1] : 0;
        const u = j > 0 ? out[k - w] : 0;
        const ul = i > 0 && j > 0 ? out[k - w - 1] : 0;
        out[k] = ((i > 0 && j > 0 ? l + u - ul : l + u) + r) & 0xffff;
      }
    }
    return out;
  }
  throw new Error(`terrain pack: unknown encoding ${enc}`);
}

export function parseHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'STP1') throw new Error('terrain pack: bad magic');
  const hl = new DataView(buffer).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  return { meta, base: 8 + hl };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fetch and decode a pack. Returns { meta, planes: { name: {w,h,data} } }. */
export async function loadPack(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`terrain pack: ${url} -> HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const { meta, base } = parseHeader(buffer);
  const planes = {};
  await Promise.all(meta.planes.map(async (p) => {
    const raw = await inflate(new Uint8Array(buffer, base + p.offset, p.length));
    planes[p.name] = { ...p, data: decodeRaw(raw, p.w, p.h, p.enc) };
  }));
  return { meta, planes, bytes: buffer.byteLength };
}
