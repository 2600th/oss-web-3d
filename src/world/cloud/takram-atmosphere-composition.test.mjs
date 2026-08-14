import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Data3DTexture,
  DataTexture,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';

import { createTakramAtmosphereComposition } from './TakramAtmosphereComposition.js';

function texture2D() {
  return new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
}

function texture3D() {
  return new Data3DTexture(new Uint8Array([255]), 1, 1, 1);
}

test('composes the real Takram cloud outputs through aerial perspective once', () => {
  const camera = new PerspectiveCamera(58, 16 / 9, 4, 750000);
  camera.position.set(10, 20, 30);
  camera.updateMatrixWorld(true);
  const scene = new Scene();
  const clouds = new CloudsEffect(camera, { width: 16, height: 16 });
  const textures = {
    irradianceTexture: texture2D(),
    scatteringTexture: texture3D(),
    transmittanceTexture: texture2D(),
    singleMieScatteringTexture: texture3D(),
    higherOrderScatteringTexture: texture3D(),
    stbnTexture: texture3D(),
  };
  clouds.irradianceTexture = textures.irradianceTexture;
  clouds.scatteringTexture = textures.scatteringTexture;
  clouds.transmittanceTexture = textures.transmittanceTexture;
  clouds.singleMieScatteringTexture = textures.singleMieScatteringTexture;
  clouds.higherOrderScatteringTexture = textures.higherOrderScatteringTexture;
  clouds.stbnTexture = textures.stbnTexture;
  clouds.ellipsoid.getNorthUpEastFrame(
    new Vector3(clouds.ellipsoid.radii.x, 0, 0),
    clouds.worldToECEFMatrix,
  );
  clouds.sunDirection.set(0.2, 0.3, 0.4).normalize();
  clouds.skipRendering = false;

  const originalCloudDispose = clouds.dispose.bind(clouds);
  let cloudDisposeCount = 0;
  clouds.dispose = () => { cloudDisposeCount += 1; };
  const externalTextureDisposeCounts = new Map();
  for (const texture of Object.values(textures)) {
    texture.dispose = () => {
      externalTextureDisposeCounts.set(texture, (externalTextureDisposeCounts.get(texture) ?? 0) + 1);
    };
  }

  const composition = createTakramAtmosphereComposition({
    camera,
    scene,
    clouds,
    textures,
    renderer: {},
  });

  assert.equal(clouds.skipRendering, true, 'cloud color must be composited only by aerial perspective');
  assert.equal(composition.effects[0], clouds);
  assert.ok(composition.effects[1] instanceof AerialPerspectiveEffect);
  assert.deepEqual(composition.passes, [], 'pre-lit terrain needs no normal pass');
  const aerial = composition.effects[1];
  assert.equal(aerial.sunLight, false);
  assert.equal(aerial.skyLight, false);
  assert.equal(aerial.sky, false);
  assert.equal(aerial.transmittance, true);
  assert.equal(aerial.inscatter, true);
  assert.equal(aerial.ellipsoid, clouds.ellipsoid);
  assert.deepEqual(aerial.worldToECEFMatrix.elements, clouds.worldToECEFMatrix.elements);
  assert.deepEqual(aerial.sunDirection.toArray(), clouds.sunDirection.toArray());
  assert.equal(aerial.irradianceTexture, clouds.irradianceTexture);
  assert.equal(aerial.scatteringTexture, clouds.scatteringTexture);
  assert.equal(aerial.transmittanceTexture, clouds.transmittanceTexture);
  assert.equal(aerial.singleMieScatteringTexture, clouds.singleMieScatteringTexture);
  assert.equal(aerial.higherOrderScatteringTexture, clouds.higherOrderScatteringTexture);
  assert.equal(aerial.stbnTexture, clouds.stbnTexture);

  const overlay = { map: texture2D() };
  const shadow = { map: texture2D(), mapSize: { x: 1, y: 1 }, cascadeCount: 1,
    intervals: [], matrices: [], inverseMatrices: [], far: 1, topHeight: 1 };
  const shadowLength = { map: texture2D() };
  clouds._atmosphereOverlay = overlay;
  clouds._atmosphereShadow = shadow;
  clouds._atmosphereShadowLength = shadowLength;
  clouds.events.dispatchEvent({ type: 'change', property: 'atmosphereOverlay' });
  clouds.events.dispatchEvent({ type: 'change', property: 'atmosphereShadow' });
  clouds.events.dispatchEvent({ type: 'change', property: 'atmosphereShadowLength' });

  assert.equal(aerial.overlay, overlay);
  assert.equal(aerial.shadow, shadow);
  assert.equal(aerial.shadowLength, shadowLength);
  assert.deepEqual(composition.getResourceReport(), {
    owner: 'takram-atmosphere-composition',
    resources: [],
    totalBytes: 0,
  });

  let aerialDisposeCount = 0;
  aerial.dispose = () => { aerialDisposeCount += 1; };
  composition.dispose();
  composition.dispose();

  assert.equal(clouds.skipRendering, false, 'disposal restores the prior direct-render setting');
  assert.equal(aerialDisposeCount, 1, 'the owned aerial effect is disposed once');
  assert.equal(cloudDisposeCount, 0, 'the adapter-owned clouds effect stays alive');
  assert.deepEqual([...externalTextureDisposeCounts.values()], [], 'harness textures stay externally owned');
  clouds._atmosphereOverlay = { map: texture2D() };
  clouds.events.dispatchEvent({ type: 'change', property: 'atmosphereOverlay' });
  assert.equal(aerial.overlay, overlay, 'disposal removes the cloud change listener');

  const replacement = createTakramAtmosphereComposition({ camera, scene, clouds, textures, renderer: {} });
  assert.equal(clouds.skipRendering, true, 'a replacement still owns the single compositing path');
  replacement.dispose();
  assert.equal(clouds.skipRendering, false, 'replacement disposal restores its own prior setting');

  clouds.dispose = originalCloudDispose;
  clouds.dispose();
});
