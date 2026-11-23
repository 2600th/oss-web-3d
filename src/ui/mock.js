import * as THREE from 'three/webgpu';
import { terrainHeight, DEM } from '../world/terrain/heightfield.js';
import { lonLatToWorld } from './geo.js';

/**
 * DEV ONLY: a busy dogfight written into `game.hud` and onto the event bus in
 * exactly the contract shapes (docs/v2/ARCHITECTURE.md), so the HUD can be
 * built, tuned and screenshotted before gameplay lands.
 *
 *   ?hudmock=1      dogfight wherever the jet is
 *   ?hudmock=snow   start low over the highest snowfield in the DEM
 *   ?hudmock=rock   start low in the Drass valley, over dark scree
 *
 * Placeholder hostiles are dark low-poly darts so markers sit on something.
 */

const AIR_NAMES = ['Bandit 1', 'Bandit 2', 'Bandit 3', 'Bandit 4', 'Bandit 5'];
const RADIO = [
  { callsign: 'Trishul 2', text: 'Two bandits, high, your left ten o’clock. Engaging the trailer.', priority: 2 },
  { callsign: 'Netra', text: 'Trishul flight, picture: four groups, bullseye two-seven-zero for twelve.', priority: 1 },
  { callsign: 'Trishul 2', text: 'Their lead is high and slow, top of the stack. He is yours.', priority: 2 },
  { callsign: 'Trishul 2', text: 'Missile in the air, defending! Flares, flares.', priority: 3 },
  { callsign: 'Netra', text: 'Gun position on the north spur is still active. Recommend you re-attack from the east.', priority: 1 },
];

export class HudMock {
  constructor(game, ui, mode) {
    this.game = game;
    this.ui = ui;
    this.mode = mode;
    this.t = 0;
    this.score = 12450;
    this.kills = 7;
    this.health = 0.68;
    this.targets = [];
    this.threats = [];
    this.lock = { state: 'none', target: null, progress: 0 };
    this._lockT = 0;
    this._radioT = 1.2;
    this._radioI = 0;
    this._threatT = 2.5;
    this._calloutT = 4;
    this.meshes = new THREE.Group();
    this.meshes.name = 'hudmock';
    game.scene.add(this.meshes);
    this._dartGeo = new THREE.ConeGeometry(2.2, 14, 4);
    this._dartGeo.rotateX(-Math.PI / 2);
    this._dartMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a3036, roughness: 0.6, metalness: 0.3 });
    this._boxGeo = new THREE.BoxGeometry(14, 6, 14);
  }

  /** Called when a sortie starts: place the jet and populate the sky. */
  start() {
    const g = this.game;
    if (this.mode === 'snow') {
      const p = highestPoint();
      // 3.2 km south-east of the summit, a little above it, nose on the summit
      const x = p.x + 2300;
      const z = p.z + 2300;
      g.spawn(x, z, 0);
      g.flight.position.y = p.h + 260;
      aimAt(g.flight, p.x, p.h - 100, p.z);
    } else if (this.mode === 'rock') {
      // Kargil, low in the Suru valley (~2,700 m): scree and bare rock below
      // the snowline, looking up-valley to the south.
      const a = lonLatToWorld(76.13, 34.565);
      const b = lonLatToWorld(76.1, 34.47);
      g.spawn(a.x, a.z, 0);
      g.flight.position.y = terrainHeight(a.x, a.z) + 380;
      aimAt(g.flight, b.x, terrainHeight(a.x, a.z) + 300, b.z);
    }
    g.cameraRig.reset?.(g.flight);
    this._populate();
  }

  _populate() {
    const f = this.game.flight;
    const fw = f.forward;
    const r = f.right;
    const P = f.position;
    this.targets.length = 0;
    this.meshes.clear();
    const air = (id, name, fwd, right, up, opts = {}) => {
      const pos = new THREE.Vector3().copy(P).addScaledVector(fw, fwd).addScaledVector(r, right);
      pos.y += up;
      const t = {
        id, kind: 'fighter', team: 'hostile', name, position: pos, velocity: new THREE.Vector3(),
        alive: true, lockable: true, isTarget: false, isAce: false, health: 1,
        orbit: { c: pos.clone(), r: 260 + Math.random() * 300, w: (0.25 + Math.random() * 0.2) * (Math.random() < 0.5 ? -1 : 1), a: Math.random() * 6.28 },
        ...opts,
      };
      const m = new THREE.Mesh(this._dartGeo, this._dartMat);
      m.scale.setScalar(opts.isAce ? 1.25 : 1);
      this.meshes.add(m);
      t.mesh = m;
      this.targets.push(t);
    };
    const ground = (id, name, fwd, right, kind, opts = {}) => {
      const pos = new THREE.Vector3().copy(P).addScaledVector(fw, fwd).addScaledVector(r, right);
      pos.y = terrainHeight(pos.x, pos.z) + 3;
      const t = { id, kind, team: 'hostile', name, position: pos, alive: true, lockable: true, isTarget: false, isAce: false, health: 1, ...opts };
      const m = new THREE.Mesh(this._boxGeo, this._dartMat);
      m.position.copy(pos);
      this.meshes.add(m);
      this.targets.push(t);
    };
    air(1, AIR_NAMES[0], 1100, -180, 60);
    air(2, AIR_NAMES[1], 2300, 520, 240);
    air(3, AIR_NAMES[2], 3800, -900, 420);
    air(4, AIR_NAMES[3], -2600, 1500, 300);
    air(5, AIR_NAMES[4], 5200, 2600, -200);
    air(6, 'Lead', 1700, 700, 180, { isAce: true });
    air(7, 'Trishul 2', 600, -420, 40, { team: 'friendly', kind: 'fighter', lockable: false });
    ground(10, 'SAM site', 6200, -1400, 'sam', { isTarget: true });
    ground(11, 'AAA', 4200, 900, 'aaa');
    ground(12, 'Supply dump', 9000, -300, 'depot', { isTarget: true });
    ground(13, 'Radar', -5000, -4000, 'radar', { isTarget: true });
  }

  update(dt) {
    const g = this.game;
    const f = g.flight;
    if (!f?.position) return;
    this.t += dt;
    // Dev-only terrain clearance so an unattended mock sortie never ends in
    // the first ridge (the HUD hides on crash).
    if (!f.crashed && f.agl < 260) f.position.y += (260 - f.agl) * Math.min(1, dt * 3);
    // fly the hostiles
    const tmp = new THREE.Vector3();
    for (const t of this.targets) {
      if (!t.orbit) continue;
      const o = t.orbit;
      o.a += o.w * dt;
      // orbit centre drifts with the player so the fight stays local
      o.c.lerp(tmp.copy(f.position).addScaledVector(f.forward, 1600), dt * 0.05);
      const prev = tmp.copy(t.position);
      t.position.set(o.c.x + Math.cos(o.a) * o.r, o.c.y + Math.sin(o.a * 0.7) * 60, o.c.z + Math.sin(o.a) * o.r);
      if (dt > 0) t.velocity.subVectors(t.position, prev).divideScalar(dt);
      t.mesh.position.copy(t.position);
      if (t.velocity.lengthSq() > 1) t.mesh.lookAt(tmp.copy(t.position).sub(t.velocity));
    }
    for (const t of this.targets) t.distance = t.position.distanceTo(f.position);

    // lock cycle on the ace, then the nearest bandit
    this._lockT += dt;
    const candidate = this.targets.find((t) => t.isAce && t.alive) ?? this.targets.find((t) => t.alive && t.team === 'hostile');
    const ev = g.events;
    if (this.lock.state === 'none' && this._lockT > 0.8 && candidate) {
      this.lock = { state: 'acquiring', target: candidate, progress: 0 };
      this._lockT = 0;
      ev.emit('lock:acquiring', { target: candidate });
    } else if (this.lock.state === 'acquiring') {
      this.lock.progress = Math.min(1, this._lockT / 1.3);
      if (this._lockT > 1.3) {
        this.lock.state = 'locked';
        this._lockT = 0;
        ev.emit('lock:locked', { target: this.lock.target });
      }
    } else if (this.lock.state === 'locked' && this._lockT > 4.5) {
      ev.emit('lock:lost', { target: this.lock.target });
      this.lock = { state: 'none', target: null, progress: 0 };
      this._lockT = 0;
    }

    // radio
    this._radioT -= dt;
    if (this._radioT <= 0) {
      ev.emit('radio', { speaker: RADIO[this._radioI].callsign, ...RADIO[this._radioI] });
      this._radioI = (this._radioI + 1) % RADIO.length;
      this._radioT = 5.5;
    }

    // incoming missile from the rear quarter, cycles
    this._threatT -= dt;
    if (this._threatT <= 0 && !this.threats.length) {
      const pos = new THREE.Vector3().copy(f.position).addScaledVector(f.forward, -3200).addScaledVector(f.right, -1400);
      this.threats.push({ position: pos, distance: 3500, kind: 'aam', bearing: 0 });
      ev.emit('threat:missile', { missile: { position: pos }, level: 'warning', bearing: 0 });
      this._threatT = 9;
    }
    for (const m of this.threats) {
      m.position.lerp(f.position, dt * 0.22);
      m.distance = m.position.distanceTo(f.position);
    }
    if (this.threats.length && this.threats[0].distance < 1100 && !this._alerted) {
      this._alerted = true;
      ev.emit('threat:missile', { missile: this.threats[0], level: 'alert', bearing: 0 });
    }
    if (this.threats.length && this.threats[0].distance < 300) {
      this.threats.length = 0;
      this._alerted = false;
      ev.emit('threat:cleared', {});
      ev.emit('flare:release', { flare: {} });
    }

    // callouts
    this._calloutT -= dt;
    if (this._calloutT <= 0) {
      const pick = Math.floor(this.t / 6) % 3;
      if (pick === 0) {
        const tgt = this.targets.find((t) => t.id === 2);
        this.score += 650;
        this.kills++;
        ev.emit('target:destroyed', { target: tgt, killer: 'player', position: tgt.position.clone(), score: 650 });
      } else if (pick === 1) {
        const tgt = this.targets.find((t) => t.id === 11);
        ev.emit('target:hit', { target: tgt, damage: 0.4 });
      } else {
        ev.emit('missile:end', { missile: { owner: 'player', kind: 'aam' }, reason: 'miss' });
      }
      this._calloutT = 6;
    }

    g.hud = {
      speed: f.airspeed,
      altitude: f.altitude,
      agl: f.agl,
      gLoad: f.gLoad,
      throttle: f.throttleSmoothed,
      reheat: f.reheat,
      stall: f.stalling,
      health: this.health,
      score: this.score,
      time: 252 + this.t,
      timeLimit: 600,
      weapon: { current: 'msl', name: 'R-60M', ammo: 18, maxAmmo: 24, ready: (this.t % 6) > 1.4, reload: Math.min(1, (this.t % 6) / 1.4) },
      gun: { ammo: 186, firing: false },
      flares: { count: 24, ready: true },
      lock: this.lock,
      targets: this.targets,
      threats: this.threats,
      warning: undefined,
      objective: { text: 'Destroy the SAM sites covering the Tololing ridge', progress: 2, total: 4, marker: this.targets.find((t) => t.id === 10)?.position },
      mission: { id: 'first-light', name: 'First Light', phase: 2, state: 'active' },
    };
  }

  dispose() {
    this.game.scene.remove(this.meshes);
  }
}

function highestPoint() {
  const { res, data, minX, maxX, minZ, maxZ } = DEM;
  let best = -1;
  let bi = 0;
  // keep away from the DEM edge blend
  const m = Math.floor(res * 0.15);
  for (let j = m; j < res - m; j += 2) {
    for (let i = m; i < res - m; i += 2) {
      const h = data[j * res + i];
      if (h > best) {
        best = h;
        bi = j * res + i;
      }
    }
  }
  const i = bi % res;
  const j = Math.floor(bi / res);
  return { x: minX + (i / (res - 1)) * (maxX - minX), z: minZ + (j / (res - 1)) * (maxZ - minZ), h: best };
}

/** Point the flight model's nose (and velocity) at a world point. */
function aimAt(f, x, y, z) {
  const dir = new THREE.Vector3(x - f.position.x, y - f.position.y, z - f.position.z).normalize();
  // Matrix4.lookAt puts +Z from target to eye, so the -Z nose faces `dir`.
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
  f.orientation.setFromRotationMatrix(m);
  f.forward.set(0, 0, -1).applyQuaternion(f.orientation);
  f.up.set(0, 1, 0).applyQuaternion(f.orientation);
  f.right.set(1, 0, 0).applyQuaternion(f.orientation);
  f.velocity.copy(f.forward).multiplyScalar(Math.max(200, f.airspeed));
  f._prevVelocity?.copy(f.velocity);
}
