import test from 'node:test';
import assert from 'node:assert/strict';

import { Settings } from './Settings.js';

const V1_KEY = 'safed-sagar.settings.v1';
const V2_KEY = 'safed-sagar.settings.v2';

function makeStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function useStorage(entries) {
  globalThis.localStorage = makeStorage(entries);
  return globalThis.localStorage;
}

test('fresh settings default to assisted controls', () => {
  useStorage();

  const fresh = new Settings();

  assert.equal(fresh.controlMode, 'assisted');
  assert.equal(fresh.controlSensitivity, 'normal');
  assert.equal(fresh.autoThrottle, true);
  assert.equal(fresh.verticalMode, 'upToClimb');
  assert.equal(fresh.assistedNoticeSeen, false);
});

test('legacy settings migrate quality, volume, and pitch direction to v2', () => {
  const storage = useStorage({
    [V1_KEY]: JSON.stringify({
      tierName: 'medium',
      masterVolume: 0.37,
      musicVolume: 0.61,
      invertPitch: true,
    }),
  });

  const migrated = new Settings();
  const savedV2 = JSON.parse(storage.getItem(V2_KEY));

  assert.equal(migrated.tierName, 'medium');
  assert.equal(migrated.masterVolume, 0.37);
  assert.equal(migrated.musicVolume, 0.61);
  assert.equal(migrated.verticalMode, 'upToDive');
  assert.equal(savedV2.verticalMode, 'upToDive');
  assert.equal('invertPitch' in savedV2, false);
});

test('v2 settings win when legacy and current records both exist', () => {
  useStorage({
    [V1_KEY]: JSON.stringify({
      tierName: 'low',
      masterVolume: 0.2,
      musicVolume: 0.3,
      invertPitch: true,
    }),
    [V2_KEY]: JSON.stringify({
      tierName: 'high',
      masterVolume: 0.91,
      musicVolume: 0.82,
      controlMode: 'direct',
      controlSensitivity: 'high',
      autoThrottle: false,
      verticalMode: 'upToClimb',
      assistedNoticeSeen: true,
    }),
  });

  const settings = new Settings();

  assert.equal(settings.tierName, 'high');
  assert.equal(settings.masterVolume, 0.91);
  assert.equal(settings.musicVolume, 0.82);
  assert.equal(settings.controlMode, 'direct');
  assert.equal(settings.controlSensitivity, 'high');
  assert.equal(settings.autoThrottle, false);
  assert.equal(settings.verticalMode, 'upToClimb');
  assert.equal(settings.assistedNoticeSeen, true);
});

test('control setters accept only supported enums and booleans and persist notice acknowledgement', () => {
  const storage = useStorage();
  const settings = new Settings();

  settings.setControlMode('direct');
  settings.setControlSensitivity('low');
  settings.setAutoThrottle(false);
  settings.setVerticalMode('upToDive');
  settings.setAssistedNoticeSeen(true);
  settings.setControlMode('automatic');
  settings.setControlSensitivity('extreme');
  settings.setAutoThrottle('false');
  settings.setVerticalMode('inverted');
  settings.setAssistedNoticeSeen(1);

  const savedV2 = JSON.parse(storage.getItem(V2_KEY));
  assert.equal(settings.controlMode, 'direct');
  assert.equal(settings.controlSensitivity, 'low');
  assert.equal(settings.autoThrottle, false);
  assert.equal(settings.verticalMode, 'upToDive');
  assert.equal(settings.assistedNoticeSeen, true);
  assert.equal(savedV2.controlMode, 'direct');
  assert.equal(savedV2.controlSensitivity, 'low');
  assert.equal(savedV2.autoThrottle, false);
  assert.equal(savedV2.verticalMode, 'upToDive');
  assert.equal(savedV2.assistedNoticeSeen, true);
  assert.equal('invertPitch' in savedV2, false);
});
