import * as THREE from 'three/webgpu';
import {
  texture, uv, float, int, vec3, vec4, clamp, luminance, mix, normalView, positionViewDirection, dot, pow, oneMinus,
  positionLocal, normalLocal, mx_noise_float, bumpMap, normalMap, vec2, smoothstep, lights,
} from 'three/tsl';
import { premultipliedGlassClass, setupGlass, setupLensGlass, bindGlassEnv } from './glass.js'; // [glass]

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
 * [mig skin] The shipped MiG GLBs now carry a baked `<part>_orm` map (ambient
 * occlusion, roughness, metalness) and a panel-line normal map
 * (tools/blender/build-mig-skin.mjs); when it is present the heuristic above
 * is replaced by the authored maps and there is no clearcoat.
 * The canopy is clear glass: almost transparent head-on, a Fresnel-weighted
 * reflection of `scene.environment` toward grazing angles.
 *
 * Ground units: a procedural 3D detail normal (dents, weld seams, stone grain)
 * and a faint large-scale albedo breakup, so a baked 1k atlas still holds up
 * in the recon optic at 200-300 m. Skipped on the `low` tier.
 */

const converted = new WeakMap(); // source material -> node material (per recipe key)
const originals = new WeakMap(); // mesh -> the material it had before any upgrade

// [textures] Texture filtering. GLTFLoader leaves every texture at anisotropy
// 1, so the skin, the cockpit consoles and every unit atlas blurred to mush at
// grazing angles (wing tops from the chase camera, side consoles from the
// seat). The assets system sets the device maximum (configureAssets); `low`
// stays at 4.
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'specularIntensityMap', 'specularColorMap', 'alphaMap'];
let maxAnisotropy = 8;
/** Anisotropic filtering applied to model textures from now on (clamped to >= 1). */
export function setTextureAnisotropy(n) { maxAnisotropy = Math.max(1, n | 0); }
function filterTextures(m, tier) {
  const a = tier === 'low' ? Math.min(4, maxAnisotropy) : maxAnisotropy;
  for (const k of TEX_SLOTS) {
    const t = m[k];
    if (!t?.isTexture || t.anisotropy === a) continue;
    t.anisotropy = a;
    t.needsUpdate = true;
  }
}

/**
 * Albedo with a light unsharp mask against a blurrier mip of itself: the MiG
 * atlases are 1024 px for the whole airframe, so in a close chase shot every
 * texel is magnified 5-10x and panel lines, stencils and the roundel rims went
 * soft. Edges regain contrast; flat paint is unchanged. One extra fetch.
 */
function sharpenedColor(m, amount) {
  const map = m.map;
  const t = texture(map, uv(map.channel ?? 0));
  const soft = texture(map, uv(map.channel ?? 0)).bias(float(1.6));
  const rgb = clamp(t.rgb.add(t.rgb.sub(soft.rgb).mul(amount)), 0, 1);
  return vec4(rgb.mul(vec3(m.color.r, m.color.g, m.color.b)), t.a);
}

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
// [mig skin] Cockpit tub. The bake is the geometric sky visibility; the gain
// stands for light bounced between the tub's own surfaces, which the bake
// does not carry. COCKPIT_RECESS is the albedo left in a fully enclosed texel.
const COCKPIT_AO_GAIN = 1.3;
const COCKPIT_RECESS = 0.55;

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
      return memo(src, key, () => {
        // [glass] canopy and the nav-light lenses (`glass_misc`: three ~3 cm covers on the
        // wingtips and fin tip, not a sheet). Premultiplied glass: reflections at full
        // strength, the background dimmed by Fresnel coverage (see src/assets/glass.js).
        if (GLASS.test(o.name) && src.transparent) {
          const g = toNodeMaterial(src, premultipliedGlassClass(low ? THREE.MeshStandardNodeMaterial : THREE.MeshPhysicalNodeMaterial));
          if (/glass_misc/.test(name)) return setupLensGlass(g, { low });
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const { min, max } = o.geometry.boundingBox;
          return setupGlass(g, { canopy: /canopy/i.test(name), low, box: { min: min.toArray(), max: max.toArray() } });
        }
        // [mig skin] `<part>_orm`: baked occlusion (R), roughness (G) and
        // metalness (B) in one texture (tools/blender/build-mig-skin.mjs).
        const orm = src.aoMap && src.aoMap === src.roughnessMap ? src.aoMap : null;
        const m = toNodeMaterial(src, rich && !orm && !INTERIOR.test(o.name) ? THREE.MeshPhysicalNodeMaterial : THREE.MeshStandardNodeMaterial);
        filterTextures(m, tier);
        let ormTexel = null;
        if (orm) {
          // one fetch feeds all three inputs (the map slots would sample it three times)
          m.aoMap = m.roughnessMap = m.metalnessMap = null;
          m.roughness = 1;
          m.metalness = 1;
          ormTexel = texture(orm, uv(orm.channel ?? 0));
        }
        if (/pitot/.test(o.name)) {
          // [textures] the source ships this nose sensor with the exporter's
          // missing-texture magenta (1, 0, 1); a dark grey metal fitting
          m.color.setRGB(0.12, 0.12, 0.13);
          m.metalness = 0.6;
          m.roughness = 0.45;
          return m;
        }
        if (INTERIOR.test(o.name)) {
          m.roughness = 0.7;
          m.metalness = 0.05;
          // [realism] Cockpit tub occlusion. Inside the tub a surface sees the
          // sky only through the canopy aperture (and the coaming hides it
          // from the panel face), but the environment map and the hemisphere
          // fill light it as if it stood in the open: the panel read as bright
          // as the airframe outside. A constant occlusion on indirect light
          // (screen-space GTAO multiplies on top of it; the sun is untouched).
          if (ormTexel) {
            // [mig skin] The constant is replaced by the baked occlusion: the
            // tub walls, the coaming, the panel shroud and the canopy frame
            // each take their own share of sky away, so the panel face and
            // the footwell sit well under the sills. AO only scales indirect
            // light; a texel that sees almost no sky is almost never reached
            // by the sun either (the shadow map cannot resolve gauge bezels),
            // so the deepest recesses also lose some albedo.
            const ao = ormTexel.r;
            m.aoNode = low ? ao : ao.mul(COCKPIT_AO_GAIN);
            m.roughnessNode = ormTexel.g;
            m.metalnessNode = float(0.03);
            const recess = mix(float(COCKPIT_RECESS), float(1), smoothstep(0.02, 0.4, ao));
            const base = !low && m.map ? sharpenedColor(m, 0.35) : m.map ? texture(m.map, uv(m.map.channel ?? 0)).mul(vec4(m.color.r, m.color.g, m.color.b, 1)) : vec4(m.color.r, m.color.g, m.color.b, 1);
            m.colorNode = vec4(base.rgb.mul(recess), base.a);
            return m;
          }
          if (!low) m.aoNode = float(0.42);
          if (!low && m.map) m.colorNode = sharpenedColor(m, 0.35); // [textures]
          return m;
        }
        if (ormTexel) {
          // [mig skin] Painted skin with authored maps. Paint is a dielectric
          // (the map's metalness is 0 there, 0.9 on bare metal and chipped
          // edges); roughness varies panel to panel, rises in soot, grime and
          // scuffs and falls in wet streaks. No clearcoat: service paint is
          // satin, and a coat over soot and bare metal is wrong.
          m.aoNode = ormTexel.r;
          m.roughnessNode = ormTexel.g;
          m.metalnessNode = ormTexel.b;
          m.envMapIntensity = 1;
          // the 2048 px player airframe has its sharpening baked in
          const big = (m.map?.image?.width ?? 0) >= 2048;
          if (!low && m.map && !big) m.colorNode = sharpenedColor(m, role === 'player' ? 0.45 : 0.35);
          return m;
        }
        if (!low && m.map) m.colorNode = sharpenedColor(m, role === 'player' ? 0.55 : 0.4); // [textures]
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
    // Only the key light (sun / moon) and the environment reflect in the glass.
    // The pooled VFX point lights include the amber panel flood a few
    // decimetres from the canopy at night; on a 0.04-roughness surface that
    // close it made a bright orb hanging over the nose in the cockpit view,
    // wherever the light was placed. (Outside memo(): env arrives later via
    // Aircraft.configure and the memo key does not include it.)
    if (env?.sun?.isLight) {
      bindGlassEnv(env); // [glass] key light for the canopy dust scatter
      for (const m of out) if (m?.userData?.glass && m.userData.keyLightOnly !== env.sun) {
        m.lightsNode = lights([env.sun]);
        m.userData.keyLightOnly = env.sun;
        m.needsUpdate = true;
      }
    }
  });
  return root;
}

// ------------------------------------------------------------------ ground units

/**
 * [textures] Detail source for ground units: a texture array layer and its mean
 * luminance (the terrain's ground layers, so it costs no download). Set by the
 * assets system before models load; until then units keep the noise-only recipe.
 */
let detail = null;
export function setGroundDetail(d) {
  detail = d?.albedo ? { albedo: d.albedo, layer: d.layer ?? 0, meanLum: d.meanLum ?? 0.18 } : null;
}

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
      // Parts authored as physical materials (KHR_materials_clearcoat: the
      // pilot's visor) stay physical and take no ground detail.
      if (src.isMeshPhysicalMaterial && src.clearcoat > 0) {
        return memo(src, `${key}|coat`, () => {
          const m = toNodeMaterial(src);
          m.clearcoat = src.clearcoat;
          m.clearcoatRoughness = src.clearcoatRoughness;
          return m;
        });
      }
      return memo(src, key, () => {
        const m = toNodeMaterial(src, THREE.MeshStandardNodeMaterial);
        filterTextures(m, tier);
        // Ground kit is built from open, single-sided shells (tarps, bed planks,
        // fenders, nets). The default shadow side for a front-faced material is
        // the back face, so a shell lit from its front cast nothing and a truck
        // threw a lattice of holes. Cast from both faces.
        m.shadowSide = THREE.DoubleSide;
        if (low || src.userData?.noDetail) return m;
        const burned = !!src.userData?.burned;
        const p = positionLocal;
        // two octaves of 3D noise: fine (pitting, weld seams, stone grain) + medium (dents)
        const fine = mx_noise_float(p.mul(burned ? 9 : 6.5));
        const mid = mx_noise_float(p.mul(1.7).add(vec3(3.1, 7.7, 1.3)));
        let height = fine.mul(0.35).add(mid.mul(0.65));
        // [textures] Real grain: the terrain's scree photograph, triplanar in
        // object space at 0.45 m, as luminance only. It roughens canvas, sandbags
        // and stone into weathered surfaces and gives painted metal a dusty
        // mottle (half strength where the ORM map says metal). Without it the
        // baked atlases (no normal map, ~2 cm texels) read as flat plastic in the
        // recon optic and from a low pass.
        let grain = null;
        if (detail?.albedo) {
          const S = 0.45;
          const w = pow(normalLocal.abs(), vec3(4));
          const wn = w.div(w.x.add(w.y).add(w.z));
          const at = (q) => luminance(texture(detail.albedo, q.div(S)).depth(int(detail.layer)).rgb);
          const lum = at(p.zy).mul(wn.x).add(at(p.xz).mul(wn.y)).add(at(p.xy).mul(wn.z));
          const metal = m.metalnessMap ? texture(m.metalnessMap, uv()).b : float(m.metalness);
          grain = lum.div(detail.meanLum).sub(1).mul(mix(float(1), float(0.45), metal));
          height = height.add(grain.mul(2.2));
        }
        // [models polish 2] the unit atlases now carry a baked tangent-space
        // normal map (rounded edges, tread, cloth, stone). Setting normalNode
        // alone would discard it, so the procedural grain perturbs the mapped
        // normal instead of the geometric one, at reduced strength.
        if (m.normalMap) {
          const mapped = normalMap(texture(m.normalMap, uv(m.normalMap.channel ?? 0)), vec2(m.normalScale.x, m.normalScale.y));
          m.normalNode = bumpMap(height, float(burned ? 0.04 : 0.022), mapped);
        } else {
          m.normalNode = bumpMap(height, float(burned ? 0.06 : 0.035));
        }
        // faint dust/fade breakup over a few metres, darker low down
        const breakup = mx_noise_float(p.mul(0.45).add(vec3(11, 2, 5))).mul(0.5).add(0.5);
        const low01 = smoothstep(0.0, 1.2, p.y);
        let tint = mix(float(0.86), float(1.06), breakup).mul(mix(float(0.9), float(1), low01));
        if (grain) tint = tint.mul(clamp(grain.mul(0.55).add(1), 0.6, 1.3));
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
