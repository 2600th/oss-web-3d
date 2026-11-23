// Target selection and lock-on state. Pure logic (node-testable).

/**
 * Lock geometry for one shooter/target pair.
 * @returns {{distance:number, angle:number, inRange:boolean, inCone:boolean}}
 */
export function lockGeometry(shooterPos, forward, targetPos, range, cone) {
  const dx = targetPos.x - shooterPos.x;
  const dy = targetPos.y - shooterPos.y;
  const dz = targetPos.z - shooterPos.z;
  const distance = Math.hypot(dx, dy, dz);
  const cos = distance > 1e-6 ? (dx * forward.x + dy * forward.y + dz * forward.z) / distance : 1;
  const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
  return { distance, angle, inRange: distance <= range, inCone: angle <= cone };
}

/**
 * Lock state machine: none -> acquiring -> locked.
 *
 * `update` returns the transition that happened this step, or null:
 * 'acquiring' | 'locked' | 'lost'. Progress decays (rather than snapping to
 * zero) when the target slips out of the cone, so a lock that is nearly made
 * survives a moment of sloppy flying — but changing target always restarts.
 */
export class LockTracker {
  constructor() {
    this.state = 'none';
    this.target = null;
    this.progress = 0;
  }

  reset() {
    const had = this.state !== 'none';
    const target = this.target;
    this.state = 'none';
    this.target = null;
    this.progress = 0;
    return had ? { event: 'lost', target } : null;
  }

  /**
   * @param {number} dt
   * @param {object|null} target   candidate (must have `alive`)
   * @param {boolean} canLock      geometry + line of sight + weapon allows it
   * @param {number} lockTime      seconds to full lock
   */
  update(dt, target, canLock, lockTime) {
    if (target !== this.target) {
      const lost = this.reset();
      this.target = target;
      if (lost) return lost;
    }
    if (!target || target.alive === false) return this.reset();

    if (canLock) {
      const before = this.state;
      this.progress = Math.min(1, this.progress + dt / Math.max(lockTime, 1e-3));
      if (this.progress >= 1) {
        this.state = 'locked';
        return before !== 'locked' ? { event: 'locked', target } : null;
      }
      this.state = 'acquiring';
      return before === 'none' ? { event: 'acquiring', target } : null;
    }

    // Out of parameters: bleed the lock away.
    this.progress = Math.max(0, this.progress - dt * 2.2);
    if (this.state === 'locked' && this.progress < 0.75) {
      this.state = this.progress > 0 ? 'acquiring' : 'none';
      return { event: 'lost', target };
    }
    if (this.state === 'acquiring' && this.progress <= 0) {
      this.state = 'none';
      return { event: 'lost', target };
    }
    return null;
  }
}

/**
 * Priority of a target for auto-select; lower is better. Mission targets and
 * things near the nose win; distance breaks ties.
 */
export function targetPriority(geom, target) {
  let s = geom.distance / 1000 + (geom.angle * 180 / Math.PI) * 0.22;
  if (target.isTarget) s -= 4;
  if (target.isAce) s -= 1.5;
  if (target.class === 'air') s -= 1;
  if (geom.angle > Math.PI / 2) s += 6; // behind the wing line
  return s;
}

/** Selectable hostile targets, sorted best-first. */
export function rankTargets(targets, shooterPos, forward, maxRange = 40000) {
  const out = [];
  for (const t of targets) {
    if (!t.alive || t.selectable === false || t.team === 'friendly') continue;
    const g = lockGeometry(shooterPos, forward, t.position, maxRange, Math.PI);
    if (!g.inRange) continue;
    out.push({ target: t, priority: targetPriority(g, t), geom: g });
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

/** Best target right now, or null. */
export function pickTarget(targets, shooterPos, forward, maxRange) {
  return rankTargets(targets, shooterPos, forward, maxRange)[0]?.target ?? null;
}

/**
 * Next target after `current` in priority order (wraps). The ranking is taken
 * once per press, so repeated presses walk outward from the nose.
 */
export function cycleTarget(targets, current, shooterPos, forward, maxRange) {
  const ranked = rankTargets(targets, shooterPos, forward, maxRange);
  if (ranked.length === 0) return null;
  const i = ranked.findIndex((r) => r.target === current);
  return ranked[(i + 1) % ranked.length].target;
}
