/**
 * ProfileFlags.js — Sprint 3 GPU profiling URL flags.
 *
 * Centralised parser for `?profile…=1` / `?disable…=1` / `?msaa=N`
 * /`?pixelRatio=N` query parameters used to A/B-isolate GPU costs at
 * runtime. Read **once** at module load so every consumer agrees on the
 * same boolean / numeric values for the entire session. There is exactly
 * ONE parser — the module-private `parse(search)`; the live singleton
 * (`parseFromLocation`) delegates after the window/URLSearchParams guard and
 * the test seam (`_parseForTest`) delegates without it, so the two cannot
 * drift (register item 89).
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
 *   `?pinTier=1`           — dev-only: suppress the ADAPTIVE tier changes (both
 *                            the FPS-history `runtimeAdapt` and the GPU-probe
 *                            downshift in [`main.js`](js/main.js:1)) so a run
 *                            HOLDS the `?tier=` override for its whole duration.
 *                            Unlike `?autoProfile=1` it does NOT start the GPU
 *                            sweep. Used by the net capture harness to shoot at
 *                            a known tier instead of the silently-downshifted
 *                            LOW that degraded every earlier capture.
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
 * @property {boolean} autoProfile
 * @property {boolean} pinTier                  — suppress adaptive tier changes (dev-only)
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
 * Parse a query string into a frozen {@link ProfileFlags}. **The ONE parser** —
 * the live singleton and the test seam both delegate to it, so they cannot
 * drift (register item 89: this was once written twice — `parseFromLocation`
 * and `_parseForTest` each parsed all eleven fields — and a mutation in the
 * singleton's copy was invisible to the suite, the DevShotGate M3 shape).
 *
 * @param {string} search — query string including leading `?`
 * @returns {ProfileFlags}
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

/**
 * Parse the live URL query string into a frozen {@link ProfileFlags} object.
 * Safe to call from non-browser contexts (Node test runner) — returns the
 * all-defaults struct when `window` / `URLSearchParams` is unavailable.
 * Guards, then delegates to the ONE parser (`parse`); the `[ProfileFlags]
 * active:` log stays on this live path only, so the test seam stays silent.
 *
 * @returns {ProfileFlags}
 */
function parseFromLocation() {
  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') {
    return DEFAULTS;
  }

  let flags;
  try {
    flags = parse(window.location.search);
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
 * Singleton, parsed at module load. All consumers should import this constant
 * rather than re-parse the URL — keeps every subsystem in agreement and avoids
 * a `URLSearchParams` allocation on every read.
 *
 * @type {ProfileFlags}
 */
export const profileFlags = parseFromLocation();

/**
 * Test helper — drives deterministic query strings through the ONE parser
 * without mutating `window.location`. Not part of the runtime API.
 * Delegates WITHOUT the window/URLSearchParams guard (the DevShotGate idiom).
 *
 * @param {string} search — query string including leading `?`
 * @returns {ProfileFlags}
 */
export function _parseForTest(search) {
  return parse(search);
}

export default profileFlags;
