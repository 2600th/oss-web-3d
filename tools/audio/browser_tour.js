// Scripted in-browser audio verification (paste into devtools or run through
// chrome-devtools `evaluate_script`; needs a dev build: window.__audioTest).
// Fires synthetic contract events, samples every bus's AnalyserNode RMS every
// 100 ms and returns { timeline, events, checks } for tools/audio/plot_browser.py.
async () => {
  const A = window.__audio;
  const T = window.__audioTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  const now = () => +((performance.now() - t0) / 1000).toFixed(2);
  const timeline = [];
  const events = [];
  const checks = {};
  let run = true;
  (async () => {
    while (run) {
      const m = {};
      for (const b of ['master', 'music', 'sfx', 'ui', 'radio', 'ambience']) {
        const v = A.meter(b);
        m[b] = Number.isFinite(v) ? +v.toFixed(1) : null;
      }
      const last = A.music.last;
      timeline.push({ t: now(), ...m, cue: A.music.cue, level: +last.level.toFixed(3), w: last.weights.map((x) => +x.toFixed(3)),
        duck: +A.engine.musicDuck.gain.value.toFixed(3) });
      await sleep(100);
    }
  })();
  // scenarios that hold state (lock, alerts, cloud) resolve late, so they are not awaited
  const ev = async (label, fn, wait) => { events.push({ t: now(), label }); fn(); if (wait) await sleep(wait); };
  const peak = (bus, from, to) => Math.max(...timeline.filter((r) => r.t >= from && r.t <= to && r[bus] !== null).map((r) => r[bus]), -200);
  const min = (bus, from, to) => Math.min(...timeline.filter((r) => r.t >= from && r.t <= to).map((r) => (r[bus] === null ? -200 : r[bus])), 0);

  await ev('menu', () => T('music:menu'), 6000);
  checks.menuCue = A.music.cue;
  checks.menuMusicPeakDb = peak('music', 2, now());
  let s = now();
  await ev('cruise', () => T('music:cruise'), 6000);
  checks.cruiseCue = A.music.cue;
  s = now();
  await ev('combat 0.1', () => T('music:combat:0.1'), 5000);
  checks.combatCue = A.music.cue;
  const p = A.music.playing;
  checks.combatStems = p?.sources.length;
  checks.combatStemsSameStart = p ? p.sources.every((x) => x.src.buffer.duration === p.sources[0].src.buffer.duration) : false;
  checks.combatLoop = p ? { loopStart: p.sources[0].src.loopStart, loopEnd: p.sources[0].src.loopEnd, buffer: p.sources[0].src.buffer.duration } : null;
  await ev('combat 0.5', () => T('music:combat:0.5'), 5000);
  checks.weightsAt05 = A.music.last.weights.map((x) => +x.toFixed(2));
  await ev('combat 1.0', () => T('music:combat:1'), 5000);
  checks.weightsAt1 = A.music.last.weights.map((x) => +x.toFixed(2));
  const xfadeFrom = s;
  checks.musicMinDuringCrossfadesDb = min('music', xfadeFrom + 1, now());
  s = now();
  await ev('radio', () => T('radio'), 600);
  checks.duckDuringRadio = +A.engine.musicDuck.gain.value.toFixed(3);
  await sleep(4500);
  checks.radioPeakDb = peak('radio', s, now());
  checks.duckAfterRadio = +A.engine.musicDuck.gain.value.toFixed(3);
  s = now();
  await ev('explosion near', () => T('explosion-near'), 2500);
  checks.explosionNearSfxPeakDb = peak('sfx', s, now());
  s = now();
  await ev('explosion far (3.5 km)', () => T('explosion-far'), 13000);
  const farRows = timeline.filter((r) => r.t >= s);
  const base = Math.max(...farRows.filter((r) => r.t < s + 5).map((r) => r.sfx ?? -200));
  const arrival = farRows.find((r) => r.t > s + 5 && (r.sfx ?? -200) > base + 3);
  checks.farExplosionArrivalS = arrival ? +(arrival.t - s).toFixed(2) : null; // expect ≈ 3500/325 = 10.8 s
  await ev('lock', () => T('lock'), 600);
  checks.lockWarn = [...A.warnings.active.keys()];
  await sleep(3500);
  await ev('missile alert', () => T('missile-alert'), 800);
  checks.missileWarn = [...A.warnings.active.keys()];
  await sleep(2500);
  s = now();
  await ev('gun', () => T('gun'), 1800);
  checks.gunSfxPeakDb = peak('sfx', s, now());
  await ev('flyby', () => T('flyby'), 6000);
  await ev('view cockpit', () => T('view:cockpit'), 2000);
  checks.cockpitBlend = +A.jet.blend.toFixed(2);
  checks.worldFilterCockpitHz = Math.round(A.engine.worldFilter.frequency.value);
  await ev('view chase', () => T('view:chase'), 1500);
  await ev('cloud', () => T('cloud', { ms: 2500 }), 1200);
  checks.worldFilterInCloudHz = Math.round(A.engine.worldFilter.frequency.value);
  await sleep(2000);
  s = now();
  await ev('victory', () => { window.__game.events.emit('mission:complete', {}); }, 6000);
  checks.victoryCue = A.music.cue;
  await ev('memorial', () => T('music:memorial'), 5000);
  checks.memorialCue = A.music.cue;
  await ev('ui confirm', () => T('ui:confirm'), 800);
  checks.uiPeakDb = peak('ui', now() - 1, now());
  run = false;
  checks.voiceStats = { ...A.voices.stats };
  checks.state = A.engine.ctx.state;
  checks.sampleRate = A.engine.ctx.sampleRate;
  checks.format = A.bank.format;
  checks.bankErrors = A.bank.errors;
  return { timeline, events, checks };
}
