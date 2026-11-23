import * as THREE from 'three';
import { ATM, ATM_AERIAL_ATLAS, sunToaIrradiance } from './constants.js';

const FULLSCREEN_VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const PHYSICAL_GLSL = /* glsl */ `
  const float ATM_PI = 3.141592653589793;
  const float ATM_GROUND_RADIUS = ${ATM.groundRadiusKm.toFixed(1)};
  const float ATM_TOP_RADIUS = ${ATM.topRadiusKm.toFixed(1)};
  const vec3 ATM_BETA_R = vec3(${ATM.rayleighScattering.join(', ')});
  const float ATM_BETA_M_S = ${ATM.mieScattering};
  const float ATM_BETA_M_E = ${ATM.mieScattering + ATM.mieAbsorption};
  const vec3 ATM_BETA_O = vec3(${ATM.ozoneAbsorption.join(', ')});
  const float ATM_MIE_G = ${ATM.miePhaseG};

  vec3 atmMedium(float h) {
    return vec3(exp(-max(h, 0.0) / ${ATM.rayleighScaleHeightKm.toFixed(1)}),
                exp(-max(h, 0.0) / ${ATM.mieScaleHeightKm.toFixed(1)}),
                max(0.0, 1.0 - abs(h - ${ATM.ozoneCenterKm.toFixed(1)}) / ${ATM.ozoneHalfWidthKm.toFixed(1)}));
  }

  vec3 atmExtinction(vec3 medium) {
    return ATM_BETA_R * medium.x + vec3(ATM_BETA_M_E * medium.y) + ATM_BETA_O * medium.z;
  }

  float atmBoundaryDistance(float radius, float mu, float boundaryRadius) {
    float d = radius * radius * (mu * mu - 1.0) + boundaryRadius * boundaryRadius;
    return max(0.0, -radius * mu + sqrt(max(d, 0.0)));
  }

  float atmGroundDistance(float radius, float mu) {
    float d = radius * radius * (mu * mu - 1.0) + ATM_GROUND_RADIUS * ATM_GROUND_RADIUS;
    if (mu >= 0.0 || d < 0.0) return 1e9;
    return max(0.0, -radius * mu - sqrt(d));
  }

  vec2 atmTransUv(float radius, float mu) {
    return vec2(clamp(mu * 0.5 + 0.5, 0.001, 0.999),
                clamp((radius - ATM_GROUND_RADIUS) / (ATM_TOP_RADIUS - ATM_GROUND_RADIUS), 0.001, 0.999));
  }

  vec3 atmSunTransmittance(sampler2D transmittanceLut, vec3 p, vec3 sunDir) {
    float radius = length(p);
    float mu = dot(p / radius, sunDir);
    if (atmGroundDistance(radius, mu) < 1e8) return vec3(0.0);
    return textureLod(transmittanceLut, atmTransUv(radius, mu), 0.0).rgb;
  }

  float atmRayleighPhase(float mu) {
    return 3.0 * (1.0 + mu * mu) / (16.0 * ATM_PI);
  }

  float atmMiePhase(float mu) {
    float g2 = ATM_MIE_G * ATM_MIE_G;
    float denom = max(1.0 + g2 - 2.0 * ATM_MIE_G * mu, 1e-3);
    return 3.0 * (1.0 - g2) * (1.0 + mu * mu) /
      (8.0 * ATM_PI * (2.0 + g2) * pow(denom, 1.5));
  }
`;

function placeholder(r, g, b, a = 1) {
  const data = new Float32Array([r, g, b, a]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

export function selectAtmosphereRenderTargetType(hasFloatColorBuffer) {
  return hasFloatColorBuffer ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

export function lutBlendFactor(elapsedMs, durationMs) {
  return THREE.MathUtils.clamp(elapsedMs / Math.max(durationMs, 1), 0, 1);
}

function target(width, height, type) {
  const renderTarget = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  renderTarget.texture.colorSpace = THREE.NoColorSpace;
  return renderTarget;
}

function pass(fragmentShader, uniforms = {}) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    uniforms,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
  });
}

/**
 * GPU atmosphere cache. Stable uniform objects are installed before any world
 * material is created; render targets replace only their values later.
 */
export class AtmosphereLut {
  constructor(environment) {
    this.environment = environment;
    this.renderer = null;
    this.lastAltitudeKm = Infinity;
    this.lastSun = new THREE.Vector3(Number.NaN, 0, 0);
    this.pendingStage = 0;
    this.currentDynamic = 0;
    this.blendStartedAt = -Infinity;
    this.blendDurationMs = 280;

    const irradiance = sunToaIrradiance(environment.sunDir.y);
    const transmittancePlaceholder = placeholder(1, 1, 1);
    const multiScatterPlaceholder = placeholder(0, 0, 0);
    const skyPlaceholder = placeholder(0.03, 0.09, 0.3);
    const aerialPlaceholder = placeholder(0, 0, 0, 1);
    this.placeholders = [transmittancePlaceholder, multiScatterPlaceholder, skyPlaceholder, aerialPlaceholder];
    Object.assign(environment.uniforms, {
      uAtmTransmittance: { value: transmittancePlaceholder },
      uAtmMultiScatter: { value: multiScatterPlaceholder },
      uAtmSkyView: { value: skyPlaceholder },
      uAtmSkyViewPrevious: { value: skyPlaceholder },
      uAtmAerial: { value: aerialPlaceholder },
      uAtmAerialPrevious: { value: aerialPlaceholder },
      uAtmLutBlend: { value: 1 },
      uAtmCameraAltitude: { value: 4.5 },
      uAtmSunIrradiance: { value: irradiance },
    });
  }

  initialize(renderer) {
    if (this.renderer) return;
    this.renderer = renderer;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.quad = new THREE.Mesh(this.geometry);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const hasFloatColorBuffer = renderer.extensions.has('EXT_color_buffer_float');
    this.renderTargetType = selectAtmosphereRenderTargetType(hasFloatColorBuffer);
    if (!hasFloatColorBuffer) {
      console.warn('[atmosphere] EXT_color_buffer_float missing; using normalized 8-bit LUTs.');
    }
    this.transmittance = target(...ATM.transmittanceSize, this.renderTargetType);
    this.multiScatter = target(...ATM.multiScatterSize, this.renderTargetType);
    this.skyViews = [
      target(...ATM.skyViewSize, this.renderTargetType),
      target(...ATM.skyViewSize, this.renderTargetType),
    ];
    this.aerials = [
      target(...ATM_AERIAL_ATLAS, this.renderTargetType),
      target(...ATM_AERIAL_ATLAS, this.renderTargetType),
    ];
    const shared = this.environment.uniforms;

    this.transmittancePass = pass(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      out vec4 fragColor;
      ${PHYSICAL_GLSL}
      void main() {
        float radius = mix(ATM_GROUND_RADIUS + 0.001, ATM_TOP_RADIUS - 0.001, vUv.y);
        float mu = vUv.x * 2.0 - 1.0;
        float topDist = atmBoundaryDistance(radius, mu, ATM_TOP_RADIUS);
        float groundDist = atmGroundDistance(radius, mu);
        if (groundDist < topDist) { fragColor = vec4(0.0); return; }
        vec3 p = vec3(0.0, radius, 0.0);
        vec3 dir = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
        vec3 opticalDepth = vec3(0.0);
        const int STEPS = 40;
        float dt = topDist / float(STEPS);
        for (int i = 0; i < STEPS; i++) {
          vec3 q = p + dir * ((float(i) + 0.5) * dt);
          opticalDepth += atmExtinction(atmMedium(length(q) - ATM_GROUND_RADIUS)) * dt;
        }
        fragColor = vec4(exp(-opticalDepth), 1.0);
      }
    `);

    this.multiScatterPass = pass(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      out vec4 fragColor;
      uniform sampler2D uAtmTransmittance;
      ${PHYSICAL_GLSL}
      void main() {
        float altitude = vUv.y * (ATM_TOP_RADIUS - ATM_GROUND_RADIUS);
        float sunMu = vUv.x * 2.0 - 1.0;
        float sunX = sqrt(max(0.0, 1.0 - sunMu * sunMu));
        vec3 sunDir = vec3(sunX, sunMu, 0.0);
        float radius = ATM_GROUND_RADIUS + max(altitude, 0.001);
        vec3 origin = vec3(0.0, radius, 0.0);
        vec3 directAverage = vec3(0.0);
        vec3 energyAverage = vec3(0.0);

        // Hillaire's multiple-scattering approximation: integrate radiance and
        // unit isotropic scattering throughput over a bounded sphere, then
        // close the higher orders as a geometric energy series. Twelve
        // Fibonacci directions x twelve ray steps is a one-time 148k-sample
        // bake for this 32x32 LUT, bounded enough for phone startup.
        const int DIRECTIONS = 12;
        const int STEPS = 12;
        for (int d = 0; d < DIRECTIONS; d++) {
          float fi = float(d) + 0.5;
          float y = 1.0 - 2.0 * fi / float(DIRECTIONS);
          // A tiny LUT-coordinate rotation prevents coherent quadrature bands
          // and keeps D3D shader compilers from constant-folding the unit-
          // sphere identity into spurious precision diagnostics.
          float phi = fi * 2.39996323 + vUv.x * 0.001;
          float radial = sqrt(max(0.0, 1.0 - y * y));
          vec3 dir = vec3(cos(phi) * radial, y, sin(phi) * radial);
          float mu = dot(origin / radius, dir);
          float topDist = atmBoundaryDistance(radius, mu, ATM_TOP_RADIUS);
          float groundDist = atmGroundDistance(radius, mu);
          bool hitsGround = groundDist < topDist;
          float rayDist = min(topDist, groundDist);
          float dt = rayDist / float(STEPS);
          vec3 transmittance = vec3(1.0);
          vec3 direct = vec3(0.0);
          vec3 throughput = vec3(0.0);
          float phaseR = atmRayleighPhase(dot(dir, sunDir));
          float phaseM = atmMiePhase(dot(dir, sunDir));
          for (int i = 0; i < STEPS; i++) {
            vec3 p = origin + dir * ((float(i) + 0.5) * dt);
            vec3 medium = atmMedium(max(length(p) - ATM_GROUND_RADIUS, 0.0));
            vec3 extinction = atmExtinction(medium);
            vec3 stepT = exp(-extinction * dt);
            vec3 integrated = (vec3(1.0) - stepT) / max(extinction, vec3(1e-5));
            vec3 scattering = ATM_BETA_R * medium.x + vec3(ATM_BETA_M_S * medium.y);
            vec3 single = ATM_BETA_R * medium.x * phaseR + vec3(ATM_BETA_M_S * medium.y * phaseM);
            direct += transmittance * single * atmSunTransmittance(uAtmTransmittance, p, sunDir) * integrated;
            throughput += transmittance * scattering * integrated;
            transmittance *= stepT;
          }
          if (hitsGround) {
            vec3 groundPoint = origin + dir * groundDist;
            vec3 groundNormal = normalize(groundPoint);
            vec3 groundSun = atmSunTransmittance(uAtmTransmittance, groundPoint, sunDir);
            direct += transmittance * groundSun *
              (${ATM.groundAlbedo.toFixed(2)} / ATM_PI) * max(dot(groundNormal, sunDir), 0.0);
            throughput += transmittance * ${ATM.groundAlbedo.toFixed(2)};
          }
          directAverage += direct / float(DIRECTIONS);
          energyAverage += throughput / float(DIRECTIONS);
        }
        vec3 feedback = clamp(energyAverage, vec3(0.0), vec3(0.92));
        fragColor = vec4(directAverage / max(vec3(1.0) - feedback, vec3(0.08)), 1.0);
      }
    `, { uAtmTransmittance: shared.uAtmTransmittance });

    const integrationShader = (aerial) => /* glsl */ `
      precision highp float;
      in vec2 vUv;
      out vec4 fragColor;
      uniform sampler2D uAtmTransmittance;
      uniform sampler2D uAtmMultiScatter;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uAtmSunIrradiance;
      uniform float uAtmCameraAltitude;
      ${PHYSICAL_GLSL}
      void main() {
        ${aerial ? `
          vec2 atlasPx = gl_FragCoord.xy - vec2(0.5);
          vec2 tile = floor(atlasPx / ${ATM.aerialTile}.0);
          float slice = tile.y * ${ATM.aerialTilesX}.0 + tile.x;
          vec2 localUv = (mod(atlasPx, ${ATM.aerialTile}.0) + vec2(0.5)) / ${ATM.aerialTile}.0;
          float azimuth = localUv.x * 2.0 * ATM_PI - ATM_PI;
          float elevation = localUv.y * ATM_PI - 0.5 * ATM_PI;
          float depthT = (slice + 1.0) / ${ATM.aerialSlices}.0;
          float requestedDist = ${ATM.aerialMaxKm.toFixed(1)} * depthT * depthT;
        ` : `
          float azimuth = vUv.x * 2.0 * ATM_PI - ATM_PI;
          float elevation = vUv.y * ATM_PI - 0.5 * ATM_PI;
          float requestedDist = 1e8;
        `}
        vec3 dir = vec3(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));
        float radius = ATM_GROUND_RADIUS + max(uAtmCameraAltitude, 0.001);
        vec3 origin = vec3(0.0, radius, 0.0);
        float mu = dot(origin / radius, dir);
        float rayDist = min(atmBoundaryDistance(radius, mu, ATM_TOP_RADIUS), atmGroundDistance(radius, mu));
        rayDist = min(rayDist, requestedDist);
        if (rayDist <= 0.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
        const int STEPS = ${aerial ? ATM.aerialSteps : 28};
        float dt = rayDist / float(STEPS);
        vec3 transmittance = vec3(1.0);
        vec3 radiance = vec3(0.0);
        float phaseR = atmRayleighPhase(dot(dir, uSunDir));
        float phaseM = atmMiePhase(dot(dir, uSunDir));
        for (int i = 0; i < STEPS; i++) {
          vec3 p = origin + dir * ((float(i) + 0.5) * dt);
          float h = max(length(p) - ATM_GROUND_RADIUS, 0.0);
          vec3 medium = atmMedium(h);
          vec3 extinction = atmExtinction(medium);
          vec3 stepT = exp(-extinction * dt);
          vec3 sunT = atmSunTransmittance(uAtmTransmittance, p, uSunDir);
          vec3 single = ATM_BETA_R * medium.x * phaseR + vec3(ATM_BETA_M_S * medium.y * phaseM);
          float sunMu = dot(normalize(p), uSunDir);
          vec3 multi = textureLod(uAtmMultiScatter, vec2(sunMu * 0.5 + 0.5, h / 100.0), 0.0).rgb;
          vec3 source = (single * sunT + multi * (ATM_BETA_R * medium.x + vec3(ATM_BETA_M_S * medium.y)))
            * uSunColor * uAtmSunIrradiance;
          vec3 integrated = (vec3(1.0) - stepT) / max(extinction, vec3(1e-5));
          radiance += transmittance * source * integrated;
          transmittance *= stepT;
        }
        fragColor = vec4(radiance, dot(transmittance, vec3(0.2126, 0.7152, 0.0722)));
      }
    `;

    this.bakeAltitude = { value: 4.5 };
    this.bakeSunDir = { value: this.environment.sunDir.clone() };
    this.bakeSunIrradiance = { value: sunToaIrradiance(this.environment.sunDir.y) };
    const integrationUniforms = () => ({
      uAtmTransmittance: shared.uAtmTransmittance,
      uAtmMultiScatter: shared.uAtmMultiScatter,
      uSunDir: this.bakeSunDir,
      uSunColor: shared.uSunColor,
      uAtmSunIrradiance: this.bakeSunIrradiance,
      uAtmCameraAltitude: this.bakeAltitude,
    });
    this.skyViewPass = pass(integrationShader(false), integrationUniforms());
    this.aerialPass = pass(integrationShader(true), integrationUniforms());

    this._render(this.transmittancePass, this.transmittance);
    shared.uAtmTransmittance.value = this.transmittance.texture;
    this._render(this.multiScatterPass, this.multiScatter);
    shared.uAtmMultiScatter.value = this.multiScatter.texture;
    this._setBakeState(4.5, this.environment.sunDir);
    this._render(this.skyViewPass, this.skyViews[0]);
    this._render(this.aerialPass, this.aerials[0]);
    shared.uAtmSkyView.value = this.skyViews[0].texture;
    shared.uAtmSkyViewPrevious.value = this.skyViews[0].texture;
    shared.uAtmAerial.value = this.aerials[0].texture;
    shared.uAtmAerialPrevious.value = this.aerials[0].texture;
    shared.uAtmLutBlend.value = 1;
    this.lastAltitudeKm = 4.5;
    this.lastSun.copy(this.environment.sunDir);
    for (const texture of this.placeholders) texture.dispose();
    this.placeholders.length = 0;
  }

  _render(material, renderTarget) {
    const renderer = this.renderer;
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    this.quad.material = material;
    renderer.autoClear = true;
    renderer.setRenderTarget(renderTarget);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(oldTarget);
    renderer.autoClear = oldAutoClear;
  }

  _setBakeState(altitudeKm, sun) {
    this.bakeAltitude.value = altitudeKm;
    this.bakeSunDir.value.copy(sun);
    this.bakeSunIrradiance.value = sunToaIrradiance(sun.y);
  }

  _finishPendingRefresh(nowMs) {
    const shared = this.environment.uniforms;
    const next = 1 - this.currentDynamic;
    this._render(this.aerialPass, this.aerials[next]);
    shared.uAtmSkyViewPrevious.value = this.skyViews[this.currentDynamic].texture;
    shared.uAtmAerialPrevious.value = this.aerials[this.currentDynamic].texture;
    this.currentDynamic = next;
    shared.uAtmSkyView.value = this.skyViews[next].texture;
    shared.uAtmAerial.value = this.aerials[next].texture;
    shared.uAtmLutBlend.value = 0;
    this.blendStartedAt = nowMs;
    this.lastAltitudeKm = this.pendingAltitudeKm;
    this.lastSun.copy(this.pendingSun);
    this.pendingStage = 0;
  }

  update(worldAltitude, force = false, nowMs = globalThis.performance?.now() ?? Date.now()) {
    if (!this.renderer) return;
    const altitudeKm = THREE.MathUtils.clamp(worldAltitude * 0.001, 0.001, 99.0);
    const sun = this.environment.sunDir;
    const shared = this.environment.uniforms;
    shared.uAtmCameraAltitude.value = altitudeKm;
    shared.uAtmSunIrradiance.value = sunToaIrradiance(sun.y);
    shared.uAtmLutBlend.value = lutBlendFactor(nowMs - this.blendStartedAt, this.blendDurationMs);

    if (force) {
      this.pendingStage = 0;
      this._setBakeState(altitudeKm, sun);
      this._render(this.skyViewPass, this.skyViews[this.currentDynamic]);
      this._render(this.aerialPass, this.aerials[this.currentDynamic]);
      shared.uAtmSkyViewPrevious.value = this.skyViews[this.currentDynamic].texture;
      shared.uAtmAerialPrevious.value = this.aerials[this.currentDynamic].texture;
      shared.uAtmLutBlend.value = 1;
      this.lastAltitudeKm = altitudeKm;
      this.lastSun.copy(sun);
      return;
    }

    // Split a refresh across consecutive frames and expose it only after both
    // LUTs agree. The old/new pair then cross-fades, avoiding both a two-pass
    // frame spike and the 120 m hard swap that was visible during climbs.
    if (this.pendingStage === 1) {
      this._finishPendingRefresh(nowMs);
      return;
    }
    const cacheMoved = Math.abs(altitudeKm - this.lastAltitudeKm) >= 0.12;
    const sunMoved = sun.dot(this.lastSun) <= 0.99998;
    if (!cacheMoved && !sunMoved) return;
    if (shared.uAtmLutBlend.value < 1) return;

    this.pendingAltitudeKm = altitudeKm;
    this.pendingSun = sun.clone();
    this._setBakeState(altitudeKm, sun);
    this._render(this.skyViewPass, this.skyViews[1 - this.currentDynamic]);
    this.pendingStage = 1;
  }

  dispose() {
    for (const value of [this.transmittance, this.multiScatter, ...(this.skyViews ?? []), ...(this.aerials ?? [])]) value?.dispose();
    for (const value of [this.transmittancePass, this.multiScatterPass, this.skyViewPass, this.aerialPass]) value?.dispose();
    for (const value of this.placeholders) value.dispose();
    this.placeholders.length = 0;
    this.geometry?.dispose();
  }
}
