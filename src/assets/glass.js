import * as THREE from 'three/webgpu';
import {
  float, vec3, vec4, clamp, mix, normalView, positionViewDirection, positionView, positionWorld, cameraPosition,
  dot, pow, oneMinus, max, normalize, length, positionLocal, mx_noise_float, smoothstep, select, step,
  uniform, mrt, modelWorldMatrixInverse,
} from 'three/tsl';

// [glass] Aircraft glazing: the canopy, the nav-light lenses (`glass_misc`).
//
// Clear glass is two things at once: light reflected off its surfaces (sky,
// sun, a little dust) is *added* on top of the scene, and the scene behind is
// *dimmed* by what the glass reflects and absorbs. Ordinary alpha blending
// (src * a + dst * (1 - a)) multiplies the reflection by the opacity as well, so
// a canopy that is ~90 % transmissive head-on also loses ~90 % of its sky
// reflection and its sun glint: it read as no glass at all, only the frame.
// Here the shaded colour is written unmultiplied and blended as premultiplied
// alpha (dst * (1 - a) + src), which is the standard "glass over" for
// rasterised transparency (e.g. McGuire & Bavoil, "Weighted Blended
// Order-Independent Transparency", JCGT 2013, sec. 2: reflection is emission,
// coverage is transmission; Frostbite / UE "premultiplied translucency").
//
//   alpha   Schlick-style Fresnel over a small absorption floor: the share of
//           the background the glass hides (two surfaces, ~8-10 % head-on).
//   rgb     three's physical shading of a dielectric (ior 1.52, clearcoat):
//           Fresnel-weighted environment reflection + key-light glint, plus
//           a faint dust/haze layer that lights up looking toward the sun.
//   inside  back faces (the inner surface seen from the seat) mirror the dark
//           cockpit, not the sky: their environment reflection is cut to ~12 %
//           through the AO input (three applies AO to indirect specular and
//           clearcoat as well, Lagarde & de Rousiers 2014 specular occlusion).

const subclasses = new Map();
/** A subclass of `Base` whose output skips three's premultiply (rgb stays reflected light). */
export function premultipliedGlassClass(Base) {
  let K = subclasses.get(Base);
  if (!K) {
    K = class extends Base {
      setupPremultipliedAlpha(builder, outputNode) { return outputNode; }
      customProgramCacheKey() { return `${super.customProgramCacheKey()}|glassPM`; }
    };
    subclasses.set(Base, K);
  }
  return K;
}

// Key light (sun by day, moon at night) for the dust forward scatter. Set from
// the environment once it is known (bindGlassEnv); shared by every glass material.
let envRef = null;
const keyDir = uniform(new THREE.Vector3(0, 1, 0)).onFrameUpdate(() => envRef?.sunDirection);
const keyRadiance = uniform(new THREE.Color(0, 0, 0)).onFrameUpdate((_, self) => {
  const s = envRef?.sun;
  if (s) self.value.copy(s.color).multiplyScalar(s.intensity);
});
export function bindGlassEnv(env) { if (env?.sunDirection) envRef = env; }

/** Fresnel-weighted coverage: `base` head-on (absorption + both surfaces), `edge` at grazing. */
function coverage(base, edge) {
  const ndv = clamp(dot(normalView, positionViewDirection).abs(), 0, 1);
  const f = pow(oneMinus(ndv), 5);
  return float(base).add(f.mul(edge - base));
}

/**
 * Turn a node material into premultiplied glass in place.
 * @param {THREE.Material} g  a node material made with premultipliedGlassClass(...)
 * @param {{canopy?: boolean, low?: boolean, box?: {min: number[], max: number[]}}} opts  box: the mesh's local bounds (eye inside = cockpit view)
 */
export function setupGlass(g, { canopy = true, low = false, box = null } = {}) {
  g.color.setRGB(0.004, 0.0048, 0.005); // near-black body: what the eye sees of the glass itself is reflection
  g.roughness = low ? 0.07 : 0.085;
  g.metalness = 0;
  g.transparent = true;
  g.premultipliedAlpha = true;
  g.depthWrite = false;
  g.side = THREE.DoubleSide;
  // a touch above physical: canopy acrylic is a curved mirror the eye reads the
  // jet's attitude from (and stretched-acrylic coatings reflect a little more)
  g.envMapIntensity = 1.4;
  if (!low) {
    g.clearcoat = 1;
    g.clearcoatRoughness = 0.02;
    g.ior = 1.52;
    g.specularIntensity = 1;
  }
  // Seen from inside (the eye is within the glass's own bounds: the cockpit
  // view), both faces of the shell mirror the dark cockpit, not the sky.
  // The shell is modelled with thickness, so face orientation cannot tell
  // inside from outside; the camera's position in mesh space can.
  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  box ??= { min: [-1, -1, -1], max: [1, 1, 1] };
  const inBox = step(box.min[0], eye.x).mul(step(eye.x, box.max[0]))
    .mul(step(box.min[1] - 0.6, eye.y)).mul(step(eye.y, box.max[1]))
    .mul(step(box.min[2], eye.z)).mul(step(eye.z, box.max[2]));
  const inner = canopy ? mix(float(1), float(0.12), inBox) : float(1);
  if (low) {
    g.opacityNode = coverage(canopy ? 0.09 : 0.4, 0.78);
    g.aoNode = inner;
  } else {
    // Dust and fine haze: object-space noise at two scales, only within a few
    // metres of the camera (cockpit, close chase) where it can resolve.
    const dist = length(positionView);
    const p = positionLocal;
    const blot = mx_noise_float(p.mul(3.1).add(vec3(1.7, 4.2, 0.3))).mul(0.5).add(0.5);
    const speck = mx_noise_float(p.mul(61)).mul(0.5).add(0.5);
    const near = smoothstep(14, 1.5, dist);
    const dust = smoothstep(0.55, 0.95, blot).mul(0.6).add(smoothstep(0.78, 0.98, speck).mul(near)).mul(near.mul(0.7).add(0.3));
    // Roughness. The clearcoat (0.02) carries the crisp sky reflection; the base
    // layer is a little rougher so the sun reads as a glint a few pixels wide
    // instead of a sub-pixel point that TRAA averages away (sphere-light
    // widening, Karis 2013: the sun disc alone is half a degree across).
    g.roughnessNode = float(0.085).add(dust.mul(0.25));
    // dust forward-scatters the key light toward an eye looking toward it (HG-like lobe)
    const toFrag = normalize(positionWorld.sub(cameraPosition));
    const fwd = max(dot(toFrag, keyDir), 0);
    const lobe = pow(fwd, 6).mul(0.35).add(0.015);
    g.emissiveNode = keyRadiance.mul(dust.mul(lobe).mul(0.06));
    g.opacityNode = coverage(canopy ? 0.08 : 0.4, 0.8).add(dust.mul(0.05));
    g.aoNode = inner;
  }
  // Blended surfaces keep the velocity of whatever is behind them. With
  // premultiplied blending the velocity target sees dst * (1 - a) + src, so the
  // glass writes zero in every channel (PostFX.useTransparentVelocity writes
  // (v, 0, 0) for straight alpha; it skips materials that already have an mrtNode).
  g.mrtNode = mrt({ velocity: vec4(0) });
  g.userData.glass = true;
  return g;
}

/**
 * The three nav-light lenses (`glass_misc`: ~3 cm covers on both wingtips and
 * the fin tip, mesh-local x about -0.9 / +0.9 / 0). Tinted glass to match the
 * lamps the time-of-day system hangs there: red left, green right, clear tail.
 */
export function setupLensGlass(g, { low = false } = {}) {
  setupGlass(g, { canopy: false, low });
  const x = positionLocal.x;
  const tint = select(x.lessThan(-0.3), vec3(0.55, 0.02, 0.015), select(x.greaterThan(0.3), vec3(0.02, 0.4, 0.06), vec3(0.4, 0.4, 0.38)));
  g.colorNode = tint.mul(0.25);
  g.opacityNode = coverage(0.55, 0.85);
  g.roughnessNode = float(0.05);
  g.emissiveNode = null;
  return g;
}
