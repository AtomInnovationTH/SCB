/**
 * menuActions.js — pure menu-action mapping (no THREE / DOM / audio imports, so Node can test it).
 * With a save present, Enter must CONTINUE, never start a new game that wipes the save.
 *
 * @module ui/menuActions
 */

/** What the primary key (Enter/Return) does: CONTINUE when a save exists, else START. */
export function resolvePrimaryMenuAction(hasSave) {
  return hasSave ? 'CONTINUE' : 'START';
}

/** START MISSION must confirm first only when there is a save to lose (MENU_START → deleteSave). */
export function startRequiresConfirm(hasSave) {
  return !!hasSave;
}

/**
 * Confirmation shown by START MISSION when a save exists. A backup is taken (PersistenceManager.backupSave) but
 * there is no restore UI, so the copy deliberately does NOT promise recovery.
 */
export const NEW_GAME_CONFIRM_MESSAGE =
  'Start a NEW mission? This overwrites your saved progress. ' +
  'Choose CONTINUE to resume it instead.';

export default resolvePrimaryMenuAction;
