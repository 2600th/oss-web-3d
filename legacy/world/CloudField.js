import * as THREE from 'three';
import { CLOUD_CONSTANTS, evaluateCloudColumn } from './clouds.glsl.js';
import { buildCloudPuffTexture, CLOUD_PUFF } from './CloudPuff.js';

/**
 * Clouds as lit billboard clusters.
 *
 * This replaced a raymarched volume. The march was fixed and made twelve times
 * faster, and it still could not be art-directed into cumulus in reasonable
 * time — every pass traded one artifact for another, because the silhouette of
 * a marched cloud is an emergent property of a noise field and there is no
 * direct handle on it. A puff cluster has the opposite property: the shape *is*
 * the placement, so it can be authored. That is why flight games shipped this
 * technique for twenty years.
 *
 * The parts that make it not look like sprites:
 *
 *   - Each puff is lit per pixel from a baked spherical normal, so it has a lit
 *     face and a curved terminator rather than a flat tint. See CloudPuff.
 *   - A cloud is a *cluster* of puffs on a squashed ellipsoid, sized by its own
 *     coverage, so silhouettes differ and read as one object.
 *   - Puffs fade where they meet terrain instead of cutting a hard edge into
 *     it, which is the tell that gives billboards away at close range.
 *   - Puffs are drawn back to front. Every puff is one instance in a single
 *     draw, so three.js cannot sort them for us — it sorts objects, not
 *     instances — and without an explicit order they blend in whatever order
 *     they happen to sit in the buffer, which is how a cloud behind another
 *     ends up painted on top of it.
 *   - The billboard basis is constrained to world up, so banking the aircraft
 *     does not spin the sky.
 *
 * Placement comes from the same evaluateCloudColumn the raymarch used, so the
 * weather model, the cleared opening corridor, the terrain shadow map and the
 * route-validation tests all keep meaning exactly what they meant before.
 */

export const CLOUD_FIELD = Object.freeze({
  /** Half-width of the placement grid around the camera, metres. */
  RADIUS: 34000,
  /** Spacing of candidate cloud sites, metres. */
  SITE_SPACING: 2100,
  /** Coverage a site needs before it grows a cloud at all. */
  SITE_THRESHOLD: 0.34,
  /** Puffs in the largest cloud; small clouds get proportionally fewer. */
  MAX_PUFFS_PER_CLOUD: 14,
  /** Hard ceiling on live puffs, so a dense sky cannot run away. */
  MAX_PUFFS: 2600,
  /** Metres the camera may drift before the field is rebuilt. */
  REBUILD_DISTANCE: 900,
});

/**
 * Metres the eye may travel before the back-to-front order is recomputed.
 *
 * Puffs that swap order over this distance are within a few metres of the same
 * depth, where getting the blend order wrong is invisible.
 */
const SORT_MOVE = 18;

const VERTEX = /* glsl */ `
precision highp float;

in vec3 position;
in vec2 uv;
in vec3 iCentre;      // puff centre, world
in vec4 iShape;       // xy sprite scale, z variant index, w rim seed
in vec4 iTint;        // rgb base tint, a opacity scale
in vec4 iCluster;     // xyz unit offset from the cloud centre, w height in cloud

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 uCameraUp;
uniform vec3 uCameraPos;

out vec2 vUv;
out float vVariant;
out vec4 vTint;
out vec3 vRight;
out vec3 vUpAxis;
out vec4 vClip;
out float vRimSeed;
out vec3 vWorld;
out vec4 vCluster;
out float vEyeDistance;

void main() {
  // Axis-constrained billboarding, the way flight sims have built sprite clouds
  // since the nineties.
  //
  // The quad faces the eye, but its up vector comes from the *world*, not from
  // the camera. Using the camera's own up — which is what this did — keeps the
  // sprite square on screen, and that is exactly the bug: bank the aircraft and
  // every cloud in the sky rotates with you, because each quad is pinned to a
  // basis that is rolling. Constraining up to world up costs nothing and the
  // clouds simply stay where they are.
  //
  // The facing direction is computed per puff rather than taken from the camera
  // forward, so puffs at the edge of a wide frustum turn to face the eye
  // properly instead of all sharing one plane.
  vec3 toEye = uCameraPos - iCentre;
  float eyeDistance = length(toEye);
  vec3 forward = toEye / max(eyeDistance, 1e-3);

  // Straight up or straight down the world-up constraint degenerates — the
  // cross product collapses — so near the poles blend back to the camera's up.
  // Looking vertically there is no horizon to judge roll against anyway.
  vec3 upRef = normalize(mix(vec3(0.0, 1.0, 0.0), uCameraUp, smoothstep(0.86, 0.995, abs(forward.y))));
  vec3 right = normalize(cross(upRef, forward));
  vec3 up = cross(forward, right);

  vec3 world = iCentre + right * (position.x * iShape.x) + up * (position.y * iShape.y);
  vWorld = world;
  vUv = uv;
  vVariant = iShape.z;
  vRimSeed = iShape.w;
  vTint = iTint;
  vCluster = iCluster;
  vRight = right;
  vUpAxis = up;
  vEyeDistance = eyeDistance;
  vClip = projectionMatrix * viewMatrix * vec4(world, 1.0);
  gl_Position = vClip;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

in vec2 vUv;
in float vVariant;
in vec4 vTint;
in vec3 vRight;
in vec3 vUpAxis;
in vec4 vClip;
in float vRimSeed;
in vec3 vWorld;
in vec4 vCluster;
in float vEyeDistance;

uniform sampler2D uPuff;
uniform sampler2D uSceneDepth;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform float uSunIntensity;
uniform vec3 uCameraPos;
uniform float uVariants;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uSoftness;
uniform float uOpacity;
uniform float uSoftEnabled;
uniform float uNearFadeStart;
uniform float uNearFadeEnd;

out vec4 fragColor;

float viewZFromDepth(float depth) {
  float ndc = depth * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
}

void main() {
  vec2 atlasUv = vec2((vUv.x + vVariant) / uVariants, vUv.y);
  vec4 puff = texture(uPuff, atlasUv);
  float coverage = puff.a * vTint.a * uOpacity;

  // Near fade. A billboard seen from a few metres away is unmistakably a flat
  // card however well it is shaded, so old sprite-cloud renderers simply never
  // let you get that close to one: the sprite dissolves as you close on it and
  // the ones behind carry the cloud. Flying through still whites out, because
  // there are always more puffs beyond the ones fading.
  coverage *= smoothstep(uNearFadeStart, uNearFadeEnd, vEyeDistance);
  if (coverage < 0.004) discard;

  // Soft particles. Without this a puff crossing a ridge draws a razor edge
  // along it and the illusion collapses; fading over a few tens of metres of
  // depth difference is what lets cloud sit *in* the landscape.
  //
  // Gated on the depth texture actually being bound. An unbound sampler reads
  // as whatever Three's placeholder happens to be, and if that is black every
  // fragment computes a scene distance at the near plane and discards — which
  // is a completely invisible cloud field that still draws every triangle.
  vec2 screenUv = (vClip.xy / vClip.w) * 0.5 + 0.5;
  float sceneDepth = uSoftEnabled > 0.5 ? texture(uSceneDepth, screenUv).r : 1.0;
  if (sceneDepth < 1.0) {
    float sceneZ = viewZFromDepth(sceneDepth);
    float fragZ = viewZFromDepth(gl_FragCoord.z);
    coverage *= clamp((sceneZ - fragZ) / uSoftness, 0.0, 1.0);
    if (coverage < 0.004) discard;
  }

  // Rebuild the baked normal and rotate it into world space with the camera
  // basis the quad was built on.
  vec3 n = vec3(puff.rg * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(1.0 - dot(n.xy, n.xy), 1e-4));
  // cross(right, up) is the facing direction the vertex shader built, pointing
  // from the puff toward the eye. The hemisphere has to bulge that way; the
  // sign was negated here, so every sprite's own shading faced away from the
  // camera and fought the cluster term it is blended with.
  vec3 forward = normalize(cross(vRight, vUpAxis));
  vec3 spriteNormal = normalize(vRight * n.x + vUpAxis * n.y + forward * n.z);

  // Blend the puff's own sphere normal toward its direction from the cloud
  // centre. This is the difference between lighting a bag of identical balls
  // and lighting a cloud: a camera-facing sprite's normal describes only the
  // sprite, so with a high sun every puff in the sky returns nearly the same
  // dot product and the whole field comes out one flat tone. The cluster normal
  // is what tells a puff whether it is on the sunward shoulder or round the
  // back, and that is the shading the eye is actually reading.
  vec3 normal = normalize(mix(spriteNormal, vCluster.xyz, 0.62));

  float thickness = puff.b;
  float ndl = dot(normal, uSunDir);

  // How much cloud stands between this puff and the sun. Sunward puffs are lit
  // directly; the ones behind them sit in their neighbours' shadow, which is
  // what gives a cumulus its dark core and bright shoulder.
  float sunDepth = clamp(dot(vCluster.xyz, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float selfShadow = mix(0.22, 1.0, pow(sunDepth, 1.3));

  // Beer through the puff's own thickness: the centre is deep and blocks the
  // sun, the rim is thin and lets it through. One term, and it is most of why
  // this reads as cloud rather than as a shaded ball.
  float transmit = exp(-thickness * 2.6);

  // Wrapped diffuse. A cloud is not a Lambertian surface — light scatters
  // round it — so the terminator has to be soft and the shadow side lit. The
  // range is wide on purpose: measured, the previous values put every cloud
  // pixel between luma 155 and 215, which is a sixty-level spread doing the
  // work of a sunlit cumulus against its own shadow.
  float wrapped = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  float lit = mix(0.10, 1.22, pow(wrapped, 1.5));

  vec3 viewDir = normalize(vWorld - uCameraPos);
  float towardSun = clamp(dot(viewDir, uSunDir), 0.0, 1.0);
  // Silver lining: thin cloud with the sun behind it glows, and it glows most
  // where the puff is thinnest. This is the single most recognisable thing
  // about a real cloud edge.
  float rim = pow(towardSun, 7.0) * transmit * (1.0 - thickness * 0.55);

  // Sky fill is what a cloud's shadowed side is actually lit by, and it is blue
  // — a white cloud with a white shadow side is the flattest thing in
  // computer graphics. Deep parts of the puff see less of the sky, so the fill
  // falls with thickness and the undersides go cool and dark.
  vec3 skyFill = mix(uHorizonColor, uZenithColor, 0.55);
  vec3 ambient = skyFill * mix(0.16, 0.62, 1.0 - thickness);
  vec3 direct = uSunColor * uSunIntensity * lit * selfShadow * mix(0.18, 1.0, transmit);
  vec3 colour = vTint.rgb * (ambient + direct) + uSunColor * rim * 2.2 * uSunIntensity;

  // Aerial perspective, so a distant bank dissolves into the horizon instead of
  // hanging in front of it at full contrast.
  float distance = length(vWorld - uCameraPos);
  float aerial = 1.0 - exp(-distance * 0.000035);
  colour = mix(colour, uHorizonColor, aerial * 0.78);
  coverage *= 1.0 - smoothstep(0.72, 1.0, distance / 46000.0);

  fragColor = vec4(colour * coverage, coverage);
}
`;

/** How far past the site threshold a column is, 0..1. */
function strengthOf(shaped) {
  return Math.min(1, Math.max(0, (shaped - CLOUD_FIELD.SITE_THRESHOLD) / (1 - CLOUD_FIELD.SITE_THRESHOLD)));
}

/** Deterministic per-site hash so a rebuild reproduces the same sky. */
function siteHash(x, z, salt) {
  let n = (Math.imul((x + 65536) | 0, 1597334677) ^ Math.imul((z + 65536) | 0, 3812015801) ^ Math.imul(salt | 0, 2798796415)) >>> 0;
  n = Math.imul((n ^ (n >>> 15)) >>> 0, 2246822519) >>> 0;
  n = Math.imul((n ^ (n >>> 13)) >>> 0, 3266489917) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return (n >>> 8) / 16777215;
}

export class CloudField {
  constructor(environment, camera) {
    this.environment = environment;
    this.camera = camera;
    this.enabled = true;
    this._texture = null;
    this._built = false;
    this._lastBuildCentre = new THREE.Vector3(Infinity, 0, Infinity);
    this._quality = { puffs: CLOUD_FIELD.MAX_PUFFS, opacity: 1, softness: 260 };

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    quad.dispose();

    this._capacity = CLOUD_FIELD.MAX_PUFFS;
    // Two copies: the field as built, and the field ordered back to front for
    // the GPU. Sorting in place would lose the build order and make each
    // re-sort depend on the last one.
    this._srcCentres = new Float32Array(this._capacity * 3);
    this._srcShapes = new Float32Array(this._capacity * 4);
    this._srcTints = new Float32Array(this._capacity * 4);
    this._srcClusters = new Float32Array(this._capacity * 4);
    this._centres = new Float32Array(this._capacity * 3);
    this._shapes = new Float32Array(this._capacity * 4);
    this._tints = new Float32Array(this._capacity * 4);
    this._clusters = new Float32Array(this._capacity * 4);
    this._order = new Uint32Array(this._capacity);
    this._depthKeys = new Float64Array(this._capacity);
    this._lastSortAt = new THREE.Vector3(Infinity, 0, Infinity);
    this.geometry.setAttribute('iCentre', new THREE.InstancedBufferAttribute(this._centres, 3));
    this.geometry.setAttribute('iShape', new THREE.InstancedBufferAttribute(this._shapes, 4));
    this.geometry.setAttribute('iTint', new THREE.InstancedBufferAttribute(this._tints, 4));
    this.geometry.setAttribute('iCluster', new THREE.InstancedBufferAttribute(this._clusters, 4));
    this.geometry.instanceCount = 0;

    const env = environment.uniforms;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      // Premultiplied: the fragment shader already multiplies colour by
      // coverage, which keeps a bright rim from being darkened by its own alpha.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uPuff: { value: null },
        uSceneDepth: { value: null },
        uCameraUp: { value: new THREE.Vector3(0, 1, 0) },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: env.uSunDir,
        uSunColor: env.uSunColor,
        uZenithColor: env.uZenithColor,
        uHorizonColor: env.uHorizonColor,
        uSunIntensity: env.uSunIntensity,
        uVariants: { value: CLOUD_PUFF.VARIANTS },
        uCameraNear: { value: camera.near },
        uCameraFar: { value: camera.far },
        uSoftness: { value: 260 },
        uOpacity: { value: 1 },
        uSoftEnabled: { value: 0 },
        uNearFadeStart: { value: 30 },
        uNearFadeEnd: { value: 190 },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'cloud-field';

    this._sites = [];
    this._scratch = new THREE.Vector3();
  }

  initialize(renderer) {
    if (this._built) return;
    this._texture = buildCloudPuffTexture(renderer);
    this.material.uniforms.uPuff.value = this._texture;
    this._built = Boolean(this._texture);
  }

  setDepthTexture(depthTexture) {
    this.material.uniforms.uSceneDepth.value = depthTexture ?? null;
    this.material.uniforms.uSoftEnabled.value = depthTexture ? 1 : 0;
  }

  /**
   * Per-tier budget.
   *
   * Billboards are fill-rate bound rather than sample bound, so the knob that
   * matters is how many puffs cover the screen, not how finely each is shaded.
   */
  setQuality(tier) {
    const name = tier?.name ?? 'high';
    const table = {
      phone: { puffs: 420, opacity: 0.86, softness: 420 },
      low: { puffs: 850, opacity: 0.92, softness: 360 },
      medium: { puffs: 1500, opacity: 0.96, softness: 300 },
      high: { puffs: CLOUD_FIELD.MAX_PUFFS, opacity: 1, softness: 260 },
    };
    this._quality = table[name] ?? table.high;
    this.material.uniforms.uSoftness.value = this._quality.softness;
    this.material.uniforms.uOpacity.value = this._quality.opacity;
    this._lastBuildCentre.set(Infinity, 0, Infinity);
  }

  /** Rebuild the cloud sites around a world position. */
  _rebuild(centre) {
    const { RADIUS, SITE_SPACING, SITE_THRESHOLD, MAX_PUFFS_PER_CLOUD } = CLOUD_FIELD;
    const base = this.environment.uniforms.uCloudBase?.value ?? CLOUD_CONSTANTS.BASE;
    const ceiling = this.environment.uniforms.uCloudTop?.value ?? CLOUD_CONSTANTS.TOP;
    const time = this.environment.uniforms.uCloudTime?.value ?? 0;
    const wind = this.environment.uniforms.uCloudWind?.value;
    const windX = wind?.x ?? 0;
    const windZ = wind?.y ?? 0;

    const sites = this._sites;
    sites.length = 0;
    const originX = Math.round(centre.x / SITE_SPACING) * SITE_SPACING;
    const originZ = Math.round(centre.z / SITE_SPACING) * SITE_SPACING;
    const span = Math.ceil(RADIUS / SITE_SPACING);

    for (let gz = -span; gz <= span; gz++) {
      for (let gx = -span; gx <= span; gx++) {
        const x = originX + gx * SITE_SPACING;
        const z = originZ + gz * SITE_SPACING;
        const dx = x - centre.x;
        const dz = z - centre.z;
        const distance = Math.hypot(dx, dz);
        if (distance > RADIUS) continue;

        const column = evaluateCloudColumn(x, z, time, windX, windZ);
        if (column.shaped < SITE_THRESHOLD) continue;
        // Thin the field. Coverage alone puts a cloud on every site above the
        // threshold, and because the coverage field is close to binary — most
        // of it is either clear or fully covered — that fills every bank solidly
        // and the clusters merge into one unbroken hedge along the horizon.
        // A flat drop rate is what actually opens gaps; scaling it by coverage
        // does almost nothing, because coverage is already saturated wherever
        // there is cloud at all. Dense banks keep more of their sites than
        // marginal ones, but every bank gets holes.
        if (siteHash(x, z, 6) > 0.42 + strengthOf(column.shaped) * 0.26) continue;

        // Jitter the site off the lattice, or the sky is a grid of clouds.
        const jx = x + (siteHash(x, z, 1) - 0.5) * SITE_SPACING * 0.85;
        const jz = z + (siteHash(x, z, 2) - 0.5) * SITE_SPACING * 0.85;

        const strength = strengthOf(column.shaped);
        const top = Math.min(ceiling, column.top);
        const height = Math.max(240, top - base);
        // Wider than tall: a cumulus is a mound, and a cluster that is as tall
        // as it is wide reads as a column, which is what the marched version
        // kept producing.
        // Kept under half the site spacing so neighbouring clusters do not
        // overlap into a continuous mass.
        const radius = 260 + strength * 520 + siteHash(x, z, 3) * 160;
        sites.push({
          x: jx,
          z: jz,
          // Spread the bases over several hundred metres. A single condensation
          // level draws one ruler-straight line across the whole sky, which is
          // the other half of why the field read as a hedge.
          base: base + 40 + siteHash(x, z, 4) * 620 + strength * 180,
          height,
          radius,
          strength,
          puffs: Math.max(3, Math.round(3 + strength * (MAX_PUFFS_PER_CLOUD - 3))),
          seed: siteHash(x, z, 5),
          distance,
        });
      }
    }

    // Nearest first, so when the puff budget runs out it is the far clouds that
    // are dropped — they are the ones aerial perspective is already dissolving.
    sites.sort((a, b) => a.distance - b.distance);
    this._writeInstances(sites);
    this._lastBuildCentre.copy(centre);
  }

  _writeInstances(sites) {
    const centres = this._srcCentres;
    const shapes = this._srcShapes;
    const tints = this._srcTints;
    const clusters = this._srcClusters;
    const budget = Math.min(this._capacity, this._quality.puffs);
    let index = 0;

    for (const site of sites) {
      if (index + site.puffs > budget) break;
      for (let p = 0; p < site.puffs; p++) {
        const a = siteHash(site.x + p * 7, site.z - p * 13, 11);
        const b = siteHash(site.x - p * 17, site.z + p * 23, 13);
        const c = siteHash(site.x + p * 31, site.z + p * 37, 17);

        // Squashed ellipsoid, biased so puffs bunch low and the crown thins —
        // the mass of a cumulus sits under its top.
        const angle = a * Math.PI * 2;
        const spread = Math.sqrt(b) * site.radius;
        const lift = Math.pow(c, 1.7);
        const px = site.x + Math.cos(angle) * spread;
        const pz = site.z + Math.sin(angle) * spread;
        const py = site.base + lift * site.height * 0.82;

        // Puffs shrink toward the crown, which keeps the silhouette rounded
        // instead of ending in a flat lid.
        const taper = 1.0 - lift * 0.45;
        const scale = (site.radius * 1.15 + 220) * taper * (0.72 + a * 0.5);

        centres[index * 3] = px;
        centres[index * 3 + 1] = py;
        centres[index * 3 + 2] = pz;
        shapes[index * 4] = scale;
        shapes[index * 4 + 1] = scale * (0.78 + b * 0.30);
        shapes[index * 4 + 2] = Math.floor(c * CLOUD_PUFF.VARIANTS) % CLOUD_PUFF.VARIANTS;
        shapes[index * 4 + 3] = a;

        // Bases sit cooler and darker than crowns, and the gap has to be large.
        // A cumulus in sunlight is close to white on top and a flat blue-grey
        // underneath; anything narrower reads as a white blob however well each
        // individual puff is shaded.
        const shade = 0.40 + lift * 0.66;
        tints[index * 4] = shade;
        tints[index * 4 + 1] = shade * (0.97 + lift * 0.03);
        tints[index * 4 + 2] = Math.min(1.08, shade * (1.10 - lift * 0.10));
        tints[index * 4 + 3] = 0.55 + site.strength * 0.45;

        // Direction from the cloud's own centre out to this puff, which is what
        // the shader lights against. Vertical is exaggerated relative to the
        // squashed placement so crowns still read as facing up.
        const cx = px - site.x;
        const cy = py - (site.base + site.height * 0.34);
        const cz = pz - site.z;
        const cl = Math.max(1e-3, Math.hypot(cx / site.radius, (cy / site.height) * 1.6, cz / site.radius));
        clusters[index * 4] = cx / site.radius / cl;
        clusters[index * 4 + 1] = ((cy / site.height) * 1.6) / cl;
        clusters[index * 4 + 2] = cz / site.radius / cl;
        clusters[index * 4 + 3] = lift;
        index++;
      }
    }

    this._liveCount = index;
    this.geometry.instanceCount = index;
    // Force the next sort: the buffer contents just changed wholesale.
    this._lastSortAt.set(Infinity, 0, Infinity);
  }

  /**
   * Order the instances back to front for the eye.
   *
   * Alpha blending is not commutative, so a transparent draw is only correct if
   * the fragments arrive far-to-near. three.js sorts *objects*; every puff here
   * is an instance inside one draw, so it sorts nothing for us and the blend
   * order is whatever order the build loop happened to emit — which is why a
   * cloud two kilometres away could appear painted over one in front of it.
   *
   * This is the painter's algorithm, which is what sprite-cloud renderers have
   * always used for exactly this. It is re-run only when the eye has moved far
   * enough to change the ordering; at cruise that is every few frames, and the
   * puffs that swap over a few metres of travel are ones at effectively the
   * same depth, where the blend order does not show.
   */
  _sortBackToFront(cameraPosition) {
    const count = this._liveCount ?? 0;
    if (count === 0) return false;
    if (this._lastSortAt.distanceToSquared(cameraPosition) < SORT_MOVE * SORT_MOVE) return false;

    const src = this._srcCentres;
    const keys = this._depthKeys;
    const order = this._order;
    const cx = cameraPosition.x;
    const cy = cameraPosition.y;
    const cz = cameraPosition.z;
    for (let i = 0; i < count; i++) {
      const dx = src[i * 3] - cx;
      const dy = src[i * 3 + 1] - cy;
      const dz = src[i * 3 + 2] - cz;
      keys[i] = dx * dx + dy * dy + dz * dz;
      order[i] = i;
    }

    // A subarray sort keeps the allocation out of the frame.
    const view = order.subarray(0, count);
    view.sort((a, b) => keys[b] - keys[a]);

    const centres = this._centres;
    const shapes = this._shapes;
    const tints = this._tints;
    const clusters = this._clusters;
    const srcShapes = this._srcShapes;
    const srcTints = this._srcTints;
    const srcClusters = this._srcClusters;
    for (let i = 0; i < count; i++) {
      const j = view[i];
      centres[i * 3] = src[j * 3];
      centres[i * 3 + 1] = src[j * 3 + 1];
      centres[i * 3 + 2] = src[j * 3 + 2];
      for (let k = 0; k < 4; k++) {
        shapes[i * 4 + k] = srcShapes[j * 4 + k];
        tints[i * 4 + k] = srcTints[j * 4 + k];
        clusters[i * 4 + k] = srcClusters[j * 4 + k];
      }
    }

    this.geometry.getAttribute('iCentre').needsUpdate = true;
    this.geometry.getAttribute('iShape').needsUpdate = true;
    this.geometry.getAttribute('iTint').needsUpdate = true;
    this.geometry.getAttribute('iCluster').needsUpdate = true;
    this._lastSortAt.copy(cameraPosition);
    return true;
  }

  update() {
    if (!this._built || !this.enabled) {
      this.geometry.instanceCount = 0;
      return;
    }
    const camera = this.camera;
    const position = camera.position;
    if (this._lastBuildCentre.distanceTo(position) > CLOUD_FIELD.REBUILD_DISTANCE) {
      this._rebuild(position);
    }

    const uniforms = this.material.uniforms;
    camera.updateMatrixWorld();
    // Only needed as the fallback reference where the world-up constraint
    // degenerates, looking straight up or straight down.
    const e = camera.matrixWorld.elements;
    uniforms.uCameraUp.value.set(e[4], e[5], e[6]).normalize();
    uniforms.uCameraPos.value.copy(position);
    uniforms.uCameraNear.value = camera.near;
    uniforms.uCameraFar.value = camera.far;

    this._sortBackToFront(position);
  }

  get puffCount() {
    return this._liveCount ?? 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this._texture?.dispose();
    this._texture = null;
    this._built = false;
  }
}
