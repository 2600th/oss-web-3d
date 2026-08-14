import assert from 'node:assert/strict';
import { ToneMappingMode } from 'postprocessing';
import { CinematicGradeEffect } from './CinematicGradeEffect.js';
import {
  AdaptiveExposureEffect,
  computeMeteredExposure,
  createFilmicToneMapping,
} from './AutoExposure.js';
import { configureFinalOutput, normalizeRenderOptions, setPassEnabled } from './PostPipeline.js';
import { SunShaftEffect } from './SunShaftEffect.js';
import { MOTION_BLUR_FRAGMENT, MotionBlurEffect } from './MotionBlurEffect.js';
import { HeatDistortionEffect } from './HeatDistortionEffect.js';
import { LensArtifactsEffect } from './LensArtifactsEffect.js';
import { OutputEffectPass } from './OutputEffectPass.js';

{
  const pass = new OutputEffectPass(null);
  const fallback = { name: 'composer-ping-pong' };
  const capture = { name: 'recon-target' };
  assert.equal(pass.resolveOutputBuffer(fallback), fallback);
  pass.outputTarget = capture;
  assert.equal(pass.resolveOutputBuffer(fallback), capture, 'final post output must route to capture target');
  pass.dispose();
}

{
  for (const tier of ['high', 'medium', 'low', 'phone']) {
    const passes = [
      { enabled: true, renderToScreen: false },
      { enabled: tier === 'high', renderToScreen: false },
      { enabled: tier !== 'phone', renderToScreen: false },
      { enabled: true, renderToScreen: false, outputTarget: undefined },
    ];
    const finalPass = passes.at(-1);
    configureFinalOutput(passes, finalPass, null);
    assert.equal(finalPass.enabled, true, `${tier} must keep its final pass enabled`);
    assert.equal(finalPass.renderToScreen, true, `${tier} must present to the canvas`);
    assert.equal(passes.filter((pass) => pass.renderToScreen).length, 1, `${tier} needs one screen owner`);

    const target = { name: `${tier}-capture` };
    configureFinalOutput(passes, finalPass, target);
    assert.equal(finalPass.renderToScreen, false, `${tier} capture must not write to the canvas`);
    assert.equal(finalPass.outputTarget, target, `${tier} capture must preserve the requested target`);
  }
}

{
  const exposure = new AdaptiveExposureEffect();
  const tone = createFilmicToneMapping();
  assert.equal(tone.mode, ToneMappingMode.AGX, 'AGX must be the sole compression operator after metered exposure');
  assert.ok(exposure.minLuminance >= 0.03, 'metering must bound dark-scene gain');
  assert.ok(exposure.adaptationRate > 0, 'metering must adapt over time');

  for (const grey of [0.1, 0.2]) {
    const ev = computeMeteredExposure(grey);
    const exposed = grey * (2 ** ev);
    assert.ok(exposed >= 0.15, `grey ${grey} must remain a terrain midtone, not collapse toward black`);
    assert.ok(exposed <= 0.32, `grey ${grey} must leave highlight headroom`);
  }
  exposure.dispose();
}

{
  const defaults = { scene: { name: 'main-scene' }, camera: { name: 'main-camera' }, deltaTime: 0 };
  const reconCamera = { isCamera: true, name: 'recon-camera' };
  assert.equal(normalizeRenderOptions(reconCamera, defaults).camera, reconCamera);
  assert.equal(normalizeRenderOptions({ camera: reconCamera, deltaTime: 0.1 }, defaults).camera, reconCamera);

  const pass = { enabled: false };
  setPassEnabled(pass, true);
  assert.equal(pass.enabled, true, 'uniform setters must toggle only their affected pass');
}

{
  const shafts = new SunShaftEffect();
  shafts.setSunPosition(0.2, 0.8, 0.75);
  assert.deepEqual(shafts.sunPosition.toArray(), [0.2, 0.8]);
  assert.equal(shafts.visibility, 0.75);

  const motion = new MotionBlurEffect();
  motion.setMotion({ angularX: 0.3, angularY: -0.4, radialPixels: 2, amount: 0.8, edgeStart: 0.45 });
  assert.equal(motion.angularPixels.length(), 0.5);
  assert.equal(motion.uniforms.get('uRadialPixels').value, 2);
  assert.equal(motion.amount, 0.8);
  assert.equal(motion.uniforms.get('uEdgeStart').value, 0.45);

  const heat = new HeatDistortionEffect();
  heat.amount = 4;
  assert.equal(heat.amount, 1, 'heat distortion must clamp unsafe strengths');

  const lens = new LensArtifactsEffect();
  lens.setSunPosition(0.3, 0.7, 0.8);
  lens.dirt = 3;
  assert.equal(lens.dirt, 1, 'procedural dirt must clamp to its documented range');
  assert.equal(lens.visibility, 0.8);
}

{
  assert.match(MOTION_BLUR_FRAGMENT, /uv\s*-\s*uOpticalCenter/, 'radial direction must originate at the optical center');
  assert.match(MOTION_BLUR_FRAGMENT, /smoothstep\(uEdgeStart/, 'the radial component needs a configurable edge mask');
  assert.match(MOTION_BLUR_FRAGMENT, /clampCombinedPixels/, 'combined offsets must be capped before sampling');
  assert.match(MOTION_BLUR_FRAGMENT, /clampCombinedPixels[\s\S]*texture2D/, 'the capped offset must feed texture sampling');
}

{
  const finish = new CinematicGradeEffect();
  finish.setQuality({ name: 'phone' });
  assert.equal(finish.chromaticAberration, 0, 'phone tier should avoid extra texture samples');
  assert.equal(finish.grain, 0, 'phone tier should avoid animated grain');

  finish.setQuality({ name: 'high' });
  assert.ok(finish.chromaticAberration > 0, 'high tier should enable restrained lens-edge separation');
  assert.ok(finish.grain > 0, 'high tier should enable subtle temporal grain');

  finish.setSize(1920, 1080);
  assert.deepEqual(finish.resolution.toArray(), [1920, 1080], 'resize should update pixel-sized effects');
  assert.deepEqual(finish.sanitizeSample([-0.04, 0.1, 1.2]), [0, 0.1, 1.2]);
}

console.log('post effect contracts passed');
