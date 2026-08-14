import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Texture } from 'three';

import {
  TAKRAM_CLOUD_ASSET_MANIFEST,
  disposeTakramCloudAssets,
  loadOfficialTakramCloudAssets,
  validateTakramCloudAssetBytes,
} from './TakramCloudAssets.js';

const PACKAGE_ASSET_ROOT = new URL('../../../node_modules/@takram/three-clouds/assets/', import.meta.url);
const PUBLIC_ASSET_ROOT = new URL('../../../public/cloud-comparison/takram/', import.meta.url);

const EXPECTED_MANIFEST = {
  localWeather: {
    file: 'local_weather.png', kind: 'png', width: 512, height: 512,
    bytes: 679_653,
    sha256: 'B84DAEF855DC5EEBCC9B174FE832BA75A98E44B846DDE201BCE354417CC08031',
  },
  shape: {
    file: 'shape.bin', kind: 'r8-volume', width: 128, height: 128, depth: 128,
    bytes: 2_097_152,
    sha256: 'EF65CF6156894720C00BF572C49E3E254F8899C4B5158246E5A35A1922E2519C',
  },
  shapeDetail: {
    file: 'shape_detail.bin', kind: 'r8-volume', width: 32, height: 32, depth: 32,
    bytes: 32_768,
    sha256: 'C09112199C6E0281B74FF5283C11C2943AE082650B9B67978CF5D59ED2956E4F',
  },
  turbulence: {
    file: 'turbulence.png', kind: 'png', width: 128, height: 128,
    bytes: 49_691,
    sha256: 'EC2B1B0AF4A6A6104102B21E58BEB300B0A3D334C0281D84FDE8C91D322910F9',
  },
};

test('asset manifest pins the exact Takram 0.7.6 cloud files', () => {
  assert.deepEqual(TAKRAM_CLOUD_ASSET_MANIFEST, EXPECTED_MANIFEST);
});

test('committed comparison assets exactly match the pinned Takram package fixtures', async () => {
  for (const [name, entry] of Object.entries(EXPECTED_MANIFEST)) {
    const packageBytes = new Uint8Array(await readFile(new URL(entry.file, PACKAGE_ASSET_ROOT)));
    const publicBytes = new Uint8Array(await readFile(new URL(entry.file, PUBLIC_ASSET_ROOT)));
    assert.deepEqual(publicBytes, packageBytes, `${entry.file} differs from @takram/three-clouds@0.7.6`);
    await validateTakramCloudAssetBytes(name, publicBytes);
  }
});

test('validator accepts pinned package bytes and rejects corruption', async () => {
  for (const [name, entry] of Object.entries(EXPECTED_MANIFEST)) {
    const bytes = new Uint8Array(await readFile(new URL(entry.file, PACKAGE_ASSET_ROOT)));
    const result = await validateTakramCloudAssetBytes(name, bytes);
    assert.deepEqual(result, { name, bytes: entry.bytes, sha256: entry.sha256 });

    const corrupted = bytes.slice();
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    await assert.rejects(
      validateTakramCloudAssetBytes(name, corrupted),
      new RegExp(`Takram cloud asset ${name} SHA-256 mismatch`),
    );
  }
  await assert.rejects(
    validateTakramCloudAssetBytes('missing', new Uint8Array()),
    /Unknown Takram cloud asset/,
  );
});

test('validator identifies missing, wrong-sized, and wrong-hash files as ineligible reference assets', async () => {
  const source = new Uint8Array(await readFile(
    new URL(EXPECTED_MANIFEST.localWeather.file, PACKAGE_ASSET_ROOT),
  ));
  await assert.rejects(
    validateTakramCloudAssetBytes('missing', new Uint8Array()),
    error => error?.code === 'ineligible-reference',
  );
  await assert.rejects(
    validateTakramCloudAssetBytes('localWeather', source.subarray(0, source.byteLength - 1)),
    error => error?.code === 'ineligible-reference',
  );
  const corrupted = source.slice();
  corrupted[0] ^= 0xff;
  await assert.rejects(
    validateTakramCloudAssetBytes('localWeather', corrupted),
    error => error?.code === 'ineligible-reference',
  );
});

test('loader decodes each PNG from the exact validated Blob payload and revokes its object URL', async () => {
  const source = new Map();
  for (const entry of Object.values(EXPECTED_MANIFEST)) {
    source.set(entry.file, new Uint8Array(await readFile(new URL(entry.file, PACKAGE_ASSET_ROOT))));
  }
  const blobs = new Map();
  const createdUrls = [];
  const revokedUrls = [];
  const decodedPayloads = [];
  const objectUrl = {
    createObjectURL(blob) {
      const url = `blob:validated-takram-${createdUrls.length}`;
      blobs.set(url, blob);
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };
  const textureLoader = {
    load(url, onLoad, _onProgress, onError) {
      const blob = blobs.get(url);
      if (blob == null) {
        queueMicrotask(() => onError(new Error('a second network URL supplied different PNG bytes')));
        return new Texture();
      }
      const entry = Object.values(EXPECTED_MANIFEST).find(item => item.bytes === blob.size);
      const texture = new Texture({ width: entry.width, height: entry.height });
      void blob.arrayBuffer()
        .then(buffer => {
          decodedPayloads.push(new Uint8Array(buffer));
          onLoad(texture);
        })
        .catch(onError);
      return texture;
    },
  };

  const assets = await loadOfficialTakramCloudAssets({
    loadBytes: async url => source.get(url.split('/').at(-1)).slice(),
    textureLoader,
    objectUrl,
  });

  assert.deepEqual(decodedPayloads, [source.get('local_weather.png'), source.get('turbulence.png')]);
  assert.deepEqual(revokedUrls, createdUrls);
  disposeTakramCloudAssets(assets);
});

test('loader revokes a validated Blob URL when TextureLoader decoding fails', async () => {
  const source = new Map();
  for (const entry of Object.values(EXPECTED_MANIFEST)) {
    source.set(entry.file, new Uint8Array(await readFile(new URL(entry.file, PACKAGE_ASSET_ROOT))));
  }
  const createdUrls = [];
  const revokedUrls = [];
  const objectUrl = {
    createObjectURL() {
      const url = `blob:validated-takram-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };

  await assert.rejects(
    loadOfficialTakramCloudAssets({
      loadBytes: async url => source.get(url.split('/').at(-1)).slice(),
      objectUrl,
      textureLoader: {
        load(_url, _onLoad, _onProgress, onError) {
          const placeholder = new Texture();
          queueMicrotask(() => onError(new Error('decoder rejected validated payload')));
          return placeholder;
        },
      },
    }),
    /decoder rejected validated payload/,
  );
  assert.equal(createdUrls.length, 1);
  assert.deepEqual(revokedUrls, createdUrls);
});

test('loader configures official textures and disposal releases each exactly once', async () => {
  const source = new Map();
  for (const entry of Object.values(EXPECTED_MANIFEST)) {
    source.set(entry.file, new Uint8Array(await readFile(new URL(entry.file, PACKAGE_ASSET_ROOT))));
  }
  const decodedPngs = [];
  const assets = await loadOfficialTakramCloudAssets({
    loadBytes: async url => source.get(url.split('/').at(-1)).slice(),
    objectUrl: {
      createObjectURL(blob) { return `blob:fixture-${blob.size}`; },
      revokeObjectURL() {},
    },
    textureLoader: {
      load(url, onLoad) {
        const entry = Object.values(EXPECTED_MANIFEST)
          .find(item => url === `blob:fixture-${item.bytes}`);
        const texture = new Texture({ width: entry.width, height: entry.height });
        decodedPngs.push(texture);
        queueMicrotask(() => onLoad(texture));
        return texture;
      },
    },
  });

  assert.equal(assets.mode, 'official-pinned');
  assert.deepEqual(assets.payloadBytes, 2_859_264);
  assert.strictEqual(assets.localWeatherTexture, decodedPngs[0]);
  assert.strictEqual(assets.turbulenceTexture, decodedPngs[1]);
  assert.equal(assets.shapeTexture.isData3DTexture, true);
  assert.deepEqual(
    [assets.shapeTexture.image.width, assets.shapeTexture.image.height, assets.shapeTexture.image.depth],
    [128, 128, 128],
  );
  assert.equal(assets.shapeDetailTexture.image.depth, 32);
  assert.equal(assets.textures.every(texture => texture.version > 0), true);

  const disposeCounts = new Map(assets.textures.map(texture => [texture, 0]));
  for (const texture of assets.textures) {
    texture.addEventListener('dispose', () => {
      disposeCounts.set(texture, disposeCounts.get(texture) + 1);
    });
  }
  disposeTakramCloudAssets(assets);
  disposeTakramCloudAssets(assets);
  assert.equal([...disposeCounts.values()].every(count => count === 1), true);
});

test('loader does not invoke the TextureLoader until every official asset validates', async () => {
  const source = new Map();
  for (const entry of Object.values(EXPECTED_MANIFEST)) {
    source.set(entry.file, new Uint8Array(await readFile(new URL(entry.file, PACKAGE_ASSET_ROOT))));
  }
  source.get('shape.bin')[0] ^= 0xff;
  let objectUrlCalls = 0;
  let textureLoaderCalls = 0;

  await assert.rejects(
    loadOfficialTakramCloudAssets({
      loadBytes: async url => source.get(url.split('/').at(-1)).slice(),
      objectUrl: {
        createObjectURL() {
          objectUrlCalls += 1;
          return 'blob:must-not-decode';
        },
        revokeObjectURL() {},
      },
      textureLoader: {
        load() {
          textureLoaderCalls += 1;
          return new Texture();
        },
      },
    }),
    /Takram cloud asset shape SHA-256 mismatch/,
  );
  assert.equal(objectUrlCalls, 0);
  assert.equal(textureLoaderCalls, 0);
});
