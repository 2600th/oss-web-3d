import * as THREE from 'three';

/**
 * The 3D noise volumes the cloud density field is built from.
 *
 * Why textures at all. The previous density function evaluated its noise
 * procedurally at every sample: five value-noise calls for coverage plus two or
 * three fBm chains for erosion, each octave eight integer hashes, so roughly a
 * hundred and fifty hashes per density lookup — and the light march asks for
 * five more lookups per lit sample. That is what capped the march at sixty-six
 * steps, and a sixty-six step budget spread over twenty-six kilometres is what
 * made the clouds look like fog. Two texture fetches cost a fraction of that,
 * and the samples they buy are worth more than any amount of shader cleverness.
 *
 * Why Worley. The old field was pure value noise, which is smooth and blobby in
 * every direction — it can only ever look like smoke. Worley (cellular) noise
 * *inverted* gives packed rounded lobes, and that is the cauliflower silhouette
 * the eye reads as cumulus. Perlin-Worley — Perlin remapped by Worley — keeps
 * the connected wispy structure of Perlin while taking on those lobes, and it
 * is the base every production cloud renderer has used since Guerrilla
 * published the technique for Horizon Zero Dawn.
 *
 * Nothing here ships as a file: both volumes are rendered on the GPU at boot,
 * one z-slice per draw, in a few milliseconds. That keeps the download at zero
 * and lets the shape be edited in source rather than in a paint package.
 */

/**
 * Base shape, 128^3 RGBA:
 *   R  Perlin-Worley  — the silhouette
 *   G  Worley  low    — coarse lobes, erodes R
 *   B  Worley  mid
 *   A  Worley  high
 * Detail, 32^3 RGB: three Worley octaves that carve the boundary.
 *
 * 128 and 32 are the sizes Guerrilla settled on and they hold up: the base is
 * tiled over roughly nine kilometres, so a texel is about seventy metres, and
 * the detail tiles over about six hundred metres for a texel just under twenty.
 * Both are well inside what the march can resolve near the aircraft.
 */
export const CLOUD_NOISE = Object.freeze({
  SHAPE_SIZE: 128,
  DETAIL_SIZE: 32,
  /** World metres one wrap of the base texture covers. */
  SHAPE_TILE: 9000,
  /** World metres one wrap of the detail texture covers. */
  DETAIL_TILE: 620,
});

/**
 * Tiling gradient/cellular primitives.
 *
 * Every lattice lookup is taken modulo the cell count so the volume wraps
 * exactly. Without that the deck shows a hard seam every time the world crosses
 * a wrap boundary, which is far more obvious than any amount of repetition.
 */
const NOISE_GLSL = /* glsl */ `
vec3 wrap(vec3 p, float period) {
  return mod(p, vec3(period));
}

float hash31(vec3 p) {
  uvec3 q = uvec3(ivec3(p));
  uint n = q.x * 1597334677u ^ q.y * 3812015801u ^ q.z * 2798796415u;
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  n ^= n >> 16u;
  return float(n >> 8u) * (1.0 / 16777215.0);
}

vec3 hash33(vec3 p, float period) {
  vec3 c = wrap(p, period);
  return vec3(hash31(c), hash31(c + 19.7), hash31(c + 47.3));
}

/** Gradient (Perlin) noise on a wrapping lattice. */
float perlin(vec3 p, float period) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  for (int dz = 0; dz <= 1; dz++) {
    for (int dy = 0; dy <= 1; dy++) {
      for (int dx = 0; dx <= 1; dx++) {
        vec3 o = vec3(float(dx), float(dy), float(dz));
        vec3 g = normalize(hash33(i + o, period) * 2.0 - 1.0);
        float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y) * mix(1.0 - u.z, u.z, o.z);
        n += w * dot(g, f - o);
      }
    }
  }
  return n * 1.4 + 0.5;
}

/**
 * Inverted Worley: distance to the nearest feature point, flipped so cell
 * centres are bright. The flip is the whole point — upright Worley looks like
 * cracked mud, inverted it looks like packed billows.
 */
float worley(vec3 p, float cells) {
  vec3 scaled = p * cells;
  vec3 base = floor(scaled);
  vec3 f = fract(scaled);
  float best = 1.0;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec3 o = vec3(float(dx), float(dy), float(dz));
        vec3 point = o + hash33(base + o, cells);
        best = min(best, length(point - f));
      }
    }
  }
  return 1.0 - clamp(best, 0.0, 1.0);
}

float worleyFbm(vec3 p, float cells) {
  return worley(p, cells) * 0.625 +
         worley(p, cells * 2.0) * 0.25 +
         worley(p, cells * 4.0) * 0.125;
}

float perlinFbm(vec3 p, float period, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  float freq = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * perlin(p * freq, period * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / max(norm, 1e-4);
}

float remap(float v, float lo, float hi, float outLo, float outHi) {
  return outLo + (clamp((v - lo) / max(hi - lo, 1e-5), 0.0, 1.0)) * (outHi - outLo);
}
`;

const SHAPE_FRAGMENT = /* glsl */ `
precision highp float;
out vec4 fragColor;
uniform float uLayer;
uniform float uSize;
${NOISE_GLSL}

void main() {
  vec3 uvw = vec3(gl_FragCoord.xy / uSize, (uLayer + 0.5) / uSize);
  // Four cell densities across the volume. The base frequency has to be low
  // enough that a lobe survives at the tile scale, and each step is a doubling
  // so the erosion channels sit exactly one octave apart.
  float pfbm = perlinFbm(uvw * 4.0, 4.0, 5);
  float w0 = worleyFbm(uvw, 4.0);
  // Perlin-Worley: remap Perlin into the range Worley leaves. This keeps
  // Perlin's connected filaments but gives them Worley's rounded lobes.
  float perlinWorley = remap(pfbm, w0 - 1.0, 1.0, 0.0, 1.0);
  fragColor = vec4(
    perlinWorley,
    worleyFbm(uvw, 8.0),
    worleyFbm(uvw, 16.0),
    worleyFbm(uvw, 32.0)
  );
}
`;

const DETAIL_FRAGMENT = /* glsl */ `
precision highp float;
out vec4 fragColor;
uniform float uLayer;
uniform float uSize;
${NOISE_GLSL}

void main() {
  vec3 uvw = vec3(gl_FragCoord.xy / uSize, (uLayer + 0.5) / uSize);
  fragColor = vec4(
    worleyFbm(uvw, 4.0),
    worleyFbm(uvw, 8.0),
    worleyFbm(uvw, 16.0),
    1.0
  );
}
`;

function makeVolumeTexture(data, size) {
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Wrapping is not decoration here: the volume is tiled across the whole
  // world, so a clamped edge would draw a hard wall every wrap.
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Compute both volumes on the GPU a slice at a time, then assemble them.
 *
 * The obvious route is to render straight into a WebGL3DRenderTarget layer by
 * layer, and it does not work here: the layer binding reports a complete
 * framebuffer and no GL error, and every layer still comes back cleared. So
 * each slice is rendered to an ordinary 2D target and read back into one
 * contiguous array, which is then uploaded as a Data3DTexture. The readback is
 * 8 MB in total, it happens once behind the loading screen, and it depends on
 * nothing beyond plain 2D render targets.
 */
export class CloudNoise {
  constructor() {
    this.shape = null;
    this.detail = null;
    this._built = false;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geometry = new THREE.PlaneGeometry(2, 2);
    this._quad = new THREE.Mesh(this._geometry);
    // The vertex shader writes clip space directly, so the camera exists only
    // to satisfy render(); without this the quad is culled against a frustum it
    // was never positioned in and every slice comes back blank.
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);
  }

  build(renderer) {
    if (this._built) return this;
    // Baking needs a real renderer that can read a target back. Headless
    // contract tests construct the volume against a stub, and they care about
    // the density code and the step schedule rather than the noise itself, so
    // this stays unbuilt there instead of throwing.
    if (typeof renderer?.readRenderTargetPixels !== 'function') return this;
    const { SHAPE_SIZE, DETAIL_SIZE } = CLOUD_NOISE;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    try {
      this.shape = makeVolumeTexture(this._bake(renderer, SHAPE_SIZE, SHAPE_FRAGMENT), SHAPE_SIZE);
      this.detail = makeVolumeTexture(this._bake(renderer, DETAIL_SIZE, DETAIL_FRAGMENT), DETAIL_SIZE);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
    this._built = true;
    return this;
  }

  _bake(renderer, size, fragmentShader) {
    const target = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uLayer: { value: 0 }, uSize: { value: size } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this._quad.material = material;

    const sliceBytes = size * size * 4;
    const volume = new Uint8Array(sliceBytes * size);
    const slice = new Uint8Array(sliceBytes);
    for (let layer = 0; layer < size; layer++) {
      material.uniforms.uLayer.value = layer;
      renderer.setRenderTarget(target);
      renderer.render(this._scene, this._camera);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, slice);
      volume.set(slice, layer * sliceBytes);
    }

    material.dispose();
    target.dispose();
    return volume;
  }

  dispose() {
    this.shape?.dispose();
    this.detail?.dispose();
    this._geometry.dispose();
    this.shape = null;
    this.detail = null;
    this._built = false;
  }
}
