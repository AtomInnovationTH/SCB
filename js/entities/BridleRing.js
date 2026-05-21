/**
 * BridleRing.js — Simplified Bridle Ring (Config G, ST-9.7 C-8)
 *
 * Per-arm load-distribution ring at strut tip. Replaces Y-harness (superseded
 * by Config G — see ARM_PIVOT_GAPS_EXPLAINER.md §V-6).
 *
 * The bridle ring is a metadata/load-distribution element: it tracks which
 * payloads (nets, daughters, debris) are attached to the strut tip and how
 * load is distributed across multiple attach points.
 *
 * All behavior gated behind FEATURE_FLAGS.BRIDLE_RING (default false).
 *
 * @module entities/BridleRing
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const BR = Constants.OCTOPUS_V5.BRIDLE;
const STATES = Constants.BRIDLE_STATES;

// ═══════════════════════════════════════════════════════════════════════════
// §1  Per-Ring Data Store
// ═══════════════════════════════════════════════════════════════════════════

/** @type {Map<number, object>} armIndex → ring data */
const _rings = new Map();

/**
 * Create a fresh attach point.
 * @param {number} index — 0-based point index
 * @returns {object}
 */
function _makePoint(index) {
  return {
    id: `pt-${index}`,
    name: `Point ${index}`,
    currentLoadKg: 0,
    maxLoadKg: BR.MAX_LOAD_PER_POINT_KG,
    isOccupied: false,
    payloadId: null,
  };
}

/**
 * Compute load balance factor across attach points.
 * 1.0 = perfectly balanced (all points equal load).
 * Lower = more imbalanced. 0 if only one point loaded.
 *
 * Uses 1 - (σ / μ) where σ is std-dev and μ is mean of occupied loads.
 * If no load, returns 1.0. If single point loaded, returns 0.33 (1/N).
 *
 * @param {object[]} points — attach points array
 * @returns {number} balance factor ∈ [0, 1]
 */
export function computeLoadBalance(points) {
  const n = points.length;
  if (n === 0) return 1.0;

  const totalLoad = points.reduce((s, p) => s + p.currentLoadKg, 0);
  if (totalLoad <= 0) return 1.0;

  const mean = totalLoad / n;
  const variance = points.reduce((s, p) => s + (p.currentLoadKg - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  // Coefficient of variation inverted: 1 - (σ/μ), clamped to [0, 1]
  if (mean <= 0) return 1.0;
  const cv = stddev / mean;
  return Math.max(0, Math.min(1, 1 - cv));
}

// ═══════════════════════════════════════════════════════════════════════════
// §2  Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create (or re-create) a bridle ring for a given arm.
 *
 * @param {number} armIndex
 * @param {number} [numAttachPoints=3] — number of hardpoints
 * @returns {object} ring status snapshot
 */
export function create(armIndex, numAttachPoints = BR.ATTACH_POINTS_PER_RING) {
  const points = [];
  for (let i = 0; i < numAttachPoints; i++) {
    points.push(_makePoint(i));
  }
  const ring = {
    armIndex,
    attachPoints: points,
    state: STATES.IDLE,
  };
  _rings.set(armIndex, ring);
  return getStatus(armIndex);
}

/**
 * Attach a payload to a specific point on a ring.
 *
 * @param {number} armIndex
 * @param {string} pointId — e.g. 'pt-0'
 * @param {string} payloadId — unique payload ID
 * @param {number} loadKg — mass in kg
 * @returns {boolean} true if attached successfully
 */
export function attach(armIndex, pointId, payloadId, loadKg) {
  const ring = _rings.get(armIndex);
  if (!ring) return false;

  const pt = ring.attachPoints.find(p => p.id === pointId);
  if (!pt) return false;
  if (pt.isOccupied) return false;

  pt.isOccupied = true;
  pt.payloadId = payloadId;
  pt.currentLoadKg = loadKg;

  // Update state
  _updateState(ring);

  eventBus.emit(Events.BRIDLE_ATTACH, {
    armIndex,
    pointId,
    payloadId,
    loadKg,
  });

  // Check overload
  checkOverload(armIndex);

  return true;
}

/**
 * Detach payload from a specific point.
 *
 * @param {number} armIndex
 * @param {string} pointId
 * @returns {boolean} true if detached successfully
 */
export function detach(armIndex, pointId) {
  const ring = _rings.get(armIndex);
  if (!ring) return false;

  const pt = ring.attachPoints.find(p => p.id === pointId);
  if (!pt || !pt.isOccupied) return false;

  const payloadId = pt.payloadId;

  pt.isOccupied = false;
  pt.payloadId = null;
  pt.currentLoadKg = 0;

  _updateState(ring);

  eventBus.emit(Events.BRIDLE_DETACH, {
    armIndex,
    pointId,
    payloadId,
  });

  return true;
}

/**
 * Get full status for a ring.
 *
 * @param {number} armIndex
 * @returns {object|null} { armIndex, attachPoints, totalLoadKg, loadBalanceFactor, state }
 */
export function getStatus(armIndex) {
  const ring = _rings.get(armIndex);
  if (!ring) return null;

  const totalLoadKg = getTotalLoadKg(armIndex);
  const loadBalanceFactor = computeLoadBalance(ring.attachPoints);

  return {
    armIndex: ring.armIndex,
    attachPoints: ring.attachPoints.map(p => ({ ...p })),
    totalLoadKg,
    loadBalanceFactor,
    state: ring.state,
  };
}

/**
 * Get total load across all attach points for an arm.
 *
 * @param {number} armIndex
 * @returns {number} total kg (0 if ring doesn't exist)
 */
export function getTotalLoadKg(armIndex) {
  const ring = _rings.get(armIndex);
  if (!ring) return 0;
  return ring.attachPoints.reduce((s, p) => s + p.currentLoadKg, 0);
}

/**
 * Check if any attach point exceeds overload threshold.
 * Sets DAMAGED state and emits BRIDLE_OVERLOAD if so.
 *
 * @param {number} armIndex
 * @returns {boolean} true if any point is overloaded
 */
export function checkOverload(armIndex) {
  const ring = _rings.get(armIndex);
  if (!ring) return false;

  let overloaded = false;
  for (const pt of ring.attachPoints) {
    const overloadThreshold = pt.maxLoadKg * BR.OVERLOAD_FACTOR;
    if (pt.currentLoadKg > overloadThreshold) {
      ring.state = STATES.DAMAGED;
      overloaded = true;
      eventBus.emit(Events.BRIDLE_OVERLOAD, {
        armIndex,
        pointId: pt.id,
        loadKg: pt.currentLoadKg,
        maxKg: pt.maxLoadKg,
      });
    }
  }
  return overloaded;
}

/**
 * Find the first unoccupied attach point on a ring.
 *
 * @param {number} armIndex
 * @returns {string|null} pointId or null
 */
export function findFreePoint(armIndex) {
  const ring = _rings.get(armIndex);
  if (!ring) return null;
  const free = ring.attachPoints.find(p => !p.isOccupied);
  return free ? free.id : null;
}

/**
 * Get bridle ring mass for a given arm (ring structure + attached loads).
 * Used by CoMCalculator integration.
 *
 * @param {number} armIndex
 * @returns {number} mass in kg (0 if ring doesn't exist)
 */
export function getRingMassKg(armIndex) {
  const ring = _rings.get(armIndex);
  if (!ring) return 0;
  return BR.RING_MASS_KG + getTotalLoadKg(armIndex);
}

/**
 * Get serializable state for persistence.
 *
 * @returns {Array<{armIndex: number, attachments: Array}>}
 */
export function getSerializableState() {
  const result = [];
  for (const [armIndex, ring] of _rings) {
    const attachments = ring.attachPoints
      .filter(p => p.isOccupied)
      .map(p => ({
        pointId: p.id,
        payloadId: p.payloadId,
        loadKg: p.currentLoadKg,
      }));
    result.push({
      armIndex,
      state: ring.state,
      attachments,
    });
  }
  return result;
}

/**
 * Restore state from persistence data.
 *
 * @param {Array<{armIndex: number, state?: string, attachments: Array}>} data
 */
export function restoreState(data) {
  if (!Array.isArray(data)) return;
  for (const entry of data) {
    create(entry.armIndex);
    const ring = _rings.get(entry.armIndex);
    if (!ring) continue;

    if (entry.state && Object.values(STATES).includes(entry.state)) {
      ring.state = entry.state;
    }

    for (const att of (entry.attachments || [])) {
      const pt = ring.attachPoints.find(p => p.id === att.pointId);
      if (pt) {
        pt.isOccupied = true;
        pt.payloadId = att.payloadId;
        pt.currentLoadKg = att.loadKg || 0;
      }
    }
    _updateState(ring);
  }
}

/**
 * Get all ring arm indices currently tracked.
 * @returns {number[]}
 */
export function getAllArmIndices() {
  return [..._rings.keys()];
}

/**
 * Reset all rings (game reset).
 */
export function resetAll() {
  _rings.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// §3  Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update ring state based on current attach points.
 * @param {object} ring
 */
function _updateState(ring) {
  // Don't downgrade from DAMAGED
  if (ring.state === STATES.DAMAGED) return;

  const hasOccupied = ring.attachPoints.some(p => p.isOccupied);
  ring.state = hasOccupied ? STATES.ATTACHED : STATES.IDLE;
}

// ═══════════════════════════════════════════════════════════════════════════
// §4  Singleton-style Module Export
// ═══════════════════════════════════════════════════════════════════════════

export const BridleRing = {
  create,
  attach,
  detach,
  getStatus,
  getTotalLoadKg,
  checkOverload,
  findFreePoint,
  getRingMassKg,
  getSerializableState,
  restoreState,
  getAllArmIndices,
  resetAll,
  computeLoadBalance,
};

export default BridleRing;
