/**
 * Art-assets runtime (auto-registered, see docs/v2/ARCHITECTURE.md "Systems").
 *
 *  - Hands loadModel the quality tier and the Environment, so every model it
 *    returns gets the node-material recipes in ./materials.js (painted metal and
 *    coated glass on the MiGs, detail normals on ground units, cloud shadows).
 *  - Player jet: material tier + cloud shadows, and the control surfaces
 *    (Aircraft.updateSurfaces) from the flight model.
 *  - Hostile fighters: the same surfaces, driven from their attitude change.
 *  - Ground units (presentation only; gameplay state is read, never written):
 *    seating on the terrain (vehicles follow the slope, emplacements stay level
 *    on a small earth foundation), turrets and barrels laid on the player,
 *    SAM / MANPADS launchers raised while locking, AAA scanning when idle.
 *    The rig re-seats whatever model the unit currently shows, so the
 *    `_destroyed` wreck that src/ai/models.js swaps in lands the same way.
 *
 * Order 15: init runs before ai (55) preloads its models; per-frame work is in
 * lateUpdate, after ai has moved convoys and updated line of sight.
 */
import * as THREE from 'three/webgpu';
import { smoothstep, positionWorld, normalWorld, mix, vec3, float, texture, triplanarTexture, attribute } from 'three/tsl';
import { terrainHeight, detailHeight, demInset, DEM } from '../world/terrain/heightfield.js';
import { configureAssets, loadModel } from './loadModel.js';
import { PilotRig } from './pilot.js';
import { CATALOG } from './catalog.js';
import { SurfaceRig, bodyRates, demandsFromRates } from './controlSurfaces.js';
import { upgradeGroundMaterials, applyCloudShadows, setGroundDetail } from './materials.js';
import { LAYERS, LAYER } from '../world/terrain/layers.js';
import { seatUnit, aimAngles, slew, UNIT_RIGS } from './unitRig.js';

export const order = 15;
export function createSystem(game) { return new AssetsSystem(game); }

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rates = { x: 0, y: 0, z: 0 };

class AssetsSystem {
  constructor(game) {
    this.name = 'assets';
    this.game = game;
    this.fighters = new WeakMap(); // fighter -> {rig, prev, demands, tries}
    this.units = new WeakMap(); // GroundUnit -> rig state
    this.foundationMat = null;
    this.stats = { units: 0, seated: 0, aiming: 0, fighters: 0 };
  }

  init(game) {
    const tier = game.r?.tier?.name ?? 'high';
    this.tier = tier;
    // [textures] model textures get the device's anisotropic filtering, and
    // ground units a weathered grain from the terrain's scree layer
    configureAssets({ tier, env: game.env, anisotropy: game.r?.renderer?.getMaxAnisotropy?.() ?? 8 });
    const layers = game.terrain?.layers;
    if (layers?.albedo) {
      const [r, g, b] = LAYERS[LAYER.scree].mean;
      setGroundDetail({ albedo: layers.albedo, layer: LAYER.scree, meanLum: 0.2126 * r + 0.7152 * g + 0.0722 * b });
    }
    game.player.configure?.({ tier, env: game.env });
    game.events.on('player:respawn', () => game.player.surfaces?.reset?.({}));
    // The pilot (pilot.glb is in aircraft model space: identity under the airframe model).
    this.pilot = null;
    if (game.player?.model) {
      loadModel('pilot', { lod: 0 }).then((p) => {
        p.name = 'pilot';
        game.player.model.add(p);
        this.pilot = new PilotRig(p);
      }).catch((e) => console.warn('[assets] pilot unavailable', e));
    }
  }

  /** Head and visibility of the player's pilot: no head in first person, looks at the fight. */
  _pilot(dt, game) {
    const view = game.cameraRig?.view;
    const firstPerson = view === 'cockpit' || view === 'hud';
    const f = game.flight;
    _q.copy(f.orientation).invert();
    let target = null;
    const lock = game.cameraRig?.lockTarget?.position ?? null;
    let best = lock;
    if (!best) {
      // else the nearest live bandit within 2.5 km
      let d2 = 2500 * 2500;
      for (const fi of game.systems.ai?.fighters ?? []) {
        const p = fi.entity?.alive ? fi.entity.position : null;
        if (!p) continue;
        const d = p.distanceToSquared(f.position);
        if (d < d2) { d2 = d; best = p; }
      }
    }
    if (best) target = _v.subVectors(best, f.position).applyQuaternion(_q).normalize();
    // bank: + = right wing down
    const right = _w.set(1, 0, 0).applyQuaternion(f.orientation);
    this.pilot.update(Math.min(dt, 0.1), { target, bank: -Math.asin(THREE.MathUtils.clamp(right.y, -1, 1)), g: f.gLoad ?? 1, firstPerson });
  }

  lateUpdate(dt, game) {
    if (dt <= 0) return;
    game.player.updateSurfaces?.(dt, game.flight);
    if (this.pilot) this._pilot(dt, game);
    const ai = game.systems.ai;
    if (!ai) return;
    const cam = game.camera.position;
    this.stats.fighters = 0;
    for (const f of ai.fighters) this._fighter(f, dt, cam);
    this.stats.units = 0;
    this.stats.aiming = 0;
    const player = game.systems.combat?.player ?? null;
    for (const u of ai.ground) this._unit(u, dt, player, cam);
  }

  // ------------------------------------------------------------ fighters --

  _fighter(f, dt, cam) {
    const e = f.entity;
    if (!e.alive || !e.object3d) return;
    let s = this.fighters.get(f);
    if (!s) this.fighters.set(f, (s = { rig: null, prev: new THREE.Quaternion().copy(f.flight.quaternion), demands: { pitch: 0, roll: 0, flap: 0 }, wait: 0 }));
    if (!s.rig?.ok) {
      s.wait -= dt;
      if (s.wait > 0) return;
      s.wait = 0.5; // the model arrives asynchronously
      const rig = new SurfaceRig(e.object3d);
      if (!rig.ok) return;
      s.rig = rig;
    }
    const q = f.flight.quaternion;
    if (e.object3d.position.distanceToSquared(cam) < 3000 * 3000) {
      bodyRates(s.prev, q, dt, _rates);
      // [aircraft fx] stabs/ailerons/flaps plus rudder (yaw rate) and airbrakes (hard deceleration)
      const speed = f.flight.speed ?? 250;
      const accel = dt > 0 && s.speed !== undefined ? (speed - s.speed) / dt : 0;
      s.accel = (s.accel ?? 0) + (accel - (s.accel ?? 0)) * Math.min(1, dt * 4);
      demandsFromRates(_rates, speed, s.accel, f.flight.cfg ?? {}, s.demands);
      s.rig.update(Math.min(dt, 0.1), s.demands);
      this.stats.fighters++;
    }
    s.prev.copy(q);
    s.speed = f.flight.speed ?? 250;
  }

  // ---------------------------------------------------------- ground units --

  _foundationMaterial() {
    if (!this.foundationMat) {
      const m = new THREE.MeshStandardMaterial({ color: 0x7a6f62, roughness: 1, metalness: 0 });
      m.name = 'foundation_earth';
      const obj = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m);
      upgradeGroundMaterials(obj, { tier: this.tier, env: this.game.env });
      const fm = obj.material;
      // The terrain's own gravel texture, triplanar in world space, so the pad and
      // berm read as the same ground the unit stands on rather than a grey sheet.
      if (this.tier !== 'low') {
        const tex = new THREE.TextureLoader().load('./assets/textures/terrain/gravel_col.webp');
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.game.r?.renderer?.getMaxAnisotropy?.() ?? 4; // [textures] was 4
        const tri = triplanarTexture(texture(tex), null, null, float(0.3), positionWorld, normalWorld);
        fm.colorNode = tri.rgb.mul(vec3(0.95, 0.92, 0.88));
      }
      // Snow lies on the berm where it lies on the ground around it; a bare brown
      // mound on a snowfield read as a hole. [models polish] A fixed 4700-4950 m
      // band put snow on berms over bare ground (and the reverse): the terrain's
      // line moves hundreds of metres with aspect and curvature. Each berm now
      // carries its site's cover in `siteSnow` (see siteSnow()).
      const snow = attribute('siteSnow', 'float').mul(smoothstep(0.35, 0.75, normalWorld.y));
      fm.colorNode = mix(fm.colorNode ?? vec3(0.48, 0.43, 0.38), vec3(0.78, 0.8, 0.83), snow.mul(0.92));
      this.foundationMat = fm;
    }
    return this.foundationMat;
  }

  _unit(u, dt, player, cam) {
    const e = u.entity;
    const holder = e.object3d;
    if (!holder) return;
    const model = holder.children.find((c) => c.userData.isUnitModel) ?? null;
    if (!model) return;
    this.stats.units++;
    let s = this.units.get(u);
    if (!s) this.units.set(u, (s = { model: null, yaw: NaN, x: NaN, z: NaN, foundation: null, nodes: null, aim: { yaw: 0, pitch: 0 }, scan: Math.random() * 10, raised: 0 }));

    // A different model (first load, or the wreck swapped in): look it up again.
    if (s.model !== model) {
      s.model = model;
      s.yaw = NaN;
      const id = model.userData.assetId ?? null;
      s.spec = UNIT_RIGS[u.type] ?? UNIT_RIGS.default;
      // base-kit layouts (a whole strongpoint, placed by ai/system.js) keep their own seating
      s.kit = CATALOG[id]?.kind === 'base';
      s.bounds = id && CATALOG[id]?.bounds?.min ? CATALOG[id].bounds : boxOf(model);
      s.nodes = e.alive ? {
        turret: model.getObjectByName('turret'),
        barrels: model.getObjectByName('barrels') ?? model.getObjectByName('barrel'),
        launcher: model.getObjectByName('launcher'),
      } : null;
      // the turret now lays the gun; ai/ground.js stops spinning the whole unit
      model.userData.aimRig = !!(s.nodes && (s.nodes.turret || s.nodes.launcher));
      if (model.userData.aimRig) u.aimRig = true;
      if (this.game.env) applyCloudShadows(model, this.game.env);
    }

    // Seat on the terrain whenever the unit has moved or turned.
    const yaw = holder.rotation.y;
    if (!s.kit && (yaw !== s.yaw || holder.position.x !== s.x || holder.position.z !== s.z)) {
      s.yaw = yaw; s.x = holder.position.x; s.z = holder.position.z;
      // relative to the holder's y: convoys interpolate it along 160 m road segments
      const seat = seatUnit(terrainHeight, holder.position.x, holder.position.z, yaw, s.bounds, s.spec, holder.position.y);
      model.position.y = seat.offset;
      model.rotation.set(seat.pitch, 0, seat.roll, 'YXZ');
      s.seat = seat;
      this._foundation(s, model, seat);
    }

    if (!e.alive || !s.nodes || !spec(s).yawRate) return;
    const n = s.nodes;
    const sp = s.spec;
    if (!n.turret && !n.launcher) return;
    if (holder.position.distanceToSquared(cam) > 9000 * 9000) return;
    const dist = player ? e.position.distanceTo(player.position) : Infinity;
    // the unit's own state from ai/ground.js: firing (guns), locking (SAMs), line of sight
    const engaged = !!player?.alive && (u.firing || u.locking || (u.los && dist < (u.def?.range ?? 4000)));
    s.time = (s.time ?? 0) + dt;
    if (u.locking || u.firing) s.lastActive = s.time;
    let wantYaw;
    let wantPitch;
    if (engaged) {
      // AAA leads the target like a gunner would; the others lay on it directly
      _v.copy(player.position);
      if (sp.lead > 0 && player.velocity) _v.addScaledVector(player.velocity, dist / sp.lead);
      const pivot = n.turret ?? n.launcher;
      const a = aimAngles(pivot.parent, _v, pivot, n.barrels ?? n.launcher, _w);
      wantYaw = a.yaw;
      wantPitch = a.pitch;
      this.stats.aiming++;
    } else {
      // idle: AAA sweeps its sector, everything else holds its bearing
      s.scan += dt;
      wantYaw = sp.scan ? Math.sin(s.scan * 0.25) * sp.scan : s.aim.yaw;
      wantPitch = sp.restPitch ?? 0;
    }
    if (sp.raiseOnLock) {
      // stowed until the site starts tracking (lock), up through the launch,
      // then lowered again some seconds after it stops
      const up = s.lastActive != null && s.time - s.lastActive < 8;
      wantPitch = up ? Math.max(sp.minLaunch ?? 0, wantPitch) : 0;
    }
    wantPitch = THREE.MathUtils.clamp(wantPitch, sp.pitch[0], sp.pitch[1]);
    s.aim.yaw = slew(s.aim.yaw, wantYaw, sp.yawRate * dt, true);
    s.aim.pitch = slew(s.aim.pitch, wantPitch, sp.pitchRate * dt, false);
    if (sp.launcherYaws && n.launcher && !n.turret) n.launcher.rotation.order = 'YXZ';
    if (n.turret) n.turret.rotation.y = s.aim.yaw;
    else if (n.launcher && sp.launcherYaws) n.launcher.rotation.y = s.aim.yaw;
    const elev = n.barrels ?? n.launcher;
    if (elev) elev.rotation.x = s.aim.pitch;
  }

  _foundation(s, model, seat) {
    if (s.foundation) { s.foundation.parent?.remove(s.foundation); s.foundation.geometry.dispose(); s.foundation = null; }
    if (!seat.foundation) return;
    const f = seat.foundation;
    const geo = foundationGeometry(f.minX, f.maxX, f.minZ, f.maxZ, f.depth, f.flare, model.id);
    const pos = model.parent?.position ?? model.position;
    const cover = siteSnow(terrainHeight, pos.x, pos.z);
    geo.setAttribute('siteSnow', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count).fill(cover), 1));
    const mesh = new THREE.Mesh(geo, this._foundationMaterial());
    mesh.name = 'foundation';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.isFoundation = true;
    // a child of the model: it tilts with a vehicle and leaves with it when the wreck swaps in
    model.add(mesh);
    s.foundation = mesh;
  }
}

function boxOf(model) {
  const b = new THREE.Box3().setFromObject(model);
  const inv = model.parent ? new THREE.Matrix4().copy(model.parent.matrixWorld).invert() : null;
  if (inv) b.applyMatrix4(inv);
  return { min: b.min.toArray(), max: b.max.toArray() };
}

const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** DEM-only height (no sub-DEM detail), bilinear like the GPU sampler. */
function demHeight(x, z) {
  const n = DEM.res;
  const gx = Math.min(n - 1.001, Math.max(0, (x - DEM.minX) / DEM.cellX));
  const gz = Math.min(n - 1.001, Math.max(0, (z - DEM.minZ) / DEM.cellZ));
  const i = Math.floor(gx), j = Math.floor(gz), tx = gx - i, tz = gz - j, d = DEM.data;
  const top = d[j * n + i] + (d[j * n + i + 1] - d[j * n + i]) * tx;
  const bot = d[(j + 1) * n + i] + (d[(j + 1) * n + i + 1] - d[(j + 1) * n + i]) * tx;
  return top + (bot - top) * tz;
}

/**
 * How much snow the terrain material puts on the ground at a site (0..1), from
 * the same inputs it uses (src/world/terrain/material.js, `snowLine` / `snowRaw`):
 * altitude against a 4760 m line moved by aspect (+-380 m), DEM curvature
 * (ridges shed, hollows hold: the 3-cell ring the `surf` texture stores) and the
 * sub-DEM detail height, then steep slopes shed it. Not reproduced: the macro
 * mask and fall-line streak terms, so it can be off near the line.
 */
export function siteSnow(heightAt, x, z) {
  const e = 4;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  const tan = Math.hypot(gx, gz);
  const nz = -gz / Math.sqrt(1 + tan * tan);
  let curv = 0;
  if (DEM.ready && DEM.data && demInset(x, z) > 4 * DEM.cellX) {
    const r = 3 * DEM.cellX;
    const ring = (demHeight(x + r, z) + demHeight(x - r, z) + demHeight(x, z + r) + demHeight(x, z - r)) * 0.25;
    curv = Math.max(-0.35, Math.min(0.35, (ring - demHeight(x, z)) / r));
  }
  const hDet = detailHeight(x, z);
  const line = 4760 + nz * 380 - Math.max(-0.12, Math.min(0.2, curv)) * 1500 + hDet * 55;
  const raw = smooth01(-90, 90, heightAt(x, z) - line) * (1 - smooth01(0.8, 1.35, tan + hDet * 0.22)) - smooth01(0.45, 0.95, tan) * 0.3;
  return smooth01(0.32, 0.68, raw);
}

/**
 * A spoil berm of packed earth and rock under an emplacement: a flat pad the
 * size of the footprint at the model base (local y 0), then rings stepping out
 * and down `depth` with a convex profile, jittered so it reads as dug ground,
 * not a plinth. Only the downhill part shows; the uphill part is in the slope.
 */
function foundationGeometry(x0, x1, z0, z1, depth, flare, seed = 1) {
  const PER_SIDE = 6;
  const RINGS = 5;
  const perim = [];
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const dirs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], da = dirs[i], db = dirs[(i + 1) % 4];
    for (let k = 0; k < PER_SIDE; k++) {
      const t = k / PER_SIDE;
      perim.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: da[0] + (db[0] - da[0]) * t, dz: da[1] + (db[1] - da[1]) * t });
    }
  }
  const n = perim.length;
  const hash = (i, j) => {
    let h = Math.imul(i * 374761393 + j * 668265263 + seed * 2147483647, 1274126177);
    h ^= h >>> 15;
    return ((h >>> 0) % 10000) / 10000 - 0.5;
  };
  const pos = [];
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    const out = flare * t;
    const y = -depth * Math.pow(t, 0.75);
    const jit = r === 0 ? 0 : Math.min(0.35, 0.12 + depth * 0.06);
    for (let i = 0; i < n; i++) {
      const p = perim[i];
      const l = Math.hypot(p.dx, p.dz) || 1;
      const j = 1 + hash(i, r) * 0.5;
      pos.push(p.x + (p.dx / l) * out * j + hash(i + 31, r) * jit, y + hash(i + 77, r) * jit * (r === RINGS ? 0 : 1), p.z + (p.dz / l) * out * j + hash(i + 53, r) * jit);
    }
  }
  const idx = [];
  for (let r = 0; r < RINGS; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i, b = r * n + ((i + 1) % n), c = (r + 1) * n + ((i + 1) % n), d = (r + 1) * n + i;
      idx.push(a, b, c, a, c, d); // outward
    }
  }
  // flat pad under the model (centre fan)
  const centre = pos.length / 3;
  pos.push((x0 + x1) / 2, -0.02, (z0 + z1) / 2);
  for (let i = 0; i < n; i++) idx.push(centre, (i + 1) % n, i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uvs = [];
  for (let i = 0; i < pos.length; i += 3) uvs.push(pos[i] * 0.25, pos[i + 2] * 0.25 + pos[i + 1] * 0.25);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const spec = (s) => s.spec ?? {};
