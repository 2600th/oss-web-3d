// Weapon data. One table; everything combat does with a weapon reads from here.
// Distances in metres, speeds m/s, times seconds, angles degrees.

const D = Math.PI / 180;

export const WEAPONS = {
  // ---- player gun -------------------------------------------------------
  gun: {
    id: 'gun', name: 'GSh-23L', type: 'gun',
    ammo: 900, rate: 30, // rounds per second (the real twin-barrel does ~55)
    muzzle: 1050, life: 1.9, range: 1900, spread: 0.0035,
    damage: 9, assistCone: 3.2 * D, // bullets bend toward the lead point inside this
  },

  // ---- player missiles --------------------------------------------------
  /** Standard short-range IR missile. Plenty of them; honest, dodgeable. */
  msl: {
    id: 'msl', name: 'R-60M', short: 'MSL', type: 'missile', guidance: 'ir',
    ammo: 72, rails: 2, reload: 2.4,
    lockRange: 4800, lockCone: 17 * D, lockTime: 1.1, groundLock: true,
    seekerCone: 48 * D, nav: 4, maxG: 30,
    launchBoost: 40, accel: 320, maxSpeed: 980, burn: 2.6, coastDrag: 0.085, life: 11,
    fuse: 13, blast: 26, damage: 62, flareChance: 0.4,
  },
  /** High-off-boresight dogfight missile: look at it, lock it, snap-turn onto it. */
  hobs: {
    id: 'hobs', name: 'R-73 ARCHER', short: 'HOBS', type: 'missile', guidance: 'ir', special: true,
    ammo: 18, rails: 2, reload: 3.6,
    lockRange: 3400, lockCone: 56 * D, lockTime: 0.45, groundLock: false,
    seekerCone: 80 * D, nav: 5, maxG: 48,
    launchBoost: 30, accel: 380, maxSpeed: 900, burn: 2.2, coastDrag: 0.11, life: 8,
    fuse: 14, blast: 24, damage: 72, flareChance: 0.15,
    description: 'Dogfight missile. Locks almost anything in front of the wing line.',
  },
  /** Long-range radar missile: reach out before the merge. Flares do nothing. */
  lraam: {
    id: 'lraam', name: 'R-27R ALAMO', short: 'LRAAM', type: 'missile', guidance: 'radar', special: true,
    ammo: 12, rails: 2, reload: 5.5,
    lockRange: 12500, lockCone: 11 * D, lockTime: 1.7, groundLock: false,
    seekerCone: 40 * D, nav: 4, maxG: 22,
    launchBoost: 40, accel: 300, maxSpeed: 1350, burn: 5.5, coastDrag: 0.05, life: 22,
    fuse: 16, blast: 30, damage: 115, flareChance: 0,
    description: 'Long-range missile. Narrow lock, heavy warhead, sluggish in a knife fight.',
  },
  /** S-8 rocket pods: ripple salvo, unguided, for soft ridge positions. */
  rkt: {
    id: 'rkt', name: 'S-8 ROCKETS', short: 'RKT', type: 'rocket', special: true,
    ammo: 120, rails: 1, reload: 0.9, salvo: 6, salvoInterval: 0.07,
    launchBoost: 60, accel: 520, maxSpeed: 760, burn: 0.9, coastDrag: 0.06, life: 7, spread: 0.008,
    fuse: 6, blast: 24, damage: 55, gravity: 0.5,
    description: 'Unguided rockets, six to a pull. Walk them along a ridge line.',
  },
  /** FAB-250: one pass, one crater. CCIP pipper in hud.weapon.ccip. */
  bomb: {
    id: 'bomb', name: 'FAB-250', short: 'BOMB', type: 'bomb', special: true,
    ammo: 16, rails: 2, reload: 1.6,
    life: 40, drag: 0.012, fuse: 0, blast: 85, damage: 340, gravity: 1,
    description: 'General-purpose bombs. Huge blast; put the pipper on the bunker.',
  },

  // ---- hostile weapons --------------------------------------------------
  e_aam: {
    id: 'e_aam', name: 'hostile AAM', type: 'missile', guidance: 'ir',
    seekerCone: 42 * D, nav: 3.5, maxG: 15,
    launchBoost: 30, accel: 250, maxSpeed: 820, burn: 2.6, coastDrag: 0.1, life: 10,
    fuse: 11, blast: 18, damage: 30, flareChance: 0.52,
  },
  e_aam_ace: {
    id: 'e_aam_ace', name: 'hostile AAM', type: 'missile', guidance: 'ir',
    seekerCone: 55 * D, nav: 4, maxG: 20,
    launchBoost: 30, accel: 300, maxSpeed: 880, burn: 2.8, coastDrag: 0.1, life: 10,
    fuse: 12, blast: 18, damage: 34, flareChance: 0.36,
  },
  e_manpads: {
    id: 'e_manpads', name: 'shoulder SAM', type: 'missile', guidance: 'ir', kind: 'sam',
    seekerCone: 38 * D, nav: 3.5, maxG: 16,
    launchBoost: 30, accel: 230, maxSpeed: 600, burn: 3.0, coastDrag: 0.12, life: 9,
    fuse: 10, blast: 16, damage: 22, flareChance: 0.55,
  },
  /** Radar SAM: ignores flares, but needs its radar alive and line of sight. */
  e_sam: {
    id: 'e_sam', name: 'radar SAM', type: 'missile', guidance: 'radar', kind: 'sam',
    seekerCone: 60 * D, nav: 3.5, maxG: 9.5,
    launchBoost: 20, accel: 260, maxSpeed: 1050, burn: 4.5, coastDrag: 0.06, life: 16,
    fuse: 18, blast: 36, damage: 28, flareChance: 0,
  },
  e_gun: { id: 'e_gun', name: 'hostile gun', type: 'gun', muzzle: 900, life: 1.6, damage: 3.5, spread: 0.012, rate: 14 },
  e_aaa: { id: 'e_aaa', name: 'AAA', type: 'gun', muzzle: 960, life: 3.0, damage: 2, spread: 0.012, rate: 12 },
};

export const SPECIALS = ['hobs', 'lraam', 'rkt', 'bomb'];

/** Damage multipliers by weapon type against an armour class. */
export const ARMOR = {
  air:    { gun: 1, missile: 1, rocket: 1.2, bomb: 2, flak: 1 },
  soft:   { gun: 1.6, missile: 1.6, rocket: 1.4, bomb: 2, flak: 1 },   // tents, trucks, crews, dumps
  medium: { gun: 0.6, missile: 1, rocket: 1, bomb: 1.5, flak: 1 },     // guns, launchers, radar
  hard:   { gun: 0.12, missile: 0.7, rocket: 0.9, bomb: 1.4, flak: 1 }, // bunkers, sangars
};

export const PLAYER = {
  health: 100,
  radius: 9,
  flares: 36,
  flareCooldown: 1.3,
  flaresPerRelease: 2,
};

export function damageAgainst(weapon, armorClass, base = weapon.damage) {
  const row = ARMOR[armorClass] ?? ARMOR.air;
  return base * (row[weapon.type] ?? 1);
}
