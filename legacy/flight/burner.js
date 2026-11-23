import * as THREE from 'three';

/**
 * Burner state from smoothed throttle.
 *
 * Its own module because two systems draw the same jet and must agree on when
 * it lights: the bounded plume frusta in Aircraft.js, and the turbulent
 * particle envelope FlightFx hangs off the same nozzle. Aircraft.js is not the
 * home for it — it imports GLTFLoader and the meshopt decoder, which is a heavy
 * thing to drag into the effects graph for two clamps.
 *
 * Dry heat starts at about half throttle, which is what makes lighting the
 * burner feel like an event rather than a slider.
 *
 * Reheat shares its threshold with the flight model (REHEAT_THRESHOLD). The two
 * used to differ — 0.84 here against 0.86 there, and on different signals — so
 * the flame and the thrust did not agree about when the burner was lit.
 */
export const REHEAT_THRESHOLD = 0.86;
export const burnerHeat = (throttleSmoothed) =>
  THREE.MathUtils.clamp((throttleSmoothed - 0.35) / 0.65, 0, 1);

export const burnerReheat = (throttleSmoothed) =>
  THREE.MathUtils.clamp((throttleSmoothed - REHEAT_THRESHOLD) / (1 - REHEAT_THRESHOLD), 0, 1);
