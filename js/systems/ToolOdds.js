/**
 * ToolOdds.js — unified live capture-tool odds model
 * (capture-feedback overhaul, Phase 1a).
 *
 * One pure module computes the success probability of EVERY verb in a
 * daughter's (or the mother's) toolset against the active target, using the
 * SAME pure functions / constants the resolve rolls use:
 *
 *   NET     → computeClingProbability (CaptureNet.js) × strain survival
 *             (mirrors ArmUnit._checkNetIntegrityOnReel) × width gate
 *   MAGNET  → MAGNETIC_GRAPPLE P_GRIP_* forks (mirrors ArmUnit._resolveMagnetGrip)
 *   GRIPPER → GRIPPER_GRAPPLE P_GRIP_FIXTURED/UNFIXTURED (ArmUnit._resolveGripperLatch)
 *   PAD     → PAD_CONTACT mode resolution + P_GRIP_BY_MODE (ArmUnit._resolvePadGrip)
 *
 * "Honest numbers" contract: any % shown on the HUD is the % rolled at
 * resolve time, given the same state. Where the resolve depends on state that
 * only exists after firing (in-flight spin decay), the pre-fire estimate
 * mirrors the flight model (spinFraction = 1 − SPIN_DECAY_PER_S × tof) so the
 * displayed odds and the resolve roll agree.
 *
 * Design notes:
 *   • PURE + Node-safe — no THREE, no DOM, no eventBus. Fully unit-testable
 *     (pattern: ToolRecommender.js).
 *   • Each tool resolves to { p, blocker, hint }:
 *       p       — probability ∈ [0,1], or null when the verb is not rollable
 *                 (empty magazine / tool offline) — display as '--', not 0%.
 *       blocker — short word naming the dominant suppressor ('WIDE', 'HEAVY',
 *                 'NON-FERR', 'EMPTY', 'FAST', 'RANGE', 'TUMBLE', 'STRAIN 26%',
 *                 'NO-FIX', 'NO-MODE', 'OFFLINE') or null.
 *       hint    — the single biggest lever the player can pull right now.
 *
 * @module systems/ToolOdds
 */

import { Constants } from '../core/Constants.js';
import {
  computeClingProbability,
  recommendCaptureMode,
  getNetClassForType,
} from '../entities/CaptureNet.js';

/** Preference order for ▶ tie-breaks (matches ToolRecommender). */
export const TOOL_PREF_ORDER = ['NET', 'MAGNET', 'GRIPPER', 'PAD'];

/**
 * Short HUD label for a verb (names are footnotes; the % is the hero). Single
 * source of truth so the reticle odds strip and the target-panel badge can
 * never disagree on the displayed vocabulary.
 * @param {string} kind
 * @returns {string}
 */
export function toolShortLabel(kind) {
  return kind === 'MAGNET' ? 'MAG' : kind === 'GRIPPER' ? 'GRAB' : kind;
}

/**
 * Strain-slip failure probability at reel start — EXACT mirror of the math in
 * ArmUnit._checkNetIntegrityOnReel (the resolve site).
 * @param {number} payloadMass — kg
 * @param {number} ratedMass   — net class MAX_CAPTURE_MASS (kg)
 * @returns {number} P(net slips) ∈ [0, NET_STRAIN_FAIL_PROB_MAX]
 */
export function computeStrainFailProbability(payloadMass, ratedMass) {
  if (!(payloadMass > 0) || !(ratedMass > 0)) return 0;
  const strain = payloadMass / ratedMass;
  const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
  if (strain <= safe) return 0;
  const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX ?? 0;
  const t = Math.min(1, (strain - safe) / Math.max(1e-6, 1 - safe));
  return pMax * t;
}

/**
 * Pre-fire estimate of the net's spin fraction at contact. Mirrors the flight
 * model: spin settles at SPIN_HZ when FLIGHT begins, then decays at
 * SPIN_HZ × SPIN_DECAY_PER_S per second of flight (CaptureNet._updateFlight),
 * with time-of-flight = range / LAUNCH_SPEED.
 * @param {number} range — metres to target
 * @param {object} netClass — CN.LARGE / MEDIUM / SMALL
 * @returns {number} estimated spinFraction at contact ∈ [0, 1]
 */
export function estimateSpinFractionAtContact(range, netClass) {
  const CN = Constants.CAPTURE_NET;
  const launchSpeed = (netClass && netClass.LAUNCH_SPEED) || 10;
  const decay = CN.SPIN_DECAY_PER_S ?? 0;
  const tof = Math.max(0, range) / Math.max(1e-6, launchSpeed);
  return Math.max(0, 1 - decay * tof);
}

/**
 * Mirror of the fire-time capture-mode resolution (fireMotherNet /
 * fireDaughterNet): NET_CEREMONY forces CINCH unless an explicit mode is
 * passed; otherwise the auto-recommender picks. The display must use the same
 * pBase the resolve will.
 * @param {object|null} target
 * @returns {'SLAM_WRAP'|'CINCH'}
 */
export function resolveCaptureModeForOdds(target) {
  const MODES = Constants.CAPTURE_NET.MODES;
  if (Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.NET_CEREMONY) return MODES.CINCH;
  return recommendCaptureMode(target);
}

/**
 * Pure mirror of ArmUnit._resolvePadMode — deterministic adhesion-mode pick
 * from surface metadata (§5.3 priority).
 * @param {{material?:string, surfaceRoughness?:number}} target
 * @param {number} uvDosesRemaining
 * @returns {string|null} mode or null (NO_MODE)
 */
export function resolvePadModeForOdds(target, uvDosesRemaining) {
  const material = target ? target.material : undefined;
  const roughness = (target && typeof target.surfaceRoughness === 'number')
    ? target.surfaceRoughness : 0.5;
  if (material === 'steel' || material === 'iron_alloy') return 'magnet';
  if (material === 'mli_mylar' || roughness > 0.7) return 'hooks';
  if (material === 'aluminum' || material === 'kapton'
      || material === 'glass_ceramic' || material === 'solar_cell') return 'gecko';
  if (material === 'composite') return 'electrostatic';
  if ((uvDosesRemaining || 0) > 0) return 'uv_cure';
  return null;
}

/**
 * NET odds: cling probability × strain survival × width/range gates.
 * @private
 */
function computeNetOdds(opts) {
  const CN = Constants.CAPTURE_NET;
  const target = opts.target || null;
  const netClass = opts.netClass;
  const range = opts.range;

  if (opts.netCount === 0) {
    return { p: null, blocker: 'EMPTY', hint: 'magazine empty. Restock' };
  }

  // ── Deterministic gates ──
  // Width: presented width (Phase 2) falls back to the scalar sizeMeter.
  const widthM = (typeof opts.presentedWidthM === 'number')
    ? opts.presentedWidthM
    : ((target && target.sizeMeter) || 0);
  const dia = (netClass && netClass.DIAMETER) || 0;
  if (dia > 0 && widthM > dia) {
    return { p: 0, blocker: 'WIDE', hint: 'too wide for the net mouth' };
  }
  // Range: beyond tether pay-out or max flight time the shot times out — a
  // deterministic miss (CaptureNet._updateFlight).
  const launchSpeed = (netClass && netClass.LAUNCH_SPEED) || 10;
  const maxReach = Math.min(
    (netClass && netClass.TETHER_MAX) || Infinity,
    launchSpeed * (CN.MAX_FLIGHT_TIME || Infinity),
  );
  if (range > maxReach) {
    return { p: 0, blocker: 'RANGE', hint: 'too far. Close in' };
  }

  // ── Probabilistic stack (same fn as NetProjectile._resolveCatch) ──
  const mode = resolveCaptureModeForOdds(target);
  const pBase = mode === CN.MODES.CINCH
    ? CN.CINCH_P_BASE.RIGHT_HARDER
    : CN.SLAM_P_BASE.RIGHT_HARDER;
  const tumbleOn = !Constants.isFeatureEnabled || Constants.isFeatureEnabled('LASER_DESPIN');
  const tumbleRate = (tumbleOn && target && typeof target.tumbleRate === 'number')
    ? target.tumbleRate : null;
  const spinFraction = estimateSpinFractionAtContact(range, netClass);

  const pCling = computeClingProbability({
    pBase,
    vRel: launchSpeed,           // contact speed = launch speed (flight model)
    vOptimal: launchSpeed,
    range,
    roughness: (target && target.surfaceRoughness) ?? 1.0,
    spinFraction,
    targetTumbleRate: tumbleRate,
  });

  // Strain survival (reel-start slip, ArmUnit._checkNetIntegrityOnReel).
  const mass = (target && target.mass) || 0;
  const rated = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
  const strainFailP = computeStrainFailProbability(mass, rated);
  const p = pCling * (1 - strainFailP);

  // ── Dominant suppressor → blocker word + lever hint ──
  const losses = [];
  if (strainFailP > 0) {
    losses.push({
      loss: strainFailP,
      blocker: `STRAIN ${Math.round(strainFailP * 100)}%`,
      hint: 'heavy catch. Slips likely above 80% rated',
    });
  }
  if (tumbleRate != null) {
    const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10, PER_DEG: 0.012, FLOOR: 0.4 };
    const tumbleDeg = Math.abs(tumbleRate) * (180 / Math.PI);
    if (tumbleDeg > P.IN_SPEC_DEG) {
      const fTumble = Math.max(P.FLOOR, 1 - (tumbleDeg - P.IN_SPEC_DEG) * P.PER_DEG);
      losses.push({
        loss: 1 - fTumble,
        blocker: 'TUMBLE',
        hint: `tumbling ${Math.round(tumbleDeg)}\u00B0/s \u2014 de-spin [H]`,
      });
    }
  }
  const fDistance = Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));
  if (fDistance < 1.0) {
    losses.push({ loss: 1 - fDistance, blocker: 'RANGE', hint: 'edge of envelope. Close in' });
  }
  const fSpin = Math.max(0.5, Math.min(1.2, spinFraction));
  if (fSpin < 1.0) {
    losses.push({ loss: 1 - fSpin, blocker: 'SPIN', hint: 'long flight bleeds net spin. Close in' });
  }
  losses.sort((a, b) => b.loss - a.loss);
  const top = losses[0] || null;

  return {
    p: Math.max(0, Math.min(1, p)),
    blocker: top ? top.blocker : null,
    hint: top ? top.hint : 'good shot',
  };
}

/** MAGNET odds — mirrors ArmUnit._magnetGripProbability/_resolveMagnetGrip. @private */
function computeMagnetOdds(target) {
  const MAG = Constants.MAGNETIC_GRAPPLE || {};
  const mass = (target && target.mass) || 0;
  if (mass > (MAG.MAX_DEBRIS_MASS_KG || 500)) {
    return { p: 0, blocker: 'HEAVY', hint: 'beyond EPM mass limit' };
  }
  if (target && target.ferromagnetic === true) {
    return { p: MAG.P_GRIP_FERROUS ?? 0.95, blocker: null, hint: 'ferrous hull. Direct grip' };
  }
  if (target && target.hasFerrousFasteners === true) {
    return { p: MAG.P_GRIP_FASTENERS ?? 0.40, blocker: null, hint: 'ferrous fasteners. Bolt-latch' };
  }
  return {
    p: MAG.P_GRIP_NON_FERROUS ?? 0.05,
    blocker: 'NON-FERR',
    hint: 'non-ferrous. Residual flux only',
  };
}

/** GRIPPER odds — mirrors ArmUnit._resolveGripperLatch. @private */
function computeGripperOdds(target) {
  if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('WEAVER_GRIPPER')) {
    return { p: null, blocker: 'OFFLINE', hint: 'not yet equipped' };
  }
  const G = Constants.GRIPPER_GRAPPLE || {};
  const mass = (target && target.mass) || 0;
  if (mass > (G.MAX_DEBRIS_MASS_KG || 2000)) {
    return { p: 0, blocker: 'HEAVY', hint: 'beyond jaw mass limit' };
  }
  if (target && target.hasGrappleFixture === true) {
    return { p: G.P_GRIP_FIXTURED ?? 0.90, blocker: null, hint: 'fixture latch' };
  }
  return {
    p: G.P_GRIP_UNFIXTURED ?? 0.10,
    blocker: 'NO-FIX',
    hint: 'no fixture to grab. Net it',
  };
}

/** PAD odds — mirrors ArmUnit._resolvePadMode/_resolvePadGrip. @private */
function computePadOdds(target, opts) {
  if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('SPINNER_PAD')) {
    return { p: null, blocker: 'OFFLINE', hint: 'not yet equipped', mode: null };
  }
  const P = Constants.PAD_CONTACT || {};
  // Contact-velocity gate: faster than the soft-contact regime → deterministic bounce.
  if (typeof opts.contactVel === 'number' && opts.contactVel > (P.CONTACT_VEL_MAX_M_S ?? 0.2)) {
    return { p: 0, blocker: 'FAST', hint: 'contact too fast. Ease the approach', mode: null };
  }
  const uvDoses = (typeof opts.padUvDoses === 'number') ? opts.padUvDoses : (P.UV_CURE_DOSES_Y0 || 0);
  const mode = resolvePadModeForOdds(target, uvDoses);
  if (!mode) {
    return {
      p: P.P_GRIP_NO_MODE ?? 0.05,
      blocker: 'NO-MODE',
      hint: 'no adhesion mode for this surface',
      mode: null,
    };
  }
  const p = (P.P_GRIP_BY_MODE && P.P_GRIP_BY_MODE[mode] != null)
    ? P.P_GRIP_BY_MODE[mode] : (P.P_GRIP_NO_MODE ?? 0.05);
  return {
    p,
    blocker: null,
    hint: mode === 'uv_cure' ? `uv-cure \u00B7${uvDoses} doses` : `${mode} adhesion`,
    mode,
  };
}

/**
 * Compute live odds for every verb in a toolset against one target.
 *
 * @param {object} opts
 * @param {'weaver'|'spinner'|'mother'} [opts.armType='weaver'] - platform class
 * @param {string[]} [opts.toolset]       - verbs to score (default: class toolset)
 * @param {object|null} [opts.target]     - debris ({mass, sizeMeter, tumbleRate,
 *   surfaceRoughness, material, ferromagnetic, hasFerrousFasteners,
 *   hasGrappleFixture, fragility, ...})
 * @param {number} [opts.range=50]        - metres to target
 * @param {object} [opts.netClass]        - net class override (e.g. CN.LARGE for mother)
 * @param {number} [opts.netCount]        - net magazine count (0 → '--' EMPTY)
 * @param {number} [opts.padUvDoses]      - UV-cure doses remaining
 * @param {number} [opts.contactVel]      - pad approach speed (m/s)
 * @param {number} [opts.presentedWidthM] - Phase 2: orientation-aware presented width
 * @returns {Object<string, {p:number|null, blocker:string|null, hint:string}>}
 */
export function computeToolOdds(opts = {}) {
  const armType = opts.armType || 'weaver';
  const TOOLSETS = Constants.DAUGHTER_TOOLSETS || {};
  const toolset = opts.toolset
    || (armType === 'mother' ? ['NET'] : (TOOLSETS[armType] || ['NET']).slice());
  const target = opts.target || null;
  const range = (typeof opts.range === 'number') ? opts.range : 50;
  const netClass = opts.netClass || getNetClassForType(armType);

  /** @type {Object<string, {p:number|null, blocker:string|null, hint:string}>} */
  const odds = {};
  for (const kind of toolset) {
    switch (kind) {
      case 'NET':
        odds.NET = computeNetOdds({ target, range, netClass, netCount: opts.netCount, presentedWidthM: opts.presentedWidthM });
        break;
      case 'MAGNET':
        odds.MAGNET = computeMagnetOdds(target);
        break;
      case 'GRIPPER':
        odds.GRIPPER = computeGripperOdds(target);
        break;
      case 'PAD':
        odds.PAD = computePadOdds(target, opts);
        break;
      default:
        odds[kind] = { p: null, blocker: 'OFFLINE', hint: 'unknown tool' };
    }
  }
  return odds;
}

/**
 * ▶ recommendation = argmax p with two stabilisers:
 *   • RECOMMEND_MARGIN (relative): a later-preference tool only takes the ▶
 *     when it beats the incumbent by more than the margin fraction (no
 *     flip-flopping on noise-level differences; NET stays primary on near-ties).
 *   • uv_cure-resolved PAD never takes the ▶ (finite consumable, last resort —
 *     its honest % still displays).
 *
 * @param {Object<string, {p:number|null, mode?:string}>} odds
 * @param {string[]} [toolset] — fallback order (first entry wins when nothing is rollable)
 * @returns {string} recommended tool kind
 */
export function computeBestTool(odds, toolset) {
  const margin = (Constants.TOOL_ODDS && Constants.TOOL_ODDS.RECOMMEND_MARGIN) ?? 0.15;
  let best = null;
  let bestP = -1;
  for (const kind of TOOL_PREF_ORDER) {
    const o = odds[kind];
    if (!o || o.p == null) continue;
    if (kind === 'PAD' && o.mode === 'uv_cure') continue;  // last-resort consumable
    if (best === null ? o.p > 0 : o.p > bestP * (1 + margin)) {
      best = kind;
      bestP = o.p;
    }
  }
  if (best) return best;
  return (toolset && toolset[0]) || 'NET';
}

export default { computeToolOdds, computeBestTool, computeStrainFailProbability, estimateSpinFractionAtContact, resolveCaptureModeForOdds, resolvePadModeForOdds, toolShortLabel, TOOL_PREF_ORDER };
