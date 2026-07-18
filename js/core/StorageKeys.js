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
