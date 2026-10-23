/**
 * DespinHint.js - u20-ipad F4: ONE rule for "is the DE-SPIN button up", shared by the docking reticle's captions and the
 * odds hint in ToolOdds, and the plain words for when it is not.
 *
 * Why: ToolOdds said "hold DE-SPIN" on any glass screen, but the button (TouchVerbButton.despinTarget) is up only on floors
 * 2-3, with the feature on, a target tumbling past the net-safe spin, and the target inside the mother optic's reach
 * (`Constants.DESPIN_LASER.RANGE_M`, 5 km). Beyond that the hint named a button that was not there.
 *
 * The reticle registers its glass controls here (`setDespinProbe`); ToolOdds has no controls handle of its own. With no probe
 * registered the button counts as not up (a bare rig, a desktop session).
 */
import { Constants } from '../../core/Constants.js';

/** @type {{up: ()=>boolean, distanceM?: (target:object)=>(number|null)}|null} */
let probe = null;

/**
 * Register (or clear, with null) how to read the DE-SPIN button.
 * @param {{up: ()=>boolean, distanceM?: (target:object)=>(number|null)}|null} p - `up` is the button's on-screen answer;
 *   `distanceM` (optional) is the mother's distance to a target in metres, to word the past-5-km case.
 */
export function setDespinProbe(p) {
  probe = p && typeof p.up === 'function' ? p : null;
}

/**
 * The shared rule: is the hold-to-fire DE-SPIN button on screen right now?
 * @param {{isDespinUp?: ()=>boolean}|null} [controls] - the reticle's glass controls; omitted = the registered probe
 * @returns {boolean}
 */
export function despinButtonUp(controls) {
  try {
    if (controls !== undefined) return !!(controls && typeof controls.isDespinUp === 'function' && controls.isDespinUp());
    return !!(probe && probe.up());
  } catch (_e) { return false; }
}

/**
 * What a glass player is told about de-spin for a tumbling target, in words that name only what exists on screen.
 * @param {object} [target] - the tumbling debris (for the distance, when the probe can measure it)
 * @returns {string} 'hold DE-SPIN' when the button is up, else what is missing
 */
export function glassDespinWords(target) {
  if (despinButtonUp()) return 'hold DE-SPIN';
  const cfg = Constants.DESPIN_LASER || {};
  if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('LASER_DESPIN')) return 'this ship has no de-spin laser';
  let d = null;
  try { d = probe && typeof probe.distanceM === 'function' ? probe.distanceM(target) : null; } catch (_e) { d = null; }
  if (Number.isFinite(d) && d > (cfg.RANGE_M ?? 5000)) return `get within ${Math.round((cfg.RANGE_M ?? 5000) / 1000)} km to stop its spin`;
  return 'no de-spin button on this screen';
}

export default { setDespinProbe, despinButtonUp, glassDespinWords };
