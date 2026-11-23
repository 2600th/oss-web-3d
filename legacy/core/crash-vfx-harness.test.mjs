import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const gameSource = await readFile(new URL('../game/Game.js', import.meta.url), 'utf8');

test('the deterministic crash visual harness stays inside the DEV diagnostics block', () => {
  const marker = '// Development hooks. Not part of the gameplay path';
  const markerAt = mainSource.indexOf(marker);
  const devAt = mainSource.indexOf('if (import.meta.env.DEV) {', markerAt);
  const devBlock = mainSource.slice(devAt);
  assert.ok(markerAt >= 0 && devAt > markerAt, 'harness must live in the dedicated DEV block');
  assert.match(devBlock, /window\.__crashVfx\s*=\s*\{/);
  assert.match(gameSource, /flight\.checkTerrainCollision\(PHYSICS_STEP\)/);
  assert.match(devBlock, /game\.onCrash/);
  assert.match(mainSource, /game\.update\(dt\);[\s\S]*?engine\.render\(dt\);/);
  assert.doesNotMatch(
    mainSource.slice(0, devAt),
    /__crashVfx/,
  );
});

test('the crash harness exposes deterministic trigger, timeline, lifecycle and frame reports', () => {
  assert.match(mainSource, /__crashVfx\s*=\s*\{[\s\S]*?trigger\([\s\S]*?waitFor\([\s\S]*?status:\s*crashVfxStatus[\s\S]*?reset\(/);
  assert.match(mainSource, /dispatchCount/);
  assert.match(mainSource, /collisionAt/);
  assert.match(mainSource, /aircraftVisible/);
  assert.match(mainSource, /exhaustVisible/);
  assert.match(mainSource, /drawingBuffer/);
  assert.match(mainSource, /new URLSearchParams\(location\.search\)\.has\('crashVfx'\)/);
  assert.match(mainSource, /Trigger crash VFX/);
  assert.match(mainSource, /crash-vfx-status/);
  assert.match(mainSource, /JSON\.stringify\(crashVfxStatus\(\)\)/);
  assert.match(mainSource, /stepTo\(ageMs\)/);
  assert.match(mainSource, /game\.update\s*=\s*\(\)\s*=>\s*\{\}/);
  assert.match(mainSource, /\[0, 100, 300, 800, 1800\]/);
  assert.match(mainSource, /crashTier/);
});
