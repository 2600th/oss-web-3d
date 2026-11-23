import { el, icon, flag } from '../dom.js';
import { formatScore, formatClock, formatAccuracy, groupThousands } from '../format.js';
import { worldToLonLat } from '../geo.js';

/**
 * Title, pause, debrief, memorial, credits and in-flow loading.
 *
 * Tone rules carried over from the legacy game (legacy/ui/Screens.js):
 *  - Remembrance is its own screen, with no score, rank or UI chrome around it,
 *    and nothing scored ever shares a screen with it.
 *  - The game is openly fictional; the disclaimer stays on the title.
 *  - Failure is plain and respectful: no mockery, no "game over".
 */

export const DISCLAIMER =
  'A work of fiction. Not affiliated with, endorsed by, or representing the Indian Air Force, the Indian Army, ' +
  'the Ministry of Defence, or any broadcaster or production. Hostile forces are unnamed and unmarked. ' +
  'All callsigns, positions and events depicted are invented.';

function menuItem(parent, label, detail, onClick) {
  const b = el('button', 'menu-item', parent);
  b.dataset.nav = '';
  el('span', 'menu-label', b, label);
  if (detail) el('span', 'menu-detail', b, detail);
  b.append(icon('chevron', 'icon menu-chev'));
  b.addEventListener('click', onClick);
  return b;
}

// ------------------------------------------------------------------ title --

export function buildTitle(ui) {
  const root = el('section', 'scr scr-home');
  root.setAttribute('aria-labelledby', 'title-h');
  const block = el('div', 'title-block', root);
  const h = el('h1', 'wordmark', block);
  h.id = 'title-h';
  el('span', 'wm-1', h, 'Safed');
  el('span', 'wm-2', h, 'Sagar');
  el('p', 'tagline', block, 'Air combat over the Kargil Himalaya');

  const nav = el('nav', 'menu', root);
  nav.setAttribute('aria-label', 'Main menu');
  const fly = menuItem(nav, 'Fly', 'Choose a sortie', () => ui.go('missionSelect'));
  fly.dataset.default = '';
  menuItem(nav, 'Settings', 'Controls, display, audio', () => ui.go('settings'));
  menuItem(nav, 'In remembrance', null, () => ui.go('memorial'));
  menuItem(nav, 'Credits', 'Licences and sources', () => ui.go('credits'));

  // Live position readout of the flyby jet: ties the title to the real place.
  const readout = el('p', 'title-readout', root);
  readout.setAttribute('aria-hidden', 'true');
  el('p', 'disclaimer', root, DISCLAIMER);

  return {
    id: 'title',
    root,
    noBack: true,
    update(game) {
      const f = game.flight;
      if (!f?.position) return;
      const { lon, lat } = worldToLonLat(f.position.x, f.position.z);
      const ft = Math.round((f.position.y * 3.28084) / 100);
      const hdg = Math.round(((Math.atan2(f.forward.x, -f.forward.z) * 180) / Math.PI + 360) % 360);
      readout.textContent = `${lat.toFixed(3)}N  ${lon.toFixed(3)}E   FL${String(ft).padStart(3, '0')}   HDG ${String(hdg).padStart(3, '0')}`;
    },
  };
}

// ------------------------------------------------------------------ pause --

export function buildPause(ui) {
  const root = el('section', 'scr scr-pause');
  root.setAttribute('aria-labelledby', 'pause-h');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const panel = el('div', 'pause-panel', root);
  const h = el('h2', 'scr-title', panel, 'Paused');
  h.id = 'pause-h';
  const ctx = el('p', 'pause-context', panel);
  const nav = el('nav', 'menu menu-compact', panel);
  const resume = menuItem(nav, 'Resume', null, () => ui.flow.resume());
  resume.dataset.default = '';
  menuItem(nav, 'Restart sortie', null, () => ui.flow.retry());
  menuItem(nav, 'Settings', null, () => ui.go('settings'));
  const quit = menuItem(nav, 'Quit to sorties', null, () => {
    if (quit.dataset.armed) {
      delete quit.dataset.armed;
      ui.flow.quitToMenu();
      return;
    }
    // Two-step quit: no modal, the item itself asks.
    quit.dataset.armed = '1';
    quit.querySelector('.menu-label').textContent = 'Confirm: leave this sortie';
    quit.classList.add('danger');
  });
  const disarm = () => {
    delete quit.dataset.armed;
    quit.querySelector('.menu-label').textContent = 'Quit to sorties';
    quit.classList.remove('danger');
  };
  quit.addEventListener('blur', disarm);

  return {
    id: 'pause',
    root,
    onShow() {
      disarm();
      const m = ui.flow.currentMission;
      ctx.textContent = m ? `${m.name} · ${m.location?.name ?? ''}` : 'Free flight';
    },
    back: () => ui.flow.resume(),
  };
}

// ---------------------------------------------------------------- debrief --

export function buildDebrief(ui) {
  const root = el('section', 'scr scr-debrief');
  root.setAttribute('aria-labelledby', 'debrief-h');
  const card = el('div', 'debrief', root);
  const top = el('div', 'debrief-top', card);
  const titles = el('div', 'debrief-titles', top);
  const h = el('h2', 'scr-title', titles);
  h.id = 'debrief-h';
  const line = el('p', 'debrief-line', titles);
  const stamp = el('div', 'rank-stamp', top);
  const stampLetter = el('span', 'rank-letter', stamp);
  el('span', 'rank-cap', stamp, 'Rank');

  const dl = el('dl', 'results', card);
  const rows = {};
  for (const [k, label] of [['score', 'Score'], ['kills', 'Kills'], ['accuracy', 'Accuracy'], ['time', 'Time'], ['best', 'Best']]) {
    const r = el('div', `res res-${k}`, dl);
    el('dt', '', r, label);
    rows[k] = el('dd', '', r);
  }
  const note = el('p', 'debrief-note', card);

  const actions = el('div', 'scr-actions', card);
  actions.dataset.navRow = '';
  const cont = el('button', 'btn btn-primary', actions, 'Continue');
  cont.dataset.nav = '';
  cont.dataset.default = '';
  const retry = el('button', 'btn', actions, 'Fly again');
  retry.dataset.nav = '';
  const missions = el('button', 'btn btn-quiet', actions, 'Sorties');
  missions.dataset.nav = '';
  cont.addEventListener('click', () => ui.afterDebrief());
  retry.addEventListener('click', () => ui.flow.retry());
  missions.addEventListener('click', () => ui.flow.quitToMenu());

  return {
    id: 'debrief',
    root,
    noBack: true,
    onShow() {
      const r = ui.lastResult ?? { success: false };
      const m = ui.flow.currentMission;
      const ok = r.success !== false;
      root.classList.toggle('is-fail', !ok);
      h.textContent = ok ? 'Mission complete' : 'Sortie ended';
      line.textContent = ok
        ? `${m?.name ?? 'Sortie'} · objectives secured`
        : r.reason === 'time'
          ? 'Mission incomplete: the window closed. Regroup and fly again.'
          : 'Mission incomplete. Regroup and fly again.';
      stamp.hidden = !ok || !r.rank;
      stampLetter.textContent = r.rank ?? '';
      stamp.setAttribute('aria-label', r.rank ? `Rank ${r.rank}` : '');
      rows.score.textContent = formatScore(r.score ?? 0);
      rows.kills.textContent = r.kills === undefined ? '—' : groupThousands(Array.isArray(r.kills) ? r.kills.length : r.kills);
      rows.accuracy.textContent = formatAccuracy(r.accuracy);
      rows.time.textContent = r.time === undefined ? '—' : formatClock(r.time);
      rows.best.textContent = r.best ? formatScore(r.best) : '—';
      note.textContent = r.isNewBest ? 'New best for this sortie.' : '';
      cont.textContent = ok ? 'Continue' : 'Sorties';
      missions.hidden = !ok;
      retry.textContent = ok ? 'Fly again' : 'Retry';
      return ok ? cont : retry;
    },
  };
}

// --------------------------------------------------------------- memorial --

export function buildMemorial(ui) {
  const root = el('section', 'scr scr-memorial');
  root.setAttribute('aria-label', 'In remembrance');
  const card = el('div', 'memorial', root);
  el('p', '', card, 'Inspired by the courage and sacrifice of the Indian Armed Forces during the Kargil War.');
  el('p', '', card,
    'With special respect to the Indian Air Force personnel who flew Operation Safed Sagar in support of soldiers fighting on the ground.');
  el('p', 'memorial-last', card, 'In remembrance of all those who made the supreme sacrifice in service of India.');
  const jai = el('p', 'jaihind', card, 'Jai Hind. ');
  jai.append(flag());
  const cont = el('button', 'btn btn-quiet memorial-continue', card, 'Continue');
  cont.dataset.nav = '';
  cont.addEventListener('click', () => ui.afterMemorial());
  return {
    id: 'memorial',
    root,
    onShow() {
      ui.settings.set('memorialSeen', true);
      return cont;
    },
    back: () => ui.afterMemorial(),
  };
}

// ---------------------------------------------------------------- credits --

const CREDITS = [
  ['Terrain', 'SRTM 1-arcsecond elevation, courtesy USGS / NASA, via Mapzen terrain tiles on AWS Open Data.'],
  ['Aircraft', '"MiG-21 Bison Indian" model by KojfDiscord, CC BY 4.0, optimised for the web.'],
  ['Typefaces', 'B612 and B612 Mono by the B612 Project (Airbus, Intactile Design), and Big Shoulders Display by Patric King, all under the SIL Open Font License 1.1.'],
  ['Engine', 'three.js (MIT) with its WebGPU renderer and TSL node materials.'],
  ['Techniques', 'Sky, cloud and terrain rendering follow published work (Hillaire 2020, Bruneton–Neyret, Nubis) without reusing their code.'],
];

export function buildCredits(ui) {
  const root = el('section', 'scr scr-credits');
  root.setAttribute('aria-labelledby', 'credits-h');
  const head = el('header', 'scr-head', root);
  const h = el('h2', 'scr-title', head, 'Credits');
  h.id = 'credits-h';
  el('p', 'scr-sub', head, 'Safed Sagar is an open-source, fictional flight game.');
  const dl = el('dl', 'credits', root);
  for (const [k, v] of CREDITS) {
    el('dt', '', dl, k);
    el('dd', '', dl, v);
  }
  const p = el('p', 'credits-more', root, 'Full licence texts: ');
  const a = el('a', '', p, 'THIRD_PARTY_NOTICES.txt');
  a.href = './THIRD_PARTY_NOTICES.txt';
  a.target = '_blank';
  a.rel = 'noopener';
  a.dataset.nav = '';
  el('p', 'disclaimer', root, DISCLAIMER);
  const foot = el('div', 'scr-actions', root);
  const back = el('button', 'btn', foot);
  back.append(icon('back'), 'Back');
  back.dataset.nav = '';
  back.dataset.default = '';
  back.addEventListener('click', () => ui.back());
  return { id: 'credits', root, back: () => ui.back() };
}

// ---------------------------------------------------------------- loading --

const TIPS = [
  'Terrain masks you from radar-guided launchers. Use the valleys.',
  'Flares work best released early, as the missile commits.',
  'The gun pipper shows where to aim, not where the target is.',
  'Thin air above 5,000 m: the jet turns wider and climbs slower.',
  'A locked missile flies best from behind the target, inside four kilometres.',
];

export function buildLoading(ui) {
  const root = el('section', 'scr scr-loading');
  root.setAttribute('aria-labelledby', 'loading-h');
  root.setAttribute('aria-busy', 'true');
  const box = el('div', 'loading', root);
  const h = el('h2', 'loading-title', box);
  h.id = 'loading-h';
  const where = el('p', 'loading-where', box);
  const bar = el('div', 'bar', box);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-labelledby', 'loading-h');
  const fill = el('i', '', bar);
  const label = el('p', 'loading-label', box);
  const tip = el('p', 'loading-tip', box);
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  const api = {
    id: 'loading',
    root,
    noBack: true,
    onShow(arg) {
      const m = arg?.mission ?? ui.flow.currentMission;
      h.textContent = m?.name ?? 'Loading';
      where.textContent = m?.location?.name ?? '';
      tip.textContent = TIPS[tipIndex++ % TIPS.length];
      api.setProgress(arg?.progress ?? 0, arg?.label ?? 'Preparing');
      return null;
    },
    setProgress(p, text) {
      const v = Math.max(0, Math.min(1, p));
      fill.style.transform = `scaleX(${v})`;
      bar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      if (text) label.textContent = text;
    },
  };
  return api;
}
