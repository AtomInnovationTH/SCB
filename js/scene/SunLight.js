/**
 * SunLight.js — Dynamic sun lighting with orbital day/night cycle,
 * sun disc sprite, lens flare artifacts, moon sprite, and auto-exposure
 * @module scene/SunLight
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { createLabelTexture } from './labelTexture.js';

// ============================================================================
// CANVAS TEXTURE HELPERS
// ============================================================================

/**
 * Create a soft radial gradient canvas texture for the sun disc.
 * White-hot center fading to transparent edges.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
function createSunDiscTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  gradient.addColorStop(0.25, 'rgba(255, 255, 238, 0.95)');
  gradient.addColorStop(0.6, 'rgba(255, 255, 200, 0.3)');
  gradient.addColorStop(1.0, 'rgba(255, 255, 180, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Create a canvas-based text texture for planetarium-style labels.
 * Thin wrapper over the shared label recipe (scene/labelTexture.js).
 * @param {string} text — label text (e.g. "♀ Venus")
 * @returns {THREE.CanvasTexture}
 */
function createPlanetLabelTexture(text) {
  return createLabelTexture(text);
}

/**
 * Create a soft radial gradient texture for moon disc.
 * Pale center fading to transparent — avoids flat-circle look.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
function createMoonDiscTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(230, 230, 210, 1.0)');
  gradient.addColorStop(0.4, 'rgba(220, 220, 200, 0.85)');
  gradient.addColorStop(0.7, 'rgba(200, 200, 185, 0.4)');
  gradient.addColorStop(1.0, 'rgba(180, 180, 160, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Create a soft white radial-gradient glow texture for planet halos. Using a gradient that
 * fades to fully transparent at the edge avoids the hard-edged "black ring"
 * artifact produced by a flat additive CircleGeometry, where the uniform-alpha
 * disc cut off abruptly between the planet body and its label.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
// Shared singleton glow texture (white gradient; tinted per-planet via material color)
let _planetGlowTex = null;
function createPlanetGlowTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.45)');
  gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.12)');
  gradient.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Create a soft radial gradient texture for lens flare elements.
 * Avoids the visible square-edge artifact of untextured Sprites.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
function createFlareTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 0.6)');
  gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.2)');
  gradient.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Planet definitions: name, hex color, disc radius, glow radius, angle from sun (degrees).
 *  Sizes are astronomically relative (Moon is largest visible body) then ×1.5 for game visibility.
 *  Real planets are point sources from LEO — these are exaggerated planetarium markers. */
const PLANET_DEFS = [
  { name: 'Mercury', hex: '#c7bfad', radius: 2.25, glow:  3.4,  deg:  20 },
  { name: 'Venus',   hex: '#ffffcc', radius: 4.5,  glow:  6.75, deg:  40 },
  { name: 'Mars',    hex: '#ff6633', radius: 4,     glow:  6,    deg: 170 },
  { name: 'Jupiter', hex: '#ffd699', radius: 5.25,  glow:  7.9,  deg:  90 },
  { name: 'Saturn',  hex: '#f5e6c8', radius: 3.75,  glow:  5.6,  deg: 130 },
];

/** Shared material for depth-only occlusion masks — invisible but writes depth */
const DEPTH_MASK_MAT = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: true,
});

/**
 * Distance from origin at which depth masks are placed.
 * Must be slightly INSIDE the star sphere (STAR_SPHERE_RADIUS = 400) so that
 * masks have smaller depth values than stars and can occlude them.
 */
const DEPTH_MASK_DIST = 398;

// ============================================================================
// SUN LIGHT CLASS
// ============================================================================

export class SunLight {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./SceneManager.js').SceneManager} [sceneManager] — needed for bloom, camera, renderer
   */
  constructor(scene, sceneManager) {
    this.scene = scene;
    this.camera = sceneManager ? sceneManager.getCamera() : null;
    this.renderer = sceneManager ? sceneManager.getRenderer() : null;
    this.elapsedTime = 0;

    // Orbital period for the sun position (visual day/night cycle)
    this.sunOrbitPeriod = Constants.ORBITAL_PERIOD_400KM;

    // --- Directional Light (the Sun) ---
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.directionalLight.name = 'SunLight';

    this.sunDirection = new THREE.Vector3(1, 0.3, 0.5).normalize();
    this._updateLightPosition();
    scene.add(this.directionalLight);

    // Subtle hemisphere light for indirect illumination. Lifted 0.03 → 0.10 to
    // help restore night-side / eclipse readability after the camera fill light
    // was corrected from its accidental ~35× flood (see CameraSystem fill-light
    // fix). Hemisphere (sky/ground gradient) is preferred over more flat ambient
    // because it preserves up/down shaping instead of washing the ship flat.
    this.hemiLight = new THREE.HemisphereLight(
      0x4488bb, // sky color
      0x111122, // ground color
      0.10
    );
    scene.add(this.hemiLight);

    // --- Visual elements ---
    this._createSunDisc(sceneManager);
    this._createLensFlare(sceneManager);
    this._createMoon();
    this._createPlanets();

    // Auto-exposure state
    this._currentExposure = 1.0;
    this._inShadow = false;

    // Reusable vector to avoid per-frame allocations
    this._camForward = new THREE.Vector3();

    // Pre-allocated vectors for Earth occlusion checks (avoid per-frame GC)
    this._occToEarth = new THREE.Vector3();
    this._occToBody = new THREE.Vector3();
  }

  // ==========================================================================
  // SUN DISC SPRITE
  // ==========================================================================

  /**
   * Create the main sun disc sprite with canvas gradient texture.
   * @param {import('./SceneManager.js').SceneManager} [sceneManager]
   * @private
   */
  _createSunDisc(sceneManager) {
    const texture = createSunDiscTexture(256);

    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      color: 0xffffee,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,          // Mask is closer than body — skip depth test so body isn't self-occluded
    }));

    // Scale for ~0.5° angular size at distance 450
    // diameter ≈ 2 × 450 × tan(0.25°) ≈ 3.93 — must stay within CAMERA_FAR (500)
    this.sunSprite.scale.set(4.0, 4.0, 1);
    this.sunSprite.name = 'SunDisc';
    this.scene.add(this.sunSprite);

    // Depth mask — invisible disc placed inside the star sphere to occlude stars/lines.
    // Radius scaled to match angular size of the sun's opaque core at DEPTH_MASK_DIST.
    this._sunDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(1.0 * (DEPTH_MASK_DIST / 450), 32),
      DEPTH_MASK_MAT
    );
    this._sunDepthMask.renderOrder = -1;
    this._sunDepthMask.onBeforeRender = (_r, _s, cam) => this._sunDepthMask.lookAt(cam.position);
    this.scene.add(this._sunDepthMask);

    // --- Sun label (planetarium-style, centered below disc) ---
    this._sunLabel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createPlanetLabelTexture('Sun'),
      transparent: true, opacity: 1.0, depthWrite: false, depthTest: true,
    }));
    this._sunLabel.scale.set(50, 12, 1);
    this._sunLabel.renderOrder = 10;
    this._sunLabel.frustumCulled = false;
    this.scene.add(this._sunLabel);

    // Add to selective bloom layer
    if (sceneManager) sceneManager.enableBloom(this.sunSprite);
  }

  // ==========================================================================
  // LENS FLARE ARTIFACTS
  // ==========================================================================

  /**
   * Create 3 lens flare sprites positioned along the sun→camera line.
   * @param {import('./SceneManager.js').SceneManager} [sceneManager]
   * @private
   */
  _createLensFlare(sceneManager) {
    this.flareGroup = new THREE.Group();
    this.flareGroup.name = 'LensFlareGroup';

    const flareDefs = [
      { fraction: 0.3, scale: 1.2, color: 0xffffaa, opacity: 0.12 },
      { fraction: 0.6, scale: 0.8, color: 0xaaffff, opacity: 0.08 },
      { fraction: 0.85, scale: 1.5, color: 0xffeeaa, opacity: 0.15 },
    ];

    const flareTexture = createFlareTexture(64);

    this.flareSprites = flareDefs.map(def => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flareTexture,
        color: def.color,
        transparent: true,
        opacity: def.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      sprite.scale.set(def.scale, def.scale, 1);
      sprite.userData.fraction = def.fraction;
      sprite.userData.baseOpacity = def.opacity;
      this.flareGroup.add(sprite);
      if (sceneManager) sceneManager.enableBloom(sprite);
      return sprite;
    });

    this.scene.add(this.flareGroup);
  }

  // ==========================================================================
  // MOON SPRITE
  // ==========================================================================

  /**
   * Create a subtle moon mesh (circle geometry) — no bloom, phase-variable opacity.
   * Uses CircleGeometry instead of Sprite to avoid billboard rectangle artifacts.
   * @private
   */
  _createMoon() {
    // Use a radial-gradient texture for soft celestial-body look (no flat-circle artifact)
    const moonTexture = createMoonDiscTexture(128);
    const moonGeo = new THREE.CircleGeometry(9, 32);  // largest visible body (×1.5 base 6)
    this._moonMaterial = new THREE.MeshBasicMaterial({
      map: moonTexture,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,          // Mask is closer than body — skip depth test so body isn't self-occluded
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.moonMesh = new THREE.Mesh(moonGeo, this._moonMaterial);
    this.moonMesh.name = 'Moon';
    // Auto-billboard: face camera each frame via onBeforeRender
    this.moonMesh.onBeforeRender = (renderer, scene, camera) => {
      this.moonMesh.lookAt(camera.position);
    };
    this.scene.add(this.moonMesh);

    // Depth mask — invisible disc placed inside the star sphere to occlude stars/lines.
    // Radius scaled to match angular size of moon's opaque core at DEPTH_MASK_DIST.
    this._moonDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(5 * (DEPTH_MASK_DIST / 430), 32),
      DEPTH_MASK_MAT
    );
    this._moonDepthMask.renderOrder = -1;
    this._moonDepthMask.onBeforeRender = (_r, _s, cam) => this._moonDepthMask.lookAt(cam.position);
    this.scene.add(this._moonDepthMask);

    // --- Moon label (planetarium-style, centered below disc) ---
    this._moonLabel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createPlanetLabelTexture('Moon'),
      transparent: true, opacity: 1.0, depthWrite: false, depthTest: true,
    }));
    this._moonLabel.scale.set(50, 12, 1);
    this._moonLabel.renderOrder = 10;
    this._moonLabel.frustumCulled = false;
    this.scene.add(this._moonLabel);
    console.log('[SunLight] Moon label created, id:', this._moonLabel.id);
  }

  // ==========================================================================
  // LIGHT POSITION
  // ==========================================================================

  /**
   * Update directional light position from the current direction vector.
   * @private
   */
  _updateLightPosition() {
    const sunDistance = 200;
    this.directionalLight.position.copy(
      this.sunDirection.clone().multiplyScalar(sunDistance)
    );
    this.directionalLight.target.position.set(0, 0, 0);
  }

  // ==========================================================================
  // PER-FRAME UPDATE
  // ==========================================================================

  /**
   * Per-frame update: orbits the sun, updates visuals, auto-exposure.
   * @param {number} dt — delta time in seconds
   * @param {THREE.Vector3} [cameraPos] — player camera position for eclipse check
   * @returns {THREE.Vector3} current sun direction (normalized)
   */
  update(dt, cameraPos) {
    this.elapsedTime += dt;

    // --- Sun orbital motion ---
    const angularSpeed = (2 * Math.PI) / this.sunOrbitPeriod;
    const angle = this.elapsedTime * angularSpeed * Constants.TIME_SCALE_GAMEPLAY;
    const tilt = 0.41; // ~23.5° in radians

    this.sunDirection.set(
      Math.cos(angle),
      Math.sin(tilt) * Math.sin(angle),
      Math.sin(angle) * Math.cos(tilt)
    ).normalize();

    this._updateLightPosition();

    // --- Eclipse / shadow check ---
    this._inShadow = false;
    if (cameraPos) {
      this._inShadow = this._isInEarthShadow(cameraPos);
      const targetIntensity = this._inShadow ? 0.05 : 1.5;
      this.directionalLight.intensity +=
        (targetIntensity - this.directionalLight.intensity) * Math.min(1, dt * 3);
    }

    // --- Update visual elements ---
    this._updateSunDisc();
    this._updateLensFlare();
    this._updateMoon();
    this._updatePlanets();
    this._updateAutoExposure(dt);

    return this.sunDirection;
  }

  // ==========================================================================
  // SUN DISC UPDATE
  // ==========================================================================

  /** @private */
  _updateSunDisc() {
    const sunPos = this.sunDirection.clone().multiplyScalar(450);
    this.sunSprite.position.copy(sunPos);

    // Geometric Earth-occlusion: hide sun when behind Earth's disc from camera POV
    const sunHidden = this.camera
      ? this._isOccludedByEarth(this.sunSprite.position, this.camera.position)
      : this._inShadow;
    this.sunSprite.visible = !sunHidden;

    // Update sun depth mask — placed at DEPTH_MASK_DIST along sun direction (inside star sphere)
    if (this._sunDepthMask) {
      this._sunDepthMask.position.copy(this.sunDirection).multiplyScalar(DEPTH_MASK_DIST);
      this._sunDepthMask.visible = !sunHidden;
    }

    // Sun label: camera-relative "below"
    if (this._sunLabel) {
      const down = this.camera
        ? new THREE.Vector3(0, -1, 0).applyQuaternion(this.camera.quaternion)
        : new THREE.Vector3(0, -1, 0);
      this._sunLabel.position.copy(sunPos).add(down.multiplyScalar(12));
      this._sunLabel.visible = !sunHidden && !this._labelsHidden;
    }
  }

  // ==========================================================================
  // LENS FLARE UPDATE
  // ==========================================================================

  /** @private */
  _updateLensFlare() {
    if (!this.camera) {
      this.flareGroup.visible = false;
      return;
    }

    // Hide flares when sun is occluded (geometric Earth-occlusion or shadow)
    if (this._inShadow || !this.sunSprite.visible) {
      this.flareGroup.visible = false;
      return;
    }
    this.flareGroup.visible = true;

    const sunPos = this.sunDirection.clone().multiplyScalar(450);
    const camPos = this.camera.position;

    // Camera forward vector
    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const sunDot = this._camForward.dot(this.sunDirection);

    // Fade flare opacity based on how directly we face the sun
    const flareFade = THREE.MathUtils.smoothstep(sunDot, 0.3, 0.9);

    this.flareSprites.forEach(sprite => {
      const t = sprite.userData.fraction;
      // Position at fraction t along sun→camera line
      sprite.position.lerpVectors(sunPos, camPos, t);
      sprite.material.opacity = sprite.userData.baseOpacity * flareFade;
    });
  }

  // ==========================================================================
  // MOON UPDATE
  // ==========================================================================

  /** @private */
  _updateMoon() {
    // Moon direction: ~110° from the sun on the ecliptic, with exaggerated inclination.
    // Not placed at 180° (opposite sun) because Earth blocks the view from LEO.
    // Rotated 110° around Y-axis from sun direction, then tilted above ecliptic.
    const sunAngle = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    const moonAngle = sunAngle + (110 * Math.PI / 180); // 110° offset
    const moonDir = new THREE.Vector3(
      Math.cos(moonAngle),
      0.25 + Math.sin(this.elapsedTime * 0.0001) * 0.1,  // above ecliptic — clears Earth
      Math.sin(moonAngle)
    ).normalize();

    const moonPos = moonDir.clone().multiplyScalar(430);
    this.moonMesh.position.copy(moonPos);

    // Update moon depth mask — placed at DEPTH_MASK_DIST along moon direction (inside star sphere)
    if (this._moonDepthMask) {
      this._moonDepthMask.position.copy(moonDir).multiplyScalar(DEPTH_MASK_DIST);
    }

    // Phase calculation — brightness varies with sun-moon angle
    // phase ≈ 1 when opposite sun (full moon), ≈ -1 when near sun (new moon)
    const phase = this.sunDirection.dot(moonDir);
    const brightness = Math.max(0.15, (phase + 1) * 0.5);
    this._moonMaterial.opacity = brightness * 0.7;

    // Moon label: camera-relative "below" — no parallax regardless of orbital orientation
    if (this._moonLabel) {
      const down = this.camera
        ? new THREE.Vector3(0, -1, 0).applyQuaternion(this.camera.quaternion)
        : new THREE.Vector3(0, -1, 0);
      this._moonLabel.position.copy(moonPos).add(down.multiplyScalar(17));
      // One-time diagnostic
      if (!this._moonLabelLogged) {
        console.log('[SunLight] Moon label pos:', this._moonLabel.position.toArray().map(v => v.toFixed(1)), 'visible:', this._moonLabel.visible);
        this._moonLabelLogged = true;
      }
    }

    // Earth occlusion — hide moon when behind Earth's disc from camera POV
    if (this.camera) {
      const moonOccluded = this._isOccludedByEarth(this.moonMesh.position, this.camera.position);
      this.moonMesh.visible = !moonOccluded;
      if (this._moonDepthMask) this._moonDepthMask.visible = !moonOccluded;
      if (this._moonLabel) this._moonLabel.visible = !moonOccluded && !this._labelsHidden;
    }
  }

  // ==========================================================================
  // PLANETS — EXAGGERATED DISCS WITH PLANETARIUM LABELS
  // ==========================================================================

  /**
   * Create 5 visible planets as billboard CircleGeometry discs with glow halos
   * and canvas-based planetarium-style text labels + thin tick lines.
   * @private
   */
  _createPlanets() {
    this._planets = PLANET_DEFS.map(def => {
      const color = new THREE.Color(def.hex);

      // --- Main disc ---
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(def.radius, 24),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.85,
          side: THREE.DoubleSide, depthWrite: false,
          depthTest: false,      // Mask is closer than body — skip depth test so body isn't self-occluded
        })
      );
      disc.onBeforeRender = (_r, _s, cam) => disc.lookAt(cam.position);
      this.scene.add(disc);

      // --- Glow halo (soft radial-gradient texture behind disc) ---
      // Use a textured PlaneGeometry with a gradient that fades to transparent
      // rather than a flat CircleGeometry. The old solid additive circle had a
      // hard outer edge that, drawn behind the opaque disc, read as a dark ring
      // between the planet and its label.
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(def.glow * 2, def.glow * 2),
        new THREE.MeshBasicMaterial({
          map: _planetGlowTex || (_planetGlowTex = createPlanetGlowTexture()),
          color, transparent: true, opacity: 0.6,
          side: THREE.DoubleSide, depthWrite: false,
          depthTest: false,      // match disc — avoid self-occlusion against mask
          blending: THREE.AdditiveBlending,
        })
      );
      glow.renderOrder = -1;
      glow.onBeforeRender = (_r, _s, cam) => glow.lookAt(cam.position);
      this.scene.add(glow);

      // --- Planetarium text label (sprite — centered directly under planet) ---
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createPlanetLabelTexture(def.name),
        transparent: true, opacity: 1.0, depthWrite: false,
      }));
      label.scale.set(50, 12, 1);
      label.frustumCulled = false;
      this.scene.add(label);

      // --- Depth mask (invisible, placed inside star sphere to occlude stars/lines) ---
      // Radius scaled to match angular size of planet disc at DEPTH_MASK_DIST.
      const depthMask = new THREE.Mesh(
        new THREE.CircleGeometry(def.radius * (DEPTH_MASK_DIST / 440), 24),
        DEPTH_MASK_MAT
      );
      depthMask.renderOrder = -1;
      depthMask.onBeforeRender = (_r, _s, cam) => depthMask.lookAt(cam.position);
      this.scene.add(depthMask);

      return { disc, glow, label, depthMask, deg: def.deg, radius: def.radius };
    });
  }

  /**
   * Per-frame planet update: reposition on ecliptic plane relative to sun,
   * center labels directly beneath each planet disc.
   * @private
   */
  _updatePlanets() {
    if (!this._planets) return;

    // Sun angle on the ecliptic (XZ plane)
    const sunAngle = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    const _pos = new THREE.Vector3();

    // Camera-relative "below" direction — eliminates parallax between disc and label
    const _down = this.camera
      ? new THREE.Vector3(0, -1, 0).applyQuaternion(this.camera.quaternion)
      : new THREE.Vector3(0, -1, 0);

    for (const p of this._planets) {
      const angle = sunAngle + p.deg * (Math.PI / 180);
      _pos.set(Math.cos(angle), 0, Math.sin(angle));

      p.disc.position.copy(_pos).multiplyScalar(440);
      if (p.depthMask) p.depthMask.position.copy(_pos).multiplyScalar(DEPTH_MASK_DIST);
      p.glow.position.copy(_pos).multiplyScalar(438);  // slightly behind disc
      _pos.multiplyScalar(440);  // restore for label calc

      // Label: camera-relative below — always visually centered under disc
      const labelOffset = p.radius + 8;
      p.label.position.copy(_pos).add(_down.clone().multiplyScalar(labelOffset));

      // Earth occlusion — hide planet when behind Earth's disc from camera POV
      if (this.camera) {
        const occluded = this._isOccludedByEarth(p.disc.position, this.camera.position);
        p.disc.visible = !occluded;
        p.glow.visible = !occluded;
        p.label.visible = !occluded && !this._labelsHidden;
        if (p.depthMask) p.depthMask.visible = !occluded;
      }
    }
  }

  /**
   * Pane-density "sky labels" rung: show/hide the planetarium NAME labels for
   * the Sun, Moon, and planets (the discs themselves stay — they are scenery).
   * A master flag gates the per-frame occlusion logic; hiding is applied
   * immediately, showing is re-derived on the next update tick.
   * @param {boolean} visible
   */
  setBodyLabelsVisible(visible) {
    this._labelsHidden = !visible;
    if (this._labelsHidden) {
      if (this._sunLabel) this._sunLabel.visible = false;
      if (this._moonLabel) this._moonLabel.visible = false;
      if (this._planets) for (const p of this._planets) { if (p.label) p.label.visible = false; }
    }
  }

  // ==========================================================================
  // AUTO-EXPOSURE
  // ==========================================================================

  /**
   * Smoothly adjust renderer tone-mapping exposure based on camera-sun alignment.
   * Looking toward sun → reduce exposure (simulates eye/camera adaptation).
   * @param {number} dt
   * @private
   */
  _updateAutoExposure(dt) {
    if (!this.camera || !this.renderer) return;

    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const sunDot = this._camForward.dot(this.sunDirection);

    // Gentle auto-exposure (now live — the gameplay OutputPass finally applies it).
    // T2.1 retune under ACES: away 1.05→1.12, sun-facing 0.8→0.85, eclipse 1.3→1.25.
    // The filmic shoulder means values >1 are usable without washing out.
    let targetExposure;
    if (this._inShadow) {
      targetExposure = 1.25;  // Boost when in Earth's shadow — simulate eye adaptation
    } else if (sunDot > 0.85) {
      targetExposure = 0.85;  // Looking directly at sun — slight dim
    } else if (sunDot < 0.3) {
      targetExposure = 1.12;  // Looking away from sun — subtle boost without washing out metallic surfaces
    } else {
      // Smooth interpolation in the transition zone [0.3, 0.85]
      const t = (sunDot - 0.3) / (0.85 - 0.3);
      targetExposure = THREE.MathUtils.lerp(1.12, 0.85, t);
    }

    this._currentExposure = THREE.MathUtils.lerp(
      this._currentExposure, targetExposure, 0.02
    );
    this.renderer.toneMappingExposure = this._currentExposure;
  }

  // ==========================================================================
  // EARTH OCCLUSION (GEOMETRIC)
  // ==========================================================================

  /**
   * Check if a celestial body position is occluded by Earth from camera's POV.
   * Uses geometric angular-disc test — no depth buffer involved.
   * Bodies with depthTest:false (moon, planets) can't be occluded by the depth
   * buffer, so this provides a CPU-side visibility check instead.
   * @param {THREE.Vector3} bodyPos - World position of the celestial body
   * @param {THREE.Vector3} cameraPos - World position of the camera
   * @returns {boolean} true if occluded (behind Earth's disc)
   * @private
   */
  _isOccludedByEarth(bodyPos, cameraPos) {
    const earthRadius = 63.71; // Must match Earth.js surface radius
    const camDist = cameraPos.length(); // Distance from camera to Earth center (origin)
    if (camDist <= earthRadius) return false; // Inside Earth — shouldn't happen

    // Angular radius of Earth as seen from camera
    const earthAngularRadius = Math.asin(earthRadius / camDist);

    // Direction from camera to Earth center (origin)
    const toEarth = this._occToEarth.copy(cameraPos).negate().normalize();

    // Vector from camera to body — compute length before normalizing
    const toBody = this._occToBody.subVectors(bodyPos, cameraPos);
    const bodyDist = toBody.length();
    toBody.normalize();

    // Angle between the two directions
    const angle = Math.acos(Math.max(-1, Math.min(1, toEarth.dot(toBody))));

    // Body is occluded if within Earth's angular disc AND farther than Earth surface
    const earthSurfaceDist = camDist - earthRadius;
    return angle < earthAngularRadius && bodyDist > earthSurfaceDist;
  }

  // ==========================================================================
  // SHADOW / ECLIPSE DETECTION
  // ==========================================================================

  /**
   * Check if a position is in Earth's shadow (cylindrical approximation).
   * @param {THREE.Vector3} pos — world position to test
   * @returns {boolean}
   * @private
   */
  _isInEarthShadow(pos) {
    const sunDot = pos.dot(this.sunDirection);
    if (sunDot > 0) return false;

    const projOnSun = this.sunDirection.clone().multiplyScalar(sunDot);
    const perpendicular = pos.clone().sub(projOnSun);
    return perpendicular.length() < Constants.EARTH_RADIUS;
  }

  // ==========================================================================
  // PUBLIC ACCESSORS
  // ==========================================================================

  /** @returns {THREE.Vector3} */
  getSunDirection() {
    return this.sunDirection.clone();
  }

  /** @returns {THREE.DirectionalLight} */
  getLight() {
    return this.directionalLight;
  }
}

export default SunLight;
