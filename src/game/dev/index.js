// DEV ONLY (imported behind `import.meta.env.DEV`; never in a production
// bundle). A temporary debug overlay so combat is readable before the real
// HUD/UI lands, and the test bot.
//
//   ?debug=0     hide the overlay (it also hides itself once a ui/hud system exists)
//   ?bot         let the bot fly the sortie       (?bot=god: and cannot be shot down)
//   ?speed=3     time scale
//   window.__bot(true|false|'god'), window.__game.dev
import { Bot } from './Bot.js';
import { terrainHeight } from '../../world/terrain/heightfield.js';
import { CLOUD } from '../../ai/brain.js';
import { ROUGH_AIR } from '../../ai/Fighter.js';

const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '--');
const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '--:--');

export function install(game) {
  const q = new URLSearchParams(location.search);
  const dev = { bot: null, overlay: null };
  // Live AI tuning tables (the same module instances the game uses, so an
  // A/B run can switch a behaviour off without a reload): dev.tuning.CLOUD.lock = 1.
  dev.tuning = { CLOUD, ROUGH_AIR };

  dev.setBot = (on) => {
    if (on) {
      dev.bot = new Bot(game, typeof on === 'object' ? on : { god: on === 'god' });
      game.autopilot = dev.bot;
    } else {
      if (game.autopilot === dev.bot) game.autopilot = null;
      game.input.releaseAll();
      dev.bot = null;
    }
    return dev.bot;
  };
  window.__bot = dev.setBot;
  // Sortie start clears game.autopilot (cinematic off): re-attach the bot.
  game.events.on('mission:start', () => { if (dev.bot) game.autopilot = dev.bot; });
  game.events.on('flow:state', ({ state }) => { if (dev.bot && state === 'sortie') game.autopilot = dev.bot; });
  if (q.has('bot')) dev.setBot(q.get('bot') === 'god' ? 'god' : true);
  if (q.has('speed')) game.timeScale = Math.min(6, Math.max(0.1, Number(q.get('speed')) || 1));

  /** Event log for automated checks: counts by type and the last few payload summaries. */
  dev.events = { counts: {}, recent: [] };
  game.events.on('*', (type, p) => {
    dev.events.counts[type] = (dev.events.counts[type] ?? 0) + 1;
    if (type === 'radio') dev.events.recent.push(`${p.callsign}: ${p.text}`);
    else if (type.startsWith('mission:') || type === 'ui:screen' || type === 'target:destroyed' || type === 'player:destroyed' || type === 'player:crash') {
      dev.events.recent.push(`${type} ${p.screen ?? p.target?.name ?? p.phase?.id ?? p.result?.state ?? ''}`);
    }
    if (dev.events.recent.length > 60) dev.events.recent.shift();
  });

  /** One-line-ish state summary for automated runs. */
  dev.status = () => {
    const h = game.hud;
    const r = game.flow.result;
    return {
      flow: game.flow.state, t: Math.round(h.time ?? 0), phase: h.mission?.phase, mission: h.mission?.state,
      obj: h.objective && `${h.objective.text} ${h.objective.progress}/${h.objective.total}`,
      score: h.score, hp: Math.round((h.health ?? 0) * 100), spd: Math.round(h.speed), alt: Math.round(h.altitude), agl: Math.round(h.agl),
      wpn: h.weapon && `${h.weapon.short} ${h.weapon.ammo} | msl ${h.weapons.msl.ammo} gun ${h.gun.ammo} flr ${h.flares.count}`,
      tgt: h.target && `${h.target.name} ${Math.round(h.target.distance)}m hp${Math.round(h.target.health * 100)}`,
      lock: h.lock?.state, warn: h.warning, bot: dev.bot?.state,
      pos: [Math.round(game.flight.position.x), Math.round(game.flight.position.z)],
      result: r && { state: r.state, reason: r.reason, score: r.score, rank: r.rank, time: Math.round(r.time), kills: r.kills, acc: +r.accuracy.toFixed(2), breakdown: r.breakdown },
    };
  };
  /**
   * Step the whole game without rendering (automated mission runs; also works
   * in a background tab where requestAnimationFrame is throttled). Stops when
   * the flow leaves the sortie.
   */
  dev.sim = (seconds, dt = 1 / 30) => {
    // Slow-motion kill cams would stretch a headless run; switch them off.
    if (game.cameraRig.options) game.cameraRig.options.killCam = false;
    game.timeScale = Math.max(game.timeScale, 1);
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      // A tab that goes to the background auto-pauses the flow; a headless run
      // has nobody to press resume.
      if (game.flow.state === 'pause') game.flow.resume();
      game.update(dt);
      if (game.flow.state !== 'sortie') break;
    }
    return dev.status();
  };

  // ---- measured bot runs ------------------------------------------------
  // dev.run('m1') flies one sortie with the bot (real input path, damage on)
  // and resolves to a record: outcome, time, score, where the damage came
  // from, what killed the pilot, what the hostile missiles did. dev.batch
  // repeats it. Results accumulate in dev.runs; dev.table() is the summary.
  dev.runs = [];
  dev.progress = null;
  const tele = { on: false };
  const kindOf = (src) => (src?.isMissile ? src.weapon?.id : src?.kind) ?? 'unknown';
  game.events.on('player:hit', ({ damage, source, weapon }) => {
    if (!tele.on) return;
    const k = `${kindOf(source)}${weapon === 'e_gun' && source?.class === 'air' ? ' gun' : weapon?.includes('aam') ? ' missile' : ''}`;
    tele.damage[k] = Math.round(((tele.damage[k] ?? 0) + damage) * 10) / 10;
    tele.lastHit = k;
  });
  game.events.on('missile:launch', ({ missile: m }) => {
    if (!tele.on || m.target !== game.systems.combat.player) return;
    const w = m.weapon.id;
    (tele.inbound[w] ??= { fired: 0, hit: 0, decoyed: 0, missed: 0 }).fired++;
    m._tele = w;
  });
  game.events.on('missile:end', ({ missile: m, reason }) => {
    if (!tele.on || !m._tele) return;
    const r = tele.inbound[m._tele];
    if (reason === 'hit' && !m.decoyed) r.hit++; else if (m.decoyed) r.decoyed++; else r.missed++;
  });
  game.events.on('mission:phase', ({ phase }) => { if (tele.on) tele.phases.push(`${phase.id}@${Math.round(game.systems.missions.runner?.time ?? 0)}`); });
  game.events.on('player:destroyed', ({ cause }) => { if (tele.on) tele.death = `shot down: ${tele.lastHit ?? cause}`; });
  game.events.on('player:crash', ({ position }) => {
    if (!tele.on || tele.death) return;
    tele.death = `crashed (${dev.bot?.state ?? '-'}) at ${Math.round(position.x)},${Math.round(position.z)}`;
  });
  const tick = () => new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0); });

  dev.run = async (id, { special, bot = {}, difficulty, maxSeconds = 1500, dt = 1 / 30 } = {}) => {
    if (difficulty) game.flow.setDifficulty?.(difficulty);
    dev.setBot(bot);
    Object.assign(tele, { on: true, damage: {}, inbound: {}, phases: [], death: null, lastHit: null });
    // The mission's own default loadout unless one is asked for (flow would
    // otherwise carry the last sortie's choice over).
    special ??= game.flow.missions.find((m) => m.id === id)?.special;
    if (!game.flow.startMission(id, { special })) { tele.on = false; return null; }
    game.autopilot = dev.bot;
    let spent = 0;
    const wall = performance.now();
    while (spent < maxSeconds && game.flow.state === 'sortie') {
      dev.sim(5, dt);
      spent += 5;
      dev.progress = { id, t: Math.round(game.hud.time ?? 0), phase: game.hud.mission?.phase, hp: Math.round((game.hud.health ?? 0) * 100), bot: dev.bot?.state };
      await tick();
    }
    tele.on = false;
    const r = game.flow.result;
    const st = game.systems.combat.world.stats;
    const combat = game.systems.combat;
    const rec = {
      id, special: game.flow.special, difficulty: game.flow.difficulty ?? 'normal',
      outcome: r ? (r.completed ? 'win' : r.reason) : 'timeout', time: Math.round(r?.time ?? spent), score: r?.score ?? 0, rank: r?.rank ?? null,
      hp: Math.round((r?.health ?? 0) * 100), damage: tele.damage, death: r?.completed ? null : (tele.death ?? r?.reason ?? 'timeout'),
      inbound: tele.inbound, phases: tele.phases, kills: r?.kills ?? st.kills, accuracy: +(r?.accuracy ?? 0).toFixed(2),
      ammo: { msl: combat.msl.ammo, sp: combat.sp.ammo, gun: combat.gun.ammo, flares: combat.flares.count },
      breakdown: r?.breakdown ?? null, bot: { ...dev.bot.stats }, wallSeconds: +((performance.now() - wall) / 1000).toFixed(1),
    };
    dev.runs.push(rec);
    dev.progress = null;
    return rec;
  };

  dev.batch = async (id, n = 5, opts = {}) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await dev.run(id, opts));
    return out;
  };

  /** Per-mission summary of dev.runs (optionally filtered). */
  dev.table = (filter = () => true) => {
    const by = {};
    for (const r of dev.runs.filter(filter)) (by[`${r.id}/${r.difficulty}`] ??= []).push(r);
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
    return Object.entries(by).map(([key, rs]) => {
      const wins = rs.filter((r) => r.outcome === 'win');
      const deaths = {};
      for (const r of rs) if (r.death) { const k = r.death.replace(/ at .*/, ''); deaths[k] = (deaths[k] ?? 0) + 1; }
      const dmg = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.damage)) dmg[k] = (dmg[k] ?? 0) + v / rs.length;
      for (const k of Object.keys(dmg)) dmg[k] = Math.round(dmg[k]);
      const inbound = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.inbound)) { const o = (inbound[k] ??= { fired: 0, hit: 0, decoyed: 0, missed: 0 }); for (const f of Object.keys(o)) o[f] += v[f]; }
      return {
        key, runs: rs.length, wins: wins.length, avgTime: avg(wins.map((r) => r.time)), avgScore: avg(wins.map((r) => r.score)),
        ranks: wins.map((r) => r.rank).join(''), avgHp: avg(wins.map((r) => r.hp)), deaths, dmgPerRun: dmg, inbound,
      };
    });
  };

  /**
   * Scripted playthrough for verifying mission scripts end to end. It does
   * NOT fly: it repositions the aircraft onto a firing solution for the next
   * objective, then uses the real input actions (lock, missile, optic) and
   * lets the real simulation resolve it. Lock-on, guidance, damage, AI,
   * triggers, radio, scoring and flow are all the shipping code; only the
   * flying in between is skipped (and damage to the player is off).
   */
  dev.autoplay = (budget = 1500) => {
    const combat = game.systems.combat;
    const f = game.flight;
    const input = game.input;
    const log = [];
    let spent = 0;
    const run = (s) => { spent += s; return dev.sim(s); };
    while (spent < budget && game.flow.state === 'sortie') {
      combat.world.god = true;
      const list = combat.world.targets.filter((t) => t.alive && t !== combat.player);
      const t = list.find((x) => x.kind === 'post' && !x.captured)
        ?? list.find((x) => x.class === 'air' && x.team === 'hostile' && game.systems.ai.hostile && (x.isTarget || !game.hud.objective?.marker))
        ?? list.filter((x) => x.isTarget).sort((a, b) => a.position.distanceTo(f.position) - b.position.distanceTo(f.position))[0];
      if (!t) {
        const mk = game.hud.objective?.marker;
        if (mk) game.spawnAt({ x: mk.x, z: mk.z, agl: 1500, heading: 90, speed: 240 });
        run(4);
        continue;
      }
      if (t.class === 'air') {
        // Saddle up 1.4 km behind it, co-speed.
        const v = t.velocity, sp = v.length() || 1;
        const hdg = (Math.atan2(v.x, -v.z) * 180) / Math.PI;
        const px = t.position.x - (v.x / sp) * 1400, pz = t.position.z - (v.z / sp) * 1400;
        game.spawnAt({ x: px, z: pz, alt: Math.max(t.position.y - (v.y / sp) * 1400, terrainHeight(px, pz) + 500), heading: hdg, speed: sp });
      } else {
        // 3 km out, 550 m above, on the side with a clear line of sight.
        let best = null;
        for (let a = 0; a < 360; a += 30) {
          const r = (a * Math.PI) / 180;
          const x = t.position.x + Math.sin(r) * 3000, z = t.position.z - Math.cos(r) * 3000, y = t.position.y + 550;
          let clear = true;
          for (let k = 1; k < 30 && clear; k++) {
            const u = k / 30;
            if (y + (t.position.y + 6 - y) * u < terrainHeight(x + (t.position.x - x) * u, z + (t.position.z - z) * u) + 25) clear = false;
          }
          if (clear) { best = { x, z, alt: y, heading: (a + 180) % 360, speed: 200 }; break; }
        }
        game.spawnAt(best ?? { x: t.position.x, z: t.position.z + 3000, alt: t.position.y + 1500, heading: 0, speed: 200 });
      }
      combat.setTarget(t);
      const before = t.health;
      if (t.kind === 'post') {
        input.setAction('optic', true);
        run(2.5);
        input.setAction('optic', false);
      } else {
        const wantSp = t.class === 'air' && combat.sp.def.type === 'missile' && combat.sp.ammo > 0;
        if ((combat.current === 'sp') !== wantSp) combat.switchWeapon();
        for (let i = 0; i < 12 && combat.lock.state !== 'locked' && t.alive; i++) run(0.25);
        input.pressAction('fireMissile');
        run(0.3);
        input.pressAction('fireMissile');
        run(t.class === 'air' ? 5 : 6);
      }
      log.push(`${t.name}${t.alive ? (t.captured ? ' photographed' : ` ${Math.round(before)}->${Math.round(t.health)}`) : ' destroyed'}`);
    }
    return { spent: Math.round(spent), log, status: dev.status() };
  };

  if (q.get('debug') !== '0') dev.overlay = createOverlay(game);
  return dev;
}

function createOverlay(game) {
  const root = document.createElement('div');
  root.id = 'dev-overlay';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;font:12px/1.35 ui-monospace,Consolas,monospace;color:#b7f5c0;text-shadow:0 0 3px #000,0 0 2px #000';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  const text = document.createElement('pre');
  text.style.cssText = 'position:absolute;left:10px;top:8px;margin:0;white-space:pre';
  const menu = document.createElement('pre');
  menu.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;white-space:pre-wrap;max-width:760px;padding:18px 22px;background:#05080cc8;border:1px solid #b7f5c055;font-size:14px;display:none';
  const radio = document.createElement('div');
  radio.style.cssText = 'position:absolute;left:50%;bottom:11%;transform:translateX(-50%);max-width:70%;text-align:center;font-size:15px;color:#fff';
  root.append(canvas, text, menu, radio);
  document.body.appendChild(root);
  const ctx = canvas.getContext('2d');
  const scratch = { x: 0, y: 0 };

  // ui+hud edit (lead request): with the real HUD present the overlay only
  // shows behind ?debughud (?debug kept as an alias); without a ui it shows.
  const q = new URLSearchParams(location.search);
  const forced = q.has('debughud') || q.has('debug');
  function frame() {
    requestAnimationFrame(frame);
    const hasUi = !!(game.systems.ui || game.systems.hud);
    root.style.display = hasUi && !forced ? 'none' : 'block';
    if (root.style.display === 'none') return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const hud = game.hud;
    const flow = game.flow;
    const combat = game.systems.combat;

    // ---- menus (fallback UI) ----
    let m = '';
    if (flow.state === 'title') m = 'SAFED SAGAR\n\nWebGPU air combat over the Kargil Himalaya\n\n[Enter] start';
    else if (flow.state === 'select') {
      m = 'SELECT MISSION   (1-5 pick, Enter briefing, Backspace title)\n\n' + flow.missions.map((x, i) =>
        `${x.id === flow.selected ? '>' : ' '} ${i + 1}. ${x.name.padEnd(16)} ${x.location.padEnd(34)} ${x.unlocked ? (x.best?.completed ? `best ${x.best.bestRank ?? '-'} ${x.best.bestScore}` : 'open') : 'LOCKED'}`).join('\n');
    } else if (flow.state === 'briefing') {
      const x = flow.mission;
      m = `${x.name.toUpperCase()} — ${x.location}\n\n${x.briefing.join('\n\n')}\n\nSPECIAL WEAPON (R to change): ${x.specials.map((s) => (s.id === flow.special ? `[${s.name}]` : s.name)).join('  ')}\n\n[Enter] launch   [Backspace] back`;
    } else if (flow.state === 'pause') m = 'PAUSED\n\n[Esc] resume   [Backspace] quit to menu\n\n' + controlsText(game);
    else if (flow.state === 'remembrance') m = `${flow.result.remembrance.title.toUpperCase()}\n\n${flow.result.remembrance.lines.join('\n\n')}\n\n[Enter] continue`;
    else if (flow.state === 'debrief') {
      const r = flow.result;
      m = `${r.name.toUpperCase()} — ${r.completed ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED'}\n${r.reasonText ?? ''}\n\n` +
        `RANK ${r.rank ?? '-'}    SCORE ${r.score}${r.newBest ? '  (new best)' : ''}\n` +
        `targets ${r.breakdown.targets}  bonuses ${r.breakdown.bonuses}  time ${r.breakdown.time}  accuracy ${r.breakdown.accuracy}  survival ${r.breakdown.survival}\n` +
        `time ${clock(r.time)}   kills ${r.kills} (air ${r.airKills}, ground ${r.groundKills})   accuracy ${fmt(r.accuracy * 100)}%   damage taken ${fmt(r.damageTaken)}\n\n[Enter] missions   [Backspace] retry`;
    }
    menu.style.display = m ? 'block' : 'none';
    menu.textContent = m;

    radio.textContent = hud.radio ? `${hud.radio.callsign}: ${hud.radio.text}` : '';

    // ---- text ----
    const lines = [`[${flow.state}] ${hud.mission ? `${hud.mission.id} ${hud.mission.name} / ${hud.mission.phase} (${hud.mission.state})` : ''}  x${game.timeScale}${game.dev?.bot ? '  BOT' : ''}`];
    if (hud.mission) {
      lines.push(`TIME ${clock(hud.time)}${hud.timeLimit ? ` / ${clock(hud.timeLimit)}` : ''}   SCORE ${hud.score}`);
      const o = hud.objective;
      if (o) lines.push(`OBJ  ${o.text}${o.total ? `  ${o.progress}/${o.total}` : ''}`);
    }
    if (hud.weapon) {
      lines.push(`SPD ${fmt(hud.speed)} m/s  ALT ${fmt(hud.altitude)}  AGL ${fmt(hud.agl)}  HDG ${fmt(hud.heading)}  G ${fmt(hud.gLoad, 1)}  THR ${fmt(hud.throttle * 100)}%${hud.reheat ? ' AB' : ''}${hud.highG > 0.3 ? ' HIGH-G' : ''}`);
      lines.push(`HP ${fmt(hud.health * 100)}%  ${hud.controlMode}  WARN ${hud.warning}${hud.lockWarning ? '  [LOCK WARNING]' : ''}`);
      const wp = hud.weapon;
      lines.push(`WPN ${wp.current === 'sp' ? 'SP ' : 'MSL'} ${wp.name} ${wp.ammo}/${wp.maxAmmo} ${wp.ready ? 'RDY' : `rld ${fmt(wp.reload * 100)}%`} | MSL ${hud.weapons.msl.ammo} | ${hud.weapons.sp.short} ${hud.weapons.sp.ammo} | GUN ${hud.gun.ammo}${hud.gun.firing ? ' *' : ''} | FLR ${hud.flares.count}`);
      const tg = hud.target;
      lines.push(tg ? `TGT ${tg.name}${tg.isTarget ? ' [TGT]' : ''} ${fmt(tg.distance / 1000, 1)} km  hp ${fmt(tg.health * 100)}%  LOCK ${hud.lock.state} ${fmt(hud.lock.progress * 100)}%` : 'TGT none');
      if (hud.threats?.length) lines.push(`MISSILE x${hud.threats.length}  ${hud.threats.map((t) => `${t.kind} ${fmt(t.distance)}m ${fmt(t.bearing)}deg ${t.level}`).join(' | ')}`);
      if (hud.recon) lines.push(`RECON ${hud.recon.captured}/${hud.recon.total} ${hud.recon.active ? `OPTIC q=${fmt(hud.recon.quality, 2)} hold ${fmt(hud.recon.progress * 100)}%` : '(hold V)'}`);
      lines.push(`targets ${hud.targets.length}  missiles ${combat.world.missiles.length}  bullets ${combat.world.bullets.n}`);
    }
    text.textContent = lines.join('\n');

    if (flow.state !== 'sortie' || !hud.targets) return;
    // ---- markers ----
    ctx.lineWidth = 1.5;
    ctx.font = '11px ui-monospace,Consolas,monospace';
    for (const o of hud.targets) {
      if (!o.onScreen) continue;
      const x = o.screen.x * w, y = o.screen.y * h;
      const s = o.selected ? 16 : 10;
      ctx.strokeStyle = o.locked ? '#ff3b30' : o.selected ? '#ffe066' : o.team === 'neutral' ? '#7cc7ff' : o.isTarget ? '#ff9f43' : '#8aff9a';
      if (o.class === 'air') ctx.strokeRect(x - s, y - s, s * 2, s * 2);
      else { ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.stroke(); }
      if (o.selected || o.isAce || o.distance < 4000) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`${o.name} ${fmt(o.distance / 1000, 1)}`, x + s + 4, y + 4);
      }
    }
    // boresight, gun lead, CCIP
    ctx.strokeStyle = '#b7f5c0';
    const f = game.flight;
    const fwd = f.position.clone().addScaledVector(f.forward, 2000);
    if (combat.project(fwd, scratch)) { const x = scratch.x * w, y = scratch.y * h; ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke(); }
    if (hud.gun.lead && combat.project(hud.gun.lead, scratch)) { ctx.strokeStyle = '#ffe066'; ctx.beginPath(); ctx.arc(scratch.x * w, scratch.y * h, 7, 0, 6.3); ctx.stroke(); }
    if (hud.weapon.ccip && combat.project(hud.weapon.ccip, scratch)) { ctx.strokeStyle = '#ff9f43'; ctx.beginPath(); ctx.arc(scratch.x * w, scratch.y * h, 11, 0, 6.3); ctx.moveTo(scratch.x * w, scratch.y * h - 16); ctx.lineTo(scratch.x * w, scratch.y * h + 16); ctx.stroke(); }
    for (const t of hud.threats ?? []) {
      if (combat.project(t.position, scratch)) { ctx.strokeStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(scratch.x * w, scratch.y * h, 6, 0, 6.3); ctx.stroke(); }
    }
  }
  requestAnimationFrame(frame);
  return root;
}

function controlsText(game) {
  const b = game.input.bindings;
  return Object.values(b).map((x) => `${x.label.padEnd(52)} ${x.keys.join(' / ')}`).join('\n');
}
