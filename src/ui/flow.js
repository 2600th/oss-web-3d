import { lonLatToWorld } from './geo.js';

/**
 * The single seam between the UI and the gameplay flow.
 *
 * Gameplay owns `game.flow` (docs/v2/ARCHITECTURE.md): `state`, `missions`,
 * `startMission(id)`, `pause()`, `resume()`, `retry()`, `quitToMenu()`, and it
 * emits `ui:screen`, `mission:complete` / `mission:failed`. Until that exists —
 * or when it is missing a method — this adapter supplies a thin local flow so
 * every screen still works: free flight for a sortie, pause by freezing the
 * game clock, and an invented mission list placed on the real map.
 *
 * `real` is read lazily on every call because gameplay may attach `game.flow`
 * after the UI system is created.
 */

export const FALLBACK_MISSIONS = [
  {
    id: 'first-light',
    name: 'First Light',
    description:
      'Hostile forces have dug in on the ridgeline above the Drass road and are shelling the convoy route. ' +
      'Go in low under the ridge, destroy the supply dumps and gun positions, and get out before their air cover wakes up.',
    location: { name: 'Tololing ridge, Drass sector', ...lonLatToWorld(75.81, 34.42) },
    threats: ['AAA', 'MANPADS'],
    unlocked: true,
    bestRank: null,
    markers: [
      { kind: 'objective', label: 'Supply dump', ...lonLatToWorld(75.815, 34.425) },
      { kind: 'objective', label: 'Gun line', ...lonLatToWorld(75.8, 34.413) },
      { kind: 'aaa', label: 'AAA', ...lonLatToWorld(75.825, 34.43), radius: 2500 },
      { kind: 'start', label: 'Ingress', ...lonLatToWorld(75.95, 34.36) },
    ],
  },
  {
    id: 'high-wire',
    name: 'High Wire',
    description:
      'A hostile fighter screen is shadowing the strike packages over Tiger Hill. Sweep the sector, hold the sky ' +
      'for the next wave, and watch for their flight lead, who flies the screen from above it.',
    location: { name: 'Tiger Hill, Mushkoh approaches', ...lonLatToWorld(75.73, 34.47) },
    threats: ['Fighters', 'Flight lead', 'SAM'],
    unlocked: true,
    bestRank: null,
    markers: [
      { kind: 'objective', label: 'CAP point', ...lonLatToWorld(75.73, 34.49) },
      { kind: 'ace', label: 'Flight lead', ...lonLatToWorld(75.66, 34.52) },
      { kind: 'sam', label: 'SAM', ...lonLatToWorld(75.69, 34.44), radius: 6000 },
      { kind: 'start', label: 'Ingress', ...lonLatToWorld(75.95, 34.55) },
    ],
  },
  {
    id: 'stone-river',
    name: 'Stone River',
    description:
      'Radar-guided launchers are covering the Indus crossings north of Batalik. Find the search radar, ' +
      'take down the launchers it cues, and open the corridor for the transports.',
    location: { name: 'Batalik, Indus valley', ...lonLatToWorld(76.36, 34.62) },
    threats: ['SAM', 'Radar', 'AAA'],
    unlocked: false,
    bestRank: null,
    markers: [
      { kind: 'objective', label: 'Search radar', ...lonLatToWorld(76.38, 34.66) },
      { kind: 'sam', label: 'SAM', ...lonLatToWorld(76.33, 34.64), radius: 7000 },
      { kind: 'sam', label: 'SAM', ...lonLatToWorld(76.42, 34.6), radius: 7000 },
      { kind: 'start', label: 'Ingress', ...lonLatToWorld(76.15, 34.5) },
    ],
  },
];

const RECORDS_KEY = 'safed-sagar.records.v1';

function loadRecords() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(RECORDS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

const RANK_ORDER = ['S', 'A', 'B', 'C', 'D'];
export function betterRank(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RANK_ORDER.indexOf(a) <= RANK_ORDER.indexOf(b) ? a : b;
}

export class FlowAdapter {
  constructor(game, ui) {
    this.game = game;
    this.ui = ui;
    this.local = { state: 'title', missionId: null };
    this.records = loadRecords();
  }

  get real() {
    const f = this.game.flow;
    return f && typeof f.startMission === 'function' ? f : null;
  }

  get state() {
    return this.real?.state ?? this.local.state;
  }

  /** Mission list with UI-side records folded in (best score/rank). */
  get missions() {
    const list = this.real?.missions;
    if (Array.isArray(list) && list.length) {
      const defs = this.game.systems?.missions?.list ?? [];
      return list.map((m) => fromRealMission(m, defs.find((d) => d.id === m.id)));
    }
    return FALLBACK_MISSIONS.map((m) => {
      const rec = this.records[m.id] ?? {};
      return {
        ...m,
        location: normaliseLocation(m.location),
        threats: Array.isArray(m.threats) ? m.threats : m.threats ? [String(m.threats)] : [],
        unlocked: m.unlocked !== false || !!import.meta.env?.DEV,
        lockedForReal: m.unlocked === false,
        bestRank: m.bestRank ?? rec.rank ?? null,
        bestScore: m.bestScore ?? rec.score ?? null,
      };
    });
  }

  mission(id) {
    return this.missions.find((m) => m.id === id) ?? null;
  }

  get currentMission() {
    const id = this.real?.mission?.id ?? this.real?.currentMission?.id ?? this.local.missionId;
    return id ? this.mission(id) : null;
  }

  // Menu steps the gameplay flow owns (title -> select -> briefing). Each
  // returns true when the real flow took it; it then answers with ui:screen.
  toTitle() {
    if (this.real?.toTitle) return this.real.toTitle(), true;
    return false;
  }

  openSelect() {
    if (this.real?.openSelect) return this.real.openSelect(), true;
    return false;
  }

  openBriefing(id) {
    if (this.real?.selectMission) return this.real.selectMission(id) !== false;
    return false;
  }

  /** Special-weapon choice on the briefing (real flow only). */
  get special() {
    return this.real?.special ?? null;
  }

  setSpecial(id) {
    return this.real?.setSpecial?.(id) ?? false;
  }

  /** Leave the remembrance screen (real flow moves on to the debrief). */
  confirm() {
    if (this.real?.confirm) return this.real.confirm(), true;
    return false;
  }

  /** Result of the last sortie as gameplay reported it, if any. */
  get result() {
    return this.real?.result ?? null;
  }

  startMission(id) {
    if (this.real) return this.real.startMission(id);
    this.local.missionId = id;
    this._localLoadThenFly(id);
  }

  pause() {
    if (this.real?.pause) return this.real.pause();
    if (this.local.state !== 'sortie') return;
    this.local.state = 'pause';
    this.game.paused = true;
    this.game.input?.releaseAll?.();
    this._emit('pause');
  }

  resume() {
    if (this.real?.resume) return this.real.resume();
    if (this.local.state !== 'pause') return;
    this.local.state = 'sortie';
    this.game.paused = false;
    this._emit('sortie');
  }

  retry() {
    if (this.real?.retry) return this.real.retry();
    this.game.paused = false;
    this._localLoadThenFly(this.local.missionId);
  }

  quitToMenu() {
    if (this.real?.quitToMenu) return this.real.quitToMenu();
    this.game.paused = false;
    this.local.state = 'missionSelect';
    if (this.game.input) this.game.input.enabled = false;
    this._emit('missionSelect');
  }

  /** Record a result locally (best rank / score per mission). */
  record(missionId, result) {
    if (!missionId || !result) return;
    const prev = this.records[missionId] ?? {};
    const next = {
      score: Math.max(prev.score ?? 0, result.score ?? 0),
      rank: result.success === false ? prev.rank ?? null : betterRank(prev.rank, result.rank),
    };
    this.records[missionId] = next;
    try {
      globalThis.localStorage?.setItem(RECORDS_KEY, JSON.stringify(this.records));
    } catch {
      /* ignore */
    }
    return { previousBest: prev.score ?? null, best: next.score, isNewBest: (result.score ?? 0) > (prev.score ?? 0) };
  }

  // ----------------------------------------------------------- local flow --

  _emit(screen, extra = {}) {
    this.game.events.emit('ui:screen', { screen, source: 'flow-local', ...extra });
  }

  _localLoadThenFly(id) {
    const m = this.mission(id);
    this.local.state = 'loading';
    this._emit('loading', { mission: m });
    // No gameplay loading exists yet: report real progress for the one thing
    // that does happen (spawning + a warm-up frame) so the bar is honest.
    const ev = this.game.events;
    ev.emit('loading:progress', { progress: 0.3, label: 'Positioning aircraft' });
    const loc = m?.markers?.find((k) => k.kind === 'start') ?? m?.location;
    requestAnimationFrame(() => {
      if (loc && Number.isFinite(loc.x)) {
        const target = m.location;
        // Compass bearing (clockwise from north) toward the objective. The
        // flight model's spawn yaw is a +Y rotation of a -Z nose, i.e. the
        // negated compass bearing.
        const bearing = target ? Math.atan2(target.x - loc.x, -(target.z - loc.z)) : -Math.PI / 2;
        this.game.spawn(loc.x, loc.z, -bearing);
      } else this.game.spawn();
      ev.emit('loading:progress', { progress: 0.8, label: 'Systems check' });
      requestAnimationFrame(() => {
        ev.emit('loading:progress', { progress: 1, label: 'Ready' });
        this.local.state = 'sortie';
        if (this.game.input) {
          this.game.input.resetForLaunch?.();
          this.game.input.enabled = true;
        }
        this.game.events.emit('mission:start', { mission: m });
        this._emit('sortie');
      });
    });
  }
}

/** Gameplay flow state -> UI screen id (where they differ). */
export const FLOW_TO_UI = { select: 'missionSelect', remembrance: 'memorial' };
export const toUiScreen = (state) => FLOW_TO_UI[state] ?? state;

const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const THREAT_FROM_UNIT = { aaa: 'AAA', flak: 'AAA', manpads: 'MANPADS', sam: 'SAM', radar: 'Radar' };

/**
 * Shape gameplay's mission meta (src/missions/system.js meta()) for the menus,
 * reading the full definition (src/missions/data.js, via the missions system)
 * for the briefing map: start point, group positions, threats. Read-only.
 */
export function fromRealMission(m, def) {
  const markers = [];
  const threats = new Set();
  const groups = def?.groups ? Object.values(def.groups) : [];
  for (const g of groups) {
    if (g.kind === 'base' && g.near) {
      const units = g.units ?? [];
      for (const u of units) if (THREAT_FROM_UNIT[u.type]) threats.add(THREAT_FROM_UNIT[u.type]);
      const air = units.some((u) => u.type === 'sam');
      const guns = units.some((u) => u.type === 'aaa' || u.type === 'flak');
      if (g.isTarget || units.some((u) => u.isTarget)) markers.push({ kind: 'objective', label: titleCase(g.name ?? 'Objective'), x: g.near.x, z: g.near.z });
      else if (air) markers.push({ kind: 'sam', label: 'SAM', x: g.near.x, z: g.near.z, radius: 6000 });
      else if (guns) markers.push({ kind: 'aaa', label: 'AAA', x: g.near.x, z: g.near.z, radius: 2500 });
      else if (units.some((u) => u.type === 'post')) markers.push({ kind: 'objective', label: 'Recon post', x: g.near.x, z: g.near.z });
    } else if (g.kind === 'convoy' && g.from) {
      markers.push({ kind: 'objective', label: 'Convoy', x: g.from.x, z: g.from.z });
    } else if (g.kind === 'fighters' && g.at) {
      const lead = Array.isArray(g.aces) && g.aces.length;
      threats.add(lead ? 'Flight lead' : 'Fighters');
      markers.push({ kind: lead ? 'ace' : 'fighter', label: lead ? 'Flight lead' : 'Fighters', x: g.at.x, z: g.at.z });
    }
  }
  if (def?.start) markers.push({ kind: 'start', label: 'Ingress', x: def.start.x, z: def.start.z });
  const objs = markers.filter((k) => k.kind === 'objective');
  const focus = objs.length ? objs : markers;
  const cx = focus.length ? focus.reduce((a, k) => a + k.x, 0) / focus.length : undefined;
  const cz = focus.length ? focus.reduce((a, k) => a + k.z, 0) / focus.length : undefined;
  const best = m.best ?? null;
  return {
    ...m,
    description: m.summary ?? '',
    briefingText: Array.isArray(m.briefing) ? m.briefing : m.briefing ? [String(m.briefing)] : [],
    location: { name: typeof m.location === 'string' ? m.location : m.location?.name ?? '', x: cx, z: cz },
    markers,
    threats: [...threats],
    specials: Array.isArray(m.specials) ? m.specials : [],
    unlocked: m.unlocked !== false,
    lockedForReal: m.unlocked === false,
    // src/missions/scoring.js recordResult: {completed, bestScore, bestRank, bestTime, attempts}
    bestRank: best?.bestRank ?? best?.rank ?? null,
    bestScore: best?.bestScore || best?.score || null,
    completed: best?.completed ?? false,
  };
}

function normaliseLocation(loc) {
  if (!loc) return { name: '' };
  if (typeof loc === 'string') return { name: loc };
  return { name: loc.name ?? loc.label ?? '', x: loc.x, z: loc.z };
}
