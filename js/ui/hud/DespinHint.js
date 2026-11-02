/**
 * DespinHint.js - ONE rule for "is the DE-SPIN button up", shared by the docking reticle's captions and the
 * odds hint in ToolOdds, and the plain words for when it is not.
 *
 * The button (TouchVerbButton.despinTarget) is up only on floors 2-3, with the feature on, a target tumbling past the
 * net-safe spin, and the target inside the mother laser's reach (`despinLaser.reachM()`: 120 m with the close laser, 1.4 km
 * once the long-range one is aboard).
 *
 * The reticle registers its glass controls here (`setDespinProbe`); ToolOdds has no controls handle of its own.
 * With no probe registered the button counts as not up.
 */
import { Constants } from '../../core/Constants.js';
import { despinLaser } from '../../systems/DespinLaser.js';

/** @type {{up: ()=>boolean, distanceM?: (target:object)=>(number|null)}|null} */
let probe = null;

/**
 * A reach in plain words: to the nearest 10 m below 1 km ("120 m"), else kilometres to one place ("1.4 km").
 * @param {number} reachM
 * @returns {string}
 */
export function reachWords(reachM) {
  const tens = Math.round(reachM / 10) * 10;
  return tens < 1000 ? `${tens} m` : `${(reachM / 1000).toFixed(1)} km`;
}

/**
 * Register (or clear, with null) how to read the DE-SPIN button.
 * @param {{up: ()=>boolean, distanceM?: (target:object)=>(number|null)}|null} p - `distanceM` (optional) is the
 *   mother's distance to a target in metres, to word the past-reach case.
 */
export function setDespinProbe(p) {
  probe = p && typeof p.up === 'function' ? p : null;
}

/**
 * Is the hold-to-fire DE-SPIN button on screen right now?
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
 * What a glass player is told about de-spin for a tumbling target; names only what exists on screen.
 * @param {object} [target] - the tumbling debris (for the distance, when the probe can measure it)
 * @returns {string} 'hold DE-SPIN' when the button is up, else what is missing ("get within 120 m to stop its spin" past reach)
 */
export function glassDespinWords(target) {
  if (despinButtonUp()) return 'hold DE-SPIN';
  if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('LASER_DESPIN')) return 'this ship has no de-spin laser';
  let d = null;
  try { d = probe && typeof probe.distanceM === 'function' ? probe.distanceM(target) : null; } catch (_e) { d = null; }
  const reach = despinLaser.reachM();
  if (Number.isFinite(d) && d > reach) return `get within ${reachWords(reach)} to stop its spin`;
  return 'no de-spin button on this screen';
}

export default { setDespinProbe, despinButtonUp, glassDespinWords };
