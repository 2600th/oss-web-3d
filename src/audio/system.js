import { AudioEngine } from './AudioEngine.js';
import { SoundBank } from './SoundBank.js';
import { Voices } from './Voices.js';
import { PlayerJet } from './PlayerJet.js';
import { Warnings } from './Warnings.js';
import { Radio } from './Radio.js';
import { MusicDirector } from './MusicDirector.js';
import { closestApproach } from './physics.js';

/**
 * Audio system (order 80): owns the Web Audio graph and reacts to the
 * `game.events` contract (docs/v2/ARCHITECTURE.md). Public API on
 * `game.systems.audio`:
 *
 *   setVolume(bus, v) / getVolume(bus)   bus: master|music|sfx|radio|ui|ambience, v 0..1 (persisted)
 *   setMuted(bool)
 *   ui(name)                              click|hover|confirm|back|error|kill|hit
 *   play(id, opts)                        any manifest SFX (see Voices.js for opts)
 *   setMusic(state, level?)               same as emitting music:intensity
 *   stinger('complete'|'failed')
 *   say({speaker, callsign, text, priority, voice?})
 *   unlock()                              create/resume the context from a gesture
 *   meter(bus) -> dBFS RMS                (verification)
 *   engine, bank, voices, music, radio, warnings, jet   (internals, read-only)
 */
export const order = 80;

const SIZE = { small: 0.55, medium: 1, large: 1.6, huge: 2.4 };

function isPlayer(entity, game) {
  if (!entity || entity === 'player') return true;
  return entity.isPlayer === true || entity.kind === 'player' || entity.team === 'player'
    || entity === game.player || entity.id === 'player';
}

export function createSystem(game) {
  const engine = new AudioEngine({ tier: game.r?.tier?.name ?? 'high' });
  const bank = new SoundBank();
  const voices = new Voices(engine, bank);
  const jet = new PlayerJet(engine, voices);
  const warnings = new Warnings(engine);
  const radio = new Radio(engine, voices, bank);
  const music = new MusicDirector(engine, bank);
  const emitters = new Map(); // entity -> { loop, kind, lastPass }
  const offs = [];
  let ambience = null;
  let cloud = null;
  let gunLoop = null;
  const aaa = new Map();     // entity -> next burst time
  let lockState = 'none';
  let threat = { level: null, at: 0 };
  let viewMode = game.cameraRig?.mode ?? 'chase';
  let screen = null;
  let lastHitUi = 0;
  const exhaust = { x: 0, y: 0, z: 0 };

  const sys = {
    name: 'audio',
    engine, bank, voices, jet, warnings, radio, music,
    ready: false,

    setVolume: (bus, v) => engine.setVolume(bus, v),
    getVolume: (bus) => engine.getVolume(bus),
    setMuted: (m) => engine.setMuted(m),
    meter: (bus) => engine.meter(bus),
    unlock: () => engine.start(),
    play: (id, opts) => voices.play(id, opts),
    ui(name) {
      const id = `ui_${name}`;
      if (bank.has(id)) voices.play(id, { bus: 'ui', gain: 1 });
    },
    setMusic(state, level) { music.request({ state, level }); },
    stinger(kind) { music.stinger(kind === 'failed' ? 'sting_failed' : 'sting_complete'); },
    say(msg) { radio.say(msg); },

    async init(g) {
      engine.unlockOn(globalThis.window);
      engine.onStart(() => {
        if (bank.loaded) startBeds();
      });
      try {
        await bank.load();
      } catch (e) {
        console.warn('[audio] manifest failed to load; running silent', e);
        return;
      }
      bank.prefetchMusic(['menu', 'cruise', 'combat_1', 'combat_2', 'combat_3']);
      if (engine.ctx) startBeds();
      music.autoFlight = true;
      // Apply legacy-style settings object if the UI owner exposes one.
      const s = g.settings;
      if (s) {
        if (typeof s.masterVolume === 'number') engine.setVolume('master', s.masterVolume);
        if (typeof s.musicVolume === 'number') engine.setVolume('music', s.musicVolume);
        if (typeof s.sfxVolume === 'number') engine.setVolume('sfx', s.sfxVolume);
        if (typeof s.radioVolume === 'number') engine.setVolume('radio', s.radioVolume);
      }
      sys.ready = true;
      if (import.meta.env?.DEV) {
        const { installHarness } = await import('./harness.js');
        installHarness(sys, g);
      }
    },

    lateUpdate(dt, g) {
      engine.updateListener(g.camera, dt);
      if (!engine.ctx || !bank.loaded) { music.update(); return; }
      voices.update(dt);

      // player jet
      const f = g.flight;
      if (f) {
        // exhaust ≈ 6.5 m behind the aircraft centre along its axis
        const fw = f.forward ?? { x: 0, y: 0, z: -1 };
        exhaust.x = f.position.x - fw.x * 6.5; exhaust.y = f.position.y - fw.y * 6.5; exhaust.z = f.position.z - fw.z * 6.5;
        const mode = g.cameraRig?.mode;
        if (mode && mode !== viewMode) setView(mode);
        jet.update(dt, f, { exhaust });
      }

      // environment: cloud muffle + canopy
      const inCloud = Math.min(1, Math.max(0, g.env?.inCloud ?? 0));
      const cockpit = jet.blend;
      const cutoff = 20000 * (1 - 0.65 * cockpit) * (1 - 0.8 * inCloud) + 600;
      engine.setWorldMuffle(Math.min(20000, cutoff), 1 - 0.35 * cockpit - 0.3 * inCloud);
      if (cloud) cloud.setGain(inCloud * Math.min(1, (f?.airspeed ?? 0) / 150) * (0.7 - 0.35 * cockpit), 0.2);
      if (ambience) {
        const inMenu = screen && screen !== 'game' && screen !== 'hud' && screen !== 'flight';
        const amb = inMenu ? 0.8 : 0.25 * Math.max(0, 1 - (f?.airspeed ?? 0) / 120);
        ambience.setGain(amb, 0.6);
      }

      // warnings from the HUD snapshot (authoritative) or the event fallbacks
      const hud = g.hud ?? {};
      const ls = hud.lock?.state ?? lockState;
      warnings.set('acquire', ls === 'acquiring');
      warnings.set('locked', ls === 'locked');
      const now = performance.now() / 1000;
      const hudThreat = Array.isArray(hud.threats) && hud.threats.length > 0;
      const tLevel = threat.level && now - threat.at < 4 ? threat.level : (hudThreat ? 'alert' : null);
      warnings.set('missile', tLevel === 'alert' || hud.warning === 'missile');
      warnings.set('rwr', tLevel === 'warning');
      let pull = hud.warning === 'pullup' || hud.warning === 'terrain';
      if (hud.warning === undefined && f && !f.crashed) {
        // fallback ground-proximity: < 5 s to impact on the current sink rate
        const sink = -(f.velocity?.y ?? 0);
        pull = f.agl < 700 && sink > 15 && f.agl / sink < 5;
      }
      warnings.set('pullup', pull && !f?.crashed);
      warnings.set('stall', hud.warning === 'stall' || (hud.warning === undefined && !!f?.stalling && !f?.crashed));
      warnings.set('damage', typeof hud.health === 'number' && hud.health > 0 && hud.health < 0.25);

      // entity emitters: flyby detection
      const L = engine.listener;
      for (const [ent, em] of emitters) {
        if (ent.alive === false) { removeEmitter(ent); continue; }
        if (!ent.velocity) continue;
        const rel = { x: ent.position.x - L.position.x, y: ent.position.y - L.position.y, z: ent.position.z - L.position.z };
        const rv = { x: ent.velocity.x - L.velocity.x, y: ent.velocity.y - L.velocity.y, z: ent.velocity.z - L.velocity.z };
        const ca = closestApproach(rel, rv);
        const speed = Math.hypot(rv.x, rv.y, rv.z);
        const lead = em.kind === 'missile' ? 0.85 : 1.5; // where the asset's pass peak sits
        if (ca.t > 0 && ca.t < lead && speed > 90 && ca.distance < (em.kind === 'missile' ? 150 : 350) && now - em.lastPass > 4) {
          em.lastPass = now;
          voices.play(em.kind === 'missile' ? 'missile_pass' : 'jet_flyby', {
            entity: ent, doppler: false, delay: false, ref: 60, maxDistance: 2500,
            gain: em.kind === 'missile' ? 0.9 : 1.0, priority: 3,
          });
        }
      }

      // AAA bursts while firing
      for (const [ent, st] of aaa) {
        if (ent.alive === false || !st.firing) { aaa.delete(ent); continue; }
        if (now >= st.next) {
          st.next = now + 0.9 + Math.random() * 1.1;
          voices.play('aaa_burst', { position: ent.position, ref: 60, maxDistance: 9000, gain: 1.0 });
          // shells cracking past the player when it is within range
          const d = Math.hypot(ent.position.x - L.position.x, ent.position.y - L.position.y, ent.position.z - L.position.z);
          if (d < 2500 && Math.random() < 0.5) {
            voices.play('gun_crack', { bus: 'sfx', gain: 0.35 * (1 - d / 2500), when: 0.3 + Math.random() * 0.5 });
          }
        }
      }

      music.update();
    },

    onCrash() {},

    dispose() {
      offs.forEach((off) => off());
      voices.stopAll(0.05);
      jet.dispose();
      engine.dispose();
    },
  };

  function startBeds() {
    if (ambience || !engine.ctx) return;
    jet.start();
    jet.setView(viewMode);
    ambience = voices.play('amb_wind', { bus: 'ambience', gain: 0, loop: true });
    cloud = voices.play('cloud_rush', { bus: 'sfx', gain: 0, loop: true });
  }

  function setView(mode) {
    viewMode = mode;
    jet.setView(mode);
  }

  function removeEmitter(ent) {
    const em = emitters.get(ent);
    if (em) { em.loop?.stop(0.2); emitters.delete(ent); }
  }

  function explosion({ position, size = 'medium', kind = 'air' }) {
    if (!position || !engine.ctx) return;
    const k = SIZE[size] ?? 1;
    const L = engine.listener.position;
    const d = Math.hypot(position.x - L.x, position.y - L.y, position.z - L.z);
    const range = 4000 * k + 2000;
    const ref = 45 * k;
    const near = d < 450 * k;
    const far = d > 1600 * k;
    const common = { position, maxDistance: range, priority: 2 + k };
    if (kind === 'flak') {
      voices.play('flak_burst', { ...common, ref: 70, gain: 1.1 });
      if (d < 600) voices.play('exp_debris', { ...common, ref: 25, gain: 0.35, when: 0.08 });
      music.heat(0.08);
      return;
    }
    if (!far) voices.play('exp_transient', { ...common, ref, gain: 0.9 * Math.sqrt(k) });
    voices.play(k < 0.8 ? 'exp_body_small' : 'exp_body', { ...common, ref: ref * 1.2, gain: 1.0 * Math.sqrt(k), maxDistance: range * 1.2 });
    voices.play('exp_tail', { ...common, ref: ref * 2, gain: 0.7 * k, maxDistance: range * 1.6, reverb: 0.6 + Math.min(0.3, d / 8000) });
    if (d > 900) voices.play('exp_far', { ...common, ref: ref * 4, gain: 0.8 * k * Math.min(1, (d - 900) / 1500), maxDistance: range * 2.2 });
    if (near) voices.play('exp_debris', { ...common, ref: 30 * k, gain: 0.6, when: 0.12 });
    if (kind === 'air' && !far && k >= 1) voices.play('exp_fireball', { ...common, ref: ref, gain: 0.6 });
    if (kind === 'ground' && near) voices.play('impact_dirt', { ...common, ref: 30, gain: 0.8, when: 0.05 });
    if (d < 250 * k) {
      engine.duckMusic(0.35, 0.02);
      setTimeout(() => { if (!radio.busy) engine.duckMusic(0, 0.6); }, 600);
    }
    music.heat(0.12 * k);
  }

  const on = (type, fn) => offs.push(game.events.on(type, (p) => {
    try { fn(p ?? {}); } catch (e) { console.warn('[audio] handler', type, e); }
  }));

  on('player:crash', ({ position }) => {
    explosion({ position: position ?? game.flight?.position, size: 'large', kind: 'ground' });
    voices.play('hit_airframe', { bus: 'cockpit', gain: 1 });
    jet.kill();
    warnings.clear();
    gunLoop?.stop(0.05); gunLoop = null;
  });
  on('player:hit', ({ damage = 0.1, health }) => {
    voices.play('hit_airframe', { bus: 'cockpit', gain: Math.min(1, 0.45 + damage * 2) });
    music.heat(0.25);
    if (typeof health === 'number' && health < 0.25) warnings.set('damage', true);
  });
  on('player:destroyed', ({ position }) => {
    explosion({ position: position ?? game.flight?.position, size: 'huge', kind: 'air' });
    jet.kill();
    warnings.clear();
    gunLoop?.stop(0.05); gunLoop = null;
  });
  on('player:respawn', () => { jet.revive(); warnings.clear(); });

  on('weapon:gun', ({ firing, entity }) => {
    if (isPlayer(entity, game)) {
      if (firing && !gunLoop) {
        voices.play('gun_start', { bus: 'cockpit', gain: 0.9 });
        gunLoop = voices.play('gun_loop', { bus: 'cockpit', gain: 0.75, loop: true, when: 0.03 });
        music.heat(0.05);
      } else if (!firing && gunLoop) {
        gunLoop.stop(0.03);
        gunLoop = null;
        voices.play('gun_tail', { bus: 'cockpit', gain: 0.8 });
      }
      return;
    }
    if (entity.kind === 'aaa' || entity.kind === 'flak') {
      if (firing) aaa.set(entity, { firing: true, next: 0 }); else aaa.delete(entity);
      return;
    }
    // other aircraft guns: a moving loop with doppler
    const em = emitters.get(entity) ?? {};
    if (firing && !em.gun) {
      em.gun = voices.play('gun_loop', { entity, ref: 50, maxDistance: 4000, gain: 0.7, loop: true, priority: 2 });
      emitters.set(entity, { kind: 'aircraft', lastPass: 0, ...em });
    } else if (!firing && em.gun) { em.gun.stop(0.05); em.gun = null; }
  });
  on('weapon:gunHit', ({ position, targetKind }) => {
    if (!position) return;
    const dirt = targetKind === 'ground' || targetKind === 'terrain' || targetKind === 'dirt';
    voices.play(dirt ? 'impact_dirt' : 'impact_metal', { position, ref: 25, maxDistance: 2500, gain: 0.7 });
  });

  on('missile:launch', ({ missile }) => {
    if (!missile?.position) return;
    // an unknown owner is treated as hostile: a missile you did not fire is the one to hear
    const mine = missile.owner != null && isPlayer(missile.owner, game);
    const heavy = missile.kind === 'sam';
    if (mine) {
      voices.play('missile_launch', { bus: 'cockpit', gain: 0.95 });
    } else {
      voices.play(heavy ? 'sam_launch' : 'missile_launch', { position: missile.position, ref: heavy ? 80 : 40, maxDistance: heavy ? 14000 : 6000, gain: 1, priority: 3 });
      music.heat(heavy ? 0.3 : 0.2);
    }
    const loop = voices.play('missile_motor', { entity: missile, ref: heavy ? 40 : 25, maxDistance: heavy ? 9000 : 5000, gain: mine ? 0.55 : 0.9, loop: true, priority: 2, when: 0.06 });
    emitters.set(missile, { kind: 'missile', loop, lastPass: mine ? Infinity : 0 });
  });
  on('missile:end', ({ missile }) => removeEmitter(missile));

  on('flare:release', ({ flare }) => {
    const pos = flare?.position ?? game.flight?.position;
    if (flare?.owner != null && !isPlayer(flare.owner, game)) voices.play('flare_pop', { position: pos, ref: 30, maxDistance: 2500, gain: 0.8 });
    else voices.play('flare_pop', { bus: 'cockpit', gain: 0.55, when: Math.random() * 0.03 });
  });

  on('explosion', explosion);
  on('target:destroyed', ({ killer }) => {
    if (killer === undefined || isPlayer(killer, game)) setTimeout(() => sys.ui('kill'), 250);
    music.heat(0.15);
  });
  on('target:hit', () => {
    const now = performance.now();
    if (now - lastHitUi > 90) { lastHitUi = now; sys.ui('hit'); }
  });

  on('lock:acquiring', () => { lockState = 'acquiring'; music.heat(0.1); });
  on('lock:locked', () => { lockState = 'locked'; music.heat(0.1); });
  on('lock:lost', () => { lockState = 'none'; });
  on('threat:missile', ({ level = 'alert' }) => { threat = { level, at: performance.now() / 1000 }; music.heat(level === 'alert' ? 0.5 : 0.25); });
  on('threat:cleared', () => { threat = { level: null, at: 0 }; });

  on('aircraft:spawn', ({ entity }) => {
    if (!entity?.position || entity.isPlayer || entity.kind === 'player' || entity === game.player) return;
    const loop = voices.play('enemy_jet', { entity, ref: 45, maxDistance: 7000, gain: 0.9, loop: true, priority: 2 });
    emitters.set(entity, { kind: 'aircraft', loop, lastPass: 0 });
  });
  on('aircraft:despawn', ({ entity }) => removeEmitter(entity));

  on('radio', (msg) => radio.say(msg));

  on('mission:start', () => { music.request({ state: 'cruise', level: 0 }); screen = 'game'; });
  on('mission:complete', () => { music.stinger('sting_complete'); music.request({ state: 'victory' }); });
  on('mission:failed', () => { music.stinger('sting_failed'); music.request({ state: 'defeat' }); });
  on('music:intensity', ({ state, level }) => music.request({ state, level }));
  on('camera:mode', ({ mode }) => setView(mode));
  on('ui:screen', ({ screen: s }) => {
    screen = s;
    const map = { title: 'menu', menu: 'menu', main: 'menu', hangar: 'menu', briefing: 'briefing', memorial: 'memorial', remembrance: 'memorial' };
    if (map[s]) music.request({ state: map[s] });
    if (s === 'game' || s === 'hud' || s === 'flight') music.request({ state: 'cruise', level: 0 });
  });
  on('ui:sound', ({ name }) => sys.ui(name));

  // UI clicks for any button in the DOM, without the UI owner wiring each one.
  // Opt out with data-sound="none"; choose a sound with data-sound="confirm|back|...".
  const doc = globalThis.document;
  if (doc) {
    const click = (ev) => {
      const el = ev.target?.closest?.('button, [role="button"], a[href], [data-sound]');
      if (!el || el.dataset?.sound === 'none') return;
      engine.start();
      sys.ui(el.dataset?.sound || 'click');
    };
    doc.addEventListener('click', click, true);
    offs.push(() => doc.removeEventListener('click', click, true));
  }

  return sys;
}
