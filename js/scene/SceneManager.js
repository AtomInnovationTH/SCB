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
import { Constants } from '../core/Constants.js';

export class SceneManager {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this._canvas = canvas;

    // --- Renderer (WebGL2, logarithmic depth buffer) ---
    // SMAA handles anti-aliasing via post-processing; no hardware MSAA needed
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });

    // Retina: use device pixel ratio (capped at 2 for perf)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

    // --- Post-processing (single-composer threshold bloom) ---
    this._setupPostProcessing();

    // --- Lights ---
    this._setupLights();

    // --- Diagnostics ---
    this._logDiagnostics();
  }

  /**
   * Build single-composer pipeline:
   *   RenderPass → UnrealBloomPass (threshold-based, half-res) → SMAAPass
   *
   * Only fragments brighter than the bloom threshold glow.
   * Three.js r170 EffectComposer auto-reads pixelRatio from renderer and
   * creates a HalfFloatType render target at the correct physical resolution.
   * @private
   */
  _setupPostProcessing() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();

    // Use MULTISAMPLED render target for MSAA 4x — eliminates temporal aliasing
    // ("shimmer") on rotating debris. WebGL2 only; falls back to 0 on WebGL1.
    const isWebGL2 = this.renderer.capabilities.isWebGL2;
    const samples = isWebGL2 ? 4 : 0;
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

    // 2. Threshold bloom at half PHYSICAL resolution
    const bloomRes = new THREE.Vector2(
      Math.floor(w * pixelRatio / 2),
      Math.floor(h * pixelRatio / 2)
    );
    const bloomPass = new UnrealBloomPass(
      bloomRes,
      0.15,  // strength — subtle bloom for sun disc + engine glow sparkle
      0.4,   // radius
      1.5    // threshold — raised from 1.2 to eliminate dark halo around ROSA panels
    );
    this.composer.addPass(bloomPass);
    this.bloomPass = bloomPass;

    // 3. SMAA anti-aliasing at full physical resolution
    const smaaPass = new SMAAPass(
      w * pixelRatio,
      h * pixelRatio
    );
    this.composer.addPass(smaaPass);
    this.smaaPass = smaaPass;
  }

  /**
   * Log all critical rendering pipeline values for debugging.
   * @private
   */
  _logDiagnostics() {
    const canvas = this._canvas;
    const pr = this.renderer.getPixelRatio();
    const caps = this.renderer.capabilities;
    const rt1 = this.composer.renderTarget1;

    console.log('%c[SceneManager] Rendering Diagnostics', 'color: #00ff88; font-weight: bold');
    console.table({
      'window.devicePixelRatio': window.devicePixelRatio,
      'renderer.getPixelRatio()': pr,
      'CSS viewport': `${window.innerWidth} × ${window.innerHeight}`,
      'canvas.width × height (buffer)': `${canvas.width} × ${canvas.height}`,
      'expected buffer (CSS × dpr)': `${window.innerWidth * pr} × ${window.innerHeight * pr}`,
      'composer RT size': `${rt1.width} × ${rt1.height}`,
      'composer RT type': rt1.texture.type === THREE.HalfFloatType ? 'HalfFloatType ✓' : `OTHER (${rt1.texture.type}) ⚠️`,
      'bloom resolution': `${this.bloomPass.resolution.x} × ${this.bloomPass.resolution.y}`,
      'bloom threshold': this.bloomPass.threshold,
      'bloom strength': this.bloomPass.strength,
      'toneMapping': this.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 'ACESFilmic' : this.renderer.toneMapping,
      'toneMappingExposure': this.renderer.toneMappingExposure,
      'maxTextureSize': caps.maxTextureSize,
      'maxAnisotropy': caps.getMaxAnisotropy(),
      'isWebGL2': caps.isWebGL2,
      'precision': caps.precision,
    });

    // Warn if something looks wrong
    if (pr < 2 && window.devicePixelRatio >= 2) {
      console.warn('[SceneManager] ⚠️ Pixel ratio mismatch: browser reports', window.devicePixelRatio, 'but renderer using', pr);
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
   */
  render() {
    this.composer.render();
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
