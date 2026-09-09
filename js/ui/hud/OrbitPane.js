/**
 * OrbitPane.js — the ORBIT HUD pane (Session M, item 1, 2026-09-06).
 *
 * The ship's orbit as a flight instrument — text only (owner 2026-09-08:
 * "remove the graphic on the left side, only text"; before that a TRACK view,
 * the OrbitMFD plot in a 126 px square, rode beside the text): a SLOTS block —
 * a header line and a 2-row grid of fixed-width readouts inside 280 px
 * (ladder reorder rev 3, locked #8 / #15 — ΔV dropped; Mother digest owns it):
 *
 *   LAT · LON · ALT (+ trend arrow)
 *   SUN (state word + time to the next terminator crossing) · MET
 *
 * It is a pane-density RUNG like the other DOM panes: `rung()` returns the HUD
 * domRung shape ({id:'orbit', label, isVisible, setVisible}) whose ONE
 * visibility bit is the `data-density-hidden` attribute on the root, so the
 * DETAIL slider counts it as a rung (Session P) and FloorMask rooms it per floor.
 *
 * HOME (owner 2026-09-07; before that: right of the DISPLAY rail): bottom-left,
 * FLUSH with the left HUD column (x = HUD_EDGE_PX 16), UNDER the left HUD column
 * (Session P: the DISPLAY rail it rode under retired — the ceiling is the
 * column's own bottom, a 1 Hz hub read) and ABOVE the hint ticker — so the
 * bottom-centre stays free for the SAFETY OVERRIDE button. The hub (main.js,
 * inside the LADDER gate) constructs the pane, pushes `rung()` into
 * hud.paneDensity.rungs before the first floorMask.setFloor, and calls
 * `setAnchor(EDGE_PX − GAP_PX, floorPx, leftColumnBottom)` once per frame
 * with cached numbers and `update(nowMs)`
 * per frame. setAnchor is write-on-change on its three inputs; every edge of
 * the root comes from it (left = leftEdge + GAP; the bottom edge = floor − GAP,
 * placed via top = bottom − the pane's fixed height — pure arithmetic, no
 * layout read). Modes by the vertical budget between the ceiling (the column's
 * bottom + GAP, or the screen top) and the bottom edge: `full` (the one form,
 * FULL_PX = 104 tall) when ≥ FULL_PX, else `hidden` (display none via the
 * `data-orbit-mode` attribute — never the rung bit). The left-edge cascade:
 * the column (top-anchored) → this pane fills what is left, hiding when
 * squeezed — the CARGO / NEXT law without their compact step.
 *
 * UPDATE: `update(nowMs)` self-throttles to one tick per second; every tick
 * recomputes the readouts from the injected deps and writes text / style /
 * attributes only when a value changed. The eclipse prediction (`eclipse()`)
 * is recomputed EVEN WHILE density-hidden (another pane consumes it) — only
 * the DOM writes are skipped. The slow slot (the SUN word)
 * flash on change (`data-changed` for 1.2 s — a white BLOOM, see below); the
 * per-second slots never flash.
 *
 * WHITE TELEMETRY (owner 2026-09-08: "White color numbers in the Orbit pane.
 * It is meant to be eye catching, to show off this is sim, not a cartoon … eye
 * candy for Space enthusiasts"; plan
 * .kilo/plans/1788863500000-orbit-pane-telemetry-showpiece.md): the pane is a
 * showpiece of the simulation and reads like mission telemetry — the SpaceX
 * webcast overlay / the ISS trackers: white tabular numerals, dim small-caps
 * labels, the unit lighter than the number, colour reserved for STATE.
 *   - Values wear `COLORS.LABEL` white (`.orbit-value`); labels and the header
 *     keep the panel's dim green (index.html `.hud-panel`), 0.55 / 0.6.
 *   - Units: the UNIT_SLOTS whose formatter yields `<number> <unit>` (ALT `km`)
 *     hold two inner spans — `.orbit-num` + `.orbit-unit`
 *     (the unit at 0.6 opacity, `white-space: pre` so its leading space
 *     survives the flex line start). The split happens at paint from the
 *     UNCHANGED formatter string (`UNIT_RE`), so the value element's
 *     textContent stays byte-identical (`'350.0 km'`) and `readout()` is the
 *     same string. Width-neutral: opacity has no metric, same glyphs, same
 *     advance — CELL_W_PX / the `.orbit-cell-2 .orbit-text` width rule untouched.
 *   - Colour for state only: the ALT `↓` stays CAUTION amber; SUN stays a
 *     word; the ALT `↑` (a burn, not a warning) inherits the value white like
 *     any other glyph. (ΔV bar / reserve tick retired with the ΔV cell.)
 *   - The change-flash on white values: `@keyframes orbit-pane-flash` is a
 *     `text-shadow` bloom (LABEL glow → transparent, `ease-out forwards`, the
 *     same CHANGE_FLASH_MS) — not a colour change (PLAYER green is a state).
 *     Under `prefers-reduced-motion: reduce` the animation is off and the
 *     glow declared on `[data-changed]` holds steady for the 1.2 s window
 *     (information kept, motion removed — the NextPane / HUD.js precedent).
 *
 * Laws: root = a DIRECT child of #hud-overlay wearing .hud-panel, pointer-
 * events none (nothing is tappable); ONE injected <style> per document, no
 * backdrop-filter; DOM fonts ride the --font-mono token with tabular numerals;
 * no timers / rAF of its own (all timing from `nowMs`); no global listeners;
 * no layout reads; never reads the ladder flag (the hub gates construction);
 * touches no DOM at import time; every dep optional and guarded (constructible
 * with no document — the readouts then hold `—` and eclipse() reads {false, null}).
 *
 * @module ui/hud/OrbitPane
 */

import { Constants } from '../../core/Constants.js';
import { VisualLaw } from '../../core/VisualLaw.js';
import { HUD_EDGE_PX, HUD_COLUMN_WIDTH_PX } from '../RailGeometry.js';
import { DENSITY_MOTION_MS, DENSITY_MOTION_EASING } from '../HUD.js';
import { orbitToKm, subSatellitePoint, nextShadowTransition } from '../../entities/OrbitalMechanics.js';
import { RESERVE_FRAC, usableDeltaV } from '../../entities/ReachabilityModel.js';

/** The colour law (read-only): LABEL white for the values and the flash bloom, CAUTION amber for the reserve tick / decay arrow. */
const COLORS = VisualLaw.COLORS;

/** The root element id (FloorMask MASK_PANES.orbit.els = ['#hud-orbit-pane']). */
export const ORBIT_PANE_ID = 'hud-orbit-pane';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const ORBIT_STYLE_ID = 'orbit-pane-style';

/** The pane-density rung id (FloorMask MASK_PANES.orbit.rung). */
export const ORBIT_RUNG_ID = 'orbit';

/**
 * ORBIT_GEOMETRY — the pane's numbers (px). FRAME_PX is the .hud-panel chrome
 * (6 px padding + 1 px border, top and bottom). Width is HUD_COLUMN_WIDTH_PX
 * (280) — two rows of slots inside 280 (ladder reorder rev 3, locked #8 / #15):
 * LAT · LON · ALT · SUN · MET. The ΔV cell is gone (Mother digest owns ΔV).
 * CELL_W_PX is derived so three cells + two gaps fill SLOTS_W_PX =
 * HUD_COLUMN_WIDTH_PX − H_CHROME_PX (8 px padding + 1 px border a side).
 * FULL_PX = FRAME + slotsPx() is the pane's ONE height (two rows).
 * Labels are 11 px (type floor, locked #14).
 * rightPx() = HUD_EDGE_PX + HUD_COLUMN_WIDTH_PX (296) — import, don't hard-code.
 */
const VALUE_FONT_PX = 13;
const VALUE_CH = 10;
/** The .hud-panel chrome a side, horizontally: 8 px padding + 1 px border. */
const H_CHROME_PX = 18;
const CELL_GAP_PX = 6;
const SLOTS_W_PX = HUD_COLUMN_WIDTH_PX - H_CHROME_PX;                        // 262
const CELL_W_PX = Math.floor((SLOTS_W_PX - 2 * CELL_GAP_PX) / 3);            // 83
const FRAME_PX = 14;
const HEADER_PX = 12;
const LABEL_PX = 11;
const VALUE_PX = 14;
const ROW_GAP_PX = 2;
const FULL_PX = FRAME_PX + HEADER_PX + ROW_GAP_PX + 2 * (LABEL_PX + VALUE_PX) + ROW_GAP_PX;   // 80
export const ORBIT_GEOMETRY = Object.freeze({
  GAP_PX: 8,
  FULL_PX,
  FRAME_PX,
  WIDTH_PX: HUD_COLUMN_WIDTH_PX,
  VALUE_FONT_PX,
  VALUE_CH,
  CELL_W_PX,
  CELL_GAP_PX,
  SLOTS_W_PX,
  HEADER_PX,
  LABEL_PX,
  VALUE_PX,
  ROW_GAP_PX,
});

/** Minimum ms between two update() ticks (the 1 Hz law). */
export const TICK_MS = 1000;

/** How long a slow slot wears `data-changed` after its string changed (ms). */
export const CHANGE_FLASH_MS = 1200;

/**
 * ALT trend threshold, km per REAL second of smoothed altitude rate. Derived
 * from the game's drag: PlayerSatellite integrates atmosphericDrag(alt, v,
 * Constants.MOTHER_DRAG.AREA_M2 = 20 m², MASS_KG = 130 kg) as
 * sma *= 1 − 2·a·dt/v per world second; at 400 km (ρ =
 * 2.8e-11 kg/m³, v = 7.67 km/s) that is 4.9e-4 km per WORLD second, i.e.
 * 4.9e-3 km per REAL second at BASE_SCALE 10 / rate 1. One fifth of it: the
 * EMA (TREND_EMA, seeded at 0.15 of the first rate = 7.4e-4) crosses the line
 * on the THIRD sample at 400 km (the second EMA step, 1.36e-3), within five
 * at 500 km, and a steady orbit (no drag above 600 km) stays blank.
 */
export const ALT_TREND_KM_PER_S = 1e-3;

/** The trend EMA weight on the previous rate (DockingReticle._easeOdds: 0.85 / 0.15). */
export const TREND_EMA = 0.85;

/** The unknown-value placeholder (an em dash; fixed homes never go empty). */
export const PLACEHOLDER = '\u2014';

/** The rung's ONE hide bit (HUD._initPaneDensity domRung grammar). */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
/** Layout-hidden (LeftStack): display:none via the pane's own style — never the density bit. */
const STACK_HIDDEN_ATTR = 'data-stack-hidden';
const MODE_ATTR = 'data-orbit-mode';
const CHANGED_ATTR = 'data-changed';
const TREND_ATTR = 'data-trend';
const ARROW_DOWN = '\u2193';
const ARROW_UP = '\u2191';

/** The slots whose string change flashes (the per-second slots never do). */
const SLOW_SLOTS = Object.freeze(['sunState']);

/** The slots block's inner height: header + gap + two rows with one gap. */
export function slotsPx() {
  const G = ORBIT_GEOMETRY;
  return G.HEADER_PX + G.ROW_GAP_PX + 2 * (G.LABEL_PX + G.VALUE_PX) + G.ROW_GAP_PX;
}

/** The pane's outer height (frame + the slots block) — its one form; equals ORBIT_GEOMETRY.FULL_PX. */
export function fullPx() {
  return ORBIT_GEOMETRY.FRAME_PX + slotsPx();
}

/** @private finite number or null (null / undefined / '' / booleans are NOT numbers here) */
function num(x) {
  if (x == null || x === '' || typeof x === 'boolean') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** @private two-digit zero pad */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * ORBIT_FMT — the slot formats (pure; every one returns PLACEHOLDER for a
 * non-finite input so the slot keeps its fixed home).
 */
export const ORBIT_FMT = Object.freeze({
  /** `408.2 km` */
  alt: (km) => { const n = num(km); return n == null ? PLACEHOLDER : `${n.toFixed(1)} km`; },
  /** `7.67 km/s` */
  vel: (kms) => { const n = num(kms); return n == null ? PLACEHOLDER : `${n.toFixed(2)} km/s`; },
  /** `51.6°` from radians */
  inc: (rad) => { const n = num(rad); return n == null ? PLACEHOLDER : `${(n * 180 / Math.PI).toFixed(1)}\u00b0`; },
  /** `92:34` — mm:ss, minutes uncapped, rounded to the second */
  mmss: (s) => {
    const n = num(s);
    if (n == null || n < 0) return PLACEHOLDER;
    const t = Math.round(n);
    return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
  },
  /** `41.2N` */
  lat: (deg) => { const n = num(deg); return n == null ? PLACEHOLDER : `${Math.abs(n).toFixed(1)}${n < 0 ? 'S' : 'N'}`; },
  /** `071.5W` — three integer digits */
  lon: (degEast) => {
    const n = num(degEast);
    return n == null ? PLACEHOLDER : `${Math.abs(n).toFixed(1).padStart(5, '0')}${n < 0 ? 'W' : 'E'}`;
  },
  /** `412 m/s` */
  dv: (ms) => { const n = num(ms); return n == null ? PLACEHOLDER : `${Math.round(n)} m/s`; },
  /** `00:12:34` — hh:mm:ss, hours uncapped */
  met: (s) => {
    const n = num(s);
    if (n == null || n < 0) return PLACEHOLDER;
    const t = Math.floor(n);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  },
});

/**
 * The unit split (white telemetry): a formatted `<number> <unit>` string paints
 * as `.orbit-num` + `.orbit-unit` (the unit dimmer). UNIT_SLOTS are the displayed
 * slots whose formatter yields that shape (ALT `km`; VEL / ΔV dropped from the
 * grid — locked #15). A non-matching string (the `—` placeholder) paints whole
 * into `.orbit-num` with an empty unit. The value element's textContent is the
 * formatter string either way: num + unit, the unit carrying its own leading
 * space (`' km'`).
 */
export const UNIT_RE = /^(\S+) (\S+)$/;
export const UNIT_SLOTS = Object.freeze(['alt']);

/** @private `'350.0 km'` → `{ num: '350.0', unit: ' km' }`; `'—'` → `{ num: '—', unit: '' }` */
export function splitUnit(text) {
  const m = UNIT_RE.exec(text);
  return m ? { num: m[1], unit: ` ${m[2]}` } : { num: text, unit: '' };
}

const EMPTY_VALS = Object.freeze({
  alt: PLACEHOLDER, trend: '', vel: PLACEHOLDER, inc: PLACEHOLDER, period: PLACEHOLDER,
  lat: PLACEHOLDER, lon: PLACEHOLDER, sunState: PLACEHOLDER, sunTimer: PLACEHOLDER,
  dv: PLACEHOLDER, dvFill: '0%', met: PLACEHOLDER,
});

const NO_ECLIPSE = Object.freeze({ inShadow: false, secondsToFlip: null });

export class OrbitPane {
  /**
   * @param {object} [deps]  every one optional and guarded
   * @param {Document|null} [deps.doc]      document (default: the global one; null = headless)
   * @param {Element}  [deps.parent]        root's parent (default: doc.getElementById('hud-overlay'))
   * @param {boolean}  [deps.glass]         touch glass (no tap targets here: class only)
   * @param {function} [deps.now]           ms clock; used only when update() is handed a non-finite nowMs
   * @param {object}   [deps.player]        PlayerSatellite-like: getOrbitalElements() → { semiMajorAxis
   *   (SCENE units), eccentricity, inclination (rad), raan, argPerigee, trueAnomaly, meanMotion },
   *   getAltitudeKm(), getVelocity() → {x,y,z} km/s, getPosition() → {x,y,z} scene units
   * @param {function} [deps.inShadow]      () => boolean (the player's own shadow flag)
   * @param {function} [deps.budget]        () => ArmManager.getMassBudget() result ({ deltaV m/s, … }) or null
   * @param {number}   [deps.reserveFrac]   reserve fraction (default ReachabilityModel.RESERVE_FRAC)
   * @param {function} [deps.missionTime]   () => seconds
   * @param {function} [deps.sunDir]        () => {x,y,z}|null — the current sun direction
   * @param {function} [deps.sunDirAt]      (aheadRealS, out) => {x,y,z} — the FUTURE sun direction (SunLight.directionAt)
   * @param {function} [deps.clock]         () => ({ rate, baseScale }) (timeAuthority.rate, TimeAuthority.BASE_SCALE)
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._glass = !!deps.glass;
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._player = deps.player || null;
    this._inShadow = typeof deps.inShadow === 'function' ? deps.inShadow : null;
    this._budget = typeof deps.budget === 'function' ? deps.budget : null;
    const rf = Number(deps.reserveFrac);
    this._reserveFrac = (Number.isFinite(rf) && rf >= 0 && rf < 1) ? rf : RESERVE_FRAC;
    this._missionTime = typeof deps.missionTime === 'function' ? deps.missionTime : null;
    this._sunDir = typeof deps.sunDir === 'function' ? deps.sunDir : null;
    this._sunDirAt = typeof deps.sunDirAt === 'function' ? deps.sunDirAt : null;
    this._clock = typeof deps.clock === 'function' ? deps.clock : null;

    this._root = null;
     this._el = null;                 // { slots, cells: {slot → value el}, units, trend }
    this._rung = null;
    this._mode = 'hidden';           // until the first setStack places the pane
    this._stackMode = undefined;     // last setStack inputs (write-on-change)
    this._stackTop = undefined;
    this._stackH = undefined;
    this._lastTickMs = null;
    this._vals = { ...EMPTY_VALS };  // the strings computed by the last tick
    this._prev = null;               // the previous tick's strings (change detection)
    this._flashUntil = Object.create(null);   // slot → ms
    this._trendState = { last: null, rate: 0 };
    this._eclipse = NO_ECLIPSE;
    this._sunScratch = { x: 0, y: 0, z: 0 };
    this._disposed = false;

    this._build(deps.parent);
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
        id: ORBIT_RUNG_ID,
        label: 'Orbit',
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
   * LeftStack apply (the hub calls it per frame). Write-on-change on the three
   * inputs. natural/compact/trimmed → data-orbit-mode 'full'; hidden →
   * 'hidden' + data-stack-hidden. Sets `top` BEFORE un-hiding.
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
    this._layout();
  }

  /** Rider natural height (the one form). */
  naturalPx() { return ORBIT_GEOMETRY.FULL_PX; }

  /** No compact step (one form). */
  compactPx() { return null; }

  /** Cannot trim. */
  minPx() { return null; }

  /** The current mode: 'full' (the one form) | 'hidden' ('hidden' until the first setStack, and headless). */
  mode() { return this._mode; }

  /**
   * SAFETY OVERRIDE (owner 2026-09-07; rev 3 inverted U): the pane's placed
   * RIGHT edge (CSS px) while it is on screen — placed by setStack, mode not
   * 'hidden', density bit clear — else null. Equals HUD_EDGE_PX +
   * HUD_COLUMN_WIDTH_PX (296) — import, don't hard-code. One attribute read,
   * never a layout read. The OVERRIDE panel centres itself in the band right
   * of this edge (the hub's gameLoop wire), so the two never overlap.
   * @returns {number|null}
   */
  rightPx() {
    const el = this._root;
    if (!el || this._disposed || this._mode === 'hidden') return null;
    if (el.hasAttribute && (el.hasAttribute(DENSITY_HIDDEN_ATTR) || el.hasAttribute(STACK_HIDDEN_ATTR))) return null;
    return HUD_EDGE_PX + HUD_COLUMN_WIDTH_PX;
  }

  /**
   * The 1 Hz tick: at most one tick per TICK_MS; recomputes every readout from
   * the deps (the eclipse prediction even while hidden), writes the DOM only
   * when visible and only what changed.
   * @param {number} nowMs
   * @returns {boolean} true when a tick ran
   */
  update(nowMs) {
    if (this._disposed) return false;
    let t = Number(nowMs);
    if (!Number.isFinite(t) && this._now) t = Number(this._now());
    if (!Number.isFinite(t)) return false;
    if (this._lastTickMs != null && t - this._lastTickMs < TICK_MS) return false;
    const dtS = this._lastTickMs == null ? 0 : (t - this._lastTickMs) / 1000;
    this._lastTickMs = t;
    this._compute(dtS);
    this._paint(t);
    return true;
  }

  /**
   * The eclipse state cached from the last tick, in WORLD seconds:
   * { inShadow, secondsToFlip } — secondsToFlip = time to the next terminator
   * crossing (null when none lies within one orbit, the clock is stopped, or
   * nothing is known). Fresh even while density-hidden.
   * @returns {{inShadow:boolean, secondsToFlip:(number|null)}}
   */
  eclipse() { return this._eclipse; }

  /** The strings the last tick computed (a copy): alt, trend, vel, inc, period, lat, lon, sunState, sunTimer, dv, dvFill, met. */
  readout() { return { ...this._vals }; }

  /** Remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._root && this._root.remove) {
      try { this._root.remove(); } catch (_e) { /* stub */ }
    }
    this._root = null;
    this._el = null;
    this._mode = 'hidden';
    this._eclipse = NO_ECLIPSE;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build the DOM under `parent` (headless: nothing). */
  _build(parentDep) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = parentDep || (doc.getElementById ? doc.getElementById('hud-overlay') : null);
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };
    const cells = Object.create(null);
    /** One slot: a dim label above a value; `wide` spans two cells. `slot` keys the value element. */
    const cell = (label, slot, wide) => {
      const c = mk('div', 'orbit-cell' + (wide ? ' orbit-cell-2' : ''));
      c.appendChild(mk('div', 'orbit-label', label));
      const v = mk('div', 'orbit-value');
      if (slot) {
        if (v.setAttribute) v.setAttribute('data-slot', slot);
        v.textContent = PLACEHOLDER;
        cells[slot] = v;
      }
      c.appendChild(v);
      return { cell: c, value: v };
    };
    const span = (cls, slot, text) => {
      const s = mk('span', cls, text);
      if (s.setAttribute) s.setAttribute('data-slot', slot);
      cells[slot] = s;
      return s;
    };
    /** The unit split (white telemetry): the slot's value element holds `.orbit-num` + `.orbit-unit`
     *  (the unit dimmer); the element's own textContent is emptied first so the two spans ARE its text. */
    const units = Object.create(null);
    const unitSplit = (slot) => {
      const el = cells[slot];
      el.textContent = '';
      const numEl = mk('span', 'orbit-num', PLACEHOLDER);
      const unitEl = mk('span', 'orbit-unit', '');
      el.appendChild(numEl); el.appendChild(unitEl);
      units[slot] = { num: numEl, unit: unitEl };
    };

    const root = mk('div', 'hud-panel' + (this._glass ? ' orbit-glass' : ''));
    root.id = ORBIT_PANE_ID;
    // Geometry: left / width at build (inverted U); top / height by setStack.
    root.style.position = 'absolute';
    root.style.left = `${HUD_EDGE_PX}px`;
    root.style.width = `${HUD_COLUMN_WIDTH_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'none';
    root.style.overflow = 'hidden';
    root.setAttribute(MODE_ATTR, 'hidden');       // placed by the first setStack
    root.setAttribute(STACK_HIDDEN_ATTR, '');

    const slots = mk('div', 'orbit-slots');
    slots.appendChild(mk('div', 'orbit-head', 'ORBIT'));

    // Row 1: LAT · LON · ALT (+ trend) — two rows inside 280 (rev 3).
    const r1 = mk('div', 'orbit-row');
    r1.appendChild(cell('LAT', 'lat', false).cell);
    r1.appendChild(cell('LON', 'lon', false).cell);
    const alt = cell('ALT', null, false);
    alt.value.appendChild(span('orbit-text', 'alt', PLACEHOLDER));
    unitSplit('alt');
    const trend = span('orbit-trend', 'alt-trend', '');
    alt.value.appendChild(trend);
    r1.appendChild(alt.cell);

    // Row 2: SUN (state word + timer, two cells) · MET
    const r2 = mk('div', 'orbit-row');
    const sun = cell('SUN', null, true);
    sun.value.appendChild(span('orbit-text', 'sunState', PLACEHOLDER));
    sun.value.appendChild(span('orbit-text', 'sunTimer', PLACEHOLDER));
    r2.appendChild(sun.cell);
    r2.appendChild(cell('MET', 'met', false).cell);

    slots.appendChild(r1); slots.appendChild(r2);
    root.appendChild(slots);
    parent.appendChild(root);

    this._root = root;
    this._el = { slots, cells, units, trend };
  }

  /** @private The one <style id="orbit-pane-style"> (per document). No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(ORBIT_STYLE_ID))) return;
    const G = ORBIT_GEOMETRY;
    const style = doc.createElement('style');
    style.id = ORBIT_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar rides in from .hud-panel (the --font-mono token,
       * PLAYER green on the dark 0.95 panel, the 1 px border). */
      #${ORBIT_PANE_ID} {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        pointer-events: none;
        box-sizing: border-box;
        overflow: hidden;
        white-space: nowrap;
        width: ${HUD_COLUMN_WIDTH_PX}px;
        transition: top ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING};
      }
      /* The rung's ONE bit (HUD's global rule carries it too; this belt keeps
       * the pane honest when it stands alone). */
      #${ORBIT_PANE_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* Layout-hidden (LeftStack). The density bit is untouched. */
      #${ORBIT_PANE_ID}[${STACK_HIDDEN_ATTR}] { display: none !important; }
      /* Mode 'hidden': no room in the left stack. The density bit is untouched. */
      #${ORBIT_PANE_ID}[${MODE_ATTR}="hidden"] { display: none !important; }
      #${ORBIT_PANE_ID} .orbit-slots {
        flex: 0 0 ${G.SLOTS_W_PX}px; width: ${G.SLOTS_W_PX}px;
        display: flex; flex-direction: column; justify-content: space-between;
      }
      #${ORBIT_PANE_ID} .orbit-head {
        font: 11px/${G.HEADER_PX}px var(--font-mono);
        font-variant: small-caps; letter-spacing: 0.12em; opacity: 0.6;
        height: ${G.HEADER_PX}px;
      }
      #${ORBIT_PANE_ID} .orbit-row { display: flex; gap: ${G.CELL_GAP_PX}px; }
      /* Fixed cell widths: the digits never jump. */
      #${ORBIT_PANE_ID} .orbit-cell { flex: 0 0 ${G.CELL_W_PX}px; width: ${G.CELL_W_PX}px; overflow: hidden; }
      #${ORBIT_PANE_ID} .orbit-cell-2 {
        flex: 0 0 ${2 * G.CELL_W_PX + G.CELL_GAP_PX}px; width: ${2 * G.CELL_W_PX + G.CELL_GAP_PX}px;
      }
      #${ORBIT_PANE_ID} .orbit-label {
        font: ${G.LABEL_PX}px/${G.LABEL_PX}px var(--font-mono);
        letter-spacing: 0.08em; opacity: 0.55; height: ${G.LABEL_PX}px;
      }
      /* White telemetry (owner 2026-09-08): the numerals wear LABEL white — the
       * SpaceX-overlay / ISS-tracker grammar; the labels above them keep the
       * panel's dim green. Colour below this line is STATE only (CAUTION). */
      #${ORBIT_PANE_ID} .orbit-value {
        font: ${G.VALUE_FONT_PX}px/${G.VALUE_PX}px var(--font-mono);
        font-variant-numeric: tabular-nums;
        height: ${G.VALUE_PX}px;
        display: flex; align-items: center;
        color: ${COLORS.LABEL};
      }
      #${ORBIT_PANE_ID} .orbit-cell-2 .orbit-value { gap: ${G.CELL_GAP_PX}px; }
      #${ORBIT_PANE_ID} .orbit-cell-2 .orbit-text { flex: 0 0 ${G.CELL_W_PX}px; width: ${G.CELL_W_PX}px; }
      /* The unit after the number, lighter (opacity has no metric: the cell
       * widths are untouched); white-space pre keeps its leading space at a flex line start. */
      #${ORBIT_PANE_ID} .orbit-unit { opacity: 0.6; white-space: pre; }
      #${ORBIT_PANE_ID} .orbit-trend { display: inline-block; width: 1ch; }
      #${ORBIT_PANE_ID} .orbit-trend[${TREND_ATTR}="down"] { color: ${COLORS.CAUTION}; }
      /* The change flash (slow slots only): a white BLOOM — a text-shadow glow
       * that fades over CHANGE_FLASH_MS and holds its end state (forwards) until
       * the attribute clears at the next tick. Not a colour change: the values
       * are already white and PLAYER green is a state. The static glow below is
       * what remains under reduced motion (steady for the window, no animation). */
      #${ORBIT_PANE_ID} [${CHANGED_ATTR}] {
        animation: orbit-pane-flash ${CHANGE_FLASH_MS}ms ease-out forwards;
        text-shadow: 0 0 8px ${COLORS.LABEL}, 0 0 4px ${COLORS.LABEL};
      }
      @keyframes orbit-pane-flash {
        from { text-shadow: 0 0 8px ${COLORS.LABEL}, 0 0 4px ${COLORS.LABEL}; }
        to   { text-shadow: 0 0 0 transparent; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${ORBIT_PANE_ID} [${CHANGED_ATTR}] { animation: none !important; }
        /* Rev 3: the rider's top glide (the left-arm reflow) is off too. */
        #${ORBIT_PANE_ID} { transition: none; }
      }
    `;
    doc.head.appendChild(style);
  }

  // ── Reads (every one guarded) ──────────────────────────────────────────────

  /** @private Call a dep, swallowing throws (undefined on failure / absence). */
  _read(fn) {
    if (typeof fn !== 'function') return undefined;
    try { return fn(); } catch (_e) { return undefined; }
  }

  /** @private A player method result (undefined when absent / throwing). */
  _playerRead(name) {
    const p = this._player;
    if (!p || typeof p[name] !== 'function') return undefined;
    try { return p[name](); } catch (_e) { return undefined; }
  }

  /** @private { rate, baseScale } from the clock dep (defaults 1 / 1). */
  _clockNow() {
    const c = this._read(this._clock);
    const rate = c ? num(c.rate) : null;
    const base = c ? num(c.baseScale) : null;
    return { rate: rate == null ? 1 : rate, baseScale: base == null ? 1 : base };
  }

  /** @private The future-sun function: sunDirAt, else a still sun from sunDir, else null. */
  _sunDirAtFn() {
    if (this._sunDirAt) return this._sunDirAt;
    if (this._sunDir) {
      return (_ahead, out) => {
        const d = this._read(this._sunDir);
        if (!d) return null;
        out.x = d.x; out.y = d.y; out.z = d.z;
        return out;
      };
    }
    return null;
  }

  /** @private A percentage string with one decimal. */
  _pct(frac) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    return (Math.round(f * 1000) / 10).toString();
  }

  // ── Compute (per tick, visible or not) ─────────────────────────────────────

  /** @private Recompute every readout string + the eclipse cache from the deps. */
  _compute(dtS) {
    const F = ORBIT_FMT;
    const v = { ...EMPTY_VALS };

    const els = this._playerRead('getOrbitalElements');
    const orbit = (els && typeof els === 'object' && num(els.semiMajorAxis) != null) ? els : null;
    const altKm = num(this._playerRead('getAltitudeKm'));
    const vel = this._playerRead('getVelocity');
    const pos = this._playerRead('getPosition');
    const clock = this._clockNow();

    v.alt = F.alt(altKm);
    v.trend = this._trend(altKm, dtS);
    if (vel && typeof vel === 'object') {
      const vx = num(vel.x), vy = num(vel.y), vz = num(vel.z);
      if (vx != null && vy != null && vz != null) v.vel = F.vel(Math.sqrt(vx * vx + vy * vy + vz * vz));
    }
    if (orbit) {
      v.inc = F.inc(num(orbit.inclination));
      v.period = F.mmss(this._periodS(orbit));
    }
    if (pos && typeof pos === 'object' && num(pos.x) != null && num(pos.y) != null && num(pos.z) != null) {
      const sp = subSatellitePoint(pos);
      v.lat = F.lat(sp.latDeg);
      v.lon = F.lon(sp.lonEastDeg);
    }

    // Eclipse: the predictor rotates BOTH the orbit (world time) and the sun (real time).
    const sunDirAt = this._sunDirAtFn();
    let pred = null;
    if (orbit && sunDirAt) {
      try {
        const kmOrbit = orbitToKm(orbit);
        const r = nextShadowTransition(kmOrbit, sunDirAt, {
          rate: clock.rate, baseScale: clock.baseScale, earthRadius: Constants.EARTH_RADIUS_KM,
        });
        pred = r || null;
      } catch (_e) { pred = null; }
    }
    const dep = this._read(this._inShadow);
    const inShadow = typeof dep === 'boolean' ? dep : (pred ? pred.inShadow : null);
    const scale = clock.rate * clock.baseScale;
    const flipWorld = (pred && pred.secondsToFlipReal != null && scale > 0) ? pred.secondsToFlipReal * scale : null;
    this._eclipse = Object.freeze({ inShadow: !!inShadow, secondsToFlip: flipWorld });
    v.sunState = inShadow == null ? PLACEHOLDER : (inShadow ? 'SHADOW' : 'SUNLIT');
    v.sunTimer = flipWorld == null ? PLACEHOLDER : F.mmss(flipWorld);

    // ΔV: usable = budget × (1 − reserve); the bar's fill = usable / budget.
    const budget = this._read(this._budget);
    const dvBudget = budget && typeof budget === 'object' ? num(budget.deltaV) : null;
    if (dvBudget != null) {
      const usable = usableDeltaV(budget, this._reserveFrac);
      v.dv = F.dv(usable);
      v.dvFill = `${dvBudget > 0 ? this._pct(usable / dvBudget) : '0'}%`;
    }

    v.met = F.met(num(this._read(this._missionTime)));
    this._vals = v;
  }

  /** @private Orbital period in world seconds: 2π / meanMotion, else 2π√(a³/μ) from the km sma. */
  _periodS(orbit) {
    const n = num(orbit.meanMotion);
    if (n != null && n > 0) return 2 * Math.PI / n;
    const aKm = num(orbit.semiMajorAxis) / Constants.SCENE_SCALE;
    if (!(aKm > 0)) return null;
    return 2 * Math.PI * Math.sqrt(aKm * aKm * aKm / Constants.MU_EARTH);
  }

  /**
   * @private The ALT trend arrow from an EMA of Δalt/Δt (km per real second)
   * — DockingReticle._easeOdds' 0.85 / 0.15 — against ALT_TREND_KM_PER_S.
   * @returns {string} ARROW_DOWN | ARROW_UP | ''
   */
  _trend(altKm, dtS) {
    const T = this._trendState;
    if (altKm == null) { T.last = null; T.rate = 0; return ''; }
    if (T.last != null && dtS > 0) {
      const inst = (altKm - T.last) / dtS;
      T.rate = T.rate * TREND_EMA + inst * (1 - TREND_EMA);
    }
    T.last = altKm;
    if (T.rate < -ALT_TREND_KM_PER_S) return ARROW_DOWN;
    if (T.rate > ALT_TREND_KM_PER_S) return ARROW_UP;
    return '';
  }

  // ── Paint (per tick; DOM writes only while visible, write-on-change) ───────

  /** @private true when the root is on screen for the DOM writes to matter. */
  _paintable() {
    const root = this._root;
    if (!root || this._mode === 'hidden') return false;
    return !(root.hasAttribute && root.hasAttribute(DENSITY_HIDDEN_ATTR));
  }

  /** @private Write the computed strings (write-on-change), mark / clear the flashes, sync the MFD. */
  _paint(nowMs) {
    const v = this._vals;
    const prev = this._prev;
    const visible = this._paintable();
    if (prev && visible) {
      for (const key of SLOW_SLOTS) {
        if (prev[key] !== PLACEHOLDER && v[key] !== prev[key]) this._flashUntil[key] = nowMs + CHANGE_FLASH_MS;
      }
    }
    this._prev = v;
    if (!visible) return;

    const el = this._el;
    const cells = el.cells;
    const units = el.units;
    for (const key of ['alt', 'lat', 'lon', 'sunState', 'sunTimer', 'met']) {
      if (units && units[key]) this._setUnitText(units[key], v[key]);
      else this._setText(cells[key], v[key]);
    }
    this._setText(el.trend, v.trend);
    this._setAttr(el.trend, TREND_ATTR, v.trend === ARROW_DOWN ? 'down' : (v.trend === ARROW_UP ? 'up' : null));
    for (const key of SLOW_SLOTS) {
      const until = this._flashUntil[key];
      const on = until != null && nowMs < until;
      if (!on && until != null) delete this._flashUntil[key];
      this._setAttr(cells[key], CHANGED_ATTR, on ? '' : null);
    }
  }

  // ── Layout (setStack; write-on-change outputs) ─────────────────────────────

  /** @private Place the pane from the cached stack inputs. No layout reads. Sets top BEFORE un-hiding. */
  _layout() {
    const root = this._root;
    if (!root || !Number.isFinite(this._stackTop)) return;
    const stack = this._stackMode;
    const hidden = stack === 'hidden';
    const orbitMode = hidden ? 'hidden' : 'full';
    const top = Math.round(this._stackTop);
    const h = hidden ? 0 : Math.round(Math.max(0, this._stackH));
    this._setStyle(root, 'top', `${top}px`);
    if (orbitMode !== this._mode) {
      this._mode = orbitMode;
      root.setAttribute(MODE_ATTR, orbitMode);
    }
    if (hidden) {
      if (!root.hasAttribute(STACK_HIDDEN_ATTR)) root.setAttribute(STACK_HIDDEN_ATTR, '');
    } else {
      if (root.hasAttribute(STACK_HIDDEN_ATTR)) root.removeAttribute(STACK_HIDDEN_ATTR);
      this._setStyle(root, 'height', `${h}px`);
    }
  }

  // ── Write-on-change helpers ────────────────────────────────────────────────

  /** @private */
  _setText(el, text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
  }

  /** @private The unit split: the formatter string lands as `.orbit-num` + `.orbit-unit` (write-on-change each;
   *  the slot element's own textContent is never written — it IS the two spans, so it reads the whole string). */
  _setUnitText(pair, text) {
    const parts = splitUnit(text);
    const a = this._setText(pair.num, parts.num);
    const b = this._setText(pair.unit, parts.unit);
    return a || b;
  }

  /** @private */
  _setStyle(el, prop, value) {
    if (!el || !el.style || el.style[prop] === value) return false;
    el.style[prop] = value;
    return true;
  }

  /** @private set (value string) or remove (null) an attribute, only when it differs. */
  _setAttr(el, name, value) {
    if (!el || !el.setAttribute) return false;
    const have = el.hasAttribute && el.hasAttribute(name) ? el.getAttribute(name) : null;
    if (have === value) return false;
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, value);
    return true;
  }
}

export default OrbitPane;
