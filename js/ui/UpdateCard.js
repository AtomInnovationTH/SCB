/**
 * UpdateCard.js — the menu "NEW VERSION READY" card (Session J.5 item 5).
 *
 * A pure DOM builder over an injected `document`: no bus, no Events, no
 * Constants, no timers, no animation. MenuScreen mounts it inside
 * `#menu-header` right after `#menu-continue-wrapper` when UpdateWatch has a
 * pending payload, and removes it on LATER. It never exists in the DOM until
 * an update arrives (a `?ladder=0` boot stays byte-identical), and never
 * renders outside `#menu-screen` (the menu hides → the card hides with it).
 *
 * THE LOOK: the translucent `#menu-left` card (rgba(4,12,30,0.52) plate,
 * blur(6px), 1px rgba(0,255,136,0.14) hairline, 8px radius), the house mono
 * token (B612 Mono since Session L),
 * #00ff88 — a STEADY letter-spaced title (no pulse, no emoji anywhere), an
 * optional bullet list (omitted entirely when empty), a big primary
 * `TAP TO UPDATE` button and a quiet `LATER` text button; both ≥ 44 px tall
 * (the touch-target minimum). Text goes in through `textContent` only.
 *
 * @module ui/UpdateCard
 */

/** The card's fixed numbers + strings (own-module export; the house rule). */
export const UPDATE_CARD = Object.freeze({
  ID: 'menu-update-card',
  UPDATE_BTN_ID: 'menu-update-btn',
  LATER_BTN_ID: 'menu-update-later',
  BULLETS_CLASS: 'update-bullets',
  TITLE: 'NEW VERSION READY',
  UPDATE_LABEL: 'TAP TO UPDATE',
  LATER_LABEL: 'LATER',
  /** Card width cap (px) — sits centered under the START / CONTINUE buttons. */
  MAX_WIDTH_PX: 420,
  /** Both buttons' minimum height (px) — the 44 pt touch-target minimum. */
  BUTTON_MIN_H_PX: 44,
});

// Session L: the B612 Mono token (index.html :root --font-mono; Courier New is its fallback).
const FONT = 'var(--font-mono)';

const CARD_CSS = `
  display: block; box-sizing: border-box; width: 100%; max-width: ${UPDATE_CARD.MAX_WIDTH_PX}px;
  margin: 0.9rem auto 0; padding: 14px 16px 12px; text-align: center;
  background: rgba(4,12,30,0.52); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  border: 1px solid rgba(0,255,136,0.14); border-radius: 8px;
  font-family: ${FONT}; color: rgba(0,255,136,0.85);
`;
const TITLE_CSS = `
  font-size: 0.95rem; color: #00ff88; letter-spacing: 0.22em;
  text-shadow: 0 0 10px rgba(0,255,136,0.45); margin: 0 0 0.55rem;
`;
const LIST_CSS = `
  list-style: square; margin: 0 0 0.75rem; padding: 0 0 0 1.3em; text-align: left;
  font-size: 0.86rem; line-height: 1.55; color: rgba(0,255,136,0.72);
`;
const ITEM_CSS = `
  margin: 0 0 0.3rem;
`;
const UPDATE_BTN_CSS = `
  display: block; width: 100%; box-sizing: border-box; min-height: ${UPDATE_CARD.BUTTON_MIN_H_PX}px;
  font-family: ${FONT}; font-size: 1.05rem; color: #00ff88;
  background: rgba(0,255,136,0.12); border: 2px solid rgba(0,255,136,0.5);
  padding: 12px 24px; cursor: pointer; border-radius: 4px; letter-spacing: 0.2em;
  text-shadow: 0 0 10px rgba(0,255,136,0.5); transition: background 0.3s, border-color 0.3s, box-shadow 0.3s;
`;
const LATER_BTN_CSS = `
  display: block; width: 100%; box-sizing: border-box; min-height: ${UPDATE_CARD.BUTTON_MIN_H_PX}px;
  margin-top: 4px; font-family: ${FONT}; font-size: 0.8rem; color: rgba(0,255,136,0.6);
  background: transparent; border: none; padding: 10px 24px; cursor: pointer;
  letter-spacing: 0.18em; transition: color 0.2s;
`;

/**
 * Build the card. Pure: touches only `doc` and the returned subtree.
 * @param {Document|object} doc  the document (injected — the test drives a fake)
 * @param {object} p
 * @param {string} [p.hash]            the new build's short sha (rendered as a quiet caption)
 * @param {string[]} [p.bullets]       ≤ 3 strings; `[]` / absent → no list at all
 * @param {Function} [p.onUpdate]      TAP TO UPDATE click
 * @param {Function} [p.onLater]       LATER click
 * @returns {HTMLElement|object} `#menu-update-card`
 */
export function buildUpdateCard(doc, { hash, bullets, onUpdate, onLater } = {}) {
  const card = doc.createElement('div');
  card.id = UPDATE_CARD.ID;
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.style.cssText = CARD_CSS;

  const title = doc.createElement('div');
  title.className = 'update-title';
  title.textContent = UPDATE_CARD.TITLE;
  title.style.cssText = TITLE_CSS;
  card.appendChild(title);

  const list = Array.isArray(bullets) ? bullets.filter((b) => typeof b === 'string' && b.trim()) : [];
  if (list.length) {
    const ul = doc.createElement('ul');
    ul.className = UPDATE_CARD.BULLETS_CLASS;
    ul.style.cssText = LIST_CSS;
    for (const text of list) {
      const li = doc.createElement('li');
      li.textContent = text;
      li.style.cssText = ITEM_CSS;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  const btn = doc.createElement('button');
  btn.id = UPDATE_CARD.UPDATE_BTN_ID;
  btn.setAttribute('type', 'button');
  btn.textContent = UPDATE_CARD.UPDATE_LABEL;
  btn.style.cssText = UPDATE_BTN_CSS;
  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(0,255,136,0.25)';
    btn.style.borderColor = '#00ff88';
    btn.style.boxShadow = '0 0 20px rgba(0,255,136,0.3)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'rgba(0,255,136,0.12)';
    btn.style.borderColor = 'rgba(0,255,136,0.5)';
    btn.style.boxShadow = 'none';
  });
  btn.addEventListener('click', () => { if (typeof onUpdate === 'function') onUpdate(); });
  card.appendChild(btn);

  const later = doc.createElement('button');
  later.id = UPDATE_CARD.LATER_BTN_ID;
  later.setAttribute('type', 'button');
  later.textContent = UPDATE_CARD.LATER_LABEL;
  later.style.cssText = LATER_BTN_CSS;
  later.addEventListener('click', () => { if (typeof onLater === 'function') onLater(); });
  card.appendChild(later);

  if (typeof hash === 'string' && hash) {
    const cap = doc.createElement('div');
    cap.className = 'update-hash';
    cap.textContent = `build ${hash}`;
    cap.style.cssText = 'font-size: 0.66rem; letter-spacing: 0.12em; color: rgba(0,255,136,0.4); margin-top: 6px;';
    card.appendChild(cap);
  }
  return card;
}

export default buildUpdateCard;
