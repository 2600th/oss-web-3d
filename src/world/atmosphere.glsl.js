/**
 * Shared atmosphere model.
 *
 * The sky dome and the terrain's aerial perspective use the *same* function, so
 * distant ridges dissolve into exactly the colour of the sky behind them. That
 * single detail does more for the sense of Himalayan scale than any amount of
 * extra geometry, and it's why fog colour is computed per-pixel from the view
 * direction rather than being a constant.
 */

export const ATMOSPHERE_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uZenithColor;
uniform vec3  uHorizonColor;
uniform float uHazeDensity;
uniform float uHazeHeight;
uniform float uHazeBase;
uniform float uSunIntensity;
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
// Sky radiance for a view direction, excluding the sun disc itself.
vec3 atm_skyColor(vec3 dir) {
  float y = dir.y;
  float t = exp(-max(y, 0.0) * 3.6);

  vec3 col = mix(uZenithColor, uHorizonColor, t);

  // Looking down past the horizon we are still inside the haze layer, so it
  // stays bright rather than going black.
  col = mix(col, uHorizonColor * 0.86, smoothstep(0.0, -0.16, y));

  float mu = dot(dir, uSunDir);
  float m = max(mu, 0.0);

  // Tight Mie forward-scattering halo, strongest near the horizon where the
  // optical path is longest.
  col += uSunColor * pow(m, 9.0) * 0.42 * (0.30 + 0.70 * t);
  // Broad warm bias across the sun-facing half of the sky.
  col += uSunColor * pow(m, 1.8) * 0.075;

  return col;
}

// Analytic integral of exponential height fog along a view ray. Gives correct
// behaviour both when diving into thick low haze and when looking down from
// 7 km at a valley floor.
//
// The profile is anchored at uHazeBase, not at sea level. Every valley floor in
// this world is already at 2.7 km; measuring haze from y=0 buried the entire
// map in the densest part of the curve and turned it into flat grey soup.
float atm_opticalDepth(float dist, float camY, float fragY) {
  float k = max(uHazeHeight, 1.0);
  float c = max(camY - uHazeBase, 0.0);
  float f = max(fragY - uHazeBase, 0.0);
  float dy = f - c;
  float ec = exp(-c / k);
  if (abs(dy) < 0.5) return ec * dist;
  float ef = exp(-f / k);
  return dist * k * (ec - ef) / dy;
}

vec3 atm_applyAerial(vec3 color, vec3 viewDir, float dist, float camY, float fragY) {
  float od = atm_opticalDepth(dist, camY, fragY);
  float fog = 1.0 - exp(-uHazeDensity * od);
  return mix(color, atm_skyColor(viewDir), clamp(fog, 0.0, 1.0));
}
`;
