/**
 * ReachOrb.js — the Zoom Ladder NAVCOM (F6) reachability envelope overlay.
 *
 * Draws the fuel-reachability envelope (ReachabilityModel.envelope) as two Earth-centered rings in the PLAYER'S
 * ORBITAL PLANE (the band of circular altitudes reachable within the usable ΔV budget), a subtle fill between them
 * and a caption ('REACH ≈ X–Y km · budget N m/s').
 *
 * Plane: normal = pos × vel from the live state vectors; when the two are (near-)parallel (a radial trajectory that
 * never occurs in orbit) it falls back to the scene equator so the orb still reads. Ring radii in scene units:
 * (EARTH_RADIUS_KM + altKm) × SCENE_SCALE = 63.71 + altKm/100 u.
 *
 * Same overlay style as ClusterIcons: full-screen canvas, pointer-events:none, built lazily on show(),
 * opacity-transitioned, DOM-guarded (inert headless). update() always computes and returns the frame descriptors
 * (rings with projector-driven visibility, envelope, caption) so tests assert the math without a browser; painting
 * happens only when the canvas exists and the layer is shown.
 *
 * Rings are projected/painted per frame (the camera moves), but the ENVELOPE (budget read + bisection) recomputes at
 * most every ENVELOPE_RECOMPUTE_MS, or at once when the budget's ΔV changes (a burn or mass change must not show a
 * stale orb).
 *
 * No camera, no game loop: NavcomFloor mounts/shows it on activate(), hides on deactivate(), and feeds update() from
 * its own per-frame tick (main.js already ticks navcom with a live projector).
 *
 * @module ui/ReachOrb
 */

import { Constants } from '../core/Constants.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { envelope } from '../entities/ReachabilityModel.js';
import { mono } from '../core/Typeface.js';

/** Envelope recompute throttle (ms), ~2 Hz; budget ΔV changes bypass it. */
export const ENVELOPE_RECOMPUTE_MS = 500;

/** Ring sampling density (points per ring). */
export const RING_SEGMENTS = 64;

/** Monotonic ms clock (Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class ReachOrb {
  /**
   * @param {object} [deps]
   * @param {function} [deps.now] - monotonic ms clock (tests); default performance.now
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
    this._env = null;           // cached ReachabilityModel.envelope() result
    this._envBudgetDv = null;   // budget.deltaV the cache was computed with
    this._envAtMs = -Infinity;  // when the cache was computed
  }

  isVisible() { return this._visible; }

  /**
   * Orthonormal basis of the player's orbital plane. e1 points along the player's position (the band starts "under"
   * the ship), e2 completes the plane, normal = normalize(pos × vel). Degenerate pos ∥ vel (or missing vel) falls
   * back to the scene equator (normal +z).
   * @param {{x,y,z}} posU - player position, scene units (Earth at origin)
   * @param {{x,y,z}|null} velU - player velocity (any scale; direction only)
   * @returns {{e1:{x,y,z}, e2:{x,y,z}, normal:{x,y,z}}}
   */
  static orbitalPlaneBasis(posU, velU) {
    const p = posU || { x: 1, y: 0, z: 0 };
    const v = velU || { x: 0, y: 0, z: 0 };
    let nx = p.y * v.z - p.z * v.y;
    let ny = p.z * v.x - p.x * v.z;
    let nz = p.x * v.y - p.y * v.x;
    let nLen = Math.hypot(nx, ny, nz);
    const pLen = Math.hypot(p.x, p.y, p.z) || 1;
    // Degenerate (radial/missing velocity): scene equator.
    if (!(nLen > 1e-9 * pLen)) { nx = 0; ny = 0; nz = 1; nLen = 1; }
    nx /= nLen; ny /= nLen; nz /= nLen;
    // e1 = pos projected into the plane (normal component removed), so a fallback plane still yields a valid in-plane basis.
    let e1x = p.x - (p.x * nx + p.y * ny + p.z * nz) * nx;
    let e1y = p.y - (p.x * nx + p.y * ny + p.z * nz) * ny;
    let e1z = p.z - (p.x * nx + p.y * ny + p.z * nz) * nz;
    let e1Len = Math.hypot(e1x, e1y, e1z);
    if (!(e1Len > 1e-12)) { e1x = 1; e1y = 0; e1z = 0; e1Len = 1; } // pos ∥ normal
    e1x /= e1Len; e1y /= e1Len; e1z /= e1Len;
    // e2 = normal × e1 (right-handed, unit by construction)
    const e2x = ny * e1z - nz * e1y;
    const e2y = nz * e1x - nx * e1z;
    const e2z = nx * e1y - ny * e1x;
    return { e1: { x: e1x, y: e1y, z: e1z }, e2: { x: e2x, y: e2y, z: e2z }, normal: { x: nx, y: ny, z: nz } };
  }

  /**
   * Sample an Earth-centered circle of radius `radiusU` (scene units) in the player's orbital plane: world-space
   * points, no projection.
   * @returns {Array<{x:number, y:number, z:number}>}
   */
  static ringPoints(posU, velU, radiusU, n = RING_SEGMENTS) {
    const { e1, e2 } = ReachOrb.orbitalPlaneBasis(posU, velU);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      const c = Math.cos(th) * radiusU;
      const s = Math.sin(th) * radiusU;
      pts.push({ x: c * e1.x + s * e2.x, y: c * e1.y + s * e2.y, z: c * e1.z + s * e2.z });
    }
    return pts;
  }

  /** Scene-unit ring radius for a circular altitude. */
  static radiusUForAltKm(altKm) {
    return (Constants.EARTH_RADIUS_KM + altKm) * Constants.SCENE_SCALE;
  }

  /**
   * Caption line for the envelope, e.g. 'REACH ≈ 320–740 km · budget 512 m/s'.
   * @param {{minAltKm:number, maxAltKm:number, budgetDvMs:number}|null} env
   */
  static caption(env) {
    if (!env) return '';
    return `REACH \u2248 ${Math.round(env.minAltKm)}\u2013${Math.round(env.maxAltKm)} km`
      + ` \u00b7 budget ${Math.round(env.budgetDvMs)} m/s`;
  }

  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const canvas = document.createElement('canvas');
    canvas.id = 'ladder-reach-orb';
    // z-index 32: beneath the cluster icons (33) + transfer panel (34); the orb is context, never occludes the icons.
    canvas.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:32', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx2d = canvas.getContext ? canvas.getContext('2d') : null;
  }

  show() { this._build(); this._visible = true; if (this._canvas) this._canvas.style.opacity = '1'; }

  hide() {
    this._visible = false;
    if (this._canvas) {
      this._canvas.style.opacity = '0';
      // Clear at once so a re-shown F6 never flashes a stale frame.
      if (this._ctx2d) this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  /**
   * Compute (and, when the DOM layer is shown, paint) one orb frame.
   * @param {object} ctx
   * @param {function} ctx.project - world→screen (worldVec3)->{x,y,visible}
   * @param {{x,y,z}} ctx.posU - player position (scene units)
   * @param {{x,y,z}|null} [ctx.velU] - player velocity (plane derivation)
   * @param {object} ctx.budget - ArmManager.getMassBudget() result
   * @param {number} ctx.playerOrbitKm - current orbit radius (km)
   * @returns {{
   *   env: object, caption: string,
   *   min: Array<{x,y,visible}>, max: Array<{x,y,visible}>,
   * }|null} frame descriptors, or null when inputs are missing/degenerate
   */
  update(ctx = {}) {
    const { project, posU, velU, budget, playerOrbitKm } = ctx;
    if (!project || !posU || !budget || !(playerOrbitKm > 0)) return null;

    // Throttled envelope recompute; a ΔV change (burn/mass change) bypasses.
    const now = this._now();
    const dv = budget.deltaV;
    if (!this._env || dv !== this._envBudgetDv || (now - this._envAtMs) >= ENVELOPE_RECOMPUTE_MS) {
      this._env = envelope({ budget, playerOrbitKm });
      this._envBudgetDv = dv;
      this._envAtMs = now;
    }
    const env = this._env;
    if (!env) return null;

    const minPts = ReachOrb.ringPoints(posU, velU, ReachOrb.radiusUForAltKm(env.minAltKm));
    const maxPts = ReachOrb.ringPoints(posU, velU, ReachOrb.radiusUForAltKm(env.maxAltKm));
    const min = minPts.map((p) => project(p) || { x: 0, y: 0, visible: false });
    const max = maxPts.map((p) => project(p) || { x: 0, y: 0, visible: false });
    const caption = ReachOrb.caption(env);

    this._paint(min, max, caption);
    return { env, caption, min, max };
  }

  /** @private Paint rings + band + caption (no-op headless / while hidden). */
  _paint(min, max, caption) {
    const canvas = this._canvas;
    const g = this._ctx2d;
    if (!canvas || !g || !this._visible) return;
    const w = (typeof window !== 'undefined') ? window.innerWidth : canvas.width;
    const h = (typeof window !== 'undefined') ? window.innerHeight : canvas.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);

    const n = min.length;
    // Band fill: per-segment quads (min[i]→min[i+1]→max[i+1]→max[i]) drawn only when all four corners are visible
    // (projector visibility handles offscreen/behind-camera points without polygon clipping).
    g.fillStyle = 'rgba(0, 204, 255, 0.07)'; // INFO cyan, subtle
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = min[i], b = min[j], c = max[j], d = max[i];
      if (!a.visible || !b.visible || !c.visible || !d.visible) continue;
      g.beginPath();
      g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y);
      g.closePath();
      g.fill();
    }
    this._strokeRing(g, min, 'rgba(0, 204, 255, 0.35)');
    this._strokeRing(g, max, 'rgba(0, 204, 255, 0.6)');

    if (caption) {
      g.font = mono(10);
      g.textAlign = 'center';
      g.fillStyle = VisualLaw.COLORS.INFO;
      g.globalAlpha = 0.85;
      g.fillText(caption, w / 2, h - 28);
      g.globalAlpha = 1;
    }
  }

  /** @private Stroke a projected ring, skipping invisible segments. */
  _strokeRing(g, pts, style) {
    g.strokeStyle = style;
    g.lineWidth = 1;
    g.beginPath();
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (!a.visible || !b.visible) continue;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
    }
    g.stroke();
  }

  dispose() {
    if (this._canvas && this._canvas.remove) this._canvas.remove();
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
    this._env = null;
    this._envBudgetDv = null;
    this._envAtMs = -Infinity;
  }
}
