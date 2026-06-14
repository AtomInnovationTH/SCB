/**
 * CaptureNet.js — Capture Net Projectile + System Manager
 * ST-9.4 C-6: Config G Capture Net (Sub-Tasks a–e)
 *
 * Implements the full net capture cycle per CAPTURE_NET.md:
 *   a) Net projectile + deploy mechanics (state machine, flight physics)
 *   b) Catch detection + tangle quality (cling probability, frag risk)
 *   c) Reel-in + tension (motor reel, abort/release)
 *   d) Stow + cargo hand-off (inventory depletion, debris transfer)
 *   e) HUD indicators (inventory tracking, reel progress, captured mass)
 *
 * All behavior gated behind FEATURE_FLAGS.CAPTURE_NET (default false).
 *
 * @module entities/CaptureNet
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { BridleRing } from './BridleRing.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;
const FEATURE_FLAGS = Constants.FEATURE_FLAGS;

// ═══════════════════════════════════════════════════════════════════════════
// §1  Pure Functions — Cling Probability + Frag Risk
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the net class spec for a given platform type.
 * @param {'mother'|'weaver'|'spinner'} type
 * @returns {object} Net class constants (LARGE, MEDIUM, or SMALL)
 */
export function getNetClassForType(type) {
  if (type === 'mother')  return CN.LARGE;
  if (type === 'weaver')  return CN.MEDIUM;
  if (type === 'spinner') return CN.SMALL;
  return CN.MEDIUM; // fallback
}

/**
 * Compute cling probability P_cling for a capture attempt.
 * Per CAPTURE_NET.md §3.3:
 *   P_cling = P_base × f_velocity × f_contact × f_roughness × f_spin × f_tension × f_distance
 *
 * @param {object} params
 * @param {number} params.pBase     — base probability for net class + target match (§3.4)
 * @param {number} params.vRel      — relative velocity at contact (m/s)
 * @param {number} params.vOptimal  — optimal wrap velocity (≈ launch speed)
 * @param {number} params.range     — distance from launcher to target (m)
 * @param {number} [params.contactFraction=1]  — mesh contact area / target area
 * @param {number} [params.roughness=1]        — surface roughness (0.4=smooth, 0.7=painted, 1.0=MLI)
 * @param {number} [params.spinFraction=1]     — ω_impact / ω_design
 * @param {number} [params.tensionFraction=1]  — T_tether / T_nominal
 * @param {number} [params.targetTumbleRate]   — target's tumble (rad/s); high tumble penalises cling (CP-2)
 * @returns {number} P_cling ∈ [0, 1]
 */
export function computeClingProbability(params) {
  const {
    pBase,
    vRel,
    vOptimal = 10,
    range = 50,
    contactFraction = 1.0,
    roughness = 1.0,
    spinFraction = 1.0,
    tensionFraction = 1.0,
    targetTumbleRate = null,
  } = params;

  const vRange = 10; // m/s velocity range for clamp
  const fVelocity  = Math.max(0.3, Math.min(1.0, 1.0 - Math.abs(vRel - vOptimal) / vRange));
  const fContact   = Math.min(contactFraction, 1.0);
  // 2026-06-11 tuning: floor the roughness multiplier — smooth surfaces are
  // harder to wrap, but the raw material scale (solar cell 0.2, aluminum 0.4)
  // multiplied a perfect shot down to "feels broken" odds.
  const fRoughness = Math.max(CN.ROUGHNESS_FLOOR ?? 0, roughness);
  const fSpin      = Math.max(0.5, Math.min(1.2, spinFraction));
  const fTension   = Math.max(0.6, Math.min(1.0, tensionFraction));
  // Distance modifier: f_distance = clamp(1.1 - 0.003 × range, 0.85, 1.1)
  const fDistance   = Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));
  // CP-2 target-tumble penalty: a fast-tumbling target sheds the net. f_tumble = 1.0
  // at/below the in-spec spin, ramping down to a floor above it. Omitted (null) ⇒ 1.0,
  // so callers/tests that don't supply tumble are unaffected. The mother de-spin laser
  // lowers targetTumbleRate to restore this factor → "detumble, then net it".
  const fTumble = computeTumbleModifier(targetTumbleRate);

  const raw = pBase * fVelocity * fContact * fRoughness * fSpin * fTension * fDistance * fTumble;
  let p = Math.max(0, Math.min(1, raw)); // clamp to valid probability

  // 2026-06-11 tuning: SURE-SHOT floor. A well-executed shot — close range,
  // target de-tumbled to in-spec (or tumble untracked), nominal launch speed,
  // fresh net spin — succeeds reliably. This is the payoff the game teaches
  // ("close the distance, de-spin [H]"); distant/tumbling/sloppy shots keep
  // the full physics stack, so aim and setup still matter.
  const sureShot = range <= (CN.CLOSE_RANGE ?? 30)
    && fTumble >= 1.0
    && fVelocity >= 0.99
    && spinFraction >= 0.8;
  if (sureShot) {
    p = Math.max(p, Math.min(1, CN.SURE_SHOT_MIN_CLING ?? 0));
  }
  return p;
}

/**
 * CP-2 net-cling tumble modifier. 1.0 when tumble is unknown or at/below the
 * in-spec spin; ramps linearly down to NET_TUMBLE_PENALTY.FLOOR above it.
 * @param {number|null} tumbleRateRad — target tumble in rad/s (null ⇒ no penalty)
 * @returns {number} f_tumble ∈ [FLOOR, 1.0]
 */
export function computeTumbleModifier(tumbleRateRad) {
  if (tumbleRateRad == null) return 1.0;
  const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10, PER_DEG: 0.012, FLOOR: 0.4 };
  const tumbleDeg = Math.abs(tumbleRateRad) * (180 / Math.PI);
  if (tumbleDeg <= P.IN_SPEC_DEG) return 1.0;
  return Math.max(P.FLOOR, 1.0 - (tumbleDeg - P.IN_SPEC_DEG) * P.PER_DEG);
}

/**
 * Compute the distance modifier alone (for HUD pre-fire display).
 * @param {number} range — metres
 * @returns {number} f_distance ∈ [0.85, 1.1]
 */
export function computeDistanceModifier(range) {
  return Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));
}

/**
 * UX-11 #1: effective catch radius with close-range forgiveness.
 * Inside CLOSE_RANGE the net mouth wraps slightly beyond its disc, so the
 * intersection test widens by CATCH_RADIUS_FORGIVENESS. Outside CLOSE_RANGE
 * the geometric radius applies unchanged — aim still matters at distance.
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} range — distance travelled / range to target (metres)
 * @returns {number} effective radius (metres)
 */
export function effectiveCatchRadius(mouthRadius, range) {
  const forgive = (range < CN.CLOSE_RANGE) ? (CN.CATCH_RADIUS_FORGIVENESS || 1.0) : 1.0;
  return mouthRadius * forgive;
}

/**
 * UX-11 #1: lead-aim direction + off-axis angle for the pre-fire readout.
 * Mirrors the lead computation in ArmUnit._updateNettingFSM: aim where the
 * target will be when the net arrives (targetPos + relVel × dist/launchSpeed).
 * All inputs share one unit system (scene units OR metres — consistent).
 *
 * @param {{x,y,z}} armPos — launcher position
 * @param {{x,y,z}} targetPos — target position now
 * @param {{x,y,z}|null} relVel — target velocity relative to launcher (units/s)
 * @param {number} launchSpeed — net speed in the same length units per second
 * @returns {{ dir: {x,y,z}, offAxisDeg: number }} lead direction + angle between
 *   the lead direction and the direct bearing (0 when no lead is needed)
 */
export function computeLeadAim(armPos, targetPos, relVel, launchSpeed) {
  const bx = targetPos.x - armPos.x;
  const by = targetPos.y - armPos.y;
  const bz = targetPos.z - armPos.z;
  const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;

  let ax = targetPos.x, ay = targetPos.y, az = targetPos.z;
  if (relVel && launchSpeed > 1e-12) {
    const tof = bLen / launchSpeed;
    ax += relVel.x * tof;
    ay += relVel.y * tof;
    az += relVel.z * tof;
  }
  const dx = ax - armPos.x, dy = ay - armPos.y, dz = az - armPos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const dir = { x: dx / dLen, y: dy / dLen, z: dz / dLen };

  // Angle between lead dir and direct bearing
  const dot = Math.max(-1, Math.min(1,
    (dir.x * bx + dir.y * by + dir.z * bz) / bLen));
  const offAxisDeg = Math.acos(dot) * (180 / Math.PI);
  return { dir, offAxisDeg };
}

/**
 * Item 4 (2026-06-12): pre-fire net-fit assessment — the SINGLE source for
 * the reticle width/mass advisory, the TargetPanel capture-fit badge, and the
 * ToolRecommender width fork. Pure + Node-safe.
 *
 * Precedence: width (deterministic post-catch failure) > mass (refused at
 * deploy / strain risk) > tumble (recoverable — de-spin first).
 *
 * Phase 2 (capture-feedback overhaul): with ASPECT_CAPTURE on and aspect data
 * present, the width fork becomes orientation-aware:
 *   • TOO_WIDE — even end-on the cross-section (widthM) exceeds the mouth.
 *   • ASPECT   — fits END-ON ONLY (widthM ≤ mouth < presented/length); pass
 *     `approachDir` for the live verdict, omit it for the static one.
 *
 * @param {{sizeMeter?:number, lengthM?:number, widthM?:number, mass?:number,
 *   tumbleRate?:number, type?:string, tumbleAxis?:object, tumbleAngle?:number}|null} target
 * @param {{DIAMETER?:number, MAX_CAPTURE_MASS?:number}|null} netClass
 * @param {{x:number,y:number,z:number}|null} [approachDir] — launcher→target direction
 * @returns {{ fit: 'OK'|'TOO_WIDE'|'TOO_HEAVY'|'DESPIN_FIRST'|'ASPECT', label: string }}
 */
export function assessNetFit(target, netClass, approachDir = null) {
  if (!target || !netClass) return { fit: 'OK', label: 'NET \u2713' };
  const size = target.sizeMeter || 0;
  const mass = target.mass || 0;
  const dia = netClass.DIAMETER || 0;
  const cap = netClass.MAX_CAPTURE_MASS || Infinity;

  const aspectOn = Constants.isFeatureEnabled && Constants.isFeatureEnabled('ASPECT_CAPTURE');
  const lengthM = (target.lengthM != null) ? target.lengthM : size;
  const widthM = (target.widthM != null) ? target.widthM : size;

  if (dia > 0) {
    if (aspectOn && lengthM > widthM) {
      if (widthM > dia) return { fit: 'TOO_WIDE', label: 'TOO WIDE' };  // even end-on
      if (lengthM > dia) {
        // Fits end-on only. With a live approach direction report the CURRENT
        // presentation; statically report the aspect opportunity.
        if (approachDir) {
          const presented = presentedWidthForApproach(target, approachDir);
          if (presented > dia) return { fit: 'ASPECT', label: 'END-ON ONLY' };
          // currently presented end-on → fits; fall through to mass/tumble
        } else {
          return { fit: 'ASPECT', label: 'END-ON ONLY' };
        }
      }
    } else if (size > dia) {
      return { fit: 'TOO_WIDE', label: 'TOO WIDE' };
    }
  }
  if (mass > cap) return { fit: 'TOO_HEAVY', label: 'TOO HEAVY' };
  const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10 };
  const tumbleDeg = (target.tumbleRate != null)
    ? Math.abs(target.tumbleRate) * (180 / Math.PI) : 0;
  if (tumbleDeg > (P.IN_SPEC_DEG ?? 10)) return { fit: 'DESPIN_FIRST', label: 'DE-SPIN FIRST' };
  return { fit: 'OK', label: 'NET \u2713' };
}

// ═══════════════════════════════════════════════════════════════════════════
// §1b  Orientation-based capture geometry (Phase 2 — ASPECT_CAPTURE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Width an elongated body presents to a net approaching at angle θ from its
 * long axis: end-on (θ=0) → widthM; broadside (θ=90°) → lengthM.
 * Pure + Node-safe.
 *
 * @param {number} lengthM — long-axis extent (m)
 * @param {number} widthM — cross-section width (m)
 * @param {number} cosTheta — cos of the angle between long axis and approach dir
 * @returns {number} presented width (m)
 */
export function presentedWidth(lengthM, widthM, cosTheta) {
  const c = Math.max(-1, Math.min(1, cosTheta || 0));
  const sinTheta = Math.sqrt(Math.max(0, 1 - c * c));
  return Math.max(widthM || 0, (lengthM || 0) * sinTheta);
}

/**
 * World-space long axis of a debris: the type's LOCAL long axis rotated by the
 * live tumble orientation quat(tumbleAxis, tumbleAngle) — exactly the rotation
 * DebrisField applies to the mesh (setFromAxisAngle). Rodrigues form, no THREE.
 *
 * @param {{type?:string, tumbleAxis?:{x,y,z}, tumbleAngle?:number}} debris
 * @returns {{x:number,y:number,z:number}} unit long axis (world space)
 */
export function worldLongAxis(debris) {
  const AC = Constants.ASPECT_CAPTURE || {};
  const locals = AC.LONG_AXIS_BY_TYPE || {};
  const v = (debris && locals[debris.type]) || { x: 0, y: 1, z: 0 };
  const k = debris && debris.tumbleAxis;
  const ang = (debris && debris.tumbleAngle) || 0;
  if (!k || ang === 0) return { x: v.x, y: v.y, z: v.z };
  // Rodrigues: v' = v cosθ + (k×v) sinθ + k (k·v)(1−cosθ)
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dot = k.x * v.x + k.y * v.y + k.z * v.z;
  const cx = k.y * v.z - k.z * v.y;
  const cy = k.z * v.x - k.x * v.z;
  const cz = k.x * v.y - k.y * v.x;
  return {
    x: v.x * c + cx * s + k.x * dot * (1 - c),
    y: v.y * c + cy * s + k.y * dot * (1 - c),
    z: v.z * c + cz * s + k.z * dot * (1 - c),
  };
}

/**
 * Live presented width of a debris for a given approach direction.
 * Falls back to the scalar sizeMeter when aspect data is missing (graceful —
 * fragments / legacy saves / catalog rows pre-derivation).
 *
 * @param {object} debris — with lengthM/widthM (else sizeMeter), tumbleAxis/Angle
 * @param {{x:number,y:number,z:number}} approachDir — launcher→target (any length)
 * @returns {number} presented width (m)
 */
export function presentedWidthForApproach(debris, approachDir) {
  if (!debris) return 0;
  const size = debris.sizeMeter || 0;
  const lengthM = (debris.lengthM != null) ? debris.lengthM : size;
  const widthM = (debris.widthM != null) ? debris.widthM : size;
  if (!(lengthM > widthM) || !approachDir) return lengthM;   // symmetric / no data
  const len = Math.sqrt(approachDir.x * approachDir.x
    + approachDir.y * approachDir.y + approachDir.z * approachDir.z);
  if (len < 1e-12) return lengthM;
  const axis = worldLongAxis(debris);
  const cosTheta = Math.abs((axis.x * approachDir.x + axis.y * approachDir.y
    + axis.z * approachDir.z) / len);
  return presentedWidth(lengthM, widthM, cosTheta);
}

/**
 * Compute fragmentation risk based on target fragility and impact KE.
 * Per CAPTURE_NET.md §5.1–§5.4.
 *
 * @param {object} params
 * @param {number} params.netMass       — net mass in kg
 * @param {number} params.vRel          — relative velocity at contact (m/s)
 * @param {number} params.targetFragility — base frag risk for debris class (§5.4, 0–1)
 * @param {number} params.range         — distance (m)
 * @returns {number} frag risk ∈ [0, 1]
 */
export function computeFragRisk(params) {
  const { netMass, vRel, targetFragility = 0.05, range = 50 } = params;
  // Impact kinetic energy: ΔKE = ½ × m_net × v_rel²
  const ke = 0.5 * netMass * vRel * vRel;
  // Reference KE: Medium Net at 10 m/s = 34 J
  const keScale = Math.min(ke / 34, 2.0);
  let risk = targetFragility * keScale;

  // Distance modifier (§3.3 QA Q-4)
  if (range < CN.CLOSE_RANGE) {
    risk *= 0.5;  // halved at close range
  } else if (range > CN.BASELINE_RANGE_MAX) {
    risk *= 1.5;  // increased at edge of envelope
  }

  return Math.max(0, Math.min(1, risk));
}

/**
 * Phase 3b: base fragility for computeFragRisk. Brittleness (per-debris,
 * surfaced by the close-range survey) drives the FRAG chip when no explicit
 * fragility is set — "brittleness drives fragmentation risk".
 * @param {object|null} target
 * @returns {number} base frag risk 0..1
 */
export function effectiveFragility(target) {
  if (!target) return 0.05;
  if (typeof target.fragility === 'number') return target.fragility;
  if (typeof target.brittleness === 'number') return Math.max(0.05, target.brittleness * 0.3);
  return 0.05;
}

/**
 * Phase 3b (capture-feedback overhaul): fragmentation severity tier.
 * Severity = brittleness × KE factor (vRel excess over the optimal wrap
 * speed). Nominal-speed shots on tough targets crack at worst; a hot approach
 * on a brittle body shatters. Pure + deterministic given countRoll.
 *
 * @param {object} params
 * @param {number} [params.brittleness=0.5] — per-debris 0..1 (DebrisField)
 * @param {number} [params.vRel=10] — contact speed (m/s)
 * @param {number} [params.vOptimal=10] — optimal wrap speed (launch speed)
 * @param {number} [params.countRoll=0.5] — 0..1 → fragment count within tier band
 * @returns {{ tier: 'crack'|'breakup'|'shatter', severity: number,
 *             fragmentCount: number, destroyTarget: boolean }}
 */
export function resolveFragSeverity({ brittleness = 0.5, vRel = 10, vOptimal = 10, countRoll = 0.5 } = {}) {
  const FS = Constants.FRAG_SEVERITY || {};
  const keFactor = Math.min(2, Math.max(0.5, vRel / Math.max(1e-6, vOptimal)));
  const severity = Math.max(0, Math.min(1, brittleness)) * (keFactor / 2);
  const tier = severity >= (FS.SHATTER_SEVERITY ?? 0.75) ? 'shatter'
    : severity >= (FS.BREAKUP_SEVERITY ?? 0.45) ? 'breakup'
    : 'crack';
  const band = tier === 'shatter' ? (FS.SHATTER_FRAGS || [8, 12])
    : tier === 'breakup' ? (FS.BREAKUP_FRAGS || [3, 6])
    : (FS.CRACK_FRAGS || [1, 2]);
  const r = Math.max(0, Math.min(1, countRoll));
  const fragmentCount = band[0] + Math.round(r * (band[1] - band[0]));
  return { tier, severity, fragmentCount, destroyTarget: tier !== 'crack' };
}

/**
 * UX-11 #1: map a NET_CATCH_MISS reason to an actionable player-facing line.
 * Returns null only for 'forced' (scripted/test resolves stay silent); unknown
 * reasons fall through to a generic re-line-the-shot message.
 * @param {string} reason — 'timeout'|'tether_limit'|'cling_failed'|'oversize_aspect'|'fragmented'|'forced'|…
 * @returns {string|null}
 */
export function missReasonToText(reason) {
  switch (reason) {
    case 'timeout':
    case 'tether_limit':
      return 'Net overshot — line up the reticle and re-fire. Net reeling back; inventory restored.';
    case 'cling_failed':
      return 'Net grazed it — wrap didn\'t hold. Close the distance or de-spin the target (hold H), then re-fire.';
    case 'oversize_aspect':
      // Phase 2: deterministic broadside bounce — teach the orientation fix.
      return 'Net bounced off broadside — too wide this way. De-spin, then come around end-on so the net swallows it lengthwise.';
    case 'fragmented':
      // Phase 3b: the impact broke the target up — teach the gentle approach.
      return 'Impact broke the target apart — fragments are now tracked. Approach slower on brittle debris (CINCH wraps gentler).';
    case 'forced':
      return null;   // scripted/test resolves stay silent
    default:
      // Phase 2: generic line instead of silent null — a miss should never
      // leave the player guessing.
      return 'Net missed — re-line the shot and fire again. Net reeling back.';
  }
}

/**
 * Auto-recommend capture mode based on target data.
 * Per CAPTURE_NET.md §3.6.
 *
 * @param {object} target — debris with optional .hasSolarPanels, .surfaceRoughness, .vRel
 * @returns {'SLAM_WRAP'|'CINCH'}
 */
export function recommendCaptureMode(target) {
  if (!target) return MODES.SLAM_WRAP;
  if (target.hasSolarPanels)  return MODES.CINCH;
  if ((target.vRel || 0) > 5) return MODES.CINCH;
  if ((target.surfaceRoughness || 1.0) < 0.5) return MODES.CINCH;
  return MODES.SLAM_WRAP;
}


// ═══════════════════════════════════════════════════════════════════════════
// §2  NetProjectile — Per-Net State Machine
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Represents a single net in flight through its full capture cycle.
 *
 * State machine (CAPTURE_NET.md §2.4):
 *   FOLDED → LAUNCHING → SPINNING_UP → FLIGHT →
 *     (slam) CONTACT → SECURE_CHECK → CAPTURED/MISSED → REELING → STOWED
 *     (cinch) BRAKE → ENVELOP → CINCH_CLOSING → SECURE_CHECK → CAPTURED/MISSED → REELING → STOWED
 *     (abort at any active state) → RELEASED
 */
export class NetProjectile {
  /**
   * @param {object} config
   * @param {object} config.netClass       — one of CN.LARGE / CN.MEDIUM / CN.SMALL
   * @param {number} config.armIndex       — daughter arm index (-1 for mother pod)
   * @param {number} [config.podIndex=-1]  — mother pod index (0 or 1, -1 for daughter)
   * @param {object} config.launchPosition — {x, y, z} in metres
   * @param {object} config.launchDirection — normalised {x, y, z}
   * @param {object} [config.targetDebris] — target with .position, .mass, .id
   * @param {string} [config.captureMode]  — 'SLAM_WRAP' or 'CINCH'
   */
  constructor(config) {
    this.netClass       = config.netClass;
    this.armIndex       = config.armIndex;
    this.podIndex       = config.podIndex ?? -1;
    this.launchPosition = { ...config.launchPosition };
    this.launchDirection = { ...config.launchDirection };
    this.targetDebris   = config.targetDebris || null;
    this.captureMode    = config.captureMode || MODES.SLAM_WRAP;

    /** @type {object|null} Reference to source arm for inventory restoration (§3.5) */
    this._sourceArm     = config.sourceArm || null;

    /** @type {boolean} Daughter capture being hauled by the ArmUnit — hold the
     *  net's own reel (bag stays cinched on the debris) until the arm delivers. */
    this._heldByArm     = false;

    // ── Runtime state ──
    this.state         = STATES.LAUNCHING;
    this.stateTimer    = 0;
    this.flightTime    = 0;
    this.distanceTraveled = 0;
    this.position      = { ...this.launchPosition };
    this.speed         = this.netClass.LAUNCH_SPEED;
    this.spinRate      = 0;           // current Hz
    this.tetherPaidOut = 0;           // metres
    this.reelProgress  = 0;           // 0..1
    this.capturedMass  = 0;           // kg of captured debris
    this.tangleQuality = 0;           // 0..1: higher is better wrap
    this.tensionN      = 0;           // current tension in Newtons
    this.isActive      = true;
    this.catchResult   = null;        // 'success' | 'miss' | null

    // Diagnostics (for tests / HUD)
    this._clingRoll        = 0;
    this._clingProbability = 0;
    this._fragRisk         = 0;
    this._presentedWidthM  = null;   // Phase 2: presented width at contact (m)

    // Flag for CaptureNetSystem to detect state changes from forceResolve()
    this._resultProcessed  = false;

    // ── Q2 Ceremony event emission guards (CEREMONY_REDESIGN.md §5.2) ──
    this._ceremonyStartEmitted    = false;
    this._brakeImminentEmitted    = false;
    this._brakeFiredEmitted       = false;
    this._envelopPeakEmitted      = false;
    this._ceremonyCompleteEmitted = false;
    this._lastCinchBucket         = -1;
  }

  // ── Tick ────────────────────────────────────────────────────────────────

  /**
   * Advance the state machine by dt seconds.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    if (!this.isActive) return;

    // Q2 Ceremony: emit start event on first tick.
    // NOTE: emitted BEFORE the scale read below so that CameraSystem's
    // _onNetCeremonyStart handler (synchronous via EventBus) can publish the
    // first beat's timeScale to CeremonyTimeScale before we apply it.
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyStartEmitted) {
      this._ceremonyStartEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_START, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        netClass: this.netClass.CODE,
      });
    }

    // Stage 4 (CEREMONY_REDESIGN.md §5, §6 R1): apply ceremony time-dilation to
    // THIS projectile's internal dt only. World dt (orbital propagation,
    // debris field, conjunctions, station-keep, etc.) is unaffected — the
    // scaling happens here, not at the caller (captureNetSystem.update). When
    // the flag is OFF or no ceremony is active, CeremonyTimeScale.get() === 1.0
    // (short-circuit) and this is a no-op multiply.
    const scale = FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

    this.stateTimer += dt;

    // 2026-05-25 — Q2 visual-drift fix (THE "NET DISAPPEARS" BUG).
    //
    // Only `_updateFlight` updates `this.position` from the arm's current
    // scene position; `_updateBrake/Envelop/CinchClosing/SecureCheck` do NOT.
    // After contact, `net.position` therefore FREEZES at the arm's position
    // at the moment of contact, while the arm itself keeps orbiting at
    // ~7 km/s (LEO). [`CaptureNetVisual.update`](js/ui/CaptureNetVisual.js:484)
    // reads `net.position * M` every frame and places the visual group there,
    // so the visual is locked to a stale world point that drifts off-frame
    // within ~1 s of contact.
    //
    // CameraSystem._computeNetScenePos meanwhile uses `arm.position + launchDir
    // * distanceTraveled * M` (CURRENT arm position), so the camera tracks the
    // arm's co-orbiting frame. Result: camera and visual end up in different
    // reference frames, and the user sees the bag VANISH right when the
    // engulf/cinch should start playing — exactly the user-reported symptom.
    //
    // Fix: keep `this.position` synced to the arm's current scene position
    // during ALL post-FLIGHT states.  Each block below documents WHY:
    //
    //   CONTACT/BRAKE/ENVELOP/CINCH_CLOSING/SECURE_CHECK — visual stays
    //     anchored at the launch-distance point in the arm's co-orbiting
    //     frame (FLIGHT already does this work; running it twice is harmless).
    //
    //   REELING — 2026-05-28 (Item 2 fix): _updateReeling had a misleading
    //     comment claiming it "has its own position logic", but it only
    //     updates reelProgress (a 0→1 scalar), not position.  Result: net
    //     visual froze at the orbital-frame contact point while the arm
    //     co-orbited at 7 km/s, so the user saw the net VANISH the moment
    //     REELING started.  Now we track the arm AND slide the effective
    //     launch distance from `tetherPaidOut → 0` as reelProgress
    //     advances 0→1, so the net visually reels in toward the arm.
    if (this._sourceArm?.position
        && (this.state === STATES.CONTACT
            || this.state === STATES.BRAKE
            || this.state === STATES.ENVELOP
            || this.state === STATES.CINCH_CLOSING
            || this.state === STATES.SECURE_CHECK)) {
      const M_NET = 0.00001;
      const ap = this._sourceArm.position;
      this.position.x = ap.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = ap.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = ap.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    } else if (this._sourceArm?.position && this.state === STATES.REELING) {
      const M_NET = 0.00001;
      // 2026-06-05 (v2 — visual-only, no physics coupling): for a SUCCESSFUL
      // catch, keep the bag locked ONTO the captured debris so the cinched net
      // and its catch never separate while the daughter hauls it home (the
      // user-reported "net doesn't cinch around / bring back the debris" bug).
      // We follow the debris's live scene position — which DebrisField already
      // drives (its orbit until the daughter snaps onto it, then the daughter's
      // position) — and seat the bag apex one mouth-radius BEHIND the debris
      // along the launch axis, so the forward drawstring ring wraps the debris's
      // FAR side (opposite the daughter). This ONLY writes the net's visual
      // position; nothing reads net.position back into the arm/debris/autopilot,
      // so there is no feedback or station-keep coupling.
      const sp = (this.catchResult === 'success') ? this.targetDebris?._scenePosition : null;
      if (sp) {
        const back = this.netClass.DIAMETER / 2;   // mouth radius (m), apex standoff
        this.position.x = sp.x / M_NET - this.launchDirection.x * back;
        this.position.y = sp.y / M_NET - this.launchDirection.y * back;
        this.position.z = sp.z / M_NET - this.launchDirection.z * back;
      } else {
        // Empty net (miss) — reel the bag back to the arm. Effective launch
        // distance shrinks from `tetherPaidOut` (contact distance) toward 0 as
        // `reelProgress` advances 0→1; at progress=1 the net rendezvous with the
        // arm.
        const ap = this._sourceArm.position;
        const eff = this.tetherPaidOut * Math.max(0, 1 - this.reelProgress);
        this.position.x = ap.x / M_NET + this.launchDirection.x * eff;
        this.position.y = ap.y / M_NET + this.launchDirection.y * eff;
        this.position.z = ap.z / M_NET + this.launchDirection.z * eff;
      }
    }

    switch (this.state) {
      case STATES.LAUNCHING:     this._updateLaunching(dt);   break;
      case STATES.SPINNING_UP:   this._updateSpinningUp(dt);  break;
      case STATES.FLIGHT:        this._updateFlight(dt);      break;
      case STATES.CONTACT:       this._updateContact(dt);     break;
      case STATES.BRAKE:         this._updateBrake(dt);       break;
      case STATES.ENVELOP:       this._updateEnvelop(dt);     break;
      case STATES.CINCH_CLOSING: this._updateCinchClosing(dt); break;
      case STATES.SECURE_CHECK:  this._updateSecureCheck(dt); break;
      case STATES.REELING:       this._updateReeling(dt);     break;
      // Terminal states — no tick
      case STATES.CAPTURED:
      case STATES.MISSED:
      case STATES.STOWED:
      case STATES.RELEASED:
      case STATES.FOLDED:
        break;
    }
  }

  // ── State transitions ──────────────────────────────────────────────────

  /** @private */
  _transitionTo(newState) {
    this.state = newState;
    this.stateTimer = 0;
  }

  /** Phase 1: Crossbow release (0.15 s) */
  _updateLaunching(dt) {
    if (this.stateTimer >= CN.CAST_WINDUP) {
      this._transitionTo(STATES.SPINNING_UP);
    }
  }

  /** Phase 2: Yo-yo despin spin-up (0.5 s) */
  _updateSpinningUp(dt) {
    // Real yo-yo despin (Item 2): the folded canister starts spinning FAST and
    // DESPINS as the rim weights deploy and the bag blossoms (L = Iω conserved,
    // I ∝ r²). Start at SPIN_HZ × SPIN_FOLDED_MULT and decay toward SPIN_HZ as the
    // mouth opens. The canister visibly "unwinds fast, blossoms, settles".
    const foldedMult = CN.SPIN_FOLDED_MULT != null ? CN.SPIN_FOLDED_MULT : 1.0;
    const fraction = Math.min(this.stateTimer / CN.SPIN_UP_TIME, 1);
    const startHz = this.netClass.SPIN_HZ * foldedMult;
    // Lerp from the folded (fast) spin down to the settled design spin.
    this.spinRate = startHz + (this.netClass.SPIN_HZ - startHz) * fraction;
    if (this.stateTimer >= CN.SPIN_UP_TIME) {
      this.spinRate = this.netClass.SPIN_HZ;
      this._transitionTo(STATES.FLIGHT);
    }
  }

  /** Phase 3: Tether pay-out + target intersection check */
  _updateFlight(dt) {
    this.flightTime += dt;
    const dist = this.speed * dt;
    this.distanceTraveled += dist;
    this.tetherPaidOut += dist;

    // Slow in-flight spin decay (Item 2): mesh flexing + rim drag bleed angular
    // momentum, so long shots arrive with spinFraction < 1 → live f_spin penalty
    // in computeClingProbability ("fire inside the envelope or the wrap is weak").
    const decayPerS = CN.SPIN_DECAY_PER_S != null ? CN.SPIN_DECAY_PER_S : 0;
    if (decayPerS > 0 && this.spinRate > 0) {
      this.spinRate = Math.max(0, this.spinRate - this.netClass.SPIN_HZ * decayPerS * dt);
    }

    // Update position along launch direction (metres, for CaptureNetVisual + test path)
    this.position.x += this.launchDirection.x * dist;
    this.position.y += this.launchDirection.y * dist;
    this.position.z += this.launchDirection.z * dist;

    // PROD path: also update position from arm's current co-orbiting frame
    // so CaptureNetVisual renders the net near the arm, not 7 km behind.
    const M_NET = 0.00001;  // 1 m in scene units (matches ArmUnit.M)
    if (this._sourceArm?.position) {
      const ap = this._sourceArm.position;  // THREE.Vector3, scene units, updated each frame
      this.position.x = ap.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = ap.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = ap.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    }

    // Check max flight time (§2.4 phase 3)
    if (this.flightTime >= CN.MAX_FLIGHT_TIME) {
      this._miss('timeout');
      return;
    }

    // Check tether limit
    if (this.tetherPaidOut >= this.netClass.TETHER_MAX) {
      this._miss('tether_limit');
      return;
    }

    // Check range to target (intersection = distance < net radius)
    // PROD: use arm-relative scene position (co-orbiting reference frame).
    // TEST: use absolute metres (mock .position, no _sourceArm).
    if (this.targetDebris) {
      const sp = this.targetDebris._scenePosition;
      const ap = this._sourceArm?.position;
      if (sp && ap) {
        // Net scene pos = arm scene pos + flight displacement (scene units)
        const netX = ap.x + this.launchDirection.x * this.distanceTraveled * M_NET;
        const netY = ap.y + this.launchDirection.y * this.distanceTraveled * M_NET;
        const netZ = ap.z + this.launchDirection.z * this.distanceTraveled * M_NET;
        const dx = sp.x - netX;
        const dy = sp.y - netY;
        const dz = sp.z - netZ;
        const distScene = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // UX-11 #1: close-range forgiveness — near-grazes inside CLOSE_RANGE count.
        const radiusScene = effectiveCatchRadius(
          this.netClass.DIAMETER / 2, this.distanceTraveled
        ) * M_NET;
        // Q2 Ceremony: brake-imminent lookahead (cinch path only)
        if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeImminentEmitted
            && this.captureMode === MODES.CINCH) {
          const brakeThreshScene = (this.speed * 0.3 + this.netClass.DIAMETER / 2) * M_NET;
          if (distScene <= brakeThreshScene) {
            this._brakeImminentEmitted = true;
            eventBus.emit(Events.NET_BRAKE_IMMINENT, {
              armIndex: this.armIndex,
              podIndex: this.podIndex,
              tMinus: 0.3,
            });
          }
        }
        if (distScene <= radiusScene) {
          if (this.captureMode === MODES.CINCH) {
            this._transitionTo(STATES.BRAKE);
          } else {
            this._transitionTo(STATES.CONTACT);
          }
        }
      } else {
        // Test fallback: .position in metres, no orbital motion
        const tp = this.targetDebris.position || this.targetDebris;
        const dx = (tp.x || 0) - this.position.x;
        const dy = (tp.y || 0) - this.position.y;
        const dz = (tp.z || 0) - this.position.z;
        const distToTarget = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Q2 Ceremony: brake-imminent lookahead (cinch path only)
        if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeImminentEmitted
            && this.captureMode === MODES.CINCH) {
          const brakeThresh = this.speed * 0.3 + this.netClass.DIAMETER / 2;
          if (distToTarget <= brakeThresh) {
            this._brakeImminentEmitted = true;
            eventBus.emit(Events.NET_BRAKE_IMMINENT, {
              armIndex: this.armIndex,
              podIndex: this.podIndex,
              tMinus: 0.3,
            });
          }
        }
        if (distToTarget <= effectiveCatchRadius(this.netClass.DIAMETER / 2, this.distanceTraveled)) {
          if (this.captureMode === MODES.CINCH) {
            this._transitionTo(STATES.BRAKE);
          } else {
            this._transitionTo(STATES.CONTACT);
          }
        }
      }
    }
  }

  /** Phase 5a: Slam-wrap contact */
  _updateContact(dt) {
    if (this.stateTimer >= CN.SLAM_CONTACT_TIME) {
      this._transitionTo(STATES.SECURE_CHECK);
    }
  }

  /** Phase 5b-A: Tether brake (cinch path) */
  _updateBrake(dt) {
    // Q2 Ceremony: emit brake-fired on state entry
    if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeFiredEmitted) {
      this._brakeFiredEmitted = true;
      eventBus.emit(Events.NET_BRAKE_FIRED, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        tetherTensionN: this.tensionN,
      });
    }
    if (this.stateTimer >= CN.BRAKE_TIME) {
      this._transitionTo(STATES.ENVELOP);
    }
  }

  /** Phase 5b-B: Rim weights sweep past target */
  _updateEnvelop(dt) {
    // Q2 Ceremony: emit envelop peak at 50% of ENVELOP_TIME
    if (FEATURE_FLAGS.NET_CEREMONY && !this._envelopPeakEmitted
        && this.stateTimer >= CN.ENVELOP_TIME * 0.5) {
      this._envelopPeakEmitted = true;
      eventBus.emit(Events.NET_ENVELOP_PEAK, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
      });
    }
    if (this.stateTimer >= CN.ENVELOP_TIME) {
      this._transitionTo(STATES.CINCH_CLOSING);
    }
  }

  /** Phase 5b-C: Drawstring cinch closing */
  _updateCinchClosing(dt) {
    // Q2 Ceremony: emit cinch progress at discrete 10% thresholds
    if (FEATURE_FLAGS.NET_CEREMONY) {
      const fraction = Math.min(this.stateTimer / CN.CINCH_CLOSE_TIME, 1);
      const bucket = Math.floor(fraction * 10);
      if (bucket !== this._lastCinchBucket) {
        this._lastCinchBucket = bucket;
        eventBus.emit(Events.NET_CINCH_PROGRESS, {
          armIndex: this.armIndex,
          podIndex: this.podIndex,
          fraction,
        });
      }
    }
    if (this.stateTimer >= CN.CINCH_CLOSE_TIME) {
      this._transitionTo(STATES.SECURE_CHECK);
    }
  }

  /** Phase 6: Secure check — resolve capture probability */
  _updateSecureCheck(dt) {
    if (this.stateTimer >= CN.SECURE_CHECK_TIME) {
      this._resolveCatch();
    }
  }

  /** Phase 7: Reel-in — motor pulls net+debris back */
  _updateReeling(dt) {
    // ── Held daughter catch: keep the bag cinched on the debris until the arm
    // delivers it. The net's own reel is short (tetherPaidOut/REEL_SPEED) and
    // would otherwise STOW — removing the bag visual — long before the daughter
    // finishes hauling, so the netted catch appeared to vanish mid-haul. The
    // position-follow above keeps the bag locked onto the debris while we hold;
    // we release the hold (and stow) once the catch is no longer pinned to a
    // captor: docked (debris removed/alive=false, pin cleared), net failure
    // (pin cleared), or tether snap's bounded drift (pin finally cleared).
    if (this._heldByArm) {
      const d = this.targetDebris;
      const stillHauling = !!(d && d.alive !== false && d._capturedByArm);
      if (stillHauling) {
        this.tensionN = 1.0 + this.capturedMass * 0.1;
        return;                       // hold: no completion while the arm hauls
      }
      this._heldByArm = false;        // delivered / lost → stow promptly
      this.reelProgress = 1.0;
    }

    if (this.tetherPaidOut <= 0) {
      // Edge case: net fired but didn't travel
      this.reelProgress = 1.0;
    } else {
      const reelRate = this.netClass.REEL_SPEED / Math.max(1, this.tetherPaidOut);
      this.reelProgress = Math.min(1.0, this.reelProgress + reelRate * dt);
    }

    // Tension: base + mass factor (simplified — real model in ST-9.5)
    this.tensionN = 1.0 + this.capturedMass * 0.1;

    if (this.reelProgress >= 1.0) {
      this._transitionTo(STATES.STOWED);
      this.isActive = false;
      eventBus.emit(Events.NET_REEL_COMPLETED, {
        armIndex:     this.armIndex,
        podIndex:     this.podIndex,
        capturedMass: this.capturedMass,
        debrisId:     this.targetDebris?.id,
      });
    }
  }

  // ── Catch resolution ───────────────────────────────────────────────────

  /** @private Roll cling probability and resolve capture */
  _resolveCatch() {
    // Phase 2 (ASPECT_CAPTURE): presented width at CONTACT — the moment the
    // mouth meets the body decides whether it can swallow it. Broadside on an
    // oversize presentation is a deterministic bounce, not a bad roll.
    if (Constants.isFeatureEnabled('ASPECT_CAPTURE') && this.targetDebris) {
      this._presentedWidthM = presentedWidthForApproach(this.targetDebris, this.launchDirection);
      const dia = this.netClass.DIAMETER || 0;
      if (dia > 0 && this._presentedWidthM > dia) {
        this._miss('oversize_aspect');
        return;
      }
    }

    // Determine P_base from capture mode
    const pBase = this.captureMode === MODES.CINCH
      ? CN.CINCH_P_BASE.RIGHT_HARDER   // 0.93 — default for cinch
      : CN.SLAM_P_BASE.RIGHT_HARDER;   // 0.80 — default for slam

    const params = {
      pBase,
      vRel:            this.speed,
      vOptimal:        this.netClass.LAUNCH_SPEED,
      range:           this.distanceTraveled,
      spinFraction:    this.spinRate / this.netClass.SPIN_HZ,
      tensionFraction: 1.0,
      contactFraction: 1.0,
      roughness:       this.targetDebris?.surfaceRoughness || 1.0,
      // CP-2: a high-tumble target sheds the net — detumble it first (mother laser).
      targetTumbleRate: Constants.isFeatureEnabled('LASER_DESPIN')
        ? (this.targetDebris?.tumbleRate ?? null)
        : null,
    };

    this._clingProbability = computeClingProbability(params);
    this._clingRoll = Math.random();

    // Phase 3b (capture-feedback overhaul): the frag risk is now ROLLED, not
    // just computed. The consequence chain was already built — handleFragmentation
    // (mercy rule) → NET_FRAGMENTATION; INTERACTION_FRAGMENTATION → KesslerSystem
    // counts it and DebrisField sheds/replaces the body.
    this._fragRisk = computeFragRisk({
      netMass:         this.netClass.MASS,
      vRel:            this.speed,
      targetFragility: effectiveFragility(this.targetDebris),
      range:           this.distanceTraveled,
    });
    const fragRoll = (this._fragRollOverride != null) ? this._fragRollOverride : Math.random();
    if (this.targetDebris && fragRoll <= this._fragRisk) {
      const sev = resolveFragSeverity({
        brittleness: this.targetDebris.brittleness ?? 0.5,
        vRel: this.speed,
        vOptimal: this.netClass.LAUNCH_SPEED,
        countRoll: (this._fragCountRollOverride != null) ? this._fragCountRollOverride : Math.random(),
      });
      this._fragSeverity = sev.tier;
      captureNetSystem.handleFragmentation(this.targetDebris.id, sev.fragmentCount);
      eventBus.emit(Events.INTERACTION_FRAGMENTATION, {
        debrisId:     this.targetDebris.id,
        fragments:    sev.fragmentCount,
        severity:     sev.tier,
        destroyTarget: sev.destroyTarget,
        mass:         this.targetDebris.mass || 1,
        source:       'net_contact',
      });
      if (sev.destroyTarget) {
        // Breakup / shatter: the body the net wrapped no longer exists.
        this._miss('fragmented');
        return;
      }
      // Crack: 1-2 frags shed, the capture itself continues to the cling roll.
    }

    if (this._clingRoll <= this._clingProbability) {
      this._captureSuccess();
    } else {
      this._miss('cling_failed');
    }
  }

  /** @private Transition to CAPTURED + emit event */
  _captureSuccess() {
    this.catchResult = 'success';
    this.capturedMass = this.targetDebris?.mass || 1.0;
    this.tangleQuality = this._clingProbability;
    this._transitionTo(STATES.CAPTURED);

    eventBus.emit(Events.NET_CATCH_SUCCESS, {
      armIndex:      this.armIndex,
      podIndex:      this.podIndex,
      debrisId:      this.targetDebris?.id,
      tangleQuality: this.tangleQuality,
      capturedMass:  this.capturedMass,
      mode:          this.captureMode,
    });

    // Q2 Ceremony: emit ceremony complete
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyCompleteEmitted) {
      this._ceremonyCompleteEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        mode:     this.captureMode,
        success:  true,
      });
    }
  }

  /** @private Transition to MISSED + emit event */
  _miss(reason) {
    this.catchResult = 'miss';
    this._transitionTo(STATES.MISSED);

    eventBus.emit(Events.NET_CATCH_MISS, {
      armIndex:    this.armIndex,
      podIndex:    this.podIndex,
      debrisId:    this.targetDebris?.id,
      probability: this._clingProbability,
      reason,
    });

    // Q2 Ceremony: emit ceremony complete
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyCompleteEmitted) {
      this._ceremonyCompleteEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        mode:     this.captureMode,
        success:  false,
      });
    }
  }

  // ── Player Commands ────────────────────────────────────────────────────

  /**
   * Start reel-in (player command after catch or miss).
   * @returns {boolean} Whether reel started
   */
  startReel() {
    if (this.state !== STATES.CAPTURED && this.state !== STATES.MISSED) return false;
    this._transitionTo(STATES.REELING);
    this.reelProgress = 0;

    eventBus.emit(Events.NET_REEL_STARTED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      hasCatch: this.catchResult === 'success',
    });
    return true;
  }

  /**
   * Release / abort: let debris and net go. Net inventory is consumed.
   * @returns {boolean} Whether release occurred
   */
  release() {
    if (this.state !== STATES.CAPTURED &&
        this.state !== STATES.REELING &&
        this.state !== STATES.FLIGHT) return false;

    this._transitionTo(STATES.RELEASED);
    this.capturedMass = 0;
    this.isActive = false;

    eventBus.emit(Events.NET_RELEASED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      debrisId: this.targetDebris?.id,
    });
    return true;
  }

  /**
   * Force the net into a deterministic result (for testing / scripted events).
   * Bypasses the random roll.
   *
   * @param {boolean} success — true for catch, false for miss
   * @param {number} [probability=1.0] — cling probability to report
   */
  forceResolve(success, probability = 1.0) {
    this._clingProbability = probability;
    this._clingRoll = success ? 0 : 1;
    if (success) {
      this._captureSuccess();
    } else {
      this._miss('forced');
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §3  CaptureNetSystem — Fleet-Wide Net Manager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manages all active net projectiles, mother pod inventory, cooldowns,
 * and provides query APIs for HUD (§ST-9.4e).
 *
 * Singleton, gated behind FEATURE_FLAGS.CAPTURE_NET.
 */
export class CaptureNetSystem {
  constructor() {
    /** @type {NetProjectile[]} Active nets in flight / capture / reel */
    this.activeNets = [];

    // Mother Large Net pod inventory: [podA_count, podB_count]
    this._motherPodInventory = [0, 0];
    this._motherPodMax       = [0, 0];

    /** @type {Map<string, number>} Cooldown timers keyed by 'pod_0', 'arm_3', etc. */
    this._cooldownTimers = new Map();

    this._initialized = false;

    // First-fragmentation mercy rule (§5.7)
    this._playerHasFragmented = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise inventory to Dyneema Y0 defaults.
   * Called once at game start / after load.
   */
  init() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._motherPodInventory = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
    this._motherPodMax       = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
    this._initialized = true;

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
    });
  }

  /**
   * Per-frame update: advance all active net projectiles + cooldowns.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    // Tick cooldowns
    for (const [key, remaining] of this._cooldownTimers.entries()) {
      const next = remaining - dt;
      if (next <= 0) {
        this._cooldownTimers.delete(key);
      } else {
        this._cooldownTimers.set(key, next);
      }
    }

    // Tick active nets
    for (let i = this.activeNets.length - 1; i >= 0; i--) {
      const net = this.activeNets[i];
      const prevState = net.state;

      net.update(dt);

      // Auto-start reel on capture/miss — detects both in-loop transitions
      // AND external state changes (e.g. forceResolve called between updates)
      const needsAutoReel = (net.state === STATES.CAPTURED || net.state === STATES.MISSED)
        && !net._resultProcessed;
      if (needsAutoReel) {
        net._resultProcessed = true;
        const cooldown = net.catchResult === 'success'
          ? CN.COOLDOWN_CATCH
          : CN.COOLDOWN_MISS;
        const key = net.armIndex >= 0 ? `arm_${net.armIndex}` : `pod_${net.podIndex}`;
        this._cooldownTimers.set(key, cooldown);

        // Daughter captures are hauled home by the ArmUnit, not reeled by the
        // net itself. Hold the net's reel (bag stays cinched on the debris) so
        // the netted catch doesn't visually vanish mid-haul; _updateReeling
        // auto-releases the hold once the daughter delivers (debris unpinned).
        // Mother-pod captures (podIndex≥0) and misses reel/stow normally.
        if (net.armIndex >= 0 && net.catchResult === 'success') {
          net._heldByArm = true;
        }

        // Auto-start reel (player can still release / override)
        net.startReel();
      }

      // Remove terminal nets + handle inventory / cargo consequences
      if (!net.isActive || net.state === STATES.STOWED || net.state === STATES.RELEASED) {
        // §3.5: Net is NOT consumed on miss — restore inventory when empty net reels back
        if (net.state === STATES.STOWED && net.catchResult === 'miss') {
          this._restoreNetInventory(net);
        }

        // ST-9.4d: Cargo hand-off — successful capture reeled to platform
        if (net.state === STATES.STOWED && net.catchResult === 'success' && net.capturedMass > 0) {
          // ST-9.7 C-8: Route through bridle ring if both flags enabled
          if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.CAPTURE_NET && net.armIndex >= 0) {
            const freePoint = BridleRing.findFreePoint(net.armIndex);
            if (freePoint) {
              const captureId = net.targetDebris?.id || `capture-${Date.now()}`;
              BridleRing.attach(net.armIndex, freePoint, captureId, net.capturedMass);
              // Brief intermediary — immediately release to cargo system
              BridleRing.detach(net.armIndex, freePoint);
            }
          }

          eventBus.emit(Events.CARGO_STORE, {
            debrisId:     net.targetDebris?.id,
            mass:         net.capturedMass,
            source:       net.armIndex >= 0 ? 'daughter' : 'mother',
            armIndex:     net.armIndex,
            podIndex:     net.podIndex,
            netCapture:   true,
          });
        }

        this.activeNets.splice(i, 1);
      }
    }
  }

  /**
   * Restore net inventory after a miss (§3.5: net is reusable, not consumed).
   * @private
   * @param {NetProjectile} net
   */
  _restoreNetInventory(net) {
    if (net.podIndex >= 0) {
      // Mother pod — increment pod inventory
      if (this._motherPodInventory[net.podIndex] < this._motherPodMax[net.podIndex]) {
        this._motherPodInventory[net.podIndex]++;
        eventBus.emit(Events.NET_INVENTORY_CHANGED, {
          source: 'mother',
          podInventory: [...this._motherPodInventory],
        });
      }
    } else if (net._sourceArm && typeof net._sourceArm.setNetInventory === 'function') {
      // Daughter arm — restore via arm reference
      const current = (typeof net._sourceArm.getNetInventory === 'function')
        ? net._sourceArm.getNetInventory() : 0;
      net._sourceArm.setNetInventory(current + 1);
      eventBus.emit(Events.NET_INVENTORY_CHANGED, {
        source: 'daughter',
        armIndex: net.armIndex,
        remaining: net._sourceArm.getNetInventory(),
      });
    }
  }

  /**
   * Reset to clean state (game reset / new session).
   */
  reset() {
    this.activeNets = [];
    this._cooldownTimers.clear();
    this._motherPodInventory = [0, 0];
    this._motherPodMax       = [0, 0];
    this._initialized = false;
    this._playerHasFragmented = false;
  }

  // ── Fire Commands ──────────────────────────────────────────────────────

  /**
   * Fire a Large Net from a mother pod.
   *
   * @param {number} podIndex   — 0 (Pod A) or 1 (Pod B)
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object (with .position, .mass, .id)
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH' (auto-recommend if omitted)
   * @returns {NetProjectile|null} The created projectile, or null on failure
   */
  fireMotherNet(podIndex, launchPos, launchDir, target, mode) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;
    if (podIndex < 0 || podIndex > 1) return null;
    // Phase 0.3 (capture-feedback overhaul): refusals speak — mirror the
    // LassoSystem denial-comms style so the player knows WHY nothing fired
    // and what fixes it (wait N s / restock at shop [B]).
    if (this._motherPodInventory[podIndex] <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Mother net magazine empty — restock at shop [B]',
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'warning',
      });
      return null;
    }
    if (this._cooldownTimers.has(`pod_${podIndex}`)) {
      const secs = this._cooldownTimers.get(`pod_${podIndex}`) || 0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Mother net reloading — ${Math.ceil(secs)}s`,
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'info',
      });
      return null;
    }

    // Deplete inventory
    this._motherPodInventory[podIndex]--;

    // CEREMONY_REDESIGN §4 / NET_CEREMONY alignment (2026-05-25):
    // When NET_CEREMONY is on, the ceremony's beats 5–6 (BRAKE_ENVELOP, CINCH)
    // assume the CINCH FSM path. SLAM_WRAP physics skips ENVELOP and CINCH_CLOSING
    // entirely (CONTACT → SECURE_CHECK → CAPTURED in <1 s game-time), so the
    // visual renders no engulf or cinch animation during those beats — confirmed
    // by browser log ([NET_CINEMATIC] CEREMONY_START captureMode=SLAM_WRAP) and
    // by inspecting [`CaptureNet._updateContact`](js/entities/CaptureNet.js:387).
    // Force CINCH when the auto-recommender would otherwise pick SLAM_WRAP, so
    // the FSM traverses BRAKE→ENVELOP→CINCH_CLOSING and the ceremony visual
    // matches the camera beats. Explicit `mode` argument is still honoured
    // (preserves test paths and future explicit-mode UI). CINCH_P_BASE is
    // ≥ SLAM_P_BASE in all pairings, so no score regression.
    let resolvedMode = mode || recommendCaptureMode(target);
    if (!mode && Constants.FEATURE_FLAGS.NET_CEREMONY) {
      resolvedMode = MODES.CINCH;
    }

    const net = new NetProjectile({
      netClass:       CN.LARGE,
      armIndex:       -1,
      podIndex,
      launchPosition: launchPos,
      launchDirection: launchDir,
      targetDebris:   target,
      captureMode:    resolvedMode,
    });

    this.activeNets.push(net);

    eventBus.emit(Events.NET_FIRED, {
      source:   'mother',
      podIndex,
      netClass: 'LARGE',
      remaining: this._motherPodInventory[podIndex],
    });

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
    });

    return net;
  }

  /**
   * Fire a net from a daughter arm (Medium for weaver, Small for spinner).
   *
   * @param {object} arm        — ArmUnit instance (must have getNetInventory, decrementNetInventory)
   * @param {number} armIndex   — arm array index
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH'
   * @returns {NetProjectile|null}
   */
  fireDaughterNet(arm, armIndex, launchPos, launchDir, target, mode) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;

    // Deploy state gate (C-4 integration)
    if (Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      if (typeof arm.getDeployState === 'function' && arm.getDeployState() !== 'DEPLOYED') {
        return null;
      }
    }

    // Net inventory gate
    const inventory = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;
    if (inventory <= 0) return null;

    // Cooldown gate
    if (this._cooldownTimers.has(`arm_${armIndex}`)) return null;

    // Decrement inventory
    if (typeof arm.decrementNetInventory === 'function') {
      arm.decrementNetInventory();
    }

    const netClass = (arm.config?.type === 'weaver') ? CN.MEDIUM : CN.SMALL;

    // CEREMONY_REDESIGN §4 / NET_CEREMONY alignment (2026-05-25): see fireMotherNet
    // above for full rationale. Force CINCH so beats 5–6 visuals (ENVELOP, CINCH_CLOSING)
    // actually render during the ceremony — SLAM_WRAP path skips those states.
    let resolvedMode = mode || recommendCaptureMode(target);
    if (!mode && Constants.FEATURE_FLAGS.NET_CEREMONY) {
      resolvedMode = MODES.CINCH;
    }

    const net = new NetProjectile({
      netClass,
      armIndex,
      podIndex: -1,
      launchPosition: launchPos,
      launchDirection: launchDir,
      targetDebris:   target,
      captureMode:    resolvedMode,
      sourceArm:      arm,           // §3.5: retained for inventory restoration on miss
    });

    this.activeNets.push(net);

    const remaining = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;

    eventBus.emit(Events.NET_FIRED, {
      source:   'daughter',
      armIndex,
      netClass: netClass === CN.MEDIUM ? 'MEDIUM' : 'SMALL',
      remaining,
    });

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex,
      remaining,
    });

    return net;
  }

  // ── Queries (ST-9.4e — HUD) ───────────────────────────────────────────

  /** Total mother pod net count (both pods combined). */
  getMotherNetCount() {
    return this._motherPodInventory[0] + this._motherPodInventory[1];
  }

  /** Inventory for a specific mother pod. */
  getMotherPodInventory(podIndex) {
    return this._motherPodInventory[podIndex] || 0;
  }

  /** Max capacity for a specific mother pod. */
  getMotherPodMax(podIndex) {
    return this._motherPodMax[podIndex] || 0;
  }

  /** Set mother pod inventory (persistence restore). */
  setMotherPodInventory(counts) {
    if (Array.isArray(counts)) {
      this._motherPodInventory = [counts[0] || 0, counts[1] || 0];
    }
  }

  /** Get the active net projectile for a given arm index (if any). */
  getActiveNetForArm(armIndex) {
    return this.activeNets.find(n => n.armIndex === armIndex) || null;
  }

  /** Get the active net projectile for a given mother pod (if any). */
  getActiveNetForPod(podIndex) {
    return this.activeNets.find(n => n.podIndex === podIndex) || null;
  }

  /**
   * Get captured mass currently on an arm's net (for CoM integration).
   * Returns netClass mass + debris mass when a net is captured/reeling.
   * @param {number} armIndex
   * @returns {number} mass in kg
   */
  getCapturedNetMass(armIndex) {
    const net = this.getActiveNetForArm(armIndex);
    if (!net) return 0;
    if (net.state === STATES.CAPTURED || net.state === STATES.REELING) {
      return net.capturedMass + (net.netClass.MASS || 0);
    }
    return 0;
  }

  /**
   * Check if an arm/pod is in cooldown.
   * @param {'arm'|'pod'} type
   * @param {number} index
   * @returns {number} remaining cooldown seconds (0 = ready)
   */
  getCooldown(type, index) {
    return this._cooldownTimers.get(`${type}_${index}`) || 0;
  }

  // ── Mercy Rule (§5.7) ─────────────────────────────────────────────────

  /** Whether the player has ever caused fragmentation. */
  get playerHasFragmented() { return this._playerHasFragmented; }
  set playerHasFragmented(v) { this._playerHasFragmented = !!v; }

  /**
   * Process a fragmentation event and apply (or waive) consequences.
   * Returns true if mercy rule was applied (first-time waiver).
   *
   * @param {string} debrisId
   * @param {number} fragmentCount
   * @returns {boolean} mercyApplied
   */
  handleFragmentation(debrisId, fragmentCount) {
    const mercyApplied = CN.FRAG_MERCY_FIRST_FREE && !this._playerHasFragmented;
    this._playerHasFragmented = true;

    // Phase 3b: apply the §5.5 credit penalty (waived on the first-time mercy).
    if (!mercyApplied && (CN.FRAG_CREDIT_PENALTY || 0) > 0 && fragmentCount > 0) {
      eventBus.emit(Events.SCORING_AWARD, {
        points: -(CN.FRAG_CREDIT_PENALTY * fragmentCount),
        reason: 'Fragmentation penalty',
      });
    }

    eventBus.emit(Events.NET_FRAGMENTATION, {
      debrisId,
      fragmentCount,
      mercyApplied,
    });

    return mercyApplied;
  }

  // ── Persistence (ST-9.4d — inventory round-trip) ──────────────────────

  /**
   * Get serialisable state for PersistenceManager.
   * @returns {object}
   */
  getState() {
    return {
      motherPodInventory: [...this._motherPodInventory],
      playerHasFragmented: this._playerHasFragmented,
    };
  }

  /**
   * Restore state from PersistenceManager.
   * @param {object} state
   */
  restoreState(state) {
    if (!state) return;
    if (Array.isArray(state.motherPodInventory)) {
      this._motherPodInventory = [...state.motherPodInventory];
    }
    if (typeof state.playerHasFragmented === 'boolean') {
      this._playerHasFragmented = state.playerHasFragmented;
    }
    this._initialized = true;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §4  Singleton Export
// ═══════════════════════════════════════════════════════════════════════════

/** Singleton CaptureNetSystem instance. */
export const captureNetSystem = new CaptureNetSystem();
export default captureNetSystem;
