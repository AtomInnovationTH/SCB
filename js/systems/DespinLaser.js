/**
 * @module systems/DespinLaser — mother-mounted de-spin laser: a hold-to-fire assist (default key: L) that bleeds the
 * angular momentum out of the active target so a net can cling. Operates on `targetSelector.getActiveTarget()`, not a
 * daughter arm; mutates the real `tumbleRate` that render + HUD + cling all read.
 *
 * Lesson: tumbling debris fails nets. Detumble below the in-spec spin and the net-cling tumble penalty
 * (CaptureNet.computeTumbleModifier) lifts → "net it".
 *
 * Pure core (`applyDespin`) is exported for headless testing. The Three.js beam is created lazily and skipped entirely
 * when no scene is injected.
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { degToRad, radToDeg } from '../core/MathUtil.js';

const M = 0.00001; // scene units per metre (mirrors ArmUnit)

// ---------------------------------------------------------------------------------------------------------------------
// Pure physics (DECISIONS §60 row 7; research docs/research/2026-11-laser-options.md). A `tier` is
// `Constants.DESPIN_LASER.CLOSE` / `.LONG` or any object with the same fields (tests build their own).
// ---------------------------------------------------------------------------------------------------------------------

/** Beam power in watts: pulse energy × pulse rate. */
export function beamW(tier) {
  return tier.PULSE_J * tier.REP_HZ;
}

/** Power drawn from the ship while firing, watts: beam ÷ wall-plug efficiency. */
export function drawW(tier) {
  return beamW(tier) / tier.EFFICIENCY;
}

/**
 * How far the beam still holds the fluence the surface needs, metres. The spot is the diffraction limit
 * (2.44 λ M² × range / D); pulse energy over that spot area must stay at the fluence:
 * `reach = D × sqrt(4E / (π F 1e4)) / (2.44 λ M²)` (D aperture m, E pulse J, F J/cm², λ m). Watts and pulse rate do not enter.
 */
export function despinReachM(tier) {
  const spotAreaM2 = tier.PULSE_J / (tier.FLUENCE_J_CM2 * 1e4);   // J ÷ (J/cm² → J/m²) = m² of surface that can be lit
  const spotDiameterM = Math.sqrt(4 * spotAreaM2 / Math.PI);
  return tier.APERTURE_M * spotDiameterM / (2.44 * tier.WAVELENGTH_M * tier.M2);
}

/**
 * Angular deceleration the beam gives one piece, rad/s²: push = coupling × beam watts, acting `LEVER_FRAC` of the half-length off
 * centre, over the moment of inertia `INERTIA_K × m × L²`. 0 when the piece lacks a usable mass or length (no silent default).
 * @param {object} tier
 * @param {number} massKg
 * @param {number} lengthM
 */
export function despinAlpha(tier, massKg, lengthM) {
  if (!(massKg > 0) || !(lengthM > 0) || !Number.isFinite(massKg) || !Number.isFinite(lengthM)) return 0;
  const cfg = Constants.DESPIN_LASER;
  const pushN = tier.COUPLING_UN_PER_W * 1e-6 * beamW(tier);
  const torque = pushN * cfg.LEVER_FRAC * (lengthM / 2);
  return torque / (cfg.INERTIA_K * massKg * lengthM * lengthM);
}

/**
 * Physical seconds to bring a piece's spin from `fromRadS` to `toRadS` at the tier's constant α (the screen shows it
 * ÷ `TIME_SCALE_GAMEPLAY`). 0 when already at or below `toRadS`; Infinity when the beam cannot turn the piece.
 */
export function despinTimeS(tier, massKg, lengthM, fromRadS, toRadS) {
  if (!(fromRadS > toRadS)) return 0;
  const alpha = despinAlpha(tier, massKg, lengthM);
  return alpha > 0 ? (fromRadS - toRadS) / alpha : Infinity;
}

/** Pure de-spin step: bleed `rate` (rad/s²) × dt out of a tumble, clamped at 0. Returns the new tumble (rad/s). */
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
    this._overrideTarget = null; // piloted-arm SK target (see setOverrideTarget)
    this._activeTier = null;    // the tier that acted this frame (null when not firing)
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
   * Is the long-range laser aboard? Asks the player (`hasLongLaser()`); false when the player has no such method. Nothing
   * here stores ownership, so a new run cannot inherit it.
   */
  hasLongRange() {
    const p = this._player;
    try { return !!(p && typeof p.hasLongLaser === 'function' && p.hasLongLaser()); } catch (_e) { return false; }
  }

  /** The longest reach aboard, metres (the long tier's when owned, else the close tier's). */
  reachM() {
    const cfg = Constants.DESPIN_LASER;
    return despinReachM(this.hasLongRange() ? cfg.LONG : cfg.CLOSE);
  }

  /**
   * The tier that would fire at `distanceM`: the close one inside its reach, the long one (when owned) beyond it up to its
   * reach, else null. An unknown distance (no positions to measure) counts as close, as the old range gate skipped itself.
   */
  tierFor(distanceM) {
    const cfg = Constants.DESPIN_LASER;
    if (!Number.isFinite(distanceM)) return cfg.CLOSE;
    if (distanceM <= despinReachM(cfg.CLOSE)) return cfg.CLOSE;
    if (this.hasLongRange() && distanceM <= despinReachM(cfg.LONG)) return cfg.LONG;
    return null;
  }

  /** The tier that acted on a target this frame, or null when the laser did not fire. */
  activeTier() { return this._activeTier; }

  /**
   * While the player pilots a daughter in STATION_KEEP, the SK readout advises "de-spin [L]": route the mother laser at
   * the PILOTED ARM's SK target (which may differ from the Tab-locked selector target). null restores selector
   * targeting. Set each frame by InputManager.processInput.
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

  /** @private mother-to-target distance in metres from the hull centre, or null when positions are unavailable. */
  _distanceM() {
    if (!this._player) return null;
    const motherPos = this._player.getPosition ? this._player.getPosition() : null;
    const tPos = this._targetPos();
    if (!motherPos || !tPos) return null;
    return motherPos.distanceTo(tPos) / M;
  }

  /**
   * @param {number} dt real frame seconds (the battery clock; billing lives here from lane L2 on)
   * @param {number} [gameDt] game seconds this frame, the step the sky and the tumble animation turn by (`dtWorld`: ×10 base,
   *   times any warp, 0 while the world is held). The spin-down runs on it. Omitted = `dt`.
   */
  update(dt, gameDt = dt) {
    const enabled = Constants.isFeatureEnabled('LASER_DESPIN');
    const target = enabled ? this._target() : null;
    let tier = null;
    let alpha = 0;
    if (enabled && this._firing && target && (target.tumbleRate || 0) > 0) {
      tier = this.tierFor(this._distanceM());
      // A piece with no mass or length is not de-spun (no silent default).
      if (tier) alpha = despinAlpha(tier, target.mass, target.lengthM);
      if (!(alpha > 0)) tier = null;
    }
    const active = !!tier;
    this._activeTier = tier;

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
    const after = applyDespin(before, alpha, gameDt);
    target.tumbleRate = after;
    if (this._beamTarget && this._beamTarget !== target) this._beamTarget._despinning = false;
    target._despinning = true;          // HUD hint (TargetReticle)
    this._beamTarget = target;

    // Crossed below the net-safe spin this frame → announce once.
    const inSpecRad = degToRad(cfg.IN_SPEC_DEG);
    if (before > inSpecRad && after <= inSpecRad) {
      const tumbleDeg = radToDeg(after);
      eventBus.emit(Events.DESPIN_IN_SPEC, { targetId: target.id ?? null, tumbleDeg, mover: target._mover === true });
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
    // BEAM VISUAL origin is the gimbal-mounted telescope muzzle, so the beam emerges from the aperture and tracks
    // sensor articulation. The reach check (_distanceM() / tierFor) intentionally stays on getPosition() (hull-center range is the
    // gameplay-correct metric); only the visual origin moves here.
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
