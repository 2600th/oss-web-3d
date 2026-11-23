// Score, accuracy, rank and saved progress. Pure logic except the two storage
// helpers at the bottom, which tolerate a missing localStorage.

export const RANKS = ['S', 'A', 'B', 'C', 'D'];

/** Hit ratio over the ordnance actually used: missiles weigh more than gun rounds. */
export function accuracy({ gunFired = 0, gunHits = 0, mslFired = 0, mslHits = 0 }) {
  const parts = [];
  if (mslFired > 0) parts.push({ w: 0.7, v: Math.min(1, mslHits / mslFired) });
  // A burst that connects with a quarter of its rounds is good gunnery.
  if (gunFired > 0) parts.push({ w: 0.3, v: Math.min(1, (gunHits / gunFired) / 0.25) });
  if (parts.length === 0) return 0;
  const w = parts.reduce((a, p) => a + p.w, 0);
  return parts.reduce((a, p) => a + p.v * p.w, 0) / w;
}

/**
 * Final score.
 *   targets   sum of destroyed target scores
 *   bonuses   mission-script bonuses
 *   time      full bonus at or under `parTime`, none at `timeLimit` (completed only)
 *   accuracy  up to 1500 (completed only)
 *   survival  up to 1500 for health, +500 untouched (completed only)
 *   difficulty  the sum above times `difficultyScale`, minus the sum (so the
 *               parts still add up to the total; 0 on Normal)
 */
export function computeScore({ targetScore = 0, bonuses = 0, completed = false, time = 0, parTime = 300, timeLimit = 900, timeBonus = 3000, accuracy: acc = 0, health = 1, damageTaken = 0, difficultyScale = 1 }) {
  const b = { targets: Math.round(targetScore), bonuses: Math.round(bonuses), time: 0, accuracy: 0, survival: 0 };
  if (completed) {
    const span = Math.max(1, (timeLimit || parTime * 3) - parTime);
    const k = Math.min(1, Math.max(0, 1 - (time - parTime) / span));
    b.time = Math.round(timeBonus * k);
    b.accuracy = Math.round(1500 * Math.min(1, Math.max(0, acc)));
    b.survival = Math.round(1500 * Math.min(1, Math.max(0, health))) + (damageTaken <= 0 ? 500 : 0);
  }
  const sum = b.targets + b.bonuses + b.time + b.accuracy + b.survival;
  const total = Math.round(sum * difficultyScale);
  b.difficulty = total - sum;
  return { total, breakdown: b };
}

/** Rank from mission thresholds `{S, A, B, C}`; anything completed below C is D. */
export function rankFor(total, thresholds, completed = true) {
  if (!completed) return null;
  for (const r of ['S', 'A', 'B', 'C']) if (total >= (thresholds?.[r] ?? Infinity)) return r;
  return 'D';
}

export const rankBetter = (a, b) => (a ? RANKS.indexOf(a) : 99) < (b ? RANKS.indexOf(b) : 99);

// ---- progress ---------------------------------------------------------------

const KEY = 'safedsagar.v2.progress';

function store() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadProgress(storage = store()) {
  try {
    const p = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (p && typeof p === 'object' && p.missions && typeof p.missions === 'object') return p;
  } catch { /* corrupt */ }
  return { missions: {} };
}

/** Merge one result into saved progress; returns {progress, newBest}. */
export function recordResult(progress, missionId, { completed, score, rank, time }) {
  const prev = progress.missions[missionId] ?? { completed: false, bestScore: 0, bestRank: null, bestTime: null, attempts: 0 };
  const next = { ...prev, attempts: prev.attempts + 1 };
  let newBest = false;
  if (completed) {
    next.completed = true;
    if (score > prev.bestScore) { next.bestScore = score; newBest = true; }
    if (rankBetter(rank, prev.bestRank)) next.bestRank = rank;
    if (prev.bestTime === null || time < prev.bestTime) next.bestTime = time;
  }
  progress.missions[missionId] = next;
  return { progress, newBest };
}

export function saveProgress(progress, storage = store()) {
  try { storage?.setItem(KEY, JSON.stringify(progress)); } catch { /* unavailable */ }
}

/** A mission is open when it is first, free flight, or the one before it is done. */
export function isUnlocked(missions, index, progress) {
  const m = missions[index];
  if (!m || m.free || index === 0) return true;
  const prev = missions.slice(0, index).reverse().find((x) => !x.free);
  return !prev || progress.missions[prev.id]?.completed === true;
}
