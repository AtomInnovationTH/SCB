/**
 * Three.js scene, renderer, camera and post-processing (@module scene/SceneManager).
 * Single-composer threshold bloom: emissive > threshold blooms without render-layer
 * tricks; Earth stays pixel-sharp.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
// FXAA fallback for MEDIUM tier (cheaper than SMAA).
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
// Applies renderer.toneMapping (ACES) + sRGB to the composed HDR buffer. Without it
// the composer chain writes raw linear HDR (three only tone-maps materials rendered
// directly to screen), so ACES + SunLight auto-exposure would do nothing.
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Constants } from '../core/Constants.js';
import { devShotGate } from '../core/DevShotGate.js';
import { NearFieldRenderPass, NEAR_FIELD_LAYER, NEAR_FIELD_SCALE } from './NearFieldRenderPass.js';
import { nearFieldBrackets } from './nearFieldMath.js';
import { portraitCameraFor, portraitCameraFit, boxCornersWorld, PORTRAIT_DEFAULT_FILL, PORTRAIT_FIT_FILL } from './portraitFraming.js';

// Near-field depth-pass tuning (see NearFieldRenderPass.js).
// NEAR_FIELD_RADIUS: half-extent (scene units; 1 unit = 100 km) bracketing the player
// ship incl. deployed ROSA wings + struts (true extent < 6 m), so 0.0001 units = 10 m
// is generous slack. Multiplied by NEAR_FIELD_SCALE each frame to set the scaled near
// camera's near/far; a tight bracket improves conditioning in the ×S sub-render.
const NEAR_FIELD_RADIUS = 0.0001;
// Scaled-space near-plane floor (5 cm): in the ×S sub-render M·S = 1 (units = metres);
// well-conditioned under log depth and below any real standoff.
const NEAR_FIELD_NEAR_FLOOR = 0.05;
const NEAR_FIELD_FAR_DEFAULT = 0.01;   // 1 km — construction default, replaced per frame
const _nfWorldPos = new THREE.Vector3();   // scratch for _updateNearCamera (no per-frame alloc)
const _nfSetNearLayer = (o) => { o.layers.set(NEAR_FIELD_LAYER); };  // traverse cb (no per-frame closure alloc)
// SPECS pane one-shot part portrait (renderPartPortrait). Vertical FOV mirrors the
// inspect lens (CameraSystem.inspection.fov = 35); default target 640×400 is 2× the
// pane's 320×200 thumbnail (PHOTO_W × PHOTO_H) so the JPEG downsample keeps edges.
// Rig rebuilt only when a caller asks for another size.
export const PORTRAIT_FOV_DEG = 35;
export const PORTRAIT_W = 640;
export const PORTRAIT_H = 400;
const _pfLook = new THREE.Vector3();       // scratch: look direction (per click, never per frame)
const _pfBox = new THREE.Box3();           // scratch: world box of the sphere-law FALLBACK
const _pfUp = new THREE.Vector3();         // scratch: the caller's image up, normalised
const _pfNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
// Black-flicker triage: `?nf=1` keeps the near-field pass ENABLED on ladder floors
// whose contract disables it (F4/F5 NAVCOM/SDA); the disabled path is the only
// per-floor render-sequence difference on the floors that black out. Opt-in,
// exact-value only, parsed once (DevShotGate idiom); Node/tests always get false.
const _nfForceOn = (() => {
  try {
    return typeof window !== 'undefined' && typeof URLSearchParams !== 'undefined' &&
      new URLSearchParams(devSearch(window.location)).get('nf') === '1';
  } catch (_e) { return false; }
})();
import { profileFlags } from '../core/ProfileFlags.js';
import { selectInitialTier } from '../systems/QualityManager.js';
import { GpuProbe } from '../systems/GpuProbe.js';
import { NetMeshKit } from '../ui/NetMeshKit.js';
import { getOrbitalFoilEnv } from './orbitalFoilEnv.js';
import { clamp01 } from '../core/MathUtil.js';
import { devSearch } from '../core/DevHost.js';

export class SceneManager {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;

    // Bloom resolution, reused across construction, resize and tier swaps (no per-event alloc).
    this._bloomRes = new THREE.Vector2();

    // Set when an AutoProfileSweep config opts into per-pass profiling, so render()
    // skips the per-frame timer query: nested with the per-pass channels, WebGL2
    // silently rejects them (empty `perPass` snapshots).
    this._runtimeProfilePasses = false;

    // WebGL2, logarithmic depth buffer; SMAA does the anti-aliasing (no hardware MSAA).
    //
    // Z-LAYER NOTE: with logarithmicDepthBuffer, `material.polygonOffsetUnits` map to a
    // depth separation that VARIES with viewing distance, so an offset tuned zoomed in
    // under/over-shoots zoomed out. For coplanar layering use `renderOrder`
    // (Constants.RENDER_ORDER) plus a tiny geometric Z stagger. Existing hull
    // polygonOffset values are legacy; do not add more.
    // `?shot=1` / `?shotauto=1` enables `preserveDrawingBuffer` via the ONE shared
    // predicate (js/core/DevShotGate.js) so `window.__netShot()` can read back
    // `#game-canvas` via `toDataURL` (a non-preserved buffer reads black). Default
    // OFF: measurable perf cost, must never ship enabled.
    const _preserveDrawingBuffer = devShotGate.requested;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: _preserveDrawingBuffer,
    });

    // Initial quality tier from GL capabilities + optional `?tier=` override. Pixel
    // ratio is set in _applyRendererPixelRatio() so each tier caps retina differently.
    this.currentTier = this._detectInitialTier();
    this.tierConfig = Constants.PERF.QUALITY_TIERS[this.currentTier];

    // Glass renders at pixel ratio 1.0; main.js flips this via setGlassPixelRatioCap on
    // real touch devices. False by default.
    this._glassPR1 = false;

    this._applyRendererPixelRatio(this.tierConfig);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // NetMeshKit fat lines need the DRAWING-BUFFER size (CSS px × pixelRatio) for
    // screen-space thread width (same units SMAA uses).
    this._syncNetMeshResolution();
    // Net membrane's orbital env (HDR sun disk + Earth hemisphere), baked once per
    // renderer; null headless (setEnvTexture is then a no-op, scene.environment applies).
    // Runs before any net exists: setEnvTexture CACHES the texture for later membranes.
    NetMeshKit.setEnvTexture(getOrbitalFoilEnv(this.renderer));

    // No shadow-casting lights in the scene
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000); // Deep space black

    this.camera = new THREE.PerspectiveCamera(
      Constants.CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      Constants.CAMERA_NEAR,
      Constants.CAMERA_FAR
    );

    // Near-field camera: at the ORIGIN each frame, mirrors the main camera's
    // orientation + intrinsics, renders ONLY the near-field layer (the player ship)
    // after NearFieldRenderPass scales it into ×S camera-relative space. That moves
    // the ship off the flat toe of the log-depth curve (w ~2e-4 → ~16), killing the
    // fp32 `1.0 + w` depth-tie quantum (rationale: NearFieldRenderPass.js).
    // position/near/far are set per frame in _updateNearCamera(); these are defaults.
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
     * space during the near render (fill/rim + launch pyro); directional/hemi/ambient
     * are position-independent and NOT listed. */
    this._nearFieldLights = [];

    // Part-portrait rig (renderPartPortrait), built LAZILY on the first photo and kept:
    // origin camera, HalfFloat colour+depth target for the near set, RGBA8 target the
    // OutputPass (ACES + sRGB) writes for readback, its OWN OutputPass (NEVER the
    // composer's: that is the renderToScreen last pass with the dither injection +
    // patched render), the readback buffer, and harness stats (`__scbPortraitCalls`).
    /** @type {THREE.PerspectiveCamera|null} */ this._portraitCam = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._portraitRT = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._portraitOut = null;
    /** @type {OutputPass|null} */ this._portraitOutput = null;
    /** @type {Uint8Array|null} */ this._portraitBuf = null;
    /** @type {{count:number, nulls:number, calls:number, triangles:number, ms:number, ok:boolean, error:string|null, width:number, height:number, method:string|null, distanceM:number, rolled:boolean}} */
    this._portraitStats = { count: 0, nulls: 0, calls: 0, triangles: 0, ms: 0, ok: false, error: null, width: 0, height: 0, method: null, distanceM: 0, rolled: false };

    /**
     * Zoom Ladder per-floor render block (archive/ladder/02-traps.md). LadderController
     * pushes {nearField, near, far, debrisMode} here; re-asserted at the end of
     * applyTier()/applyTierWithOverrides() because _setupPostProcessing() builds a
     * fresh NearFieldRenderPass that resets nearFieldEnabled to true. Null when the
     * ladder is disengaged / flag off (re-assert is then a no-op).
     * @type {{nearField:boolean, near:?number, far:?number, debrisMode:?string, floor:?number}|null}
     */
    this._ladderFidelity = null;

    /**
     * Zoom Ladder F4/F5 (NAVCOM/SDA) content refs ('ship-to-icon' costume). On floors
     * whose `debrisMode` iconizes the field (F4 'clusters'), debris meshes become
     * cluster icons and the world ship mesh a chevron, so both are hidden and
     * RE-ASSERTED across applyTier() alongside nearFieldEnabled. Registered once from
     * main.js (setLadderContentRefs); null (headless/tests/flag-off) = guarded no-op.
     * @type {?{getDebrisClusters?:function, setLadderDebrisMode?:function}}
     */
    this._ladderDebrisField = null;
    /** @type {?{visible:boolean}} world ship mesh hidden on ship-is-icon floors. */
    this._ladderShip = null;
    /**
     * @type {?{setFollowCamera?:function}} star shell: camera-follow on the
     * Earth-anchored floors (F4/F5, see setLadderFloorFidelity), world-fixed on
     * floors <= 5 and on disengage.
     */
    this._ladderStarfield = null;

    this.clock = new THREE.Clock();

    // GPU runtime probe: wraps the render call to measure GPU frame time; active only
    // with EXT_disjoint_timer_query_webgl2. MUST exist BEFORE _setupPostProcessing()
    // so `?profilePasses=1` can wrap each pass with timer-query channels on the first build.
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

    // Must run AFTER GpuProbe is created (see above).
    this._setupPostProcessing(this.tierConfig);

    this._setupLights();

    this._logDiagnostics();

    console.log(`[Perf] initial quality tier: ${this.currentTier}`, this.tierConfig);
  }

  /**
   * Initial tier from GL capabilities + `?tier=LOW|MEDIUM|HIGH` override (case-insensitive).
   * @returns {'HIGH'|'MEDIUM'|'LOW'}
   */
  _detectInitialTier() {
    try {
      const params = new URLSearchParams(devSearch(window.location));
      const raw = (params.get('tier') || '').toUpperCase();
      if (raw === 'HIGH' || raw === 'MEDIUM' || raw === 'LOW') {
        console.log(`[Perf] tier URL override → ${raw}`);
        return raw;
      }
    } catch (_e) {
      // Non-browser env or malformed URL — ignore.
    }

    const caps = this.renderer.capabilities;
    const maxTextureSize = caps?.maxTextureSize;
    const devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const deviceMemoryGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || undefined;

    // Apple GPU via WEBGL_debug_renderer_info; Safari may expose it only on
    // cross-origin-isolated contexts, so absence = false.
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
   * Glass renders at PIXEL RATIO 1.0: a DPR-2 target quadruples fragment work on an
   * iPad, and tier caps (HIGH/MEDIUM 1.5) still burn ~2.25× the pixels of 1.0.
   * main.js calls this once at init when TouchControls.detectGlass() is true (NARROW
   * gate: coarse PRIMARY pointer + touch points, so a hybrid laptop on a mouse keeps
   * hi-DPI); the current tier's ratio re-applies immediately. The `?pixelRatio=N`
   * override and the applyTierWithOverrides sweep still WIN over the clamp (a profile
   * measures what it asked for).
   */
  setGlassPixelRatioCap(on) {
    this._glassPR1 = !!on;
    if (this.tierConfig) this._applyRendererPixelRatio(this.tierConfig);
    // A ratio change must REBUILD the composer chain NOW: the ctor sized composer/
    // bloom/SMAA/FXAA from the PRE-clamp ratio and an iPad may never fire a window
    // resize, leaving the post chain at 1.5× against the 1× canvas. resize() re-sizes
    // all of them (and the net-mesh resolution) from renderer.getPixelRatio().
    if (this.composer) this.resize();
  }

  /** The glass clamp: tier cap → min(cap, 1) on real touch devices. */
  _pixelRatioCapFor(cap) {
    return this._glassPR1 ? Math.min(cap, 1) : cap;
  }

  /**
   * Sweep config merge for applyTierWithOverrides: an explicit override wins raw (a
   * profile measures what it asked for, the `?pixelRatio=N` law); an UN-overridden
   * pixel ratio re-asserts the glass clamp (so `applyTierWithOverrides({})` restores it).
   * @param {object} base - the live tierConfig
   */
  _mergeSweepTier(base, overrides) {
    const o = overrides || {};
    return {
      msaaSamples: o.msaaSamples !== undefined ? o.msaaSamples : base.msaaSamples,
      enableBloom: o.enableBloom !== undefined ? o.enableBloom : base.enableBloom,
      enableSMAA:  o.enableSMAA  !== undefined ? o.enableSMAA  : base.enableSMAA,
      pixelRatioCap: o.pixelRatioCap !== undefined ? o.pixelRatioCap : this._pixelRatioCapFor(base.pixelRatioCap),
      useFXAAFallback: base.useFXAAFallback,
    };
  }

  _applyRendererPixelRatio(tier) {
    const devicePR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    let cap = (tier && Number.isFinite(tier.pixelRatioCap)) ? tier.pixelRatioCap : 2;
    // Glass clamp applies to every TIER cap; the `?pixelRatio=N` profiling override
    // wins over tier AND glass.
    cap = this._pixelRatioCapFor(cap);
    if (profileFlags.pixelRatioOverride !== null) {
      cap = profileFlags.pixelRatioOverride;
    }
    const target = Math.min(devicePR, cap);
    // Only touch the renderer when the ratio changes: setPixelRatio re-runs setSize,
    // and ANY canvas size assignment (even same-value) resets the drawing buffer to
    // black per the HTML spec (HIGH↔MEDIUM share cap 1.5).
    if (this.renderer.getPixelRatio() !== target) {
      this.renderer.setPixelRatio(target);
    }
  }

  /**
   * Single-composer pipeline from a quality-tier config:
   *   NearFieldRenderPass → [UnrealBloomPass] → OutputPass → [SMAAPass | FXAA ShaderPass]
   * Bloom/SMAA toggle on `tier.enableBloom` / `tier.enableSMAA`; with
   * `tier.useFXAAFallback` (MEDIUM) and SMAA off, FXAA runs instead. MSAA samples =
   * `tier.msaaSamples` (0 on WebGL1).
   * Idempotent: disposes the old composer/passes first, so applyTier() can run live.
   * @param {object} tier - msaaSamples, enableBloom, enableSMAA, useFXAAFallback
   */
  _setupPostProcessing(tier) {
    const cfg = tier || Constants.PERF.QUALITY_TIERS[Constants.PERF.DEFAULT_QUALITY_TIER];

    this._disposePostProcessing();

    const w = window.innerWidth;
    const h = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();
    // Physical buffer dims, floored like WebGLRenderer.setSize; every pass/target sizes from these.
    const pw = Math.floor(w * pixelRatio);
    const ph = Math.floor(h * pixelRatio);

    // Multisampled target removes shimmer on rotating debris (WebGL2 only).
    const isWebGL2 = this.renderer.capabilities.isWebGL2;
    let wantedSamples = Number.isFinite(cfg.msaaSamples) ? cfg.msaaSamples : 4;
    // `?msaa=N` overrides the tier's MSAA.
    if (profileFlags.msaaOverride !== null) {
      wantedSamples = profileFlags.msaaOverride;
    }
    const samples = isWebGL2 ? wantedSamples : 0;
    const customRT = new THREE.WebGLRenderTarget(
      pw,
      ph,
      {
        type: THREE.HalfFloatType,
        samples: samples,
      }
    );
    this.composer = new EffectComposer(this.renderer, customRT);
    // GOTCHA: at LOW tier the chain is [NearFieldRenderPass→renderTarget2,
    // OutputPass→screen] and EffectComposer's swap is a pure JS reference exchange, so
    // renderTarget1 is NEVER BOUND (no __webglTexture); with bloom off there is no
    // renderTargetBright. A GPU probe of target liveness must use dead-AFTER-live
    // semantics (BlackFrameProbe.js) or it misreads this as texture necrosis.
    // Size discipline: the composer gets a PHYSICAL-size custom RT but its _pixelRatio
    // initializes from the renderer (e.g. 1.5), so a later setSize(cssW, cssH) would
    // give fractional css × 1.5 sizes, 0.5px LARGER than the floored drawing buffer.
    // Pin it to ratio 1 and feed floored PHYSICAL sizes everywhere (resize()).
    this.composer.setPixelRatio(1);

    // 1. NearFieldRenderPass draws the far scene with the main camera, then (depth
    //    cleared) the near-field layer (the player ship) with the tight-range near
    //    camera, into the SAME buffer, so downstream passes are unchanged.
    const renderPass = new NearFieldRenderPass(this.scene, this.camera, this.nearCamera);
    this.composer.addPass(renderPass);
    this.renderPass = renderPass;
    // Inspect background-dim ease state (NearFieldRenderPass seam vignette).
    this._inspectDimTarget = 0;
    this._inspectDimLastMs = 0;
    // LIVE shared arrays (re-pointed on every applyTier() rebuild).
    renderPass.nearFieldRoots = this._nearFieldRoots;
    renderPass.nearFieldLights = this._nearFieldLights;
    renderPass.nearFieldScale = NEAR_FIELD_SCALE;

    // 2. Threshold bloom at QUARTER PHYSICAL resolution (gated by tier). Bloom is a
    // low-frequency, threshold-gated effect (sun disc, engine sprites, rare overbright
    // pixels), so /4 vs /2 is visually indistinguishable at orbital altitudes; measured
    // pass cost at /2 was 1.74 ms of a 3.44 ms baseline (HIGH, in mission).
    // `?disableBloom=1` forces this pass off.
    if (cfg.enableBloom && !profileFlags.disableBloom) {
      // Reuses the cached Vector2 (UnrealBloomPass clones its input). Quarter of the
      // FLOORED physical size, so construction and resize() share one integer base.
      this._bloomRes.set(
        Math.floor(pw / 4),
        Math.floor(ph / 4)
      );
      const bloomPass = new UnrealBloomPass(
        this._bloomRes,
        0.08,  // strength — subtle bloom for sun disc + engine glow sparkle
        0.4,   // radius
        // threshold: Constants.BLOOM_THRESHOLD (star ceiling, planet ladder and bloom
        // gate are coupled to it); `?bloomThreshold=N` overrides. Audit: nothing reached
        // the old 4.0 (pass output was ZERO at ~1.35 ms): max static emissive 0.6, fire 1.5,
        // LED flash 2.0, ROSA 0.82 all sit below the threshold. Only the two brightest real
        // sources bloom, the sun-facing limb (Mie ≈ 2.7 luma) and glint (≈ 2.2–2.7), and
        // the threshold stays above the hull-glint range. Venus renders at 2.74
        // (bodyCatalog), so a NON-sun-driven source crosses it, hence the gate below is
        // not sun-only.
        (profileFlags.bloomThresholdOverride !== null)
          ? profileFlags.bloomThresholdOverride
          : Constants.BLOOM_THRESHOLD
      );
      this.composer.addPass(bloomPass);
      this.bloomPass = bloomPass;
    } else {
      this.bloomPass = null;
    }

    // 3. ACES tone map + sRGB encode. MUST come before any post-AA: FXAA/SMAA edge
    // detection assumes sRGB/LDR input. Also what activates SunLight auto-exposure
    // (`renderer.toneMappingExposure`) and rolls off limb/specular highlights. All tiers.
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
    this.outputPass = outputPass;

    // Dither the final 8-bit quantization: the ACES→sRGB conversion re-quantizes the
    // whole frame and dark ocean/night gradients could re-band. OutputShader has no
    // dithering hook, so inject the core chunks (<common> first: it supplies rand();
    // tonemapping_pars self-guards its saturate #ifndef).
    outputPass.material.fragmentShader = outputPass.material.fragmentShader
      .replace('#include <tonemapping_pars_fragment>',
        '#include <common>\n\t\t#include <dithering_pars_fragment>\n\t\t#include <tonemapping_pars_fragment>')
      .replace(/\}\s*$/, '\t#include <dithering_fragment>\n}');
    outputPass.material.defines = outputPass.material.defines || {};
    outputPass.material.defines.DITHERING = '';
    outputPass.material.needsUpdate = true;
    // If a three upgrade reshapes OutputShader the replaces above fail QUIETLY
    // (dithering() defined but never called).
    if (!outputPass.material.fragmentShader.includes('dithering_fragment')) {
      console.warn('[SceneManager] OutputPass dither injection failed — OutputShader changed shape (three upgrade?)');
    }
    // The construction-time define alone is NOT enough: OutputPass.render() rebuilds
    // material.defines from `{}` whenever outputColorSpace/toneMapping differ from its
    // cached values (ALWAYS on the first frame, again on any later change), silently
    // dropping DITHERING; the text guard can't see it. Re-assert AFTER three's rebuild
    // (one extra recompile the frame after a wipe).
    const _origOutputRender = outputPass.render.bind(outputPass);
    outputPass.render = (...args) => {
      _origOutputRender(...args);
      if (outputPass.material.defines.DITHERING === undefined) {
        outputPass.material.defines.DITHERING = '';
        outputPass.material.needsUpdate = true;
      }
    };

    // 4. Anti-aliasing: SMAA (HIGH) → FXAA (MEDIUM) → none (LOW, MSAA only).
    // `?disableSMAA=1` forces *both* SMAA and FXAA off (tier-MSAA still runs in customRT).
    if (cfg.enableSMAA && !profileFlags.disableSMAA) {
      const smaaPass = new SMAAPass(pw, ph);
      this.composer.addPass(smaaPass);
      this.smaaPass = smaaPass;
      this.fxaaPass = null;
    } else if (cfg.useFXAAFallback && !profileFlags.disableSMAA) {
      // FXAA: cheap (~0.3 ms on Iris Xe), softer than SMAA, better than nothing on iGPUs.
      const fxaaPass = new ShaderPass(FXAAShader);
      // `resolution` is in *inverse pixel* units of the physical (integer) buffer.
      fxaaPass.material.uniforms['resolution'].value.set(1 / pw, 1 / ph);
      this.composer.addPass(fxaaPass);
      this.fxaaPass = fxaaPass;
      this.smaaPass = null;
    } else {
      this.smaaPass = null;
      this.fxaaPass = null;
    }

    // `?profilePasses=1`: wrap each pass's render() in a named timer-query channel
    // (re-wraps on every rebuild).
    if (profileFlags.profilePasses) {
      this._installPassProfilers();
    }
  }

  /**
   * Wrap every composer pass's `render()` in `gpuProbe.beginChannel/endChannel`.
   * Channel names come from the pass constructor (render, bloom, smaa, fxaa, else
   * `pass<N>`). No-op without a supported GpuProbe. Sequential by design (WebGL2
   * forbids nested TIME_ELAPSED queries).
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
        case 'NearFieldRenderPass': channelName = 'render'; break;
        case 'UnrealBloomPass':  channelName = 'bloom'; break;
        case 'SMAAPass':         channelName = 'smaa'; break;
        case 'ShaderPass':       channelName = 'fxaa'; break; // ShaderPass is only used for FXAA
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
    try {
      const labels = this.composer.passes
        .map((p) => p?.__profilerChannel || '?')
        .join(' → ');
      console.info(`[GpuProfile] per-pass channels installed: ${labels}`);
    } catch (_e) { /* noop */ }
  }

  _disposePostProcessing() {
    if (this.composer) {
      try { this.composer.renderTarget1?.dispose?.(); } catch (_e) {}
      try { this.composer.renderTarget2?.dispose?.(); } catch (_e) {}
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
   * Register Earth so applyTier() can toggle its LOW_DETAIL fragment-shader branch.
   * @param {object} earth — exposes `setLowDetail(boolean)`
   */
  setEarth(earth) {
    this._earth = earth || null;
    // Applied immediately so registration order is harmless.
    if (this._earth && typeof this._earth.setLowDetail === 'function') {
      this._earth.setLowDetail(this.currentTier === 'LOW');
    }
  }

  /**
   * Switch quality tier live: rebuilds post-processing, updates the pixel-ratio cap,
   * and toggles Earth's LOW_DETAIL branch (skips the 7-octave noise stack at LOW,
   * 2–4 ms/frame on iGPUs). Safe from `runtimeAdapt` paths.
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
    // No explicit renderer.setSize: setPixelRatio re-runs it when the ratio changes, and
    // any needless setSize reassigns canvas.width and blanks the drawing buffer (one
    // black frame per tier swap). Window-size changes are resize()'s job.
    this._applyRendererPixelRatio(cfg);
    this._setupPostProcessing(cfg);
    if (this._earth && typeof this._earth.setLowDetail === 'function') {
      this._earth.setLowDetail(tierName === 'LOW');
    }
    // The rebuilt NearFieldRenderPass reset nearFieldEnabled to true; re-assert the ladder block.
    this._reassertLadderFidelity();
  }

  /**
   * Zoom Ladder per-floor render block setter. LadderController calls it on floor
   * arrival with the FloorContract fidelity + clip planes, or with `null` on
   * disengage, which RESTORES the shipped block (near-field on, camera.near/far back
   * to Constants.CAMERA_NEAR/FAR).
   * @param {{nearField:boolean, near:?number, far:?number, debrisMode:?string, floor:?number}|null} fid
   */
  setLadderFloorFidelity(fid) {
    if (!fid) {
      // Disengage: restore the SHIPPED block (F4/F5 leave far 2000, near-field OFF).
      // Guarded on a prior engaged request.
      if (this._ladderFidelity) {
        if (this.renderPass) this.renderPass.nearFieldEnabled = true;
        if (this.camera) {
          this.camera.near = Constants.CAMERA_NEAR;
          this.camera.far = Constants.CAMERA_FAR;
          this.camera.updateProjectionMatrix();
        }
        // Restore the debris meshes + world ship mesh the ship-is-icon floors hid.
        if (this._ladderDebrisField && this._ladderDebrisField.setLadderDebrisMode) {
          this._ladderDebrisField.setLadderDebrisMode(null);
        }
        if (this._ladderShip) this._ladderShip.visible = true;
        // Back to the world-fixed star shell (setFollowCamera(false) resets the group
        // to the Earth-centered origin pose).
        if (this._ladderStarfield?.setFollowCamera) this._ladderStarfield.setFollowCamera(false);
      }
      this._ladderFidelity = null;
      return;
    }
    this._ladderFidelity = fid;
    // Earth-anchored floors (F4/F5): a world-fixed 400 u shell needs far >= D_max + R,
    // which NAVCOM breaks (BLACK-SKY); camera-follow puts every star at exactly R = 400.
    if (this._ladderStarfield?.setFollowCamera) this._ladderStarfield.setFollowCamera(fid.floor >= 4);
    this._reassertLadderFidelity();
  }

  /**
   * Re-assert the engaged floor's render block over whatever the last rebuild left.
   * No-op for a null request (flag off / disengaged).
   */
  _reassertLadderFidelity() {
    const f = this._ladderFidelity;
    if (!f) return;
    if (this.renderPass) {
      // `?nf=1` overrides the contract's OFF.
      this.renderPass.nearFieldEnabled = _nfForceOn ? true : f.nearField;
      if (_nfForceOn && !f.nearField && !this._nfForceLogged) {
        this._nfForceLogged = true;
        console.info(`[SceneManager] ?nf=1 — near-field pass FORCED ON over floor F${f.floor} contract (H1 experiment)`);
      }
    }
    if (this.camera) {
      let changed = false;
      if (f.near != null && this.camera.near !== f.near) { this.camera.near = f.near; changed = true; }
      if (f.far != null && this.camera.far !== f.far) { this.camera.far = f.far; changed = true; }
      // Starfield: R < far is NOT sufficient for the world-fixed shell (a star behind
      // Earth sits at D + R); F4 (NAVCOM, D <= 255, far 500) breaks it, so
      // Earth-anchored floors run the shell camera-attached (setLadderFloorFidelity).
      if (changed) this.camera.updateProjectionMatrix();
    }
    // 'ship-to-icon' costume: hidden from the SAME re-assert as nearFieldEnabled so it
    // survives applyTier() rebuilds. Guarded on the registered refs (null → no-op).
    if (this._ladderDebrisField && this._ladderDebrisField.setLadderDebrisMode) {
      this._ladderDebrisField.setLadderDebrisMode(f.debrisMode);
    }
    if (this._ladderShip) {
      // Ship-is-icon predicate: keep in lockstep with DebrisField.setLadderDebrisMode's
      // debris hide and LadderController._applyFloorContent's floor arms. The ship
      // vanishes where a costume replaces it: F4 'clusters' (NAVCOM chevron) and F5
      // 'massBands' (full-screen chart).
      const shipIsIcon = (f.debrisMode === 'clusters' || f.debrisMode === 'massBands');
      this._ladderShip.visible = !shipIsIcon;
    }
  }

  /**
   * Clip-plane OWNERSHIP: while a ladder floor contract is engaged, re-assert its
   * near/far EVERY FRAME. Several camera paths restore clip planes unconditionally
   * with no ladder awareness (inspect exit, launch/net ceremony teardown in
   * CameraSystem, the dynamic near-plane), which produced a `near=0.5 far=500` pair
   * matching NO contract; a `far` stomp on F5 (2000) would clip the 1020 u chart
   * framing. Enforcing in the render loop beats patching every writer. Cost: two
   * float compares per frame; projection rebuild + ONE rate-limited warn (the
   * tripwire naming the next rogue writer) only on a stomp. While engaged,
   * LadderController owns all legitimate transitions (through the setter above).
   * @returns {boolean} true when a stomp was repaired this frame
   */
  _enforceLadderClip() {
    const f = this._ladderFidelity;
    if (!f || !this.camera) return false;
    const cam = this.camera;
    const wrongNear = f.near != null && cam.near !== f.near;
    const wrongFar = f.far != null && cam.far !== f.far;
    if (!wrongNear && !wrongFar) return false;
    const was = `${cam.near}/${cam.far}`;
    if (wrongNear) cam.near = f.near;
    if (wrongFar) cam.far = f.far;
    cam.updateProjectionMatrix();
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now() : Date.now();
    if (!this._clipStompWarnAt || now - this._clipStompWarnAt > 5000) {
      this._clipStompWarnAt = now;
      console.warn(`[SceneManager] ladder clip stomp repaired: ${was} → ${cam.near}/${cam.far} (F${f.floor} contract)`);
    }
    return true;
  }

  /**
   * Register the content the per-floor `debrisMode` hides on the ship-is-icon floors
   * (F4/F5): debris meshes and the world ship mesh. Called once from main.js; refs are
   * optional. The hide is applied only from _reassertLadderFidelity.
   * @param {{debrisField?:object, ship?:object, starfield?:object}} [refs]
   */
  setLadderContentRefs({ debrisField, ship, starfield } = {}) {
    this._ladderDebrisField = debrisField || null;
    this._ladderShip = ship || null;
    this._ladderStarfield = starfield || null;
  }

  /**
   * Rebuild composer + renderer state from the **current** tier, with per-key
   * overrides layered on top; AutoProfileSweep uses it to A/B each suspect in one
   * session. Unlike applyTier() it does **not** change `currentTier` / `tierConfig`;
   * revert by calling with `{}`. URL profile flags should not be set alongside
   * `?autoProfile=1` (the sweep warns at construction).
   *
   * @param {object} overrides
   * @param {number}  [overrides.msaaSamples]
   * @param {boolean} [overrides.enableBloom]
   * @param {boolean} [overrides.enableSMAA]
   * @param {number}  [overrides.pixelRatioCap]
   * @param {boolean} [overrides.earthLowDetail]   — force LOW_DETAIL Earth FS
   * @param {boolean} [overrides.cloudsVisible]
   * @param {boolean} [overrides.atmosphereVisible]
   * @param {boolean} [overrides.profilePasses]    — install per-pass timer-query channels
   */
  applyTierWithOverrides(overrides) {
    const base = this.tierConfig;
    const merged = this._mergeSweepTier(base, overrides);

    // Bypasses `_applyRendererPixelRatio` so sweep configs win over `?pixelRatio=N`.
    const devicePR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.renderer.setPixelRatio(Math.min(devicePR, merged.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // `_setupPostProcessing` reads `profileFlags.disableBloom` etc.; expected off in a sweep.
    this._setupPostProcessing(merged);

    if (this._earth) {
      if (typeof this._earth.setLowDetail === 'function') {
        const want = overrides.earthLowDetail !== undefined
          ? !!overrides.earthLowDetail
          : (this.currentTier === 'LOW');
        // Sets the material defines directly to bypass the profileFlags.disableEarthNoise guard.
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

    // The latch flips both ways on every call, so the sweep's NEXT config
    // (profilePasses undefined) falls back to per-frame timing.
    this._runtimeProfilePasses = overrides.profilePasses === true;
    if (overrides.profilePasses) {
      this._installPassProfilers();
    }
    this._reassertLadderFidelity();
  }

  _logDiagnostics() {
    // Gated on Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS (`?debug=1` in main.js).
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

    // The tier may intentionally cap below devicePR; only other mismatches warn.
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

  /** The sun DirectionalLight is managed by SunLight.js; this adds ambient + IBL fill. */
  _setupLights() {
    // Cool, very dim ambient floor (night-side / eclipse readability); kept low so the
    // sunlit side keeps strong directional contrast.
    const ambient = new THREE.AmbientLight(0x112244, 0.06);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    // Image-based ambient fill (PMREM of a neutral studio room): gives the metallic
    // hulls (MeshStandardMaterial, metalness ~0.7, no per-material envMap) a soft
    // omnidirectional response so faces the sun isn't hitting read as lit metal, not a
    // black silhouette against the Earth limb. Same IBL as the menu hero ship.
    // EARTH-SAFE: Earth surface/clouds/atmosphere are custom ShaderMaterials (Earth.js)
    // that ignore scene.environment, so the terminator and limb scattering are untouched.
    // Only PBR materials (ship + interactive debris) pick it up. Kept modest.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const roomEnv = new RoomEnvironment();
      this._envRT = pmrem.fromScene(roomEnv, 0.04);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = 0.55;
      pmrem.dispose();
      // Frees the bake scene; only the PMREM texture (_envRT) is kept.
      roomEnv.dispose?.();
    } catch (e) {
      console.warn('[SceneManager] environment IBL setup failed:', e);
      this._envRT = null;
    }
  }

  /** Render one frame via the composer, wrapped in the GPU probe when supported. */
  render() {
    // Repair any off-contract near/far stomp BEFORE this frame projects anything.
    this._enforceLadderClip();
    // Per-pass profilers wrap each pass in their own TIME_ELAPSED query and WebGL2
    // forbids nesting, so the per-frame begin/end MUST be skipped while they are in
    // use (`?profilePasses=1` or the runtime latch from applyTierWithOverrides).
    const passProfiling = profileFlags.profilePasses || this._runtimeProfilePasses;
    const useFrameQuery =
      this.gpuProbeEnabled && this.gpuProbe && !passProfiling;
    if (useFrameQuery) {
      this.gpuProbe.beginFrame();
    }
    this._updateNearCamera();
    this._updateInspectDim();
    this.composer.render();
    if (useFrameQuery) {
      this.gpuProbe.endFrame();
    }
  }

  /** No-op, kept for callers (e.g. SunLight.js); threshold bloom replaced layer-based bloom. */
  enableBloom(_object3D) {
  }

  /**
   * Enable/disable the bloom pass for this frame; the game loop passes
   * SunLight.isBloomSourceVisible(), so with no source above Constants.BLOOM_THRESHOLD
   * on screen the whole mip chain (~1.35 ms) is skipped via Pass.enabled.
   * The gate is deliberately NOT isSunVisible(): Venus renders at 2.74 with
   * sun-independent visibility, and a sun-only gate disabled bloom with it in frame.
   * No-op without a bloom pass; safe across applyTier() rebuilds (new pass defaults
   * enabled, re-gated next frame).
   */
  setBloomEnabled(enabled) {
    if (this.bloomPass) this.bloomPass.enabled = enabled !== false;
  }

  /** Push the drawing-buffer size (CSS px × pixelRatio) to NetMeshKit for fat-line thread width. */
  _syncNetMeshResolution() {
    const pr = this.renderer.getPixelRatio();
    NetMeshKit.setResolution(window.innerWidth * pr, window.innerHeight * pr);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    // pose/near/far sync per frame in _updateNearCamera; aspect is set here.
    if (this.nearCamera) {
      this.nearCamera.aspect = w / h;
      this.nearCamera.updateProjectionMatrix();
    }

    this.renderer.setSize(w, h);

    this._syncNetMeshResolution();

    // Physical buffer size, floored like WebGLRenderer.setSize. The composer's pixel
    // ratio is pinned to 1 (see _setupPostProcessing), so physical dims keep every
    // target integer-sized and matched to the canvas.
    const pw = Math.floor(w * pixelRatio);
    const ph = Math.floor(h * pixelRatio);
    this.composer.setSize(pw, ph);

    if (this.smaaPass) {
      this.smaaPass.setSize(pw, ph);
    }

    // Mutates the existing Vector2s (no allocs). Quarter-physical (/4) must match
    // _setupPostProcessing, or a resize changes the bloom RT resolution vs boot.
    if (this.bloomPass) {
      const bw = Math.floor(pw / 4);
      const bh = Math.floor(ph / 4);
      this._bloomRes.set(bw, bh);
      if (this.bloomPass.resolution && typeof this.bloomPass.resolution.set === 'function') {
        this.bloomPass.resolution.set(bw, bh);
      }
      if (typeof this.bloomPass.setSize === 'function') {
        this.bloomPass.setSize(bw, bh);
      }
    }

    // Inverse-pixel units.
    if (this.fxaaPass && this.fxaaPass.material?.uniforms?.['resolution']) {
      this.fxaaPass.material.uniforms['resolution'].value.set(1 / pw, 1 / ph);
    }
  }

  /**
   * Reallocate every composer render target WITHOUT touching the canvas or rebuilding
   * a pass (BlackPatchHeal step "targets"). `WebGLRenderTarget.setSize` disposes only
   * when the size CHANGES, so sizing to (pw + 2, ph) and straight back makes three
   * dispose and rebuild each target. Same SMAA/bloom/FXAA updates as `resize()`.
   * Triggers no render.
   */
  reallocateRenderTargets() {
    const pixelRatio = this.renderer.getPixelRatio();
    const pw = Math.floor(window.innerWidth * pixelRatio);
    const ph = Math.floor(window.innerHeight * pixelRatio);
    this.composer.setSize(pw + 2, ph);
    this.composer.setSize(pw, ph);
    if (this.smaaPass) {
      this.smaaPass.setSize(pw, ph);
    }
    if (this.bloomPass) {
      const bw = Math.floor(pw / 4);
      const bh = Math.floor(ph / 4);
      this._bloomRes.set(bw, bh);
      if (this.bloomPass.resolution && typeof this.bloomPass.resolution.set === 'function') {
        this.bloomPass.resolution.set(bw, bh);
      }
      if (typeof this.bloomPass.setSize === 'function') {
        this.bloomPass.setSize(bw, bh);
      }
    }
    if (this.fxaaPass && this.fxaaPass.material?.uniforms?.['resolution']) {
      this.fxaaPass.material.uniforms['resolution'].value.set(1 / pw, 1 / ph);
    }
  }

  /** @returns {THREE.Scene} */
  getScene() {
    return this.scene;
  }

  /**
   * Register an object whose subtree renders in the near-field depth pass: moved onto
   * NEAR_FIELD_LAYER (the far camera skips it), and every scene light is ALSO enabled
   * on that layer (so the near camera lights it). Call after the object and the scene
   * lights exist. Idempotent per root.
   * @param {THREE.Object3D} root  e.g. the PlayerSatellite group
   */
  registerNearFieldRoot(root) {
    if (!root || this._nearFieldRoots.includes(root)) return;
    this._nearFieldRoots.push(root);
    // ONLY the near layer (off layer 0); harmless on non-render nodes.
    root.traverse((o) => { o.layers.set(NEAR_FIELD_LAYER); });
    // Lights must reach BOTH cameras or the ship goes dark in the near pass: enable, not set.
    this.scene.traverse((o) => { if (o.isLight) o.layers.enable(NEAR_FIELD_LAYER); });
  }

  /**
   * Remove a near-field root and return its subtree to layer 0 (the FAR camera renders
   * it again). For DYNAMIC membership: a daughter's hull is a near root only while
   * docked/close to the mother (where the depth-cleared near pass would occlude it or
   * z-fight the strut-tip collar). No-op if not registered. Scene lights keep their
   * near layer (other roots still need them).
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
   * Register a camera/ship-follow POINT light so the near pass renders it on
   * NEAR_FIELD_LAYER and transforms it into ×S camera-relative space (position for
   * scene-level lights, `distance` cutoff for all). Without this, lights created AFTER
   * registerNearFieldRoot never get the near layer (ship renders UNLIT), and unscaled
   * `distance` cutoffs fall to ~1/S of the ×S ship. Idempotent per light.
   * Only POSITION-dependent lights (PointLight fill/rim/pyro); NOT Directional/
   * Hemisphere/Ambient (registerNearFieldRoot's scene-light enable covers them).
   */
  registerNearFieldLight(light) {
    if (!light || this._nearFieldLights.includes(light)) return;
    this._nearFieldLights.push(light);
    if (light.layers && typeof light.layers.enable === 'function') {
      light.layers.enable(NEAR_FIELD_LAYER);
    }
  }

  /**
   * Re-tag near-field subtrees onto NEAR_FIELD_LAYER. Call if a root gains children
   * AFTER registration (new meshes default to layer 0 and would leak into the far pass).
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
   * Inspect background-dim target (peak vignette alpha; 0 fades out). Drawn in
   * NearFieldRenderPass's far→near seam, so it darkens only the surroundings, not
   * the ship or callout layer. Eased per frame (~300 ms fade).
   * @param {number} target01  peak alpha (typically Constants.INSPECTION.DIM), or 0
   */
  setInspectDim(target01) {
    this._inspectDimTarget = clamp01(target01 || 0);
  }

  _updateInspectDim() {
    if (!this.renderPass) return;
    const target = this._inspectDimTarget || 0;
    let cur = this.renderPass.vignetteOpacity || 0;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (Math.abs(target - cur) < 0.002) {
      cur = target;
      this._inspectDimLastMs = 0;
    } else {
      const dt = this._inspectDimLastMs ? Math.min(0.1, (now - this._inspectDimLastMs) / 1000) : 0.016;
      cur += (target - cur) * (1 - Math.exp(-8 * dt));
      this._inspectDimLastMs = now;
    }
    this.renderPass.vignetteOpacity = cur;
  }

  /**
   * Sync the near camera to the main camera and bracket its (scaled) near/far around
   * the near-field roots. It sits at the ORIGIN; NearFieldRenderPass scales the ship
   * into ×S camera-relative space in front of it. Owns near-camera STATE only (the
   * transform swap is the pass's job). Once per frame in render().
   */
  _updateNearCamera() {
    const nc = this.nearCamera;
    const c = this.camera;
    if (!nc || !this._nearFieldRoots || this._nearFieldRoots.length === 0) return;

    // Re-tag onto NEAR_FIELD_LAYER every frame: a one-time tag at registration is NOT
    // enough, since systems initialised AFTER the ship (ArmManager, tether/net/lasso
    // kits, pooled FX, launch pyro) parent meshes/lights into it at layer 0, which
    // would render in the FAR pass and z-fight. A few hundred nodes is sub-0.1 ms.
    for (const r of this._nearFieldRoots) {
      if (r) r.traverse(_nfSetNearLayer);
    }

    // Orientation + intrinsics mirror the main camera; position must stay (0,0,0)
    // because the pass brings the ship to it (scaled, camera-relative).
    nc.position.set(0, 0, 0);
    nc.quaternion.copy(c.quaternion);
    nc.fov = c.fov;
    nc.aspect = c.aspect;
    nc.zoom = c.zoom;
    nc.filmGauge = c.filmGauge;
    nc.filmOffset = c.filmOffset;

    // Unscaled distances; the helper multiplies by NEAR_FIELD_SCALE.
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

    // CRITICAL: use the LIVE main-camera near (distance·0.02 during inspect, from
    // _applyDynamicNearPlane), NOT the static Constants.CAMERA_NEAR: the 3 m constant
    // made close inspect clip through the hull.
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

  /**
   * Session T — the SPECS pane's one-shot PART PORTRAIT (plan §1.6 / T2): draw
   * the near-field set (the ship, in its CURRENT state — flower pose, furl,
   * docked daughters) ONCE with a dedicated camera aimed at a part's world box,
   * callout-free and backdrop-free (layer NEAR_FIELD_LAYER only → the clear's
   * opaque black), tone-mapped like the main view, and hand back the pixels.
   * Runs at the pane's photo edge (one click → one render), NEVER per frame;
   * nothing here touches the per-frame composer chain or the main/near cameras.
   *
   * Steps: the framing — checkpoint-1 amendment (a)/(b), 2026-09-08: with a
   * `matrix` (the part's box is SHIP-LOCAL, the hub's getPartFrame contract)
   * the 8 local corners go through it to world and `portraitCameraFit`
   * (the tight projected-corner fit with auto-roll, fill default
   * PORTRAIT_FIT_FILL) stands
   * the camera; without a matrix, or when the fit is degenerate, the
   * documented FALLBACK `portraitCameraFor(worldBox, dir, 35°, w/h, fill,
   * NEAR_FIELD_RADIUS)` — the bounding-sphere law (fill default 0.7) — does
   * (null → null) → re-tag the roots' layer with the `_nfSetNearLayer` traverse
   * (NOT `_updateNearCamera()`, which brackets near/far against the MAIN camera)
   * → the portrait camera at the ORIGIN, oriented by lookAt from the framing
   * position toward the target with `up` (the ship's up in world, from the
   * hub), `near/far = the framing's · NEAR_FIELD_SCALE` (the ×S space is metres:
   * M·S = 1) → `renderPass.renderNearOnly(renderer, _portraitRT, f.position,
   * cam)` — the swap origin is the portrait camera's WORLD position, so the
   * origin camera sees what a camera standing there would; the scene-level
   * fill/rim/earthshine lights ride the same translation (their POSE is still
   * the main camera's — plan T7) → the private `OutputPass` renders
   * `_portraitRT` → `_portraitOut` (RGBA8; standalone use is legal:
   * renderToScreen false → setRenderTarget(writeBuffer); ACES + sRGB in its own
   * shader — parity with the composer, minus its dither) →
   * `readRenderTargetPixels` into the reused Uint8Array (rows BOTTOM-UP — the
   * caller flips) → `{ data, width, height }`. `setRenderTarget(null)` in a
   * `finally` so the next game frame never inherits the portrait target.
   * Never throws: every failure (no near pass / no roots, a degenerate box, an
   * unsupported readback, a GL error) → null, and the pane keeps today's live
   * crop (plan §1.6: the byte-identical fallback). Stats for the harness in
   * `_portraitStats` (`__scbPortraitCalls` in main.js's ?shot block): the near
   * render's draw calls / triangles (renderer.info right after it, before the
   * output quad resets it), the CPU-blocking ms of render + output + readback.
   *
   * @param {object} opts
   * @param {THREE.Box3} opts.box   the part's box (scene units): SHIP-LOCAL when `matrix` is given, else world
   * @param {THREE.Matrix4} [opts.matrix]  box local → world (the ship's matrixWorld); absent → sphere fallback on a world box
   * @param {THREE.Vector3|number[]} opts.dir   part → camera unit direction (world)
   * @param {number} [opts.fill]   frame fill (fit: largest projected extent's share of the limiting axis; sphere: the
   *    diameter's, default 0.7; small parts 0.35–0.7)
   * @param {THREE.Vector3|number[]} [opts.up]  image up (world; default +Y); the fit may roll it 90°
   * @param {number} [opts.width]  default 640
   * @param {number} [opts.height] default 400
   * @returns {{ data: Uint8Array, width: number, height: number, distance: number, radius: number,
   *   method: 'fit'|'sphere', rolled: boolean }|null}  `distance` in scene units
   */
  renderPartPortrait(opts) {
    const stats = this._portraitStats || (this._portraitStats = { count: 0, nulls: 0, calls: 0, triangles: 0, ms: 0, ok: false, error: null, width: 0, height: 0, method: null, distanceM: 0, rolled: false });
    const renderer = this.renderer;
    try {
      const pass = this.renderPass;
      if (!opts || !renderer || !pass || typeof pass.renderNearOnly !== 'function') return this._portraitNull(stats, 'no near pass');
      if (!this._nearFieldRoots || this._nearFieldRoots.length === 0) return this._portraitNull(stats, 'no near-field roots');
      if (pass.nearFieldEnabled === false) return this._portraitNull(stats, 'near field disabled on this floor');
      const w = (Number.isFinite(opts.width) && opts.width > 0) ? Math.floor(opts.width) : PORTRAIT_W;
      const h = (Number.isFinite(opts.height) && opts.height > 0) ? Math.floor(opts.height) : PORTRAIT_H;
      const fillIn = (Number.isFinite(opts.fill) && opts.fill > 0) ? opts.fill : null;
      const up = opts.up;
      let upOk = false;
      if (up && Number.isFinite(up.x) && Number.isFinite(up.y) && Number.isFinite(up.z) && (up.x || up.y || up.z)) { _pfUp.set(up.x, up.y, up.z).normalize(); upOk = true; }
      else if (Array.isArray(up) && up.length >= 3 && Number.isFinite(up[0]) && Number.isFinite(up[1]) && Number.isFinite(up[2]) && (up[0] || up[1] || up[2])) { _pfUp.set(up[0], up[1], up[2]).normalize(); upOk = true; }
      if (!upOk) _pfUp.set(0, 1, 0);
      // far slack = the near-field bracket radius (10 m): the hull BEHIND a small part
      // stays in frame (a 5 cm puck's 3·radius would clip the deck).
      let f = null;
      const hasMatrix = !!(opts.matrix && opts.matrix.isMatrix4);
      if (hasMatrix) {
        const corners = boxCornersWorld(opts.box, opts.matrix);
        if (corners) f = portraitCameraFit(corners, opts.dir, _pfUp, PORTRAIT_FOV_DEG, w / h, fillIn === null ? PORTRAIT_FIT_FILL : fillIn, NEAR_FIELD_RADIUS);
      }
      if (!f) {
        // FALLBACK: bounding-sphere law on the WORLD box.
        const worldBox = hasMatrix ? _pfBox.copy(opts.box).applyMatrix4(opts.matrix) : opts.box;
        f = portraitCameraFor(worldBox, opts.dir, PORTRAIT_FOV_DEG, w / h, fillIn === null ? PORTRAIT_DEFAULT_FILL : fillIn, NEAR_FIELD_RADIUS);
      }
      if (!f) return this._portraitNull(stats, 'degenerate frame');
      this._ensurePortraitRig(w, h);

      // Late-parented meshes default to layer 0: re-tag as the per-frame path does.
      for (const r of this._nearFieldRoots) {
        if (r) r.traverse(_nfSetNearLayer);
      }

      const cam = this._portraitCam;
      cam.position.set(0, 0, 0);
      // The fit may have rolled the image up.
      cam.up.copy(f.up || _pfUp);
      // The look direction is scale-free: world (unscaled) target − position works.
      _pfLook.copy(f.target).sub(f.position);
      cam.lookAt(_pfLook);
      cam.fov = PORTRAIT_FOV_DEG;
      cam.aspect = w / h;
      cam.near = f.near * NEAR_FIELD_SCALE;
      cam.far = f.far * NEAR_FIELD_SCALE;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      const t0 = _pfNow();
      const drew = pass.renderNearOnly(renderer, this._portraitRT, f.position, cam);
      if (!drew) return this._portraitNull(stats, 'near set not drawn');
      const info = renderer.info && renderer.info.render;
      stats.calls = info ? (info.calls | 0) : 0;
      stats.triangles = info ? (info.triangles | 0) : 0;
      this._portraitOutput.render(renderer, this._portraitOut, this._portraitRT);
      renderer.readRenderTargetPixels(this._portraitOut, 0, 0, w, h, this._portraitBuf);
      stats.ms = _pfNow() - t0;
      stats.count++;
      stats.ok = true;
      stats.error = null;
      stats.width = w;
      stats.height = h;
      stats.method = f.method;
      stats.distanceM = f.distance * NEAR_FIELD_SCALE;   // scene units → metres (M·S = 1)
      stats.rolled = !!f.rolled;
      // Fit's projected half-extents (m), for the witness's frame-share.
      stats.exM = Number.isFinite(f.ex) ? f.ex * NEAR_FIELD_SCALE : null;
      stats.eyM = Number.isFinite(f.ey) ? f.ey * NEAR_FIELD_SCALE : null;
      return { data: this._portraitBuf, width: w, height: h, distance: f.distance, radius: f.radius, method: f.method, rolled: !!f.rolled, ex: f.ex, ey: f.ey };
    } catch (e) {
      return this._portraitNull(stats, (e && e.message) ? e.message : String(e));
    } finally {
      // The next game frame must never inherit the portrait target.
      try { if (renderer && typeof renderer.setRenderTarget === 'function') renderer.setRenderTarget(null); } catch (_e) { /* best-effort */ }
    }
  }

  /** Record a null portrait (the pane falls back to the live crop) and return null. */
  _portraitNull(stats, why) {
    stats.nulls++;
    stats.ok = false;
    stats.error = why || 'unknown';
    return null;
  }

  /**
   * Build the portrait rig on first use (targets rebuilt on a new size): origin camera
   * on NEAR_FIELD_LAYER, HalfFloat colour+depth target (no msaa: the readback source
   * must stay single-sampled), RGBA8 readback target (readRenderTargetPixels accepts
   * UnsignedByte RGBA only), a fresh OutputPass, and the pixel buffer.
   */
  _ensurePortraitRig(w, h) {
    if (!this._portraitCam) {
      this._portraitCam = new THREE.PerspectiveCamera(PORTRAIT_FOV_DEG, w / h, 0.05, 100);
      this._portraitCam.layers.set(NEAR_FIELD_LAYER);
    }
    if (!this._portraitOutput) {
      this._portraitOutput = new OutputPass();
      this._portraitOutput.renderToScreen = false;
    }
    const sized = this._portraitRT && this._portraitRT.width === w && this._portraitRT.height === h;
    if (!sized) {
      if (this._portraitRT) { try { this._portraitRT.dispose(); } catch (_e) { /* best-effort */ } }
      if (this._portraitOut) { try { this._portraitOut.dispose(); } catch (_e) { /* best-effort */ } }
      this._portraitRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        samples: 0,
        depthBuffer: true,
        stencilBuffer: false,
      });
      this._portraitOut = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._portraitBuf = new Uint8Array(w * h * 4);
    }
  }

  /** Harness read: the last portrait's stats (see renderPartPortrait). */
  getPortraitStats() {
    return this._portraitStats;
  }

  /** @returns {THREE.PerspectiveCamera} */
  getCamera() {
    return this.camera;
  }

  /** @returns {THREE.WebGLRenderer} */
  getRenderer() {
    return this.renderer;
  }
}

export default SceneManager;
