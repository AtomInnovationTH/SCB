/**
 * @module core/ZoomLadder — the Zoom Ladder's pure, headless gesture/decision core. Contract:
 * archive/ladder/06-core-api.md.
 *
 * (floor, z01) state machine: wall detection, spring charge (τ decay, ≥ MIN_EVENTS (4 in the contract) within
 * EVENT_WINDOW_MS (400 ms), 1.6× firm-in, ≤20% creep, one crossing per gesture, settle-back, momentum-tail rejection,
 * peek), crossing decisions with entry z01 0.25/0.75, dock-gated hard walls, subject-fallback re-aims, and the alarm
 * knock → klaxon → auto-ride escalation.
 *
 * PURE & DETERMINISTIC: no THREE, no DOM, no EventBus, no Date.now, no timers. Every input carries `tMs`
 * (the caller's monotonic clock, ms); the same call sequence always yields the same decisions. Each input method
 * synchronously returns a `Decision[]`; the core never calls out
 * (WheelRouter / ride engine / rail translate decisions into camera/UI/audio actions). Permitted imports are Constants
 * and FloorContract; this module needs FloorContract alone.
 *
 * Direction (scroll up = zoom in; docs/ladder/00-spec.md §4):
 *   dir 'in'  → z01 decreases → lower wall → side 'down' → toFloor = floor−1
 *   dir 'out' → z01 increases → upper wall → side 'up'   → toFloor = floor+1
 * Inbound crossings are the FIRM direction: threshold = CHARGE_THRESHOLD × destination `humps.inFirmness` (1.6×);
 * outbound use the soft 1× base.
 *
 * Decision union: move | charge | cross | denied | settle | ride | reaim | verb | alarm
 *
 * Flicks are the PRIMARY navigation quantum; the sustained push stays as the additive fallback. A flick = deliberate
 * (non-tail) mags accumulating to ≥ FLICK_MIN_MAG within FLICK_MAX_DRIVE_MS, where the trigger event must RISE above
 * the run's first event (or alone meet the threshold): equal-mag streams (wheel notches, plateaus) and slow/sparse
 * scrolling never flick; tail events neither accumulate nor trigger
 * (a tail resets and re-arms the detector, so a flick's own momentum never reads as a second flick). One flick
 * mid-floor rides WITHIN the floor to that wall edge ({type:'ride', kind:'flickWall', miniMs: FLICK_RIDE_MS}).
 *
 * Defaults for contract gaps (overridable via constructor deps): spring.CHARGE_THRESHOLD 3
 * (only a fallback: FloorContract.HUMP_SPRING.CHARGE_THRESHOLD 1.2 wins), rules.wheelZ01Step 0.04,
 * rules.knockToKlaxonMs 1000, rules.initialFloor 2 / initialZ01 0.5.
 *
 * `place({tMs, floor, z01})` is the ONE placement method: a settled cut with no decision, only for invisible moments
 * (the depot park under the SHOP overlay; the saved-view restore before the first engage). Every visible transition is
 * a ride (00-spec.md §4).
 *
 * `ceremonyRide` takes an optional `entryZ01` override (the intro dive lands CLOSE on the hull floor; absent → the
 * geometry default, byte-identical). `dollyTo({tMs, z01, rideMs})` is a WITHIN-FLOOR ride to an arbitrary z01
 * (dwell-phase camera drift, modeled on the flickWall ride). Like `place` it is not an input: the settle clock is
 * untouched, so a target inside a wall band settles to the edge on the next update (T6, archive/ladder/02-traps.md) —
 * callers keep targets in the free zone.
 */

import { FloorContract } from './FloorContract.js';

/** Float tolerance for threshold/zero comparisons on decayed charge. */
const EPS = 1e-9;

/** z01 in [0, 1] from a camera distance (scene units): log10 interpolation on the floor's `camera.rangeLog10`. */
export function z01FromDistance(floor, distU) {
  const [lo, hi] = floor.camera.rangeLog10;
  if (!(distU > 0)) return 0;
  const z = (Math.log10(distU) - lo) / (hi - lo);
  return Math.min(1, Math.max(0, z));
}

/** Inverse of z01FromDistance (z01 clamped to [0, 1] first); returns scene units. */
export function distanceFromZ01(floor, z01) {
  const [lo, hi] = floor.camera.rangeLog10;
  const z = Math.min(1, Math.max(0, z01));
  return Math.pow(10, lo + z * (hi - lo));
}

/** CHARGE_THRESHOLD: absolute outbound charge threshold (router-normalized wheel mag units; inbound = this ×
 *  inFirmness). MIN_SPAN_MS: the sustain gate — charge-contributing events inside the window must SPAN at least this
 *  many ms for a crossing (intent is sustained pushing: a trackpad flick drives ≲150 ms then pure momentum, a
 *  deliberate push 250-400+ ms; 0 disables). Both are canonical in FloorContract.HUMP_SPRING; these are fallbacks for
 *  spring-override tests. */
const DEFAULT_SPRING_EXTENSIONS = { CHARGE_THRESHOLD: 3, MIN_SPAN_MS: 0 };

/** Behavior knobs the contract leaves to the caller. */
const DEFAULT_RULES = {
  initialFloor: 2,        // COMMAND — the shipped gameplay floor
  initialZ01: 0.5,
  initialDocked: false,
  devFullAccess: false,   // true bypasses entry gates. INERT: no shipping floor carries entryRequiresDock (injected test tables can).
                          // LadderController injects Constants.LADDER.DEV_FULL_ACCESS into its DEFAULT core only.
                          // Ladder ENDS still deny.
  wheelZ01Step: 0.04,     // free-scroll z01 per unit mag (scroll gain)
  knockToKlaxonMs: 1000,  // knock → klaxon
  autoRideDelayMs: 3000,  // klaxon → auto-ride (locked: VisualLaw 3 s)
  rideMsRange: [450, 650],// crossing-ride window (locked: VisualLaw)
  miniRideMs: 200,        // hotkey-jump mini-ride (locked: VisualLaw)
  reaimMs: 300,           // re-aim / subject-loss soft ride (locked: VisualLaw)
  crossBlock: null,       // optional (fromFloor, destFloor) => true: a zoom (wheel/flick) may not cross there.
                          // Silent: no 'cross', no 'denied'. owner 2026-10-27: while the camera rides a daughter,
                          // zooming in on floor 2 never swings to the mother's close-up (floor 1). Jumps, page keys
                          // and Esc are explicit commands and are not asked.
};

export class ZoomLadder {
  /** deps are injectable for tests (floors, geometry, spring, rules); production passes nothing. */
  constructor({ floors, geometry, spring, rules } = {}) {
    this._floors = floors || FloorContract.FLOORS;
    this._geo = { ...FloorContract.LADDER_GEOMETRY, ...(geometry || {}) };
    // Spread order: extension DEFAULTS sit UNDER the contract (FloorContract.HUMP_SPRING carries CHARGE_THRESHOLD +
    // MIN_SPAN_MS); caller overrides win over both.
    this._spring = { ...DEFAULT_SPRING_EXTENSIONS, ...FloorContract.HUMP_SPRING, ...(spring || {}) };
    this._rules = { ...DEFAULT_RULES, ...(rules || {}) };

    this._byId = new Map(this._floors.map((f) => [f.id, f]));

    // Ladder position — ALWAYS a valid (floor, z01); the camera never rests between floors (00-spec.md §4).
    this._floor = this._rules.initialFloor;
    this._z01 = this._rules.initialZ01;

    // _rawCharge is in wheel-mag units and decays with τ; decisions/getState expose it normalized against the side's
    // threshold.
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

    // Flick detector: one same-direction accumulation run of deliberate (non-tail) events inside FLICK_MAX_DRIVE_MS.
    // `armed` false = a flick already fired from the current drive; re-armed by a tail event (momentum began),
    // GESTURE_LOCK_SILENCE_MS of input silence, or a direction change.
    this._flick = { dir: null, events: [], armed: true };

    // Undo window: armed when a CROSS ride completes; a reverse-direction flick inside it crosses straight back.
    // Cleared by any new player ride; otherwise purely temporal (free scrolling does not cancel it).
    this._undoDir = null;                 // 'in' | 'out' — the direction that undoes
    this._undoUntilTMs = -Infinity;

    this._settled = false;                // settle-back latched until next input
    this._ride = null;                    // { kind } while mode === 'riding'
    this._preRide = null;                 // (floor, z01) revert point, alarmAuto only

    this._subject = null;                 // opaque ref (or 'cluster'/'ship' tokens)
    this._docked = this._rules.initialDocked;
    this._alarm = null;                   // { targetFloor, stage, knockTMs, klaxonTMs }
  }

  // Input methods (all return Decision[])

  /**
   * One router-normalized wheel event. dir: 'in'|'out' (invert already applied by the router); mag: positive magnitude.
   */
  wheel({ tMs, dir, mag }) {
    if ((dir !== 'in' && dir !== 'out') || !(mag > 0)) return [];
    this._tick(tMs);
    const decisions = [];

    // Any scroll input cancels a pending alarm escalation (00-spec.md §6).
    this._cancelPendingAlarm(decisions);

    // Momentum-tail rejection: a same-direction continuation (< gesture-silence gap) with strictly decaying mag charges
    // ZERO; only deliberate re-pushes (mag >= previous) count (00-spec.md §4). Computed BEFORE _recordWheel so the
    // flick detector and the spring share one causal view of the stream, mid-ride events included.
    const gap = tMs - this._lastWheelTMs;
    const isTail = gap < this._spring.GESTURE_LOCK_SILENCE_MS &&
      dir === this._lastWheelDir && mag < this._lastWheelMag;
    const flicked = this._flickTrack(tMs, dir, mag, isTail, gap);

    if (this._ride) {
      // Scroll cancels only alarm auto-rides, not player rides.
      if (this._ride.kind === 'alarmAuto') {
        this._cancelAlarmAutoRide(decisions);
      } else if (flicked) {
        // Flick effects DURING player rides (sustained charging stays ignored mid-ride; the detector above sees every
        // event):
        //  - flickWall + same dir  → upgrade: the second flick crosses;
        //  - flickWall + reverse   → re-target the opposite wall edge;
        //  - cross + reverse       → undo: cross straight back;
        //  - cross + same dir      → absorbed (the floor change already happened);
        //  - jump/page/esc/aimDown → detection-only.
        // Each ride replacement swaps this._ride; the controller replaces the camera ride params + onDone
        // (the old onDone never fires).
        if (this._ride.kind === 'flickWall') {
          if (dir === this._ride.dir) {
            this._flickCross(dir, decisions);
          } else {
            decisions.push(this._startFlickWall(dir));
          }
        } else if (this._ride.kind === 'cross' && dir !== this._ride.dir) {
          this._flickCross(dir, decisions);
        }
      }
      // Wheel is otherwise ignored while riding, but the gesture bookkeeping still sees it so a momentum tail spanning
      // the ride can't pass as a fresh gesture at arrival.
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    this._settled = false;
    this._lastInputTMs = tMs;

    const wallLo = this._geo.WALL_ZONE_FRAC;
    const wallHi = 1 - this._geo.WALL_ZONE_FRAC;
    const side = dir === 'in' ? 'down' : 'up';

    // Direction reversal releases the spring (the push is let go).
    if (this._chargeSide && this._chargeSide !== side) {
      if (this._rawCharge > EPS) {
        decisions.push({ type: 'charge', side: this._chargeSide, charge: 0, peek: false });
      }
      this._releaseSpring();
    }

    // Undo: a reverse-direction flick within FLICK_UNDO_WINDOW_MS of a completed cross crosses straight back — from
    // ANYWHERE on the floor, past the charge gesture lock.
    if (flicked && dir === this._undoDir && tMs <= this._undoUntilTMs) {
      this._clearUndoWindow();
      this._flickCross(dir, decisions);
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    // A flick while NOT at/in the flick-direction wall zone rides WITHIN the floor to that wall edge; it consumes the
    // event (no move, no charge).
    if (flicked && !this._atOrInWall(dir)) {
      decisions.push(this._startFlickWall(dir));
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    const target = dir === 'in'
      ? this._z01 - mag * this._rules.wheelZ01Step
      : this._z01 + mag * this._rules.wheelZ01Step;
    const wallward = dir === 'in' ? target < wallLo : target > wallHi;

    if (!wallward) {
      // Free scroll inside the floor (clamps at the wall edges; only charging takes the camera INTO a wall).
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

    // Wall zone: charge the spring. After a crossing/denial, charging is locked until GESTURE_LOCK_SILENCE_MS of input
    // silence (one crossing per gesture). Tail events contribute MOMENTUM_TAIL_CHARGE × mag (canonically zero).
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

    // A charge decision accompanies EVERY wall-zone wheel call so the rail never stutters.
    decisions.push({
      type: 'charge', side, charge: norm,
      peek: norm > this._spring.PEEK_CHARGE_FRAC,
    });

    // Crossing requires intent: charge past threshold AND enough deliberate events in the window AND a sustained push
    // (charge events span MIN_SPAN_MS) AND a deliberate trigger (chargeMag > 0): a momentum-tail event may never
    // COMPLETE a crossing, even with the spring already past threshold. At most one cross/denied per gesture. A FLICK
    // at/in the wall zone crosses too (reaching here with `flicked` implies _atOrInWall), bypassing the charge gesture
    // lock; the detector's one-flick-per-drive rule is its gesture boundary.
    const wantsCross = flicked || (!this._gestureLocked &&
      chargeMag > 0 &&
      norm >= 1 - EPS &&
      this._chargeEvents.length >= this._spring.MIN_EVENTS &&
      (tMs - this._chargeEvents[0]) >= (this._spring.MIN_SPAN_MS || 0));

    const blocked = this._crossBlocked(dest);
    if (wantsCross && dest && !blocked && !this._dockDenies(dest)) {
      decisions.push({
        type: 'cross',
        fromFloor: this._floor,
        toFloor: destId,
        entryZ01: side === 'down' ? this._geo.ENTRY_Z01_FROM_ABOVE : this._geo.ENTRY_Z01_FROM_BELOW,
        direction: side === 'down' ? 'in' : 'out',
        rideMsRange: [...this._rules.rideMsRange],
      });
      // The spring released through the wall; the ride engine flies the reframe ride.
      this._floor = destId;
      this._z01 = decisions[decisions.length - 1].entryZ01;
      this._ride = { kind: 'cross', toFloor: destId, dir };
      this._releaseSpring();
      this._gestureLocked = true;
      this._clearUndoWindow();
      this._recordWheel(tMs, dir, mag);
      return decisions;
    }

    // No crossing this event: the camera creeps up to CREEP_FRAC of the remaining wall distance
    // (tracks the live charge, so a decaying spring relaxes it back).
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
      // The spring met its threshold but the wall refuses: dock-gated floor (hard wall + hint, 00-spec.md §3 F2) or the
      // end of the ladder. A crossBlock refusal is silent (no rail flash).
      if (!blocked) {
        decisions.push(dest
          ? { type: 'denied', floor: dest.id, reason: 'undocked', hint: dest.humps?.deniedHint ?? null }
          : { type: 'denied', floor: this._floor, reason: 'ladder-end', hint: null });
      }
      this._gestureLocked = true;   // exactly one cross OR denied per gesture
    }

    this._recordWheel(tMs, dir, mag);
    return decisions;
  }

  /** Discrete command: 'esc' | 'pageUp' | 'pageDown' | 'space' (00-spec.md §5). */
  command({ tMs, type }) {
    this._tick(tMs);
    this._lastInputTMs = tMs;
    const decisions = [];

    if (type === 'esc') {
      // Esc cancels an alarm escalation (pending or in-flight auto-ride) before it means "ride one floor up". Player
      // rides are NOT cancelled.
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

  /**
   * CEREMONY ride (the mission break is a ride, not a state). Like `jump`, but (1) at the CROSSING duration
   * (decision carries `miniMs: null`, so it flies at CROSS_RIDE_MS (550), not the 200 ms mini-ride: a ceremony is seen,
   * never a cut) and (2) it SUPERSEDES a ride in flight (the boundary dwell landing a frame after a flick must still
   * bring the player down; the ride token drops the superseded completion; `_rideTo` re-targets the core as a flick
   * upgrade does). Same floor → [] (caller opens the drawer); unknown floor → []. Counts as an input (settle clock).
   * Optional `entryZ01` overrides the floor rule (the intro dive lands CLOSE on the hull floor); absent / non-finite →
   * the geometry default, byte-identical (pinned).
   * @returns {Array} Decision[] — one `ride` (kind 'ceremony') or []
   */
  ceremonyRide({ tMs, toFloor, entryZ01 }) {
    this._tick(tMs);
    this._lastInputTMs = tMs;
    if (toFloor === this._floor || !this._byId.has(toFloor)) return [];
    const decisions = [];
    // An ALARM auto-ride in flight yields to the ceremony as a scroll cancels it: its stage closes 'cancelled'
    // (the controller hears the abort) and its revert point dies (nothing reverts). The revert may land the core on the
    // target floor already: then there is nothing left to ride.
    if (this._ride && this._ride.kind === 'alarmAuto') {
      this._cancelAlarmAutoRide(decisions);
      if (toFloor === this._floor) return decisions;
    }
    decisions.push(...this._rideTo(toFloor, 'ceremony', null, entryZ01));
    return decisions;
  }

  /**
   * WITHIN-FLOOR ride to an arbitrary z01 on the CURRENT floor (the intro dwell's silent camera drift). Modeled on the
   * flickWall ride (`_startFlickWall`): same floor, no crossing, state moves to the target immediately, the spring
   * releases, the undo window clears. The decision carries `miniMs: rideMs` (null → the controller's CROSS_RIDE_MS).
   * NOT an input (the `place` law): `_lastInputTMs` is untouched, so a target inside a wall band settles to the edge on
   * the next update — a placement can never leave the camera resting in the wall (T6, archive/ladder/02-traps.md).
   * Callers keep targets in the free zone (WALL_ZONE_FRAC … 1 − WALL_ZONE_FRAC). Refused ([]) while a ride is in flight
   * (the scripted dolly must never replace a player ride) or for a non-finite z01. `rideMs` absent/non-positive → null.
   * @returns {Array} Decision[] — one `ride` (kind 'dolly') or []
   */
  dollyTo({ tMs, z01, rideMs }) {
    this._tick(tMs);
    if (this._ride) return [];
    if (typeof z01 !== 'number' || !Number.isFinite(z01)) return [];
    const target = Math.min(1, Math.max(0, z01));
    const miniMs = (Number.isFinite(rideMs) && rideMs > 0) ? rideMs : null;
    this._z01 = target;
    this._ride = { kind: 'dolly', toFloor: this._floor };
    this._settled = false;
    this._releaseSpring();
    this._clearUndoWindow();
    return [{ type: 'ride', toFloor: this._floor, entryZ01: target, kind: 'dolly', miniMs }];
  }

  /**
   * One step of a live, eased zoom the controller drives frame by frame
   * (floor-4 framing keeps the ship and focused field in view). Not a ride, not an input (`_lastInputTMs` untouched),
   * and only inside the free zone: z01 is clamped to [WALL_ZONE_FRAC, 1 − WALL_ZONE_FRAC], so a glide never creeps into
   * a wall or triggers a settle-back. Releases the spring. Refused ([]) during a ride or for a non-finite z01. Emits
   * one `move` tagged `glide: true` when z01 changes.
   */
  glide({ tMs, z01 }) {
    if (Number.isFinite(tMs)) this._tick(tMs);
    if (this._ride) return [];
    if (typeof z01 !== 'number' || !Number.isFinite(z01)) return [];
    const w = this._geo.WALL_ZONE_FRAC;
    const z = Math.min(1 - w, Math.max(w, z01));
    this._settled = false;
    this._releaseSpring();
    if (z === this._z01) return [];
    this._z01 = z;
    return [{ type: 'move', floor: this._floor, z01: z, inWall: false, creepFrac: 0, glide: true }];
  }

  /**
   * Settled CUT of the ladder position to (floor, z01): no ride, no decision. The ONE exception to "never a cut"
   * (00-spec.md §4: about VISIBLE transitions): only where no camera ride can be seen — parking the core on the hull
   * under the SHOP overlay (the depot return lands at the exact z01 the player left) and restoring a saved (floor, z01)
   * before the first engage of a continued run. Refusals (state untouched, returns false): a ride in flight
   * (`rideFinished` first — a cut under a flying camera would desync them), an unknown floor, a non-finite z01.
   * Otherwise z01 is clamped to [0, 1] and the spring, settle latch, alarm revert point and undo window are released —
   * a fresh rest, as after a completed ride. NOT an input (`_lastInputTMs` untouched): a z01 placed inside a wall band
   * settles to the edge on the next update (T6, archive/ladder/02-traps.md).
   * @returns {boolean} true when placed
   */
  place({ tMs, floor, z01 }) {
    if (this._ride) return false;
    if (!this._byId.has(floor)) return false;
    if (typeof z01 !== 'number' || !Number.isFinite(z01)) return false;
    if (Number.isFinite(tMs)) this._tick(tMs);
    this._floor = floor;
    this._z01 = Math.min(1, Math.max(0, z01));
    this._settled = false;
    this._preRide = null;
    this._releaseSpring();
    this._clearUndoWindow();
    return true;
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
   * Subject destroyed/despawned. Fallback ladder (00-spec.md §5): debris → its cluster → ship; daughter → ship. Soft
   * 300 ms, never a cut. The 'cluster'/'ship' tokens are resolved to real refs by the caller.
   */
  subjectLost({ tMs, kind }) {
    this._tick(tMs);
    const token = (kind === 'daughter' || this._subject === 'cluster') ? 'ship' : 'cluster';
    this._subject = token;
    return [{ type: 'reaim', subject: token, soft: true, durationMs: this._rules.reaimMs }];
  }

  /** Conjunction alarm raised/cleared by the controller. Raise emits the knock. */
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

  /** Docked state of the ship (boolean); gates entry to dock-required floors. */
  dockChanged({ docked }) {
    this._docked = !!docked;
    return [];
  }

  /** The controller reports the crossing/mini ride (or crossfade) completed. */
  rideFinished({ tMs }) {
    this._tick(tMs);
    // A completed CROSS arms the undo window: a reverse flick within FLICK_UNDO_WINDOW_MS crosses straight back.
    if (this._ride && this._ride.kind === 'cross' && this._ride.dir) {
      this._undoDir = this._ride.dir === 'in' ? 'out' : 'in';
      this._undoUntilTMs = tMs + this._spring.FLICK_UNDO_WINDOW_MS;
    }
    this._ride = null;
    this._preRide = null;
    return [];
  }

  /**
   * Tick: charge decay, gesture-lock release, settle-back, knock → klaxon → auto-ride escalation. Call every frame with
   * the inputs' monotonic clock. @returns {Array} Decision[]
   */
  update(tMs) {
    this._tick(tMs);
    const decisions = [];

    // Alarm escalation (anchored to the knock, so late/lumped update calls emit the stages in order within one return).
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

  // State snapshot (rail + debugging; fresh object, mutation-safe)

  /**
   * Allocation-free ride probe: true exactly when getState().mode === 'riding'. For per-frame callers
   * (LadderController.adaptHoldoff runs every gameLoop frame).
   */
  isRiding() { return !!this._ride; }

  /**
   * Allocation-free floor probe: exactly getState().floor, for per-frame callers
   * (the turntable gate; same law as isRiding()).
   */
  floorId() { return this._floor; }

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

  // Internals

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

  /**
   * Flick detector: feeds one wheel event; true when a flick fires. A flick = accumulated deliberate (non-tail) mag
   * within FLICK_MAX_DRIVE_MS reaching FLICK_MIN_MAG, with a RISE gate: the trigger event's mag must exceed the run's
   * first event's (or alone meet the threshold). Deliberate events never decrease (a decreasing one is a tail), so an
   * equal-mag stream never rises and never flicks; slow/sparse scrolling ages out of the window. A tail RESETS the run
   * and re-ARMS the detector: a deliberate re-push during the tail reads as a second flick while the tail itself never
   * can.
   * @private
   */
  _flickTrack(tMs, dir, mag, isTail, gap) {
    const F = this._flick;
    if (gap >= this._spring.GESTURE_LOCK_SILENCE_MS || dir !== F.dir) {
      F.dir = dir;
      F.events = [];
      F.armed = true;
    }
    if (isTail) {
      F.events = [];
      F.armed = true;
      return false;
    }
    if (!F.armed) return false;              // one flick per drive
    const cutoff = tMs - this._spring.FLICK_MAX_DRIVE_MS;
    F.events = F.events.filter((e) => e.tMs >= cutoff);
    F.events.push({ tMs, mag });
    let sum = 0;
    for (const e of F.events) sum += e.mag;
    if (sum < this._spring.FLICK_MIN_MAG - EPS) return false;
    const rose = F.events.length === 1
      ? mag >= this._spring.FLICK_MIN_MAG - EPS
      : mag > F.events[0].mag + EPS;
    if (!rose) return false;
    F.events = [];
    F.armed = false;
    return true;
  }

  /**
   * True when z01 sits at or inside the wall zone the direction points at
   * (the wall EDGE counts: a flick there crosses). @private
   */
  _atOrInWall(dir) {
    return dir === 'in'
      ? this._z01 <= this._geo.WALL_ZONE_FRAC + EPS
      : this._z01 >= 1 - this._geo.WALL_ZONE_FRAC - EPS;
  }

  /**
   * Start a flickWall ride: within the CURRENT floor, to the wall edge the flick points at. State moves to the edge
   * immediately; the spring releases; the gesture lock is NOT touched
   * (flick-to-wall then sustained push-through must work as one composite gesture).
   * @private
   */
  _startFlickWall(dir) {
    const edge = dir === 'in'
      ? this._geo.WALL_ZONE_FRAC
      : 1 - this._geo.WALL_ZONE_FRAC;
    this._z01 = edge;
    this._ride = { kind: 'flickWall', toFloor: this._floor, dir };
    this._settled = false;
    this._releaseSpring();
    this._clearUndoWindow();
    return {
      type: 'ride', toFloor: this._floor, entryZ01: edge,
      kind: 'flickWall', miniMs: this._spring.FLICK_RIDE_MS,
    };
  }

  /**
   * Attempt a flick-crossing in `dir` (at-wall flick, double-flick upgrade, mid-cross undo, post-cross undo window).
   * Bypasses the charge gesture lock (the detector's one-per-drive rule is the boundary) but honors dock gates and
   * ladder ends like the spring path. On success the state moves to (dest, entry) and the ride REPLACES any in-flight
   * player ride (the controller swaps ride params + onDone; the old onDone never fires). Sets the charge gesture lock
   * so the same input stream can't also spring-cross.
   * @private
   * @returns {boolean} true when the cross fired (false = denied)
   */
  _flickCross(dir, decisions) {
    const side = dir === 'in' ? 'down' : 'up';
    const destId = side === 'down' ? this._floor - 1 : this._floor + 1;
    const dest = this._byId.get(destId);
    if (!dest) {
      decisions.push({ type: 'denied', floor: this._floor, reason: 'ladder-end', hint: null });
      this._gestureLocked = true;
      return false;
    }
    if (this._crossBlocked(dest)) return false;   // silent: see DEFAULT_RULES.crossBlock
    if (this._dockDenies(dest)) {
      decisions.push({ type: 'denied', floor: dest.id, reason: 'undocked', hint: dest.humps?.deniedHint ?? null });
      this._gestureLocked = true;
      return false;
    }
    const entryZ01 = side === 'down'
      ? this._geo.ENTRY_Z01_FROM_ABOVE
      : this._geo.ENTRY_Z01_FROM_BELOW;
    decisions.push({
      type: 'cross',
      fromFloor: this._floor,
      toFloor: destId,
      entryZ01,
      direction: dir,
      rideMsRange: [...this._rules.rideMsRange],
    });
    this._floor = destId;
    this._z01 = entryZ01;
    this._ride = { kind: 'cross', toFloor: destId, dir };
    this._settled = false;
    this._releaseSpring();
    this._gestureLocked = true;
    this._clearUndoWindow();
    return true;
  }

  /** Drop a pending post-cross undo window. @private */
  _clearUndoWindow() {
    this._undoDir = null;
    this._undoUntilTMs = -Infinity;
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

  /** True when the caller's `rules.crossBlock(from, dest)` vetoes a ZOOM crossing into `dest`
   *  (see DEFAULT_RULES.crossBlock). No dest, no hook → false. @private */
  _crossBlocked(dest) {
    const hook = this._rules.crossBlock;
    return !!(dest && typeof hook === 'function' && hook(this._floor, dest.id));
  }

  /** Set (or clear, with null) the zoom-crossing veto: see DEFAULT_RULES.crossBlock. */
  setCrossBlock(fn) { this._rules.crossBlock = (typeof fn === 'function') ? fn : null; }

  /** The free-scroll z01 step per unit of wheel magnitude (a caller that extends the zoom past a
   *  floor's end steps the same amount per notch). */
  wheelZ01Step() { return this._rules.wheelZ01Step; }

  /**
   * True when entering `dest` must be refused for lack of a dock. rules.devFullAccess bypasses entry gates
   * (ladder ENDS are not gates and still deny).
   */
  _dockDenies(dest) {
    if (this._rules.devFullAccess) return false;
    return !!(dest?.humps?.entryRequiresDock && !this._docked);
  }

  /**
   * Shared ride starter for jump/esc/page/aimDown/alarmAuto/ceremony. Applies the dock gate, moves the state to
   * (toFloor, entryZ01) immediately, and marks the core riding. Optional `entryZ01` overrides the floor rule
   * (ENTRY_Z01_FROM_BELOW upward / _FROM_ABOVE downward), clamped to [0, 1]; absent / non-finite → the geometry
   * default, byte-identical.
   */
  _rideTo(toId, kind, miniMs, entryZ01) {
    const dest = this._byId.get(toId);
    if (!dest) return [];
    if (this._dockDenies(dest)) {
      return [{ type: 'denied', floor: dest.id, reason: 'undocked', hint: dest.humps?.deniedHint ?? null }];
    }
    const entry = (entryZ01 !== undefined && Number.isFinite(entryZ01))
      ? Math.min(1, Math.max(0, entryZ01))
      : (toId > this._floor
        ? this._geo.ENTRY_Z01_FROM_BELOW
        : this._geo.ENTRY_Z01_FROM_ABOVE);
    if (kind === 'alarmAuto') {
      this._preRide = { floor: this._floor, z01: this._z01 };   // scroll/Esc revert point
    }
    this._floor = toId;
    this._z01 = entry;
    this._ride = { kind, toFloor: toId };
    this._settled = false;
    this._releaseSpring();
    this._clearUndoWindow();   // navigating on — a pending flick-undo is stale
    return [{ type: 'ride', toFloor: toId, entryZ01: entry, kind, miniMs }];
  }

  /** Cancel a knock/klaxon-stage escalation (wheel or Esc arrived). */
  _cancelPendingAlarm(decisions) {
    const a = this._alarm;
    if (a && (a.stage === 'knock' || a.stage === 'klaxon')) {
      a.stage = 'cancelled';
      decisions.push({ type: 'alarm', stage: 'cancelled', targetFloor: a.targetFloor });
    }
  }

  /** Cancel an in-flight alarm auto-ride: revert to the pre-ride position and ALWAYS report the cancellation, even if
   *  the alarm was cleared or replaced mid-flight (a silent revert would desync the core from the camera still flying). */
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
