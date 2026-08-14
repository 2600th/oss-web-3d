import {
  DataTexture,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

export const REFERENCE_RAW_FULL_FAR_DEPTH_RESOURCE = 'reference-raw-full-far-depth';

/**
 * Takram's BasicDepthPacking path reads the red channel directly. A depth of
 * one is the far plane, so this owned diagnostic texture keeps a sky-only raw
 * reference from clamping its cloud ray to absent/black scene depth.
 */
export function createReferenceRawFullFarDepthTexture() {
  const texture = new DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType,
  );
  texture.name = REFERENCE_RAW_FULL_FAR_DEPTH_RESOURCE;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function describeReferenceRawFullFarDepthTexture(texture) {
  if (texture == null) return null;
  return {
    name: REFERENCE_RAW_FULL_FAR_DEPTH_RESOURCE,
    kind: 'diagnostic-depth-texture',
    source: 'reference-raw-full-far-basic-depth',
    owner: 'comparison-harness',
    width: 1,
    height: 1,
    layers: 1,
    mipLevels: 1,
    samples: 1,
    attachments: 1,
    bytes: 4,
  };
}
