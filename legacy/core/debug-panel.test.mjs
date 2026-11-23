import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldToggleDebug } from './debugPanel.js';

const mainSource = await readFile(new URL('../main.js', import.meta.url), 'utf8');

const press = (over = {}) => ({
  code: 'Backquote',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  ...over,
});

test('tilde toggles the panel, on the physical key and without modifiers', () => {
  assert.equal(shouldToggleDebug(press()), true);
  assert.equal(shouldToggleDebug(press({ shiftKey: true })), true, 'shifted ~ is the same key');

  assert.equal(shouldToggleDebug(press({ code: 'Digit1' })), false);
  assert.equal(shouldToggleDebug(press({ ctrlKey: true })), false);
  assert.equal(shouldToggleDebug(press({ metaKey: true })), false);
  assert.equal(shouldToggleDebug(press({ altKey: true })), false);
  assert.equal(shouldToggleDebug(null), false);
});

test('a tilde typed into a text field stays a tilde', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(shouldToggleDebug(press({ target: { tagName } })), false, tagName);
  }
  assert.equal(
    shouldToggleDebug(press({ target: { tagName: 'DIV', isContentEditable: true } })),
    false,
  );
  assert.equal(
    shouldToggleDebug(press({ target: { tagName: 'DIV', isContentEditable: false } })),
    true,
  );
});

test('the panel ships outside DEV, starts hidden, and still honours ?debug', () => {
  // Creating it unconditionally is the point: the frame rate, render scale and
  // auto-selected tier are the first things a performance report needs, and a
  // player cannot be asked to build from source to read them.
  assert.match(mainSource, /const debug = document\.createElement\('div'\)/);
  assert.doesNotMatch(mainSource, /import\.meta\.env\.DEV \? document\.createElement/);

  // Hidden until asked for: #debug is display:none and only .show reveals it,
  // so no class at construction means no panel.
  assert.doesNotMatch(mainSource, /debug\.classList\.add\('show'\);\s*\n\s*window\.addEventListener/);
  assert.match(mainSource, /has\('debug'\)\) debug\.classList\.add\('show'\)/);

  assert.match(mainSource, /shouldToggleDebug\(event\)\) debug\.classList\.toggle\('show'\)/);
  assert.match(mainSource, /window\.addEventListener\('keydown', onDebugKey\)/);

  // Both teardown paths drop the listener: the boot-failure early return and
  // the normal page-lifecycle dispose.
  const removals = mainSource.match(/window\.removeEventListener\('keydown', onDebugKey\)/g) ?? [];
  assert.equal(removals.length, 2);

  // Free while hidden -- the per-frame text build stays behind the class check.
  assert.match(mainSource, /if \(debug\.classList\.contains\('show'\)\) \{/);
});
