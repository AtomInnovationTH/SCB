/**
 * DespinHint.js - ONE rule for "is the DE-SPIN button up", shared by the docking reticle's captions and the
 * odds hint in ToolOdds, and the plain words for when it is not.
 *
 * The button (TouchVerbButton.despinTarget) is up only on floors 2-3, with the feature on, a target tumbling past the
 * net-safe spin, and a beam that can fire at it: inside the mother laser's reach (`despinLaser.reachM()`: 120 m with the close
 * laser, 1.4 km once the long-range one is aboard) or relayed by a daughter's mirror (laser round 2, E11; `previewBeams`).
 *
 * The reticle registers its glass controls here (`setDespinProbe`); ToolOdds has no controls handle of its own.
 * With no probe registered the button counts as not up.
 *
 * Also the one place that words the time the laser takes to bring a spin to the net-safe 10°/s ("about 30 s", `despinTimeSuffix`),
 * on the screen clock, for the laser that would fire (laser-1101 D8); ToolOdds and the reticle append it to their de-spin advice.
 */
import { Constants } from '../../core/Constants.js';
import { despinLaser, despinTimeS, despinReachM, relayTier } from '../../systems/DespinLaser.js';
import { TimeAuthority } from '../../systems/TimeAuthority.js';   // BASE_SCALE: the one owner of the game-clock rate (test-TimeSweep)
import { degToRad } from '../../core/MathUtil.js';

/** @type {{up: ()=>boolean, distanceM?: (target:object)=>(number|null)}|null} */
let probe = null;

/**
 * A length of on-screen time in plain words (D8, laser-1101). Nearest 10 s under a minute ("about 30 s"; "under 10 s" below 5 s),
 * nearest minute under an hour, nearest hour above ("about 6 h"). Not finite (the beam cannot turn the piece) or not above 0: ''.
 * @param {number} screenS - seconds as the player's clock shows them (physical seconds ÷ `TIME_SCALE_GAMEPLAY`)
 * @returns {string}
 */
export function screenTimeWords(screenS) {
  if (!Number.isFinite(screenS) || !(screenS > 0)) return '';
  if (screenS < 5) return 'under 10 s';
  if (screenS < 55) return `about ${Math.round(screenS / 10) * 10} s`;
  const min = Math.round(screenS / 60);
  if (screenS < 3600 && min < 60) return `about ${min} min`;
  return `about ${Math.max(1, Math.round(screenS / 3600))} h`;
}

/** @private the mother's distance to a target in metres, or null when nothing can measure it (the registered probe first;
 *  else the player's position against the target's scene position, the measure `DespinLaser._distanceM` takes). */
function motherDistanceM(target) {
  try {
    if (probe && typeof probe.distanceM === 'function') {
      const d = probe.distanceM(target);
      if (Number.isFinite(d)) return d;
    }
    const p = despinLaser._player;
    const from = p && typeof p.getPosition === 'function' ? p.getPosition() : null;
    const to = target && target._scenePosition;
    return from && to && typeof from.distanceTo === 'function' ? from.distanceTo(to) / Constants.SCENE_UNITS_PER_METER : null;
  } catch (_e) { return null; }
}

/** @private the beams that would fire at the target from the mother's distance `d` (laser round 2, E11): the mother's direct
 *  beam or a relay through a daughter that owns a mirror, summed as `previewBeams` plans them. null when it cannot be asked. */
function previewAt(target, d) {
  try { return despinLaser.previewBeams(target, { motherDistanceM: d }); } catch (_e) { return null; }
}

/** @private does a daughter's beam act on the target at distance `d` — a relay through her mirror or a weaver's own laser
 *  (laser round 2, E11 with L2's 'own' beams)? Then nothing past the mother's reach is "out of reach". */
function relayActs(target, d) {
  const p = previewAt(target, d);
  return !!(p && p.beams.some((b) => b.kind === 'relay' || b.kind === 'own'));
}

/**
 * How near a daughter must hold to the piece for the mirror to carry the beam, in plain words ("41 m"): the longest reach, over the
 * laser tiers aboard and the daughter types in the fleet (a weaver's 10 cm mirror when no daughter is out), of the mirror as the
 * last aperture (`relayTier`, mirror facing the piece). Metres rounded DOWN, so the words never promise more than the game gives.
 * @returns {string}
 */
function relayReachWords() {
  const cfg = Constants.DESPIN_LASER;
  const tiers = despinLaser.hasLongRange() ? [cfg.CLOSE, cfg.LONG] : [cfg.CLOSE];
  const arms = (despinLaser._armManager && despinLaser._armManager.arms) || [];
  const types = [...new Set(arms.filter(Boolean).map((u) => u.type).filter((ty) => cfg.RELAY.MIRROR_M[ty] > 0))];
  if (!types.length) types.push('weaver');
  let best = 0;
  for (const ty of types) for (const t of tiers) best = Math.max(best, despinReachM(relayTier(t, cfg.RELAY.MIRROR_M[ty])));
  return best < 1000 ? `${Math.floor(best)} m` : reachWords(best);
}

/**
 * "get within 120 m to stop its spin", and with the relay mirrors aboard "get within 120 m to stop its spin, or hold a daughter
 * within 41 m of it" (the mirror bounces the beam, so what counts is the daughter's distance to the piece).
 * @param {string} reach - the mother's reach in words
 * @returns {string}
 */
function pastReachWords(reach) {
  return `get within ${reach} to stop its spin${despinLaser.hasRelayMirrors() ? `, or hold a daughter within ${relayReachWords()} of it` : ''}`;
}

/**
 * When the target's distance is known and past every owned laser's reach (and no daughter's mirror carries the beam there), the
 * reach in plain words ("120 m"); else '' (in reach, or the distance cannot be measured: then nothing says the laser cannot fire).
 * @param {object} target
 * @returns {string}
 */
export function outOfReachWords(target) {
  if (!target) return '';
  const d = motherDistanceM(target);
  if (!(Number.isFinite(d) && despinLaser.tierFor(d) === null)) return '';
  return relayActs(target, d) ? '' : reachWords(despinLaser.reachM());
}

/**
 * The keys advice for a tumbling target: "de-spin [L]" with the time where the laser would fire, but past every owned reach
 * (L does nothing there) the same words glass gets: "get within 120 m to stop its spin" (with mirrors aboard, "..., or hold a
 * daughter within 41 m of it"). Unknown distance: "de-spin [L]".
 * @param {object} target
 * @param {string} [lead] - the keys phrase when the laser can fire (default "de-spin [L]"; the aspect line passes its own)
 * @returns {string}
 */
export function keysDespinWords(target, lead = 'de-spin [L]') {
  const far = outOfReachWords(target);
  return far ? pastReachWords(far) : `${lead}${despinTimeSuffix(target)}`;
}

/**
 * How long, on the screen clock, the beams that would fire take to bring this target's spin down to the net-safe spin
 * (`DESPIN_LASER.IN_SPEC_DEG`), in words: "about 30 s": `previewBeams` at the target's distance (the mother's direct beam, or a
 * relay through a daughter's mirror, summed). With the distance unknown, the close laser alone, as before. '' when nothing fires
 * (past every reach). While the beam acts it is the time left, falling. '' also when the target is already in spec or has no
 * usable mass or length (the laser does not de-spin it).
 * @param {object} target - debris with `tumbleRate` (rad/s), `mass` (kg), `lengthM` (m)
 * @returns {string}
 */
export function despinTimeWords(target) {
  if (!target) return '';
  const cfg = Constants.DESPIN_LASER;
  const d = motherDistanceM(target);
  let physS;
  if (Number.isFinite(d)) {
    const p = previewAt(target, d);
    if (!p) return '';
    physS = p.timeS;
  } else {
    const tier = despinLaser.tierFor(d);   // unknown distance: counts as close, as the old range gate skipped itself
    if (!tier) return '';
    physS = despinTimeS(tier, target.mass, target.lengthM, Math.abs(target.tumbleRate || 0), degToRad(cfg.IN_SPEC_DEG));
  }
  return screenTimeWords(physS / (TimeAuthority.BASE_SCALE || 10));
}

/**
 * `despinTimeWords` as the tail of an advice line: ", about 30 s", or ", about 20 s left" while the beam is acting on the target
 * (`target._despinning`, which DespinLaser sets each frame it fires), or '' when there is no time.
 * @param {object} target
 * @returns {string}
 */
export function despinTimeSuffix(target) {
  const w = despinTimeWords(target);
  return w ? `, ${w}${target._despinning === true ? ' left' : ''}` : '';
}

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
 * @returns {string} 'hold DE-SPIN' (plus ", about 30 s" when the time is known) when the button is up, else what is missing
 *   ("get within 120 m to stop its spin" past reach)
 */
export function glassDespinWords(target) {
  if (despinButtonUp()) return `hold DE-SPIN${despinTimeSuffix(target)}`;
  if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('LASER_DESPIN')) return 'this ship has no de-spin laser';
  let d = null;
  try { d = probe && typeof probe.distanceM === 'function' ? probe.distanceM(target) : null; } catch (_e) { d = null; }
  const reach = despinLaser.reachM();
  if (Number.isFinite(d) && d > reach) return pastReachWords(reachWords(reach));
  return 'no de-spin button on this screen';
}

export default { setDespinProbe, despinButtonUp, glassDespinWords, despinTimeWords, despinTimeSuffix, screenTimeWords, outOfReachWords, keysDespinWords };
