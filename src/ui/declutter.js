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
export function slotCost(boxes, obstacles, bounds) {
  let c = 0;
  for (const b of boxes) {
    if (bounds) {
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      const vis = overlap(b, bounds);
      c += w * h - vis;
    }
    for (const o of obstacles) c += overlap(b, o) * (o.w ?? 1);
  }
  return c;
}

/**
 * Pick a label slot. `cands` is a list of candidate layouts, each a list of
 * rects. Returns { i, cost }: the first candidate with no conflict, else
 * the cheapest one (callers drop it unless the label must show).
 */
export function chooseSlot(cands, obstacles, bounds) {
  let best = -1;
  let bestC = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const c = slotCost(cands[i], obstacles, bounds);
    if (c <= 0) return { i, cost: 0 };
    if (c < bestC) {
      bestC = c;
      best = i;
    }
  }
  return { i: best, cost: bestC };
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
