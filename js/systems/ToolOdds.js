/**
 * ToolOdds.js — unified live capture-tool odds model. PURE + Node-safe (no THREE, no DOM, no eventBus; pattern:
 * ToolRecommender.js).
 *
 * Computes the success probability of EVERY verb in a daughter's (or the mother's) toolset against the active target, using
 * the SAME pure functions / constants the resolve rolls use:
 *   NET     → computeClingProbability (CaptureNet.js) × strain survival (mirrors ArmUnit._checkNetIntegrityOnReel) × width gate
 *   MAGNET  → MAGNETIC_GRAPPLE P_GRIP_* forks (mirrors ArmUnit._resolveMagnetGrip)
 *   GRIPPER → GRIPPER_GRAPPLE P_GRIP_FIXTURED/UNFIXTURED (ArmUnit._resolveGripperLatch)
 *   PAD     → PAD_CONTACT mode resolution + P_GRIP_BY_MODE (ArmUnit._resolvePadGrip)
 *
 * "Honest numbers" contract: any % shown on the HUD is the % rolled at resolve time, given the same state. Where the resolve
 * depends on state that only exists after firing (in-flight spin decay), the pre-fire estimate mirrors the flight model
 * (spinFraction = 1 − decay × tof, same per-class decay override).
 *
 * Each tool resolves to { p, blocker, hint }:
 *   p       — probability ∈ [0,1], or null when the verb is not rollable (empty magazine / tool offline): display '--', not 0%.
 *   blocker — short word naming the dominant suppressor ('WIDE', 'HEAVY', 'NON-FERR', 'EMPTY', 'FAST', 'RANGE', 'TUMBLE',
 *             'STRAIN 26%', 'NO-FIX', 'NO-MODE', 'OFFLINE') or null.
 *   hint    — the single biggest lever the player can pull right now.
 *
 * @module systems/ToolOdds
 */

import { Constants } from '../core/Constants.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { glassDespinWords } from '../ui/hud/DespinHint.js';
import {
  computeClingLockFactors,
  finishClingProbability,
  computeTumbleModifier,
  recommendCaptureMode,
  getNetClassForType,
  captureNetSystem,
  netMaxReachM,
  fitsMouth,
  strainBandT,
} from '../entities/CaptureNet.js';
import { RAD2DEG, clamp01, clamp } from '../core/MathUtil.js';

/** Preference order for ▶ tie-breaks (matches ToolRecommender). */
export const TOOL_PREF_ORDER = ['NET', 'MAGNET', 'GRIPPER', 'PAD'];

/** Short HUD label for a verb; single source so the reticle odds strip and the target-panel badge never disagree. */
export function toolShortLabel(kind) {
  return kind === 'MAGNET' ? 'MAG' : kind === 'GRIPPER' ? 'GRAB' : kind;
}

/**
 * Strain-slip failure probability at reel start: EXACT mirror of ArmUnit._checkNetIntegrityOnReel. The band ramp is the ONE
 * shared `strainBandT` (homed in CaptureNet.js so the extraction adds no import edge); this applies the one-shot cap
 * (× NET_STRAIN_FAIL_PROB_MAX).
 * @param {number} payloadMass kg
 * @param {number} ratedMass net class MAX_CAPTURE_MASS (kg)
 * @returns {number} P(net slips) ∈ [0, NET_STRAIN_FAIL_PROB_MAX]
 */
export function computeStrainFailProbability(payloadMass, ratedMass) {
  const t = strainBandT(payloadMass, ratedMass);
  if (t <= 0) return 0;
  const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX ?? 0;
  return pMax * t;
}

/**
 * Pre-fire estimate of the net's spin fraction at contact. Mirrors the flight model: spin settles at SPIN_HZ when FLIGHT
 * begins, then decays at SPIN_HZ × decay per second of flight (CaptureNet._updateFlight); time-of-flight = range /
 * LAUNCH_SPEED. The decay honours the per-class override like the flight code (netClass.SPIN_DECAY_PER_S ??
 * CN.SPIN_DECAY_PER_S — §11.2 LARGE resolution: the whale net bleeds at 0.04/s, daughters at the shared 0.08/s).
 * @param {number} range metres to target
 * @param {object} netClass CN.LARGE / MEDIUM / SMALL
 * @returns {number} estimated spinFraction at contact ∈ [0, 1]
 */
export function estimateSpinFractionAtContact(range, netClass) {
  const CN = Constants.CAPTURE_NET;
  const launchSpeed = (netClass && netClass.LAUNCH_SPEED) || 10;
  const decay = (netClass && netClass.SPIN_DECAY_PER_S) ?? CN.SPIN_DECAY_PER_S ?? 0;
  const tof = Math.max(0, range) / Math.max(1e-6, launchSpeed);
  return Math.max(0, 1 - decay * tof);
}

/**
 * Mirror of the fire-time capture-mode resolution (fireMotherNet / fireDaughterNet): NET_CEREMONY forces CINCH unless an
 * explicit mode is passed; otherwise the auto-recommender picks. The display must use the same pBase the resolve will.
 * @returns {'SLAM_WRAP'|'CINCH'}
 */
export function resolveCaptureModeForOdds(target) {
  const MODES = Constants.CAPTURE_NET.MODES;
  if (Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.NET_CEREMONY) return MODES.CINCH;
  return recommendCaptureMode(target);
}

/**
 * Pure mirror of ArmUnit._resolvePadMode: deterministic adhesion-mode pick from surface metadata (§5.3 priority).
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
 * Pre-fire NET-odds lock cache (CAPTURE_NET.md §10 concern 3). The §3.3 stack is 6+ multiplicative factors and the HUD path
 * must cost ≤1 ms/frame, so lock-stable factors are precomputed at target-lock, not per frame. One cache object per odds
 * OWNER (per arm, one for the mother badge), allocated ONCE at owner setup and mutated in place, never per frame
 * (CaptureNet scratch discipline).
 *
 * Cached (lock-stable): capture mode → pBase, the cling prefix pBase×f_velocity×f_contact×f_roughness (+ f_tension and the
 * sure-shot velocity gate), strain survival (mass vs rated). Live every call: range gates, presented-width gate,
 * f_distance(range), f_spin (pure function of range), the loss ranking. f_tumble sits in between (epsilon trigger below).
 *
 * INVALIDATION CONTRACT: input-keyed; the lock-stable bundle recomputes iff an echoed input changed:
 *  • target changed (reference): every target-derived product may differ on another body.
 *  • lock re-acquire: owners force `valid = false` on their lock-entry seam (ArmUnit SK entry); pooled debris objects can be
 *    recycled between locks, so reference identity alone is not proof the inputs survived unlock.
 *  • target.surfaceRoughness / material-derived inputs: no shipped code mutates these mid-lock (spawn-derived,
 *    debrisFerrous.js; upgrades route to config.*, audited in upgradeEffectRoutes.js), but the dev/QA harness
 *    (__netScenario) and future writers do; the echo fails closed to a recompute instead of a stale display.
 *  • target.mass / netClass.MAX_CAPTURE_MASS: strain survival inputs (same rationale; the netClass echo pins the pair).
 *  • target.hasSolarPanels / target.vRel changed, NET_CEREMONY flipped: capture-mode inputs; mode picks pBase (§3.4).
 *  • LASER_DESPIN flipped (tumbleOn): governs whether tumble is read at all.
 *  • |target.tumbleRate − rate-at-compute| > NET_TUMBLE_PENALTY.RATE_EPS_RAD_S: the despin laser (0.30 rad/s²) and MAGNET eddy
 *    damp (0.10 rad/s²) move tumble continuously MID-LOCK, so an at-lock snapshot would freeze the odds-climb loop the despin
 *    laser exists for. Only f_tumble recomputes on this trigger (tumbleComputes), not the lock bundle. A value-delta check,
 *    not DESPIN_* event wiring, because tumbleRate has non-despin writers too (capture-torque settle → 0, tumble-remainder
 *    resume). The epsilon sits orders below the smallest real per-frame despin step, so every real write recomputes (the
 *    cache-equality contract stays exact) while bit-stable reads skip the work.
 *
 * Callers that pass no cache (TargetPanel per-row badges at 2 Hz, ToolRecommender one-shots, tests) get the fresh path: both
 * phases recompute into a module scratch, same functions and order, so cached and fresh results are IDENTICAL by construction.
 *
 * @returns {object} a new, invalid lock cache (one per odds owner)
 */
export function makeNetOddsLockCache() {
  return {
    // input echo (staleness key)
    valid: false,
    target: undefined, netClass: undefined,
    ceremony: undefined, tumbleOn: undefined,
    hasSolarPanels: undefined, vRel: undefined,
    roughness: undefined, mass: undefined, rated: undefined,
    mode: null,
    pBase: 0,
    cling: { fVelocity: 1, fContact: 1, fRoughness: 1, fTension: 1, prefix: 0, sureShotVelOK: false },
    strainFailP: 0,
    strainSurvival: 1,
    // slowly-varying tumble factor (epsilon-triggered; undefined = never computed)
    tumbleRateAtCompute: undefined,
    fTumble: 1,
    tumbleDeg: 0,
    // recompute instrumentation (once-per-lock test guards)
    lockComputes: 0,
    tumbleComputes: 0,
  };
}

/** Fresh-path scratch, forced invalid on every uncached call so both phases recompute (zero per-call allocation). */
const _freshNetOddsCache = makeNetOddsLockCache();

function refreshNetOddsLockCache(cache, target, netClass, tumbleOn) {
  const CN = Constants.CAPTURE_NET;
  const ceremony = !!(Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.NET_CEREMONY);
  const hasSolarPanels = !!(target && target.hasSolarPanels);
  const vRel = target ? target.vRel : undefined;
  const roughness = (target && target.surfaceRoughness) ?? 1.0;
  const mass = (target && target.mass) || 0;
  const rated = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
  if (cache.valid
      && cache.target === target && cache.netClass === netClass
      && cache.ceremony === ceremony && cache.tumbleOn === tumbleOn
      && cache.hasSolarPanels === hasSolarPanels && cache.vRel === vRel
      && cache.roughness === roughness && cache.mass === mass
      && cache.rated === rated) {
    return;
  }
  cache.valid = true;
  cache.target = target;
  cache.netClass = netClass;
  cache.ceremony = ceremony;
  cache.tumbleOn = tumbleOn;
  cache.hasSolarPanels = hasSolarPanels;
  cache.vRel = vRel;
  cache.roughness = roughness;
  cache.mass = mass;
  cache.rated = rated;
  cache.mode = resolveCaptureModeForOdds(target);
  cache.pBase = cache.mode === CN.MODES.CINCH
    ? CN.CINCH_P_BASE.RIGHT_HARDER
    : CN.SLAM_P_BASE.RIGHT_HARDER;
  const launchSpeed = (netClass && netClass.LAUNCH_SPEED) || 10;
  computeClingLockFactors({
    pBase: cache.pBase,
    vRel: launchSpeed,           // contact speed = launch speed (flight model)
    vOptimal: launchSpeed,
    roughness,
  }, cache.cling);
  cache.strainFailP = computeStrainFailProbability(mass, rated);
  cache.strainSurvival = 1 - cache.strainFailP;
  // a lock recompute drops the tumble sub-cache too (new target = new source)
  cache.tumbleRateAtCompute = undefined;
  cache.lockComputes++;
}

function refreshTumbleFactor(cache, tumbleRate) {
  const prev = cache.tumbleRateAtCompute;
  const eps = (Constants.NET_TUMBLE_PENALTY && Constants.NET_TUMBLE_PENALTY.RATE_EPS_RAD_S) ?? 0;
  const unchanged = (typeof prev === 'number' && typeof tumbleRate === 'number')
    ? Math.abs(tumbleRate - prev) <= eps   // NaN compares false → recompute
    : prev === tumbleRate;                 // null↔number/undefined sentinel → recompute
  if (unchanged) return;
  cache.tumbleRateAtCompute = tumbleRate;
  cache.fTumble = computeTumbleModifier(tumbleRate);
  cache.tumbleDeg = (typeof tumbleRate === 'number')
    ? Math.abs(tumbleRate) * RAD2DEG : 0;
  cache.tumbleComputes++;
}

function computeNetOdds(opts) {
  const CN = Constants.CAPTURE_NET;
  const target = opts.target || null;
  const netClass = opts.netClass;
  const range = opts.range;

  if (opts.netCount === 0) {
    return { p: null, blocker: 'EMPTY', hint: 'magazine empty. Restock' };
  }

  // Deterministic gates (live: range/geometry never cached). Width: presented width falls back to the scalar sizeMeter;
  // the verdict routes through the ONE mouth-fit predicate.
  const widthM = (typeof opts.presentedWidthM === 'number')
    ? opts.presentedWidthM
    : ((target && target.sizeMeter) || 0);
  if (!fitsMouth(target, netClass, null, widthM)) {
    return { p: 0, blocker: 'WIDE', hint: 'too wide for the net mouth' };
  }
  // Range: beyond tether pay-out or max flight time the shot times out, a deterministic miss (CaptureNet._updateFlight).
  // netMaxReachM honours the per-class MAX_FLIGHT_TIME override (LARGE = 11 s → 100 m reach).
  const maxReach = netMaxReachM(netClass) || Infinity;
  if (range > maxReach) {
    return { p: 0, blocker: 'RANGE', hint: 'too far. Close in' };
  }

  // Probabilistic stack (same fns as NetProjectile._resolveCatch). Lock-stable factors come from the caller's lock cache
  // when provided; the fresh path recomputes them into the module scratch; identical output either way.
  const tumbleOn = !Constants.isFeatureEnabled || Constants.isFeatureEnabled('LASER_DESPIN');
  const tumbleRate = (tumbleOn && target && typeof target.tumbleRate === 'number')
    ? target.tumbleRate : null;
  const cache = opts.lockCache || _freshNetOddsCache;
  if (cache === _freshNetOddsCache) cache.valid = false; // fresh path: recompute both phases
  refreshNetOddsLockCache(cache, target, netClass, tumbleOn);
  refreshTumbleFactor(cache, tumbleRate);

  const spinFraction = estimateSpinFractionAtContact(range, netClass);
  const pCling = finishClingProbability(cache.cling, {
    range,
    spinFraction,
    fTumble: cache.fTumble,
  });

  // Strain survival (reel-start slip, ArmUnit._checkNetIntegrityOnReel): lock-stable, applied outside the §3.3 chain.
  const strainFailP = cache.strainFailP;
  const p = pCling * cache.strainSurvival;

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
    const tumbleDeg = cache.tumbleDeg;
    if (tumbleDeg > P.IN_SPEC_DEG) {
      const fTumble = cache.fTumble;
      losses.push({
        loss: 1 - fTumble,
        blocker: 'TUMBLE',
        // On glass the DE-SPIN button (floors 2-3, a target tumbling past the same 10 deg/s) replaces the L key; read at draw
        // time, and only while that button is really up; else the plain words for what is missing (past 5 km: get closer).
        hint: `tumbling ${Math.round(tumbleDeg)}\u00B0/s \u2014 ${GestureHints.isGlass() ? glassDespinWords(target) : 'de-spin [L]'}`,
      });
    }
  }
  const fDistance = clamp(1.1 - 0.003 * range, 0.85, 1.1);
  if (fDistance < 1.0) {
    losses.push({ loss: 1 - fDistance, blocker: 'RANGE', hint: 'edge of envelope. Close in' });
  }
  const fSpin = clamp(spinFraction, 0.5, 1.2);
  if (fSpin < 1.0) {
    losses.push({ loss: 1 - fSpin, blocker: 'SPIN', hint: 'long flight bleeds net spin. Close in' });
  }
  losses.sort((a, b) => b.loss - a.loss);
  const top = losses[0] || null;

  return {
    p: clamp01(p),
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
 * Live odds for every verb in a toolset against one target.
 * @param {object} opts
 * @param {'weaver'|'spinner'|'mother'} [opts.armType='weaver'] platform class
 * @param {string[]} [opts.toolset] verbs to score (default: class toolset)
 * @param {object|null} [opts.target] debris ({mass, sizeMeter, tumbleRate, surfaceRoughness, material, ferromagnetic,
 *   hasFerrousFasteners, hasGrappleFixture, fragility, ...})
 * @param {number} [opts.range=50] metres to target
 * @param {object} [opts.netClass] net class override (e.g. CN.LARGE for mother)
 * @param {number} [opts.netCount] net magazine count (0 → '--' EMPTY)
 * @param {number} [opts.padUvDoses] UV-cure doses remaining
 * @param {number} [opts.contactVel] pad approach speed (m/s)
 * @param {number} [opts.presentedWidthM] orientation-aware presented width (m)
 * @param {object} [opts.lockCache] persistent per-owner NET lock cache from makeNetOddsLockCache(); omit for the fresh
 *   path (output identical either way)
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

  // A Mother-net odds row must reflect the pod magazine (never "96%" on an empty pod): without an explicit netCount, derive
  // it from the live pod inventory so an empty magazine collapses to the EMPTY blocker ('--').
  let netCount = opts.netCount;
  if (netCount === undefined && armType === 'mother'
      && captureNetSystem && typeof captureNetSystem.getMotherNetCount === 'function') {
    netCount = captureNetSystem.getMotherNetCount();
  }

  /** @type {Object<string, {p:number|null, blocker:string|null, hint:string}>} */
  const odds = {};
  for (const kind of toolset) {
    switch (kind) {
      case 'NET':
        odds.NET = computeNetOdds({
          target,
          range,
          netClass,
          netCount,
          presentedWidthM: opts.presentedWidthM,
          lockCache: opts.lockCache,
        });
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
 *   • RECOMMEND_MARGIN (relative): a later-preference tool only takes the ▶ when it beats the incumbent by more than the
 *     margin (no flip-flopping on noise; NET stays primary on near-ties).
 *   • uv_cure-resolved PAD never takes the ▶ (finite consumable, last resort; its honest % still displays).
 * @param {Object<string, {p:number|null, mode?:string}>} odds
 * @param {string[]} [toolset] fallback order (first entry wins when nothing is rollable)
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

export default { computeToolOdds, computeBestTool, computeStrainFailProbability, estimateSpinFractionAtContact, resolveCaptureModeForOdds, resolvePadModeForOdds, toolShortLabel, makeNetOddsLockCache, TOOL_PREF_ORDER };
