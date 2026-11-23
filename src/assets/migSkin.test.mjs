// The MiG family's baked skin maps (tools/blender/build-mig-skin.mjs): every
// textured opaque material carries one occlusion / roughness / metalness
// texture, and the nodes the game animates are still there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function gltfJson(file) {
  const buf = readFileSync(fileURLToPath(new URL(`../../public/models/${file}`, import.meta.url)));
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file}: not a GLB`);
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
}

const FILES = ['mig21.glb', 'mig21_hostile.glb', 'mig21_hostile_lod1.glb', 'mig21-low.glb'];

for (const file of FILES) {
  test(`${file}: opaque textured materials carry a shared ORM texture`, () => {
    const g = gltfJson(file);
    let n = 0;
    for (const m of g.materials) {
      const pbr = m.pbrMetallicRoughness ?? {};
      if (!pbr.baseColorTexture || m.alphaMode === 'BLEND') continue;
      n++;
      assert.ok(m.occlusionTexture, `${file} ${m.name}: no occlusion texture`);
      assert.equal(m.occlusionTexture.index, pbr.metallicRoughnessTexture?.index, `${file} ${m.name}: occlusion and roughness must be one texture`);
      assert.ok(m.normalTexture, `${file} ${m.name}: no normal map`);
      assert.equal(m.extensions?.KHR_materials_specular, undefined, `${file} ${m.name}: the specular mask should be gone`);
    }
    assert.equal(n, 10, `${file}: expected 10 skin and cockpit materials`);
  });
}

test('mig21.glb keeps the nodes the game drives and the texture budget', () => {
  const g = gltfJson('mig21.glb');
  const names = new Set(g.nodes.map((n) => n.name));
  for (const n of ['mig21', 'airframe', 'canopy_glass', 'cockpit_interior', 'cockpit_seat', 'glass_misc', 'pitot',
    'stab_L', 'stab_R', 'aileron_L', 'aileron_R', 'flap_L', 'flap_R', 'rudder', 'rudder_hinge', 'airbrake_L', 'airbrake_R']) {
    assert.ok(names.has(n), `missing node ${n}`);
  }
  // same texture count as before the pass (the ORM maps replaced the specular masks)
  assert.equal(g.textures.length, 33);
});
