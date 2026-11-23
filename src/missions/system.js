// Mission system: runs the active mission script, the radio, reactive chatter,
// recon photography, score and the sortie result. Emits `radio`, `mission:*`
// and `music:intensity`; writes the mission part of `game.hud`.
import { clearLine } from '../combat/los.js';
import { MISSIONS, missionById } from './data.js';
import { CAST, CHATTER, REMEMBRANCE } from './cast.js';
import { MissionRunner } from './runner.js';
import { Radio } from './radio.js';
import { Recon, OPTIC } from './recon.js';
import { Onboarding, controlLabel } from './onboarding.js';
import { accuracy, computeScore, rankFor, loadProgress, recordResult, saveProgress, isUnlocked } from './scoring.js';
import { WEAPONS } from '../combat/weapons.js';
import { difficultyFor } from '../game/difficulty.js';

export const order = 52;
export function createSystem(game) { return new MissionSystem(game); }

const FAIL_TEXT = {
  shot_down: 'Vajra One was shot down over the ridges.',
  crashed: 'Vajra One was lost to the mountain.',
  time: 'The window closed before the task was done.',
  overrun: 'Anvil could not hold the face. The crest stayed in hostile hands.',
  objective: 'The objective was not met.',
};
const OUTRO_SECONDS = { complete: 6, failed: 3.5 };
const los = (a, b) => clearLine(a, b);

export class MissionSystem {
  constructor(game) {
    this.name = 'missions';
    this.game = game;
    this.list = MISSIONS;
    this.cast = CAST;
    this.remembrance = REMEMBRANCE;
    this.radio = new Radio(game.events, CAST);
    this.progress = loadProgress();
    this.mission = null;
    this.runner = null;
    this.recon = null;
    this.result = null;
    this.targetScore = 0;
    this.bonusScore = 0;
    this._chatter = {};
    this._outro = 0;
    this._lastHitBy = null;
    this._opticOn = false;
    this._savedCam = null;
    this.rng = Math.random;

    const ev = game.events;
    ev.on('target:destroyed', (e) => this._onDestroyed(e));
    ev.on('player:destroyed', () => this.runner?.fail('shot_down'));
    ev.on('player:crash', () => this.runner?.fail(this.combat?.player.health <= 0 ? 'shot_down' : 'crashed'));
    ev.on('missile:launch', ({ missile }) => this._onLaunch(missile));
    ev.on('missile:end', ({ missile, reason }) => {
      if (this.running && missile.targetWasPlayer && reason !== 'hit') this.chatter('missileEvaded');
    });
    ev.on('threat:missile', ({ level }) => { if (level === 'alert') this.chatter('missileWarning'); });
    ev.on('player:hit', ({ health, source }) => {
      if (!this.running) return;
      this._lastHitBy = source;
      if (source?.fighter?.pilot) this.aceLine(source.fighter.pilot, 'hit', 0.5);
      else if (health < 0.3) this.chatter('playerCritical'); else this.chatter('playerHit');
    });
    ev.on('target:hit', ({ target }) => { if (target.fighter?.pilot && this.rng() < 0.35) this.aceLine(target.fighter.pilot, 'struck', 0.6); });
    // Onboarding: doing the thing retires its prompt.
    ev.on('flare:release', ({ flare }) => { if (flare.owner === this.combat?.player) this.onboard?.learn('flares'); });
    ev.on('lock:locked', () => this.onboard?.learn('lock'));
    ev.on('weapon:switch', () => this.onboard?.learn('special'));
    ev.on('weapon:gun', ({ firing, entity }) => { if (firing && entity === this.combat?.player) this.onboard?.learn('gun'); });
    // Turning the difficulty down mid-sortie keeps the lower score multiplier.
    ev.on('flow:difficulty', ({ difficulty }) => {
      if (!this.runner) return;
      const s = difficultyFor(difficulty).score;
      if (s < this._scoreScale) { this._scoreScale = s; this.difficulty = difficulty; }
    });
    ev.on('ai:engage', ({ fighter }) => { if (!this.running) return; if (fighter.pilot) this.aceLine(fighter.pilot, 'engage', 1); else this.chatter('bandits'); });
    ev.on('ai:fire', ({ fighter }) => { if (fighter.pilot) this.aceLine(fighter.pilot, 'fire', 0.5); });
  }

  init(game) {
    this.combat = game.systems.combat;
    this.ai = game.systems.ai;
  }

  get running() { return this.runner?.state === 'running'; }

  /** Menu metadata for every mission (the UI renders from this). */
  meta() {
    return this.list.map((m, i) => ({
      id: m.id, order: m.order, name: m.name, location: m.location, summary: m.summary, briefing: m.briefing,
      free: m.free === true, timeLimit: m.timeLimit, parTime: m.parTime, rank: m.rank,
      specials: m.specials.map((id) => ({ id, name: WEAPONS[id].name, short: WEAPONS[id].short, ammo: WEAPONS[id].ammo, description: WEAPONS[id].description })),
      special: m.special, unlocked: isUnlocked(this.list, i, this.progress),
      best: this.progress.missions[m.id] ?? null,
    }));
  }

  // -------------------------------------------------------------- start --

  start(id, { special } = {}) {
    const m = missionById(id);
    if (!m) return false;
    const game = this.game;
    this.stop();
    this.mission = m;
    this.result = null;
    this.targetScore = 0;
    this.bonusScore = 0;
    this._chatter = {};
    this._outro = 0;
    this.radio.clear();
    this.special = m.specials.includes(special) ? special : m.special;
    this.difficulty = game.flow?.difficulty ?? 'normal';
    this._scoreScale = difficultyFor(this.difficulty).score;
    this.combat.resetForSortie({ special: this.special });
    this.combat.world.god = false;
    this.ai.hostile = true;
    this.ai.maxAttackers = m.maxAttackers ?? 2;
    game.spawnAt(m.start);
    this.recon = m.recon ? new Recon() : null;
    this.onboard = m.onboarding ? new Onboarding({ veteran: this.progress.missions[m.id]?.completed === true }) : null;

    this.runner = new MissionRunner(m, {
      spawn: (def) => {
        const entities = this.ai.spawn(def);
        if (this.recon) for (const e of entities) if (e.kind === 'post') this.recon.addPost(e);
        return entities;
      },
      radio: (speaker, text, priority) => this.radio.say(speaker, text, priority),
      music: (mu) => game.events.emit('music:intensity', { level: mu.level ?? 0.5, state: mu.state ?? 'cruise' }),
      bonus: (b) => { this.bonusScore += b.score; game.events.emit('score:bonus', { ...b }); },
      setHostile: (h) => { this.ai.hostile = h; },
      setMaxAttackers: (n) => { this.ai.maxAttackers = n; },
      phase: (phase) => game.events.emit('mission:phase', { mission: this.info(), phase: { id: phase.id, name: phase.name, objective: phase.objective?.text } }),
      end: (state, reason) => this._onEnd(state, reason),
    });
    this.combat.active = true;
    game.events.emit('mission:start', { mission: this.info() });
    this.runner.start();
    return true;
  }

  stop() {
    this._setOptic(false);
    if (this.combat) this.combat.active = false;
    this.ai?.clear();
    this.runner = null;
    this.mission = null;
    this.recon = null;
    this.onboard = null;
    this.radio.clear();
  }

  info() {
    const m = this.mission;
    return m ? { id: m.id, name: m.name, location: m.location, free: m.free === true, phase: this.runner?.phase?.id ?? null, state: this.runner?.state ?? 'idle' } : null;
  }

  // ------------------------------------------------------------- events --

  chatter(category, extra = null) {
    if (!this.running) return false;
    const c = CHATTER[category];
    if (!c) return false;
    const now = this.runner.time;
    if (now < (this._chatter[category] ?? -Infinity)) return false;
    this._chatter[category] = now + c.cooldown;
    const line = c.lines[Math.floor(this.rng() * c.lines.length)];
    return this.radio.say(c.speaker, line, c.priority, extra);
  }

  aceLine(ace, type, chance = 1) {
    if (!this.runner || this.rng() > chance) return;
    const key = `ace:${ace.id}:${type}`;
    const now = this.runner.time;
    if (now < (this._chatter[key] ?? -Infinity)) return;
    this._chatter[key] = now + (type === 'engage' ? 1e9 : 14);
    const lines = ace.lines?.[type];
    if (!lines?.length) return;
    this.radio.say('ace', lines[Math.floor(this.rng() * lines.length)], type === 'down' || type === 'engage' ? 2 : 1, { callsign: `${ace.callsign} "${ace.name.toUpperCase()}"` });
  }

  _onLaunch(m) {
    if (!this.running) return;
    const player = this.combat.player;
    if (m.owner === player) {
      const w = m.weapon;
      if (m.target) this.onboard?.learn('fire');
      this.chatter(w.type === 'bomb' ? 'playerBomb' : w.type === 'rocket' ? 'playerRockets' : w.guidance === 'radar' ? 'playerRadar' : 'playerMissile');
      const st = this.combat.msl;
      if (st.ammo === 8) this.chatter('lowAmmo');
    } else if (m.target === player) {
      m.targetWasPlayer = true;
      if (m.weapon.id === 'e_sam') this.chatter('samLaunch');
      else if (m.weapon.id === 'e_manpads') this.chatter('manpadsLaunch');
    }
  }

  _onDestroyed({ target, killer, score }) {
    if (!this.runner) return;
    this.runner.notifyDestroyed(target.tags ?? []);
    if (killer !== this.combat.player) return;
    this.targetScore += score;
    if (target.fighter?.pilot) this.aceLine(target.fighter.pilot, 'down', 1);
    else if (target.class === 'air') this.chatter(target.lastHitWeapon === 'gun' ? 'gunKill' : 'airKill');
    else if (target.kind === 'supply') this.chatter('bigKill');
    else this.chatter('groundKill');
  }

  _onEnd(state, reason) {
    const game = this.game;
    const m = this.mission;
    const st = this.combat.world.stats;
    const p = this.combat.player;
    const completed = state === 'complete';
    const acc = accuracy(st);
    const { total, breakdown } = computeScore({
      targetScore: this.targetScore, bonuses: this.bonusScore, completed, time: this.runner.time,
      parTime: m.parTime, timeLimit: m.timeLimit, accuracy: acc, health: p.health / p.maxHealth, damageTaken: st.damageTaken,
      difficultyScale: this._scoreScale ?? 1,
    });
    const rank = m.rank ? rankFor(total, m.rank, completed) : null;
    let newBest = false;
    if (!m.free) {
      newBest = recordResult(this.progress, m.id, { completed, score: total, rank, time: this.runner.time }).newBest;
      saveProgress(this.progress);
    }
    this.result = {
      missionId: m.id, name: m.name, state, completed, reason, reasonText: completed ? null : (FAIL_TEXT[reason] ?? FAIL_TEXT.objective),
      score: total, breakdown, rank, thresholds: m.rank, newBest, time: this.runner.time, difficulty: this.difficulty ?? 'normal',
      kills: st.kills, airKills: st.airKills, groundKills: st.groundKills, accuracy: acc,
      shots: { gunFired: st.gunFired, gunHits: st.gunHits, mslFired: st.mslFired, mslHits: st.mslHits },
      damageTaken: st.damageTaken, health: p.health / p.maxHealth,
      photos: this.recon ? { captured: this.recon.captured, total: this.recon.total } : null,
      pilotLost: reason === 'shot_down' || reason === 'crashed',
      remembrance: (reason === 'shot_down' || reason === 'crashed' || (completed && m.remembrance)) ? this.remembrance : null,
    };
    this._outro = OUTRO_SECONDS[state] ?? 4;
    this.ai.hostile = false;
    this.combat.world.god = true;
    if (completed) {
      game.events.emit('mission:complete', { mission: this.info(), result: this.result });
    } else {
      // Respectful: one quiet line, no jeering, then silence.
      const killer = this._lastHitBy?.fighter?.pilot;
      if (reason === 'shot_down' && killer) this.aceLine(killer, 'kill', 1);
      else if (reason === 'shot_down' || reason === 'crashed') this.radio.say('control', 'Vajra One, Shikhar... Vajra One, respond. ...Vajra One.', 2);
      else if (reason === 'time') this.radio.say('control', 'Vajra One, Shikhar. We are out of time. Return to base.', 2);
      game.events.emit('music:intensity', { level: 0.3, state: 'defeat' });
      game.events.emit('mission:failed', { mission: this.info(), result: this.result });
    }
  }

  // ------------------------------------------------------------- update --

  _setOptic(on) {
    if (on === this._opticOn) return;
    this._opticOn = on;
    const game = this.game;
    game.events.emit('camera:request', on ? { mode: 'optic', fov: OPTIC.fov, depression: OPTIC.depression } : { mode: 'restore' });
    // The rig has no optic view of its own: borrow the HUD-only first-person
    // view at the optic's field of view, and put everything back afterwards.
    const rig = game.cameraRig;
    const set = (mode) => (rig.setMode ? rig.setMode(mode) : (rig.mode = mode));
    if (on) {
      this._savedCam = { mode: rig.mode, baseFov: rig.baseFov, cockpitFov: rig.cockpitFov };
      set('hud');
      rig.baseFov = OPTIC.fov;
      if (rig.cockpitFov !== undefined) rig.cockpitFov = OPTIC.fov;
    } else if (this._savedCam) {
      set(this._savedCam.mode);
      rig.baseFov = this._savedCam.baseFov;
      if (this._savedCam.cockpitFov !== undefined) rig.cockpitFov = this._savedCam.cockpitFov;
      this._savedCam = null;
    }
  }

  update(dt, game) {
    const hud = game.hud;
    const r = this.runner;
    this.radio.update(dt);
    hud.radio = this.radio.current ? { ...this.radio.current, age: this.radio.elapsed } : null;
    if (!r) {
      hud.mission = null;
      hud.objective = null;
      hud.recon = null;
      return;
    }
    const f = game.flight;
    const p = this.combat.player;

    if (r.state === 'running') {
      // Convoys that made it out.
      for (const u of this.ai.ground) {
        const e = u.entity;
        if (e.arrived && !e._arrivedSeen && e.alive) { e._arrivedSeen = true; r.notifyArrived(e.tags); }
      }
      if (this.recon) {
        const want = game.input.actions.optic && p.alive && game.playerControl;
        this._setOptic(want);
        const shot = this.recon.update(dt, f, want, los, want && game.input.pressed.fireGun);
        if (shot) {
          r.notifyCaptured(1);
          this.bonusScore += Math.round(this.mission.recon.photoScore * (0.6 + 0.4 * shot.best));
          shot.entity.captured = true;
          shot.entity.isTarget = false;
          shot.entity.name = 'POST (PHOTOGRAPHED)';
          game.events.emit('recon:capture', { target: shot.entity, quality: shot.best, captured: this.recon.captured, total: this.recon.total });
        }
      }
      if (this.onboard?.enabled && game.playerControl) this._onboarding(game, hud, r);
      if (hud.warning === 'pullup') this.chatter('pullUp');
      r.update(dt, { player: f.position, health: p.health / p.maxHealth });
    } else if (this._outro > 0) {
      this._outro -= dt;
      if (this._outro <= 0) {
        this._setOptic(false);
        this.combat.active = false;
        game.events.emit('flow:missionEnd', { result: this.result });
        // Flow has stopped the mission (runner and mission are gone).
        hud.mission = null;
        hud.objective = null;
        hud.recon = null;
        return;
      }
    }

    const m = this.mission;
    hud.score = this.targetScore + this.bonusScore;
    hud.time = r.time;
    hud.timeLimit = r.timeLimit;
    hud.timeRemaining = r.timeRemaining;
    hud.objective = r.objective();
    hud.mission = { id: m.id, name: m.name, phase: r.phase?.id ?? null, phaseName: r.phase?.name ?? null, state: r.state };
    hud.recon = this.recon ? {
      active: this.recon.active, captured: this.recon.captured, total: this.recon.total,
      progress: this.recon.progress, focus: this.recon.focus?.entity ?? null, quality: this.recon.focus?.quality ?? 0,
      axis: this.recon.axis, fov: OPTIC.fov,
    } : null;
  }

  /**
   * First-sortie prompts. Emits `hint {id, action, text, keys, urgent,
   * duration, handled}`; a HUD that draws it sets `handled = true` in its
   * listener, otherwise the wingman says it on the radio.
   */
  _onboarding(game, hud, r) {
    const input = game.input;
    const ob = this.onboard;
    if (input.pressed.targetNext) ob.learn('target');
    if (input.pressed.camera) ob.learn('camera');
    if (hud.highG > 0.5) ob.learn('highG');
    const t = hud.target;
    const hint = ob.update({
      time: r.time, phase: r.phase?.id, threats: hud.threats?.length ?? 0,
      lockable: !!t && t.lockable === true && t.team === 'hostile', lockState: hud.lock?.state ?? 'none',
      targetDistance: t?.distance ?? Infinity, gunSolution: !!hud.gun?.lead,
      kills: this.combat.world.stats.kills, spAmmo: this.combat.sp.ammo, current: this.combat.current,
      specialName: this.combat.sp.def.name?.toLowerCase(), targets: hud.targets?.length ?? 0,
    }, (action) => controlLabel(input.bindings, action, input.modality));
    if (!hint) return;
    const payload = { ...hint, handled: false };
    game.events.emit('hint', payload);
    if (!payload.handled) this.radio.say('wing', hint.text, hint.urgent ? 2 : 1);
  }

  dispose() { this.stop(); }
}
