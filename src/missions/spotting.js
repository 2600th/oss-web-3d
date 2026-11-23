// Night spotting: the HUD only knows about what the pilot has actually seen.
// Pure logic (node-testable): the mission system hands it the player's
// position, the watched entities and a line-of-sight test, and it writes the
// combat contract's flags on each entity:
//
//   hidden      true: left out of hud.targets (no box, no radar contact)
//   selectable  false: auto-select and target cycling skip it
//   lockable    false: the seeker will not take it
//
// Something is seen when it is inside its sight range and in line of sight.
// A truck on dipped headlights shows from a long way off; one that has killed
// its lights has to be found almost overhead. A night fighter shows by its
// afterburner; throttled back it is a shape against the stars. Once seen, a
// contact stays marked until the pilot has been well away from it for a
// while (a string of lights is easy to keep in view, and easy to lose again).
//
// When a truck is destroyed, the rest of its column kill their lights and put
// their foot down for a while, then have to light up again to stay on the road.
//
// Mission data:
//   spotting: { tags: [tag...], truck: {lit, dark}, fighter: {lit, dark},
//               keep, hold, lose, scatter: {seconds, speed, spread} }

export const SPOT_DEFAULTS = {
  /** m: sight range of a truck on headlights / running dark. */
  truck: { lit: 5200, dark: 1500 },
  /** m: sight range of a fighter in afterburner / throttled back. */
  fighter: { lit: 5000, dark: 2200 },
  /** A marked contact stays marked out to this multiple of its sight range, */
  keep: 1.4,
  /** or to this many metres, whichever is further (eyes on a shape you have found) ... */
  hold: 0,
  /** ... and for this many seconds beyond it (or out of sight). */
  lose: 8,
  /** After a loss in the column: lights off, faster and opened out, for this long. */
  scatter: { seconds: 28, speed: 1.45, spread: 2.2 },
};

const LOS_EVERY = 0.25;
/** m/s: how fast a scattering column opens out (and closes up again). */
const SPREAD_RATE = 3;

/**
 * A controller's picture call for a contact the pilot cannot see:
 * "your four o'clock, nine kilometres, low". `heading` is the player's
 * compass heading in radians (0 = north, +X east, north is -Z).
 */
export function pictureCall(player, heading, target) {
  const dx = target.x - player.x, dz = target.z - player.z;
  const bearing = Math.atan2(dx, -dz);
  let rel = (bearing - heading) / (Math.PI * 2);
  rel -= Math.floor(rel);
  const hour = Math.round(rel * 12) % 12 || 12;
  const km = Math.max(1, Math.round(Math.hypot(dx, dz) / 1000));
  const dy = target.y - player.y;
  const level = dy > 600 ? 'high' : dy < -600 ? 'low' : 'level';
  return `your ${hour} o'clock, ${km} kilometre${km === 1 ? '' : 's'}, ${level}`;
}

export class Spotter {
  constructor(opts = {}) {
    const d = SPOT_DEFAULTS;
    this.o = {
      ...d, ...opts,
      truck: { ...d.truck, ...(opts.truck ?? {}) },
      fighter: { ...d.fighter, ...(opts.fighter ?? {}) },
      scatter: opts.scatter === false ? null : { ...d.scatter, ...(opts.scatter ?? {}) },
    };
    this.tags = new Set(opts.tags ?? []);
    /** entity -> {spotted, lost, dark, los, losTimer, orig} */
    this.watched = new Map();
    /** convoy (ai/ground.js Convoy) -> {baseSpeed, timer} */
    this.columns = new Map();
    this._i = 0;
  }

  static kindOf(e) { return e?.kind === 'truck' ? 'truck' : e?.class === 'air' ? 'fighter' : null; }

  /** Does this entity belong to something watched? */
  wants(e) {
    if (!Spotter.kindOf(e)) return false;
    for (const t of e.tags ?? []) if (this.tags.has(t)) return true;
    return false;
  }

  add(e) {
    if (!this.wants(e) || this.watched.has(e)) return;
    const s = { kind: Spotter.kindOf(e), spotted: false, lost: 0, dark: 0, los: false, losTimer: (this._i++ % 8) * (LOS_EVERY / 8), orig: { lockable: e.lockable, selectable: e.selectable } };
    this.watched.set(e, s);
    this._apply(e, s);
  }

  /** Sight range of one contact now. */
  range(e, s) {
    const r = this.o[s.kind];
    if (s.kind === 'truck') return s.dark > 0 ? r.dark : r.lit;
    return (e.engine?.reheat ?? 0) > 0 ? r.lit : r.dark;
  }

  /**
   * A truck of a column was destroyed: the others go dark and speed up.
   * `convoy` is the ai Convoy it drove in (or null), `trucks` its entities.
   */
  scatter(convoy, trucks, player = null) {
    const sc = this.o.scatter;
    if (!sc || sc.seconds <= 0) return;
    for (const e of trucks) {
      const s = this.watched.get(e);
      if (!s || !e.alive) continue;
      s.dark = sc.seconds;
      // The pilot was following lamps. When they go out, anything he is not
      // already close to is gone from the sight at once.
      if (player && s.spotted) {
        const d = Math.hypot(e.position.x - player.x, e.position.y - player.y, e.position.z - player.z);
        if (d > this.o.truck.dark) { s.spotted = false; s.lost = 0; }
      }
      this._apply(e, s);
    }
    if (convoy) {
      const c = this.columns.get(convoy) ?? { baseSpeed: convoy.speed, baseSpacing: convoy.spacing, timer: 0 };
      c.timer = sc.seconds;
      convoy.speed = c.baseSpeed * sc.speed;
      this.columns.set(convoy, c);
    }
  }

  /**
   * @param {number} dt
   * @param {{x,y,z}} player
   * @param {(from, to) => boolean} los
   */
  update(dt, player, los) {
    const sc = this.o.scatter;
    for (const [convoy, c] of this.columns) {
      c.timer -= dt;
      // The column opens out while it runs (the trucks behind back off; no
      // jumps) and closes up again once it has its lights back.
      if (c.baseSpacing !== undefined && sc?.spread) {
        const want = c.timer > 0 ? c.baseSpacing * sc.spread : c.baseSpacing;
        const step = SPREAD_RATE * dt;
        convoy.spacing += Math.max(-step, Math.min(step, want - convoy.spacing));
      }
      if (c.timer <= 0) {
        convoy.speed = c.baseSpeed;
        if (c.baseSpacing === undefined || !sc?.spread || Math.abs(convoy.spacing - c.baseSpacing) < 0.5) {
          if (c.baseSpacing !== undefined) convoy.spacing = c.baseSpacing;
          this.columns.delete(convoy);
        }
      }
    }
    for (const [e, s] of this.watched) {
      if (!e.alive) { this.watched.delete(e); this._restore(e, s); continue; }
      if (s.dark > 0) s.dark = Math.max(0, s.dark - dt);
      const dx = e.position.x - player.x, dy = e.position.y - player.y, dz = e.position.z - player.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const r = this.range(e, s);
      const keep = Math.max(r * this.o.keep, this.o.hold);
      s.losTimer -= dt;
      if (d < keep && s.losTimer <= 0) { s.losTimer = LOS_EVERY; s.los = los(player, e.position); }
      if (d < r && s.los) { s.spotted = true; s.lost = 0; }
      else if (s.spotted) {
        if (d > keep || !s.los) s.lost += dt; else s.lost = 0;
        if (s.lost > this.o.lose) s.spotted = false;
      }
      this._apply(e, s);
    }
  }

  /** Force a contact to be marked (it just shot at the player, say). */
  reveal(e) {
    const s = this.watched.get(e);
    if (!s) return;
    s.spotted = true; s.lost = 0;
    this._apply(e, s);
  }

  _apply(e, s) {
    e.hidden = !s.spotted;
    e.selectable = s.spotted ? s.orig.selectable : false;
    e.lockable = s.spotted ? s.orig.lockable : false;
    const lamps = s.kind === 'truck' ? e.object3d?.getObjectByName?.('headlights') : null;
    if (lamps) lamps.visible = s.dark <= 0;
  }

  _restore(e, s) {
    e.hidden = false;
    e.selectable = s.orig.selectable;
    e.lockable = s.orig.lockable;
  }

  /** Unspotted contacts of a kind (for the controller's picture calls). */
  unseen(kind) {
    const out = [];
    for (const [e, s] of this.watched) if (s.kind === kind && !s.spotted && e.alive) out.push(e);
    return out;
  }

  /** Put every convoy back to its own speed (sortie end). */
  clear() {
    for (const [convoy, c] of this.columns) { convoy.speed = c.baseSpeed; if (c.baseSpacing !== undefined) convoy.spacing = c.baseSpacing; }
    this.columns.clear();
    for (const [e, s] of this.watched) this._restore(e, s);
    this.watched.clear();
  }

  /** Counts for the HUD / tests. */
  stats() {
    let spotted = 0, dark = 0;
    for (const s of this.watched.values()) { if (s.spotted) spotted++; if (s.dark > 0) dark++; }
    return { tracked: this.watched.size, spotted, dark };
  }
}
