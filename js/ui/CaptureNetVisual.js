/**
 * CaptureNetVisual.js — 3-D renderer for active capture nets.
 * V-8: Epic 10 Capture Net Visual
 *
 * Manages one mesh group per active net, updates geometry / appearance
 * every frame based on the 14-state NetProjectile FSM in CaptureNet.js.
 *
 * Renders:  canister (folded/launching) → spinning disc (flight→capture)
 *           + tether line from strut tip to net position.
 *
 * Gated behind FEATURE_FLAGS.CAPTURE_NET.
 *
 * @module ui/CaptureNetVisual
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** 1 metre in scene units (1 scene unit = 100 km). Same as PlayerSatellite.js */
const M = 1e-5;

const STATES = Constants.CAPTURE_NET.STATES;

// ── Re-usable colour constants ──────────────────────────────────────────
const COL_CANISTER  = 0x556677;
const COL_DISC      = 0x88aacc;
const COL_CONTACT   = 0xffaa00;
const COL_CINCH     = 0x00aaff;
const COL_CAPTURED  = 0x00ff44;
const COL_MISSED    = 0xff4444;
const COL_TETHER    = 0xddddee;

// Scratch vectors (avoid per-frame allocation)
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

// ════════════════════════════════════════════════════════════════════════
// CaptureNetVisual
// ════════════════════════════════════════════════════════════════════════

/**
 * Derive a unique visual key + lookup metadata from an event payload.
 * Daughter-arm nets carry armIndex ≥ 0; mother-pod nets carry podIndex ≥ 0
 * with armIndex absent or -1.
 *
 * @param {object} payload — event payload with armIndex? / podIndex?
 * @returns {{ key: string, armIndex: number, podIndex: number }}
 */
function resolveNetId(payload) {
  const ai = payload.armIndex;
  const pi = payload.podIndex;
  if (ai != null && ai >= 0) return { key: `arm_${ai}`, armIndex: ai, podIndex: -1 };
  if (pi != null && pi >= 0) return { key: `pod_${pi}`, armIndex: -1, podIndex: pi };
  // Fallback — treat as arm 0
  return { key: 'arm_0', armIndex: 0, podIndex: -1 };
}

export class CaptureNetVisual {
  constructor() {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {import('../entities/PlayerSatellite.js').PlayerSatellite|null} */
    this._player = null;
    /** @type {import('../entities/CaptureNet.js').CaptureNetSystem|null} */
    this._captureNetSystem = null;
    /** @type {boolean} */
    this._enabled = false;
    /**
     * Active visual entries keyed by composite string ('arm_0', 'pod_1', etc.)
     * @type {Map<string, {group:THREE.Group, canisterMesh:THREE.Mesh, discMesh:THREE.Mesh, tetherLine:THREE.Line, tetherPositions:Float32Array, armIndex:number, podIndex:number}>}
     */
    this._activeVisuals = new Map();
    /** @type {boolean} */
    this._disposed = false;
    /** @type {Array<{key:string, color:number, timer:number}>} */
    this._flashTimers = [];
    /** @type {Array<{key:string, timer:number, duration:number}>} */
    this._fadeTimers = [];

    // Bound handler refs for EventBus unsubscription
    this._boundNetFired = null;
    this._boundNetCaught = null;
    this._boundNetMiss = null;
    this._boundReelCompleted = null;
    this._boundNetReleased = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise the visual system.  No-ops if CAPTURE_NET flag is false.
   * @param {THREE.Scene} scene
   * @param {object} player   — PlayerSatellite instance
   * @param {object} captureNetSystem — CaptureNetSystem singleton
   */
  init(scene, player, captureNetSystem) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._scene = scene;
    this._player = player;
    this._captureNetSystem = captureNetSystem;
    this._enabled = true;
    this._disposed = false;

    this._boundNetFired      = this._onNetFired.bind(this);
    this._boundNetCaught     = this._onNetCaught.bind(this);
    this._boundNetMiss       = this._onNetMiss.bind(this);
    this._boundReelCompleted = this._onReelCompleted.bind(this);
    this._boundNetReleased   = this._onNetReleased.bind(this);

    eventBus.on(Events.NET_FIRED,          this._boundNetFired);
    eventBus.on(Events.NET_CATCH_SUCCESS,  this._boundNetCaught);
    eventBus.on(Events.NET_CATCH_MISS,     this._boundNetMiss);
    eventBus.on(Events.NET_REEL_COMPLETED, this._boundReelCompleted);
    eventBus.on(Events.NET_RELEASED,       this._boundNetReleased);
  }

  // ── Net lookup helper ──────────────────────────────────────────────────

  /**
   * Look up the active NetProjectile for a visual entry.
   * Uses getActiveNetForArm for daughter arms, getActiveNetForPod for mother pods.
   * @param {number} armIndex
   * @param {number} podIndex
   * @returns {object|null} NetProjectile or null
   * @private
   */
  _getNet(armIndex, podIndex) {
    if (armIndex >= 0) return this._captureNetSystem.getActiveNetForArm(armIndex);
    if (podIndex >= 0) return this._captureNetSystem.getActiveNetForPod(podIndex);
    return null;
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  /** @private */
  _onNetFired(payload) {
    const { key, armIndex, podIndex } = resolveNetId(payload);
    if (this._activeVisuals.has(key)) return; // already tracking
    const net = this._getNet(armIndex, podIndex);
    if (!net) return;
    this._createNetVisual(key, armIndex, podIndex, net);
  }

  /** @private Flash disc green on successful catch. */
  _onNetCaught(payload) {
    const { key } = resolveNetId(payload);
    this._flashTimers.push({ key, color: COL_CAPTURED, timer: 0.5 });
  }

  /** @private Flash disc red, then fade out and remove. */
  _onNetMiss(payload) {
    const { key } = resolveNetId(payload);
    this._flashTimers.push({ key, color: COL_MISSED, timer: 0.3 });
    this._fadeTimers.push({ key, timer: 1.0, duration: 1.0 });
  }

  /** @private */
  _onReelCompleted(payload) {
    const { key } = resolveNetId(payload);
    this._removeNetVisual(key);
  }

  /** @private */
  _onNetReleased(payload) {
    const { key } = resolveNetId(payload);
    this._removeNetVisual(key);
  }

  // ── Visual creation / removal ──────────────────────────────────────────

  /**
   * Create a visual group for one net projectile.
   * @param {string} key            — composite map key ('arm_0', 'pod_1')
   * @param {number} armIndex       — daughter arm index (≥0) or -1
   * @param {number} podIndex       — mother pod index (≥0) or -1
   * @param {object} netProjectile  — NetProjectile instance
   * @private
   */
  _createNetVisual(key, armIndex, podIndex, netProjectile) {
    const group = new THREE.Group();
    group.name = `CaptureNetVis_${key}`;

    // ── Canister (FOLDED / LAUNCHING) ──
    const canGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.08, M * 0.25, 8);
    const canMat = new THREE.MeshStandardMaterial({
      color: COL_CANISTER,
      metalness: 0.6,
      roughness: 0.4,
    });
    const canisterMesh = new THREE.Mesh(canGeo, canMat);
    canisterMesh.name = 'canister';
    group.add(canisterMesh);

    // ── Disc (SPINNING_UP → CAPTURED) ──
    const diameter = netProjectile.netClass.DIAMETER || 8;
    const discGeo = new THREE.CircleGeometry(M * diameter / 2, 16);
    const discMat = new THREE.MeshStandardMaterial({
      color: COL_DISC,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      wireframe: true,
    });
    const discMesh = new THREE.Mesh(discGeo, discMat);
    discMesh.name = 'disc';
    discMesh.visible = false;
    group.add(discMesh);

    // ── Tether line ──
    const tetherPositions = new Float32Array(6); // 2 points × 3 components
    const tetherGeo = new THREE.BufferGeometry();
    tetherGeo.setAttribute('position', new THREE.BufferAttribute(tetherPositions, 3));
    const tetherMat = new THREE.LineBasicMaterial({
      color: COL_TETHER,
      transparent: true,
      opacity: 0.7,
    });
    const tetherLine = new THREE.Line(tetherGeo, tetherMat);
    tetherLine.name = 'tether';
    tetherLine.visible = false;
    tetherLine.frustumCulled = false;
    group.add(tetherLine);

    this._scene.add(group);
    this._activeVisuals.set(key, {
      group,
      canisterMesh,
      discMesh,
      tetherLine,
      tetherPositions,
      armIndex,
      podIndex,
    });
  }

  /**
   * Remove and dispose a visual by its composite key.
   * @param {string} key
   * @private
   */
  _removeNetVisual(key) {
    const vis = this._activeVisuals.get(key);
    if (!vis) return;

    this._scene.remove(vis.group);

    // Dispose geometries + materials
    vis.canisterMesh.geometry.dispose();
    vis.canisterMesh.material.dispose();
    vis.discMesh.geometry.dispose();
    vis.discMesh.material.dispose();
    vis.tetherLine.geometry.dispose();
    vis.tetherLine.material.dispose();

    this._activeVisuals.delete(key);

    // Purge associated timers
    this._flashTimers = this._flashTimers.filter(f => f.key !== key);
    this._fadeTimers  = this._fadeTimers.filter(f => f.key !== key);
  }

  // ── Per-frame update ───────────────────────────────────────────────────

  /**
   * Tick all active net visuals.  Called from the game loop.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._enabled) return;

    // ── Tick flash timers ──
    for (let i = this._flashTimers.length - 1; i >= 0; i--) {
      const f = this._flashTimers[i];
      f.timer -= dt;
      if (f.timer <= 0) {
        this._flashTimers.splice(i, 1);
        // Colour restored via next state-driven update
      } else {
        const vis = this._activeVisuals.get(f.key);
        if (vis) vis.discMesh.material.color.setHex(f.color);
      }
    }

    // ── Tick fade timers ──
    for (let i = this._fadeTimers.length - 1; i >= 0; i--) {
      const f = this._fadeTimers[i];
      f.timer -= dt;
      const vis = this._activeVisuals.get(f.key);
      if (f.timer <= 0) {
        this._fadeTimers.splice(i, 1);
        this._removeNetVisual(f.key);
        continue;
      }
      if (vis) {
        vis.discMesh.material.opacity = Math.max(0, f.timer / f.duration) * 0.6;
      }
    }

    // ── Update each active visual ──
    for (const [key, vis] of this._activeVisuals) {
      const net = this._getNet(vis.armIndex, vis.podIndex);
      if (!net) {
        this._removeNetVisual(key);
        continue;
      }

      const { group, canisterMesh, discMesh, tetherLine, tetherPositions } = vis;
      const state = net.state;

      // ── Position: net.position is in metres → multiply by M ──
      group.position.set(
        net.position.x * M,
        net.position.y * M,
        net.position.z * M,
      );

      // ── State-driven visibility + appearance ──
      const isFlash = this._flashTimers.some(f => f.key === key);

      switch (state) {
        case STATES.FOLDED:
          canisterMesh.visible = true;
          discMesh.visible = false;
          tetherLine.visible = false;
          break;

        case STATES.LAUNCHING:
          canisterMesh.visible = true;
          discMesh.visible = false;
          tetherLine.visible = true;
          break;

        case STATES.SPINNING_UP: {
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          // Scale from 0→1 as spin ramps up
          const spinFrac = net.netClass.SPIN_HZ > 0
            ? Math.min(1, net.spinRate / net.netClass.SPIN_HZ)
            : 1;
          discMesh.scale.setScalar(Math.max(0.05, spinFrac));
          if (!isFlash) discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;
        }

        case STATES.FLIGHT:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.scale.setScalar(1);
          discMesh.rotation.z += net.spinRate * Math.PI * 2 * dt;
          if (!isFlash) discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.CONTACT:
        case STATES.BRAKE:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          if (!isFlash) discMesh.material.color.setHex(COL_CONTACT);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.ENVELOP:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.scale.setScalar(Math.max(0.3, 1.0 - net.tangleQuality * 0.5));
          if (!isFlash) discMesh.material.color.setHex(COL_CONTACT);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.CINCH_CLOSING:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.scale.setScalar(Math.max(0.2, 1.0 - net.tangleQuality * 0.7));
          if (!isFlash) discMesh.material.color.setHex(COL_CINCH);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.SECURE_CHECK:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          // Pulse opacity
          discMesh.material.opacity = 0.4 + 0.3 * Math.sin(Date.now() * 0.01);
          break;

        case STATES.CAPTURED:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          if (!isFlash) discMesh.material.color.setHex(COL_CAPTURED);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.MISSED:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          if (!isFlash) discMesh.material.color.setHex(COL_MISSED);
          // Opacity handled by fade timer
          break;

        case STATES.REELING:
          canisterMesh.visible = false;
          discMesh.visible = net.catchResult === 'success';
          tetherLine.visible = true;
          if (discMesh.visible && !isFlash) {
            discMesh.material.color.setHex(COL_CAPTURED);
          }
          break;

        case STATES.STOWED:
        case STATES.RELEASED:
          this._removeNetVisual(key);
          continue; // skip tether update

        default:
          break;
      }

      // ── Tether update: strut tip (or player origin) → net position ──
      if (tetherLine.visible && this._player) {
        // Daughter arms use strutTipNodes; mother pods fall back to player group position
        if (vis.armIndex >= 0 && this._player.strutTipNodes && this._player.strutTipNodes[vis.armIndex]) {
          this._player.strutTipNodes[vis.armIndex].getWorldPosition(_v3a);
        } else if (this._player.group) {
          // Mother pod: approximate tether origin at player body
          _v3a.copy(this._player.group.position);
        } else if (this._player.getPosition) {
          const pp = this._player.getPosition();
          _v3a.set(pp.x, pp.y, pp.z);
        } else {
          _v3a.set(0, 0, 0);
        }
        _v3b.copy(group.position);

        tetherPositions[0] = _v3a.x;
        tetherPositions[1] = _v3a.y;
        tetherPositions[2] = _v3a.z;
        tetherPositions[3] = _v3b.x;
        tetherPositions[4] = _v3b.y;
        tetherPositions[5] = _v3b.z;
        tetherLine.geometry.attributes.position.needsUpdate = true;
      }
    }
  }

  // ── Disposal ───────────────────────────────────────────────────────────

  /** Clean up all visuals and unsubscribe from events. */
  dispose() {
    // Remove all visuals
    for (const key of [...this._activeVisuals.keys()]) {
      this._removeNetVisual(key);
    }

    // Unsubscribe events
    if (this._boundNetFired)      eventBus.off(Events.NET_FIRED,          this._boundNetFired);
    if (this._boundNetCaught)     eventBus.off(Events.NET_CATCH_SUCCESS,  this._boundNetCaught);
    if (this._boundNetMiss)       eventBus.off(Events.NET_CATCH_MISS,     this._boundNetMiss);
    if (this._boundReelCompleted) eventBus.off(Events.NET_REEL_COMPLETED, this._boundReelCompleted);
    if (this._boundNetReleased)   eventBus.off(Events.NET_RELEASED,       this._boundNetReleased);

    this._boundNetFired = null;
    this._boundNetCaught = null;
    this._boundNetMiss = null;
    this._boundReelCompleted = null;
    this._boundNetReleased = null;

    this._flashTimers = [];
    this._fadeTimers = [];
    this._enabled = false;
    this._disposed = true;
  }
}

/** Singleton CaptureNetVisual instance. */
export const captureNetVisual = new CaptureNetVisual();
export default captureNetVisual;
