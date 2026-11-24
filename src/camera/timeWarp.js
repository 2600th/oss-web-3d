import { warpScale, easeInOut } from './cameraMath.js';

/**
 * Brief slow-motion beats ("bullet time" on a kill, a missile impact, the
 * player's death). One beat at a time, run on real time, written to
 * `game.timeScale` relative to whatever scale was set before (dev `?speed=3`
 * keeps working). Cancelling or finishing restores that scale exactly.
 *
 * Three kinds of beat:
 *  - start(env): a fixed envelope (cameraMath.warpScale);
 *  - drive(scale): the caller sets the scale every frame (the kill cam
 *    follows its own curves); if it stops calling, the warp releases itself
 *    after `ttl` so time can never stay stuck slow;
 *  - release(seconds): ease from the current scale back to 1.
 */
export class TimeWarp {
  constructor(game) {
    this.game = game;
    this.active = null; // { t, mode, env | s | from, base }
    this.ttl = 0.3;
  }

  _base() { return this.active ? this.active.base : (this.game?.timeScale ?? 1); }

  /** env: { scale, ease, hold, end } (see cameraMath.warpScale). */
  start(env) {
    const g = this.game;
    if (!g) return;
    this.active = { t: 0, mode: 'env', env, base: this._base() };
  }

  /** Set the relative scale for this frame (0..1). */
  drive(scale) {
    const g = this.game;
    if (!g) return;
    const s = Math.min(1, Math.max(0.001, scale));
    const a = this.active?.mode === 'drive' ? this.active : { t: 0, mode: 'drive', base: this._base() };
    a.s = s;
    a.left = this.ttl;
    this.active = a;
    g.timeScale = a.base * s;
  }

  /** Ease from the current scale back to normal time over `seconds` (real). */
  release(seconds = 0.25) {
    const a = this.active;
    if (!a || a.mode === 'release') return;
    const from = this.scale;
    if (!(seconds > 0) || from >= 0.999) { this.cancel(); return; }
    this.active = { t: 0, mode: 'release', from, dur: seconds, base: a.base };
    this.game.timeScale = a.base * from;
  }

  /** Current relative scale (1 when idle). */
  get scale() {
    const a = this.active;
    if (!a) return 1;
    if (a.mode === 'drive') return a.s;
    if (a.mode === 'release') return a.from + (1 - a.from) * easeInOut(a.t / a.dur);
    return warpScale(a.t, a.env);
  }

  /** Restore normal time now. */
  cancel() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (this.game) this.game.timeScale = a.base;
  }

  /** @param {number} rdt real seconds */
  update(rdt) {
    const a = this.active;
    if (!a) return;
    a.t += rdt;
    if (a.mode === 'drive') {
      a.left -= rdt;
      if (a.left <= 0) this.release(0.3);
      return;
    }
    if (a.mode === 'release') {
      if (a.t >= a.dur) { this.cancel(); return; }
      this.game.timeScale = a.base * this.scale;
      return;
    }
    if (a.t >= a.env.end) { this.cancel(); return; }
    this.game.timeScale = a.base * warpScale(a.t, a.env);
  }
}
