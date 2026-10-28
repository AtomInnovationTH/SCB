/**
 * CollisionAvoidanceSystem.js — semi-autonomous evasive maneuvers. Scans nearby debris at 4 Hz and fires RCS dodge
 * impulses on an imminent collision, unless the player explicitly targeted that debris for capture. Real-world
 * analogue: ISS Pre-Determined Debris Avoidance Maneuver (PDAM).
 *
 * Detection uses the same constant-velocity linear TCA prediction as ConjunctionSystem._predictClosestApproach(),
 * with a tighter scan radius (5 km) and shorter look-ahead (10 s).
 *
 * @module systems/CollisionAvoidanceSystem
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesian, orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';
import { classifyContact } from './collisionModel.js';
import { TimeAuthority } from './TimeAuthority.js';
import { audioSystem } from './AudioSystem.js';
import { engineGasLowFrac } from './ResourceSystem.js';
import { clamp } from '../core/MathUtil.js';

/** 1 metre in scene units */
const M = 0.00001;

/** Velocity conversion: km/s → scene-units/s (orbitToSceneCartesian returns km/s) */
const KM_TO_SCENE = M * 1000; // 0.01

export class CollisionAvoidanceSystem {

  constructor() {
    const CA = Constants.COLLISION_AVOIDANCE;

    this._enabled = CA.ENABLED_DEFAULT;

    this._scanTimer = 0;

    /** @type {number} WORLD (game) seconds since the previous scan tick — the contact scan's look-ahead window */
    this._worldSinceScan = 0;
    /** @type {boolean} true once update() has been given a world dt (old callers pass none) */
    this._worldDtSeen = false;

    // --- Backward chord memory ---
    /** @type {number} Contact-scan sequence number: advances on EVERY contact-scan call
     *  (armed or not), so a chord is only ever drawn between two ADJACENT scans. */
    this._contactSeq = 0;
    /** @type {Map<*, {seq:number, x:number, y:number, z:number}>} Per-debris relative position
     *  (piece - ship, scene units) as of the contact scan numbered `seq`. One object per id, reused. */
    this._contactMem = new Map();
    /** @private Scratch outputs of _chordSeverity (closest distance m / implied speed m/s). */
    this._chordDistM = 0;
    this._chordSpeedMs = 0;

    this._currentThreat = null;

    this._lastDodgeTime = -Infinity;

    this._elapsedTime = 0;

    /** @type {number|null} Active (Tab-selected) target debris ID — exempt from dodging */
    this._activeTargetId = null;

    /** @type {number|string|null} Debris ID locked by autopilot: exempt from dodging in all AP modes (TARGET, DEBRIS,
     *  TRAWL). See archive/AUTOPILOT_ANALYSIS.md §D / B.8. */
    this._autopilotLockId = null;

    this._trawlActive = false;

    this._armPilotMode = false;

    /** @type {number} Timestamp of last player movement input */
    this._lastPlayerInputTime = -Infinity;

    /** @type {string|null} Debounce: last suppression reason emitted for current threat */
    this._lastSuppressedReason = null;

    // --- Dependencies (set via init()) ---
    /** @type {object|null} */ this._player = null;
    /** @type {object|null} */ this._debrisField = null;
    /** @type {object|null} */ this._armManager = null;
    /** @type {object|null} */ this._inputManager = null;
    /** @type {object|null} ConjunctionSystem ref for MOID prefilter */
    this._conjunctionSystem = null;
    /** @type {number} Debug log throttle */
    this._moidLogTimer = 0;

    // --- Comms quieting state ---
    /** @type {number} Current mission number, tracked via MISSION_START and SCORE_UPDATE so the CA comms gate works
     *  without a direct GameState ref (same pattern as KesslerSystem). */
    this._missionNumber = 1;
    /** @type {number} Epoch ms of last CA comms emit (any kind) */
    this._lastCommsEmitMs = -Infinity;

    // --- Collision-consequence emitter state ---
    /** @type {boolean} In a gameplay state (tracked via GAME_STATE_CHANGE) */
    this._inGameplay = false;
    /** @type {boolean} Onboarding tutorial running — collisions disarmed */
    this._onboardingActive = false;
    /** @type {boolean} A launch/net ceremony is playing — collisions disarmed */
    this._ceremonyActive = false;
    /** @type {number} Seconds of eligible gameplay accrued (spawn-grace clock) */
    this._gameplayElapsed = 0;
    /** @type {Map<*, {warn:number, contact:number}>} Per-debris event cooldowns */
    this._contactCooldowns = new Map();
    /** @type {object|null} ResourceSystem ref for glancing-hit damage */
    this._resourceSystem = null;
    /** @private Reusable scratch for the contact scan's cartesian read (no per-tick alloc). */
    this._contactScratchPos = { x: 0, y: 0, z: 0 };
    this._contactScratchVel = { x: 0, y: 0, z: 0 };

    this._setupListeners();
  }

  /** Wire dependencies after construction (same pattern as AutopilotSystem). */
  init(deps) {
    this._player = deps.player;
    this._debrisField = deps.debrisField;
    this._armManager = deps.armManager || null;
    this._inputManager = deps.inputManager || null;
    this._conjunctionSystem = deps.conjunctionSystem || null;
    this._resourceSystem = deps.resourceSystem || null;
  }

  _setupListeners() {
    eventBus.on(Events.TARGET_SELECTED, (data) => {
      this._activeTargetId = data?.id ?? data?.debrisId ?? null;
    });
    eventBus.on(Events.TARGET_CLEARED, () => {
      this._activeTargetId = null;
    });

    // Autopilot-locked debris is exempt regardless of AP mode (archive/AUTOPILOT_ANALYSIS.md B.8): closes the CA/AP
    // tug-of-war during DEBRIS / TRAWL.
    eventBus.on(Events.AUTOPILOT_TARGET_LOCK, (data) => {
      this._autopilotLockId = data?.debrisId ?? null;
    });
    eventBus.on(Events.AUTOPILOT_TARGET_UNLOCK, (data) => {
      if (data?.debrisId == null || data.debrisId === this._autopilotLockId) {
        this._autopilotLockId = null;
      }
    });

    // Trawl mode — tighten avoidance radius
    eventBus.on(Events.TRAWL_START, () => { this._trawlActive = true; });
    eventBus.on(Events.TRAWL_END, () => { this._trawlActive = false; });
    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, () => { this._trawlActive = false; });

    // ARM_PILOT mode — fully suppress
    eventBus.on(Events.CONTROL_MODE_CHANGE, (data) => {
      this._armPilotMode = data?.mode === 'ARM_PILOT';
    });

    eventBus.on(Events.CA_TOGGLED, (data) => {
      this._enabled = !!data?.enabled;
    });

    // Mission tracking for the comms quieting gate
    eventBus.on(Events.MISSION_START, (d) => {
      if (typeof d?.missionNumber === 'number') {
        this._missionNumber = d.missionNumber;
      }
      // A new mission re-seats / respawns the field: positions remembered from the old one must never be chorded to
      // the new ones.
      this._contactMem.clear();
    });
    eventBus.on(Events.SCORE_UPDATE, (d) => {
      if (typeof d?.debrisCleared === 'number') {
        const per = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
        this._missionNumber = Math.floor(d.debrisCleared / per) + 1;
      }
    });

    eventBus.on(Events.GAME_RESET, () => { this.reset(); });

    eventBus.on(Events.GAME_STATE_CHANGE, (data) => {
      const gameplay = ['ORBITAL_VIEW', 'APPROACH', 'INTERACTION'];
      const nowGameplay = !!(data?.to && gameplay.includes(data.to));
      this._inGameplay = nowGameplay;
      if (!nowGameplay) {
        // Freeze scanning (the toggle stays); reset the spawn-grace clock so re-entering gameplay re-arms after it.
        this._scanTimer = 0;
        this._worldSinceScan = 0;
        this._contactMem.clear(); // no chord across a pause / menu / re-entry
        this._currentThreat = null;
        this._gameplayElapsed = 0;
      }
    });

    // --- Collision-consequence gating (load-bearing new-player guard) ---
    // Onboarding tutorial: keep the collision emitter disarmed so the curated
    // welcome field (spawned deliberately close) can never kill a new player.
    eventBus.on(Events.ONBOARDING_STARTED, () => { this._onboardingActive = true; });
    eventBus.on(Events.ONBOARDING_COMPLETE, () => {
      this._onboardingActive = false;
      this._gameplayElapsed = 0; // re-grace after the tutorial ends
    });
    // Launch / net ceremonies: suppress while the camera cinematic plays and the
    // mother is being flung/repositioned (arm deploy), so a ceremony ≠ a collision.
    eventBus.on(Events.LAUNCH_CEREMONY_START, () => { this._ceremonyActive = true; });
    eventBus.on(Events.LAUNCH_CEREMONY_COMPLETE, () => { this._ceremonyActive = false; });
    // A skipped ceremony emits ABORT, not COMPLETE: without this row _ceremonyActive stuck true after one
    // ESC/Space/Enter/D skip and auto-dodge stayed DISABLED for the session.
    eventBus.on(Events.LAUNCH_CEREMONY_ABORT, () => { this._ceremonyActive = false; });
    // Aim-before-launch: the auto-rotation slew repositions the mother's attitude for several seconds; treat it like a
    // ceremony so avoidance impulses don't fight the slew.
    eventBus.on(Events.AIM_SEQUENCE_START, () => { this._ceremonyActive = true; });
    eventBus.on(Events.AIM_SEQUENCE_END, () => { this._ceremonyActive = false; });
  }

  get enabled() { return this._enabled; }

  toggle() {
    this._enabled = !this._enabled;
    eventBus.emit(Events.CA_TOGGLED, { enabled: this._enabled });
  }

  getStatus() {
    return {
      enabled: this._enabled,
      currentThreat: this._currentThreat,
      lastDodgeTime: this._lastDodgeTime,
      trawlActive: this._trawlActive,
      armPilotMode: this._armPilotMode,
    };
  }

  reset() {
    this._scanTimer = 0;
    this._worldSinceScan = 0;
    this._worldDtSeen = false;
    this._currentThreat = null;
    this._lastDodgeTime = -Infinity;
    this._elapsedTime = 0;
    this._activeTargetId = null;
    this._autopilotLockId = null;
    this._trawlActive = false;
    this._armPilotMode = false;
    this._lastPlayerInputTime = -Infinity;
    this._lastSuppressedReason = null;
    this._missionNumber = 1;
    this._lastCommsEmitMs = -Infinity;
    // Collision-consequence state. _inGameplay is NOT reset: a GAME_RESET is followed by a fresh GAME_STATE_CHANGE that
    // sets it, and the grace clock restart keeps a new run guarded regardless.
    this._onboardingActive = false;
    this._ceremonyActive = false;
    this._gameplayElapsed = 0;
    this._contactCooldowns.clear();
    this._contactMem.clear();
    this._contactSeq = 0;
  }

  /**
   * @private Comms gate. Two gates: (1) mission floor, silent until missionNumber >= COMMS_MIN_MISSION; (2) rate
   * limit, at most one CA comms per COMMS_RATE_LIMIT_S seconds. Why: a COMMS_MESSAGE on every threat / dodge / clear
   * made a yellow wall on mission 1 (10+ dodges in 60 s) that drowned out the onboarding tone. Dodging still fires
   * silently; only the COMMS_MESSAGE side-channel is gated. Use for any "chatty" CA comms; NOT for future game-over
   * alerts (those fire even on mission 1).
   * @param {object} payload as for eventBus.emit(COMMS_MESSAGE,…)
   * @returns {boolean} true if the message was emitted, false if gated
   */
  _emitCaComms(payload) {
    const CA = Constants.COLLISION_AVOIDANCE;
    const minMission = CA.COMMS_MIN_MISSION ?? 1;
    if (this._missionNumber < minMission) return false;

    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const rateLimitMs = (CA.COMMS_RATE_LIMIT_S ?? 0) * 1000;
    if (rateLimitMs > 0 && (now - this._lastCommsEmitMs) < rateLimitMs) return false;

    this._lastCommsEmitMs = now;
    eventBus.emit(Events.COMMS_MESSAGE, payload);
    return true;
  }

  /**
   * Main update tick; called after autopilot, before player.update().
   *
   * Cadence: the DODGE scan and every real-time timer run at 4 Hz of REAL time (SCAN_INTERVAL). The CONTACT scan runs
   * on that tick AND whenever the world seconds since the previous contact scan reach CONTACT_WINDOW_MAX_S (only once
   * a world dt has been seen), whichever comes first. Why: the forward look is clamped to 10 world s, so a 4 Hz real
   * scan at 40×/200×/1000× (floors 3/4/5) left 10.0-10.7 / 50 / 250 world s per scan mostly unchecked (measured real
   * hits of a dead-on 10 kg pass: 40× 19-20/20, 100× 7-8/20, 200× 4/20, 1000× 1/20). F1-F3 tick as before, F4 scans
   * about every 3 frames, F5 every frame. A world-time-only tick runs the contact scan and nothing else (no dodge
   * scan, no `_scanTimer` reset). See `_scanAndProcessContacts` for the backward chord.
   *
   * @param {number} dt REAL delta time in seconds (all timers here run on it)
   * @param {number} [dtWorld] WORLD (game) seconds that passed this frame (`timeAuthority.dtWorld`); the contact scan's
   *   look-ahead window is the sum of these since the previous contact scan. Omitted → the nominal
   *   SCAN_INTERVAL × TIME_SCALE_GAMEPLAY.
   */
  update(dt, dtWorld) {
    if (!this._player || !this._debrisField) return;

    if (dtWorld !== undefined && dtWorld !== null) {
      this._worldDtSeen = true;
      if (dtWorld > 0) this._worldSinceScan += dtWorld;
    }

    this._elapsedTime += dt;
    if (this._inGameplay) this._gameplayElapsed += dt;

    const CA = Constants.COLLISION_AVOIDANCE;

    this._detectPlayerInput();

    // Scan throttle: the real 4 Hz tick runs the dodge scan AND the contact scan; a world-time tick runs the contact
    // scan alone.
    this._scanTimer += dt;
    const realDue = this._scanTimer >= CA.SCAN_INTERVAL;
    const worldDue = !realDue && this._worldDtSeen
      && this._worldSinceScan >= CA.CONTACT_WINDOW_MAX_S;
    if (!realDue && !worldDue) return;
    if (realDue) this._scanTimer = 0;

    // World seconds since the previous CONTACT scan (reset on EVERY contact scan, before the armed check, so the spawn
    // grace never piles into one window), clamped to 10 s for the forward look (a straight line over minutes is
    // wrong). The raw, unclamped value is the backward chord's elapsed time. No world dt ever supplied → the nominal
    // window and no chord.
    const CAw = Constants.COLLISION_AVOIDANCE;
    const windowWorldS = this._worldDtSeen
      ? Math.min(this._worldSinceScan, CAw.CONTACT_WINDOW_MAX_S)
      : undefined;
    const sinceScanWorldS = this._worldDtSeen ? this._worldSinceScan : undefined;
    this._worldSinceScan = 0;

    const playerPos = this._player.getPosition();
    const playerVel = this._player.getVelocity();

    // Collision consequences run INDEPENDENT of the dodge enable-toggle and ARM_PILOT, so turning auto-dodge off (or
    // piloting a daughter) can't make the mother invincible to debris. Internally gated (gameplay / onboarding /
    // spawn-grace / ceremony / per-debris cooldown / captured-pinned exemption). Runs on the 4 Hz real tick AND on
    // world-time ticks (every frame at 1000×).
    this._scanAndProcessContacts(playerPos, playerVel, windowWorldS, sinceScanWorldS);

    // World-time-only tick: the dodge scan keeps its 4 Hz real cadence.
    if (!realDue) return;

    // Auto-dodge (gated by the enable toggle + ARM_PILOT suppression)
    if (!this._enabled || this._armPilotMode) return;

    const threat = this._scanForThreats(playerPos, playerVel);

    if (threat) {
      // Emit threat detected (only on new threat or different debris)
      if (!this._currentThreat || this._currentThreat.debrisId !== threat.debrisId) {
        this._currentThreat = threat;
        eventBus.emit(Events.CA_THREAT_DETECTED, {
          debrisId: threat.debrisId,
          tca: threat.tca,
          missDistance: threat.missDistM,
          evasionVector: threat.evasionDir,
        });

        // Comms warning (gated — see _emitCaComms JSDoc)
        this._emitCaComms({
          sender: 'CA',
          text: `Debris ${threat.debrisId}. TCA ${threat.tca.toFixed(1)}s, miss ${Math.round(threat.missDistM)}m. Evaluating`,
          priority: 'info',
        });
      }

      this._evaluateAndDodge(threat, playerPos);
    } else {
      this._clearThreat();
    }
  }

  /**
   * @private Is the collision-consequence emitter armed this tick? All four gates are load-bearing: the onboarding +
   * grace gates keep a new player un-killable by the deliberately-close welcome field.
   */
  _collisionArmed() {
    const CM = Constants.COLLISION_MODEL || {};
    return this._inGameplay
      && !this._onboardingActive
      && !this._ceremonyActive
      && this._gameplayElapsed >= (CM.SPAWN_GRACE_S || 0);
  }

  /**
   * @private Scan the same candidate set as the dodge scan for genuine CONTACTS (not near-misses to dodge) and route
   * graduated consequences. Called once per contact-scan tick (the real 4 Hz tick or a world-time tick; see
   * `update()`), independent of the dodge toggle. No per-iteration allocation.
   *
   * Two looks per candidate (the hit check must see a pass at every time rate; measured real hits of a dead-on 10 kg
   * pass, same at 20..10 000 m/s: 10×/20× 20/20, 40× 19-20, 100× 7-8, 200× 4/20, 1000× 1/20):
   *   1. FORWARD: straight line from the current state over the window
   *      `min(world s since the last contact scan, CONTACT_WINDOW_MAX_S)`.
   *   2. BACKWARD CHORD: the segment between this piece's relative position at the IMMEDIATELY previous contact scan
   *      and now, both read from the orbit (`orbitToSceneCartesianInto` minus the ship). It catches a pass that
   *      happened between two scans and so lies behind the forward window. Used only when
   *      `0 < Tb <= CONTACT_CHORD_MAX_S` (Tb = world s between the two scans, unclamped; a chord between two TRUE
   *      positions errs about a quarter of a straight-line extrapolation: <= ~17 m at 10 km/s over 25 s, so longer
   *      gaps, e.g. F5 under ~40 fps, skip it), the pair was approaching at the start (r0·d < 0), and the implied
   *      speed is <= CONTACT_PREFILTER_SPEED_MS and agrees with the orbit-derived relative speed (a teleport or
   *      re-seat fails this and is skipped). It acts on 'glancing'/'hard' only; a chord 'warning' is ignored
   *      (warnings stay forward-only). One pass = one consequence: both looks go through `_handleContact`, whose
   *      per-piece real-time contact cooldown (5 s >> the 0.25 s real gap between scans) swallows the second.
   *
   * Loop order per piece: exemption -> store gate (distance to the ship, so the memory covers everything the next,
   * possibly longer, interval could bring in) -> chord + store -> forward `reachSq` skip -> forward look. The scan
   * sequence number advances on EVERY call, armed or not, and an unarmed scan stores nothing, so the first armed scan
   * after a gap draws no chord.
   * @param {{x,y,z}} playerVel km/s
   * @param {number} [windowWorldS] look-ahead window in WORLD seconds (default the nominal world time of one
   *   SCAN_INTERVAL, TimeAuthority.baseGameDt); 0 grades by the current distance only
   * @param {number} [sinceScanWorldS] raw (unclamped) WORLD seconds since the previous contact scan = the chord's
   *   elapsed time Tb; undefined / 0 → no chord this scan
   */
  _scanAndProcessContacts(playerPos, playerVel, windowWorldS, sinceScanWorldS) {
    const seq = ++this._contactSeq;
    if (!this._collisionArmed()) return;

    const CA = Constants.COLLISION_AVOIDANCE;
    const CM = Constants.COLLISION_MODEL || {};
    const T = (typeof windowWorldS === 'number' && windowWorldS >= 0)
      ? windowWorldS
      : TimeAuthority.baseGameDt(CA.SCAN_INTERVAL);
    // Pre-filter reaches as far as the fastest crossing can travel in the window.
    const reach = CA.SCAN_RADIUS + CA.CONTACT_PREFILTER_SPEED_MS * M * T;
    const reachSq = reach * reach;
    const hullRadiusM = CM.HULL_RADIUS_M || 12;

    // Chord: needs a real elapsed world time, inside the cap.
    const Tb = (typeof sinceScanWorldS === 'number' && sinceScanWorldS > 0) ? sinceScanWorldS : 0;
    const chordOn = Tb > 0 && Tb <= (CA.CONTACT_CHORD_MAX_S || 0);
    // Store gate: a margin of 2x for the next interval being longer; never inside reach.
    const storeReach = CA.SCAN_RADIUS + CA.CONTACT_PREFILTER_SPEED_MS * M * 2
      * Math.max(Tb, CA.CONTACT_WINDOW_MAX_S);
    const storeReachSq = Math.max(storeReach * storeReach, reachSq);

    const list = this._debrisField.debrisList;
    if (!list) return;
    const mem = this._contactMem;
    if (mem.size > 2 * list.length + 64) this._pruneContactMem(seq);

    for (let i = 0, len = list.length; i < len; i++) {
      const debris = list[i];
      if (!debris || !debris.alive) continue;

      // Shared exemption set (SSOT with the dodge scan): welcome cluster (M1-scoped) / welcomeField / captured-pinned /
      // active-target / autopilot-locked / arm-targeted are never contacts.
      if (this._isThreatExempt(debris)) continue;

      // Fast distance² pre-filter on the cached scene position (same candidate envelope as the dodge scan).
      const sp = debris._scenePosition;
      if (!sp) continue;
      const dx = sp.x - playerPos.x;
      const dy = sp.y - playerPos.y;
      const dz = sp.z - playerPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > storeReachSq) continue;
      if (!debris.orbit) continue; // no orbit to read

      // State from the orbit (world seconds). Zero-alloc scratch variant: one read serves the chord, the memory and
      // the forward look.
      const pos = this._contactScratchPos;
      const vel = this._contactScratchVel;
      orbitToSceneCartesianInto(debris.orbit, pos, vel);

      // Backward chord + memory: the relative position (piece - ship) from the same source (the orbit) at both ends.
      const r1x = pos.x - playerPos.x;
      const r1y = pos.y - playerPos.y;
      const r1z = pos.z - playerPos.z;
      let m = mem.get(debris.id);
      if (!m) { m = { seq: -1, x: 0, y: 0, z: 0 }; mem.set(debris.id, m); } // -1: never chordable on its first scan
      if (chordOn && m.seq === seq - 1) {
        const sev = this._chordSeverity(m, r1x, r1y, r1z, vel, playerVel, Tb, hullRadiusM, debris.mass, CA, CM);
        if (sev !== 'none') this._handleContact(sev, debris, this._chordSpeedMs, this._chordDistM);
      }
      m.seq = seq; m.x = r1x; m.y = r1y; m.z = r1z;

      if (distSq > reachSq) continue;
      const rvx = (vel.x - playerVel.x) * KM_TO_SCENE;
      const rvy = (vel.y - playerVel.y) * KM_TO_SCENE;
      const rvz = (vel.z - playerVel.z) * KM_TO_SCENE;
      const rLen = Math.sqrt(distSq);
      // Real closest pass inside the window: t* = clamp(-(r.v)/|v|^2, 0, T),
      // graded distance |r + v t*|.
      const rDotV = dx * rvx + dy * rvy + dz * rvz;
      const vSq = rvx * rvx + rvy * rvy + rvz * rvz;
      let tStar = vSq > 1e-30 ? -rDotV / vSq : 0;
      if (tStar < 0) tStar = 0; else if (tStar > T) tStar = T;
      const cx = dx + rvx * tStar;
      const cy = dy + rvy * tStar;
      const cz = dz + rvz * tStar;
      const effDistM = Math.sqrt(cx * cx + cy * cy + cz * cz) / M;
      // Approaching: grade at the relative speed (constant along a straight
      // pass = the impact speed). Receding keeps the signed radial rate (<= 0)
      // so classifyContact still reads it as receding.
      const closingMs = rDotV < 0
        ? Math.sqrt(vSq) / M
        : (rLen > 1e-12 ? -rDotV / rLen / M : 0);

      const severity = classifyContact({
        distanceM: effDistM,
        hullRadiusM,
        closingSpeedMs: closingMs,
        massKg: debris.mass,
      }, CM);

      if (severity === 'none') continue;
      this._handleContact(severity, debris, closingMs, effDistM);
    }
  }

  /**
   * @private The backward chord for one piece (see `_scanAndProcessContacts`). Pure arithmetic on the stored previous
   * relative position `m` and the current one (r1); no allocation except the classifier's argument object, built only
   * for a chord that passes inside the warning envelope.
   * @param {{x,y,z}} m previous relative position (piece - ship, scene units)
   * @param {number} r1x relative position now, x (scene units)
   * @param {number} r1y
   * @param {number} r1z
   * @param {{x,y,z}} vel piece velocity now (km/s)
   * @param {{x,y,z}} playerVel km/s
   * @param {number} Tb world seconds between the two scans (> 0)
   * @param {number} hullRadiusM ship hull radius for the classifier (m)
   * @returns {'none'|'glancing'|'hard'} on a hit, `_chordDistM` / `_chordSpeedMs` hold the closest distance (m) and
   *   the implied closing speed (m/s)
   */
  _chordSeverity(m, r1x, r1y, r1z, vel, playerVel, Tb, hullRadiusM, massKg, CA, CM) {
    const dx = r1x - m.x;
    const dy = r1y - m.y;
    const dz = r1z - m.z;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < 1e-30) return 'none';
    const r0d = m.x * dx + m.y * dy + m.z * dz;
    if (r0d >= 0) return 'none'; // not approaching at the start of the segment
    // Implied relative speed along the chord must be physical...
    const impliedMs = Math.sqrt(dd) / Tb / M;
    if (impliedMs > CA.CONTACT_PREFILTER_SPEED_MS) return 'none';
    // ...and agree with the orbit-derived relative speed now; otherwise it is a
    // teleport / re-seat, not flight.
    const rvx = (vel.x - playerVel.x) * KM_TO_SCENE;
    const rvy = (vel.y - playerVel.y) * KM_TO_SCENE;
    const rvz = (vel.z - playerVel.z) * KM_TO_SCENE;
    const orbitMs = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz) / M;
    if (Math.abs(impliedMs - orbitMs) > 0.25 * orbitMs + 50) return 'none';
    let s = -r0d / dd;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    const cx = m.x + dx * s;
    const cy = m.y + dy * s;
    const cz = m.z + dz * s;
    const distM = Math.sqrt(cx * cx + cy * cy + cz * cz) / M;
    if (distM > (CM.WARN_RADIUS_M || 0)) return 'none'; // outside the envelope: cannot be a hit
    const sev = classifyContact({
      distanceM: distM,
      hullRadiusM,
      closingSpeedMs: impliedMs,
      massKg,
    }, CM);
    if (sev !== 'glancing' && sev !== 'hard') return 'none'; // chord warnings are ignored
    this._chordDistM = distM;
    this._chordSpeedMs = impliedMs;
    return sev;
  }

  /**
   * @private Drop chord-memory entries that can no longer be chorded (older than the previous scan): pieces that died
   * or flew out of the store radius.
   */
  _pruneContactMem(seq) {
    for (const [id, m] of this._contactMem) {
      if (m.seq < seq - 1) this._contactMem.delete(id);
    }
  }

  /**
   * @private Route one classified contact to its consequence, honoring per-debris cooldowns so a single lingering
   * pass-through can't machine-gun events.
   */
  _handleContact(severity, debris, closingMs, distM) {
    const CM = Constants.COLLISION_MODEL || {};
    const id = debris.id;
    const now = this._elapsedTime;
    let cd = this._contactCooldowns.get(id);
    if (!cd) { cd = { warn: -Infinity, contact: -Infinity }; this._contactCooldowns.set(id, cd); }

    if (severity === 'warning') {
      if (now - cd.warn < (CM.WARN_COOLDOWN_S || 0)) return;
      cd.warn = now;
      eventBus.emit(Events.COLLISION_WARNING, {
        debrisId: id,
        distanceM: Math.round(distM),
        closingSpeedMs: Math.round(closingMs * 10) / 10,
      });
      return;
    }

    // glancing + hard are physical contacts — share the contact cooldown.
    if (now - cd.contact < (CM.CONTACT_COOLDOWN_S || 0)) return;
    cd.contact = now;

    if (severity === 'glancing') {
      // Subsystem damage: solar-panel health hit + battery drain (via ResourceSystem).
      if (this._resourceSystem) {
        if (typeof this._resourceSystem.damageSolarPanel === 'function') {
          this._resourceSystem.damageSolarPanel(CM.GLANCING_SOLAR_DAMAGE_FRAC || 0);
        }
        if (typeof this._resourceSystem.drainBattery === 'function') {
          this._resourceSystem.drainBattery(CM.GLANCING_BATTERY_DRAIN || 0);
        }
      }
      // Signal the collision (KesslerSystem's DEBRIS_COLLISION listener safely
      // ignores this — no debris1/debris2 — so a glancing hit sheds no fragments).
      eventBus.emit(Events.DEBRIS_COLLISION, {
        severity: 'glancing',
        debrisId: id,
        closingSpeedMs: Math.round(closingMs * 10) / 10,
        massKg: debris.mass,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CA',
        text: `WARNING: GLANCING IMPACT — debris ${id}. Solar panel + battery damage`,
        priority: 'critical',
      });
      if (audioSystem && typeof audioSystem.playWarning === 'function') audioSystem.playWarning(0.7);
      return;
    }

    // severity === 'hard' → route to the Whipple-shield absorb / game-over path.
    eventBus.emit(Events.GAME_COLLISION, {
      source: 'debris',
      debrisId: id,
      relSpeed: Math.round(closingMs * 10) / 10,
      massKg: debris.mass,
    });
  }

  /**
   * @private Shared exemption test for BOTH the dodge scan (`_scanForThreats`) and the collision-consequence scan
   * (`_scanAndProcessContacts`), so the two candidate filters over the same `debrisList` can't drift apart. A debris is
   * exempt when:
   *   • it's a welcome-cluster piece placed for THIS chapter (DebrisField tags each piece `welcomeChapter` at spawn and
   *     re-tags it when the re-seat puts it back ahead of the ship; untagged = chapter 1). The game put it in the
   *     player's path, so it must not cost them a burn. A surviving piece of an OLDER chapter that was not re-seated
   *     re-enters both scans (welcomeSpawn is not cleared on MISSION_START): never permanently invincible;
   *   • it carries the persistent `welcomeField` flag;
   *   • it's a held/captured catch (we're holding it: not a collision, not a dodge);
   *   • it's the active (Tab-selected) target, autopilot-locked, or arm-targeted (deliberately being approached to
   *     capture).
   */
  _isThreatExempt(debris) {
    if (debris.welcomeSpawn && (debris.welcomeChapter ?? 1) === this._missionNumber) return true;
    if (debris.welcomeField) return true;
    if (debris._captured || debris._armPinned || debris._capturedByArm) return true;
    if (debris.id === this._activeTargetId) return true;
    if (this._autopilotLockId != null && debris.id === this._autopilotLockId) return true;
    if (this._isArmTarget(debris.id)) return true;
    return false;
  }

  /**
   * @private Scan all debris for the most threatening upcoming collision. Pre-filters by distance² (800 debris → ~5-20
   * candidates). A piece whose relative speed is below `Constants.COLLISION_MODEL.GLANCING_MIN_SPEED_MS` is skipped: a
   * touch that slow does nothing (collisionModel.js), so a dodge would burn gas for no harm. Read live each scan.
   * @param {THREE.Vector3} playerPos player scene position
   * @param {{x,y,z}} playerVel player velocity (km/s)
   * @returns {object|null} Worst threat { debrisId, tca, missDistScene, missDistM, evasionDir, threatDir }
   */
  _scanForThreats(playerPos, playerVel) {
    const CA = Constants.COLLISION_AVOIDANCE;
    const avoidRadius = this._getAvoidanceRadius();
    const glancingFloorMs = (Constants.COLLISION_MODEL || {}).GLANCING_MIN_SPEED_MS || 0;

    // MOID prefilter: if ConjunctionSystem has MOID data, scan only the top-N pairs
    const moidPairs = this._conjunctionSystem
      ? this._conjunctionSystem.getTopRiskPairs()
      : null;
    const useMoidFilter = moidPairs && moidPairs.length > 0;

    let debrisList;
    let totalCandidates;

    if (useMoidFilter) {
      const moidIds = new Set(moidPairs.map(p => p.id));
      debrisList = this._debrisField.debrisList.filter(d => d.alive && moidIds.has(d.id));
      totalCandidates = this._debrisField.debrisList.length;
    } else {
      debrisList = this._debrisField.debrisList;
      totalCandidates = debrisList.length;
    }

    // Debug log once per second
    this._moidLogTimer += CA.SCAN_INTERVAL;
    if (this._moidLogTimer >= 1.0) {
      this._moidLogTimer = 0;
      if (useMoidFilter) {
        console.log(
          `[CA] checking ${debrisList.length} pairs (MOID-prefiltered from ${totalCandidates} objects)`,
        );
      }
    }

    let worst = null;
    let worstDist = Infinity;

    for (let i = 0, len = debrisList.length; i < len; i++) {
      const debris = debrisList[i];
      if (!debris.alive) continue;

      // Shared exemption set (SSOT with the contact scan) — welcome cluster is
      // M1-scoped so surviving pieces re-enter CA in later missions.
      if (this._isThreatExempt(debris)) continue;

      // Fast distance² pre-filter using cached scene position
      let dx, dy, dz;
      if (debris._scenePosition) {
        dx = debris._scenePosition.x - playerPos.x;
        dy = debris._scenePosition.y - playerPos.y;
        dz = debris._scenePosition.z - playerPos.z;
      } else {
        continue; // No position cached yet — skip this frame
      }

      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > CA.SCAN_RADIUS_SQ) continue;

      const cart = orbitToSceneCartesian(debris.orbit);
      const prediction = this._predictClosestApproach(
        cart.position, cart.velocity, playerPos, playerVel,
      );
      if (!prediction) continue;
      if (prediction.relSpeedMs < glancingFloorMs) continue; // too slow to do harm

      if (prediction.tca <= 0 || prediction.minDist > avoidRadius) continue;
      if (prediction.tca > CA.LOOK_AHEAD_S) continue;

      if (prediction.minDist < worstDist) {
        worstDist = prediction.minDist;
        worst = {
          debrisId: debris.id,
          tca: prediction.tca,
          missDistScene: prediction.minDist,
          missDistM: prediction.minDist / M,
          threatDir: prediction.threatDir,
          evasionDir: this._generateEvasionVector(prediction.threatDir, playerPos),
        };
      }
    }

    return worst;
  }

  /**
   * @private Time of closest approach (TCA) and miss distance by constant-velocity linear extrapolation:
   *
   *   TCA = −(Δr · Δv) / (Δv · Δv)   clamped to [0, LOOK_AHEAD_S]
   *   miss = |Δr + Δv × TCA|
   *
   * @param {{x,y,z}} dPos debris position (scene units)
   * @param {{x,y,z}} dVel debris velocity (km/s from orbitToSceneCartesian)
   * @param {{x,y,z}} pPos player position (scene units)
   * @param {{x,y,z}} pVel player velocity (km/s from getVelocity)
   * @returns {{ tca:number, minDist:number, threatDir:{x,y,z}, relSpeedMs:number } | null}
   */
  _predictClosestApproach(dPos, dVel, pPos, pVel) {
    const CA = Constants.COLLISION_AVOIDANCE;

    const rpx = dPos.x - pPos.x;
    const rpy = dPos.y - pPos.y;
    const rpz = dPos.z - pPos.z;

    // Relative velocity: km/s → scene-units/s
    const rvx = (dVel.x - pVel.x) * KM_TO_SCENE;
    const rvy = (dVel.y - pVel.y) * KM_TO_SCENE;
    const rvz = (dVel.z - pVel.z) * KM_TO_SCENE;

    const rvDotRv = rvx * rvx + rvy * rvy + rvz * rvz;
    if (rvDotRv < 1e-24) return null; // negligible relative motion

    const rpDotRv = rpx * rvx + rpy * rvy + rpz * rvz;
    let tca = -rpDotRv / rvDotRv;
    tca = clamp(tca, 0, CA.LOOK_AHEAD_S);

    const cx = rpx + rvx * tca;
    const cy = rpy + rvy * tca;
    const cz = rpz + rvz * tca;
    const minDist = Math.sqrt(cx * cx + cy * cy + cz * cz);

    const rLen = Math.sqrt(rpx * rpx + rpy * rpy + rpz * rpz);
    const threatDir = rLen > 1e-10
      ? { x: rpx / rLen, y: rpy / rLen, z: rpz / rLen }
      : { x: 1, y: 0, z: 0 };

    return { tca, minDist, threatDir, relSpeedMs: Math.sqrt(rvDotRv) / M };
  }

  /**
   * @private Dodge direction perpendicular to the threat approach vector (threat × radial → perpendicular in the
   * orbital plane).
   * @param {{x,y,z}} threatDir normalised threat direction
   * @param {{x,y,z}} playerPos player scene position
   * @returns {{x:number, y:number, z:number}} normalised evasion direction (scene units)
   */
  _generateEvasionVector(threatDir, playerPos) {
    // Radial "up" — away from Earth centre
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;
    const pLen = Math.sqrt(px * px + py * py + pz * pz);
    const radial = pLen > 1e-10
      ? { x: px / pLen, y: py / pLen, z: pz / pLen }
      : { x: 0, y: 1, z: 0 };

    let ex = threatDir.y * radial.z - threatDir.z * radial.y;
    let ey = threatDir.z * radial.x - threatDir.x * radial.z;
    let ez = threatDir.x * radial.y - threatDir.y * radial.x;
    const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);

    if (eLen > 1e-10) {
      return { x: ex / eLen, y: ey / eLen, z: ez / eLen };
    }

    // Degenerate case: threat is perfectly radial → evade prograde
    return { x: radial.z, y: 0, z: -radial.x };
  }

  /**
   * @private Evaluate whether to execute a dodge and fire if appropriate.
   *
   * The manoeuvre is a genuine Δv burn through `PlayerSatellite.applyCartesianImpulse` (owner decision 2026-09-15): it
   * mutates the orbit and bills xenon + battery (the ion/FEEP path applyCartesianImpulse already gates and charges).
   * The old `_rcsVelocity` placebo channel is no longer touched by this method.
   *
   * Magnitude is geometry-driven: Δv_needed ≈ (desiredMiss − predictedMiss) / timeToTCA, clamped to
   * [BASE_DODGE_DV, DODGE_DV_CEILING_MS]. `threat.tca` is already in the same WORLD/orbital-mechanics time base that
   * drives `PlayerSatellite.update()`'s orbit propagation (gameDt = dtReal × TIME_SCALE_GAMEPLAY); see
   * `_predictClosestApproach()` and the `LOOK_AHEAD_S` comment in Constants.js. Using `threat.tca` directly (never
   * `dt`, never the real-time COOLDOWN clock) keeps this unit-consistent with the burn's effect on the propagated
   * orbit.
   *
   * Three honest outcomes (never a false "fired" claim):
   *   - sufficient: burn clears the geometry → routine, gated comms.
   *   - insufficient: DODGE_DV_CEILING_MS clamped the burn below what the geometry needed → BRACE comms, bypasses the
   *     mission-floor/rate-limit quieting (safety-critical).
   *   - refused: PROPELLANT_RESERVE_FRAC pre-check or applyCartesianImpulse itself declined (dry tank, flat battery,
   *     interlock, envelope guard) → explicit named refusal comms, also bypasses quieting, no orbit change, no
   *     billing.
   *
   * @param {object} threat from _scanForThreats()
   * @param {THREE.Vector3} playerPos current player position
   */
  _evaluateAndDodge(threat, playerPos) {
    const CA = Constants.COLLISION_AVOIDANCE;

    if (this._elapsedTime - this._lastDodgeTime < CA.COOLDOWN) return;

    // Player manual override: recent input suppresses dodge
    if (this._elapsedTime - this._lastPlayerInputTime < CA.OVERRIDE_WINDOW) {
      if (this._lastSuppressedReason !== 'manual_override') {
        this._lastSuppressedReason = 'manual_override';
        eventBus.emit(Events.CA_SUPPRESSED, {
          debrisId: threat.debrisId,
          reason: 'manual_override',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'CA',
          text: 'Override. Manual control',
          priority: 'info',
        });
      }
      return;
    }

    // ARM_PILOT suppress (redundant safety; also checked in update)
    if (this._armPilotMode) {
      if (this._lastSuppressedReason !== 'arm_pilot') {
        this._lastSuppressedReason = 'arm_pilot';
        eventBus.emit(Events.CA_SUPPRESSED, {
          debrisId: threat.debrisId,
          reason: 'arm_pilot',
        });
      }
      return;
    }

    // Clear suppression debounce — we're proceeding to dodge
    this._lastSuppressedReason = null;

    const desiredMissM = this._trawlActive ? CA.TRAWL_AVOIDANCE_RADIUS_M : CA.AVOIDANCE_RADIUS_M;
    const missShortfallM = Math.max(0, desiredMissM - threat.missDistM);
    const tcaForDv = Math.max(CA.DV_MIN_TCA_S, threat.tca);
    const requiredDvMs = missShortfallM / tcaForDv;
    const clampBinding = requiredDvMs > CA.DODGE_DV_CEILING_MS;
    const dodgeDvMs = clampBinding
      ? CA.DODGE_DV_CEILING_MS
      : Math.max(CA.BASE_DODGE_DV, requiredDvMs);

    const dirLabel = this._getDirectionLabel(threat.evasionDir, playerPos);

    // Propellant reserve pre-check: CA won't autonomously spend the player's last margin; refuse and name it before
    // attempting.
    const reserveReason = this._checkPropellantReserve();
    if (reserveReason) {
      this._lastDodgeTime = this._elapsedTime;
      eventBus.emit(Events.CA_DODGE_REFUSED, {
        debrisId: threat.debrisId,
        reason: reserveReason,
        requiredDvMs,
      });
      // Refusals bypass mission-floor/rate-limit quieting: safety-critical.
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CA',
        text: `COLLISION AVOIDANCE REFUSED — ${reserveReason}. Debris ${threat.debrisId}, miss ${Math.round(threat.missDistM)}m. MANUAL ACTION REQUIRED`,
        priority: 'critical',
      });
      return;
    }

    // Issue the real impulse. Bills xenon + battery exactly once inside applyCartesianImpulse (no separate
    // RESOURCE_CONSUME emit here: that would double-bill).
    const ev = threat.evasionDir;
    const dvWorld = new THREE.Vector3(ev.x, ev.y, ev.z).multiplyScalar(dodgeDvMs);
    const fired = this._player.applyCartesianImpulse(dvWorld, CA.DODGE_BILLING_WINDOW_S, { dodge: true });   // a dodge is never held for a ducked catch

    this._lastDodgeTime = this._elapsedTime;

    if (!fired) {
      // Refused by applyCartesianImpulse itself: name the reason honestly.
      const reason = this._diagnoseRefusalReason();
      eventBus.emit(Events.CA_DODGE_REFUSED, {
        debrisId: threat.debrisId,
        reason,
        requiredDvMs,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CA',
        text: `COLLISION AVOIDANCE REFUSED — ${reason}. Debris ${threat.debrisId}, miss ${Math.round(threat.missDistM)}m. MANUAL ACTION REQUIRED`,
        priority: 'critical',
      });
      return;
    }

    // Cosmetic puff already fired inside applyCartesianImpulse.

    eventBus.emit(Events.CA_DODGE_EXECUTED, {
      debrisId: threat.debrisId,
      direction: dirLabel,
      magnitude: dodgeDvMs,
      insufficient: clampBinding,
    });

    // The CA autopilot performed an avoidance burn → COLLISION_EVASION (HUD banner + comms consumers); naturally
    // rate-limited by the dodge cooldown (≥ COOLDOWN s between dodges).
    eventBus.emit(Events.COLLISION_EVASION, {
      debrisId: threat.debrisId,
      distanceM: Math.round(threat.missDistM),
      direction: dirLabel,
    });

    if (clampBinding) {
      // Insufficient: the ceiling clamped the burn below what the geometry needed. Never imply safety; bypasses
      // mission-floor/rate-limit quieting.
      eventBus.emit(Events.CA_DODGE_INSUFFICIENT, {
        debrisId: threat.debrisId,
        magnitude: dodgeDvMs,
        requiredDvMs,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CA',
        text: `BRACE. COLLISION AVOIDANCE PARTIAL — ${dodgeDvMs.toFixed(2)} m/s ${dirLabel} fired, insufficient to fully clear debris ${threat.debrisId}`,
        priority: 'critical',
      });
    } else {
      this._emitCaComms({
        sender: 'CA',
        text: `CAUTION: COLLISION AVOIDANCE. Dodge burn fired (${dodgeDvMs.toFixed(2)} m/s ${dirLabel})`,
        priority: 'warning',
      });
    }
  }

  /**
   * @private Reserve-floor guard: the autonomous CA burn must never be what drains the player's LAST xenon/battery
   * margin without their knowledge. Below PROPELLANT_RESERVE_FRAC of either tank, CA declines to fire and reports why
   * (a named refusal, not a silent skip). applyCartesianImpulse's own gates only trip at exactly empty/interlocked;
   * this is a proactive floor above that.
   * @returns {string|null} refusal reason, or null when the reserve is fine
   */
  _checkPropellantReserve() {
    const CA = Constants.COLLISION_AVOIDANCE;
    const frac = CA.PROPELLANT_RESERVE_FRAC ?? 0;
    if (frac <= 0 || !this._player) return null;
    const res = this._player.resources || {};
    const batteryReserve = (Constants.BATTERY_MAX || 100) * frac;
    const fuel = this._getActiveFuel();
    const batteryLow = (res.battery ?? Infinity) <= batteryReserve;
    // The reserve is MASS against the base argon tank (the same for every gas), 5 %.
    const xenonLow = (!fuel || !fuel.fromCargo) && (res.xenon == null ? false : engineGasLowFrac(res) <= frac);
    if (batteryLow) return 'battery reserve — preserving power for essential systems';
    if (xenonLow) return `${this._tankGasName(res)} reserve — preserving propellant for essential maneuvers`;
    return null;
  }

  /**
   * @private Why applyCartesianImpulse refused a burn, mirroring its gate order (power → interlock → battery → xenon →
   * envelope), so the refusal comms name the real reason instead of a generic failure.
   */
  _diagnoseRefusalReason() {
    const p = this._player;
    if (p.thrusterInterlocked) return 'thruster interlocked';
    const res = p.resources || {};
    if ((res.battery ?? 1) <= 0) return 'battery depleted';
    const fuel = this._getActiveFuel();
    if ((!fuel || !fuel.fromCargo) && (res.xenon ?? 1) <= 0) return `${this._tankGasName(res)} tank dry`;
    return 'maneuver envelope limit';
  }

  _getActiveFuel() {
    if (this._resourceSystem && typeof this._resourceSystem.getCurrentFuel === 'function') {
      return this._resourceSystem.getCurrentFuel();
    }
    return (Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL]) || null;
  }

  /**
   * @private Lower-case name of the gas IN the engine tank, for the refusal texts.
   * @param {object} [res] player.resources
   */
  _tankGasName(res) {
    const f = (Constants.FUELS && (Constants.FUELS[res && res.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL])) || null;
    return f && f.name ? f.name.toLowerCase() : 'engine gas';
  }

  _clearThreat() {
    if (this._currentThreat) {
      eventBus.emit(Events.CA_THREAT_CLEARED, {
        debrisId: this._currentThreat.debrisId,
      });

      // Gated. Skipping this on mission 1 avoids a matching "Clear." after every dodge (2× the noise).
      this._emitCaComms({
        sender: 'CA',
        text: 'Clear. Resume heading.',
        priority: 'info',
      });

      this._currentThreat = null;
      this._lastSuppressedReason = null;
    }
  }

  _isArmTarget(debrisId) {
    if (!this._armManager) return false;
    const arms = this._armManager.arms;
    for (let i = 0, len = arms.length; i < len; i++) {
      const arm = arms[i];
      if (arm.target && arm.target.id === debrisId) return true;
    }
    return false;
  }

  /** @private Record the time of recent player movement input (WASD/arrows) for the override window. */
  _detectPlayerInput() {
    if (!this._inputManager) return;
    const keys = this._inputManager.keys;
    if (!keys) return;

    const hasInput = keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD'] ||
                     keys['ArrowUp'] || keys['ArrowDown'] || keys['ArrowLeft'] || keys['ArrowRight'];
    if (hasInput) {
      this._lastPlayerInputTime = this._elapsedTime;
    }
  }

  /** @private Effective avoidance radius by mode (scene units). */
  _getAvoidanceRadius() {
    const CA = Constants.COLLISION_AVOIDANCE;
    return this._trawlActive ? CA.TRAWL_AVOIDANCE_RADIUS : CA.AVOIDANCE_RADIUS;
  }

  /**
   * @private Human-readable direction label from the evasion vector (e.g. "cross-track", "radial-up").
   * @param {{x,y,z}} evasionDir normalised evasion direction (world space)
   * @param {{x,y,z}} playerPos player scene position
   */
  _getDirectionLabel(evasionDir, playerPos) {
    const pLen = Math.sqrt(playerPos.x ** 2 + playerPos.y ** 2 + playerPos.z ** 2);
    if (pLen < 1e-10) return 'lateral';

    const radDot = (evasionDir.x * playerPos.x + evasionDir.y * playerPos.y +
                    evasionDir.z * playerPos.z) / pLen;

    if (Math.abs(radDot) > 0.7) {
      return radDot > 0 ? 'radial-up' : 'radial-down';
    }
    return 'cross-track';
  }
}
