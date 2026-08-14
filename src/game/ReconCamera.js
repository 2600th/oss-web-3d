import * as THREE from 'three';
import { POST_RADIUS } from './ObservationPost.js';
import { terrainVisibility } from './TerrainVisibility.js';

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

/**
 * Nominal aperture at each zoom step, for the exposure readout on the overlay.
 *
 * A real long-focus recon lens loses light as it racks out, so the widest usable
 * stop closes with magnification. These are not simulation — nothing in the
 * renderer reads them — but they are *derived from* the zoom the pilot actually
 * selected rather than invented per frame, which is the difference between an
 * instrument and set dressing.
 */
const APERTURE_AT_ZOOM = ['f/4', 'f/4', 'f/5.6', 'f/5.6', 'f/8'];

/** Aperture the overlay should display for a magnification step. */
export function apertureFor(zoomIndex) {
  return APERTURE_AT_ZOOM[zoomIndex] ?? 'f/5.6';
}

const CAPTURE_W = 512;
const CAPTURE_H = 288;
const TRANSIENT_SHOT_RELEASE_MS = 4200;

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

    this.shutterCooldown = 0;
    this.flash = 0;
    /** Exposures made this session — stamped on the plate, like a film counter. */
    this.exposureCount = 0;

    // Offscreen targets for the captured frame. Small on purpose: these are
    // thumbnails on a debrief board, not wallpapers, and reading back a large
    // buffer stalls the pipeline noticeably at 250 m/s.
    //
    // Two of them, alternated, because the readback is now asynchronous: a
    // single target would let the *next* shutter press overwrite pixels the
    // previous exposure has not finished reading, and the debrief would show
    // the same plate twice. RGBA8 is not a preference — readRenderTargetPixels-
    // Async refuses anything else.
    const targetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      colorSpace: THREE.SRGBColorSpace,
    };
    this.captureTargets = [
      new THREE.WebGLRenderTarget(CAPTURE_W, CAPTURE_H, targetOptions),
      new THREE.WebGLRenderTarget(CAPTURE_W, CAPTURE_H, targetOptions),
    ];
    this._targetIndex = 0;
    this._canvas = document.createElement('canvas');
    this._canvas.width = CAPTURE_W;
    this._canvas.height = CAPTURE_H;
    this._ctx = this._canvas.getContext('2d');
    // Reads are issued immediately into per-shot buffers. Only the shared
    // canvas encoder is serialised.
    this._encoding = Promise.resolve();
    this._evaluationByPost = new WeakMap();
    this._pendingShots = new Set();
    this._objectUrls = new Set();
    this._releaseTimers = new Map();
    this._disposed = false;
    this._generation = 0;
  }

  /** Aperture the overlay should display for the selected magnification. */
  get aperture() {
    return apertureFor(this.zoomIndex);
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

    let result = this._evaluationByPost.get(post);
    if (!result) {
      result = {
        post,
        range: 0,
        inFrame: false,
        visibility: 0,
        framing: 0,
        coverage: 0,
        rangeQuality: 0,
        angleQuality: 0,
        score: 0,
      };
      this._evaluationByPost.set(post, result);
    }
    result.range = range;
    result.inFrame = false;
    result.visibility = 0;
    result.framing = 0;
    result.coverage = 0;
    result.rangeQuality = 0;
    result.angleQuality = 0;
    result.score = 0;
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

    // Line of sight is 31 samples of the height function and it is the only
    // expensive term here, so it is gated on the cheap frustum test that has
    // already been done. It used to run for every uncaptured post on every
    // recon frame and then have its result multiplied by a score that the next
    // line forced to zero anyway — five posts' worth of terrain marching thrown
    // away per frame.
    if (!result.inFrame) return result;

    result.visibility = this.lineOfSight(camera.position, post.aimPoint);

    result.score =
      result.visibility *
      (0.30 * result.framing +
        0.25 * result.coverage +
        0.22 * result.rangeQuality +
        0.23 * result.angleQuality);

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
    // Keep scoring and navigation on the same terrain-occlusion contract.
    return terrainVisibility(from, to);
  }

  /**
   * Take the photograph.
   *
   * Returns *immediately*, with a shot record whose `dataUrl` is still null and
   * whose `ready` promise resolves once the plate has been developed. This is
   * the whole point of the shape: the shutter is the most important single
   * frame in the game, and the previous version did a full GPU sync
   * (`readRenderTargetPixels`) plus a base64 JPEG encode inside it — a
   * guaranteed multi-frame hitch at 250 m/s, at the exact moment the player is
   * concentrating hardest. The render still happens on this frame, because the
   * image has to be of *this* instant; everything after it is deferred.
   *
   * @param {object} engine the Engine whose full post chain renders the plate
   */
  capture(engine, evaluation) {
    if (this._disposed) throw new Error('Cannot capture with a disposed ReconCamera');
    if (!engine?.renderer || typeof engine.renderToTarget !== 'function') {
      throw new TypeError('ReconCamera.capture requires Engine.renderToTarget');
    }
    const renderer = engine.renderer;
    const target = this.captureTargets[this._targetIndex];
    this._targetIndex ^= 1;

    engine.renderToTarget(target, this.camera);

    this.flash = 1;
    this.shutterCooldown = 0.55;
    this.exposureCount++;

    this.camera.getWorldDirection(_viewDir);
    const shot = {
      dataUrl: null,
      pending: true,
      frame: this.exposureCount,
      score: evaluation.score,
      range: evaluation.range,
      grade: gradeFor(evaluation.score),
      // Stamped on the plate in the debrief, so a photograph reads as
      // intelligence material with a provenance rather than a screenshot.
      bearing: (((Math.atan2(_viewDir.x, -_viewDir.z) * 180) / Math.PI) + 360) % 360,
      altitude: this.camera.position.y,
      aperture: this.aperture,
      timestamp: Date.now(),
    };
    const pixels = new Uint8Array(CAPTURE_W * CAPTURE_H * 4);
    let read;
    try {
      // Fence/copy this exposure before another shutter can recycle `target`.
      read = this._readPlate(renderer, target, pixels);
    } catch (error) {
      read = Promise.reject(error);
    }
    const generation = this._generation;
    this._pendingShots.add(shot);
    shot.ready = this._develop(read, pixels, shot, generation);
    this.releaseShot(shot, TRANSIENT_SHOT_RELEASE_MS);
    return shot;
  }

  /**
   * Read the exposed plate back and encode it, off the shutter frame.
   *
   * `readRenderTargetPixelsAsync` is a fenced PBO read: it costs nothing on the
   * frame it is issued and resolves a frame or two later. `canvas.toBlob` was
   * chosen over `toDataURL` because it is asynchronous *and* produces an object
   * URL instead of a ~60 KB base64 string per shot — the string was being built
   * on the main thread and then re-parsed by the image decoder. OffscreenCanvas
   * with `convertToBlob` in a worker would move the encode off-thread entirely,
   * but it would also mean transferring the pixels and a worker for one JPEG a
   * minute; `toBlob` already leaves the critical frame clean.
   */
  _readPlate(renderer, target, pixels) {
    if (renderer.readRenderTargetPixelsAsync) {
      return Promise.resolve(renderer.readRenderTargetPixelsAsync(
        target, 0, 0, CAPTURE_W, CAPTURE_H, pixels,
      ));
    }
    renderer.readRenderTargetPixels(target, 0, 0, CAPTURE_W, CAPTURE_H, pixels);
    return Promise.resolve();
  }

  _develop(read, pixels, shot, generation) {
    const encode = async () => {
      try {
        await read;
        if (this._disposed || generation !== this._generation || shot.cancelled) {
          shot.cancelled = true;
          return shot;
        }
        if (shot.releaseRequested) {
          shot.released = true;
          return shot;
        }

        const image = this._ctx.createImageData(CAPTURE_W, CAPTURE_H);
        // GL reads bottom-up; canvas expects top-down.
        const stride = CAPTURE_W * 4;
        for (let y = 0; y < CAPTURE_H; y++) {
          const src = (CAPTURE_H - 1 - y) * stride;
          image.data.set(pixels.subarray(src, src + stride), y * stride);
        }
        this._ctx.putImageData(image, 0, 0);

        const blob = await new Promise((resolve) =>
          this._canvas.toBlob(resolve, 'image/jpeg', 0.82),
        );
        if (!blob) throw new Error('encoder returned no blob');
        if (this._disposed || generation !== this._generation || shot.cancelled) {
          shot.cancelled = true;
          return shot;
        }
        if (shot.releaseRequested) {
          shot.released = true;
          return shot;
        }
        shot.dataUrl = URL.createObjectURL(blob);
        this._objectUrls.add(shot.dataUrl);
      } catch (error) {
        if (this._disposed || generation !== this._generation || shot.cancelled) {
          shot.cancelled = true;
          return shot;
        }
        // A plate that fails to develop is a missing thumbnail, not a lost
        // objective — the score was already recorded from the evaluation.
        console.warn('[recon] exposure could not be developed', error);
        shot.failed = true;
      } finally {
        shot.pending = false;
        this._pendingShots.delete(shot);
      }
      return shot;
    };
    const queueEncode = () => {
      const queued = this._encoding.then(encode, encode);
      this._encoding = queued.then(() => undefined, () => undefined);
      return queued;
    };
    const queued = read.then(queueEncode, queueEncode);
    return queued;
  }

  /** Promote a transient exposure to mission-owned best-shot storage. */
  retainShot(shot) {
    if (!shot || this._disposed || shot.released) return false;
    const timer = this._releaseTimers.get(shot);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._releaseTimers.delete(shot);
    }
    shot.retained = true;
    shot.releaseRequested = false;
    return true;
  }

  /** Release now, or after the bounded HUD preview lease. */
  releaseShot(shot, delayMs = 0) {
    if (!shot || this._disposed) return false;
    const existing = this._releaseTimers.get(shot);
    if (existing !== undefined) clearTimeout(existing);
    this._releaseTimers.delete(shot);
    shot.retained = false;

    if (delayMs > 0 && !shot.released) {
      const timer = setTimeout(() => {
        this._releaseTimers.delete(shot);
        shot.releaseRequested = true;
        shot.released = true;
        this._revokeShotUrl(shot);
      }, delayMs);
      this._releaseTimers.set(shot, timer);
      return true;
    }

    shot.releaseRequested = true;
    shot.released = true;
    this._revokeShotUrl(shot);
    return true;
  }

  _revokeShotUrl(shot) {
    const url = shot?.dataUrl;
    if (!url) return false;
    if (this._objectUrls.delete(url)) URL.revokeObjectURL(url);
    shot.dataUrl = null;
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._generation++;
    for (const shot of this._pendingShots) {
      shot.cancelled = true;
      shot.pending = false;
    }
    this._pendingShots.clear();
    for (const timer of this._releaseTimers.values()) clearTimeout(timer);
    this._releaseTimers.clear();
    for (const target of this.captureTargets) target.dispose();
    for (const url of this._objectUrls) URL.revokeObjectURL(url);
    this._objectUrls.clear();
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
