/**
 * Loads public/audio/manifest.json, fetches and decodes assets.
 *
 * Format: Opus-in-WebM where the browser can decode it (Chrome, Edge, Firefox,
 * recent Safari), AAC (.m4a) otherwise or when a WebM decode fails.
 *
 * Decoding happens on an OfflineAudioContext before the user gesture, so the
 * SFX are ready the instant the real AudioContext starts and no autoplay
 * warning is triggered. AudioBuffers are not bound to a context.
 *
 * Music is fetched (compressed) up front but decoded on demand and evicted
 * when not needed: a decoded minute of stereo float audio is ~23 MB.
 */
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'audio/';

function pickFormat() {
  try {
    const a = globalThis.document?.createElement('audio');
    if (a?.canPlayType('audio/webm; codecs="opus"')) return 'webm';
  } catch { /* ignore */ }
  return 'm4a';
}

export class SoundBank {
  constructor(base = BASE) {
    this.base = base;
    this.manifest = null;
    this.format = pickFormat();
    this.sfx = new Map();        // id -> AudioBuffer[]
    this._rr = new Map();        // id -> last index
    this._musicBytes = new Map(); // id -> Promise<ArrayBuffer>
    this._musicBuf = new Map();   // id -> { buffer, used }
    this._decoder = null;
    this.loaded = false;
    this.errors = [];
  }

  _decodeCtx() {
    if (!this._decoder) {
      const Off = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      this._decoder = new Off(2, 1, 48000);
    }
    return this._decoder;
  }

  async _fetch(path, fmt = this.format) {
    const res = await fetch(`${this.base}${path}.${fmt}`);
    if (!res.ok) throw new Error(`${res.status} ${path}.${fmt}`);
    return res.arrayBuffer();
  }

  async _decode(path, bytes) {
    const ctx = this._decodeCtx();
    try {
      return await ctx.decodeAudioData(bytes.slice(0));
    } catch (e) {
      if (this.format !== 'm4a') {
        // e.g. a Safari build without WebM-Opus in decodeAudioData
        const alt = await this._fetch(path, 'm4a');
        const buf = await ctx.decodeAudioData(alt);
        this.format = 'm4a';
        return buf;
      }
      throw e;
    }
  }

  async load() {
    const res = await fetch(`${this.base}manifest.json`);
    this.manifest = await res.json();
    const jobs = [];
    for (const [id, e] of Object.entries(this.manifest.sfx)) {
      jobs.push(Promise.all(e.files.map(async (f) => {
        try { return await this._decode(f, await this._fetch(f)); } catch (err) {
          this.errors.push(`${f}: ${err.message}`);
          return null;
        }
      })).then((bufs) => this.sfx.set(id, bufs.filter(Boolean))));
    }
    await Promise.all(jobs);
    this.loaded = true;
    if (this.errors.length) console.warn('[audio] some assets failed', this.errors);
    return this;
  }

  /** Begin downloading compressed music bytes (cheap) for cues likely soon. */
  prefetchMusic(ids) {
    for (const id of ids) this._bytes(id);
  }

  _bytes(id) {
    const e = this.manifest?.music?.[id];
    if (!e) return null;
    if (!this._musicBytes.has(id)) {
      this._musicBytes.set(id, this._fetch(e.file).catch((err) => { this.errors.push(`${e.file}: ${err.message}`); return null; }));
    }
    return this._musicBytes.get(id);
  }

  musicEntry(id) { return this.manifest?.music?.[id] ?? null; }
  sfxEntry(id) { return this.manifest?.sfx?.[id] ?? null; }

  /** Decoded music buffer (cached; least-recently-used beyond `keep` are evicted). */
  async music(id, keep = 6) {
    const hit = this._musicBuf.get(id);
    if (hit) { hit.used = performance.now(); return hit.buffer; }
    const e = this.musicEntry(id);
    if (!e) return null;
    const bytes = await this._bytes(id);
    if (!bytes) return null;
    const buffer = await this._decode(e.file, bytes);
    this._musicBuf.set(id, { buffer, used: performance.now() });
    if (this._musicBuf.size > keep) {
      const old = [...this._musicBuf.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (old && old[0] !== id) this._musicBuf.delete(old[0]);
    }
    return buffer;
  }

  has(id) { return (this.sfx.get(id)?.length ?? 0) > 0; }

  /** Round-robin variant pick that never repeats the previous one. */
  get(id, variant) {
    const list = this.sfx.get(id);
    if (!list || !list.length) return null;
    if (variant !== undefined) return list[variant % list.length];
    if (list.length === 1) return list[0];
    const last = this._rr.get(id) ?? -1;
    let i = Math.floor(Math.random() * (list.length - 1));
    if (i >= last) i++;
    this._rr.set(id, i);
    return list[i];
  }
}
