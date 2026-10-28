/**
 * PhoneFold.js — the short-screen fold shared by the DAUGHTERS and Targets panes
 * (research archive/research/2026-10-ux-panels.md §3.2 row 6).
 *
 * On a SHORT screen each pane starts as ONE line (a "fold toggle"); a tap opens it,
 * a tap on its header folds it again. On a tall screen nothing folds.
 *
 * Node-safe: importing touches no window or document. Everything is a pure helper
 * except `watchShortScreen`, which only touches the window it is handed.
 *
 * @module ui/hud/PhoneFold
 */

/** A screen shorter than this many CSS px (window.innerHeight) is "short", any pointer. */
export const SHORT_SCREEN_MAX_PX = 500;

/** The fold toggle's touch height (RAIL_GEOMETRY.TOUCH_PITCH_PX, Apple HIG). */
export const FOLD_TOGGLE_TOUCH_PX = 44;

/** Right-side glyphs of a fold toggle: folded / open. */
export const FOLD_CLOSED_GLYPH = '\u25B8';   // ▸
export const FOLD_OPEN_GLYPH = '\u25BE';     // ▾

/**
 * @param {number} h  window.innerHeight (CSS px)
 * @returns {boolean} false for a non-finite height (headless = tall)
 */
export function isShortScreen(h) {
  return Number.isFinite(h) && h < SHORT_SCREEN_MAX_PX;
}

/** The live short-screen answer for a window (false without one). */
export function shortScreenNow(win) {
  return !!win && isShortScreen(win.innerHeight);
}

/**
 * DAUGHTERS summary: how many are Ready out of how many are listed.
 * @param {Array<{label?: string}>} rows  `label` = the status word the row shows (StatusPanel._daughterStatus)
 * @returns {{ready: number, total: number, text: string}}  text is `N of M ready`
 */
export function daughtersSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let ready = 0;
  for (const r of list) if (r && r.label === 'Ready') ready++;
  return { ready, total: list.length, text: `${ready} of ${list.length} ready` };
}

/**
 * Edge detector for "a daughter just left the dock" (docked -> not docked); `next` is the map to
 * pass next time. A daughter first seen not docked is not an edge.
 * @param {Map<string, boolean>|null} prev  id -> was docked
 * @param {Array<{id: string, docked: boolean}>} rows
 * @returns {{departed: boolean, next: Map<string, boolean>}}
 */
export function departureEdges(prev, rows) {
  const next = new Map();
  let departed = false;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    next.set(r.id, !!r.docked);
    if (prev && prev.get(r.id) === true && !r.docked) departed = true;
  }
  return { departed, next };
}

/**
 * The one row a folded Targets pane shows: the selected target, else the first of `list`
 * (nearest-first for the simple level, the pane's own order otherwise).
 * @param {Array<{id: *}>} list
 * @param {*} selectedId
 * @returns {{id: *}|null}
 */
export function foldedTargetRow(list, selectedId) {
  const l = Array.isArray(list) ? list : [];
  if (l.length === 0) return null;
  if (selectedId != null) {
    const sel = l.find((t) => t && t.id === selectedId);
    if (sel) return sel;
  }
  return l[0];
}

/** The "+ n more" count on a folded Targets header: total - 1, never below 0. */
export function foldedMoreCount(total) {
  return Math.max(0, (Number.isFinite(total) ? total : 0) - 1);
}

/**
 * Right-hand text of a Targets header: `+ n more ▸` (n = 0: `▸` alone); open: `▾`
 * (with the count of rows left out of the open list in front, when there are any).
 */
export function targetsFoldText(n, folded) {
  const glyph = folded ? FOLD_CLOSED_GLYPH : FOLD_OPEN_GLYPH;
  return n > 0 ? `+ ${n} more ${glyph}` : glyph;
}

/**
 * Watch a window for the short-screen answer flipping: one 'resize' listener (none when
 * `addEventListener` is missing); `onChange(short)` fires only on a flip.
 * @returns {() => void} unwatch
 */
export function watchShortScreen(win, onChange) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  let last = shortScreenNow(win);
  const listener = () => {
    const now = shortScreenNow(win);
    if (now === last) return;
    last = now;
    if (typeof onChange === 'function') onChange(now);
  };
  win.addEventListener('resize', listener);
  return () => {
    if (typeof win.removeEventListener === 'function') win.removeEventListener('resize', listener);
  };
}
