// AI system: owns every hostile unit. Missions hand it spawn definitions
// (`ai.spawn(def)`); it builds the entities, registers them with combat as
// targets, attaches models, runs their behaviour, and hands out attack tokens
// so the player is pressured by a couple of shooters at a time, not all of
// them at once.
import * as THREE from 'three/webgpu';
import { terrainHeight } from '../world/terrain/heightfield.js';
import { Fighter } from './Fighter.js';
import { GroundUnit, Convoy } from './ground.js';
import { findSite, scatterSites, traceValleyRoad, mulberry32 } from './sites.js';
import { groundModel, hostileFighterModel, loadBaseKit, preloadModels, wreck } from './models.js';

export const order = 55;
export function createSystem(game) { return new AiSystem(game); }

const D2R = Math.PI / 180;
const FORMATION = [
  { x: 0, y: 0, z: 0 }, { x: 70, y: -8, z: -90 }, { x: -70, y: -8, z: -90 }, { x: 140, y: -16, z: -180 },
];

export class AiSystem {
  constructor(game) {
    this.name = 'ai';
    this.game = game;
    this.fighters = [];
    this.ground = [];
    this.convoys = [];
    this.props = [];
    this.root = new THREE.Group();
    this.root.name = 'hostiles';
    game.scene.add(this.root);
    this.rng = mulberry32(1999);
    this.tokens = new Set();
    /** How many fighters may be shooting missiles at once. */
    this.maxAttackers = 2;
    /** Missions switch this off for cinematic / briefing states. */
    this.hostile = true;
    this._tokenTimer = 0;
    this.ctx = { player: null, world: null, events: game.events, tokens: this.tokens, hostile: true, playerAgl: 0, alerted: false };

    game.events.on('target:destroyed', ({ target }) => this._onDestroyed(target));
  }

  async init(game) {
    this.combat = game.systems.combat;
    this.ctx.player = this.combat.player;
    this.ctx.world = this.combat.world;
    preloadModels();
  }

  // -------------------------------------------------------------- spawn --

  /** Spawn from a mission definition. Returns the combat entities created. */
  spawn(def) {
    let out;
    switch (def.kind) {
      case 'fighters': out = this.spawnFighters(def); break;
      case 'base': out = this.spawnBase(def); break;
      case 'convoy': out = this.spawnConvoy(def); break;
      case 'ground':
      default: out = [this.spawnGround(def.type, def.at.x, def.at.z, def).entity];
    }
    for (const e of out) if (def.id && !e.tags.includes(def.id)) e.tags = [...e.tags, def.id];
    return out;
  }

  spawnFighters(def) {
    const n = def.aces?.length ?? def.count ?? 2;
    const heading = (def.heading ?? 0) * D2R;
    const base = new THREE.Vector3(def.at.x, def.at.alt ?? terrainHeight(def.at.x, def.at.z) + (def.at.agl ?? 1500), def.at.z);
    const fwd = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const route = def.route?.map((w) => new THREE.Vector3(w.x, w.alt ?? terrainHeight(w.x, w.z) + 1500, w.z)) ?? null;
    const out = [];
    let leader = null;
    for (let i = 0; i < n; i++) {
      const ace = def.aces?.[i] ?? null;
      const slot = FORMATION[i % FORMATION.length];
      const f = new Fighter({
        skill: ace ? (ace.skill ?? 'ace') : (def.type ?? 'bandit'),
        name: ace ? ace.callsign : (def.names?.[i] ?? (def.type === 'veteran' ? 'BANDIT (VET)' : 'BANDIT')),
        isAce: !!ace, ace, health: ace?.health ?? def.health, score: ace?.score ?? def.score,
        skillOverrides: ace?.skillOverrides ?? def.skillOverrides, airframeOverrides: ace?.airframeOverrides,
        role: i === 0 ? 'lead' : 'wing', leader, slot, route: i === 0 ? route : null,
        tags: [...(def.tags ?? [])], isTarget: def.isTarget,
      }, this.rng);
      if (i === 0) leader = f;
      const p = base.clone().addScaledVector(fwd, slot.z).addScaledVector(right, slot.x);
      p.y += slot.y;
      f.flight.reset(p, heading, def.speed ?? 250);
      if (def.aware) f.mem.aware = true;
      const e = f.entity;
      e.object3d.position.copy(p);
      e.object3d.quaternion.copy(f.flight.quaternion);
      this.root.add(e.object3d);
      hostileFighterModel().then((m) => e.object3d.add(m));
      this.combat.addTarget(e);
      this.fighters.push(f);
      this.game.events.emit('aircraft:spawn', { entity: e });
      out.push(e);
    }
    return out;
  }

  spawnGround(type, x, z, def = {}) {
    const u = new GroundUnit(type, x, z, def, this.rng);
    u.wreckId = def.wreckId ?? null;
    const e = u.entity;
    this.root.add(e.object3d);
    if (def.model !== false) groundModel(type).then((m) => { u.model = m; e.object3d.add(m); if (!e.alive) wreck(e.object3d, type); });
    this.combat.addTarget(e);
    this.ground.push(u);
    return u;
  }

  /**
   * A fortified position: optionally a base-kit GLB as the centrepiece, with
   * units scattered on the flattest ground around it.
   *   def: { near:{x,z}, search, snap, kit?, units:[{type,count,isTarget?}], spread, tags, isTarget }
   */
  spawnBase(def) {
    const site = def.snap === false ? { x: def.near.x, z: def.near.z, y: terrainHeight(def.near.x, def.near.z) }
      : findSite(def.near.x, def.near.z, def.search ?? 900, def.snap ?? 'ridge');
    const group = { radar: null, site };
    const out = [];
    const tags = def.tags ?? [];
    if (def.kit) {
      // The kit is the bunker: one hard target at the centre whose model is the GLB.
      const u = this.spawnGround('bunker', site.x, site.z, { wreckId: `base_${def.kit}`, tags: [...tags], isTarget: def.isTarget, group, model: false, name: def.name ?? 'STRONGPOINT', health: def.kitHealth ?? 300 });
      u.entity.radius = 22;
      u.entity.object3d.rotation.y = 0;
      loadBaseKit(def.kit).then((m) => {
        if (!m) return groundModel('bunker').then((b) => u.entity.object3d.add(b));
        m.position.y = -0.6;
        u.entity.object3d.add(m);
        if (!u.entity.alive) wreck(u.entity.object3d, `base_${def.kit}`, 0.85);
      });
      out.push(u.entity);
    }
    const total = def.units.reduce((a, u) => a + (u.count ?? 1), 0);
    const spots = scatterSites(site.x, site.z, total, {
      rMin: def.kit ? 55 : 15, rMax: def.spread ?? 190, minSep: 26, seed: Math.round(Math.abs(site.x * 7 + site.z * 13)) + 1,
    });
    let k = 0;
    for (const ud of def.units) {
      for (let i = 0; i < (ud.count ?? 1); i++) {
        const s = spots[k++] ?? { x: site.x + k * 20, z: site.z + k * 14 };
        const u = this.spawnGround(ud.type, s.x, s.z, { tags: [...(ud.tags ?? def.unitTags ?? [])], isTarget: ud.isTarget === true, group, name: ud.name });
        if (ud.type === 'radar') group.radar = u;
        out.push(u.entity);
      }
    }
    return out;
  }

  /** def: { from:{x,z}, heading (deg), length, count, speed, loop, tags, isTarget } */
  spawnConvoy(def) {
    const start = findSite(def.from.x, def.from.z, def.search ?? 1500, 'valley', { step: 120 });
    const path = traceValleyRoad(start.x, start.z, (def.heading ?? 90) * D2R, { length: def.length ?? 9000 });
    const trucks = [];
    for (let i = 0; i < (def.count ?? 4); i++) trucks.push(this.spawnGround('truck', start.x, start.z, { tags: [...(def.tags ?? [])], isTarget: def.isTarget }));
    const convoy = new Convoy(path, trucks, { speed: def.speed ?? 13, loop: def.loop });
    this.convoys.push(convoy);
    return trucks.map((t) => t.entity);
  }

  _onDestroyed(target) {
    if (target.fighter) {
      this.root.remove(target.object3d);
      this.game.events.emit('aircraft:despawn', { entity: target });
    } else if (target.unit) {
      if (target.armor === 'soft' && target.kind !== 'truck') target.object3d.visible = false;
      else wreck(target.object3d, target.unit.wreckId ?? target.kind);
      target.unit._setFiring?.(false, this.ctx);
      target.velocity.set(0, 0, 0);
    }
  }

  /** Remove every unit (sortie end / restart). */
  clear() {
    for (const f of this.fighters) {
      if (f.entity.alive) { f.entity.alive = false; this.game.events.emit('aircraft:despawn', { entity: f.entity }); }
      if (f.gunFiring) this.game.events.emit('weapon:gun', { firing: false, entity: f.entity });
    }
    for (const u of this.ground) { u._setFiring(false, this.ctx); u.entity.alive = false; }
    this.root.clear();
    this.fighters.length = 0;
    this.ground.length = 0;
    this.convoys.length = 0;
    this.tokens.clear();
    this.rng = mulberry32(1999);
  }

  /** Alive entities carrying a tag. */
  count(tag) {
    let n = 0;
    for (const f of this.fighters) if (f.entity.alive && f.entity.tags.includes(tag)) n++;
    for (const u of this.ground) if (u.entity.alive && u.entity.tags.includes(tag)) n++;
    return n;
  }

  // ------------------------------------------------------------- update --

  _assignTokens() {
    this.tokens.clear();
    const p = this.ctx.player.position;
    const alive = this.fighters.filter((f) => f.entity.alive && f.mem.aware);
    alive.sort((a, b) => (a.entity.isAce ? -1e9 : 0) + a.flight.position.distanceToSquared(p) - ((b.entity.isAce ? -1e9 : 0) + b.flight.position.distanceToSquared(p)));
    for (let i = 0; i < Math.min(this.maxAttackers, alive.length); i++) this.tokens.add(alive[i]);
  }

  update(dt, game) {
    const ctx = this.ctx;
    ctx.hostile = this.hostile;
    ctx.playerAgl = game.flight.agl;
    this._tokenTimer -= dt;
    if (this._tokenTimer <= 0) { this._tokenTimer = 1; this._assignTokens(); }

    let locking = 0;
    // Fighters: sub-step long frames so the kinematics stay stable.
    const steps = dt > 1 / 45 ? 2 : 1;
    const h = dt / steps;
    for (const f of this.fighters) {
      if (!f.entity.alive) continue;
      for (let i = 0; i < steps; i++) f.update(h, ctx);
      if (f.locking) locking++;
    }
    for (const c of this.convoys) c.update(dt);
    for (const u of this.ground) {
      if (!u.entity.alive) continue;
      u.update(dt, ctx);
      if (u.locking) locking++;
      const spin = u.model?.userData.spin;
      if (spin) spin.rotation[spin.name === 'dish' ? 'y' : 'z'] += dt * 1.6;
    }
    this.combat.lockedBy = locking;
  }

  dispose() { this.clear(); this.game.scene.remove(this.root); }
}
