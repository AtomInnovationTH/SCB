/**
 * @module ui/FocusPauseCard
 * Pause card shown while the window is unfocused or the page was hidden during live play (DECISIONS §47 row 7).
 * main.js keeps the freeze; this owns only the card and the first-input rule: the world resumes on the first click,
 * tap or key (not on focus alone), and that input never reaches the game.
 */

const STATE = Object.freeze({ HIDDEN: 'hidden', BLURRED: 'blurred', ARMED: 'armed' });

const RESUME_EVENTS = ['pointerdown', 'touchstart', 'keydown'];

/** Releases of the resuming input, swallowed once so it can't end on the game. */
const TAIL_EVENTS = ['pointerup', 'mouseup', 'mousedown', 'touchstart', 'touchend', 'touchcancel', 'click', 'keyup'];

/** ms after a resume in which the matching release (and key repeats) is still swallowed. */
const TAIL_MS = 700;

/** Capture, and not passive: window-level touchstart is passive by default and then ignores preventDefault. */
const LISTEN = { capture: true, passive: false };

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);

/**
 * Cards that own input while open (show mode's "Still playing?", DECISIONS §52). Under one, this card never shows and
 * never swallows: on an iPad wake both can be up, and the first tap must reach that card's 20 s countdown buttons.
 */
const YIELD_TO_IDS = ['still-playing-card'];

/** @type {Partial<CSSStyleDeclaration>} full-window layer: z-index 9000 sits above the HUD pause overlay (150). */
const LAYER_STYLE = {
  position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
  display: 'none', alignItems: 'center', justifyContent: 'center',
  background: 'rgb(var(--hud-ink-rgb, 0 10 20) / 0.7)',
  zIndex: '9000', pointerEvents: 'auto', touchAction: 'none', userSelect: 'none',
  fontFamily: 'var(--font-mono)',
};

/** Card sized for 1728x1117 and 1366x1024 (no phone layout). */
const CARD_STYLE = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: '36px 64px', borderRadius: '6px', textAlign: 'center',
  border: '1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.5)',
  background: 'rgb(var(--hud-ink-rgb, 0 10 20) / 0.85)',
  boxShadow: '0 0 40px rgb(var(--hud-normal-rgb, 0 255 136) / 0.18)',
};

const TITLE_STYLE = {
  fontSize: '2rem', letterSpacing: '0.3em', marginBottom: '1.4rem',
  color: 'var(--hud-normal, #00ff88)',
  textShadow: '0 0 20px rgb(var(--hud-normal-rgb, 0 255 136) / 0.5)',
};

const HINT_STYLE = { fontSize: '1rem', letterSpacing: '0.15em', color: 'var(--hud-text, #ffe1a8)' };

export class FocusPauseCard {
  /**
   * @param {object} o
   * @param {() => boolean} o.isRunning world is running (gameplay state)
   * @param {() => boolean} o.isPaused the Esc pause menu is open
   * @param {() => void} o.resume called once per card, when the player's input lifts it
   * @param {() => boolean} [o.touch] touch device: "Tap to resume"
   * @param {Document} [o.document]
   * @param {Window} [o.window]
   * @param {() => number} [o.now] ms clock
   * @param {() => boolean} [o.yieldTo] another input-owning card is open (default: an element in YIELD_TO_IDS exists)
   */
  constructor({ isRunning, isPaused, resume, touch = () => false, document: doc, window: win, now, yieldTo } = {}) {
    this._isRunning = isRunning;
    this._isPaused = isPaused;
    this._resume = resume;
    this._touch = touch;
    this._doc = doc || (typeof document !== 'undefined' ? document : null);
    this._win = win || (typeof window !== 'undefined' ? window : null);
    this._now = now || (() => Date.now());
    this._yieldTo = yieldTo || (() => {
      const d = this._doc;
      return !!d && typeof d.getElementById === 'function' && YIELD_TO_IDS.some((id) => !!d.getElementById(id));
    });
    this._state = STATE.HIDDEN;
    this._el = null;
    this._hint = null;
    this._tail = null;
    // All listeners live from construction (main.js builds the card at import): stopImmediatePropagation can't pre-empt
    // a window-capture listener registered earlier (StartOpening's first-action capture would see the click).
    this._onEvent = (e) => this._event(e);
    if (this._win && typeof this._win.addEventListener === 'function') {
      for (const t of new Set([...RESUME_EVENTS, ...TAIL_EVENTS])) this._win.addEventListener(t, this._onEvent, LISTEN);
    }
  }

  get state() { return this._state; }
  get isShown() { return this._state !== STATE.HIDDEN; }

  /** Window lost focus: shows the card while the world runs, no Esc menu or YIELD_TO card open. @returns {boolean} card is up */
  onBlur() {
    if (this._state !== STATE.HIDDEN) return true;
    if (!this._isRunning() || this._isPaused() || this._yieldTo()) return false;
    this._show();
    return true;
  }

  /** Focus is back: the card stays until the player's input. @returns {boolean} card is up (caller keeps the freeze) */
  onFocus() {
    if (this._state === STATE.BLURRED) this._state = STATE.ARMED;
    return this._state !== STATE.HIDDEN;
  }

  /** Page visible again: the card stays. @returns {boolean} card is up */
  onVisible() { return this._state !== STATE.HIDDEN; }

  _show() {
    this._state = STATE.BLURRED;
    this._tail = null;
    if (this._doc && this._win) {
      const el = this._ensureEl();
      this._hint.textContent = this._touch() ? 'Tap to resume' : 'Click to resume';
      el.style.display = 'flex';
    }
  }

  _ensureEl() {
    if (this._el) return this._el;
    const d = this._doc;
    const el = d.createElement('div');
    el.id = 'focus-pause-card';
    Object.assign(el.style, LAYER_STYLE);
    const card = d.createElement('div');
    Object.assign(card.style, CARD_STYLE);
    const title = d.createElement('div');
    Object.assign(title.style, TITLE_STYLE);
    title.textContent = 'Paused';
    const hint = d.createElement('div');
    Object.assign(hint.style, HINT_STYLE);
    card.appendChild(title);
    card.appendChild(hint);
    el.appendChild(card);
    (d.body || d.documentElement).appendChild(el);
    this._el = el;
    this._hint = hint;
    return el;
  }

  _event(e) {
    if (this._state === STATE.HIDDEN) this._swallowTail(e);
    else if (RESUME_EVENTS.includes(e.type)) this._input(e);
  }

  _input(e) {
    if (e.type === 'keydown' && MODIFIER_KEYS.has(e.key)) return;   // Cmd-Tab back: a bare modifier can't steer
    if (this._yieldTo()) {   // that card opened over this one: lift and resume, but the input (and its tail) is its own
      this._hide();
      this._tail = null;
      this._resume();
      return;
    }
    this._swallow(e);
    this._hide();
    this._startTail(e);
    this._resume();
  }

  _hide() {
    this._state = STATE.HIDDEN;
    if (this._el) this._el.style.display = 'none';
  }

  _startTail(e) {
    this._tail = { until: this._now() + TAIL_MS, key: e.type === 'keydown' ? e.code : null, seen: new Set([e.type]) };
  }

  _swallowTail(e) {
    const tail = this._tail;
    if (!tail || !TAIL_EVENTS.includes(e.type) && e.type !== 'keydown') return;
    if (this._now() > tail.until) { this._tail = null; return; }
    if (e.type === 'keydown') {
      if (e.repeat && e.code === tail.key) this._swallow(e);
      return;
    }
    if (tail.key !== null && e.type !== 'keyup') return;   // a key resume only swallows that key's release
    if (e.type === 'keyup' && e.code !== tail.key) return;
    if (tail.seen.has(e.type)) return;
    tail.seen.add(e.type);
    this._swallow(e);
  }

  _swallow(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    else if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
}
