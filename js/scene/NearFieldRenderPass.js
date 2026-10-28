/**
 * NearFieldRenderPass.js — scaled near-field beauty pass for the sim's post chain.
 *
 * ROOT CAUSE of the hull shimmer (verified at shader level; do NOT re-diagnose as geometry): the sim renders at
 * 1 scene unit = 100 km with `logarithmicDepthBuffer: true`, far plane 500. three's log-depth path is
 *     vertex:   vFragDepth   = 1.0 + gl_Position.w;                      // fp32 varying
 *     fragment: gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
 * The ~2 m ship at chase/inspect range has `w ≈ 2e-4` scene units; the fp32 ulp of `1.0 + w` is 2^-23 ≈ 11.9 mm,
 * so ANY two hull surfaces within ~12 mm of view depth map to a BIT-IDENTICAL `gl_FragDepth`. Draw order breaks
 * the tie, and three re-sorts opaque objects by camera distance every frame, so the winner flips as the view moves.
 * The quantization happens BEFORE `logDepthBufFC`, so tightening the near camera's near/far does NOT help and no
 * sub-12 mm geometry offset can win. The menu hero is clean because MenuScene3D renders the same mesh ×1e5 in a
 * renderer WITHOUT log depth (`w ≈ 5`, quantum sub-µm).
 *
 * THE FIX (menu parity, per frame): draw the far scene (Earth, orbits, debris, stars) with the main camera,
 * CLEAR DEPTH, then re-render ONLY the near-field set (the ship) with a second camera at the ORIGIN, after
 * transforming each near root into CAMERA-RELATIVE coordinates scaled by S = {@link NEAR_FIELD_SCALE} (1e5):
 *     root.worldPos → (root.worldPos − farCam.worldPos) · S,  root.scale ·= S
 * The ship's metre unit is M = 1e-5, so `M · S = 1` (1 unit = 1 metre, like the menu): `w` climbs from ~2e-4 to
 * ~16 and the fp32 quantum drops from ~12 mm to ~2 µm. See {@link module:scene/nearFieldMath}.
 *
 * Partitioning is by layer: near-field objects + the point lights that must light them live on
 * `NEAR_FIELD_LAYER`; the main camera renders layer 0 only, the near camera `NEAR_FIELD_LAYER` only.
 * Both renders target the SAME composer buffer with `needsSwap = false`, so the downstream bloom / SMAA /
 * output chain is unchanged.
 *
 * Occlusion caveat: clearing depth draws the near set on top of the far scene. Correct for a chase/orbit camera
 * (the ship is always nearest); a far object passing BETWEEN camera and ship would composite wrong. Hull-origin
 * FX (muzzle flashes, tethers, nets) are far-pass by design.
 *
 * @module scene/NearFieldRenderPass
 */
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Vector3, Color, Scene, OrthographicCamera, PlaneGeometry, Mesh, ShaderMaterial } from 'three';

/** Layer for near-field objects + the lights that illuminate them. Layer 0 stays the far layer. */
export const NEAR_FIELD_LAYER = 1;

/**
 * Camera-relative re-render scale. 1e5 with the ship's M = 1e-5 metre unit gives M·S = 1. SSOT, imported by
 * SceneManager for the near/far bracket math.
 * @type {number}
 */
export const NEAR_FIELD_SCALE = 1e5;

// Module-scope scratch: the render path must not allocate per frame.
const _worldPos = new Vector3();
const _localPos = new Vector3();
const _lightWorld = new Vector3();
const _clearSave = new Color();   // renderNearOnly: saved/restored renderer clear colour

/**
 * A RenderPass that draws the scene twice into one buffer: the far scene with the main camera, then (depth
 * cleared) the near-field layer at ×S in camera-relative space with a dedicated origin camera.
 *
 * The near camera's STATE (origin position, mirrored orientation/intrinsics, scaled near/far, per-frame layer
 * re-tag) is owned by `SceneManager._updateNearCamera()`. This pass owns only the per-frame TRANSFORM SWAP
 * (scale roots + near lights into ×S space; restore in a `finally` so an exception mid-render can never leave
 * the ship scaled). `renderNearOnly` reuses the swap with an arbitrary origin for the SPECS pane's one-shot
 * part portrait (per click, never inside `render()`).
 *
 * @augments RenderPass
 */
export class NearFieldRenderPass extends RenderPass {
  constructor(scene, farCamera, nearCamera) {
    super(scene, farCamera);
    this.nearCamera = nearCamera;
    /** When false, the near sub-render is skipped (stock RenderPass; safety valve / headless). @type {boolean} */
    this.nearFieldEnabled = true;

    /**
     * Shared references handed over by SceneManager after construction (applyTier() rebuilds re-point at the
     * same live arrays).
     * @type {import('three').Object3D[]|null}
     */
    this.nearFieldRoots = null;
    /** @type {import('three').Light[]|null} */
    this.nearFieldLights = null;
    /** @type {number} camera-relative re-render scale (×S) */
    this.nearFieldScale = NEAR_FIELD_SCALE;

    // Preallocated save slots (grown once, reused): only the first _saved*Count entries are live in a frame.
    /** @private */ this._rootSaves = [];
    /** @private */ this._lightSaves = [];
    /** @private */ this._savedRootCount = 0;
    /** @private */ this._savedLightCount = 0;

    /**
     * Inspect background-dim vignette: peak (corner) alpha; 0 → skip the draw entirely. Driven and eased by
     * SceneManager.setInspectDim(). Drawn in the SEAM between the far and near passes, so it darkens ONLY
     * Earth/stars/debris, never the ship or callout sprites. Its private scene is NEVER added to the shared
     * scene, so neither camera can pick it up.
     * @type {number}
     */
    this.vignetteOpacity = 0;
    /** @private */ this._vigScene = null;
    /** @private */ this._vigCamera = null;
    /** @private */ this._vigMesh = null;
    /** @private */ this._vigMaterial = null;
  }

  /**
   * Lazily build the fullscreen vignette (private scene + ortho camera + quad):
   *   alpha = peak · clamp((len(ndc)/√2 − 0.42) / 0.58, 0, 1)
   * clear out to ~42% of the ray to the corner, ramping to `peak` at the corner.
   * @private
   */
  _ensureVignette() {
    if (this._vigMesh) return;
    this._vigScene = new Scene();
    this._vigCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._vigMaterial = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { uPeak: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec2 vUv;
        uniform float uPeak;
        void main() {
          vec2 ndc = vUv * 2.0 - 1.0;           // viewport-normalized (ellipse fit)
          float r = length(ndc) * 0.7071067811865476; // /√2 → corner = 1.0
          float t = clamp((r - 0.42) / 0.58, 0.0, 1.0);
          float a = uPeak * t;
          gl_FragColor = vec4(vec3(0.0, 0.031, 0.063), a);
        }
      `,
    });
    this._vigMesh = new Mesh(new PlaneGeometry(2, 2), this._vigMaterial);
    this._vigMesh.frustumCulled = false;
    this._vigScene.add(this._vigMesh);
  }

  /**
   * Draw the inspect vignette into the current render target (no clears), in the far→near seam and after
   * super.render() on the disabled path.
   * @private
   */
  _drawVignette(renderer) {
    if (!(this.vignetteOpacity > 0.001)) return;
    this._ensureVignette();
    this._vigMaterial.uniforms.uPeak.value = this.vignetteOpacity;
    renderer.render(this._vigScene, this._vigCamera);
  }

  /** Release the vignette GPU resources. Safe when never built. */
  disposeVignette() {
    if (this._vigMesh) this._vigMesh.geometry?.dispose();
    this._vigMaterial?.dispose();
    this._vigMesh = null;
    this._vigMaterial = null;
    this._vigScene = null;
    this._vigCamera = null;
  }

  /** Composer teardown hook. */
  dispose() {
    this.disposeVignette();
    if (typeof super.dispose === 'function') super.dispose();
  }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    // Disabled → stock RenderPass plus the vignette on top (dims the ship too; safety-valve/headless fallback only).
    if (!this.nearFieldEnabled || !this.nearCamera) {
      super.render(renderer, writeBuffer, readBuffer);
      if (this.vignetteOpacity > 0.001) {
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
        this._drawVignette(renderer);
        renderer.autoClear = prevAutoClear;
      }
      return;
    }

    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);

    // FAR pass: clear honoring the renderer's autoClear* flags like the stock RenderPass, then draw layer 0.
    renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    renderer.render(this.scene, this.camera);

    // INSPECT DIM: in the seam, after the far pass and BEFORE the depth clear + near pass, so only the
    // surroundings darken. It renders its OWN private scene (background null), and issues no clears, so the far
    // colour is preserved.
    this._drawVignette(renderer);

    // NEAR pass: wipe ONLY depth, scale the near set into ×S space, draw on top.
    // CRITICAL: a non-null scene.background makes WebGLBackground FORCE-CLEAR the color buffer at the start of
    // EVERY renderer.render() regardless of autoClear, erasing the far scene. Null it for the near render.
    const savedBackground = this.scene.background;
    this.scene.background = null;
    try {
      if (this._applyNearFieldScale()) {
        renderer.clearDepth();
        renderer.render(this.scene, this.nearCamera);
      }
    } finally {
      // Restore transforms FIRST (even if the render threw: a scaled ship leaking into the far pass would be catastrophic).
      this._restoreNearFieldScale();
      this.scene.background = savedBackground;
      renderer.autoClear = oldAutoClear;
    }
  }

  /**
   * The SPECS pane's one-shot PART PORTRAIT: draw ONLY the near-field set (NEAR_FIELD_LAYER, no far pass, no
   * vignette) into `target` with an arbitrary origin camera. The ×S swap is taken relative to `originWorld` (the
   * portrait camera's WORLD position), so `camera` at the ORIGIN looking along the portrait direction sees the
   * part as a camera standing at `originWorld` would. The caller owns the camera's pose/fov/near/far/layers and
   * re-tags the roots' layer first.
   *
   * The target is cleared to OPAQUE black (colour + depth + stencil, whatever the renderer's clear colour: a
   * transparent clear would double-darken translucent hull layers when the readback is composited onto black)
   * with `scene.background` nulled so WebGLBackground cannot force-clear it again. Everything touched (roots,
   * lights, `scene.background`, `renderer.autoClear`, clear colour/alpha, bound render target) is restored in a
   * `finally`, even when `render` throws (the error propagates). `render()` never calls this.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').WebGLRenderTarget|null} target  the portrait colour+depth target
   * @param {import('three').Vector3} originWorld  the swap origin — the portrait camera's world position
   * @param {import('three').Camera} camera  the origin camera (NEAR_FIELD_LAYER only)
   * @returns {boolean} true when the near set was drawn (false: no roots / degenerate origin)
   */
  renderNearOnly(renderer, target, originWorld, camera) {
    const savedBackground = this.scene.background;
    const oldAutoClear = renderer.autoClear;
    const hasTargetApi = typeof renderer.getRenderTarget === 'function';
    const prevTarget = hasTargetApi ? renderer.getRenderTarget() : null;
    const hasClearApi = typeof renderer.getClearColor === 'function' && typeof renderer.getClearAlpha === 'function'
      && typeof renderer.setClearColor === 'function';
    let prevClearColor = null;
    let prevClearAlpha = 1;
    let drew = false;
    this.scene.background = null;
    renderer.autoClear = false;
    try {
      if (hasClearApi) {
        prevClearColor = renderer.getClearColor(_clearSave);
        prevClearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 1);
      }
      renderer.setRenderTarget(target);
      renderer.clear(true, true, true);
      if (this._applyNearFieldScale(originWorld)) {
        renderer.render(this.scene, camera);
        drew = true;
      }
    } finally {
      // Transforms FIRST, then the renderer state.
      this._restoreNearFieldScale();
      this.scene.background = savedBackground;
      renderer.autoClear = oldAutoClear;
      if (hasClearApi && prevClearColor) renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.setRenderTarget(prevTarget);
    }
    return drew;
  }

  /**
   * Transform every visible near-field root — and the point lights that light them — into ×S camera-relative
   * space, recording restore state. Ship-child lights ride along on their root's scale; only their `distance`
   * cutoff is scaled. Scene-level lights (camera fill/rim) are repositioned to the same `(world − cam)·S` point.
   *
   * `originPos` is the world point the swap is taken relative to: the far camera's position by default, or the
   * portrait camera's WORLD position for {@link renderNearOnly}. A pure translation of the whole ×S scene, so
   * lighting geometry stays consistent whatever origin is passed.
   *
   * @param {import('three').Vector3} [originPos] swap origin (world); default this.camera.position
   * @returns {boolean} true if the near sub-render should proceed this frame
   * @private
   */
  _applyNearFieldScale(originPos) {
    this._savedRootCount = 0;
    this._savedLightCount = 0;

    const roots = this.nearFieldRoots;
    if (!roots || roots.length === 0) return false;

    const S = this.nearFieldScale;
    const camPos = originPos || this.camera.position;   // far camera has no parent: position is world
    if (!camPos || !Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z)) {
      return false;
    }

    let anyValid = false;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (!r || r.visible === false) continue;

      r.getWorldPosition(_worldPos);          // updates ancestor world matrices
      _localPos.copy(_worldPos).sub(camPos);
      if (_localPos.lengthSq() < 1e-30) continue; // camera coincides with root → skip (NaN guard)
      // (world − cam)·S, inlined zero-alloc; oracle is nearFieldMath.scaledRelativePosition (test-NearFieldDepth keeps them in lockstep).
      _localPos.multiplyScalar(S);
      if (r.parent) r.parent.worldToLocal(_localPos);
      if (!Number.isFinite(_localPos.x) || !Number.isFinite(_localPos.y) || !Number.isFinite(_localPos.z)) {
        continue;
      }

      const save = this._rootSaves[this._savedRootCount] ||
        (this._rootSaves[this._savedRootCount] = { root: null, pos: new Vector3(), scale: new Vector3() });
      save.root = r;
      save.pos.copy(r.position);
      save.scale.copy(r.scale);
      this._savedRootCount++;

      r.position.copy(_localPos);
      r.scale.multiplyScalar(S);            // COMPOSE with any existing scale (intro cinematic!)
      r.updateMatrixWorld(true);
      anyValid = true;
    }
    if (!anyValid) return false;

    // Near-field lights, scaled AFTER roots (ship-child lights already sit at their scaled position; only the falloff cutoff needs fixing).
    const lights = this.nearFieldLights;
    if (lights && lights.length) {
      for (let i = 0; i < lights.length; i++) {
        const L = lights[i];
        if (!L) continue;

        const save = this._lightSaves[this._savedLightCount] ||
          (this._lightSaves[this._savedLightCount] = { light: null, pos: new Vector3(), distance: 0, movedPos: false });
        save.light = L;
        save.distance = L.distance;
        save.movedPos = false;
        this._savedLightCount++;

        // Falloff cutoff scales with the space (decay 0 ⇒ intensity unchanged); oracle: nearFieldMath.scaledLightDistance.
        if (typeof L.distance === 'number' && L.distance > 0) {
          L.distance = L.distance * S;
        }

        // Scene-level lights must be repositioned to (world − cam)·S themselves; ship-child lights moved with their root.
        if (!this._isInsideNearRoot(L)) {
          L.getWorldPosition(_lightWorld);
          _lightWorld.sub(camPos).multiplyScalar(S);
          if (L.parent) L.parent.worldToLocal(_lightWorld);
          if (Number.isFinite(_lightWorld.x) && Number.isFinite(_lightWorld.y) && Number.isFinite(_lightWorld.z)) {
            save.pos.copy(L.position);
            save.movedPos = true;
            L.position.copy(_lightWorld);
            L.updateMatrixWorld(true);
          }
        }
      }
    }
    return true;
  }

  /** Restore every root/light mutated this frame to its pre-swap transform. No-op when nothing was saved. @private */
  _restoreNearFieldScale() {
    for (let i = 0; i < this._savedRootCount; i++) {
      const s = this._rootSaves[i];
      if (!s || !s.root) continue;
      s.root.position.copy(s.pos);
      s.root.scale.copy(s.scale);
      s.root.updateMatrixWorld(true);
      s.root = null; // release ref
    }
    this._savedRootCount = 0;

    for (let i = 0; i < this._savedLightCount; i++) {
      const s = this._lightSaves[i];
      if (!s || !s.light) continue;
      s.light.distance = s.distance;
      if (s.movedPos) {
        s.light.position.copy(s.pos);
        s.light.updateMatrixWorld(true);
      }
      s.light = null; // release ref
    }
    this._savedLightCount = 0;
  }

  /** True when `obj` is a descendant of a near-field root (its world position is carried by the root's ×S scale). @private */
  _isInsideNearRoot(obj) {
    const roots = this.nearFieldRoots;
    if (!roots || roots.length === 0) return false;
    let p = obj.parent;
    while (p) {
      if (roots.indexOf(p) !== -1) return true;
      p = p.parent;
    }
    return false;
  }
}
