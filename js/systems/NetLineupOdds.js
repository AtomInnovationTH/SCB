/**
 * NetLineupOdds.js — the mother's Large Net catch chance, "line up and scan" (owner pick 2026-11-07). PURE + Node-safe.
 *
 * The ONE function the roll (CaptureNet `_resolveCatch`, from a snapshot taken at release) and the screen (TargetPanel via
 * ToolOdds) both read, so the % on the panel is the % rolled (Ruling 0, honest numbers).
 *
 *   p_catch = A0(range) × Q(lineup) × Hs(roughness, profiled) × fT(tumble, winch)
 *
 *   A0  aim: 1 inside AIM_CLOSE_M; beyond it, (spin × distance factor at range / the same at AIM_CLOSE_M)², clamped to 0..1.
 *       Spin is the net's own decay in flight (ToolOdds.estimateSpinFractionAtContact), distance factor is §3.3's.
 *   Q   line-up: Q_MIN + (1 − Q_MIN) × u, u in 0..1 (1 = fully lined up; wave 1 has no meter, every throw is u = 1).
 *   Hs  hold: 1 when the piece was scanned up close (net-profiled: the neck closes at the right moment); else it loses
 *       HOLD_MISS / roughness (roughness floored like §3.3), so a smooth piece slips out more.
 *   fT  tumble: 1 up to the limit (10 °/s, 15 °/s with the closing winch), then down TUMBLE_SLOPE per °/s to TUMBLE_FLOOR.
 *
 * No pBase and no sure-shot floor: a close, still, scanned piece is 100 % by construction. Daughter nets keep §3.3.
 * Constants: `Constants.NET_LINEUP`. Import cycle (CaptureNet → NetLineupOdds → ToolOdds → CaptureNet): imports are used
 * only inside function bodies.
 *
 * @module systems/NetLineupOdds
 */

import { Constants } from '../core/Constants.js';
import { RAD2DEG, clamp, clamp01 } from '../core/MathUtil.js';
import { estimateSpinFractionAtContact } from './ToolOdds.js';
import { computeFragRisk, effectiveFragility } from '../entities/CaptureNet.js';

/** §3.3's distance factor (same expression as CaptureNet.computeDistanceModifier; inlined, no CaptureNet import needed). */
function distanceFactor(rangeM) {
  return clamp(1.1 - 0.003 * rangeM, 0.85, 1.1);
}

/**
 * Aim part A0 of the model.
 * @param {number} rangeM range to the target at release (m)
 * @returns {number} 0..1
 */
export function computeAimPart(rangeM) {
  const L = Constants.NET_LINEUP;
  const r = Math.max(0, Number.isFinite(rangeM) ? rangeM : 0);
  if (r <= L.AIM_CLOSE_M) return 1;
  const net = Constants.CAPTURE_NET.LARGE;
  const at = (x) => estimateSpinFractionAtContact(x, net) * distanceFactor(x);
  const ref = at(L.AIM_CLOSE_M);
  if (!(ref > 0)) return 0;
  const ratio = clamp01(at(r) / ref);
  return ratio * ratio;
}

/**
 * Hold part Hs of the model.
 * @param {number} roughness surface roughness (0.4 smooth .. 1.0 rough); missing counts as 1.0
 * @param {boolean} profiled the piece was scanned within PROFILE_RANGE_M (netProfiled)
 * @returns {number} 0..1
 */
export function computeHoldPart(roughness, profiled) {
  if (profiled) return 1;
  const L = Constants.NET_LINEUP;
  const rough = (typeof roughness === 'number' && Number.isFinite(roughness)) ? roughness : 1.0;
  const floor = Constants.CAPTURE_NET.ROUGHNESS_FLOOR ?? 0;
  return 1 - L.HOLD_MISS / Math.max(floor, rough);
}

/**
 * Tumble part fT of the model.
 * @param {number|null|undefined} tumbleRadS the piece's tumble rate in rad/s (ToolOdds/DebrisField unit); null = untracked
 * @param {boolean} winch the closing winch is fitted (wave 2; wave 1 always false)
 * @returns {number} TUMBLE_FLOOR..1
 */
export function computeTumblePart(tumbleRadS, winch) {
  if (typeof tumbleRadS !== 'number' || !Number.isFinite(tumbleRadS)) return 1;
  const L = Constants.NET_LINEUP;
  const limit = winch ? L.WINCH_TUMBLE_LIMIT_DEG : L.TUMBLE_LIMIT_DEG;
  const omegaDeg = Math.abs(tumbleRadS) * RAD2DEG;
  if (omegaDeg <= limit) return 1;
  return Math.max(L.TUMBLE_FLOOR, 1 - L.TUMBLE_SLOPE * (omegaDeg - limit));
}

/**
 * The mother Large Net's catch chance (cling roll), before any destroy-on-contact roll.
 * @param {object} p
 * @param {number} p.rangeM range to the target at release (m)
 * @param {number|null} [p.tumbleRadS] target tumble rate (rad/s)
 * @param {number} [p.roughness=1] surface roughness
 * @param {boolean} [p.profiled=false] net-profiled by a close scan
 * @param {number} [p.lineup=1] line-up u in 0..1 (1 = lined up; 0 = quick shot)
 * @param {boolean} [p.winch=false] closing winch fitted
 * @returns {number} p_catch in 0..1
 */
export function computeLineupCatch({ rangeM, tumbleRadS = null, roughness = 1.0, profiled = false, lineup = 1, winch = false } = {}) {
  const L = Constants.NET_LINEUP;
  const u = clamp01(typeof lineup === 'number' && Number.isFinite(lineup) ? lineup : 1);
  const q = L.Q_MIN + (1 - L.Q_MIN) * u;
  return clamp01(computeAimPart(rangeM) * q * computeHoldPart(roughness, profiled) * computeTumblePart(tumbleRadS, winch));
}

/**
 * Chance that the piece is destroyed on contact (the frag roll that ends the catch): the frag risk when the severity
 * (brittleness × keFactor / 2, as CaptureNet.resolveFragSeverity) reaches the breakup tier, else 0 (a crack sheds pieces
 * and the catch goes on).
 * @param {number} fragRisk CaptureNet.computeFragRisk output at release
 * @param {number} brittleness per-piece 0..1 (missing counts as 0.5, like the roll)
 * @param {number} [keFactor=1] clamp(contact speed / optimal speed, 0.5, 2)
 * @returns {number} 0..1
 */
export function computeDestroyChance(fragRisk, brittleness, keFactor = 1) {
  const FS = Constants.FRAG_SEVERITY || {};
  const b = clamp01(typeof brittleness === 'number' && Number.isFinite(brittleness) ? brittleness : 0.5);
  const ke = clamp(Number.isFinite(keFactor) ? keFactor : 1, 0.5, 2);
  const severity = b * (ke / 2);
  if (severity < (FS.BREAKUP_SEVERITY ?? 0.45)) return 0;
  return clamp01(Number.isFinite(fragRisk) ? fragRisk : 0);
}

/**
 * The % the player sees and the roll delivers: p_catch × (1 − P_destroy).
 * @param {object} p computeLineupCatch inputs plus
 * @param {number} [p.fragRisk=0] CaptureNet.computeFragRisk output at release
 * @param {number} [p.brittleness=0.5] piece brittleness
 * @param {number} [p.keFactor=1] contact speed / optimal speed, clamped 0.5..2
 * @returns {number} 0..1
 */
export function computeLineupShown({ fragRisk = 0, brittleness = 0.5, keFactor = 1, ...catchInputs } = {}) {
  return computeLineupCatch(catchInputs) * (1 - computeDestroyChance(fragRisk, brittleness, keFactor));
}

/**
 * Where `buildLineupSnapshot` asks whether the closing winch is fitted when the caller does not say (net-odds-1107 D13). main.js
 * registers `() => player.hasNetWinch()` once at boot, so the release, the panel and the ring all see the same answer without
 * passing it. Unset (tests, headless) means no winch.
 * @type {(() => boolean)|null}
 */
let _winchSource = null;

/**
 * Register (or clear, with null) the closing-winch provider.
 * @param {(() => boolean)|null} fn
 */
export function setNetWinchSource(fn) {
  _winchSource = (typeof fn === 'function') ? fn : null;
}

/** @returns {boolean} the provider's answer; false when none is set or it throws */
function winchFromSource() {
  if (!_winchSource) return false;
  try { return !!_winchSource(); } catch (_e) { return false; }
}

/**
 * The inputs and results of the model for one piece at one moment: read by the panel with the live range, and stored on a
 * mother Large Net at release, which then rolls exactly these numbers (so the last panel frame shows the rolled %).
 * Reads the piece the way the roll does: tumble only while LASER_DESPIN is on, roughness `|| 1.0`, brittleness `?? 0.5`.
 * @param {object|null} target debris (surfaceRoughness, tumbleRate rad/s, netProfiled, brittleness, fragility)
 * @param {number} rangeM range to the target (m)
 * @param {{lineup?: number, winch?: boolean}} [opt] lineup defaults to 1 (lined up); winch defaults to the registered provider
 *   (`setNetWinchSource`), false when none
 * @returns {{rangeM:number, tumbleRadS:number|null, roughness:number, profiled:boolean, lineup:number, winch:boolean,
 *   fragRisk:number, brittleness:number, keFactor:number, vRel:number, pCatch:number, pDestroy:number, pShown:number}}
 */
export function buildLineupSnapshot(target, rangeM, opt = {}) {
  const net = Constants.CAPTURE_NET.LARGE;
  const tumbleOn = !Constants.isFeatureEnabled || Constants.isFeatureEnabled('LASER_DESPIN');
  const tumbleRadS = (tumbleOn && target && typeof target.tumbleRate === 'number') ? target.tumbleRate : null;
  const roughness = (target && target.surfaceRoughness) || 1.0;
  const profiled = !!(target && target.netProfiled);
  const lineup = (typeof opt.lineup === 'number') ? opt.lineup : 1;
  const winch = (typeof opt.winch === 'boolean') ? opt.winch : winchFromSource();
  const brittleness = (target && typeof target.brittleness === 'number') ? target.brittleness : 0.5;
  // Contact speed is the launch speed (the flight model; the net does not speed up or brake before contact).
  const vRel = net.LAUNCH_SPEED;
  const keFactor = clamp(vRel / Math.max(1e-6, net.LAUNCH_SPEED), 0.5, 2);
  const fragRisk = computeFragRisk({
    netMass: net.MASS, vRel, targetFragility: effectiveFragility(target), range: rangeM,
  });
  const pCatch = computeLineupCatch({ rangeM, tumbleRadS, roughness, profiled, lineup, winch });
  const pDestroy = computeDestroyChance(fragRisk, brittleness, keFactor);
  return {
    rangeM, tumbleRadS, roughness, profiled, lineup, winch, fragRisk, brittleness, keFactor, vRel,
    pCatch, pDestroy, pShown: pCatch * (1 - pDestroy),
  };
}

export default { computeLineupCatch, computeLineupShown, computeAimPart, computeHoldPart, computeTumblePart, computeDestroyChance, buildLineupSnapshot, setNetWinchSource };
