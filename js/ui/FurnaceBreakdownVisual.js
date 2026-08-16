/**
 * FurnaceBreakdownVisual.js — staged furnace breakdown choreography (Item 1).
 *
 * THREE-side renderer for the "chop the catch into pieces and feed it into the
 * mother's furnace" sequence that plays while a daughter sits in HOLDING_CATCH,
 * OR (cargo-continuity S13(c), register item 47) while a whale cooks at the
 * nose berthing collar — the COLLARED mother catch runs the same staged beat
 * with chunks arcing collar seat → bus, carried by a `{ kind: 'collar', podIndex }`
 * anchor instead of an armId (the S7 anchor-abstraction shape — the breakdown
 * events otherwise resolve an arm index).
 * Pure visuals — gameplay (salvage/score/remove) is owned by GameFlowManager's
 * single CATCH_PROCESSED handler. The flight choreography is NOT covered by the
 * Node test harness (it touches THREE + the player render hierarchy); the FSM
 * timing that drives it (ArmUnit._updateHoldingCatch + CaptureNetSystem._tickCollarDigestion)
 * IS tested, the `_collarWorld` anchor fallback chain is pinned by
 * test-FurnaceBreakdownVisual.js (register item 64), and the mission-reset
 * sweep (`_onMissionReset` / `_cancelStation`) is pinned by the same suite
 * (register item 79).
 *
 * Lifecycle (events emitted by ArmUnit._updateHoldingCatch or the collar tick):
 *   CATCH_BREAKDOWN_START { armId, debrisId, chunkCount, [anchor] }
 *     → spawn `chunkCount` small irregular chunk meshes at the strut-tip catch
 *       (or the collar seat) with a brief outward "chop" jitter + tumble, plus a
 *       short-lived "ghost bag" (so the net stays visibly cinched after
 *       CaptureNetVisual has already stowed the real bag on the daughter path —
 *       see plan §risks ghost-bag note; at the collar the real bag stays welded
 *       until NET_CONSUMED).
 *   CATCH_BREAKDOWN_CHUNK { armId, debrisId, index, total, [anchor] }
 *     → launch that chunk on a curve from the station toward the mother's
 *       furnace port (bus center), shrinking + warm glow, then dispose.
 *   NET_CONSUMED { armIndex } / { podIndex } (collar)
 *     → draw the ghost bag toward the mother (shrink + fade), then dispose.
 *   CATCH_BREAKDOWN_CANCEL { armId | anchor } (S13(c), mid-cook [K])
 *     → dispose the station's ghost bag + unflown pool with no draw-in.
 *   GAME_RESET / GAMEOVER_CONTINUE (register item 79)
 *     → the cancel disposal swept per live station: every mission-reset path
 *       drops the rack mid-cook, so no completion event ever arrives for it.
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
    /** Active ghost bags keyed by station (arm index | 'collar'): Map<number|string, { group, t, dur, holding, startScale, worldOf }> */
    this._bags = new Map();
    /** Pending chunk-spawn pools keyed by station (arm index | 'collar'): prebuilt chunk meshes awaiting their CHUNK event. */
    this._pools = new Map();
    /** S13(c): the last live collar seat (the draw-in keeps it after the splice). */
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
    // Register item 79: every mission-reset path drops the rack mid-cook.
    // resetGame() emits GAME_RESET; the GAMEOVER_CONTINUE handler calls
    // armManager.reset() WITHOUT emitting GAME_RESET (KesslerSystem.js:74
    // documents the split) — the sweep must ride BOTH.
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

  /**
   * S13(c) — the collar station's live world position: the collared catch's
   * own `_scenePosition` (what pinCapturedDebris wrote this frame).
   * After the completion splice the docked catch is gone, so fall back to the
   * LAST live seat (the ghost bag's draw-in reads from where the mated body
   * actually was), then the berth collar anchor (the on-axis station — S13(e)
   * moved the pods to ±NET_POD_X_M, so the pod muzzle is 0.45 m off the collar;
   * the pod-0 read survives only for headless mocks without the anchor — the
   * CaptureNet/LassoSystem idiom), then the bus centre.
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
   * Resolve a breakdown-event payload to a station anchor: the daughter rack's
   * strut tip (armIndex, the shipped path) or the S13(c) collar
   * ({anchor:{kind:'collar', podIndex}}). Returns null when nothing resolves.
   * @returns {{ key: number|string, worldOf: (out: THREE.Vector3) => THREE.Vector3 }|null}
   * @private
   */
  _resolveAnchor(payload) {
    if (payload && payload.anchor && payload.anchor.kind === 'collar') {
      return { key: 'collar', worldOf: (out) => this._collarWorld(out) };
    }
    const armIndex = resolveArmIndex(this._player, payload);
    if (armIndex < 0) return null;
    return { key: armIndex, worldOf: (out) => this._strutTipWorld(armIndex, out) };
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
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    const count = payload.chunkCount || (Constants.FURNACE_TRANSFER?.CHUNK_COUNT ?? 5);

    const tip = anchor.worldOf(_v3a).clone();

    // Pre-build a pool of chunk meshes parked at the station with a small
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
    this._pools.set(anchor.key, pool);

    // Ghost bag holds at the station until NET_CONSUMED draws it in.
    const bag = this._makeGhostBag();
    bag.position.copy(tip);
    this._scene.add(bag);
    this._bags.set(anchor.key, { group: bag, t: 0, dur: 0.6, holding: true, startScale: 1, worldOf: anchor.worldOf });
  }

  /** @private */
  _onBreakdownChunk(payload) {
    if (!this._enabled || !this._scene) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    const pool = this._pools.get(anchor.key);
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

    if (pool.length === 0) this._pools.delete(anchor.key);
  }

  /** @private */
  _onNetConsumed(payload) {
    if (!this._enabled) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    const bag = this._bags.get(anchor.key);
    if (bag) { bag.holding = false; bag.t = 0; bag.dur = 0.7; }
  }

  /**
   * @private S13(c) — a mid-cook jettison [K] from the collar ends the beat
   * WITHOUT the furnace draw-in: the body left the furnace, not into it (the
   * ghost bag sitting at the seat with no body would be a continuity lie).
   * Unflown pool chunks dispose; chunks already committed keep flying home.
   */
  _onBreakdownCancel(payload) {
    if (!this._enabled || !this._scene) return;
    const anchor = this._resolveAnchor(payload);
    if (!anchor) return;
    this._cancelStation(anchor.key);
  }

  /**
   * @private The cancel path's per-station disposal: the chop-owning ghost
   * bag and its unflown chunk pool at one key. Chunks already committed to
   * the furnace (`this._chunks`) are deliberately untouched — they keep
   * flying home and self-dispose in update().
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
   * @private Register item 79 — every mission-reset path drops the rack
   * (ArmManager.reset() from BOTH GameFlowManager.resetGame() — which emits
   * GAME_RESET — and the GAMEOVER_CONTINUE handler, which does not), so a
   * mid-chop piece's completion events never fire: without this sweep the
   * chop-owning ghost bag + unflown pool render forever, keyed to a station
   * that may host a fresh cook later — and item 71's release clears the
   * piece's `_breakdownActive`, so the instanced original renders whole
   * again beside the leaked meshes (a second copy). Runs the
   * CATCH_BREAKDOWN_CANCEL disposal per live station; committed chunks keep
   * flying (the cancel path's own discipline — the reset teleports the view,
   * so their self-disposal is off-camera).
   */
  _onMissionReset() {
    if (this._bags.size === 0 && this._pools.size === 0) return;
    for (const key of new Set([...this._bags.keys(), ...this._pools.keys()])) {
      this._cancelStation(key);
    }
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

    // Ghost bags: hold a gentle pulse at the station; on NET_CONSUMED draw in.
    for (const [key, bag] of this._bags) {
      bag.t += dt;
      const world = bag.worldOf || ((out) => this._strutTipWorld(key, out));
      if (bag.holding) {
        // Track the station and pulse softly while the chop runs.
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
