/**
 * PieceClaim - launch interlocks (owner 2026-10-22; archive/research/2026-10-launch-interlocks.md).
 *
 * One rule, "a piece has one owner". `pieceClaim(piece, world)` answers who owns a piece right now:
 *   - a daughter flying to it (LAUNCHING, TRANSIT, APPROACH),
 *   - a daughter holding it (STATION_KEEP: her tool is the player's N) or working it (net out, grapple closing),
 *   - a daughter waiting to launch for it (docked, strut aiming / launch line gate: the ~8-10 s ceremony),
 *   - a mother net or the small net (lasso) flying at it,
 *   - a catch already held (flagged captured / pinned, or a daughter carrying it);
 *   else free.
 * The pure line helpers live here too: `linesCross` (two daughter lines swap sides) and `lineWrapsShip` (a daughter's
 * line runs through the hull, read off the ship keep-out passed in). The player's words for each refusal are built
 * here, so every caller (keys, tests, touch) says the same thing.
 *
 * Imports only core modules (as TransferTrip.js does), so ArmManager, ArmUnit, InputManager, LassoSystem and
 * AutopilotSystem can call it without an import cycle. Everything else is passed in.
 *
 * Player text rule (owner 2026-10-20): lead with what to do, then why; no "can't" / "no" / "not" where a positive
 * wording exists. Daughter names are the ones the game prints ("Small 1", "Large 2").
 *
 * @module systems/PieceClaim
 */

import { Constants } from '../core/Constants.js';
// Leaf module (imports nothing), so no cycle; every line below that names a key reads the glass flag when it is built.
import { GestureHints } from '../ui/hud/GestureHints.js';
import { degToRad } from '../core/MathUtil.js';

const S = Constants.ARM_STATES;

export const CLAIM = Object.freeze({
  FREE: 'free',
  FLYING: 'flying',     // a daughter is flying to it (launch, transit, final approach)
  HOLDING: 'holding',   // a daughter is station-keeping at it: her tool is the player's N
  WORKING: 'working',   // a daughter's net is out / her grapple is closing
  WAITING: 'waiting',   // a daughter is lining up a launch at it (still docked)
  NET: 'net',           // a mother net or the small net (lasso) is on its way to it
  CAUGHT: 'caught',     // already caught (net, lasso, daughter rack, tip bag, hand-off)
});

const FREE_CLAIM = Object.freeze({ kind: CLAIM.FREE, arm: null, armIndex: -1 });

const FLYING_STATES = new Set([S.UNDOCKING, S.LAUNCHING, S.TRANSIT, S.APPROACH]);
const HOLDING_STATES = new Set([S.STATION_KEEP]);
const WORKING_STATES = new Set([S.NETTING, S.MAGNETIC_GRAPPLE, S.GRIPPER_GRAPPLE, S.PAD_CONTACT]);

/** Net states in which the net is still on its way to the piece (not yet caught or given up). */
const NET_FLYING_STATES = new Set(['LAUNCHING', 'SPINNING_UP', 'FLIGHT', 'CONTACT', 'BRAKE', 'ENVELOP', 'CINCH_CLOSING', 'SECURE_CHECK']);

/** Identical object, or the same id (a Tab-selected snapshot vs the field's live object). */
export function samePiece(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.id !== undefined && a.id !== null && a.id === b.id;
}

/** Already caught, or gone. */
export function pieceIsCaught(piece) {
  return !!piece && (piece._captured === true || piece._armPinned === true || !!piece._capturedByArm);
}

/**
 * Who owns `piece`.
 * @param {object|null} piece a debris object (`id`, optional `_captured` / `_armPinned` / `_capturedByArm`)
 * @param {{arms?: object[], pending?: (Map|Set|null), nets?: object[], lasso?: (object|null)}} world
 *   `arms`: the daughters (array index = launch index), `pending`: the launches the keep-out gate holds
 *   (ArmManager._pendingLaunches), `nets`: CaptureNetSystem.activeNets, `lasso`: LassoSystem.
 * @param {{exceptArm?: object|null}} [opts] `exceptArm`: ignore this daughter (her own claim is not a conflict for her)
 * @returns {{kind: string, arm: (object|null), armIndex: number}}
 */
export function pieceClaim(piece, world, opts) {
  if (!piece || !world) return FREE_CLAIM;
  const except = (opts && opts.exceptArm) || null;
  const arms = Array.isArray(world.arms) ? world.arms : [];

  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    if (!a || a === except) continue;
    const st = a.state;
    if (st === S.DOCKED) {
      // Waiting to launch: the claim target is set at the launch request and counts only while her reservation lives
      const live = a._aimReserved === true || (world.pending && typeof world.pending.has === 'function' && world.pending.has(i));
      if (live && samePiece(a._claimTarget, piece)) return { kind: CLAIM.WAITING, arm: a, armIndex: i };
      continue;
    }
    const mine = samePiece(a.target, piece) || samePiece(a._stationKeepTarget, piece);
    if (!mine) continue;
    if (FLYING_STATES.has(st)) return { kind: CLAIM.FLYING, arm: a, armIndex: i };
    if (HOLDING_STATES.has(st)) return { kind: CLAIM.HOLDING, arm: a, armIndex: i };
    if (WORKING_STATES.has(st)) return { kind: CLAIM.WORKING, arm: a, armIndex: i };
  }

  const nets = Array.isArray(world.nets) ? world.nets : [];
  for (const n of nets) {
    if (!n || !samePiece(n.targetDebris, piece)) continue;
    if (n.podIndex === undefined || n.podIndex < 0) continue;       // a daughter's own net: she owns the piece (above)
    if (n.isActive === false) continue;
    if (NET_FLYING_STATES.has(n.state)) return { kind: CLAIM.NET, arm: null, armIndex: -1 };
  }
  const ls = world.lasso;
  if (ls && ls.active === true && samePiece(ls.target, piece) && !pieceIsCaught(piece)) {
    return { kind: CLAIM.NET, arm: null, armIndex: -1 };
  }

  if (pieceIsCaught(piece)) {
    // A catch on a daughter's rack is hers: name her
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      if (!a || a === except) continue;
      if (samePiece(a.capturedDebris, piece) || (Array.isArray(a.heldCatches) && a.heldCatches.some((h) => samePiece(h, piece)))) {
        return { kind: CLAIM.CAUGHT, arm: a, armIndex: i };
      }
    }
    return { kind: CLAIM.CAUGHT, arm: null, armIndex: -1 };
  }
  return FREE_CLAIM;
}

export function isFree(claim) {
  return !claim || claim.kind === CLAIM.FREE;
}

/** Is a mother net (or the small net) still FLYING, not yet caught or reeling a catch in? Gives the true reason the ship holds still. */
export function netIsOut(world) {
  if (!world) return false;
  const nets = Array.isArray(world.nets) ? world.nets : [];
  for (const n of nets) {
    if (!n || n.isActive === false) continue;
    if (n.podIndex === undefined || n.podIndex < 0) continue;
    if (NET_FLYING_STATES.has(n.state)) return true;
  }
  const ls = world.lasso;
  return !!(ls && ls.active === true && ls._reelingIn !== true);
}

/**
 * A touch player has no Tab: picking another piece is a tap on it (the words chipPhrase uses for "Press T for next
 * target"), so "Tab to ..." says "Tap ..." on glass. The "Press N / D / S / R" parts stay: CommsSystem runs every line
 * through `GestureHints.chipPhrase`, which turns them into the chip names.
 */
const forInput = (desktop, glass) => (GestureHints.isGlass() ? glass : desktop);

const nameOf = (claim) => (claim && claim.arm && claim.arm.displayName) || 'A daughter';

/** The plain word for the tool N would work for this daughter; null when unknown (the line then says "tool"). */
const TOOL_WORD = { NET: 'net', PAD: 'pad', MAGNET: 'magnet', GRIPPER: 'gripper' };
export function toolWord(arm) {
  return (arm && TOOL_WORD[arm.selectedTool]) || null;
}

/**
 * The line for a DAUGHTER launch (D, Shift+D, Shift+A, the number keys) at an owned piece; null for a free piece.
 * A daughter who HOLDS the piece names the tool N would work for her.
 * @param {{kind:string, arm:object|null}} claim from `pieceClaim`
 */
export function launchRefusalLine(claim) {
  if (!claim) return null;
  const who = nameOf(claim);
  switch (claim.kind) {
    case CLAIM.HOLDING: return `Press N to work ${who}'s ${toolWord(claim.arm) || 'tool'}, or ${forInput('Tab to the next piece', 'tap another piece')}: she has this one.`;
    case CLAIM.FLYING: return `${forInput('Tab to the next piece', 'Tap another piece')}, or press R to bring ${who} home: she is flying to this one.`;
    case CLAIM.WORKING: return `${forInput('Tab to the next piece', 'Tap another piece')}: ${who} is working this one.`;
    case CLAIM.WAITING: return `${forInput('Tab to the next piece', 'Tap another piece')}: ${who} is lining up a launch at this one.`;
    case CLAIM.NET: return 'Pick another piece: a net is on its way to that one.';
    case CLAIM.CAUGHT: return 'Pick another piece: that one is already caught.';
    default: return null;
  }
}

/**
 * The line for a NET (N, the small net / lasso, the large net) at an owned piece; null for a free piece.
 * (N normally works a HOLDING daughter's tool before it gets here.)
 */
export function netRefusalLine(claim) {
  if (!claim) return null;
  const who = nameOf(claim);
  switch (claim.kind) {
    case CLAIM.FLYING: return `Pick another piece, or press R to bring ${who} home: she is flying to that one.`;
    case CLAIM.HOLDING: return `Pick another piece: ${who} has that one.`;
    case CLAIM.WORKING: return `Pick another piece: ${who} is working that one.`;
    case CLAIM.WAITING: return `Pick another piece: ${who} is lining up a launch at that one.`;
    case CLAIM.NET: return 'Pick another piece: a net is on its way to that one.';
    case CLAIM.CAUGHT: return 'Pick another piece: that one is already caught.';
    default: return null;
  }
}

const WHY_PIECE = { gone: 'her piece is gone', caught: 'her piece is caught already', taken: 'her piece is taken already' };

/** A daughter flying to a piece that was caught or lost turns round. `why`: 'gone' | 'caught' | 'taken'. */
export function pieceLostLine(who, why) {
  return `${who} coming home: ${WHY_PIECE[why] || WHY_PIECE.caught}.`;
}

/** A launch that waited to fire finds its piece taken at the spring: she stays docked. */
export function launchDroppedLine(who, why) {
  return `${who} stays docked: ${WHY_PIECE[why] || WHY_PIECE.caught}. ${forInput('Tab to the next piece', 'Tap another piece')}, then press D.`;
}

/** At the spring: the ship has turned since the strut was picked and her line would now cross another daughter's. */
export function launchCrossDroppedLine(who, otherWho) {
  return `${who} stays docked: her line would cross ${otherWho}'s. ${forInput('Tab to another piece', 'Tap another piece')}, then press D.`;
}

// Pair shot (the Q key; owner 2026-10-25 "2 a"): plain words.

/** A pair is offered: said once per pair. `missDeg`: the larger of the two launch lines' misses, rounded. */
export function pairReadyLine(missDeg) {
  return `Pair shot ready. ${forInput('Press Q', 'Tap PAIR')} to launch both daughters together; each steers the last ${missDeg}° to her own piece.`;
}

/** Q with no pair offered. */
export function pairNoneLine() {
  return `No pair shot is ready. Pick a daughter and a piece first: a second piece is marked when two fit. ${forInput('D', 'SEND DAUGHTER')} launches one daughter alone.`;
}

/** A daughter's catch is in its cell and her partner's is not yet: she waits so both reel in together (said once per pair). */
export function pairHoldLine() {
  return 'Holding the catch so both daughters reel in together.';
}

/** The pair needs the ship free to turn (a daughter out on her line, a launch under way ...). */
export function pairNeedsTurnLine(reason) {
  return `Pair shot held: ${reason}. ${forInput('D', 'SEND DAUGHTER')} launches one daughter alone.`;
}

/** A daughter of the pair is not ready (not docked, spring not charged, no fuel). */
export function pairNotReadyLine(who) {
  return `Pair shot held: ${who} is not ready. Neither daughter left.`;
}

/** At the spring one of the two pieces was caught, lost or taken: neither daughter leaves. */
export function pairDroppedLine(who, why) {
  return `Pair shot cancelled: ${who}'s ${(WHY_PIECE[why] || WHY_PIECE.caught).replace(/^her piece/, 'piece')}. Neither daughter left.`;
}

/** A launch line is blocked by part of the ship: neither leaves, the strut angles stay as they are. */
export function pairHeldLine(who, part) {
  return `Pair shot held: ${part} is in the way of ${who}'s line. Neither daughter left.`;
}

/** A piece drifted out of a daughter's reach while the ship turned (checked at the spring, for both). */
export function pairRangeLine(who, distM, maxM) {
  return `Pair shot cancelled: ${who}'s piece is ${Math.round(distM)} m away, past her ${Math.round(maxM)} m reach. Neither daughter left.`;
}

/** A check inside the pair launch failed (a fault, not a refusal): neither daughter leaves. */
export function pairErrorLine() {
  return 'Pair shot cancelled: the launch check failed. Neither daughter left.';
}

/** The pieces drifted off the two lines while the ship turned. */
export function pairDriftLine(missA, missB) {
  return `Pair shot cancelled: the pieces have drifted ${Math.round(Math.max(missA, missB))}° off the lines. Neither daughter left.`;
}

/** The two tethers would swap sides on the way. */
export function pairCrossLine() {
  return 'Pair shot cancelled: the two tethers would cross. Neither daughter left.';
}

/** A strut did not reach its angle (or a hinge is locked). */
export function pairStrutLine(who) {
  return `Pair shot cancelled: ${who}'s strut is not at its angle. Neither daughter left.`;
}

/**
 * The number key picked a strut whose line would cross another daughter's, and a clear one exists.
 * On glass there are no number keys: a daughter is picked by a tap on her row in DAUGHTERS and sent with the
 * SEND DAUGHTER chip (GestureHints Digit1-4 / CHIP_LABELS.D), so a glass player is told that (`glassName`: her name).
 * @param {number} clearStrutNumber 1-4
 * @param {string} otherWho the daughter whose line would be crossed
 * @param {string|null} [glassName] the clear daughter's name when the player is on glass, else null
 */
export function crossNamedStrutLine(clearStrutNumber, otherWho, glassName) {
  if (glassName) return `Tap ${glassName} in DAUGHTERS, then SEND DAUGHTER: her line stays clear of ${otherWho}'s.`;
  return `Press ${clearStrutNumber}, then D: strut ${clearStrutNumber}'s line stays clear of ${otherWho}'s.`;
}

/** Every free strut's line would cross. */
export function crossNoneClearLine(otherWho) {
  return `Press R to bring ${otherWho} home first: every free strut's line would cross hers.`;
}

/** A mother turn for a net would wrap a daughter's line round the ship. */
export function wrapRefusalLine(who) {
  return `Press R to bring ${who} home, or pick a piece in front: her line would wrap the ship.`;
}

/**
 * The true reason each group of daughters stayed docked after a send. Built by `ArmManager._whyStayed`; every count
 * is a number of DAUGHTERS, and they add up to `stayed`.
 * @typedef {object} StayWhy
 * @property {number} ranOut   no free piece was left for her (more daughters than pieces)
 * @property {number} cross    every piece she reaches would take her line across a line already out
 * @property {string[]} crossWho  the daughters whose lines are in the way (names the game prints)
 * @property {number} reach    every piece left is past her tether
 * @property {number} heavy    every piece left is heavier than she holds
 * @property {number} [other]   she reaches and holds a piece on a clear line, but was not sent (a reason already said)
 * @property {boolean} [reachSeen] some stayed daughter has a piece left that is past her tether (whatever group she is in)
 * @property {boolean} [heavySeen] some stayed daughter has a piece left that is heavier than she holds
 */
const stayVerb = (n) => (n === 1 ? '1 stays' : `${n} stay`);
const possessives = (names) => {
  const p = (names || []).map((n) => `${n}'s`);
  if (p.length === 0) return 'the lines already out';
  return p.length === 1 ? p[0] : `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
};

/** The sentences saying why daughters stayed docked, one per group with members; '' when none stayed. Positive words, the way out in each. */
export function stayedLine(why) {
  if (!why) return '';
  const parts = [];
  if (why.ranOut > 0) parts.push(`${stayVerb(why.ranOut)} docked, ready for the next free piece.`);
  if (why.cross > 0) {
    const one = why.cross === 1;
    const homer = (why.crossWho || []).length > 1 ? 'them' : 'her';
    parts.push(`${stayVerb(why.cross)} docked so ${one ? 'her line stays' : 'their lines stay'} clear of ${possessives(why.crossWho)}. `
      + `Press R to bring ${homer} home and free ${one ? 'her' : 'them'}.`);
  }
  if (why.reach > 0) parts.push(`${stayVerb(why.reach)} docked: the pieces left are out of ${why.reach === 1 ? 'her' : 'their'} reach. ${forInput('Tab to a nearer piece', 'Tap a nearer piece')}.`);
  if (why.heavy > 0) parts.push(`${stayVerb(why.heavy)} docked: the pieces left are too heavy for ${why.heavy === 1 ? 'her' : 'them'}. ${forInput('Tab to a lighter piece', 'Tap a lighter piece')}.`);
  return parts.join(' ');
}

/**
 * How many daughters a one-per-piece send put out, and why the rest stayed docked.
 * Without `why` every stayed daughter counts as "no free piece left".
 */
export function fanOutLine(sent, stayed, why) {
  const head = sent === 1 ? '1 daughter sent.' : `${sent} daughters sent, one per piece.`;
  if (!(stayed > 0)) return head;
  const tail = stayedLine(why || { ranOut: stayed, cross: 0, crossWho: [], reach: 0, heavy: 0 });
  return tail ? `${head} ${tail}` : head;
}

/** A one-per-piece send found no free piece (every one has a daughter, a net or a catch). */
export const FAN_OUT_NONE_LINE = 'Tab to a free piece: every piece in reach already has a daughter or a net.';

/** The same line as the player reads it (glass: a tap, not Tab). */
export function fanOutNoneText() {
  return forInput(FAN_OUT_NONE_LINE, FAN_OUT_NONE_LINE.replace('Tab to a free piece', 'Tap a free piece'));
}

/** The lasso's auto-aim found every piece in lasso range taken: `fanOutNoneText`'s wording for the lasso's range. */
export function lassoRangeAllOwnedLine() {
  return forInput('Tab to a free piece: every piece in lasso range already has a daughter or a net.',
    'Tap a free piece: every piece in lasso range already has a daughter or a net.');
}

/**
 * The player steered while the ship turned for the net, so the daughters stay docked.
 * Glass has no Shift+A: send from the DAUGHTERS row with the SEND DAUGHTER chip.
 */
export function daughtersHeldBackLine() {
  return GestureHints.isGlass()
    ? 'Daughters held back while you steer. Tap a daughter in DAUGHTERS, then SEND DAUGHTER.'
    : 'Daughters held back while you steer. Press Shift+A to send them.';
}

/** Nobody was sent: every free piece is past the docked daughters' tethers. `pieces`: how many were left. */
export function reachNoneLine(pieces = 1) {
  return `${forInput('Tab to a nearer piece', 'Tap a nearer piece')}: ${pieces === 1 ? 'that one is' : 'those are'} out of the free daughters' reach.`;
}

/** Nobody was sent: every free piece is heavier than the docked daughters hold. */
export function heavyNoneLine(pieces = 1) {
  return `${forInput('Tab to a lighter piece', 'Tap a lighter piece')}: ${pieces === 1 ? 'that one is' : 'those are'} too heavy for the free daughters.`;
}

/** Nobody was sent: some free pieces are past the free daughters' tethers and the others are heavier than they hold. */
export function reachHeavyNoneLine() {
  return `${forInput('Tab to another piece', 'Tap another piece')}: the pieces left are out of the free daughters' reach or too heavy for them.`;
}

/** A daughter stayed for a reason already said (her launch was refused with its own line): only the way on is added. */
export function otherNoneLine() {
  return `${forInput('Tab to another piece', 'Tap another piece')}, then press D.`;
}

/**
 * The line for a one-per-piece send (Shift+D, Shift+N, Shift+A) that put NOBODY out although a daughter was ready:
 * the true reason, in this order - a crossing line (name the way out), pieces out of reach and/or too heavy (both
 * named when both are present), a daughter who stayed for another reason (no claim about owners), else every
 * piece already has an owner (the one case that claim is true: `ranOut`, no free piece left).
 * @param {StayWhy & {left?: number}} why `left`: how many free pieces were still on the list (default 1)
 */
export function fanOutNoneLine(why) {
  if (why && why.cross > 0) return crossNoneClearLine((why.crossWho && why.crossWho[0]) || 'a daughter');
  const left = (why && why.left) || 1;
  const reach = !!why && (why.reachSeen !== undefined ? why.reachSeen : why.reach > 0);
  const heavy = !!why && (why.heavySeen !== undefined ? why.heavySeen : why.heavy > 0);
  if (reach && heavy) return reachHeavyNoneLine();
  if (reach) return reachNoneLine(left);
  if (heavy) return heavyNoneLine(left);
  if (why && why.other > 0) return otherNoneLine();
  return fanOutNoneText();
}

/** Shift+A before a scan. */
export const SCAN_FIRST_LINE = 'Press S to scan first, then try again.';

/** Shift+A with every piece past net reach: daughters only, no net. */
export const DAUGHTERS_ONLY_LINE = 'Daughters only: every piece is past net reach.';

/** The true reason the ship holds still while the arm aims. */
export function holdsStillLine(reason) {
  const why = reason === 'a catch is being reeled in' ? 'a catch is reeling in' : reason;
  return `Aiming the arm only: ${why}, so the ship holds still.`;
}

// Geometry: pure; plain arrays or {x,y,z}; one common frame, metres.

const v3 = (p) => (Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };

/**
 * How far short of a full swap two lines still count as crossing, in degrees. The strict test (below) judges the lines
 * at ONE moment, the press; the real lines then move: the ship turns a further 20-25 degrees while the second daughter
 * flies, the daughters drift, and the near-end offset is only ~1 m (two struts), so its direction turns with the ship.
 * Measured in the real game (12 strut pairs, archive/research/2026-10-launch-interlocks.md "Phase 2 built"): at the press
 * the strict test said clear for 4 of the 8 pairs that later crossed (offset directions 75-86 degrees apart, not yet
 * past 90). With this margin the offset directions must be less than 90 - 30 = 60 degrees apart to count as clear: all 8
 * are flagged (at least 15 degrees to spare) and one measured-clear pair, strut 2 then 4 (66 degrees), is flagged too.
 * A false "cross" only makes the pick take another strut; a missed one leaves two lines tangled.
 */
export const CROSS_MARGIN_DEG = 30;

/**
 * Do two lines swap sides, or come within `CROSS_MARGIN_DEG` of swapping? Look along the mean direction of the two
 * lines; the sideways offset of line B from line A at the ship end is `d0`, at the far end `d1`. Strictly they cross when
 * the offset has turned round (`d0 . d1 < 0`, offsets more than 90 degrees apart); here already when the offsets are
 * more than (90 - margin) degrees apart. Two lines that stay on their own sides of each other never touch.
 * @param {{a: (number[]|{x,y,z}), b: (number[]|{x,y,z})}} A line from the ship end `a` to the far end `b`
 * @param {{a: (number[]|{x,y,z}), b: (number[]|{x,y,z})}} B
 * @param {{marginDeg?: number}} [opts] `marginDeg: 0` is the strict side-swap test
 * @returns {boolean}
 */
export function linesCross(A, B, opts) {
  const Aa = v3(A.a), Ab = v3(A.b), Ba = v3(B.a), Bb = v3(B.b);
  const nHat = unit(add(sub(Ab, Aa), sub(Bb, Ba)));
  if (len(nHat) < 1e-9) return false;
  const lat = (v) => sub(v, scale(nHat, dot(v, nHat)));
  const d0 = lat(sub(Ba, Aa));
  const d1 = lat(sub(Bb, Ab));
  const m = opts && opts.marginDeg !== undefined ? opts.marginDeg : CROSS_MARGIN_DEG;
  const l0 = len(d0), l1 = len(d1);
  if (!(l0 > 1e-9) || !(l1 > 1e-9)) return dot(d0, d1) < 0;
  return dot(d0, d1) < Math.sin(degToRad(m)) * l0 * l1;
}

/**
 * Does this daughter's line run through the ship? Reads the ship keep-out: the first 30 m of the line from just off her
 * strut tip, a 3 cm radius (measured: through the radiator strut bracket at 128 deg of turn, through the barrel from
 * 131 deg). The caller passes the keep-out in so this module imports no entity.
 * @param {{a: (number[]|{x,y,z}), b: (number[]|{x,y,z})}} line SHIP frame, metres: `a` her tether anchor on the strut, `b` her far end
 * @param {{segment: function}|null} keepOut `ArmManager.getKeepOut()`; null (a mock ship) answers "no"
 * @param {{ignore?: string[]}} [opts] parts of her own that never count (`dau<i>`, `strut<i>`, `rack catch <i>`)
 * @returns {{wraps: boolean, part: string, cat: string, name: string}}
 */
export function lineWrapsShip(line, keepOut, opts) {
  const none = { wraps: false, part: '', cat: '', name: '' };
  if (!keepOut || typeof keepOut.segment !== 'function' || !line) return none;
  const a = v3(line.a), b = v3(line.b);
  const d = sub(b, a);
  const L = len(d);
  if (!(L > 1e-6)) return none;
  const dn = scale(d, 1 / L);
  const start = add(a, scale(dn, 0.05));                 // just off the strut tip
  const end = add(a, scale(dn, Math.min(L, 30)));        // only the first 30 m can touch the ship
  const res = keepOut.segment(start, end, 0.03, { hits: true, ignore: (opts && opts.ignore) || [] });
  const hit = res && res.hits && res.hits.length ? res.hits[0] : null;
  if (!hit) return none;
  return { wraps: true, part: hit.cat + ':' + hit.name, cat: hit.cat, name: hit.name };
}

// Pair lesson and the gas saved (owner 2026-10-26 "1. Mission 2 lesson"): appended at the end of the pair lines.

/** The lesson waits for both daughters of a pair (said once, when the lesson starts with none ready). */
export function pairLessonWaitLine() {
  return 'Waiting for both daughters to be home and charged. Then two pieces get marked for the double shot.';
}

/** The lesson ends without a shot: no pair was offered in time (the daughters were not ready, or no two pieces line up here). */
export function pairLessonSkipLine(ready) {
  return ready
    ? 'No two pieces line up here. Watch for the PAIR mark in later missions.'
    : 'The daughters are not ready for a double shot yet. Watch for the PAIR mark in later missions.';
}

/** After a double shot: the gas used and saved against two single shots. One decimal, "about": both are plans, not meters. */
export function pairSavedLine(xG, yG) {
  return `Double shot: about ${xG.toFixed(1)} g of gas, ${yG.toFixed(1)} g less than two single shots.`;
}

/** The lesson's closing sentence (always said, saved or not). */
export const PAIR_PARK_LINE = 'Park the ship between two pieces to get more double shots.';

/** The lesson, a pair that saved nothing here: plain words, and why. */
export function pairSameLine(xG) {
  return `Double shot: about ${xG.toFixed(1)} g of gas, the same as two singles here: pairs save most when the ship would have to turn.`;
}
