/**
 * QualityManager.js — Pure, stateless quality-tier selection + runtime adapt.
 *
 * Node-safe: no THREE, document or window. The caller (main.js / SceneManager) owns the rolling FPS history and the
 * `framesSinceLastChange` counter; this module reads them and returns a decision.
 *
 * Tier configs: [`Constants.PERF.QUALITY_TIERS`](../core/Constants.js). Notification: [`Events.PERF_TIER_CHANGED`](../core/Events.js).
 *
 * @module systems/QualityManager
 */

/** Tier ordering, highest to lowest quality; `runtimeAdapt` steps along it. */
export const TIER_ORDER = ['HIGH', 'MEDIUM', 'LOW'];

/** Median of a numeric array (non-mutating). Empty → `NaN` (never a numeric 0; callers gate on history length). */
export function medianOf(arr) {
  if (!arr || arr.length === 0) return NaN;
  // Copy: don't mutate the caller's history buffer.
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pick an initial quality tier from device capability hints.
 *   - 16K-capable GPU + (Apple Silicon OR ≥ 8 GB RAM) → HIGH
 *   - 8K-capable GPU + ≥ 4 GB RAM                     → MEDIUM
 *   - Otherwise                                       → LOW
 * Missing inputs fall through to `'MEDIUM'` (safe middle); never crash, never assume.
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

  // No signal at all → MEDIUM. maxTextureSize is the most fundamental GPU capability, almost always present in a
  // real browser, so its absence is the strongest "unknown".
  if (maxTex === null && memGB === null) return 'MEDIUM';

  // Apple Silicon is whitelisted: unified memory + tile-based renderer make the bloom + SMAA path cheap.
  if (maxTex !== null && maxTex >= 16384) {
    if (isApple || (memGB !== null && memGB >= 8)) {
      return 'HIGH';
    }
  }

  if (maxTex !== null && maxTex >= 8192 && memGB !== null && memGB >= 4) {
    return 'MEDIUM';
  }

  // Only a strong negative signal (low texture size OR low RAM) picks LOW.
  if ((maxTex !== null && maxTex < 8192) || (memGB !== null && memGB < 4)) {
    return 'LOW';
  }

  return 'MEDIUM';
}

/**
 * Decide whether to downshift OR upshift the current quality tier based on recent FPS.
 *
 * Downshift:
 *   - Needs at least HALF of `FPS_HISTORY_SIZE` samples first (avoids the cold-cache warm-up window).
 *   - Needs `framesSinceLastChange >= cooldownFrames`.
 *   - Median FPS < `threshold` (default 50) → drop one step. At LOW, never drops further.
 *
 * Upshift (opt-in: only when both `upshiftThreshold` and `upshiftCooldownFrames` are finite):
 *   - Needs `framesSinceLastChange >= upshiftCooldownFrames` (typ. 600, longer than downshift's 300: optimism waits).
 *   - Median FPS ≥ `upshiftThreshold` (typ. 58) → promote one step. The 50..58 gap is the hysteresis band that
 *     prevents HIGH ↔ MEDIUM ping-pong when the workload sits near 55 fps. At HIGH, never promotes further.
 *
 * Downshift wins if both gates ever fire together (safety first).
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

  // Half-window gate: callers pass a capped rolling buffer plus the full window size (default: array length).
  const fullSize = Number.isFinite(historySize) && historySize > 0
    ? historySize
    : fpsHistory.length;
  if (fpsHistory.length < Math.floor(fullSize / 2)) return noChange();

  if (!Number.isFinite(framesSinceLastChange)) return noChange();

  const med = medianOf(fpsHistory);
  if (!Number.isFinite(med)) return noChange(med);

  const idx = TIER_ORDER.indexOf(currentTier);

  // Downshift first (safety).
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

  // Opt-in: only when the caller supplies both upshift knobs.
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
