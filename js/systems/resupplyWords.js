/**
 * resupplyWords - where buying happens: the resupply stop after a mission, or the resupply satellite (DECISIONS §33 rows 2
 * and 7).
 *
 * The satellite is the place exactly when fields by height is on AND floor 4 (the LEO map, where the "where next" list
 * lives) is there: with `?ladder=0` there is no list, so the stop after every mission stays.
 * Flags are read live every time (flipped per boot and per test rig). Flag off: every function returns the stop's words.
 *
 * Pure: no DOM, no THREE, nothing stored.
 */
import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';
import { GestureHints } from '../ui/hud/GestureHints.js';

/** @returns {boolean} buying happens at the satellite (flag on, list available), not at a stop after a mission */
export function satelliteIsTheStop() {
  return Constants.isFeatureEnabled('FIELDS_BY_HEIGHT') && !!(Constants.LADDER && Constants.LADDER.ENABLED);
}

/**
 * `?fields` / `?fields=1` / `?fields=on` turn fields by height on for this boot; `?fields=0`, `off`, `false` turn it off.
 * Absent: null (leave the flag as the table says).
 * @param {string} search `window.location.search`
 * @returns {boolean|null}
 */
export function fieldsFromSearch(search) {
  const v = new URLSearchParams(search || '').get('fields');
  if (v === null) return null;
  return !['0', 'off', 'false'].includes(v.trim().toLowerCase());
}

export function placeName() { return satelliteIsTheStop() ? 'resupply satellite' : 'resupply stop'; }

/** @type {(() => boolean)|null} the one "can she restock right now" getter (set once at wiring by main.js; null = say today's line) */
let openGetter = null;

/** @type {(() => boolean)|null} "the trip to the satellite is under way" (set once at wiring by main.js; null = no) */
let onTheWayGetter = null;

/**
 * Register the one getter that says whether she can restock right now: the "where next" list is open (the satellite can be
 * picked) or she is berthed there (map off: the stop after a mission is open). Mid-mission it is false. `null` = no getter.
 * @param {(() => boolean)|null} fn
 */
export function setResupplyOpenGetter(fn) { openGetter = typeof fn === 'function' ? fn : null; }

/**
 * Register the getter that says the trip to the satellite is under way (not open yet, but she is on her way: the line says
 * "when you arrive", not "after this mission"). `null` = none.
 * @param {(() => boolean)|null} fn
 */
export function setResupplyOnTheWayGetter(fn) { onTheWayGetter = typeof fn === 'function' ? fn : null; }

/** @returns {boolean} she is flying to the satellite now (read live; no getter or an error: no) */
export function resupplyIsOnTheWay() {
  if (!onTheWayGetter || resupplyIsOpenNow()) return false;
  try { return !!onTheWayGetter(); } catch (e) { return false; }
}

/**
 * Can she restock right now? Read live from the getter main.js registered; with no getter (a bare test rig) it is true, so a
 * line reads as it always did.
 * @returns {boolean}
 */
export function resupplyIsOpenNow() {
  if (!openGetter) return true;
  try { return !!openGetter(); } catch (e) { return true; }
}

/**
 * A daughter has no nets (DECISIONS §33 row 8). Where she can restock now the line says where; while she cannot (mid-mission:
 * the satellite is picked on the list after the mission), it names what still works right now, read from the real state
 * (`now.padWorks`: her pad would take this piece), else says when the nets come back (training chat 15, owner 11-10).
 * The pad is named only by the step the game accepts in her state, on this device (`now.step`, see `padStepWords`); the trip to
 * the satellite being under way says "when you arrive".
 * @param {{padWorks?: boolean, step?: string}} [now]
 * @returns {string}
 */
export function daughterOutOfNetsLine(now) {
  if (resupplyIsOpenNow()) return `Out of nets. Restock at the ${placeName()}.`;
  if (resupplyIsOnTheWay()) return `Out of nets. They restock at the ${placeName()} when you arrive.`;
  const pad = now && now.padWorks ? padStepWords(now.step) : null;
  if (pad) return `Out of nets. ${pad}: it can grab this piece.`;
  return `Out of nets. They restock at the ${placeName()} after this mission.`;
}

/** @returns {boolean} the touch controls are the input (the iPad: the button, never the key) */
function touchIsInput() {
  try { return GestureHints.isGlass() === true; } catch (e) { return false; }
}

/**
 * The step toward her pad that the game accepts in her exact state, in the words of this device; null when this device has no
 * control for that step. `step`: 'wait' (she is still flying to the piece: nothing to press yet), 'switch' (she is flown and
 * holds station: the tool key, or the CHANGE TOOL button), 'fly' (she holds station but is not flown: fly her first, then the
 * tool change), 'stick' (flown, her pad already chosen: N, or the STICK PAD button), 'flystick' (not flown, pad chosen).
 * The tool key and the CHANGE TOOL button exist only while she is flown and holds station (InputManager Backquote,
 * StatusPanel.toolButtonUp, which also needs the tap grammar).
 * @param {string} [step]
 * @returns {string|null}
 */
export function padStepWords(step) {
  const touch = touchIsInput();
  const noButton = touch && !(Constants.LADDER && Constants.LADDER.ENABLED);   // CHANGE TOOL is not on her row without the ladder
  const fly = touch ? 'Tap her row in DAUGHTERS to fly her, then ' : 'Fly her yourself (press 1-4), then ';
  switch (step) {
    case 'wait': return 'When she holds station at the piece, take her controls and switch to her pad';
    case 'switch': return noButton ? null : touch ? 'Tap CHANGE TOOL to switch to her pad' : 'Switch to her pad (the ` key)';
    case 'fly': return noButton ? null : `${fly}${touch ? 'tap CHANGE TOOL to switch to her pad' : 'switch to her pad (the ` key)'}`;
    case 'stick': return touch ? 'Tap STICK PAD' : 'N sticks her pad on';
    case 'flystick': return `${fly}${touch ? 'tap STICK PAD' : 'N sticks her pad on'}`;
    default: return null;
  }
}

/**
 * The idle coach's out-of-nets chip and body for a holding daughter: null while she can restock (the table's own words stand),
 * else the same truth as the comms line (`daughterOutOfNetsLine`): her pad when it works, "when you arrive" on the trip, or
 * when the nets come back. The chip is at most 5 words.
 * @param {{padWorks?: boolean, step?: string}} [now]
 * @returns {{chip: string, text: string}|null}
 */
export function outOfNetsCoach(now) {
  if (resupplyIsOpenNow()) return null;
  const text = daughterOutOfNetsLine(now);
  if (resupplyIsOnTheWay()) return { chip: 'Restock when you arrive', text };
  if (now && now.padWorks && padStepWords(now.step)) return { chip: 'Use her pad', text };
  return { chip: 'Restock after this mission', text };
}

export function outOfMotherNetsLine() {
  if (resupplyIsOpenNow()) return `Out of mother nets. Restock at the ${placeName()}.`;
  if (resupplyIsOnTheWay()) return `Out of mother nets. They restock at the ${placeName()} when you arrive.`;
  return `Out of mother nets. They restock at the ${placeName()} after this mission.`;
}

export function restockTail() {
  if (resupplyIsOpenNow()) return `Restock at the ${placeName()}.`;
  return resupplyIsOnTheWay() ? `Restock when you arrive at the ${placeName()}.` : 'Restock after this mission.';
}

export function buyAtLine() { return `buy at the ${placeName()}`; }

export function sellAtLine() { return `sell at the ${placeName()}`; }
export function contributeAtLine() { return `contribute at the ${placeName()}`; }

/**
 * For text in a table that cannot import this file (Constants strings, help rows, beat sentences): the same switch applied
 * where the text is read. "the next resupply stop" -> "the resupply satellite" (there is one), "resupply stop" ->
 * "resupply satellite", "at the stop" -> "at the satellite"; anything else, and every string with the map off, is untouched.
 * @param {string} text @returns {string}
 */
export function wordsFor(text) {
  if (typeof text !== 'string' || !satelliteIsTheStop()) return text;
  return text.replace(/the next resupply stop/g, 'the resupply satellite').replace(/resupply stop/g, 'resupply satellite').replace(/at the stop\b/g, 'at the satellite');
}

export function pinReadyLabel() { return satelliteIsTheStop() ? 'READY AT THE SATELLITE' : 'READY AT DEPOT'; }

export function pinReadyLine(name) {
  return `You've got the credits for ${name}. See you at the ${satelliteIsTheStop() ? 'resupply satellite' : 'depot'}.`;
}

/**
 * The "depot" sentences inside tables (a comms template, a shop card), rewritten where shown. Map on: "orbital depot" ->
 * "resupply satellite"; "More salvage per depot run." -> "per trip." (the hold carries salvage between fields). Map off: untouched.
 * @param {string} text @returns {string}
 */
export function depotWords(text) {
  if (typeof text !== 'string' || !satelliteIsTheStop()) return text;
  return text
    .replace('Refuel at an orbital depot when you can.', 'Refuel at the resupply satellite when you can.')
    .replace('More salvage per depot run.', 'More salvage per trip.');
}

export function shopTitle() { return satelliteIsTheStop() ? 'RESUPPLY SATELLITE' : 'ORBITAL SUPPLY DEPOT'; }

/** The LEO map's name, from the floor contract as `WhereNextRows` reads it. */
const mapName = () => (FloorContract.byId(4) || { name: 'map' }).name;

/** Briefing objective destination: with the map nothing is reached by clearing, the next trip is the player's pick. */
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
