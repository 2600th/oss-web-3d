/**
 * Measured effect anchors of the MiG-21 airframe (model space, metres, nose
 * -Z, up +Y, right +X; mig21.glb after the game's normalisation, 15.76 m
 * long; mig21_hostile is the same mesh). Pure data, no three.js: combat reads
 * the gun muzzle from here too, so the rounds and the muzzle flash leave the
 * same point.
 *
 * GUN_MUZZLE: the GSh-23L's twin barrels poke out of the front of the ventral
 * gun gondola (`ventral_fairing` in the GLB): a constant 13 x 5 cm section,
 * x +-0.065, y -1.335..-1.286, whose front face is at z = -2.612
 * (tools/vfx/probe-gun.mjs). The old anchor (0, -0.6, -2.5) was inside the
 * fuselage, 0.7 m above the barrels; combat fired from 7 m ahead of the
 * centre, at the nose cone.
 */
export const GUN_MUZZLE = Object.freeze({ x: 0, y: -1.31, z: -2.64 });

/**
 * AAM_RAIL: centre of the right-hand wing missile as it hangs on its launch
 * rail (mirror x for the left one). Measured from the `stores` mesh of
 * mig21.glb: the R-60 body is a 0.26 m fin cross-section centred at
 * x +-2.11, y -1.25, nose at z -2.025; the flying aam_ir.glb is 2.08 m long
 * with its origin at mid-body, so mid-body sits 1.04 m behind the nose. The
 * old launch point (x 2.3, 1 m below and 1.5 m ahead of the centre) was
 * 0.25 m high and 2.5 m ahead of the rail; hostiles fired from the nose.
 */
export const AAM_RAIL = Object.freeze({ x: 2.11, y: -1.25, z: -0.985 });
