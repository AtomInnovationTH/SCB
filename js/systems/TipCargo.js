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
import {
  seedShipRelativeAttitude,
  applyShipRelativeAttitude,
  clearShipRelativeAttitude,
} from '../entities/CaptureNet.js';

const M = Constants.SCENE_UNITS_PER_METER ?? 0.00001;

/** Latch point offset beyond the pad origin along the outward boom (m). Measured: lat15/bsum.txt. */
export const TIP_STALK_M = 0.15;
/** Largest bag radius a tip takes (m). */
export const MAX_BAG_R_M = 0.50;
/**
 * Bag radius (m) → max radiator angle (deg) with that bag on a tip, 0.15 m
 * floor to every engine plume cone (the same for all four tips). Measured with
 * the 0.15 m latch — tmp/probes/leash/lat15/bsum.txt. A bag takes the row for
 * the next radius at or above its own.
 */
export const TIP_BAND = [[0.10, 146], [0.15, 145], [0.22, 143], [0.30, 142], [0.40, 140], [0.50, 138]];
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
    this._tipCache = [null, null, null, null];
    this._bookings = [];
    this._lastTheta = null;
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

  /** Next free tip that exists (order az 40 → 220 → 140 → 320), or null. */
  pickTip() {
    for (const i of PICK_ORDER) {
      if (!this._slots[i] && this._tipRec(i)) return i;
    }
    return null;
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
    const radiusM = Number.isFinite(opts.radiusM) ? opts.radiusM : ((debris.sizeMeter || 0) / 2);
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
    // The radiator swing moves the bags (books): the cached inertia must follow.
    if (any) {
      const th = player._flowerThetaRad;
      if (this._lastTheta === null || Math.abs(th - this._lastTheta) > 1e-4) {
        this._lastTheta = th;
        this._invalidateInertia();
      }
    } else {
      this._lastTheta = null;
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

    if (dt > 0) {
      const span = FT.digestSpanS(slot.massKg);
      d._digestProgress = (d._digestProgress || 0) + dt * TimeAuthority.BASE_SCALE * this._sunScale();
      slot.phaseT = Math.min(FT.FEED_S, (d._digestProgress / span) * FT.FEED_S);
    }
    const t = slot.phaseT;

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

    if (t < FT.HOLD_S) return;

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

  // ── reset ────────────────────────────────────────────────────────────────

  /** Drop every bag: release the bodies to the field as free, re-targetable pieces. */
  reset() {
    const held = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this._slots[i];
      if (!s) continue;
      held.push(s.debris);
      this._slots[i] = null;
    }
    this._lastTheta = null;
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
