/**
 * LassoSystem.js — short-range net projectile: SPACE fires at the nearest debris in range (auto-aim cone ±30°).
 * @module systems/LassoSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';
import { tripRefuses } from './TransferTrip.js';
import { devShotGate } from '../core/DevShotGate.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';
import { classifyNetTarget, OUT_OF_MOTHER_NETS_LINE, targetRangeM, netRangeLine, motherNLine, motherNWorks } from './netRouting.js';
import { isFree, netRefusalLine, lassoRangeAllOwnedLine } from './PieceClaim.js';
import { NetMeshKit } from '../ui/NetMeshKit.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { DebrisField } from '../entities/DebrisField.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { degToRad, clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

/** 1 meter in scene units (1 unit = 100 km = 100000 m) */
const M = 0.00001;

/** Seconds a pending catch glides from its wait point onto the collar seat before adopting (never a teleport). */
const LASSO_ADOPT_SETTLE_S = 0.8;

/** Seconds the welded web fades out over the adopted catch; the berthed bag (NET_ADOPTED → CaptureNetVisual)
 *  appears at the same collar seat that frame, so it reads as a crossfade. Under both cooldowns (catch 2 s /
 *  miss 1 s): a re-cast never races a live fade. */
const LASSO_WEB_FADE_S = 0.35;

const _zAxis = new THREE.Vector3(0, 0, 1);

/** −Z axis: the NetMeshKit mouth points along local −Z; the net group maps local −Z onto the flight direction. */
const _negZAxis = new THREE.Vector3(0, 0, -1);

const _zeroVec = new THREE.Vector3(0, 0, 0);

/** Default forward when the ship has no velocity (mirrors fire()). */
const _defaultForward = new THREE.Vector3(0, 0, 1);

const _scratchFwd = new THREE.Vector3();
const _scratchToTarget = new THREE.Vector3();
const _scratchMuzzle = new THREE.Vector3();
const _scratchCargoOffset = new THREE.Vector3();
const _scratchNadir = new THREE.Vector3();
const _scratchTetherAnchor = new THREE.Vector3();

// Wrap drape-drive scratches; own copies (contents spec mirrors CaptureNetVisual's) so two live drivers never share one.
const _scratchAway = new THREE.Vector3();
const _scratchAway2 = new THREE.Vector3();
const _scratchPiecePos = new THREE.Vector3();
const _scratchOrientQuat = new THREE.Quaternion();
const _scratchSpinQuat = new THREE.Quaternion();
const _vWrapLocal = new THREE.Vector3();
const _vWrapBox = new THREE.Vector3();
const _qWrapA = new THREE.Quaternion();
const _qWrapB = new THREE.Quaternion();
const _m4Wrap = new THREE.Matrix4();
const _wrapBoxScratch = { ox: 0, oy: 0, oz: 0,
    r00: 1, r01: 0, r02: 0, r10: 0, r11: 1, r12: 0, r20: 0, r21: 0, r22: 1,
    hx: 0, hy: 0, hz: 0 };

export class LassoSystem {
    constructor(scene) {
        this.scene = scene;

        this.active = false;

        this.projectilePos = null;

        this.projectileVel = null;

        this.target = null;

        /** Debris held by the reel-in pin (_armPinned/_armPinPos); kept so it is released on reset after target clears. */
        this._reelPinTarget = null;

        /** Scene manager (null = web stays far pass); whether the web group is a near-field root now; the piece the web
         *  wraps (kept after `target` clears while the welded web fades). */
        this._nearSm = null;
        this._webNear = false;
        this._webDebris = null;

        /** Live web fade-out over an adopted catch; ticked by _updateVisualEffects, cleared at zero. */
        this._webFade = null;

        this._billowPhase = 0;

        /** Apex→piece depth at contact (scene units); the wrap eases it to the WRAP_SEAT_FRAC seat so the net slides
         *  OVER the piece (engulf) instead of pinning it at the apex tip. */
        this._wrapSeatD0 = 0;

        this._targetId = null;

        this._targetScenePos = null;
        /** `target` is the canonical field object (live `_scenePosition`), not a snapshot. */
        this._targetIsLive = false;

        /** @type {THREE.Vector3} Offset of projectile relative to player (local frame) */
        this._projOffset = new THREE.Vector3();

        /** Per-shot contact radius (scene units), scaled by launch distance. */
        this._contactRadiusScene = Constants.LASSO_CONTACT_RADIUS_M * M;

        /** Per-shot eased apparent flight speed (scene units / real second). */
        this._flightSpeedScene = Constants.LASSO_SPEED * M * TimeAuthority.BASE_SCALE;

        /** Last launch direction (world), for cosmetic recoil. */
        this._lastLaunchDir = null;

        this._player = null;

        this.flightTimer = 0;

        this.maxFlightTime = Constants.LASSO_MAX_FLIGHT_TIME;

        this.cooldown = 0;

        this._tetherMesh = null;

        this._tetherCore = null;

        /** Pulse bead phase (legacy; kept for reset compat). */
        this._pulsePhase = 0;

        this._tetherCurve = null;

        this._netGroup = null;

        this._reelingIn = false;

        this._reelProgress = 0;

        /** @type {THREE.Vector3} Reel start offset from player (relative coords — orbit-safe) */
        this._reelStartOffset = new THREE.Vector3();

        this._time = 0;

        this._muzzleFlash = null;
        this._muzzleFlashTimer = 0;

        this._contactFlash = null;
        this._contactFlashTimer = 0;

        /** @type {number} Accumulated net spin angle (radians) */
        this._netSpinAngle = 0;

        this._tetherSampleCount = Constants.NET_TETHER_SEGMENTS + 1;

        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;

        this._firstCastPrimerSent = false;

        // DECISIONS §33: the small net draws on the mother's ONE count of nets, owned by CaptureNetSystem (getAmmo() reads
        // it, fire() spends it). LassoSystem keeps no count of its own.

        /** Target id last announced as "in lasso range" (the proactive prompt fires once per entry). */
        this._inRangePromptId = null;

        /** True while the OnboardingDirector pipeline runs: its `lasso` beat teaches the in-range "Press N" prompt, so the
         *  system prompt is suppressed until ONBOARDING_COMPLETE (it would punch through tier 0 over early beats). */
        this._onboardingActive = false;
        // Unsubscribe handles for dispose(): else the closures keep a disposed LassoSystem alive on the eventBus.
        this._evtUnsubs = [
            eventBus.on(Events.ONBOARDING_STARTED, () => { this._onboardingActive = true; }),
            eventBus.on(Events.ONBOARDING_COMPLETE, () => { this._onboardingActive = false; }),
            eventBus.on(Events.GAME_RESET, () => { this._inRangePromptId = null; this._clearPendingAdoption(); }),
            // Track the active mission: reel-in physics is gated OFF on Mission 1 (the tutorial reels as before).
            eventBus.on(Events.MISSION_START, (data) => {
                this._missionNumber = (data && data.missionNumber != null) ? data.missionNumber : 1;
            }),
            eventBus.on(Events.LASSO_DENIED, (e) => this._trace('DENIED', e)),
            eventBus.on(Events.LASSO_CONTACT, (e) => this._trace('CONTACT', e)),
            eventBus.on(Events.LASSO_STOWED, (e) => this._trace('STOWED', e)),
            eventBus.on(Events.LASSO_SNAPPED, (e) => this._trace('SNAPPED', e)),
            eventBus.on(Events.LASSO_CAPTURED, (e) => this._trace('CAPTURED', e)),
        ];

        /** Active mission number (1 = tutorial; gates reel physics). */
        this._missionNumber = 1;

        /** Reel-in physics active for the CURRENT catch (flag ON && !isMission1 && capturedMass > LASSO_MAX_CAPTURE_MASS);
         *  latched at contact. */
        this._reelPhysicsActive = false;

        /** Seconds the tether has spent above the safe strain fraction. */
        this._strainTimer = 0;

        /** A completed catch waiting for the nose collar to free before adopting: { target, phase: 'wait'|'settle',
         *  settleT, fromPos, announced }. At most one (fire() refuses a new cast while it exists). */
        this._pendingAdoption = null;

        /** CaptureNetSystem (setCaptureNetSystem): the catch adopts onto its mother berth path; null (headless tests)
         *  = legacy instant path. */
        this._captureNetSystem = null;
        /** @type {object|null} Test seam for the net count (setMotherNetSupply); null in production. */
        this._motherNetSupply = null;

        /** Optional SkillsSystem for hint-gating (setSkillsSystem); absent = prompt fires ungated (headless). */
        this._skillsSystem = null;
        // Lasso failures reach SkillsSystem through LASSO_DENIED itself (catalog FAILURE_CAUSES); no wiring needed here.
        this._trailPoints = null;
        this._trailPositions = null;
        this._trailAlphas = null;
        this._trailBirths = null;
        this._trailDrift = null;
        this._trailHead = 0;
        this._trailCount = 200;
        this._trailLifetime = 1.0;
        this._trailEmitAccum = 0;

        this._createVisuals();

        this._dbgFrame = 0;
        // Dev diagnostics, installed ONLY under the net-shot opt-in (`?shot=1`/`?shotauto=1`, devShotGate.requested;
        // register item 18). Trace logging: window.__lassoDebug = true, then fire a net (N); snapshot: window.__lassoState().
        if (typeof window !== 'undefined' && devShotGate.requested) {
            window.__lasso = this;
            window.__lassoState = () => this._dbgSnapshot();
            // Live flag toggle for A/B testing: __lassoFlags() reads; __lassoFlags({ phys:false }) reverts reel physics;
            // __lassoFlags({ kin:false }) disables net open/cinch.
            window.__lassoFlags = (set) => {
                const F = Constants.FEATURE_FLAGS;
                if (set && typeof set === 'object') {
                    if ('kin' in set) F.LASSO_NET_KINEMATICS = !!set.kin;
                    if ('phys' in set) F.LASSO_REEL_PHYSICS = !!set.phys;
                }
                const now = {
                    kin: F.LASSO_NET_KINEMATICS,
                    phys: F.LASSO_REEL_PHYSICS,
                };
                console.log('[lasso] flags', now);
                return now;
            };
        }
    }

    _dbg() {
        return typeof window !== 'undefined' && window.__lassoDebug === true;
    }

    _trace(tag, obj) {
        if (this._dbg()) console.log(`[lasso] ${tag}`, obj || '');
    }

    /** Lifecycle snapshot for diagnostics (metres where noted). */
    _dbgSnapshot() {
        const M = 0.00001;
        const off = (this.projectilePos && this._lastPlayerPos)
            ? this.projectilePos.distanceTo(this._lastPlayerPos) / M : null;
        return {
            flags: {
                NET_KINEMATICS: Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS,
                REEL_PHYSICS: Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS,
                REALITY_MODE: Constants.FEATURE_FLAGS.REALITY_MODE,
            },
            active: this.active,
            reelingIn: this._reelingIn,
            reelProgress: +(this._reelProgress || 0).toFixed(3),
            flightTimer: +(this.flightTimer || 0).toFixed(3),
            cooldown: +(this.cooldown || 0).toFixed(2),
            ammo: this.getAmmo(),
            missionNumber: this._missionNumber,
            reelPhysicsActive: this._reelPhysicsActive,
            pendingAdoption: this._pendingAdoption
                ? { id: this._pendingAdoption.target && this._pendingAdoption.target.id, phase: this._pendingAdoption.phase }
                : null,
            projOffsetFromPlayer_m: off != null ? +off.toFixed(2) : null,
            target: this.target ? { id: this.target.id, mass: this.target.mass, type: this.target.type } : null,
            constants: {
                MIN_FLIGHT_TIME: Constants.LASSO_MIN_FLIGHT_TIME,
                MUZZLE_OFFSET_M: Constants.LASSO_MUZZLE_OFFSET_M,
                FURNACE_FEED_S: Constants.FURNACE_TRANSFER.FEED_S,
            },
        };
    }

    /** Inject SkillsSystem so the in-range prompt obeys hint-gating (mastered ⇒ silent; veteran ⇒ ticker; silent after
     *  MAX_UNHEEDED_NUDGES). Optional: unset = ungated. */
    setSkillsSystem(skillsSystem) {
        this._skillsSystem = skillsSystem || null;
    }

    setCaptureNetSystem(captureNetSystem) {
        this._captureNetSystem = captureNetSystem || null;
    }

    /** Forward firing direction for the arc constraint; single source for fire() and the in-range invite, so the invite
     *  never advertises a cast fire() rejects. Falls back to +Z without velocity. Writes into scratch `out`. */
    _resolveForwardDir(playerVelDir, out) {
        if (playerVelDir && playerVelDir.lengthSq() > 0) {
            return out.copy(playerVelDir).normalize();
        }
        return out.copy(_defaultForward);
    }

    /** World position of the nose launcher muzzle: LASSO_MUZZLE_OFFSET_M ahead of the hull centre along the nose
     *  (+Z/prograde); the net spawns here. Recomputed every frame as the ship reorients along velocity. */
    _computeMuzzleWorld(playerPos, playerVelDir, out) {
        const fwd = this._resolveForwardDir(playerVelDir, _scratchFwd);
        return out.copy(playerPos).addScaledVector(fwd, Constants.LASSO_MUZZLE_OFFSET_M * M);
    }

    /** Tether anchor for the OUTBOUND phase: a short way from the hull toward the *net*, so it is always collinear with
     *  the tether. Anchoring along velocity bowed the strand into an arch over the mother whenever cast ≠ prograde
     *  (read as a detached tether; owner: "tether seems disconnect from mother"). Offset clamped small so it hugs the hull.
     *  @param {THREE.Vector3} playerPos hull centre (world)
     *  @param {THREE.Vector3} netPos projectile/net position (world)
     *  @param {THREE.Vector3} out scratch target (world; returned) */
    _computeTetherAnchor(playerPos, netPos, out) {
        // Keep all math on `out` itself; do NOT alias a separate `dir` to it (that added playerPos·off and parked the
        // anchor ~100 m radially outward).
        out.copy(netPos).sub(playerPos);
        const dist = out.length();
        if (dist < 1e-9) return out.copy(playerPos);
        // Anchor at the NOSE TIP, not the 8 m spawn muzzle (that gap read as a detached tether). The hull (OCTOPUS_V5 core
        // ≈ 2 m) reads as connected when the strand starts within ~1.5 m of centre; shrink further for very short throws.
        const off = Math.min(1.5 * M, dist * 0.5);
        return out.multiplyScalar(off / dist).add(playerPos);
    }

    /** VISUAL-ONLY recoil kick of the mother mesh opposite the launch direction (no orbit change, fuel or _rcsVelocity,
     *  so the M1 station-keep/pin is undisturbed); springs back in PlayerSatellite. No-op without a player model.
     *  @param {THREE.Vector3} launchDir normalized world launch direction */
    _launchRecoil(launchDir) {
        if (!this._player || typeof this._player.applyCosmeticRecoil !== 'function') return;
        if (!launchDir) return;
        this._player.applyCosmeticRecoil(
            launchDir.clone().multiplyScalar(-Constants.LASSO_RECOIL_KICK_M * M)
        );
    }

    setPlayer(player) {
        this._player = player || null;
    }

    /** Hand over the scene manager so the web can draw in the near pass. The web follows the HELD piece it wraps (its
     *  `_nearProxy`, set by DebrisField when the pinned catch is within the near rule): a near-pass web over a far-pass
     *  piece would paint over it. In flight the web stays far pass. Unset = far pass. */
    attachNearField(sceneManager) {
        this._nearSm = sceneManager || null;
        if (!this._nearSm && this._webNear) this._webNear = false;
    }

    /** Put the web group in the near pass exactly while the piece it wraps is drawn there. The group is a scene child
     *  with a world position, i.e. a near-field root (the pass moves it to (world − camera)·S, scales ×S, then restores).
     *  Web lines are screen-space px (worldUnits false), unchanged by the pass. The piece is resolved BY ID through the
     *  field (CONVENTIONS.md Rule H): `target` may be a snapshot that never gets the field's `_nearProxy` flag. */
    _syncWebPass(debrisField = null) {
        const g = this._netGroup, sm = this._nearSm;
        if (!g || !sm || typeof sm.registerNearFieldRoot !== 'function') return;
        if (this.target) this._webDebris = this.target;
        else if (!g.visible) this._webDebris = null;
        const held = this._webDebris;
        const d = this._canonicalDebris(debrisField, held) || held;
        const want = !!(g.visible && d && d._nearProxy === true);
        if (want === this._webNear) return;
        this._webNear = want;
        if (want) sm.registerNearFieldRoot(g);
        else if (typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(g);
    }

    /** Berth axis the collar seat sits on: the ship's live forward (attitude) when a player is wired, else the
     *  prograde fallback. Matches CaptureNet.updateBerthHold so reel delivery and the adoption pin agree. */
    _berthAxis(playerVelDir, out) {
        const player = this._player;
        if (player && player.quaternion) {
            return out.set(0, 0, 1).applyQuaternion(player.quaternion).normalize();
        }
        return this._resolveForwardDir(playerVelDir, out);
    }

    /** A lasso catch is drawn at its TRUE size from contact to the collar (DECISIONS Ruling 0; same law as
     *  CaptureNet._catchFloorScale). Returns the piece's BASE render scale, which DebrisField.catchRenderFloorScale treats
     *  as no floor (its predicate only raises, `_catchRenderMin > base`). MOTHER_CATCH_MIN_RENDER_M stays in Constants.js
     *  (the non-ladder ceremony hold distance reads it). The scene/player params are unused. */
    _catchFloorFor(target, _scenePos, _playerPos) {
        return DebrisField.baseRenderScale(target);
    }

    /** World position of the collar seat a catch berths at: berth anchor + berth-axis × standoff, the exact standoff
     *  CaptureNet.updateBerthHold holds. The anchor is the COLLAR (on-axis), not the pod-0 muzzle. The lasso reels its
     *  package HERE and adoption pins it HERE, so the hand-off never snaps. Falls back to hull centre + prograde without
     *  a player (headless). */
    _collarSeatWorld(target, playerPos, playerVelDir, out) {
        // The seat is HOME: the catch's centre on the collar axis, the bag's surface on the ring (or clear of the nose parts
        // by 0.02 m); the same place the mother reel ends (CaptureNetSystem.getCatchHomeDistM → catchHomeDistM).
        const cnsHome = this._captureNetSystem;
        const R = Constants.CAPTURE_NET.REEL_HOME;
        const standoffM = (cnsHome && typeof cnsHome.getCatchHomeDistM === 'function' && target)
            ? cnsHome.getCatchHomeDistM(target)
            : ((target && target.sizeMeter ? target.sizeMeter : 2) / 2) + R.APEX_AT_RING_M;
        const player = this._player;
        if (player && typeof player.getNetBerthCollarPositionInto === 'function') {
            player.getNetBerthCollarPositionInto(out);
        } else if (player && typeof player.getNetPodPositionInto === 'function') {
            player.getNetPodPositionInto(0, out);
        } else {
            out.copy(playerPos);
        }
        this._berthAxis(playerVelDir, _scratchFwd);
        return out.addScaledVector(_scratchFwd, standoffM * M);
    }

    /** Where the reel DELIVERS the piece. Adoption seats the catch at HOME (apex at the ring), so this IS the collar
     *  seat; the reel must land exactly there or the hand-off snaps. The pending-wait hold (_pinPending) uses the same
     *  seat and the settle glide animates onto it before adopting. */
    _reelDeliveryWorld(target, playerPos, playerVelDir, out) {
        return this._collarSeatWorld(target, playerPos, playerVelDir, out);
    }

    /** Create capture net projectile group, tube tether, trail, and flash visuals */
    _createVisuals() {
        // Unified web-in-space net: the shared NetMeshKit (Mother + Daughter), sized and styled by NET_WEB: a delicate web,
        // never a cage that out-masses ship + catch (GAME_DESIGN.md §2.1).
        // STRICTLY LOCAL-SPACE: the kit builds geometry around a local origin (apex (0,0,0), mouth along local −Z). World
        // positioning, orientation, open/cinch drive, reel and tether stay in update()/_applyNetMouthRadius/_setNetOpacity.
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

        // Handles for the open/cinch animation + tests (mouth radius driven through NetMeshKit.setMouthFraction).
        this._netWeights = this._netKit.rimWeights;          // rim nodes (open/cinch sweep)
        this._netFullRadiusScene = this._netKit.mouthRadius; // full open mouth radius (scene units)

        this._netGroup.visible = false;
        this.scene.add(this._netGroup);

        // The tether is rebuilt each frame from a QuadraticBezierCurve3 (NOT CatmullRom with 3 points: it extrapolates past
        // its endpoints, "out the back of mother"); a quadratic Bezier passes only through its two endpoints.

        // Fat-line tether (Line2/LineMaterial; matches the NetMeshKit web primitive): constant screen-space width + AA, smooth
        // at any thinness (a thin tube faceted/Frenet-twisted into a jagged staircase). Shares the web's resolution sync
        // (registered with NetMeshKit). _tetherCore is retired (kept null; its call sites are guarded).
        const tetherGeo = new LineGeometry();
        // Seed straight segment; rebuilt each frame from the live catenary in _rebuildTetherGeometry.
        tetherGeo.setPositions([0, 0, 0, 0, 0, M * 10]);
        const tetherMat = new LineMaterial({
            color: Constants.NET_WEB.WEB_COLOR, // cable and net share one colour SSOT
            linewidth: Constants.NET_WEB.TETHER_WIDTH_M, // world units (m): thickens on approach, AA-smooth at distance
            transparent: true,
            opacity: 0,             // faded in on fire()
            worldUnits: true,       // width is metres, not screen px
            dashed: false,
            blending: THREE.NormalBlending,
            depthWrite: false,
            depthTest: true,
        });
        NetMeshKit.registerLineMaterial(tetherMat);
        this._tetherMesh = new Line2(tetherGeo, tetherMat);
        this._tetherMesh.frustumCulled = false;
        this._tetherMesh.visible = false;
        // Tag CONNECTOR: the tether bridges mother and a captured target (separate scene objects), so it must lie on the
        // hull/target instead of sorting by raw depth.
        this._tetherMesh.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
        this.scene.add(this._tetherMesh);

        this._tetherCore = null;


        const flashGeo = new THREE.SphereGeometry(M * 10, 6, 6);
        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
        });
        this._muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
        this._muzzleFlash.visible = false;
        this._muzzleFlash.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
        this.scene.add(this._muzzleFlash);

        const contactGeo = new THREE.SphereGeometry(M * 12, 6, 6);
        const contactMat = new THREE.MeshBasicMaterial({
            color: 0x88ffff,
            transparent: true,
            opacity: 0,
        });
        this._contactFlash = new THREE.Mesh(contactGeo, contactMat);
        this._contactFlash.visible = false;
        this._contactFlash.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
        this.scene.add(this._contactFlash);

        const N = this._trailCount;
        this._trailPositions = new Float32Array(N * 3);
        this._trailAlphas = new Float32Array(N);
        this._trailBirths = new Float32Array(N); // 0 = inactive
        this._trailDrift = new Float32Array(N * 3);

        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position', new THREE.BufferAttribute(this._trailPositions, 3));
        trailGeo.setAttribute('alpha', new THREE.BufferAttribute(this._trailAlphas, 1));

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
        this._trailPoints.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
        this.scene.add(this._trailPoints);

    }

    /** Set opacity on the net web (cone, drawstring, edge nodes) via the kit; the tether is faded independently. */
    _setNetOpacity(opacity) {
        if (this._netKit) NetMeshKit.setOpacity(this._netKit, opacity);
    }

    /** Net MOUTH radius as a fraction of the full perimeter radius, in [NET_CINCH..1] (LASSO_NET_KINEMATICS): open on
     *  launch, cinch on capture; a kinematic mapping, not cloth. No-op before the kit exists. */
    _applyNetMouthRadius(radiusFrac) {
        if (this._netKit) NetMeshKit.setMouthFraction(this._netKit, radiusFrac);
    }

    /**
     * Drive the shared kit's REAL drape machinery during the lasso's WRAP + haul (the vocabulary the mother pod-net speaks,
     * CaptureNetVisual drape driver): ring-collapse cinch onto the piece's contents floor, elbow redistribution, size-aware
     * welded film. Envelop leads (drape saturates by cinchT 0.5); the drawstring completes (cinchFrac = cinchT, held 1
     * through the haul); the film fades base → the SMALL welded rest (catchSizeM = LOGICAL size: the floored rendered
     * radius pops at reel entry and would re-fade the film).
     * The piece is pinned AT the projectile each reel frame (target._armPinPos ← projectilePos), i.e. the kit-group
     * origin: contentsZ ≈ 0, the co-located apex-pin case. The oriented-box spec mirrors CaptureNetVisual (own scratches:
     * two live drivers never share one). Contents are omitted (0 / null) when the debris has no drawable scale (bare
     * headless mocks): the kit treats that as an empty net bunching to a point.
     * @param {number} cinchT wrap progress in [0, 1]
     * @param {number} [gatherT] sock-gather in [0, 1]: how far the mouth ring has eased toward the contents' far face
     *   (0 during the wrap window; ramps over WRAP_SOCK_GATHER_RAMP after)
     */
    _driveWrapDrape(cinchT, gatherT = 0) {
        const kit = this._netKit;
        if (!kit) return;
        const drape = Math.min(1, cinchT * 2);
        const d = this.target;
        let contentsRadius = 0, contentsZ = 0, contentsBox = null, catchSizeM = 0;
        if (d && d._scenePosition) {
            catchSizeM = d.sizeMeter || 0;
            DebrisWireframe.getGeometry(d.type, d.id);            // br cache (uncached ⇒ 1)
            const br = DebrisWireframe.getBoundingRadius(d.type, d.id) || 1;
            const renderScale = DebrisField.effectiveRenderScale(d);
            if (Number.isFinite(renderScale) && renderScale > 0) {
                contentsRadius = renderScale * br;
                kit.group.updateMatrixWorld(true);
                const lp = kit.group.worldToLocal(_vWrapLocal.copy(d._scenePosition));
                contentsZ = lp.z;
                const bb = DebrisWireframe.getBoundingBoxExtents(d.type, d.id);
                if (bb) {
                    // Catch orientation in kit space: qB2K = qKit⁻¹ ⊗ tumble
                    // (frozen while _armPinned — the wrap cannot spin/drift).
                    kit.group.getWorldQuaternion(_qWrapA);
                    if (d.tumbleAxis) _qWrapB.setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
                    else _qWrapB.identity();
                    _qWrapA.invert().multiply(_qWrapB);           // box-local → kit-space
                    _vWrapBox.set(bb.cx * renderScale, bb.cy * renderScale, bb.cz * renderScale)
                        .applyQuaternion(_qWrapA);
                    _wrapBoxScratch.ox = lp.x + _vWrapBox.x;
                    _wrapBoxScratch.oy = lp.y + _vWrapBox.y;
                    _wrapBoxScratch.oz = lp.z + _vWrapBox.z;
                    // kit→box rotation rows (v_box = R·v_kit): matrix of qB2K⁻¹.
                    _m4Wrap.makeRotationFromQuaternion(_qWrapA.invert());
                    const e = _m4Wrap.elements;                    // column-major
                    _wrapBoxScratch.r00 = e[0]; _wrapBoxScratch.r01 = e[4]; _wrapBoxScratch.r02 = e[8];
                    _wrapBoxScratch.r10 = e[1]; _wrapBoxScratch.r11 = e[5]; _wrapBoxScratch.r12 = e[9];
                    _wrapBoxScratch.r20 = e[2]; _wrapBoxScratch.r21 = e[6]; _wrapBoxScratch.r22 = e[10];
                    _wrapBoxScratch.hx = bb.hx * renderScale;
                    _wrapBoxScratch.hy = bb.hy * renderScale;
                    _wrapBoxScratch.hz = bb.hz * renderScale;
                    contentsBox = _wrapBoxScratch;
                }
            }
        }
        NetMeshKit.updateWebDrape(kit, {
            drape,
            cinchFrac: cinchT,
            jigglePhase: 0,
            jiggleAmp: 0,
            contentsRadius,
            contentsZ,
            contentsBox,
            catchSizeM,
            mouthGather: gatherT,
        });
    }


    /** Rebuild the tether with a subtle catenary sag at the midpoint (scales with length, so short tethers stay taut);
     *  stores the curve in _tetherCurve. */
    _rebuildTetherGeometry(startPos, endPos) {
        if (!this._tetherMesh) return;

        const length = startPos.distanceTo(endPos);
        // Sag capped at NET_TETHER_SAG (m) or 5% of length, whichever is smaller.
        const sagMag = Math.min(Constants.NET_TETHER_SAG * M, length * 0.05);
        const mid = new THREE.Vector3()
            .addVectors(startPos, endPos)
            .multiplyScalar(0.5);
        // Sag toward NADIR (planet-down; Earth at the scene origin, so nadir = −normalize(mid)), NOT a fixed world axis, which
        // bowed the strand into an arch over the mother at most attitudes (reads as a detached tether). Vanishes to taut when
        // the tether is radial. A QuadraticBezierCurve3 apex sits halfway to the control point, so offset by 2× the sag.
        const nadir = mid.lengthSq() > 0
            ? _scratchNadir.copy(mid).normalize().multiplyScalar(-1)
            : _scratchNadir.set(0, -1, 0);
        mid.addScaledVector(nadir, sagMag * 2);

        const curve = new THREE.QuadraticBezierCurve3(
            startPos.clone(),
            mid,
            endPos.clone()
        );
        this._tetherCurve = curve;

        // Sample the catenary (NET_TETHER_SEGMENTS+1 points) into the fat-line strand, flattened to [x,y,z,…].
        const pts = curve.getPoints(Constants.NET_TETHER_SEGMENTS);
        const flat = this._tetherFlat && this._tetherFlat.length === pts.length * 3
            ? this._tetherFlat
            : (this._tetherFlat = new Float32Array(pts.length * 3));
        // Anchor-relative vertices (float32 precision): the ship orbits ~64–84 scene units from the origin (EARTH_RADIUS 63.71
        // + altitude), where float32 spacing is ≈ 7.6e-6 units ≈ 0.76 m against tether points ~1 m apart, so absolute vertices
        // snap to a "lightning-bolt" sawtooth (the web is immune: it lives in a local Group). Park the line AT the start anchor
        // and store vertices RELATIVE to it (float64 subtraction keeps the ~0.0003-unit offsets exact in float32; one
        // object-matrix translation shifts the strand together).
        this._tetherMesh.position.copy(startPos);
        for (let i = 0; i < pts.length; i++) {
            flat[i * 3] = pts[i].x - startPos.x;
            flat[i * 3 + 1] = pts[i].y - startPos.y;
            flat[i * 3 + 2] = pts[i].z - startPos.z;
        }
        this._tetherMesh.geometry.setPositions(flat);
    }

    /** The CANONICAL field object for a debris from getDebrisNear (a read-only SNAPSHOT: frozen `_scenePosition` and
     *  `orbit`) or a stale selection, found by id. The reel seeds its start offset and pin from `_scenePosition`; a
     *  snapshot is frozen while the ship moves ~78 km/s in scene space, so the catch was drawn tens of km off the line
     *  (owner 2026-10-18: the lasso catch never leaves the line). Returns null when the field has no `getDebrisById`,
     *  does not know the id, or the piece is dead (the caller then keeps `d` and reads the live `_targetScenePos`). */
    _canonicalDebris(debrisField, d) {
        if (!d || !debrisField || typeof debrisField.getDebrisById !== 'function') return null;
        const live = debrisField.getDebrisById(d.id);
        return (live && live.id === d.id && live.alive !== false) ? live : null;
    }

    /** Who owns `piece` now (a daughter flying, holding or lining up a launch for it, a mother net inbound, a catch
     *  held)? Null when nobody does or no arm manager is wired (headless mocks). The lasso itself is not asked: it is idle
     *  whenever this runs. */
    _pieceOwner(piece) {
        const am = this._player && this._player.armManager;
        if (!piece || !am || typeof am.pieceClaimOf !== 'function') return null;
        const claim = am.pieceClaimOf(piece);
        return claim && !isFree(claim) ? claim : null;
    }

    /** Where the target piece is NOW (scene units, shared reference: copy before keeping). A canonical target's
     *  `_scenePosition` is live; a snapshot's is frozen at fire, so prefer `_targetScenePos` (refreshed by id every frame). */
    _livePiecePos() {
        const t = this.target;
        if (this._targetIsLive && t && t._scenePosition) return t._scenePosition;
        return this._targetScenePos || (t && t._scenePosition) || this.projectilePos;
    }

    /** Scene position of a debris from getDebrisNear (`_cartesian.position`) or the field (`_scenePosition`). */
    _getDebrisScenePos(debris) {
        if (!debris) return null;
        if (debris._scenePosition) {
            return debris._scenePosition.clone();
        }
        if (debris._cartesian && debris._cartesian.position) {
            const p = debris._cartesian.position;
            return new THREE.Vector3(p.x, p.y, p.z);
        }
        return null;
    }

    /**
     * Proactive in-range prompt: a one-time "press N" comms hint when the Tab-selected target first comes within range,
     * inside the forward arc, with a cast possible. Re-arms when the target leaves range (10% hysteresis) / changes /
     * leaves the arc / a cast becomes impossible.
     * Invite ⇔ success: mirrors fire()'s constraints (range, mass, arc) so we never invite a cast it will refuse. The
     * line is tagged `_proactive` so commsSuppression tier-gates it (suppressed at tier 0: the Director owns onboarding).
     * @param {THREE.Vector3|null} [playerVelDir] prograde dir for the arc test
     * @private
     */
    _updateInRangePrompt(playerPos, selectedTarget, playerVelDir = null) {
        // During onboarding the Director's `lasso` beat teaches this; suppress so it can't contradict an earlier beat.
        if (this._onboardingActive) { this._inRangePromptId = null; return; }

        const canCast = !this.active && this.cooldown <= 0 && this.getAmmo() > 0;
        if (!canCast || !selectedTarget || !playerPos) {
            this._inRangePromptId = null;
            return;
        }

        const targetId = selectedTarget.id != null ? selectedTarget.id : selectedTarget.catalogId;
        const pos = this._getDebrisScenePos(selectedTarget);
        if (!pos) { this._inRangePromptId = null; return; }

        const dist = playerPos.distanceTo(pos);
        const rangeScene = Constants.LASSO_RANGE * M;
        // Hysteresis: leave by a 10% margin before re-arming, so a target at the boundary can't re-fire the prompt.
        const alreadyArmed = this._inRangePromptId === targetId;
        const enterRange = dist <= rangeScene;
        const stayRange = dist <= rangeScene * 1.1;
        const inRange = alreadyArmed ? stayRange : enterRange;
        const tooHeavy = (selectedTarget.mass || 1) > Constants.LASSO_MAX_CAPTURE_MASS;

        // Forward arc: same resolution as fire() (_resolveForwardDir, +Z fallback); always enforced, even at zero velocity.
        const fwdDir = this._resolveForwardDir(playerVelDir, _scratchFwd);
        const toTarget = _scratchToTarget.copy(pos).sub(playerPos).normalize();
        const inArc = toTarget.dot(fwdDir) >= Constants.LASSO_FORWARD_ARC_DOT;

        if (inRange && !tooHeavy && inArc) {
            if (this._inRangePromptId !== targetId) {
                // Hint-gating: skip when the lasso is mastered or after MAX_UNHEEDED_NUDGES, but still nudge a struggling player
                // (recent lasso-denied). Ungated without a SkillsSystem (tests).
                const ss = this._skillsSystem;
                if (ss && typeof ss.canFireHint === 'function') {
                    if (!ss.canFireHint('collect_lasso', { cause: 'lasso-denied' })) {
                        // Do NOT consume the transition: a later lasso-denied can flip canFireHint true while still in range; re-checked
                        // next frame.
                        return;
                    }
                }
                // While he flies a daughter N works HER tool: the line says "Esc, then N", or (Esc would recall her) waits, unconsumed,
                // until he is back on the ship. Picked now, as the hint is posted.
                const _nWorks = motherNWorks();
                const _castLine = motherNLine('In range. N to cast');
                const _castComms = motherNLine('Target in lasso range. Press N to cast.');
                if (_castLine == null) return;
                this._inRangePromptId = targetId;

                // Veteran: a one-line ticker entry instead of a comms line.
                const veteran = !!(ss && typeof ss.isVeteran === 'function' && ss.isVeteran());
                if (veteran) {
                    eventBus.emit(Events.HINT_POSTED, {
                        id: 'lasso_in_range',
                        text: _castLine,
                        // piloted: the glyph is Esc and no key lights (N is not what he presses first), as the Director's chips
                        glyph: _nWorks ? 'N' : 'Esc',
                        keys: _nWorks ? ['KeyN'] : [],
                        skillId: 'collect_lasso',
                        duration: 4000,
                        priority: 'normal',
                    });
                } else {
                    // Keep it actionable: no raw capture-odds % (noise to a new player); the labelled odds live in the Target panel
                    // badge and the reticle odds strip (SSOT ToolOdds).
                    eventBus.emit(Events.COMMS_MESSAGE, {
                        text: _castComms,
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
            this._inRangePromptId = null;
        }
    }

    /** Fire a lasso toward the nearest debris; true if fired. A Tab-selected `selectedTarget` takes priority over auto-aim. */
    fire(playerPos, debrisField, playerVelDir, selectedTarget = null) {
        if (selectedTarget && selectedTarget._disposed === true) selectedTarget = null;   // a disposed piece is no pick
        // Nothing is cast while the ship burns to the next field (one plain line).
        if (tripRefuses('lasso')) return false;
        if (this.active || this.cooldown > 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'cooldown' });
            // Say WHY the cast was rejected (else the only feedback is a red reticle flash + click).
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

        // Ammo: the mother's one count of nets (0 when the net system is not wired). One line at 0, never two (DECISIONS §33 row 3).
        if (this.getAmmo() <= 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_ammo' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: OUT_OF_MOTHER_NETS_LINE,
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
            });
            return false;
        }

        // The lasso rides the ONE holding model: a catch berths at the nose collar. Soft-block while that station is busy
        // (a mated/inbound mother net holds it, or a catch is already waiting for it).
        const cns = this._captureNetSystem;
        if (cns && (cns.getDockedCatch() || cns.hasMotherNetInFlight() || this._pendingAdoption)) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'collar_busy' });
            // A catch the nose cannot get rid of (no furnace; every tip and daughter cell taken) gets the plain "nose is full"
            // line; while a hand-off is pending the wait line stays.
            const noseFull = typeof cns.getNoseFullLine === 'function' ? cns.getNoseFullLine() : null;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: noseFull || 'Cargo berth busy. Wait for the nose collar to clear.',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
            });
            return false;
        }

        const rangeScene = Constants.LASSO_RANGE * M; // LASSO_RANGE (=== NET_LOCK_RANGE_M, 90 m) in scene units
        // A disposed piece (let go by a push-down or a drag sail) is never the nearest piece: it is no catch.
        const nearby = (debrisField.getDebrisNear(playerPos, rangeScene) || []).filter((p) => !(p && p._disposed));

        if (!nearby || nearby.length === 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_target' });
            // A Tab-selected piece beyond reach gets the line that names its distance and the limit.
            const selPos0 = selectedTarget ? this._getDebrisScenePos(selectedTarget) : null;
            const selRangeM = selPos0 ? targetRangeM(playerPos, selPos0) : Infinity;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: selRangeM > Constants.LASSO_RANGE && Number.isFinite(selRangeM)
                    ? netRangeLine(selRangeM, Constants.LASSO_RANGE, 'lasso')
                    : `No targets in lasso range (${Constants.LASSO_RANGE}m)`,
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
        let ownedSkipped = 0;   // pieces auto-aim passed over because somebody owns them

        // PRIORITY 1: a Tab-selected target in range wins.
        if (selectedTarget) {
            // A Tab-selected target can be a stale snapshot: read its LIVE field object.
            selectedTarget = this._canonicalDebris(debrisField, selectedTarget) || selectedTarget;
            const selectedPos = this._getDebrisScenePos(selectedTarget);
            // The player's own pick has an owner: one line, nothing is cast (InputManager.fireLasso refuses first; this is the
            // release-time and direct-caller backstop).
            const pickOwner = this._pieceOwner(selectedTarget);
            if (pickOwner) {
                eventBus.emit(Events.LASSO_DENIED, { reason: 'piece_owned' });
                eventBus.emit(Events.COMMS_MESSAGE, {
                    text: netRefusalLine(pickOwner), source: 'SYSTEM', channel: 'CMD', priority: 'warning', _lassoFeedback: true,
                });
                return false;
            }
            if (selectedPos) {
                const dist = playerPos.distanceTo(selectedPos);
                const mass = selectedTarget.mass || 1;
                if (mass > Constants.LASSO_MAX_CAPTURE_MASS) {
                    eventBus.emit(Events.LASSO_DENIED, { reason: 'too_heavy' });
                    // Shared classifier (single source with InputManager's Mother fire routing). InputManager hands every piece over 10 kg
                    // to the mother's large net before calling fire() (fireLasso, and again after the windup), so this refusal is reached
                    // only with no net system wired (CAPTURE_NET off) or a direct caller. It must not send the player back to N: nothing
                    // here can fire the large net. DECISIONS §33: no 10-500 kg 'daughter-sized' band.
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
        const maxAngle = degToRad(30); // ±30° cone

        if (!bestTarget) for (const d of nearby) {
            const debrisPos = this._getDebrisScenePos(d);
            if (!debrisPos) continue;

            const toDebris = new THREE.Vector3().subVectors(debrisPos, playerPos);
            const dist = toDebris.length();
            toDebris.normalize();

            const dot = Math.max(-1, Math.min(1, toDebris.dot(aimDir)));
            const angle = Math.acos(dot);

            const mass = d.mass || 1;
            if (mass > Constants.LASSO_MAX_CAPTURE_MASS) continue;
            if (this._pieceOwner(d)) { ownedSkipped++; continue; }   // auto-aim leaves a piece somebody owns alone

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
                if (this._pieceOwner(d)) { ownedSkipped++; continue; }
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
                text: ownedSkipped > 0
                    ? lassoRangeAllOwnedLine()
                    : 'No suitable target for lasso (too heavy or no position)',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // Forward-arc constraint: the target must be in the forward hemisphere; shared _resolveForwardDir (same +Z fallback
        // as the invite) so the two gates never disagree.
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
                // During onboarding the Director owns alignment guidance: tier-gate this denial.
                _proactive: this._onboardingActive || undefined,
            });
            return false;
        }

        // getDebrisNear hands out SNAPSHOT copies (frozen `_scenePosition`/`orbit`): hold the CANONICAL field object so every
        // read of the target (contact seeding, the reel pin) is live.
        const liveTarget = this._canonicalDebris(debrisField, bestTarget);
        this._targetIsLive = !!liveTarget;
        if (liveTarget) bestTarget = liveTarget;
        this.active = true;
        this.target = bestTarget;
        this._targetId = bestTarget.id;
        this._targetScenePos = bestPos.clone();

        // Spawn the projectile + anchor the tether at the FRONT-CENTRE launcher muzzle (nose, +Z/prograde), not the hull
        // centroid; update() recomputes it every frame, here we only seed the spawn.
        const muzzleWorld = this._computeMuzzleWorld(playerPos, playerVelDir, new THREE.Vector3());
        this.projectilePos = muzzleWorld.clone();
        this._projOffset.copy(muzzleWorld).sub(playerPos); // player-relative muzzle offset

        const dir = new THREE.Vector3().subVectors(bestPos, muzzleWorld).normalize();
        this.projectileVel = dir.multiplyScalar(Constants.LASSO_SPEED * M); // LASSO_SPEED m/s in scene units (relative)
        this._lastLaunchDir = dir.clone();

        // Launch distance (muzzle → target, m) once at fire; the contact radius scales down for near targets and flight speed
        // is EASED so even a point-blank catch reads as a ~LASSO_MIN_FLIGHT_TIME arc, not a 0.02 s blink. Far targets keep the
        // fast 100 m/real-s apparent speed (capped by LASSO_MAX_FLIGHT_TIME).
        const launchDistanceM = muzzleWorld.distanceTo(bestPos) / M;
        const contactRadiusM = clamp(Constants.LASSO_CONTACT_RADIUS_FRACTION * launchDistanceM, Constants.LASSO_CONTACT_RADIUS_FLOOR_M, Constants.LASSO_CONTACT_RADIUS_M);
        this._contactRadiusScene = contactRadiusM * M;

        const maxApparentSpeed = Constants.LASSO_SPEED * TimeAuthority.BASE_SCALE; // 100 m/s apparent
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
            },
        });

        // Show net visuals; reset scale in case a prior reel-in collapsed it. A still-ticking web fade (tests can re-fire
        // inside the fade window; production cooldowns cannot) hands the kit back to the new cast: rebuild the natural cone so
        // the flight web never starts welded-shaped.
        if (this._webFade) {
            this._webFade = null;
            if (this._netKit) NetMeshKit.updateWebDrape(this._netKit, {});
        }
        this._netGroup.visible = true;
        this._netGroup.scale.setScalar(1.0);
        // Leave the canister with the mouth compact so open-on-launch has somewhere to open FROM (else it pops full).
        if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) {
            this._applyNetMouthRadius(Constants.NET_LAUNCH_COMPACT_FRAC);
        }
        // Cool pre-contact web tint (reset any green left from a prior reel).
        if (this._netKit) NetMeshKit.setColor(this._netKit, Constants.NET_WEB.WEB_COLOR);
        this._setNetOpacity(Constants.NET_WEB.WEB_OPACITY);
        this._tetherMesh.visible = true;
        this._tetherMesh.material.opacity = 0.55;
        if (this._tetherCore) {
            this._tetherCore.visible = true;
            this._tetherCore.material.opacity = 0.8;
        }
        this._pulsePhase = 0;
        // Muzzle puff AT THE CANISTER (nose), scaled up and longer so the net visibly emerges from hardware.
        this._muzzleFlash.position.copy(muzzleWorld);
        this._muzzleFlash.scale.setScalar(Constants.LASSO_MUZZLE_FLASH_SCALE);
        this._muzzleFlash.visible = true;
        this._muzzleFlashTimer = Constants.LASSO_MUZZLE_FLASH_TIME;
        this._muzzleFlash.material.opacity = Constants.LASSO_MUZZLE_FLASH_OPACITY ?? 0.95;
        this._launchRecoil(this._lastLaunchDir);

        eventBus.emit(Events.LASSO_FIRED, {
            targetId: bestTarget.id,
            projectileMass: Constants.LASSO_PROJECTILE_MASS,
            launchDirection: this.projectileVel.clone().normalize(),
            speed: Constants.LASSO_SPEED,
        });

        if (!this._firstCastPrimerSent) {
            this._firstCastPrimerSent = true;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Lasso deployed. Hold steady for catch. Recharges from onboard power.',
                priority: 'info',
            });
        }

        // The shot has really launched (every refusal check is behind us): spend one mother net, hit or miss.
        // CaptureNetSystem emits NET_INVENTORY_CHANGED{source:'mother'} and says "One mother net left." at 1.
        const supply = this._motherNetSupply || this._captureNetSystem;
        if (supply && typeof supply.spendMotherNet === 'function') supply.spendMotherNet();

        return true;
    }

    /** The mother's net count (HUD and cast gate): CaptureNetSystem's one count; 0 with no net system wired (CAPTURE_NET
     *  off), so the lasso does not fire (DECISIONS §33 row 1). */
    getAmmo() {
        const cns = this._motherNetSupply || this._captureNetSystem;
        return cns && typeof cns.getMotherNetCount === 'function' ? cns.getMotherNetCount() : 0;
    }

    /** Test seam: a separate source for the net count (`getMotherNetCount()`/`spendMotherNet()`) for headless
     *  legacy-resolution tests with NO capture net system wired (a wired one makes the catch adopt onto the nose collar).
     *  Production never calls this. */
    setMotherNetSupply(supply) {
        this._motherNetSupply = supply || null;
    }

    _getLiveTargetPos(debrisField) {
        // `== null` so targetId === 0 (a valid first debris) is not treated as "target died".
        if (this._targetId == null || !debrisField) return null;
        const debris = debrisField.getDebrisById
            ? debrisField.getDebrisById(this._targetId)
            : null;
        if (!debris || !debris.alive) return null;
        // Prefer the live _scenePosition (matches _getDebrisScenePos at fire; honours the onboarding pin whose ORBIT is
        // intentionally frozen): a pinned piece's orbit is the stale spawn position the mother flies past, which made the net
        // home BACKWARD.
        if (debris._scenePosition) return debris._scenePosition.clone();
        if (!debris.orbit) return null;
        const cart = orbitToSceneCartesian(debris.orbit);
        return new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
    }

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

        this._updateVisualEffects(dt);

        // catch-near-pass (Decision 2): the web follows the held piece it wraps into the same pass.
        this._syncWebPass(debrisField);

        // Tick a catch waiting for the nose collar (hold clear of the occupant, settle in, adopt). Runs regardless of active
        // state: the wait persists across casts.
        this._updatePendingAdoption(dt, playerPos, playerVelDir, debrisField);

        // Proactive in-range prompt (tier-gated, onboarding-suppressed).
        this._updateInRangePrompt(playerPos, selectedTarget, playerVelDir);

        if (!this.active) return;


        this.flightTimer += dt;

        const liveTargetPos = this._getLiveTargetPos(debrisField);
        if (liveTargetPos) {
            this._targetScenePos.copy(liveTargetPos);
        } else if (!this._reelingIn) {
            this._cancelLasso();
            return;
        }

        if (this._reelingIn) {
            this._reelProgress += dt * Constants.LASSO_REEL_SPEED;
            this._reelProgress = Math.min(this._reelProgress, 1.0); // clamp — prevent overshoot
            this._billReelMotor(dt);
            if (this._reelProgress >= 1.0) {
                // Catch complete: it adopts onto the nose-collar berth, or (no capture system, headless) resolves via the legacy
                // instant path.
                this._resolveCatch(debrisField, playerPos, playerVelDir);
                return;
            }

            // Tether tension feedback grows with reel progress. With reel physics active (heavy, non-M1 catch) also carry the
            // mass-driven tension (N) + a strain fraction, a subtle CoM pull toward the catch, and snap risk under sustained
            // over-strain. Gate OFF: payload + timing unchanged.
            if (this._reelPhysicsActive) {
                this._applyReelPhysics(dt, playerPos);
                if (!this.active) return; // a snap reset the lasso this frame
            } else {
                eventBus.emit(Events.TETHER_TENSION, {
                    tensionFraction: this._reelProgress,
                    armId: 'lasso',
                });
            }

            // Two-phase capture: WRAP (net shrinks at contact) → REEL (compact package travels to player).
            const WRAP_END = 0.2;                              // wrap phase: t ∈ [0, 0.2]
            const COMPACT_SCALE = Constants.NET_COMPACT_SCALE;

            // The web stays ivory Dyneema through the haul (a real net doesn't change colour when it grips; capture state is on
            // the HUD/comms, as in CaptureNetVisual). ORDER MATTERS: this hold runs BEFORE the drape drive below: setOpacity
            // writes the membrane's plain 0.28 rest, and updateWebDrape's welded fade must land after it or the film
            // re-brightens every frame (the mother path keeps the same write order).
            if (this._netKit) NetMeshKit.setColor(this._netKit, Constants.NET_WEB.WEB_COLOR);
            this._setNetOpacity(Constants.NET_WEB.WEB_OPACITY);

            if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) {
                // The wrap speaks the mother pod-net's drape vocabulary, not _applyNetMouthRadius (its uniform cone+membrane XY scale
                // read as "debris shrinking wrapped in a geodesic bubble"): rim weights cinch onto the kit's own closed radius
                // (cone/membrane meshes stay at scale 1) while updateWebDrape bunches threads+film onto the piece's contents floor
                // with the size-aware welded fade (_driveWrapDrape). Group scale stays 1 either way.
                const cinchT = Math.min(1, this._reelProgress / WRAP_END);
                if (this._netGroup) this._netGroup.scale.setScalar(1.0);
                if (this._netKit) {
                    // Sock gather: once the cinch completes the mouth ring eases toward the piece (rosette ON the bundle) instead of
                    // trailing as an empty sock. Drape first, rim second: setRimCinch reads the drape's effective mouth plane (_mouthZEff)
                    // so the beads ride THIS frame's gathered fabric.
                    const gatherT = (Constants.NET_WEB.WRAP_SOCK_GATHER_FRAC ?? 0)
                        * clamp01((this._reelProgress - WRAP_END)
                            / (Constants.NET_WEB.WRAP_SOCK_GATHER_RAMP ?? 0.25));
                    this._driveWrapDrape(cinchT, gatherT);
                    NetMeshKit.setRimCinch(this._netKit, cinchT);
                }
            } else if (this._netGroup) {
                this._netGroup.scale.setScalar(
                    this._reelProgress < WRAP_END
                        ? 1.0 - (this._reelProgress / WRAP_END) * (1.0 - COMPACT_SCALE)
                        : COMPACT_SCALE
                );
            }

            let reelT;
            if (this._reelProgress < WRAP_END) {
                // WRAP: net stays at contact position while shrinking
                reelT = 0;
            } else {
                // REEL: compact package travels player-relative from contact → zero
                reelT = (this._reelProgress - WRAP_END) / (1 - WRAP_END);
            }
            // The PIECE is primary: it lerps contact → the reel DELIVERY point (the adoption seat, so the hand-off lands
            // pin-exact). The net APEX rides seatScene BEHIND the piece toward the ship: the piece sits INSIDE the bag (engulfed),
            // never at the apex tip. During WRAP the piece is stationary (reelT = 0) while the seat eases from the actual contact
            // depth to the WRAP_SEAT_FRAC seat: the net slides OVER the piece as the mouth cinches behind it.
            this._reelDeliveryWorld(this.target, playerPos, playerVelDir, _scratchMuzzle);
            const reelEndOffset = _scratchCargoOffset.copy(_scratchMuzzle).sub(playerPos);
            const pieceOffset = new THREE.Vector3().lerpVectors(
                this._reelStartOffset, reelEndOffset, reelT
            );
            const piecePos = _scratchPiecePos.copy(playerPos).add(pieceOffset);
            // Reel-tick forensics (dev-gated): names the garbage INPUT when the pin goes km-scale; no hot-path allocation unless
            // the lasso debug flag is on.
            if (this._dbg()) {
                this._dbgReel = {
                    reelT: +reelT.toFixed(3),
                    startM: +(this._reelStartOffset.length() / M).toFixed(1),
                    endM: +(reelEndOffset.length() / M).toFixed(1),
                    pieceOffM: +(pieceOffset.length() / M).toFixed(1),
                };
            }
            let seatScene = 0;
            _scratchAway2.copy(pieceOffset);
            if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS && this._netKit
                && _scratchAway2.lengthSq() > 1e-18) {
                _scratchAway2.normalize();
                const seatTarget = this._netKit.coneHeight * (Constants.NET_WEB.WRAP_SEAT_FRAC ?? 0);
                const cinchT = Math.min(1, this._reelProgress / WRAP_END);
                seatScene = lerp(this._wrapSeatD0, seatTarget, cinchT);
            }
            this.projectilePos.copy(piecePos).addScaledVector(_scratchAway2, -seatScene);

            // Drag the captured debris along with the package: its position is otherwise owned by
            // DebrisField._updateInstanceTransform (orbit, or the onboarding pin released at LASSO_CONTACT). Use the
            // authoritative _armPinned/_armPinPos direct-copy pin (highest priority after the released onboarding pin); it also
            // exempts the package from distance LOD culling.
            if (this.target) {
                this._reelPinTarget = this.target;
                // Pin-priority belt: the onboarding tease pin OUTRANKS the arm pin in DebrisField._updateInstanceTransform; its
                // release rides the LASSO_CONTACT listener + an orbit resync, which intermittently lost the race under long SwiftShader
                // frames (piece rendered km off the ship mid-reel). The reel OWNS this piece: assert the release every frame (one
                // idempotent boolean write; the field's doc says "an arm capture releases the pin first, _armPinned wins after").
                this.target._onboardingPinned = false;
                this.target._catchRenderMin = this._catchFloorFor(this.target, piecePos, playerPos);
                // SAME-FRAME pin: pinCapturedDebris force-writes `_scenePosition` + the rendered instance NOW (debrisField already
                // ran this frame; a bare `_armPinPos` write draws one ship-step late, see _pinFresh).
                this._pinFresh(debrisField, this.target, piecePos);
            }
        } else {
            // Flight: the homing projectile tracks the target-relative-to-player offset in the local frame.
            const targetOffset = new THREE.Vector3().subVectors(this._targetScenePos, playerPos);
            const toTarget = new THREE.Vector3().subVectors(targetOffset, this._projOffset);
            const distToTarget = toTarget.length();

            if (distToTarget < this._contactRadiusScene &&
                this.flightTimer >= Constants.LASSO_MIN_FLIGHT_TIME) { // proximity + min-flight gate — contact!
                // The lasso homes on a live piece for up to LASSO_MAX_FLIGHT_TIME (~808 m of reach), so a piece that drifted beyond
                // the advertised reach since the cast is a miss, never a catch.
                if (this._targetScenePos && targetRangeM(playerPos, this._targetScenePos) > Constants.LASSO_RANGE) {
                    this._cancelLasso();
                    return;
                }
                this._reelingIn = true;
                // Normalize the kit out of the open-on-launch mouth scale ONCE at contact (openFrac has saturated by min-flight:
                // 0.8 s > NET_SPIN_UP_TIME 0.4 s, so it is (1,1,1) already; the explicit write is the contract). From here the wrap
                // owns the web via setRimCinch + updateWebDrape, which rebuild VERTICES in full-mouth space: leftover mesh scale
                // would shrink the drape's output.
                if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS && this._netKit) {
                    NetMeshKit.setMouthFraction(this._netKit, 1.0);
                }
                // Latch whether reel-in physics applies to THIS catch. MANDATORY gate: off on Mission 1 and for ≤ the Mother-net mass
                // cap, so tutorial/welcome catches reel identically regardless of the LASSO_REEL_PHYSICS flag.
                this._strainTimer = 0;
                const capturedMass = this.target ? (this.target.mass || 0) : 0;
                this._reelPhysicsActive =
                    Constants.FEATURE_FLAGS.LASSO_REEL_PHYSICS &&
                    this._missionNumber !== 1 &&
                    capturedMass > Constants.LASSO_MAX_CAPTURE_MASS;
                // Use LOCAL (player-relative) offsets only: mixing absolute frames added a velocity×dt error of ~1.3 km per frame at
                // 80 km/s apparent orbital velocity ("shoots out front, disappears, reels in from the back"). The reel lerp is
                // PIECE-primary: the start offset is the CATCH's player-relative offset at contact (the apex trails it); the
                // apex→piece depth at contact seeds the seat ease so the wrap slides the net OVER the stationary piece.
                // The piece's LIVE position: `_targetScenePos` was refreshed from the canonical object at the top of update(); a
                // snapshot target's own `_scenePosition` is frozen at fire.
                const pieceAtContact = this._livePiecePos();
                this._reelStartOffset.copy(pieceAtContact).sub(playerPos);
                // Contact-tick forensics (dev probe): names the source when the start offset reads km-scale garbage.
                this._dbgContact = {
                    startOffM: this._reelStartOffset.length() / M,
                    sceneRelM: this.target && this.target._scenePosition
                        ? this.target._scenePosition.clone().sub(playerPos).length() / M : null,
                    liveRelM: this._targetScenePos
                        ? this._targetScenePos.clone().sub(playerPos).length() / M : null,
                    projRelM: this._projOffset.length() / M,
                };
                this._wrapSeatD0 = 0;
                if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS && this._netKit) {
                    _scratchAway.copy(pieceAtContact).sub(playerPos);
                    if (_scratchAway.lengthSq() > 1e-18) {
                        _scratchAway.normalize();
                        const d0 = _scratchToTarget.copy(pieceAtContact)
                            .sub(this.projectilePos).dot(_scratchAway);
                        this._wrapSeatD0 = Math.min(
                            Math.max(d0, 0), this._netKit.coneHeight * 0.8);
                    }
                }
                this._reelProgress = 0;

                // Establish the reel-in pin AT CONTACT where the debris is now, so it doesn't render one frame at its stale orbital
                // position between the onboarding-pin release (LASSO_CONTACT, below) and the first reel frame (debrisField.update
                // runs before lassoSystem.update).
                if (this.target) {
                    this._reelPinTarget = this.target;
                    // Pin-priority belt (see the reel-frame twin above): the arm pin owns the piece from contact on.
                    this.target._onboardingPinned = false;
                    this.target._catchRenderMin = this._catchFloorFor(this.target, pieceAtContact, playerPos);
                    // Same-frame pin (see _pinFresh).
                    this._pinFresh(debrisField, this.target, pieceAtContact);
                }

                this._contactFlashTimer = 0;
                this._contactFlash.visible = false;

                // KEEP the tether visible through reel-in: the cue that the debris is being retracted. _rebuildTetherGeometry
                // rebuilds from current playerPos → projectilePos every frame (no retrograde-cast bug).


                eventBus.emit(Events.LASSO_CONTACT, { targetId: this.target.id });
            } else {
                // Move at the per-shot EASED apparent speed (_flightSpeedScene folds in TIME_SCALE_GAMEPLAY at fire). Clamp the step
                // so the net parks at contact range and waits out the min-flight gate instead of overshooting.
                const parkDist = Math.max(0, distToTarget - this._contactRadiusScene * 0.5);
                const step = Math.min(this._flightSpeedScene * dt, distToTarget, parkDist || distToTarget);
                toTarget.normalize().multiplyScalar(step);
                this._projOffset.add(toTarget);
            }

            this.projectilePos.copy(playerPos).add(this._projOffset);

            if (this.flightTimer > this.maxFlightTime) {
                this._cancelLasso();
                return;
            }
        }

        this._updateGossamerTrail(dt, playerPos);

        if (this._netGroup && this.projectilePos) {
            this._netGroup.position.copy(this.projectilePos);

            if (this._targetScenePos && !this._reelingIn) {
                // OPEN-ON-LAUNCH: the net leaves the canister compact and opens as the gyroscopic spin ramps over NET_SPIN_UP_TIME
                // (kinematic spin→centrifugal-open mapping, not a force sim); spin rate ramps with the open fraction.
                let spinScale = 1.0;
                if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS) {
                    const openFrac = Math.min(1, this.flightTimer / Constants.NET_SPIN_UP_TIME);
                    const mouthFrac = Constants.NET_LAUNCH_COMPACT_FRAC +
                        openFrac * (1.0 - Constants.NET_LAUNCH_COMPACT_FRAC);
                    this._applyNetMouthRadius(mouthFrac);
                    spinScale = 0.25 + 0.75 * openFrac; // spin-up while opening
                    // Organic flight web: the net BILLOWS (the kit's per-spoke jiggle channel) rather than flying as a perfect cone.
                    // Drape stays 0, so contents floors and the welded fade are untouched (both are drape/cinch-gated); the
                    // open-on-launch mouth scale composes on top (jiggle deforms vertices in full-mouth space; the scale opens it).
                    const billowFrac = Constants.NET_WEB.FLIGHT_BILLOW_FRAC ?? 0;
                    if (this._netKit && billowFrac > 0) {
                        this._billowPhase += dt * 2 * Math.PI
                            * (Constants.NET_WEB.FLIGHT_BILLOW_HZ ?? 0);
                        NetMeshKit.updateWebDrape(this._netKit, {
                            jigglePhase: this._billowPhase,
                            jiggleAmp: this._netKit.mouthRadius * billowFrac * openFrac,
                        });
                    }
                }
                const flightDir = new THREE.Vector3()
                    .subVectors(this._targetScenePos, playerPos).normalize();
                if (flightDir.lengthSq() > 0.001) {
                    const orientQuat = new THREE.Quaternion();
                    // The NetMeshKit cone points its MOUTH along local −Z (apex at the group origin / tether side): orient so local −Z
                    // maps onto the flight direction, opening the mouth toward the target (cosmetic only).
                    orientQuat.setFromUnitVectors(_negZAxis, flightDir);
                    this._netSpinAngle += 2 * Math.PI * Constants.NET_SPIN_HZ * spinScale * dt;
                    const spinQuat = new THREE.Quaternion();
                    spinQuat.setFromAxisAngle(_zAxis, this._netSpinAngle);
                    this._netGroup.quaternion.multiplyQuaternions(orientQuat, spinQuat);
                }
            } else {
                // Reel-in: the apex (tether side, kit origin) faces the ship and the wrapped mouth trails away, so the bundle reads
                // as DRAGGED home by its tether. Set the quaternion, not an Euler `rotation.z =` (that wiped the flight orientation
                // when the wrap started). Spin continues around the local drag axis.
                this._netSpinAngle += 2 * Math.PI * Constants.NET_SPIN_HZ * dt;
                _scratchAway.copy(this.projectilePos).sub(playerPos);
                if (_scratchAway.lengthSq() > 1e-18) {
                    _scratchAway.normalize();
                    _scratchOrientQuat.setFromUnitVectors(_negZAxis, _scratchAway);
                    _scratchSpinQuat.setFromAxisAngle(_zAxis, this._netSpinAngle);
                    this._netGroup.quaternion.multiplyQuaternions(_scratchOrientQuat, _scratchSpinQuat);
                }
            }
        }

        // Rebuild the tether EVERY frame from the front-centre MUZZLE (nose, +Z/prograde) → projectile (the muzzle is
        // recomputed each frame as the ship reorients). During reel-in the package returns toward the hull centre. With
        // QuadraticBezierCurve3 (no extrapolation) the tether goes from the muzzle to the net and nowhere else.
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
     * Same-frame pin. DebrisField.update (main.js) consumes `_armPinPos` BEFORE this system moves it, so a bare write left
     * the rendered piece, and `_scenePosition` (which the catch cut and its 250 m sanity fence read), ONE FRAME of apparent
     * ship travel behind the net: ~128 m at 60 fps, 7.7 km under the SwiftShader 0.1 s dt clamp. ArmManager and CaptureNet
     * solve this ordering with `pinCapturedDebris` ("force the rendered instance ... THIS frame, overriding whatever
     * this.update() computed earlier"); the lasso was the only per-frame pin writer missing it. Headless mocks without a
     * field (or lacking the method) keep the bare writes. Resolves the lasso-side pin lag noted in CAPTURE_NET.md §12.1
     * trap 3; pinned against the REAL DebrisField write path by the §12.1 FRAME ORDER family in test-LassoSystem.js (bare
     * write trails 1166.67 m at 60 fps / 0.7 u/s).
     * @param {THREE.Vector3} pos — scene position for the pin THIS frame
     * @private
     */
    _pinFresh(debrisField, target, pos) {
        if (!target || !pos) return;
        // Own the lasso-side pin state unconditionally (headless mocks may
        // implement pinCapturedDebris sparsely; the reel/pending math reads
        // _armPinPos back).
        if (!target._armPinPos) target._armPinPos = new THREE.Vector3();
        if (target._armPinPos !== pos) target._armPinPos.copy(pos);
        target._armPinned = true;
        if (debrisField && typeof debrisField.pinCapturedDebris === 'function') {
            debrisField.pinCapturedDebris(target, target._armPinPos);
        }
    }

    /**
     * Resolve a completed reel. The catch adopts onto the CaptureNetSystem nose-collar berth (berth hold → securing mate →
     * ledger → transfer / collar digestion); with no capture system (headless) it falls back to the legacy instant
     * resolution. LASSO_STOWED / LASSO_CAPTURED / ARM_CAPTURED fire AT reel completion (the catch IS made now) so
     * onboarding beats (tease_lock / first_catch / second_catch) and the autopilot's lasso attitude-hold release advance
     * promptly. Scoring + salvage + removal happen later, exactly once, at the collar's CATCH_PROCESSED.
     * @private
     */
    _resolveCatch(debrisField, playerPos, playerVelDir) {
        const target = this.target;
        const cns = this._captureNetSystem;
        if (!cns) {
            this._completeCatch(debrisField);
            return;
        }

        // The catch is MADE at reel completion: fire the capture-UX beats now.
        eventBus.emit(Events.LASSO_STOWED, {
            debrisId: target ? target.id : null,
            podIndex: 0,
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

        // Hand pin ownership off the reel BEFORE _resetLasso clears it: the adoption (or pending wait) now owns the pin.
        this._reelPinTarget = null;

        // The completion step returns before the reel's final pin write, leaving the pin a hair short: snap it onto the
        // DELIVERY point (updateBerthHold pins the same point: no gap, no pop), through the same-frame pin (CaptureNet's berth
        // tick already ran this frame; see _pinFresh).
        if (target) {
            this._reelDeliveryWorld(target, playerPos, playerVelDir, _scratchMuzzle);
            this._pinFresh(debrisField, target, _scratchMuzzle);
        }

        this._beginWebFadeOut();   // crossfade into the adoption's berthed bag
        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_CATCH;
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_CATCH });

        if (target) this._adoptOrPend(target, playerPos, playerVelDir, debrisField);
    }

    /** Start the welded web's fade-out at reel completion (success paths only; misses retract instantly). The kit's live
     *  opacities seed it and the welded SHAPE is frozen (no drape writes during the fade): the fabric dissolves in place
     *  while the adoption's berthed bag takes over. */
    _beginWebFadeOut() {
        if (!this._netKit || !this._netGroup || !this._netGroup.visible) return;
        this._webFade = {
            t: LASSO_WEB_FADE_S,
            dur: LASSO_WEB_FADE_S,
            seed: NetMeshKit.captureOpacity(this._netKit),
        };
    }

    /** Adopt the catch onto the collar now or, when the single collar station is busy (a mated catch or an inbound mother
     *  net), hold it clear of the occupant and adopt the moment it frees. Cargo is never destroyed (continuity law 1): a
     *  busy collar pends, never drops. `debrisField` enables the same-frame pin. */
    _adoptOrPend(target, playerPos, playerVelDir, debrisField = null) {
        const cns = this._captureNetSystem;
        if (!cns.getDockedCatch() && !cns.hasMotherNetInFlight() && cns.adoptLassoCatch(target)) {
            return;
        }
        // Collar busy, or the adoption was refused (a context race): hold clear of the occupant and retry.
        this._pendingAdoption = { target, phase: 'wait', settleT: 0, fromPos: null, announced: false };
        this._pinPending(target, playerPos, playerVelDir, debrisField);
    }

    /** Tick a catch waiting for the collar: 'wait' holds it pinned clear of the occupant (recomputed each frame); once the
     *  station frees it 'settle's smoothly onto the collar seat (no teleport), then adopts. Runs every frame, regardless
     *  of lasso active state. */
    _updatePendingAdoption(dt, playerPos, playerVelDir, debrisField = null) {
        const p = this._pendingAdoption;
        if (!p) return;
        const target = p.target;
        const cns = this._captureNetSystem;

        // The piece died (Kessler / mission transition) or the system went away: release the pin and drop the wait. The field
        // owns a dead body.
        if (!target || target.alive === false || !cns) {
            this._clearPendingAdoption();
            return;
        }

        const busy = cns.getDockedCatch() || cns.hasMotherNetInFlight();
        if (p.phase === 'wait') {
            if (!p.announced) {
                p.announced = true;
                eventBus.emit(Events.COMMS_MESSAGE, {
                    text: 'Collar busy — holding the catch off the berth until it clears.',
                    source: 'SYSTEM', channel: 'CMD', priority: 'info',
                    _lassoFeedback: true,
                });
            }
            if (busy) {
                this._pinPending(target, playerPos, playerVelDir, debrisField);
            } else {
                p.phase = 'settle';
                p.settleT = 0;
                p.fromPos = target._armPinPos
                    ? target._armPinPos.clone()
                    : this._collarSeatWorld(target, playerPos, playerVelDir, new THREE.Vector3());
            }
            return;
        }

        // 'settle': ease onto the collar seat only while the station is free; if a mother catch re-takes the collar
        // mid-glide, abort back to 'wait'.
        const stillBusy = cns.getDockedCatch() || cns.hasMotherNetInFlight();
        if (stillBusy) {
            p.phase = 'wait';
            this._pinPending(target, playerPos, playerVelDir, debrisField);
            return;
        }
        p.settleT += dt;
        const f = Math.min(1, p.settleT / LASSO_ADOPT_SETTLE_S);
        const ease = smoothstep01(f);
        // The glide lands on the DELIVERY point, the exact pin adoptLassoCatch writes, so pend→adopt is snap-free.
        this._reelDeliveryWorld(target, playerPos, playerVelDir, _scratchMuzzle);
        if (!target._armPinPos) target._armPinPos = new THREE.Vector3();
        target._armPinPos.copy(p.fromPos).lerp(_scratchMuzzle, ease);
        target._motherParked = true;
        target._catchRenderMin = this._catchFloorFor(target, target._armPinPos, playerPos);
        // Same-frame pin (see _pinFresh): the glide must RENDER each eased step this frame.
        this._pinFresh(debrisField, target, target._armPinPos);
        if (f >= 1) {
            // Seat reached: adopt. If the collar was re-occupied since this frame's check (belt-and-braces), fall back to 'wait'.
            const adopted = cns.adoptLassoCatch(target);
            if (!adopted) {
                p.phase = 'wait';
                return;
            }
            this._pendingAdoption = null;
        }
    }

    /** Pin a waiting catch clear of the collar's occupant: the collar seat pushed fore along the berth axis by the
     *  occupant's fore extent (getCollarQueueDepthM), so it never overlaps a mated/inbound mother catch. Follows the
     *  reorienting ship. The read is corridor-held / extended-standoff honest (shared motherNetForeExtentM), so the hold
     *  clears a tandem body's TRUE far face. `debrisField` enables the same-frame pin. */
    _pinPending(target, playerPos, playerVelDir, debrisField = null) {
        const cns = this._captureNetSystem;
        this._collarSeatWorld(target, playerPos, playerVelDir, _scratchMuzzle);
        const depthM = cns ? cns.getCollarQueueDepthM() : 0;
        this._berthAxis(playerVelDir, _scratchFwd);
        if (!target._armPinPos) target._armPinPos = new THREE.Vector3();
        // The hold-off sits one BERTH_CLEARANCE_M (keep-clear spacing) past the occupant's far face; with the collar free it
        // is home itself.
        const holdOffM = depthM > 0 ? depthM + (Constants.CAPTURE_NET.BERTH_CLEARANCE_M ?? 1.0) : 0;
        target._armPinPos.copy(_scratchMuzzle).addScaledVector(_scratchFwd, holdOffM * M);
        target._motherParked = true;
        target._catchRenderMin = this._catchFloorFor(target, target._armPinPos, playerPos);
        // Same-frame pin (see _pinFresh).
        this._pinFresh(debrisField, target, target._armPinPos);
    }

    /** Release the pending wait (game reset / dead target / teardown): clears the pin flags it owned; idempotent. */
    _clearPendingAdoption() {
        const p = this._pendingAdoption;
        if (p && p.target) {
            p.target._armPinned = false;
            p.target._catchRenderMin = 0;
            p.target._motherParked = false;
        }
        this._pendingAdoption = null;
    }

    /** The lasso reel bills the mother's battery while it turns (owner 2026-10-12: "Reel on mother costs"): line tension
     *  (the lasso's own base + per-kg model) × line speed ÷ REEL_EFFICIENCY, floored at the mother reel's 15 W motor
     *  (TETHER_REEL_POWER), capped at HAUL_MOTOR_POWER. Line speed: the haul from the contact range over the REEL window
     *  (1 − 0.2 of the progress at LASSO_REEL_SPEED); the WRAP cinch bills the floor. Nothing on a held-world frame or
     *  with no battery wired. */
    _billReelMotor(dt) {
        const p = this._player;
        if (!(dt > 0) || !p || p._motorBillHeld === true) return;
        const rs = p._resourceSystem;
        if (!rs || typeof rs.billWatts !== 'function') return;
        const MD = Constants.MOTOR_DRAW_W || {};
        const WRAP_END = 0.2;
        let lineSpeed = 0;
        if (this._reelProgress > WRAP_END && this._reelStartOffset) {
            lineSpeed = (this._reelStartOffset.length() / M) * Constants.LASSO_REEL_SPEED / (1 - WRAP_END);
        }
        const mass = this.target ? (this.target.mass || 0) : 0;
        const tensionN = Constants.LASSO_TENSION_BASE_N + mass * Constants.LASSO_TENSION_PER_KG;
        const mechW = tensionN * lineSpeed / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.MOTHER_REEL_MIN ?? 15, mechW)), dt, 'lassoReel');
    }

    /** Reel physics (LASSO_REEL_PHYSICS, gated): mass-driven tension + a subtle centre-of-mass pull toward the catch +
     *  tangle/break risk. Called only when _reelPhysicsActive was latched at contact (flag ON, NOT Mission 1, capturedMass
     *  > LASSO_MAX_CAPTURE_MASS). Motion uses the fuel-free, self-damping _rcsVelocity channel (as the collision-dodge
     *  does), clamped by RCS_MAX_SPEED: never the fuel-charging applyCartesianImpulse. */
    _applyReelPhysics(dt, playerPos) {
        const capturedMass = this.target ? (this.target.mass || 0) : 0;

        // Mass-driven tension (mirrors CaptureNet.js)
        const tensionN = Constants.LASSO_TENSION_BASE_N + capturedMass * Constants.LASSO_TENSION_PER_KG;
        const strainFraction = capturedMass / Math.max(1, Constants.LASSO_NET_RATED_MASS_KG);
        eventBus.emit(Events.TETHER_TENSION, {
            tensionFraction: this._reelProgress, // keep progress for legacy HUD/audio
            tensionN,                            // real Newtons (Phase 3 HUD/tautness)
            strainFraction,                      // 0..1+ vs net rating
            armId: 'lasso',
        });

        // CoM pull: reeling a mass m pulls the ship toward the catch by m/m_ship. Nudge _rcsVelocity toward the
        // (player-relative) net package, scaled by mass ratio × reel rate, clamped by RCS_MAX_SPEED.
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
                // Angular coupling: a heavy OFF-AXIS catch also tugs the nose toward it while hauling (fed to the recoil attitude
                // springs, RCS-nulled); centreline catches: no tug.
                if (typeof this._player.applyReelTorque === 'function') {
                    this._player.applyReelTorque(toCatch, massRatio, dt);
                }
            }
        }

        // Tangle/break risk: sustained strain above NET_STRAIN_SAFE_FRACTION accumulates; past LASSO_NET_BREAK_TIME_S the
        // tether snaps, dropping the catch (no score, no removeDebris) with a miss-style cooldown.
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

    /** Snap the tether under over-strain: drop the catch cleanly (release the reel pin, NO removeDebris/score), then a
     *  miss-style cooldown. */
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

    /** Legacy instant catch (removeDebris + flat score): ONLY the headless/test fallback with no CaptureNetSystem wired
     *  (production's real path is the collar adoption in _resolveCatch). Kept so throw-only tests resolve a catch. */
    _completeCatch(debrisField) {
        const target = this.target;

        if (debrisField && target) {
            debrisField.removeDebris(target.id);
        }

        eventBus.emit(Events.LASSO_CAPTURED, {
            debrisId: target ? target.id : null,
            type: target ? target.type : 'unknown',
            mass: target ? (target.mass || 0) : 0,
        });

        // Also ARM_CAPTURED for catch juice (slo-mo, flash, sound). Owner 2026-09-07: "one catch, one confirmation": this and
        // the INTERACTION_CAPTURE below both feed HUD toasts tagged `confirm`; under the engaged toast policy both die, so a
        // lasso catch shows ONE surface (or none while engaged). The EVENTS stay: arm pane, audio, skills, scoring listen.
        eventBus.emit(Events.ARM_CAPTURED, {
            armId: 'lasso',
            debrisId: target ? target.id : null,
        });

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

        eventBus.emit(Events.COMMS_MESSAGE, {
            text: `Lasso catch! ${target ? target.type : 'debris'} secured.`,
            priority: 'info',
        });

        this._beginWebFadeOut();   // success path — same crossfade as the adoption route
        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_CATCH;
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_CATCH });
    }

    /** Gossamer silk trail: emit at the projectile, update drift + fade. */
    _updateGossamerTrail(dt, playerPos) {
        if (!this._trailPoints) return;

        const N = this._trailCount;
        const pos = this._trailPositions;
        const alphas = this._trailAlphas;
        const births = this._trailBirths;
        const drift = this._trailDrift;
        const now = this._time;
        const lifetime = this._trailLifetime;

        if (this.active && this.projectilePos && !this._reelingIn) {
            this._trailPoints.visible = true;
            // Emit ~60 particles/sec (1 per ~0.016s)
            this._trailEmitAccum += dt;
            const emitInterval = 0.016;
            while (this._trailEmitAccum >= emitInterval) {
                this._trailEmitAccum -= emitInterval;
                const i = this._trailHead;
                const i3 = i * 3;

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

        let anyAlive = false;
        for (let i = 0; i < N; i++) {
            if (births[i] <= 0) continue; // inactive slot
            const age = now - births[i];
            if (age > lifetime) {
                alphas[i] = 0;
                births[i] = 0;
                continue;
            }
            anyAlive = true;

            const t = age / lifetime;
            alphas[i] = 1.0 - t * t; // quadratic fade-out

            const i3 = i * 3;
            const curlPhase = age * 4.0 + i * 0.7; // unique per particle
            pos[i3]     += drift[i3]     * dt + Math.sin(curlPhase) * M * 0.02 * dt;
            pos[i3 + 1] += drift[i3 + 1] * dt + Math.cos(curlPhase * 1.3) * M * 0.02 * dt;
            pos[i3 + 2] += drift[i3 + 2] * dt + Math.sin(curlPhase * 0.7) * M * 0.02 * dt;
        }

        if (this._trailPoints.visible) {
            this._trailPoints.geometry.attributes.position.needsUpdate = true;
            this._trailPoints.geometry.attributes.alpha.needsUpdate = true;
        }

        if (!this.active && !anyAlive) {
            this._trailPoints.visible = false;
        }
    }

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

    _resetLasso() {
        // Release the reel-in pin so a cancelled-mid-reel piece resumes propagation. After a COMPLETED catch _resolveCatch
        // has already nulled _reelPinTarget (the adoption/pending record owns the pin), so this is a no-op; a headless
        // instant catch has already removed the debris.
        if (this._reelPinTarget) {
            this._reelPinTarget._armPinned = false;
            this._reelPinTarget._catchRenderMin = 0;
            this._reelPinTarget = null;
        }
        this.active = false;
        this.target = null;
        this._targetId = null;
        this._targetScenePos = null;
        this._targetIsLive = false;
        this._projOffset.set(0, 0, 0);
        this.projectilePos = null;
        this.projectileVel = null;
        this.flightTimer = 0;
        this._reelingIn = false;
        this._reelProgress = 0;
        this._netSpinAngle = 0;
        // Clear the reel-physics latch + strain accumulator for the next cast.
        this._reelPhysicsActive = false;
        this._strainTimer = 0;
        // Re-arm flight billow + engulf seat.
        this._billowPhase = 0;
        this._wrapSeatD0 = 0;

        if (this._netGroup && !this._webFade) this._netGroup.visible = false;
        // Restore the mouth to full radius so the next cast (or a flag toggle) starts clean. Deferred while a web fade is
        // live: the welded shape must dissolve in place; the fade's completion tick restores the geometry.
        if (Constants.FEATURE_FLAGS.LASSO_NET_KINEMATICS && !this._webFade) {
            this._applyNetMouthRadius(1.0);
        }
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

    /** Visual effects independent of lasso active state (muzzle/contact flash persist briefly after reset). */
    _updateVisualEffects(dt) {
        // Welded web fade-out over an adopted catch: shape frozen (no drape writes), opacity rides the captured seed. At
        // zero: hide, then restore the resting geometry the next cast expects (natural cone, open rim, scale 1: what
        // _resetLasso deferred).
        if (this._webFade) {
            this._webFade.t -= dt;
            const s = Math.max(0, this._webFade.t / this._webFade.dur);
            if (this._netKit) NetMeshKit.setOpacityScaled(this._netKit, this._webFade.seed, s);
            if (s <= 0) {
                this._webFade = null;
                if (this._netGroup) this._netGroup.visible = false;
                if (this._netKit) {
                    NetMeshKit.updateWebDrape(this._netKit, {});   // natural cone; opacity untouched (not driven)
                    NetMeshKit.setMouthFraction(this._netKit, 1.0);
                }
            }
        }

        if (this._muzzleFlashTimer > 0) {
            this._muzzleFlashTimer -= dt;
            const flashLife = Constants.LASSO_MUZZLE_FLASH_TIME || 0.2;
            this._muzzleFlash.material.opacity = Math.max(0, this._muzzleFlashTimer / flashLife)
                * (Constants.LASSO_MUZZLE_FLASH_OPACITY ?? 0.95);
            if (this._muzzleFlashTimer <= 0) {
                this._muzzleFlash.visible = false;
            }
        }

        if (this._contactFlashTimer > 0) {
            this._contactFlashTimer -= dt;
            this._contactFlash.material.opacity = Math.max(0, this._contactFlashTimer / 0.3) * 0.9;
            if (this._contactFlashTimer <= 0) {
                this._contactFlash.visible = false;
            }
        }

    }


    /** Seconds of cooldown remaining (0 = ready to fire) */
    get cooldownRemaining() {
        return Math.max(0, this.cooldown);
    }

    dispose() {
        // Unsubscribe from the eventBus so a disposed LassoSystem isn't kept alive.
        if (this._evtUnsubs) {
            this._evtUnsubs.forEach(u => { if (typeof u === 'function') u(); });
            this._evtUnsubs.length = 0;
        }
        if (this._netGroup) {
            if (this._webNear && this._nearSm && typeof this._nearSm.unregisterNearFieldRoot === 'function') {
                this._nearSm.unregisterNearFieldRoot(this._netGroup);   // never leave a dead root in the pass
                this._webNear = false;
            }
            if (this._netKit) NetMeshKit.dispose(this._netKit);
            this.scene.remove(this._netGroup);
        }
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
        if (this._trailPoints) {
            this.scene.remove(this._trailPoints);
            this._trailPoints.geometry.dispose();
            this._trailPoints.material.dispose();
        }
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
