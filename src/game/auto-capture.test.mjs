import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { matchMedia: () => ({ matches: false }) };
globalThis.document ??= {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
    toBlob() {},
  }),
};

const { Game } = await import('./Game.js');
const { CAPTURE_THRESHOLD } = await import('./ReconCamera.js');

const STEP = 1 / 60;

/**
 * A Game reduced to what the auto-capture controller touches. `shots` records
 * the score at the moment the shutter fired, which is the thing under test:
 * the controller is supposed to release near the peak of a pass, not on the
 * first frame that clears the threshold.
 */
function makeCamera({ cooldown = 0 } = {}) {
  const shots = [];
  const post = { callsign: 'RAVEN', captured: false };
  const evaluation = { post, inFrame: true, score: 0 };
  let pressed = false;

  const game = Object.create(Game.prototype);
  Object.assign(game, {
    evaluation,
    recon: { shutterCooldown: cooldown },
    input: {
      consumePress: () => {
        const was = pressed;
        pressed = false;
        return was;
      },
    },
    _autoDwell: 0,
    _autoPeak: 0,
    _autoPost: null,
    // Stands in for the real _takePhoto, and must reproduce the two
    // post-conditions the controller depends on: ReconCamera.capture parks a
    // 0.55s shutter cooldown, and a shot at or above the threshold secures the
    // post, after which _evaluateBest stops offering it. Without both, the
    // fixture lets a single pass fire twice and the test measures nothing.
    _takePhoto: (ev) => {
      shots.push(ev.score);
      game.recon.shutterCooldown = 0.55;
      if (ev.score >= CAPTURE_THRESHOLD) ev.post.captured = true;
    },
  });

  // The real loop decays the cooldown in recon.update() before the controller
  // runs, so the fixture does the same.
  const step = () => {
    game.recon.shutterCooldown = Math.max(0, game.recon.shutterCooldown - STEP);
    game._updateAutoCapture(STEP);
  };

  return {
    game,
    shots,
    post,
    press: () => { pressed = true; },
    /** Hold a framing for `seconds`. */
    hold: (score, seconds) => {
      evaluation.score = score;
      for (let t = 0; t < seconds - 1e-9; t += STEP) step();
    },
    frame: (score) => {
      evaluation.score = score;
      step();
    },
    setFramed: (value) => { evaluation.inFrame = value; },
    setPost: (next) => { evaluation.post = next; },
    setEvaluation: (next) => { game.evaluation = next; },
  };
}

test('a framing below the capture threshold never trips the shutter', () => {
  const c = makeCamera();
  c.hold(CAPTURE_THRESHOLD - 0.01, 5);
  assert.deepEqual(c.shots, []);
});

test('a single frame grazing the threshold mid-slew is not a capture', () => {
  const c = makeCamera();
  c.hold(0.2, 0.5);
  c.frame(0.9);
  c.hold(0.2, 0.5);
  assert.deepEqual(c.shots, [], 'the dwell floor exists for exactly this');
});

test('the shutter waits for the peak of a pass rather than the first crossing', () => {
  const c = makeCamera();
  // A realistic pass: the score climbs as the target centres, peaks, then falls
  // away as the aircraft overflies it.
  const peak = 0.72;
  for (let i = 0; i <= 40; i++) c.frame(peak - Math.abs(i - 20) * 0.012);

  assert.equal(c.shots.length, 1, 'exactly one plate per site');
  assert.ok(
    c.shots[0] > peak - 0.05,
    `fired at ${c.shots[0]}, expected within 0.05 of the ${peak} peak`,
  );
  assert.ok(
    c.shots[0] > CAPTURE_THRESHOLD + 0.15,
    'firing on the first crossing would have banked a barely-usable plate',
  );
});

test('a framing good enough to stop gambling on fires without waiting for a turn', () => {
  const c = makeCamera();
  c.hold(0.9, 0.3);
  assert.equal(c.shots.length, 1);
  assert.equal(c.shots[0], 0.9);
});

test('a perfectly steady hold still resolves instead of waiting forever', () => {
  const c = makeCamera();
  c.hold(0.6, 1.0);
  assert.deepEqual(c.shots, [], 'still holding out for an improvement');
  c.hold(0.6, 0.6);
  assert.equal(c.shots.length, 1, 'the dwell ceiling releases it');
});

test('losing the framing resets the hold', () => {
  const c = makeCamera();
  c.hold(0.6, 1.0);
  c.setFramed(false);
  c.frame(0.6);
  c.setFramed(true);
  c.hold(0.6, 1.0);
  assert.deepEqual(c.shots, [], 'the dwell restarted, so the ceiling has not been reached');
});

test('an already secured post is not photographed again', () => {
  const c = makeCamera();
  c.post.captured = true;
  c.hold(0.95, 5);
  assert.deepEqual(c.shots, []);
});

test('Enter still fires immediately, including on a deliberately weak frame', () => {
  const c = makeCamera();
  c.press();
  c.frame(0.12);
  assert.deepEqual(c.shots, [0.12], 'the manual shutter is how a poor plate is kept on purpose');
});

test('a press during the shutter cooldown is spent, not buffered', () => {
  // Score stays well below the threshold so nothing but the press could fire,
  // which is what isolates the buffering question from the auto path.
  const c = makeCamera({ cooldown: 0.5 });
  c.press();
  c.frame(0.1);
  assert.deepEqual(c.shots, [], 'blocked by the cooldown');

  c.hold(0.1, 1.0);
  assert.deepEqual(c.shots, [], 'and does not resurface once the cooldown expires');
});

test('the hold belongs to a site, not to the camera', () => {
  const c = makeCamera();
  const second = { callsign: 'SLATE', captured: false };

  // Bank a long hold on the first post, stopping short of the dwell ceiling.
  c.hold(0.6, 1.0);
  assert.deepEqual(c.shots, []);

  // A different post comes into frame and wins the evaluation. It must start
  // its own hold: inheriting the first post's dwell and peak would photograph
  // it after one frame, at a score that was never its own peak.
  c.setPost(second);
  c.frame(0.6);
  c.frame(0.6);
  assert.deepEqual(c.shots, [], 'a new site does not inherit the previous hold');

  // And it still fires on its own merits once it has held long enough.
  c.hold(0.6, 1.5);
  assert.equal(c.shots.length, 1);
});

test('losing the target entirely clears the hold', () => {
  const c = makeCamera();
  c.hold(0.6, 1.0);
  c.setEvaluation(null);
  c.game._updateAutoCapture(STEP);
  assert.equal(c.game._autoDwell, 0);
  assert.equal(c.game._autoPeak, 0);
  assert.equal(c.game._autoPost, null);
});
