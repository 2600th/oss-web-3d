import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { matchMedia: () => ({ matches: false }) };
globalThis.document ??= {};

const { Engine } = await import('./Engine.js');

/**
 * The adaptive resolution scaler in isolation.
 *
 * This is the safety net under the whole 30 fps claim: the opening tier is a
 * guess from a renderer string that is often masked, so what actually protects
 * a slow GPU is that sustained slow frames pull resolution down. The reference
 * GPU cannot be made slow enough to exercise it live — at 140 march steps and a
 * full-resolution cloud buffer it still returns 104 fps — so it is proved here,
 * where the frame times are an input rather than something to be provoked.
 */
function harness({ renderScale = 1, hidden = false } = {}) {
  const engine = Object.create(Engine.prototype);
  let resizes = 0;
  Object.assign(engine, {
    renderScale,
    adaptEnabled: true,
    fps: 60,
    _frameTimes: new Float32Array(30),
    _sorted: new Float32Array(30),
    _frameIndex: 0,
    _frameCount: 0,
    _scaleCooldown: 0,
    resize() { resizes++; },
  });
  globalThis.document = { hidden };
  return {
    engine,
    get resizes() { return resizes; },
    /** Feed `seconds` of frames at a steady frame time. */
    run(frameSeconds, seconds) {
      const steps = Math.round(seconds / frameSeconds);
      for (let i = 0; i < steps; i++) engine._adapt(frameSeconds);
    },
  };
}

test('sustained slow frames converge on the floor and stop there', () => {
  const h = harness();
  h.run(1 / 24, 30); // a GPU delivering 24 fps at full resolution
  assert.equal(+h.engine.renderScale.toFixed(2), 0.62, 'must reach the floor');

  const atFloor = h.resizes;
  h.run(1 / 24, 20); // still slow — but there is nothing left to give
  assert.equal(+h.engine.renderScale.toFixed(2), 0.62, 'must not descend past the floor');
  assert.equal(h.resizes, atFloor, 'a pinned scaler must stop calling resize');
});

test('the descent is prompt enough to matter and monotonic', () => {
  const h = harness();
  const trace = [];
  for (let second = 0; second < 8; second++) {
    h.run(1 / 24, 1);
    trace.push(+h.engine.renderScale.toFixed(2));
  }
  for (let i = 1; i < trace.length; i++) {
    assert.ok(trace[i] <= trace[i - 1], `scale must never rise while slow: ${trace}`);
  }
  assert.ok(trace[5] <= 0.62 + 1e-6, `six seconds must be enough to reach the floor: ${trace}`);
});

test('fast frames climb back to native and stop at 1', () => {
  const h = harness({ renderScale: 0.62 });
  h.run(1 / 90, 40);
  assert.equal(+h.engine.renderScale.toFixed(2), 1, 'a fast GPU must recover full resolution');
  const atTop = h.resizes;
  h.run(1 / 90, 20);
  assert.equal(h.resizes, atTop, 'a scaler at native must stop calling resize');
});

test('a frame rate between the thresholds is left alone', () => {
  // 55 fps sits above the 1/57 recovery bar and below the 1/52 descent bar.
  const h = harness({ renderScale: 0.8 });
  h.run(1 / 55, 30);
  assert.equal(+h.engine.renderScale.toFixed(2), 0.8, 'the dead band must not oscillate');
  assert.equal(h.resizes, 0);
});

test('occlusion and stalls cannot pin the scaler', () => {
  // Chrome throttles rAF for a covered window without setting document.hidden,
  // so both guards matter and neither alone is enough.
  const stalled = harness();
  stalled.run(0.9, 30);
  assert.equal(stalled.engine.renderScale, 1, 'quarter-second-plus samples must be rejected');

  const backgrounded = harness({ hidden: true });
  backgrounded.run(1 / 24, 30);
  assert.equal(backgrounded.engine.renderScale, 1, 'a hidden document must not adapt');
});

test('the floor still leaves a usable share of the pixels', () => {
  // 0.62 linear is 38% of the pixels. Below roughly a third, upscaled 1080p
  // stops reading as soft and starts reading as broken, which is why the floor
  // is a floor rather than an unbounded descent.
  const h = harness();
  h.run(1 / 10, 60);
  const share = h.engine.renderScale ** 2;
  assert.ok(share > 0.33, `floor keeps ${(share * 100).toFixed(0)}% of the pixels`);
});


test('render forwards the unclamped frame time to the scaler', () => {
  // The guard above only works if _adapt actually receives the long sample.
  // main.js clamps dt to 0.1 s so a tab switch cannot teleport the aircraft
  // through a mountain, and that clamp used to be applied *before* render() —
  // so _adapt never saw a value above 0.1 and its 0.25 s spike guard was dead
  // code. Every test here called _adapt directly, so the suite passed while the
  // shipped path was broken. This is the case that was missing.
  const engine = Object.create(Engine.prototype);
  const seen = [];
  engine._adapt = (value) => { seen.push(value); };
  engine.finishPass = {};
  engine.composer = { passes: [], render() {}, stableDepthTexture: null };
  engine.syncDepthTexture = () => false;
  engine._postSettled = true;
  Engine.prototype.render.call(engine, 0.1, 1.0);
  assert.deepEqual(seen, [1.0], 'the scaler must see the raw delta, not the simulation clamp');
});

console.log('adaptive scale contracts passed');
