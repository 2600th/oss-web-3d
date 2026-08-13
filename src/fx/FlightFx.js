import * as THREE from 'three';
import { terrainHeight, terrainSlope } from '../world/heightfield.js';

/**
 * Speed streaks, wingtip trails and ridge spindrift.
 *
 * Both exist to solve the same problem: at 250 m/s over terrain a kilometre
 * below, there is nothing close to the camera for the eye to measure motion
 * against, so a fast jet reads as a slow one. Streaks give the eye near-field
 * reference; the trails give the manoeuvre a visible history. Together they do
 * more for the sense of speed than any amount of FOV or camera shake, and
 * unlike shake they do not cost the player their sense of where the horizon is.
 */

const TRAIL_SAMPLES = 96;

export class FlightFx {
  constructor(environment) {
    this.environment = environment;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;

    this._buildStreaks();
    this._buildTrails();
    this._buildSpindrift();
  }

  // ------------------------------------------------------------ spindrift --

  /**
   * Snow streaming off the ridge crests.
   *
   * The streaks above are near-field reference that happens to be near the
   * camera; this is near-field reference *attached to the terrain*, which is
   * the stronger cue. Perceived speed tracks how many discontinuities cross
   * the eye per second, and a plume that is anchored to a ridge and sweeps past
   * as the aircraft crosses it gives the eye something with a known position to
   * measure against — which streaks floating in a sphere around the camera
   * cannot. It also does what the brief asks for directly, and it is the reason
   * flying a ridgeline reads differently from flying a valley.
   *
   * Particles seed only on genuinely wind-scoured ground: steep, high, and
   * within a short distance of the aircraft, so the cost is bounded regardless
   * of altitude.
   */
  _buildSpindrift(max = 260) {
    this.maxDrift = max;
    this.driftCount = max;
    this.driftPos = new Float32Array(max * 3);
    this.driftVel = new Float32Array(max * 3);
    this.driftAge = new Float32Array(max);
    this.driftLife = new Float32Array(max);
    this.driftAlpha = new Float32Array(max);
    this.driftSize = new Float32Array(max);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.driftPos, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.driftAlpha, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.driftSize, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { uScale: { value: 700 } },
      vertexShader: /* glsl */ `
        precision highp float;
        in float aAlpha;
        in float aSize;
        uniform float uScale;
        out float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = max(2.0, aSize * uScale / max(-view.z, 1.0));
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in float vAlpha;
        out vec4 fragColor;
        void main() {
          vec2 d = gl_PointCoord * 2.0 - 1.0;
          float r = dot(d, d);
          if (r > 1.0) discard;
          fragColor = vec4(vec3(0.93, 0.95, 1.0), vAlpha * (1.0 - r) * 0.55);
        }
      `,
    });

    this.spindrift = new THREE.Points(geometry, material);
    this.spindrift.frustumCulled = false;
    this.spindrift.renderOrder = 13;
    this.group.add(this.spindrift);
    this._driftMaterial = material;
  }

  _respawnDrift(i, flight) {
    const o = i * 3;
    // Look for scoured ground a little ahead of the aircraft, biased along the
    // flight path so plumes appear before they are passed rather than behind.
    const ahead = 260 + Math.random() * 900;
    const spread = 620;
    const fx = flight.position.x + flight.forward.x * ahead + (Math.random() - 0.5) * spread;
    const fz = flight.position.z + flight.forward.z * ahead + (Math.random() - 0.5) * spread;
    const h = terrainHeight(fx, fz);

    // Only crests hold blowing snow: steep enough to be scoured, high enough to
    // be snow rather than rock. Failures cost one height sample and the slot is
    // simply retried next frame.
    if (h < 4600 || terrainSlope(fx, fz, 24) < 0.22) {
      this.driftAlpha[i] = 0;
      this.driftLife[i] = 0;
      return;
    }

    const wind = this.environment.uniforms.uWind.value;
    this.driftPos[o] = fx;
    this.driftPos[o + 1] = h + 2 + Math.random() * 14;
    this.driftPos[o + 2] = fz;
    this.driftVel[o] = wind.x * (0.7 + Math.random() * 0.7);
    this.driftVel[o + 1] = 3 + Math.random() * 9;
    this.driftVel[o + 2] = wind.y * (0.7 + Math.random() * 0.7);
    this.driftAge[i] = 0;
    this.driftLife[i] = 1.6 + Math.random() * 2.2;
    this.driftSize[i] = 5 + Math.random() * 16;
  }

  _updateSpindrift(dt, flight) {
    // A low-level effect on purpose. Seen from altitude these would be
    // sub-pixel specks costing height samples for nothing.
    const near = 1 - THREE.MathUtils.smoothstep(flight.agl, 420, 1500);
    this.spindrift.visible = this.driftsEnabled !== false && near > 0.01;
    if (!this.spindrift.visible) return;

    for (let i = 0; i < this.driftCount; i++) {
      if (this.driftLife[i] <= 0) {
        this._respawnDrift(i, flight);
        continue;
      }
      const o = i * 3;
      this.driftAge[i] += dt;
      const t = this.driftAge[i] / this.driftLife[i];
      if (t >= 1) {
        this.driftLife[i] = 0;
        this.driftAlpha[i] = 0;
        continue;
      }
      this.driftPos[o] += this.driftVel[o] * dt;
      this.driftPos[o + 1] += this.driftVel[o + 1] * dt;
      this.driftPos[o + 2] += this.driftVel[o + 2] * dt;
      this.driftVel[o + 1] -= 1.6 * dt; // the plume settles as it loses the crest
      // Fade in fast, out slow, so a plume looks lifted rather than switched on.
      this.driftAlpha[i] = Math.min(1, t * 6) * (1 - t) * near;
    }

    this.spindrift.geometry.attributes.position.needsUpdate = true;
    this.spindrift.geometry.attributes.aAlpha.needsUpdate = true;
    this.spindrift.geometry.attributes.aSize.needsUpdate = true;
  }

  // --------------------------------------------------------------- streaks --

  _buildStreaks(max = 700) {
    this.maxStreaks = max;
    this.streakCount = max;

    // Two vertices per streak, drawn as a line segment stretched along the
    // aircraft's motion. Lines are the cheapest primitive that still conveys
    // direction, and these are only ever seen for a few frames each.
    this.streakPositions = new Float32Array(max * 6);
    this.streakAlpha = new Float32Array(max * 2);
    this.streakOrigins = new Float32Array(max * 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.streakPositions, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.streakAlpha, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uIntensity: { value: 0 } },
      vertexShader: /* glsl */ `
        precision highp float;
        in float aAlpha;
        out float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in float vAlpha;
        uniform float uIntensity;
        out vec4 fragColor;
        void main() {
          fragColor = vec4(vec3(0.86, 0.92, 1.0), vAlpha * uIntensity);
        }
      `,
    });

    this.streaks = new THREE.LineSegments(geometry, material);
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 14;
    this.group.add(this.streaks);
    this._streakMaterial = material;
    this._streaksSeeded = false;
  }

  _seedStreaks(centre) {
    for (let i = 0; i < this.maxStreaks; i++) this._respawnStreak(i, centre, true);
    this._streaksSeeded = true;
  }

  _respawnStreak(i, centre, anywhere) {
    const o = i * 3;
    const spread = 190;
    this.streakOrigins[o] = centre.x + (Math.random() - 0.5) * spread * 2;
    this.streakOrigins[o + 1] = centre.y + (Math.random() - 0.5) * spread;
    this.streakOrigins[o + 2] = centre.z + (Math.random() - 0.5) * spread * 2;
    if (!anywhere) {
      // Push new streaks out ahead so they sweep past rather than popping in.
      this.streakOrigins[o] += (Math.random() - 0.5) * 40;
    }
  }

  // ---------------------------------------------------------------- trails --

  _buildTrails() {
    this.trails = [];
    for (let side = 0; side < 2; side++) {
      const positions = new Float32Array(TRAIL_SAMPLES * 2 * 3);
      const alpha = new Float32Array(TRAIL_SAMPLES * 2);
      const indices = [];
      for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
      geometry.setIndex(indices);
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {},
        vertexShader: /* glsl */ `
          precision highp float;
          in float aAlpha;
          out float vAlpha;
          void main() {
            vAlpha = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          in float vAlpha;
          out vec4 fragColor;
          void main() {
            if (vAlpha < 0.004) discard;
            fragColor = vec4(vec3(0.96, 0.975, 1.0), vAlpha);
          }
        `,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 13;
      this.group.add(mesh);

      this.trails.push({
        mesh,
        positions,
        alpha,
        head: 0,
        filled: 0,
        // Ring-buffer history: world position, ribbon side vector, birth alpha.
        history: new Array(TRAIL_SAMPLES).fill(null).map(() => ({
          p: new THREE.Vector3(),
          s: new THREE.Vector3(),
          a: 0,
          w: 1,
        })),
      });
    }
    this._emitAccumulator = 0;
  }

  setQuality(tier) {
    this.streakCount = Math.min(this.maxStreaks, tier.speedParticles);
    this.streaks.geometry.setDrawRange(0, this.streakCount * 2);
    this.trailsEnabled = tier.contrails;
    for (const t of this.trails) t.mesh.visible = tier.contrails;
    // Spindrift costs CPU height samples rather than fill, so it scales with
    // the same budget that governs the other near-field particles.
    this.driftCount = Math.min(this.maxDrift, Math.round(tier.speedParticles * 0.4));
    this.driftsEnabled = this.driftCount > 0;
    this.spindrift.geometry.setDrawRange(0, this.driftCount);
  }

  reset() {
    for (const t of this.trails) {
      t.filled = 0;
      t.head = 0;
      t.alpha.fill(0);
      t.mesh.geometry.attributes.aAlpha.needsUpdate = true;
    }
    this._streaksSeeded = false;
    this.driftLife.fill(0);
    this.driftAlpha.fill(0);
  }

  /**
   * @param {FlightModel} flight
   * @param {THREE.Vector3} cameraPos
   */
  update(dt, flight, cameraPos) {
    this._updateStreaks(dt, flight, cameraPos);
    if (this.trailsEnabled !== false) this._updateTrails(dt, flight);
    this._updateSpindrift(dt, flight);
  }

  _updateStreaks(dt, flight, cameraPos) {
    if (!this._streaksSeeded) this._seedStreaks(cameraPos);

    const speed = flight.airspeed;
    // Below ~140 m/s streaks would be visible dust rather than a speed cue.
    const intensity = THREE.MathUtils.clamp((speed - 140) / 260, 0, 1);
    this._streakMaterial.uniforms.uIntensity.value = intensity * 0.5;
    this.streaks.visible = intensity > 0.01;
    if (!this.streaks.visible) return;

    const vx = flight.velocity.x;
    const vy = flight.velocity.y;
    const vz = flight.velocity.z;
    const length = 0.055 + 0.05 * intensity;

    const spread = 190;
    const spreadSq = spread * spread * 2.6;

    for (let i = 0; i < this.streakCount; i++) {
      const o = i * 3;
      // Streaks are static in the world; the aircraft moves through them, which
      // is what makes the parallax read as speed rather than as a moving fog.
      const dx = this.streakOrigins[o] - cameraPos.x;
      const dy = this.streakOrigins[o + 1] - cameraPos.y;
      const dz = this.streakOrigins[o + 2] - cameraPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > spreadSq) {
        this._respawnStreak(i, cameraPos, false);
        continue;
      }

      const v = i * 6;
      this.streakPositions[v] = this.streakOrigins[o];
      this.streakPositions[v + 1] = this.streakOrigins[o + 1];
      this.streakPositions[v + 2] = this.streakOrigins[o + 2];
      this.streakPositions[v + 3] = this.streakOrigins[o] - vx * length;
      this.streakPositions[v + 4] = this.streakOrigins[o + 1] - vy * length;
      this.streakPositions[v + 5] = this.streakOrigins[o + 2] - vz * length;

      // Fade at both ends. The far fade stops the spawn sphere showing up as a
      // box edge. The near fade matters more: a streak a few metres off the
      // lens is drawn tens of metres long, so it sweeps most of the frame in
      // one frame and reads as a scratch on the canopy rather than as speed.
      const dist = Math.sqrt(distSq);
      const near = THREE.MathUtils.smoothstep(dist, 22, 60);
      const fade = (1 - distSq / spreadSq) * near;
      this.streakAlpha[i * 2] = fade * 0.6;
      this.streakAlpha[i * 2 + 1] = 0;
    }

    this.streaks.geometry.attributes.position.needsUpdate = true;
    this.streaks.geometry.attributes.aAlpha.needsUpdate = true;
  }

  _updateTrails(dt, flight) {
    // Two sources, and they behave differently. Persistent contrails need cold
    // air, so they only form high up. Wingtip vapour is a pressure effect and
    // appears whenever the wing is working hard, at any altitude — which is why
    // it reads as "that was a hard turn" rather than as weather.
    const altitudeTrail = THREE.MathUtils.clamp((flight.altitude - 6400) / 900, 0, 1);
    const gVapour = THREE.MathUtils.clamp((Math.abs(flight.gLoad) - 3.4) / 3.6, 0, 1);
    const strength = Math.min(1, altitudeTrail * 0.85 + gVapour);
    const speedGate = THREE.MathUtils.clamp((flight.airspeed - 110) / 120, 0, 1);
    const emit = strength * speedGate;

    // Emit at a fixed rate in *distance*, so trail density does not change with
    // frame rate or airspeed.
    this._emitAccumulator += flight.airspeed * dt;
    const spacing = 14;
    let emits = 0;
    while (this._emitAccumulator >= spacing && emits < 6) {
      this._emitAccumulator -= spacing;
      emits++;

      for (let side = 0; side < 2; side++) {
        const trail = this.trails[side];
        const sign = side === 0 ? -1 : 1;
        const sample = trail.history[trail.head];
        sample.p
          .copy(flight.position)
          .addScaledVector(flight.right, sign * 3.4)
          .addScaledVector(flight.forward, -2.2);
        sample.s.copy(flight.up);
        sample.a = emit;
        sample.w = 1.1 + 2.6 * gVapour + 1.4 * altitudeTrail;
        trail.head = (trail.head + 1) % TRAIL_SAMPLES;
        trail.filled = Math.min(trail.filled + 1, TRAIL_SAMPLES);
      }
    }

    const decay = Math.exp(-dt * 0.13);
    for (const trail of this.trails) {
      for (let i = 0; i < TRAIL_SAMPLES; i++) {
        const sample = trail.history[i];
        sample.a *= decay;
        // Contrails spread and thin as they age.
        sample.w += dt * 0.8;
      }

      // Rebuild the ribbon oldest-to-newest so the strip is continuous.
      //
      // Start at the oldest *valid* sample, not at head. Writes advance head,
      // so while the buffer is still filling the live samples sit in the slots
      // *behind* it and the slots at head are untouched. Walking from head and
      // then drawing the first (filled - 1) quads drew exactly the uninitialised
      // ones, so a trail did not appear at all until a full 96-sample history
      // had accumulated — several seconds after the manoeuvre that earned it.
      const count = trail.filled;
      const start = (trail.head - count + TRAIL_SAMPLES) % TRAIL_SAMPLES;
      const span = Math.max(count - 1, 1);
      for (let i = 0; i < count; i++) {
        const index = (start + i) % TRAIL_SAMPLES;
        const sample = trail.history[index];
        const age = i / span; // 0 = oldest
        const v = i * 6;
        const half = sample.w;
        trail.positions[v] = sample.p.x + sample.s.x * half;
        trail.positions[v + 1] = sample.p.y + sample.s.y * half;
        trail.positions[v + 2] = sample.p.z + sample.s.z * half;
        trail.positions[v + 3] = sample.p.x - sample.s.x * half;
        trail.positions[v + 4] = sample.p.y - sample.s.y * half;
        trail.positions[v + 5] = sample.p.z - sample.s.z * half;

        // Taper the newest end so the ribbon grows out of the wingtip instead
        // of appearing as a blunt rectangle.
        const taper = Math.min(1, (1 - age) * 6);
        const a = sample.a * age * taper * 0.85;
        trail.alpha[i * 2] = a;
        trail.alpha[i * 2 + 1] = a;
      }

      trail.mesh.geometry.attributes.position.needsUpdate = true;
      trail.mesh.geometry.attributes.aAlpha.needsUpdate = true;
      trail.mesh.geometry.setDrawRange(0, Math.max(0, (trail.filled - 1) * 6));
    }
  }

  dispose() {
    this.streaks.geometry.dispose();
    this._streakMaterial.dispose();
    for (const t of this.trails) {
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
    }
  }
}
