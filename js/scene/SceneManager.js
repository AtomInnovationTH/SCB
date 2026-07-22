/**
 * SceneManager.js — Three.js scene, renderer, camera, and post-processing
 * Single-composer threshold bloom: bright objects (emissive > threshold) bloom
 * automatically without render-layer tricks. Earth stays pixel-sharp.
 * @module scene/SceneManager
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
// Sprint 2 / PR D — FXAA fallback for MEDIUM tier (cheaper than SMAA).
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
// Output stage: applies renderer.toneMapping (ACES) + sRGB encoding to the
// composed HDR buffer. Without it the EffectComposer chain writes raw linear
// HDR to the canvas (three only tone-maps built-in materials rendered directly
// to screen), so ACES + the SunLight auto-exposure system were dead in flight.
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Constants } from '../core/Constants.js';
import { NearFieldRenderPass, NEAR_FIELD_LAYER, NEAR_FIELD_SCALE } from './NearFieldRenderPass.js';
import { nearFieldBrackets } from './nearFieldMath.js';

// Near-field depth-pass tuning (z-layer fix — see NearFieldRenderPass.js).
// NEAR_FIELD_RADIUS is a half-extent (scene units) bracketing the player ship
// incl. deployed ROSA wings (1×2 m, OCTOPUS_V5) + 1.6 m struts — true extent is
// < 6 m, so 0.0001 units = 10 m is generous slack. Multiplied by NEAR_FIELD_SCALE
// each frame to set the scaled near camera's near/far around the ship. 1 unit =
// 100 km. (Shrunk from 40 m: the old bracket predated the ×S sub-render, where
// the bracket lives in metre-scale space and a tight one improves conditioning.)
const NEAR_FIELD_RADIUS = 0.0001;
// Scaled-space near-plane floor (5 cm). In the ×S sub-render M·S = 1 so units are
// metres; 5 cm is well-conditioned under log depth and below any real standoff.
const NEAR_FIELD_NEAR_FLOOR = 0.05;
const NEAR_FIELD_FAR_DEFAULT = 0.01;   // 1 km — construction default, replaced per frame
const _nfWorldPos = new THREE.Vector3();   // scratch for _updateNearCamera (no per-frame alloc)
const _nfSetNearLayer = (o) => { o.layers.set(NEAR_FIELD_LAYER); };  // traverse cb (no per-frame closure alloc)
import { profileFlags } from '../core/ProfileFlags.js';
import { selectInitialTier } from '../systems/QualityManager.js';
import { GpuProbe } from '../systems/GpuProbe.js';
import { NetMeshKit } from '../ui/NetMeshKit.js';

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
    //
    // Z-LAYER NOTE (§2-followup round 4): logarithmicDepthBuffer makes depth
    // non-linear, so `material.polygonOffsetUnits` map to a real-world depth
    // separation that VARIES with viewing distance — an offset tuned to stop
    // z-fighting when zoomed in will under/over-shoot when zoomed out (and
    // vice-versa). For coplanar layering prefer deterministic `renderOrder`
    // (Constants.RENDER_ORDER) plus a tiny geometric Z stagger over polygonOffset.
    // Existing polygonOffset values on the ship hull are legacy from FIX_PLAN §2;
    // do not add more — promote to renderOrder bands instead.
    // Dev screenshot loop (Phase 0 of the net-visual plan): `?shot=1` enables
    // `preserveDrawingBuffer` so `window.__netShot()` can read back the exact
    // `#game-canvas` pixels via `toDataURL`. A plain (non-preserved) buffer
    // returns black on read-back. Default OFF — this has a measurable perf cost
    // and must never ship enabled.
    let _preserveDrawingBuffer = false;
    try {
      const _p = new URLSearchParams(window.location.search);
      _preserveDrawingBuffer = _p.get('shot') === '1' || _p.has('shot');
    } catch (_e) { /* non-browser env — ignore */ }
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: _preserveDrawingBuffer,
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

    // Fat-line capture-net web (NetMeshKit) needs the DRAWING-BUFFER size (CSS px
    // × pixelRatio) for correct screen-space thread width — same units SMAA uses.
    this._syncNetMeshResolution();

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

    // --- Near-field camera (z-layer fix) ---
    // Sits at the ORIGIN each frame, mirroring the main camera's orientation +
    // intrinsics, and renders ONLY the near-field layer (the player ship) after
    // NearFieldRenderPass scales the ship into ×S camera-relative space. That
    // moves the ship off the flat toe of the log-depth curve (w ~2e-4 → ~16),
    // killing the fp32 `1.0 + w` depth-tie quantum. See NearFieldRenderPass.js
    // for the full rationale. position/near/far are set per frame in
    // _updateNearCamera(); these are just sane construction defaults.
    this.nearCamera = new THREE.PerspectiveCamera(
      Constants.CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      Constants.CAMERA_NEAR,
      NEAR_FIELD_FAR_DEFAULT
    );
    this.nearCamera.layers.set(NEAR_FIELD_LAYER);   // renders ONLY the near-field layer
    /** @type {THREE.Object3D[]} roots whose subtrees render in the near pass */
    this._nearFieldRoots = [];
    /** @type {THREE.Light[]} camera/ship-follow point lights transformed into ×S
     * space during the near render (fill/rim + launch pyro). Directional/hemi/
     * ambient are direction- or position-independent and are NOT listed here. */
    this._nearFieldLights = [];

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
        console.log('[Perf] GPU probe unavailable. Falling back to deviceMemory heuristic');
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

    // 1. Render the full scene. NearFieldRenderPass draws the far scene with the
    //    main camera, then (depth cleared) the near-field layer — the player ship
    //    — with the tight-range near camera, into the SAME buffer in one pass, so
    //    the downstream bloom/SMAA/output chain is unchanged. (z-layer fix.)
    const renderPass = new NearFieldRenderPass(this.scene, this.camera, this.nearCamera);
    this.composer.addPass(renderPass);
    this.renderPass = renderPass;
    // Hand the pass the LIVE shared arrays (re-pointed on every applyTier()
    // rebuild) so it can scale the ship + its follow lights into ×S space.
    renderPass.nearFieldRoots = this._nearFieldRoots;
    renderPass.nearFieldLights = this._nearFieldLights;
    renderPass.nearFieldScale = NEAR_FIELD_SCALE;

    // 2. Threshold bloom at QUARTER PHYSICAL resolution (gated by tier).
    //
    // Sprint 3 GPU profiling — Phase C.3 (2026-05-23): lowered from half-physical
    // (/2) to quarter-physical (/4). Post-C.1+C.2 measurement (HIGH/IN-MISSION):
    // bloom pass cost 1.74 ms (50% of the 3.44 ms baseline) at half-physical.
    // Bloom is a low-frequency, threshold-gated effect (only the sun disc, a few
    // engine sprites, and rare overbright pixels exceed the threshold) — its
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
        0.08,  // strength — subtle bloom for sun disc + engine glow sparkle
        0.4,   // radius
        // threshold — P2 re-aim (2026-07-20): 4.0 → 2.5. Full HDR-source audit
        // found NOTHING reaches 4.0 (max static emissive 0.6; fireEmissive 1.5;
        // LED flash 2.0; ROSA 0.82; plumes/laser/sun sprite LDR ≤ 0.95;
        // atmosphere Mie limb ≈ 2.7 luma; ocean glint ≈ 2.2–2.7) — the pass
        // produced literally ZERO output while burning its full mip chain
        // (~1.35 ms, GPU_PROFILING_REPORT §10.3). At 2.5 the two brightest real
        // sources (sun-facing limb, peak glint sparkle) bloom subtly — the cost
        // buys visuals again — while staying above the hull-glint range that
        // motivated the raise from 1.5. `?bloomThreshold=N` still overrides.
        (profileFlags.bloomThresholdOverride !== null)
          ? profileFlags.bloomThresholdOverride
          : 2.5
      );
      this.composer.addPass(bloomPass);
      this.bloomPass = bloomPass;
    } else {
      this.bloomPass = null;
    }

    // 3. Output stage — ACES tone map + sRGB encode of the composed HDR buffer.
    // MUST come before any post-AA: OutputPass converts HDR→LDR sRGB, and FXAA's
    // luma edge detection (and SMAA's) assume sRGB/LDR input, so AA runs on the
    // tone-mapped result. This is also what finally activates the SunLight
    // auto-exposure (`renderer.toneMappingExposure`, SunLight._updateAutoExposure)
    // and rolls off the bright atmosphere limb / specular highlights that used to
    // hard-clip at 1.0 (the washed-out look). One cheap fullscreen pass, all tiers.
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
    this.outputPass = outputPass;

    // P1 (2026-07-20): dither the final 8-bit quantization. The HDR chain is
    // HalfFloat end-to-end and the atmosphere shell already self-dithers, but
    // the OutputPass ACES→sRGB conversion re-quantizes the whole frame — dark
    // ocean/night gradients could re-band. three's OutputShader has no
    // dithering hook, so inject the core chunks (<common> first: it supplies
    // rand(); tonemapping_pars self-guards its saturate #ifndef).
    outputPass.material.fragmentShader = outputPass.material.fragmentShader
      .replace('#include <tonemapping_pars_fragment>',
        '#include <common>\n\t\t#include <dithering_pars_fragment>\n\t\t#include <tonemapping_pars_fragment>')
      .replace(/\}\s*$/, '\t#include <dithering_fragment>\n}');
    outputPass.material.defines = outputPass.material.defines || {};
    outputPass.material.defines.DITHERING = '';
    outputPass.material.needsUpdate = true;
    // Guard against silent no-ops: if a future three upgrade reshapes
    // OutputShader, the string replaces above fail QUIETLY (dithering() gets
    // defined but never called — no compile error, just no dithering).
    if (!outputPass.material.fragmentShader.includes('dithering_fragment')) {
      console.warn('[SceneManager] OutputPass dither injection failed — OutputShader changed shape (three upgrade?)');
    }
    // ...but the construction-time define alone is NOT enough: OutputPass.render()
    // rebuilds material.defines from scratch (`defines = {}`) whenever
    // renderer.outputColorSpace/toneMapping differ from its cached values — which
    // is ALWAYS true on the first frame (both cached as null) and again on any
    // later tone-map/color-space change. That wipe silently drops DITHERING, and
    // the text guard above can't detect it (the #include directive stays in the
    // source string). Re-assert the define AFTER three's rebuild so the feature
    // actually engages — one extra recompile the frame after a wipe, stable after.
    const _origOutputRender = outputPass.render.bind(outputPass);
    outputPass.render = (...args) => {
      _origOutputRender(...args);
      if (outputPass.material.defines.DITHERING === undefined) {
        outputPass.material.defines.DITHERING = '';
        outputPass.material.needsUpdate = true;
      }
    };

    // 4. Anti-aliasing: SMAA (HIGH) → FXAA (MEDIUM) → none (LOW + MSAA only).
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
        case 'NearFieldRenderPass': channelName = 'render'; break; // z-layer two-range beauty pass
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
    this.outputPass = null;
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
      console.warn('[SceneManager] ⚠️ Composer RT is NOT HalfFloatType. HDR values will be clamped!');
    }
  }

  /**
   * Set up ambient and directional lights.
   * The main sun DirectionalLight is managed by SunLight.js;
   * here we add a very dim ambient fill.
   * @private
   */
  _setupLights() {
    // Cool, very dim ambient floor. Lifted 0.02 → 0.06 to partly restore the
    // night-side / eclipse readability that previously leaned on the camera
    // fill light's accidental ~35× flood (see CameraSystem fill-light fix).
    // Kept low so the sunlit side still reads with strong directional contrast.
    const ambient = new THREE.AmbientLight(0x112244, 0.06);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    // Image-based ambient fill (PMREM of a neutral studio room). Gives the
    // metallic Mother/daughter hulls (MeshStandardMaterial, metalness ~0.7, no
    // per-material envMap) a soft omnidirectional specular + diffuse response so
    // faces the orbit-driven sun isn't hitting read as lit metal instead of a
    // flat black silhouette against the bright Earth limb. This is the same IBL
    // that makes the menu hero ship read well.
    //
    // EARTH-SAFE: Earth surface, clouds and atmosphere are custom ShaderMaterials
    // (Earth.js), which ignore scene.environment entirely — so the day/night
    // terminator and limb scattering are untouched. Only PBR materials (ship +
    // interactive debris) pick up the fill. Kept modest so deep space stays dark.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const roomEnv = new RoomEnvironment();
      this._envRT = pmrem.fromScene(roomEnv, 0.04);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = 0.55;
      pmrem.dispose();
      // Free the bake scene's geometries/materials — the PMREM texture is the
      // only artifact we keep (in _envRT).
      roomEnv.dispose?.();
    } catch (e) {
      console.warn('[SceneManager] environment IBL setup failed:', e);
      this._envRT = null;
    }
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
    this._updateNearCamera();   // z-layer fix: sync near camera + tight depth range
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
   * P2 (2026-07-20): enable/disable the bloom pass for this frame. Called from
   * the game loop with SunLight.isSunVisible() — when the sun is occluded by
   * Earth nothing in the scene can cross the 2.5 threshold, so the whole
   * UnrealBloom mip chain (~1.35 ms measured) is skipped via Pass.enabled.
   * No-op when the tier has no bloom pass. Safe across applyTier() rebuilds
   * (the new pass defaults to enabled=true and is re-gated next frame).
   * @param {boolean} enabled
   */
  setBloomEnabled(enabled) {
    if (this.bloomPass) this.bloomPass.enabled = enabled !== false;
  }

  /**
   * Push the renderer's drawing-buffer size (CSS px × pixelRatio) to NetMeshKit
   * so its fat-line web threads render at the intended screen-space width.
   */
  _syncNetMeshResolution() {
    const pr = this.renderer.getPixelRatio();
    NetMeshKit.setResolution(window.innerWidth * pr, window.innerHeight * pr);
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

    // Keep the near-field camera's aspect in lockstep (pose/near/far are synced
    // per frame in _updateNearCamera, but aspect must be right for the resize).
    if (this.nearCamera) {
      this.nearCamera.aspect = w / h;
      this.nearCamera.updateProjectionMatrix();
    }

    this.renderer.setSize(w, h);

    // Keep the fat-line net web's LineMaterial resolution in sync with the
    // drawing buffer so threads keep their intended screen-space width.
    this._syncNetMeshResolution();

    // EffectComposer.setSize accepts CSS pixels and internally multiplies
    // by its _pixelRatio (read from renderer in the constructor).
    this.composer.setSize(w, h);

    // Update SMAA pass resolution
    if (this.smaaPass) {
      this.smaaPass.setSize(w * pixelRatio, h * pixelRatio);
    }

    // P2.9: update bloom pass resolution by mutating its existing Vector2
    // and cached resolution — no new allocations on resize.
    // A3: quarter-physical (/4) to match the construction-time resolution in
    // _setupPostProcessing (was /2 here, so a resize silently doubled the bloom
    // RT resolution vs boot).
    if (this.bloomPass) {
      const bw = Math.floor(w * pixelRatio / 4);
      const bh = Math.floor(h * pixelRatio / 4);
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

  /**
   * Register an object whose subtree renders in the near-field depth pass (the
   * z-layer fix). The subtree is moved onto NEAR_FIELD_LAYER (so the main/far
   * camera skips it), and every light currently in the scene is ALSO enabled on
   * that layer (so the near camera still lights the subtree). Call after the
   * object and the scene lights are constructed. Idempotent per root.
   *
   * @param {THREE.Object3D} root  e.g. the player PlayerSatellite group
   */
  registerNearFieldRoot(root) {
    if (!root || this._nearFieldRoots.includes(root)) return;
    this._nearFieldRoots.push(root);
    // Move the whole subtree to the near-field layer ONLY (off layer 0) so the
    // far camera (layer 0) skips it and the near camera (NEAR_FIELD_LAYER) owns
    // it. Groups/lines/sprites included — harmless on non-render nodes.
    root.traverse((o) => { o.layers.set(NEAR_FIELD_LAYER); });
    // Lights must be visible to BOTH cameras or the ship goes dark in the near
    // pass — enable (not set) the near layer so they keep lighting layer 0 too.
    this.scene.traverse((o) => { if (o.isLight) o.layers.enable(NEAR_FIELD_LAYER); });
  }

  /**
   * Remove a previously-registered near-field root and return its subtree to
   * layer 0 (so the FAR camera renders it again). Used for DYNAMIC membership:
   * a daughter's hull is a near root only while it is docked/close to the mother
   * (where it overlaps the hull and would be occluded by the depth-cleared near
   * pass or z-fight the strut-tip collar); once it deploys away it leaves the
   * near set and renders normally in the far pass. No-op if not registered.
   *
   * NOTE: only resets to the default layer 0. Scene lights keep their enabled
   * near layer (harmless, and other roots still need them).
   *
   * @param {THREE.Object3D} root
   */
  unregisterNearFieldRoot(root) {
    const i = this._nearFieldRoots.indexOf(root);
    if (i === -1) return;
    this._nearFieldRoots.splice(i, 1);
    if (root && typeof root.traverse === 'function') {
      root.traverse((o) => { o.layers.set(0); });
    }
  }

  /**
   * Register a camera/ship-follow POINT light so the near pass (a) renders it on
   * NEAR_FIELD_LAYER and (b) transforms it into ×S camera-relative space during
   * the near sub-render (position for scene-level lights, `distance` cutoff for
   * all). Without this, camera fill/rim lights created AFTER registerNearFieldRoot
   * never get the near layer, so the ship renders UNLIT in sim (flat vs the menu
   * hero); and unscaled `distance` cutoffs would fall to ~1/S of the ×S ship,
   * killing the light's reach. Idempotent per light.
   *
   * Only pass lights whose POSITION matters (PointLight fill/rim/pyro). Do NOT
   * pass Directional/Hemisphere/Ambient lights — they are direction- or
   * position-independent, so the ×S reposition is meaningless (and the generic
   * scene-light layer enable in registerNearFieldRoot already covers them).
   *
   * @param {THREE.Light} light
   */
  registerNearFieldLight(light) {
    if (!light || this._nearFieldLights.includes(light)) return;
    this._nearFieldLights.push(light);
    if (light.layers && typeof light.layers.enable === 'function') {
      light.layers.enable(NEAR_FIELD_LAYER);
    }
  }

  /**
   * Drop a previously-registered near-field light (e.g. a transient launch pyro
   * flash being disposed) so the near pass stops transforming it. No-op if the
   * light was never registered.
   * @param {THREE.Light} light
   */
  unregisterNearFieldLight(light) {
    const i = this._nearFieldLights.indexOf(light);
    if (i !== -1) this._nearFieldLights.splice(i, 1);
  }

  /**
   * Re-tag a near-field root's subtree onto NEAR_FIELD_LAYER. Call if a root
   * gains children AFTER registration (dynamically added meshes default to
   * layer 0 and would otherwise leak into the far pass). Cheap; safe to skip.
   * @param {THREE.Object3D} [root] specific root, or all registered roots
   */
  refreshNearFieldLayers(root) {
    const roots = root ? [root] : this._nearFieldRoots;
    for (const r of roots) {
      if (r) r.traverse((o) => { o.layers.set(NEAR_FIELD_LAYER); });
    }
    this.scene.traverse((o) => { if (o.isLight) o.layers.enable(NEAR_FIELD_LAYER); });
  }

  /**
   * @private Sync the near camera to the main camera and bracket its (scaled)
   * near/far around the near-field roots. The near camera sits at the ORIGIN;
   * NearFieldRenderPass scales the ship into ×S camera-relative space so it lands
   * in front of this camera. Owns near-camera STATE only (the transform swap is
   * the pass's job). Called once per frame in render().
   */
  _updateNearCamera() {
    const nc = this.nearCamera;
    const c = this.camera;
    if (!nc || !this._nearFieldRoots || this._nearFieldRoots.length === 0) return;

    // Re-tag the near-field subtree(s) onto NEAR_FIELD_LAYER every frame. A
    // one-time tag at registration is NOT enough: systems that initialise AFTER
    // the ship (ArmManager, tether/net/lasso kits, pooled FX, launch pyro)
    // parent extra meshes/lights into it, and those default to layer 0 — so
    // they'd render in the FAR pass at low precision and z-fight (the exact bug
    // this pass kills). Traversing a few hundred nodes/frame to set an int mask
    // is sub-0.1 ms.
    for (const r of this._nearFieldRoots) {
      if (r) r.traverse(_nfSetNearLayer);
    }

    // The near camera renders from the ORIGIN with the main camera's orientation
    // + intrinsics. The ship is brought to it (scaled, camera-relative) by the
    // pass, so mirroring position would be wrong — it must stay at (0,0,0).
    nc.position.set(0, 0, 0);
    nc.quaternion.copy(c.quaternion);
    nc.fov = c.fov;
    nc.aspect = c.aspect;
    nc.zoom = c.zoom;
    nc.filmGauge = c.filmGauge;
    nc.filmOffset = c.filmOffset;

    // Bracket the depth range tightly around the roots (unscaled distances; the
    // helper multiplies by NEAR_FIELD_SCALE).
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const r of this._nearFieldRoots) {
      if (!r || r.visible === false) continue;
      r.getWorldPosition(_nfWorldPos);
      const d = c.position.distanceTo(_nfWorldPos);
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
    if (!isFinite(dMin)) return;

    // CRITICAL: mirror the LIVE main-camera near (dropped to distance·0.02 during
    // inspect by _applyDynamicNearPlane), NOT the static Constants.CAMERA_NEAR —
    // clamping to the 3 m constant is what made close inspect clip through the
    // hull (see plan B.1). The scaled 5 cm floor keeps it well-conditioned.
    const { near, far } = nearFieldBrackets({
      dMin,
      dMax,
      cameraNear: c.near,
      radius: NEAR_FIELD_RADIUS,
      scale: NEAR_FIELD_SCALE,
      nearFloor: NEAR_FIELD_NEAR_FLOOR,
    });
    nc.near = near;
    nc.far = far;
    nc.updateProjectionMatrix();
    nc.updateMatrixWorld(true);
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
