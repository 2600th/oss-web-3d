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
    const src = Array.isArray(list) && list.length ? list : FALLBACK_MISSIONS;
    return src.map((m) => {
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

function normaliseLocation(loc) {
  if (!loc) return { name: '' };
  if (typeof loc === 'string') return { name: loc };
  return { name: loc.name ?? loc.label ?? '', x: loc.x, z: loc.z };
}
