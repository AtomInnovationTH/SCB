/**
 * nearFieldMath.js — pure math for the scaled near-field depth sub-render (the
 * log-depth z-layer fix). No three.js / DOM. SINGLE SOURCE OF TRUTH for the
 * scalar math used by `SceneManager._updateNearCamera()` (near/far brackets) and
 * `NearFieldRenderPass.render()` (the ×S transform).
 *
 * WHY: the sim renders at 1 scene unit = 100 km with `logarithmicDepthBuffer`.
 * three's log-depth is:
 *     vFragDepth  = 1.0 + gl_Position.w;              // fp32 varying
 *     gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
 * At chase/inspect range the ~2 m ship sits at `w ≈ 2e-4` units; the fp32 ulp of
 * `1.0 + w` is 2^-23 ≈ 11.9 mm, so any two ship surfaces closer than ~12 mm in
 * depth get BIT-IDENTICAL gl_FragDepth and z-fight. The quantization happens
 * BEFORE logDepthBufFC, so tightening camera near/far does NOT help.
 *
 * FIX: re-render the ship at ×S = 1e5 in CAMERA-RELATIVE coordinates. With metre
 * M = 1e-5 units, M·S = 1 (1 unit = 1 metre in the sub-render); `w` climbs from
 * ~2e-4 to ~16 and the quantum drops to ~2 µm ({@link fp32DepthQuantumMeters}).
 */

/** fp32 unit-in-the-last-place (round-to-nearest) at |x|. */
export function ulpAt(x) {
  x = Math.abs(x);
  if (!(x > 0) || !Number.isFinite(x)) return Math.pow(2, -149); // 0 / NaN → smallest subnormal
  const e = Math.floor(Math.log2(x));
  return Math.pow(2, e - 23); // 23-bit fp32 mantissa
}

/**
 * Real-world depth quantum (metres) at `distanceMeters`. `nearFieldScale = 1`
 * is the BROKEN status quo (~11.9 mm at 16.5 m); `1e5` gives the fixed ~2 µm.
 *
 * @param {number} distanceMeters      camera→surface distance, metres
 * @param {number} metersToSceneUnits  scene units per metre (M = 1e-5)
 * @param {number} nearFieldScale      the ×S sub-render scale (1 = unscaled)
 */
export function fp32DepthQuantumMeters(distanceMeters, metersToSceneUnits, nearFieldScale) {
  const unitsPerMeter = metersToSceneUnits * nearFieldScale;
  const wScaled = distanceMeters * unitsPerMeter;      // clip-space w in the scaled sub-render
  const quantumScaledUnits = ulpAt(1 + wScaled);       // fp32 step of the (1 + w) varying
  return quantumScaledUnits / unitsPerMeter;           // scaled units → real metres
}

/**
 * Camera-relative ×S world position for a near-field root (or scene-level
 * light): a camera at the ORIGIN with the far camera's orientation sees it at
 * the same screen position, S× larger and S× farther. World-space result; nested
 * roots must convert to parent-local afterwards.
 *
 * Test oracle: `NearFieldRenderPass._applyNearFieldScale()` does this inline with
 * reused Vector3s (no per-frame allocation); `test-NearFieldDepth.js` asserts it
 * equals this function. Keep them identical.
 *
 * @param {{x:number,y:number,z:number}} rootWorld object world position
 * @param {{x:number,y:number,z:number}} camPos    far-camera world position
 * @param {number} scale                            ×S
 */
export function scaledRelativePosition(rootWorld, camPos, scale) {
  return {
    x: (rootWorld.x - camPos.x) * scale,
    y: (rootWorld.y - camPos.y) * scale,
    z: (rootWorld.z - camPos.z) * scale,
  };
}

/**
 * Scale a point light's `distance` into ×S space, preserving its reach relative
 * to the ship. `distance ≤ 0` (no cutoff) passes through. Test oracle: the pass
 * applies `distance · S` inline.
 */
export function scaledLightDistance(distance, scale) {
  return distance > 0 ? distance * scale : distance;
}

/**
 * Near/far planes for the scaled near camera, bracketing the near-field roots.
 * `dMin`/`dMax` are UNSCALED camera→root distances and `radius` the unscaled
 * half-extent slack; all multiplied by `scale`. `cameraNear` MUST be the live
 * main-camera near plane (drops to `distance·0.02` during inspect), NOT the
 * static Constants.CAMERA_NEAR, or close inspection clips through the hull.
 *
 * @param {number} p.dMin        nearest camera→root distance (scene units)
 * @param {number} p.dMax        farthest camera→root distance (scene units)
 * @param {number} p.cameraNear  live main-camera near plane (scene units)
 * @param {number} p.radius      near-field half-extent slack (scene units)
 * @param {number} p.scale       ×S
 * @param {number} [p.nearFloor] scaled-space near floor (default 0.05 = 5 cm)
 */
export function nearFieldBrackets({ dMin, dMax, cameraNear, radius, scale, nearFloor = 0.05 }) {
  const near = Math.max(nearFloor, scale * Math.max(cameraNear, dMin - radius));
  const far = scale * (dMax + radius);
  return { near, far };
}
