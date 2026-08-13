import * as THREE from 'three';
import { terrainHeight } from '../world/heightfield.js';
import { POST_RADIUS } from './ObservationPost.js';

/**
 * The reconnaissance camera: a fixed forward-oblique installation in the nose,
 * with a zoom, a live quality readout and a shutter.
 *
 * It is deliberately *fixed to the airframe* rather than a free-look gimbal.
 * A steerable camera turns the mission into aiming a turret and makes the
 * flying incidental; a fixed camera means the only way to frame a target is to
 * fly the pass properly — line up the run, hold the attitude, judge the range.
 * That keeps flight feel at the centre of the experience, and it is how a real
 * recon installation of the period worked.
 *
 * Scoring follows the brief: visibility, framing, distance, screen coverage and
 * viewing angle. Visibility multiplies rather than adds, because a photograph
 * of a ridge with the target behind it is worth nothing however well composed.
 */

/**
 * Camera depression below the airframe's waterline.
 *
 * 11 degrees is the sweet spot found by testing approach geometry: at a
 * 1.5-3 km stand-off it puts the target on the optical axis when the aircraft
 * is 300-600 m above it, which is a natural height to be flying at anyway.
 * Shallower and the pilot has to push the nose down and dive at the ridge to
 * frame anything; steeper and the target is buried under the nose.
 */
const DEPRESSION = THREE.MathUtils.degToRad(11);

export const ZOOM_STEPS = [34, 24, 17, 12, 8.5];

const IDEAL_RANGE_MIN = 320;
const IDEAL_RANGE_MAX = 2400;
const HARD_RANGE_MAX = 5200;

const _pos = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler();

export class ReconCamera {
  constructor(camera) {
    this.camera = camera;
    this.active = false;
    this.zoomIndex = 2;
    this.fov = ZOOM_STEPS[this.zoomIndex];
    this._fovSmoothed = this.fov;

    this.lastShot = null;
    this.shutterCooldown = 0;
    this.flash = 0;

    // Offscreen target for the captured frame. Small on purpose: these are
    // thumbnails on a debrief board, not wallpapers, and reading back a large
    // buffer stalls the pipeline noticeably at 250 m/s.
    this.captureTarget = new THREE.WebGLRenderTarget(512, 288, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      colorSpace: THREE.SRGBColorSpace,
    });
    this._pixels = new Uint8Array(512 * 288 * 4);
    this._canvas = document.createElement('canvas');
    this._canvas.width = 512;
    this._canvas.height = 288;
    this._ctx = this._canvas.getContext('2d');
  }

  setZoom(index) {
    this.zoomIndex = THREE.MathUtils.clamp(index, 0, ZOOM_STEPS.length - 1);
    this.fov = ZOOM_STEPS[this.zoomIndex];
  }

  zoomIn() {
    this.setZoom(this.zoomIndex + 1);
  }

  zoomOut() {
    this.setZoom(this.zoomIndex - 1);
  }

  /** Place the camera in the nose and point it along the airframe, angled down. */
  update(dt, flight) {
    this.shutterCooldown = Math.max(0, this.shutterCooldown - dt);
    this.flash = Math.max(0, this.flash - dt * 3.2);

    _pos.copy(flight.position).addScaledVector(flight.forward, 5.4).addScaledVector(flight.up, -0.9);
    this.camera.position.copy(_pos);

    _euler.set(-DEPRESSION, 0, 0, 'XYZ');
    _q.setFromEuler(_euler);
    this.camera.quaternion.copy(flight.orientation).multiply(_q);

    // Zoom eases rather than snapping, so a change of magnification reads as a
    // lens moving and not as a teleport.
    this._fovSmoothed += (this.fov - this._fovSmoothed) * (1 - Math.exp(-11 * dt));
    if (Math.abs(this.camera.fov - this._fovSmoothed) > 0.005) {
      this.camera.fov = this._fovSmoothed;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  /**
   * Score what the camera is currently looking at, for a given post.
   * Returns a breakdown so the HUD can show the pilot *why* a shot is weak.
   */
  evaluate(post) {
    const camera = this.camera;
    _toTarget.subVectors(post.aimPoint, camera.position);
    const range = _toTarget.length();

    const result = {
      post,
      range,
      inFrame: false,
      visibility: 0,
      framing: 0,
      coverage: 0,
      rangeQuality: 0,
      angleQuality: 0,
      score: 0,
    };
    if (range < 1) return result;

    _ndc.copy(post.aimPoint).project(camera);
    const behind = _ndc.z > 1 || _ndc.z < -1;
    const offset = Math.hypot(_ndc.x, _ndc.y);
    result.inFrame = !behind && Math.abs(_ndc.x) < 1 && Math.abs(_ndc.y) < 1;

    // Framing: dead centre is best, and it falls away smoothly rather than at
    // the frame edge, so a shot that clips the border still scores something.
    result.framing = clamp01(1 - offset / 1.05);

    // Screen coverage from the true angular size of the camp footprint.
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const angular = 2 * Math.atan(POST_RADIUS / range);
    const fraction = angular / vFov;
    result.coverage = band(fraction, 0.1, 0.22, 0.8, 1.5);

    result.rangeQuality = band(range, 160, IDEAL_RANGE_MIN, IDEAL_RANGE_MAX, HARD_RANGE_MAX);

    // Viewing angle: an oblique looking down onto the position is what makes a
    // usable photograph. Straight-on from the same altitude shows nothing, and
    // straight down loses the terrain context.
    camera.getWorldDirection(_viewDir);
    const depression = Math.asin(clamp(-_viewDir.y, -1, 1));
    result.angleQuality = band(depression, -0.08, 0.10, 0.72, 1.15);

    result.visibility = this.lineOfSight(camera.position, post.aimPoint);

    result.score =
      result.visibility *
      (0.30 * result.framing +
        0.25 * result.coverage +
        0.22 * result.rangeQuality +
        0.23 * result.angleQuality);

    if (!result.inFrame) result.score = 0;
    return result;
  }

  /**
   * Terrain line-of-sight, 0 (blocked) to 1 (clear).
   *
   * Marches the shared height function rather than casting into the scene:
   * there is no terrain mesh to raycast against — it only exists in the vertex
   * shader — and this is the same field the GPU draws, so the answer always
   * agrees with what the pilot can actually see.
   */
  lineOfSight(from, to) {
    // Sample the span between the camera and the target, excluding both ends.
    // The target *is* ground — the aim point sits a few metres above a hillside
    // — so including the last few per cent measures the site against itself and
    // caps every shot at a low score no matter how clear the approach. The near
    // end is skipped for the same reason when flying low.
    const steps = 30;
    const first = 0.05;
    const last = 0.9;
    let clearance = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = first + ((last - first) * i) / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const z = from.z + (to.z - from.z) * t;
      const margin = y - terrainHeight(x, z);
      if (margin < clearance) clearance = margin;
    }
    if (clearance <= 0) return 0;
    // Soft edge: skimming a ridge crest degrades the shot rather than being
    // pass/fail, which keeps low approaches tense instead of binary.
    return clamp01(clearance / 40);
  }

  /**
   * Take the photograph. Renders the scene through the recon camera into an
   * offscreen buffer and returns a data URL plus the score breakdown.
   */
  capture(renderer, scene, evaluation) {
    const previousTarget = renderer.getRenderTarget();
    const previousToneMapping = renderer.toneMapping;
    const previousExposure = renderer.toneMappingExposure;

    // The main path tone-maps in the post chain, which this offscreen render
    // bypasses; without this the thumbnail comes out blown out and linear.
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setRenderTarget(this.captureTarget);
    renderer.render(scene, this.camera);
    renderer.readRenderTargetPixels(this.captureTarget, 0, 0, 512, 288, this._pixels);
    renderer.setRenderTarget(previousTarget);
    renderer.toneMapping = previousToneMapping;
    renderer.toneMappingExposure = previousExposure;

    const image = this._ctx.createImageData(512, 288);
    // GL reads bottom-up; canvas expects top-down.
    for (let y = 0; y < 288; y++) {
      const src = (287 - y) * 512 * 4;
      const dst = y * 512 * 4;
      image.data.set(this._pixels.subarray(src, src + 512 * 4), dst);
    }
    this._ctx.putImageData(image, 0, 0);

    this.flash = 1;
    this.shutterCooldown = 0.55;

    return {
      dataUrl: this._canvas.toDataURL('image/jpeg', 0.82),
      score: evaluation.score,
      range: evaluation.range,
      grade: gradeFor(evaluation.score),
      timestamp: Date.now(),
    };
  }

  dispose() {
    this.captureTarget.dispose();
  }
}

export function gradeFor(score) {
  if (score >= 0.78) return 'EXCELLENT';
  if (score >= 0.62) return 'GOOD';
  if (score >= 0.46) return 'USABLE';
  if (score >= 0.25) return 'POOR';
  return 'UNUSABLE';
}

/** Minimum score that counts an objective as photographed. */
export const CAPTURE_THRESHOLD = 0.46;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v) {
  return clamp(v, 0, 1);
}

/** Trapezoid: 0 below `lo`, 1 across the plateau, 0 above `hi`. */
function band(v, lo, plateauLo, plateauHi, hi) {
  if (v <= lo || v >= hi) return 0;
  if (v < plateauLo) return smoothstep(lo, plateauLo, v);
  if (v > plateauHi) return 1 - smoothstep(plateauHi, hi, v);
  return 1;
}

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
