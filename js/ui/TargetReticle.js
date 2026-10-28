/**
 * Canvas 2D overlay: projects 3D debris positions to screen space and draws on-screen reticles (brackets/diamonds)
 * with distance labels, and off-screen arrows along the screen edges.
 * `colorLaw` is a dep (`{ reachKm, threatId, threatTier, apTargetId }` or null); null = shipped colours (`?ladder=0`).
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
import { GestureHints } from './hud/GestureHints.js';   // the fire prompt follows glass, read when drawn
import { isMarked } from '../systems/ScanMarks.js';
import { radToDeg, clamp01, clamp, lerp } from '../core/MathUtil.js';
import { VisualLaw } from '../core/VisualLaw.js';

const MAX_RETICLE_RANGE = 1.0;        // 100km in scene units
// Closing-rate readout (DECISIONS §48 row 6): an exponential average (about 0.3 s) of the per-frame rate, shown from
// 0.3 m/s and hidden below 0.2 m/s. Her last approach is commanded at exactly 0.5 m/s, so the raw rate sits on the
// rounding edge and flips; the average starts over when the measuring point jumps (the reticle measures from her only
// while she is flown, so a switch of view moves the point; see _relJump), and as a backstop when one frame's rate is
// more than CLOSING_BACKSTOP_MS away from the average.
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
/** owner 2026-09-07: an unselected bracket whose BOX (arms + dist label) touches the score strip's exclusion band
 *  grown by this pad (px, every side) is skipped whole, never half-drawn. */
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

// Off-screen marker label placement: pure, so it is testable without a canvas

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
  // (size, 0) lands on the bearing of the target. Negating it would point top / bottom arrows inward.
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
 * enough from the arrow's box that the two never touch. The block moves along the line from the arrow towards the
 * screen centre until it clears the arrow box by `gap`, so a long word sits further out than a short one.
 * owner 2026-10-21: the arrow was drawn over the letters ("FR▶MENT"); the text must never touch the arrow.
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

// Keeping markers off the HUD panes: pure helpers, testable without a canvas or a DOM

/** Ids of the HUD blocks a target marker must not cover. Rects are read from the DOM while shown. */
export const HUD_OBSTACLE_IDS = [
  'hud-score-panel', 'hud-left-column', 'hud-right-column', 'hud-targets-panel',
  'hud-comms-panel', 'hud-conjunction-panel',
];
/** The obstacle rects are re-read at most this often (seconds of reticle time) and on resize. */
export const OBSTACLE_REFRESH_S = 0.25;
/** Below this canvas width there are no obstacles (phones are frozen: DECISIONS §32). */
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
 * Edge arrow clear of the HUD panes. If the arrow's box or its label block (from `layoutFn`) touches an
 * obstacle (+ gap), the anchor slides inward along the line from the anchor to the screen centre, so the arrow keeps
 * its bearing and still points at the target, and the label layout is recomputed at every step, until both boxes clear
 * every obstacle. It stops at `OBSTACLE_SLIDE_MAX` of the way; if nothing clears, the position with the least overlap wins.
 * Cost: the walk is coarse (`opts.step`, 32 px), then the last blocked/clear pair is bisected to
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

export class TargetReticle {
  /**
   * @param {THREE.PerspectiveCamera} camera - The scene camera
   * @param {object} [opts]
   * @param {() => Array<{left:number,top:number,right:number,bottom:number}>} [opts.obstacleReader] — the HUD rects markers
   *   keep clear of; default: the visible HUD blocks read from the DOM (`readHudObstacles`).
   */
  constructor(camera, opts = {}) {
    this.camera = camera;

    // HUD rects target markers stay off (cached, re-read every OBSTACLE_REFRESH_S and on resize)
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
    // Mirrors the canvas display state so update() skips the whole paint while hidden (a display:none canvas is
    // otherwise still cleared and drawn every frame). Starts visible (no display rule in _createCanvas); main.js hides
    // it at boot via setVisible(false).
    this._visible = true;

    this._tempVec3 = new THREE.Vector3();
    this._tempVec4 = new THREE.Vector4();
    this._projMatrix = new THREE.Matrix4();

    // Scratch outputs for `orbitToSceneCartesianInto`; hot path, per visible target per frame.
    this._tmpCartPos = { x: 0, y: 0, z: 0 };
    this._tmpCartVel = { x: 0, y: 0, z: 0 };

    this._selectedTargetId = null;
    this._capturedIds = new Set();  // captured debris is not drawn
    this._debrisTargets = [];
    this._activeSatTargets = [];
    this._time = 0;

    this.previousDistances = new Map();
    this._closing = new Map();      // target id -> { rate (m/s, smoothed), shown, t (reticle clock) }
    this._dt = 0;

    this._thrustDirection = null;

    // Target lock ceremony animation state
    this._lockAnimT = 1;              // 0→1 over 300ms (1 = complete/idle)
    this._lockAnimActive = false;
    this._lockLostAnimT = 1;          // 0→1 over 200ms (1 = complete/idle)
    this._lockLostAnimActive = false;
    this._lockLostTargetId = null;    // ID of target being animated out

    this._apEngaged = false;
    this._apMode = '';
    this._apTargetName = '';
    this._apEngagedSince = null;      // drives the one-shot engage dip
    this._selectedScreenPos = null;   // { x, y } screen coords of selected target
    this._pairPiece = null;           // pair-shot: the pair's second piece (marked while a pair is offered), or null
    this._pairMarkScreen = null;      // pair-shot: where its mark was drawn this frame ({x, y}), null when it was not drawn

    // Under prefers-reduced-motion the ceremonies are skipped (the CSS media block can't reach canvas draws);
    // selection still works, just without the 300 ms size pop.
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

    // Whether the selected target is inside net-lock range: yellow reticle (out) vs cyan (in). The big "OUT OF RANGE"
    // text is brief: it shows for `_outOfRangeFlashT` seconds after the out-of-range crossing, then fades, and never
    // while in range. AutoLockController emits these on the crossing.
    this._selectedInRange = true;
    this._outOfRangeFlashT = 0;            // >0 = show the brief OUT OF RANGE text
    this._outOfRangeFlashDur = 1.6;        // seconds the callout stays up
    eventBus.on(Events.TARGET_IN_RANGE, () => {
      this._selectedInRange = true;
      this._outOfRangeFlashT = 0;          // hide immediately once in range
    });
    eventBus.on(Events.TARGET_OUT_OF_RANGE, () => {
      // Flash only on the in→out transition, not every frame it stays out.
      if (this._selectedInRange !== false) this._outOfRangeFlashT = this._outOfRangeFlashDur;
      this._selectedInRange = false;
    });

    this._lassoInFlight = false;        // true while lasso projectile is active
    this._lassoCooldownTimer = 0;       // >0 after capture/cancel, counts down
    this._lassoCooldownMax = 2;         // matches LassoSystem cooldown (2s)
    this._lassoFlightTimeout = 0;       // safety: auto-clear in-flight after max time
    this._lassoDeniedTimer = 0;         // >0 = show denied red flash
    this._lassoShakeTimer = 0;          // >0 = screen micro-shake active
    this._lassoContactFlashTimer = 0;   // >0 = flash target bracket white
    this._lassoContactTargetId = null;  // ID of target hit by lasso

    this._catchPulseActive = false;
    this._catchPulseTime = 0;           // countdown from 0.3 → 0

    // Fading "▸ N" training wheel: a tiny fire-prompt under an in-range lock.
    // Deliberately UNHURRIED: it waits a grace period after the first in-range lock (time to look around) and only
    // nudges across the first two pieces, persisting on each until that piece is captured. It does NOT vanish the
    // instant the net is first fired (the 2nd piece would have no prompt).
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
      this.showCatchPulse();
      if (data && data.debrisId) this._capturedIds.add(data.debrisId);
    });

    eventBus.on(Events.ARM_CAPTURED, (data) => {
      // Tally each cleared piece ONCE, here, for the "▸ N" cap. A Mother-net catch emits BOTH LASSO_CAPTURED and
      // ARM_CAPTURED (LassoSystem fires ARM_CAPTURED "for catch juice"), and ARM_CAPTURED also fires for daughter
      // captures, so counting in both handlers would double-count.
      this._debrisCleared++;
      this.showCatchPulse();
      if (data && data.targetId) this._capturedIds.add(data.targetId);
    });

    // Forget the captured id once the debris is fully removed from the field
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

    eventBus.on(Events.AUTOPILOT_ENGAGE, (data) => {
      this._apEngaged = true;
      this._apMode = data.mode || '';
      this._apTargetName = data.targetName || data.mode || '';
      // Engagement is an EVENT: the badge gets one finite acknowledgement dip, then reads steady.
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

    // The score-strip exclusion band, copied per frame from `data.exclusionRect` (the hub's cached
    // hud.scoreStripRect()) into ONE reused rect (no per-frame allocation); a later frame with null data clears it.
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
  }

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
    this._obstacleCache = null;   // the HUD moves with the window
    this.canvas.width = this._width * dpr;
    this.canvas.height = this._height * dpr;
    this.canvas.style.width = this._width + 'px';
    this.canvas.style.height = this._height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  // Public API

  /** @param {number|null} id */
  setSelectedTarget(id) {
    this._selectedTargetId = id;
  }

  /**
   * Replace the HUD-rect reader (tests; hosts with their own layout). `null` = the default DOM reader.
   * @param {(() => Array<{left:number,top:number,right:number,bottom:number}>)|null} fn
   */
  setObstacleReader(fn) {
    this._obstacleReader = typeof fn === 'function' ? fn : null;
    this._obstacleCache = null;
  }

  /**
   * The visible HUD rects, cached for OBSTACLE_REFRESH_S of reticle time and dropped on resize. Empty below
   * OBSTACLE_MIN_VIEW_W (phones) and without a DOM.
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

  /** Obstacles for an edge arrow: the HUD blocks plus the AP chip while it is drawn. */
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
   * Cut the HUD blocks out of everything drawn from here to the caller's `ctx.restore()`: an even-odd clip of the whole
   * canvas minus each obstacle rect. In SCREEN coordinates — the lasso shake translates the canvas, so the rects are
   * shifted back by it. No obstacles = no clip call at all.
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
   * View-level rendering config (from CameraSystem info levels).
   * @param {object} config
   */
  setViewConfig(config) {
    if (!config) return;
    if (config.showClosureRate !== undefined)    this._viewConfig.showClosureRate    = config.showClosureRate;
  }

  /**
   * Called each frame from the game loop.
   * @param {number} dt - seconds
   * @param {object} data
   * @param {object} data.debrisField - DebrisField instance
   * @param {object} data.activeSatellites - ActiveSatellites instance
   * @param {THREE.Vector3} data.playerPos - scene units
   * @param {object} data.targetSelector - TargetSelector for the selected target
   * @param {object} [data.playerVel] - { x, y, z }
   */
  update(dt, data) {
    this._time += dt;
    this._dt = dt;

    // Copy the score-strip exclusion band into the ONE reused rect (no per-frame allocation); null clears it.
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

    if (this._outOfRangeFlashT > 0) this._outOfRangeFlashT -= dt;

    // Lock ceremony timers
    if (this._lockAnimActive) {
      this._lockAnimT += dt / 0.3; // 0.3 s
      if (this._lockAnimT >= 1) {
        this._lockAnimT = 1;
        this._lockAnimActive = false;
      }
    }
    if (this._lockLostAnimActive) {
      this._lockLostAnimT += dt / 0.2; // 0.2 s
      if (this._lockLostAnimT >= 1) {
        this._lockLostAnimT = 1;
        this._lockLostAnimActive = false;
        this._lockLostTargetId = null;
      }
    }

    // Lasso feedback timers
    if (this._lassoCooldownTimer > 0) this._lassoCooldownTimer -= dt;
    if (this._lassoDeniedTimer > 0) this._lassoDeniedTimer -= dt;
    if (this._lassoShakeTimer > 0) this._lassoShakeTimer -= dt;
    if (this._lassoContactFlashTimer > 0) this._lassoContactFlashTimer -= dt;
    if (this._lassoFlightTimeout > 0) {
      this._lassoFlightTimeout -= dt;
      if (this._lassoFlightTimeout <= 0) {
        this._lassoInFlight = false; // clear stale in-flight state
        this._lassoCooldownTimer = 1; // brief cooldown arc for the cancel case
      }
    }

    // Catch pulse timer
    if (this._catchPulseActive) {
      this._catchPulseTime -= dt;
      if (this._catchPulseTime <= 0) {
        this._catchPulseActive = false;
        this._catchPulseTime = 0;
      }
    }

    // Hidden canvas: no paint. Timers and ceremony/lasso/catch bookkeeping above still ran, so state stays correct
    // across a hide; the per-target closing-rate memory is cleared so the first visible frame cannot spike off a stale distance.
    // Nothing below is read by another system — every cross-system input to the reticle arrives via events.
    if (!this._visible) {
      if (this.previousDistances) this.previousDistances.clear();
      if (this._closing) this._closing.clear();
      return;
    }

    this.ctx.clearRect(0, 0, this._width, this._height);

    // Screen micro-shake on lasso fire (2 px, 100 ms)
    const doShake = this._lassoShakeTimer > 0;
    if (doShake) {
      this.ctx.save();
      this._shakeX = (Math.random() - 0.5) * 4;
      this._shakeY = (Math.random() - 0.5) * 4;
      this.ctx.translate(this._shakeX, this._shakeY);
    }

    if (!data || !data.playerPos) {
      if (doShake) { this.ctx.restore(); this._shakeX = this._shakeY = 0; }
      // Gated on SK like the main path below: else the green "Ready" ring renders on the first SK frame while data
      // is briefly absent.
      if (!data || data.skTargetId == null) {
        this._drawLassoCooldownArc();
      }
      return;
    }

    if (data.telemetry) {
      this._thrustDirection = data.telemetry.thrustDirection || null;
    }

    const { debrisField, activeSatellites, playerPos, targetSelector } = data;

    this.camera.updateMatrixWorld();
    this._projMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );

    if (targetSelector) {
      const activeTarget = targetSelector.getActiveTarget();
      if (activeTarget) {
        this._selectedTargetId = activeTarget.id;
      }
    }

    if (debrisField) {
      this._debrisTargets = debrisField.getDebrisNear(playerPos, MAX_RETICLE_RANGE);
    }

    if (activeSatellites) {
      this._activeSatTargets = activeSatellites.getSatelliteList(playerPos);
    }

    this._selectedScreenPos = null;
    this._pairMarkScreen = null;

    // During STATION_KEEP all on-screen target chrome is silenced EXCEPT a faint outline (no labels) on the SK target
    // debris: the arm pilot works on one piece ~8 m away, and neighbouring brackets, labels, ETAs and arrows only pull
    // the eye away.
    const skTargetId = data.skTargetId;
    if (skTargetId != null) {
      this.ctx.save();
      this.ctx.globalAlpha = 0.2;
      for (const target of this._debrisTargets) {
        if (target.id !== skTargetId) continue;
        if (!target.alive || target._captured || this._capturedIds.has(target.id)) continue;
        if (!isMarked(target)) continue;   // scan-first: no mark until a scan reveals it
        this._drawDebrisReticle(target, playerPos);
      }
      this.ctx.restore();
      // neighbouring debris and active sats are skipped entirely
    } else {
      // Scan-first (DECISIONS §15 row 1): an undiscovered piece gets no bracket
      // and no off-screen arrow until a scan (S) reveals it. The list stays
      // unfiltered — getDebrisNear's result is a frame-shared cache the scan
      // reveal also reads, so it must never be compacted in place.
      for (const target of this._debrisTargets) {
        if (!target.alive || target._captured || this._capturedIds.has(target.id)) continue;
        if (!isMarked(target)) continue;
        this._drawDebrisReticle(target, playerPos);
      }

      for (const sat of this._activeSatTargets) {
        if (sat.distance / Constants.SCENE_SCALE > 100) continue; // skip beyond 100 km
        this._drawActiveSatReticle(sat, playerPos);
      }

      // The pair's second piece: marked only while a pair is offered
      this._pairPiece = data.pairPiece || null;
      if (this._pairPiece && this._pairPiece.alive !== false) this._drawPairMarker(this._pairPiece);
    }

    const activeIds = new Set(this._debrisTargets.map(t => t.id));
    for (const id of this.previousDistances.keys()) {
      if (!activeIds.has(id)) this.previousDistances.delete(id);
    }
    if (this._closing) {
      for (const id of this._closing.keys()) {
        if (!activeIds.has(id)) this._closing.delete(id);
      }
    }

    if (doShake) { this.ctx.restore(); this._shakeX = this._shakeY = 0; }

    // Autopilot badge: top level, AFTER the shake restore (a mode readout should not shake).
    if (this._apEngaged) this._drawApBadge(); else this._apBadgeRect = null;

    // Lasso cooldown arc: on top, no shake. Skipped in SK: its "Ready" state is a green ring (#00ff88 @ α0.35, radius
    // 22) at screen centre, which would be visual noise inside the SK target bracket (Space is capture in SK, not lasso).
    if (data.skTargetId == null) {
      this._drawLassoCooldownArc();
    }
  }

  /**
   * Show/hide the canvas. Also gates the per-frame paint in update(): a hidden reticle keeps its timers ticking but
   * draws nothing.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._visible = !!visible;
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /** @returns {boolean} whether the reticle canvas is shown (and painted). */
  isVisible() { return this._visible; }

  /** Sim mode: no catch pulse (no bracket flash or green glow; it read as arcade sparks). Kept for external callers. */
  showCatchPulse() {
  }

  // Projection

  /**
   * The mark on the pair's SECOND piece (the selected one keeps its own reticle): an amber double diamond with "PAIR"
   * under it; off screen, an amber chevron at the edge toward it. main.js passes `pairPiece` only while a pair is offered.
   * @param {{_scenePosition: {x:number,y:number,z:number}}} piece
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
   * Project a world position to screen pixels (`ndcX`/`ndcY` returned for the edge arrows).
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

    const behind = w < 0;

    const screenX = (ndcX + 1) * this._halfW;
    const screenY = (1 - ndcY) * this._halfH;

    const margin = 50;
    const visible = !behind &&
      ndcX >= -1 && ndcX <= 1 &&
      ndcY >= -1 && ndcY <= 1 &&
      ndcZ >= -1 && ndcZ <= 1;

    return { x: screenX, y: screenY, z: ndcZ, visible, behind, ndcX, ndcY };
  }

  /**
   * Edge-of-screen position for an off-screen arrow.
   * @param {number} ndcX - NDC x (-1 to 1, or beyond)
   * @param {number} ndcY - NDC y (-1 to 1, or beyond)
   * @param {boolean} behind - Whether target is behind camera
   * @returns {{ x: number, y: number, angle: number }} angle: screen-space radians toward the target
   */
  _getEdgePosition(ndcX, ndcY, behind) {
    // Behind the camera the direction flips
    let dx = ndcX;
    let dy = ndcY;
    if (behind) {
      dx = -dx;
      dy = -dy;
    }

    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) {
      dx = 0; dy = -1; // default: point up
    } else {
      dx /= len;
      dy /= len;
    }

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
    const ey = this._halfH - dy * scale; // flip Y for screen coords

    const angle = Math.atan2(-dy, dx);

    return {
      x: clamp(ex, pad, this._width - pad),
      y: clamp(ey, pad, this._height - pad),
      angle,
    };
  }

  /**
   * Did the measuring point jump this frame? `st` keeps the last relative position (target minus observer, scene
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
   * Smoothed closing rate for the selected target (m/s, positive = closing). `raw` is this frame's finite
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
    // A jump (observer or reference changed) or a rate far from the average: this frame's difference is not a speed.
    // Start over; the next frame seeds the average.
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

  // Debris reticle drawing

  _drawDebrisReticle(target, playerPos) {
    // Orbit velocity goes into _tmpCartVel, but PREFER the rendered _scenePosition (carried as a clone on the
    // getDebrisNear snapshot) for the bracket: onboarding PINNED pieces (#1/#2) skip orbit propagation, so
    // their orbit is stale and would put the bracket far from where the debris renders.
    orbitToSceneCartesianInto(target.orbit, this._tmpCartPos, this._tmpCartVel);
    if (target._scenePosition) {
      this._tempVec3.set(target._scenePosition.x, target._scenePosition.y, target._scenePosition.z);
    } else {
      this._tempVec3.set(this._tmpCartPos.x, this._tmpCartPos.y, this._tmpCartPos.z);
    }
    const worldPos = this._tempVec3;

    const proj = this._project(worldPos);
    const distKm = target.distanceKm;

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

    // Selected target's screen position feeds the AP heading line.
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
      // `_tmpCartVel` is the velocity scratch written by `orbitToSceneCartesianInto`: `.x/.y/.z` km/s, no nested `.velocity`.
      this._drawOnScreenReticle(proj, target, color, isSelected, distKm, worldPos, playerPos, this._tmpCartVel, law);
    } else {
      const showArrow = law ? law.arrow : (isSelected || distKm < 50 || (target.type === 'rocketBody' && distKm < 30));
      if (showArrow) {
        this._drawOffScreenArrow(proj, target, color, isSelected, distKm, law);
      }
    }
  }

  /** @private Glass is read when a caption is drawn, never cached; no GestureHints (headless) means desktop. */
  _glassNow() {
    return !!(GestureHints && typeof GestureHints.isGlass === 'function' && GestureHints.isGlass());
  }

  /**
   * @private
   * @param {{x:number,y:number,z:number}|null} vel — km/s velocity scratch from `orbitToSceneCartesianInto`
   */
  _drawOnScreenReticle(proj, target, color, isSelected, distKm, worldPos, playerPos, vel, law = null) {
    const ctx = this.ctx;
    const x = proj.x;
    const y = proj.y;

    // Larger when closer.
    const distFactor = clamp(5.0 / (distKm + 1), 0.2, 1.0);
    let size = lerp(RETICLE_MIN_SIZE, RETICLE_MAX_SIZE, distFactor);

    const isLockLost = !isSelected && target.id === this._lockLostTargetId && this._lockLostAnimActive;

    if (isSelected) {
      size *= SELECTED_RETICLE_SCALE;
      // Lock-on ceremony: brackets shrink from 2.5× → 1× over 300ms; steady after (no standing breathe).
      if (this._lockAnimActive) {
        size *= 1 + 1.5 * (1 - this._easeOutCubic(this._lockAnimT));
      }
    } else if (isLockLost) {
      // Starts at selected scale, expands to 2×.
      size *= SELECTED_RETICLE_SCALE * (1 + this._lockLostAnimT);
    }

    if (this._catchPulseActive && isSelected) {
      const pulseProgress = Math.max(0, this._catchPulseTime / 0.3);
      size *= 1 + 0.3 * pulseProgress; // 1.3× at start, 1.0× at end
    }

    const half = size / 2;
    const corner = size * 0.3;

    // A selected-but-OUT-OF-RANGE target renders YELLOW (no lock glow): the silent "too far for the net" state that
    // teaches Autopilot. In range → cyan lock. Derived once, shared by the bracket and label code below.
    const outOfRange = this._selectedInRange === false;
    const selColor = law ? law.color : (outOfRange ? COLORS.yellow : COLORS.cyan);

    // owner 2026-09-07: score-strip exclusion band. An UNSELECTED bracket whose BOX (arms `x ± half` / `y ± half`, down
    // to its dist label at `y + half + 22`) would touch the strip rect + 8 px pad is skipped WHOLE: never a half
    // reticle under the strip, never a bracket+label under its opaque panel. The SELECTED target is exempt (it is the
    // player's lock). Off-screen arrows take a different path. Allocation-free; null rect (flag off) → no skip.
    const ex = this._exclusionRect;
    if (ex != null && !isSelected) {
      // The caution word rides ABOVE the box (baseline y - half - 6, ~11 px glyphs, up to ~80 px wide) and counts as
      // part of the box, so an amber TUMBLING never lands on the strip. Null law → no word.
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
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = selColor;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH_SELECTED || 3.0;

      // White corner flash at lock-on start (~60ms), in-range locks only: the "locked, act now" cue.
      if (!outOfRange && this._lockAnimActive && this._lockAnimT < 0.20) {
        ctx.strokeStyle = COLORS.white;
        ctx.shadowColor = COLORS.white;
        ctx.shadowBlur = 16;
      } else {
        ctx.shadowColor = selColor;
        ctx.shadowBlur = 0;
      }
    } else if (isLockLost) {
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

    // Lasso contact flash: bracket goes white
    if (this._lassoContactFlashTimer > 0 && target.id === this._lassoContactTargetId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLORS.white;
      ctx.lineWidth = 3;
      ctx.shadowColor = COLORS.white;
      ctx.shadowBlur = 16;
    }

    // Catch pulse: green-cyan flash on the selected bracket
    if (this._catchPulseActive && isSelected) {
      const pulseProgress = Math.max(0, this._catchPulseTime / 0.3);
      ctx.globalAlpha = 0.7 + 0.3 * pulseProgress;
      ctx.strokeStyle = VisualLaw.COLORS.PLAYER;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = VisualLaw.COLORS.PLAYER;
      ctx.shadowBlur = 12 * pulseProgress;
    }

    ctx.beginPath();
    ctx.moveTo(x - half, y - half + corner);
    ctx.lineTo(x - half, y - half);
    ctx.lineTo(x - half + corner, y - half);
    ctx.moveTo(x + half - corner, y - half);
    ctx.lineTo(x + half, y - half);
    ctx.lineTo(x + half, y - half + corner);
    ctx.moveTo(x + half, y + half - corner);
    ctx.lineTo(x + half, y + half);
    ctx.lineTo(x + half - corner, y + half);
    ctx.moveTo(x - half + corner, y + half);
    ctx.lineTo(x - half, y + half);
    ctx.lineTo(x - half, y + half - corner);
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Lock-lost: fading brackets only, no labels
    if (isLockLost) {
      ctx.restore();
      return;
    }

    // Label rows below the reticle: distance (20 px) → closure rate (18 px) → baselines ~22 px apart.
    ctx.font = mono(20);
    ctx.fillStyle = law ? law.color : color;
    ctx.textAlign = 'center';

    if (isSelected) {
      if (!law) ctx.fillStyle = COLORS.cyan;
      ctx.font = mono(22, 'bold');
    }

    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    ctx.fillText(distText, x, y + half + 22);

    // Closure rate below distance (selected only). Plain words, not ▲/▼, and nothing when negligible (no "0 m/s").
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

    if (isSelected) {
      // Brief "OUT OF RANGE" callout when beyond net-lock range. The onboarding comms point at this label
      // ("see OUT OF RANGE"), so the wording is load-bearing.
      if (outOfRange && this._outOfRangeFlashT > 0) {
        // Fades over the last 0.5 s.
        const a = clamp01(this._outOfRangeFlashT / 0.5);
        ctx.save();
        ctx.globalAlpha *= a;
        ctx.font = mono(16, 'bold');
        ctx.fillStyle = COLORS.yellow;
        ctx.fillText('OUT OF RANGE', x, y + half + 70);
        ctx.restore();
      }

      // DE-SPIN feedback only while the mother laser is firing (the "it's working" cue). The idle tumble°/s and size
      // numbers are deliberately not drawn: bracket color encodes danger; raw figures live in TargetPanel.
      if (target._despinning) {
        ctx.font = mono(11, 'bold');
        ctx.fillStyle = selColor;
        ctx.fillText('\u25BC DE-SPIN', x, y - half - 6);
      }

      // Fading "▸ N" fire prompt: puts the comms lesson ("fire the Mother net with N") on the bracket the eye is on.
      // Deliberately gentle:
      //   • only on an IN-RANGE lock,
      //   • only across the first two pieces (capped by captures, NOT by the first fire), persisting on each until
      //     that piece is captured, and
      //   • only after a ~4 s grace from the first in-range lock (global, so the 2nd piece shows promptly).
      //     Fades in over 0.8 s, then soft-pulses.
      const NUDGE_DELAY_S = 4;
      if (!outOfRange && this._debrisCleared < 2) {
        if (this._firstInRangeLockTime == null) this._firstInRangeLockTime = this._time;
        const sinceLock = this._time - this._firstInRangeLockTime;
        // owner 2026-10-23: on a touch screen the N key is never shown and there is no touch control to name instead (the
        // LAUNCH NET chip and comms lesson teach the net there), so the prompt is left out. Read at draw time.
        if (sinceLock >= NUDGE_DELAY_S && !this._glassNow()) {
          // Slow breath (~0.29 Hz), amplitude easing ±0.16 → ±0.05 over ~6 s, then a soft steady glow. This is the
          // shape calmBreathe() encodes; keep the explicit opts so it stays exact.
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
   * Salience comes from WEIGHT, not motion: a bordered amber chip with a static glow at a stable position; the only
   * motion is one finite dip when AP engages.
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
    // measureText is absent from the headless canvas mock: fall back to a fixed-pitch estimate.
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
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = Math.max(0.3, 1.0 - distKm / 50);
    }

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
    // A marker that would sit on a HUD pane slides inward along its bearing until it clears every pane
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

  // Active satellite reticle

  _drawActiveSatReticle(sat, playerPos) {
    const worldPos = sat.position;
    const proj = this._project(worldPos);
    const distKm = sat.distance / Constants.SCENE_SCALE;

    if (proj.visible) {
      this._drawDiamondReticle(proj, sat, distKm);
    } else if (distKm < 20) {
      this._drawActiveSatArrow(proj, sat, distKm);
    }
  }

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

    // Diamond ◇
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.stroke();

    ctx.font = mono(10);
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = 'center';
    ctx.fillText(sat.name, x, y - size - 6);
    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    ctx.fillText(distText, x, y + size + 12);

    if (distKm < 5) {
      // Steady red: a standing hazard, not an event; the WARN word + red already encode severity.
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = COLORS.red;
      ctx.font = mono(11, 'bold');
      ctx.fillText('WARN DO NOT APPROACH', x, y + size + 24);
    }

    ctx.restore();
  }

  _drawActiveSatArrow(proj, sat, distKm) {
    const ctx = this.ctx;
    const edge = this._getEdgePosition(proj.ndcX, proj.ndcY, proj.behind);

    ctx.save();

    const urgent = distKm < 5;
    // Steady red when urgent: a standing hazard, not an event. Audio (proximity warning) is event-driven elsewhere.
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
    // The label sits beside the arrow, never under it (same placement as the debris marker), and both stay off the
    // HUD panes (slid inward along the bearing).
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

  // Drawing primitives

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

  /**
   * Cubic ease-out.
   * @param {number} t - progress 0-1
   * @returns {number} eased value 0-1
   */
  _easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

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
      // Steady dim gray: lasso active, can't fire.
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
    // No "ready" ring: readiness is the absence of the cooldown / in-flight / denied indicators (plus the lasso HUD
    // in TargetPanel).

    ctx.restore();
  }

  // Color & type helpers

  _getDebrisColor(target) {
    const tumbleDeg = radToDeg(target.tumbleRate);

    // red = dangerous, yellow = medium, green = easy
    if (tumbleDeg > 60 || (target.type === 'rocketBody' && target.mass > 3000)) {
      return COLORS.red;
    }
    if (tumbleDeg > 20 || target.type === 'defunctSat') {
      return COLORS.yellow;
    }
    return COLORS.green;
  }

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
