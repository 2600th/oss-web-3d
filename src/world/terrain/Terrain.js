import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, ivec2, float, uniform, textureLoad, positionLocal, positionWorld,
  floor, clamp, mix, smoothstep, normalize, min, vec4, cameraViewMatrix,
} from 'three/tsl';
import { DEM, EDGE_BLEND, SURROUND_HEIGHT } from './heightfield.js';

/**
 * Foundation terrain: GPU geometry clipmap displaced from the DEM texture.
 *
 * Level 0 is a full N x N grid of `baseCell` metres; level l >= 1 is a ring of
 * cell size baseCell * 2^l around it. Each level snaps to its own grid so the
 * vertices never swim. Heights are fetched with manual bilinear filtering
 * (textureLoad), identical to heightfield.js, so CPU and GPU agree.
 *
 * The terrain owner replaces the placeholder shading (and adds level morphing,
 * detail displacement, material layers, shadows).
 */
export class Terrain {
  constructor(r, { grid = 128, levels = 10, baseCell = 6 } = {}) {
    this.r = r;
    this.grid = grid;
    this.levels = levels;
    this.baseCell = baseCell;
    this.group = new THREE.Group();
    this.group.name = 'terrain';

    const tex = new THREE.DataTexture(DEM.data, DEM.res, DEM.res, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.demTexture = tex;

    this.heightNode = makeHeightNode(tex);
    this.material = this._makeMaterial();

    const full = gridGeometry(grid, false);
    const ring = gridGeometry(grid, true);
    this.levelUniforms = [];
    for (let l = 0; l < levels; l++) {
      const cell = baseCell * 2 ** l;
      const u = { center: uniform(new THREE.Vector2()), cell: uniform(cell) };
      this.levelUniforms.push(u);
      const mat = this.material.clone();
      mat.positionNode = this._positionNode(u);
      const mesh = new THREE.Mesh(l === 0 ? full : ring, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = l < 4;
      mesh.name = `terrain-L${l}`;
      this.group.add(mesh);
    }
  }

  _positionNode(u) {
    const heightAt = this.heightNode;
    return Fn(() => {
      const xz = positionLocal.xz.mul(u.cell).add(u.center);
      const h = heightAt(xz);
      return vec3(xz.x, h, xz.y);
    })();
  }

  _makeMaterial() {
    const heightAt = this.heightNode;
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    // Per-pixel normal from the heightfield.
    const normalW = Fn(() => {
      const p = positionWorld.xz;
      const e = float(12);
      const hl = heightAt(p.sub(vec2(e, 0)));
      const hr = heightAt(p.add(vec2(e, 0)));
      const hb = heightAt(p.sub(vec2(0, e)));
      const hf = heightAt(p.add(vec2(0, e)));
      return normalize(vec3(hl.sub(hr), e.mul(2), hb.sub(hf)));
    })();
    const slope = float(1).sub(normalW.y);
    const alt = positionWorld.y;
    const rock = vec3(0.34, 0.3, 0.27);
    const scree = vec3(0.52, 0.46, 0.39);
    const snow = vec3(0.92, 0.94, 0.97);
    const base = mix(scree, rock, smoothstep(0.15, 0.45, slope));
    const snowLine = smoothstep(4300, 4900, alt).mul(float(1).sub(smoothstep(0.35, 0.6, slope)));
    mat.colorNode = mix(base, snow, snowLine);
    // normalNode is view space.
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(normalW, 0)).xyz);
    return mat;
  }

  update(camera) {
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (let l = 0; l < this.levels; l++) {
      const u = this.levelUniforms[l];
      const snap = u.cell.value * 2;
      u.center.value.set(Math.floor(cx / snap) * snap, Math.floor(cz / snap) * snap);
    }
  }

  addTo(scene) { scene.add(this.group); }

  dispose() {
    this.demTexture.dispose();
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
}


/** TSL function: world xz -> terrain height, mirroring heightfield.terrainHeight. */
export function makeHeightNode(tex) {
  const res = float(DEM.res);
  const minXZ = vec2(DEM.minX, DEM.minZ);
  const maxXZ = vec2(DEM.maxX, DEM.maxZ);
  const cell = vec2(DEM.cellX, DEM.cellZ);
  return Fn(([p]) => {
    const f = clamp(p.sub(minXZ).div(cell), vec2(0), vec2(res.sub(1.0001)));
    const i = floor(f);
    const t = f.sub(i);
    const ii = ivec2(i);
    const a = textureLoad(tex, ii).r;
    const b = textureLoad(tex, ii.add(ivec2(1, 0))).r;
    const c = textureLoad(tex, ii.add(ivec2(0, 1))).r;
    const d = textureLoad(tex, ii.add(ivec2(1, 1))).r;
    const h = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
    const inset = min(min(p.x.sub(minXZ.x), maxXZ.x.sub(p.x)), min(p.y.sub(minXZ.y), maxXZ.y.sub(p.y)));
    const s = smoothstep(0, EDGE_BLEND, inset);
    return mix(float(SURROUND_HEIGHT), h, s);
  });
}

/**
 * Grid of (n x n) cells centred on the origin in unit-cell coordinates,
 * x/z in [-n/2, n/2]. With `ring`, the central n/2 x n/2 cells are removed so
 * the next finer level fits inside.
 */
function gridGeometry(n, ring) {
  const verts = [];
  const idx = [];
  const h = n / 2;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i - h, 0, j - h);
  const q = n / 4;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Hole is one cell smaller per side than the finer level so the two overlap
      // instead of leaving a crack when their snap phases differ.
      if (ring && i >= q + 1 && i < n - q - 1 && j >= q + 1 && j < n - q - 1) continue;
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}
