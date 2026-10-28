/**
 * orbitalFoilEnv.js — synthetic orbital environment map for the MLI gold foil.
 * @module scene/orbitalFoilEnv
 *
 * WHY: foil is a near-mirror, so it shows a distorted image of its environment.
 * The scenes' near-uniform `RoomEnvironment` PMREM makes the reflection integral
 * normal-INDEPENDENT, so no normal map gives contrast (smooth brass pipe). A
 * factorial A/B showed the environment is the dominant lever; this map (black
 * void + one HDR sun disk + one HDR Earth hemisphere) gives broken white/dark
 * foil patchwork.
 *
 * PMREM-prefiltered once per renderer and applied as a PER-MATERIAL `envMap` to
 * ONLY the gold MLI materials (PlayerSatellite.applyFoilEnv); `scene.environment`
 * stays RoomEnvironment for everything else.
 *
 * NOTE: a per-material `envMap` ignores `scene.environmentIntensity`; tune
 * brightness via `material.envMapIntensity` at the call site.
 *
 * Headless-safe: returns null when no usable WebGL renderer is supplied (node
 * tests pass `undefined`).
 */

import * as THREE from 'three';

/** Per-renderer cache of the baked env target: a texture from one GL context is invalid in another. WeakMap so a disposed renderer is GC'd. */
const _cache = new WeakMap();

/**
 * Build (or fetch the cached) synthetic orbital env texture for a renderer; the
 * PMREM bake runs at most once per renderer.
 * @param {THREE.WebGLRenderer} [renderer] needs a GL context; undefined → null
 * @returns {THREE.Texture|null}
 */
export function getOrbitalFoilEnv(renderer) {
  // PMREMGenerator needs a real GL context; null leaves envMap unset.
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
 * The synthetic orbital scene fed to PMREM. Sun and Earth are unlit
 * `MeshBasicMaterial`, so `color` IS emitted radiance; HDR comes from
 * `THREE.Color` components > 1 (r184 accepts this in PMREM fromScene).
 *
 * Sun direction matches the menu hero rig (0xfff8ec at (5,3,4)) so env streaks
 * and the analytic `DirectionalLight` highlight agree; the sim sun is
 * time-varying but one compromise env is fine since crumpled foil scrambles
 * reflections anyway.
 */
function _buildOrbitalScene() {
  const s = new THREE.Scene();
  // Dim WARM FLOOR, not pure black: a black void gave large black voids and
  // maximum-contrast reflections (owner: "too fancy/shiny/distracting").
  s.background = new THREE.Color(0.14, 0.13, 0.11);

  // HDR sun disk, aligned with the analytic sun direction (5,3,4); radiance kept
  // low enough that glints stay but panel-wide blowouts settle to satin.
  const sunDir = new THREE.Vector3(5, 3, 4).normalize().multiplyScalar(10);
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 24, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(28, 26, 22) }),
  );
  sun.position.copy(sunDir);
  s.add(sun);

  // HDR Earth sphere: large, cool, low, so downward-facing folds catch a blue glow band.
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1.1, 1.7) }),
  );
  earth.position.set(0, -12.5, 0);
  s.add(earth);

  return s;
}

function _disposeScene(scene) {
  scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) obj.material.dispose?.();
  });
}
