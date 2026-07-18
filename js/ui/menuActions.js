/**
 * menuActions.js — F1 save-guard: pure menu-action mapping helpers.
 *
 * The bug (F1): pressing Enter on the menu mapped to START even when a save
 * existed and CONTINUE was on screen, so MENU_START → deleteSave() wiped the
 * save instantly with no confirmation. These pure helpers decide what the
 * primary (Enter/Return) key does and whether the explicit START MISSION
 * button must confirm a save-wipe, based only on whether a recoverable save
 * exists. Extracted from the DOM-heavy MenuScreen so the mapping is
 * unit-testable in Node (no THREE / DOM / audio imports here).
 *
 * @module ui/menuActions
 */

/**
 * What the primary key (Enter/Return, or the default action) should do.
 * With a save present, the primary action RESUMES the mission (CONTINUE)
 * rather than silently starting a new game that wipes the save.
 * @param {boolean} hasSave — whether a valid save exists
 * @returns {'CONTINUE'|'START'}
 */
export function resolvePrimaryMenuAction(hasSave) {
  return hasSave ? 'CONTINUE' : 'START';
}

/**
 * Whether pressing the explicit START MISSION button must confirm first.
 * A new game clears the existing save (GameFlowManager MENU_START →
 * deleteSave), so a confirm is required only when there is a save to lose.
 * @param {boolean} hasSave — whether a valid save exists
 * @returns {boolean}
 */
export function startRequiresConfirm(hasSave) {
  return !!hasSave;
}

/**
 * One-line confirmation shown by START MISSION when a save exists. Names the
 * loss (overwrites saved progress) and points at the non-destructive path
 * (CONTINUE). A recovery backup is taken under the hood (PersistenceManager
 * .backupSave), but there's no in-game restore UI yet, so the copy deliberately
 * does NOT promise the player can recover it.
 * @type {string}
 */
export const NEW_GAME_CONFIRM_MESSAGE =
  'Start a NEW mission? This overwrites your saved progress. ' +
  'Choose CONTINUE to resume it instead.';

export default resolvePrimaryMenuAction;
