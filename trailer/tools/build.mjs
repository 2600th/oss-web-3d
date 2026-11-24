// Builds index.html and the scene files from one cut list.
//   node tools/build.mjs
// The output is ordinary static HyperFrames HTML (no runtime script makes
// timed elements). Edit the tables here and rebuild, or edit the HTML and
// stop using this script.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const FPS = 30;
const fr = (t) => Math.round(t * FPS) / FPS; // snap to the frame grid
const n3 = (t) => +fr(t).toFixed(4);
const DUR = 57;

// ── Picture ── [id, file, start, end, mediaStart]. P: placeholder until the combat reels are shot.
const SHOTS = [
  // I. Dawn: the valley is yours, then the ridge opens up (Noir Now build; silence 6.8–9.0)
  ['s01', 'dawn-track', 0.0, 2.81, 0.2],
  ['s02', 'dawn-fpv', 2.81, 4.75, 0.6],
  ['s03', 'strike-aaa-chase', 4.75, 6.68, 4.0], // AAA tracers whipping past, valley floor
  ['s04', 'strike-sam-chase', 6.68, 8.04, 1.0], // SAM in, the break, flare fan
  ['s05', 'strike-aaa-cockpit3', 8.04, 9.01, 0.2], // cockpit: eight guns' streams past the glass
  // Title on the hit (9.01)
  ['s06', 'gold-orbit', 9.01, 12.77, 0.8],
  // II. The sortie (Noir Now drums)
  ['s07', 'dawn-pass', 12.77, 14.71, 0.0],
  ['s08', 'strike-gun-chase', 14.71, 16.66, 1.33], // gun run: rounds walking in
  ['s09', 'strike-supply-kill', 16.66, 18.07, 0.45], // the dump goes up (kill cam)
  ['s10', 'dog-cross5-cockpit', 18.07, 19.52, 0.33], // a flight of four crosses the windscreen at ~100 m ("Tally four")
  ['s11', 'dog-pursuit', 19.52, 22.16, 0.3], // over the shoulder: the bandit 40 m ahead, weaving in burner
  ['s12', 'dog-msl-b', 22.16, 23.41, 0.0], // the launch (22.36)
  ['s13', 'dog-msl-b', 23.41, 26.25, 3.03], // whip onto the missile (23.71), the hit (24.65), breakup
  ['s14', 'dog-kill-fq', 26.25, 27.16, 0.2], // a second kill, front quarter
  ['s15', 'storm-chase', 27.16, 28.66, 0.2], // storm: lightning ahead
  ['s16', 'storm-fpv', 28.66, 30.07, 0.6],
  ['s17', 'storm-track', 30.07, 31.07, 0.7],
  ['s18', 'night-chase', 31.07, 33.3, 1.2], // night: the road
  ['s19', 'night-fpv', 33.3, 34.62, 0.0],
  ['s20', 'night-track', 34.62, 36.4, 1.4],
  ['s21', 'night-pass', 36.4, 37.5, 0.2],
  // III. Payoff, then the cliffhanger (Noir Now's drums, looped; the music stops dead at 49.89)
  ['s22', 'ab-lightup', 37.8, 40.52, 0.05],
  ['s23', 'ab-climb', 40.52, 42.56, 0.5],
  ['s24', 'ab-breakout-chase', 42.56, 45.98, 0.3],
  ['s25', 'ab-breakout-long', 45.98, 47.5, 1.0], // calm above the cloud sea: "Come home."
  // Cliffhanger: a bandit on the six. First the jet, big, from a camera ahead
  // of it: the smoke trail closes on its tail and the flares go (48.77).
  // Then the missile camera rides the shot in; its last frame is clip frame
  // 73 (the plume right on the jet), the next would be the impact. Cut to
  // black on the downbeat.
  ['s26', 'cliff-mount', 47.5, 48.9, 0.733],
  ['s27', 'cliff-msl2', 48.9, 49.9, 1.433],
];
const BLACK = [[37.5, 37.8], [49.9, 50.4]]; // a breath before the light-up; the cut to black
const FLASH = [24.65]; // the one missile hit: 3 white frames
const ENDCARD = { start: 50.4, end: DUR }; // its own black, the title wipes in 0.68 s later
const TITLE = { start: 9.01, end: 12.77 };

// ── Radio ── [id, file, start, callsign, text] (text verbatim from assets/voice/lines.tsv)
const RADIO = [
  ['r1', 0.35, 'KESAR TOWER', 'Vajra One, Kesar Tower. The valley is yours.'],
  ['r3', 4.8, 'ANVIL SIX', 'Guns on both shoulders of the ridge! Tracers coming up!'],
  ['r4', 13.0, 'SHIKHAR', 'Vajra One, you are cleared hot.'],
  ['r5', 18.2, 'VAJRA TWO', 'Tally four. Split them, lead.'],
  ['r6', 20.8, 'VAJRA ONE', 'Vajra One, Fox Two.'],
  ['r7', 31.25, 'ANVIL SIX', 'Lights on the road, Vajra. A string of them.'],
  ['r8', 43.15, 'SHIKHAR', 'Sky is clear. Outstanding work, Vajra One. Come home.'],
  ['r9', 47.75, 'VAJRA TWO', 'Missile, missile! Break!'], // src/missions/cast.js missileWarning
];
const voiceDur = {};
for (const [id] of RADIO) {
  const f = path.join(root, 'assets/voice', `${id}.wav`);
  const b = fs.readFileSync(f); // WAV: duration from the data chunk
  const rate = b.readUInt32LE(28); // byte rate
  let o = 12, data = 0;
  while (o < b.length - 8) { const tag = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (tag === 'data') { data = sz; break; } o += 8 + sz; }
  voiceDur[id] = data / rate;
}

// ── Sound effects ── [id, file, start, volume, opts]  (the game's own SFX unless noted)
const SFX = [
  ['x01', 'jet_flyby_1.m4a', 0.5, 0.55],
  ['x02', 'aaa_burst_1.m4a', 4.85, 0.5],
  ['x03', 'aaa_burst_2.m4a', 5.9, 0.45],
  ['x04', 'sam_launch_1.m4a', 6.72, 0.55, { dur: 1.8, fadeOut: 0.4 }],
  ['x05', 'flare_pop_1.m4a', 7.0, 0.5],
  ['x06', 'flak_burst_1.m4a', 8.08, 0.6],
  ['x07', 'impact-bass-1.mp3', 9.0, 0.5],
  ['x08', 'jet_flyby_2.m4a', 12.8, 0.5],
  ['x09', 'gun_start.m4a', 14.85, 0.5],
  ['x10', 'gun_loop.m4a', 15.15, 0.5, { fadeOut: 0.15 }],
  ['x11', 'gun_tail_1.m4a', 16.3, 0.45],
  ['x12', 'exp_body_1.m4a', 16.7, 0.6],
  ['x13', 'jet_flyby_3.m4a', 18.07, 0.5],
  ['x14', 'missile_launch_1.m4a', 22.36, 0.6],
  ['x15', 'missile_pass_1.m4a', 23.71, 0.45],
  ['x16', 'exp_fireball.m4a', 24.68, 0.7],
  ['x17', 'thunder_clap.mp3', 27.45, 0.6, { dur: 3.4, fadeOut: 1.2 }], // CC BY, credited
  ['x18', 'thunder_clap.mp3', 30.4, 0.45, { dur: 2.0, fadeOut: 0.8, ms: 0.2 }],
  ['x19', 'exp_far_1.m4a', 33.3, 0.55, { dur: 2.5, fadeOut: 0.8 }],
  ['x20', 'missile_launch_2.m4a', 35.65, 0.55],
  ['x21', 'riser.mp3', 34.9, 0.4, { ms: 0.3, dur: 3.0, fadeIn: 0.6, fadeOut: 0.3 }],
  ['x22', 'ab_roar.m4a', 38.45, 0.6, { dur: 4.0, fadeOut: 1.5 }],
  ['x23', 'impact-bass-1.mp3', 38.48, 0.55],
  ['x24', 'cloud_rush.m4a', 40.4, 0.4, { dur: 2.6, fadeIn: 0.4, fadeOut: 0.6 }],
  ['x25', 'exp_body_1.m4a', 26.27, 0.55], // the second kill
  ['x26', 'missile_alert.wav', 47.6, 0.32, { dur: 2.29 }], // the game's missile warning (tools/bed.py), cut with the music
  ['x27', 'missile_motor.m4a', 47.7, 0.7, { dur: 2.19, fadeIn: 0.5 }], // riding the missile in
  ['x28', 'impact-bass-1.mp3', 51.08, 0.55], // the end-card title
  ['x29', 'flare_pop_1.m4a', 48.77, 0.5], // the cliffhanger break
];

// Music ducks under each radio call
const duck = [{ t: 0, v: 1 }];
for (const [id, start] of RADIO) {
  const a = n3(start - 0.12), b = n3(start + voiceDur[id] + 0.1);
  duck.push({ t: n3(a - 0.15), v: 1 }, { t: a, v: 0.42 }, { t: b, v: 0.42 }, { t: n3(b + 0.35), v: 1 });
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const jsonAttr = (o) => JSON.stringify(o).replace(/"/g, '&quot;');

const fontFaces = `
      @font-face { font-family: 'Big Shoulders Display'; font-weight: 800; src: url('assets/fonts/big-shoulders-display-latin-800-normal.woff2') format('woff2'); }
      @font-face { font-family: 'B612 Mono'; font-weight: 400; src: url('assets/fonts/b612-mono-latin-400-normal.woff2') format('woff2'); }
      @font-face { font-family: 'B612'; font-weight: 700; src: url('assets/fonts/b612-latin-700-normal.woff2') format('woff2'); }`;

// ── index.html ──
let z = 1;
const shotTags = SHOTS.map(([id, file, s, e, ms]) => `      <video id="${id}" class="clip shot" src="assets/footage/${file}.mp4" data-start="${n3(s)}" data-duration="${n3(e - s)}" data-media-start="${ms}" data-track-index="1" muted playsinline style="z-index:${z++}"></video>`).join('\n');
const blackTags = BLACK.map(([s, e], i) => `      <div id="black${i + 1}" class="clip black" data-start="${n3(s)}" data-duration="${n3(e - s)}" data-track-index="2" style="z-index:40"></div>`).join('\n');
const flashTags = FLASH.map((s, i) => `      <div id="flash${i + 1}" class="clip flash" data-start="${n3(s)}" data-duration="${n3(3 / FPS)}" data-track-index="2" style="z-index:70"></div>`).join('\n');
const voiceTags = RADIO.map(([id, s]) => `      <audio id="v-${id}" class="clip" src="assets/voice/${id}.wav" data-start="${n3(s)}" data-duration="${n3(voiceDur[id])}" data-track-index="11" data-volume="1"></audio>`).join('\n');
const probe = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
const lanes = []; // greedy: no two effects share a Studio lane at once
const sfxTags = SFX.map(([id, file, s, vol, o = {}]) => {
  const start = n3(s);
  const len = n3(Math.min(o.dur ?? Infinity, probe(path.join(root, 'assets/sfx', file)) - (o.ms ?? 0), DUR - start));
  let lane = lanes.findIndex((end) => end <= start);
  if (lane < 0) { lane = lanes.length; lanes.push(0); }
  lanes[lane] = start + len;
  const ms = o.ms ? ` data-media-start="${o.ms}"` : '';
  const fi = o.fadeIn ? ` data-fade-in="${o.fadeIn}"` : '';
  const fo = o.fadeOut ? ` data-fade-out="${o.fadeOut}"` : '';
  return `      <audio id="${id}" class="clip" src="assets/sfx/${file}" data-start="${start}" data-duration="${len}"${ms}${fi}${fo} data-track-index="${12 + lane}" data-volume="${vol}"></audio>`;
}).join('\n');

const host = (id, s, e, track, kind = 'graphics', z = 60) => `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${n3(s)}" data-duration="${n3(e - s)}" data-track-index="${track}" data-track-kind="${kind}" data-width="1920" data-height="1080" style="z-index:${z}"></div>`;

const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <!-- Generated by tools/build.mjs from its cut list. -->
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; background: #000; }
      .shot { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
      .black { position: absolute; inset: 0; background: #000; }
      .flash { position: absolute; inset: 0; background: #fff; }
      #bars { position: absolute; inset: 0; pointer-events: none; }
      #bars i { position: absolute; left: 0; width: 1920px; height: 138px; background: #000; }
      #bars i:first-child { top: 0; }
      #bars i:last-child { bottom: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1920" data-height="1080">
${shotTags}
${blackTags}
      <div id="bars" class="clip" data-start="0" data-duration="${n3(ENDCARD.start)}" data-track-index="3" data-layout-ignore style="z-index:50"><i></i><i></i></div>
${host('title', TITLE.start, TITLE.end, 4)}
${host('radio', 0, DUR, 5, 'captions', 65)}
${flashTags}
${host('endcard', ENDCARD.start, ENDCARD.end, 4, 'graphics', 90)}
      <audio id="bed" class="clip" src="assets/music/bed.wav" data-start="0" data-duration="${DUR}" data-track-index="10" data-volume="0.8"
        data-automation="${jsonAttr({ version: 1, lanes: [{ target: 'volume', points: duck }] })}"></audio>
${voiceTags}
${sfxTags}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines['main'] = tl;
    </script>
  </body>
</html>
`;

// ── compositions/title.html ── SAFED SAGAR wipes in on the hit; the subtitle a beat later
const titleLen = TITLE.end - TITLE.start;
const title = `<template>
  <style>${fontFaces}
    #root { position: absolute; inset: 0; }
    #t-wrap { position: absolute; left: 0; right: 0; top: 330px; text-align: center; }
    #t-word { display: inline-block; font-family: 'Big Shoulders Display'; font-weight: 800; font-size: 210px; line-height: 1; letter-spacing: 0.02em; color: #F2F4F5; text-transform: uppercase; text-shadow: 0 6px 40px rgba(0,0,0,0.45); }
    #t-sub { margin-top: 26px; font-family: 'B612 Mono'; font-size: 40px; letter-spacing: 0.32em; color: #F2F4F5; }
    #t-sub span { display: inline-block; opacity: 0; }
  </style>
  <div id="root" data-composition-id="title" data-width="1920" data-height="1080">
    <div id="t-wrap">
      <div id="t-word">SAFED SAGAR</div>
      <div id="t-sub"><span>KARGIL</span> <span>HEIGHTS</span> <span>·</span> <span>1999</span></div>
    </div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#t-word', { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: ${n3(10 / FPS)}, ease: 'power3.out' }, 0);
    tl.fromTo('#t-sub span', { opacity: 0, filter: 'blur(4px)' }, { opacity: 0.92, filter: 'blur(0px)', duration: 0.16, stagger: 0.09, ease: 'power2.out' }, 0.94);
    tl.to('#t-wrap', { opacity: 0, filter: 'blur(8px)', duration: 0.2, ease: 'power3.in' }, ${n3(titleLen - 0.24)});
    window.__timelines['title'] = tl;
  </script>
</template>
`;

// ── compositions/radio.html ── one group per call, typed into the lower letterbox band
const radioLines = RADIO.map(([id, s, cs, text], i) => {
  const next = RADIO[i + 1]?.[1] ?? DUR;
  const hold = Math.min(next - s - 0.1, Math.max(voiceDur[id] + 0.15, text.length / 45 + 0.5 + 0.3 * text.split(/\s+/).length));
  return { id, s: n3(s), d: n3(hold), cs, text };
});
const radio = `<template>
  <style>${fontFaces}
    #root { position: absolute; inset: 0; }
    .line { position: absolute; left: 0; right: 0; top: 958px; text-align: center; font-family: 'B612 Mono'; font-size: 30px; line-height: 40px; color: #F2F4F5; white-space: nowrap; }
    .cs { color: rgba(242,244,245,0.6); margin-right: 1.2ch; }
    .tx { display: inline-block; vertical-align: top; }
  </style>
  <div id="root" data-composition-id="radio" data-width="1920" data-height="1080" data-layout-allow-caption-zone>
${radioLines.map((l) => `    <div id="rl-${l.id}" class="clip line" data-start="${l.s}" data-duration="${l.d}"><span class="cs">${esc(l.cs)}</span><span class="tx" id="rt-${l.id}">${esc(l.text)}</span></div>`).join('\n')}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
${radioLines.map((l) => `    tl.fromTo('#rt-${l.id}', { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: ${(l.text.length / 45).toFixed(3)}, ease: 'steps(${l.text.length})' }, ${l.s});`).join('\n')}
    window.__timelines['radio'] = tl;
  </script>
</template>
`;

// ── compositions/endcard.html ──
const endcard = `<template>
  <style>${fontFaces}
    #root { position: absolute; inset: 0; background: #000; }
    #e-wrap { position: absolute; left: 0; right: 0; top: 352px; text-align: center; }
    #e-word { display: inline-block; font-family: 'Big Shoulders Display'; font-weight: 800; font-size: 190px; line-height: 1; letter-spacing: 0.02em; color: #F2F4F5; }
    #e-rule { width: 560px; height: 5px; margin: 30px auto 0; background: #FF9933; transform-origin: 0 50%; }
    #e-cta { margin-top: 40px; font-family: 'B612 Mono'; font-size: 40px; color: #F2F4F5; }
    #e-cta span { display: inline-block; opacity: 0; }
    #e-credit { opacity: 0; position: absolute; left: 0; right: 0; top: 880px; text-align: center; font-family: 'B612 Mono'; font-size: 24px; line-height: 34px; color: rgba(242,244,245,0.55); }
  </style>
  <div id="root" data-composition-id="endcard" data-width="1920" data-height="1080">
    <div id="e-wrap">
      <div id="e-word">SAFED SAGAR</div>
      <div id="e-rule"></div>
      <div id="e-cta"><span>Play</span> <span>free</span> <span>in</span> <span>your</span> <span>browser</span></div>
    </div>
    <div id="e-credit" data-layout-ignore>Music: "Noir Now" by Drakensson (CC0) · Thunder: "Thunder Clap 1" by jzielke011 (CC BY 4.0)<br />All footage captured in game.</div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#e-word', { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.42, ease: 'power3.out' }, 0.68);
    tl.fromTo('#e-rule', { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'expo.out' }, 1.05);
    tl.fromTo('#e-cta span', { opacity: 0 }, { opacity: 1, duration: 0.18, stagger: 0.085, ease: 'power2.out' }, 2.04);
    tl.fromTo('#e-credit', { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' }, 2.7);
    window.__timelines['endcard'] = tl;
  </script>
</template>
`;

fs.mkdirSync(path.join(root, 'compositions'), { recursive: true });
fs.writeFileSync(path.join(root, 'index.html'), index);
fs.writeFileSync(path.join(root, 'compositions/title.html'), title);
fs.writeFileSync(path.join(root, 'compositions/radio.html'), radio);
fs.rmSync(path.join(root, 'compositions/claim.html'), { force: true });
fs.writeFileSync(path.join(root, 'compositions/endcard.html'), endcard);
console.log(`built: ${SHOTS.length} shots, ${RADIO.length} radio calls, ${SFX.length} effects; placeholders: ${SHOTS.filter((s) => /P:/.test(String(s))).length}`);
