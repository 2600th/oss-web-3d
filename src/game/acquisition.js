/**
 * What the pilot is told about a position they have not yet seen.
 *
 * The briefing says the positions are unconfirmed and asks the pilot to
 * *locate* them — and then the HUD printed an exact bearing and slant range to
 * every one of them from the first frame. The mission was not "locate", it was
 * "fly to this waypoint", and the search never happened.
 *
 * That matters because of what it wasted. The observation posts are built for
 * long-range legibility: pitched roofs to carry a silhouette no mountain makes,
 * fuel drums at even 2.15 m centres so they read as rhythm when only a few
 * pixels tall, rust and weathered canvas as the only warm pixels within a
 * kilometre of white. All of that exists to be found, and an exact range and
 * bearing guarantees it never has to be.
 *
 * So until a position has actually been seen, the pilot gets a sector and a
 * range band — enough to fly a search, not enough to skip one. After that the
 * precise solution is theirs, because having found it once, re-finding it is
 * busywork rather than gameplay.
 */

/**
 * Score at which a position counts as visually acquired.
 *
 * Deliberately far below CAPTURE_THRESHOLD: this is "the pilot has it in
 * frame and unobstructed", not "the pilot has a usable photograph".
 */
export const ACQUISITION_SCORE = 0.18;

const SECTORS = [
  'NORTH', 'NORTH-EAST', 'EAST', 'SOUTH-EAST',
  'SOUTH', 'SOUTH-WEST', 'WEST', 'NORTH-WEST',
];

/** The eight-point sector a bearing falls in. */
export function bearingSector(bearingDeg) {
  if (!Number.isFinite(bearingDeg)) return null;
  const normalised = ((bearingDeg % 360) + 360) % 360;
  return SECTORS[Math.round(normalised / 45) % 8];
}

/**
 * A range band, in kilometres.
 *
 * Bands widen with distance because the useful precision does too: five
 * kilometres of uncertainty at forty kilometres out is a heading, while the
 * same five at four kilometres out is the difference between finding a camp and
 * flying past it.
 */
export function rangeBand(metres) {
  if (!Number.isFinite(metres) || metres < 0) return null;
  const km = metres / 1000;
  if (km < 2) return 'UNDER 2 KM';
  const step = km < 10 ? 2 : km < 30 ? 5 : 10;
  const lo = Math.floor(km / step) * step;
  return `${lo}-${lo + step} KM`;
}

/**
 * The navigation line for a target, precise once acquired and approximate
 * before that.
 */
export function targetCue({ acquired, bearingDeg, rangeMetres }) {
  if (acquired) {
    return {
      precise: true,
      bearing: `BRG ${String(Math.round(((bearingDeg % 360) + 360) % 360)).padStart(3, '0')}°`,
      range: rangeMetres >= 1000
        ? `${(rangeMetres / 1000).toFixed(1)} KM`
        : `${Math.round(rangeMetres)} M`,
    };
  }
  return {
    precise: false,
    bearing: bearingSector(bearingDeg) ?? 'SECTOR UNKNOWN',
    range: rangeBand(rangeMetres) ?? 'RANGE UNKNOWN',
  };
}
