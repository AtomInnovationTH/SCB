/**
 * TargetReticle.js — Canvas 2D overlay for HUD reticle tracking
 * Inspired by Independence War (iWar) and MechWarrior 2 target tracking.
 * Projects 3D debris positions to 2D screen space and draws:
 *  - On-screen reticles (brackets/diamonds) with distance labels
 *  - Off-screen directional arrows along screen edges
 *  - Velocity vectors for selected target
 *
 * Session Q (plan D15/D15c): `colorLaw` is a dep
 * (`{ reachKm, threatId, threatTier, apTargetId }` or null). Null =
 * shipped colours (`?ladder=0` byte-identity).
 * @module ui/TargetReticle
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';
import { calmBreathe, finitePulse, prefersReducedMotion } from './hudPulse.js';
import { classify } from './hud/TargetColorLaw.js';
import { mono } from '../core/Typeface.js';
import { GestureHints } from './hud/GestureHints.js';   // u17: the fire prompt follows glass, read when drawn
import { isMarked } from '../systems/ScanMarks.js';
import { engineGasKg, engineDeltaV, engineTankDryKg, coldGasPoolToKg } from '../systems/ResourceSystem.js';
import { radToDeg, clamp01, clamp, lerp } from '../core/MathUtil.js';
import { VisualLaw } from '../core/VisualLaw.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_RETICLE_RANGE = 1.0;        // 100km in scene units
// Closing-rate readout (owner 10-27, "the closing 1 m/s flashes"). Measured with the real daughter approach: her last
// approach is commanded at exactly 0.5 m/s, the old line showed at |rate| >= 0.5 and rounded 0.5 up to "1", so the raw
// per-frame rate sat on the edge and the line flipped on rounding noise (137 flips in 3 s at 60 Hz). Now: an
// exponential average (about 0.3 s), shown from 0.3 m/s and hidden below 0.2 m/s (her 0.5 m/s approach reads steadily,
// to one decimal below 1 m/s). The average starts over when the measuring point jumps (the reticle measures from her only
// while she is flown, so a switch of view moves the point), see _relJump, and as a backstop when one frame's rate is more
// than CLOSING_BACKSTOP_MS away from the average.
const CLOSING_TAU_S = 0.3;
const CLOSING_SHOW_MS = 0.3;
const CLOSING_HIDE_MS = 0.2;
const CLOSING_JUMP_M = 1;            // a frame whose relative motion departs from the last frame's by more than this = a jump
const CLOSING_BACKSTOP_MS = 20;      // |raw - average| above this: start over
const CLOSING_STALE_S = 0.5;         // not seen this long: start over (hidden canvas, other target, off screen)
const EDGE_PADDING = 40;              // px from screen edge for arrows
const RETICLE_MIN_SIZE = 12;          // px minimum bracket size
const RETICLE_MAX_SIZE = 60;          // px maximum bracket size
const SELECTED_RETICLE_SCALE = 1.6;   // Selected target is bigger
/** Session O (plan D16 (b), owner 2026-09-07): the score strip's exclusion band
 *  expansion (px on every side) — an unselected bracket whose BOX (arms + dist
 *  label) touches the band + this pad is skipped whole (never a half-drawn reticle). */
const SCORE_STRIP_PAD_PX = 8;
/** Fixed y of the autopilot-engaged chip, and its height (px). `Constants.TEACHING.OVERLAY_AP_BADGE_BOTTOM_PX` must equal
 *  their sum (test-TeachingOverlay.js); `_drawApBadge` draws with both, so the drawing and the constant cannot drift. */
export const AP_BADGE_TOP_PX = 92;
export const AP_BADGE_H_PX = 19;

/** Color scheme */
const COLORS = {
  green:   VisualLaw.COLORS.PLAYER,
  yellow:  VisualLaw.COLORS.CAUTION,
  red:     '#ff4444',
  white:   '#ffffff',
  cyan:    '#4488ff',
  cyanDim: 'rgba(68,136,255,0.4)',
  magenta: '#ff44ff',
};

// ============================================================================
// OFF-SCREEN MARKER LABEL PLACEMENT (u13-polish D3) — pure, so it is testable without a canvas
// ============================================================================

/** Clear space kept between an edge arrow and its label block (px). */
export const OFFSCREEN_LABEL_GAP_PX = 4;

/**
 * The box (axis-aligned, px) that `_drawArrowShape(x, y, angle, size)` fills and strokes: its four corners rotated
 * exactly as the canvas does (`translate(x, y)`, `rotate(angle)`), grown by the stroke (the mitre at the tip reaches
 * ~1.35 line widths past the corner). Kept next to the draw call so a change to one shows in the other's test.
 * @param {number} x @param {number} y @param {number} angle @param {number} size @param {number} [lineWidth=2.5]
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function arrowShapeBox(x, y, angle, size, lineWidth = 2.5) {
  // `angle` is a CANVAS angle (clockwise from +x, y down): `_getEdgePosition` returns atan2(screen dy, dx), so the tip
  // (size, 0) lands on the bearing of the target. (u14: this used to be `-angle`, which pointed top / bottom arrows inward.)
  const th = angle;
  const c = Math.cos(th), sn = Math.sin(th);
  const pts = [[size, 0], [-size * 0.5, -size * 0.6], [-size * 0.2, 0], [-size * 0.5, size * 0.6]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of pts) {
    const rx = x + px * c - py * sn;
    const ry = y + px * sn + py * c;
    if (rx < x0) x0 = rx; if (rx > x1) x1 = rx;
    if (ry < y0) y0 = ry; if (ry > y1) y1 = ry;
  }
  const pad = lineWidth * 1.4;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/**
 * Where an off-screen marker's text goes: a centred block of lines, on the screen-centre side of its edge arrow, far
 * enough from the arrow's box that the two never touch (owner 2026-10-21: "FR▶MENT", the arrow drawn over the
 * letters). The old rule put the text centre a fixed 20 px behind the arrow, which on a side edge is inside half the
 * word's width. The block moves along the line from the arrow towards the screen centre until it clears the arrow box
 * by `gap`, so a long word sits further out than a short one.
 *
 * @param {object} o
 * @param {{x:number,y:number,angle:number}} o.edge   the arrow anchor (`_getEdgePosition`)
 * @param {number} o.size                             arrow size
 * @param {number} [o.lineWidth=2.5]
 * @param {Array<{w:number,h:number}>} o.lines        text lines, top to bottom (each is centred in the block)
 * @param {number} o.viewW @param {number} o.viewH    the canvas size (the block heads for its centre)
 * @param {number} [o.gap=OFFSCREEN_LABEL_GAP_PX]
 * @returns {{arrow:{x,y,w,h}, block:{x,y,w,h}, lines:Array<{cx:number, cy:number}>}}  line centres, for `textAlign:'center'` + `textBaseline:'middle'`
 */
export function offscreenLabelLayout(o) {
  const gap = o.gap != null ? o.gap : OFFSCREEN_LABEL_GAP_PX;
  const arrow = arrowShapeBox(o.edge.x, o.edge.y, o.edge.angle, o.size, o.lineWidth != null ? o.lineWidth : 2.5);
  const bw = Math.max(0, ...o.lines.map((l) => l.w));
  const bh = o.lines.reduce((n, l) => n + l.h, 0);
  // unit vector from the anchor towards the screen centre
  const vw = o.viewW > 0 ? o.viewW : 1280, vh = o.viewH > 0 ? o.viewH : 720;
  let ux = vw / 2 - o.edge.x, uy = vh / 2 - o.edge.y;
  const len = Math.hypot(ux, uy);
  if (len < 1e-6) { ux = 0; uy = 1; } else { ux /= len; uy /= len; }
  // smallest d >= 0 with the block centre c = anchor + u d separated from the arrow box on x or on y
  const acx = arrow.x + arrow.w / 2, acy = arrow.y + arrow.h / 2;
  const hx = (arrow.w + bw) / 2 + gap, hy = (arrow.h + bh) / 2 + gap;
  const rx = o.edge.x - acx, ry = o.edge.y - acy;
  const sepAt = (d) => Math.abs(rx + ux * d) >= hx - 1e-9 || Math.abs(ry + uy * d) >= hy - 1e-9;
  let d = 0;
  if (!sepAt(0)) {
    const cands = [];
    if (Math.abs(ux) > 1e-9) cands.push((hx - rx) / ux, (-hx - rx) / ux);
    if (Math.abs(uy) > 1e-9) cands.push((hy - ry) / uy, (-hy - ry) / uy);
    d = Math.min(...cands.filter((v) => v >= 0 && sepAt(v + 1e-6)).map((v) => v + 1e-6));
    if (!isFinite(d)) d = hx + hy;   // unreachable with a finite box; keeps the result finite
  }
  let cx = o.edge.x + ux * d, cy = o.edge.y + uy * d;
  // A wide block near a corner is slid back inside the canvas, but only if that keeps it clear of the arrow.
  const m = 2;
  const kx = clamp(cx, bw / 2 + m, vw - bw / 2 - m);
  const ky = clamp(cy, bh / 2 + m, vh - bh / 2 - m);
  if ((kx !== cx || ky !== cy) && vw >= bw + 2 * m && vh >= bh + 2 * m
      && (Math.abs(kx - acx) >= hx - 1e-9 || Math.abs(ky - acy) >= hy - 1e-9)) { cx = kx; cy = ky; }
  const block = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
  let top = block.y;
  const lines = o.lines.map((l) => { const c = { cx, cy: top + l.h / 2 }; top += l.h; return c; });
  return { arrow, block, lines };
}

// ============================================================================
// KEEPING MARKERS OFF THE HUD PANES (u14a) — pure helpers, testable without a canvas or a DOM
// ============================================================================

/** Ids of the HUD blocks a target marker must not cover (u14a A4). Rects are read from the DOM while shown. */
export const HUD_OBSTACLE_IDS = [
  'hud-score-panel', 'hud-left-column', 'hud-right-column', 'hud-targets-panel',
  'hud-comms-panel', 'hud-conjunction-panel',
];
/** The obstacle rects are re-read at most this often (seconds of reticle time) and on resize. */
export const OBSTACLE_REFRESH_S = 0.25;
/** Below this canvas width (phones, frozen by DECISIONS §32) there are no obstacles: today's drawing. */
export const OBSTACLE_MIN_VIEW_W = 920;
/** Clear space an edge marker keeps from an obstacle (px). */
export const OBSTACLE_GAP_PX = 4;
/** An edge arrow slides at most this fraction of the way to the screen centre looking for a clear spot. */
export const OBSTACLE_SLIDE_MAX = 0.8;
const OBSTACLE_SLIDE_STEP_PX = 32;   // coarse walk; the first clear stretch is then bisected down to OBSTACLE_SLIDE_FINE_PX
const OBSTACLE_SLIDE_FINE_PX = 1;

/**
 * The visible HUD blocks, as `{left, top, right, bottom}` client rects: width and height > 0, not `display:none` /
 * `visibility:hidden`. No DOM (tests, the menu backdrop) = an empty list.
 * @param {Document} [doc] @param {Window} [win]
 * @returns {Array<{left:number, top:number, right:number, bottom:number}>}
 */
export function readHudObstacles(doc = (typeof document !== 'undefined' ? document : null), win = (typeof window !== 'undefined' ? window : null)) {
  const out = [];
  if (!doc || typeof doc.getElementById !== 'function') return out;
  for (const id of HUD_OBSTACLE_IDS) {
    let el = null;
    try { el = doc.getElementById(id); } catch (_) { el = null; }
    if (!el || typeof el.getBoundingClientRect !== 'function') continue;
    const b = el.getBoundingClientRect();
    if (!b || !(b.width > 0) || !(b.height > 0)) continue;
    try {
      const cs = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
    } catch (_) { /* no computed style: the rect alone decides */ }
    out.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
  }
  return out;
}

/** The pane rect grown outward to whole pixels, so an anti-aliased clip edge never leaves a faint line inside the pane. */
export function snapRectOut(r) {
  return { left: Math.floor(r.left), top: Math.floor(r.top), right: Math.ceil(r.right), bottom: Math.ceil(r.bottom) };
}

/**
 * Rects that cover exactly the same area but never overlap each other (contained ones dropped, partly overlapping ones
 * cut into pieces). An even-odd clip needs this: two overlapping holes would cancel in their overlap and let a marker
 * through. Input and output are `{left, top, right, bottom}`.
 */
export function disjointRects(rects) {
  const pieces = [];
  for (const r of rects) {
    let cur = [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
    for (const q of pieces) {
      const next = [];
      for (const c of cur) {
        if (q.left >= c.right || q.right <= c.left || q.top >= c.bottom || q.bottom <= c.top) { next.push(c); continue; }
        if (c.top < q.top) next.push({ left: c.left, top: c.top, right: c.right, bottom: q.top });
        if (c.bottom > q.bottom) next.push({ left: c.left, top: q.bottom, right: c.right, bottom: c.bottom });
        const t = Math.max(c.top, q.top), b = Math.min(c.bottom, q.bottom);
        if (c.left < q.left) next.push({ left: c.left, top: t, right: q.left, bottom: b });
        if (c.right > q.right) next.push({ left: q.right, top: t, right: c.right, bottom: b });
      }
      cur = next;
    }
    for (const c of cur) if (c.right > c.left && c.bottom > c.top) pieces.push(c);
  }
  return pieces;
}

/** Area (px²) of the box `{x, y, w, h}` that lies inside the obstacle grown by `gap` on every side. */
export function boxObstacleOverlap(box, ob, gap = OBSTACLE_GAP_PX) {
  const w = Math.min(box.x + box.w, ob.right + gap) - Math.max(box.x, ob.left - gap);
  const h = Math.min(box.y + box.h, ob.bottom + gap) - Math.max(box.y, ob.top - gap);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Edge arrow clear of the HUD panes (u14a A3). If the arrow's box or its label block (from `layoutFn`) touches an
 * obstacle (+ gap), the anchor slides inward along the line from the anchor to the screen centre, so the arrow keeps
 * its bearing and still points at the target, and the label layout is recomputed at every step, until both boxes clear
 * every obstacle. It stops at `OBSTACLE_SLIDE_MAX` of the way; if nothing clears, the position with the least overlap wins.
 * Cost (u14a fix round 1): the walk is coarse (`opts.step`, 32 px), then the last blocked/clear pair is bisected to
 * `opts.fine` (1 px), so a slide of 150 px takes about 11 layout calls, not 75.
 *
 * @param {{x:number,y:number,angle:number}} edge   the anchor from `_getEdgePosition`
 * @param {{x:number,y:number}} centre              screen centre
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} obstacles
 * @param {(edge:{x:number,y:number,angle:number}) => {arrow:{x,y,w,h}, block:{x,y,w,h}}} layoutFn
 * @param {{gap?:number, max?:number, step?:number, fine?:number}} [opts]
 * @returns {{edge:{x:number,y:number,angle:number}, layout:object, moved:boolean, fraction:number, overlap:number}}
 */
export function clearOfObstacles(edge, centre, obstacles, layoutFn, opts = {}) {
  const gap = opts.gap != null ? opts.gap : OBSTACLE_GAP_PX;
  const max = opts.max != null ? opts.max : OBSTACLE_SLIDE_MAX;
  const step = opts.step != null ? opts.step : OBSTACLE_SLIDE_STEP_PX;
  const fine = opts.fine != null ? opts.fine : OBSTACLE_SLIDE_FINE_PX;
  const overlapAt = (lay) => {
    let n = 0;
    for (const ob of obstacles) n += boxObstacleOverlap(lay.arrow, ob, gap) + boxObstacleOverlap(lay.block, ob, gap);
    return n;
  };
  const first = layoutFn(edge);
  const o0 = obstacles && obstacles.length ? overlapAt(first) : 0;
  if (o0 === 0) return { edge, layout: first, moved: false, fraction: 0, overlap: 0 };
  const dx = centre.x - edge.x, dy = centre.y - edge.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { edge, layout: first, moved: false, fraction: 0, overlap: o0 };
  let best = { edge, layout: first, moved: false, fraction: 0, overlap: o0 };
  const reach = dist * max;                       // furthest slide, in px
  const n = Math.max(1, Math.floor(reach / step));
  const at = (px) => ({ x: edge.x + dx * (px / dist), y: edge.y + dy * (px / dist), angle: edge.angle });
  let lastBlocked = 0;                            // slide (px) of the last position that still overlapped
  for (let i = 1; i <= n; i++) {
    const px = Math.min(i * step, reach);
    const e = at(px);
    const lay = layoutFn(e);
    const o = overlapAt(lay);
    if (o < best.overlap) best = { edge: e, layout: lay, moved: true, fraction: px / dist, overlap: o };
    if (o === 0) {
      // first clear stretch found: bisect between the last blocked position and this one down to `fine` px
      let lo = lastBlocked, hi = px;
      while (hi - lo > fine) {
        const mid = (lo + hi) / 2;
        const em = at(mid);
        const lm = layoutFn(em);
        if (overlapAt(lm) === 0) { hi = mid; best = { edge: em, layout: lm, moved: true, fraction: mid / dist, overlap: 0 }; }
        else lo = mid;
      }
      break;
    }
    lastBlocked = px;
  }
  return best;
}

const NO_OBSTACLES = Object.freeze([]);

// ============================================================================
// TARGET RETICLE SYSTEM
// ============================================================================

export class TargetReticle {
  /**
   * @param {THREE.PerspectiveCamera} camera - The scene camera
   * @param {object} [opts]
   * @param {() => Array<{left:number,top:number,right:number,bottom:number}>} [opts.obstacleReader] — the HUD rects markers
   *   keep clear of (u14a A4); default: the visible HUD blocks read from the DOM (`readHudObstacles`).
   */
  constructor(camera, opts = {}) {
    this.camera = camera;

    // u14a: HUD rects target markers stay off (cached, re-read every OBSTACLE_REFRESH_S and on resize)
    this._obstacleReader = (opts && typeof opts.obstacleReader === 'function') ? opts.obstacleReader : null;
    this._obstacleCache = null;
    this._obstacleDisjoint = null;
    this._obstacleAt = 0;
    this._shakeX = 0;          // the shake translate in effect, so the clip stays in SCREEN coordinates
    this._shakeY = 0;
    this._apBadgeRect = null;  // where the AP chip was last drawn (edge arrows keep clear of it)
    this._apRectObj = { left: 0, top: 0, right: 0, bottom: 0 };  // reused every frame: no per-frame allocation
    this._edgeObsBase = null;  // the cached HUD list `_edgeObsList` was built from
    this._edgeObsList = null;  // HUD rects + the AP rect, for edge arrows while AP is on

    /** @type {HTMLCanvasElement} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = null;

    this._width = 0;
    this._height = 0;
    this._halfW = 0;
    this._halfH = 0;
    // Perf (2026-09-02): mirrors the canvas display state so update() can skip
    // the whole paint while hidden — setVisible() used to flip CSS only, and a
    // display:none canvas was still cleared + fully drawn every frame (menus,
    // the shop, the F6/F7 icon floors). The canvas starts visible (no display
    // rule in _createCanvas); main.js hides it at boot via setVisible(false).
    this._visible = true;

    // Reusable math objects
    this._tempVec3 = new THREE.Vector3();
    this._tempVec4 = new THREE.Vector4();
    this._projMatrix = new THREE.Matrix4();

    // Sprint 2 / PR A — scratch outputs for [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:1).
    // Hot path: per visible target per frame (5–15 calls/frame typical).
    this._tmpCartPos = { x: 0, y: 0, z: 0 };
    this._tmpCartVel = { x: 0, y: 0, z: 0 };

    // Cached target data
    this._selectedTargetId = null;
    this._capturedIds = new Set();  // UX Fix E+: Skip rendering captured debris
    this._debrisTargets = [];
    this._activeSatTargets = [];
    this._time = 0;

    // Closure rate tracking
    this.previousDistances = new Map();
    this._closing = new Map();      // target id -> { rate (m/s, smoothed), shown, t (reticle clock) }
    this._dt = 0;

    // First-encounter callout tracking
    this._progradeCalloutTimer = 0;
    this._retroCalloutTimer = 0;

    // Phase 1: Telemetry tracking
    this._thrustDirection = null;

    // Phase R6: Closure rate / ETA for selected target (prograde marker)
    this._selectedTargetDistKm = 0;
    this._prevSelectedTargetDist = null;
    this._prevClosureTargetId = null;   // reset tracking on target switch
    this._selRel = null;                // measuring-point tracker for the prograde line (see _relJump)
    this._selClosureKms = null;         // smoothed km/s behind _selectedClosureRate
    this._selClosureShown = false;      // hysteresis state of the prograde marker's "Closing: N m/s" line
    this._selectedClosureRate = 0;      // km/s, positive = closing

    // Phase R6: Cached player ΔV from PLAYER_TELEMETRY event
    this._cachedPlayerDeltaV = 0;

    // Phase R6: Periapsis proximity flag for Oberth hint
    this._nearPeriapsis = false;

    // Phase 5: Target Lock Ceremony animation state
    this._lockAnimT = 1;              // 0→1 over 300ms (1 = complete/idle)
    this._lockAnimActive = false;
    this._lockLostAnimT = 1;          // 0→1 over 200ms (1 = complete/idle)
    this._lockLostAnimActive = false;
    this._lockLostTargetId = null;    // ID of target being animated out

    // Phase 7: Autopilot visual indicator state
    this._apEngaged = false;
    this._apMode = '';
    this._apTargetName = '';
    this._apEngagedSince = null;      // Calm-HUD: drives the one-shot engage dip
    this._selectedScreenPos = null;   // { x, y } screen coords of selected target
    this._pairPiece = null;           // pair-shot: the pair's second piece (marked while a pair is offered), or null
    this._pairMarkScreen = null;      // pair-shot: where its mark was drawn this frame ({x, y}), null when it was not drawn

    // Listen for target events to trigger lock ceremonies.
    // Calm-HUD: under prefers-reduced-motion the ceremonies are skipped (the
    // CSS media block can't reach canvas draws) — selection still works, just
    // without the 300 ms size pop.
    eventBus.on(Events.TARGET_SELECTED, () => {
      this._lockAnimT = 0;
      this._lockAnimActive = !prefersReducedMotion();
      this._lockLostAnimActive = false; // Cancel any active lost animation
    });

    eventBus.on(Events.TARGET_CLEARED, () => {
      this._lockLostAnimT = 0;
      this._lockLostAnimActive = !prefersReducedMotion();
      this._lockLostTargetId = this._selectedTargetId;
      this._selectedTargetId = null; // Clear so brackets transition to lock-lost rendering
      this._selectedInRange = true;  // reset range state on clear
      this._outOfRangeFlashT = 0;    // clear any lingering OUT OF RANGE callout
    });

    // Reward-first spine: track whether the selected target is inside net-lock
    // range. Drives the yellow reticle color (out) vs cyan (in). The big
    // "OUT OF RANGE" TEXT, however, is BRIEF feedback: it only shows for
    // `_outOfRangeFlashT` seconds after the out-of-range crossing, then fades —
    // and never while in range. AutoLockController emits these on the crossing.
    this._selectedInRange = true;
    this._outOfRangeFlashT = 0;            // >0 = show the brief OUT OF RANGE text
    this._outOfRangeFlashDur = 1.6;        // seconds the callout stays up
    eventBus.on(Events.TARGET_IN_RANGE, () => {
      this._selectedInRange = true;
      this._outOfRangeFlashT = 0;          // hide immediately once in range
    });
    eventBus.on(Events.TARGET_OUT_OF_RANGE, () => {
      // Flash the text only on the in→out transition (not every frame it stays out).
      if (this._selectedInRange !== false) this._outOfRangeFlashT = this._outOfRangeFlashDur;
      this._selectedInRange = false;
    });

    // Phase 6: Lasso feedback state
    this._lassoInFlight = false;        // true while lasso projectile is active
    this._lassoCooldownTimer = 0;       // >0 after capture/cancel, counts down
    this._lassoCooldownMax = 2;         // matches LassoSystem cooldown (2s)
    this._lassoFlightTimeout = 0;       // safety: auto-clear in-flight after max time
    this._lassoDeniedTimer = 0;         // >0 = show denied red flash
    this._lassoShakeTimer = 0;          // >0 = screen micro-shake active
    this._lassoContactFlashTimer = 0;   // >0 = flash target bracket white
    this._lassoContactTargetId = null;  // ID of target hit by lasso

    // S9-B: Catch pulse state — bracket expand + green flash on capture
    this._catchPulseActive = false;
    this._catchPulseTime = 0;           // countdown from 0.3 → 0

    // Fading "▸ N" training wheel: a tiny fire-prompt under an in-range lock.
    // Deliberately UNHURRIED — it waits a grace period after the first in-range
    // lock (give the player time to look around) and only nudges across the
    // first two pieces, persisting on each until that piece is captured. It does
    // NOT vanish the instant the net is first fired (that left the 2nd piece with
    // no prompt and felt like it disappeared too fast). Helpful, not pushy.
    this._firstInRangeLockTime = null;  // _time (s) when an in-range lock first appeared
    this._debrisCleared = 0;            // captures seen — prompt caps out after 2

    eventBus.on(Events.LASSO_FIRED, () => {
      this._lassoInFlight = true;
      this._lassoCooldownTimer = 0;     // Not cooling yet — in flight
      this._lassoFlightTimeout = 65;    // 60s max flight + margin
      this._lassoShakeTimer = 0.1;      // 100ms micro-shake
    });

    eventBus.on(Events.LASSO_CAPTURED, (data) => {
      this._lassoInFlight = false;
      this._lassoCooldownTimer = this._lassoCooldownMax; // Start actual cooldown
      this._lassoFlightTimeout = 0;
      this.showCatchPulse(); // S9-B: bracket pulse on lasso catch
      // UX Fix E+: Hide captured debris reticle immediately
      if (data && data.debrisId) this._capturedIds.add(data.debrisId);
    });

    // S9-B: Bracket pulse on arm capture
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      // Count each cleared piece ONCE here for the "▸ N" cap. A Mother-net catch
      // emits BOTH LASSO_CAPTURED and ARM_CAPTURED (LassoSystem fires ARM_CAPTURED
      // "for catch juice"), so counting in both handlers double-counted and tripped
      // the 2-piece cap after a single catch. ARM_CAPTURED fires for net AND
      // daughter captures, so it's the single canonical place to tally.
      this._debrisCleared++;
      this.showCatchPulse();
      // UX Fix E+: Hide captured debris reticle immediately
      if (data && data.targetId) this._capturedIds.add(data.targetId);
    });

    // UX Fix E+: Cleanup captured ID when debris is fully removed from field
    eventBus.on(Events.DEBRIS_REMOVED, (data) => {
      if (data && data.id) this._capturedIds.delete(data.id);
    });

    eventBus.on(Events.LASSO_DENIED, () => {
      this._lassoDeniedTimer = 0.3; // 300ms red flash on arc
    });

    eventBus.on(Events.LASSO_CONTACT, (data) => {
      this._lassoContactFlashTimer = 0.2; // 200ms bracket flash
      this._lassoContactTargetId = data.targetId;
    });

    // Phase 7: Autopilot indicator events
    eventBus.on(Events.AUTOPILOT_ENGAGE, (data) => {
      this._apEngaged = true;
      this._apMode = data.mode || '';
      this._apTargetName = data.targetName || data.mode || '';
      // Calm-HUD: engagement is an EVENT — timestamp it so the badge gets one
      // finite acknowledgement dip, then reads steady.
      this._apEngagedSince = null;
    });
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this._apEngaged = false;
      this._apEngagedSince = null;
    });

    // View-config flags (set by CameraSystem progressive info levels)
    this._viewConfig = {
      showClosureRate: true,
    };

    // Session O (plan D16 (b), owner 2026-09-07): the score-strip exclusion band,
    // copied per frame from `data.exclusionRect` (the hub's cached hud.scoreStripRect())
    // into ONE reused instance rect (zero per-frame allocation; a later frame with
    // null data clears it — no lingering band).
    this._exclusionRect = null;
    this._colorLaw = null;

    this._createCanvas();
    this._onResize();
    window.addEventListener('resize', () => this._onResize());

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.VIEW_CONFIG_CHANGE, (config) => {
      this.setViewConfig(config);
    });
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      this.setVisible(gameplay);
    });
    eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
      this.setSelectedTarget(data.id);
    });

    // Phase R6: Listen for telemetry to cache player ΔV for post-burn readout
    eventBus.on(Events.PLAYER_TELEMETRY, (t) => {
      this._cacheDeltaV(t);
    });
  }

  /**
   * Cache the player's remaining ΔV for the post-burn readout. h3-argon-engine D4: the payload carries
   * `deltaV` straight from ArmManager.getMassBudget() (struts, cargo, tank, honest engine gas) — the
   * one source. Only a payload without it (bare tests, menu hero) falls back to the SAME shared
   * formula (ResourceSystem.engineDeltaV) over the resources mirror and the core + tank mass, with
   * getMassBudget()'s own Isp and c (h3b-argon-push D4): the ACTIVE fuel's Isp (the payload's
   * `currentFuelId`; the tank gas's when the payload names none — a cargo fuel only while it burns),
   * and the consumption multiplier the player puts in the payload (`consumptionMultiplier`).
   * @param {object} t - PLAYER_TELEMETRY payload
   * @private
   */
  _cacheDeltaV(t) {
    if (Number.isFinite(t.deltaV)) { this._cachedPlayerDeltaV = t.deltaV; return; }
    if (!t.resources) return;
    const res = t.resources;
    const fuel = Constants.FUELS[t.currentFuelId] || Constants.FUELS[res.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    this._cachedPlayerDeltaV = engineDeltaV({
      dryKg: Constants.OCTOPUS_V5.CORE_DRY_MASS + engineTankDryKg(res),
      coldGasKg: coldGasPoolToKg(res.coldGas || 0),
      gasKg: engineGasKg(res),
      isp: fuel.isp,
      c: t.consumptionMultiplier > 0 ? t.consumptionMultiplier : 1,
    });
  }

  // ==========================================================================
  // CANVAS SETUP
  // ==========================================================================

  /** @private Create the 2D canvas overlay */
  _createCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'reticle-canvas';
    this.canvas.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 11;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  /** @private Handle window resize */
  _onResize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.dpr = dpr;
    this._width = window.innerWidth;
    this._height = window.innerHeight;
    this._halfW = this._width / 2;
    this._halfH = this._height / 2;
    this._obstacleCache = null;   // u14a: the HUD moves with the window
    this.canvas.width = this._width * dpr;
    this.canvas.height = this._height * dpr;
    this.canvas.style.width = this._width + 'px';
    this.canvas.style.height = this._height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Set the currently selected target ID.
   * @param {number|null} id
   */
  setSelectedTarget(id) {
    this._selectedTargetId = id;
  }

  /**
   * Replace the function that returns the HUD rects markers keep clear of (tests; or a host with its own layout).
   * `null` = the default DOM reader. The cache is dropped.
   * @param {(() => Array<{left:number,top:number,right:number,bottom:number}>)|null} fn
   */
  setObstacleReader(fn) {
    this._obstacleReader = typeof fn === 'function' ? fn : null;
    this._obstacleCache = null;
  }

  /**
   * The visible HUD rects (u14a A4), cached for OBSTACLE_REFRESH_S of reticle time and dropped on resize. Empty below
   * OBSTACLE_MIN_VIEW_W (phones: today's drawing) and without a DOM.
   * @returns {Array<{left:number,top:number,right:number,bottom:number}>}
   */
  _getObstacles() {
    if (!(this._width >= OBSTACLE_MIN_VIEW_W)) return NO_OBSTACLES;
    const t = this._time || 0;
    if (this._obstacleCache == null || t - this._obstacleAt >= OBSTACLE_REFRESH_S || t < this._obstacleAt) {
      let r = null;
      try { r = (this._obstacleReader || readHudObstacles)(); } catch (_) { r = null; }
      this._obstacleCache = Array.isArray(r) ? r : [];
      this._obstacleDisjoint = null;
      this._obstacleAt = t;
    }
    return this._obstacleCache;
  }

  /** Obstacles for an edge arrow: the HUD blocks plus the AP chip while it is drawn (u14a A3 / A4). */
  _getEdgeObstacles() {
    const obs = this._getObstacles();
    if (obs === NO_OBSTACLES || !this._apEngaged || !this._apBadgeRect) return obs;
    // one list, rebuilt only when the cached HUD rects change (the AP rect is one object, updated in place)
    if (this._edgeObsBase !== obs || this._edgeObsList == null) {
      this._edgeObsBase = obs;
      this._edgeObsList = obs.concat([this._apBadgeRect]);
    }
    return this._edgeObsList;
  }

  /**
   * Cut the HUD blocks out of everything drawn from here to the caller's `ctx.restore()` (u14a A2): an even-odd clip of
   * the whole canvas minus each obstacle rect. In SCREEN coordinates — the lasso shake translates the canvas, so the
   * rects are shifted back by it. No obstacles = no clip call at all (today's call sequence).
   * @private
   */
  _clipToObstacles() {
    const obs = this._getObstacles();
    const ctx = this.ctx;
    if (!obs.length || !ctx || typeof ctx.clip !== 'function') return;
    if (this._obstacleDisjoint == null || this._obstacleDisjointFor !== obs) {
      this._obstacleDisjoint = disjointRects(obs.map(snapRectOut));
      this._obstacleDisjointFor = obs;
    }
    const sx = this._shakeX || 0, sy = this._shakeY || 0;
    const pad = 64;
    ctx.beginPath();
    ctx.rect(-pad - sx, -pad - sy, (this._width || 0) + 2 * pad, (this._height || 0) + 2 * pad);
    for (const r of this._obstacleDisjoint) ctx.rect(r.left - sx, r.top - sy, r.right - r.left, r.bottom - r.top);
    ctx.clip('evenodd');
  }

  /**
   * Set view-level rendering config (from CameraSystem info levels).
   * @param {object} config
   */
  setViewConfig(config) {
    if (!config) return;
    if (config.showClosureRate !== undefined)    this._viewConfig.showClosureRate    = config.showClosureRate;
  }

  /**
   * Main update — called each frame from the game loop.
   * @param {number} dt - Delta time
   * @param {object} data - Game data
   * @param {object} data.debrisField - DebrisField instance
   * @param {object} data.activeSatellites - ActiveSatellites instance
   * @param {THREE.Vector3} data.playerPos - Player position
   * @param {object} data.targetSelector - TargetSelector for selected target
   * @param {object} [data.playerVel] - Player velocity { x, y, z }
   */
  update(dt, data) {
    this._time += dt;
    this._dt = dt;

    // Session O (plan D16 (b)): copy the score-strip exclusion band from data into
    // the ONE reused instance rect (zero per-frame allocation; `exclusionRect` is
    // null off the ladder → cleared — byte-identical shipped path).
    if (data && data.exclusionRect) {
      if (!this._exclusionRect) this._exclusionRect = {};
      this._exclusionRect.left = data.exclusionRect.left;
      this._exclusionRect.top = data.exclusionRect.top;
      this._exclusionRect.right = data.exclusionRect.right;
      this._exclusionRect.bottom = data.exclusionRect.bottom;
    } else {
      this._exclusionRect = null;
    }
    this._colorLaw = (data && data.colorLaw) ? data.colorLaw : null;

    // Decrement first-encounter callout timers
    if (this._progradeCalloutTimer > 0) this._progradeCalloutTimer -= dt;
    if (this._retroCalloutTimer > 0) this._retroCalloutTimer -= dt;
    if (this._outOfRangeFlashT > 0) this._outOfRangeFlashT -= dt;

    // Advance lock ceremony timers
    if (this._lockAnimActive) {
      this._lockAnimT += dt / 0.3; // 300ms duration
      if (this._lockAnimT >= 1) {
        this._lockAnimT = 1;
        this._lockAnimActive = false;
      }
    }
    if (this._lockLostAnimActive) {
      this._lockLostAnimT += dt / 0.2; // 200ms duration
      if (this._lockLostAnimT >= 1) {
        this._lockLostAnimT = 1;
        this._lockLostAnimActive = false;
        this._lockLostTargetId = null;
      }
    }

    // Phase 6: Advance lasso feedback timers
    if (this._lassoCooldownTimer > 0) this._lassoCooldownTimer -= dt;
    if (this._lassoDeniedTimer > 0) this._lassoDeniedTimer -= dt;
    if (this._lassoShakeTimer > 0) this._lassoShakeTimer -= dt;
    if (this._lassoContactFlashTimer > 0) this._lassoContactFlashTimer -= dt;
    if (this._lassoFlightTimeout > 0) {
      this._lassoFlightTimeout -= dt;
      if (this._lassoFlightTimeout <= 0) {
        this._lassoInFlight = false; // Safety: clear stale in-flight state
        this._lassoCooldownTimer = 1; // Show brief cooldown arc for cancel case
      }
    }

    // S9-B: Advance catch pulse timer
    if (this._catchPulseActive) {
      this._catchPulseTime -= dt;
      if (this._catchPulseTime <= 0) {
        this._catchPulseActive = false;
        this._catchPulseTime = 0;
      }
    }

    // Perf (2026-09-02): hidden canvas → no paint. Everything above (timers,
    // ceremony/lasso/catch bookkeeping) has run so state stays correct across
    // a hide; the closure-rate derivative resets so the first visible frame
    // cannot spike off a stale distance. Nothing below is read by another
    // system — every cross-system input to the reticle arrives via events.
    if (!this._visible) {
      this._prevSelectedTargetDist = null; this._selClosureKms = null; this._selRel = null;
      if (this.previousDistances) this.previousDistances.clear();
      if (this._closing) this._closing.clear();
      return;
    }

    this.ctx.clearRect(0, 0, this._width, this._height);

    // Phase 6: Screen micro-shake on lasso fire (2px, 100ms)
    const doShake = this._lassoShakeTimer > 0;
    if (doShake) {
      this.ctx.save();
      this._shakeX = (Math.random() - 0.5) * 4;
      this._shakeY = (Math.random() - 0.5) * 4;
      this.ctx.translate(this._shakeX, this._shakeY);
    }

    if (!data || !data.playerPos) {
      if (doShake) { this.ctx.restore(); this._shakeX = this._shakeY = 0; }
      // 2026-05-15 polish task 4: also gate the early-return arc on SK,
      // matching the main-path gate below at line ~544. Without this the
      // green "Ready" ring would still render on the first frame after
      // SK entry while data is briefly absent.
      if (!data || data.skTargetId == null) {
        this._drawLassoCooldownArc();
      }
      return;
    }

    // Capture Phase 1 telemetry
    if (data.telemetry) {
      this._thrustDirection = data.telemetry.thrustDirection || null;
    }

    const { debrisField, activeSatellites, playerPos, targetSelector } = data;

    // Phase R6: Track selected target distance for prograde closure rate + ETA
    this._selectedTargetDistKm = 0;
    this._selectedClosureRate = 0;
    if (targetSelector && data.playerPos) {
      const selTarget = targetSelector.getActiveTarget();
      const selTargetId = selTarget ? selTarget.id : null;
      // Reset previous distance when target changes to avoid closure rate spikes
      if (selTargetId !== this._prevClosureTargetId) {
        this._prevSelectedTargetDist = null; this._selClosureKms = null; this._selRel = null;
        this._prevClosureTargetId = selTargetId;
      }
      if (selTarget && (selTarget._scenePosition || selTarget.orbit)) {
        // Prefer the rendered _scenePosition so PINNED pieces (#1/#2) report
        // their true range instead of a stale frozen-orbit distance.
        let tx, ty, tz;
        if (selTarget._scenePosition) {
          tx = selTarget._scenePosition.x;
          ty = selTarget._scenePosition.y;
          tz = selTarget._scenePosition.z;
        } else {
          // Sprint 2 / PR A — scratch-output variant.
          orbitToSceneCartesianInto(selTarget.orbit, this._tmpCartPos, this._tmpCartVel);
          tx = this._tmpCartPos.x;
          ty = this._tmpCartPos.y;
          tz = this._tmpCartPos.z;
        }
        const dx = tx - data.playerPos.x;
        const dy = ty - data.playerPos.y;
        const dz = tz - data.playerPos.z;
        const distKm = Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_SCALE;
        this._selectedTargetDistKm = distKm;
        if (!this._selRel) this._selRel = { has: false };
        const selJumped = this._relJump(this._selRel, dx, dy, dz, this._dt);
        if (selJumped) { this._prevSelectedTargetDist = null; this._selClosureKms = null; }   // measuring point moved: start over
        if (this._dt > 0 && this._prevSelectedTargetDist !== null) {
          // km/s; smoothed like the target's own line (same time constant), so the 1 m/s edge below cannot flicker
          const rawKms = (this._prevSelectedTargetDist - distKm) / this._dt;
          if (this._selClosureKms != null && Math.abs(rawKms - this._selClosureKms) * 1000 > CLOSING_BACKSTOP_MS) {
            this._selClosureKms = null;   // backstop: not a speed, start over (the next frame seeds the average)
          } else {
            this._selClosureKms = this._selClosureKms == null
              ? rawKms
              : lerp(this._selClosureKms, rawKms, 1 - Math.exp(-this._dt / CLOSING_TAU_S));
            this._selectedClosureRate = this._selClosureKms;
          }
        }
        this._prevSelectedTargetDist = distKm;
      } else {
        this._prevSelectedTargetDist = null; this._selClosureKms = null;
      }
    }

    // Phase R6: Periapsis detection for Oberth efficiency hint
    this._nearPeriapsis = false;
    if (data.playerOrbit) {
      const ecc = data.playerOrbit.eccentricity || 0;
      const ta = data.playerOrbit.trueAnomaly || 0;
      if (ecc > 0.01) {
        this._nearPeriapsis = (ta < Math.PI / 6) || (ta > (2 * Math.PI - Math.PI / 6));
      }
    }

    // Update projection matrix
    this.camera.updateMatrixWorld();
    this._projMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );

    // Get selected target ID from target selector
    if (targetSelector) {
      const activeTarget = targetSelector.getActiveTarget();
      if (activeTarget) {
        this._selectedTargetId = activeTarget.id;
      }
    }

    // --- Gather debris targets within range ---
    if (debrisField) {
      this._debrisTargets = debrisField.getDebrisNear(playerPos, MAX_RETICLE_RANGE);
    }

    // --- Gather active satellite targets ---
    if (activeSatellites) {
      this._activeSatTargets = activeSatellites.getSatelliteList(playerPos);
    }

    // Phase 7: Reset selected target screen pos each frame (avoid stale heading line)
    this._selectedScreenPos = null;
    this._pairMarkScreen = null;

    // During STATION_KEEP we want to silence all on-screen target chrome
    // EXCEPT a faint outline on the actual target debris.  The arm pilot is
    // focused on a single piece of debris ~8 m away — surrounding contacts'
    // brackets, labels, ETAs, and arrows are visual noise that pull the eye
    // away from the work.  We render the SK target with reduced globalAlpha
    // (no labels) so the pilot still has a positional confirmation.
    const skTargetId = data.skTargetId;
    if (skTargetId != null) {
      this.ctx.save();
      this.ctx.globalAlpha = 0.2;   // very faint outline only
      for (const target of this._debrisTargets) {
        if (target.id !== skTargetId) continue;
        if (!target.alive || target._captured || this._capturedIds.has(target.id)) continue;
        if (!isMarked(target)) continue;   // scan-first: no mark until a scan reveals it
        this._drawDebrisReticle(target, playerPos);
      }
      this.ctx.restore();
      // Skip neighbouring debris + active sats entirely while station-keeping.
    } else {
      // --- Draw reticles for debris ---
      // Scan-first (DECISIONS §15 row 1): an undiscovered piece gets no bracket
      // and no off-screen arrow until a scan (S) reveals it. The list stays
      // unfiltered — getDebrisNear's result is a frame-shared cache the scan
      // reveal also reads, so it must never be compacted in place.
      for (const target of this._debrisTargets) {
        if (!target.alive || target._captured || this._capturedIds.has(target.id)) continue;
        if (!isMarked(target)) continue;
        this._drawDebrisReticle(target, playerPos);
      }

      // --- Draw reticles for active satellites ---
      for (const sat of this._activeSatTargets) {
        if (sat.distance / Constants.SCENE_SCALE > 100) continue; // Skip if > 100km
        this._drawActiveSatReticle(sat, playerPos);
      }

      // --- The pair's second piece (pair-shot, owner 2026-10-25 "2 a"): marked only while a pair is offered ---
      this._pairPiece = data.pairPiece || null;
      if (this._pairPiece && this._pairPiece.alive !== false) this._drawPairMarker(this._pairPiece);
    }

    // Clean up stale closure rate entries
    const activeIds = new Set(this._debrisTargets.map(t => t.id));
    for (const id of this.previousDistances.keys()) {
      if (!activeIds.has(id)) this.previousDistances.delete(id);
    }
    if (this._closing) {
      for (const id of this._closing.keys()) {
        if (!activeIds.has(id)) this._closing.delete(id);
      }
    }

    // Phase 6: Restore shake transform
    if (doShake) { this.ctx.restore(); this._shakeX = this._shakeY = 0; }

    // Calm-HUD: autopilot-engaged badge — drawn from the top level, AFTER the
    // shake restore (a mode readout should not shake).
    if (this._apEngaged) this._drawApBadge(); else this._apBadgeRect = null;

    // Phase 6: Draw lasso cooldown arc (on top, no shake).
    // 2026-05-15 polish task 4: the cooldown arc's "Ready" state is a
    // green ring (#00ff88 @ α0.35, radius 22) drawn at screen-centre —
    // exactly the mid-screen green circle the user reported as still
    // visible during SK. The pilot isn't going to fire a lasso while
    // parked on a target (Space is bound to capture in SK at line 777),
    // so the arc has no purpose there and is purely visual noise inside
    // the SK target bracket. Skip when in SK.
    if (data.skTargetId == null) {
      this._drawLassoCooldownArc();
    }
  }

  /**
   * Show/hide the canvas. Also gates the per-frame paint in update() (perf):
   * a hidden reticle keeps its timers ticking but draws nothing.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._visible = !!visible;
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /** @returns {boolean} whether the reticle canvas is shown (and painted). */
  isVisible() { return this._visible; }

  /**
   * Sim mode: catch pulse is disabled — no bracket flash, no green glow.
   * Previously expanded brackets +30% and flashed #00ff88 over 300ms, which
   * read as arcade sparks on capture. Removed per user feedback.
   */
  showCatchPulse() {
    // no-op — keep method signature for external call sites.
  }

  // ==========================================================================
  // PROJECTION
  // ==========================================================================

  /**
   * pair-shot: the mark on the pair's SECOND piece (the first, the selected one, keeps its own reticle): an amber double diamond with
   * "PAIR" under it, unlike the selected piece's bracket; off screen, an amber chevron at the edge toward it. Drawn only while a pair is
   * offered (main.js passes `pairPiece` = the second piece, else nothing).
   * @param {{_scenePosition: {x:number,y:number,z:number}}} piece
   * @private
   */
  _drawPairMarker(piece) {
    const sp = piece && piece._scenePosition;
    if (!sp) return;
    const proj = this._project(sp);
    const ctx = this.ctx;
    const amber = '#ffcf4a';
    ctx.save();
    ctx.strokeStyle = amber; ctx.fillStyle = amber; ctx.lineWidth = 2; ctx.globalAlpha = 0.95;
    ctx.font = mono(11); ctx.textAlign = 'center';
    const diamond = (x, y, r) => {
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath(); ctx.stroke();
    };
    if (proj.visible) {
      diamond(proj.x, proj.y, 18);
      diamond(proj.x, proj.y, 11);
      ctx.fillText('PAIR', proj.x, proj.y + 34);
      this._pairMarkScreen = { x: proj.x, y: proj.y };
    } else {
      let dx = proj.x - this._halfW, dy = proj.y - this._halfH;
      if (proj.behind) { dx = -dx; dy = -dy; }
      const ang = Math.atan2(dy, dx), m = 30;
      const k = Math.min((this._halfW - m) / (Math.abs(Math.cos(ang)) || 1e-6), (this._halfH - m) / (Math.abs(Math.sin(ang)) || 1e-6));
      const ex = this._halfW + Math.cos(ang) * k, ey = this._halfH + Math.sin(ang) * k;
      ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-8, -9); ctx.lineTo(-3, 0); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
      ctx.fillText('PAIR', 0, 24);
      this._pairMarkScreen = { x: ex, y: ey };
    }
    ctx.restore();
  }

  /**
   * Project a 3D world position to 2D screen coordinates.
   * @param {THREE.Vector3} worldPos
   * @returns {{ x: number, y: number, z: number, visible: boolean }}
   */
  _project(worldPos) {
    this._tempVec4.set(worldPos.x, worldPos.y, worldPos.z, 1.0);
    this._tempVec4.applyMatrix4(this._projMatrix);

    const w = this._tempVec4.w;
    if (Math.abs(w) < 1e-10) {
      return { x: 0, y: 0, z: 0, visible: false, behind: true };
    }

    const ndcX = this._tempVec4.x / w;
    const ndcY = this._tempVec4.y / w;
    const ndcZ = this._tempVec4.z / w;

    // Behind camera check
    const behind = w < 0;

    // Convert NDC to screen pixels
    const screenX = (ndcX + 1) * this._halfW;
    const screenY = (1 - ndcY) * this._halfH;

    // Check if within viewport (with small margin)
    const margin = 50;
    const visible = !behind &&
      ndcX >= -1 && ndcX <= 1 &&
      ndcY >= -1 && ndcY <= 1 &&
      ndcZ >= -1 && ndcZ <= 1;

    return { x: screenX, y: screenY, z: ndcZ, visible, behind, ndcX, ndcY };
  }

  /**
   * Calculate edge-of-screen position for off-screen arrow.
   * @param {number} ndcX - NDC x (-1 to 1, or beyond)
   * @param {number} ndcY - NDC y (-1 to 1, or beyond)
   * @param {boolean} behind - Whether target is behind camera
   * @returns {{ x: number, y: number, angle: number }}
   */
  _getEdgePosition(ndcX, ndcY, behind) {
    // If behind camera, flip direction
    let dx = ndcX;
    let dy = ndcY;
    if (behind) {
      dx = -dx;
      dy = -dy;
    }

    // Normalize to unit direction
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) {
      dx = 0; dy = -1; // Default: point up
    } else {
      dx /= len;
      dy /= len;
    }

    // Find intersection with screen edges
    const pad = EDGE_PADDING;
    const edgeW = this._width - pad * 2;
    const edgeH = this._height - pad * 2;

    // Scale so that the longer axis hits the edge
    let scale;
    if (Math.abs(dx) * edgeH > Math.abs(dy) * edgeW) {
      scale = (edgeW / 2) / Math.abs(dx);
    } else {
      scale = (edgeH / 2) / Math.abs(dy);
    }

    const ex = this._halfW + dx * scale;
    const ey = this._halfH - dy * scale; // Flip Y for screen coords

    // Angle for the arrow (points toward target)
    const angle = Math.atan2(-dy, dx); // Screen space angle

    return {
      x: clamp(ex, pad, this._width - pad),
      y: clamp(ey, pad, this._height - pad),
      angle,
    };
  }

  /**
   * @private Did the measuring point jump this frame? `st` keeps the last relative position (target minus observer, scene
   * units) and last relative velocity; a jump is a frame whose relative velocity differs from the last frame's by more
   * than CLOSING_JUMP_M metres over the frame (a real approach or fly-by moves steadily, a switch of observer does not).
   * After a jump the velocity memory is dropped, so the frame after it is not compared against the jump itself.
   */
  _relJump(st, dx, dy, dz, dt) {
    let jumped = false;
    if (st.has && dt > 0) {
      const vx = (dx - st.x) / dt, vy = (dy - st.y) / dt, vz = (dz - st.z) / dt;
      if (st.hasV) {
        const devU = Math.hypot(vx - st.vx, vy - st.vy, vz - st.vz) * dt;   // scene units
        jumped = devU * 1000 / Constants.SCENE_SCALE > CLOSING_JUMP_M;
      }
      st.hasV = !jumped; st.vx = vx; st.vy = vy; st.vz = vz;
    } else {
      st.hasV = false;
    }
    st.has = true; st.x = dx; st.y = dy; st.z = dz;
    return jumped;
  }

  /**
   * @private Smoothed closing rate for the selected target (m/s, positive = closing). `raw` is this frame's finite
   * difference. Exponential average (CLOSING_TAU_S), per target id; the readout shows from CLOSING_SHOW_MS and hides
   * below CLOSING_HIDE_MS, so a rate sitting on an edge cannot flip it frame to frame. A target not seen for
   * CLOSING_STALE_S starts over, and the sample that ends the gap is dropped (its previous distance is old).
   * @returns {{rate:number, shown:boolean}|null} null while there is no valid sample yet
   */
  _smoothClosing(id, raw, rel) {
    if (!this._closing) this._closing = new Map();
    let e = this._closing.get(id);
    if (!e || this._time - e.t > CLOSING_STALE_S) {
      e = { rate: null, shown: false, t: this._time, rel: { has: false } };
      this._closing.set(id, e);
      if (rel) this._relJump(e.rel, rel.x, rel.y, rel.z, this._dt);
      return null;
    }
    e.t = this._time;
    // The measuring point jumped (observer or reference changed), or this frame's rate is far from the average: the
    // frame's difference is not a speed. Start over; the next frame seeds the average.
    const jumped = rel ? this._relJump(e.rel, rel.x, rel.y, rel.z, this._dt) : false;
    if (jumped || (e.rate !== null && Math.abs(raw - e.rate) > CLOSING_BACKSTOP_MS)) {
      e.rate = null; e.shown = false;
      return null;
    }
    if (!Number.isFinite(raw)) return e.rate === null ? null : e;
    if (e.rate === null) {
      e.rate = raw;
    } else {
      e.rate += (raw - e.rate) * (1 - Math.exp(-this._dt / CLOSING_TAU_S));
    }
    const a = Math.abs(e.rate);
    e.shown = e.shown ? a >= CLOSING_HIDE_MS : a >= CLOSING_SHOW_MS;
    // One decimal below 1 m/s, whole numbers from 1: switch at 0.85 / 0.95 with memory, so a rate hovering near 1 m/s
    // does not alternate "1 m/s" and "0.9 m/s".
    e.dec = e.dec == null ? a < 0.9 : (e.dec ? a < 0.95 : a < 0.85);
    return e;
  }

  // ==========================================================================
  // DEBRIS RETICLE DRAWING
  // ==========================================================================

  /**
   * Draw reticle for a debris target (on-screen or off-screen arrow).
   * @private
   */
  _drawDebrisReticle(target, playerPos) {
    // World position + velocity. Compute orbit velocity into _tmpCartVel (used
    // by the velocity-vector / lead rendering below), but PREFER the
    // authoritative rendered _scenePosition for the bracket position: onboarding
    // PINNED pieces (#1/#2) skip orbit propagation each frame, so their orbit is
    // stale and orbitToSceneCartesian would draw the bracket far from where the
    // debris actually renders (the reported "reticle won't focus on #1/#2" bug).
    // getDebrisNear carries _scenePosition as a clone on the snapshot.
    orbitToSceneCartesianInto(target.orbit, this._tmpCartPos, this._tmpCartVel);
    if (target._scenePosition) {
      this._tempVec3.set(target._scenePosition.x, target._scenePosition.y, target._scenePosition.z);
    } else {
      this._tempVec3.set(this._tmpCartPos.x, this._tmpCartPos.y, this._tmpCartPos.z);
    }
    const worldPos = this._tempVec3;

    // Project to screen
    const proj = this._project(worldPos);
    const distKm = target.distanceKm;

    // Track closure rate (distance delta over time)
    target._closureRate = null;
    target._closureShown = false;
    target._closureDec = false;
    if (this._dt > 0) {
      const prevDist = this.previousDistances.get(target.id);
      this.previousDistances.set(target.id, distKm);
      if (prevDist !== undefined) {
        const raw = (prevDist - distKm) * 1000 / this._dt; // m/s, raw per frame (noisy; only the smoothed value is shown)
        if (target.id === this._selectedTargetId) {
          const c = this._smoothClosing(target.id, raw, playerPos
            ? { x: worldPos.x - playerPos.x, y: worldPos.y - playerPos.y, z: worldPos.z - playerPos.z } : null);
          if (c) { target._closureRate = c.rate; target._closureShown = c.shown; target._closureDec = !!c.dec; }
        } else {
          target._closureRate = raw;
        }
      }
    }

    const isSelected = target.id === this._selectedTargetId;

    // Phase 7: Capture selected target screen position for AP heading line
    if (isSelected && proj.visible) {
      this._selectedScreenPos = { x: proj.x, y: proj.y };
    }

    const cl = this._colorLaw;
    const law = cl ? classify({
      selected: isSelected,
      managed: cl.apTargetId != null && target.id === cl.apTargetId,
      threatTier: (cl.threatId != null && target.id === cl.threatId) ? cl.threatTier : null,
      hydrazine: !!(target.salvage && target.salvage.hydrazine),
      tumbleDegS: radToDeg(target.tumbleRate),
      massKg: target.mass,
      distanceKm: distKm,
      reachKm: cl.reachKm,
    }) : null;
    const color = law ? law.color : this._getDebrisColor(target);

    if (proj.visible) {
      // === ON-SCREEN RETICLE ===
      // Sprint 2 / PR A fix — pass the velocity scratch directly. The old
      // `cart` binding (a `{position, velocity}` literal from the allocating
      // `orbitToSceneCartesian`) was removed when this site migrated to the
      // scratch-output variant at line 677, but the downstream argument and
      // four `cart.velocity.*` reads inside `_drawOnScreenReticle` were left
      // dangling — causing `ReferenceError: cart is not defined` every frame
      // in ORBITAL_VIEW. `_tmpCartVel` is the velocity object written by
      // `orbitToSceneCartesianInto` above; it carries `.x/.y/.z` km/s directly
      // (no nested `.velocity`).
      this._drawOnScreenReticle(proj, target, color, isSelected, distKm, worldPos, playerPos, this._tmpCartVel, law);
    } else {
      // === OFF-SCREEN ARROW ===
      const showArrow = law ? law.arrow : (isSelected || distKm < 50 || (target.type === 'rocketBody' && distKm < 30));
      if (showArrow) {
        this._drawOffScreenArrow(proj, target, color, isSelected, distKm, law);
      }
    }
  }

  /** @private u17: glass is read when a caption is drawn, never cached; no GestureHints (headless) means desktop. */
  _glassNow() {
    return !!(GestureHints && typeof GestureHints.isGlass === 'function' && GestureHints.isGlass());
  }

  /**
   * Draw on-screen bracket reticle for debris.
   * @private
   * @param {{x:number,y:number,z:number}|null} vel — km/s velocity scratch from
   *   [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:593). The
   *   parameter shape changed in Sprint 2 / PR A: callers now pass the velocity
   *   scratch object directly instead of a `{position, velocity}` wrapper.
   */
  _drawOnScreenReticle(proj, target, color, isSelected, distKm, worldPos, playerPos, vel, law = null) {
    const ctx = this.ctx;
    const x = proj.x;
    const y = proj.y;

    // Size scales with distance (larger when closer)
    const distFactor = clamp(5.0 / (distKm + 1), 0.2, 1.0);
    let size = lerp(RETICLE_MIN_SIZE, RETICLE_MAX_SIZE, distFactor);

    // Target lock ceremony state
    const isLockLost = !isSelected && target.id === this._lockLostTargetId && this._lockLostAnimActive;

    if (isSelected) {
      size *= SELECTED_RETICLE_SCALE;
      // Lock-on ceremony: brackets shrink from 2.5× → 1× over 300ms
      if (this._lockAnimActive) {
        size *= 1 + 1.5 * (1 - this._easeOutCubic(this._lockAnimT));
      }
      // Calm-HUD: no standing size breathe on the selected reticle — the lock
      // ceremony above covers the selection event; steady brackets after that.
    } else if (isLockLost) {
      // Lock-lost ceremony: start at selected scale, expand to 2×
      size *= SELECTED_RETICLE_SCALE * (1 + this._lockLostAnimT);
    }

    // S9-B: Catch pulse — expand brackets outward during pulse
    if (this._catchPulseActive && isSelected) {
      const pulseProgress = Math.max(0, this._catchPulseTime / 0.3);
      size *= 1 + 0.3 * pulseProgress; // 1.3× at start, 1.0× at end
    }

    const half = size / 2;
    const corner = size * 0.3; // Corner bracket length

    // Reward-first spine: a selected-but-OUT-OF-RANGE target renders YELLOW
    // (no lock glow) — the silent "too far for the net" state that teaches
    // Autopilot. In range → cyan lock. Derived once here and reused by both the
    // bracket and label sub-sections below to avoid drift within this method.
    const outOfRange = this._selectedInRange === false;
    const selColor = law ? law.color : (outOfRange ? COLORS.yellow : COLORS.cyan);

    // Session O (plan D16 (b), owner 2026-09-07): the score-strip exclusion
    // band — an UNSELECTED debris bracket whose BOX (the arms, `x ± half` /
    // `y ± half`, down to its dist label at `y + half + 22`) would touch the
    // strip's rect + the 8 px pad is skipped WHOLE — never a half reticle
    // under the strip, never a bracket+label pair the strip's opaque panel
    // sits over (chrome-over-chrome, the owner's D16 (b) screenshot). The
    // review of the gate pictures tightened the rule from the label anchor
    // to the box: a large near bracket's top arm still crossed the strip while
    // its label cleared it. The SELECTED target is exempt — its bracket is the
    // player's lock (the teaching overlay points at it); the strip is small
    // and a lock under it is brief. Off-screen arrows are drawn by a
    // different path and are unaffected. Zero per-frame allocation: reads
    // only (the reused instance rect + this method's existing x/y/half
    // numbers). Null (flag-off) → byte-identical shipped path.
    const ex = this._exclusionRect;
    if (ex != null && !isSelected) {
      // Session Q: the caution word rides ABOVE the box (baseline y - half - 6,
      // ~11 px glyphs, up to ~80 px wide) — it is part of the box for this test,
      // so an amber TUMBLING never lands on the strip. Null law → the O box.
      const wordUp = (law && law.word) ? 17 : 0;
      const reach = Math.max(half > 30 ? half : 30, wordUp ? 40 : 0);   // the dist label is centred at x, ~60 px wide at most
      if (x + reach >= ex.left - SCORE_STRIP_PAD_PX && x - reach <= ex.right + SCORE_STRIP_PAD_PX &&
          y + half + 22 + 4 >= ex.top - SCORE_STRIP_PAD_PX && y - half - wordUp <= ex.bottom + SCORE_STRIP_PAD_PX) {
        return;
      }
    }

    ctx.save();
    this._clipToObstacles();

    if (isSelected) {
      // Steady alpha for selected target (Issue #5 — removed pulse)
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = selColor;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH_SELECTED || 3.0;

      // White corner flash at start of lock-on animation (~60ms window) — only
      // for an in-range lock (the flash is the "locked, act now" cue).
      if (!outOfRange && this._lockAnimActive && this._lockAnimT < 0.20) {
        ctx.strokeStyle = COLORS.white;
        ctx.shadowColor = COLORS.white;
        ctx.shadowBlur = 16;
      } else {
        // Outer glow
        ctx.shadowColor = selColor;
        ctx.shadowBlur = 0;
      }
    } else if (isLockLost) {
      // Lock-lost: cyan brackets fading out
      ctx.globalAlpha = 1 - this._lockLostAnimT;
      ctx.strokeStyle = COLORS.cyan;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH_SELECTED || 3.0;
      ctx.shadowColor = COLORS.cyan;
      ctx.shadowBlur = 8 * (1 - this._lockLostAnimT);
    } else if (law) {
      ctx.globalAlpha = law.alpha;
      ctx.strokeStyle = law.color;
      ctx.lineWidth = law.weight === 'thick' ? (Constants.RETICLE_BRACKET_WIDTH_SELECTED || 3.0) : (Constants.RETICLE_BRACKET_WIDTH || 2.0);
    } else {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = color;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH || 2.0;
    }

    // Phase 6: Lasso contact flash — temporarily override bracket to white
    if (this._lassoContactFlashTimer > 0 && target.id === this._lassoContactTargetId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLORS.white;
      ctx.lineWidth = 3;
      ctx.shadowColor = COLORS.white;
      ctx.shadowBlur = 16;
    }

    // S9-B: Catch pulse — green-cyan flash on selected target brackets
    if (this._catchPulseActive && isSelected) {
      const pulseProgress = Math.max(0, this._catchPulseTime / 0.3);
      ctx.globalAlpha = 0.7 + 0.3 * pulseProgress;
      ctx.strokeStyle = VisualLaw.COLORS.PLAYER;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = VisualLaw.COLORS.PLAYER;
      ctx.shadowBlur = 12 * pulseProgress;
    }

    // Draw corner brackets [ ]
    ctx.beginPath();
    // Top-left corner
    ctx.moveTo(x - half, y - half + corner);
    ctx.lineTo(x - half, y - half);
    ctx.lineTo(x - half + corner, y - half);
    // Top-right corner
    ctx.moveTo(x + half - corner, y - half);
    ctx.lineTo(x + half, y - half);
    ctx.lineTo(x + half, y - half + corner);
    // Bottom-right corner
    ctx.moveTo(x + half, y + half - corner);
    ctx.lineTo(x + half, y + half);
    ctx.lineTo(x + half - corner, y + half);
    // Bottom-left corner
    ctx.moveTo(x - half + corner, y + half);
    ctx.lineTo(x - half, y + half);
    ctx.lineTo(x - half, y + half - corner);
    ctx.stroke();

    // Reset shadow
    ctx.shadowBlur = 0;

    // Lock-lost ceremony: only draw fading brackets, skip all labels
    if (isLockLost) {
      ctx.restore();
      return;
    }

    // --- Distance text below reticle ---
    // 2026-05-28 (Item 7 readability pass): font sizes doubled (10/11/9 → 20/22/18)
    // and vertical offsets re-spaced to clear the larger glyph height. The
    // sequence below reticle is: distance (20 px) → closure rate (18 px) →
    // metal preview (18 px). Baselines need ~22 px spacing per row to avoid
    // overlap; previously they were at +14/+26/+38 (12 px spacing).
    ctx.font = mono(20);
    ctx.fillStyle = law ? law.color : color;
    ctx.textAlign = 'center';

    if (isSelected) {
      if (!law) ctx.fillStyle = COLORS.cyan;
      ctx.font = mono(22, 'bold');
    }

    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    ctx.fillText(distText, x, y + half + 22);

    // --- Closure rate below distance (selected target only) ---
    // Plain words ("Closing"/"Opening") instead of ▲/▼ jargon for newcomers,
    // and nothing at all when the rate is negligible (no dead "0 m/s" line).
    if (isSelected && target._closureRate != null && target._closureShown && this._viewConfig.showClosureRate) {
      const rate = target._closureRate;           // smoothed (see _smoothClosing)
      const absRate = Math.abs(rate);
      ctx.font = mono(18);
      ctx.textAlign = 'center';
      ctx.fillStyle = rate > 0 ? COLORS.green : COLORS.red;
      ctx.fillText(`${rate > 0 ? 'Closing' : 'Opening'} ${target._closureDec ? absRate.toFixed(1) : absRate.toFixed(0)} m/s`, x, y + half + 46);
    }

    if (law && law.word && !(isSelected && target._despinning)) {
      ctx.font = mono(11, 'bold');
      ctx.fillStyle = law.wordColor;
      ctx.textAlign = 'center';
      ctx.fillText(law.word, x, y - half - 6);
    }

    // Phase R6: Metal loot preview — removed 2026-06-14 (declutter). The
    // refined-metal breakdown lives in the target dossier / shop; the floating
    // "Al:..kg" metal line next to every selected target was noise.

    // --- Selected target: extra info ---
    if (isSelected) {
      // Reward-first spine: brief "OUT OF RANGE" callout below the distance when
      // the selected target is beyond net-lock range. The onboarding comms point
      // directly at this label ("see OUT OF RANGE"), so the wording is load-bearing.
      if (outOfRange && this._outOfRangeFlashT > 0) {
        // Fade out over the last 0.5 s of the flash.
        const a = clamp01(this._outOfRangeFlashT / 0.5);
        ctx.save();
        ctx.globalAlpha *= a;
        ctx.font = mono(16, 'bold');
        ctx.fillStyle = COLORS.yellow;
        ctx.fillText('OUT OF RANGE', x, y + half + 70);
        ctx.restore();
      }

      // CP-2: DE-SPIN feedback — shown ONLY while the mother laser is actively
      // firing (actionable "the de-spin is working" cue). The idle tumble°/s and
      // size numerics were removed: the bracket color already encodes danger, and
      // the raw figures live in the target dossier (TargetPanel) for those who
      // want them. A newcomer can't act on "34.2°/s 1.5m".
      if (target._despinning) {
        ctx.font = mono(11, 'bold');
        ctx.fillStyle = selColor;
        ctx.fillText('\u25BC DE-SPIN', x, y - half - 6);
      }

      // Fading "▸ N" fire prompt — co-locates the comms lesson ("fire the Mother
      // net with N") on the bracket the eye is already on. Deliberately gentle:
      //   • only on an IN-RANGE lock,
      //   • only across the first two pieces (capped by captures, NOT by the
      //     first fire — so it returns for the 2nd piece), persisting on each
      //     until that piece is captured, and
      //   • only after a ~4 s grace from the first in-range lock — the player
      //     gets to look around first (the grace is global, so by the 2nd piece
      //     it shows promptly). Fades in over 0.8 s, then soft-pulses.
      const NUDGE_DELAY_S = 4;
      if (!outOfRange && this._debrisCleared < 2) {
        if (this._firstInRangeLockTime == null) this._firstInRangeLockTime = this._time;
        const sinceLock = this._time - this._firstInRangeLockTime;
        // u17 browser-check fix (owner u15 D5): on a touch screen the N key is never shown, and this prompt has no touch control to
        // name instead (the LAUNCH NET chip and the comms lesson teach the net there), so it is left out. Read at draw time.
        if (sinceLock >= NUDGE_DELAY_S && !this._glassNow()) {
          // Stays visible until the net is fired, but the pulse is intentionally
          // calm: a slow breath (~0.29 Hz) whose amplitude eases from ±0.16 down
          // to ±0.05 over the first ~6 s, so it greets the eye then settles into
          // a soft steady glow rather than nagging. (This is the reference shape
          // calmBreathe() encodes — keep the explicit opts so it stays exact.)
          const shownFor = sinceLock - NUDGE_DELAY_S;
          ctx.save();
          ctx.globalAlpha = calmBreathe(this._time, shownFor, { base: 0.8 });
          ctx.font = mono(18, 'bold');
          ctx.fillStyle = COLORS.cyan;
          ctx.fillText('\u25B8 N', x, y + half + 70);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }

  /**
   * Draw the autopilot-engaged badge at a FIXED screen position.
   *
   * A mode as consequential as "the autopilot is flying my ship" is drawn unconditionally,
   * never inside another overlay's visibility check.
   *
   * Calm-HUD: salience comes from WEIGHT, not motion — a bordered, amber-tinted
   * chip with a static glow, at a stable position so it is learnable. The only
   * motion is a single finite dip when AP engages (an event); then dead steady.
   * @private
   */
  _drawApBadge() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this._apEngagedSince == null) this._apEngagedSince = this._time;

    const label = `\u25C9 AP \u2192 ${this._apTargetName}`;
    ctx.save();
    ctx.font = mono(12, 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // measureText is absent from the headless canvas mock — fall back to a
    // fixed-pitch advance estimate so draw code stays test-safe.
    const textW = typeof ctx.measureText === 'function'
      ? ctx.measureText(label).width
      : label.length * 7.2;
    const padX = 8;
    const chipW = textW + padX * 2;
    const cx = (this._width || 1280) / 2;
    const chipY = AP_BADGE_TOP_PX;
    const chipX = cx - chipW / 2;
    const apr = this._apRectObj || (this._apRectObj = { left: 0, top: 0, right: 0, bottom: 0 });
    apr.left = chipX; apr.top = chipY; apr.right = chipX + chipW; apr.bottom = chipY + AP_BADGE_H_PX;
    this._apBadgeRect = apr;

    ctx.globalAlpha = finitePulse(this._time - this._apEngagedSince, { cycles: 1 });
    ctx.fillStyle = 'rgba(255, 170, 0, 0.16)';
    ctx.fillRect(chipX, chipY, chipW, AP_BADGE_H_PX);
    ctx.strokeStyle = COLORS.yellow;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(chipX, chipY, chipW, AP_BADGE_H_PX);
    ctx.fillStyle = COLORS.yellow;
    ctx.shadowColor = COLORS.yellow;
    ctx.shadowBlur = 6;
    ctx.fillText(label, cx, chipY + AP_BADGE_H_PX / 2);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /**
   * Draw off-screen directional arrow.
   * @private
   */
  _drawOffScreenArrow(proj, target, color, isSelected, distKm, law = null) {
    const ctx = this.ctx;
    const edge = this._getEdgePosition(proj.ndcX, proj.ndcY, proj.behind);

    ctx.save();

    if (law) {
      ctx.strokeStyle = law.color;
      ctx.fillStyle = law.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = law.color;
      ctx.shadowBlur = 6;
      ctx.globalAlpha = 1;
    } else if (isSelected) {
      ctx.strokeStyle = COLORS.cyan;
      ctx.fillStyle = COLORS.cyan;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = COLORS.cyan;
      ctx.shadowBlur = 6;
      // Calm-HUD: steady cyan — the 300 ms lock ceremony covers the selection
      // event; the old 3 Hz standing pulse was the fastest blink on a
      // centre-of-attention element.
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = Math.max(0.3, 1.0 - distKm / 50);
    }

    // Draw arrow
    const arrowSize = (law || isSelected) ? 12 : 8;
    // Distance text (+ the type name above it for the selected target), in a block beside the arrow, never on it
    const fontPx = isSelected ? 11 : 10;
    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    const typeName = isSelected ? this._getTypeName(target.type) : null;
    const prepText = () => {
      ctx.font = isSelected ? mono(11, 'bold') : mono(10);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };
    const buildLines = () => {
      const ls = [];
      if (typeName) ls.push({ t: typeName, w: this._textWidth(typeName, fontPx), h: fontPx + 1 });
      ls.push({ t: distText, w: this._textWidth(distText, fontPx), h: fontPx + 1 });
      return ls;
    };
    // u14a A3: a marker that would sit on a HUD pane slides inward along its bearing until it clears every pane
    let lines = null, lay = null, at = edge;
    const obs = this._getEdgeObstacles();
    if (obs.length) {
      prepText();
      lines = buildLines();
      const res = clearOfObstacles(edge, { x: this._halfW, y: this._halfH }, obs, (e) => offscreenLabelLayout({
        edge: e, size: arrowSize, lineWidth: ctx.lineWidth, lines, viewW: this._width, viewH: this._height,
      }));
      at = res.edge; lay = res.layout;
    }
    this._drawArrowShape(at.x, at.y, at.angle, arrowSize);

    ctx.shadowBlur = 0;
    if (!lines) {
      prepText();
      lines = buildLines();
      lay = offscreenLabelLayout({
        edge, size: arrowSize, lineWidth: ctx.lineWidth, lines, viewW: this._width, viewH: this._height,
      });
    }
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i].t, lay.lines[i].cx, lay.lines[i].cy);

    ctx.restore();
  }

  /**
   * Width of `text` in the current canvas font. The headless test canvas has no `measureText`, so fall back to the
   * fixed-pitch advance (the HUD font is fixed-pitch, ~0.62 em per character).
   * @private
   */
  _textWidth(text, fontPx) {
    const ctx = this.ctx;
    if (ctx && typeof ctx.measureText === 'function') {
      const m = ctx.measureText(text);
      if (m && m.width > 0) return m.width;
    }
    return text.length * fontPx * 0.62;
  }

  // ==========================================================================
  // ACTIVE SATELLITE RETICLE
  // ==========================================================================

  /**
   * Draw reticle/arrow for an active satellite.
   * @private
   */
  _drawActiveSatReticle(sat, playerPos) {
    const worldPos = sat.position;
    const proj = this._project(worldPos);
    const distKm = sat.distance / Constants.SCENE_SCALE;

    if (proj.visible) {
      this._drawDiamondReticle(proj, sat, distKm);
    } else if (distKm < 20) {
      // Off-screen warning arrow for nearby active sats
      this._drawActiveSatArrow(proj, sat, distKm);
    }
  }

  /**
   * Draw white diamond reticle for active satellite (on-screen).
   * @private
   */
  _drawDiamondReticle(proj, sat, distKm) {
    const ctx = this.ctx;
    const x = proj.x;
    const y = proj.y;

    const distFactor = clamp(10.0 / (distKm + 1), 0.3, 1.0);
    const size = 10 + 20 * distFactor;

    ctx.save();
    this._clipToObstacles();
    ctx.strokeStyle = COLORS.white;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;

    // Diamond shape ◇
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.stroke();

    // Name and distance
    ctx.font = mono(10);
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = 'center';
    ctx.fillText(sat.name, x, y - size - 6);
    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    ctx.fillText(distText, x, y + size + 12);

    // Warning if close
    if (distKm < 5) {
      // Calm-HUD: steady red — this is a standing hazard, not an event; the
      // WARN word + red already encode severity. (Was a hard on/off square wave.)
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = COLORS.red;
      ctx.font = mono(11, 'bold');
      ctx.fillText('WARN DO NOT APPROACH', x, y + size + 24);
    }

    ctx.restore();
  }

  /**
   * Draw off-screen arrow for active satellite with warning.
   * @private
   */
  _drawActiveSatArrow(proj, sat, distKm) {
    const ctx = this.ctx;
    const edge = this._getEdgePosition(proj.ndcX, proj.ndcY, proj.behind);

    ctx.save();

    const urgent = distKm < 5;
    // Calm-HUD: steady red when urgent — standing hazard, not an event; the
    // old hard square wave (0.5↔1.0 @ ~1.27 Hz) was the harshest pattern in
    // the codebase. Audio (proximity warning) is event-driven elsewhere.
    const alpha = urgent ? 1.0 : 0.8;

    ctx.strokeStyle = urgent ? COLORS.red : COLORS.white;
    ctx.fillStyle = urgent ? COLORS.red : COLORS.white;
    ctx.lineWidth = urgent ? 2.5 : 1.5;
    ctx.globalAlpha = alpha;

    const arrowSize = urgent ? 12 : 8;
    const fontPx = 10;
    const distText = `${distKm.toFixed(1)}km`;
    const label = urgent ? `WARN ${sat.name} ${distText}` : `${sat.name} ${distText}`;
    const prepText = () => {
      ctx.font = urgent ? mono(10, 'bold') : mono(10);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };
    // u13 D3: the label sits beside the arrow, never under it (same placement as the debris marker);
    // u14a A3: and both stay off the HUD panes (slid inward along the bearing)
    const layoutAt = (e) => offscreenLabelLayout({
      edge: e, size: arrowSize, lineWidth: ctx.lineWidth, lines: [{ w: this._textWidth(label, fontPx), h: fontPx + 1 }],
      viewW: this._width, viewH: this._height,
    });
    let lay = null, at = edge, prepped = false;
    const obs = this._getEdgeObstacles();
    if (obs.length) {
      prepText(); prepped = true;
      const res = clearOfObstacles(edge, { x: this._halfW, y: this._halfH }, obs, layoutAt);
      at = res.edge; lay = res.layout;
    }
    this._drawArrowShape(at.x, at.y, at.angle, arrowSize);

    ctx.shadowBlur = 0;
    if (!prepped) { prepText(); lay = layoutAt(edge); }
    ctx.fillText(label, lay.lines[0].cx, lay.lines[0].cy);

    ctx.restore();
  }

  // ==========================================================================
  // DRAWING PRIMITIVES
  // ==========================================================================

  /**
   * Draw a filled arrow shape at a position.
   * @private
   */
  _drawArrowShape(x, y, angle, size) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle); // `angle` is already a canvas angle (clockwise, y down): see _getEdgePosition

    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.5, -size * 0.6);
    ctx.lineTo(-size * 0.2, 0);
    ctx.lineTo(-size * 0.5, size * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  // ==========================================================================
  // EASING HELPERS
  // ==========================================================================

  /**
   * Cubic ease-out: decelerating to zero velocity.
   * @param {number} t - Progress 0-1
   * @returns {number} Eased value 0-1
   */
  _easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // ==========================================================================
  // PHASE 6: LASSO COOLDOWN ARC
  // ==========================================================================

  /**
   * Draw lasso cooldown arc around crosshair center.
   * Green ring when ready, gray pulsing ring during flight,
   * gray filling arc during cooldown, red flash on denied.
   * @private
   */
  _drawLassoCooldownArc() {
    const ctx = this.ctx;
    const cx = this._halfW;
    const cy = this._halfH;
    const radius = 22;

    ctx.save();
    ctx.lineWidth = 2.5;

    if (this._lassoDeniedTimer > 0) {
      // Denied flash: red arc pulses
      const alpha = this._lassoDeniedTimer / 0.3;
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = '#ff4444';
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this._lassoInFlight) {
      // In flight: steady dim gray ring (lasso active, can't fire).
      // Calm-HUD: was a 2 Hz alpha wobble; the gray already reads "inactive".
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = '#888888';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this._lassoCooldownTimer > 0) {
      // Cooling: gray background ring + gray fill arc
      const progress = 1 - (this._lassoCooldownTimer / this._lassoCooldownMax);

      // Gray background ring
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = '#888888';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Fill arc (clockwise from top, -π/2 start)
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#aaaaaa';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress));
      ctx.stroke();
    }
    // 2026-05-15 polish task 4 (urgent revision): the original "Ready"
    // branch drew a faint green ring at canvas centre (radius 22, α 0.35,
    // #00ff88) any time the lasso was charged. User reported it as a
    // mid-screen green circle that persisted regardless of game state
    // (not just SK). Removed entirely — readiness is already conveyed by
    // the absence of the cooldown / in-flight / denied indicators, plus
    // the dedicated lasso HUD elements in TargetPanel. Keeping cooldown
    // (gray), in-flight (gray pulse), and denied (red flash) since those
    // communicate active state changes; only the static "you are ready"
    // ring is gone.

    ctx.restore();
  }

  // ==========================================================================
  // COLOR & TYPE HELPERS
  // ==========================================================================

  /**
   * Get color for debris based on type and tumble rate.
   * @private
   */
  _getDebrisColor(target) {
    const tumbleDeg = radToDeg(target.tumbleRate);

    // High tumble or large rocket body = red (dangerous)
    if (tumbleDeg > 60 || (target.type === 'rocketBody' && target.mass > 3000)) {
      return COLORS.red;
    }
    // Medium tumble or defunct sats = yellow
    if (tumbleDeg > 20 || target.type === 'defunctSat') {
      return COLORS.yellow;
    }
    // Low tumble fragments = green (easy)
    return COLORS.green;
  }

  /**
   * Get human-readable type name.
   * @private
   */
  _getTypeName(type) {
    switch (type) {
      case 'rocketBody': return 'ROCKET BODY';
      case 'defunctSat': return 'DEFUNCT SAT';
      case 'missionDebris': return 'MISSION DEB';
      case 'fragment': return 'FRAGMENT';
      default: return 'DEBRIS';
    }
  }
}

export default TargetReticle;
