/**
 * Physical parameters for the Hillaire 2020 sky model, and the one number that
 * ties the whole renderer's radiance scale together.
 *
 * Everything here is in kilometres and per-kilometre coefficients, which is the
 * unit system the published Rayleigh/Mie/ozone figures are quoted in. World
 * space is metres above sea level (the valley floors sit at ~2.7 km and are
 * genuinely 2.7 km above sea level in this world), so the only conversion
 * needed anywhere is a multiply by 0.001 -- there is deliberately no separate
 * "world origin altitude" offset to get wrong.
 */

export const ATM = {
  // Earth. The 100 km atmosphere shell is the usual cutoff: above it the
  // density is below the precision of a half-float LUT anyway.
  groundRadiusKm: 6360.0,
  topRadiusKm: 6460.0,

  rayleighScaleHeightKm: 8.0,
  mieScaleHeightKm: 1.2,

  // Rayleigh scattering at sea level, sRGB primaries, per km.
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],

  // Mie. Scattering and absorption are separate because the absorbing fraction
  // is what stops the horizon glow from going unphysically bright.
  mieScattering: 3.996e-3,
  mieAbsorption: 4.4e-3,

  // Ozone. This is the term that is usually dropped and it is exactly the term
  // that makes the zenith read deep blue instead of washed cyan: it removes the
  // green/yellow band from a long slant path without touching the blue.
  // Modelled as a tent centred at 25 km, half-width 15 km.
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCenterKm: 25.0,
  ozoneHalfWidthKm: 15.0,

  // Cornette-Shanks asymmetry. 0.76 is the aerosol value that reproduces the
  // measured forward-scattering aureole around the sun; Henyey-Greenstein at
  // the same g is visually indistinguishable here and costs the same, so the
  // choice was made on which one has the published fit.
  miePhaseG: 0.76,

  // Planet-average ground albedo, used only by the multiple-scattering LUT to
  // account for light that bounces off the surface and scatters again. This is
  // a *planetary* average (0.3 is Hillaire's value for Earth); the local
  // Himalayan snowfield albedo used for ambient bounce is a separate, much
  // higher number -- see LOCAL below.
  groundAlbedo: 0.35,

  // Angular radius of the solar disc, radians (0.2665 degrees).
  sunAngularRadius: 4.6542e-3,

  // Art-directed sun-disc radiance under the contract below. The physical value
  // is irradiance / solid angle, about 46000 -- which survives a half-float
  // framebuffer but not a bloom pyramid multiplied on top of it, and buys
  // nothing visible because everything above ~50 clips to white anyway. 2200
  // keeps the disc ~2400x brighter than sunlit snow, which is more than enough
  // separation for the bloom and flare to key off.
  sunDiscRadiance: 2200.0,

  // Local environment model for atm_skyIrradiance. A surface in this world is
  // never alone under an empty sky: it sits inside a bowl of high-albedo snow
  // and rock, and the bounce off that bowl is most of the light a shadowed
  // slope receives. Ignoring it is what makes procedural snow shadows read as
  // dead grey holes.
  terrainAlbedo: [0.6, 0.62, 0.66],
  // Cosine-weighted fraction of the hemisphere occupied by terrain for an
  // up-facing normal. Mountains, not a plain, hence 0.22 rather than ~0.05.
  terrainViewFactorUp: 0.22,
  // Fraction of that surrounding terrain that is itself in sunlight. Below 1.0
  // because the same ridges that fill the hemisphere also shade each other.
  terrainSunlitFraction: 0.85,

  // LUT sizes.
  transmittanceSize: [256, 64],
  multiScatterSize: [32, 32],
  skyViewSize: [192, 108],
  // Aerial-perspective froxels, stored as a 2D atlas of depth slices rather
  // than a Data3DTexture. A 3D render target has to be filled one layer at a
  // time -- 32 render-target binds and 32 draws every frame -- and this
  // renderer already documents (CloudVolume) that a render-pass switch costs a
  // full framebuffer store/load on tile-based GPUs. The atlas fills in one
  // draw, samples in two texture fetches, and needs no GLSL ES 3.00 sampler3D,
  // which matters because postprocessing Effect shaders are authored as GLSL 1.
  aerialSlices: 32,
  aerialTile: 32,
  aerialTilesX: 8,
  aerialTilesY: 4,
  aerialMaxKm: 80.0,
  aerialSteps: 20,
  // Sky irradiance for ambient lighting: 64 altitudes x 2 reference normals
  // (up-facing, horizontal).
  irradianceSize: [64, 2],
};

export const ATM_AERIAL_ATLAS = [ATM.aerialTile * ATM.aerialTilesX, ATM.aerialTile * ATM.aerialTilesY];

/** Density of the triangular ozone layer at an altitude in kilometres. */
export function ozoneDensity(altKm) {
  return Math.max(0, 1 - Math.abs(altKm - ATM.ozoneCenterKm) / ATM.ozoneHalfWidthKm);
}

/** Dimensionless density profiles used by both the CPU validator and LUT shaders. */
export function mediumAtAltitude(altKm) {
  const h = Math.max(altKm, 0);
  return {
    rayleighDensity: Math.exp(-h / ATM.rayleighScaleHeightKm),
    mieDensity: Math.exp(-h / ATM.mieScaleHeightKm),
    ozoneDensity: ozoneDensity(h),
  };
}

/** Distance in kilometres to the top atmosphere shell along a ray. */
export function distanceToAtmosphereBoundary(radiusKm, radialCosine) {
  const disc = radiusKm * radiusKm * (radialCosine * radialCosine - 1) + ATM.topRadiusKm ** 2;
  return -radiusKm * radialCosine + Math.sqrt(Math.max(disc, 0));
}

/** Distance in kilometres to the ground, or Infinity when the ray misses it. */
export function distanceToGroundBoundary(radiusKm, radialCosine) {
  const disc = radiusKm * radiusKm * (radialCosine * radialCosine - 1) + ATM.groundRadiusKm ** 2;
  if (radialCosine >= 0 || disc < 0) return Infinity;
  return -radiusKm * radialCosine - Math.sqrt(disc);
}

/**
 * Optical depth from an altitude to the top of the atmosphere along a ray,
 * evaluated on the CPU with the same medium model the LUT shader uses.
 *
 * This exists so the radiance normalisation below is derived from the model
 * rather than hand-tuned against it. If a scattering coefficient changes, the
 * contract "sunlit white surface at 4.5 km == 1.0" stays true with no edit.
 */
function opticalDepthToSpace(altKm, cosZenith, steps = 512) {
  const Rg = ATM.groundRadiusKm;
  const Rt = ATM.topRadiusKm;
  const r = Rg + altKm;
  const mu = cosZenith;
  // Distance to the top shell along (r, mu).
  const disc = r * r * (mu * mu - 1) + Rt * Rt;
  const dist = -r * mu + Math.sqrt(Math.max(disc, 0));
  const od = [0, 0, 0];
  const dt = dist / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    // Law of cosines in the plane of the ray.
    const h = Math.sqrt(r * r + t * t + 2 * r * t * mu) - Rg;
    const medium = mediumAtAltitude(h);
    const dR = medium.rayleighDensity;
    const dM = medium.mieDensity;
    const dO = medium.ozoneDensity;
    const mieExt = (ATM.mieScattering + ATM.mieAbsorption) * dM;
    for (let c = 0; c < 3; c++) {
      od[c] += (ATM.rayleighScattering[c] * dR + mieExt + ATM.ozoneAbsorption[c] * dO) * dt;
    }
  }
  return od;
}

/** Sun transmittance at a world altitude (metres) for a sun elevation sine. */
export function sunTransmittance(worldY, sunUpCosine) {
  const od = opticalDepthToSpace(Math.max(worldY, 0) * 0.001, sunUpCosine);
  return [Math.exp(-od[0]), Math.exp(-od[1]), Math.exp(-od[2])];
}

export const REC709_LUMA = [0.2126, 0.7152, 0.0722];

export function luminance(rgb) {
  return rgb[0] * REC709_LUMA[0] + rgb[1] * REC709_LUMA[1] + rgb[2] * REC709_LUMA[2];
}

/**
 * Top-of-atmosphere solar irradiance in the renderer's radiance units.
 *
 * THE RADIANCE CONTRACT: 1.0 is the radiance of an ideal Lambertian white
 * surface (albedo 1.0) facing the sun at 4.5 km altitude. That surface emits
 * E_perp / PI, so the scale is fixed by requiring luminance(E_toa * T / PI) == 1
 * at 4.5 km. Everything else in the renderer -- snow at ~0.9, rock at ~0.05,
 * zenith sky at ~0.02, the exposure constant in the post stack -- hangs off
 * this one number, so it is computed, not typed.
 */
/**
 * Memoised because this is a 512-step CPU ray march (opticalDepthToSpace) and
 * the atmosphere LUT called it once per frame for the whole session. It depends
 * only on the sun's height, which changes once per sortie — so it was
 * recomputing a constant sixty times a second on the main thread.
 *
 * A one-entry cache is enough: the argument is the same value every frame until
 * the sun moves, and then it is the same new value every frame after that.
 */
let _toaCacheKey = NaN;
let _toaCacheValue = 0;

export function sunToaIrradiance(sunUpCosine) {
  if (sunUpCosine === _toaCacheKey) return _toaCacheValue;
  const t = sunTransmittance(4500, sunUpCosine);
  _toaCacheKey = sunUpCosine;
  _toaCacheValue = Math.PI / Math.max(luminance(t), 1e-4);
  return _toaCacheValue;
}
