/**
 * DaughterReachBubble.js — the daughters' reach, drawn as a faint bubble round the mother on the ship floors 2 and 3.
 *
 * Owner 2026-11-19 (picked "Daughter reach bubble"): "On the ship floors, a bubble around a ready daughter shows how far
 * her net and tether reach." And: "consider daughters range with full upgrade to 10k graphene 100 GPa tether".
 *
 * WHAT IT SHOWS. The farthest piece a ready daughter can be sent to: the game's own deploy gate, `config.tetherMax` x
 * `Constants.ARM_DEPLOY_RANGE_FRACTION` (the expression ArmManager's `_armShortfall` / `_pairOutOfReach` / `_deployWithCeremony`
 * refuse by: "Target 492m away (max 400m)"). `config.tetherMax` is the LIVE tether length (`ArmUnit.setTetherTier` writes it
 * from `Constants.TETHER_TIERS`), so a longer line-fibre tier grows the bubble with no number kept here. The net throw
 * is already inside that gate (the gate measures to the piece; she throws from beside it), so no net range is added: adding the
 * 90 m would draw a piece the game refuses as reachable.
 *
 * WHICH DAUGHTER. Only daughters that can launch right now count (`armCanLaunchNow`: docked, spring charged, fuel, not
 * reserved). When a large and a small daughter are both ready the LONGER reach is drawn and the label names her.
 *
 * WHERE. Floors 2 and 3 only (FloorContract ids), hidden in training 1-3 (nothing is drawn there today, DECISIONS §71) and
 * while no daughter is ready. Drawn as three thin dashed great circles (a wire sphere) centred on the mother, on one
 * full-screen canvas with pointer-events:none, no fill, so no piece is ever covered. Style follows ProxOverlay / ReachOrb.
 *
 * Headless-safe: update() always computes and returns the descriptor; painting only happens with a canvas and when shown.
 *
 * @module ui/DaughterReachBubble
 */

import { Constants } from '../core/Constants.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { mono } from '../core/Typeface.js';
import { ProxOverlay } from './ProxOverlay.js';

/** The floors that draw the bubble (FloorContract ids: 2 CATCH, 3 DEBRIS). Hidden on 1, 4, 5. */
export const REACH_BUBBLE_FLOORS = Object.freeze([2, 3]);

/** Caption size (CSS px; owner 2026-11-17: on-screen text at least 13). */
export const REACH_LABEL_PX = 13;

/** Samples per great circle. */
export const REACH_SEGMENTS = 64;

/** A ring point nearer than this to the right screen edge does not carry the label. */
export const EDGE_MARGIN_PX = 80;

/** Stroke alpha of the wire sphere and the label (faint: context, never covers a piece). */
export const REACH_LINE_ALPHA = 0.3;
export const REACH_LABEL_ALPHA = 0.8;

const NAMES = Object.freeze({ weaver: 'Large daughter', spinner: 'Small daughter' });

/**
 * How far one daughter can be sent: the deploy gate, in metres.
 * @param {{config?: {tetherMax?: number}}} arm
 * @returns {number} 0 when unknown
 */
export function armReachM(arm) {
  const L = arm && arm.config ? arm.config.tetherMax : 0;
  return L > 0 ? L * Constants.ARM_DEPLOY_RANGE_FRACTION : 0;
}

/**
 * The reach to draw: the longest of the daughters that can launch now.
 * @param {Array} arms ArmUnit-shaped
 * @param {(arm: object) => boolean} canLaunch ArmManager's `armCanLaunchNow`
 * @returns {{radiusM: number, type: string, name: string}|null} null when none is ready
 */
export function pickReach(arms, canLaunch) {
  let best = null;
  for (const a of (arms || [])) {
    if (!a || !canLaunch(a)) continue;
    const r = armReachM(a);
    if (!(r > 0)) continue;
    if (!best || r > best.radiusM) best = { radiusM: r, type: a.type, name: NAMES[a.type] || 'Daughter' };
  }
  return best;
}

/** @param {number} m metres @returns {string} '400 m' under 1 km, else '1.6 km' ('10 km' when whole). */
export function formatReach(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}

/** The one label line. */
export function reachLabel(reach) {
  return `${reach.name} reach ${formatReach(reach.radiusM)}`;
}

export class DaughterReachBubble {
  /**
   * @param {object} deps
   * @param {() => Array} deps.getArms ArmManager.arms
   * @param {(arm: object) => boolean} deps.canLaunch ArmManager's `armCanLaunchNow`
   * @param {() => (number|null)} deps.getFloor the ladder's current floor id, null when the ladder is off
   * @param {() => boolean} [deps.isTraining] true in training 1-3 (hidden there)
   */
  constructor(deps = {}) {
    this._getArms = deps.getArms || (() => []);
    this._canLaunch = deps.canLaunch || (() => false);
    this._getFloor = deps.getFloor || (() => null);
    this._isTraining = deps.isTraining || (() => false);
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._shown = false;
    this._last = null;
  }

  /** The descriptor of the last update() (tests). */
  get last() { return this._last; }

  /**
   * Can the bubble be up this frame at all (a floor 2-3 frame outside training)? The loop asks BEFORE it copies the mother's
   * position and velocity and refreshes the camera matrices, so a hidden bubble (floors 1, 4, 5) costs one floor read per frame.
   * @returns {boolean}
   */
  wantsFrame() {
    return REACH_BUBBLE_FLOORS.includes(this._getFloor()) && !this._isTraining();
  }

  /**
   * Should the bubble be up this frame, and how big?
   * @returns {{radiusM:number, type:string, name:string, label:string}|null}
   */
  state() {
    const floor = this._getFloor();
    if (!REACH_BUBBLE_FLOORS.includes(floor)) return null;
    if (this._isTraining()) return null;
    const reach = pickReach(this._getArms(), this._canLaunch);
    if (!reach) return null;
    return { ...reach, label: reachLabel(reach) };
  }

  /**
   * One frame: decide, project and (when a canvas exists) paint.
   * @param {object} frame
   * @param {{x,y,z}} frame.shipPos the mother (the tether's anchor), scene units
   * @param {{x,y,z}|null} [frame.shipVel] her velocity (orients the first circle like the density shells)
   * @param {(p:{x,y,z}) => {x,y,visible}} frame.project world -> screen
   * @returns {{visible:boolean, radiusM?:number, radiusU?:number, label?:string, circles?:Array, tag?:{x,y}}}
   */
  update(frame = {}) {
    const st = frame.shipPos ? this.state() : null;
    if (!st) {
      this._last = { visible: false };
      this._hide();
      return this._last;
    }
    const radiusU = st.radiusM * Constants.SCENE_UNITS_PER_METER;
    const basis = ProxOverlay.planeBasis(frame.shipPos, frame.shipVel || null);
    const e1 = basis.e1, e2 = basis.e2;
    const n = {
      x: e1.y * e2.z - e1.z * e2.y,
      y: e1.z * e2.x - e1.x * e2.z,
      z: e1.x * e2.y - e1.y * e2.x,
    };
    const proj = typeof frame.project === 'function' ? frame.project : () => ({ x: 0, y: 0, visible: false });
    const bases = [{ e1, e2 }, { e1, e2: n }, { e1: e2, e2: n }];
    const circles = bases.map((b) => ProxOverlay.ringPoints(frame.shipPos, radiusU, b, REACH_SEGMENTS)
      .map((q) => proj(q) || { x: 0, y: 0, visible: false }));
    // Label anchor: the visible ring point farthest right (a point on the bubble, off the ship).
    let tag = null;
    for (const c of circles) for (const p of c) if (p.visible && (!tag || p.x > tag.x)) tag = { x: p.x, y: p.y };
    // A ring point hard against the screen edge is the horizon of a bubble the camera sits inside (floor 2): the label then
    // sits at the mother, where the bubble is centred, not at a random spot on the edge.
    const W = (typeof window !== 'undefined') ? window.innerWidth : Infinity;
    if (tag && tag.x > W - EDGE_MARGIN_PX) tag = null;
    const mother = proj(frame.shipPos) || null;
    this._last = {
      visible: true, radiusM: st.radiusM, radiusU, label: st.label, type: st.type, circles, tag,
      mother: mother && mother.visible ? { x: mother.x, y: mother.y } : null,
    };
    this._show();
    this._paint(this._last);
    return this._last;
  }

  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const canvas = document.createElement('canvas');
    canvas.id = 'daughter-reach-bubble';
    // z-index 31: under ProxOverlay (32) and the floors' panels, over the 3D canvas. No hitboxes.
    canvas.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:31', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx2d = canvas.getContext ? canvas.getContext('2d') : null;
  }

  _show() {
    this._build();
    this._shown = true;
    if (this._canvas) this._canvas.style.opacity = '1';
  }

  _hide() {
    if (!this._shown) return;
    this._shown = false;
    if (this._canvas) {
      this._canvas.style.opacity = '0';
      if (this._ctx2d) this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  _paint(f) {
    const canvas = this._canvas;
    const g = this._ctx2d;
    if (!canvas || !g || !this._shown) return;
    const w = (typeof window !== 'undefined') ? window.innerWidth : canvas.width;
    const h = (typeof window !== 'undefined') ? window.innerHeight : canvas.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    // A segment that jumps across the screen is a projection wrap (a point beside the camera), not part of the circle.
    const maxJump = Math.hypot(w, h) * 0.6;
    g.strokeStyle = VisualLaw.COLORS.INFO;
    g.lineWidth = 1;
    g.globalAlpha = REACH_LINE_ALPHA;
    if (g.setLineDash) g.setLineDash([6, 6]);
    for (const c of f.circles) {
      g.beginPath();
      const n = c.length;
      for (let i = 0; i < n; i++) {
        const a = c[i], b = c[(i + 1) % n];
        if (!a.visible || !b.visible) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > maxJump) continue;
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      }
      g.stroke();
    }
    if (g.setLineDash) g.setLineDash([]);
    g.globalAlpha = REACH_LABEL_ALPHA;
    g.fillStyle = VisualLaw.COLORS.INFO;
    g.font = mono(REACH_LABEL_PX);
    // On the bubble when a ring point is on screen, else bottom centre; always fully inside the screen.
    g.textAlign = 'left';
    const tw = g.measureText ? g.measureText(f.label).width : 200;
    let x, y;
    if (f.tag) { x = f.tag.x + 8; y = f.tag.y - 8; }
    else if (f.mother) { x = f.mother.x + 48; y = f.mother.y + 4; }
    else { x = (w - tw) / 2; y = h - 56; }
    x = Math.max(8, Math.min(w - tw - 8, x));
    y = Math.max(REACH_LABEL_PX + 8, Math.min(h - 8, y));
    g.fillText(f.label, x, y);
    g.globalAlpha = 1;
  }

  dispose() {
    if (this._canvas && this._canvas.remove) this._canvas.remove();
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._shown = false;
    this._last = null;
  }
}
