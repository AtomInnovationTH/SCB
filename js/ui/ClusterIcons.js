/**
 * @module ui/ClusterIcons — world-icon layer for debris clusters: each cluster as a ring + count, the player ship as a
 * velocity-aligned chevron. Near-field pass is off and full debris meshes are hidden while it is up.
 *
 * VISUAL LAW (js/core/VisualLaw.js), pinned by test-FloorContract.js:
 *   - icon sizes are exactly the 3 bands [12, 18, 24] px (count-weighted);
 *   - colour is never the SOLE channel: count -> size, focus -> colour AND scale;
 *   - clusters read INFO cyan; the focused cluster reads SELECTION blue;
 *   - FUEL-REACHABILITY (optional opts.assessments): unreachable = dimmed + dash-ringed, marginal = VALUE gold +
 *     dashed; the FOCUSED cluster's label gains an estimate line; hitboxes are ring + count only (the root stays
 *     pointer-events:none) and click-dispatch to the onSelect sink;
 *   - at most `labelBudget` icons carry a text label, the rest are ranked out (highest count first).
 *
 * The projection is INJECTED (`project(worldVec3) -> {x, y, visible}`) so layout is unit-testable headless: no THREE
 * import, fully DOM-guarded. `render()` returns the icon descriptors that also drive the DOM.
 * Floor content only: owns no camera, debris source or game loop.
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';
import { Constants } from '../core/Constants.js';
import { ReachOrb } from './ReachOrb.js';
import { catchableCount, heldBackCount, heldBackNote } from '../core/missionProgress.js';

/** The FieldRegistry (or a getter) `ClusterIcons.nameLine` names her field from; set by `setFieldRegistry`. */
let _registrySource = null;
/** @returns {object|null} the registry when the map-by-height flag is on, else null */
function _fieldRegistry() {
  let r = _registrySource;
  try { if (typeof r === 'function') r = r(); } catch (_e) { return null; }
  return r && typeof r.isOn === 'function' && r.isOn() ? r : null;
}

/** Count thresholds mapping member count to a VisualLaw size band (SIZES_PX [12, 18, 24]); pinned by test. */
const SIZE_BREAKS = [25, 100]; // <25 → 12px, <100 → 18px, else 24px

/** FUEL-REACHABILITY: opacity of clusters the ΔV budget cannot reach (never colour-alone: also a dashed ring). */
export const UNREACHABLE_DIM_OPACITY = 0.35;

/** The focused cluster's label at the simple level: the verdict in TransferWindows.readout's words, no numbers. */
const PLAIN_VERDICT_LINE = Object.freeze({
  reachable: 'Enough fuel to go',
  marginal: 'Only just enough fuel',
  unreachable: 'Not enough fuel to go',
});

/** The focused field's ring is at least this many px across on every screen (DECISIONS: "Floor 4 easier to read"). */
export const FOCUS_RING_MIN_PX = 28;
/** Font size (px) of the field name beside the focused ring and of the ship's / edge arrow's `You`. */
export const MARKER_LABEL_PX = 13;
/** The ship chevron's size (px). */
export const SHIP_MARKER_PX = 18;
/** `You` hangs this far below the chevron's point (px): clear of a focused ring (14 px radius) round it. */
export const SHIP_LABEL_DROP_PX = 17;
/** The ship's edge arrow sits this far inside the viewport edge (px). */
export const EDGE_ARROW_INSET_PX = 28;
/** The ship marker's plain label (also on its edge arrow). */
export const SHIP_LABEL = 'You';
/** The card a click on `You` opens: its width and its gap to the marker (px). */
export const SHIP_CARD_W_PX = 360;
export const SHIP_CARD_GAP_PX = 22;
/** The invisible tap target round the chevron (px): the 18 px chevron alone is too small a target. */
export const SHIP_HIT_PX = 36;
/** Mono glyph width as a fraction of the font size (for the `footprint` estimate). */
const MONO_EM = 0.62;
/** A name block changes side only once its ring is this far past Earth's centre on screen (px). */
export const LABEL_FLIP_PX = 8;

export class ClusterIcons {
  /**
   * @param {object} [deps]
   * @param {function} [deps.simple] - () => boolean, true at the simple level. Absent → the numbers label.
   */
  constructor(deps = {}) {
    this._simple = (deps && typeof deps.simple === 'function') ? deps.simple : null;
    this._root = null;
    this._shipEl = null;
    this._icons = new Map();  // clusterId → { el, ring, label }
    this._sides = new Map();  // clusterId → the name block's side ('left'|'right'), for the hysteresis
    this._built = false;
    this._visible = false;
    this._onSelect = null;    // click-to-select sink: (clusterId) => void
    this._shipInfo = null;    // () => the reach envelope (or null) the card under `You` reads; NavcomFloor wires it
    this._shipCardEl = null;  // the small card a click on `You` opens
    this._shipCardOpen = false;
    this._shipAnchor = null;  // {x, y}: where the marker (or its edge arrow) is now, px
    this._shipCardOff = null; // removes the listeners that close the card while it is open
  }

  /** Wire the reach source for the card a click on `You` opens: () => {minAltKm, maxAltKm, budgetDvMs} | null (NavcomFloor's last envelope). */
  setShipInfo(fn) { this._shipInfo = (typeof fn === 'function') ? fn : null; }

  /** True while the card under `You` is open. */
  isShipCardOpen() { return this._shipCardOpen; }

  /**
   * Open the card beside `You` (field, debris, reach: three plain lines), or close it when it is open (a second click or tap on `You`). Public so
   * headless tests and the browser probe reach it. The lines are filled here; `renderShip` keeps the card beside the marker each frame.
   * @param {boolean} [open] force open (true) or closed (false); absent toggles
   * @returns {boolean} open now
   */
  toggleShipCard(open) {
    const want = open === undefined ? !this._shipCardOpen : !!open;
    if (want && !this._visible) return false;   // off the globe `You` is not on screen: no card nobody can see (it would eat the next Esc)
    if (want === this._shipCardOpen) return want;
    if (!want) { this._closeShipCard(); return false; }
    if (typeof document === 'undefined' || !this._root) return false;
    if (!this._shipCardEl) {
      const card = document.createElement('div');
      card.id = 'ladder-ship-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'Your field, the debris there and your reach');
      card.style.cssText = [
        'position:absolute', 'display:none', 'pointer-events:auto', 'box-sizing:border-box', `width:${SHIP_CARD_W_PX}px`,
        'padding:8px 10px', 'border-radius:6px', 'background:rgba(8,12,22,0.9)', 'border:1px solid rgba(160,180,220,0.35)',
        `font-size:${MARKER_LABEL_PX}px`, 'line-height:1.35', 'text-transform:none', 'white-space:normal', 'user-select:none', '-webkit-user-select:none',
        `color:${VisualLaw.COLORS.PLAYER}`,
      ].join(';');
      this._root.appendChild(card);
      this._shipCardEl = card;
    }
    let env = null;
    try { env = this._shipInfo ? this._shipInfo() : null; } catch (_e) { env = null; }
    const lines = ClusterIcons.shipInfoLines(env);
    const card = this._shipCardEl;
    while (card.firstChild) card.removeChild(card.firstChild);
    for (const t of lines) {
      const row = document.createElement('div');
      row.textContent = t;
      card.appendChild(row);
    }
    card.style.display = 'block';
    this._shipCardOpen = true;
    this._shipCardH = (typeof card.offsetHeight === 'number' && card.offsetHeight > 0) ? card.offsetHeight : 76;
    this._shipCardL = undefined; this._shipCardT = undefined;
    this._placeShipCard();
    // Closes on a click or tap elsewhere and on Esc (Esc closes only this: it is stopped before the pause menu sees it).
    const inside = (t) => { for (let n = t; n; n = n.parentNode) if (n === card || n === this._shipHit || n === this._shipEl || n === this._shipLabelEl || n === this._shipArrowEl) return true; return false; };
    const onDown = (e) => { if (!inside(e && e.target)) this._closeShipCard(); };
    const onKey = (e) => { if (e && (e.key === 'Escape' || e.code === 'Escape')) { this._closeShipCard(); if (e.stopPropagation) e.stopPropagation(); if (e.preventDefault) e.preventDefault(); } };
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('keydown', onKey, true);
      this._shipCardOff = () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
    }
    return true;
  }

  /** @private */
  _closeShipCard() {
    if (this._shipCardOff) { this._shipCardOff(); this._shipCardOff = null; }
    this._shipCardOpen = false;
    if (this._shipCardEl) this._shipCardEl.style.display = 'none';
  }

  /** @private Put the card beside the marker (right of it, left when it would leave the screen), kept inside the view. */
  _placeShipCard() {
    const card = this._shipCardEl, a = this._shipAnchor;
    if (!this._shipCardOpen || !card || !a) return;
    const W = typeof window !== 'undefined' ? window.innerWidth : NaN;
    const H = typeof window !== 'undefined' ? window.innerHeight : NaN;
    let left = a.x + SHIP_CARD_GAP_PX;
    if (Number.isFinite(W) && left + SHIP_CARD_W_PX > W - 8) left = a.x - SHIP_CARD_GAP_PX - SHIP_CARD_W_PX;
    let top = a.y - this._shipCardH / 2;
    if (Number.isFinite(H)) top = Math.max(8, Math.min(H - 8 - this._shipCardH, top));
    left = Math.max(8, left);
    if (left !== this._shipCardL) { card.style.left = `${left}px`; this._shipCardL = left; }
    if (top !== this._shipCardT) { card.style.top = `${top}px`; this._shipCardT = top; }
  }

  /** Wire the click-to-select sink: icon hitboxes dispatch the cluster id here (NavcomFloor → focusById()). */
  setOnSelect(fn) { this._onSelect = (typeof fn === 'function') ? fn : null; }

  /** Dispatch a click on a cluster icon to the onSelect sink (public so headless tests reach it). */
  clickIcon(id) { if (this._onSelect) this._onSelect(id); }

  /** The focused icon's estimate line, e.g. 'ΔV 320 · Gas 2.1 kg · 14 min'. Pure + static. */
  static estimateLine(a) {
    if (!a) return '';
    const dv = Number.isFinite(a.dvCost) ? Math.round(a.dvCost) : '\u2014';
    const xe = Number.isFinite(a.fuelKg) ? (Math.round(a.fuelKg * 10) / 10) : '\u2014';
    return `\u0394V ${dv} \u00b7 Gas ${xe} kg \u00b7 ${ClusterIcons.formatTime(a.timeS)}`;
  }

  /**
   * Compact duration: '45 s' / '14 min' / '2.5 h' ('—' for non-finite). Pure + static.
   * @param {number} s - seconds
   */
  static formatTime(s) {
    if (!Number.isFinite(s)) return '\u2014';
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  }

  /** @returns {number} px ∈ VisualLaw.ICONS.SIZES_PX for a member count. Pure + static. */
  static sizeForCount(count) {
    const [small, mid, large] = VisualLaw.ICONS.SIZES_PX;
    const c = count > 0 ? count : 0;
    if (c < SIZE_BREAKS[0]) return small;
    if (c < SIZE_BREAKS[1]) return mid;
    return large;
  }

  /** A field's plain name: the trip box's name up to its first comma ('ISS Band, 180-400 km' → 'ISS Band'). */
  static plainName(c) {
    const raw = (c && (c.name || c.id)) != null ? String(c.name || c.id) : '';
    return raw.split(',')[0].trim();
  }

  /** The line beside the focused ring: plain name and piece count ('ISS Band · 7 pieces'); plain words at every level. */
  static nameLine(c) {
    const own = ClusterIcons.ownFieldLine(c);
    if (own != null) return own;
    return ClusterIcons._plainLine(c);
  }

  /** @private the cluster's own plain-name line ('ISS Band · 7 pieces') */
  static _plainLine(c) {
    const n = (c && c.count > 0) ? c.count : 0;
    return `${ClusterIcons.plainName(c)} \u00b7 ${ClusterIcons._pieces(n)}`;
  }

  /** @private '7 pieces' / '1 piece' */
  static _pieces(k) { return `${k} ${k === 1 ? 'piece' : 'pieces'}`; }

  /**
   * The field she is at, named by the registry ('Field at 350 km · 7 pieces'), or null when the registry does not name her field (flag off, none
   * set, or no field found: `nameLine` then falls back to the cluster's plain name). '' while she is berthed at a satellite or at the free
   * place of a push-down (no field is hers). Since Sky 30 (DECISIONS §102 row 2) this text is not drawn beside her ring: a click on `You` shows it.
   * @param {object} [c] the cluster, whose count stands in when the registry cannot count the field's pieces
   * @returns {string|null}
   */
  static ownFieldLine(c) {
    // FIELDS_BY_HEIGHT: a field is named by its height ('Field at 350 km') from the registry's field she is at;
    // berthed at a satellite no field is out, so no field line. Flag off: the plain-name text.
    const reg = _fieldRegistry();
    if (reg) {
      if (typeof reg.isBerthed === 'function' ? reg.isBerthed() : !!(reg.berthedSatellite && reg.berthedSatellite())) return '';
      if (typeof reg.isFree === 'function' && reg.isFree()) return '';     // the free place of a push-down is no field either
      const f = typeof reg.currentField === 'function' ? reg.currentField()
        : (typeof reg.fields === 'function' && typeof reg.currentId === 'function' ? reg.fields().find((x) => x.id === reg.currentId()) : null);
      if (f && Number.isFinite(f.altKm)) {
        let n = (c && c.count > 0) ? c.count : 0;
        // The cluster snapshot is only re-polled on activate/plan; the height column and list read the registry live.
        if (typeof reg.remainingCount === 'function') {
          // DECISIONS §64 row 1: the pieces she can catch now; the ones the training rule holds back are named after them
          const live = catchableCount(reg, f.id);
          if (Number.isFinite(live)) n = Math.max(0, live);
          const held = heldBackCount(reg, f.id);
          if (held > 0) return `Field at ${Math.round(f.altKm)} km \u00b7 ${ClusterIcons._pieces(n)} \u00b7 ${heldBackNote(held)}`;
        }
        return `Field at ${Math.round(f.altKm)} km \u00b7 ${ClusterIcons._pieces(n)}`;
      }
    }
    return null;
  }

  /**
   * The three plain lines the card under `You` shows (Sky 30, DECISIONS §102 row 2): her field (height, pieces), the debris there (count and
   * kinds, from the registry's rows for the field), and her reach. Pure + static; reads the registry set by `setFieldRegistry`.
   * @param {{minAltKm:number, maxAltKm:number, budgetDvMs:number}|null} env the reach envelope (ReachOrb), or null while there is none
   * @returns {string[]} three lines, or two when the field line already names the piece count (no "Debris here" line then)
   */
  static shipInfoLines(env) {
    const reg = _fieldRegistry();
    let field = 'Field: not known';
    let debris = 'Debris here: not known';
    if (reg) {
      const berthed = typeof reg.isBerthed === 'function' ? reg.isBerthed() : !!(reg.berthedSatellite && reg.berthedSatellite());
      const free = typeof reg.isFree === 'function' && reg.isFree();
      const f = typeof reg.currentField === 'function' ? reg.currentField() : null;
      const km = f && Number.isFinite(f.altKm) ? `${Math.round(f.altKm)} km` : '';
      if (berthed) { field = 'At a resupply satellite, no field here'; debris = 'Debris here: none'; }
      else if (free) { field = km ? `Between fields, at ${km}` : 'Between fields'; debris = 'Debris here: none'; }
      else if (f && km) {
        const own = ClusterIcons.ownFieldLine();
        field = own != null ? own : `Field at ${km}`;
        if (typeof reg.remainingRows === 'function') {
          const rows = reg.remainingRows(f.id);
          const catchable = typeof reg.remainingCount === 'function' ? Math.max(0, catchableCount(reg, f.id)) : rows.length;
          // kinds the rows tell: the extra satellite's row is a dead satellite, every other row is a loose piece
          const sats = rows.filter((r) => r === Constants.SMALL_GROUP.SAT_ROW).length;
          const pieces = Math.max(0, catchable - sats);
          const parts = [];
          if (pieces > 0 || sats === 0) parts.push(ClusterIcons._pieces(pieces));
          if (sats > 0) parts.push(`${sats} dead ${sats === 1 ? 'satellite' : 'satellites'}`);
          debris = catchable > 0 ? `Debris here: ${parts.join(' and ')}` : 'Debris here: none left to catch';
          // Sky 34 F (owner 2026-11-25, "less wordy"): the field line already names the piece count, so the same count is not said twice; a dead satellite
          // in the field still gets its line (the field line's count does not say it is one).
          if (own != null && sats === 0) debris = null;
        }
      }
    }
    const reach = env ? ReachOrb.plainReach(env) : '';
    return [field, debris, reach || 'Reach: not known yet'].filter((t) => t != null);
  }

  /**
   * Where `nameLine` finds the field she is at (HeightScale hands its registry over; null clears it).
   * `r` is a FieldRegistry or () => one. Flag off (`isOn()` false) or none: plain-name text.
   * @param {object|function|null} r
   */
  static setFieldRegistry(r) { _registrySource = r || null; }

  /** On-screen ring size (px): the count band; focused = x1.25 and at least FOCUS_RING_MIN_PX. Pure + static. */
  static ringPx(count, focused) {
    const band = ClusterIcons.sizeForCount(count);
    return focused ? Math.max(FOCUS_RING_MIN_PX, Math.round(band * 1.25)) : band;
  }

  /**
   * Where the ship's edge arrow goes when the ship is off screen: on the ray from the viewport centre toward the
   * ship's projection (flipped when behind the camera), EDGE_ARROW_INSET_PX inside the edges. null when on screen.
   * @param {{x:number, y:number, visible:boolean}} p
   * @param {number} W viewport px
   * @param {number} H viewport px
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
   * Half-extents (px) round a marker's anchor that the framing keeps on screen and off the HUD panels: the union of
   * the focused field icon (ring + name block of `lines` at MARKER_LABEL_PX, toward Earth's centre) and the ship
   * chevron with `You` below it, plus 4 px. `inner` faces Earth's centre (the name block), `outer` is the far side;
   * `flip` is LABEL_FLIP_PX. Pure + static; an estimate from the text length (mono glyph ≈ 0.62 em).
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
   * Which side of its ring a field's name block goes: toward Earth's centre on screen (`sideX`), so the text never
   * sticks out past the shell the framing keeps clear of the panels. Hysteresis: changes side only once the ring is
   * LABEL_FLIP_PX past `sideX`. Pure + static.
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

  /** Rank clusters for the label budget: highest count first (ties by id), truncated to `budget`. Pure + static. */
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

  show() { this._build(); this._visible = true; if (this._root) { this._root.style.transition = 'opacity 0.3s'; this._root.style.visibility = 'visible'; this._root.style.opacity = '1'; } }

  hide() {
    this._visible = false;
    this._closeShipCard();   // leaving the globe closes the card under `You`
    if (this._root) {
      // Fade out, then hidden: hidden boxes take no clicks, so the `You` tap target and the rings cannot catch a click on floors 1-3 (Sky 30 review).
      this._root.style.transition = 'opacity 0.3s, visibility 0s linear 0.3s';
      this._root.style.visibility = 'hidden';
      this._root.style.opacity = '0';
    }
    // The DOM stays in place: re-show is cheap, positions refresh on the next render().
  }

  /**
   * Lay out the cluster icons for one frame.
   * @param {Array} clusters - from DebrisField.getDebrisClusters() (id, name, count, center{x,y,z})
   * @param {(pos:{x,y,z}) => {x:number, y:number, visible:boolean}} project - world→screen
   * @param {object} [opts]
   * @param {number} [opts.budget] - max labelled icons (default floor 4 labelBudget = 7)
   * @param {*} [opts.focusId] - the currently-focused cluster id (SELECTION blue)
   * @param {Map|object} [opts.assessments] - clusterId → ReachabilityModel.assess() result. Absent → no verdicts.
   * @param {boolean} [opts.coOrbital] - the focused cluster is at the ship's own height; at the simple level it
   *                 carries no label.
   * @param {function} [opts.centerOf] - (cluster) => live centre {x,y,z} (NavcomFloor's members-mean, ≤ 2 Hz +
   *                 extrapolated); absent or null → `cluster.center`.
   * @param {number} [opts.labelSideX] - Earth's centre's screen x; name blocks sit on the side of their ring that
   *                 faces it (ClusterIcons.labelSide). Absent → the right side.
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
        // Height map on: the Hohmann ΔV/Gas/min line contradicts the real-thruster gas and days the column and list show.
        if (!simple) estimate = _fieldRegistry() ? null : ClusterIcons.estimateLine(a);
        else if (!coOrbital) estimate = PLAIN_VERDICT_LINE[verdict] || null;   // co-orbital → no label
      }
      const dimmed = verdict === 'unreachable';
      const ringPx = ClusterIcons.ringPx(c.count, focused);
      const label = focused ? ClusterIcons.nameLine(c) : null;
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
    // Retire icons no longer in the visible set (idempotent).
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
      // The wrapper is a zero-size anchor AT the projected point; the ring is centred on it. The count sits under
      // the ring; the name block (plain name · count, then the estimate line) sits beside it at MARKER_LABEL_PX,
      // shown for the focused field and on hover for the others.
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
      // The ROOT stays pointer-events:none; only the ring + count label are hitboxes (small enough to never block
      // canvas interaction). The listener sits on the wrapper and dispatches through clickIcon().
      ring.style.pointerEvents = 'auto';
      ring.style.cursor = 'pointer';
      label.style.pointerEvents = 'auto';
      label.style.cursor = 'pointer';
      name.style.pointerEvents = 'none';   // a drag that starts on the name pill turns the view; the ring is the tap target
      el.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.clickIcon(cluster.id);
      });
      // The other fields show their name on hover (a tap focuses them).
      const hover = (on) => () => { const r = this._icons.get(cluster.id); if (r) { r._hover = on; this._paintName(r); } };
      ring.addEventListener('pointerenter', hover(true));
      ring.addEventListener('pointerleave', hover(false));
      label.addEventListener('pointerenter', hover(true));
      label.addEventListener('pointerleave', hover(false));
      this._root.appendChild(el);
      // The `_`-prefixed fields cache the last WRITTEN value of every rarely-changing property, so the per-frame
      // render only touches left/top. Unconditional writes re-replaced the label text node every frame (one DOM
      // childList add+remove per icon per frame). `est` is created LAZILY so the no-assessment path adds no element.
      rec = {
        el, ring, label, name, nameLine, est: null,
        _display: null, _dim: null, _focused: null, _color: null, _count: null,
        _dimmed: false, _dashed: false, _estText: null,
        _hover: false, _nameText: null, _nameShown: null, _labelShown: null, _side: null, _ownHidden: null,
      };
      this._icons.set(cluster.id, rec);
    }
    // Verdict encoding (never colour-alone): marginal = VALUE gold + dashed; unreachable = dimmed + dashed;
    // reachable/unknown = INFO solid. Focus stays SELECTION blue (also thicker ring + scale).
    const color = focused ? VisualLaw.COLORS.SELECTION
      : (verdict === 'marginal' ? VisualLaw.COLORS.VALUE : VisualLaw.COLORS.INFO);
    const dim = ClusterIcons.ringPx(cluster.count, focused);   // focused ≥ FOCUS_RING_MIN_PX
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
      // The name block faces Earth's centre (left of a ring right of it, and the reverse).
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
    // The focused field carries its count in the name line, not under the ring. When the name line is the registry's text for the field she
    // is at, it is not drawn beside her ring any more (Sky 30, DECISIONS §102 row 2: a click on `You` shows it), so the count stays under the ring.
    const own = ClusterIcons.ownFieldLine(cluster);
    const ownHidden = focused && own != null;
    const labelShown = !focused || ownHidden;
    if (rec._labelShown !== labelShown) {
      rec.label.style.display = labelShown ? 'block' : 'none';
      rec._labelShown = labelShown;
    }
    const nameText = own != null ? own : ClusterIcons._plainLine(cluster);
    if (rec._nameText !== nameText) {
      rec.nameLine.textContent = nameText;
      rec._nameText = nameText;
    }
    if (rec._ownHidden !== ownHidden) {
      rec.nameLine.style.display = ownHidden ? 'none' : '';
      rec._ownHidden = ownHidden;
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

  /** @private Show the name block for the focused field, or while hovered. Her own field's block shows only for an estimate line (its text is hidden). */
  _paintName(rec) {
    const shown = rec._focused ? (!rec._ownHidden || !!rec._estText) : !!rec._hover;
    if (rec._nameShown !== shown) {
      rec.name.style.display = shown ? 'block' : 'none';
      rec._nameShown = shown;
    }
    if (rec.est) rec.est.style.visibility = rec._focused ? 'visible' : 'hidden';
  }

  /**
   * Draw the player ship as a velocity-aligned chevron labelled `You`; off screen, an arrow at the viewport edge
   * pointing to it, also labelled `You`.
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
      // A CSS chevron (two strokes), tinted PLAYER green.
      el.style.cssText = [
        'position:absolute', 'transform-origin:center', 'pointer-events:none',
        `width:${SHIP_MARKER_PX}px`, `height:${SHIP_MARKER_PX}px`, 'box-sizing:border-box',
        `border-left:3px solid ${VisualLaw.COLORS.PLAYER}`, `border-top:3px solid ${VisualLaw.COLORS.PLAYER}`,
        'filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))',
      ].join(';');
      this._root.appendChild(el);
      this._shipEl = el;
      // `You` is a button (Sky 30, DECISIONS §102 row 2): a click or tap on the chevron, its tap target or the word opens the card with her
      // field, the debris there and her reach; a second one closes it. The root stays pointer-events:none: only these small boxes take the pointer.
      const hit = document.createElement('div');
      hit.style.cssText = `position:absolute;width:${SHIP_HIT_PX}px;height:${SHIP_HIT_PX}px;transform:translate(-50%,-50%);border-radius:50%;pointer-events:auto;cursor:pointer;`;
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', 'You: your field, the debris there and your reach');
      this._root.appendChild(hit);
      this._shipHit = hit;
      const lab = document.createElement('div');
      lab.style.cssText = [
        'position:absolute', 'pointer-events:auto', 'cursor:pointer', 'transform:translateX(-50%)', 'white-space:nowrap',
        `font-size:${MARKER_LABEL_PX}px`, 'line-height:1', 'text-transform:none', 'background:rgba(0,0,0,0.78)', 'padding:1px 4px', 'border-radius:3px',
        `color:${VisualLaw.COLORS.PLAYER}`, 'text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9)',
      ].join(';');
      lab.textContent = SHIP_LABEL;
      this._root.appendChild(lab);
      this._shipLabelEl = lab;
      const arrow = document.createElement('div');
      arrow.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;display:none;';
      const tri = document.createElement('div');
      // A solid triangle pointing along +x before the rotation (border trick).
      tri.style.cssText = `position:absolute;left:-8px;top:-9px;width:0;height:0;border-top:9px solid transparent;border-bottom:9px solid transparent;border-left:16px solid ${VisualLaw.COLORS.PLAYER};filter:drop-shadow(0 0 2px rgba(0,0,0,0.9));transform-origin:8px 9px;pointer-events:auto;cursor:pointer;`;
      const alab = document.createElement('div');
      alab.style.cssText = [
        'position:absolute', 'white-space:nowrap', `font-size:${MARKER_LABEL_PX}px`, 'line-height:1', 'text-transform:none', 'background:rgba(0,0,0,0.78)', 'padding:1px 4px', 'border-radius:3px',
        `color:${VisualLaw.COLORS.PLAYER}`, 'text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9)', 'pointer-events:auto', 'cursor:pointer',
      ].join(';');
      alab.textContent = SHIP_LABEL;
      arrow.appendChild(tri);
      arrow.appendChild(alab);
      this._root.appendChild(arrow);
      this._shipArrowEl = arrow;
      this._shipArrowTri = tri;
      this._shipArrowLabel = alab;
      const onShipClick = (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); this.toggleShipCard(); };
      for (const t of [hit, lab, tri, alab]) t.addEventListener('click', onShipClick);
    }
    const display = out.onScreen || (out.visible && !(W > 0 && H > 0)) ? 'block' : 'none';
    if (this._shipDisplay !== display) {
      this._shipEl.style.display = display;
      this._shipLabelEl.style.display = display;
      this._shipHit.style.display = display;
      this._shipDisplay = display;
    }
    if (display === 'block') {
      this._shipEl.style.left = `${out.x}px`;
      this._shipEl.style.top = `${out.y}px`;
      this._shipEl.style.transform = `translate(-50%,-50%) rotate(${angleRad + Math.PI / 4}rad)`;
      this._shipHit.style.left = `${out.x}px`;
      this._shipHit.style.top = `${out.y}px`;
      this._shipLabelEl.style.left = `${out.x}px`;
      this._shipLabelEl.style.top = `${out.y + SHIP_LABEL_DROP_PX}px`;
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
    // The card follows the marker (or its edge arrow); with neither on screen it closes.
    if (display === 'block') this._shipAnchor = { x: out.x, y: out.y };
    else if (out.edge) this._shipAnchor = { x: out.edge.x, y: out.edge.y };
    if (this._shipCardOpen) {
      if (display !== 'block' && !out.edge) { this._closeShipCard(); return out; }
      this._placeShipCard();
    }
    return out;
  }

  /** Remove the whole layer. */
  dispose() {
    this._closeShipCard();
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._shipEl = null;
    this._shipHit = null;
    this._shipCardEl = null;
    this._shipLabelEl = null;
    this._shipArrowEl = null;
    this._shipDisplay = undefined;
    this._shipArrowDisplay = undefined;
    this._icons.clear();
    this._sides.clear();
    this._built = false;
  }
}
