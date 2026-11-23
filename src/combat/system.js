// Combat system: the player's weapons, targeting and lock-on, threat warning,
// damage, and the per-frame HUD snapshot (`game.hud`). The simulation itself
// (missiles, bullets, flares, damage) lives in CombatWorld.
import * as THREE from 'three/webgpu';
import { terrainHeight, lineOfSight, raycastTerrain } from '../world/terrain/heightfield.js';
import { burnerReheat } from '../flight/burner.js';
import { AIRCRAFT } from '../flight/FlightModel.js';
import { CombatWorld } from './CombatWorld.js';
import { CombatVisuals } from './visuals.js';
import { LockTracker, lockGeometry, pickTarget, cycleTarget } from './lock.js';
import { leadPoint, ballisticImpact } from './guidance.js';
import { WEAPONS, PLAYER, SPECIALS } from './weapons.js';

export const order = 50;
export function createSystem(game) { return new CombatSystem(game); }

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _dir = new THREE.Vector3();
const RAD2DEG = 180 / Math.PI;

function weaponState(id) {
  const w = WEAPONS[id];
  return { id, def: w, ammo: w.ammo, maxAmmo: w.ammo, rails: new Array(w.rails ?? 1).fill(0), next: 0 };
}

export class CombatSystem {
  constructor(game) {
    this.name = 'combat';
    this.game = game;
    this.world = new CombatWorld({ events: game.events, terrainHeight });
    const f = game.flight;
    /** The player as a combat entity (live references into the flight model). */
    this.player = {
      id: 'player', kind: 'player', class: 'air', armor: 'air', team: 'friendly', name: 'Player',
      position: f.position, velocity: f.velocity, quaternion: f.orientation,
      alive: true, health: PLAYER.health, maxHealth: PLAYER.health, radius: PLAYER.radius,
      object3d: game.player.group, engine: { throttle: 0, reheat: 0 }, incoming: 0, isPlayer: true,
    };
    this.world.player = this.player;
    this.world.targets.push(this.player);

    this.lock = new LockTracker();
    this.target = null;
    /** Weapons are live only while a sortie is running. */
    this.active = false;
    this.gun = weaponState('gun');
    this.msl = weaponState('msl');
    this.sp = weaponState('hobs');
    this.current = 'msl';
    this.flares = { count: PLAYER.flares, cooldown: 0 };
    this.gunFiring = false;
    this._gunAcc = 0;
    this._salvo = 0;
    this._salvoTimer = 0;
    this._los = true;
    this._losTimer = 0;
    this._side = 1;
    this._threatActive = false;
    this._autoTimer = 0;
    this.radarRange = 12000;
    /** Number of hostile units currently building / holding a lock on the player. */
    this.lockedBy = 0;
    this.ccip = new THREE.Vector3();
    this.lead = new THREE.Vector3();
    this._hudTargets = [];
    this._hudThreats = [];

    game.events.on('target:destroyed', ({ target }) => {
      if (target === this.target) { this.target = null; this._autoTimer = 0.35; }
    });
    game.events.on('player:hit', ({ damage, health }) => {
      f.damage = Math.min(1, Math.max(0, (0.6 - health) / 0.6));
      game.events.emit('vfx:shake', { amount: Math.min(1, 0.25 + damage / 40) });
    });
    game.events.on('player:destroyed', () => {
      f.destroyed = true;
      this._stopGun();
    });
  }

  async init(game) {
    this.visuals = new CombatVisuals(game, this.world);
    await this.visuals.init();
  }

  // ------------------------------------------------------------ sorties --

  /** Rearm and repair for a new sortie. `special` is one of SPECIALS. */
  resetForSortie({ special = 'hobs' } = {}) {
    this.world.reset();
    this.visuals?.clear();
    const p = this.player;
    p.alive = true;
    p.health = p.maxHealth;
    p.incoming = 0;
    this.gun = weaponState('gun');
    this.msl = weaponState('msl');
    this.sp = weaponState(SPECIALS.includes(special) ? special : 'hobs');
    this.current = 'msl';
    this.flares = { count: PLAYER.flares, cooldown: 0 };
    this.target = null;
    this.lock.reset();
    this.lockedBy = 0;
    this._salvo = 0;
    this._threatActive = false;
    this._stopGun();
    this.game.flight.damage = 0;
    this.game.flight.destroyed = false;
  }

  addTarget(e) { return this.world.addTarget(e); }
  removeTarget(e) { this.world.removeTarget(e); if (this.target === e) this.target = null; }

  setTarget(t) {
    if (t === this.target) return;
    this.target = t;
    this.game.events.emit('target:select', { target: t });
  }

  get weapon() { return this.current === 'sp' ? this.sp : this.msl; }

  // -------------------------------------------------------------- fixed --

  fixedUpdate(dt, game) {
    const p = this.player;
    const f = game.flight;
    const live = this.active && p.alive && !f.crashed;

    for (const st of [this.msl, this.sp]) for (let i = 0; i < st.rails.length; i++) st.rails[i] = Math.max(0, st.rails[i] - dt);
    this.flares.cooldown = Math.max(0, this.flares.cooldown - dt);

    if (live) {
      this._updateLock(dt, f);
      this._updateGun(dt, game, f);
      if (this._salvo > 0) {
        this._salvoTimer -= dt;
        while (this._salvo > 0 && this._salvoTimer <= 0) {
          this._salvoTimer += this.sp.def.salvoInterval ?? 0.07;
          this._salvo--;
          this._launch(this.sp, null, f);
        }
      }
    } else if (this.gunFiring) this._stopGun();

    this.world.step(dt);
  }

  _updateLock(dt, f) {
    const st = this.weapon;
    const w = st.def;
    const t = this.target;
    let can = false;
    if (t && t.alive && w.type === 'missile' && st.ammo > 0 && t.lockable !== false && (t.class === 'air' || w.groundLock)) {
      const g = lockGeometry(f.position, f.forward, t.position, w.lockRange, w.lockCone);
      if (g.inRange && g.inCone) {
        this._losTimer -= dt;
        if (this._losTimer <= 0) {
          this._losTimer = 0.1;
          _v.copy(t.position); _v.y += Math.max(6, t.radius * 0.6);
          this._los = lineOfSight(f.position, _v, 40);
        }
        can = this._los;
      }
    }
    const tr = this.lock.update(dt, t && t.alive ? t : null, can, w.lockTime ?? 1);
    if (tr) this.game.events.emit(`lock:${tr.event}`, { target: tr.target });
    if (this._lockMark && this._lockMark !== t) this._lockMark.lockedByPlayer = 'none';
    if (t) t.lockedByPlayer = this.lock.state;
    this._lockMark = t;
  }

  _stopGun() {
    if (!this.gunFiring) return;
    this.gunFiring = false;
    this.game.events.emit('weapon:gun', { firing: false, entity: this.player });
  }

  _updateGun(dt, game, f) {
    const want = game.input.actions.fireGun && this.gun.ammo > 0;
    if (want && !this.gunFiring) {
      this.gunFiring = true;
      this._gunAcc = 1;
      game.events.emit('weapon:gun', { firing: true, entity: this.player });
    } else if (!want && this.gunFiring) this._stopGun();
    if (!this.gunFiring) return;

    const w = this.gun.def;
    this._gunAcc += dt * w.rate;
    while (this._gunAcc >= 1 && this.gun.ammo > 0) {
      this._gunAcc -= 1;
      this.gun.ammo--;
      _dir.copy(f.forward);
      // Aim assist: inside a small cone the burst bends onto the lead point.
      if (this._leadValid) {
        _v.subVectors(this.lead, f.position).normalize();
        const ang = Math.acos(Math.min(1, _v.dot(f.forward)));
        if (ang < w.assistCone) _dir.lerp(_v, 0.75).normalize();
      }
      const r = this.world.rng;
      _dir.addScaledVector(f.right, (r() - 0.5) * 2 * w.spread).addScaledVector(f.up, (r() - 0.5) * 2 * w.spread).normalize();
      _v.copy(f.position).addScaledVector(f.forward, 7).addScaledVector(f.up, -0.6);
      _v2.copy(_dir).multiplyScalar(w.muzzle).add(f.velocity);
      this.world.fireBullet(this.player, _v, _v2, w.damage, w.life);
    }
    if (this.gun.ammo <= 0) this._stopGun();
  }

  _launch(st, target, f) {
    const w = st.def;
    if (st.ammo <= 0) return null;
    st.ammo--;
    this._side = -this._side;
    const pos = _v.copy(f.position).addScaledVector(f.right, this._side * (w.type === 'rocket' ? 1.6 : 2.3)).addScaledVector(f.up, -1.0).addScaledVector(f.forward, 1.5);
    _dir.copy(f.forward);
    if (w.spread) {
      const r = this.world.rng;
      _dir.addScaledVector(f.right, (r() - 0.5) * 2 * w.spread).addScaledVector(f.up, (r() - 0.5) * 2 * w.spread);
    }
    return this.world.fireMissile({ weapon: w, owner: this.player, target, position: pos, direction: _dir, velocity: f.velocity });
  }

  /** Fire the selected missile / special. Returns true if something left the rail. */
  fire() {
    const f = this.game.flight;
    const st = this.weapon;
    const w = st.def;
    if (st.ammo <= 0) { this.game.events.emit('weapon:empty', { weapon: w.id }); return false; }
    const rail = st.rails.findIndex((r) => r <= 0);
    if (rail < 0) return false;
    st.rails[rail] = w.reload;
    if (w.type === 'rocket') {
      this._salvo = Math.min(w.salvo ?? 4, st.ammo);
      this._salvoTimer = 0;
      return true;
    }
    const target = w.type === 'missile' && this.lock.state === 'locked' ? this.lock.target : null;
    this._launch(st, target, f);
    return true;
  }

  releaseFlares() {
    if (this.flares.count <= 0 || this.flares.cooldown > 0) return false;
    const f = this.game.flight;
    this.flares.cooldown = PLAYER.flareCooldown;
    for (let i = 0; i < PLAYER.flaresPerRelease && this.flares.count > 0; i++) {
      this.flares.count--;
      const side = i % 2 ? 1 : -1;
      _v.copy(f.position).addScaledVector(f.forward, -8).addScaledVector(f.up, -1);
      _v2.copy(f.velocity).multiplyScalar(0.55).addScaledVector(f.right, side * 28).addScaledVector(f.up, -22);
      this.world.releaseFlare(this.player, _v, _v2);
    }
    return true;
  }

  switchWeapon() {
    this.current = this.current === 'msl' ? 'sp' : 'msl';
    this._salvo = 0;
    this.game.events.emit('weapon:switch', { current: this.current, weapon: this.weapon.def.id });
  }

  cycleTarget() {
    const f = this.game.flight;
    this.setTarget(cycleTarget(this.world.targets, this.target, f.position, f.forward, 60000));
  }

  // -------------------------------------------------------------- frame --

  update(dt, game) {
    const f = game.flight;
    const p = this.player;
    const input = game.input;
    const live = this.active && p.alive && !f.crashed;
    p.engine.throttle = f.throttleSmoothed;
    p.engine.reheat = burnerReheat(f.throttleSmoothed);

    if (live) {
      if (input.pressed.fireMissile) this.fire();
      if (input.pressed.switchWeapon) this.switchWeapon();
      if (input.pressed.flares) this.releaseFlares();
      if (input.pressed.targetNext) this.cycleTarget();
      // Auto-select when there is nothing selected (or it just died).
      if (!this.target || !this.target.alive) {
        this._autoTimer -= dt;
        if (this._autoTimer <= 0) {
          this._autoTimer = 0.5;
          const t = pickTarget(this.world.targets, f.position, f.forward, 30000);
          if (t) this.setTarget(t);
        }
      }
    }

    this._updateThreats(f);
    this._updateAimData(f);
    this.visuals?.update(dt);
    this._writeHud(game, f);
  }

  _updateThreats(f) {
    const threats = this._hudThreats;
    threats.length = 0;
    let any = false;
    for (const m of this.world.missiles) {
      if (!m.alive || m.target !== this.player) continue;
      any = true;
      _v.subVectors(m.position, f.position);
      const distance = _v.length();
      const bearing = Math.atan2(_v.dot(f.right), _v.dot(f.forward)) * RAD2DEG;
      const tti = distance / Math.max(m.speed, 100);
      const level = distance < 1700 || tti < 3 ? 'alert' : 'warning';
      if (m._level !== level) {
        if (level === 'alert' || !m._level) this.game.events.emit('threat:missile', { missile: m, level, bearing });
        m._level = level;
      }
      threats.push({ position: m.position, distance, bearing, kind: m.kind, level, missile: m });
    }
    if (!any && this._threatActive) this.game.events.emit('threat:cleared', {});
    this._threatActive = any;
  }

  _updateAimData(f) {
    const t = this.target;
    this._leadValid = false;
    if (t && t.alive) {
      const d = t.position.distanceTo(f.position);
      if (d < this.gun.def.range * 1.3) {
        const tof = leadPoint(_lead, f.position, f.velocity, t.position, t.velocity, this.gun.def.muzzle, 0.35);
        if (Number.isFinite(tof) && tof < this.gun.def.life) {
          this.lead.copy(_lead);
          this._leadValid = true;
        }
      }
    }
    this._ccipValid = false;
    const w = this.weapon.def;
    if (w.type === 'bomb') {
      this._ccipValid = Number.isFinite(ballisticImpact(this.ccip, f.position, f.velocity, terrainHeight, { drag: w.drag }));
    } else if (w.type === 'rocket') {
      const d = raycastTerrain(f.position.x, f.position.y, f.position.z, f.forward.x, f.forward.y, f.forward.z, 6000, 60);
      if (Number.isFinite(d)) { this.ccip.copy(f.position).addScaledVector(f.forward, d); this._ccipValid = true; }
    }
  }

  _warning(f) {
    const p = this.player;
    if (!p.alive || f.crashed) return 'none';
    // Time to impact along the current flight path.
    if (f.velocity.y < -8 || f.agl < 220) {
      const speed = Math.max(f.airspeed, 1);
      const d = raycastTerrain(f.position.x, f.position.y, f.position.z, f.velocity.x / speed, f.velocity.y / speed, f.velocity.z / speed, speed * 4, 40);
      if (d / speed < 3.2) return 'pullup';
    }
    for (const th of this._hudThreats) if (th.level === 'alert') return 'missile';
    if (this._hudThreats.length) return 'missile';
    if (f.stalling) return 'stall';
    if (f.agl < 140) return 'terrain';
    if (p.health / p.maxHealth < 0.3) return 'damage';
    return 'none';
  }

  _writeHud(game, f) {
    const hud = game.hud;
    const p = this.player;
    const st = this.weapon;
    const w = st.def;
    hud.speed = f.airspeed;
    hud.altitude = f.altitude;
    hud.agl = f.agl;
    hud.heading = ((Math.atan2(f.forward.x, -f.forward.z) * RAD2DEG) + 360) % 360;
    hud.pitch = Math.asin(Math.min(1, Math.max(-1, f.forward.y))) * RAD2DEG;
    hud.roll = Math.atan2(f.right.y, f.up.y) * RAD2DEG;
    hud.gLoad = f.gLoad;
    hud.throttle = f.throttleSmoothed;
    hud.reheat = f.reheat;
    hud.stall = f.stalling;
    hud.aoa = f.angleOfAttack * RAD2DEG;
    hud.highG = f.highG;
    hud.speedLimits = { stall: AIRCRAFT.stallSpeed, corner: AIRCRAFT.cornerSpeed, max: AIRCRAFT.maxSpeed };
    hud.health = p.health / p.maxHealth;
    hud.controlMode = game.input.mode;

    let ready = 0, best = 1;
    for (const r of st.rails) { if (r <= 0) ready++; best = Math.min(best, r / (w.reload || 1)); }
    hud.weapon = {
      current: this.current, id: w.id, name: w.name, short: w.short ?? w.name, type: w.type, ammo: st.ammo, maxAmmo: st.maxAmmo,
      ready: st.ammo > 0 && ready > 0, reload: 1 - Math.max(0, best),
      rails: st.rails.map((r) => 1 - r / (w.reload || 1)),
      ccip: this._ccipValid ? this.ccip : null,
      lockRange: w.lockRange ?? 0, lockCone: (w.lockCone ?? 0) * RAD2DEG,
    };
    hud.weapons = {
      msl: { name: this.msl.def.name, short: this.msl.def.short, ammo: this.msl.ammo, maxAmmo: this.msl.maxAmmo },
      sp: { name: this.sp.def.name, short: this.sp.def.short, ammo: this.sp.ammo, maxAmmo: this.sp.maxAmmo },
    };
    hud.gun = {
      ammo: this.gun.ammo, maxAmmo: this.gun.maxAmmo, firing: this.gunFiring, range: this.gun.def.range,
      lead: this._leadValid ? this.lead : null,
    };
    hud.flares = { count: this.flares.count, max: PLAYER.flares, ready: this.flares.cooldown <= 0 && this.flares.count > 0 };
    hud.lock = { state: this.lock.state, target: this.lock.target, progress: this.lock.progress };
    hud.lockWarning = this.lockedBy > 0;

    const list = this._hudTargets;
    let n = 0;
    for (const t of this.world.targets) {
      if (t === p || !t.alive || t.hidden) continue;
      const o = list[n] ?? (list[n] = {});
      n++;
      o.entity = t;
      o.id = t.id; o.kind = t.kind; o.team = t.team; o.class = t.class;
      o.position = t.position; o.name = t.name ?? t.kind;
      o.isTarget = t.isTarget === true; o.isAce = t.isAce === true;
      o.distance = t.position.distanceTo(f.position);
      o.selected = t === this.target;
      o.lockable = t.lockable !== false && w.type === 'missile' && (t.class === 'air' || !!w.groundLock) && o.distance <= w.lockRange;
      o.locked = o.selected && this.lock.state === 'locked';
      o.health = t.health / t.maxHealth;
      o.onScreen = undefined; o.screen = o.screen ?? { x: 0, y: 0 };
    }
    list.length = n;
    hud.targets = list;
    hud.target = this.target && this.target.alive ? list.find((o) => o.entity === this.target) ?? null : null;
    hud.threats = this._hudThreats;
    hud.warning = this._warning(f);
    hud.radar = { range: this.radarRange };
  }

  /** Project targets with the camera that has just moved this frame. */
  lateUpdate(dt, game) {
    const cam = game.camera;
    for (const o of this._hudTargets) {
      _v.copy(o.position).project(cam);
      // Reversed-Z and standard depth both keep clip-space w sign: test with
      // the camera-space z instead of NDC z.
      _v2.copy(o.position).applyMatrix4(cam.matrixWorldInverse);
      const front = _v2.z < 0;
      o.screen.x = _v.x * 0.5 + 0.5;
      o.screen.y = 0.5 - _v.y * 0.5;
      o.onScreen = front && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1;
    }
  }

  /** Project any world point to 0..1 screen space; returns false when behind. */
  project(world, out) {
    const cam = this.game.camera;
    _v2.copy(world).applyMatrix4(cam.matrixWorldInverse);
    _v.copy(world).project(cam);
    out.x = _v.x * 0.5 + 0.5;
    out.y = 0.5 - _v.y * 0.5;
    return _v2.z < 0;
  }

  onCrash() {
    this._stopGun();
    this.player.alive = false;
  }

  dispose() { this.visuals?.clear(); }
}
