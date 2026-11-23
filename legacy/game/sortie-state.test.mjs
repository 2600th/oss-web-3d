import assert from 'node:assert/strict';
import { acceptsLaunchKey } from './sortieState.js';

// Enter is the manual shutter for the whole flight. When the sortie ended, the
// same key restarted it — discarding the contact sheet and a leaderboard time
// the player had not entered a callsign for yet.
assert.equal(acceptsLaunchKey('briefing'), true, 'the briefing is where Enter starts a sortie');
assert.equal(acceptsLaunchKey('complete'), false, 'a completed sortie must survive the shutter key');
assert.equal(acceptsLaunchKey('failed'), false, 'a failed sortie must survive the shutter key');

for (const state of ['title', 'flying', 'paused']) {
  assert.equal(acceptsLaunchKey(state), false, `${state} must not launch on Enter`);
}

console.log('sortie state key contracts passed');
