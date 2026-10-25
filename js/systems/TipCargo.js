/**
 * TipCargo.js — bags held on the radiator tips (lane l5a-tip-cargo).
 *
 * DECISIONS §1 (the leash ends at a radiator tip, where the tip magnet latches
 * the steel washer at the net's neck), §12 (pieces go to furnaces on the
 * radiator tips; the furnace is not built — the stand-in cook is the existing
 * span law), §5a (hardware keeps 0.15 m outside the engine plume cones).
 *
 * This is only the HOLDER. One bag per radiator tip (4 slots). Nothing puts a
 * bag here yet except tests — lane l5b wires the leash to `stow()`.
 *
 * The holder mirrors the daughter rack (ArmUnit._pinHeldCatches /
 * _updateHoldingCatch):
 *   - PIN: every frame — "a gap reads as a release". The bag centre is the
 *     latch point + radius · dir, where `dir` lives in the radiator HINGE
 *     frame so the bag turns with the radiator and with the ship. After
 *     `swingToBoom(i)` the dir slews to the boom axis at SWING_RATE_DEG_S.
 *   - COOK: the same clock (`dt · BASE_SCALE · sunScale`), span
 *     (`FURNACE_TRANSFER.digestSpanS(mass)`), phases (hold / chop / feed),
 *     chop scale and `_breakdownActive` as the rack, each tip on its own clock.
 *     Ends with CATCH_PROCESSED { digested: true, source: 'tip', tipIndex }.
 *   - BOOKS: `massBookings()` feeds CoMCalculator.computeCoM / computeInertia;
 *     `totalMassKg()` feeds ArmManager.getCargoMassKg.
 *   - RADIATOR CEILING: `maxRadiatorThetaRad()` is read by
 *     PlayerSatellite._updateFlower — a bag on a tip must stay out of the
 *     engine plume cones, so the radiators may not open past the band row for
 *     the largest bag held (measured, tmp/probes/leash/lat15/bsum.txt).
 *
 * Frames: positions handed to the debris field are scene units in the world
 * frame (1 m = 1e-5). `massBookings()` / `spheres()` are metres in the ship
 * body frame (the frame `strutTipMeters` uses: barrel long axis = Z).
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { TimeAuthority } from './TimeAuthority.js';
import { tripMelting } from './TransferTrip.js';
import {
  seedShipRelativeAttitude,
  applyShipRelativeAttitude,
  clearShipRelativeAttitude,
} from '../entities/CaptureNet.js';
import { DebrisField } from '../entities/DebrisField.js';

const M = Constants.SCENE_UNITS_PER_METER ?? 0.00001;

/** Latch point offset beyond the pad origin along the outward boom (m). Measured: lat15/bsum.txt. */
export const TIP_STALK_M = 0.15;
/**
 * Largest bag radius a tip takes (m). 0.75 since v12-big-bags (the 2.30 m radiators): every radius up to 0.75 has a
 * measured hand-off angle with and without bags held on the other tips — Constants.LEASH.HANDOFF_THETA_TABLE,
 * tmp/v12bb/summ.txt. (0.50 at the 2.5 m radiators.)
 */
export const MAX_BAG_R_M = 0.75;
/**
 * Bag radius (m) → max radiator angle (deg) with that bag on a tip, 0.15 m
 * floor to every engine plume cone (the same for all four tips). Measured with
 * the 0.15 m latch — tmp/probes/leash/lat15/bsum.txt at 2.5 m; re-measured at
 * the 2.30 m radiators (tmp/probes/arm-length/band.mjs, tmp/v12bb/band-s0.2.txt:
 * 0.10 146 | 0.15 145 | 0.22 143.5 | 0.30 142 | 0.40 140 | 0.50 138 | 0.60 136.5 |
 * 0.75 134; the old rows are unchanged, the new ones are floored to a whole degree
 * like the old). A bag takes the row for the next radius at or above its own.
 */
export const TIP_BAND = [[0.10, 146], [0.15, 145], [0.22, 143], [0.30, 142], [0.40, 140], [0.50, 138], [0.60, 136], [0.75, 134]];
/** How fast a bag turns from the line it arrived on to the boom axis (deg/s). ESTIMATE, not measured. */
export const SWING_RATE_DEG_S = 10;
/** Tip order for the next free tip: azimuth 40 → 220 → 140 → 320 (AZIMUTHS_DEG indices). */
const PICK_ORDER = [0, 2, 1, 3];
const SLOT_COUNT = 4;

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);

/** Band row (deg) for a bag radius, or null when the bag is too big for a tip. */
export function bandDegForRadius(radiusM) {
  const r = Number.isFinite(radiusM) ? radiusM : 0;
  for (const [maxR, deg] of TIP_BAND) {
    if (r <= maxR + 1e-9) return deg;
  }
  return null;
}

export class TipCargo {
  /**
   * @param {{ player: object, debrisField?: object, armManager?: object, eventBus?: object }} deps
   */
  constructor({ player, debrisField = null, armManager = null, eventBus: bus = eventBus } = {}) {
    this.player = player;
    this.debrisField = debrisField;
    this.armManager = armManager;
    this.eventBus = bus;
    /** @type {Array<null|object>} one bag per tip */
    this._slots = [null, null, null, null];
    /** trip-melt-2 (carry): tips a daughter is carrying a catch to (see `reserve`) */
    this._reserved = [false, false, false, false];
    this._tipCache = [null, null, null, null];
    this._bookings = [];
    this._lastThetas = [null, null, null, null];   // petal-single: each occupied tip's petal angle at the last update
    this._boundReset = () => this.reset();
    this.eventBus.on(Events.GAME_RESET, this._boundReset);
    this.eventBus.on(Events.GAMEOVER_CONTINUE, this._boundReset);
  }

  dispose() {
    this.eventBus.off(Events.GAME_RESET, this._boundReset);
    this.eventBus.off(Events.GAMEOVER_CONTINUE, this._boundReset);
  }

  // ── tip hardware (found lazily by name — pairs are installed late) ───────

  /** @returns {{hinge:THREE.Object3D, tip:THREE.Object3D, pad:THREE.Object3D|null}|null} */
  _tipRec(i) {
    const c = this._tipCache[i];
    if (c && c.hinge.parent) return c;
    const groups = this.player && this.player._flowerGroups;
    if (!groups) return null;
    const az = Constants.THERMAL.FLOWER.AZIMUTHS_DEG[i];
    for (const fg of groups) {
      if (fg.azDeg !== az || !fg.hinge) continue;
      const tip = fg.hinge.getObjectByName(`FlowerStrutTip_${i}`);
      if (!tip) return null;
      const pad = tip.getObjectByName(`FlowerStrutTipPad_${i}`) || null;
      return (this._tipCache[i] = { hinge: fg.hinge, tip, pad });
    }
    return null;
  }

  /** Hinge-frame point → ship-local point (scene units), into `out`. */
  _hingeToShip(rec, p, out) {
    const hinge = rec.hinge;
    const pivot = hinge.parent;
    out.copy(p).applyQuaternion(hinge.quaternion).add(hinge.position);
    if (pivot) out.applyQuaternion(pivot.quaternion).add(pivot.position);
    return out;
  }

  /** Quaternion hinge frame → ship frame, into `out`. */
  _hingeQuatShip(rec, out) {
    const pivot = rec.hinge.parent;
    if (pivot) out.copy(pivot.quaternion).multiply(rec.hinge.quaternion);
    else out.copy(rec.hinge.quaternion);
    return out;
  }

  /** The latch point in the HINGE frame (scene units): pad origin + 0.15 m along local +X. */
  _latchHingeInto(rec, out) {
    out.copy(rec.tip.position);
    if (rec.pad) out.add(rec.pad.position);
    else out.x -= 0.0275 * M;
    out.x += TIP_STALK_M * M;
    return out;
  }

  _shipPos(out) {
    const p = this.player;
    if (p && p.position) return out.copy(p.position);
    return out.set(0, 0, 0);
  }

  /**
   * World position (scene units) of tip i's latch point — where the swivel cone
   * holds the washer: pad origin + 0.15 m along the outward boom.
   * @returns {THREE.Vector3|null} `out`, or null when the tip does not exist
   */
  latchWorldInto(i, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._latchHingeInto(rec, _v1);
    this._hingeToShip(rec, _v1, out);
    out.applyQuaternion(this.player.quaternion).add(this._shipPos(_v2));
    return out;
  }

  /** Unit outward boom direction of tip i in the world frame. */
  axisWorldInto(i, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._hingeQuatShip(rec, _q1);
    return out.copy(_X).applyQuaternion(_q1).applyQuaternion(this.player.quaternion).normalize();
  }

  /**
   * The turn from tip i's HINGE frame to the ship body frame, as plain {x,y,z,w} into `out` (read-only view of
   * `_hingeQuatShip`; the frame `_place` seats the bag in). null when the tip does not exist.
   */
  hingeQuatShipInto(i, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._hingeQuatShip(rec, _q1);
    out.x = _q1.x; out.y = _q1.y; out.z = _q1.z; out.w = _q1.w;
    return out;
  }

  // ── slots ────────────────────────────────────────────────────────────────

  /**
   * Next free tip that exists (order az 40 → 220 → 140 → 320), or null. A tip a daughter is carrying to is not free.
   * petal-single (owner 2026-10-19, "debris should be transferred to radiators first so daughters stay available"): a free
   * tip whose daughter holds no catch is preferred, so a nose catch does not take the tip a loaded daughter is waiting for
   * while another tip is free; with every free tip wanted by a loaded daughter, the order above decides.
   */
  pickTip() {
    let wanted = null;
    for (const i of PICK_ORDER) {
      if (this._slots[i] || this._reserved[i] || !this._tipRec(i)) continue;
      if (!this._daughterLoaded(i)) return i;
      if (wanted === null) wanted = i;
    }
    return wanted;
  }

  /** @private Tip i's daughter (the one on her line: arm index = tip index) holds a catch on her rack. */
  _daughterLoaded(i) {
    const arms = this.armManager && this.armManager.arms;
    const a = Array.isArray(arms) ? arms[i] : null;
    return !!(a && !a.isDetached && Array.isArray(a.heldCatches) && a.heldCatches.length > 0);
  }

  /**
   * trip-melt-2 (carry): hold tip i's slot for a daughter on her way with a catch — `pickTip` skips it until the stow
   * (which clears it), `unreserve`, or `reset`.
   * @returns {boolean} false when the tip is taken, already reserved, or does not exist
   */
  reserve(i) {
    if (!(i >= 0 && i < SLOT_COUNT) || this._slots[i] || this._reserved[i] || !this._tipRec(i)) return false;
    this._reserved[i] = true;
    return true;
  }

  unreserve(i) { if (i >= 0 && i < SLOT_COUNT) this._reserved[i] = false; }

  isReserved(i) { return !!this._reserved[i]; }

  /**
   * Tip i's bag point for a bag of radius `radiusM`: the latch point plus the radius along the boom, SHIP-LOCAL scene units
   * (the point `stow` seats the bag at once its direction has swung onto the boom). The carrying daughter flies the
   * delivered catch's centre onto it. null when the tip does not exist.
   * @returns {THREE.Vector3|null} `out`
   */
  bagPointShipInto(i, radiusM, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._latchHingeInto(rec, _v1);
    this._hingeToShip(rec, _v1, out);
    this._hingeQuatShip(rec, _q1);
    _v2.copy(_X).applyQuaternion(_q1).normalize();
    return out.addScaledVector(_v2, radiusM * M);
  }

  /** Does a bag of this radius fit on a tip at all? */
  fits(radiusM) {
    return Number.isFinite(radiusM) && radiusM >= 0 && radiusM <= MAX_BAG_R_M + 1e-9;
  }

  has(i) { return !!this._slots[i]; }
  /**
   * l6-look — what the mother digest line prints ("Tips 1/2", "cooking 40%"). Returns ONE reused object, so a
   * 10 Hz readout allocates nothing: `held` bags, `tips` fitted (2 per radiator pair, 4 with both), `cookingPct`
   * (0..100, the furthest-along bag's share of its cook clock) or null while nothing is cooking.
   * @returns {{held:number, tips:number, cookingPct:number|null}}
   */
  digest() {
    const out = this._digest || (this._digest = { held: 0, tips: 0, cookingPct: null });
    const FEED = Constants.FURNACE_TRANSFER.FEED_S;
    let held = 0, tips = 0, best = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (this._tipRec(i)) tips++;
      const s = this._slots[i];
      if (!s) continue;
      held++;
      if (s.phaseT > 0 && s.phaseT > best) best = s.phaseT;
    }
    out.held = held;
    out.tips = tips;
    out.cookingPct = best > 0 ? Math.min(100, Math.floor((best / FEED) * 100)) : null;
    return out;
  }
  count() { let n = 0; for (const s of this._slots) if (s) n++; return n; }
  isSwinging(i) { const s = this._slots[i]; return !!(s && s.swinging); }
  /** @returns {object|null} the debris held on tip i */
  debrisAt(i) { const s = this._slots[i]; return s ? s.debris : null; }

  totalMassKg() {
    let m = 0;
    for (const s of this._slots) if (s) m += s.massKg;
    return m;
  }

  /**
   * Latch a bag onto tip i. The bag arrives along `fromDirWorld` (the line,
   * from the latch point out to the bag centre); it keeps that direction in
   * the radiator's frame until `swingToBoom(i)` turns it onto the boom axis.
   * @param {number} i tip index (0..3)
   * @param {object} debris the caught body (must carry `tumbleAxis` for the attitude pin)
   * @param {{massKg?:number, radiusM?:number, fromDirWorld?:{x:number,y:number,z:number}}} [opts]
   * @returns {boolean} true when stowed
   */
  stow(i, debris, opts = {}) {
    if (!debris || !(i >= 0 && i < SLOT_COUNT) || this._slots[i]) return false;
    const rec = this._tipRec(i);
    if (!rec) return false;
    for (const s of this._slots) if (s && s.debris === debris) return false;
    const massKg = Number.isFinite(opts.massKg) ? opts.massKg : (debris.mass || 0);
    const radiusM = Number.isFinite(opts.radiusM) ? opts.radiusM : DebrisField.trueReachM(debris, 0);   // tip-fit: the catch as drawn
    if (!this.fits(radiusM)) return false;

    const dirLocal = new THREE.Vector3(1, 0, 0);
    const f = opts.fromDirWorld;
    if (f && (f.x * f.x + f.y * f.y + f.z * f.z) > 1e-12) {
      // world → ship → hinge frame, so the bag turns with the radiator
      this._hingeQuatShip(rec, _q1);
      _q2.copy(this.player.quaternion).multiply(_q1).invert();
      dirLocal.set(f.x, f.y, f.z).normalize().applyQuaternion(_q2).normalize();
    }

    const slot = {
      i, debris, massKg, radiusM, dirLocal, swinging: false,
      pos: new THREE.Vector3(),
      posShip: { massKg, posShip: { x: 0, y: 0, z: 0 } },
      breakdownStarted: false, chunksFired: 0, phaseT: 0,
      anchor: { kind: 'tip', index: i },   // one object per bag, reused by every event (no per-frame allocation)
    };
    this._slots[i] = slot;
    this._reserved[i] = false;                     // a stow (the carry's or a leash's) ends any reservation of the slot
    this._place(slot, rec);
    debris._captured = true;
    debris._armPinned = true;
    debris._tipIndex = i;
    debris._breakdownActive = false;
    if (!debris._armPinPos) debris._armPinPos = new THREE.Vector3();
    debris._armPinPos.copy(slot.pos);
    // Take the catch's current attitude into the ship's frame; it turns with the ship from here on.
    seedShipRelativeAttitude(debris, this.player.quaternion, this.debrisField);
    this._invalidateInertia();
    return true;
  }

  /** Start turning tip i's bag from its arrival line onto the boom axis. */
  swingToBoom(i) {
    const s = this._slots[i];
    if (!s) return false;
    s.swinging = true;
    return true;
  }

  /**
   * The lowest radiator angle limit, in radians, set by the bags held: for each
   * bag the band row for its radius (the next radius at or above it); the
   * minimum over all bags. Infinity when no tip holds a bag.
   */
  maxRadiatorThetaRad() {
    let best = Infinity;
    for (const s of this._slots) {
      if (!s) continue;
      const deg = bandDegForRadius(s.radiusM);
      const rad = ((deg === null ? TIP_BAND[TIP_BAND.length - 1][1] : deg) * Math.PI) / 180;
      if (rad < best) best = rad;
    }
    return best;
  }

  // ── placement ────────────────────────────────────────────────────────────

  /** Bag centre for a slot: scene-unit world into slot.pos, metres ship-frame into slot.posShip. */
  _place(slot, rec) {
    // latch + r·dir in the hinge frame, then to ship / world
    this._latchHingeInto(rec, _v1);
    _v3.copy(slot.dirLocal).multiplyScalar(slot.radiusM * M).add(_v1);
    this._hingeToShip(rec, _v3, _v2);               // ship-local, scene units
    const ps = slot.posShip.posShip;
    ps.x = _v2.x / M; ps.y = _v2.y / M; ps.z = _v2.z / M;
    slot.pos.copy(_v2).applyQuaternion(this.player.quaternion).add(this._shipPos(_v3));
  }

  _advanceSwing(slot, dt) {
    if (!slot.swinging || !(dt > 0)) return;
    const d = slot.dirLocal;
    const cos = Math.max(-1, Math.min(1, d.dot(_X)));
    const angle = Math.acos(cos);
    if (angle < 1e-9) { d.copy(_X); slot.swinging = false; return; }
    const step = (SWING_RATE_DEG_S * Math.PI / 180) * dt;
    if (step >= angle) { d.copy(_X); slot.swinging = false; return; }
    _v1.crossVectors(d, _X);
    if (_v1.lengthSq() < 1e-12) _v1.set(0, 0, 1);   // exactly opposite: any perpendicular will do
    _v1.normalize();
    d.applyAxisAngle(_v1, step).normalize();
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  /**
   * Pin every bag and run its cook. `dt` is the game step (0 while the world is
   * held: the pin still runs — the ship may turn — but the clocks do not).
   */
  update(dt) {
    const player = this.player;
    if (!player) return;
    let any = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this._slots[i];
      if (!slot) continue;
      any = true;
      const rec = this._tipRec(i);
      if (!rec) continue;   // hardware gone: leave the bag where it was pinned
      this._advanceSwing(slot, dt);
      this._place(slot, rec);
      this._cook(slot, dt);
    }
    // The radiator swing moves the bags (books): the cached inertia must follow. petal-single: each bag rides ITS petal, so
    // the check is per tip (a held petal swings while the rest stay still).
    if (any) {
      let moved = false;
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (!this._slots[i]) { this._lastThetas[i] = null; continue; }
        const th = typeof player.petalThetaRad === 'function'
          ? player.petalThetaRad(Constants.THERMAL.FLOWER.AZIMUTHS_DEG[i])
          : player._flowerThetaRad;
        const last = this._lastThetas[i];
        if (last === null || Math.abs(th - last) > 1e-4) { this._lastThetas[i] = th; moved = true; }
      }
      if (moved) this._invalidateInertia();
    } else {
      for (let i = 0; i < SLOT_COUNT; i++) this._lastThetas[i] = null;
    }
  }

  _sunScale() {
    const cns = (this.armManager && this.armManager.playerSatellite
      && this.armManager.playerSatellite._captureNetSystem)
      || (this.player && this.player._captureNetSystem);
    return (cns && cns._digestSunScale) ?? 1.0;
  }

  _invalidateInertia() {
    const p = this.player;
    if (p && '_attitudeInertia' in p) p._attitudeInertia = null;
  }

  /** Pin + cook one bag — the rack's _updateHoldingCatch / ArmManager pin loop on a tip. */
  _cook(slot, dt) {
    const d = slot.debris;
    const FT = Constants.FURNACE_TRANSFER;
    const bus = this.eventBus;
    const anchor = slot.anchor;

    // no-melt (owner 2026-10-18, "Stay full size, no melting"): with no furnace the clock never runs, so the bag
    // never reaches the hold/chop/feed phases below - no breakdown events, no shrink, the slot stays held.
    // trip-melt D5 (owner 2026-10-19, "melted down in the furnace during the long ion burn"): the four tip furnaces
    // cook while a transfer trip burns, and only then (the nose collar and the racks have no furnace: their flag
    // reads stay FURNACE_COOK alone). Same span, same sun factor, same real-dt clock.
    const cook = Constants.isFeatureEnabled('FURNACE_COOK') || tripMelting();
    if (dt > 0 && cook) {
      const span = FT.digestSpanS(slot.massKg);
      d._digestProgress = (d._digestProgress || 0) + dt * TimeAuthority.BASE_SCALE * this._sunScale();
      slot.phaseT = Math.min(FT.FEED_S, (d._digestProgress / span) * FT.FEED_S);
    }
    // A melt the trip left unfinished keeps its stage (and its size) until the next trip: the clock is off, the bag is not reset.
    const t = slot.phaseT || 0;

    // Pin every frame (a gap reads as a release); position + ship-relative attitude.
    d._armPinned = true;
    d._captured = true;
    let scaleMul = 1;
    if (t >= FT.HOLD_S && !slot.breakdownStarted) {
      slot.breakdownStarted = true;
      d._breakdownActive = true;           // the furnace visual owns scale/disposal
      d._capturedByArm = null;
      bus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: 'mother', debrisId: d.id, chunkCount: FT.CHUNK_COUNT, anchor,
      });
    }
    if (d._breakdownActive) scaleMul = FT.chopScaleMul(t);
    if (this.debrisField && typeof this.debrisField.pinCapturedDebris === 'function') {
      this.debrisField.pinCapturedDebris(d, slot.pos, scaleMul);
    } else {
      if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
      d._armPinPos.copy(slot.pos);
    }
    applyShipRelativeAttitude(d, this.player.quaternion, this.debrisField);

    if (!cook || t < FT.HOLD_S) return;

    if (t >= FT.CHOP_S && t < FT.FEED_S) {
      const feedFrac = (t - FT.CHOP_S) / Math.max(1e-6, FT.FEED_S - FT.CHOP_S);
      const due = Math.min(FT.CHUNK_COUNT, Math.floor(feedFrac * FT.CHUNK_COUNT) + 1);
      this._fireChunks(slot, due, anchor);
      return;
    }
    if (t < FT.FEED_S) return;

    // ── Digestion complete: flush chunks, free the tip, then the one CATCH_PROCESSED ──
    this._fireChunks(slot, FT.CHUNK_COUNT, anchor);
    const debrisId = d.id;
    const type = d.type;
    this._slots[slot.i] = null;
    d._armPinned = false;
    d._armPinPos = null;
    d._breakdownActive = false;
    d._tipIndex = undefined;
    clearShipRelativeAttitude(d);
    this._invalidateInertia();
    bus.emit(Events.NET_CONSUMED, { armId: 'mother', debrisId, anchor });
    bus.emit(Events.CATCH_PROCESSED, {
      debrisId, armId: null, source: 'tip', tipIndex: slot.i, type, digested: true,
    });
  }

  _fireChunks(slot, due, anchor) {
    const FT = Constants.FURNACE_TRANSFER;
    while (slot.chunksFired < due) {
      this.eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
        armId: 'mother', debrisId: slot.debris.id, index: slot.chunksFired, total: FT.CHUNK_COUNT, anchor,
      });
      slot.chunksFired++;
    }
  }

  /**
   * u23 (owner 2026-10-24, "each catch moves to a free tip and melts before you arrive"; DECISIONS §33 row 17: many hours or days of realtime to melt
   * debris): finish every melt in progress NOW, the end of a transfer trip's days. Each occupied tip gets its whole span and the melt's own
   * completion runs (`_cook(slot, 0)`, the code `update` runs at the end of the span), so the chunks, `NET_CONSUMED` and `CATCH_PROCESSED`
   * (`digested: true`, source 'tip') fire exactly as in play and the tip is free. Only while melting runs (the furnace flag, or a trip burning:
   * `tripMelting`); outside one it does nothing. A tip whose hardware is gone is left, as `update` leaves it.
   * @returns {number} how many bags melted
   */
  finishMelts() {
    if (!(Constants.isFeatureEnabled('FURNACE_COOK') || tripMelting())) return 0;
    const FT = Constants.FURNACE_TRANSFER;
    let n = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this._slots[i];
      if (!slot || !this._tipRec(i)) continue;
      slot.debris._digestProgress = FT.digestSpanS(slot.massKg);
      slot.phaseT = FT.FEED_S;
      this._cook(slot, 0);
      if (!this._slots[i]) n++;
    }
    return n;
  }

  // ── books ────────────────────────────────────────────────────────────────

  /**
   * Held mass and where it sits, for computeCoM / computeInertia.
   * @returns {Array<{massKg:number, posShip:{x:number,y:number,z:number}}>} metres, ship body
   *   frame. The array and its entries are reused between calls — read, do not keep.
   */
  massBookings() {
    const out = this._bookings;
    out.length = 0;
    for (const s of this._slots) {
      if (!s || !(s.massKg > 0)) continue;
      const rec = this._tipRec(s.i);
      if (rec) this._place(s, rec);   // fresh: the radiator may have moved since update()
      out.push(s.posShip);
    }
    return out;
  }

  /** Bag spheres (metres, ship body frame) for clearance checks. */
  spheres() {
    const out = [];
    for (const s of this._slots) {
      if (!s) continue;
      const rec = this._tipRec(s.i);
      if (rec) this._place(s, rec);
      const p = s.posShip.posShip;
      out.push({ c: { x: p.x, y: p.y, z: p.z }, r: s.radiusM, name: `tipBag_${s.i}` });
    }
    return out;
  }

  // ── station hand-over ────────────────────────────────────────────────────

  /**
   * no-melt: let go of tip i's bag WITHOUT cooking it (the old station hand-over; the station takes nothing since
   * trip-melt-1, so only tests call it now). Frees the
   * slot and clears every pin the tip wrote; the caller owns what happens to the body (the game removes it from the
   * field, already paid). Emits NET_CONSUMED so the bag visual clears the way the cook's end does; no
   * CATCH_PROCESSED (nothing is credited or digested).
   * @param {number} i tip index (0..3)
   * @returns {object|null} the released debris, or null when the tip is empty
   */
  releaseSlot(i) {
    const s = this._slots[i];
    if (!s) return null;
    const d = s.debris;
    this._slots[i] = null;
    d._armPinned = false;
    d._armPinPos = null;
    d._captured = false;
    d._breakdownActive = false;
    d._tipIndex = undefined;
    clearShipRelativeAttitude(d);
    this._invalidateInertia();
    this.eventBus.emit(Events.NET_CONSUMED, { armId: 'mother', debrisId: d.id, anchor: s.anchor });
    return d;
  }

  // ── reset ────────────────────────────────────────────────────────────────

  /** Drop every bag: release the bodies to the field as free, re-targetable pieces. */
  reset() {
    this._reserved = [false, false, false, false];
    const held = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this._slots[i];
      if (!s) continue;
      held.push(s.debris);
      this._slots[i] = null;
    }
    this._lastThetas = [null, null, null, null];
    if (held.length === 0) return;
    const am = this.armManager;
    const vel = (this.player && typeof this.player.getVelocity === 'function')
      ? this.player.getVelocity() : null;
    if (am && typeof am._releaseDroppedCargo === 'function') {
      am._releaseDroppedCargo(held, vel);
    }
    for (const d of held) {
      // belt and braces for an armManager without the helper: the pin must never outlive the hold
      d._armPinned = false;
      d._armPinPos = null;
      d._capturedByArm = null;
      d._captured = false;
      d._breakdownActive = false;
      d._tipIndex = undefined;
      clearShipRelativeAttitude(d);
    }
    this._invalidateInertia();
  }
}
