/**
 * NearFieldRenderPass.js — scaled near-field beauty pass for the sim's post chain.
 *
 * ── ROOT CAUSE (verified at the shader level; do NOT re-diagnose as geometry) ─
 * The sim renders at 1 scene unit = 100 km with `logarithmicDepthBuffer: true`
 * and a far plane of 500 (~50,000 km). three's log-depth path is:
 *     // vertex
 *     vFragDepth   = 1.0 + gl_Position.w;              // fp32 varying
 *     // fragment
 *     gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
 * The ~2 m player ship at chase/inspect range sits at `gl_Position.w ≈ 2e-4`
 * scene units. The fp32 ulp of `1.0 + w` near 1.0 is 2^-23 ≈ 1.19e-7 units =
 * ~11.9 mm, so ANY two hull surfaces within ~12 mm of view depth (PV cells,
 * seams, caps, nozzle liners, strut collars…) map to a BIT-IDENTICAL
 * `gl_FragDepth`. The tie is then broken by draw order, and three re-sorts
 * opaque objects by camera distance every frame, so the winner flips as the
 * view moves → the shimmer/flicker historically (mis)called "z-fighting".
 *
 * CRUCIALLY the quantization happens BEFORE `logDepthBufFC` is applied, so
 * tightening the near camera's near/far does NOT help — the input `w` is already
 * quantized. No sub-12 mm geometry offset can win either. The menu hero is clean
 * only because MenuScene3D renders the identical mesh scaled ×1e5 in a renderer
 * WITHOUT log depth (near 0.1 / far 200): at metre scale `w ≈ 5` and the quantum
 * is sub-µm. That scale difference is the entire menu-vs-sim gap.
 *
 * ── THE FIX (menu parity, per frame) ─────────────────────────────────────────
 * Draw the far scene (Earth, orbits, debris, stars) with the main camera, CLEAR
 * DEPTH, then re-render ONLY the near-field set (the ship) with a second camera
 * positioned at the ORIGIN, after transforming each near root into CAMERA-
 * RELATIVE coordinates scaled by S = {@link NEAR_FIELD_SCALE} (1e5):
 *     root.worldPos → (root.worldPos − farCam.worldPos) · S,  root.scale ·= S
 * Because the ship's metre unit is M = 1e-5 and S = 1e5, `M · S = 1`: the sub-
 * render is effectively "1 unit = 1 metre", the same well-conditioned regime the
 * menu uses. `w` climbs from ~2e-4 to ~16 → the fp32 quantum drops from ~12 mm
 * to ~2 µm (three orders below the mm-scale hull detail). No world scale, physics
 * or Earth-shader changes. See {@link module:scene/nearFieldMath} for the numbers.
 *
 * Partitioning is by layer: near-field objects + the point lights that must light
 * them live on `NEAR_FIELD_LAYER`; the main camera renders layer 0 only (skips
 * the ship), the near camera renders `NEAR_FIELD_LAYER` only.
 *
 * Both renders target the SAME composer buffer with `needsSwap = false`, so the
 * downstream bloom / SMAA / output chain is byte-for-byte unchanged and the
 * ship's additive lights still bloom on the composite exactly as before.
 *
 * Occlusion caveat: clearing depth draws the near set on top of the far scene.
 * With a chase/orbit camera the ship is always the nearest thing, so this is
 * correct in practice; only a far object passing BETWEEN camera and ship (never
 * with a follow cam) would composite wrong. Scene-level FX that originate at the
 * hull (muzzle flashes, tethers, nets) are far-pass by design — see the plan's
 * A.6 follow-up.
 *
 * @module scene/NearFieldRenderPass
 */
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Vector3 } from 'three';

/**
 * Layer index for near-field objects + the lights that illuminate them.
 * Layer 0 stays the default (far) layer for the whole rest of the scene.
 * @type {number}
 */
export const NEAR_FIELD_LAYER = 1;

/**
 * Camera-relative re-render scale. 1e5 with the ship's M = 1e-5 metre unit makes
 * the sub-render "1 unit = 1 metre" (M·S = 1) — menu parity. SSOT, imported by
 * SceneManager for the near/far bracket math.
 * @type {number}
 */
export const NEAR_FIELD_SCALE = 1e5;

// Module-scope scratch — the render path must not allocate per frame.
const _worldPos = new Vector3();
const _localPos = new Vector3();
const _lightWorld = new Vector3();

/**
 * A RenderPass that draws the scene twice into one buffer: the far scene with
 * the main camera, then (depth cleared) the near-field layer re-rendered at ×S
 * in camera-relative space with a dedicated origin camera.
 *
 * The near camera's STATE (origin position, mirrored orientation/intrinsics,
 * scaled near/far, per-frame layer re-tag) is owned by
 * `SceneManager._updateNearCamera()`. This pass owns only the per-frame
 * TRANSFORM SWAP (scale roots + near lights into ×S space, restore in a
 * `finally` so an exception mid-render can never leave the ship scaled).
 *
 * @augments RenderPass
 */
export class NearFieldRenderPass extends RenderPass {
  /**
   * @param {import('three').Scene} scene   Shared scene (both cameras draw it).
   * @param {import('three').Camera} farCamera  Main camera (layer 0 — far scene).
   * @param {import('three').Camera} nearCamera Near camera (NEAR_FIELD_LAYER only).
   */
  constructor(scene, farCamera, nearCamera) {
    super(scene, farCamera);
    /** @type {import('three').Camera} */
    this.nearCamera = nearCamera;
    /**
     * When false, the near sub-render is skipped and this behaves as a stock
     * RenderPass (safety valve / headless / fallback paths).
     * @type {boolean}
     */
    this.nearFieldEnabled = true;

    /**
     * Shared references handed over by SceneManager after construction (so
     * applyTier() rebuilds re-point at the same live arrays).
     * @type {import('three').Object3D[]|null}
     */
    this.nearFieldRoots = null;
    /** @type {import('three').Light[]|null} */
    this.nearFieldLights = null;
    /** @type {number} camera-relative re-render scale (×S) */
    this.nearFieldScale = NEAR_FIELD_SCALE;

    // Preallocated save slots (grown once, reused) so the transform swap and
    // its restore never allocate. Only the first _savedRoot/LightCount entries
    // are live in any given frame.
    /** @private */ this._rootSaves = [];
    /** @private */ this._lightSaves = [];
    /** @private */ this._savedRootCount = 0;
    /** @private */ this._savedLightCount = 0;
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').WebGLRenderTarget} writeBuffer
   * @param {import('three').WebGLRenderTarget} readBuffer
   */
  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    // No near camera / disabled → identical to the stock RenderPass.
    if (!this.nearFieldEnabled || !this.nearCamera) {
      super.render(renderer, writeBuffer, readBuffer);
      return;
    }

    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);

    // FAR beauty pass: clear color+depth (+stencil) honoring the renderer's
    // autoClear* flags exactly as the stock RenderPass does, then draw layer 0.
    renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    renderer.render(this.scene, this.camera);

    // NEAR beauty pass: wipe ONLY depth (keep the far color), scale the near-
    // field set into ×S camera-relative space, then draw it on top.
    //
    // CRITICAL: a non-null scene.background (here a black Color) makes
    // WebGLBackground FORCE-CLEAR the color buffer at the start of EVERY
    // renderer.render() regardless of renderer.autoClear — which would erase
    // the far scene the first render just drew. Null it for the near render so
    // the ship composites ON TOP of the far color, then restore it.
    const savedBackground = this.scene.background;
    this.scene.background = null;
    try {
      if (this._applyNearFieldScale()) {
        renderer.clearDepth();
        renderer.render(this.scene, this.nearCamera);
      }
    } finally {
      // Restore transforms FIRST (must happen even if the render threw — a
      // scaled ship leaking into the far pass would be catastrophic), then the
      // background + autoClear.
      this._restoreNearFieldScale();
      this.scene.background = savedBackground;
      renderer.autoClear = oldAutoClear;
    }
  }

  /**
   * Transform every visible near-field root — and the point lights that light
   * them — into ×S camera-relative space, recording restore state. Ship-child
   * lights ride along on their root's scale (position handled for free); only
   * their `distance` cutoff is scaled here. Scene-level lights (camera fill/rim)
   * are repositioned to the same `(world − cam)·S` world point their ship-child
   * peers land at, keeping the lighting geometry consistent.
   *
   * @returns {boolean} true if the near sub-render should proceed this frame
   * @private
   */
  _applyNearFieldScale() {
    this._savedRootCount = 0;
    this._savedLightCount = 0;

    const roots = this.nearFieldRoots;
    if (!roots || roots.length === 0) return false;

    const S = this.nearFieldScale;
    const camPos = this.camera.position; // far-camera world position (no parent)
    if (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z)) {
      return false;
    }

    let anyValid = false;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (!r || r.visible === false) continue;

      r.getWorldPosition(_worldPos);          // updates ancestor world matrices
      _localPos.copy(_worldPos).sub(camPos);
      if (_localPos.lengthSq() < 1e-30) continue; // camera coincides with root → skip (NaN guard)
      // (world − cam)·S, inlined zero-alloc; readable SSOT + test-oracle is
      // nearFieldMath.scaledRelativePosition (kept in lockstep by test-NearFieldDepth).
      _localPos.multiplyScalar(S);
      // World → parent-local (identity when the root is a direct child of scene).
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

    // Near-field lights (scaled AFTER roots so ship-child lights already sit at
    // their scaled world position — we only fix their falloff cutoff).
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

        // Falloff cutoff scales with the space (decay 0 ⇒ intensity unchanged).
        // Inlined; SSOT/test-oracle is nearFieldMath.scaledLightDistance.
        if (typeof L.distance === 'number' && L.distance > 0) {
          L.distance = L.distance * S;
        }

        // Scene-level lights (not inside a scaled subtree) must be repositioned
        // to (world − cam)·S themselves; ship-child lights already moved with
        // their root.
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

  /**
   * Restore every root/light mutated this frame to its pre-swap transform.
   * Safe to call unconditionally (no-op when nothing was saved).
   * @private
   */
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

  /**
   * True when `obj` is a descendant of one of the near-field roots (so its
   * world position is already carried by the root's ×S scale).
   * @param {import('three').Object3D} obj
   * @returns {boolean}
   * @private
   */
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
