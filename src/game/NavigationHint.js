export const NAV_PHASE = Object.freeze({
  TRANSIT: 'transit',
  SEARCH: 'search',
  ACQUISITION: 'acquisition',
  COMPLETE: 'complete',
});

/** Shortest signed turn from heading to target, with a deterministic right tie. */
export function signedBearingDelta(headingDeg, targetBearingDeg) {
  const delta = ((targetBearingDeg - headingDeg) % 360 + 360) % 360;
  return delta > 180 ? delta - 360 : delta;
}

export function navigationPhase(rangeMetres) {
  if (rangeMetres == null || Number.isNaN(rangeMetres)) return NAV_PHASE.COMPLETE;
  if (rangeMetres > 8000) return NAV_PHASE.TRANSIT;
  if (rangeMetres > 3000) return NAV_PHASE.SEARCH;
  return NAV_PHASE.ACQUISITION;
}

export function rangeTrend(closingSpeed, previousTrend, deadband = 2) {
  if (closingSpeed > deadband) return 'CLOSING';
  if (closingSpeed < -deadband) return 'OPENING';
  return previousTrend ?? null;
}

export function altitudeCue(deltaMetres) {
  if (deltaMetres > 0) return 'ABOVE';
  if (deltaMetres < 0) return 'BELOW';
  return 'LEVEL';
}

function point2(point) {
  return point ? { x: point.x, y: point.y } : null;
}

function completeSnapshot() {
  return {
    targetId: null,
    phase: NAV_PHASE.COMPLETE,
    bearingDelta: null,
    trend: null,
    altitude: null,
    projected: null,
    edgeNdc: null,
    masked: false,
    label: null,
    reconPresentation: 'hidden',
  };
}

export class NavigationHintTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this._targetId = null;
    this._trend = null;
    this._lastValidEdge = null;
    this._reconAcquisitionTime = 0;
  }

  update(input = {}) {
    const targetId = input.targetId ?? null;
    const phase = input.complete || targetId == null
      ? NAV_PHASE.COMPLETE
      : navigationPhase(input.rangeMetres);
    if (phase === NAV_PHASE.COMPLETE) {
      this.reset();
      return completeSnapshot();
    }

    if (targetId !== this._targetId) {
      this.reset();
      this._targetId = targetId;
    }

    this._trend = rangeTrend(input.closingSpeed ?? 0, this._trend);

    const masked = phase === NAV_PHASE.ACQUISITION && (input.terrainVisibility ?? 1) <= 0;
    if (!masked && input.edgeNdc) this._lastValidEdge = point2(input.edgeNdc);

    let reconPresentation = 'normal';
    if (!input.reconActive) {
      this._reconAcquisitionTime = 0;
    } else if (phase !== NAV_PHASE.ACQUISITION) {
      this._reconAcquisitionTime = 0;
      reconPresentation = 'hidden';
    } else if (input.reconFramed || input.framed) {
      reconPresentation = 'hidden';
    } else {
      this._reconAcquisitionTime += Math.max(0, input.dt ?? 0);
      reconPresentation = this._reconAcquisitionTime < 0.65 ? 'dimmed' : 'hidden';
    }

    return {
      targetId,
      phase,
      bearingDelta: signedBearingDelta(input.headingDeg ?? 0, input.targetBearingDeg ?? 0),
      trend: this._trend,
      altitude: altitudeCue(input.altitudeDeltaMetres ?? 0),
      projected: masked ? null : point2(input.projected),
      edgeNdc: masked ? point2(this._lastValidEdge) : point2(input.edgeNdc),
      masked,
      label: masked ? 'RIDGE MASKED' : null,
      reconPresentation,
    };
  }
}
