/**
 * AmbientLaunchScheduler.js — launch plumes from any pad as it orbits into view.
 *
 * The scripted opening cameo (GameFlowManager → LaunchCameo) fires ONCE from
 * the player's home pad on a New Game. This scheduler is the ambient extension
 * (FEATURE_FLAGS.LAUNCH_CAMEO_AMBIENT): every ~0.5 s it checks all launch pads
 * from cities.json and fires a plume from any pad that RISES into view — the
 * instant its label pill begins to fade in (facing dot crosses FIRE_GATE=0.03
 * upward) — so later in the pass, and on later orbits, other spaceports launch
 * as the mother flies over them.
 *
 * Example (owner request): on the Thai orbit, Sriharikota's pill begins to
 * fade in ~17 s after spawn and the plume ignites within ~0.5 s of that —
 * climbing to fd 0.44 over the next half minute, once per 9.1-minute orbit.
 * Wenchang fires scripted at 7 s; the two plumes overlap ~17–23 s.
 *
 * Rate limiting keeps it lively but not a fireworks show:
 *  • per pad: at most once per pass (re-armed only after the pad fully sets);
 *  • global: at most one ambient launch per GLOBAL_COOLDOWN_S (30 s — long
 *    enough to avoid volleys, short enough that a queued pad still fires
 *    inside its visibility window; the East-Asia cluster queues, not volleys).
 *
 * Silent by design ("comms is not a tour guide"): no comms line; the pad's
 * label pill flashes cyan briefly at ignition (cityLabels.pulse).
 *
 * Scripted-vs-ambient coordination: ambient fire is deferred until the
 * scripted opening cameo has had its moment (launchCameo.firedOnce, or
 * SCRIPTED_DEFER_S of gameplay as the Continue fallback). The defer gates
 * ONLY the fire decision — edges are tracked fresh every tick regardless, so
 * a pad that rises during the defer is never lost. An edge is consumed ONLY
 * by a successful fire or by the pad setting: cooldowns and a full plume pool
 * pin it (prevFd = -1) until it can fire.
 *
 * Timing runs on an accumulated game-time clock (dt), not wall-clock — pause
 * and slow-mo freeze the scheduler with the rest of the sim.
 *
 * Gated: gameplay state only and not while the Strategic Map is open (a
 * wasted fire). LaunchCameo pools MAX_PLUMES concurrent plumes.
 *
 * The decision core (chooseAmbientPad / updatePadEdges) is pure and
 * Node-testable; all THREE/DOM access lives in the wrapper.
 *
 * @module systems/AmbientLaunchScheduler
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';
import { Constants } from '../core/Constants.js';
import { launchCameo, launchVisible, LAUNCH_FLASH_S, FIRE_GATE } from '../scene/LaunchCameo.js';
import { cityLabels, cityFacingDot } from '../scene/CityLabels.js';
import { latLonToPosition } from '../ui/StrategicMap.js';

/** How often the scheduler evaluates pad visibility (seconds). Short so the
 * fire happens within ~0.5 s of the pad rising — the player needs the whole
 * plume to play while the pad is still in view. 27 pads × cheap math: free. */
export const CHECK_INTERVAL_S = 0.5;
/** Facing-dot gate for "in view" — the instant the pad's pill begins to fade
 * into view (shared with LaunchCameo.fire's gate). Re-exported for tests. */
export { FIRE_GATE };
/** At/below this the pad is considered set — re-arms the per-pass flag.
 * Band [SET_GATE, FIRE_GATE] = [0, 0.03] is the hysteresis. */
export const SET_GATE = 0.0;
/** Minimum seconds between ambient launches. 30 s: long enough to avoid
 * volleys, short enough that a queued pad still fires inside its visibility
 * window (a 90 s cooldown outlived Sriharikota's ~70 s window on th). */
export const GLOBAL_COOLDOWN_S = 30;
/** Seconds ambient holds for the scripted opening cameo before falling back
 * (Continue sessions never run the scripted path). */
export const SCRIPTED_DEFER_S = 30;

/**
 * Roll per-pad edge bookkeeping. Re-arms a pad once it has set; rolls prevFd.
 * Pure — Node-testable.
 * @param {Array<{fd:number, prevFd:number, firedThisPass:boolean}>} pads
 */
export function updatePadEdges(pads) {
  for (const p of pads) {
    if (p.fd < SET_GATE) p.firedThisPass = false;
    p.prevFd = p.fd;
  }
}

/**
 * Pick the best pad to fire this tick, if any. Pure — Node-testable.
 * Eligible = rising edge (prevFd ≤ gate < fd) AND not yet fired this pass.
 * When several rise together (East-Asia cluster), the most central (highest
 * fd) wins. The caller enforces the global cooldown via `cooldownOk`.
 * @param {Array<{name:string, fd:number, prevFd:number, firedThisPass:boolean}>} pads
 * @param {boolean} cooldownOk — global cooldown has elapsed
 * @returns {string|null} pad name to fire, or null
 */
export function chooseAmbientPad(pads, cooldownOk) {
  if (!cooldownOk) return null;
  let best = null;
  for (const p of pads) {
    if (p.firedThisPass) continue;
    if (!(p.prevFd <= FIRE_GATE && p.fd > FIRE_GATE)) continue;
    if (!best || p.fd > best.fd) best = p;
  }
  return best ? best.name : null;
}

const _cam = new THREE.Vector3();
const _centre = new THREE.Vector3();

export class AmbientLaunchScheduler {
  constructor() {
    this._layer = null;
    this._pads = [];          // [{name, lat, lon, world, fd, prevFd, firedThisPass}]
    this._accum = 0;
    this._clock = 0;          // game-time seconds (dt-accumulated; pause/slow-mo safe)
    this._lastFireAt = -Infinity;
    this._firstTickAt = null;  // when gameplay evaluation started (scripted-defer fallback)
    this._deferWasActive = false;
    this._deferOverride = false;  // GFM sets true on non-opening ORBITAL_VIEW entries
    this._onReset = () => this.resetState();
  }

  /**
   * @param {object} opts
   * @param {THREE.Camera} opts.camera — main scene camera (facing-dot source)
   * @param {THREE.Object3D} opts.parent — the Earth group (pads ride with it)
   * @param {number} opts.radius — Earth radius (scene units)
   * @param {boolean} [opts.mirrorLon=true] — match CityLabels / LaunchCameo
   * @param {Array} opts.cities — parsed cities.json entries (launch pads used)
   * @param {Function} [opts.canFire] — extra gate (e.g. strategic map closed)
   */
  init({ camera, parent, radius, mirrorLon = true, cities = [], canFire = null } = {}) {
    if (!camera || !parent) return;
    this._layer = { camera, parent, radius, mirrorLon, canFire };
    this._pads = cities
      .filter((c) => c.kind === 'launch')
      .map((c) => ({
        name: c.name, lat: c.lat, lon: c.lon,
        world: null, fd: 0, prevFd: 0, firedThisPass: false,
      }));
    eventBus.on(Events.GAME_RESET, this._onReset);
  }

  /** Clear cooldowns + per-pass flags (New Game / reset). */
  resetState() {
    this._lastFireAt = -Infinity;
    this._firstTickAt = null;
    this._deferWasActive = false;
    this._clock = 0;
    this._accum = 0;
    this._deferOverride = false;
    for (const p of this._pads) { p.firedThisPass = false; p.prevFd = 0; }
  }

  /**
   * GameFlowManager calls this when ORBITAL_VIEW is entered WITHOUT the
   * scripted opening beats (Continue, or returning from a screen): no scripted
   * cameo is coming, so the defer window is pointless — ambient opens now.
   */
  skipScriptedDefer() { this._deferOverride = true; }

  /**
   * GameFlowManager calls this when the SCRIPTED cameo fires a pad, so the
   * ambient scheduler does not double-fire the same pad this pass.
   * @param {string} name — pad name as listed in cities.json
   */
  markFiredExternally(name) {
    const pad = this._pads.find((p) => p.name === name);
    if (pad) pad.firedThisPass = true;
  }

  /**
   * Per-frame entry from the main loop; self-throttles to CHECK_INTERVAL_S.
   * All timing (defer, cooldown) runs on the accumulated game-time clock, so
   * pause / slow-mo freeze the scheduler with the rest of the sim.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._layer || !this._pads.length) return;
    if (!Constants.FEATURE_FLAGS.LAUNCH_CAMEO || !Constants.FEATURE_FLAGS.LAUNCH_CAMEO_AMBIENT) return;
    this._clock += dt;
    this._accum += dt;
    if (this._accum < CHECK_INTERVAL_S) return;
    this._accum = 0;

    if (!gameState.isGameplay()) return;
    const { camera, parent, radius, mirrorLon, canFire } = this._layer;
    if (canFire && !canFire()) return;

    const now = this._clock;
    if (this._firstTickAt === null) this._firstTickAt = now;

    // Refresh watchability EVERY tick — the edge state must stay fresh even
    // while the fire decision is deferred, or rising edges die unobserved.
    // Watchable = above the horizon AND inside the camera frustum
    // (launchVisible). A pad above the horizon but off-screen (Wenchang on th)
    // must never fire — the plume would be invisible by definition.
    // p.fd stores the WATCHABLE metric (raw fd when watchable, else -1) so the
    // pure edge machinery (chooseAmbientPad / updatePadEdges) works unchanged.
    parent.getWorldPosition(_centre);
    camera.getWorldPosition(_cam);
    for (const p of this._pads) {
      if (!p.world) {
        const s = latLonToPosition(p.lat, mirrorLon ? -p.lon : p.lon, radius);
        p.world = new THREE.Vector3(s.x, s.y, s.z);
        parent.localToWorld(p.world);
      }
      p.fd = launchVisible(p.world, _centre, _cam, camera)
        ? cityFacingDot(p.world, _centre, _cam)
        : -1;
    }

    // Scripted-defer gates ONLY the fire decision. On a New Game the scripted
    // cameo (7 s + poll) sets firedOnce and ambient opens immediately; on a
    // Continue (no scripted cameo exists) it times out after SCRIPTED_DEFER_S.
    const deferActive = !this._deferOverride && !launchCameo.firedOnce && (now - this._firstTickAt) < SCRIPTED_DEFER_S;
    if (!deferActive && this._deferWasActive && !launchCameo.firedOnce) {
      // Defer expired by time: pads that became watchable during the defer
      // produced no tracked rising edge. Make watchable pads eligible once,
      // so the first pass of a Continue session is not silently lost.
      for (const p of this._pads) if (p.fd > 0) p.prevFd = -1;
    }
    this._deferWasActive = deferActive;

    if (!deferActive) {
      const cooldownOk = (now - this._lastFireAt) >= GLOBAL_COOLDOWN_S;
      // Always evaluate edges (cooldownOk=true): the cooldown is enforced
      // AFTER the pick so a blocked pad's edge is pinned, not consumed.
      const name = chooseAmbientPad(this._pads, true);
      updatePadEdges(this._pads);
      if (name) {
        const pad = this._pads.find((p) => p.name === name);
        if (!cooldownOk) {
          // The cooldown must not swallow the edge either (Xichang fired first
          // on th and 90 s ate Sriharikota's whole window): pin it and fire
          // the moment the cooldown lifts — if the pad is still in view.
          pad.prevFd = -1;
        } else {
          // Pool full (MAX_PLUMES): same rule — a refusal keeps the edge live
          // until a slot frees, it never consumes the pass.
          const fired = launchCameo.fire(pad);
          if (!fired) { pad.prevFd = -1; return; }
          pad.firedThisPass = true;
          this._lastFireAt = now;
          // Short cyan flash on the pad's pill at ignition ("launching NOW") —
          // then the plume itself holds the eye. No comms (tour-guide rule).
          cityLabels.pulse(pad.name, LAUNCH_FLASH_S);
        }
      }
      return;
    }

    updatePadEdges(this._pads);
  }

  dispose() {
    eventBus.off(Events.GAME_RESET, this._onReset);
    this._layer = null;
    this._pads = [];
  }
}

/** Singleton (wired in main.js). */
export const ambientLaunchScheduler = new AmbientLaunchScheduler();
export default AmbientLaunchScheduler;
