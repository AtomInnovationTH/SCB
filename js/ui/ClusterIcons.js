/**
 * ClusterIcons.js — the Zoom Ladder F6 (NAVCOM) world-icon layer (S5, M3).
 *
 * On F6 the near-field render pass is OFF and the full debris meshes are hidden
 * (FloorContract.FLOORS[5].fidelity.debrisMode === 'clusters', costume transform
 * 'ship-to-icon'). This layer draws the replacement: each debris cluster as a
 * ring + count icon, and the player ship as a velocity-aligned chevron
 * (VisualLaw.ICONS.SHAPES: cluster 'ring-count', ship 'chevron').
 *
 * VISUAL LAW (js/core/VisualLaw.js) — pinned by test-FloorContract.js:
 *   - icon sizes are exactly the 3 bands [12, 18, 24] px (count-weighted);
 *   - color is never the SOLE channel: count → size, focus → color AND scale;
 *   - clusters read INFO cyan; the focused cluster reads SELECTION blue;
 *   - FUEL-REACHABILITY (optional opts.assessments): unreachable clusters are
 *     dimmed + dash-ringed, marginal read VALUE gold + dashed (never
 *     color-alone), and the FOCUSED cluster's label gains an estimate line
 *     ('ΔV 320 · Gas 2.1 kg · 14 min'); icon hitboxes (ring + count only — the
 *     root stays pointer-events:none) click-dispatch to the onSelect sink;
 *   - at most `labelBudget` (F6 = 7) icons carry a text label, the rest are
 *     ranked out (highest count first) — hover would reveal the rest (S6).
 *
 * The projection is INJECTED (`project(worldVec3) -> {x, y, visible}`) so the
 * layout math is unit-testable headless — the module never imports THREE and is
 * fully DOM-guarded (inert + constructible in Node tests). `render()` returns the
 * computed icon descriptors (also what drives the DOM) so tests assert layout,
 * ranking, sizing, and focus without a browser.
 *
 * This is FLOOR CONTENT (parallel track, docs/ladder/03-plan.md): it owns no
 * camera, no debris source, and no game loop — NavcomFloor (S5) feeds it clusters
 * + a projector, and the serial track wires NavcomFloor into main.js.
 *
 * @module ui/ClusterIcons
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';

/** Lane 3e: the FieldRegistry (or a getter) `ClusterIcons.nameLine` names her field from; set by `setFieldRegistry`. */
let _registrySource = null;
/** @returns {object|null} the registry when the map-by-height flag is on, else null */
function _fieldRegistry() {
  let r = _registrySource;
  try { if (typeof r === 'function') r = r(); } catch (_e) { return null; }
  return r && typeof r.isOn === 'function' && r.isOn() ? r : null;
}

/** Count thresholds mapping a cluster's member count to a VisualLaw size band.
 *  Three bands ↔ SIZES_PX [12, 18, 24]; endpoints pinned by test. */
const SIZE_BREAKS = [25, 100]; // <25 → 12px, <100 → 18px, else 24px

/**
 * FUEL-REACHABILITY (F6): opacity applied to clusters the ΔV budget cannot
 * reach. Verdict encoding is never color-alone (VisualLaw law): unreachable =
 * dim + dashed ring; marginal = VALUE gold + dashed ring; reachable = normal
 * INFO cyan solid. Own-module tunable (house rule: not FloorContract/Constants).
 */
export const UNREACHABLE_DIM_OPACITY = 0.35;

/**
 * u7 D1: the focused cluster's label at the simple level - the verdict in the trip box's
 * own words (TransferWindows.readout), no numbers. Unknown verdict → no label.
 */
const PLAIN_VERDICT_LINE = Object.freeze({
  reachable: 'Enough fuel to go',
  marginal: 'Only just enough fuel',
  unreachable: 'Not enough fuel to go',
});

/**
 * u10 D1 (owner pick "Floor 4 easier to read", 2026-10-20): the focused field's ring is at least
 * this many px across on every screen (the count bands stay for the other fields).
 */
export const FOCUS_RING_MIN_PX = 28;
/** u10 D1: the field name beside the focused ring, the ship's `You` and the edge arrow's `You` (px). */
export const MARKER_LABEL_PX = 13;
/** u10 D1: the ship chevron's size (px; the 12 px chevron was hard to find on a big screen). */
export const SHIP_MARKER_PX = 18;
/** u10 D1: `You` hangs this far below the chevron's point (px) — below a focused ring (14 px radius) round it. */
export const SHIP_LABEL_DROP_PX = 17;
/** u10 D3: the ship's edge arrow sits this far inside the viewport edge (px). */
export const EDGE_ARROW_INSET_PX = 28;
/** u10 D1: the ship marker's plain label (also on its edge arrow). */
export const SHIP_LABEL = 'You';
/** u10 D3: mono glyph width as a fraction of the font size (the footprint estimate below). */
const MONO_EM = 0.62;
/** u10 D1/D3: a name block changes side only once its ring is this far past Earth's centre on screen (px). */
export const LABEL_FLIP_PX = 8;

export class ClusterIcons {
  /**
   * @param {object} [deps]
   * @param {function} [deps.simple] - () => boolean, true at the simple level (u7 D1). Absent → today's label.
   */
  constructor(deps = {}) {
    this._simple = (deps && typeof deps.simple === 'function') ? deps.simple : null;
    this._root = null;
    this._shipEl = null;
    this._icons = new Map();  // clusterId → { el, ring, label }
    this._sides = new Map();  // u10: clusterId → the name block's side ('left'|'right'), for the hysteresis
    this._built = false;
    this._visible = false;
    this._onSelect = null;    // click-to-select sink: (clusterId) => void
  }

  /**
   * Wire the click-to-select sink. Individual icon hitboxes (ring + count
   * label only — the root stays pointer-events:none) dispatch the cluster id
   * here; NavcomFloor routes it into focusById().
   * @param {(id:*) => void} fn
   */
  setOnSelect(fn) { this._onSelect = (typeof fn === 'function') ? fn : null; }

  /**
   * Dispatch a click on a cluster icon to the onSelect sink. Public so the
   * dispatch path is headless-testable (the DOM listener calls this).
   * @param {*} id - cluster id
   */
  clickIcon(id) { if (this._onSelect) this._onSelect(id); }

  /**
   * Format a reachability assessment as the focused icon's estimate line,
   * e.g. 'ΔV 320 · Gas 2.1 kg · 14 min'. Pure + static.
   * @param {{dvCost:number, fuelKg:number, timeS:number}} a
   * @returns {string}
   */
  static estimateLine(a) {
    if (!a) return '';
    const dv = Number.isFinite(a.dvCost) ? Math.round(a.dvCost) : '\u2014';
    const xe = Number.isFinite(a.fuelKg) ? (Math.round(a.fuelKg * 10) / 10) : '\u2014';
    return `\u0394V ${dv} \u00b7 Gas ${xe} kg \u00b7 ${ClusterIcons.formatTime(a.timeS)}`;
  }

  /**
   * Compact duration for the estimate line. Pure + static.
   * @param {number} s - seconds
   * @returns {string} '45 s' / '14 min' / '2.5 h' ('—' for non-finite)
   */
  static formatTime(s) {
    if (!Number.isFinite(s)) return '\u2014';
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  }

  /**
   * Map a cluster member count to one of the three VisualLaw icon sizes.
   * Pure + static so the size law is unit-testable.
   * @param {number} count
   * @returns {number} px ∈ VisualLaw.ICONS.SIZES_PX ([12, 18, 24])
   */
  static sizeForCount(count) {
    const [small, mid, large] = VisualLaw.ICONS.SIZES_PX;
    const c = count > 0 ? count : 0;
    if (c < SIZE_BREAKS[0]) return small;
    if (c < SIZE_BREAKS[1]) return mid;
    return large;
  }

  /**
   * u10 D1: a field's plain name — the trip box's name up to its first comma
   * ('ISS Band, 180-400 km' → 'ISS Band'). Pure + static.
   * @param {{name?:string, id?:*}} c
   * @returns {string}
   */
  static plainName(c) {
    const raw = (c && (c.name || c.id)) != null ? String(c.name || c.id) : '';
    return raw.split(',')[0].trim();
  }

  /**
   * u10 D1: the line beside the focused ring — plain name and piece count
   * ('ISS Band · 7 pieces'). Pure + static; plain words at every level.
   * @param {{name?:string, id?:*, count?:number}} c
   * @returns {string}
   */
  static nameLine(c) {
    const n = (c && c.count > 0) ? c.count : 0;
    const pieces = `${n} ${n === 1 ? 'piece' : 'pieces'}`;
    // Nets step 3 lane 3e (FIELDS_BY_HEIGHT): a field is named by its height, not by an inclination band ('Field at 350 km'),
    // from the registry's field she is at; berthed at a satellite no field is out, so no field line. Flag off: today's text.
    const reg = _fieldRegistry();
    if (reg) {
      if (typeof reg.isBerthed === 'function' ? reg.isBerthed() : !!(reg.berthedSatellite && reg.berthedSatellite())) return '';
      const f = typeof reg.currentField === 'function' ? reg.currentField()
        : (typeof reg.fields === 'function' && typeof reg.currentId === 'function' ? reg.fields().find((x) => x.id === reg.currentId()) : null);
      if (f && Number.isFinite(f.altKm)) return `Field at ${Math.round(f.altKm)} km \u00b7 ${pieces}`;
    }
    return `${ClusterIcons.plainName(c)} \u00b7 ${pieces}`;
  }

  /**
   * Lane 3e: where `nameLine` finds the field she is at (HeightScale hands its registry over when it is built; null clears it).
   * `r` is a FieldRegistry or () => one. Flag off (`isOn()` false) or none: `nameLine` is exactly today's.
   * @param {object|function|null} r
   */
  static setFieldRegistry(r) { _registrySource = r || null; }

  /**
   * u10 D1: the on-screen ring size (px) — the count band, x1.25 and at least
   * FOCUS_RING_MIN_PX when focused. Pure + static.
   * @param {number} count
   * @param {boolean} focused
   * @returns {number}
   */
  static ringPx(count, focused) {
    const band = ClusterIcons.sizeForCount(count);
    return focused ? Math.max(FOCUS_RING_MIN_PX, Math.round(band * 1.25)) : band;
  }

  /**
   * u10 D3: where the ship's edge arrow goes when the ship is off screen — on the
   * ray from the viewport centre toward the ship's projection (flipped when the
   * projection is behind the camera), clamped EDGE_ARROW_INSET_PX inside the
   * edges. Pure + static. null when the ship is on screen.
   * @param {{x:number, y:number, visible:boolean}} p
   * @param {number} W
   * @param {number} H
   * @returns {{x:number, y:number, angleRad:number}|null}
   */
  static edgeArrow(p, W, H) {
    if (!p || !(W > 0) || !(H > 0) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const onScreen = p.visible && p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
    if (onScreen) return null;
    const cx = W / 2, cy = H / 2;
    let dx = p.x - cx, dy = p.y - cy;
    if (!p.visible) { dx = -dx; dy = -dy; }
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) dy = 1;
    const hx = Math.max(1, cx - EDGE_ARROW_INSET_PX), hy = Math.max(1, cy - EDGE_ARROW_INSET_PX);
    const t = Math.min(hx / Math.max(Math.abs(dx), 1e-9), hy / Math.max(Math.abs(dy), 1e-9));
    return { x: cx + dx * t, y: cy + dy * t, angleRad: Math.atan2(dy, dx) };
  }

  /**
   * u10 D3: the half-extents (px) round a marker's anchor point that the
   * framing keeps on screen and off the HUD panels — the union of the focused
   * field icon (ring, name block beside it: `lines` of text at
   * MARKER_LABEL_PX, on the side toward Earth's centre) and the ship chevron
   * with `You` below it, plus 4 px. `inner` is the extent on the side facing
   * Earth's centre (the name block), `outer` the side away from it; `flip` is
   * the label's hysteresis band (LABEL_FLIP_PX). Pure + static (an estimate
   * from the text length; mono glyph ≈ 0.62 em).
   * @param {{ringPx?:number, lines?:string[]}} [arg]
   * @returns {{inner:number, outer:number, up:number, down:number, flip:number}}
   */
  static footprint({ ringPx = FOCUS_RING_MIN_PX, lines = [] } = {}) {
    const r = ringPx / 2;
    const chars = lines.reduce((m, s) => Math.max(m, String(s || '').length), 0);
    const textW = chars * MONO_EM * MARKER_LABEL_PX;
    const blockHalfH = (Math.max(1, lines.length) * MARKER_LABEL_PX * 1.25) / 2;
    const shipHalf = SHIP_MARKER_PX * 0.71;                  // the rotated chevron's half-diagonal
    const shipDown = SHIP_LABEL_DROP_PX + MARKER_LABEL_PX + 2; // `You` (in its pill) below the chevron
    const pad = 4;
    return {
      inner: Math.ceil(Math.max(r + 6 + textW + 8, shipHalf) + pad),
      outer: Math.ceil(Math.max(r, shipHalf) + pad),
      up: Math.ceil(Math.max(r, blockHalfH + 2, shipHalf) + pad),
      down: Math.ceil(Math.max(r, blockHalfH + 2, shipDown) + pad),
      flip: LABEL_FLIP_PX,
    };
  }

  /**
   * u10 D1/D3: which side of its ring a field's name block goes — toward
   * Earth's centre on screen (`sideX`), so the text never sticks out past the
   * shell the framing keeps clear of the panels. Hysteresis: it changes side
   * only once the ring is LABEL_FLIP_PX past `sideX`. Pure + static.
   * @param {number} x       the ring's screen x
   * @param {number} sideX   Earth's centre's screen x
   * @param {'left'|'right'|null} prev
   * @returns {'left'|'right'}
   */
  static labelSide(x, sideX, prev) {
    if (!Number.isFinite(x) || !Number.isFinite(sideX)) return prev || 'right';
    if (x > sideX + LABEL_FLIP_PX) return 'left';
    if (x < sideX - LABEL_FLIP_PX) return 'right';
    return prev || (x > sideX ? 'left' : 'right');
  }

  /**
   * Rank clusters for the label budget: highest member count first (stable on
   * ties by id) then truncate to `budget`. Pure + static for testability.
   * @param {Array<{id:*, count:number}>} clusters
   * @param {number} budget
   * @returns {Array} the top `budget` clusters, count-desc
   */
  static rank(clusters, budget) {
    const list = Array.isArray(clusters) ? clusters.slice() : [];
    list.sort((a, b) => {
      const dc = (b.count || 0) - (a.count || 0);
      if (dc !== 0) return dc;
      return String(a.id).localeCompare(String(b.id));
    });
    const n = Math.max(0, budget | 0);
    return list.slice(0, n);
  }

  // ── DOM lifecycle (all no-op headless) ─────────────────────────────────────

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-cluster-icons';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:33', 'opacity:0', 'transition:opacity 0.3s',
      'font-family: var(--font-mono)', 'font-size:0.6rem',
    ].join(';');
    document.body.appendChild(root);
    this._root = root;
  }

  show() { this._build(); this._visible = true; if (this._root) this._root.style.opacity = '1'; }

  hide() {
    this._visible = false;
    if (this._root) this._root.style.opacity = '0';
    // Leaving the DOM in place (opacity 0) keeps re-show cheap; positions refresh
    // on the next render(). Nothing paints while hidden.
  }

  /**
   * Lay out the cluster icons for one frame.
   * @param {Array} clusters - from DebrisField.getDebrisClusters() (id, name, count, center{x,y,z})
   * @param {(pos:{x,y,z}) => {x:number, y:number, visible:boolean}} project - world→screen
   * @param {object} [opts]
   * @param {number} [opts.budget] - max labelled icons (default F6 labelBudget = 7)
   * @param {*} [opts.focusId] - the currently-focused cluster id (SELECTION blue)
   * @param {Map|object} [opts.assessments] - FUEL-REACHABILITY: clusterId →
   *                 ReachabilityModel.assess() result. Absent → the pre-reach
   *                 rendering, byte-identical.
   * @param {boolean} [opts.coOrbital] - u7 D1: the focused cluster is at the ship's own height
   *                 (NavcomFloor passes `!!coOrbitalReadout(win)`); at the simple level it carries no label.
   * @param {function} [opts.centerOf] - u10 D2: (cluster) => live centre {x,y,z} (NavcomFloor's
   *                 members-mean, ≤ 2 Hz + extrapolated); absent or null → `cluster.center`.
   * @param {number} [opts.labelSideX] - u10 D3: Earth's centre's screen x; name blocks sit on the
   *                 side of their ring that faces it (ClusterIcons.labelSide). Absent → the right side.
   * @returns {Array<{id:*, name:string, count:number, x:number, y:number, sizePx:number,
   *                  focused:boolean, verdict:?string, estimate:?string, dimmed:boolean,
   *                  ringPx:number, label:?string, labelSide:string}>}
   */
  render(clusters, project, opts = {}) {
    const budget = (opts.budget != null) ? opts.budget : FloorContract.byId(4).labelBudget;
    const focusId = (opts.focusId != null) ? opts.focusId : null;
    const assessments = opts.assessments || null;
    const centerOf = (typeof opts.centerOf === 'function') ? opts.centerOf : null;
    const sideX = Number.isFinite(opts.labelSideX) ? opts.labelSideX : null;
    const assessFor = (id) => {
      if (!assessments) return null;
      return (typeof assessments.get === 'function') ? (assessments.get(id) || null) : (assessments[id] || null);
    };
    const ranked = ClusterIcons.rank(clusters, budget);
    const simple = !!(this._simple && this._simple());
    const coOrbital = opts.coOrbital === true;

    const descriptors = [];
    const seen = new Set();
    for (const c of ranked) {
      const pos = (centerOf && centerOf(c)) || c.center;
      const p = project ? project(pos) : { x: 0, y: 0, visible: false };
      if (!p || !p.visible) continue;
      const sizePx = ClusterIcons.sizeForCount(c.count);
      const focused = focusId != null && c.id === focusId;
      const a = assessFor(c.id);
      const verdict = a ? a.verdict : null;
      let estimate = null;
      if (focused && a) {
        if (!simple) estimate = ClusterIcons.estimateLine(a);
        else if (!coOrbital) estimate = PLAIN_VERDICT_LINE[verdict] || null;   // u7 D1: co-orbital → no label
      }
      const dimmed = verdict === 'unreachable';
      const ringPx = ClusterIcons.ringPx(c.count, focused);
      const label = focused ? ClusterIcons.nameLine(c) : null;   // u10 D1: name + count beside the focused ring
      const prevSide = this._sides.get(c.id) || null;
      const labelSide = sideX == null ? 'right' : ClusterIcons.labelSide(p.x, sideX, prevSide);
      this._sides.set(c.id, labelSide);
      descriptors.push({
        id: c.id, name: c.name, count: c.count, x: p.x, y: p.y, sizePx, focused,
        verdict, estimate, dimmed, ringPx, label, labelSide,
      });
      seen.add(c.id);
      this._paintIcon(c, p, sizePx, focused, verdict, estimate, labelSide);
    }
    // Retire icons no longer in the visible set (idempotent — G1 churn fix).
    for (const [id, rec] of this._icons) {
      if (!seen.has(id) && rec._display !== 'none') {
        rec.el.style.display = 'none';
        rec._display = 'none';
      }
    }
    return descriptors;
  }

  /** @private Build/position one ring+count icon. */
  _paintIcon(cluster, p, sizePx, focused, verdict = null, estimate = null, labelSide = 'right') {
    if (!this._root) return;
    let rec = this._icons.get(cluster.id);
    if (!rec) {
      // u10 D1: the wrapper is a zero-size anchor AT the projected point; the
      // ring is centred on it (before u10 the ring+count stack was centred, so
      // the ring sat a few px off its field). The count sits under the ring;
      // the name block (plain name · count, then the estimate line) sits beside
      // the ring at MARKER_LABEL_PX — shown for the focused field, and on hover
      // for the others.
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;width:0;height:0;';
      const ring = document.createElement('div');
      ring.style.cssText = 'position:absolute;box-sizing:border-box;border-style:solid;border-radius:50%;';
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;left:0;transform:translateX(-50%);white-space:nowrap;';
      const name = document.createElement('div');
      name.style.cssText = `position:absolute;top:0;transform:translateY(-50%);white-space:nowrap;text-align:left;font-size:${MARKER_LABEL_PX}px;line-height:1.25;text-transform:none;text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9);background:rgba(0,0,0,0.78);padding:1px 4px;border-radius:3px;display:none;`;
      const nameLine = document.createElement('div');
      name.appendChild(nameLine);
      el.appendChild(ring);
      el.appendChild(label);
      el.appendChild(name);
      // Click-to-select: the ROOT stays pointer-events:none; only the ring +
      // count label (+ the shown name block) are hitboxes (small enough to
      // never block canvas interaction elsewhere). The listener sits on the
      // wrapper and dispatches through clickIcon() → the onSelect sink.
      ring.style.pointerEvents = 'auto';
      ring.style.cursor = 'pointer';
      label.style.pointerEvents = 'auto';
      label.style.cursor = 'pointer';
      name.style.pointerEvents = 'none';   // u11 D7: a drag that starts on the name pill turns the view; the ring is the tap target
      el.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.clickIcon(cluster.id);
      });
      // u10 D1: the other fields show their name on hover (a tap focuses them).
      const hover = (on) => () => { const r = this._icons.get(cluster.id); if (r) { r._hover = on; this._paintName(r); } };
      ring.addEventListener('pointerenter', hover(true));
      ring.addEventListener('pointerleave', hover(false));
      label.addEventListener('pointerenter', hover(true));
      label.addEventListener('pointerleave', hover(false));
      this._root.appendChild(el);
      // The `_`-prefixed fields cache the last WRITTEN value of every property
      // that rarely changes, so the per-frame render only touches left/top
      // (world-anchored — legitimately changes every frame). G1 (post-M3
      // play-test): the unconditional writes re-replaced the label text node
      // every frame — the instrumented probe measured #ladder-cluster-icons
      // childList mutations at one add+remove per icon per frame (~17 Hz
      // headless, would be ~120 Hz at 120 fps) for text that almost never
      // changes. Same-value style writes are cached on the same principle.
      // est (the focused estimate line) is created LAZILY on first use so the
      // no-assessment path adds no element.
      rec = {
        el, ring, label, name, nameLine, est: null,
        _display: null, _dim: null, _focused: null, _color: null, _count: null,
        _dimmed: false, _dashed: false, _estText: null,
        _hover: false, _nameText: null, _nameShown: null, _labelShown: null, _side: null,
      };
      this._icons.set(cluster.id, rec);
    }
    // FUEL-REACHABILITY verdict encoding (never color-alone): marginal = VALUE
    // gold + dashed; unreachable = dimmed + dashed; reachable/unknown = INFO
    // solid. Focus stays SELECTION blue (double-encoded: thicker ring + scale).
    const color = focused ? VisualLaw.COLORS.SELECTION
      : (verdict === 'marginal' ? VisualLaw.COLORS.VALUE : VisualLaw.COLORS.INFO);
    const dim = ClusterIcons.ringPx(cluster.count, focused);   // u10 D1: focused ≥ FOCUS_RING_MIN_PX
    if (rec._display !== 'block') { rec.el.style.display = 'block'; rec._display = 'block'; }
    rec.el.style.left = `${p.x}px`;
    rec.el.style.top = `${p.y}px`;
    if (rec._dim !== dim) {
      rec.ring.style.width = `${dim}px`;
      rec.ring.style.height = `${dim}px`;
      rec.ring.style.left = `${-dim / 2}px`;
      rec.ring.style.top = `${-dim / 2}px`;
      rec.label.style.top = `${dim / 2 + 2}px`;
      rec._dim = dim;
      rec._side = null;   // re-place the name block for the new ring size
    }
    if (rec._side !== labelSide) {
      // u10 D3: the name block faces Earth's centre (left of a ring right of it, and the reverse).
      const gap = `${rec._dim / 2 + 6}px`;
      rec.name.style.left = labelSide === 'left' ? '' : gap;
      rec.name.style.right = labelSide === 'left' ? gap : '';
      rec.name.style.textAlign = labelSide === 'left' ? 'right' : 'left';
      rec._side = labelSide;
    }
    if (rec._focused !== focused) {
      rec.ring.style.borderWidth = focused ? '3px' : '1px';
      rec._focused = focused;
    }
    if (rec._color !== color) {
      rec.ring.style.borderColor = color;
      rec.label.style.color = color;
      rec.name.style.color = color;
      rec._color = color;
    }
    const dimmed = verdict === 'unreachable';
    if (rec._dimmed !== dimmed) {
      rec.el.style.opacity = dimmed ? String(UNREACHABLE_DIM_OPACITY) : '1';
      rec._dimmed = dimmed;
    }
    const dashed = verdict === 'marginal' || verdict === 'unreachable';
    if (rec._dashed !== dashed) {
      rec.ring.style.borderStyle = dashed ? 'dashed' : 'solid';
      rec._dashed = dashed;
    }
    if (rec._count !== cluster.count) {
      rec.label.textContent = String(cluster.count);
      rec._count = cluster.count;
    }
    // u10 D1: the focused field carries its count in the name line, not under the ring.
    const labelShown = !focused;
    if (rec._labelShown !== labelShown) {
      rec.label.style.display = labelShown ? 'block' : 'none';
      rec._labelShown = labelShown;
    }
    const nameText = ClusterIcons.nameLine(cluster);
    if (rec._nameText !== nameText) {
      rec.nameLine.textContent = nameText;
      rec._nameText = nameText;
    }
    if (rec._estText !== estimate) {
      if (estimate) {
        if (!rec.est) {
          const est = document.createElement('div');
          est.style.cssText = 'white-space:nowrap;opacity:0.85;pointer-events:none;text-transform:none;';
          rec.name.appendChild(est);
          rec.est = est;
        }
        rec.est.style.display = 'block';
        rec.est.textContent = estimate;
      } else if (rec.est) {
        rec.est.style.display = 'none';
        rec.est.textContent = '';
      }
      rec._estText = estimate;
    }
    this._paintName(rec);
  }

  /** @private u10 D1: show the name block for the focused field, or while hovered. */
  _paintName(rec) {
    const shown = !!(rec._focused || rec._hover);
    if (rec._nameShown !== shown) {
      rec.name.style.display = shown ? 'block' : 'none';
      rec._nameShown = shown;
    }
    if (rec.est) rec.est.style.visibility = rec._focused ? 'visible' : 'hidden';
  }

  /**
   * Draw the player ship as a velocity-aligned chevron (ship-to-icon transform),
   * labelled `You` (u10 D1); off screen, an arrow at the viewport edge pointing
   * to it, also labelled `You` (u10 D3).
   * @param {{x:number, y:number, visible:boolean}} p - projected ship position
   * @param {number} [angleRad] - screen-space velocity heading (0 = +x)
   * @param {{viewW?:number, viewH?:number}} [opts] - viewport (default: the window's)
   * @returns {{x:number, y:number, visible:boolean, shape:string, angleRad:number,
   *            label:string, onScreen:boolean, edge:?{x:number,y:number,angleRad:number}}}
   */
  renderShip(p, angleRad = 0, opts = {}) {
    const out = { x: p?.x ?? 0, y: p?.y ?? 0, visible: !!(p && p.visible), shape: VisualLaw.ICONS.SHAPES.ship, angleRad };
    const W = Number.isFinite(opts.viewW) ? opts.viewW : (typeof window !== 'undefined' ? window.innerWidth : NaN);
    const H = Number.isFinite(opts.viewH) ? opts.viewH : (typeof window !== 'undefined' ? window.innerHeight : NaN);
    out.label = SHIP_LABEL;
    out.edge = (W > 0 && H > 0) ? ClusterIcons.edgeArrow(p, W, H) : null;
    out.onScreen = out.visible && !out.edge;
    if (!this._root) return out;
    if (!this._shipEl) {
      const el = document.createElement('div');
      // A CSS chevron (two strokes), tinted PLAYER green (u10: 18 px, 3 px strokes).
      el.style.cssText = [
        'position:absolute', 'transform-origin:center', 'pointer-events:none',
        `width:${SHIP_MARKER_PX}px`, `height:${SHIP_MARKER_PX}px`, 'box-sizing:border-box',
        `border-left:3px solid ${VisualLaw.COLORS.PLAYER}`, `border-top:3px solid ${VisualLaw.COLORS.PLAYER}`,
        'filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))',
      ].join(';');
      this._root.appendChild(el);
      this._shipEl = el;
      const lab = document.createElement('div');
      lab.style.cssText = [
        'position:absolute', 'pointer-events:none', 'transform:translateX(-50%)', 'white-space:nowrap',
        `font-size:${MARKER_LABEL_PX}px`, 'line-height:1', 'text-transform:none', 'background:rgba(0,0,0,0.78)', 'padding:1px 4px', 'border-radius:3px',
        `color:${VisualLaw.COLORS.PLAYER}`, 'text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9)',
      ].join(';');
      lab.textContent = SHIP_LABEL;
      this._root.appendChild(lab);
      this._shipLabelEl = lab;
      const arrow = document.createElement('div');
      arrow.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;display:none;';
      const tri = document.createElement('div');
      // A solid triangle pointing along +x before the rotation (border trick, PLAYER green).
      tri.style.cssText = `position:absolute;left:-8px;top:-9px;width:0;height:0;border-top:9px solid transparent;border-bottom:9px solid transparent;border-left:16px solid ${VisualLaw.COLORS.PLAYER};filter:drop-shadow(0 0 2px rgba(0,0,0,0.9));transform-origin:8px 9px;`;
      const alab = document.createElement('div');
      alab.style.cssText = [
        'position:absolute', 'white-space:nowrap', `font-size:${MARKER_LABEL_PX}px`, 'line-height:1', 'text-transform:none', 'background:rgba(0,0,0,0.78)', 'padding:1px 4px', 'border-radius:3px',
        `color:${VisualLaw.COLORS.PLAYER}`, 'text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9)',
      ].join(';');
      alab.textContent = SHIP_LABEL;
      arrow.appendChild(tri);
      arrow.appendChild(alab);
      this._root.appendChild(arrow);
      this._shipArrowEl = arrow;
      this._shipArrowTri = tri;
      this._shipArrowLabel = alab;
    }
    const display = out.onScreen || (out.visible && !(W > 0 && H > 0)) ? 'block' : 'none';
    if (this._shipDisplay !== display) {
      this._shipEl.style.display = display;
      this._shipLabelEl.style.display = display;
      this._shipDisplay = display;
    }
    if (display === 'block') {
      // The bare corner (border-left+top) reads as a chevron; rotate to heading.
      this._shipEl.style.left = `${out.x}px`;
      this._shipEl.style.top = `${out.y}px`;
      this._shipEl.style.transform = `translate(-50%,-50%) rotate(${angleRad + Math.PI / 4}rad)`;
      this._shipLabelEl.style.left = `${out.x}px`;
      this._shipLabelEl.style.top = `${out.y + SHIP_LABEL_DROP_PX}px`;   // below: clear of a focused ring round it
    }
    const arrowDisplay = out.edge ? 'block' : 'none';
    if (this._shipArrowDisplay !== arrowDisplay) { this._shipArrowEl.style.display = arrowDisplay; this._shipArrowDisplay = arrowDisplay; }
    if (out.edge) {
      const e = out.edge;
      this._shipArrowEl.style.left = `${e.x}px`;
      this._shipArrowEl.style.top = `${e.y}px`;
      this._shipArrowTri.style.transform = `rotate(${e.angleRad}rad)`;
      // `You` sits on the inner side of the arrow (toward the middle of the screen).
      const lx = -Math.cos(e.angleRad) * 22, ly = -Math.sin(e.angleRad) * 20;
      this._shipArrowLabel.style.left = `${lx}px`;
      this._shipArrowLabel.style.top = `${ly}px`;
      this._shipArrowLabel.style.transform = 'translate(-50%,-50%)';
    }
    return out;
  }

  /** Remove the whole layer. */
  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._shipEl = null;
    this._shipLabelEl = null;
    this._shipArrowEl = null;
    this._shipDisplay = undefined;
    this._shipArrowDisplay = undefined;
    this._icons.clear();
    this._sides.clear();
    this._built = false;
  }
}
