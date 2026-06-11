/**
 * FurnaceBreakdownVisual.js — staged furnace breakdown choreography (Item 1).
 *
 * THREE-side renderer for the "chop the catch into pieces and feed it into the
 * mother's furnace" sequence that plays while a daughter sits in HOLDING_CATCH.
 * Pure visuals — gameplay (salvage/score/remove) is owned by GameFlowManager's
 * single CATCH_PROCESSED handler. This module is NOT covered by the Node test
 * harness (it touches THREE + the player render hierarchy); the FSM timing that
 * drives it (ArmUnit._updateHoldingCatch) IS tested.
 *
 * Lifecycle (events emitted by ArmUnit._updateHoldingCatch):
 *   CATCH_BREAKDOWN_START { armId, debrisId, chunkCount }
 *     → spawn `chunkCount` small irregular chunk meshes at the strut-tip catch
 *       position with a brief outward "chop" jitter + tumble, plus a short-lived
 *       "ghost bag" (so the net stays visibly cinched after CaptureNetVisual has
 *       already stowed the real bag — see plan §risks ghost-bag note).
 *   CATCH_BREAKDOWN_CHUNK { armId, debrisId, index, total }
 *     → launch that chunk on a curve from the strut tip toward the mother's
 *       furnace port (bus center), shrinking + warm glow, then dispose.
 *   NET_CONSUMED { armIndex }
 *     → draw the ghost bag toward the mother (shrink + fade), then dispose.
 *
 * Wire in main.js next to CaptureNetVisual: construct, init(scene, player), update(dt).
 *
 * @module ui/FurnaceBreakdownVisual
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** 1 metre in scene units (1 scene unit = 100 km). */
const M = 1e-5;

// Warm furnace palette.
const COL_CHUNK_COLD = 0x8a7f72;   // freshly chopped (cool metal)
const COL_CHUNK_HOT  = 0xff7a1a;   // heated as it nears the furnace
const COL_BAG        = 0x9fb4c8;   // ghost net bag

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

/**
 * Resolve an arm index from an armId like "weaver-1" / "spinner-2" by matching
 * against the player's arm manager, falling back to a payload armIndex.
 */
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
    /** Active ghost bags keyed by arm index: Map<number, { group, t, dur, holding, startScale }> */
    this._bags = new Map();
    /** Pending chunk-spawn pools keyed by arm index: prebuilt chunk meshes awaiting their CHUNK event. */
    this._pools = new Map();

    this._boundStart = null;
    this._boundChunk = null;
    this._boundConsumed = null;
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

    eventBus.on(Events.CATCH_BREAKDOWN_START, this._boundStart);
    eventBus.on(Events.CATCH_BREAKDOWN_CHUNK, this._boundChunk);
    eventBus.on(Events.NET_CONSUMED, this._boundConsumed);
  }

  dispose() {
    if (this._boundStart) eventBus.off(Events.CATCH_BREAKDOWN_START, this._boundStart);
    if (this._boundChunk) eventBus.off(Events.CATCH_BREAKDOWN_CHUNK, this._boundChunk);
    if (this._boundConsumed) eventBus.off(Events.NET_CONSUMED, this._boundConsumed);
    for (const c of this._chunks) this._disposeMesh(c.mesh);
    this._chunks.length = 0;
    for (const [, bag] of this._bags) this._disposeMesh(bag.group);
    this._bags.clear();
    for (const [, pool] of this._pools) pool.forEach((m) => this._disposeMesh(m));
    this._pools.clear();
    this._enabled = false;
    this._disposed = true;
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────

  /** World position of the strut-tip catch for an arm index. */
  _strutTipWorld(armIndex, out) {
    const p = this._player;
    if (p && p.strutTipNodes && p.strutTipNodes[armIndex]) {
      p.strutTipNodes[armIndex].getWorldPosition(out);
      return out;
    }
    return this._motherCenter(out);
  }

  /** World position of the mother's furnace port (bus center). */
  _motherCenter(out) {
    const p = this._player;
    if (p && p.getWorldPosition) { p.getWorldPosition(out); return out; }
    if (p && p.getPosition) { const pp = p.getPosition(); out.set(pp.x, pp.y, pp.z); return out; }
    return out.set(0, 0, 0);
  }

  _makeChunkMesh() {
    // Small irregular chunk; size ~0.6 m so it reads at gameplay distance.
    const r = 0.6 * M;
    const geo = new THREE.IcosahedronGeometry(r, 0);
    // Jitter vertices for an irregular "chopped" look.
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

  _makeGhostBag() {
    const r = 1.4 * M;
    const geo = new THREE.SphereGeometry(r, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: COL_BAG, wireframe: true, transparent: true, opacity: 0.5,
    });
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    group.renderOrder = Constants.RENDER_ORDER ? Constants.RENDER_ORDER.TRANSPARENT : 3;
    return group;
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

  // ── Event handlers ─────────────────────────────────────────────────────

  /** @private */
  _onBreakdownStart(payload) {
    if (!this._enabled || !this._scene) return;
    const armIndex = resolveArmIndex(this._player, payload);
    if (armIndex < 0) return;
    const count = payload.chunkCount || (Constants.FURNACE_TRANSFER?.CHUNK_COUNT ?? 5);

    const tip = this._strutTipWorld(armIndex, _v3a).clone();

    // Pre-build a pool of chunk meshes parked at the strut tip with a small
    // outward chop jitter + tumble; they wait for their CHUNK event to fly in.
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
    this._pools.set(armIndex, pool);

    // Ghost bag holds at the strut tip until NET_CONSUMED draws it in.
    const bag = this._makeGhostBag();
    bag.position.copy(tip);
    this._scene.add(bag);
    this._bags.set(armIndex, { group: bag, t: 0, dur: 0.6, holding: true, startScale: 1 });
  }

  /** @private */
  _onBreakdownChunk(payload) {
    if (!this._enabled || !this._scene) return;
    const armIndex = resolveArmIndex(this._player, payload);
    if (armIndex < 0) return;
    const pool = this._pools.get(armIndex);
    if (!pool || pool.length === 0) return;
    const mesh = pool.shift();
    if (!mesh) return;

    const start = mesh.position.clone();
    const end = this._motherCenter(_v3b).clone();
    // Control point bulges outward so the chunk arcs into the furnace.
    const mid = start.clone().lerp(end, 0.5);
    const outward = start.clone().sub(end).normalize().multiplyScalar(2.0 * M);
    const ctrl = mid.add(outward);

    this._chunks.push({
      mesh, t: 0, dur: 0.9 + Math.random() * 0.3,
      start, ctrl, end,
      spin: mesh.userData.spin || new THREE.Vector3(2, 1, 3),
      baseScale: mesh.scale.x || 1,
    });

    if (pool.length === 0) this._pools.delete(armIndex);
  }

  /** @private */
  _onNetConsumed(payload) {
    if (!this._enabled) return;
    const armIndex = resolveArmIndex(this._player, payload);
    if (armIndex < 0) return;
    const bag = this._bags.get(armIndex);
    if (bag) { bag.holding = false; bag.t = 0; bag.dur = 0.7; }
  }

  // ── Per-frame animation ─────────────────────────────────────────────────

  update(dt) {
    if (!this._enabled || this._disposed) return;

    // Chunks: quadratic-Bézier flight to the furnace, shrinking + heating.
    for (let i = this._chunks.length - 1; i >= 0; i--) {
      const c = this._chunks[i];
      c.t += dt;
      const u = Math.min(1, c.t / c.dur);
      const iu = 1 - u;
      // B(u) = iu²·start + 2·iu·u·ctrl + u²·end
      _v3a.copy(c.start).multiplyScalar(iu * iu)
        .addScaledVector(c.ctrl, 2 * iu * u)
        .addScaledVector(c.end, u * u);
      c.mesh.position.copy(_v3a);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      const s = c.baseScale * (1 - 0.85 * u);
      c.mesh.scale.setScalar(Math.max(1e-4, s));
      if (c.mesh.material && c.mesh.material.emissiveIntensity != null) {
        c.mesh.material.emissiveIntensity = 0.2 + 1.6 * u;   // warm glow as it nears the furnace
      }
      if (u >= 1) {
        this._disposeMesh(c.mesh);
        this._chunks.splice(i, 1);
      }
    }

    // Ghost bags: hold a gentle pulse at the strut tip; on NET_CONSUMED draw in.
    for (const [armIndex, bag] of this._bags) {
      bag.t += dt;
      if (bag.holding) {
        // Track the strut tip and pulse softly while the chop runs.
        this._strutTipWorld(armIndex, _v3a);
        bag.group.position.copy(_v3a);
        const pulse = 1 + 0.06 * Math.sin(bag.t * 6);
        bag.group.scale.setScalar(pulse);
      } else {
        const u = Math.min(1, bag.t / bag.dur);
        this._strutTipWorld(armIndex, _v3a);
        this._motherCenter(_v3b);
        bag.group.position.copy(_v3a).lerp(_v3b, u);
        bag.group.scale.setScalar(Math.max(1e-4, 1 - u));
        bag.group.traverse((n) => { if (n.material && n.material.opacity != null) n.material.opacity = 0.5 * (1 - u); });
        if (u >= 1) {
          this._disposeMesh(bag.group);
          this._bags.delete(armIndex);
        }
      }
    }
  }
}

export const furnaceBreakdownVisual = new FurnaceBreakdownVisual();
