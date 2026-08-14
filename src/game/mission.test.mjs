import assert from 'node:assert/strict';
import * as missionModule from './Mission.js';
import { Mission } from './Mission.js';
import * as THREE from 'three';

assert.equal(typeof missionModule.findPostSites, 'function', 'mission site search needs a count contract');

function missionWithPosts() {
  const mission = Object.create(Mission.prototype);
  mission.targetIndex = 1;
  mission.posts = [
    { id: 'A', captured: false },
    { id: 'B', captured: false },
    { id: 'C', captured: false },
  ];
  return mission;
}

{
  const mission = missionWithPosts();
  assert.equal(mission.target.id, 'B');
  mission.posts[0].captured = true;
  assert.equal(mission.target.id, 'B', 'capturing an earlier post must not silently retarget the HUD');
  mission.cycleTarget(1);
  assert.equal(mission.target.id, 'C');
}

for (const [x, z] of [[21000, 6000], [-180000, 220000], [420000, -390000], [0, 0]]) {
  const sites = missionModule.findPostSites(new THREE.Vector3(x, 0, z), 6);
  assert.equal(sites.length, 6, `mission at ${x},${z} must retain every requested objective`);
  assert.equal(new Set(sites.map((site) => `${site.position.x},${site.position.z}`)).size, 6, 'objectives must be distinct');
}

console.log('mission target identity contracts passed');
