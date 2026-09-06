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
 * shape ({id:'copilot', label:'Copilot', isVisible, setVisible}) whose ONE
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

/** The root element id (FloorMask MASK_PANES.copilot.els = ['#hud-fma-strip']). */
export const FMA_STRIP_ID = 'hud-fma-strip';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const FMA_STYLE_ID = 'fma-strip-style';

/** The pane-density rung id (FloorMask MASK_PANES.copilot.rung). */
export const FMA_RUNG_ID = 'copilot';

/** The column the strip rides in (its LAST child). */
export const FMA_PARENT_ID = 'hud-left-column';

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
});

/** The word shown while an aim sequence owns the nose and the AP is off. */
export const AIMING_LABEL = 'AIMING';

/** The closing placeholder until two range samples exist. */
export const NO_RATE = '\u2014';                 // —

/** The rung's ONE hide bit (HUD._initPaneDensity domRung grammar). */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
/** off | aiming | engaged — drives the dim rule and which segments show. */
const MODE_ATTR = 'data-fma-mode';
/** The PHASE segment's 10 s box. */
const BOXED_ATTR = 'data-boxed';
/** A segment (or separator) folded away in the off / aiming forms. */
const SEG_HIDDEN_ATTR = 'data-fma-hidden';

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
   * @param {Element}  [deps.parent]     root's parent (default: doc.getElementById('hud-left-column')); appended LAST.
   * @param {function} [deps.now]        ms clock — used only when update() is called without nowMs.
   * @param {function} [deps.fma]        () → AutopilotSystem.fmaState() shape. Absent ⇒ `AP OFF`.
   * @param {function} [deps.onPhaseChange] (prevPhase, nextPhase, state) on every AP phase change after the first sample.
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._fma = typeof deps.fma === 'function' ? deps.fma : null;
    this._onPhaseChange = typeof deps.onPhaseChange === 'function' ? deps.onPhaseChange : null;

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
        label: 'Copilot',
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
   * The poll (the hub calls it per frame; it accepts one sample per POLL_MS).
   * Reads deps.fma(), advances the closing estimator, boxes / unboxes the
   * PHASE word on the passed clock, writes the DOM on change only.
   * @param {number} [nowMs] the frame clock; falls back to deps.now(). No clock ⇒ no-op.
   */
  update(nowMs) {
    if (this._disposed) return;
    let t = Number(nowMs);
    if (!Number.isFinite(t) && this._now) t = Number(this._now());
    if (!Number.isFinite(t)) return;
    if (this._lastMs !== null && t - this._lastMs < FMA_GEOMETRY.POLL_MS) return;
    this._lastMs = t;

    const s = this._read();
    const engaged = !!(s && s.engaged);
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
    // The column's other panes override .hud-panel's absolute the same way.
    root.style.position = 'relative';
    root.style.boxSizing = 'border-box';
    root.style.height = `${FMA_GEOMETRY.HEIGHT_PX}px`;
    root.style.pointerEvents = 'none';
    root.setAttribute(MODE_ATTR, 'off');

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
        color: ${VisualLaw.COLORS.PLAYER};
        white-space: nowrap;
        overflow: hidden;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
      }
      /* The rung's ONE bit (HUD's global rule carries it too; this copy keeps
       * the strip honest when it stands alone). */
      #${FMA_STRIP_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
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
    this._text = mode === 'off' ? 'AP OFF'
      : mode === 'aiming' ? `AP ${DOT} ${word}`
        : `AP ${DOT} ${word} ${DOT} ${rangeText} ${DOT} ${closingText}`;
    const el = this._el;
    if (!el || !this._root) return;
    // Density-hidden (the room / a flip): the line is tracked, the DOM is left
    // alone — every write below is write-on-change, so the next visible tick
    // catches up in one pass (Session M review; the OrbitPane / NextPane rule).
    if (this._root.hasAttribute && this._root.hasAttribute(DENSITY_HIDDEN_ATTR)) return;
    this._setAttr(this._root, MODE_ATTR, mode);
    this._setText(el.phase, word);
    this._setText(el.range, rangeText);
    this._setText(el.closing, closingText);
    const showSep1 = mode !== 'off';
    const showNums = mode === 'engaged';
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

export default FmaStrip;
