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
