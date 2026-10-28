/**
 * @module core/StorageKeys — the single registry (SSOT) of every localStorage key the game uses; every reader/writer
 * imports its key from here (loose consts scattered across modules made
 * collisions and version drift easy to miss, e.g. OnboardingDirector's stale `_v1` fallback vs the live `_v3`).
 * IMPORTANT: changing a value orphans existing player data. Bump deliberately (and add a migration); don't rename
 * casually.
 */

import { Constants } from './Constants.js';

/** Live keys — each has a real reader/writer somewhere in the app. */
export const StorageKeys = {
  /** Full game save envelope (PersistenceManager). */
  SAVE:        'spacecowboy_save_v1',
  /** One-shot recovery copy taken before a New Game wipes the save (F1). */
  SAVE_BACKUP: 'spacecowboy_save_v1_backup',
  /** SettingsManager preferences blob. */
  SETTINGS:    'sc_settings_v1',
  /**
   * Zoom Ladder VIEW preferences (LadderViewStore): the FloorMask per-floor room memory + the F1 workbench pane
   * open-state. PLAYER-owned like SETTINGS, deliberately NOT in the run save
   * (New Game wipes that; a rearranged room belongs to the player). Written only while `Constants.LADDER.ENABLED`
   * (a ?ladder=0 boot never reads or writes it). Bumped v1→v2 when the 7→5 floor renumber changed what every floor KEY
   * means, and v2→v3 because existing players' rooms remembered cargo shown on F1
   * (the deleted WORKBENCH_STOP force-show), which made the F1 empty-room fix invisible to them. Old blobs are
   * abandoned in place, not migrated: rooms are cheap to re-arrange, wrong rooms silently applied are not.
   */
  LADDER_VIEW: 'sc_ladder_view_v3',
  /**
   * The first-run TOUCH MAP / KEY MAP checklist (TouchMapStore; "advance only on the witnessed real input"): which of
   * the six rows the player has witnessed, and whether the map was skipped. PLAYER-owned like LADDER_VIEW: once per
   * player, never in the run save. Written only while `Constants.LADDER.ENABLED` (constructed inside the hub's gate).
   */
  TOUCH_MAP:   'sc_touch_map_v1',
  /**
   * Daughter-arm automation (StrutAutoStore): whether this player has seen the once-only full-range show. PLAYER-owned
   * like TOUCH_MAP; never in the run save.
   */
  STRUT_AUTO:  'sc_strut_auto_v1',
  /**
   * The once-only "LEO means low Earth orbit" / "GEO means ..." lines (FloorWordsStore): which floors' lines this
   * player has seen. PLAYER-owned like STRUT_AUTO.
   */
  FLOOR_WORDS: 'sc_floor_words_v1',
  /** CityLabels visibility toggle ('0' | '1'). */
  CITY_LABELS: 'sc_city_labels_visible',
  /** BlackPatchHeal's ring of the last 20 "centre went black on F4/F5" records (detected, which repair step healed it).
   *  Device-owned diagnostics, never in the run save; read back from the owner's browser
   *  (BLACK_SCREEN_TRIAGE.md, Producer 4). */
  BLACK_HEAL:  'sc_black_heal_v1',
  /** Menu update notice (WhatsNewCard, owner 2026-10-26, DECISIONS §43): the version whose "Updated to" card was
   *  auto-shown, and the version whose notes were opened or dismissed with GOT IT (plain strings, e.g. '1.02').
   *  PLAYER-owned like SETTINGS: a wiped save does not bring the card back. */
  WHATS_NEW_SHOWN: 'sc_whats_new_shown',
  WHATS_NEW_SEEN:  'sc_whats_new_seen',
  // Owned by Constants (beside related tuning) but mirrored here so the registry is complete and the collision/drift
  // test sees them.
  /** OnboardingDirector cleared-state blob. */
  ONBOARDING:  Constants.ONBOARDING?.STORAGE_KEY || 'spacecowboy_onboarding_v4',
  /** TeachingSystem seen-moments set. */
  TEACHING:    Constants.TEACHING?.PERSISTENCE_KEY || 'teachingSeen',
};

/** Reserved keys defined in Constants for systems that DO NOT yet persist
 *  (IssConjunctionBoss / StarlinkCascadeBoss / MissionCoach have a PERSISTENCE_KEY but no reader/writer). Listed so a
 *  future feature can't silently reuse one. */
export const RESERVED_STORAGE_KEYS = {
  ISS_BOSS:      Constants.ISS_BOSS?.PERSISTENCE_KEY || 'spacecowboy_iss_boss_v1',
  STARLINK_BOSS: Constants.STARLINK_BOSS?.PERSISTENCE_KEY || 'spacecowboy_starlink_boss_v1',
  MISSION_COACH: Constants.MISSION_COACH?.PERSISTENCE_KEY || 'spacecowboy_mission_coach_v1',
};

export default StorageKeys;
