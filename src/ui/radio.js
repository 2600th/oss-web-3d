/**
 * Radio subtitle queue and transient callouts. Pure state machines driven by
 * `update(dt)`, so the HUD only reads `current`/`items` when it draws.
 *
 * Radio: one line on air at a time. Higher `priority` pre-empts a lower line
 * that has been up for at least `minHold` seconds; equal priority queues
 * (FIFO). A line's on-air time scales with its length so long lines are
 * readable, then it fades out over `fade` seconds.
 */
export class RadioQueue {
  constructor({ maxQueue = 6, minHold = 1.2, fade = 0.45 } = {}) {
    this.queue = [];
    this.current = null;
    this.maxQueue = maxQueue;
    this.minHold = minHold;
    this.fade = fade;
    this._seq = 0;
  }

  static durationFor(text) {
    const words = String(text ?? '').split(/\s+/).filter(Boolean).length;
    return Math.min(9, Math.max(2.4, 1.2 + words * 0.36));
  }

  push({ callsign = '', speaker = '', text = '', priority = 1, duration } = {}) {
    if (!text) return;
    const item = {
      id: ++this._seq,
      callsign: callsign || speaker || '',
      text: String(text),
      priority: Number.isFinite(priority) ? priority : 1,
      duration: duration ?? RadioQueue.durationFor(text),
      age: 0,
    };
    const cur = this.current;
    if (cur && item.priority > cur.priority && cur.age >= Math.min(this.minHold, cur.duration)) {
      // Pre-empt: cut the current line short (it fades from here).
      cur.duration = Math.min(cur.duration, cur.age);
    }
    this.queue.push(item);
    // stable sort: priority desc, then arrival
    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
    if (this.queue.length > this.maxQueue) this.queue.length = this.maxQueue;
  }

  update(dt) {
    const cur = this.current;
    if (cur) {
      cur.age += dt;
      if (cur.age >= cur.duration + this.fade) this.current = null;
    }
    if (!this.current && this.queue.length) {
      this.current = this.queue.shift();
      this.current.age = 0;
    }
  }

  /** 0..1 opacity of the current line (fade in 0.15 s, fade out `fade`). */
  get alpha() {
    const c = this.current;
    if (!c) return 0;
    if (c.age < 0.15) return c.age / 0.15;
    if (c.age > c.duration) return Math.max(0, 1 - (c.age - c.duration) / this.fade);
    return 1;
  }

  clear() {
    this.queue.length = 0;
    this.current = null;
  }
}

/**
 * Short-lived stacked callouts (kill confirms, hits, misses, mission updates).
 * Each has a kind, text, optional sub-line, and a lifetime; `items` is newest
 * first and capped so a multi-kill does not wallpaper the screen.
 */
/** Callout kinds that refresh in place rather than stack. */
const REFRESH = new Set(['hit', 'miss']);

export class Callouts {
  constructor({ max = 3 } = {}) {
    this.items = [];
    this.max = max;
  }

  push(kind, text, sub = '', life = 2.2) {
    // A burst of hits or misses refreshes the line on top instead of
    // stacking copies of it (and pushing the kill confirm down).
    const top = this.items[0];
    if (top && REFRESH.has(kind) && top.kind === kind && top.text === text) {
      top.age = Math.min(top.age, 0.12);
      top.life = Math.max(top.life, life);
      top.sub = sub;
      return;
    }
    this.items.unshift({ kind, text, sub, life, age: 0 });
    if (this.items.length > this.max) this.items.length = this.max;
  }

  update(dt) {
    for (const it of this.items) it.age += dt;
    this.items = this.items.filter((it) => it.age < it.life);
  }

  clear() {
    this.items.length = 0;
  }
}
