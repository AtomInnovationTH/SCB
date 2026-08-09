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
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';
import { cartesianToKeplerian, orbitToSceneCartesianInto } from './OrbitalMechanics.js';
import { strutLocalDirection } from './ArmDockBasis.js';
import * as THREE from 'three';

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;
const FEATURE_FLAGS = Constants.FEATURE_FLAGS;

// Module-level scratch objects for the mother reel/berth per-frame math —
// the reel/berth path must not allocate per frame (plan §13: use the Into
// accessors and scratch vectors).
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _v3g = new THREE.Vector3();
const _q0  = new THREE.Quaternion();
const _q1  = new THREE.Quaternion();
// Tug scratch (Phase B §9) — catch/ship velocity sampling at CAPTURED.
const _tugScratchPos = { x: 0, y: 0, z: 0 };
const _tugScratchVel = { x: 0, y: 0, z: 0 };

/** C1: base capture-tension readout (N) — one source for the three former
 *  identical `1.0 + capturedMass × 0.1` sites. HUD-facing garnish only. */
function baseCaptureTensionN(capturedMass) {
  return 1.0 + capturedMass * 0.1;
}

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
 * Single source of truth for "how far can this net class reach" (metres).
 * Reach is tether-limited AND flight-time-limited: the projectile misses with
 * 'timeout' at MAX_FLIGHT_TIME (per-class override, else the shared default)
 * and with 'tether_limit' at TETHER_MAX, whichever comes first
 * (NetProjectile._updateFlight). Used by the InputManager refusal, ToolOdds
 * and DockingReticle so all three agree on the same number.
 * @param {object} netClass — one of CN.LARGE / CN.MEDIUM / CN.SMALL
 * @returns {number} max reach in metres
 */
export function netMaxReachM(netClass) {
  if (!netClass) return 0;
  const maxFlightTime = netClass.MAX_FLIGHT_TIME ?? CN.MAX_FLIGHT_TIME;
  return Math.min(
    netClass.TETHER_MAX ?? Infinity,
    (netClass.LAUNCH_SPEED ?? 0) * maxFlightTime,
  );
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
  // ("close the distance, de-spin [L]"); distant/tumbling/sloppy shots keep
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
 * Local cone radius at an axial depth ahead of the apex.
 * The bag is a cone: apex at local origin, mouth ring at local z = −coneHeight
 * (js/ui/NetMeshKit.js:364-365). Depth `a` metres ahead of the apex therefore
 * sees a local radius mouthRadius × (a / coneHeight). Returns 0 outside
 * [0, coneHeight] — a target behind the apex or past the mouth plane sees no
 * cone at all. Pure + Node-safe.
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} coneHeight — apex-to-mouth axial length (metres)
 * @param {number} axialDepth — metres ahead of the apex along the cone axis
 * @returns {number} local cone radius (metres)
 */
export function coneRadiusAtDepth(mouthRadius, coneHeight, axialDepth) {
  if (!(coneHeight > 0) || axialDepth < 0 || axialDepth > coneHeight) return 0;
  return mouthRadius * (axialDepth / coneHeight);
}

/**
 * Cone containment test for a target expressed in the kit's local frame.
 * localZ is NEGATIVE ahead of the apex (the mouth sits at local z = −coneHeight);
 * localR is the lateral off-axis distance (hypot(localX, localY)). Inclusive on
 * the wall: a target exactly at r == coneRadiusAtDepth(a) counts as inside.
 * Pure + Node-safe.
 * @param {number} localZ — kit-local z of the target (negative ahead of apex)
 * @param {number} localR — lateral off-axis distance (metres)
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} coneHeight — apex-to-mouth axial length (metres)
 * @returns {boolean} true when the target is inside the bag cone
 */
export function isInsideCone(localZ, localR, mouthRadius, coneHeight) {
  const a = -localZ;
  if (a < 0 || a > coneHeight) return false;
  return localR <= coneRadiusAtDepth(mouthRadius, coneHeight, a);
}

/**
 * Largest lateral offset that still yields containment at the brake instant.
 * BRAKE fires when the apex-to-target distance equals the catch radius R, so
 * a² + r² = R² at that instant; containment requires r ≤ k·a with
 * k = mouthRadius / coneHeight. Solving gives R·mouthRadius / hypot(mouthRadius,
 * coneHeight). Valid only while R ≤ coneHeight — if the brake sphere exceeds the
 * bag depth the net brakes with the target still ahead of the mouth plane and
 * containment at the brake instant is geometrically impossible; returns NaN then.
 * Pure + Node-safe.
 * @param {number} catchRadius — the BRAKE-trigger sphere radius (metres)
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} coneHeight — apex-to-mouth axial length (metres)
 * @returns {number} max lateral offset (metres), or NaN when undefined
 */
export function maxImpactParameter(catchRadius, mouthRadius, coneHeight) {
  if (!(catchRadius <= coneHeight)) return NaN;
  return catchRadius * mouthRadius / Math.hypot(mouthRadius, coneHeight);
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
 * @param {{dir:{x,y,z}, offAxisDeg:number}} [out] — optional preallocated result to
 *   write into (avoids per-frame allocation on hot aim paths). When omitted a
 *   fresh object is returned.
 * @returns {{ dir: {x,y,z}, offAxisDeg: number }} lead direction + angle between
 *   the lead direction and the direct bearing (0 when no lead is needed)
 */
export function computeLeadAim(armPos, targetPos, relVel, launchSpeed, out = null) {
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
  const dir = out ? out.dir : { x: 0, y: 0, z: 0 };
  dir.x = dx / dLen; dir.y = dy / dLen; dir.z = dz / dLen;

  // Angle between lead dir and direct bearing
  const dot = Math.max(-1, Math.min(1,
    (dir.x * bx + dir.y * by + dir.z * bz) / bLen));
  const offAxisDeg = Math.acos(dot) * (180 / Math.PI);
  if (out) { out.offAxisDeg = offAxisDeg; return out; }
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
      return 'Net overshot. Line up the reticle and re-fire. Net reeling back; inventory restored.';
    case 'cling_failed':
      return 'Net grazed it. Wrap didn\'t hold. Close the distance or de-spin the target (hold L), then re-fire.';
    case 'oversize_aspect':
      // Phase 2: deterministic broadside bounce — teach the orientation fix.
      return 'Net bounced off broadside. Too wide this way. De-spin, then come around end-on so the net swallows it lengthwise.';
    case 'fragmented':
      // Phase 3b: the impact broke the target up — teach the gentle approach.
      return 'Impact broke the target apart. Fragments are now tracked. Approach slower on brittle debris (CINCH wraps gentler).';
    case 'forced':
      return null;   // scripted/test resolves stay silent
    default:
      // Phase 2: generic line instead of silent null — a miss should never
      // leave the player guessing.
      return 'Net missed. Re-line the shot and fire again. Net reeling back.';
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

    /** @type {function(THREE.Vector3):THREE.Vector3|null} Mother-pod launcher
     *  anchor provider — writes the pod muzzle's CURRENT world position (scene
     *  units) into the supplied scratch vector. This is the mother-path
     *  replacement for `_sourceArm.position`: the ship translates at ~0.7 scene
     *  units/s (70 km/s apparent), so any anchor read once at launch is ~45 km
     *  stale by the end of the first 0.65 s. The provider is polled every frame
     *  the net needs the launcher frame. Null on the headless test path. */
    this._anchorProvider = config.anchorProvider || null;
    /** @type {THREE.Vector3|null} Scratch for the anchor provider (allocated
     *  lazily on first use — headless tests never touch it). */
    this._anchorScratch  = null;

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

    // ── Mother berth (mother-net-reel plan §8) — podIndex ≥ 0 && armIndex < 0 ──
    /** @type {object|null} Injected context { player, debrisField } — set by
     *  CaptureNetSystem.fireMotherNet from init(deps). Backs the ship-relative
     *  reel pin and the pinCapturedDebris API. */
    this._ctx            = null;
    /** @type {number|null} Ship-relative reel: remaining distance muzzle→bag
     *  APEX (the tether end the winch reels — the catch rides _catchSeatM
     *  metres deeper) in METRES. Seeded at REELING entry from the debris's
     *  live _scenePosition minus the seat depth, then monotonically eased to
     *  the berth standoff. Single source for reelProgress on the mother path. */
    this._remainingM     = null;
    /** @type {number|null} The seeded _remainingM at REELING entry — the
     *  reelProgress denominator (review fix: do NOT derive from tetherPaidOut,
     *  which disagrees with the live seed after contact→reel drift). */
    this._reelSeedM      = null;
    /** @type {number} Net-domain seconds since reel entry, accumulated in the
     *  reel/berth ticks — the ramp key for the readability floor's engagement
     *  (whale-in-cone item 15: the floor eases in over
     *  MOTHER_CATCH_MIN_RENDER_RAMP_S instead of popping on the first reel
     *  frame). Seeded 0 at _enterMotherReel, NEVER reset while held — keying
     *  on stateTimer would re-ramp at BERTHED entry (stateTimer resets on
     *  every _transitionTo), a second pop at the nose. */
    this._floorRampT     = 0;
    /** @type {number|null} Depth (metres) the catch rides INSIDE the bag past
     *  the apex, along the frozen bag axis (launchDirection). Seeded at
     *  REELING entry from the live capture geometry — the depth the cinch
     *  left the catch at (aM ≈ 4.5 m on a LARGE net). The reel/berth pin
     *  writes apex + launchDirection × _catchSeatM so the catch stays wrapped
     *  in the drawn bag (whale-in-cone follow-up 2: _updateMotherReel /
     *  updateBerthHold used to pin net.position and the debris to the SAME
     *  point — the catch rode the bag apex unwrapped, the metres gate's
     *  COLOCATION-DEFECT). */
    this._catchSeatM     = null;
    /** @type {THREE.Vector3|null} Lateral offset (scene units), decayed to 0. */
    this._lateral        = null;
    /** @type {THREE.Vector3|null} Lagged ship-forward (scene units) — a raw
     *  live fwd would whip a 5 t catch across the sky on a mid-reel slew. */
    this._fwdLagged      = null;
    /** @type {THREE.Quaternion|null} Catch attitude in the SHIP frame, captured
     *  at berth entry: qLocal = shipQuat⁻¹ × qCatch. Every frame the berth hold
     *  writes shipQuat × qLocal back into tumbleAxis/tumbleAngle so the catch
     *  rotates rigidly WITH the ship (plan §1.2 — otherwise it visibly swivels
     *  inside the net on every slew). */
    this._qLocal         = null;
    /** @type {number} BERTH_SECURE_S countdown once BERTHED; ≤ 0 → processed. */
    this._berthTimer     = -1;
    /** @type {boolean} True once CATCH_PROCESSED has been emitted for this net. */
    this._berthProcessed = false;
    /** @type {number|null} Deterministic strain-roll override for tests. */
    this._strainRollOverride = null;
    /** @type {number|null} Deterministic cling-roll override for tests / the
     *  shot harness (`__netScenario`). 0 ⇒ guaranteed catch; read at the
     *  `_clingRoll <= _clingProbability` compare in `_resolveCatch`. */
    this._clingRollOverride = null;
    /** @type {boolean} Set when the mother reel has no berth context (headless
     *  test path — no player/debrisField): the reel falls through to the
     *  daughter-style reel-back so the net still stows/prunes instead of
     *  looping MISSED→REELING on the re-armed auto-reel. */
    this._motherReelFallback = false;
    // ── Reel corridor clearance (mother-net-reel plan §10 Phase C-lite) ──
    /** @type {boolean} True while the reel is holding at CORRIDOR_HOLD_M
     *  waiting for the recovery corridor to clear. */
    this._corridorHold = false;
    /** @type {number} Seconds spent in the corridor hold; at CORRIDOR_TIMEOUT_S
     *  the reel berths at CORRIDOR_EXTENDED_STANDOFF_M rather than clip through. */
    this._corridorTimer = 0;
    /** @type {boolean} True once the corridor gate has timed out — latches the
     *  gate OFF for the rest of the reel so it cannot re-arm against the same
     *  still-blocked corridor (the berth completes at the held range). */
    this._corridorTimedOut = false;
    /** @type {number} The _remainingM at corridor-hold engagement — the hold
     *  freezes the approach HERE (never pushes it back out). */
    this._corridorHoldLevelM = 0;
    /** @type {boolean} True once the corridor gate has emitted its Houston line
     *  (once per net — a corridor that clears and re-blocks does not re-announce). */
    this._corridorAnnounced = false;
    /** @type {number|null} The berth standoff actually in force — normally
     *  sizeMeter/2 + BERTH_CLEARANCE_M, raised to CORRIDOR_EXTENDED_STANDOFF_M
     *  after a corridor timeout. */
    this._effectiveStandoffM = null;
    /** @type {boolean} Phase B §9: the line-taut tug fires exactly once, at
     *  the CAPTURED transition (mother path only). */
    this._tugApplied = false;
    /** @type {THREE.Vector3|null} §9.8 windowed tug delivery: the feel vector
     *  (scene units/s) fed into _rcsVelocity over NET_TUG_WINDOW_S by
     *  CaptureNetSystem.update. Null when no window is active. Dies with the
     *  net, so a jettison mid-window correctly abandons the remainder. */
    this._tugFeelScene = null;
    /** @type {number} Seconds of the tug window already delivered. */
    this._tugElapsed = 0;
    // ── Phase D.7 garnish (mother-net-reel plan §11.7) ──
    /** @type {number} (a) Tumble carryover: residual spin (rad/s) the wrapped
     *  bundle keeps at ENVELOP, decaying over TUMBLE_CARRYOVER_DECAY_S. Fed
     *  into the berth-hold orientation as a small extra pitch term. */
    this._tumbleCarryover = 0;
    // V7: ACCUMULATED residual-spin angle (rad). The pre-V7 twin sites applied
    // one frame's increment to a freshly rebuilt quaternion each frame, so the
    // carryover never accumulated — a sub-degree offset decaying to nothing.
    this._tumbleCarryAngle = 0;
    /** @type {number} (b) Berthed pendulum: angular offset (rad) of the
     *  berthed bundle off the lagged-forward axis, driven by the same
     *  critically damped spring as the reel-direction lag, re-excited by RCS. */
    this._pendulumAngle = 0;
    /** @type {number} Pendulum angular velocity (rad/s). */
    this._pendulumVel = 0;

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
   * Launcher anchor in scene units, current frame. Daughter path reads the
   * source arm's live position; mother-pod path polls the anchor provider
   * (pod muzzle world position). Returns null on the headless test path —
   * callers fall back to the metres-based absolute-position logic.
   * @returns {THREE.Vector3|null}
   * @private
   */
  _anchorScene() {
    if (this._sourceArm?.position) return this._sourceArm.position;
    if (this._anchorProvider) {
      if (!this._anchorScratch) this._anchorScratch = new THREE.Vector3();
      return this._anchorProvider(this._anchorScratch);
    }
    return null;
  }

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
    // Mother-net-reel plan §7.3: the sync now ALSO covers LAUNCHING and
    // SPINNING_UP (the first 0.65 s). Previously the net sat at its absolute
    // launch point for those states while the launcher co-orbited at ~0.7
    // scene units/s — ~0.45 units (~45 km apparent) of drift before FLIGHT
    // even began. distanceTraveled is 0 during both states, so the sync seats
    // the net exactly on the moving muzzle. (Fixes the daughter's first
    // 0.65 s too — daughter regression pass required.)
    const anchor = this._anchorScene();
    if (anchor
        && (this.state === STATES.LAUNCHING
            || this.state === STATES.SPINNING_UP
            || this.state === STATES.CONTACT
            || this.state === STATES.BRAKE
            || this.state === STATES.ENVELOP
            || this.state === STATES.CINCH_CLOSING
            || this.state === STATES.SECURE_CHECK)) {
      const M_NET = 0.00001;
      this.position.x = anchor.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = anchor.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = anchor.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    } else if (anchor && this.state === STATES.REELING) {
      const M_NET = 0.00001;
      // Mother physical-reel path: _updateMotherReel owns net.position (it
      // writes the bag apex from the ship-relative pin every tick), so this
      // sync is dead — and it must NOT run: it rewrites net.position to
      // whale − mouthR before _enterMotherReel reads it, which would pollute
      // the catch-seat measurement (whale-in-cone follow-up 2).
      const motherPhysical = this._isMother
        && this.catchResult === 'success' && !this._motherReelFallback;
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
      const sp = (!motherPhysical && this.catchResult === 'success') ? this.targetDebris?._scenePosition : null;
      if (motherPhysical) {
        // _updateMotherReel writes net.position later this same tick.
      } else if (sp) {
        const back = this.netClass.DIAMETER / 2;   // mouth radius (m), apex standoff
        this.position.x = sp.x / M_NET - this.launchDirection.x * back;
        this.position.y = sp.y / M_NET - this.launchDirection.y * back;
        this.position.z = sp.z / M_NET - this.launchDirection.z * back;
      } else {
        // Empty net (miss) — reel the bag back to the launcher. Effective
        // launch distance shrinks from `tetherPaidOut` (contact distance)
        // toward 0 as `reelProgress` advances 0→1; at progress=1 the net
        // rendezvous with the launcher.
        const eff = this.tetherPaidOut * Math.max(0, 1 - this.reelProgress);
        this.position.x = anchor.x / M_NET + this.launchDirection.x * eff;
        this.position.y = anchor.y / M_NET + this.launchDirection.y * eff;
        this.position.z = anchor.z / M_NET + this.launchDirection.z * eff;
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
      // Mother berth: the per-frame hold is driven by CaptureNetSystem (which
      // owns the player/debrisField refs), not by the projectile's own switch.
      case STATES.BERTHED:
        break;
    }
  }

  /** True for a mother-pod net (the only path the berth machinery runs on). */
  get _isMother() {
    return this.podIndex >= 0 && this.armIndex < 0;
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

    // PROD path: also update position from the launcher's current co-orbiting
    // frame so CaptureNetVisual renders the net near the ship, not 7 km behind.
    const M_NET = 0.00001;  // 1 m in scene units (matches ArmUnit.M)
    const anchor = this._anchorScene();
    if (anchor) {
      this.position.x = anchor.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = anchor.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = anchor.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    }

    // Check max flight time (§2.4 phase 3). Per-class override (LARGE gets
    // 11 s so its reach reaches the 100 m tether limit); daughters keep the
    // shared CN.MAX_FLIGHT_TIME.
    const maxFlightTime = this.netClass.MAX_FLIGHT_TIME ?? CN.MAX_FLIGHT_TIME;
    if (this.flightTime >= maxFlightTime) {
      this._miss('timeout');
      return;
    }

    // Check tether limit
    if (this.tetherPaidOut >= this.netClass.TETHER_MAX) {
      this._miss('tether_limit');
      return;
    }

    // Mother-net-reel plan §7.7: dead-target guard. DebrisField.removeDebris
    // sets alive=false and FREEZES _scenePosition, so a stale truthy position
    // would keep passing the intersection check below against a body that no
    // longer exists. Route to the miss path instead.
    if (this.targetDebris && this.targetDebris.alive === false) {
      this._miss('target_lost');
      return;
    }

    // Check range to target (intersection = distance < net radius)
    // PROD: use launcher-relative scene position (co-orbiting reference frame).
    // TEST: use absolute metres (mock .position, no anchor).
    if (this.targetDebris) {
      const sp = this.targetDebris._scenePosition;
      const ap = anchor;
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
    // ── MOTHER PHYSICAL REEL (mother-net-reel plan §8 A1) ─────────────────
    // Ship-relative, pinned through debrisField.pinCapturedDebris every frame.
    // TRAP 1 (plan §0): NEVER step the pin toward the pod in absolute
    // coordinates — the ship translates ~0.7 scene units/s while the reel
    // closes at 2e-5 units/s, so an absolute reel diverges ~35,000×.
    // TRAP 3: NEVER write _armPinPos raw and rely on DebrisField.update to
    // render it — that ran EARLIER this frame, so the catch lands one frame
    // (~1.17 km at 60 fps) behind the nose. pinCapturedDebris force-writes
    // the instance matrix in the same call, so frame order stops mattering.
    if (this._isMother && this.catchResult === 'success' && !this._motherReelFallback) {
      this._updateMotherReel(dt);
      // _updateMotherReel sets _motherReelFallback when no berth context
      // exists (headless path) — fall through to the daughter reel-back so
      // the net still stows and prunes instead of looping on a miss.
      if (!this._motherReelFallback) return;
    }

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
        // REEL_PROFILE_V2 (plan Q3): during the SNUG sub-phase the arm sets
        // `_snugTargetN` — pull the bag tight to that explicit cinch tension so
        // daughter+net+debris rigidize into one unit before the haul. Otherwise
        // hold at the base mass formula (legacy behaviour).
        this.tensionN = (this._snugTargetN != null)
          ? this._snugTargetN
          : baseCaptureTensionN(this.capturedMass);
        return;                       // hold: no completion while the arm hauls
      }
      this._heldByArm = false;        // delivered / lost → stow promptly
      this._snugTargetN = null;
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
    this.tensionN = baseCaptureTensionN(this.capturedMass);

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

  // ── Mother physical reel + berth (mother-net-reel plan §8) ─────────────

  /**
   * @private Mother REELING entry: strain/oversize roll, then seed the
   * ship-relative reel state from the debris's LIVE _scenePosition (one frame
   * only — LassoSystem.js:1401-1409 documents why the seed must start from
   * where the debris actually is, not where the flight model left it).
   * @returns {boolean} false when the entry itself failed (strain slip → miss)
   */
  _enterMotherReel() {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    if (!d || !player) return false;

    // §4.3 strain/oversize roll — the odds model already prices this
    // (ToolOdds.computeNetOdds multiplies by 1 − computeStrainFailProbability),
    // so the HUD would otherwise promise a slip that can never happen.
    const rated = this.netClass.MAX_CAPTURE_MASS || 0;
    const mass = d.mass || 0;
    const presented = this._presentedWidthM ?? d.sizeMeter ?? 0;
    const netDia = this.netClass.DIAMETER || 0;
    if (netDia > 0 && presented > netDia) {
      this._miss('oversize_aspect');
      return false;
    }
    if (rated > 0 && mass > 0) {
      const strain = mass / rated;
      const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
      if (strain > safe) {
        const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX ?? 0;
        const t = Math.min(1, (strain - safe) / Math.max(1e-6, 1 - safe));
        const roll = (this._strainRollOverride != null) ? this._strainRollOverride : Math.random();
        if (roll < pMax * t) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: `Net strain slip — catch was ${Math.round(strain * 100)}% of the net's rated mass. `
              + `Slips become likely above ${Math.round(safe * 100)}%.`,
            source: 'SYSTEM', channel: 'CMD', priority: 'warning',
          });
          this._miss('strain_slip');
          return false;
        }
      }
    }

    // Seed ship-relative reel state.
    const M_NET = 0.00001;
    const podWorld = (typeof player.getNetPodPositionInto === 'function')
      ? player.getNetPodPositionInto(this.podIndex, new THREE.Vector3())
      : new THREE.Vector3();
    const sp = d._scenePosition;
    if (sp) {
      const dx = sp.x - podWorld.x, dy = sp.y - podWorld.y, dz = sp.z - podWorld.z;
      // Whale-in-cone follow-up 2 (reel/berth co-location): the catch rides
      // INSIDE the bag at the depth the capture left it — not AT the apex.
      // The seat is its depth past the brake apex along the frozen bag axis
      // (launchDirection — the same axis CaptureNetVisual orients the drawn
      // bag to every frame, so pin, mesh and probe can never drift). The
      // brake apex is anchor + launchDir × distanceTraveled (the formula the
      // post-FLIGHT anchor-sync writes every tick, :815). Read the LIVE
      // anchor — never net.position, which is FROZEN in the absolute frame
      // from the last SECURE_CHECK tick: one frame of orbital drift is
      // ~1.17 km at 60 fps (~8 km in the headless harness), which would pin
      // the catch kilometres from the bag (measured 2026-08-05:
      // _catchSeatM = 7612.69 m on a one-frame-stale anchor). anchor + sp
      // are both live, so the seat is drift-free.
      const L = this.launchDirection;
      const anchor = this._anchorScene();
      const seatM = (L && anchor) ? Math.max(0,
        ((sp.x - anchor.x) / M_NET) * L.x
        + ((sp.y - anchor.y) / M_NET) * L.y
        + ((sp.z - anchor.z) / M_NET) * L.z
        - this.distanceTraveled) : 0;
      this._catchSeatM = seatM;
      // _remainingM is the APEX (tether) distance — pod→catch minus the seat —
      // so the winch hauls the bag's apex anchor to the standoff while the
      // catch rides seatM metres inside it. At entry the apex lands on the
      // brake point and the pin reproduces the live catch position exactly
      // (no teleport at the CAPTURED→REELING hand-off).
      this._remainingM = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz) / M_NET - seatM);
      // Lateral = component of (debris − pod) perpendicular to ship forward.
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();
      const along = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      this._lateral = new THREE.Vector3(dx - fwd.x * along, dy - fwd.y * along, dz - fwd.z * along);
    } else {
      this._remainingM = this.tetherPaidOut;
      this._catchSeatM = 0;
      this._lateral = new THREE.Vector3();
    }
    // Review fix: the reelProgress denominator must be the ACTUAL seeded
    // remaining distance, not tetherPaidOut — the two disagree whenever the
    // catch drifted between contact and reel entry (or a close target made
    // tetherPaidOut < berthStandoffM), which collapsed the denominator to
    // ~0 and snapped progress 0→1 instead of easing.
    this._reelSeedM = Math.max(this._remainingM, 1e-3);
    // Item 15: the readability floor's engagement ramp starts at reel entry
    // (see _catchFloorScale). Seeded HERE, once — never at BERTHED.
    this._floorRampT = 0;
    this._fwdLagged = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();

    // Capture the catch's attitude in the SHIP frame so the berth hold can
    // rotate it rigidly with the ship (plan §1.2).
    if (d.tumbleAxis && player.quaternion) {
      const qCatch = new THREE.Quaternion().setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
      this._qLocal = player.quaternion.clone().invert().multiply(qCatch);
    } else {
      this._qLocal = new THREE.Quaternion();
    }

    // Phase D.7 (a) — tumble carryover: seed the residual spin the wrapped
    // bundle keeps at ENVELOP (the plan's "decaying spin over ~4–6 s instead
    // of the hard stop"). Capped; decays in _updateMotherReel/updateBerthHold.
    const tumbleRate = Math.abs(d.tumbleRate || 0);
    this._tumbleCarryover = Math.min(tumbleRate, CN.TUMBLE_CARRYOVER_MAX_RAD_S ?? 0.6);
    this._tumbleCarryAngle = 0;   // V7: accumulation starts fresh each catch
    return true;
  }

  /**
   * @private The ramped `_catchRenderMin` VALUE for the reel/berth write sites
   * (whale-in-cone register item 15, 2026-08-09 — owner decision: RAMP; plan
   * 1786237166000). Pre-item-15 the floor engaged at full strength on the
   * first reel frame — a measured one-frame pop of 1.31× (2 m catch,
   * tmp/i11-step.log) to 3.33× (0.6 m fragment,
   * test-CaptureNet-CaptureTransition.js) at exactly the instant the ceremony
   * camera is on the catch. The written value now eases base → fullFloor over
   * MOTHER_CATCH_MIN_RENDER_RAMP_S of net dt (the ceremony-scaled domain this
   * tick already runs in, so the ramp stretches under slow-mo like every
   * other net animation), on a smoothstep so both ends have zero velocity.
   *
   * Writer-side ONLY: every reader (the probe, the bag's contents floor, both
   * matrix writers) still reads the one clamp-aware SSOT
   * DebrisField.effectiveRenderScale, whose predicate (`_catchRenderMin >
   * base`, only raises) makes a ramped value ≤ base inert — an at/above-floor
   * catch's drawn size never moves. The scenario's `_catchRenderMin` property
   * freeze swallows this write whatever its value, so every gate stays
   * bit-identical (item-8 D3). The accumulator is seeded at _enterMotherReel
   * and never reset while held (the berth re-ramp trap — item-15 plan F6).
   * Scalar arithmetic only — the per-frame path stays allocation-free.
   * @param {object} d — the canonical catch debris
   * @param {number} dt — net-domain seconds (already ceremony-scaled)
   * @returns {number} scene-unit scale floor for `_catchRenderMin`
   */
  _catchFloorScale(d, dt) {
    this._floorRampT += dt;
    const fullFloor = DebrisWireframe.scaleForRenderRadiusM(CN.MOTHER_CATCH_MIN_RENDER_M ?? 2.0, d.type, d.id);
    const rampS = Math.max(1e-6, CN.MOTHER_CATCH_MIN_RENDER_RAMP_S ?? 0.6);
    const frac = Math.min(1, this._floorRampT / rampS);
    const ease = frac * frac * (3 - 2 * frac);           // smoothstep
    const base = d.sceneSize || (d.sizeMeter ? d.sizeMeter * 0.00001 : 0);
    return base + (fullFloor - base) * ease;
  }

  /**
   * @private Mother REELING per-frame tick: monotonically ease remainingM to
   * the berth standoff and pin the catch through debrisField.pinCapturedDebris.
   */
  _updateMotherReel(dt) {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    const debrisField = this._ctx?.debrisField;
    // No berth context (headless test path, or a mother net fired without
    // init(deps)): fall through to the daughter-style reel-back below rather
    // than missing — a miss here would loop MISSED→REELING→MISSED via the
    // re-armed auto-reel and never prune.
    if (!d || !player || !debrisField) { this._motherReelFallback = true; return; }
    if (d.alive === false) { this._miss('target_lost'); return; }

    if (this._remainingM == null) {
      if (!this._enterMotherReel()) return;   // strain slip / oversize → missed
    }

    const M_NET = 0.00001;
    // The standoff in force: raised to CORRIDOR_EXTENDED_STANDOFF_M after a
    // corridor-timeout berth (Phase C-lite, plan §10).
    const baseStandoffM = (d.sizeMeter || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
    if (this._effectiveStandoffM == null) this._effectiveStandoffM = baseStandoffM;
    const berthStandoffM = Math.max(baseStandoffM, this._effectiveStandoffM);

    // ── Corridor gate (Phase C-lite, plan §10): pause the final approach
    // CORRIDOR_HOLD_M out until the recovery corridor (a cylinder along
    // ship-local +Z from the muzzle, radius = sizeMeter/2 + BERTH_CLEARANCE_M)
    // is clear of strut tips, held daughter catches and lasso cargo. On
    // timeout, berth at the extended standoff rather than clip through.
    const holdM = Math.max(berthStandoffM, CN.CORRIDOR_HOLD_M ?? 10);
    if (!this._corridorTimedOut && this._remainingM <= holdM && !this._corridorClear(d)) {
      if (!this._corridorHold) {
        this._corridorHold = true;
        this._corridorTimer = 0;
        // Freeze at the CURRENT range, never above it: a catch seeded inside
        // the gate range (a very close shot) must not pop outward to holdM.
        this._corridorHoldLevelM = this._remainingM;
      }
      this._corridorTimer += dt;
      if (!this._corridorAnnounced) {
        this._corridorAnnounced = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Clearing deck for recovery…',
          source: 'HOUSTON', priority: 'info',
        });
      }
      if (this._corridorTimer >= (CN.CORRIDOR_TIMEOUT_S ?? 8)) {
        // Timeout — berth AT the held position (clamped into [base, extended]).
        // The hold level is already outside every intruder's reach — that is
        // why the gate froze the approach there — so completing at the held
        // range neither slides inward past the intruder nor pops outward.
        const extended = Math.max(holdM, CN.CORRIDOR_EXTENDED_STANDOFF_M ?? 10);
        this._effectiveStandoffM = Math.min(Math.max(baseStandoffM, this._corridorHoldLevelM), extended);
        // Keep _corridorHold TRUE for the rest of this frame: berthStandoffM
        // was derived at the top of the tick from the OLD standoff, so letting
        // the ease run now would step remainingM below the new standoff and
        // the next frame would clamp it back OUT — a one-frame outward pop
        // violating the monotonic-ease invariant. The latch below makes the
        // gate condition false next frame, and the resume branch clears the
        // hold there, when the ease runs against the correct standoff.
        this._corridorTimedOut = true;   // latch: the gate must not re-arm
                                         // against the same blocked corridor
                                         // while the berth completes.
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Deck not clear — berthing at extended standoff (${Math.round(this._effectiveStandoffM)} m).`,
          source: 'HOUSTON', priority: 'warning',
        });
      }
      // Hold: freeze the approach at the engagement range (still pinned below).
      if (this._corridorHold) this._remainingM = this._corridorHoldLevelM;
    } else if (this._corridorHold) {
      // Corridor cleared (or we were never blocked) — resume the approach.
      this._corridorHold = false;
      this._corridorTimer = 0;
    }

    // Monotonic ease-in (never decelerate mid-reel so the tether cannot
    // re-slack and re-snap). Mild long-tether speed-up lands the duration in
    // the ~5–25 s window (REEL_SPEED 2.0 on a 100 m shot would else be ~50 s).
    const reelSpeed = (this._remainingM >= (CN.REEL_LONG_TETHER_M ?? 40))
      ? this.netClass.REEL_SPEED * (CN.REEL_LONG_TETHER_MULT ?? 3.0)
      : this.netClass.REEL_SPEED;
    if (!this._corridorHold) {
      this._remainingM = Math.max(berthStandoffM, this._remainingM - reelSpeed * dt);
    }

    // reelProgress: remainingM is the single source (no external consumer, so
    // free to redefine). 0 at the seeded range (_reelSeedM), 1 at the standoff.
    // During a corridor hold remainingM freezes, so progress freezes with it —
    // the honest read (the catch IS parked at the gate).
    const seedM = Math.max(berthStandoffM + 1e-3, this._reelSeedM ?? this.tetherPaidOut ?? berthStandoffM + 1e-3);
    this.reelProgress = Math.min(1, Math.max(0,
      1 - (this._remainingM - berthStandoffM) / (seedM - berthStandoffM)));

    // Rotation lag: run the ship forward through a critically damped spring so
    // a mid-reel slew lags and settles instead of whipping the catch.
    this._settleFwdLagged(player, dt);

    // Pin anchor: pod + lagged-fwd · remainingM + lateral (scene units) — the
    // bag's APEX, i.e. the tether end the winch actually reels.
    const podWorld = (typeof player.getNetPodPositionInto === 'function')
      ? player.getNetPodPositionInto(this.podIndex, _v3c) : _v3c.set(0, 0, 0);
    _v3d.copy(podWorld)
      .addScaledVector(this._fwdLagged, this._remainingM * M_NET)
      .add(this._lateral);

    // net.position is the bag's apex anchor (CaptureNetVisual seats the kit
    // there × M every frame; the tether draws to it) — written BEFORE the
    // seat offset goes into the catch pin below.
    this.position.x = _v3d.x / M_NET;
    this.position.y = _v3d.y / M_NET;
    this.position.z = _v3d.z / M_NET;

    // The catch rides _catchSeatM metres INSIDE the bag along the frozen bag
    // axis (launchDirection — the axis the visual orients to), not AT the
    // apex (whale-in-cone follow-up 2: co-locating the two left the catch on
    // the bag apex unwrapped — the metres gate's COLOCATION-DEFECT).
    if (this._catchSeatM) _v3d.addScaledVector(this.launchDirection, this._catchSeatM * M_NET);

    // Orientation follows the ship (plan §1.2), PLUS the Phase D.7 (a)
    // tumble-carryover offset — shared helper (V7: the twin sites are one
    // implementation now, so the accumulation fix cannot drift apart again).
    this._applyCatchOrientation(d, player, dt);

    d._armPinned = true;
    d._captured = true;
    d._catchRenderMin = this._catchFloorScale(d, dt);   // item 15: ramped at reel entry
    debrisField.pinCapturedDebris(d, _v3d);

    // Tension readout (HUD): base + mass factor, same shape as the daughter.
    this.tensionN = baseCaptureTensionN(this.capturedMass);

    // Completion → BERTHED.
    if (this._remainingM <= berthStandoffM + 1e-6) {
      this._transitionTo(STATES.BERTHED);
      this._berthTimer = CN.BERTH_SECURE_S ?? 4.0;
      eventBus.emit(Events.NET_REEL_COMPLETED, {
        armIndex:     this.armIndex,
        podIndex:     this.podIndex,
        capturedMass: this.capturedMass,
        debrisId:     d.id,
      });
      eventBus.emit(Events.NET_BERTHED, {
        debrisId: d.id,
        mass:     this.capturedMass,
        podIndex: this.podIndex,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Catch secured — berthed at pod ${this.podIndex + 1}. Securing ${Math.round(this.capturedMass)} kg…`,
        source: 'HOUSTON', priority: 'info',
      });
    }
  }

  /**
   * @private Recovery-corridor test (mother-net-reel plan §10 Phase C-lite).
   * Analytic — no mesh collision exists anywhere in this codebase. The
   * corridor is a cylinder along ship-local +Z from the muzzle, radius =
   * debris.sizeMeter/2 + BERTH_CLEARANCE_M. It must contain:
   *   1. no strut tip (strutLocalDirection(α, az) × STRUT_LENGTH from the
   *      collar pivot — at α≈π a 1.60 m strut tip reaches ~2.5 m fore, past
   *      the muzzle plane at z ≈ 1.30 m; a forward-swept strut blocks whether
   *      or not it holds a catch),
   *   2. no lasso cargo cell (parked at MOTHER_CARGO_FWD_OFFSET_M dead ahead).
   * Everything is evaluated in the SHIP-LOCAL frame with the origin at the pod
   * muzzle (the corridor is defined there), so the test is attitude- and
   * position-free and needs no world-space round-trip.
   * @param {object} d — the caught debris (for the corridor radius)
   * @returns {boolean} true when the corridor is clear
   */
  _corridorClear(d) {
    const player = this._ctx?.player;
    if (!player || typeof player.getNetPodPositionInto !== 'function') return true;
    const V5 = Constants.OCTOPUS_V5;
    if (!V5) return true;

    const radiusM = (d.sizeMeter || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
    const radiusSq = radiusM * radiusM;
    const M_NET = 0.00001;

    // Everything is evaluated SHIP-LOCAL with the origin at the pod muzzle —
    // the corridor is defined in that frame, so the test is attitude- and
    // position-free. Muzzle ship-local (from _buildNetPods): x=0, y=±0.06,
    // z=1.30 — recovered exactly from the muzzle anchor's local position when
    // the real ship is present, falling back to the documented constants.
    const muzzle = player._netPodMuzzles?.[this.podIndex] ?? player._netPodMuzzles?.[0];
    const mx = muzzle ? muzzle.position.x / M_NET : 0;
    const my = muzzle ? muzzle.position.y / M_NET : 0;
    const mz = muzzle ? muzzle.position.z / M_NET : 1.30;

    // Cylinder axis = ship-local +Z. A point is INSIDE when its axial
    // coordinate z > 0 (fore of the muzzle plane) — intruders aft of the
    // muzzle can't be clipped by an incoming catch — AND its radial
    // (x,y) distance from the axis < radiusM.
    const testLocal = (lx, ly, lz) => {
      if (lz <= 0) return false;                       // aft of the muzzle plane
      return (lx * lx + ly * ly) < radiusSq;
    };

    // ── 1. Strut tips ──
    // Strut geometry is ship-local by construction: pivot at
    // (cos az·collarR, sin az·collarR, collarY), tip at pivot +
    // strutLocalDirection(α, az) × STRUT_LENGTH. A forward-swept strut is the
    // blocker whether or not it holds a catch — no separate held-catch test:
    // whenever a tip is fore of the muzzle plane (tipZ > 0) its radial is
    // ≤ 2.01 m, while the smallest whale-class corridor radius in the catalog
    // is 2.40 m (FENGYUN-1C, 2.8 m), so the tip test always fires first. (And
    // capturedDebris is set at CAPTURED/GRAPPLED — long before the daughter is
    // back at the tip — so a held-catch check keyed on it would test the wrong
    // position anyway.) Revisit if strut length, collar radius or the minimum
    // whale size changes enough to close that 0.39 m margin.
    const armManager = this._ctx?.armManager;
    const arms = armManager?.arms;
    if (arms && arms.length) {
      const strutLen = V5.STRUT_LENGTH ?? 1.60;
      const collarR  = V5.COLLAR_RADIUS ?? 0.40;
      const collarY  = V5.COLLAR_Y ?? 0.90;
      for (let i = 0; i < arms.length; i++) {
        const arm = arms[i];
        if (!arm) continue;
        // Stowed/locked struts sit at α=0 (aft, against the barrel) — clear
        // by construction, and getAimAlpha already reflects the forced α=0,
        // but skip them explicitly so a mid-stow strut doesn't flicker the
        // gate.
        const ds = (typeof arm.getDeployState === 'function') ? arm.getDeployState() : 'DEPLOYED';
        if (ds === 'LOCKED' || ds === 'STOWED') continue;
        const alpha = (typeof arm.getAimAlpha === 'function') ? arm.getAimAlpha() : Math.PI / 2;
        const azRad = (arm._azimuthDeg || 0) * Math.PI / 180;
        strutLocalDirection(alpha, azRad, _v3g);
        const tipX = Math.cos(azRad) * collarR + _v3g.x * strutLen - mx;
        const tipY = Math.sin(azRad) * collarR + _v3g.y * strutLen - my;
        const tipZ = collarY + _v3g.z * strutLen - mz;
        if (testLocal(tipX, tipY, tipZ)) return false;
      }
    }

    // ── 2. Lasso cargo cells ──
    // Cells park at MOTHER_CARGO_FWD_OFFSET_M (4 m) ahead of the HULL ORIGIN
    // on the centreline — squarely inside the corridor (the §4.13 overlap).
    // Settled in §10 by ACCEPTING the overlap and letting the gate manage it:
    // the reel holds at CORRIDOR_HOLD_M until the furnace feed (FEED_S ≤ 9 s)
    // clears the cell; on timeout the berth completes at the extended
    // standoff, whose near face (≥ HOLD_M − sizeMeter/2 ≥ 4.5 m for an 11 m
    // whale) clears the 4 m cargo row. No lateral-spread constant needed.
    const lasso = this._ctx?.lassoSystem;
    const cargo = lasso?._cargo;
    if (cargo && cargo.length) {
      const fwdOff = Constants.MOTHER_CARGO_FWD_OFFSET_M ?? 4;
      const spread = Constants.MOTHER_CARGO_CELL_SPREAD_M ?? 0;
      const cells = Math.max(1, Constants.MOTHER_CARGO_CELLS ?? 3);
      for (const item of cargo) {
        const t = item?.target;
        if (!t || t.alive === false) continue;
        const lat = (item.cellIndex - (cells - 1) / 2) * spread;
        const catchR = ((t.sizeMeter || 1) / 2);
        const lx = lat - mx, ly = -my, lz = fwdOff - mz;
        if (lz > 0 && (lx * lx + ly * ly) < (radiusM + catchR) * (radiusM + catchR)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Mother BERTHED per-frame hold (driven by CaptureNetSystem.update — the
   * projectile's own switch no-ops on BERTHED). Freezes the reel formula at
   * the standoff: same code path, same pin API, same ship-relative frame.
   * @param {number} dt
   * @returns {boolean} false when the berth should tear down (dead target)
   */
  updateBerthHold(dt) {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    const debrisField = this._ctx?.debrisField;
    if (!d || !player || !debrisField) return false;
    // §4.19: the berth-hold alive guard is what cleans up a mission transition
    // (a BERTHED net survives getState holding a debris ref that no longer
    // exists). NOT optional polish.
    if (d.alive === false) return false;

    const M_NET = 0.00001;
    // Respect the corridor-timeout extended standoff (Phase C-lite): a berth
    // forced out to CORRIDOR_EXTENDED_STANDOFF_M must HOLD there — recomputing
    // the base standoff here would slide the catch inward at the berth.
    const baseStandoffM = (d.sizeMeter || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
    const berthStandoffM = Math.max(baseStandoffM, this._effectiveStandoffM ?? baseStandoffM);
    this._remainingM = berthStandoffM;

    this._settleFwdLagged(player, dt);

    // Phase D.7 (b) — berthed pendulum: the bundle swings on a critically
    // damped spring (~0.5 Hz, decays ~5 s), re-excited by RCS translation.
    // The swing is an angular offset off the lagged-forward axis, applied as a
    // small lateral displacement at the standoff distance. Semi-implicit
    // (dt-robust at 30/120 fps). Phase D.8 (§11.8): garnish — dropped at LOW
    // tier (the berth hold itself is structure and stays).
    if (CN.BERTH_PENDULUM_ENABLED !== false) {
      const pOmega = 2 * Math.PI * (CN.BERTH_PENDULUM_FREQ_HZ ?? 0.5);
      const pZeta = 1.0;
      const pK = pOmega * pOmega, pC = 2 * pZeta * pOmega;
      // RCS re-excite: translation velocity kicks the pendulum. _rcsVelocity is
      // in scene-units/s; convert to m/s (÷ M_NET) so the coefficient reads in
      // rad-per-metre and matches how the rest of this file reasons in metres.
      // Scaled by dt like every other term in this integrator: the excitation is
      // applied EVERY frame the RCS velocity is non-zero (thrust plus its
      // RCS_DAMPING tail), so an unscaled kick made the swing framerate-dependent
      // (~2.1× at 120 fps vs 60 fps) AND saturated BERTH_PENDULUM_MAX_RAD after
      // ~0.3 s of held thrust, turning the damped swing into a hard clamp.
      // With dt, the total kick over a burst is ∫v·dt = the RCS displacement in
      // metres, so the coefficient is rad/s of swing per metre of drift.
      if (player._rcsVelocity) {
        const rcsMps = player._rcsVelocity.length() / M_NET;
        this._pendulumVel += rcsMps * dt * (CN.BERTH_PENDULUM_RCS_EXCITE ?? 0.6);
      }
      // Spring toward 0 (the boresight), capped.
      const pAccel = -pK * this._pendulumAngle - pC * this._pendulumVel;
      this._pendulumVel += pAccel * dt;
      this._pendulumAngle += this._pendulumVel * dt;
      const pMax = CN.BERTH_PENDULUM_MAX_RAD ?? 0.06;
      if (Math.abs(this._pendulumAngle) > pMax) {
        this._pendulumAngle = Math.sign(this._pendulumAngle) * pMax;
        this._pendulumVel = 0;
      }
      // Apply the swing as a lateral offset at the standoff distance.
      if (Math.abs(this._pendulumAngle) > 1e-9) {
        // Swing direction: perpendicular to fwd, in the ship's local XZ plane
        // (a yaw swing — reads as the bundle swaying side-to-side on the line).
        _v3e.crossVectors(this._fwdLagged, _v3a.set(0, 1, 0).applyQuaternion(player.quaternion)).normalize();
        if (_v3e.lengthSq() > 1e-9) {
          const swingM = Math.tan(this._pendulumAngle) * berthStandoffM;
          this._lateral.addScaledVector(_v3e, swingM * M_NET);
        }
      }
    }

    const podWorld = (typeof player.getNetPodPositionInto === 'function')
      ? player.getNetPodPositionInto(this.podIndex, _v3c) : _v3c.set(0, 0, 0);
    _v3d.copy(podWorld)
      .addScaledVector(this._fwdLagged, berthStandoffM * M_NET)
      .add(this._lateral);

    // net.position = the bag's apex anchor (the tether end), written BEFORE
    // the seat offset — same split as _updateMotherReel, so the catch stays
    // seated INSIDE the bag through the berth hold instead of riding the apex.
    this.position.x = _v3d.x / M_NET;
    this.position.y = _v3d.y / M_NET;
    this.position.z = _v3d.z / M_NET;
    if (this._catchSeatM) _v3d.addScaledVector(this.launchDirection, this._catchSeatM * M_NET);

    // Phase D.7 (a) — tumble carryover (shared helper — V7, same as the reel path).
    this._applyCatchOrientation(d, player, dt);

    d._armPinned = true;
    d._captured = true;
    d._catchRenderMin = this._catchFloorScale(d, dt);   // item 15: ramp continues; never restarts at berth
    debrisField.pinCapturedDebris(d, _v3d);
    return true;
  }

  /**
   * @private C1: the reel/berth rotation-lag spring, hoisted from two identical
   * inline sites (_updateMotherReel + updateBerthHold). Runs the ship forward
   * through a critically damped spring (~0.8 Hz settle) so a mid-reel slew lags
   * and settles instead of whipping the catch, and decays the lateral offset
   * toward the boresight as the bundle reels in. Writes _fwdLagged + _lateral.
   * @param {object} player — mother ship (quaternion read)
   * @param {number} dt — seconds
   */
  _settleFwdLagged(player, dt) {
    const fwdTarget = _v3a.set(0, 0, 1).applyQuaternion(player.quaternion).normalize();
    const omega = 2 * Math.PI * 0.8;                    // ~0.8 Hz settle
    const zeta = 1.0;                                   // critically damped
    const k = omega * omega, c = 2 * zeta * omega;
    _v3b.copy(fwdTarget).sub(this._fwdLagged);          // displacement
    this._fwdLagged.addScaledVector(_v3b, Math.min(1, k * dt * dt + c * dt));
    this._fwdLagged.normalize();
    // Lateral decay (catch swings onto the boresight as it reels in).
    this._lateral.multiplyScalar(Math.max(0, 1 - 2.0 * dt));
  }

  /**
   * @private Shared reel/berth orientation: ship-rigid attitude (plan §1.2)
   * PLUS the Phase D.7 (a) tumble carryover — a small extra pitch term on top
   * of the ship-rigid attitude, decaying over TUMBLE_CARRYOVER_DECAY_S. The
   * two share the orientation channel (tumbleAxis/tumbleAngle), so the
   * carryover is composed as an additional rotation about the ship-local X
   * (pitch) axis — the same axis the tug's angular kick uses.
   *
   * V7: the residual spin is now ACCUMULATED — `_tumbleCarryAngle` integrates
   * `_tumbleCarryover × dt` (mod 2π), mirroring how `_pendulumAngle` /
   * `_pendulumVel` already integrate, so the catch visibly spins down in the
   * bag. The pre-V7 twin sites applied one frame's increment to a freshly
   * rebuilt quaternion each frame, so it never accumulated: a sub-degree
   * offset that decayed to nothing. Hoisted into one helper so the two call
   * sites cannot drift apart again. The accumulated angle outlives the rate on
   * purpose — see the in-body note.
   * @param {object} d — the caught debris (tumbleAxis/tumbleAngle written)
   * @param {object} player — mother ship (quaternion read)
   * @param {number} dt — seconds
   */
  _applyCatchOrientation(d, player, dt) {
    if (!this._qLocal || !d.tumbleAxis) return;
    _q0.copy(player.quaternion).multiply(this._qLocal);
    if (CN.TUMBLE_CARRYOVER_ENABLED !== false) {
      // Integrate while the RATE is alive…
      if (this._tumbleCarryover > 1e-6) {
        this._tumbleCarryAngle = (this._tumbleCarryAngle + this._tumbleCarryover * dt) % (2 * Math.PI);
        // Decay the residual (exponential, dt-robust).
        this._tumbleCarryover *= Math.exp(-dt / (CN.TUMBLE_CARRYOVER_DECAY_S ?? 5.0));
      }
      // …but KEEP APPLYING the accumulated angle after it dies. The rate and the
      // angle are separate quantities: the rate decaying to zero means the catch
      // has finished spinning down, not that it teleports back to its
      // pre-tumble attitude. Both used to sit behind the same `> 1e-6` gate,
      // which was harmless pre-V7 (the angle was one frame's sub-degree
      // increment) but became a one-frame snap of up to ∫0.6·e^(−t/5)dt = 3 rad
      // ≈ 172° once V7 made the accumulation real. Reachable on any catch held
      // past ~66 s (corridor timeout / a long berth hold).
      if (this._tumbleCarryAngle !== 0) {
        _q1.setFromAxisAngle(_v3e.set(1, 0, 0), this._tumbleCarryAngle);
        _q0.multiply(_q1);
      }
    }
    const w = Math.max(-1, Math.min(1, _q0.w));
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    if (s > 1e-6) d.tumbleAxis.set(_q0.x / s, _q0.y / s, _q0.z / s);
    else d.tumbleAxis.set(0, 1, 0);
    d.tumbleAngle = angle;
  }

  // ── Catch resolution ───────────────────────────────────────────────────

  /** @private Roll cling probability and resolve capture */
  _resolveCatch() {
    // Dead-target guard (mother-net-reel plan §7.7): the body may have been
    // removed (fragmented by another interaction, deorbited) while the net
    // was wrapping. Never award a catch against a dead reference.
    if (this.targetDebris && this.targetDebris.alive === false) {
      this._miss('target_lost');
      return;
    }

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

    const clingRoll = (this._clingRollOverride != null) ? this._clingRollOverride : this._clingRoll;
    if (clingRoll <= this._clingProbability) {
      this._captureSuccess();
    } else {
      this._miss('cling_failed');
    }
  }

  /**
   * Phase B §9.8–9.10 — the line-taut tug (mother path only).
   *
   * At CAPTURED the tether snaps straight: the whale's residual momentum
   * relative to the Mother transfers through the net. Honest ratio up to
   * 177:1 (23 t vs 130 kg), so the NET_TUG_MAX_DV_MS cap does nearly all the
   * work. Three coupled effects:
   *
   *   1. Spring soft-capture (the shock absorber, §9.8): the feel component is
   *      spread over NET_TUG_WINDOW_S into _rcsVelocity by the windowed
   *      delivery in CaptureNetSystem.update — Σ(step/window) === 1 exactly at
   *      any frame rate, so the delivered impulse is dt-robust. The residual
   *      decay is RCS_DAMPING's inherited per-frame behaviour (shared with
   *      manual RCS, deliberately out of scope). Feel-only; never mutates the
   *      orbit. NET_TUG_FEEL_MULT scales the share so the ~2× transient (same
   *      magnitude drives orbit + _rcsVelocity) is deliberate, not accidental.
   *   2. Kept orbit impulse (one-shot, NOT spread): the capped Δv goes through
   *      applyCartesianImpulse with { noBill: true } — passive momentum
   *      transfer bills no fuel/battery and ignores the power gates. The kept
   *      Δv is a genuine ΔV-economy event (comms'd, cancellable with RCS, NOT
   *      auto-nulled — keep-or-cancel by design). A false return means the
   *      altitude-envelope guard refused it: comms must say so honestly
   *      ("tug damped — envelope limit") rather than claiming kept Δv.
   *   3. Angular kick: τ_x = r_y·F_z — the ROW_DZ muzzle lever (±6 cm in ship
   *      Y) × the AXIAL tug, the single term _applyMotherNetRecoil models.
   *      Signed so a forward pull pitches opposite to an aft recoil at the
   *      same muzzle. RCS springs it back (~2 s, ζ=1); attitude hold survives.
   *
   * relVel derivation: the catch's orbital velocity (orbitToSceneCartesianInto
   * on its own elements — it keeps propagating while pinned) minus the
   * Mother's getVelocity(). This is the same quantity the pre-fire drift
   * refusal measures via its EMA, but sampled exactly once at the taut moment.
   *
   * @private
   */
  _applyCaptureTug() {
    if (this._tugApplied) return;
    this._tugApplied = true;
    const d = this.targetDebris;
    const player = this._ctx?.player;
    if (!d || !player || !d.orbit) return;
    if (typeof player.applyCartesianImpulse !== 'function') return;
    if (typeof player.getVelocity !== 'function') return;

    // A tease-pinned catch rides the mother's frame: orbit propagation is
    // SKIPPED while _onboardingPinned (DebrisField update loop), so the
    // elements below carry a velocity stale by the whole pin duration —
    // measured ~1.2 km/s phantom relative velocity after a ~95 s pin
    // (2026-08-02 P1 probe), which capped dvMag and armed a full-scale camera
    // shake for a catch that was, physically, co-moving with the ship. The
    // honest relative velocity of a piece held in the mother's frame is ~0,
    // and a zero-relative-velocity catch yanks nothing (same early return as
    // the matched-velocity case below).
    if (d._onboardingPinned) return;

    // Catch orbital velocity (km/s) at its current elements.
    orbitToSceneCartesianInto(d.orbit, _tugScratchPos, _tugScratchVel);
    const shipV = player.getVelocity();
    // Relative velocity catch − ship, converted km/s → m/s.
    const rvx = (_tugScratchVel.x - shipV.x) * 1000;
    const rvy = (_tugScratchVel.y - shipV.y) * 1000;
    const rvz = (_tugScratchVel.z - shipV.z) * 1000;
    const relSpeed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    if (relSpeed < 1e-3) return;   // matched velocity → no tug (zero-relVel case)

    // Momentum the catch carries relative to the ship, shared by mass ratio,
    // capped. m_catch·v_rel is the full momentum; the ship's share of the
    // velocity change is m_catch/(m_catch + m_ship) of v_rel.
    const mCatch = d.mass || this.capturedMass || 1;
    const mShip = player.mass || 130;
    const share = mCatch / (mCatch + mShip);
    const cap = CN.NET_TUG_MAX_DV_MS ?? 0.5;
    const dvMag = Math.min(relSpeed * share, cap);

    // Direction the ship gets PULLED: toward the catch's relative motion
    // (the tether drags the Mother after the whale).
    const inv = 1 / relSpeed;
    const dvWorld = _v3e.set(rvx * inv, rvy * inv, rvz * inv).multiplyScalar(dvMag);

    // Minor 5 (review): snapshot everything needed AFTER the impulse call into
    // plain locals BEFORE it. applyCartesianImpulse synchronously emits
    // COMMS_MESSAGE / THRUST_VISUAL / RESOURCE_CONSUME, and a future listener
    // re-entering CaptureNet would clobber the module scratch (_v3e/_v3b/_q0)
    // the comms dirTag and the angular kick are computed from.
    let localTugX = 0, localTugY = 0, localTugZ = 0;
    if (player.quaternion) {
      _q0.copy(player.quaternion).invert();
      _v3b.copy(dvWorld).applyQuaternion(_q0);   // tug dir in ship frame (m/s)
      localTugX = _v3b.x; localTugY = _v3b.y; localTugZ = _v3b.z;
    }

    // (2) Kept orbit impulse — one-shot, no billing, envelope guard surfaced.
    const applied = player.applyCartesianImpulse(dvWorld, 0, { noBill: true });

    // (1) Spring soft-capture (§9.8): seed the windowed delivery. The feel
    // vector is stored on the net and fed into _rcsVelocity over
    // NET_TUG_WINDOW_S by CaptureNetSystem.update — Σ(step/window) === 1
    // exactly at any frame rate. M = 1e-5 scene-units-per-metre.
    const windowS = CN.NET_TUG_WINDOW_S ?? 0.65;
    const feelMult = CN.NET_TUG_FEEL_MULT ?? 1.0;
    if (player._rcsVelocity && feelMult > 0 && windowS > 0) {
      if (!this._tugFeelScene) this._tugFeelScene = new THREE.Vector3();
      this._tugFeelScene.copy(dvWorld).multiplyScalar(1e-5 * feelMult);
      this._tugElapsed = 0;
    }

    // (3) Angular kick: τ_x = r_y·F_z — the ROW_DZ lever × the AXIAL tug
    // (review item 1: the previous |F_y| term zeroed the pitch for a
    // boresight tug — the dominant case — and mis-levered the lateral one).
    if (player.quaternion && typeof player.mass === 'number') {
      const muzzles = player._netPodMuzzles;
      const muzzle = muzzles && muzzles[this.podIndex];
      const muzzleLocalY = muzzle ? muzzle.position.y : 0;
      if (Math.abs(muzzleLocalY) > 1e-9) {
        // Angular impulse ∝ linear momentum transferred × lever / I. Reuse
        // the recoil shape: I = m·0.25; momentum = m_ship·dv (N·s).
        const I = mShip * 0.25;
        const leverM = Math.abs(muzzleLocalY) / 1e-5;   // scene units → metres
        const j = mShip * dvMag;                        // N·s (kg·m/s)
        const pitchSign = muzzleLocalY >= 0 ? -1 : 1;
        // Signed axial component: −Z (aft, the recoil case) → +1 so the
        // expression reduces exactly to _applyMotherNetRecoil; +Z (forward
        // pull) → −1. Clamped to ±1.
        const axial = Math.max(-1, Math.min(1, -localTugZ / Math.max(1e-9, dvMag)));
        player._recoilPitchVel += pitchSign * (j * leverM / I) * axial;
      }
    }

    // Comms — magnitude + direction, or the honest envelope refusal.
    if (applied) {
      const dirTag = Math.abs(localTugZ) > Math.max(Math.abs(localTugX), Math.abs(localTugY))
        ? (localTugZ > 0 ? 'prograde' : 'retrograde') : 'lateral';
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Tug absorbed: ${dvMag.toFixed(2)} m/s ${dirTag}.`,
        source: 'HOUSTON', priority: 'info',
      });
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Tug damped — envelope limit.',
        source: 'HOUSTON', priority: 'info',
      });
    }

    // Camera micro-shake payload (CameraSystem listens, whale-only, scaled by
    // imparted Δv, skipped under prefers-reduced-motion — §9.11).
    eventBus.emit(Events.NET_MOTHER_TUG, {
      podIndex: this.podIndex,
      dvMs: applied ? dvMag : 0,
      windowS,
    });
  }

  /** @private Transition to CAPTURED + emit event */
  _captureSuccess() {
    this.catchResult = 'success';
    this.capturedMass = this.targetDebris?.mass || 1.0;
    this.tangleQuality = this._clingProbability;
    this._transitionTo(STATES.CAPTURED);

    // Phase B §9 — the line-taut tug. The tether just snapped straight on a
    // whale with residual relative velocity: the catch yanks the Mother.
    // Runs BEFORE the event emits so the tug's comms/camera payloads read as
    // part of the capture beat. Mother path only (the daughter's arm absorbs
    // its own catch momentum).
    if (this._isMother) this._applyCaptureTug();

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
    // Review fix (strain-slip lifecycle): a miss can fire AFTER the net already
    // passed CAPTURED→REELING (the mother strain roll at reel entry), which
    // set _resultProcessed in CaptureNetSystem.update(). Without resetting it,
    // needsAutoReel never re-arms and the net strands in MISSED forever —
    // never pruned, inventory never restored, pins never cleared.
    this._resultProcessed = false;

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
   * BERTHED is the manual jettison ([K]) — clears pins, re-seats the orbit,
   * frees the launcher. The securing timer (if still running) is cancelled.
   * @returns {boolean} Whether release occurred
   */
  release() {
    if (this.state !== STATES.CAPTURED &&
        this.state !== STATES.REELING &&
        this.state !== STATES.FLIGHT &&
        this.state !== STATES.BERTHED) return false;

    const wasBerthed = this.state === STATES.BERTHED;
    this._transitionTo(STATES.RELEASED);
    this.capturedMass = 0;
    this.isActive = false;
    this._berthTimer = -1;

    eventBus.emit(Events.NET_RELEASED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      debrisId: this.targetDebris?.id,
    });
    if (wasBerthed) {
      // §4.9: jettison consumes the net — say so.
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Catch released — net expended, launcher clear.',
        source: 'HOUSTON', priority: 'info',
      });
    }
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

    /** @type {object|null} Injected deps (player, debrisField) — stored by
     *  init(deps) BEFORE the feature-flag check so a flag-off init still
     *  leaves the references usable when the flag flips on later. */
    this._player = null;
    this._debrisField = null;
    /** @type {object|null} Optional AudioSystem ref for the winch pitch
     *  (Phase B §9.3). Injected via init(deps.audioSystem); optional-chained
     *  so headless tests and the no-audio path stay silent. */
    this._audioSystem = null;
    /** @type {object|null} Optional ArmManager + LassoSystem refs for the
     *  Phase C-lite recovery-corridor test (strut tips, held daughter
     *  catches, lasso cargo cells). Absent ⇒ corridor vacuously clear. */
    this._armManager = null;
    this._lassoSystem = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise inventory to Dyneema Y0 defaults.
   * Called once at game start / after load.
   * @param {object} [deps] — { player, debrisField, audioSystem, armManager,
   *   lassoSystem } context references. `player` backs the mother-pod anchor
   *   provider; `debrisField` backs the Phase-A pin API (pinCapturedDebris);
   *   `audioSystem` backs the Phase-B winch pitch; `armManager`/`lassoSystem`
   *   back the Phase C-lite recovery-corridor test. Optional — the no-arg
   *   call stays valid for headless tests and test-main-wiring.
   */
  init(deps = {}) {
    this._player = deps.player || this._player || null;
    this._debrisField = deps.debrisField || this._debrisField || null;
    this._audioSystem = deps.audioSystem || this._audioSystem || null;
    this._armManager = deps.armManager || this._armManager || null;
    this._lassoSystem = deps.lassoSystem || this._lassoSystem || null;
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._motherPodInventory = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
    this._motherPodMax       = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
    this._initialized = true;

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
      podMax: [...this._motherPodMax],
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

      // ── Mother per-frame housekeeping (Phase B) ─────────────────────────
      if (net._isMother) {
        // §9.8 — dt-robust tug delivery. The feel vector seeded at CAPTURED is
        // fed into _rcsVelocity over NET_TUG_WINDOW_S; step is clamped to the
        // remaining window, so Σ(step/window) === 1 exactly at any frame rate.
        // The residual decay is RCS_DAMPING's inherited per-frame behaviour
        // (shared with manual RCS — deliberately out of scope).
        if (net._tugFeelScene && net._tugElapsed < (CN.NET_TUG_WINDOW_S ?? 0.65)) {
          const player = this._player;
          if (player && player._rcsVelocity) {
            const windowS = CN.NET_TUG_WINDOW_S ?? 0.65;
            const step = Math.min(dt, windowS - net._tugElapsed);
            net._tugElapsed += step;
            player._rcsVelocity.addScaledVector(net._tugFeelScene, step / windowS);
            // Minor 6 (review): mirror the manual-RCS clamp
            // (PlayerSatellite.js:5193) — the tug must not stack past
            // RCS_MAX_SPEED on top of existing drift.
            const maxV = Constants.RCS_MAX_SPEED;
            if (maxV > 0 && player._rcsVelocity.length() > maxV) {
              player._rcsVelocity.normalize().multiplyScalar(maxV);
            }
          } else {
            net._tugElapsed = CN.NET_TUG_WINDOW_S ?? 0.65;   // no player: close the window
          }
        }

        // Review item 3: the flight whistle means "projectile in flight" —
        // stop it the frame the net leaves LAUNCHING/SPINNING_UP/FLIGHT. A
        // state poll, NOT the NET_BRAKE_FIRED hook: that event is gated on
        // FEATURE_FLAGS.NET_CEREMONY, and plan §6 forbids routing anything
        // load-bearing through a flag REALITY_MODE forces false.
        const inFlight = net.state === STATES.LAUNCHING
          || net.state === STATES.SPINNING_UP
          || net.state === STATES.FLIGHT;
        if (!inFlight) this._audioSystem?.stopNetFlightWhistle?.();

        // §9.3: drive the winch pitch from the live reel distance.
        // Cheap — one setTargetAtTime on a running loop, no-op otherwise.
        if (net.state === STATES.REELING && net._remainingM != null) {
          this._audioSystem?.updateNetReelPitch?.(net._remainingM, net._reelSeedM);
        }
      }

      // ── Mother BERTHED hold + securing timer (mother-net-reel plan §8 A2) ──
      // The projectile's own switch no-ops on BERTHED; the per-frame hold runs
      // here because the system owns the player/debrisField refs. The berth
      // survives pruning (isActive stays true, state never STOWED/RELEASED).
      if (net.state === STATES.BERTHED) {
        const holding = net.updateBerthHold(dt);
        if (!holding) {
          // Dead target while docked (§4.19 mission-transition guard): clear
          // the dock, pins and visual, free the launcher. Do NOT stow as if
          // the catch succeeded (the daughter's death-in-hand behaviour).
          this._teardownBerth(net);
          this.activeNets.splice(i, 1);
          continue;
        }
        if (!net._berthProcessed && net._berthTimer > 0) {
          net._berthTimer -= dt;
          if (net._berthTimer <= 0) {
            // §19 terminal credit: the existing GameFlowManager CATCH_PROCESSED
            // path awards score + salvage + clearDebris() + removeDebris +
            // autosave. Order matters — removeDebris emits DEBRIS_REMOVED, so
            // pins + visual are cleared on that signal too (idempotently).
            net._berthProcessed = true;
            eventBus.emit(Events.CATCH_PROCESSED, {
              debrisId: net.targetDebris?.id,
              armId:    null,
              source:   'mother',
              podIndex: net.podIndex,
              method:   'mother',
            });
            this._teardownBerth(net);
            this.activeNets.splice(i, 1);
            continue;
          }
        }
      }

      // Remove terminal nets + handle inventory / cargo consequences.
      // BERTHED is deliberately absent — a berthed net must hit neither the
      // prune predicate nor the STOWED cargo hand-off (§8 A2).
      if (!net.isActive || net.state === STATES.STOWED || net.state === STATES.RELEASED) {
        // Mother exits (miss / release / forceResolve) — clear any pins the
        // reel/berth wrote. Idempotent; most exits fire before any pin exists.
        if (net._isMother) this._clearCatchPins(net.targetDebris);

        // §3.5: Net is NOT consumed on miss — restore inventory when empty net reels back
        if (net.state === STATES.STOWED && net.catchResult === 'miss') {
          this._restoreNetInventory(net);
        }

        // ST-9.4d: Cargo hand-off — successful capture reeled to platform.
        // Gated OFF for mother catches (§8 A2): the berth + securing timer
        // replaces the daughter's cargo-store path (a mother catch berths, it
        // is never stuffed into a cargo cell it cannot fit).
        if (net.state === STATES.STOWED && net.catchResult === 'success' && net.capturedMass > 0
            && !(net.podIndex >= 0 && net.armIndex < 0)) {
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

        // Manual jettison from BERTHED ([K]) — re-seat the orbit so the whale
        // resumes from where it was released, not wherever its own orbit
        // propagated to while pinned (§8 A2). Net is expended (no restore).
        if (net.state === STATES.RELEASED && net._isMother) {
          this._reseatOrbitOnRelease(net);
        }

        this.activeNets.splice(i, 1);
      }
    }
  }

  /**
   * §8 A2 — the pin-clearing chokepoint that did not exist. Mother nets have
   * no ArmUnit, so nothing else ever clears the debris pin flags the
   * reel/berth writes. Idempotent by design; call from EVERY mother exit.
   * @param {object|null} debris
   * @private
   */
  _clearCatchPins(debris) {
    if (!debris) return;
    debris._captured = false;
    debris._armPinned = false;
    debris._armPinPos = null;
    debris._catchRenderMin = 0;
  }

  /**
   * §8 A2 — tear down a berthed catch: clear pins, drop the docked slot, free
   * the launcher. The bag visual is removed by CaptureNetVisual's own
   * STOWED/RELEASED handling via the fade path; here we emit nothing visual —
   * the net is spliced out of activeNets by the caller, and _getNet then
   * returns null so the visual removes itself next frame.
   * @param {NetProjectile} net
   * @private
   */
  _teardownBerth(net) {
    this._clearCatchPins(net.targetDebris);
    net.isActive = false;
    net._berthTimer = -1;
  }

  /**
   * §8 A2 — re-seat the released catch's orbit from the release position +
   * the mother's velocity. DebrisField.update skips orbit propagation only
   * for _onboardingPinned, NOT _armPinned, so a pinned catch's trueAnomaly
   * kept advancing and a jettisoned whale would snap to wherever its own
   * orbit went. Rebuild debris.orbit from the pin following
   * applyCartesianImpulse's recipe. The arm path deliberately accepts the
   * snap (ArmUnit.js:4494-4497) — do not copy that 2 m in front of the camera.
   * @param {NetProjectile} net
   * @private
   */
  _reseatOrbitOnRelease(net) {
    const d = net.targetDebris;
    const player = this._player;
    if (!d || !player || !d._scenePosition || !d.orbit) return;
    // Review fix: no metres-scale fallback — Constants.SCENE_SCALE is 0.01
    // (km-scale); the old `|| 0.00001` silently produced a ~1000× error on a
    // falsy read (headless mock).
    const SCENE_SCALE = Constants.SCENE_SCALE;
    if (!(SCENE_SCALE > 0)) return;
    // cartesianToKeplerian wants km / km/s in the Y-up scene frame (the same
    // convention applyCartesianImpulse uses: scene units ÷ SCENE_SCALE → km).
    const rKm = {
      x: d._scenePosition.x / SCENE_SCALE,
      y: d._scenePosition.y / SCENE_SCALE,
      z: d._scenePosition.z / SCENE_SCALE,
    };
    const v = (typeof player.getVelocity === 'function') ? player.getVelocity() : null;
    if (!v) return;
    const newOrbit = cartesianToKeplerian(rKm, { x: v.x, y: v.y, z: v.z });
    // Review fix: validate EVERY element before writing — inclination comes
    // from acos(hz/h) and is NaN on the degenerate h=0 geometry (radial
    // release velocity), and only semiMajorAxis was checked, so a jettison
    // could permanently corrupt the whale's orbit with NaN.
    if (!newOrbit
        || !isFinite(newOrbit.semiMajorAxis) || newOrbit.semiMajorAxis <= 0
        || !isFinite(newOrbit.eccentricity)
        || !isFinite(newOrbit.inclination)
        || !isFinite(newOrbit.raan)
        || !isFinite(newOrbit.argPerigee)
        || !isFinite(newOrbit.trueAnomaly)) return;
    // DebrisField orbits store semiMajorAxis in SCENE UNITS (same convention
    // as PlayerSatellite.orbit — applyCartesianImpulse writes sma × SCENE_SCALE).
    d.orbit.semiMajorAxis = newOrbit.semiMajorAxis * SCENE_SCALE;
    d.orbit.eccentricity  = Math.max(0, Math.min(0.1, newOrbit.eccentricity));
    d.orbit.inclination   = newOrbit.inclination;
    d.orbit.raan          = newOrbit.raan;
    d.orbit.argPerigee    = newOrbit.argPerigee;
    d.orbit.trueAnomaly   = newOrbit.trueAnomaly;
    if (typeof newOrbit.meanMotion === 'number' && isFinite(newOrbit.meanMotion)) {
      d.orbit.meanMotion = newOrbit.meanMotion;
    }
  }

  /**
   * §8 A2 — berthed mass for the translational thrust scaling (plan §4.4).
   * Structured as a sum over attachments so a future CoM upgrade is
   * non-breaking. Replaces the dead getCapturedNetMass for the mother path.
   * @returns {number} kg currently berthed at the mother launcher
   */
  getBerthedMassKg() {
    let sum = 0;
    for (const net of this.activeNets) {
      if (net._isMother && net.state === STATES.BERTHED) sum += net.capturedMass || 0;
    }
    return sum;
  }

  /**
   * §8 A2 — single docked catch slot. The launcher is one nose patch; a
   * berthed whale obstructs every cell, so a second fire is refused while
   * anything is berthed.
   * @returns {NetProjectile|null}
   */
  getDockedCatch() {
    return this.activeNets.find(n => n._isMother && n.state === STATES.BERTHED) || null;
  }

  /**
   * §8 A2 — manual jettison ([K]). Releases the berthed catch: pins cleared,
   * orbit re-seated, net expended, launcher freed. The securing timer (if
   * still running) is cancelled — jettison before expiry means NO score.
   * @returns {boolean} whether a docked catch was released
   */
  releaseDockedCatch() {
    const net = this.getDockedCatch();
    if (!net) return false;
    return net.release();
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
    // Phase B §9.5: kill any running net loops — a reset drops every net with
    // no terminal events, so the whistle/winch would otherwise stick (the
    // classic bug). Optional-chained: headless tests inject no audioSystem.
    this._audioSystem?._stopNetLoops?.();
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
        text: 'Mother net magazine empty. Restock at shop [B]',
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'warning',
      });
      return null;
    }
    if (this._cooldownTimers.has(`pod_${podIndex}`)) {
      const secs = this._cooldownTimers.get(`pod_${podIndex}`) || 0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Mother net reloading. ${Math.ceil(secs)}s`,
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'info',
      });
      return null;
    }
    // §8 A2 launcher-blocked gate: one nose patch, one docked catch. A berthed
    // whale obstructs every cell, so a second fire is refused until the catch
    // is processed (securing timer) or jettisoned [K].
    if (this.getDockedCatch()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Launcher blocked — jettison catch [K] to clear.',
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'warning',
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
      // Mother-pod launcher anchor: polled every frame for the pod muzzle's
      // CURRENT world position (scene units). Without it every
      // `_sourceArm?.position` block is skipped and the net renders at a
      // stale absolute point that drifts ~45 km apparent in the first 0.65 s
      // (mother-net-reel plan §7.2). Falls back to the metres-based test
      // path when no player ref was injected (headless mocks).
      anchorProvider: this._player
        ? (out) => (typeof this._player.getNetPodPositionInto === 'function'
            ? this._player.getNetPodPositionInto(podIndex, out)
            : out)
        : null,
    });
    // Phase-A berth context (player for the ship-relative reel frame,
    // debrisField for the pinCapturedDebris API — plan §1.1). Phase C-lite
    // adds armManager + lassoSystem for the recovery-corridor test (§10).
    net._ctx = {
      player: this._player,
      debrisField: this._debrisField,
      armManager: this._armManager,
      lassoSystem: this._lassoSystem,
    };

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

  /** Set mother pod inventory (persistence restore). Clamped to per-pod max. */
  setMotherPodInventory(counts) {
    if (Array.isArray(counts)) {
      this._motherPodInventory = [
        Math.max(0, Math.min(counts[0] || 0, this._motherPodMax[0] || 0)),
        Math.max(0, Math.min(counts[1] || 0, this._motherPodMax[1] || 0)),
      ];
    }
  }

  /** True when at least one Mother pod has space for another net. */
  hasMotherPodSpace() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return false;
    for (let i = 0; i < this._motherPodInventory.length; i++) {
      if ((this._motherPodInventory[i] || 0) < (this._motherPodMax[i] || 0)) return true;
    }
    return false;
  }

  /**
   * Load exactly one Large Net into the emptiest pod that has space (shop
   * restock — one net per 250 cr purchase, matching REPLACEMENT_COST; net
   * ladder Phase B, mirrors the daughters' per-net reload economy).
   * @returns {boolean} true if a net was loaded
   */
  loadOneMotherNet() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return false;
    // Pick the pod with the most free space (largest max−current), so repeated
    // buys top the pods off evenly.
    let bestPod = -1;
    let bestFree = 0;
    for (let i = 0; i < this._motherPodInventory.length; i++) {
      const free = (this._motherPodMax[i] || 0) - (this._motherPodInventory[i] || 0);
      if (free > bestFree) { bestFree = free; bestPod = i; }
    }
    if (bestPod < 0) return false;
    this._motherPodInventory[bestPod]++;
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
      podMax: [...this._motherPodMax],
    });
    return true;
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
   * Whether a mother pod is in its post-fire cooldown. InputManager's
   * pre-slew gate calls this (it was wired behind a `typeof` guard against a
   * method that never existed — mother-net-reel plan §2 C4 — so a cooldown
   * fire used to run the entire aim slew before being refused).
   * @param {number} podIndex
   * @returns {boolean}
   */
  isMotherPodOnCooldown(podIndex) {
    return this.getCooldown('pod', podIndex) > 0;
  }

  /**
   * Net class fired by a mother pod. The lead-aim provider in InputManager
   * calls this for the launch speed (previously hardcoded `10.0 * M` behind
   * another typeof guard — §2 C4 — which silently desynced from any retune).
   * @param {number} podIndex — currently both pods fire LARGE
   * @returns {object} CN.LARGE
   */
  getMotherNetClass(podIndex) { // eslint-disable-line no-unused-vars
    return CN.LARGE;
  }

  /**
   * True when any mother-pod net (podIndex ≥ 0) is in a non-terminal,
   * non-berthed state. Firing a second net from the same launcher frame
   * breaks the VISUAL (the visual map is keyed `pod_${podIndex}` and
   * early-returns when the key exists — mother-net-reel plan §4.5) as well
   * as the physics, so the InputManager refusal gates on this. BERTHED is
   * excluded — a berthed catch has its own dedicated refusal ("Launcher
   * blocked — jettison [K]") via getDockedCatch(), and including it here
   * made that message unreachable (review finding).
   * @returns {boolean}
   */
  hasMotherNetInFlight() {
    return this.activeNets.some(n =>
      n.podIndex >= 0 && n.isActive
      && n.state !== STATES.STOWED && n.state !== STATES.RELEASED
      && n.state !== STATES.BERTHED);
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
      // Ensure the per-pod max is seeded (init() normally does this before
      // restore, but guard for out-of-order load paths) so the clamp below has
      // a real ceiling. Then clamp restored counts to the current max — a save
      // written before the net-ladder MAGAZINE_SIZE downsize can carry counts
      // above the new cap and must not load an over-max magazine.
      if (!this._motherPodMax[0] && !this._motherPodMax[1]) {
        this._motherPodMax = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
      }
      this._motherPodInventory = [
        Math.max(0, Math.min(state.motherPodInventory[0] ?? 0, this._motherPodMax[0] || 0)),
        Math.max(0, Math.min(state.motherPodInventory[1] ?? 0, this._motherPodMax[1] || 0)),
      ];
    }
    if (typeof state.playerHasFragmented === 'boolean') {
      this._playerHasFragmented = state.playerHasFragmented;
    }
    this._initialized = true;

    // Emit so listeners (pod caps, HUD NetInventoryPanel) sync to the restored
    // magazine — restore previously mutated inventory silently, leaving any
    // listener showing stale state after a load. Mirrors init()'s emit.
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
      podMax: [...this._motherPodMax],
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §4  Singleton Export
// ═══════════════════════════════════════════════════════════════════════════

/** Singleton CaptureNetSystem instance. */
export const captureNetSystem = new CaptureNetSystem();
export default captureNetSystem;
