// The radio cast, the ace squadron, and the event-driven chatter tables.
// Everything here is fictional: callsigns, people and units are invented.
// Hostile forces are never named beyond "hostile" / "bandit" and the aces'
// own flight callsign.

export const CAST = {
  player:  { callsign: 'VAJRA 1',  role: 'You. MiG-21 Bison, flight lead.', voice: 'pilot' },
  wing:    { callsign: 'VAJRA 2',  role: 'Your wingman, holding high cover.', voice: 'pilot2' },
  control: { callsign: 'SHIKHAR',  role: 'Ground-controlled intercept, sector control.', voice: 'control' },
  fac:     { callsign: 'ANVIL 6',  role: 'Forward air controller with the infantry.', voice: 'ground' },
  tower:   { callsign: 'HOME PLATE', role: 'Base operations.', voice: 'tower' },
  ace:     { callsign: 'IRBIS',    role: 'Hostile ace flight.', voice: 'hostile' },
};

/**
 * IRBIS flight — four hostile aces. Each flies differently on purpose:
 *   Cairn    turn fighter: lives in the phone booth, deadly guns
 *   Verglas  cannot be pinned: flares, jinks, drags you for his leader
 *   Scree    boom and zoom: fast pass, extend, come back from above
 *   Monsoon  the leader: patient, vertical, shoots the moment you are in parameters
 */
export const ACES = {
  cairn: {
    id: 'cairn', callsign: 'IRBIS 2', name: 'Cairn', health: 190, score: 2000,
    skillOverrides: { aggression: 1, gunRange: 950, gunError: 0.007, minFight: 140, vertical: 0.2, mslCooldown: 9 },
    airframeOverrides: { turnRate: 0.6, maxG: 9, bleed: 2.5 },
    lines: {
      engage: ['Irbis Two. I have the lead ship. He is mine.', 'Close with him. Guns.'],
      fire: ['Irbis Two, firing.'],
      hit: ['He bites. Good.', 'A scratch. Come closer.'],
      down: ['Two is hit — I am out. Well flown.'],
      kill: ['Irbis Two. He is down. He flew well.'],
    },
  },
  verglas: {
    id: 'verglas', callsign: 'IRBIS 3', name: 'Verglas', health: 170, score: 2000,
    skillOverrides: { flareChance: 0.85, flares: 44, jink: 1.3, aggression: 0.7, lockTime: 1.6 },
    airframeOverrides: { roll: 5.6, turnRate: 0.55 },
    lines: {
      engage: ['Irbis Three, dragging. Follow me if you can.'],
      fire: ['Three, missile away.'],
      hit: ['Tch. He has patience.'],
      down: ['Three is finished. Tell the others he is good.'],
      kill: ['Three. Target destroyed. No pleasure in it.'],
    },
  },
  scree: {
    id: 'scree', callsign: 'IRBIS 4', name: 'Scree', health: 180, score: 2000,
    skillOverrides: { aggression: 0.4, extendTime: 6.5, mslRange: 4300, mslCone: 20 * Math.PI / 180, vertical: 0.8 },
    airframeOverrides: { maxSpeed: 500, accel: 40, turnRate: 0.46 },
    lines: {
      engage: ['Irbis Four, coming down the mountain.'],
      fire: ['Four, shot.'],
      hit: ['He turns well. I will not turn with him.'],
      down: ['Four... the mountain has me. Good hunting, lead.'],
      kill: ['Four. Splash. Returning to height.'],
    },
  },
  monsoon: {
    id: 'monsoon', callsign: 'IRBIS 1', name: 'Monsoon', health: 270, score: 3500,
    skillOverrides: { lockTime: 1.0, mslCooldown: 6, vertical: 0.9, jink: 1, missiles: 12, reaction: 0.14 },
    airframeOverrides: { maxG: 9.2, turnRate: 0.56, accel: 37, bleed: 2.5 },
    lines: {
      engage: ['Irbis Lead. So this is the one who took the ridge. Let us see.', 'All Irbis: he is alone. Do not waste him.'],
      fire: ['Lead, firing.'],
      hit: ['Hm. You have teeth.', 'Again. Show me again.'],
      down: ['Lead is going in. ...It was an honour, pilot.'],
      kill: ['Irbis Lead. It is done. He deserved better odds.'],
    },
  },
};

/**
 * Reactive chatter: [category] -> {cooldown (s), priority, speaker, lines}.
 * The mission system picks a line when the matching event fires and the
 * category is off cooldown.
 */
export const CHATTER = {
  playerMissile:   { cooldown: 9,  priority: 0, speaker: 'player',  lines: ['Vajra One, Fox Two.', 'Fox Two.', 'Missile away.'] },
  playerRadar:     { cooldown: 9,  priority: 0, speaker: 'player',  lines: ['Vajra One, Fox One.', 'Fox One, long shot.'] },
  playerRockets:   { cooldown: 12, priority: 0, speaker: 'player',  lines: ['Rockets.', 'Rippling rockets.'] },
  playerBomb:      { cooldown: 8,  priority: 0, speaker: 'player',  lines: ['Bombs gone.', 'Pickle.'] },
  airKill:         { cooldown: 3,  priority: 1, speaker: 'wing',    lines: ['Splash one! Good kill, lead.', 'He is going down. Splash.', 'Confirmed, bandit destroyed.', 'That one will not climb again. Good shooting.'] },
  gunKill:         { cooldown: 3,  priority: 1, speaker: 'wing',    lines: ['Guns kill! Beautiful.', 'Guns, guns — he is finished.'] },
  groundKill:      { cooldown: 7,  priority: 0, speaker: 'fac',     lines: ['Good hits. Position is burning.', 'Direct hit. Keep it coming.', 'Target destroyed, that gun is silent.', 'That is a hit. We see smoke.'] },
  bigKill:         { cooldown: 4,  priority: 1, speaker: 'fac',     lines: ['Secondaries! You found their ammunition.', 'Whole dump just went up. We felt that down here.'] },
  missileWarning:  { cooldown: 6,  priority: 2, speaker: 'wing',    lines: ['Missile, missile! Break!', 'Vajra One, missile inbound — flares, break now!', 'Smoke in the air, on you! Break!'] },
  samLaunch:       { cooldown: 10, priority: 2, speaker: 'control', lines: ['SAM launch! Get low, put a ridge between you.', 'Shikhar: SAM in the air. Terrain is your friend.'] },
  manpadsLaunch:   { cooldown: 10, priority: 2, speaker: 'fac',     lines: ['Shoulder launch from the ridge! Flares!', 'Missile off the rocks, coming up at you!'] },
  playerHit:       { cooldown: 8,  priority: 1, speaker: 'wing',    lines: ['You are hit, lead! Check your gauges.', 'Vajra One, you are trailing smoke.'] },
  playerCritical:  { cooldown: 25, priority: 2, speaker: 'control', lines: ['Vajra One, Shikhar. You are badly damaged. Your call, but be careful.', 'Shikhar: one more hit and you are walking home, Vajra.'] },
  missileEvaded:   { cooldown: 12, priority: 0, speaker: 'wing',    lines: ['It missed! Nicely done.', 'Missile defeated. Stay on it.'] },
  lowAmmo:         { cooldown: 60, priority: 1, speaker: 'player',  lines: ['Vajra One is nearly Winchester.'] },
  pullUp:          { cooldown: 15, priority: 2, speaker: 'wing',    lines: ['Pull up, pull up! Watch the rocks!'] },
  bandits:         { cooldown: 15, priority: 1, speaker: 'control', lines: ['Bandits committing on you.', 'Hostiles turning in, they have seen you.'] },
};

export const REMEMBRANCE = {
  title: 'In remembrance',
  lines: [
    'This is a work of fiction, flown over real mountains.',
    'In the summer of 1999 aircrew and soldiers fought at heights where engines starve and men can barely breathe.',
    'Some of them did not come home.',
    'We remember them — not as a score.',
  ],
};
