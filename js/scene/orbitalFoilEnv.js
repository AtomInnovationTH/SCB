/**
 * orbitalFoilEnv.js — synthetic orbital environment map for the MLI gold foil.
 * @module scene/orbitalFoilEnv
 *
 * WHY THIS EXISTS (MLI foil v6, root-cause fix):
 * Foil is a near-mirror; its appearance is a distorted image OF ITS ENVIRONMENT.
 * Both scenes light the ship with a near-uniform `RoomEnvironment` PMREM (menu
 * @0.30, sim @0.55). A uniform environment makes the reflection integral
 * normal-INDEPENDENT, so no normal map can produce contrast — the gold reads as
 * a smooth brass pipe regardless of the crumple detail baked into the texture.
 * A factorial A/B (v6 Task 1) confirmed the environment is the dominant lever:
 * swapping in this synthetic orbital env transforms the brass pipe into broken
 * white/dark foil patchwork, while doubling the normal tilt under the room env
 * changes almost nothing.
 *
 * The map is a tiny synthetic orbital scene — black void + one HDR sun disk +
 * one HDR Earth hemisphere — PMREM-prefiltered once per renderer and applied as
 * a PER-MATERIAL `envMap` to ONLY the gold MLI materials (see
 * PlayerSatellite.applyFoilEnv). `scene.environment` stays RoomEnvironment for
 * everything else (astronaut, PV, UI props), so nothing else changes.
 *
 * NOTE: a per-material `envMap` ignores `scene.environmentIntensity`; brightness
 * is retuned via `material.envMapIntensity` at the call site (start 1.0).
 *
 * Deterministic, no downloads, ~ms to bake. Headless-safe: returns null when no
 * usable WebGL renderer is supplied (node tests pass `undefined`).
 */

import * as THREE from 'three';

/**
 * Per-renderer cache of the baked env render target. Keyed by renderer so each
 * WebGL context (menu owns one, sim owns another) gets its own texture; a
 * texture from one context is invalid in another. WeakMap so a disposed
 * renderer's entry is GC'd with it.
 * @type {WeakMap<THREE.WebGLRenderer, THREE.WebGLRenderTarget>}
 */
const _cache = new WeakMap();

/**
 * Build (or fetch the cached) synthetic orbital environment texture for a
 * renderer. Safe to call repeatedly — the PMREM bake runs at most once per
 * renderer.
 *
 * @param {THREE.WebGLRenderer} [renderer] - the scene's renderer (needs a GL
 *   context for PMREMGenerator). Omit/undefined in headless tests → returns null.
 * @returns {THREE.Texture|null} PMREM-prefiltered env texture, or null when no
 *   usable renderer is available.
 */
export function getOrbitalFoilEnv(renderer) {
  // Headless / no-WebGL guard: PMREMGenerator needs a real GL context. Tests run
  // in node with no renderer; return null so the caller leaves envMap unset.
  if (!renderer || typeof renderer.getContext !== 'function') return null;

  const cached = _cache.get(renderer);
  if (cached) return cached.texture;

  let rt = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = _buildOrbitalScene();
    rt = pmrem.fromScene(envScene, 0.04);
    pmrem.dispose();
    _disposeScene(envScene);
  } catch (err) {
    console.warn('[orbitalFoilEnv] PMREM bake failed:', err);
    return null;
  }

  _cache.set(renderer, rt);
  return rt.texture;
}

/**
 * Dispose the cached env render target for a renderer (call on scene teardown).
 * @param {THREE.WebGLRenderer} renderer
 */
export function disposeOrbitalFoilEnv(renderer) {
  const rt = _cache.get(renderer);
  if (rt) {
    rt.dispose();
    _cache.delete(renderer);
  }
}

/**
 * The synthetic orbital scene fed to PMREM. Lit by nothing — the sun and Earth
 * are unlit `MeshBasicMaterial`, so their `color` IS their emitted radiance.
 * HDR radiance comes from `THREE.Color` components > 1 (r184 accepts this in
 * PMREM fromScene): the sun is far brighter than the tonemap white point,
 * producing the blown specular streaks; the Earth is a moderate cool fill for
 * the lower hemisphere.
 *
 * Directions match the menu hero rig so the env sun streaks and the analytic
 * `DirectionalLight` highlight agree (menu sun 0xfff8ec at (5,3,4)). The sim
 * sun is orbit-driven and time-varying; a single compromise env is fine because
 * a crumpled mirror scrambles reflection directions anyway (foil never shows a
 * clean mirror of the sky).
 * @returns {THREE.Scene}
 */
function _buildOrbitalScene() {
  const s = new THREE.Scene();
  // v6.1 CALM: a dim WARM FLOOR instead of pure black. A pitch-black void made
  // the near-mirror foil show large black voids and maximum-contrast reflections
  // (user: "too fancy/shiny/distracting"). A low warm floor keeps the gold's
  // body color everywhere — reflections never crash to black.
  s.background = new THREE.Color(0.14, 0.13, 0.11);

  // HDR sun disk — bright warm, aligned with the analytic sun direction (5,3,4).
  // v6.1 CALM: radiance lowered (60,55,45)→(28,26,22) so glints stay but the
  // whole-panel specular blowouts settle to a satin sheen.
  const sunDir = new THREE.Vector3(5, 3, 4).normalize().multiplyScalar(10);
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 24, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(28, 26, 22) }),
  );
  sun.position.copy(sunDir);
  s.add(sun);

  // HDR Earth sphere — large, cool, low, filling the lower hemisphere so the
  // foil's downward-facing folds catch an Earth-blue glow band.
  // v6.1 CALM: cyan band was too loud (0.9,1.6,2.6)→(0.7,1.1,1.7).
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1.1, 1.7) }),
  );
  earth.position.set(0, -12.5, 0);
  s.add(earth);

  return s;
}

/** Free the throwaway bake scene's geometries + materials. */
function _disposeScene(scene) {
  scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) obj.material.dispose?.();
  });
}
