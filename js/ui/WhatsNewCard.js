/**
 * WhatsNewCard.js — the menu "what's new" notes card, and the pure rules for when it shows
 * (owner 2026-10-26, DECISIONS §43).
 *
 * Five parts, one file:
 *   - `noticeState` — the pure rule: card? dot? write which key? (the four rows of D2);
 *   - `readNotice` / `markSeen` — the two localStorage keys (StorageKeys.WHATS_NEW_SHOWN / _SEEN),
 *     every touch inside try/catch: private mode or a full disk never nags;
 *   - `loadNotes` — the RUNNING build's own `data/whats-new.json` (one fetch; the service worker serves
 *     the app cache's copy), or null when it cannot be read or names another version;
 *   - `placeNotice` — where the fixed card sits, from the version button's box;
 *   - `buildWhatsNewCard` — the DOM, over an injected `document` (no bus, no timers, no animation).
 *
 * THE LOOK: same family as UpdateCard but an opaque plate (no blur) in the library's INFO grammar
 * (cyan title, #aaddff prose). Non-modal (role=status): it never blocks START and never takes focus.
 * Text goes in through `textContent` only.
 *
 * @module ui/WhatsNewCard
 */

import { Constants } from '../core/Constants.js';
import { StorageKeys } from '../core/StorageKeys.js';
import { parseBullets } from '../core/UpdateWatch.js';
import { clamp } from '../core/MathUtil.js';

/** The card's fixed numbers + strings (own-module export; the house rule). */
export const WHATS_NEW_CARD = Object.freeze({
  ID: 'menu-whats-new',
  GOT_IT_ID: 'menu-whats-new-gotit',
  CHECK_ID: 'menu-whats-new-check',
  STATUS_ID: 'menu-whats-new-status',
  RESTART_ID: 'menu-whats-new-restart',
  BULLETS_CLASS: 'whats-new-bullets',
  /** `UPDATED TO V1.02` — shown by itself on the first start after an update. */
  TITLE_UPDATED: 'UPDATED TO',
  /** `WHAT'S NEW IN V1.02` — opened from the version button. */
  TITLE_OPENED: "WHAT'S NEW IN",
  GOT_IT_LABEL: 'GOT IT',
  CHECK_LABEL: 'Check for updates',
  CHECKING_LABEL: 'Checking...',
  CURRENT_LABEL: 'Up to date',
  OFFLINE_LABEL: "Can't check right now",
  READY_TITLE: 'New version ready',
  RESTART_LABEL: 'RESTART NOW',
  /** Card width cap (px) and the gaps to the version button / the screen edge. */
  MAX_WIDTH_PX: 340,
  GAP_PX: 8,
  EDGE_PX: 16,
  /** Every button's minimum height (px) — the 44 pt touch-target minimum. */
  BUTTON_MIN_H_PX: 44,
});

// ── when does it show (D2) ───────────────────────────────────────────────────

/**
 * The pure rule. `shown` = the version whose card was auto-shown; `seen` = the version whose notes were
 * opened or dismissed; `hasSave` = the run save exists.
 *  - new player (no save AND neither key): no card, no dot; both keys are written silently (`newPlayer`);
 *  - `seen === version`: nothing;
 *  - `shown !== version`: the card once (`markShown`), dot while unseen;
 *  - `shown === version`, unseen (the card folded away on START, unread): no card, the dot stays.
 * A wiped save with keys present is NOT a new player (the keys are settings, not the save).
 * @param {{ version: string, shown?: string|null, seen?: string|null, hasSave?: boolean }} p
 * @returns {{ card: boolean, dot: boolean, markShown: boolean, newPlayer: boolean }}
 */
export function noticeState({ version, shown = null, seen = null, hasSave = false } = {}) {
  if (!hasSave && !shown && !seen) return { card: false, dot: false, markShown: false, newPlayer: true };
  if (seen === version) return { card: false, dot: false, markShown: false, newPlayer: false };
  if (shown !== version) return { card: true, dot: true, markShown: true, newPlayer: false };
  return { card: false, dot: true, markShown: false, newPlayer: false };
}

/** localStorage (or the injected one); null when there is none or touching it throws. */
function store(dep) {
  if (dep !== undefined) return dep;
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

/**
 * Read both keys + the save, decide (`noticeState`), write what the decision says. Any storage failure
 * (no storage, a throwing read or write) → `{ card: false, dot: false }`: never nag.
 * @param {object|null} [storage]  localStorage-like { getItem, setItem }; omitted = the page's
 * @param {string} [version]
 * @returns {{ card: boolean, dot: boolean }}
 */
export function readNotice(storage, version = Constants.VERSION) {
  const none = { card: false, dot: false };
  try {
    const st = store(storage);
    if (!st || typeof st.getItem !== 'function' || typeof st.setItem !== 'function') return none;
    const state = noticeState({
      version,
      shown: st.getItem(StorageKeys.WHATS_NEW_SHOWN),
      seen: st.getItem(StorageKeys.WHATS_NEW_SEEN),
      hasSave: st.getItem(StorageKeys.SAVE) != null,
    });
    if (state.newPlayer) {
      st.setItem(StorageKeys.WHATS_NEW_SHOWN, version);
      st.setItem(StorageKeys.WHATS_NEW_SEEN, version);
    } else if (state.markShown) {
      st.setItem(StorageKeys.WHATS_NEW_SHOWN, version);
    }
    return { card: state.card, dot: state.dot };
  } catch (_) {
    return none;
  }
}

/**
 * The notes were opened or dismissed: remember this version as seen.
 * @param {object|null} [storage]
 * @param {string} [version]
 * @returns {boolean} true when written
 */
export function markSeen(storage, version = Constants.VERSION) {
  try {
    const st = store(storage);
    if (!st || typeof st.setItem !== 'function') return false;
    st.setItem(StorageKeys.WHATS_NEW_SEEN, version);
    return true;
  } catch (_) {
    return false;
  }
}

// ── the notes (D4a) ──────────────────────────────────────────────────────────

/**
 * One fetch of the running build's `./data/whats-new.json`. `null` on any fetch / parse failure, when the
 * file names another version than `version`, or when it carries no lines.
 * @param {Function} [fetchFn]  (url) → Promise<Response-like { ok, text() }>; omitted = the page's fetch
 * @param {string} [version]
 * @returns {Promise<{ version: string, bullets: string[] }|null>}
 */
export async function loadNotes(fetchFn, version = Constants.VERSION) {
  try {
    const f = fetchFn || (typeof globalThis.fetch === 'function' ? (u) => globalThis.fetch(u) : null);
    if (!f) return null;
    const r = await f('./data/whats-new.json');
    if (!r || !r.ok) return null;
    const text = await r.text();
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || json.version !== version) return null;
    const bullets = parseBullets(text);
    return bullets.length ? { version, bullets } : null;
  } catch (_) {
    return null;
  }
}

// ── placement (D4) ───────────────────────────────────────────────────────────

/**
 * Where the fixed card sits: just under the version button, left edges aligned, at most MAX_WIDTH_PX wide
 * and always EDGE_PX clear of the right edge of the screen.
 * @param {{ left: number, bottom: number }} rect  the version button's bounding box
 * @param {number} viewportW
 * @returns {{ top: number, left: number, width: number }}
 */
export function placeNotice(rect, viewportW) {
  const left = Math.max(WHATS_NEW_CARD.EDGE_PX, rect.left);
  const width = clamp(viewportW - left - WHATS_NEW_CARD.EDGE_PX, 0, WHATS_NEW_CARD.MAX_WIDTH_PX);
  return { top: rect.bottom + WHATS_NEW_CARD.GAP_PX, left, width };
}

/** The status line for a finished check. */
export function checkStatusText(status) {
  return status === 'current' ? WHATS_NEW_CARD.CURRENT_LABEL : WHATS_NEW_CARD.OFFLINE_LABEL;
}

// ── the DOM ──────────────────────────────────────────────────────────────────

const FONT = 'var(--font-ui)';   // proportional (B612): bullets wrap less and the apostrophe is not spaced out as in the mono face

const CARD_CSS = `
  position: fixed; z-index: 60; display: block; box-sizing: border-box; width: ${WHATS_NEW_CARD.MAX_WIDTH_PX}px;
  padding: 12px 14px 8px; text-align: left;
  background: rgb(4,12,30); border: 1px solid rgba(0,204,255,0.4); border-radius: 8px;
  font-family: ${FONT}; color: #aaddff; pointer-events: auto;
`;
const TITLE_CSS = `
  font-size: 0.82rem; color: rgb(0,204,255); letter-spacing: 0.16em; margin: 0 0 0.5rem;
`;
const LIST_CSS = `
  list-style: square; margin: 0 0 0.6rem; padding: 0 0 0 1.2em;
  font-size: 0.85rem; line-height: 1.45; color: #aaddff;
`;
const ITEM_CSS = 'margin: 0 0 0.3rem;';
const PRIMARY_BTN_CSS = `
  display: block; width: 100%; box-sizing: border-box; min-height: ${WHATS_NEW_CARD.BUTTON_MIN_H_PX}px;
  font-family: ${FONT}; font-size: 0.9rem; color: #00ff88; letter-spacing: 0.18em;
  background: rgba(0,255,136,0.12); border: 2px solid rgba(0,255,136,0.5);
  padding: 8px 16px; cursor: pointer; border-radius: 4px;
`;
const LINK_BTN_CSS = `
  display: block; width: 100%; box-sizing: border-box; min-height: ${WHATS_NEW_CARD.BUTTON_MIN_H_PX}px;
  margin-top: 2px; font-family: ${FONT}; font-size: 0.74rem; color: rgba(170,221,255,0.75);
  background: transparent; border: none; padding: 8px 16px; cursor: pointer; letter-spacing: 0.12em;
`;
const STATUS_CSS = `
  min-height: ${WHATS_NEW_CARD.BUTTON_MIN_H_PX}px; box-sizing: border-box; padding: 12px 16px; text-align: center;
  font-size: 0.82rem; letter-spacing: 0.04em; color: #d4eeff;
`;

/**
 * Build the card. Pure: touches only `doc` and the returned subtree. The caller places it (`placeNotice`)
 * and mounts it as a child of `#menu-screen`.
 * @param {Document|object} doc  the document (injected — the test drives a fake)
 * @param {object} p
 * @param {string} p.version                the notes' version, e.g. '1.02' (the title renders `V1.02`)
 * @param {string[]} p.bullets              the three lines of the running build
 * @param {'updated'|'opened'} [p.mode]     `updated` = the once-only card after an update
 * @param {Function} [p.onGotIt]            GOT IT click
 * @param {boolean} [p.updateReady]         a newer build is waiting: show `New version ready` + RESTART NOW
 *                                          instead of the check link
 * @param {Function} [p.onRestart]          RESTART NOW click
 * @param {Function} [p.onCheck]            () → Promise<'ready'|'current'|'offline'>; absent → no check link
 * @param {Function} [p.onReady]            called when a check found a build (the owner closes this card)
 * @returns {HTMLElement|object} `#menu-whats-new`
 */
export function buildWhatsNewCard(doc, { version, bullets, mode = 'opened', onGotIt, updateReady = false, onRestart, onCheck, onReady } = {}) {
  const card = doc.createElement('div');
  card.id = WHATS_NEW_CARD.ID;
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.style.cssText = CARD_CSS;

  const title = doc.createElement('div');
  title.className = 'whats-new-title';
  title.textContent = `${mode === 'updated' ? WHATS_NEW_CARD.TITLE_UPDATED : WHATS_NEW_CARD.TITLE_OPENED} V${version}`;
  title.style.cssText = TITLE_CSS;
  card.appendChild(title);

  const list = Array.isArray(bullets) ? bullets.filter((b) => typeof b === 'string' && b.trim()) : [];
  if (list.length) {
    const ul = doc.createElement('ul');
    ul.className = WHATS_NEW_CARD.BULLETS_CLASS;
    ul.style.cssText = LIST_CSS;
    for (const text of list) {
      const li = doc.createElement('li');
      li.textContent = text;
      li.style.cssText = ITEM_CSS;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  const gotIt = doc.createElement('button');
  gotIt.id = WHATS_NEW_CARD.GOT_IT_ID;
  gotIt.setAttribute('type', 'button');
  gotIt.textContent = WHATS_NEW_CARD.GOT_IT_LABEL;
  gotIt.style.cssText = PRIMARY_BTN_CSS;
  gotIt.addEventListener('click', () => { if (typeof onGotIt === 'function') onGotIt(); });
  card.appendChild(gotIt);

  if (updateReady) {
    const ready = doc.createElement('div');
    ready.className = 'whats-new-ready';
    ready.textContent = WHATS_NEW_CARD.READY_TITLE;
    ready.style.cssText = `${TITLE_CSS} margin: 0.7rem 0 0.2rem; text-align: center;`;
    card.appendChild(ready);
    const restart = doc.createElement('button');
    restart.id = WHATS_NEW_CARD.RESTART_ID;
    restart.setAttribute('type', 'button');
    restart.textContent = WHATS_NEW_CARD.RESTART_LABEL;
    restart.style.cssText = PRIMARY_BTN_CSS;
    restart.addEventListener('click', () => { if (typeof onRestart === 'function') onRestart(); });
    card.appendChild(restart);
  } else if (typeof onCheck === 'function') {
    const check = doc.createElement('button');
    check.id = WHATS_NEW_CARD.CHECK_ID;
    check.setAttribute('type', 'button');
    check.textContent = WHATS_NEW_CARD.CHECK_LABEL;
    check.style.cssText = LINK_BTN_CSS;
    let busy = false;
    check.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      check.textContent = WHATS_NEW_CARD.CHECKING_LABEL;
      let run;
      try { run = Promise.resolve(onCheck()); } catch (_) { run = Promise.resolve('offline'); }
      run.catch(() => 'offline').then((status) => {
        busy = false;
        if (status === 'ready') {
          if (typeof onReady === 'function') onReady();
          return;
        }
        // The line replaces the link; the card stays put (no layout jump: same height as the link).
        const line = doc.createElement('div');
        line.id = WHATS_NEW_CARD.STATUS_ID;
        line.setAttribute('role', 'status');
        line.textContent = checkStatusText(status);
        line.style.cssText = STATUS_CSS;
        if (check.replaceWith) check.replaceWith(line);
        else if (card.removeChild) { card.removeChild(check); card.appendChild(line); }
      });
    });
    card.appendChild(check);
  }
  return card;
}

export default buildWhatsNewCard;
