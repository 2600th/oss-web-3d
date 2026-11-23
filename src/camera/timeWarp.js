import { warpScale } from './cameraMath.js';

/**
 * Brief slow-motion beats ("bullet time" on a kill, a missile impact, the
 * player's death). One envelope at a time, run on real time, written to
 * `game.timeScale` relative to whatever scale was set before (dev `?speed=3`
 * keeps working). Cancelling or finishing restores that scale exactly.
 */
export class TimeWarp {
  constructor(game) {
    this.game = game;
    this.active = null; // { t, env, base }
  }

  /** env: { scale, ease, hold, end } (see cameraMath.warpScale). */
  start(env) {
    const g = this.game;
    if (!g) return;
    const base = this.active ? this.active.base : (g.timeScale ?? 1);
    this.active = { t: 0, env, base };
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
    if (a.t >= a.env.end) { this.cancel(); return; }
    this.game.timeScale = a.base * warpScale(a.t, a.env);
  }
}
