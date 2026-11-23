const WAVE_GLSL = /* glsl */ `
const float WATER_TAU = 6.28318530718;
const float WATER_CAPILLARY = 0.000074;

float waveFilter(float wavelength, float pixelFootprint) {
  return 1.0 - smoothstep(wavelength * 0.1, wavelength * 0.62, pixelFootprint);
}

void gerstnerBand(
  vec2 p,
  float time,
  vec2 direction,
  float wavelength,
  float amplitude,
  float steepness,
  float weight,
  inout vec3 displacement,
  inout vec3 tangentX,
  inout vec3 tangentZ
) {
  float k = WATER_TAU / wavelength;
  float omega = sqrt(9.81 * k + WATER_CAPILLARY * k * k * k);
  float phase = k * dot(direction, p) + omega * time;
  float s = sin(phase);
  float c = cos(phase);
  float horizontal = steepness * amplitude * weight;
  float slope = amplitude * k * weight;
  float compression = steepness * amplitude * k * weight * s;

  displacement += vec3(direction.x * horizontal * c, amplitude * weight * s, direction.y * horizontal * c);
  tangentX += vec3(
    -direction.x * direction.x * compression,
    direction.x * slope * c,
    -direction.x * direction.y * compression
  );
  tangentZ += vec3(
    -direction.x * direction.y * compression,
    direction.y * slope * c,
    -direction.y * direction.y * compression
  );
}

void waterLongDisplacement(vec2 p, float time, out vec3 displacement) {
  displacement = vec3(0.0);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  gerstnerBand(p, time, vec2(0.923076923, 0.384615385), 34.0, 0.095, 0.42, 1.0, displacement, tx, tz);
  gerstnerBand(p, time, vec2(-0.316227766, 0.948683298), 17.0, 0.052, 0.36, 1.0, displacement, tx, tz);
}

void waterSurfaceFrame(
  vec2 p,
  float time,
  float pixelFootprint,
  float detailFade,
  out vec3 displacement,
  out vec3 normal
) {
  displacement = vec3(0.0);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  gerstnerBand(p, time, vec2(0.923076923, 0.384615385), 34.0, 0.095, 0.42, 1.0, displacement, tx, tz);
  gerstnerBand(p, time, vec2(-0.316227766, 0.948683298), 17.0, 0.052, 0.36, 1.0, displacement, tx, tz);
#if WATER_WAVES > 2
  float w2 = detailFade * waveFilter(7.8, pixelFootprint);
  gerstnerBand(p, time, vec2(0.624695048, -0.780868809), 7.8, 0.022, 0.28, w2, displacement, tx, tz);
#endif
#if WATER_WAVES > 3
  float w3 = detailFade * waveFilter(2.6, pixelFootprint);
  gerstnerBand(p, time, vec2(-0.857492926, -0.514495755), 2.6, 0.0075, 0.18, w3, displacement, tx, tz);
#endif
#if WATER_WAVES > 4
  float w4 = detailFade * waveFilter(0.72, pixelFootprint);
  gerstnerBand(p, time, vec2(0.196116135, 0.980580676), 0.72, 0.0022, 0.08, w4, displacement, tx, tz);
#endif
#if WATER_WAVES > 5
  float w5 = detailFade * waveFilter(0.18, pixelFootprint);
  gerstnerBand(p, time, vec2(-0.707106781, 0.707106781), 0.18, 0.00055, 0.03, w5, displacement, tx, tz);
  // Surface tension and gravity contribute equally near 1.7 cm. This band is
  // normal-scale only in practice and vanishes before its wavelength becomes
  // subpixel, preventing the distant sparkle associated with unfiltered noise.
  float capillaryWeight = detailFade * waveFilter(0.0173, pixelFootprint);
  gerstnerBand(
    p,
    time,
    vec2(0.447213595, -0.894427191),
    0.0173,
    0.000035,
    0.01,
    capillaryWeight,
    displacement,
    tx,
    tz
  );
#endif
  normal = normalize(cross(tz, tx));
}
`;

export const WATER_VERTEX_SHADER = /* glsl */ `
precision highp float;

in float aDepth;
in float aShoreDistance;

uniform float uTime;
uniform vec3 uCameraPosition;
uniform float uWaveFadeDistance;

out vec3 vWorldPosition;
out vec2 vWaterCoord;
out float vDepthHint;
out float vShoreDistance;
out float vWaveFade;
out float vDetailFade;

${WAVE_GLSL}

void main() {
  vec3 baseWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  float cameraDistance = distance(baseWorld.xz, uCameraPosition.xz);
  float distanceFade = 1.0 - smoothstep(uWaveFadeDistance * 0.62, uWaveFadeDistance, cameraDistance);
  float shoreFade = smoothstep(0.0, 18.0, aShoreDistance);
  vWaveFade = distanceFade * shoreFade;
  vDetailFade = (1.0 - smoothstep(1800.0, 9000.0, cameraDistance)) * shoreFade;

  vec3 displacement;
  waterLongDisplacement(baseWorld.xz, uTime, displacement);
  vec3 world = baseWorld;
  // True Gerstner motion: both horizontal and vertical displacement, faded to
  // exactly zero at the collision shoreline.
  world += displacement * vWaveFade;

  vWorldPosition = world;
  vWaterCoord = baseWorld.xz;
  vDepthHint = max(aDepth, 0.0);
  vShoreDistance = max(aShoreDistance, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const WATER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2 uResolution;
uniform float uHasRefraction;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uTime;
uniform vec3 uCameraPosition;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;

in vec3 vWorldPosition;
in vec2 vWaterCoord;
in float vDepthHint;
in float vShoreDistance;
in float vWaveFade;
in float vDetailFade;

out vec4 fragColor;

${WAVE_GLSL}

float linearDepth(float depth) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) /
    max(uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear), 1e-4);
}

float schlickWater(float cosTheta) {
  const float f0 = 0.0200593122;
  float grazing = 1.0 - clamp(cosTheta, 0.0, 1.0);
  return f0 + (1.0 - f0) * grazing * grazing * grazing * grazing * grazing;
}

float dielectricFresnel(float cosTheta) {
  const float etaI = 1.0;
  const float etaT = 1.33;
  float ci = clamp(cosTheta, 0.0, 1.0);
  float eta = etaI / etaT;
  float sinT2 = eta * eta * max(0.0, 1.0 - ci * ci);
  if (sinT2 >= 1.0) return 1.0;
  float ct = sqrt(max(0.0, 1.0 - sinT2));
  float rs = (etaI * ci - etaT * ct) / max(etaI * ci + etaT * ct, 1e-5);
  float rp = (etaT * ci - etaI * ct) / max(etaT * ci + etaI * ct, 1e-5);
  return 0.5 * (rs * rs + rp * rp);
}

vec3 skyReflection(vec3 direction) {
  float up = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uHorizonColor, uZenithColor, pow(up, 0.62));
  float solar = pow(max(dot(direction, normalize(uSunDir)), 0.0), 700.0);
  return sky + uSunColor * solar * 1.45;
}

vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

float voronoiEdge(vec2 p, float time) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float nearest = 10.0;
  float second = 10.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 seed = hash22(cell + offset);
      vec2 point = offset + 0.5 + 0.32 * sin(time + 6.2831853 * seed);
      vec2 delta = point - local;
      float distance2 = dot(delta, delta);
      if (distance2 < nearest) {
        second = nearest;
        nearest = distance2;
      } else if (distance2 < second) {
        second = distance2;
      }
    }
  }
  return max(sqrt(second) - sqrt(nearest), 0.0);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash22(cell).x;
  float b = hash22(cell + vec2(1.0, 0.0)).x;
  float c = hash22(cell + vec2(0.0, 1.0)).x;
  float d = hash22(cell + vec2(1.0, 1.0)).x;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  if (vDepthHint <= 0.025) discard;

  float pixelFootprint = max(length(dFdx(vWaterCoord)), length(dFdy(vWaterCoord)));
  vec3 unusedDisplacement;
  vec3 waveNormal;
  waterSurfaceFrame(vWaterCoord, uTime, pixelFootprint, vDetailFade, unusedDisplacement, waveNormal);
  vec3 normal = normalize(mix(vec3(0.0, 1.0, 0.0), waveNormal, vWaveFade));
  vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
#if WATER_EXACT_FRESNEL == 1
  float fresnel = dielectricFresnel(dot(normal, viewDirection));
#else
  float fresnel = schlickWater(dot(normal, viewDirection));
#endif

  vec2 screenUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
  vec3 viewNormal = normalize(mat3(viewMatrix) * normal);
  float refractionFade = vWaveFade * smoothstep(1.5, 12.0, vShoreDistance);
  vec2 rawRefractUv = screenUv + viewNormal.xy * (0.0045 * refractionFade);
  vec2 refractUv = clamp(rawRefractUv, vec2(0.001), vec2(0.999));

  float depth = vDepthHint;
  vec3 shallowSource = vec3(0.16, 0.43, 0.48);
  vec3 deepSource = vec3(0.025, 0.16, 0.23);
  vec3 source = mix(shallowSource, deepSource, smoothstep(1.0, 42.0, depth));
#if WATER_REFRACTION == 1
  if (uHasRefraction > 0.5) {
    float rawSceneDepth = texture(uSceneDepth, refractUv).r;
    float waterDepth = linearDepth(gl_FragCoord.z);
    float measuredDepth = linearDepth(rawSceneDepth) - waterDepth;
    bool validRefraction = all(greaterThan(rawRefractUv, vec2(0.001))) &&
      all(lessThan(rawRefractUv, vec2(0.999))) && rawSceneDepth < 0.999999 &&
      measuredDepth > 0.05 && measuredDepth < 120.0;
    if (validRefraction) {
      depth = min(measuredDepth, 80.0);
      source = texture(uSceneColor, refractUv).rgb;
    }
  }
#endif

  vec3 extinction = vec3(0.040, 0.020, 0.010);
  vec3 transmittance = exp(-extinction * min(depth, 80.0));
  vec3 glacialScatter = vec3(0.055, 0.27, 0.34) * (1.0 - transmittance);
  vec3 refracted = source * transmittance + glacialScatter;

#if WATER_CAUSTICS > 0
  float causticEdgeA = voronoiEdge(vWaterCoord * 0.055 + vec2(0.0, uTime * 0.018), uTime * 0.34);
  float causticWidthA = max(fwidth(causticEdgeA) * 1.6, 0.012);
  float causticA = 1.0 - smoothstep(causticWidthA, causticWidthA * 4.0, causticEdgeA);
#if WATER_CAUSTICS > 1
  float causticEdgeB = voronoiEdge(vWaterCoord.yx * 0.081 + vec2(17.0, -9.0), -uTime * 0.27);
  float causticWidthB = max(fwidth(causticEdgeB) * 1.6, 0.012);
  float causticB = 1.0 - smoothstep(causticWidthB, causticWidthB * 4.0, causticEdgeB);
  float caustic = min(causticA, causticB);
#else
  float caustic = causticA * 0.72;
#endif
  float causticFade = vDetailFade * (1.0 - smoothstep(1.0, 18.0, depth));
  refracted += uSunColor * caustic * causticFade * 0.075;
#endif

  vec3 reflected = skyReflection(reflect(-viewDirection, normal));
  vec3 halfVector = normalize(viewDirection + normalize(uSunDir));
  float normalVariation = max(length(dFdx(normal)), length(dFdy(normal)));
  float glintFilter = clamp(normalVariation * 24.0 + pixelFootprint * 0.035 + (1.0 - vDetailFade), 0.0, 1.0);
  float glintExponent = mix(210.0, 26.0, glintFilter);
  float glint = pow(max(dot(normal, halfVector), 0.0), glintExponent) * vWaveFade;

  float shoreMetric = min(vShoreDistance, depth * 1.35);
  float shoreAA = max(fwidth(shoreMetric), 0.18);
  float shoreline = 1.0 - smoothstep(1.0 - shoreAA, 6.0 + shoreAA, shoreMetric);
  float foamBreakup = valueNoise(vWaterCoord * 0.036 + vec2(uTime * 0.012, -uTime * 0.008));
  float foam = shoreline * smoothstep(0.43, 0.70, foamBreakup);

  vec3 color = mix(refracted, reflected, fresnel);
  color += uSunColor * glint * mix(0.24, 0.52, 1.0 - glintFilter);
  color = mix(color, vec3(0.74, 0.83, 0.84), foam * 0.18);
  fragColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;
