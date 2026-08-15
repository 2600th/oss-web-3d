import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Audio } from './Audio.js';
import { Music } from './Music.js';

const gameSource = await readFile(new URL('../game/Game.js', import.meta.url), 'utf8');

const param = () => ({
  value: 0,
  calls: [],
  ramps: [],
  setTargetAtTime(value) { this.calls.push(value); },
  setValueAtTime(value) { this.ramps.push(value); },
  linearRampToValueAtTime(value) { this.ramps.push(value); },
  exponentialRampToValueAtTime(value) { this.ramps.push(value); },
  cancelScheduledValues() {},
});
const node = () => ({
  gain: param(), frequency: param(), Q: param(),
  connect(next) { return next; }, start() {}, stop() {}, disconnect() {},
});

/**
 * The live node graph, stubbed. This mirrors _build's output rather than the
 * subset any one test touches, because a fixture that lags the graph fails as
 * a missing property instead of as the contract under test.
 */
const fixture = (overrides = {}) => {
  const audio = Object.create(Audio.prototype);
  Object.assign(audio, {
    ready: true,
    ctx: {
      state: 'running', currentTime: 4,
      createBufferSource: node, createBiquadFilter: node, createGain: node, createOscillator: node,
    },
    _noise: {}, limiter: node(), _n1: 0.7, _n2: 0.8, _warnPhase: 0,
    _gSmoothed: 1, _machArmed: true,
    rumbleOsc: node(), rumbleGain: node(), whineOsc: node(), whineFilter: node(), whineGain: node(),
    effluxFilter: node(), effluxGain: node(), reheatFilter: node(), reheatGain: node(),
    windFilter: node(), windGain: node(), warnOsc: node(), warnGain: node(),
    cabin: node(), machDip: node(), stressFilter: node(), stressGain: node(),
    music: { setIntensity() {}, setTension() {} },
  }, overrides);
  return audio;
};

const flying = (extra = {}) => ({
  crashed: false, throttleSmoothed: 0.6, airspeed: 200, altitude: 3000, gLoad: 1, ...extra,
});

{
  const audio = fixture();
  audio.impact(1);
  assert.equal(audio.warnGain.gain.calls.at(-1), 0, 'impact must silence an active warning tone');
  assert.equal(audio.stressGain.gain.calls.at(-1), 0, 'impact must silence the airframe stress bed');
  assert.equal(
    audio.cabin.frequency.calls.at(-1),
    20000,
    'impact must reopen the cabin filter — the pull that preceded it left the mix muffled',
  );
  const silenced = [
    audio.rumbleGain, audio.whineGain, audio.effluxGain,
    audio.reheatGain, audio.windGain, audio.warnGain, audio.stressGain,
  ];
  for (const gain of silenced) gain.gain.calls.length = 0;
  audio.cabin.frequency.calls.length = 0;
  audio.update(1 / 60, flying({ crashed: true, throttleSmoothed: 1, airspeed: 400 }));
  assert.deepEqual(
    silenced.map((g) => g.gain.calls),
    [[], [], [], [], [], [], []],
    'engine, wind, stress and warning gains must remain untouched after impact silences them',
  );
  assert.deepEqual(audio.cabin.frequency.calls, [], 'the cabin filter must stay open after impact');
}

// G-load closes the cabin filter and opens the airframe bed. Both are silent in
// ordinary manoeuvring, so the knee is part of the contract: if it drifted down
// the whole mix would sit muffled through a normal turn.
{
  const audio = fixture();
  audio.update(1, flying({ gLoad: 1 }));
  assert.equal(audio.cabin.frequency.calls.at(-1), 20000, 'level flight must leave the mix open');
  assert.equal(audio.stressGain.gain.calls.at(-1), 0, 'level flight must not load the airframe');

  const cruising = fixture();
  cruising.update(1, flying({ gLoad: 3 }));
  assert.equal(cruising.cabin.frequency.calls.at(-1), 20000, 'a 3 G turn is below the knee');

  const pulling = fixture({ _gSmoothed: 8 });
  pulling.update(1 / 60, flying({ gLoad: 8 }));
  assert.ok(
    pulling.cabin.frequency.calls.at(-1) < 3000,
    `8 G must grey the mix down, got ${pulling.cabin.frequency.calls.at(-1)} Hz`,
  );
  assert.ok(pulling.stressGain.gain.calls.at(-1) > 0.05, 'the airframe must be audible under load');
}

// The debrief must never inherit a muffled mix. update() stops once the sortie
// ends, so whatever the cabin filter was doing at that instant it keeps doing.
{
  const audio = fixture({ _gSmoothed: 8 });
  audio.update(1 / 60, flying({ gLoad: 8 }));
  assert.ok(audio.cabin.frequency.calls.at(-1) < 3000, 'precondition: the mix is muffled');
  audio.endSortie();
  assert.equal(audio.cabin.frequency.calls.at(-1), 20000, 'the closing cue must be heard clearly');
  assert.equal(audio.stressGain.gain.calls.at(-1), 0, 'the airframe bed must not run under the debrief');
  assert.equal(audio._gSmoothed, 1);
}

// The transonic one-shot fires once per crossing. Without the hysteresis band a
// speed sitting on the threshold retriggers it every frame.
{
  const audio = fixture();
  audio.update(1 / 60, flying({ airspeed: 290 }));
  assert.equal(audio.machDip.gain.ramps.length, 0, 'subsonic flight must not fire the boom');

  audio.update(1 / 60, flying({ airspeed: 300 }));
  const fired = audio.machDip.gain.ramps.length;
  assert.ok(fired > 0, 'crossing the threshold must dip the airflow bed');
  assert.equal(audio._machArmed, false);

  for (let i = 0; i < 30; i++) audio.update(1 / 60, flying({ airspeed: 296 }));
  assert.equal(audio.machDip.gain.ramps.length, fired, 'the boom must not retrigger while supersonic');

  audio.update(1 / 60, flying({ airspeed: 270 }));
  assert.equal(audio._machArmed, true, 'dropping well below the threshold must rearm it');
  audio.update(1 / 60, flying({ airspeed: 300 }));
  assert.ok(audio.machDip.gain.ramps.length > fired, 'a second crossing must fire again');
}

// Tension is a range mapping, and the score must never see a value outside 0..1.
{
  const seen = [];
  const audio = fixture({ music: { setIntensity() {}, setTension: (t) => seen.push(t) } });
  audio.setTension(40000, true);
  audio.setTension(3000, true);
  audio.setTension(400, true);
  audio.setTension(400, false);
  assert.equal(seen[0], 0, 'a distant target must leave the score at rest');
  assert.ok(seen[1] > 0 && seen[1] < 1, 'the approach must be continuous, not a switch');
  assert.equal(seen[2], 1, 'arriving over the post must reach full tension');
  assert.equal(seen[3], 0, 'no target means no tension');
}

{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Set();
  let nextId = 1;
  globalThis.setTimeout = () => { const id = nextId++; pending.add(id); return id; };
  globalThis.clearTimeout = (id) => pending.delete(id);
  try {
    const ctx = {
      currentTime: 0, state: 'running', sampleRate: 48000,
      createGain: node,
      createBiquadFilter: node,
    };
    const music = new Music(ctx, node());
    music._register(node(), [node()], 10);
    assert.equal(pending.size, 1);
    music.dispose();
    assert.equal(pending.size, 0, 'dispose must cancel every owned timeout');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Set();
  globalThis.setInterval = () => { const id = Symbol('interval'); intervals.add(id); return id; };
  globalThis.clearInterval = (id) => intervals.delete(id);
  try {
    const ctx = { currentTime: 0, state: 'running', sampleRate: 48000, createGain: node, createBiquadFilter: node };
    const music = new Music(ctx, node());
    music._voice = () => {};
    music.play('loss');
    for (let i = 0; i < 20 && music._timer; i++) {
      ctx.currentTime = music._next;
      music._pump();
    }
    assert.equal(music._timer, null, 'a finite cue must stop its scheduler after its last event');
    assert.equal(intervals.size, 0);
    music.dispose();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

// The sortie cue tightens with tension, and the sting is the only place the
// melody ever lands on the tonic the drone has been holding all along. That
// withholding is the whole design: if the sortie phrase starts resolving,
// securing a post stops meaning anything.
{
  const TONIC = -9;
  const onTonic = (note) => ((note - TONIC) % 12 + 12) % 12 === 0;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => Symbol('interval');
  globalThis.clearInterval = () => {};
  try {
    const ctx = { currentTime: 0, state: 'running', sampleRate: 48000, createGain: node, createBiquadFilter: node };
    const music = new Music(ctx, node());
    music.play('sortie');
    const bar = (tension) => {
      const out = [];
      for (let step = 0; step < 16; step++) out.push(...music.cue.at(step, tension));
      return out;
    };

    const calm = bar(0);
    const tense = bar(0.85);
    assert.equal(calm.filter((e) => e.voice === 'drone').length, 2, 'the resting bed is two drones');
    assert.equal(
      tense.filter((e) => e.voice === 'drone').length,
      3,
      'the approach opens a fifth above the drone',
    );
    assert.ok(tense.some((e) => e.voice === 'drone' && e.note === TONIC + 7), 'the added drone is a fifth');
    assert.ok(
      tense.filter((e) => e.voice === 'pluck').length > calm.filter((e) => e.voice === 'pluck').length,
      'the phrase cadence must tighten on the run in',
    );
    // The drone holds the tonic, as a tanpura does — that is the ground the
    // phrase is unresolved *against*. It is the melodic voices that must never
    // arrive there while posts remain.
    for (const [name, events] of [['calm', calm], ['tense', tense]]) {
      assert.ok(
        !events.some((e) => e.voice !== 'drone' && onTonic(e.note)),
        `the ${name} sortie melody must never reach the tonic`,
      );
    }

    const played = [];
    music._voice = (e) => played.push(e);
    music.sting();
    assert.ok(played.length > 0, 'securing a post must be scored');
    assert.ok(played.some((e) => onTonic(e.note)), 'the sting must resolve onto the tonic');

    played.length = 0;
    music.cue = null;
    music.sting();
    assert.equal(played.length, 0, 'a sting with no cue running must be silent');
    music.dispose();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

{
  let musicDisposed = 0;
  let contextClosed = 0;
  const audio = Object.create(Audio.prototype);
  Object.assign(audio, {
    ctx: { close() { contextClosed++; } },
    music: { dispose() { musicDisposed++; } },
    ready: true,
  });
  audio.dispose();
  audio.dispose();
  assert.equal(musicDisposed, 1, 'Audio must dispose the scheduler it owns');
  assert.equal(contextClosed, 1, 'Audio disposal must be idempotent');
}

// The menu theme is the one cue allowed to be a tune, and its identity is raga
// Desh: S R M P N S' up with Ga and Dha left out, the full S' N D P M G R S back
// down. Leave those two notes in the ascent and the whole thing collapses into a
// generic major scale, which is precisely what it must not be.
{
  const TONIC = -9;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => Symbol('interval');
  globalThis.clearInterval = () => {};
  try {
    const ctx = {
      currentTime: 0, state: 'running', sampleRate: 48000,
      createGain: node, createBiquadFilter: node,
    };
    const music = new Music(ctx, node());
    music.play('menu');

    assert.equal(music.cue.steps, undefined, 'the menu theme must loop, not run out');
    assert.equal(music.cue.ducks, false, 'there is no engine on a menu to duck under');

    const pass = (index) => {
      const out = [];
      for (let step = index * 32; step < (index + 1) * 32; step++) out.push(...music.cue.at(step));
      return out;
    };

    const degrees = (events) =>
      events.filter((e) => e.voice === 'flute').map((e) => ((e.note - TONIC) % 12 + 12) % 12);

    const first = pass(0);
    assert.deepEqual(
      degrees(first),
      [0, 2, 5, 7, 11, 0, 11, 9, 7, 5, 7, 4, 2, 0],
      'S R M P N Ṡ up, Ṡ N D P M P G R S down',
    );
    const ascent = degrees(first).slice(0, 6);
    assert.ok(!ascent.includes(4), 'Ga is omitted from the ascent');
    assert.ok(!ascent.includes(9), 'Dha is omitted from the ascent');
    assert.ok(degrees(first).slice(6).includes(9), 'Dha returns on the way down');

    // A menu resolves where the sortie never does — the last melodic note is home.
    assert.equal(degrees(first).at(-1), 0);

    // Two beats of rest at the bottom of the phrase give the loop a seam.
    assert.equal(degrees(first).length, 14, 'sixteen slots, two of them rests');

    // The repeat is an arrangement change, not a rerun.
    const second = pass(1);
    assert.equal(degrees(second).length, 8, 'the flute sits out the ascent on the second pass');
    assert.deepEqual(degrees(second), degrees(first).slice(6), 'and returns for the descent');
    const loudPluck = (events) => events.filter((e) => e.voice === 'pluck' && e.gain > 0.3).length;
    assert.ok(
      loudPluck(second) > loudPluck(first),
      'the pluck carries the ascent the flute handed over',
    );

    music.dispose();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

// Which screens the theme plays under, and the one hand-back that is easy to
// forget: pausing swaps the sortie cue for the menu, so unpausing has to swap
// it back or the flight runs the rest of the sortie under menu music.
{
  assert.match(
    gameSource,
    /const MENU_MUSIC_STATES = new Set\(\['title', 'briefing', 'paused'\]\)/,
  );
  assert.match(gameSource, /MENU_MUSIC_STATES\.has\(this\.state\)\) this\.audio\.music\?\.play\('menu'\)/);

  const resume = gameSource.slice(gameSource.indexOf('  resume() {'));
  assert.match(
    resume.slice(0, resume.indexOf('\n  }')),
    /this\.audio\.music\?\.play\('sortie'\)/,
    'unpausing must hand the score back to the sortie cue',
  );
}


// Nothing drives the flight bed outside the flying path: update() is only
// called from _updateFlight, so pause and both debriefs used to leave the
// engine, wind and any live warning tone frozen at their last flown value and
// holding it indefinitely. Measured at full reheat: 0.204 peak amplitude in
// flight, still 0.197 six seconds into the pause menu, under the menu theme.
{
  const audio = fixture();
  const beds = [
    audio.rumbleGain, audio.whineGain, audio.effluxGain,
    audio.reheatGain, audio.windGain, audio.stressGain, audio.warnGain,
  ];
  for (const bed of beds) bed.gain.calls.length = 0;
  audio.cabin.frequency.calls.length = 0;
  audio._n1 = 0.9;
  audio._n2 = 0.95;

  audio.quietFlightBed(0.5);
  assert.deepEqual(
    beds.map((bed) => bed.gain.calls.at(-1)),
    [0, 0, 0, 0, 0, 0, 0],
    'every flight bed must be ramped to silence',
  );
  assert.equal(audio.cabin.frequency.calls.at(-1), 20000, 'and the cabin filter reopened');
  assert.equal(audio._n1, 0.9, 'spool state is untouched');
  assert.equal(audio._n2, 0.95, 'so resuming does not re-spool from idle');

  // endSortie routes through the same fade, so a closing cue is not played
  // over a frozen afterburner.
  for (const bed of beds) bed.gain.calls.length = 0;
  audio.endSortie();
  assert.deepEqual(beds.map((bed) => bed.gain.calls.at(-1)), [0, 0, 0, 0, 0, 0, 0]);
}

// Pause hands the score to the menu theme, so it must also quiet the engine.
{
  const pause = gameSource.slice(gameSource.indexOf('  pause() {'));
  assert.match(
    pause.slice(0, pause.indexOf('\n  }')),
    /quietFlightBed/,
    'pausing must spool the flight bed down',
  );
}

console.log('audio lifecycle contracts passed');
