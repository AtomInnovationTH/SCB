/**
 * ZoomLadder.js — the Zoom Ladder's pure, headless gesture/decision core (S1).
 *
 * Implements the binding API contract in docs/ladder/06-core-api.md: the
 * (floor, z01) state machine — wall detection, spring charge (τ decay,
 * ≥3-events/400 ms gate, 1.6× firm-in, ≤20% creep, one-crossing-per-gesture
 * lock, settle-back, momentum-tail rejection, peek), crossing decisions with
 * entry z01 0.25/0.75, dock-gated hard walls, subject-fallback re-aims, and
 * the alarm knock → klaxon → auto-ride escalation.
 *
 * PURE & DETERMINISTIC (docs/ladder/03-plan.md S1): no THREE, no DOM, no
 * EventBus, no Date.now, no timers. Every input carries `tMs` (the caller's
 * monotonic clock, in ms); the same call sequence always yields the same
 * decisions. Each input method synchronously returns a `Decision[]` — the
 * core never calls out; S2 (WheelRouter / ride engine / rail) translates
 * decisions into camera/UI/audio actions.
 *
 * The only permitted imports are Constants and FloorContract; this module
 * needs FloorContract alone (default floor table + spring/geometry numbers).
 *
 * Direction vocabulary (00-spec.md §4 "scroll up = zoom in"):
 *   dir 'in'  → z01 decreases → lower wall → side 'down' → toFloor = floor−1
 *   dir 'out' → z01 increases → upper wall → side 'up'   → toFloor = floor+1
 * Inbound (zoom-in, toward interiors) crossings are the FIRM direction:
 * threshold = CHARGE_THRESHOLD × destination `humps.inFirmness` (1.6×);
 * outbound crossings use the soft 1× base (firm-in / soft-out).
 *
 * Decision union (see docs/ladder/06-core-api.md for field semantics):
 *   move | charge | cross | denied | settle | ride | reaim | verb | alarm
 *
 * S1-chosen defaults for contract gaps (documented in 06-core-api.md
 * "S1 implementation notes", all overridable via constructor deps):
 *   spring.CHARGE_THRESHOLD 3, rules.wheelZ01Step 0.04,
 *   rules.knockToKlaxonMs 1000, rules.initialFloor 4 / initialZ01 0.5.
 *
 * @module core/ZoomLadder
 */

import { FloorContract } from './FloorContract.js';

/** Float tolerance for threshold/zero comparisons on decayed charge. */
const EPS = 1e-9;

/**
 * Normalized ladder depth from a camera distance (clamped 0..1).
 * Log10 interpolation on the floor's `camera.rangeLog10` (01-numbers.md).
 *
 * @param {object} floor - a FloorContract.FLOORS entry
 * @param {number} distU - camera→anchor distance in scene units
 * @returns {number} z01 in [0, 1]
 */
export function z01FromDistance(floor, distU) {
  const [lo, hi] = floor.camera.rangeLog10;
  if (!(distU > 0)) return 0;
  const z = (Math.log10(distU) - lo) / (hi - lo);
  return Math.min(1, Math.max(0, z));
}

/**
 * Inverse of z01FromDistance (z01 clamped 0..1 first).
 *
 * @param {object} floor - a FloorContract.FLOORS entry
 * @param {number} z01
 * @returns {number} camera distance in scene units
 */
export function distanceFromZ01(floor, z01) {
  const [lo, hi] = floor.camera.rangeLog10;
  const z = Math.min(1, Math.max(0, z01));
  return Math.pow(10, lo + z * (hi - lo));
}

/** S1 extension: absolute outbound charge threshold (router-normalized wheel
 *  mag units). The docs lock τ/window/ratio but no absolute value — see
 *  06-core-api.md "S1 implementation notes". Inbound = this × inFirmness. */
const DEFAULT_SPRING_EXTENSIONS = { CHARGE_THRESHOLD: 3 };

/** S1 defaults for behavior knobs the contract leaves to the caller. */
const DEFAULT_RULES = {
  initialFloor: 4,        // COMMAND — the shipped gameplay floor
  initialZ01: 0.5,
  initialDocked: false,
  wheelZ01Step: 0.04,     // free-scroll z01 per unit mag (scroll gain)
  knockToKlaxonMs: 1000,  // knock → klaxon (escalation step 1; not doc-pinned)
  autoRideDelayMs: 3000,  // klaxon → auto-ride (locked: VisualLaw 3 s)
  rideMsRange: [450, 650],// crossing-ride window (locked: VisualLaw)
  miniRideMs: 200,        // hotkey-jump mini-ride (locked: VisualLaw)
  reaimMs: 300,           // re-aim / subject-loss soft ride (locked: VisualLaw)
};

export class ZoomLadder {
  /**
   * @param {object} [deps] - injectable for tests; production passes nothing
   * @param {Array}  [deps.floors]   - FloorContract.FLOORS-shaped table
   * @param {object} [deps.geometry] - FloorContract.LADDER_GEOMETRY overrides
   * @param {object} [deps.spring]   - FloorContract.HUMP_SPRING (+extensions) overrides
   * @param {object} [deps.rules]    - DEFAULT_RULES overrides
   */
  constructor({ floors, geometry, spring, rules } = {}) {
    this._floors = floors || FloorContract.FLOORS;
    this._geo = { ...FloorContract.LADDER_GEOMETRY, ...(geometry || {}) };
    this._spring = { ...FloorContract.HUMP_SPRING, ...DEFAULT_SPRING_EXTENSIONS, ...(spring || {}) };
    this._rules = { ...DEFAULT_RULES, ...(rules || {}) };

    this._byId = new Map(this._floors.map((f) => [f.id, f]));

    // Ladder position — ALWAYS a valid (floor, z01); the camera never rests
    // between floors (00-spec.md §4).
    this._floor = this._rules.initialFloor;
    this._z01 = this._rules.initialZ01;

    // Spring state. _rawCharge is in wheel-mag units and decays with τ;
    // decisions/getState expose it normalized against the side's threshold.
    this._rawCharge = 0;
    this._chargeSide = null;              // 'up' | 'down' | null
    this._chargeEvents = [];              // tMs of charge-contributing events
    this._lastDecayTMs = -Infinity;

    // Gesture tracking (one crossing per gesture + momentum-tail rejection).
    this._gestureLocked = false;
    this._lastWheelTMs = -Infinity;
    this._lastWheelDir = null;
    this._lastWheelMag = 0;
    this._lastInputTMs = -Infinity;       // wheel/command/jump/aim — settle idle base

    this._settled = false;                // settle-back latched until next input
    this._ride = null;                    // { kind } while mode === 'riding'
    this._preRide = null;                 // (floor, z01) revert point, alarmAuto only

    this._subject = null;                 // opaque ref (or 'cluster'/'ship' tokens)
    this._docked = this._rules.initialDocked;
    this._alarm = null;                   // { targetFloor, stage, knockTMs, klaxonTMs }
  }

  // ── Input methods (all return Decision[]) ────────────────────────────────

  /**
   * One router-normalized wheel event. dir: 'in'|'out' (invert already
   * applied by the router); mag: positive magnitude.
   */
  wheel({ tMs, dir, mag }) {
    if ((dir !== 'in' && dir !== 'out') || !(mag > 0)) return [];
    this._tick(tMs);
    const decisions = [];

    // Any scroll input cancels a pending alarm escalation (00-spec.md §6).
    this._cancelPendingAlarm(decisions);

    if (this._ride) {
      // Scroll cancels only alarm auto-rides, not player rides (06-core-api).
      if (this._ride.kind === 'alarmAuto') {
        this._cancelAlarmAutoRide(decisions);
      }
      // Wheel is otherwise ignored while riding (buffered nowhere) — but the
      // gesture bookkeeping still sees it, so a momentum tail spanning the
      // ride cannot masquerade as a fresh gesture at arrival.
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    this._settled = false;
    this._lastInputTMs = tMs;

    const wallLo = this._geo.WALL_ZONE_FRAC;
    const wallHi = 1 - this._geo.WALL_ZONE_FRAC;
    const side = dir === 'in' ? 'down' : 'up';

    // Momentum-tail rejection: a same-direction continuation (< gesture-
    // silence gap) with strictly decaying mag charges ZERO — only deliberate
    // re-pushes (mag >= previous) count. Sequence heads charge: the flick
    // itself is deliberate; its decaying tail is not (00-spec.md §4).
    const gap = tMs - this._lastWheelTMs;
    const isTail = gap < this._spring.GESTURE_LOCK_SILENCE_MS &&
      dir === this._lastWheelDir && mag < this._lastWheelMag;

    // Direction reversal releases the spring (the push is let go).
    if (this._chargeSide && this._chargeSide !== side) {
      if (this._rawCharge > EPS) {
        decisions.push({ type: 'charge', side: this._chargeSide, charge: 0, peek: false });
      }
      this._releaseSpring();
    }

    const target = dir === 'in'
      ? this._z01 - mag * this._rules.wheelZ01Step
      : this._z01 + mag * this._rules.wheelZ01Step;
    const wallward = dir === 'in' ? target < wallLo : target > wallHi;

    if (!wallward) {
      // Free scroll inside the floor (movement clamps at the wall edges;
      // only charging takes the camera INTO a wall).
      if (target !== this._z01) {
        this._z01 = target;
        decisions.push({
          type: 'move', floor: this._floor, z01: this._z01,
          inWall: this._z01 < wallLo || this._z01 > wallHi, creepFrac: 0,
        });
      }
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    // ── Wall zone: charge the spring ─────────────────────────────────────
    // After a crossing/denial, further charging is locked until GESTURE_LOCK_
    // SILENCE_MS of input silence (one crossing per gesture). Tail events
    // contribute MOMENTUM_TAIL_CHARGE × mag — canonically zero.
    const chargeMag = this._gestureLocked
      ? 0
      : (isTail ? this._spring.MOMENTUM_TAIL_CHARGE * mag : mag);
    if (chargeMag > 0) {
      this._rawCharge += chargeMag;        // decay already applied by _tick
      this._chargeSide = side;
      this._chargeEvents.push(tMs);
    }
    // Event-count gate window (≥ MIN_EVENTS within EVENT_WINDOW_MS).
    const windowStart = tMs - this._spring.EVENT_WINDOW_MS;
    this._chargeEvents = this._chargeEvents.filter((t) => t > windowStart);

    const destId = side === 'down' ? this._floor - 1 : this._floor + 1;
    const dest = this._byId.get(destId);
    const threshold = this._thresholdFor(side, dest);
    const norm = Math.min(1, this._rawCharge / threshold);

    // A charge decision accompanies EVERY wall-zone wheel call, so the rail
    // never stutters (06-core-api.md emission guarantees).
    decisions.push({
      type: 'charge', side, charge: norm,
      peek: norm > this._spring.PEEK_CHARGE_FRAC,
    });

    // Crossing requires intent: charge past threshold AND enough deliberate
    // events inside the window — and at most one cross/denied per gesture.
    const wantsCross = !this._gestureLocked &&
      norm >= 1 - EPS &&
      this._chargeEvents.length >= this._spring.MIN_EVENTS;

    if (wantsCross && dest && !this._dockDenies(dest)) {
      decisions.push({
        type: 'cross',
        fromFloor: this._floor,
        toFloor: destId,
        entryZ01: side === 'down' ? this._geo.ENTRY_Z01_FROM_ABOVE : this._geo.ENTRY_Z01_FROM_BELOW,
        direction: side === 'down' ? 'in' : 'out',
        rideMsRange: [...this._rules.rideMsRange],
      });
      // The spring released through the wall; S2 flies the reframe ride.
      this._floor = destId;
      this._z01 = decisions[decisions.length - 1].entryZ01;
      this._ride = { kind: 'cross', toFloor: destId };
      this._releaseSpring();
      this._gestureLocked = true;
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    // No crossing this event: the camera creeps up to CREEP_FRAC of the
    // remaining wall distance so the push is visible (creep tracks the live
    // charge, so a decaying spring relaxes the camera back on its own).
    const creepFrac = this._spring.CREEP_FRAC * norm;
    const newZ01 = side === 'down'
      ? wallLo - this._geo.WALL_ZONE_FRAC * creepFrac
      : wallHi + this._geo.WALL_ZONE_FRAC * creepFrac;
    if (newZ01 !== this._z01) {
      this._z01 = newZ01;
      decisions.push({
        type: 'move', floor: this._floor, z01: this._z01,
        inWall: this._z01 < wallLo || this._z01 > wallHi, creepFrac,
      });
    }

    if (wantsCross) {
      // The spring met its threshold but the wall refuses: dock-gated floor
      // (hard wall + hint, 00-spec.md §3 F2) or the end of the ladder.
      decisions.push(dest
        ? { type: 'denied', floor: dest.id, reason: 'undocked', hint: dest.humps?.deniedHint ?? null }
        : { type: 'denied', floor: this._floor, reason: 'ladder-end', hint: null });
      this._gestureLocked = true;   // exactly one cross OR denied per gesture
    }

    this._recordWheel(tMs, dir, mag);
    return decisions;
  }

  /** Discrete command: 'esc' | 'pageUp' | 'pageDown' | 'space' (00-spec §5). */
  command({ tMs, type }) {
    this._tick(tMs);
    this._lastInputTMs = tMs;
    const decisions = [];

    if (type === 'esc') {
      // Esc cancels an alarm escalation (pending or in-flight auto-ride)
      // before it means "ride one floor up". Player rides are NOT cancelled.
      if (this._ride && this._ride.kind === 'alarmAuto') {
        this._cancelPendingAlarm(decisions);   // a replaced alarm's fresh knock dies too
        this._cancelAlarmAutoRide(decisions);
        return decisions;
      }
      this._cancelPendingAlarm(decisions);
      if (decisions.length > 0) return decisions;
      if (this._ride) return [];
      return this._rideTo(this._floor + 1, 'esc', null);
    }

    if (this._ride) return [];   // mid-flight: page/space land nowhere

    if (type === 'pageUp') return this._rideTo(this._floor + 1, 'page', null);
    if (type === 'pageDown') return this._rideTo(this._floor - 1, 'page', null);

    if (type === 'space') {
      const verb = this._byId.get(this._floor)?.spaceVerb;
      return verb ? [{ type: 'verb', floor: this._floor, verb }] : [];
    }
    return [];
  }

  /** Hotkey / rail-notch instant jump — still a ~200 ms mini-ride, never a cut. */
  jump({ tMs, toFloor }) {
    this._tick(tMs);
    this._lastInputTMs = tMs;
    if (this._ride) return [];
    if (toFloor === this._floor || !this._byId.has(toFloor)) return [];
    return this._rideTo(toFloor, 'jump', this._rules.miniRideMs);
  }

  /** Click = re-aim the elevator; double-click adds a one-floor ride down. */
  aim({ tMs, subject, andRideDown }) {
    this._tick(tMs);
    this._lastInputTMs = tMs;
    this._settled = false;
    this._subject = subject;
    const decisions = [{ type: 'reaim', subject, soft: true, durationMs: this._rules.reaimMs }];
    if (andRideDown && !this._ride && this._byId.has(this._floor - 1)) {
      decisions.push(...this._rideTo(this._floor - 1, 'aimDown', null));
    }
    return decisions;
  }

  /**
   * Subject destroyed/despawned. Fallback ladder (00-spec.md §5):
   * debris → its cluster → ship; daughter → ship. Soft 300 ms, never a cut.
   * The 'cluster'/'ship' tokens are resolved to real refs by S2.
   */
  subjectLost({ tMs, kind }) {
    this._tick(tMs);
    const token = (kind === 'daughter' || this._subject === 'cluster') ? 'ship' : 'cluster';
    this._subject = token;
    return [{ type: 'reaim', subject: token, soft: true, durationMs: this._rules.reaimMs }];
  }

  /** Conjunction alarm raised/cleared by S2. Raise emits the knock. */
  alarm({ tMs, targetFloor, active }) {
    this._tick(tMs);
    if (!active) {
      this._alarm = null;
      return [];
    }
    const pending = this._alarm && this._alarm.stage !== 'cancelled';
    if (pending && this._alarm.targetFloor === targetFloor) return [];   // already escalating
    this._alarm = { targetFloor, stage: 'knock', knockTMs: tMs, klaxonTMs: null };
    return [{ type: 'alarm', stage: 'knock', targetFloor }];
  }

  /** F2 gating input: docked state of the ship (boolean). */
  dockChanged({ docked }) {
    this._docked = !!docked;
    return [];
  }

  /** S2 reports the crossing/mini ride (or crossfade) completed. */
  rideFinished({ tMs }) {
    this._tick(tMs);
    this._ride = null;
    this._preRide = null;
    return [];
  }

  /**
   * Tick: charge decay, gesture-lock release, settle-back, and the
   * knock → klaxon → auto-ride escalation. Call every frame with the same
   * monotonic clock the inputs use.
   *
   * @param {number} tMs
   * @returns {Array} Decision[]
   */
  update(tMs) {
    this._tick(tMs);
    const decisions = [];

    // Alarm escalation (schedule anchored to the knock, so late/lumped update
    // calls emit the stages in order within one return).
    const a = this._alarm;
    if (a && a.stage === 'knock' && tMs >= a.knockTMs + this._rules.knockToKlaxonMs) {
      a.stage = 'klaxon';
      a.klaxonTMs = a.knockTMs + this._rules.knockToKlaxonMs;
      decisions.push({ type: 'alarm', stage: 'klaxon', targetFloor: a.targetFloor });
    }
    if (a && a.stage === 'klaxon' && !this._ride &&
        tMs >= a.klaxonTMs + this._rules.autoRideDelayMs) {
      a.stage = 'autoRide';
      decisions.push({ type: 'alarm', stage: 'autoRide', targetFloor: a.targetFloor });
      if (a.targetFloor !== this._floor && this._byId.has(a.targetFloor)) {
        decisions.push(...this._rideTo(a.targetFloor, 'alarmAuto', null));
      }
    }

    // Settle-back: idle beyond SETTLE_IDLE_MS while creeped inside a wall
    // zone → one eased return to the wall edge. Never fires mid-ride.
    if (!this._ride) {
      const wallLo = this._geo.WALL_ZONE_FRAC;
      const wallHi = 1 - this._geo.WALL_ZONE_FRAC;
      const inWall = this._z01 < wallLo || this._z01 > wallHi;
      if (inWall && tMs - this._lastInputTMs > this._spring.SETTLE_IDLE_MS) {
        const edge = this._z01 < wallLo ? wallLo : wallHi;
        this._z01 = edge;
        this._settled = true;
        this._releaseSpring();
        decisions.push({ type: 'settle', floor: this._floor, z01: edge });
      }
    }

    return decisions;
  }

  // ── State snapshot (rail + debugging; fresh object, mutation-safe) ───────

  getState() {
    let mode = 'free';
    if (this._ride) mode = 'riding';
    else if (this._chargeSide) mode = 'charging';
    else if (this._settled) mode = 'settling';

    let charge = 0;
    if (this._chargeSide) {
      const destId = this._chargeSide === 'down' ? this._floor - 1 : this._floor + 1;
      charge = Math.min(1, this._rawCharge / this._thresholdFor(this._chargeSide, this._byId.get(destId)));
    }

    return {
      floor: this._floor,
      z01: this._z01,
      mode,
      charge,
      chargeSide: this._chargeSide,
      subject: this._subject,
      docked: this._docked,
      alarm: this._alarm ? { targetFloor: this._alarm.targetFloor, stage: this._alarm.stage } : null,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Exponential charge decay + gesture-lock release, up to tMs. */
  _tick(tMs) {
    if (Number.isFinite(this._lastDecayTMs) && tMs > this._lastDecayTMs) {
      this._rawCharge *= Math.exp(-(tMs - this._lastDecayTMs) / this._spring.CHARGE_TAU_MS);
    }
    this._lastDecayTMs = tMs;
    if (this._gestureLocked && tMs - this._lastWheelTMs >= this._spring.GESTURE_LOCK_SILENCE_MS) {
      this._gestureLocked = false;
    }
    if (this._chargeSide && this._rawCharge < EPS) {
      this._releaseSpring();   // fully drained at the wall edge
    }
  }

  _recordWheel(tMs, dir, mag) {
    this._lastWheelTMs = tMs;
    this._lastWheelDir = dir;
    this._lastWheelMag = mag;
  }

  _releaseSpring() {
    this._rawCharge = 0;
    this._chargeSide = null;
    this._chargeEvents = [];
  }

  /** Crossing threshold for a wall side. Inbound (down) is the firm 1.6×
   *  direction; the ratio comes from the DESTINATION floor's hump. */
  _thresholdFor(side, dest) {
    const base = this._spring.CHARGE_THRESHOLD;
    if (side !== 'down') return base;
    const firmness = dest?.humps?.inFirmness ?? this._spring.IN_FIRMNESS_RATIO;
    return base * firmness;
  }

  /** True when entering `dest` must be refused for lack of a dock. */
  _dockDenies(dest) {
    return !!(dest?.humps?.entryRequiresDock && !this._docked);
  }

  /**
   * Shared ride starter for jump/esc/page/aimDown/alarmAuto. Applies the
   * dock gate, moves the state to (toFloor, entryZ01) immediately (the
   * camera never rests between floors), and marks the core riding.
   */
  _rideTo(toId, kind, miniMs) {
    const dest = this._byId.get(toId);
    if (!dest) return [];
    if (this._dockDenies(dest)) {
      return [{ type: 'denied', floor: dest.id, reason: 'undocked', hint: dest.humps?.deniedHint ?? null }];
    }
    const entryZ01 = toId > this._floor
      ? this._geo.ENTRY_Z01_FROM_BELOW
      : this._geo.ENTRY_Z01_FROM_ABOVE;
    if (kind === 'alarmAuto') {
      this._preRide = { floor: this._floor, z01: this._z01 };   // scroll/Esc revert point
    }
    this._floor = toId;
    this._z01 = entryZ01;
    this._ride = { kind, toFloor: toId };
    this._settled = false;
    this._releaseSpring();
    return [{ type: 'ride', toFloor: toId, entryZ01, kind, miniMs }];
  }

  /** Cancel a knock/klaxon-stage escalation (wheel or Esc arrived). */
  _cancelPendingAlarm(decisions) {
    const a = this._alarm;
    if (a && (a.stage === 'knock' || a.stage === 'klaxon')) {
      a.stage = 'cancelled';
      decisions.push({ type: 'alarm', stage: 'cancelled', targetFloor: a.targetFloor });
    }
  }

  /**
   * Cancel an in-flight alarm auto-ride: revert to the pre-ride position and
   * ALWAYS report the cancellation — even if S2 cleared or replaced the alarm
   * mid-flight, the ride abort must reach the decision stream (a silent
   * revert would desync the core from the camera S2 is still flying).
   */
  _cancelAlarmAutoRide(decisions) {
    const targetFloor = this._ride?.toFloor ?? this._alarm?.targetFloor ?? null;
    if (this._preRide) {
      this._floor = this._preRide.floor;
      this._z01 = this._preRide.z01;
    }
    this._ride = null;
    this._preRide = null;
    if (this._alarm && this._alarm.stage === 'autoRide') {
      this._alarm.stage = 'cancelled';
    }
    decisions.push({ type: 'alarm', stage: 'cancelled', targetFloor });
  }
}
