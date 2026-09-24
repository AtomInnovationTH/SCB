/**
 * cutPlanner.js — pure debris cut planner (cutting step 1).
 *
 * Decides how a captured debris body is chopped into pot-sized pieces:
 * D1 = A (cut every seam; slice any part still too big), outer parts first,
 * lightest first, main body last, and the part the ship is holding very last
 * (you cannot cut away what you are gripping). Rulings and chop order are
 * ratified in `docs/DECISIONS.md` §12.
 *
 * PURE: no THREE, no `eventBus`, no `Math.random`, no `Constants`. The only
 * import is the wireframe zone table (same precedent as `LassoSystem.js`).
 * Zone data is read, never mutated; results share no objects with the input.
 *
 * @module systems/cutPlanner
 */

import { getWireframeData } from '../ui/DebrisWireframe.js';

/** Guards `parts` against float noise on exact multiples of the limit. */
const PARTS_EPS = 1e-9;

/** Salvage scalar fields scaled by piece mass fraction (DebrisField shape). */
const SALVAGE_SCALARS = ['xenon', 'indium', 'gaAs', 'battery', 'hydrazine', 'lithium'];

/**
 * Plan how to cut one debris body into pieces of at most `maxPieceKg`.
 *
 * @param {object} debris - debris data (`id`, `type`, `mass`, `material`,
 *   optional `salvage`); never modified.
 * @param {object} [options]
 * @param {number} options.maxPieceKg - required, finite, > 0 — the pot-sized
 *   limit is a required input with no default (DECISIONS §12).
 * @param {string} [options.holdZone] - zone name the ship is holding; its
 *   parts come off very last. Defaults to the main body.
 * @returns {{ cut: boolean, cuts: number, seamCuts: number, throughCuts: number,
 *   pieces: Array<{ parentId, index, massKg, material, salvage,
 *   zones: Array<{ zoneName, zoneIndex, part, parts, massKg }> }> }}
 *   pieces are in chop order.
 * @throws {TypeError} if `debris` is missing.
 * @throws {RangeError} if `maxPieceKg` is missing/invalid, or `holdZone` is
 *   not a zone of this body (DECISIONS §8: fail loudly).
 */
export function planCuts(debris, { maxPieceKg, holdZone } = {}) {
  if (debris === null || debris === undefined) {
    throw new TypeError('planCuts: debris is required');
  }
  if (typeof maxPieceKg !== 'number' || !Number.isFinite(maxPieceKg) || maxPieceKg <= 0) {
    throw new RangeError(`planCuts: maxPieceKg must be > 0, got ${maxPieceKg}`);
  }

  // Zones come from the wireframe table (unknown types fall back to
  // missionDebris). Read-only: never mutated, never shared into the result.
  const zones = getWireframeData(debris.type, debris.id).zones;

  if (holdZone !== null && holdZone !== undefined) {
    if (!zones.some((z) => z.name === holdZone)) {
      throw new RangeError(
        `planCuts: holdZone "${holdZone}" is not a zone of this body; `
        + `valid zones: ${zones.map((z) => z.name).join(', ')}`,
      );
    }
  }

  const mass = debris.mass;
  const massOk = typeof mass === 'number' && Number.isFinite(mass) && mass > 0;
  const whole = !massOk || mass <= maxPieceKg;
  const salvage = debris.salvage !== null && debris.salvage !== undefined
    ? debris.salvage
    : null;

  // ── No cut needed (or mass is nonsense): one piece listing every zone ─────
  if (whole) {
    return {
      cut: false,
      cuts: 0,
      seamCuts: 0,
      throughCuts: 0,
      pieces: [{
        parentId: debris.id,
        index: 0,
        massKg: mass,
        material: debris.material,
        salvage: copySalvage(salvage),
        zones: zones.map((z, i) => ({
          zoneName: z.name,
          zoneIndex: i,
          part: 0,
          parts: 1,
          massKg: massOk ? mass * z.massPercent / 100 : mass,
        })),
      }],
    };
  }

  // ── Per-zone part counts ──────────────────────────────────────────────────
  const plan = zones.map((z, i) => {
    const zoneMass = mass * z.massPercent / 100;
    const parts = Math.max(1, Math.ceil(zoneMass / maxPieceKg - PARTS_EPS));
    return { zoneName: z.name, zoneIndex: i, zoneMass, parts };
  });

  // Main body: the FIRST zone with the largest massPercent. Held zone:
  // holdZone if given, else the main body.
  let mainIdx = 0;
  for (let i = 1; i < zones.length; i++) {
    if (zones[i].massPercent > zones[mainIdx].massPercent) mainIdx = i;
  }
  const heldIdx = holdZone !== null && holdZone !== undefined
    ? zones.findIndex((z) => z.name === holdZone)
    : mainIdx;

  // Chop order: every other zone first (lightest first, ties by zone order),
  // then the main body (if it isn't the held zone), then the held zone last.
  // A zone's parts stay together.
  const order = plan
    .filter((p) => p.zoneIndex !== mainIdx && p.zoneIndex !== heldIdx)
    .sort((a, b) => (a.zoneMass - b.zoneMass) || (a.zoneIndex - b.zoneIndex));
  if (mainIdx !== heldIdx) order.push(plan[mainIdx]);
  order.push(plan[heldIdx]);

  const pieces = [];
  for (const zp of order) {
    for (let part = 0; part < zp.parts; part++) {
      pieces.push({
        parentId: debris.id,
        index: pieces.length,
        massKg: zp.zoneMass / zp.parts,
        material: debris.material,
        salvage: null, // filled in below
        zones: [{
          zoneName: zp.zoneName,
          zoneIndex: zp.zoneIndex,
          part,
          parts: zp.parts,
          massKg: zp.zoneMass / zp.parts,
        }],
      });
    }
  }

  // Mass: the last piece absorbs the residue, so the sum is exact.
  let allocated = 0;
  for (let i = 0; i < pieces.length - 1; i++) allocated += pieces[i].massKg;
  pieces[pieces.length - 1].massKg = mass - allocated;

  fillSalvage(salvage, pieces, mass);

  const cuts = pieces.length - 1;
  const throughCuts = plan.reduce((s, p) => s + (p.parts - 1), 0);
  return { cut: true, cuts, seamCuts: cuts - throughCuts, throughCuts, pieces };
}

/**
 * Deep-copy a salvage object for the uncut case (no scaling, no sharing).
 * @param {object|null} salvage
 * @returns {object|null}
 */
function copySalvage(salvage) {
  if (!salvage) return null;
  const out = {};
  for (const f of SALVAGE_SCALARS) out[f] = salvage[f];
  out.metals = (salvage.metals || []).map((m) => ({ ...m }));
  return out;
}

/**
 * Scale salvage across the pieces: the six scalar fields and each metal's
 * `amount` and `value` follow the piece's mass fraction; all other metal
 * fields are copied. The LAST piece absorbs the residue per field, so every
 * field conserves exactly. Missing salvage leaves every piece at `null`.
 *
 * @param {object|null} salvage - the input's salvage (read-only).
 * @param {object[]} pieces - chop-ordered pieces (mutated: `.salvage` set).
 * @param {number} mass - the whole body's mass.
 */
function fillSalvage(salvage, pieces, mass) {
  if (!salvage) return; // pieces keep salvage: null

  const scalarSums = new Map(); // field -> allocated so far
  const metalSums = new Map(); // metal index -> { amount, value } allocated so far
  const last = pieces.length - 1;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const isLast = i === last;
    const fraction = piece.massKg / mass;

    const scaled = {};
    for (const f of SALVAGE_SCALARS) {
      const v = salvage[f];
      if (typeof v !== 'number') { scaled[f] = v; continue; }
      if (isLast) {
        scaled[f] = v - (scalarSums.get(f) || 0);
      } else {
        scaled[f] = v * fraction;
        scalarSums.set(f, (scalarSums.get(f) || 0) + scaled[f]);
      }
    }

    scaled.metals = (salvage.metals || []).map((m, mi) => {
      const out = { ...m }; // copy the other metal fields verbatim
      let sums = metalSums.get(mi);
      if (!sums) { sums = { amount: 0, value: 0 }; metalSums.set(mi, sums); }
      if (typeof m.amount === 'number') {
        out.amount = isLast ? m.amount - sums.amount : m.amount * fraction;
        if (!isLast) sums.amount += out.amount;
      }
      if (typeof m.value === 'number') {
        out.value = isLast ? m.value - sums.value : m.value * fraction;
        if (!isLast) sums.value += out.value;
      }
      return out;
    });

    piece.salvage = scaled;
  }
}
