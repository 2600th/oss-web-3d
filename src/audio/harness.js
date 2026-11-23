/**
 * Dev-only audio test harness (loaded by system.js only when import.meta.env.DEV).
 *
 *   window.__audio                 the audio system
 *   window.__audioTest(name, opts) fire synthetic contract events
 *   window.__audioProbe()          { state, meters (dBFS RMS per bus), voices, music }
 *   ?audiotest=1                   adds a small on-screen panel with buttons
 *
 * Synthetic entities are plain objects moved by a rAF loop, so the tests work
 * before the combat/AI systems exist.
 */
const SCENARIOS = [
  'explosion-near', 'explosion-mid', 'explosion-far', 'explosion-ground', 'flak', 'gun', 'missile-player',
  'missile-flyby', 'sam', 'flare', 'hit', 'lock', 'rwr', 'missile-alert', 'pullup', 'radio', 'flyby', 'aaa',
  'music:menu', 'music:cruise', 'music:combat:0.1', 'music:combat:0.5', 'music:combat:1', 'music:ace',
  'music:victory', 'music:defeat', 'music:memorial', 'music:briefing', 'stinger:complete', 'stinger:failed',
  'ui:click', 'ui:confirm', 'ui:back', 'view:cockpit', 'view:chase', 'cloud',
];

export function installHarness(sys, game) {
  const ev = game.events;
  const L = () => sys.engine.listener;
  const ahead = (dist, side = 0, up = 0) => {
    const l = L();
    const f = l.forward;
    // right = forward × up
    const r = { x: f.y * l.up.z - f.z * l.up.y, y: f.z * l.up.x - f.x * l.up.z, z: f.x * l.up.y - f.y * l.up.x };
    return {
      x: l.position.x + f.x * dist + r.x * side + l.up.x * up,
      y: l.position.y + f.y * dist + r.y * side + l.up.y * up,
      z: l.position.z + f.z * dist + r.z * side + l.up.z * up,
    };
  };
  const movers = new Set();
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const m of movers) {
      m.position.x += m.velocity.x * dt; m.position.y += m.velocity.y * dt; m.position.z += m.velocity.z * dt;
      m.life -= dt;
      if (m.life <= 0) { m.alive = false; movers.delete(m); m.onDone?.(); }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const entity = (kind, pos, vel, life, extra = {}) => {
    const e = { id: `test-${kind}-${Math.random().toString(36).slice(2, 7)}`, kind, team: 'hostile', alive: true,
      position: { ...pos }, velocity: { ...vel }, life, ...extra };
    movers.add(e);
    return e;
  };
  // a straight pass that crosses `miss` metres beside the listener after `t` seconds
  const pass = (speed, miss, t, up = 0) => {
    const l = L();
    const f = l.forward;
    const start = ahead(speed * t, miss, up);
    return { start, vel: { x: -f.x * speed, y: -f.y * speed, z: -f.z * speed } };
  };
  const hold = (fn, ms) => new Promise((res) => setTimeout(() => { fn?.(); res(); }, ms));

  async function test(name, opts = {}) {
    sys.unlock();
    const [head, a, b] = name.split(':');
    switch (head) {
      case 'explosion-near': ev.emit('explosion', { position: ahead(opts.distance ?? 180, 60), size: opts.size ?? 'large', kind: 'air' }); break;
      case 'explosion-mid': ev.emit('explosion', { position: ahead(opts.distance ?? 900, -300), size: opts.size ?? 'large', kind: 'ground' }); break;
      case 'explosion-far': ev.emit('explosion', { position: ahead(opts.distance ?? 3500, 800), size: opts.size ?? 'huge', kind: 'ground' }); break;
      case 'explosion-ground': ev.emit('explosion', { position: ahead(opts.distance ?? 400, 0, -200), size: 'medium', kind: 'ground' }); break;
      case 'flak': for (let i = 0; i < 4; i++) setTimeout(() => ev.emit('explosion', { position: ahead(250 + Math.random() * 500, (Math.random() - 0.5) * 400, (Math.random() - 0.3) * 200), size: 'small', kind: 'flak' }), i * 380); break;
      case 'gun': ev.emit('weapon:gun', { firing: true, entity: undefined }); await hold(() => ev.emit('weapon:gun', { firing: false, entity: undefined }), opts.ms ?? 1500); break;
      case 'missile-player': {
        const l = L();
        const m = entity('missile', ahead(8, 0, -2), { x: l.forward.x * 600, y: l.forward.y * 600, z: l.forward.z * 600 }, 4, { kind: 'aam', owner: 'player' });
        ev.emit('missile:launch', { missile: m });
        m.onDone = () => ev.emit('missile:end', { missile: m, reason: 'miss' });
        break;
      }
      case 'missile-flyby': {
        const p = pass(opts.speed ?? 550, opts.miss ?? 40, 2.2);
        const m = entity('missile', p.start, p.vel, 4.5, { kind: 'aam', owner: { team: 'hostile' } });
        ev.emit('missile:launch', { missile: m });
        ev.emit('threat:missile', { missile: m, level: 'alert', bearing: 0 });
        m.onDone = () => { ev.emit('missile:end', { missile: m, reason: 'miss' }); ev.emit('threat:cleared', {}); };
        break;
      }
      case 'sam': {
        const pos = ahead(2500, 600, -600);
        const m = entity('missile', pos, { x: 0, y: 380, z: 0 }, 5, { kind: 'sam', owner: { team: 'hostile' } });
        ev.emit('missile:launch', { missile: m });
        m.onDone = () => ev.emit('missile:end', { missile: m, reason: 'fuel' });
        break;
      }
      case 'flare': for (let i = 0; i < 4; i++) setTimeout(() => ev.emit('flare:release', { flare: { position: ahead(-5), owner: 'player' } }), i * 160); break;
      case 'hit': ev.emit('player:hit', { damage: opts.damage ?? 0.2, health: opts.health ?? 0.7, source: 'test' }); break;
      case 'lock': {
        const tgt = { id: 'test-target' };
        ev.emit('lock:acquiring', { target: tgt });
        await hold(() => ev.emit('lock:locked', { target: tgt }), 1500);
        await hold(() => ev.emit('lock:lost', { target: tgt }), 2000);
        break;
      }
      case 'rwr': ev.emit('threat:missile', { level: 'warning', bearing: 1 }); await hold(() => ev.emit('threat:cleared', {}), 2500); break;
      case 'missile-alert': ev.emit('threat:missile', { level: 'alert', bearing: 1 }); await hold(() => ev.emit('threat:cleared', {}), 2500); break;
      case 'pullup': game.hud.warning = 'pullup'; await hold(() => { game.hud.warning = 'none'; }, 2500); break;
      case 'radio': ev.emit('radio', { speaker: 'AWACS', callsign: opts.callsign ?? 'Netra', priority: opts.priority ?? 1,
        text: opts.text ?? 'Vajra flight, bandits two, bearing zero-four-zero, angels twenty, closing fast.' }); break;
      case 'flyby': {
        const p = pass(opts.speed ?? 300, opts.miss ?? 70, 3.5, 20);
        const e = entity('aircraft', p.start, p.vel, 8, { engine: { throttle: 0.9, reheat: false } });
        ev.emit('aircraft:spawn', { entity: e });
        e.onDone = () => ev.emit('aircraft:despawn', { entity: e });
        break;
      }
      case 'aaa': {
        const e = entity('aaa', ahead(1500, -400, -300), { x: 0, y: 0, z: 0 }, 6, { kind: 'aaa' });
        ev.emit('weapon:gun', { firing: true, entity: e });
        e.onDone = () => ev.emit('weapon:gun', { firing: false, entity: e });
        break;
      }
      case 'music': ev.emit('music:intensity', { state: a, level: b !== undefined ? Number(b) : undefined }); break;
      case 'stinger': sys.stinger(a); break;
      case 'ui': sys.ui(a); break;
      case 'view': ev.emit('camera:mode', { mode: a }); break;
      case 'cloud': // Environment rewrites env.inCloud every frame, so override inside audio
        sys.debug.inCloud = 1;
        await hold(() => { delete sys.debug.inCloud; }, opts.ms ?? 3000);
        break;
      default: throw new Error(`unknown audio test "${name}". Try: ${SCENARIOS.join(', ')}`);
    }
    return probe();
  }

  function probe() {
    const e = sys.engine;
    const meters = {};
    for (const b of ['master', 'music', 'sfx', 'ui', 'radio', 'ambience']) meters[b] = Math.round(e.meter(b) * 10) / 10;
    return {
      state: e.ctx?.state ?? 'none', sampleRate: e.ctx?.sampleRate, format: sys.bank.format, loaded: sys.bank.loaded,
      meters, worldVoices: sys.voices.world.size, flatVoices: sys.voices.flat.size, stats: { ...sys.voices.stats },
      music: { cue: sys.music.cue, state: sys.music.last.cue, level: +sys.music.last.level.toFixed(3), weights: sys.music.last.weights.map((w) => +w.toFixed(3)) },
      warnings: [...sys.warnings.active.keys()], jet: sys.jet.state, bankErrors: sys.bank.errors.slice(0, 5),
    };
  }

  window.__audio = sys;
  window.__audioTest = test;
  window.__audioProbe = probe;
  window.__audioScenarios = SCENARIOS;

  if (new URLSearchParams(location.search).has('audiotest')) {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:8px;top:8px;z-index:9999;max-width:360px;display:flex;flex-wrap:wrap;gap:4px;'
      + 'background:rgba(10,14,20,.82);padding:8px;border-radius:6px;font:11px system-ui;color:#cde';
    for (const s of SCENARIOS) {
      const btn = document.createElement('button');
      btn.textContent = s;
      btn.dataset.sound = 'none';
      btn.style.cssText = 'font:11px system-ui;padding:3px 6px;background:#1d2a38;color:#cde;border:1px solid #345;border-radius:4px;cursor:pointer';
      btn.onclick = () => test(s);
      panel.appendChild(btn);
    }
    const meter = document.createElement('pre');
    meter.style.cssText = 'width:100%;margin:4px 0 0;font:10px ui-monospace,monospace;white-space:pre-wrap';
    panel.appendChild(meter);
    document.body.appendChild(panel);
    setInterval(() => {
      const p = probe();
      meter.textContent = `${p.state} ${p.format} voices ${p.worldVoices}/${p.flatVoices}\n`
        + Object.entries(p.meters).map(([k, v]) => `${k.padEnd(8)} ${String(v).padStart(6)} dB`).join('\n')
        + `\nmusic ${p.music.cue} L=${p.music.level} w=${p.music.weights}\nwarn ${p.warnings.join(',')}`;
    }, 250);
  }
}
