/**
 * Screen-space DOM labels at the strut tips, shown while the `struts` onboarding beat is active
 * (Events.STRUT_LABELS_SHOW, auto-hide after durationMs or hide()). Each shows strut index n/k and the hinge
 * angle α in degrees (unsigned sweep from the deployed baseline). `update(camera)` projects tips each frame.
 *
 * @module ui/hud/StrutLabels
 */

import { eventBus } from '../../core/EventBus.js';
import { Events }   from '../../core/Events.js';
import { RAD2DEG } from '../../core/MathUtil.js';

const LABEL_STYLE = {
  position:        'fixed',
  zIndex:          '200',
  pointerEvents:   'none',
  fontFamily:      "var(--font-mono)",
  fontSize:        '10px',
  color:           'var(--hud-normal, #00ffcc)',
  background:      'rgb(var(--hud-ink-rgb, 0 10 25) / 0.78)',
  border:          '1px solid rgb(var(--hud-normal-rgb, 0 255 204) / 0.4)',
  borderRadius:    '3px',
  padding:         '2px 6px',
  whiteSpace:      'nowrap',
  lineHeight:      '1.4',
  transition:      'opacity 0.2s',
  opacity:         '0',
  textShadow:      '0 0 6px rgb(var(--hud-normal-rgb, 0 255 204) / 0.6)',
};

const _v3 = { x: 0, y: 0, z: 0 };   // scratch vector (avoids new THREE.Vector3 per frame)

/**
 * Prefer the `hingeAngleDeg` that PlayerSatellite.highlightStrutsForBeat attaches per strut; fall back to the
 * Euler-magnitude estimate when it is missing (tests with handcrafted strutGroups).
 */
function _hingeAngle(sg) {
  if (sg && Number.isFinite(sg.hingeAngleDeg)) {
    return Math.round(sg.hingeAngleDeg);
  }
  const pivotGroup = sg && sg.pivotGroup;
  if (!pivotGroup || !pivotGroup.rotation) return 0;
  // Axis-magnitude proxy: not the sweep angle, but monotonic with stow/deploy progress.
  const r = pivotGroup.rotation;
  const deg = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z) * RAD2DEG;
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

    this._onShow = ({ strutGroups, durationMs = 4000 }) => {
      this.show(strutGroups, durationMs);
    };
    eventBus.on(Events.STRUT_LABELS_SHOW, this._onShow);
  }

  /** @param {Array<{pivotGroup, strut, tipNode, azRad}>} strutGroups */
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
   * @param {object}  camera  THREE.PerspectiveCamera
   * @param {number}  dt      seconds
   */
  update(camera, dt) {
    if (!this._visible || !this._strutGroups) return;

    // The auto-hide timer ticks even with no camera.
    if (this._timeLeft !== null) {
      this._timeLeft -= dt;
      if (this._timeLeft <= 0) {
        this.hide();
        return;
      }
    }

    if (!camera) return;

    const k   = this._strutGroups.length;
    const W   = (typeof window !== 'undefined') ? window.innerWidth  : 1920;
    const H   = (typeof window !== 'undefined') ? window.innerHeight : 1080;

    for (let i = 0; i < k; i++) {
      if (i >= this._labels.length) break;
      const sg  = this._strutGroups[i];
      const tip = sg.tipNode;

      if (!tip) continue;

      // `_v3` is a plain {x,y,z}, not a Vector3, so getWorldPosition(_v3) would throw: read the
      // translation column (matrixWorld.elements[12..14]) directly.
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

      const ndc = _projectToScreen(_v3, camera);
      if (!ndc) continue;

      // NDC → CSS px, top-left origin.
      const sx = (ndc.x  *  0.5 + 0.5) * W;
      const sy = (ndc.y  * -0.5 + 0.5) * H;

      const alpha = _hingeAngle(sg);
      const lbl   = this._labels[i];
      lbl.textContent  = `STRUT ${i + 1}/${k}. α=${String(alpha).padStart(3, ' ')}°`;
      lbl.style.left   = `${Math.round(sx + 8)}px`;
      lbl.style.top    = `${Math.round(sy - 10)}px`;
    }
  }

  destroy() {
    this._removeLabels();
    eventBus.off(Events.STRUT_LABELS_SHOW, this._onShow);
  }

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
 * World → NDC without allocating a Vector3; z is clip w. Null when the camera lacks matrices or w≈0.
 * @param {{x:number,y:number,z:number}} worldPos
 * @param {object} camera  THREE.PerspectiveCamera with projectionMatrix + matrixWorldInverse
 */
function _projectToScreen(worldPos, camera) {
  try {
    const m = camera.projectionMatrix   && camera.projectionMatrix.elements;
    const v = camera.matrixWorldInverse && camera.matrixWorldInverse.elements;
    if (!m || !v) return null;

    // world → view
    const vx = v[0]*worldPos.x + v[4]*worldPos.y + v[8]*worldPos.z  + v[12];
    const vy = v[1]*worldPos.x + v[5]*worldPos.y + v[9]*worldPos.z  + v[13];
    const vz = v[2]*worldPos.x + v[6]*worldPos.y + v[10]*worldPos.z + v[14];
    const vw = v[3]*worldPos.x + v[7]*worldPos.y + v[11]*worldPos.z + v[15];

    // view → clip
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
