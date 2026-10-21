/**
 * HintTicker.js — Bottom-screen single-line onboarding hint presenter
 *
 * Delegation 2 onboarding (2026-05-31). A stateless presenter driven entirely
 * by EventBus messages:
 *   • Events.HINT_POSTED     — show a new hint on the LEFT (latest, brightest)
 *   • Events.HINT_SATISFIED  — fade and remove a hint by `id`
 *   • Events.SKILL_STATE_CHANGED — when the related skillId reaches `practiced`
 *                                  state, the matching hint fades on its own.
 *
 * Layout: fixed strip ~36 px tall, anchored 88 px above viewport bottom
 * (above the existing notification slot at the very bottom).  The latest hint
 * lives on the LEFT — bright cyan border, 16 px font, key glyph in a chip.
 * Older hints push RIGHT, each step dimmer + slightly smaller (~13 px, 95 %
 * scale).  At most 4 hints are visible; a 5th displaces the rightmost.  When
 * a hint clears (satisfied / duration / skill practiced), the remaining items
 * shift left over 250 ms.
 *
 * Inline CSS only — matches the project pattern of self-contained UI modules
 * (TeachingOverlay.js, CommsPanel.js).  No new CSS files.
 *
 * Glass (Session J item 5): the payload stays KEY-based; at render time the
 * chip and the body consult GestureHints — on a touch device a `keys:
 * ['KeyN']` hint paints "HOLD → NET" and "Press N" prose speaks the gesture.
 * Off glass GestureHints is inert (null chip, same-instance text), so desktop
 * is byte-identical. The "+ Library" unlock chip (CodexSystem, `codexId`) is
 * the one tappable row: its click reaches `setChipTap(fn)` — the hub wires it
 * to the SPECS pane so an unlock is a doorway, not a notification.
 *
 * Step chips (u2-one-voice, 2026-10-18): a row whose payload has `step: true`
 * is THE one thing to do now. Posting a step row takes any other visible step
 * row off screen at once; the replaced row WAITS (newest first) and comes back
 * when the newer step row is satisfied, expires or is practiced away. A waiting
 * id counts in `getItemIds()` and a post for it is a no-op. On glass, with a
 * `setStepTap` sink wired, a step row that carries `press` + `button` renders
 * as a 44 px button (label only) whose tap calls the sink with the key code.
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

// Lazy DOM probe — checked on each use so Node-side tests can install a
// minimal document shim AFTER the module has been first evaluated.
function _hasDOM() {
  return typeof document !== 'undefined';
}

// Default tuning falls back when Constants.ONBOARDING.TICKER is absent
// (defensive — keeps the module usable in isolated tests).
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

/** u7 D5b: gap + Targets pane width (px) the chip clears on a short phone (Targets is 300 wide, 8 gap). */
export const CHIP_TARGETS_CLEAR_PX = 308;

/**
 * u7 D5b: where the step chip sits. Centred (today) except on a short screen no wider than the
 * 768 px phone rule while the Targets pane is shown: then its right edge is the pane's left edge - 8, so the
 * two never overlap. Pure; no layout read.
 * @param {{W:number, H:number, targetsShown:boolean}} p
 * @returns {'center'|'left-of-targets'}
 */
export function chipPlacement({ W, H, targetsShown }) {
  return (targetsShown && isShortScreen(H) && Number.isFinite(W) && W <= 768) ? 'left-of-targets' : 'center';
}

// ───────────────────────────────────────────────────────────────────────────
// HINT TICKER
// ───────────────────────────────────────────────────────────────────────────

export class HintTicker {
  /**
   * @param {HTMLElement} [containerEl] — DOM mount point (defaults to document.body)
   * @param {object}      [opts]
   * @param {object}      [opts.eventBus] — overridable EventBus (tests pass a mock)
   */
  constructor(containerEl, opts = {}) {
    this._container = containerEl || (_hasDOM() ? document.body : null);
    this._eventBus = opts.eventBus || eventBus;
    /** @type {Array<{ id: string, el: HTMLElement, skillId?: string, timer?: number, payload: object }>} */
    this._items = [];
    this._unsubs = [];
    this._disposed = false;

    /** @type {HTMLElement|null} Container strip element */
    this._strip = null;

    /**
     * @type {((info: { id: string }) => void)|null} The unlock-chip tap sink
     * (`setChipTap`). Called with `{ id: payload.codexId }` when a row that
     * carries a string `codexId` is clicked. Null = the row is inert.
     */
    this._onChipTap = null;

    /**
     * @type {((code: string) => void)|null} The step-button tap sink
     * (`setStepTap`). Called with the payload's `press` key code when a step
     * button is tapped. Null = step rows render as plain chips.
     */
    this._onStepTap = null;

    /**
     * Step rows pushed off screen by a newer step row, newest first. Same item
     * shape as `_items`; the timer keeps running while a row waits.
     * @type {Array<{ id: string, el: HTMLElement, skillId?: string, timer?: number, payload: object }>}
     */
    this._waiting = [];

    /** Step-button elements fading out: the strip stays tall until they are gone. */
    this._fadingButtons = new Set();

    /** @type {(() => boolean)|null} u7 D5b: is the Targets pane on screen? (HUD wires it; null = never) */
    this._targetsShown = null;
    /** @type {'center'|'left-of-targets'} the placement last written (write-on-change) */
    this._placement = 'center';

    this._build();
    this._wireListeners();
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /** u7 D5b: the Targets-shown getter (HUD passes one over the TargetPanel's attributes). */
  setTargetsShown(fn) {
    this._targetsShown = (typeof fn === 'function') ? fn : null;
  }

  /**
   * u7 D5b: put the chip where chipPlacement() says; writes only on change. Called once a frame
   * (main.js) with the window numbers the code already has. No layout read.
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

  /** Programmatic post (used by tests).  Same payload contract as HINT_POSTED. */
  post(payload) {
    this._onHintPosted(payload);
  }

  /** Programmatic satisfy (used by tests). */
  satisfy(id) {
    this._onHintSatisfied({ id });
  }

  /**
   * Wire the unlock-chip tap. A HINT_POSTED payload with a string `codexId`
   * (CodexSystem's "+ Library" acknowledgment) renders as a tappable row; its
   * click calls `fn({ id: codexId })`. The hub points this at the SPECS pane
   * (`libraryPane.openEntry(id)`, else the CODEX_OPEN_ENTRY deep link) so the
   * unlock chip opens the new entry. Pass a non-function to unwire.
   * @param {((info: { id: string }) => void)|null} fn
   */
  setChipTap(fn) {
    this._onChipTap = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Wire the step-button tap (touch). A glass step row with `press` + `button`
   * renders as a button; its click calls `fn(press)`. main.js points this at
   * `dispatchKeyPress`. Pass a non-function to unwire.
   * @param {((code: string) => void)|null} fn
   */
  setStepTap(fn) {
    this._onStepTap = (typeof fn === 'function') ? fn : null;
  }

  /**
   * u11 D2: is a step row other than `exceptId` alive (on screen, or waiting off screen for the newer one to leave)?
   * TouchActionChip asks before it posts: one step chip, one action.
   * @param {string} [exceptId]
   * @returns {boolean}
   */
  hasStepChip(exceptId) {
    // u11 R11: only a step row WITH a button is a tappable chip; a text-only step hint ("Turn to line her up")
    // does not hold the slot against a line chip.
    const isStep = (it) => it && it.id !== exceptId && it.payload && it.payload.step === true && !!it.payload.button;
    return this._items.some(isStep) || this._waiting.some(isStep);
  }

  /** Number of currently-visible hint rows. */
  getVisibleCount() {
    return this._items.length;
  }

  /** Returns the DOM strip (for tests). */
  getStripElement() {
    return this._strip;
  }

  /**
   * Returns the array of item ids in left→right order (for tests), then the
   * ids of step rows waiting off screen (a waiting id still counts as "up", so
   * a poster that checks `getItemIds()` never re-posts it).
   */
  getItemIds() {
    return this._items.map(it => it.id).concat(this._waiting.map(it => it.id));
  }

  /**
   * Clear every visible hint. Wired to GAME_WIN (F3) so a lingering onboarding
   * chip doesn't sit on top of the victory screen. Also usable programmatically.
   */
  clearAll() {
    // Waiting step rows go first, so the fade of a visible step row can never
    // bring one back (no chip may sit over the victory report).
    this._dropAllWaiting();
    // Snapshot ids first — _fadeAndRemove mutates this._items in place.
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

  // ─── INTERNAL — DOM CONSTRUCTION ───────────────────────────────────────

  _build() {
    if (!_hasDOM() || !this._container) return;
    const T = _tuning();
    const strip = document.createElement('div');
    // Zoom Ladder (FloorMask, 08-workbench §4): on the F3 hull floor the mask
    // sets `data-floor-gone` on this strip (display:none !important) and clears
    // it on the next floor — the ticker itself never knows; items and timers
    // keep running and whatever is still alive reappears. The density 'score'
    // rung's `data-density-hidden` is the other, independent bit on this node.
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

    // Inline-glossary affordances. The strip is pointer-events:none (click-
    // through); decorated terms re-enable pointer events on themselves (see the
    // body span below) so a click can deep-link, and this delegated handler on
    // the strip catches the bubbled event.
    ensureGlossaryCss();
    delegateGlossaryClicks(strip);
  }

  // ─── INTERNAL — EVENTBUS WIRING ────────────────────────────────────────

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
    // F3: the game-win screen takes over — drop any lingering hint chips so they
    // don't hover over the victory report.
    if (Events.GAME_WIN) {
      on(Events.GAME_WIN, () => this.clearAll());
    }
  }

  // ─── EVENT HANDLERS ────────────────────────────────────────────────────

  _onHintPosted(payload) {
    if (this._disposed) return;
    if (!payload || !payload.id) return;
    // Idempotent: re-emitting the same id while alive = no-op.
    // A step row that is waiting off screen is "alive" too.
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

    // One step at a time: a new step row pushes every visible step row off
    // screen; they wait and come back when this one leaves.
    if (payload.step === true) this._shelveVisibleSteps();

    // Insert as LEFT-most (latest); push existing right.
    this._items.unshift(item);
    if (this._strip) {
      this._strip.insertBefore(el, this._strip.firstChild);
    }

    // Brief flash for `priority:'high'`.
    if (payload.priority === 'high' && _hasDOM()) {
      el.style.boxShadow = '0 0 12px rgb(var(--hud-info-rgb, 0 204 255) / 0.55)';
      setTimeout(() => { if (el) el.style.boxShadow = ''; }, 500);
    }

    // Displace 5th-and-beyond from the RIGHT (never a step row).
    this._enforceCap();

    // Restyle older entries (font / opacity / scale) — left-to-right.
    this._restyleAll();

    // Auto-expire timer.
    if (typeof setTimeout === 'function' && Number.isFinite(dur) && dur > 0) {
      item.timer = setTimeout(() => this._fadeAndRemove(item.id), dur);
    }
  }

  _onHintSatisfied(payload) {
    if (!payload || !payload.id) return;
    this._dropWaiting(payload.id);
    this._fadeAndRemove(payload.id);
  }

  _onSkillStateChanged(payload) {
    if (!payload || !payload.skillId || !payload.to) return;
    // When the related skill becomes 'practiced' (or higher), fade matching hints.
    const reached = (payload.to === 'practiced' || payload.to === 'mastered');
    if (!reached) return;
    for (const it of this._waiting.filter(w => w.skillId === payload.skillId)) {
      this._dropWaiting(it.id);
    }
    const matches = this._items.filter(it => it.skillId === payload.skillId);
    for (const it of matches) this._fadeAndRemove(it.id);
  }

  // ─── STEP WAIT LIST ────────────────────────────────────────────────────

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

  /** Forget a waiting row (satisfied / practiced / expired / cleared). */
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

  /**
   * Keep at most MAX_VISIBLE rows. The oldest NON-step row goes first: the cap
   * must never push out the step (visible or waiting) the player is meant to do.
   */
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

  // ─── ITEM LIFECYCLE ────────────────────────────────────────────────────

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
    }
    // Remove from array immediately so list logic stays consistent.
    this._items.splice(idx, 1);
    // Physically remove after fade.
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

  /** Force-remove without fade (e.g. displaced by 5th post). */
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

  /** Re-apply opacity / font / scale across the row (left = brightest). */
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

  /**
   * Build the DOM for one hint row.
   * @param {object} payload
   * @param {boolean} highlight — whether this slot is the latest (left-most)
   * @returns {HTMLElement}
   */
  _buildItemElement(payload, highlight) {
    const T = _tuning();
    const row = _hasDOM() ? document.createElement('div') : null;
    if (!row) return row;
    // The unlock chip (CodexSystem `_postAckChip`, `codexId: entry.id`) is
    // the ONE tappable row: pointer events back on, a pointer cursor, and a
    // click that reaches the `setChipTap` sink. Every other row stays
    // click-through (the strip is pointer-events:none). Tappable ONLY while a
    // sink is wired at build time: the hub wires it inside the LADDER.ENABLED
    // gate, so a ?ladder=0 boot (no SPECS pane, no sink) renders the shipped
    // click-through row byte-for-byte — never a dead pointer target.
    const tappable = (typeof payload.codexId === 'string') && (typeof this._onChipTap === 'function');
    // A step row on glass with a step sink and a button label IS the button
    // (44 px, label only). No sink / off glass: the plain chip, as before.
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

    // Glyph chip (left). On glass a keyed hint's chip is the GESTURE
    // ("HOLD → NET", see _resolveGlyph) — several words, so the chip must be
    // free to grow: it keeps its 22 px height and never shrinks or wraps
    // inside the flex row. Off glass the chip is one key glyph and the style
    // list is exactly what it was (desktop byte-identical).
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

    // Body text (right) — inline glossary decorated. `pointer-events:auto`
    // re-enables hit-testing inside the click-through strip so glossary terms
    // are clickable; decorateGlossary escapes the source before wrapping.
    // GestureHints.speak rewrites "[N]" / "(N)" / "Press N" as the gesture on
    // glass and hands back the SAME string off glass.
    const body = document.createElement('span');
    body.innerHTML = decorateGlossary(GestureHints.speak(payload.text || ''), { once: true });
    body.style.cssText = 'color:var(--hud-text, #ccddee);pointer-events:auto;';
    row.appendChild(body);

    if (tappable) {
      row.addEventListener('click', (e) => {
        // A glossary term inside the body is its own deep link (glossaryDom's
        // delegated handler on the strip) — one intent per tap: yield to it.
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
   * The chip text for a hint row. On glass a KEYED hint paints its gesture
   * (GestureHints.chipFor — the first key with a table row) even when the
   * payload also carries a `glyph`; glyph-only hints (`keys: []` — the '!'
   * refusal, the '…' hold, the codex 'I' ack) keep their glyph. Off glass
   * chipFor is always null and the key-glyph fallbacks below are untouched.
   */
  _resolveGlyph(payload) {
    const g = GestureHints.chipFor(payload.keys);
    if (g) return g;
    if (payload.glyph) return payload.glyph;
    if (Array.isArray(payload.keys) && payload.keys.length > 0) {
      // Friendly fallback: just take first character of first key.
      const k = String(payload.keys[0]);
      // Strip 'Key' prefix from KeyS / KeyD codes.
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
    // Matches a legacy mouse pictograph (U+1F5B1) still carried by some payloads;
    // built from its code point so this file renders no pictograph itself.
    if (glyph.includes(String.fromCodePoint(0x1F5B1)) || glyph.includes('mouse')) return T.KEY_CHIP_BG_MOUSE;
    if (glyph.includes('shift') || glyph.includes('ctrl') || glyph.includes('alt') || glyph.includes('meta')) {
      return T.KEY_CHIP_BG_MODIFIER;
    }
    return T.KEY_CHIP_BG_GAMEPLAY;
  }
}

export default HintTicker;
