import { el, icon } from '../dom.js';
import { bindingsFor } from '../bindings.js';

/**
 * Settings: one scrolling column of grouped rows, so keyboard and gamepad
 * navigation is a single linear ring (Up/Down between rows, Left/Right to
 * change). Wide screens get a section index on the left for pointer users.
 *
 * Every row writes through `settings.set(key, value)`; the UI system turns
 * that into side effects (renderer tier, bus event for audio/camera, HUD
 * re-theme) in one place.
 */

const pct = (v) => `${Math.round(v * 100)}%`;

export const SECTIONS = [
  {
    id: 'graphics',
    title: 'Graphics',
    rows: [
      {
        key: 'tier', label: 'Quality', type: 'choice',
        options: [[null, 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
        note: 'Resolution applies now. Terrain detail and shadows apply after a reload.',
      },
    ],
  },
  {
    id: 'controls',
    title: 'Controls',
    rows: [
      {
        key: 'controlMode', label: 'Control mode', type: 'choice',
        options: [['standard', 'Standard'], ['expert', 'Expert']],
        note: 'Standard keeps the jet coordinated and manages throttle. Expert gives you the raw stick and throttle.',
      },
      { key: 'invertY', label: 'Invert pitch', type: 'toggle', note: 'Push forward to climb.' },
      { key: 'sensitivity', label: 'Stick sensitivity', type: 'range', min: 0.4, max: 1.8, step: 0.1, fmt: (v) => `${v.toFixed(1)}x` },
      { key: 'vibration', label: 'Controller vibration', type: 'toggle' },
    ],
  },
  {
    id: 'audio',
    title: 'Audio',
    rows: [
      { key: 'masterVolume', label: 'Master', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'musicVolume', label: 'Music', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'sfxVolume', label: 'Effects', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'radioVolume', label: 'Radio', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    ],
  },
  {
    id: 'hud',
    title: 'HUD',
    rows: [
      {
        key: 'hudColor', label: 'Symbology colour', type: 'choice',
        options: [['glacier', 'Glacier'], ['phosphor', 'Phosphor'], ['amber', 'Amber'], ['white', 'White']],
        swatch: { glacier: '#d6f6ff', phosphor: '#b6ffcf', amber: '#ffd9a0', white: '#ffffff' },
      },
      {
        key: 'palette', label: 'Identification colours', type: 'choice',
        options: [['standard', 'Standard'], ['deutan', 'Red-green safe'], ['tritan', 'Blue-yellow safe']],
        note: 'Target shapes always repeat what colour says.',
      },
      { key: 'hudScale', label: 'HUD size', type: 'range', min: 0.8, max: 1.3, step: 0.05, fmt: pct },
      { key: 'hudOpacity', label: 'HUD opacity', type: 'range', min: 0.5, max: 1, step: 0.05, fmt: pct },
    ],
  },
  {
    id: 'subtitles',
    title: 'Subtitles',
    rows: [
      { key: 'subtitles', label: 'Radio subtitles', type: 'toggle' },
      {
        key: 'subtitleSize', label: 'Subtitle size', type: 'choice',
        options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']],
      },
    ],
  },
  {
    id: 'camera',
    title: 'Camera',
    rows: [
      {
        key: 'defaultCamera', label: 'Starting view', type: 'choice',
        options: [['chase', 'Chase'], ['cockpit', 'Cockpit'], ['hud', 'HUD only']],
      },
      { key: 'cameraFov', label: 'Field of view', type: 'range', min: -10, max: 15, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v}°` },
      { key: 'cameraShake', label: 'Camera shake', type: 'range', min: 0, max: 1, step: 0.1, fmt: pct },
    ],
  },
  {
    id: 'access',
    title: 'Accessibility',
    rows: [
      {
        key: 'reducedMotion', label: 'Reduce motion', type: 'choice',
        options: [['system', 'System'], ['on', 'On'], ['off', 'Off']],
        note: 'Stops flashing warnings and menu animation.',
      },
    ],
  },
];

export function buildSettings(ui) {
  const { settings } = ui;
  const root = el('section', 'scr scr-settings');
  root.setAttribute('aria-labelledby', 'settings-h');
  const head = el('header', 'scr-head', root);
  const h = el('h2', 'scr-title', head, 'Settings');
  h.id = 'settings-h';

  const body = el('div', 'settings', root);
  const index = el('nav', 'settings-index', body);
  index.setAttribute('aria-label', 'Settings sections');
  const list = el('div', 'settings-list', body);

  const refreshers = [];
  for (const sec of SECTIONS) {
    const a = el('a', 'settings-index-link', index, sec.title);
    a.href = `#set-${sec.id}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      list.querySelector(`#set-${sec.id}`)?.scrollIntoView({ block: 'start', behavior: settings.prefersReducedMotion ? 'auto' : 'smooth' });
    });
    const group = el('section', 'set-group', list);
    group.id = `set-${sec.id}`;
    const gh = el('h3', 'set-group-title', group, sec.title);
    gh.id = `set-${sec.id}-h`;
    group.setAttribute('aria-labelledby', gh.id);
    for (const row of sec.rows) refreshers.push(buildRow(group, row, settings));
    if (sec.id === 'graphics') {
      const notice = el('div', 'set-notice', group);
      notice.hidden = true;
      el('span', '', notice, 'Reload to rebuild terrain at the new quality.');
      const btn = el('button', 'btn btn-small', notice, 'Reload now');
      btn.dataset.nav = '';
      btn.addEventListener('click', () => location.reload());
      ui.reloadNotice = notice;
    }
  }

  // Bindings (read-only)
  const bind = el('section', 'set-group', list);
  bind.id = 'set-bindings';
  const bh = el('h3', 'set-group-title', bind, 'Controls reference');
  bind.setAttribute('aria-labelledby', (bh.id = 'set-bindings-h'));
  el('a', 'settings-index-link', index, 'Controls reference').href = '#set-bindings';
  const table = el('table', 'bindings', bind);
  const thead = el('thead', '', table);
  const tr0 = el('tr', '', thead);
  for (const t of ['Action', 'Keyboard', 'Gamepad']) el('th', '', tr0, t).scope = 'col';
  const tbody = el('tbody', '', table);
  ui.fillBindings = () => {
    tbody.textContent = '';
    for (const b of bindingsFor(ui.game.input)) {
      const tr = el('tr', '', tbody);
      el('th', '', tr, b.label).scope = 'row';
      const k = el('td', '', tr);
      (b.keys ?? []).forEach((key, i) => {
        if (i) k.append(' ');
        el('kbd', '', k, key);
      });
      if (b.alt) {
        k.append(' or ');
        b.alt.forEach((key, i) => {
          if (i) k.append(' ');
          el('kbd', '', k, key);
        });
      }
      el('td', '', tr, b.pad ?? '');
    }
  };
  ui.fillBindings();

  const foot = el('div', 'scr-actions', root);
  foot.dataset.navRow = '';
  const back = el('button', 'btn', foot);
  back.append(icon('back'), 'Back');
  back.dataset.nav = '';
  back.addEventListener('click', () => ui.back());
  const reset = el('button', 'btn btn-quiet', foot, 'Restore defaults');
  reset.dataset.nav = '';
  reset.addEventListener('click', () => {
    settings.reset();
    for (const r of refreshers) r();
  });

  return {
    id: 'settings',
    root,
    onShow() {
      for (const r of refreshers) r();
      ui.fillBindings();
      list.scrollTop = 0;
    },
    back: () => ui.back(),
  };
}

function buildRow(parent, row, settings) {
  const wrap = el('div', 'set-row', parent);
  const id = `set-${row.key}`;
  const label = el('label', 'set-label', wrap, row.label);
  label.id = `${id}-l`;
  let note = null;
  if (row.note) {
    note = el('p', 'set-note', wrap, row.note);
    note.id = `${id}-n`;
  }
  const ctl = el('div', `set-ctl set-${row.type}`, wrap);
  ctl.tabIndex = 0;
  ctl.dataset.nav = '';
  ctl.dataset.adjust = '';
  ctl.setAttribute('aria-labelledby', label.id);
  if (note) ctl.setAttribute('aria-describedby', note.id);
  label.addEventListener('click', () => ctl.focus());

  if (row.type === 'toggle') {
    ctl.setAttribute('role', 'switch');
    const track = el('span', 'switch', ctl);
    el('span', 'switch-knob', track);
    const txt = el('span', 'switch-text', ctl);
    const refresh = () => {
      const v = !!settings[row.key];
      ctl.setAttribute('aria-checked', String(v));
      txt.textContent = v ? 'On' : 'Off';
    };
    const flip = () => {
      settings.set(row.key, !settings[row.key]);
      refresh();
    };
    ctl.addEventListener('click', flip);
    ctl.addEventListener('nav-adjust', flip);
    refresh();
    return refresh;
  }

  if (row.type === 'choice') {
    ctl.setAttribute('role', 'radiogroup');
    const opts = row.options.map(([value, text]) => {
      const o = el('span', 'choice', ctl);
      o.setAttribute('role', 'radio');
      if (row.swatch?.[value]) {
        const sw = el('i', 'swatch', o);
        sw.style.background = row.swatch[value];
      }
      o.append(text);
      o.addEventListener('click', (e) => {
        e.stopPropagation();
        settings.set(row.key, value);
        refresh();
        ctl.focus();
      });
      return { o, value };
    });
    const refresh = () => {
      for (const { o, value } of opts) {
        const on = settings[row.key] === value;
        o.setAttribute('aria-checked', String(on));
        o.classList.toggle('on', on);
      }
    };
    ctl.addEventListener('nav-adjust', (e) => {
      const i = Math.max(0, opts.findIndex((x) => x.value === settings[row.key]));
      const j = Math.min(opts.length - 1, Math.max(0, i + e.detail));
      settings.set(row.key, opts[j].value);
      refresh();
    });
    refresh();
    return refresh;
  }

  // range
  ctl.setAttribute('role', 'slider');
  ctl.setAttribute('aria-valuemin', String(row.min));
  ctl.setAttribute('aria-valuemax', String(row.max));
  const track = el('span', 'range', ctl);
  const fill = el('span', 'range-fill', track);
  const knob = el('span', 'range-knob', track);
  const out = el('output', 'range-value', ctl);
  const snap = (v) => {
    const k = Math.round((v - row.min) / row.step);
    return Math.min(row.max, Math.max(row.min, +(row.min + k * row.step).toFixed(4)));
  };
  const refresh = () => {
    const v = settings[row.key];
    const f = (v - row.min) / (row.max - row.min);
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
    out.textContent = row.fmt ? row.fmt(v) : String(v);
    ctl.setAttribute('aria-valuenow', String(v));
    ctl.setAttribute('aria-valuetext', out.textContent);
  };
  ctl.addEventListener('nav-adjust', (e) => {
    settings.set(row.key, snap(settings[row.key] + e.detail * row.step));
    refresh();
  });
  const fromPointer = (e) => {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    settings.set(row.key, snap(row.min + f * (row.max - row.min)));
    refresh();
  };
  track.addEventListener('pointerdown', (e) => {
    ctl.focus();
    track.setPointerCapture(e.pointerId);
    fromPointer(e);
    const move = (ev) => fromPointer(ev);
    const up = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });
  refresh();
  return refresh;
}
