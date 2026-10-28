/**
 * @module ui/StillPlayingCard — the "Still playing?" card of the shared-iPad show mode (DECISIONS §52 row 2).
 * "Keep playing" (a tap anywhere outside the buttons, or Esc / Enter / Space) returns to the exact state; "New player"
 * (or the countdown reaching zero) starts the reset (IdleReset.js).
 *
 *  - `StillPlayingCard`: the DOM (a modal over the HUD), built with an injected `doc` (tests drive a fake). Words come
 *    from stillPlayingText.js.
 *  - `wireStillPlaying`: the glue main.js calls once. It builds the idle clock and the card, pauses the game behind the
 *    card through the SAME path as Esc (`InputManager.togglePause`, which emits PAUSE_RESUME on the way back), only when
 *    the card did the pausing, and runs the countdown from the clock's own timer (a paused game loop schedules no
 *    frames, so the loop cannot drive it).
 *
 * While the card is up it swallows Esc, Enter and Space in the capture phase (Esc would toggle pause, Enter on the menu
 * would start a game) and keeps every other key and touch from reaching the game under it.
 */

import { IdleReset } from '../systems/IdleReset.js';
import { stillPlayingTextFor, countdownLine, NO_SPACING_LANGS } from './stillPlayingText.js';

/** Smallest touch target (Apple HIG), CSS px each way. */
export const BUTTON_MIN_PX = 44;
/** Above the HUD and its panes (the highest game layer is 99999), below the debug overlay. */
export const CARD_Z = 100000;

const OVERLAY_ID = 'still-playing-card';
const KEEP_ID = 'still-playing-keep';
const NEW_ID = 'still-playing-new';
const LINE_ID = 'still-playing-line';

const KEEP_KEYS = new Set(['Escape', 'Enter', ' ', 'Spacebar']);
const POINTER_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown', 'mouseup'];

export class StillPlayingCard {
  /**
   * @param {object} d
   * @param {Document|object} d.doc          the document (injected)
   * @param {object} [d.win]                 where the key swallower listens (default `window`)
   * @param {Function} [d.getLanguage]       () => language code; read again on every open
   * @param {Function} [d.onKeep]            Keep playing
   * @param {Function} [d.onNewPlayer]       New player
   */
  constructor({ doc, win, getLanguage, onKeep, onNewPlayer } = {}) {
    this._doc = doc;
    this._win = win || (typeof window !== 'undefined' ? window : null);
    this._getLanguage = typeof getLanguage === 'function' ? getLanguage : () => 'en';
    this._onKeep = typeof onKeep === 'function' ? onKeep : () => {};
    this._onNew = typeof onNewPlayer === 'function' ? onNewPlayer : () => {};
    this._el = null;
    this._lineEl = null;
    this._lang = 'en';
    this._keyHandler = (e) => this._onKey(e);
  }

  /** @returns {boolean} */
  isOpen() { return this._el !== null; }

  /** The overlay element while open, else null. */
  get element() { return this._el; }

  /** @param {number} seconds the full countdown */
  open(seconds) {
    if (this._el || !this._doc) return;
    const doc = this._doc;
    this._lang = this._getLanguage() || 'en';
    const t = stillPlayingTextFor(this._lang);
    const plain = NO_SPACING_LANGS.includes(this._lang);
    const type = plain ? 'letter-spacing:normal;text-transform:none;' : 'letter-spacing:0.08em;';

    const overlay = doc.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t.title);
    overlay.style.cssText = `position:fixed;left:0;top:0;right:0;bottom:0;z-index:${CARD_Z};display:flex;align-items:center;justify-content:center;`
      + 'background:rgba(2,6,16,0.62);touch-action:none;font-family:var(--font-ui);';   // the browser falls back per glyph for Thai, Japanese, Hindi, Tamil

    const card = doc.createElement('div');
    card.style.cssText = 'box-sizing:border-box;min-width:360px;max-width:80vw;padding:28px 32px;text-align:center;color:#d4eeff;'
      + 'background:rgba(4,12,30,0.94);border:1px solid rgba(0,255,136,0.5);border-radius:10px;box-shadow:0 0 40px rgba(0,255,136,0.18);';

    const title = doc.createElement('div');
    title.textContent = t.title;
    title.style.cssText = `font-size:1.9rem;font-weight:700;color:#00ff88;margin-bottom:12px;${type}`;
    card.appendChild(title);

    const line = doc.createElement('div');
    line.id = LINE_ID;
    line.setAttribute('aria-live', 'polite');
    line.textContent = countdownLine(this._lang, seconds);
    line.style.cssText = 'font-size:1.25rem;margin-bottom:22px;font-variant-numeric:tabular-nums;';
    card.appendChild(line);
    this._lineEl = line;

    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:16px;justify-content:center;flex-wrap:wrap;';
    const mk = (id, text, primary, handler) => {
      const b = doc.createElement('button');
      b.id = id;
      b.setAttribute('type', 'button');
      b.textContent = text;
      b.style.cssText = `min-width:${BUTTON_MIN_PX}px;min-height:${BUTTON_MIN_PX + 12}px;box-sizing:border-box;padding:0 24px;font:inherit;font-size:1.15rem;font-weight:700;cursor:pointer;border-radius:8px;${type}`
        + (primary ? 'background:#00ff88;color:#021008;border:1px solid #00ff88;' : 'background:rgba(4,12,30,0.8);color:#d4eeff;border:1px solid rgba(212,238,255,0.5);');
      b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); handler(); });
      return b;
    };
    this._keepBtn = mk(KEEP_ID, t.keep, true, () => this._onKeep());
    this._newBtn = mk(NEW_ID, t.newPlayer, false, () => this._onNew());
    row.appendChild(this._keepBtn);
    row.appendChild(this._newBtn);
    card.appendChild(row);
    overlay.appendChild(card);

    // A tap anywhere outside the two buttons = Keep playing. Pointer events stop here so the game under the card never
    // sees them; the dismissal rides `click`, so the tap's pointerup cannot land on the game after the card is gone.
    for (const ev of POINTER_EVENTS) overlay.addEventListener(ev, (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
    overlay.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (e && (e.target === this._keepBtn || e.target === this._newBtn)) return;
      this._onKeep();
    });

    const host = doc.body || (doc.documentElement);
    host.appendChild(overlay);
    this._el = overlay;
    if (this._win && this._win.addEventListener) this._win.addEventListener('keydown', this._keyHandler, true);
    try { if (this._keepBtn.focus) this._keepBtn.focus(); } catch (_) { /* no focus in a fake */ }
  }

  setRemaining(seconds) {
    if (this._lineEl) this._lineEl.textContent = countdownLine(this._lang, seconds);
  }

  close() {
    if (this._win && this._win.removeEventListener) this._win.removeEventListener('keydown', this._keyHandler, true);
    const el = this._el;
    this._el = null; this._lineEl = null; this._keepBtn = null; this._newBtn = null;
    if (el && el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
  }

  _onKey(e) {
    if (!this._el || !e) return;
    const key = e.key;
    const onButton = !!(e.target && (e.target === this._keepBtn || e.target === this._newBtn));
    if (KEEP_KEYS.has(key)) {
      if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else if (e.stopPropagation) e.stopPropagation();
      if (onButton && key !== 'Escape') return;   // Enter / Space on a focused button presses that button
      if (e.preventDefault) e.preventDefault();
      this._onKeep();
      return;
    }
    // Everything else stays out of the game under the card (Tab keeps its focus move, nothing more).
    if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else if (e.stopPropagation) e.stopPropagation();
    if (key !== 'Tab' && e.preventDefault) e.preventDefault();
  }
}

/**
 * Build the idle clock and the card and join them to the game.
 * @param {object} d
 * @param {Document|object} d.doc
 * @param {object} [d.win]
 * @param {Function} d.getLanguage   () => code
 * @param {Function} d.enabled       () => show mode on
 * @param {Function} d.onMenu        () => the menu is up
 * @param {Function} d.holds         () => the game plays itself out
 * @param {Function} d.reset         () => the New player reset (resetForNewPlayer with the page's deps)
 * @param {{ isGameplay: Function, isPaused: Function, toggle: Function }} d.pause  the Esc path
 * @param {Function} [d.now]
 * @param {Function} [d.needsReset]
 * @param {number} [d.idleS]
 * @param {number} [d.countdownS]
 * @returns {{ idle: IdleReset, card: StillPlayingCard, noteInput: Function, tick: Function }}
 */
export function wireStillPlaying(d) {
  let pausedByCard = false;
  let idle = null;
  const card = new StillPlayingCard({
    doc: d.doc, win: d.win, getLanguage: d.getLanguage,
    onKeep: () => idle.keepPlaying(),
    onNewPlayer: () => idle.newPlayer(),
  });
  idle = new IdleReset({
    now: d.now, enabled: d.enabled, onMenu: d.onMenu, holds: d.holds, needsReset: d.needsReset,
    idleS: d.idleS, countdownS: d.countdownS, reset: d.reset,
    onCard: (remaining) => {
      pausedByCard = false;
      const p = d.pause;
      if (p && p.isGameplay() && !p.isPaused()) pausedByCard = p.toggle() === true;
      card.open(remaining);
    },
    onCountdown: (remaining) => card.setRemaining(remaining),
    onKeep: () => {
      card.close();
      const p = d.pause;
      if (pausedByCard && p && p.isPaused()) p.toggle();   // togglePause emits PAUSE_RESUME: without it the screen freezes
      pausedByCard = false;
    },
  });
  return {
    idle, card,
    noteInput: () => idle.noteInput(),
    tick: () => idle.tick(),
  };
}

/**
 * Run the idle clock's own timer and its come-back-from-hidden tick ONLY while show mode is on (off means off: no timer,
 * no listener). Turning it on starts them, off stops them.
 * @param {object} d
 * @param {{ isOn: Function, onChange: Function }} d.showMode
 * @param {{ tick: Function }} d.kit              what wireStillPlaying returned
 * @param {Document|object} d.doc
 * @param {Function} [d.setIntervalFn]            injectable (default: the global setInterval)
 * @param {Function} [d.clearIntervalFn]
 * @param {number} [d.everyMs]                    default 250
 * @returns {{ running: () => boolean, sync: Function }}
 */
export function wireIdleTimers(d) {
  const setI = d.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
  const clearI = d.clearIntervalFn || ((h) => clearInterval(h));
  const everyMs = d.everyMs || 250;
  let handle = null;
  let on = false;
  const onVisible = () => { if (!d.doc.hidden) d.kit.tick(); };
  const sync = () => {
    const want = !!d.showMode.isOn();
    if (want && !on) {
      on = true;
      if (typeof d.kit.noteInput === 'function') d.kit.noteInput();   // switched on: the count starts fresh, not from the hours already passed
      handle = setI(() => d.kit.tick(), everyMs);
      d.doc.addEventListener('visibilitychange', onVisible);
    } else if (!want && on) {
      on = false;
      clearI(handle); handle = null;
      if (typeof d.doc.removeEventListener === 'function') d.doc.removeEventListener('visibilitychange', onVisible);
    }
  };
  if (typeof d.showMode.onChange === 'function') d.showMode.onChange(sync);
  sync();
  return { running: () => on, sync };
}

export default StillPlayingCard;
