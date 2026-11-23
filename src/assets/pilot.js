/**
 * The pilot figure in the MiG cockpit (public/models/pilot.glb, built by
 * tools/blender/build_pilot.py). The GLB is authored in aircraft model space,
 * so it is parented to the airframe model with an identity transform.
 *
 *   const pilot = await loadModel('pilot');            // player: LOD0
 *   aircraft.model.add(pilot);
 *   const rig = new PilotRig(pilot);
 *   rig.update(dt, { target: localDir | null, bank, g, firstPerson });
 *
 * `pilot_head` (helmet, visor, mask, upper hose) pivots at the top of the
 * neck: rotation.y > 0 looks left, rotation.x > 0 looks up. In the cockpit
 * view the camera sits inside the helmet, so the head is hidden there; the
 * body (arms on the stick and throttle) stays.
 *
 * Pure logic (no three.js import), unit-tested in node (pilot.test.mjs).
 */

/** How far a seated, strapped-in pilot turns his head (radians). */
export const HEAD_LIMITS = { yaw: 1.3, up: 0.42, down: -0.22, rate: 2.6 };

/**
 * Head angles that look along `dir` (aircraft model space: nose -Z, up +Y),
 * clamped to what the neck and the harness allow. A target behind the
 * shoulder is followed to the stop on that side.
 */
export function headAim(dir, out = { yaw: 0, pitch: 0 }) {
  const h = Math.hypot(dir.x, dir.z);
  let yaw = Math.atan2(-dir.x, -dir.z);
  let pitch = Math.atan2(dir.y, Math.max(h, 1e-6));
  yaw = Math.max(-HEAD_LIMITS.yaw, Math.min(HEAD_LIMITS.yaw, yaw));
  // looking far round, the head cannot also tip far up or down
  const k = 1 - 0.5 * Math.min(1, Math.abs(yaw) / HEAD_LIMITS.yaw);
  pitch = Math.max(HEAD_LIMITS.down * k, Math.min(HEAD_LIMITS.up * k, pitch));
  out.yaw = yaw;
  out.pitch = pitch;
  return out;
}

/**
 * No target: look into the turn. `bank` is the roll angle (radians, + = right
 * wing down), `g` the load factor. Pilots lead a turn with their eyes.
 */
export function turnLook(bank, g, out = { yaw: 0, pitch: 0 }) {
  const pull = Math.max(0, Math.min(1, (g - 1.3) / 4));
  const side = Math.max(-1, Math.min(1, bank / 1.2));
  out.yaw = -side * (0.18 + 0.5 * pull);
  out.pitch = 0.08 + 0.22 * pull * Math.abs(side);
  return out;
}

export class PilotRig {
  constructor(pilot) {
    this.pilot = pilot;
    this.head = pilot?.getObjectByName('pilot_head') ?? null;
    this.yaw = 0;
    this.pitch = 0;
    this._aim = { yaw: 0, pitch: 0 };
  }

  /**
   * @param {number} dt seconds
   * @param {{target?: {x: number, y: number, z: number}|null, bank?: number, g?: number, firstPerson?: boolean}} s
   *   target = direction to look at in aircraft model space (null: look into the turn)
   */
  update(dt, { target = null, bank = 0, g = 1, firstPerson = false } = {}) {
    const head = this.head;
    if (!head) return;
    head.visible = !firstPerson;
    if (firstPerson) return;
    const a = target ? headAim(target, this._aim) : turnLook(bank, g, this._aim);
    // a neck, not a servo: rate-limited, then eased
    const step = HEAD_LIMITS.rate * dt;
    const k = 1 - Math.exp(-dt * 6);
    this.yaw += Math.max(-step, Math.min(step, (a.yaw - this.yaw) * k));
    this.pitch += Math.max(-step, Math.min(step, (a.pitch - this.pitch) * k));
    head.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
