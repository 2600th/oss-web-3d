/**
 * Player settings, persisted in localStorage.
 *
 * One flat record of plain values, validated on every write and on load, so a
 * hand-edited or stale record can never put the game into a state the menus
 * cannot represent. Every key has a schema entry: its default, and either a set
 * of allowed values, a numeric range, or a boolean. Anything else is dropped.
 *
 * Consumers subscribe with `settings.onChange(fn)`; the UI system also forwards
 * each change onto the game bus as `settings:change {key, value, settings}` so
 * audio, camera and gameplay can react without importing this file.
 *
 * The v2 record from the legacy WebGL game is migrated once (volumes, control
 * mode, vertical sense), then left alone.
 */

export const SETTINGS_KEY = 'safed-sagar.settings.v3';
const LEGACY_KEYS = ['safed-sagar.settings.v2', 'safed-sagar.settings.v1'];

/** Schema: default + validation for every persisted key. */
export const SCHEMA = {
  // graphics
  tier: { def: null, values: [null, 'low', 'medium', 'high', 'ultra'] }, // null = auto
  // controls
  controlMode: { def: 'standard', values: ['standard', 'expert'] },
  invertY: { def: false, bool: true },
  sensitivity: { def: 1, min: 0.4, max: 1.8 },
  vibration: { def: true, bool: true },
  // audio (0..1)
  masterVolume: { def: 0.8, min: 0, max: 1 },
  musicVolume: { def: 0.7, min: 0, max: 1 },
  sfxVolume: { def: 0.9, min: 0, max: 1 },
  radioVolume: { def: 0.9, min: 0, max: 1 },
  // hud
  hudColor: { def: 'glacier', values: ['glacier', 'phosphor', 'amber', 'white'] },
  hudScale: { def: 1, min: 0.8, max: 1.3 },
  palette: { def: 'standard', values: ['standard', 'deutan', 'tritan'] },
  hudOpacity: { def: 1, min: 0.5, max: 1 },
  // subtitles
  subtitles: { def: true, bool: true },
  subtitleSize: { def: 'medium', values: ['small', 'medium', 'large'] },
  // camera
  cameraShake: { def: 1, min: 0, max: 1 },
  cameraFov: { def: 0, min: -10, max: 15 }, // degrees added to the rig's base FOV
  defaultCamera: { def: 'chase', values: ['chase', 'cockpit', 'hud'] },
  // accessibility
  reducedMotion: { def: 'system', values: ['system', 'on', 'off'] },
  // first-run
  memorialSeen: { def: false, bool: true },
};

export function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) return undefined;
  if (s.bool) return typeof value === 'boolean' ? value : undefined;
  if (s.values) return s.values.includes(value) ? value : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(s.max, Math.max(s.min, value));
}

export function defaults() {
  const out = {};
  for (const [k, s] of Object.entries(SCHEMA)) out[k] = s.def;
  return out;
}

/** Map a legacy (v1/v2) record onto the v3 keys. Pure; exported for tests. */
export function migrateLegacy(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  if (typeof data.masterVolume === 'number') out.masterVolume = data.masterVolume;
  if (typeof data.musicVolume === 'number') out.musicVolume = data.musicVolume;
  if (data.controlMode === 'direct') out.controlMode = 'expert';
  if (data.controlMode === 'assisted') out.controlMode = 'standard';
  if (data.verticalMode === 'upToDive' || data.invertPitch === true) out.invertY = true;
  const sens = { low: 0.7, normal: 1, high: 1.35 }[data.controlSensitivity];
  if (sens) out.sensitivity = sens;
  return out;
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // a sandboxed iframe throws on access
  }
}

export class Settings {
  constructor({ store = storage() } = {}) {
    this._store = store;
    this._listeners = new Set();
    Object.assign(this, defaults());
    this.load();
  }

  /** Set one key. Returns true if the stored value changed. */
  set(key, value) {
    const v = validate(key, value);
    if (v === undefined || this[key] === v) return false;
    this[key] = v;
    this.save();
    for (const fn of [...this._listeners]) {
      try {
        fn(key, v, this);
      } catch (e) {
        console.error(e);
      }
    }
    return true;
  }

  get(key) {
    return this[key];
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  reset() {
    for (const [k, v] of Object.entries(defaults())) {
      if (k === 'memorialSeen') continue;
      this.set(k, v);
    }
  }

  /** Resolved reduced-motion preference (system setting honoured). */
  get prefersReducedMotion() {
    if (this.reducedMotion === 'on') return true;
    if (this.reducedMotion === 'off') return false;
    try {
      return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      return false;
    }
  }

  toJSON() {
    const out = {};
    for (const k of Object.keys(SCHEMA)) out[k] = this[k];
    return out;
  }

  load() {
    const st = this._store;
    if (!st) return;
    try {
      const raw = st.getItem(SETTINGS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        for (const k of Object.keys(SCHEMA)) {
          const v = validate(k, data?.[k]);
          if (v !== undefined) this[k] = v;
        }
        return;
      }
      for (const lk of LEGACY_KEYS) {
        const old = st.getItem(lk);
        if (!old) continue;
        const m = migrateLegacy(JSON.parse(old));
        for (const [k, v] of Object.entries(m)) {
          const ok = validate(k, v);
          if (ok !== undefined) this[k] = ok;
        }
        this.save();
        return;
      }
    } catch {
      /* corrupt record: defaults stand */
    }
  }

  save() {
    try {
      this._store?.setItem(SETTINGS_KEY, JSON.stringify(this.toJSON()));
    } catch {
      /* quota or privacy mode: settings simply do not persist */
    }
  }
}

/**
 * Is this a touch-first device?
 *
 * A capability query rather than user-agent sniffing: a phone or tablet reports
 * a coarse primary pointer, a touchscreen laptop still reports a fine one and
 * wants keyboard controls. maxTouchPoints is the fallback for browsers that do
 * not support the media query. (Also imported by src/core/Input.js.)
 */
export function isTouchDevice() {
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
  const noHover = globalThis.matchMedia?.('(hover: none)').matches ?? false;
  return (coarse && touch) || (noHover && touch);
}
