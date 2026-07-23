/**
 * LassoSystem.js — Short-range magnetic/adhesive projectile for quick debris grabs.
 * SPACE key fires a lasso toward the nearest debris within range.
 * Auto-aim assist (±30° cone) makes first catches easy.
 * ST-2.4 → FIX-2.4a: Weighted capture net — spinning octagonal net with perimeter weights,
 *   tube tether, radial sparks on contact.
 * @module systems/LassoSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';
import { classifyNetTarget } from './netRouting.js';
import { NetMeshKit } from '../ui/NetMeshKit.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

/** 1 meter in scene units (1 unit = 100 km = 100000 m) */
const M = 0.00001;

/** Reusable Z-axis vector for quaternion math */
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Reusable −Z axis — the NetMeshKit mouth points along local −Z, so the net
 *  group is oriented so local −Z maps onto the flight direction (see update()). */
const _negZAxis = new THREE.Vector3(0, 0, -1);

/** Reusable zero vector for reel-in lerp target */
const _zeroVec = new THREE.Vector3(0, 0, 0);

/** Default forward dir when the ship has no velocity (mirrors fire()'s legacy +Z). */
const _defaultForward = new THREE.Vector3(0, 0, 1);

/** Module-level scratch vectors — avoid per-frame allocation in the arc test. */
const _scratchFwd = new THREE.Vector3();
const _scratchToTarget = new THREE.Vector3();
/** Phase 1B — scratch for the per-frame muzzle world position. */
const _scratchMuzzle = new THREE.Vector3();
/** Phase 4 — scratch for the local-frame basis used by aft cargo cells. */
const _scratchRadial = new THREE.Vector3();
const _scratchCross = new THREE.Vector3();
const _scratchCargoOffset = new THREE.Vector3();
/** Tether — scratch for the nadir (planet-down) sag direction + flight anchor. */
const _scratchNadir = new THREE.Vector3();
const _scratchTetherAnchor = new THREE.Vector3();

export class LassoSystem {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this.scene = scene;

        /** @type {boolean} Whether a lasso is currently in flight */
        this.active = false;

        /** @type {THREE.Vector3|null} Lasso projectile position */
        this.projectilePos = null;

        /** @type {THREE.Vector3|null} Lasso velocity */
        this.projectileVel = null;

        /** @type {object|null} Target debris (from getDebrisNear result) */
        this.target = null;

        /** @type {object|null} Debris currently held by the reel-in pin
         *  (_armPinned/_armPinPos), tracked so it can be released on reset even
         *  after this.target is cleared. */
        this._reelPinTarget = null;

        /** @type {string|null} Target debris ID for live lookup */
        this._targetId = null;

        /** @type {THREE.Vector3|null} Live target scene position (updated each frame) */
        this._targetScenePos = null;

        /** @type {THREE.Vector3} Offset of projectile relative to player (local frame) */
        this._projOffset = new THREE.Vector3();

        /** @type {number} Phase 1A — per-shot contact radius (scene units), scaled by launch distance. */
        this._contactRadiusScene = Constants.LASSO_CONTACT_RADIUS_M * M;

        /** @type {number} Phase 1A — per-shot eased apparent flight speed (scene units / real second). */
        this._flightSpeedScene = Constants.LASSO_SPEED * M * Constants.TIME_SCALE_GAMEPLAY;

        /** @type {THREE.Vector3|null} Phase 1C — last launch direction (world), for cosmetic recoil. */
        this._lastLaunchDir = null;

        /** @type {object|null} Phase 1C — PlayerSatellite for cosmetic recoil kick (optional). */
        this._player = null;

        /** @type {number} Flight timer */
        this.flightTimer = 0;

        /** @type {number} Max flight time before lasso retracts */
        this.maxFlightTime = Constants.LASSO_MAX_FLIGHT_TIME;

        /** @type {number} Cooldown between casts */
        this.cooldown = 0;

        /** @type {THREE.Mesh|null} Tether outer sheath mesh (dark, thick — coaxial) */
        this._tetherMesh = null;

        /** @type {THREE.Mesh|null} Tether inner core mesh (bright, thin — coaxial v2) */
        this._tetherCore = null;

        /** @type {number} Pulse bead phase (legacy — kept for reset compat) */
        this._pulsePhase = 0;

        /** @type {THREE.QuadraticBezierCurve3|null} Most recently built tether curve */
        this._tetherCurve = null;

        /** @type {THREE.Group|null} Capture net projectile group (FIX-2.4a — replaces bolas) */
        this._netGroup = null;

        /** @type {boolean} Reel-in phase */
        this._reelingIn = false;

        /** @type {number} Reel progress 0-1 */
        this._reelProgress = 0;

        /** @type {THREE.Vector3} Reel start offset from player (relative coords — orbit-safe) */
        this._reelStartOffset = new THREE.Vector3();

        // Phase 6: Visual feedback state
        /** @type {number} Running time for animations */
        this._time = 0;

        /** @type {THREE.Mesh|null} Muzzle flash */
        this._muzzleFlash = null;
        /** @type {number} Muzzle flash timer (seconds remaining) */
        this._muzzleFlashTimer = 0;

        /** @type {THREE.Mesh|null} Contact flash */
        this._contactFlash = null;
        /** @type {number} Contact flash timer */
        this._contactFlashTimer = 0;

        /** @type {number} Accumulated net spin angle (radians) */
        this._netSpinAngle = 0;

        /** @type {number} Number of curve sample points for tether */
        this._tetherSampleCount = Constants.NET_TETHER_SEGMENTS + 1;

        /** @type {number} Max cooldown duration (for UI reference) — driven by Constants */
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;

        /** @type {boolean} Whether the first-cast comms primer has been sent this session */
        this._firstCastPrimerSent = false;

        /** @type {number} UX-3 #7 — remaining web tether ammo */
        this._ammo = Constants.LASSO_AMMO_MAX;

        /** @type {number|null} Target id we last announced as "in lasso range",
         *  so the proactive prompt fires once per entry (not every frame). */
        this._inRangePromptId = null;

        /** @type {boolean} True while the OnboardingDirector pipeline is running.
         *  The proactive in-range "Press N" prompt is the Director's job during
         *  onboarding (the `lasso` beat teaches it), so we suppress the system
         *  prompt until ONBOARDING_COMPLETE to avoid contradicting the Director
         *  (it would otherwise punch through tier 0 and appear over early beats). */
        this._onboardingActive = false;
        // Capture unsubscribe handles so dispose() can tear these down — without
        // this the closures keep a disposed LassoSystem alive on the eventBus and
        // its stale callbacks keep mutating _onboardingActive / _inRangePromptId.
        this._evtUnsubs = [
            eventBus.on(Events.ONBOARDING_STARTED, () => { this._onboardingActive = true; }),
            eventBus.on(Events.ONBOARDING_COMPLETE, () => { this._onboardingActive = false; }),
            eventBus.on(Events.GAME_RESET, () => { this._inRangePromptId = null; this._cargo = []; }),
            // Phase 3: track the active mission so reel-in physics can be gated OFF
            // on Mission 1 (the tutorial reels exactly as today, flag regardless).
            eventBus.on(Events.MISSION_START, (data) => {
                this._missionNumber = (data && data.missionNumber != null) ? data.missionNumber : 1;
            }),
            // Diagnostics: trace the key lifecycle events when window.__lassoDebug is on.
            eventBus.on(Events.LASSO_DENIED, (e) => this._trace('DENIED', e)),
            eventBus.on(Events.LASSO_CONTACT, (e) => this._trace('CONTACT', e)),
            eventBus.on(Events.LASSO_STOWED, (e) => this._trace('STOWED', e)),
            eventBus.on(Events.LASSO_SNAPPED, (e) => this._trace('SNAPPED', e)),
            eventBus.on(Events.LASSO_CAPTURED, (e) => this._trace('CAPTURED', e)),
            eventBus.on(Events.CATCH_BREAKDOWN_START, (e) => { if (e && e.armId === 'lasso') this._trace('FURNACE_START', e); }),
            eventBus.on(Events.CATCH_PROCESSED, (e) => { if (e && e.armId === 'lasso') this._trace('FURNACE_PROCESSED', e); }),
        ];

        /** @type {number} Phase 3 — active mission number (1 = tutorial; gates reel physics). */
        this._missionNumber = 1;

        /** @type {boolean} Phase 3 — whether reel-in physics is active for the CURRENT catch
         *  (flag ON && !isMission1 && capturedMass > LASSO_MAX_CAPTURE_MASS). Latched at contact. */
        this._reelPhysicsActive = false;

        /** @type {number} Phase 3 — seconds the tether has spent above the safe strain fraction. */
        this._strainTimer = 0;

        /** @type {Array<object>} Phase 4 — stowed catches awaiting/undergoing furnace breakdown.
         *  Each: { target, cellIndex, furnaceTimer, breakdownStarted }. Persists across casts. */
        this._cargo = [];

        /** @type {number} Phase 4 — cargo cell index chosen for the in-flight catch (−1 = none). */
        this._reelCellIndex = -1;

        /** @type {object|null} Optional SkillsSystem for hint-gating (Phase 3).
         *  Wired via setSkillsSystem(); when absent the prompt fires ungated
         *  (Node tests / headless). */
        this._skillsSystem = null;
        // Feed lasso failures into the recent-failure ring buffer so a STRUGGLING
        // player still gets the proactive nudge while an expert who never fails
        // does not. SkillsSystem records these on the LASSO_DENIED event itself
        // (catalog FAILURE_CAUSES), so no extra wiring is needed here.
        // ── Gossamer particle trail state ──────────────────────────────────
        /** @type {THREE.Points|null} Particle system for gossamer silk trail */
        this._trailPoints = null;
        /** @type {Float32Array} Particle positions (x,y,z per particle) */
        this._trailPositions = null;
        /** @type {Float32Array} Particle alphas (1 per particle) */
        this._trailAlphas = null;
        /** @type {Float32Array} Particle birth times (1 per particle) */
        this._trailBirths = null;
        /** @type {Float32Array} Particle drift velocities (x,y,z per particle) */
        this._trailDrift = null;
        /** @type {number} Next particle slot index (ring buffer) */
        this._trailHead = 0;
        /** @type {number} Trail particle count */
        this._trailCount = 200;
        /** @type {number} Particle lifetime in seconds */
        this._trailLifetime = 1.0;
        /** @type {number} Emit accumulator */
        this._trailEmitAccum = 0;

        this._createVisuals();

        /** @type {number} Diagnostics — throttle counter for per-frame trace logs. */
        this._dbgFrame = 0;
        // Diagnostics: expose the live instance + a state dumper so issues can be
        // inspected from the browser console without a rebuild. Enable tracing with
        //   window.__lassoDebug = true
        // then fire a net (N). Snapshot anytime with window.__lassoState().
        if (typeof window !== 'undefined') {
            window.__lasso = this;
            window.__lassoState = () => this._dbgSnapshot();
            // Live flag toggle for A/B testing without a rebuild/restart, e.g.:
            //   window.__lassoFlags()                       → read current
            //   window.__lassoFlags({ stow:false, phys:false }) → revert Phase 3/4
            //   window.__lassoFlags({ kin:false })          → disable net open/cinch
            window.__lassoFlags = (set) => {
                const F = Constants.FEATURE_FLAGS;
                if (set && typeof set === 'object') {
                    if ('kin' in set) F.LASSO_NET_KINEMATICS = !!set.kin;
                    if ('phys' in set) F.LASSO_REEL_PHYSICS = !!set.phys;
                    if ('stow' in set) F.MOTHER_CARGO_STOW = !!set.stow;
                }
                const now = {
                    kin: F.LASSO_NET_KINEMATICS,
                    phys: F.LASSO_REEL_PHYSICS,
                    stow: F.MOTHER_CARGO_STOW,
                };
                console.log('[lasso] flags', now);
                return now;
            };
        }
    }

    /** Diagnostics — true when console tracing is enabled (browser only). */
    _dbg() {
        return typeof window !== 'undefined' && window.__lassoDebug === true;
    }

    /** Diagnostics — one-line tagged console log when tracing is on. */
    _trace(tag, obj) {
        if (this._dbg()) console.log(`[lasso] ${tag}`, obj || '');
    }

    /** Diagnostics — current lifecycle snapshot (numbers in metres where noted). */
    _dbgSnapshot() {
        const M = 0.00001;
        const off = (this.projectilePos && this._lastPlayerPos)
            ? this.projectilePos.distanceTo(this._lastPlayerPos) / M : null;
        return {
            flags: {
                NET_KINEMATICS: Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS,
                REEL_PHYSICS: Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS,
                CARGO_STOW: Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW,
                REALITY_MODE: Constants.FEATURE_FLAGS.REALITY_MODE,
            },
            active: this.active,
            reelingIn: this._reelingIn,
            reelProgress: +(this._reelProgress || 0).toFixed(3),
            flightTimer: +(this.flightTimer || 0).toFixed(3),
            cooldown: +(this.cooldown || 0).toFixed(2),
            ammo: this._ammo,
            missionNumber: this._missionNumber,
            reelCellIndex: this._reelCellIndex,
            reelPhysicsActive: this._reelPhysicsActive,
            cargoCount: this._cargo.length,
            cargo: this._cargo.map(c => ({ id: c.target && c.target.id, cell: c.cellIndex, t: +c.furnaceTimer.toFixed(2), chop: c.breakdownStarted })),
            projOffsetFromPlayer_m: off != null ? +off.toFixed(2) : null,
            target: this.target ? { id: this.target.id, mass: this.target.mass, type: this.target.type } : null,
            constants: {
                MIN_FLIGHT_TIME: Constants.LASSO_MIN_FLIGHT_TIME,
                MUZZLE_OFFSET_M: Constants.LASSO_MUZZLE_OFFSET_M,
                CARGO_CELLS: Constants.MOTHER_CARGO_CELLS,
                FURNACE_FEED_S: Constants.FURNACE_TRANSFER.FEED_S,
            },
        };
    }

    /**
     * Inject the SkillsSystem so the proactive in-range prompt obeys the
     * universal hint-gating rule (mastered ⇒ silent; veteran ⇒ ticker; silent
     * after MAX_UNHEEDED_NUDGES). Optional — when unset the prompt is ungated.
     * @param {object} skillsSystem
     */
    setSkillsSystem(skillsSystem) {
        this._skillsSystem = skillsSystem || null;
    }

    /**
     * Resolve the forward firing direction for the arc constraint. Single source
     * of truth shared by fire() (the authoritative gate) and the proactive
     * in-range invite, so the invite can never advertise a cast fire() will then
     * reject. Falls back to +Z when the ship has no velocity (matches fire()'s
     * legacy behaviour). Writes into `out` (a scratch vector) to avoid per-frame
     * allocation; returns `out`.
     * @param {THREE.Vector3|null} playerVelDir — prograde dir (may be null/zero)
     * @param {THREE.Vector3} out — scratch target
     * @returns {THREE.Vector3} normalized forward direction
     * @private
     */
    _resolveForwardDir(playerVelDir, out) {
        if (playerVelDir && playerVelDir.lengthSq() > 0) {
            return out.copy(playerVelDir).normalize();
        }
        return out.copy(_defaultForward);
    }

    /**
     * Phase 1B: world position of the front-centre launcher muzzle — along the
     * nose (+Z/prograde) at LASSO_MUZZLE_OFFSET_M ahead of the hull centre. The
     * net spawns here and the tether anchors here so the throw reads as leaving
     * a front launcher, not the hull centroid. Recomputed every frame so it
     * tracks the nose as the ship reorients along velocity.
     * @param {THREE.Vector3} playerPos
     * @param {THREE.Vector3|null} playerVelDir — prograde dir (may be null/zero)
     * @param {THREE.Vector3} out — scratch target (returned)
     * @returns {THREE.Vector3} world muzzle position
     * @private
     */
    _computeMuzzleWorld(playerPos, playerVelDir, out) {
        const fwd = this._resolveForwardDir(playerVelDir, _scratchFwd);
        return out.copy(playerPos).addScaledVector(fwd, Constants.LASSO_MUZZLE_OFFSET_M * M);
    }

    /**
     * Tether anchor for the OUTBOUND (flight) phase. Unlike the muzzle (which
     * sits LASSO_MUZZLE_OFFSET_M along the *velocity* vector), this anchor sits a
     * short way from the hull along the direction to the *net* — i.e. it is
     * always collinear with the tether. Anchoring along velocity put the start
     * point off the tether's line whenever the cast direction ≠ prograde (the
     * common case — the net flies at the target, not along velocity), which bowed
     * the strand into an arch that looped over the mother and read as a detached
     * tether (owner: "tether seems disconnect from mother"). Pointing the anchor
     * at the net keeps the strand straight from the nose to the net and clearly
     * attached. Offset is clamped small so it hugs the hull at the in-game framing.
     * @param {THREE.Vector3} playerPos hull centre (world)
     * @param {THREE.Vector3} netPos    projectile/net position (world)
     * @param {THREE.Vector3} out       scratch target (returned)
     * @returns {THREE.Vector3} world tether anchor
     * @private
     */
    _computeTetherAnchor(playerPos, netPos, out) {
        // out = (net − player) delta. NOTE: keep all math on `out` itself — do
        // NOT alias a separate `dir` handle to it; an earlier version did
        // `const dir = out.copy(...)` then `out.copy(playerPos).addScaledVector(dir,…)`,
        // which (since dir===out) added playerPos·off and parked the anchor ~100 m
        // radially outward — the tether then stretched to a wrong point in flight
        // and snapped back to the hull at reel ("tether jumps to wrong position").
        out.copy(netPos).sub(playerPos);
        const dist = out.length();
        if (dist < 1e-9) return out.copy(playerPos);
        // Anchor at the NOSE TIP, not the 8 m spawn muzzle. LASSO_MUZZLE_OFFSET_M
        // (where the projectile spawns + the muzzle flash sits) is ~4 ship-lengths
        // ahead of the hull; anchoring the *tether* there left a large empty gap
        // between the mother and the strand at the in-game framing, reading as a
        // detached tether. The hull (OCTOPUS_V5 core ≈ 2 m) reads as connected
        // when the strand starts within ~1.5 m of centre, so clamp hard to the
        // nose and shrink further for very short throws. Direction is toward the
        // net (collinear with the tether) so the strand never arches off-axis.
        const off = Math.min(1.5 * M, dist * 0.5);
        // Scale the delta to length `off` (toward the net), then offset from the
        // hull — single-buffer, no aliasing.
        return out.multiplyScalar(off / dist).add(playerPos);
    }

    /**
     * Phase 1C: trigger a brief cosmetic recoil kick of the mother mesh opposite
     * the launch direction. This is VISUAL ONLY — no orbit change, no fuel, no
     * _rcsVelocity — so it cannot disturb the M1 station-keep / pin. The kick
     * offset is applied to the player model group and springs back via a
     * critically-damped decay in PlayerSatellite. Falls back to a no-op when no
     * player model is wired (headless tests).
     * @param {THREE.Vector3} launchDir — normalized world launch direction
     * @private
     */
    _launchRecoil(launchDir) {
        if (!this._player || typeof this._player.applyCosmeticRecoil !== 'function') return;
        if (!launchDir) return;
        this._player.applyCosmeticRecoil(
            launchDir.clone().multiplyScalar(-Constants.LASSO_RECOIL_KICK_M * M)
        );
    }

    /**
     * Wire the PlayerSatellite so the cosmetic launch recoil (Phase 1C) can kick
     * the hull mesh. Optional — when unset the recoil is a no-op (headless tests).
     * @param {object} player — PlayerSatellite with applyCosmeticRecoil(offsetVec)
     */
    setPlayer(player) {
        this._player = player || null;
    }

    /**
     * Phase 4: world position of a cargo cell, in the mother's local frame
     * (prograde / radial-up / cross-track — cf. PlayerSatellite.js:3705-3715).
     * Cells sit just FORWARD of the hull (near the launch muzzle) with a small
     * cross-track spread, so the reeled catch returns toward the nose it was
     * thrown from and is NEVER hauled straight through the hull to the rear
     * (that read as the net "overshooting the mother on return"). Recomputed each
     * frame so stowed catches ride the hull as it reorients along velocity.
     * @param {THREE.Vector3} playerPos
     * @param {THREE.Vector3|null} playerVelDir
     * @param {number} cellIndex
     * @param {THREE.Vector3} out
     * @returns {THREE.Vector3} world cell anchor
     * @private
     */
    _cargoCellWorld(playerPos, playerVelDir, cellIndex, out) {
        const prograde = this._resolveForwardDir(playerVelDir, _scratchFwd);
        // radial-up = geocentric up (Earth at scene origin); fall back to +Y.
        const radialUp = playerPos && playerPos.lengthSq() > 0
            ? _scratchRadial.copy(playerPos).normalize()
            : _scratchRadial.set(0, 1, 0);
        const crossTrack = _scratchCross.crossVectors(prograde, radialUp);
        if (crossTrack.lengthSq() < 1e-9) crossTrack.set(1, 0, 0); else crossTrack.normalize();

        const cells = Math.max(1, Constants.MOTHER_CARGO_CELLS);
        // Centre the row: lateral = (i - (n-1)/2) × spread.
        const lateral = (cellIndex - (cells - 1) / 2) * Constants.MOTHER_CARGO_CELL_SPREAD_M * M;
        out.copy(playerPos)
            .addScaledVector(prograde, Constants.MOTHER_CARGO_FWD_OFFSET_M * M)
            .addScaledVector(crossTrack, lateral);
        return out;
    }

    /**
     * Phase 4: index of the first free cargo cell, or -1 when full.
     *
     * Fills cells CENTER-OUT (e.g. for 3 cells the order is [1, 0, 2]) so a lone
     * catch reels straight back to the nose centerline instead of an off-centre
     * cell. Cells are laterally spread by MOTHER_CARGO_CELL_SPREAD_M, so the old
     * left-to-right fill parked the very first catch ~one spread off to the side
     * (visible as the net "returning off to the left"). Order = ascending lateral
     * distance from centre, index as the tie-break.
     * @returns {number}
     * @private
     */
    _firstFreeCell() {
        const cells = Math.max(1, Constants.MOTHER_CARGO_CELLS);
        const centre = (cells - 1) / 2;
        const order = Array.from({ length: cells }, (_, i) => i)
            .sort((a, b) => (Math.abs(a - centre) - Math.abs(b - centre)) || (a - b));
        for (const i of order) {
            if (!this._cargo.some(c => c.cellIndex === i)) return i;
        }
        return -1;
    }

    /** Create capture net projectile group, tube tether, trail, and flash visuals */
    _createVisuals() {
        // ── Unified "web in space" net — shared NetMeshKit (Mother + Daughter) ──
        // Replaces the rejected look (8 m octagon LineSegments + four 3 m chrome
        // sphere weights + the wireframe cone "bag") with the SAME translucent web
        // vocabulary the daughter uses (handoff option B). Sized + styled by
        // NET_WEB so it reads as a delicate web the small operator casts, never a
        // cage that out-masses the ship + catch (GAME_DESIGN.md §2.1).
        //
        // STRICTLY LOCAL-SPACE: the kit only builds geometry around a local origin
        // (apex at (0,0,0), mouth along local −Z). All world-positioning,
        // orientation, open/cinch drive, reel, and tether (the solved F8–F12
        // machinery) stay in update()/_applyNetMouthRadius/_setNetOpacity below.
        this._netGroup = new THREE.Group();

        const NW = Constants.NET_WEB;
        this._netKit = NetMeshKit.build({
            diameter:          NW.MOTHER_DIAMETER,
            weightCount:       NW.EDGE_NODE_COUNT,
            weightRadiusM:     NW.EDGE_NODE_RADIUS_M,
            color:             NW.WEB_COLOR,
            opacity:           0,             // faded in on fire() via _setNetOpacity
            drawstringOpacity: 0,             // whole web (incl. drawstring) starts hidden
            weightTransparent: true,          // Mother fades the whole net in/out
            apexTransparent:   true,          // …including the apex hub
            childrenVisible:   true,          // Mother shows the whole net at once (no per-state FSM)
        });
        this._netGroup.add(this._netKit.group);

        // References the open-on-launch / cinch-on-capture animation + tests use.
        // These mirror the kit handle (which owns the meshes) — the mouth-radius
        // animation drives them through NetMeshKit.setMouthFraction.
        this._netWeights = this._netKit.rimWeights;          // rim nodes (open/cinch sweep)
        this._netFullRadiusScene = this._netKit.mouthRadius; // full open mouth radius (scene units)

        this._netGroup.visible = false;
        this.scene.add(this._netGroup);

        // ── Sprint 2 v2: tether (Dyneema ivory fibre, not arcade yellow) ────
        // Rebuilt each frame from a QuadraticBezierCurve3 (NOT CatmullRom with 3
        // points — that extrapolates past its endpoints, the "out the back of
        // mother" bug). Quadratic Bezier passes through only its two endpoints.

        // ── Gossamer fat-line tether (matches the NetMeshKit web primitive) ──
        // A single Line2 / LineMaterial cable replaces the old coaxial
        // sheath+core TubeGeometry. A thin tube faceted/Frenet-twisted into a
        // jagged "staircase" when slimmed toward gossamer; a fat line carries a
        // constant screen-space width + built-in AA, so it reads as a smooth,
        // delicate ivory strand at any thinness. Shares the web's resolution sync
        // (registered with NetMeshKit). Cheaper than the per-frame dual-tube
        // rebuild it replaces. _tetherCore is retired (kept null; all its call
        // sites are guarded).
        const tetherGeo = new LineGeometry();
        // Seed with the initial straight segment (rebuilt each frame from the
        // live catenary in _rebuildTetherGeometry).
        tetherGeo.setPositions([0, 0, 0, 0, 0, M * 10]);
        const tetherMat = new LineMaterial({
            color: 0xcfeaff,        // ivory Dyneema, matching the web
            linewidth: 2.0,         // screen-space px — slim but AA-legible
            transparent: true,
            opacity: 0,             // faded in on fire()
            worldUnits: false,
            dashed: false,
            blending: THREE.NormalBlending,
            depthWrite: false,
            depthTest: true,
        });
        NetMeshKit.registerLineMaterial(tetherMat);
        this._tetherMesh = new Line2(tetherGeo, tetherMat);
        this._tetherMesh.frustumCulled = false;
        this._tetherMesh.visible = false;
        // §2-followup (round 4): the net tether bridges mother and a captured
        // target (separate scene objects). Tag it CONNECTOR so it lies on the
        // hull/target instead of sorting ambiguously by raw depth.
        this._tetherMesh.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
        this.scene.add(this._tetherMesh);

        // Coaxial bright core retired — the fat-line strand carries the look.
        this._tetherCore = null;

        // Markers removed in v2e — they confirmed anchor was going to wrong place

        // Energy pulse bead removed (Issue #6 — de-arcade tether visual)
        // Trail spheres removed (Issue #6 — de-arcade tether visual)

        // ── Phase 6: Muzzle flash — bright white sphere ────────────────────
        const flashGeo = new THREE.SphereGeometry(M * 10, 6, 6);
        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
        });
        this._muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
        this._muzzleFlash.visible = false;
        this._muzzleFlash.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // §2-followup (round 4)
        this.scene.add(this._muzzleFlash);

        // ── Phase 6: Contact flash — white/cyan ─────────────────────────────
        const contactGeo = new THREE.SphereGeometry(M * 12, 6, 6);
        const contactMat = new THREE.MeshBasicMaterial({
            color: 0x88ffff,
            transparent: true,
            opacity: 0,
        });
        this._contactFlash = new THREE.Mesh(contactGeo, contactMat);
        this._contactFlash.visible = false;
        this._contactFlash.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // §2-followup (round 4)
        this.scene.add(this._contactFlash);

        // ── Gossamer particle trail ──────────────────────────────────────────
        const N = this._trailCount;
        this._trailPositions = new Float32Array(N * 3);
        this._trailAlphas = new Float32Array(N);
        this._trailBirths = new Float32Array(N); // 0 = inactive
        this._trailDrift = new Float32Array(N * 3);

        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position', new THREE.BufferAttribute(this._trailPositions, 3));
        trailGeo.setAttribute('alpha', new THREE.BufferAttribute(this._trailAlphas, 1));

        // Custom ShaderMaterial for per-particle alpha + additive glow
        const trailMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0.55, 0.95, 0.80) }, // cyan-green silk
                uSize:  { value: M * 18 },                            // particle screen size
            },
            vertexShader: `
                attribute float alpha;
                varying float vAlpha;
                uniform float uSize;
                void main() {
                    vAlpha = alpha;
                    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = uSize * (300.0 / -mvPos.z);
                    gl_Position = projectionMatrix * mvPos;
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    // Soft circular falloff
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float falloff = 1.0 - smoothstep(0.0, 1.0, d);
                    gl_FragColor = vec4(uColor, vAlpha * falloff * 0.7);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });

        this._trailPoints = new THREE.Points(trailGeo, trailMat);
        this._trailPoints.frustumCulled = false;
        this._trailPoints.visible = false;
        this._trailPoints.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // §2-followup (round 4)
        this.scene.add(this._trailPoints);

        // NOTE: Contact ring removed (ST-2.4) — replaced by dynamic radial sparks
    }

    /**
     * Set opacity on the net's web (cone + drawstring + fade-able edge nodes)
     * via the shared kit. The tether is a separate object owned by LassoSystem
     * and is faded independently.
     * @param {number} opacity
     */
    _setNetOpacity(opacity) {
        if (this._netKit) NetMeshKit.setOpacity(this._netKit, opacity);
    }

    /**
     * Phase 2 (LASSO_NET_KINEMATICS): set the net MOUTH radius as a fraction of
     * the full perimeter radius — the parameterized "open / cinch" animation,
     * delegated to the shared kit (scales rim-node + cone XY, keeps the apex +
     * axial length, rebuilds the drawstring). This is a kinematic mapping (not a
     * cloth sim): openFrac on launch, cinchFrac on capture. No-op when the kit is
     * absent (pre-init).
     * @param {number} radiusFrac — mouth radius fraction in [NET_CINCH..1]
     * @private
     */
    _applyNetMouthRadius(radiusFrac) {
        if (this._netKit) NetMeshKit.setMouthFraction(this._netKit, radiusFrac);
    }

    // Sparks removed per user feedback — "NOT an arcade game"

    /**
     * Rebuild coaxial tether (sheath + core) with a subtle catenary sag at
     * the midpoint for natural cable-slack look. Stores the curve so the
     * pulse bead can travel along it during reel-in.
     * Sag magnitude scales with tether length so short tethers stay taut.
     * @param {THREE.Vector3} startPos - Satellite attach point
     * @param {THREE.Vector3} endPos   - Net projectile position
     */
    _rebuildTetherGeometry(startPos, endPos) {
        if (!this._tetherMesh) return;

        const length = startPos.distanceTo(endPos);
        // Sag capped at either the configured NET_TETHER_SAG (m) or 5% of length,
        // whichever is smaller — short tethers stay visually taut.
        const sagMag = Math.min(Constants.NET_TETHER_SAG * M, length * 0.05);
        const mid = new THREE.Vector3()
            .addVectors(startPos, endPos)
            .multiplyScalar(0.5);
        // Catenary sag toward NADIR (planet-down), NOT world −Y. The Earth sits
        // at the scene origin, so nadir = −normalize(mid). Sagging along a fixed
        // world axis pulled the control point off to one side of the tether at
        // most orbital attitudes, bowing the strand into an "arch" that loops
        // up and over the mother and reads as a detached tether. A nadir-aligned
        // sag always hangs the strand gently downward toward the planet (and
        // vanishes to taut when the tether is itself radial), so it never arches
        // across the hull. For a QuadraticBezierCurve3 the apex sits halfway to
        // the control point, so offset by 2× the desired sag.
        const nadir = mid.lengthSq() > 0
            ? _scratchNadir.copy(mid).normalize().multiplyScalar(-1)
            : _scratchNadir.set(0, -1, 0);
        mid.addScaledVector(nadir, sagMag * 2);

        // Sprint 2 v2c: QuadraticBezierCurve3 — guaranteed no extrapolation
        // past endpoints. CatmullRomCurve3 with 3 points OVERSHOOTS past
        // start/end, causing the "tether out the back of mother" bug.
        const curve = new THREE.QuadraticBezierCurve3(
            startPos.clone(),
            mid,
            endPos.clone()
        );
        this._tetherCurve = curve;

        // Sample the catenary into the fat-line strand. getPoints(N) yields
        // NET_TETHER_SEGMENTS+1 points; flatten to [x,y,z,…] for LineGeometry.
        const pts = curve.getPoints(Constants.NET_TETHER_SEGMENTS);
        const flat = this._tetherFlat && this._tetherFlat.length === pts.length * 3
            ? this._tetherFlat
            : (this._tetherFlat = new Float32Array(pts.length * 3));
        // ── DEFECT-1 FIX: anchor-relative vertices (float32 precision) ──────
        // The ship orbits at ~64–84 scene units from the world origin
        // (EARTH_RADIUS 63.71 + altitude). At magnitude ~64 the float32 grid
        // spacing is 2^(6-23) ≈ 7.6e-6 units ≈ 0.76 m, while the tether's spine
        // points sit ~1 m apart — so absolute-world vertices snap to that grid
        // and the strand renders as a regular "lightning-bolt" sawtooth (the web
        // escapes this because it lives in a local Group near its own origin).
        // Fix: park the line object AT the start anchor and store every vertex
        // RELATIVE to that anchor. The subtraction happens in float64 (JS
        // numbers) and the small offsets (~0.0003 units) keep full float32
        // precision; the single uniform translation in the object matrix shifts
        // the whole strand together (no per-vertex wobble). Primitive-agnostic.
        this._tetherMesh.position.copy(startPos);
        for (let i = 0; i < pts.length; i++) {
            flat[i * 3] = pts[i].x - startPos.x;
            flat[i * 3 + 1] = pts[i].y - startPos.y;
            flat[i * 3 + 2] = pts[i].z - startPos.z;
        }
        this._tetherMesh.geometry.setPositions(flat);
    }

    /**
     * Extract scene position from a debris object returned by getDebrisNear.
     * getDebrisNear returns objects with _cartesian.position = { x, y, z }.
     * @param {object} debris
     * @returns {THREE.Vector3|null}
     */
    _getDebrisScenePos(debris) {
        if (!debris) return null;
        // Original debris objects have _scenePosition (from DebrisField._updateInstanceTransform)
        if (debris._scenePosition) {
            return debris._scenePosition.clone();
        }
        // Copies from getDebrisNear() have _cartesian
        if (debris._cartesian && debris._cartesian.position) {
            const p = debris._cartesian.position;
            return new THREE.Vector3(p.x, p.y, p.z);
        }
        return null;
    }

    /**
     * Proactive in-range prompt (gap C.3). When the Tab-selected target first
     * comes within lasso range, is inside the forward firing arc, AND a cast is
     * actually possible, emit a one-time "press N" comms hint. Resets when the
     * target leaves range (with hysteresis margin) / changes / leaves the arc /
     * a cast becomes impossible, so it re-arms for the next entry.
     *
     * Invite ⇔ success: the gate here mirrors the real constraints `fire()`
     * enforces (range, mass, forward arc) so we never invite a cast the system
     * will then refuse. The line is tagged `_proactive` so commsSuppression
     * tier-gates it (suppressed at tier 0 — the Director owns onboarding).
     *
     * @private
     * @param {THREE.Vector3} playerPos
     * @param {object|null} selectedTarget
     * @param {THREE.Vector3|null} [playerVelDir] prograde dir for the arc test
     */
    _updateInRangePrompt(playerPos, selectedTarget, playerVelDir = null) {
        // During onboarding the Director's `lasso` beat teaches this; suppress
        // the system prompt entirely so it can't contradict an earlier beat.
        if (this._onboardingActive) { this._inRangePromptId = null; return; }

        // A cast must be currently possible, else clear and bail.
        const canCast = !this.active && this.cooldown <= 0 && this._ammo > 0;
        if (!canCast || !selectedTarget || !playerPos) {
            this._inRangePromptId = null;
            return;
        }

        const targetId = selectedTarget.id != null ? selectedTarget.id : selectedTarget.catalogId;
        const pos = this._getDebrisScenePos(selectedTarget);
        if (!pos) { this._inRangePromptId = null; return; }

        const dist = playerPos.distanceTo(pos);
        const rangeScene = Constants.LASSO_RANGE * M;
        // Hysteresis: require leaving by a 10% margin before re-arming so a
        // target hovering at the boundary can't re-fire the prompt repeatedly.
        const alreadyArmed = this._inRangePromptId === targetId;
        const enterRange = dist <= rangeScene;
        const stayRange = dist <= rangeScene * 1.1;
        const inRange = alreadyArmed ? stayRange : enterRange;
        const tooHeavy = (selectedTarget.mass || 1) > Constants.LASSO_MAX_CAPTURE_MASS;

        // Forward-arc test — uses the SAME forward-dir resolution as fire()
        // (shared _resolveForwardDir, +Z fallback) so the invite matches exactly
        // what a cast would do. Always enforced, even at zero velocity.
        const fwdDir = this._resolveForwardDir(playerVelDir, _scratchFwd);
        const toTarget = _scratchToTarget.copy(pos).sub(playerPos).normalize();
        const inArc = toTarget.dot(fwdDir) >= Constants.LASSO_FORWARD_ARC_DOT;

        if (inRange && !tooHeavy && inArc) {
            // Only announce on the transition into a castable state for this target.
            if (this._inRangePromptId !== targetId) {
                // Universal hint-gating (Phase 3): skip for a player who has
                // mastered the lasso, or after MAX_UNHEEDED_NUDGES, but still
                // nudge a discovered-but-struggling player (recent lasso-denied
                // failure). Ungated when no SkillsSystem is wired (tests).
                const ss = this._skillsSystem;
                if (ss && typeof ss.canFireHint === 'function') {
                    if (!ss.canFireHint('collect_lasso', { cause: 'lasso-denied' })) {
                        // Do NOT consume the transition — a subsequent lasso-denied
                        // failure can flip canFireHint true while still in range, and
                        // we want the nudge to fire then. Re-checked next frame.
                        return;
                    }
                }
                // Mark the transition consumed only now that we will show a hint.
                this._inRangePromptId = targetId;

                // Veteran downgrade: a one-line ticker entry instead of a comms
                // line, so an expert isn't interrupted by a modal-weight prompt.
                const veteran = !!(ss && typeof ss.isVeteran === 'function' && ss.isVeteran());
                if (veteran) {
                    eventBus.emit(Events.HINT_POSTED, {
                        id: 'lasso_in_range',
                        text: 'In range. N to cast',
                        glyph: 'N',
                        keys: ['KeyN'],
                        skillId: 'collect_lasso',
                        duration: 4000,
                        priority: 'normal',
                    });
                } else {
                    // Keep this prompt clean and actionable. The raw capture-odds
                    // % ("Mother net 32%") was removed (2026-06-14): a bare number
                    // with no context is noise to a new player, and the labelled,
                    // colour-coded odds already live in the Target panel badge and
                    // the reticle odds strip (the SSOT ToolOdds readout). Comms
                    // just needs to say what to press.
                    eventBus.emit(Events.COMMS_MESSAGE, {
                        text: 'Target in lasso range. Press N to cast.',
                        source: 'SYSTEM',
                        channel: 'CMD',
                        priority: 'info',
                        // Proactive teach prompt — tier-gated (does NOT bypass tier 0).
                        _lassoFeedback: true,
                        _proactive: true,
                    });
                }
                if (ss && typeof ss.noteNudgeShown === 'function') {
                    ss.noteNudgeShown('collect_lasso');
                }
            }
        } else {
            // Out of range, too heavy, out of arc, or deselected — re-arm.
            this._inRangePromptId = null;
        }
    }

    /**
     * Fire a lasso toward the nearest debris.
     * @param {THREE.Vector3} playerPos - Mothership position
     * @param {object} debrisField - DebrisField instance
     * @param {THREE.Vector3} [playerVelDir] - Prograde direction for aim cone
     * @param {object|null} [selectedTarget=null] - Tab-selected target from TargetSelector (priority over auto-aim)
     * @returns {boolean} true if lasso was fired
     */
    fire(playerPos, debrisField, playerVelDir, selectedTarget = null) {
        if (this.active || this.cooldown > 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'cooldown' });
            // UX: tell the player WHY the cast was rejected. Without this the
            // only feedback is a red reticle flash + click — a first-time
            // player can't tell the lasso is mid-flight or recharging.
            const secs = this.cooldownRemaining;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: this.active
                    ? 'Lasso busy. Wait for it to retract'
                    : `Lasso recharging. ${Math.ceil(secs)}s`,
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // UX-3 #7: Ammo check
        if (this._ammo <= 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_ammo' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Web tether depleted. Deploy daughters [D]',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
            });
            return false;
        }

        // Phase 4 (MOTHER_CARGO_STOW): soft-block when every aft cargo cell is
        // occupied — the catch has nowhere to go until the furnace clears one.
        if (Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW && this._firstFreeCell() < 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'cargo_full' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Cargo full. Furnace still processing. Wait for a cell to clear.',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
            });
            return false;
        }

        // Find nearest debris within lasso range
        const rangeScene = Constants.LASSO_RANGE * M; // 200m in scene units
        const nearby = debrisField.getDebrisNear(playerPos, rangeScene);

        if (!nearby || nearby.length === 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_target' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'No targets in lasso range (200m)',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // Auto-aim: find closest target within ±30° cone of prograde
        let bestTarget = null;
        let bestPos = null;
        let bestDist = Infinity;

        // PRIORITY 1: If player has Tab-selected a target and it's in range, use it (S1 Fix C2)
        if (selectedTarget) {
            const selectedPos = this._getDebrisScenePos(selectedTarget);
            if (selectedPos) {
                const dist = playerPos.distanceTo(selectedPos);
                const mass = selectedTarget.mass || 1;
                // UX-3 #4: Mass-specific rejection with comms hint
                if (mass > Constants.LASSO_MAX_CAPTURE_MASS) {
                    eventBus.emit(Events.LASSO_DENIED, { reason: 'too_heavy' });
                    // Net ladder: route the player to the right tool by mass via
                    // the shared classifier (single source of truth with the
                    // Mother fire routing in InputManager) — a Daughter for
                    // 10–500 kg, the Mother's Large Net for whales (>500 kg).
                    const { message } = classifyNetTarget(mass);
                    eventBus.emit(Events.COMMS_MESSAGE, {
                        text: message,
                        source: 'SYSTEM',
                        channel: 'CMD',
                        priority: 'warning',
                        _lassoFeedback: true,
                    });
                    return false;
                }
                if (dist <= rangeScene) {
                    bestTarget = selectedTarget;
                    bestPos = selectedPos;
                    bestDist = dist;
                }
            }
        }

        // PRIORITY 2: Fall back to auto-aim only if no selected target in range
        const aimDir = playerVelDir
            ? playerVelDir.clone().normalize()
            : new THREE.Vector3(0, 0, 1);
        const maxAngle = 30 * Math.PI / 180; // ±30° cone

        if (!bestTarget) for (const d of nearby) {
            const debrisPos = this._getDebrisScenePos(d);
            if (!debrisPos) continue;

            const toDebris = new THREE.Vector3().subVectors(debrisPos, playerPos);
            const dist = toDebris.length();
            toDebris.normalize();

            const dot = Math.max(-1, Math.min(1, toDebris.dot(aimDir)));
            const angle = Math.acos(dot);

            // Check mass limit
            const mass = d.mass || 1;
            if (mass > Constants.LASSO_MAX_CAPTURE_MASS) continue;

            if (angle <= maxAngle && dist < bestDist) {
                bestDist = dist;
                bestTarget = d;
                bestPos = debrisPos;
            }
        }

        // Fallback: if no target in cone, grab the absolute nearest eligible target
        if (!bestTarget) {
            for (const d of nearby) {
                const mass = d.mass || 1;
                if (mass > Constants.LASSO_MAX_CAPTURE_MASS) continue;
                const debrisPos = this._getDebrisScenePos(d);
                if (!debrisPos) continue;
                bestTarget = d;
                bestPos = debrisPos;
                break; // already sorted by distance from getDebrisNear
            }
        }

        if (!bestTarget || !bestPos) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_target' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'No suitable target for lasso (too heavy or no position)',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // UX-3 #4: Forward-arc constraint — target must be in forward hemisphere.
        // Uses the shared _resolveForwardDir (same +Z fallback as the proactive
        // invite) so the two gates can never disagree.
        const fwdDir = this._resolveForwardDir(playerVelDir, _scratchFwd);
        const toTarget = new THREE.Vector3().subVectors(bestPos, playerPos).normalize();
        const fwdDot = toTarget.dot(fwdDir);
        if (fwdDot < Constants.LASSO_FORWARD_ARC_DOT) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'outside_arc' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Target not in forward arc. Align with autopilot first',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
                // During onboarding, let the Director own alignment guidance —
                // tier-gate this denial so it can't contradict an early beat.
                _proactive: this._onboardingActive || undefined,
            });
            return false;
        }

        // Fire!
        this.active = true;
        this.target = bestTarget;
        this._targetId = bestTarget.id;
        this._targetScenePos = bestPos.clone();

        // Phase 1B: spawn the projectile + anchor the tether at the FRONT-CENTRE
        // launcher muzzle (along the nose, +Z/prograde), not the hull centroid.
        // The muzzle is recomputed every frame in update() so it tracks the nose
        // as the ship reorients; here we just seed the initial spawn.
        const muzzleWorld = this._computeMuzzleWorld(playerPos, playerVelDir, new THREE.Vector3());
        this.projectilePos = muzzleWorld.clone();
        this._projOffset.copy(muzzleWorld).sub(playerPos); // player-relative muzzle offset

        const dir = new THREE.Vector3().subVectors(bestPos, muzzleWorld).normalize();
        this.projectileVel = dir.multiplyScalar(Constants.LASSO_SPEED * M); // LASSO_SPEED m/s in scene units (relative)
        // Phase 1C: remember the launch direction so the cosmetic recoil kick can
        // shove the mother mesh opposite the throw.
        this._lastLaunchDir = dir.clone();

        // Phase 1A: visible throw geometry. Compute the launch distance (muzzle →
        // target, metres) once at fire, then derive a contact radius that scales
        // down for near targets and an EASED flight speed so even a point-blank
        // guided catch reads as a ~LASSO_MIN_FLIGHT_TIME arc instead of a 0.02 s
        // blink. Far targets keep the fast 100 m/real-s apparent speed (capped by
        // LASSO_MAX_FLIGHT_TIME).
        const launchDistanceM = muzzleWorld.distanceTo(bestPos) / M;
        const contactRadiusM = Math.max(
            Constants.LASSO_CONTACT_RADIUS_FLOOR_M,
            Math.min(
                Constants.LASSO_CONTACT_RADIUS_M,
                Constants.LASSO_CONTACT_RADIUS_FRACTION * launchDistanceM
            )
        );
        this._contactRadiusScene = contactRadiusM * M;

        const maxApparentSpeed = Constants.LASSO_SPEED * Constants.TIME_SCALE_GAMEPLAY; // 100 m/s apparent
        const desiredTravelM = Math.max(contactRadiusM, launchDistanceM - contactRadiusM);
        const easedApparentSpeed = Math.max(
            3, // tiny floor so it always visibly moves; near throws glide for the full LASSO_MIN_FLIGHT_TIME
            Math.min(maxApparentSpeed, desiredTravelM / Constants.LASSO_MIN_FLIGHT_TIME)
        );
        this._flightSpeedScene = easedApparentSpeed * M; // scene units / real second (TIME_SCALE already folded in)

        this.flightTimer = 0;
        this._reelingIn = false;
        this._reelProgress = 0;
        this._netSpinAngle = 0;

        this._trace('FIRE', {
            targetId: bestTarget.id, mass: bestTarget.mass, type: bestTarget.type,
            muzzleOffset_m: +(this._projOffset.length() / M).toFixed(2),
            launchDist_m: +launchDistanceM.toFixed(2),
            contactRadius_m: +contactRadiusM.toFixed(2),
            easedSpeed_mps: +easedApparentSpeed.toFixed(2),
            flags: {
                kin: Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS,
                phys: Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS,
                stow: Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW,
            },
        });

        // Show capture net visuals (FIX-2.4a) — reset scale in case prior reel-in collapsed it
        this._netGroup.visible = true;
        this._netGroup.scale.setScalar(1.0);
        // Phase 2: leave the canister with the mouth compact so the open-on-launch
        // animation has somewhere to open FROM (else it pops full for one frame).
        if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) {
            this._applyNetMouthRadius(Constants.NET_LAUNCH_COMPACT_FRAC);
        }
        // Cool pre-contact web tint (reset any green left from a prior reel).
        if (this._netKit) NetMeshKit.setColor(this._netKit, Constants.NET_WEB.WEB_COLOR);
        this._setNetOpacity(Constants.NET_WEB.WEB_OPACITY);
        // Sprint 2 v2: Show coaxial tether (sheath + bright core)
        this._tetherMesh.visible = true;
        this._tetherMesh.material.opacity = 0.55;
        if (this._tetherCore) {
            this._tetherCore.visible = true;
            this._tetherCore.material.opacity = 0.8;
        }
        this._pulsePhase = 0;
        // Phase 1B/1C: a muzzle puff AT THE CANISTER (nose), scaled up + longer so
        // the launch reads clearly and the net visibly emerges from hardware.
        this._muzzleFlash.position.copy(muzzleWorld);
        this._muzzleFlash.scale.setScalar(Constants.LASSO_MUZZLE_FLASH_SCALE);
        this._muzzleFlash.visible = true;
        this._muzzleFlashTimer = Constants.LASSO_MUZZLE_FLASH_TIME;
        this._muzzleFlash.material.opacity = 0.95;
        // Phase 1C: kick the mother mesh opposite the launch (cosmetic only).
        this._launchRecoil(this._lastLaunchDir);

        // Sound: electromagnetic THWIP (via EventBus → AudioSystem)
        eventBus.emit(Events.LASSO_FIRED, {
            targetId: bestTarget.id,
            projectileMass: Constants.LASSO_PROJECTILE_MASS,
            launchDirection: this.projectileVel.clone().normalize(),
            speed: Constants.LASSO_SPEED,
        });

        // ST-1.3: First-cast comms primer — once per session
        if (!this._firstCastPrimerSent) {
            this._firstCastPrimerSent = true;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Lasso deployed. Hold steady for catch. Recharges from onboard power.',
                priority: 'info',
            });
        }

        // UX-3 #7: Decrement ammo + emit change event
        this._ammo--;
        eventBus.emit(Events.LASSO_AMMO_CHANGED, {
            remaining: this._ammo,
            max: Constants.LASSO_AMMO_MAX,
        });

        // UX-3 #7: Low ammo warning at 5 remaining
        if (this._ammo === 5) {
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Web nets running low. Daughters are reusable',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
            });
        }

        return true;
    }

    /**
     * UX-3 #7: Refill web tether ammo to max (called by shop purchase).
     */
    refillAmmo() {
        this._ammo = Constants.LASSO_AMMO_MAX;
        eventBus.emit(Events.LASSO_AMMO_CHANGED, {
            remaining: this._ammo,
            max: Constants.LASSO_AMMO_MAX,
        });
    }

    /**
     * Get current ammo count (for HUD queries).
     * @returns {number}
     */
    getAmmo() {
        return this._ammo;
    }

    /**
     * Look up the live scene position of the target debris from its orbital elements.
     * @param {object} debrisField
     * @returns {THREE.Vector3|null}
     */
    _getLiveTargetPos(debrisField) {
        // FIX: use `== null` so targetId === 0 (valid — first debris spawned) is NOT
        // treated as "target died", which previously cancelled the lasso on frame 1.
        if (this._targetId == null || !debrisField) return null;
        const debris = debrisField.getDebrisById
            ? debrisField.getDebrisById(this._targetId)
            : null;
        if (!debris || !debris.alive) return null;
        // Prefer the live _scenePosition (single source of truth — matches
        // _getDebrisScenePos used at fire time, and honours the onboarding pin
        // whose ORBIT is intentionally frozen). Reading the orbit here for a
        // pinned piece returned the stale spawn position the mother flies past
        // at orbital speed — making the net home BACKWARD ("180° wrong way").
        if (debris._scenePosition) return debris._scenePosition.clone();
        if (!debris.orbit) return null;
        const cart = orbitToSceneCartesian(debris.orbit);
        return new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
    }

    /**
     * Update lasso state each frame.
     * @param {number} dt - Delta time
     * @param {THREE.Vector3} playerPos - Current mothership position
     * @param {object} debrisField - For debris removal on catch
     * @param {object|null} [selectedTarget] - Tab-selected target
     * @param {THREE.Vector3|null} [playerVelDir] - Prograde dir for the arc test
     */
    update(dt, playerPos, debrisField, selectedTarget = null, playerVelDir = null) {
        this._time += dt;
        this._lastPlayerPos = playerPos; // diagnostics — for _dbgSnapshot offset math

        if (this.cooldown > 0) {
            this.cooldown -= dt;
            if (this.cooldown <= 0) {
                this.cooldown = 0;
                eventBus.emit(Events.LASSO_COOLDOWN_END, {});
            }
        }

        // Phase 6: Update visual effects (run independently of active state)
        this._updateVisualEffects(dt);

        // Phase 4: tick stowed catches (furnace breakdown + cell pinning). Runs
        // independent of active state — cargo persists across casts.
        this._updateCargo(dt, playerPos, playerVelDir);

        // Proactive "in range — press N" prompt (gap C.3). Fires once when the
        // Tab-selected target first enters a castable state (in range, in the
        // forward arc, idle/loaded). Tier-gated + onboarding-suppressed.
        this._updateInRangePrompt(playerPos, selectedTarget, playerVelDir);

        if (!this.active) return;


        this.flightTimer += dt;

        // --- Refresh target position from orbital elements each frame ---
        const liveTargetPos = this._getLiveTargetPos(debrisField);
        if (liveTargetPos) {
            this._targetScenePos.copy(liveTargetPos);
        } else if (!this._reelingIn) {
            // Target died or became invalid during flight
            this._cancelLasso();
            return;
        }

        if (this._reelingIn) {
            // Reel-in phase: move debris toward player
            this._reelProgress += dt * Constants.LASSO_REEL_SPEED;
            this._reelProgress = Math.min(this._reelProgress, 1.0); // clamp — prevent overshoot
            if (this._reelProgress >= 1.0) {
                // Catch complete! Phase 4: route through stow → furnace when the
                // flag + a cargo cell are available; else the legacy instant catch.
                if (Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW && this._reelCellIndex >= 0) {
                    this._stowCatch(playerPos, playerVelDir);
                } else {
                    this._completeCatch(debrisField);
                }
                return;
            }

            // S4: Emit tether tension feedback — intensifies as reel-in progresses.
            // Phase 3 (gated): when reel physics is active for this (heavy, non-M1)
            // catch, also carry the real mass-driven tension in Newtons + a strain
            // fraction; apply a subtle CoM pull toward the catch; and risk a snap
            // under sustained over-strain. When the gate is OFF (M1 / ≤cap / flag
            // off) the payload + timing are byte-identical to before.
            if (this._reelPhysicsActive) {
                this._applyReelPhysics(dt, playerPos);
                if (!this.active) return; // a snap reset the lasso this frame
            } else {
                eventBus.emit(Events.TETHER_TENSION, {
                    tensionFraction: this._reelProgress,
                    armId: 'lasso',
                });
            }

            // Two-phase capture: WRAP (net shrinks at contact) → REEL (compact package
            // travels to player). Matches physically meaningful net capture sequence.
            const WRAP_END = 0.2;                              // wrap phase: t ∈ [0, 0.2]
            const COMPACT_SCALE = Constants.NET_COMPACT_SCALE; // Sprint 2 v2: 0.45 (was 0.15 — too small to see)

            if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) {
                // Phase 2: drawstring CINCH on the catch — close the mouth radius
                // around the debris over the WRAP window, then hold it cinched
                // through the haul. Drive the radius directly (group scale stays 1
                // so weights cinch toward centre rather than the whole net merely
                // scaling down).
                const cinchT = Math.min(1, this._reelProgress / WRAP_END);
                const mouthFrac = 1.0 - cinchT * (1.0 - Constants.NET_CINCH_RADIUS_FRAC);
                if (this._netGroup) this._netGroup.scale.setScalar(1.0);
                this._applyNetMouthRadius(mouthFrac);
            } else if (this._netGroup) {
                this._netGroup.scale.setScalar(
                    this._reelProgress < WRAP_END
                        ? 1.0 - (this._reelProgress / WRAP_END) * (1.0 - COMPACT_SCALE)
                        : COMPACT_SCALE
                );
            }
            // 2026-06-30 realism pass: the web stays ivory Dyneema through the
            // haul too — a real net doesn't change colour when it grips. Capture
            // state is signalled on the HUD/comms, not by recolouring the mesh
            // (matches CaptureNetVisual.js). Hold the translucent web opacity.
            if (this._netKit) NetMeshKit.setColor(this._netKit, Constants.NET_WEB.WEB_COLOR);
            this._setNetOpacity(Constants.NET_WEB.WEB_OPACITY);
            // Tether hidden at contact — no opacity update needed during reel-in

            let reelT;
            if (this._reelProgress < WRAP_END) {
                // WRAP: net stays at contact position while shrinking
                reelT = 0;
            } else {
                // REEL: compact package travels player-relative from contact → zero
                reelT = (this._reelProgress - WRAP_END) / (1 - WRAP_END);
            }
            // Phase 4: reel the catch back to its FORWARD cargo cell near the
            // nose (player-relative) — the same side it was thrown from — so it is
            // never dragged through the hull to the rear. _zeroVec (centre) is the
            // legacy/flag-off target.
            let reelEndOffset = _zeroVec;
            if (Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW && this._reelCellIndex >= 0) {
                this._cargoCellWorld(playerPos, playerVelDir, this._reelCellIndex, _scratchMuzzle);
                reelEndOffset = _scratchCargoOffset.copy(_scratchMuzzle).sub(playerPos);
            }
            const reelOffset = new THREE.Vector3().lerpVectors(
                this._reelStartOffset, reelEndOffset, reelT
            );
            this.projectilePos.copy(playerPos).add(reelOffset);

            // Drag the captured debris along with the net package so it visibly
            // reels into the mother. The debris position is otherwise owned by
            // DebrisField._updateInstanceTransform (orbit propagation, or the
            // onboarding pin which is released at LASSO_CONTACT) and would stay
            // frozen mid-reel. Use the authoritative _armPinned/_armPinPos
            // direct-copy pin (highest priority after the now-released onboarding
            // pin) — this also exempts the package from distance LOD culling so
            // it stays visible inside the net during the haul.
            if (this.target) {
                this._reelPinTarget = this.target;
                if (!this.target._armPinPos) this.target._armPinPos = new THREE.Vector3();
                this.target._armPinPos.copy(this.projectilePos);
                this.target._armPinned = true;
                this.target._catchRenderMin = Constants.MOTHER_CATCH_MIN_RENDER_M * M;
            }
        } else {
            // Flight phase: homing projectile tracks target in local frame
            // Advance offset toward target-relative-to-player
            const targetOffset = new THREE.Vector3().subVectors(this._targetScenePos, playerPos);
            const toTarget = new THREE.Vector3().subVectors(targetOffset, this._projOffset);
            const distToTarget = toTarget.length();

            if (distToTarget < this._contactRadiusScene &&
                this.flightTimer >= Constants.LASSO_MIN_FLIGHT_TIME) { // proximity + min-flight gate — contact!
                this._reelingIn = true;
                // Phase 3: latch whether reel-in physics applies to THIS catch.
                // MANDATORY gate — disabled on Mission 1 and for ≤ the Mother-net
                // mass cap, so the tutorial / welcome catches reel identically to
                // today regardless of the LASSO_REEL_PHYSICS flag.
                this._strainTimer = 0;
                const capturedMass = this.target ? (this.target.mass || 0) : 0;
                this._reelPhysicsActive =
                    Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS &&
                    this._missionNumber !== 1 &&
                    capturedMass > Constants.LASSO_MAX_CAPTURE_MASS;
                // CRITICAL FIX (v2e): Use _projOffset directly — it's already the
                // player-relative offset, uncontaminated by per-frame orbital drift.
                // Previous code (subVectors(projectilePos, playerPos)) was subtracting
                // playerPos_N from projectilePos_{N-1}, introducing a velocity×dt
                // error of ~1.3km per frame. At 80km/s apparent orbital velocity
                // that error FLIPS the offset sign, causing the net to reel in
                // from ~1.3km BEHIND the ship ("shoots out front, disappears,
                // reels in from the back").
                this._reelStartOffset.copy(this._projOffset);
                this._reelProgress = 0;

                // Phase 4: pick the aft cargo cell this catch will be hauled to
                // (leaves the forward canister clear). -1 when the flag is off, in
                // which case the package reels to the hull centre as before.
                this._reelCellIndex = Constants.FEATURE_FLAGS.MOTHER_CARGO_STOW
                    ? this._firstFreeCell()
                    : -1;

                // Establish the reel-in pin AT CONTACT, anchored to where the
                // debris currently is, so it doesn't render for one frame at its
                // stale orbital position in the gap between the onboarding-pin
                // release (LASSO_CONTACT, emitted below) and the first reel-in
                // frame (debrisField.update runs before lassoSystem.update). The
                // reel branch then animates _armPinPos toward the mother.
                if (this.target) {
                    this._reelPinTarget = this.target;
                    if (!this.target._armPinPos) this.target._armPinPos = new THREE.Vector3();
                    this.target._armPinPos.copy(this.target._scenePosition || this._targetScenePos || this.projectilePos);
                    this.target._armPinned = true;
                    this.target._catchRenderMin = Constants.MOTHER_CATCH_MIN_RENDER_M * M;
                }

                // Contact flash removed per user feedback ("NOT an arcade game")
                this._contactFlashTimer = 0;
                this._contactFlash.visible = false;

                // Sprint 2 v2: KEEP tether visible through reel-in — this is the
                // visual cue that tells the player their debris is being retracted.
                // Retrograde-cast bug is avoided because _rebuildTetherGeometry
                // rebuilds from current playerPos → projectilePos every frame.


                eventBus.emit(Events.LASSO_CONTACT, { targetId: this.target.id });
            } else {
                // Phase 1A: move at the per-shot EASED apparent speed so even a
                // point-blank guided catch reads as a ~LASSO_MIN_FLIGHT_TIME arc
                // instead of a single-frame blink. _flightSpeedScene already folds
                // in TIME_SCALE_GAMEPLAY (computed at fire). Clamp the step so the
                // net parks at contact range and waits out the min-flight gate
                // rather than overshooting the target.
                const parkDist = Math.max(0, distToTarget - this._contactRadiusScene * 0.5);
                const step = Math.min(this._flightSpeedScene * dt, distToTarget, parkDist || distToTarget);
                toTarget.normalize().multiplyScalar(step);
                this._projOffset.add(toTarget);
            }

            // Convert offset back to absolute scene position
            this.projectilePos.copy(playerPos).add(this._projOffset);

            // Timeout
            if (this.flightTimer > this.maxFlightTime) {
                this._cancelLasso();
                return;
            }
        }

        // ── Gossamer particle trail: emit + update ────────────────────────────
        this._updateGossamerTrail(dt, playerPos);

        // ── FIX-2.4a: Update net position, orientation, and spin ─────────────
        if (this._netGroup && this.projectilePos) {
            this._netGroup.position.copy(this.projectilePos);

            // Orient net face perpendicular to flight direction (Z-axis = velocity)
            if (this._targetScenePos && !this._reelingIn) {
                // Phase 2: OPEN-ON-LAUNCH. The net leaves the canister compact and
                // opens as the gyroscopic spin ramps over NET_SPIN_UP_TIME — a
                // kinematic spin→centrifugal-open mapping (not a force sim). Spin
                // rate ramps with the open fraction so it reads as "spinning up".
                let spinScale = 1.0;
                if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) {
                    const openFrac = Math.min(1, this.flightTimer / Constants.NET_SPIN_UP_TIME);
                    const mouthFrac = Constants.NET_LAUNCH_COMPACT_FRAC +
                        openFrac * (1.0 - Constants.NET_LAUNCH_COMPACT_FRAC);
                    this._applyNetMouthRadius(mouthFrac);
                    spinScale = 0.25 + 0.75 * openFrac; // spin-up while opening
                }
                const flightDir = new THREE.Vector3()
                    .subVectors(this._targetScenePos, playerPos).normalize();
                if (flightDir.lengthSq() > 0.001) {
                    const orientQuat = new THREE.Quaternion();
                    // The shared NetMeshKit cone points its MOUTH along local −Z
                    // (apex at the group origin / tether side). Orient the group so
                    // local −Z maps onto the flight direction → the web mouth opens
                    // toward the target (was +Z for the old octagon; cosmetic only,
                    // outside the F8–F12 frame/motion machinery).
                    orientQuat.setFromUnitVectors(_negZAxis, flightDir);
                    // Apply gyroscopic spin around flight axis
                    this._netSpinAngle += 2 * Math.PI * Constants.NET_SPIN_HZ * spinScale * dt;
                    const spinQuat = new THREE.Quaternion();
                    spinQuat.setFromAxisAngle(_zAxis, this._netSpinAngle);
                    this._netGroup.quaternion.multiplyQuaternions(orientQuat, spinQuat);
                }
            } else {
                // During reel-in, just spin in place
                this._netSpinAngle += 2 * Math.PI * Constants.NET_SPIN_HZ * dt;
                this._netGroup.rotation.z = this._netSpinAngle;
            }
        }

        // Phase 1B: rebuild the tether EVERY frame from the front-centre MUZZLE
        // (nose, +Z/prograde) → projectile, not the hull centroid. The muzzle is
        // recomputed each frame so it tracks the nose as the ship reorients along
        // velocity. During reel-in the package returns toward the hull centre
        // (Phase 4 reroutes this to an aft cargo cell). Combined with
        // QuadraticBezierCurve3 (no extrapolation) the tether is guaranteed to go
        // from the muzzle to the net and nowhere else.
        if (this._tetherMesh && this._tetherMesh.visible && this.projectilePos) {
            this._tetherMesh.material.opacity = 0.5;
            if (this._tetherCore) {
                this._tetherCore.material.opacity = this._reelingIn ? 0.95 : 0.8;
            }
            const tetherStart = this._reelingIn
                ? playerPos
                : this._computeTetherAnchor(playerPos, this.projectilePos, _scratchTetherAnchor);
            this._rebuildTetherGeometry(tetherStart, this.projectilePos);
            // Keep the muzzle puff pinned to the (moving) nose while it fades.
            if (this._muzzleFlash && this._muzzleFlash.visible && !this._reelingIn) {
                this._muzzleFlash.position.copy(
                    this._computeMuzzleWorld(playerPos, playerVelDir, _scratchMuzzle)
                );
            }
        }

        // Energy pulse bead removed (Issue #6 — de-arcade tether visual)

        // Diagnostics — throttled per-frame state while a cast is live (~6 Hz).
        if (this._dbg() && (++this._dbgFrame % 10 === 0)) {
            const M = 0.00001;
            const offM = (this.projectilePos && playerPos)
                ? this.projectilePos.distanceTo(playerPos) / M : null;
            this._trace(this._reelingIn ? 'reel' : 'flight', {
                t: +this.flightTimer.toFixed(2),
                reel: +this._reelProgress.toFixed(2),
                netOffset_m: offM != null ? +offM.toFixed(2) : null,
                netVisible: this._netGroup ? this._netGroup.visible : null,
            });
        }
    }

    /**
     * Phase 4 (MOTHER_CARGO_STOW): clamp/slice the reeled catch free of the
     * tether into its aft cargo cell. The debris STAYS alive + pinned to the cell
     * anchor (no removeDebris / no score here) and begins the furnace-transfer
     * countdown. LASSO_CAPTURED / ARM_CAPTURED fire AT STOW so onboarding beats
     * (tease_lock / first_catch / second_catch) and reacquire advance promptly —
     * scoring + salvage + removal happen later, exactly once, at CATCH_PROCESSED.
     * @param {THREE.Vector3} playerPos
     * @param {THREE.Vector3|null} playerVelDir
     * @private
     */
    _stowCatch(playerPos, playerVelDir) {
        const target = this.target;
        const cellIndex = this._reelCellIndex;

        // Keep the catch pinned to the cell anchor. Detach the reel-pin reference
        // so _resetLasso() below does NOT release the pin — the cargo tick now
        // owns it (persisting on the hull through the furnace window).
        if (target) {
            if (!target._armPinPos) target._armPinPos = new THREE.Vector3();
            this._cargoCellWorld(playerPos, playerVelDir, cellIndex, _scratchMuzzle);
            target._armPinPos.copy(_scratchMuzzle);
            target._armPinned = true;
            target._catchRenderMin = Constants.MOTHER_CATCH_MIN_RENDER_M * M;
        }
        this._reelPinTarget = null; // hand pin ownership to the cargo system

        this._cargo.push({
            target,
            cellIndex,
            furnaceTimer: 0,
            breakdownStarted: false,
        });

        // Onboarding/tutorial advance + capture juice fire at STOW (not furnace end).
        eventBus.emit(Events.LASSO_STOWED, {
            debrisId: target ? target.id : null,
            cellIndex,
        });
        eventBus.emit(Events.LASSO_CAPTURED, {
            debrisId: target ? target.id : null,
            type: target ? target.type : 'unknown',
            mass: target ? (target.mass || 0) : 0,
        });
        eventBus.emit(Events.ARM_CAPTURED, {
            armId: 'lasso',
            debrisId: target ? target.id : null,
        });
        // NOTE: no per-catch comms here — the furnace breakdown (CATCH_BREAKDOWN_START
        // → GameFlowManager) already narrates, and a sourceless message per catch
        // spammed both the comms feed and the console.

        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_CATCH;
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_CATCH });
    }

    /**
     * Phase 4: tick stowed catches — keep them pinned to their (moving) aft cell
     * anchor and run the staged furnace breakdown. Reuses the daughter timing
     * (FURNACE_TRANSFER: HOLD → CHOP → FEED) and emits the SAME CATCH_BREAKDOWN_START
     * + single CATCH_PROCESSED the daughter does, so GameFlowManager's existing
     * handler performs salvage + scoring + removeDebris exactly once. Runs every
     * frame (cargo persists across casts), independent of lasso active state.
     * @param {number} dt
     * @param {THREE.Vector3} playerPos
     * @param {THREE.Vector3|null} playerVelDir
     * @private
     */
    _updateCargo(dt, playerPos, playerVelDir) {
        if (!this._cargo.length) return;
        const FT = Constants.FURNACE_TRANSFER;
        for (let i = this._cargo.length - 1; i >= 0; i--) {
            const item = this._cargo[i];
            const target = item.target;

            // Keep the catch riding its aft cell anchor on the (reorienting) hull.
            if (target && playerPos) {
                if (!target._armPinPos) target._armPinPos = new THREE.Vector3();
                this._cargoCellWorld(playerPos, playerVelDir, item.cellIndex, _scratchMuzzle);
                target._armPinPos.copy(_scratchMuzzle);
                target._armPinned = true;
                target._catchRenderMin = Constants.MOTHER_CATCH_MIN_RENDER_M * M;
            }

            item.furnaceTimer += dt;

            // CHOP begins at HOLD_S — narrate the breakdown once (single owner is
            // GameFlowManager's CATCH_BREAKDOWN_START handler).
            if (!item.breakdownStarted && item.furnaceTimer >= FT.HOLD_S) {
                item.breakdownStarted = true;
                eventBus.emit(Events.CATCH_BREAKDOWN_START, {
                    armId: 'lasso',
                    debrisId: target ? target.id : null,
                    chunkCount: FT.CHUNK_COUNT,
                });
            }

            // FEED completes at FEED_S — the single CATCH_PROCESSED owns salvage +
            // scoring + removeDebris (in GameFlowManager). Release our pin and free
            // the cell.
            if (item.furnaceTimer >= FT.FEED_S) {
                if (target) target._armPinned = false;
                if (target) target._catchRenderMin = 0;
                eventBus.emit(Events.CATCH_PROCESSED, {
                    armId: 'lasso',
                    debrisId: target ? target.id : null,
                    type: target ? target.type : 'fragment',
                });
                this._cargo.splice(i, 1);
            }
        }
    }

    /**
     * Phase 3 (LASSO_REEL_PHYSICS, gated): mass-driven reel tension + a subtle
     * centre-of-mass pull toward the catch + tangle/break risk. Only ever called
     * when _reelPhysicsActive is latched true at contact (flag ON, NOT Mission 1,
     * capturedMass > LASSO_MAX_CAPTURE_MASS), so the tutorial / welcome catches
     * never reach this path. VISUAL/MOTION uses the fuel-free, self-damping
     * _rcsVelocity channel (the same one the collision-dodge uses), clamped by
     * RCS_MAX_SPEED — never the fuel-charging applyCartesianImpulse.
     * @param {number} dt
     * @param {THREE.Vector3} playerPos
     * @private
     */
    _applyReelPhysics(dt, playerPos) {
        const capturedMass = this.target ? (this.target.mass || 0) : 0;

        // --- Mass-driven tension (mirror CaptureNet.js:879) ---
        const tensionN = Constants.LASSO_TENSION_BASE_N + capturedMass * Constants.LASSO_TENSION_PER_KG;
        const strainFraction = capturedMass / Math.max(1, Constants.LASSO_NET_RATED_MASS_KG);
        eventBus.emit(Events.TETHER_TENSION, {
            tensionFraction: this._reelProgress, // keep progress for legacy HUD/audio
            tensionN,                            // real Newtons (Phase 3 HUD/tautness)
            strainFraction,                      // 0..1+ vs net rating
            armId: 'lasso',
        });

        // --- CoM pull toward the catch (momentum) ---
        // Reeling a mass m toward the ship pulls the ship toward the catch by
        // m/m_ship. Nudge _rcsVelocity toward the (player-relative) net package,
        // scaled by mass ratio × reel rate, clamped by RCS_MAX_SPEED.
        if (this._player && this._player._rcsVelocity && this.projectilePos) {
            const shipMass = (this._player.mass && this._player.mass > 0) ? this._player.mass : 130;
            const massRatio = capturedMass / (capturedMass + shipMass);
            const toCatch = new THREE.Vector3().subVectors(this.projectilePos, playerPos);
            if (toCatch.lengthSq() > 1e-20) {
                toCatch.normalize();
                const nudge = Constants.LASSO_REEL_PULL_GAIN * massRatio *
                    Constants.LASSO_REEL_SPEED * dt * Constants.RCS_MAX_SPEED;
                this._player._rcsVelocity.addScaledVector(toCatch, nudge);
                const maxV = Constants.RCS_MAX_SPEED;
                if (this._player._rcsVelocity.length() > maxV) {
                    this._player._rcsVelocity.normalize().multiplyScalar(maxV);
                }
                // (b) Angular coupling: a heavy OFF-AXIS catch also tugs the
                // Mother's nose toward it while hauling. Fed to the recoil
                // attitude springs (RCS-nulled). Centreline catches → no tug.
                if (typeof this._player.applyReelTorque === 'function') {
                    this._player.applyReelTorque(toCatch, massRatio, dt);
                }
            }
        }

        // --- Tangle / break risk ---
        // Sustained strain above NET_STRAIN_SAFE_FRACTION accumulates; past
        // LASSO_NET_BREAK_TIME_S the tether snaps, dropping the catch (no score,
        // no removeDebris) with a miss-style cooldown.
        if (strainFraction > Constants.NET_STRAIN_SAFE_FRACTION) {
            this._strainTimer += dt;
            if (this._strainTimer >= Constants.LASSO_NET_BREAK_TIME_S) {
                this._snapTether(tensionN);
                return;
            }
        } else {
            this._strainTimer = Math.max(0, this._strainTimer - dt); // strain recovers when eased
        }
    }

    /**
     * Phase 3: snap the tether under over-strain — drop the catch cleanly (release
     * the reel pin, NO removeDebris/score) and go to a miss-style cooldown.
     * @param {number} tensionN
     * @private
     */
    _snapTether(tensionN) {
        const targetId = this.target ? this.target.id : null;
        eventBus.emit(Events.LASSO_SNAPPED, { targetId, tensionN });
        eventBus.emit(Events.LASSO_MISSED); // tutorial/skills treat a snap as a failed catch
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'Net tether snapped under load. Catch lost. Detumble or use a Daughter.',
            source: 'SYSTEM',
            channel: 'CMD',
            priority: 'warning',
        });
        this._resetLasso(); // releases the _armPinned pin → debris resumes its orbit
        this.cooldown = Constants.LASSO_COOLDOWN_MISS;
        this.cooldownMax = Constants.LASSO_COOLDOWN_MISS;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_MISS });
    }

    /** Complete a successful lasso catch */
    _completeCatch(debrisField) {
        const target = this.target;

        // Remove debris from field
        if (debrisField && target) {
            debrisField.removeDebris(target.id);
        }

        // Emit lasso-specific catch event (TutorialSystem listens to this)
        eventBus.emit(Events.LASSO_CAPTURED, {
            debrisId: target ? target.id : null,
            type: target ? target.type : 'unknown',
            mass: target ? (target.mass || 0) : 0,
        });

        // Also emit ARM_CAPTURED for catch juice (slo-mo, flash, sound)
        eventBus.emit(Events.ARM_CAPTURED, {
            armId: 'lasso',
            debrisId: target ? target.id : null,
        });

        // Score the lasso catch through the normal pipeline
        eventBus.emit(Events.INTERACTION_CAPTURE, {
            points: Constants.TIER3_BASE || 500,
            type: target ? target.type : 'fragment',
        });

        // Record score in ScoringSystem (INTERACTION_CAPTURE only updates gameState)
        eventBus.emit(Events.SCORING_AWARD, {
            points: Constants.TIER3_BASE || 500,
            debris: target || { type: 'fragment', mass: 1 },
            method: 'arm',
            captureTier: 3,
        });

        // Comms
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: `Lasso catch! ${target ? target.type : 'debris'} secured.`,
            priority: 'info',
        });

        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_CATCH;
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_CATCH });
    }

    /**
     * Update gossamer silk particle trail — emit at projectile, update drift + fade.
     * @param {number} dt
     * @param {THREE.Vector3} playerPos
     * @private
     */
    _updateGossamerTrail(dt, playerPos) {
        if (!this._trailPoints) return;

        const N = this._trailCount;
        const pos = this._trailPositions;
        const alphas = this._trailAlphas;
        const births = this._trailBirths;
        const drift = this._trailDrift;
        const now = this._time;
        const lifetime = this._trailLifetime;

        // ── Emit new particles during flight (not reel-in) ────────────────
        if (this.active && this.projectilePos && !this._reelingIn) {
            this._trailPoints.visible = true;
            // Emit ~60 particles/sec (1 per ~0.016s)
            this._trailEmitAccum += dt;
            const emitInterval = 0.016;
            while (this._trailEmitAccum >= emitInterval) {
                this._trailEmitAccum -= emitInterval;
                const i = this._trailHead;
                const i3 = i * 3;

                // Position at projectile with small random offset
                pos[i3]     = this.projectilePos.x + (Math.random() - 0.5) * M * 3;
                pos[i3 + 1] = this.projectilePos.y + (Math.random() - 0.5) * M * 3;
                pos[i3 + 2] = this.projectilePos.z + (Math.random() - 0.5) * M * 3;

                // Curl-noise-like drift: random perpendicular velocity
                const driftSpeed = M * 0.5; // very slow lateral drift
                drift[i3]     = (Math.random() - 0.5) * driftSpeed;
                drift[i3 + 1] = (Math.random() - 0.5) * driftSpeed;
                drift[i3 + 2] = (Math.random() - 0.5) * driftSpeed;

                births[i] = now;
                alphas[i] = 1.0;

                this._trailHead = (i + 1) % N;
            }
        }

        // ── Update all particles: drift + fade ────────────────────────────
        let anyAlive = false;
        for (let i = 0; i < N; i++) {
            if (births[i] <= 0) continue; // inactive slot
            const age = now - births[i];
            if (age > lifetime) {
                // Dead — hide particle
                alphas[i] = 0;
                births[i] = 0;
                continue;
            }
            anyAlive = true;

            // Smooth fade: ease-out (fast at start, slow tail)
            const t = age / lifetime;
            alphas[i] = 1.0 - t * t; // quadratic fade-out

            // Drift with curl-like sinusoidal modulation
            const i3 = i * 3;
            const curlPhase = age * 4.0 + i * 0.7; // unique per particle
            pos[i3]     += drift[i3]     * dt + Math.sin(curlPhase) * M * 0.02 * dt;
            pos[i3 + 1] += drift[i3 + 1] * dt + Math.cos(curlPhase * 1.3) * M * 0.02 * dt;
            pos[i3 + 2] += drift[i3 + 2] * dt + Math.sin(curlPhase * 0.7) * M * 0.02 * dt;
        }

        // Update GPU buffers
        if (this._trailPoints.visible) {
            this._trailPoints.geometry.attributes.position.needsUpdate = true;
            this._trailPoints.geometry.attributes.alpha.needsUpdate = true;
        }

        // Hide trail when all particles dead and lasso inactive
        if (!this.active && !anyAlive) {
            this._trailPoints.visible = false;
        }
    }

    /** Cancel/retract lasso without a catch */
    _cancelLasso() {
        eventBus.emit(Events.LASSO_MISSED);  // notify tutorial of mid-flight miss
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'Lasso retracted. No contact.',
            priority: 'info',
        });
        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_MISS;
        this.cooldownMax = Constants.LASSO_COOLDOWN_MISS;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_MISS });
    }

    /** Reset lasso state */
    _resetLasso() {
        // Release the reel-in pin so a cancelled-mid-reel piece returns to
        // normal propagation (on a completed catch the debris is already removed,
        // so this is a harmless no-op cleanup).
        if (this._reelPinTarget) {
            this._reelPinTarget._armPinned = false;
            this._reelPinTarget._catchRenderMin = 0;
            this._reelPinTarget = null;
        }
        this.active = false;
        this.target = null;
        this._targetId = null;
        this._targetScenePos = null;
        this._projOffset.set(0, 0, 0);
        this.projectilePos = null;
        this.projectileVel = null;
        this.flightTimer = 0;
        this._reelingIn = false;
        this._reelProgress = 0;
        this._netSpinAngle = 0;
        // Phase 3: clear reel-physics latch + strain accumulator for the next cast.
        this._reelPhysicsActive = false;
        this._strainTimer = 0;
        // Phase 4: clear the in-flight cargo-cell choice (stowed cargo persists).
        this._reelCellIndex = -1;

        if (this._netGroup) this._netGroup.visible = false;
        // Phase 2: restore the mouth to full radius so the static net geometry is
        // correct if the flag is toggled off and the next cast starts clean.
        if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) this._applyNetMouthRadius(1.0);
        if (this._tetherMesh) {
            this._tetherMesh.visible = false;
            this._tetherMesh.material.opacity = 0;
        }
        if (this._tetherCore) {
            this._tetherCore.visible = false;
            this._tetherCore.material.opacity = 0;
        }
        this._pulsePhase = 0;
        this._tetherCurve = null;
    }

    /**
     * Phase 6 + ST-2.4: Update visual effects independently of lasso active state.
     * Allows muzzle flash, contact flash, and sparks to persist briefly after reset.
     * @param {number} dt
     */
    _updateVisualEffects(dt) {
        // Muzzle flash fade (LASSO_MUZZLE_FLASH_TIME)
        if (this._muzzleFlashTimer > 0) {
            this._muzzleFlashTimer -= dt;
            const flashLife = Constants.LASSO_MUZZLE_FLASH_TIME || 0.2;
            this._muzzleFlash.material.opacity = Math.max(0, this._muzzleFlashTimer / flashLife) * 0.95;
            if (this._muzzleFlashTimer <= 0) {
                this._muzzleFlash.visible = false;
            }
        }

        // Contact flash fade (300ms)
        if (this._contactFlashTimer > 0) {
            this._contactFlashTimer -= dt;
            this._contactFlash.material.opacity = Math.max(0, this._contactFlashTimer / 0.3) * 0.9;
            if (this._contactFlashTimer <= 0) {
                this._contactFlash.visible = false;
            }
        }

        // Sparks removed per user feedback
    }

    // ── Public cooldown state accessors (ST-1.3) ────────────────────────────

    /** Seconds of cooldown remaining (0 = ready to fire) */
    get cooldownRemaining() {
        return Math.max(0, this.cooldown);
    }

    /** Fraction of cooldown elapsed: 0 = just started, 1 = ready (for ring UI) */
    get cooldownFraction() {
        if (this.cooldownMax <= 0 || this.cooldown <= 0) return 1;
        return 1 - (this.cooldown / this.cooldownMax);
    }

    /** Cleanup */
    dispose() {
        // Tear down eventBus subscriptions so a disposed LassoSystem isn't kept
        // alive (and doesn't keep mutating state) via its onboarding listeners.
        if (this._evtUnsubs) {
            this._evtUnsubs.forEach(u => { if (typeof u === 'function') u(); });
            this._evtUnsubs.length = 0;
        }
        // Dispose the shared net-mesh kit (cone + nodes + drawstring + apex hub).
        if (this._netGroup) {
            if (this._netKit) NetMeshKit.dispose(this._netKit);
            this.scene.remove(this._netGroup);
        }
        // Sprint 2 v2: Dispose coaxial tether (sheath + core)
        if (this._tetherMesh) {
            this.scene.remove(this._tetherMesh);
            NetMeshKit.unregisterLineMaterial(this._tetherMesh.material);
            this._tetherMesh.geometry.dispose();
            this._tetherMesh.material.dispose();
        }
        if (this._tetherCore) {
            this.scene.remove(this._tetherCore);
            this._tetherCore.geometry.dispose();
            this._tetherCore.material.dispose();
        }
        // Gossamer trail cleanup
        if (this._trailPoints) {
            this.scene.remove(this._trailPoints);
            this._trailPoints.geometry.dispose();
            this._trailPoints.material.dispose();
        }
        // Sparks removed — no cleanup needed
        if (this._muzzleFlash) {
            this.scene.remove(this._muzzleFlash);
            this._muzzleFlash.geometry.dispose();
            this._muzzleFlash.material.dispose();
        }
        if (this._contactFlash) {
            this.scene.remove(this._contactFlash);
            this._contactFlash.geometry.dispose();
            this._contactFlash.material.dispose();
        }
    }
}
