import * as THREE from 'three/webgpu';
import { rankLights } from './ring.js';

/**
 * A small pool of real PointLights fed by any number of "virtual" lights.
 *
 * Effects call `flash()` for one-shot decaying lights (explosions, impacts)
 * and `request()` every frame for continuous ones (flares, fires, muzzle,
 * reheat). Each frame the brightest few as seen from the camera get a real
 * light; the rest are dropped. The real lights always exist in the scene at
 * intensity 0, so the light count — and therefore every lit material's
 * pipeline — never changes mid-game.
 */
export class Lights {
  constructor(scene, count) {
    this.lights = [];
    this.group = new THREE.Group();
    this.group.name = 'vfx-lights';
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 100, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
    scene.add(this.group);
    this.flashes = [];
    this._req = [];
    this._free = [];
  }

  _item() {
    return this._free.pop() ?? { x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, intensity: 0, range: 100, score: 0 };
  }

  /** One-shot light that decays to zero over `duration` seconds. */
  flash(pos, r, g, b, intensity, range, duration) {
    if (this.flashes.length > 48) this.flashes.shift();
    this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, r, g, b, intensity, range, duration, age: 0 });
  }

  /** Continuous light; call every frame it should exist. */
  request(x, y, z, r, g, b, intensity, range) {
    const q = this._item();
    q.x = x; q.y = y; q.z = z; q.r = r; q.g = g; q.b = b; q.intensity = intensity; q.range = range;
    this._req.push(q);
  }

  update(dt, camPos) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      if (f.age >= f.duration) { this.flashes.splice(i, 1); continue; }
      const k = 1 - f.age / f.duration;
      this.request(f.x, f.y, f.z, f.r, f.g, f.b, f.intensity * k * k, f.range);
    }
    const top = rankLights(this._req, camPos, this.lights.length);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i], q = top[i];
      if (q) {
        l.position.set(q.x, q.y, q.z);
        l.color.setRGB(q.r, q.g, q.b);
        l.intensity = q.intensity;
        l.distance = q.range;
      } else if (l.intensity !== 0) {
        l.intensity = 0;
      }
    }
    for (const q of this._req) this._free.push(q);
    this._req.length = 0;
  }

  dispose() {
    this.group.removeFromParent();
    for (const l of this.lights) l.dispose();
  }
}
