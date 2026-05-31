/**
 * StrutLabels.js — Screen-space callout labels for the V5 strut tips
 * Shows floating DOM labels when the `struts` onboarding beat is active.
 *
 * Each label reads:  "STRUT n/k — α=DDD°"
 *   n  = 1-based index
 *   k  = total strut count
 *   α  = hinge angle in degrees (unsigned sweep from deployed baseline)
 *
 * Lifecycle:
 *   • Listen to Events.STRUT_LABELS_SHOW → show labels for durationMs.
 *   • update(camera) projects strut-tip world positions each frame.
 *   • Automatically hides after durationMs or when hide() is called.
 *
 * Uses THREE.Vector3.project(camera) for world→NDC→screen conversion.
 * DOM labels, no Canvas2D, no new Three.js render passes.
 *
 * @module ui/hud/StrutLabels
 */

import { eventBus } from '../../core/EventBus.js';
import { Events }   from '../../core/Events.js';

const LABEL_STYLE = {
  position:        'fixed',
  zIndex:          '200',
  pointerEvents:   'none',
  fontFamily:      "'Courier New', monospace",
  fontSize:        '10px',
  color:           '#00ffcc',
  background:      'rgba(0,10,25,0.78)',
  border:          '1px solid rgba(0,255,204,0.4)',
  borderRadius:    '3px',
  padding:         '2px 6px',
  whiteSpace:      'nowrap',
  lineHeight:      '1.4',
  transition:      'opacity 0.2s',
  opacity:         '0',
  textShadow:      '0 0 6px rgba(0,255,204,0.6)',
};

const _v3 = { x: 0, y: 0, z: 0 };   // scratch vector (avoids new THREE.Vector3 per frame)

/**
 * Delegation 4 (2026-05-31) — Quick-Win 2b / P1-3:
 *
 * Prefer the authoritative `hingeAngleDeg` field that the emitter
 * (PlayerSatellite.highlightStrutsForBeat) now attaches per strut. Falls back
 * to the legacy Euler-magnitude estimate when the field is missing so older
 * tests with handcrafted strutGroups continue to work.
 */
function _hingeAngle(sg) {
  if (sg && Number.isFinite(sg.hingeAngleDeg)) {
    return Math.round(sg.hingeAngleDeg);
  }
  const pivotGroup = sg && sg.pivotGroup;
  if (!pivotGroup || !pivotGroup.rotation) return 0;
  // Legacy fallback — axis-magnitude proxy; not strictly the sweep angle but
  // remains monotonic with strut stow/deploy progress.
  const r = pivotGroup.rotation;
  const deg = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z) * (180 / Math.PI);
  return Math.round(deg);
}

export class StrutLabels {
  /**
   * @param {HTMLElement} [container]  Host element — defaults to document.body.
   */
  constructor(container = null) {
    this._container = container || (typeof document !== 'undefined' ? document.body : null);

    /** @type {HTMLElement[]} One label div per strut */
    this._labels = [];

    /** @type {Array<{pivotGroup: object, tipNode: object, azRad: number}>|null} */
    this._strutGroups = null;

    /** @type {number|null} Remaining display duration in seconds */
    this._timeLeft = null;

    /** @type {boolean} */
    this._visible = false;

    // Subscribe to strut-labels event
    this._onShow = ({ strutGroups, durationMs = 4000 }) => {
      this.show(strutGroups, durationMs);
    };
    eventBus.on(Events.STRUT_LABELS_SHOW, this._onShow);
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Show labels for the given strut groups.
   * @param {Array<{pivotGroup, strut, tipNode, azRad}>} strutGroups
   * @param {number} durationMs  Auto-hide after this many ms.
   */
  show(strutGroups, durationMs = 4000) {
    if (!this._container) return;
    this._strutGroups = strutGroups || [];
    this._timeLeft    = durationMs / 1000;
    this._visible     = true;
    this._rebuildLabels(this._strutGroups.length);
    for (const lbl of this._labels) lbl.style.opacity = '0.92';
  }

  hide() {
    this._visible  = false;
    this._timeLeft = null;
    for (const lbl of this._labels) lbl.style.opacity = '0';
  }

  /**
   * Per-frame update — projects tip positions and ticks auto-hide timer.
   * @param {object}  camera  THREE.PerspectiveCamera
   * @param {number}  dt      Delta time in seconds
   */
  update(camera, dt) {
    if (!this._visible || !this._strutGroups) return;

    // Auto-hide timer always ticks, regardless of camera availability
    if (this._timeLeft !== null) {
      this._timeLeft -= dt;
      if (this._timeLeft <= 0) {
        this.hide();
        return;
      }
    }

    // Skip world-space label projection when no camera is available
    if (!camera) return;

    const k   = this._strutGroups.length;
    const W   = (typeof window !== 'undefined') ? window.innerWidth  : 1920;
    const H   = (typeof window !== 'undefined') ? window.innerHeight : 1080;

    for (let i = 0; i < k; i++) {
      if (i >= this._labels.length) break;
      const sg  = this._strutGroups[i];
      const tip = sg.tipNode;

      if (!tip) continue;

      // Delegation 4 (2026-05-31) — Browser-playtest fix:
      // `_v3` is a plain {x,y,z} scratch object (not a THREE.Vector3),
      // so `tip.getWorldPosition(_v3)` crashed with
      // "target.setFromMatrixPosition is not a function" every frame.
      // Read the world position directly from `matrixWorld.elements`
      // (indices 12/13/14 = translation column) — avoids needing a
      // real Vector3 and avoids importing THREE.
      const mw = tip.matrixWorld?.elements;
      if (mw) {
        _v3.x = mw[12];
        _v3.y = mw[13];
        _v3.z = mw[14];
      } else if (tip.position) {
        _v3.x = tip.position.x || 0;
        _v3.y = tip.position.y || 0;
        _v3.z = tip.position.z || 0;
      } else {
        continue;
      }

      // Project to NDC via camera
      const ndc = _projectToScreen(_v3, camera);
      if (!ndc) continue;

      // NDC → CSS pixels (top-left origin)
      const sx = (ndc.x  *  0.5 + 0.5) * W;
      const sy = (ndc.y  * -0.5 + 0.5) * H;

      const alpha = _hingeAngle(sg);
      const lbl   = this._labels[i];
      lbl.textContent  = `STRUT ${i + 1}/${k} — α=${String(alpha).padStart(3, ' ')}°`;
      lbl.style.left   = `${Math.round(sx + 8)}px`;
      lbl.style.top    = `${Math.round(sy - 10)}px`;
    }
  }

  /**
   * Remove all labels and unsubscribe from events.
   */
  destroy() {
    this._removeLabels();
    eventBus.off(Events.STRUT_LABELS_SHOW, this._onShow);
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  _rebuildLabels(count) {
    this._removeLabels();
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      Object.assign(el.style, LABEL_STYLE);
      el.style.opacity = '0';
      this._container.appendChild(el);
      this._labels.push(el);
    }
  }

  _removeLabels() {
    for (const lbl of this._labels) {
      if (lbl.parentNode) lbl.parentNode.removeChild(lbl);
    }
    this._labels.length = 0;
  }
}

/**
 * Lightweight world → NDC projection.
 * Avoids allocating a THREE.Vector3 by using a scratch object.
 * @param {{x:number,y:number,z:number}} worldPos
 * @param {object} camera  THREE.PerspectiveCamera with projectionMatrix + matrixWorldInverse
 * @returns {{x:number,y:number,z:number}|null}
 */
function _projectToScreen(worldPos, camera) {
  try {
    // Build 4-component clip-space vector manually (avoids import)
    const m = camera.projectionMatrix   && camera.projectionMatrix.elements;
    const v = camera.matrixWorldInverse && camera.matrixWorldInverse.elements;
    if (!m || !v) return null;

    // Transform world → view
    const vx = v[0]*worldPos.x + v[4]*worldPos.y + v[8]*worldPos.z  + v[12];
    const vy = v[1]*worldPos.x + v[5]*worldPos.y + v[9]*worldPos.z  + v[13];
    const vz = v[2]*worldPos.x + v[6]*worldPos.y + v[10]*worldPos.z + v[14];
    const vw = v[3]*worldPos.x + v[7]*worldPos.y + v[11]*worldPos.z + v[15];

    // View → clip
    const cx = m[0]*vx + m[4]*vy + m[8]*vz  + m[12]*vw;
    const cy = m[1]*vx + m[5]*vy + m[9]*vz  + m[13]*vw;
    const cw = m[3]*vx + m[7]*vy + m[11]*vz + m[15]*vw;

    if (Math.abs(cw) < 1e-7) return null;
    return { x: cx / cw, y: cy / cw, z: cw };
  } catch {
    return null;
  }
}

export default StrutLabels;
