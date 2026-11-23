/**
 * ScanMass — what a scan tells her about a piece's mass (DECISIONS §92 rows 1-2, reality audit M-03).
 *
 * One press of S shows whole satellites, cubesats and rocket stages with their real mass. Fragments and small junk show a
 * RANGE guessed from their size, and every guess contains the true mass; a close look narrows it; a piece she has caught
 * shows its exact mass. The game itself (catch limit, odds, spin hand-over, pay, salvage) keeps reading the true mass:
 * this module only decides what the PLAYER is shown.
 *
 *   far guess    from the piece's type and size alone (the spawn rule makes size follow mass, ±15 % jitter, and the
 *                material is unknown: ×0.5 / ×2). A piece off that rule (an authored training shard, a Kessler shard)
 *                widens the band just enough to hold its mass, by a per-piece fixed amount so the edge never sits at a
 *                fixed ratio to the truth.
 *   close band   a window 1.5× wide whose position is fixed per piece (hashed from its id), intersected with the far guess.
 *
 * Pure: no DOM, no THREE (DebrisField is imported only for its type table and the size jitter).
 */

import { DEBRIS_TYPES, SIZE_JITTER } from '../entities/DebrisField.js';

/** Junk: the breakup populations. Every other type is a whole body. */
const JUNK_TYPES = new Set(['fragment', 'missionDebris']);

/** @param {string} type a debris type @returns {boolean} true for fragments and mission debris (a mass range is shown) */
export function isJunk(type) {
  return JUNK_TYPES.has(type);
}

/**
 * A fixed number in [0, 1) per piece id and salt (FNV-1a plus a final bit mix): stable across frames and saves.
 * @param {string|number} id
 * @param {string} salt a different salt gives an independent number
 * @returns {number}
 */
function hash01(id, salt) {
  const s = `${id}\u0000${salt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The type's mass range read back from a size: its mass-matched mass at that size (the spawn rule, inverted). */
function massForSize(row, x) {
  const sizeSpan = row.sizeMax - row.sizeMin;
  const frac = sizeSpan > 0 ? Math.max(0, (x - row.sizeMin) / sizeSpan) : 0.5;
  return row.massMin + frac * (row.massMax - row.massMin);
}

/**
 * The far guess, kg (unrounded), from the piece's type and size, widened only when the piece is off the size rule.
 * @param {{type?: string, mass: number, sizeMeter?: number, id?: string|number}} piece
 * @returns {{lo: number, hi: number}} contains `piece.mass`
 */
export function farGuessKg(piece) {
  const row = DEBRIS_TYPES[piece.type] || DEBRIS_TYPES.fragment;
  const size = piece.sizeMeter;
  let lo;
  let hi;
  if (Number.isFinite(size)) {
    lo = massForSize(row, size / (SIZE_JITTER.MIN + SIZE_JITTER.SPAN)) * 0.5;
    hi = massForSize(row, size / SIZE_JITTER.MIN) * 2;
  } else {
    lo = row.massMin * 0.5;
    hi = row.massMax * 2;
  }
  const mass = piece.mass;
  if (Number.isFinite(mass)) {
    const r2 = hash01(piece.id, 'far');
    if (mass > hi / 1.1) hi = mass * (1.3 + r2);
    if (mass < lo * 1.1) lo = mass / (1.3 + r2);
  }
  return { lo, hi };
}

/**
 * The close-look band, kg (unrounded): 1.5× wide, the true mass anywhere inside by a per-piece fixed offset, then
 * cut to the far guess.
 * @param {{type?: string, mass: number, sizeMeter?: number, id?: string|number}} piece
 * @returns {{lo: number, hi: number}} contains `piece.mass`
 */
export function closeGuessKg(piece) {
  const far = farGuessKg(piece);
  const r = hash01(piece.id, 'close');
  const lo = piece.mass / (1 + 0.5 * r);
  const hi = lo * 1.5;
  return { lo: Math.max(lo, far.lo), hi: Math.min(hi, far.hi) };
}

/** Two significant figures, rounded down (`up` false) or up (`up` true), so a band still holds the number after rounding. */
function round2(x, up) {
  if (!(x > 0)) return 0;
  const step = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  let v = up ? Math.ceil(x / step - 1e-9) * step : Math.floor(x / step + 1e-9) * step;
  if (up && v < x) v += step;
  if (!up && v > x) v -= step;
  return Number(v.toPrecision(12));
}

/**
 * What the card shows for a piece's mass.
 * - not scanned: exact (as before this rule; no card draws a mass for it);
 * - whole bodies, and any piece she has caught (`_captured`): exact, whatever the scan;
 * - junk scanned from afar: the far band; with a close look: the close band. Numbers are rounded as the player reads them.
 * @param {{type?: string, mass: number, sizeMeter?: number, id?: string|number, _captured?: boolean}} piece
 * @param {{scanned?: boolean, closeLook?: boolean}} [state]
 * @returns {{exact: number}|{lo: number, hi: number}} kg
 */
export function massShown(piece, { scanned = true, closeLook = false } = {}) {
  if (!piece || !Number.isFinite(piece.mass)) return { exact: piece ? piece.mass : null };
  if (!scanned || !isJunk(piece.type) || piece._captured === true) return { exact: piece.mass };
  const g = closeLook ? closeGuessKg(piece) : farGuessKg(piece);
  return { lo: round2(g.lo, false), hi: round2(g.hi, true) };
}

/** A number with two significant figures as text (`0.50`, `12`, `1.2`, `310`). */
function fig2(v) {
  return v >= 100 ? String(Math.round(v)) : v.toPrecision(2);
}

/**
 * The band as text: grams when its high end is under 1 kg (`12–67 g`), otherwise kilograms (`0.45–2.1 kg`); en dash.
 * @param {number} lo kg, already rounded
 * @param {number} hi kg, already rounded
 * @returns {string}
 */
export function formatMassBand(lo, hi) {
  if (hi < 1) return `${fig2(Number((lo * 1000).toPrecision(12)))}\u2013${fig2(Number((hi * 1000).toPrecision(12)))} g`;
  return `${fig2(lo)}\u2013${fig2(hi)} kg`;
}
