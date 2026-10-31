/**
 * CameraSystem.js — multi-view camera. V toggles FLY (chase, default) ↔ LOOK AROUND (orbit); close inspection engages
 * automatically as a zoom sub-state of LOOK AROUND (Schmitt trigger on distance). Cockpit, target lock, arm pilot and
 * net cinematic are entered by their own bindings. Transitions lerp position and lookAt.
 * @module systems/CameraSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { persistenceManager } from './PersistenceManager.js';
import { CeremonyTimeScale } from './CeremonyTimeScale.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';
import { earthTurnTarget, earthTurnDirAt, EARTH_TURN_S, EARTH_TURN_MIN_GAP_U, earthFrameTurnS, earthFrameEase } from './EarthTurn.js';
import { testsRequestedHere } from '../ui/hud/TestsSwitch.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { degToRad, clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

/** @enum {string} Camera view modes */
export const CameraViews = {
  FIRST_PERSON: 'FIRST_PERSON',
  CHASE: 'CHASE',
  ORBIT: 'ORBIT',
  TARGET_LOCK: 'TARGET_LOCK',
  ARM_PILOT: 'ARM_PILOT',
  INSPECTION: 'INSPECTION',
  NET_CINEMATIC: 'NET_CINEMATIC',
};

/**
 * View cycle driven by the V key: FLY ↔ LOOK AROUND. Close inspection is not a stop: zooming in while in LOOK AROUND
 * auto-enters an inspection sub-state (Schmitt trigger on distance: narrow FOV, dynamic near plane, vignette, contextual
 * wireframe; a Tab-locked debris shows the debris wireframe, otherwise the mothership). The discrete INSPECTION view
 * and bare-I / toggleInspection() remain (enterInspection()); V from there wraps to FLY. FIRST_PERSON, ARM_PILOT and
 * NET_CINEMATIC stay outside the cycle.
 */
const VIEW_CYCLE = [
  CameraViews.CHASE,          // FLY (default)
  CameraViews.ORBIT,          // LOOK AROUND (zoom in here to inspect the mothership)
];

const VIEW_LABELS = {
  [CameraViews.FIRST_PERSON]: '🎯 COCKPIT',
  [CameraViews.CHASE]:        '🛰 FLY',
  [CameraViews.TARGET_LOCK]:  '🔒 TACTICAL',
  [CameraViews.ORBIT]:        '🔭 LOOK AROUND',
  [CameraViews.ARM_PILOT]:    '🤖 DAUGHTER PILOT',
  [CameraViews.INSPECTION]:   '🔍 INSPECTION',
  [CameraViews.NET_CINEMATIC]: '🎬 NET CINEMATIC',
};

// Zoom-ladder crossing choreography (docs/ladder/08-workbench.md §8: "one change at a time — the roll is its own
// phase"). In-module constants, not FloorContract numbers: the ride timing the core sees (rideMs / onDone) is
// untouched; these shape only what the camera does with the up-vector.

/**
 * UP-rides (ship→Earth, F3→F4): the source (ship-radial) up is HELD for the whole flight; the horizon then levels to
 * Earth-north in a separate post-ride phase of this length (cubic in-out). On-floor exactness resumes when it ends.
 */
export const LADDER_LEVEL_MS = 600;
/** Wall ms without a ladder update after which ladderDragNudge drops nudges (paused / hidden / blurred; ~15 frames at 60 fps). */
export const LADDER_NUDGE_STALE_MS = 250;

/**
 * Drag coast is PER SECOND: speed is rad/s and decays `damping ** (step * 60)`, so the `damping` constants (0.92) mean
 * "per 1/60 s" and a flick coasts the same distance at any frame rate.
 */
export const COAST_REF_FPS = 60;
/** Real-time step bounds for the coast: no divide by zero, a long hitch never flings the view. */
export const COAST_STEP_MIN_S = 1 / 240;
export const COAST_STEP_MAX_S = 0.1;
/** Rest snap: 1e-5 rad per frame at 60 fps = 6e-4 rad/s. */
export const COAST_REST_RAD_S = 1e-5 * COAST_REF_FPS;

/**
 * Real-clock gap in seconds between two wall readings (ms), at least COAST_STEP_MIN_S (no divide by zero).
 * First frame (prev null) = one 60 fps frame. Only the coast caps it at COAST_STEP_MAX_S (`_coastDrag`): a move
 * frame divides by the TRUE gap, so a slow frame (0.1-0.25 s) never sets a speed above the finger's.
 */
function coastStepS(prevMs, nowMs) {
  if (prevMs === null || prevMs === undefined || !Number.isFinite(prevMs) || !Number.isFinite(nowMs)) return 1 / COAST_REF_FPS;
  return Math.max(COAST_STEP_MIN_S, (nowMs - prevMs) / 1000);
}

/**
 * VIEW RETURN (DECISIONS §35 row 12; docs/ladder/00-spec.md §6: "the camera never moves on its own without a
 * player-initiated cause"; the drag is the cause): after the last view input the view glides back to the floor's default.
 *  - IDLE_S: the wait after the LAST view input (mouse or finger drag, held arrows, wheel or pinch zoom) once the drag's
 *    coast has stopped. Any view input restarts it. Real seconds, the same clock as the coast (a hitch counts at most
 *    COAST_STEP_MAX_S, so a pause or a hidden tab never ends the wait).
 *  - GLIDE_S: floors 1-3 (ship anchor): smoothstep along the great circle from the view to the chase direction
 *    (`_ladderChaseLocal`; over a pole of the floor, the same smoothstep over azimuth and polar angle instead, so the
 *    horizon never flips); the zoom distance does not change. Floor 4 (Earth anchor): CameraSystem only raises
 *    `ladderViewReturnDue()`; main.js's floor-4 block answers with the same framing turn the arrival uses
 *    (`ladderTurnEarthDir`). Floor 5 never moves.
 * No return while a drawer is open, a ride runs, or the catch focus or reel view holds the camera.
 */
export const LADDER_VIEW_RETURN = Object.freeze({ IDLE_S: 4.0, GLIDE_S: 2.0 });

/**
 * DOWN-rides (Earth→ship, F6→F5): the roll back to ship-up completes within this FRACTION of the ride (the cubic in-out
 * barely moves the dolly there), so the camera is fully ship-up before the dive dominates.
 */
export const LADDER_DOWN_ROLL_FRAC = 0.45;

/**
 * F3 look-at bias ease (08-workbench §2 "Motion": "240–300 ms for pane slides and subject reframes", one curve).
 * Deliberately the SAME number as RefitPane.PANE_SLIDE_MS (270) so subject and pane arrive together; VisualLaw has no
 * pane-timing entry (01-numbers "Workbench panes" is canonical until entries land per 08-workbench §9 — do not add one
 * here). Reduced motion snaps instead.
 */
export const LADDER_PANE_REFRAME_MS = 270;

/**
 * CATCH FOCUS (DECISIONS §25 item 2: "the reel-in must be seen"; owner 2026-10-16: "the reel-in phase is invisible").
 * Under the zoom ladder the camera holds 24.5 m (F2), so a 0.3 m catch is ~16 px while reeled in, handed to a radiator
 * tip and fed to the furnace. EVERY catch (owner 2026-10-18: "no camera doesn't seem to move in on the catch") brings
 * the ladder camera in to 6 m on the catch (reel), the middle of collar and tip (hand-off) and the tip (cook), then
 * back: mother net, daughter net (a far one is a CUT in and out), lasso (from LASSO_CONTACT, on to the collar), and a
 * collar catch keeps it until processed. F1-F3 (ship anchor) run it; F4-F5 (Earth anchor) refuse with a console line;
 * reduced motion CUTS in and out. Each start / refusal / cancel / end prints exactly one `[catch-focus]` line.
 * A SEPARATE camera-layer blend (anchor offset from the mother plus a distance pull) over the ladder's own state, which
 * it never writes: at blend 0 the camera is exactly where the ladder holds it. Firing the net is the player-initiated
 * cause (docs/ladder/00-spec.md §6); any camera input of his ends it. In-module numbers, not FloorContract numbers.
 */
export const CATCH_FOCUS = Object.freeze({
  DIST_U: 6e-5,        // 6 m: F2's floor (FloorContract), so no near-plane change
  TAU_S: 0.6,          // the anchor's time constant toward the focus point
  // the whole move in; slow enough that the camera does not swing round the ship and throw the piece off screen (DECISIONS §35)
  IN_S: 1.8,
  AIM_S: 1.0,          // ... of which the LOOK-AT point reaches the piece in this first part ("aim first, then move"): the piece stays on screen
  POS_DELAY_S: 0.4,    // ... and the camera position starts to move this long after the aim began, ending with the move
  TAKEOVER_MAX_U: 1e-3, // 100 m: a camera input takes the pose over for the ladder when it stands within this of the mother (F2's far end); farther, the old walk back
  // the time a HOP of the focus point (collar -> hand-off -> tip, a second catch, a newer reel) is eased out over
  // (critically damped, starts at rest); without it the camera turned in ONE frame
  LOOK_SMOOTH_S: 0.8,
  OUT_S: 1.0,          // ... and back out, after the catch is processed
  CANCEL_S: 0.3,       // ... and out after a player camera input: no cut, no walk back
  END_HOLD_S: 1.0,     // stay on the tip this long after CATCH_PROCESSED
  WAIT_S: 8.0,         // a lasso catch waiting for a busy collar to adopt it: let go after this (a mother catch AT the collar is COLLAR_MAX_S)
  COLLAR_MAX_S: 60,    // a catch sitting at the nose collar keeps the focus this long, then lets go
  TIP_MAX_S: 40,       // safety valve: never hold the cook longer than this
  HOP_CUT_U: 2e-4,     // 20 m: a hop of the focus point (a newer reel, a second catch) bigger than this is a CUT to the new point; smaller ones are eased out over LOOK_SMOOTH_S
  FAR_CUT_U: 5e-4,     // 50 m: a catch farther than this from the camera's anchor is a CUT in and out, not an ease over hundreds of metres
  DAUGHTER_HOLD_S: 1.5, // a daughter's reel: stay on her this long after she is latched at her strut
  REEL_OFF_DEG: 30,    // reel view: the camera sits this far round from the mother-daughter line so her tail glow and gas puffs are seen side-on
  // ... at max(this, REEL_SIDE_MULT x her catch's longest side, near plane + REEL_NEAR_CLEAR_M + the shot's reach)
  // (the F2/F3 near plane is 3 m: a 2.5 m distance would not draw her)
  REEL_MIN_DIST_M: 4,
  REEL_NEAR_CLEAR_M: 0.5, // ... the nearest point of her and her catch stays this far beyond the camera's near plane
  REEL_LAG_M: 1.0,     // ... and the ease's overshoot while she brakes (the lead term runs ahead of a slowing point: measured 0.6 m closer than the shot's distance)
  REEL_ARM_R_M: 0.5,   // ... counted as the daughter's own reach around her centre (body, antennas, tail glow)
  REEL_SIDE_MULT: 1.5,
  REEL_WIDEN_M: 10,    // in her last this-many metres to the strut tip the shot widens (REEL_WIDE_M) and looks between her and the tip
  REEL_WIDE_M: 7,      // ... to this distance at the latch
  DAUGHTER_MAX_S: 300, // safety valve for a daughter's long haul (4 m/s over a 500 m tether is ~125 s)
  ADOPT_GRACE_S: 0.5,  // a lasso reel that ended: wait this long for a net to adopt the catch before letting go
  LEAD_FILTER_S: 0.25, // smoothing of the focus point's velocity (the lead that cancels the ease's lag)
  // this many consecutive frames of "jumps" that all show the same measured velocity are motion, not hops: the
  // filtered velocity takes it (a view that starts while she is already at 30 m/s)
  VEL_ACCEPT_N: 3,
  VEL_AGREE: 0.3,      // ... "the same": successive measured velocities within this fraction of their length
  // a jump off the point's predicted path faster than this (20 m/s, scene units / s) is a hop between phases, not
  // motion (not absolute speed: a reeled daughter cruises at 60 m/s)
  LEAD_MAX_U_S: 2e-4,
});

/**
 * The catch focus is two moves with their own clocks over one progress `u` (0..1 of CATCH_FOCUS.IN_S): the LOOK-AT
 * point eases onto the piece first (`aim`), the camera POSITION follows a little later and ends with it (`pos`). Both
 * are smoothsteps. Pure: the tests call it with the same numbers the camera uses.
 * @param {number} u progress 0..1 (the camera's blend progress; it runs backwards on the way out)
 */
export function catchFocusWeights(u) {
  const t = clamp01(u) * CATCH_FOCUS.IN_S;
  const ss = (x) => { const c = clamp01(x); return smoothstep01(c); };
  return {
    aim: ss(t / CATCH_FOCUS.AIM_S),
    pos: ss((t - CATCH_FOCUS.POS_DELAY_S) / Math.max(1e-6, CATCH_FOCUS.IN_S - CATCH_FOCUS.POS_DELAY_S)),
  };
}

/**
 * How far the focus point jumped off its own predicted path this frame. A HOP of the point (collar -> middle of collar
 * and tip, a newer reel) is a jump the filtered velocity does not predict; a reeled daughter cruising at 60 m/s is fast
 * but on her path, so absolute speed cannot tell the two apart. Pure: the tests call it.
 * @param {THREE.Vector3} vel - the filtered velocity (scene units / s)
 * @param {THREE.Vector3} out - receives tgt - (rel + vel * dt)
 */
export function focusPointJump(tgt, rel, vel, dt, out) {
  out.copy(tgt).sub(rel).addScaledVector(vel, -dt);
  return out.length();
}

/**
 * How far from the shot's focus point the reel-view camera stands. Floors 2-3 keep the near plane at 3 m and the
 * close-up pass takes her within 10 m of the mother and never goes below the main near plane, so a shot that puts her
 * inside the near plane clips her: the NEAREST point of her and her catch must stay REEL_NEAR_CLEAR_M beyond it.
 * Pure: the tests call it.
 * @param {number} [p.sizeM] her catch's longest side, m (0 when empty-handed)
 * @param {number} [p.reachM] farthest of her and her catch (centres plus own extent) from the focus point, m
 * @param {number} [p.nearM] the camera's near plane on this floor, m
 */
export function reelViewDistM({ sizeM = 0, reachM = 0, nearM = 3 } = {}) {
  return Math.max(CATCH_FOCUS.REEL_MIN_DIST_M, CATCH_FOCUS.REEL_SIDE_MULT * sizeM, nearM + CATCH_FOCUS.REEL_NEAR_CLEAR_M + reachM);
}

/** The near plane (m) the floor contract gives floor `floor` (floors 1-3; others have no reel view). */
export function floorNearM(floor) {
  const row = FloorContract.FLOORS.find((r) => r.id === floor);
  return row && row.camera && row.camera.near != null ? row.camera.near / Constants.SCENE_UNITS_PER_METER : 3;
}

/** A ceremony kept only for its slow motion under the ladder ends by itself after this (real seconds). */
const QUIET_CEREMONY_MAX_S = 60;

/** Cubic in-out ease shared by the ride engine, the down-ride roll and the level phase. */
export function cubicInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraSystem {
  /**
   * @param {import('../scene/SceneManager.js').SceneManager} [sceneManager] - enrolls the fill/rim follow lights in
   *   the near-field depth pass so they light the ×S ship
   */
  constructor(camera, canvas, scene = null, sceneManager = null) {
    /** @type {THREE.PerspectiveCamera} */
    this.camera = camera;

    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /** @type {import('../scene/SceneManager.js').SceneManager|null}
     *  Drives the inspect background dim (NearFieldRenderPass vignette); null in headless tests. */
    this._sceneManager = sceneManager;

    // Camera fill light: a warm PointLight that follows the camera (cockpit-floodlight feel); only with a scene.
    /** @type {THREE.PointLight|null} */
    this._fillLight = null;
    /** @type {THREE.PointLight|null} Cool back/rim light on the far side of the ship. */
    this._rimLight = null;
    /** @type {THREE.PointLight|null} Dim blue albedo fill on the nadir (Earth-facing) side. */
    this._earthLight = null;
    if (scene) {
      // UNIT SCALE: 1 scene unit = 100 km, so camera-to-ship distance is tiny (a 15 m chase cam ≈ 0.00015). three.js
      // attenuation is `1 / max(pow(d, decay), 0.01)`: with decay=2, pow(0.00015, 2) is always below the 0.01 floor, so
      // inverse-square pins at its MAX (100×) and a nominal 0.35 fill became a ~35× flood (vs the sun's 2.0) that
      // flattened the ship. So decay=0 (physical falloff is meaningless at this scale) with a wide cutoff (0.01 units ≈
      // 1 km): constant base 1, window ≈1 across the gameplay zoom band, reaching only the near ship/debris, never the
      // Earth (~0.6 units away). Key (camera-side front fill) 2.4 so the camera-facing hull reads as lit metal; warm
      // colour 0xfff8ec matches the menu hero's key. Positioned off-axis per frame in update().
      this._fillLight = new THREE.PointLight(0xfff8ec, 2.4, 0.01, 0);
      this._fillLight.name = 'cameraFillLight';
      scene.add(this._fillLight);

      // RIM / BACK LIGHT: a cool light just beyond the ship (opposite the camera) catches the hull's silhouette edges and
      // separates them from the backdrop (the menu hero's MenuScene3D rim technique). Same unit-scale trick as the fill
      // (decay=0 + ~1 km cutoff). Positioned per frame in update() along the camera→ship axis.
      this._rimLight = new THREE.PointLight(0xbcd0ff, 2.0, 0.01, 0);
      this._rimLight.name = 'cameraRimLight';
      scene.add(this._rimLight);

      // EARTHSHINE FILL: a dim blue albedo glow (0.6 vs sun 2.0 / camera key 2.4) on the NADIR side, lifting the
      // Earth-facing side of the net's membrane/bag and hull that neither the sun nor the camera key reaches. Same
      // unit-scale trick. Positioned per frame in update() toward the planet.
      this._earthLight = new THREE.PointLight(0x9db8e8, 0.6, 0.01, 0);
      this._earthLight.name = 'earthshineFill';
      scene.add(this._earthLight);

      // Enroll the follow lights in the near-field depth pass. They are created AFTER main.js's
      // registerNearFieldRoot(player), so without this they never gain NEAR_FIELD_LAYER and the ship renders UNLIT in
      // the near sub-render. The pass also scales their `distance` cutoff into ×S space each near render. No-op
      // without a sceneManager (tests).
      if (sceneManager && typeof sceneManager.registerNearFieldLight === 'function') {
        sceneManager.registerNearFieldLight(this._fillLight);
        sceneManager.registerNearFieldLight(this._rimLight);
        sceneManager.registerNearFieldLight(this._earthLight);
      }
    }

    /** @private scene reference for fill-light cleanup */
    this._scene = scene;

    /** @type {string} Current view mode */
    this.currentView = CameraViews.CHASE;

    /** @type {string|null} Previous view (for transition) */
    this._previousView = null;

    /** @type {object|null} PlayerSatellite ref, injected via setPlayer(): backs the mother-pod net ceremony launcher
     *  (pod muzzle world position via getNetPodPositionInto). Optional: headless tests run without a player and the
     *  pod ceremony then no-ops. */
    this._player = null;

    /** @type {('mother'|'debris'|'daughter')|null} Focused subject while in INSPECTION */
    this._inspectSubject = null;

    /** The Tests switch (?tests=1 / ?sounds=1), read once here; tests may set it. */
    this.testsSwitch = testsRequestedHere();

    this._transitioning = false;
    this._transitionProgress = 0;
    this._transitionDuration = 0.5; // seconds
    // The ceremony exit over a sub-metre subject cuts in EXIT_CUT_SMALL_S instead of the default ease; this one-shot
    // override is restored to the default the frame any transition completes.
    this._transitionDurationDefault = this._transitionDuration;
    this._transitionStartOffset = new THREE.Vector3(); // Start offset from player for transition
    this._transitionStartLookDir = new THREE.Vector3(); // Start look DIRECTION for transition
    this._lastPlayerPos = new THREE.Vector3(); // Cached player pos for setView
    // The PREVIOUS frame's player pos: the epoch the camera's position was written in while an override drives it. Lets
    // an in-update exit rebase the (one-frame-old) camera pose into the current ship frame before setView captures its
    // transition start offset (one frame of apparent orbital travel is ~128 m at 60 fps).
    this._prevPlayerPos = new THREE.Vector3();
    this._prevPlayerPosInit = false;
    this._lastVelDir = new THREE.Vector3(0, 0, 1);

    this.chase = {
      offsetBehind: 0.00015,   // Distance behind player along velocity (~15m)
      offsetAbove: 0.00007,    // Distance above player along radial (~7m)
      lookAhead: 0.00002,      // Look-ahead past player (~2m, keeps spacecraft centered)
      smoothing: 3.0,          // Damping factor (higher = faster follow)
      targetLookBias: 0.25,    // fraction the look point eases toward
                               // a locked target (folded-in TACTICAL framing).
                               // 0 = off (pure chase); keep subtle.
    };

    this.firstPerson = {
      offsetForward: 0.000025, // Slightly in front of satellite center
      offsetUp: 0.000005,      // Slight upward offset
      headBobAmplitude: 0.0000005, // Subtle head-bob during thrust
      headBobFrequency: 8.0,
      headBobPhase: 0,
      freeLookYaw: 0,          // Mouse free-look yaw (right-click drag)
      freeLookPitch: 0,        // Mouse free-look pitch
      freeLookActive: false,
    };

    this.orbit = {
      theta: Math.PI,           // Azimuthal angle (start behind player — same direction as cockpit)
      phi: Math.PI / 4,        // Polar angle (radians)
      distance: 0.0003,        // Distance from player (~30m)
      minDistance: 0.00002,     // Minimum zoom (~2m); near-clip scales dynamically below the inspect threshold
      maxDistance: 0.01,        // Maximum zoom
      rotateSpeed: 0.005,      // Mouse rotation sensitivity
      zoomSpeed: 0.0001,       // Scroll zoom speed
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      damping: 0.92,           // Rotation momentum damping, per 1/60 s
      velocityTheta: 0,        // rad/s
      velocityPhi: 0,
      pendTheta: 0,            // turn (rad) of the moves since the last drawn frame
      pendPhi: 0,
      hasPend: false,
      lastWallMs: null,        // wall clock of the last orbit frame (coast step)

      // Zoom-driven inspection sub-state: while in OVERVIEW, zooming in past `inspectEnterDist` engages a mothership
      // inspection (narrow FOV, dynamic near-plane, vignette, hull/wireframe overlays); zooming out past the larger
      // `inspectExitDist` disengages it. The gap is a Schmitt trigger so the overlay/FOV don't flicker at the boundary.
      inspectEnterDist: 0.00012,  // ~12m — push in closer than this to inspect
      inspectExitDist: 0.00018,   // ~18m — pull back past this to leave inspect
      inspectActive: false,       // current sub-state (hysteresis output)
      inspectTaught: false,       // one-shot learning beat fired?
    };

    // `fov` here is the single source of truth for the inspection lens, shared by BOTH the discrete INSPECTION view
    // (enterInspection) and the OVERVIEW zoom-driven sub-state (_setInspectZoom reads this.inspection.fov), so the two
    // paths can't drift.
    this.inspection = {
      theta: Math.PI,
      phi: Math.PI / 4,
      distance: 0.0002,         // Start at ~20m
      minDistance: 0.00002,      // 2m minimum — see mechanical detail
      maxDistance: 0.0005,       // 50m maximum
      rotateSpeed: 0.005,
      zoomSpeed: 0.00003,       // Slower zoom for fine control
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      damping: 0.92,           // per 1/60 s
      velocityTheta: 0,        // rad/s
      velocityPhi: 0,
      pendTheta: 0,
      pendPhi: 0,
      hasPend: false,
      lastWallMs: null,
      fov: 35,                  // Narrow FOV like zoom lens
      savedFov: null,           // Stores previous FOV to restore on exit
    };

    this.armPilot = {
      arm: null,              // Reference to ArmUnit being piloted
      fovNarrow: Constants.CAMERA_FOV_ARM_PILOT,  // 40° narrow FOV for arm camera
      fovNormal: Constants.CAMERA_FOV,             // Stored normal FOV to restore (55° COMMAND base)
      offsetBehind: 0.00005,  // 5m behind arm center — enough to see arm + debris at standoff
      offsetAbove: 0.000016,  // 1.6m above arm
    };

    this.targetLock = {
      target: null,             // THREE.Vector3 or null
      offsetDistance: 0.0003,   // Camera offset from midpoint
      smoothing: 2.5,
      minCamDist: 0.0001,      // Min distance from player
    };

    this._currentTargetPos = new THREE.Vector3();  // Where camera should be
    this._currentTargetLook = new THREE.Vector3(); // Where camera should look
    this._thrustMagnitude = 0; // For head-bob
    // owner 2026-08-15: no chase-camera attitude kick on RCS taps (it read as an annoying jolt; the RCS plume + hiss confirm input).

    this._catchShakeTimer = 0;     // seconds remaining for shake effect
    this._catchShakeDuration = Constants.CATCH_SHAKE_DURATION || 0.3; // total shake duration
    this._catchShakeIntensity = Constants.CATCH_SHAKE_INTENSITY ?? 0.000003; // scene units (= 0.3 m)
    // The fallback must stay a MICRO-shake: the constant is in scene units (0.003 would be ±300 m of camera jitter).

    // Whale-tug amplitude scale: the NET_MOTHER_TUG handler stores ONLY this multiplier; the base intensity/duration
    // constants above stay immutable so a later consumer of _catchShakeTimer doesn't inherit the last tug's amplitude.
    this._catchShakeScale = 1.0;

    this._fovBreathOffset = 0;       // current FOV offset in degrees
    this._fovBreathTarget = 0;       // target FOV offset
    this._fovBreathTimer = 0;        // sustained thrust timer (seconds)
    this._baseFov = camera.fov;      // base FOV to offset from

    // OVERVIEW zoom-inspection FOV ease state (undefined = inactive sentinel).
    this._inspectZoomFovTarget = undefined; // target _baseFov while easing in/out
    this._inspectZoomSavedFov = undefined;  // _baseFov captured on engage, restored on exit
    this._thrustVisualDir = null;    // 'prograde' | 'retrograde' | 'lateral' | null
    this._thrustVisualMag = 0;       // current thrust magnitude for FOV

    // Menu→sim handoff intro: chase offset starts scaled at MENU_START (match-cut to the receding menu hero) and eases
    // straight back to 1.0 (normal formation); see startIntroZoom().
    this._introScale = 1.0;          // chase-offset multiplier (1.0 = normal)

    this._tmpVecA = new THREE.Vector3();
    this._tmpVecB = new THREE.Vector3();
    this._tmpVecC = new THREE.Vector3();
    this._tmpVecD = new THREE.Vector3();   // _computeTargetLock toTarget / ceremony up
    this._radialDir = new THREE.Vector3(); // per-frame radial-up

    // Cached LVLH basis for the current frame: written on the render path, read only by the pure
    // solveOrbitAnglesForDirection() (the ?shot=1 sky-pose hook). Dedicated vectors, NOT _tmpVecA/B/C: those are live
    // scratch in _computeOrbit and are reused elsewhere within the same frame.
    this._lvlhRadial = new THREE.Vector3();
    this._lvlhLateral = new THREE.Vector3();
    this._lvlhForward = new THREE.Vector3();

    this._launchCeremony = {
      active: false,
      phase: 0,       // 0=inactive, 1=PRE_LAUNCH, 2=LAUNCH, 3=COAST, 4=HANDOFF
      timer: 0,
      arm: null,
      savedFov: 0,    // Pre-ceremony _baseFov for ESC restore
      prevPos: new THREE.Vector3(),
      prevLook: new THREE.Vector3(),
    };

    // Ion start-up (DECISIONS §37 row 7): while a trip's four tail engines light, the camera eases to a view behind and
    // a little to the side of her tail, holds, and eases back. A BLEND over the normal driver (ladder, chase, orbit ...),
    // applied after it each frame: that driver keeps running, so handing back needs no saved pose. `t` 0..1 is how far
    // out the camera is; phase 'in' | 'hold' | 'out'. Any player camera input ends it at once.
    this._ion = { active: false, phase: 'in', t: 0, savedNear: 0, holdLeft: -1 };
    this._ionOff = new THREE.Vector3();
    this._ionTgt = new THREE.Vector3();
    this._ionDirN = new THREE.Vector3();
    this._ionDirC = new THREE.Vector3();
    this._ionLook = new THREE.Vector3();
    this._ionLookC = new THREE.Vector3();
    this._ionQ = new THREE.Quaternion();
    this._ionQ2 = new THREE.Quaternion();
    this._ionIdentityQ = new THREE.Quaternion();

    this._netCeremony = {
      active: false,
      beatIndex: 0,
      beatTimer: 0,
      beats: [],          // ordered beat definitions: [{ key, duration, fov }]
      armIndex: -1,
      podIndex: -1,
      arm: null,           // ArmUnit reference (the arm that fired the net)
      savedView: null,     // previous CameraView to restore
      savedFov: 0,         // pre-ceremony _baseFov
      isFirstEver: false,  // true if this is the first-ever net deploy
      success: null,       // null until NET_CEREMONY_COMPLETE event
      // Launcher abstraction (a mother-pod shot has armIndex=-1 and no arm): anchors every beat.
      //   daughter: getPos → arm.position,        getDebrisPos → arm.target._scenePosition
      //   mother:   getPos → pod muzzle (live),   getDebrisPos → net.targetDebris._scenePosition
      // Both allocation-free; null when no launcher could be resolved (the ceremony then refuses to start).
      _launcher: null,     // { getPos(out), getDebrisPos(out) } | null
      _net: null,          // the NetProjectile (either path)
      _reelBeatChained: false, // the REEL_IN beat chains at most once
      _quiet: false,           // started while the ladder owns the camera: slow motion only, no view
      // Persistent geometry (set once at ceremony start)
      _launchFwd: new THREE.Vector3(),     // launch direction (unit)
      _sideDir: new THREE.Vector3(),       // port-side (cross fwd × radialUp)
      _netDiameterScene: 0,                // D × M, scene units
      // Per-frame scratch vectors (ZERO allocation in hot path)
      _v3a: new THREE.Vector3(),  // result pos
      _v3b: new THREE.Vector3(),  // result look
      _v3c: new THREE.Vector3(),  // localUp / result up
      _v3d: new THREE.Vector3(),  // debrisPos
      _v3e: new THREE.Vector3(),  // general scratch
      _scratchNetPos: new THREE.Vector3(), // net scene position
      _scratchLauncherPos: new THREE.Vector3(), // launcher (arm/pod) scene position
    };

    // The SHORT lasso-catch cut (FEATURE_FLAGS.LASSO_CATCH_CUT): one continuous catch-framed shot from wrap contact
    // through the reel escort (hold [8,12] m off the catch, side/up off the reel line, look biased ≤ 4.5 m toward the
    // ship), released when the reel resolves (+ a settle breath) or at LASSO_CUT_MAX_S, always before the berth-secure
    // clock starts digestion. NOT the beat machinery: no beat list, no time-scale, no FOV moves.
    this._lassoCut = {
      active: false,
      t: 0,
      settleT: null,       // starts counting when the reel resolves
      debris: null,        // the wrapped piece (captured at LASSO_CONTACT)
      savedView: null,
      savedFov: 0,
      // Transient-entry retry: a subject-sanity refusal at LASSO_CONTACT (ghost `_scenePosition`, out-of-range read,
      // degenerate reel line) arms a per-frame retry while THIS reel is still live on THIS debris. Policy refusals
      // (flags, reduced motion, held keys, an owning ceremony) never retry: they are answers, not races.
      pendingDebris: null,
      _sideDir: new THREE.Vector3(),   // fixed at entry — stable framing
      _vCatch: new THREE.Vector3(),
      _vUp: new THREE.Vector3(),
      _vSide: new THREE.Vector3(),
      _vLook: new THREE.Vector3(),
      _vPos: new THREE.Vector3(),
    };
    /** @type {object|null} LassoSystem — wired by main.js (setLassoSystem). */
    this._lassoSystem = null;
    /** @type {(function(): boolean)|null} True while any player key is held: the cut never STARTS over active piloting
     *  (a held key produces no new keydown, so the any-input abort alone could not cover it). */
    this._lassoCutInputProbe = null;

    this._viewIndicator = null;
    this._viewIndicatorTimer = 0;
    /** @type {boolean} Keeps the indicator on screen (no fade) in non-default views; cleared on return to FLY. */
    this._viewIndicatorPersistent = false;
    this._createViewIndicator();

    // Sim mode: NO camera shake on capture (a real ADR catching sub-kg debris would feel nothing); arm/lasso captures
    // stay silent.
    // EXCEPTION: the WHALE tug. A 0.5–23 t catch yanking the Mother at line-taut is a real momentum event. Subscribed
    // for the mother path only (NET_MOTHER_TUG, once at CAPTURED with the imparted Δv): amplitude scaled by that Δv,
    // duration ≈ the spring window, skipped under prefers-reduced-motion.
    // Collect every eventBus subscription so dispose() can drain them: otherwise each CameraSystem ever constructed
    // stays subscribed to NET_CEREMONY_START for the process lifetime (a stale instance re-arms and pins
    // CeremonyTimeScale).
    this._unsubs = this._unsubs || [];
    this._unsubs.push(eventBus.on(Events.NET_MOTHER_TUG, (data) => {
      if (!data || data.podIndex < 0) return;              // mother pods only
      if (this._prefersReducedMotion()) return;            // accessibility gate
      const dv = data.dvMs || 0;
      if (dv <= 0) return;                                 // envelope-damped tug: no shake
      // Amplitude scales with the imparted Δv against the cap (0.5 m/s → full CATCH_SHAKE_INTENSITY); duration follows
      // the spring window. Store ONLY the scale: the base constants stay immutable.
      const cap = Constants.CAPTURE_NET?.NET_TUG_MAX_DV_MS ?? 0.5;
      this._catchShakeScale = Math.min(1, dv / Math.max(1e-9, cap));
      this._catchShakeDuration = data.windowS || Constants.CATCH_SHAKE_DURATION || 0.3;
      this._catchShakeTimer = this._catchShakeDuration;
    }));

    this._unsubs.push(eventBus.on(Events.THRUST_VISUAL, (data) => {
      this._thrustVisualMag = data.magnitude || 0;
      this._thrustVisualDir = data.direction || null;
    }));

    this._unsubs.push(eventBus.on(Events.LAUNCH_CEREMONY_START, ({ arm }) => {
      this.startLaunchCeremony(arm);
    }));

    // Net ceremony subscriptions (gated at handler entry)
    this._unsubs.push(eventBus.on(Events.NET_CEREMONY_START, (payload) => {
      this._onNetCeremonyStart(payload);
    }));
    this._unsubs.push(eventBus.on(Events.NET_BRAKE_FIRED, (payload) => {
      this._onNetBrakeFired(payload);
    }));
    this._unsubs.push(eventBus.on(Events.NET_CEREMONY_COMPLETE, (payload) => {
      this._onNetCeremonyComplete(payload);
    }));
    this._unsubs.push(eventBus.on(Events.NET_BERTHED, (payload) => {
      this._onNetBerthed(payload);
    }));

    // Lasso catch cut: contact enters (guarded in the handler); a mid-cut miss or tether snap is a truncation (the
    // catch is NOT made), so the letterbox must drop the same frame.
    this._unsubs.push(eventBus.on(Events.LASSO_CONTACT, () => {
      this._onLassoContact();
    }));
    this._unsubs.push(eventBus.on(Events.LASSO_MISSED, () => {
      if (this._lassoCut.active) this._exitLassoCut(false);
    }));
    this._unsubs.push(eventBus.on(Events.LASSO_SNAPPED, () => {
      if (this._lassoCut.active) this._exitLassoCut(false);
    }));

    // Guarantee CeremonyTimeScale is released when a net ceremony stops receiving update(); otherwise the net FSM keeps
    // reading a <1.0× scale and runs in slow motion indefinitely.
    //   • A hard game-state transition (mission end, back to menu) cannot carry a cinematic across it: abort any live
    //     ceremony (restores view/FOV and resets the scale).
    //   • The pause menu resumes the SAME ceremony: only release the scale this system owns; _updateNetCeremony
    //     re-asserts the active beat's scale on the next served frame (self-healing).
    this._unsubs.push(eventBus.on(Events.GAME_STATE_CHANGE, () => {
      if (this._netCeremony && this._netCeremony.active) this._abortNetCeremony();
      else CeremonyTimeScale.reset(this);
      // A hard state transition can't carry the lasso cut across it either.
      if (this._lassoCut && this._lassoCut.active) this._exitLassoCut(false);
      this._resetCatchFocus('game state change');
    }));
    this._unsubs.push(eventBus.on(Events.PAUSE_MENU, () => {
      CeremonyTimeScale.reset(this);
    }));
    // Ion start-up: BEGIN swings the camera out behind her tail; LIT (all four burn) starts its hold (CAM_HOLD_S) and
    // then the hand-back; END (the trip ended / was aborted) hands it back at once.
    this._unsubs.push(eventBus.on(Events.ION_STARTUP_BEGIN, () => this._beginIonStartup()));
    this._unsubs.push(eventBus.on(Events.ION_STARTUP_LIT, () => this._litIonStartup()));
    this._unsubs.push(eventBus.on(Events.ION_STARTUP_END, () => this._releaseIonStartup()));
    // ... and any player camera input ends the swing at once. With the ladder on, the wheel and the pinch never reach
    // handleWheelZoom (the WheelRouter feeds the ladder); the router emits this before it routes, so it is the one
    // signal every wheel / pinch gives. (A ladder ride - the rail, a floor change - ends it in ladderStartRide.)
    this._unsubs.push(eventBus.on(Events.CAMERA_ZOOM_INPUT, () => this._ionStartupInput('zoom input')));

    // ZOOM LADDER camera (ride engine, archive/ladder/06-core-api.md): a separate override slot (parallel to the
    // launch/net ceremonies) driven by LadderController. It dollies the camera along a direction from the floor's
    // anchor (ship/subject for F1–F3, Earth CENTRE for F4–F5 → Earth-fixed framing, which setView() offset lerps cannot
    // do) at the (floor, z01) distance, cubic-in-out for crossing rides. The direction is HEADING-RELATIVE on ship anchors
    // (see `local` below) and inertial on Earth anchors. Active only while the ladder is engaged
    // (Constants.LADDER.ENABLED + gameplay); untouched when the flag is off, so shipped views stay byte-identical.
    this._ladderUpdateSeq = 0;   // drawn-frame counter (ladderDragNudge coalescing)
    this._ladderUpdateWallMs = null;   // wall clock of the last ladder update (stale-nudge guard)
    this._wallNowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
    this._ladderCam = {
      active: false,
      anchor: 'ship',            // 'ship' | 'earth'
      dir: new THREE.Vector3(0, 0.35, 1).normalize(), // anchor→camera unit dir (WORLD; rebuilt from `local` on ship anchors)
      earthTurn: null,           // a running turn of `dir` on an Earth anchor { start, target, t } (ladderTurnEarthTo); null = none
      curDistU: 0.0004,          // eased current distance (scene units)
      targetDistU: 0.0004,       // free-scroll / settle target
      fov: Constants.CAMERA_FOV,
      riding: false,
      rideT: 0,
      rideDur: 0,
      rideFromDistU: 0,
      rideToDistU: 0,
      rideFromFov: 0,
      rideToFov: 0,
      rideAnchorFrom: 'ship',
      onDone: null,
      _tmp: new THREE.Vector3(),
      // Cross-anchor up-frame interpolation temps (F3↔F4; down-rides roll early in the ride, up-rides level AFTER it;
      // see _updateLadderCamera / _ladderSlerpUp).
      _upTo: new THREE.Vector3(),
      _upQuat: new THREE.Quaternion(),
      _upQuatE: new THREE.Quaternion(),
      // Drag-to-rotate: mouse drag rotates the dolly direction (the LOCAL orbital-frame pose on ship anchors, the
      // inertial world dir on Earth anchors) around the floor's up-frame with ORBIT's velocity+damping feel (constants
      // mirror this.orbit). Two gates: `enabled` is the MOUSE rule: floors 1-4 always (like the finger). Held arrows on floor 1
      // still turn the view only with a drawer open (arrows orbit the CAMERA, never the ship). `touchEnabled` is the TOUCH
      // rule: a finger turns the view on floors 1–4 with or without a drawer. The floor-5 chart stays locked for both;
      // closing the drawer on floor 2 forgets the dragged pose (setLadderPaneOpen). Every consumer is also gated on
      // lc.active, so mouse handling is byte-identical while the ladder is off.
      paneOpen: false,        // main.js feeds setLadderPaneOpen (the ONE pane edge)
      drag: {
        enabled: false,       // the MOUSE gate (_ladderDragEnabledFor)
        touchHeld: false,     // a finger is held on a view drag (TouchControls -> ladderSetTouchHeld): view input while down
        touchEnabled: false,  // the TOUCH gate (_ladderTouchDragEnabledFor): a finger turns the view on floors 1-4
        isDragging: false,
        lastMouseX: 0,
        lastMouseY: 0,
        velocityTheta: 0,     // rad/s
        velocityPhi: 0,
        pendTheta: 0,         // turn (rad) of the moves since the last drawn frame
        pendPhi: 0,
        hasPend: false,
        rotateSpeed: 0.005,   // mirrors this.orbit.rotateSpeed
        damping: 0.92,        // mirrors this.orbit.damping (per 1/60 s)
        nudgeSeq: -1,         // _ladderUpdateSeq of the last ladderDragNudge (touch coalescing)
      },
      _dragUp: new THREE.Vector3(),
      _dragRight: new THREE.Vector3(),
      // HULL CAM (floor 1): true while the engaged ladder floor is 1 and the inspect dim/overlay effects are applied
      // (_ladderApplyInspectFx).
      inspectFxActive: false,
      // On SHIP anchors the dolly offset lives in the ship's ORBITAL frame (docs/ladder/08-workbench.md §8, the "flying
      // backwards" fix): R = radial, T = velocity (Gram-Schmidt against R; identical for circular orbits), N = R × T, as
      // unit local coefficients `local = (r, t, n)`. The world `dir` is rebuilt from the LIVE frame every frame, as CHASE
      // does with velDir/radialDir, so the camera follows the heading instead of drifting behind → beside → ahead over
      // half an orbit. Earth anchors keep the inertial world `dir` (that makes Earth's spin visible on F4/F5).
      // Cross-anchor rides: ship→Earth freezes the current world dir (continuity, then inertial); Earth→ship slerps the
      // world dir from the frozen inertial start toward the ARRIVAL local pose (the player's per-floor drag memory, else
      // the canonical chase-behind pose), recomputed each frame from the live frame, on the ride's ease.
      local: new THREE.Vector3(0, 1, 0),   // (r, t, n): x along R, y along T, z along N
      localSeeded: false,                  // false ⇒ project the world dir on the next ship-anchored frame
      floor: null,                         // engaged frame's floor id (drag-memory key)
      dragMemory: {},                      // floor → Vector3 local pose last dragged there (per-floor framing memory)
      // The view returns to the floor's default after a pause (LADDER_VIEW_RETURN; _stepLadderViewReturn).
      viewReturn: {
        dirty: false,       // a view input moved the view since it was last at default: a return is owed
        moved: false,       // the drag block applied a turn this frame (set there, read and cleared by the step)
        t: 0,               // real seconds since the last input / hold (the wait clock)
        glide: null,        // while gliding: { t, arc, az0, daz, th0, dth } (pose = from + s(t) along the path)
        due: false,         // floor 4: the wait is over, main.js's answer is owed (ladderViewReturnDue)
        anchor: null,       // the anchor of the previous frame (a change of anchor type is not a view input)
        prevCur: null,      // last frame's lc.curDistU / lc.targetDistU: a change is a zoom input
        prevTarget: null,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        quatS: new THREE.Quaternion(),
        tmp: new THREE.Vector3(),
      },
      rideDirFrom: new THREE.Vector3(),    // Earth→ship ride: frozen inertial start dir
      rideDirSlerp: false,                 // true while a ride slerps `dir` toward the local arrival pose
      _R: new THREE.Vector3(1, 0, 0),
      _T: new THREE.Vector3(0, 0, 1),      // persists across frames: the degenerate-velocity fallback
      _N: new THREE.Vector3(0, -1, 0),
      _frameTmp: new THREE.Vector3(),
      _arrival: new THREE.Vector3(),
      _dirQuat: new THREE.Quaternion(),
      _dirQuatE: new THREE.Quaternion(),
      _localUp: new THREE.Vector3(1, 0, 0),   // the R axis in local coordinates (the ship floors' pole)
      _localRight: new THREE.Vector3(),
      // The roll is its own phase (see LADDER_LEVEL_MS / LADDER_DOWN_ROLL_FRAC). `_upStart` is the camera.up captured at
      // ride start: an UP-ride holds it for the whole flight, then levels it to Earth-north in the post-ride `leveling`
      // phase; a DOWN-ride rolls it to the live ship-radial during the first LADDER_DOWN_ROLL_FRAC of the ride.
      // `levelHoldFloor` is the up-ride's DEPARTURE floor, whose timeCap main.js keeps feeding the TimeAuthority until
      // the level phase completes (ladderWarpHoldFloor).
      _upStart: new THREE.Vector3(0, 1, 0),
      leveling: false,
      levelT: 0,
      rideFloorFrom: null,
      levelHoldFloor: null,
      // F3 look-at bias (08-workbench §2 / 01-numbers "F3 look-at bias"): while a workbench pane covers one edge of the
      // viewport the subject reframes toward the PANE-FREE centre. main.js feeds ONE signed CSS-px inset through
      // setLadderPaneInset (positive = pane on the LEFT edge, negative = RIGHT; both open → the caller nets them) from
      // the pane's onOpenChange edge (the same signal that feeds the calm cap). The per-frame TARGET is that inset only
      // while the engaged floor is 3, else 0 (a ride away, a disengage or a close all release it), eased over
      // LADDER_PANE_REFRAME_MS on the ride ease (reduced motion → snap). The bias is a pure YAW about the camera's own
      // up, applied AFTER the shipped lookAt (position, distance, up, dolly frame and ride engine untouched), sized so
      // the anchor projects to x_ndc = inset / viewport width: the centre of the uncovered strip.
      paneInsetPx: 0,       // the request (setLadderPaneInset) — 0 forever on a flag-off boot
      paneBiasPx: 0,        // the eased inset applied this frame
      paneBiasFrom: 0,
      paneBiasTo: 0,
      paneBiasT: 1,         // ease progress (1 = settled)
      // DECISIONS §15 (owner 2026-10-09: "the camera should follow the daughter"): on floors 2–3 a piloted daughter
      // becomes the ship anchor. The target is captured ONCE per frame at the top of _updateLadderCamera (the blend
      // clock); the anchor readers only read it. The blend is in OFFSETS from the live mother position, never between
      // frozen world points: the ship moves ~2.3 km per 300 ms.
      followArm: null,                    // the daughter the ship anchor rides with (null = the mother)
      followT: 1,                         // blend progress since the last target change (1 = settled)
      followFromOff: new THREE.Vector3(), // anchor − mother when the target last changed
      followLastOff: new THREE.Vector3(), // anchor − mother as resolved on the previous frame
    };

    this._catchFocus = {
      active: false,                      // from NET_CATCH_SUCCESS until the blend has eased back to 0
      engaging: true,                     // false once released / cancelled: the blend is only easing out
      phase: 'idle',                      // mother: 'reel' | 'wait' | 'handoff' | 'tip' | 'end'; daughter: 'haul' | 'held'; lasso: 'lasso' | 'adopt'
      kind: 'mother',                     // 'mother' | 'daughter' | 'lasso' (what caught it; a lasso catch becomes a collar catch once a net adopts it)
      cut: false,                         // reduced motion, or a catch farther than FAR_CUT_U: CUT in and out instead of easing
      snapPending: false,                 // a cut waiting for the first frame that knows the focus point
      armIndex: -1,                       // daughter: which one
      arm: null,                          // daughter: her ArmUnit (state HOLDING_CATCH ends the haul)
      totalS: 0,                          // real seconds since the focus began (the daughter's safety valve)
      collarS: 0,                         // real seconds a catch has sat at the nose collar (COLLAR_MAX_S)
      u: 0,                               // blend progress 0..1 (-> w, wa through catchFocusWeights)
      w: 0,                               // POSITION blend weight applied to the ladder camera this frame
      wa: 0,                              // LOOK-AT blend weight (leads w: aim first, then move)
      look: new THREE.Vector3(),          // the piece (or reel focus), relative to the mother (hops eased out, see `hop`): where the camera looks at wa = 1
      hop: new THREE.Vector3(),           // a hop of the focus point not yet eased out (scene units): the point everything chases is tgt + hop
      hopVel: new THREE.Vector3(),        // ... and its smooth-damp velocity
      lookV: new THREE.Vector3(),         // scratch: the look-at point in the world
      base: new THREE.Vector3(),          // the ladder's own anchor this frame (before the focus pulled it)
      camRel: new THREE.Vector3(),        // the camera relative to `base`, as drawn last frame (what a camera input takes over)
      camRelOk: false,                    // `camRel` is from a frame with the focus on
      takenOver: false,                   // a camera input took the pose over: the ladder owns the position, only the look-at fades out
      dist: CATCH_FOCUS.DIST_U,           // eased viewing distance of the end view (the reel view changes it)
      wantDist: CATCH_FOCUS.DIST_U,       // this frame's wanted distance (with his zoom, see `zoom`)
      baseDist: CATCH_FOCUS.DIST_U,       // daughter focus: this frame's wanted distance as the shot frames it, before his zoom
      innerDist: 0,                       // daughter focus: the nearest his zoom may bring the camera to her this frame (scene units; 0 = the daughter limit alone)
      zoom: 1,                            // daughter focus (owner 2026-10-27): his wheel / pinch zoom, a factor on the shot's distance; holds for the whole spell
      zoomed: false,                      // `zoom` is in force this frame (not 1)
      safeDist: 0,                        // the reel view's floor (scene units): the nearest point of her and her catch stays clear of the near plane
      reelView: false,                    // the focus rides with a daughter on her reel home
      reelSeen: false,                    // she has been on a reel home during this focus
      reelSeq: 0,                         // which reel (ArmUnit._rhReelSeq) the view follows
      spell: null,                        // wait view: the waiting spell this focus began on ({n, live}; null for every other focus)
      rate: 1 / CATCH_FOCUS.IN_S,         // |du/dt| in the current direction
      timer: 0,                           // real seconds in the current phase (wait / tip / end)
      net: null,                          // the mother NetProjectile that caught it
      debris: null,                       // the catch
      podIndex: -1,
      tipIndex: -1,                       // the radiator tip it goes to (-1 until known)
      off: new THREE.Vector3(),           // eased focus point − mother position (scene units)
      tgt: new THREE.Vector3(),           // this frame's focus point (world)
      tmp: new THREE.Vector3(),
      dir: new THREE.Vector3(),           // eased viewing direction out of the focus point (unit, world)
      dirSeeded: false,
      rel: new THREE.Vector3(),           // the focus point relative to the mother, last frame
      relSeeded: false,
      vel: new THREE.Vector3(),           // its velocity relative to the mother (filtered), scene units / s
      lastMeas: new THREE.Vector3(),      // last frame's measured velocity (while it counted as a jump)
      jumpRun: 0,                         // consecutive frames that counted as jumps with the same measured velocity
      aim: new THREE.Vector3(),
      q2a: new THREE.Vector3(),           // scratch for _catchFocusBlendDir
      q2b: new THREE.Vector3(),
      q2c: new THREE.Vector3(),
      azSide: 1,                          // which way round the blend turns when the two directions are opposite
      azKeepAim: { ang: 0, set: false, shrink: true },   // the aim's remaining turn of last frame (what is left after this frame's step)
      azKeep: { ang: 0, set: false },     // the drawn blend's turn of last frame (kept continuous; cleared while the focus weight is 0)
      v: new THREE.Vector3(),
    };
    this._takeoverDistU = null; // the distance a camera input took over from the focus, until the ladder controller has read it
    this._reelViewOff = null;   // {arm, seq}: the reel whose view he ended (or that was refused): not started again
    // Wait view (DECISIONS §46): the view goes to a daughter who waits in STATION_KEEP for N.
    this._waitSpells = new Map();   // ArmUnit -> {n, live}: a spell runs from her first STATION_KEEP until a state that is not part of the catch
    this._waitSpellSeq = 0;         // spells counted over all daughters (the oldest still waiting gets the view first)
    this._waitViewOff = new Map();  // ArmUnit -> spell number: the waiting spell whose view he ended (or that the mother's catch took): not started again in that spell
    this._unsubs.push(eventBus.on(Events.NET_CATCH_SUCCESS, (p) => this._onCatchFocusStart(p)));
    this._unsubs.push(eventBus.on(Events.NET_RELEASED, (p) => this._onCatchFocusLost(p, 'net released')));
    this._unsubs.push(eventBus.on(Events.NET_CATCH_MISS, (p) => this._onCatchFocusLost(p, 'net missed')));
    this._unsubs.push(eventBus.on(Events.CARGO_TRANSFER_START, (p) => {
      // to a daughter's rack: not a radiator-tip catch, nothing more to show from here
      if (p && p.to && p.to.kind !== 'tip') this._onCatchFocusLost(p, 'catch went to a rack');
    }));
    this._unsubs.push(eventBus.on(Events.CATCH_BREAKDOWN_START, (p) => this._onCatchFocusBreakdown(p)));
    this._unsubs.push(eventBus.on(Events.CATCH_PROCESSED, (p) => this._onCatchFocusProcessed(p)));
    // A lasso catch gets the focus from contact; a snapped or missed line lets it go
    this._unsubs.push(eventBus.on(Events.LASSO_CONTACT, (p) => this._onCatchFocusLassoStart(p)));
    this._unsubs.push(eventBus.on(Events.LASSO_SNAPPED, () => this._onCatchFocusLassoLost('lasso snapped')));
    this._unsubs.push(eventBus.on(Events.LASSO_MISSED, () => this._onCatchFocusLassoLost('lasso missed')));

    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
    this._boundWindowMouseUp = () => { this._ladderCam.drag.isDragging = false; };   // a release off the canvas ends the ladder drag
    this._boundContextMenu = (e) => {
      if (this.currentView === CameraViews.FIRST_PERSON ||
          this.currentView === CameraViews.ORBIT) {
        e.preventDefault();
      }
    };

    this._attachMouseListeners();
  }

  /** Toggle FLY ↔ LOOK AROUND (V key); from the discrete INSPECTION view V wraps to FLY. `lockedId` is unused. */
  cycleView(lockedId = null) {
    void lockedId; // retained for caller API stability (INSPECTION left the cycle)
    this._ionStartupInput('view key');   // the player's own camera input ends the ion start-up swing at once
    const cur = this.currentView;

    if (cur === CameraViews.INSPECTION) {
      this.exitInspection(CameraViews.CHASE);
      return;
    }

    const currentIdx = VIEW_CYCLE.indexOf(cur);
    const nextIdx = (currentIdx + 1) % VIEW_CYCLE.length;
    const next = VIEW_CYCLE[nextIdx];
    this.setView(next);
  }

  /** Set a camera view (a CameraViews value) with a smooth transition. */
  setView(view) {
    if (view === this.currentView && !this._transitioning) return;

    // Leaving OVERVIEW clears the zoom-driven inspection sub-state so its narrow FOV / near-plane / vignette / overlay
    // don't leak into the next view.
    if (this.currentView === CameraViews.ORBIT && view !== CameraViews.ORBIT) {
      this._clearInspectZoom();
    }

    // An external view switch during an active net ceremony aborts it cleanly (FOV/time-scale restored, FIRST_NET_DEPLOY
    // NOT written). NET_CINEMATIC entries from the ceremony itself are exempt.
    if (this._netCeremony.active && view !== CameraViews.NET_CINEMATIC) {
      this._abortNetCeremony();
    }
    // Same for the lasso cut: any external view intent wins instantly (the cut is garnish, never a wall).
    // _exitLassoCut clears `active` before its own setView, so this cannot recurse.
    if (this._lassoCut.active && view !== CameraViews.NET_CINEMATIC) {
      this._exitLassoCut(false);
    }

    this._previousView = this.currentView;
    this.currentView = view;

    this._transitioning = true;
    this._transitionProgress = 0;
    // Leaving orbit/inspection: use the canonical theta=π (behind + above) position to prevent a 90° roll from an
    // arbitrary orbit theta
    if ((this._previousView === CameraViews.ORBIT || this._previousView === CameraViews.INSPECTION) && this._lastVelDir) {
      const radialDir = this._lastPlayerPos.clone().normalize();
      const velDir = this._lastVelDir;
      const cfg = this._previousView === CameraViews.INSPECTION ? this.inspection : this.orbit;
      const d = cfg.distance;
      const cosPhi = Math.cos(cfg.phi);
      const sinPhi = Math.sin(cfg.phi);
      // offset = radialDir * d * cosPhi + (-velDir) * d * sinPhi
      const canonOffset = radialDir.clone().multiplyScalar(d * cosPhi)
        .sub(velDir.clone().multiplyScalar(d * sinPhi));
      this._transitionStartOffset.copy(canonOffset);
      this._transitionStartLookDir.copy(canonOffset).negate().normalize();
    } else {
      this._transitionStartOffset.copy(this.camera.position).sub(this._lastPlayerPos);
      this._transitionStartLookDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    }

    this.orbit.isDragging = false;
    this._dragStop(this.orbit);
    this.inspection.isDragging = false;
    this._dragStop(this.inspection);

    this.firstPerson.freeLookYaw = 0;
    this.firstPerson.freeLookPitch = 0;
    this.firstPerson.freeLookActive = false;

    // Show view indicator (skip for ARM_PILOT enter/exit — controls strip handles it)
    const isArmPilotTransition = view === CameraViews.ARM_PILOT || this._previousView === CameraViews.ARM_PILOT;
    if (!isArmPilotTransition) {
      this._showViewIndicator(view);
    } else {
      // ARM_PILOT uses its own controls strip: force-clear the indicator so a persistent badge (e.g. LOOK AROUND
      // "[V] to fly") doesn't linger through the piloting session.
      this._viewIndicatorPersistent = false;
      this._viewIndicatorTimer = 0;
      this._hideViewIndicator();
    }

    this._applyInspectDim(view === CameraViews.INSPECTION);

    eventBus.emit(Events.CAMERA_VIEW_CHANGE, { view, label: VIEW_LABELS[view] });
    // Route the view change through the notification zone (skip for ARM_PILOT enter/exit: its controls strip is the
    // indicator)
    if (!isArmPilotTransition) {
      eventBus.emit(Events.SHOW_NOTIFICATION, { text: VIEW_LABELS[view], kind: 'view' });
    }
    console.log(`[CameraSystem] View: ${VIEW_LABELS[view]}`);
  }

  getView() {
    return this.currentView;
  }

  getViewLabel() {
    return VIEW_LABELS[this.currentView] || 'UNKNOWN';
  }

  setLockTarget(targetPos) {
    this.targetLock.target = targetPos ? targetPos.clone() : null;
  }

  /** @param {number} magnitude - 0 to 1 (head-bob in first person) */
  setThrustMagnitude(magnitude) {
    this._thrustMagnitude = magnitude;
  }

  /**
   * Per-frame camera update.
   * @param {number} dt - seconds
   * @param {THREE.Vector3} playerPos - scene units
   * @param {{ x: number, y: number, z: number }} playerVel - km/s
   */
  update(dt, playerPos, playerVel, playerQuat) {
    if (!playerPos || !playerVel) return;

    this._lastVelDir.set(playerVel.x, playerVel.y, playerVel.z).normalize();
    const velDir = this._lastVelDir;
    const radialDir = this._radialDir.copy(playerPos).normalize();
    // Keep the one-frame-old epoch for the in-update exit rebase (see _exitLassoCut). Seeded to the live pos on the
    // first frame so a day-one exit can never rebase against the origin.
    if (this._prevPlayerPosInit) {
      this._prevPlayerPos.copy(this._lastPlayerPos);
    } else {
      this._prevPlayerPos.copy(playerPos);
      this._prevPlayerPosInit = true;
    }
    this._lastPlayerPos.copy(playerPos); // Cache for setView()

    // Lasso-cut transient-entry retry: a subject-sanity refusal at LASSO_CONTACT armed `pendingDebris`; re-attempt with
    // THIS frame's ship position (the contact-time attempt reads the cached one, one frame old relative to the freshly
    // pinned piece under long frames). The retry dies with the reel, with a retarget, or on any policy refusal.
    {
      const lc = this._lassoCut;
      if (lc && !lc.active && lc.pendingDebris) {
        const ls = this._lassoSystem;
        if (!(ls && ls.active && ls._reelingIn && ls.target === lc.pendingDebris)) {
          lc.pendingDebris = null;
        } else if (this._tryEnterLassoCut(playerPos) !== 'transient') {
          lc.pendingDebris = null;
        }
      }
    }

    // Cache the frame's LVLH basis for solveOrbitAnglesForDirection(). Done here, not in _computeOrbit, so the basis
    // exists before the first ORBIT frame and regardless of the active view; nothing reads it except the pure solver.
    // KEEP IN SYNC: the same lateral/forward derivation lives in _computeFirstPerson (×2), _computeOrbit and
    // _computeInspection; the solver assumes the cache matches the ORBIT view's basis bit-for-bit.
    this._lvlhRadial.copy(radialDir);
    this._lvlhLateral.crossVectors(velDir, radialDir).normalize();
    this._lvlhForward.crossVectors(radialDir, this._lvlhLateral).normalize();

    // Zoom Ladder override: highest-priority camera driver when engaged. Bypasses the normal view path; the follow-light
    // rig + shake below still run so the ship stays lit on the ladder.
    if (this._netCeremony.active && this._netCeremony._quiet) this._tickQuietNetCeremony(dt);
    if (this._ladderCam.active) {
      // A launch ceremony's camera never shows under the ladder, yet it would swallow every key until it ended. Stand
      // it down here, a frame after START, so every START listener (TeachingSystem's blocker) has already run and ABORT
      // clears them. Press her number to ride with her.
      if (this._launchCeremony.active) this.skipLaunchCeremony(false);
      this._updateLadderCamera(dt, playerPos, velDir, radialDir);
    } else if (this._launchCeremony.active) {
      const result = this._updateLaunchCeremony(dt, playerPos, velDir, radialDir, playerQuat);
      if (result) {
        this.camera.position.copy(result.pos);
        // Use the daughter's radial-up when the camera is near her (phases 2-3): the mother's radialDir diverges as the
        // tether extends (same fix as ARM_PILOT).
        const c = this._launchCeremony;
        const ceremonyUp = (c.phase >= 2 && c.arm?.position)
          ? this._tmpVecD.copy(c.arm.position).normalize()
          : radialDir;
        this.camera.up.copy(ceremonyUp);
        this.camera.lookAt(result.look);
      }
    } else if (this._netCeremony.active) {
      const ncResult = this._updateNetCeremony(dt, playerPos, velDir, radialDir, playerQuat);
      if (ncResult) {
        this.camera.position.copy(ncResult.pos);
        this.camera.up.copy(ncResult.up);
        this.camera.lookAt(ncResult.look);
      }
    } else {
      // Lasso catch cut: same override slot, own tiny driver. When it returns null the cut EXITED this very tick
      // (fence / max valve / settle / dropped subject): fall through to the normal view path below so THIS frame still
      // gets a camera write (skipping it would hold a one-frame-old pose that reads as a km-scale walkabout under long
      // frames).
      let lcResult = null;
      if (this._lassoCut.active) {
        lcResult = this._updateLassoCut(dt, playerPos);
        if (lcResult) {
          this.camera.position.copy(lcResult.pos);
          this.camera.up.copy(lcResult.up);
          this.camera.lookAt(lcResult.look);
        }
      }
      if (!lcResult) {
    let targetPos;
    let targetLook;

    let targetUp;  // optional explicit up vector from per-view compute (overrides default)
    switch (this.currentView) {
      case CameraViews.FIRST_PERSON:
        ({ pos: targetPos, look: targetLook } = this._computeFirstPerson(dt, playerPos, velDir, radialDir, playerQuat));
        break;

      case CameraViews.CHASE:
        ({ pos: targetPos, look: targetLook } = this._computeChase(dt, playerPos, velDir, radialDir, true));
        break;

      case CameraViews.ORBIT:
        ({ pos: targetPos, look: targetLook } = this._computeOrbit(dt, playerPos, velDir, radialDir));
        break;

      case CameraViews.TARGET_LOCK:
        // TARGET_LOCK is no longer reachable (dropped from VIEW_CYCLE; nothing else calls setView(TARGET_LOCK), see
        // GameFlowManager's "no auto-switch" note); its side-on framing is folded into CHASE via targetLookBias. Kept
        // intact (this case, _computeTargetLock, VIEW_INFO_LEVELS.TARGET_LOCK, the GameFlowManager revert) so it can be
        // re-enabled by re-adding it to VIEW_CYCLE.
        ({ pos: targetPos, look: targetLook } = this._computeTargetLock(dt, playerPos, velDir, radialDir));
        break;

      case CameraViews.ARM_PILOT:
        // SK branch returns an explicit up vector (daughter-local) so the horizon stays stable as the daughter orbits
        // debris.
        ({ pos: targetPos, look: targetLook, up: targetUp } = this._computeArmPilot(dt, playerPos, velDir, radialDir));
        break;

      case CameraViews.INSPECTION:
        ({ pos: targetPos, look: targetLook } = this._computeInspection(dt, playerPos, velDir, radialDir));
        break;
    }

    if (this._transitioning) {
      this._transitionProgress += dt / this._transitionDuration;

      if (this._transitionProgress >= 1.0) {
        this._transitioning = false;
        this._transitionProgress = 1.0;
        // any one-shot exit-cut override expires with the transition it shortened: later view changes ease at the default
        this._transitionDuration = this._transitionDurationDefault;
        if (this._fovTransitionStart !== undefined && this._fovTransitionEnd !== undefined) {
          this._baseFov = this._fovTransitionEnd;
          this.camera.fov = this._fovTransitionEnd;
          this.camera.updateProjectionMatrix();
          this._fovTransitionStart = undefined;
          this._fovTransitionEnd = undefined;
        }
      }

      const t = this._transitionProgress;
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      if (this._fovTransitionStart !== undefined && this._fovTransitionEnd !== undefined) {
        const lerpedFov = lerp(this._fovTransitionStart, this._fovTransitionEnd, ease);
        this._baseFov = lerpedFov;
        this.camera.fov = lerpedFov;
        this.camera.updateProjectionMatrix();
      }

      // Lerp OFFSET from player (not absolute position) to track orbiting player
      const targetOffset = targetPos.clone().sub(playerPos);
      const currentOffset = this._tmpVecA.lerpVectors(this._transitionStartOffset, targetOffset, ease);
      this.camera.position.copy(playerPos).add(currentOffset);

      // Interpolate look DIRECTION (nlerp), which avoids the scale mismatch of lerping absolute positions
      const targetLookDir = targetLook.clone().sub(targetPos).normalize();
      const lerpedDir = this._tmpVecB.lerpVectors(this._transitionStartLookDir, targetLookDir, ease);
      if (lerpedDir.lengthSq() < 0.0001) lerpedDir.copy(targetLookDir); // fallback
      lerpedDir.normalize();
      const currentLook = this.camera.position.clone().add(lerpedDir.multiplyScalar(0.001));

      // Always use radialDir as up — maintains roll-free constraint throughout
      this.camera.up.copy(radialDir);
      this.camera.lookAt(currentLook);
    } else {
      // Direct position copy, no lerp smoothing: at orbital velocity (~128 m/frame) any position lerp makes the camera
      // fall behind the player and lose tracking.
      this.camera.position.copy(targetPos);
      // ARM_PILOT: prefer the explicit up from _computeArmPilot (SK branch: daughter-local +Y, so the horizon stays
      // stable as she orbits debris; Earth-radial wobbles at φ-poles); else her Earth-radial up (the mother's radial
      // diverges as the tether extends).
      if (this.currentView === CameraViews.ARM_PILOT && this.armPilot.arm?.position) {
        if (targetUp && targetUp.lengthSq() > 1e-12) {
          this.camera.up.copy(targetUp);
        } else {
          this.camera.up.copy(this.armPilot.arm.position).normalize();
        }
      } else {
        this.camera.up.copy(radialDir);
      }
      this.camera.lookAt(targetLook);
    }
      } // end !lcResult
    } // end ceremony else

    // Ion start-up: blend the frame's pose toward the view behind her tail (no-op unless a trip's engines are lighting)
    if (this._ion.active) this._applyIonStartup(dt, playerPos, playerQuat, radialDir);

    if (this._catchShakeTimer > 0) {
      this._catchShakeTimer -= dt;
      const intensity = this._catchShakeIntensity * this._catchShakeScale
        * (this._catchShakeTimer / this._catchShakeDuration);
      this.camera.position.x += (Math.random() - 0.5) * 2 * intensity;
      this.camera.position.y += (Math.random() - 0.5) * 2 * intensity;
      this.camera.position.z += (Math.random() - 0.5) * 2 * intensity;
      // One-shot scale: restore to neutral when the shake ends so a future armer starts from the base amplitude.
      if (this._catchShakeTimer <= 0) this._catchShakeScale = 1.0;
    }

    // View indicator timer (skipped while persistent: non-default views keep the badge on screen).
    if (!this._viewIndicatorPersistent && this._viewIndicatorTimer > 0) {
      this._viewIndicatorTimer -= dt;
      if (this._viewIndicatorTimer <= 0) {
        this._hideViewIndicator();
      }
    }

    // Zoom-inspection FOV ease (OVERVIEW sub-state). The view-transition FOV lerp only runs when _fovTransitionEnd is set
    // (armPilot / ceremony / discrete-inspection paths), so this independent ease drives _baseFov toward the inspect
    // target (narrow) or back to the saved base, including across an OVERVIEW→COMMAND view change. Yields to the
    // transition lerp if one is configured, to avoid double-driving FOV.
    if (this._inspectZoomFovTarget !== undefined && this._fovTransitionEnd === undefined) {
      const easeRate = 5.0; // ~200ms to 63%
      this._baseFov += (this._inspectZoomFovTarget - this._baseFov) * Math.min(1, easeRate * dt);
      if (Math.abs(this._baseFov - this._inspectZoomFovTarget) < 0.05) {
        this._baseFov = this._inspectZoomFovTarget;
        this._inspectZoomFovTarget = undefined; // settled — release control
      }
      this.camera.fov = this._baseFov + this._fovBreathOffset;
      this.camera.updateProjectionMatrix();
    }

    // FOV breathe during sustained thrust (I-War heritage); skipped during ARM_PILOT (own narrow FOV)
    if (this.currentView !== CameraViews.ARM_PILOT && !this._launchCeremony.active && !this._netCeremony.active && !this._ladderCam.active) {
      const thrustMag = this._thrustVisualMag;
      if (thrustMag > 0.05) {
        this._fovBreathTimer = Math.min(this._fovBreathTimer + dt, 1.0);
        const sustainFrac = Math.max(0, (this._fovBreathTimer - 0.5) / 0.5);
        // Prograde: narrow FOV (tunnel-vision acceleration), Retrograde: widen FOV (braking)
        const maxOffset = 2.5 * thrustMag * sustainFrac;
        if (this._thrustVisualDir === 'prograde') {
          this._fovBreathTarget = -maxOffset;  // narrow — acceleration tunnel-vision
        } else if (this._thrustVisualDir === 'retrograde') {
          this._fovBreathTarget = maxOffset;   // widen — braking expansion
        } else {
          this._fovBreathTarget = 0;
        }
      } else {
        this._fovBreathTimer = Math.max(0, this._fovBreathTimer - dt * 2);
        this._fovBreathTarget = 0;
      }
      const easeRate = 4.0; // ~250ms to 63% of target
      this._fovBreathOffset += (this._fovBreathTarget - this._fovBreathOffset) * Math.min(1, easeRate * dt);
      if (Math.abs(this._fovBreathOffset) > 0.01) {
        this.camera.fov = this._baseFov + this._fovBreathOffset;
        this.camera.updateProjectionMatrix();
      } else if (Math.abs(this.camera.fov - this._baseFov) > 0.01 && this._fovBreathTarget === 0) {
        this.camera.fov = this._baseFov;
        this.camera.updateProjectionMatrix();
      }
      this._thrustVisualMag = 0;
      this._thrustVisualDir = null;
    }

    // Menu→sim intro offset decay: ease straight back to normal formation (no hold). Bidirectional: startIntroZoom()
    // may set _introScale ABOVE 1.0 (start wide, zoom in) or BELOW 1.0 (start close, pull back: the measured match-cut,
    // since the menu hero fills the frame at the handoff). The ease begins the moment it moves _introScale off 1.0.
    if (Math.abs(this._introScale - 1.0) > 0.001) {
      const easeRate = Constants.EARTH.INTRO_EASE_RATE;
      this._introScale += (1.0 - this._introScale) * Math.min(1, easeRate * dt);
      if (Math.abs(this._introScale - 1.0) < 0.001) this._introScale = 1.0;
    }

    // Sync the ship light rig each frame. The lights are distance-limited (see ctor) so they only illuminate the near
    // ship/debris, never the Earth.
    if (this._fillLight) {
      // OFF-AXIS KEY: a fill AT the camera is a flat, frontal "flash-photo" light. Offset it in CAMERA SPACE (up and
      // right) by a fraction of the camera→ship distance, so the offset scales with zoom and the hull gets form shadows.
      // Basis from the camera QUATERNION (set synchronously by lookAt() above; matrixWorld is only recomputed lazily at
      // render, so it would be stale).
      this._tmpVecB.set(1, 0, 0).applyQuaternion(this.camera.quaternion); // right
      this._tmpVecC.set(0, 1, 0).applyQuaternion(this.camera.quaternion); // up
      let d = 0.0004;                         // ~40 m default (no ship pos yet)
      if (playerPos) {
        d = this._tmpVecA.subVectors(playerPos, this.camera.position).length();
      }
      // Clamp the offset lever so the offset light stays inside the ~1 km cutoff even in wide (ORBIT/INSPECTION)
      // views: the added lever is sqrt(0.4² + 0.3²)=0.5·d, so cap d·0.5 at ~half the cutoff (0.004).
      const lever = Math.min(d, 0.008);
      this._fillLight.position.copy(this.camera.position)
        .addScaledVector(this._tmpVecC, 0.4 * lever)   // lift up
        .addScaledVector(this._tmpVecB, 0.3 * lever);  // push right
    }
    if (this._rimLight && playerPos) {
      // Back/rim: just beyond the ship along the camera→ship axis, lighting the far edges and peeling the silhouette
      // off the black background.
      const back = this._tmpVecA.subVectors(playerPos, this.camera.position);
      if (back.lengthSq() > 1e-12) {
        back.setLength(0.0003);   // ~30 m past the ship
        this._rimLight.position.copy(playerPos).add(back);
      } else {
        this._rimLight.position.copy(playerPos);
      }
    }
    if (this._earthLight && playerPos) {
      // Earthshine: planet centre is the scene origin, so the nadir direction at the ship is −playerPos/|playerPos|.
      // Sit ~40 m planetward of the hull, inside the ~1 km cutoff.
      const r = playerPos.length();
      if (r > 1e-9) {
        this._tmpVecA.copy(playerPos).multiplyScalar(-1 / r);
        this._earthLight.position.copy(playerPos).addScaledVector(this._tmpVecA, 0.0004);
      } else {
        this._earthLight.position.copy(playerPos);
      }
    }
  }

  /** True while the ion start-up view is out (swinging out, holding, or coming back). */
  isIonStartupActive() { return this._ion.active; }

  /** The ion start-up view's state: `{ active, phase: 'in'|'hold'|'out', t: 0..1 (how far out), holdLeft: s of hold left after LIT, -1 before it }`. */
  ionStartupState() { return { active: this._ion.active, phase: this._ion.phase, t: this._ion.t, holdLeft: this._ion.holdLeft }; }

  /** @private BEGIN: take the view, unless another camera driver owns the frame (a ceremony or a lasso cut). */
  _beginIonStartup() {
    const io = this._ion;
    if (io.active) return;
    if (this._launchCeremony.active || this._netCeremony.active || this._lassoCut.active) return;
    io.active = true;
    io.phase = 'in';
    io.t = 0;
    io.holdLeft = -1;
    io.savedNear = this.camera.near;
  }

  /** @private LIT (all four burn): the close view stays CAM_HOLD_S more, then eases back (the hold runs from the moment it has arrived). */
  _litIonStartup() {
    const io = this._ion;
    if (io.active && io.phase !== 'out' && io.holdLeft < 0) io.holdLeft = Constants.ION_STARTUP.CAM_HOLD_S;
  }

  /** @private END: begin the ease back to the player's view at once (from wherever the swing out had got to). */
  _releaseIonStartup() {
    const io = this._ion;
    if (io.active && io.phase !== 'out') io.phase = 'out';
  }

  /** @private Player camera input: the view is the player's again, at once. */
  _ionStartupInput(cause) {
    if (this._ion.active) this._endIonStartup(cause);
  }

  /** @private End the ion start-up view now: the normal driver's pose stands (it ran underneath), the near plane comes back. */
  _endIonStartup(_cause) {
    const io = this._ion;
    if (!io.active) return;
    io.active = false;
    io.t = 0;
    io.phase = 'in';
    io.holdLeft = -1;
    if (io.savedNear > 0 && this.camera.near !== io.savedNear) {
      this.camera.near = io.savedNear;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * @private Blend this frame's pose (the normal driver's, already on the camera) toward the view behind and to the side of her tail:
   * the offset from her swings round (slerp) and its length changes geometrically (so a dive from a far map floor reads even, not a
   * late rush), the look point slides from where the normal view looked to a point aft on her axis (the four boxes and their plumes),
   * and `up` goes to the radial. At 0 it is the normal pose, at 1 the tail view.
   */
  _applyIonStartup(dt, playerPos, playerQuat, radialDir) {
    const io = this._ion;
    const I = Constants.ION_STARTUP;
    if (io.phase === 'in') {
      io.t += dt / I.CAM_IN_S;
      if (io.t >= 1) { io.t = 1; io.phase = 'hold'; }
    } else if (io.phase === 'hold') {
      if (io.holdLeft >= 0) {                     // lit: the hold after LIT runs down, then the hand-back
        io.holdLeft -= dt;
        if (io.holdLeft <= 0) { io.holdLeft = 0; io.phase = 'out'; }
      }
    } else if (io.phase === 'out') {
      io.t -= dt / I.CAM_OUT_S;
      if (io.t <= 0) { this._endIonStartup('done'); return; }
    }
    if (!playerQuat) return;
    const w = smoothstep01(io.t);
    if (!(w > 1e-4)) return;
    const cam = this.camera;
    const M = Constants.SCENE_UNITS_PER_METER;

    // the normal view's offset from her, and the tail view's (her own frame: +Z nose, +X side, +Y up)
    const off = this._ionOff.copy(cam.position).sub(playerPos);
    const dN = off.length();
    const tgt = this._ionTgt.set(I.CAM_SIDE_M * M, I.CAM_UP_M * M, -I.CAM_AFT_M * M).applyQuaternion(playerQuat);
    const dC = tgt.length();
    const dirC = this._ionDirC.copy(tgt).multiplyScalar(1 / dC);
    const dirN = dN > 1e-12 ? this._ionDirN.copy(off).multiplyScalar(1 / dN) : this._ionDirN.copy(dirC);

    // where the normal view looks, held at her distance along its own forward
    const fwd = this._ionLook.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const natLook = fwd.multiplyScalar(dN > 1e-12 ? dN : dC).add(cam.position);
    // the tail view looks at a point on her axis aft of her centre
    const lookC = this._ionLookC.set(0, 0, -I.CAM_LOOK_AFT_M * M).applyQuaternion(playerQuat).add(playerPos);

    // position: the offset's direction swings (slerp via the rotation between), its length is geometric
    this._ionQ.setFromUnitVectors(dirN, dirC);
    this._ionQ2.copy(this._ionIdentityQ).slerp(this._ionQ, w);
    dirN.applyQuaternion(this._ionQ2);
    const dist = dN > 1e-12 ? Math.exp((1 - w) * Math.log(dN) + w * Math.log(dC)) : dC;
    cam.position.copy(playerPos).addScaledVector(dirN, dist);

    natLook.lerp(lookC, w);
    cam.up.lerp(radialDir, w).normalize();
    cam.lookAt(natLook);

    // the near plane must clear her hull at this distance (the ladder's floors keep it at metres)
    const nearWant = Math.min(io.savedNear > 0 ? io.savedNear : Infinity, Math.max(dist * 0.02, 0.000001));
    if (Math.abs(cam.near - nearWant) > nearWant * 0.1) {
      cam.near = nearWant;
      cam.updateProjectionMatrix();
    }
  }

  _computeFirstPerson(dt, playerPos, velDir, radialDir, playerQuat) {
    // Camera mounted at front of satellite, looking along velocity
    const pos = playerPos.clone()
      .addScaledVector(velDir, this.firstPerson.offsetForward)
      .addScaledVector(radialDir, this.firstPerson.offsetUp);

    if (this._thrustMagnitude > 0.01) {
      this.firstPerson.headBobPhase += dt * this.firstPerson.headBobFrequency;
      const bobX = Math.sin(this.firstPerson.headBobPhase) * this.firstPerson.headBobAmplitude * this._thrustMagnitude;
      const bobY = Math.cos(this.firstPerson.headBobPhase * 0.7) * this.firstPerson.headBobAmplitude * 0.5 * this._thrustMagnitude;
      const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
      pos.add(lateral.multiplyScalar(bobX));
      pos.addScaledVector(radialDir, bobY);
    }

    let look = playerPos.clone().addScaledVector(velDir, 0.001);

    if (this.firstPerson.freeLookActive) {
      const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
      look.add(lateral.multiplyScalar(this.firstPerson.freeLookYaw * 0.001));
      look.addScaledVector(radialDir, this.firstPerson.freeLookPitch * 0.001);
    }

    return { pos, look };
  }

  _computeChase(dt, playerPos, velDir, radialDir, allowTargetBias = false) {
    // Menu→sim intro uses a scaled chase offset for the match-cut settle.
    const s = this._introScale;

    const pos = playerPos.clone()
      .addScaledVector(velDir, -this.chase.offsetBehind * s)
      .addScaledVector(radialDir, this.chase.offsetAbove * s);

    const look = playerPos.clone()
      .addScaledVector(velDir, this.chase.lookAhead);

    // Folded-in TARGET_LOCK behaviour: when a debris target is locked (set each frame during APPROACH) and reasonably
    // close, gently bias the look point toward it and ease the camera back a touch so ship and target stay framed.
    // Intentionally subtle; only on the live CHASE view (not the ARM_PILOT / TARGET_LOCK fallbacks).
    if (allowTargetBias && this.targetLock.target) {
      const sep = playerPos.distanceTo(this.targetLock.target);
      // Only within the OVERVIEW zoom range (~1 km), to avoid acting on a stale target left from a previous approach.
      if (sep > 1e-9 && sep < this.orbit.maxDistance) {
        const bias = this.chase.targetLookBias; // 0..1 fraction toward target
        look.lerp(this.targetLock.target, bias);
        // Pull back proportional to separation (capped) so the target does not crowd the edge of frame as it nears.
        const pullback = Math.min(sep * 0.4, this.chase.offsetBehind * 1.5);
        pos.addScaledVector(velDir, -pullback);
      }
    }

    // Scale the near plane to the live camera→ship distance so the closest hull parts don't clip when zoomed in and the
    // ship rotates toward the camera (proportional keeps depth precision sane at all chase distances).
    this._applyDynamicNearPlane(pos.distanceTo(playerPos));

    return { pos, look };
  }

  /**
   * Drag moves (mouse delta, finger nudge) since the last drawn frame, as a TURN in rad. The frame that draws them
   * turns by exactly this (_coastDrag); `velocity*` is set to the speed it will have (turn / last step) at once so
   * "a drag is live" readers (the frame scheduler) see it before the frame.
   * @param {object} d - drag config (orbit / inspection / ladder drag)
   * @param {boolean} sum - add to the turn already pending (touch coalescing) instead of replacing it
   * @private
   */
  _dragMove(d, addTheta, addPhi, sum) {
    if (sum && d.hasPend) {
      d.pendTheta += addTheta;
      d.pendPhi += addPhi;
    } else {
      d.pendTheta = addTheta;
      d.pendPhi = addPhi;
    }
    d.hasPend = true;
    const step = this._lastCoastStepS || 1 / COAST_REF_FPS;
    d.velocityTheta = d.pendTheta / step;
    d.velocityPhi = d.pendPhi / step;
  }

  /** Drop all drag motion (speed and unapplied moves). @private */
  _dragStop(d) {
    d.velocityTheta = 0;
    d.velocityPhi = 0;
    d.pendTheta = 0;
    d.pendPhi = 0;
    d.hasPend = false;
  }

  /**
   * One frame of drag motion at the REAL step (seconds): the same total coast at every frame rate.
   *  - a frame WITH new moves turns by exactly those moves and sets the speed (turn / step; scaled by `carry`, below),
   *    no decay that frame;
   *  - a frame without coasts: angle += speed * (1 - d) / k, speed *= d, with
   *    d = damping ** (step * 60), k = -60 ln(damping)  (damping = per 1/60 s).
   * `carry` = d60 * (-ln d60) / (1 - d60) makes the 60 fps turn per frame bit-for-bit the 0.92^n series (a move frame
   * leaves `damping` x the move; the discrete sum d/(1-d) differs 4 % from the continuous 1/k).
   * Writes the turn to this._coastOut ({theta, phi}, rad) and returns it.
   * @private
   */
  _coastDrag(d, stepS) {
    const out = this._coastOut || (this._coastOut = { theta: 0, phi: 0 });
    const dmp = Math.min(0.999999, Math.max(1e-6, d.damping));
    this._lastCoastStepS = stepS;
    if (d.hasPend) {
      const carry = dmp * (-Math.log(dmp)) / (1 - dmp);
      out.theta = d.pendTheta;
      out.phi = d.pendPhi;
      d.velocityTheta = d.pendTheta / stepS * carry;
      d.velocityPhi = d.pendPhi / stepS * carry;
      d.pendTheta = 0;
      d.pendPhi = 0;
      d.hasPend = false;
      return out;
    }
    if (d.velocityTheta === 0 && d.velocityPhi === 0) {
      out.theta = 0;
      out.phi = 0;
      return out;
    }
    const dec = Math.pow(dmp, Math.min(COAST_STEP_MAX_S, stepS) * COAST_REF_FPS);   // a long hitch never flings the view
    const k = -COAST_REF_FPS * Math.log(dmp);
    const gain = (1 - dec) / k;
    out.theta = d.velocityTheta * gain;
    out.phi = d.velocityPhi * gain;
    d.velocityTheta *= dec;
    d.velocityPhi *= dec;
    if (Math.abs(d.velocityTheta) < COAST_REST_RAD_S) d.velocityTheta = 0;
    if (Math.abs(d.velocityPhi) < COAST_REST_RAD_S) d.velocityPhi = 0;
    return out;
  }

  /** Orbit camera: free orbit around the player in the LVLH frame (no skew or roll); drag rotates, scroll zooms. @private */
  _computeOrbit(dt, playerPos, velDir, radialDir) {
    const _wallNow = this._wallNowMs();
    const _turn = this._coastDrag(this.orbit, coastStepS(this.orbit.lastWallMs, _wallNow));
    this.orbit.lastWallMs = _wallNow;
    this.orbit.theta += _turn.theta;
    this.orbit.phi += _turn.phi;

    // Clamp phi to avoid gimbal lock
    this.orbit.phi = clamp(this.orbit.phi, 0.1, Math.PI - 0.1);

    // Build LVLH frame: radial = "up pole", lateral = "right", forward = "ahead"
    const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
    const forward = this._tmpVecB.crossVectors(radialDir, lateral).normalize();

    // Spherical to Cartesian offset in LVLH: phi from radial (0 = directly above, π = directly below), theta azimuth
    // around radial in the forward/lateral plane
    const sinPhi = Math.sin(this.orbit.phi);
    const cosPhi = Math.cos(this.orbit.phi);
    const cosTheta = Math.cos(this.orbit.theta);
    const sinTheta = Math.sin(this.orbit.theta);

    const offset = this._tmpVecC.set(0, 0, 0)
      .addScaledVector(radialDir, this.orbit.distance * cosPhi)
      .addScaledVector(forward, this.orbit.distance * sinPhi * cosTheta)
      .addScaledVector(lateral, this.orbit.distance * sinPhi * sinTheta);

    const pos = playerPos.clone().add(offset);
    const look = playerPos.clone();

    // In the inspection sub-state, scale the near plane to the (very small) distance so close detail doesn't clip;
    // outside it the near plane stays at the global default (restored by _setInspectZoom(false)).
    if (this.orbit.inspectActive) {
      this._applyDynamicNearPlane(this.orbit.distance);
    }

    return { pos, look };
  }

  /**
   * Solve the ORBIT angles (theta, phi) that centre a world-space sky direction in the camera's view. Pure.
   * The orbit camera sits at `playerPos + offset` looking at `playerPos`, so its forward is `-offset̂`; to centre a sky
   * direction `d` you need `offset̂ = -d`. In the LVLH frame (radial = up pole, lateral = right, forward = ahead):
   *   phi   = acos(-d · radial)            — angle from the radial pole
   *   theta = atan2(-d · lateral, -d · forward)
   * The caller must respect _computeOrbit's gimbal clamp phi ∈ [0.1, π-0.1]: a target within ~5.7° of the ±radial axis
   * will be off-centre by the clamp, which is harmless for framing a wide figure.
   * @param {THREE.Vector3} dir — unit world-space sky direction to centre
   */
  solveOrbitAnglesForDirection(dir) {
    const nx = -dir.x, ny = -dir.y, nz = -dir.z;
    const r = this._lvlhRadial, l = this._lvlhLateral, f = this._lvlhForward;
    const dRadial = nx * r.x + ny * r.y + nz * r.z;
    const dLateral = nx * l.x + ny * l.y + nz * l.z;
    const dForward = nx * f.x + ny * f.y + nz * f.z;
    const phi = Math.acos(clamp(dRadial, -1, 1));
    const theta = Math.atan2(dLateral, dForward);
    return { theta, phi };
  }

  /**
   * Scale the camera near plane to a (very small) inspection distance so close detail doesn't clip. Shared by both
   * inspection paths (the OVERVIEW zoom sub-state and the discrete INSPECTION view) so the optics can't drift. The
   * change-guard avoids a projection-matrix rebuild on frames where near barely moves.
   * @param {number} distance camera-to-subject distance in scene units
   * @private
   */
  _applyDynamicNearPlane(distance) {
    const newNear = Math.max(distance * 0.02, 0.000001);
    if (Math.abs(this.camera.near - newNear) > newNear * 0.1) {
      this.camera.near = newNear;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Evaluate the zoom-driven inspection sub-state for OVERVIEW (ORBIT) after every zoom change. Schmitt trigger: engage
   * closer than `inspectEnterDist`, disengage only past the larger `inspectExitDist` (no flicker when parked near the
   * boundary). Mothership-only: debris/daughter inspection stays on the explicit bare-I / ARM_PILOT path.
   * @private
   */
  _evaluateInspectZoom() {
    // ZOOM LADDER: while engaged the shipped 12/18 m Schmitt is BYPASSED: the floor 1/2 wall/entry pair owns the inspect
    // optics (_ladderApplyInspectFx keys them on the engaged floor id).
    if (this._ladderCam.active) return;
    if (this.currentView !== CameraViews.ORBIT) return;

    const o = this.orbit;
    if (!o.inspectActive && o.distance < o.inspectEnterDist) {
      this._setInspectZoom(true);
    } else if (o.inspectActive && o.distance > o.inspectExitDist) {
      this._setInspectZoom(false);
    }
  }

  /**
   * Engage/disengage the OVERVIEW zoom-inspection sub-state: tween FOV, manage the dynamic near plane, fade the
   * vignette, toggle the mothership overlay. Does NOT change `currentView`.
   * @private
   */
  _setInspectZoom(on) {
    const o = this.orbit;
    if (o.inspectActive === on) return;
    o.inspectActive = on;

    if (on) {
      // Narrow the lens like the dedicated inspection view; remember the pre-zoom base FOV so exit restores it. The FOV
      // eases per frame in update() (the view-transition FOV lerp only runs during a view change).
      this._inspectZoomSavedFov = this._baseFov;
      this._inspectZoomFovTarget = this.inspection.fov; // single source of truth (shared with discrete view)
      this._fovBreathOffset = 0;
      this._fovBreathTarget = 0;
      this._fovBreathTimer = 0;

      this._applyInspectDim(true);
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'mother', targetId: null });
      eventBus.emit(Events.INSPECT_HULL_OUTLINE, { visible: true });
      // Onboarding signal: fires only on mother-inspection ENGAGE (never exit), so the `inspect` beat can confirm the
      // player reached the depth where the hull callouts appear.
      eventBus.emit(Events.MOTHER_INSPECTION_ENGAGED, {});

      // One-shot learning beat the first time inspection engages via zoom (the silent threshold did something deliberate).
      if (!o.inspectTaught) {
        o.inspectTaught = true;
        // a developer line; players see it only with the Tests switch on.
        if (this.testsSwitch) eventBus.emit(Events.SHOW_NOTIFICATION, { text: '🔍 INSPECTION. Overlays active', kind: 'inspect' });
      }
    } else {
      this._inspectZoomFovTarget = this._inspectZoomSavedFov || Constants.CAMERA_FOV;
      this.camera.near = Constants.CAMERA_NEAR;
      this.camera.updateProjectionMatrix();

      // Fade the background dim back out (any non-inspect view clears it) + hide overlay.
      this._applyInspectDim(false);
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'mother' });
      eventBus.emit(Events.INSPECT_HULL_OUTLINE, { visible: false });
    }
  }

  /**
   * Clear the zoom-inspection sub-state without a view transition (leaving OVERVIEW), so optics/overlays don't leak.
   * Also pulls the stored OVERVIEW zoom distance back out to the exit threshold: otherwise re-entering OVERVIEW
   * (V→COMMAND→V) would leave orbit.distance inside the inspection band with inspectActive false, so the optics stay
   * off AND _computeOrbit's dynamic near plane (gated on inspectActive) would not engage, letting the camera clip
   * through the mothership until the next wheel event.
   * @private
   */
  _clearInspectZoom() {
    if (!this.orbit.inspectActive) return;
    this._setInspectZoom(false);
    this.orbit.distance = Math.max(this.orbit.distance, this.orbit.inspectExitDist);
  }

  /** INSPECTION camera: reuses the orbit math with tighter limits + dynamic near plane. @private */
  _computeInspection(dt, playerPos, velDir, radialDir) {
    const cfg = this.inspection;

    const _wallNow = this._wallNowMs();
    const _turn = this._coastDrag(cfg, coastStepS(cfg.lastWallMs, _wallNow));
    cfg.lastWallMs = _wallNow;
    cfg.theta += _turn.theta;
    cfg.phi += _turn.phi;

    // Clamp phi to avoid gimbal lock
    cfg.phi = clamp(cfg.phi, 0.1, Math.PI - 0.1);

    const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
    const forward = this._tmpVecB.crossVectors(radialDir, lateral).normalize();

    const sinPhi = Math.sin(cfg.phi);
    const cosPhi = Math.cos(cfg.phi);
    const cosTheta = Math.cos(cfg.theta);
    const sinTheta = Math.sin(cfg.theta);

    const offset = this._tmpVecC.set(0, 0, 0)
      .addScaledVector(radialDir, cfg.distance * cosPhi)
      .addScaledVector(forward, cfg.distance * sinPhi * cosTheta)
      .addScaledVector(lateral, cfg.distance * sinPhi * sinTheta);

    const pos = playerPos.clone().add(offset);
    const look = playerPos.clone();

    this._applyDynamicNearPlane(cfg.distance);

    return { pos, look };
  }

  /**
   * Target-lock camera: shows both satellite AND target. UNREACHABLE (TARGET_LOCK removed from VIEW_CYCLE; nothing calls
   * setView(TARGET_LOCK)); retained for re-enable by re-adding CameraViews.TARGET_LOCK to VIEW_CYCLE. The framing
   * intent now lives in _computeChase's targetLookBias.
   * @private
   */
  _computeTargetLock(dt, playerPos, velDir, radialDir) {
    const target = this.targetLock.target;

    if (!target) {
      return this._computeChase(dt, playerPos, velDir, radialDir);
    }

    const midpoint = this._tmpVecC.copy(playerPos).add(target).multiplyScalar(0.5);

    const separation = playerPos.distanceTo(target);

    const toTarget = this._tmpVecD.subVectors(target, playerPos).normalize();
    const perpendicular = this._tmpVecA.crossVectors(toTarget, radialDir).normalize();
    if (perpendicular.lengthSq() < 0.001) {
      perpendicular.crossVectors(toTarget, this._tmpVecB.set(0, 1, 0)).normalize();
    }

    const camDist = Math.max(
      this.targetLock.minCamDist,
      separation * 0.8 + this.targetLock.offsetDistance
    );

    const pos = midpoint.clone()
      .addScaledVector(perpendicular, camDist * 0.5)
      .addScaledVector(radialDir, camDist * 0.3);

    const look = playerPos.clone().lerp(target, 0.15);

    return { pos, look };
  }

  /**
   * Wire the PlayerSatellite so the mother-pod net ceremony can anchor on the pod muzzle. Optional: when unset the pod
   * ceremony no-ops (same early-exit contract as a missing arm).
   * @param {object} player — PlayerSatellite with getNetPodPositionInto()
   */
  setPlayer(player) {
    this._player = player || null;
  }

  /**
   * Set the arm to follow in ARM_PILOT mode: narrows FOV and switches to the ARM_PILOT view.
   */
  setPilotArm(arm) {
    if (!arm) return;
    this.armPilot.arm = arm;
    this.armPilot.fovNormal = this._baseFov;
    this._fovBreathOffset = 0;
    this._fovBreathTarget = 0;
    this._fovBreathTimer = 0;
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.armPilot.fovNarrow;
    // Look-direction blend into the ARM PILOT view: if the arm has a target, start the blend already facing it so the
    // camera doesn't reverse 180° when the arm flies retrograde toward trailing debris.
    this.armPilot._lookBlendTime = 0;
    this.armPilot._lookBlendDuration = 1.5; // seconds
    this.armPilot._prevForward = new THREE.Vector3();
    if (arm.target && arm.target._scenePosition && arm.position) {
      this.armPilot._prevForward
        .subVectors(arm.target._scenePosition, arm.position)
        .normalize();
    } else if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
      this.armPilot._prevForward.copy(arm.velocity).normalize();
    } else {
      this.camera.getWorldDirection(this.armPilot._prevForward);
    }
    this.setView(CameraViews.ARM_PILOT);
  }

  /**
   * @private FOV transition + look-blend fields for ARM_PILOT entry, shared with the launch-ceremony auto-entry path.
   * Caller must set this.armPilot.arm BEFORE invoking, then call setView(ARM_PILOT) AFTER.
   */
  _setupArmPilotEntry(arm) {
    this.armPilot.fovNormal = this._baseFov;
    this._fovBreathOffset = 0;
    this._fovBreathTarget = 0;
    this._fovBreathTimer = 0;
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.armPilot.fovNarrow;
    // Look-direction blend into ARM_PILOT (see setPilotArm).
    this.armPilot._lookBlendTime = 0;
    this.armPilot._lookBlendDuration = 1.5;
    this.armPilot._prevForward = new THREE.Vector3();
    if (arm.target && arm.target._scenePosition && arm.position) {
      this.armPilot._prevForward
        .subVectors(arm.target._scenePosition, arm.position)
        .normalize();
    } else if (arm._stationKeepTarget && arm._stationKeepTarget._scenePosition && arm.position) {
      // Daughter already in SK before the ceremony ended: face the debris.
      this.armPilot._prevForward
        .subVectors(arm._stationKeepTarget._scenePosition, arm.position)
        .normalize();
    } else if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
      this.armPilot._prevForward.copy(arm.velocity).normalize();
    } else {
      this.camera.getWorldDirection(this.armPilot._prevForward);
    }
  }

  /** Exit ARM_PILOT mode: restore FOV and return to CHASE view. */
  clearPilotArm() {
    this.armPilot.arm = null;
    this.armPilot._skLookTarget = null; // Clear STATION_KEEP smooth look target
    this.armPilot._skLockedUp = null;   // Clear STATION_KEEP frozen up vector
    // Restore default ARM_PILOT offsets (ceremony may have boosted them to 8×)
    this.armPilot.offsetBehind = 0.00005;
    this.armPilot.offsetAbove  = 0.000016;
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.armPilot.fovNormal || Constants.CAMERA_FOV;
    this.setView(CameraViews.CHASE);
  }

  /** @returns {import('../entities/ArmUnit.js').ArmUnit|null} the piloted arm */
  getPilotedArm() {
    return this.armPilot.arm;
  }

  /**
   * Start the launch cinematic camera sequence.
   */
  startLaunchCeremony(arm) {
    if (!arm) return;
    const c = this._launchCeremony;
    c.active = true;
    c.phase = 1;  // OBSERVE
    c.timer = 0;
    c.arm = arm;
    c.prevPos.copy(this.camera.position);
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    c.prevLook.copy(this.camera.position).add(lookDir.multiplyScalar(0.001));

    // Reset dynamic slew multiplier — recomputed on first Phase 1 frame
    c._slewMultiplier = undefined;

    // Latch: once the crossbow spring fires, never override arm position again (arm._springFired resets on the
    // LAUNCHING→TRANSIT transition, so the ceremony needs its own persistent flag).
    c._springLatch = false;

    // Save pre-ceremony FOV for ESC restore and fovNormal
    c.savedFov = this._baseFov;

    this._transitioning = false;
    this._transitionProgress = 0;

    this._fovTransitionStart = undefined;
    this._fovTransitionEnd = undefined;

    // Reset ARM_PILOT offsets to defaults so Phase 2's * 8 is always correct (a previous ceremony may have left
    // boosted 8× offsets from completion).
    this.armPilot.offsetBehind = 0.00005;
    this.armPilot.offsetAbove  = 0.000016;
  }

  /**
   * Skip the launch ceremony: jump to ARM_PILOT or restore the previous view.
   * @param {boolean} [enterPilot=true] - true → enter ARM_PILOT, false → return to CHASE (ESC)
   */
  skipLaunchCeremony(enterPilot = true) {
    const c = this._launchCeremony;
    if (!c.active) return;
    const arm = c.arm;
    c.active = false;
    c.phase = 0;
    if (!enterPilot) {
      this._baseFov = c.savedFov || Constants.CAMERA_FOV;
    }
    this.camera.fov = this._baseFov;
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();
    if (enterPilot && arm) {
      eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm });
    } else {
      // Every exit that does NOT hand off to the pilot must still stand the ceremony-state listeners down; otherwise
      // one ESC/Space/Enter/D skip (or the dead-arm guard above the phase machine) leaves _launchCeremonyLive true in
      // main.js (the frame scheduler boosts to native refresh for the REST OF THE SESSION) and sticks TeachingSystem's
      // 'launchCeremony' blocker and CollisionAvoidanceSystem._ceremonyActive (auto-dodge disabled).
      // ABORT deliberately skips the COMPLETE side effects (ArmPilot entry, FOV keep, enableManual: InputManager's
      // COMPLETE handler).
      eventBus.emit(Events.LAUNCH_CEREMONY_ABORT, { arm });
    }
  }

  /**
   * Update the launch ceremony: 3-phase cinematic camera sequence (durations: DURATIONS below).
   *   Phase 1 OBSERVE: camera stays at CHASE; the player watches the daughter power up, the strut aim, the crossbow
   *     spring fire (at CROSSBOW_UNDOCK_TIME: camera shake, mother recoil) and the daughter shoot off, tether streaming.
   *   Phase 2 TETHER_FOLLOW: smooth dolly from CHASE behind-mother to behind-daughter along the tether (not FPV:
   *     slightly behind & above so a new player keeps perspective); FOV narrows gradually.
   *   Phase 3 HANDOFF: settles to the standard ARM_PILOT viewpoint; FOV eases to ARM_PILOT narrow (40°).
   * @private
   * @returns {{ pos: THREE.Vector3, look: THREE.Vector3 }|null}
   */
  _updateLaunchCeremony(dt, playerPos, velDir, radialDir, playerQuat) {
    const c = this._launchCeremony;
    //                     Phase:  0    1       2       3
    const DURATIONS = [0, 3.25, 3.5, 1.0]; // total 7.75s.
    // Phase 1 (3.25s): the spring fires at CROSSBOW_UNDOCK_TIME (1.5s), leaving ~1.75s to SEE the daughter separate and
    //   fly free in the familiar wide CHASE view before the camera leaves the mothership.
    // Phase 2 (3.5s) / Phase 3 (1.0s): a longer, gentler glide + settle into the pilot view so the handoff reads as
    //   gradual rather than a lunge.
    c.timer += dt;

    if (c.timer >= DURATIONS[c.phase]) {
      c.timer -= DURATIONS[c.phase];
      c.phase++;

      if (c.phase === 2) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Tracking ${c.arm.displayName}. Tether deploying`,
          priority: 'info',
        });
      }

      // Phase 3 entry: boost ARM_PILOT offsets BEFORE Phase 3 runs: _computeArmPilot() reads them, so otherwise it
      // lerps to 0.3 m (default).
      if (c.phase === 3) {
        this.armPilot.offsetBehind = 0.00005;   // 5m behind
        this.armPilot.offsetAbove  = 0.000016;  // 1.6m above
      }

      if (c.phase > 3) {
        // Ceremony complete → ARM_PILOT is entered automatically below (the camera stays on the daughter).
        // Restore near-plane pushed during Phase 2-3
        this.camera.near = Constants.CAMERA_NEAR;
        this.camera.updateProjectionMatrix();
        const completingArm = c.arm;
        c.active = false;
        c.phase = 0;
        // Camera STAYS on the daughter: auto-enter ARM_PILOT so the player immediately gets the inspection framing of
        // the debris instead of being yanked back to the mothership CHASE view.
        this.armPilot.offsetBehind = 0.00005;   // 5m past debris (in SK branch)
        this.armPilot.offsetAbove  = 0.000016;  // 1.6m above
        this.armPilot.arm = completingArm;
        this._setupArmPilotEntry(completingArm);
        // Force a transition lerp so the camera doesn't snap (setView would otherwise short-circuit if currentView
        // already matches).
        this._previousView = this.currentView;
        this._transitioning = true;
        this._transitionProgress = 0;
        this._transitionStartOffset.copy(this.camera.position).sub(this._lastPlayerPos);
        this._transitionStartLookDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.setView(CameraViews.ARM_PILOT);
        eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm: completingArm });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${completingArm.displayName} deployed. Arrow keys orbit debris, ESC to recall`,
          priority: 'info',
        });
        return this._computeArmPilot(dt, playerPos, velDir, radialDir);
      }
    }

    const t = c.timer / DURATIONS[c.phase];
    const ease = smoothstep01(t);
    const arm = c.arm;
    if (!arm || !arm.position) { this.skipLaunchCeremony(); return null; }

    if (arm.state === 'EXPENDED' || arm.state === 'DOCKED') {
      this.skipLaunchCeremony(false);
      return null;
    }

    // Daughter reached STATION_KEEP before the ceremony finished (timing race when debris is close: e.g. 35 m at
    // 10 m/s ≈ 3.5 s arrival vs 6 s ceremony). Complete immediately so the daughter is still findable and armPilot is
    // prepped: the ceremony hands the player straight into the daughter (LAUNCH_CEREMONY_COMPLETE auto-enters
    // ARM_PILOT). Cannot use skipLaunchCeremony(): it omits armPilot setup, comms and LAUNCH_CEREMONY_COMPLETE, so the
    // phase > 3 completion block above is replicated inline.
    if (arm.state === Constants.ARM_STATES.STATION_KEEP && c.phase < 3) {
      this.camera.near = Constants.CAMERA_NEAR;
      this.camera.updateProjectionMatrix();
      const completingArm = c.arm;
      c.active = false;
      c.phase = 0;
      // Same as phase>3 path: stay on daughter via ARM_PILOT (don't jump to mother).
      this.armPilot.offsetBehind = 0.00005;   // 5m past debris (in SK branch)
      this.armPilot.offsetAbove  = 0.000016;  // 1.6m above
      this.armPilot.arm = completingArm;
      this._setupArmPilotEntry(completingArm);
      this._previousView = this.currentView;
      this._transitioning = true;
      this._transitionProgress = 0;
      this._transitionStartOffset.copy(this.camera.position).sub(this._lastPlayerPos);
      this._transitionStartLookDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.setView(CameraViews.ARM_PILOT);
      eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm: completingArm });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${completingArm.displayName} deployed. Arrow keys orbit debris, ESC to recall`,
        priority: 'info',
      });
      return this._computeArmPilot(dt, playerPos, velDir, radialDir);
    }

    const armPos = arm.position.clone();
    const localUp = armPos.clone().normalize();
    let pos, look;

    let fwd = velDir.clone();
    if (arm.target && arm.target._scenePosition) {
      fwd = arm.target._scenePosition.clone().sub(armPos).normalize();
    } else if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
      fwd = arm.velocity.clone().normalize();
    }

    // Orthogonalize localUp against fwd so "behind" and "above" offsets stay perpendicular (same as _computeArmPilot).
    localUp.addScaledVector(fwd, -fwd.dot(localUp)).normalize();

    switch (c.phase) {

      // Phase 1: OBSERVE (3.25s): camera at CHASE, watching the satellite
      case 1: {
        // Drive strut slew toward target direction during clamp hold. With LAUNCH_AIMS_STRUT on, the launch gate has
        // already swung the strut at its real strut rate (19.5°/s) and the spring pushes along it: the cut-scene never
        // writes a strut (a 4x+ swing would be the "teleporting strut" the owner's physics ruling forbids).
        if (!Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT
            && arm.launchDirection && arm._dockOutward && playerQuat && arm.setAimAlpha) {
          const invQuat = playerQuat.clone().invert();
          const localDir = arm.launchDirection.clone().applyQuaternion(invQuat).normalize();
          // Strut-alpha in the PlayerSatellite MODEL frame.
          // Model convention: barrel axis = Z, collar radial plane = XY.
          // _dockOutward stores (cos θ, 0, sin θ) in the XZ collar convention,
          // so _dockOutward.z = sin(θ) maps to the model's Y-radial component.
          // sin(α) = target · model_outward = target.x·cos(θ) + target.y·sin(θ)
          const sinA = localDir.x * arm._dockOutward.x + localDir.y * arm._dockOutward.z;
          // cos(α) = target · (-ẑ_barrel) = -target.z
          const cosA = -localDir.z;
          const tgtAlpha = Math.atan2(Math.abs(sinA), cosA);

          // Dynamic slew multiplier: the strut must reach tgtAlpha BEFORE the spring fires at CROSSBOW_UNDOCK_TIME.
          // Budget 80% of the undock window; minimum 4× so small angles still look smooth.
          if (c._slewMultiplier === undefined) {
            // First frame of Phase 1 — compute once from initial delta
            const curAlpha = arm.getAimAlpha ? arm.getAimAlpha() : 0;
            const angleDelta = Math.abs(tgtAlpha - curAlpha);
            const budget = Constants.CROSSBOW_UNDOCK_TIME * 0.8;  // 80% of undock window
            const baseRate = Constants.OCTOPUS_V5.STRUT_SLEW_RATE;  // rad/s
            // multiplier so that baseRate × multiplier × budget ≥ angleDelta
            const needed = angleDelta / (baseRate * Math.max(budget, 0.01));
            c._slewMultiplier = Math.max(4, Math.ceil(needed));
          }
          arm.setAimAlpha(tgtAlpha, dt * c._slewMultiplier);
        }

        // Latch spring-fire on the ceremony object so the flag survives the LAUNCHING→TRANSIT state transition
        // (ArmUnit resets _springFired).
        if (arm._springFired && !c._springLatch) {
          c._springLatch = true;
        }

        // Track strut tip position during clamp hold (before spring fires). Uses the ceremony latch, since
        // arm._springFired resets on state transition.
        if (!c._springLatch && arm.dockOffset && playerQuat) {
          const tipOffset = arm.dockOffset.clone().applyQuaternion(playerQuat);
          arm.position.copy(playerPos).add(tipOffset);
        }

        // The "Spring released. Separating" line is ArmUnit's (at ARM_SPRING_FIRED, so it shows with or without this
        // cut-scene).

        // Camera: stay exactly at CHASE (tracks orbiting player at ~7.6 km/s).
        // Look directly at the arm — starts at strut tip, flies away after spring fires.
        const chaseResult = this._computeChase(dt, playerPos, velDir, radialDir);
        pos = chaseResult.pos;
        look = arm.position.clone();
        break;
      }

      // Phase 2: TETHER_FOLLOW (3.5s): zoom from mother to behind-daughter
      case 2: {
        const chasePos = this._computeChase(dt, playerPos, velDir, radialDir).pos;

        // End: behind the daughter arm (4 m behind, 1.3 m above): the daughter mesh (~0.3 m) fills ~8.5% of screen height
        // at 45° FOV, with several metres of tether in frame.
        const behindDaughter = armPos.clone()
          .addScaledVector(fwd, -0.00004)    // 4m behind
          .addScaledVector(localUp, 0.000013); // 1.3m above

        pos = new THREE.Vector3().lerpVectors(chasePos, behindDaughter, ease);

        // Look ahead (same 0.001 = 100 m pattern as _computeArmPilot): keeps the daughter in the lower frame, tether
        // trailing behind visible.
        const lookAhead = armPos.clone().addScaledVector(fwd, 0.001);
        look = new THREE.Vector3().lerpVectors(armPos, lookAhead, ease);
        break;
      }

      // Phase 3: HANDOFF (1.0s): settle to the ARM_PILOT tracking view
      case 3: {
        this.armPilot.arm = c.arm;
        const apResult = this._computeArmPilot(dt, playerPos, velDir, radialDir);

        // Start: behind-daughter (same geometry as the Phase 2 endpoint); offsets are already boosted at the Phase 2→3
        // transition (4 m / 1.3 m).
        const startPos = armPos.clone()
          .addScaledVector(fwd, -this.armPilot.offsetBehind)
          .addScaledVector(localUp, this.armPilot.offsetAbove);
        const startLook = armPos.clone().addScaledVector(fwd, 0.001);

        pos = new THREE.Vector3().lerpVectors(startPos, apResult.pos, ease);
        look = new THREE.Vector3().lerpVectors(startLook, apResult.look, ease);
        break;
      }
    }

    // FOV + near plane. Phase 1: keep CHASE FOV (the player observes from the familiar view). Phase 2-3: ease toward 45°
    // (moderate cinematic view behind the daughter), kept through Phase 3 so the post-ceremony ARM_PILOT tracking view
    // matches Phase 2 exactly (no visual zoom from FOV narrowing). Selecting a launched daughter (1-4) eases to 40°
    // (armPilot.fovNarrow).
    if (c.phase >= 2) {
      const targetFov = 45;
      const fovEaseRate = 1.5;
      this._baseFov += (targetFov - this._baseFov) * Math.min(1, fovEaseRate * dt);
      this.camera.fov = this._baseFov;

      // Dynamic near plane: the camera is very close to the daughter in phases 2-3, where the default CAMERA_NEAR (3 m)
      // clips her mesh; push near to 0.1 m (same floor as INSPECTION mode) so daughter + tether stay visible.
      this.camera.near = 0.000001;   // ~0.1m
      this.camera.updateProjectionMatrix();
    }

    return { pos, look };
  }

  // NET CEREMONY CINEMATIC (archive/CEREMONY_REDESIGN.md §4)

  /** NET_CEREMONY_START handler: enter NET_CINEMATIC mode. @private */
  _onNetCeremonyStart(payload) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return;
    if (this._netCeremony.active) return;       // already in ceremony
    if (this._launchCeremony.active) return;     // don't interrupt launch

    const c = this._netCeremony;
    const M = 0.00001;
    const NC = Constants.CAPTURE_NET.NET_CEREMONY;
    const BD = NC.BEAT_DURATIONS_S;
    const HCB = NC.HIGHLIGHTS_CUT_BEATS;
    const HTS = NC.HIGHLIGHTS_TIME_SCALE;

    // First-deploy flags from PersistenceManager. The mother path has its own flag: FIRST_NET_DEPLOY is
    // daughter-flavoured (set by the arm ceremony), so without a mother flag the first-ever WHALE catch would play the
    // trimmed highlights cut even though the player has never seen the pod fire.
    const isMotherShot = (payload.podIndex ?? -1) >= 0 && (payload.armIndex ?? -1) < 0;
    const firstDeployDone = isMotherShot
      ? persistenceManager.getCeremonyFlag('FIRST_MOTHER_NET_DEPLOY')
      : persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
    const isFirstEver = !firstDeployDone;

    // FOV targets per beat (design doc §5.3)
    const BEAT_FOV = {
      POD_MUZZLE_PREFIRE: 35,
      MUZZLE_EXIT_SPINUP: 40,
      GLAMOUR_SHOT:       50,
      APPROACH_DOLLY:     45,
      BRAKE_ENVELOP:      38,
      CINCH:              42,
      SECURED_SETTLE:     45,
    };

    // Per-beat physics time-scale (archive/CEREMONY_REDESIGN.md §5.1): applied ONLY to NetProjectile.update() and
    // CaptureNetVisual.update() via CeremonyTimeScale. World dt stays at 1.0× (§6 R1).
    const BEAT_TIME_SCALE = {
      POD_MUZZLE_PREFIRE: NC.TIME_SCALE_PRE_FLIGHT, // 0.4 — beats 1–2
      MUZZLE_EXIT_SPINUP: NC.TIME_SCALE_PRE_FLIGHT, // 0.4
      GLAMOUR_SHOT:       NC.TIME_SCALE_GLAMOUR,    // 0.5 — beat 3
      APPROACH_DOLLY:     NC.TIME_SCALE_APPROACH,   // 0.6 — beat 4
      BRAKE_ENVELOP:      NC.TIME_SCALE_BRAKE,      // 0.3 — beat 5 (heavy slowmo)
      CINCH:              NC.TIME_SCALE_CINCH,      // 0.4 — beat 6
      SECURED_SETTLE:     1.0,                      // beat 7 — full speed
    };

    let beats;
    if (isFirstEver) {
      beats = [
        { key: 'POD_MUZZLE_PREFIRE', duration: BD.POD_MUZZLE_PREFIRE, fov: 35, timeScale: BEAT_TIME_SCALE.POD_MUZZLE_PREFIRE },
        { key: 'MUZZLE_EXIT_SPINUP', duration: BD.MUZZLE_EXIT_SPINUP, fov: 40, timeScale: BEAT_TIME_SCALE.MUZZLE_EXIT_SPINUP },
        { key: 'GLAMOUR_SHOT',       duration: BD.GLAMOUR_SHOT,       fov: 50, timeScale: BEAT_TIME_SCALE.GLAMOUR_SHOT },
        // APPROACH_DOLLY 8.0 s: so the FLIGHT phase completes inside this beat for typical 30–80 m engagements
        // (10 m/s × scale 0.6 = 6 m/s wall, so 8 s wall ≈ 48 m of flight). NET_BRAKE_FIRED force-advances out of this
        // beat on contact, so the long cap is only a safety bound; it does not extend the ceremony.
        { key: 'APPROACH_DOLLY',     duration: 8.0,                   fov: 45, timeScale: BEAT_TIME_SCALE.APPROACH_DOLLY },
        { key: 'BRAKE_ENVELOP',      duration: BD.BRAKE_ENVELOP,      fov: 38, timeScale: BEAT_TIME_SCALE.BRAKE_ENVELOP },
        { key: 'CINCH',              duration: BD.CINCH,              fov: 42, timeScale: BEAT_TIME_SCALE.CINCH },
        { key: 'SECURED_SETTLE',     duration: BD.SECURED_SETTLE,     fov: 45, timeScale: BEAT_TIME_SCALE.SECURED_SETTLE },
      ];
    } else {
      // Highlights cut: only HIGHLIGHTS_CUT_BEATS, with the beat DURATION multiplied by HIGHLIGHTS_TIME_SCALE (the
      // per-beat physics time-scale is the SAME as the full sequence). APPROACH_DOLLY has no single BEAT_DURATIONS_S
      // entry (only _MIN/_MAX), so it uses the same 8.0 s safety cap as the full sequence (force-advanced on
      // NET_BRAKE_FIRED), giving the FSM time to contact the target inside the ceremony.
      beats = HCB.map(key => {
        const duration = key === 'APPROACH_DOLLY'
          ? 8.0 * HTS
          : BD[key] * HTS;
        return {
          key,
          duration,
          fov: BEAT_FOV[key],
          timeScale: BEAT_TIME_SCALE[key] ?? 1.0,
        };
      });
    }

    // Resolve the launcher. Daughter path (armIndex ≥ 0): the ARM_PILOT arm anchors the ceremony. Mother path
    // (podIndex ≥ 0, armIndex < 0): the pod muzzle anchors it, polled live each frame because the pod rides the ship.
    // Either path yields { getPos, getDebrisPos, net }; neither ⇒ refuse to start (test-NetCinematic asserts this for
    // the daughter path).
    const isMother = (payload.podIndex ?? -1) >= 0 && (payload.armIndex ?? -1) < 0;
    let launcher = null;
    let net = null;
    let arm = null;
    const cns = this._netSystemRef();
    if (isMother) {
      net = cns.getActiveNetForPod
        ? cns.getActiveNetForPod(payload.podIndex)
        : null;
      const player = this._player;
      const podIndex = payload.podIndex;
      if (net && player && typeof player.getNetPodPositionInto === 'function') {
        launcher = {
          getPos: (out) => player.getNetPodPositionInto(podIndex, out),
          getDebrisPos: (out) => {
            const sp = net.targetDebris?._scenePosition;
            return sp ? out.copy(sp) : null;
          },
        };
      }
    } else {
      arm = this.armPilot.arm;
      net = cns.getActiveNetForArm(payload.armIndex);
      if (arm && arm.position) {
        launcher = {
          getPos: (out) => out.copy(arm.position),
          getDebrisPos: (out) => {
            const sp = arm.target?._scenePosition ?? arm._stationKeepTarget?._scenePosition;
            return sp ? out.copy(sp) : null;
          },
        };
      }
    }
    if (!launcher) return;

    // A ceremony films a LAUNCH. A net already seated at the ship (the lasso-adoption hand-off constructs one directly
    // in BERTHED, adoptLassoCatch) has no flight to film: the beats would replay the launch around a parked bag and drag
    // the camera to flight anchors in empty space. Belt-and-braces with the _ceremonyStartEmitted suppression at the
    // adoption site.
    if (net && (net.state === 'BERTHED' || net.state === 'COLLARED'
      || net.state === 'TRANSFERRING' || net.state === 'STOWED')) return;

    // A real pod launch outranks the lasso garnish: if the cut is live (lasso mid-reel + simultaneous whale fire),
    // release it before the ceremony takes NET_CINEMATIC, so ENTERED/EXITED stay paired.
    if (this._lassoCut.active) this._exitLassoCut(false);

    c.active = true;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = beats;
    c.armIndex = payload.armIndex;
    c.podIndex = payload.podIndex;
    c.arm = arm;
    c._launcher = launcher;
    c._net = net;
    c.savedView = this.currentView;
    c.savedFov = this._baseFov;
    c.isFirstEver = isFirstEver;
    c.success = null;
    c._reelBeatChained = false;

    // Launch direction (unit vector) + radial/side frame, anchored on the launcher's CURRENT position.
    const launcherPos = launcher.getPos(c._scratchLauncherPos);
    if (net) {
      c._launchFwd.set(
        net.launchDirection.x,
        net.launchDirection.y,
        net.launchDirection.z
      ).normalize();
      c._netDiameterScene = (net.netClass?.DIAMETER || 5) * M;
    } else if (launcher.getDebrisPos(c._v3d)) {
      c._launchFwd.copy(c._v3d).sub(launcherPos).normalize();
      c._netDiameterScene = 5 * M;
    } else {
      c._launchFwd.copy(this._lastVelDir);
      c._netDiameterScene = 5 * M;
    }

    // Side direction: cross(fwd, radialUp) — consistent "port side"
    const radialUp = c._v3e.copy(launcherPos).normalize();
    c._sideDir.crossVectors(c._launchFwd, radialUp).normalize();
    if (c._sideDir.lengthSq() < 0.001) {
      c._sideDir.crossVectors(c._launchFwd, c._v3e.set(0, 1, 0)).normalize();
    }

    // Publish the first beat's physics time-scale BEFORE the next NetProjectile / CaptureNetVisual tick. EventBus is
    // synchronous, so this handler completes inside captureNetSystem.update() before the camera tick; the very first
    // NetProjectile sub-step that emitted NET_CEREMONY_START already ran at 1.0× (one-frame lag accepted).
    if (beats.length > 0) {
      CeremonyTimeScale.set(beats[0].timeScale ?? 1.0, this);
    }

    // Under the zoom ladder the ceremony's camera never shows (update() hands the frame to the ladder before it reaches
    // _updateNetCeremony), so a NET_CINEMATIC cut would only leave a ghost view and a ceremony nothing advances. Keep the
    // slow motion of the net flight (released when the catch resolves, NET_CEREMONY_COMPLETE) and take no view, FOV,
    // near plane or cinema-dim event. The catch focus (CATCH_FOCUS) is what the player sees instead.
    if (this._ladderCam.active) {
      c._quiet = true;
      return;
    }
    c._quiet = false;

    this.currentView = CameraViews.NET_CINEMATIC;
    this._transitioning = false;
    this._transitionProgress = 0;
    this._fovTransitionStart = undefined;
    this._fovTransitionEnd = undefined;

    // Cinema-dim contract: announce that the ceremony cut is actually LIVE on screen. Emitted here (not at
    // NET_CEREMONY_START) so a refused ceremony (no launcher, launch ceremony active, flag off) never dims the HUD.
    // HUD.js listens and dims the overlay.
    eventBus.emit(Events.NET_CINEMATIC_ENTERED, {
      armIndex: c.armIndex, podIndex: c.podIndex, isFirstEver,
    });
  }

  /** NET_BRAKE_FIRED advisory handler: snap APPROACH_DOLLY to BRAKE_ENVELOP. @private */
  _onNetBrakeFired(payload) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return;
    const c = this._netCeremony;
    if (!c.active) return;
    // Identity filter: match on the launcher axis that started this ceremony (armIndex for daughter, podIndex for
    // mother; two mother pods share armIndex=-1, so armIndex alone cannot discriminate pod ceremonies).
    if (c.podIndex >= 0 ? (c.podIndex !== payload.podIndex)
                       : (c.armIndex !== payload.armIndex)) return;

    const beat = c.beats[c.beatIndex];
    if (beat && beat.key === 'APPROACH_DOLLY') {
      c.beatTimer = beat.duration;
    }
  }

  /** NET_CEREMONY_COMPLETE handler: handle a miss (truncate) or a success (let play out). @private */
  _onNetCeremonyComplete(payload) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return;
    const c = this._netCeremony;
    if (!c.active) return;
    // Identity filter: see _onNetBrakeFired.
    if (c.podIndex >= 0 ? (c.podIndex !== payload.podIndex)
                       : (c.armIndex !== payload.armIndex)) return;

    c.success = payload.success;

    // A quiet ceremony (ladder on) has no beats to play out: the catch has resolved either way, so the slow motion ends
    // here (the reel must run at full speed) and the catch focus takes over.
    if (c._quiet) {
      this._endQuietNetCeremony();
      return;
    }

    if (payload.success === false) {
      this._exitNetCeremony(false);
    }
    // Success path: let the ceremony beats play out naturally.
    // _updateNetCeremony will call _exitNetCeremony(true) when all beats finish.
  }

  /**
   * Chain a trailing REEL_IN beat onto the ceremony when a mother catch is mid-reel as the capture beats complete. The
   * beat frames mother + incoming catch in a 3/4 view and is released to the player cam at berth (NET_BERTHED →
   * _onNetBerthed) or at the REEL_BEAT_MAX_S wall-clock cap, never a 40 s hold.
   * Runs at 1.0× timeScale: CeremonyTimeScale multiplies the reel's dt, so a slowmo beat would slow the winch. Skipped
   * under prefers-reduced-motion, for daughter catches, and when the reel already finished inside the capture beats.
   * @param {object} c — the _netCeremony state
   * @returns {boolean} true when the REEL_IN beat was chained
   * @private
   */
  _tryChainReelBeat(c) {
    if (c.podIndex < 0) return false;                    // daughter — exit as before
    if (c._reelBeatChained) return false;                // chain once: the cap is the release valve; re-chaining
                                                       // would hold the cinematic for the whole reel (never 40 s)
    if (this._prefersReducedMotion()) return false;      // accessibility gate
    const net = c._net;
    if (!net || net.state !== 'REELING' || net.catchResult !== 'success') return false;
    if (net._motherReelFallback) return false;           // headless fallback reel

    const NC = Constants.CAPTURE_NET.NET_CEREMONY;
    // Wall-clock estimate: remaining distance ÷ reel speed, padded, capped. The beat force-advances on NET_BERTHED, so
    // this is only a safety bound; the corridor hold can add up to CORRIDOR_TIMEOUT_S, which the cap absorbs (release
    // mid-hold is the intended pressure valve).
    const reelSpeed = net.netClass?.REEL_SPEED || 2.0;
    const remaining = net._remainingM ?? 0;
    // Effectively berthed: a close-range shot that finished its reel inside the capture beats. (remaining/speed)×1.2+0.5
    // floors at 0.5 s, so a raw duration check can never exclude this case; gate on the distance itself.
    if (remaining <= 0.5) return false;
    // The reel runs all the way to the collar and eases off for the last metres, so the net gives its own time-to-go
    // (the apex distance alone under-counts the catch's seat and the slow tail)
    const eta = typeof net.reelEtaS === 'function' ? net.reelEtaS() : null;
    const estimate = (eta != null ? eta : remaining / reelSpeed) * 1.2 + 0.5;
    const duration = Math.min(estimate, NC.REEL_BEAT_MAX_S ?? 12.0);
    if (duration <= 0.25) return false;

    c.beats.push({
      key: 'REEL_IN',
      duration,
      fov: NC.REEL_BEAT_FOV ?? 42,
      timeScale: 1.0,                                    // never dilate the reel
      // Saturate the dolly-in early: otherwise the smoothstep eased across the beat's WHOLE duration (up to 12 s) and
      // the camera spent most of the reel mid-transit between the muzzle-side settle pose and the catch-framed hold.
      // With easeInS the camera arrives in ~2.5 s and HOLDS; the remaining motion is the winch itself.
      easeInS: NC.REEL_DOLLY_IN_S ?? 2.5,
    });
    c._reelBeatChained = true;
    // beatIndex == beats.length - 1 here (just incremented past the old last beat): point it at the new trailing beat.
    c.beatIndex = c.beats.length - 1;
    return true;
  }

  /**
   * NET_BERTHED handler: chain the PARK_HOLD beat off the REEL_IN beat. The catch PARKS at the nose instead of being
   * deleted, so the berth IS the payoff: do not release to the player cam here. The park hold is APPENDED (never a
   * same-index swap) so the lerp's prevKey is REEL_IN: both share the catch-framed pos/look formula, so
   * `lerpVectors(REEL_IN, PARK_HOLD, ease)` is position-exact at every ease and the camera holds rock-steady. A
   * same-index swap would leave prevKey = SECURED_SETTLE and reset ease to 0, snapping the camera ~5–7 m back to the
   * muzzle-side pose at the payoff frame.
   * The normal beat-advance then exits by the clock with completedNormally, so the first-deploy flag write is
   * preserved. Outside the reel beat this is a no-op (the berth can land after the beat's wall-clock cap released us,
   * or mid capture-beats on a close-range shot).
   * @private
   */
  _onNetBerthed(payload) {
    const c = this._netCeremony;
    if (!c.active) return;
    if (c.podIndex < 0 || c.podIndex !== payload.podIndex) return;
    const beat = c.beats[c.beatIndex];
    if (beat && beat.key === 'REEL_IN') {
      const NC = Constants.CAPTURE_NET.NET_CEREMONY;
      // A sub-metre catch digests fast (min-mass span 60 game-s ≈ 6 wall-s sunlit) and the fixed 4/6 s hold released the
      // camera as the chop started. Extend the hold through berth secure + digestion to CHOP END (+ pad) so the
      // deflate-and-fade lands INSIDE the held shot; capped (eclipse dilates the digest clock ×25: the cap is the
      // release valve, and the guard's `_digestedOut` check releases early whenever the feed finishes first). Repeat and
      // first-ever catches at/above the size gate keep the trimmed 4/6 s.
      let duration = c.isFirstEver ? (NC.PARK_HOLD_FIRST_S ?? 10.0) : (NC.PARK_HOLD_S ?? 5.0);
      const d = c._net?.targetDebris;
      const sizeGateM = NC.PARK_HOLD_DIGEST_MAX_SIZE_M ?? 0;
      // With no furnace (FURNACE_COOK off) there is no chop to wait for, so the hold stays the plain PARK_HOLD_FIRST_S /
      // PARK_HOLD_S; the lengthening below runs only while the cook is on.
      if (Constants.isFeatureEnabled('FURNACE_COOK') && d && typeof d.sizeMeter === 'number' && d.sizeMeter < sizeGateM) {
        const CN = Constants.CAPTURE_NET;
        const FT = Constants.FURNACE_TRANSFER;
        const chopEndS = (CN.BERTH_SECURE_S ?? 4.0)
          + (FT.CHOP_S / FT.FEED_S) * FT.digestSpanS(d.mass)
            / Math.max(1e-6, TimeAuthority.BASE_SCALE)
          + (NC.PARK_HOLD_DIGEST_PAD_S ?? 1.0);
        duration = Math.min(Math.max(duration, chopEndS), NC.PARK_HOLD_DIGEST_CAP_S ?? 12.0);
      }
      c.beats.push({
        key: 'PARK_HOLD',
        // First-ever mother catch holds longer: the first_net_park teaching moment (CATCH_PROCESSED { parked: true })
        // lands during it.
        duration,
        fov: NC.REEL_BEAT_FOV ?? 42,   // unchanged from REEL_IN: no FOV pop
        timeScale: 1.0,                // never dilate the berth hold
      });
      c.beatIndex = c.beats.length - 1;
      c.beatTimer = 0;
    }
  }

  /**
   * A beat's camera endpoint position (design doc §5.3). Writes into `out`; no allocation.
   * @private
   * @param {THREE.Vector3} out — pre-allocated output vector
   * @param {string} key — beat key or 'ARM_PILOT_START'
   */
  _netCeremonyBeatPos(out, key, armPos, netPos, debrisPos, fwd, side, localUp, D_M) {
    const M = 0.00001;
    switch (key) {
      case 'ARM_PILOT_START': {
        const apFwd = this._netCeremony._v3e;
        if (debrisPos.distanceToSquared(armPos) > 1e-20) {
          apFwd.subVectors(debrisPos, armPos).normalize();
        } else {
          apFwd.copy(fwd);
        }
        return out.copy(armPos)
          .addScaledVector(apFwd, -this.armPilot.offsetBehind)
          .addScaledVector(localUp, this.armPilot.offsetAbove);
      }
      case 'SECURED_SETTLE': {
        // OWN pose, side-on to the reel line (never on the catch↔muzzle axis: the lerp from the CINCH pose, 16 m beyond the
        // capture site, would run straight down the reel line and through the berthed bag). A fixed side/up offset can
        // never enter the bag cone; looking at the live catch (see _netCeremonyBeatLook) keeps the payoff framed: at berth
        // the catch rides ~6.5 m ahead of the muzzle (2.0 m standoff + ~4.5 m seat), so 6 m off-axis frames it large.
        return out.copy(armPos)
          .addScaledVector(side, 6 * M)
          .addScaledVector(localUp, 2.5 * M);
      }
      case 'POD_MUZZLE_PREFIRE':
        // Side profile off the boresight reads the arming device ON the nose (canister pop, disc spin-up and ship hull in
        // one composition): a pose just behind the muzzle sits INSIDE the spin-up cone's silhouette (the disc expands to
        // the full mouth diameter at the muzzle during SPINNING_UP), hiding the pod.
        return out.copy(armPos)
          .addScaledVector(side, 3.0 * M)
          .addScaledVector(fwd, -1.5 * M)
          .addScaledVector(localUp, 0.8 * M);
      case 'MUZZLE_EXIT_SPINUP':
        return out.copy(armPos)
          .addScaledVector(localUp, 1.0 * M)
          .addScaledVector(side, 2.5 * M);
      case 'GLAMOUR_SHOT':
        // D fractions: 1.5 (mouthR = 0.5 D, so distance/radius = 3.0×: hero-shot silhouette breathing room). The 3/4
        // rear-side pose (dead-astern puts the net exactly ON the camera→whale axis, hiding the whale) keeps ratio ≥ 3.0
        // while parallax separates net and whale from the first frame of the beat.
        return out.copy(netPos)
          .addScaledVector(fwd, -1.3 * D_M)
          .addScaledVector(side, 0.85 * D_M)
          .addScaledVector(localUp, 0.3 * D_M);
      case 'APPROACH_DOLLY':
        // 1.25 D fractions (ratio 2.5×: outside the cone wall).
        return out.copy(netPos)
          .addScaledVector(side, 1.25 * D_M);
      case 'BRAKE_ENVELOP':
        // CONTINUOUS netPos-tracking + apex-plane-breakout:
        // (1) NO cached `_beat5WorldPos` (CINCH-class regression test 11 in test-NetCinematic.js): the orbital frame
        //     translates >100 km/s, so any stale absolute anchor goes out of frame in <1 s.
        // (2) The camera MUST have a non-zero `fwd` component: a `side × 1.25 × D_M`-only offset sits in the apex plane
        //     (perpendicular to launchDir), and the ENVELOP rim weights (translating along the cone axis from z=−coneH,
        //     the mouth plane, to z=0, the apex plane) start atan(0.85D/1.25D) = 34.2° off the camera→apex axis: OUTSIDE
        //     the half-FOV-V of 19° at beat-5 FOV=38°, so they "pop in". Offset (side 1.5, fwd 0.6, up 0.5) × D_M is a 3/4
        //     elevated side view: distance/mouthR = √(2.25+0.36+0.25)/0.5 = 3.38× (well outside the cone surface), and
        //     the fwd component takes the camera off the apex plane so the weight sweep is seen obliquely.
        return out.copy(netPos)
          .addScaledVector(side, 1.5 * D_M)
          .addScaledVector(fwd, 0.6 * D_M)
          .addScaledVector(localUp, 0.5 * D_M);
      case 'CINCH':
        // Apex-plane-breakout, front-view framing: an offset perpendicular to launchDir (e.g. side 1.5, up −0.3) puts the
        // camera in the apex plane (the plane the CINCH_CLOSING weights spin in), so the ring is seen EDGE-ON: a
        // contracting line, not a closing drawstring spiral. fwd × 2.0 × D_M puts the camera AHEAD of the mouth, looking
        // back through the bag's open mouth at the apex plane, plus a small side component for parallax: the spiral
        // inward renders as a shrinking 2-D circle dead-centre. Distance/mouthR: √(0.4² + 2.0² + 0.4²)/0.5 = 4.16× (well
        // outside the cone).
        return out.copy(netPos)
          .addScaledVector(side, 0.4 * D_M)
          .addScaledVector(fwd, 2.0 * D_M)
          .addScaledVector(localUp, 0.4 * D_M);
      case 'REEL_IN':
      case 'PARK_HOLD': {
        // Frame THE CATCH, mother as context: hold ~8–12 m off the LIVE catch, side/up off the reel line (never on the
        // catch↔muzzle axis), scaled by the catch so a 7 m whale still fits. The mother grows into frame as the catch
        // closes; at berth/park the payoff is the catch AT the nose, large. REEL_IN and PARK_HOLD share the formula so the
        // NET_BERTHED chain is seamless (identical pos + look, no camera jump). up 0.34 / side 0.94 is unit-norm, so the
        // hold distance is exactly holdM (the S4 test contract); the flat profile puts the nose in frame from the first
        // held frame. The hold tracks the DRAWN BUNDLE, not just the logical size: `2 × sizeM` read 1 m for a 0.5 m
        // fragment while the readability floor draws that catch at 2.0 m radius (net.heldBundleRadiusM). The bundle term
        // holds HOLD_BUNDLE_FRAME_K = 4 bundle-radii off (the bundle's diameter subtends 2·atan(1/4) ≈ 28° of the 42°
        // beat FOV). The [8, 12] clamp: the floor equals 4 × MOTHER_CATCH_MIN_RENDER_M (2.0 m), the smallest bundle the
        // reel/park can draw, so a 2 m whale and a sub-metre fragment both hold at exactly 8 m. Headless mocks without
        // the accessor fall back to the sizeM-only term (bundle 0).
        const sizeM = this._netCeremony._net?.targetDebris?.sizeMeter || 2;
        const bundleRM = (typeof this._netCeremony._net?.heldBundleRadiusM === 'function')
          ? (this._netCeremony._net.heldBundleRadiusM() || 0) : 0;
        const K_BUNDLE = Constants.CAPTURE_NET.NET_CEREMONY.HOLD_BUNDLE_FRAME_K ?? 4;
        const holdM = Math.min(Math.max(Math.max(2 * sizeM, K_BUNDLE * bundleRM), 8), 12);
        return out.copy(debrisPos)
          .addScaledVector(side, holdM * M * 0.94)
          .addScaledVector(localUp, holdM * M * 0.34);
      }
      default:
        return out.copy(armPos);
    }
  }

  /** A beat's lookAt target. Writes into `out`; no allocation. @private */
  _netCeremonyBeatLook(out, key, armPos, netPos, debrisPos, fwd, D_M) {
    switch (key) {
      case 'ARM_PILOT_START':
      case 'SECURED_SETTLE':
      case 'GLAMOUR_SHOT':
        return out.copy(debrisPos);
      case 'POD_MUZZLE_PREFIRE':
        return out.copy(armPos);
      case 'MUZZLE_EXIT_SPINUP':
        return out.copy(netPos);
      case 'BRAKE_ENVELOP':
        // Look at the cone midpoint (apex + fwd × coneH/2), not the apex: the ENVELOP animation occupies the full cone
        // length (weights translate from mouth plane to apex plane), and centring on the apex pushes the FROM-end of the
        // sweep (mouth plane) outside the FOV; the midpoint balances both ends in frame.
        // coneH = D × CONE_LENGTH_FRAC × CONE_OPEN_RADIUS_FRAC; CONE_LENGTH_FRAC 0.85 puts the midpoint at 0.425 × D.
        return out.copy(netPos).addScaledVector(fwd, 0.425 * (D_M ?? 0));
      case 'CINCH':
        // Look at the CINCH ring, which contracts at the MOUTH plane (local z=-coneHeight). CONE_LENGTH_FRAC 0.85 makes
        // coneH = 0.85 × D, so the ring sits 0.35 × D past the target (2.8 m for LARGE D=8), safely past the debris's
        // leading edge (the ring must not cinch THROUGH the debris's middle). This look-at value = CONE_LENGTH_FRAC ×
        // CONE_OPEN_RADIUS_FRAC × D_M and MUST stay in sync with Constants.CAPTURE_NET.NET_CEREMONY.CONE_LENGTH_FRAC.
        return out.copy(netPos).addScaledVector(fwd, 0.85 * (D_M ?? 0));
      case 'APPROACH_DOLLY':
        return out.copy(netPos).add(debrisPos).multiplyScalar(0.5);
      case 'REEL_IN':
      case 'PARK_HOLD': {
        // Track the incoming catch biased 0.45 toward the muzzle, so the berth destination stays in frame as it closes;
        // shared with PARK_HOLD so the berth chain has no look-target jump. CLAMPED to ≤ 4.5 m from the catch: an
        // unclamped bias aimed ~9 m off the catch at reel start (20 m separation), atan(9/8) ≈ 48° off the hold axis, past
        // the 42°-FOV horizontal half-angle (~31.5° at 16:10). 4.5 m keeps the catch in frame at the 8 m hold (atan(4.5/8)
        // ≈ 29°) and the 12 m hold (≈ 21°); inside ~10 m separation the 0.45 fraction takes over and frames catch + nose.
        const toMuzzle = this._netCeremony._v3e.copy(armPos).sub(debrisPos);
        const dist = toMuzzle.length();
        const M_LOOK = 0.00001;
        const f = dist > 1e-12 ? Math.min(0.45, (4.5 * M_LOOK) / dist) : 0.45;
        return out.copy(debrisPos).addScaledVector(toMuzzle, f);
      }
      default:
        return out.copy(armPos);
    }
  }

  /**
   * Net scene position into c._scratchNetPos. No allocation. Daughter: arm position + launchDirection ×
   * distanceTraveled (the arm is the flight anchor). Mother: the net's own live position × M (the mother reel/berth
   * writes net.position in metres every frame from the ship-relative pin, which IS the correct scene anchor; the
   * flight phase reads the same field via the anchor provider).
   * @private
   */
  _computeNetScenePos(c) {
    const M = 0.00001;
    const net = c._net ?? (c.podIndex >= 0
      ? (captureNetSystem.getActiveNetForPod ? captureNetSystem.getActiveNetForPod(c.podIndex) : null)
      : captureNetSystem.getActiveNetForArm(c.armIndex));
    if (net && c.podIndex >= 0 && net.position) {
      c._scratchNetPos.set(net.position.x * M, net.position.y * M, net.position.z * M);
    } else if (net && net._sourceArm?.position) {
      const ap = net._sourceArm.position;
      c._scratchNetPos.set(
        ap.x + net.launchDirection.x * net.distanceTraveled * M,
        ap.y + net.launchDirection.y * net.distanceTraveled * M,
        ap.z + net.launchDirection.z * net.distanceTraveled * M
      );
    } else if (c._launcher && c._launcher.getPos(c._scratchNetPos)) {
    } else {
      c._scratchNetPos.set(0, 0, 0);
    }
  }

  /**
   * Per-frame net ceremony beat update. Returns { pos, look, up } or null.
   * All returned vectors are pre-allocated ceremony scratch — caller must
   * copy them immediately (same pattern as _updateLaunchCeremony).
   * @private
   */
  _updateNetCeremony(dt, playerPos, velDir, radialDir, playerQuat) {
    const c = this._netCeremony;

    c.beatTimer += dt;
    let beat = c.beats[c.beatIndex];

    // Subject-death guard: a ceremony must never keep lerping beats over a net that has been consumed/deactivated
    // (Kessler kill mid-flight, teardown, release). Keys on `isActive === false` EXPLICITLY (headless beat mocks without
    // the field stay served: undefined is not false, and the FLIGHT-control pin keeps this from becoming a blanket
    // refusal). A digested-out subject is the one COMPLETED payoff (like the PARK_HOLD `_digestedOut` release below, which
    // remains for the spliced-net case where isActive never flips); everything else is a truncation. A DELIVERED
    // hand-off is the other completed payoff: the mother-path arrival sets `isActive = false` + `_cargoDelivered = true`
    // (CaptureNet S7), which must not read as a subject death (it would truncate the first catch's exit, so
    // FIRST_MOTHER_NET_DEPLOY never fires and the long first-catch ceremony replays on every mother catch).
    if (beat && c._net && c._net.isActive === false) {
      this._exitNetCeremony(c._net._digestedOut === true || c._net._cargoDelivered === true);
      return null;
    }

    // REEL_IN guard: the beat ends the frame the net leaves REELING for any reason other than the berth (NET_BERTHED
    // covers that); a mid-reel miss (dead target, strain slip) does NOT re-emit NET_CEREMONY_COMPLETE (already spent at
    // CAPTURED), so poll the state.
    if (beat && beat.key === 'REEL_IN' && c._net && c._net.state !== 'REELING') {
      this._exitNetCeremony(false);
      return null;
    }

    // The park hold lives in BERTHED/COLLARED: a jettison [K] or a dead-target teardown ends it the frame the hold
    // breaks (same idiom as the REEL_IN guard above); the terminal state is the collar mate. `_digestedOut` releases
    // too: the spliced net keeps its stale COLLARED state forever, so a hold extended through digestion (sub-metre
    // catches) would otherwise sit out its full clock over a consumed body. completedNormally: the whole ceremony
    // played and the payoff finished on camera, a clean cut, not a truncation. `_cargoDelivered` releases the same way
    // (belt-and-braces with the subject-death guard: a reader holding the reference before the splice sees the marker
    // first).
    if (beat && beat.key === 'PARK_HOLD' && c._net
        && (c._net._digestedOut === true || c._net._cargoDelivered === true)) {
      this._exitNetCeremony(true);
      return null;
    }
    // TRANSFERRING keeps serving the hold, like COLLARED: the cargo hand-off IS the payoff continuing (the nose-collar
    // crane to a daughter rack, CaptureNet S7), and the bag leaving the collar must not cut the shot the frame the
    // catch departs. The PARK_HOLD pos/look formulas already track the live pin, which the transfer rewrites every
    // frame. Any OTHER state out of the hold (RELEASED, jettison, teardown, STOWED) still truncates; an aborted
    // transfer returns to COLLARED, which stays served.
    if (beat && beat.key === 'PARK_HOLD' && c._net
        && c._net.state !== 'BERTHED' && c._net.state !== 'COLLARED'
        && c._net.state !== 'TRANSFERRING') {
      this._exitNetCeremony(false);
      return null;
    }

    // FIRST-EVER hold only: when the cargo hand-off starts under the hold, stretch the beat so it can end ON the
    // landing (+ PARK_HOLD_DIGEST_PAD_S), capped at PARK_HOLD_DIGEST_CAP_S from hold start. Repeat holds are NEVER
    // stretched (no cutscene the player sees every time): a repeat hold that runs out mid-flight ends on its own clock
    // via the normal beat-advance exit. Polled, not evented: the transfer clock (_cargoS/_cargoDur) is live net state,
    // read like `state` above. Idempotent while the flight runs (beatTimer and the remaining flight advance 1:1 at the
    // hold's 1.0× timeScale), and a re-crane after an abort simply stretches to the new landing.
    if (beat && beat.key === 'PARK_HOLD' && c.isFirstEver && c._net
        && c._net.state === 'TRANSFERRING'
        && typeof c._net._cargoDur === 'number') {
      const NC = Constants.CAPTURE_NET.NET_CEREMONY;
      const remainingS = Math.max(0, c._net._cargoDur - (c._net._cargoS || 0));
      const endS = Math.min(
        c.beatTimer + remainingS + (NC.PARK_HOLD_DIGEST_PAD_S ?? 1.0),
        NC.PARK_HOLD_DIGEST_CAP_S ?? 12.0);
      if (endS > beat.duration) beat.duration = endS;
    }

    if (c.beatTimer >= beat.duration) {
      c.beatTimer -= beat.duration;
      c.beatIndex++;
      if (c.beatIndex >= c.beats.length) {
        // Chain into the REEL_IN beat instead of exiting when a mother catch is mid-reel (3/4 view of mother + incoming
        // catch, released at berth or the wall-clock cap). Daughter catches exit here.
        if (this._tryChainReelBeat(c)) {
          beat = c.beats[c.beatIndex];
        } else {
          this._exitNetCeremony(true);
          return null;
        }
      } else {
        beat = c.beats[c.beatIndex];
      }
    }

    // Publish the active beat's physics time-scale (archive/CEREMONY_REDESIGN.md §5.1), re-asserted every served frame
    // so it is the single source of truth for the beat scale in this method. Idempotent (same value, same owner) and
    // self-healing: if the pause path (or any owner-scoped reset) cleared it, the first frame after resume restores it,
    // while the exit/abort paths clear it for good. (The ceremony-start set in _onNetCeremonyStart stays: it must run
    // inside the synchronous NET_CEREMONY_START handler, before the projectile's next tick.)
    CeremonyTimeScale.set(beat.timeScale ?? 1.0, this);

    const t = c.beatTimer / (beat.easeInS
      ? Math.min(beat.easeInS, beat.duration)
      : beat.duration);
    const tc = Math.min(1, t);
    const ease = smoothstep01(tc); // smoothstep, saturates at easeInS when set

    // Launcher anchor: arm.position for daughter, the live pod muzzle for mother. Polled every frame: the pod rides the
    // ship, and a stale absolute anchor drifts ~45 km apparent in 0.65 s.
    if (!c._launcher) {
      this._exitNetCeremony(false);
      return null;
    }
    const armPos = c._launcher.getPos(c._scratchLauncherPos);
    if (!armPos) {
      this._exitNetCeremony(false);
      return null;
    }

    this._computeNetScenePos(c);
    const netPos = c._scratchNetPos;
    const fwd = c._launchFwd;
    const side = c._sideDir;
    const D_M = c._netDiameterScene;

    // Debris scene position (into c._v3d), live on both paths (the debris keeps propagating while pinned).
    const debrisPos = c._v3d;
    if (!c._launcher.getDebrisPos(debrisPos)) {
      debrisPos.copy(armPos).addScaledVector(fwd, 0.0005);
    }

    // Local up (radial at arm, orthogonalized against fwd)
    const localUp = c._v3c;
    localUp.copy(armPos).normalize();
    const upDot = localUp.dot(fwd);
    if (Math.abs(upDot) < 0.999) {
      localUp.addScaledVector(fwd, -upDot).normalize();
    }

    const prevKey = c.beatIndex > 0 ? c.beats[c.beatIndex - 1].key : 'ARM_PILOT_START';
    this._netCeremonyBeatPos(this._tmpVecA, prevKey, armPos, netPos, debrisPos, fwd, side, localUp, D_M);
    this._netCeremonyBeatPos(this._tmpVecB, beat.key, armPos, netPos, debrisPos, fwd, side, localUp, D_M);

    // Output position (lerpVectors reads A,B then writes into _v3a — safe)
    const pos = c._v3a;
    pos.lerpVectors(this._tmpVecA, this._tmpVecB, ease);

    this._netCeremonyBeatLook(this._tmpVecA, prevKey, armPos, netPos, debrisPos, fwd, D_M);
    this._netCeremonyBeatLook(this._tmpVecB, beat.key, armPos, netPos, debrisPos, fwd, D_M);

    const look = c._v3b;
    look.lerpVectors(this._tmpVecA, this._tmpVecB, ease);

    const prevFov = c.beatIndex > 0 ? c.beats[c.beatIndex - 1].fov : c.savedFov;
    this._baseFov = lerp(prevFov, beat.fov, ease);
    this.camera.fov = this._baseFov;
    this.camera.near = 0.000001; // ~0.1m (tight framing)
    this.camera.updateProjectionMatrix();

    return { pos, look, up: localUp };
  }

  /**
   * End a QUIET net ceremony (one started while the zoom ladder owned the camera): clear its state and give the net its
   * full speed back. Deliberately NOT the cinematic exit: it never took a view, so it restores no view, FOV or near
   * plane (the ladder owns all three), writes no first-deploy flag and emits no NET_CINEMATIC_EXITED (its ENTERED was
   * never sent: the pair stays balanced).
   * @private
   */
  _endQuietNetCeremony() {
    const c = this._netCeremony;
    if (!c.active) return;
    c.active = false;
    c._quiet = false;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = [];
    c.arm = null;
    c._launcher = null;
    c._reelBeatChained = false;
    c._net = null;
    c.success = null;
    CeremonyTimeScale.reset();
  }

  /**
   * Per-frame guard for a quiet ceremony: nothing advances it, so it must end by itself if the ladder lets go of the
   * camera (its beats would then pull the camera to beat anchors it never entered), the net is gone without a COMPLETE
   * (a release mid-flight), or a safety cap passes.
   * @private
   */
  _tickQuietNetCeremony(dt) {
    const c = this._netCeremony;
    c.beatTimer += dt;
    if (!this._ladderCam.active
        || (c._net && c._net.isActive === false)
        || c.beatTimer > QUIET_CEREMONY_MAX_S) {
      this._endQuietNetCeremony();
    }
  }

  /**
   * Abort an active net ceremony WITHOUT routing through setView(prevView). Used by setView() when an external view
   * change is requested mid-ceremony; the new view is set by setView's normal flow, so this only undoes ceremony
   * side-effects (FOV, state, time-scale). FIRST_NET_DEPLOY is intentionally NOT written: abort ≠ normal completion.
   * @private
   */
  _abortNetCeremony() {
    const c = this._netCeremony;
    if (!c.active) return;
    if (c._quiet) { this._endQuietNetCeremony(); return; }

    this._baseFov = c.savedFov;
    this.camera.fov = c.savedFov;
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();

    c.active = false;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = [];
    c.arm = null;
    c._launcher = null;
    c._reelBeatChained = false;
    c._net = null;
    c.success = null;

    // Clear ceremony time-scale (world dt back to 1.0×, §6 R1)
    CeremonyTimeScale.reset();

    // Cinema-dim contract: the abort path leaves the cinematic too (setView's normal flow takes over): the HUD must
    // un-dim on every exit route.
    eventBus.emit(Events.NET_CINEMATIC_EXITED, { completedNormally: false });
  }

  /**
   * Exit net ceremony — restore previous view and FOV.
   * @private
   * @param {boolean} completedNormally — true if all beats played, false on truncation/miss
   */
  _exitNetCeremony(completedNormally) {
    const c = this._netCeremony;
    if (!c.active) return;
    if (c._quiet) { this._endQuietNetCeremony(); return; }

    // Capture the subject's size BEFORE the state is cleared below: the exit over a sub-metre bundle cuts in
    // EXIT_CUT_SMALL_S instead of easing 0.5 s across a frame whose subject was just consumed. One-shot: the update
    // loop restores the default when the transition completes. Gate shared with the park-hold digest extension.
    const NCx = Constants.CAPTURE_NET.NET_CEREMONY;
    const exitSizeM = c._net?.targetDebris?.sizeMeter;
    const smallExit = typeof exitSizeM === 'number'
      && exitSizeM < (NCx.PARK_HOLD_DIGEST_MAX_SIZE_M ?? 0);

    // Set the first-deploy flag at the end of the first-ever SUCCESSFUL ceremony. The mother path writes its own flag
    // so a first whale catch after a daughter deploy still gets the full beat list. NOTE: the flag must also be listed
    // in PersistenceManager.save()'s ceremonyFlags WHITELIST: GameFlowManager's saveGame() passthrough only forwards
    // flags that already survived that whitelist, so the whitelist entry is what actually makes this persist.
    if (completedNormally && c.isFirstEver && c.success !== false) {
      persistenceManager.setCeremonyFlag(
        c.podIndex >= 0 ? 'FIRST_MOTHER_NET_DEPLOY' : 'FIRST_NET_DEPLOY', true);
    }

    this._baseFov = c.savedFov;
    this.camera.fov = c.savedFov;
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();

    const prevView = c.savedView || CameraViews.ARM_PILOT;

    c.active = false;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = [];
    c.arm = null;
    c._launcher = null;
    c._reelBeatChained = false;
    c._net = null;
    c.success = null;

    // Clear ceremony time-scale (world dt back to 1.0×, §6 R1)
    CeremonyTimeScale.reset();

    // Cinema-dim contract: paired with NET_CINEMATIC_ENTERED; every exit route (beats done, miss truncation, skip)
    // un-dims the HUD.
    eventBus.emit(Events.NET_CINEMATIC_EXITED, { completedNormally });

    if (smallExit) this._transitionDuration = NCx.EXIT_CUT_SMALL_S ?? this._transitionDurationDefault;
    this.setView(prevView);
  }

  /**
   * Public skip for the net ceremony (every beat, REEL_IN included, must be skippable, like `skipLaunchCeremony`).
   * Routes through `_exitNetCeremony(false)` so the saved view is restored and `CeremonyTimeScale.reset()` runs (world
   * dt back to 1.0×, §6 R1). No-op when no ceremony is active.
   * @returns {boolean} true if a ceremony was skipped
   */
  skipNetCeremony() {
    // The same keys (Esc / Space / Enter) also end a catch focus, which is what is on screen under the ladder
    const focus = this.ladderCancelCatchFocus('skip key');
    if (!this._netCeremony.active) return focus;
    this._exitNetCeremony(false);
    return true;
  }


  /** Wire the LassoSystem (main.js) — the cut reads the live cast state. */
  setLassoSystem(lassoSystem) {
    this._lassoSystem = lassoSystem;
  }

  /** Wire the held-input probe (main.js → InputManager.anyKeyHeld). */
  setLassoCutInputProbe(probe) {
    this._lassoCutInputProbe = (typeof probe === 'function') ? probe : null;
  }

  /** True while the lasso catch cut owns the camera (InputManager reads this). */
  lassoCutActive() {
    return !!(this._lassoCut && this._lassoCut.active);
  }

  /**
   * Instant abort: ANY player input routes here (keydown via InputManager, mouse button / wheel via this system's own
   * handlers). The input is never eaten: the cut steps aside and the action proceeds.
   * @returns {boolean} true if a cut was aborted
   */
  abortLassoCut() {
    if (!this._lassoCut.active) return false;
    this._exitLassoCut(false);
    return true;
  }

  /**
   * LASSO_CONTACT: enter the cut if, and only if, every guard agrees: flags on, no other cinematic owns the camera,
   * motion is welcome (prefers-reduced-motion skips), and the player is not actively piloting (a held key produces no
   * new keydown, so the any-input abort alone could not protect that player). Entry is a hard cut (direct view
   * assignment, the ceremony idiom at _onNetCeremonyStart); exit eases over EXIT_CUT_SMALL_S.
   * NET_CINEMATIC_ENTERED/EXITED stay paired on every route so the HUD dim contract holds.
   * The attempt is factored out so a TRANSIENT subject-sanity refusal (a ghost/out-of-range `_scenePosition` read, a
   * degenerate reel line) can RETRY on the next camera frames, with the camera update's own same-frame ship position,
   * instead of skipping the whole cut. Policy refusals still answer once.
   * @private
   */
  _onLassoContact() {
    const verdict = this._tryEnterLassoCut(this._lastPlayerPos);
    const lc = this._lassoCut;
    if (verdict === 'transient') {
      const ls = this._lassoSystem;
      lc.pendingDebris = (ls && ls.target) || null;
    } else {
      lc.pendingDebris = null;
    }
  }

  /**
   * One entry attempt against the given ship position (the event path passes the cached `_lastPlayerPos`; the
   * per-frame retry passes the live one).
   * @returns {('entered'|'refused'|'transient')} — 'transient' means the subject exists but its geometry read insane
   *   THIS attempt; retry.
   * @private
   */
  _tryEnterLassoCut(shipPos) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return 'refused';
    if (!Constants.FEATURE_FLAGS.LASSO_CATCH_CUT) return 'refused';
    const lc = this._lassoCut;
    if (lc.active) return 'refused';
    // Under the zoom ladder the lasso cut's camera never shows (the ladder drives the frame), so entering would only
    // leave a NET_CINEMATIC ghost view and a cut nothing advances. The lasso keeps its slow reel; the ladder camera
    // stays where the player holds it.
    if (this._ladderCam.active) return 'refused';
    if (this._netCeremony.active || this._launchCeremony.active) return 'refused';
    if (this.currentView === CameraViews.NET_CINEMATIC) return 'refused';
    if (this._prefersReducedMotion()) return 'refused';
    if (this._lassoCutInputProbe && this._lassoCutInputProbe()) return 'refused';
    const ls = this._lassoSystem;
    const debris = ls && ls.active && ls._reelingIn ? ls.target : null;
    if (!debris) return 'refused';
    if (!debris._scenePosition || !shipPos) return 'transient';

    // Fixed side axis: perpendicular to the reel line in the radial frame at entry (never on the catch↔ship axis;
    // stable for the whole shot so the escort reads as one held camera, not a chase).
    const catchPos = lc._vCatch.copy(debris._scenePosition);
    // Entry twin of the 250 m in-shot sanity fence: a lasso subject lives within LASSO_RANGE of the ship, so a farther
    // read at entry is a stale/ghost frame, not a subject. Classified TRANSIENT: the reel is live and next frame's read
    // is fresh.
    if (catchPos.distanceTo(shipPos) > 250 * 0.00001) return 'transient';
    const reelDir = lc._vLook.copy(shipPos).sub(catchPos);
    if (reelDir.lengthSq() < 1e-18) return 'transient';
    reelDir.normalize();
    const radial = lc._vUp.copy(catchPos).normalize();
    lc._sideDir.crossVectors(radial, reelDir);
    if (lc._sideDir.lengthSq() < 1e-6) {
      // Degenerate (catch on the radial line) — any perpendicular will do.
      lc._sideDir.set(reelDir.z, 0, -reelDir.x);
      if (lc._sideDir.lengthSq() < 1e-6) lc._sideDir.set(0, 1, 0);
    }
    lc._sideDir.normalize();

    lc.active = true;
    lc.t = 0;
    lc.settleT = null;
    lc.debris = debris;
    lc.pendingDebris = null;
    lc.savedView = this.currentView;
    lc.savedFov = this._baseFov;
    this.currentView = CameraViews.NET_CINEMATIC;   // hard cut (ceremony idiom)
    eventBus.emit(Events.NET_CINEMATIC_ENTERED, { lassoCut: true });
    return 'entered';
  }

  /**
   * Per-frame driver for the cut: TWO shots.
   *   1. WRAP close-up: catch-anchored hold while the wrap cinches (the piece is stationary through the wrap window, so
   *      nothing translates but fabric);
   *   2. hard cut to the ARRIVAL shot: SHIP-anchored at LASSO_CUT_ARRIVAL_HOLD_M with the nose steady in frame while the
   *      PIECE flies in (riding the catch for the whole escort made the converging ship read as "mother moving to
   *      debris", owner report; a ship-rigid vantage makes the causality unambiguous).
   * Unit-norm (side 0.94, up 0.34) offset, look at the catch biased ≤ 4.5 m toward the ship. Release: the reel resolves
   * (the lasso hands the pin to the adoption) + LASSO_CUT_SETTLE_S, or LASSO_CUT_MAX_S: both completed payoffs, both
   * before digestion (berth-secure is 4 s away at adoption). A dead subject or a dropped pin exits as a truncation.
   * @private
   */
  _updateLassoCut(dt, playerPos) {
    const lc = this._lassoCut;
    const NCx = Constants.CAPTURE_NET.NET_CEREMONY;
    lc.t += dt;

    const debris = lc.debris;
    if (!debris || debris.alive === false || !debris._scenePosition) {
      this._exitLassoCut(false, true);
      return null;
    }
    if (lc.t >= (NCx.LASSO_CUT_MAX_S ?? 4.0)) {
      this._exitLassoCut(true, true);
      return null;
    }
    const ls = this._lassoSystem;
    const reelLive = !!(ls && ls.active && ls.target === debris);
    if (!reelLive) {
      // The reel resolved this catch (adoption/pending owns the pin now) or dropped it. A held pin is the completed
      // read; a released pin means the catch was lost between the event aborts and this frame.
      if (debris._armPinned !== true) {
        this._exitLassoCut(false, true);
        return null;
      }
      lc.settleT = (lc.settleT ?? 0) + dt;
      if (lc.settleT >= (NCx.LASSO_CUT_SETTLE_S ?? 0.4)) {
        this._exitLassoCut(true, true);
        return null;
      }
    }

    const M_CUT = 0.00001;
    const catchPos = lc._vCatch.copy(debris._scenePosition);
    // Sanity fence: a lasso subject lives within lasso range of the ship (fire() refuses beyond LASSO_RANGE; the reel
    // only pulls INWARD). If the scene position reads outside ~250 m, hand the camera back gracefully instead of
    // framing empty space. Ghost reads are fixed at the source (the lasso pin is same-frame, LassoSystem._pinFresh), so
    // this is a last resort; it exits with the epoch rebase like every other in-update exit.
    if (catchPos.distanceTo(playerPos) > 250 * M_CUT) {
      this._exitLassoCut(true, true);
      return null;
    }
    // Shot switch: the wrap is done when the reel passes the WRAP window (reelProgress ≥ 0.2), the reel already
    // resolved, or (mocks without a progress field) a 1.2 s fallback (the real wrap is ~0.6 s).
    const wrapDone = (ls && typeof ls._reelProgress === 'number' && ls._reelProgress >= 0.2)
      || !reelLive || lc.t >= 1.2;

    if (!wrapDone) {
      const sizeM = debris.sizeMeter || 2;
      const bundleFloorM = Constants.MOTHER_CATCH_MIN_RENDER_M ?? 1.5;
      const K_BUNDLE = NCx.HOLD_BUNDLE_FRAME_K ?? 4;
      const bundleRM = Math.max(bundleFloorM, sizeM / 2);
      const holdM = Math.min(Math.max(Math.max(2 * sizeM, K_BUNDLE * bundleRM), 8), 12);

      const up = lc._vUp.copy(catchPos).normalize();
      const side = lc._vSide.copy(lc._sideDir).addScaledVector(up, -lc._sideDir.dot(up));
      if (side.lengthSq() < 1e-9) side.copy(lc._sideDir);
      side.normalize();

      const pos = lc._vPos.copy(catchPos)
        .addScaledVector(side, holdM * M_CUT * 0.94)
        .addScaledVector(up, holdM * M_CUT * 0.34);

      const toShip = lc._vLook.copy(playerPos).sub(catchPos);
      const dist = toShip.length();
      const f = dist > 1e-12 ? Math.min(0.45, (4.5 * M_CUT) / dist) : 0.45;
      const look = toShip.multiplyScalar(f).add(catchPos);   // catch + toShip·f, in place

      return { pos, look, up };
    }

    const holdM = NCx.LASSO_CUT_ARRIVAL_HOLD_M ?? 9.0;
    const up = lc._vUp.copy(playerPos).normalize();
    const side = lc._vSide.copy(lc._sideDir).addScaledVector(up, -lc._sideDir.dot(up));
    if (side.lengthSq() < 1e-9) side.copy(lc._sideDir);
    side.normalize();

    const pos = lc._vPos.copy(playerPos)
      .addScaledVector(side, holdM * M_CUT * 0.94)
      .addScaledVector(up, holdM * M_CUT * 0.34);

    const toShip = lc._vLook.copy(playerPos).sub(catchPos);
    const dist = toShip.length();
    const f = dist > 1e-12 ? Math.min(0.45, (4.5 * M_CUT) / dist) : 0.45;
    const look = toShip.multiplyScalar(f).add(catchPos);     // catch-dominant, nose in frame

    return { pos, look, up };
  }

  /**
   * Leave the cut: restore FOV + view, un-dim the HUD. Mirrors _exitNetCeremony's contract in miniature: `active`
   * clears BEFORE the setView call (no recursion through the setView abort hook), the exit transition is the sub-metre
   * cut (every lasso subject is sub-metre class), and NET_CINEMATIC_EXITED fires on every route.
   * @param {boolean} [rebaseEpoch=false] — true for exits taken INSIDE update() (fence / valve / settle / dropped
   *   subject), where `_lastPlayerPos` already holds THIS frame's ship but the camera still holds LAST frame's pose. The
   *   camera is shifted by the ship's one-frame travel so setView captures a ship-relative start offset instead of a
   *   cross-epoch difference (~128 m at 60 fps, km-scale under the SwiftShader dt clamp). Event-driven aborts (keydown /
   *   wheel / external setView) run between frames where both epochs already agree: they keep the default false.
   * @private
   */
  _exitLassoCut(completedNormally, rebaseEpoch = false) {
    const lc = this._lassoCut;
    if (!lc.active) return;

    lc.active = false;
    lc.debris = null;
    lc.settleT = null;
    lc.pendingDebris = null;

    if (rebaseEpoch && this._prevPlayerPosInit) {
      this.camera.position.sub(this._prevPlayerPos).add(this._lastPlayerPos);
    }

    this._baseFov = lc.savedFov || this._baseFov;
    this.camera.fov = this._baseFov;
    this.camera.updateProjectionMatrix();

    const prevView = lc.savedView || CameraViews.CHASE;
    lc.savedView = null;

    eventBus.emit(Events.NET_CINEMATIC_EXITED, { completedNormally: !!completedNormally });

    const NCx = Constants.CAPTURE_NET.NET_CEREMONY;
    // One-shot short cut: the update loop restores the default duration when the transition completes.
    this._transitionDuration = NCx.EXIT_CUT_SMALL_S ?? this._transitionDurationDefault;
    this.setView(prevView);
  }

  /**
   * Enter INSPECTION mode: narrow FOV, close-range orbit around the spacecraft, plus a contextual wireframe overlay
   * (mother / debris / daughter). The single entry point for the discrete inspection view: emits INSPECTION_TOGGLE
   * exactly once so the wireframe panels show, then transitions optics. Reached via the legacy bare-I /
   * toggleInspection() path (the V cycle no longer routes here; close inspection engages as a LOOK AROUND zoom
   * sub-state instead).
   * @param {('mother'|'debris'|'daughter')} [subject='mother'] overlay to focus.
   * @param {number|null} [targetId=null] debris id (for the 'debris' subject).
   */
  enterInspection(subject = 'mother', targetId = null) {
    if (this.currentView === CameraViews.INSPECTION) return;

    if (this.currentView === CameraViews.ORBIT) {
      this.inspection.theta = this.orbit.theta;
      this.inspection.phi = this.orbit.phi;
      this.inspection.distance = Math.min(this.orbit.distance, this.inspection.maxDistance);
    }

    this.inspection.savedFov = this._baseFov;
    this._fovBreathOffset = 0;
    this._fovBreathTarget = 0;
    this._fovBreathTimer = 0;

    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.inspection.fov;

    this._inspectSubject = subject;

    this.setView(CameraViews.INSPECTION);

    eventBus.emit(Events.INSPECTION_TOGGLE, { subject, targetId });

    console.log(`[CameraSystem] Inspection mode (${subject}). Zoom 2–50m, FOV 35°`);
  }

  /**
   * Guarded for the Node test runner (no window/matchMedia). Skips motion-heavy feedback (the whale-tug micro-shake) for
   * users who opt out of motion. Mirrors GameFlowManager._prefersReducedMotion.
   * @private
   */
  _prefersReducedMotion() {
    try {
      return !!(typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_e) {
      return false;
    }
  }

  /**
   * Exit INSPECTION mode: restore FOV/near plane, hide the overlay, return to the requested view.
   * @param {string} [returnTo] a CameraViews value; falls back to _previousView then CHASE. cycleView() passes CHASE so
   *   V from inspection wraps to FLY.
   */
  exitInspection(returnTo) {
    if (this.currentView !== CameraViews.INSPECTION) return;

    this.orbit.theta = this.inspection.theta;
    this.orbit.phi = this.inspection.phi;

    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.inspection.savedFov || Constants.CAMERA_FOV;

    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();

    eventBus.emit(Events.INSPECTION_TOGGLE, { subject: this._inspectSubject || 'mother' });
    this._inspectSubject = null;

    // Default return view: bare-I / ESC fall back to the prior view (usually FLY); cycleView() passes CHASE explicitly.
    const dest = returnTo || this._previousView || CameraViews.CHASE;
    this.setView(dest);
  }

  /**
   * Start the menu→sim intro settle: chase offset snaps to INTRO_START_SCALE, then eases straight back to 1.0 (no dead
   * hold). Call on first ORBITAL_VIEW entry of a new game; callers skip it under reduced motion or when the departure
   * was skipped (leave the scale at 1.0), see GameFlowManager.
   */
  startIntroZoom() {
    this._introScale = Constants.EARTH.INTRO_START_SCALE;
  }

  /** Force the intro settle to its end state (scale 1.0) when the player skips the menu departure. */
  skipIntroZoom() {
    this._introScale = 1.0;
  }

  /** ARM_PILOT camera: follows the arm, looking toward the target. @private */
  _computeArmPilot(dt, playerPos, velDir, radialDir) {
    const arm = this.armPilot.arm;
    if (!arm || !arm.position) {
      return this._computeChase(dt, playerPos, velDir, radialDir);
    }

    const armPos = arm.position.clone();

    // STATION_KEEP: inspection-mode framing. The camera stays in its standard ARM_PILOT position (5 m behind + 1.6 m
    // above the daughter) and looks AT the debris. The daughter moves around the debris on a θ/φ/R sphere with the arrow
    // keys; the camera is rigidly attached behind her, so sweeping her around the sphere sweeps the camera too, exposing
    // the debris from every angle. Layout: [camera] → [daughter (foreground)] → [debris (centered)]; the tether trails
    // back past the camera toward the mothership.
    // KEY DIFFERENCE from the non-SK branch: that one sets look = arm + fwd × 100 m (a phantom point past the daughter),
    // so the debris drifts through the frame as she advances toward/past it. Here the look-target is the LIVE debris
    // position, so the debris is locked in screen space and her circumnavigation causes the change in viewing angle.
    // Use _scenePosition (authoritative orbit-propagated position), not mesh.position (may be a floating-origin-adjusted
    // InstancedMesh container).
    if (arm.state === Constants.ARM_STATES.STATION_KEEP && arm._stationKeepTarget) {
      const debrisScenePos = (arm._stationKeepTarget._scenePosition || arm._stationKeepTarget.mesh?.position)?.clone();
      if (!debrisScenePos) return this._computeChase(dt, playerPos, velDir, radialDir);

      const armToDebris = debrisScenePos.clone().sub(armPos);
      if (armToDebris.lengthSq() < 1e-20) {
        return this._computeChase(dt, playerPos, velDir, radialDir);
      }
      armToDebris.normalize();

      // UP VECTOR: FROZEN at SK entry to prevent screen roll during the sweep. Earth-radial at the daughter
      // (`armPos.normalize()`) wobbles at the orbit-sphere φ-poles; the daughter's local +Y (`arm.group.quaternion`)
      // changes EVERY frame as she slerps to face the new sweep direction, rolling the screen and creating the illusion
      // of the debris "moving" although it stays at NDC (0,0). So capture Earth-radial at the DEBRIS position when SK is
      // first entered and reuse it every frame: a sensible "up" (away from Earth's centre) that depends on neither the
      // daughter's quaternion nor armToDebris. Cleared when the arm exits STATION_KEEP.
      if (!this.armPilot._skLockedUp) {
        this.armPilot._skLockedUp = debrisScenePos.clone().normalize();
      }
      // Orthogonalise the locked vector against the current armToDebris so the 1.6 m offset goes purely in screen-up; at
      // the orbit-sphere poles it becomes nearly parallel to armToDebris, so fall back to un-orthogonalised (never a
      // zero up).
      const lockedUp = this.armPilot._skLockedUp;
      const upDot = lockedUp.dot(armToDebris);
      const localUp = Math.abs(upDot) > 0.999
        ? lockedUp.clone()
        : lockedUp.clone().addScaledVector(armToDebris, -upDot).normalize();

      // Camera: 5 m behind the daughter (away from debris), 1.6 m above along her local up (same offsets as the rest of
      // ARM_PILOT).
      const pos = armPos.clone()
        .addScaledVector(armToDebris, -this.armPilot.offsetBehind)
        .addScaledVector(localUp, this.armPilot.offsetAbove);

      // CRITICAL: the look-target uses the LIVE debris position every frame, NO LERP: a 0.5 s-time-constant lerp gave a
      // steady-state lag of v·dt·(1-rate)/rate ≈ 127 m × 0.968 / 0.032 ≈ 3.8 km along the orbit-trailing direction
      // (debris _scenePosition advances ~127 m/frame at LEO orbital velocity, lerp rate ≈ 0.032/frame), so the camera
      // slid off the debris. The smooth entry is handled by _lookBlendTime in _setupArmPilotEntry, not by a lookAt lerp.
      this.armPilot._skLookTarget = debrisScenePos;  // bookkeeping only

      return { pos, look: debrisScenePos.clone(), up: localUp.clone() };
    }

    // Reset SK state when not in STATION_KEEP: _skLookTarget (bookkeeping for the live look target) and _skLockedUp (the
    // up vector frozen at SK entry, so a fresh capture happens next time SK is entered, possibly on another debris).
    if (this.armPilot._skLookTarget) {
      this.armPilot._skLookTarget = null;
    }
    if (this.armPilot._skLockedUp) {
      this.armPilot._skLockedUp = null;
    }

    // Camera behind and above the arm. forwardDir is the direction the camera looks: toward the target debris if
    // available (so the player sees it directly during APPROACH), else arm velocity, else parent velocity.
    let forwardDir;
    let lookTarget = null;       // explicit lookAt target when we have a debris target
    if (arm.target && arm.target._scenePosition) {
      forwardDir = arm.target._scenePosition.clone().sub(armPos);
      if (forwardDir.lengthSq() > 1e-12) {
        forwardDir.normalize();
        lookTarget = arm.target._scenePosition.clone();
      } else {
        // GRAPPLED: _updateGrappled snaps arm.position onto target._scenePosition, so (target - armPos) is the zero
        // vector; lookAt(target=armPos) with camera.up=radial-at-arm then gives antiparallel view/up vectors →
        // gimbal-locked rotation, and the screen rotates/jitters wildly. Fall back to a sane forward direction and
        // suppress lookTarget so the phantom-point branch below renders a stable view.
        if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
          forwardDir = arm.velocity.clone().normalize();
        } else if (this.armPilot._prevForward &&
                   this.armPilot._prevForward.lengthSq() > 1e-12) {
          forwardDir = this.armPilot._prevForward.clone().normalize();
        } else {
          forwardDir = velDir.clone();
        }
      }
    } else if (arm.velocity.lengthSq() > 1e-16) {
      forwardDir = arm.velocity.clone().normalize();
    } else {
      forwardDir = velDir.clone();
    }

    // Smooth look-direction blend when first entering ARM PILOT: prevents a disorienting snap by easing from the
    // pre-switch camera forward to the arm's desired forward over _lookBlendDuration seconds.
    if (this.armPilot._lookBlendTime !== undefined &&
        this.armPilot._lookBlendTime < this.armPilot._lookBlendDuration) {
      this.armPilot._lookBlendTime += dt;
      const t = Math.min(1, this.armPilot._lookBlendTime / this.armPilot._lookBlendDuration);
      const eased = smoothstep01(t);

      forwardDir = new THREE.Vector3().lerpVectors(
        this.armPilot._prevForward,
        forwardDir,
        eased
      ).normalize();
    }

    // Radial up at the arm position, orthogonalized to forwardDir so the "behind" and "above" offsets stay
    // perpendicular; otherwise, when forwardDir has a radial component (target at a different altitude), they partially
    // cancel and the camera drifts steadily closer to the daughter.
    const rawUp = armPos.clone().normalize();
    const upDot = rawUp.dot(forwardDir);
    const localUp = rawUp.clone().addScaledVector(forwardDir, -upDot).normalize();

    const pos = armPos.clone()
      .addScaledVector(forwardDir, -this.armPilot.offsetBehind)
      .addScaledVector(localUp, this.armPilot.offsetAbove);

    // Look at the actual debris position when a target exists, so it stays locked in screen space as the daughter
    // circles or approaches it (a phantom point 100 m past the daughter slides the debris through the frame, and once
    // she overshoots in APPROACH the camera frames empty space). No target: look 100 m ahead of the arm.
    const look = lookTarget !== null
      ? lookTarget
      : armPos.clone().addScaledVector(forwardDir, 0.001);

    return { pos, look };
  }

  /** @private */
  _attachMouseListeners() {
    this.canvas.addEventListener('mousedown', this._boundMouseDown);
    this.canvas.addEventListener('mousemove', this._boundMouseMove);
    this.canvas.addEventListener('mouseup', this._boundMouseUp);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('mouseup', this._boundWindowMouseUp);
    // The wheel is owned by the single WheelRouter (window capture); the zoom logic lives in handleWheelZoom(e), which
    // the router calls on the legacy (ladder-off) path. No canvas wheel listener here.
    this.canvas.addEventListener('contextmenu', this._boundContextMenu);
  }

  /** @private */
  _onMouseDown(e) {
    this._ionStartupInput('mouse');      // ion start-up: the player's own camera input ends the swing at once
    // ZOOM LADDER: while the ladder owns the camera, its drag branch owns the mouse; RETURN so the legacy
    // ORBIT/INSPECTION/free-look paths never double-fire. Gated on lc.active: byte-identical when disengaged.
    if (this._ladderCam.active) {
      if (this._lassoCut.active) this.abortLassoCut();
      const d = this._ladderCam.drag;
      // Left or right click starts a rotate drag on the drag-enabled floors
      // (floors 1-4). Rides own the camera — drags are ignored while riding.
      if (d.enabled && !this._ladderCam.riding && (e.button === 0 || e.button === 2)) {
        d.isDragging = true;
        d.lastMouseX = e.clientX;
        d.lastMouseY = e.clientY;
        this._dragStop(d);
      }
      return;
    }
    // Any mouse button aborts the lasso cut instantly (the cut is garnish, never a wall); the press then acts on the
    // restored view.
    if (this._lassoCut.active) this.abortLassoCut();
    if (this.currentView === CameraViews.ORBIT || this.currentView === CameraViews.INSPECTION) {
      const cfg = this.currentView === CameraViews.INSPECTION ? this.inspection : this.orbit;
      if (e.button === 0 || e.button === 2) {
        cfg.isDragging = true;
        cfg.lastMouseX = e.clientX;
        cfg.lastMouseY = e.clientY;
        this._dragStop(cfg);
      }
    } else if (this.currentView === CameraViews.FIRST_PERSON) {
      if (e.button === 2) {
        this.firstPerson.freeLookActive = true;
        this.orbit.lastMouseX = e.clientX;
        this.orbit.lastMouseY = e.clientY;
      }
    }
  }

  /** @private */
  _onMouseMove(e) {
    // ZOOM LADDER: accumulate rotate-drag velocities exactly like ORBIT (the turn of the moves since the last frame =
    // delta × rotateSpeed; the speed coasts per second in _updateLadderCamera). Deliberately NO CAMERA_ORBIT_DRAG emit:
    // that is an ORBIT-view skills-discovery signal, and the ladder keeps the events graph unchanged. RETURN keeps the
    // legacy paths unreachable while engaged.
    if (this._ladderCam.active) {
      const d = this._ladderCam.drag;
      if (d.isDragging) {
        const dx = e.clientX - d.lastMouseX;
        const dy = e.clientY - d.lastMouseY;
        d.lastMouseX = e.clientX;
        d.lastMouseY = e.clientY;
        this._dragMove(d, -dx * d.rotateSpeed, dy * d.rotateSpeed, false);   // a SET: the last move of a frame wins
        this.ladderCancelCatchFocus('mouse drag');   // his own camera input ends the catch focus
        this.ladderCancelEarthTurn('mouse drag');    // so does the floor-4 turn to the focused field
      }
      return;
    }
    if ((this.currentView === CameraViews.ORBIT || this.currentView === CameraViews.INSPECTION) &&
        (this.currentView === CameraViews.INSPECTION ? this.inspection.isDragging : this.orbit.isDragging)) {
      const cfg = this.currentView === CameraViews.INSPECTION ? this.inspection : this.orbit;
      const dx = e.clientX - cfg.lastMouseX;
      const dy = e.clientY - cfg.lastMouseY;
      cfg.lastMouseX = e.clientX;
      cfg.lastMouseY = e.clientY;

      this._dragMove(cfg, -dx * cfg.rotateSpeed, dy * cfg.rotateSpeed, false);

      eventBus.emit(Events.CAMERA_ORBIT_DRAG);
    } else if (this.currentView === CameraViews.FIRST_PERSON && this.firstPerson.freeLookActive) {
      const dx = e.clientX - this.orbit.lastMouseX;
      const dy = e.clientY - this.orbit.lastMouseY;
      this.orbit.lastMouseX = e.clientX;
      this.orbit.lastMouseY = e.clientY;

      this.firstPerson.freeLookYaw += dx * 0.3;
      this.firstPerson.freeLookPitch += dy * 0.3;
      this.firstPerson.freeLookYaw = clamp(this.firstPerson.freeLookYaw, -90, 90);
      this.firstPerson.freeLookPitch = clamp(this.firstPerson.freeLookPitch, -45, 45);

      eventBus.emit(Events.CAMERA_FREE_LOOK);
    }
  }

  /** @private */
  _onMouseUp(e) {
    // ZOOM LADDER: release the rotate drag; the accumulated velocities decay as momentum in _updateLadderCamera (ORBIT
    // feel). RETURN keeps the legacy release paths unreachable while the ladder owns the camera.
    if (this._ladderCam.active) {
      this._ladderCam.drag.isDragging = false;
      return;
    }
    if (this.currentView === CameraViews.ORBIT) {
      this.orbit.isDragging = false;
    }
    if (this.currentView === CameraViews.INSPECTION) {
      this.inspection.isDragging = false;
    }
    if (this.currentView === CameraViews.FIRST_PERSON && e.button === 2) {
      this.firstPerson.freeLookActive = false;
      this.firstPerson.freeLookYaw *= 0.3;
      this.firstPerson.freeLookPitch *= 0.3;
    }
  }

  /**
   * Legacy wheel-zoom logic (chase/orbit/inspection/first-person). Not a DOM listener: the single WheelRouter calls it
   * on the ladder-OFF path. Emits CAMERA_ZOOM (skills discovery) and drives the inspect Schmitt.
   */
  handleWheelZoom(e) {
    e.preventDefault();
    this._ionStartupInput('wheel');      // ion start-up: the player's own camera input ends the swing at once

    if (this._lassoCut.active) this.abortLassoCut();

    eventBus.emit(Events.CAMERA_ZOOM);

    if (this.currentView === CameraViews.ORBIT) {
      // Zoom in/out: finer 3% steps inside the inspection band so close framing is controllable; 5% otherwise.
      const fine = this.orbit.distance < this.orbit.inspectExitDist;
      const step = fine ? 0.03 : 0.05;
      const zoomDelta = e.deltaY > 0 ? (1 + step) : (1 - step);
      this.orbit.distance *= zoomDelta;
      this.orbit.distance = clamp(this.orbit.distance, this.orbit.minDistance, this.orbit.maxDistance);
      this._evaluateInspectZoom();
    } else if (this.currentView === CameraViews.INSPECTION) {
      const zoomDelta = e.deltaY > 0 ? 1.03 : 0.97;
      this.inspection.distance *= zoomDelta;
      this.inspection.distance = clamp(this.inspection.distance, this.inspection.minDistance, this.inspection.maxDistance);
    } else if (this.currentView === CameraViews.CHASE) {
      // Adjust chase distance (smooth 5% steps, min ~4 m behind)
      const zoomDelta = e.deltaY > 0 ? 1.05 : 0.95;
      this.chase.offsetBehind *= zoomDelta;
      // Min ~4 m: stays outside the ~3 m near-clip (CAMERA_NEAR) to avoid hull clipping.
      this.chase.offsetBehind = clamp(this.chase.offsetBehind, 0.00004, 0.001);
      this.chase.offsetAbove = this.chase.offsetBehind * 0.48;
    } else if (this.currentView === CameraViews.TARGET_LOCK) {
      // Unreachable (TARGET_LOCK removed from VIEW_CYCLE); retained for possible re-enable. See _computeTargetLock.
      const zoomDelta = e.deltaY > 0 ? 1.1 : 0.9;
      this.targetLock.offsetDistance *= zoomDelta;
      this.targetLock.offsetDistance = clamp(this.targetLock.offsetDistance, 0.0001, 0.005);
    } else if (this.currentView === CameraViews.FIRST_PERSON) {
      // Adjust FOV slightly for zoom effect (update _baseFov so FOV breathe offset stacks correctly)
      this._baseFov += e.deltaY > 0 ? 2 : -2;
      this._baseFov = clamp(this._baseFov, 30, 90);
      this.camera.fov = this._baseFov + this._fovBreathOffset;
      this.camera.updateProjectionMatrix();
    }
  }

  // ZOOM LADDER RIDE ENGINE (archive/ladder/06-core-api.md). The ceremony-BEAT pattern applied to the ladder:
  // LadderController hands the camera a target FRAME { distU, fov, anchor } derived from (floor, z01), and this engine
  // dollies along a direction from the anchor: heading-relative on ship anchors (the ship's orbital frame), inertial on
  // Earth anchors. Rides (crossings / mini-rides) cubic-in-out interpolate distance + FOV; free scroll / settle ease
  // toward the live target. Anchor 'earth' aims at the scene ORIGIN (Earth centre): the Earth-fixed framing setView()
  // cannot do.

  /**
   * Engage the ladder camera. Captures the current camera direction relative to the frame's anchor so the first floor
   * doesn't snap the view.
   * @param {{distU:number, fov:number, anchor:'ship'|'earth'}} frame
   */
  ladderEngage(frame) {
    const lc = this._ladderCam;
    lc.active = true;
    lc.riding = false;
    lc.onDone = null;
    this._resetCatchFocus('ladder engaged again');   // a fresh engage never inherits a focus
    this._takeoverDistU = null;
    lc.anchor = frame.anchor;
    lc.targetDistU = frame.distU;
    lc.curDistU = frame.distU;
    lc.fov = frame.fov;
    this._ladderResetFollow();   // every engage starts on the mother
    const anchorPos = this._ladderAnchorPos(frame.anchor);
    const d = lc._tmp.copy(this.camera.position).sub(anchorPos);
    if (d.lengthSq() > 1e-20) lc.dir.copy(d).normalize();
    // The local (orbital-frame) coefficients are projected from THIS world dir on the first ship-anchored frame
    // (update() owns the live velDir), so the pose at engage is exactly the current one; the frame only starts
    // co-rotating afterwards. Per-floor drag memory deliberately survives.
    lc.localSeeded = false;
    lc.rideDirSlerp = false;
    lc.floor = (frame.floor != null) ? frame.floor : null;
    lc.leveling = false;
    lc.levelT = 0;
    lc.rideFloorFrom = null;
    lc.levelHoldFloor = null;
    this._baseFov = frame.fov;
    // Drag gating: the mouse rule and the touch rule (see _ladderSetDragGates). A fresh engage starts with no drag in
    // flight.
    this._ladderSetDragGates(frame.floor);
    lc.drag.isDragging = false;
    lc.drag.touchHeld = false;
    this._dragStop(lc.drag);
    this._resetLadderViewReturn();   // no owed return, glide or wait carries into a fresh engage
    // The look-at bias starts settled at 0 on every engage (the pane is enabled by the controller only AFTER engage);
    // the request itself (paneInsetPx) stays the caller's: main.js owns it through the setter.
    this._ladderResetPaneBias();
    // Floor 1 inspect absorption: engaging directly on floor 1 applies the arrival effects (a re-engage mid-session restores the
    // floor's costume).
    this._ladderApplyInspectFx(frame.floor);
  }

  /** Disengage the ladder camera; the normal view path resumes next frame. */
  ladderDisengage() {
    const lc = this._ladderCam;
    lc.active = false;
    lc.riding = false;
    lc.onDone = null;
    lc.leveling = false;
    lc.levelT = 0;
    lc.levelHoldFloor = null;
    this.ladderCancelEarthTurn('ladder disengaged');
    this._resetCatchFocus('ladder disengaged');
    this._ladderResetFollow();
    lc.drag.enabled = false;
    lc.drag.touchEnabled = false;
    lc.drag.isDragging = false;
    lc.drag.touchHeld = false;
    lc.drag.lastMouseX = 0;
    lc.drag.lastMouseY = 0;
    this._dragStop(lc.drag);
    this._resetLadderViewReturn();
    this._ladderResetPaneBias();
    // Floor 1 inspect absorption: a disengage while on floor 1 reverts the arrival effects (dim off, overlays off): the shipped
    // views resume clean.
    this._ladderApplyInspectFx(null);
  }

  /**
   * The F3 look-at bias (08-workbench §2, 01-numbers "F3 look-at bias"): the ONE inset value. `px` is the signed
   * CSS-pixel width of the workbench pane covering a viewport edge: positive = a pane on the LEFT edge (the subject
   * reframes right, to the centre of the uncovered strip), negative = a pane on the RIGHT edge, 0 = none (both panes
   * open → the caller nets the two). main.js calls this from the pane's onOpenChange edge, the SAME signal that feeds
   * the calm cap, never a second path. The camera applies it on every engaged floor (the SPECS drawer lives on every
   * floor), eased over LADDER_PANE_REFRAME_MS (reduced motion → snap). Non-finite → 0. Flag-off: the pane is never
   * constructed, this is never called, the request stays 0 and the ladder never engages → byte-identical.
   */
  setLadderPaneInset(px) {
    this._ladderCam.paneInsetPx = Number.isFinite(px) ? px : 0;
  }

  /**
   * The drawer-open bit for the drag gate (the TURNTABLE). main.js's ONE workbench-pane edge (_syncWorkbenchPanes)
   * feeds it. LIVE re-gate: a drawer opening while the player already stands on the floor must arm the drag without a
   * ride, and closing it disarms mid-hold (any in-flight drag and its momentum are cancelled: the pointer-up path can
   * never race a disabled gate).
   * FLOOR-2 CLOSE RULE: floor 2 is the shipped flying view, so "drawer closed → arrows steer the ship as today" must
   * hold for the CAMERA too. The SPECS drawer RIDES ALONG across floors, so the close edge can fire ANYWHERE: the
   * floor-2 turntable MEMORY dies on every close (else an Earth→2 descent restores it with the drag disarmed: no way
   * back to the shipped view), and the LIVE pose returns to the canonical chase-behind pose only when the camera is
   * actually ON floor 2 (off-floor, lc.local is the current floor's pose). Floor 1 keeps its drag memory (the
   * workbench pose is the player's). Flag-off: the panes are never constructed, this is never called → byte-identical.
   */
  setLadderPaneOpen(open) {
    const lc = this._ladderCam;
    lc.paneOpen = !!open;
    if (!lc.paneOpen) {
      delete lc.dragMemory[2];
      if (lc.floor === 2) this._ladderChaseLocal(lc.local);
    }
    const was = lc.drag.enabled;
    this._ladderSetDragGates(lc.floor);
    if (lc.drag.enabled !== was) {
      lc.drag.isDragging = false;
      this._dragStop(lc.drag);
    }
  }

  /**
   * @private The MOUSE drag-gate rule: floors 1-4 always, like the finger (owner 2026-10-20 "Mac too" for floor 2; owner 2026-10-25:
   * "mouse drag works great in Floor 2 ... make it work in Floor 1"). Held arrows on floor 1 still turn the view only with a drawer open
   * (ladderDragNudge's key rule). Floor 5 and floorless legacy frames never arm.
   */
  _ladderDragEnabledFor(floor) {
    return floor === 1 || floor === 2 || floor === 3 || floor === 4; // mouse rule
  }

  /**
   * @private The TOUCH drag-gate rule (owner 2026-10-20: "one-finger drag turns the view"): floors 1-4 always, with or
   * without a drawer (a finger has no other use on the canvas; the ship turns from the turn pad). Floor 5 and
   * floorless frames never arm. A superset of the mouse rule.
   */
  _ladderTouchDragEnabledFor(floor) {
    return floor === 1 || floor === 2 || floor === 3 || floor === 4;
  }

  /** @private Re-evaluate both drag gates for `floor`. */
  _ladderSetDragGates(floor) {
    const d = this._ladderCam.drag;
    d.enabled = this._ladderDragEnabledFor(floor);
    d.touchEnabled = this._ladderTouchDragEnabledFor(floor);
  }

  /**
   * The turntable's ARROW nudge: LadderController maps held arrow keys to this while a drawer is open on floor 1. Same
   * math as the pointer path (_onMouseMove): the px delta becomes a pending turn (then a per-second coast speed) through
   * drag.rotateSpeed, decaying through drag.damping per 1/60 s: one drag feel, two inputs. Gated like a pointer drag:
   * engaged + drag-enabled (mouse rule, or the touch rule for source 'touch') + not riding (rides own the camera). A
   * nudge is a SET like the pointer's (never accumulates across frames), so holding a key rotates at a steady
   * px-per-call rate and release coasts on the shipped momentum.
   * @param {number} dxPx - horizontal pointer-equivalent px (+ = drag right)
   * @param {number} dyPx - vertical pointer-equivalent px (+ = drag down)
   * @param {string} [source] - 'touch' = a finger on the glass (TouchControls): gated by the touch rule (floors 1-4).
   *   Anything else (the turntable's held arrows) keeps the mouse rule.
   */
  ladderDragNudge(dxPx, dyPx, source) {
    const lc = this._ladderCam;
    if (!lc.active || lc.riding) return;
    if (!(source === 'touch' ? lc.drag.touchEnabled : lc.drag.enabled)) return;
    // Key rule: the mouse gate arms floor 1 always, but held arrows on floor 1 steer the ship unless a drawer is open
    // (the turntable).
    if (source !== 'touch' && lc.floor === 1 && !lc.paneOpen) return;
    const dx = Number.isFinite(dxPx) ? dxPx : 0;
    const dy = Number.isFinite(dyPx) ? dyPx : 0;
    if (dx === 0 && dy === 0) return;
    this._ionStartupInput('touch drag'); // ion start-up: the player's own camera input ends the swing at once
    // Stale-nudge guard: main.js stops calling update() while the game is paused, the tab is hidden or the window is
    // blurred, yet a finger that stays down keeps sending nudges; they would all land in one frame's sum and fling the
    // view on resume. No ladder update for LADDER_NUDGE_STALE_MS of wall time = nobody is drawing: the nudge is dropped.
    if (this._ladderUpdateWallMs !== null &&
        this._wallNowMs() - this._ladderUpdateWallMs > LADDER_NUDGE_STALE_MS) return;
    this.ladderCancelCatchFocus('touch drag');   // a touch drag is his own camera input too (the mouse path does the same)
    this.ladderCancelEarthTurn('touch drag');    // and it stops the floor-4 turn to the focused field
    // Touch coalescing: a SET keeps only the LAST event of a frame, so a 120 Hz touchmove on a 60 fps (or 30 fps under
    // load) canvas threw away half or more of the finger's travel (a 1180 px swipe: 506 deg at 1 event/frame, 262 deg
    // at 2). Several nudges inside ONE drawn frame therefore SUM; the first nudge of a frame still SETS (the pointer's
    // law, and the held arrow's one-call-per-frame).
    const d = lc.drag;
    const addTheta = -dx * d.rotateSpeed, addPhi = dy * d.rotateSpeed;
    const same = d.nudgeSeq === this._ladderUpdateSeq;
    this._dragMove(d, addTheta, addPhi, same);
    d.nudgeSeq = this._ladderUpdateSeq;
  }

  /**
   * A finger is held (or let go) on a view drag. TouchControls calls it on the drag's first move and on every end of
   * the gesture. A held finger is view input even when it does not move (the view return does not start under it).
   */
  ladderSetTouchHeld(on) {
    this._ladderCam.drag.touchHeld = !!on && this._ladderCam.active;
  }

  // VIEW RETURN (see LADDER_VIEW_RETURN; owner 2026-10-25): after the last view input, once the drag's coast has
  // stopped, the view waits IDLE_S, then glides home. One state block (lc.viewReturn), one writer of the pose (this
  // step, after the drag block and before the direction is rebuilt from lc.local).

  /** @private Forget any owed return, glide and wait (engage / disengage). `dragMemory` is kept. */
  _resetLadderViewReturn() {
    const vr = this._ladderCam.viewReturn;
    vr.dirty = false; vr.moved = false; vr.t = 0; vr.glide = null; vr.due = false;
    vr.anchor = null; vr.prevCur = null; vr.prevTarget = null;
  }

  /**
   * Floor 4 (Earth anchor): true ONCE when the wait after his last view input is over and the view should go back to
   * the floor's default. The default is the framing main.js's floor-4 block computes (ship and debris field in view:
   * NavcomFloor.framing), so main.js answers with `ladderTurnEarthDir(fr.dir)` (direction only; the zoom stays).
   * Cleared by any view input, ride, drawer or turn; floors 1-3 return on their own and floor 5 never.
   */
  ladderViewReturnDue() {
    const lc = this._ladderCam;
    const vr = lc.viewReturn;
    if (!vr.due) return false;
    vr.due = false;
    return lc.active && lc.floor === 4;
  }

  /**
   * @private One frame of the view return. `coastStep` is the coast's real step (s).
   *  - View input = a drag turn applied this frame, a mouse button held, a coast still running, or a change of
   *    `lc.curDistU` / `lc.targetDistU` (wheel and pinch zoom go through LadderController, not this file). It stops a
   *    glide where it is (the pose of that frame, no snap) and restarts the wait. A finger held still sends no event, so
   *    it counts only through its nudges.
   *  - Held off, wait restarting: a ride, the post-ride level phase, a floor-4 turn, a drawer (any floor), the catch
   *    focus or reel view. The wait starts when they end, if the view is still off default (`dirty`).
   *  - A change of anchor type (a ride between ship and Earth floors) is not a view input: arriving on a remembered pose
   *    owes a return, any other arrival does not.
   */
  _stepLadderViewReturn(coastStep, shipAnchored) {
    const lc = this._ladderCam;
    const vr = lc.viewReturn;
    const dg = lc.drag;
    const moved = vr.moved;
    vr.moved = false;
    if (vr.anchor !== null && vr.anchor !== lc.anchor) {
      vr.dirty = shipAnchored && lc.floor != null && !!lc.dragMemory[lc.floor];
      vr.glide = null; vr.due = false; vr.t = 0;
    }
    vr.anchor = lc.anchor;
    const zoomed = vr.prevCur !== null && (lc.curDistU !== vr.prevCur || lc.targetDistU !== vr.prevTarget);
    vr.prevCur = lc.curDistU;
    vr.prevTarget = lc.targetDistU;
    // A press or a held finger that has not turned the view is input (it holds the wait) but owes nothing: only a turn
    // that moved the view makes `dirty` (a plain click must not turn the floor-4 view 4 s later).
    const input = moved || dg.isDragging || dg.touchHeld || dg.hasPend || dg.velocityTheta !== 0 || dg.velocityPhi !== 0;
    if (moved) vr.dirty = true;
    // The catch focus holds the wait while it owns the camera; once his input has taken its pose over (the ladder owns
    // the camera again, only the look-at fades back) the wait runs, from that hand-back.
    const cf = this._catchFocus;
    const held = lc.riding || lc.leveling || lc.paneOpen || !!lc.earthTurn || (cf.active && !cf.takenOver);
    if (held || input || zoomed) {
      vr.glide = null; vr.t = 0; vr.due = false;
      if (lc.earthTurn) vr.dirty = false;   // a framing turn has just replaced the view
      return;
    }
    if (!vr.dirty) { vr.t = 0; return; }
    const step = Math.min(coastStep, COAST_STEP_MAX_S);   // a hitch (pause, hidden tab) never ends the wait
    if (vr.glide) { this._advanceLadderViewReturnGlide(step); return; }
    vr.t += step;
    if (vr.t < LADDER_VIEW_RETURN.IDLE_S) return;
    vr.t = 0;
    if (!shipAnchored) {                     // Earth anchor: main.js's floor-4 block answers (floor 5 never moves)
      vr.dirty = false;
      if (lc.floor === 4) vr.due = true;
      return;
    }
    this._beginLadderViewReturnGlide();
  }

  /** @private The view is home (or a glide ended): nothing owed, and a ride back to this floor lands on the default. */
  _finishLadderViewReturn() {
    const lc = this._ladderCam;
    const vr = lc.viewReturn;
    vr.dirty = false; vr.t = 0; vr.glide = null;
    if (lc.floor != null) delete lc.dragMemory[lc.floor];
  }

  /**
   * @private Start the glide from the current local pose to the chase direction: the great circle between them
   * (smoothstep over GLIDE_S), except where that arc would pass nearer a pole of the floor (the radial axis) than the
   * drag's own gimbal window allows the view to go (near 180 degrees round, the arc goes over the top and the horizon
   * would flip): then the same smoothstep over azimuth and polar angle, which keeps the polar angle between the two ends.
   * Reduced motion cuts instead of gliding (the file's precedent for the catch focus and the pane reframe).
   */
  _beginLadderViewReturnGlide() {
    const lc = this._ladderCam;
    const vr = lc.viewReturn;
    const from = vr.from.copy(lc.local).normalize();
    const to = this._ladderChaseLocal(vr.to);
    if (Math.acos(Math.max(-1, Math.min(1, from.dot(to)))) < 1e-6) { this._finishLadderViewReturn(); return; }
    if (this._prefersReducedMotion()) { lc.local.copy(to); this._finishLadderViewReturn(); return; }
    const poleDist = (x) => Math.acos(Math.min(1, Math.abs(x)));      // the pole is local x (lc._localUp)
    vr.quat.setFromUnitVectors(from, to);
    let arcMin = Math.PI;
    for (let i = 0; i <= 24; i++) {
      vr.quatS.identity().slerp(vr.quat, i / 24);
      arcMin = Math.min(arcMin, poleDist(vr.tmp.copy(from).applyQuaternion(vr.quatS).x));
    }
    const endsMin = Math.min(poleDist(from.x), poleDist(to.x));
    const g = { t: 0, arc: !(arcMin < Math.min(0.3, 0.9 * endsMin)), az0: 0, daz: 0, th0: 0, dth: 0 };
    if (!g.arc) {
      g.th0 = Math.acos(clamp(from.x, -1, 1));
      g.dth = Math.acos(clamp(to.x, -1, 1)) - g.th0;
      g.az0 = Math.atan2(from.z, from.y);
      let d = Math.atan2(to.z, to.y) - g.az0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      g.daz = d;
    }
    vr.glide = g;
  }

  /** @private One glide frame: smoothstep progress by the real step; the end is exact. */
  _advanceLadderViewReturnGlide(step) {
    const lc = this._ladderCam;
    const vr = lc.viewReturn;
    const g = vr.glide;
    g.t += step;
    const u = Math.min(1, g.t / LADDER_VIEW_RETURN.GLIDE_S);
    if (u >= 1) {
      this._ladderChaseLocal(lc.local);
      this._finishLadderViewReturn();
      return;
    }
    const s = smoothstep01(u);
    if (g.arc) {
      vr.quatS.identity().slerp(vr.quat, s);
      lc.local.copy(vr.from).applyQuaternion(vr.quatS);
    } else {
      const th = g.th0 + g.dth * s;
      const az = g.az0 + g.daz * s;
      lc.local.set(Math.cos(th), Math.sin(th) * Math.cos(az), Math.sin(th) * Math.sin(az));
    }
    lc.local.normalize();
    if (lc.floor != null) {            // a ride away mid-glide leaves from the pose the glide is at
      const m = lc.dragMemory[lc.floor] || (lc.dragMemory[lc.floor] = new THREE.Vector3());
      m.copy(lc.local);
    }
  }

  /** @private Settle the eased look-at bias at 0 (engage / disengage). */
  _ladderResetPaneBias() {
    const lc = this._ladderCam;
    lc.paneBiasPx = 0;
    lc.paneBiasFrom = 0;
    lc.paneBiasTo = 0;
    lc.paneBiasT = 1;
  }

  /**
   * @private CSS-px viewport width for the inset → NDC conversion: the render canvas's clientWidth (SceneManager sizes
   * it to window.innerWidth, the number camera.aspect is built from; tests inject it on the mock canvas). 0 when
   * unknown → no bias is applied (never NaN, never a guess).
   */
  _ladderViewportWidthPx() {
    const c = this.canvas;
    const w = c ? c.clientWidth : 0;
    return (Number.isFinite(w) && w > 0) ? w : 0;
  }

  /**
   * Free-scroll / settle target (no ride). The camera eases toward it.
   */
  ladderSetTarget(frame) {
    const lc = this._ladderCam;
    if (!lc.active) return;
    // Anchors only change through rides; should a target switch anchor without one, re-project the (continuous) world
    // dir into the new frame.
    if (frame.anchor !== lc.anchor) lc.localSeeded = false;
    lc.anchor = frame.anchor;
    lc.targetDistU = frame.distU;
    lc.fov = frame.fov;
    if (frame.floor != null) lc.floor = frame.floor;
    this._ladderSetDragGates(frame.floor);
    this._ladderApplyInspectFx(frame.floor);
  }

  /**
   * Start a crossing / mini ride to a destination frame over `rideMs`, cubic
   * in-out, invoking `onDone` once when it completes.
   * @param {{distU:number, fov:number, anchor:'ship'|'earth', rideMs:number, onDone:function}} opts
   */
  ladderStartRide(opts) {
    this._ionStartupInput('ladder ride');   // ion start-up: a ride (the rail, a floor change) takes the camera; the swing ends at once
    const lc = this._ladderCam;
    if (!lc.active) {
      if (typeof opts.onDone === 'function') opts.onDone();
      return;
    }
    const wasRiding = lc.riding;       // a replacement ride may inherit an in-flight dir slerp
    lc.riding = true;
    lc.rideT = 0;
    lc.rideDur = Math.max(0.001, (opts.rideMs || 550) / 1000);
    lc.rideFromDistU = lc.curDistU;
    lc.rideToDistU = opts.distU;
    lc.rideFromFov = this.camera.fov || lc.fov;
    lc.rideToFov = opts.fov;
    lc.rideAnchorFrom = lc.anchor;
    lc.anchor = opts.anchor;           // destination anchor drives the framing
    lc.targetDistU = opts.distU;
    lc.fov = opts.fov;
    lc.onDone = (typeof opts.onDone === 'function') ? opts.onDone : null;
    // Direction policy per anchor pair (docs/ladder/08-workbench.md B1):
    //   ship→Earth : `dir` simply stops being rebuilt from the local pose: the last rebuilt world dir is frozen
    //                (continuity) and then holds inertial on the Earth floors.
    //   Earth→ship : freeze the inertial start dir and slerp it, on the ride's ease, toward the live world vector of the
    //                ARRIVAL local pose (the player's drag memory for the destination floor, else the canonical
    //                chase-behind pose), so every descent lands "back in the cockpit", never facing backwards.
    //   ship→ship  : the local pose carries over (heading-relative throughout); a ride replacing an in-flight
    //                Earth→ship slerp (flick upgrade/undo) continues that slerp from the current dir so the direction
    //                never snaps mid-flight.
    if (opts.anchor === 'ship') {
      if (lc.rideAnchorFrom === 'earth') {
        lc.rideDirFrom.copy(lc.dir);
        const mem = (opts.floor != null) ? lc.dragMemory[opts.floor] : null;
        if (mem) lc.local.copy(mem); else this._ladderChaseLocal(lc.local);
        lc.localSeeded = true;
        lc.rideDirSlerp = true;
      } else if (wasRiding && lc.rideDirSlerp) {
        lc.rideDirFrom.copy(lc.dir);       // continue the interrupted slerp from here
      } else {
        lc.rideDirSlerp = false;
      }
    } else {
      lc.rideDirSlerp = false;
    }
    lc.rideFloorFrom = lc.floor;
    lc.floor = (opts.floor != null) ? opts.floor : null;
    // The up at ride start is what an UP-ride holds and a DOWN-ride rolls away from (so a ride that interrupts a level
    // phase or reverses a half-rolled ride starts from the CURRENT horizon, never a snap). A cross-anchor ride owns the
    // up from here, cancelling any level phase; a same-anchor ride (F4→F5 flicked during leveling) does not touch the
    // up state, so a running level phase completes on its own clock.
    if (lc.rideAnchorFrom !== opts.anchor) {
      lc._upStart.copy(this.camera.up).normalize();
      lc.leveling = false;
      lc.levelT = 0;
      lc.levelHoldFloor = null;
    }
    // A ride owns the camera (flick replacements included): cancel any in-flight drag and its momentum; re-gate on the
    // destination floor.
    this.ladderCancelEarthTurn('ride');   // a ride owns `dir` too
    this._ladderSetDragGates(opts.floor);
    lc.drag.isDragging = false;
    this._dragStop(lc.drag);
    // Floor 1 inspect absorption: the 2/1 down-hump ride applies the ARRIVAL effects at ride start (destination floor 1, the
    // same moment the render block swaps, LadderController._startRide); the up-hump ride's destination floor 2 applies
    // the DEPARTURE inverses.
    this._ladderApplyInspectFx(opts.floor);
  }

  isLadderActive() { return this._ladderCam.active; }

  /**
   * Turn the floor-4 view (about EARTH_TURN_S) so the debris field at `center` is in the middle: the camera moves onto
   * the line from Earth's centre through the field (EarthTurn.earthTurnTarget), so the field sits between the camera
   * and Earth. Only `lc.dir` moves (inertial); the distance, the fov and the up are untouched. Returns true and stores
   * the turn (a call during a running turn restarts from the current dir) only when the ladder is engaged on an Earth
   * anchor, `center` is usable (EarthTurn: finite, not inside Earth) and the camera is above the field by
   * EARTH_TURN_MIN_GAP_U (a field at or above the camera cannot be shown by turning: the ladder has no live zoom-out).
   * Otherwise false and nothing changes.
   * @param {{x:number,y:number,z:number}|THREE.Vector3} center  scene units, Earth at the origin
   */
  ladderTurnEarthTo(center) {
    const lc = this._ladderCam;
    if (!lc.active || lc.anchor !== 'earth') return false;
    const target = earthTurnTarget(center);
    if (!target) return false;
    const r = Math.sqrt(center.x * center.x + center.y * center.y + center.z * center.z);
    const gap = Math.max(EARTH_TURN_MIN_GAP_U, (this.camera.near || 0) + 1);
    if (!(lc.curDistU - r >= gap)) return false;
    lc.earthTurn = { start: lc.dir.clone(), target, t: 0 };
    return true;
  }

  /**
   * The same 1 s turn as ladderTurnEarthTo, to a view DIRECTION chosen by the floor-4 framing (NavcomFloor.framing: the
   * ship–field midpoint, or the field when both cannot fit; owner pick "Floor 4 easier to read", 2026-10-20). Polar
   * angle clamped to the drag window like every turn target; no distance gap test (the framing picks the distance and
   * LadderController.frameZoomTo glides to it). Refused off an Earth anchor, on any floor but 4, disengaged, or for an
   * unusable direction.
   * @param {{x:number,y:number,z:number}} dir  any non-zero vector from Earth's centre
   */
  ladderTurnEarthDir(dir) {
    const lc = this._ladderCam;
    if (!lc.active || lc.anchor !== 'earth' || !dir) return false;
    if (lc.floor != null && lc.floor !== 4) return false;   // floor 5 (also Earth-anchored) never re-frames
    const n = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(n > 0) || !Number.isFinite(n)) return false;
    const k = 200 / n;   // a point 200 u out on that ray: beyond Earth's surface (63.71 u), as earthTurnTarget needs
    const target = earthTurnTarget({ x: dir.x * k, y: dir.y * k, z: dir.z * k });
    if (!target) return false;
    // Smoothness: sine in-out, stretched (≤ 1.5 s) when the path would pass 120°/s at its fastest.
    lc.earthTurn = { start: lc.dir.clone(), target, t: 0, s: earthFrameTurnS(lc.dir, target), ease: earthFrameEase };
    return true;
  }

  /** The running turn's length in ms (0 when none runs); LadderController's glide takes the same time. */
  ladderEarthTurnMs() {
    const et = this._ladderCam.earthTurn;
    return et ? (et.s || EARTH_TURN_S) * 1000 : 0;
  }

  /**
   * Stop the turn to the focused field where it is (the view stays on the way); no-op when none runs. Every call (a
   * mouse drag, a touch drag, a ride, a disengage, an anchor change) also counts once in `ladderEarthFrameCancels()`,
   * which ends LadderController's framing glide. The wheel no longer calls it (a trackpad tail after arrival cancelled the
   * turn to the lifted default view, owner 2026-10-31); should a USER-input cause ('wheel', 'mouse drag', 'touch drag') stop
   * a running turn on floor 4, the view is marked off default (`viewReturn.dirty`) so the 4 s return restores it.
   * @param {string} [cause] which call site; the three user-input causes above also owe the view return
   */
  ladderCancelEarthTurn(cause = 'camera input') {
    const lc = this._ladderCam;
    if (lc.earthTurn && lc.active && lc.floor === 4 && (cause === 'wheel' || cause === 'mouse drag' || cause === 'touch drag')) {
      lc.viewReturn.dirty = true;
    }
    lc.earthTurn = null;
    this._earthFrameCancels = (this._earthFrameCancels || 0) + 1;
  }

  /** How many times the floor-4 framing was cancelled from the camera side (LadderController watches it). */
  ladderEarthFrameCancels() { return this._earthFrameCancels || 0; }

  isLadderEarthTurning() { return !!this._ladderCam.earthTurn; }

  // CATCH FOCUS (see CATCH_FOCUS). Camera-layer only: it adds an anchor offset and a distance pull to the ladder
  // camera's own pose, and never writes the ladder's state (lc.curDistU / lc.dir / lc.floor / the rides).

  /** @returns {object|null} the capture-net system this camera's ship uses (the singleton in the shipped build). */
  _netSystemRef() {
    const p = this._player;
    return (p && p._captureNetSystem) || captureNetSystem;
  }

  /** @returns {boolean} whether the catch focus is on screen (engaged, or still easing back out). */
  isCatchFocusActive() { return this._catchFocus.active; }

  /**
   * @returns {{active:boolean, engaging:boolean, phase:string, w:number, tipIndex:number, kind:string, cut:boolean}}
   *   the focus, for tests and the dev overlay. A copy: never write through it.
   */
  catchFocusState() {
    const f = this._catchFocus;
    return { active: f.active, engaging: f.engaging, phase: f.phase, w: f.w, wa: f.wa, tipIndex: f.tipIndex, kind: f.kind, cut: f.cut, reelView: f.reelView, dist: f.dist, armIndex: f.armIndex, zoom: f.zoom };
  }

  /** One console line per catch-focus event (start / refused / cancel / end), never per frame. */
  _catchFocusLog(text) {
    console.log(`[catch-focus] ${text}`);
  }

  /**
   * Drop the focus at once (a state change, a re-engage, a disengage): the camera is the ladder's again this frame.
   * @param {string} [cause] when given and a focus was engaged, prints its one `cancel <cause>` line
   */
  _resetCatchFocus(cause) {
    const f = this._catchFocus;
    if (!f) return;
    if (cause && f.active && f.engaging) this._catchFocusLog(`cancel ${cause}`);
    f.active = false; f.engaging = true; f.phase = 'idle';
    f.u = 0; f.w = 0; f.wa = 0; f.rate = 1 / CATCH_FOCUS.IN_S; f.timer = 0;
    f.look.set(0, 0, 0); f.hop.set(0, 0, 0); f.hopVel.set(0, 0, 0); f.dist = CATCH_FOCUS.DIST_U; f.wantDist = CATCH_FOCUS.DIST_U;
    f.baseDist = CATCH_FOCUS.DIST_U; f.innerDist = 0; f.zoom = 1; f.zoomed = false;
    f.reelView = false; f.reelSeen = false; f.reelSeq = 0; f.safeDist = 0; f.jumpRun = 0; f.spell = null;
    f.takenOver = false; f.camRelOk = false;
    f.net = null; f.debris = null; f.podIndex = -1; f.tipIndex = -1;
    f.kind = 'mother'; f.cut = false; f.snapPending = false; f.armIndex = -1; f.arm = null; f.totalS = 0; f.collarS = 0;
    f.off.set(0, 0, 0);
    f.dirSeeded = false;
    f.azSide = 1; f.azKeep.set = false; f.azKeepAim.set = false;
    f.relSeeded = false;
    f.vel.set(0, 0, 0);
  }

  /**
   * Why a catch cannot get the focus right now, or null when it can: the ladder camera must be up on a ship-anchored
   * level (F1-F3; F4-F5 are Earth-anchored maps), not mid-ride, the net ceremony switch on, and no piloted daughter
   * holding the camera. Reduced motion is NOT a reason: it cuts instead (see `_beginCatchFocus`).
   * @returns {string|null}
   */
  _catchFocusRefusal() {
    const lc = this._ladderCam;
    if (!lc.active) return 'ladder camera is off';
    if (lc.riding) return 'ladder is changing level';
    if (lc.anchor !== 'ship' || (lc.floor != null && (lc.floor < 1 || lc.floor > 3))) return `level F${lc.floor} is a map`;
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return 'net ceremony is off';
    if (this.currentView === CameraViews.ARM_PILOT) return 'a daughter is piloted';
    return null;
  }

  /**
   * Start (or re-aim) the focus on a catch.
   * @param {'mother'|'daughter'|'lasso'} kind
   * @param {object|null} net - the NetProjectile that holds the catch (null for a lasso reel)
   * @param {object|null} d - the catch (needs `_scenePosition`); null for a daughter's empty reel (then `pos` is the shot)
   * @param {string} phase - first phase
   * @param {string} label - for the console line: `mother` | `daughter N` | `lasso`
   * @param {THREE.Vector3} [pos] - where the shot is when there is no catch (the daughter)
   * @private
   */
  _beginCatchFocus(kind, net, d, phase, label, pos, noFarCut = false) {
    const f = this._catchFocus;
    const lc = this._ladderCam;
    // A focus still engaged when another catch begins ends first, with its own `end` line (so every `start` has an `end`).
    if (f.active && f.engaging) {
      // the mother's own catch (or a lasso) took the shot: this waiting spell is done with it. Another DAUGHTER's catch
      // is not a mark: she gets the view back when that focus is released
      if (kind !== 'daughter' && f.spell && f.arm) this._waitViewOff.set(f.arm, f.spell.n);
      this._releaseCatchFocus('a new catch began');
    }
    if (f.takenOver) { f.u = 0; f.takenOver = false; f.camRelOk = false; }   // a camera input took the last one over: this is a fresh focus
    f.active = true; f.engaging = true; f.phase = phase; f.timer = 0;
    f.kind = kind; f.totalS = 0; f.collarS = 0;
    f.rate = 1 / CATCH_FOCUS.IN_S;
    f.net = net; f.debris = d; f.podIndex = net && net.podIndex != null ? net.podIndex : -1; f.tipIndex = -1;
    f.armIndex = -1; f.arm = null;
    f.reelView = false; f.reelSeen = false; f.reelSeq = 0; f.safeDist = 0; f.jumpRun = 0; f.spell = null;
    f.wantDist = CATCH_FOCUS.DIST_U; f.baseDist = CATCH_FOCUS.DIST_U; f.innerDist = 0; f.zoom = 1; f.zoomed = false;   // a fresh focus is a fresh shot: his earlier zoom is spent
    if (f.u <= 0) { f.off.set(0, 0, 0); f.dirSeeded = false; f.relSeeded = false; f.vel.set(0, 0, 0); f.dist = CATCH_FOCUS.DIST_U; f.look.set(0, 0, 0); f.hop.set(0, 0, 0); f.hopVel.set(0, 0, 0); }   // a fresh focus starts ON the mother
    // A CUT, not an ease: reduced motion asks for no camera travel, and a catch tens or hundreds of metres from the
    // camera's anchor (a daughter's, a far lasso) would take the anchor ease (TAU_S) seconds to cross, leaving the
    // camera far from it for the first ~2 s. The focus snaps in on its first frame and snaps out at its end.
    // The ship is read LIVE (an event fires mid-frame, before this frame's camera update, and `_lastPlayerPos` is the
    // previous frame's: the ship moves ~78 km/s in scene space, ~1.3 km stale at 60 fps).
    const p = this._player;
    const now = (p && p.position && p.position.isVector3) ? p.position : this._lastPlayerPos;
    const anchor = this._ladderShipAnchor(now, f.tmp);
    const at = (d && d._scenePosition) || pos;
    const far = !!at && anchor.distanceTo(at) > CATCH_FOCUS.FAR_CUT_U;
    f.cut = this._prefersReducedMotion() || (far && !noFarCut);   // wait view: eased in as he was told, however far she waits
    f.snapPending = f.cut;
    this._catchFocusLog(`start ${label} level F${lc.floor}${f.cut ? ' (cut)' : ''}`);
  }

  /** The player's own mother net has caught something, or a daughter's net has: come in on it (floors 1-3). */
  _onCatchFocusStart(payload) {
    if (!payload) return;
    const daughter = payload.armIndex != null && payload.armIndex >= 0;
    if (!daughter && (payload.podIndex == null || payload.podIndex < 0)) return;
    const label = daughter ? `daughter ${payload.armIndex}` : 'mother';
    const why = this._catchFocusRefusal();
    if (why) { this._catchFocusLog(`refused ${label}: ${why}`); return; }
    const cns = this._netSystemRef();
    let net = null;
    if (cns) {
      if (daughter && typeof cns.getActiveNetForArm === 'function') net = cns.getActiveNetForArm(payload.armIndex);
      else if (!daughter && typeof cns.getActiveNetForPod === 'function') net = cns.getActiveNetForPod(payload.podIndex);
      if ((!net || !net.targetDebris || (payload.debrisId != null && net.targetDebris.id !== payload.debrisId))
          && Array.isArray(cns.activeNets) && payload.debrisId != null) {
        net = cns.activeNets.find((n) => n.targetDebris && n.targetDebris.id === payload.debrisId) || net;
      }
    }
    const d = net && net.targetDebris;
    if (!d || !d._scenePosition) { this._catchFocusLog(`refused ${label}: no catch to look at`); return; }
    const on = this._catchFocus;
    if (daughter && on.active && on.engaging && on.phase === 'station' && on.armIndex === payload.armIndex) {
      // wait view: her net has caught her piece: the same focus goes on as her haul (no release, no cut, no hand-back)
      on.phase = 'haul'; on.timer = 0; on.totalS = 0; on.net = net; on.debris = d;
      this._catchFocusLog(`wait view daughter ${payload.armIndex} -> haul`);
      return;
    }
    if (on.active && on.engaging && on.debris === d) return;                // the same catch announced twice: already on it
    this._beginCatchFocus(daughter ? 'daughter' : 'mother', net, d, daughter ? 'haul' : 'reel', label);
    if (daughter) {
      const f = this._catchFocus;
      const arms = this._player && this._player.armManager && this._player.armManager.arms;
      f.armIndex = payload.armIndex;
      f.arm = (arms && arms[payload.armIndex]) || null;
      f.podIndex = -1;
    }
  }

  /** A lasso net has touched its piece: the camera comes in on it and follows the reel to the collar. */
  _onCatchFocusLassoStart(_p) {
    const why = this._catchFocusRefusal();
    if (why) { this._catchFocusLog(`refused lasso: ${why}`); return; }
    const ls = this._lassoSystem;
    const d = ls && ls.target;
    if (!d || !d._scenePosition) { this._catchFocusLog('refused lasso: no catch to look at'); return; }
    const on = this._catchFocus;
    if (on.active && on.engaging && on.debris === d) return;                // already on it
    this._beginCatchFocus('lasso', null, d, 'lasso', 'lasso');
  }

  /** The lasso line snapped or the cast failed while the camera is still on the reel. */
  _onCatchFocusLassoLost(reason) {
    const f = this._catchFocus;
    if (!f.active || !f.engaging || f.kind !== 'lasso' || f.phase !== 'lasso') return;
    this._releaseCatchFocus(reason);
  }

  /**
   * Ease the focus out after a normal end (the catch is processed, let go, or went to a rack). A cut focus (reduced
   * motion, a far catch) cuts back at once.
   * @param {string} [reason] printed as the one `end <reason>` line
   */
  _releaseCatchFocus(reason = 'done') {
    const f = this._catchFocus;
    if (!f.active || !f.engaging) return;
    // His zoom put the shot far from the mother (up to floor 3's edge): the ladder takes that pose over first, so the
    // ease-out is the ladder's own glide home from where the camera stands, not a flight across the whole distance.
    const took = this._focusZoomedDaughter() && this._takeOverCatchFocusPose();
    f.engaging = false;
    f.rate = 1 / CATCH_FOCUS.OUT_S;
    if (f.cut && !took) f.u = 0;
    this._catchFocusLog(`end ${reason}`);
  }

  /**
   * A player camera input (wheel, key, drag, jump): end the focus NOW and leave the camera to the ladder, which the
   * input is about to move. No walk back by itself beyond a short fade of the blend.
   * @param {string} [cause] printed as the one `cancel <cause>` line
   * @returns {boolean} true when a focus was engaged and has been cancelled
   */
  ladderCancelCatchFocus(cause = 'camera input') {
    const f = this._catchFocus;
    if (!f.active) return false;
    const was = f.engaging;
    if (was && f.kind === 'daughter' && f.arm) {
      // reel view: his own input ends it for THIS reel; before her reel has begun (still on the catch) that is the next one.
      // wait view: ending the waiting view must NOT touch this: her later reel home still gets the reel view (§35 row 4)
      if (f.phase !== 'station') {
        const seq = f.arm._rhReelSeq | 0;
        this._reelViewOff = { arm: f.arm, seq: (f.reelSeen || f.reelView) ? seq : seq + 1 };
      }
    }
    // wait view: HIS input (drag, zoom, wheel, Esc/Space/Enter, a number key, a floor jump) takes the view back to the
    // mother for good: every daughter waiting at this moment is marked off (else the next frame hands the view to another
    // waiting daughter). A new waiting spell may take it again. A ride, a level change or a piloted daughter are not his input.
    const internal = cause === 'ladder changing level' || cause === 'level changed' || cause === 'daughter piloted' || cause === 'trip start';
    if (was && !internal) this._markWaitSpellsOff();
    // His own camera input leaves the camera WHERE HE PUT IT: the ladder takes over from the pose on screen (no flight
    // back to the ladder view, up to 50 m in 0.3 s); only the look-at point fades back to the mother. The internal causes
    // (a ride, a level change, a piloted daughter) and the skip key still walk back. The same for any end that is not
    // internal when his zoom had moved the shot (Esc, a floor jump, ...). A piloted daughter ('daughter piloted': a
    // digit in the haul / held phase, or any other way into the pilot view) is internal for the wait-view mark, but when
    // his zoom had moved the shot the pose is just as owed to the ladder.
    const byInput = cause === 'camera input' || cause === 'mouse drag' || cause === 'touch drag'
      || ((!internal || cause === 'daughter piloted') && this._focusZoomedDaughter());
    const took = was && byInput && this._takeOverCatchFocusPose();
    f.engaging = false;
    f.rate = 1 / CATCH_FOCUS.CANCEL_S;                                    // also speeds up an ease-out already running
    if (f.cut && !took) f.u = 0;                                           // a cut focus cuts back (no 0.3 s zip over hundreds of metres)
    if (was) this._catchFocusLog(`cancel ${cause}`);
    return was;
  }

  /**
   * Hand the camera's drawn pose (relative to the mother) to the ladder: its direction becomes the ladder's local pose
   * and its distance the ladder's current and target distance, so the next frame draws exactly the same position with
   * the focus weight at 0. False (nothing taken) when no focus pose was drawn last frame, the camera stands farther than
   * TAKEOVER_MAX_U from the mother, or the ladder is not on a still ship anchor.
   * @private
   */
  _takeOverCatchFocusPose() {
    const f = this._catchFocus;
    const lc = this._ladderCam;
    if (f.takenOver) return true;
    if (!f.camRelOk || !(f.w > 0) || lc.anchor !== 'ship' || lc.riding) return false;
    const len = f.camRel.length();
    // his zoom may have put the camera anywhere up to floor 3's edge: that is a distance a floor holds, so no 100 m limit then
    if (!(len > 1e-9) || (len > CATCH_FOCUS.TAKEOVER_MAX_U && !this._focusZoomedDaughter())) return false;
    this._ladderWorldToLocal(f.v.copy(f.camRel).divideScalar(len), lc.local);
    lc.curDistU = len; lc.targetDistU = len;
    this._takeoverDistU = len;                                              // the controller puts the ladder's zoom state on it
    f.takenOver = true;
    lc.viewReturn.dirty = true;                                             // the pose handed back is off the default: it owes a return
    return true;
  }

  /**
   * The camera distance (scene units) a camera input took over from the catch focus, once; null when nothing is
   * pending. The ladder controller reads it to put the ladder's zoom state (floor, z01) on that distance.
   */
  ladderTakeoverDistU() {
    const d = this._takeoverDistU;
    this._takeoverDistU = null;
    return d > 0 ? d : null;
  }

  /** The near plane (m) in force while the camera is close to a daughter: the deep-zoom floor's own (FloorContract.DAUGHTER_ZOOM.NEAR_FLOOR). @private */
  _deepNearM() {
    const row = FloorContract.byId(FloorContract.DAUGHTER_ZOOM.NEAR_FLOOR);
    return row.camera.near / Constants.SCENE_UNITS_PER_METER;
  }

  /** The farthest his zoom may take the camera from her: floor 3's free zone outer edge (floors 4-5 never follow her). Scene units. @private */
  _focusZoomOuterU() {
    const row = FloorContract.byId(3);
    const [lo, hi] = row.camera.rangeLog10;
    return Math.pow(10, lo + (1 - FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC) * (hi - lo));
  }

  /**
   * Daughter focus (owner 2026-10-27, "zoom stays on her"): a wheel / pinch / key zoom moves the camera toward or away from
   * the shot and keeps the view on her. `zoom` is a factor on the shot's distance, bounded between the daughter limit
   * (FloorContract.daughterZoomLimitU: the one rule the follow-zoom uses too, raised for a big piece) and floor 3's outer
   * edge. Pure arithmetic over this frame's `baseDist` / `innerDist`; the frame's wanted distance then eases as it always did.
   * @private
   */
  _catchFocusZoomApply() {
    const f = this._catchFocus;
    f.baseDist = f.wantDist;
    f.zoomed = false;
    if (f.kind !== 'daughter' || f.zoom === 1) return;
    const base = f.baseDist;
    const inner = Math.max(FloorContract.daughterZoomLimitU(), f.innerDist || 0);
    const want = Math.min(this._focusZoomOuterU(), Math.max(inner, base * f.zoom));
    f.zoom = base > 0 ? want / base : 1;
    if (Math.abs(f.zoom - 1) < 1e-6) { f.zoom = 1; return; }               // back at the shot as framed: nothing of his is left
    f.wantDist = want;
    f.safeDist = inner;                                                    // the reel view's own floor gives way to his zoom: the near plane is the small one then
    f.zoomed = true;
  }

  /**
   * Daughter focus: one zoom notch from the ladder controller. The view stays on her (no hand-back, so no wait-spell mark).
   * @param {{dir:'in'|'out', mag:number, stepDecades:number}} z - `stepDecades`: decades of distance per unit of mag (the
   *   ladder's own step on this floor, so a notch feels the same)
   * @returns {boolean|'edge'} true: taken (the view stays on her); 'edge': she is already at floor 3's outer edge, zooming out
   *   past it ends the focus as before (the caller hands the distance to the ladder first); false: not a daughter focus
   *   (a mother or lasso catch, nothing up, a ride, a takeover) - the caller does what it always did
   */
  ladderCatchFocusZoom({ dir, mag, stepDecades }) {
    const f = this._catchFocus;
    const lc = this._ladderCam;
    if (!f.active || !f.engaging || f.kind !== 'daughter' || !f.arm || f.takenOver || lc.riding) return false;
    const factor = Math.pow(10, Math.abs(stepDecades) * Math.max(0, mag));
    const base = f.baseDist > 0 ? f.baseDist : CATCH_FOCUS.DIST_U;
    const outer = this._focusZoomOuterU();
    if (dir !== 'in' && base * f.zoom >= outer * (1 - 1e-9)) return 'edge';
    const inner = Math.max(FloorContract.daughterZoomLimitU(), f.innerDist || 0);
    const z = dir === 'in' ? f.zoom / factor : f.zoom * factor;
    f.zoom = Math.min(outer / base, Math.max(inner / base, z));            // no wind-up beyond either end
    if (Math.abs(f.zoom - 1) < 1e-6) f.zoom = 1;                           // back to the shot as framed: exactly, so its own floor is back
    return true;
  }

  /** The distance (scene units) the daughter focus's camera is at from her: for the controller to hand the ladder when a zoom out passes the edge. */
  catchFocusZoomOuterU() { return this._focusZoomOuterU(); }

  /** True while the daughter focus is zoomed in closer than the shot's own framing (the small near plane is then in
   *  force). Not while the focus is fading out: a ride then must not push the small near plane again. */
  catchFocusZoomIn() {
    const f = this._catchFocus;
    return !!(f.active && f.engaging && f.kind === 'daughter' && f.zoom < 1 - 1e-9);
  }

  /** The daughter focus holds a zoom of his (in or out): its distance is his, not the shot's. @private */
  _focusZoomedDaughter() {
    const f = this._catchFocus;
    return !!(f.active && f.kind === 'daughter' && f.zoom !== 1);
  }

  /** The net let go / the catch was lost / it went to a rack. */
  _onCatchFocusLost(p, reason = 'catch lost') {
    const f = this._catchFocus;
    if (!f.active || !f.engaging) return;
    if (f.kind === 'daughter' && f.reelView) return;                     // reel view: it ends with her reel (state), not with a net event
    if (f.phase === 'station') return;                                   // wait view: a missed net puts her back to waiting; her state ends it
    if (p && p.debrisId != null && f.debris && p.debrisId !== f.debris.id) return;
    if (p && p.podIndex != null && p.podIndex >= 0 && p.podIndex !== f.podIndex) return;
    this._releaseCatchFocus(reason);
  }

  /**
   * The furnace starts on the catch: a radiator tip keeps the focus (and names the tip). The nose collar's own furnace
   * keeps it too: the focus ends when the collar has eaten the catch, or at COLLAR_MAX_S.
   */
  _onCatchFocusBreakdown(p) {
    const f = this._catchFocus;
    if (!f.active || !f.engaging || !f.debris || !p || p.debrisId !== f.debris.id) return;
    if (p.anchor && p.anchor.kind === 'tip') {
      f.tipIndex = p.anchor.index;
      if (f.phase !== 'handoff' && f.phase !== 'end') { f.phase = 'tip'; f.timer = 0; }
    }
  }

  /** The furnace has eaten the catch: hold the place one more second, then go back. */
  _onCatchFocusProcessed(p) {
    const f = this._catchFocus;
    if (!f.active || !f.engaging || !f.debris || !p || p.debrisId !== f.debris.id || p.digested !== true) return;
    if (f.tipIndex < 0 && p.tipIndex != null) f.tipIndex = p.tipIndex;
    f.phase = 'end'; f.timer = 0;
  }

  /**
   * A lasso reel that has ended: the net that adopted the catch at the nose collar (podIndex 0, holds this piece), or
   * null while it is not there (yet).
   * @param {object} d - the catch
   */
  _adoptingNet(d) {
    const cns = this._netSystemRef();
    const nets = cns && cns.activeNets;
    if (!Array.isArray(nets)) return null;
    // Match by id, not by object identity: a net's `targetDebris` can be a different object (a snapshot) from the `d` the
    // focus holds, and identity then never found the adopting net (the "no net took the catch" bug).
    for (const n of nets) {
      const td = n && n.targetDebris;
      if (td && (td === d || (d && d.id != null && td.id === d.id)) && n.isActive !== false) return n;
    }
    return null;
  }

  /**
   * Has the catch at the nose collar settled for good? True once the collar's hand-off was tried and declined
   * (nothing is pending: no leash, no cut, no flight), so with no furnace nothing more will happen to it here.
   * @param {object|null} net - the mother net holding the catch
   */
  _collarCatchSettled(net) {
    if (!net || net.state !== 'COLLARED' || net._cargoDeclined !== true || net._leash || net._leashNoseReel) return false;
    const cns = this._netSystemRef();
    const cutting = cns && typeof cns._cutActive === 'function' ? cns._cutActive(net) : !!net._cutPlan;
    return !cutting;
  }

  /**
   * This frame's focus point (world, scene units) into `f.tgt`: the catch while it is reeled in, the middle of
   * collar and tip during the hand-off, the tip while it cooks. Moves the phase on, or lets go.
   * @returns {boolean} false when there is nothing to look at (the focus has been released)
   */
  _catchFocusPoint(dt) {
    const f = this._catchFocus;
    const player = this._player;
    f.wantDist = CATCH_FOCUS.DIST_U;
    if (f.phase === 'station') {
      const r = this._waitViewStep();
      if (r !== 'haul') return r;                                           // true: her waiting shot is in f.tgt; false: released
    }
    const d = f.debris;
    // a daughter's reel with nothing in the net has no catch to look at: the shot is her
    const emptyReel = f.kind === 'daughter' && f.arm && !d;
    if (!emptyReel && (!d || d.alive === false || !d._scenePosition)) {
      // a daughter on her reel keeps the view when the piece is gone (the net slipped): the shot is her
      if (!(f.kind === 'daughter' && f.arm && f.reelView)) { this._releaseCatchFocus('catch gone'); return false; }
    }
    f.totalS += dt;

    // A lasso reel: the camera rides the piece in to the collar. When the reel ends, the net that adopts it takes over
    // (a collar catch from there on); a catch with no net to adopt it lets go after a short grace.
    if (f.phase === 'lasso') {
      const ls = this._lassoSystem;
      if (!(ls && ls.active && ls.target && ls.target.id === d.id)) { f.phase = 'adopt'; f.timer = 0; }
    }
    if (f.phase === 'adopt') {
      const net = this._adoptingNet(d);
      if (net) {
        f.net = net; f.podIndex = net.podIndex != null ? net.podIndex : -1;
        f.phase = 'reel'; f.timer = 0;                                       // the mother collar logic below takes it from here
      } else {
        const pa = this._lassoSystem && this._lassoSystem._pendingAdoption;
        f.timer += dt;
        const pending = !!(pa && pa.target && pa.target.id === d.id);
        if (pending ? f.timer > CATCH_FOCUS.WAIT_S : f.timer > CATCH_FOCUS.ADOPT_GRACE_S) {
          this._releaseCatchFocus(pending ? 'collar stayed busy' : 'no net took the catch');
          return false;
        }
      }
    }
    if (f.phase === 'lasso' || f.phase === 'adopt') {
      f.tgt.copy(d._scenePosition);
      return true;
    }

    // A daughter's reel (reel view) or her catch on the way home: ride with her while she is wound in, then stay a short
    // while once she is latched at her strut.
    if (f.phase === 'haul' || f.phase === 'held') {
      const arm = f.arm;
      const st = arm && arm.state;
      const AS = Constants.ARM_STATES;
      const stage = arm && typeof arm.reelHomeStage === 'function' ? arm.reelHomeStage() : null;
      if (f.totalS > CATCH_FOCUS.DAUGHTER_MAX_S) { this._releaseCatchFocus('daughter haul took too long'); return false; }
      if (stage) { f.reelView = true; f.reelSeen = true; f.reelSeq = arm._rhReelSeq | 0; }
      if (f.spell && f.phase === 'haul' && !f.reelSeen && st === AS.STATION_KEEP) {
        // wait view: a failed catch left her waiting again (same spell): back to the waiting shot
        f.phase = 'station'; f.timer = 0; f.net = null;
        f.debris = arm._stationKeepTarget || arm.target || null;
        return this._waitViewStep() === true;
      }
      if (f.phase === 'haul' && st === AS.HOLDING_CATCH) { f.phase = 'held'; f.timer = 0; }
      else if (f.phase === 'haul' && f.reelSeen && !stage && (st === AS.DOCKED || st === AS.RELOADING)) { f.phase = 'held'; f.timer = 0; }
      else if (st === AS.EXPENDED || st === AS.DEORBITING || (!f.reelSeen && (st === AS.DOCKED || st === AS.RELOADING))) {
        this._releaseCatchFocus('daughter lost the catch');
        return false;
      }
      if (f.phase === 'held') {
        f.timer += dt;
        if (f.timer >= CATCH_FOCUS.DAUGHTER_HOLD_S) { this._releaseCatchFocus('daughter is home'); return false; }
      }
      if (f.reelView && arm) this._reelViewPoint(arm, d);
      else {
        f.tgt.copy(d._scenePosition);
        f.innerDist = (this._deepNearM() + CATCH_FOCUS.REEL_NEAR_CLEAR_M + 0.5 * ((d && d.sizeMeter) || 0)) * Constants.SCENE_UNITS_PER_METER;
      }
      return true;
    }

    const ld = player && player.leashDriver;
    const view = ld && typeof ld.view === 'function' ? ld.view() : null;
    const tc = player && player.tipCargo;
    const onView = !!(view && view.debris === d);
    const tipHolds = (i) => i >= 0 && tc && typeof tc.debrisAt === 'function' && tc.debrisAt(i) === d;
    const tipPoint = (i) => !!(i >= 0 && tc && typeof tc.latchWorldInto === 'function' && tc.latchWorldInto(i, f.tmp));

    if (f.phase === 'reel' || f.phase === 'wait') {
      const net = f.net;
      if (onView) { f.phase = 'handoff'; f.timer = 0; }
      else if (f.phase === 'reel' && net && (net.state === 'BERTHED' || net.state === 'COLLARED')) { f.phase = 'wait'; f.timer = 0; }
      else if (f.phase === 'wait') {
        // At the nose collar: a catch too big for a tip cooks right there, a rack catch leaves (CARGO_TRANSFER_START lets
        // go), a leash catch hands over to the tip phase below. It stays until the collar has processed it, or
        // COLLAR_MAX_S.
        f.timer += dt;
        f.collarS += dt;
        // With no furnace the collar never "processes" the catch: the focus ends END_HOLD_S after the catch has settled
        // there (hand-off declined, nothing pending) instead of waiting for a digest that cannot come.
        if (!Constants.isFeatureEnabled('FURNACE_COOK') && this._collarCatchSettled(f.net)) { f.phase = 'end'; f.timer = 0; }
        else if (f.collarS > CATCH_FOCUS.COLLAR_MAX_S) { this._releaseCatchFocus('collar time limit'); return false; }
      }
    }
    if (f.phase === 'handoff') {
      if (onView) {
        f.tipIndex = view.tipIndex != null ? view.tipIndex : f.tipIndex;
      } else if (tipHolds(f.tipIndex)) { f.phase = 'tip'; f.timer = 0; }
      else { f.phase = 'wait'; f.timer = 0; }                                 // the leash failed: the catch is back at the nose
    }
    if (f.phase === 'tip') {
      f.timer += dt;
      if (!tipHolds(f.tipIndex)) { this._releaseCatchFocus('tip let go of the catch'); return false; }
      // With no furnace the tip never digests the catch: the focus ends END_HOLD_S after the bag has settled on its tip
      // (the swing onto the boom is done and the leash hand-off has finished).
      const leashBusy = !!(ld && (typeof ld.isActive === 'function' ? ld.isActive() : ld.busy));
      const swinging = !!(tc && typeof tc.isSwinging === 'function' && tc.isSwinging(f.tipIndex));
      if (!Constants.isFeatureEnabled('FURNACE_COOK') && !leashBusy && !swinging) { f.phase = 'end'; f.timer = 0; }
      else if (f.timer > CATCH_FOCUS.TIP_MAX_S) { this._releaseCatchFocus('tip time limit'); return false; }
    }
    if (f.phase === 'end') {
      f.timer += dt;
      if (f.timer >= CATCH_FOCUS.END_HOLD_S) {
        this._releaseCatchFocus(Constants.isFeatureEnabled('FURNACE_COOK') ? 'processed' : 'settled');
        return false;
      }
    }

    if (f.phase === 'handoff') {
      const collar = player && typeof player.getNetBerthCollarPositionInto === 'function'
        ? player.getNetBerthCollarPositionInto(f.tgt) : null;
      if (collar && tipPoint(f.tipIndex)) {
        f.tgt.add(f.tmp).multiplyScalar(0.5);                               // the middle of collar and tip
        return true;
      }
    } else if ((f.phase === 'tip' || f.phase === 'end') && tipPoint(f.tipIndex)) {
      f.tgt.copy(f.tmp);
      return true;
    }
    f.tgt.copy(d._scenePosition);                                           // reel / wait (and the fallbacks)
    return true;
  }

  /**
   * Reel view: this frame's shot for a daughter being wound home: the middle of her and her catch (just her when
   * empty-handed), moving toward the strut tip in her last REEL_WIDEN_M, where the shot also widens to REEL_WIDE_M so
   * her latch onto the tip and the strut are in view. Writes `f.tgt` and `f.wantDist`.
   * @param {object} arm - the ArmUnit
   * @param {object|null} d - her catch, if any
   */
  _reelViewPoint(arm, d) {
    const f = this._catchFocus;
    const M = Constants.SCENE_UNITS_PER_METER;
    const pos = arm.position;
    f.tgt.copy(pos);
    let side = 0;
    if (d && d.alive !== false && d._scenePosition && d._scenePosition.distanceTo(pos) < 20 * M) {
      f.tgt.add(d._scenePosition).multiplyScalar(0.5);                     // between her and her catch
      side = d.sizeMeter || 0;
    }
    const tip = typeof arm.strutTipWorldInto === 'function' ? arm.strutTipWorldInto(f.q2c) : null;
    let k = 0;
    if (tip) {
      const sepM = pos.distanceTo(tip) / M;
      k = clamp01((CATCH_FOCUS.REEL_WIDEN_M - sepM) / CATCH_FOCUS.REEL_WIDEN_M);
      if (k > 0) f.tgt.lerp(tip, 0.5 * k);
    }
    // the shot stands so that the nearest point of her and her catch is clear of the near plane
    let reachM = f.tgt.distanceTo(pos) / M + CATCH_FOCUS.REEL_ARM_R_M;
    if (side > 0) reachM = Math.max(reachM, f.tgt.distanceTo(d._scenePosition) / M + side / 2);
    f.innerDist = (this._deepNearM() + CATCH_FOCUS.REEL_NEAR_CLEAR_M + reachM) * M;   // his zoom: the same clearance rule on the small near plane, without the braking lag
    reachM += CATCH_FOCUS.REEL_LAG_M;
    const lc = this._ladderCam;
    const base = reelViewDistM({ sizeM: side, reachM, nearM: floorNearM(lc && lc.floor) }) * M;
    f.safeDist = base;                                                     // the pose below never goes nearer than this
    let want = base;
    if (k > 0) want = base + k * Math.max(0, CATCH_FOCUS.REEL_WIDE_M * M - base);
    f.wantDist = want;
  }

  /**
   * wait view (DECISIONS §46 row 1): her states that are part of one waiting spell. A spell runs from her first
   * STATION_KEEP through her capture and reel home; any other state (DOCKED, EXPENDED, DEORBITING, TRANSIT, RETURNING
   * on the FEEP flight ...) ends it, and the next STATION_KEEP is a new spell.
   */
  _waitSpellState(st) {
    const AS = Constants.ARM_STATES;
    return st === AS.STATION_KEEP || st === AS.NETTING || st === AS.PAD_CONTACT || st === AS.MAGNETIC_GRAPPLE
      || st === AS.GRIPPER_GRAPPLE || st === AS.GRAPPLED || st === AS.HAULING || st === AS.REELING
      || st === AS.HOLDING_CATCH || st === AS.APPROACH || st === AS.DOCKING;
  }

  /** wait view: mark off every waiting spell that is live right now (he took the view back; none of them gets it again). */
  _markWaitSpellsOff() {
    for (const [a, rec] of this._waitSpells) if (rec.live) this._waitViewOff.set(a, rec.n);
  }

  /** Count each daughter's waiting spells by reading her state (no event: every path into STATION_KEEP counts). */
  _trackWaitSpells(arms) {
    const SK = Constants.ARM_STATES.STATION_KEEP;
    for (const a of arms) {
      if (!a) continue;
      let rec = this._waitSpells.get(a);
      if (a.state === SK) {
        if (!rec || !rec.live) { rec = { n: ++this._waitSpellSeq, live: true }; this._waitSpells.set(a, rec); }
      } else if (rec && rec.live && !this._waitSpellState(a.state)) rec.live = false;
    }
  }

  /**
   * wait view: each frame, give the view to a daughter who waits for N (STATION_KEEP) when nothing holds the shot, the
   * ladder is on floors 1-3 and no one flies a daughter. Oldest waiting spell first. Never marks or logs a refusal:
   * it simply starts later, when the refusal clears.
   */
  _pollWaitView() {
    const arms = this._player && this._player.armManager && this._player.armManager.arms;
    if (!Array.isArray(arms)) return;
    this._trackWaitSpells(arms);
    const f = this._catchFocus;
    if (f.active && f.engaging) return;                                    // a catch focus (or an older waiting view) holds the shot
    if (this.currentView === CameraViews.ARM_PILOT || this._ladderFollowTarget() || this.isIonStartupActive()) return;
    const lc = this._ladderCam;
    if (!lc.active || lc.riding || this._catchFocusRefusal()) return;
    const SK = Constants.ARM_STATES.STATION_KEEP;
    const off = this._waitViewOff;
    let best = null, bestRec = null, bestPiece = null;
    for (const a of arms) {
      if (!a || a.state !== SK) continue;
      const rec = this._waitSpells.get(a);
      if (!rec || !rec.live) continue;
      if (off.get(a) === rec.n) continue;                                  // he ended the view of this spell
      const piece = a._stationKeepTarget || a.target;
      if (!piece || piece.alive === false || !piece._scenePosition) continue;
      if (!best || rec.n < bestRec.n) { best = a; bestRec = rec; bestPiece = piece; }
    }
    if (!best) return;
    // eased in as he was told ("view eases to a daughter"), however far she waits: a cut only for reduced motion
    this._beginCatchFocus('daughter', null, bestPiece, 'station', `wait view daughter ${best.index}`, best.position, true);
    f.armIndex = best.index; f.arm = best; f.podIndex = -1; f.spell = bestRec;
  }

  /**
   * wait view: one frame of a 'station' focus. Keeps the shot on her and her piece while she waits and while her capture
   * runs (firing moves her SK -> NETTING before any catch event), hands over to the haul phase on her reel home or her
   * hold at the strut, and lets go when she stops waiting without a capture.
   * @returns {boolean|'haul'} true: the shot is in `f.tgt`; false: released; 'haul': converted, carry on as a haul
   */
  _waitViewStep() {
    const f = this._catchFocus;
    const arm = f.arm;
    const AS = Constants.ARM_STATES;
    if (!arm) { this._releaseCatchFocus('waiting daughter is gone'); return false; }
    const st = arm.state;
    const stage = typeof arm.reelHomeStage === 'function' ? arm.reelHomeStage() : null;
    if (stage || st === AS.HOLDING_CATCH) {
      // her reel home (or her hold at the strut): the same focus goes on as her haul. The wait may have run longer than
      // DAUGHTER_MAX_S, so the haul's clock starts now.
      f.phase = 'haul'; f.timer = 0; f.totalS = 0; f.debris = arm.capturedDebris || null;
      if (stage) { f.reelView = true; f.reelSeen = true; f.reelSeq = arm._rhReelSeq | 0; }
      this._catchFocusLog(`wait view daughter ${arm.index} -> haul`);
      return 'haul';
    }
    const sk = st === AS.STATION_KEEP;
    const capturing = st === AS.NETTING || st === AS.PAD_CONTACT || st === AS.MAGNETIC_GRAPPLE || st === AS.GRIPPER_GRAPPLE
      || st === AS.GRAPPLED || st === AS.HAULING || st === AS.REELING || st === AS.APPROACH;
    if (!sk && !capturing) { this._releaseCatchFocus('she stopped waiting'); return false; }
    let piece = arm.capturedDebris || arm._stationKeepTarget || arm.target || null;
    if (piece && (piece.alive === false || !piece._scenePosition)) piece = null;
    if (sk && !piece) {
      // her piece is gone while she waits: nothing to wait for. Marked off so it does not restart on the same frame.
      if (f.spell) this._waitViewOff.set(arm, f.spell.n);
      this._releaseCatchFocus('her piece is gone');
      return false;
    }
    f.debris = piece;
    this._reelViewPoint(arm, piece);                                       // her and her piece, with the reel view's framing and distance rules
    return true;
  }

  /**
   * wait view: a number key (or any other "I will take it from here" input that reaches the camera by name) ends the
   * waiting view for this spell. Does nothing for any other focus.
   * @returns {boolean} true when a waiting view was up and has been ended
   */
  endWaitView(cause = 'number key') {
    const f = this._catchFocus;
    if (!f.active || !f.engaging || f.phase !== 'station') return false;
    return this.ladderCancelCatchFocus(cause);
  }

  /**
   * wait view: the daughter the view is on while she waits (STATION_KEEP): N works her (DECISIONS §46 row 2).
   * @returns {object|null} her ArmUnit, or null
   */
  getWaitViewArm() {
    const f = this._catchFocus;
    if (!f.active || !f.engaging || f.kind !== 'daughter' || !f.arm) return null;
    if (f.phase !== 'station' && f.phase !== 'haul') return null;
    return f.arm.state === Constants.ARM_STATES.STATION_KEEP ? f.arm : null;
  }

  /**
   * Reel view: look for new reels each frame (by reading arm state; no event). Starts the view on the NEWEST daughter
   * on a reel home, floors 1-3, unless he ended the view of that reel; a view already on an older reel moves to the new one.
   */
  _pollReelView() {
    const f = this._catchFocus;
    const arms = this._player && this._player.armManager && this._player.armManager.arms;
    if (!Array.isArray(arms)) return;
    // Never while he pilots a daughter (1-4): the pilot view owns the camera. Nothing is marked as refused, so when he
    // leaves the pilot view while her reel still runs the view starts then.
    if (this.currentView === CameraViews.ARM_PILOT || this._ladderFollowTarget()) return;
    let best = null;
    for (const a of arms) {
      if (!a || typeof a.reelHomeStage !== 'function' || a.reelHomeStage() !== 'reel') continue;
      if (!best || (a._rhReelSeq | 0) > (best._rhReelSeq | 0)) best = a;
    }
    if (!best) return;
    const seq = best._rhReelSeq | 0;
    const off = this._reelViewOff;
    if (off && off.arm === best && off.seq >= seq) return;                 // he ended this reel's view (or it was refused)
    if (f.active && f.engaging) {
      if (f.kind === 'daughter' && f.arm !== best && seq > (f.reelSeq | 0)) {   // two reels at once: follow the newest
        f.arm = best; f.armIndex = best.index; f.debris = best.capturedDebris || null; f.phase = 'haul'; f.timer = 0;
        f.reelView = true; f.reelSeen = true; f.reelSeq = seq; f.spell = null; f.totalS = 0;
        this._catchFocusLog(`reel view moves to daughter ${best.index}`);
      }
      return;                                                              // another focus (a mother catch, a lasso) keeps the shot
    }
    const lc = this._ladderCam;
    if (!lc.active || lc.riding) return;
    const why = this._catchFocusRefusal();
    if (why) { this._reelViewOff = { arm: best, seq }; this._catchFocusLog(`refused reel view daughter ${best.index}: ${why}`); return; }
    this._beginCatchFocus('daughter', null, best.capturedDebris || null, 'haul', `reel view daughter ${best.index}`, best.position);
    f.armIndex = best.index; f.arm = best; f.podIndex = -1;
    f.reelView = true; f.reelSeen = true; f.reelSeq = seq;
  }

  /**
   * Where the camera looks FROM, as a unit direction out of the focus point: OUTSIDE the ship, along the line
   * mother -> focus point, so the hull is behind the shot and never between the camera and the catch (measured:
   * from the ladder's usual behind-and-above seat the barrel and the solar panels hid the catch in most hand-off
   * frames). Eased like the anchor, and kept off the radial pole so the up vector never flips.
   */
  _catchFocusAim(k, playerPos) {
    const f = this._catchFocus;
    const out = f.v.copy(f.off);                                           // mother -> focus point
    if (out.lengthSq() < 1e-20) return;
    out.normalize();
    const R = this._radialDir;                                            // set by update() this frame
    if (f.reelView) {
      // Off the line, so her tail glow is side-on. Turned about the radial it is a true REEL_OFF_DEG only for a line
      // about square to the radial; within ~60 deg of it the turn shrinks (measured 9 deg at 26 deg off the radial).
      // Then tilt away from the pole about the axis square to both instead.
      const th = degToRad(CATCH_FOCUS.REEL_OFF_DEG);
      const line = f.q2a.copy(out);
      out.applyAxisAngle(R, th);
      if (line.dot(out) > Math.cos(th * 0.85)) {
        const ax = f.q2b.crossVectors(R, line);
        if (ax.lengthSq() > 1e-10) { out.copy(line).applyAxisAngle(ax.normalize(), line.dot(R) >= 0 ? th : -th); }
      }
    }
    const a = out.dot(R);
    const POLE = 0.94;                                                     // ~20 deg off the radial
    if (Math.abs(a) > POLE) {
      out.addScaledVector(R, -a);                                          // keep its horizontal part
      if (out.lengthSq() < 1e-12) out.copy(this._ladderCam.dir).addScaledVector(R, -this._ladderCam.dir.dot(R));
      out.normalize().multiplyScalar(Math.sqrt(1 - POLE * POLE)).addScaledVector(R, a > 0 ? POLE : -POLE);
    }
    if (!f.dirSeeded) { f.dir.copy(this._ladderCam.dir); f.dirSeeded = true; f.azKeepAim.set = false; }
    this._catchFocusBlendDir(f.dir, out, k, f.dir, f.azKeepAim);
  }

  /**
   * Blend two unit directions by weight t WITHOUT passing the radial pole: the azimuth about the radial turns the short
   * way (180 deg apart: always the same way, so it is steady) and the elevation is blended on its own (so it stays
   * between the two ends, which the focus aim keeps outside the ~20 deg pole cone). A plain slerp or lerp between two
   * directions on opposite sides of the ship passes over the pole, where camera.up (= the radial) flips the view.
   * @param {THREE.Vector3} a - from (unit)
   * @param {THREE.Vector3} b - to (unit)
   * @param {number} t - 0..1
   * @param {THREE.Vector3} out - may be a or b
   */
  _catchFocusBlendDir(a, b, t, out, keep = null) {
    const R = this._radialDir;
    const f = this._catchFocus;
    const sa = Math.max(-1, Math.min(1, a.dot(R))), sb = Math.max(-1, Math.min(1, b.dot(R)));
    const ha = f.q2a.copy(a).addScaledVector(R, -sa);                       // horizontal parts
    const hb = f.q2b.copy(b).addScaledVector(R, -sb);
    const la = ha.length(), lb = hb.length();
    if (la < 1e-6 && lb < 1e-6) { ha.copy(this._ladderCam.dir).addScaledVector(R, -this._ladderCam.dir.dot(R)); hb.copy(ha); }
    else if (la < 1e-6) ha.copy(hb);
    else if (lb < 1e-6) hb.copy(ha);
    if (ha.lengthSq() < 1e-12) { ha.set(1, 0, 0).addScaledVector(R, -R.x); if (ha.lengthSq() < 1e-12) ha.set(0, 1, 0).addScaledVector(R, -R.y); }
    ha.normalize(); hb.normalize();
    let ang = Math.atan2(f.q2c.crossVectors(ha, hb).dot(R), ha.dot(hb));    // signed, about the radial
    if (keep && keep.set) {
      // The DRAWN blend keeps its turn continuous: the angle within half a turn of last frame's (both the DRAWN blend and
      // the aim's step toward the focus direction). The side rule below flips the way round when the angle leaves the
      // near-opposite band on the far side, a jump of 2 pi x t in the azimuth (measured: a 9.7 deg one-frame blip of the
      // reel view when a daughter's shot comes round to the far side of the ship).
      ang += 2 * Math.PI * Math.round((keep.ang - ang) / (2 * Math.PI));
    } else if (Math.abs(ang) > Math.PI - 0.35) {
      // near opposite the short way is a coin toss that noise would flip every frame: keep the side last taken
      if (ang * f.azSide < 0) ang += f.azSide * 2 * Math.PI;
    } else f.azSide = ang >= 0 ? 1 : -1;
    if (keep) { keep.ang = keep.shrink ? ang * (1 - t) : ang; keep.set = true; }
    const az = ang * t;
    const el = lerp(sa, sb, t);                                         // sin(elevation): between the ends, so never nearer the pole than the nearer end
    // horizontal direction turned by az about R:  h cos + (R x h) sin
    const cx = f.q2c.crossVectors(R, ha);
    out.copy(ha).multiplyScalar(Math.cos(az)).addScaledVector(cx, Math.sin(az));
    return out.normalize().multiplyScalar(Math.sqrt(1 - el * el)).addScaledVector(R, el);
  }

  /**
   * Per ladder frame: advance the blend and ease the focus point. Runs before the pose is written.
   * @param {number} dt - real seconds
   */
  _updateCatchFocus(dt, playerPos) {
    const f = this._catchFocus;
    this._pollReelView();                                                  // a daughter wound home gets the shot (reel view)
    this._pollWaitView();                                                  // wait view: a daughter waiting for N gets it when nothing else holds it
    if (!f.active) { f.w = 0; f.wa = 0; f.azKeep.set = false; return; }
    const lc = this._ladderCam;
    if (f.engaging) {
      const gone = lc.anchor !== 'ship' || (lc.floor != null && (lc.floor < 1 || lc.floor > 3));
      if (gone || lc.riding || this.currentView === CameraViews.ARM_PILOT || this._ladderFollowTarget()) {
        this.ladderCancelCatchFocus(lc.riding ? 'ladder changing level' : gone ? 'level changed' : 'daughter piloted');
      } else if (f.kind === 'daughter' && f.phase === 'station' && this.isIonStartupActive()) {
        // A trip began (the engines light) while the view waits on a daughter: the mother has the view again. The wait
        // view only (a catch already being hauled keeps its rules); an internal cause, so it is not his input (no spell
        // marked off by it). THIS waiting spell is marked off here, so the view stays on the mother for the trip and does
        // not go back to her when the start-up ends; a new waiting spell later may take it. `_reelViewOff` is not touched.
        if (f.spell && f.arm) this._waitViewOff.set(f.arm, f.spell.n);
        this.ladderCancelCatchFocus('trip start');
      } else if (this._catchFocusPoint(dt)) {
        f.tgt.sub(playerPos);                                              // a point on the mother's own frame
        // a hop bigger than HOP_CUT_U (two reels 30 m apart) is a CUT, like a far catch: easing it would sweep the camera
        // round the ship at 6 deg a frame for a second
        let hopCut = false;
        if (!f.snapPending && f.relSeeded && dt > 0) {
          const dd = focusPointJump(f.tgt, f.rel, f.vel, dt, f.aim);   // the jump off the point's own predicted path, not its speed
          hopCut = dd > CATCH_FOCUS.HOP_CUT_U && dd / dt >= CATCH_FOCUS.LEAD_MAX_U_S;
        }
        const snap = f.snapPending || hopCut;
        const k = (snap || dt <= 0) ? 1 : 1 - Math.exp(-dt / CATCH_FOCUS.TAU_S);
        // A first-order ease trails a moving point by v * TAU (1.2 m behind a catch reeled at 2 m/s, which put the camera
        // 7.1 m from it, not 6): lead the aim by the point's own (filtered) velocity, so the ease keeps its soft feel and
        // the lag goes. A hop between phases is not a velocity: it keeps the last estimate.
        if (f.relSeeded && dt > 0) {
          const jump = focusPointJump(f.tgt, f.rel, f.vel, dt, f.q2b);   // off its own predicted path
          f.aim.copy(f.tgt).sub(f.rel).multiplyScalar(1 / dt);
          if (jump / dt < CATCH_FOCUS.LEAD_MAX_U_S) {
            f.vel.lerp(f.aim, 1 - Math.exp(-dt / CATCH_FOCUS.LEAD_FILTER_S));
            f.jumpRun = 0;
          } else {
            // a HOP of the focus point: bridged below. The part the filtered velocity already predicts is motion, not a
            // hop: a reeled daughter cruises at up to 60 m/s and used to count as one hop per frame.
            // A view that starts (or cuts) while she is already fast has a filtered velocity of 0, so EVERY frame is a
            // "jump" and the velocity was never updated (the camera trailed her by 5-36 m). A hop is ONE frame: the same
            // measured velocity VEL_ACCEPT_N frames running is motion, and the filtered velocity takes it.
            f.jumpRun = (f.jumpRun > 0 && f.lastMeas.distanceTo(f.aim) <= CATCH_FOCUS.VEL_AGREE * f.aim.length()) ? f.jumpRun + 1 : 1;
            f.lastMeas.copy(f.aim);
            if (f.jumpRun >= CATCH_FOCUS.VEL_ACCEPT_N) { f.vel.copy(f.aim); f.jumpRun = 0; }
            else f.hop.addScaledVector(f.q2b, -1);                         // q2b = the jump (tgt - predicted), see focusPointJump
          }
        } else f.jumpRun = 0;
        f.rel.copy(f.tgt);
        f.relSeeded = true;
        // The focus point HOPS (collar -> middle of collar and tip -> tip, a second catch while a focus runs, a newer
        // reel, her catch -> her reel). Everything below (the look-at point, the camera's anchor, its direction) would
        // chase the raw point, so a hop was a step in all of them at once (measured: 3.9 deg of camera turn in the first
        // frame of a 15 m hop; with the aim weight near 1 a look-at that copied the point turned it in ONE frame). The
        // step is carried in `hop` instead and eased out, critically damped, so it starts at rest: the point everything
        // below chases is continuous. Ordinary motion passes through untouched (no lag added to a reeled-in catch). A
        // cut (and a fresh focus's first frame) lands on the point.
        if (snap || dt <= 0) { f.hop.set(0, 0, 0); f.hopVel.set(0, 0, 0); if (snap) f.jumpRun = 0; }
        else if (f.hop.lengthSq() > 1e-24 || f.hopVel.lengthSq() > 1e-24) {
          const T = CATCH_FOCUS.LOOK_SMOOTH_S, om = 2 / T, x = om * dt;
          const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
          f.q2b.copy(f.hopVel).addScaledVector(f.hop, om).multiplyScalar(dt);   // temp
          f.hopVel.addScaledVector(f.q2b, -om).multiplyScalar(e);
          f.hop.add(f.q2b).multiplyScalar(e);
        }
        f.tgt.add(f.hop);
        f.look.copy(f.tgt);
        f.aim.copy(f.look).addScaledVector(f.vel, CATCH_FOCUS.TAU_S);
        f.off.lerp(f.aim, k);                                              // a cut (k = 1) lands on the catch this frame
        this._catchFocusZoomApply();                                       // daughter focus: his zoom on the shot's distance
        f.dist += (f.wantDist - f.dist) * k;
        this._catchFocusAim(k, playerPos);
        if (snap) { f.snapPending = false; f.u = 1; f.azKeepAim.set = false; f.azKeep.set = false; }   // ... at full weight: the camera is there NOW
      }
    }
    f.u = clamp01(f.u + (f.engaging ? 1 : -1) * dt * f.rate);
    const ww = catchFocusWeights(f.u);                                     // aim first (wa), the camera position follows (w)
    f.w = f.takenOver ? 0 : ww.pos; f.wa = ww.aim;                         // taken over: the ladder owns the position, the look-at fades
    if (!(f.w > 0)) f.azKeep.set = false;
    if (!f.engaging && f.u <= 0) this._resetCatchFocus();
  }

  /**
   * Warp-feed rule (hub wire in main.js): while a cross-anchor ride is going UP (ship→Earth), and until its post-ride
   * level phase completes, the DEPARTURE floor's timeCap must keep driving the TimeAuthority, so the time-lapse engages
   * only after arrival + leveling, never during the flight. Down-rides keep the existing destination pre-ramp (time
   * settles first).
   * @returns {number|null} the departure floor id to hold, or null (the core's current floor drives, as before)
   */
  ladderWarpHoldFloor() {
    const lc = this._ladderCam;
    if (!lc.active) return null;
    if (lc.riding && lc.rideAnchorFrom === 'ship' && lc.anchor === 'earth') return lc.rideFloorFrom;
    if (lc.leveling) return lc.levelHoldFloor;
    return null;
  }

  isLadderLeveling() { return this._ladderCam.leveling; }

  /** @private world position of the frame anchor (Earth centre = scene origin;
   *  ship = the live player position). Writes into `out` and returns it. */
  _anchorWorld(anchor, playerPos, out) {
    return anchor === 'earth' ? out.set(0, 0, 0) : this._ladderShipAnchor(playerPos, out);
  }

  /** @private Forget the follow target (engage / disengage): the next frame starts on the mother and, if she is
   *  piloting, blends from there. */
  _ladderResetFollow() {
    const lc = this._ladderCam;
    lc.followArm = null;
    lc.followT = 1;
    lc.followFromOff.set(0, 0, 0);
    lc.followLastOff.set(0, 0, 0);
  }

  /**
   * @private Who the ship anchor rides with RIGHT NOW (DECISIONS §15). The piloted daughter while the ladder stands on
   * floor 2 or 3, the view is ARM_PILOT and she is out flying; null (= the mother) otherwise. Floor 1 stays on the
   * mother: the workbench, hull outline and dimming there are hers (_ladderApplyInspectFx). 'earth' floors never ask.
   * Read-only.
   */
  _ladderFollowTarget() {
    const lc = this._ladderCam;
    if (lc.floor !== 2 && lc.floor !== 3) return null;
    if (this.currentView !== CameraViews.ARM_PILOT) return null;
    const arm = this.armPilot.arm;
    if (!arm || !arm.position) return null;
    if (arm.state === 'DOCKED' || arm.state === 'EXPENDED') return null;   // lost → back to the mother
    return arm;
  }

  /**
   * The daughter the ladder camera rides with right now (floors 2-3, piloted, out flying), or null. Public read for
   * the ladder controller: while it is set, zooming in on floor 2 stops at the daughter limit instead of crossing
   * to floor 1 (owner 2026-10-27; FloorContract.DAUGHTER_ZOOM). Read-only.
   */
  ladderFollowedDaughter() { return this._ladderFollowTarget(); }

  /**
   * @private The ship-anchor OFFSET from the live mother position (scene units), the ONE resolver behind _anchorWorld
   * and _ladderAnchorPos so the two readers cannot drift. Target offset = the followed daughter's live position minus
   * the mother's (zero for the mother), eased from the offset captured when the target last changed over
   * SUBJECT_REAIM_MS (cubic in-out, the one curve). The blend is in offsets, so the anchor rides with the ship: a lerp
   * between frozen world points would fall behind it (see the "no position lerp" note in update()). Read-only apart
   * from `out`; `out` must not be `playerPos`.
   */
  _ladderShipOffset(playerPos, out) {
    const lc = this._ladderCam;
    const arm = lc.followArm;
    if (arm && arm.position) out.copy(arm.position).sub(playerPos); else out.set(0, 0, 0);
    if (lc.followT < 1) out.sub(lc.followFromOff).multiplyScalar(cubicInOut(lc.followT)).add(lc.followFromOff);
    return out;
  }

  /** @private The ship anchor in world space (mother, or the blended daughter). */
  _ladderShipAnchor(playerPos, out) {
    return this._ladderShipOffset(playerPos, out).add(playerPos);
  }

  /** @private THE ladder up-frame rule (single source): Earth-north (0,1,0) for an 'earth' anchor, roll-free radial for
   *  a ship anchor. Used by BOTH the on-floor branch and the cross-anchor ride interpolation endpoints of
   *  _updateLadderCamera, so the two can never drift apart. Writes `out`. */
  _ladderUpFor(anchor, radialDir, out) {
    return anchor === 'earth' ? out.set(0, 1, 0) : out.copy(radialDir);
  }

  /**
   * @private Write camera.up = slerp(fromUp → toUp, e) (unit vectors, e in 0..1).
   * Endpoints are exact (e ≤ 0 → fromUp, e ≥ 1 → toUp). setFromUnitVectors is
   * robust to the near-antiparallel (dot ≈ −1) case (it picks an orthogonal
   * axis), so a ship at the sub-Earth pole doesn't blow up the nlerp; the
   * already-aligned case short-circuits (avoids a degenerate quat).
   */
  _ladderSlerpUp(fromUp, toUp, e) {
    const lc = this._ladderCam;
    if (e >= 1 || fromUp.dot(toUp) > 0.999999) { this.camera.up.copy(toUp); return; }
    if (e <= 0) { this.camera.up.copy(fromUp); return; }
    lc._upQuat.setFromUnitVectors(fromUp, toUp);
    lc._upQuatE.identity().slerp(lc._upQuat, e);
    this.camera.up.copy(fromUp).applyQuaternion(lc._upQuatE).normalize();
  }

  /** @private world position of the frame anchor. */
  _ladderAnchorPos(anchor) {
    // Earth centre = scene origin (radialDir is playerPos.normalize()). The ship
    // anchor uses the live cached player position.
    if (anchor === 'earth') return this._tmpVecA.set(0, 0, 0);
    return this._ladderShipAnchor(this._lastPlayerPos, this._tmpVecA);
  }

  /**
   * Build the ship's live orbital frame into lc._R/_T/_N. R = radialDir; T = velDir orthogonalized against R
   * (Gram-Schmidt: identical to velDir on a circular orbit, and it keeps the frame orthonormal so the engage-time
   * projection reproduces the pose exactly); N = R × T (unit, right-handed). A degenerate velocity (zero, or parallel
   * to R) falls back to the PREVIOUS T re-orthogonalized against the new R, so the frame never collapses.
   * @private
   */
  _ladderShipFrame(radialDir, velDir) {
    const lc = this._ladderCam;
    const R = lc._R.copy(radialDir);
    const T = lc._T;
    const c = lc._frameTmp;
    if (velDir && velDir.lengthSq() > 1e-12) c.copy(velDir); else c.copy(T);
    c.addScaledVector(R, -c.dot(R));
    if (c.lengthSq() < 1e-12) {
      c.copy(T).addScaledVector(R, -T.dot(R));
      if (c.lengthSq() < 1e-12) c.set(0, 1, 0).addScaledVector(R, -R.y);
      if (c.lengthSq() < 1e-12) c.set(1, 0, 0).addScaledVector(R, -R.x);
    }
    T.copy(c).normalize();
    lc._N.crossVectors(R, T);
  }

  /** @private local (r,t,n) → unit world direction on the CURRENT frame. */
  _ladderLocalToWorld(local, out) {
    const lc = this._ladderCam;
    return out.set(0, 0, 0)
      .addScaledVector(lc._R, local.x)
      .addScaledVector(lc._T, local.y)
      .addScaledVector(lc._N, local.z)
      .normalize();
  }

  /** @private unit world direction → local (r,t,n) on the CURRENT frame. */
  _ladderWorldToLocal(dir, out) {
    const lc = this._ladderCam;
    return out.set(dir.dot(lc._R), dir.dot(lc._T), dir.dot(lc._N)).normalize();
  }

  /**
   * @private The canonical chase-behind local pose: behind (t < 0) and slightly above (r > 0, n = 0) with the elevation
   * of the shipped CHASE offset (offsetAbove / offsetBehind), so an Earth→ship descent lands where the shipped chase
   * camera would sit.
   */
  _ladderChaseLocal(out) {
    return out.set(this.chase.offsetAbove, -this.chase.offsetBehind, 0).normalize();
  }

  /**
   * F1 (HULL CAM) inspect side-effect absorption (T6). The five side-effects
   * of the OVERVIEW zoom Schmitt's _setInspectZoom(true) become
   * the 2/1 down-hump's ARRIVAL effects and their inverses the up-hump's
   * DEPARTURE effects, keyed on the engaged ladder frame's floor id:
   *   1. FOV narrow — no code here: the ride engine already lerps to floor 1's
   *      contract fov 35 and restores floor 2's 55 on the up-hump.
   *   2. Dynamic near-plane — no code here: SceneManager's per-floor render
   *      block applies/restores floor 1's camera.near via setLadderFloorFidelity.
   *   3. Background dim — the _applyInspectDim path, both directions.
   *   4. Hull overlays — INSPECTION_TOGGLE + INSPECT_HULL_OUTLINE events, so
   *      MotherCallouts and the hull outline keep working UNMODIFIED.
   *   5. Onboarding — MOTHER_INSPECTION_ENGAGED on each floor 1 arrival (mirrors
   *      _setInspectZoom, which fires it on every engage, never exit) + the
   *      one-shot SHOW_NOTIFICATION learning beat (the shared
   *      orbit.inspectTaught flag, so zoom-path and ladder-path teach once).
   * Idempotent per state flip. While the ladder is engaged the shipped
   * 12/18 m Schmitt is bypassed (_evaluateInspectZoom), so the floor 1/2
   * wall/entry pair fully replaces it. Flag-off: the ladder never engages →
   * never called → shipped behavior byte-identical.
   * @param {number|null|undefined} floor - engaged floor id (null = disengage)
   * @private
   */
  _ladderApplyInspectFx(floor) {
    const lc = this._ladderCam;
    const on = (floor === 1);   // HULL CAM (id 1 since the Session H renumber)
    if (on === lc.inspectFxActive) return;
    lc.inspectFxActive = on;
    if (on) {
      this._applyInspectDim(true);
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'mother', targetId: null });
      eventBus.emit(Events.INSPECT_HULL_OUTLINE, { visible: true });
      eventBus.emit(Events.MOTHER_INSPECTION_ENGAGED, {});
      if (!this.orbit.inspectTaught) {
        this.orbit.inspectTaught = true;
        if (this.testsSwitch) eventBus.emit(Events.SHOW_NOTIFICATION, { text: '🔍 INSPECTION. Overlays active', kind: 'inspect' });   // developer line
      }
    } else {
      this._applyInspectDim(false);
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'mother' });
      eventBus.emit(Events.INSPECT_HULL_OUTLINE, { visible: false });
    }
  }

  /**
   * Per-frame ladder camera driver (called from update() when engaged).
   * @param {number} dt - real seconds
   * @param {THREE.Vector3} playerPos - live ship position (scene units)
   * @param {THREE.Vector3} velDir - unit ship velocity (zero when degenerate)
   * @private
   */
  _updateLadderCamera(dt, playerPos, velDir, radialDir) {
    const lc = this._ladderCam;
    this._ladderUpdateSeq++;   // one tick per drawn frame: ladderDragNudge coalesces within a tick
    // The coast's REAL step (not the game dt, which slow motion shrinks): computed BEFORE the
    // wall stamp below overwrites the previous frame's (ladderDragNudge's stale guard reads it).
    const wallNow = this._wallNowMs();
    const coastStep = coastStepS(this._ladderUpdateWallMs, wallNow);
    this._ladderUpdateWallMs = wallNow;

    // The follow blend clock, ONCE per frame and before any anchor reader. A change of target (mother ↔ daughter,
    // daughter A → B, loss) restarts the soft re-aim from the offset resolved last frame, so the anchor never jumps.
    const want = this._ladderFollowTarget();
    if (want !== lc.followArm) {
      lc.followFromOff.copy(lc.followLastOff);
      lc.followArm = want;
      lc.followT = 0;
    } else if (lc.followT < 1) {
      lc.followT = Math.min(1, lc.followT + dt / (VisualLaw.TIMINGS.SUBJECT_REAIM_MS / 1000));
    }

    this._updateCatchFocus(dt, playerPos);

    // On a ship anchor the dolly direction is heading-relative: build the live orbital frame first (the drag and the
    // direction rebuild below both need it), and seed the local pose from the world dir the FIRST time a ship-anchored
    // frame runs after engage (byte-identical pose at engage).
    const shipAnchored = (lc.anchor === 'ship');
    if (shipAnchored) {
      this._ladderShipFrame(radialDir, velDir);
      if (!lc.localSeeded) {
        this._ladderWorldToLocal(lc.dir, lc.local);
        lc.localSeeded = true;
      }
    }

    let ease = 0;
    const wasRiding = lc.riding;   // the completion frame still counts as in-flight for the up rule
    if (lc.riding) {
      lc.rideT += dt / lc.rideDur;
      if (lc.rideT >= 1) {
        lc.rideT = 1;
        lc.riding = false;
      }
      ease = cubicInOut(lc.rideT);
      lc.curDistU = lerp(lc.rideFromDistU, lc.rideToDistU, ease);
      const fov = lerp(lc.rideFromFov, lc.rideToFov, ease);
      this._baseFov = fov;
      this.camera.fov = fov;
    } else {
      // Free scroll / settle: ease the current distance toward the target so
      // per-event z01 steps read as smooth dolly, not jumps.
      const rate = 14.0; // ~ e-fold per 70 ms
      lc.curDistU += (lc.targetDistU - lc.curDistU) * Math.min(1, rate * dt);
      if (Math.abs(lc.curDistU - lc.targetDistU) < lc.targetDistU * 1e-4) {
        lc.curDistU = lc.targetDistU;
      }
      this._baseFov = lc.fov;
      this.camera.fov = lc.fov;

      // Drag-to-rotate: rotate the dolly direction by the accumulated drag velocities (yaw around the floor's up-frame
      // pole, pitch around camera-right clamped to ORBIT's pole window), then coast the speeds (ORBIT momentum, per
      // second: ×damping per 1/60 s, snap to 0 below 6e-4 rad/s; _coastDrag). On a SHIP anchor the rotation is applied to
      // the LOCAL pose (yaw about local R, pitch about local right) so a drag stays heading-relative as the ship orbits,
      // and the result is remembered per floor as the Earth→ship arrival pose. On an Earth anchor it rotates the
      // inertial world dir about Earth-north. The lookAt(anchorPos) below is unchanged. Rides never reach here
      // (non-riding branch), and ladderStartRide cancels in-flight drags.
      const dg = lc.drag;
      if ((dg.enabled || dg.touchEnabled) && (dg.hasPend || dg.velocityTheta !== 0 || dg.velocityPhi !== 0)) {
        const turn = this._coastDrag(dg, coastStep);
        const v = shipAnchored ? lc.local : lc.dir;
        const up = shipAnchored ? lc._localUp : this._ladderUpFor(lc.anchor, radialDir, lc._dragUp);
        v.applyAxisAngle(up, turn.theta);                       // yaw around the pole
        const right = lc._dragRight.crossVectors(up, v);
        if (right.lengthSq() > 1e-12) {
          right.normalize();
          // Rotating around `right = up × dir` by +a INCREASES the angle from
          // the pole (right-hand rule); clamp the resulting polar angle to
          // ORBIT's gimbal window [0.1, π−0.1] (see _computeOrbit).
          const angle = Math.acos(Math.max(-1, Math.min(1, v.dot(up))));
          const target = clamp(angle + turn.phi, 0.1, Math.PI - 0.1);
          if (target !== angle) v.applyAxisAngle(right, target - angle);
        }
        v.normalize();
        if (turn.theta !== 0 || turn.phi !== 0) lc.viewReturn.moved = true;   // a drag turn was applied this frame (the return's wait restarts)
        if (shipAnchored && lc.floor != null) {
          const m = lc.dragMemory[lc.floor] || (lc.dragMemory[lc.floor] = new THREE.Vector3());
          m.copy(v);
        }
      }
    }

    this._stepLadderViewReturn(coastStep, shipAnchored);

    // The turn to the focused field. Only on an Earth anchor (`dir` is the inertial view direction there) and never
    // while a ride runs (a ride owns the camera; ladderStartRide cancels a running turn, this also keeps one stored
    // mid-ride still). Each frame's dt is clamped to [0, 0.1] s so a stalled frame cannot jump the turn. The end is exact
    // (dir = target), then the turn is gone and `dir` is inertial again.
    if (lc.earthTurn) {
      if (lc.anchor !== 'earth') {
        this.ladderCancelEarthTurn('anchor changed');
      } else if (!lc.riding) {
        const et = lc.earthTurn;
        et.t += (Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0) / (et.s || EARTH_TURN_S);   // a re-frame may be longer
        if (et.t >= 1) {
          lc.dir.copy(et.target);
          lc.earthTurn = null;
        } else {
          lc.dir.copy(earthTurnDirAt(et.start, et.target, et.t, et.ease));
        }
      }
    }

    // Resolve the world dolly direction for this frame. Ship anchor: the local pose on the LIVE frame (heading-relative,
    // like CHASE); during an Earth→ship ride slerp from the frozen inertial start toward that live arrival vector on the
    // ride's ease (endpoints exact: ease 0 = start, ease 1 = arrival). Earth anchor: `dir` is inertial and left
    // untouched (a ship→Earth ride therefore freezes it at ride start).
    if (shipAnchored) {
      const arrival = this._ladderLocalToWorld(lc.local, lc._arrival);
      if (lc.riding && lc.rideDirSlerp) {
        const from = lc.rideDirFrom;
        const dot = from.dot(arrival);
        if (dot > 0.999999) {
          lc.dir.copy(arrival);
        } else {
          lc._dirQuat.setFromUnitVectors(from, arrival);
          lc._dirQuatE.identity().slerp(lc._dirQuat, ease);
          lc.dir.copy(from).applyQuaternion(lc._dirQuatE).normalize();
        }
      } else {
        lc.dir.copy(arrival);
        lc.rideDirSlerp = false;
      }
    }

    // Anchor position. During a ride the anchor is LERPED from the source frame's anchor to the destination's using the
    // same cubic ease, so a cross-anchor crossing (ship→Earth, F3↔F4) flies smoothly instead of snapping the world
    // origin at ride start. Same-anchor rides (F4↔F5) are unaffected.
    let anchorPos;
    if (lc.riding && lc.rideAnchorFrom !== lc.anchor) {
      const fromA = this._anchorWorld(lc.rideAnchorFrom, playerPos, lc._tmp);
      const toA = this._anchorWorld(lc.anchor, playerPos, this._tmpVecC);
      anchorPos = this._tmpVecB.lerpVectors(fromA, toA, ease);
    } else {
      anchorPos = this._anchorWorld(lc.anchor, playerPos, this._tmpVecB);
    }
    this._ladderShipOffset(playerPos, lc.followLastOff);   // where the next target change starts from
    // The catch focus pulls the anchor toward the catch and the distance in to CATCH_FOCUS.DIST_U by its blend weight
    // w. The ladder's own state (curDistU, dir, floor, rides) is not touched, so w = 0 is exactly the pose above. A
    // ship-anchored frame only (a cross-anchor ride has already cancelled the focus).
    let distU = lc.curDistU;
    let dirUse = lc.dir;
    const cf = this._catchFocus;
    let lookPos = anchorPos;                       // where the camera looks: the anchor, or (reel view) the piece, reached first
    if ((cf.wa > 0 || cf.w > 0) && lc.anchor === 'ship' && !(lc.riding && lc.rideAnchorFrom !== lc.anchor)) {
      cf.base.copy(anchorPos);
      lookPos = cf.lookV.copy(anchorPos).addScaledVector(cf.look, cf.wa);
      anchorPos.addScaledVector(cf.off, cf.w);
      // The reel view stands at ITS distance, never nearer than the safe shot (a shorter saved ladder distance used to
      // win the min and put a 5 m catch inside the 3 m near plane); the catch focus proper keeps the nearer of the two
      const focusDist = ((cf.reelView || cf.phase === 'station' || cf.zoomed) && cf.safeDist > 0) ? Math.max(cf.dist, cf.safeDist) : Math.min(lc.curDistU, cf.dist);
      distU += (focusDist - lc.curDistU) * cf.w;
      if (cf.dirSeeded) dirUse = this._catchFocusBlendDir(lc.dir, cf.dir, cf.w, cf.v, cf.azKeep);   // never over the radial pole
    }
    this.camera.position.copy(anchorPos).addScaledVector(dirUse, distU);
    if (lookPos !== anchorPos && cf.w > 0) { cf.camRel.copy(this.camera.position).sub(cf.base); cf.camRelOk = true; } else cf.camRelOk = false;
    // Up-frame ("one change at a time: the roll is its own phase"). On-floor (and same-anchor rides) the up rule is
    // exact: radial for a ship anchor (roll-free), Earth-north for an earth anchor. Cross-anchor rides (F5↔F6) are
    // asymmetric so the horizon never rolls during the fast part of the flight:
    //   UP   (ship→Earth): the up captured at ride start is HELD for the whole flight; on completion the `leveling`
    //        phase levels it to Earth-north over LADDER_LEVEL_MS (cubic in-out) and exactness resumes after.
    //   DOWN (Earth→ship): roll from the start up to the LIVE ship-radial during the first LADDER_DOWN_ROLL_FRAC of the
    //        ride (the dolly barely moves there), fully ship-up before the dive dominates.
    // `wasRiding` classifies the completion frame as still-in-flight so the held up is what the ride ends on (no snap
    // into the level phase).
    const crossRide = wasRiding && lc.rideAnchorFrom !== lc.anchor;
    if (crossRide && lc.anchor === 'earth') {
      this.camera.up.copy(lc._upStart);
      if (!lc.riding) {                       // arrived: arm the level phase
        lc.leveling = true;
        lc.levelT = 0;
        lc.levelHoldFloor = lc.rideFloorFrom;
      }
    } else if (crossRide) {
      const rollEase = cubicInOut(Math.min(1, lc.rideT / LADDER_DOWN_ROLL_FRAC));
      this._ladderSlerpUp(lc._upStart, this._ladderUpFor('ship', radialDir, lc._upTo), rollEase);
    } else if (lc.leveling) {
      lc.levelT = Math.min(1, lc.levelT + dt / (LADDER_LEVEL_MS / 1000));
      if (lc.levelT >= 1 - 1e-9) {          // tolerate fp accumulation of frame dts
        lc.levelT = 1;
        lc.leveling = false;
        lc.levelHoldFloor = null;
      }
      this._ladderSlerpUp(lc._upStart, this._ladderUpFor('earth', radialDir, lc._upTo), cubicInOut(lc.levelT));
    } else {
      this._ladderUpFor(lc.anchor, radialDir, this.camera.up);
    }
    // The look-at bias (08-workbench §2). Target = the requested pane inset on EVERY engaged floor (the SPECS drawer
    // lives on every floor, so the subject reframes into the uncovered strip wherever a drawer covers an edge): the
    // request itself is the ONE pane edge (main.js _syncWorkbenchPanes), 0 when no drawer is open, so a ride away with
    // the drawer closing drops the bias; a ride with the drawer OPEN carries the bias to the destination floor. On a
    // target edge the ease re-arms from the CURRENT value (a reversal mid-ease never snaps); reduced motion settles at
    // once. The bias is a pure YAW about the camera's own up AFTER the shipped lookAt: by θ = atan(tan(fov/2) · aspect ·
    // b), b = inset / viewport width, so the anchor projects to x_ndc = b exactly (y_ndc stays 0): the centre of the
    // uncovered strip, on ship- and Earth-anchored floors alike. (Offsetting the look-at point instead would let lookAt
    // re-orthogonalize the radial up against the new forward → a residual tilt; the yaw keeps the up exact.) Position,
    // distance, up and the dolly frame above are untouched; bias 0 → no rotation.
    const insetTarget = lc.paneInsetPx;
    if (insetTarget !== lc.paneBiasTo) {
      lc.paneBiasFrom = lc.paneBiasPx;
      lc.paneBiasTo = insetTarget;
      lc.paneBiasT = this._prefersReducedMotion() ? 1 : 0;
    }
    if (lc.paneBiasT < 1) {
      lc.paneBiasT = Math.min(1, lc.paneBiasT + dt / (LADDER_PANE_REFRAME_MS / 1000));
    }
    lc.paneBiasPx = lc.paneBiasFrom + (lc.paneBiasTo - lc.paneBiasFrom) * cubicInOut(lc.paneBiasT);
    this.camera.lookAt(lookPos);
    if (lc.paneBiasPx !== 0) {
      const viewportW = this._ladderViewportWidthPx();   // 0 when unknown → no bias, never a guess
      if (viewportW > 0) {
        const b = clamp(lc.paneBiasPx / viewportW, -0.9, 0.9);
        const halfW = Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * this.camera.fov) * (this.camera.aspect || 1);
        // +θ about local Y pans the camera LEFT → the subject lands RIGHT of centre (a left pane).
        this.camera.rotateY(Math.atan(halfW * b));
      }
    }
    this.camera.updateProjectionMatrix();

    if (!lc.riding && lc.onDone) {
      const cb = lc.onDone;
      lc.onDone = null;
      cb();
    }
  }

  /** @private Create the view mode indicator overlay element */
  _createViewIndicator() {
    const overlay = document.getElementById('hud-overlay');
    if (!overlay) return;

    this._viewIndicator = document.createElement('div');
    this._viewIndicator.id = 'camera-view-indicator';
    // Moved from top:60 (blocked info near the comms panel header) down to top:140.
    this._viewIndicator.style.cssText = `
      position: absolute; top: 140px; left: 50%; transform: translateX(-50%);
      font-family: var(--font-mono); font-size: 0.85rem;
      color: #00ff88; letter-spacing: 0.1em;
      background: rgba(0, 20, 40, 0.7); border: 1px solid rgba(0,255,136,0.3);
      padding: 6px 16px; border-radius: 4px;
      pointer-events: none; opacity: 0; transition: opacity 0.3s;
      text-shadow: 0 0 8px rgba(0,255,136,0.4);
      z-index: 30;
    `;
    overlay.appendChild(this._viewIndicator);
  }

  /**
   * @private Drive the in-engine inspect background dim: a fullscreen vignette drawn in NearFieldRenderPass, in the
   * seam between the far beauty pass and the near (ship) pass, so it darkens ONLY the surroundings (Earth/stars/debris)
   * and never the ship or the callout layer. No-op in headless tests (no sceneManager).
   */
  _applyInspectDim(on) {
    const dim = Constants.INSPECTION?.DIM ?? 0.6;
    this._sceneManager?.setInspectDim?.(on && dim > 0 ? dim : 0);
  }

  /** @private Show the view indicator with a label */
  _showViewIndicator(view) {
    if (!this._viewIndicator) return;

    // The default FLY view fades after 2.5s (unobtrusive). Any other view keeps
    // the badge on screen with a "[V] to fly" return hint so the player can't
    // get stuck in LOOK AROUND (or the legacy INSPECTION view) unknowingly.
    const isDefault = view === CameraViews.CHASE;

    // Glass has no V or 1-4 keys, so the badge is the bare label there (read at draw time, desktop unchanged).
    const glass = GestureHints.isGlass();
    if (view === CameraViews.ARM_PILOT) {
      this._viewIndicator.textContent = glass ? `${VIEW_LABELS[view]}` : `${VIEW_LABELS[view]}  [1-4]`;
    } else if (isDefault) {
      this._viewIndicator.textContent = glass ? `${VIEW_LABELS[view]}` : `${VIEW_LABELS[view]}  [V]`;
    } else {
      this._viewIndicator.textContent = glass ? `${VIEW_LABELS[view]}` : `${VIEW_LABELS[view]} · [V] to fly`;
    }

    this._viewIndicator.style.opacity = '1';

    if (isDefault) {
      this._viewIndicatorPersistent = false;
      this._viewIndicatorTimer = 2.5; // fade out after 2.5 seconds
    } else {
      this._viewIndicatorPersistent = true; // stays until we return to FLY
      this._viewIndicatorTimer = 0;
    }
  }

  /** @private Fade out the view indicator */
  _hideViewIndicator() {
    if (!this._viewIndicator) return;
    this._viewIndicator.style.opacity = '0';
  }

  /** Remove event listeners (call on destroy). */
  dispose() {
    // Drain eventBus subscriptions so a disposed instance can never re-arm a ceremony (and pin CeremonyTimeScale) on a
    // later NET_CEREMONY_START.
    if (this._unsubs) {
      for (const off of this._unsubs) { try { off(); } catch { /* already gone */ } }
      this._unsubs.length = 0;
    }
    // Tearing down mid-ceremony: hand the world clock back (§6 R1) rather than leave the global time scale pinned.
    if (this._netCeremony && this._netCeremony.active) {
      this._exitNetCeremony(false);
    }

    this.canvas.removeEventListener('mousedown', this._boundMouseDown);
    this.canvas.removeEventListener('mousemove', this._boundMouseMove);
    this.canvas.removeEventListener('mouseup', this._boundMouseUp);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('mouseup', this._boundWindowMouseUp);
    this.canvas.removeEventListener('contextmenu', this._boundContextMenu);

    if (this._viewIndicator && this._viewIndicator.parentNode) {
      this._viewIndicator.parentNode.removeChild(this._viewIndicator);
    }

    if (this._fillLight && this._scene) {
      this._scene.remove(this._fillLight);
      this._fillLight = null;
    }
    if (this._rimLight && this._scene) {
      this._scene.remove(this._rimLight);
      this._rimLight = null;
    }
  }

  /**
   * Whether this camera system should suppress OrbitControls.
   */
  isActive() {
    return true; // CameraSystem always manages the camera when active
  }
}

export default CameraSystem;
