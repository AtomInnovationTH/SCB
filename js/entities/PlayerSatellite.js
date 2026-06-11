/**
 * PlayerSatellite.js — The player's ADR (Active Debris Removal) spacecraft
 * (Octopus V5 / Config G core). Detailed cylindrical "barrel" model with
 * subsystems: body-mount thin-film solar cells, deployable ROSA wings,
 * FEEP main + RCS thrusters, EO/IR/LIDAR sensor gimbal, arm collar with
 * hinges and crossbow struts, docking port, and nav lights.
 * @module entities/PlayerSatellite
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';
import { powerDistribution } from '../systems/PowerDistribution.js';
import {
  computeCoM, computeCoMDrift, computeCoMDriftVector,
  getActiveBlocks,
} from '../systems/CoMCalculator.js';
import { composeDockedArmQuat } from './ArmDockBasis.js';
import {
  propagateOrbit,
  orbitToSceneCartesian,
  keplerianToCartesian,
  cartesianToKeplerian,
  orbitToKm,
  kmToScene,
  isInShadow,
  orbitalVelocity,
  atmosphericDrag,
} from './OrbitalMechanics.js';

/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/* ── Preallocated temp objects for strut sweep animation (Epic 10 V-3) ── */
const _strutFrom = new THREE.Vector3(0, -1, 0);
const _strutTo   = new THREE.Vector3();
const _strutQuat = new THREE.Quaternion();
/* ── V-4: Preallocated temps for strut-tip dock offset + arm orientation ── */
const _tipLocal    = new THREE.Vector3();
const _armQuat     = new THREE.Quaternion();
/* Scratch world-space target quat for DOCKING slerp / HOLDING_CATCH snap. */
const _armDockTargetQuat = new THREE.Quaternion();
/* Deterministic docked-arm roll basis now lives in ArmDockBasis.js (shared SSOT
 * with ArmUnit's DOCKING/HOLDING_CATCH self-alignment — see HANDOFF §10 Rule B).
 * `_composeDockedArmQuat` is a thin local alias kept for call-site readability. */
const _composeDockedArmQuat = composeDockedArmQuat;

/** Destructured V5 constants for crossbow recoil & interlock */
const {
  DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  V5_ARM_COUNT, V5_WEAVER_MASS, V5_SPINNER_MASS, ARM_STATES,
} = Constants;

export class PlayerSatellite extends THREE.Group {
  /**
   * @param {THREE.Scene} scene - The Three.js scene to add the satellite to
   */
  constructor(scene) {
    super();
    this.name = 'PlayerSatellite';

    // ========================================================================
    // ORBITAL STATE (Keplerian elements — semiMajorAxis in scene units)
    // ========================================================================
    this.orbit = {
      semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE,
      eccentricity: 0.0001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0,
      argPerigee: 0,
      trueAnomaly: 0,
      meanMotion: 0,
    };

    // Cache for Cartesian state
    this._cartesian = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };

    // ========================================================================
    // RESOURCES
    // ========================================================================
    this.resources = {
      xenon: Constants.XENON_FUEL_MAX,
      coldGas: Constants.COLD_GAS_MAX,
      battery: Constants.BATTERY_MAX,
      solarRate: 0,
      solarPanelHealth: 1.0,
      lithium: 0,
      lithiumMax: Constants.MPD_LITHIUM_CAPACITY,
    };

    // ========================================================================
    // MPD THRUSTER STATE (F16)
    // ========================================================================
    this._hasMPD = false;           // unlocked via shop purchase
    this._mpdCathodeTime = 0;       // cumulative seconds of MPD firing
    this._mpdCathodeLife = Constants.MPD_CATHODE_LIFE || 600; // upgradable via Hardened Cathode
    this._mpdDeltaV = Constants.MPD_DELTA_V || 0.0015; // scene-scale ΔV per tick

    // ========================================================================
    // MPD BURST MODE STATE (S3b)
    // ========================================================================
    this._mpdArmed = false;           // M key toggle
    this._mpdHeat = 0;                // thermal accumulator (0 to MPD_BURST_OVERHEAT_THRESHOLD)
    this._mpdCooldownTimer = 0;       // seconds remaining in forced cooldown (0 = ready)
    this._mpdDegraded = false;        // true when battery < 5% during burst
    this._hasSupercap = false;        // set by Graphene Supercap upgrade

    // Consumption rates
    this._ionThrustXenonRate = 0.02;
    this._ionThrustPowerRate = 5.0;
    this._coldGasRate = 0.5;
    this._basePowerDraw = 0.5;
    this._ionDeltaV = 0.0003;
    this._coldGasDeltaV = 0.002;

    // Base values for upgrade multipliers (so upgrades modify the rate properties
    // that thrustIon()/thrustColdGas() already read directly)
    this._baseIonDeltaV = this._ionDeltaV;
    this._baseIonXenonRate = this._ionThrustXenonRate;
    this._baseColdGasDeltaV = this._coldGasDeltaV;
    this._baseColdGasRate = this._coldGasRate;

    // ========================================================================
    // THRUST INPUT STATE
    // ========================================================================
    this.thrustInput = { x: 0, y: 0, z: 0 };
    this._lastThrustOfflineWarning = 0; // Throttle for power-offline comms warnings

    // Phase 1: RCS fine-positioning velocity (additive to orbital motion)
    this._rcsVelocity = new THREE.Vector3();

    // Phase 1: Thrust direction tracking & cumulative ΔV
    this._deltaVSpent = 0;         // cumulative ΔV spent this mission (km/s game units)
    this._thrustDirection = null;   // 'prograde' | 'retrograde' | 'lateral' | null
    this._lastThrustType = null;    // 'ion' | 'coldgas' | null

    // F14: Throttle level (0.0–1.0, default 1.0 for backward compatibility)
    this.throttleLevel = 1.0;

    // F13: Manual rotation offset (applied on top of velocity-aligned orientation)
    this._manualRotation = new THREE.Quaternion(); // identity = no offset

    // Autopilot flag — suppresses orientation decay when autopilot is steering (Fix 2)
    this.autopilotEngaged = false;

    // Phase 4: Dual-mode fuel system references
    /** @type {import('../systems/ResourceSystem.js').ResourceSystem|null} */
    this._resourceSystem = null;
    /** @type {import('../systems/CargoSystem.js').CargoSystem|null} */
    this._cargoSystem = null;

    // ========================================================================
    // ANIMATION STATE
    // ========================================================================
    this._blinkTimer = 0;
    this._strobeTimer = 0;
    this._lidarPulseTimer = 0;
    this._thrusterGlowTargets = new Map(); // thruster mesh → { glow, plume, outerGlow, intensity }
    this._differentialFireTargets = [0, 0, 0, 0]; // per-nozzle attitude rotation intensity [TOP, BOTTOM, RIGHT, LEFT]
    this._sensorTarget = null; // THREE.Vector3 world position to track
    this._activeThrustDir = { x: 0, y: 0, z: 0 };

    // Tether reel states: 'ready', 'deployed', 'empty' — V5: expanded to 8 reels
    this._tetherStates = Array(V5_ARM_COUNT).fill('ready');
    this._tetherDeployAnim = Array(V5_ARM_COUNT).fill(0); // 0..1 spool animation

    // ========================================================================
    // RCS THRUSTER PUFF POOL STATE
    // ========================================================================
    this._rcsPuffs = [];          // Array of { sprite, startTime, active }
    this._rcsPuffIndex = 0;       // Round-robin pool index
    this._rcsPuffLastFire = {};   // Per-nozzle cooldown timestamps (seconds)

    // ========================================================================
    // EDT — Electrodynamic Tether (Phase 6)
    // ========================================================================
    this._edtDeployed = false;
    this._edtDeployTimer = 0;
    this._edtActive = false;

    // Wire EDT event listener
    eventBus.on(Events.EDT_DEPLOY, () => this.toggleEDT());

    // ========================================================================
    // V5 CROSSBOW STATE
    // ========================================================================
    this.mass = 130;                // kg — mothership mass for recoil calculations
    this.armManager = null;         // Set via setArmManager() for interlock checks
    this._thrusterInterlock = false; // True when back arm blocks FEEP thruster exhaust
    this._plumeBlocked = {};        // C-9: Map<thrusterId, reason> — plume geometry interlock
    this._comCache = null;          // C-9: Cached CoM result from last computation
    this._comDriftM = 0;            // C-9: Cached scalar drift (m) for HUD
    this._comDriftVec = { x: 0, y: 0, z: 0 }; // C-9: Drift vector (actual − balanced) for torque coupling
    this._crossbowAutoRcs = true;   // Auto-compensate crossbow recoil with RCS
    this._frameRecoilDv = 0;        // Accumulated recoil ΔV this frame (for dual-fire tracking)
    this._frameRecoilCount = 0;     // Number of crossbow fires this frame
    this._frameN2Consumed = 0;      // Actual N₂ consumed (kg) this frame for refund on dual-fire
    this._recoilAngularVel = 0;     // C-11: Pending recoil angular velocity (rad/s) for RCS nulling

    // V5: Subscribe to crossbow fire events for recoil handling
    eventBus.on(Events.CROSSBOW_FIRE, (data) => this._applyCrossbowRecoil(data));
    eventBus.on(Events.DUAL_FIRE_RECOIL, (data) => this._applyDualFireRecoil(data));

    // Scan visual feedback — emissive flash on body material
    this._scanFlashTimer = 0;
    eventBus.on(Events.SCAN_INITIATED, () => {
      this._scanFlashTimer = 0.5; // 0.5s flash duration
    });

    // Diagnostic hull outline — visible during close inspection. Two signals
    // drive it; they are INDEPENDENT inputs we OR together (each frame the
    // outline is on if EITHER path reports inspection), with an explicit boolean
    // so they can't desync or flip-flop:
    //   (1) the discrete INSPECTION camera view (bare-I / debris / arm path)
    //       via CAMERA_VIEW_CHANGE, and
    //   (2) the OVERVIEW zoom-driven mothership inspection sub-state, which
    //       keeps the view as ORBIT and signals via INSPECT_HULL_OUTLINE.
    // Previously these were two separate setHullOutlineVisible() calls, so a
    // CAMERA_VIEW_CHANGE to ORBIT fired during the zoom path would clobber the
    // hull-outline signal and make the outline flicker.
    this._hullInspectView = false; // discrete INSPECTION view active?
    this._hullInspectZoom = false; // OVERVIEW zoom sub-state active?
    eventBus.on(Events.CAMERA_VIEW_CHANGE, ({ view } = {}) => {
      this._hullInspectView = (view === 'INSPECTION');
      this.setHullOutlineVisible(this._hullInspectView || this._hullInspectZoom);
    });
    eventBus.on(Events.INSPECT_HULL_OUTLINE, ({ visible } = {}) => {
      this._hullInspectZoom = !!visible;
      this.setHullOutlineVisible(this._hullInspectView || this._hullInspectZoom);
    });

    // ========================================================================
    // BUILD VISUAL MODEL
    // ========================================================================
    this._buildModel();

    // ========================================================================
    // INITIAL POSITION
    // ========================================================================
    this._updateCartesian();
    this._applyPosition();

    scene.add(this);
  }

  // ==========================================================================
  // VISUAL MODEL — V3 Octopus ADR Spacecraft (Octagonal Core)
  // ==========================================================================

  /** @private */
  _buildModel() {
    // Shared materials
    this._matBody = new THREE.MeshStandardMaterial({
      color: 0x5c5c64, metalness: 0.7, roughness: 0.55,
    });
    this._matGoldMLI = new THREE.MeshStandardMaterial({
      // MLI thermal blanket — warm gold foil, shiny so it catches specular
      // glints (real MLI is crinkled, iridescent, not flat matte yellow).
      // Base color is a bright gold (not dark orange) so the foil reads gold
      // under the sun at ANY distance — it must NOT depend on the camera fill
      // light (CameraSystem ~100 m range), otherwise it goes dark-orange far
      // away and only turns gold up close. Low roughness + a lifted emissive
      // warmth keeps it reading as gold on the shadowed side too (the scene
      // has near-zero ambient light).
      color: 0xd6a43e, metalness: 0.85, roughness: 0.28,
      emissive: 0x4a3008, emissiveIntensity: 0.16,
    });
    this._matDark = new THREE.MeshStandardMaterial({
      color: 0x222233, metalness: 0.6, roughness: 0.4,
    });
    // FEEP nozzle material — copper/bronze tint (field-emission emitters use refractory metals)
    this._matFEEP = new THREE.MeshStandardMaterial({
      color: 0x996644, metalness: 0.80, roughness: 0.35,
    });
    // FEEP nozzle interior — bright emissive ion-emitter surface (BackSide rendered)
    // Visually distinct from the copper exterior; emissive modulated by differential firing
    this._matFEEPInner = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.5, roughness: 0.2,
      emissive: 0x334466, emissiveIntensity: 0.3,
      side: THREE.BackSide,
    });
    // RCS attitude thruster nozzles — standard aerospace gray
    this._matRCS = new THREE.MeshStandardMaterial({
      color: 0x555566, metalness: 0.65, roughness: 0.45,
    });

    // --- 1. MAIN BUS — Config G cylindrical barrel (Epic 10 V-1) ---
    this._buildMainBus();

    // --- 1.5. COLLAR RING + HINGE MOUNTS (Epic 10 V-2) ---
    this._buildCollar();

    // --- 1.6. STRUTS + SWEEP PIVOTS (Epic 10 V-3) ---
    this._buildStruts();

    // --- 2. FEEP THRUSTERS (4 main dual-metal FEEP + 8 RCS attitude) — Config G ---
    this._buildThrusters();

    // --- 3. ROSA SOLAR ARRAYS (Epic 10 V-5) ---
    this._buildSolarPanels();

    // --- 4. SENSOR SUITE (front) ---
    this._buildSensors();

    // --- 5. Tether reels + indicators now populated by _buildStruts() (S3.3) ---

    // --- 6. (V3 magnetic ring removed — not in Config G) ---

    // --- 7. DOCKING PORT (rear/front adapter) ---
    this._buildDockingPort();

    // --- 8. NAVIGATION LIGHTS ---
    this._buildNavLights();

    // --- 9. RCS THRUSTER PUFF SPRITES ---
    this._buildRcsPuffPool();
  }

  // --------------------------------------------------------------------------
  // 1. Main Bus — Config G Cylindrical Barrel (Epic 10 V-1)
  // --------------------------------------------------------------------------
  /**
   * @private Carve stow grooves into the barrel by displacing the cylinder's
   * vertices radially inward in a band at each strut azimuth.
   *
   * The body CylinderGeometry is built Y-axis aligned and the mesh is later
   * rotated rotation.x=π/2 (geom-Y → world-Z). So a groove at ship azimuth θ and
   * barrel-Z range [z0,z1] maps to:
   *   geometry azimuth  φ = -θ          (atan2(geomZ, geomX))
   *   geometry axial    y ∈ [z0, z1]    (geom-Y == world-Z after the rotation)
   *
   * Each groove uses smooth cosine falloff across its angular width and a
   * smooth ramp at its axial ends, so the dip is a rounded depression rather
   * than a hard-edged trench. Vertices are pushed inward up to `depth`; the
   * normals are recomputed so lighting reads the groove correctly.
   * @param {THREE.BufferGeometry} geo  the body CylinderGeometry (Y-axis)
   * @param {number} barrelR
   * @param {number} barrelH
   */
  _carveStowGrooves(geo, barrelR, barrelH) {
    const azimuths = (Constants.ARM_LADDER?.Y0_QUAD?.azimuths ?? [60, 120, 240, 300])
      .map(d => d * Math.PI / 180);

    // Daughter body specs [x, y, z] in metres. The pocket cradles the body
    // cross-section (x≈y); z is the body length. Source: Constants.WEAVER_BODY /
    // SPINNER_BODY. Arm type alternates around the ring by index (mirrors
    // ArmManager._buildDockPositions: i%2===0 → weaver, else spinner), so the
    // groove at azimuths[i] is sized for that daughter.
    const WEAVER_BODY  = Constants.WEAVER_BODY  ?? [0.2, 0.2, 0.3];
    const SPINNER_BODY = Constants.SPINNER_BODY ?? [0.1, 0.1, 0.15];
    const barrelR_m = (Constants.OCTOPUS_V5?.COLLAR_RADIUS ?? 0.40); // metres

    /**
     * Build the groove profile (stow channel + cradle pocket) for one daughter.
     * @param {number[]} body  daughter [x,y,z] in metres
     * @returns {Array<{zc:number,hl:number,ha:number,d:number}>}
     */
    const profileFor = (body) => {
      const crossW = body[0];                 // body width (m), cross-section
      const bodyLen = body[2];                // body length (m), along barrel Z
      // Pocket angular half-width so the arc spans ~1.3× the body width (a little
      // clearance around the cradled body): arcWidth = barrelR * 2*ha = 1.3*crossW.
      const pocketHa = Math.min(0.45, (1.3 * crossW) / (2 * barrelR_m));
      // Pocket depth scales with daughter size and is capped at 50% of the barrel
      // radius. The largest daughter (Weaver, crossW 0.20) hits the 50% cap; the
      // smaller Spinner (crossW 0.10) scales down proportionally. Convert the
      // metre depth to scene units (×M).
      const maxDepth_m = barrelR_m * 0.50;            // 0.20 m = 50% of 0.40 m radius
      const WEAVER_CROSS = (Constants.WEAVER_BODY ?? [0.2])[0];  // reference (largest)
      const pocketDepth = Math.min(maxDepth_m, maxDepth_m * (crossW / WEAVER_CROSS)) * M;
      // Pocket axial half-length ≈ body length / 2 plus a little clearance.
      const pocketHl = (bodyLen * 0.6) * M;
      // Stow channel: a shallower, narrower groove the folded strut lies in,
      // running forward of the pocket. Scaled down from the pocket.
      const chanHa = pocketHa * 0.55;
      const chanDepth = pocketDepth * 0.55;
      return [
        { zc: barrelH * 0.08,  hl: barrelH * 0.38, ha: chanHa,   d: chanDepth },  // stow channel
        { zc: -barrelH * 0.34, hl: pocketHl,       ha: pocketHa, d: pocketDepth }, // cradle pocket
      ];
    };

    const weaverProfile  = profileFor(WEAVER_BODY);
    const spinnerProfile = profileFor(SPINNER_BODY);

    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    const smooth = (t) => { // smoothstep 0..1
      t = Math.max(0, Math.min(1, t));
      return t * t * (3 - 2 * t);
    };
    const angDist = (a, b) => {
      let d = Math.abs(a - b) % (Math.PI * 2);
      return d > Math.PI ? Math.PI * 2 - d : d;
    };

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const r = Math.hypot(v.x, v.z);
      if (r < 1e-9) continue;              // skip axis-cap centre (open cyl: none)
      const phi = Math.atan2(v.z, v.x);    // geometry azimuth around Y
      const y = v.y;                       // geometry axial == world barrel-Z

      let maxDepth = 0;
      for (let a = 0; a < azimuths.length; a++) {
        const gPhi = -azimuths[a];         // ship azimuth → geometry azimuth
        // Match ArmManager ring assignment: even index = weaver, odd = spinner.
        const grooves = (a % 2 === 0) ? weaverProfile : spinnerProfile;
        for (const g of grooves) {
          const dAng = angDist(phi, gPhi);
          if (dAng > g.ha) continue;
          const dAx = Math.abs(y - g.zc);
          if (dAx > g.hl) continue;
          // Cosine falloff across width, smooth ramp over the last 25% of length.
          const wAng = 0.5 + 0.5 * Math.cos((dAng / g.ha) * Math.PI);
          const wAx  = smooth((g.hl - dAx) / (g.hl * 0.25));
          maxDepth = Math.max(maxDepth, g.d * wAng * wAx);
        }
      }
      if (maxDepth > 0) {
        const nr = (r - maxDepth) / r;     // pull inward toward the axis
        v.x *= nr; v.z *= nr;
        pos.setXYZ(i, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** @private */
  _buildMainBus() {
    // ── Config G Barrel — cylindrical, 0.4m radius × 2.0m height ──
    // Reference: Constants.OCTOPUS_V5 + ARM_PIVOT_ANALYSIS.md §10.11
    const V5 = Constants.OCTOPUS_V5;
    const barrelR = V5.COLLAR_RADIUS * M;  // 0.40m → M * 0.40
    const barrelH = V5.CORE_LENGTH * M;    // 2.00m → M * 2.00

    // Main body — smooth cylinder (16 radial segments). The body shell IS the
    // base MLI (Multi-Layer Insulation) thermal blanket: gold foil is the
    // default surface that wraps the whole bus for thermal control. Everything
    // else — solar panels, thrusters, sensors, collar, docking port, channels —
    // sits ON TOP of this blanket (higher renderOrder / larger radius), exactly
    // as cut-outs/mounts sit on a real satellite's MLI.
    // §2-followup (round 11): body uses 64 radial segments (was 16) so stow
    // grooves can be carved into the hull as real vertex displacement. The
    // grooves dip the wall inward in a band at each strut azimuth — a true
    // conforming depression with no separate, coincident groove mesh.
    const bodyGeo = new THREE.CylinderGeometry(barrelR, barrelR, barrelH, 64, 24, true);
    this._carveStowGrooves(bodyGeo, barrelR, barrelH);
    this._matBody = this._matGoldMLI.clone();   // body skin = MLI blanket (gold)
    this.body = new THREE.Mesh(bodyGeo, this._matBody);
    this.body.rotation.x = Math.PI / 2; // Align Y-cylinder to Z-forward
    this.body.name = 'Barrel_ConfigG';
    this.body.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE; // FIX_PLAN §2
    this.add(this.body);

    // Diagnostic hull edge-outline (2026-06-03) — shown only in the INSPECT
    // camera view to give a "technical scan" read without a full scene
    // wireframe. EdgesGeometry on the open 16-seg barrel yields the axial seams
    // + rim circles (clean silhouette). Hidden by default; toggled via
    // setHullOutlineVisible() from the CAMERA_VIEW_CHANGE listener below.
    const INS = Constants.INSPECTION || {};
    const outlineEdges = new THREE.EdgesGeometry(bodyGeo, INS.HULL_OUTLINE_THRESHOLD_DEG ?? 20);
    this._hullOutline = new THREE.LineSegments(
      outlineEdges,
      new THREE.LineBasicMaterial({
        color: INS.HULL_OUTLINE_COLOR ?? 0x00ffcc,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this._hullOutline.rotation.x = Math.PI / 2; // match this.body orientation
    this._hullOutline.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // draw on top
    this._hullOutline.visible = false;
    this.add(this._hullOutline);

    // Body-mount GaAs solar cells (610W per ARM_PIVOT_ANALYSIS §10.15 —
    // supplements the deployable ROSA wings).
    //
    // REAL-BUS INTEGRATION: body-mounted cells on real spacecraft are FLAT rigid
    // sub-panels tiled onto the structure's facets — not a curved film. The
    // barrel is a 16-gon, so we mount one flat PV sub-panel per facet (22.5°),
    // tangent to the barrel ON TOP of the MLI blanket, but ONLY on facets that
    // fall in the clear sectors between the stowed struts ([60,120,240,300]°)
    // and clear of the ROSA wing roots at 0°/180°. Each panel carries the dark
    // GaAs cell texture (crisp rectangular cells when the player zooms to
    // inspect). Cells occupy only the central z-band; the MLI blanket (= the
    // body skin itself) shows through everywhere else.

    // PV rows along the barrel length. The satellite is solar-constrained
    // (2240 W solar vs an 8 kW distributable budget + 600 Wh battery), so body
    // cells are maximized: a tall CENTRAL row plus a shorter FORWARD and AFT row
    // filling the end bands that were previously bare MLI. All rows live only on
    // the clear inter-strut facets (off the struts and ROSA roots).
    // §2-followup (round 13): pulled the fore/aft rows INWARD and shortened them
    // so they no longer run into the end-mounted hardware (collar ring at the
    // +Z end, FEEP/RCS thrusters + docking port at the −Z end) or the carved
    // daughter pockets near the aft end. endZ 0.36→0.30, endH 0.16→0.12.
    const centralH = barrelH * 0.46;          // central PV row height (z)
    const endH     = barrelH * 0.12;          // forward/aft PV row height (shortened)
    const endZ     = barrelH * 0.30;          // |z| centre of the end rows (pulled in)
    const cellBandH = centralH;               // (kept for MLI seam placement below)
    const barrelFacets = 16;                  // matches the barrel shell segment count
    const facetStep = (Math.PI * 2) / barrelFacets; // 22.5°
    const facetWidth = 2 * (barrelR * 1.006) * Math.tan(facetStep / 2); // chord of one facet

    const barrelCellTex = getSolarCellTexture();
    const makeRowMat = (texRows) => {
      let tx = null;
      if (barrelCellTex) {
        tx = barrelCellTex.clone();
        tx.needsUpdate = true;
        tx.repeat.set(1, texRows);   // ~one cell-tile across a facet, N rows down
      }
      return new THREE.MeshStandardMaterial({
        color: tx ? 0xffffff : 0x0a1133, // tint comes from the map when present
        map: tx || null,
        emissiveMap: tx || null,
        metalness: 0.5, roughness: 0.5,
        emissive: 0x0b1030, emissiveIntensity: 0.18,
        side: THREE.FrontSide,
        // §2-followup (round 5): barrel PV panels are flat DECALS tangent to the
        // body at 1.006× radius — only ~0.6% proud, so they z-fought the gold
        // MLI shell at some zooms under logarithmicDepthBuffer. Don't write depth
        // and rely on renderOrder (DETAIL > body OPAQUE) so each panel always
        // paints on the body it sits on, with no depth tie. depthTest stays on so
        // the far side of the barrel still occludes panels behind it.
        depthWrite: false,
      });
    };
    // PV rows: { z-centre, height, texture rows }. Three rows: central + 2 ends.
    const pvRows = [
      { z: 0,      h: centralH, mat: makeRowMat(3) },
      { z: endZ,   h: endH,     mat: makeRowMat(1) },
      { z: -endZ,  h: endH,     mat: makeRowMat(1), aft: true },
    ];
    // Scan-flash drives every PV-row material.
    this._cellSkinMats = pvRows.map(r => r.mat);

    // Bare-MLI half-window reserved around each strut; cells avoid these and
    // the ROSA roots at 0°/180°.
    // §2-followup (round 13): the central/fore rows keep the original ±18° strut
    // keep-out (they sit away from the daughter, which stows AFT). The AFT row
    // gets a much wider ±30° keep-out so no aft cell overlaps a carved daughter
    // pocket or a stowed daughter, and all end rows were pulled inward + shortened
    // (endZ/endH above) so they clear the collar (+Z) and thruster/dock (−Z)
    // hardware near the barrel ends.
    const strutAz = Constants.ARM_LADDER.Y0_QUAD.azimuths.map(d => d * Math.PI / 180);
    const rosaAz = [0, Math.PI];
    const strutKeep    = 18 * Math.PI / 180;  // ±18° clear of each strut (side/central/fore rows)
    const strutKeepAft = 30 * Math.PI / 180;  // ±30° clear of each strut for the AFT row (pocket/daughter)
    const rosaKeep  = 8 * Math.PI / 180;   // ±8° clear of each ROSA root
    const angDist = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };

    let _panelN = 0;
    for (let f = 0; f < barrelFacets; f++) {
      const az = f * facetStep + facetStep / 2;  // facet centre azimuth
      // Skip facets near a strut or a ROSA root.
      if (strutAz.some(s => angDist(az, s) < strutKeep)) continue;
      if (rosaAz.some(rz => angDist(az, rz) < rosaKeep)) continue;

      const rr = barrelR * 1.025;
      const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, radial).normalize();
      const _m4 = new THREE.Matrix4().makeBasis(right, up, radial);

      for (const row of pvRows) {
        // The aft row sits over the daughter-pocket band — give it a wider strut
        // keep-out so no aft cell overlaps a pocket or a stowed daughter.
        if (row.aft && strutAz.some(s => angDist(az, s) < strutKeepAft)) continue;

        const panelGeo = new THREE.PlaneGeometry(facetWidth * 0.92, row.h);
        const panel = new THREE.Mesh(panelGeo, row.mat);
        // Flat panel tangent to the barrel, just proud of the surface.
        panel.position.set(Math.cos(az) * rr, Math.sin(az) * rr, row.z);
        panel.quaternion.setFromRotationMatrix(_m4);
        panel.name = `BarrelSolarPanel_${_panelN++}`;
        panel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // over body
        this.add(panel);
      }
    }

    // §2-followup (round 15): a few EXTRA cells in the clear gaps BETWEEN stowed
    // daughters near the barrel ends, without disturbing the rows above. The
    // daughters stow at the strut azimuths [60,120,240,300]; the widest clear
    // azimuth windows sit at 90° and 270° (between a Weaver, ±18.6°, and a
    // Spinner, ±9.3°). At the fore/aft end Z-bands those windows are clear of
    // daughters, struts, the RCS thrusters (45/135/225/315°) and the collar, so
    // one cell fits in each — reclaiming otherwise-bare MLI. (The strobe lights
    // at 90/270 sit at the equator Z=0, not at these end bands, so no conflict.)
    const gapMat = makeRowMat(1);
    this._cellSkinMats.push(gapMat);
    const gapCellW = facetWidth * 0.75;   // half-angle ≈ 8.5° → ~2.9° margin to the Weaver
    for (const gapAzDeg of [90, 270]) {
      const gapAz = gapAzDeg * Math.PI / 180;
      const radial = new THREE.Vector3(Math.cos(gapAz), Math.sin(gapAz), 0);
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, radial).normalize();
      const gM4 = new THREE.Matrix4().makeBasis(right, up, radial);
      for (const z of [endZ, -endZ]) {  // fore (+) and aft (−) end bands
        const rr = barrelR * 1.025;
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(gapCellW, endH), gapMat);
        panel.position.set(Math.cos(gapAz) * rr, Math.sin(gapAz) * rr, z);
        panel.quaternion.setFromRotationMatrix(gM4);
        panel.name = `BarrelSolarPanel_gap_${gapAzDeg}_${z > 0 ? 'F' : 'A'}`;
        panel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        this.add(panel);
      }
    }

    // MLI quilting seams — the body shell IS the gold blanket, so instead of
    // redundant solid gold bands we add thin darker tape/seam rings that divide
    // the blanket into quilted sections (the characteristic MLI look). Purely
    // visual definition over the gold body.
    const seamGeo = new THREE.TorusGeometry(barrelR * 1.005, M * 0.005, 4, 24);
    const seamMat = new THREE.MeshStandardMaterial({
      color: 0x8a6d24, metalness: 0.7, roughness: 0.5,  // darker gold tape
      // §2-followup (round 5): MLI seam rings are DECALS on the gold body.
      // polygonOffset(-0.5) shimmered under logarithmicDepthBuffer; use
      // depthWrite:false + renderOrder so the seam always paints on the body.
      // The body shell still writes depth, so the seam's far arc is correctly
      // occluded (depthTest stays on).
      depthWrite: false,
    });
    // Seams at the cell-band edges and in the two bare-MLI end sections.
    for (const z of [-barrelH * 0.40, -cellBandH * 0.5, cellBandH * 0.5, barrelH * 0.40]) {
      const seam = new THREE.Mesh(seamGeo, seamMat);
      seam.position.z = z;
      seam.rotation.x = Math.PI / 2;
      seam.name = 'MLI_Seam';
      seam.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(seam);
    }


    // Panel-line accent rings (thin dark seam grooves) marking the cell-band
    // seams: one at centre, two at the cell/MLI boundaries.
    // §2-followup (round 8): the accent ring (was 1.007×, tube ±0.006 → radial
    // 1.001–1.013) RADIALLY OVERLAPPED the MLI seam ring (1.005×, ±0.005 →
    // 1.000–1.010) AND shared its z at z=±cellBandH*0.5 → two coincident tori
    // z-fighting each other. Push the accent out to 1.02× (radial 1.014–1.026,
    // fully clear of the seam) and nudge its z bands off the seam bands so the
    // two ring sets never coincide.
    const lineGeo = new THREE.TorusGeometry(barrelR * 1.02, M * 0.006, 4, 24);
    const lineMat = this._matDark.clone();
    lineMat.depthWrite = false;
    const accentZNudge = barrelH * 0.015; // shift accent bands off the seam bands
    for (const z of [-(cellBandH * 0.5) + accentZNudge, 0, cellBandH * 0.5 - accentZNudge]) {
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.position.z = z;
      line.rotation.x = Math.PI / 2;
      line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(line);
    }

    // Front viewport/window — laser aperture (20cm Cassegrain)
    // FIX_PLAN §2-followup (round 3): viewport was at z=barrelH*0.5 − 0.05 =
    // 0.95, i.e. 5 CM BEHIND the front cap at z=1.0 — polygonOffset cannot
    // cover a 5 cm gap in depth, so the cap was occluding the aperture.
    // Moved viewport to z=barrelH*0.5 + 0.001 (1 mm IN FRONT of cap) and
    // apertureRing to +0.002 m. They now sit flush on the cap face, fully
    // visible, with renderOrder layering keeping the gold rim on top.
    const viewportGeo = new THREE.CircleGeometry(M * 0.12, 8);
    const viewportMat = new THREE.MeshStandardMaterial({
      color: 0x112244, metalness: 0.3, roughness: 0.2,
      emissive: 0x1133aa, emissiveIntensity: 0.4,
    });
    this.viewport = new THREE.Mesh(viewportGeo, viewportMat);
    // §2-followup (round 8): was +0.001·M (1 mm) in front of the cap — the disc
    // (r 0.12) overlaps the cap (r 0.40) in screen space, and 1 mm is below the
    // log depth buffer's reliable separation → z-fight on the front face. Pushed
    // to +0.008·M (8 mm) for a decisive, zoom-independent standoff.
    this.viewport.position.set(0, M * 0.2, barrelH * 0.5 + M * 0.008);
    this.viewport.rotation.x = -0.2;
    this.viewport.name = 'LaserAperture';
    this.viewport.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2-followup
    this.add(this.viewport);

    // Laser aperture ring (gold, forward-facing)
    const apertureRingGeo = new THREE.RingGeometry(M * 0.10, M * 0.14, 8);
    const apertureRingMat = this._matGoldMLI.clone();
    const apertureRing = new THREE.Mesh(apertureRingGeo, apertureRingMat);
    // §2-followup (round 8): +0.012·M (12 mm), 4 mm proud of the viewport so the
    // gold rim sits clearly in front of the aperture glass.
    apertureRing.position.set(0, M * 0.2, barrelH * 0.5 + M * 0.012);
    apertureRing.rotation.x = -0.2;
    apertureRing.name = 'LaserRing';
    apertureRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;  // FIX_PLAN §2-followup
    this.add(apertureRing);

    // End caps
    // FIX_PLAN §2-followup (round 3): removed polygonOffset from cap material
    // — bus is openEnded so there's no built-in cap to z-fight with; the
    // offset was also tying with viewport's offset (both -2,-2) which caused
    // the aperture occlusion. Cap now renders as plain SPACECRAFT_OPAQUE so
    // any DETAIL-tagged mesh in front (viewport, ring) wins cleanly.
    const capGeo = new THREE.CircleGeometry(barrelR, 16);
    // End caps are structural plates (optics bench forward, thruster deck aft),
    // not blanket — keep them dark metallic, distinct from the gold MLI body.
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x4a4a52, metalness: 0.7, roughness: 0.5,
    });
    const frontCap = new THREE.Mesh(capGeo, capMat);
    frontCap.position.z = barrelH * 0.5;
    frontCap.name = 'FrontCap_ConfigG';
    frontCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;      // FIX_PLAN §2-followup (round 3)
    this.add(frontCap);
    const rearCap = new THREE.Mesh(capGeo, capMat);
    rearCap.position.z = -barrelH * 0.5;
    rearCap.rotation.y = Math.PI;
    rearCap.name = 'RearCap_ConfigG';
    rearCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;       // FIX_PLAN §2-followup (round 3)
    this.add(rearCap);

    // ── V-11: Stowage grooves are carved into the BODY mesh itself ──
    // §2-followup (round 11): a true inset arc would be hidden behind the smooth
    // (thin, open) body wall, so the groove is now part of the hull geometry —
    // see _buildMainBus where the body cylinder's vertices are displaced inward
    // in a band at each strut azimuth (_carveStowGrooves). That gives a real
    // conforming depression with zero coincident geometry. Here we only add the
    // pyro-pin launch locks at the groove lips.
    const channelTier = Constants.ARM_LADDER.Y0_QUAD;

    for (const azDeg of channelTier.azimuths) {
      const azRad = azDeg * Math.PI / 180;

      // ── Pyro-pin launch lock — small retention cylinder at the groove lip ──
      const pyroGeo = new THREE.CylinderGeometry(M * 0.006, M * 0.006, M * 0.025, 4);
      const pyroMat = new THREE.MeshStandardMaterial({
        color: 0xcc4400, metalness: 0.6, roughness: 0.4,
      });
      const pyro = new THREE.Mesh(pyroGeo, pyroMat);
      pyro.position.set(
        Math.cos(azRad) * barrelR * 1.02,
        Math.sin(azRad) * barrelR * 1.02,
        -barrelH * 0.21,
      );
      const radialUp = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      pyro.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), radialUp);
      pyro.name = `PyroPin_${azDeg}`;
      this.add(pyro);
    }

    // (V3 docking cavities removed — Config G uses collar-mounted struts)
    this._dockingCavities = [];
  }

  /**
   * @private — Helper: creates A-frame bracket 2D Shape for ExtrudeGeometry.
   * Topology-optimized profile with rounded apex, tapered web, gusset fillets,
   * and oval lightening hole. See EPIC10_DEEP_ANALYSIS.md §13.1.2.
   * @returns {THREE.Shape}
   */
  _aframeShape() {
    const W  = M * 0.025;  // half-width at base (50 mm total)
    const H  = M * 0.040;  // total height base→apex (40 mm)
    const FH = M * 0.012;  // flange height (12 mm)
    const AW = M * 0.010;  // half-width at apex (20 mm total)
    const R  = M * 0.008;  // apex fillet radius

    const shape = new THREE.Shape();
    // Bottom-left of mounting flange
    shape.moveTo(-W, 0);
    // Left flange edge up
    shape.lineTo(-W, FH);
    // Left web taper — bezier from flange top to apex
    shape.bezierCurveTo(
      -W, FH + M * 0.010,    // CP1: slight outward bulge (gusset fillet)
      -AW - R, H - R,        // CP2: approach apex tangent
      -AW, H,                // End: apex left edge
    );
    // Rounded apex arc (over pin bore)
    shape.bezierCurveTo(
      -AW + R * 0.5, H + R * 0.4,  // CP1
       AW - R * 0.5, H + R * 0.4,  // CP2
       AW, H,                       // End: apex right edge
    );
    // Right web taper (mirror of left)
    shape.bezierCurveTo(
       AW + R, H - R,
       W, FH + M * 0.010,
       W, FH,
    );
    // Right flange edge down + close
    shape.lineTo(W, 0);
    shape.lineTo(-W, 0);

    // Lightening hole — oval cutout in web center (~30 % mass removal)
    const hole = new THREE.Path();
    hole.ellipse(0, M * 0.022, M * 0.007, M * 0.005, 0, Math.PI * 2, false, 0);
    shape.holes.push(hole);

    return shape;
  }

  /**
   * @private — Epic 10 S3.1: Collar ring + Double-A clevis hinge assemblies.
   *
   * Implements EPIC10_DEEP_ANALYSIS.md §13.1 — topology-optimized A-frame brackets,
   * Vespel bushings, brake discs, Ti bolt details, collar flange ring, and bolt circle.
   * All shared geometries are created once and reused via mesh cloning.
   *
   * PRESERVED: this.hingeMounts[], this.hingeLEDs[] (used by postArmUpdate).
   */
  _buildCollar() {
    const V5 = Constants.OCTOPUS_V5;
    const collarY = V5.COLLAR_Y * M;          // 0.90 m → ship-frame Z offset
    const collarR = V5.COLLAR_RADIUS * M;     // 0.40 m → torus major radius
    const tier = Constants.ARM_LADDER.Y0_QUAD; // { azimuths: [60, 120, 240, 300] }
    const _yUpCollar = new THREE.Vector3(0, 1, 0);  // reusable Y-up for quaternion ops

    // ── Materials (§13.1.1 Material Selection Table) ─────────────────────
    const collarMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,   // 7075-T6 clear-anodized
    });
    const aframeMat = new THREE.MeshStandardMaterial({
      color: 0x9090a8, metalness: 0.72, roughness: 0.30,   // 6061-T6 CNC
    });
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xaabbcc, metalness: 0.85, roughness: 0.15,   // 17-4PH stainless
    });
    const bushingMat = new THREE.MeshStandardMaterial({
      color: 0x8b6914, metalness: 0.15, roughness: 0.70,   // Vespel SP-1
    });
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x555566, metalness: 0.70, roughness: 0.35,   // 440C stainless
    });
    const boltMat = new THREE.MeshStandardMaterial({
      color: 0x99aabb, metalness: 0.80, roughness: 0.20,   // Ti-6Al-4V
    });
    const seatMat = new THREE.MeshStandardMaterial({
      color: 0x777788, metalness: 0.70, roughness: 0.32,   // barrel seat ring
    });

    // ── Component A: Collar Ring (enhanced) ──────────────────────────────
    // FIX_PLAN §2-followup: all three rings (collarRing, flangeRing, seatRing)
    // were coplanar at z=collarY with overlapping radial extents:
    //   collarRing  major 0.40 ± 0.015 → covers 0.385–0.415
    //   flangeRing  major 0.388 ± 0.006 → covers 0.382–0.394
    //   seatRing    major 0.402 ± 0.008 → covers 0.394–0.410
    // → seatRing radially overlaps collarRing (0.394–0.410 ⊂ 0.385–0.415).
    // §2-followup (round 8): the original ±2 mm z-stagger was SMALLER than the
    // rings' own tube radii (collar ±0.015, seat ±0.008), so at the overlapping
    // radius their tubes still intersected in z → residual z-fight under the log
    // depth buffer. Widened the stagger to ±0.025·M (25 mm) — larger than the
    // sum of the half-tube-thicknesses (0.015+0.008) — so the tubes are fully
    // separated in z at every zoom.
    const collarGeo = new THREE.TorusGeometry(collarR, M * 0.015, 8, 32);
    this.collarRing = new THREE.Mesh(collarGeo, collarMat);
    this.collarRing.rotation.x = Math.PI / 2;   // torus plane ⊥ barrel Z
    this.collarRing.position.z = collarY;
    this.collarRing.name = 'CollarRing';
    this.collarRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2-followup
    this.add(this.collarRing);

    // Inner flange ring (collar-to-barrel shelf) — pushed 25 mm aft
    const flangeRingGeo = new THREE.TorusGeometry(collarR - M * 0.012, M * 0.006, 4, 32);
    const flangeRing = new THREE.Mesh(flangeRingGeo, collarMat);
    flangeRing.rotation.x = Math.PI / 2;
    flangeRing.position.z = collarY - M * 0.025;                            // §2-followup (round 8)
    flangeRing.name = 'CollarFlangeRing';
    flangeRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;      // FIX_PLAN §2-followup
    this.add(flangeRing);

    // Barrel seat ring (raised interface ring on barrel skin) — pushed 25 mm fore
    const seatRingGeo = new THREE.TorusGeometry(collarR + M * 0.002, M * 0.008, 4, 32);
    const seatRing = new THREE.Mesh(seatRingGeo, seatMat);
    seatRing.rotation.x = Math.PI / 2;
    seatRing.position.z = collarY + M * 0.025;                              // §2-followup (round 8)
    seatRing.name = 'BarrelSeatRing';
    seatRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;        // FIX_PLAN §2-followup
    this.add(seatRing);

    // 12× flange bolts (Ti M5, collar-to-barrel, 30° intervals on inner ring)
    const flangeBoltGeo = new THREE.CylinderGeometry(
      M * 0.004, M * 0.004, M * 0.005, 6,
    );
    const flangeR = collarR - M * 0.012;        // bolt circle radius = inner flange
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const bolt = new THREE.Mesh(flangeBoltGeo, boltMat);
      const bx = Math.cos(a) * flangeR;
      const by = Math.sin(a) * flangeR;
      bolt.position.set(bx, by, collarY);
      // Orient bolt head radially outward (cylinder Y → radial)
      const radBolt = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      bolt.quaternion.setFromUnitVectors(_yUpCollar, radBolt);
      bolt.name = `FlangeBolt_${i}`;
      this.add(bolt);
    }

    // ── Shared hinge geometries (§13.1.5, create once, clone per hinge) ──
    const aframeGeo = new THREE.ExtrudeGeometry(this._aframeShape(), {
      depth:          M * 0.008,    // 8 mm plate thickness
      bevelEnabled:   true,
      bevelThickness: M * 0.001,    // 1 mm chamfer
      bevelSize:      M * 0.001,
      bevelSegments:  1,            // single chamfer (machined look)
      curveSegments:  8,            // bezier smoothness
    });
    aframeGeo.center();             // origin at bracket centroid

    const pinGeo     = new THREE.CylinderGeometry(M * 0.005, M * 0.005, M * 0.070, 8);
    const clipGeo    = new THREE.TorusGeometry(M * 0.007, M * 0.0015, 4, 8);
    const bushingGeo = new THREE.TorusGeometry(M * 0.008, M * 0.003, 6, 8);
    const brakeGeo   = new THREE.CylinderGeometry(M * 0.015, M * 0.015, M * 0.003, 12);
    const mountBoltGeo = new THREE.CylinderGeometry(M * 0.003, M * 0.003, M * 0.004, 6);
    const ledGeo     = new THREE.SphereGeometry(M * 0.01, 4, 4);

    // ── Per-hinge Double-A clevis assemblies ─────────────────────────────
    this.hingeMounts = [];
    this.hingeLEDs   = [];

    for (const azDeg of tier.azimuths) {
      const azRad   = azDeg * Math.PI / 180;
      const cx      = Math.cos(azRad) * collarR;
      const cy      = Math.sin(azRad) * collarR;
      const radial  = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
      const pinQuat = new THREE.Quaternion().setFromUnitVectors(_yUpCollar, tangent);

      // ── A-frame brackets (×2 per hinge, straddling strut root) ──
      // Offset ±19 mm along tangent (gap = 38 mm, clears 25 mm strut + bushings)
      // Orientation: shape +Y → radial, extrude +Z → tangent×side, shape +X → barrel Z
      // FIX_PLAN §2-followup (round 3): hinge cluster (brackets, mount bolts,
      // bushings, pin, c-clips, brake disc) sits ON the collar ring at z=0.90
      // with overlapping radial extents → multiple z-fights between bracket
      // body and collar/seat ring torus surfaces. Tag every part DETAIL so
      // they render after the ring stack and win the depth ties cleanly.
      for (const side of [-1, 1]) {
        const bracket = new THREE.Mesh(aframeGeo, aframeMat);
        // Position: on collar surface, offset tangentially, centered at half bracket height
        bracket.position.set(
          cx + radial.x * M * 0.020 + tangent.x * M * 0.019 * side,
          cy + radial.y * M * 0.020 + tangent.y * M * 0.019 * side,
          collarY,
        );
        // Build rotation: localX→barrelZ×side, localY→radial, localZ→tangent×side
        // Both axes flip together to keep the basis right-handed (det = +1).
        // Shape is X-symmetric so flipping local X has no visual effect.
        const basis = new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 0, side),                   // local X → barrel axis (×side)
          radial,                                          // local Y → radial out
          tangent.clone().multiplyScalar(side),            // local Z → tangent×side
        );
        bracket.setRotationFromMatrix(basis);
        bracket.name = `AFrame_${azDeg}_${side > 0 ? 'L' : 'R'}`;
        bracket.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;       // FIX_PLAN §2-followup (round 3)
        this.add(bracket);

        // ── Mounting bolts (×2 per bracket, at flange base ±18 mm along barrel Z) ──
        for (const boltSide of [-1, 1]) {
          const mb = new THREE.Mesh(mountBoltGeo, boltMat);
          mb.position.set(
            cx + tangent.x * M * 0.019 * side + radial.x * M * 0.002,
            cy + tangent.y * M * 0.019 * side + radial.y * M * 0.002,
            collarY + M * 0.018 * boltSide,
          );
          mb.quaternion.setFromUnitVectors(_yUpCollar, radial);  // bolt head outward
          mb.name = `MountBolt_${azDeg}_${side > 0 ? 'L' : 'R'}_${boltSide}`;
          mb.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;          // FIX_PLAN §2-followup (round 3)
          this.add(mb);
        }

        // ── Vespel bushing (×1 per bracket, pressed into pin bore at apex) ──
        const bushing = new THREE.Mesh(bushingGeo, bushingMat);
        bushing.position.set(
          cx + radial.x * M * 0.040 + tangent.x * M * 0.019 * side,
          cy + radial.y * M * 0.040 + tangent.y * M * 0.019 * side,
          collarY,
        );
        bushing.quaternion.copy(pinQuat);   // ring axis along tangent (around pin)
        bushing.name = `Bushing_${azDeg}_${side > 0 ? 'L' : 'R'}`;
        bushing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;       // FIX_PLAN §2-followup (round 3)
        this.add(bushing);
      }

      // ── Pivot pin (17-4PH, ∅10 mm × 70 mm, through both A-frame bores) ──
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(
        cx + radial.x * M * 0.040,
        cy + radial.y * M * 0.040,
        collarY,
      );
      pin.quaternion.copy(pinQuat);
      pin.name = `HingePin_${azDeg}`;
      pin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;             // FIX_PLAN §2-followup (round 3)
      this.add(pin);
      this.hingeMounts.push(pin);           // preserve hingeMounts[] reference

      // ── C-clip retainers (×2, snap rings on pin ends, 5 mm exposed) ──
      for (const side of [-1, 1]) {
        const clip = new THREE.Mesh(clipGeo, pinMat);
        clip.position.set(
          cx + radial.x * M * 0.040 + tangent.x * M * 0.033 * side,
          cy + radial.y * M * 0.040 + tangent.y * M * 0.033 * side,
          collarY,
        );
        clip.quaternion.copy(pinQuat);
        clip.name = `CClip_${azDeg}_${side > 0 ? 'L' : 'R'}`;
        clip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;          // FIX_PLAN §2-followup (round 3)
        this.add(clip);
      }

      // ── Brake disc (440C, centered on pin between A-frames) ──
      const disc = new THREE.Mesh(brakeGeo, brakeMat);
      disc.position.set(
        cx + radial.x * M * 0.040,
        cy + radial.y * M * 0.040,
        collarY,
      );
      disc.quaternion.copy(pinQuat);
      disc.name = `BrakeDisc_${azDeg}`;
      disc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;            // FIX_PLAN §2-followup (round 3)
      this.add(disc);

      // ── LED indicator (forward of outboard A-frame, per §13.1.1) ──
      const ledMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(cx, cy, collarY + M * 0.03);
      led.name = `HingeLED_${azDeg}`;
      led.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;           // FIX_PLAN §2-followup (round 3)
      this.add(led);
      this.hingeLEDs.push(led);             // preserve hingeLEDs[] for postArmUpdate
    }
  }

  // --------------------------------------------------------------------------
  // 1.6. Struts — Animated sweep arms (Epic 10 V-3)
  // --------------------------------------------------------------------------

  /**
   * @private — Epic 10 V-3: Build animated strut pivots at each hinge mount.
   *
   * Each strut extends from the collar hinge and sweeps 0–π driven by
   * {@link ArmUnit.getAimAlpha}. A tip node at the far end serves as the
   * attachment point for daughter arms (V-4).
   *
   * Scene hierarchy per arm:
   * ```
   *   PlayerSatellite (ship group)
   *     └─ StrutPivot_i (THREE.Group) — at hinge, rotates for sweep
   *          └─ Strut_i (Mesh)       — cylinder, top = pivot
   *          └─ StrutTip_i (Group)   — far end, daughter-arm dock
   * ```
   */
  _buildStruts() {
    const V5 = Constants.OCTOPUS_V5;
    const strutLen = V5.STRUT_LENGTH * M;         // 1.60 m → scene
    const strutR   = (V5.STRUT_TUBE_OD / 2) * M;  // 0.025 m → scene
    const collarY  = V5.COLLAR_Y * M;
    const collarR  = V5.COLLAR_RADIUS * M;
    const tier     = Constants.ARM_LADDER.Y0_QUAD;

    // V-4: Cache strut length for dynamic dock-offset computation in _updateStruts
    this._strutLen = strutLen;

    // Shared geometry + material (one per satellite, 4 struts share)
    const strutGeo = new THREE.CylinderGeometry(strutR, strutR, strutLen, 12);
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, metalness: 0.15, roughness: 0.65,  // CFRP T800/M21
    });

    // ── Rib ring collars (field-joint detail) ──
    // FIX_PLAN §2-followup: bumped 1.15→1.22 so torus inner edge clears strut
    // surface (was strutR*1.15 - 0.003 ≈ strutR*1.03, only ~0.7 mm gap → z-fight).
    const ribGeo = new THREE.TorusGeometry(strutR * 1.22, M * 0.003, 4, 12);   // FIX_PLAN §2-followup
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // machined 6061-T6
    });

    // ── Root joint collar (clevis fork fitting at hinge end) ──
    // FIX_PLAN §2-followup: rootCollar cylinder at strutR*1.20 (radius 0.030)
    // sits at the pivot point on the bus surface, where it crosses the body
    // collar/seat rings. §2-followup (round 5) replaced the old polygonOffset
    // depth bias with a real outboard standoff (see ROOT_COLLAR_STANDOFF below).
    const ROOT_COLLAR_LEN = M * 0.025;          // cylinder length (half = inner-face offset)
    // Forward reach of the body collar cluster toward the strut, measured from
    // the hinge plane (collarY). The collarRing (tube radius 0.015 at z=collarY)
    // dominates; seat/flange rings sit within it. Keep in sync with _buildCollar.
    const COLLAR_RING_REACH = M * 0.015;
    const STANDOFF_MARGIN   = M * 0.004;        // clearance so metal never grazes the ring
    // Distance the collar centre must sit outboard (-Y) of the pivot so its
    // inner face clears the ring cluster: half-length + ring reach + margin.
    const ROOT_COLLAR_STANDOFF = ROOT_COLLAR_LEN * 0.5 + COLLAR_RING_REACH + STANDOFF_MARGIN;
    const rootCollarGeo = new THREE.CylinderGeometry(
      strutR * 1.20, strutR * 1.20, ROOT_COLLAR_LEN, 12
    );
    const rootCollarMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,  // 7075-T6
      // §2-followup (round 5): polygonOffset(-2,-2) removed. The root collar is
      // solid metal interpenetrating the body-frame collar/seat rings, and
      // polygonOffset is the LEAST reliable here under logarithmicDepthBuffer
      // (it biased two solids in different transform frames). Replaced with a
      // real geometric standoff (see rootCollar.position.y below) so the collar
      // metal physically clears the ring surfaces at every zoom.
    });

    // ── Tip joint collar (dock fitting at daughter-arm end) ──
    const tipCollarGeo = new THREE.CylinderGeometry(
      strutR * 1.10, strutR * 1.10, M * 0.020, 12
    );
    const tipCollarMat = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // 6061-T6
    });

    // ── S3.3: Reel cartridge shared geometry + materials ──
    const housingGeo = new THREE.CylinderGeometry(M * 0.055, M * 0.055, M * 0.065, 8, 1, true);
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x505868, metalness: 0.40, roughness: 0.50,  // hard-anodized 6061-T6
    });
    const drumGeo = new THREE.CylinderGeometry(M * 0.045, M * 0.045, M * 0.055, 8);
    const drumMat = new THREE.MeshStandardMaterial({
      color: 0xddddee, metalness: 0.20, roughness: 0.60,  // Dyneema SK78 T0
    });
    const ledGeo = new THREE.PlaneGeometry(M * 0.008, M * 0.008);
    const ledMatBase = new THREE.MeshBasicMaterial({
      color: 0x00ff44, side: THREE.DoubleSide,  // green = STOWED
    });

    // ── S3.3: Cable harness (Line geometry, simplified from TubeGeometry) ──
    // §2-followup (round 8): was strutR+0.005 = 0.030, which put the cable line
    // right on the rib-ring tube (centre 0.0305, outer 0.0335) → the 1px line
    // z-fought the ring surface where it crossed each ring. Route it just
    // OUTSIDE the rib-ring outer edge so it rides proud of the rings with a real
    // gap. The P-clips inherit this offset, so cable + clips stay aligned.
    const cableOffset = strutR * 1.22 + M * 0.006;  // ~clear of rib-ring outer (0.0335)
    const cableVerts = new Float32Array([
      cableOffset, -M * 0.015, 0,                       // root collar exit
      cableOffset, -strutLen * 0.25, 0,                  // clip 1
      cableOffset, -strutLen * 0.50, 0,                  // clip 2
      cableOffset, -strutLen * 0.75, 0,                  // clip 3
      cableOffset, -strutLen * 0.85 + M * 0.0325, 0,    // reel housing entry
    ]);
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute('position', new THREE.BufferAttribute(cableVerts, 3));
    const cableMat = new THREE.LineBasicMaterial({ color: 0x555566 });

    // ── S3.3: P-clip shared geometry (reuses ribMat from S3.2) ──
    const clipGeo = new THREE.BoxGeometry(M * 0.012, M * 0.008, M * 0.006);

    // ── S3.4: Crossbow spring mechanism shared geometry + materials ──
    const springHousingGeo = new THREE.CylinderGeometry(
      M * 0.030, M * 0.030, M * 0.060, 8, 1, true   // open-ended, reveals coil
    );
    const springRingGeo = new THREE.TorusGeometry(M * 0.018, M * 0.003, 3, 6);
    const springMat = new THREE.MeshStandardMaterial({
      color: 0x889999, metalness: 0.82, roughness: 0.28,  // maraging steel C-300
    });
    const guideLen = strutLen * 0.05;  // 5% of strut = 80mm (housing to tip)
    const guideGeo = new THREE.BoxGeometry(M * 0.005, guideLen, M * 0.005);

    this.strutPivots   = [];   // THREE.Group — pivot at hinge
    this.strutMeshes   = [];   // THREE.Mesh  — the thin rod
    this.strutTipNodes = [];   // THREE.Group — tip attachment for V-4
    this.tetherReels   = [];   // THREE.Group[] — S3.3 reel cartridge per strut
    this._tetherIndicators = []; // THREE.Mesh[] — S3.3 LED per reel

    /** @type {Array<{pivotGroup: THREE.Group, strut: THREE.Mesh, tipNode: THREE.Group, azRad: number}>} */
    this.strutGroups = [];

    tier.azimuths.forEach((azDeg, i) => {
      const azRad = azDeg * Math.PI / 180;

      // ── Pivot group at hinge point on collar ──
      const pivotGroup = new THREE.Group();
      pivotGroup.position.set(
        Math.cos(azRad) * collarR,
        Math.sin(azRad) * collarR,
        collarY,
      );
      pivotGroup.name = `StrutPivot_${i}`;

      // ── Strut mesh — CylinderGeometry default is Y-axis aligned.
      //    Offset so the pivot point = top end of the cylinder. ──
      const strut = new THREE.Mesh(strutGeo, strutMat);
      strut.position.y = -strutLen / 2;   // hang from pivot
      strut.name = `Strut_${i}`;
      strut.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;   // FIX_PLAN §2-followup
      pivotGroup.add(strut);

      // ── Tip node at far end of strut (daughter-arm dock in V-4) ──
      const tipNode = new THREE.Group();
      tipNode.position.y = -strutLen;
      tipNode.name = `StrutTip_${i}`;
      pivotGroup.add(tipNode);

      // ── S3.3: Reel cartridge (3-child group, replaces placeholder reel) ──
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.name = `ReelHousing_${i}`;
      const drum = new THREE.Mesh(drumGeo, drumMat);
      drum.name = `ReelDrum_${i}`;
      const led = new THREE.Mesh(ledGeo, ledMatBase.clone());
      led.position.set(0, M * 0.034, M * 0.056);  // forward face of housing
      led.rotation.x = Math.PI / 2;                // face outward
      led.name = `ReelLED_${i}`;

      const reelCartridge = new THREE.Group();
      reelCartridge.add(housing);    // children[0] — housing shell
      reelCartridge.add(drum);       // children[1] — spool drum (keyed for rotation)
      reelCartridge.add(led);        // children[2] — status LED
      reelCartridge.position.y = -strutLen * 0.85;
      reelCartridge.name = `ReelCartridge_${i}`;
      pivotGroup.add(reelCartridge);

      this.tetherReels.push(reelCartridge);
      this._tetherIndicators.push(led);

      // ── S3.3: Cable harness line (root collar → rib rings → reel entry) ──
      const cable = new THREE.Line(cableGeo, cableMat);
      cable.name = `CableHarness_${i}`;
      pivotGroup.add(cable);

      // ── S3.3: P-clips at rib ring positions ──
      // §2-followup (round 8): the clips were at the EXACT same Y as the rib
      // rings (-strutLen*{0.25,0.50,0.75}), and the clip box (centred at radius
      // cableOffset≈0.030, extent ±0.006 → 0.024–0.036) sits INSIDE the rib-ring
      // torus radial span (0.0275–0.0335) at that Y → interpenetrating coincident
      // geometry that z-fought on the +X side. Offset each clip a few mm along Y
      // off the ring plane so the box and torus no longer share a plane. (A clip
      // clamping the cable just below its rib ring is physically correct.)
      const CLIP_Y_OFFSET = M * 0.012;
      for (const frac of [0.25, 0.50, 0.75]) {
        const clip = new THREE.Mesh(clipGeo, ribMat);
        clip.position.set(cableOffset, -strutLen * frac - CLIP_Y_OFFSET, 0);
        clip.name = `PClip_${i}_${frac * 100}`;
        clip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
        pivotGroup.add(clip);
      }

      // ── S3.4: Crossbow spring mechanism (4-child group, replaces SpringMount) ──
      const springGroup = new THREE.Group();
      const springHousing = new THREE.Mesh(springHousingGeo, housingMat);
      springHousing.name = `SpringHousing_${i}`;
      springGroup.add(springHousing);
      const springCoil = new THREE.Mesh(springRingGeo, springMat);
      springCoil.rotation.x = Math.PI / 2;
      springCoil.name = `SpringCoil_${i}`;
      springGroup.add(springCoil);
      const railOff = M * 0.012;
      const railL = new THREE.Mesh(guideGeo, housingMat);
      railL.position.set(-railOff, -strutLen * 0.025, 0);
      railL.name = `GuideRail_${i}_L`;
      springGroup.add(railL);
      const railR = new THREE.Mesh(guideGeo, housingMat);
      railR.position.set(+railOff, -strutLen * 0.025, 0);
      railR.name = `GuideRail_${i}_R`;
      springGroup.add(railR);
      springGroup.position.y = -strutLen * 0.95;
      springGroup.name = `CrossbowSpring_${i}`;
      pivotGroup.add(springGroup);

      // ── Rib ring collars at 25%, 50%, 75% of strut length ──
      for (const frac of [0.25, 0.50, 0.75]) {
        const ring = new THREE.Mesh(ribGeo, ribMat);
        ring.position.y = -strutLen * frac;
        ring.rotation.x = Math.PI / 2;   // torus plane ⊥ strut Y-axis
        ring.name = `RibRing_${i}_${frac * 100}`;
        ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
        pivotGroup.add(ring);
      }

      // ── Root joint collar (hinge end) ──
      const rootCollar = new THREE.Mesh(rootCollarGeo, rootCollarMat);
      // §2-followup (round 5): seat the collar outboard along the strut (-Y) by
      // a standoff DERIVED from the ring cluster's reach + the collar's own
      // half-length (see ROOT_COLLAR_STANDOFF above), so its inner face clears
      // the body collar/seat rings geometrically — log-depth-buffer-safe and
      // self-adjusting if the ring/collar dimensions change. Replaces both the
      // old polygonOffset bias and the earlier hand-picked 6mm guess.
      rootCollar.position.y = -ROOT_COLLAR_STANDOFF;
      rootCollar.name = `RootCollar_${i}`;
      rootCollar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
      pivotGroup.add(rootCollar);

      // ── Tip joint collar (daughter dock end) ──
      const tipCollar = new THREE.Mesh(tipCollarGeo, tipCollarMat);
      tipCollar.position.y = -strutLen + M * 0.010;  // at strut tip
      tipCollar.name = `TipCollar_${i}`;
      tipCollar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
      pivotGroup.add(tipCollar);

      // ── Default orientation: α = π/2  →  strut points radially outward ──
      //    Rotation maps local -Y to the radial direction (cosθ, sinθ, 0).
      //    Uses setFromUnitVectors for exact alignment (same as _updateStruts).
      const radialDir = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const baseQuat = new THREE.Quaternion();
      baseQuat.setFromUnitVectors(new THREE.Vector3(0, -1, 0), radialDir);
      pivotGroup.setRotationFromQuaternion(baseQuat);

      this.add(pivotGroup);

      // Store references
      this.strutPivots.push(pivotGroup);
      this.strutMeshes.push(strut);
      this.strutTipNodes.push(tipNode);
      this.strutGroups.push({ pivotGroup, strut, tipNode, azRad, baseQuat, strutDir: new THREE.Vector3() });
    });
  }

  // --------------------------------------------------------------------------
  // 2. Thrusters
  // --------------------------------------------------------------------------
  /** @private — Config G FEEP thruster array + RCS attitude thrusters */
  _buildThrusters() {
    this.mainThrusters = [];
    this.mainThrusterPlumes = [];
    this.attitudeThrusters = [];
    this.attitudeThrusterPlumes = [];

    // Config G main FEEP nozzle — smaller proportions for 0.4m barrel
    const nozzleGeo = new THREE.CylinderGeometry(M * 0.03, M * 0.06, M * 0.15, 6, 1, true);

    // FEEP plume — silvery-blue (indium/cesium field-emission, distinct from Hall-effect blue)
    const plumeMat = new THREE.MeshBasicMaterial({
      color: 0x99bbdd, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    // Map thruster index → Constants.THRUSTERS id (for interlock visual)
    const thrusterIds = ['HT_TOP', 'HT_BOTTOM', 'HT_RIGHT', 'HT_LEFT'];

    // 4 main FEEP thrusters at aft face, cross pattern (Config G barrel)
    const mainPositions = [
      { x: 0, y: M * 0.2 },  // top
      { x: 0, y: -M * 0.2 }, // bottom
      { x: M * 0.2, y: 0 },  // right
      { x: -M * 0.2, y: 0 }, // left
    ];

    mainPositions.forEach((pos, i) => {
      const thruster = new THREE.Mesh(nozzleGeo, this._matFEEP);
      thruster.position.set(pos.x, pos.y, -M * 1.0);
      thruster.rotation.x = Math.PI / 2;
      thruster.name = `MainFEEP_${i}`;
      thruster._thrusterId = thrusterIds[i]; // for interlock visual lookup
      this.add(thruster);
      this.mainThrusters.push(thruster);

      // Inner liner — BackSide-rendered interior surface, distinct from copper
      // exterior.
      // §2-followup (round 8): the liner used the SAME nozzleGeo as the thruster
      // with zero offset — a coincident shell (exactly the daughter cell-skin
      // bug). Under logarithmicDepthBuffer two coincident surfaces z-fight
      // regardless of depth flags. Give the liner its own geometry at 0.97× the
      // nozzle radius so it is a genuine interior wall with a real ~1.8mm gap,
      // never coincident with the outer nozzle.
      const linerGeo = new THREE.CylinderGeometry(M * 0.03 * 0.97, M * 0.06 * 0.97, M * 0.15, 6, 1, true);
      const innerLiner = new THREE.Mesh(linerGeo, this._matFEEPInner.clone());
      innerLiner.name = `FEEPInner_${i}`;
      innerLiner.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      thruster.add(innerLiner);

      // FIX_PLAN §2 — Mounting boss (ring around nozzle throat)
      // Parent thruster has rotation.x=π/2 mapping local +Y → world +Z, so
      // boss.position.y is the axis aligned with the nozzle, and boss cylinder
      // geometry (along local Y) auto-aligns with world Z (no extra rotation).
      const bossGeo = new THREE.CylinderGeometry(M * 0.07, M * 0.07, M * 0.03, 8);
      const bossMat = new THREE.MeshStandardMaterial({
        color: 0x444455, metalness: 0.7, roughness: 0.3,
      });
      const boss = new THREE.Mesh(bossGeo, bossMat);
      // Place at nozzle throat (world Δz = +0.075M from thruster centre at world -M*1.0)
      boss.position.y = M * 0.075;
      boss.name = 'FEEP_Boss';
      boss.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2
      thruster.add(boss);

      // FIX_PLAN §2 — Grid disc (ion accelerator grid recessed inside nozzle exit)
      // Same parent-rotation accounting: use local Y axis for the nozzle direction.
      const gridDiscGeo = new THREE.CircleGeometry(M * 0.025, 8);
      const gridDiscMat = new THREE.MeshBasicMaterial({
        color: 0x667788, wireframe: true, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const gridDisc = new THREE.Mesh(gridDiscGeo, gridDiscMat);
      // Place 5mm inside nozzle exit (world z = -M*1.005, exit at world z = -M*1.075)
      gridDisc.position.y = -M * 0.005;
      // Disc default normal is local +Z = world -Y; DoubleSide keeps it visible
      // from outside the nozzle without further rotation.
      gridDisc.name = 'FEEP_GridDisc';
      gridDisc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT; // FIX_PLAN §2
      thruster.add(gridDisc);

      // FEEP nozzle glow ring (sized to nozzle aperture)
      const glowGeo = new THREE.RingGeometry(M * 0.02, M * 0.055, 6);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x99bbdd, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(pos.x, pos.y, -M * 1.075);
      glow.name = `MainFEEPGlow_${i}`;
      glow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2
      this.add(glow);

      // FEEP plume cone (shorter, tighter than Hall-effect)
      const plumeGeo = new THREE.ConeGeometry(M * 0.08, M * 0.3, 6, 1, true);
      const plume = new THREE.Mesh(plumeGeo, plumeMat.clone());
      plume.position.set(pos.x, pos.y, -M * 1.2);
      plume.rotation.x = -Math.PI / 2;
      plume.name = `MainFEEPPlume_${i}`;
      plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2
      plume.visible = false;
      this.add(plume);
      this.mainThrusterPlumes.push(plume);

      // Outer glow halo — larger, softer cone for volumetric plume effect
      const outerGlowGeo = new THREE.ConeGeometry(M * 0.14, M * 0.45, 8, 1, true);
      const outerGlowMat = new THREE.MeshBasicMaterial({
        color: 0xaaccee, transparent: true, opacity: 0.0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
      outerGlow.position.set(pos.x, pos.y, -M * 1.25);
      outerGlow.rotation.x = -Math.PI / 2;
      outerGlow.name = `MainFEEPOuterGlow_${i}`;
      outerGlow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2
      outerGlow.visible = false;
      this.add(outerGlow);

      this._thrusterGlowTargets.set(thruster, { glow, plume, outerGlow, innerLiner, intensity: 0 });
    });

    // 8 RCS attitude thrusters (2 per quadrant, Config G barrel radius)
    const attitudeNozzleGeo = new THREE.CylinderGeometry(M * 0.02, M * 0.035, M * 0.08, 4, 1, true);
    const attPlumeGeo = new THREE.ConeGeometry(M * 0.04, M * 0.12, 4, 1, true);

    for (let q = 0; q < 4; q++) {
      const angle = (q * Math.PI / 2) + Math.PI / 4;
      for (let j = 0; j < 2; j++) {
        const zOff = j === 0 ? M * 0.6 : -M * 0.6;
        const x = Math.cos(angle) * M * 0.42;
        const y = Math.sin(angle) * M * 0.42;

        const att = new THREE.Mesh(attitudeNozzleGeo, this._matRCS);
        att.position.set(x, y, zOff);
        // Orient radially outward
        att.lookAt(x * 2, y * 2, zOff);
        att.name = `RCSThruster_${q}_${j}`;
        this.add(att);
        this.attitudeThrusters.push(att);

        // RCS plume
        const attPlume = new THREE.Mesh(attPlumeGeo, plumeMat.clone());
        const outDir = new THREE.Vector3(x, y, 0).normalize();
        attPlume.position.set(
          x + outDir.x * M * 0.1,
          y + outDir.y * M * 0.1,
          zOff
        );
        attPlume.lookAt(x + outDir.x * 2, y + outDir.y * 2, zOff);
        attPlume.rotateX(Math.PI / 2);
        attPlume.name = `RCSPlume_${q}_${j}`;
        attPlume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // additive/transparent — sort after solid geometry
        attPlume.visible = false;
        this.add(attPlume);
        this.attitudeThrusterPlumes.push(attPlume);
      }
    }
  }

  // --------------------------------------------------------------------------
  // 3. Solar Panels
  // --------------------------------------------------------------------------
  /**
   * @private — Epic 10 V-5: ROSA (Roll-Out Solar Array) panels.
   *
   * Replaces V3-era accordion wings with two compact ROSA panels at
   * 0° and 180° azimuths (±X from barrel centre).
   *
   * Scene hierarchy per wing:
   * ```
   *   panelRightPivot (Group — sun-tracking rotation)
   *     ├─ _rosaPanelWrapper1 (Group — scale.x drives roll-out)
   *     │    ├─ ROSA_Panel_Front_0deg (ShapeGeometry — FrontSide dark cell surface)
   *     │    ├─ ROSA_Panel_Back_0deg  (ShapeGeometry — BackSide Kapton substrate)
   *     │    ├─ ROSA_GoldEdge_0deg    (LineSegments — gold anodized frame)
   *     │    └─ ROSA_Grid_0deg        (PlaneGeometry — wireframe overlay)
   *     └─ ROSA_Roll_0deg             (CylinderGeometry — stowed roll)
   * ```
   */
  _buildSolarPanels() {
    const V5      = Constants.OCTOPUS_V5;
    const rosaW   = V5.ROSA_WIDTH * M;       // 1.0 m → scene
    const rosaL   = V5.ROSA_LENGTH * M;      // 2.0 m → scene
    const barrelR = V5.COLLAR_RADIUS * M;    // 0.4 m → scene
    const chamfer = V5.ROSA_CHAMFER * M;     // 0.30 m → scene

    // ── Materials ──────────────────────────────────────────────
    const panelMatFront = new THREE.MeshStandardMaterial({
      color: 0x0a1133, metalness: 0.4, roughness: 0.5,
      side: THREE.FrontSide,
      emissive: 0x0a0a40, emissiveIntensity: 0.15,
    });
    const panelMatBack = new THREE.MeshStandardMaterial({
      color: 0xccccdd, metalness: 0.3, roughness: 0.4,
      side: THREE.BackSide,
      emissive: 0xccccdd, emissiveIntensity: 0.4,
    });
    // Grid overlay: ShaderMaterial with manual back-face discard.
    // Wireframe (GL_LINES) ignores face-culling, so gl_FrontFacing doesn't
    // work for lines. Instead we compute the view-dot-normal per fragment
    // and discard when negative — hides the grid from behind the panel.
    const gridMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        varying vec3 vViewPos;
        varying vec3 vNorm;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mv.xyz;
          vNorm = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vViewPos;
        varying vec3 vNorm;
        void main() {
          if (dot(normalize(vViewPos), vNorm) < 0.0) discard;
          gl_FragColor = vec4(0.133, 0.267, 0.667, 0.3);
        }
      `,
      wireframe: true,
      transparent: true,
      depthWrite: false,
      // §2-followup (round 6): the grid is a wireframe DECAL sitting ~sub-mm over
      // the panel face. With depthTest on, that tiny fixed z-gap is unreliable
      // under logarithmicDepthBuffer → the grid shimmered against the panel.
      // The fragment shader already discards back-facing fragments (the dot test
      // above), so we can safely skip the depth test entirely: the grid then
      // always paints cleanly on the camera-facing panel with NO depth tie, and
      // never shows through from behind. renderOrder keeps it above the panel.
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const rollMat = new THREE.MeshStandardMaterial({
      color: 0x333344, metalness: 0.5, roughness: 0.4,
    });

    // ── Chamfered panel shapes (local XY, rotated to XZ via wrapper) ──
    // Panel 1 (+X): shape spans [0, rosaW] × [-rosaL/2, rosaL/2]
    // Bottom corners (outboard tips) are chamfered.
    const shape1 = new THREE.Shape();
    shape1.moveTo(chamfer, -rosaL / 2);
    shape1.lineTo(rosaW - chamfer, -rosaL / 2);
    shape1.lineTo(rosaW, -rosaL / 2 + chamfer);
    shape1.lineTo(rosaW, rosaL / 2);
    shape1.lineTo(0, rosaL / 2);
    shape1.lineTo(0, -rosaL / 2 + chamfer);
    shape1.closePath();

    // Panel 2 (-X): mirrored shape spans [-rosaW, 0] × [-rosaL/2, rosaL/2]
    const shape2 = new THREE.Shape();
    shape2.moveTo(-chamfer, -rosaL / 2);
    shape2.lineTo(-rosaW + chamfer, -rosaL / 2);
    shape2.lineTo(-rosaW, -rosaL / 2 + chamfer);
    shape2.lineTo(-rosaW, rosaL / 2);
    shape2.lineTo(0, rosaL / 2);
    shape2.lineTo(0, -rosaL / 2 + chamfer);
    shape2.closePath();

    const panelGeo1 = new THREE.ShapeGeometry(shape1);
    const panelGeo2 = new THREE.ShapeGeometry(shape2);

    // Back-face geometry clones with flipped normals — BackSide doesn't
    // flip normals in the shader (only DoubleSide does via DOUBLE_SIDED),
    // so we negate them here to get correct back-face lighting.
    const panelGeo1Back = panelGeo1.clone();
    const n1 = panelGeo1Back.attributes.normal;
    for (let i = 0; i < n1.count; i++) n1.setZ(i, -n1.getZ(i));
    n1.needsUpdate = true;

    const panelGeo2Back = panelGeo2.clone();
    const n2 = panelGeo2Back.attributes.normal;
    for (let i = 0; i < n2.count; i++) n2.setZ(i, -n2.getZ(i));
    n2.needsUpdate = true;

    // Higher-fidelity grid: 12×24 subdivisions for accordion-fold pattern
    const gridGeo   = new THREE.PlaneGeometry(rosaW, rosaL, 12, 24);
    const rollGeo   = new THREE.CylinderGeometry(M * 0.05, M * 0.05, rosaL, 8);

    // ── Gold anodized edge frames (ISS ROSA style) ──
    const goldEdgeMat = new THREE.LineBasicMaterial({
      color: 0xccaa44,     // gold chromate conversion coating
      transparent: false,
      // §2-followup (round 6): the gold edge is a DECAL line frame on the panel
      // outline, near-coplanar with the grid + panel face. It previously WROTE
      // depth and depth-TESTED at a fixed 0.0015 z-nudge that does not hold under
      // logarithmicDepthBuffer → shimmer against the grid/panel. Treat it like
      // the grid: no depth write AND no depth test, so the frame always paints
      // on its panel with zero depth tie. renderOrder keeps the stacking order
      // (panel < edge < grid). The frame only exists where a panel face is, so
      // skipping depthTest does not make it bleed through unrelated geometry in
      // practice (the wings deploy far outboard of the hull).
      depthWrite: false,
      depthTest: false,
    });

    // ── Shared solar array pivot — groups both wings as one rigid
    //    assembly so they stay coplanar through the satellite centre. ──
    // No Z-rotation: panels extend ±X (orbit-normal direction), which
    // projects as horizontal wings from the CHASE camera.
    // Sun-tracking is handled per-panel via boom-axis tilt (pivot.rotation.x).
    this._solarArrayPivot = new THREE.Group();
    this._solarArrayPivot.name = 'SolarArrayPivot';
    this.add(this._solarArrayPivot);

    // ── Panel 1: 0° azimuth (+X) ─────────────────────────────
    this.panelRightPivot = new THREE.Group();
    this.panelRightPivot.position.set(barrelR, 0, 0);
    this.panelRightPivot.name = 'PanelRightPivot';
    this._solarArrayPivot.add(this.panelRightPivot);

    this._rosaPanelWrapper1 = new THREE.Group();
    // Wrapper at pivot origin — shape starts at local x=0 (barrel surface)
    this._rosaPanelWrapper1.rotation.x = -Math.PI / 2; // local XY → world XZ
    this.panelRightPivot.add(this._rosaPanelWrapper1);

    const panel1Front = new THREE.Mesh(panelGeo1, panelMatFront);
    panel1Front.name = 'ROSA_Panel_Front_0deg';
    panel1Front.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;     // FIX_PLAN §2-followup
    this._rosaPanelWrapper1.add(panel1Front);

    // FIX_PLAN §2-followup: bump back 1 mm behind front so the two ShapeGeometry
    // planes no longer share the exact wrapper z=0 plane (was depth-tie ring).
    const panel1Back = new THREE.Mesh(panelGeo1Back, panelMatBack);
    panel1Back.position.z = -0.001;                                          // FIX_PLAN §2-followup
    panel1Back.name = 'ROSA_Panel_Back_0deg';
    panel1Back.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;       // FIX_PLAN §2-followup
    this._rosaPanelWrapper1.add(panel1Back);

    // FIX_PLAN §2-followup (round 3): edge was at z=0.001, grid at z=0.001 →
    // coplanar line/wireframe stack on the panel face. Bump edge up 0.5 mm
    // so the gold panel-outline always sits above the grid wireframe.
    const edgeGeo1 = new THREE.EdgesGeometry(panelGeo1, 1);
    const edge1 = new THREE.LineSegments(edgeGeo1, goldEdgeMat);
    edge1.position.z = 0.0015;                                              // FIX_PLAN §2-followup (round 3)
    edge1.name = 'ROSA_GoldEdge_0deg';
    edge1.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;           // FIX_PLAN §2-followup (round 3)
    this._rosaPanelWrapper1.add(edge1);

    const grid1 = new THREE.Mesh(gridGeo, gridMat);
    grid1.position.set(rosaW / 2, 0, 0.001);
    grid1.name = 'ROSA_Grid_0deg';
    grid1.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;      // FIX_PLAN §2-followup (round 3)
    this._rosaPanelWrapper1.add(grid1);

    this._rosaRoll1 = new THREE.Mesh(rollGeo, rollMat);
    this._rosaRoll1.position.set(M * 0.05, 0, 0); // just beyond barrel edge
    this._rosaRoll1.rotation.x = Math.PI / 2; // Y-axis → Z-axis (barrel axis)
    this._rosaRoll1.name = 'ROSA_Roll_0deg';
    this.panelRightPivot.add(this._rosaRoll1);

    // ── Panel 2: 180° azimuth (-X) ───────────────────────────
    this.panelLeftPivot = new THREE.Group();
    this.panelLeftPivot.position.set(-barrelR, 0, 0);
    this.panelLeftPivot.name = 'PanelLeftPivot';
    this._solarArrayPivot.add(this.panelLeftPivot);

    this._rosaPanelWrapper2 = new THREE.Group();
    this._rosaPanelWrapper2.rotation.x = -Math.PI / 2;
    this.panelLeftPivot.add(this._rosaPanelWrapper2);

    const panel2Front = new THREE.Mesh(panelGeo2, panelMatFront);
    panel2Front.name = 'ROSA_Panel_Front_180deg';
    panel2Front.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;     // FIX_PLAN §2-followup
    this._rosaPanelWrapper2.add(panel2Front);

    const panel2Back = new THREE.Mesh(panelGeo2Back, panelMatBack);
    panel2Back.position.z = -0.001;                                          // FIX_PLAN §2-followup — clear front plane
    panel2Back.name = 'ROSA_Panel_Back_180deg';
    panel2Back.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;       // FIX_PLAN §2-followup
    this._rosaPanelWrapper2.add(panel2Back);

    const edgeGeo2 = new THREE.EdgesGeometry(panelGeo2, 1);
    const edge2 = new THREE.LineSegments(edgeGeo2, goldEdgeMat);
    edge2.position.z = 0.0015;                                              // FIX_PLAN §2-followup (round 3)
    edge2.name = 'ROSA_GoldEdge_180deg';
    edge2.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;           // FIX_PLAN §2-followup (round 3)
    this._rosaPanelWrapper2.add(edge2);

    const grid2 = new THREE.Mesh(gridGeo, gridMat);
    grid2.position.set(-rosaW / 2, 0, 0.001);
    grid2.name = 'ROSA_Grid_180deg';
    grid2.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;      // FIX_PLAN §2-followup (round 3)
    this._rosaPanelWrapper2.add(grid2);

    this._rosaRoll2 = new THREE.Mesh(rollGeo, rollMat);
    this._rosaRoll2.position.set(-M * 0.05, 0, 0); // just beyond barrel edge
    this._rosaRoll2.rotation.x = Math.PI / 2;
    this._rosaRoll2.name = 'ROSA_Roll_180deg';
    this.panelLeftPivot.add(this._rosaRoll2);

    // ── Default state: fully deployed ─────────────────────────
    this._setRosaWingProgress(1, 1.0);
    this._setRosaWingProgress(2, 1.0);
  }

  /**
   * @private Apply roll-out progress to one ROSA wing.
   * @param {1|2} wing  — 1 = +X (0°), 2 = -X (180°)
   * @param {number} progress  — 0 (stowed) → 1 (deployed)
   */
  _setRosaWingProgress(wing, progress) {
    const wrapper = wing === 1 ? this._rosaPanelWrapper1 : this._rosaPanelWrapper2;
    const roll    = wing === 1 ? this._rosaRoll1 : this._rosaRoll2;
    if (wrapper) wrapper.scale.x = 0.05 + 0.95 * progress;
    if (roll)    roll.visible = progress < 0.5;
  }

  /**
   * @private Drive ROSA panel roll-out from LaunchSequence progress.
   * Defaults to fully deployed when no LaunchSequence is available.
   */
  _updateRosaPanels(/* dt */) {
    let progress1 = 1.0, progress2 = 1.0;
    if (this._launchSequence && this._launchSequence.getRosaProgress) {
      const prog = this._launchSequence.getRosaProgress();
      progress1 = prog.wing1;
      progress2 = prog.wing2;
    }
    this._setRosaWingProgress(1, progress1);
    this._setRosaWingProgress(2, progress2);
  }

  /**
   * Wire up a LaunchSequence instance so ROSA panels can read
   * roll-out progress.  Called from main.js or GameFlowManager.
   * @param {import('../systems/LaunchSequence.js').default} ls
   */
  setLaunchSequence(ls) {
    this._launchSequence = ls;
  }

  // --------------------------------------------------------------------------
  // 4. Sensor Suite
  // --------------------------------------------------------------------------
  /** @private */
  _buildSensors() {
    // Gimbal platform group (articulates toward targets — repositioned for Config G barrel)
    this.sensorGimbal = new THREE.Group();
    this.sensorGimbal.position.set(0, M * 0.25, M * 1.0);
    this.sensorGimbal.name = 'SensorGimbal';
    this.add(this.sensorGimbal);

    // EO Camera: small cylinder with dark lens
    const camGeo = new THREE.CylinderGeometry(M * 0.12, M * 0.12, M * 0.3, 6);
    const camLensMat = new THREE.MeshStandardMaterial({
      color: 0x111122, metalness: 0.7, roughness: 0.3,
    });
    const eoCam = new THREE.Mesh(camGeo, camLensMat);
    eoCam.rotation.x = Math.PI / 2;
    eoCam.position.set(M * 0.25, 0, M * 0.1);
    eoCam.name = 'EO_Camera';
    this.sensorGimbal.add(eoCam);

    // IR Sensor: gold-foil box
    const irGeo = new THREE.BoxGeometry(M * 0.2, M * 0.15, M * 0.2);
    const irSensor = new THREE.Mesh(irGeo, this._matGoldMLI);
    irSensor.position.set(-M * 0.25, 0, M * 0.1);
    irSensor.name = 'IR_Sensor';
    this.sensorGimbal.add(irSensor);

    // LIDAR: small dome with pulsing green light
    const lidarGeo = new THREE.SphereGeometry(M * 0.1, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const lidarMat = new THREE.MeshStandardMaterial({
      color: 0x888888, metalness: 0.7, roughness: 0.3,
    });
    this.lidarDome = new THREE.Mesh(lidarGeo, lidarMat);
    this.lidarDome.position.set(0, M * 0.15, M * 0.15);
    this.lidarDome.name = 'LIDAR_Dome';
    this.sensorGimbal.add(this.lidarDome);

    // LIDAR pulse light
    const lidarLightGeo = new THREE.SphereGeometry(M * 0.04, 4, 4);
    this._lidarLightMat = new THREE.MeshBasicMaterial({
      color: 0x00ff44, transparent: true, opacity: 0.0,
    });
    this.lidarLight = new THREE.Mesh(lidarLightGeo, this._lidarLightMat);
    this.lidarLight.position.set(0, M * 0.2, M * 0.15);
    this.lidarLight.name = 'LIDAR_Light';
    this.sensorGimbal.add(this.lidarLight);

    // Gimbal base plate
    // FIX_PLAN §2-followup: basePlate cylinder rotation.x=π/2 makes its 0.05 m
    // height extend along world Z, centred on sensorGimbal.z=1.0. So plate
    // z-extent was [0.975, 1.025] — straddles the front cap at z=1.0 →
    // textbook z-fight on the forward face of the bus. Shift plate 30 mm
    // forward (local z=+0.03) so its aft face sits clear at z=1.005.
    const basePlateGeo = new THREE.CylinderGeometry(M * 0.35, M * 0.35, M * 0.05, 8);
    const basePlate = new THREE.Mesh(basePlateGeo, this._matDark);
    basePlate.rotation.x = Math.PI / 2;
    basePlate.position.set(0, -M * 0.1, M * 0.03);                          // FIX_PLAN §2-followup
    basePlate.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;        // FIX_PLAN §2-followup
    this.sensorGimbal.add(basePlate);
  }

  // --------------------------------------------------------------------------
  // 5. Tether Reels — REMOVED for Config G (strut-mounted reels in V-3/V-7)
  // --------------------------------------------------------------------------
  // V3 bus-mounted tether reels removed. Config G uses strut-mounted reels
  // that will be added to each strut tip in V-3 (strut animation) and V-7 (tether reel visual).
  // Arrays kept empty for API compatibility with _animateTetherIndicators / getTetherReelPosition.

  // --------------------------------------------------------------------------
  // 6. Magnetic Field Generator — REMOVED for Config G
  // --------------------------------------------------------------------------
  // V3 magnetic coil ring removed — not present in Config G design.

  // --------------------------------------------------------------------------
  // 7. Docking Port (repositioned for Config G barrel)
  // --------------------------------------------------------------------------
  /** @private */
  _buildDockingPort() {
    // Docking ring on front end — scaled for Config G (barrel front at Z = +M*1.0)
    const dockRingGeo = new THREE.TorusGeometry(M * 0.25, M * 0.04, 6, 12);
    const dockMat = new THREE.MeshStandardMaterial({
      color: 0x888899, metalness: 0.65, roughness: 0.4,
    });
    this.dockingPort = new THREE.Mesh(dockRingGeo, dockMat);
    this.dockingPort.position.set(0, -M * 0.15, M * 1.05);
    this.dockingPort.name = 'DockingPort';
    this.add(this.dockingPort);

    // Docking guide cone
    const guideGeo = new THREE.ConeGeometry(M * 0.22, M * 0.12, 6, 1, true);
    const guide = new THREE.Mesh(guideGeo, this._matDark);
    guide.position.set(0, -M * 0.15, M * 1.1);
    this.add(guide);

    // Green/Red docking lights
    // FIX_PLAN §2-followup (round 3): lights were at radial 0.20 from torus
    // centre; torus tube inner edge at major(0.25) − minor(0.04) = 0.21, so
    // sphere outer (0.20+0.03=0.23) physically pierced the tube. Pulled
    // lights inward to radial 0.15 → sphere outer 0.18, well clear of tube
    // hole rim. Visual still reads as "lights flanking the docking port".
    const dockLightGeo = new THREE.SphereGeometry(M * 0.03, 4, 4);

    this._dockGreenMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
    const dockGreen = new THREE.Mesh(dockLightGeo, this._dockGreenMat);
    dockGreen.position.set(M * 0.15, -M * 0.15, M * 1.05);                  // FIX_PLAN §2-followup (round 3)
    dockGreen.name = 'DockLight_Green';
    dockGreen.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;     // FIX_PLAN §2-followup (round 3)
    this.add(dockGreen);

    this._dockRedMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    const dockRed = new THREE.Mesh(dockLightGeo, this._dockRedMat);
    dockRed.position.set(-M * 0.15, -M * 0.15, M * 1.05);                   // FIX_PLAN §2-followup (round 3)
    dockRed.name = 'DockLight_Red';
    dockRed.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;       // FIX_PLAN §2-followup (round 3)
    this.add(dockRed);

    this._dockGreenLight = dockGreen;
    this._dockRedLight = dockRed;
  }

  // --------------------------------------------------------------------------
  // 8. Navigation Lights
  // --------------------------------------------------------------------------
  /** @private */
  _buildNavLights() {
    const navGeo = new THREE.SphereGeometry(M * 0.04, 4, 4);

    // Port (left) — Red (repositioned for Config G barrel)
    this._portLightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    this.portLight = new THREE.Mesh(navGeo, this._portLightMat);
    this.portLight.position.set(-M * 0.42, 0, M * 0.3);
    this.portLight.name = 'NavLight_Port';
    this.add(this.portLight);

    // Starboard (right) — Green
    this._starboardLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    this.starboardLight = new THREE.Mesh(navGeo, this._starboardLightMat);
    this.starboardLight.position.set(M * 0.42, 0, M * 0.3);
    this.starboardLight.name = 'NavLight_Starboard';
    this.add(this.starboardLight);

    // White strobe — top
    this._strobeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1.0,
    });
    this.strobeTop = new THREE.Mesh(navGeo, this._strobeMat.clone());
    this.strobeTop.position.set(0, M * 0.42, 0);
    this.strobeTop.name = 'StrobeTop';
    this.add(this.strobeTop);

    // White strobe — bottom
    this.strobeBottom = new THREE.Mesh(navGeo, this._strobeMat.clone());
    this.strobeBottom.position.set(0, -M * 0.42, 0);
    this.strobeBottom.name = 'StrobeBottom';
    this.add(this.strobeBottom);
  }

  // --------------------------------------------------------------------------
  // 9. RCS Thruster Puff Sprites (pooled)
  // --------------------------------------------------------------------------
  /** @private — Create sprite pool for RCS thruster puff visual effects */
  _buildRcsPuffPool() {
    // Procedural soft radial gradient texture (32×32 canvas)
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2
    );
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.4)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);

    const puffMat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });

    // Nozzle positions: keyed by direction sign — exhaust appears OPPOSITE to thrust
    // Ship model: +Z = forward (prograde), -Z = rear (aft thrusters)
    this._rcsPuffNozzles = {
      'pz': new THREE.Vector3(0, 0, -M * 1.1),   // thrust prograde (+Z) → exhaust at rear (-Z, aft end)
      'nz': new THREE.Vector3(0, 0,  M * 1.1),   // thrust retrograde (-Z) → exhaust at front (+Z)
      'px': new THREE.Vector3(-M * 0.5, 0, 0),    // thrust +X → exhaust at -X (Config G radius 0.4m + offset)
      'nx': new THREE.Vector3( M * 0.5, 0, 0),    // thrust -X → exhaust at +X
      'py': new THREE.Vector3(0, -M * 0.5, 0),    // thrust +Y → exhaust at -Y
      'ny': new THREE.Vector3(0,  M * 0.5, 0),    // thrust -Y → exhaust at +Y
    };

    // Create 8 pooled sprites (round-robin reuse)
    for (let i = 0; i < 8; i++) {
      const sprite = new THREE.Sprite(puffMat.clone());
      sprite.scale.set(M * 0.5, M * 0.5, M * 0.5);
      sprite.visible = false;
      sprite.name = `RcsPuff_${i}`;
      this.add(sprite);
      this._rcsPuffs.push({ sprite, startTime: 0, active: false });
    }
  }

  // ==========================================================================
  // NAMED ATTACHMENT POINT GETTERS
  // ==========================================================================

  /** Get world position of the sensor gimbal (laser/scan origin) */
  getSensorGimbalPosition() {
    const pos = new THREE.Vector3();
    this.sensorGimbal.getWorldPosition(pos);
    return pos;
  }

  /** Get world position of a specific main FEEP nozzle (field-emission beam origin) */
  getMainThrusterPosition(index = 0) {
    const pos = new THREE.Vector3();
    if (this.mainThrusters[index]) {
      this.mainThrusters[index].getWorldPosition(pos);
    } else {
      this.getWorldPosition(pos);
    }
    return pos;
  }

  /** Get world position of a specific tether reel (tether origin) */
  getTetherReelPosition(index = 0) {
    const pos = new THREE.Vector3();
    if (this.tetherReels[index]) {
      this.tetherReels[index].getWorldPosition(pos);
    } else {
      this.getWorldPosition(pos);
    }
    return pos;
  }

  /** Get world position of the docking port */
  getDockingPortPosition() {
    const pos = new THREE.Vector3();
    this.dockingPort.getWorldPosition(pos);
    return pos;
  }

  // ==========================================================================
  // ANIMATION CONTROL API
  // ==========================================================================

  /** Set sensor gimbal target (world position vector or null) */
  setSensorTarget(worldPos) {
    this._sensorTarget = worldPos;
  }

  /** Set tether reel state (index 0-7, state: 'ready'|'deployed'|'empty') */
  setTetherState(index, state) {
    if (index >= 0 && index < this._tetherStates.length) {
      this._tetherStates[index] = state;
    }
  }

  /** Get current active thrust direction for thruster glow */
  setActiveThrustDirection(dir) {
    this._activeThrustDir = dir;
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Per-frame update: propagate orbit, position, solar power, animations.
   * @param {number} dt - Real-time delta (seconds)
   * @param {THREE.Vector3} sunDirection - Normalized sun direction vector
   */
  update(dt, sunDirection) {
    const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;

    // --- V5: Thruster interlock check ---
    this._updateThrusterInterlock();

    // --- C-11: RCS nulling of recoil angular velocity ---
    if (Constants.FEATURE_FLAGS.RECOIL_PHYSICS) {
      this._tickRecoilRcs(gameDt);
    }

    // --- Apply accumulated thrust ---
    this._applyThrust(gameDt);

    // --- Propagate orbit ---
    const kmOrbit = {
      ...this.orbit,
      semiMajorAxis: this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
    };
    propagateOrbit(kmOrbit, gameDt);
    this.orbit.trueAnomaly = kmOrbit.trueAnomaly;
    this.orbit.meanMotion = kmOrbit.meanMotion;

    // --- Atmospheric drag ---
    const altKm = (this.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
    if (altKm < 600) {
      const vel = orbitalVelocity(
        this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
        this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
        Constants.MU_EARTH
      );
      const dragDecel = atmosphericDrag(altKm, vel, 20, this.mass);
      const dvDrag = dragDecel * gameDt;
      if (vel > 0) {
        const factor = 1 - 2 * dvDrag / vel;
        this.orbit.semiMajorAxis *= factor;
      }
    }

    // --- Update position ---
    this._updateCartesian();
    this._applyPosition();

    // --- RCS fine-positioning (Phase 1: additive to orbital motion) ---
    if (this._rcsVelocity.lengthSq() > 1e-20) {
      this.position.add(this._rcsVelocity.clone().multiplyScalar(dt));
      // Damping: velocity decays when not thrusting (stops quickly on key release)
      this._rcsVelocity.multiplyScalar(Constants.RCS_DAMPING);
      // Zero out when negligible
      if (this._rcsVelocity.lengthSq() < 1e-22) {
        this._rcsVelocity.set(0, 0, 0);
      }
    }

    this._orientAlongVelocity();

    // --- Solar power ---
    this._updateSolarPower(sunDirection);

    // --- Resources ---
    this._updateResources(dt);

    // --- S3b: MPD thermal dissipation (always runs, even when not firing) ---
    if (this._mpdHeat > 0) {
      const coolRate = this._hasSupercap
        ? (Constants.MPD_BURST_COOL_RATE_SUPERCAP || 0.5)
        : (Constants.MPD_BURST_COOL_RATE || 0.3);
      this._mpdHeat = Math.max(0, this._mpdHeat - coolRate * dt);
    }

    // S3b: MPD cooldown timer
    if (this._mpdCooldownTimer > 0) {
      this._mpdCooldownTimer -= dt;
      if (this._mpdCooldownTimer <= 0) {
        this._mpdCooldownTimer = 0;
        this._mpdHeat = 0;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'MPD thermal nominal — ready to arm',
          priority: 'info',
        });
      }
    }

    // S3b: Auto-disarm if battery depleted while armed
    if (this._mpdArmed && this.resources.battery <= 0) {
      this._mpdArmed = false;
      this._mpdDegraded = false;
      eventBus.emit(Events.MPD_BURST_END, { reason: 'battery_depleted' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD OFFLINE — battery depleted',
        priority: 'warning',
      });
    }

    // S3b: Auto-disarm if lithium depleted while armed
    if (this._mpdArmed && this.resources.lithium <= 0) {
      this._mpdArmed = false;
      this._mpdDegraded = false;
      eventBus.emit(Events.MPD_BURST_END, { reason: 'lithium_depleted' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD FUEL DEPLETED — no lithium',
        priority: 'warning',
      });
    }

    // --- Animations ---
    this._updateRosaPanels(dt);
    this._animateSolarTracking(dt, sunDirection);
    this._animateSensorGimbal(dt);
    this._animateNavLights(dt);
    this._animateThrusterGlow(dt);
    this._animateLidarPulse(dt);
    this._animateTetherIndicators(dt);
    this._animateScanFlash(dt);
    this._updateRcsPuffs(dt);
    this._updateStruts(dt);

    // --- EDT deployment & attraction (Phase 6) ---
    if (this._edtDeployed && !this._edtActive) {
      const deployTime = (Constants.EDT && Constants.EDT.DEPLOY_TIME) || 5;
      this._edtDeployTimer += dt;
      if (this._edtDeployTimer >= deployTime) {
        this._edtActive = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'EDT', text: 'EDT active — attracting nearby debris', priority: 'info',
        });
      }
    }

    if (this._edtActive) {
      const powerDraw = (Constants.EDT && Constants.EDT.POWER_DRAW) || 0.05;
      if (this._resourceSystem && !this._resourceSystem.canAfford('battery', powerDraw * dt)) {
        this._edtActive = false;
        this._edtDeployed = false;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'EDT', text: 'EDT shutdown — low power', priority: 'warning',
        });
      } else if (this._resourceSystem) {
        this._resourceSystem.consume('battery', powerDraw * dt);
        // Emit attraction event for debris field to process
        eventBus.emit(Events.EDT_ATTRACT, {
          position: this.position ? this.position.clone() : new THREE.Vector3(),
          radius: (Constants.EDT && Constants.EDT.ATTRACTION_RADIUS_KM) || 0.2,
          force: (Constants.EDT && Constants.EDT.ATTRACTION_FORCE) || 0.0001,
          maxMass: (Constants.EDT && Constants.EDT.MAX_ATTRACT_MASS) || 20,
        });
      } else {
        // No resource system — drain legacy battery directly
        this.resources.battery -= powerDraw * dt;
        if (this.resources.battery <= 0) {
          this.resources.battery = 0;
          this._edtActive = false;
          this._edtDeployed = false;
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'EDT', text: 'EDT shutdown — low power', priority: 'warning',
          });
        }
      }
    }

    // --- ST-5.2: Trail sample emission (continuous 10 Hz) ---
    // Samples emitted continuously; TrailSystem controls visibility via
    // THRUST_VISUAL events (only shows trail during active thrust).
    if (Constants.TRAILS && Constants.TRAILS.ENABLED !== false) {
      this._trailSampleAccum = (this._trailSampleAccum || 0) + gameDt;
      const trailInterval = 1 / (Constants.TRAILS.SAMPLE_RATE_HZ || 10);
      if (this._trailSampleAccum >= trailInterval) {
        this._trailSampleAccum -= trailInterval;
        // Clamp accumulator to prevent burst after long pauses
        if (this._trailSampleAccum > trailInterval) this._trailSampleAccum = 0;
        eventBus.emit(Events.PLAYER_TRAIL_SAMPLE, {
          pos: { x: this.position.x, y: this.position.y, z: this.position.z },
          vel: this._cartesian ? this._cartesian.velocity : { x: 0, y: 0, z: 0 },
        });
      }
    }

    // --- Emit telemetry ---
    if (Math.random() < 0.02) {
      // Phase 4: Include current fuel info in telemetry
      const currentFuel = this._resourceSystem
        ? this._resourceSystem.getCurrentFuel()
        : Constants.FUELS.xenon;

      eventBus.emit(Events.PLAYER_TELEMETRY, {
        altitude: altKm,
        velocity: this._cartesian.velocity,
        resources: { ...this.resources },
        orbit: { ...this.orbit },
        deltaVSpent: this._deltaVSpent,
        thrustDirection: this._thrustDirection,
        lastThrustType: this._lastThrustType,
        currentFuelId: currentFuel.id || 'xenon',
        currentIsp: currentFuel.isp || 1600,
        throttleLevel: this.throttleLevel,
        edtActive: this._edtActive,
        edtDeployed: this._edtDeployed,
        hasMPD: this._hasMPD,
        mpdCathodeTime: this._mpdCathodeTime,
        mpdCathodeHealth: this.mpdCathodeHealth,
        mpdCathodeLife: this._mpdCathodeLife,
        // S3b: MPD burst mode telemetry
        mpdArmed: this._mpdArmed,
        mpdHeat: this._mpdHeat,
        mpdHeatFraction: this.mpdHeatFraction,
        mpdCooldownRemaining: this._mpdCooldownTimer,
        mpdDegraded: this._mpdDegraded,
      });
    }
    // Reset per-frame thrust direction (accumulated fresh each frame)
    this._thrustDirection = null;
  }

  // ==========================================================================
  // ANIMATIONS
  // ==========================================================================

  /** @private Solar panels slowly track the sun via boom-axis tilt.
   *
   *  Each panel pivot rotates around the boom axis (body ±X) to tilt the
   *  panel face toward the sun.  This keeps wings extending in ±X
   *  (orbit-normal → horizontal on screen from CHASE camera) while
   *  allowing proper sun-tracking.
   *
   *  Panel normal at rest (rotation.x = 0) is body +Y (zenith).
   *  Rotation.x = α tilts the normal to (0, cos α, sin α) in body space.
   *  Optimal α = atan2(localSun.z, localSun.y) — maximises dot(normal, sun).
   */
  _animateSolarTracking(dt, sunDirection) {
    if (!sunDirection) return;

    // Convert sun direction to satellite body space
    const localSun = sunDirection.clone().applyQuaternion(this.quaternion.clone().invert());

    // Optimal tilt: align panel normal with sun's projection in the YZ plane
    // (perpendicular to the boom axis X).
    const targetTilt = Math.atan2(localSun.z, localSun.y);

    // Clamp to ±30° — avoids ROSA trailing edge colliding with arm struts
    // at 60°/120° azimuth (Config G 3-plane layout clearance: 0.20m at 30°).
    const maxTilt = 30 * Math.PI / 180;
    const clampedTilt = Math.max(-maxTilt, Math.min(maxTilt, targetTilt));

    const trackSpeed = 0.3 * dt; // Slow, smooth tracking

    // Apply identical tilt to both panel pivots (coplanar tracking)
    if (this.panelRightPivot) {
      const cur = this.panelRightPivot.rotation.x;
      this.panelRightPivot.rotation.x += (clampedTilt - cur) * trackSpeed;
    }
    if (this.panelLeftPivot) {
      const cur = this.panelLeftPivot.rotation.x;
      this.panelLeftPivot.rotation.x += (clampedTilt - cur) * trackSpeed;
    }
  }

  /** @private Sensor gimbal points toward selected target */
  _animateSensorGimbal(dt) {
    if (!this._sensorTarget || !this.sensorGimbal) return;

    // Get target direction in local space
    const worldPos = new THREE.Vector3();
    this.sensorGimbal.getWorldPosition(worldPos);
    const dir = this._sensorTarget.clone().sub(worldPos);
    const localDir = dir.applyQuaternion(this.quaternion.clone().invert());

    // Compute yaw/pitch for gimbal
    const yaw = Math.atan2(localDir.x, localDir.z);
    const pitch = Math.atan2(localDir.y, Math.sqrt(localDir.x * localDir.x + localDir.z * localDir.z));

    // Clamp rotation range
    const maxYaw = Math.PI / 3;
    const maxPitch = Math.PI / 4;
    const clampedYaw = Math.max(-maxYaw, Math.min(maxYaw, yaw));
    const clampedPitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));

    // Smooth interpolation
    const speed = 2.0 * dt;
    this.sensorGimbal.rotation.y += (clampedYaw - this.sensorGimbal.rotation.y) * speed;
    this.sensorGimbal.rotation.x += (-clampedPitch - this.sensorGimbal.rotation.x) * speed;
  }

  /** @private Navigation and strobe lights blinking */
  _animateNavLights(dt) {
    // Port/Starboard nav lights: always on (constant)

    // White strobes: blink at ~1Hz
    this._strobeTimer += dt;
    if (this._strobeTimer > 1.0) {
      this._strobeTimer = 0;
      const on = !this.strobeTop.visible;
      this.strobeTop.visible = on;
      this.strobeBottom.visible = on;
    }

    // Docking lights alternate blink
    this._blinkTimer += dt;
    if (this._blinkTimer > 0.8) {
      this._blinkTimer = 0;
      this._dockGreenLight.visible = !this._dockGreenLight.visible;
      this._dockRedLight.visible = !this._dockRedLight.visible;
    }
  }

  /** @private Thruster glow — per-nozzle differential for attitude + uniform prograde */
  _animateThrusterGlow(dt) {
    const ti = this.thrustInput;
    const mag = Math.sqrt(ti.x * ti.x + ti.y * ti.y + ti.z * ti.z);
    const hasThrust = mag > 1e-12;
    const lerpRate = Constants.DIFFERENTIAL_THRUST.LERP_RATE;

    // Main thrusters: each nozzle lerps independently toward its own target
    this.mainThrusters.forEach((thruster, i) => {
      const data = this._thrusterGlowTargets.get(thruster);
      if (!data) return;

      // C-9: Check plume interlock — dim blocked FEEP nozzles
      const tid = thruster._thrusterId;
      const blocked = Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK &&
                      this._plumeBlocked && tid && (tid in this._plumeBlocked);

      // Prograde thrust target (same for all nozzles, as before)
      let progradeTarget = 0;
      if (hasThrust && ti.z > 0) {
        progradeTarget = Math.min(1.0, Math.abs(ti.z) * 5000);
      }

      // Differential attitude-rotation target (per-nozzle, set by setThrusterFire)
      const diffTarget = this._differentialFireTargets[i] || 0;

      // Composite: max of prograde and differential
      let target = Math.max(progradeTarget, diffTarget);

      // Suppress thrust output when plume-blocked
      if (blocked) target *= 0.15;

      // Smooth interpolation — per-nozzle independent lerp
      data.intensity += (target - data.intensity) * Math.min(1, dt * lerpRate);

      // Apply glow — red tint when blocked, silvery-blue when clear
      if (data.glow && data.glow.material) {
        data.glow.material.opacity = data.intensity * 0.8;
        if (blocked) {
          data.glow.material.color.setHex(0xff4444);
        } else {
          data.glow.material.color.setHex(0x99bbdd);
        }
      }

      // Plume visibility, scale, and flickering
      if (data.plume) {
        data.plume.visible = data.intensity > 0.05;
        if (data.plume.visible) {
          // Enhanced flicker: multi-frequency noise for realistic ion thruster shimmer
          const flicker = 1.0 + Math.random() * 0.25 - 0.125 + Math.sin(Date.now() * 0.03) * 0.08;
          const s = (0.5 + data.intensity * 1.5) * flicker;
          data.plume.scale.set(s, s + Math.random() * 0.3, s);
          data.plume.material.opacity = data.intensity * 0.45 * flicker;
          // Red-shift plume when interlock active
          if (blocked) {
            data.plume.material.color.setHex(0xff6644);
          } else {
            data.plume.material.color.setHex(0x99bbdd);
          }
        }
      }

      // Outer volumetric glow — softer, larger halo
      if (data.outerGlow) {
        data.outerGlow.visible = data.intensity > 0.08;
        if (data.outerGlow.visible) {
          const gs = 0.6 + data.intensity * 1.2;
          data.outerGlow.scale.set(gs, gs, gs);
          data.outerGlow.material.opacity = data.intensity * 0.15;
          data.outerGlow.material.color.setHex(blocked ? 0xff4422 : 0xaaccee);
        }
      }

      // Inner nozzle liner — emissive intensifies when nozzle fires
      if (data.innerLiner && data.innerLiner.material) {
        const DT = Constants.DIFFERENTIAL_THRUST;
        const fireEmissive = DT.INNER_EMISSIVE_BASE + data.intensity * DT.INNER_EMISSIVE_FIRE_SCALE;
        data.innerLiner.material.emissiveIntensity = fireEmissive;
        if (blocked) {
          data.innerLiner.material.emissive.setHex(0x662222);
        } else {
          data.innerLiner.material.emissive.setHex(0x334466);
        }
      }
    });

    // Reset differential targets — caller must re-set every frame for sustained fire
    this._differentialFireTargets[0] = 0;
    this._differentialFireTargets[1] = 0;
    this._differentialFireTargets[2] = 0;
    this._differentialFireTargets[3] = 0;

    // Attitude thrusters: glow based on lateral/normal thrust
    const attitudeIntensity = hasThrust ? Math.min(1.0, (Math.abs(ti.x) + Math.abs(ti.y)) * 5000) : 0;
    this.attitudeThrusterPlumes.forEach(plume => {
      plume.visible = attitudeIntensity > 0.1;
      if (plume.visible && plume.material) {
        plume.material.opacity = attitudeIntensity * 0.3;
      }
    });
  }

  /**
   * @private Scan flash — brief cyan emissive pulse on body material.
   * Triggered by SCAN_INITIATED event, decays over 0.5s.
   */
  _animateScanFlash(dt) {
    if (this._scanFlashTimer <= 0) return;
    this._scanFlashTimer -= dt;

    const t = Math.max(0, this._scanFlashTimer / 0.5); // 1→0 over 0.5s
    const done = this._scanFlashTimer <= 0;

    // Drive BOTH the MLI body blanket and the solar-cell panels with the cyan
    // scan glow. Restore values MUST match each material's build defaults
    // (mismatched restores previously dimmed the barrel permanently after the
    // first scan).
    if (this._matBody) {
      this._matBody.emissive.setHex(0x00aaff);     // cyan scan glow
      this._matBody.emissiveIntensity = t * 0.6;    // peak 0.6, fade to 0
      if (done) {
        this._matBody.emissive.setHex(0x4a3008);    // gold MLI build default (_matGoldMLI)
        this._matBody.emissiveIntensity = 0.16;
      }
    }
    if (this._cellSkinMats) {
      for (const mat of this._cellSkinMats) {
        mat.emissive.setHex(0x00aaff);
        mat.emissiveIntensity = t * 0.6;
        if (done) {
          mat.emissive.setHex(0x0b1030); // build default (_buildMainBus)
          mat.emissiveIntensity = 0.18;
        }
      }
    }
  }

  /** @private LIDAR occasional green pulse */
  _animateLidarPulse(dt) {
    this._lidarPulseTimer += dt;
    if (this._lidarPulseTimer > 3.0) {
      this._lidarPulseTimer = 0;
      // Pulse
      this._lidarLightMat.opacity = 1.0;
    }
    // Fade
    if (this._lidarLightMat.opacity > 0) {
      this._lidarLightMat.opacity = Math.max(0, this._lidarLightMat.opacity - dt * 2.0);
    }
  }

  /** @private Tether indicator colors based on state (Config G: no-op, bus reels removed) */
  _animateTetherIndicators(dt) {
    // Config G: bus-mounted tether reels removed — guard against empty arrays
    if (!this._tetherIndicators || this._tetherIndicators.length === 0) return;

    this._tetherStates.forEach((state, i) => {
      const ind = this._tetherIndicators[i];
      if (!ind) return;

      switch (state) {
        case 'ready':
          ind.material.color.setHex(0x00ff44); // Green
          break;
        case 'deployed':
          ind.material.color.setHex(0xffaa00); // Yellow
          // Animate spool rotation
          if (this.tetherReels && this.tetherReels[i]) {
            this.tetherReels[i].children[1].rotation.y += dt * 2;
          }
          break;
        case 'empty':
          ind.material.color.setHex(0xff2222); // Red
          break;
      }
    });

    // EDT active glow — pulse tether indicators blue when EDT is on (Phase 6)
    // Uses color override since indicators are MeshBasicMaterial (no emissive)
    if (this._edtActive && this._tetherIndicators && this._tetherIndicators.length > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.005);
      const r = Math.round(79 * pulse);        // 0x4f = 79
      const g = Math.round(195 * (0.5 + 0.5 * pulse)); // 0xc3 = 195
      const b = Math.round(247);                // 0xf7 = 247
      for (const indicator of this._tetherIndicators) {
        if (indicator && indicator.material) {
          indicator.material.color.setRGB(r / 255, g / 255, b / 255);
        }
      }
    }
  }

  // ==========================================================================
  // SYSTEM REFERENCES (Phase 4)
  // ==========================================================================

  /** Set ResourceSystem reference for fuel-aware thrust. */
  setResourceSystem(rs) { this._resourceSystem = rs; }

  /** Set CargoSystem reference for cargo-based fuel consumption. */
  setCargoSystem(cs) { this._cargoSystem = cs; }

  /**
   * Show/hide the diagnostic hull edge-outline (INSPECT view treatment).
   * Gated by Constants.INSPECTION.HULL_OUTLINE so it can be disabled globally.
   * @param {boolean} visible
   */
  setHullOutlineVisible(visible) {
    if (!this._hullOutline) return;
    const enabled = Constants.INSPECTION?.HULL_OUTLINE !== false;
    this._hullOutline.visible = !!visible && enabled;
  }

  // ==========================================================================
  // V5 CROSSBOW — ARM MANAGER & RECOIL (Phase 4 Mothership)
  // ==========================================================================

  /**
   * Set arm manager reference for interlock and recoil calculations.
   * @param {import('./ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this.armManager = armManager;
  }

  /**
   * Apply recoil momentum from crossbow arm firing.
   * Newton's 3rd law: p_recoil = m_arm × v_launch / m_mother
   * Single Weaver at 10 m/s: 6.6 × 10 / 130 = 0.508 m/s recoil
   * Single Spinner at 10 m/s: 2.1 × 10 / 130 = 0.162 m/s recoil
   * @param {object} data - { armIndex, armMass, speed }
   * @private
   */
  _applyCrossbowRecoil(data) {
    const { armMass, speed } = data;
    const motherMass = this.mass || 130; // kg
    const recoilSpeed = (armMass * speed) / motherMass;

    // Convert recoil speed (m/s) to scene units/s.
    // Scale to 10% of theoretical — subtle nudge, not disorienting for new players.
    // Real ADR sats have internal momentum management that absorbs most recoil.
    const RECOIL_SCALE = 0.1;
    const recoilDv = recoilSpeed * M * RECOIL_SCALE;

    // Apply recoil as velocity change opposite to arm launch direction
    // Approximate: backward along ship's current heading (-Z local axis)
    const backward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv);
    this._rcsVelocity.add(backward);

    // Track cumulative recoil for this frame — DUAL_FIRE_RECOIL may
    // supersede these individual impulses (opposing arms cancel naturally).
    this._frameRecoilDv += recoilDv;
    this._frameRecoilCount++;

    // Auto-compensate with RCS if enabled (single-arm fire).
    // For dual-fire, individual compensations still apply but the net
    // velocity change is zero (backward + forward cancel). The N₂ cost
    // is refunded when DUAL_FIRE_RECOIL arrives with cancelled=true.
    this._autoRcsCompensation(recoilDv);
  }

  /**
   * Automatic RCS compensation after crossbow recoil.
   * Uses cold-gas N₂ — 3.7g per Weaver single-fire compensation.
   * @param {number} recoilDv - Scene-scale ΔV to compensate
   * @private
   */
  _autoRcsCompensation(recoilDv) {
    if (!this._crossbowAutoRcs) return; // Can be toggled by player

    // Calculate N₂ needed (proportional to ΔV relative to Weaver baseline)
    const baseRecoilDv = DUALFIRE_RECOIL_WEAVER * M;
    const n2Grams = DUALFIRE_RCS_COMPENSATION_N2 * (recoilDv / baseRecoilDv);

    // Consume cold gas resource via EventBus (ResourceSystem is canonical owner)
    const n2Kg = n2Grams / 1000;
    eventBus.emit(Events.RESOURCE_CONSUME, {
      resource: 'coldGas',
      amount: n2Kg,
    });

    // Track actual N₂ consumed for dual-fire refund
    this._frameN2Consumed += n2Kg;

    // Apply counter-impulse (cancel the recoil)
    const forward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv);
    this._rcsVelocity.add(forward);

    // Show RCS compensation puff visual
    this._triggerRcsPuff('compensation');
  }

  /**
   * Handle dual-fire recoil result.
   * If cancelled: no compensation needed (opposing arms cancelled momentum).
   * If residual: small RCS correction only.
   * @param {object} data - { cancelled: boolean, residualDv: number }
   * @private
   */
  _applyDualFireRecoil(data) {
    if (data.cancelled) {
      // Momentum fully cancelled by opposing arms — refund N₂ that
      // individual CROSSBOW_FIRE handlers consumed (2 arms × compensation).
      // Each arm's autoRcsCompensation already cancelled the velocity,
      // so we only need to refund the cold gas.
      if (this._crossbowAutoRcs && this._frameN2Consumed > 0) {
        // Refund exact N₂ consumed by individual arm compensations
        eventBus.emit(Events.RESOURCE_REPLENISH, {
          resource: 'coldGas',
          amount: this._frameN2Consumed,
        });
      }
      this._frameRecoilDv = 0;
      this._frameRecoilCount = 0;
      this._frameN2Consumed = 0;
      return;
    }

    // Small residual — apply minimal RCS correction
    this._frameRecoilDv = 0;
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;
    const residualDv = data.residualDv * M;
    this._autoRcsCompensation(residualDv);
  }

  /**
   * C-11: Apply angular impulse from Config G dual-fire residual.
   * Converts torque impulse (N·m·s) to angular velocity change via
   * approximate moment of inertia (I ≈ mass × r² where r = 0.5 m).
   * RCS nulling runs in _tickRecoilRcs() during update loop.
   *
   * @param {number} torqueImpulse — angular impulse in N·m·s
   */
  applyRecoilAngularImpulse(torqueImpulse) {
    if (!Constants.FEATURE_FLAGS.RECOIL_PHYSICS) return;
    // Approximate MOI for a 130 kg cylinder of radius 0.5 m
    const I_mother = (this.mass || 130) * 0.25; // kg·m²
    const deltaOmega = torqueImpulse / I_mother;
    this._recoilAngularVel += deltaOmega;
  }

  /**
   * C-11: RCS damping of recoil angular velocity.
   * Nulls _recoilAngularVel toward zero at RCS angular authority rate.
   * Called each frame from update(). Settles within ~2 s.
   * @param {number} dt — frame time in seconds
   * @private
   */
  _tickRecoilRcs(dt) {
    if (Math.abs(this._recoilAngularVel) < 1e-6) {
      this._recoilAngularVel = 0;
      return;
    }
    // RCS angular authority: ~0.5 rad/s² (cold-gas thrusters)
    const rcsAuthority = 0.5; // rad/s²
    const maxDelta = rcsAuthority * dt;
    if (Math.abs(this._recoilAngularVel) <= maxDelta) {
      this._recoilAngularVel = 0;
    } else {
      this._recoilAngularVel -= Math.sign(this._recoilAngularVel) * maxDelta;
    }
  }

  /**
   * C-11: Apply induced torque from CoM offset during recoil.
   * Called by ArmManager when both RECOIL_PHYSICS and COM_TRACKING are enabled.
   * The torque vector comes from computeInducedTorque(comPos, recoilForce).
   *
   * @param {{ x: number, y: number, z: number }} torqueVec — torque in N·m
   */
  applyInducedTorque(torqueVec) {
    if (!Constants.FEATURE_FLAGS.RECOIL_PHYSICS) return;
    if (!torqueVec) return;
    // Convert torque vector magnitude to angular velocity (simplified)
    const I_mother = (this.mass || 130) * 0.25; // kg·m²
    const mag = Math.sqrt(torqueVec.x ** 2 + torqueVec.y ** 2 + torqueVec.z ** 2);
    this._recoilAngularVel += mag / I_mother;
  }

  /**
   * Fire a visual RCS puff for compensation feedback.
   * @param {string} type - 'compensation' | other
   * @private
   */
  _triggerRcsPuff(type) {
    // Fire a forward-facing puff to indicate RCS compensation firing
    this._fireRcsPuff({ x: 0, y: 0, z: 0.5 });
  }

  /**
   * Check if back arm (index 7) is in a state that requires thruster inhibit,
   * AND run Config G plume-geometry interlock (C-9, Gap #8).
   * §13 Thruster Safety: Hall/MPD exhaust endangers arm at retrograde dock.
   * Called each update tick.
   * @private
   */
  _updateThrusterInterlock() {
    if (!this.armManager) {
      this._thrusterInterlock = false;
      this._plumeBlocked = {};
      return;
    }

    // Legacy back-arm check (Y3 Octo retro dock)
    const backArm = this.armManager.arms[7]; // Back arm at retrograde position
    if (backArm) {
      const dangerStates = [
        ARM_STATES.LAUNCHING,
        ARM_STATES.DOCKING,
        ARM_STATES.REELING,
      ];
      this._thrusterInterlock = dangerStates.includes(backArm.state);
    } else {
      this._thrusterInterlock = false;
    }

    // C-9: Plume-geometry interlock (flag-gated)
    if (Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK) {
      this._plumeBlocked = getActiveBlocks(this.armManager);
      // If ANY thruster is plume-blocked, also set the legacy interlock flag
      // so existing thrust methods that check _thrusterInterlock will respect it
      if (Object.keys(this._plumeBlocked).length > 0) {
        this._thrusterInterlock = true;
      }
    } else {
      this._plumeBlocked = {};
    }

    // C-9: Compute and cache CoM (once per frame, used by HUD + torque coupling)
    if (Constants.FEATURE_FLAGS.COM_TRACKING) {
      this._comCache = computeCoM(this.armManager, this);
      this._comDriftM = computeCoMDrift(this.armManager, this);
      this._comDriftVec = computeCoMDriftVector(this.armManager, this);
    } else {
      this._comCache = null;
      this._comDriftM = 0;
      this._comDriftVec = { x: 0, y: 0, z: 0 };
    }
  }

  /**
   * Check if mothership angular velocity is safe for crossbow fire.
   * §16 Attitude Management: recoil torque is dangerous if ω too high.
   * @returns {boolean} true if safe, false if ω too high (HUD should show "STABILIZE")
   */
  isCrossbowFireSafe() {
    // If angular velocity exceeds threshold, firing would cause unpredictable torque
    const maxOmega = 0.1; // rad/s — threshold for safe fire
    if (this.angularVelocity) {
      const omega = typeof this.angularVelocity === 'number'
        ? Math.abs(this.angularVelocity)
        : this.angularVelocity.length();
      return omega < maxOmega;
    }
    return true; // No angular velocity tracking — assume safe
  }

  /**
   * Toggle automatic RCS compensation for crossbow recoil.
   * @returns {boolean} New auto-RCS state
   */
  toggleCrossbowAutoRcs() {
    this._crossbowAutoRcs = !this._crossbowAutoRcs;
    return this._crossbowAutoRcs;
  }

  /**
   * Reset V5 crossbow-related state (call on mission restart).
   */
  resetCrossbowState() {
    this._thrusterInterlock = false;
    this._plumeBlocked = {};
    this._comCache = null;
    this._comDriftM = 0;
    this._comDriftVec = { x: 0, y: 0, z: 0 };
    this._crossbowAutoRcs = true;
    this._frameRecoilDv = 0;
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;
  }

  /** @returns {boolean} Whether thruster interlock is active (back arm blocking exhaust) */
  get thrusterInterlocked() { return this._thrusterInterlock; }

  /** @returns {boolean} Whether auto-RCS compensation is enabled */
  get crossbowAutoRcs() { return this._crossbowAutoRcs; }

  /**
   * C-9: Get cached CoM computation result from this frame.
   * Only populated when COM_TRACKING flag is ON.
   * @returns {{ position: {x,y,z}, totalMass: number, breakdown: object }|null}
   */
  getCoMCache() { return this._comCache; }

  /**
   * C-9: Get cached CoM drift distance (meters) from this frame.
   * Returns 0 when COM_TRACKING flag is OFF.
   * @returns {number}
   */
  getCoMDrift() { return this._comDriftM; }

  /**
   * C-9: Get the plume-blocked thruster map from this frame.
   * @returns {Object<string, string>} Map: { thrusterId → reason }
   */
  getPlumeBlocks() { return this._plumeBlocked; }

  // ==========================================================================
  // UPGRADES
  // ==========================================================================

  /**
   * Apply a shop upgrade that affects propulsion properties.
   * Modifies the rate properties that thrustIon()/thrustColdGas() already read.
   * @param {object} data - { effect: string, value: number }
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'xenonEfficiency':
        // value=0.8 → 20% less xenon consumption per thrust tick
        this._ionThrustXenonRate = this._baseIonXenonRate * data.value;
        break;
      case 'thrustMultiplier':
        // value=1.5 → 50% more thrust delta-V per tick
        this._ionDeltaV = this._baseIonDeltaV * data.value;
        break;
      case 'coldGasThrust':
        // value=1.3 → 30% more cold gas thrust per tick
        this._coldGasDeltaV = this._baseColdGasDeltaV * data.value;
        break;
      case 'coldGasEfficiency':
        // value=0.8 → 20% less cold gas consumption per tick
        this._coldGasRate = this._baseColdGasRate * data.value;
        break;
      case 'mpdThruster':
        // F16: Unlock MPD thruster from shop purchase
        this._hasMPD = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'MPD thruster installed. Requires lithium propellant — salvage from defunct satellites.',
          priority: 'info',
        });
        break;
      case 'mpdCathodeLife':
        // Hardened Cathode upgrade — doubles cathode life
        this._mpdCathodeLife = data.value;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'Hardened tungsten-rhenium cathode installed. Cathode lifetime extended to 1,200s.',
          priority: 'info',
        });
        break;
      case 'supercapUpgrade':
        // S3b: Graphene Supercapacitor — faster thermal dissipation
        this._hasSupercap = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'POWER',
          text: 'Graphene supercapacitor bank installed. MPD thermal dissipation improved.',
          priority: 'info',
        });
        break;
    }
  }

  // ==========================================================================
  // THROTTLE (F14)
  // ==========================================================================

  /**
   * Set the throttle level (0.0–1.0). Clamps to valid range.
   * Affects all thrust methods proportionally.
   * @param {number} level — desired throttle level
   */
  setThrottleLevel(level) {
    this.throttleLevel = Math.max(0, Math.min(1, level));
    eventBus.emit(Events.THROTTLE_CHANGE, { level: this.throttleLevel });
  }

  // ==========================================================================
  // ROTATION (F13)
  // ==========================================================================

  /**
   * Apply pitch rotation (around local X axis).
   * Positive angle = nose up.
   * @param {number} angle — radians to rotate
   */
  rotatePitch(angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), angle
    );
    this._manualRotation.multiply(q);
    this._manualRotation.normalize();
  }

  /**
   * Apply yaw rotation (around local Y axis).
   * Positive angle = nose left.
   * @param {number} angle — radians to rotate
   */
  rotateYaw(angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), angle
    );
    this._manualRotation.multiply(q);
    this._manualRotation.normalize();
  }

  /**
   * Differential FEEP plume — set per-nozzle firing intensity for attitude rotation.
   * Visual only: does NOT apply torque (rotatePitch/rotateYaw handle that).
   *
   * Nozzle mapping (same-side nozzle fires, +Z = forward model convention):
   *   pitch +1 (nose up)    → HT_TOP    (idx 0, at +Y)
   *   pitch −1 (nose down)  → HT_BOTTOM (idx 1, at −Y)
   *   yaw   +1 (nose left)  → HT_LEFT   (idx 3, at −X)
   *   yaw   −1 (nose right) → HT_RIGHT  (idx 2, at +X)
   *
   * @param {'pitch'|'yaw'} axis — rotation axis
   * @param {number} sign — +1 or −1 direction
   * @param {number} magnitude — 0..1 normalised firing intensity
   */
  setThrusterFire(axis, sign, magnitude) {
    const map = Constants.DIFFERENTIAL_THRUST.NOZZLE_MAP[axis];
    if (!map) return; // unknown axis (roll etc.) — no-op
    const key = sign >= 0 ? '1' : '-1';
    const idx = map[key];
    if (idx === undefined) return;
    this._differentialFireTargets[idx] = Math.max(
      this._differentialFireTargets[idx],
      Math.min(1, magnitude)
    );
  }

  // ==========================================================================
  // THRUST
  // ==========================================================================

  /**
   * Apply ion thrust (costs fuel + battery).
   * Phase 4: fuel type determines thrustScale and consumption source.
   * @param {{ x: number, y: number, z: number }} direction
   * @param {number} dt
   */
  thrustIon(direction, dt) {
    // Power distribution: block thrust entirely if THRUST bus is at 0%
    if (powerDistribution.thrustMultiplier <= 0) {
      const now = performance.now();
      if (now - this._lastThrustOfflineWarning > 3000) {
        this._lastThrustOfflineWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ ION DRIVE OFFLINE — increase THRUST power allocation',
          priority: 'warning',
        });
      }
      return;
    }

    // V5: Thruster interlock — back arm in danger zone near FEEP thruster exhaust
    if (this._thrusterInterlock) {
      return;
    }

    // Phase 4: Get current fuel definition for thrust scaling
    const fuel = this._resourceSystem
      ? this._resourceSystem.getCurrentFuel()
      : Constants.FUELS.xenon;
    const thrustScale = fuel.thrustScale || 1.0;

    // Check battery (always required)
    if (this.resources.battery <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }

    // Check fuel availability — xenon tank for default, cargo existence for alt fuels
    if (!fuel.fromCargo && this.resources.xenon <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }

    // Apply thrust scaled by fuel's thrustScale and throttle level (F14)
    const thr = this.throttleLevel;
    this.thrustInput.x += direction.x * this._ionDeltaV * thrustScale * thr * dt;
    this.thrustInput.y += direction.y * this._ionDeltaV * thrustScale * thr * dt;
    this.thrustInput.z += direction.z * this._ionDeltaV * thrustScale * thr * dt;

    // Classify thrust direction (z = prograde/retrograde axis)
    if (direction.z > 0.5) this._thrustDirection = 'prograde';
    else if (direction.z < -0.5) this._thrustDirection = 'retrograde';
    else if (!this._thrustDirection) this._thrustDirection = 'lateral';
    this._lastThrustType = 'ion';

    // Power distribution modulates Isp/efficiency: higher mult = less fuel consumed
    const efficiencyScale = 1 / powerDistribution.thrustMultiplier;
    const fuelAmount = this._ionThrustXenonRate * dt * efficiencyScale;

    // Phase 4: Route fuel consumption through dual-mode system
    if (this._resourceSystem) {
      this._resourceSystem.consumeIonFuel(fuelAmount);
    } else {
      // Fallback: direct xenon consumption via event
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'xenon', amount: fuelAmount });
    }

    // Battery always consumed regardless of fuel type
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: this._ionThrustPowerRate * dt });

    // Phase 4: Emit thrust visual event for velocity streaks overlay
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: thr,
      direction: this._thrustDirection || 'lateral',
      type: 'ion',
    });

    // Visual: fire RCS puff opposite to thrust direction
    this._fireRcsPuff(direction);
  }

  /**
   * Apply cold-gas thrust (emergency).
   * @param {{ x: number, y: number, z: number }} direction
   * @param {number} dt
   */
  thrustColdGas(direction, dt) {
    if (this.resources.coldGas <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'coldGas' });
      return;
    }

    // F14: Scale by throttle level
    const thr = this.throttleLevel;
    this.thrustInput.x += direction.x * this._coldGasDeltaV * thr * dt;
    this.thrustInput.y += direction.y * this._coldGasDeltaV * thr * dt;
    this.thrustInput.z += direction.z * this._coldGasDeltaV * thr * dt;

    // Classify thrust direction (z = prograde/retrograde axis)
    if (direction.z > 0.5) this._thrustDirection = 'prograde';
    else if (direction.z < -0.5) this._thrustDirection = 'retrograde';
    else if (!this._thrustDirection) this._thrustDirection = 'lateral';
    this._lastThrustType = 'coldgas';

    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'coldGas', amount: this._coldGasRate * dt });

    // Phase 4: Emit thrust visual event for velocity streaks overlay
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: thr,
      direction: this._thrustDirection || 'lateral',
      type: 'coldgas',
    });

    // Visual: fire RCS puff opposite to thrust direction
    this._fireRcsPuff(direction);
  }

  /**
   * Apply MPD thrust (F16). Costs lithium + battery. High thrust, cathode erosion.
   * @param {{ x: number, y: number, z: number }} direction
   * @param {number} dt
   */
  thrustMPD(direction, dt) {
    // Guard: MPD must be unlocked
    if (!this._hasMPD) return;

    // V5: Thruster interlock — back arm in danger zone near FEEP thruster exhaust
    if (this._thrusterInterlock) return;

    // Guard: power distribution — block if THRUST bus is at 0%
    if (powerDistribution.thrustMultiplier <= 0) {
      const now = performance.now();
      if (now - this._lastThrustOfflineWarning > 3000) {
        this._lastThrustOfflineWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ MPD DRIVE OFFLINE — increase THRUST power allocation',
          priority: 'warning',
        });
      }
      return;
    }

    // Guard: need lithium
    if (this.resources.lithium <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'mpd' });
      return;
    }

    // Guard: need battery (MPD draws significant power)
    if (this.resources.battery <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_power', type: 'mpd' });
      return;
    }

    // Cathode degradation factor
    const cathodeLife = this._mpdCathodeLife;
    const degradedFactor = Constants.MPD_DEGRADED_FACTOR || 0.5;
    const cathodeFactor = this._mpdCathodeTime >= cathodeLife ? degradedFactor : 1.0;

    // Apply thrust scaled by throttle level and cathode health
    const thr = this.throttleLevel;
    const dv = this._mpdDeltaV * cathodeFactor * thr * dt;
    this.thrustInput.x += direction.x * dv;
    this.thrustInput.y += direction.y * dv;
    this.thrustInput.z += direction.z * dv;

    // Classify thrust direction
    if (direction.z > 0.5) this._thrustDirection = 'prograde';
    else if (direction.z < -0.5) this._thrustDirection = 'retrograde';
    else if (!this._thrustDirection) this._thrustDirection = 'lateral';
    this._lastThrustType = 'mpd';

    // Consume lithium
    const lithiumCost = (Constants.MPD_LITHIUM_PER_SECOND || 0.5) * dt;
    if (this._resourceSystem) {
      this._resourceSystem.consumeLithium(lithiumCost);
    } else {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'lithium', amount: lithiumCost });
    }

    // S3b: Battery degradation — reduce thrust at low battery
    const batteryFraction = this.resources.batteryMax > 0
      ? this.resources.battery / this.resources.batteryMax : 0;
    const degradeThreshold = Constants.MPD_BURST_POWER_DEGRADE || 0.05;
    const batteryThrustMult = batteryFraction <= degradeThreshold ? 0.5 : 1.0;

    // Apply battery thrust degradation to thrust input
    if (batteryThrustMult < 1.0 && !this._mpdDegraded) {
      this._mpdDegraded = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: '⚠ MPD degraded — critical power',
        priority: 'warning',
      });
    } else if (batteryThrustMult >= 1.0) {
      this._mpdDegraded = false;
    }

    // Re-scale thrust by battery degradation (applied on top of cathode factor)
    this.thrustInput.x *= batteryThrustMult;
    this.thrustInput.y *= batteryThrustMult;
    this.thrustInput.z *= batteryThrustMult;

    // Consume battery (high power draw — scaled for gameplay)
    const powerCost = (Constants.MPD_POWER_DRAW || 150) * 0.1 * dt; // 150 kW × 0.1 = 15 Wh/s battery drain (S3b)
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: powerCost });

    // Track cathode time (increment when firing)
    this._mpdCathodeTime += dt;

    // Check cathode erosion threshold — emit event once when crossed
    if (this._mpdCathodeTime >= cathodeLife &&
        this._mpdCathodeTime - dt < cathodeLife) {
      eventBus.emit(Events.MPD_CATHODE_WORN, {
        cathodeTime: this._mpdCathodeTime,
        degradedFactor,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: `⚠ MPD cathode eroded — thrust degraded to ${Math.round(degradedFactor * 100)}%`,
        priority: 'warning',
      });
    }

    // S3b: Thermal tracking
    const heatRate = Constants.MPD_BURST_HEAT_RATE || 1.0;
    this._mpdHeat += heatRate * dt;

    // Check overheat
    if (this._mpdHeat >= (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40)) {
      this._mpdArmed = false;
      this._mpdCooldownTimer = Constants.MPD_BURST_COOLDOWN_TIME || 15;
      eventBus.emit(Events.MPD_OVERHEAT, { heat: this._mpdHeat });
      eventBus.emit(Events.MPD_BURST_END, { reason: 'overheat' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: '🔥 MPD THERMAL SHUTDOWN — mandatory cooldown',
        priority: 'critical',
      });
    }

    // S3b: Battery low warning
    const warnThreshold = Constants.MPD_BURST_POWER_WARN || 0.15;
    if (batteryFraction < warnThreshold && batteryFraction > 0) {
      eventBus.emit(Events.MPD_POWER_WARNING, { batteryFraction });
    }

    // Fire event
    eventBus.emit(Events.MPD_FIRE, {
      direction,
      thrust: Constants.MPD_THRUST * cathodeFactor * thr,
      cathodeHealth: Math.max(0, 1 - this._mpdCathodeTime / cathodeLife),
    });

    // Phase 4: Emit thrust visual event for velocity streaks overlay
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: thr * cathodeFactor,
      direction: this._thrustDirection || 'lateral',
      type: 'mpd',
    });

    // Visual: fire RCS puff opposite to thrust direction (reuse existing)
    this._fireRcsPuff(direction);
  }

  /** @returns {boolean} Whether MPD thruster is unlocked */
  get hasMPD() { return this._hasMPD; }

  // ========================================================================
  // S3b: MPD BURST MODE
  // ========================================================================

  /** @returns {boolean} Whether MPD is armed (Ludicrous mode active) */
  get isMPDArmed() { return this._mpdArmed; }

  /** @returns {number} Current thermal accumulator value */
  get mpdBurstHeat() { return this._mpdHeat; }

  /** @returns {number} Heat as fraction 0–1 of overheat threshold */
  get mpdHeatFraction() {
    return this._mpdHeat / (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40);
  }

  /** @returns {number} Seconds remaining in forced cooldown (0 = ready) */
  get mpdCooldownRemaining() { return this._mpdCooldownTimer; }

  /** @returns {boolean} Whether Graphene Supercap upgrade is installed */
  get hasSupercap() { return this._hasSupercap; }

  /**
   * Toggle MPD armed state. Called from InputManager on M key.
   */
  toggleMPDArmed() {
    if (!this._hasMPD) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD thruster not installed.',
        priority: 'warning',
      });
      return;
    }
    if (this._mpdCooldownTimer > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: `MPD cooling — ${Math.ceil(this._mpdCooldownTimer)}s remaining`,
        priority: 'warning',
      });
      return;
    }
    if (this.resources.lithium <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD FUEL DEPLETED — no lithium',
        priority: 'warning',
      });
      return;
    }

    this._mpdArmed = !this._mpdArmed;
    this._mpdDegraded = false;

    if (this._mpdArmed) {
      eventBus.emit(Events.MPD_BURST_START, { armed: true });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: '⚡ MPD ARMED — Ludicrous mode active',
        priority: 'info',
      });
    } else {
      eventBus.emit(Events.MPD_BURST_END, { reason: 'manual' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD standby — ion drive resumed',
        priority: 'info',
      });
    }
  }

  /** @returns {number} Cumulative cathode operation time in seconds */
  get mpdCathodeTime() { return this._mpdCathodeTime; }

  /** @returns {number} Cathode health as fraction (1.0 = new, 0.0 = fully worn) */
  get mpdCathodeHealth() {
    return Math.max(0, 1 - this._mpdCathodeTime / this._mpdCathodeLife);
  }

  /**
   * Apply RCS cold-gas impulse for fine positioning within debris field.
   * Unlike thrustIon/thrustColdGas which change orbital elements,
   * RCS applies tiny velocity nudges to the world position directly.
   * @param {{ x: number, y: number, z: number }} direction - Normalized thrust direction in local frame
   * @param {number} dt - Delta time
   */
  applyRCS(direction, dt) {
    const impulse = Constants.RCS_IMPULSE * this.throttleLevel * dt;

    // Build local-frame axes: prograde (velocity), radial (up from Earth), cross-track
    const vel = this._cartesian.velocity;
    const vLen = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    let prograde, radialUp, crossTrack;

    if (vLen > 1e-10) {
      prograde = new THREE.Vector3(vel.x, vel.y, vel.z).normalize();
    } else {
      prograde = new THREE.Vector3(0, 0, 1);
    }
    radialUp = this.position.clone().normalize();
    crossTrack = new THREE.Vector3().crossVectors(prograde, radialUp).normalize();
    // Re-orthogonalize radialUp
    radialUp = new THREE.Vector3().crossVectors(crossTrack, prograde).normalize();

    // Map direction: W/S = prograde/retrograde (z), A/D = cross-track (x), Q/E = radial (y)
    const worldImpulse = new THREE.Vector3()
      .addScaledVector(prograde, direction.z * impulse)
      .addScaledVector(crossTrack, direction.x * impulse)
      .addScaledVector(radialUp, direction.y * impulse);

    this._rcsVelocity.add(worldImpulse);

    // Visual: fire RCS puff opposite to thrust direction
    this._fireRcsPuff(direction);

    // Phase 4: Emit thrust visual event for velocity streaks overlay (RCS)
    let rcsDir = 'lateral';
    if (direction.z > 0.5) rcsDir = 'prograde';
    else if (direction.z < -0.5) rcsDir = 'retrograde';
    else if (direction.x < -0.5) rcsDir = 'lateral-left';
    else if (direction.x > 0.5) rcsDir = 'lateral-right';
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: this.throttleLevel,
      direction: rcsDir,
      type: 'rcs',
    });

    // Clamp to max RCS speed
    const maxV = Constants.RCS_MAX_SPEED;
    if (this._rcsVelocity.length() > maxV) {
      this._rcsVelocity.normalize().multiplyScalar(maxV);
    }
  }

  /**
   * @private — Fire RCS puff sprites opposite to the given thrust direction.
   * Uses a round-robin pool of 8 sprites with per-nozzle cooldown.
   * @param {{ x: number, y: number, z: number }} direction
   */
  _fireRcsPuff(direction) {
    if (!this._rcsPuffs.length) return;
    const now = performance.now() * 0.001; // seconds
    const cooldown = 0.12; // min seconds between puffs per nozzle
    const threshold = 0.1;

    const axes = [
      { val: direction.z, pos: 'pz', neg: 'nz' },
      { val: direction.x, pos: 'px', neg: 'nx' },
      { val: direction.y, pos: 'py', neg: 'ny' },
    ];

    for (const { val, pos, neg } of axes) {
      let nozzleKey = null;
      if (val > threshold) nozzleKey = pos;
      else if (val < -threshold) nozzleKey = neg;
      if (!nozzleKey) continue;

      // Per-nozzle cooldown
      if (this._rcsPuffLastFire[nozzleKey] &&
          (now - this._rcsPuffLastFire[nozzleKey]) < cooldown) continue;
      this._rcsPuffLastFire[nozzleKey] = now;

      // Grab next sprite from pool (round-robin)
      const puff = this._rcsPuffs[this._rcsPuffIndex];
      this._rcsPuffIndex = (this._rcsPuffIndex + 1) % this._rcsPuffs.length;

      const nozzlePos = this._rcsPuffNozzles[nozzleKey];
      puff.sprite.position.copy(nozzlePos);
      puff.sprite.material.opacity = 0.6;
      puff.sprite.scale.set(M * 0.5, M * 0.5, M * 0.5);
      puff.sprite.visible = true;
      puff.startTime = now;
      puff.active = true;
    }
  }

  /**
   * @private — Animate active RCS puff sprites (fade out + slight expansion).
   * @param {number} dt — frame delta (unused; uses absolute time)
   */
  _updateRcsPuffs(dt) {
    const now = performance.now() * 0.001;
    const fadeDuration = 0.5;

    for (const puff of this._rcsPuffs) {
      if (!puff.active) continue;
      const age = now - puff.startTime;

      if (age >= fadeDuration) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        puff.active = false;
        continue;
      }

      const t = age / fadeDuration;
      puff.sprite.material.opacity = 0.6 * (1 - t);
      const s = M * (0.5 + 0.5 * t);
      puff.sprite.scale.set(s, s, s);
    }
  }

  // --------------------------------------------------------------------------
  // Strut sweep animation (Epic 10 V-3)
  // --------------------------------------------------------------------------

  /**
   * @private — Each frame: read arm aim-alpha and rotate strut pivot.
   *
   * Sweep maps getAimAlpha() (0–π) to strut orientation:
   *   α = 0   → strut along −Z (aft / stowed alongside barrel)
   *   α = π/2 → strut radially outward (equatorial)
   *   α = π   → strut along +Z (forward / zenith)
   *
   * The desired strut-tip direction from the pivot is:
   *   d(α) = sin(α) · r̂ − cos(α) · ẑ
   * where r̂ = (cos θ, sin θ, 0) is the radial-outward direction for azimuth θ.
   *
   * The pivot's local −Y axis is rotated to match d(α) using
   * `Quaternion.setFromUnitVectors()`.
   */
  _updateStruts(dt) {
    if (!this.strutGroups || !this.armManager) return;
    const arms = this.armManager.arms;
    if (!arms) return;

    for (let i = 0; i < this.strutGroups.length; i++) {
      if (i >= arms.length) break;
      const sg  = this.strutGroups[i];
      const arm = arms[i];

      // Gradual strut slew: if a target alpha was set (by , / . keys), slew toward it
      if (arm._strutTargetAlpha !== undefined && arm.setAimAlpha) {
        arm.setAimAlpha(arm._strutTargetAlpha, dt);
        // Clear target when reached (within 0.01 rad ≈ 0.6°)
        if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) {
          arm._strutTargetAlpha = undefined;
        }
      }

      // Read current sweep angle from arm FSM (default π/2 = radially out)
      let alpha = (arm.getAimAlpha ? arm.getAimAlpha() : Math.PI / 2);

      // V-11: Stowage — force α = 0 (aft, against barrel) when LOCKED or STOWED
      if (arm.getDeployState) {
        const ds = arm.getDeployState();
        if (ds === 'LOCKED' || ds === 'STOWED') {
          alpha = 0;
        }
      }

      // Compute desired strut direction: sin(α)·radial − cos(α)·Z
      // α=0 → −Z (stowed aft), α=π/2 → radial (equatorial), α=π → +Z (zenith)
      const sinA = Math.sin(alpha);
      const cosA = Math.cos(alpha);
      _strutTo.set(
        sinA * Math.cos(sg.azRad),
        sinA * Math.sin(sg.azRad),
        -cosA,
      );

      // Rotate local -Y → desired direction
      _strutQuat.setFromUnitVectors(_strutFrom, _strutTo);
      sg.pivotGroup.setRotationFromQuaternion(_strutQuat);

      // ── V-4: Update arm dockOffset to track strut tip position ──
      // Tip position in player-local frame = pivot origin + strutDir * strutLen.
      // _strutTo is already a unit vector, so multiply by cached _strutLen.
      // This runs BEFORE armManager.update() in the game loop, so when
      // arm._updateDocked() fires, it uses the updated dockOffset — the arm
      // world position naturally follows the strut tip each frame.
      if (arm.dockOffset && this._strutLen !== undefined) {
        _tipLocal.set(
          sg.pivotGroup.position.x + _strutTo.x * this._strutLen,
          sg.pivotGroup.position.y + _strutTo.y * this._strutLen,
          sg.pivotGroup.position.z + _strutTo.z * this._strutLen,
        );
        arm.dockOffset.copy(_tipLocal);

        // Reel position: 85% along strut from pivot (where the tether exits).
        // The tether anchors HERE, not at the strut tip (100%).
        const REEL_FRAC = 0.85;
        if (!arm._reelOffset) arm._reelOffset = new THREE.Vector3();
        arm._reelOffset.set(
          sg.pivotGroup.position.x + _strutTo.x * this._strutLen * REEL_FRAC,
          sg.pivotGroup.position.y + _strutTo.y * this._strutLen * REEL_FRAC,
          sg.pivotGroup.position.z + _strutTo.z * this._strutLen * REEL_FRAC,
        );

        // Cache strut direction for postArmUpdate orientation
        sg.strutDir.copy(_strutTo);
      }
    }
  }

  /**
   * V-4: Post-arm-update visibility sync.
   *
   * Must be called from the game loop AFTER `armManager.update()` so that
   * `_updateDocked()`'s unconditional `mesh.visible = false` can be overridden
   * for daughter arms whose deploy state is DEPLOYED / DEPLOYING / STOWING
   * (i.e. the strut has swept out and the arm should be visible at the tip).
   *
   * Arms in LOCKED or STOWED deploy state remain hidden (folded inside barrel).
   */
  postArmUpdate() {
    if (!this.armManager || !this.strutGroups) return;
    const arms = this.armManager.arms;
    if (!arms) return;

    const DS = Constants.DEPLOY_STATES;

    for (let i = 0; i < this.strutGroups.length; i++) {
      if (i >= arms.length) break;
      const arm = arms[i];
      const sg  = this.strutGroups[i];

      // ── V-10: Deploy State LEDs — color each hinge LED by arm deploy state ──
      if (this.hingeLEDs && this.hingeLEDs[i]) {
        const led = this.hingeLEDs[i];
        const state = arm.getDeployState ? arm.getDeployState() : DS.DEPLOYED;
        const isRecoil = arm.isHighRecoilZone ? arm.isHighRecoilZone() : false;

        let color;
        let intensity = 1.0;

        if (state === DS.LOCKED) {
          color = 0x222222;
        } else if (state === DS.STOWED) {
          color = 0x664400;
        } else if (state === DS.DEPLOYING) {
          // Pulsing blue (0.3–1.0 intensity)
          intensity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(Date.now() * 0.005));
          color = 0x0066ff;
        } else if (state === DS.STOWING) {
          // Pulsing amber (0.3–1.0 intensity)
          intensity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(Date.now() * 0.005));
          color = 0xff8800;
        } else if (state === DS.DEPLOYED && isRecoil) {
          // High recoil zone — amber override
          color = 0xff6600;
        } else {
          // Default: DEPLOYED green
          color = 0x00ff44;
        }

        led.material.color.setHex(color);
        // Dim pulsing states by scaling color channels
        if (intensity < 1.0) {
          led.material.color.multiplyScalar(intensity);
        }
      }

      // Only override visibility + orientation for DOCKED arms (strut-mounted).
      // Arms in other FSM states (TRANSIT, HAULING, etc.) manage their own visuals.
      //
      // Exceptions handled here so a SINGLE owner composes the strut basis (the
      // live sg.strutDir/azRad + mother world quat), avoiding the override-fight
      // bug class (HANDOFF §10 Rule B):
      //   • LAUNCHING (pre-spring): still clamped to the strut — track it, else the
      //     daughter counter-rotates as the ceremony slews the strut to target.
      //   • DOCKING: slerp onto the strut basis over the dock window so the arm
      //     visibly aligns itself — no orientation pop at RELOADING→DOCKED.
      //   • HOLDING_CATCH: snap to the strut basis every frame (like DOCKED) so the
      //     parked daughter holds the catch square to her strut instead of drifting
      //     toward the raw mother-bus quaternion (the wrong-basis defect, Item 4/5).
      if (arm.state !== ARM_STATES.DOCKED) {
        const trackStrut =
          (arm.state === 'LAUNCHING' && !arm._springFired) ||
          arm.state === ARM_STATES.DOCKING ||
          arm.state === ARM_STATES.HOLDING_CATCH;
        if (trackStrut && arm.group && sg.strutDir.lengthSq() > 0) {
          _composeDockedArmQuat(sg.strutDir, sg.azRad, _armQuat);
          _armDockTargetQuat.copy(this.quaternion).multiply(_armQuat);
          if (arm.state === ARM_STATES.DOCKING) {
            // Exponential approach onto the strut over the ~3 s dock window.
            // 0.12/frame ≈ converges in <1 s @60fps; smooth, no snap.
            arm.group.quaternion.slerp(_armDockTargetQuat, 0.12);
          } else {
            arm.group.quaternion.copy(_armDockTargetQuat);
          }
        }
        continue;
      }

      if (arm.getDeployState) {
        const ds = arm.getDeployState();
        const shouldShow = (ds === DS.DEPLOYED || ds === DS.DEPLOYING || ds === DS.STOWING);
        if (arm.mesh) arm.mesh.visible = shouldShow;

        // Orient arm.group so its +Z (forward) faces outward along strut
        // direction in world space.  Compose mother's full quaternion with
        // the local strut rotation so the arm inherits pitch/yaw/roll —
        // not just the forward axis.  strutDir is in player-local frame.
        //
        // SYMMETRY: use the deterministic basis (forward + azimuth-radial up)
        // instead of setFromUnitVectors, so every docked daughter shares one
        // roll convention and their body-conformal cells / panel lines stay
        // symmetric around the ring.
        if (shouldShow && arm.group && sg.strutDir.lengthSq() > 0) {
          _composeDockedArmQuat(sg.strutDir, sg.azRad, _armQuat);  // local strut rotation
          arm.group.quaternion.copy(this.quaternion).multiply(_armQuat);
        }
      }
    }
  }

  /**
   * Apply a world-frame Cartesian ΔV impulse to the orbit.
   *
   * Used by [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) to command
   * rendezvous burns independent of the element-rate channel mapping in
   * [`_applyThrust()`](js/entities/PlayerSatellite.js:2139) which is tuned
   * for manual thrust feel.
   *
   * Algorithm: take current Cartesian state (km / km/s), add the impulse
   * (converted m/s → km/s), recompute Keplerian elements via
   * [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129), write
   * back. This is equivalent to the closed-form Gauss planetary equations
   * without the approximations in `_applyThrust`.
   *
   * Side-effects: mutates `this.orbit`, refreshes `this._cartesian`, charges
   * fuel/battery, accumulates `_deltaVSpent`. Does NOT touch `_rcsVelocity`.
   *
   * @param {THREE.Vector3} dvWorld - World-frame ΔV in m/s
   * @param {number} dt - Frame delta (s) for resource bookkeeping
   */
  applyCartesianImpulse(dvWorld, dt) {
    if (!dvWorld) return;
    const dvMag = dvWorld.length();
    if (dvMag < 1e-9 || !isFinite(dvMag)) return;

    // --- Resource / power gating (mirrors thrustIon) ---
    if (powerDistribution.thrustMultiplier <= 0) {
      const now = performance.now();
      if (now - this._lastThrustOfflineWarning > 3000) {
        this._lastThrustOfflineWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ ION DRIVE OFFLINE — increase THRUST power allocation',
          priority: 'warning',
        });
      }
      return;
    }
    if (this._thrusterInterlock) return;
    if (this.resources.battery <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }
    const fuel = this._resourceSystem
      ? this._resourceSystem.getCurrentFuel()
      : (Constants.FUELS && Constants.FUELS.xenon) || null;
    if (fuel && !fuel.fromCargo && this.resources.xenon <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }

    // --- Recompute Cartesian state (km / km/s) from current orbit ---
    const pos = this._cartesian.position;   // scene units
    const vel = this._cartesian.velocity;   // km/s (unchanged by orbitToSceneCartesian)

    const rKm = {
      x: pos.x / Constants.SCENE_SCALE,
      y: pos.y / Constants.SCENE_SCALE,
      z: pos.z / Constants.SCENE_SCALE,
    };
    // Add impulse (convert m/s → km/s by × 0.001)
    const vKms = {
      x: vel.x + dvWorld.x * 0.001,
      y: vel.y + dvWorld.y * 0.001,
      z: vel.z + dvWorld.z * 0.001,
    };

    const newOrbit = cartesianToKeplerian(rKm, vKms);
    if (!isFinite(newOrbit.semiMajorAxis) || newOrbit.semiMajorAxis <= 0) return;

    // Altitude guard (same envelope as _applyThrust)
    const newSmaScene = newOrbit.semiMajorAxis * Constants.SCENE_SCALE;
    const minAlt = Constants.VLEO_MIN + Constants.EARTH_RADIUS;
    const maxAlt = Constants.LEO_MAX + Constants.EARTH_RADIUS;
    if (newSmaScene < minAlt || newSmaScene > maxAlt) {
      // Refuse the burn rather than silently clip — keeps orbital energy accounting honest
      return;
    }

    // --- Write back Keplerian elements ---
    this.orbit.semiMajorAxis = newSmaScene;
    this.orbit.eccentricity = Math.max(0, Math.min(0.1, newOrbit.eccentricity));
    this.orbit.inclination = newOrbit.inclination;
    this.orbit.raan = newOrbit.raan;
    this.orbit.argPerigee = newOrbit.argPerigee;
    this.orbit.trueAnomaly = newOrbit.trueAnomaly;
    this.orbit.meanMotion = newOrbit.meanMotion;

    // Refresh cached Cartesian so subsequent getVelocity/getPosition reads see the new state
    this._cartesian = orbitToSceneCartesian(this.orbit);

    // --- Bookkeeping ---
    this._deltaVSpent += dvMag;

    // Resource consumption: scale with |dv| vs. one ion-thrust tick baseline.
    const baselineDv_mps =
      (this._ionDeltaV || 0.0003) * (this.throttleLevel || 1) * 1000; // rough m/s per tick proxy
    const usage = baselineDv_mps > 1e-6
      ? Math.min(5.0, dvMag / baselineDv_mps)
      : 1.0;
    const fuelAmount = this._ionThrustXenonRate * dt * usage;
    const batteryAmount = this._ionThrustPowerRate * dt * usage;

    if (this._resourceSystem) {
      this._resourceSystem.consumeIonFuel(fuelAmount);
    } else {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'xenon', amount: fuelAmount });
    }
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: batteryAmount });

    // --- Visual: fire RCS puff opposite to the impulse direction (in local frame) ---
    const localDir = dvWorld.clone().applyQuaternion(
      this.quaternion.clone().invert()
    ).normalize();
    this._fireRcsPuff({ x: localDir.x, y: localDir.y, z: localDir.z });

    // Velocity-streaks visual
    const dirTag = Math.abs(localDir.z) > Math.max(Math.abs(localDir.x), Math.abs(localDir.y))
      ? (localDir.z > 0 ? 'prograde' : 'retrograde')
      : 'lateral';
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: Math.min(1, dvMag * 0.5),
      direction: dirTag,
      type: 'ion',
    });

  }

  /** @private */
  _applyThrust(gameDt) {
    const ti = this.thrustInput;
    const mag = Math.sqrt(ti.x * ti.x + ti.y * ti.y + ti.z * ti.z);
    if (mag < 1e-12) {
      ti.x = ti.y = ti.z = 0;
      return;
    }

    // Accumulate ΔV spent (mag is the actual |Δv| applied this tick)
    this._deltaVSpent += mag;

    const aKm = this.orbit.semiMajorAxis / Constants.SCENE_SCALE;
    const v = orbitalVelocity(aKm, aKm, Constants.MU_EARTH);

    if (Math.abs(ti.z) > 1e-14) {
      const da = 2 * aKm * ti.z / v;
      this.orbit.semiMajorAxis += da * Constants.SCENE_SCALE;
    }

    if (Math.abs(ti.y) > 1e-14) {
      this.orbit.inclination += ti.y / v;
    }

    if (Math.abs(ti.x) > 1e-14) {
      this.orbit.eccentricity += ti.x / (2 * v);
      this.orbit.eccentricity = Math.max(0, Math.min(0.1, this.orbit.eccentricity));
    }

    // C-9: CoM-offset induced torque coupling (COM_TRACKING flag-gated).
    // When asymmetric arm deployment shifts CoM off the thrust line, linear thrust
    // induces a torque τ = r × F. Uses the DRIFT vector (actual − balanced)
    // to isolate player-caused asymmetry from the permanent collar offset.
    // Simplified model: perpendicular drift / barrel length = angular tilt,
    // leaking z-thrust into inclination (y) and eccentricity (x) perturbations.
    if (Constants.FEATURE_FLAGS.COM_TRACKING && this._comDriftM > 1e-8 && mag > 1e-12) {
      const cp = this._comDriftVec; // drift vector, NOT raw CoM position
      const perpSq = cp.x * cp.x + cp.y * cp.y; // XY drift from Z-axis thrust line
      if (perpSq > 1e-12) {
        const barrelLen = Constants.OCTOPUS_V5.CORE_LENGTH; // 2.0 m
        const perpDist = Math.sqrt(perpSq);
        const tiltRad = perpDist / barrelLen; // small-angle approx (typ. < 0.01 rad)
        const leakDv = mag * tiltRad; // ΔV leaked into cross-track
        // Direction of leak = normalize(comXY) — tells which way thrust tilts
        const invPerp = 1 / perpDist;
        const leakY = leakDv * (cp.y * invPerp); // inclination leak
        const leakX = leakDv * (cp.x * invPerp); // eccentricity leak
        if (Math.abs(leakY) > 1e-16) {
          this.orbit.inclination += leakY / v;
        }
        if (Math.abs(leakX) > 1e-16) {
          this.orbit.eccentricity += leakX / (2 * v);
          this.orbit.eccentricity = Math.max(0, Math.min(0.1, this.orbit.eccentricity));
        }
      }
    }

    const minAlt = Constants.VLEO_MIN + Constants.EARTH_RADIUS;
    const maxAlt = Constants.LEO_MAX + Constants.EARTH_RADIUS;
    this.orbit.semiMajorAxis = Math.max(minAlt, Math.min(maxAlt, this.orbit.semiMajorAxis));

    ti.x = ti.y = ti.z = 0;
  }

  // ==========================================================================
  // POSITION & ORIENTATION
  // ==========================================================================

  /** @private */
  _updateCartesian() {
    this._cartesian = orbitToSceneCartesian(this.orbit);
  }

  /** @private */
  _applyPosition() {
    const p = this._cartesian.position;
    this.position.set(p.x, p.y, p.z);
  }

  /** @private Orient the satellite so +Z faces velocity direction (slerp-damped),
   *  then apply manual rotation offset (F13) */
  _orientAlongVelocity() {
    // Autopilot has exclusive orientation control — skip prograde tracking entirely
    if (this.autopilotEngaged) return;

    const v = this._cartesian.velocity;
    const vLen = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (vLen < 1e-10) return;

    const velDir = new THREE.Vector3(v.x, v.y, v.z).normalize();
    const radial = this.position.clone().normalize();

    // lookAt: eye=pos+vel, target=pos → +Z = velDir (model +Z = forward/prograde).
    // Model convention: thrusters at -Z (aft), sensors at +Z (fore).
    const mat = new THREE.Matrix4();
    const eye = this.position.clone().add(velDir);
    mat.lookAt(eye, this.position, radial);

    // Slerp toward velocity heading — preserves spin momentum on startup
    const targetQuat = new THREE.Quaternion().setFromRotationMatrix(mat);
    this.quaternion.slerp(targetQuat, 0.02); // Low alpha = slow settling, longer spin

    // F13: Apply manual rotation offset on top of velocity alignment
    if (this._manualRotation.x !== 0 || this._manualRotation.y !== 0 || this._manualRotation.z !== 0) {
      this.quaternion.multiply(this._manualRotation);
      this.quaternion.normalize();
    }

    // F13: Decay manual rotation slowly back to identity when not actively rotating
    this._manualRotation.slerp(new THREE.Quaternion(), 0.01);
  }

  // ==========================================================================
  // SOLAR POWER
  // ==========================================================================

  /** @private */
  _updateSolarPower(sunDirection) {
    if (!sunDirection) {
      this.resources.solarRate = 0;
      return;
    }

    const panelNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
    const sunAngle = Math.max(0, panelNormal.dot(sunDirection));

    const pos = this._cartesian.position;
    const sunDir = { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z };
    const inShadow = isInShadow(pos, sunDir, Constants.EARTH_RADIUS);

    if (inShadow) {
      this.resources.solarRate = 0;
    } else {
      this.resources.solarRate =
        Constants.SOLAR_FLUX *
        Constants.SOLAR_PANEL_AREA *
        Constants.SOLAR_PANEL_EFFICIENCY *
        sunAngle *
        this.resources.solarPanelHealth;
    }
  }

  // ==========================================================================
  // RESOURCES
  // ==========================================================================

  /** @private */
  _updateResources(dt) {
    // Base power draw routed through ResourceSystem (canonical owner)
    const powerDraw = this._basePowerDraw * dt;
    if (powerDraw > 0) {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: powerDraw });
    }

    // Low-resource warnings (reads from player.resources, pushed by ResourceSystem)
    if (this.resources.battery < 10) {
      eventBus.emit(Events.PLAYER_LOW_BATTERY, { level: this.resources.battery });
    }
    if (this.resources.xenon < 10) {
      eventBus.emit(Events.PLAYER_LOW_XENON, { level: this.resources.xenon });
    }
  }

  /**
   * Consume a resource — delegates to ResourceSystem via eventBus.
   * PlayerSatellite.resources is a read-only view; ResourceSystem is the
   * canonical owner and will push updated values back via _syncToPlayer().
   * @param {string} type - 'xenon' | 'coldGas' | 'battery'
   * @param {number} amount
   * @returns {boolean}
   */
  consumeResource(type, amount) {
    if (this.resources[type] === undefined) return false;
    if (this.resources[type] <= 0) {
      return false;
    }

    eventBus.emit(Events.RESOURCE_CONSUME, { resource: type, amount });
    return true;
  }

  // ==========================================================================
  // GETTERS
  // ==========================================================================

  /** @returns {THREE.Vector3} */
  getPosition() {
    return this.position.clone();
  }

  /** @returns {{ x: number, y: number, z: number }} */
  getVelocity() {
    return { ...this._cartesian.velocity };
  }

  // ==========================================================================
  // EDT — Electrodynamic Tether (Phase 6)
  // ==========================================================================

  /** Toggle EDT deployment on/off. */
  toggleEDT() {
    if (!this._edtActive && !this._edtDeployed) {
      // Start deploying
      this._edtDeployed = true;
      this._edtDeployTimer = 0;
      this._edtActive = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'Deploying electrodynamic tether...', priority: 'info',
      });
    } else if (this._edtActive) {
      // Retract
      this._edtDeployed = false;
      this._edtActive = false;
      eventBus.emit(Events.EDT_RETRACT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'EDT retracted', priority: 'info',
      });
    } else if (this._edtDeployed && !this._edtActive) {
      // Still deploying — cancel
      this._edtDeployed = false;
      this._edtDeployTimer = 0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'EDT deployment cancelled', priority: 'info',
      });
    }
  }

  /** @returns {boolean} Whether EDT is actively attracting debris */
  isEDTActive() { return this._edtActive; }

  /** @returns {boolean} Whether EDT is deployed (may still be deploying) */
  isEDTDeployed() { return this._edtDeployed; }

  /** @returns {object} */
  getOrbitalElements() {
    return { ...this.orbit };
  }

  /** @returns {number} */
  getAltitudeKm() {
    return (this.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
  }

  /** @returns {number} Cumulative ΔV spent in km/s game units */
  getDeltaVSpent() {
    return this._deltaVSpent;
  }

  /** @returns {string|null} 'prograde' | 'retrograde' | 'lateral' | null */
  getThrustDirection() {
    return this._thrustDirection;
  }

  /** @returns {string|null} 'ion' | 'coldgas' | null */
  getLastThrustType() {
    return this._lastThrustType;
  }

  /**
   * Delegation 2 (2026-05-31) — onboarding "struts" beat helper.
   *
   * Briefly brightens every strut's emissive channel to a cyan glow so the
   * player can see what their `,` / `.` keypress just animated.  Self-clears
   * after `durationMs`.  Calling again while a highlight is live extends the
   * timer (idempotent).  Labels are NOT rendered — kept to a glow-only pass
   * since the screen-space label primitive is out of scope for this delegation.
   *
   * @param {number} [durationMs=4000]
   * @returns {boolean} true if struts exist and the highlight was applied
   */
  highlightStrutsForBeat(durationMs = 4000) {
    if (!Array.isArray(this.strutMeshes) || this.strutMeshes.length === 0) return false;
    // Mesh materials may be shared across all struts — collect the unique set.
    const uniqueMats = new Set();
    for (const s of this.strutMeshes) {
      if (s && s.material) uniqueMats.add(s.material);
    }
    if (uniqueMats.size === 0) return false;
    // Record original emissive values once per session (so we can restore).
    if (!this._strutEmissiveOriginal) {
      this._strutEmissiveOriginal = new Map();
      for (const m of uniqueMats) {
        if (m.emissive && typeof m.emissive.clone === 'function') {
          this._strutEmissiveOriginal.set(m, m.emissive.clone());
        }
      }
    }
    // Apply cyan glow.
    for (const m of uniqueMats) {
      if (m.emissive && typeof m.emissive.setRGB === 'function') {
        m.emissive.setRGB(0.05, 0.55, 0.75);
        m.emissiveIntensity = 1.0;
        m.needsUpdate = true;
      }
    }
    // (Re-)arm restore timer.
    if (this._strutHighlightTimer != null && typeof clearTimeout === 'function') {
      clearTimeout(this._strutHighlightTimer);
    }
    if (typeof setTimeout === 'function') {
      this._strutHighlightTimer = setTimeout(() => {
        this._strutHighlightTimer = null;
        const orig = this._strutEmissiveOriginal;
        if (!orig) return;
        for (const [m, c] of orig) {
          if (m && m.emissive && typeof m.emissive.copy === 'function') {
            m.emissive.copy(c);
            m.needsUpdate = true;
          }
        }
      }, durationMs);
    }
    // Emit strut-labels event so StrutLabels overlay can visualize tip positions.
    // Delegation 4 (2026-05-31) — Quick-Win 2b / P1-3: enrich each entry with
    // the authoritative `hingeAngleDeg` read from the partner arm's aimAlpha
    // so labels can render the real strut sweep angle instead of the legacy
    // Euler-magnitude proxy.  Falls back to 0° when an arm slot is empty.
    const arms = this.armManager?.arms || [];
    const RAD2DEG = 180 / Math.PI;
    const sgPayload = (this.strutGroups || []).map((sg, i) => {
      const arm = arms[i];
      const alphaRad = (arm && typeof arm.getAimAlpha === 'function')
        ? arm.getAimAlpha()
        : 0;
      return {
        pivotGroup: sg.pivotGroup,
        strut:      sg.strut,
        tipNode:    sg.tipNode,
        azRad:      sg.azRad,
        hingeAngleDeg: Math.round(alphaRad * RAD2DEG),
      };
    });
    eventBus.emit(Events.STRUT_LABELS_SHOW, {
      strutGroups: sgPayload,
      durationMs,
    });
    return true;
  }
}

export default PlayerSatellite;
