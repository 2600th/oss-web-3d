/**
 * Fastest complete sorties.
 *
 * Local only for now: the board lives in this browser's localStorage. The
 * shape is deliberately the shape an online board would have — a ranked list
 * of `{ name, seconds, grade, objectives, at }` and a `submit` that returns the
 * new standings — so putting it on a server later is a matter of giving the
 * class a different store, not rewriting the card that renders it.
 *
 * Two rules decide what is rankable, and both exist to stop the board from
 * being trivially won. A sortie must have secured *every* objective, or "least
 * time" is taken by whoever takes off and lands immediately. And a name holds
 * one row, its best, so a player with an afternoon to spare cannot fill all ten
 * places with their own attempts.
 */

export const LEADERBOARD_KEY = 'safed-sagar.leaderboard.v1';
export const LAST_NAME_KEY = 'safed-sagar.leaderboard.name';
export const MAX_ENTRIES = 10;
export const NAME_MIN = 3;
export const NAME_MAX = 12;

/**
 * Trim a typed name down to something that can sit in a monospaced column.
 *
 * Uppercased because every other label on the record card is, and a mixed-case
 * row in that grid reads as a bug. Returns null rather than a fallback: a name
 * that cannot be used should stop the submission and say so, not silently
 * become "PILOT".
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function sanitiseName(raw) {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length < NAME_MIN || collapsed.length > NAME_MAX) return null;
  if (!/^[A-Za-z0-9 ._-]+$/.test(collapsed)) return null;
  return collapsed.toUpperCase();
}

/**
 * Whether a finished sortie is allowed onto the board.
 *
 * @param {{captured: number, total: number, seconds: number}} run
 */
export function isRankable(run) {
  if (!run) return false;
  const { captured, total, seconds } = run;
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  if (!Number.isInteger(total) || total < 1) return false;
  return captured === total;
}

/** mm:ss, or h:mm:ss once a sortie has run past the hour. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Insert one run into a ranked list. Pure, so the ordering and the
 * one-row-per-name rule can be tested without touching storage.
 *
 * @param {Array} entries existing rows, assumed already sorted
 * @param {object} entry
 * @param {number} [max]
 * @returns {{entries: Array, rank: number|null, improved: boolean}}
 *   `rank` is 1-based, or null when the run did not make the board.
 */
export function insertEntry(entries, entry, max = MAX_ENTRIES) {
  const existing = Array.isArray(entries) ? entries.filter(isEntry) : [];
  const previous = existing.find((row) => row.name === entry.name);
  // A slower run under a name already on the board is not a new row and not a
  // lost place — it simply did not beat what that pilot already did.
  if (previous && previous.seconds <= entry.seconds) {
    const sorted = rank(existing);
    return {
      entries: sorted,
      rank: sorted.indexOf(previous) + 1,
      improved: false,
    };
  }
  const merged = rank([...existing.filter((row) => row !== previous), entry]).slice(0, max);
  const placed = merged.indexOf(entry);
  return {
    entries: merged,
    rank: placed < 0 ? null : placed + 1,
    improved: placed >= 0,
  };
}

function rank(entries) {
  // Ties broken by the older run, so beating a time requires beating it. `at`
  // is coerced because it comes back from storage and a hand-edited or
  // older-format row can carry a missing or non-numeric timestamp — which
  // would make the comparator return NaN and leave the whole sort order
  // implementation-defined rather than merely mis-tied.
  const at = (row) => (Number.isFinite(row.at) ? row.at : 0);
  return [...entries].sort((a, b) => (a.seconds - b.seconds) || (at(a) - at(b)));
}

function isEntry(row) {
  return Boolean(row)
    && typeof row.name === 'string'
    && Number.isFinite(row.seconds)
    && row.seconds > 0;
}

/**
 * The board, backed by a Storage-shaped object.
 *
 * Every access is wrapped: Safari in private mode throws on setItem, a synced
 * profile can hand back a half-written string, and none of that is worth
 * losing a debrief screen over. A board that fails to load is an empty board.
 */
export class Leaderboard {
  constructor(store = safeStore()) {
    this.store = store;
  }

  /** @returns {Array} ranked rows, best first */
  read() {
    const raw = this._get(LEADERBOARD_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? rank(parsed.filter(isEntry)).slice(0, MAX_ENTRIES) : [];
    } catch {
      return [];
    }
  }

  /** The last name used on this machine, so the field arrives filled in. */
  lastName() {
    return sanitiseName(this._get(LAST_NAME_KEY) ?? '') ?? '';
  }

  /**
   * @param {{name: string, seconds: number, grade?: string, objectives?: string, at: number}} entry
   * @returns {{entries: Array, rank: number|null, improved: boolean}}
   */
  submit(entry) {
    const name = sanitiseName(entry?.name);
    if (!name || !Number.isFinite(entry.seconds) || entry.seconds <= 0) {
      return { entries: this.read(), rank: null, improved: false };
    }
    const row = {
      name,
      seconds: entry.seconds,
      grade: entry.grade ?? '',
      objectives: entry.objectives ?? '',
      at: Number.isFinite(entry.at) ? entry.at : 0,
    };
    const result = insertEntry(this.read(), row);
    this._set(LEADERBOARD_KEY, JSON.stringify(result.entries));
    this._set(LAST_NAME_KEY, name);
    return result;
  }

  /** Fastest time on this machine, or null on an empty board. */
  best() {
    return this.read()[0] ?? null;
  }

  _get(key) {
    try {
      return this.store?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  _set(key, value) {
    try {
      this.store?.setItem(key, value);
    } catch {
      /* quota, private mode, disabled storage — the board is just not kept */
    }
  }
}

function safeStore() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
