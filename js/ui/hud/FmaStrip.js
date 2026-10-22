/**
 * FmaStrip.js — the COPILOT flight-mode annunciator (Session M, 2026-09-06).
 *
 * One 28 px line under the left column's panes that says what the autopilot
 * is doing, the aviation FMA way: `AP OFF` (dim) when it has nothing, `AP ·
 * AIMING` while an aim-before-launch attitude sequence owns the nose (and the
 * AP is off — engaged wins: the numbers keep flowing through a short aim), and
 * the four fixed segments `AP · <PHASE> · <range> · <closing>` while engaged. A
 * PHASE change is BOXED (1 px border in the strip's text colour) for 10 s,
 * measured on the `nowMs` the hub passes — no timers of its own.
 *
 * It POLLS: `update(nowMs)` self-throttles to <= 1 Hz, reads `deps.fma()` (the
 * hub passes `() => autopilotSystem.fmaState()`), and writes on change only.
 * The CLOSING rate is the SIGNED range rate from successive 1 Hz range samples
 * (negative = closing), smoothed by an EMA (0.85 old / 0.15 new, seeded on the
 * first rate) and shown as `—` until two samples exist. On a phase change it
 * calls `deps.onPhaseChange(prevPhase, nextPhase, state)` if provided — the
 * hub connects that to the CopilotVoice. It emits NOTHING on the bus.
 *
 * It is a pane-density RUNG like CargoPane: `rung()` returns the HUD domRung
 * shape ({id:'copilot', label:'Autopilot', isVisible, setVisible}) whose ONE
 * visibility bit is `data-density-hidden` on the root (HUD.js carries the
 * global `[data-density-hidden]{display:none !important}`; the injected style
 * carries the id-scoped belt). Never emits HUD_PANE_VISIBILITY.
 *
 * HOME: the LAST child of `#hud-left-column` (deps.parent default), inheriting
 * the column's 260 px width; `position: relative` inline like the column's
 * other panes (the .hud-panel class says absolute). Display-only: NO tap
 * action, so no 44 pt rule; `user-select: none`; pointer-events none.
 *
 * Laws: DOM fonts through var(--font-mono) only; tabular numerals; no
 * pictographic glyph (· — − are Latin-1 / General Punctuation / Math
 * Operators); no floor name; no layout reads on the hot path (isVisible's
 * getClientRects is the domRung contract, called at event time); no timers, no
 * rAF, no window/document listeners; never reads Constants.LADDER; never
 * touches the DOM at import time; constructible headless (no document ⇒ every
 * method callable, nothing thrown).
 *
 * @module ui/hud/FmaStrip
 */

import { VisualLaw } from '../../core/VisualLaw.js';
import { PANE_CORNER_PX, HUD_COLUMN_WIDTH_PX } from '../RailGeometry.js';
import { DENSITY_MOTION_MS, DENSITY_MOTION_EASING } from '../HUD.js';
import { shortTypeName } from './TargetPanel.js';

/** The root element id (FloorMask MASK_PANES.copilot.els = ['#hud-fma-strip']). */
export const FMA_STRIP_ID = 'hud-fma-strip';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const FMA_STYLE_ID = 'fma-strip-style';

/** The pane-density rung id (FloorMask MASK_PANES.copilot.rung). */
export const FMA_RUNG_ID = 'copilot';

/** The column the strip rides in (its LAST child). */
export const FMA_PARENT_ID = 'hud-overlay';

/**
 * FMA_GEOMETRY — the strip's numbers. HEIGHT_PX is the outer height (display
 * only: no tap target, so no 44 pt rule). POLL_MS is the self-throttle floor
 * (<= 1 Hz). BOX_MS is how long a changed PHASE word wears its box. EMA_KEEP /
 * EMA_NEW smooth the range rate (old / new weights).
 */
export const FMA_GEOMETRY = Object.freeze({
  HEIGHT_PX: 28,
  FONT_PX: 11,
  POLL_MS: 1000,
  BOX_MS: 10000,
  EMA_KEEP: 0.85,
  EMA_NEW: 0.15,
});

/** AutopilotSystem PHASE key → the annunciated word. */
export const PHASE_LABELS = Object.freeze({
  OFF: 'OFF',
  RENDEZVOUS_FAR: 'RENDEZVOUS (FAR)',
  MATCH_ORBIT: 'MATCH ORBIT',
  TRAIL_ALIGN: 'TRAIL ALIGN',
  HOLD: 'HOLD',
  TRANSFER: 'TRANSFER',   // trip-melt D8: the burn to the next field (AutopilotSystem.holdPrograde)
});

/** The word shown while an aim sequence owns the nose and the AP is off. */
export const AIMING_LABEL = 'AIMING';

/** The closing placeholder until two range samples exist. */
export const NO_RATE = '\u2014';                 // —

/** The rung's ONE hide bit (HUD._initPaneDensity domRung grammar). */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
/** Layout-hidden (LeftStack): display:none via the strip's own style — never the density bit. */
const STACK_HIDDEN_ATTR = 'data-stack-hidden';
/** off | aiming | engaged — drives the dim rule and which segments show. */
const MODE_ATTR = 'data-fma-mode';
/** The PHASE segment's 10 s box. */
const BOXED_ATTR = 'data-boxed';
/** A segment (or separator) folded away in the off / aiming forms. */
const SEG_HIDDEN_ATTR = 'data-fma-hidden';
/** u5 D2: the autopilot is flying on floor 2 - the strip shows there although the room hides it. */
export const FLYING_ATTR = 'data-ap-flying';
/** u5 D2: the plain-words line (floor 2, simple level): no small-caps, no PHASE / numbers segments. */
const PLAIN_ATTR = 'data-fma-plain';

/** The FmaStrip floor on which the flying rule and the plain line apply (the home floor). */
const HOME_FLOOR = 2;

const MINUS = '\u2212';                          // − (Math Operators, allowed)
const DOT = '\u00b7';                            // · (Latin-1, allowed)

/**
 * Range text: `412 m` below 1 km, `1.4 km` below 10 km, `12 km` / `1235 km`
 * beyond (the strip is 260 px wide; the integer tier keeps the far line on
 * one row). Non-finite ⇒ the placeholder.
 * @param {number|null} m
 * @returns {string}
 */
export function fmtRange(m) {
  if (m == null) return NO_RATE;
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return NO_RATE;
  if (Math.round(n) < 1000) return `${Math.round(n)} m`;
  const km = n / 1000;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/**
 * Closing text: the SIGNED range rate, sign always shown (`−0.4 m/s`,
 * `+0.4 m/s`; a rounded zero reads `+0.0 m/s`), one decimal below 10 m/s and
 * an integer beyond. Non-finite ⇒ `—`. Negative = closing.
 * @param {number|null} mps
 * @returns {string}
 */
export function fmtClosing(mps) {
  if (mps == null) return NO_RATE;
  const n = Number(mps);
  if (!Number.isFinite(n)) return NO_RATE;
  const abs = Math.abs(n);
  const body = abs < 10 ? abs.toFixed(1) : String(Math.round(abs));
  const zero = Number(body) === 0;
  const sign = (n < 0 && !zero) ? MINUS : '+';
  return `${sign}${body} m/s`;
}

export class FmaStrip {
  /**
   * @param {object} [deps]
   * @param {Document|null} [deps.doc]  document (default: the global one; null = headless).
    * @param {Element}  [deps.parent]     root's parent (default: doc.getElementById('hud-overlay')).
   * @param {function} [deps.now]        ms clock — used only when update() is called without nowMs.
   * @param {function} [deps.fma]        () → AutopilotSystem.fmaState() shape. Absent ⇒ `AP OFF`.
   * @param {function} [deps.onPhaseChange] (prevPhase, nextPhase, state) on every AP phase change after the first sample.
   * @param {function} [deps.floor]      () → the applied floor id (u5 D2: the flying rule and the plain line are floor 2's). Absent ⇒ null.
   * @param {function} [deps.simple]     () → true at the simple level (u5 D2: HUD.isSimpleTargets). Absent ⇒ false.
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._fma = typeof deps.fma === 'function' ? deps.fma : null;
    this._onPhaseChange = typeof deps.onPhaseChange === 'function' ? deps.onPhaseChange : null;
    this._floorFn = typeof deps.floor === 'function' ? deps.floor : null;
    this._simpleFn = typeof deps.simple === 'function' ? deps.simple : null;

    this._root = null;
    this._el = null;                 // { ap, sep1, phase, sep2, range, sep3, closing }
    this._rung = null;
    this._disposed = false;

    // The model (write-on-change against these).
    this._lastMs = null;             // last accepted poll time
    this._phase = null;              // raw AP phase key (null until the first sample)
    this._word = null;               // the displayed PHASE word
    this._mode = null;               // 'off' | 'aiming' | 'engaged'
    this._boxedAt = null;            // nowMs the current box was set (null = no box)
    this._rangeM = null;             // last range sample (m)
    this._rangeMs = null;            // its time
    this._closing = null;            // EMA'd range rate (m/s), null until two samples
    this._series = null;             // headingMode|targetName key the samples belong to
    this._text = 'AP OFF';
    this._stackMode = undefined;
    this._stackTop = undefined;
    this._stackH = undefined;
    this._flying = false;            // u5 D2: the autopilot is engaged (setFlying / the poll)
    this._flyShown = false;          // u5 D2: data-ap-flying is on the root (flying AND on the home floor)
    this._lastT = null;              // the last clock value seen by update()
    this._plainText = null;          // u5 D2: the plain-words line, or null for today's segments

    this._build(deps.parent);
    this._paint('off', PHASE_LABELS.OFF, NO_RATE, NO_RATE);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The pane-density rung adapter (cached object; HUD domRung shape). The ONE
   * visibility bit is `data-density-hidden` on the root; isVisible() also
   * honours on-screen presence (getClientRects) like HUD's DOM rungs. Never
   * throws headless (no root ⇒ not visible, setVisible no-op).
   * @returns {{id:string, label:string, isVisible:function, setVisible:function}}
   */
  rung() {
    if (!this._rung) {
      this._rung = {
        id: FMA_RUNG_ID,
        label: 'Autopilot',
        isVisible: () => {
          const el = this._root;
          if (!el || !el.hasAttribute) return false;
          return !el.hasAttribute(DENSITY_HIDDEN_ATTR) && !el.hasAttribute('data-density-leaving');
        },
        setVisible: (v) => {
          const el = this._root;
          if (!el || !el.setAttribute) return;
          if (v) el.removeAttribute(DENSITY_HIDDEN_ATTR);
          else el.setAttribute(DENSITY_HIDDEN_ATTR, '');
        },
      };
    }
    return this._rung;
  }

  /**
   * LeftStack apply (the hub calls it per frame). Write-on-change. Sets `top`
   * BEFORE un-hiding. mode 'hidden' → data-stack-hidden (never the density bit).
   * @param {number} top
   * @param {number} height
   * @param {'natural'|'compact'|'trimmed'|'hidden'} mode
   */
  setStack(top, height, mode) {
    if (this._disposed || !this._root) return;
    const t = Number(top);
    const h = Number(height);
    if (!Number.isFinite(t)) return;
    const m = (mode === 'compact' || mode === 'trimmed' || mode === 'hidden') ? mode : 'natural';
    const hh = Number.isFinite(h) ? h : 0;
    if (t === this._stackTop && hh === this._stackH && m === this._stackMode) return;
    this._stackTop = t;
    this._stackH = hh;
    this._stackMode = m;
    const root = this._root;
    const hidden = m === 'hidden';
    const topStr = `${Math.round(t)}px`;
    if (!root.style || root.style.top !== topStr) {
      if (root.style) root.style.top = topStr;
    }
    const hStr = `${Math.round(Math.max(0, hh || FMA_GEOMETRY.HEIGHT_PX))}px`;
    if (!hidden && root.style && root.style.height !== hStr) root.style.height = hStr;
    if (hidden) {
      if (root.setAttribute) root.setAttribute(STACK_HIDDEN_ATTR, '');
    } else if (root.removeAttribute) {
      root.removeAttribute(STACK_HIDDEN_ATTR);
    }
  }

  /** Rider natural height (one line). */
  naturalPx() { return FMA_GEOMETRY.HEIGHT_PX; }

  /**
   * u5-info-ap-hold D2: the autopilot is flying (engaged; HOLD after arrival counts). On the home floor
   * (floor 2) the strip then shows even though the room hides it: a separate attribute, never the density
   * bit, so the pane level (FloorMask.extraPaneShown / capture) is untouched. The hub calls it from
   * AUTOPILOT_ENGAGE / AUTOPILOT_DISENGAGE (this class holds no listener); the next poll re-reads the
   * truth from `deps.fma()`. Shows / hides at once and repaints the text without waiting for the poll.
   * @param {boolean} on
   */
  setFlying(on) {
    if (this._disposed) return;
    this._flying = !!on;
    this._syncFlyAttr();
    // Repaint now from the live state (the next poll would be up to POLL_MS away).
    let t = Number(this._now ? this._now() : NaN);
    if (!Number.isFinite(t)) t = this._lastT;
    if (!Number.isFinite(t)) t = 0;
    this._lastMs = null;
    this._sample(t, false);
  }

  /** u5 D2: true while the autopilot flies and the strip is held on screen by that (floor 2). */
  isFlyingShown() { return this._flyShown; }

  /** u5 D2: true while the autopilot is flying (any floor). */
  isFlying() { return this._flying; }

  /** @private Mirror `_flying` + the home floor onto the root's flying attribute. */
  _syncFlyAttr() {
    const want = this._flying && this._floor() === HOME_FLOOR;
    if (want !== this._flyShown) this._flyShown = want;
    this._setFlag(this._root, FLYING_ATTR, want);
  }

  /** @private The applied floor (the injected getter; never throws). */
  _floor() {
    if (!this._floorFn) return null;
    try { const f = this._floorFn(); return typeof f === 'number' ? f : null; } catch (_e) { return null; }
  }

  /** @private The simple level (the injected getter; never throws). */
  _isSimple() {
    if (!this._simpleFn) return false;
    try { return !!this._simpleFn(); } catch (_e) { return false; }
  }

  /**
   * The poll (the hub calls it per frame; it accepts one sample per POLL_MS).
   * Reads deps.fma(), advances the closing estimator, boxes / unboxes the
   * PHASE word on the passed clock, writes the DOM on change only.
   * @param {number} [nowMs] the frame clock; falls back to deps.now(). No clock ⇒ no-op.
   */
  update(nowMs) {
    if (this._disposed) return;
    this._syncFlyAttr();   // a floor change reaches the flying attribute this frame, not at the next poll
    let t = Number(nowMs);
    if (!Number.isFinite(t) && this._now) t = Number(this._now());
    if (!Number.isFinite(t)) return;
    this._lastT = t;
    if (this._lastMs !== null && t - this._lastMs < FMA_GEOMETRY.POLL_MS) return;
    this._sample(t, true);
  }

  /**
   * @private One accepted sample at `t`: read the state, advance the estimator, paint.
   * @param {number} t
   * @param {boolean} reconcile  the poll corrects `_flying` from the state; setFlying's own repaint does not
   */
  _sample(t, reconcile) {
    if (this._disposed) return;
    this._lastMs = t;

    const s = this._read();
    const engaged = !!(s && s.engaged);
    if (reconcile) this._flying = engaged;
    this._syncFlyAttr();
    const aiming = !!(s && s.aiming);
    const phase = (s && typeof s.phase === 'string') ? s.phase : PHASE_LABELS.OFF;

    // Phase (raw) — the callback rides the AP's own key, not the displayed word.
    const prevPhase = this._phase;
    if (prevPhase !== phase) {
      this._phase = phase;
      if (prevPhase !== null && this._onPhaseChange) {
        try { this._onPhaseChange(prevPhase, phase, s); } catch (_e) { /* a listener's bug is not the strip's */ }
      }
    }

    // Mode + the displayed word.
    const mode = engaged ? 'engaged' : (aiming ? 'aiming' : 'off');
    const word = engaged ? (PHASE_LABELS[phase] || phase)
      : (aiming ? AIMING_LABEL : PHASE_LABELS.OFF);

    // The box: set on a change of the displayed word (after the first sample), cleared at +BOX_MS.
    if (this._word !== null && word !== this._word) this._boxedAt = t;
    else if (this._boxedAt !== null && t - this._boxedAt >= FMA_GEOMETRY.BOX_MS) this._boxedAt = null;
    this._word = word;
    this._mode = mode;

    // Range + closing (engaged with a finite range only).
    let rangeText = NO_RATE;
    let closingText = NO_RATE;
    if (engaged) {
      const r = s.rangeM == null ? NaN : Number(s.rangeM);
      const series = `${s.headingMode || ''}|${s.targetName || ''}`;
      if (Number.isFinite(r) && r >= 0) {
        if (this._rangeM !== null && this._series === series && t > this._rangeMs) {
          const rate = (r - this._rangeM) / ((t - this._rangeMs) / 1000);
          this._closing = this._closing === null ? rate
            : FMA_GEOMETRY.EMA_KEEP * this._closing + FMA_GEOMETRY.EMA_NEW * rate;
        } else if (this._series !== series) {
          this._closing = null;                    // a new target: the series restarts
        }
        this._rangeM = r;
        this._rangeMs = t;
        this._series = series;
        rangeText = fmtRange(r);
        closingText = fmtClosing(this._closing);
      } else {
        this._resetSeries();
      }
    } else {
      this._resetSeries();
    }

    // u5 D2: floor 2 at the simple level says it in plain words (the autopilot is flying there).
    // u6 D8: floors 3 and 4 too, and there the strip is plain whatever the autopilot is doing:
    // `Autopilot off` / `Autopilot on` (aiming) / u5's engaged line.
    this._plainText = null;
    const floor = this._floor();
    if (this._isSimple() && ((engaged && floor === HOME_FLOOR) || floor === 3 || floor === 4)) {
      const named = engaged && s.headingMode === 'TARGET' && typeof s.targetName === 'string' && s.targetName
        ? shortTypeName(s.targetName) : null;
      if (phase === 'TRANSFER') {
        // trip-melt D8: the ship's own burn, not "Autopilot on". Nets step 3 slice 2b: a trip between fields says where she is
        // going and which day of it this is ("Climbing to 425 km · day 3 of 5"); without that data, the old words.
        // Review F6: while her nose is not along the way she goes (a climb pushes along her motion, a descent against it) the push
        // waits, and the line says why. Review R1: the same when the turn waits for power (an empty battery).
        const t = s.trip;
        this._plainText = (t && Number.isFinite(t.toKm) && Number.isFinite(t.day) && Number.isFinite(t.days) && t.days >= 1)
          ? (t.wait === 'power'
            ? (t.dir < 0 ? 'Descent paused: no power to turn' : 'Climb paused: no power to turn')
            : t.wait === 'nose'
              ? (t.dir < 0 ? 'Descent paused: nose not backward' : 'Climb paused: nose not forward')
              : `${t.dir < 0 ? 'Descending' : 'Climbing'} to ${Math.round(t.toKm)} km ${DOT} day ${t.day} of ${t.days}`)
          : 'Burning to the next field';
      } else if (named) {
        this._plainText = rangeText === NO_RATE ? `Autopilot to ${named}` : `Autopilot to ${named} ${DOT} ${rangeText}`;
      } else {
        this._plainText = (engaged || aiming) ? 'Autopilot on' : 'Autopilot off';
      }
    }

    this._paint(mode, word, rangeText, closingText);
  }

  /** The current line as one string (`AP OFF`, `AP · AIMING`, `AP · HOLD · 12 m · +0.0 m/s`). */
  text() { return this._text; }

  /** Unsubscribe nothing (the strip holds no listener), remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._root && this._root.remove) {
      try { this._root.remove(); } catch (_e) { /* stub */ }
    }
    this._root = null;
    this._el = null;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build the DOM as the LAST child of `parent` (headless: nothing). */
  _build(parentDep) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = parentDep || (doc.getElementById ? doc.getElementById(FMA_PARENT_ID) : null);
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();

    const root = doc.createElement('div');
    root.id = FMA_STRIP_ID;
    root.className = 'hud-panel';
    // Overlay rider (plan Task 8): left column width, stacked by LeftStack.
    root.style.position = 'absolute';
    root.style.left = `max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`;   // = the left column's edge
    root.style.width = `${HUD_COLUMN_WIDTH_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.height = `${FMA_GEOMETRY.HEIGHT_PX}px`;
    root.style.pointerEvents = 'none';
    root.setAttribute(MODE_ATTR, 'off');
    root.setAttribute(STACK_HIDDEN_ATTR, '');

    const mk = (cls, text) => {
      const el = doc.createElement('span');
      el.className = cls;
      el.textContent = text;
      return el;
    };
    const ap = mk('fma-seg fma-label fma-ap', 'AP');
    const sep1 = mk('fma-sep', DOT);
    const phase = mk('fma-seg fma-label fma-phase', PHASE_LABELS.OFF);
    const sep2 = mk('fma-sep', DOT);
    const range = mk('fma-seg fma-num fma-range', NO_RATE);
    const sep3 = mk('fma-sep', DOT);
    const closing = mk('fma-seg fma-num fma-closing', NO_RATE);
    for (const el of [ap, sep1, phase, sep2, range, sep3, closing]) root.appendChild(el);
    parent.appendChild(root);

    this._root = root;
    this._el = { ap, sep1, phase, sep2, range, sep3, closing };
  }

  /** @private The one <style id="fma-strip-style"> (per document). No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(FMA_STYLE_ID))) return;
    const G = FMA_GEOMETRY;
    const style = doc.createElement('style');
    style.id = FMA_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar rides in from .hud-panel (the mono token, the
       * dark 0.95 plate, the green hairline); the strip sets its own size.
       * Width budget: 260 − 2 border − 12 padding = 246 px; B612 Mono advances
       * ~0.6 em = 6.6 px at 11 px, so a 34-character line (the far phase with
       * km range and a two-digit closing) just fits; the PHASE word alone
       * yields (ellipsis) when a longer one arrives — the numbers never clip. */
      #${FMA_STRIP_ID} {
        display: flex;
        align-items: center;
        flex: 0 0 auto;
        height: ${G.HEIGHT_PX}px;
        box-sizing: border-box;
        padding: 0 6px;
        font: ${G.FONT_PX}px/1 var(--font-mono);
        font-variant-numeric: tabular-nums;
        color: var(--hud-normal, ${VisualLaw.COLORS.PLAYER});
        white-space: nowrap;
        overflow: hidden;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
        width: ${HUD_COLUMN_WIDTH_PX}px;
        transition: top ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING};
      }
      @media (prefers-reduced-motion: reduce) {
        #${FMA_STRIP_ID} { transition: none; }
      }
      /* The rung's ONE bit (HUD's global rule carries it too; this copy keeps
       * the strip honest when it stands alone). */
      #${FMA_STRIP_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* Layout-hidden (LeftStack). The density bit is untouched. */
      #${FMA_STRIP_ID}[${STACK_HIDDEN_ATTR}] { display: none !important; }
      /* u5 D2: the autopilot is flying on floor 2 - the strip shows although the room hid it
       * (the density bit stays set: it is the player's pane choice, FloorMask reads it). The
       * longer selector beats both display:none rules above and HUD's global one. */
      #${FMA_STRIP_ID}[${FLYING_ATTR}][${DENSITY_HIDDEN_ATTR}] { display: flex !important; }
      /* ...but LeftStack's "no room" still wins for the frames it takes the hub to fold DAUGHTERS (main.js copilot rider apply) and re-place the strip: D2 never leaves it dropped. */
      #${FMA_STRIP_ID}[${FLYING_ATTR}][${STACK_HIDDEN_ATTR}] { display: none !important; }
      /* The plain-words line: written as is (no small-caps), may yield with an ellipsis. */
      #${FMA_STRIP_ID}[${PLAIN_ATTR}] .fma-label { font-variant: normal !important; font-variant-caps: normal !important; text-transform: none !important; letter-spacing: normal !important; }  /* index.html's html[data-look=new] label rule is !important */
      #${FMA_STRIP_ID}[${PLAIN_ATTR}] .fma-ap { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* AP OFF reads dim. */
      #${FMA_STRIP_ID}[${MODE_ATTR}="off"] { opacity: 0.45; }
      #${FMA_STRIP_ID} .fma-seg { flex: 0 0 auto; }
      #${FMA_STRIP_ID} .fma-label { font-variant-caps: small-caps; }
      #${FMA_STRIP_ID} .fma-num { font-variant-caps: normal; }
      #${FMA_STRIP_ID} .fma-sep { flex: 0 0 auto; margin: 0 2px; opacity: 0.6; }
      /* The PHASE word yields first when the line is long (the numbers never clip). */
      #${FMA_STRIP_ID} .fma-phase {
        flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        border: 1px solid transparent; border-radius: 2px; padding: 1px 2px;
      }
      /* BOXED 10 s on a phase change: the strip's own text colour. */
      #${FMA_STRIP_ID} .fma-phase[${BOXED_ATTR}] { border-color: currentColor; }
      #${FMA_STRIP_ID} [${SEG_HIDDEN_ATTR}] { display: none; }
    `;
    doc.head.appendChild(style);
  }

  // ── Reads / model ──────────────────────────────────────────────────────────

  /** @private deps.fma() guarded (absent / throwing / non-object ⇒ null). */
  _read() {
    if (!this._fma) return null;
    try {
      const s = this._fma();
      return (s && typeof s === 'object') ? s : null;
    } catch (_e) {
      return null;
    }
  }

  /** @private Drop the range series (disengaged / no goal). */
  _resetSeries() {
    this._rangeM = null;
    this._rangeMs = null;
    this._closing = null;
    this._series = null;
  }

  // ── Paint (write-on-change) ────────────────────────────────────────────────

  /** @private The line text + the DOM (segments, separators, mode, box). */
  _paint(mode, word, rangeText, closingText) {
    const plain = this._plainText;
    this._text = plain !== null ? plain
      : mode === 'off' ? 'AP OFF'
        : mode === 'aiming' ? `AP ${DOT} ${word}`
          : `AP ${DOT} ${word} ${DOT} ${rangeText} ${DOT} ${closingText}`;
    const el = this._el;
    if (!el || !this._root) return;
    // Density-hidden (the room / a flip): the line is tracked, the DOM is left
    // alone — every write below is write-on-change, so the next visible tick
    // catches up in one pass (Session M review; the OrbitPane / NextPane rule).
    // u5 D2: not while the strip is held on screen by the flying rule - it must read true.
    if (!this._flyShown && this._root.hasAttribute && this._root.hasAttribute(DENSITY_HIDDEN_ATTR)) return;
    this._setAttr(this._root, MODE_ATTR, mode);
    if (plain !== null) {
      // The plain-words line rides in the first segment; every other segment folds away.
      this._setFlag(this._root, PLAIN_ATTR, true);
      this._setText(el.ap, plain);
      for (const e of [el.sep1, el.phase, el.sep2, el.range, el.sep3, el.closing]) this._setFlag(e, SEG_HIDDEN_ATTR, true);
      return;
    }
    this._setFlag(this._root, PLAIN_ATTR, false);
    this._setText(el.ap, 'AP');
    this._setText(el.phase, word);
    this._setText(el.range, rangeText);
    this._setText(el.closing, closingText);
    const showSep1 = mode !== 'off';
    const showNums = mode === 'engaged';
    this._setFlag(el.phase, SEG_HIDDEN_ATTR, false);
    this._setFlag(el.sep1, SEG_HIDDEN_ATTR, !showSep1);
    for (const e of [el.sep2, el.range, el.sep3, el.closing]) this._setFlag(e, SEG_HIDDEN_ATTR, !showNums);
    this._setFlag(el.phase, BOXED_ATTR, this._boxedAt !== null);
  }

  /** @private */
  _setText(el, text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
  }

  /** @private */
  _setAttr(el, name, value) {
    if (!el || !el.setAttribute) return false;
    const have = el.getAttribute ? el.getAttribute(name) : undefined;
    if (have === value) return false;
    el.setAttribute(name, value);
    return true;
  }

  /** @private A boolean attribute: present when `on`, absent otherwise. */
  _setFlag(el, name, on) {
    if (!el || !el.setAttribute || !el.hasAttribute) return false;
    const have = el.hasAttribute(name);
    if (have === !!on) return false;
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
    return true;
  }
}

/**
 * u5 D2 (review fix round 1): folds DAUGHTERS to make room for a strip the autopilot holds on screen, at
 * most ONCE per flight, and gives it back only if this keeper folded it and nobody touched it since.
 *
 * The LeftStack never calls a hidden rider's `apply`, so the hub calls `step()` once a frame (before the
 * layout) and the rider's `apply` tells it the mode it was given through `setMode()`.
 *  - fold:    flying shown + the stack said 'hidden' + DAUGHTERS open + not folded yet this flight.
 *  - release: DAUGHTERS found open again after the keeper folded it (the player, or a departure's
 *             auto-open): the keeper lets go, never refolds this flight (the strip stays stack-hidden).
 *  - restore: the strip stops being shown (autopilot off, or off floor 2) and DAUGHTERS is still folded
 *             by this keeper: unfold it.
 */
export class DaughtersFoldKeeper {
  constructor() {
    this._did = false;        // this keeper folded DAUGHTERS and still owns that fold
    this._once = false;       // already folded during this flight
    this._noRoom = false;     // the strip rider's last mode was 'hidden' while it flies
  }

  /** The strip rider's `apply` mode (only read while the strip flies). */
  setMode(mode) { this._noRoom = (mode === 'hidden'); }

  /** True while this keeper holds a fold it will give back. */
  holdsFold() { return this._did; }

  /**
   * @param {boolean} flyingShown  FmaStrip.isFlyingShown()
   * @param {{isFolded?:function, toggleFold?:function}|null} sp  the DAUGHTERS pane (StatusPanel)
   * @returns {boolean} true when it toggled the fold this call
   */
  step(flyingShown, sp) {
    const ok = !!(sp && typeof sp.isFolded === 'function' && typeof sp.toggleFold === 'function');
    if (!flyingShown) {
      this._once = false;
      this._noRoom = false;
      if (this._did) {
        this._did = false;
        if (ok && sp.isFolded()) { sp.toggleFold(); return true; }
      }
      return false;
    }
    if (!ok) return false;
    const folded = sp.isFolded();
    if (this._did && !folded) this._did = false;   // somebody reopened it: leave it open
    if (!folded && !this._once && this._noRoom) {
      this._once = true;
      sp.toggleFold();
      this._did = !!sp.isFolded();   // a no-op on a tall screen (it never folds): then nothing was done
      return this._did;
    }
    return false;
  }
}

export default FmaStrip;
