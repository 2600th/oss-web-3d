import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Leaderboard,
  LEADERBOARD_KEY,
  LAST_NAME_KEY,
  MAX_ENTRIES,
  formatDuration,
  insertEntry,
  isRankable,
  sanitiseName,
} from './Leaderboard.js';

/** A Storage-shaped object that can be told to misbehave the way real ones do. */
function fakeStore({ failReads = false, failWrites = false, seed = {} } = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(key) {
      if (failReads) throw new Error('storage disabled');
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (failWrites) throw new Error('quota exceeded');
      data.set(key, value);
    },
  };
}

const run = (name, seconds, at = 1000) => ({ name, seconds, grade: 'GOOD', objectives: '5/5', at });

test('callsigns are normalised, and unusable ones are rejected rather than replaced', () => {
  assert.equal(sanitiseName('raven'), 'RAVEN');
  assert.equal(sanitiseName('  two   words  '), 'TWO WORDS', 'whitespace collapses');
  assert.equal(sanitiseName('a.b_c-1'), 'A.B_C-1');

  assert.equal(sanitiseName('ab'), null, 'too short');
  assert.equal(sanitiseName('a'.repeat(13)), null, 'too long');
  assert.equal(sanitiseName('   '), null);
  assert.equal(sanitiseName('rav<script>'), null, 'punctuation outside the allowed set');
  assert.equal(sanitiseName(undefined), null);
  assert.equal(sanitiseName(42), null);
});

test('only a sortie that secured every objective can rank', () => {
  assert.equal(isRankable({ captured: 5, total: 5, seconds: 300 }), true);
  // Otherwise "least time" is won by taking off and landing again.
  assert.equal(isRankable({ captured: 4, total: 5, seconds: 12 }), false);
  assert.equal(isRankable({ captured: 0, total: 5, seconds: 3 }), false);

  assert.equal(isRankable({ captured: 5, total: 5, seconds: 0 }), false);
  assert.equal(isRankable({ captured: 5, total: 5, seconds: NaN }), false);
  assert.equal(isRankable({ captured: 0, total: 0, seconds: 300 }), false);
  assert.equal(isRankable(null), false);
});

test('durations read as a stopwatch', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(9), '0:09');
  assert.equal(formatDuration(372), '6:12');
  assert.equal(formatDuration(372.9), '6:12', 'seconds floor, they do not round up');
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3671), '1:01:11');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(NaN), '—');
});

test('the board ranks fastest first and ties go to whoever got there earlier', () => {
  const { entries } = insertEntry(
    [run('SLOW', 400, 10), run('FAST', 200, 10)],
    run('TIED', 200, 5),
  );
  assert.deepEqual(entries.map((e) => e.name), ['TIED', 'FAST', 'SLOW']);
});

test('a callsign holds one row, its best', () => {
  let board = [run('RAVEN', 400, 1)];

  const slower = insertEntry(board, run('RAVEN', 500, 2));
  assert.equal(slower.entries.length, 1, 'a worse run is not a second row');
  assert.equal(slower.entries[0].seconds, 400, 'and does not overwrite the better one');
  assert.equal(slower.improved, false);
  assert.equal(slower.rank, 1, 'the pilot still holds their place');

  const faster = insertEntry(slower.entries, run('RAVEN', 300, 3));
  assert.equal(faster.entries.length, 1);
  assert.equal(faster.entries[0].seconds, 300);
  assert.equal(faster.improved, true);
  assert.equal(faster.rank, 1);

  // Without this rule one player with an afternoon fills all ten places.
  board = faster.entries;
  for (let i = 0; i < 20; i++) board = insertEntry(board, run('RAVEN', 300 - i, i)).entries;
  assert.equal(board.length, 1);
});

test('the board keeps ten and reports when a run missed the cut', () => {
  let entries = [];
  for (let i = 0; i < MAX_ENTRIES; i++) {
    entries = insertEntry(entries, run(`P${i}`, 100 + i, i)).entries;
  }
  assert.equal(entries.length, MAX_ENTRIES);

  const missed = insertEntry(entries, run('LATE', 9999, 99));
  assert.equal(missed.entries.length, MAX_ENTRIES);
  assert.equal(missed.rank, null, 'a run outside the top ten has no rank');
  assert.equal(missed.improved, false);
  assert.equal(missed.entries.some((e) => e.name === 'LATE'), false);

  const made = insertEntry(entries, run('QUICK', 1, 99));
  assert.equal(made.rank, 1);
  assert.equal(made.entries.length, MAX_ENTRIES, 'and pushes the slowest off the bottom');
  assert.equal(made.entries.some((e) => e.name === 'P9'), false);
});

test('submitting persists the board and remembers the callsign', () => {
  const store = fakeStore();
  const board = new Leaderboard(store);
  assert.deepEqual(board.read(), []);
  assert.equal(board.lastName(), '');
  assert.equal(board.best(), null);

  const result = board.submit({ name: 'raven', seconds: 372, grade: 'GOOD', objectives: '5/5', at: 7 });
  assert.equal(result.rank, 1);
  assert.equal(result.improved, true);

  const reloaded = new Leaderboard(store);
  assert.deepEqual(reloaded.read().map((e) => [e.name, e.seconds]), [['RAVEN', 372]]);
  assert.equal(reloaded.lastName(), 'RAVEN', 'the field arrives prefilled next time');
  assert.equal(reloaded.best().seconds, 372);
});

test('a submission with an unusable callsign or time changes nothing', () => {
  const store = fakeStore();
  const board = new Leaderboard(store);
  board.submit({ name: 'RAVEN', seconds: 300, at: 1 });

  for (const bad of [
    { name: 'x', seconds: 100, at: 2 },
    { name: 'VALID', seconds: 0, at: 2 },
    { name: 'VALID', seconds: NaN, at: 2 },
    null,
  ]) {
    const result = board.submit(bad);
    assert.equal(result.rank, null);
    assert.equal(result.improved, false);
  }
  assert.deepEqual(board.read().map((e) => e.name), ['RAVEN']);
});

test('a corrupt or hostile store degrades to an empty board, never an exception', () => {
  assert.deepEqual(new Leaderboard(fakeStore({ seed: { [LEADERBOARD_KEY]: '{not json' } })).read(), []);
  assert.deepEqual(new Leaderboard(fakeStore({ seed: { [LEADERBOARD_KEY]: '"a string"' } })).read(), []);
  assert.deepEqual(new Leaderboard(fakeStore({ seed: { [LEADERBOARD_KEY]: 'null' } })).read(), []);

  // Rows that survived a partial write are dropped, not rendered as undefined.
  const mixed = new Leaderboard(fakeStore({
    seed: { [LEADERBOARD_KEY]: JSON.stringify([run('OK', 100), { name: 'BAD' }, null, 7]) },
  }));
  assert.deepEqual(mixed.read().map((e) => e.name), ['OK']);

  // Safari in private mode throws on setItem; losing the board is acceptable,
  // losing the debrief screen is not.
  const readOnly = new Leaderboard(fakeStore({ failWrites: true }));
  assert.doesNotThrow(() => readOnly.submit({ name: 'RAVEN', seconds: 300, at: 1 }));

  const blind = new Leaderboard(fakeStore({ failReads: true }));
  assert.deepEqual(blind.read(), []);
  assert.equal(blind.lastName(), '');

  assert.doesNotThrow(() => new Leaderboard(null).read());
  assert.deepEqual(new Leaderboard(null).read(), []);
});

test('the stored callsign is sanitised on the way out, not trusted', () => {
  const board = new Leaderboard(fakeStore({ seed: { [LAST_NAME_KEY]: '  <bad>  ' } }));
  assert.equal(board.lastName(), '');
});
