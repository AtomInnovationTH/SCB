/**
 * daughterFittings.js — the hardware bought for the daughters (laser round 2, E2/E3/E10) and what it weighs.
 *
 * Two shop items ride on the daughters: the relay mirror (every daughter; `Constants.DESPIN_LASER.RELAY.MASS_KG[type]`) and the
 * weaver's own laser (weavers only; `Constants.DESPIN_LASER.WEAVER.MASS_KG`). Ownership lives on the player
 * (`hasRelayMirrors()`, `hasWeaverLaser()`), never here, so a new run cannot inherit it. This module only turns ownership into
 * kilograms, so every place that reads a daughter's mass (thrust, recoil, reel, the CoM, the fleet mass budget, the autopilot's
 * launch mass) asks one function.
 *
 * Pure: imports only Constants (loads in Node with no THREE/DOM).
 *
 * @module systems/daughterFittings
 */
import { Constants } from '../core/Constants.js';

/** The daughter's own mass before any bought fitting, kg (`V5_WEAVER_MASS` / `V5_SPINNER_MASS`). */
export function daughterBaseMassKg(type) {
  return type === 'weaver' ? Constants.V5_WEAVER_MASS : Constants.V5_SPINNER_MASS;
}

/** Ask the player a yes/no ownership question; false when it has no such method or it throws. */
function owns(player, method) {
  try { return !!(player && typeof player[method] === 'function' && player[method]()); } catch (_e) { return false; }
}

/**
 * The extra mass a daughter of `type` carries for what was bought, kg: the relay mirror on every daughter, the laser on weavers.
 * 0 with no player, or a player without the methods.
 * @param {'weaver'|'spinner'} type
 * @param {object|null|undefined} player the PlayerSatellite (asked `hasRelayMirrors()`, `hasWeaverLaser()`)
 * @returns {number} kg
 */
export function daughterExtraMassKg(type, player) {
  const D = Constants.DESPIN_LASER;
  let kg = 0;
  if (owns(player, 'hasRelayMirrors')) kg += (D.RELAY.MASS_KG[type] || 0);
  if (type === 'weaver' && owns(player, 'hasWeaverLaser')) kg += D.WEAVER.MASS_KG;
  return kg;
}

/**
 * One daughter's mass, kg: her own mass plus what was bought. A real `ArmUnit` answers with its `_massKg()` (it knows its
 * player); a bare object (a test double, a snapshot) falls back to its type, plus the fittings of `fallbackPlayer` if given.
 * @param {object} arm
 * @param {object} [fallbackPlayer]
 * @returns {number} kg
 */
export function daughterMassKg(arm, fallbackPlayer) {
  if (arm && typeof arm._massKg === 'function') return arm._massKg();
  const type = arm && arm.config && arm.config.type;
  return daughterBaseMassKg(type) + daughterExtraMassKg(type, fallbackPlayer);
}
