/**
 * resupplyWords - one place for "where does buying happen": the resupply stop after a mission (today's game) or the resupply
 * satellite (Nets step 3 slice 3, DECISIONS §33 rows 2 and 7). Lane 3d.
 *
 * The satellite is the place exactly when fields by height is on AND floor 4 (the LEO map, where the "where next" list lives) is
 * there to ask on: with `?ladder=0` there is no list, so no satellite to fly to, and today's stop after every mission stays.
 * Read live every time (the flags are flipped per boot and per test rig). Flag off: every function here returns today's words.
 *
 * Pure: no DOM, no THREE, nothing stored. Strings that used to be constants are functions here (or are read at use).
 */
import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';

/** @returns {boolean} buying happens at the resupply satellite (flag on and the list available), not at a stop after a mission */
export function satelliteIsTheStop() {
  return Constants.isFeatureEnabled('FIELDS_BY_HEIGHT') && !!(Constants.LADDER && Constants.LADDER.ENABLED);
}

/**
 * `?fields` / `?fields=1` / `?fields=on` turn fields by height on for this boot; `?fields=0`, `off` and `false` turn it off (they
 * used to turn it ON, because any value was "present"). Absent: null (leave the flag as the table says).
 * @param {string} search `window.location.search`
 * @returns {boolean|null}
 */
export function fieldsFromSearch(search) {
  const v = new URLSearchParams(search || '').get('fields');
  if (v === null) return null;
  return !['0', 'off', 'false'].includes(v.trim().toLowerCase());
}

/** The place's name in a sentence: "resupply satellite" with the map on, "resupply stop" as today. */
export function placeName() { return satelliteIsTheStop() ? 'resupply satellite' : 'resupply stop'; }

/** "Out of nets. Restock at the resupply stop." (a daughter has no nets; DECISIONS §33 row 8) */
export function daughterOutOfNetsLine() { return `Out of nets. Restock at the ${placeName()}.`; }

/** "Out of mother nets. Restock at the resupply stop." (the arrival line on a piece only a net can take) */
export function outOfMotherNetsLine() { return `Out of mother nets. Restock at the ${placeName()}.`; }

/** The lasso chip's tooltip tail: "Restock at the resupply stop." */
export function restockTail() { return `Restock at the ${placeName()}.`; }

/** REFIT chips while buying is closed: "buy at the resupply stop" */
export function buyAtLine() { return `buy at the ${placeName()}`; }

/** CARGO pane buttons while trading is closed: "sell at the resupply stop" / "contribute at the resupply stop" */
export function sellAtLine() { return `sell at the ${placeName()}`; }
export function contributeAtLine() { return `contribute at the ${placeName()}`; }

/**
 * For text that lives in a table that cannot import this file (Constants strings, the help page's rows, beat sentences): the same
 * switch applied where the text is read. "the next resupply stop" -> "the resupply satellite" (there is one), "resupply stop" -> "resupply satellite", "at the stop" -> "at the satellite"; anything
 * else is returned as it came, and with the map off every string is returned untouched.
 * @param {string} text @returns {string}
 */
export function wordsFor(text) {
  if (typeof text !== 'string' || !satelliteIsTheStop()) return text;
  return text.replace(/the next resupply stop/g, 'the resupply satellite').replace(/resupply stop/g, 'resupply satellite').replace(/at the stop\b/g, 'at the satellite');
}

/** The pinned-upgrade chip while the credits are there: "READY AT DEPOT" today, "READY AT THE SATELLITE" with the map on. */
export function pinReadyLabel() { return satelliteIsTheStop() ? 'READY AT THE SATELLITE' : 'READY AT DEPOT'; }

/** The comms line when the pinned upgrade becomes affordable: "... See you at the depot." / "... See you at the resupply satellite." */
export function pinReadyLine(name) {
  return `You've got the credits for ${name}. See you at the ${satelliteIsTheStop() ? 'resupply satellite' : 'depot'}.`;
}

/**
 * The "depot" sentences that live inside tables (a comms template, a shop card) read where they are shown: with the map on,
 * "Refuel at an orbital depot when you can." -> "Refuel at the resupply satellite when you can." and "More salvage per depot
 * run." -> "More salvage per trip." (the hold carries salvage on trips between fields); map off: untouched.
 * @param {string} text @returns {string}
 */
export function depotWords(text) {
  if (typeof text !== 'string' || !satelliteIsTheStop()) return text;
  return text
    .replace('Refuel at an orbital depot when you can.', 'Refuel at the resupply satellite when you can.')
    .replace('More salvage per depot run.', 'More salvage per trip.');
}

/** The full-screen shop's header (the game-over continue shop opens it with the map on): "ORBITAL SUPPLY DEPOT" / "RESUPPLY SATELLITE". */
export function shopTitle() { return satelliteIsTheStop() ? 'RESUPPLY SATELLITE' : 'ORBITAL SUPPLY DEPOT'; }

/** The LEO map's name, from the floor contract as `WhereNextRows` reads it. */
const mapName = () => (FloorContract.byId(4) || { name: 'map' }).name;

/** Briefing: the mission objective sentence's destination ("depot" today; with the map nothing is reached by clearing, the next
 *  trip is the player's pick, on the map). */
export function briefingObjective(perMission) {
  return satelliteIsTheStop()
    ? `Clear ${perMission} debris, then pick your next field on the ${mapName()} map`
    : `Clear ${perMission} debris to reach the depot`;
}
export function briefingObjectiveMore(debrisUntilShop) {
  return satelliteIsTheStop()
    ? `Clear ${debrisUntilShop} more debris, then pick your next field on the ${mapName()} map`
    : `Clear ${debrisUntilShop} more debris for depot visit`;
}
