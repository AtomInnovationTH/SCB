/**
 * DespinLaser.js — CP-2 mother-mounted de-spin laser.
 *
 * A hold-to-fire assist (default key: L) that bleeds the angular momentum out of
 * the active target so a net can cling. Mother-mounted per BIG_PICTURE §16 — it
 * operates on `targetSelector.getActiveTarget()`, not a daughter arm (the dormant
 * daughter `ARM_STATES.ABLATING` path mutated a non-existent `angularVelocity`;
 * this system mutates the real `tumbleRate` that render + HUD + cling all read).
 *
 * Lesson (CP-2): tumbling debris fails nets. Detumble below the in-spec spin and
 * the net-cling tumble penalty (CaptureNet.computeTumbleModifier) lifts → "net it".
 *
 * Pure core (`applyDespin`) is exported for headless testing. The Three.js beam
 * is created lazily and skipped entirely when no scene is injected.
 *
 * @module systems/DespinLaser
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const M = 0.00001; // scene units per metre (mirrors ArmUnit)

/**
 * Pure de-spin step: bleed `rate` (rad/s²) × dt out of a tumble, clamped at 0.
 * @returns {number} new tumble (rad/s)
 */
export function applyDespin(tumbleRate, rate, dt) {
  return Math.max(0, (tumbleRate || 0) - rate * dt);
}

export class DespinLaser {
  constructor() {
    this._scene = null;
    this._player = null;
    this._targetSelector = null;
    this._firing = false;       // intent set by InputManager from the held key
    this._wasFiring = false;    // edge detection for ABLATION_START/END
    this._beam = null;          // lazy THREE.Line
    this._beamTarget = null;    // debris currently lit
    this._overrideTarget = null; // ARM_PILOT SK target (issue 5c/9, 2026-06-12)
  }

  /** @param {{scene?, player?, targetSelector?}} deps */
  init({ scene = null, player = null, targetSelector = null } = {}) {
    this._scene = scene;
    this._player = player;
    this._targetSelector = targetSelector;
  }

  /** Set fire intent (called each frame by InputManager from the held key). */
  setFiring(on) { this._firing = !!on; }

  isFiring() { return this._firing; }

  /**
   * Issue 5c/9 (2026-06-12): while the player pilots a daughter in
   * STATION_KEEP, the SK readout advises "de-spin [L]" — route the mother
   * laser at the PILOTED ARM's SK target (which may differ from the
   * Tab-locked selector target). Pass null to restore selector targeting.
   * Set each frame by InputManager.processInput.
   */
  setOverrideTarget(target) { this._overrideTarget = target || null; }

  /** @private resolve the active target debris (canonical, mutable). */
  _target() {
    if (this._overrideTarget) return this._overrideTarget;
    return this._targetSelector && this._targetSelector.getActiveTarget
      ? this._targetSelector.getActiveTarget()
      : null;
  }

  /** @private world position of the resolved target (override-aware). */
  _targetPos() {
    if (this._overrideTarget) return this._overrideTarget._scenePosition || null;
    return this._targetSelector && this._targetSelector.getActiveTargetPosition
      ? this._targetSelector.getActiveTargetPosition()
      : null;
  }

  /** @private in-range check vs the mother optic (skipped if positions unavailable). */
  _inRange(target) {
    const cfg = Constants.DESPIN_LASER;
    if (!this._player) return true;
    const motherPos = this._player.getPosition ? this._player.getPosition() : null;
    const tPos = this._targetPos();
    if (!motherPos || !tPos) return true;
    return (motherPos.distanceTo(tPos) / M) <= cfg.RANGE_M;
  }

  update(dt) {
    const enabled = Constants.isFeatureEnabled('LASER_DESPIN');
    const target = enabled ? this._target() : null;
    const active = enabled && this._firing && !!target
      && (target.tumbleRate || 0) > 0 && this._inRange(target);

    if (!active) {
      if (this._wasFiring) {
        eventBus.emit(Events.ABLATION_END, { armIndex: -1, despinAchieved: true });
        this._wasFiring = false;
      }
      if (this._beamTarget) { this._beamTarget._despinning = false; this._beamTarget = null; }
      this._hideBeam();
      return;
    }

    const cfg = Constants.DESPIN_LASER;
    if (!this._wasFiring) {
      this._wasFiring = true;
      eventBus.emit(Events.ABLATION_START, { armIndex: -1, targetId: target.id ?? null });
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'MOTHER', text: 'De-spin laser firing. Bleeding target tumble.',
        channel: 'CMD', priority: 'info',
      });
    }

    const before = target.tumbleRate || 0;
    const after = applyDespin(before, cfg.DESPIN_RATE_RAD_S2, dt);
    target.tumbleRate = after;
    if (this._beamTarget && this._beamTarget !== target) this._beamTarget._despinning = false;
    target._despinning = true;          // HUD hint (TargetReticle)
    this._beamTarget = target;

    // Crossed below the net-safe spin this frame → announce once.
    const inSpecRad = cfg.IN_SPEC_DEG * Math.PI / 180;
    if (before > inSpecRad && after <= inSpecRad) {
      const tumbleDeg = after * 180 / Math.PI;
      eventBus.emit(Events.DESPIN_IN_SPEC, { targetId: target.id ?? null, tumbleDeg });
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'MOTHER', text: 'Tumble in spec. Net it.',
        channel: 'CMD', priority: 'success',
      });
    }

    this._drawBeam(target);
  }

  /** @private update/create the cyan mother→target beam (no-op without a scene). */
  _drawBeam(target) {
    if (!this._scene || !this._player) return;
    // BEAM VISUAL origin uses the gimbal-mounted telescope muzzle so the beam
    // emerges from the aperture and tracks sensor articulation. NOTE: the range
    // check in _inRange() intentionally stays on getPosition() (hull-center
    // range is the gameplay-correct metric); only the visual origin moves here.
    const motherPos = (this._player && typeof this._player.getLaserAperturePosition === 'function')
      ? this._player.getLaserAperturePosition()
      : (this._player.getPosition ? this._player.getPosition() : null);
    const tPos = this._targetPos();
    if (!motherPos || !tPos) return;
    if (!this._beam) {
      const cfg = Constants.DESPIN_LASER;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(6).fill(0), 3));
      const mat = new THREE.LineBasicMaterial({
        color: cfg.BEAM_COLOR, transparent: true, opacity: cfg.BEAM_OPACITY,
      });
      this._beam = new THREE.Line(geo, mat);
      this._beam.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // cyan glow beam (§9 Rule 6)
      this._scene.add(this._beam);
    }
    const pos = this._beam.geometry.attributes.position;
    pos.setXYZ(0, motherPos.x, motherPos.y, motherPos.z);
    pos.setXYZ(1, tPos.x, tPos.y, tPos.z);
    pos.needsUpdate = true;
    this._beam.visible = true;
  }

  /** @private hide the beam line. */
  _hideBeam() {
    if (this._beam) this._beam.visible = false;
  }
}

export const despinLaser = new DespinLaser();
