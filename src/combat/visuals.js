// Minimal, gameplay-critical visuals owned by combat: tracer rounds and the
// missile bodies themselves. Smoke trails, explosions, flares and debris are
// the VFX area's job (driven by events); the *placeholder* versions here only
// switch on when no `game.systems.vfx` is registered, so the game is readable
// in a gameplay-only checkout.
import * as THREE from 'three/webgpu';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, -1);
const _c = new THREE.Color();

const MISSILE_ASSET = { msl: 'aam_ir', hobs: 'aam_hobs', lraam: 'aam_long', rkt: 'rocket', bomb: 'bomb', e_aam: 'aam_ir', e_aam_ace: 'aam_hobs', e_manpads: 'sam', e_sam: 'sam_large' };
const EXPLOSION_RADIUS = { small: 14, medium: 30, large: 55, huge: 110 };

/**
 * The art area's loader (src/assets/loadModel.js). Reached through a glob so a
 * gameplay-only checkout without it still builds and falls back to primitives.
 */
const loaderModules = import.meta.glob('../assets/loadModel.js');
const catalogModules = import.meta.glob('../assets/catalog.js');
let apiPromise = null;
function loadApi() {
  if (!apiPromise) {
    const load = Object.values(loaderModules)[0];
    const cat = Object.values(catalogModules)[0];
    apiPromise = load && cat
      ? Promise.all([load(), cat()]).then(([l, c]) => ({ loadModel: l.loadModel, catalog: c.CATALOG ?? {} })).catch(() => null)
      : Promise.resolve(null);
  }
  return apiPromise;
}

/** `loadModel(id, opts)` from the asset catalogue, or null when the id (or the loader) is absent. */
export async function tryLoadModel(id, opts) {
  const api = await loadApi();
  if (!api?.loadModel || !api.catalog[id]) return null;
  try {
    return (await api.loadModel(id, opts)) ?? null;
  } catch (e) {
    console.warn('[assets] failed to load', id, e);
    return null;
  }
}

export class CombatVisuals {
  constructor(game, world) {
    this.game = game;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'combat-visuals';
    game.scene.add(this.group);

    // Tracers: one instanced box, stretched along the velocity.
    const geo = new THREE.BoxGeometry(0.3, 0.3, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.tracers = new THREE.InstancedMesh(geo, mat, 768);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.setColorAt(0, _c.setRGB(1, 1, 1));
    this.group.add(this.tracers);

    this.missileGeo = new THREE.CylinderGeometry(0.09, 0.09, 2.6, 8).rotateX(Math.PI / 2);
    this.bombGeo = new THREE.CapsuleGeometry(0.2, 1.5, 4, 8).rotateX(Math.PI / 2);
    this.missileMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5, metalness: 0.3 });
    this.glowGeo = new THREE.SphereGeometry(1, 10, 8);
    this.glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 5, 1.6) });
    this.flareMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 12, 9) });
    this.models = {};
    this.missileMeshes = new Map();
    this.flareMeshes = new Map();
    this.explosions = [];

    const ev = game.events;
    ev.on('missile:launch', ({ missile }) => this._addMissile(missile));
    ev.on('missile:end', ({ missile }) => this._removeMissile(missile));
    ev.on('flare:release', ({ flare }) => { if (this.placeholders) this._addFlare(flare); });
    ev.on('explosion', (e) => { if (this.placeholders) this._addExplosion(e); });
  }

  get placeholders() { return !this.game.systems.vfx; }

  async init() {
    for (const id of ['aam_ir', 'aam_hobs', 'aam_long', 'sam', 'sam_large', 'rocket', 'bomb']) this.models[id] = await tryLoadModel(id);
  }

  _addMissile(m) {
    const assetId = MISSILE_ASSET[m.weapon.id] ?? (m.kind === 'bomb' ? 'bomb' : m.kind === 'rocket' ? 'rocket' : m.kind === 'sam' ? 'sam' : 'aam_ir');
    const root = new THREE.Group();
    const src = this.models[assetId];
    if (src) root.add(src.clone());
    else {
      const body = new THREE.Mesh(m.kind === 'bomb' ? this.bombGeo : this.missileGeo, this.missileMat);
      if (m.kind === 'sam') body.scale.set(2, 2, 1.8);
      root.add(body);
    }
    if (m.kind !== 'bomb') {
      // Motor glow: the one part of the missile you can see at range. Kept
      // even with real VFX off; hidden when a vfx system takes over.
      const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
      glow.position.z = 1.6;
      glow.scale.setScalar(m.kind === 'rocket' ? 0.5 : 0.9);
      root.add(glow);
      root.userData.glow = glow;
    }
    m.object3d = root;
    this.group.add(root);
    this.missileMeshes.set(m, root);
  }

  _removeMissile(m) {
    const root = this.missileMeshes.get(m);
    if (!root) return;
    this.group.remove(root);
    this.missileMeshes.delete(m);
  }

  _addFlare(f) {
    const mesh = new THREE.Mesh(this.glowGeo, this.flareMat);
    mesh.scale.setScalar(1.3);
    this.group.add(mesh);
    this.flareMeshes.set(f, mesh);
  }

  _addExplosion({ position, size }) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(10, 5, 1.5), transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(this.glowGeo, mat);
    mesh.position.copy(position);
    this.group.add(mesh);
    this.explosions.push({ mesh, mat, age: 0, life: 0.5 + (EXPLOSION_RADIUS[size] ?? 20) * 0.012, radius: EXPLOSION_RADIUS[size] ?? 20 });
  }

  clear() {
    for (const root of this.missileMeshes.values()) this.group.remove(root);
    for (const mesh of this.flareMeshes.values()) this.group.remove(mesh);
    for (const e of this.explosions) { this.group.remove(e.mesh); e.mat.dispose(); }
    this.missileMeshes.clear();
    this.flareMeshes.clear();
    this.explosions.length = 0;
    this.tracers.count = 0;
  }

  update(dt) {
    // [vfx] Tracers have one owner: when the VFX system is present it draws
    // every live round itself (src/vfx/core/Tracers.js reads world.bullets),
    // so the placeholder boxes only run in a gameplay-only checkout.
    const b = this.world.bullets;
    const n = this.placeholders ? b.n : 0;
    this.tracers.visible = n > 0;
    for (let i = 0; i < n; i++) {
      _d.set(b.vx[i], b.vy[i], b.vz[i]);
      const speed = _d.length();
      _d.divideScalar(speed || 1);
      _q.setFromUnitVectors(_fwd, _d);
      _p.set(b.px[i], b.py[i], b.pz[i]);
      _s.set(1, 1, Math.min(40, speed * 0.028));
      _m.compose(_p, _q, _s);
      this.tracers.setMatrixAt(i, _m);
      if (b.hostile[i]) _c.setRGB(7, 1.6, 0.5); else _c.setRGB(8, 5.5, 1.8);
      this.tracers.setColorAt(i, _c);
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;

    const placeholders = this.placeholders;
    for (const [m, root] of this.missileMeshes) {
      root.position.copy(m.position);
      root.quaternion.copy(m.quaternion);
      const glow = root.userData.glow;
      if (glow) glow.visible = m.motor && placeholders;
    }
    for (const [f, mesh] of this.flareMeshes) {
      if (!f.alive) { this.group.remove(mesh); this.flareMeshes.delete(f); continue; }
      mesh.position.copy(f.position);
      mesh.scale.setScalar(1.4 * Math.max(0.2, 1 - f.age / f.life));
    }
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.age += dt;
      const k = e.age / e.life;
      if (k >= 1) {
        this.group.remove(e.mesh);
        e.mat.dispose();
        this.explosions.splice(i, 1);
        continue;
      }
      e.mesh.scale.setScalar(e.radius * (0.25 + 0.75 * Math.sqrt(k)));
      e.mat.opacity = (1 - k) * (1 - k);
    }
  }
}
