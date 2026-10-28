/**
 * Bottom-screen single-line onboarding hint presenter, driven entirely by EventBus messages:
 *   • Events.HINT_POSTED         — show a new hint on the LEFT (latest, brightest)
 *   • Events.HINT_SATISFIED      — fade and remove a hint by `id`
 *   • Events.SKILL_STATE_CHANGED — when the related skillId reaches `practiced`, the matching hint fades on its own
 *
 * Layout (tuning: Constants.ONBOARDING.TICKER): the latest hint lives on the LEFT (bright border, key glyph in a
 * chip); older hints push RIGHT, each dimmer and slightly smaller; a hint beyond MAX_VISIBLE displaces the
 * rightmost. When one clears, the rest shift left. Inline CSS only (self-contained, like TeachingOverlay.js).
 *
 * Glass: the payload stays KEY-based; at render time the chip and the body consult GestureHints — on a touch device
 * a `keys: ['KeyN']` hint paints "HOLD → NET". Off glass GestureHints is inert, so desktop is byte-identical.
 * The "+ Library" unlock chip (CodexSystem, `codexId`) is the one tappable row: its click reaches `setChipTap(fn)`
 * (the hub wires it to the SPECS pane).
 *
 * Step chips: a row whose payload has `step: true` is THE one thing to do now. Posting a step row takes any other
 * visible step row off screen at once; the replaced row WAITS (newest first) and comes back when the newer step row
 * is satisfied, expires or is practiced away. A waiting id counts in `getItemIds()` and a post for it is a no-op.
 * On glass, with a `setStepTap` sink wired, a step row that carries `press` + `button` renders as a 44 px button
 * (label only) whose tap calls the sink with the key code.
 *
 * @module ui/hud/HintTicker
 */

import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { Constants } from '../../core/Constants.js';
import { decorateGlossary } from '../../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from '../glossaryDom.js';
import { GestureHints } from './GestureHints.js';
import { isShortScreen } from './PhoneFold.js';

// Checked on each use so Node tests can install a document shim AFTER first evaluation.
function _hasDOM() {
  return typeof document !== 'undefined';
}

// Fallback when Constants.ONBOARDING.TICKER is absent (isolated tests).
const DEFAULTS = {
  BOTTOM_PX: 88,
  ROW_HEIGHT_PX: 36,
  MAX_WIDTH_PX: 1100,
  MAX_VISIBLE: 4,
  FADE_OUT_MS: 300,
  SHIFT_MS: 250,
  FONT_LATEST_PX: 16,
  FONT_OLDER_PX: 13,
  SCALE_OLDER: 0.95,
  KEY_CHIP_BG_GAMEPLAY: 'var(--hud-ink, #0a2a3a)',
  KEY_CHIP_BG_MODIFIER: 'var(--hud-ink, #3a2a0a)',
  KEY_CHIP_BG_MOUSE: 'var(--hud-ink, #2a0a3a)',
  ACCENT_BORDER: 'var(--hud-info, #00ccff)',
};

function _tuning() {
  const c = (Constants && Constants.ONBOARDING && Constants.ONBOARDING.TICKER) || {};
  return Object.assign({}, DEFAULTS, c);
}

/** Gap + Targets pane width (px) the chip clears on a short phone (Targets is 300 wide, 8 gap). */
export const CHIP_TARGETS_CLEAR_PX = 308;

/**
 * Where the step chip sits: centred, except on a short screen no wider than 768 px while the Targets pane is shown;
 * then its right edge is the pane's left edge - 8. Pure; no layout read.
 * @param {{W:number, H:number, targetsShown:boolean}} p
 * @returns {'center'|'left-of-targets'}
 */
export function chipPlacement({ W, H, targetsShown }) {
  return (targetsShown && isShortScreen(H) && Number.isFinite(W) && W <= 768) ? 'left-of-targets' : 'center';
}

export class HintTicker {
  /**
   * @param {HTMLElement} [containerEl] — mount point (defaults to document.body)
   * @param {object}      [opts.eventBus] — overridable EventBus (tests pass a mock)
   */
  constructor(containerEl, opts = {}) {
    this._container = containerEl || (_hasDOM() ? document.body : null);
    this._eventBus = opts.eventBus || eventBus;
    /** @type {Array<{ id: string, el: HTMLElement, skillId?: string, timer?: number, payload: object }>} */
    this._items = [];
    this._unsubs = [];
    this._disposed = false;

    this._strip = null;

    /** @type {((info: { id: string }) => void)|null} unlock-chip tap sink (`setChipTap`); null = the row is inert. */
    this._onChipTap = null;

    /** @type {((code: string) => void)|null} step-button tap sink (`setStepTap`); null = step rows render as plain chips. */
    this._onStepTap = null;

    /**
     * Step rows pushed off screen by a newer step row, newest first. Same shape as `_items`; the timer keeps running.
     * @type {Array<{ id: string, el: HTMLElement, skillId?: string, timer?: number, payload: object }>}
     */
    this._waiting = [];

    /** Step-button elements fading out: the strip stays tall until they are gone. */
    this._fadingButtons = new Set();

    /** @type {(() => boolean)|null} is the Targets pane on screen? (HUD wires it; null = never) */
    this._targetsShown = null;
    /** @type {'center'|'left-of-targets'} the placement last written (write-on-change) */
    this._placement = 'center';

    this._build();
    this._wireListeners();
  }

  /** The Targets-shown getter (HUD passes one over the TargetPanel's attributes). */
  setTargetsShown(fn) {
    this._targetsShown = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Put the chip where chipPlacement() says; writes only on change. Called once a frame (main.js). No layout read.
   * @param {{innerWidth?:number, innerHeight?:number}|null} [win]  defaults to window
   */
  syncPlacement(win) {
    if (!this._strip) return;
    const w = win || (typeof window !== 'undefined' ? window : null);
    let shown = false;
    try { shown = !!(this._targetsShown && this._targetsShown()); } catch (_e) { shown = false; }
    const next = w ? chipPlacement({ W: w.innerWidth, H: w.innerHeight, targetsShown: shown }) : 'center';
    if (next === this._placement) return;
    this._placement = next;
    const st = this._strip.style;
    if (next === 'left-of-targets') {
      st.left = 'auto';
      st.right = `${CHIP_TARGETS_CLEAR_PX}px`;
      st.transform = 'none';
    } else {
      st.left = '50%';
      st.right = '';
      st.transform = 'translateX(-50%)';
    }
  }

  /** Programmatic post (tests); same payload contract as HINT_POSTED. */
  post(payload) {
    this._onHintPosted(payload);
  }

  satisfy(id) {
    this._onHintSatisfied({ id });
  }

  /**
   * Wire the unlock-chip tap. A HINT_POSTED payload with a string `codexId` renders as a tappable row; its click
   * calls `fn({ id: codexId })`. The hub points this at the SPECS pane (`libraryPane.openEntry(id)`, else the
   * CODEX_OPEN_ENTRY deep link). Pass a non-function to unwire.
   */
  setChipTap(fn) {
    this._onChipTap = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Wire the step-button tap (touch): a glass step row with `press` + `button` renders as a button; its click calls
   * `fn(press)` (main.js: `dispatchKeyPress`). Pass a non-function to unwire.
   */
  setStepTap(fn) {
    this._onStepTap = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Is a step row other than `exceptId` alive (on screen, or waiting off screen)? TouchActionChip asks before it
   * posts: one step chip, one action.
   * @param {string} [exceptId]
   * @param {string} [exceptPress]  also ignore step buttons that press this key (a daughter's tool button replaces a
   *        KeyN beat chip: same key, and hers is the true word)
   */
  hasStepChip(exceptId, exceptPress) {
    // Only a step row WITH a button is a tappable chip; a text-only step hint does not hold the slot.
    const isStep = (it) => it && it.id !== exceptId && it.payload && it.payload.step === true && !!it.payload.button
      && !(exceptPress && it.payload.press === exceptPress);
    return this._items.some(isStep) || this._waiting.some(isStep);
  }

  /** Is the row with this id on screen right now (a waiting step row does not count)? */
  isOnScreen(id) {
    return this._items.some((it) => it && it.id === id);
  }

  /** A step BUTTON (glass, with a step sink) is on screen: the row a text-only `yieldToButton` hint must not cover. */
  _stepButtonUp() {
    if (typeof this._onStepTap !== 'function' || !GestureHints.isGlass()) return false;
    return this._items.some((it) => it && it.payload && it.payload.step === true && typeof it.payload.press === 'string' && !!it.payload.button);
  }

  /** Is a step button with this label showing now? (the glass pilot strip names only buttons that are up) */
  hasStepButton(label) {
    return this._items.some((it) => it && it.payload && it.payload.step === true && it.payload.button === label);
  }

  getVisibleCount() {
    return this._items.length;
  }

  /** The DOM strip (tests). */
  getStripElement() {
    return this._strip;
  }

  /** Item ids left→right, then the ids of step rows waiting off screen (a waiting id still counts as "up"). */
  getItemIds() {
    return this._items.map(it => it.id).concat(this._waiting.map(it => it.id));
  }

  /** Clear every visible hint. Wired to GAME_WIN so no chip sits over the victory screen. */
  clearAll() {
    // Waiting rows go first, so the fade of a visible step row can never bring one back.
    this._dropAllWaiting();
    // Snapshot ids: _fadeAndRemove mutates this._items in place.
    for (const id of this._items.map(it => it.id)) {
      this._fadeAndRemove(id);
    }
  }

  /** Tear down DOM + EventBus subscriptions. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const it of this._items) {
      if (it.timer != null && typeof clearTimeout === 'function') clearTimeout(it.timer);
    }
    this._items.length = 0;
    this._dropAllWaiting();
    for (const u of this._unsubs) {
      if (typeof u === 'function') u();
    }
    this._unsubs.length = 0;
    if (this._strip && this._strip.parentNode) {
      this._strip.parentNode.removeChild(this._strip);
    }
    this._strip = null;
  }

  _build() {
    if (!_hasDOM() || !this._container) return;
    const T = _tuning();
    const strip = document.createElement('div');
    // FloorMask sets `data-floor-gone` on this strip (display:none !important) on the hull floor and clears it on the
    // next; the ticker never knows (items and timers keep running). The density 'score' rung's
    // `data-density-hidden` is the other, independent bit on this node.
    strip.id = 'hud-hint-ticker';
    strip.style.cssText = [
      'position:fixed',
      `bottom:${T.BOTTOM_PX}px`,
      'left:50%',
      'transform:translateX(-50%)',
      `height:${T.ROW_HEIGHT_PX}px`,
      `max-width:${T.MAX_WIDTH_PX}px`,
      'min-width:200px',
      'display:flex',
      'flex-direction:row',
      'align-items:center',
      'gap:8px',
      'pointer-events:none',
      'z-index:8000',
      "font-family: var(--font-mono)",
      'white-space:nowrap',
      'overflow:hidden',
    ].join(';') + ';';
    this._strip = strip;
    this._container.appendChild(strip);

    // The strip is pointer-events:none; decorated glossary terms re-enable pointer events on themselves (body span
    // below) and this delegated handler catches the bubbled click.
    ensureGlossaryCss();
    delegateGlossaryClicks(strip);
  }

  _wireListeners() {
    const eb = this._eventBus;
    if (!eb) return;
    const on = (evt, h) => {
      const u = eb.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };
    on(Events.HINT_POSTED,    (d) => this._onHintPosted(d));
    on(Events.HINT_SATISFIED, (d) => this._onHintSatisfied(d));
    if (Events.SKILL_STATE_CHANGED) {
      on(Events.SKILL_STATE_CHANGED, (d) => this._onSkillStateChanged(d));
    }
    if (Events.GAME_WIN) {
      on(Events.GAME_WIN, () => this.clearAll());
    }
  }

  _onHintPosted(payload) {
    if (this._disposed) return;
    if (!payload || !payload.id) return;
    // Idempotent: re-posting an id that is alive (on screen or waiting) is a no-op.
    if (this._items.some(it => it.id === payload.id)) return;
    if (this._waiting.some(it => it.id === payload.id)) return;
    const T = _tuning();
    const dur = (payload.duration != null) ? payload.duration : (Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000);

    const el = this._buildItemElement(payload, /* highlight= */ true);
    const item = {
      id: payload.id,
      el,
      skillId: payload.skillId || null,
      payload,
      timer: null,
    };

    // One step at a time: a new step row pushes every visible step row off screen; they come back when this one
    // leaves. Except a text-only hint with `yieldToButton` (the idle coach's "Grip it") while a step BUTTON is up on
    // glass: it waits behind the button, which is the same instruction in the true word.
    if (payload.step === true && payload.yieldToButton === true && !payload.button && this._stepButtonUp()) {
      this._waiting.push(item);
      if (typeof setTimeout === 'function' && Number.isFinite(dur) && dur > 0) {
        item.timer = setTimeout(() => this._fadeAndRemove(item.id), dur);   // it expires while it waits (_fadeAndRemove drops it)
      }
      return;
    }
    if (payload.step === true) this._shelveVisibleSteps();

    this._items.unshift(item);
    if (this._strip) {
      // A button of the SAME id still fading out (re-posted within FADE_OUT_MS) is replaced IN PLACE, so the new
      // button sits where the thumb is going; a second copy beside it would shift the centred strip.
      const old = el ? this._fadingButtonFor(payload.id) : null;
      if (old && old.parentNode === this._strip) {
        this._fadingButtons.delete(old);
        if (typeof this._strip.replaceChild === 'function') this._strip.replaceChild(el, old);
        else { this._strip.insertBefore(el, old); this._strip.removeChild(old); }
      } else {
        this._strip.insertBefore(el, this._strip.firstChild);
      }
    }

    if (payload.priority === 'high' && _hasDOM()) {
      el.style.boxShadow = '0 0 12px rgb(var(--hud-info-rgb, 0 204 255) / 0.55)';
      setTimeout(() => { if (el) el.style.boxShadow = ''; }, 500);
    }

    // Displace from the RIGHT (never a step row).
    this._enforceCap();

    this._restyleAll();

    if (typeof setTimeout === 'function' && Number.isFinite(dur) && dur > 0) {
      item.timer = setTimeout(() => this._fadeAndRemove(item.id), dur);
    }
  }

  /** The step button with this hint id that is fading out (not yet removed), or null. */
  _fadingButtonFor(id) {
    for (const b of this._fadingButtons) if (b && b.dataset && b.dataset.hintId === id) return b;
    return null;
  }

  /**
   * Take a fading row out of the strip's layout (position:absolute at its current spot). The strip is centred, so a
   * row left in the flow for FADE_OUT_MS keeps the next button off centre and then snaps back: a tap hit the dead copy.
   */
  _floatOut(el) {
    if (!el || !el.style || !el.parentNode) return;
    const left = el.offsetLeft, top = el.offsetTop;
    if (Number.isFinite(left) && Number.isFinite(top)) {
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
    el.style.position = 'absolute';
    el.style.margin = '0';
  }

  _onHintSatisfied(payload) {
    if (!payload || !payload.id) return;
    this._dropWaiting(payload.id);
    this._fadeAndRemove(payload.id);
  }

  _onSkillStateChanged(payload) {
    if (!payload || !payload.skillId || !payload.to) return;
    const reached = (payload.to === 'practiced' || payload.to === 'mastered');
    if (!reached) return;
    for (const it of this._waiting.filter(w => w.skillId === payload.skillId)) {
      this._dropWaiting(it.id);
    }
    const matches = this._items.filter(it => it.skillId === payload.skillId);
    for (const it of matches) this._fadeAndRemove(it.id);
  }

  /** Take every visible step row off screen (no fade) and put it on the wait list, newest first. */
  _shelveVisibleSteps() {
    const steps = this._items.filter(it => it.payload && it.payload.step === true);
    if (steps.length === 0) return;
    // _items is newest-first, so iterating in reverse and unshifting keeps newest first.
    for (const it of steps.slice().reverse()) {
      this._items.splice(this._items.indexOf(it), 1);
      if (it.el && it.el.parentNode) it.el.parentNode.removeChild(it.el);
      this._waiting.unshift(it);
    }
  }

  _dropWaiting(id) {
    const i = this._waiting.findIndex(it => it.id === id);
    if (i < 0) return false;
    const [it] = this._waiting.splice(i, 1);
    if (it.timer != null && typeof clearTimeout === 'function') clearTimeout(it.timer);
    it.timer = null;
    return true;
  }

  _dropAllWaiting() {
    for (const it of this._waiting) {
      if (it.timer != null && typeof clearTimeout === 'function') clearTimeout(it.timer);
      it.timer = null;
    }
    this._waiting.length = 0;
  }

  /** When no step row is visible, bring back the newest waiting one. */
  _restoreWaitingStep() {
    if (this._waiting.length === 0) return;
    if (this._items.some(it => it.payload && it.payload.step === true)) return;
    const item = this._waiting.shift();
    this._items.unshift(item);
    if (this._strip && item.el) this._strip.insertBefore(item.el, this._strip.firstChild);
    if (item.el) {
      item.el.style.opacity = '1';
      item.el.style.pointerEvents = item.el.dataset.stepButton === '1' ? 'auto'
        : (typeof item.payload.codexId === 'string' && this._onChipTap ? 'auto' : 'none');
    }
    this._enforceCap();
    this._restyleAll();
  }

  /** Keep at most MAX_VISIBLE rows. The oldest NON-step row goes first: never push out the step the player is meant to do. */
  _enforceCap() {
    const T = _tuning();
    while (this._items.length > T.MAX_VISIBLE) {
      let i = this._items.length - 1;
      while (i >= 0 && this._items[i].payload && this._items[i].payload.step === true) i--;
      if (i < 0) break; // only step rows left (at most one is ever visible)
      const [victim] = this._items.splice(i, 1);
      if (victim) this._removeItemElement(victim, /* fade= */ false);
    }
  }

  /** The strip is 36 px tall; a 44 px step button needs it taller. */
  _syncStripHeight() {
    if (!this._strip) return;
    const T = _tuning();
    const hasBtn = this._fadingButtons.size > 0
      || this._items.some(it => it.el && it.el.dataset && it.el.dataset.stepButton === '1');
    this._strip.style.height = hasBtn ? `${Math.max(T.ROW_HEIGHT_PX, 48)}px` : `${T.ROW_HEIGHT_PX}px`;
  }

  _fadeAndRemove(id) {
    const idx = this._items.findIndex(it => it.id === id);
    if (idx < 0) {
      // A timer that fires while the row waits: it expires there.
      this._dropWaiting(id);
      return;
    }
    const item = this._items[idx];
    if (!item) return;
    if (item.timer != null && typeof clearTimeout === 'function') {
      clearTimeout(item.timer);
      item.timer = null;
    }
    const T = _tuning();
    if (_hasDOM() && item.el) {
      item.el.style.transition = `opacity ${T.FADE_OUT_MS}ms ease-out, transform ${T.SHIFT_MS}ms ease-out`;
      item.el.style.opacity = '0';
      // A second tap during the fade must not toggle anything back.
      item.el.style.pointerEvents = 'none';
      this._floatOut(item.el);   // nor sit in the strip's layout
    }
    this._items.splice(idx, 1);
    const el = item.el;
    const isBtn = !!(el && el.dataset && el.dataset.stepButton === '1');
    if (isBtn) this._fadingButtons.add(el);
    setTimeout(() => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      if (isBtn) {
        this._fadingButtons.delete(el);
        if (!this._disposed) this._syncStripHeight();
      }
    }, T.FADE_OUT_MS);
    if (item.payload && item.payload.step === true) this._restoreWaitingStep();
    this._restyleAll();
  }

  /** Remove (no fade when displaced by the cap). */
  _removeItemElement(item, fade = true) {
    if (!_hasDOM()) return;
    if (item.timer != null && typeof clearTimeout === 'function') clearTimeout(item.timer);
    const T = _tuning();
    if (fade && item.el) {
      item.el.style.transition = `opacity ${T.FADE_OUT_MS}ms ease-out`;
      item.el.style.opacity = '0';
      setTimeout(() => {
        if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
      }, T.FADE_OUT_MS);
    } else if (item.el && item.el.parentNode) {
      item.el.parentNode.removeChild(item.el);
    }
  }

  _restyleAll() {
    if (!_hasDOM()) return;
    const T = _tuning();
    this._items.forEach((it, i) => {
      const isLatest = (i === 0);
      const dimSteps = i; // 0 = brightest, 1..3 = older
      const opacity = Math.max(0.35, 1.0 - dimSteps * 0.18);
      // A step button keeps its full 44 px at any position.
      const isBtn = it.el.dataset && it.el.dataset.stepButton === '1';
      const scale = (isLatest || isBtn) ? 1.0 : T.SCALE_OLDER;
      const fontPx = isLatest ? T.FONT_LATEST_PX : T.FONT_OLDER_PX;
      const borderColor = isLatest ? T.ACCENT_BORDER : 'rgb(var(--hud-info-rgb, 0 204 255) / 0.35)';
      const el = it.el;
      el.style.transition = `opacity ${T.SHIFT_MS}ms ease-out, transform ${T.SHIFT_MS}ms ease-out`;
      el.style.opacity = String(opacity);
      el.style.transform = `scale(${scale})`;
      el.style.fontSize = `${fontPx}px`;
      el.style.borderColor = borderColor;
      el.dataset.position = String(i);
    });
    this._syncStripHeight();
  }

  /** @param {boolean} highlight — this slot is the latest (left-most) */
  _buildItemElement(payload, highlight) {
    const T = _tuning();
    const row = _hasDOM() ? document.createElement('div') : null;
    if (!row) return row;
    // The unlock chip (`codexId`) is the ONE tappable row; every other row stays click-through. Tappable ONLY while a
    // sink is wired at build time: the hub wires it inside the LADDER.ENABLED gate, so a ?ladder=0 boot (no SPECS
    // pane, no sink) never gets a dead pointer target.
    const tappable = (typeof payload.codexId === 'string') && (typeof this._onChipTap === 'function');
    // A step row on glass with a step sink and a button label IS the button. No sink / off glass: the plain chip.
    if (payload.step === true && typeof payload.press === 'string' && payload.button
        && typeof this._onStepTap === 'function' && GestureHints.isGlass()) {
      return this._buildStepButton(row, payload, highlight);
    }
    row.className = 'hint-ticker-item';
    row.dataset.hintId = payload.id;
    row.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'padding:4px 10px',
      'border:1px solid ' + (highlight ? T.ACCENT_BORDER : 'rgb(var(--hud-info-rgb, 0 204 255) / 0.35)'),
      'border-radius:4px',
      'background:rgb(var(--hud-ink-rgb, 0 10 20) / 0.78)',
      'color:var(--hud-text, #ccddee)',
      `font-size:${highlight ? T.FONT_LATEST_PX : T.FONT_OLDER_PX}px`,
      'letter-spacing:0.02em',
      tappable ? 'pointer-events:auto' : 'pointer-events:none',
      'box-shadow:0 0 4px rgb(var(--hud-info-rgb, 0 204 255) / 0.18)',
      'opacity:1',
      'transform:scale(1)',
      'will-change:opacity,transform',
    ].concat(tappable ? ['cursor:pointer'] : []).join(';') + ';';

    // Glyph chip (left). On glass a keyed hint's chip is the GESTURE ("HOLD → NET", see _resolveGlyph): several
    // words, so it must be free to grow and never shrink or wrap in the flex row. Off glass it is one key glyph.
    const chipText = this._resolveGlyph(payload);
    if (chipText) {
      const chip = document.createElement('span');
      chip.textContent = chipText;
      const chipBg = this._chipBg(payload, T);
      chip.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'min-width:24px',
        'height:22px',
        'padding:0 6px',
        'border-radius:3px',
        `background:${chipBg}`,
        'color:var(--hud-label, #ffffff)',
        'font-weight:bold',
        "font-family: var(--font-mono)",
        'font-size:12px',
        'letter-spacing:0.04em',
      ].concat(GestureHints.isGlass() ? ['flex-shrink:0', 'white-space:nowrap'] : []).join(';') + ';';
      row.appendChild(chip);
    }

    // Body text (right): `pointer-events:auto` re-enables hit-testing inside the click-through strip so glossary
    // terms are clickable; decorateGlossary escapes the source before wrapping.
    const body = document.createElement('span');
    body.innerHTML = decorateGlossary(GestureHints.speak(payload.text || ''), { once: true });
    body.style.cssText = 'color:var(--hud-text, #ccddee);pointer-events:auto;';
    row.appendChild(body);

    if (tappable) {
      row.addEventListener('click', (e) => {
        // A glossary term inside the body is its own deep link: one intent per tap, yield to it.
        const t = e && e.target;
        if (t && typeof t.closest === 'function' && t.closest('.glossary-term[data-entry]')) return;
        if (typeof this._onChipTap === 'function') this._onChipTap({ id: payload.codexId });
      });
    }

    return row;
  }

  /** Render a step row as a touch button: label only, 44 px minimum, tap = the key. */
  _buildStepButton(row, payload, highlight) {
    const T = _tuning();
    row.className = 'hint-ticker-item';
    row.dataset.hintId = payload.id;
    row.dataset.stepButton = '1';
    if (typeof row.setAttribute === 'function') {
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', String(payload.button));
    }
    row.textContent = String(payload.button);
    row.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'box-sizing:border-box',
      'min-height:44px',
      'min-width:44px',
      'padding:0 18px',
      'border:1px solid ' + (highlight ? T.ACCENT_BORDER : 'rgb(var(--hud-info-rgb, 0 204 255) / 0.35)'),
      'border-radius:6px',
      'background:rgb(var(--hud-ink-rgb, 0 10 20) / 0.86)',
      'color:var(--hud-label, #ffffff)',
      `font-size:${T.FONT_LATEST_PX}px`,
      'font-weight:bold',
      'letter-spacing:0.06em',
      'pointer-events:auto',
      'cursor:pointer',
      'box-shadow:0 0 8px rgb(var(--hud-info-rgb, 0 204 255) / 0.35)',
      'opacity:1',
      'transform:scale(1)',
      'will-change:opacity,transform',
      'flex-shrink:0',
    ].join(';') + ';';
    row.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof this._onStepTap === 'function') this._onStepTap(payload.press);
    });
    return row;
  }

  /**
   * The chip text for a hint row. On glass a KEYED hint paints its gesture (GestureHints.chipFor) even when the
   * payload also carries a `glyph`; glyph-only hints (`keys: []`: the '!' refusal, the '…' hold, the codex 'I' ack)
   * keep their glyph.
   */
  _resolveGlyph(payload) {
    const g = GestureHints.chipFor(payload.keys);
    if (g) return g;
    // On glass a raw key glyph ("S", "?", "1-4") is never shown: the skill's touch word, else no badge.
    const word = GestureHints.badgeFor(payload);
    if (word !== undefined) return word;
    if (payload.glyph) return payload.glyph;
    if (Array.isArray(payload.keys) && payload.keys.length > 0) {
      if (GestureHints.isGlass()) return null;   // a key with no gesture row shows no badge on glass
      const k = String(payload.keys[0]);
      if (k.startsWith('Key')) return k.slice(3);
      if (k.startsWith('Arrow')) return '←';
      if (k === 'Space') return '␣';
      if (k === 'Tab') return '⇥';
      if (k === 'Equal') return '+';
      if (k === 'Minus') return '−';
      return k.slice(0, 3);
    }
    return null;
  }

  _chipBg(payload, T) {
    const glyph = (payload.glyph || '').toLowerCase();
    // U+1F5B1 (mouse pictograph) is still carried by some payloads; built from its code point so this file has none.
    if (glyph.includes(String.fromCodePoint(0x1F5B1)) || glyph.includes('mouse')) return T.KEY_CHIP_BG_MOUSE;
    if (glyph.includes('shift') || glyph.includes('ctrl') || glyph.includes('alt') || glyph.includes('meta')) {
      return T.KEY_CHIP_BG_MODIFIER;
    }
    return T.KEY_CHIP_BG_GAMEPLAY;
  }
}

export default HintTicker;
