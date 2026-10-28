/**
 * FurnaceBreakdownVisual.js — THREE-side renderer for the staged "chop the catch into pieces and feed it into the
 * mother's furnace" sequence while a daughter sits in HOLDING_CATCH, or a whale cooks at the nose berthing collar
 * (carried by a `{ kind: 'collar', podIndex }` anchor instead of an armId).
 * Pure visuals — gameplay (salvage/score/remove) is owned by GameFlowManager's single CATCH_PROCESSED handler.
 * The flight choreography is NOT covered by the Node test harness (it touches THREE + the player render hierarchy);
 * the FSM timing that drives it (ArmUnit._updateHoldingCatch + CaptureNetSystem._tickCollarDigestion) is tested, and
 * test-FurnaceBreakdownVisual.js pins the `_collarWorld` anchor fallback chain and the mission-reset sweep.
 *
 * Lifecycle (events emitted by ArmUnit._updateHoldingCatch or the collar tick):
 *   CATCH_BREAKDOWN_START { armId, debrisId, chunkCount, [anchor] }
 *     → spawn `chunkCount` small irregular chunk meshes at the strut-tip catch (or the collar seat) with a brief
 *       outward "chop" jitter + tumble. NO ghost bag at either station: the REAL bag (CaptureNetVisual) stays on the
 *       catch through the chop, deflates with it and fades at chop end; see _onBreakdownStart.
 *   CATCH_BREAKDOWN_CHUNK { armId, debrisId, index, total, [anchor] }
 *     → launch that chunk on a curve from the station toward the mother's furnace port (bus center), shrinking +
 *       warm glow, then dispose. RADIATOR-TIP stations (anchor.kind 'tip') feed the tip itself instead: the chunks
 *       are sized from the catch (each ~0.45 of its radius), start at random points on its surface and sink into the
 *       tip's latch point over ~1 s; the tip is read every frame, so the whole path rides with the ship. They never
 *       fly to the ship's centre (the tip IS the furnace there). No dish mesh yet.
 *   NET_CONSUMED { armIndex } / { podIndex } (collar)
 *     → draw a station ghost bag toward the mother — a no-op since no station spawns one any more (the `_bags`
 *       consumers are kept tolerant).
 *   CATCH_BREAKDOWN_CANCEL { armId | anchor } (mid-cook jettison)
 *     → dispose the station's unflown pool with no draw-in.
 *   GAME_RESET / GAMEOVER_CONTINUE
 *     → the cancel disposal swept per live station: every mission-reset path drops the rack mid-cook, so no
 *       completion event ever arrives for it.
 *
 * Wire in main.js next to CaptureNetVisual: construct, init(scene, player), update(dt).
 *
 * @module ui/FurnaceBreakdownVisual
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { smoothstep01 } from '../core/MathUtil.js';

/** 1 metre in scene units (1 scene unit = 100 km). */
const M = 1e-5;

const COL_CHUNK_COLD = 0x8a7f72;   // freshly chopped (cool metal)
const COL_CHUNK_HOT  = 0xff7a1a;   // heated as it nears the furnace

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _qa = new THREE.Quaternion();

/** A radiator-tip chunk's radius as a fraction of the catch's radius. */
export const TIP_CHUNK_FRAC = 0.45;
/** Scale left at the end of its sink into the tip. */
const TIP_CHUNK_END_SCALE = 0.1;

/** Arm index from an armId like "weaver-1" via the player's arm manager, falling back to a payload armIndex. */
function resolveArmIndex(player, payload) {
  if (payload && payload.armIndex != null && payload.armIndex >= 0) return payload.armIndex;
  const id = payload && payload.armId;
  const arms = player && player.armManager && player.armManager.arms;
  if (id && arms) {
    const idx = arms.findIndex((a) => a && a.id === id);
    if (idx >= 0) return idx;
  }
  return -1;
}

export class FurnaceBreakdownVisual {
  constructor() {
    this._scene = null;
    this._player = null;
    this._enabled = false;
    this._disposed = false;

    /** Active chunk animations: { mesh, t, dur, start:Vector3, ctrl:Vector3, end:Vector3, spin:Vector3, baseScale } */
    this._chunks = [];
    /** Ghost bags keyed by station (arm index | 'collar'): Map<number|string, { group, t, dur, holding, startScale, worldOf }>.
     *  Always EMPTY: no station spawns one (the real bag owns the read). The consumers stay `if (bag)`-tolerant. */
    this._bags = new Map();
    /** Pending chunk pools keyed by station (arm index | 'collar'): prebuilt meshes awaiting their CHUNK event. */
    this._pools = new Map();
    /** The last live collar seat (the draw-in keeps it after the splice). */
    this._collarLastWorld = null;

    this._boundStart = null;
    this._boundChunk = null;
    this._boundConsumed = null;
    this._boundCancel = null;
    this._boundReset = null;
  }

  /**
   * @param {THREE.Scene} scene
   * @param {object} player — PlayerSatellite (provides strutTipNodes + body center)
   */
  init(scene, player) {
    this._scene = scene;
    this._player = player;
    this._enabled = true;
    this._disposed = false;

    this._boundStart = this._onBreakdownStart.bind(this);
    this._boundChunk = this._onBreakdownChunk.bind(this);
    this._boundConsumed = this._onNetConsumed.bind(this);
    this._boundCancel = this._onBreakdownCancel.bind(this);
    this._boundReset = this._onMissionReset.bind(this);

    eventBus.on(Events.CATCH_BREAKDOWN_START, this._boundStart);
    eventBus.on(Events.CATCH_BREAKDOWN_CHUNK, this._boundChunk);
    eventBus.on(Events.NET_CONSUMED, this._boundConsumed);
    eventBus.on(Events.CATCH_BREAKDOWN_CANCEL, this._boundCancel);
    // resetGame() emits GAME_RESET; the GAMEOVER_CONTINUE handler calls armManager.reset() WITHOUT emitting it
    // (KesslerSystem documents the split), so the sweep must ride BOTH.
    eventBus.on(Events.GAME_RESET, this._boundReset);
    eventBus.on(Events.GAMEOVER_CONTINUE, this._boundReset);
  }

  dispose() {
    if (this._boundStart) eventBus.off(Events.CATCH_BREAKDOWN_START, this._boundStart);
    if (this._boundChunk) eventBus.off(Events.CATCH_BREAKDOWN_CHUNK, this._boundChunk);
    if (this._boundConsumed) eventBus.off(Events.NET_CONSUMED, this._boundConsumed);
    if (this._boundCancel) eventBus.off(Events.CATCH_BREAKDOWN_CANCEL, this._boundCancel);
    if (this._boundReset) {
      eventBus.off(Events.GAME_RESET, this._boundReset);
      eventBus.off(Events.GAMEOVER_CONTINUE, this._boundReset);
    }
    for (const c of this._chunks) this._disposeMesh(c.mesh);
    this._chunks.length = 0;
    for (const [, bag] of this._bags) this._disposeMesh(bag.group);
    this._bags.clear();
    for (const [, pool] of this._pools) pool.forEach((m) => this._disposeMesh(m));
    this._pools.clear();
    this._enabled = false;
    this._disposed = true;
  }

  _strutTipWorld(armIndex, out) {
    const p = this._player;
    if (p && p.strutTipNodes && p.strutTipNodes[armIndex]) {
      p.strutTipNodes[armIndex].getWorldPosition(out);
      return out;
    }
    return this._motherCenter(out);
  }

  /** World position of a radiator tip's latch point (TipCargo), else the bus centre. */
  _tipWorld(index, out) {
    const tc = this._player && this._player.tipCargo;
    if (tc && typeof tc.latchWorldInto === 'function' && tc.latchWorldInto(index, out)) return out;
    return this._motherCenter(out);
  }

  /** The ship's world orientation into `out` (identity for a mock without one). */
  _shipQuat(out) {
    const q = this._player && this._player.quaternion;
    return q ? out.copy(q) : out.identity();
  }

  /** World position of the mother's furnace port (bus center). */
  _motherCenter(out) {
    const p = this._player;
    if (p && p.getWorldPosition) { p.getWorldPosition(out); return out; }
    if (p && p.getPosition) { const pp = p.getPosition(); out.set(pp.x, pp.y, pp.z); return out; }
    return out.set(0, 0, 0);
  }

  /**
   * The collar station's live world position: the collared catch's own `_scenePosition` (what pinCapturedDebris
   * wrote this frame). After the completion splice the docked catch is gone, so fall back to the LAST live seat,
   * then the berth collar anchor (the on-axis station; the muzzle read survives only for headless mocks without
   * it), then the bus centre.
   * @param {THREE.Vector3} out
   */
  _collarWorld(out) {
    try {
      const cns = this._player && this._player._captureNetSystem;
      const net = cns && typeof cns.getDockedCatch === 'function' ? cns.getDockedCatch() : null;
      const sp = net && net.targetDebris && net.targetDebris._scenePosition;
      if (sp) {
        this._collarLastWorld = { x: sp.x, y: sp.y, z: sp.z };
        return out.copy(sp);
      }
    } catch (_e) { /* fall through to the last-known seat */ }
    if (this._collarLastWorld) {
      return out.set(this._collarLastWorld.x, this._collarLastWorld.y, this._collarLastWorld.z);
    }
    if (this._player && typeof this._player.getNetBerthCollarPositionInto === 'function') {
      return this._player.getNetBerthCollarPositionInto(out);
    }
    if (this._player && typeof this._player.getNetPodPositionInto === 'function') {
      return this._player.getNetPodPositionInto(0, out);
    }
    return this._motherCenter(out);
  }

  /**
   * Resolve a breakdown-event payload to a station anchor: the daughter rack's strut tip (armIndex), the collar
   * ({anchor:{kind:'collar', podIndex}}) or a radiator tip ({anchor:{kind:'tip', index}}, TipCargo). Null when
   * nothing resolves.
   * @returns {{ key: number|string, worldOf: (out: THREE.Vector3) => THREE.Vector3 }|null}
   * @private
   */
  _resolveAnchor(payload) {
    if (payload && payload.anchor && payload.anchor.kind === 'collar') {
      return { key: 'collar', worldOf: (out) => this._collarWorld(out) };
    }
    if (payload && payload.anchor && payload.anchor.kind === 'tip') {
      const index = payload.anchor.index;
      return { key: 'tip' + index, worldOf: (out) => this._tipWorld(index, out) };
    }
    const armIndex = resolveArmIndex(this._player, payload);
    if (armIndex < 0) return null;
    return { key: armIndex, worldOf: (out) => this._strutTipWorld(armIndex, out) };
  }

  _makeChunkMesh(radius = 0.6 * M) {
    // ~0.6 m so it reads at gameplay distance. A radiator-tip chunk is sized from its catch instead
    // (TIP_CHUNK_FRAC), so a 0.3 m piece does not break into 0.6 m lumps.
    const r = radius;
    const geo = new THREE.IcosahedronGeometry(r, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i,
        pos.getX(i) * (0.7 + Math.random() * 0.6),
        pos.getY(i) * (0.7 + Math.random() * 0.6),
        pos.getZ(i) * (0.7 + Math.random() * 0.6));
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: COL_CHUNK_COLD, emissive: COL_CHUNK_HOT, emissiveIntensity: 0.0,
      roughness: 0.8, metalness: 0.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = Constants.RENDER_ORDER ? Constants.RENDER_ORDER.DETAIL : 2;
    return mesh;
  }

  _disposeMesh(obj) {
    if (!obj) return;
    if (this._scene) this._scene.remove(obj);
    obj.traverse?.((n) => {
      if (n.geometry) n.geometry.dispose?.();
      if (n.material) { Array.isArray(n.material) ? n.material.forEach((m) => m.dispose?.()) : n.material.dispose?.(); }
    });
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) obj.material.dispose?.();
  }

  _onBreakdownStart(payload) {
    if (!this._enabled || !this._scene) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    const count = payload.chunkCount || (Constants.FURNACE_TRANSFER?.CHUNK_COUNT ?? 5);

    if (payload.anchor && payload.anchor.kind === 'tip') {
      this._startTipPool(anchor, payload.anchor.index, count);
      return;
    }

    const tip = anchor.worldOf(_v3a).clone();

    // Pool of chunk meshes parked at the station with a small chop jitter + tumble, waiting for their CHUNK event.
    const pool = [];
    for (let i = 0; i < count; i++) {
      const mesh = this._makeChunkMesh();
      const jitter = new THREE.Vector3(
        (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5),
      ).normalize().multiplyScalar(0.8 * M);
      mesh.position.copy(tip).add(jitter);
      mesh.userData.spin = new THREE.Vector3(
        (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
      this._scene.add(mesh);
      pool.push(mesh);
    }
    this._pools.set(anchor.key, pool);

    // NO ghost bag at any station: the real bag (CaptureNetVisual) stays on the catch through the chop, deflates
    // with the body off the same FT.chopScaleMul ramp and fades at chop end. A ghost sphere (1.4 m gray wireframe,
    // the owner's "geometric ball") crossed the deflating fabric mid-chop and then stood alone until NET_CONSUMED.
    // Chunks still arc from the seat (the feed payoff). Every `_bags` consumer already tolerates a missing bag.
  }

  /**
   * @private A radiator-tip breakdown: park `count` chunks at random points on the catch's surface, each a fraction
   * of its radius, remembered as offsets from the tip in the SHIP's frame so they ride with the ship (and the
   * radiator) until their CHUNK event sinks them into the tip.
   * @param {{key:string}} anchor
   * @param {number} index — the tip
   */
  _startTipPool(anchor, index, count) {
    const tc = this._player && this._player.tipCargo;
    const d = tc && typeof tc.debrisAt === 'function' ? tc.debrisAt(index) : null;
    let radiusM = d && Number.isFinite(d.sizeMeter) ? d.sizeMeter / 2 : 0.2;
    if (tc && typeof tc.spheres === 'function') {                          // the bag's own radius
      const sph = tc.spheres().find((x) => x.name === 'tipBag_' + index);
      if (sph && sph.r > 0) radiusM = sph.r;
    }
    const tip = this._tipWorld(index, new THREE.Vector3());
    const centre = d && d._scenePosition ? d._scenePosition : tip;
    const inv = this._shipQuat(new THREE.Quaternion()).invert();
    const pool = [];
    pool.tipIndex = index;
    for (let i = 0; i < count; i++) {
      const mesh = this._makeChunkMesh(TIP_CHUNK_FRAC * radiusM * M);
      const u = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      if (u.lengthSq() < 1e-6) u.set(0, 1, 0);
      u.normalize().multiplyScalar(radiusM * M);                           // a point on the catch's surface
      mesh.position.copy(centre).add(u);
      mesh.userData.tipOff = mesh.position.clone().sub(tip).applyQuaternion(inv);   // from the tip, in the ship's frame
      mesh.userData.spin = new THREE.Vector3(
        (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
      this._scene.add(mesh);
      pool.push(mesh);
    }
    this._pools.set(anchor.key, pool);
  }

  _onBreakdownChunk(payload) {
    if (!this._enabled || !this._scene) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    const pool = this._pools.get(anchor.key);
    if (!pool || pool.length === 0) return;
    const mesh = pool.shift();
    if (!mesh) return;

    if (pool.tipIndex != null) {
      // sink into the tip: the stored ship-frame offset shrinking to 0, read every frame
      this._chunks.push({
        mesh, t: 0, dur: 0.9 + Math.random() * 0.3, tipIndex: pool.tipIndex,
        off: mesh.userData.tipOff.clone(),
        spin: mesh.userData.spin || new THREE.Vector3(2, 1, 3),
        baseScale: mesh.scale.x || 1,
      });
      if (pool.length === 0) this._pools.delete(anchor.key);
      return;
    }

    const start = mesh.position.clone();
    const end = this._motherCenter(_v3b).clone();
    // Control point bulges outward so the chunk arcs into the furnace
    const mid = start.clone().lerp(end, 0.5);
    const outward = start.clone().sub(end).normalize().multiplyScalar(2.0 * M);
    const ctrl = mid.add(outward);

    this._chunks.push({
      mesh, t: 0, dur: 0.9 + Math.random() * 0.3,
      start, ctrl, end,
      spin: mesh.userData.spin || new THREE.Vector3(2, 1, 3),
      baseScale: mesh.scale.x || 1,
    });

    if (pool.length === 0) this._pools.delete(anchor.key);
  }

  _onNetConsumed(payload) {
    if (!this._enabled) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    const bag = this._bags.get(anchor.key);
    if (bag) { bag.holding = false; bag.t = 0; bag.dur = 0.7; }
  }

  /**
   * @private A mid-cook jettison [K] from the collar ends the beat WITHOUT the furnace draw-in: the body left the
   * furnace, not into it. Unflown pool chunks dispose; chunks already committed keep flying home.
   */
  _onBreakdownCancel(payload) {
    if (!this._enabled || !this._scene) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    this._cancelStation(anchor.key);
  }

  /**
   * @private Per-station disposal: the ghost bag and unflown chunk pool at one key. Chunks already committed
   * (`this._chunks`) are deliberately untouched: they keep flying home and self-dispose in update().
   */
  _cancelStation(key) {
    const bag = this._bags.get(key);
    if (bag) {
      this._disposeMesh(bag.group);
      this._bags.delete(key);
    }
    const pool = this._pools.get(key);
    if (pool) {
      for (const m of pool) this._disposeMesh(m);
      this._pools.delete(key);
    }
  }

  /**
   * @private Every mission-reset path drops the rack (ArmManager.reset() from BOTH resetGame() and the
   * GAMEOVER_CONTINUE handler), so a mid-chop piece's completion events never fire: without this sweep the unflown
   * pool renders forever, and the released piece's instanced original renders whole again beside the leaked meshes
   * (a second copy). Runs the cancel disposal per live station; committed chunks keep flying (the reset teleports
   * the view, so their self-disposal is off-camera).
   */
  _onMissionReset() {
    if (this._bags.size === 0 && this._pools.size === 0) return;
    for (const key of new Set([...this._bags.keys(), ...this._pools.keys()])) {
      this._cancelStation(key);
    }
  }

  update(dt) {
    if (!this._enabled || this._disposed) return;

    // Parked radiator-tip chunks ride with the tip (and the ship) until their CHUNK event.
    for (const [, pool] of this._pools) {
      if (pool.tipIndex == null) continue;
      this._tipWorld(pool.tipIndex, _v3b);
      this._shipQuat(_qa);
      for (const m of pool) m.position.copy(m.userData.tipOff).applyQuaternion(_qa).add(_v3b);
    }

    for (let i = this._chunks.length - 1; i >= 0; i--) {
      const c = this._chunks[i];
      c.t += dt;
      const u = Math.min(1, c.t / c.dur);
      const iu = 1 - u;
      if (c.tipIndex != null) {
        // tip(now) + R(now) · offset · (1 - ease): monotone toward the tip, exactly on it at u = 1
        this._tipWorld(c.tipIndex, _v3b);
        this._shipQuat(_qa);
        const e = smoothstep01(u);
        _v3a.copy(c.off).applyQuaternion(_qa).multiplyScalar(1 - e).add(_v3b);
      } else {
        // B(u) = iu²·start + 2·iu·u·ctrl + u²·end
        _v3a.copy(c.start).multiplyScalar(iu * iu)
          .addScaledVector(c.ctrl, 2 * iu * u)
          .addScaledVector(c.end, u * u);
      }
      c.mesh.position.copy(_v3a);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      const s = c.baseScale * (1 - (c.tipIndex != null ? 1 - TIP_CHUNK_END_SCALE : 0.85) * u);
      c.mesh.scale.setScalar(Math.max(1e-4, s));
      if (c.mesh.material && c.mesh.material.emissiveIntensity != null) {
        c.mesh.material.emissiveIntensity = 0.2 + 1.6 * u;   // warm glow as it nears the furnace
      }
      if (u >= 1) {
        this._disposeMesh(c.mesh);
        this._chunks.splice(i, 1);
      }
    }

    for (const [key, bag] of this._bags) {
      bag.t += dt;
      const world = bag.worldOf || ((out) => this._strutTipWorld(key, out));
      if (bag.holding) {
        bag.group.position.copy(world(_v3a));
        const pulse = 1 + 0.06 * Math.sin(bag.t * 6);
        bag.group.scale.setScalar(pulse);
      } else {
        const u = Math.min(1, bag.t / bag.dur);
        this._motherCenter(_v3b);
        bag.group.position.copy(world(_v3a)).lerp(_v3b, u);
        bag.group.scale.setScalar(Math.max(1e-4, 1 - u));
        bag.group.traverse((n) => { if (n.material && n.material.opacity != null) n.material.opacity = 0.5 * (1 - u); });
        if (u >= 1) {
          this._disposeMesh(bag.group);
          this._bags.delete(key);
        }
      }
    }
  }
}

export const furnaceBreakdownVisual = new FurnaceBreakdownVisual();
