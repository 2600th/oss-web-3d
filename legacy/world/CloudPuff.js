import * as THREE from 'three';

/**
 * The sprite a cloud is built out of.
 *
 * A billboard cloud lives or dies on whether its sprites read as volume. A flat
 * alpha blob lit by a constant colour is a decal and the eye knows it instantly,
 * which is the whole reason billboard clouds got a bad name. The fix is old and
 * reliable: bake a *surface* into the sprite and light it per pixel.
 *
 *   RG  the xy of a unit normal, biased to 0..1
 *   B   thickness through the puff at that texel, 0 at the rim, 1 at the centre
 *   A   coverage, with the rim eaten away by noise so the silhouette is ragged
 *
 * The shader reconstructs z from xy, rotates the normal into world space with
 * the camera basis, and shades it against the sun. That gives every puff a lit
 * face, a terminator and a shaded side for the cost of one texture fetch, and
 * because the normal is spherical the terminator curves — which is what sells
 * it as a lump of cloud rather than a sticker.
 *
 * Thickness drives the Beer term separately from coverage, so a puff's centre
 * blocks more light than its edge and the rim glows when the sun is behind it.
 * That rim is the single most recognisable thing about a real cloud.
 *
 * Generated on the GPU at boot. Nothing ships as a file.
 */

export const CLOUD_PUFF = Object.freeze({
  /** Texels across one sprite. */
  SIZE: 256,
  /** Distinct sprite variants in the atlas, laid out in a row. */
  VARIANTS: 4,
});

const PUFF_FRAGMENT = /* glsl */ `
precision highp float;
out vec4 fragColor;
uniform float uSize;
uniform float uVariants;

float hash21(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 8192);
  uint n = q.x * 1597334677u ^ q.y * 3812015801u;
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  n ^= n >> 16u;
  return float(n >> 8u) * (1.0 / 16777215.0);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
    mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x),
    f.y);
}

float fbm2(vec2 p, float seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * noise2(p + seed * 37.0);
    norm += amp;
    amp *= 0.52;
    p *= 2.07;
  }
  return sum / norm;
}

void main() {
  float variant = floor(gl_FragCoord.x / uSize);
  vec2 local = vec2(mod(gl_FragCoord.x, uSize), gl_FragCoord.y) / uSize;
  vec2 uv = local * 2.0 - 1.0;
  float r = length(uv);

  // Lumpy silhouette. Displacing the radius by low-frequency noise before the
  // falloff is what stops every puff being a circle; the eye picks a repeated
  // circle out of a sky immediately.
  float seed = variant * 11.37;
  float lumps = fbm2(uv * 2.1 + seed, seed) - 0.5;
  float radius = r + lumps * 0.34;

  // Coverage, then erode the rim with a finer octave so the edge is torn
  // rather than feathered.
  float coverage = 1.0 - smoothstep(0.42, 1.0, radius);
  float erosion = fbm2(uv * 6.3 + seed * 2.0, seed + 3.0);
  coverage *= smoothstep(0.0, 0.42, coverage * 0.55 + erosion * 0.62 - 0.30);

  // Thickness: a hemisphere through the lumpy silhouette, so the centre is
  // deep and the rim is thin.
  float thickness = sqrt(max(1.0 - clamp(radius, 0.0, 1.0) * clamp(radius, 0.0, 1.0), 0.0));

  // Spherical normal, tilted by the lump field so the shading is bumpy and the
  // terminator wanders instead of drawing a clean crescent.
  vec2 bumps = vec2(
    fbm2(uv * 3.4 + seed + 5.0, seed + 7.0) - 0.5,
    fbm2(uv * 3.4 + seed - 5.0, seed + 9.0) - 0.5
  );
  vec3 normal = normalize(vec3(uv * 0.92 + bumps * 0.55, max(thickness, 0.18)));

  fragColor = vec4(normal.xy * 0.5 + 0.5, thickness, coverage);
}
`;

/** Bake the sprite atlas once. Returns a texture, or null without a renderer. */
export function buildCloudPuffTexture(renderer) {
  if (typeof renderer?.readRenderTargetPixels !== 'function') return null;
  const { SIZE, VARIANTS } = CLOUD_PUFF;
  const width = SIZE * VARIANTS;
  const target = new THREE.WebGLRenderTarget(width, SIZE, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uSize: { value: SIZE }, uVariants: { value: VARIANTS } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: PUFF_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(width * SIZE * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, SIZE, pixels);
  renderer.setRenderTarget(previous);

  geometry.dispose();
  material.dispose();
  target.dispose();

  const texture = new THREE.DataTexture(pixels, width, SIZE, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Clamped, not repeated: a sprite that wrapped would smear its opposite edge
  // across the puff when the atlas is sampled with a bilinear tap at the border.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
