/**
 * @module ui/DemoEndCard — the end screen of demo mode (owner 2026-10-29; systems/DemoEnd.js decides when). Title, what the
 * player caught, one line about the full game, one big "Play again" button (= the New player reset: the next person gets a
 * fresh start). Modelled on StillPlayingCard: a modal over the HUD, built with an injected `doc` (tests drive a fake), z-index
 * at the same layer, buttons at least 44 px.
 *
 * While it is up it keeps every pointer, touch and key from reaching the game under it (the game is paused behind it).
 * Enter / Space press Play again; every other key is swallowed. Any touch tells `onTouch` (the walk-away clock restarts).
 * Words come from demoEndText.js.
 */

import { demoEndTextFor, caughtLine, countdownLine, NO_SPACING_LANGS } from './demoEndText.js';

/** Smallest touch target (Apple HIG), CSS px each way. */
export const BUTTON_MIN_PX = 44;
/** Same layer as the "Still playing?" card (above the HUD and its panes, below the debug overlay). */
export const CARD_Z = 100000;

export const OVERLAY_ID = 'demo-end-card';
const BUTTON_ID = 'demo-end-again';
const CAUGHT_ID = 'demo-end-caught';
const COUNT_ID = 'demo-end-countdown';

const ACT_KEYS = new Set(['Enter', ' ', 'Spacebar']);
const POINTER_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown', 'mouseup', 'click'];

export class DemoEndCard {
  /**
   * @param {object} d
   * @param {Document|object} d.doc          the document (injected)
   * @param {object} [d.win]                 where the key swallower listens (default `window`)
   * @param {Function} [d.getLanguage]       () => language code; read again on every open
   * @param {Function} [d.onPlayAgain]       Play again (button, Enter, Space)
   * @param {Function} [d.onTouch]           any touch or key on the card
   */
  constructor({ doc, win, getLanguage, onPlayAgain, onTouch } = {}) {
    this._doc = doc;
    this._win = win || (typeof window !== 'undefined' ? window : null);
    this._getLanguage = typeof getLanguage === 'function' ? getLanguage : () => 'en';
    this._onPlayAgain = typeof onPlayAgain === 'function' ? onPlayAgain : () => {};
    this._onTouch = typeof onTouch === 'function' ? onTouch : () => {};
    this._el = null;
    this._countEl = null;
    this._btn = null;
    this._lang = 'en';
    this._keyHandler = (e) => this._onKey(e);
  }

  /** @returns {boolean} */
  isOpen() { return this._el !== null; }

  /** The overlay element while open, else null. */
  get element() { return this._el; }

  /** @param {{ caught: number }} a pieces the player caught */
  open({ caught } = {}) {
    if (this._el || !this._doc) return;
    const doc = this._doc;
    this._lang = this._getLanguage() || 'en';
    const t = demoEndTextFor(this._lang);
    const plain = NO_SPACING_LANGS.includes(this._lang);
    const type = plain ? 'letter-spacing:normal;text-transform:none;' : 'letter-spacing:0.08em;';

    const overlay = doc.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t.title);
    overlay.style.cssText = `position:fixed;left:0;top:0;right:0;bottom:0;z-index:${CARD_Z};display:flex;align-items:center;justify-content:center;`
      + 'background:rgba(2,6,16,0.72);touch-action:none;font-family:var(--font-ui);';

    const card = doc.createElement('div');
    card.style.cssText = 'box-sizing:border-box;width:560px;max-width:86vw;padding:36px 40px;text-align:center;color:#d4eeff;'
      + 'background:rgba(4,12,30,0.94);border:1px solid rgba(0,255,136,0.5);border-radius:10px;box-shadow:0 0 40px rgba(0,255,136,0.18);';

    const title = doc.createElement('div');
    title.textContent = t.title;
    title.style.cssText = `font-size:2.2rem;font-weight:700;color:#00ff88;margin-bottom:18px;${type}`;
    card.appendChild(title);

    const got = doc.createElement('div');
    got.id = CAUGHT_ID;
    got.textContent = caughtLine(this._lang, caught);
    got.style.cssText = 'font-size:1.4rem;font-weight:600;margin-bottom:14px;';
    card.appendChild(got);

    const next = doc.createElement('div');
    next.textContent = t.next;
    next.style.cssText = 'font-size:1.1rem;line-height:1.5;color:rgba(212,238,255,0.8);margin-bottom:28px;';
    card.appendChild(next);

    const btn = doc.createElement('button');
    btn.id = BUTTON_ID;
    btn.setAttribute('type', 'button');
    btn.textContent = t.playAgain;
    btn.style.cssText = `min-width:240px;min-height:${BUTTON_MIN_PX + 20}px;box-sizing:border-box;padding:0 32px;font:inherit;font-size:1.4rem;font-weight:700;cursor:pointer;border-radius:10px;`
      + `background:#00ff88;color:#021008;border:1px solid #00ff88;${type}`;
    btn.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); this._onPlayAgain(); });
    card.appendChild(btn);
    this._btn = btn;

    const count = doc.createElement('div');
    count.id = COUNT_ID;
    count.setAttribute('aria-live', 'polite');
    count.textContent = '';
    count.style.cssText = 'min-height:1.6em;margin-top:18px;font-size:1.1rem;font-variant-numeric:tabular-nums;color:rgba(212,238,255,0.8);';
    card.appendChild(count);
    this._countEl = count;

    overlay.appendChild(card);
    // Nothing reaches the game under the card; every touch restarts the walk-away clock.
    for (const ev of POINTER_EVENTS) {
      overlay.addEventListener(ev, (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (ev === 'pointerdown' || ev === 'touchstart' || ev === 'mousedown' || ev === 'click') this._onTouch();
      });
    }

    const host = doc.body || doc.documentElement;
    host.appendChild(overlay);
    this._el = overlay;
    if (this._win && this._win.addEventListener) this._win.addEventListener('keydown', this._keyHandler, true);
    try { if (btn.focus) btn.focus(); } catch (_) { /* no focus in a fake */ }
  }

  /** @param {number|null} seconds the walk-away countdown; null clears it (a touch restarted the clock) */
  setCountdown(seconds) {
    if (!this._countEl) return;
    this._countEl.textContent = seconds == null ? '' : countdownLine(this._lang, seconds);
  }

  close() {
    if (this._win && this._win.removeEventListener) this._win.removeEventListener('keydown', this._keyHandler, true);
    const el = this._el;
    this._el = null; this._countEl = null; this._btn = null;
    if (el && el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
  }

  _onKey(e) {
    if (!this._el || !e) return;
    const stop = () => { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else if (e.stopPropagation) e.stopPropagation(); };
    stop();
    this._onTouch();
    if (ACT_KEYS.has(e.key)) {
      if (e.target && e.target === this._btn) return;   // Enter / Space on the focused button: its own click does it
      if (e.preventDefault) e.preventDefault();
      this._onPlayAgain();
      return;
    }
    if (e.key !== 'Tab' && e.preventDefault) e.preventDefault();
  }
}

export default DemoEndCard;
