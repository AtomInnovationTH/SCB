/**
 * NextPane.js — the NEXT HUD pane (Session M item 3, 2026-09-06): upcoming
 * events, four FIXED row slots, one T-minus each.
 *
 *   TRANSFER  <cluster>   T-12m40s | OPEN NOW   the soonest transfer window
 *   TCA       <threat>    T-42s · 0.3 km        the current conjunction (amber; tier RED red)
 *   SHADOW|SUNLIT  in     08:11                 the next eclipse flip
 *   PASS      <station>   T-21m00s              the next ground-station pass
 *
 * It is a pane-density RUNG like CARGO: `rung()` returns the HUD domRung shape
 * ({id:'next', label, isVisible, setVisible}) whose ONE visibility bit is the
 * `data-density-hidden` attribute on the root, so the DETAIL slider counts it as a
 * notch and FloorMask rooms it per floor (MASK_PANES.next). This pane is NOT
 * the focused-cluster transfer readout costume (that one is the FULL readout of
 * ONE cluster); this is the soonest of everything, in one glance.
 *
 * Wiring (the hub's, main.js inside the LADDER gate): construct with the deps
 * below, push `pane.rung()` into hud.paneDensity.rungs BEFORE the first
 * floorMask.setFloor, call `update(nowMs)` per frame (self-throttled to 1 Hz)
 * and feed `setDodge(underPx, floorPx)` per frame with the bottom edge of what
 * rides above on the right edge (the SPECS tab or the WHERE rail) and the
 * lowest allowed bottom edge (the thumb-rest floor, or CARGO's top - GAP when
 * CARGO is visible). `topPx()` is this pane's top for the next link of the
 * edge chain — arithmetic, never a layout read.
 *
 * Laws: the root is a DIRECT child of #hud-overlay; NO backdrop-filter; NO
 * layout read anywhere (the heights are fixed numbers: FRAME + HEADER + rows);
 * the tick is self-throttled to >= TICK_MS from the `nowMs` it is handed (no
 * timer, no rAF of its own); every DOM write is write-on-change; textContent
 * only (no innerHTML); no window/document listeners; no fetch (the stations
 * arrive as a dep); the module never reads Constants.LADDER and never touches
 * the DOM at import time; every dep is optional and guarded, so `new
 * NextPane()` with no document is inert (rows read the unknown mark). Every
 * T-minus on this pane is WORLD seconds (departIn is orbit time, the eclipse
 * dep is world seconds, the pass is orbit time) — the same clock as the
 * transfer readout, never the boss countdowns' paced clock.
 *
 * @module ui/hud/NextPane
 */

import { Constants } from '../../core/Constants.js';
import { VisualLaw } from '../../core/VisualLaw.js';
import { computeTransferWindow, isCoOrbital, clusterToOrbitKm } from '../../entities/LaunchWindow.js';
import { propagateOrbit, keplerianToCartesian, orbitToKm } from '../../entities/OrbitalMechanics.js';
import { TransferWindows } from '../TransferWindows.js';

/** The root element id (FloorMask MASK_PANES.next.els = ['#hud-next-pane']). */
export const NEXT_PANE_ID = 'hud-next-pane';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const NEXT_STYLE_ID = 'next-pane-style';

/** The pane-density rung id (FloorMask MASK_PANES.next.rung). */
export const NEXT_RUNG_ID = 'next';

/** The fixed row slots, in DOM order (never reordered; compact FOLDS the two latest). */
export const NEXT_ROWS = Object.freeze(['transfer', 'tca', 'shadow', 'pass']);

/**
 * NEXT_GEOMETRY — the pane's numbers (px). FULL_MAX_PX is the hard budget the
 * full form must fit (the 13-inch iPad landscape slot above CARGO); FRAME_PX
 * is the .hud-panel chrome (6 px padding + 1 px border, top and bottom);
 * HEADER_PX the title line; ROW_PX one event row. The full form is header +
 * FULL_ROWS rows, the compact form header + COMPACT_ROWS (the soonest two).
 */
export const NEXT_GEOMETRY = Object.freeze({
  WIDTH_PX: 280,
  RIGHT_PX: 10,
  GAP_PX: 8,
  FULL_MAX_PX: 120,
  FRAME_PX: 14,
  HEADER_PX: 16,
  ROW_PX: 20,
  FULL_ROWS: 4,
  COMPACT_ROWS: 2,
});

/** The self-throttle: update(nowMs) recomputes at most once per TICK_MS. */
export const TICK_MS = 1000;

/** The change-highlight: `data-changed` rides on a row for FLASH_MS after its subject changed. */
export const FLASH_MS = 1200;

/** PASS: a ground-station pass is a sub-point within this great-circle distance (km). */
export const PASS_RADIUS_KM = 500;

/** PASS: the player orbit is propagated over ONE period in this many samples (the per-tick budget). */
export const PASS_STEPS = 64;

/** The unknown mark (em dash) — the value of every row the deps cannot fill. */
const UNKNOWN = '\u2014';

/** The rung's ONE hide bit (HUD._initPaneDensity domRung grammar). */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
/** The dodge's mode: 'full' | 'compact' | 'hidden' (hidden = display:none via the style). */
const MODE_ATTR = 'data-next-mode';
/** A row folded away by the compact form (the two latest events). */
const FOLDED_ATTR = 'data-folded';
/** A row whose subject just changed (the keyframe flash). */
const CHANGED_ATTR = 'data-changed';
/** The TCA row's colour channel: 'caution' (amber) | 'red' (the critical tier). */
const TIER_ATTR = 'data-tier';

const COLORS = VisualLaw.COLORS;
const EARTH_RADIUS_KM = Constants.EARTH_RADIUS_KM;
const MU = Constants.MU_EARTH;
const DEG = Math.PI / 180;

/** The full form's outer height: frame + header + FULL_ROWS rows. */
export function fullPx() {
  const G = NEXT_GEOMETRY;
  return G.FRAME_PX + G.HEADER_PX + G.FULL_ROWS * G.ROW_PX;
}

/** The compact form's outer height: frame + header + COMPACT_ROWS rows. */
export function compactPx() {
  const G = NEXT_GEOMETRY;
  return G.FRAME_PX + G.HEADER_PX + G.COMPACT_ROWS * G.ROW_PX;
}

/**
 * Great-circle distance (km) between two lat/lon points (degrees, east-positive).
 * @returns {number}
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = (lat2 - lat1) * DEG;
  const dl = (lon2 - lon1) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The SHADOW row's clock: mm:ss under an hour, else h:mm (world seconds).
 * @param {number} s
 * @returns {string}
 */
export function formatClock(s) {
  if (!Number.isFinite(s)) return UNKNOWN;
  const sec = Math.max(0, Math.round(s));
  if (sec < 3600) return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const h = Math.floor(sec / 3600);
  return `${h}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

/** @private A T-minus for an event that may be happening right now (TCA, PASS). */
function fmtTminus(s) {
  if (!Number.isFinite(s)) return UNKNOWN;
  return s > 0 ? TransferWindows.formatDuration(s) : 'NOW';
}

/** @private Metres to 1-decimal km. */
function fmtKm(m) {
  const n = num(m);                                 // null / '' are NOT zero (Session M review)
  return Number.isFinite(n) ? `${(Math.max(0, n) / 1000).toFixed(1)} km` : UNKNOWN;
}

/** @private Call a dep function defensively (absent / throwing dep = null). */
function call(fn) {
  if (typeof fn !== 'function') return null;
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch (_e) {
    return null;
  }
}

/** @private A finite number or NaN (null / undefined / '' are NOT zero). */
function num(x) {
  if (x == null || x === '') return NaN;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/** @private The empty row model (the unknown mark). */
function unknownRow(label, subject = '') {
  return { label, subject, value: UNKNOWN, seconds: Infinity, key: '', tier: null };
}

export class NextPane {
  /**
   * @param {object} [deps]  every dep optional and guarded
   * @param {Document|null} [deps.doc]  document (default: the global one; null = headless).
   * @param {Element}  [deps.parent]    root's parent (default: doc.getElementById('hud-overlay')).
   * @param {boolean}  [deps.glass]     true on glass (the pane is display-only: no touch target changes).
   * @param {function} [deps.now]       ms clock — the fallback when update() is called without nowMs.
   * @param {function} [deps.clusters]  () => [{ name, altKm }] (optionally orbitKm or a live
   *   cluster with `targets`) — the transfer candidates.
   * @param {function} [deps.playerAltKm] () => the player's altitude (km).
   * @param {function} [deps.orbit]     () => the player's Keplerian elements, semiMajorAxis in
   *   SCENE units (PlayerSatellite.getOrbitalElements shape).
   * @param {function} [deps.tca]       () => { id, label, tcaS, distM, tier } | null.
   * @param {function} [deps.eclipse]   () => { inShadow, secondsToFlip } | null (world seconds).
   * @param {function} [deps.subPoint]  (pos {x,y,z}) => { latDeg, lonEastDeg } (direction only).
   * @param {function} [deps.stations]  () => [{ name, lat, lon }] | null (degrees, east-positive).
   */
  constructor(deps = {}) {
    this._glass = !!deps.glass;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._clusters = deps.clusters;
    this._playerAltKm = deps.playerAltKm;
    this._orbit = deps.orbit;
    this._tca = deps.tca;
    this._eclipse = deps.eclipse;
    this._subPoint = deps.subPoint;
    this._stations = deps.stations;

    this._root = null;
    this._el = null;                 // { head, title, rows: [{ el, label, subject, value }] }
    this._model = null;              // the last computed row models (slot order)
    this._keys = NEXT_ROWS.map(() => undefined);   // last subject key per slot (undefined = never rendered)
    this._flashUntil = NEXT_ROWS.map(() => 0);     // change-highlight deadline per slot (ms)
    this._order = [0, 1, 2, 3];      // slots by soonest first
    this._mode = 'hidden';           // until the first setDodge places the pane
    this._underPx = undefined;       // last setDodge inputs (write-on-change)
    this._floorPx = undefined;
    this._topPx = null;              // the written top (px) — null while hidden
    this._heightPx = 0;              // the written height (px)
    this._lastTickMs = null;
    this._rung = null;
    this._disposed = false;

    this._build(deps.parent);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The pane-density rung adapter (cached object; HUD domRung shape). The ONE
   * visibility bit is `data-density-hidden` on the root; isVisible() also
   * honours on-screen presence (getClientRects) like HUD's DOM rungs. Never
   * throws headless (no root = not visible, setVisible no-op).
   * @returns {{id:string, label:string, isVisible:function, setVisible:function}}
   */
  rung() {
    if (!this._rung) {
      this._rung = {
        id: NEXT_RUNG_ID,
        label: 'Next',
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
   * THE DODGE (the hub calls it per frame). `underPx` = bottom edge of whatever
   * rides above the pane on the right edge (null = nothing: bottom-anchored);
   * `floorPx` = the lowest allowed bottom edge (the thumb-rest floor, or the
   * CARGO pane's top - GAP). Write-on-change on the two inputs.
   *   bottom = floorPx - GAP_PX;  want = bottom - fullPx()
   *   top    = want, pushed DOWN to underPx + GAP_PX only when that is lower
   *   avail  = bottom - top
   *   mode   = 'full' (avail >= fullPx) | 'compact' (avail >= compactPx) | 'hidden'
   * Writes data-next-mode, top and height (the form's fixed height, bottom-anchored).
   * @param {number|null} underPx
   * @param {number} floorPx
   */
  setDodge(underPx, floorPx) {
    if (this._disposed || !this._root) return;
    const u = Number(underPx);
    const under = (underPx == null || !Number.isFinite(u)) ? null : u;
    let floor = Number(floorPx);
    if (!Number.isFinite(floor)) floor = this._viewportHeight();
    if (!Number.isFinite(floor)) return;
    if (under === this._underPx && floor === this._floorPx) return;   // write-on-change (inputs)
    this._underPx = under;
    this._floorPx = floor;
    this._layout();
  }

  /** The root's current top (CSS px) from the pane's own layout numbers — null while hidden. Never a layout read. */
  topPx() { return this._mode === 'hidden' ? null : this._topPx; }

  /** The written height (px): fullPx() | compactPx() | 0. */
  heightPx() { return this._mode === 'hidden' ? 0 : this._heightPx; }

  /** The current mode: 'full' | 'compact' | 'hidden' ('hidden' until the first setDodge, and headless). */
  mode() { return this._mode; }

  /**
   * The tick (the hub calls it per frame). Self-throttled to >= TICK_MS from
   * `nowMs`; recomputes the four rows from the deps and writes on change.
   * Nothing is computed or written while the pane is density-hidden or
   * clipped by the dodge (both display:none).
   * @param {number} [nowMs]  the world clock in ms (falls back to deps.now, then Date.now)
   */
  update(nowMs) {
    if (this._disposed || !this._root) return;
    const root = this._root;
    if (root.hasAttribute && root.hasAttribute(DENSITY_HIDDEN_ATTR)) return;
    if (this._mode === 'hidden') return;
    let t = Number(nowMs);
    if (!Number.isFinite(t)) t = this._now ? Number(this._now()) : Date.now();
    if (!Number.isFinite(t)) return;
    if (this._lastTickMs !== null && t - this._lastTickMs < TICK_MS) return;
    this._lastTickMs = t;
    this._render(t);
  }

  /** Remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._root && this._root.remove) {
      try { this._root.remove(); } catch (_e) { /* stub */ }
    }
    this._root = null;
    this._el = null;
    this._model = null;
    this._mode = 'hidden';
    this._topPx = null;
    this._heightPx = 0;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build the DOM under `parent` (headless: nothing). */
  _build(parentDep) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = parentDep || (doc.getElementById ? doc.getElementById('hud-overlay') : null);
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();
    const G = NEXT_GEOMETRY;

    const root = doc.createElement('div');
    root.id = NEXT_PANE_ID;
    root.className = 'hud-panel' + (this._glass ? ' next-glass' : '');
    // Geometry literals live inline (the style sheet carries the look); `top`
    // and `height` are written ONLY by setDodge.
    root.style.right = `${G.RIGHT_PX}px`;
    root.style.width = `${G.WIDTH_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'none';
    root.style.overflow = 'hidden';
    root.setAttribute(MODE_ATTR, 'hidden');       // placed by the first setDodge

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };

    const head = mk('div', 'next-head');
    const title = mk('span', 'next-title', 'NEXT');
    head.appendChild(title);
    root.appendChild(head);

    const rows = [];
    for (const slot of NEXT_ROWS) {
      const el = mk('div', 'next-row');
      el.setAttribute('data-row', slot);
      const label = mk('span', 'next-label', slot.toUpperCase());
      const subject = mk('span', 'next-subject', '');
      const value = mk('span', 'next-value', UNKNOWN);
      el.appendChild(label); el.appendChild(subject); el.appendChild(value);
      root.appendChild(el);
      rows.push({ el, label, subject, value });
    }
    parent.appendChild(root);

    this._root = root;
    this._el = { head, title, rows };
  }

  /** @private The one <style id="next-pane-style"> (per document). No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(NEXT_STYLE_ID))) return;
    const G = NEXT_GEOMETRY;
    const style = doc.createElement('style');
    style.id = NEXT_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar rides in from .hud-panel (the mono token, 13px,
       * #00ff88 on rgba(5,10,20,0.95), 1px rgba(0,255,136,0.3) border). */
      #${NEXT_PANE_ID} {
        display: flex;
        flex-direction: column;
        pointer-events: none;
        box-sizing: border-box;
        overflow: hidden;
        font-family: var(--font-mono);
        font-variant-numeric: tabular-nums;
      }
      /* The rung's ONE bit (HUD's pane-density style carries the global rule
       * too; this copy keeps the pane honest when it stands alone). */
      #${NEXT_PANE_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* Mode 'hidden': no room under the rider (setDodge). The density bit is untouched. */
      #${NEXT_PANE_ID}[${MODE_ATTR}="hidden"] { display: none !important; }
      #${NEXT_PANE_ID} .next-head {
        display: flex; align-items: baseline; gap: 8px;
        height: ${G.HEADER_PX}px; line-height: ${G.HEADER_PX}px; white-space: nowrap;
        flex: 0 0 auto;
      }
      #${NEXT_PANE_ID} .next-title { font-weight: bold; letter-spacing: 0.08em; }
      #${NEXT_PANE_ID} .next-row {
        display: flex; align-items: baseline; gap: 6px;
        height: ${G.ROW_PX}px; line-height: ${G.ROW_PX}px; white-space: nowrap;
        flex: 0 0 auto;
        font-family: var(--font-mono);
        font-variant-numeric: tabular-nums;
      }
      #${NEXT_PANE_ID} .next-label {
        flex: 0 0 74px;
        font-variant-caps: small-caps;
        font-size: 11px;
        letter-spacing: 0.06em;
        opacity: 0.75;
      }
      #${NEXT_PANE_ID} .next-subject { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
      #${NEXT_PANE_ID} .next-value { flex: 0 0 auto; text-align: right; }
      /* Compact: the two soonest rows stay; the two latest fold away (slot order kept). */
      #${NEXT_PANE_ID}[${MODE_ATTR}="compact"] .next-row[${FOLDED_ATTR}] { display: none; }
      /* TCA: an active conjunction is advisory amber; tier RED is the critical red and pulses
       * (the red is never the sole channel: the row's text names the threat). */
      #${NEXT_PANE_ID} .next-row[${TIER_ATTR}="caution"] { color: ${COLORS.CAUTION}; }
      #${NEXT_PANE_ID} .next-row[${TIER_ATTR}="red"] { color: ${COLORS.THREAT}; animation: next-pulse 1s ease-in-out infinite; }
      /* The change-highlight: a subject change flashes the row once (FLASH_MS). */
      #${NEXT_PANE_ID} .next-row[${CHANGED_ATTR}] { animation: next-flash ${FLASH_MS}ms ease-out 1; }
      #${NEXT_PANE_ID} .next-row[${TIER_ATTR}="red"][${CHANGED_ATTR}] { animation: next-flash ${FLASH_MS}ms ease-out 1, next-pulse 1s ease-in-out infinite; }
      @keyframes next-flash {
        from { background: rgba(255, 255, 255, 0.22); }
        to   { background: transparent; }
      }
      @keyframes next-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.55; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${NEXT_PANE_ID} .next-row { animation: none !important; }
      }
    `;
    doc.head.appendChild(style);
  }

  // ── Reads (every one guarded) ──────────────────────────────────────────────

  /** @private The window height when the hub passes no floor (never per frame: setDodge caches). */
  _viewportHeight() {
    const doc = this._doc;
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const h = win && Number(win.innerHeight);
    return Number.isFinite(h) && h > 0 ? h : NaN;
  }

  /** @private The player's km orbit (angles rad; missing fields 0) or null. */
  _orbitKm() {
    const o = call(this._orbit);
    if (!o || typeof o !== 'object') return null;
    const km = orbitToKm(o);
    const a = num(km.semiMajorAxis);
    if (!(a > 0)) return null;
    return {
      semiMajorAxis: a,
      eccentricity: num(km.eccentricity) || 0,
      inclination: num(km.inclination) || 0,
      raan: num(km.raan) || 0,
      argPerigee: num(km.argPerigee) || 0,
      trueAnomaly: num(km.trueAnomaly) || 0,
    };
  }

  /**
   * @private TRANSFER: the cluster with the smallest departIn. The chaser is the
   * player's radius (playerAltKm + R_E, or the orbit's semi-major axis) with the
   * orbit's angles for phase; a cluster is a km orbit when it carries one
   * (orbitKm, or live `targets` via clusterToOrbitKm), else a circular orbit at
   * altKm + R_E in the player's plane. computeTransferWindow takes RADII (km),
   * never altitudes. A co-orbital cluster (isCoOrbital) is open now.
   */
  _transferRow() {
    const clusters = call(this._clusters);
    if (!Array.isArray(clusters) || clusters.length === 0) return unknownRow('TRANSFER');
    const orbitKm = this._orbitKm();
    let r1 = num(call(this._playerAltKm));
    r1 = Number.isFinite(r1) ? r1 + EARTH_RADIUS_KM : (orbitKm ? orbitKm.semiMajorAxis : NaN);
    if (!(r1 > 0)) return unknownRow('TRANSFER');
    const chaser = {
      semiMajorAxis: r1,
      eccentricity: orbitKm ? orbitKm.eccentricity : 0,
      inclination: orbitKm ? orbitKm.inclination : 0,
      raan: orbitKm ? orbitKm.raan : 0,
      argPerigee: orbitKm ? orbitKm.argPerigee : 0,
      trueAnomaly: orbitKm ? orbitKm.trueAnomaly : 0,
    };
    let best = null;
    for (const c of clusters) {
      if (!c || typeof c !== 'object') continue;
      const name = c.name != null ? String(c.name) : null;
      if (!name) continue;
      let target = null;
      if (c.orbitKm && num(c.orbitKm.semiMajorAxis) > 0) {
        target = c.orbitKm;
      } else if (Array.isArray(c.targets) && c.targets.length > 0) {
        try { target = clusterToOrbitKm(c); } catch (_e) { target = null; }
      }
      if (!target) {
        const altKm = num(c.altKm !== undefined ? c.altKm : c.avgAltKm);
        if (!Number.isFinite(altKm)) continue;
        const inc = num(c.incCenter);
        target = {
          semiMajorAxis: altKm + EARTH_RADIUS_KM,
          eccentricity: 0,
          inclination: Number.isFinite(inc) ? inc * DEG : chaser.inclination,
          raan: 0, argPerigee: 0, trueAnomaly: 0,
        };
      }
      if (!(num(target.semiMajorAxis) > 0)) continue;
      let win;
      try { win = computeTransferWindow(chaser, target); } catch (_e) { continue; }
      if (!win) continue;
      const departIn = isCoOrbital(win) ? 0 : num(win.departIn);
      if (!Number.isFinite(departIn)) continue;
      if (!best || departIn < best.seconds) best = { name, seconds: departIn };
    }
    if (!best) return unknownRow('TRANSFER');
    return {
      label: 'TRANSFER', subject: best.name, seconds: best.seconds,
      value: TransferWindows.formatDuration(best.seconds), key: best.name, tier: null,
    };
  }

  /** @private TCA: the current conjunction (amber; tier RED red) or `TCA — clear`. */
  _tcaRow() {
    const t = call(this._tca);
    if (!t || typeof t !== 'object') {
      return { label: 'TCA', subject: UNKNOWN, value: 'clear', seconds: Infinity, key: '', tier: null };
    }
    const label = t.label != null ? String(t.label) : (t.id != null ? `#${t.id}` : UNKNOWN);
    const tcaS = num(t.tcaS);
    const seconds = Number.isFinite(tcaS) ? Math.max(0, tcaS) : Infinity;
    const tier = String(t.tier || '').toUpperCase() === 'RED' ? 'red' : 'caution';
    return {
      label: 'TCA', subject: label, seconds,
      value: `${fmtTminus(tcaS)} \u00b7 ${fmtKm(t.distM)}`,
      key: String(t.id != null ? t.id : label), tier,
    };
  }

  /** @private SHADOW | SUNLIT: the next eclipse flip (world seconds). */
  _shadowRow() {
    const e = call(this._eclipse);
    if (!e || typeof e !== 'object') return unknownRow('SHADOW');
    const word = e.inShadow ? 'SUNLIT' : 'SHADOW';
    const s = num(e.secondsToFlip);
    if (!Number.isFinite(s)) return { ...unknownRow(word), key: word };
    return { label: word, subject: 'in', value: formatClock(s), seconds: Math.max(0, s), key: word, tier: null };
  }

  /**
   * @private PASS: propagate the player orbit over ONE period in PASS_STEPS
   * samples (the only propagation budget of the tick), sub-point each sample,
   * the first sample within PASS_RADIUS_KM of a station wins (the closest
   * station of that sample). The Earth's surface does not rotate in this game,
   * so the ECI sub-point IS the ground point.
   */
  _passRow() {
    const stations = call(this._stations);
    const subPoint = this._subPoint;
    if (!Array.isArray(stations) || stations.length === 0 || typeof subPoint !== 'function') return unknownRow('PASS');
    const km = this._orbitKm();
    if (!km) return unknownRow('PASS');
    const a = km.semiMajorAxis;
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU);
    if (!Number.isFinite(period) || !(period > 0)) return unknownRow('PASS');
    const dt = period / PASS_STEPS;
    const list = [];
    for (const st of stations) {
      if (!st || typeof st !== 'object') continue;
      const lat = num(st.lat !== undefined ? st.lat : st.lat_deg);
      const lon = num(st.lon !== undefined ? st.lon : st.lon_deg);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      list.push({ name: st.name != null ? String(st.name) : (st.id != null ? String(st.id) : UNKNOWN), lat, lon });
    }
    if (list.length === 0) return unknownRow('PASS');
    for (let i = 0; i < PASS_STEPS; i++) {
      if (i > 0) propagateOrbit(km, dt);
      let sp;
      try { sp = subPoint(keplerianToCartesian(km).position); } catch (_e) { return unknownRow('PASS'); }
      const lat = sp && num(sp.latDeg), lon = sp && num(sp.lonEastDeg);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      let hit = null;
      for (const st of list) {
        const d = haversineKm(lat, lon, st.lat, st.lon);
        if (d <= PASS_RADIUS_KM && (!hit || d < hit.d)) hit = { name: st.name, d };
      }
      if (hit) {
        const t = i * dt;
        return { label: 'PASS', subject: hit.name, seconds: t, value: fmtTminus(t), key: hit.name, tier: null };
      }
    }
    return unknownRow('PASS');
  }

  // ── Render (1 Hz) ──────────────────────────────────────────────────────────

  /** @private Recompute the four rows, rank them, write on change; the change-highlight by `now`. */
  _render(now) {
    const el = this._el;
    if (!el) return;
    const model = [this._transferRow(), this._tcaRow(), this._shadowRow(), this._passRow()];
    this._model = model;
    for (let i = 0; i < model.length; i++) {
      const m = model[i];
      const r = el.rows[i];
      this._setText(r.label, m.label);
      this._setText(r.subject, m.subject);
      this._setText(r.value, m.value);
      this._setAttr(r.el, TIER_ATTR, m.tier);
      // The highlight keys on the SUBJECT only (never the ticking countdown);
      // the first render of a slot is a placement, not a change.
      const prev = this._keys[i];
      if (prev !== undefined && prev !== m.key) this._flashUntil[i] = now + FLASH_MS;
      this._keys[i] = m.key;
      const flashing = this._flashUntil[i] > now;
      this._setAttr(r.el, CHANGED_ATTR, flashing ? '' : null);
    }
    this._order = [0, 1, 2, 3].sort((x, y) => (model[x].seconds - model[y].seconds) || (x - y));
    this._applyFold();
  }

  /** @private Compact folds the two latest slots (attribute only in compact; slot order never changes). */
  _applyFold() {
    const el = this._el;
    if (!el) return;
    const keep = new Set(this._mode === 'compact' ? this._order.slice(0, NEXT_GEOMETRY.COMPACT_ROWS) : [0, 1, 2, 3]);
    for (let i = 0; i < el.rows.length; i++) {
      this._setAttr(el.rows[i].el, FOLDED_ATTR, keep.has(i) ? null : '');
    }
  }

  // ── Layout (setDodge; pure arithmetic, write-on-change outputs) ────────────

  /**
   * @private Place the pane from the cached dodge inputs. Bottom-anchored: the
   * pane hugs the floor and yields UPWARD only as far as the rider above
   * forces it. No layout reads. Returns true when a DOM write happened.
   */
  _layout() {
    const root = this._root;
    if (!root || !Number.isFinite(this._floorPx)) return false;
    const G = NEXT_GEOMETRY;
    const full = fullPx();
    const compact = compactPx();
    const bottom = this._floorPx - G.GAP_PX;
    const want = bottom - full;
    let top = (this._underPx == null) ? want : Math.max(want, this._underPx + G.GAP_PX);
    if (top < 0) top = 0;
    const avail = bottom - top;
    let mode, h;
    if (avail >= full) { mode = 'full'; h = full; }
    else if (avail >= compact) { mode = 'compact'; h = compact; }
    else { mode = 'hidden'; h = 0; }
    if (mode !== 'hidden') top = bottom - h;          // the form is fixed-height: hug the floor

    let wrote = false;
    if (mode !== this._mode) {
      this._mode = mode;
      root.setAttribute(MODE_ATTR, mode);
      wrote = true;
      this._applyFold();
    }
    if (mode !== 'hidden') {
      this._topPx = Math.round(top);
      this._heightPx = h;
      wrote = this._setStyle(root, 'top', `${this._topPx}px`) || wrote;
      wrote = this._setStyle(root, 'height', `${h}px`) || wrote;
    }
    return wrote;
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

  /** @private value null = remove; else set (write-on-change). */
  _setAttr(el, name, value) {
    if (!el || !el.setAttribute) return false;
    const have = el.getAttribute ? el.getAttribute(name) : null;
    if (value == null) {
      if (have === null) return false;
      el.removeAttribute(name);
      return true;
    }
    if (have === value) return false;
    el.setAttribute(name, value);
    return true;
  }
}

export default NextPane;
