// Radio queue: one voice at a time, urgent calls jump the queue, chatter is
// dropped when the net is busy. Emits `radio` when a line starts. Pure logic.

export function lineDuration(text) {
  return Math.min(7, Math.max(1.8, 1.2 + text.length * 0.052));
}

export class Radio {
  /** @param {{emit:Function}} events @param {object} cast speaker -> {callsign, voice} */
  constructor(events, cast) {
    this.events = events;
    this.cast = cast;
    this.queue = [];
    this.current = null;
    this.elapsed = 0;
    this.gap = 0;
    this.log = [];
  }

  clear() { this.queue.length = 0; this.current = null; this.gap = 0; this.log.length = 0; }

  /**
   * @param {string} speaker  key into the cast
   * @param {string} text
   * @param {number} priority 0 chatter, 1 normal, 2 urgent
   * @param {object} [extra]  merged into the payload (e.g. {callsign})
   */
  say(speaker, text, priority = 1, extra = null) {
    const c = this.cast[speaker] ?? {};
    const line = {
      speaker, callsign: extra?.callsign ?? c.callsign ?? speaker.toUpperCase(), text, priority,
      voice: extra?.voice ?? c.voice, duration: lineDuration(text),
    };
    if (priority === 0 && (this.queue.length >= 2 || (this.current && this.current.priority > 0 && this.queue.length >= 1))) return false;
    if (this.queue.length >= 7) {
      const i = this.queue.findIndex((l) => l.priority < priority);
      if (i < 0) return false;
      this.queue.splice(i, 1);
    }
    if (priority >= 2) {
      // Ahead of everything that is not itself urgent.
      let i = 0;
      while (i < this.queue.length && this.queue[i].priority >= 2) i++;
      this.queue.splice(i, 0, line);
      if (this.current && this.current.priority < 2 && this.elapsed > 0.9) this.current = null;
    } else this.queue.push(line);
    return true;
  }

  update(dt) {
    if (this.current) {
      this.elapsed += dt;
      if (this.elapsed >= this.current.duration) { this.current = null; this.gap = 0.35; }
      return;
    }
    this.gap -= dt;
    if (this.gap > 0 || this.queue.length === 0) return;
    this.current = this.queue.shift();
    this.elapsed = 0;
    this.log.push(this.current);
    if (this.log.length > 40) this.log.shift();
    this.events.emit('radio', { ...this.current });
  }
}
