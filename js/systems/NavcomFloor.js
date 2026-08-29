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
import { computeTransferWindow, clusterToOrbitKm } from '../entities/LaunchWindow.js';
import { orbitToKm } from '../entities/OrbitalMechanics.js';

/** F6 index in FloorContract.FLOORS (id 6). */
const F6 = FloorContract.FLOORS[5];

export class NavcomFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.clusterSource] - exposes getDebrisClusters()
   * @param {object} [deps.player]        - exposes orbit / getOrbitalElements() (+ getPosition/getVelocity)
   * @param {function} [deps.project]     - default world→screen projector (worldVec3)->{x,y,visible}
   * @param {object} [deps.clusterIcons]  - ClusterIcons instance (default: fresh)
   * @param {object} [deps.transferWindows] - TransferWindows instance (default: fresh)
   * @param {function} [deps.onPlanTransfer] - verb sink: (cluster, window) => void
   */
  constructor(deps = {}) {
    this._clusterSource = deps.clusterSource || null;
    this._player = deps.player || null;
    this._project = deps.project || null;
    this._icons = deps.clusterIcons || new ClusterIcons();
    this._windows = deps.transferWindows || new TransferWindows();
    this._onPlanTransfer = deps.onPlanTransfer || null;

    this._active = false;
    this._clusters = [];
    this._focusId = null;    // id of the aimed/focused cluster (SELECTION)
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** The two view instances (for the serial track to mount / tests). */
  get clusterIcons() { return this._icons; }
  get transferWindows() { return this._windows; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Enter F6: show the costume + take a first cluster sample. */
  activate() {
    if (this._active) return;
    this._active = true;
    this.refreshClusters();
    if (this._icons.show) this._icons.show();
    if (this._windows.show) this._windows.show();
  }

  /** Leave F6: hide the costume (state kept so re-entry is cheap). */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._icons.hide) this._icons.hide();
    if (this._windows.hide) this._windows.hide();
  }

  // ── Cluster data + focus ─────────────────────────────────────────────────────

  /** Re-poll the cluster source, preserving focus by id (fallback: top cluster). */
  refreshClusters() {
    const list = (this._clusterSource && this._clusterSource.getDebrisClusters)
      ? (this._clusterSource.getDebrisClusters() || [])
      : [];
    this._clusters = list;
    if (list.length === 0) { this._focusId = null; return; }
    // Keep the current focus if it still exists; otherwise focus the top-ranked.
    if (this._focusId == null || !list.some((c) => c.id === this._focusId)) {
      const ranked = ClusterIcons.rank(list, list.length);
      this._focusId = ranked.length ? ranked[0].id : null;
    }
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
   * @returns {{icons:Array, window:object}|null} rendered descriptors (tests)
   */
  update(ctx = {}) {
    if (!this._active) return null;
    const project = ctx.project || this._project;
    const icons = this._icons.render(this._clusters, project, {
      budget: F6.labelBudget,
      focusId: this._focusId,
    });
    if (ctx.shipPos && project && this._icons.renderShip) {
      this._icons.renderShip(project(ctx.shipPos), ctx.shipAngleRad || 0);
    }
    const focused = this.getFocusedCluster();
    const win = this.computeWindow(focused);
    const window = this._windows.refresh(win, { targetName: focused ? focused.name : undefined });
    return { icons, window };
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
    if (this._windows.refresh) this._windows.refresh(window, { targetName: cluster.name });
    if (typeof this._onPlanTransfer === 'function') this._onPlanTransfer(cluster, window);
    return { cluster, window };
  }

  /** Tear down the owned views. */
  dispose() {
    if (this._icons.dispose) this._icons.dispose();
    if (this._windows.dispose) this._windows.dispose();
  }
}
