const DEFAULT_WARMUP_FRAMES = 120;
const DEFAULT_MINIMUM_SAMPLES = 180;
const DEFAULT_MAX_PENDING_QUERIES = 32;

function finite(values) {
  return values.filter(Number.isFinite);
}

export function summarizeSamples(values) {
  const sorted = finite(values).toSorted((a, b) => a - b);
  if (sorted.length === 0) return { median: null, p95: null };
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  return { median, p95 };
}

export function bytesForTarget({
  width,
  height,
  channels,
  bytesPerChannel,
  layers = 1,
  samples = 1,
  attachments = 1,
  history = 1,
  mipLevels = 1,
}) {
  let mipWidth = Math.max(1, Math.floor(width));
  let mipHeight = Math.max(1, Math.floor(height));
  let texels = 0;
  for (let level = 0; level < Math.max(1, mipLevels); level += 1) {
    texels += mipWidth * mipHeight;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
  return texels
    * Math.max(1, layers)
    * Math.max(1, samples)
    * Math.max(1, attachments)
    * Math.max(1, history)
    * channels
    * bytesPerChannel;
}

export function summarizeResourceReport(report = {}) {
  const byKind = {};
  for (const resource of report.resources ?? []) {
    const kind = resource.kind ?? (resource.width != null ? 'render-target' : 'unknown');
    byKind[kind] = (byKind[kind] ?? 0) + (Number.isFinite(resource.bytes) ? resource.bytes : 0);
  }
  const targetBytes = Object.entries(byKind)
    .filter(([kind]) => kind === 'render-target' || kind.endsWith('-render-target'))
    .reduce((total, [, bytes]) => total + bytes, 0);
  const totalBytes = Object.values(byKind).reduce((total, bytes) => total + bytes, 0);
  return { targetBytes, assetBytes: totalBytes - targetBytes, totalBytes, byKind };
}

export function combineOwnedResourceItems({
  backendResources = [],
  atmosphereResources = [],
  stbnResource = null,
}) {
  const items = [...backendResources, ...atmosphereResources];
  const backendOwnsStbn = items.some(resource => resource.kind === 'sampling-texture'
    && (resource.name === 'stbn-external' || resource.name === 'official-stbn'));
  if (stbnResource != null && !backendOwnsStbn) items.push(stbnResource);
  return items;
}

export class GpuTimerQuery {
  constructor(gl, { maxPending = DEFAULT_MAX_PENDING_QUERIES } = {}) {
    this.gl = gl;
    this.extension = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
    this.maxPending = Math.max(1, maxPending);
    this.pending = [];
    this.active = null;
    this.samplesMs = [];
    this.disjointCount = 0;
    this.droppedCount = 0;
  }

  get supported() {
    return this.extension != null;
  }

  begin() {
    if (!this.supported || this.active != null) return false;
    if (this.pending.length >= this.maxPending) {
      this.droppedCount += 1;
      return false;
    }
    const query = this.gl.createQuery();
    if (query == null) {
      this.droppedCount += 1;
      return false;
    }
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.active = query;
    return true;
  }

  end() {
    if (this.active == null) return false;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    return true;
  }

  poll() {
    if (!this.supported) return 0;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      this.disjointCount += this.pending.length;
      for (const query of this.pending) this.gl.deleteQuery(query);
      this.pending.length = 0;
      return 0;
    }
    let resolved = 0;
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const nanoseconds = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
      if (Number.isFinite(nanoseconds) && nanoseconds >= 0) {
        this.samplesMs.push(nanoseconds / 1_000_000);
        resolved += 1;
      } else {
        this.droppedCount += 1;
      }
      this.pending.shift();
      this.gl.deleteQuery(query);
    }
    return resolved;
  }

  resetSamples() {
    this.samplesMs.length = 0;
    this.disjointCount = 0;
    this.droppedCount = 0;
  }

  dispose() {
    if (this.active != null) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
  }

  snapshot() {
    return {
      supported: this.supported,
      status: this.supported ? (this.samplesMs.length > 0 ? 'MEASURED' : 'PENDING') : 'UNVERIFIED',
      samplesMs: [...this.samplesMs],
      disjointCount: this.disjointCount,
      droppedCount: this.droppedCount,
      pendingCount: this.pending.length,
    };
  }
}

function defaultVisibility() {
  if (typeof document === 'undefined') return { visibilityState: 'unknown', focused: null };
  return {
    visibilityState: document.visibilityState ?? 'unknown',
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
  };
}

export class CloudBenchmark {
  constructor(gl, {
    warmupFrames = DEFAULT_WARMUP_FRAMES,
    minimumSamples = DEFAULT_MINIMUM_SAMPLES,
    now = () => performance.now(),
    visibility = defaultVisibility,
  } = {}) {
    this.gl = gl;
    this.warmupFrames = Math.max(DEFAULT_WARMUP_FRAMES, warmupFrames);
    this.minimumSamples = Math.max(DEFAULT_MINIMUM_SAMPLES, minimumSamples);
    this.now = now;
    this.visibility = visibility;
    this.gpu = new GpuTimerQuery(gl);
    this.frameCount = 0;
    this.cpuSamplesMs = [];
    this.frameIntervalsMs = [];
    this.visibilityStates = new Set();
    this.focusStates = new Set();
    this.rejectedFrames = 0;
  }

  measure(render) {
    const observation = this.visibility();
    this.visibilityStates.add(observation.visibilityState);
    this.focusStates.add(observation.focused);
    const eligible = observation.visibilityState === 'visible' && observation.focused !== false;
    const afterWarmup = this.frameCount >= this.warmupFrames;
    const cpuCapturing = afterWarmup && this.cpuSamplesMs.length < this.minimumSamples;
    const gpuCapturing = afterWarmup && this.gpu.supported
      && this.gpu.samplesMs.length + this.gpu.pending.length < this.minimumSamples;
    if (!eligible) this.rejectedFrames += 1;
    const measureCpu = cpuCapturing && eligible;
    const start = measureCpu ? this.now() : 0;
    const gpuStarted = gpuCapturing && eligible && this.gpu.begin();
    try {
      return render();
    } finally {
      if (gpuStarted) this.gpu.end();
      if (measureCpu) this.cpuSamplesMs.push(this.now() - start);
      this.frameCount += 1;
      this.gpu.poll();
    }
  }

  poll() {
    return this.gpu.poll();
  }

  recordFrameInterval(milliseconds) {
    const observation = this.visibility();
    const eligible = observation.visibilityState === 'visible' && observation.focused !== false;
    if (eligible && Number.isFinite(milliseconds) && milliseconds > 0
      && this.frameIntervalsMs.length < this.minimumSamples) {
      this.frameIntervalsMs.push(milliseconds);
    }
  }

  get complete() {
    if (this.cpuSamplesMs.length < this.minimumSamples) return false;
    return !this.gpu.supported || this.gpu.samplesMs.length >= this.minimumSamples;
  }

  reset() {
    this.gpu.dispose();
    this.gpu = new GpuTimerQuery(this.gl);
    this.frameCount = 0;
    this.cpuSamplesMs.length = 0;
    this.frameIntervalsMs.length = 0;
    this.visibilityStates.clear();
    this.focusStates.clear();
    this.rejectedFrames = 0;
  }

  recreate(gl) {
    this.gpu.dispose();
    this.gl = gl;
    this.gpu = new GpuTimerQuery(gl);
  }

  report() {
    this.gpu.poll();
    const cpuStats = summarizeSamples(this.cpuSamplesMs);
    const frameStats = summarizeSamples(this.frameIntervalsMs);
    const gpuSnapshot = this.gpu.snapshot();
    const gpuValues = gpuSnapshot.samplesMs.slice(0, this.minimumSamples);
    const gpuStats = summarizeSamples(gpuValues);
    const cpuVerified = this.cpuSamplesMs.length >= this.minimumSamples;
    const gpuVerified = gpuSnapshot.supported && gpuValues.length >= this.minimumSamples;
    const status = cpuVerified && gpuVerified ? 'VERIFIED' : 'UNVERIFIED';
    return {
      status,
      cpu: {
        sampleCount: Math.min(this.cpuSamplesMs.length, this.minimumSamples),
        medianMs: cpuStats.median,
        p95Ms: cpuStats.p95,
      },
      gpu: {
        supported: gpuSnapshot.supported,
        status: gpuSnapshot.supported && gpuVerified ? 'VERIFIED' : 'UNVERIFIED',
        sampleCount: gpuValues.length,
        medianMs: gpuStats.median,
        p95Ms: gpuStats.p95,
        disjointCount: gpuSnapshot.disjointCount,
        droppedCount: gpuSnapshot.droppedCount,
        pendingCount: gpuSnapshot.pendingCount,
      },
      fps: this.frameIntervalsMs.length >= this.minimumSamples && frameStats.median > 0
        ? 1000 / frameStats.median
        : null,
      fpsStatus: this.frameIntervalsMs.length >= this.minimumSamples ? 'VERIFIED' : 'UNVERIFIED',
      frameCadence: {
        status: this.frameIntervalsMs.length >= this.minimumSamples ? 'VERIFIED' : 'UNVERIFIED',
        sampleCount: Math.min(this.frameIntervalsMs.length, this.minimumSamples),
        medianMs: frameStats.median,
        p95Ms: frameStats.p95,
      },
      capabilities: {
        timerQuery: gpuSnapshot.supported,
        webgl2: typeof WebGL2RenderingContext !== 'undefined'
          ? this.gl instanceof WebGL2RenderingContext
          : Boolean(this.gl),
      },
      observation: {
        visibilityStates: [...this.visibilityStates].toSorted(),
        focusStates: [...this.focusStates].toSorted(),
        rejectedFrames: this.rejectedFrames,
      },
    };
  }

  dispose() {
    this.gpu.dispose();
  }
}

function lifecycleSnapshot(describeResources) {
  const snapshot = new Map();
  for (const descriptor of describeResources() ?? []) {
    if (typeof descriptor?.key !== 'string' || descriptor.resource == null) {
      throw new TypeError('Lifecycle resources require a string key and disposable resource');
    }
    if (snapshot.has(descriptor.key)) {
      throw new Error(`Duplicate lifecycle resource key: ${descriptor.key}`);
    }
    snapshot.set(descriptor.key, {
      key: descriptor.key,
      resource: descriptor.resource,
      signature: String(descriptor.signature ?? ''),
    });
  }
  return snapshot;
}

export class CloudLifecycleAuditor {
  constructor(describeResources) {
    if (typeof describeResources !== 'function') {
      throw new TypeError('CloudLifecycleAuditor requires a resource descriptor function');
    }
    this.describeResources = describeResources;
    this.pending = null;
    this.reports = [];
  }

  begin(reason) {
    if (this.pending != null) {
      throw new Error(`Lifecycle transition already pending: ${this.pending.reason}`);
    }
    const before = lifecycleSnapshot(this.describeResources);
    const observations = new Map();
    for (const { resource } of before.values()) {
      if (observations.has(resource) || typeof resource.dispose !== 'function') continue;
      const original = resource.dispose;
      const observation = { original, wrapper: null, disposeCount: 0 };
      observation.wrapper = function observedDispose(...args) {
        observation.disposeCount += 1;
        return original.apply(this, args);
      };
      resource.dispose = observation.wrapper;
      observations.set(resource, observation);
    }
    this.pending = {
      reason,
      before,
      after: null,
      observations,
      resetReason: null,
    };
  }

  markReset(reason) {
    if (this.pending == null) return;
    this.pending.resetReason = reason;
  }

  completeMutation() {
    if (this.pending == null) throw new Error('No lifecycle transition is pending');
    this.pending.after = lifecycleSnapshot(this.describeResources);
  }

  abortMutation(abortReason = 'aborted') {
    const transition = this.pending;
    if (transition == null) return null;
    this._restoreObservers(transition);
    this.pending = null;
    const report = {
      reason: transition.reason,
      resetReason: transition.resetReason,
      state: 'ABORTED',
      abortReason,
      resetBeforeRender: false,
      reconstructionCompleted: false,
    };
    this.reports.push(report);
    return report;
  }

  _restoreObservers(transition) {
    for (const [resource, observation] of transition.observations) {
      if (resource.dispose === observation.wrapper) resource.dispose = observation.original;
    }
  }

  beforeRender() {
    const transition = this.pending;
    if (transition == null) return null;
    if (transition.resetReason == null) {
      this._restoreObservers(transition);
      this.pending = null;
      throw new Error(`${transition.reason} transition rendered before history reset`);
    }
    if (transition.after == null) {
      this._restoreObservers(transition);
      this.pending = null;
      throw new Error(`${transition.reason} transition rendered before reconstruction completed`);
    }

    const changedKeys = [];
    const unchangedKeys = [];
    const releasedKeys = [];
    const createdKeys = [];
    const recreatedKeys = [];
    const allKeys = [...new Set([...transition.before.keys(), ...transition.after.keys()])].toSorted();
    try {
      for (const key of allKeys) {
        const before = transition.before.get(key);
        const after = transition.after.get(key);
        const observation = before == null ? null : transition.observations.get(before.resource);
        const disposeCount = observation?.disposeCount ?? 0;
        if (before == null) {
          createdKeys.push(key);
          continue;
        }
        if (after == null) {
          if (disposeCount !== 1) {
            throw new Error(`${key} superseded by ${transition.reason} disposed ${disposeCount} times`);
          }
          releasedKeys.push(key);
          continue;
        }
        if (before.resource === after.resource) {
          if (before.signature === after.signature) {
            if (disposeCount !== 0) {
              throw new Error(`${key} unchanged by ${transition.reason} but disposed ${disposeCount} times`);
            }
            unchangedKeys.push(key);
          } else {
            if (disposeCount !== 1) {
              throw new Error(`${key} resized by ${transition.reason} disposed ${disposeCount} times`);
            }
            changedKeys.push(key);
          }
          continue;
        }
        if (transition.reason !== 'context-restore' && before.signature === after.signature) {
          throw new Error(`${key} was recreated by ${transition.reason} despite an unchanged signature`);
        }
        if (disposeCount !== 1) {
          throw new Error(`${key} recreated by ${transition.reason} disposed ${disposeCount} times`);
        }
        recreatedKeys.push(key);
      }
    } finally {
      this._restoreObservers(transition);
    }
    const report = {
      reason: transition.reason,
      resetReason: transition.resetReason,
      resetBeforeRender: true,
      changedKeys,
      unchangedKeys,
      releasedKeys,
      createdKeys,
      recreatedKeys,
    };
    this.reports.push(report);
    this.pending = null;
    return report;
  }

  dispose() {
    if (this.pending != null) this._restoreObservers(this.pending);
    this.pending = null;
  }
}

function srgbChannelToLinear(value) {
  const encoded = value / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function averageLinearLuminance(pixels) {
  if (!(pixels instanceof Uint8Array) || pixels.length === 0 || pixels.length % 4 !== 0) {
    return null;
  }
  let total = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    total += 0.2126 * srgbChannelToLinear(pixels[index])
      + 0.7152 * srgbChannelToLinear(pixels[index + 1])
      + 0.0722 * srgbChannelToLinear(pixels[index + 2]);
  }
  return total / (pixels.length / 4);
}

export function computeObjectiveContrast({ targetPixels, backgroundPixels }) {
  const targetLuminance = averageLinearLuminance(targetPixels);
  const backgroundLuminance = averageLinearLuminance(backgroundPixels);
  return {
    colorSpace: 'linear-srgb-from-final-rgba8',
    targetLuminance,
    backgroundLuminance,
    contrast: targetLuminance == null || backgroundLuminance == null
      ? null
      : Math.abs(targetLuminance - backgroundLuminance),
  };
}

function dilateMask(mask, width, height, radius) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let occupied = false;
      for (let offsetY = -radius; offsetY <= radius && !occupied; offsetY += 1) {
        const sampleY = y + offsetY;
        if (sampleY < 0 || sampleY >= height) continue;
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = x + offsetX;
          if (sampleX < 0 || sampleX >= width) continue;
          if (mask[sampleY * width + sampleX] > 0) {
            occupied = true;
            break;
          }
        }
      }
      output[y * width + x] = occupied ? 1 : 0;
    }
  }
  return output;
}

export function deriveCloudMask(composited, noCloud, threshold = 4) {
  if (composited.length !== noCloud.length || composited.length % 4 !== 0) {
    throw new RangeError('Cloud-mask frames must have matching RGBA8 dimensions');
  }
  const mask = new Uint8Array(composited.length / 4);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    const difference = Math.max(
      Math.abs(composited[offset] - noCloud[offset]),
      Math.abs(composited[offset + 1] - noCloud[offset + 1]),
      Math.abs(composited[offset + 2] - noCloud[offset + 2]),
    );
    mask[pixel] = difference >= threshold ? 1 : 0;
  }
  return mask;
}

export function flipPixelRows(values, width, height, channels = 1) {
  if (values.length !== width * height * channels) {
    throw new RangeError('Pixel row dimensions do not match the supplied buffer');
  }
  const output = new values.constructor(values.length);
  const rowLength = width * channels;
  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    const sourceOffset = sourceY * rowLength;
    const destinationOffset = (height - sourceY - 1) * rowLength;
    output.set(values.subarray(sourceOffset, sourceOffset + rowLength), destinationOffset);
  }
  return output;
}

export function computeTemporalTrail({
  historyFrames,
  referenceFrames,
  cloudMasks,
  width,
  height,
  dilationRadius = 2,
}) {
  if (historyFrames.length < 2 || referenceFrames.length < 2 || cloudMasks.length < 2) {
    return { status: 'UNVERIFIED', reason: 'two-resolved-frames-required', frames: [], heatmaps: [] };
  }
  const pixelCount = width * height;
  const frames = [];
  const heatmaps = [];
  for (let frame = 0; frame < 2; frame += 1) {
    const history = historyFrames[frame];
    const reference = referenceFrames[frame];
    const mask = dilateMask(cloudMasks[frame], width, height, dilationRadius);
    if (history.length !== pixelCount * 4 || reference.length !== pixelCount * 4
      || mask.length !== pixelCount) {
      return { status: 'UNVERIFIED', reason: 'frame-dimensions-mismatch', frames: [], heatmaps: [] };
    }
    const heatmap = new Uint8Array(pixelCount);
    let residualTotal = 0;
    let outsidePixelCount = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (mask[pixel]) continue;
      const offset = pixel * 4;
      const residual = Math.round((
        Math.abs(history[offset] - reference[offset])
        + Math.abs(history[offset + 1] - reference[offset + 1])
        + Math.abs(history[offset + 2] - reference[offset + 2])
      ) / 3);
      heatmap[pixel] = residual;
      residualTotal += residual;
      outsidePixelCount += 1;
    }
    frames.push({
      resolvedFrame: frame + 1,
      outsidePixelCount,
      residualRatio: outsidePixelCount === 0 ? null : residualTotal / (outsidePixelCount * 255),
    });
    heatmaps.push(heatmap);
  }
  if (frames.some(frame => frame.outsidePixelCount === 0)) {
    return { status: 'UNVERIFIED', reason: 'no-outside-cloud-pixels', frames, heatmaps };
  }
  return { status: 'VERIFIED', reason: null, frames, heatmaps };
}

export function summarizePayloadManifest(manifest, entryNames = []) {
  if (manifest == null || typeof manifest !== 'object') {
    return { status: 'UNVERIFIED', compressedBytes: null, uncompressedBytes: null, files: [] };
  }
  const wanted = new Set(entryNames);
  const visited = new Set();
  const files = [];
  const visit = key => {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (entry == null) return;
    visited.add(key);
    files.push(entry.file);
    for (const imported of entry.imports ?? []) visit(imported);
    for (const asset of entry.assets ?? []) files.push(asset);
  };
  for (const [key, entry] of Object.entries(manifest)) {
    if (wanted.size === 0 || wanted.has(key) || wanted.has(entry.name) || wanted.has(entry.src)) visit(key);
  }
  return { status: 'PENDING_FILE_SIZES', compressedBytes: null, uncompressedBytes: null,
    files: [...new Set(files)].toSorted() };
}

export async function measurePayloadManifest(
  manifest,
  entryNames,
  readAsset,
  compressAsset,
) {
  const summary = summarizePayloadManifest(manifest, entryNames);
  if (summary.status === 'UNVERIFIED') return summary;
  let uncompressedBytes = 0;
  let compressedBytes = 0;
  for (const file of summary.files) {
    const bytes = await readAsset(file);
    const compressed = await compressAsset(bytes);
    uncompressedBytes += bytes.byteLength;
    compressedBytes += compressed.byteLength;
  }
  return { status: 'MEASURED', compressedBytes, uncompressedBytes, files: summary.files };
}

export function createCloudComparisonResult({
  backend,
  versions = {},
  scenario,
  viewport,
  quality,
  benchmark,
  resources,
  payload = { status: 'UNVERIFIED', compressedBytes: null, uncompressedBytes: null, files: [] },
  objective = { status: 'UNVERIFIED' },
  temporal = { status: 'UNVERIFIED' },
  consoleIssues = [],
  artifacts = [],
}) {
  return {
    version: 'cloud-comparison-v1',
    backend,
    versions,
    scenario,
    viewport,
    quality,
    measurementStatus: benchmark.status,
    measurements: {
      cpu: { status: benchmark.status, ...benchmark.cpu },
      gpu: {
        status: benchmark.gpu.status
          ?? (benchmark.gpu.supported && benchmark.gpu.sampleCount >= DEFAULT_MINIMUM_SAMPLES
            ? 'VERIFIED'
            : 'UNVERIFIED'),
        ...benchmark.gpu,
      },
      fps: benchmark.fps,
      fpsStatus: benchmark.fpsStatus,
      frameCadence: benchmark.frameCadence,
      capabilities: benchmark.capabilities,
      observation: benchmark.observation,
    },
    resources,
    payload,
    objective,
    temporal,
    consoleIssues: [...consoleIssues],
    artifacts: [...artifacts],
  };
}
