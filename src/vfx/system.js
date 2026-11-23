import * as THREE from 'three/webgpu';
import { PassNode } from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { Shared } from './core/shared.js';
import { ParticlePool } from './core/ParticlePool.js';
import { Ribbons } from './core/Ribbons.js';
import { Lights } from './core/Lights.js';
import { Heat } from './core/Heat.js';
import { explosionRadius } from './core/ring.js';
import { defineTypes, TRAILS } from './effects/types.js';
import { Explosions } from './effects/Explosions.js';
import { Emitters } from './effects/Emitters.js';
import { AircraftFx } from './effects/AircraftFx.js';

export const order = 70;

const TIERS = {
  low: { segments: 3000, lights: 2, heat: false, debris: 12, rate: 0.5, spacing: 1.8, fires: 6 },
  medium: { segments: 8000, lights: 3, heat: true, debris: 24, rate: 0.75, spacing: 1.3, fires: 10 },
  high: { segments: 16000, lights: 4, heat: true, debris: 40, rate: 1, spacing: 1, fires: 14 },
  ultra: { segments: 26000, lights: 6, heat: true, debris: 56, rate: 1.3, spacing: 0.8, fires: 18 },
};

const _clear = new THREE.Color();

/** The VFX layer's own pass: same camera, transparent black clear. */
class LayerPass extends PassNode {
  updateBefore(frame) {
    const r = frame.renderer;
    r.getClearColor(_clear);
    const a = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    super.updateBefore(frame);
    r.setClearColor(_clear, a);
  }
}

/**
 * VFX system (`game.systems.vfx`).
 *
 * All particles and trails render into one HDR layer (premultiplied alpha)
 * that is composited over the scene in a post scene stage, after the
 * atmosphere and clouds and before bloom. The layer soft-clips against the
 * scene pass's depth, so nothing here needs a framebuffer copy or sorting
 * against the world. Heat haze is a second stage on top.
 *
 * Public API (positions are THREE.Vector3, world space):
 *   explosion(position, size = 'medium', kind = 'air', velocity?)
 *   impact(position, normal?, targetKind?)            gun hit
 *   attachTrail(entity, style = 'aam') -> handle      handle.end()
 *   missile(entity) / endMissile(entity)              full motor + trail
 *   flare(entity)
 *   muzzleFlash(position, direction, velocity?, scale = 1)
 *   tracer(position, velocity)
 *   spawnFire(position, {size, duration, smoke}) -> handle (handle.stop())
 *   setDamage(entity, level 0..1)                     smoke/fire off an aircraft
 *   wreck(position, velocity, scale = 1)              burning piece that falls and impacts
 *   addAircraft(entity) / removeAircraft(entity)      afterburner, vapour, vortices
 *   light(position, [r,g,b], intensity, range, duration)
 *   heat(a, b, radius, strength)                      per-frame haze capsule
 *   stats()
 */
class VfxSystem {
  constructor(game) {
    this.name = 'vfx';
    this.game = game;
    this.ready = false;
  }

  async init(game) {
    const tier = game.r.tier;
    const cfg = this.cfg = { ...(TIERS[tier.name] ?? TIERS.high) };
    const max = tier.particlesMax ?? 60000;
    cfg.lit = Math.floor(max * 0.28);
    cfg.glow = Math.floor(max * 0.16);
    cfg.backend = game.r.backend;

    const shared = this.shared = new Shared(game);
    await shared.load();
    this.lit = new ParticlePool(shared, cfg.lit, 'lit');
    this.glow = new ParticlePool(shared, cfg.glow, 'glow');
    this.ribbons = new Ribbons(shared, cfg.segments);
    this.lights = new Lights(game.scene, cfg.lights);
    this.heatField = new Heat(shared);
    const { L, G } = defineTypes(this.lit, this.glow);
    this.L = L; this.G = G;
    this.TRAILS = TRAILS;

    // The layer: its own scene, drawn after the world, composited in post.
    this.scene = new THREE.Scene();
    this.scene.name = 'vfx-layer';
    this.ribbons.mesh.renderOrder = 0;
    this.lit.mesh.renderOrder = 1;
    this.glow.mesh.renderOrder = 3; // attached additive meshes (plumes) sit at 2
    this.scene.add(this.ribbons.mesh, this.lit.mesh, this.glow.mesh);
    this.pass = new LayerPass(PassNode.COLOR, this.scene, game.camera, { depthBuffer: false });
    const layer = this.pass.getTextureNode();
    game.post.addSceneStage((color) => vec4(color.rgb.mul(layer.a.oneMinus()).add(layer.rgb), color.a), 55);
    if (cfg.heat) game.post.addSceneStage(this.heatField.stage(), 60);

    this.explosions = new Explosions(this);
    this.emitters = new Emitters(this);
    this.aircraft = new AircraftFx(this);
    this._wire(game);
    this.ready = true;

    if (import.meta.env.DEV) {
      const { installHarness } = await import('./dev/harness.js');
      installHarness(this, game);
    }
  }

  _wire(game) {
    const ev = game.events, off = this._off = [];
    const on = (type, fn) => off.push(ev.on(type, (p) => { try { fn(p ?? {}); } catch (e) { console.error(`[vfx] ${type}`, e); } }));
    on('missile:launch', ({ missile }) => missile && this.emitters.missile(missile));
    on('missile:end', ({ missile }) => missile && this.emitters.endMissile(missile));
    on('flare:release', ({ flare }) => flare && this.emitters.flare(flare));
    on('explosion', (p) => p.position && this.explosion(p.position, p.size, p.kind, p.velocity));
    on('weapon:gun', ({ firing, entity }) => this.aircraft.gun(entity, !!firing));
    on('weapon:gunHit', (p) => p.position && this.impact(p.position, p.normal, p.targetKind));
    on('target:destroyed', (p) => this.emitters.targetDestroyed(p));
    on('target:hit', ({ target }) => {
      if (target && typeof target.health === 'number') {
        const max = target.maxHealth ?? (target.health > 1 ? 100 : 1);
        this.setDamage(target, 1 - target.health / max);
      }
    });
    on('aircraft:spawn', ({ entity }) => entity && this.aircraft.add(entity));
    on('aircraft:despawn', ({ entity }) => { if (entity) { this.aircraft.remove(entity); this.emitters.clearDamage(entity); } });
    on('player:hit', (p) => {
      if (typeof p.health === 'number') this.setDamage(this.aircraft.player, 1 - (p.health > 1 ? p.health / 100 : p.health));
      if (p.position) this.impact(p.position, null, 'aircraft');
    });
    on('player:destroyed', (p) => {
      const pos = p.position ?? game.flight.position;
      this.explosion(pos, 'large', 'air', p.velocity);
      this.wreck(pos, p.velocity ?? game.flight.velocity, 1.2);
    });
    on('player:crash', (p) => {
      const pos = p.position ?? game.flight.position;
      this.explosion(pos, 'large', 'ground', p.velocity);
      this.spawnFire(pos, { size: 5, duration: 90 });
      this.setDamage(this.aircraft.player, 0);
    });
    on('player:respawn', () => this.setDamage(this.aircraft.player, 0));
  }

  // ---------------- public API ----------------
  explosion(position, size = 'medium', kind = 'air', velocity = null) {
    if (!this.ready) return;
    this.emitters.noteBlast(position);
    this.explosions.explode(position, explosionRadius(size), kind ?? 'air', velocity);
  }

  impact(position, normal = null, targetKind = 'terrain') { if (this.ready) this.explosions.impact(position, normal, targetKind); }
  attachTrail(entity, style = 'aam') { return this.emitters.attachTrail(entity, style); }
  missile(entity) { return this.emitters.missile(entity); }
  endMissile(entity) { this.emitters.endMissile(entity); }
  flare(entity) { return this.emitters.flare(entity); }
  muzzleFlash(position, direction, velocity = null, scale = 1) { this.aircraft.muzzleFlash(position, direction, velocity, scale); }
  tracer(position, velocity) { this.aircraft.tracer(position, velocity); }
  spawnFire(position, opts = {}) { return this.emitters.fire(position, opts); }
  setDamage(entity, level) { if (entity) this.emitters.damage(entity, level); }
  wreck(position, velocity, scale = 1) { return this.emitters.wreck(position, velocity, scale); }
  addAircraft(entity) { return this.aircraft.add(entity); }
  removeAircraft(entity) { this.aircraft.remove(entity); }
  light(position, color = [1, 0.7, 0.4], intensity = 5000, range = 400, duration = 0.4) {
    this.lights.flash(position, color[0], color[1], color[2], intensity, range, duration);
  }

  heat(a, b, radius, strength) { this.heatField.add(a, b, radius, strength); }

  stats() {
    return {
      backend: this.cfg.backend,
      lit: { capacity: this.lit.capacity, spawned: this.lit.spawned },
      glow: { capacity: this.glow.capacity, spawned: this.glow.spawned },
      segments: { capacity: this.ribbons.capacity, written: this.ribbons.segments },
      emitters: this.emitters.count(),
      debris: this.explosions.debrisCount(),
      heatSources: this.heatField.activeCount,
      lights: this.lights.lights.filter((l) => l.intensity > 0).length,
    };
  }

  // ---------------- frame ----------------
  lateUpdate(dt, game) {
    if (!this.ready) return;
    this.devCamera?.(game.camera);
    const shared = this.shared;
    shared.update(dt, game);
    if (dt > 0) {
      this.aircraft.update(dt);
      this.emitters.update(dt);
      this.explosions.update(dt);
    }
    this.lights.update(dt, shared.u.camPos.value);
    this.heatField.update(game.camera);
    this.ribbons.update();
    const renderer = game.r.renderer;
    this.lit.update(renderer);
    this.glow.update(renderer);
  }

  dispose() {
    for (const f of this._off ?? []) f();
    this.aircraft?.dispose();
    this.explosions?.dispose();
    this.lit?.dispose();
    this.glow?.dispose();
    this.ribbons?.dispose();
    this.lights?.dispose();
  }
}

export async function createSystem(game) {
  return new VfxSystem(game);
}
