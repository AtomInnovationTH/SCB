/**
 * @module systems/SimClock — game time runs faster while the reaction wheels turn the ship (DECISIONS §57 row 5,
 * owner 2026-11-03: "Time runs about 8× faster during autopilot turns, so a 90° turn shows in about 20 s").
 *
 * ONE global sim-time scale `k`, applied in main.js's frame between the TimeAuthority update and the system updates:
 *   - every system that runs on game time gets `dt × k` (and `dtWorld × k`), in `n` equal steps of at most
 *     `SIM_SPEEDUP.MAX_STEP_S` (0.1 s) game time each — the step every system already gets at a 10 fps frame;
 *   - the wall clock keeps input polling, camera, HUD drawing, comms line pacing, menus and idle timers.
 *
 * k targets `SIM_SPEEDUP.K` (8) while the autopilot reports a wheel turn (`isWheelTurnActive()`) and no gate is up,
 * otherwise 1. It ramps on the WALL clock: up over RAMP_UP_S (0.5 s), down over RAMP_DOWN_S (0.25 s); any gate drops
 * k to 1 the same frame. It is NOT TimeAuthority's rate: that scales `dtWorld` only and flips the autopilot to its
 * orbit-frame hold (`_isWarpAbove1`); k scales the whole game step, and a TimeAuthority rate ≠ 1 is itself a gate,
 * so k never multiplies a warped or held world.
 *
 * Gates (force k = 1), in report order (`simGate`): not in play (menu, opening dance), paused, a world hold (open
 * drawer, codex page, held clock), a TimeAuthority rate ≠ 1 or a trip clock, catch slow-mo, a net in flight (mother or
 * daughter) or the lasso out, a catch ceremony (CeremonyTimeScale), the leash hand-off, a conjunction alert, the player
 * flying a daughter by hand, arrow-key turning. A daughter merely out on her tether is NOT a gate: her flight, reel and
 * tether physics run in the same ≤ 0.1 s steps.
 *
 * Pure apart from its own fields; no imports beyond Constants, so tests drive it headless.
 */
import { Constants } from '../core/Constants.js';

const NET_STATES = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.STATES) || {};
/** Net states between launch and the catch roll's answer: the net is flying or wrapping the piece. */
const NET_FLYING = new Set([
  NET_STATES.LAUNCHING, NET_STATES.SPINNING_UP, NET_STATES.FLIGHT, NET_STATES.CONTACT,
  NET_STATES.BRAKE, NET_STATES.ENVELOP, NET_STATES.CINCH_CLOSING, NET_STATES.SECURE_CHECK,
].filter(Boolean));

/** The gate names `simGate` can return, in the order it checks them. */
export const SIM_GATES = Object.freeze([
  'notInPlay', 'paused', 'worldHold', 'timeRate', 'trip', 'slowMo', 'netInFlight', 'lasso',
  'ceremony', 'leash', 'conjunction', 'daughterByHand', 'arrowKeys',
]);

/**
 * The first gate that forces k = 1, or null when none is up. Missing fields read as "no gate", except `gameplay`
 * (must be true) and `taRate` (must be exactly 1 when given).
 * @param {object} s
 * @param {boolean} s.gameplay        gameState.isGameplay()
 * @param {boolean} [s.dance]         the opening dance runs
 * @param {boolean} [s.paused]
 * @param {boolean} [s.worldHold]     open drawer / codex page (TimeAuthority.worldHoldOpen) or a held world clock
 * @param {number}  [s.taRate]        timeAuthority.rate
 * @param {boolean} [s.trip]          a trip's clock runs (gameFlowManager.isTripRunning())
 * @param {boolean} [s.slowMo]        catch slow-mo
 * @param {boolean} [s.netInFlight]   a mother net out (hasMotherNetInFlight) or any net flying (netsFlying)
 * @param {boolean} [s.lasso]         lassoSystem.active
 * @param {boolean} [s.ceremony]      CeremonyTimeScale.get() < 1 or an owner set
 * @param {boolean} [s.leash]         player.leashDriver.busy
 * @param {boolean} [s.conjunction]   a conjunction alert is up
 * @param {boolean} [s.daughterByHand] inputManager.isArmHandFlying(): pilot view AND a hand-flying key held
 * @param {boolean} [s.arrowKeys]     an arrow key is held
 * @returns {string|null}
 */
export function simGate(s) {
  if (!s || !s.gameplay || s.dance) return 'notInPlay';
  if (s.paused) return 'paused';
  if (s.worldHold) return 'worldHold';
  if (s.taRate !== undefined && s.taRate !== 1) return 'timeRate';
  if (s.trip) return 'trip';
  if (s.slowMo) return 'slowMo';
  if (s.netInFlight) return 'netInFlight';
  if (s.lasso) return 'lasso';
  if (s.ceremony) return 'ceremony';
  if (s.leash) return 'leash';
  if (s.conjunction) return 'conjunction';
  if (s.daughterByHand) return 'daughterByHand';
  if (s.arrowKeys) return 'arrowKeys';
  return null;
}

/**
 * True when any net in `nets` (captureNetSystem.activeNets: mother pods and daughters alike) is flying or wrapping
 * its piece (launch → the catch roll). A daughter's net in flight gates the speed-up; her tether alone does not.
 * @param {Array<{state:string,isActive?:boolean}>} nets
 */
export function netsFlying(nets) {
  if (!Array.isArray(nets)) return false;
  for (let i = 0; i < nets.length; i++) {
    const n = nets[i];
    if (n && n.isActive !== false && NET_FLYING.has(n.state)) return true;
  }
  return false;
}

/**
 * Steps a frame's game time is cut into so each is ≤ maxStepS (at least 1).
 * @param {number} gameDt   the frame's game seconds (dt × k)
 * @param {number} [maxStepS]
 */
export function substepCount(gameDt, maxStepS = Constants.SIM_SPEEDUP.MAX_STEP_S) {
  if (!(gameDt > 0) || !(maxStepS > 0)) return 1;
  return Math.max(1, Math.ceil(gameDt / maxStepS - 1e-9));
}

export class SimClock {
  /** @param {object} [cfg] defaults to Constants.SIM_SPEEDUP */
  constructor(cfg = Constants.SIM_SPEEDUP) {
    this.K = cfg.K;
    this.rampUpS = cfg.RAMP_UP_S;
    this.rampDownS = cfg.RAMP_DOWN_S;
    this.maxStepS = cfg.MAX_STEP_S;
    /** The live scale (1 … K). */
    this.k = 1;
    /** The gate that held k at 1 on the last update, or null. */
    this.gate = null;
    /** Did the last update ask for the speed-up (wheel turn running, no gate)? */
    this.wanted = false;
    // The frame's steps, written by frame(): reused, never reallocated.
    this.n = 1;
    this.stepDt = 0;
    this.stepDtWorld = 0;
    this.gameDt = 0;
    this.gameDtWorld = 0;
  }

  /**
   * Advance k by one frame of WALL time.
   * @param {number} wallDt   real seconds this frame (realDt, before slow-mo)
   * @param {boolean} wheelTurn  autopilotSystem.isWheelTurnActive()
   * @param {object} signals  the gate inputs (see simGate)
   * @returns {number} k
   */
  update(wallDt, wheelTurn, signals) {
    const gate = simGate(signals);
    this.gate = gate;
    this.wanted = !!wheelTurn && gate === null;
    if (gate !== null) { this.k = 1; return 1; }   // a gate drops k to 1 the same frame
    const w = wallDt > 0 ? wallDt : 0;
    const span = this.K - 1;
    if (this.wanted) {
      this.k = this.rampUpS > 0 ? Math.min(this.K, this.k + span * w / this.rampUpS) : this.K;
    } else {
      this.k = this.rampDownS > 0 ? Math.max(1, this.k - span * w / this.rampDownS) : 1;
    }
    return this.k;
  }

  /**
   * Cut this frame's step: gameDt = dt × k cut into n steps of ≤ maxStepS game seconds; dtWorld follows in proportion.
   * At k = 1 and dt ≤ maxStepS this is one step of exactly (dt, dtWorld): the frame is unchanged.
   * @param {number} dt       the frame's dt (real, slow-mo scaled)
   * @param {number} dtWorld  timeAuthority.dtWorld
   * @returns {SimClock} this (n, stepDt, stepDtWorld, gameDt, gameDtWorld)
   */
  frame(dt, dtWorld) {
    const k = this.k;
    const d = dt > 0 ? dt : 0;
    const dw = dtWorld > 0 ? dtWorld : 0;
    this.gameDt = k === 1 ? d : d * k;
    this.gameDtWorld = k === 1 ? dw : dw * k;
    this.n = substepCount(this.gameDt, this.maxStepS);
    this.stepDt = this.n === 1 ? this.gameDt : this.gameDt / this.n;
    this.stepDtWorld = this.n === 1 ? this.gameDtWorld : this.gameDtWorld / this.n;
    return this;
  }

  /** Reset to 1× (new run, menu). */
  reset() {
    this.k = 1; this.gate = null; this.wanted = false;
  }
}

export default SimClock;
