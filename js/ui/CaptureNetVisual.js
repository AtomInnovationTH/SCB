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
 * When FEATURE_FLAGS.NET_CEREMONY is ON (Stage 2+), replaces the flat disc
 * with a cone mesh, rim weight spheres, drawstring line, and apex hub.
 *
 * Gated behind FEATURE_FLAGS.CAPTURE_NET.
 *
 * @module ui/CaptureNetVisual
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';

/** 1 metre in scene units (1 scene unit = 100 km). Same as PlayerSatellite.js */
const M = 1e-5;

const STATES = Constants.CAPTURE_NET.STATES;
const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
// Animation needs access to state-duration constants (ENVELOP_TIME etc.) to
// drive ceremony-state visuals from net.stateTimer instead of the broken
// `net.tangleQuality` proxy (which is 0 throughout ENVELOP / CINCH_CLOSING
// and only set on CAPTURED transition).
const CN = Constants.CAPTURE_NET;

// ── Re-usable colour constants ──────────────────────────────────────────
// 2026-05-25 retune: each ceremony FSM state now has a distinct cone hue
// so user can identify what phase they're seeing at a glance. The hue
// progression maps to action energy: blue (calm pre-contact) → yellow
// (touched) → orange (tether locked) → red (wrapping) → magenta
// (drawstring closing) → green (captured). Old COL_CONTACT (orange) was
// shared by CONTACT+BRAKE+ENVELOP — three states one colour — which made
// debugging the broken engulf animation impossible.
const COL_CANISTER  = 0x556677;
const COL_DISC      = 0x88aacc;   // pre-contact (LAUNCHING / SPINNING_UP / FLIGHT)
const COL_CONTACT   = 0xffdd44;   // CONTACT (yellow — "touched")
const COL_BRAKE     = 0xff7700;   // BRAKE (orange — "tether locked")
const COL_ENVELOP   = 0xff3344;   // ENVELOP (red — "wrapping")
const COL_CINCH     = 0xff44dd;   // CINCH_CLOSING (magenta — "drawstring")
const COL_SECURE    = 0xaaff44;   // SECURE_CHECK (yellow-green pulse — "checking grip")
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

    /** @type {boolean} Cached ceremony flag — frozen at construct time (§2.4.1) */
    this._useCeremony = !!Constants.FEATURE_FLAGS.NET_CEREMONY;

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
    if (Constants.FEATURE_FLAGS.NET_CEREMONY) {
      this._createCeremonyVisual(key, armIndex, podIndex, netProjectile);
      return;
    }

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
   * Create the ceremony visual group: cone mesh, rim weights, drawstring, apex hub.
   * Only called when FEATURE_FLAGS.NET_CEREMONY is true.
   * @param {string} key
   * @param {number} armIndex
   * @param {number} podIndex
   * @param {object} netProjectile
   * @private
   */
  _createCeremonyVisual(key, armIndex, podIndex, netProjectile) {
    const group = new THREE.Group();
    group.name = `CaptureNetVis_${key}`;

    // ── Canister (FOLDED / LAUNCHING) — same as flag-OFF ──
    const canGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.08, M * 0.25, 8);
    const canMat = new THREE.MeshStandardMaterial({
      color: COL_CANISTER,
      metalness: 0.6,
      roughness: 0.4,
    });
    const canisterMesh = new THREE.Mesh(canGeo, canMat);
    canisterMesh.name = 'canister';
    group.add(canisterMesh);

    // ── Cone mesh (replaces flat disc) ──
    const diameter = netProjectile.netClass.DIAMETER || 8;
    const mouthR = M * (diameter / 2) * NET_CER.CONE_OPEN_RADIUS_FRAC;
    const coneH  = mouthR * 2 * NET_CER.CONE_LENGTH_FRAC;
    // ConeGeometry: base at y=-h/2, apex at y=+h/2; 16 radial, 4 height, open-ended
    const coneGeo = new THREE.ConeGeometry(mouthR, coneH, 16, 4, true);
    // Rotate so mouth faces -Z (lookAt forward direction) and apex near origin
    // rotateX(PI/2): (x,y,z)→(x,-z,y) → apex at z=+h/2, base at z=-h/2
    coneGeo.rotateX(Math.PI / 2);
    // Translate so apex at origin (z=0) and mouth at z=-coneH
    coneGeo.translate(0, 0, -coneH / 2);
    const coneMat = new THREE.MeshStandardMaterial({
      color: COL_DISC,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      wireframe: true,
    });
    const coneMesh = new THREE.Mesh(coneGeo, coneMat);
    coneMesh.name = 'cone';
    coneMesh.visible = false;
    group.add(coneMesh);

    // ── Rim weight spheres ──
    const weightCount = netProjectile.netClass.RIM_WEIGHT_COUNT || 4;
    const weightGeo = new THREE.SphereGeometry(M * NET_CER.RIM_WEIGHT_RENDER_RADIUS_M, 8, 8);
    const rimWeights = [];
    const rimWeightMats = [];
    for (let i = 0; i < weightCount; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x888888,
        metalness: 0.9,
        roughness: 0.3,
        emissive: new THREE.Color(0x000000),
      });
      const w = new THREE.Mesh(weightGeo, mat);
      w.name = `weight_${i}`;
      w.visible = false;
      rimWeights.push(w);
      rimWeightMats.push(mat);
      group.add(w);
    }

    // ── Drawstring — spoke pattern: apex→w0→apex→w1→…→apex→wN-1→apex→w0 ──
    const dsVertexCount = weightCount * 2 + 2;
    const drawstringPositions = new Float32Array(dsVertexCount * 3);
    const drawstringGeo = new THREE.BufferGeometry();
    drawstringGeo.setAttribute('position', new THREE.BufferAttribute(drawstringPositions, 3));
    const drawstringMat = new THREE.LineBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.8,
    });
    const drawstringLine = new THREE.Line(drawstringGeo, drawstringMat);
    drawstringLine.name = 'drawstring';
    drawstringLine.visible = false;
    drawstringLine.frustumCulled = false;
    group.add(drawstringLine);

    // ── Apex hub — small sphere at tether termination ──
    const apexGeo = new THREE.SphereGeometry(M * 0.05, 8, 8);
    const apexMat = new THREE.MeshStandardMaterial({
      color: 0x665544,
      metalness: 0.7,
      roughness: 0.4,
    });
    const apexHub = new THREE.Mesh(apexGeo, apexMat);
    apexHub.name = 'apexHub';
    apexHub.visible = false;
    group.add(apexHub);

    // ── Tether line (same as flag-OFF path) ──
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
      discMesh: coneMesh,          // alias for flash-timer compat
      coneMesh,
      tetherLine,
      tetherPositions,
      rimWeights,
      rimWeightMats,
      weightGeo,
      drawstringLine,
      drawstringPositions,
      apexHub,
      mouthRadius: mouthR,
      coneHeight: coneH,
      closedRadius: mouthR * NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED,
      weightCount,
      spinAngle: 0,
      armIndex,
      podIndex,
      useCeremony: true,
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

    if (vis.useCeremony) {
      // Ceremony path — cone, weights, drawstring, apex hub
      vis.coneMesh.geometry.dispose();
      vis.coneMesh.material.dispose();
      vis.weightGeo.dispose();
      for (const mat of vis.rimWeightMats) mat.dispose();
      vis.drawstringLine.geometry.dispose();
      vis.drawstringLine.material.dispose();
      vis.apexHub.geometry.dispose();
      vis.apexHub.material.dispose();
    } else {
      // Original path — flat disc
      vis.discMesh.geometry.dispose();
      vis.discMesh.material.dispose();
    }

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

    // Stage 4 (CEREMONY_REDESIGN.md §5, §6 R1): apply ceremony time-dilation to
    // visual dt only. World dt at the caller (main.js → captureNetVisual.update)
    // is unaffected. When the flag is OFF or no ceremony is active,
    // CeremonyTimeScale.get() === 1.0 (short-circuit, no-op multiply).
    const scale = Constants.FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

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

      // ── Ceremony path: separate state handler ──
      if (vis.useCeremony) {
        if (this._updateCeremonyState(key, vis, net, dt, isFlash)) continue;
      } else {

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

      } // end else (non-ceremony)

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

  // ── Ceremony state handler (flag-ON only) ──────────────────────────────

  /**
   * Update ceremony-path visual for one net.
   * @param {string} key — visual map key
   * @param {object} vis — entry from _activeVisuals
   * @param {object} net — NetProjectile
   * @param {number} dt  — seconds
   * @param {boolean} isFlash — true if a flash timer is active for this key
   * @returns {boolean} true if visual was removed (caller should `continue`)
   * @private
   */
  _updateCeremonyState(key, vis, net, dt, isFlash) {
    const { coneMesh, rimWeights, drawstringLine,
            apexHub, mouthRadius, coneHeight, closedRadius,
            weightCount, rimWeightMats, canisterMesh } = vis;
    const state = net.state;

    switch (state) {
      case STATES.FOLDED:
        canisterMesh.visible = true;
        coneMesh.visible = false;
        for (const w of rimWeights) w.visible = false;
        drawstringLine.visible = false;
        apexHub.visible = false;
        vis.tetherLine.visible = false;
        break;

      case STATES.LAUNCHING:
        canisterMesh.visible = true;
        coneMesh.visible = false;
        for (const w of rimWeights) w.visible = false;
        drawstringLine.visible = false;
        apexHub.visible = false;
        vis.tetherLine.visible = true;
        break;

      case STATES.SPINNING_UP: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        const spinFrac = net.netClass.SPIN_HZ > 0
          ? Math.min(1, net.spinRate / net.netClass.SPIN_HZ)
          : 1;

        // Scale cone with spin fraction
        coneMesh.scale.setScalar(Math.max(0.05, spinFrac));
        if (!isFlash) coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Place weights at expanding radius
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        const curR = mouthRadius * spinFrac;
        const curZ = -coneHeight * spinFrac;
        for (let i = 0; i < weightCount; i++) {
          const w = rimWeights[i];
          w.visible = true;
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          w.position.set(curR * Math.cos(angle), curR * Math.sin(angle), curZ);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.FLIGHT:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        coneMesh.scale.setScalar(1);
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        if (!isFlash) coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Place weights at full mouth radius
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            mouthRadius * Math.cos(angle),
            mouthRadius * Math.sin(angle),
            -coneHeight,
          );
          rimWeights[i].visible = true;
        }

        this._updateDrawstring(vis);
        break;

      case STATES.CONTACT:
      case STATES.BRAKE:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        // 2026-05-25: split CONTACT (yellow) from BRAKE (orange) — they were
        // both COL_CONTACT before, making the brake-fired event invisible.
        if (!isFlash) {
          coneMesh.material.color.setHex(
            state === STATES.BRAKE ? COL_BRAKE : COL_CONTACT
          );
        }
        coneMesh.material.opacity = 0.55;

        // Maintain weight positions at mouth radius
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            mouthRadius * Math.cos(angle),
            mouthRadius * Math.sin(angle),
            -coneHeight,
          );
          rimWeights[i].visible = true;
        }

        // On BRAKE: set weight emissive to brake colour (immediate set — animated flash deferred to Stage 3/5)
        if (state === STATES.BRAKE) {
          for (const mat of rimWeightMats) {
            mat.emissive.setHex(NET_CER.RIM_WEIGHT_EMISSIVE_BRAKE);
          }
        }

        this._updateDrawstring(vis);
        break;

      case STATES.ENVELOP: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        if (!isFlash) coneMesh.material.color.setHex(COL_ENVELOP);
        coneMesh.material.opacity = 0.55;
        // Cone scale UNCHANGED — no shrink (replaces old discMesh.scale.setScalar)

        // 2026-05-26 GEOMETRY FIX (Option A — "cinch over debris"):
        // Previously envZ went -coneHeight → 0 (mouth plane → apex plane),
        // i.e. weights RETRACTED toward the daughter, away from the target.
        // The target world-position at contact ≈ net.position + launchDir
        // × (DIAMETER/2) (= -mouthR = -0.5 × D in local z, sitting ~0.4 m
        // SHORT of the mouth plane at -coneH = -0.55 × D). For the bag to
        // physically engulf the target, weights must OVERSHOOT the mouth —
        // Newton's first law during deceleration. New envZ ranges
        // -coneHeight → -2 × coneHeight, sweeping the weights forward past
        // the target and wrapping it inside the closing bag. Drawstring
        // strands (apex → weight) automatically lengthen, reading as
        // bag-cone fabric draping around the target.
        const envProgress = Math.min(1, Math.max(0, net.stateTimer / CN.ENVELOP_TIME));
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        const envZ = -coneHeight * (1 + envProgress);
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            mouthRadius * Math.cos(angle),
            mouthRadius * Math.sin(angle),
            envZ,
          );
          rimWeights[i].visible = true;
        }

        // Keep weight emissive from brake
        for (const mat of rimWeightMats) {
          mat.emissive.setHex(NET_CER.RIM_WEIGHT_EMISSIVE_BRAKE);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.CINCH_CLOSING: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        if (!isFlash) coneMesh.material.color.setHex(COL_CINCH);
        coneMesh.material.opacity = 0.55;

        // 2026-05-25 CRITICAL FIX: was `net.tangleQuality` (=0 throughout this
        // state — see ENVELOP comment). Result: drawstring radius stayed at
        // mouthRadius the entire 2 g of CINCH_CLOSE_TIME, then snapped to the
        // closed radius in a SINGLE FRAME at the CAPTURED transition (when
        // tangleQuality finally got set). That snap is the "cinch happens
        // suddenly" symptom the user reported. Now driven by stateTimer /
        // CINCH_CLOSE_TIME so the ring contracts smoothly from mouthRadius
        // to closedRadius across the camera's CINCH beat.
        // 2026-05-26 GEOMETRY FIX (Option A — "cinch over debris"):
        // Cinch ring center was at z=0 (apex plane), but the target sits at
        // z ≈ -mouthRadius (= -0.5 × D). The drawstring was therefore
        // closing ~coneHeight (4.4 m for LARGE D=8) BEHIND the target, on
        // the daughter side — the "between daughter and debris" symptom
        // the user reported. Cinch ring now contracts at z=-coneHeight
        // (mouth plane), which sits 0.4 m past the target along the launch
        // direction. The closing ring is centered on the debris within the
        // half-thickness of the cone mouth. Drawstring strands from apex
        // (z=0) to the ring at z=-coneHeight render as the long bag-cone
        // strands cinching closed at the debris.
        const cinchProgress = Math.min(1, Math.max(0, net.stateTimer / CN.CINCH_CLOSE_TIME));
        const curR = mouthRadius + (closedRadius - mouthRadius) * cinchProgress;
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            curR * Math.cos(angle),
            curR * Math.sin(angle),
            -coneHeight, // at mouth plane (target sits at z ≈ -mouthRadius, ~0.4 m short of here)
          );
          rimWeights[i].visible = true;
        }

        // Drawstring brightens during cinch
        for (const mat of rimWeightMats) {
          mat.emissive.setHex(NET_CER.RIM_WEIGHT_EMISSIVE_BRAKE);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.SECURE_CHECK:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        // Pulse opacity AND tint yellow-green so user can identify the
        // "checking grip" beat distinctly from CINCH and CAPTURED.
        if (!isFlash) coneMesh.material.color.setHex(COL_SECURE);
        coneMesh.material.opacity = 0.35 + 0.25 * Math.sin(Date.now() * 0.01);
        break;

      case STATES.CAPTURED:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        if (!isFlash) coneMesh.material.color.setHex(COL_CAPTURED);
        coneMesh.material.opacity = 0.55;
        break;

      case STATES.MISSED:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        if (!isFlash) coneMesh.material.color.setHex(COL_MISSED);
        // Opacity handled by fade timer
        break;

      case STATES.REELING:
        canisterMesh.visible = false;
        coneMesh.visible = net.catchResult === 'success';
        vis.tetherLine.visible = true;
        if (coneMesh.visible && !isFlash) {
          coneMesh.material.color.setHex(COL_CAPTURED);
        }
        break;

      case STATES.STOWED:
      case STATES.RELEASED:
        this._removeNetVisual(key);
        return true; // signal caller to continue (skip tether update)

      default:
        break;
    }

    // Orient group so local -Z points along the launch direction (i.e. the
    // mouth/forward end of the cone is at local z = -coneH, the apex is at
    // local z = 0, and rim weights placed at z = -coneH render past the target
    // along launchDir).
    //
    // CRITICAL: THREE.js [`Object3D.lookAt`](https://github.com/mrdoob/three.js/blob/master/src/core/Object3D.js)
    // uses the OPPOSITE convention from [`Camera.lookAt`](https://github.com/mrdoob/three.js/blob/master/src/cameras/Camera.js):
    //   - For Camera / Light:  internal _m1.lookAt(position, target, up)   → local -Z points TOWARD target.
    //   - For Object3D:        internal _m1.lookAt(target, position, up)   → local +Z points TOWARD target.
    // (See three.js Object3D.js, isCamera/isLight branch.)
    //
    // Net group is a plain Group (not Camera). To make local -Z point along
    // launchDir (so existing z = -coneH placements render on the target-far
    // side, as the cone-build comments at line 295 assume), we must pass a
    // lookAt point on the OPPOSITE side of the group — group.position - launchDir × ε.
    // Object3D.lookAt then sets local +Z = -launchDir, hence local -Z = +launchDir,
    // which matches the camera-style convention all the cone/rim/drawstring
    // geometry was written to assume.
    //
    // The historical bug: previous code did `.add(_v3a)` (camera convention),
    // which made local +Z = launchDir and rendered the rim weights, mouth, and
    // cinch ring on the DAUGHTER side of the net center — exactly the
    // "cinch happens between daughter and debris" symptom diagnosed via
    // NET_CINEMATIC_DEBUG instrumentation (see HANDOFF / CAPTURE_NET_QA).
    if (net.launchDirection) {
      _v3a.set(
        net.launchDirection.x * 0.001,
        net.launchDirection.y * 0.001,
        net.launchDirection.z * 0.001,
      );
      _v3b.copy(vis.group.position).sub(_v3a);
      vis.group.lookAt(_v3b);
    }

    return false;
  }

  /**
   * Update drawstring line vertex positions from current rim weight positions.
   * Spoke pattern: apex→w0→apex→w1→…→apex→wN-1→apex→w0.
   * No allocations — writes directly to pre-allocated Float32Array.
   * @param {object} vis — entry from _activeVisuals
   * @private
   */
  _updateDrawstring(vis) {
    const { rimWeights, drawstringPositions, drawstringLine, weightCount } = vis;
    let idx = 0;
    for (let i = 0; i < weightCount; i++) {
      // Apex vertex (origin in local space)
      drawstringPositions[idx++] = 0;
      drawstringPositions[idx++] = 0;
      drawstringPositions[idx++] = 0;
      // Weight vertex
      drawstringPositions[idx++] = rimWeights[i].position.x;
      drawstringPositions[idx++] = rimWeights[i].position.y;
      drawstringPositions[idx++] = rimWeights[i].position.z;
    }
    // Final apex
    drawstringPositions[idx++] = 0;
    drawstringPositions[idx++] = 0;
    drawstringPositions[idx++] = 0;
    // Close to first weight
    drawstringPositions[idx++] = rimWeights[0].position.x;
    drawstringPositions[idx++] = rimWeights[0].position.y;
    drawstringPositions[idx++] = rimWeights[0].position.z;

    drawstringLine.geometry.attributes.position.needsUpdate = true;
  }

  // ── Public getters ─────────────────────────────────────────────────────

  /**
   * Get the apex hub world position for a given net visual key.
   * Returns the group position as fallback when flag is OFF or key not found.
   * Stage 3 camera can use this for tether-attach-point framing.
   * @param {string} key — visual key ('arm_0', 'pod_1', etc.)
   * @returns {THREE.Vector3} scratch vector — caller must copy if persisting
   */
  getTetherAttachPoint(key) {
    const vis = this._activeVisuals.get(key);
    if (!vis) {
      _v3a.set(0, 0, 0);
      return _v3a;
    }
    if (vis.useCeremony && vis.apexHub) {
      vis.apexHub.getWorldPosition(_v3a);
      return _v3a;
    }
    // Flag-OFF: return group position (centre of flat disc)
    _v3a.copy(vis.group.position);
    return _v3a;
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
