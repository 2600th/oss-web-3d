/**
 * HUD declutter geometry (pure; unit-tested in node).
 *
 * Rects are { x0, y0, x1, y1 } in CSS px. The HUD builds a keep-out list
 * from the instrument layout each frame (tapes with their readout boxes and
 * the rows under them, the heading tape, the banner and radio plates), then
 * target markers and their labels are placed around it:
 *   - a marker whose centre falls on an instrument collapses to a small pip
 *     with no text (it is still there, it just stops writing over numbers);
 *   - a label tries above/below, then the side away from the screen centre,
 *     then the other side, and takes the first slot that is clear of the
 *     instruments, the other markers and labels already placed. Priority
 *     labels take the least-bad slot; the rest drop out.
 */

export function rect(x0, y0, x1, y1) {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

export function overlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

export function inside(x, y, r, pad = 0) {
  return x > r.x0 - pad && x < r.x1 + pad && y > r.y0 - pad && y < r.y1 + pad;
}

/**
 * Keep-out rects for the flight instruments, from `computeLayout` output.
 * Extents mirror the drawing code in Hud.js (_tape, _drawSpeedTape,
 * _drawAltTape, _drawHeadingTape): the speed side reaches out to the
 * throttle column (76 u), the altitude side to the end of its readout box
 * (78 u) and the AGL value; both carry a unit tag above and a G / radar
 * altitude row below.
 */
export function instrumentKeepOut(L, s, extra = []) {
  const hh = L.tapeH / 2;
  const top = -hh - 18 * s;
  const bot = hh + 30 * s;
  // weight 3: text over a readout costs more than text over another marker
  const out = [
    rect(L.speed.x - 86 * s, L.speed.y + top, L.speed.x + 6 * s, L.speed.y + bot),
    rect(L.alt.x - 14 * s, L.alt.y + top, L.alt.x + 84 * s, L.alt.y + bot),
    rect(L.heading.x - L.heading.w / 2 - 4, L.heading.y - 4, L.heading.x + L.heading.w / 2 + 4, L.heading.y + 50 * s),
  ];
  for (const r of out) r.w = 3;
  for (const r of extra) if (r) out.push(r);
  return out;
}

/**
 * The corner groups (radar, objective, score, weapons, airframe), which a
 * label should not write over either. Extents follow Hud.js; weight 2.
 */
export function panelKeepOut(L, s) {
  const { radar: rd, objective: ob, score: sc, weapons: wp, health: hl } = L;
  const objW = L.portrait ? L.w * 0.5 : Math.min(360 * s, L.w * 0.3);
  const wpH = 120 * s;
  const out = [
    rect(rd.x - rd.r, rd.y - rd.r, rd.x + rd.r, rd.y + rd.r + 12 * s),
    rect(ob.x, ob.y, ob.x + objW, ob.y + 44 * s),
    rect(sc.x - 130 * s, sc.y, sc.x, sc.y + 56 * s),
    rect(wp.x - 160 * s, L.weaponsTop ? wp.y : wp.y - wpH, wp.x, L.weaponsTop ? wp.y + wpH : wp.y),
    rect(hl.x, hl.y - 27 * s, hl.x + 180 * s, hl.y + 2 * s),
  ];
  for (const r of out) r.w = 2;
  return out;
}

/**
 * Total overlap of `boxes` with `obstacles` (each weighted by its `w`,
 * default 1), plus anything off `bounds`.
 */
export function slotCost(boxes, obstacles, bounds, skip = null) {
  let c = 0;
  for (const b of boxes) {
    if (bounds) {
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      const vis = overlap(b, bounds);
      c += w * h - vis;
    }
    for (const o of obstacles) if (o !== skip) c += overlap(b, o) * (o.w ?? 1);
  }
  return c;
}

/**
 * Pick a label slot. `cands` is a list of candidate layouts, each a list of
 * rects. Returns { i, cost }: the first candidate with no conflict, else
 * the cheapest one (callers drop it unless the label must show).
 */
export function chooseSlot(cands, obstacles, bounds, skip = null) {
  let best = -1;
  let bestC = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const c = slotCost(cands[i], obstacles, bounds, skip);
    if (c <= 0) return { i, cost: 0 };
    if (c < bestC) {
      bestC = c;
      best = i;
    }
  }
  return { i: best, cost: bestC };
}

// ------------------------------------------------- label priority + placing --
//
// A convoy, a dug-in position or a tight formation puts several markers
// within a few dozen pixels. Every marker keeps its shape; only the text is
// rationed:
//   1. rank: the lock, then anything firing on the player, then the selected
//      target, the flight lead, priority targets, then the rest, nearest first
//      (a label that was up last frame counts as a little nearer, so two
//      equal targets do not swap labels every frame);
//   2. "must" labels (lock, firing, selected) are never dropped: they take
//      the least-bad slot if nothing is clear;
//   3. the rest share a small budget and are dropped when no slot is clear;
//   4. slots are tried in order: the label's slot from last frame (if still
//      clear), the usual stack, beside, then out on a leader line.

/** Rank tier for a placed marker (higher draws its label first). */
export function labelTier(o) {
  if (o.isLock) return 5;
  if (o.firing) return 4;
  if (o.selected) return 3;
  if (o.isAce) return 2;
  if (o.isTarget) return 1;
  return 0;
}

/** Labels that are never dropped. */
export function mustLabel(o) {
  return !!(o.isLock || o.firing || o.selected);
}

/**
 * Sort markers into label order (in place). Each item: {tier, dist, had}
 * where `had` = it carried a label last frame.
 */
export function sortForLabels(list) {
  return list.sort((a, b) => b.tier - a.tier || a.dist * (a.had ? 0.85 : 1) - b.dist * (b.had ? 0.85 : 1));
}

/**
 * Leader-line slots for a label block `w` x `h` around a marker of half-size
 * `m` at (x, y): up, up-right, up-left, right, left, down-right, down-left,
 * down, at each gap in `gaps` (px beyond the marker edge). Each slot is
 * {box, ax, ay, lx, ly, align}: the line runs from (ax, ay) on the marker
 * edge to (lx, ly) on the label box; `align` is the text alignment.
 */
export const LEADER_DIRS = [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [0, 1]];
export function leaderSlots(x, y, m, w, h, gaps) {
  const out = [];
  for (const gap of gaps) {
    for (const [dx, dy] of LEADER_DIRS) {
      const diag = dx !== 0 && dy !== 0;
      const d = m + gap;
      const k = diag ? 0.72 : 1;
      // box edge nearest the marker sits `d` out along the direction
      const cx = x + dx * (d * k + w / 2);
      const cy = y + dy * (d * k + h / 2);
      const box = rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
      const lx = Math.min(box.x1, Math.max(box.x0, x));
      const ly = Math.min(box.y1, Math.max(box.y0, y));
      const len = Math.hypot(lx - x, ly - y) || 1;
      const e = m * (diag ? 1.25 : 1.1);
      out.push({ box, ax: x + ((lx - x) / len) * e, ay: y + ((ly - y) / len) * e, lx, ly, align: dx > 0 ? 'left' : dx < 0 ? 'right' : 'center', dir: [dx, dy] });
    }
  }
  return out;
}

/**
 * Place labels. `items` are in label order, each {must, cands, prev, self}
 * where `cands` is a list of candidates (each a list of rects), `prev` the
 * candidate index used last frame (or -1) and `self` the item's own marker
 * rect in `obstacles` (ignored for its own label). Chosen boxes are pushed onto
 * `obstacles` so later labels keep off them. `budget` caps the labels that
 * are not `must`. Returns, per item, the chosen candidate index or -1.
 */
export function placeLabels(items, obstacles, bounds, { budget = 3 } = {}) {
  const out = new Array(items.length).fill(-1);
  let free = budget;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!it.must && free <= 0) continue;
    let pick = -1;
    const prev = it.prev ?? -1;
    const self = it.self ?? null;
    if (prev >= 0 && prev < it.cands.length && slotCost(it.cands[prev], obstacles, bounds, self) <= 0) pick = prev;
    if (pick < 0) {
      const c = chooseSlot(it.cands, obstacles, bounds, self);
      if (c.i >= 0 && (c.cost <= 0 || it.must)) pick = c.i;
    }
    if (pick < 0) continue;
    out[k] = pick;
    for (const b of it.cands[pick]) obstacles.push(b);
    if (!it.must) free--;
  }
  return out;
}

/**
 * Fold markers that sit on top of one another. `list` is in rank order;
 * items with `keep` (lock, firing, selected) are never folded and never take
 * others in, so a firing threat can not vanish into another marker's "+n"
 * and nothing hides under the lock reticle. Returns the hosts; each carries
 * `extra` (how many folded into it).
 */
export function foldMarkers(list, merge, mergeFor = () => merge) {
  const shown = [];
  for (const o of list) {
    o.extra = 0;
    if (!o.keep) {
      const mg = mergeFor(o);
      const host = shown.find((h) => !h.keep && Math.abs(h.x - o.x) < mg && Math.abs(h.y - o.y) < mg);
      if (host) {
        host.extra++;
        // a hit on a folded marker shows on the marker standing in for it
        if (o.hit != null) host.hit = Math.min(host.hit ?? Infinity, o.hit);
        continue;
      }
    }
    shown.push(o);
  }
  return shown;
}

/**
 * Ease a label's opacity toward `target`: fast in (a label that appears
 * fades up in ~0.12 s instead of popping), a touch slower down.
 */
export function easeAlpha(a, target, dt) {
  const rate = target > a ? 9 : 5;
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  return a + (target - a) * k;
}

/**
 * Which radio-plate slot covers fewer markers. `slots` are rects in order of
 * preference; `marks` are marker rects. Ties keep the earlier slot.
 */
export function pickPlateSlot(slots, marks) {
  let best = 0;
  let bestN = Infinity;
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i]) continue;
    let n = 0;
    for (const m of marks) if (overlap(slots[i], m) > 0) n++;
    if (n < bestN) {
      bestN = n;
      best = i;
    }
    if (n === 0) break;
  }
  return best;
}
