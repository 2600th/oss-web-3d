// The campaign: four missions and free flight, as data. See runner.js for the
// phase / condition / action vocabulary and ai/system.js for spawn definitions.
// World coordinates: metres, +X east, +Z south, origin at the DEM centre.
// Headings are compass degrees (0 = north, 90 = east).
//
// Sites (from the DEM): Drass valley floor ~(-30000, 8000) 3090 m; Tololing
// ridge ~(-32150, 500) 4780 m; Tiger Hill ~(-38950, 1860) 4530 m; Kargil
// ~(3300, -6300) 2690 m; Batalik ridge ~(25080, -20110) 4170 m above the Indus
// at ~(20500, -18700) 2570 m.
import { ACES } from './cast.js';

const TOLOLING = { x: -32150, z: 500 };
const TIGER = { x: -38950, z: 1860 };
const BATALIK = { x: 25080, z: -20110 };

export const MISSIONS = [
  // ------------------------------------------------------------------ M1 --
  {
    id: 'm1', order: 1, name: 'First Light', location: 'Tololing ridge, above Drass',
    summary: 'Strike the hostile positions dug in on the ridge that overlooks the valley road.',
    briefing: [
      'Hostile forces have dug in along the ridge north of Drass and are shelling the only road through the valley.',
      'Follow the river west. Three strongpoints sit on the crest: destroy their sangars and the supply dump behind them.',
      'Expect anti-aircraft guns on the shoulders and shoulder-launched missiles in the rocks. Flares when you hear the tone.',
      'Standard missiles will lock ground targets. Rockets and bombs hit the stone harder.',
    ],
    start: { x: -15500, z: 9300, alt: 5300, heading: 268, speed: 250 },
    specials: ['rkt', 'bomb', 'hobs'], special: 'rkt',
    timeLimit: 900, parTime: 360, rank: { S: 10200, A: 8800, B: 7200, C: 5500 },
    maxAttackers: 2,
    groups: {
      crest: { kind: 'base', kit: 'raven', near: TOLOLING, search: 700, snap: 'ridge', name: 'STRONGPOINT', tags: ['m1_primary'], isTarget: true, kitHealth: 170,
        units: [{ type: 'sangar', count: 3, tags: ['m1_primary'], isTarget: true }, { type: 'supply', count: 1, tags: ['m1_primary'], isTarget: true },
          { type: 'aaa', count: 2, isTarget: false }, { type: 'tent', count: 3, isTarget: false }, { type: 'manpads', count: 1, isTarget: false }] },
      east: { kind: 'base', kit: 'slate', near: { x: -30300, z: 2500 }, search: 900, snap: 'ridge', name: 'STRONGPOINT', tags: ['m1_primary'], isTarget: true, kitHealth: 170,
        units: [{ type: 'sangar', count: 2, tags: ['m1_primary'], isTarget: true }, { type: 'aaa', count: 1, isTarget: false }, { type: 'tent', count: 2, isTarget: false }, { type: 'manpads', count: 1, isTarget: false }] },
      west: { kind: 'base', kit: 'cinder', near: { x: -34200, z: 1900 }, search: 900, snap: 'ridge', name: 'STRONGPOINT', tags: ['m1_primary'], isTarget: true, kitHealth: 170,
        units: [{ type: 'sangar', count: 2, tags: ['m1_primary'], isTarget: true }, { type: 'flak', count: 1, isTarget: false }, { type: 'tent', count: 2, isTarget: false }] },
      convoy: { kind: 'convoy', from: { x: -30000, z: 8000 }, heading: 280, length: 9500, count: 5, speed: 15, tags: ['m1_convoy'], isTarget: true },
      bandits: { kind: 'fighters', type: 'bandit', count: 2, at: { x: -41000, z: -12000, alt: 6300 }, heading: 140, tags: ['m1_air'], isTarget: true, aware: true },
    },
    phases: [
      {
        id: 'ingress', name: 'Ingress', objective: { text: 'Follow the Drass valley west to the ridge', marker: TOLOLING },
        enter: [
          { music: { state: 'cruise', level: 0.3 } },
          { spawn: 'crest' }, { spawn: 'east' }, { spawn: 'west' },
          { radio: ['control', 'Vajra One, Shikhar. Radar contact, you are clear west along the river.', 1] },
          { radio: ['fac', 'Vajra, Anvil Six. We are in the valley below the ridge. Three strongpoints on the crest — they have the road zeroed.', 1] },
        ],
        triggers: [
          { when: { time: 22 }, do: [{ radio: ['wing', 'Vajra Two is high and dry, watching your six. Thin air today, lead — mind your speed in the turns.', 0] }] },
        ],
        done: { zone: { ...TOLOLING, r: 9500 } },
      },
      {
        id: 'strike', name: 'Strike', objective: { text: 'Destroy the ridge positions', track: { destroyed: 'm1_primary' }, marker: TOLOLING },
        enter: [
          { music: { state: 'combat', level: 0.6 } },
          { radio: ['fac', 'Anvil has you visual. Guns on both shoulders of the ridge — tracers coming up!', 2] },
          { radio: ['control', 'Vajra One, you are cleared hot. All positions on that crest are hostile.', 1] },
        ],
        triggers: [
          { when: { destroyed: 'm1_primary', count: 4 }, do: [{ radio: ['fac', 'That is it, Vajra! Their fire is slackening. Hit them again.', 1] }] },
          { when: { destroyed: 'm1_primary', count: 8 }, do: [{ radio: ['control', 'Shikhar: nearly there. Finish the last positions.', 1] }] },
        ],
        done: { destroyed: 'm1_primary' },
      },
      {
        id: 'convoy', name: 'Interdiction', objective: { text: 'Stop the trucks on the valley road', track: { destroyed: 'm1_convoy' }, marker: { x: -31000, z: 7900 } },
        enter: [
          { music: { state: 'combat', level: 0.75 } },
          { spawn: 'convoy' },
          { radio: ['fac', 'Ridge is silent! Trucks are pulling out along the valley road, heading west. Do not let them reach the pass.', 2] },
        ],
        triggers: [
          { when: { time: 35 }, do: [{ spawn: 'bandits' }, { radio: ['control', 'Vajra One, Shikhar. Pop-up contacts, two bandits, north-west, descending. They are coming for you.', 2] }, { music: { state: 'danger', level: 0.9 } }] },
          { when: { arrived: 'm1_convoy' }, do: [{ radio: ['fac', 'Trucks have reached the pass. We will deal with what got through.', 1] }] },
        ],
        done: { all: [{ any: [{ destroyed: 'm1_convoy' }, { arrived: 'm1_convoy' }] }, { time: 36 }] },
        exit: [],
      },
      {
        id: 'bandits', name: 'Defend', objective: { text: 'Shoot down the bandits', track: { destroyed: 'm1_air' } },
        enter: [{ radio: ['wing', 'Two bandits, lead. I am too high to help. They are yours.', 1] }],
        done: { destroyed: 'm1_air' },
        exit: [
          { radio: ['control', 'Shikhar: sky is clear. Outstanding work, Vajra One. Come home.', 1] },
          { music: { state: 'victory', level: 0.5 } },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ M2 --
  {
    id: 'm2', order: 2, name: 'River of Stone', location: 'Batalik sector, above the Indus',
    summary: 'Infantry are pinned below the eastern ridge. Clear the crest, then hold the sky over them.',
    briefing: [
      'Our infantry climbing above the Indus are pinned by guns on the crest. Anvil Six will talk you on.',
      'Silence the crest positions quickly — the men below cannot stay where they are for long.',
      'Sector control expects hostile fighters to contest the valley once you start hurting them.',
      'The dogfight missile locks well off the nose. Use it when they get close.',
    ],
    start: { x: 6500, z: -8300, alt: 5000, heading: 58, speed: 260 },
    specials: ['hobs', 'rkt', 'lraam'], special: 'hobs',
    timeLimit: 840, parTime: 360, rank: { S: 11400, A: 9800, B: 8000, C: 6000 },
    maxAttackers: 2,
    groups: {
      crest: { kind: 'base', kit: 'hollow', near: BATALIK, search: 800, snap: 'ridge', name: 'STRONGPOINT', tags: ['m2_cas'], isTarget: true, kitHealth: 170,
        units: [{ type: 'sangar', count: 3, tags: ['m2_cas'], isTarget: true }, { type: 'aaa', count: 2, isTarget: false }, { type: 'manpads', count: 2, isTarget: false }, { type: 'tent', count: 3, isTarget: false }] },
      spur: { kind: 'base', near: { x: 22600, z: -21500 }, search: 900, snap: 'ridge', tags: ['m2_cas'], isTarget: true,
        units: [{ type: 'sangar', count: 2, tags: ['m2_cas'], isTarget: true }, { type: 'supply', count: 1, tags: ['m2_cas'], isTarget: true }, { type: 'aaa', count: 1, isTarget: false }, { type: 'tent', count: 2, isTarget: false }] },
      wave1: { kind: 'fighters', type: 'bandit', count: 2, at: { x: 24000, z: -37000, alt: 6200 }, heading: 180, tags: ['m2_air'], isTarget: true, aware: true },
      wave1b: { kind: 'fighters', type: 'bandit', count: 2, at: { x: 31000, z: -35000, alt: 5800 }, heading: 200, tags: ['m2_air'], isTarget: true, aware: true },
      wave2: { kind: 'fighters', type: 'veteran', count: 2, at: { x: 38000, z: -30000, alt: 6500 }, heading: 235, tags: ['m2_air'], isTarget: true, aware: true },
    },
    phases: [
      {
        id: 'cas', name: 'Close support', objective: { text: 'Destroy the crest positions above Anvil', track: { destroyed: 'm2_cas' }, marker: BATALIK },
        enter: [
          { music: { state: 'cruise', level: 0.4 } },
          { spawn: 'crest' }, { spawn: 'spur' },
          { radio: ['fac', 'Vajra One, Anvil Six! We are pinned on the east face, taking fire from the crest above us. North-east of the river bend.', 2] },
          { radio: ['control', 'Shikhar copies. Vajra One, push north-east, cleared hot on the crest. Friendlies are below the ridgeline, keep it on the top.', 1] },
        ],
        triggers: [
          { when: { zone: { ...BATALIK, r: 8000 } }, do: [{ music: { state: 'combat', level: 0.65 } }, { radio: ['fac', 'We hear you, Vajra! Positions are right on the skyline. Guns to the left of the big strongpoint.', 1] }] },
          { when: { time: 200 }, do: [{ radio: ['fac', 'Anvil Six — we are taking casualties down here. Need those guns gone, Vajra.', 2] }] },
          { when: { time: 300 }, do: [{ radio: ['fac', 'Vajra, we cannot hold this face much longer!', 2] }, { music: { state: 'danger', level: 0.9 } }] },
          { when: { destroyed: 'm2_cas', count: 3 }, do: [{ radio: ['fac', 'Good hits! Their fire is thinning. Keep working the crest.', 1] }] },
        ],
        failWhen: { time: 380 }, failReason: 'overrun',
        done: { destroyed: 'm2_cas' },
        exit: [{ bonus: { label: 'Anvil relieved', score: 1500 } }, { radio: ['fac', 'Crest is clear! Anvil is moving up. We owe you, Vajra.', 2] }],
      },
      {
        id: 'intercept', name: 'Intercept', objective: { text: 'Intercept the inbound fighters', track: { destroyed: 'm2_air' } },
        enter: [
          { music: { state: 'danger', level: 0.85 } },
          { spawn: 'wave1' }, { spawn: 'wave1b' },
          { radio: ['control', 'Vajra One, Shikhar. Four bandits, north, twelve kilometres, low and fast. They are after Anvil. Commit.', 2] },
          { radio: ['wing', 'Tally four. Split them, lead — do not let them drag you down into the valley.', 1] },
        ],
        triggers: [
          { when: { destroyed: 'm2_air', count: 2 }, do: [{ spawn: 'wave2' }, { radio: ['control', 'Shikhar: second group, two more, from the north-east. These ones are flying it properly. Stay sharp.', 2] }] },
        ],
        done: { destroyed: 'm2_air' },
        exit: [{ radio: ['control', 'Shikhar: scope is clean. Anvil is on the crest. Bring it home, Vajra One.', 1] }, { music: { state: 'victory', level: 0.5 } }],
      },
    ],
  },

  // ------------------------------------------------------------------ M3 --
  {
    id: 'm3', order: 3, name: 'Long Lens', location: 'Ridges between Drass and Kargil',
    summary: 'Photograph four observation posts with the nose optic while the air defences are awake.',
    briefing: [
      'Before the next push we need photographs of four observation posts. Not craters — photographs.',
      'Hold V to open the nose optic. Frame a post inside five kilometres with a clear line of sight and hold it steady; the camera fires itself.',
      'Radar-guided missiles cover the approaches. They cannot see you below the ridgeline, and flares will not fool them. Kill the radar and the launchers go blind.',
      'Fighters will scramble once they understand what you are doing. Bring the film home.',
    ],
    start: { x: -21000, z: 8600, alt: 4700, heading: 78, speed: 250 },
    specials: ['hobs', 'bomb', 'lraam'], special: 'hobs',
    timeLimit: 900, parTime: 420, rank: { S: 14000, A: 12000, B: 9500, C: 7000 },
    maxAttackers: 2, recon: { total: 4, photoScore: 1800 },
    groups: {
      post1: { kind: 'base', near: { x: -12500, z: 2500 }, search: 2200, snap: 'ridge', tags: ['m3_site'], units: [{ type: 'post', tags: ['m3_post'], isTarget: true }, { type: 'manpads', count: 1 }, { type: 'tent', count: 2 }] },
      post2: { kind: 'base', near: { x: -5500, z: -3500 }, search: 2200, snap: 'ridge', tags: ['m3_site'], units: [{ type: 'post', tags: ['m3_post'], isTarget: true }, { type: 'aaa', count: 2 }, { type: 'tent', count: 2 }] },
      post3: { kind: 'base', near: { x: 1500, z: 2500 }, search: 2200, snap: 'ridge', tags: ['m3_site'], units: [{ type: 'post', tags: ['m3_post'], isTarget: true }, { type: 'manpads', count: 2 }, { type: 'sangar', count: 1 }] },
      post4: { kind: 'base', near: { x: 8500, z: -4500 }, search: 2200, snap: 'ridge', tags: ['m3_site'], units: [{ type: 'post', tags: ['m3_post'], isTarget: true }, { type: 'aaa', count: 1 }, { type: 'flak', count: 1 }, { type: 'tent', count: 2 }] },
      sam1: { kind: 'base', near: { x: -8500, z: 500 }, search: 1800, snap: 'flat', tags: ['m3_sam'], units: [{ type: 'radar', count: 1 }, { type: 'sam', count: 2 }] },
      sam2: { kind: 'base', near: { x: 5500, z: -1000 }, search: 1800, snap: 'flat', tags: ['m3_sam'], units: [{ type: 'radar', count: 1 }, { type: 'sam', count: 2 }] },
      scramble: { kind: 'fighters', type: 'veteran', count: 2, at: { x: 2000, z: -26000, alt: 6200 }, heading: 190, tags: ['m3_air'], aware: true },
      pursuit: { kind: 'fighters', type: 'bandit', count: 2, at: { x: 14000, z: -22000, alt: 6000 }, heading: 240, tags: ['m3_air'], aware: true },
    },
    phases: [
      {
        id: 'recon', name: 'Reconnaissance', objective: { text: 'Photograph the observation posts (hold V)', track: { captured: 4 } },
        enter: [
          { music: { state: 'cruise', level: 0.45 } },
          { spawn: 'post1' }, { spawn: 'post2' }, { spawn: 'post3' }, { spawn: 'post4' }, { spawn: 'sam1' }, { spawn: 'sam2' },
          { radio: ['control', 'Vajra One, Shikhar. Four posts along the ridges east of you. Optic on, pictures only.', 1] },
          { radio: ['control', 'Be advised, search radar is active in the sector. Stay under the ridgeline when you can.', 1] },
        ],
        triggers: [
          { when: { captured: 1 }, do: [{ radio: ['control', 'Shikhar has your first frame. Clean picture. Three more.', 1] }] },
          { when: { captured: 2 }, do: [{ spawn: 'scramble' }, { music: { state: 'combat', level: 0.7 } }, { radio: ['control', 'Vajra One, they have worked out what you are doing. Two fighters scrambling from the north.', 2] }] },
          { when: { captured: 3 }, do: [{ radio: ['wing', 'One more, lead. Then we run.', 1] }] },
        ],
        done: { captured: 4 },
      },
      {
        id: 'egress', name: 'Egress', objective: { text: 'Bring the film home: return west to the Drass valley', marker: { x: -21000, z: 8600 } },
        enter: [
          { music: { state: 'danger', level: 0.9 } },
          { spawn: 'pursuit' },
          { radio: ['control', 'That is all four. Film is worth more than your aircraft, Vajra — come home. West along the river.', 2] },
          { radio: ['control', 'More bandits behind you. You do not have to fight them. You have to get back.', 1] },
        ],
        done: { zone: { x: -21000, z: 8600, r: 4500 } },
        exit: [
          { bonus: { label: 'Film delivered', score: 2500 } },
          { radio: ['tower', 'Home Plate has you in sight, Vajra One. The darkroom is waiting. Welcome back.', 1] },
          { music: { state: 'victory', level: 0.5 } },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ M4 --
  {
    id: 'm4', order: 4, name: "Tiger's Teeth", location: 'Tiger Hill',
    summary: 'Break the summit positions on Tiger Hill — and meet the ace flight sent to stop you.',
    briefing: [
      'Tiger Hill commands everything west of Drass. Tonight the infantry climb it. This afternoon you open the door.',
      'Bunkers on the summit, sangars on the eastern spur, a radar-guided missile site in the valley beneath. Bombs for the bunkers.',
      'Intelligence believes the hostile ace flight, callsign Irbis, has moved into the sector. Four aircraft. They do not fly like the others.',
      'If Irbis comes, you will be outnumbered. Fight your fight, not theirs.',
    ],
    start: { x: -21500, z: 9400, alt: 5500, heading: 282, speed: 260 },
    specials: ['bomb', 'rkt', 'hobs'], special: 'bomb',
    timeLimit: 960, parTime: 480, rank: { S: 19000, A: 16500, B: 13500, C: 10000 },
    maxAttackers: 2,
    groups: {
      summit: { kind: 'base', kit: 'marble', near: TIGER, search: 600, snap: 'ridge', name: 'SUMMIT BUNKER', tags: ['m4_primary'], isTarget: true, kitHealth: 260,
        units: [{ type: 'bunker', count: 2, tags: ['m4_primary'], isTarget: true }, { type: 'flak', count: 1, isTarget: false }, { type: 'aaa', count: 2, isTarget: false }, { type: 'manpads', count: 1, isTarget: false }] },
      spur: { kind: 'base', kit: 'raven', near: { x: -37100, z: 2900 }, search: 800, snap: 'ridge', name: 'STRONGPOINT', tags: ['m4_primary'], isTarget: true, kitHealth: 170,
        units: [{ type: 'sangar', count: 3, tags: ['m4_primary'], isTarget: true }, { type: 'supply', count: 1, tags: ['m4_primary'], isTarget: true }, { type: 'aaa', count: 1, isTarget: false }, { type: 'manpads', count: 1, isTarget: false }, { type: 'tent', count: 3, isTarget: false }] },
      sam: { kind: 'base', near: { x: -35700, z: 3500 }, search: 1500, snap: 'flat', tags: ['m4_sam'], units: [{ type: 'radar', count: 1 }, { type: 'sam', count: 2 }, { type: 'flak', count: 1 }] },
      irbisA: { kind: 'fighters', aces: [ACES.cairn, ACES.verglas], at: { x: -41000, z: -15000, alt: 6900 }, heading: 150, speed: 300, tags: ['m4_aces'], isTarget: true, aware: true },
      irbisB: { kind: 'fighters', aces: [ACES.monsoon, ACES.scree], at: { x: -30000, z: -17000, alt: 7300 }, heading: 205, speed: 310, tags: ['m4_aces'], isTarget: true, aware: true },
    },
    phases: [
      {
        id: 'strike', name: 'Strike', objective: { text: 'Destroy the Tiger Hill positions', track: { destroyed: 'm4_primary' }, marker: TIGER },
        enter: [
          { music: { state: 'cruise', level: 0.5 } },
          { spawn: 'summit' }, { spawn: 'spur' }, { spawn: 'sam' },
          { radio: ['control', 'Vajra One, Shikhar. Tiger Hill is the big one west of the valley mouth. Everything on it is hostile.', 1] },
          { radio: ['fac', 'Anvil Six. We climb tonight, Vajra. Whatever you leave standing, we meet on the way up.', 1] },
        ],
        triggers: [
          { when: { zone: { ...TIGER, r: 9000 } }, do: [{ music: { state: 'combat', level: 0.7 } }, { radio: ['control', 'Radar site in the valley below the hill is tracking you. Mask behind the spur or kill it.', 2] }] },
          { when: { destroyed: 'm4_primary', count: 4 }, do: [{ flag: 'irbis' }] },
          { when: { time: 250 }, do: [{ flag: 'irbis' }] },
        ],
        done: { flag: 'irbis' },
      },
      {
        id: 'irbis', name: 'Irbis', objective: { text: 'Survive Irbis flight — shoot down all four', track: { destroyed: 'm4_aces' } },
        enter: [
          { music: { state: 'ace', level: 1 } },
          { maxAttackers: 2 },
          { spawn: 'irbisA' },
          { radio: ['control', 'Vajra One — Shikhar. Two contacts, north, very high, very fast. They are not answering to any pattern we know.', 2] },
          { radio: ['wing', 'Lead... those are not regulars. That is Irbis.', 2] },
        ],
        triggers: [
          { when: { any: [{ destroyed: 'm4_aces', count: 1 }, { time: 75 }] }, do: [{ spawn: 'irbisB' }, { radio: ['control', 'Two more, north-east, coming down on you. That will be their leader.', 2] }] },
          { when: { destroyed: 'm4_aces', count: 3 }, do: [{ radio: ['wing', 'One left, lead! It is just him now!', 1] }] },
        ],
        done: { all: [{ destroyed: 'm4_aces', count: 4 }, { time: 76 }] },
        exit: [{ bonus: { label: 'Irbis flight defeated', score: 3000 } }, { radio: ['control', 'Shikhar... scope is clean. All four. Vajra One, I do not have the words.', 2] }],
      },
      {
        id: 'finish', name: 'Finish the hill', objective: { text: 'Destroy the remaining Tiger Hill positions', track: { destroyed: 'm4_primary' }, marker: TIGER },
        enter: [{ music: { state: 'combat', level: 0.7 } }, { radio: ['fac', 'Anvil Six. The sky is yours, Vajra. Finish the summit for us.', 1] }],
        done: { destroyed: 'm4_primary' },
        exit: [
          { radio: ['fac', 'Summit is burning. We go up tonight. Thank you, Vajra — from all of us down here.', 2] },
          { radio: ['tower', 'Home Plate to Vajra One. Come home. The tea is hot.', 1] },
          { music: { state: 'victory', level: 0.6 } },
        ],
      },
    ],
    remembrance: true,
  },

  // ---------------------------------------------------------------- free --
  {
    id: 'free', order: 5, free: true, name: 'Free Flight', location: 'Drass valley',
    summary: 'No orders, no clock. A practice range in the valley and two drones that will not shoot back.',
    briefing: [
      'The sector is yours. Unarmed drones orbit above the valley; trucks and tents are laid out on the range near the river.',
      'Nothing here shoots back. Learn the aircraft: corner speed, the airbrake turn, the gun lead.',
    ],
    start: { x: -15500, z: 9300, alt: 5200, heading: 268, speed: 250 },
    specials: ['hobs', 'lraam', 'rkt', 'bomb'], special: 'hobs',
    timeLimit: 0, parTime: 0, rank: null,
    groups: {
      range: { kind: 'base', near: { x: -24000, z: 8800 }, search: 1200, snap: 'flat', tags: ['free'], spread: 320,
        units: [{ type: 'truck', count: 4 }, { type: 'tent', count: 5 }, { type: 'sangar', count: 2 }, { type: 'supply', count: 1 }, { type: 'bunker', count: 1 }] },
      drones: { kind: 'fighters', type: 'bandit', count: 2, at: { x: -24000, z: 5000, alt: 5600 }, heading: 90, tags: ['free'], names: ['DRONE', 'DRONE'],
        skillOverrides: { detect: 0, missiles: 0, gunRange: 0, flares: 0 },
        route: [{ x: -18000, z: 5000, alt: 5600 }, { x: -18000, z: 11000, alt: 5600 }, { x: -29000, z: 11000, alt: 5600 }, { x: -29000, z: 5000, alt: 5600 }] },
    },
    phases: [
      {
        id: 'free', name: 'Free flight', objective: { text: 'Free flight — practice range marked in the valley' },
        enter: [
          { music: { state: 'cruise', level: 0.3 } }, { hostile: false },
          { spawn: 'range' }, { spawn: 'drones' },
          { radio: ['tower', 'Vajra One, Home Plate. The valley is yours. Range is hot, drones are up. Enjoy the view.', 0] },
        ],
        done: { flag: 'never' },
      },
    ],
  },
];

export function missionById(id) {
  return MISSIONS.find((m) => m.id === id) ?? null;
}
