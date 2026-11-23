/**
 * Shared public atmosphere contract.
 *
 * The expensive spherical integration lives in cached LUTs owned by Sky. All
 * world shaders call these functions, keeping the sky and distant-object
 * scattering identical without paying a ray march per terrain fragment.
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
uniform sampler2D uAtmTransmittance;
uniform sampler2D uAtmMultiScatter;
uniform sampler2D uAtmSkyView;
uniform sampler2D uAtmSkyViewPrevious;
uniform sampler2D uAtmAerial;
uniform sampler2D uAtmAerialPrevious;
uniform float uAtmLutBlend;
uniform float uAtmCameraAltitude;
uniform float uAtmSunIrradiance;
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
const float ATM_PI = 3.141592653589793;
const vec3 ATM_BETA_R = vec3(0.005802, 0.013558, 0.0331);
const float ATM_BETA_M_E = 0.008396;
const vec3 ATM_BETA_O = vec3(0.00065, 0.001881, 0.000085);
const float ATM_AERIAL_MAX_KM = 80.0;
const float ATM_AERIAL_SLICES = 32.0;
const vec2 ATM_AERIAL_ATLAS_SIZE = vec2(256.0, 128.0);
const vec2 ATM_AERIAL_TILE_SIZE = vec2(32.0);

vec2 atm_directionUv(vec3 direction) {
  vec3 dir = normalize(direction);
  float azimuth = atan(dir.z, dir.x);
  float elevation = asin(clamp(dir.y, -1.0, 1.0));
  return vec2(azimuth / (2.0 * ATM_PI) + 0.5, elevation / ATM_PI + 0.5);
}

vec3 atm_skyColor(vec3 direction) {
  vec2 uv = atm_directionUv(direction);
  vec3 previous = texture(uAtmSkyViewPrevious, uv).rgb;
  vec3 current = texture(uAtmSkyView, uv).rgb;
  return max(mix(previous, current, uAtmLutBlend), vec3(0.0));
}

vec3 atm_sunTransmittance() {
  float altitudeUv = clamp(uAtmCameraAltitude / 100.0, 0.001, 0.999);
  float sunMuUv = clamp(uSunDir.y * 0.5 + 0.5, 0.001, 0.999);
  return texture(uAtmTransmittance, vec2(sunMuUv, altitudeUv)).rgb;
}

// Cosine-weighted sky fill contract for terrain, cloud and water shading. It
// intentionally excludes the sun: direct light remains the caller's job.
vec3 atm_skyIrradiance(vec3 normal) {
  vec3 N = normalize(normal);
  vec3 sunProjection = uSunDir - N * dot(uSunDir, N);
  vec3 fallback = abs(N.y) < 0.95 ? cross(vec3(0.0, 1.0, 0.0), N) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(length(sunProjection) > 1e-4 ? sunProjection : fallback);
  vec3 B = normalize(cross(N, T));
  vec3 towardSun = normalize(N * 0.82 + T * 0.57);
  vec3 awaySun = normalize(N * 0.82 - T * 0.57);
  vec3 crossA = normalize(N * 0.82 + B * 0.57);
  vec3 crossB = normalize(N * 0.82 - B * 0.57);
  vec3 irradiance = atm_skyColor(N) * 0.36;
  irradiance += atm_skyColor(towardSun) * 0.16;
  irradiance += atm_skyColor(awaySun) * 0.16;
  irradiance += atm_skyColor(crossA) * 0.16;
  irradiance += atm_skyColor(crossB) * 0.16;
  return ATM_PI * irradiance;
}

float atm_expIntegral(float startKm, float endKm, float distanceKm, float scaleHeightKm) {
  float a = exp(-max(startKm, 0.0) / scaleHeightKm);
  float b = exp(-max(endKm, 0.0) / scaleHeightKm);
  float delta = endKm - startKm;
  if (abs(delta) < 1e-4) return a * distanceKm;
  return distanceKm * scaleHeightKm * (a - b) / delta;
}

float atm_ozoneDensity(float altitudeKm) {
  return max(0.0, 1.0 - abs(altitudeKm - 25.0) / 15.0);
}

vec3 atm_segmentTransmittance(float distanceM, float cameraY, float fragmentY) {
  float distanceKm = max(distanceM, 0.0) * 0.001;
  float cameraKm = max(cameraY, 0.0) * 0.001;
  float fragmentKm = max(fragmentY, 0.0) * 0.001;
  float rayleighDepth = atm_expIntegral(cameraKm, fragmentKm, distanceKm, 8.0);
  float mieDepth = atm_expIntegral(cameraKm, fragmentKm, distanceKm, 1.2);
  float ozoneDepth = distanceKm * 0.5 *
    (atm_ozoneDensity(cameraKm) + atm_ozoneDensity(fragmentKm));
  return exp(-(ATM_BETA_R * rayleighDepth + vec3(ATM_BETA_M_E * mieDepth) + ATM_BETA_O * ozoneDepth));
}

vec2 atm_aerialAtlasUv(vec3 direction, float sliceIndex) {
  vec2 directionUv = atm_directionUv(direction);
  float tileX = mod(sliceIndex, 8.0);
  float tileY = floor(sliceIndex / 8.0);
  vec2 texel = vec2(0.5) / ATM_AERIAL_ATLAS_SIZE;
  vec2 tileMin = vec2(tileX, tileY) * ATM_AERIAL_TILE_SIZE / ATM_AERIAL_ATLAS_SIZE + texel;
  vec2 tileMax = vec2(tileX + 1.0, tileY + 1.0) * ATM_AERIAL_TILE_SIZE / ATM_AERIAL_ATLAS_SIZE - texel;
  return mix(tileMin, tileMax, directionUv);
}

vec3 atm_aerialScattering(vec3 direction, float distanceM) {
  float depth = sqrt(clamp(distanceM * 0.001 / ATM_AERIAL_MAX_KM, 0.0, 1.0));
  float slicePosition = depth * ATM_AERIAL_SLICES - 1.0;
  float lower = clamp(floor(slicePosition), 0.0, ATM_AERIAL_SLICES - 1.0);
  float upper = min(lower + 1.0, ATM_AERIAL_SLICES - 1.0);
  float blend = fract(max(slicePosition, 0.0));
  vec3 scattering = mix(
    mix(texture(uAtmAerialPrevious, atm_aerialAtlasUv(direction, lower)).rgb,
        texture(uAtmAerial, atm_aerialAtlasUv(direction, lower)).rgb, uAtmLutBlend),
    mix(texture(uAtmAerialPrevious, atm_aerialAtlasUv(direction, upper)).rgb,
        texture(uAtmAerial, atm_aerialAtlasUv(direction, upper)).rgb, uAtmLutBlend),
    blend
  );
  return scattering * smoothstep(0.0, 1.0, max(slicePosition + 1.0, 0.0));
}

vec3 atm_applyAerial(vec3 color, vec3 viewDir, float dist, float camY, float fragY) {
  vec3 transmittance = atm_segmentTransmittance(dist, camY, fragY);
  return color * transmittance + atm_aerialScattering(viewDir, dist);
}
`;
