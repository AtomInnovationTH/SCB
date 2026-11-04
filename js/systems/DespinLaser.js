/**
 * @module systems/DespinLaser — mother-mounted de-spin laser: a hold-to-fire assist (default key: L) that bleeds the
 * angular momentum out of the active target so a net can cling. Operates on `targetSelector.getActiveTarget()`, not a
 * daughter arm; mutates the real `tumbleRate` that render + HUD + cling all read.
 *
 * Lesson: tumbling debris fails nets. Detumble below the in-spec spin and the net-cling tumble penalty
 * (CaptureNet.computeTumbleModifier) lifts → "net it".
 *
 * Laser round 2 (E1/E4): a daughter that owns a relay mirror and station-keeps on the piece can bounce the beam onto it
 * (`relayTier`, `relayLegMaxM`); `planBeams` picks the mother's best path, `previewBeams` answers for the hint and the button.
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
 * Angular deceleration the beam gives one piece, rad/s²: push = coupling × beam watts, acting `LEVER_FRAC` (0.55, the laser aims
 * at the end of the piece, E12; was 0.3) of the half-length off centre, over the moment of inertia `INERTIA_K × m × L²`. 0 when the piece lacks a usable mass or length (no silent default).
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

// ---------------------------------------------------------------------------------------------------------------------
// Relay mirror (laser round 2, E1): a daughter's mirror bounces the mother's beam onto the piece.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The tier a relayed beam acts as: the mirror is the last aperture (`mirrorEffM`, already reduced by cos θi) and the push is
 * what the mirror returns (`COUPLING × REFLECTIVITY`). Pulse, rate, wavelength and fluence are the base tier's, so
 * `despinReachM` (reach measured daughter to piece) and `despinAlpha` work on it unchanged.
 * @param {object} baseTier the mother's tier whose beam is relayed
 * @param {number} mirrorEffM effective mirror width, m
 */
export function relayTier(baseTier, mirrorEffM) {
  return {
    ...baseTier,
    APERTURE_M: mirrorEffM,
    COUPLING_UN_PER_W: baseTier.COUPLING_UN_PER_W * Constants.DESPIN_LASER.RELAY.REFLECTIVITY,
  };
}

/**
 * Longest mother→daughter leg, metres, where the beam's smallest spot (2.44 λ M² × leg / D) still fits the mirror:
 * `leg ≤ mirrorEffM × D / (2.44 λ M²)` (D, λ, M² the base tier's).
 */
export function relayLegMaxM(baseTier, mirrorEffM) {
  return mirrorEffM * baseTier.APERTURE_M / (2.44 * baseTier.WAVELENGTH_M * baseTier.M2);
}

/** θi at the daughter, radians: half the angle between "to mother" and "to piece". 0 when the two coincide or a vector is zero. */
function incidenceRad(daughterPos, motherPos, piecePos) {
  const a = new THREE.Vector3().subVectors(motherPos, daughterPos);
  const b = new THREE.Vector3().subVectors(piecePos, daughterPos);
  if (!(a.lengthSq() > 0) || !(b.lengthSq() > 0)) return 0;
  const c = Math.max(-1, Math.min(1, a.normalize().dot(b.normalize())));
  return Math.acos(c) / 2;
}

/**
 * Which beams act on the piece, pure. The mother fires its single best path: direct with any owned tier in reach, or relayed
 * through an eligible daughter (a daughter with a mirror, a pack that is not flat); the largest push wins, ties go to the direct
 * path, then to the nearest daughter. Positions are scene units; a missing position counts as an unknown distance (the first
 * owned tier fires direct, as the old range gate skipped itself). `hasOwnLaser` daughters are reserved for the weaver laser.
 * @param {{motherPos: THREE.Vector3|null, target: {mass?: number, lengthM?: number}|null, targetPos: THREE.Vector3|null,
 *   tiers: object[], daughters: {armIndex: number, type: string, pos: THREE.Vector3, eligible: boolean, hasMirror: boolean,
 *   hasOwnLaser?: boolean, packOk: boolean}[]}} ctx
 * @returns {{kind: 'direct'|'relay'|'own', armIndex: number|null, tier: object, baseTier: object, emitter: THREE.Vector3|null,
 *   path: THREE.Vector3[], pushN: number, alpha: number}[]}
 */
export function planBeams(ctx) {
  const { motherPos, target, targetPos } = ctx;
  const tiers = ctx.tiers || [];
  const daughters = ctx.daughters || [];
  if (!target || !tiers.length) return [];
  const mass = target.mass, len = target.lengthM;
  const R = Constants.DESPIN_LASER.RELAY;
  const cand = [];
  const known = !!(motherPos && targetPos);

  // direct: every owned tier whose reach covers the mother→piece distance
  const dist = known ? motherPos.distanceTo(targetPos) / M : NaN;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (known ? !(dist <= despinReachM(tier)) : i !== 0) continue;
    cand.push({ kind: 'direct', armIndex: null, tier, baseTier: tier, emitter: motherPos || null,
      path: known ? [motherPos, targetPos] : [], pushN: tier.COUPLING_UN_PER_W * 1e-6 * beamW(tier), near: 0 });
  }

  // relay: every owned tier through every eligible daughter whose mirror takes the beam and whose reach covers the piece
  if (known) {
    for (const d of daughters) {
      if (!d || !d.eligible || !d.hasMirror || !d.packOk || !d.pos) continue;
      const mirrorM = R.MIRROR_M[d.type];
      if (!(mirrorM > 0)) continue;
      const mirrorEffM = mirrorM * Math.cos(incidenceRad(d.pos, motherPos, targetPos));
      if (!(mirrorEffM > 1e-9)) continue;
      const legM = motherPos.distanceTo(d.pos) / M;
      const reachFromD = d.pos.distanceTo(targetPos) / M;
      for (const base of tiers) {
        if (!(legM <= relayLegMaxM(base, mirrorEffM))) continue;
        const tier = relayTier(base, mirrorEffM);
        if (!(reachFromD <= despinReachM(tier))) continue;
        cand.push({ kind: 'relay', armIndex: d.armIndex, tier, baseTier: base, emitter: d.pos,
          path: [motherPos, d.pos, targetPos], pushN: tier.COUPLING_UN_PER_W * 1e-6 * beamW(base), near: legM });
      }
    }
  }

  const beams = [];
  for (const c of cand) {
    const alpha = despinAlpha(c.tier, mass, len);
    if (alpha > 0) beams.push({ ...c, alpha });
  }
  if (!beams.length) return [];
  // largest push; direct before relay on a tie; then the nearest daughter
  const EPS = 1e-9;
  beams.sort((a, b) => {
    if (Math.abs(a.pushN - b.pushN) > EPS * Math.max(a.pushN, b.pushN)) return b.pushN - a.pushN;
    if (a.kind !== b.kind) return a.kind === 'direct' ? -1 : 1;
    return a.near - b.near;
  });
  const best = beams[0];
  delete best.near;
  return [best];
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
    this._activeTier = null;    // the mother's tier that acted this frame (null when not firing)
    this._beamsActed = [];      // the beams that acted this frame (planBeams entries)
    this._rs = null;            // ResourceSystem: the battery the beam bills (null = unbilled, headless tests)
    this._armManager = null;    // the daughters that may relay (`.arms`); null = none
    this._emptyTold = false;    // the "battery empty" line was said for this press
  }

  /** @param {{scene?, player?, targetSelector?, resourceSystem?, armManager?}} deps */
  init({ scene = null, player = null, targetSelector = null, resourceSystem = null, armManager = null } = {}) {
    this._scene = scene;
    this._player = player;
    this._targetSelector = targetSelector;
    this._rs = resourceSystem;
    this._armManager = armManager;
    this._emptyTold = false;
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

  /** Are the daughters' relay mirrors aboard? Asks the player (`hasRelayMirrors()`); false when it has no such method. */
  hasRelayMirrors() {
    const p = this._player;
    try { return !!(p && typeof p.hasRelayMirrors === 'function' && p.hasRelayMirrors()); } catch (_e) { return false; }
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

  /** The mother's tier that acted on a target this frame (the base tier when relayed), or null when the laser did not fire. */
  activeTier() { return this._activeTier; }

  /** The beams that acted this frame (`planBeams` entries); `[]` when none. */
  beamsThisFrame() { return this._beamsActed; }

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
   * @private the context `planBeams` needs, from the live mother, the daughters and what is owned. `daughters` are the units
   * that could relay: undocked and in STATION_KEEP on this very piece.
   */
  _ctx(target, targetPos) {
    const cfg = Constants.DESPIN_LASER;
    const p = this._player;
    const motherPos = p && p.getPosition ? p.getPosition() : null;
    const tiers = this.hasLongRange() ? [cfg.CLOSE, cfg.LONG] : [cfg.CLOSE];
    const hasMirror = this.hasRelayMirrors();
    const S = Constants.ARM_STATES;
    const arms = (this._armManager && this._armManager.arms) || [];
    const daughters = [];
    for (let i = 0; i < arms.length; i++) {
      const u = arms[i];
      if (!u || !u.position || u.state !== S.STATION_KEEP || !target || u._stationKeepTarget !== target) continue;
      daughters.push({
        armIndex: u.index ?? i, type: u.type, pos: u.position, eligible: true, hasMirror,
        hasOwnLaser: false, packOk: !(u.power && u.power.flat),
      });
    }
    return { motherPos, target, targetPos, tiers, daughters };
  }

  /**
   * The beams that would fire at `target` (default: the laser's target) and the physical seconds to bring it to `IN_SPEC_DEG`
   * with their summed spin-down (0 when already in spec, Infinity when no beam can fire). Works whether or not L is held; the
   * hint and the DE-SPIN button use it.
   * @param {object} [target]
   * @returns {{beams: object[], timeS: number}}
   */
  previewBeams(target) {
    const t = target || this._target();
    if (!t) return { beams: [], timeS: Infinity };
    const tPos = (t === this._target()) ? this._targetPos() : (t._scenePosition || null);
    const beams = planBeams(this._ctx(t, tPos));
    if (!beams.length) return { beams, timeS: Infinity };
    const alpha = beams.reduce((a, b) => a + b.alpha, 0);
    const from = t.tumbleRate || 0, to = degToRad(Constants.DESPIN_LASER.IN_SPEC_DEG);
    return { beams, timeS: from > to ? (from - to) / alpha : 0 };
  }

  /**
   * @param {number} dt real frame seconds (the battery clock: the beam bills `drawW(tier)` for this long)
   * @param {number} [gameDt] game seconds this frame, the step the sky and the tumble animation turn by (`dtWorld`: ×10 base,
   *   times any warp, 0 while the world is held). The spin-down runs on it. Omitted = `dt`.
   */
  update(dt, gameDt = dt) {
    const enabled = Constants.isFeatureEnabled('LASER_DESPIN');
    const target = enabled ? this._target() : null;
    let beams = [];
    if (enabled && this._firing && target && (target.tumbleRate || 0) > 0) {
      // A piece with no mass or length gives no beam (no silent default).
      beams = planBeams(this._ctx(target, this._targetPos()));
    }
    const motherBeam = () => beams.find((b) => b.kind !== 'own') || null;

    // The beam is paid for in real battery seconds (D7): draw/EFFICIENCY watts, tagged 'laser', the part that leaves as
    // light (EFFICIENCY) kept out of the heat. Nothing is billed while the world is held (gameDt 0). A battery that cannot
    // cover the frame scales the despin by what it could pay, and an empty one stops it (one line per press). A daughter
    // that relays bills her own pack STEER_W for the steering ('aim').
    let paid = 1;
    const mb = motherBeam();
    if (mb && this._rs && dt > 0 && gameDt > 0) {
      const w = drawW(mb.tier);
      const want = (w / Constants.SHIP_HEAT.W_PER_UNIT_S) * dt;
      const got = this._rs.billWatts(w, dt, 'laser', mb.tier.EFFICIENCY);
      paid = want > 0 ? Math.min(1, got / want) : 1;
      if (paid < 1 - 1e-9 && !this._emptyTold) {
        this._emptyTold = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'MOTHER', text: 'De-spin laser short of power: battery empty.',
          channel: 'CMD', priority: 'warning',
        });
      }
      if (!(paid > 0)) beams = [];
      else if (paid >= 1 - 1e-9) this._emptyTold = false;
    }
    if (!this._firing) this._emptyTold = false;
    if (beams.length && dt > 0 && gameDt > 0) {
      const R = Constants.DESPIN_LASER.RELAY;
      const arms = (this._armManager && this._armManager.arms) || [];
      for (const b of beams) {
        if (b.kind !== 'relay') continue;
        const unit = arms.find((a, i) => a && (a.index ?? i) === b.armIndex);
        if (unit && unit.power && typeof unit.power.bill === 'function') unit.power.bill(R.STEER_W[unit.type] || 0, dt, 'aim');
      }
    }
    const active = beams.length > 0;
    const mAct = active ? motherBeam() : null;
    this._activeTier = mAct ? mAct.baseTier : null;
    this._beamsActed = beams;

    if (!active) {
      if (this._wasFiring) {
        // Achieved = the piece is at or under the net-safe spin when the beam stops (a flat battery, a released key or a lost
        // target with the piece still fast is not).
        const bt = this._beamTarget;
        const achieved = !!bt && (bt.tumbleRate || 0) <= degToRad(Constants.DESPIN_LASER.IN_SPEC_DEG);
        eventBus.emit(Events.ABLATION_END, { armIndex: -1, despinAchieved: achieved });
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

    const alpha = beams.reduce((a, b) => a + b.alpha, 0);
    const before = target.tumbleRate || 0;
    const after = applyDespin(before, alpha, gameDt * paid);
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

    this._drawBeam(target, mAct);
  }

  /**
   * @private update/create the cyan beam line: mother → target, or mother → daughter → target when relayed (no-op without a
   * scene).
   */
  _drawBeam(target, beam = null) {
    if (!this._scene || !this._player) return;
    // BEAM VISUAL origin is the gimbal-mounted telescope muzzle, so the beam emerges from the aperture and tracks
    // sensor articulation. The reach check (planBeams) intentionally stays on getPosition() (hull-center range is the
    // gameplay-correct metric); only the visual origin moves here.
    const motherPos = (this._player && typeof this._player.getLaserAperturePosition === 'function')
      ? this._player.getLaserAperturePosition()
      : (this._player.getPosition ? this._player.getPosition() : null);
    const tPos = this._targetPos();
    if (!motherPos || !tPos) return;
    if (!this._beam) {
      const cfg = Constants.DESPIN_LASER;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));   // up to 3 points
      const mat = new THREE.LineBasicMaterial({
        color: cfg.BEAM_COLOR, transparent: true, opacity: cfg.BEAM_OPACITY,
      });
      this._beam = new THREE.Line(geo, mat);
      this._beam.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // cyan glow beam (§9 Rule 6)
      this._scene.add(this._beam);
    }
    const pts = [motherPos];
    if (beam && beam.kind === 'relay' && beam.path.length === 3) pts.push(beam.path[1]);
    pts.push(tPos);
    const pos = this._beam.geometry.attributes.position;
    pts.forEach((v, i) => pos.setXYZ(i, v.x, v.y, v.z));
    this._beam.geometry.setDrawRange(0, pts.length);
    pos.needsUpdate = true;
    this._beam.visible = true;
  }

  /** @private hide the beam line. */
  _hideBeam() {
    if (this._beam) this._beam.visible = false;
  }
}

export const despinLaser = new DespinLaser();
