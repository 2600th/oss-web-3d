import * as THREE from 'three/webgpu';
import { Fn, vec3, vec4, float, uniform, positionLocal, positionWorld, max, abs, clamp, fract, uv } from 'three/tsl';
import { DEM, terrainHeight, waterHeight, riverEdge } from './heightfield.js';
import { AMP_MAX, SURROUND } from './detail.js';
import { buildTerrainTextures } from './textures.js';
import { makeTerrainNodes } from './nodes.js';
import { TerrainLayers } from './layers.js';
import { buildTerrainMaterial, applyShadowHooks } from './material.js';
import { ShadowSweep } from './shadowSweep.js';

/**
 * GPU terrain: a geometry clipmap displaced from the DEM.
 *
 * Structure (Losasso & Hoppe 2004, "Geometry clipmaps"; morphing as in Strugar
 * 2009, "Continuous distance-dependent LOD"): level l is an N x N grid of cells
 * of size cell0 * 2^l centred on the camera and snapped to its own 2-cell
 * lattice, so vertices never swim. Level l draws a ring; the hole is exactly
 * the footprint of level l - 1.
 *
 * Crack-free and pop-free by construction:
 *  - In the outer band of every level, odd vertices slide onto their even
 *    neighbour (weight `alpha`, 0 inside, exactly 1 on the border), and the
 *    height is sampled at the moved position. At alpha = 1 the level *is* the
 *    next coarser grid, vertex for vertex, so adjacent levels share positions.
 *  - Positions are computed in world space in the shader from per-object
 *    uniforms with all meshes at identity, so two levels meeting at a border
 *    feed bit-identical world positions through the same view-projection.
 *  - `alpha` depends on Chebyshev distance to the *camera* (not the snapped
 *    centre), so it never jumps when a level re-centres.
 *  - The same metric includes the camera's clearance above the ground: as the
 *    aircraft climbs, the finest levels morph completely into their parents and
 *    are then dropped (their parent fills the hole) without any change in shape.
 *
 * Each level is 12 fixed blocks plus an L-shaped trim (4 variants, one per
 * parity of the hole) so blocks can be frustum-culled individually.
 *
 * Shading is entirely per pixel from world position (material.js); the CPU
 * mirror of the height function is heightfield.js.
 */

// Grid cells per level side (N), finest cell (m). N/2 * cell = 384 m on every
// tier, so a tier changes angular vertex density, not the level ranges.
const TIERS = {
  low: { N: 128, cell: 6, layerSize: 512, aniso: 2, triplanar: false, octaveBlend: false, fineDetail: false, normalStrength: 1, detailNear: 32, streak: 1.2 },
  // [textures] aniso medium 4 -> 8, high 8 -> 16 (clamped to the device maximum)
  medium: { N: 192, cell: 4, layerSize: 1024, aniso: 8, triplanar: true, octaveBlend: true, fineDetail: true, normalStrength: 1, detailNear: 28, streak: 1.1 },
  high: { N: 256, cell: 3, layerSize: 1024, aniso: 16, triplanar: true, octaveBlend: true, fineDetail: true, normalStrength: 1, detailNear: 24, streak: 1.1 },
  ultra: { N: 384, cell: 2, layerSize: 1024, aniso: 16, triplanar: true, octaveBlend: true, fineDetail: true, normalStrength: 1, detailNear: 24, streak: 1.1 },
};
const LEVELS = 11; // radius of the last level: 384 m * 2^10 = 393 km (camera far plane is 260 km)
// levels with cells up to this size go into the sun shadow map. [shadows] None
// now: the camera-fitted cascades (src/world/shadows/SunShadows.js) carry only
// objects; the terrain's own shadow is the heightfield sweep, which has no acne
// at a grazing sun and was the only terrain shadow outside the old 120 m box anyway.
const SHADOW_CAST_CELL = 0;
// [engine perf] Render layers for the terrain blocks: the main camera sees
// VIEW_LAYER, the sun's shadow camera SHADOW_LAYER (plus layer 0, where every
// other object stays). A block is on one, both or neither (see update()).
export const VIEW_LAYER = 1;
export const SHADOW_LAYER = 2;
const VIEW_MASK = 1 << VIEW_LAYER;
const SHADOW_MASK = 1 << SHADOW_LAYER;

export class Terrain {
  /**
   * @param r     engine Renderer
   * @param opts  { grid, levels } are accepted for compatibility with the
   *              foundation signature; the mesh density actually comes from the
   *              quality tier (table above). `env` (Environment) enables
   *              sun-driven long shadows, cloud shadows and the glitter term.
   */
  constructor(r, { env = null, tier = r?.tier?.name ?? 'high' } = {}) {
    this.r = r;
    this.env = env;
    this.tier = TIERS[tier] ?? TIERS.high;
    this.tierName = TIERS[tier] ? tier : 'high';
    const { N, cell } = this.tier;
    this.grid = N;
    this.baseCell = cell;
    this.levels = LEVELS;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.stats = { finest: 0, visible: 0, total: 0, clearance: 0 };

    const maxAniso = r?.renderer?.getMaxAnisotropy?.() ?? 1;
    const aniso = Math.max(1, Math.min(this.tier.aniso, maxAniso));
    this.textures = buildTerrainTextures(DEM, { aniso });
    this.nodes = makeTerrainNodes(DEM, this.textures);
    this.layers = new TerrainLayers({ size: this.tier.layerSize, aniso });
    // [engine perf] These textures never change after their (last) upload, but
    // three keeps the source arrays: ~170 MB of JS heap at 3073^2 (height,
    // surf, river at 36 MB each, the two layer arrays at 24 MB). Drop them once
    // the GPU has its copy. The layer arrays are rewritten by layers.load(), so
    // only after the loaded upload. (Device loss restarts the page, so nothing
    // ever needs to re-upload them; the shadow texture is dynamic and kept.)
    const release = (tex, ready = () => true) => {
      tex.onUpdate = () => { if (ready() && tex.image?.data) tex.image.data = null; };
    };
    for (const k of ['height', 'outer', 'amp', 'tile', 'surf', 'river', 'outerSurf']) if (this.textures[k]) release(this.textures[k]);
    release(this.layers.albedo, () => this.layers.loaded);
    release(this.layers.nrm, () => this.layers.loaded);
    this.shadow = new ShadowSweep(DEM);
    // [shadows] units and props near the ground take the same heightfield shadow
    if (env) env.terrainShadow = this.shadow.makeShadowFn(this.textures.height, DEM);

    this.uniforms = {
      cam: uniform(new THREE.Vector3()),
      clearance: uniform(0),
      sunDir: uniform(new THREE.Vector3(0.5, 0.6, 0.5).normalize()),
      sunColor: uniform(new THREE.Color(1, 0.95, 0.88)),
      sunVisible: uniform(1),
      skyColor: uniform(new THREE.Color(0.32, 0.5, 0.85)),
      skyReflect: uniform(1),
      shadowTex: this.shadow.texture,
      shadowSoft: uniform(3.5),
      shadowOn: uniform(1),
      shadowCamPos: uniform(new THREE.Vector3()),
      shadowRange: uniform(new THREE.Vector2(-1e9, 1e9)), // near, far of the sun shadow camera along the light
    };
    /** Per-object level data: (centre x, centre z, cell size, unused). */
    this._level = uniform(new THREE.Vector4()).onObjectUpdate(({ object }, self) => {
      const v = object.userData.level;
      if (v) self.value.copy(v);
    });

    this.material = buildTerrainMaterial({
      DEM, tex: this.textures, nodes: this.nodes, layers: this.layers, uniforms: this.uniforms, quality: this.tier,
    });
    this.material.positionNode = this._positionNode();
    this._shadowNode = applyShadowHooks(this.material, env, this.uniforms);
    /** Materials other areas may want to hook (fog, cloud shadow). */
    this.materials = [this.material];

    this._buildMinMax();
    this._buildMeshes();

    /** Resolves when the PBR layer textures are in (the terrain renders flat-coloured until then). */
    this.ready = this.layers.load().catch((e) => { console.warn('[terrain] layer textures failed to load', e); });

    this._frustum = new THREE.Frustum();
    this._pv = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._clear = null;
    if (typeof window !== 'undefined') {
      window.__verifyTerrain = (opts) => this.verify(opts);
    }
  }

  // ---------------------------------------------------------------- vertex stage
  _positionNode() {
    const { N } = this.tier;
    const W = N / 8; // width of the morph band, in cells
    const start = N / 2 - W - 2; // alpha reaches 1 at N/2 - 2 cells: the border, whatever the snap phase
    const u = this.uniforms;
    const lvl = this._level;
    const heightAt = this.nodes.heightAt;
    return Fn(() => {
      const g = positionLocal.xz; // integer grid coordinates in the level
      const cell = lvl.z;
      const w = g.mul(cell).add(lvl.xy);
      const d = max(max(abs(w.x.sub(u.cam.x)), abs(w.y.sub(u.cam.z))), u.clearance).div(cell);
      const alpha = clamp(d.sub(start).div(W), 0, 1);
      const odd = fract(g.mul(0.5)).mul(2); // 1 on odd lattice lines
      const wm = g.sub(odd.mul(alpha)).mul(cell).add(lvl.xy);
      return vec3(wm.x, heightAt(wm), wm.y);
    })();
  }

  // ---------------------------------------------------------------- geometry
  _buildMeshes() {
    const { N, cell } = this.tier;
    const h = N / 2;
    const q = N / 4;
    // Break points along one axis. The middle two spans cover [-q, q + 1]: the
    // footprint of the finer level for either parity of its snap.
    const cuts = [-h, -q, 0, q + 1, h];
    const blocks = [];
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
      if ((a === 1 || a === 2) && (b === 1 || b === 2)) continue;
      blocks.push({ x0: cuts[a], x1: cuts[a + 1], z0: cuts[b], z1: cuts[b + 1] });
    }
    const blockGeo = blocks.map((b) => patch(b.x0, b.z0, b.x1, b.z1));
    // Trim: the middle region minus the finer level's footprint [o - q, o + q].
    const trimGeo = [];
    for (let oz = 0; oz < 2; oz++) for (let ox = 0; ox < 2; ox++) {
      trimGeo.push(patch(-q, -q, q + 1, q + 1, (i, j) => i >= ox - q && i < ox + q && j >= oz - q && j < oz + q));
    }
    const fillGeo = patch(-q, -q, q + 1, q + 1);
    this._geometries = [...blockGeo, ...trimGeo, fillGeo];

    this._levels = [];
    for (let l = 0; l < this.levels; l++) {
      const c = cell * 2 ** l;
      const data = new THREE.Vector4(0, 0, c, 0);
      const mk = (geo, bounds, name) => {
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.name = `terrain-L${l}-${name}`;
        mesh.frustumCulled = false; // culled here, per block, against world-space boxes
        mesh.matrixAutoUpdate = false;
        mesh.receiveShadow = true;
        mesh.castShadow = c <= SHADOW_CAST_CELL;
        mesh.layers.mask = VIEW_MASK; // [engine perf] see update()
        mesh.renderOrder = l; // finest first: near terrain fills depth before far terrain shades
        mesh.userData.level = data;
        mesh.userData.bounds = bounds;
        this.group.add(mesh);
        return mesh;
      };
      const mid = { x0: -q, x1: q + 1, z0: -q, z1: q + 1 };
      this._levels.push({
        cell: c,
        data,
        blocks: blocks.map((b, i) => mk(blockGeo[i], b, `b${i}`)),
        trim: mk(trimGeo[0], mid, 'trim'),
        fill: mk(fillGeo, mid, 'fill'),
        cx: NaN, cz: NaN,
        trimGeo,
        yRange: new Map(),
      });
    }
  }

  /** Coarse min/max of the DEM for the vertical extent of culling boxes. */
  _buildMinMax() {
    const G = 128;
    const n = DEM.res;
    const mn = new Float32Array(G * G).fill(Infinity);
    const mx = new Float32Array(G * G).fill(-Infinity);
    const s = G / n;
    const H = DEM.data;
    for (let j = 0; j < n; j++) {
      const gj = Math.min(G - 1, Math.floor(j * s)) * G;
      for (let i = 0; i < n; i++) {
        const k = gj + Math.min(G - 1, Math.floor(i * s));
        const v = H[j * n + i];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    this._mm = { G, mn, mx };
  }

  /** Conservative height range of the terrain over a world rectangle. */
  _yRange(x0, z0, x1, z1, out) {
    const pad = AMP_MAX * 1.9 + 4; // amplitude times the largest detail value (mix + C + ledge), plus slack
    const span = SURROUND.G0 + SURROUND.G1 + SURROUND.G2;
    let lo = Infinity;
    let hi = -Infinity;
    const inside = x0 >= DEM.minX && x1 <= DEM.maxX && z0 >= DEM.minZ && z1 <= DEM.maxZ;
    if (!inside) {
      // touches the outer DEM or the procedural surround: bound both
      lo = Math.min(SURROUND.BASE - span, 1500);
      hi = Math.max(SURROUND.BASE + span, 7600);
    }
    if (x1 > DEM.minX && x0 < DEM.maxX && z1 > DEM.minZ && z0 < DEM.maxZ) {
      const { G, mn, mx } = this._mm;
      const fx = G / (DEM.maxX - DEM.minX);
      const fz = G / (DEM.maxZ - DEM.minZ);
      const i0 = Math.max(0, Math.floor((x0 - DEM.minX) * fx) - 1);
      const i1 = Math.min(G - 1, Math.floor((x1 - DEM.minX) * fx) + 1);
      const j0 = Math.max(0, Math.floor((z0 - DEM.minZ) * fz) - 1);
      const j1 = Math.min(G - 1, Math.floor((z1 - DEM.minZ) * fz) + 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * G + i;
        if (mn[k] < lo) lo = mn[k];
        if (mx[k] > hi) hi = mx[k];
      }
    }
    out[0] = lo - pad;
    out[1] = hi + pad;
    return out;
  }

  /** Smallest distance from the camera to the ground around it (the LOD metric's vertical term). */
  _clearance(p) {
    let best = Math.max(0, p.y - terrainHeight(p.x, p.z));
    for (const r of [120, 300, 700, 1500]) {
      if (best < r * 0.5) break; // nothing that far out can be nearer
      for (let a = 0; a < 8; a++) {
        const dx = Math.cos(a * 0.7854) * r;
        const dz = Math.sin(a * 0.7854) * r;
        const dy = Math.max(0, p.y - terrainHeight(p.x + dx, p.z + dz));
        const d = Math.hypot(r, dy);
        if (d < best) best = d;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- per frame
  update(camera) {
    const { N } = this.tier;
    const u = this.uniforms;
    const p = camera.position;
    u.cam.value.copy(p);

    // Vertical LOD term, eased so it never steps.
    const target = this._clearance(p) * 0.9;
    this._clear = this._clear === null ? target : this._clear + (target - this._clear) * 0.2;
    u.clearance.value = this._clear;

    // Finest level still doing anything: the first one not fully morphed away.
    let finest = 0;
    while (finest < this.levels - 2 && this._clear >= (N / 2 - 2) * this._levels[finest].cell) finest++;

    camera.updateMatrixWorld();
    this._inv.copy(camera.matrixWorld).invert();
    this._pv.multiplyMatrices(camera.projectionMatrix, this._inv);
    this._frustum.setFromProjectionMatrix(this._pv, camera.coordinateSystem, camera.reversedDepth);

    // [engine perf] layer setup + the sun's shadow frustum for caster culling
    // (Game updates env before terrain, so the sun already sits on the focus).
    camera.layers.enable(VIEW_LAYER);
    const sun = this.env?.sun;
    let shadowFrustum = null;
    if (sun?.castShadow && sun.shadow) {
      // A shadow camera mask with any bit above layer 0 is used as-is by three
      // (ShadowNode); otherwise it would copy the main camera's mask.
      sun.shadow.camera.layers.mask = 1 | SHADOW_MASK;
      sun.updateMatrixWorld();
      sun.target.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      shadowFrustum = sun.shadow.getFrustum();
    }

    let visible = 0;
    let total = 0;
    for (let l = 0; l < this.levels; l++) {
      const L = this._levels[l];
      const snap = L.cell * 2;
      const cx = Math.floor(p.x / snap) * snap;
      const cz = Math.floor(p.z / snap) * snap;
      const moved = cx !== L.cx || cz !== L.cz;
      if (moved) { L.cx = cx; L.cz = cz; L.data.set(cx, cz, L.cell, 0); L.yRange.clear(); }
      const active = l >= finest;
      const isFinest = l === finest;
      if (active && !isFinest) {
        // Parity of the finer level's centre on this level's lattice picks the trim.
        const fx = Math.floor(p.x / L.cell) * L.cell; // finer centre (its snap == this cell)
        const fz = Math.floor(p.z / L.cell) * L.cell;
        const ox = Math.round((fx - cx) / L.cell);
        const oz = Math.round((fz - cz) / L.cell);
        L.trim.geometry = L.trimGeo[oz * 2 + ox];
      }
      // [engine perf] Each block is tested twice: against the view frustum
      // (layer VIEW_LAYER, main camera) and, for shadow casters, against the
      // sun's shadow frustum (layer SHADOW_LAYER, shadow camera). Before, the
      // caster levels were never culled at all, so the shadow pass and the
      // main pass drew every block of the four finest levels, including the
      // ones behind the camera and kilometres outside the 120 m shadow box.
      const caster = L.blocks[0].castShadow && shadowFrustum !== null;
      const test = (mesh, on) => {
        if (!on) { mesh.visible = false; return; }
        total++;
        const b = mesh.userData.bounds;
        // one cell of slack: morphing slides border vertices onto the parent lattice
        const x0 = cx + (b.x0 - 1) * L.cell;
        const x1 = cx + (b.x1 + 1) * L.cell;
        const z0 = cz + (b.z0 - 1) * L.cell;
        const z1 = cz + (b.z1 + 1) * L.cell;
        let r = L.yRange.get(mesh);
        if (!r) { r = this._yRange(x0, z0, x1, z1, [0, 0]); L.yRange.set(mesh, r); }
        this._box.min.set(x0, r[0], z0);
        this._box.max.set(x1, r[1], z1);
        const inView = this._frustum.intersectsBox(this._box);
        const inShadow = caster && shadowFrustum.intersectsBox(this._box);
        mesh.layers.mask = (inView ? VIEW_MASK : 0) | (inShadow ? SHADOW_MASK : 0);
        mesh.visible = inView || inShadow;
        if (inView) visible++;
      };
      for (const b of L.blocks) test(b, active);
      test(L.trim, active && !isFinest);
      test(L.fill, isFinest);
    }
    this.stats.finest = finest;
    this.stats.visible = visible;
    this.stats.total = total;
    this.stats.clearance = this._clear;

    // Lighting inputs from the environment.
    const env = this.env;
    if (env?.sunDirection) {
      u.sunDir.value.copy(env.sunDirection);
      u.sunVisible.value = THREE.MathUtils.smoothstep(env.sunDirection.y, -0.02, 0.06);
      this.shadow.update(env.sunDirection);
    }
    const sh = env?.sun?.shadow?.camera;
    if (sh) {
      u.shadowCamPos.value.copy(env.sun.position);
      u.shadowRange.value.set(sh.near, sh.far * 0.98);
    }
    // Someone re-installed the cloud shadow on our material: wrap it again.
    if (this.material.receivedShadowNode !== this._shadowNode) {
      this._shadowNode = applyShadowHooks(this.material, env, u);
    }
    if (env?.sun?.color) u.sunColor.value.copy(env.sun.color);
    if (env?.ambient?.color) u.skyColor.value.copy(env.ambient.color).multiplyScalar(env.ambient.intensity ?? 1);
    u.skyReflect.value = this._scene?.environment ? 0 : 1;
  }

  addTo(scene) {
    this._scene = scene;
    scene.add(this.group);
  }

  /** Ground height at (x, z): heightfield.terrainHeight, for callers that hold the terrain. */
  height(x, z) { return terrainHeight(x, z); }
  /** Water surface height at (x, z), or -Infinity where there is no river. */
  waterHeight(x, z) { return waterHeight(x, z); }
  /** Metres to the nearest river bank (negative in the water). */
  riverEdge(x, z) { return riverEdge(x, z); }

  /**
   * Compare the GPU height function with heightfield.terrainHeight.
   * Renders heightAt() for a grid of world points into a float target, reads it
   * back and diffs against the CPU. Returns per-region max/mean error in metres.
   */
  async verify({ size = 96 } = {}) {
    const renderer = this.r.renderer;
    const rt = new THREE.RenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false });
    rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
    const origin = uniform(new THREE.Vector2());
    const extent = uniform(new THREE.Vector2());
    const mat = new THREE.NodeMaterial();
    const xz = origin.add(uv().mul(extent));
    mat.fragmentNode = vec4(this.nodes.heightAt(xz), xz.x, xz.y, float(1));
    const quad = new THREE.QuadMesh(mat);
    const c = this.uniforms.cam.value;
    const regions = {
      'near camera (2 km)': [c.x - 1000, c.z - 1000, 2000, 2000],
      'near camera (200 m)': [c.x - 100, c.z - 100, 200, 200],
      'whole DEM': [DEM.minX, DEM.minZ, DEM.maxX - DEM.minX, DEM.maxZ - DEM.minZ],
      'DEM edge seam': [DEM.minX - 2000, -6000, 5000, 12000],
      'outer + procedural (400 km)': [-200000, -200000, 400000, 400000],
    };
    const report = {};
    for (const [name, [x, z, w, d]] of Object.entries(regions)) {
      origin.value.set(x, z);
      extent.value.set(w, d);
      renderer.setRenderTarget(rt);
      quad.render(renderer);
      renderer.setRenderTarget(null);
      const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
      let worst = 0;
      let sum = 0;
      let at = null;
      for (let i = 0; i < size * size; i++) {
        // Use the position the GPU actually evaluated (returned in g, b).
        const gpu = px[i * 4];
        const cpu = terrainHeight(px[i * 4 + 1], px[i * 4 + 2]);
        const e = Math.abs(gpu - cpu);
        sum += e;
        if (e > worst) { worst = e; at = [px[i * 4 + 1], px[i * 4 + 2], gpu, cpu]; }
      }
      report[name] = { maxError: +worst.toFixed(4), meanError: +(sum / (size * size)).toFixed(5), samples: size * size, worstAt: at?.map((v) => +v.toFixed(2)) };
    }
    rt.dispose();
    mat.dispose();
    console.table(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { max: v.maxError, mean: v.meanError }])));
    return report;
  }

  /**
   * Dev measurement: render only the terrain (plus lights, so shading and the
   * shadow pass are real) into an off-screen target `frames` times and wait for
   * the GPU to finish. Returns milliseconds per frame, and the same for an
   * empty scene so the fixed per-frame overhead can be subtracted (best of
   * `rounds`, because other tabs share the GPU).
   */
  async gpuTime({ width = 2560, height = 1440, frames = 30, rounds = 4 } = {}) {
    const renderer = this.r.renderer;
    const camera = this.r.camera;
    const scene = this._scene;
    const rt = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: true });
    const hidden = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let inTerrain = false;
      for (let q = o; q; q = q.parent) if (q === this.group) inTerrain = true;
      if (!inTerrain) { hidden.push(o); o.visible = false; }
    });
    const flush = async () => {
      const device = renderer.backend.device;
      if (device) await device.queue.onSubmittedWorkDone();
      else renderer.backend.gl?.finish();
    };
    // With ?gputime the renderer records timestamp queries: the real duration of
    // the passes, which also holds in a background tab.
    const stamped = !!renderer.backend.trackTimestamp && typeof renderer.resolveTimestampsAsync === 'function';
    const run = async () => {
      if (stamped) {
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);
        await renderer.resolveTimestampsAsync('render');
        // Chrome quantises the queries (~66 us): take the median of the frames
        const got = [];
        for (let i = 0; i < frames; i++) {
          renderer.setRenderTarget(rt); // the game loop may render in between
          renderer.render(scene, camera);
          const ms = await renderer.resolveTimestampsAsync('render');
          got.push(Number.isFinite(ms) ? ms : renderer.info.render.timestamp || 0);
        }
        got.sort((a, b) => a - b);
        renderer.setRenderTarget(null);
        return { total: got[got.length >> 1], submit: 0 };
      }
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera); // warm-up (pipelines)
      await flush();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) renderer.render(scene, camera);
      const t1 = performance.now();
      await flush();
      const t2 = performance.now();
      renderer.setRenderTarget(null);
      return { total: (t2 - t0) / frames, submit: (t1 - t0) / frames };
    };
    // Other tabs share the GPU: take the best of several rounds of each.
    let terrain = null;
    let empty = null;
    for (let i = 0; i < rounds; i++) {
      const a = await run();
      if (!terrain || a.total < terrain.total) terrain = a;
      this.group.visible = false;
      const b = await run();
      this.group.visible = true;
      if (!empty || b.total < empty.total) empty = b;
    }
    for (const o of hidden) o.visible = true;
    rt.dispose();
    const info = renderer.info.render;
    return {
      width, height,
      method: stamped ? 'timestamp-query' : 'queue-flush',
      terrainMs: +(terrain.total - empty.total).toFixed(3),
      totalMs: +terrain.total.toFixed(3),
      submitMs: +terrain.submit.toFixed(3),
      emptyMs: +empty.total.toFixed(3),
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      blocks: `${this.stats.visible}/${this.stats.total}`,
    };
  }

  /**
   * Dev check for holes and over-eager culling. From `views` random camera poses:
   *  - looking straight down, every pixel must be terrain: any background pixel
   *    is a crack between levels (or a missing block);
   *  - at an oblique angle, the image with per-block culling must equal the
   *    image with every block forced visible.
   * Returns the number of offending pixels of each kind (both should be 0).
   */
  async crackTest({ views = 24, size = 768, seed = 7 } = {}) {
    const renderer = this.r.renderer;
    const scene = this._scene;
    const rt = new THREE.RenderTarget(size, size, { depthBuffer: true });
    const cam = new THREE.PerspectiveCamera(62, 1, 0.5, 260000);
    cam.rotation.order = 'YXZ';
    const hidden = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let inTerrain = false;
      for (let q = o; q; q = q.parent) if (q === this.group) inTerrain = true;
      if (!inTerrain) { hidden.push(o); o.visible = false; }
    });
    const prevBg = scene.background;
    scene.background = new THREE.Color(1, 0, 1);
    // A time-independent stand-in for the surface (rivers and glitter animate):
    // same vertex stage, colour from height.
    const flat = new THREE.MeshBasicNodeMaterial();
    flat.positionNode = this.material.positionNode;
    flat.colorNode = vec3(fract(positionWorld.y.mul(0.037)).mul(0.8), fract(positionWorld.x.mul(0.0113)).mul(0.8), 0.2);
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = flat;
    let s = seed;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
    const shoot = async () => {
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      return renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
    };
    const isBg = (px, i) => px[i] > 240 && px[i + 1] < 16 && px[i + 2] > 240;
    let cracks = 0;
    let culled = 0;
    const worst = [];
    for (let v = 0; v < views; v++) {
      const x = (rnd() - 0.5) * 70000;
      const z = (rnd() - 0.5) * 70000;
      const agl = 30 * 2 ** (rnd() * 8); // 30 m .. 7.7 km
      cam.position.set(x, terrainHeight(x, z) + agl, z);
      // straight down
      cam.rotation.set(-Math.PI / 2, rnd() * 6.28, 0);
      cam.updateMatrixWorld(true);
      this._clear = null;
      this.update(cam);
      let px = await shoot();
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (isBg(px, i)) n++;
      if (n) worst.push({ x: Math.round(x), z: Math.round(z), agl: Math.round(agl), cracks: n });
      cracks += n;
      // oblique: culled vs everything
      cam.rotation.set(-0.15 - rnd() * 0.6, rnd() * 6.28, 0);
      cam.updateMatrixWorld(true);
      this._clear = null;
      this.update(cam);
      px = await shoot();
      // the game loop may have run its own update() while the pixels were read back
      this._clear = null;
      this.update(cam);
      const before = [];
      this.group.traverse((o) => { if (o.isMesh) before.push([o, o.visible, o.layers.mask]); });
      const finest = this.stats.finest;
      for (let l = finest; l < this.levels; l++) {
        const L = this._levels[l];
        for (const b of L.blocks) { b.visible = true; b.layers.enable(VIEW_LAYER); }
      }
      const all = await shoot();
      for (const [o, vis, mask] of before) { o.visible = vis; o.layers.mask = mask; }
      let d = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] !== all[i] || px[i + 1] !== all[i + 1] || px[i + 2] !== all[i + 2]) d++;
      if (d) worst.push({ x: Math.round(x), z: Math.round(z), agl: Math.round(agl), culledPixels: d });
      culled += d;
    }
    scene.background = prevBg;
    scene.overrideMaterial = prevOverride;
    flat.dispose();
    for (const o of hidden) o.visible = true;
    rt.dispose();
    this._clear = null;
    return { views, pixelsPerView: size * size, crackPixels: cracks, culledPixels: culled, worst: worst.slice(0, 8) };
  }

  dispose() {
    for (const t of Object.values(this.textures)) t.dispose();
    this.layers.dispose();
    this.shadow.dispose();
    for (const g of this._geometries) g.dispose();
    this.material.dispose();
    if (typeof window !== 'undefined' && window.__verifyTerrain) delete window.__verifyTerrain;
  }
}

/**
 * Grid patch over integer cells [x0, x1] x [z0, z1] in level-local lattice
 * coordinates; `skip(i, j)` removes cell (i, j). Vertices carry the lattice
 * coordinate in position.xz; the shader places them.
 */
function patch(x0, z0, x1, z1, skip = null) {
  const index = new Map();
  const verts = [];
  const idx = [];
  const w = x1 - x0 + 1;
  const vert = (i, j) => {
    const key = (j - z0) * w + (i - x0);
    let v = index.get(key);
    if (v === undefined) { v = verts.length / 3; verts.push(i, 0, j); index.set(key, v); }
    return v;
  };
  for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) {
    if (skip && skip(i, j)) continue;
    const a = vert(i, j);
    const b = vert(i + 1, j);
    const c = vert(i, j + 1);
    const d = vert(i + 1, j + 1);
    idx.push(a, c, b, b, c, d); // same diagonal everywhere: morphed cells collapse onto the parent's triangles
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e9, -1e9, -1e9), new THREE.Vector3(1e9, 1e9, 1e9));
  return g;
}
