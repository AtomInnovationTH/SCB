/**
 * @module core/ProfileFlags — GPU profiling URL flags (`?profile…=1` / `?disable…=1` / `?msaa=N` / `?pixelRatio=N`)
 * used to A/B-isolate GPU costs at runtime. Read **once** at module
 * load so every consumer agrees for the session. ONE parser (module-private `parse(search)`): the live singleton
 * (`parseFromLocation`) delegates after the window/URLSearchParams guard and the test seam (`_parseForTest`) delegates
 * without it, so the two cannot drift. All flags are opt-in, default **off / null**, and fire no code path in normal
 * play.
 *
 *   `?profilePasses=1`     — wrap each EffectComposer pass with a TIME_ELAPSED timer query; disables the per-frame
 *   query so the sum of per-pass channels ≈ per-frame total (WebGL2 has no nested timer queries).
 *   `?autoProfile=1`       — run an 8-configuration GPU sweep after the scene settles (systems/AutoProfileSweep.js);
 *   results auto-download as JSON and log to the console. Cycles baseline +
 *                            profilePasses + disableEarthNoise + disableBloom + disableSMAA + disableClouds +
 *                            disableAtmosphere + msaa=0 + pixelRatio=1 in ONE session.
 *   `?pinTier=1`           — dev-only: suppress the ADAPTIVE tier changes
 *   (FPS-history `runtimeAdapt` and the GPU-probe downshift in main.js) so a run HOLDS the `?tier=` override. Unlike
 *                            `?autoProfile=1` it does NOT start the sweep. Used by the net capture harness to shoot at
 *                            a known tier instead of a silently-downshifted LOW.
 *   `?disableEarthNoise=1` — compile out the `Earth.js` fragment shader's 7-octave noise stack
 *   (forces `LOW_DETAIL` regardless of tier).
 *   `?disableBloom=1`      — skip the `SceneManager.js` UnrealBloomPass.
 *   `?disableSMAA=1`       — skip the `SceneManager.js` SMAAPass **and** the FXAA fallback pass.
 *   `?disableClouds=1`     — skip `Earth.js` Earth._createClouds() (no 8K-textured 128×128 transparent sphere).
 *   `?disableAtmosphere=1` — skip `Earth.js` Earth._createAtmosphere().
 *   `?msaa=N`              — override `tierConfig.msaaSamples` (0, 2, 4 typical).
 *   `?pixelRatio=N`        — override `tierConfig.pixelRatioCap` (1, 1.5, 2 typical).
 *   `?bloomThreshold=N`    — override the UnrealBloomPass luminance threshold
 *   (default `Constants.BLOOM_THRESHOLD`, 2.5, read in `SceneManager.js`; range [0.5..8]; lower = more of the
 *                            frame blooms).
 */
import { devSearch } from './DevHost.js';

/** `?key=value` integer in [min..max], or `null` when absent / blank / out of range (`msaa`). */
function readIntInRange(params, key, min, max) {
  const raw = params.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** `?key=value` float in [min..max] (`pixelRatio` can be fractional, e.g. 1.5), else `null`. */
function readFloatInRange(params, key, min, max) {
  const raw = params.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Resolved flag values for this session (frozen).
 * @typedef {object} ProfileFlags
 * @property {boolean} profilePasses
 * @property {boolean} autoProfile
 * @property {boolean} pinTier                  — suppress adaptive tier changes (dev-only)
 * @property {boolean} disableEarthNoise
 * @property {boolean} disableBloom
 * @property {boolean} disableSMAA
 * @property {boolean} disableClouds
 * @property {boolean} disableAtmosphere
 * @property {number|null} msaaOverride        — null means "use tier default"
 * @property {number|null} pixelRatioOverride  — null means "use tier default"
 * @property {number|null} bloomThresholdOverride — null means "use the default (`Constants.BLOOM_THRESHOLD`)"
 * @property {boolean} anyEnabled              — true when any flag is non-default
 */

/**
 * Parse a query string (with leading `?`) into a frozen {@link ProfileFlags}. The ONE parser: the live singleton and
 * the test seam both delegate to it.
 */
function parse(search) {
  const params = new URLSearchParams(search || '');
  const flags = {
    profilePasses: params.get('profilePasses') === '1',
    autoProfile: params.get('autoProfile') === '1',
    pinTier: params.get('pinTier') === '1',
    disableEarthNoise: params.get('disableEarthNoise') === '1',
    disableBloom: params.get('disableBloom') === '1',
    disableSMAA: params.get('disableSMAA') === '1',
    disableClouds: params.get('disableClouds') === '1',
    disableAtmosphere: params.get('disableAtmosphere') === '1',
    msaaOverride: readIntInRange(params, 'msaa', 0, 8),
    pixelRatioOverride: readFloatInRange(params, 'pixelRatio', 0.5, 4),
    bloomThresholdOverride: readFloatInRange(params, 'bloomThreshold', 0.5, 8),
  };

  flags.anyEnabled =
    flags.profilePasses ||
    flags.autoProfile ||
    flags.pinTier ||
    flags.disableEarthNoise ||
    flags.disableBloom ||
    flags.disableSMAA ||
    flags.disableClouds ||
    flags.disableAtmosphere ||
    flags.msaaOverride !== null ||
    flags.pixelRatioOverride !== null ||
    flags.bloomThresholdOverride !== null;

  return Object.freeze(flags);
}

/** @type {ProfileFlags} */
const DEFAULTS = Object.freeze({
  profilePasses: false,
  autoProfile: false,
  pinTier: false,
  disableEarthNoise: false,
  disableBloom: false,
  disableSMAA: false,
  disableClouds: false,
  disableAtmosphere: false,
  msaaOverride: null,
  pixelRatioOverride: null,
  bloomThresholdOverride: null,
  anyEnabled: false,
});

/** Parse the live URL query string into frozen flags; the all-defaults struct when `window` / `URLSearchParams` is
 *  unavailable (Node test runner). The `[ProfileFlags] active:` log stays on this live path only, so the test seam
 *  stays silent. */
function parseFromLocation() {
  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') {
    return DEFAULTS;
  }

  let flags;
  try {
    flags = parse(devSearch(window.location));
  } catch (_e) {
    return DEFAULTS;
  }

  if (flags.anyEnabled && typeof console !== 'undefined') {
    try {
      console.info('[ProfileFlags] active:', flags);
    } catch (_e) { /* noop */ }
  }

  return flags;
}

/**
 * Singleton, parsed at module load: import this rather than re-parse the URL
 * (keeps every subsystem in agreement, no `URLSearchParams` allocation per read). @type {ProfileFlags}
 */
export const profileFlags = parseFromLocation();

/**
 * Test helper: drives query strings through the ONE parser without mutating `window.location`; no
 * window/URLSearchParams guard (the DevShotGate idiom). Not runtime API.
 */
export function _parseForTest(search) {
  return parse(search);
}

export default profileFlags;
