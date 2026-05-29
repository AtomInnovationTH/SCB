/**
 * QualityManager.js — Pure, stateless quality-tier selection + runtime adapt.
 *
 * Pure data in, pure decision out. Node-safe: no THREE, no document, no window.
 * The caller (main.js / SceneManager) owns the rolling FPS history and the
 * `framesSinceLastChange` counter; this module just reads them and returns
 * a decision.
 *
 * Tier configs live in [`Constants.PERF.QUALITY_TIERS`](../core/Constants.js).
 * Cross-module notification uses [`Events.PERF_TIER_CHANGED`](../core/Events.js).
 *
 * @module systems/QualityManager
 */

/**
 * Canonical tier ordering from highest to lowest quality.
 * Used by `runtimeAdapt` to find the "next step down" when downshifting.
 */
export const TIER_ORDER = ['HIGH', 'MEDIUM', 'LOW'];

/**
 * Compute the median of a numeric array (non-mutating).
 * - Empty array returns `NaN` (documented choice — callers gate on history
 *   length before calling, so an "empty" result is never a numeric 0).
 * - Odd lengths return the middle element.
 * - Even lengths return the mean of the two middle elements.
 *
 * @param {number[]} arr
 * @returns {number}
 */
export function medianOf(arr) {
  if (!arr || arr.length === 0) return NaN;
  // Copy then sort to avoid mutating the caller's history buffer.
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pick an initial quality tier from device capability hints.
 *
 * Heuristics (documented inline):
 *   - 16K-capable GPU + (Apple Silicon OR ≥ 8 GB RAM) → HIGH
 *   - 8K-capable GPU + ≥ 4 GB RAM                     → MEDIUM
 *   - Otherwise                                       → LOW
 *
 * Missing / undefined inputs fall through gracefully to `'MEDIUM'`
 * (safe middle) — never crash, never assume.
 *
 * @param {object} caps
 * @param {number} [caps.maxTextureSize]   — `renderer.capabilities.maxTextureSize`
 * @param {number} [caps.devicePixelRatio] — `window.devicePixelRatio`
 * @param {boolean} [caps.isAppleGPU]      — UNMASKED_RENDERER_WEBGL matches /Apple/i
 * @param {number} [caps.deviceMemoryGB]   — `navigator.deviceMemory` (GB)
 * @returns {'HIGH'|'MEDIUM'|'LOW'}
 */
export function selectInitialTier(caps) {
  const c = caps || {};
  const maxTex = Number.isFinite(c.maxTextureSize) ? c.maxTextureSize : null;
  const memGB = Number.isFinite(c.deviceMemoryGB) ? c.deviceMemoryGB : null;
  const isApple = c.isAppleGPU === true;

  // If we have no signal at all, return safe middle (MEDIUM).
  // We treat "no maxTextureSize" as the strongest "unknown" signal because
  // it's the most fundamental GPU capability and is almost always present
  // when this runs in a real browser.
  if (maxTex === null && memGB === null) return 'MEDIUM';

  // HIGH gate: must be 16K-capable AND (Apple Silicon GPU OR ≥ 8 GB RAM).
  // Apple Silicon is whitelisted because its unified memory + tile-based
  // renderer makes the bloom + SMAA path cheap even on integrated GPUs.
  if (maxTex !== null && maxTex >= 16384) {
    if (isApple || (memGB !== null && memGB >= 8)) {
      return 'HIGH';
    }
  }

  // MEDIUM gate: 8K-capable AND ≥ 4 GB RAM (typical Intel/AMD mid laptop).
  if (maxTex !== null && maxTex >= 8192 && memGB !== null && memGB >= 4) {
    return 'MEDIUM';
  }

  // If we only have a strong negative signal (low texture size OR low RAM),
  // pick LOW. Bare-unknown still falls back to MEDIUM above.
  if ((maxTex !== null && maxTex < 8192) || (memGB !== null && memGB < 4)) {
    return 'LOW';
  }

  // Partial signal that didn't trip any rule above — be safe.
  return 'MEDIUM';
}

/**
 * Decide whether to downshift OR upshift the current quality tier based on
 * recent FPS. Sprint 2 / PR B added the upshift path; the original downshift
 * semantics are unchanged.
 *
 * Rules (downshift):
 *   - Need at least HALF of `FPS_HISTORY_SIZE` samples before the first decision.
 *     (Avoids reacting to the warm-up window where caches are cold.)
 *   - Need `framesSinceLastChange >= cooldownFrames`.
 *   - Median FPS < `threshold` (default 50) → drop one step.
 *   - At LOW, never drops further.
 *
 * Rules (upshift — Sprint 2 / PR B):
 *   - Opt-in: only evaluates when both `upshiftThreshold` and `upshiftCooldownFrames`
 *     are finite numbers. If absent, behaviour is identical to the pre-PR-B function.
 *   - Need `framesSinceLastChange >= upshiftCooldownFrames` (typ. 600 — longer
 *     than downshift's 300; we're being optimistic, so we wait longer).
 *   - Median FPS ≥ `upshiftThreshold` (typ. 58) → promote one step. The gap
 *     between 50 (downshift) and 58 (upshift) is the hysteresis band that
 *     prevents HIGH ↔ MEDIUM ping-pong when the workload sits near 55 fps.
 *   - At HIGH, never promotes further.
 *
 * Priority: downshift wins over upshift in the (impossible-in-practice but
 * defensible) case both gates fire simultaneously — safety first.
 *
 * @param {object} params
 * @param {'HIGH'|'MEDIUM'|'LOW'} params.currentTier
 * @param {number[]} params.fpsHistory
 * @param {number} params.framesSinceLastChange
 * @param {number} params.threshold              — median fps below this triggers drop
 * @param {number} params.cooldownFrames
 * @param {number} [params.upshiftThreshold]     — median fps at-or-above this triggers promotion
 * @param {number} [params.upshiftCooldownFrames] — cooldown for promotion (typ. > cooldownFrames)
 * @param {number} [params.historySize]          — full window size (for half-fill gate);
 *                                                 defaults to `fpsHistory.length`.
 * @returns {{ nextTier: ('HIGH'|'MEDIUM'|'LOW'), changed: boolean, medianFps: number, direction: ('down'|'up'|null) }}
 */
export function runtimeAdapt(params) {
  const {
    currentTier,
    fpsHistory,
    framesSinceLastChange,
    threshold,
    cooldownFrames,
    upshiftThreshold,
    upshiftCooldownFrames,
    historySize,
  } = params || {};

  const noChange = (medFps = NaN) => ({
    nextTier: currentTier,
    changed: false,
    medianFps: medFps,
    direction: null,
  });

  if (!currentTier || !TIER_ORDER.includes(currentTier)) return noChange();
  if (!Array.isArray(fpsHistory) || fpsHistory.length === 0) return noChange();

  // Half-window gate: callers usually pass a capped rolling buffer plus the
  // full window size. If `historySize` isn't given we use the array length.
  const fullSize = Number.isFinite(historySize) && historySize > 0
    ? historySize
    : fpsHistory.length;
  if (fpsHistory.length < Math.floor(fullSize / 2)) return noChange();

  if (!Number.isFinite(framesSinceLastChange)) return noChange();

  const med = medianOf(fpsHistory);
  if (!Number.isFinite(med)) return noChange(med);

  const idx = TIER_ORDER.indexOf(currentTier);

  // --- DOWNSHIFT path (priority — safety first) ---------------------------
  const downshiftReady = framesSinceLastChange >= cooldownFrames
    && med < threshold
    && idx < TIER_ORDER.length - 1; // not at LOW
  if (downshiftReady) {
    return {
      nextTier: TIER_ORDER[idx + 1],
      changed: true,
      medianFps: med,
      direction: 'down',
    };
  }

  // --- UPSHIFT path (Sprint 2 / PR B) -------------------------------------
  // Opt-in: only when caller supplies both upshift knobs. Back-compat
  // callers (pre-PR-B) get the original downshift-only behaviour.
  const upshiftConfigured = Number.isFinite(upshiftThreshold)
    && Number.isFinite(upshiftCooldownFrames);
  if (upshiftConfigured) {
    const upshiftReady = framesSinceLastChange >= upshiftCooldownFrames
      && med >= upshiftThreshold
      && idx > 0; // not at HIGH
    if (upshiftReady) {
      return {
        nextTier: TIER_ORDER[idx - 1],
        changed: true,
        medianFps: med,
        direction: 'up',
      };
    }
  }

  return noChange(med);
}

export default {
  TIER_ORDER,
  medianOf,
  selectInitialTier,
  runtimeAdapt,
};
