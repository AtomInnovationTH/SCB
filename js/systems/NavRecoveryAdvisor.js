/**
 * NavRecoveryAdvisor.js — "you're lost" recovery guidance (UX-11 #11).
 *
 * Two recovery surfaces, both pointing at the nearest live contact with a
 * bearing + distance so the player is never silently stranded:
 *
 *   1. Empty-scan guidance — when an active scan completes with
 *      `rewardKind:'empty'` (no debris field in range — see
 *      [`SensorSystem._completeScan`](js/systems/SensorSystem.js:391)), post a
 *      HOUSTON line with the bearing/distance to the nearest live debris and
 *      the one-tap recovery affordance ("press A to approach").
 *   2. Out-of-range watchdog — when the player has no selected target AND no
 *      live debris within sensor reach for LOST_DWELL_S seconds, fire a single
 *      throttled hint. Veterans (SkillsSystem.isVeteran) never see the
 *      watchdog; the empty-scan line is a direct response to a player action
 *      and is shown to everyone.
 *
 * The one-tap re-acquire itself lives in
 * [`AutopilotSystem.engage`](js/systems/AutopilotSystem.js:167): pressing A
 * with no target auto-selects the nearest live large debris.
 *
 * Pure helpers (`findNearestLiveDebris`, `classifyBearing`,
 * `formatDistanceKm`) are exported for unit tests and reused by
 * [`AutopilotSystem._findNearestLargeDebris`](js/systems/AutopilotSystem.js:1).
 *
 * Pattern mirror of [`ArmIdleAdvisor`](js/systems/ArmIdleAdvisor.js:1).
 * Wire in main.js: init({ player, debrisField, targetSelector, skillsSystem }),
 * update(dt).
 *
 * @module systems/NavRecoveryAdvisor
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';

const TICK_S = 5.0;             // watchdog scan cadence — the debris scan is O(N), keep it slow
const LOST_DWELL_S = 20;        // seconds of "no target + nothing in reach" before the watchdog fires
const WATCHDOG_COOLDOWN_S = 120; // min seconds between watchdog hints
const SCAN_HINT_COOLDOWN_S = 20; // min seconds between empty-scan guidance lines
/** "In reach" envelope (scene units). 1.0 = 100 km — generous sensor-scale radius. */
const NEARBY_RADIUS_SCENE = 1.0;

// Scratch outputs for orbitToSceneCartesianInto — the nearest-debris scan
// walks the full debrisList (~800 entries); no per-entry allocations
// (project scratch-vector discipline; see OrbitalMechanics PR A).
const _scanPos = { x: 0, y: 0, z: 0 };
const _scanVel = { x: 0, y: 0, z: 0 };

// ============================================================================
// PURE HELPERS (Node-safe, no THREE)
// ============================================================================

/**
 * Find the nearest alive debris to a position.
 * @param {{x:number,y:number,z:number}} playerPos — scene units
 * @param {Array<object>} debrisList — DebrisField.debrisList entries ({ alive, mass, orbit, id })
 * @param {number} [minMassKg=0] — minimum mass filter (use 50 for "large")
 * @returns {{ debris: object, pos: {x:number,y:number,z:number}, distScene: number }|null}
 */
export function findNearestLiveDebris(playerPos, debrisList, minMassKg = 0) {
  if (!playerPos || !Array.isArray(debrisList)) return null;
  let best = null;
  let bestDistSq = Infinity;
  for (const d of debrisList) {
    if (!d || !d.alive) continue;
    if ((d.mass || 0) < minMassKg) continue;
    if (!d.orbit) continue;
    orbitToSceneCartesianInto(d.orbit, _scanPos, _scanVel);
    const dx = _scanPos.x - playerPos.x;
    const dy = _scanPos.y - playerPos.y;
    const dz = _scanPos.z - playerPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      if (best) {
        // Reuse the result object — allocations only on the first hit.
        best.debris = d;
        best.pos.x = _scanPos.x; best.pos.y = _scanPos.y; best.pos.z = _scanPos.z;
      } else {
        best = { debris: d, pos: { x: _scanPos.x, y: _scanPos.y, z: _scanPos.z }, distScene: 0 };
      }
    }
  }
  if (best) best.distScene = Math.sqrt(bestDistSq);
  return best;
}

/**
 * Classify the bearing from the player to a target in pilot-friendly orbital
 * terms: along-track (prograde/retrograde/abeam) + radial (high/low).
 *
 * @param {{x,y,z}} playerPos — scene units (also defines the radial direction)
 * @param {{x,y,z}} playerVel — any consistent units (direction only)
 * @param {{x,y,z}} targetPos — scene units
 * @returns {{ distKm: number, label: string, along: number, radial: number }}
 */
export function classifyBearing(playerPos, playerVel, targetPos) {
  const dx = targetPos.x - playerPos.x;
  const dy = targetPos.y - playerPos.y;
  const dz = targetPos.z - playerPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const distKm = dist / (Constants.SCENE_SCALE || 0.01);
  if (dist < 1e-12) return { distKm: 0, label: 'overhead', along: 0, radial: 0 };

  const tx = dx / dist, ty = dy / dist, tz = dz / dist;

  // Along-track component (vs. velocity direction)
  let along = 0;
  const vmag = Math.sqrt(playerVel.x * playerVel.x + playerVel.y * playerVel.y + playerVel.z * playerVel.z);
  if (vmag > 1e-12) {
    along = (tx * playerVel.x + ty * playerVel.y + tz * playerVel.z) / vmag;
  }

  // Radial component (vs. local "up" — away from Earth's center)
  let radial = 0;
  const pmag = Math.sqrt(playerPos.x * playerPos.x + playerPos.y * playerPos.y + playerPos.z * playerPos.z);
  if (pmag > 1e-12) {
    radial = (tx * playerPos.x + ty * playerPos.y + tz * playerPos.z) / pmag;
  }

  const alongLabel = along > 0.34 ? 'prograde' : (along < -0.34 ? 'retrograde' : 'abeam');
  const radialLabel = radial > 0.34 ? 'high' : (radial < -0.34 ? 'low' : '');
  const label = radialLabel ? `${alongLabel}-${radialLabel}` : alongLabel;
  return { distKm, label, along, radial };
}

/**
 * Human-friendly distance string: "850 m", "4.2 km", "38 km", "310 km".
 * @param {number} distKm
 * @returns {string}
 */
export function formatDistanceKm(distKm) {
  if (distKm < 1) return `${Math.max(1, Math.round(distKm * 1000))} m`;
  if (distKm < 10) return `${distKm.toFixed(1)} km`;
  return `${Math.round(distKm)} km`;
}

// ============================================================================
// ADVISOR
// ============================================================================

export class NavRecoveryAdvisor {
  constructor() {
    this._player = null;
    this._debrisField = null;
    this._targetSelector = null;
    this._skillsSystem = null;
    this._enabled = false;

    this._accum = 0;
    /** Seconds spent continuously "lost" (no target + nothing in reach). */
    this._lostS = 0;
    /** Seconds since the watchdog last fired. */
    this._sinceWatchdogHint = WATCHDOG_COOLDOWN_S;
    /** Seconds since the empty-scan guidance last fired. */
    this._sinceScanHint = SCAN_HINT_COOLDOWN_S;

    this._onScanComplete = this._onScanComplete.bind(this);
  }

  /**
   * @param {object} deps
   * @param {object} deps.player — PlayerSatellite (getPosition/getVelocity)
   * @param {object} deps.debrisField — exposes `.debrisList`
   * @param {object} [deps.targetSelector] — exposes getActiveTarget()
   * @param {object} [deps.skillsSystem] — exposes isVeteran()
   */
  init({ player, debrisField, targetSelector = null, skillsSystem = null } = {}) {
    this._player = player || null;
    this._debrisField = debrisField || null;
    this._targetSelector = targetSelector;
    this._skillsSystem = skillsSystem;
    this._enabled = !!(player && debrisField);
    eventBus.on(Events.SCAN_COMPLETE, this._onScanComplete);
  }

  dispose() {
    this._enabled = false;
    eventBus.off(Events.SCAN_COMPLETE, this._onScanComplete);
  }

  _isVeteran() {
    return !!(this._skillsSystem && typeof this._skillsSystem.isVeteran === 'function'
      && this._skillsSystem.isVeteran());
  }

  /**
   * Empty-scan → actionable bearing guidance. Fires for everyone (it's a
   * direct response to a player action), throttled so scan-spamming doesn't
   * repeat it.
   * @private
   */
  _onScanComplete(data) {
    if (!this._enabled) return;
    if (!data || data.rewardKind !== 'empty') return;
    if (this._sinceScanHint < SCAN_HINT_COOLDOWN_S) return;
    this._sinceScanHint = 0;
    this._postGuidance();
  }

  /**
   * @param {number} dt — real seconds
   */
  update(dt) {
    if (!this._enabled) return;
    this._sinceWatchdogHint += dt;
    this._sinceScanHint += dt;

    this._accum += dt;
    if (this._accum < TICK_S) return;
    const step = this._accum;
    this._accum = 0;

    // Watchdog is coaching — veterans never see it.
    if (this._isVeteran()) { this._lostS = 0; return; }

    const hasTarget = !!(this._targetSelector
      && typeof this._targetSelector.getActiveTarget === 'function'
      && this._targetSelector.getActiveTarget());
    if (hasTarget) { this._lostS = 0; return; }

    const playerPos = this._playerPos();
    if (!playerPos) { this._lostS = 0; return; }
    const nearest = findNearestLiveDebris(playerPos, this._debrisField.debrisList || []);
    const inReach = nearest && nearest.distScene <= NEARBY_RADIUS_SCENE;
    if (inReach) { this._lostS = 0; return; }

    this._lostS += step;
    if (this._lostS >= LOST_DWELL_S && this._sinceWatchdogHint >= WATCHDOG_COOLDOWN_S) {
      this._sinceWatchdogHint = 0;
      this._lostS = 0;
      this._postGuidance();
    }
  }

  /** @private Player position as a plain {x,y,z} (scene units). */
  _playerPos() {
    if (!this._player || typeof this._player.getPosition !== 'function') return null;
    const p = this._player.getPosition();
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }

  /** @private Player velocity as a plain {x,y,z}. */
  _playerVel() {
    if (!this._player || typeof this._player.getVelocity !== 'function') return { x: 0, y: 0, z: 0 };
    const v = this._player.getVelocity();
    return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0, z: 0 };
  }

  /**
   * Post the recovery line: bearing + distance to the nearest live contact,
   * or map guidance when the field is genuinely empty.
   * @private
   */
  _postGuidance() {
    const playerPos = this._playerPos();
    if (!playerPos || !this._debrisField) return;
    const nearest = findNearestLiveDebris(playerPos, this._debrisField.debrisList || []);

    if (!nearest) {
      // Field genuinely empty — disambiguate "lost" from "done" (#11.4):
      // mission-progress milestones are handled by GameFlowManager (#12);
      // here we only route the player to the next cluster.
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'No live contacts remain in this field. Open the Debris Map (`) to pick your next cluster, then press A.',
        priority: 'info',
        _postOnboarding: true,
      });
      return;
    }

    const bearing = classifyBearing(playerPos, this._playerVel(), nearest.pos);
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: `Nearest contact ~${formatDistanceKm(bearing.distKm)}, ${bearing.label}. Press A to approach.`,
      priority: 'info',
      _postOnboarding: true,
    });
  }
}

export const navRecoveryAdvisor = new NavRecoveryAdvisor();
