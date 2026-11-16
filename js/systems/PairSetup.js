/**
 * PairSetup.js — the pair-setup burn (plan sky-1116, lane L-pair; owner 2026-11-16: "planning where a small burn will position
 * mother for easy captures, especially captures nearly on opposite sides so reaction from 2 daughters launching at same time
 * cancels reaction, saves fuel").
 *
 * Pure part (this file, top): Clohessy-Wiltshire relative motion about her circular orbit, and a finite-thrust two-arc burn
 * (one arc from the start of the window, one ending at its end, each at constant thrust direction, thrust = the engine's real
 * push over her mass: Hall thrust time, so 10-30 min windows cannot be flown and the windows here are 60-120 min) that takes her
 * to a point on, or up to 600 m behind along the track, the line between two pieces, with the pieces' own velocity there. The
 * pieces fly free on their CW orbits meanwhile (a replan every 5 game minutes absorbs drift). Measured 2026-11-16 against
 * `tmp/sky1116/pair/scen.mjs`: the impulsive limit of this planner equals scen's two-impulse dv within 0.1%.
 *
 * Only goals the EXISTING pair rule accepts are offered (`pairVerdict`: her attitude held in the orbit frame, the barrel turn
 * capped at 30 deg, the miss limits, tethers, home gap), and not goals the rule already accepts from where she is. With her
 * attitude held, almost none of the "exactly between A and B" goals pass (the pieces lie ahead along the track, the pair needs the
 * strut axis along A-B), so the offset behind the line is part of the search; the line promises a pair shot, not "between".
 *
 * Game part (`PairSetup` class, below): looks for such a setup while no pair is offered, says ONE line, and on the accept key Y
 * (or the tap) flies the burn through `PlayerSatellite.applyCartesianImpulse(dv, dt, { continuous: true })`, the same thrust
 * command the autopilot's chase uses (AutopilotSystem.js `update`, `this._player.applyCartesianImpulse(dvCmd, dt, ...)`).
 * After the burn the existing pair offer (AutopilotSystem `_tickPairOffer`) shows as today. On arrival she asks the pair rule first:
 * in position -> piece A becomes her target, a daughter of the pair is picked (the two inputs that pair offer needs), piece B carries
 * the reticle's PAIR mark (`getMarkPiece`, handed over by main.js) and the line names both; else the line says it stopped short.
 * The burn ends on the player's own thrust (`thrustInput`) and on NET_FIRED, with a short line.
 *
 * Training missions 1-3 never get a setup offer (DECISIONS §71: training stays as the owner played it).
 *
 * @module systems/PairSetup
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';
import { isTrainingNow } from './TrainingHintGate.js';
import { GestureHints } from '../ui/hud/GestureHints.js';

/** The numbers of this lane (plan sky-1116 keeps each lane's constants in its own module). */
export const PAIR_SETUP = Object.freeze({
  ENABLED: true,
  /** Game seconds from the accept to the arrival: tried shortest first; a longer window is taken only while it saves gas. */
  WINDOWS_S: Object.freeze([3600, 4500, 5400, 6300, 7200]),
  /** A window is skipped when |sin(n T)| is under this: near a whole orbit a radial offset cannot be reached (CW: x = sin(nT)/n * vx0). */
  MIN_SIN: 0.3,
  /** The shortest window is kept unless a longer one saves at least this fraction of the gas. */
  LONGER_SAVES: 0.2,
  /** Where on the line between the two pieces she ends: from piece A (0) to piece B (1). */
  S_MIN: 0.2, S_MAX: 0.8, S_STEP: 0.05,
  /** Both pieces must end within this fraction of the daughters' reach (the reach: tetherMax x ARM_DEPLOY_RANGE_FRACTION). */
  REACH_FRAC: 0.95,
  /** The two ranges at the end must differ by less than this fraction of the pair's HOME_GAP_S (x launch speed). */
  GAP_FRAC: 0.8,
  /** Pieces searched: both within this range now (m); the reach is the limit after the burn, this one bounds the work. */
  SEARCH_M: 3000,
  /** The burn is looked at again this often (game s): drag and the pieces' own drift move the goal. */
  REPLAN_S: 300,
  /** No replan inside the last stretch of the window (game s): too short for a second look to matter. */
  REPLAN_END_S: 600,
  /** A replan that now costs more than this multiple of the first plan's gas (or fails) ends the setup. */
  ABORT_COST_X: 3,
  /** An offer is looked for at most this often (real s of play). */
  LOOK_S: 2,
  /** Piece-count and pair work caps per look. */
  MAX_PIECES: 40,
  MAX_CHECKED: 6,
  /** The offer's line is said at most once per this many game seconds for the same pair of pieces... */
  SAY_AGAIN_S: 3600,
  /** ...and any two offer lines are at least this far apart (game s): the offer stands and Y works, the next line waits. */
  SAY_GAP_S: 1200,
  /** The two pieces must be at least this far apart (m): nearer is a clump the net scoops whole. */
  MIN_SEP_M: 40,
  /** Each arc must be at least this long (s) to count as a burn (shorter = skipped). */
  MIN_ARC_S: 5,
});

// ── small linear algebra on plain arrays (the planner runs a few thousand of these per look) ──
const mv3 = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Solve the n x n system A x = b (Gaussian elimination, partial pivoting); null when singular. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * The Clohessy-Wiltshire state transition over `t` seconds about a circular orbit of mean motion `n` (rad/s). Frame: x radial
 * (up), y along the track (forward), z across the track (orbit normal). Prr/Prv: position from position/velocity; Pvr/Pvv: velocity.
 * @param {number} n @param {number} t
 */
export function cwPhi(n, t) {
  const c = Math.cos(n * t), s = Math.sin(n * t);
  return {
    Prr: [[4 - 3 * c, 0, 0], [6 * (s - n * t), 1, 0], [0, 0, c]],
    Prv: [[s / n, 2 * (1 - c) / n, 0], [-2 * (1 - c) / n, (4 * s - 3 * n * t) / n, 0], [0, 0, s / n]],
    Pvr: [[3 * n * s, 0, 0], [6 * n * (c - 1), 0, 0], [0, 0, -n * s]],
    Pvv: [[c, 2 * s, 0], [-2 * s, 4 * c - 3, 0], [0, 0, c]],
  };
}

/** A relative state [pos(3), vel(3)] carried `t` seconds on its free CW orbit. */
export function cwFree(n, t, pos, vel) {
  const P = cwPhi(n, t);
  return { pos: add3(mv3(P.Prr, pos), mv3(P.Prv, vel)), vel: add3(mv3(P.Pvr, pos), mv3(P.Pvv, vel)) };
}

// 5-point Gauss-Legendre on [-1, 1]
const GL_X = [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640];
const GL_W = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

/**
 * What a constant thrust acceleration (1 m/s^2, any direction) applied over [t0, t1] does to the state at time T: a 6 x 3
 * matrix (rows 0-2 position, 3-5 velocity), the integral of [Prv; Pvv](T - tau) over the arc.
 * @returns {number[][]} 6 x 3
 */
export function arcMatrix(n, T, t0, t1) {
  const G = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const parts = 2, h = (t1 - t0) / parts;
  for (let p = 0; p < parts; p++) {
    const a = t0 + p * h, mid = a + h / 2;
    for (let i = 0; i < GL_X.length; i++) {
      const tau = mid + GL_X[i] * h / 2, w = GL_W[i] * h / 2;
      const P = cwPhi(n, T - tau);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { G[r][c] += w * P.Prv[r][c]; G[r + 3][c] += w * P.Pvv[r][c]; }
    }
  }
  return G;
}

/**
 * The two-arc finite burn from rest at the origin (her own frame, the burn's reference orbit) to the relative state
 * (X, V) at time T: arc 1 on [0, tau1], arc 2 on [T - tau2, T], constant thrust vector on each, thrust acceleration `a`
 * (the engine's push over her mass, as applied). Starts from the impulsive two-burn answer and refines the arc lengths until
 * the thrust each arc needs equals `a`.
 * @param {number} n mean motion @param {number} T window (s) @param {number} a thrust acceleration (m/s^2)
 * @param {number[]} X end position (m) @param {number[]} V end velocity (m/s)
 * @returns {{u1:number[], u2:number[], tau1:number, tau2:number, dv1:number, dv2:number, dv:number}|null} u = unit direction
 */
export function planArcs(n, T, a, X, V) {
  const P = cwPhi(n, T);
  const Pi = invert3(P.Prv);
  if (!Pi) return null;
  return planArcsFrom(n, T, a, X, V, Pi, P.Pvv);
}

/** `planArcs` with the window's matrices already made (the search calls it for many goals in one window). */
export function planArcsFrom(n, T, a, X, V, Pi, Pvv) {
  const v1 = mv3(Pi, X);
  const v2 = sub3(V, mv3(Pvv, v1));
  const b = [...X, ...V];
  // For arc lengths (t1, t2) the thrust vectors that reach (X, V) are the solution of a 6 x 6 system; the burn is real when both
  // have the push `a`. Root-find on the logs of the two lengths (Newton, finite-difference Jacobian): the thrust falls roughly as
  // 1 / length, so the logs are nearly linear and a few steps do it. (A plain fixed point t <- |u| t / a diverges for long arcs.)
  const solve = (l1, l2) => {
    const t1 = Math.exp(l1), t2 = Math.exp(l2);
    if (t1 + t2 > 0.9 * T) return null;
    const G1 = arcMatrix(n, T, 0, t1), G2 = arcMatrix(n, T, T - t2, T);
    const A = [];
    for (let r = 0; r < 6; r++) A.push([G1[r][0], G1[r][1], G1[r][2], G2[r][0], G2[r][1], G2[r][2]]);
    const x = solveLinear(A, b);
    if (!x) return null;
    const u1 = [x[0], x[1], x[2]], u2 = [x[3], x[4], x[5]];
    return { u1, u2, t1, t2, f1: Math.log(Math.max(len3(u1), 1e-9) / a), f2: Math.log(Math.max(len3(u2), 1e-9) / a) };
  };
  let l1 = Math.log(Math.max(len3(v1) / a, 2)), l2 = Math.log(Math.max(len3(v2) / a, 2));
  let cur = solve(l1, l2);
  for (let it = 0; it < 14 && cur; it++) {
    if (Math.abs(cur.f1) < 0.004 && Math.abs(cur.f2) < 0.004) break;
    const h = 0.02;
    const s1 = solve(l1 + h, l2), s2 = solve(l1, l2 + h);
    if (!s1 || !s2) return null;
    const J = [[(s1.f1 - cur.f1) / h, (s2.f1 - cur.f1) / h], [(s1.f2 - cur.f2) / h, (s2.f2 - cur.f2) / h]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (!(Math.abs(det) > 1e-9)) return null;
    let d1 = -(J[1][1] * cur.f1 - J[0][1] * cur.f2) / det, d2 = -(-J[1][0] * cur.f1 + J[0][0] * cur.f2) / det;
    const big = Math.max(Math.abs(d1), Math.abs(d2));
    if (big > 1) { d1 /= big; d2 /= big; }
    let ok = false;
    for (let k = 0; k < 6 && !ok; k++) {                       // halve the step until the thrust mismatch shrinks
      const nx = solve(l1 + d1, l2 + d2);
      if (nx && Math.hypot(nx.f1, nx.f2) < Math.hypot(cur.f1, cur.f2)) { l1 += d1; l2 += d2; cur = nx; ok = true; } else { d1 /= 2; d2 /= 2; }
    }
    if (!ok) break;
  }
  if (!cur || !(Math.abs(cur.f1) < 0.02 && Math.abs(cur.f2) < 0.02)) return null;
  const t1 = cur.t1, t2 = cur.t2;
  if (!(t1 + t2 < 0.9 * T)) return null;
  return { u1: unit3(cur.u1), u2: unit3(cur.u2), tau1: t1, tau2: t2, dv1: t1 * a, dv2: t2 * a, dv: (t1 + t2) * a };
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

/** Gas (kg) of a burn of `dv` m/s at exhaust speed `ve` from mass `m` (the rocket equation: what the game bills, `ionGasUnits`). */
export function gasKgFor(dv, ve, m) { return m * (1 - Math.exp(-dv / ve)); }

/**
 * Her LVLH frame (x radial, y along-track, z normal) in world axes, and the relative state of any inertial state in it.
 * @param {number[]} rM her position (m) @param {number[]} vM her velocity (m/s) @param {number} n her mean motion
 * @returns {{R:number[], T:number[], N:number[], rel:(r:number[], v:number[])=>{pos:number[], vel:number[]}, toWorld:(c:number[])=>number[], fromWorld:(w:number[])=>number[]}}
 */
export function lvlhFrame(rM, vM, n) {
  const R = unit3(rM), N = unit3(cross3(rM, vM)), T = cross3(N, R);
  const fromWorld = (w) => [dot3(w, R), dot3(w, T), dot3(w, N)];
  const toWorld = (c) => [R[0] * c[0] + T[0] * c[1] + N[0] * c[2], R[1] * c[0] + T[1] * c[1] + N[1] * c[2], R[2] * c[0] + T[2] * c[1] + N[2] * c[2]];
  return {
    R, T, N, fromWorld, toWorld,
    rel(r, v) {
      const pos = fromWorld(sub3(r, rM)), dv = fromWorld(sub3(v, vM));
      return { pos, vel: [dv[0] + n * pos[1], dv[1] - n * pos[0], dv[2]] };   // the rotating frame's own velocity
    },
  };
}

/** The places she may end, as offsets (m, LVLH) from the point on the line between the two pieces: on the line, or this far BEHIND
 * the pair along the track (the pieces lie ahead of her, so a pair is seen inside the barrel's cone from behind them; probe,
 * 2026-11-16: with her attitude held, 4 of 476 on-the-line goals passed the pair rule at mission 4, 110 of ~1,900 at 300 m behind). */
const OFFSETS = Object.freeze([[0, 0, 0], [0, -100, 0], [0, -200, 0], [0, -300, 0], [0, -450, 0], [0, -600, 0]]);

/**
 * The goals of ONE window, screened by the impulsive two-burn dv (cheap). Pushes onto `out` (kept to the cheapest `cap`).
 * @param {object} inp see `planPairSetups` @param {number} T window (s) @param {object[]} out
 */
export function screenWindow(inp, T, out) {
  for (const _ of screenWindowGen(inp, T, out)) { /* run to the end */ }
  return out;
}

/** `screenWindow` as a generator that yields after each row of pieces (a row is about 2 ms), so the game can spread it over frames. */
export function* screenWindowGen(inp, T, out) {
  const P = PAIR_SETUP;
  const { n, pieces, reachM, launchSpeed, homeGapS } = inp;
  const maxGap = P.GAP_FRAC * Math.max(0, homeGapS) * launchSpeed;
  const offsets = inp.offsets || OFFSETS;
  const cap = inp.cap ?? 300;
  if (Math.abs(Math.sin(n * T)) < P.MIN_SIN) return;
  const ph = cwPhi(n, T);
  const Pi = invert3(ph.Prv);
  if (!Pi) return;
  const z0 = inp.z0 || null, bisect = Math.cos((inp.bisectDeg ?? 50) * Math.PI / 180);
  const end = pieces.map((p) => cwFree(n, T, p.pos, p.vel));
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (len3(sub3(pieces[i].pos, pieces[j].pos)) < P.MIN_SEP_M) continue;
      const A = end[i], B = end[j];
      for (let s = P.S_MIN; s <= P.S_MAX + 1e-9; s += P.S_STEP) {
        const L0 = [A.pos[0] + s * (B.pos[0] - A.pos[0]), A.pos[1] + s * (B.pos[1] - A.pos[1]), A.pos[2] + s * (B.pos[2] - A.pos[2])];
        const V = [A.vel[0] + s * (B.vel[0] - A.vel[0]), A.vel[1] + s * (B.vel[1] - A.vel[1]), A.vel[2] + s * (B.vel[2] - A.vel[2])];
        for (let k = 0; k < offsets.length; k++) {
          const o = offsets[k];
          const X = [L0[0] + o[0], L0[1] + o[1], L0[2] + o[2]];
          const rA = sub3(A.pos, X), rB = sub3(B.pos, X);
          const la = len3(rA), lb = len3(rB);
          if (la > reachM * P.REACH_FRAC || lb > reachM * P.REACH_FRAC || la < 1 || lb < 1 || Math.abs(la - lb) > maxGap) continue;
          if (z0) {   // the barrel can turn 30 deg: the pair's bisector must be near it (the solver's own first test, for free)
            const m = [rA[0] / la + rB[0] / lb, rA[1] / la + rB[1] / lb, rA[2] / la + rB[2] / lb], ml = len3(m);
            const cosB = ml > 1e-6 ? Math.abs(dot3(z0, m)) / ml : 0;
            if (cosB < bisect) continue;
          }
          const v1 = mv3(Pi, X), v2 = sub3(V, mv3(ph.Pvv, v1));
          out.push({ i, j, T, s, off: k, X, V, dvImp: len3(v1) + len3(v2), rA, rB, la, lb, Pi, Pvv: ph.Pvv, A, B });
        }
      }
      if (out.length > 4 * cap) { out.sort((p, q) => p.dvImp - q.dvImp); out.length = cap; }
    }
    yield;
  }
}

/** The finite-thrust plan of one screened goal, as a candidate; null when the arcs do not fit the window. */
export function finishGoal(inp, c) {
  const arcs = planArcsFrom(inp.n, c.T, inp.a, c.X, c.V, c.Pi, c.Pvv);
  if (!arcs) return null;
  return { i: c.i, j: c.j, idA: inp.pieces[c.i].id, idB: inp.pieces[c.j].id, T: c.T, s: c.s, off: c.off, X: c.X, V: c.V, arcs,
    gasG: 1000 * gasKgFor(arcs.dv, inp.ve, inp.massKg), rA: c.rA, rB: c.rB, endRangeA: c.la, endRangeB: c.lb, endA: c.A, endB: c.B };
}

/**
 * Of the candidates the pair rule accepts, the one to offer: the cheapest, unless a shorter window has one within 25% of its gas.
 * @param {object[]} pass candidates, any order
 */
export function chooseBest(pass) {
  if (!pass.length) return null;
  const sorted = [...pass].sort((p, q) => p.gasG - q.gasG);
  const best = sorted[0];
  let pick = best;
  for (const c of sorted) if (c.T < pick.T && c.gasG <= best.gasG * (1 + PAIR_SETUP.LONGER_SAVES / (1 - PAIR_SETUP.LONGER_SAVES))) pick = c;
  return pick;
}

/**
 * The whole search at once (tests, probes, the accept re-plan): screen every window, finish the cheapest goals in order, keep
 * the ones `verdict` accepts, until `maxPass` are found or `maxTry` goals are tried.
 * @param {object} inp
 * @param {number} inp.n mean motion @param {number} inp.a thrust acceleration (m/s^2, as applied)
 * @param {number} inp.massKg @param {number} inp.ve exhaust speed (m/s)
 * @param {Array<{id:*, pos:number[], vel:number[]}>} inp.pieces relative LVLH states now
 * @param {number} inp.reachM @param {number} inp.launchSpeed (m/s) @param {number} inp.homeGapS
 * @param {number[]} [inp.windows] @param {number[]} [inp.z0] her barrel in LVLH (for the bisector test)
 * @param {(c:object)=>boolean} [inp.verdict] the pair rule from the end point
 * @param {number} [inp.maxTry=80] @param {number} [inp.maxPass=4]
 * @returns {object[]} candidates (`finishGoal`), cheapest first
 */
export function planPairSetups(inp) {
  const goals = [];
  for (const T of inp.windows || PAIR_SETUP.WINDOWS_S) screenWindow(inp, T, goals);
  goals.sort((p, q) => p.dvImp - q.dvImp);
  const out = [];
  let tried = 0;
  for (const g of goals) {
    if (tried >= (inp.maxTry ?? 80) || out.length >= (inp.maxPass ?? 4)) break;
    tried++;
    const c = finishGoal(inp, g);
    if (!c) continue;
    if (inp.verdict && !inp.verdict(c)) continue;
    out.push(c);
  }
  out.sort((p, q) => p.gasG - q.gasG);
  return out;
}

/** Row-major 3 x 3 of her attitude in LVLH coordinates: the body-to-world rotation `Rw` (row-major 9, `pairRotationOf`) read in the
 * frame axes (R, T, N), so the pair solver can run on LVLH vectors. Her attitude holds in that frame while the player owns it
 * (PlayerSatellite `_orientAlongVelocity`: quaternion = prograde x offset), so this stays true while she coasts to the end point. */
export function attitudeInLvlh(Rw, L) {
  const out = new Float64Array(9);
  const axes = [L.R, L.T, L.N];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[3 * i + j] = axes[i][0] * Rw[j] + axes[i][1] * Rw[3 + j] + axes[i][2] * Rw[6 + j];
  return out;
}

/**
 * Would the pair rule offer these two pieces from this end point? The search's own checks (AutopilotSystem `_pairSearchUnit`):
 * both launch lines within MISS_DEG, the barrel turn within TURN_DEG, the plane limit, the fuel cap, the spread, the two tethers
 * not crossing, a part of the ship not across a line, the two pieces at least MIN_SEP_DEG apart, the catches within HOME_GAP_S.
 * @param {object} env `{ solvePairAimAll, pairTethersCross, pairAttitudeFor, pairLineBlockedAt?(alpha) }` (from AutopilotSystem)
 * @param {object} g `pairGeometry` @param {ArrayLike<number>} Rb her attitude in LVLH (`attitudeInLvlh`)
 * @param {number[]} rA metres from her centre to piece A, LVLH @param {number[]} rB likewise piece B
 * @param {{planMaxDeg:number, type:string, speedA:number, speedB:number}} opt
 * @returns {{ok:boolean, why?:string, miss?:number, turnDeg?:number, alpha?:number}}
 */
export function pairVerdict(env, g, Rb, rA, rB, opt) {
  const PS = Constants.PAIR_SHOT;
  const la = len3(rA) || 1, lb = len3(rB) || 1;
  const sep = Math.acos(Math.max(-1, Math.min(1, dot3(rA, rB) / (la * lb)))) * 180 / Math.PI;
  if (sep < PS.MIN_SEP_DEG) return { ok: false, why: 'clump' };
  if (Math.abs(la / opt.speedA - lb / opt.speedB) > (PS.HOME_GAP_S ?? Infinity)) return { ok: false, why: 'home gap' };
  const sols = env.solvePairAimAll(g, Rb, rA, rB, { turnDeg: PS.TURN_DEG });
  let why = 'no solution';
  for (const r of sols) {
    if (r.missA > PS.MISS_DEG || r.missB > PS.MISS_DEG || r.turnDeg > PS.TURN_DEG + 1e-6) { why = 'miss'; continue; }
    if (Math.max(r.missA, r.missB) > opt.planMaxDeg) { why = 'plane'; continue; }
    if (PS.FUEL_G_PER_DEG[opt.type] * (r.missA + r.missB) > PS.FUEL_G[opt.type]) { why = 'fuel'; continue; }
    const flight = r.alpha <= Math.PI / 2 ? 2 * r.alpha : 2 * Math.PI - 2 * r.alpha;
    if (flight < (PS.SPREAD_MIN_DEG || 0) * Math.PI / 180) { why = 'spread'; continue; }
    if (env.pairTethersCross(g, env.pairAttitudeFor(Rb, r.n), r.alpha, r.swap, rA, rB)) { why = 'tethers'; continue; }
    if (env.pairLineBlockedAt && env.pairLineBlockedAt(r.alpha)) { why = 'blocked'; continue; }
    return { ok: true, miss: Math.max(r.missA, r.missB), turnDeg: r.turnDeg, alpha: r.alpha };
  }
  return { ok: false, why };
}

// ── The words (plain; the owner's rule: lead with what to do, then why; glass says Tap, never a key) ──

const forInput = (desktop, glass) => (GestureHints.isGlass() ? glass : desktop);
const gWords = (g) => (g < 10 ? `${Math.max(0.1, Math.round(g * 10) / 10).toFixed(1)} g` : `${Math.round(g)} g`);
const minWords = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const mWords = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

/** The HUD's own words for a piece (TargetPanel `_getFullTypeName`) and its distance from her now, e.g. "Fragment (740 m)". */
const TYPE_NAMES = { rocketBody: 'Rocket Body', defunctSat: 'Defunct Sat', missionDebris: 'Mission Debris', fragment: 'Fragment' };
export function pieceLabel(d, distM) {
  const name = (d && TYPE_NAMES[d.type]) || 'Debris';
  return Number.isFinite(distM) ? `${name} (${mWords(distM)})` : name;
}

/** The offer: said once per pair of pieces (owner's line, 2026-11-16, with "nearly": the burn ends near the line between them). */
export function setupOfferLine(o) {
  return `Line up a pair: a small burn now puts you nearly between ${o.labelA || 'one piece'} and ${o.labelB || 'another'} in about ${minWords(o.T)}, ${gWords(o.gasG)} gas. ${forInput('Press Y', 'Tap SET UP PAIR')}.`;
}
export function setupStartLine(o) { return `Flying the pair setup: about ${gWords(o.gasG)} of gas over about ${minWords(o.T)}. The pair shot is offered when you arrive.`; }
/** Arrival, with the pair rule satisfied: the first piece is her selected target, the second carries the PAIR mark. */
export function setupArriveLine(o) {
  return `In position for a pair: ${o && o.labelA ? o.labelA : 'the first piece'} is selected and ${o && o.labelB ? o.labelB : 'the second'} is marked PAIR. The pair shot is offered next; it may pick a better second piece.`;
}
/** Arrival with the pair rule NOT satisfied (the burn ended short: refused frames, drift). */
export function setupShortLine() { return 'Pair setup stopped short: the two pieces do not line up for a pair shot from here. A new setup is offered if one fits.'; }
export function setupAbortLine(why) { return `Pair setup stopped: ${why}.`; }
export function setupNoneLine() { return `No pair setup is offered now. It appears when a small burn can line two pieces up for a pair shot.`; }
export function setupRefusedLine(why) { return `Pair setup waits: ${why}.`; }

let _active = null;
/** True while a setup is offered (the touch button reads it; TouchControls keeps no copy of the game's state). */
export function pairSetupOffered() { return !!(_active && _active.getOffer()); }

const IDLE_ARM = new Set(['DOCKED', 'HOLDING_CATCH', 'RELOADING']);

/**
 * The game side: looks for a setup while no pair is offered, says one line, flies the burn on accept, and says when she is there.
 * Owned and ticked by AutopilotSystem (`_tickPairSetup`); every game object is read through `ap` and `env`.
 */
export class PairSetup {
  /**
   * @param {object} ap the AutopilotSystem
   * @param {object} env `{ solvePairAimAll, pairTethersCross, pairAttitudeFor, pairGeometry, pairRotationOf }`
   * @param {{now?: ()=>number}} [opts] `now` = the clock for the look's time slices (tests)
   */
  constructor(ap, env, opts = {}) {
    this._ap = ap;
    this._env = env;
    this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._offer = null;
    this._offerMisses = 0;
    this._burn = null;
    this._gen = null;
    this._lookClock = PAIR_SETUP.LOOK_S;     // look at once on the first tick
    this._clock = 0;                          // game seconds
    this._said = new Map();                   // pair key -> game clock it was said at
    this._lastBurn = null;
    this._lastSaid = undefined;
    this._mark = null;                        // after an arrival in position: { pieceA, pieceB } while B carries the PAIR mark
    // the mother's net going out ends the burn (the net's own kick and the line it hands to her are not part of the plan)
    this._onNetFired = () => { if (this._burn) this._abort('you fired the net'); };
    eventBus.on(Events.NET_FIRED, this._onNetFired);
    _active = this;
  }

  dispose() {
    if (_active === this) _active = null;
    eventBus.off(Events.NET_FIRED, this._onNetFired);
    this._gen = null; this._offer = null; this._burn = null; this._mark = null;
  }

  /** A new game: forget the offer, the burn (silently) and what was said. */
  reset() {
    this._offer = null; this._burn = null; this._gen = null; this._offerMisses = 0; this._mark = null;
    this._said.clear(); this._lastSaid = undefined; this._lastBurn = null; this._lookClock = PAIR_SETUP.LOOK_S;
  }

  /**
   * The piece to mark PAIR after an in-position arrival (main.js hands it to the reticle's existing pair mark), or null. Held only
   * while piece A is still her target, both pieces are fair, no daughter is out and the game's own pair offer has not taken over.
   */
  getMarkPiece() {
    const m = this._mark;
    if (!m) return null;
    const ap = this._ap, ts = ap._targetSelector;
    const offered = typeof ap.getPairOffer === 'function' && ap.getPairOffer();
    const out = ap._armManager && Array.isArray(ap._armManager.arms) && ap._armManager.arms.some((a) => a && !IDLE_ARM.has(a.state));
    if (offered || out || !ts || ts.getActiveTarget() !== m.pieceA || !ap._pairPieceOk(m.pieceA) || !ap._pairPieceOk(m.pieceB)) { this._mark = null; return null; }
    return m.pieceB;
  }

  /** @returns {object|null} the setup offered now */
  getOffer() { return this._burn ? null : this._offer; }
  isBurning() { return !!this._burn; }
  /** Read-only (tests, HUD). */
  getBurn() { return this._burn; }
  lastBurn() { return this._lastBurn; }

  /** What the world looks like to the planner now, or null (a precondition fails). `forceType` is for the accept re-plan. */
  _context() {
    const ap = this._ap, p = ap._player, am = ap._armManager, PS = Constants.PAIR_SHOT;
    if (!PAIR_SETUP.ENABLED || !PS || PS.ENABLED === false || !p || !am || !p._cartesian || !p.orbit) return null;
    if (p.safeMode || isTrainingNow()) return null;
    if (ap._engaged || p.autopilotEngaged || ap._tripHold || ap._tripOmega > 0 || ap._turn || ap._aimCoroutine || ap._attitudeHold) return null;
    if (!Array.isArray(am.arms) || typeof am.getDualFirePair !== 'function') return null;
    if (am.arms.some((a) => a && !IDLE_ARM.has(a.state))) return null;                   // a daughter out on her line: no burn
    if (typeof am._motherTurnBlock === 'function' && am._motherTurnBlock()) return null;
    if (p._thrusterInterlock) return null;
    // the opposite pair to use: the weavers (the long reach) first, then the spinners
    let pair = null;
    for (const type of ['weaver', 'spinner']) {
      for (const a of am.arms) {
        if (!a || !Number.isInteger(a.index)) continue;
        const j = am.getDualFirePair(a.index);
        if (!Number.isInteger(j) || j < a.index) continue;
        const b = am.arms[j];
        if (!ap._pairArmReady(a) || !ap._pairArmReady(b) || !a.config || !b.config || a.config.type !== type || b.config.type !== type) continue;
        pair = { armA: a, armB: b, type };
        break;
      }
      if (pair) break;
    }
    if (!pair) return null;
    const { armA, armB, type } = pair;
    const dpA = am._dockPositions && am._dockPositions[armA.index], dpB = am._dockPositions && am._dockPositions[armB.index];
    if (!dpA || !dpB) return null;
    const lo = Math.PI / 180 * (PS.ALPHA_MIN_DEG[type] ?? 7), hi = Math.PI / 180 * Math.min(PS.ALPHA_MAX_DEG, 180);
    const g = this._env.pairGeometry(dpA, dpB, lo, hi);
    // her state, in metres, and the LVLH frame about her
    const MPS = 1 / Constants.SCENE_UNITS_PER_METER;
    const c = p._cartesian;
    const rM = [c.position.x * MPS, c.position.y * MPS, c.position.z * MPS], vM = [c.velocity.x * 1000, c.velocity.y * 1000, c.velocity.z * 1000];
    const n = p.orbit.meanMotion;
    if (!(n > 0)) return null;
    const L = lvlhFrame(rM, vM, n);
    const Rw = this._env.pairRotationOf(p.quaternion);
    const Rb = attitudeInLvlh(Rw, L);
    const fuel = (p._resourceSystem && p._resourceSystem.getCurrentFuel ? p._resourceSystem.getCurrentFuel() : null) || Constants.FUELS[Constants.DEFAULT_FUEL];
    const ts = typeof p.getThrustScale === 'function' && p.getThrustScale() > 0 ? p.getThrustScale() : 1;
    const mass = p.mass > 1 ? p.mass : 291;
    const cons = typeof p.getConsumptionMultiplier === 'function' && p.getConsumptionMultiplier() > 0 ? p.getConsumptionMultiplier() : 1;   // the bill's own factor (ionGasUnits)
    const aCmd = Constants.TRIP.XENON_THRUST_N / mass;              // what she commands: the push of the xenon engine over her mass
    const speed = (a) => Math.max(0.5, Number.isFinite(a.launchSpeed) ? a.launchSpeed : 7);
    return { p, am, ap, pair, type, armA, armB, g, L, Rb, n, rM, vM, mass, cons, fuel, ve: fuel.isp * Constants.G0, ts,
      aCmd, a: aCmd * ts, MPS, reachM: armA.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION, speedA: speed(armA), speedB: speed(armB),
      z0: [Rb[2], Rb[5], Rb[8]], maxMass: armA.config.maxCaptureMass };
  }

  /** The pieces she could take as a pair, as relative LVLH states. */
  _pieces(ctx, only = null) {
    const list = ctx.ap._debrisField && ctx.ap._debrisField.debrisList;
    if (!list || !list.length) return [];
    const out = [];
    for (const d of list) {
      if (only && !only.includes(d.id)) continue;
      if (!ctx.ap._pairPieceOk(d) || d.discovered === false || d._captured || d._armPinned || !d.orbit || d._onboardingPinned) continue;
      if (!(d.mass <= ctx.maxMass)) continue;
      const sp = d._scenePosition, pp = ctx.p.position;
      const dx = (sp.x - pp.x) * ctx.MPS, dy = (sp.y - pp.y) * ctx.MPS, dz = (sp.z - pp.z) * ctx.MPS;
      const dist = Math.hypot(dx, dy, dz);
      if (!only && dist > PAIR_SETUP.SEARCH_M) continue;
      const cc = orbitToSceneCartesian(d.orbit);
      const st = ctx.L.rel([cc.position.x * ctx.MPS, cc.position.y * ctx.MPS, cc.position.z * ctx.MPS], [cc.velocity.x * 1000, cc.velocity.y * 1000, cc.velocity.z * 1000]);
      out.push({ id: d.id, d, dist, ...st });
    }
    out.sort((a, b) => a.dist - b.dist);
    if (out.length > PAIR_SETUP.MAX_PIECES) out.length = PAIR_SETUP.MAX_PIECES;
    return out;
  }

  /** The planner input and the pair-rule test for a context and its pieces. */
  _input(ctx, pieces, windows) {
    const PS = Constants.PAIR_SHOT;
    const env = { solvePairAimAll: this._env.solvePairAimAll, pairTethersCross: this._env.pairTethersCross, pairAttitudeFor: this._env.pairAttitudeFor,
      pairLineBlockedAt: (alpha) => typeof ctx.am.pairLineBlockedAt === 'function' && ctx.am.pairLineBlockedAt(ctx.armA, ctx.armB, alpha) };
    const planMaxDeg = ctx.ap._pairPlaneMax();
    return {
      n: ctx.n, a: ctx.a, massKg: ctx.mass * ctx.cons, ve: ctx.ve, pieces, reachM: ctx.reachM, launchSpeed: Math.min(ctx.speedA, ctx.speedB),
      homeGapS: PS.HOME_GAP_S ?? 30, windows, z0: ctx.z0,
      verdictAt: (rA, rB) => pairVerdict(env, ctx.g, ctx.Rb, rA, rB, { planMaxDeg, type: ctx.type, speedA: ctx.speedA, speedB: ctx.speedB }).ok,
      verdict: (c) => pairVerdict(env, ctx.g, ctx.Rb, c.rA, c.rB, { planMaxDeg, type: ctx.type, speedA: ctx.speedA, speedB: ctx.speedB }).ok,
    };
  }

  /** The look as a generator: it yields between small units of work so no frame carries all of it (`tick` runs it on a time budget). */
  *_look() {
    const ctx = this._context();
    yield;
    if (!ctx) return { offer: null, none: 'no ctx' };
    if (ctx.ap.getPairOffer && ctx.ap.getPairOffer()) return { offer: null, none: 'pair offered' };
    const pieces = this._pieces(ctx);
    yield;
    if (pieces.length < 2) return { offer: null, none: 'pieces' };
    const inp = this._input(ctx, pieces);
    const goals = [];
    for (const T of PAIR_SETUP.WINDOWS_S) yield* screenWindowGen(inp, T, goals);
    goals.sort((p, q) => p.dvImp - q.dvImp);
    const pass = [];
    let tried = 0;
    const dvLeft = ctx.ap._getRemainingDeltaV();
    for (const g of goals) {
      if (tried >= 200 || pass.length >= 3) break;
      tried++;
      const c = finishGoal(inp, g);
      // a pair the rule already offers from where she is needs no burn: the player's own pick shows it
      if (c && c.arcs.dv * 1.5 < dvLeft && inp.verdict(c) && !inp.verdictAt(pieces[c.i].pos, pieces[c.j].pos)) pass.push(c);
      yield;
    }
    const best = chooseBest(pass);
    if (!best) return { offer: null, none: 'no goal' };
    return { offer: this._mkOffer(ctx, best, pieces) };
  }

  _mkOffer(ctx, c, pieces) {
    const pa = pieces[c.i], pb = pieces[c.j];
    return { key: `${pa.id}+${pb.id}`, idA: pa.id, idB: pb.id, pieceA: pa.d, pieceB: pb.d, T: c.T, gasG: c.gasG, dvCms: 100 * c.arcs.dv,
      labelA: pieceLabel(pa.d, pa.dist), labelB: pieceLabel(pb.d, pb.dist),
      endRangeA: c.endRangeA, endRangeB: c.endRangeB, armA: ctx.armA, armB: ctx.armB, type: ctx.type, plan: c, atClock: this._clock };
  }

  /** @param {number} dt real s @param {number} dtWorld game s (> 0) */
  tick(dt, dtWorld) {
    this._clock += dtWorld;
    if (this._burn) { this._tickBurn(dt, dtWorld); return; }
    this._maybeSay();
    this._lookClock += dt;
    if (!this._gen && this._lookClock >= PAIR_SETUP.LOOK_S) { this._lookClock = 0; this._gen = this._look(); }
    if (!this._gen) return;
    const t0 = this._now();
    let r;
    do { r = this._gen.next(); } while (!r.done && this._now() - t0 < 3);
    if (!r.done) return;
    this._gen = null;
    this._setOffer(r.value && r.value.offer ? r.value.offer : null);
  }

  /** @private keep the offer steady: a look that finds nothing drops it only on the second miss; the line is said once per pair. */
  _setOffer(next) {
    if (!next) {
      this._offerMisses++;
      if (this._offerMisses >= 2) this._offer = null;
      return;
    }
    this._offerMisses = 0;
    const cur = this._offer;
    if (cur && cur.key !== next.key && cur.gasG < next.gasG * 1.25 && this._stillOk(cur)) return;   // a standing offer stays unless clearly beaten
    this._offer = next;
    this._maybeSay();
  }

  /** @private say the standing offer once: not again for the same pair within SAY_AGAIN_S, never within SAY_GAP_S of another line. */
  _maybeSay() {
    const o = this._offer;
    if (!o || o.said) return;
    const at = this._said.get(o.key);
    if (at !== undefined && this._clock - at <= PAIR_SETUP.SAY_AGAIN_S) { o.said = true; return; }
    if (this._lastSaid !== undefined && this._clock - this._lastSaid < PAIR_SETUP.SAY_GAP_S) return;      // the line waits; the offer stands
    o.said = true;
    this._said.set(o.key, this._clock);
    this._lastSaid = this._clock;
    eventBus.emit(Events.COMMS_MESSAGE, { text: setupOfferLine(o), priority: 'info', source: 'HOUSTON', _keep: true });
  }

  _stillOk(o) { return !!o && this._ap._pairPieceOk(o.pieceA) && this._ap._pairPieceOk(o.pieceB) && !o.pieceA._captured && !o.pieceB._captured; }

  /**
   * The accept key / tap: plan the offered pair afresh (the geometry has moved since the look) and start the burn.
   * @returns {boolean} true when the burn started
   */
  accept() {
    const o = this._offer;
    if (this._burn) return false;
    if (!o) { eventBus.emit(Events.COMMS_MESSAGE, { text: setupNoneLine(), priority: 'info', source: 'HOUSTON' }); return false; }
    const plan = this._planPair(o.idA, o.idB, PAIR_SETUP.WINDOWS_S);
    if (!plan) {
      this._offer = null;
      eventBus.emit(Events.COMMS_MESSAGE, { text: setupRefusedLine('the pieces have moved out of line; a new setup is offered if one fits'), priority: 'info', source: 'HOUSTON' });
      return false;
    }
    const { ctx, c, pieces } = plan;
    const so = this._mkOffer(ctx, c, pieces);
    this._burn = { key: so.key, idA: so.idA, idB: so.idB, pieceA: so.pieceA, pieceB: so.pieceB, labelA: so.labelA, labelB: so.labelB, armA: ctx.armA, armB: ctx.armB, type: ctx.type,
      T: c.T, t: 0, arcs: c.arcs, gas0G: c.gasG, planGasG: c.gasG, nextReplan: PAIR_SETUP.REPLAN_S, refused: 0, dvApplied: 0, replans: 0,
      startClock: this._clock, startMs: this._now(), thrusting: false, off: c.off, s: c.s, dvPlanned: c.arcs.dv, rangeA: c.endRangeA, rangeB: c.endRangeB };
    this._offer = null;
    this._mark = null;
    eventBus.emit(Events.COMMS_MESSAGE, { text: setupStartLine(so), priority: 'info', source: 'HOUSTON', _keep: true });
    return true;
  }

  /** Plan one named pair of pieces afresh: the cheapest goal the pair rule accepts. @returns {{ctx:object, c:object, pieces:object[]}|null} */
  _planPair(idA, idB, windows) {
    const ctx = this._context();
    if (!ctx) return null;
    const pieces = this._pieces(ctx, [idA, idB]);
    if (pieces.length < 2) return null;
    const inp = this._input(ctx, pieces, windows);
    inp.maxPass = 6; inp.maxTry = 200;
    const found = planPairSetups(inp);
    const c = chooseBest(found);
    return c ? { ctx, c, pieces } : null;
  }

  /** @private one frame of the burn */
  _tickBurn(dt, dtWorld) {
    const b = this._burn, ap = this._ap, p = ap._player, am = ap._armManager;
    // things that end it
    if (!p || p.safeMode || ap._engaged || ap._tripHold) return this._abort('the autopilot or a trip took over');
    // the player's own thrust (the ship's manual-thrust accumulator, read before `player.update` applies and zeroes it) ends the burn
    const ti = p.thrustInput;
    if (ti && Math.hypot(ti.x, ti.y, ti.z) > 1e-12) return this._abort('you took the thrusters');
    if (am && Array.isArray(am.arms) && am.arms.some((a) => a && !IDLE_ARM.has(a.state))) return this._abort('a daughter went out');
    if (!ap._pairPieceOk(b.pieceA) || !ap._pairPieceOk(b.pieceB) || b.pieceA._captured || b.pieceB._captured) return this._abort('one of the two pieces is gone');
    const t0 = b.t, t1 = b.t + dtWorld;
    // the thrust inside this frame: arc 1 on [0, tau1], arc 2 on [T - tau2, T] (a frame may end the window: it is cut there)
    const ctx = b.ctxLast = this._burnContext();
    if (!ctx) return this._abort('the engine cannot burn');
    const ov = (a0, a1) => Math.max(0, Math.min(t1, a1) - Math.max(t0, a0));
    const l1 = ov(0, b.arcs.tau1), l2 = ov(b.T - b.arcs.tau2, b.T);
    let dvx = 0, dvy = 0, dvz = 0;
    for (const [len, u] of [[l1, b.arcs.u1], [l2, b.arcs.u2]]) {
      if (!(len > 0)) continue;
      const w = ctx.L.toWorld(u);
      const k = ctx.aCmd * len;
      dvx += w[0] * k; dvy += w[1] * k; dvz += w[2] * k;
    }
    b.t = t1;
    b.thrusting = (l1 + l2) > 0;
    if (b.thrusting) {
      const ok = p.applyCartesianImpulse(_v3(dvx, dvy, dvz), dt, { continuous: true });
      if (ok) { b.dvApplied += Math.hypot(dvx, dvy, dvz) * ctx.ts; b.refused = 0; } else if (++b.refused > 1800) return this._abort('the engine would not fire');
    }
    if (b.t >= b.T) return this._arrive();
    if (b.t >= b.nextReplan) this._replan();
  }

  /** @private the frame and engine numbers of the burn, from her live state */
  _burnContext() {
    const p = this._ap._player;
    if (!p || !p._cartesian || !p.orbit) return null;
    const MPS = 1 / Constants.SCENE_UNITS_PER_METER, c = p._cartesian;
    const rM = [c.position.x * MPS, c.position.y * MPS, c.position.z * MPS], vM = [c.velocity.x * 1000, c.velocity.y * 1000, c.velocity.z * 1000];
    const L = lvlhFrame(rM, vM, p.orbit.meanMotion);
    const ts = typeof p.getThrustScale === 'function' && p.getThrustScale() > 0 ? p.getThrustScale() : 1;
    return { L, ts, aCmd: Constants.TRIP.XENON_THRUST_N / (p.mass > 1 ? p.mass : 291) };
  }

  /** @private look again from where she is: the pieces' own drift (and their drag) moved the goal */
  _replan() {
    const b = this._burn;
    b.nextReplan = b.t + PAIR_SETUP.REPLAN_S;
    const left = b.T - b.t;
    if (left < PAIR_SETUP.REPLAN_END_S) return;
    const ctx = this._context(true);
    const plan = ctx ? this._planPairIn(ctx, b.idA, b.idB, left) : null;
    if (!plan) { b.noPlan = (b.noPlan || 0) + 1; if (b.noPlan >= 3) this._abort('the two pieces drifted out of line'); return; }
    b.noPlan = 0;
    if (plan.c.gasG > PAIR_SETUP.ABORT_COST_X * Math.max(b.gas0G, 0.05)) { this._abort('the pieces drifted and the setup now costs too much gas'); return; }
    b.arcs = plan.c.arcs; b.T = left; b.t = 0; b.nextReplan = PAIR_SETUP.REPLAN_S; b.planGasG = plan.c.gasG; b.replans++;
  }

  _planPairIn(ctx, idA, idB, T) {
    const pieces = this._pieces(ctx, [idA, idB]);
    if (pieces.length < 2) return null;
    const inp = this._input(ctx, pieces, [T]);
    inp.maxPass = 6; inp.maxTry = 200;
    const c = chooseBest(planPairSetups(inp));
    return c ? { c, pieces } : null;
  }

  _abort(why) {
    const b = this._burn;
    this._lastBurn = { ok: false, why, ...(b ? { key: b.key, t: b.t, dvApplied: b.dvApplied } : {}) };
    this._burn = null;
    this._offer = null;
    this._lookClock = 0;
    eventBus.emit(Events.COMMS_MESSAGE, { text: setupAbortLine(why), priority: 'info', source: 'HOUSTON', _keep: true });
  }

  /** @private does the game's own pair rule accept the two pieces from where she is NOW? Also their labels with today's distances.
   * `ok` is false when it cannot be asked. */
  _arrivalNow(b) {
    const ctx = this._context();
    if (!ctx) return { ok: false };
    const pieces = this._pieces(ctx, [b.idA, b.idB]);
    if (pieces.length < 2) return { ok: false };
    const pa = pieces.find((x) => x.id === b.idA) || pieces[0], pb = pieces.find((x) => x.id === b.idB) || pieces[1];
    return { ok: !!this._input(ctx, pieces).verdictAt(pa.pos, pb.pos), labelA: pieceLabel(pa.d, pa.dist), labelB: pieceLabel(pb.d, pb.dist) };
  }

  _arrive() {
    const b = this._burn;
    const now = this._arrivalNow(b), inPosition = now.ok;
    this._lastBurn = { ok: true, inPosition, key: b.key, replans: b.replans, dvApplied: b.dvApplied, dvPlanned: b.dvPlanned, gas0G: b.gas0G, rangeA: b.rangeA, rangeB: b.rangeB, clock: this._clock - b.startClock };
    this._burn = null;
    this._offer = null;
    this._lookClock = 0;
    this._said.set(b.key, this._clock);
    if (!inPosition) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: setupShortLine(), priority: 'info', source: 'HOUSTON', _keep: true });
      return;
    }
    // Hand her the existing pair offer's two inputs, as the player would: a daughter of the pair and piece A as the target;
    // piece B is marked through the reticle's own PAIR mark (`getMarkPiece`).
    const ap = this._ap, am = ap._armManager, ts = ap._targetSelector;
    if (am && typeof am.getSelectedArm === 'function' && typeof am.selectArm === 'function') {
      const sel = am.getSelectedArm();
      if (sel !== b.armA && sel !== b.armB) am.selectArm(b.armA.index, { quiet: true });
    }
    if (ts && typeof ts.setTarget === 'function') { ts.setTarget(b.pieceA); this._mark = { pieceA: b.pieceA, pieceB: b.pieceB }; }
    eventBus.emit(Events.COMMS_MESSAGE, { text: setupArriveLine(now), priority: 'info', source: 'HOUSTON', _keep: true });
  }
}

const _dv = new THREE.Vector3();
function _v3(x, y, z) { return _dv.set(x, y, z); }
