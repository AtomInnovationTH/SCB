/**
 * StorageKeys.js — the single registry of every localStorage key the game uses.
 *
 * Keys were scattered across modules as loose consts (`SAVE_KEY`, `SETTINGS_KEY`,
 * `STORAGE_KEY`, …) plus a few `PERSISTENCE_KEY` fields inside Constants. That
 * made collisions and version drift easy to miss (e.g. OnboardingDirector's
 * stale `spacecowboy_onboarding_v1` fallback vs the live `_v3`). This module is
 * the SSOT: every reader/writer imports its key from here.
 *
 * IMPORTANT: changing a value orphans existing player data. Bump deliberately
 * (and add a migration) — do not rename casually.
 *
 * @module core/StorageKeys
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
   * Zoom Ladder VIEW preferences (LadderViewStore — D5 "rooms you can
   * rearrange", Wave 5 Session G): the FloorMask per-floor room memory + the
   * F1 workbench pane open-state. PLAYER-owned like SETTINGS — deliberately
   * NOT in the run save, which New Game wipes; a rearranged room belongs to
   * the player, not the run. Written only while `Constants.LADDER.ENABLED`
   * (a ?ladder=0 boot never reads or writes it). v2 (Wave 5 Session H): the
   * 7→5 renumber changed what every floor KEY means (old 3–7 → new 1–5), so
   * the key bumps and v1 blobs are abandoned in place rather than migrated —
   * rooms are cheap to re-arrange, wrong rooms silently applied are not
   * (plan step 7).
   */
  LADDER_VIEW: 'sc_ladder_view_v2',
  /**
   * The first-run TOUCH MAP / KEY MAP checklist (TouchMapStore — Session N
   * onboarding, Ipad.md §5.5 / §5.8 "advance only on the witnessed real
   * input"): which of the six rows the player has witnessed, and whether the
   * map was skipped. PLAYER-owned like LADDER_VIEW — once per player, never
   * in the run save (a New Game does not re-teach the gestures). Written only
   * while `Constants.LADDER.ENABLED` (constructed inside the hub's gate; a
   * ?ladder=0 boot never reads or writes it).
   */
  TOUCH_MAP:   'sc_touch_map_v1',
  /** CityLabels visibility toggle ('0' | '1'). */
  CITY_LABELS: 'sc_city_labels_visible',
  // Owned by Constants (they sit beside related tuning) but mirrored here so the
  // registry is complete and the collision/drift test can see them.
  /** OnboardingDirector cleared-state blob. */
  ONBOARDING:  Constants.ONBOARDING?.STORAGE_KEY || 'spacecowboy_onboarding_v3',
  /** TeachingSystem seen-moments set. */
  TEACHING:    Constants.TEACHING?.PERSISTENCE_KEY || 'teachingSeen',
};

/**
 * Reserved keys defined in Constants for systems that DO NOT yet persist — F8
 * found IssConjunctionBoss / StarlinkCascadeBoss / MissionCoach have a
 * PERSISTENCE_KEY constant but no localStorage reader/writer. Listed here so a
 * future feature can't silently reuse/collide with one, and so the audit trail
 * is explicit rather than dead constants hiding in Constants.
 */
export const RESERVED_STORAGE_KEYS = {
  ISS_BOSS:      Constants.ISS_BOSS?.PERSISTENCE_KEY || 'spacecowboy_iss_boss_v1',
  STARLINK_BOSS: Constants.STARLINK_BOSS?.PERSISTENCE_KEY || 'spacecowboy_starlink_boss_v1',
  MISSION_COACH: Constants.MISSION_COACH?.PERSISTENCE_KEY || 'spacecowboy_mission_coach_v1',
};

export default StorageKeys;
