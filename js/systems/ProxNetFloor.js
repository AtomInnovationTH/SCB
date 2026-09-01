/**
 * ProxNetFloor.js — the Zoom Ladder F5 (PROX NET) floor content orchestrator
 * (S4, FloorContract.FLOORS[4]).
 *
 * F5 is the ship-anchored tactical floor (100 m – 120 km, debrisMode
 * 'tactical'): threat/density context around the ship, approach-corridor
 * picking against the aimed cluster, cluster context at range. This module is
 * the F5 "costume" controller — it owns the floor's tactical overlay
 * (ProxOverlay) and the data behind it:
 *   - VALUE MARKERS: DebrisField.getEnhancedTargetList() entries
 *     (estimatedPoints/risk) merged with each target's LIVE canonical debris
 *     ref (getDebrisById → _scenePosition), so marker positions track orbits
 *     per frame while the LIST itself re-polls on a throttle;
 *   - DENSITY SHELLS: FieldRiskModel shell counts around the ship
 *     (getDebrisNear), drawn as translucent rings in the orbital plane;
 *   - INSERTION PLAN: when a target cluster is aimed, InsertionPlanner's
 *     edge/mid/core arrival candidates with risk-colored trajectories.
 *     The cluster comes from the injected `getFocusedCluster` — the F6→F5
 *     HANDOFF (production wiring: () => navcomFloor.getFocusedCluster(), so
 *     the cluster focused on NAVCOM is the corridor target on PROX NET);
 *   - the Space verb 'approach' (00-spec.md §5, FloorContract F5 spaceVerb):
 *     approach() commits the SELECTED arrival point and hands
 *     (cluster, arrivalPoint) to the injected `onApproach` sink — production
 *     wiring routes it into AutopilotSystem.engageCluster(cluster,
 *     { arrivalPoint }). Verb dispatch itself arrives via LadderController in
 *     the serial pass (see the session HANDOFF): its _dispatchVerb gains a
 *     `verb === 'approach'` case calling proxNet.approach().
 *
 * DESIGN (docs/ladder/03-plan.md, PARALLEL track — the NavcomFloor pattern):
 *   - Every dependency is INJECTED and optional, so the module is
 *     unit-testable headless (no THREE, no DOM, no EventBus) and a dep-less
 *     construction is a byte-identical no-op (no debris reads, no clock
 *     reads, no DOM). The projector is passed per frame by the ticker.
 *   - It emits NO events. LadderController drives the activate/deactivate
 *     LIFECYCLE (arrival floor's fidelity.debrisMode === 'tactical'); main.js
 *     is the single per-frame ticker (update({project, shipPos,
 *     shipAngleRad}) right after cameraSystem.update, the navcom precedent).
 *   - Debris scans (target list, shell counts, insertion risk) run on a
 *     REFRESH_MS throttle + on activate/selection — never per frame. Per
 *     frame is projection + painting only.
 *   - SELECTION is cycled, not clicked (click/keyboard-free per the F5
 *     brief): cycleInsertion(±1) steps edge→mid→core; the serial pass may
 *     bind it to any input it likes. The selected zone survives re-plans.
 *
 * @module systems/ProxNetFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { ProxOverlay } from '../ui/ProxOverlay.js';
import { shellCounts, SHELL_RADII_KM } from '../entities/FieldRiskModel.js';
import { plan as planInsertion } from '../entities/InsertionPlanner.js';

/** F5 index in FloorContract.FLOORS (id 5). */
const F5 = FloorContract.FLOORS[4];

/** Minimum real-time interval between debris re-polls (target list, shell
 *  counts, insertion re-plan) while F5 is active. Own-module tunable (house
 *  rule: not FloorContract/Constants). */
export const REFRESH_MS = 500;

/** Marker search radius: the F5 working range's outer edge (120 km in scene
 *  units) — matches camera.distU[1] of the floor. */
export const TACTICAL_RANGE_U = F5.camera.distU[1];

/** Monotonic ms clock (headless-safe; injectable for tests). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** @private Wrap a plain {x,y,z} for DebrisField.getDebrisNear, whose frame
 *  cache calls position.distanceToSquared() (a Vector3 method) on the arg. */
function vecLike(p) {
  return {
    x: p.x, y: p.y, z: p.z,
    distanceToSquared(v) {
      const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
      return dx * dx + dy * dy + dz * dz;
    },
  };
}

export class ProxNetFloor {
  /**
   * @param {object} [deps] - ALL optional; absent ⇒ byte-identical no-op
   * @param {object} [deps.debrisSource] - DebrisField-shaped: getEnhancedTargetList,
   *                 getDebrisNear, getDebrisById (each individually optional)
   * @param {object} [deps.player]       - getPosition/getVelocity + orbit /
   *                 getOrbitalElements() (ΔV estimates, shell plane)
   * @param {function} [deps.getFocusedCluster] - the F6→F5 handoff: returns the
   *                 aimed cluster (NavcomFloor.getFocusedCluster) or null
   * @param {function} [deps.onApproach] - verb sink: (cluster, arrivalPoint) =>
   *                 void — production: autopilot engageCluster(cluster,
   *                 { arrivalPoint })
   * @param {object} [deps.proxOverlay]  - ProxOverlay instance (default: fresh)
   * @param {function} [deps.now]        - monotonic ms clock (tests)
   */
  constructor(deps = {}) {
    this._debrisSource = deps.debrisSource || null;
    this._player = deps.player || null;
    this._getFocusedCluster = deps.getFocusedCluster || null;
    this._onApproach = deps.onApproach || null;
    this._overlay = deps.proxOverlay || new ProxOverlay();
    this._now = deps.now || _nowMs;

    this._active = false;
    this._markers = [];          // [{entry, debris}] — live canonical refs
    this._shells = [];           // FieldRiskModel shell reads (ship-centered)
    this._plan = null;           // InsertionPlanner.plan() result
    this._selectedZone = null;   // selection survives re-plans by zone id
    this._lastRefreshMs = -Infinity;
    this._lastShipPos = null;    // last ticked ship position (refresh anchor)
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** The view instance (for the serial track to mount / tests). */
  get overlay() { return this._overlay; }

  /** The current insertion plan (read-only probe for rail/context panels). */
  getPlan() { return this._plan; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Enter F5: show the costume + take a first data sample. */
  activate() {
    if (this._active) return;
    this._active = true;
    this.refresh();
    if (this._overlay.show) this._overlay.show();
  }

  /** Leave F5: hide the costume (state kept so re-entry is cheap). */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._overlay.hide) this._overlay.hide();
  }

  // ── Data refresh (throttled — never per frame) ─────────────────────────────

  /**
   * Re-poll the debris source + the focused cluster and rebuild the marker /
   * shell / insertion caches. Called on activate, selection change, and the
   * REFRESH_MS throttle from update(). A total no-op without deps.
   * @param {{x,y,z}} [shipPos] - defaults to the player's live position
   */
  refresh(shipPos) {
    // Stamp the throttle window here so an activate()/approach() refresh also
    // resets the per-frame poll. Dep-less instances read NOTHING — not even
    // the clock (byte-identical no-op).
    if (this._debrisSource || this._getFocusedCluster) this._lastRefreshMs = this._now();
    const pos = shipPos
      || this._lastShipPos
      || (this._player && this._player.getPosition && this._player.getPosition())
      || null;

    // Value markers: enhanced entries merged with live canonical debris refs.
    this._markers = [];
    if (this._debrisSource && this._debrisSource.getEnhancedTargetList && pos) {
      const orbit = this._playerOrbit();
      if (orbit) {
        const entries = this._debrisSource.getEnhancedTargetList(vecLike(pos), orbit) || [];
        for (const entry of entries) {
          const debris = this._debrisSource.getDebrisById
            ? this._debrisSource.getDebrisById(entry.id)
            : null;
          this._markers.push({ entry, debris });
        }
      }
    }

    // Density shells around the ship.
    this._shells = [];
    if (this._debrisSource && this._debrisSource.getDebrisNear && pos) {
      const near = (p, r) => this._debrisSource.getDebrisNear(vecLike(p), r);
      this._shells = shellCounts(near, pos, SHELL_RADII_KM).shells;
    }

    // Insertion plan against the aimed cluster (the F6→F5 handoff).
    this._plan = null;
    const cluster = (typeof this._getFocusedCluster === 'function')
      ? (this._getFocusedCluster() || null)
      : null;
    if (cluster && cluster.center) {
      const near = (this._debrisSource && this._debrisSource.getDebrisNear)
        ? (p, r) => this._debrisSource.getDebrisNear(vecLike(p), r)
        : undefined;
      this._plan = planInsertion({
        cluster,
        playerPos: pos,
        playerOrbit: this._playerOrbit() || undefined,
        getDebrisNear: near,
      });
    }
    // Selection: keep the chosen zone when it still exists; default = edge
    // (index 0 — the safe outermost corridor).
    if (this._plan && this._plan.candidates.length) {
      if (this._selectedZone == null
          || !this._plan.candidates.some((c) => c.zone === this._selectedZone)) {
        this._selectedZone = this._plan.candidates[0].zone;
      }
    } else {
      this._selectedZone = null;
    }
  }

  /** @private Player orbital elements (scene units), or null. */
  _playerOrbit() {
    if (!this._player) return null;
    const o = this._player.orbit
      || (this._player.getOrbitalElements && this._player.getOrbitalElements());
    return (o && o.semiMajorAxis > 0) ? o : null;
  }

  // ── Insertion selection (cycled — click/keyboard-free per the F5 brief) ────

  /** @returns {number} index of the selected candidate (−1 without a plan). */
  getSelectedIndex() {
    if (!this._plan || this._selectedZone == null) return -1;
    return this._plan.candidates.findIndex((c) => c.zone === this._selectedZone);
  }

  /** @returns {object|null} the selected InsertionPlanner candidate. */
  getSelectedInsertion() {
    const i = this.getSelectedIndex();
    return i >= 0 ? this._plan.candidates[i] : null;
  }

  /**
   * Step the insertion selection through the plan's candidates (edge→mid→core,
   * wrapping). No-op without a plan.
   * @param {number} [dir=1] - +1 / −1
   * @returns {object|null} the newly selected candidate
   */
  cycleInsertion(dir = 1) {
    if (!this._plan || !this._plan.candidates.length) return null;
    const n = this._plan.candidates.length;
    let i = this.getSelectedIndex();
    if (i < 0) i = 0;
    else i = ((i + (dir < 0 ? -1 : 1)) % n + n) % n;
    this._selectedZone = this._plan.candidates[i].zone;
    return this._plan.candidates[i];
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  /**
   * Render one frame of the F5 costume. No-op while inactive. Debris scans are
   * throttled (REFRESH_MS); the per-frame work is marker position reads +
   * projection + painting.
   * @param {object} [ctx]
   * @param {function} [ctx.project] - world→screen (worldVec3)->{x,y,visible}
   * @param {{x,y,z}} [ctx.shipPos]  - ship world position
   * @param {number} [ctx.shipAngleRad] - ship velocity heading on screen
   * @returns {{markers:Array, ship:object|null, shells:Array, insertion:object|null}|null}
   *          rendered descriptors (tests), or null while inactive
   */
  update(ctx = {}) {
    if (!this._active) return null;
    if (ctx.shipPos) this._lastShipPos = ctx.shipPos;

    // Throttled data refresh — only when something can actually be read
    // (dep-less instances never touch the clock: byte-identical no-op).
    // refresh() stamps _lastRefreshMs itself, so an activate/approach refresh
    // also resets this window.
    if (this._debrisSource || this._getFocusedCluster) {
      const now = this._now();
      if (now - this._lastRefreshMs >= REFRESH_MS) {
        this.refresh(ctx.shipPos);
      }
    }

    // Live marker positions from the canonical refs (fall back to nothing —
    // a despawned id simply drops off this frame's draw).
    const targets = [];
    for (const m of this._markers) {
      const d = m.debris;
      if (d && d.alive === false) continue;
      const posU = d && d._scenePosition ? d._scenePosition : null;
      if (!posU) continue;
      targets.push({
        id: m.entry.id,
        estimatedPoints: m.entry.estimatedPoints,
        risk: m.entry.risk,
        posU,
      });
    }

    return this._overlay.render({
      targets,
      shipPos: ctx.shipPos || this._lastShipPos || undefined,
      shipAngleRad: ctx.shipAngleRad || 0,
      shipVel: (this._player && this._player.getVelocity && this._player.getVelocity()) || null,
      shells: this._shells,
      insertion: this._plan
        ? { candidates: this._plan.candidates, selectedIndex: this.getSelectedIndex() }
        : null,
      labelBudget: F5.labelBudget,
    }, ctx.project);
  }

  // ── The Space verb: approach ────────────────────────────────────────────────

  /**
   * Dispatch the F5 Space verb (FloorContract.FLOORS[4].spaceVerb 'approach').
   * Commits the SELECTED arrival point against the aimed cluster and hands
   * (cluster, arrivalPoint) to the injected sink — production wiring routes it
   * into AutopilotSystem.engageCluster(cluster, { arrivalPoint }). The verb
   * decision itself arrives via LadderController's _dispatchVerb in the serial
   * pass (session HANDOFF).
   * @returns {{cluster:object, arrivalPoint:object|null}|null} null when
   *          nothing is aimed
   */
  approach() {
    if (!this._active) this.refresh();
    const cluster = (typeof this._getFocusedCluster === 'function')
      ? (this._getFocusedCluster() || null)
      : null;
    if (!cluster) return null;
    // Re-plan if the aimed cluster changed since the last refresh.
    if (!this._plan || this._plan.clusterId !== cluster.id) this.refresh();
    const arrivalPoint = this.getSelectedInsertion();
    if (typeof this._onApproach === 'function') this._onApproach(cluster, arrivalPoint);
    return { cluster, arrivalPoint };
  }

  /** Tear down the owned view. */
  dispose() {
    if (this._overlay.dispose) this._overlay.dispose();
  }
}
