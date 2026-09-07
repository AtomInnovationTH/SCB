/**
 * OrbitPane.js — the ORBIT HUD pane (Session M, item 1, 2026-09-06).
 *
 * The ship's orbit as a flight instrument: a TRACK view (the OrbitMFD plot,
 * mounted into a 126 px square) beside a SLOTS block — a header line and a
 * 3 × 4 grid of fixed-width readouts:
 *
 *   ALT (+ trend arrow) · VEL · INC · PERIOD
 *   LAT · LON · SUN (state word + time to the next terminator crossing)
 *   ΔV (usable + a 2-px bar with the reserve marker) · MET
 *
 * It is a pane-density RUNG like the other DOM panes: `rung()` returns the HUD
 * domRung shape ({id:'orbit', label, isVisible, setVisible}) whose ONE
 * visibility bit is the `data-density-hidden` attribute on the root, so the
 * DISPLAY rail lists it as a notch and FloorMask rooms it per floor.
 *
 * HOME (owner 2026-09-07; before that: right of the DISPLAY rail): bottom-left,
 * FLUSH with the left HUD column (x = EDGE_PX 10), UNDER the DISPLAY rail and
 * ABOVE the hint ticker — so the bottom-centre stays free for the SAFETY
 * OVERRIDE button. The hub (main.js, inside the LADDER gate) constructs the
 * pane, pushes `rung()` into hud.paneDensity.rungs before the first
 * floorMask.setFloor, and calls `setAnchor(EDGE_PX − GAP_PX, floorPx,
 * paneRail.bottomPx())` once per frame with cached numbers and `update(nowMs)`
 * per frame. setAnchor is write-on-change on its three inputs; every edge of
 * the root comes from it (left = leftEdge + GAP; the bottom edge = floor − GAP,
 * placed via top = bottom − the mode's fixed height — pure arithmetic, no
 * layout read). Modes by the vertical budget between the ceiling (the rail's
 * bottom + GAP, or the screen top) and the bottom edge: `full` (track + slots,
 * 140 tall) when ≥ 140, `compact` (slots only, 104) when ≥ 104, else `hidden`
 * (display none via the `data-orbit-mode` attribute — never the rung bit). The
 * left-edge cascade: the column (top-anchored) → the rail (dodges under it) →
 * this pane fills what is left, compacting, then hiding — the CARGO / NEXT law.
 *
 * UPDATE: `update(nowMs)` self-throttles to one tick per second; every tick
 * recomputes the readouts from the injected deps and writes text / style /
 * attributes only when a value changed. The eclipse prediction (`eclipse()`)
 * is recomputed EVEN WHILE density-hidden (another pane consumes it) — only
 * the DOM writes are skipped. The slow slots (INC, PERIOD, the SUN word, ΔV)
 * flash on change (`data-changed` for 1.2 s, a CSS keyframe from SELECTION
 * white back to inherit); the per-second slots never flash.
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
import { orbitToKm, subSatellitePoint, nextShadowTransition } from '../../entities/OrbitalMechanics.js';
import { RESERVE_FRAC, usableDeltaV } from '../../entities/ReachabilityModel.js';

/** The six-colour law (read-only): CAUTION amber for the reserve tick / decay arrow, SELECTION white for the flash. */
const COLORS = VisualLaw.COLORS;

/** The root element id (FloorMask MASK_PANES.orbit.els = ['#hud-orbit-pane']). */
export const ORBIT_PANE_ID = 'hud-orbit-pane';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const ORBIT_STYLE_ID = 'orbit-pane-style';

/** The pane-density rung id (FloorMask MASK_PANES.orbit.rung). */
export const ORBIT_RUNG_ID = 'orbit';

/**
 * ORBIT_GEOMETRY — the pane's numbers (px). FULL_PX is the hard height budget
 * (on the 13-inch iPad the pane spans y 760–900 under the thumb rest / above
 * the ticker band); FRAME_PX is the .hud-panel chrome (6 px padding + 1 px
 * border, top and bottom); TRACK_PX = FULL − FRAME is the OrbitMFD square;
 * the slots block is 4 cells of CELL_W_PX with CELL_GAP_PX between (SLOTS_W_PX),
 * a HEADER_PX line and three rows of LABEL_PX + VALUE_PX with ROW_GAP_PX
 * between (slotsPx()); COMPACT_PX = FRAME + slotsPx() is the slots-only form.
 */
export const ORBIT_GEOMETRY = Object.freeze({
  GAP_PX: 8,
  FULL_PX: 140,
  FRAME_PX: 14,
  TRACK_PX: 126,
  BLOCK_GAP_PX: 8,
  CELL_W_PX: 66,
  CELL_GAP_PX: 6,
  SLOTS_W_PX: 282,
  HEADER_PX: 12,
  LABEL_PX: 10,
  VALUE_PX: 14,
  ROW_GAP_PX: 2,
  COMPACT_PX: 104,
});

/** Minimum ms between two update() ticks (the 1 Hz law). */
export const TICK_MS = 1000;

/** How long a slow slot wears `data-changed` after its string changed (ms). */
export const CHANGE_FLASH_MS = 1200;

/**
 * ALT trend threshold, km per REAL second of smoothed altitude rate. Derived
 * from the game's drag: PlayerSatellite integrates atmosphericDrag(alt, v,
 * 20 m², 130 kg) as sma *= 1 − 2·a·dt/v per world second; at 400 km (ρ =
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
const MODE_ATTR = 'data-orbit-mode';
/** The .hud-panel chrome a side, horizontally: 8 px padding + 1 px border (SAFETY OVERRIDE rightPx). */
const H_CHROME_PX = 18;
const CHANGED_ATTR = 'data-changed';
const TREND_ATTR = 'data-trend';
const ARROW_DOWN = '\u2193';
const ARROW_UP = '\u2191';

/** The slots whose string change flashes (the per-second slots never do). */
const SLOW_SLOTS = Object.freeze(['inc', 'period', 'sunState', 'dv']);

/** The slots block's inner height: header + gap + three rows with two gaps. */
export function slotsPx() {
  const G = ORBIT_GEOMETRY;
  return G.HEADER_PX + G.ROW_GAP_PX + 3 * (G.LABEL_PX + G.VALUE_PX) + 2 * G.ROW_GAP_PX;
}

/** The compact form's outer height (frame + the slots block). */
export function compactPx() {
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
   * @param {object}   [deps.orbitMFD]      an OrbitMFD (mount / unmount / show / hide / isShown) or null
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
    this._mfd = deps.orbitMFD || null;

    this._root = null;
    this._el = null;                 // { track, slots, cells: {slot → value el}, trend, bar, fill, mark }
    this._rung = null;
    this._mode = 'hidden';           // until the first setAnchor places the pane
    this._leftPx = undefined;        // last setAnchor inputs (write-on-change)
    this._ceilingPx = undefined;
    this._floorPx = undefined;
    this._lastTickMs = null;
    this._vals = { ...EMPTY_VALS };  // the strings computed by the last tick
    this._prev = null;               // the previous tick's strings (change detection)
    this._flashUntil = Object.create(null);   // slot → ms
    this._trendState = { last: null, rate: 0 };
    this._eclipse = NO_ECLIPSE;
    this._sunScratch = { x: 0, y: 0, z: 0 };
    this._mfdMounted = false;
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
          this._syncMfd();
        },
      };
    }
    return this._rung;
  }

  /**
   * THE ANCHOR (the hub calls it per frame with cached numbers). `leftEdgePx`
   * = the right edge of what sits to the pane's left (owner 2026-09-07: the
   * pane rides FLUSH-LEFT under the DISPLAY rail, lined up with the left HUD
   * column — the hub passes EDGE_PX − GAP_PX so `left` lands on the column's
   * x; before that it was the rail's rightPx()); `floorPx` = the lowest allowed
   * bottom edge (min of the thumb rest and the ticker band); `ceilingPx`
   * (optional, owner 2026-09-07) = the bottom edge of what sits ABOVE the pane
   * (the DISPLAY rail's cached bottomPx()) — null / non-finite = the screen
   * top. Write-on-change on the three inputs: repeated identical inputs return
   * before any DOM access. Pure arithmetic, no layout read:
   *   left   = leftEdgePx + GAP_PX
   *   bottom = floorPx − GAP_PX
   *   budget = bottom − (ceilingPx + GAP_PX | 0);  mode = full (budget ≥ FULL_PX) | compact (≥ COMPACT_PX) | hidden
   *   top    = bottom − the mode's height (FULL_PX | COMPACT_PX)
   * The cascade on the left edge: the HUD column (top-anchored) → the rail
   * (dodges under the column) → this pane fills what is left at the bottom,
   * compacting, then hiding, when squeezed — the CARGO / NEXT law on the right.
   * Writes data-orbit-mode, left, top and height.
   * @param {number} leftEdgePx
   * @param {number} floorPx
   * @param {number|null} [ceilingPx]
   */
  setAnchor(leftEdgePx, floorPx, ceilingPx = null) {
    if (this._disposed || !this._root) return;
    const left = Number(leftEdgePx);
    const floor = Number(floorPx);
    if (!Number.isFinite(left) || !Number.isFinite(floor)) return;
    const c = Number(ceilingPx);
    const ceiling = (ceilingPx == null || !Number.isFinite(c)) ? null : c;
    if (left === this._leftPx && floor === this._floorPx && ceiling === this._ceilingPx) return;   // write-on-change (inputs)
    this._leftPx = left;
    this._floorPx = floor;
    this._ceilingPx = ceiling;
    this._layout();
  }

  /**
   * The 1 Hz tick: at most one tick per TICK_MS; recomputes every readout from
   * the deps (the eclipse prediction even while hidden), writes the DOM only
   * when visible and only what changed, and keeps the OrbitMFD's show() in
   * force while the TRACK view is wanted.
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

  /** The current mode: 'full' | 'compact' | 'hidden' ('hidden' until the first setAnchor, and headless). */
  mode() { return this._mode; }

  /**
   * SAFETY OVERRIDE (owner 2026-09-07): the pane's placed RIGHT edge (CSS px)
   * while it is on screen — placed by setAnchor, mode not 'hidden', density
   * bit clear — else null. Pure arithmetic over the anchor + the mode's fixed
   * width (TRACK + BLOCK_GAP + SLOTS in full, SLOTS in compact, plus the
   * .hud-panel chrome: 8 px padding + 1 px border a side); one attribute read,
   * never a layout read. The OVERRIDE panel centres itself in the band right
   * of this edge (the hub's gameLoop wire), so the two never overlap.
   * @returns {number|null}
   */
  rightPx() {
    const el = this._root;
    if (!el || this._disposed || this._mode === 'hidden' || !Number.isFinite(this._leftPx)) return null;
    if (el.hasAttribute && el.hasAttribute(DENSITY_HIDDEN_ATTR)) return null;
    const G = ORBIT_GEOMETRY;
    const inner = this._mode === 'compact' ? G.SLOTS_W_PX : (G.TRACK_PX + G.BLOCK_GAP_PX + G.SLOTS_W_PX);
    return Math.round(this._leftPx + G.GAP_PX) + inner + H_CHROME_PX;
  }

  /** The strings the last tick computed (a copy): alt, trend, vel, inc, period, lat, lon, sunState, sunTimer, dv, dvFill, met. */
  readout() { return { ...this._vals }; }

  /** Hide + unmount the OrbitMFD, remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const m = this._mfd;
    if (m && this._mfdMounted) {
      try { if (typeof m.hide === 'function') m.hide(); } catch (_e) { /* stub */ }
      try { if (typeof m.unmount === 'function') m.unmount(); } catch (_e) { /* stub */ }
    }
    this._mfdMounted = false;
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

    const root = mk('div', 'hud-panel' + (this._glass ? ' orbit-glass' : ''));
    root.id = ORBIT_PANE_ID;
    // Geometry: left / top / height are written ONLY by setAnchor.
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'none';
    root.style.overflow = 'hidden';
    root.setAttribute(MODE_ATTR, 'hidden');       // placed by the first setAnchor

    const track = mk('div', 'orbit-track');
    const slots = mk('div', 'orbit-slots');
    slots.appendChild(mk('div', 'orbit-head', 'ORBIT'));

    // Row 1: ALT (+ trend) · VEL · INC · PERIOD
    const r1 = mk('div', 'orbit-row');
    const alt = cell('ALT', null, false);
    alt.value.appendChild(span('orbit-text', 'alt', PLACEHOLDER));
    const trend = span('orbit-trend', 'alt-trend', '');
    alt.value.appendChild(trend);
    r1.appendChild(alt.cell);
    r1.appendChild(cell('VEL', 'vel', false).cell);
    r1.appendChild(cell('INC', 'inc', false).cell);
    r1.appendChild(cell('PERIOD', 'period', false).cell);

    // Row 2: LAT · LON · SUN (state word + timer)
    const r2 = mk('div', 'orbit-row');
    r2.appendChild(cell('LAT', 'lat', false).cell);
    r2.appendChild(cell('LON', 'lon', false).cell);
    const sun = cell('SUN', null, true);
    sun.value.appendChild(span('orbit-text', 'sunState', PLACEHOLDER));
    sun.value.appendChild(span('orbit-text', 'sunTimer', PLACEHOLDER));
    r2.appendChild(sun.cell);

    // Row 3: ΔV (value + bar with the reserve marker) · MET
    const r3 = mk('div', 'orbit-row');
    const dv = cell('\u0394V', null, true);
    dv.value.appendChild(span('orbit-text', 'dv', PLACEHOLDER));
    const bar = mk('div', 'orbit-bar');
    if (bar.setAttribute) bar.setAttribute('data-slot', 'dv-bar');
    const fill = mk('div', 'orbit-bar-fill');
    const mark = mk('div', 'orbit-bar-mark');
    fill.style.width = '0%';
    mark.style.left = `${this._pct(1 - this._reserveFrac)}%`;
    bar.appendChild(fill); bar.appendChild(mark);
    dv.value.appendChild(bar);
    r3.appendChild(dv.cell);
    r3.appendChild(cell('MET', 'met', true).cell);

    slots.appendChild(r1); slots.appendChild(r2); slots.appendChild(r3);
    root.appendChild(track); root.appendChild(slots);
    parent.appendChild(root);

    this._root = root;
    this._el = { track, slots, cells, trend, bar, fill, mark };
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
        gap: ${G.BLOCK_GAP_PX}px;
        pointer-events: none;
        box-sizing: border-box;
        overflow: hidden;
        white-space: nowrap;
      }
      /* The rung's ONE bit (HUD's global rule carries it too; this belt keeps
       * the pane honest when it stands alone). */
      #${ORBIT_PANE_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* Mode 'hidden': no room above the floor (setAnchor). The density bit is untouched. */
      #${ORBIT_PANE_ID}[${MODE_ATTR}="hidden"] { display: none !important; }
      /* Compact: the slots only; the TRACK square folds away. */
      #${ORBIT_PANE_ID}[${MODE_ATTR}="compact"] .orbit-track { display: none; }
      #${ORBIT_PANE_ID} .orbit-track {
        flex: 0 0 ${G.TRACK_PX}px; width: ${G.TRACK_PX}px; height: ${G.TRACK_PX}px;
        position: relative; overflow: hidden;
      }
      #${ORBIT_PANE_ID} .orbit-track > canvas { display: block; }
      #${ORBIT_PANE_ID} .orbit-slots {
        flex: 0 0 ${G.SLOTS_W_PX}px; width: ${G.SLOTS_W_PX}px;
        display: flex; flex-direction: column; justify-content: space-between;
      }
      #${ORBIT_PANE_ID} .orbit-head {
        font: 10px/${G.HEADER_PX}px var(--font-mono);
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
        font: 9px/${G.LABEL_PX}px var(--font-mono);
        letter-spacing: 0.08em; opacity: 0.55; height: ${G.LABEL_PX}px;
      }
      #${ORBIT_PANE_ID} .orbit-value {
        font: 13px/${G.VALUE_PX}px var(--font-mono);
        font-variant-numeric: tabular-nums;
        height: ${G.VALUE_PX}px;
        display: flex; align-items: center; gap: ${G.CELL_GAP_PX}px;
      }
      #${ORBIT_PANE_ID} .orbit-cell-2 .orbit-text { flex: 0 0 ${G.CELL_W_PX}px; width: ${G.CELL_W_PX}px; }
      #${ORBIT_PANE_ID} .orbit-trend { display: inline-block; width: 1ch; }
      #${ORBIT_PANE_ID} .orbit-trend[${TREND_ATTR}="down"] { color: ${COLORS.CAUTION}; }
      /* The ΔV bar: usable / budget as the fill, the reserve boundary as a tick. */
      #${ORBIT_PANE_ID} .orbit-bar {
        position: relative; flex: 0 0 ${G.CELL_W_PX - 6}px; width: ${G.CELL_W_PX - 6}px; height: 2px;
        background: rgba(0, 255, 136, 0.15);
      }
      #${ORBIT_PANE_ID} .orbit-bar-fill { position: absolute; left: 0; top: 0; height: 2px; width: 0%; background: ${COLORS.PLAYER}; }
      #${ORBIT_PANE_ID} .orbit-bar-mark { position: absolute; top: -2px; width: 1px; height: 6px; background: ${COLORS.CAUTION}; }
      /* The change flash (slow slots only): bright, then back to the inherited colour. */
      #${ORBIT_PANE_ID} [${CHANGED_ATTR}] { animation: orbit-pane-flash ${CHANGE_FLASH_MS}ms ease-out; }
      @keyframes orbit-pane-flash { from { color: ${COLORS.SELECTION}; } to { color: inherit; } }
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
    this._syncMfd();
    if (!visible) return;

    const el = this._el;
    const cells = el.cells;
    for (const key of ['alt', 'vel', 'inc', 'period', 'lat', 'lon', 'sunState', 'sunTimer', 'dv', 'met']) {
      this._setText(cells[key], v[key]);
    }
    this._setText(el.trend, v.trend);
    this._setAttr(el.trend, TREND_ATTR, v.trend === ARROW_DOWN ? 'down' : (v.trend === ARROW_UP ? 'up' : null));
    this._setStyle(el.fill, 'width', v.dvFill);
    for (const key of SLOW_SLOTS) {
      const until = this._flashUntil[key];
      const on = until != null && nowMs < until;
      if (!on && until != null) delete this._flashUntil[key];
      this._setAttr(cells[key], CHANGED_ATTR, on ? '' : null);
    }
  }

  /**
   * @private The OrbitMFD follows the pane: mounted into the TRACK square on
   * first need, show() re-asserted whenever the TRACK view is wanted (mode
   * full, not density-hidden) and the MFD reports hidden (it hides itself on
   * GAME_STATE_CHANGE out of gameplay), hide() when it is not.
   */
  _syncMfd() {
    const m = this._mfd;
    if (!m || this._disposed || !this._root || !this._el) return;
    const want = this._mode === 'full' && this._paintable();
    try {
      if (want) {
        if (!this._mfdMounted) {
          if (typeof m.mount !== 'function') return;
          m.mount(this._el.track, ORBIT_GEOMETRY.TRACK_PX);
          this._mfdMounted = true;
        }
        const shown = typeof m.isShown === 'function' ? m.isShown() : false;
        if (!shown && typeof m.show === 'function') m.show();
      } else if (this._mfdMounted) {
        const shown = typeof m.isShown === 'function' ? m.isShown() : true;
        if (shown && typeof m.hide === 'function') m.hide();
      }
    } catch (_e) { /* a stub MFD */ }
  }

  // ── Layout (setAnchor; pure arithmetic, write-on-change outputs) ───────────

  /** @private Place the pane from the cached anchor inputs. No layout reads. */
  _layout() {
    const root = this._root;
    if (!root || !Number.isFinite(this._floorPx) || !Number.isFinite(this._leftPx)) return;
    const G = ORBIT_GEOMETRY;
    const bottom = this._floorPx - G.GAP_PX;      // the bottom edge
    // The vertical budget: down from the ceiling (the rail's bottom + GAP) or,
    // with no ceiling, from the screen top (owner 2026-09-07).
    const budget = bottom - (this._ceilingPx != null ? this._ceilingPx + G.GAP_PX : 0);
    let mode, h;
    if (budget >= G.FULL_PX) { mode = 'full'; h = G.FULL_PX; }
    else if (budget >= G.COMPACT_PX) { mode = 'compact'; h = G.COMPACT_PX; }
    else { mode = 'hidden'; h = 0; }
    if (mode !== this._mode) {
      this._mode = mode;
      root.setAttribute(MODE_ATTR, mode);
    }
    if (mode !== 'hidden') {
      this._setStyle(root, 'left', `${Math.round(this._leftPx + G.GAP_PX)}px`);
      this._setStyle(root, 'top', `${Math.round(bottom - h)}px`);
      this._setStyle(root, 'height', `${h}px`);
    }
    this._syncMfd();
  }

  // ── Write-on-change helpers ────────────────────────────────────────────────

  /** @private */
  _setText(el, text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
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
