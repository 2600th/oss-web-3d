import { EffectPass } from 'postprocessing';

/** EffectPass that can present to either the canvas or a caller-owned target. */
export class OutputEffectPass extends EffectPass {
  constructor(camera, ...effects) {
    super(camera, ...effects);
    this.outputTarget = null;
  }

  resolveOutputBuffer(fallback) {
    return this.outputTarget ?? fallback;
  }

  render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
    super.render(
      renderer,
      inputBuffer,
      this.resolveOutputBuffer(outputBuffer),
      deltaTime,
      stencilTest,
    );
  }
}
