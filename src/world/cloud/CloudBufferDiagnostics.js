import * as THREE from 'three';

export const CLOUD_ALPHA_OCCUPANCY_THRESHOLD = 0.05;
export const FINAL_COMPOSITE_CONTRAST_THRESHOLD = 0.04;

function deepFreeze(value) {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function assessRawCloudDiagnosticEligibility({
  cloudAssetMode,
  stbnMode,
  nearestLayerBoundaryDistance,
  rawMetrics,
  captureEvidence = null,
}) {
  const reasons = [];
  if (captureEvidence != null && (
    captureEvidence.sameOutputBufferIdentity !== true
    || captureEvidence.sameCloudFrame !== true
  )) reasons.push('cloud-buffer-state-mismatch');
  if (cloudAssetMode !== 'official-pinned') reasons.push('official-cloud-assets-unavailable');
  if (stbnMode !== 'official-pinned') reasons.push('official-stbn-unavailable');
  if (!(nearestLayerBoundaryDistance >= 500)) reasons.push('camera-near-zero-density-boundary');
  if (rawMetrics?.status !== 'MEASURED') reasons.push('cloud-buffer-readback-unavailable');
  else if (!(rawMetrics.alphaOccupancy > 0)) reasons.push('empty-cloud-buffer-alpha');
  return {
    eligible: reasons.length === 0,
    reason: reasons[0] ?? null,
    reasons,
  };
}

function normalisedChannel(pixels, offset) {
  const value = pixels[offset] ?? 0;
  return pixels instanceof Float32Array || pixels instanceof Float64Array
    ? THREE.MathUtils.clamp(value, 0, 1)
    : value / 255;
}

function luminanceAt(pixels, offset) {
  const red = normalisedChannel(pixels, offset);
  const green = normalisedChannel(pixels, offset + 1);
  const blue = normalisedChannel(pixels, offset + 2);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function compositeContrastMask(pixels, width, height, threshold) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const center = luminanceAt(pixels, index * 4);
      let contrast = 0;
      if (x + 1 < width) contrast = Math.max(
        contrast,
        Math.abs(center - luminanceAt(pixels, (index + 1) * 4)),
      );
      if (y + 1 < height) contrast = Math.max(
        contrast,
        Math.abs(center - luminanceAt(pixels, (index + width) * 4)),
      );
      if (x > 0) contrast = Math.max(
        contrast,
        Math.abs(center - luminanceAt(pixels, (index - 1) * 4)),
      );
      if (y > 0) contrast = Math.max(
        contrast,
        Math.abs(center - luminanceAt(pixels, (index - width) * 4)),
      );
      mask[index] = contrast >= threshold ? 1 : 0;
    }
  }
  return mask;
}

function connectedComponentCount(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  let count = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] !== 0) continue;
    count += 1;
    const queue = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || mask[neighbor] === 0 || visited[neighbor] !== 0) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
  }
  return count;
}

export function measureCloudBufferPixels({
  pixels,
  width,
  height,
  alphaThreshold = CLOUD_ALPHA_OCCUPANCY_THRESHOLD,
  finalCompositePixels = null,
  finalCompositeWidth = null,
  finalCompositeHeight = null,
}) {
  if (!(width > 0 && height > 0) || pixels == null || pixels.length !== width * height * 4) {
    return { status: 'UNVERIFIED', reason: 'invalid-cloud-buffer-readback' };
  }
  const mask = new Uint8Array(width * height);
  let occupied = 0;
  let topHalfOccupied = 0;
  let topHalfPixels = 0;
  let maxHorizontalRun = 0;
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const occupiedHere = normalisedChannel(pixels, index * 4 + 3) >= alphaThreshold;
      if (y >= Math.floor(height / 2)) topHalfPixels += 1;
      if (occupiedHere) {
        mask[index] = 1;
        occupied += 1;
        run += 1;
        if (y >= Math.floor(height / 2)) topHalfOccupied += 1;
      } else {
        run = 0;
      }
      maxHorizontalRun = Math.max(maxHorizontalRun, run);
    }
  }
  const finalCompatible = finalCompositePixels != null
    && finalCompositeWidth === width
    && finalCompositeHeight === height
    && finalCompositePixels.length === width * height * 4;
  let finalCompositeContrast = {
    status: 'UNVERIFIED',
    reason: 'final-composite-readback-unavailable',
    threshold: FINAL_COMPOSITE_CONTRAST_THRESHOLD,
    overlapPixels: null,
    overlapRatio: null,
  };
  if (finalCompatible) {
    const contrastMask = compositeContrastMask(
      finalCompositePixels,
      width,
      height,
      FINAL_COMPOSITE_CONTRAST_THRESHOLD,
    );
    const overlapPixels = mask.reduce((total, alpha, index) => (
      total + (alpha !== 0 && contrastMask[index] !== 0 ? 1 : 0)
    ), 0);
    finalCompositeContrast = {
      status: 'MEASURED',
      reason: null,
      threshold: FINAL_COMPOSITE_CONTRAST_THRESHOLD,
      overlapPixels,
      overlapRatio: occupied === 0 ? null : overlapPixels / occupied,
    };
  }
  return deepFreeze({
    status: 'MEASURED',
    reason: null,
    source: 'cloudsPass.outputBuffer',
    width,
    height,
    alphaThreshold,
    alphaOccupancy: occupied / mask.length,
    topHalfAlphaOccupancy: topHalfPixels === 0 ? 0 : topHalfOccupied / topHalfPixels,
    connectedComponents: connectedComponentCount(mask, width, height),
    maxHorizontalRun,
    finalCompositeContrast,
  });
}

function cloudOutputRenderTarget(clouds) {
  const pass = clouds?.cloudsPass;
  const output = pass?.outputBuffer;
  if (output == null) return null;
  return [pass.historyRenderTarget, pass.resolveRenderTarget, pass.currentRenderTarget]
    .find(target => target?.texture === output) ?? null;
}

function createReadbackBuffer(textureType, length) {
  if (textureType === THREE.HalfFloatType) return new Uint16Array(length);
  if (textureType === THREE.FloatType) return new Float32Array(length);
  return new Uint8Array(length);
}

function readbackSentinel(buffer) {
  if (buffer instanceof Float32Array) return Number.NaN;
  if (buffer instanceof Uint16Array) return 0xffff;
  return 0xa5;
}

function hasReadbackWrite(buffer, sentinel) {
  return buffer.some(value => !Object.is(value, sentinel));
}

export function readCloudOutputBuffer(renderer, clouds) {
  const target = cloudOutputRenderTarget(clouds);
  if (target == null || typeof renderer?.readRenderTargetPixels !== 'function') {
    return { status: 'UNVERIFIED', reason: 'cloud-buffer-readback-unavailable' };
  }
  const width = target.width;
  const height = target.height;
  if (!(width > 0 && height > 0)) {
    return { status: 'UNVERIFIED', reason: 'invalid-cloud-buffer-size' };
  }
  const gl = renderer.getContext?.();
  if (typeof gl?.getError !== 'function') {
    return { status: 'UNVERIFIED', reason: 'cloud-buffer-readback-validation-unavailable' };
  }
  const noError = gl.NO_ERROR ?? 0;
  if (gl.getError() !== noError) {
    return { status: 'UNVERIFIED', reason: 'cloud-buffer-readback-preexisting-gl-error' };
  }
  const rawPixels = createReadbackBuffer(target.texture.type, width * height * 4);
  const sentinel = readbackSentinel(rawPixels);
  rawPixels.fill(sentinel);
  try {
    const result = renderer.readRenderTargetPixels(target, 0, 0, width, height, rawPixels);
    if (result?.then != null) {
      return { status: 'UNVERIFIED', reason: 'cloud-buffer-readback-async-unsupported' };
    }
  } catch (error) {
    return {
      status: 'UNVERIFIED',
      reason: 'cloud-buffer-readback-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (gl.getError() !== noError) {
    return { status: 'UNVERIFIED', reason: 'cloud-buffer-readback-gl-error' };
  }
  if (!hasReadbackWrite(rawPixels, sentinel)) {
    return { status: 'UNVERIFIED', reason: 'cloud-buffer-readback-no-buffer-write' };
  }
  const pixels = rawPixels instanceof Uint16Array
    ? Float32Array.from(rawPixels, value => THREE.DataUtils.fromHalfFloat(value))
    : rawPixels;
  return { status: 'MEASURED', target, width, height, pixels };
}
