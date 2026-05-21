/**
 * TierVisualManager.js — Visual transitions for spacecraft tier upgrades.
 * V-9: Epic 10 Tier Progression Visual
 *
 * Manages the visual rebuild when the Crossbow upgrades from Y0_QUAD (4 arms)
 * → Y1_HEX (6 arms, thicker collar) → Y3_OCTO (8 arms, +2 end-face arms).
 *
 * Listens for TIER_UPGRADED event, rebuilds collar ring + strut geometry,
 * plays a brief construction flash animation.
 *
 * Gated behind FEATURE_FLAGS.TIER_UPGRADES.
 *
 * @module scene/TierVisualManager
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** 1 metre in scene units (1 scene unit = 100 km). Same as PlayerSatellite.js */
const M = 1e-5;

// ── Material colour constants ───────────────────────────────────────────
const COL_HINGE   = 0x889999;
const COL_STRUT   = 0x667788;
const COL_LED     = 0x00ff88;
const COL_FLASH   = 0x44aaff;
const COL_ENDFACE = 0x889999;

// ── Geometry defaults from OCTOPUS_V5 ───────────────────────────────────
const v5 = () => Constants.OCTOPUS_V5 || {};

// ═══════════════════════════════════════════════════════════════════════════
// CLASS
// ═══════════════════════════════════════════════════════════════════════════

class TierVisualManager {
  constructor() {
    this._scene = null;
    this._player = null;
    this._armManager = null;
    this._enabled = false;
    this._transitioning = false;
    this._transitionTimer = 0;
    this._transitionDuration = 2.0;   // seconds
    this._flashMeshes = [];           // temporary flash geometry
    this._addedStruts = [];           // strut groups added during upgrade
    this._endFaceGroups = [];         // end-face arm mount groups for Y3
    this._currentTier = 'Y0_QUAD';
    this._unsubscribe = null;         // EventBus unsubscribe function
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialize the tier visual manager.
   * @param {THREE.Scene} scene
   * @param {object} player      — PlayerSatellite instance
   * @param {object} armManager  — ArmManager instance
   */
  init(scene, player, armManager) {
    if (!Constants.FEATURE_FLAGS || !Constants.FEATURE_FLAGS.TIER_UPGRADES) {
      return;
    }
    this._scene = scene;
    this._player = player;
    this._armManager = armManager;
    this._enabled = true;
    this._currentTier = armManager.getCurrentTier();

    this._boundHandler = (payload) => this._onTierUpgraded(payload);
    this._unsubscribe = eventBus.on(Events.TIER_UPGRADED, this._boundHandler);
  }

  // ─── Event handler ──────────────────────────────────────────────────────

  /**
   * Handle TIER_UPGRADED event.
   * @param {{ fromTier: string, toTier: string, newArmCount: number, newMassDryKg: number }} payload
   */
  _onTierUpgraded({ fromTier, toTier, newArmCount, newMassDryKg }) {
    this._currentTier = toTier;
    this._transitioning = true;
    this._transitionTimer = 0;
    this._rebuildVisuals(toTier, newArmCount);
    this._createUpgradeFlash();
  }

  // ─── Visual rebuild ─────────────────────────────────────────────────────

  /**
   * Rebuild collar ring geometry and add new strut visuals for the new tier.
   * @param {string} tierKey    — 'Y0_QUAD' | 'Y1_HEX' | 'Y3_OCTO'
   * @param {number} newArmCount
   */
  _rebuildVisuals(tierKey, newArmCount) {
    const player = this._player;
    if (!player) return;

    const cfg       = v5();
    const collarR   = cfg.COLLAR_RADIUS   || 0.40;
    const collarY   = cfg.COLLAR_Y        || 0.90;
    const strutLen  = cfg.STRUT_LENGTH    || 1.60;
    const strutOD   = cfg.STRUT_TUBE_OD   || 0.050;
    const coreLen   = cfg.CORE_LENGTH     || 2.0;

    const tierCfg = Constants.ARM_LADDER && Constants.ARM_LADDER[tierKey];
    if (!tierCfg) return;

    // ── 1. Thicken collar ring ──────────────────────────────────────────
    if (player.collarRing) {
      const tubeBase = 0.025;           // m — base tube radius
      let tubeScale = 1.0;
      if (tierCfg.tier >= 1) tubeScale = 1.25;
      if (tierCfg.tier >= 3) tubeScale = 1.50;

      if (player.collarRing.geometry && player.collarRing.geometry.dispose) {
        player.collarRing.geometry.dispose();
      }
      player.collarRing.geometry = new THREE.TorusGeometry(
        collarR * M,
        tubeBase * tubeScale * M,
        8, 32
      );
    }

    // ── 2. Add new strut visuals for additional arms ────────────────────
    this._removeAddedStruts();

    // Collect azimuths already present on the player model
    const existingAz = new Set();
    if (player.strutGroups) {
      for (const sg of player.strutGroups) {
        if (sg && sg.azRad !== undefined) {
          existingAz.add(Math.round(sg.azRad * 180 / Math.PI));
        }
      }
    }

    const targetAz = tierCfg.azimuths || [];
    for (const azDeg of targetAz) {
      if (existingAz.has(azDeg)) continue;
      const azRad = azDeg * Math.PI / 180;
      const group = this._createStrutVisual(azRad, collarR, collarY, strutLen, strutOD);
      if (player.add) player.add(group);
      this._addedStruts.push(group);
    }

    // ── 3. End-face arm mounts for Y3_OCTO ──────────────────────────────
    this._removeEndFaceGroups();

    if (tierCfg.endFaceArms && tierCfg.endFaceArms.length > 0) {
      const halfLen = coreLen / 2;
      for (const face of tierCfg.endFaceArms) {
        const zSign = face === '+Z' ? 1 : -1;
        const mount = this._createEndFaceMount(zSign * halfLen);
        if (player.add) player.add(mount);
        this._endFaceGroups.push(mount);
      }
    }
  }

  // ─── Strut factory ──────────────────────────────────────────────────────

  /**
   * Create a simple strut visual at the given azimuth on the collar.
   * @param {number} azRad       — azimuth in radians
   * @param {number} collarR     — collar radius in metres
   * @param {number} collarY     — collar Y offset in metres
   * @param {number} strutLen    — strut length in metres
   * @param {number} strutOD     — strut outer diameter in metres
   * @returns {THREE.Group}
   */
  _createStrutVisual(azRad, collarR, collarY, strutLen, strutOD) {
    const group = new THREE.Group();
    group.name = 'tierStrut';

    // Position at collar ring surface
    const cx = Math.cos(azRad) * collarR * M;
    const cz = Math.sin(azRad) * collarR * M;
    group.position.set(cx, collarY * M, cz);

    // Hinge bracket (small sphere)
    const hingeMat = new THREE.MeshStandardMaterial({
      color: COL_HINGE, metalness: 0.7, roughness: 0.3,
    });
    const hingeGeo = new THREE.SphereGeometry(strutOD * 0.8 * M, 6, 4);
    const hinge = new THREE.Mesh(hingeGeo, hingeMat);
    group.add(hinge);

    // Strut tube (cylinder oriented radially outward)
    const strutMat = new THREE.MeshStandardMaterial({
      color: COL_STRUT, metalness: 0.5, roughness: 0.4,
    });
    const strutGeo = new THREE.CylinderGeometry(
      strutOD / 2 * M, strutOD / 2 * M, strutLen * M, 6,
    );
    const strut = new THREE.Mesh(strutGeo, strutMat);
    strut.rotation.z = -Math.PI / 2;
    strut.position.set(
      (strutLen / 2) * M * Math.cos(azRad),
      0,
      (strutLen / 2) * M * Math.sin(azRad),
    );
    group.add(strut);

    // Tip LED indicator
    const ledMat = new THREE.MeshBasicMaterial({ color: COL_LED });
    const ledGeo = new THREE.SphereGeometry(strutOD * 0.4 * M, 4, 3);
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.set(
      strutLen * M * Math.cos(azRad),
      0,
      strutLen * M * Math.sin(azRad),
    );
    group.add(led);

    // Start stowed (near-zero scale) — animated to 1.0 during transition
    group.scale.set(0.01, 0.01, 0.01);
    return group;
  }

  // ─── End-face mount factory ─────────────────────────────────────────────

  /**
   * Create an end-face arm mount at the given Z position.
   * @param {number} zMetres — signed Z position in metres
   * @returns {THREE.Group}
   */
  _createEndFaceMount(zMetres) {
    const group = new THREE.Group();
    group.name = 'endFaceMount';
    group.position.set(0, 0, zMetres * M);

    const mat = new THREE.MeshStandardMaterial({
      color: COL_ENDFACE, metalness: 0.7, roughness: 0.3,
    });

    // Hinge bracket (small box)
    const bracketGeo = new THREE.BoxGeometry(0.08 * M, 0.08 * M, 0.06 * M);
    const bracket = new THREE.Mesh(bracketGeo, mat);
    group.add(bracket);

    // LED indicator
    const ledMat = new THREE.MeshBasicMaterial({ color: COL_LED });
    const ledGeo = new THREE.SphereGeometry(0.02 * M, 4, 3);
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.set(0, 0.05 * M, 0);
    group.add(led);

    // Start stowed
    group.scale.set(0.01, 0.01, 0.01);
    return group;
  }

  // ─── Flash effect ───────────────────────────────────────────────────────

  /**
   * Create a brief construction flash effect around the collar.
   */
  _createUpgradeFlash() {
    const player = this._player;
    if (!player) return;

    const cfg    = v5();
    const collarR = cfg.COLLAR_RADIUS || 0.40;
    const collarY = cfg.COLLAR_Y      || 0.90;

    const geo = new THREE.SphereGeometry(collarR * 3 * M, 16, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: COL_FLASH,
      transparent: true,
      opacity: 0.6,
    });
    const flash = new THREE.Mesh(geo, mat);
    flash.position.set(0, collarY * M, 0);

    if (player.add) player.add(flash);
    this._flashMeshes.push(flash);
  }

  // ─── Per-frame update ───────────────────────────────────────────────────

  /**
   * Animate flash fade + strut unfold.
   * @param {number} dt — delta time in seconds
   */
  update(dt) {
    if (!this._enabled || !this._transitioning) return;

    this._transitionTimer += dt;
    const progress = Math.min(this._transitionTimer / this._transitionDuration, 1.0);

    // ── Flash fade + expand ─────────────────────────────────────────────
    for (const flash of this._flashMeshes) {
      if (flash.material) flash.material.opacity = 0.6 * (1.0 - progress);
      const s = 1.0 + progress * 0.5;
      flash.scale.set(s, s, s);
    }

    // ── Strut unfold: scale 0.01 → 1.0 (slightly faster than flash) ────
    const strutProg  = Math.min(progress * 1.5, 1.0);
    const strutScale = 0.01 + strutProg * 0.99;
    for (const strut of this._addedStruts) {
      strut.scale.set(strutScale, strutScale, strutScale);
    }

    // ── End-face mount unfold ───────────────────────────────────────────
    for (const mount of this._endFaceGroups) {
      mount.scale.set(strutScale, strutScale, strutScale);
    }

    // ── Transition complete ─────────────────────────────────────────────
    if (progress >= 1.0) {
      this._finishTransition();
    }
  }

  /** Finalize transition: dispose flash, snap struts to full scale. */
  _finishTransition() {
    for (const flash of this._flashMeshes) {
      if (flash.parent) flash.parent.remove(flash);
      if (flash.geometry) flash.geometry.dispose();
      if (flash.material) flash.material.dispose();
    }
    this._flashMeshes.length = 0;

    for (const strut of this._addedStruts) strut.scale.set(1, 1, 1);
    for (const mount of this._endFaceGroups) mount.scale.set(1, 1, 1);

    this._transitioning = false;
  }

  // ─── Cleanup helpers ────────────────────────────────────────────────────

  /** Remove previously-added tier strut visuals. */
  _removeAddedStruts() {
    for (const s of this._addedStruts) {
      if (s.parent) s.parent.remove(s);
      s.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    this._addedStruts.length = 0;
  }

  /** Remove end-face mount groups. */
  _removeEndFaceGroups() {
    for (const g of this._endFaceGroups) {
      if (g.parent) g.parent.remove(g);
      g.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    this._endFaceGroups.length = 0;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** @returns {string} Current tier key */
  getCurrentTier() {
    return this._currentTier;
  }

  /** Clean up all resources and unsubscribe from events. */
  dispose() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._removeAddedStruts();
    this._removeEndFaceGroups();

    for (const flash of this._flashMeshes) {
      if (flash.parent) flash.parent.remove(flash);
      if (flash.geometry) flash.geometry.dispose();
      if (flash.material) flash.material.dispose();
    }
    this._flashMeshes.length = 0;

    this._scene = null;
    this._player = null;
    this._armManager = null;
    this._enabled = false;
    this._transitioning = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS — singleton + named class
// ═══════════════════════════════════════════════════════════════════════════
export { TierVisualManager };
export const tierVisualManager = new TierVisualManager();
export default tierVisualManager;
