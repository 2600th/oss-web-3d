import assert from 'node:assert/strict';
import { Audio } from './Audio.js';
import { Music } from './Music.js';

const param = () => ({
  value: 0,
  calls: [],
  setTargetAtTime(value) { this.calls.push(value); },
  setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  cancelScheduledValues() {},
});
const node = () => ({
  gain: param(), frequency: param(), Q: param(),
  connect(next) { return next; }, start() {}, stop() {}, disconnect() {},
});

{
  const audio = Object.create(Audio.prototype);
  Object.assign(audio, {
    ready: true,
    ctx: {
      state: 'running', currentTime: 4,
      createBufferSource: node, createBiquadFilter: node, createGain: node, createOscillator: node,
    },
    _noise: {}, limiter: node(), _n1: 0.7, _n2: 0.8, _warnPhase: 0,
    rumbleOsc: node(), rumbleGain: node(), whineOsc: node(), whineFilter: node(), whineGain: node(),
    effluxFilter: node(), effluxGain: node(), reheatFilter: node(), reheatGain: node(),
    windFilter: node(), windGain: node(), warnOsc: node(), warnGain: node(),
    music: { setIntensity() {} },
  });
  audio.impact(1);
  assert.equal(audio.warnGain.gain.calls.at(-1), 0, 'impact must silence an active warning tone');
  for (const gain of [audio.rumbleGain, audio.whineGain, audio.effluxGain, audio.reheatGain, audio.windGain, audio.warnGain]) {
    gain.gain.calls.length = 0;
  }
  audio.update(1 / 60, { crashed: true, throttleSmoothed: 1, airspeed: 400, altitude: 3000 });
  assert.deepEqual(
    [audio.rumbleGain, audio.whineGain, audio.effluxGain, audio.reheatGain, audio.windGain, audio.warnGain].map((g) => g.gain.calls),
    [[], [], [], [], [], []],
    'engine, wind, and warning gains must remain untouched after impact silences them',
  );
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

console.log('audio lifecycle contracts passed');
