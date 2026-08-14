/**
 * Noise chunk shared by every effect material in src/fx/gpu.
 *
 * Adapted from LinearAbiltyCastingThreeJS (MIT), src/shaders/lib/noise.glsl.js.
 * The simplex implementation there is the Ashima/Gustavson one; the fbm, ridged
 * and curl wrappers are the reference's.
 *
 * This is a *second* noise library in the repository, alongside
 * src/world/terrainNoise.glsl.js, and that is deliberate. The terrain noise is
 * value noise on an integer lattice with an exactly reproducible CPU mirror,
 * because gameplay queries the same field the GPU draws. Nothing here is ever
 * queried on the CPU, and simplex has the two properties the terrain field does
 * not: no axis-aligned lattice artifacts (which show up immediately on a smoke
 * puff seen edge-on) and a cheap analytic curl, which is what makes turbulent
 * particle motion possible without a simulation step.
 *
 * Included with an include guard because several materials concatenate both this
 * and common.glsl.js, and a few concatenate this twice through two helpers.
 */
export const FX_NOISE_GLSL = /* glsl */ `
#ifndef FX_NOISE_INCLUDED
#define FX_NOISE_INCLUDED

vec3 fxMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 fxMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 fxPermute(vec4 x) { return fxMod289(((x * 34.0) + 1.0) * x); }
vec4 fxTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float fxHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float fxSnoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = fxMod289(i);
  vec4 p = fxPermute(fxPermute(fxPermute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = fxTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fxFbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * fxSnoise(p);
    p = p * 2.03 + vec3(17.3, 5.1, 9.7);
    a *= 0.5;
  }
  return v;
}

float fxFbm4(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * fxSnoise(p);
    p = p * 2.03 + vec3(17.3, 5.1, 9.7);
    a *= 0.5;
  }
  return v;
}

/** Ridged multifractal. Sharp filaments -- flame streaks, vapour striations. */
float fxRidged(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * (1.0 - abs(fxSnoise(p)));
    p *= 2.06;
    a *= 0.5;
  }
  return v;
}

/**
 * Divergence-free curl noise.
 *
 * Six extra snoise calls buy the one thing a plain noise offset cannot: the
 * field has no sources or sinks, so particles advected by it swirl and fold
 * instead of piling up in clumps and thinning out in between. That difference is
 * exactly what separates blowing snow from a cloud of dots.
 */
vec3 fxCurl(vec3 p) {
  const float e = 0.28;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);

  float x0 = fxSnoise(p - dx), x1 = fxSnoise(p + dx);
  float y0 = fxSnoise(p - dy), y1 = fxSnoise(p + dy);
  float z0 = fxSnoise(p - dz), z1 = fxSnoise(p + dz);

  vec3 pb = p + vec3(31.416, 47.853, 12.793);
  float bx0 = fxSnoise(pb - dx), bx1 = fxSnoise(pb + dx);
  float by0 = fxSnoise(pb - dy), by1 = fxSnoise(pb + dy);
  float bz0 = fxSnoise(pb - dz), bz1 = fxSnoise(pb + dz);

  float inv = 1.0 / (2.0 * e);
  vec3 grad1 = vec3(x1 - x0, y1 - y0, z1 - z0) * inv;
  vec3 grad2 = vec3(bx1 - bx0, by1 - by0, bz1 - bz0) * inv;
  return normalize(cross(grad1, grad2) + 1e-5);
}

mat2 fxRot2(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

#endif
`;
