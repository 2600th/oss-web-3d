import {
  Data3DTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  TextureLoader,
  UnsignedByteType,
} from 'three';

const ASSET_BASE_URL = '/cloud-comparison/takram/';

export const TAKRAM_CLOUD_ASSET_MANIFEST = Object.freeze({
  localWeather: Object.freeze({
    file: 'local_weather.png', kind: 'png', width: 512, height: 512,
    bytes: 679_653,
    sha256: 'B84DAEF855DC5EEBCC9B174FE832BA75A98E44B846DDE201BCE354417CC08031',
  }),
  shape: Object.freeze({
    file: 'shape.bin', kind: 'r8-volume', width: 128, height: 128, depth: 128,
    bytes: 2_097_152,
    sha256: 'EF65CF6156894720C00BF572C49E3E254F8899C4B5158246E5A35A1922E2519C',
  }),
  shapeDetail: Object.freeze({
    file: 'shape_detail.bin', kind: 'r8-volume', width: 32, height: 32, depth: 32,
    bytes: 32_768,
    sha256: 'C09112199C6E0281B74FF5283C11C2943AE082650B9B67978CF5D59ED2956E4F',
  }),
  turbulence: Object.freeze({
    file: 'turbulence.png', kind: 'png', width: 128, height: 128,
    bytes: 49_691,
    sha256: 'EC2B1B0AF4A6A6104102B21E58BEB300B0A3D334C0281D84FDE8C91D322910F9',
  }),
});

export class IneligibleTakramReferenceError extends Error {
  constructor(message, options) {
    super(`Ineligible Takram reference: ${message}`, options);
    this.name = 'IneligibleTakramReferenceError';
    this.code = 'ineligible-reference';
  }
}

function asIneligibleReferenceError(error) {
  if (error?.code === 'ineligible-reference') return error;
  const message = error instanceof Error ? error.message : String(error);
  return new IneligibleTakramReferenceError(message, { cause: error });
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

async function defaultLoadBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Takram cloud asset request failed (${response.status}): ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function loadPngTexture(textureLoader, url, entry) {
  return new Promise((resolve, reject) => {
    let placeholder = null;
    const disposePlaceholder = texture => {
      texture?.dispose?.();
      if (placeholder != null && placeholder !== texture) placeholder.dispose?.();
    };
    try {
      placeholder = textureLoader.load(url, texture => {
        const image = texture?.image;
        if (image?.width !== entry.width || image?.height !== entry.height) {
          disposePlaceholder(texture);
          reject(new IneligibleTakramReferenceError(
            `Takram cloud asset ${entry.file} image dimensions mismatch: expected ${entry.width}x${entry.height}, got ${image?.width ?? 0}x${image?.height ?? 0}`,
          ));
          return;
        }
        if (placeholder != null && placeholder !== texture) placeholder.dispose?.();
        resolve(texture);
      }, undefined, error => {
        placeholder?.dispose?.();
        reject(asIneligibleReferenceError(error));
      });
    } catch (error) {
      placeholder?.dispose?.();
      reject(asIneligibleReferenceError(error));
    }
  });
}

function configureRepeatedTexture(texture) {
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createVolume(bytes, entry) {
  const texture = new Data3DTexture(
    bytes,
    entry.width,
    entry.height,
    entry.depth,
  );
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export async function validateTakramCloudAssetBytes(name, bytes) {
  const entry = TAKRAM_CLOUD_ASSET_MANIFEST[name];
  if (entry == null) {
    throw new IneligibleTakramReferenceError(`Unknown Takram cloud asset: ${String(name)}`);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new IneligibleTakramReferenceError(`Takram cloud asset ${name} must be a Uint8Array`);
  }
  if (bytes.byteLength !== entry.bytes) {
    throw new IneligibleTakramReferenceError(
      `Takram cloud asset ${name} byte length mismatch: expected ${entry.bytes}, got ${bytes.byteLength}`,
    );
  }
  const actualHash = await sha256(bytes);
  if (actualHash !== entry.sha256) {
    throw new IneligibleTakramReferenceError(`Takram cloud asset ${name} SHA-256 mismatch`);
  }
  return { name, bytes: bytes.byteLength, sha256: actualHash };
}

export async function loadOfficialTakramCloudAssets({
  loadBytes = defaultLoadBytes,
  textureLoader = new TextureLoader(),
  baseUrl = ASSET_BASE_URL,
} = {}) {
  const loaded = new Map();
  const textures = [];
  try {
    await Promise.all(Object.entries(TAKRAM_CLOUD_ASSET_MANIFEST).map(async ([name, entry]) => {
      const bytes = await loadBytes(`${baseUrl}${entry.file}`);
      await validateTakramCloudAssetBytes(name, bytes);
      loaded.set(name, bytes);
    }));

    const localWeatherTexture = configureRepeatedTexture(await loadPngTexture(
      textureLoader,
      `${baseUrl}${TAKRAM_CLOUD_ASSET_MANIFEST.localWeather.file}`,
      TAKRAM_CLOUD_ASSET_MANIFEST.localWeather,
    ));
    textures.push(localWeatherTexture);
    const shapeTexture = createVolume(
      loaded.get('shape'),
      TAKRAM_CLOUD_ASSET_MANIFEST.shape,
    );
    textures.push(shapeTexture);
    const shapeDetailTexture = createVolume(
      loaded.get('shapeDetail'),
      TAKRAM_CLOUD_ASSET_MANIFEST.shapeDetail,
    );
    textures.push(shapeDetailTexture);
    const turbulenceTexture = configureRepeatedTexture(await loadPngTexture(
      textureLoader,
      `${baseUrl}${TAKRAM_CLOUD_ASSET_MANIFEST.turbulence.file}`,
      TAKRAM_CLOUD_ASSET_MANIFEST.turbulence,
    ));
    textures.push(turbulenceTexture);
    return {
      mode: 'official-pinned',
      localWeatherTexture,
      shapeTexture,
      shapeDetailTexture,
      turbulenceTexture,
      textures,
      payloadBytes: Object.values(TAKRAM_CLOUD_ASSET_MANIFEST)
        .reduce((total, entry) => total + entry.bytes, 0),
      disposed: false,
    };
  } catch (error) {
    for (const texture of new Set(textures)) texture.dispose?.();
    throw asIneligibleReferenceError(error);
  }
}

export function disposeTakramCloudAssets(assets) {
  if (assets == null || assets.disposed) return;
  assets.disposed = true;
  for (const texture of new Set(assets.textures ?? [])) texture.dispose();
}
