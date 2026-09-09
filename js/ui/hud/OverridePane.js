/**
 * OverridePane.js — the SAFETY OVERRIDE demo panel (owner brief 2026-09-06/07;
 * .kilo/plans/1788703905516-safety-override-panel.md, decisions D1–D9).
 *
 * A big sci-fi cockpit button labelled SAFETY OVERRIDE at the bottom-centre of
 * the HUD. Pressing it slides a 2×2 grid up out of it — DAUGHTERS · RADIATOR /
 * ROSA · FURNACE. Three of the four tap the ship's REAL deploy/retract
 * hardware; the fourth has no hardware and is an obviously-broken, fritzing
 * button that runs a klaxon → "furnace offline" → fake self-destruct → 10 s
 * black-screen gag.
 *
 * Control law (D1) = SHIPPED. The panel receives the SAME `actuators` object
 * the hub builds for RefitPane (`{ rosaFurl, rosaFeather, struts, flower,
 * flowerSweep }`, each `{ get(), toggle() }`): a tap calls `toggle()` — which
 * reverses the COMMANDED state, plays the click and emits the input event —
 * and then `refresh()` re-reads truth through `get()`. Never an optimistic
 * label flip, never a second click blip (the closure owns the sound).
 *
 * Mapping (D2): DAUGHTERS → `struts` · RADIATOR → `flowerSweep` (the THERMAL
 * family's part is literally "RADIATOR PLATES") · ROSA → `rosaFurl` · FURNACE →
 * the gag. `rosaFeather` is NOT on the panel.
 *
 * RADIATOR (owner amendment 2026-09-09, plan
 * .kilo/plans/1788863400000-radiator-launch-fold-redesign.md last section):
 * "when player presses override button, and press "O" or clicks radiator
 * button, they need to see how radiator struts move, full range of motion".
 * The chip therefore reads the hub's `flowerSweep` actuator — FOLDED (the
 * LAUNCH geometry, θ 0, packs along the barrel, wings folded) ↔ DEPLOYED (the
 * STOW bud 146°), 'SLEWING' while moving; a tap runs
 * PlayerSatellite.toggleFlowerOverride (the whole 146° travel, a press
 * mid-swing reverses), which the hub only honours while this pane is engaged
 * (`isExpanded()`). The REFIT chip keeps the shipped `flower` STOW ↔ CARGO law.
 * `aria-pressed` = DEPLOYED (the hardware is OUT).
 *
 * Home (D3; ladder reorder rev 3): a pane-density rung the hub adds as the
 * last MEMBER of the `experimental` composite (the ladder's index 0 — the
 * lowest priority: hidden by default on every floor (FloorMask `MASK_PANES.override`,
 * every `DEFAULT_ROOMS` row 'gone', `memory: true`), the LAST `+` reveals it
 * and the FIRST `-` sheds it. The root is constructed with `data-density-hidden`
 * set; that attribute is THE one visibility bit (the module never writes
 * display:none itself).
 *
 * Placement (D4; follow-up 2026-09-09, owner: "almost at bottom" — plan
 * .kilo/plans/1788926404388-hud-followups-0909.md §1.1–6): STATIC. A DIRECT
 * child of `#hud-overlay` wearing `.hud-panel` but WITHOUT the plate
 * (transparent, no border, padding 0 — the sheet's id rule beats the class);
 * `bottom: max(12px, env(safe-area-inset-bottom, 0px))`, `left: 50%` /
 * `translateX(-50%)`, written ONCE in `_build`. Inside the glass thumb-rest
 * band by design: bottom-centre is the most reachable spot (the STORE-chip
 * precedent at bottom 12), and a press there is outside the edge-wake footer
 * band (132–164), so it wakes nothing. The root is `pointer-events: none`;
 * only `.ovr-main` (the 220 × 56 button, `margin: 0 auto` inside the 324
 * grid plate) and the OPEN grid take pointer events, so a drag beside the
 * button reaches the canvas. `setDodge` is RETIRED — nothing is fed per
 * frame. Never a side column (the columns dim under the F1 callouts).
 *
 * The bottom-centre stacking law (offsets from the viewport bottom): 12–68
 * gag (20–76 on an iPad with a 20 px inset) · 88–124 hint ticker · 120 salvage
 * popup (legacy) · 132 toast (`HUD.toastBottomPx`) · 132–164 footer band, free
 * centre · 148 F1 breadcrumb · 170 warnings · 172 ARM PILOT strip
 * (`HUD.armPilotStripBottomPx`). `?ladder=0` keeps toast 48 / strip 12 and
 * builds no gag.
 *
 * CTA: two lines — `.ovr-main-title` "SAFETY OVERRIDE" over `.ovr-main-cta`
 * "PRESS TO TEST ACTUATORS" / "PRESS TO CLOSE" (pure `mainLabel(expanded)`;
 * house uppercase; the cta inherits CAUTION / PLAYER from the button).
 *
 * Grid open hides what it would cover: `expand()` sets `body[data-ovr-open]`;
 * `collapse()`, `dispose()` and a GAME_STATE_CHANGE away from gameplay clear
 * it; the sheet hides `#hud-hint-ticker`, `#notification-zone` and
 * `#arm-pilot-controls` under it (the ticker is z 8000 on body, above the
 * overlay's grid).
 *
 * Reveal (D5) = slide-up: the grid translates up out of the main button in
 * SLIDE_MS (one curve, the RefitPane 270 ms); `prefers-reduced-motion` → no
 * transition, no fritz keyframes (steady dim + FAULT), no shake, no pulse.
 *
 * The FURNACE gag (D6) touches NO game state: IDLE → WARN1 → WARN2 → COUNTDOWN
 * → BLACKOUT → RECOVER → IDLE, every timer through the injected
 * setTimeout/clearTimeout so the FSM runs in Node on fake time. The black veil
 * is a DOM element with a known id (`#hud-override-veil`) that swallows POINTER
 * events only (Esc still reaches the game); `navigator.webdriver` builds no
 * veil at all (harness determinism — it must never be mistaken for the real
 * black-screen bug class, BLACK_SCREEN_TRIAGE.md). A GAME_STATE_CHANGE away
 * from gameplay, GAME_RESET, the rung hiding the panel, a collapse or a dispose
 * aborts and disposes everything at once.
 *
 * Everything lives inside the `Constants.LADDER.ENABLED` gate — the hub
 * constructs the pane only there. NO live singletons are imported here (the
 * one import is VisualLaw, pure data): bus / events / audio / timers / clock
 * are all injected (Node-testable).
 *
 * @module ui/hud/OverridePane
 */

import { VisualLaw } from '../../core/VisualLaw.js';

export const OVERRIDE_PANE_ID = 'hud-override-pane';
export const OVERRIDE_RUNG_ID = 'override';
export const OVERRIDE_STYLE_ID = 'override-pane-style';
export const OVERRIDE_VEIL_ID = 'hud-override-veil';
export const OVERRIDE_COUNTDOWN_ID = 'hud-override-countdown';
export const OVERRIDE_VIGNETTE_ID = 'hud-override-vignette';

/** Grid order: row 1 DAUGHTERS · RADIATOR, row 2 ROSA · FURNACE. */
export const OVERRIDE_KEYS = Object.freeze(['daughters', 'radiator', 'rosa', 'furnace']);

export const OVERRIDE_GEOMETRY = Object.freeze({
  MAIN_W_PX: 220,          // the big button's FIXED width (`margin: 0 auto` inside the 324 grid plate)
  MAIN_H_PX: 56,           // was 72 — the two-line CTA (16 px title over 11 px cta) fits 56 (follow-up 2026-09-09)
  MAIN_GLASS_MIN_H_PX: 56, // was 72 — still ≥ 44 pt (Apple HIG)
  BOTTOM_PX: 12,           // the root's CSS bottom floor: max(12px, env(safe-area-inset-bottom, 0px))
  BTN_W_PX: 150,           // grid buttons: desktop >= 44 px tall, glass >= 44x44 (Apple HIG 44 pt)
  BTN_H_PX: 44,
  BTN_GLASS_MIN_PX: 44,
  GAP_PX: 8,               // grid gap AND the gap between the grid plate and the main button
  SLIDE_MS: 270,           // motion law: one curve, 240-300 ms (RefitPane uses 270)
});

export const FURNACE_GAG = Object.freeze({
  KLAXON_S: 2,
  KLAXON_SHORT_S: 0.8,
  VIGNETTE_MS: 2000,
  VIGNETTE_HZ: 2,          // THREAT vignette pulse (real alarms); gag chrome is CAUTION steady
  FLASH_MS: 300,
  SHAKE_MS: 600,
  COUNTDOWN_FROM: 5,
  COUNTDOWN_STEP_MS: 1000,
  BLACKOUT_MS: 10000,
  CRT_TAIL_MS: 1500,
  RECOVER_FLICKERS: 3,
  RECOVER_FLICKER_MS: 80,
  CANCEL_RATE_MS: 400,
});

export const FURNACE_SENDER = 'FURNACE';

export const FURNACE_LINES = Object.freeze({
  WARN1:   Object.freeze({ text: 'WARNING: Furnace offline. Safety override rejected.', priority: 'warning' }),
  WARN2:   Object.freeze({ text: 'WARNING: Furnace interlock tripped. Do NOT press that again.', priority: 'warning' }),
  ARMED:   Object.freeze({ text: 'CRITICAL: Self-destruct sequence initiated.', priority: 'critical' }),
  CANCEL:  Object.freeze({ text: 'CAUTION: Cancel circuit not responding.', priority: 'caution' }),
  RECOVER: Object.freeze({ text: 'Furnace: still offline. Nothing happened. Nothing at all.', priority: 'info' }),
});

export const GAG_STATES = Object.freeze(['IDLE', 'WARN1', 'WARN2', 'COUNTDOWN', 'BLACKOUT', 'RECOVER']);

/** The centre-screen banner over the countdown numerals (owner 2026-09-07). */
export const COUNTDOWN_WARNING = 'SELF DESTRUCT INITIATED';

// ── Private constants ──────────────────────────────────────────────────────────

const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
const OPEN_ATTR = 'data-ovr-open';
const GLASS_ATTR = 'data-ovr-glass';
const REDUCED_ATTR = 'data-ovr-reduced';
const KEY_ATTR = 'data-ovr-key';
const FLICKER_ATTR = 'data-flicker';
const SHAKE_CLASS = 'ovr-shake';
const PULSE_CLASS = 'ovr-pulse';
const CRT_CLASS = 'ovr-crt';
const JITTER_CLASS = 'ovr-jitter';
const JITTER_MS = 200;               // the broken CANCEL's twitch
const TICK_MS = 1000;                // the 1 Hz label refresh while expanded
const PAD_PX = 8;
const Z_VIGNETTE = 9990;
const Z_COUNTDOWN = 9995;
const Z_VEIL = 100000;               // above everything incl. the pause overlay
const NOT_FITTED = 'NOT FITTED';     // RefitPane.ACTUATOR_NOT_FITTED, the flower's present-but-unowned word

/** The house palette (VisualLaw is pure data — no live singleton). */
const COLOR_PLAYER = VisualLaw.COLORS.PLAYER;     // heritage green — the HUD
const COLOR_THREAT = VisualLaw.COLORS.THREAT;     // red-orange — the ONE pulsing channel (vignette only; gag countdown is CAUTION steady, rev 3)
const COLOR_CAUTION = VisualLaw.COLORS.CAUTION;   // steady amber — FAULT, disabled reasons, gag main + countdown

/** The two-line CTA's words (house uppercase). */
const MAIN_TITLE = 'SAFETY OVERRIDE';
const CTA_CLOSED = 'PRESS TO TEST ACTUATORS';
const CTA_OPEN = 'PRESS TO CLOSE';

/** Panel key → actuators key (RADIATOR → the OVERRIDE full-range sweep, amendment 2026-09-09). */
const ACTUATOR_OF = Object.freeze({ daughters: 'struts', radiator: 'flowerSweep', rosa: 'rosaFurl' });
const NAME_OF = Object.freeze({ daughters: 'DAUGHTERS', radiator: 'RADIATOR', rosa: 'ROSA', furnace: 'FURNACE' });
/** "The hardware is OUT" — the aria-pressed pose (RADIATOR: DEPLOYED = the STOW bud; FOLDED / SLEWING read unpressed). */
const OUT_STATE = Object.freeze({ daughters: 'DEPLOYED', radiator: 'DEPLOYED', rosa: 'DEPLOYED' });
/** The honest reason when `get()` reads null. */
const NULL_REASON = Object.freeze({ daughters: 'NO DAUGHTER DOCKED', radiator: 'OFFLINE', rosa: 'OFFLINE' });

// ── Private helpers ────────────────────────────────────────────────────────────

/** @private The house matchMedia probe (RefitPane / FloorMask / DetailSlider). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

/** @private ms clock default. */
function _nowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch (_e) { /* fall through */ }
  return Date.now();
}

/** @private classList when present, else the className string (stub documents). */
function _addClass(el, c) {
  if (!el) return;
  if (el.classList && typeof el.classList.add === 'function') { el.classList.add(c); return; }
  const parts = String(el.className || '').split(/\s+/).filter(Boolean);
  if (!parts.includes(c)) parts.push(c);
  el.className = parts.join(' ');
}

/** @private */
function _removeClass(el, c) {
  if (!el) return;
  if (el.classList && typeof el.classList.remove === 'function') { el.classList.remove(c); return; }
  const parts = String(el.className || '').split(/\s+/).filter(Boolean).filter((p) => p !== c);
  el.className = parts.join(' ');
}

/** @private Remove an element from its document (never throws). */
function _removeEl(el) {
  if (!el) return;
  try {
    if (typeof el.remove === 'function') el.remove();
    else if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
  } catch (_e) { /* stub */ }
}

/** @private Walk up from a click target to the nearest [data-ovr-key] element. */
function _closestKey(el) {
  let node = el;
  for (let i = 0; node && i < 8; i++) {
    if (typeof node.hasAttribute === 'function' && node.hasAttribute(KEY_ATTR)) return node;
    node = node.parentNode || node.parentElement || null;
  }
  return null;
}

export class OverridePane {
  /**
   * @param {object} [deps] every dep optional, duck-typed, never trusted not to throw
   * @param {object}   [deps.actuators] the RefitPane actuators object — only `struts`, `flowerSweep`, `rosaFurl` are read
   * @param {object}   [deps.audio] `{ playClick?(), playKlaxon?(durationS), stopKlaxon?() }` (the AudioSystem singleton)
   * @param {object}   [deps.bus] `{ on(event, cb) -> unsubscribe, emit(event, data) }`
   * @param {object}   [deps.events] the Events name table
   * @param {string[]} [deps.gameplayStates] state ids that count as gameplay; a GAME_STATE_CHANGE to any
   *   other `to` aborts the gag. Absent / empty ⇒ ANY state change aborts (conservative).
   * @param {Document|null} [deps.doc] document (default: the global one; null = headless inert)
   * @param {Element}  [deps.parent] root's parent (default: `#hud-overlay`, else `doc.body`)
   * @param {boolean}  [deps.glass] true ⇒ 44 pt buttons
   * @param {boolean}  [deps.webdriver] true ⇒ the gag never builds the black veil
   * @param {boolean|function} [deps.reducedMotion] override for the matchMedia probe
   * @param {function} [deps.setTimeout] injected timer (default: the global)
   * @param {function} [deps.clearTimeout] injected timer (default: the global)
   * @param {function} [deps.now] ms clock (default: performance.now / Date.now)
   */
  constructor(deps = {}) {
    this._actuators = deps.actuators || null;
    this._audio = deps.audio || null;
    this._bus = deps.bus || null;
    this._events = deps.events || null;
    this._gameplayStates = Array.isArray(deps.gameplayStates) ? deps.gameplayStates.slice() : null;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._glass = !!deps.glass;
    this._webdriver = !!deps.webdriver;
    this._reducedDep = deps.reducedMotion;
    // Timers: injected or the globals. Always CALLED DETACHED (`const f = ...; f(cb, ms)`,
    // never as a method of the pane): window.setTimeout throws "Illegal invocation" when
    // its `this` is anything but the window — the 2026-09-07 browser witness caught every
    // gag timer silently dying that way while Node (which ignores `this`) stayed green.
    this._setTimeoutFn = typeof deps.setTimeout === 'function' ? deps.setTimeout
      : (typeof setTimeout === 'function' ? (fn, ms) => setTimeout(fn, ms) : null);
    this._clearTimeoutFn = typeof deps.clearTimeout === 'function' ? deps.clearTimeout
      : (typeof clearTimeout === 'function' ? (id) => clearTimeout(id) : null);
    this._now = typeof deps.now === 'function' ? deps.now : _nowMs;

    this._root = null;
    this._grid = null;
    this._mainBtn = null;
    this._titleEl = null;            // .ovr-main-title (static text)
    this._ctaEl = null;              // .ovr-main-cta (write-on-change on expand / collapse)
    this._btns = {};                 // key → button element
    this._models = {};               // key → last applied { text, disabled, pressed }
    this._rung = null;
    this._unsubs = [];
    this._disposed = false;
    this._expanded = false;
    this._tickId = null;             // the 1 Hz refresh while expanded (NOT a gag timer)

    // The FURNACE gag
    this._gagState = 'IDLE';
    this._pressCount = 0;
    this._timers = new Set();        // every pending gag timer id (abort clears them all)
    this._vignette = null;
    this._vignetteTimer = null;
    this._shaken = [];
    this._countdown = null;
    this._countNum = null;
    this._cancelBtn = null;
    this._count = 0;
    this._lastCancelMs = -Infinity;
    this._veil = null;
    this._recoverSteps = 0;

    this._onClick = (e) => this._handleClick(e);

    this._build(deps.parent);
    this._subscribe();
    if (this._root) this.refresh();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The pane-density rung adapter (cached; the HUD domRung shape). The ONE
   * visibility bit is `data-density-hidden` on the root; hiding the panel also
   * collapses the grid and aborts any in-flight gag. Never throws headless.
   * @returns {{id:string, label:string, isVisible:function, setVisible:function}}
   */
  rung() {
    if (!this._rung) {
      this._rung = {
        id: OVERRIDE_RUNG_ID,
        label: 'Override',
        isVisible: () => {
          const el = this._root;
          if (!el || (el.hasAttribute && el.hasAttribute(DENSITY_HIDDEN_ATTR))) return false;
          try {
            return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
          } catch (_e) {
            return false;
          }
        },
        setVisible: (v) => {
          if (!v) this.collapse();
          const el = this._root;
          if (!el || !el.setAttribute) return;
          if (v) el.removeAttribute(DENSITY_HIDDEN_ATTR);
          else el.setAttribute(DENSITY_HIDDEN_ATTR, '');
        },
      };
    }
    return this._rung;
  }

  /** Re-read the three actuators and repaint the labels (write-on-change; never throws). */
  refresh() {
    if (this._disposed || !this._root) return;
    for (const key of OVERRIDE_KEYS) {
      if (key === 'furnace') continue;
      this._applyModel(key, OverridePane.buttonLabel(key, this._readActuator(key)));
    }
  }

  /**
   * Slide the grid up: resets the gag press count, refreshes, starts the 1 Hz
   * tick, flips the CTA to PRESS TO CLOSE and sets `body[data-ovr-open]` (the
   * sheet hides the ticker / toast zone / ARM PILOT strip the grid would cover).
   */
  expand() {
    if (this._disposed || this._expanded) return;
    this._expanded = true;
    this._pressCount = 0;            // per collapsed → expanded session
    if (this._root) {
      this._root.setAttribute(OPEN_ATTR, '');
      if (this._mainBtn) this._mainBtn.setAttribute('aria-expanded', 'true');
    }
    this._applyCta(true);
    this._setBodyOpen(true);
    this.refresh();
    this._startTick();
  }

  /** Collapse the grid: stops the tick, aborts any in-flight gag, restores the CTA, clears `body[data-ovr-open]`. */
  collapse() {
    if (this._disposed) return;
    this._stopTick();
    this._abortGag();
    this._expanded = false;
    if (this._root) {
      this._root.removeAttribute(OPEN_ATTR);
      if (this._mainBtn) this._mainBtn.setAttribute('aria-expanded', 'false');
    }
    this._applyCta(false);
    this._setBodyOpen(false);
  }

  /** The main button's verb. */
  toggleExpanded() {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  /** @returns {boolean} */
  isExpanded() { return this._expanded; }

  /** @returns {string} one of GAG_STATES */
  gagState() { return this._gagState; }

  /** @returns {number} FURNACE presses in the current session (0 after recovery / abort / expand) */
  pressCount() { return this._pressCount; }

  /** @returns {object|null} the root element */
  el() { return this._root; }

  /** Abort the gag, clear every timer, unsubscribe, remove the root, clear `body[data-ovr-open]`; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._stopTick();
    this._abortGag();
    this._setBodyOpen(false);
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch (_e) { /* stub bus */ }
    }
    this._unsubs = [];
    if (this._root && typeof this._root.removeEventListener === 'function') {
      try { this._root.removeEventListener('click', this._onClick); } catch (_e) { /* stub */ }
    }
    _removeEl(this._root);
    this._root = null;
    this._grid = null;
    this._mainBtn = null;
    this._titleEl = null;
    this._ctaEl = null;
    this._btns = {};
    this._models = {};
    this._timers.clear();
  }

  /**
   * The pure two-line CTA law (follow-up 2026-09-09 §1.3): the title never
   * changes; the cta names the press's effect. House uppercase.
   * @param {boolean} expanded
   * @returns {{title:string, cta:string}}
   */
  static mainLabel(expanded) {
    return { title: MAIN_TITLE, cta: expanded ? CTA_OPEN : CTA_CLOSED };
  }

  /**
   * The pure label law (STATE-first like the REFIT chips). `pressed` = "the
   * hardware is OUT". `null` ⇒ disabled with the honest reason; the flower's
   * 'NOT FITTED' ⇒ disabled; a known state ⇒ the house word; any other non-null
   * state passes through uppercased, enabled, unpressed. FURNACE is never
   * disabled — it is BROKEN, not off. Unknown key ⇒ null.
   * @param {string} key one of OVERRIDE_KEYS
   * @param {string|null|undefined} state the actuator's `get()`
   * @returns {{text:string, sub?:string, disabled:boolean, pressed:boolean}|null}
   */
  static buttonLabel(key, state) {
    if (key === 'furnace') return { text: NAME_OF.furnace, sub: 'FAULT', disabled: false, pressed: false };
    const name = NAME_OF[key];
    if (!name || !ACTUATOR_OF[key]) return null;
    const sep = ' \u00b7 ';
    if (state == null) return { text: name + sep + NULL_REASON[key], disabled: true, pressed: false };
    const s = String(state).toUpperCase();
    if (s === NOT_FITTED) return { text: name + sep + NOT_FITTED, disabled: true, pressed: false };
    return { text: name + sep + s, disabled: false, pressed: s === OUT_STATE[key] };
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build the DOM under `parent` (headless: nothing). */
  _build(parentDep) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    let parent = parentDep || (typeof doc.getElementById === 'function' ? doc.getElementById('hud-overlay') : null);
    if (!parent) parent = doc.body || null;
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();
    const G = OVERRIDE_GEOMETRY;

    const root = doc.createElement('div');
    root.id = OVERRIDE_PANE_ID;
    root.className = 'hud-panel';
    // Geometry literals live inline (the style sheet carries the look). STATIC
    // placement, written once (follow-up 2026-09-09): bottom-centre, 12 px
    // (or the safe-area inset) off the viewport bottom — nothing dodges it,
    // nothing feeds it per frame. The root is the 324-wide grid plate's box
    // and takes NO pointer events; the button and the open grid opt in. Never
    // a column child: the hub's F1 callouts dim both side columns to 0.35 +
    // pointer-events:none.
    root.style.position = 'absolute';
    root.style.left = '50%';
    root.style.bottom = `max(${G.BOTTOM_PX}px, env(safe-area-inset-bottom, 0px))`;
    root.style.transform = 'translateX(-50%)';
    root.style.width = `${2 * G.BTN_W_PX + G.GAP_PX + 2 * PAD_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.padding = '0';
    root.style.pointerEvents = 'none';
    root.setAttribute(DENSITY_HIDDEN_ATTR, '');       // hidden by default on EVERY floor (D3)
    if (this._glass) root.setAttribute(GLASS_ATTR, '');
    if (this._reducedMotion()) root.setAttribute(REDUCED_ATTR, '');

    const grid = doc.createElement('div');
    grid.className = 'ovr-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Safety override');
    for (const key of OVERRIDE_KEYS) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.setAttribute('type', 'button');
      btn.setAttribute(KEY_ATTR, key);
      if (key === 'furnace') {
        btn.className = 'ovr-btn ovr-furnace';
        const model = OverridePane.buttonLabel(key, null);
        const name = doc.createElement('span');
        name.className = 'ovr-name';
        name.textContent = model.text;
        const sub = doc.createElement('span');
        sub.className = 'ovr-sub';
        sub.textContent = model.sub;
        btn.appendChild(name);
        btn.appendChild(sub);
        btn.setAttribute('aria-pressed', 'false');
      } else {
        btn.className = 'ovr-btn';
        btn.setAttribute('aria-pressed', 'false');
      }
      grid.appendChild(btn);
      this._btns[key] = btn;
    }

    const main = doc.createElement('button');
    main.type = 'button';
    main.setAttribute('type', 'button');
    main.className = 'ovr-main';
    main.setAttribute(KEY_ATTR, 'main');
    main.setAttribute('aria-expanded', 'false');
    main.style.pointerEvents = 'auto';               // the ONE hit surface while collapsed (root is none)
    // Two lines (follow-up 2026-09-09 §1.3): the title over the cta, both from
    // the pure law; the cta is rewritten on expand / collapse (write-on-change).
    const label = OverridePane.mainLabel(false);
    const title = doc.createElement('span');
    title.className = 'ovr-main-title';
    title.textContent = label.title;
    const cta = doc.createElement('span');
    cta.className = 'ovr-main-cta';
    cta.textContent = label.cta;
    main.appendChild(title);
    main.appendChild(cta);

    root.appendChild(grid);
    root.appendChild(main);
    if (typeof root.addEventListener === 'function') root.addEventListener('click', this._onClick);
    parent.appendChild(root);

    this._root = root;
    this._grid = grid;
    this._mainBtn = main;
    this._titleEl = title;
    this._ctaEl = cta;
  }

  /** @private The cta span follows the grid (write-on-change; title is static). */
  _applyCta(expanded) {
    const el = this._ctaEl;
    if (!el) return;
    const next = OverridePane.mainLabel(!!expanded).cta;
    if (el.textContent !== next) el.textContent = next;
  }

  /**
   * @private `body[data-ovr-open]` — the sheet hides the hint ticker, the toast
   * zone and the ARM PILOT strip while the grid is up (they share the
   * bottom-centre column the grid slides into). Write-on-change; headless /
   * no body ⇒ nothing.
   */
  _setBodyOpen(open) {
    const d = this._doc;
    const body = d && d.body;
    if (!body || typeof body.setAttribute !== 'function') return;
    const has = typeof body.hasAttribute === 'function' ? body.hasAttribute(OPEN_ATTR) : null;
    if (open) {
      if (has !== true) body.setAttribute(OPEN_ATTR, '');
    } else if (has !== false && typeof body.removeAttribute === 'function') {
      body.removeAttribute(OPEN_ATTR);
    }
  }

  /** @private One <style> per document, idempotent by id. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || typeof doc.head.appendChild !== 'function') return;
    if (typeof doc.getElementById === 'function' && doc.getElementById(OVERRIDE_STYLE_ID)) return;
    const G = OVERRIDE_GEOMETRY;
    const F = FURNACE_GAG;
    const P = `#${OVERRIDE_PANE_ID}`;
    const curve = 'cubic-bezier(0.65, 0, 0.35, 1)';
    const style = doc.createElement('style');
    style.id = OVERRIDE_STYLE_ID;
    style.textContent = `
      /* The rung bit, local copy (keeps the pane honest when it stands alone). */
      ${P}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* No plate (follow-up 2026-09-09): the root is the grid plate's box only —
         the .hud-panel background / border / padding are undone here (the id
         rule beats the class); the button and the open grid carry their own. */
      ${P} {
        display: block;
        overflow: visible;
        background: transparent;
        border: none;
        box-shadow: none;
        padding: 0;
        color: ${COLOR_PLAYER};
      }
      ${P} button {
        font-family: var(--font-mono);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      /* The big cockpit button: a FIXED 220 x 56 (two lines), centred in the plate's box. */
      ${P} .ovr-main {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: ${G.MAIN_W_PX}px;
        min-height: ${G.MAIN_H_PX}px;
        margin: 0 auto;
        box-sizing: border-box;
        padding: 4px 12px;
        line-height: 1.15;
        text-align: center;
        color: ${COLOR_CAUTION};
        text-shadow: 0 0 8px rgba(255, 170, 0, 0.45);
        background:
          repeating-linear-gradient(135deg, rgba(255, 170, 0, 0.12) 0 10px, rgba(0, 0, 0, 0) 10px 20px),
          rgba(20, 12, 0, 0.85);
        border: 2px solid ${COLOR_CAUTION};
        border-radius: 4px;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.6), inset 0 0 18px rgba(255, 170, 0, 0.12);
        transition: background-color 0.15s ease, box-shadow 0.15s ease;
        pointer-events: auto;
      }
      ${P} .ovr-main-title {
        font-size: 16px;
        font-weight: 700;
        letter-spacing: 0.16em;
        white-space: nowrap;
      }
      /* The cta inherits the button's colour (CAUTION closed / PLAYER open). */
      ${P} .ovr-main-cta {
        font-size: 11px;
        font-weight: 400;
        letter-spacing: 0.12em;
        opacity: 0.8;
        color: inherit;
        white-space: nowrap;
      }
      ${P} .ovr-main:hover { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.6), inset 0 0 26px rgba(255, 170, 0, 0.28); }
      ${P} .ovr-main:active { box-shadow: inset 0 3px 10px rgba(0, 0, 0, 0.7); }
      ${P}[${OPEN_ATTR}] .ovr-main { border-color: ${COLOR_PLAYER}; color: ${COLOR_PLAYER}; text-shadow: 0 0 8px rgba(0, 255, 136, 0.45); }
      /* Grid open hides what it would cover (the bottom-centre column): the hint
         ticker (z 8000 on body, above the overlay's grid), the toast zone and
         the ARM PILOT strip. expand() sets the body attribute; collapse() /
         dispose() / a GAME_STATE_CHANGE away from gameplay clear it. */
      body[${OPEN_ATTR}] #hud-hint-ticker, body[${OPEN_ATTR}] #notification-zone, body[${OPEN_ATTR}] #arm-pilot-controls { visibility: hidden !important; }
      /* The 2x2 grid slides UP out of the main button (its own plate above it). */
      ${P} .ovr-grid {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 100%;
        margin-bottom: ${G.GAP_PX}px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: ${G.GAP_PX}px;
        padding: ${PAD_PX}px;
        box-sizing: border-box;
        background: rgba(5, 10, 20, 0.95);
        border: 1px solid rgba(0, 255, 136, 0.3);
        border-radius: 4px;
        transform: translateY(24px);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: transform ${G.SLIDE_MS}ms ${curve}, opacity ${G.SLIDE_MS}ms ease, visibility 0s linear ${G.SLIDE_MS}ms;
      }
      ${P}[${OPEN_ATTR}] .ovr-grid {
        transform: translateY(0);
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transition: transform ${G.SLIDE_MS}ms ${curve}, opacity ${G.SLIDE_MS}ms ease, visibility 0s;
      }
      ${P} .ovr-btn {
        min-height: ${G.BTN_H_PX}px;
        box-sizing: border-box;
        padding: 4px 8px;
        font-size: 12px;
        letter-spacing: 0.06em;
        text-align: center;
        color: ${COLOR_PLAYER};
        background: rgba(0, 255, 136, 0.06);
        border: 1px solid rgba(0, 255, 136, 0.35);
        border-radius: 3px;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      ${P} .ovr-btn:hover:not(:disabled) { background: rgba(0, 255, 136, 0.14); }
      ${P} .ovr-btn[aria-pressed="true"] { background: rgba(0, 255, 136, 0.2); border-color: ${COLOR_PLAYER}; }
      ${P} .ovr-btn:disabled { color: ${COLOR_CAUTION}; opacity: 0.55; cursor: not-allowed; border-color: rgba(255, 170, 0, 0.35); background: rgba(255, 170, 0, 0.04); }
      /* FURNACE: obviously broken — irregular fritz + amber FAULT */
      ${P} .ovr-furnace {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        color: ${COLOR_CAUTION};
        border-color: rgba(255, 170, 0, 0.5);
        background: rgba(255, 170, 0, 0.05);
      }
      /* The fritz runs ONLY while the grid is open: visibility:hidden does not pause a CSS
         animation, and the panel is collapsed most of its life (review 2026-09-07). */
      ${P}[${OPEN_ATTR}] .ovr-furnace { animation: ovr-fritz 2.7s infinite; }
      ${P} .ovr-furnace .ovr-name { font-size: 12px; letter-spacing: 0.06em; }
      ${P} .ovr-furnace .ovr-sub { font-size: 11px; letter-spacing: 0.22em; color: ${COLOR_CAUTION}; }
      @keyframes ovr-fritz {
        0%   { opacity: 1; text-shadow: none; }
        7%   { opacity: 0.55; text-shadow: 0 0 5px ${COLOR_CAUTION}; }
        11%  { opacity: 1; text-shadow: none; }
        23%  { opacity: 0.8; }
        29%  { opacity: 1; }
        46%  { opacity: 0.4; text-shadow: 0 0 7px ${COLOR_CAUTION}; }
        49%  { opacity: 0.95; }
        63%  { opacity: 0.85; text-shadow: 0 0 3px ${COLOR_CAUTION}; }
        67%  { opacity: 1; }
        88%  { opacity: 0.5; text-shadow: 0 0 6px ${COLOR_CAUTION}; }
        91%  { opacity: 1; }
        100% { opacity: 1; text-shadow: none; }
      }
      /* Glass: 44 pt hit boxes (Apple HIG); the main button's fixed 220 x 56 already clears it */
      ${P}[${GLASS_ATTR}] .ovr-btn { min-height: ${G.BTN_GLASS_MIN_PX}px; min-width: ${G.BTN_GLASS_MIN_PX}px; font-size: 13px; }
      ${P}[${GLASS_ATTR}] .ovr-main { min-height: ${G.MAIN_GLASS_MIN_H_PX}px; }
      /* The gag's body-level chrome */
      #${OVERRIDE_VIGNETTE_ID} { opacity: 0.85; }
      .${PULSE_CLASS} { animation: ovr-pulse ${Math.round(1000 / F.VIGNETTE_HZ)}ms ease-in-out infinite; }
      @keyframes ovr-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
      .${SHAKE_CLASS} { animation: ovr-shake-kf ${F.SHAKE_MS}ms linear 1; }
      @keyframes ovr-shake-kf {
        0%, 100% { transform: translate(0, 0); }
        20% { transform: translate(-4px, 2px); }
        40% { transform: translate(4px, -3px); }
        60% { transform: translate(-3px, -2px); }
        80% { transform: translate(3px, 3px); }
      }
      /* The countdown stack sits in the upper middle (padding-bottom lifts the
         flex centre ~10vh) so CANCEL never lands on the SAFETY OVERRIDE grid. */
      #${OVERRIDE_COUNTDOWN_ID} { padding-bottom: 20vh; box-sizing: border-box; }
      #${OVERRIDE_COUNTDOWN_ID} .ovr-warn {
        font-family: var(--font-mono);
        font-size: clamp(22px, 2.9vw, 40px);
        font-weight: 700;
        letter-spacing: 0.18em;
        line-height: 1.1;
        text-align: center;
        color: ${COLOR_CAUTION};
        text-shadow: 0 0 18px rgba(255, 170, 0, 0.85), 0 0 48px rgba(255, 170, 0, 0.4);
        padding: 8px 22px;
        border: 3px solid ${COLOR_CAUTION};
        border-radius: 6px;
        background: rgba(20, 12, 0, 0.72);
      }
      #${OVERRIDE_COUNTDOWN_ID} .ovr-count {
        font-family: var(--font-mono);
        font-size: clamp(180px, 26vh, 320px);
        font-weight: 700;
        line-height: 1;
        margin-top: 12px;
        color: ${COLOR_CAUTION};
        text-shadow: 0 0 32px rgba(255, 170, 0, 0.9), 0 0 90px rgba(255, 170, 0, 0.45);
      }
      /* The text throb never dips below 0.72: a warning must stay legible on every frame. */
      #${OVERRIDE_COUNTDOWN_ID} .ovr-cancel {
        margin-top: 16px;
        min-width: 160px;
        min-height: 44px;
        font-family: var(--font-mono);
        font-size: 14px;
        letter-spacing: 0.2em;
        color: ${COLOR_CAUTION};
        background: rgba(20, 12, 0, 0.9);
        border: 2px solid ${COLOR_CAUTION};
        border-radius: 4px;
        cursor: pointer;
      }
      .${JITTER_CLASS} { animation: ovr-jitter-kf ${JITTER_MS}ms linear 1; opacity: 0.7; }
      @keyframes ovr-jitter-kf {
        0%, 100% { transform: translate(0, 0); }
        25% { transform: translate(3px, -2px); }
        50% { transform: translate(-2px, 2px); }
        75% { transform: translate(2px, 1px); }
      }
      #${OVERRIDE_VEIL_ID} { opacity: 1; }
      #${OVERRIDE_VEIL_ID}[${FLICKER_ATTR}] { opacity: 0.35; }
      #${OVERRIDE_VEIL_ID}.${CRT_CLASS} { animation: ovr-crt-kf 340ms steps(3) infinite; }
      @keyframes ovr-crt-kf { 0% { opacity: 1; } 40% { opacity: 0.93; } 70% { opacity: 0.97; } 100% { opacity: 1; } }
      /* Reduced motion: no slide, no fritz (steady dim + FAULT), no shake / pulse / flicker */
      ${P}[${REDUCED_ATTR}], ${P}[${REDUCED_ATTR}] .ovr-grid { transition: none; }
      ${P}[${REDUCED_ATTR}] .ovr-furnace { animation: none; opacity: 0.55; }
      @media (prefers-reduced-motion: reduce) {
        ${P}, ${P} .ovr-grid { transition: none; }
        ${P} .ovr-furnace { animation: none; opacity: 0.55; }
        .${PULSE_CLASS}, .${SHAKE_CLASS}, .${JITTER_CLASS}, #${OVERRIDE_VEIL_ID}.${CRT_CLASS}, #${OVERRIDE_COUNTDOWN_ID} .ovr-count, #${OVERRIDE_COUNTDOWN_ID} .ovr-warn { animation: none !important; }
      }
    `;
    doc.head.appendChild(style);
  }

  /** @private Subscribe to the actuator input/pose events (refresh) + the abort events. */
  _subscribe() {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.on !== 'function' || !E) return;
    const on = (name, fn) => {
      const ev = E[name];
      if (ev === undefined || ev === null) return;
      try {
        const off = bus.on(ev, fn);
        if (typeof off === 'function') this._unsubs.push(off);
        else if (typeof bus.off === 'function') this._unsubs.push(() => bus.off(ev, fn));
      } catch (_e) { /* stub bus */ }
    };
    const refresh = () => this.refresh();
    on('ROSA_FURL_INPUT', refresh);
    on('STRUT_DEPLOY_INPUT', refresh);
    on('THERMAL_FLOWER_INPUT', refresh);
    on('THERMAL_FLOWER_POSE', refresh);
    on('GAME_STATE_CHANGE', (p) => this._onStateChange(p));
    on('GAME_RESET', () => { this._abortGag(); this.collapse(); this.refresh(); });
  }

  // ── Labels + taps ──────────────────────────────────────────────────────────

  /** @private The actuator's `get()`, null on absence / throw. */
  _readActuator(key) {
    const a = this._actuators && this._actuators[ACTUATOR_OF[key]];
    if (!a || typeof a.get !== 'function') return null;
    try {
      const s = a.get();
      return s == null ? null : s;
    } catch (_e) {
      return null;
    }
  }

  /** @private Write one button's model, write-on-change. */
  _applyModel(key, model) {
    const btn = this._btns[key];
    if (!btn || !model) return;
    const prev = this._models[key];
    if (prev && prev.text === model.text && prev.disabled === model.disabled && prev.pressed === model.pressed) return;
    if (!prev || prev.text !== model.text) btn.textContent = model.text;
    if (!prev || prev.disabled !== model.disabled) {
      btn.disabled = model.disabled;
      if (model.disabled) {
        btn.setAttribute('disabled', '');
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.removeAttribute('disabled');
        btn.removeAttribute('aria-disabled');
      }
    }
    if (!prev || prev.pressed !== model.pressed) btn.setAttribute('aria-pressed', model.pressed ? 'true' : 'false');
    this._models[key] = model;
  }

  /** @private The ONE delegated click: main / a real actuator / FURNACE. */
  _handleClick(e) {
    if (this._disposed) return;
    const btn = _closestKey(e && e.target);
    if (!btn) return;
    const key = btn.getAttribute(KEY_ATTR);
    if (key === 'main') {
      try { if (this._audio && typeof this._audio.playClick === 'function') this._audio.playClick(); } catch (_e) { /* audio */ }
      this.toggleExpanded();
      return;
    }
    if (key === 'furnace') { this._furnacePress(); return; }
    if (!ACTUATOR_OF[key]) return;
    const model = this._models[key] || OverridePane.buttonLabel(key, this._readActuator(key));
    if (!model || model.disabled) return;                 // a disabled button drops the tap
    const a = this._actuators && this._actuators[ACTUATOR_OF[key]];
    if (a && typeof a.toggle === 'function') {
      // The closure owns the click + the input event (one wire, no double blip).
      try { a.toggle(); } catch (_e) { /* dep */ }
    }
    this.refresh();                                       // re-read truth, never an optimistic flip
  }

  /** @private The 1 Hz label refresh while expanded (labels follow the hotkeys). */
  _startTick() {
    this._stopTick();
    if (!this._root || !this._setTimeoutFn || !this._expanded) return;
    const setTimer = this._setTimeoutFn;                  // detached call (see the constructor)
    try {
      this._tickId = setTimer(() => {
        this._tickId = null;
        if (this._disposed || !this._expanded) return;
        this.refresh();
        this._startTick();
      }, TICK_MS);
    } catch (_e) {
      this._tickId = null;
    }
  }

  /** @private */
  _stopTick() {
    if (this._tickId != null) {
      this._clearTimer(this._tickId);
      this._tickId = null;
    }
  }

  // ── The FURNACE gag ────────────────────────────────────────────────────────

  /** @private Press 1 → WARN1, 2 → WARN2, 3 → COUNTDOWN; anything in flight beyond that is ignored. */
  _furnacePress() {
    if (this._disposed) return;
    const s = this._gagState;
    if (s === 'COUNTDOWN' || s === 'BLACKOUT' || s === 'RECOVER') return;   // ONE gag in flight
    this._pressCount += 1;
    if (this._pressCount === 1) this._warn1();
    else if (this._pressCount === 2) this._warn2();
    else this._enterCountdown();
  }

  /** @private */
  _warn1() {
    this._gagState = 'WARN1';
    this._klaxon(FURNACE_GAG.KLAXON_S);
    this._vibrate(200);
    this._showVignette(true, FURNACE_GAG.VIGNETTE_MS);
    this._shake(FURNACE_GAG.SHAKE_MS);
    this._comm(FURNACE_LINES.WARN1);
  }

  /** @private */
  _warn2() {
    this._gagState = 'WARN2';
    this._klaxon(FURNACE_GAG.KLAXON_SHORT_S);
    this._showVignette(false, FURNACE_GAG.FLASH_MS);
    this._comm(FURNACE_LINES.WARN2);
  }

  /** @private */
  _enterCountdown() {
    this._gagState = 'COUNTDOWN';
    this._comm(FURNACE_LINES.ARMED);
    this._lastCancelMs = -Infinity;
    this._count = FURNACE_GAG.COUNTDOWN_FROM;
    this._showCountdown();
    this._schedule(() => this._countdownTick(), FURNACE_GAG.COUNTDOWN_STEP_MS);
  }

  /** @private 5 → 4 → 3 → 2 → 1, and the tick after "1" → BLACKOUT. */
  _countdownTick() {
    if (this._gagState !== 'COUNTDOWN') return;
    this._count -= 1;
    if (this._count >= 1) {
      if (this._countNum) this._countNum.textContent = String(this._count);
      this._schedule(() => this._countdownTick(), FURNACE_GAG.COUNTDOWN_STEP_MS);
      return;
    }
    this._enterBlackout();
  }

  /** @private */
  _enterBlackout() {
    this._gagState = 'BLACKOUT';
    this._removeCountdown();
    if (!this._webdriver) this._showVeil();
    if (this._veil && !this._reducedMotion()) {
      this._schedule(() => { if (this._veil) _addClass(this._veil, CRT_CLASS); },
        FURNACE_GAG.BLACKOUT_MS - FURNACE_GAG.CRT_TAIL_MS);
    }
    this._schedule(() => this._enterRecover(), FURNACE_GAG.BLACKOUT_MS);
  }

  /** @private */
  _enterRecover() {
    this._gagState = 'RECOVER';
    if (!this._veil || this._reducedMotion()) { this._finishRecover(); return; }
    this._recoverSteps = FURNACE_GAG.RECOVER_FLICKERS * 2;
    this._recoverFlicker();
  }

  /** @private The three rapid flickers, then the veil goes. */
  _recoverFlicker() {
    const veil = this._veil;
    if (!veil) { this._finishRecover(); return; }
    if (this._recoverSteps % 2 === 0) veil.setAttribute(FLICKER_ATTR, '');
    else veil.removeAttribute(FLICKER_ATTR);
    this._recoverSteps -= 1;
    if (this._recoverSteps <= 0) { this._finishRecover(); return; }
    this._schedule(() => this._recoverFlicker(), FURNACE_GAG.RECOVER_FLICKER_MS);
  }

  /** @private */
  _finishRecover() {
    this._removeVeil();
    this._comm(FURNACE_LINES.RECOVER);
    this._pressCount = 0;
    this._gagState = 'IDLE';
  }

  /** @private The broken CANCEL: jitters, never cancels, one caution line per CANCEL_RATE_MS. */
  _cancelPress() {
    if (this._disposed || this._gagState !== 'COUNTDOWN') return;
    const btn = this._cancelBtn;
    if (btn && !this._reducedMotion()) {
      _addClass(btn, JITTER_CLASS);
      this._schedule(() => _removeClass(btn, JITTER_CLASS), JITTER_MS);
    }
    let t = NaN;
    try { t = Number(this._now()); } catch (_e) { t = NaN; }
    if (!Number.isFinite(t)) t = 0;
    if (t - this._lastCancelMs < FURNACE_GAG.CANCEL_RATE_MS) return;
    this._lastCancelMs = t;
    this._comm(FURNACE_LINES.CANCEL);
  }

  /**
   * @private Abort + dispose the gag at once (GAME_STATE_CHANGE away from
   * gameplay, GAME_RESET, the rung hiding the panel, collapse, dispose).
   * Idempotent.
   */
  _abortGag() {
    for (const id of this._timers) this._clearTimer(id);
    this._timers.clear();
    this._vignetteTimer = null;
    this._removeVeil();
    this._removeCountdown();
    this._removeVignette();
    this._unshake();
    try { if (this._audio && typeof this._audio.stopKlaxon === 'function') this._audio.stopKlaxon(); } catch (_e) { /* audio */ }
    this._gagState = 'IDLE';
    this._pressCount = 0;
    this._recoverSteps = 0;
  }

  /**
   * @private A GAME_STATE_CHANGE away from gameplay (shop / pause / menu / end
   * screens) aborts the gag AND collapses the grid (follow-up 2026-09-09 §1.5:
   * the collapse also clears `body[data-ovr-open]`, so the ticker / toast zone
   * / ARM PILOT strip are never left hidden off the flying view). A change TO a
   * gameplay state keeps the grid as it was.
   */
  _onStateChange(payload) {
    const to = payload && payload.to;
    const list = this._gameplayStates;
    if (!list || list.length === 0 || !list.includes(to)) {
      this._abortGag();
      this.collapse();
    }
  }

  // ── Gag DOM ────────────────────────────────────────────────────────────────

  /** @private */
  _canBody() {
    const d = this._doc;
    return !!(d && typeof d.createElement === 'function' && d.body && typeof d.body.appendChild === 'function');
  }

  /** @private */
  _byId(id) {
    const d = this._doc;
    return (d && typeof d.getElementById === 'function') ? d.getElementById(id) : null;
  }

  /** @private The THREAT vignette: pulsing for WARN1, steady for the WARN2 flash; removed after `ms`. */
  _showVignette(pulse, ms) {
    if (!this._canBody()) return;
    let v = this._vignette;
    if (!v) {
      const doc = this._doc;
      v = doc.createElement('div');
      v.id = OVERRIDE_VIGNETTE_ID;
      v.className = 'ovr-vignette';
      v.style.position = 'fixed';
      v.style.inset = '0';
      v.style.pointerEvents = 'none';
      v.style.zIndex = String(Z_VIGNETTE);
      v.style.background = `radial-gradient(ellipse at center, transparent 55%, ${COLOR_THREAT} 100%)`;
      doc.body.appendChild(v);
      this._vignette = v;
    }
    if (pulse && !this._reducedMotion()) _addClass(v, PULSE_CLASS);
    else _removeClass(v, PULSE_CLASS);
    if (this._vignetteTimer != null) {
      this._clearTimer(this._vignetteTimer);
      this._timers.delete(this._vignetteTimer);
    }
    this._vignetteTimer = this._schedule(() => { this._vignetteTimer = null; this._removeVignette(); }, ms);
  }

  /** @private */
  _removeVignette() {
    _removeEl(this._vignette);
    this._vignette = null;
  }

  /** @private CSS shake on the HUD overlay + the render canvas (the haptic on glass); skipped under reduced motion. */
  _shake(ms) {
    if (this._reducedMotion()) return;
    const els = [this._byId('hud-overlay'), this._byId('game-canvas')].filter(Boolean);
    if (!els.length) return;
    this._unshake();
    for (const el of els) _addClass(el, SHAKE_CLASS);
    this._shaken = els;
    this._schedule(() => this._unshake(), ms);
  }

  /** @private */
  _unshake() {
    for (const el of this._shaken) _removeClass(el, SHAKE_CLASS);
    this._shaken = [];
  }

  /** @private The centre-screen numerals + the broken CANCEL. */
  _showCountdown() {
    if (!this._canBody()) return;
    this._removeCountdown();
    const doc = this._doc;
    const box = doc.createElement('div');
    box.id = OVERRIDE_COUNTDOWN_ID;
    box.className = 'ovr-countdown';
    box.style.position = 'fixed';
    box.style.inset = '0';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.pointerEvents = 'none';
    box.style.zIndex = String(Z_COUNTDOWN);
    const warn = doc.createElement('div');
    warn.className = 'ovr-warn';
    warn.textContent = COUNTDOWN_WARNING;
    const num = doc.createElement('div');
    num.className = 'ovr-count';
    num.textContent = String(this._count);
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute('type', 'button');
    cancel.className = 'ovr-cancel';
    cancel.textContent = 'CANCEL';
    cancel.style.pointerEvents = 'auto';
    if (typeof cancel.addEventListener === 'function') cancel.addEventListener('click', () => this._cancelPress());
    box.appendChild(warn);
    box.appendChild(num);
    box.appendChild(cancel);
    doc.body.appendChild(box);
    this._countdown = box;
    this._countNum = num;
    this._cancelBtn = cancel;
  }

  /** @private */
  _removeCountdown() {
    _removeEl(this._countdown);
    this._countdown = null;
    this._countNum = null;
    this._cancelBtn = null;
  }

  /**
   * @private The black veil: above everything incl. the pause overlay, swallows
   * POINTER events only — never focused, no key trap, so Esc still pauses.
   */
  _showVeil() {
    if (!this._canBody()) return;
    this._removeVeil();
    const doc = this._doc;
    const veil = doc.createElement('div');
    veil.id = OVERRIDE_VEIL_ID;
    veil.className = 'ovr-veil';
    veil.setAttribute('aria-hidden', 'true');
    veil.style.position = 'fixed';
    veil.style.inset = '0';
    veil.style.background = 'rgb(0, 0, 0)';
    veil.style.zIndex = String(Z_VEIL);
    veil.style.pointerEvents = 'auto';
    doc.body.appendChild(veil);
    this._veil = veil;
  }

  /** @private */
  _removeVeil() {
    _removeEl(this._veil);
    this._veil = null;
  }

  // ── Small seams ────────────────────────────────────────────────────────────

  /** @private A gag timer: tracked in the Set so abort clears it. Returns the id (null headless). */
  _schedule(fn, ms) {
    if (!this._setTimeoutFn) return null;
    let id = null;
    const wrapped = () => {
      if (id != null) this._timers.delete(id);
      if (this._disposed) return;
      try { fn(); } catch (_e) { /* gag */ }
    };
    const setTimer = this._setTimeoutFn;                  // detached call (see the constructor)
    try {
      id = setTimer(wrapped, ms);
    } catch (_e) {
      return null;
    }
    if (id != null) this._timers.add(id);
    return id;
  }

  /** @private */
  _clearTimer(id) {
    if (id == null || !this._clearTimeoutFn) return;
    const clearTimer = this._clearTimeoutFn;              // detached call (see the constructor)
    try { clearTimer(id); } catch (_e) { /* timer */ }
  }

  /**
   * @private The FURNACE's comms line. `_reactive: true` is the CommsSystem
   * guidance arbiter's bypass for feedback to a key the player JUST pressed —
   * without it the onboarding tiers (commsSuppression tier 0–2) mute the gag
   * and the button reads as dead instead of broken (the 2026-09-07 witness).
   * The texts lead with WARNING:/CAUTION:/CRITICAL: on purpose: that is the
   * ALERT-channel heuristic (sourceToChannel), so they never queue as flavor.
   */
  _comm(line) {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.emit !== 'function' || !E || !E.COMMS_MESSAGE || !line) return;
    try {
      bus.emit(E.COMMS_MESSAGE, { sender: FURNACE_SENDER, text: line.text, priority: line.priority, _reactive: true });
    } catch (_e) { /* bus */ }
  }

  /** @private */
  _klaxon(durationS) {
    try {
      if (this._audio && typeof this._audio.playKlaxon === 'function') this._audio.playKlaxon(durationS);
    } catch (_e) { /* audio */ }
  }

  /** @private iPadOS Safari has no Vibration API — the shake IS the haptic there. */
  _vibrate(ms) {
    try {
      if (typeof navigator !== 'undefined' && navigator && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
    } catch (_e) { /* nav */ }
  }

  /** @private */
  _reducedMotion() {
    const d = this._reducedDep;
    if (typeof d === 'function') {
      try { return !!d(); } catch (_e) { return false; }
    }
    if (typeof d === 'boolean') return d;
    return _prefersReducedMotion();
  }
}

export default OverridePane;
