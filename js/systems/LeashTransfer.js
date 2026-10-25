/**
 * LeashTransfer.js — the leash hand-off: one line, one small state machine.
 *
 * PURE. No THREE scene, no eventBus, no game objects, no THREE import at all
 * (vectors are plain {x,y,z}, the ship attitude is any {x,y,z,w} quaternion).
 * Nothing in the game calls it yet; lane l5b wires it. Design:
 * docs/research/2026-10-leash.md, ruling DECISIONS §1/§19.
 *
 * Ruling in one breath: release the nose magnet → pay the bag out on its own
 * leash → turn the whole ship under it → reel in at a radiator tip → the tip
 * magnet latches the steel washer at the net's neck. The bag is never
 * free-flying. Tension is a few newtons, so a spike can only mean a snag.
 *
 * FRAME: non-rotating, centred on the ship origin (player.position;
 * player.quaternion pivots there), metres. The ship's attitude arrives each
 * step as a quaternion; ship translation is ignored over a transfer (orbital
 * drift 0.11 m in 120 s, tmp/research/leash/turn-dynamics.md). Keep-out
 * queries take SHIP-frame points: the machine converts with inverse(shipQuat).
 *
 * PHYSICS FACTS THIS DESIGN RESTS ON
 *  1. A line can only pull. Once the reel slows, a bag moving toward the tip
 *     keeps its speed (the line goes slack). So the arrival speed at the tip
 *     equals the fastest reel-in speed used: reel in at REEL_SPEED_MPS from
 *     start to contact, and a bounce retries at half that.
 *  2. A soft constraint (Box2D "soft step") is stable at every dt 0.02–1.0 s;
 *     an explicit spring gained energy and blew up at dt 1.0 (1-D probe,
 *     tmp/research/leash/probe.mjs, probe2.mjs). Stretch ≈ v/ω·0.37 (critical
 *     damping), independent of mass.
 *  3. During the turn the anchor (ring rim, ~1.3 m from the origin) moves at
 *     up to ω·r ≈ 0.11 m/s; the line must pay out on demand (the clutch) or
 *     it drags the bag.
 *
 * KNOWN LIMITS (logged in tmp/plans/l3-leash-core.md):
 *  - The clutch back-tension scales with mass (5e-4 N/kg), the snag threshold
 *    does not scale (5 N + 2·m·reel accel): at 50 kg the threshold is 10 N.
 *  - A line cannot stop a bag that moves toward the anchor, and a pull-only
 *    line from the ring rim cannot carry a bag outward: there is no reel-in-first
 *    and no `stopBag`; a bag farther than D_MAX_M from its target is refused
 *    ('plan: too far') and the radiators go home.
 *
 * REEL_HOME (fix round 1 F1): the machine never assigns the bag's position. It
 * reels the bag back to its nose spot at HOME_REEL_MPS (<= LATCH_OK_MPS, never
 * shorter than the start distance) and commands relatchNose only when the bag is
 * within HOME_TOL_M of that spot and slower than LATCH_OK_MPS. A pull-only line
 * from the ring rim cannot carry a bag outward, so a bag that moved toward the
 * tip (closer to the anchor than the start distance - HOME_TOL_M) cannot get
 * home: CUT_FREE, failure {reason:'cut free', cause:'cannot reach the nose',
 * fault:<the original fault>}. F2: the part that caused the snag is ignored for
 * contacts while homing. F3: dt <= 0 is a no-op. F5: velocity given to the bag
 * outside the line (PAYOUT push, bounce) is booked as −m·dv in reactionImpulse.
 * H2: the push happens once, at the first PAYOUT entry; a replan re-entry does not push
 * again; the bag only coasts. A bag that has not reached the planned distance (within
 * PAYOUT_ACCEPT_M) by the PAYOUT time limit, or at once when a replan still misses by more
 * than PAYOUT_ACCEPT_M, faults 'payout' (home as from TURN).
 *
 * BACK-TENSION (fix round 2 H1): the reel is a slipping brake, not a motor. In the
 * clutch (TURN / CATCH) the constant back-tension pull is applied only on a
 * substep where the clutch paid line out (Ldot > 0); a bag at rest on a line that
 * is not paying out feels no pull, so a long wait cannot drag it toward the
 * anchor. (This replaces round 1's C >= -5 mm gate, F7.)
 *
 * Exports: planHandoff, latchCheck, lineImpulse, LeashLine, LeashTransfer.
 */

import { Constants } from '../core/Constants.js';

const K = () => Constants.LEASH;

// ─── tiny vector maths on plain {x,y,z} ────────────────────────────────────
const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.sqrt(dot(a, a));
const clone = (a) => V(a.x, a.y, a.z);
const lerp = (a, b, f) => V(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
const unit = (a, fallback = V(0, 0, 1)) => {
    const l = len(a);
    return l > 1e-12 ? mul(a, 1 / l) : clone(fallback);
};
/** Rotate v by quaternion q (x,y,z,w). */
function qRot(q, v) {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return V(
        v.x + q.w * tx + (q.y * tz - q.z * ty),
        v.y + q.w * ty + (q.z * tx - q.x * tz),
        v.z + q.w * tz + (q.x * ty - q.y * tx),
    );
}
/** Rotate v by the inverse of q (unit quaternion): world → ship frame. */
const qRotInv = (q, v) => qRot({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);

const DEG = Math.PI / 180;

// ─── planHandoff ───────────────────────────────────────────────────────────

/**
 * F2.4: the longest the reaction wheels may take for a hand-off turn of `angleRad` (s): `LEASH.WHEEL_TURN_X` x the time of the gas plan
 * (peak rate and ramp as `leashTurnLimits`). The swing of the line is tuned to that plan; a turn on the wheels 2x slower (55 s for what
 * the gas does in 26 s) let the line touch a radiator and the hull and cut it (mission-1 bot, 10-24). So the wheels take the hand-off
 * only for a turn about as quick as the gas, and the gas the rest.
 * @param {number} angleRad
 * @returns {number} s
 */
export function leashWheelLimitS(angleRad) {
    const lim = leashTurnLimits();
    const A = Math.abs(angleRad);
    const t = A * lim.accel >= lim.maxRate * lim.maxRate ? A / lim.maxRate + lim.maxRate / lim.accel : 2 * Math.sqrt(A / lim.accel);
    return K().WHEEL_TURN_X * t;
}

/**
 * The rate and ramp the hand-off asks the autopilot for when it turns the ship (rad/s, rad/s²). The ONE place they are
 * read: the TURN phase sends them with `startTurn`, and the early gas check (`LeashDriver.gasShort`, gas-low-fail-fast
 * D1) prices the turn with the same limits.
 * @returns {{maxRate:number, accel:number}}
 */
export function leashTurnLimits() {
    const k = K();
    return { maxRate: k.TURN_MAX_RATE_DEG * DEG, accel: k.TURN_ACCEL_DEG * DEG };
}

/**
 * l8-reel-collar (D5): the nearest the bag's CENTRE may start to the tip along the line. The measured floor is
 * D_MIN_M (0.3 m, a bag of radius <= 0.25 m); a bigger bag needs `D_MIN_PER_R` radii, or its surface sweeps the
 * tip's own strut during the turn (measured: r 0.50 at 0.3 m snags FlowerStrut_0 on the first turn; at 0.6 m it
 * latches). Before this lane the bag started 2.5-5 m out (seat 0 at the old standoff), where the planner's root
 * was always far beyond this; from HOME (the bag 1.4-1.8 m out) the planner falls back to dMin and it matters.
 * @param {number} bagR — metres
 * @returns {number} metres
 */
export function minHandoffD(bagR) {
    const k = K();
    return Math.max(k.D_MIN_M, (k.D_MIN_PER_R ?? 0) * (bagR || 0));
}

/**
 * Where must the bag sit, and how must the ship turn, for the line from the
 * ring anchor to pass through the latch point with the bag beyond it?
 * All points in the SHIP (body) frame.
 *
 * u = unit(tip − anchor). The target is tip + d·u with |target| = r (the bag's
 * current radius), the larger root. d in [dMin, dMax] → payoutM 0. No root or
 * d < dMin → payoutM = the radius increase needed for dMin (> 0: pay out
 * first). d > dMax → ok:false, reason 'too far' (F4; the REEL phase covers any
 * d up to dMax, there is no reel-in-first). The turn rotates the ship so
 * the body direction of the target comes to the bag's current direction.
 *
 * @returns {{ok:boolean, reason:string, d:number, bagTargetBody:object,
 *            axisBody:object, psiRad:number, payoutM:number}}
 */
export function planHandoff({ anchorBody, tipBody, bagBodyNow, dMin, dMax }) {
    const u = unit(sub(tipBody, anchorBody));
    const r = len(bagBodyNow);
    const b = dot(tipBody, u);
    const c = dot(tipBody, tipBody) - r * r;
    const disc = b * b - c;
    const radiusAt = (d) => len(add(tipBody, mul(u, d)));

    let d = disc >= 0 ? -b + Math.sqrt(disc) : NaN;
    let payoutM = 0;
    let dUsed = d;
    if (!(d >= dMin - 1e-9)) {
        dUsed = dMin;
        payoutM = radiusAt(dMin) - r;
    } else if (d > dMax + 1e-9) {
        // fix round 1 F4: no reel-in-first (a line cannot stop a bag moving toward the anchor)
        return { ok: false, reason: 'too far', d, bagTargetBody: add(tipBody, mul(u, d)), axisBody: V(), psiRad: 0, payoutM: 0 };
    }
    const bagTargetBody = add(tipBody, mul(u, dUsed));

    const x = cross(bagTargetBody, bagBodyNow);
    const sinPsi = len(x);
    const cosPsi = dot(bagTargetBody, bagBodyNow);
    const psiRad = Math.atan2(sinPsi, cosPsi);
    if (psiRad > Math.PI - 1e-3) {
        return { ok: false, reason: 'opposite', d: dUsed, bagTargetBody, axisBody: V(), psiRad, payoutM };
    }
    const axisBody = psiRad < 1e-4 ? V() : mul(x, 1 / sinPsi);
    return { ok: true, reason: '', d: dUsed, bagTargetBody, axisBody, psiRad, payoutM };
}

// ─── latchCheck ────────────────────────────────────────────────────────────

/**
 * Does the washer at the neck latch, bounce, or has it not arrived yet?
 * The swivel cone at the tip points along the incoming line: axis = lineDirIn
 * (unit, from the bag toward the tip). Contact when the signed distance
 * s = (tip − neck)·lineDirIn ≤ 5 mm. A neck further than FUNNEL_MOUTH_R_M from
 * the axis misses the funnel (bounce). A bag moving away is 'none'.
 * latch if vc ≤ LATCH_OK_MPS; latch if vc ≤ LATCH_ALIGNED_MPS and the velocity
 * is within LATCH_ALIGN_DEG of the line; else bounce.
 * @returns {'none'|'latch'|'bounce'}
 */
export function latchCheck({ neckPos, bagVel, tipPos, lineDirIn }) {
    const k = K();
    const rel = sub(tipPos, neckPos);
    const s = dot(rel, lineDirIn);
    if (s > k.CONTACT_M) return 'none';
    const vc = dot(bagVel, lineDirIn);
    if (vc < 0) return 'none';                       // receding after a bounce
    const lateral = len(sub(rel, mul(lineDirIn, s)));
    if (lateral > k.FUNNEL_MOUTH_R_M) return 'bounce';
    if (vc <= k.LATCH_OK_MPS) return 'latch';
    const sp = len(bagVel);
    const mis = sp > 1e-4 ? Math.acos(Math.max(-1, Math.min(1, vc / sp))) : 0;
    if (vc <= k.LATCH_ALIGNED_MPS && mis <= k.LATCH_ALIGN_DEG * DEG) return 'latch';
    return 'bounce';
}

// ─── the line: one unilateral soft constraint ──────────────────────────────

/**
 * Soft-step impulse (Box2D v3 "soft step", one iteration), pull only, NO cap.
 * C = dist − free length, cdotEff = d(dist)/dt − (reel's own rate).
 * Returns j ≤ 0 (impulse on the bag along n, n = pivot → bag). The caller
 * decides whether the line is taut (C ≥ 0); slack → no call.
 */
export function lineImpulse({ mass, h, freqHz, damping, C, cdotEff }) {
    const w = 2 * Math.PI * freqHz;
    const a1 = 2 * damping + h * w;
    const a2 = h * w * a1;
    const a3 = 1 / (1 + a2);
    return Math.min(0, -mass * a2 * a3 * (cdotEff + (w / a1) * C));
}

/**
 * The bag on its line. The ship is kinematic (anchor / tip positions are
 * inputs); only the bag moves, and the reaction impulse on the ship is
 * reported. Before the catch the line is anchor → bag; after (`engaged`)
 * anchor → tip → bag with the tip a frictionless pulley: free length =
 * reel length L − |anchor − tip|, constraint on |bag − tip|.
 *
 * Reel modes (L = reel length, Ldot its rate):
 *   hold   — L fixed.
 *   in     — Ldot ramps to −reelSpeed at REEL_ACCEL_MPS2 (and back down if
 *            reelSpeed is lowered).
 *   clutch — TURN: pays out on demand so the line only just stays taut
 *            (cap PAYOUT_MAX_MPS); takes up at ≤ TAKEUP_MPS (only when the
 *            `takeup` flag is set) without pulling; back-tension pulls the bag
 *            along the line only while the clutch pays out (H1).
 *   payout — PAYOUT: pays out on the bag's demand (line never tighter than the
 *            bag needs), braking at REEL_ACCEL_MPS2 so the line stops at `target`.
 *   out    — pays out to `target` at TAKEUP_MPS (line lifting out of a slot).
 */
export class LeashLine {
    constructor({ mass, pos, vel = V(), reelLen, engaged = false }) {
        this.mass = mass;
        this.pos = clone(pos);
        this.vel = clone(vel);
        this.L = reelLen;
        this.Ldot = 0;
        this.mode = 'hold';
        this.reelSpeed = K().REEL_SPEED_MPS;
        this.target = 0;
        this.takeup = false;
        this.engaged = engaged;
        this.fixed = false;      // an obstacle holds the bag (position frozen)
        this.minLen = 0;         // 'in' mode never reels the free length shorter than this (F1)
        this.lastC = 0;
    }

    /** Free length of the bag's own segment: L − |anchor − tip| when engaged. */
    freeLen(anchor, tip) {
        return this.L - (this.engaged ? len(sub(anchor, tip)) : 0);
    }

    /** Back-tension in newtons for this bag. */
    backTensionN() {
        const k = K();
        return Math.min(k.BACK_TENSION_MAX_N, k.BACK_TENSION_PER_KG * this.mass);
    }

    /**
     * Advance by dt (substeps ≤ 1/60 s). g = { a0, a1, t0, t1 }: anchor and tip
     * positions at the start / end of the step (linear in between).
     * opts.stopWhen(line) is tested after every substep; true stops early.
     * @returns {{elapsed:number, stopped:boolean, tension:number, reaction:object,
     *            maxOver:number, impulseSum:number, C:number}}
     */
    advance(dt, g, opts = {}) {
        const k = K();
        const hMax = Math.min(k.SUBSTEP_MAX_S, k.SUBSTEP_MAX_MOVE_M / Math.max(len(this.vel), 1e-6));
        const n = Math.max(1, Math.ceil(dt / hMax - 1e-9));
        const h = dt / n;
        const reaction = V();
        let impulseSum = 0;
        let maxOver = -Infinity;
        let elapsed = 0;
        let stopped = false;
        for (let i = 0; i < n; i++) {
            const f0 = i / n, f1 = (i + 1) / n;
            const A0 = lerp(g.a0, g.a1, f0), A1 = lerp(g.a0, g.a1, f1);
            const T0 = lerp(g.t0, g.t1, f0), T1 = lerp(g.t0, g.t1, f1);
            const P0 = this.engaged ? T0 : A0;
            const P1 = this.engaged ? T1 : A1;
            const Pv = mul(sub(P1, P0), 1 / h);
            const base0 = this.engaged ? len(sub(A0, T0)) : 0;
            const base1 = this.engaged ? len(sub(A1, T1)) : 0;
            const baseRate = (base1 - base0) / h;

            const d = sub(this.pos, P0);
            const dist = len(d);
            const nrm = unit(d, V(0, 0, 1));
            const distPred = len(sub(add(this.pos, mul(this.vel, h)), P1));

            // ── reel ────────────────────────────────────────────────────
            const Lold = this.L;
            let Lnew = Lold;
            if (this.mode === 'in') {
                const want = -this.reelSpeed;
                // accel-limited, with a smooth tail (a hard stop of the ramp makes the soft line overshoot ~3 mm/s)
                const acc = Math.max(-k.REEL_ACCEL_MPS2, Math.min(k.REEL_ACCEL_MPS2, (want - this.Ldot) / k.RAMP_TAU_S));
                this.Ldot += acc * h;
                Lnew = Lold + this.Ldot * h;
                Lnew = Math.max(Lnew, base1, this.minLen);
                if (Lnew > Lold + this.Ldot * h) this.Ldot = (Lnew - Lold) / h;   // clamped at the floor: the reel stopped
            } else if (this.mode === 'clutch') {
                const need = base1 + distPred;
                if (need > Lold) Lnew = Math.min(Lold + k.PAYOUT_MAX_MPS * h, need);
                else if (this.takeup) Lnew = Math.max(need, base0 + dist, Lold - k.TAKEUP_MPS * h); // never tighter than now: no pull
                this.Ldot = (Lnew - Lold) / h;
            } else if (this.mode === 'payout') {
                // pay out on the bag's demand (never tighter than the bag needs), but brake
                // at REEL_ACCEL_MPS2 so the line stops at the planned length `target`
                const demand = Math.max(0, (base1 + distPred - Lold) / h);
                const rem = Math.max(0, this.target - Lold);
                const brake = Math.sqrt(2 * k.REEL_ACCEL_MPS2 * rem);
                this.Ldot = Math.min(demand, brake, k.PAYOUT_MAX_MPS);
                Lnew = Math.min(this.target, Lold + this.Ldot * h);
                this.Ldot = (Lnew - Lold) / h;
            } else if (this.mode === 'out') {
                Lnew = Math.min(this.target, Lold + k.TAKEUP_MPS * h);
                this.Ldot = (Lnew - Lold) / h;
            } else {
                this.Ldot = 0;
            }
            this.L = Lnew;

            // ── constraint ──────────────────────────────────────────────
            const C = dist - (this.L - base0);
            this.lastC = C;
            const cdotEff = dot(sub(this.vel, Pv), nrm) - (this.Ldot - baseRate);
            let j = 0;
            if (C >= 0) {
                j = lineImpulse({ mass: this.mass, h, freqHz: k.LINE_FREQ_HZ, damping: k.LINE_DAMPING, C, cdotEff });
            }
            let pull = -j;                       // impulse magnitude toward the pivot
            if (this.mode === 'clutch' && this.Ldot > 0) {
                // H1: the reel is a slipping brake, not a motor: tension only while the line pays out
                pull += this.backTensionN() * h;
            }
            if (pull > 0) {
                this.vel = sub(this.vel, mul(nrm, pull / this.mass));
                reaction.x += nrm.x * pull; reaction.y += nrm.y * pull; reaction.z += nrm.z * pull;
                impulseSum += pull;
            }
            if (this.fixed) this.vel = V();
            else this.pos = add(this.pos, mul(this.vel, h));

            const over = len(sub(this.pos, P1)) - (this.L - base1);
            if (over > maxOver) maxOver = over;
            elapsed += h;
            if (opts.stopWhen && opts.stopWhen(this)) { stopped = true; break; }
        }
        return { elapsed, stopped, tension: elapsed > 0 ? impulseSum / elapsed : 0, reaction, maxOver, impulseSum, C: this.lastC };
    }
}

// ─── the machine ───────────────────────────────────────────────────────────

const ACTIVE_LINE_PHASES = new Set(['RELEASE', 'PAYOUT', 'TURN', 'CATCH', 'REEL', 'REEL_HOME']);
const LATCHED_PHASES = new Set(['LATCHED', 'CUT', 'SWING', 'UNFOLD']);
const BERTH_NAMES = ['BerthCollar', 'BerthFace'];

/**
 * The leash hand-off machine. One attempt per instance; after FAILED the caller
 * makes a new instance to retry.
 *
 * step(dt, io) → { phase, commands, events, state, failure }
 *  commands: [{type, ...}] for the wiring lane (foldRadiators, releaseNose,
 *    startTurn, cancelTurn, relatchNose, latch, cutLine, swingToBoom,
 *    unfoldRadiators, releaseHold, bagFree).
 *  events: [{type:'phase'|'snag'|'slack'|'bounce'|'catch'|'failed', ...}].
 *  io (every step): { shipQuat, anchorWorld, tipWorld (latch point), bagWorld
 *    (after LATCHED: bag centre from TipCargo), radiatorThetaRad,
 *    turn:{state:'idle'|'turning'|'done'|'rejected', reason, progressRad},
 *    swingDone, noseReleased (optional, default true), bagFixed (optional:
 *    an obstacle holds the bag), keepOut:{segment(aShip,bShip,r,opts),
 *    sphere(cShip,r,opts)} → {gap,name} }.
 *  keep-out opts: { ignore: [{ point, r, names? }] } (ship-frame points).
 */
export class LeashTransfer {
    /**
     * @param {object} o { tipIndex, bagMass, bagR, bagPos, bagVel, thetaHRad,
     *   homeThetaRad, unfoldThetaRad, reelSpeedMps?, retrySpeedFactor? }
     *   reelSpeedMps / retrySpeedFactor are test hooks (defaults: REEL_SPEED_MPS, 0.5).
     */
    constructor(o) {
        const k = K();
        this.tipIndex = o.tipIndex ?? 0;
        this.mass = o.bagMass;
        this.bagR = o.bagR;
        this.thetaH = o.thetaHRad ?? k.HANDOFF_THETA_DEG * DEG;
        this.homeTheta = o.homeThetaRad;
        this.unfoldTheta = o.unfoldThetaRad;
        this.reelSpeed = o.reelSpeedMps ?? k.REEL_SPEED_MPS;
        this.retryFactor = o.retrySpeedFactor ?? 0.5;
        this.bag = { pos: clone(o.bagPos), vel: clone(o.bagVel ?? V()) };
        this.line = null;
        this.phase = 'FOLD';
        this.phaseT = 0;
        this.t = 0;
        this.stepNo = 0;
        this.entered = false;
        this.enteredStep = 0;
        this.plan = null;
        this.turn = null;
        this.bounces = 0;
        this.payoutTries = 0;
        this.slackT = 0;
        this.slackFired = false;
        this.win = [];
        this.failure = null;
        this.home = null;
        this.fault = null;
        this._started = false;
        this._last = null;
        this._reset();
    }

    _reset() {
        this.cmds = [];
        this.evs = [];
        this.stepReaction = V();
        this.stepImpulse = 0;
        this.stepMaxOver = -Infinity;
    }

    _cmd(type, props = {}) { this.cmds.push({ type, ...props }); }
    _event(type, props = {}) { this.evs.push({ type, ...props }); }

    _enter(phase) {
        this.phase = phase;
        this.phaseT = 0;
        this.entered = false;
        this.enteredStep = this.stepNo;
        this._event('phase', { phase });
    }

    getState() { return this._last ? JSON.parse(JSON.stringify(this._last.state)) : null; }

    _buildState(io) {
        const line = this.line;
        const anchorToTip = line && line.engaged && io ? len(sub(io.anchorWorld, io.tipWorld)) : 0;
        return {
            bagPos: clone(this.bag.pos),
            bagVel: clone(this.bag.vel),
            reelLen: line ? line.L : 0,
            tension: this._dt > 0 ? this.stepImpulse / this._dt : 0,
            reactionImpulse: clone(this.stepReaction),
            tipEngaged: !!(line && line.engaged),
            anchorToTip,
            maxStretch: this.stepMaxOver === -Infinity ? 0 : this.stepMaxOver,
        };
    }

    /** F5: a velocity change dv given to the bag outside the line is booked on the ship as −m·dv. */
    _bookKick(dv) {
        this.stepReaction = add(this.stepReaction, mul(dv, -this.mass));
    }

    /** Advance the line (and the bag with it) and accumulate the step's outputs. */
    _sim(dt, g, opts) {
        const line = this.line;
        const r = line.advance(dt, g, opts);
        this.stepImpulse += r.impulseSum;
        this.stepReaction = add(this.stepReaction, r.reaction);
        if (r.maxOver > this.stepMaxOver) this.stepMaxOver = r.maxOver;
        this.bag.pos = clone(line.pos);
        this.bag.vel = clone(line.vel);
        this.win.push({ dt: r.elapsed, imp: r.impulseSum });
        return r;
    }

    step(dt, io) {
        if (!(dt > 0)) {
            // F3: dt <= 0 (or NaN) changes nothing and reports nothing
            this._reset();
            this._dt = 0;
            return { phase: this.phase, commands: [], events: [], state: this._buildState(io), failure: this.failure };
        }
        this._reset();
        this._dt = dt;
        this.stepNo++;
        this.t += dt;
        this.io = io;
        const anchor = clone(io.anchorWorld), tip = clone(io.tipWorld);
        if (!this._started) {
            this._started = true;
            this.prevAnchor = clone(anchor);
            this.prevTip = clone(tip);
            this.homeBody = qRotInv(io.shipQuat, this.bag.pos);
            this.startDist = len(sub(anchor, this.bag.pos));
            this._event('phase', { phase: this.phase });
        }
        const g = { a0: this.prevAnchor, a1: anchor, t0: this.prevTip, t1: tip };
        if (this.line) this.line.fixed = !!io.bagFixed;

        if (this.phase !== 'DONE' && this.phase !== 'FAILED') {
            this.phaseT += dt;
            let guard = 0;
            let again = true;
            while (again && guard++ < 8 && this.phase !== 'DONE' && this.phase !== 'FAILED') {
                const before = this.phase;
                again = this['_ph_' + this.phase](dt, io, g) === true;
                if (!again) break;
                if (this.phase === before) break;
            }
            if (this.phase !== 'DONE' && this.phase !== 'FAILED') {
                this._watch(dt, io);
            }
        }
        this.prevAnchor = anchor;
        this.prevTip = tip;
        this._prevTheta = io.radiatorThetaRad;
        const result = {
            phase: this.phase,
            commands: this.cmds,
            events: this.evs,
            state: this._buildState(io),
            failure: this.failure,
        };
        this._last = result;
        return result;
    }

    // ── watchers: slack, snag, timeout (after the phase handler) ─────────────
    _watch(dt, io) {
        const k = K();
        const ph = this.phase;
        const startPhase = ph;
        // slack
        if ((ph === 'TURN' || ph === 'REEL') && this.line) {
            if (this.line.lastC < -k.SLACK_MIN_M) this.slackT += dt; else this.slackT = 0;
            if (this.slackT > k.SLACK_S && !this.slackFired) {
                this.slackFired = true;
                this.line.takeup = true;
                this._event('slack', { phase: ph });
            }
        }
        // snag
        const snagPart = this._snagPart(io);
        if (snagPart) {
            this._event('snag', { part: snagPart, phase: ph });
            this._failWith('snag', snagPart);
            return;
        }
        // timeout
        const limit = k.PHASE_TIMEOUT_S[ph];
        if (limit !== undefined && this.phase === startPhase && this.phaseT > limit) {
            // H2: a PAYOUT re-entry has no push; a bag that has not coasted to the planned distance by then missed it
            this._failWith(ph === 'PAYOUT' && this.payoutTries > 1 ? 'payout' : 'timeout ' + ph);
        }
    }

    _snagPart(io) {
        const k = K();
        const ph = this.phase;
        const ko = io.keepOut;
        const q = io.shipQuat;
        // F2: while homing, the part that caused the snag does not trip it again (a
        // keep-out hit lasts many steps); any other part, and the mean tension, still do.
        const ignored = ph === 'REEL_HOME' && this.home ? this.home.part : undefined;
        const tripped = (hit) => !!(hit && hit.gap <= 0 && !(ignored && hit.name === ignored));
        const toShip = (p) => qRotInv(q, p);
        if (ko && LATCHED_PHASES.has(ph)) {
            if ((ph === 'SWING' || ph === 'UNFOLD') && io.bagWorld && ko.sphere) {
                const c = toShip(io.bagWorld);
                const hit = ko.sphere(c, this.bagR, { ignore: [{ point: toShip(io.tipWorld), r: K().CONE_IGNORE_R_M }] });
                if (tripped(hit)) return hit.name || 'unknown';
            }
            return null;
        }
        if (!ACTIVE_LINE_PHASES.has(ph) || !this.line) return null;
        if (ko) {
            const A = toShip(io.anchorWorld), T = toShip(io.tipWorld), B = toShip(this.bag.pos);
            const ringIgnore = { point: A, r: K().RING_IGNORE_R_M, names: BERTH_NAMES };
            const coneIgnore = { point: T, r: K().CONE_IGNORE_R_M };
            const lr = k.LINE_RADIUS_M;
            const segs = this.line.engaged
                ? [[A, T, [ringIgnore, coneIgnore]], [T, B, [coneIgnore]]]
                : [[A, B, [ringIgnore]]];
            if (ko.segment) {
                for (const [a, b, ignore] of segs) {
                    const hit = ko.segment(a, b, lr, { ignore });
                    if (tripped(hit)) return hit.name || 'unknown';
                }
            }
            if (ko.sphere) {
                const hit = ko.sphere(B, this.bagR, { ignore: [coneIgnore] });
                if (tripped(hit)) return hit.name || 'unknown';
            }
        }
        // mean tension over SNAG_MEAN_S
        let sumT = 0, sumI = 0;
        for (let i = this.win.length - 1; i >= 0; i--) {
            sumT += this.win[i].dt; sumI += this.win[i].imp;
            if (sumT >= k.SNAG_MEAN_S - 1e-9) break;
        }
        this.win = this.win.slice(-240);
        if (sumT >= k.SNAG_MEAN_S - 1e-9) {
            const limit = k.SNAG_TENSION_N + 2 * this.mass * k.REEL_ACCEL_MPS2;
            if (sumI / sumT > limit) return 'tension';
        }
        return null;
    }

    // ── failure handling ─────────────────────────────────────────────────────
    _failWith(reason, part) {
        const ph = this.phase;
        if (LATCHED_PHASES.has(ph)) {
            this._cmd('unfoldRadiators', { thetaRad: this.io.radiatorThetaRad });
            this._cmd('releaseHold');
            this._finishFailed({ reason, part, latched: true });
            return;
        }
        if (ph === 'REEL_HOME') {
            const stage = this.home && this.home.stage;
            if (this.home && (this.home.origin === 'FOLD' || stage === 'unfold')) {
                this._cmd('releaseHold');
                this._finishFailed({ reason: this.home.reason, part: this.home.part, followUp: reason });
            } else {
                this._cutFree(reason, part);
            }
            return;
        }
        // first fault: recover
        const origin = ph;
        const engaged = !!(this.line && this.line.engaged);
        this.home = { reason, part, origin, stage: null, sub: 0 };
        this._enter('REEL_HOME');
        if (origin === 'FOLD') {
            this.home.stage = 'unfold';
            return;
        }
        this.home.stage = engaged ? 'lift' : 'unturn';
        this.win = [];
    }

    _cutFree(reason, part) {
        this._cmd('cutLine');
        this._cmd('bagFree');
        this.line = null;
        this._cmd('unfoldRadiators', { thetaRad: this.homeTheta });
        this._cmd('releaseHold');
        this._enter('CUT_FREE');
        this.cutFree = { reason, part: part ?? (this.home && this.home.part), fault: this.home && this.home.reason };
    }

    _finishFailed(f) {
        this.failure = { reason: f.reason, ...(f.cause ? { cause: f.cause } : {}), ...(f.fault ? { fault: f.fault } : {}), ...(f.part ? { part: f.part } : {}), ...(f.latched ? { latched: true } : {}) };
        this._enter('FAILED');
        this._event('failed', { ...this.failure });
    }

    // ── phases ───────────────────────────────────────────────────────────────
    _ph_FOLD(dt, io) {
        if (!this.entered) {
            this.entered = true;
            this._cmd('foldRadiators', { thetaRad: this.thetaH });
        }
        // fb16 (owner 2026-10-25, "tighten up delays/pauses"): when the bag must be paid out first, the nose lets go and the line pays
        // out UNDER the end of the radiator's fold, timed to finish with it (the plan reads where the tip WILL be: `io.tipFinalWorld`);
        // the turn still waits for the radiator (PAYOUT, below). Every snag / tension / clearance check runs in RELEASE and PAYOUT
        // exactly as before.
        if (!this._aheadTried) this._planAhead(io);
        if (this.foldWait) {
            if (this._payoutDue(io)) { this._enter('RELEASE'); return true; }
            return false;
        }
        if (Math.abs(io.radiatorThetaRad - this.thetaH) > (K().THETA_TOL_DEG * DEG)) return false;
        if (!this._replan(io)) return false;
        this._enter('RELEASE');
        return true;
    }

    /**
     * fb16: the plan for the radiator's FINAL position, made at the start of the fold. True = the bag needs a payout and the fold
     * can run under it (`foldWait` is set; PAYOUT waits for the radiator before it re-plans). False = wait for the fold as before
     * (no early position given, the switch is off, no payout needed, or the plan is not ok: the normal re-plan at the end of the
     * fold then reports it exactly as it always did). Asked once.
     */
    _planAhead(io) {
        this._aheadTried = true;
        if (K().PAYOUT_DURING_FOLD === false || !io.tipFinalWorld) return false;
        const q = io.shipQuat;
        const plan = planHandoff({
            anchorBody: qRotInv(q, io.anchorWorld),
            tipBody: qRotInv(q, io.tipFinalWorld),
            bagBodyNow: qRotInv(q, this.bag.pos),
            dMin: minHandoffD(this.bagR),
            dMax: K().D_MAX_M,
        });
        if (!plan.ok || !(Math.abs(plan.payoutM) > K().PAYOUT_ACCEPT_M)) return false;
        this.plan = plan;
        this.foldWait = true;
        return true;
    }

    /**
     * fb16: is it time to let the bag go? The payout takes about `payoutM / PAYOUT_PUSH_MPS + push / (2 · REEL_ACCEL)` seconds (the
     * coast, then the line brakes it to a stop); it starts when the radiator has that long (plus PAYOUT_FOLD_MARGIN_S) left to fold at
     * `HOLD_SLEW_DEG_S`, so the two end together and the bag never waits long on a held line (a bag that has stopped drifts back at a
     * few mm/s and a line cannot push it out again).
     */
    _payoutDue(io) {
        const k = K();
        const left = Math.abs(io.radiatorThetaRad - this.thetaH) / (k.HOLD_SLEW_DEG_S * DEG);
        const v = k.PAYOUT_PUSH_MPS;
        const need = Math.abs(this.plan.payoutM) / v + v / (2 * k.REEL_ACCEL_MPS2);
        return left <= need + (k.PAYOUT_FOLD_MARGIN_S ?? 0.3);
    }

    /** fb16: the radiator has reached the hand-off angle (within THETA_TOL) and has stopped moving (it lands exactly on its target). */
    _foldLanded(io) {
        const th = io.radiatorThetaRad;
        return Math.abs(th - this.thetaH) <= (K().THETA_TOL_DEG * DEG)
            && this._prevTheta !== undefined && Math.abs(th - this._prevTheta) < 1e-7;
    }

    /** planHandoff from the current io; faults on 'opposite'. Returns true when a plan is stored. */
    _replan(io) {
        const k = K();
        const q = io.shipQuat;
        const plan = planHandoff({
            anchorBody: qRotInv(q, io.anchorWorld),
            tipBody: qRotInv(q, io.tipWorld),
            bagBodyNow: qRotInv(q, this.bag.pos),
            dMin: minHandoffD(this.bagR),
            dMax: k.D_MAX_M,
        });
        if (!plan.ok) {
            this._failWith('plan: ' + plan.reason);
            return false;
        }
        this.plan = plan;
        return true;
    }

    _ph_RELEASE(dt, io, g) {
        if (!this.entered) {
            this.entered = true;
            // F5: the nose's separation spring gives the push; the machine books it at PAYOUT entry
            this._cmd('releaseNose', { pushMps: this.plan.payoutM > 0 ? K().PAYOUT_PUSH_MPS : 0 });
            this.line = new LeashLine({
                mass: this.mass, pos: this.bag.pos, vel: this.bag.vel,
                reelLen: len(sub(io.anchorWorld, this.bag.pos)),
            });
            this.line.reelSpeed = this.reelSpeed;
            return false;
        }
        if (io.noseReleased === false) return false;
        this._enter(Math.abs(this.plan.payoutM) > 1e-9 ? 'PAYOUT' : 'TURN');
        return true;
    }

    _ph_PAYOUT(dt, io, g) {
        const k = K();
        const line = this.line;
        if (!this.entered) {
            this.entered = true;
            this.payoutTries++;
            const A = io.anchorWorld;
            const p = this.bag.pos;
            const r = len(p);
            const rt = r + this.plan.payoutM;
            const nrm = unit(sub(p, A));
            const pn = dot(p, nrm);
            const dist = len(sub(p, A));
            const disc = Math.max(0, pn * pn - r * r + rt * rt);
            const s = -pn + Math.sqrt(disc);
            this.pay = { target: dist + Math.max(0, s) };
            line.mode = 'payout';
            line.target = line.L - dist + this.pay.target;
            // H2: the nose's separation spring pushes once, at the first PAYOUT entry. A replan that
            // re-enters PAYOUT finds the bag off the nose: nothing exists to push it again.
            if (this.payoutTries === 1) {
                line.vel = add(line.vel, mul(nrm, k.PAYOUT_PUSH_MPS));
                this.bag.vel = clone(line.vel);
                this._bookKick(mul(nrm, k.PAYOUT_PUSH_MPS));
            }
        }
        const r = this._sim(dt, g);
        const A = io.anchorWorld;
        const dist = len(sub(this.bag.pos, A));
        // fb16: latched once true (a bag that waits for the radiator drifts back a few mm/s; it is still paid out). With the faster push
        // (PAYOUT_PUSH_MPS 0.05) the line's stop leaves a rebound of ~3.5 mm/s that no force removes (a line only pulls), a hair over the
        // old 3 mm/s rest test, so it passed only on a frame that sampled the rebound crossing zero (never at dt 0.25 s). At rest is now
        // also: the line is at its length, slack (no longer pulling), and the bag moves under 1 cm/s.
        const atLength = line.L >= line.target - 1e-4 && Math.abs(line.Ldot) < 1e-3;
        const sp = len(line.vel);
        const done = this.payoutDone || (atLength && (sp < 0.003 || (line.lastC <= 0 && sp < 0.01)));
        if (!done) return false;
        this.payoutDone = true;
        if (this.foldWait) {
            // fb16: paid out under the fold; the bag rests until the radiator has landed, then the plan is made again on the tip's real
            // position (the turn depends on it). The line spools freely meanwhile: a HELD line, a few mm stretched at the stop, would
            // pull the bag back in at ~3 mm/s, and the turn that follows carries that on (measured: the bag ended 25 mm nearer the tip)
            if (!this._foldLanded(io)) { line.mode = 'clutch'; return false; }
            this.foldWait = false;
        }
        line.mode = 'hold';
        line.Ldot = 0;
        if (!this._replan(io)) return false;
        if (Math.abs(this.plan.payoutM) <= k.PAYOUT_ACCEPT_M) {
            this._enter('TURN');
            return true;
        }
        // l5b-wire D10: a re-entry has no push and the bag is at rest, so it could only wait out the
        // PAYOUT time limit (60 s) before the same fault. Fault now.
        this._failWith('payout');
        return false;
    }

    _turnCmd(io, axisWorld, angleRad) {
        const lim = leashTurnLimits();
        this._cmd('startTurn', { axisWorld, angleRad, maxRate: lim.maxRate, accel: lim.accel });
    }

    _ph_TURN(dt, io, g) {
        if (!this.entered) {
            this.entered = true;
            if (this.plan.psiRad < 1e-4) { this._enter('CATCH'); return true; }
            const axisWorld = qRot(io.shipQuat, this.plan.axisBody);
            this._turnCmd(io, axisWorld, this.plan.psiRad);
            this.turn = { axisWorld, angle: this.plan.psiRad, issuedStep: this.stepNo, completed: false };
            this.line.mode = 'clutch';
        }
        this._sim(dt, g);
        const st = io.turn && io.turn.state;
        if (st === 'rejected') { this._failWith('turn rejected' + (io.turn.reason ? ': ' + io.turn.reason : '')); return false; }
        if (st === 'done' && this.stepNo > this.turn.issuedStep) {
            this.turn.completed = true;
            this._enter('CATCH');
            return true;
        }
        return false;
    }

    _ph_CATCH(dt, io, g) {
        const k = K();
        this.line.mode = 'clutch';
        this._sim(dt, g);
        const A = io.anchorWorld, B = this.bag.pos, T = io.tipWorld;
        const ab = sub(B, A);
        const l2 = dot(ab, ab);
        if (l2 < 1e-12) return false;
        const t = dot(sub(T, A), ab) / l2;
        const off = len(sub(T, add(A, mul(ab, t))));
        if (t > 0 && t < 1 && off <= k.CATCH_TOL_M) {
            const line = this.line;
            line.L += len(sub(A, T)) + len(sub(T, B)) - len(ab);
            line.engaged = true;
            line.mode = 'in';
            line.reelSpeed = this.reelSpeed;
            this._event('catch', { offsetM: off });
            this._enter('REEL');
            return true;
        }
        return false;
    }

    _ph_REEL(dt, io, g) {
        const line = this.line;
        line.mode = 'in';
        line.reelSpeed = this.reelSpeed;
        let used = 0;
        let guard = 0;
        while (used < dt - 1e-12 && guard++ < 64) {
            const f = used / dt;
            const gg = { a0: lerp(g.a0, g.a1, f), a1: g.a1, t0: lerp(g.t0, g.t1, f), t1: g.t1 };
            let verdict = 'none';
            const r = this._sim(dt - used, gg, {
                stopWhen: (l) => {
                    verdict = this._contact(io, l);
                    return verdict !== 'none';
                },
            });
            used += r.elapsed;
            if (verdict === 'latch') {
                this._cmd('latch');
                this._enter('LATCHED');
                return false;
            }
            if (verdict === 'bounce') {
                const e = K().RESTITUTION;
                const dir = unit(sub(io.tipWorld, line.pos));
                const vc = dot(line.vel, dir);
                const dvB = mul(dir, -(1 + e) * vc);
                line.vel = add(line.vel, dvB);
                this.bag.vel = clone(line.vel);
                this._bookKick(dvB);
                this.bounces++;
                this._event('bounce', { speed: vc, bounces: this.bounces });
                if (this.bounces >= K().MAX_BOUNCES) {
                    this._failWith('bounce');
                    return false;
                }
                this.reelSpeed *= this.retryFactor;
                line.reelSpeed = this.reelSpeed;
                continue;
            }
            break;
        }
        return false;
    }

    _contact(io, line) {
        const tip = io.tipWorld;
        const dir = unit(sub(tip, line.pos));
        const neck = add(line.pos, mul(dir, this.bagR));
        return latchCheck({ neckPos: neck, bagVel: line.vel, tipPos: tip, lineDirIn: dir });
    }

    _ph_LATCHED(dt, io) {
        this.line = null;
        // l5c-reach E5: the latch brings the bag to rest on the ship. Its momentum relative to the ship goes
        // onto the ship (+m·v), so the ship's books close at the latch instead of keeping m·v for ever.
        this._bookKick(mul(this.bag.vel, -1));
        this._pinBag(io);
        this._enter('CUT');
        return true;
    }

    _pinBag(io) {
        if (io.bagWorld) this.bag.pos = clone(io.bagWorld);
        this.bag.vel = V();
    }

    /**
     * l5c-reach E8: the wiring could not latch the bag on the tip (the tip's slot is taken, a hardware refusal).
     * The machine entered LATCHED on the step that sent 'latch', and the line is still on: recover exactly as
     * from a snag in the reel — lift off the slot, undo the turn, reel the bag home, relatch at the nose within
     * HOME_TOL_M. (A failure from LATCHED would go straight to FAILED and the wiring would have to move the
     * bag to the collar in one frame.)
     * @returns {boolean} true if the refusal was taken (the machine is now in REEL_HOME, or has cut the bag free)
     */
    refuseLatch() {
        if (this.phase !== 'LATCHED' || !this.line) return false;
        this.phase = 'REEL';                   // the latch never happened
        this._failWith('latch refused');
        return true;
    }

    _ph_CUT(dt, io) {
        this._pinBag(io);
        if (!this.entered) {
            this.entered = true;
            this._cmd('cutLine');
        }
        if (this.phaseT >= K().CUT_DWELL_S) { this._enter('SWING'); return true; }
        return false;
    }

    _ph_SWING(dt, io) {
        this._pinBag(io);
        if (!this.entered) {
            this.entered = true;
            this._cmd('swingToBoom');
            // fb16: the radiator opens while the bag swings onto the boom (the two are independent; the keep-out check on the bag
            // runs in SWING and UNFOLD alike)
            if (K().UNFOLD_DURING_SWING !== false) {
                this.unfoldIssued = true;
                this._cmd('unfoldRadiators', { thetaRad: this.unfoldTheta });
            }
            return false;
        }
        if (io.swingDone && this.stepNo > this.enteredStep) { this._enter('UNFOLD'); return true; }
        return false;
    }

    _ph_UNFOLD(dt, io) {
        this._pinBag(io);
        if (!this.entered) {
            this.entered = true;
            if (this.unfoldIssued) return true;   // fb16: already opening (since SWING began); only wait for it
            this._cmd('unfoldRadiators', { thetaRad: this.unfoldTheta });
            return false;
        }
        if (Math.abs(io.radiatorThetaRad - this.unfoldTheta) <= (K().THETA_TOL_DEG * DEG) && this.stepNo > this.enteredStep) {
            this._cmd('releaseHold');
            this._enter('DONE');
        }
        return false;
    }

    _ph_CUT_FREE(dt, io) {
        this.bag.pos = add(this.bag.pos, mul(this.bag.vel, dt));
        this._finishFailed({ reason: 'cut free', part: this.cutFree && this.cutFree.part, cause: this.cutFree && this.cutFree.reason, fault: this.cutFree && this.cutFree.fault });
        return false;
    }

    _ph_REEL_HOME(dt, io, g) {
        const h = this.home;
        const line = this.line;
        if (h.stage === 'lift') {
            if (!h.started) {
                h.started = true;
                line.mode = 'out';
                line.target = line.L + K().LIFT_OUT_M;
            }
            this._sim(dt, g);
            if (line.L >= line.target - 1e-6) {
                line.engaged = false;
                line.mode = 'clutch';
                h.stage = 'unturn';
                h.started = false;
                this.win = [];
                return true;
            }
            return false;
        }
        if (h.stage === 'unturn') {
            if (!this.turn) { h.stage = 'reelin'; return true; }
            if (!h.started) {
                h.started = true;
                line.mode = 'clutch';
                if (io.turn && io.turn.state === 'turning') {
                    this._cmd('cancelTurn');
                    h.waitStep = this.stepNo;
                    this._sim(dt, g);
                    return false;
                }
            }
            if (h.turnIssued === undefined) {
                if (h.waitStep !== undefined && this.stepNo === h.waitStep) { this._sim(dt, g); return false; }
                const prog = (this.turn.completed ? this.turn.angle : (io.turn && io.turn.progressRad)) || 0;
                if (Math.abs(prog) > 1e-4) {
                    this._turnCmd(io, this.turn.axisWorld, -prog);
                    h.turnIssued = this.stepNo;
                } else {
                    h.stage = 'reelin';
                    return true;
                }
            }
            this._sim(dt, g);
            if (io.turn && io.turn.state === 'rejected') { this._cutFree('turn rejected'); return false; }
            if (io.turn && io.turn.state === 'done' && this.stepNo > h.turnIssued) {
                h.stage = 'reelin';
                return true;
            }
            return false;
        }
        if (h.stage === 'reelin') {
            // F1: no teleport. A pull-only line from the ring rim cannot carry a bag outward, so a bag that
            // moved toward the tip (closer to the anchor than at the start) cannot get home: cut it free.
            const k = K();
            const dist0 = len(sub(this.bag.pos, io.anchorWorld));
            if (!h.reelChecked) {
                h.reelChecked = true;
                if (dist0 < this.startDist - k.HOME_TOL_M) { this._cutFree('cannot reach the nose'); return false; }
            }
            line.mode = 'in';
            // a pull-only line cannot slow the bag once the reel stops, so it must pass the nose slowly enough for the magnet
            line.reelSpeed = Math.min(this.reelSpeed, k.HOME_REEL_MPS);
            line.minLen = this.startDist;          // never shorter than the start distance
            this._sim(dt, g);
            const dist = len(sub(this.bag.pos, io.anchorWorld));
            const speed = len(this.bag.vel);       // the ship is still: world speed = speed relative to the ship
            const away = len(sub(this.bag.pos, qRot(io.shipQuat, this.homeBody)));
            if (away <= k.HOME_TOL_M && speed <= k.LATCH_OK_MPS) {
                this._cmd('relatchNose');
                this._cmd('unfoldRadiators', { thetaRad: this.homeTheta });
                this.line = null;
                h.stage = 'unfold';
                h.waitStep = this.stepNo;
            } else if (dist < this.startDist - k.HOME_TOL_M) {
                this._cutFree('cannot reach the nose');   // it missed the nose and is now inside the home sphere
            }
            return false;
        }
        if (h.stage === 'unfold') {
            if (!h.started) {
                h.started = true;
                if (h.origin === 'FOLD') this._cmd('unfoldRadiators', { thetaRad: this.homeTheta });
                h.waitStep = this.stepNo;
                return false;
            }
            if (this.stepNo > h.waitStep && Math.abs(io.radiatorThetaRad - this.homeTheta) <= (K().THETA_TOL_DEG * DEG)) {
                this._cmd('releaseHold');
                this._finishFailed({ reason: h.reason, part: h.part });
            }
            return false;
        }
        return false;
    }
}
