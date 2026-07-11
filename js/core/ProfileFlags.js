/**
 * ProfileFlags.js — Sprint 3 GPU profiling URL flags.
 *
 * Centralised parser for `?profile…=1` / `?disable…=1` / `?msaa=N`
 * /`?pixelRatio=N` query parameters used to A/B-isolate GPU costs at
 * runtime. Read **once** at module load so every consumer agrees on the
 * same boolean / numeric values for the entire session.
 *
 * Activation pattern mirrors [`main.js`](js/main.js:202)'s `?perfReport=1`
 * convention and [`SceneManager._detectInitialTier()`](js/scene/SceneManager.js:113)'s
 * `?tier=` override — all flags are opt-in, all default to **off / null**, and
 * none should fire any code path in normal play.
 *
 * Flags
 * -----
 *   `?profilePasses=1`     — wrap each EffectComposer pass with a TIME_ELAPSED
 *                            timer query. Disables the per-frame query so the
 *                            sum of per-pass channels ≈ per-frame total
 *                            (WebGL2 does not allow nested timer queries).
 *   `?autoProfile=1`       — run an 8-configuration GPU sweep automatically
 *                            after the scene settles (see
 *                            [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1));
 *                            results are auto-downloaded as JSON and logged
 *                            to the console. Cycles through baseline +
 *                            profilePasses + disableEarthNoise +
 *                            disableBloom + disableSMAA + disableClouds +
 *                            disableAtmosphere + msaa=0 + pixelRatio=1 in
 *                            ONE session.
 *   `?disableEarthNoise=1` — compile out the [`Earth`](js/scene/Earth.js:104)
 *                            fragment shader's 7-octave noise stack (forces
 *                            `LOW_DETAIL` regardless of quality tier).
 *   `?disableBloom=1`      — skip the [`UnrealBloomPass`](js/scene/SceneManager.js:209).
 *   `?disableSMAA=1`       — skip the [`SMAAPass`](js/scene/SceneManager.js:229)
 *                            **and** the FXAA fallback shader pass.
 *   `?disableClouds=1`     — skip [`Earth._createClouds()`](js/scene/Earth.js:622)
 *                            (no 8K-textured 128×128 transparent sphere).
 *   `?disableAtmosphere=1` — skip [`Earth._createAtmosphere()`](js/scene/Earth.js:652).
 *   `?msaa=N`              — override `tierConfig.msaaSamples` (0, 2, 4 typical).
 *   `?pixelRatio=N`        — override `tierConfig.pixelRatioCap` (1, 1.5, 2 typical).
 *   `?bloomThreshold=N`    — override the [`UnrealBloomPass`](js/scene/SceneManager.js:289)
 *                            luminance threshold (default 4.0). Lower = more of
 *                            the frame blooms. Used to A/B the historical hull
 *                            roll-glint (P3): 4.0 suppresses it, 2.5 was proposed
 *                            to re-add a subtle sun glint. Range [0.5..8].
 *
 * @module core/ProfileFlags
 */

/**
 * Parse a `?key=value` integer in the [min..max] range, returning `null` when
 * the parameter is absent / blank / out of range. Used for `msaa` & `pixelRatio`.
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function readIntInRange(params, key, min, max) {
  const raw = params.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Parse a `?key=value` float in the [min..max] range. Used for `pixelRatio`
 * which can be fractional (e.g. 1.5).
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function readFloatInRange(params, key, min, max) {
  const raw = params.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Resolved flag values for this browser session. Frozen so consumers cannot
 * mutate the shared object by accident.
 *
 * @typedef {object} ProfileFlags
 * @property {boolean} profilePasses
 * @property {boolean} disableEarthNoise
 * @property {boolean} disableBloom
 * @property {boolean} disableSMAA
 * @property {boolean} disableClouds
 * @property {boolean} disableAtmosphere
 * @property {number|null} msaaOverride        — null means "use tier default"
 * @property {number|null} pixelRatioOverride  — null means "use tier default"
 * @property {number|null} bloomThresholdOverride — null means "use pass default (4.0)"
 * @property {boolean} anyEnabled              — true when any flag is non-default
 */

/**
 * Parse the live URL query string into a frozen {@link ProfileFlags} object.
 * Safe to call from non-browser contexts (Node test runner) — returns a
 * struct with all defaults when `window` / `URLSearchParams` is unavailable.
 *
 * @returns {ProfileFlags}
 */
function parseFromLocation() {
  /** @type {ProfileFlags} */
  const defaults = {
    profilePasses: false,
    autoProfile: false,
    disableEarthNoise: false,
    disableBloom: false,
    disableSMAA: false,
    disableClouds: false,
    disableAtmosphere: false,
    msaaOverride: null,
    pixelRatioOverride: null,
    bloomThresholdOverride: null,
    anyEnabled: false,
  };

  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') {
    return Object.freeze(defaults);
  }

  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (_e) {
    return Object.freeze(defaults);
  }

  const flags = {
    profilePasses: params.get('profilePasses') === '1',
    autoProfile: params.get('autoProfile') === '1',
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
    flags.disableEarthNoise ||
    flags.disableBloom ||
    flags.disableSMAA ||
    flags.disableClouds ||
    flags.disableAtmosphere ||
    flags.msaaOverride !== null ||
    flags.pixelRatioOverride !== null ||
    flags.bloomThresholdOverride !== null;

  if (flags.anyEnabled && typeof console !== 'undefined') {
    try {
      console.info('[ProfileFlags] active:', flags);
    } catch (_e) { /* noop */ }
  }

  return Object.freeze(flags);
}

/**
 * Singleton, parsed at module load. All consumers should import this constant
 * rather than re-parse the URL — keeps every subsystem in agreement and avoids
 * a `URLSearchParams` allocation on every read.
 *
 * @type {ProfileFlags}
 */
export const profileFlags = parseFromLocation();

/**
 * Test helper — exposes the parser so unit tests can drive deterministic
 * inputs without mutating `window.location`. Not part of the runtime API.
 *
 * @param {string} search — query string including leading `?`
 * @returns {ProfileFlags}
 */
export function _parseForTest(search) {
  const params = new URLSearchParams(search || '');
  const out = {
    profilePasses: params.get('profilePasses') === '1',
    autoProfile: params.get('autoProfile') === '1',
    disableEarthNoise: params.get('disableEarthNoise') === '1',
    disableBloom: params.get('disableBloom') === '1',
    disableSMAA: params.get('disableSMAA') === '1',
    disableClouds: params.get('disableClouds') === '1',
    disableAtmosphere: params.get('disableAtmosphere') === '1',
    msaaOverride: readIntInRange(params, 'msaa', 0, 8),
    pixelRatioOverride: readFloatInRange(params, 'pixelRatio', 0.5, 4),
    bloomThresholdOverride: readFloatInRange(params, 'bloomThreshold', 0.5, 8),
  };
  out.anyEnabled =
    out.profilePasses ||
    out.autoProfile ||
    out.disableEarthNoise ||
    out.disableBloom ||
    out.disableSMAA ||
    out.disableClouds ||
    out.disableAtmosphere ||
    out.msaaOverride !== null ||
    out.pixelRatioOverride !== null ||
    out.bloomThresholdOverride !== null;
  return Object.freeze(out);
}

export default profileFlags;
