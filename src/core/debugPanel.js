/**
 * The tilde-key predicate for the diagnostics panel.
 *
 * It lives in its own module rather than inline in main.js purely so it can be
 * tested: main.js is the entry point and importing it runs the whole boot.
 */

const TEXT_ENTRY = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * True when a keydown should flip the diagnostics panel.
 *
 * `Backquote` rather than the `~` character because the physical key is what
 * players are told to press, and on a UK or German layout the character that
 * key produces is not a tilde at all.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function shouldToggleDebug(event) {
  if (!event || event.code !== 'Backquote') return false;
  // Ctrl+` and Cmd+` belong to editors and the macOS window switcher, Alt+` to
  // some desktops. Only the bare key, shifted or not, is ours.
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  // A tilde typed into a text field is a tilde, not a toggle.
  const node = event.target;
  if (!node) return true;
  if (TEXT_ENTRY.has(node.tagName)) return false;
  return !node.isContentEditable;
}
