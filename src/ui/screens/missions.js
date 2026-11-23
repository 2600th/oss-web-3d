import { el, icon } from '../dom.js';
import { getRelief } from '../relief.js';
import { PLACES, worldToLonLat } from '../geo.js';
import { formatScore } from '../format.js';

/**
 * Mission select and briefing.
 *
 * Select is a list + detail split rather than a wall of equal cards: the list
 * is what you scan (name, place, best rank), the detail is what you read
 * (the ground, the threats). Hover/focus previews; activating a row opens the
 * briefing. Briefing leads with the map, because the place is the point.
 */

const THREAT_INFO = {
  AAA: 'Anti-aircraft guns. Deadly below 1,500 m; stay fast and high over them.',
  MANPADS: 'Shoulder-launched infrared missiles. Short range; flares defeat them.',
  SAM: 'Radar-guided surface-to-air missiles. Watch the rings; terrain masks you.',
  Radar: 'Search radar that cues launchers. Kill it and the SAMs go blind.',
  Fighters: 'Hostile interceptors flying in pairs.',
  'Flight lead': 'The hostile flight lead. Better aircraft, better pilot; marked with a double frame.',
};
THREAT_INFO.Ace = THREAT_INFO['Flight lead'];

const MARKER_STYLE = {
  objective: { color: '#ffc53d', shape: 'diamond' },
  sam: { color: '#ff5b47', shape: 'ring' },
  aaa: { color: '#ff7a4a', shape: 'ring' },
  ace: { color: '#ff5b47', shape: 'chevron' },
  fighter: { color: '#ff5b47', shape: 'chevron' },
  start: { color: '#d6f6ff', shape: 'arrow' },
};

export function buildMissionSelect(ui) {
  const root = el('section', 'scr scr-missions');
  root.setAttribute('aria-labelledby', 'missions-h');
  const head = el('header', 'scr-head', root);
  const h = el('h2', 'scr-title', head, 'Sorties');
  h.id = 'missions-h';
  el('p', 'scr-sub', head, 'Kargil sector, summer 1999. Fictional operations over real ground.');

  const split = el('div', 'missions', root);
  const list = el('ol', 'mission-list', split);
  list.setAttribute('aria-label', 'Sorties');
  const detail = el('article', 'mission-detail', split);
  detail.setAttribute('aria-live', 'polite');
  const mapWrap = el('div', 'mission-map', detail);
  const map = el('canvas', '', mapWrap);
  map.setAttribute('role', 'img');
  const dName = el('h3', 'mission-name', detail);
  const dLoc = el('p', 'mission-loc', detail);
  const dDesc = el('p', 'mission-desc', detail);
  const dThreats = el('ul', 'threats', detail);
  dThreats.setAttribute('aria-label', 'Threats');
  const dBest = el('p', 'mission-best', detail);

  const foot = el('div', 'scr-actions', root);
  foot.dataset.navRow = '';
  const back = el('button', 'btn', foot);
  back.append(icon('back'), 'Back');
  back.dataset.nav = '';
  back.addEventListener('click', () => ui.back());

  let selected = null;
  const show = (m) => {
    selected = m;
    for (const row of list.querySelectorAll('.mission-row')) row.setAttribute('aria-current', String(row.dataset.id === m.id));
    dName.textContent = m.name;
    dLoc.textContent = formatPlace(m.location);
    dDesc.textContent = m.description ?? '';
    dThreats.textContent = '';
    for (const t of m.threats) el('li', 'threat', dThreats, t);
    dBest.textContent = m.bestRank || m.bestScore
      ? `Best: rank ${m.bestRank ?? '—'}${m.bestScore ? ` · ${formatScore(m.bestScore)}` : ''}`
      : 'Not yet flown.';
    map.setAttribute('aria-label', `Relief map around ${m.location?.name ?? m.name}`);
    drawMap(map, m, { span: 30000, labels: true, compact: true });
  };

  return {
    id: 'missionSelect',
    root,
    onShow() {
      list.textContent = '';
      const missions = ui.flow.missions;
      missions.forEach((m, i) => {
        const li = el('li', '', list);
        const b = el('button', 'mission-row', li);
        b.dataset.nav = '';
        b.dataset.id = m.id;
        if (!m.unlocked) b.setAttribute('aria-disabled', 'true');
        el('span', 'm-index', b, String(i + 1).padStart(2, '0'));
        const mid = el('span', 'm-text', b);
        el('span', 'm-name', mid, m.name);
        el('span', 'm-loc', mid, m.location?.name ?? '');
        const rk = el('span', 'm-rank', b, m.unlocked ? m.bestRank ?? '' : '');
        if (!m.unlocked) rk.append(icon('lock'));
        if (m.lockedForReal && m.unlocked) el('span', 'm-dev', b, 'dev');
        b.setAttribute('aria-label', `${m.name}, ${m.location?.name ?? ''}${m.bestRank ? `, best rank ${m.bestRank}` : ''}${m.unlocked ? '' : ', locked'}`);
        b.addEventListener('focus', () => show(m));
        b.addEventListener('pointerenter', () => show(m));
        b.addEventListener('click', () => {
          if (!m.unlocked) return;
          ui.openBriefing(m.id);
        });
      });
      const first = missions.find((m) => m.id === selected?.id) ?? missions[0];
      if (first) show(first);
      return list.querySelector(`[data-id="${first?.id}"]`);
    },
    onResize() {
      if (selected) drawMap(map, selected, { span: 30000, labels: true, compact: true });
    },
    back: () => ui.back(),
  };
}

export function buildBriefing(ui) {
  const root = el('section', 'scr scr-briefing');
  root.setAttribute('aria-labelledby', 'brief-h');
  const mapWrap = el('div', 'brief-map', root);
  const map = el('canvas', '', mapWrap);
  map.setAttribute('role', 'img');
  const legend = el('ul', 'brief-legend', mapWrap);
  legend.setAttribute('aria-label', 'Map legend');
  for (const [k, label] of [['objective', 'Objective'], ['sam', 'SAM / AAA cover'], ['ace', 'Air threat'], ['start', 'Ingress']]) {
    const li = el('li', `lg lg-${k}`, legend);
    el('i', '', li);
    li.append(label);
  }

  const text = el('div', 'brief-text', root);
  const h = el('h2', 'brief-title', text);
  h.id = 'brief-h';
  const loc = el('p', 'brief-loc', text);
  const desc = el('p', 'brief-desc', text);
  const objH = el('h3', 'brief-sub', text, 'Objectives');
  const objList = el('ul', 'brief-objs', text);
  el('h3', 'brief-sub', text, 'Threats');
  const thrList = el('dl', 'brief-threats', text);

  const actions = el('div', 'scr-actions', text);
  actions.dataset.navRow = '';
  const launch = el('button', 'btn btn-primary', actions, 'Launch');
  launch.dataset.nav = '';
  launch.dataset.default = '';
  const back = el('button', 'btn', actions);
  back.append(icon('back'), 'Sorties');
  back.dataset.nav = '';
  back.addEventListener('click', () => ui.back());

  let mission = null;
  launch.addEventListener('click', () => mission && ui.launch(mission.id));

  return {
    id: 'briefing',
    root,
    onShow(arg) {
      mission = ui.flow.mission(arg?.id ?? ui.briefingId) ?? ui.flow.missions[0];
      if (!mission) return;
      h.textContent = mission.name;
      loc.textContent = formatPlace(mission.location);
      desc.textContent = mission.description ?? '';
      const objs = (mission.markers ?? []).filter((m) => m.kind === 'objective');
      objH.hidden = objList.hidden = !objs.length;
      objList.textContent = '';
      for (const o of objs) el('li', '', objList, o.label);
      thrList.textContent = '';
      for (const t of mission.threats) {
        el('dt', '', thrList, t);
        el('dd', '', thrList, THREAT_INFO[t] ?? '');
      }
      map.setAttribute('aria-label', `Briefing map: ${mission.location?.name ?? mission.name}, ${objs.length} objectives marked`);
      requestAnimationFrame(() => drawMap(map, mission, { span: 42000, labels: true, grid: true }));
      return launch;
    },
    onResize() {
      if (mission) drawMap(map, mission, { span: 42000, labels: true, grid: true });
    },
    back: () => ui.back(),
  };
}

export function formatPlace(loc) {
  if (!loc) return '';
  if (!Number.isFinite(loc.x)) return loc.name ?? '';
  const { lon, lat } = worldToLonLat(loc.x, loc.z);
  return `${loc.name} · ${lat.toFixed(2)}°N ${lon.toFixed(2)}°E`;
}

/**
 * Draw a top-down relief map window centred on the mission with markers,
 * real place labels, a lat/lon grid and a scale bar.
 */
export function drawMap(canvas, mission, { span = 36000, labels = true, grid = false, compact = false } = {}) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a1116';
  ctx.fillRect(0, 0, w, h);
  const relief = getRelief();
  const loc = mission.location ?? {};
  const markers = mission.markers ?? [];
  // centre on the centroid of the markers if any, else the location
  let cx = loc.x ?? 0;
  let cz = loc.z ?? 0;
  if (markers.length) {
    cx = markers.reduce((a, m) => a + m.x, 0) / markers.length;
    cz = markers.reduce((a, m) => a + m.z, 0) / markers.length;
    let ext = 0;
    for (const m of markers) ext = Math.max(ext, Math.abs(m.x - cx) * 2 * (h / w), Math.abs(m.z - cz) * 2);
    span = Math.max(span, ext * 1.35);
  }
  let k = h / span; // px per metre (span fits the height)
  // Keep the window inside the DEM so the map never shows the void past it:
  // zoom in until the DEM covers both axes, then clamp the centre.
  if (relief) {
    const b = relief.bounds;
    k = Math.max(k, w / (b.maxX - b.minX), h / (b.maxZ - b.minZ));
    const hw = w / 2 / k;
    const hh = h / 2 / k;
    if (b.maxX - b.minX > 2 * hw) cx = Math.min(b.maxX - hw, Math.max(b.minX + hw, cx));
    if (b.maxZ - b.minZ > 2 * hh) cz = Math.min(b.maxZ - hh, Math.max(b.minZ + hh, cz));
  }
  const toX = (x) => w / 2 + (x - cx) * k;
  const toY = (z) => h / 2 + (z - cz) * k;
  if (relief) {
    const b = relief.bounds;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(relief.canvas, toX(b.minX), toY(b.minZ), (b.maxX - b.minX) * k, (b.maxZ - b.minZ) * k);
  }
  // cool overlay to sit the markers forward
  ctx.fillStyle = 'rgba(6,14,20,0.25)';
  ctx.fillRect(0, 0, w, h);

  if (grid) {
    ctx.strokeStyle = 'rgba(214,246,255,0.14)';
    ctx.lineWidth = 1;
    ctx.font = '400 10px "SS B612", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(214,246,255,0.6)';
    ctx.textBaseline = 'alphabetic';
    const tl = worldToLonLat(cx - w / 2 / k, cz - h / 2 / k);
    const br = worldToLonLat(cx + w / 2 / k, cz + h / 2 / k);
    const step = 0.05;
    ctx.beginPath();
    for (let lon = Math.ceil(tl.lon / step) * step; lon < br.lon; lon += step) {
      const x = toX(((lon - 76.09) * 111320 * Math.cos((34.5 * Math.PI) / 180)));
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.textAlign = 'left';
      ctx.fillText(`${lon.toFixed(2)}E`, x + 3, 14);
    }
    for (let lat = Math.ceil(br.lat / step) * step; lat < tl.lat; lat += step) {
      const y = toY(-(lat - 34.5) * 110574);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.fillText(`${lat.toFixed(2)}N`, 4, y - 3);
    }
    ctx.stroke();
  }

  // Symbols first, then labels placed greedily around their anchor so the
  // dense clusters (an objective on a named ridge under an AAA ring) stay
  // legible. Mission labels win over place names.
  const occupied = [];
  const labelQueue = [];
  const r = compact ? 5 : 7;
  for (const m of markers) {
    const st = MARKER_STYLE[m.kind] ?? MARKER_STYLE.objective;
    const x = toX(m.x);
    const y = toY(m.z);
    if (m.radius) {
      ctx.beginPath();
      ctx.arc(x, y, m.radius * k, 0, Math.PI * 2);
      ctx.fillStyle = st.color;
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }
  for (const m of markers) {
    const st = MARKER_STYLE[m.kind] ?? MARKER_STYLE.objective;
    const x = toX(m.x);
    const y = toY(m.z);
    ctx.beginPath();
    if (st.shape === 'diamond') {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    } else if (st.shape === 'chevron') {
      ctx.moveTo(x - r, y + r * 0.6);
      ctx.lineTo(x, y - r * 0.6);
      ctx.lineTo(x + r, y + r * 0.6);
    } else if (st.shape === 'arrow') {
      // ingress arrow pointing at the mission location
      const a = Math.atan2((loc.z ?? cz) - m.z, (loc.x ?? cx) - m.x);
      ctx.moveTo(x + Math.cos(a) * r * 1.6, y + Math.sin(a) * r * 1.6);
      ctx.lineTo(x + Math.cos(a + 2.5) * r, y + Math.sin(a + 2.5) * r);
      ctx.lineTo(x + Math.cos(a - 2.5) * r, y + Math.sin(a - 2.5) * r);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    }
    ctx.strokeStyle = 'rgba(4,10,14,0.85)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = st.color;
    ctx.fillStyle = st.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (st.shape === 'diamond' || st.shape === 'arrow') ctx.fill();
    occupied.push([x - r - 2, y - r - 2, x + r + 2, y + r + 2]);
    if (!compact && m.label) {
      labelQueue.push({ text: m.label.toUpperCase(), x, y, color: st.color, font: '700 11px "SS B612", system-ui, sans-serif' });
    }
  }

  if (labels) {
    for (const p of PLACES) {
      const x = toX(p.x);
      const y = toY(p.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      const italic = p.kind === 'river' || p.kind === 'valley';
      if (p.kind === 'town' || p.kind === 'peak') {
        ctx.beginPath();
        if (p.kind === 'peak') {
          ctx.moveTo(x, y - 4);
          ctx.lineTo(x + 4, y + 3);
          ctx.lineTo(x - 4, y + 3);
          ctx.closePath();
        } else ctx.rect(x - 2.5, y - 2.5, 5, 5);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(4,10,14,0.8)';
        ctx.fillStyle = '#e9f1f4';
        ctx.stroke();
        ctx.fill();
        occupied.push([x - 5, y - 5, x + 5, y + 5]);
      }
      labelQueue.push({
        text: p.name, x, y,
        color: italic ? 'rgba(160,214,255,0.9)' : '#e9f1f4',
        font: `${italic ? 'italic ' : ''}400 ${compact ? 10 : 12}px "SS B612", system-ui, sans-serif`,
        optional: true,
      });
    }
  }

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const hit = (a) => occupied.some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
  for (const L of labelQueue) {
    ctx.font = L.font;
    const tw = ctx.measureText(L.text).width;
    const th = 13;
    // candidate offsets: right, upper-right, lower-right, left, above, below
    const cands = [[9, 0], [9, -12], [9, 12], [-9 - tw, 0], [-tw / 2, -15], [-tw / 2, 15], [9, -24], [9, 24]];
    let placed = null;
    for (const [dx, dy] of cands) {
      const rect = [L.x + dx - 2, L.y + dy - th / 2, L.x + dx + tw + 2, L.y + dy + th / 2];
      if (!hit(rect)) {
        placed = [L.x + dx, L.y + dy, rect];
        break;
      }
    }
    if (!placed) {
      if (L.optional) continue;
      placed = [L.x + 9, L.y, [0, 0, 0, 0]];
    }
    occupied.push(placed[2]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(4,10,14,0.85)';
    ctx.strokeText(L.text, placed[0], placed[1]);
    ctx.fillStyle = L.color;
    ctx.fillText(L.text, placed[0], placed[1]);
  }

  // scale bar + north
  const km = span > 30000 ? 10 : 5;
  const bw = km * 1000 * k;
  const sx = w - bw - 14;
  const sy = h - 16;
  ctx.strokeStyle = '#e9f1f4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy - 4);
  ctx.lineTo(sx, sy);
  ctx.lineTo(sx + bw, sy);
  ctx.lineTo(sx + bw, sy - 4);
  ctx.stroke();
  ctx.font = '700 10px "SS B612", system-ui, sans-serif';
  ctx.fillStyle = '#e9f1f4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${km} km`, sx + bw / 2, sy - 8);
  ctx.beginPath();
  ctx.moveTo(w - 20, 14);
  ctx.lineTo(w - 14, 30);
  ctx.lineTo(w - 20, 26);
  ctx.lineTo(w - 26, 30);
  ctx.closePath();
  ctx.fill();
  ctx.fillText('N', w - 20, 42);
}
