/**
 * Tiny synchronous event bus shared by all systems (`game.events`).
 * Gameplay emits; VFX, audio, HUD and camera react. Payloads are plain objects
 * that may hold live references (e.g. a missile entity whose position keeps
 * updating until `entity.alive === false`). See docs/ARCHITECTURE.md for
 * the event catalogue.
 */
export class Events {
  constructor() { this._map = new Map(); }

  on(type, fn) {
    if (!this._map.has(type)) this._map.set(type, new Set());
    this._map.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this._map.get(type)?.delete(fn); }

  emit(type, payload = {}) {
    const set = this._map.get(type);
    if (set) for (const fn of [...set]) fn(payload);
    const any = this._map.get('*');
    if (any) for (const fn of [...any]) fn(type, payload);
  }
}
