import * as THREE from 'three/webgpu';
import {
  texture, uv, float, vec3, clamp, luminance, mix, normalView, positionViewDirection, dot, pow, oneMinus,
  positionLocal, mx_noise_float, bumpMap, smoothstep,
} from 'three/tsl';

/**
 * Runtime material recipes for the art assets (shared by the player jet in
 * src/flight/Aircraft.js and everything loadModel hands out).
 *
 * The GLBs come from GLTFLoader as classic three materials. Here they become
 * node materials, which (a) take `env.applyCloudShadow` (a classic material's
 * `receivedShadowNode` is only copied once, when the renderer first converts it)
 * and (b) let us add the TSL detail below.
 *
 * MiG-21: the source textures carry no metal/roughness map and every skin
 * material shipped matte (roughness 0.88-1.0, metalness 0), so under the
 * physical sky the airframe read as grey card. Paint here is semi-gloss: base
 * roughness ~0.42 with the texture's own grime/panel-line contrast (texel vs. a
 * blurred mip of itself) pushing dirty areas rougher, a little metalness so the
 * sky reflection takes the paint colour, and on the player a thin clearcoat.
 * The canopy is clear glass: almost transparent head-on, a Fresnel-weighted
 * reflection of `scene.environment` toward grazing angles.
 *
 * Ground units: a procedural 3D detail normal (dents, weld seams, stone grain)
 * and a faint large-scale albedo breakup, so a baked 1k atlas still holds up
 * in the recon optic at 200-300 m. Skipped on the `low` tier.
 */

const converted = new WeakMap(); // source material -> node material (per recipe key)
const originals = new WeakMap(); // mesh -> the material it had before any upgrade

const COPY = [
  'name', 'map', 'lightMap', 'lightMapIntensity', 'aoMap', 'aoMapIntensity', 'emissiveIntensity', 'emissiveMap',
  'bumpMap', 'bumpScale', 'normalMap', 'normalMapType', 'displacementMap', 'roughness', 'roughnessMap',
  'metalness', 'metalnessMap', 'alphaMap', 'envMapIntensity', 'flatShading', 'side', 'transparent', 'opacity',
  'alphaTest', 'depthWrite', 'depthTest', 'vertexColors', 'blending', 'alphaToCoverage', 'polygonOffset',
  'polygonOffsetFactor', 'polygonOffsetUnits', 'shadowSide', 'visible',
  // physical (KHR_materials_specular / ior on the MiG)
  'ior', 'specularIntensity', 'specularIntensityMap', 'specularColorMap',
];

/** A node-material copy of a classic three material (textures shared). */
export function toNodeMaterial(src, Klass = null) {
  if (!src) return src;
  const K = Klass ?? (src.isMeshPhysicalMaterial ? THREE.MeshPhysicalNodeMaterial : THREE.MeshStandardNodeMaterial);
  const m = new K();
  for (const k of COPY) if (src[k] !== undefined && k in m) m[k] = src[k];
  if (src.color) m.color.copy(src.color);
  if (src.emissive) m.emissive.copy(src.emissive);
  if (src.normalScale && m.normalScale) m.normalScale.copy(src.normalScale);
  if (src.specularColor && m.specularColor) m.specularColor.copy(src.specularColor);
  m.userData = { ...src.userData, sourceMaterial: src.uuid };
  return m;
}

function memo(src, key, build) {
  let byKey = converted.get(src);
  if (!byKey) converted.set(src, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, build());
  return byKey.get(key);
}

// ------------------------------------------------------------------ aircraft

const GLASS = /canopy|glass/i;
const INTERIOR = /cockpit/i;

/** Fresnel-weighted opacity: clear head-on, mirror-like toward grazing angles. */
function glassOpacity(base, edge) {
  const ndv = clamp(dot(normalView, positionViewDirection).abs(), 0, 1);
  const f = pow(oneMinus(ndv), 4);
  return float(base).add(f.mul(edge - base));
}

/** Grime/panel-line driven roughness from the albedo map itself (no ORM in the source). */
function paintRoughness(map, base, range) {
  if (!map) return float(base);
  const t = texture(map, uv());
  const local = luminance(t.rgb);
  const blurred = luminance(texture(map, uv()).level(float(5)).rgb);
  // darker than its neighbourhood (panel lines, soot, worn paint) = rougher
  return clamp(float(base).add(blurred.sub(local).mul(range * 2.2)).add(local.mul(-0.08)), 0.22, 0.85);
}

/**
 * Upgrade an aircraft model's materials in place (meshes get node materials).
 * @param {THREE.Object3D} root
 * @param {{tier?: string, role?: 'player'|'hostile', env?: object}} opts
 */
export function upgradeAircraftMaterials(root, { tier = 'high', role = 'player', env = null } = {}) {
  const low = tier === 'low';
  const rich = role === 'player' && !low;
  const key = `ac|${tier}|${role}`;
  root.traverse((o) => {
    if (!o.isMesh) return;
    // re-running (another tier) starts again from the GLB's own materials
    if (!originals.has(o)) originals.set(o, o.material);
    const srcMat = originals.get(o);
    const list = Array.isArray(srcMat) ? srcMat : [srcMat];
    const out = list.map((src) => {
      if (!src || src.isNodeMaterial) return src;
      const name = `${o.name} ${src.name}`;
      // `glass_misc` (source Object_3) is a large dark alpha sheet around the tail that the
      // source exporter left in; as a classic material it never shows, as a node material
      // it draws as a smoked disc. Leave it exactly as loaded.
      if (/glass_misc/.test(o.name)) return src;
      return memo(src, key, () => {
        if (GLASS.test(o.name) && src.transparent) {
          // canopy + small glazing (glass_misc): clear, coated, reflective
          const g = low ? toNodeMaterial(src, THREE.MeshStandardNodeMaterial) : toNodeMaterial(src, THREE.MeshPhysicalNodeMaterial);
          const canopy = /canopy/i.test(name);
          g.color.setRGB(0.02, 0.026, 0.03);
          g.roughness = 0.04;
          g.metalness = 0;
          g.transparent = true;
          g.depthWrite = false;
          g.side = THREE.DoubleSide;
          g.envMapIntensity = 1.6;
          if (!low) {
            g.clearcoat = 1;
            g.clearcoatRoughness = 0.02;
            g.ior = 1.52;
            g.specularIntensity = 1;
          }
          g.opacityNode = glassOpacity(canopy ? 0.1 : 0.45, canopy ? 0.82 : 0.9);
          g.userData.glass = true;
          return g;
        }
        const m = toNodeMaterial(src, rich && !INTERIOR.test(o.name) ? THREE.MeshPhysicalNodeMaterial : THREE.MeshStandardNodeMaterial);
        if (INTERIOR.test(o.name)) {
          m.roughness = 0.7;
          m.metalness = 0.05;
          return m;
        }
        // painted metal skin
        m.metalness = role === 'hostile' ? 0.22 : 0.18;
        m.roughness = 0.44;
        m.envMapIntensity = 1;
        if (!low) m.roughnessNode = paintRoughness(m.map, role === 'hostile' ? 0.46 : 0.42, 0.35);
        if (m.isMeshPhysicalNodeMaterial) {
          m.clearcoat = 0.16;
          m.clearcoatRoughness = 0.24;
          m.specularIntensity = 1;
        }
        return m;
      });
    });
    o.material = Array.isArray(o.material) ? out : out[0];
    const glass = out.some((m) => m?.userData?.glass);
    o.castShadow = !glass;
    o.receiveShadow = true;
    if (glass) o.renderOrder = 2; // after the cockpit it covers
    if (env) for (const m of out) if (m && !m.userData?.glass) env.applyCloudShadow(m);
  });
  return root;
}

// ------------------------------------------------------------------ ground units

/**
 * Ground props / units: node materials with a procedural detail normal and a
 * low-frequency albedo breakup (object space, so it sticks to the model).
 */
export function upgradeGroundMaterials(root, { tier = 'high', env = null } = {}) {
  const low = tier === 'low';
  const key = `gr|${tier}`;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const out = list.map((src) => {
      if (!src || src.isNodeMaterial || !src.isMeshStandardMaterial) return src;
      return memo(src, key, () => {
        const m = toNodeMaterial(src, THREE.MeshStandardNodeMaterial);
        if (low || src.userData?.noDetail) return m;
        const burned = !!src.userData?.burned;
        const p = positionLocal;
        // two octaves of 3D noise: fine (pitting, weld seams, stone grain) + medium (dents)
        const fine = mx_noise_float(p.mul(burned ? 9 : 6.5));
        const mid = mx_noise_float(p.mul(1.7).add(vec3(3.1, 7.7, 1.3)));
        const height = fine.mul(0.35).add(mid.mul(0.65));
        m.normalNode = bumpMap(height, float(burned ? 0.06 : 0.035));
        // faint dust/fade breakup over a few metres, darker low down
        const breakup = mx_noise_float(p.mul(0.45).add(vec3(11, 2, 5))).mul(0.5).add(0.5);
        const low01 = smoothstep(0.0, 1.2, p.y);
        const tint = mix(float(0.86), float(1.06), breakup).mul(mix(float(0.9), float(1), low01));
        const col = vec3(m.color.r, m.color.g, m.color.b);
        m.colorNode = m.map ? texture(m.map, uv()).rgb.mul(col).mul(tint) : col.mul(tint);
        return m;
      });
    });
    o.material = Array.isArray(o.material) ? out : out[0];
    if (env) for (const m of out) if (m?.isNodeMaterial) env.applyCloudShadow(m);
  });
  return root;
}

/** Cloud shadows on every node material under `root` (idempotent; cheap to repeat). */
export function applyCloudShadows(root, env) {
  if (!env?.applyCloudShadow) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) if (m?.isNodeMaterial && !m.userData?.glass) env.applyCloudShadow(m);
  });
}
