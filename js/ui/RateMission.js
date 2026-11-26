/**
 * @module ui/RateMission — the "Rate mission" button at the bottom right when a mission ends (owner 2026-11-25/26:
 * feedback must cost one tap, right when the mission feels right or wrong). Dev hosts only (DevHost.isDevHost: this Mac,
 * or the iPad through `start.sh --lan`); the public site never builds it (`wireRateMission` returns null there).
 *
 * Shows on MISSION_COMPLETE (training 1-3 and real missions), on the game-over screen (failed) and on the win screen.
 * Pauses nothing and covers no game control. Goes away at the next credited catch, on the menu, when the game-over or win
 * screen is left, or about 2 s after a rating is saved.
 *
 * One tap opens a card: the mission's name and outcome, 5 stars, an optional line of text, Send, × (Esc too). Send POSTs one
 * JSON file to the page's own server (`scripts/serve.mjs`, `/__rating`, saved under `ratings/`); where that server cannot
 * take it, the same JSON downloads. The body carries the whole play log (PlayRecorder.snapshot).
 *
 * Node-safe: no `window`/`document` at module scope; the DOM is built with an injected `doc` (tests drive a fake).
 */

import { eventBus as defaultBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { getMissionProgress, missionName } from '../core/missionProgress.js';
import { isDevHost } from '../core/DevHost.js';

/** Smallest touch target (Apple HIG), CSS px each way. */
export const TARGET_MIN_PX = 44;
/** Above the game-over screen (50) and the mission headline (9000), below the help page (9999). */
export const RATE_Z = 9500;
/** Distance of the button from the right and bottom edges, CSS px (= the HUD edge inset). Measured 2026-11-26 at 1728×1117 and
 *  1366×1024 (touch): the button sits 72 px below the DETAIL slider row and clear of the ORB chip and the footer band. */
export const EDGE_RIGHT_PX = 16;
export const EDGE_BOTTOM_PX = 16;
export const TEXT_MAX = 1000;
export const RATING_URL = '/__rating';
export const BUTTON_ID = 'rate-mission-btn';
export const CARD_ID = 'rate-mission-card';
const SENT_HIDE_MS = 2000;

const POINTER_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown', 'mouseup'];
const FIELD_KEY_EVENTS = ['keydown', 'keyup', 'keypress'];

const p2 = (x) => String(x).padStart(2, '0');

export class RateMission {
  /**
   * @param {object} d
   * @param {Document|object} d.doc
   * @param {object} [d.win]                       where the Esc handler listens (default `window`)
   * @param {{on: Function}} [d.bus]               the event bus (default the game's)
   * @param {{debrisCleared:number}} d.gameState   read for the catch count and the failed mission's number
   * @param {{snapshot: Function}} d.recorder      the play recorder (its `snapshot()` goes into the file)
   * @param {Function} [d.getInput]                () => 'touch'|'mouse'
   * @param {Function} [d.fetchFn]                 default `fetch`
   * @param {Function} [d.setTimer]                default `setTimeout`
   * @param {Function} [d.now]                     () => Date, default `new Date()`
   */
  constructor({ doc, win, bus, gameState, recorder, getInput, fetchFn, setTimer, now } = {}) {
    this._doc = doc;
    this._win = win || (typeof window !== 'undefined' ? window : null);
    this._bus = bus || defaultBus;
    this._gs = gameState || { debrisCleared: 0 };
    this._rec = recorder || null;
    this._getInput = typeof getInput === 'function' ? getInput : () => 'mouse';
    this._fetch = fetchFn || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._now = now || (() => new Date());
    this._offs = [];
    this._btn = null;
    this._card = null;
    this._shownBy = null;        // 'event' (MISSION_COMPLETE) | 'state' (GAME_OVER / WIN screen)
    this._mission = 1;
    this._outcome = 'complete';
    this._reason = null;
    this._clearedAtShow = 0;
    this._stars = null;
    this._sending = false;
    this._sentMark = 0;
    this._keyHandler = (e) => this._onKey(e);
  }

  /** @returns {boolean} the button is up */
  isShown() { return this._btn !== null; }
  /** @returns {boolean} the card is open */
  isCardOpen() { return this._card !== null; }
  get button() { return this._btn; }
  get card() { return this._card; }
  /** What the next Send would call this: { mission, outcome, reason }. */
  get ending() { return { mission: this._mission, outcome: this._outcome, reason: this._reason }; }

  /** Subscribe to the game's events. */
  start() {
    if (this._offs.length) return this;
    const bus = this._bus;
    const sub = (ev, fn) => { const off = bus.on(ev, fn); if (typeof off === 'function') this._offs.push(off); };
    sub(Events.MISSION_COMPLETE, (d) => this._onMissionComplete(d));
    sub(Events.GAME_STATE_CHANGE, (d) => this._onState(d));
    sub(Events.CATCH_PROCESSED, () => this._onCatch());
    return this;
  }

  /** Unsubscribe and remove everything. */
  stop() {
    for (const off of this._offs) { try { off(); } catch (_) { /* gone */ } }
    this._offs = [];
    this.hide();
  }

  _onMissionComplete(d) {
    const m = Math.max(1, Math.floor(Number(d && d.mission)) || 1);
    this.show({ mission: m, outcome: 'complete', reason: null, by: 'event' });
  }

  _onState(d) {
    const to = d && d.to;
    if (to === GameStates.GAME_OVER) {
      const reason = d && typeof d.payload === 'string' ? d.payload : null;
      const mission = getMissionProgress(this._gs.debrisCleared).missionNum;   // the failed mission is the one being played
      this.show({ mission, outcome: 'failed', reason, by: 'state' });
    } else if (to === GameStates.WIN) {
      const mission = Math.max(1, getMissionProgress(this._gs.debrisCleared).missionsCompleted);
      this.show({ mission, outcome: 'complete', reason: null, by: 'state' });
    } else if (to === GameStates.MENU || this._shownBy === 'state') {
      this.hide();   // the menu, or leaving the game-over / win screen (retry, continue)
    }
  }

  /**
   * The last catch of a mission IS a CATCH_PROCESSED and MISSION_COMPLETE is emitted inside that same dispatch, and a second
   * `{ digested: true }` one can follow for the same body: only a HIGHER catch count than at show time is "the next catch".
   */
  _onCatch() {
    if (!this._btn) return;
    if ((Number(this._gs.debrisCleared) || 0) > this._clearedAtShow) this.hide();
  }

  /**
   * Show the button (a second call while it shows only updates the mission and outcome).
   * @param {{mission:number, outcome:'complete'|'failed', reason?:(string|null), by?:('event'|'state')}} a
   */
  show({ mission, outcome, reason = null, by = 'event' }) {
    if (!this._doc) return;
    this._mission = mission;
    this._outcome = outcome;
    this._reason = reason;
    this._shownBy = by;
    this._clearedAtShow = Number(this._gs.debrisCleared) || 0;
    if (this._btn) { this._refreshTitle(); return; }
    this._stars = null;
    this._sending = false;
    const doc = this._doc;
    const b = doc.createElement('button');
    b.id = BUTTON_ID;
    b.setAttribute('type', 'button');
    b.setAttribute('tabindex', '-1');
    b.textContent = 'Rate mission';
    b.style.cssText = `position:fixed;right:${EDGE_RIGHT_PX}px;bottom:${EDGE_BOTTOM_PX}px;z-index:${RATE_Z};box-sizing:border-box;`
      + `min-width:${TARGET_MIN_PX}px;min-height:${TARGET_MIN_PX}px;padding:0 18px;cursor:pointer;pointer-events:auto;`
      + 'font-family:var(--font-mono);font-size:13px;letter-spacing:1px;color:var(--hud-label,#fff);'
      + 'background:rgb(var(--hud-ink-rgb,0 0 0) / 0.85);border:1px solid rgb(var(--hud-caution-rgb,255 200 80) / 0.7);border-radius:6px;'
      + 'box-shadow:0 0 12px rgb(var(--hud-caution-rgb,255 200 80) / 0.3);touch-action:manipulation;';
    this._noFocusSteal(b);
    this._stopPointers(b);
    b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.isCardOpen() ? this.closeCard() : this.openCard(); });
    (doc.body || doc.documentElement).appendChild(b);
    this._btn = b;
  }

  /** Remove the button and the card. */
  hide() {
    this.closeCard();
    this._sentMark++;   // a pending "hide after Thanks" timer no longer applies
    const b = this._btn;
    this._btn = null;
    this._shownBy = null;
    if (b && b.parentNode && b.parentNode.removeChild) b.parentNode.removeChild(b);
  }

  /** The card's title line: the mission's name and how it ended. */
  titleText() {
    return `${missionName(this._mission)} ${this._outcome === 'failed' ? 'failed' : 'complete'}`;
  }

  _refreshTitle() {
    if (this._titleEl) this._titleEl.textContent = this.titleText();
  }

  /** Keep the click from moving keyboard focus onto the control (a later Space/Enter in play would press it again). */
  _noFocusSteal(el) {
    const stop = (e) => { if (e && e.preventDefault) e.preventDefault(); };
    el.addEventListener('mousedown', stop);
    el.addEventListener('pointerdown', stop);
  }

  _stopPointers(el) {
    for (const ev of POINTER_EVENTS) el.addEventListener(ev, (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
  }

  _mk(tag, id, css) {
    const el = this._doc.createElement(tag);
    if (id) el.id = id;
    if (css) el.style.cssText = css;
    return el;
  }

  _mkButton(id, text, css, handler) {
    const b = this._mk('button', id, css);
    b.setAttribute('type', 'button');
    b.setAttribute('tabindex', '-1');
    b.textContent = text;
    this._noFocusSteal(b);
    b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); handler(); });
    return b;
  }

  /** Open the card above the button. */
  openCard() {
    if (this._card || !this._btn) return;
    const doc = this._doc;
    const card = this._mk('div', CARD_ID, `position:fixed;right:${EDGE_RIGHT_PX}px;bottom:${EDGE_BOTTOM_PX + TARGET_MIN_PX + 10}px;z-index:${RATE_Z};`
      + 'box-sizing:border-box;width:300px;max-width:calc(100vw - 32px);padding:14px 16px;pointer-events:auto;'
      + 'font-family:var(--font-mono);color:var(--hud-label,#fff);'
      + 'background:rgb(var(--hud-ink-rgb,0 0 0) / 0.92);border:1px solid rgb(var(--hud-caution-rgb,255 200 80) / 0.7);border-radius:8px;'
      + 'box-shadow:0 4px 18px rgb(var(--hud-ink-rgb,0 0 0) / 0.6);');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Rate mission');
    this._stopPointers(card);

    const head = this._mk('div', null, 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;');
    const title = this._mk('div', 'rate-mission-title', 'font-size:13px;letter-spacing:1px;color:var(--hud-caution,#ffcc66);');
    title.textContent = this.titleText();
    const close = this._mkButton('rate-mission-close', '\u00D7', `min-width:${TARGET_MIN_PX}px;min-height:${TARGET_MIN_PX}px;margin:-8px -10px -8px 0;cursor:pointer;`
      + 'font-family:inherit;font-size:22px;line-height:1;color:var(--hud-label,#fff);background:transparent;border:0;', () => this.closeCard());
    close.setAttribute('aria-label', 'Close');
    head.appendChild(title);
    head.appendChild(close);
    card.appendChild(head);
    this._titleEl = title;

    const row = this._mk('div', 'rate-mission-stars', 'display:flex;gap:2px;margin-bottom:8px;');
    this._starEls = [];
    for (let i = 1; i <= 5; i++) {
      const s = this._mkButton(`rate-mission-star-${i}`, '\u2606', `flex:1 1 0;min-width:${TARGET_MIN_PX}px;min-height:${TARGET_MIN_PX}px;cursor:pointer;`
        + 'font-family:inherit;font-size:28px;line-height:1;color:var(--hud-caution,#ffcc66);background:transparent;border:0;touch-action:manipulation;', () => this.setStars(i));
      s.setAttribute('aria-label', `${i} star${i > 1 ? 's' : ''}`);
      s.setAttribute('aria-pressed', 'false');
      row.appendChild(s);
      this._starEls.push(s);
    }
    card.appendChild(row);

    const ta = this._mk('textarea', 'rate-mission-text', 'display:block;box-sizing:border-box;width:100%;min-height:64px;margin-bottom:8px;padding:6px 8px;resize:none;'
      + 'font-family:inherit;font-size:13px;color:var(--hud-label,#fff);background:rgb(var(--hud-ink-rgb,0 0 0) / 0.6);'
      + 'border:1px solid rgb(var(--hud-caution-rgb,255 200 80) / 0.4);border-radius:4px;');
    ta.setAttribute('rows', '3');
    ta.setAttribute('maxlength', String(TEXT_MAX));
    ta.setAttribute('placeholder', 'What felt good or wrong? (optional)');
    ta.addEventListener('input', () => this._refreshSend());
    // Typing stays in the box: the page's own key listeners (bubble phase) never see these keys.
    for (const ev of FIELD_KEY_EVENTS) ta.addEventListener(ev, (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
    card.appendChild(ta);
    this._textEl = ta;

    const foot = this._mk('div', null, 'display:flex;align-items:center;gap:10px;');
    const send = this._mkButton('rate-mission-send', 'Send', `min-width:84px;min-height:${TARGET_MIN_PX}px;padding:0 18px;cursor:pointer;`
      + 'font-family:inherit;font-size:13px;letter-spacing:1px;color:var(--hud-label,#fff);background:rgb(var(--hud-caution-rgb,255 200 80) / 0.25);'
      + 'border:1px solid rgb(var(--hud-caution-rgb,255 200 80) / 0.7);border-radius:6px;', () => { this.send(); });
    const status = this._mk('div', 'rate-mission-status', 'font-size:12px;color:var(--hud-label,#fff);');
    status.setAttribute('aria-live', 'polite');
    foot.appendChild(send);
    foot.appendChild(status);
    card.appendChild(foot);
    this._sendEl = send;
    this._statusEl = status;

    (doc.body || doc.documentElement).appendChild(card);
    this._card = card;
    this._paintStars();
    this._refreshSend();
    if (this._win && this._win.addEventListener) this._win.addEventListener('keydown', this._keyHandler, true);
  }

  /** Close the card (the button stays). */
  closeCard() {
    if (this._win && this._win.removeEventListener) this._win.removeEventListener('keydown', this._keyHandler, true);
    const card = this._card;
    if (!card) return;
    try { if (this._textEl && this._textEl.blur) this._textEl.blur(); } catch (_) { /* no focus in a fake */ }
    this._card = null; this._titleEl = null; this._starEls = null; this._textEl = null; this._sendEl = null; this._statusEl = null;
    if (card.parentNode && card.parentNode.removeChild) card.parentNode.removeChild(card);
  }

  /** @param {number} n 1..5 */
  setStars(n) {
    this._stars = n;
    this._paintStars();
    this._refreshSend();
  }

  _paintStars() {
    if (!this._starEls) return;
    this._starEls.forEach((s, i) => {
      const on = this._stars !== null && i < this._stars;
      s.textContent = on ? '\u2605' : '\u2606';
      s.setAttribute('aria-pressed', on && i === this._stars - 1 ? 'true' : 'false');
    });
  }

  _text() { return this._textEl ? String(this._textEl.value || '').trim().slice(0, TEXT_MAX) : ''; }

  _canSend() { return !this._sending && (this._stars !== null || this._text() !== ''); }

  _refreshSend() {
    const s = this._sendEl;
    if (!s) return;
    if (this._canSend()) { if (s.removeAttribute) s.removeAttribute('disabled'); s.disabled = false; }
    else { s.setAttribute('disabled', ''); s.disabled = true; }
  }

  _say(t) { if (this._statusEl) this._statusEl.textContent = t; }

  _onKey(e) {
    if (!this._card || !e) return;
    if (e.key === 'Escape') {
      if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      this.closeCard();
    }
  }

  /** The file's content. */
  buildBody() {
    const w = this._win;
    let playLog = null;
    try { playLog = this._rec && this._rec.snapshot ? this._rec.snapshot() : null; } catch (_) { playLog = null; }
    return {
      format: 'rating-1',
      stars: this._stars,
      text: this._text(),
      mission: this._mission,
      missionName: missionName(this._mission),
      outcome: this._outcome,
      reason: this._reason,
      at: this._now().toISOString(),
      viewport: { w: (w && w.innerWidth) || null, h: (w && w.innerHeight) || null },
      input: this._getInput(),
      playLog,
    };
  }

  /**
   * Save the rating: POST to the page's server, else download the same JSON. Never throws.
   * @returns {Promise<'saved'|'downloaded'|'failed'>}
   */
  async send() {
    if (!this._canSend()) return 'failed';
    this._sending = true;
    const mark0 = this._sentMark;
    this._refreshSend();
    let result = 'failed';
    try {
      const json = JSON.stringify(this.buildBody());
      let saved = false;
      try {
        if (this._fetch) {
          const r = await this._fetch(RATING_URL, { method: 'POST', headers: { 'X-SC-Rating': '1', 'Content-Type': 'application/json' }, body: json });
          saved = !!r && r.status === 201;
        }
      } catch (_) { saved = false; }
      if (saved) result = 'saved';
      else {
        try { result = this._download(json) ? 'downloaded' : 'failed'; } catch (_) { result = 'failed'; }
      }
    } catch (_) { result = 'failed'; }
    this._sending = false;
    this._say(result === 'saved' ? 'Thanks, saved' : result === 'downloaded' ? 'Saved to Downloads' : "Couldn't save");
    this._refreshSend();
    if (result !== 'failed' && this._sentMark === mark0) {   // not hidden (or re-shown) while the send was in flight
      const mark = ++this._sentMark;
      this._setTimer(() => { if (this._sentMark === mark) this.hide(); }, SENT_HIDE_MS);
    }
    return result;
  }

  /** Download the JSON as `space-cowboy-rating-<YYYYMMDD-HHMM>.json` (the way PlayRecorder.download does; link released late for Safari). */
  _download(json) {
    const win = this._win;
    const doc = this._doc;
    if (!win || !doc || typeof Blob === 'undefined' || !win.URL || typeof win.URL.createObjectURL !== 'function') return false;
    const d = this._now();
    const name = `space-cowboy-rating-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    const url = win.URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    this._setTimer(() => { try { win.URL.revokeObjectURL(url); } catch (_) { /* gone */ } }, 5000);
    this.lastFileName = name;
    return true;
  }
}

/**
 * Build the button and join it to the game (main.js calls this once, right after the play log starts).
 * @param {object} d  the RateMission options, plus `loc` (default the page's location; tests pass a public host)
 * @returns {RateMission|null} null on a public host: nothing is built there
 */
export function wireRateMission(d = {}) {
  if (!isDevHost(d.loc)) return null;
  return new RateMission(d).start();
}
