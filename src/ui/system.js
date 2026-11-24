import { UI } from './UI.js';

/**
 * UI + HUD system (auto-registered by src/main.js; see docs/ARCHITECTURE.md).
 * Order 90: runs after gameplay has written `game.hud` and after the camera
 * rig has moved, so projected HUD symbology lands on the frame being drawn.
 */
export const order = 90;

export function createSystem(game) {
  globalThis.__ssBoot?.set('renderer', 1);
  globalThis.__ssBoot?.set('terrain', 1);
  globalThis.__ssBoot?.set('systems', 1);
  const ui = new UI(game);
  game.ui = ui;
  return {
    name: 'ui',
    init: () => ui.init(),
    update: (dt) => ui.update(dt),
    lateUpdate: (dt) => ui.lateUpdate(dt),
    onCrash: () => ui.hud.flashDamage(0.6),
    dispose: () => ui.dispose(),
  };
}
