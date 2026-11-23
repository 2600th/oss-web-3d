/**
 * Atmosphere + clouds system. Auto-registered by main.js (see
 * docs/v2/ARCHITECTURE.md, "Systems"); order 10 = world/atmosphere.
 *
 * The Environment itself is owned and updated by Game; this system only plugs
 * its screen-space stages into PostFX, sets the calibrated exposure, and keeps
 * cloud shadows hooked into the terrain materials (which the terrain owner may
 * rebuild at any time).
 */

export const order = 10;

/** PostFX exposure calibrated for sun irradiance 4.6 (see Atmosphere.js) under AgX. */
export const BASE_EXPOSURE = 0.85;

export function createSystem(game) {
  const env = game.env;
  const post = game.post;
  // Aerial perspective on opaque geometry, then clouds over everything.
  post.addSceneStage(env.atmosphere.aerialStage(), 20);
  if (env.clouds) post.addSceneStage(env.clouds.stage(), 30);

  let exposureScale = 0;
  let timer = 0;
  const hookTerrain = () => {
    game.terrain?.group?.traverse((o) => {
      if (o.isMesh && o.material?.isNodeMaterial) env.applyCloudShadow(o.material);
    });
  };

  return {
    name: 'atmosphere',
    env,
    init() {
      hookTerrain();
    },
    update(dt) {
      if (post.uniforms?.exposure && env.exposureScale !== exposureScale) {
        exposureScale = env.exposureScale;
        post.uniforms.exposure.value = BASE_EXPOSURE * exposureScale;
      }
      timer += dt;
      if (timer > 1) { timer = 0; hookTerrain(); }
    },
  };
}
