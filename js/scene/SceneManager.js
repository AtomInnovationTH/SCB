/**
 * SceneManager.js — Three.js scene, renderer, camera, and post-processing
 * Single-composer threshold bloom: bright objects (emissive > threshold) bloom
 * automatically without render-layer tricks. Earth stays pixel-sharp.
 * @module scene/SceneManager
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
// Sprint 2 / PR D — FXAA fallback for MEDIUM tier (cheaper than SMAA).
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Constants } from '../core/Constants.js';
import { profileFlags } from '../core/ProfileFlags.js';
import { selectInitialTier } from '../systems/QualityManager.js';
import { GpuProbe } from '../systems/GpuProbe.js';

export class SceneManager {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;

    // P2.9: Cached Vector2 for bloom resolution — reused across construction,
    // resize, and live tier swaps so we don't allocate per-event.
    this._bloomRes = new THREE.Vector2();

    // Sprint 3 GPU profiling: when an [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1)
    // config opts into per-pass profiling, this latch must be flipped on so
    // [`render()`](js/scene/SceneManager.js:1) skips the per-frame timer
    // query — otherwise it nests with the per-pass channels and WebGL2
    // silently rejects them (returning empty `perPass` snapshots).
    this._runtimeProfilePasses = false;

    // --- Renderer (WebGL2, logarithmic depth buffer) ---
    // SMAA handles anti-aliasing via post-processing; no hardware MSAA needed
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });

    // --- PR 4 / P1.5: Detect initial quality tier from GL capabilities
    // + optional `?tier=` URL override. Pixel ratio is set inside _applyTier()
    // so HIGH/MEDIUM/LOW each cap retina differently.
    this.currentTier = this._detectInitialTier();
    this.tierConfig = Constants.PERF.QUALITY_TIERS[this.currentTier];

    // setPixelRatio is honored by the tier (see _applyRendererPixelRatio).
    this._applyRendererPixelRatio(this.tierConfig);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Shadow maps disabled — no shadow-casting lights in the scene
    this.renderer.shadowMap.enabled = false;

    // --- Scene ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000); // Deep space black

    // --- Camera ---
    this.camera = new THREE.PerspectiveCamera(
      Constants.CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      Constants.CAMERA_NEAR,
      Constants.CAMERA_FAR
    );

    // --- Clock ---
    this.clock = new THREE.Clock();

    // --- PR 6 / P3.11: GPU runtime probe ---
    // Wraps the actual render call to measure GPU frame time.
    // Only active when the EXT_disjoint_timer_query_webgl2 extension exists.
    //
    // Sprint 3 GPU profiling — the probe must exist BEFORE
    // [`_setupPostProcessing`](js/scene/SceneManager.js:178) runs so that
    // `?profilePasses=1` can wrap each pass with timer-query channels on the
    // very first build. (Pre-Sprint-3 ordering created the probe after the
    // composer; that's still fine for the per-frame query but breaks per-pass
    // instrumentation on the initial frames.)
    /** @type {GpuProbe|null} */
    this.gpuProbe = null;
    /** @type {boolean} Whether GPU probe is actively sampling */
    this.gpuProbeEnabled = false;
    try {
      const gl = this.renderer.getContext();
      this.gpuProbe = new GpuProbe(gl, {
        windowSize: Constants.PERF.GPU_PROBE_FRAMES,
      });
      if (this.gpuProbe.isSupported) {
        this.gpuProbeEnabled = true;
        console.log('[Perf] GPU probe active (EXT_disjoint_timer_query_webgl2 available)');
      } else {
        console.log('[Perf] GPU probe unavailable — falling back to deviceMemory heuristic');
      }
    } catch (_e) {
      console.warn('[Perf] GPU probe init failed:', _e);
    }

    // --- Post-processing (built from current tier config) ---
    // Must run AFTER GpuProbe is created so `?profilePasses=1` can wrap
    // each pass with a timer-query channel inside _setupPostProcessing().
    this._setupPostProcessing(this.tierConfig);

    // --- Lights ---
    this._setupLights();

    // --- Diagnostics ---
    this._logDiagnostics();

    console.log(`[Perf] initial quality tier: ${this.currentTier}`, this.tierConfig);
  }

  /**
   * PR 4 / P1.5: Choose initial tier from GL capabilities + URL override.
   * @private
   * @returns {'HIGH'|'MEDIUM'|'LOW'}
   */
  _detectInitialTier() {
    // URL override: ?tier=LOW|MEDIUM|HIGH (case-insensitive). Useful for debug.
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = (params.get('tier') || '').toUpperCase();
      if (raw === 'HIGH' || raw === 'MEDIUM' || raw === 'LOW') {
        console.log(`[Perf] tier URL override → ${raw}`);
        return raw;
      }
    } catch (_e) {
      // Non-browser env or malformed URL — ignore.
    }

    // Capability hints
    const caps = this.renderer.capabilities;
    const maxTextureSize = caps?.maxTextureSize;
    const devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const deviceMemoryGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || undefined;

    // Apple GPU detection via WEBGL_debug_renderer_info. Some browsers (Safari)
    // expose this only on cross-origin-isolated contexts; treat absence as false.
    let isAppleGPU = false;
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
        isAppleGPU = /Apple/i.test(String(renderer));
      }
    } catch (_e) {
      isAppleGPU = false;
    }

    const picked = selectInitialTier({
      maxTextureSize,
      devicePixelRatio,
      isAppleGPU,
      deviceMemoryGB,
    });
    return picked || Constants.PERF.DEFAULT_QUALITY_TIER;
  }

  /**
   * Apply pixel-ratio cap from the tier config.
   * @private
   * @param {object} tier
   */
  _applyRendererPixelRatio(tier) {
    const devicePR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    let cap = (tier && Number.isFinite(tier.pixelRatioCap)) ? tier.pixelRatioCap : 2;
    // Sprint 3 GPU profiling — `?pixelRatio=N` forces the cap regardless of tier.
    if (profileFlags.pixelRatioOverride !== null) {
      cap = profileFlags.pixelRatioOverride;
    }
    this.renderer.setPixelRatio(Math.min(devicePR, cap));
  }

  /**
   * Build single-composer pipeline driven by a quality-tier config:
   *   RenderPass → [UnrealBloomPass] → [SMAAPass | FXAA ShaderPass]
   *
   * The bloom + SMAA passes are toggled by `tier.enableBloom` / `tier.enableSMAA`.
   * Sprint 2 / PR D added an FXAA fallback: when `tier.useFXAAFallback === true`
   * (MEDIUM tier) and SMAA is disabled, an FXAA `ShaderPass` runs after bloom.
   * MSAA sample count is `tier.msaaSamples` (clamped to 0 on WebGL1).
   *
   * Idempotent: disposes any existing composer/passes before rebuilding so
   * `applyTier()` can be called live without leaking GL resources.
   *
   * @private
   * @param {object} tier - tier config (msaaSamples, enableBloom, enableSMAA, useFXAAFallback)
   */
  _setupPostProcessing(tier) {
    const cfg = tier || Constants.PERF.QUALITY_TIERS[Constants.PERF.DEFAULT_QUALITY_TIER];

    // Dispose any previous composer + passes (idempotency for applyTier()).
    this._disposePostProcessing();

    const w = window.innerWidth;
    const h = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();

    // Multisampled render target — eliminates temporal aliasing ("shimmer")
    // on rotating debris. WebGL2 only; falls back to 0 on WebGL1.
    const isWebGL2 = this.renderer.capabilities.isWebGL2;
    let wantedSamples = Number.isFinite(cfg.msaaSamples) ? cfg.msaaSamples : 4;
    // Sprint 3 GPU profiling — `?msaa=N` overrides the tier's MSAA setting.
    if (profileFlags.msaaOverride !== null) {
      wantedSamples = profileFlags.msaaOverride;
    }
    const samples = isWebGL2 ? wantedSamples : 0;
    const customRT = new THREE.WebGLRenderTarget(
      Math.floor(w * pixelRatio),
      Math.floor(h * pixelRatio),
      {
        type: THREE.HalfFloatType,
        samples: samples,
      }
    );
    this.composer = new EffectComposer(this.renderer, customRT);

    // 1. Render the full scene
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);
    this.renderPass = renderPass;

    // 2. Threshold bloom at QUARTER PHYSICAL resolution (gated by tier).
    //
    // Sprint 3 GPU profiling — Phase C.3 (2026-05-23): lowered from half-physical
    // (/2) to quarter-physical (/4). Post-C.1+C.2 measurement (HIGH/IN-MISSION):
    // bloom pass cost 1.74 ms (50% of the 3.44 ms baseline) at half-physical.
    // Bloom is a low-frequency, threshold-gated effect (only the sun disc, a few
    // engine sprites, and rare overbright pixels exceed threshold=1.5) — its
    // visible silhouette is fundamentally blurry, so quartering the mip-chain
    // base resolution is visually indistinguishable at orbital altitudes but
    // drops the Gaussian-blur fragment count by 4× across the entire 5-mip chain.
    // Expected save: ~0.7–1.2 ms (the largest mip dominates so cost doesn't
    // drop 4× linearly — but it's still the biggest remaining lever after C.2).
    //
    // Sprint 3 GPU profiling — `?disableBloom=1` forces this pass off entirely.
    if (cfg.enableBloom && !profileFlags.disableBloom) {
      // P2.9: reuse cached Vector2 — UnrealBloomPass clones the input
      // internally, so it's safe to mutate later for resize/tier swaps.
      this._bloomRes.set(
        Math.floor(w * pixelRatio / 4),
        Math.floor(h * pixelRatio / 4)
      );
      const bloomPass = new UnrealBloomPass(
        this._bloomRes,
        0.15,  // strength — subtle bloom for sun disc + engine glow sparkle
        0.4,   // radius
        1.5    // threshold — eliminates dark halo around ROSA panels
      );
      this.composer.addPass(bloomPass);
      this.bloomPass = bloomPass;
    } else {
      this.bloomPass = null;
    }

    // 3. Anti-aliasing: SMAA (HIGH) → FXAA (MEDIUM) → none (LOW + MSAA only).
    // Sprint 3 GPU profiling — `?disableSMAA=1` forces *both* SMAA and FXAA off
    // (the flag is really "disable post-AA"; tier-MSAA still runs in customRT).
    if (cfg.enableSMAA && !profileFlags.disableSMAA) {
      const smaaPass = new SMAAPass(w * pixelRatio, h * pixelRatio);
      this.composer.addPass(smaaPass);
      this.smaaPass = smaaPass;
      this.fxaaPass = null;
    } else if (cfg.useFXAAFallback && !profileFlags.disableSMAA) {
      // Sprint 2 / PR D — FXAA as a single ShaderPass. Cheap (~0.3 ms on Iris Xe),
      // softer than SMAA, but visibly better than no post-AA on iGPU class GPUs.
      const fxaaPass = new ShaderPass(FXAAShader);
      // FXAAShader expects `resolution` in *inverse pixel* units. We size the
      // pass to the physical buffer (w * pixelRatio × h * pixelRatio).
      fxaaPass.material.uniforms['resolution'].value.set(
        1 / (w * pixelRatio),
        1 / (h * pixelRatio),
      );
      this.composer.addPass(fxaaPass);
      this.fxaaPass = fxaaPass;
      this.smaaPass = null;
    } else {
      this.smaaPass = null;
      this.fxaaPass = null;
    }

    // Sprint 3 GPU profiling — when `?profilePasses=1`, monkey-patch each pass's
    // render() to wrap it in a named timer-query channel on the shared
    // [`GpuProbe`](js/systems/GpuProbe.js:1). Idempotent: re-wraps on every
    // [`_setupPostProcessing`](js/scene/SceneManager.js:178) rebuild.
    if (profileFlags.profilePasses) {
      this._installPassProfilers();
    }
  }

  /**
   * Monkey-patch every composer pass so `pass.render()` is wrapped with
   * `gpuProbe.beginChannel(name) / endChannel(name)`. Channel names are
   * derived from the pass constructor (`RenderPass` → `'render'`,
   * `UnrealBloomPass` → `'bloom'`, `SMAAPass` → `'smaa'`, `ShaderPass` (used
   * as FXAA) → `'fxaa'`, anything else → `'pass<N>'`).
   *
   * No-op when the [`GpuProbe`](js/systems/GpuProbe.js:1) is unavailable or
   * when `?profilePasses=1` is not set. Sequential by design (WebGL2 forbids
   * nested TIME_ELAPSED queries).
   *
   * @private
   */
  _installPassProfilers() {
    if (!this.gpuProbe || !this.gpuProbe.isSupported) return;
    if (!this.composer || !Array.isArray(this.composer.passes)) return;
    const probe = this.gpuProbe;
    let fallbackIdx = 0;
    for (const pass of this.composer.passes) {
      if (!pass || typeof pass.render !== 'function') continue;
      if (pass.__profilerWrapped) continue;
      const ctorName = pass.constructor && pass.constructor.name || '';
      let channelName;
      switch (ctorName) {
        case 'RenderPass':       channelName = 'render'; break;
        case 'UnrealBloomPass':  channelName = 'bloom'; break;
        case 'SMAAPass':         channelName = 'smaa'; break;
        case 'ShaderPass':       channelName = 'fxaa'; break; // we only use ShaderPass for FXAA
        default:                 channelName = `pass${fallbackIdx++}`; break;
      }
      const origRender = pass.render.bind(pass);
      pass.render = function profiledRender(...args) {
        probe.beginChannel(channelName);
        try {
          return origRender(...args);
        } finally {
          probe.endChannel(channelName);
        }
      };
      pass.__profilerWrapped = true;
      pass.__profilerChannel = channelName;
    }
    // Echo once so the user can confirm which channels were installed.
    try {
      const labels = this.composer.passes
        .map((p) => p?.__profilerChannel || '?')
        .join(' → ');
      console.info(`[GpuProfile] per-pass channels installed: ${labels}`);
    } catch (_e) { /* noop */ }
  }

  /**
   * Tear down composer + passes so a new pipeline can be built in place.
   * @private
   */
  _disposePostProcessing() {
    if (this.composer) {
      // Dispose render targets owned by the composer
      try { this.composer.renderTarget1?.dispose?.(); } catch (_e) {}
      try { this.composer.renderTarget2?.dispose?.(); } catch (_e) {}
      // Dispose each pass that supports it
      try {
        for (const pass of (this.composer.passes || [])) {
          if (pass && typeof pass.dispose === 'function') pass.dispose();
        }
      } catch (_e) { /* best-effort */ }
    }
    this.composer = null;
    this.bloomPass = null;
    this.smaaPass = null;
    this.fxaaPass = null;
    this.renderPass = null;
  }

  /**
   * Register the Earth instance so [`applyTier()`](js/scene/SceneManager.js:275)
   * can toggle its LOW_DETAIL fragment-shader branch (Sprint 2 / PR C).
   * Optional — if not set, Earth detail simply stays at whatever was compiled.
   *
   * @param {object} earth — Earth instance exposing `setLowDetail(boolean)`.
   */
  setEarth(earth) {
    this._earth = earth || null;
    // Apply the current tier's setting immediately so the registration order
    // (Earth created before SceneManager.applyTier) is harmless.
    if (this._earth && typeof this._earth.setLowDetail === 'function') {
      this._earth.setLowDetail(this.currentTier === 'LOW');
    }
  }

  /**
   * PR 4 / P1.5: Switch quality tier live. Rebuilds the post-processing
   * chain with the new tier config and updates the renderer pixel-ratio cap.
   *
   * Sprint 2 / PR C: Also toggles the Earth fragment-shader's LOW_DETAIL
   * branch (skips the 7-octave noise stack at LOW tier — saves 2–4 ms/frame
   * on iGPUs).
   *
   * Re-uses `_setupPostProcessing(tierCfg)` which is idempotent (disposes the
   * existing composer first). Safe to call from `runtimeAdapt` paths.
   *
   * @param {'HIGH'|'MEDIUM'|'LOW'} tierName
   */
  applyTier(tierName) {
    const cfg = Constants.PERF.QUALITY_TIERS[tierName];
    if (!cfg) {
      console.warn(`[Perf] applyTier: unknown tier '${tierName}', ignoring.`);
      return;
    }
    this.currentTier = tierName;
    this.tierConfig = cfg;
    this._applyRendererPixelRatio(cfg);
    // Resize renderer in case pixel ratio changed — buffer size depends on it.
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._setupPostProcessing(cfg);
    // Sprint 2 / PR C — Earth surface shader variant.
    if (this._earth && typeof this._earth.setLowDetail === 'function') {
      this._earth.setLowDetail(tierName === 'LOW');
    }
  }

  /**
   * Sprint 3 GPU profiling: rebuild the composer + renderer state with the
   * **current** tier as a base, then layer per-key overrides on top. Used by
   * [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1) to A/B-isolate
   * each suspect (bloom, SMAA, MSAA, pixel ratio, Earth noise, clouds,
   * atmosphere) in a single browser session — no reloads required.
   *
   * Unlike [`applyTier()`](js/scene/SceneManager.js:385), this does **not**
   * change `currentTier` / `tierConfig`; reverting is just calling this
   * again with `{}` (empty overrides). Bypasses the profileFlags-based
   * checks in [`_setupPostProcessing`](js/scene/SceneManager.js:178) so the
   * sweep doesn't fight URL flags — those flags should not be set in the
   * same session as `?autoProfile=1` (the sweep prints a warning if they
   * are at construction time).
   *
   * @param {object} overrides
   * @param {number}  [overrides.msaaSamples]
   * @param {boolean} [overrides.enableBloom]
   * @param {boolean} [overrides.enableSMAA]
   * @param {number}  [overrides.pixelRatioCap]
   * @param {boolean} [overrides.earthLowDetail]   — force LOW_DETAIL Earth FS
   * @param {boolean} [overrides.cloudsVisible]    — toggle clouds visibility
   * @param {boolean} [overrides.atmosphereVisible]— toggle atmosphere visibility
   * @param {boolean} [overrides.profilePasses]    — install per-pass timer-query channels
   */
  applyTierWithOverrides(overrides) {
    const base = this.tierConfig;
    const merged = {
      msaaSamples: overrides.msaaSamples !== undefined ? overrides.msaaSamples : base.msaaSamples,
      enableBloom: overrides.enableBloom !== undefined ? overrides.enableBloom : base.enableBloom,
      enableSMAA:  overrides.enableSMAA  !== undefined ? overrides.enableSMAA  : base.enableSMAA,
      pixelRatioCap: overrides.pixelRatioCap !== undefined ? overrides.pixelRatioCap : base.pixelRatioCap,
      useFXAAFallback: base.useFXAAFallback,
    };

    // Pixel ratio (sweep paths bypass `_applyRendererPixelRatio` to ignore
    // any `?pixelRatio=N` URL flag — sweep configs win).
    const devicePR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.renderer.setPixelRatio(Math.min(devicePR, merged.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Rebuild composer with merged cfg. `_setupPostProcessing` reads
    // `profileFlags.disableBloom` etc. but they are expected to be off in a
    // sweep session — see `?autoProfile=1` wiring in [`main.js`](js/main.js:1).
    this._setupPostProcessing(merged);

    // Earth-side toggles.
    if (this._earth) {
      if (typeof this._earth.setLowDetail === 'function') {
        const want = overrides.earthLowDetail !== undefined
          ? !!overrides.earthLowDetail
          : (this.currentTier === 'LOW');
        // Bypass the profileFlags.disableEarthNoise guard by calling the
        // material defines directly — sweep should override URL flags.
        if (this._earth.surfaceMaterial) {
          const defs = this._earth.surfaceMaterial.defines || {};
          if (want) defs.LOW_DETAIL = 1; else delete defs.LOW_DETAIL;
          this._earth.surfaceMaterial.defines = defs;
          this._earth.surfaceMaterial.needsUpdate = true;
          this._earth._useLowDetail = want;
        }
      }
      if (typeof this._earth.setCloudsVisible === 'function') {
        this._earth.setCloudsVisible(overrides.cloudsVisible !== false);
      }
      if (typeof this._earth.setAtmosphereVisible === 'function') {
        this._earth.setAtmosphereVisible(overrides.atmosphereVisible !== false);
      }
    }

    // Per-pass profiling install — sweep enables this only for the
    // dedicated `profilePasses` config so it doesn't affect other rows.
    // The `_runtimeProfilePasses` latch flips both directions on every call
    // so that the sweep's NEXT config (which has profilePasses=undefined)
    // automatically falls back to per-frame timing.
    this._runtimeProfilePasses = overrides.profilePasses === true;
    if (overrides.profilePasses) {
      this._installPassProfilers();
    }
  }

  /**
   * Log all critical rendering pipeline values for debugging.
   * @private
   */
  _logDiagnostics() {
    // PR 5 / P2.10: gated behind Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS
    // (flipped on via ?debug=1 in main.js). Off by default — cheap no-op.
    if (!Constants.DEBUG || !Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) return;

    const canvas = this._canvas;
    const pr = this.renderer.getPixelRatio();
    const caps = this.renderer.capabilities;
    const rt1 = this.composer.renderTarget1;

    console.log('%c[SceneManager] Rendering Diagnostics', 'color: #00ff88; font-weight: bold');
    console.table({
      'quality tier': this.currentTier,
      'tier msaaSamples': this.tierConfig?.msaaSamples,
      'tier enableBloom': this.tierConfig?.enableBloom,
      'tier enableSMAA': this.tierConfig?.enableSMAA,
      'tier pixelRatioCap': this.tierConfig?.pixelRatioCap,
      'window.devicePixelRatio': window.devicePixelRatio,
      'renderer.getPixelRatio()': pr,
      'CSS viewport': `${window.innerWidth} × ${window.innerHeight}`,
      'canvas.width × height (buffer)': `${canvas.width} × ${canvas.height}`,
      'expected buffer (CSS × dpr)': `${window.innerWidth * pr} × ${window.innerHeight * pr}`,
      'composer RT size': `${rt1.width} × ${rt1.height}`,
      'composer RT type': rt1.texture.type === THREE.HalfFloatType ? 'HalfFloatType ✓' : `OTHER (${rt1.texture.type}) ⚠️`,
      'bloom resolution': this.bloomPass ? `${this.bloomPass.resolution.x} × ${this.bloomPass.resolution.y}` : '(disabled)',
      'bloom threshold': this.bloomPass ? this.bloomPass.threshold : '(disabled)',
      'bloom strength': this.bloomPass ? this.bloomPass.strength : '(disabled)',
      'smaa': this.smaaPass ? 'enabled' : '(disabled)',
      'toneMapping': this.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 'ACESFilmic' : this.renderer.toneMapping,
      'toneMappingExposure': this.renderer.toneMappingExposure,
      'maxTextureSize': caps.maxTextureSize,
      'maxAnisotropy': caps.getMaxAnisotropy(),
      'isWebGL2': caps.isWebGL2,
      'precision': caps.precision,
    });

    // Warn if pixel ratio differs from devicePR for reasons OTHER than the tier cap
    // (tier can intentionally cap below devicePR — that's not a bug).
    const expectedPR = Math.min(window.devicePixelRatio, this.tierConfig?.pixelRatioCap ?? 2);
    if (Math.abs(pr - expectedPR) > 0.001) {
      console.warn('[SceneManager] ⚠️ Pixel ratio mismatch: expected', expectedPR, 'but renderer using', pr);
    }
    if (canvas.width !== window.innerWidth * pr || canvas.height !== window.innerHeight * pr) {
      console.warn('[SceneManager] ⚠️ Canvas buffer size mismatch!', { canvasW: canvas.width, canvasH: canvas.height, expectedW: window.innerWidth * pr, expectedH: window.innerHeight * pr });
    }
    if (rt1.width !== canvas.width || rt1.height !== canvas.height) {
      console.warn('[SceneManager] ⚠️ Composer RT size ≠ canvas buffer!', { rtW: rt1.width, rtH: rt1.height, canvasW: canvas.width, canvasH: canvas.height });
    }
    if (rt1.texture.type !== THREE.HalfFloatType) {
      console.warn('[SceneManager] ⚠️ Composer RT is NOT HalfFloatType — HDR values will be clamped!');
    }
  }

  /**
   * Set up ambient and directional lights.
   * The main sun DirectionalLight is managed by SunLight.js;
   * here we add a very dim ambient fill.
   * @private
   */
  _setupLights() {
    const ambient = new THREE.AmbientLight(0x112244, 0.02);
    this.scene.add(ambient);
    this.ambientLight = ambient;
  }

  /**
   * Render one frame via EffectComposer pipeline.
   * PR 6 / P3.11: Wraps composer.render() with GPU probe begin/end
   * when probe is enabled and supported.
   */
  render() {
    // Sprint 3 GPU profiling: when per-pass profilers are installed they wrap
    // each pass with their own TIME_ELAPSED query. WebGL2 forbids nesting, so
    // we MUST skip the per-frame begin/end while the channel API is in use.
    // The sum of per-pass channel medians then approximates the frame total.
    //
    // Both the boot-time URL flag (`?profilePasses=1`) and the runtime latch
    // set by [`applyTierWithOverrides`](js/scene/SceneManager.js:1) (used by
    // [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1)'s `profilePasses`
    // config row) suppress the per-frame timer.
    const passProfiling = profileFlags.profilePasses || this._runtimeProfilePasses;
    const useFrameQuery =
      this.gpuProbeEnabled && this.gpuProbe && !passProfiling;
    if (useFrameQuery) {
      this.gpuProbe.beginFrame();
    }
    this.composer.render();
    if (useFrameQuery) {
      this.gpuProbe.endFrame();
    }
  }

  /**
   * No-op — retained for API compatibility with callers (e.g. SunLight.js).
   * Threshold bloom replaces selective layer-based bloom.
   * @param {THREE.Object3D} _object3D
   */
  enableBloom(_object3D) {
    // No-op: bloom is now threshold-based (emissive > 0.85 blooms automatically)
  }

  /**
   * Handle browser resize — updates composer and all passes.
   */
  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(w, h);

    // EffectComposer.setSize accepts CSS pixels and internally multiplies
    // by its _pixelRatio (read from renderer in the constructor).
    this.composer.setSize(w, h);

    // Update SMAA pass resolution
    if (this.smaaPass) {
      this.smaaPass.setSize(w * pixelRatio, h * pixelRatio);
    }

    // P2.9: update bloom pass resolution by mutating its existing Vector2
    // and cached resolution — no new allocations on resize.
    if (this.bloomPass) {
      const bw = Math.floor(w * pixelRatio / 2);
      const bh = Math.floor(h * pixelRatio / 2);
      this._bloomRes.set(bw, bh);
      if (this.bloomPass.resolution && typeof this.bloomPass.resolution.set === 'function') {
        this.bloomPass.resolution.set(bw, bh);
      }
      if (typeof this.bloomPass.setSize === 'function') {
        this.bloomPass.setSize(bw, bh);
      }
    }

    // Sprint 2 / PR D — FXAA shader resolution uniform is in inverse-pixel units.
    if (this.fxaaPass && this.fxaaPass.material?.uniforms?.['resolution']) {
      this.fxaaPass.material.uniforms['resolution'].value.set(
        1 / (w * pixelRatio),
        1 / (h * pixelRatio),
      );
    }
  }

  /** @returns {THREE.Scene} */
  getScene() {
    return this.scene;
  }

  /** @returns {THREE.PerspectiveCamera} */
  getCamera() {
    return this.camera;
  }

  /** @returns {THREE.WebGLRenderer} */
  getRenderer() {
    return this.renderer;
  }

  /** @returns {THREE.Clock} */
  getClock() {
    return this.clock;
  }
}

export default SceneManager;
