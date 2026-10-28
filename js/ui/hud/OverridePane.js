/**
 * The SAFETY OVERRIDE demo panel (owner brief 2026-09-06/07): a big cockpit button at the bottom-centre of the HUD. Pressing it slides a 2×2
 * grid up out of it — DAUGHTERS · RADIATOR / ROSA · FURNACE. Three tap the ship's REAL deploy/retract hardware;
 * FURNACE has no hardware and is an obviously-broken button that runs a klaxon → "furnace offline" → "containment
 * failing" → fake self-destruct → 10 s black-screen gag with a POST screen, a systems reboot and a dry word from
 * Houston.
 *
 * Control law: the panel receives the SAME `actuators` object the hub builds for RefitPane (`{ rosaFurl,
 * rosaFeather, struts, flower, flowerSweep }`, each `{ get(), toggle() }`): a tap calls `toggle()` (reverses the
 * COMMANDED state, plays the click, emits the input event), then `refresh()` re-reads truth through `get()`. Never
 * an optimistic label flip, never a second click blip (the closure owns the sound).
 *
 * Mapping: DAUGHTERS → `struts` · RADIATOR → `flowerSweep` · ROSA → `rosaFurl` · FURNACE → the gag.
 * `rosaFeather` is NOT on the panel.
 *
 * RADIATOR: owner 2026-09-09: pressing override and then "O" or the radiator button must show the full range of
 * radiator-strut motion. The chip reads `flowerSweep`: FOLDED (LAUNCH geometry, θ 0) ↔ DEPLOYED (146°), 'SLEWING'
 * while moving; a tap runs PlayerSatellite.toggleFlowerOverride (the whole 146° travel, a press mid-swing reverses),
 * which the hub only honours while this pane is engaged (`isExpanded()`). The REFIT chip keeps the `flower` STOW ↔
 * CARGO law. `aria-pressed` = DEPLOYED (the hardware is OUT).
 *
 * Home: a pane-density rung the hub adds as the last MEMBER of the `experimental` composite (the ladder's index 0,
 * lowest priority): hidden by default on every floor (FloorMask `MASK_PANES.override`, every `DEFAULT_ROOMS` row
 * 'gone', `memory: true`), the LAST `+` reveals it and the FIRST `-` sheds it. The root is constructed with
 * `data-density-hidden`; that attribute is THE one visibility bit (this module never writes display:none).
 *
 * Placement (owner 2026-09-09: "almost at bottom"): STATIC. A DIRECT child of `#hud-overlay` wearing `.hud-panel`
 * but WITHOUT the plate (the sheet's id rule beats the class); `bottom: max(12px, env(safe-area-inset-bottom, 0px))`,
 * `left: 50%` / `translateX(-50%)`, written ONCE in `_build`. Inside the glass thumb-rest band by design, and
 * outside the edge-wake footer band (132–164), so a press wakes nothing. The root is `pointer-events: none`; only
 * `.ovr-main` and the OPEN grid take pointer events, so a drag beside the button reaches the canvas. Never a side
 * column (the columns dim under the F1 callouts).
 *
 * The bottom-centre stacking law (offsets from the viewport bottom): 12–76 gag (20–84 on an iPad with a 20 px
 * inset) · 88–124 hint ticker · 120 salvage popup (legacy) · 132 toast (`HUD.toastBottomPx`) · 132–164 footer band,
 * free centre · 148 F1 breadcrumb · 170 warnings · 172 ARM PILOT strip (`HUD.armPilotStripBottomPx`).
 * `?ladder=0` keeps toast 48 / strip 12 and builds no gag.
 *
 * CTA: two lines — `.ovr-main-title` "SAFETY OVERRIDE" over `.ovr-main-cta` "PRESS TO TEST ACTUATORS" /
 * "PRESS TO CLOSE" (pure `mainLabel(expanded)`; the cta inherits CAUTION / PLAYER from the button).
 *
 * The tempting button (owner 2026-09-09, gag v2: "more tempting"): hazard tape top and bottom
 * (`.ovr-main::before/::after`, 6 px CAUTION / near-black stripes),
 * a live lamp before the title (`.ovr-main-title::before`). Open ⇒ tape and lamp turn PLAYER with the button. No new
 * DOM, pseudo-elements only; every colour is `VisualLaw.COLORS`. The ONE motion: a one-shot `ovr-attract` blink
 * (ATTRACT_MS, three blinks) when the rung REVEALS the panel (hidden → visible), removed by a tracked timer; never
 * on expand, never idle, never under reduced motion. CAUTION stays steady otherwise (colour law: only THREAT pulses).
 *
 * Grid open hides what it would cover: `expand()` sets `body[data-ovr-open]`; `collapse()`, `dispose()` and a
 * GAME_STATE_CHANGE away from gameplay clear it; the sheet hides `#hud-hint-ticker`, `#notification-zone` and
 * `#arm-pilot-controls` under it (the ticker is z 8000 on body, above the overlay's grid).
 *
 * Reveal = slide-up in SLIDE_MS; `prefers-reduced-motion` → no transition, no fritz keyframes (steady dim +
 * FAULT), no shake, no pulse.
 *
 * The FURNACE gag (owner 2026-09-09, v2) touches NO game state: IDLE → WARN → OVERHEAT → COUNTDOWN → BLACKOUT → RECOVER → IDLE, every timer
 * through the injected setTimeout/clearTimeout so the FSM runs in Node on fake time. TWO presses arm it
 * (`PRESSES_TO_ARM`): press 1 = klaxon + THREAT vignette pulse + shake + "Do NOT press that again."; press 2 = the
 * same alarm + "Furnace overheating. Containment failing." and, OVERHEAT_MS later, the countdown (SELF DESTRUCT
 * INITIATED, 5 … 1; every numeral change ticks the injected click; the CANCEL button is broken by design). The tick
 * after 1 is the hit: `audio.playCollision` + a 300 ms haptic + the black veil — a DOM element with a known id
 * (`#hud-override-veil`) that swallows POINTER events only (Esc still reaches the game). Five seconds of pure black,
 * then the POST screen (`.ovr-post` inside the veil, ten ASCII lines one per POST_LINE_MS), the CRT tail from
 * T+8500, RECOVER at T+10000. RECOVER asks the injected systems reboot (`deps.reboot`, HudReboot) to darken every
 * visible HUD element FIRST, then flickers the veil three times and lifts it onto the bare world and waits for the
 * reboot's `onDone` (the panels return top → bottom) before the run closes; without the dep (or webdriver / reduced
 * motion / a `false` return) it is the flickers → IDLE at once. No FURNACE line closes the run. Then
 * HOUSTON_DELAY_MS later Houston: "Cowboy, did you read the manual." — escalating over the session's runs
 * (`gagRuns()`, never persisted), "manual" a SPECS deep link (`HOUSTON_LINK`: page one of the manual, landing on its
 * WARNING box). `navigator.webdriver` builds no veil at all (it must never be mistaken for the real black-screen bug
 * class, BLACK_SCREEN_TRIAGE.md), so no POST and no reboot either. A GAME_STATE_CHANGE away from gameplay,
 * GAME_RESET, the rung hiding the panel, a collapse or a dispose aborts and disposes everything at once: the reboot
 * cancelled (no dark panel left behind), the Houston line dropped.
 *
 * F1 BAR (DECISIONS §15 row 9): the same four buttons as a flat always-visible bar at the bottom centre of F1 —
 * `#hud-f1-bar`, a SIBLING root built here and sharing the gag, the actuators and the label/click machinery. Plain
 * labels with a live state word under each (WINGS · DAUGHTERS · RADIATORS · FURNACE); no hazard-tape main button,
 * no slide-up. Its ONE visibility bit is FloorMask's `data-floor-gone` (MASK_PANES.f1bar, an attribute pane, shown
 * on F1 only); styling is injected CSS, never inline. RADIATOR reads / drives the hub's `flowerDeploy` actuator (the
 * O key's plain toggle, never the override sweep) and a tap inside `tapDebounceMs` of the last one is dropped, so a
 * touch double-tap can never VENT. FURNACE is the same joke until the furnace is built.
 *
 * Everything lives inside the `Constants.LADDER.ENABLED` gate — the hub constructs the pane only there. NO live
 * singletons are imported (the one import is VisualLaw, pure data): bus / events / audio / reboot / timers / clock
 * are all injected (Node-testable; the reboot is tested against a fake).
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
  MAIN_W_PX: 260,          // the big button's FIXED width (`margin: 0 auto` inside the 324 grid plate)
  MAIN_H_PX: 64,           // two lines + the 6 px hazard bands top and bottom; 12 + 64 = 76 < the ticker's 88
  MAIN_GLASS_MIN_H_PX: 64, // ≥ 44 pt (Apple HIG)
  BOTTOM_PX: 12,           // the root's CSS bottom floor: max(12px, env(safe-area-inset-bottom, 0px))
  BTN_W_PX: 150,           // grid buttons: desktop >= 44 px tall, glass >= 44x44 (HIG 44 pt)
  BTN_H_PX: 44,
  BTN_GLASS_MIN_PX: 44,
  GAP_PX: 8,               // grid gap AND the gap between the grid plate and the main button
  SLIDE_MS: 270,           // motion law: one curve, 240-300 ms (RefitPane 270)
});

/** The F1 bar (DECISIONS §15 row 9): a root of its own, beside the override pane. */
export const F1_BAR_ID = 'hud-f1-bar';
export const F1_BAR_KEYS = Object.freeze(['wings', 'struts', 'radiator', 'furnace']);
export const F1_BAR_GEOMETRY = Object.freeze({
  BTN_W_PX: 94,            // each button (owner's floor 88); 4 x 94 + 3 x 8 = 400 keeps the bar clear of a 380 px drawer at 1180 wide
  BTN_H_PX: 48,            // touch-sized (>= 44 pt HIG) on desktop and glass alike
  GAP_PX: 8,
  BOTTOM_PX: 12,           // CSS bottom floor: max(12px, env(safe-area-inset-bottom, 0px)); the bar's top is 12 + 48 = 60 < the hint ticker's 88
  TICK_MS: 500,            // the bar's live-state refresh (struts have no arrival event)
  HOLD_VENT_MS: 450,       // a press held this long on RADIATORS sends 180° (= TouchControls' radial holdMs; deps.holdMs overrides)
  HOLD_SWALLOW_MS: 1000,   // the click after a hold's release is swallowed this long; a long press with no click never eats a later tap
  TAP_DEBOUNCE_MS: 600,    // = Constants.THERMAL.FLOWER.VENT_DOUBLE_TAP_MS (main.js passes the live value as deps.tapDebounceMs)
  // The override pane pulled out on F1 sits at the same bottom-centre spot (12 + 64): the bar lifts above it AND
  // above the hint band (Constants.ONBOARDING.TICKER BOTTOM_PX 88 + ROW_HEIGHT_PX 36 + 8 = 132). With its grid open
  // the bar hides (two RADIATOR buttons doing different things at once would confuse).
  LIFT_OVER_HINT_PX: 132,
  // Drawer open: the bar centre keeps at least clamp(380px, 28vw, 440px) (WorkbenchPane's width, pinned by
  // test-F1Bar) + DRAWER_GAP_PX + half the bar from the left edge, clear of the drawer and of the SPECS tab riding
  // its inner edge (measured 59-60 wide). Wide screens stay centred.
  DRAWER_GAP_PX: 72,
  // FURNACE on the bar has no expand/collapse to reset the two-press joke: a WARN left this long (or the bar
  // hidden) goes back to IDLE, so press 2 is a deliberate second press.
  FURNACE_RESET_MS: 30000,
});

export const FURNACE_GAG = Object.freeze({
  PRESSES_TO_ARM: 2,       // press 1 WARN, press 2 OVERHEAT → COUNTDOWN
  KLAXON_S: 2,             // both presses; AudioSystem's klaxon is single-instance (a call while one sounds is ignored)
  VIGNETTE_MS: 2000,       // WARN: THREAT vignette pulse (real alarms); gag chrome is CAUTION steady
  VIGNETTE_HZ: 2,
  SHAKE_MS: 600,
  OVERHEAT_MS: 1800,       // OVERHEAT: the vignette pulse AND the beat before the countdown ("containment failing")
  COUNTDOWN_FROM: 5,
  COUNTDOWN_STEP_MS: 1000,
  BLACKOUT_MS: 10000,
  POST_START_MS: 5000,     // pure black, then the POST lines
  POST_LINE_MS: 450,       // T+5000 … T+9050
  CRT_TAIL_MS: 1500,
  RECOVER_FLICKERS: 3,
  RECOVER_FLICKER_MS: 80,
  HOUSTON_DELAY_MS: 1500,  // the Houston line lands this long after the run closes (veil off / reboot done)
  ATTRACT_MS: 900,         // the one-shot reveal blink on the main button (three blinks)
  CANCEL_RATE_MS: 400,
});

export const FURNACE_SENDER = 'FURNACE';
export const HOUSTON_SOURCE = 'HOUSTON';

export const FURNACE_LINES = Object.freeze({
  WARN:     Object.freeze({ text: 'WARNING: Furnace offline. Safety override rejected. Do NOT press that again.', priority: 'warning' }),
  OVERHEAT: Object.freeze({ text: 'WARNING: Furnace overheating. Containment failing.', priority: 'warning' }),
  ARMED:    Object.freeze({ text: 'CRITICAL: Self-destruct sequence initiated.', priority: 'critical' }),
  CANCEL:   Object.freeze({ text: 'CAUTION: Cancel circuit not responding.', priority: 'caution' }),
});

/**
 * Houston's escalating lines, one per gag run in the session (index `min(gagRuns - 1, 1)`; never persisted). No `!`
 * and no `WARNING:` prefix (it would re-route the line to the ALERT channel). Both contain "manual": both carry
 * HOUSTON_LINK.
 */
export const HOUSTON_LINES = Object.freeze([
  'Cowboy, did you read the manual.',
  'Cowboy. The manual. Page one.',
]);

/**
 * The COMMS_MESSAGE `link`: CommsPanel wraps the first whole-word "manual" as a `.glossary-link` that opens the SPECS
 * viewer on page one of the manual (`welcome_cowboy`), landing on its WARNING box.
 */
export const HOUSTON_LINK = Object.freeze({ term: 'manual', entryId: 'welcome_cowboy', anchor: 'warning' });

/**
 * The POST screen: ten ASCII lines, one per POST_LINE_MS from POST_START_MS, each its own <div> (textContent).
 * FURNACE CTRL fails twice on purpose.
 */
export const POST_LINES = Object.freeze([
  'MOTHER ROM v0.9.3 ...... POST',
  'MEM CHECK .............. OK',
  'POWER BUS .............. OK',
  'THERMAL LOOP ........... OK',
  'COMMS .................. OK',
  'FURNACE CTRL ........... FAIL',
  'FURNACE CTRL ........... FAIL',
  'SAFETY INTERLOCK ....... OK',
  'DELTA-V RESERVE ........ OK',
  'HUD .................... RESTARTING',
]);

export const OVERRIDE_POST_CLASS = 'ovr-post';

export const GAG_STATES = Object.freeze(['IDLE', 'WARN', 'OVERHEAT', 'COUNTDOWN', 'BLACKOUT', 'RECOVER']);

/** The centre-screen banner over the countdown numerals (owner 2026-09-07). */
export const COUNTDOWN_WARNING = 'SELF DESTRUCT INITIATED';

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
const ATTRACT_CLASS = 'ovr-attract';  // the main button's one-shot reveal blink
const JITTER_MS = 200;               // the broken CANCEL's twitch
const TICK_MS = 1000;                // the 1 Hz label refresh while expanded
const PAD_PX = 8;
const Z_VIGNETTE = 9990;
const Z_COUNTDOWN = 9995;
const Z_VEIL = 100000;               // above everything incl. the pause overlay
const NOT_FITTED = 'NOT FITTED';     // RefitPane.ACTUATOR_NOT_FITTED, the flower's present-but-unowned word

const COLOR_PLAYER = `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`;     // heritage green — the HUD
const COLOR_THREAT = `var(--hud-warning, ${VisualLaw.COLORS.THREAT})`;     // the ONE pulsing channel (vignette only; the gag countdown is CAUTION steady)
const COLOR_CAUTION = `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})`;   // steady amber — FAULT, disabled reasons, gag main + countdown

const MAIN_TITLE = 'SAFETY OVERRIDE';
const CTA_CLOSED = 'PRESS TO TEST ACTUATORS';
const CTA_OPEN = 'PRESS TO CLOSE';

/** F1 bar key → actuators key (RADIATOR → `flowerDeploy`, the O key's plain toggle — never the override sweep). */
const BAR_ACTUATOR_OF = Object.freeze({ struts: 'struts', radiator: 'flowerDeploy', wings: 'rosaFurl' });
const BAR_NAME_OF = Object.freeze({ struts: 'DAUGHTERS', radiator: 'RADIATORS', wings: 'WINGS', furnace: 'FURNACE' });
const BAR_NULL_STATE = Object.freeze({ struts: 'NO DAUGHTER', radiator: 'OFFLINE', wings: 'OFFLINE' });
const HOLDING_ATTR = 'data-holding';      // RADIATORS while a press is on its way to the hold (not the "pressed" look: that means open)
const FLOOR_GONE_ATTR = 'data-floor-gone';  // FloorMask's attribute-pane bit (the mask is its one writer)

/** Panel key → actuators key (RADIATOR → the OVERRIDE full-range sweep). */
const ACTUATOR_OF = Object.freeze({ daughters: 'struts', radiator: 'flowerSweep', rosa: 'rosaFurl' });
const NAME_OF = Object.freeze({ daughters: 'DAUGHTERS', radiator: 'RADIATOR', rosa: 'ROSA', furnace: 'FURNACE' });
/** "The hardware is OUT": the aria-pressed pose (RADIATOR: FOLDED / SLEWING read unpressed). */
const OUT_STATE = Object.freeze({ daughters: 'DEPLOYED', radiator: 'DEPLOYED', rosa: 'DEPLOYED' });
const NULL_REASON = Object.freeze({ daughters: 'NO DAUGHTER DOCKED', radiator: 'OFFLINE', rosa: 'OFFLINE' });

/** The house matchMedia probe (RefitPane / FloorMask / DetailSlider). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

function _nowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch (_e) { /* fall through */ }
  return Date.now();
}

/** classList when present, else the className string (stub documents). */
function _addClass(el, c) {
  if (!el) return;
  if (el.classList && typeof el.classList.add === 'function') { el.classList.add(c); return; }
  const parts = String(el.className || '').split(/\s+/).filter(Boolean);
  if (!parts.includes(c)) parts.push(c);
  el.className = parts.join(' ');
}

function _removeClass(el, c) {
  if (!el) return;
  if (el.classList && typeof el.classList.remove === 'function') { el.classList.remove(c); return; }
  const parts = String(el.className || '').split(/\s+/).filter(Boolean).filter((p) => p !== c);
  el.className = parts.join(' ');
}

/** Never throws. */
function _removeEl(el) {
  if (!el) return;
  try {
    if (typeof el.remove === 'function') el.remove();
    else if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
  } catch (_e) { /* stub */ }
}

/** Walk up from a click target to the nearest [data-ovr-key] element. */
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
   * @param {object}   [deps.actuators] the RefitPane actuators; the panel reads `struts`, `flowerSweep`, `rosaFurl`
   * @param {object}   [deps.audio] `{ playClick?(), playKlaxon?(durationS), stopKlaxon?(), playCollision?() }`: the
   *   click is the main button's press AND the countdown's tick; the collision is the blackout thud
   * @param {object}   [deps.reboot] HudReboot, `{ play({ onDone }) -> boolean, cancel() }`: RECOVER calls `play` FIRST
   *   and waits for `onDone` before the run closes; a `false` return, a missing dep, webdriver, no veil or reduced
   *   motion ⇒ flickers → IDLE at once. Every abort calls `cancel()`
   * @param {object}   [deps.bus] `{ on(event, cb) -> unsubscribe, emit(event, data) }`
   * @param {object}   [deps.events] the Events name table
   * @param {string[]} [deps.gameplayStates] state ids that count as gameplay; a GAME_STATE_CHANGE to any other `to`
   *   aborts the gag. Absent / empty ⇒ ANY state change aborts.
   * @param {Document|null} [deps.doc] document (default: the global one; null = headless inert)
   * @param {Element}  [deps.parent] root's parent (default: `#hud-overlay`, else `doc.body`)
   * @param {boolean}  [deps.glass] true ⇒ 44 pt buttons
   * @param {boolean}  [deps.barTick] true ⇒ the F1 bar re-reads the actuators every F1_BAR_GEOMETRY.TICK_MS; default
   *   off so a bare pane owns no timer
   * @param {number}   [deps.tapDebounceMs] RADIATOR / FURNACE taps closer than this are dropped (main.js: VENT_DOUBLE_TAP_MS)
   * @param {function} [deps.drawerOpen] zero-arg bool: the workbench drawer is open (the bar tick shifts the bar clear of it)
   * @param {boolean}  [deps.webdriver] true ⇒ the gag never builds the black veil (so no POST, no reboot)
   * @param {boolean|function} [deps.reducedMotion] override for the matchMedia probe
   * @param {function} [deps.setTimeout] injected timer (default: the global)
   * @param {function} [deps.clearTimeout] injected timer (default: the global)
   * @param {function} [deps.now] ms clock (default: performance.now / Date.now)
   */
  constructor(deps = {}) {
    this._actuators = deps.actuators || null;
    this._audio = deps.audio || null;
    this._reboot = deps.reboot || null;
    this._bus = deps.bus || null;
    this._events = deps.events || null;
    this._gameplayStates = Array.isArray(deps.gameplayStates) ? deps.gameplayStates.slice() : null;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._glass = !!deps.glass;
    this._webdriver = !!deps.webdriver;
    this._reducedDep = deps.reducedMotion;
    // Timers: injected or the globals. Always CALLED DETACHED, never as a method of the pane: window.setTimeout
    // throws "Illegal invocation" when `this` is not the window (Node ignores `this`, so tests stay green).
    this._setTimeoutFn = typeof deps.setTimeout === 'function' ? deps.setTimeout
      : (typeof setTimeout === 'function' ? (fn, ms) => setTimeout(fn, ms) : null);
    this._clearTimeoutFn = typeof deps.clearTimeout === 'function' ? deps.clearTimeout
      : (typeof clearTimeout === 'function' ? (id) => clearTimeout(id) : null);
    this._now = typeof deps.now === 'function' ? deps.now : _nowMs;
    this._barTickOn = deps.barTick === true;   // opt-in: the hub passes true (a default timer would show in every pane test)
    this._tapDebounceMs = Number.isFinite(deps.tapDebounceMs) ? deps.tapDebounceMs : F1_BAR_GEOMETRY.TAP_DEBOUNCE_MS;
    this._holdMs = Number.isFinite(deps.holdMs) ? deps.holdMs : F1_BAR_GEOMETRY.HOLD_VENT_MS;

    this._root = null;
    this._grid = null;
    this._mainBtn = null;
    this._titleEl = null;            // .ovr-main-title (static text)
    this._ctaEl = null;              // .ovr-main-cta (write-on-change on expand / collapse)
    this._btns = {};                 // key → button element
    this._models = {};               // key → last applied { text, disabled, pressed }
    this._bar = null;                // #hud-f1-bar root
    this._barBtns = {};              // key → button element
    this._barParts = {};             // key → { name, state } spans
    this._barModels = {};            // key → last applied { name, state, disabled, pressed }
    this._barTickId = null;          // the bar's self-rescheduling refresh (NOT a gag timer)
    this._lastRadiatorTapMs = -Infinity;
    this._hold = null;               // the RADIATORS press in flight: { pointerId, timerId, fired, btn }
    this._swallowClickAtMs = -Infinity;   // > -Infinity while the click after a fired hold is to be swallowed (fire / release time)
    this._lastFurnaceTapMs = -Infinity;
    this._furnacePresses = 0;        // every FURNACE press, bar or grid (the bar's reset checks no press came since)
    this._barFurnacePressNo = -1;    // _furnacePresses right after the bar's last FURNACE press
    this._barFurnaceResetId = null;  // the bar's WARN reset timer
    this._drawerOpen = typeof deps.drawerOpen === 'function' ? deps.drawerOpen : null;
    this._barDrawer = false;         // last applied .f1b-drawer state
    this._rung = null;
    this._unsubs = [];
    this._disposed = false;
    this._expanded = false;
    this._tickId = null;             // the 1 Hz refresh while expanded (NOT a gag timer)
    this._attractTimer = null;       // the reveal blink's removal timer (NOT a gag timer; cleared on dispose / re-reveal)

    this._gagState = 'IDLE';
    this._pressCount = 0;
    this._gagRuns = 0;               // completed runs this session (Houston escalates; never persisted)
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
    this._post = null;               // the POST block inside the veil (goes with it)
    this._recoverSteps = 0;
    this._rebootHandle = null;       // truthy while the systems reboot runs (reboot.play returned true)

    this._onClick = (e) => this._handleClick(e);
    this._onBarClick = (e) => this._handleBarClick(e);
    this._onBarDown = (e) => this._handleBarDown(e);
    this._onBarUp = (e) => this._handleBarUp(e);
    this._onBarMove = (e) => this._handleBarMove(e);
    this._onBarCancel = (e) => this._cancelHold(e);
    this._onBarMenu = (e) => this._handleBarMenu(e);

    this._build(deps.parent);
    this._subscribe();
    if (this._root) this.refresh();
    this._startBarTick();
  }

  /**
   * The pane-density rung adapter (cached; the HUD domRung shape). The ONE visibility bit is `data-density-hidden`
   * on the root; hiding the panel also collapses the grid and aborts any in-flight gag. A REVEAL (hidden → visible)
   * blinks the main button once (`ovr-attract`); `setVisible(true)` on an already-visible root does not.
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
          if (v) {
            const wasHidden = typeof el.hasAttribute === 'function' && el.hasAttribute(DENSITY_HIDDEN_ATTR);
            el.removeAttribute(DENSITY_HIDDEN_ATTR);
            if (wasHidden) this._attract();             // on REVEAL only
          } else {
            this._clearAttract();                        // a hidden button has nothing to blink
            el.setAttribute(DENSITY_HIDDEN_ATTR, '');
          }
        },
      };
    }
    return this._rung;
  }

  /** Re-read the actuators and repaint the labels (write-on-change; never throws). */
  refresh() {
    if (this._disposed || !this._root) return;
    for (const key of OVERRIDE_KEYS) {
      if (key === 'furnace') continue;
      this._applyModel(key, OverridePane.buttonLabel(key, this._readActuator(key)));
    }
    this._refreshBar();
  }

  /** Slide the grid up: resets the gag press count, starts the 1 Hz tick, flips the CTA and sets `body[data-ovr-open]`. */
  expand() {
    if (this._disposed || this._expanded) return;
    this._expanded = true;
    this._pressCount = 0;
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

  toggleExpanded() {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  isExpanded() { return this._expanded; }

  /** @returns {string} one of GAG_STATES */
  gagState() { return this._gagState; }

  /** @returns {number} FURNACE presses in the current session (0 after recovery / abort / expand) */
  pressCount() { return this._pressCount; }

  /** @returns {number} completed gag runs this session (Houston's escalation index; an abort does not reset it) */
  gagRuns() { return this._gagRuns; }

  el() { return this._root; }

  /** @returns {object|null} the F1 bar's root element (`#hud-f1-bar`) */
  barEl() { return this._bar; }

  /**
   * The F key: press FURNACE exactly as the bar's button does (touches no game state). Where the bar is hidden its
   * tick resets a WARN, so a second press may just warn again — accepted.
   */
  pressFurnace() { this._barFurnacePress(); }

  /** Abort the gag, clear every timer, unsubscribe, remove the roots, clear `body[data-ovr-open]`; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._stopTick();
    this._stopBarTick();
    this._cancelHold();
    this._clearAttract();
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
    if (this._bar && typeof this._bar.removeEventListener === 'function') {
      try {
        this._bar.removeEventListener('click', this._onBarClick);
        this._bar.removeEventListener('pointerdown', this._onBarDown);
        this._bar.removeEventListener('pointerup', this._onBarUp);
        this._bar.removeEventListener('pointermove', this._onBarMove);
        this._bar.removeEventListener('pointercancel', this._onBarCancel);
        this._bar.removeEventListener('pointerleave', this._onBarCancel);
        this._bar.removeEventListener('contextmenu', this._onBarMenu);
      } catch (_e) { /* stub */ }
    }
    _removeEl(this._bar);
    this._bar = null;
    this._barBtns = {};
    this._barParts = {};
    this._barModels = {};
    this._root = null;
    this._grid = null;
    this._mainBtn = null;
    this._titleEl = null;
    this._ctaEl = null;
    this._btns = {};
    this._models = {};
    this._timers.clear();
  }

  /** Pure: the title never changes; the cta names the press's effect. */
  static mainLabel(expanded) {
    return { title: MAIN_TITLE, cta: expanded ? CTA_OPEN : CTA_CLOSED };
  }

  /**
   * Pure label law (STATE-first like the REFIT chips). `pressed` = "the hardware is OUT". `null` ⇒ disabled with the
   * honest reason; 'NOT FITTED' ⇒ disabled; any other state passes through uppercased, enabled, unpressed. FURNACE
   * is never disabled (BROKEN, not off). Unknown key ⇒ null.
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

  /**
   * Pure F1-bar label law: plain name + a live state word. `state` is the actuator's `get()` (struts DEPLOYED /
   * STOWED / null; radiator the hub's `flowerDeploy` OPEN / CLOSED / MOVING / NOT FITTED / null; wings FURLED /
   * DEPLOYED / null); `moving` (struts only) = a docked strut is mid-swing. `pressed` = "the hardware is OUT".
   * FURNACE: FAULT, never disabled.
   * @param {string} key one of F1_BAR_KEYS
   * @param {string|null|undefined} state
   * @param {{moving?:boolean}} [opts]
   * @returns {{name:string, state:string, disabled:boolean, pressed:boolean}|null}
   */
  static barLabel(key, state, opts = {}) {
    const name = BAR_NAME_OF[key];
    if (!name) return null;
    if (key === 'furnace') return { name, state: 'FAULT', disabled: false, pressed: false };
    if (state == null) return { name, state: BAR_NULL_STATE[key], disabled: true, pressed: false };
    const s = String(state).toUpperCase();
    if (s === NOT_FITTED) return { name, state: NOT_FITTED, disabled: true, pressed: false };
    if (key === 'struts') {
      if (opts && opts.moving) return { name, state: 'MOVING', disabled: false, pressed: false };
      if (s === 'DEPLOYED') return { name, state: 'OPEN', disabled: false, pressed: true };
      if (s === 'STOWED') return { name, state: 'CLOSED', disabled: false, pressed: false };
    } else if (key === 'wings') {
      if (s === 'DEPLOYED') return { name, state: 'OUT', disabled: false, pressed: true };
      if (s === 'FURLED') return { name, state: 'FURLED', disabled: false, pressed: false };
    } else if (key === 'radiator') {
      if (s === 'OPEN') return { name, state: 'OPEN', disabled: false, pressed: true };
    }
    return { name, state: s, disabled: false, pressed: false };
  }

  /** Inject the style once, build the DOM under `parent` (headless: nothing). */
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
    // Geometry literals live inline (the style sheet carries the look). STATIC placement, written once; nothing
    // feeds it per frame. The root is the 324-wide grid plate's box and takes NO pointer events; the button and the
    // open grid opt in. Never a column child: the hub's F1 callouts dim both side columns to 0.35 + pointer-events:none.
    root.style.position = 'absolute';
    root.style.left = '50%';
    root.style.bottom = `max(${G.BOTTOM_PX}px, env(safe-area-inset-bottom, 0px))`;
    root.style.transform = 'translateX(-50%)';
    root.style.width = `${2 * G.BTN_W_PX + G.GAP_PX + 2 * PAD_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.padding = '0';
    root.style.pointerEvents = 'none';
    root.setAttribute(DENSITY_HIDDEN_ATTR, '');       // hidden by default on EVERY floor
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
    // Title over the cta, both from the pure law; the cta is rewritten on expand / collapse.
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
    this._buildBar(doc, parent);

    this._root = root;
    this._grid = grid;
    this._mainBtn = main;
    this._titleEl = title;
    this._ctaEl = cta;
  }

  /**
   * The F1 bar (DECISIONS §15 row 9): `#hud-f1-bar`, four buttons in a flat row. Built HIDDEN (`data-floor-gone`;
   * FloorMask is its one writer: shown on F1, gone elsewhere and on disengage). Look is injected CSS, no inline style.
   */
  _buildBar(doc, parent) {
    const bar = doc.createElement('div');
    bar.id = F1_BAR_ID;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Mother controls');
    bar.setAttribute(FLOOR_GONE_ATTR, '');
    if (this._glass) bar.setAttribute(GLASS_ATTR, '');
    if (this._reducedMotion()) bar.setAttribute(REDUCED_ATTR, '');
    for (const key of F1_BAR_KEYS) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.setAttribute('type', 'button');
      btn.setAttribute(KEY_ATTR, key);
      btn.className = key === 'furnace' ? 'f1b-btn f1b-furnace' : 'f1b-btn';
      btn.setAttribute('aria-pressed', 'false');
      const name = doc.createElement('span');
      name.className = 'f1b-name';
      const state = doc.createElement('span');
      state.className = 'f1b-state';
      btn.appendChild(name);
      btn.appendChild(state);
      bar.appendChild(btn);
      this._barBtns[key] = btn;
      this._barParts[key] = { name, state };
    }
    if (typeof bar.addEventListener === 'function') {
      bar.addEventListener('click', this._onBarClick);
      // Hold RADIATORS = 180° (touch has no double press: the bar drops quick double taps on purpose).
      bar.addEventListener('pointerdown', this._onBarDown);
      bar.addEventListener('pointerup', this._onBarUp);
      bar.addEventListener('pointermove', this._onBarMove);
      bar.addEventListener('pointercancel', this._onBarCancel);
      bar.addEventListener('pointerleave', this._onBarCancel);
      bar.addEventListener('contextmenu', this._onBarMenu);
    }
    parent.appendChild(bar);
    this._bar = bar;
  }

  /** The cta span follows the grid (write-on-change; title is static). */
  _applyCta(expanded) {
    const el = this._ctaEl;
    if (!el) return;
    const next = OverridePane.mainLabel(!!expanded).cta;
    if (el.textContent !== next) el.textContent = next;
  }

  /** `body[data-ovr-open]`: the sheet hides the hint ticker, toast zone and ARM PILOT strip (same column). Write-on-change. */
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

  /** One <style> per document, idempotent by id. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || typeof doc.head.appendChild !== 'function') return;
    if (typeof doc.getElementById === 'function' && doc.getElementById(OVERRIDE_STYLE_ID)) return;
    const G = OVERRIDE_GEOMETRY;
    const F = FURNACE_GAG;
    const P = `#${OVERRIDE_PANE_ID}`;
    const B = F1_BAR_GEOMETRY;
    const BAR = `#${F1_BAR_ID}`;
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
      /* The big cockpit button: a FIXED 260 x 64 (two lines), centred in the plate's box.
         Gag v2 (2026-09-09, "more tempting"): hazard tape top and bottom (the ::before /
         ::after bands), a live lamp before the title, a deeper hatch and glow — all steady
         CAUTION (the colour law: CAUTION never pulses; the only motion is the one-shot
         reveal blink below). position: relative + overflow: hidden anchor and clip the bands. */
      ${P} .ovr-main {
        position: relative;
        overflow: hidden;
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
        text-shadow: 0 0 8px rgb(var(--hud-caution-rgb, 255 170 0) / 0.45);
        background:
          repeating-linear-gradient(135deg, rgb(var(--hud-caution-rgb, 255 170 0) / 0.18) 0 10px, rgb(var(--hud-ink-rgb, 0 0 0) / 0) 10px 20px),
          rgb(var(--hud-ink-rgb, 20 12 0) / 0.85);
        border: 2px solid ${COLOR_CAUTION};
        border-radius: 4px;
        box-shadow: inset 0 0 0 1px rgb(var(--hud-ink-rgb, 0 0 0) / 0.6), inset 0 0 18px rgb(var(--hud-caution-rgb, 255 170 0) / 0.16);
        transition: background-color 0.15s ease, box-shadow 0.15s ease;
        pointer-events: auto;
      }
      /* Hazard tape: 6 px bands, full width, top and bottom; CAUTION / near-black stripes. */
      ${P} .ovr-main::before, ${P} .ovr-main::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        height: 6px;
        background: repeating-linear-gradient(135deg, ${COLOR_CAUTION} 0 8px, rgb(var(--hud-ink-rgb, 0 0 0) / 0.85) 8px 16px);
        opacity: 0.7;
        pointer-events: none;
      }
      ${P} .ovr-main::before { top: 0; }
      ${P} .ovr-main::after { bottom: 0; }
      ${P} .ovr-main-title {
        font-size: 16px;
        font-weight: 700;
        letter-spacing: 0.16em;
        white-space: nowrap;
      }
      /* The live lamp: a 7 px CAUTION disc before the title (no DOM — a pseudo-element). */
      ${P} .ovr-main-title::before {
        content: '';
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: ${COLOR_CAUTION};
        box-shadow: 0 0 6px ${COLOR_CAUTION};
        margin-right: 8px;
        vertical-align: middle;
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
      ${P} .ovr-main:hover { box-shadow: inset 0 0 0 1px rgb(var(--hud-ink-rgb, 0 0 0) / 0.6), inset 0 0 26px rgb(var(--hud-caution-rgb, 255 170 0) / 0.32); }
      ${P} .ovr-main:hover::before, ${P} .ovr-main:hover::after { opacity: 1; }
      ${P} .ovr-main:active { box-shadow: inset 0 3px 10px rgb(var(--hud-ink-rgb, 0 0 0) / 0.7); }
      ${P}[${OPEN_ATTR}] .ovr-main { border-color: ${COLOR_PLAYER}; color: ${COLOR_PLAYER}; text-shadow: 0 0 8px rgb(var(--hud-normal-rgb, 0 255 136) / 0.45); }
      /* Open: the tape and the lamp turn PLAYER with the button. */
      ${P}[${OPEN_ATTR}] .ovr-main::before, ${P}[${OPEN_ATTR}] .ovr-main::after { background: repeating-linear-gradient(135deg, ${COLOR_PLAYER} 0 8px, rgb(var(--hud-ink-rgb, 0 0 0) / 0.85) 8px 16px); }
      ${P}[${OPEN_ATTR}] .ovr-main-title::before { background: ${COLOR_PLAYER}; box-shadow: 0 0 6px ${COLOR_PLAYER}; }
      /* The one-shot reveal blink (ATTRACT_MS): three blinks, a glow bloom on each return.
         The class lands only on the rung's hidden -> visible edge (see _attract). */
      ${P} .ovr-main.${ATTRACT_CLASS} { animation: ovr-attract ${F.ATTRACT_MS}ms ease-in-out 1; }
      @keyframes ovr-attract {
        0%, 100% { opacity: 1; }
        17%, 50%, 83% { opacity: 0.35; }
        33%, 67% { opacity: 1; box-shadow: inset 0 0 0 1px rgb(var(--hud-ink-rgb, 0 0 0) / 0.6), inset 0 0 26px rgb(var(--hud-caution-rgb, 255 170 0) / 0.32), 0 0 18px rgb(var(--hud-caution-rgb, 255 170 0) / 0.55); }
      }
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
        background: rgb(var(--hud-ink-rgb, 5 10 20) / 0.95);
        border: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.3);
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
        background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.06);
        border: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.35);
        border-radius: 3px;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      ${P} .ovr-btn:hover:not(:disabled) { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.14); }
      ${P} .ovr-btn[aria-pressed="true"] { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.2); border-color: ${COLOR_PLAYER}; }
      ${P} .ovr-btn:disabled { color: ${COLOR_CAUTION}; opacity: 0.55; cursor: not-allowed; border-color: rgb(var(--hud-caution-rgb, 255 170 0) / 0.35); background: rgb(var(--hud-caution-rgb, 255 170 0) / 0.04); }
      /* FURNACE: obviously broken — irregular fritz + amber FAULT */
      ${P} .ovr-furnace {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        color: ${COLOR_CAUTION};
        border-color: rgb(var(--hud-caution-rgb, 255 170 0) / 0.5);
        background: rgb(var(--hud-caution-rgb, 255 170 0) / 0.05);
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
      /* Glass: 44 pt hit boxes (Apple HIG); the main button's fixed 260 x 64 already clears it */
      ${P}[${GLASS_ATTR}] .ovr-btn { min-height: ${G.BTN_GLASS_MIN_PX}px; min-width: ${G.BTN_GLASS_MIN_PX}px; font-size: 13px; }
      ${P}[${GLASS_ATTR}] .ovr-main { min-height: ${G.MAIN_GLASS_MIN_H_PX}px; }
      /* ── The F1 bar (DECISIONS §15 row 9): one flat row at the bottom centre, shown by
         FloorMask on F1 only (data-floor-gone is the one bit). Buttons are touch-sized
         (>= 44 pt; ${B.BTN_H_PX} tall), the root takes no pointer events so a drag beside
         them reaches the canvas. Geometry lives here, never inline. */
      ${BAR}[${FLOOR_GONE_ATTR}] { display: none !important; }
      /* The override pane pulled out on F1 sits at the same spot: the bar lifts above it and the
         hint band (a sibling rule on the root's own bits — no inline style, no JS state); with its
         grid open the bar hides (the grid is the same four buttons). */
      ${P}:not([${DENSITY_HIDDEN_ATTR}]) ~ ${BAR} {
        bottom: max(${B.LIFT_OVER_HINT_PX}px, calc(max(${G.BOTTOM_PX}px, env(safe-area-inset-bottom, 0px)) + ${G.MAIN_H_PX + G.GAP_PX}px));
      }
      ${P}[${OPEN_ATTR}]:not([${DENSITY_HIDDEN_ATTR}]) ~ ${BAR} { visibility: hidden; }
      /* Drawer open: keep the bar right of the drawer + its SPECS tab (wide screens stay centred). */
      ${BAR}.f1b-drawer { left: max(50%, calc(clamp(380px, 28vw, 440px) + ${B.DRAWER_GAP_PX + (4 * B.BTN_W_PX + 3 * B.GAP_PX) / 2}px)); }
      ${BAR} {
        position: absolute;
        left: 50%;
        bottom: max(${B.BOTTOM_PX}px, env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        display: flex;
        flex-direction: row;
        gap: ${B.GAP_PX}px;
        pointer-events: none;
        color: ${COLOR_PLAYER};
      }
      ${BAR} .f1b-btn {
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: ${B.BTN_W_PX}px;
        min-height: ${B.BTN_H_PX}px;
        box-sizing: border-box;
        padding: 4px 6px;
        font-family: var(--font-mono);
        color: ${COLOR_PLAYER};
        background: rgb(var(--hud-ink-rgb, 5 10 20) / 0.82);
        border: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.4);
        border-radius: 4px;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      ${BAR} .f1b-name { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; line-height: 1.1; white-space: nowrap; }
      ${BAR} .f1b-state { font-size: 10px; letter-spacing: 0.1em; line-height: 1.1; white-space: nowrap; opacity: 0.85; }
      ${BAR} .f1b-btn:hover:not(:disabled) { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.16); }
      ${BAR} .f1b-btn:active:not(:disabled) { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.28); }
      ${BAR} .f1b-btn[${HOLDING_ATTR}]:not(:disabled) { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.28); border-color: ${COLOR_PLAYER}; outline: 2px dashed ${COLOR_PLAYER}; outline-offset: -3px; }
      ${BAR} .f1b-btn[aria-pressed="true"] { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.2); border-color: ${COLOR_PLAYER}; }
      ${BAR} .f1b-btn:disabled { color: ${COLOR_CAUTION}; opacity: 0.6; cursor: not-allowed; border-color: rgb(var(--hud-caution-rgb, 255 170 0) / 0.35); }
      ${BAR} .f1b-furnace { color: ${COLOR_CAUTION}; border-color: rgb(var(--hud-caution-rgb, 255 170 0) / 0.5); }
      ${BAR} .f1b-furnace .f1b-state { color: ${COLOR_CAUTION}; letter-spacing: 0.22em; }
      ${BAR}[${GLASS_ATTR}] .f1b-btn { min-height: ${B.BTN_H_PX}px; min-width: ${B.BTN_W_PX}px; }
      ${BAR}[${REDUCED_ATTR}] .f1b-btn { transition: none; }
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
        text-shadow: 0 0 18px rgb(var(--hud-caution-rgb, 255 170 0) / 0.85), 0 0 48px rgb(var(--hud-caution-rgb, 255 170 0) / 0.4);
        padding: 8px 22px;
        border: 3px solid ${COLOR_CAUTION};
        border-radius: 6px;
        background: rgb(var(--hud-ink-rgb, 20 12 0) / 0.72);
      }
      #${OVERRIDE_COUNTDOWN_ID} .ovr-count {
        font-family: var(--font-mono);
        font-size: clamp(180px, 26vh, 320px);
        font-weight: 700;
        line-height: 1;
        margin-top: 12px;
        color: ${COLOR_CAUTION};
        text-shadow: 0 0 32px rgb(var(--hud-caution-rgb, 255 170 0) / 0.9), 0 0 90px rgb(var(--hud-caution-rgb, 255 170 0) / 0.45);
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
        background: rgb(var(--hud-ink-rgb, 20 12 0) / 0.9);
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
      /* The POST screen (gag v2): bottom-left of the veil, mono, PLAYER green, one <div> per line.
         It rides the veil's opacity (the CRT tail flickers the text too) and goes with the veil. */
      #${OVERRIDE_VEIL_ID} .${OVERRIDE_POST_CLASS} {
        position: absolute;
        left: max(24px, env(safe-area-inset-left, 0px));
        bottom: max(24px, env(safe-area-inset-bottom, 0px));
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.5;
        letter-spacing: 0.04em;
        color: ${COLOR_PLAYER};
        opacity: 0.8;
        white-space: pre;
        text-align: left;
        pointer-events: none;
      }
      /* Reduced motion: no slide, no fritz (steady dim + FAULT), no shake / pulse / flicker, no reveal blink */
      ${P}[${REDUCED_ATTR}], ${P}[${REDUCED_ATTR}] .ovr-grid { transition: none; }
      ${P}[${REDUCED_ATTR}] .ovr-furnace { animation: none; opacity: 0.55; }
      ${P}[${REDUCED_ATTR}] .${ATTRACT_CLASS} { animation: none; }
      @media (prefers-reduced-motion: reduce) {
        ${BAR} .f1b-btn { transition: none; }
        ${P}, ${P} .ovr-grid { transition: none; }
        ${P} .ovr-furnace { animation: none; opacity: 0.55; }
        ${P} .${ATTRACT_CLASS}, .${PULSE_CLASS}, .${SHAKE_CLASS}, .${JITTER_CLASS}, #${OVERRIDE_VEIL_ID}.${CRT_CLASS}, #${OVERRIDE_COUNTDOWN_ID} .ovr-count, #${OVERRIDE_COUNTDOWN_ID} .ovr-warn { animation: none !important; }
      }
    `;
    doc.head.appendChild(style);
  }

  /** Subscribe to the actuator input/pose events (refresh) + the abort events. */
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

  /** The actuator's `get()`, null on absence / throw. */
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

  /** Write one button's model, write-on-change. */
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

  /** The ONE delegated click: main / a real actuator / FURNACE. */
  _handleClick(e) {
    if (this._disposed) return;
    const btn = _closestKey(e && e.target);
    if (!btn) return;
    const key = btn.getAttribute(KEY_ATTR);
    if (key === 'main') {
      this._click();
      this.toggleExpanded();
      return;
    }
    if (key === 'furnace') { this._furnacePress(); return; }
    if (!ACTUATOR_OF[key]) return;
    const model = this._models[key] || OverridePane.buttonLabel(key, this._readActuator(key));
    if (!model || model.disabled) return;
    const a = this._actuators && this._actuators[ACTUATOR_OF[key]];
    if (a && typeof a.toggle === 'function') {
      // The closure owns the click + the input event (no double blip).
      try { a.toggle(); } catch (_e) { /* dep */ }
    }
    this.refresh();                                       // re-read truth, never an optimistic flip
  }

  /** The struts' mid-swing flag (the actuator's optional `moving()`); false on absence / throw. */
  _strutsMoving() {
    const a = this._actuators && this._actuators.struts;
    if (!a || typeof a.moving !== 'function') return false;
    try { return !!a.moving(); } catch (_e) { return false; }
  }

  /** The bar's label model for `key`, from the live actuators. */
  _barModel(key) {
    if (key === 'furnace') return OverridePane.barLabel(key, null);
    const a = this._actuators && this._actuators[BAR_ACTUATOR_OF[key]];
    let state = null;
    if (a && typeof a.get === 'function') {
      try { state = a.get(); } catch (_e) { state = null; }
    }
    return OverridePane.barLabel(key, state, key === 'struts' ? { moving: this._strutsMoving() } : undefined);
  }

  /** Re-read the actuators and repaint the bar (write-on-change; never throws). */
  _refreshBar() {
    if (this._disposed || !this._bar) return;
    for (const key of F1_BAR_KEYS) this._applyBarModel(key, this._barModel(key));
  }

  /** Write one bar button's model, write-on-change (two spans; the button is never re-textContent'd). */
  _applyBarModel(key, model) {
    const btn = this._barBtns[key];
    const parts = this._barParts[key];
    if (!btn || !parts || !model) return;
    const prev = this._barModels[key];
    if (prev && prev.name === model.name && prev.state === model.state
      && prev.disabled === model.disabled && prev.pressed === model.pressed) return;
    if (!prev || prev.name !== model.name) parts.name.textContent = model.name;
    if (!prev || prev.state !== model.state) parts.state.textContent = model.state;
    if (!prev || prev.state !== model.state || prev.name !== model.name) btn.setAttribute('aria-label', `${model.name} ${model.state}`);
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
    this._barModels[key] = model;
  }

  /**
   * The bar's ONE delegated click. FURNACE is the joke; the others call the actuator's `toggle()` and re-read truth.
   * RADIATOR drops a tap inside `tapDebounceMs` of the last one: `player.toggleFlowerDeploy` reads two taps inside
   * VENT_DOUBLE_TAP_MS as the push-through VENT, which a touch double-tap must never do. Every tap blurs the button
   * first, so Enter never re-presses it.
   */
  _handleBarClick(e) {
    if (this._disposed) return;
    const btn = _closestKey(e && e.target);
    if (!btn) return;
    // A focused button would be re-pressed by the next Enter (InputManager's Enter does not preventDefault).
    try { if (typeof btn.blur === 'function') btn.blur(); } catch (_e) { /* stub */ }
    const key = btn.getAttribute(KEY_ATTR);
    if (key === 'furnace') { this._barFurnacePress(); return; }
    if (!BAR_ACTUATOR_OF[key]) return;
    const model = this._barModels[key] || this._barModel(key);
    if (!model || model.disabled) return;
    if (key === 'radiator') {
      const now = this._now();
      // The click that follows the release of a hold (180° already sent) is not a tap: swallow it once.
      if (this._swallowClickAtMs > -Infinity) {
        const fresh = now - this._swallowClickAtMs < F1_BAR_GEOMETRY.HOLD_SWALLOW_MS;
        this._swallowClickAtMs = -Infinity;
        if (fresh) return;
      }
      if (now - this._lastRadiatorTapMs < this._tapDebounceMs) return;
      this._lastRadiatorTapMs = now;
    }
    const a = this._actuators && this._actuators[BAR_ACTUATOR_OF[key]];
    if (a && typeof a.toggle === 'function') {
      try { a.toggle(); } catch (_e) { /* dep */ }
    }
    this._refreshBar();                                   // re-read truth, never an optimistic flip
  }

  /**
   * A press on RADIATORS starts the hold clock (any pointer: finger or mouse). Held `_holdMs` it sends 180°
   * once (`flowerDeploy.vent()`); released earlier it is an ordinary tap (the click toggles as before). A new press
   * ends any old swallow flag, so a long press that sent no click never eats the next real tap.
   */
  _handleBarDown(e) {
    if (this._disposed || !e) return;
    const btn = _closestKey(e.target);
    if (!btn || btn.getAttribute(KEY_ATTR) !== 'radiator') return;
    this._swallowClickAtMs = -Infinity;
    this._cancelHold();
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    const fl = this._actuators && this._actuators[BAR_ACTUATOR_OF.radiator];
    if (!fl || typeof fl.vent !== 'function' || typeof this._setTimeoutFn !== 'function') return;
    const model = this._barModels.radiator || this._barModel('radiator');
    if (!model || model.disabled) return;
    const hold = { pointerId: e.pointerId, timerId: null, fired: false, btn };
    this._hold = hold;
    try { btn.setAttribute(HOLDING_ATTR, ''); } catch (_e) { /* stub */ }
    const f = this._setTimeoutFn;
    hold.timerId = f(() => this._fireHold(hold), this._holdMs);
  }

  /** The hold reached `_holdMs` with the finger still on the button: send 180°, stamp the tap debounce. */
  _fireHold(hold) {
    if (this._disposed || this._hold !== hold || hold.fired) return;
    // A floor change (FloorMask hides the bar) while the finger is down: the press belongs to a bar that is gone.
    if (this._barGone()) { this._cancelHold(); return; }
    hold.fired = true;
    hold.timerId = null;
    const now = this._now();
    this._lastRadiatorTapMs = now;
    this._swallowClickAtMs = now;
    try { hold.btn.removeAttribute(HOLDING_ATTR); } catch (_e) { /* stub */ }
    const a = this._actuators && this._actuators[BAR_ACTUATOR_OF.radiator];
    if (a && typeof a.vent === 'function') {
      try { a.vent(); } catch (_e) { /* dep */ }
    }
    this._refreshBar();
  }

  /** Release: a fired hold re-stamps the swallow clock (the click arrives just after); an early release is a plain tap. */
  _handleBarUp(e) {
    const hold = this._hold;
    if (!hold) return;
    if (e && hold.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== hold.pointerId) return;
    if (hold.fired) this._swallowClickAtMs = this._now();
    this._cancelHold(null, true);
  }

  /** Sliding off the button (touch keeps the pointer captured, so no leave event fires) ends the hold, unfired. */
  _handleBarMove(e) {
    const hold = this._hold;
    if (!hold || hold.fired || !e) return;
    if (e.pointerId !== undefined && hold.pointerId !== undefined && e.pointerId !== hold.pointerId) return;
    const btn = hold.btn;
    if (!btn || typeof btn.getBoundingClientRect !== 'function') return;
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    const r = btn.getBoundingClientRect();
    if (!r || !(r.width > 0)) return;
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this._cancelHold();
  }

  /**
   * End the hold in flight: clear its timer and the holding look. A cancelled or slid-off press does nothing
   * (a fired hold has already sent 180°; its swallow flag stays until the click, the next press or 1 s).
   * @param {*} [_e] event arg (unused; lets this be a listener)
   * @param {boolean} [released] true from pointerup
   */
  _cancelHold(_e, released) {
    const hold = this._hold;
    if (!hold) return;
    if (!released && hold.fired) { this._hold = null; return; }   // a leave / cancel after the send: nothing left to undo
    this._hold = null;
    if (hold.timerId !== null && typeof this._clearTimeoutFn === 'function') {
      const c = this._clearTimeoutFn;
      try { c(hold.timerId); } catch (_e2) { /* stub */ }
    }
    hold.timerId = null;
    try { hold.btn.removeAttribute(HOLDING_ATTR); } catch (_e2) { /* stub */ }
  }

  /** No iPad long-press menu (and no text selection) on RADIATORS: the hold is ours. */
  _handleBarMenu(e) {
    const btn = e && _closestKey(e.target);
    if (btn && btn.getAttribute(KEY_ATTR) === 'radiator' && typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * FURNACE from the bar: the same two-press joke (no expand/collapse resets the count). A tap inside
   * `tapDebounceMs` of the last one counts once; a WARN left FURNACE_RESET_MS, or the bar hidden, goes back to IDLE.
   */
  _barFurnacePress() {
    const now = this._now();
    if (now - this._lastFurnaceTapMs < this._tapDebounceMs) return;
    this._lastFurnaceTapMs = now;
    this._furnacePress();
    this._barFurnacePressNo = this._furnacePresses;
    if (this._barFurnaceResetId != null) this._clearTimer(this._barFurnaceResetId);
    this._barFurnaceResetId = this._gagState === 'WARN'
      ? this._schedule(() => { this._barFurnaceResetId = null; this._resetBarFurnaceWarn(); }, F1_BAR_GEOMETRY.FURNACE_RESET_MS)
      : null;
  }

  /** Back to IDLE from a WARN the BAR started, when no FURNACE press came since (a grid WARN keeps its no-timeout law). */
  _resetBarFurnaceWarn() {
    if (this._gagState !== 'WARN' || this._furnacePresses !== this._barFurnacePressNo) return;
    this._gagState = 'IDLE';
    this._pressCount = 0;
  }

  /** `.f1b-drawer` on the bar while the workbench drawer is open (write-on-change; a cheap bool read). */
  _syncBarDrawer() {
    if (!this._bar || !this._drawerOpen) return;
    let open = false;
    try { open = !!this._drawerOpen(); } catch (_e) { open = false; }
    if (open === this._barDrawer) return;
    this._barDrawer = open;
    if (open) _addClass(this._bar, 'f1b-drawer');
    else _removeClass(this._bar, 'f1b-drawer');
  }

  /** True while FloorMask hides the bar (a floor change, or the bar gone on this floor). */
  _barGone() {
    return !!this._bar && typeof this._bar.hasAttribute === 'function' && this._bar.hasAttribute(FLOOR_GONE_ATTR);
  }

  /** The bar's live refresh: self-rescheduling; the actuator re-read is skipped while the mask hides the bar. */
  _startBarTick() {
    this._stopBarTick();
    if (!this._barTickOn || !this._bar || !this._setTimeoutFn || this._disposed) return;
    const setTimer = this._setTimeoutFn;                  // detached call (see the constructor)
    try {
      this._barTickId = setTimer(() => {
        this._barTickId = null;
        if (this._disposed || !this._bar) return;
        const gone = this._barGone();
        if (gone) this._cancelHold();                     // a press in flight on a bar that just went (floor change)
        this._syncBarDrawer();
        if (!gone) this._refreshBar();
        else this._resetBarFurnaceWarn();                 // the bar hidden: the joke starts over next time
        this._startBarTick();
      }, F1_BAR_GEOMETRY.TICK_MS);
    } catch (_e) {
      this._barTickId = null;
    }
  }

  _stopBarTick() {
    if (this._barTickId != null) {
      this._clearTimer(this._barTickId);
      this._barTickId = null;
    }
  }

  /** The 1 Hz label refresh while expanded (labels follow the hotkeys). */
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

  _stopTick() {
    if (this._tickId != null) {
      this._clearTimer(this._tickId);
      this._tickId = null;
    }
  }

  /**
   * The one-shot reveal blink: `.ovr-main` wears `ovr-attract` for ATTRACT_MS, removed by a tracked timer. Called
   * ONLY from the rung's hidden → visible edge. Reduced motion skips the class. A second reveal restarts it.
   */
  _attract() {
    const btn = this._mainBtn;
    if (this._disposed || !btn) return;
    this._clearAttract();
    if (this._reducedMotion()) return;
    _addClass(btn, ATTRACT_CLASS);
    if (!this._setTimeoutFn) return;
    const setTimer = this._setTimeoutFn;                  // detached call (see the constructor)
    try {
      this._attractTimer = setTimer(() => {
        this._attractTimer = null;
        _removeClass(this._mainBtn, ATTRACT_CLASS);
      }, FURNACE_GAG.ATTRACT_MS);
    } catch (_e) {
      this._attractTimer = null;
    }
  }

  /** Drop the blink and its timer (dispose, a hide, a re-reveal). Idempotent. */
  _clearAttract() {
    if (this._attractTimer != null) {
      this._clearTimer(this._attractTimer);
      this._attractTimer = null;
    }
    _removeClass(this._mainBtn, ATTRACT_CLASS);
  }

  /** Press 1 → WARN, press 2 (PRESSES_TO_ARM) → OVERHEAT → (timer) COUNTDOWN; beyond WARN a press is ignored (ONE gag). */
  _furnacePress() {
    if (this._disposed) return;
    const s = this._gagState;
    if (s === 'OVERHEAT' || s === 'COUNTDOWN' || s === 'BLACKOUT' || s === 'RECOVER') return;
    this._furnacePresses += 1;
    this._pressCount += 1;
    if (this._pressCount < FURNACE_GAG.PRESSES_TO_ARM) this._warn();
    else this._overheat();
  }

  /** The rejection: klaxon, haptic, THREAT pulse, shake, "Do NOT press that again." */
  _warn() {
    this._gagState = 'WARN';
    this._klaxon(FURNACE_GAG.KLAXON_S);
    this._vibrate(200);
    this._showVignette(true, FURNACE_GAG.VIGNETTE_MS);
    this._shake(FURNACE_GAG.SHAKE_MS);
    this._comm(FURNACE_LINES.WARN);
  }

  /**
   * The overheat beat (owner: "furnace overheating, containment failing"): the same alarm again, then OVERHEAT_MS
   * later the countdown. The klaxon is single-instance: ignored while press 1's still sounds.
   */
  _overheat() {
    this._gagState = 'OVERHEAT';
    this._klaxon(FURNACE_GAG.KLAXON_S);
    this._vibrate(200);
    this._showVignette(true, FURNACE_GAG.OVERHEAT_MS);
    this._shake(FURNACE_GAG.SHAKE_MS);
    this._comm(FURNACE_LINES.OVERHEAT);
    this._schedule(() => this._enterCountdown(), FURNACE_GAG.OVERHEAT_MS);
  }

  _enterCountdown() {
    this._gagState = 'COUNTDOWN';
    this._comm(FURNACE_LINES.ARMED);
    this._lastCancelMs = -Infinity;
    this._count = FURNACE_GAG.COUNTDOWN_FROM;
    this._showCountdown();
    this._schedule(() => this._countdownTick(), FURNACE_GAG.COUNTDOWN_STEP_MS);
  }

  /**
   * 5 → 1: each numeral change ticks the injected click (the initial "5" does not; the ARMED line is its beat); the
   * tick after "1" → BLACKOUT.
   */
  _countdownTick() {
    if (this._gagState !== 'COUNTDOWN') return;
    this._count -= 1;
    if (this._count >= 1) {
      if (this._countNum) this._countNum.textContent = String(this._count);
      this._click();
      this._schedule(() => this._countdownTick(), FURNACE_GAG.COUNTDOWN_STEP_MS);
      return;
    }
    this._enterBlackout();
  }

  /**
   * "Took a hit": the collision rumble, a longer haptic, then the veil (never under webdriver). Five seconds of pure
   * black, then POST lines one per POST_LINE_MS from POST_START_MS (T+5000 … T+9050); the CRT tail flickers the veil
   * (POST text included) from T+8500; RECOVER at T+10000. No veil ⇒ no POST, no CRT; the recover timer still runs.
   */
  _enterBlackout() {
    this._gagState = 'BLACKOUT';
    this._removeCountdown();
    this._thud();
    this._vibrate(300);
    if (!this._webdriver) this._showVeil();
    if (this._veil) {
      for (let i = 0; i < POST_LINES.length; i++) {
        this._schedule(() => this._postLine(i), FURNACE_GAG.POST_START_MS + i * FURNACE_GAG.POST_LINE_MS);
      }
      if (!this._reducedMotion()) {
        this._schedule(() => { if (this._veil) _addClass(this._veil, CRT_CLASS); },
          FURNACE_GAG.BLACKOUT_MS - FURNACE_GAG.CRT_TAIL_MS);
      }
    }
    this._schedule(() => this._enterRecover(), FURNACE_GAG.BLACKOUT_MS);
  }

  /** One POST line: its own <div> (textContent, never innerHTML) in `.ovr-post` inside the veil (built on the first line). */
  _postLine(i) {
    const veil = this._veil;
    if (!veil || this._gagState !== 'BLACKOUT') return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || typeof veil.appendChild !== 'function') return;
    let post = this._post;
    if (!post) {
      post = doc.createElement('div');
      post.className = OVERRIDE_POST_CLASS;
      veil.appendChild(post);
      this._post = post;
    }
    const text = POST_LINES[i];
    if (typeof text !== 'string') return;
    const line = doc.createElement('div');
    line.textContent = text;
    post.appendChild(line);
  }

  /**
   * RECOVER. No veil (webdriver) or reduced motion ⇒ finish at once (the reboot is never asked). Otherwise FIRST
   * `reboot.play({ onDone })` darkens every visible HUD element under the veil, THEN the three veil flickers, then
   * the veil goes (world visible, instruments dead); the choreography returns them top → bottom and calls `onDone` →
   * `_finishRecover()`. A missing dep or a `false` return falls back to the flickers → `_finishRecover()` at once.
   */
  _enterRecover() {
    this._gagState = 'RECOVER';
    if (!this._veil || this._reducedMotion()) { this._finishRecover(); return; }
    this._rebootHandle = null;
    const reboot = this._reboot;
    if (reboot && typeof reboot.play === 'function') {
      this._rebootHandle = reboot;                        // armed BEFORE the call: a synchronous onDone must find it
      let ok = false;
      try { ok = reboot.play({ onDone: () => this._finishRecover() }) === true; } catch (_e) { ok = false; }
      if (!ok || this._gagState !== 'RECOVER') this._rebootHandle = null;   // false / threw / already finished
    }
    this._recoverSteps = FURNACE_GAG.RECOVER_FLICKERS * 2;
    this._recoverFlicker();
  }

  /** The three rapid flickers, then the veil goes. */
  _recoverFlicker() {
    const veil = this._veil;
    if (!veil) { this._afterFlickers(); return; }
    if (this._recoverSteps % 2 === 0) veil.setAttribute(FLICKER_ATTR, '');
    else veil.removeAttribute(FLICKER_ATTR);
    this._recoverSteps -= 1;
    if (this._recoverSteps <= 0) { this._afterFlickers(); return; }
    this._schedule(() => this._recoverFlicker(), FURNACE_GAG.RECOVER_FLICKER_MS);
  }

  /** With the reboot running, lift the veil onto the dark instruments and WAIT for its `onDone`; otherwise finish now. */
  _afterFlickers() {
    if (this._rebootHandle) { this._removeVeil(); return; }
    this._finishRecover();
  }

  /**
   * The end of a run: veil off, run counted, Houston scheduled HOUSTON_DELAY_MS later (a tracked gag timer that
   * outlives IDLE on purpose; an abort clears it), press count 0, IDLE at once. Only from RECOVER: a late `onDone`
   * after an abort is dropped.
   */
  _finishRecover() {
    if (this._gagState !== 'RECOVER') return;
    this._rebootHandle = null;
    this._removeVeil();
    this._gagRuns += 1;
    const text = HOUSTON_LINES[Math.min(this._gagRuns - 1, HOUSTON_LINES.length - 1)];
    this._schedule(() => this._commHouston(text), FURNACE_GAG.HOUSTON_DELAY_MS);
    this._pressCount = 0;
    this._gagState = 'IDLE';
  }

  /** The broken CANCEL: jitters, never cancels, one caution line per CANCEL_RATE_MS. */
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
   * Abort + dispose the gag at once (GAME_STATE_CHANGE away from gameplay, GAME_RESET, the rung hiding the panel,
   * collapse, dispose). Cancels the systems reboot too (no dark panel left behind) and drops the pending Houston
   * line. `_gagRuns` is NOT reset (the session counter). Idempotent.
   */
  _abortGag() {
    for (const id of this._timers) this._clearTimer(id);
    this._timers.clear();
    this._vignetteTimer = null;
    this._cancelReboot();
    this._removeVeil();
    this._removeCountdown();
    this._removeVignette();
    this._unshake();
    try { if (this._audio && typeof this._audio.stopKlaxon === 'function') this._audio.stopKlaxon(); } catch (_e) { /* audio */ }
    this._gagState = 'IDLE';
    this._pressCount = 0;
    this._recoverSteps = 0;
  }

  /** `reboot.cancel?.()` (guarded) + forget the handle. */
  _cancelReboot() {
    const reboot = this._reboot;
    try {
      if (reboot && typeof reboot.cancel === 'function') reboot.cancel();
    } catch (_e) { /* dep */ }
    this._rebootHandle = null;
  }

  /**
   * A GAME_STATE_CHANGE away from gameplay (shop / pause / menu / end screens) aborts the gag AND collapses the grid
   * (which clears `body[data-ovr-open]`, so the ticker / toast zone / ARM PILOT strip are never left hidden).
   * A change TO a gameplay state keeps the grid as it was.
   */
  _onStateChange(payload) {
    const to = payload && payload.to;
    const list = this._gameplayStates;
    if (!list || list.length === 0 || !list.includes(to)) {
      this._abortGag();
      this.collapse();
    }
  }

  _canBody() {
    const d = this._doc;
    return !!(d && typeof d.createElement === 'function' && d.body && typeof d.body.appendChild === 'function');
  }

  _byId(id) {
    const d = this._doc;
    return (d && typeof d.getElementById === 'function') ? d.getElementById(id) : null;
  }

  /** The THREAT vignette (the one pulsing colour) for WARN and OVERHEAT; removed after `ms`. */
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

  _removeVignette() {
    _removeEl(this._vignette);
    this._vignette = null;
  }

  /** CSS shake on the HUD overlay + the render canvas (the haptic on glass); skipped under reduced motion. */
  _shake(ms) {
    if (this._reducedMotion()) return;
    const els = [this._byId('hud-overlay'), this._byId('game-canvas')].filter(Boolean);
    if (!els.length) return;
    this._unshake();
    for (const el of els) _addClass(el, SHAKE_CLASS);
    this._shaken = els;
    this._schedule(() => this._unshake(), ms);
  }

  _unshake() {
    for (const el of this._shaken) _removeClass(el, SHAKE_CLASS);
    this._shaken = [];
  }

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

  _removeCountdown() {
    _removeEl(this._countdown);
    this._countdown = null;
    this._countNum = null;
    this._cancelBtn = null;
  }

  /** The black veil: above the pause overlay, swallows POINTER events only (no key trap, so Esc still pauses). */
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
    veil.style.background = '#000'; // pure black in BOTH looks, not an ink tint
    veil.style.zIndex = String(Z_VEIL);
    veil.style.pointerEvents = 'auto';
    doc.body.appendChild(veil);
    this._veil = veil;
  }

  _removeVeil() {
    _removeEl(this._veil);
    this._veil = null;
    this._post = null;
  }

  /** A gag timer, tracked in the Set so abort clears it. Returns the id (null headless). */
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

  _clearTimer(id) {
    if (id == null || !this._clearTimeoutFn) return;
    const clearTimer = this._clearTimeoutFn;              // detached call (see the constructor)
    try { clearTimer(id); } catch (_e) { /* timer */ }
  }

  /**
   * The FURNACE's comms line. `_reactive: true` is the CommsSystem guidance arbiter's bypass for feedback to a key
   * the player JUST pressed; without it the onboarding tiers (commsSuppression tier 0–2) mute the gag and the button
   * reads as dead instead of broken. The texts lead with WARNING:/CAUTION:/CRITICAL: on purpose (the ALERT-channel
   * heuristic, sourceToChannel), so they never queue as flavor.
   */
  _comm(line) {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.emit !== 'function' || !E || !E.COMMS_MESSAGE || !line) return;
    try {
      bus.emit(E.COMMS_MESSAGE, { sender: FURNACE_SENDER, text: line.text, priority: line.priority, _reactive: true });
    } catch (_e) { /* bus */ }
  }

  /**
   * Houston's line: `source` + `channel` HOUSTON, priority `info` (green; a `WARNING:` prefix would re-route it to
   * ALERT), `_reactive: true` (same bypass as the FURNACE lines), `link: HOUSTON_LINK` so CommsPanel renders
   * "manual" as the SPECS deep link.
   */
  _commHouston(text) {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.emit !== 'function' || !E || !E.COMMS_MESSAGE || !text) return;
    try {
      bus.emit(E.COMMS_MESSAGE, { source: HOUSTON_SOURCE, channel: HOUSTON_SOURCE, text, priority: 'info', _reactive: true, link: HOUSTON_LINK });
    } catch (_e) { /* bus */ }
  }

  _klaxon(durationS) {
    try {
      if (this._audio && typeof this._audio.playKlaxon === 'function') this._audio.playKlaxon(durationS);
    } catch (_e) { /* audio */ }
  }

  _click() {
    try {
      if (this._audio && typeof this._audio.playClick === 'function') this._audio.playClick();
    } catch (_e) { /* audio */ }
  }

  _thud() {
    try {
      if (this._audio && typeof this._audio.playCollision === 'function') this._audio.playCollision();
    } catch (_e) { /* audio */ }
  }

  /** iPadOS Safari has no Vibration API: the shake IS the haptic there. */
  _vibrate(ms) {
    try {
      if (typeof navigator !== 'undefined' && navigator && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
    } catch (_e) { /* nav */ }
  }

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
