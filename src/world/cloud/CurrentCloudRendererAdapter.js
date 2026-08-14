export class CurrentCloudRendererAdapter {
  constructor(cloudVolume) {
    this.cloudVolume = cloudVolume;
    this._disposed = false;
  }

  setSize(width, height, _pixelRatio) {
    this.cloudVolume.setSize(width, height);
  }

  setQuality(tier) {
    this.cloudVolume.setQuality(tier);
  }

  setDepthTexture(texture) {
    this.cloudVolume.setDepthTexture(texture);
  }

  update(frame) {
    this.cloudVolume.update(frame.renderer, frame.inputBuffer, frame.dt);
  }

  resetHistory(reason) {
    this.cloudVolume.resetHistory(reason);
  }

  getShadowOutput() {
    return this.cloudVolume.shadowContract;
  }

  getResourceReport() {
    return this.cloudVolume.getResourceReport();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.cloudVolume.dispose();
  }
}
