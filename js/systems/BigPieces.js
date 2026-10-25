/**
 * BigPieces.js - the ledger of big caught pieces that PAY WHEN THEY ARE DISPOSED OF, not at the catch (Nets step 3 slice 5, lane 5b;
 * DECISIONS §33 row 16-17; the names are the contract between the slice's lanes, plan decision C7).
 *
 * A BIG PIECE is a field body of type `rocketBody` or `defunctSat` that carries an `owner` (set only by the high-field spawn: the live
 * pool's own stages and satellites and the catalogue pieces carry none and pay at the catch as they always did), or a scoop bag holding
 * one. Only with the map on (`FieldRegistry.isOn()`): with `?fields=0` nothing is big. `isBigPiece(d, fieldsOn)` is that test.
 *
 * At the catch GameFlowManager counts a big piece exactly as any catch (the field row leaves, `debrisCleared`, the mission boundary, the
 * win, the save) and pays nothing: no score, no salvage. It `register`s the piece here instead: `d._credited = true` (so no later
 * CATCH_PROCESSED pays or counts it again) and `d._disposal = {fate, caughtAtMs, fieldId, row}` holds the pending pay. The ledger is a
 * Map by debris id, holding the FIELD's own body (a holder may keep a snapshot of it, so every lookup here is by id, never by object).
 *
 *   pendingAboard()   the pending pieces she still holds: `[{debris, holder: 'collar' | {armId}, fate}]`, oldest first. An entry whose body
 *                     is gone (removed from the field) is dropped; one held by nothing (no collar net, no rack) is skipped.
 *   serialize()       the save form of every pending piece (F3: one held by nothing saves `holder: null`; pendingAboard() lists held ones only): `[{type, name, material, mass, size, owner, areaM2, fieldId, fieldRow, fate, holder,
 *                     caughtAtMs, members?, massAtCatch?, meltDoneKg?}]` (a bag lists its BIG members only: the small ones were paid at the catch and carry no value;
 *                     the last two only for a piece in the furnaces, lane 5e: `mass` is then what is left of it).
 *   restore(list, io) rebuilds each entry through `io` ({makeBody(spec), makeBag(bodies), place(body, holder)}): GameFlowManager's load.
 *   loose(id)         a piece that broke loose (its holder let it drop): it leaves the ledger with a line and is marked `_disposed`.
 *
 * Pure of the game's heavy modules: it imports Constants, the event bus and Events only. The holders are read through `bind({nets, arms})`
 * (GameFlowManager binds the capture system's `activeNets` and the arm manager's `arms`), so a rig can bind its own.
 * @module systems/BigPieces
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/** The five ways to dispose of a big piece (C5). `keep` is the default (null until picked). */
export const FATES = ['satellite', 'push', 'sail', 'keep', 'melt'];

const isBigBody = (p) => !!p && Constants.BIG_PIECES.TYPES.includes(p.type) && !!p.owner;
const memberBody = (m) => ((m && m.piece) ? m.piece : m);

/**
 * The big bodies in `d`: itself, or the big members of a scoop bag. Empty for anything else.
 * @param {object|null} d @returns {object[]}
 */
export function bigBodiesOf(d) {
  if (!d) return [];
  if (d.isBag === true && Array.isArray(d.bagMembers)) return d.bagMembers.map(memberBody).filter(isBigBody);
  return isBigBody(d) ? [d] : [];
}

/**
 * C1: is `d` a big piece? A field body of type `rocketBody|defunctSat` carrying an `owner`, or a bag holding one; never when the map is
 * off (`fieldsOn` false: no satellites or trips, so every catch pays at the catch as today).
 * @param {object|null} d @param {boolean} fieldsOn `fieldRegistry.isOn()` @returns {boolean}
 */
export function isBigPiece(d, fieldsOn) {
  return !!fieldsOn && bigBodiesOf(d).length > 0;
}

/**
 * The plain name of a piece for a line: "SL-14 stage", "Cosmos 1175 satellite", "dead microsatellite" (the row name is "Dead upper stage
 * (SL-14 class)"). A bag is named after its heaviest big member.
 * @param {object|null} d @returns {string}
 */
export function pieceName(d) {
  let p = d;
  if (d && d.isBag === true) {
    const bigs = bigBodiesOf(d);
    if (bigs.length) p = bigs.reduce((a, b) => ((b.mass || 0) > (a.mass || 0) ? b : a), bigs[0]);
  }
  const name = p && typeof p.name === 'string' ? p.name : '';
  const m = /\(([^()]+?) class\)/.exec(name);
  if (m) return `${m[1]} ${p.type === 'rocketBody' ? 'stage' : 'satellite'}`;
  const plain = name.replace(/\s*\(est\.\)\s*/g, '').trim();
  // F4: a generic row name ("Dead microsatellite") reads lowercase inside a sentence; proper names (Meteor, Cosmos, Vespa) keep theirs.
  // `pieceNameCap` puts the capital back for a line that starts with the name.
  if (plain) return plain.replace(/^Dead\b/, 'dead');
  return p && p.type === 'rocketBody' ? 'rocket stage' : 'satellite';
}

/** `pieceName` with a capital first letter, for the start of a sentence. */
export function pieceNameCap(d) {
  const n = pieceName(d);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** One body's save form (the fields restoreHeldPiece reads). */
function bodySpec(p) {
  return {
    type: p.type,
    name: typeof p.name === 'string' ? p.name : null,
    material: p.material || null,
    mass: p.mass,
    size: Number.isFinite(p.sizeMeter) ? p.sizeMeter : null,
    owner: p.owner ? { ...p.owner } : null,
    areaM2: Number.isFinite(p.areaM2) ? p.areaM2 : null,
    fieldId: p.fieldId ?? p._bagFieldId ?? null,
    fieldRow: p.fieldRow ?? p._bagFieldRow ?? null,
  };
}

const validSpec = (s) => !!s && typeof s === 'object' && Constants.BIG_PIECES.TYPES.includes(s.type)
  && Number.isFinite(s.mass) && s.mass > 0 && !!s.owner && typeof s.owner === 'object'
  && ['owner', 'insurer', 'abandoned'].includes(s.owner.status);

export class BigPieceLedger {
  constructor() {
    /** @type {Map<number|string, object>} debris id -> the field's own body, in the order the catches landed */
    this._byId = new Map();
    this._src = { nets: () => [], arms: () => [] };
  }

  /** Wire the holders: `nets()` the capture system's active nets, `arms()` the arm manager's daughters. */
  bind(src = {}) {
    this._src = {
      nets: typeof src.nets === 'function' ? src.nets : () => [],
      arms: typeof src.arms === 'function' ? src.arms : () => [],
    };
  }

  /** How many entries (held or not). */
  get size() { return this._byId.size; }

  has(id) { return id != null && this._byId.has(id); }

  /** Is `d` (the field's body or a snapshot of it) a piece waiting to be disposed of? By id. */
  isPending(d) { return !!d && d.id != null && this._byId.has(d.id); }

  get(id) { return id != null ? (this._byId.get(id) || null) : null; }

  /**
   * A big piece was caught (counted, not paid): it is credited (never paid or counted again) and its pay waits in `_disposal`.
   * @param {object} d the field's own body (or bag) @param {{fate?: string, caughtAtMs?: number}} [meta]
   * @returns {boolean} false when it was already registered
   */
  register(d, meta = {}) {
    if (!d || d.id == null || this._byId.has(d.id)) return false;
    d._credited = true;
    d._disposal = {
      fate: FATES.includes(meta.fate) ? meta.fate : null,
      caughtAtMs: Number.isFinite(meta.caughtAtMs) ? meta.caughtAtMs : Date.now(),
      fieldId: d.fieldId ?? null,
      row: d.fieldRow ?? null,
    };
    // C7 "Melt progress" (lane 5e): written only once the piece is in the furnaces, so a fresh entry keeps the shape it always had
    if (Number.isFinite(meta.massAtCatch) && meta.massAtCatch > 0) {
      d._disposal.massAtCatch = meta.massAtCatch;
      d._disposal.meltDoneKg = Number.isFinite(meta.meltDoneKg) && meta.meltDoneKg > 0 ? meta.meltDoneKg : 0;
    }
    this._byId.set(d.id, d);
    return true;
  }

  /** The piece leaves the ledger (disposed of, broke loose). Its pay is gone with `_disposal`. @returns {object|null} the body */
  remove(id) {
    const d = this.get(id);
    if (!d) return null;
    this._byId.delete(id);
    d._disposal = null;
    return d;
  }

  /** A new game or a game reset: nothing is pending any more. */
  clear() {
    for (const d of this._byId.values()) if (d) d._disposal = null;
    this._byId.clear();
  }

  /** @returns {string|null} the fate picked for the piece (null = not picked yet) */
  fateOf(id) {
    const d = this.get(id);
    return d && d._disposal ? (d._disposal.fate || null) : null;
  }

  /** Record the pick. @returns {boolean} false for an unknown piece or fate */
  setFate(id, fate) {
    const d = this.get(id);
    if (!d || !d._disposal || !FATES.includes(fate)) return false;
    d._disposal.fate = fate;
    return true;
  }

  /**
   * Who holds the piece: `'collar'` (a mother net berthed, collared or on its way to a daughter, around it), `{armId}` (on a daughter's
   * rack, or in her hand), or null. By id: a holder may keep a snapshot of the field's body.
   * @param {number|string} id @returns {('collar'|{armId: string}|null)}
   */
  holderOf(id) {
    const S = Constants.CAPTURE_NET.STATES;
    for (const n of this._src.nets() || []) {
      if (!n || !n._isMother || !n.targetDebris || n.targetDebris.id !== id) continue;
      if (n.state === S.BERTHED || n.state === S.COLLARED || n.state === S.TRANSFERRING) return 'collar';
    }
    for (const a of this._src.arms() || []) {
      if (!a) continue;
      if (Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h && h.id === id)) return { armId: a.id };
      if (a.capturedDebris && a.capturedDebris.id === id) return { armId: a.id };
    }
    return null;
  }

  /**
   * The pending pieces she still holds, oldest catch first (C7). An entry whose body is gone (not alive, held by nothing) leaves the
   * ledger; one that is alive but held by nothing right now is skipped.
   * @returns {Array<{debris: object, holder: ('collar'|{armId: string}), fate: (string|null)}>}
   */
  pendingAboard() {
    const out = [];
    for (const [id, d] of [...this._byId]) {
      if (!d || !d._disposal) { this._byId.delete(id); continue; }
      const holder = this.holderOf(id);
      if (!holder) {
        if (d.alive === false) { this._byId.delete(id); d._disposal = null; }
        continue;
      }
      out.push({ debris: d, holder, fate: d._disposal.fate || null });
    }
    out.sort((a, b) => (a.debris._disposal.caughtAtMs || 0) - (b.debris._disposal.caughtAtMs || 0));
    return out;
  }

  /** The save form of `pendingAboard()` (see the file header). */
  serialize() {
    // F3: every pending piece is saved; one held by nothing right now (on the retry list) saves `holder: null` and the restore seats it by
    // the normal fallbacks. Same order as pendingAboard(): oldest catch first.
    const all = [];
    for (const [id, d] of [...this._byId]) {
      if (!d || !d._disposal) continue;
      const holder = this.holderOf(id);
      if (!holder && d.alive === false) continue;
      all.push({ debris: d, holder, fate: d._disposal.fate || null });
    }
    all.sort((a, b) => (a.debris._disposal.caughtAtMs || 0) - (b.debris._disposal.caughtAtMs || 0));
    return all.map(({ debris: d, holder, fate }) => {
      const base = { ...bodySpec(d), fate, holder, caughtAtMs: d._disposal.caughtAtMs };
      // lane 5e (E7): `mass` above is the remainder of a piece being melted; these two say what it was caught at and how much is gone
      if (Number.isFinite(d._disposal.massAtCatch)) {
        base.massAtCatch = d._disposal.massAtCatch;
        base.meltDoneKg = d._disposal.meltDoneKg || 0;
      }
      if (d.isBag === true) {
        base.type = 'bag';
        base.mass = d.mass;
        base.members = bigBodiesOf(d).map(bodySpec);
        base.owner = null;
      }
      return base;
    });
  }

  /**
   * Rebuild the ledger from `serialize()`'s list. Each entry becomes a real field body (`io.makeBody(spec)`; a bag of two or more big
   * pieces is re-bagged with `io.makeBag(bodies)`, a bag of one is that piece alone), registered with its fate, then put on a holder
   * (`io.place(body, savedHolder)` -> true when it is held). Nothing pays here. A bad entry is skipped.
   * @param {Array<object>} list
   * @param {{makeBody: Function, makeBag: Function, place: Function}} io
   * @returns {{restored: number, lost: number, unplaced: object[]}} `unplaced`: bodies the holders could not take yet
   */
  restore(list, io) {
    const out = { restored: 0, lost: 0, unplaced: [] };
    if (!Array.isArray(list) || !io) return out;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      let body = null;
      if (Array.isArray(e.members)) {
        const parts = e.members.filter(validSpec).map((m) => io.makeBody(m)).filter(Boolean);
        body = parts.length >= 2 ? io.makeBag(parts) : (parts[0] || null);
      } else if (validSpec(e)) {
        body = io.makeBody(e);
      }
      if (!body) { out.lost++; continue; }
      this.register(body, { fate: e.fate, caughtAtMs: e.caughtAtMs, massAtCatch: e.massAtCatch, meltDoneKg: e.meltDoneKg });
      // lane 5e (E7): a partly melted bag comes back as its remainder, drawn shortened (a single piece did so in `restoreHeldPiece`)
      if (body.isBag === true && Number.isFinite(e.massAtCatch) && e.massAtCatch > 0 && e.mass > 0 && e.mass < e.massAtCatch) {
        body.mass = e.mass;
        body._meltK = e.mass / e.massAtCatch;
      }
      out.restored++;
      if (!io.place(body, e.holder)) out.unplaced.push(body);
    }
    return out;
  }

  /**
   * A pending piece broke loose (its holder dropped it): nobody pays for it now. It leaves the ledger with a plain line and is marked
   * `_disposed` (it stays a collision object; wave 2 keeps it unlockable). @returns {boolean} false when it was not pending
   */
  loose(id, { say = true } = {}) {
    const d = this.remove(id);
    if (!d) return false;
    d._disposed = true;
    if (say) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD', priority: 'warning', _keep: true,
        text: `The ${pieceName(d)} broke loose: nobody pays for it now.`,
      });
    }
    return true;
  }
}

/** The one ledger of the running game (a new game clears it; each test file runs in its own process). */
export const bigPieces = new BigPieceLedger();

/** C7: the pending pieces she still holds. See `BigPieceLedger.pendingAboard`. */
export function pendingAboard() {
  return bigPieces.pendingAboard();
}
