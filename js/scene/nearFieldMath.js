/**
 * nearFieldMath.js — pure, allocation-light math for the scaled near-field
 * depth sub-render (the log-depth z-layer fix). No three.js / DOM dependency so
 * it is unit-testable headlessly, and it is the SINGLE SOURCE OF TRUTH for the
 * scalar math that both `SceneManager._updateNearCamera()` (near/far brackets)
 * and `NearFieldRenderPass.render()` (the ×S transform) rely on.
 *
 * ── WHY ANY OF THIS EXISTS (root cause, verified at the shader level) ─────────
 * The sim renders at 1 scene unit = 100 km with `logarithmicDepthBuffer: true`.
 * three's log-depth path (vertex→fragment) is:
 *     vFragDepth  = 1.0 + gl_Position.w;              // fp32 varying
 *     gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
 * At chase/inspect range the ~2 m ship sits at `gl_Position.w ≈ 2e-4` scene
 * units. The fp32 ulp of `1.0 + w` near 1.0 is 2^-23 ≈ 1.19e-7 units ≈ 11.9 mm,
 * so ANY two ship surfaces closer than ~12 mm in view depth get BIT-IDENTICAL
 * gl_FragDepth and their draw order (re-sorted by camera distance each frame)
 * decides the winner → shimmer/z-fighting. The quantization happens BEFORE
 * logDepthBufFC is applied, so tightening the camera's near/far does NOT help.
 *
 * ── THE FIX ───────────────────────────────────────────────────────────────
 * Re-render the ship at ×S = 1e5 scale in CAMERA-RELATIVE coordinates. Because
 * the ship's metre unit is M = 1e-5 scene units and S = 1e5, `M · S = 1`, i.e.
 * the scaled sub-render is effectively "1 unit = 1 metre" — the same
 * well-conditioned regime the menu hero renders in. `w` climbs from ~2e-4 to
 * ~16, moving the ship off the flat toe of log2(1 + w); the fp32 quantum drops
 * to ~2 µm (see {@link fp32DepthQuantumMeters}).
 */

/**
 * fp32 unit-in-the-last-place at |x| (single-precision, round-to-nearest).
 * @param {number} x
 * @returns {number} the spacing between consecutive fp32 values near x
 */
export function ulpAt(x) {
  x = Math.abs(x);
  if (!(x > 0) || !Number.isFinite(x)) return Math.pow(2, -149); // 0 / NaN → smallest subnormal
  const e = Math.floor(Math.log2(x));
  return Math.pow(2, e - 23); // 23-bit fp32 mantissa
}

/**
 * Real-world depth quantum (metres) for a surface at `distanceMeters`, given the
 * scene's metre→unit factor and the near-field render scale. With
 * `nearFieldScale = 1` this returns the BROKEN status-quo (~11.9 mm at 16.5 m);
 * with `nearFieldScale = 1e5` it returns the FIXED quantum (~2 µm) — the whole
 * point of the sub-render.
 *
 * @param {number} distanceMeters      camera→surface distance, metres
 * @param {number} metersToSceneUnits  scene units per metre (M = 1e-5)
 * @param {number} nearFieldScale      the ×S sub-render scale (1 = unscaled)
 * @returns {number} smallest resolvable depth separation, metres
 */
export function fp32DepthQuantumMeters(distanceMeters, metersToSceneUnits, nearFieldScale) {
  const unitsPerMeter = metersToSceneUnits * nearFieldScale;
  const wScaled = distanceMeters * unitsPerMeter;      // clip-space w in the scaled sub-render
  const quantumScaledUnits = ulpAt(1 + wScaled);       // fp32 step of the (1 + w) varying
  return quantumScaledUnits / unitsPerMeter;           // scaled units → real metres
}

/**
 * Camera-relative ×S world position for a near-field root (or scene-level light).
 * Places the object so a camera at the ORIGIN with the far camera's orientation
 * reproduces the exact screen position, S× larger and S× farther (so w scales).
 * Returns a world-space triple; nested roots must convert to parent-local space
 * afterwards (identity when the root is a direct child of the scene).
 *
 * SSOT / test-oracle: `NearFieldRenderPass._applyNearFieldScale()` performs this
 * transform inline with reused three.js Vector3s (zero per-frame allocation)
 * rather than calling this helper; `test-NearFieldDepth.js` asserts the pass's
 * live output equals this function, so the two stay in lockstep. Keep them
 * identical — this is the readable definition of that inlined math.
 *
 * @param {{x:number,y:number,z:number}} rootWorld object world position
 * @param {{x:number,y:number,z:number}} camPos    far-camera world position
 * @param {number} scale                            ×S
 * @returns {{x:number,y:number,z:number}}
 */
export function scaledRelativePosition(rootWorld, camPos, scale) {
  return {
    x: (rootWorld.x - camPos.x) * scale,
    y: (rootWorld.y - camPos.y) * scale,
    z: (rootWorld.z - camPos.z) * scale,
  };
}

/**
 * Scale a point light's `distance` (falloff cutoff) into the ×S space so its
 * reach relative to the (now S× larger) ship is preserved. `distance ≤ 0` means
 * "no cutoff" and is passed through unchanged.
 *
 * SSOT / test-oracle: as with {@link scaledRelativePosition}, the render pass
 * applies `distance · S` inline; this is the tested reference definition.
 *
 * @param {number} distance
 * @param {number} scale
 * @returns {number}
 */
export function scaledLightDistance(distance, scale) {
  return distance > 0 ? distance * scale : distance;
}

/**
 * Near/far planes for the scaled near camera, bracketing the near-field roots.
 *
 * `dMin`/`dMax` are the UNSCALED camera→root distances (real scene units) and
 * `radius` is the unscaled half-extent slack; everything is multiplied by
 * `scale` because the sub-render lives in ×S space. `cameraNear` MUST be the
 * live main-camera near plane (which drops to `distance·0.02` during inspect),
 * NOT the static Constants.CAMERA_NEAR — mirroring the constant is what made
 * close inspection clip through the hull.
 *
 * @param {object} p
 * @param {number} p.dMin        nearest camera→root distance (scene units)
 * @param {number} p.dMax        farthest camera→root distance (scene units)
 * @param {number} p.cameraNear  live main-camera near plane (scene units)
 * @param {number} p.radius      near-field half-extent slack (scene units)
 * @param {number} p.scale       ×S
 * @param {number} [p.nearFloor] scaled-space near floor (default 0.05 = 5 cm)
 * @returns {{near:number, far:number}}
 */
export function nearFieldBrackets({ dMin, dMax, cameraNear, radius, scale, nearFloor = 0.05 }) {
  const near = Math.max(nearFloor, scale * Math.max(cameraNear, dMin - radius));
  const far = scale * (dMax + radius);
  return { near, far };
}
