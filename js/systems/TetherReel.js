/**
 * TetherReel.js — Strut-Mounted Tether Reel System (Config G §10.4)
 * ST-9.5 C-7
 *
 * Each arm has an independent tether reel mounted at the strut tip.
 * The reel manages cable pay-out, reel-in, jamming, and cut states.
 *
 * Cable origin: ArmUnit.getTetherAnchorWorldPosition() (strut tip, from C-3).
 * Cable physics: straight-line model with Hooke's law restoring force at max extension.
 *
 * Gated by FEATURE_FLAGS.TETHER_REEL (default false).
 * When OFF: all APIs return defaults / no-ops. Existing tether behavior unchanged.
 *
 * State machine:
 *   STOWED → PAYING_OUT → STATIC ↔ REELING_IN → STOWED
 *   (any state → JAMMED or CUT)
 *
 * @module systems/TetherReel
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const RS = Constants.REEL_STATES;
const V5 = Constants.OCTOPUS_V5;
const REEL = V5.REEL;

/**
 * Valid state transitions. Map from current state → set of legal next states.
 * JAMMED and CUT are reachable from any state (except CUT is terminal).
 * @private
 */
const VALID_TRANSITIONS = {
  [RS.STOWED]:      new Set([RS.PAYING_OUT, RS.JAMMED, RS.CUT]),
  [RS.PAYING_OUT]:  new Set([RS.STATIC, RS.JAMMED, RS.CUT]),
  [RS.STATIC]:      new Set([RS.PAYING_OUT, RS.REELING_IN, RS.JAMMED, RS.CUT]),
  [RS.REELING_IN]:  new Set([RS.STOWED, RS.STATIC, RS.JAMMED, RS.CUT]),
  [RS.JAMMED]:      new Set([RS.STATIC, RS.CUT]),  // clearJam → STATIC
  [RS.CUT]:         new Set([]),                     // terminal — no transitions out
};

/**
 * Per-arm reel state record.
 * @typedef {object} ReelRecord
 * @property {string}  state           — current REEL_STATES enum value
 * @property {number}  cableLengthM    — metres of cable currently paid out
 * @property {number}  targetLengthM   — target length for payout (PAYING_OUT only)
 * @property {number}  tensionN        — current cable tension in Newtons
 * @property {number}  payloadMassKg   — mass attached to cable end (for reel-in scaling)
 * @property {string|null} attachedEndpointId — debris/daughter id on far end (if any)
 * @property {number}  jamClearCooldownS — remaining cooldown before clearJam is available
 * @property {number}  tensionWarnTimer — debounce timer for TETHER_TENSION_HIGH (seconds)
 * @property {number}  maxCableLengthM  — per-tier max cable length
 */

/**
 * Get the max cable length for a given arm tier name.
 * @param {string} [tierName='Y0'] — 'Y0', 'Y1', or 'Y3'
 * @returns {number} max cable length in metres
 */
function getMaxCableForTier(tierName) {
  const tierKey = tierName || 'Y0';
  return REEL.MAX_CABLE_LENGTH_M[tierKey] || REEL.MAX_CABLE_LENGTH_M.Y0;
}

class TetherReelSystem {
  constructor() {
    /** @type {Map<number, ReelRecord>} Per-arm reel states keyed by armIndex */
    this._reels = new Map();
    /** @type {object|null} Reference to ArmManager (set via init) */
    this._armManager = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §1  Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize the tether reel system.
   * Call after ArmManager is constructed and arms are assigned indices.
   * @param {object} armManager — ArmManager instance with .arms[]
   * @param {string} [tierName='Y0'] — arm tier for max cable length
   */
  init(armManager, tierName) {
    this._armManager = armManager;
    this._reels.clear();
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return;

    const arms = armManager?.arms || [];
    for (let i = 0; i < arms.length; i++) {
      this._reels.set(i, this._createReelRecord(tierName));
    }
  }

  /**
   * Create a fresh reel record with default values.
   * @private
   * @param {string} [tierName='Y0']
   * @returns {ReelRecord}
   */
  _createReelRecord(tierName) {
    return {
      state: RS.STOWED,
      cableLengthM: 0,
      targetLengthM: 0,
      tensionN: 0,
      payloadMassKg: 0,
      attachedEndpointId: null,
      jamClearCooldownS: 0,
      tensionWarnTimer: 0,
      maxCableLengthM: getMaxCableForTier(tierName),
    };
  }

  /**
   * Reset all reels to STOWED (e.g. new game).
   */
  reset() {
    for (const [idx, reel] of this._reels) {
      Object.assign(reel, this._createReelRecord());
      reel.maxCableLengthM = reel.maxCableLengthM; // preserve tier
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §2  State Machine
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Attempt a state transition for a reel.
   * @private
   * @param {number} armIndex
   * @param {string} newState — REEL_STATES value
   * @returns {boolean} whether the transition was valid and applied
   */
  _transition(armIndex, newState) {
    const reel = this._reels.get(armIndex);
    if (!reel) return false;

    const valid = VALID_TRANSITIONS[reel.state];
    if (!valid || !valid.has(newState)) {
      console.warn(`[TetherReel] Invalid transition ${reel.state} → ${newState} for arm ${armIndex}`);
      return false;
    }
    reel.state = newState;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §3  Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Pay out cable to target length.
   * @param {number} armIndex
   * @param {number} lengthM — target cable length in metres
   * @returns {boolean} whether pay-out was initiated
   */
  payOut(armIndex, lengthM) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return false;
    const reel = this._reels.get(armIndex);
    if (!reel) return false;

    // Only from STOWED or STATIC
    if (reel.state !== RS.STOWED && reel.state !== RS.STATIC) return false;

    const targetLen = Math.min(lengthM, reel.maxCableLengthM);
    if (targetLen <= reel.cableLengthM) return false;

    const newState = RS.PAYING_OUT;
    if (!this._transition(armIndex, newState)) return false;

    reel.targetLengthM = targetLen;
    eventBus.emit(Events.TETHER_PAYOUT_STARTED, { armIndex, targetLengthM: targetLen });
    return true;
  }

  /**
   * Start reeling in the cable.
   * @param {number} armIndex
   * @param {number} [ratePerS] — override reel-in rate (default from constants)
   * @returns {boolean} whether reel-in was initiated
   */
  reelIn(armIndex, ratePerS) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return false;
    const reel = this._reels.get(armIndex);
    if (!reel) return false;

    // Only from STATIC (or PAYING_OUT via STATIC transition)
    if (reel.state === RS.PAYING_OUT) {
      // Stop payout first, go to STATIC
      this._transition(armIndex, RS.STATIC);
    }
    if (reel.state !== RS.STATIC) return false;
    if (reel.cableLengthM <= 0) {
      // Already fully spooled — snap to STOWED
      this._transition(armIndex, RS.REELING_IN);
      reel.cableLengthM = 0;
      this._transition(armIndex, RS.STOWED);
      eventBus.emit(Events.TETHER_REELIN_COMPLETED, { armIndex });
      return true;
    }

    if (!this._transition(armIndex, RS.REELING_IN)) return false;

    eventBus.emit(Events.TETHER_REELIN_STARTED, { armIndex, payloadMassKg: reel.payloadMassKg });
    return true;
  }

  /**
   * Emergency cable severance.
   * @param {number} armIndex
   * @param {string} [reason='manual'] — reason for cut
   * @returns {boolean} whether cut was performed
   */
  cut(armIndex, reason) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return false;
    const reel = this._reels.get(armIndex);
    if (!reel) return false;
    if (reel.state === RS.CUT) return false; // already cut

    if (!this._transition(armIndex, RS.CUT)) return false;

    reel.tensionN = 0;
    reel.attachedEndpointId = null;
    eventBus.emit(Events.TETHER_CUT, { armIndex, reason: reason || 'manual' });
    return true;
  }

  /**
   * Clear a jammed reel (player action with cooldown).
   * @param {number} armIndex
   * @returns {boolean} whether jam was cleared
   */
  clearJam(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return false;
    const reel = this._reels.get(armIndex);
    if (!reel) return false;
    if (reel.state !== RS.JAMMED) return false;
    if (reel.jamClearCooldownS > 0) return false;

    this._transition(armIndex, RS.STATIC);
    return true;
  }

  /**
   * Get current cable length in metres.
   * @param {number} armIndex
   * @returns {number}
   */
  getCableLength(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return 0;
    return this._reels.get(armIndex)?.cableLengthM ?? 0;
  }

  /**
   * Get max cable length for an arm.
   * @param {number} armIndex
   * @returns {number}
   */
  getMaxCableLength(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return 0;
    return this._reels.get(armIndex)?.maxCableLengthM ?? 0;
  }

  /**
   * Get current cable tension in Newtons.
   * @param {number} armIndex
   * @returns {number}
   */
  getTensionN(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return 0;
    return this._reels.get(armIndex)?.tensionN ?? 0;
  }

  /**
   * Get reel state for an arm.
   * @param {number} armIndex
   * @returns {string} REEL_STATES enum value
   */
  getReelState(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return RS.STOWED;
    return this._reels.get(armIndex)?.state ?? RS.STOWED;
  }

  /**
   * Attach an endpoint (debris/daughter) to the cable end.
   * @param {number} armIndex
   * @param {string} endpointId
   * @param {number} massKg — payload mass on the far end
   */
  attachEndpoint(armIndex, endpointId, massKg) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return;
    const reel = this._reels.get(armIndex);
    if (!reel) return;
    reel.attachedEndpointId = endpointId;
    reel.payloadMassKg = massKg || 0;
  }

  /**
   * Detach endpoint from cable end (without cutting).
   * @param {number} armIndex
   */
  detachEndpoint(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return;
    const reel = this._reels.get(armIndex);
    if (!reel) return;
    reel.attachedEndpointId = null;
    reel.payloadMassKg = 0;
  }

  /**
   * Get the full reel record for an arm (for HUD / persistence).
   * @param {number} armIndex
   * @returns {ReelRecord|null}
   */
  getReelRecord(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return null;
    return this._reels.get(armIndex) || null;
  }

  /**
   * Get all reel records (for persistence).
   * @returns {Array<{armIndex: number, state: string, cableLengthM: number, attachedEndpointId: string|null}>}
   */
  getAllReelStates() {
    const result = [];
    for (const [idx, reel] of this._reels) {
      result.push({
        armIndex: idx,
        state: reel.state,
        cableLengthM: reel.cableLengthM,
        attachedEndpointId: reel.attachedEndpointId,
      });
    }
    return result;
  }

  /**
   * Restore reel states from persistence data.
   * Mid-transition states snap to safe states:
   *   PAYING_OUT → STATIC, REELING_IN → STOWED, JAMMED → JAMMED (preserved)
   * @param {Array<{armIndex: number, state: string, cableLengthM: number, attachedEndpointId: string|null}>} data
   */
  restoreFromPersistence(data) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return;
    if (!Array.isArray(data)) return;

    for (const entry of data) {
      const reel = this._reels.get(entry.armIndex);
      if (!reel) continue;

      // Snap mid-transition states
      let state = entry.state;
      if (state === RS.PAYING_OUT) state = RS.STATIC;
      if (state === RS.REELING_IN) state = RS.STOWED;
      // CUT and JAMMED are preserved as-is

      reel.state = state;
      reel.cableLengthM = (state === RS.STOWED) ? 0 : (entry.cableLengthM || 0);
      reel.attachedEndpointId = entry.attachedEndpointId || null;
      reel.tensionN = 0;
      reel.targetLengthM = reel.cableLengthM;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §4  Per-Frame Update (Cable Physics)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Tick the reel system. Called from the game loop each frame.
   * Processes pay-out, reel-in, tension, and jam/break checks.
   *
   * @param {number} dt — delta time in seconds
   * @param {Function} [getEndpointDistance] — (armIndex) => distance in metres
   *   from strut tip to attached endpoint. Used for tension calculation.
   */
  update(dt, getEndpointDistance) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return;

    for (const [armIndex, reel] of this._reels) {
      // Decrement jam cooldown
      if (reel.jamClearCooldownS > 0) {
        reel.jamClearCooldownS = Math.max(0, reel.jamClearCooldownS - dt);
      }

      // Decrement tension warning debounce
      if (reel.tensionWarnTimer > 0) {
        reel.tensionWarnTimer = Math.max(0, reel.tensionWarnTimer - dt);
      }

      switch (reel.state) {
        case RS.PAYING_OUT:
          this._tickPayOut(armIndex, reel, dt);
          break;
        case RS.REELING_IN:
          this._tickReelIn(armIndex, reel, dt);
          break;
        case RS.STATIC:
        case RS.JAMMED:
          // Tension update for cable under load
          this._tickTension(armIndex, reel, dt, getEndpointDistance);
          break;
        case RS.STOWED:
        case RS.CUT:
          reel.tensionN = 0;
          break;
      }
    }
  }

  /**
   * Tick PAYING_OUT state — extend cable towards target length.
   * @private
   */
  _tickPayOut(armIndex, reel, dt) {
    const rate = REEL.PAYOUT_RATE_M_PER_S;
    const remaining = reel.targetLengthM - reel.cableLengthM;

    if (remaining <= 0) {
      // Reached target — transition to STATIC
      reel.cableLengthM = reel.targetLengthM;
      this._transition(armIndex, RS.STATIC);
      return;
    }

    const extend = Math.min(rate * dt, remaining);
    reel.cableLengthM += extend;

    // Clamp to max
    if (reel.cableLengthM >= reel.maxCableLengthM) {
      reel.cableLengthM = reel.maxCableLengthM;
      this._transition(armIndex, RS.STATIC);
      return;
    }

    // Check if target reached after extending
    if (reel.cableLengthM >= reel.targetLengthM) {
      reel.cableLengthM = reel.targetLengthM;
      this._transition(armIndex, RS.STATIC);
    }
  }

  /**
   * Tick REELING_IN state — retract cable towards zero.
   * Speed scales inversely with payload mass.
   * @private
   */
  _tickReelIn(armIndex, reel, dt) {
    // Speed scales: baseRate / (1 + payloadMass / 10)
    const baseRate = REEL.REEL_IN_RATE_M_PER_S;
    const massScale = 1 + (reel.payloadMassKg / 10);
    const rate = baseRate / massScale;

    reel.cableLengthM -= rate * dt;

    // Jam check: small probability per reel cycle (simplified per-frame)
    // Apply probability scaled by dt to approximate per-cycle probability
    if (Math.random() < REEL.JAM_PROBABILITY_PER_REEL * dt) {
      this._triggerJam(armIndex, reel);
      return;
    }

    if (reel.cableLengthM <= 0) {
      reel.cableLengthM = 0;
      reel.tensionN = 0;
      this._transition(armIndex, RS.STOWED);
      eventBus.emit(Events.TETHER_REELIN_COMPLETED, { armIndex });
    }
  }

  /**
   * Compute cable tension when cable is static or jammed.
   * If endpoint distance > cable length, apply Hooke's law restoring force.
   * @private
   */
  _tickTension(armIndex, reel, dt, getEndpointDistance) {
    if (!getEndpointDistance) {
      reel.tensionN = 0;
      return;
    }

    const endpointDist = getEndpointDistance(armIndex);
    if (endpointDist === null || endpointDist === undefined) {
      reel.tensionN = 0;
      return;
    }

    const overExtension = endpointDist - reel.cableLengthM;

    if (overExtension > 0) {
      // Cable taut — Hooke's law: F = K * x + C * dx/dt
      // Simplified: tension = K * overExtension (damping requires velocity, which
      // we approximate as overExtension rate — but we don't track previous overExt
      // here, so use pure spring for simplicity)
      reel.tensionN = Math.min(
        REEL.CABLE_SPRING_K * overExtension,
        REEL.BREAKING_TENSION_N * 1.5  // allow slight overshoot before break check
      );
    } else {
      // Cable slack
      reel.tensionN = 0;
    }

    // Breaking tension check
    if (reel.tensionN >= REEL.BREAKING_TENSION_N) {
      // Overload — trigger CUT or JAM depending on how far over
      if (reel.tensionN >= REEL.BREAKING_TENSION_N * 1.2) {
        // Snap — emergency CUT
        this.cut(armIndex, 'overload');
      } else {
        // Marginal overload — JAM
        this._triggerJam(armIndex, reel);
      }
      return;
    }

    // Debounced tension warning at >75% of breaking
    const warningThreshold = REEL.BREAKING_TENSION_N * REEL.TENSION_WARNING_FRAC;
    if (reel.tensionN > warningThreshold && reel.tensionWarnTimer <= 0) {
      eventBus.emit(Events.TETHER_TENSION_HIGH, {
        armIndex,
        tensionN: reel.tensionN,
        breakingN: REEL.BREAKING_TENSION_N,
      });
      reel.tensionWarnTimer = 2.0; // debounce: 2 seconds between warnings
    }
  }

  /**
   * Trigger a jam on a reel.
   * @private
   */
  _triggerJam(armIndex, reel) {
    if (reel.state === RS.JAMMED || reel.state === RS.CUT) return;
    this._transition(armIndex, RS.JAMMED);
    reel.jamClearCooldownS = REEL.JAM_CLEAR_COOLDOWN_S;
    eventBus.emit(Events.TETHER_JAMMED, { armIndex, lengthM: reel.cableLengthM });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §5  Cable Mass Contribution (for CoM)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the mass of cable currently paid out for a given arm.
   * Cable mass = cableLengthM × CABLE_MASS_PER_M_KG.
   *
   * Note: Per §10.4, cable mass is small (max 50m × 0.05 kg/m = 2.5 kg for Y0).
   * The reel housing mass (1.2 kg) is already included in STRUT_MASS (4.5 kg).
   * Paid-out cable mass is negligible for CoM (< 1.3% of total dry mass at Y0 max).
   * We expose the method for correctness but document the negligible impact.
   *
   * @param {number} armIndex
   * @returns {number} cable mass in kg
   */
  getCableMassKg(armIndex) {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return 0;
    const reel = this._reels.get(armIndex);
    if (!reel) return 0;
    return reel.cableLengthM * REEL.CABLE_MASS_PER_M_KG;
  }

  /**
   * Get the total mass of all cable currently paid out (all arms).
   * @returns {number} total cable mass in kg
   */
  getTotalCableMassKg() {
    if (!Constants.FEATURE_FLAGS.TETHER_REEL) return 0;
    let total = 0;
    for (const [, reel] of this._reels) {
      total += reel.cableLengthM * REEL.CABLE_MASS_PER_M_KG;
    }
    return total;
  }
}

/** Singleton instance */
export const tetherReel = new TetherReelSystem();
export default tetherReel;
