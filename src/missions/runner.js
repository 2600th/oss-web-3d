// Data-driven mission runner. Pure logic (node-testable): it is handed a
// mission definition and a set of hooks, and it walks phases, fires triggers
// and reports completion or failure. It knows nothing about rendering, AI or
// the HUD.
//
// Mission shape (see data.js for real ones):
//   { id, name, timeLimit, groups: {id: spawnDef}, phases: [phase] }
// Phase:
//   { id, name, objective: {text, track?}, enter: [action], triggers: [{when, do}],
//     done: condition, failWhen?: condition, failReason?, next?: phaseId }
// Condition (all keys optional, combined with AND):
//   {time}            seconds since the phase began
//   {missionTime}     seconds since the mission began
//   {destroyed: tag, count?}   that many of the tag destroyed (default: all spawned)
//   {remaining: tag, lte?}     at most that many still alive
//   {arrived: tag, count?}     convoy units that reached the end of their road
//   {zone: {x, z, r}}          player inside the circle
//   {captured: n}              recon photographs taken
//   {healthBelow: 0..1}, {flag: name}
//   {all: [..]}, {any: [..]}, {not: cond}
// Action:
//   {radio: [speaker, text, priority?]}, {spawn: groupId}, {music: {state, level}},
//   {flag: name}, {bonus: {label, score}}, {goto: phaseId}, {complete: true},
//   {fail: reason}, {hostile: bool}, {maxAttackers: n}, {timeLimit: seconds}

export function testCondition(c, v) {
  if (!c) return false;
  if (c.all && !c.all.every((x) => testCondition(x, v))) return false;
  if (c.any && !c.any.some((x) => testCondition(x, v))) return false;
  if (c.not && testCondition(c.not, v)) return false;
  if (c.time !== undefined && !(v.phaseTime >= c.time)) return false;
  if (c.missionTime !== undefined && !(v.time >= c.missionTime)) return false;
  if (c.destroyed !== undefined) {
    const total = v.total(c.destroyed);
    if (total <= 0 || v.destroyed(c.destroyed) < (c.count ?? total)) return false;
  }
  if (c.remaining !== undefined) {
    if (v.total(c.remaining) <= 0 || v.alive(c.remaining) > (c.lte ?? 0)) return false;
  }
  if (c.arrived !== undefined && v.arrived(c.arrived) < (c.count ?? 1)) return false;
  if (c.zone) {
    const dx = v.player.x - c.zone.x, dz = v.player.z - c.zone.z;
    if (dx * dx + dz * dz > c.zone.r * c.zone.r) return false;
  }
  if (c.captured !== undefined && v.captured < c.captured) return false;
  if (c.healthBelow !== undefined && !(v.health < c.healthBelow)) return false;
  if (c.flag !== undefined && !v.flags[c.flag]) return false;
  return true;
}

export class MissionRunner {
  /**
   * @param {object} mission
   * @param {object} hooks { spawn(def)->entities, radio(speaker,text,priority), music(m),
   *                         bonus(b), setHostile(b), setMaxAttackers(n), phase(phase), end(state, reason) }
   */
  constructor(mission, hooks = {}) {
    this.mission = mission;
    this.hooks = hooks;
    this.state = 'idle'; // idle | running | complete | failed
    this.reason = null;
    this.time = 0;
    this.phaseTime = 0;
    this.phaseIndex = -1;
    this.phase = null;
    this.flags = {};
    this.timeLimit = mission.timeLimit ?? 0;
    this.captured = 0;
    this.bonuses = [];
    /** tag -> {total, destroyed, arrived}; alive = total - destroyed. */
    this.tags = new Map();
    this._fired = new Set();
    this.view = {
      time: 0, phaseTime: 0, captured: 0, health: 1, flags: this.flags, player: { x: 0, y: 0, z: 0 },
      total: (t) => this.tags.get(t)?.total ?? 0,
      destroyed: (t) => this.tags.get(t)?.destroyed ?? 0,
      alive: (t) => { const s = this.tags.get(t); return s ? s.total - s.destroyed : 0; },
      arrived: (t) => this.tags.get(t)?.arrived ?? 0,
    };
  }

  _tag(t) {
    let s = this.tags.get(t);
    if (!s) { s = { total: 0, destroyed: 0, arrived: 0 }; this.tags.set(t, s); }
    return s;
  }

  /** Tell the runner that entities carrying these tags now exist. */
  register(tags) { for (const t of tags) this._tag(t).total++; }
  notifyDestroyed(tags) { for (const t of tags) this._tag(t).destroyed++; }
  notifyArrived(tags) { for (const t of tags) this._tag(t).arrived++; }
  notifyCaptured(n = 1) { this.captured += n; }

  start() {
    this.state = 'running';
    this.time = 0;
    this._enter(0);
  }

  _enter(index) {
    this.phaseIndex = index;
    this.phase = this.mission.phases[index] ?? null;
    this.phaseTime = 0;
    if (!this.phase) return this._end('complete');
    this.hooks.phase?.(this.phase, index);
    this.run(this.phase.enter);
  }

  _end(state, reason = null) {
    if (this.state !== 'running') return;
    this.state = state;
    this.reason = reason;
    this.hooks.end?.(state, reason);
  }

  fail(reason) { this._end('failed', reason); }

  run(actions) {
    if (!actions) return;
    for (const a of actions) {
      if (this.state !== 'running') return;
      if (a.radio) this.hooks.radio?.(a.radio[0], a.radio[1], a.radio[2] ?? 1);
      if (a.spawn) {
        const def = this.mission.groups?.[a.spawn];
        if (def) {
          const entities = this.hooks.spawn?.({ id: a.spawn, ...def }) ?? [];
          for (const e of entities) this.register(e.tags ?? []);
        }
      }
      if (a.music) this.hooks.music?.(a.music);
      if (a.flag) this.flags[a.flag] = true;
      if (a.bonus) { this.bonuses.push(a.bonus); this.hooks.bonus?.(a.bonus); }
      if (a.hostile !== undefined) this.hooks.setHostile?.(a.hostile);
      if (a.maxAttackers !== undefined) this.hooks.setMaxAttackers?.(a.maxAttackers);
      if (a.timeLimit !== undefined) this.timeLimit = a.timeLimit;
      if (a.fail) return this.fail(a.fail);
      if (a.complete) return this._end('complete');
      if (a.goto) {
        const i = this.mission.phases.findIndex((p) => p.id === a.goto);
        if (i >= 0) return this._enter(i);
      }
    }
  }

  /** @param {object} world {player:{x,y,z}, health} */
  update(dt, world = {}) {
    if (this.state !== 'running') return;
    this.time += dt;
    this.phaseTime += dt;
    const v = this.view;
    v.time = this.time;
    v.phaseTime = this.phaseTime;
    v.captured = this.captured;
    if (world.player) { v.player.x = world.player.x; v.player.y = world.player.y; v.player.z = world.player.z; }
    if (world.health !== undefined) v.health = world.health;

    if (this.timeLimit > 0 && this.time >= this.timeLimit) return this.fail('time');
    const phase = this.phase;
    if (!phase) return;
    if (phase.failWhen && testCondition(phase.failWhen, v)) return this.fail(phase.failReason ?? 'objective');

    const triggers = phase.triggers ?? [];
    for (let i = 0; i < triggers.length; i++) {
      const key = `${this.phaseIndex}:${i}`;
      if (this._fired.has(key)) continue;
      if (testCondition(triggers[i].when, v)) {
        this._fired.add(key);
        const before = this.phase;
        this.run(triggers[i].do);
        if (this.state !== 'running' || this.phase !== before) return;
      }
    }
    if (phase.done && testCondition(phase.done, v)) {
      this.run(phase.exit);
      if (this.state !== 'running' || this.phase !== phase) return;
      const next = phase.next ? this.mission.phases.findIndex((p) => p.id === phase.next) : this.phaseIndex + 1;
      if (next < 0 || next >= this.mission.phases.length) this._end('complete');
      else this._enter(next);
    }
  }

  /** {text, progress, total} for the HUD. */
  objective() {
    const o = this.phase?.objective;
    if (!o) return { text: '', progress: 0, total: 0 };
    let progress = 0, total = 0;
    if (o.track?.destroyed) { total = this.view.total(o.track.destroyed); progress = this.view.destroyed(o.track.destroyed); }
    else if (o.track?.captured) { total = o.track.captured; progress = Math.min(this.captured, total); }
    return { text: o.text, progress, total, marker: o.marker ?? null };
  }

  get timeRemaining() { return this.timeLimit > 0 ? Math.max(0, this.timeLimit - this.time) : Infinity; }
}
