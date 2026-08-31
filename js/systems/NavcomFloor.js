/**
 * NavcomFloor.js — the Zoom Ladder F6 (NAVCOM) floor content orchestrator
 * (S5, M3, FloorContract.FLOORS[5]).
 *
 * F6 is Earth-anchored orbital-neighborhood planning. This module is the F6
 * "costume" controller: it owns the floor's replacement content while the near
 * field is off and the full debris meshes are hidden
 * (fidelity.debrisMode === 'clusters', costume.transform 'ship-to-icon'):
 *   - debris clusters as ring+count icons (ClusterIcons), ranked to the floor's
 *     labelBudget (7), the aimed one focused;
 *   - the player ship as a velocity chevron (ship-to-icon);
 *   - the transfer-window planner surface (TransferWindows) for the focused
 *     cluster, computed from the player orbit via LaunchWindow;
 *   - FUEL-REACHABILITY (optional getMassBudget dep): per-cluster
 *     ΔV/fuel/time assessments (ReachabilityModel.assess) tinting the icons +
 *     the planner's fuel row, and the reachability envelope orb (ReachOrb) in
 *     the player's orbital plane. Assessments recompute on refresh/focus and
 *     on a throttled budget poll (BUDGET_POLL_MS) — never per frame. Without
 *     the dep the whole layer is inert (no budget/clock reads, no orb DOM);
 *   - the Space verb 'plan-transfer' (00-spec.md §5): commit/plan the focused
 *     cluster's transfer and hand it to `onPlanTransfer` for the serial track to
 *     engage (autopilot) + fan out to legacy consumers (LadderBridge, M7).
 *
 * DESIGN (docs/ladder/03-plan.md, this is the PARALLEL track):
 *   - Every dependency is INJECTED and optional, so the module is unit-testable
 *     headless (no THREE, no DOM, no EventBus). The projector `(worldVec3) ->
 *     {x,y,visible}` is passed in (the serial track builds it from the live
 *     camera); the cluster source is any object exposing getDebrisClusters().
 *   - It emits NO events itself: legacy fan-out (DEBRIS_MAP_CLUSTER_SELECTED /
 *     CLUSTER_WINDOW_*) belongs in LadderBridge and only lands in the commit that
 *     HIDES the legacy DebrisMap (05-bridge.md) — which this flag-off content does
 *     not. The verb instead calls the injected `onPlanTransfer(cluster, window)`.
 *
 * LadderController drives this: it activates the floor when the arrival floor's
 * debrisMode is 'clusters' (F6) and ticks update() each frame while active.
 *
 * @module systems/NavcomFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { ClusterIcons } from '../ui/ClusterIcons.js';
import { TransferWindows } from '../ui/TransferWindows.js';
import { ReachOrb } from '../ui/ReachOrb.js';
import { computeTransferWindow, clusterToOrbitKm } from '../entities/LaunchWindow.js';
import { orbitToKm, sceneToKm } from '../entities/OrbitalMechanics.js';
import { assess } from '../entities/ReachabilityModel.js';

/** F6 index in FloorContract.FLOORS (id 6). */
const F6 = FloorContract.FLOORS[5];

/**
 * FUEL-REACHABILITY: minimum real-time interval between getMassBudget() polls
 * while F6 is active. Assessments recompute on refresh/focus and whenever a
 * poll sees the ΔV budget move (a burn, cargo change) — never per frame.
 * Own-module tunable (house rule: not FloorContract/Constants).
 */
export const BUDGET_POLL_MS = 1000;

/** Monotonic ms clock (headless-safe; injectable for tests). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class NavcomFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.clusterSource] - exposes getDebrisClusters()
   * @param {object} [deps.player]        - exposes orbit / getOrbitalElements() (+ getPosition/getVelocity)
   * @param {function} [deps.project]     - default world→screen projector (worldVec3)->{x,y,visible}
   * @param {object} [deps.clusterIcons]  - ClusterIcons instance (default: fresh)
   * @param {object} [deps.transferWindows] - TransferWindows instance (default: fresh)
   * @param {function} [deps.onPlanTransfer] - verb sink: (cluster, window) => void
   * @param {function} [deps.getMassBudget] - OPTIONAL fuel-reachability source:
   *                 () => ArmManager.getMassBudget(). When present, per-cluster
   *                 ΔV/fuel/time assessments + the reachability orb light up;
   *                 when absent, behavior is byte-identical to the pre-F6-reach
   *                 module (no budget reads, no orb DOM, no clock reads).
   * @param {object} [deps.reachOrb]      - ReachOrb instance (default: fresh)
   * @param {function} [deps.now]         - monotonic ms clock (tests)
   */
  constructor(deps = {}) {
    this._clusterSource = deps.clusterSource || null;
    this._player = deps.player || null;
    this._project = deps.project || null;
    this._icons = deps.clusterIcons || new ClusterIcons();
    this._windows = deps.transferWindows || new TransferWindows();
    this._onPlanTransfer = deps.onPlanTransfer || null;
    this._getMassBudget = deps.getMassBudget || null;
    this._orb = deps.reachOrb || new ReachOrb();
    this._now = deps.now || _nowMs;

    this._active = false;
    this._clusters = [];
    this._focusId = null;    // id of the aimed/focused cluster (SELECTION)

    // FUEL-REACHABILITY state (all inert without the getMassBudget dep).
    this._budget = null;              // last getMassBudget() sample
    this._assessments = new Map();    // clusterId → ReachabilityModel.assess()
    this._lastBudgetPollMs = -Infinity;

    // Click-to-select: cluster icon hitboxes route back into focusById (which
    // re-drives TransferWindows + the plan-transfer verb target). Wiring the
    // callback changes nothing headless and paints nothing extra.
    if (typeof this._icons.setOnSelect === 'function') {
      this._icons.setOnSelect((id) => this.focusById(id));
    }
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** The view instances (for the serial track to mount / tests). */
  get clusterIcons() { return this._icons; }
  get transferWindows() { return this._windows; }
  get reachOrb() { return this._orb; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Enter F6: show the costume + take a first cluster sample. */
  activate() {
    if (this._active) return;
    this._active = true;
    this.refreshClusters();
    if (this._icons.show) this._icons.show();
    if (this._windows.show) this._windows.show();
    // The orb exists only with the fuel-reachability dep: without it, no DOM
    // is mounted and no budget is read (byte-identical to the pre-reach floor).
    if (this._getMassBudget && this._orb.show) this._orb.show();
  }

  /** Leave F6: hide the costume (state kept so re-entry is cheap). */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._icons.hide) this._icons.hide();
    if (this._windows.hide) this._windows.hide();
    if (this._orb.hide) this._orb.hide();
  }

  // ── Cluster data + focus ─────────────────────────────────────────────────────

  /** Re-poll the cluster source, preserving focus by id (fallback: top cluster). */
  refreshClusters() {
    const list = (this._clusterSource && this._clusterSource.getDebrisClusters)
      ? (this._clusterSource.getDebrisClusters() || [])
      : [];
    this._clusters = list;
    if (list.length === 0) {
      this._focusId = null;
      this._recomputeAssessments();
      return;
    }
    // Keep the current focus if it still exists; otherwise focus the top-ranked.
    if (this._focusId == null || !list.some((c) => c.id === this._focusId)) {
      const ranked = ClusterIcons.rank(list, list.length);
      this._focusId = ranked.length ? ranked[0].id : null;
    }
    this._recomputeAssessments();
  }

  /** @returns {object|null} the focused cluster. */
  getFocusedCluster() {
    if (this._focusId == null) return null;
    return this._clusters.find((c) => c.id === this._focusId) || null;
  }

  /** Focus a cluster by id (click / minimap re-aim). @returns {boolean} found */
  focusById(id) {
    if (!this._clusters.some((c) => c.id === id)) return false;
    this._focusId = id;
    this._recomputeAssessments();
    return true;
  }

  /** Step focus through the ranked list (+1 / -1). */
  focusStep(dir) {
    const ranked = ClusterIcons.rank(this._clusters, this._clusters.length);
    if (ranked.length === 0) return;
    let i = ranked.findIndex((c) => c.id === this._focusId);
    if (i < 0) i = 0;
    i = Math.min(ranked.length - 1, Math.max(0, i + (dir < 0 ? -1 : 1)));
    this._focusId = ranked[i].id;
    this._recomputeAssessments();
  }

  // ── Fuel reachability (inert without the getMassBudget dep) ────────────────

  /** @returns {Map} clusterId → ReachabilityModel.assess() result (live cache). */
  getAssessments() { return this._assessments; }

  /** @returns {object|null} the last getMassBudget() sample. */
  getBudget() { return this._budget; }

  /**
   * @private Recompute the per-cluster assessment cache against a fresh budget
   * sample. Called on refresh/focus/budget-change — never per frame. A total
   * no-op (no budget read, cache stays empty) without the dep.
   * @param {object} [budget] - pre-read budget (poll path); default re-reads
   */
  _recomputeAssessments(budget) {
    this._assessments.clear();
    if (!this._getMassBudget) { this._budget = null; return; }
    this._budget = budget || this._getMassBudget() || null;
    if (!this._budget) return;
    for (const c of this._clusters) {
      const win = this.computeWindow(c);
      const a = assess({ budget: this._budget, win });
      if (a) this._assessments.set(c.id, a);
    }
  }

  /**
   * @private Throttled budget poll from the per-frame tick: at most one
   * getMassBudget() read per BUDGET_POLL_MS; assessments recompute only when
   * the ΔV budget actually moved (burn / cargo change). No-op without the dep
   * — no clock read, no budget read (byte-identical).
   */
  _maybePollBudget() {
    if (!this._getMassBudget) return;
    const now = this._now();
    if (now - this._lastBudgetPollMs < BUDGET_POLL_MS) return;
    this._lastBudgetPollMs = now;
    const b = this._getMassBudget() || null;
    const moved = !this._budget || !b
      || b.deltaV !== this._budget.deltaV
      || b.wetMass !== this._budget.wetMass;
    if (moved) this._recomputeAssessments(b);
  }

  /** @private Player orbit radius (km) for the envelope; 0 when unknown. */
  _playerOrbitRadiusKm() {
    if (!this._player) return 0;
    const o = this._player.orbit
      || (this._player.getOrbitalElements && this._player.getOrbitalElements());
    return (o && o.semiMajorAxis > 0) ? sceneToKm(o.semiMajorAxis) : 0;
  }

  // ── Transfer window ──────────────────────────────────────────────────────────

  /**
   * Compute the transfer window from the player orbit to a cluster.
   * @param {object|null} cluster
   * @returns {object|null} computeTransferWindow() result, or null
   */
  computeWindow(cluster) {
    if (!cluster || !this._player) return null;
    const playerOrbit = this._player.orbit || (this._player.getOrbitalElements && this._player.getOrbitalElements());
    if (!playerOrbit || !(playerOrbit.semiMajorAxis > 0)) return null;
    const chaserKm = orbitToKm(playerOrbit);
    const targetKm = clusterToOrbitKm(cluster);
    if (!(targetKm.semiMajorAxis > 0)) return null;
    return computeTransferWindow(chaserKm, targetKm);
  }

  // ── Per-frame ────────────────────────────────────────────────────────────────

  /**
   * Render one frame of the F6 costume. No-op while inactive.
   * @param {object} [ctx]
   * @param {function} [ctx.project] - world→screen (overrides the dep for this frame)
   * @param {{x,y,z}} [ctx.shipPos]  - ship world position (chevron)
   * @param {number} [ctx.shipAngleRad] - ship velocity heading on screen
   * @returns {{icons:Array, window:object, orb:object|null}|null} rendered descriptors (tests)
   */
  update(ctx = {}) {
    if (!this._active) return null;
    // FUEL-REACHABILITY: throttled budget poll (no-op without the dep) so a
    // burn/cargo change refreshes assessments without per-frame recompute.
    this._maybePollBudget();
    const project = ctx.project || this._project;
    const icons = this._icons.render(this._clusters, project, {
      budget: F6.labelBudget,
      focusId: this._focusId,
      assessments: this._getMassBudget ? this._assessments : null,
    });
    if (ctx.shipPos && project && this._icons.renderShip) {
      this._icons.renderShip(project(ctx.shipPos), ctx.shipAngleRad || 0);
    }
    const focused = this.getFocusedCluster();
    const win = this.computeWindow(focused);
    const window = this._windows.refresh(win, {
      targetName: focused ? focused.name : undefined,
      assessment: focused ? (this._assessments.get(focused.id) || null) : null,
      budget: this._budget,
    });
    // Reachability orb: envelope rings in the player's orbital plane. Gated on
    // the dep (never mounts/paints without it) + a live budget/orbit/projector.
    let orb = null;
    if (this._getMassBudget && this._budget && project && this._orb.update) {
      const posU = ctx.shipPos
        || (this._player && this._player.getPosition && this._player.getPosition());
      const velU = (this._player && this._player.getVelocity && this._player.getVelocity()) || null;
      const playerOrbitKm = this._playerOrbitRadiusKm();
      if (posU && playerOrbitKm > 0) {
        orb = this._orb.update({ project, posU, velU, budget: this._budget, playerOrbitKm });
      }
    }
    return { icons, window, orb };
  }

  // ── The Space verb: plan-transfer ────────────────────────────────────────────

  /**
   * Dispatch the F6 Space verb (FloorContract.FLOORS[5].spaceVerb 'plan-transfer').
   * Selects the focused cluster, computes its transfer window, refreshes the
   * planner surface, and hands (cluster, window) to the injected sink for the
   * serial track to engage autopilot + fan out to legacy consumers.
   * @returns {{cluster:object, window:object|null}|null} null when nothing is aimed
   */
  planTransfer() {
    if (!this._active) this.refreshClusters();
    const cluster = this.getFocusedCluster();
    if (!cluster) return null;
    const window = this.computeWindow(cluster);
    // Surface it immediately (the readout doubles as the "plan committed" cue).
    if (this._windows.refresh) {
      this._windows.refresh(window, {
        targetName: cluster.name,
        assessment: this._assessments.get(cluster.id) || null,
        budget: this._budget,
      });
    }
    if (typeof this._onPlanTransfer === 'function') this._onPlanTransfer(cluster, window);
    return { cluster, window };
  }

  /** Tear down the owned views. */
  dispose() {
    if (this._icons.dispose) this._icons.dispose();
    if (this._windows.dispose) this._windows.dispose();
    if (this._orb.dispose) this._orb.dispose();
  }
}
