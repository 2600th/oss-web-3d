/**
 * Quality tiers. Picked automatically from a short frame-time probe on first
 * run, overridable from the pause menu, persisted in localStorage.
 *
 * The knobs are ordered by cost: pixel ratio dominates, then cloud fill, then
 * the postprocessing chain.
 *
 * terrainRes is the exception and has to be set before Terrain is built, since
 * it fixes buffer sizes and shader constants. Dropping clipmap *levels* is
 * still refused — that shrinks view distance, the one thing this experience
 * cannot afford — but grid resolution is fair game: it costs vertices, not
 * range. Desktop measured 257 as free (the renderer is fragment-bound), and a
 * phone cannot afford the million triangles that produces.
 */

export const TIERS = {
  phone: {
    name: 'phone',
    label: 'Phone',
    pixelRatio: 0.7,
    maxPixelRatio: 1.0,
    bloom: false,
    smaa: false,
    terrainDetail: 0.0,
    contrails: false,
    speedParticles: 120,
    terrainBudget: 1,
    terrainRes: 129,
    cloudSteps: 24,
    cloudLightSteps: 3,
    cloudDistance: 26000,
  },
  low: {
    name: 'low',
    label: 'Low',
    pixelRatio: 0.75,
    maxPixelRatio: 1.0,
    bloom: false,
    smaa: false,
    terrainDetail: 0.0,
    contrails: false,
    speedParticles: 220,
    terrainBudget: 2,
    terrainRes: 129,
    cloudSteps: 32,
    cloudLightSteps: 4,
    cloudDistance: 32000,
  },
  medium: {
    name: 'medium',
    label: 'Medium',
    pixelRatio: 1.0,
    maxPixelRatio: 1.25,
    bloom: true,
    smaa: false,
    terrainDetail: 0.7,
    contrails: true,
    speedParticles: 420,
    terrainBudget: 3,
    terrainRes: 193,
    cloudSteps: 44,
    cloudLightSteps: 4,
    cloudDistance: 40000,
  },
  high: {
    name: 'high',
    label: 'High',
    pixelRatio: 1.0,
    maxPixelRatio: 1.5,
    bloom: true,
    smaa: true,
    terrainDetail: 1.0,
    contrails: true,
    speedParticles: 700,
    terrainBudget: 4,
    terrainRes: 257,
    cloudSteps: 56,
    cloudLightSteps: 5,
    cloudDistance: 46000,
  },
};

const LEGACY_KEY = 'safed-sagar.settings.v1';
const KEY = 'safed-sagar.settings.v2';
const CONTROL_MODES = new Set(['assisted', 'direct']);
const CONTROL_SENSITIVITIES = new Set(['low', 'normal', 'high']);
const VERTICAL_MODES = new Set(['upToClimb', 'upToDive']);

export class Settings {
  constructor() {
    this.tierName = 'high';
    this.masterVolume = 0.8;
    this.musicVolume = 0.75;
    this.controlMode = 'assisted';
    this.controlSensitivity = 'normal';
    this.autoThrottle = true;
    this.verticalMode = 'upToClimb';
    this.assistedNoticeSeen = false;
    this.load();
  }

  get tier() {
    return TIERS[this.tierName] ?? TIERS.high;
  }

  setTier(name) {
    if (!TIERS[name]) return;
    this.tierName = name;
    this.save();
  }

  setMasterVolume(value) {
    if (!Number.isFinite(value)) return;
    this.masterVolume = Math.min(1, Math.max(0, value));
    this.save();
  }

  setMusicVolume(value) {
    if (!Number.isFinite(value)) return;
    this.musicVolume = Math.min(1, Math.max(0, value));
    this.save();
  }

  setControlMode(value) {
    if (!CONTROL_MODES.has(value)) return;
    this.controlMode = value;
    this.save();
  }

  setControlSensitivity(value) {
    if (!CONTROL_SENSITIVITIES.has(value)) return;
    this.controlSensitivity = value;
    this.save();
  }

  setAutoThrottle(value) {
    if (typeof value !== 'boolean') return;
    this.autoThrottle = value;
    this.save();
  }

  setVerticalMode(value) {
    if (!VERTICAL_MODES.has(value)) return;
    this.verticalMode = value;
    this.save();
  }

  setAssistedNoticeSeen(value) {
    if (typeof value !== 'boolean') return;
    this.assistedNoticeSeen = value;
    this.save();
  }

  get invertPitch() {
    return this.verticalMode === 'upToDive';
  }

  setInvertPitch(value) {
    if (typeof value !== 'boolean') return;
    this.setVerticalMode(value ? 'upToDive' : 'upToClimb');
  }

  load() {
    try {
      const current = localStorage.getItem(KEY);
      const raw = current ?? localStorage.getItem(LEGACY_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (TIERS[data.tierName]) this.tierName = data.tierName;
      if (typeof data.masterVolume === 'number') this.masterVolume = data.masterVolume;
      if (typeof data.musicVolume === 'number') this.musicVolume = data.musicVolume;
      if (CONTROL_MODES.has(data.controlMode)) this.controlMode = data.controlMode;
      if (CONTROL_SENSITIVITIES.has(data.controlSensitivity)) {
        this.controlSensitivity = data.controlSensitivity;
      }
      if (typeof data.autoThrottle === 'boolean') this.autoThrottle = data.autoThrottle;
      if (VERTICAL_MODES.has(data.verticalMode)) this.verticalMode = data.verticalMode;
      if (typeof data.assistedNoticeSeen === 'boolean') {
        this.assistedNoticeSeen = data.assistedNoticeSeen;
      }
      if (current === null && typeof data.invertPitch === 'boolean') {
        this.verticalMode = data.invertPitch ? 'upToDive' : 'upToClimb';
      }
      this.autoDetected = true;
      if (current === null) this.save();
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }

  save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          tierName: this.tierName,
          masterVolume: this.masterVolume,
          musicVolume: this.musicVolume,
          controlMode: this.controlMode,
          controlSensitivity: this.controlSensitivity,
          autoThrottle: this.autoThrottle,
          verticalMode: this.verticalMode,
          assistedNoticeSeen: this.assistedNoticeSeen,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rough hardware guess used only when the player has never picked a tier.
 * Deliberately conservative: it is much better to start at medium and let the
 * adaptive resolution scaler climb than to open at high and stutter.
 */
/**
 * Is this a touch-first device?
 *
 * Deliberately a *capability* query rather than user-agent sniffing. The
 * pointer media query reports how accurate the primary input is, so a phone and
 * a tablet answer "coarse" while a laptop with a touchscreen still answers
 * "fine" — which is the distinction that matters, since that laptop wants the
 * desktop renderer and keyboard controls. maxTouchPoints is the fallback for
 * browsers that do not support the query.
 */
export function isTouchDevice() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  return (coarse && touch) || (noHover && touch);
}

export function guessTier(renderer) {
  const gl = renderer.getContext();
  // WEBGL_debug_renderer_info is being withdrawn for fingerprinting reasons and
  // is already masked or absent in several browsers, so it is treated as a hint
  // when present rather than as the basis of the decision.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const lower = name.toLowerCase();

  // A phone is decided by input and screen, which are observable and not
  // masked. Getting this wrong in the safe direction costs some sharpness;
  // getting it wrong the other way hands a 1M-triangle scene to a phone.
  if (isTouchDevice()) {
    const wide = Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0);
    const cores = navigator.hardwareConcurrency ?? 4;
    const roomy = wide >= 1024 && cores >= 6;
    return roomy ? 'low' : 'phone';
  }

  const integrated = /(intel|uhd graphics|iris|adreno|mali|apple a\d|powervr)/.test(lower);

  const discrete = discreteClass(lower);
  if (discrete) return discrete;
  if (/(arc a|apple m[1-9])/.test(lower)) return 'high';
  if (integrated) return 'medium';
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return 'medium';
  return 'high';
}

/**
 * Read the generation out of a discrete GPU's model number.
 *
 * This used to be `/rtx/`, which put an RTX 2060 Mobile — the floor this
 * experience is meant to run on — on exactly the tier a card twenty times
 * faster gets. Measured on the reference GPU, the worst-case pose (low in a
 * valley, where the cloud march crosses the deck edge-on and accounts for four
 * fifths of the frame) costs 2.89 ms at 1080p on high and 1.61 ms on medium.
 * Those tolerate a 19x and a 35x slower GPU respectively before dropping under
 * 30 fps, and a 2060 Mobile is somewhere between 10x and 20x slower depending
 * on whether the shader binds on arithmetic or on texture rate. 19x is too
 * close to call, 35x is not, so the 20-series opens on medium.
 *
 * Nothing here is load-bearing: it picks a *starting* tier, the adaptive
 * resolution scaler covers what it gets wrong, and the pause menu overrides it.
 * That is the licence to be crude — and the reason not to be clever, since the
 * renderer string is a hint that is already masked in some browsers.
 */
function discreteClass(lower) {
  const nvidia = lower.match(/\b(?:rtx|gtx)\s*(\d{3,4})/);
  if (nvidia) {
    const model = Number(nvidia[1]);
    if (model < 1000) return 'medium'; // GTX 900-series and older
    const generation = Math.floor(model / 100); // 50, 40, 30, 20, 16, 10
    const rank = model % 100; // 90, 80, 70, 60, 50
    if (generation >= 40) return 'high'; // Ada and later: the slowest clears it
    if (generation === 30) return rank >= 60 ? 'high' : 'medium'; // 3050 is not a 3060
    return 'medium'; // 20-series, 16-series, 10-series
  }
  const amd = lower.match(/radeon\s+rx\s+(\d{3,4})/);
  if (amd) {
    const model = Number(amd[1]);
    if (model < 5000) return 'medium'; // pre-RDNA
    return model % 1000 >= 600 ? 'high' : 'medium'; // an RX 6500 is not an RX 6600
  }
  return null;
}
