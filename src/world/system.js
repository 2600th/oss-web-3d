/**
 * Atmosphere + clouds system. Auto-registered by main.js (see
 * docs/ARCHITECTURE.md, "Systems"); order 10 = world/atmosphere.
 *
 * The Environment itself is owned and updated by Game; this system only plugs
 * its screen-space stages into PostFX, calibrates PostFX's exposure reference
 * and sun reference for this sky, and keeps cloud shadows hooked into the
 * terrain materials (which the terrain owner may rebuild at any time).
 */

export const order = 10;

/**
 * Exposure calibration for this atmosphere (sun irradiance 4.6 at the top of the
 * atmosphere, about 4.4 on the DirectionalLight at noon) under AgX.
 * PostFX owns exposure and meters the frame; we only move its reference:
 * BASE_EXPOSURE is the linear exposure for the reference scene (default preset,
 * chase view over sunlit terrain with cumulus), EXPOSURE_REF_LOG the metered
 * log2 luminance of that scene (measured in-game: -1.54 .. -1.58).
 */
export const BASE_EXPOSURE = 0.85;
export const EXPOSURE_REF_LOG = -1.55;

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
  const syncPost = () => {
    if (env.exposureScale === exposureScale) return;
    exposureScale = env.exposureScale;
    if (post.options?.exposure) {
      // Auto-exposure does most of the work between presets; the preset only
      // nudges the reference by half its suggested gain.
      post.options.exposure = {
        ...post.options.exposure,
        baseEV: Math.log2(BASE_EXPOSURE) + 0.5 * Math.log2(exposureScale),
        refLog: EXPOSURE_REF_LOG,
      };
    } else if (post.uniforms?.exposure) {
      post.uniforms.exposure.value = BASE_EXPOSURE * exposureScale;
    }
    // Lens flare / sun visibility normalise by the sun core's HDR luminance
    // (PostFX convention: reference = one third of the clear-sky peak).
    const a = env.atmosphere.u;
    if (post.uniforms?.sunRefLum) post.uniforms.sunRefLum.value = a.sunIrradiance.value.x * a.sunDiscGain.value / 3;
  };

  // Lightning strikes are announced on the event bus (audio: thunder, after
  // distance / 340 seconds).
  env.onLightning?.(({ position, distance }) => game.events?.emit('weather:lightning', { position, distance }));

  return {
    name: 'atmosphere',
    env,
    init() {
      hookTerrain();
      syncPost();
    },
    update(dt) {
      syncPost();
      // [terrain-2] the terrain samples the post chain's GTAO itself (the
      // scene-pass AO context skips it); post.ao can be rebuilt on a tier change
      game.terrain?.bindNearAO?.(post.ao);
      timer += dt;
      if (timer > 1) { timer = 0; hookTerrain(); }
    },
  };
}
