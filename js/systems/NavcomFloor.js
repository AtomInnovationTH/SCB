/**
 * NavcomFloor.js — the Zoom Ladder NAVCOM floor (id 4) content orchestrator
 * (S5, M3, FloorContract.FLOORS[5]).
 *
 * NAVCOM is Earth-anchored orbital-neighborhood planning. This module is its
 * "costume" controller: it owns the floor's replacement content while the near
 * field is off and the full debris meshes are hidden
 * (fidelity.debrisMode === 'clusters', costume.transform 'ship-to-icon'):
 *   - debris clusters as ring+count icons (ClusterIcons), ranked to the floor's
 *     labelBudget (7), the aimed one focused; u10 D2: each drawn field sits at
 *     its members' live mean (recomputed ≤ 2 Hz, carried on between);
 *   - the player ship as a velocity chevron (ship-to-icon), labelled `You`;
 *   - the transfer-window planner surface (TransferWindows) for the focused
 *     cluster, computed from the player orbit via LaunchWindow;
 *   - FUEL-REACHABILITY (optional getMassBudget dep): per-cluster
 *     ΔV/fuel/time assessments (ReachabilityModel.assess) tinting the icons +
 *     the planner's fuel row, and the reachability envelope orb (ReachOrb) in
 *     the player's orbital plane. Assessments recompute on refresh/focus and
 *     on a throttled budget poll (BUDGET_POLL_MS) — never per frame. Without
 *     the dep the whole layer is inert (no budget/clock reads, no orb DOM);
 *   - OrbitMFD retirement: the two whole-FIELD planners ported to
 *     systems/OrbitPlanners.js (computeRoutePlan / computeSweepBands),
 *     recomputed from the flattened cluster-target list on refreshClusters()
 *     (activate + re-poll) and on a throttled poll (FIELD_PLAN_REFRESH_MS) —
 *     never per frame — and fed to the planner surface as `opts.route` /
 *     `opts.sweep` (same plumbing as `assessment`);
 *   - the Space verb 'plan-transfer' (00-spec.md §5): commit/plan the focused
 *     cluster's transfer and hand it to `onPlanTransfer` for the serial track to
 *     engage (autopilot) + fan out to legacy consumers (LadderBridge, M7).
 *
 * DESIGN (docs/ladder/03-plan.md, this is the PARALLEL track):
 *   - Every dependency is INJECTED and optional, so the module is unit-testable
 *     headless (no DOM, no EventBus; THREE only inside the pure EarthTurn maths the
 *     u10 framing uses). The projector `(worldVec3) ->
 *     {x,y,visible}` is passed in (the serial track builds it from the live
 *     camera); the cluster source is any object exposing getDebrisClusters().
 *   - It emits NO events itself: legacy fan-out (DEBRIS_MAP_CLUSTER_SELECTED /
 *     CLUSTER_WINDOW_*) belongs in LadderBridge and only lands in the commit that
 *     HIDES the legacy DebrisMap (05-bridge.md) — which this flag-off content does
 *     not. The verb instead calls the injected `onPlanTransfer(cluster, window)`.
 *
 * LadderController drives this: it activates the floor when the arrival floor's
 * debrisMode is 'clusters' (NAVCOM) and ticks update() each frame while active.
 *
 * @module systems/NavcomFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { ClusterIcons } from '../ui/ClusterIcons.js';
import { TransferWindows } from '../ui/TransferWindows.js';
import { ReachOrb } from '../ui/ReachOrb.js';
import { computeTransferWindow, clusterToOrbitKm, coOrbitalReadout } from '../entities/LaunchWindow.js';
import { orbitToKm, sceneToKm, orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';
import { assess } from '../entities/ReachabilityModel.js';
import { computeRoutePlan, computeSweepBands } from './OrbitPlanners.js';
import { Constants } from '../core/Constants.js';
import { distanceFromZ01 } from '../core/ZoomLadder.js';
import { earthFrame } from './EarthTurn.js';
import { clamp } from '../core/MathUtil.js';

/** The NAVCOM (id 4) contract row — by id, never by index (Session H). */
const FLOOR = FloorContract.byId(4);

/** u10: Earth's centre, scene units (the floor's anchor). Frozen: the projector only reads it. */
const EARTH_CENTRE = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * u10 D2 (owner pick "Floor 4 easier to read", 2026-10-20): minimum real-time
 * interval between recomputes of the drawn fields' centres from their members'
 * current positions (≤ 2 Hz). Before u10 the centre was read once in activate()
 * and drifted thousands of km off the field while you watched (u8 measured it).
 */
export const LIVE_CENTRE_MS = 500;
/**
 * u10 D2: between recomputes the centre is carried on by the rotation seen
 * between the last two (on floor 4 a field sweeps ~13° per real second —
 * measured 2026-10-20, tmp/u10/data/p1-*.json); never further than this past
 * the last recompute (a stalled tick must not fling the marker).
 */
export const LIVE_EXTRAP_MAX_MS = 1000;
/** u10 D2: a correction at a recompute (first rate, a member lost) is blended out with this time constant (s). */
export const LIVE_BLEND_S = 0.12;

/**
 * u10 D3: the HUD panels the floor-4 framing keeps the markers off — the same list the
 * browser proof measures overlap against (tmp/u10). Only the visible ones count (shown,
 * opacity ≥ 0.05, non-zero size); the step chips inside #hud-hint-ticker are added.
 */
export const FRAMING_PANEL_IDS = Object.freeze([
  'hud-vitals', 'hud-comms-panel', 'hud-next-pane', 'hud-targets-panel', 'ladder-transfer-windows',
  'ladder-rail', 'ladder-workbench-tab', 'ladder-detail-slider', 'hud-arms-panel', 'hud-fma-strip',
  'hud-score-panel', 'hud-payoff',
]);

/**
 * FUEL-REACHABILITY: minimum real-time interval between getMassBudget() polls
 * while the NAVCOM floor is active. Assessments recompute on refresh/focus and whenever a
 * poll sees the ΔV budget move (a burn, cargo change) — never per frame.
 * Own-module tunable (house rule: not FloorContract/Constants).
 */
export const BUDGET_POLL_MS = 1000;

/**
 * OrbitMFD retirement: minimum real-time interval between the whole-field
 * route/sweep planner recomputes from the per-frame tick (the route walk +
 * band binning touch every cluster's targets — not a per-frame cost). Also
 * recomputed on refreshClusters() (activate + re-poll), so a fresh cluster
 * sample never waits out the throttle. Own-module tunable.
 */
export const FIELD_PLAN_REFRESH_MS = 2000;

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
   *                 when absent, the reach layer is fully inert (no budget
   *                 reads, no orb DOM). The field planners' clock poll is
   *                 dep-independent by design (OrbitMFD retirement).
   * @param {object} [deps.reachOrb]      - ReachOrb instance (default: fresh)
   * @param {function} [deps.now]         - monotonic ms clock (tests)
   */
  constructor(deps = {}) {
    this._clusterSource = deps.clusterSource || null;
    this._player = deps.player || null;
    this._project = deps.project || null;
    this._icons = deps.clusterIcons || new ClusterIcons({ simple: deps.simple });   // u7 D1: the simple-level getter rides in
    this._windows = deps.transferWindows || new TransferWindows({ simple: deps.simple });   // u6 D7: the simple-level getter rides in
    this._onPlanTransfer = deps.onPlanTransfer || null;
    this._getMassBudget = deps.getMassBudget || null;
    this._orb = deps.reachOrb || new ReachOrb();
    this._now = deps.now || _nowMs;
    // Nets step 3 slice 2b (lane 2b-2): the "where next" list (ui/WhereNextList.js) this floor hosts - set by main.js once built.
    this._whereNext = null;
    this._whereNextHeld = false;     // slice 5 (lane 5c): the fate list holds the where-next list hidden
    this._heightScale = null;         // lane 3e: the fields and the satellite by height beside her marker (ui/HeightScale.js)

    this._active = false;
    this._clusters = [];
    this._focusId = null;    // id of the aimed/focused cluster (SELECTION)

    // FUEL-REACHABILITY state (all inert without the getMassBudget dep).
    this._budget = null;              // last getMassBudget() sample
    this._assessments = new Map();    // clusterId → ReachabilityModel.assess()
    this._lastBudgetPollMs = -Infinity;

    // OrbitMFD retirement: whole-FIELD planner state (route + sweep), computed
    // from the flattened cluster-target list — never per frame.
    this._routePlan = null;           // computeRoutePlan() result, or null pre-first-refresh
    this._sweepPlan = null;           // computeSweepBands() result, or null pre-first-refresh
    this._lastFieldPlanMs = -Infinity;

    // u10 D2: live field centres — id → { c0, t0, c1, t1, ref, nu1, kPhase, off, offT, cur } (members' mean
    // at the last two recomputes, the field's clock: a reference member, its phase then and the centre's
    // turn per unit of it; the blended correction, the per-frame position). ≤ 2 Hz recompute.
    this._live = new Map();
    this._lastLiveMs = -Infinity;
    this._livePos = { x: 0, y: 0, z: 0 };   // scratch for orbitToSceneCartesianInto
    this._liveVel = { x: 0, y: 0, z: 0 };
    this._focusDesc = null;                 // u10 D3: the focused icon descriptor as last painted

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

  /** Enter NAVCOM: show the costume + take a first cluster sample. */
  activate() {
    if (this._active) return;
    this._active = true;
    this._live.clear();                 // u10 D2: a fresh visit starts from the members, not an old track
    this._lastLiveMs = -Infinity;
    this.refreshClusters();
    if (this._icons.show) this._icons.show();
    if (this._windows.show) this._windows.show();
    // The orb exists only with the fuel-reachability dep: without it, no DOM
    // is mounted and no budget is read (byte-identical to the pre-reach floor).
    if (this._getMassBudget && this._orb.show) this._orb.show();
    if (this._whereNext) this._whereNext.setFloorShown(!this._whereNextHeld);     // pending choice: the list is there again on return (unless the fate list holds it)
    if (this._heightScale) this._heightScale.show();
  }

  /** Leave NAVCOM: hide the costume (state kept so re-entry is cheap). */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._icons.hide) this._icons.hide();
    if (this._windows.hide) this._windows.hide();
    if (this._orb.hide) this._orb.hide();
    if (this._whereNext) this._whereNext.setFloorShown(false);    // a pending choice stays pending; only the panel goes
    if (this._heightScale) this._heightScale.hide();
  }

  // ── The "where next" list (Nets step 3 slice 2b, lane 2b-2) ─────────────────────

  /** main.js: the list this floor hosts (null = none). Its floor-shown state follows this floor from here on. */
  setWhereNext(list) {
    this._whereNext = list || null;
    if (this._whereNext) this._whereNext.setFloorShown(this._active && !this._whereNextHeld);
  }

  /**
   * Slice 5 (lane 5c): the fate list is open on top of the where-next list's place. While `hold` is true the where-next list stays hidden
   * (the choice stays pending); when it is false again the list is back if this floor is shown (rebuilt, as on any return).
   * @param {boolean} hold
   */
  holdWhereNext(hold) {
    this._whereNextHeld = !!hold;
    if (this._whereNext) this._whereNext.setFloorShown(this._active && !this._whereNextHeld);
  }

  /** main.js: the height scale this floor hosts (null = none; ui/HeightScale.js, lane 3e). It draws only with the fields flag on. */
  setHeightScale(scale) {
    this._heightScale = scale || null;
    if (this._heightScale && this._active) this._heightScale.show();
  }

  /** The list is open (a choice is pending and this floor is shown): Tab, Space and the FLY THERE chip belong to it. */
  choosing() { return !!(this._active && this._whereNext && this._whereNext.isOpen()); }
  /** Tab / Shift+Tab while choosing: move over the rows that can be picked. @returns {boolean} */
  choiceStep(dir) { return this.choosing() ? this._whereNext.focusStep(dir) : false; }
  /** Space while choosing: pick the focused row. @returns {boolean} the pick was made */
  choicePick() { return this.choosing() ? this._whereNext.pickFocused() : false; }
  /** The FLY THERE chip's word while choosing ('STAY' / 'FLY THERE'), else null (the chip then follows the focused cluster). */
  choiceLabel() { return this.choosing() ? this._whereNext.chipLabel() : null; }

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
      this._recomputeFieldPlans();
      return;
    }
    // Keep the current focus if it still exists; otherwise focus the top-ranked.
    if (this._focusId == null || !list.some((c) => c.id === this._focusId)) {
      const ranked = ClusterIcons.rank(list, list.length);
      this._focusId = ranked.length ? ranked[0].id : null;
    }
    this._recomputeAssessments();
    this._recomputeFieldPlans();
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

  // ── OrbitMFD retirement: whole-FIELD planners (route + sweep) ──────────────

  /** @returns {{plan:Array, totalDv:number}|null} the last computeRoutePlan() result. */
  getRoutePlan() { return this._routePlan; }

  /** @returns {{bands:Array, densest:object|null}|null} the last computeSweepBands() result. */
  getSweepPlan() { return this._sweepPlan; }

  /** @private Flatten every cluster's `.targets` (debris objects with `.orbit`) into one list. */
  _flattenClusterTargets() {
    const out = [];
    for (const c of this._clusters) {
      if (c && Array.isArray(c.targets)) out.push(...c.targets);
    }
    return out;
  }

  /**
   * @private Recompute the whole-field route/sweep plans from the flattened
   * cluster-target list against the player's current orbit. Called on
   * refreshClusters() (activate + re-poll) and from the throttled per-frame
   * poll — never per frame. No player orbit → both plans null (nothing to
   * plan from).
   */
  _recomputeFieldPlans() {
    const playerOrbit = this._player
      && (this._player.orbit || (this._player.getOrbitalElements && this._player.getOrbitalElements()));
    if (!playerOrbit || !(playerOrbit.semiMajorAxis > 0)) {
      this._routePlan = null;
      this._sweepPlan = null;
      return;
    }
    const targets = this._flattenClusterTargets();
    this._routePlan = computeRoutePlan(targets, playerOrbit);
    const pAltKm = sceneToKm(playerOrbit.semiMajorAxis) - Constants.EARTH_RADIUS_KM;
    this._sweepPlan = computeSweepBands(targets, pAltKm);
  }

  /**
   * @private Throttled field-plan poll from the per-frame tick: at most one
   * recompute per FIELD_PLAN_REFRESH_MS, so the route/sweep track the player's
   * orbit as it drifts between cluster re-polls without per-frame cost.
   */
  _maybeRefreshFieldPlans() {
    const now = this._now();
    if (now - this._lastFieldPlanMs < FIELD_PLAN_REFRESH_MS) return;
    this._lastFieldPlanMs = now;
    this._recomputeFieldPlans();
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

  // ── u10 D2: live field centres ─────────────────────────────────────────────

  /**
   * @private The members' mean position now (scene units), from each alive
   * member's own orbit — the same sum getDebrisClusters() makes, for ONE
   * cluster, without walking the debris list. null when no member can say.
   */
  _membersMean(c) {
    const ms = c && Array.isArray(c.targets) ? c.targets : null;
    if (!ms || ms.length === 0) return null;
    let n = 0, x = 0, y = 0, z = 0;
    const p = this._livePos;
    for (const d of ms) {
      if (!d || d.alive === false || !d.orbit) continue;
      orbitToSceneCartesianInto(d.orbit, p, this._liveVel);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      x += p.x; y += p.y; z += p.z; n++;
    }
    return n ? { x: x / n, y: y / n, z: z / n } : null;
  }

  /** @private The first alive member with a phase (the field's clock), or null. */
  static _refMember(c) {
    const ms = c && Array.isArray(c.targets) ? c.targets : null;
    if (ms) for (const d of ms) if (Number.isFinite(NavcomFloor._phase(d))) return d;
    return null;
  }

  /**
   * @private The rotation angle (rad) and unit axis seen between a track's last two
   * recomputes, or null (no pair, no motion, or a jump over 90°: a member lost, not motion).
   */
  static _turn(e) {
    if (!e.c0 || !(e.t1 > e.t0)) return null;
    const c0 = e.c0, c1 = e.c1;
    const kx = c0.y * c1.z - c0.z * c1.y, ky = c0.z * c1.x - c0.x * c1.z, kz = c0.x * c1.y - c0.y * c1.x;
    const s = Math.hypot(kx, ky, kz);
    if (!(s > 1e-12)) return null;
    const theta = Math.atan2(s, c0.x * c1.x + c0.y * c1.y + c0.z * c1.z);
    if (theta > Math.PI / 2) return null;
    return { theta, kx: kx / s, ky: ky / s, kz: kz / s };
  }

  /** @private A member's phase (true anomaly, rad), or NaN. */
  static _phase(m) {
    const o = m && m.alive !== false ? m.orbit : null;
    const v = o ? o.trueAnomaly : NaN;
    return Number.isFinite(v) ? v : NaN;
  }

  /**
   * @private The track's carried-on centre at `now` (no correction), into `out`: c1 turned
   * about the last axis. How far: by the field's own clock — the reference member's phase
   * moved since the last recompute, times the centre's turn per unit of that phase over the
   * last pair (one number read per frame; exact when game time speeds up after arrival or is
   * held). Without a usable phase: by real time at the last pair's rate, at most
   * LIVE_EXTRAP_MAX_MS ahead.
   */
  static _carry(e, now, out) {
    const c1 = e.c1;
    out.x = c1.x; out.y = c1.y; out.z = c1.z;
    const r = NavcomFloor._turn(e);
    if (!r) return out;
    let phi;
    const nu = NavcomFloor._phase(e.ref);
    if (e.kPhase != null && Number.isFinite(nu)) {
      phi = e.kPhase * NavcomFloor._wrap(nu - e.nu1);
      phi = clamp(Math.PI / 4, 0, phi);
    } else {
      const dt = Math.min(Math.max(now - e.t1, 0), LIVE_EXTRAP_MAX_MS);
      phi = (r.theta / (e.t1 - e.t0)) * dt;
    }
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const { kx, ky, kz } = r;
    // Rodrigues with k ⟂ c1: c1 cosφ + (k × c1) sinφ
    out.x = c1.x * cos + (ky * c1.z - kz * c1.y) * sin;
    out.y = c1.y * cos + (kz * c1.x - kx * c1.z) * sin;
    out.z = c1.z * cos + (kx * c1.y - ky * c1.x) * sin;
    return out;
  }

  /** @private An angle difference wrapped to (−π, π]. */
  static _wrap(d) {
    const t = 2 * Math.PI;
    return d - t * Math.floor((d + Math.PI) / t);
  }

  /** @private Carried-on centre + the fading correction, written to e.cur. */
  _livePosition(e, now) {
    NavcomFloor._carry(e, now, e.cur);
    if (e.off) {
      const f = Math.exp(-Math.max(now - e.offT, 0) / (LIVE_BLEND_S * 1000));
      e.cur.x += e.off.x * f; e.cur.y += e.off.y * f; e.cur.z += e.off.z * f;
    }
    return e.cur;
  }

  /**
   * @private At most every LIVE_CENTRE_MS: recompute the centres of the fields
   * that are drawn (the label-budget ranking, focus kept by id — nothing is
   * re-ranked into focus or re-polled) from their members. Never calls
   * getDebrisClusters() / refreshClusters() / the assessments.
   */
  _maybeRecomputeLiveCentres(now) {
    if (now - this._lastLiveMs < LIVE_CENTRE_MS) return;
    this._lastLiveMs = now;
    const drawn = ClusterIcons.rank(this._clusters, FLOOR.labelBudget);
    const keep = new Set();
    for (const c of drawn) {
      keep.add(c.id);
      const m = this._membersMean(c);
      if (!m) continue;
      const e = this._live.get(c.id);
      if (!e) {
        const ref = NavcomFloor._refMember(c);
        this._live.set(c.id, { c0: null, t0: 0, c1: m, t1: now, ref, nu1: NavcomFloor._phase(ref), kPhase: null, off: null, offT: now, cur: { x: m.x, y: m.y, z: m.z } });
        continue;
      }
      const shown = this._livePosition(e, now);
      const was = { x: shown.x, y: shown.y, z: shown.z };
      e.c0 = e.c1; e.t0 = e.t1; e.c1 = m; e.t1 = now;
      // The field's clock: the reference member's phase now and its step over the last pair.
      const ref = NavcomFloor._refMember(c), nu = NavcomFloor._phase(ref);
      const r = NavcomFloor._turn(e);
      const dNu = (ref === e.ref && Number.isFinite(nu) && Number.isFinite(e.nu1)) ? NavcomFloor._wrap(nu - e.nu1) : NaN;
      e.kPhase = (r && Number.isFinite(dNu) && Math.abs(dNu) > 1e-9 && r.theta / dNu > 0) ? r.theta / dNu : null;
      e.ref = ref; e.nu1 = nu;
      e.off = { x: was.x - m.x, y: was.y - m.y, z: was.z - m.z };
      e.offT = now;
    }
    for (const id of this._live.keys()) if (!keep.has(id)) this._live.delete(id);
  }

  /**
   * u10 D2: a field's live centre (scene units) — its members' mean, recomputed
   * at ≤ 2 Hz and carried on between; `cluster.center` (the activate() sample)
   * when no member can say. A fresh object each call.
   * @param {object|*} clusterOrId
   * @returns {{x:number,y:number,z:number}|null}
   */
  liveCentreOf(clusterOrId) {
    const c = (clusterOrId && typeof clusterOrId === 'object') ? clusterOrId
      : this._clusters.find((k) => k.id === clusterOrId);
    if (!c) return null;
    const e = this._live.get(c.id);
    if (!e) return c.center ? { x: c.center.x, y: c.center.y, z: c.center.z } : null;
    const p = this._livePosition(e, this._now());
    return { x: p.x, y: p.y, z: p.z };
  }

  /** u10 D2: the focused field's live centre (the framing's target). @returns {{x,y,z}|null} */
  getFocusedCentre() {
    const f = this.getFocusedCluster();
    return f ? this.liveCentreOf(f) : null;
  }

  // ── u10 D3: what the floor-4 framing needs ───────────────────────────────────

  /**
   * u10 D3: the visible HUD panels' screen rects (FRAMING_PANEL_IDS + the step chips).
   * Read once per re-frame, never per frame. [] without a DOM.
   * @param {Document} [doc]
   * @returns {Array<{id:string, x:number, y:number, w:number, h:number}>}
   */
  hudPanelRects(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc || typeof doc.getElementById !== 'function') return [];
    const cs = (el) => ((typeof getComputedStyle === 'function') ? getComputedStyle(el) : null);
    const out = [];
    const add = (el, id) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return;
      const b = el.getBoundingClientRect();
      if (!(b.width > 1 && b.height > 1)) return;
      const s = cs(el);
      if (s && (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05)) return;
      if (el.style && el.style.opacity === '0') return;
      out.push({ id, x: b.x, y: b.y, w: b.width, h: b.height });
    };
    for (const id of FRAMING_PANEL_IDS) add(doc.getElementById(id), id);
    const tk = doc.getElementById('hud-hint-ticker');
    if (tk && typeof tk.querySelectorAll === 'function') {
      for (const el of tk.querySelectorAll('[role=button], button')) add(el, 'step-chip');
    }
    return out;
  }

  /**
   * u10 D3: the framing for a re-frame (EarthTurn.earthFrame) from this floor's facts —
   * the focused field's live centre, the focused icon's footprint (its ring and the text
   * last painted beside it), the visible HUD panels, where Earth's centre lands now and the
   * floor's free-zone top. main.js calls it on the u8 trigger and hands `dir` to
   * CameraSystem.ladderTurnEarthDir and `distU` to LadderController.frameZoomTo.
   * @param {object} a
   * @param {{x,y,z}} a.shipPos
   * @param {{x,y,z}} [a.shipVel]
   * @param {function} [a.project]  world→screen (default: the dep)
   * @param {number} [a.fovDeg]     default: the floor's 45
   * @param {number} [a.viewW]      default: window.innerWidth
   * @param {number} [a.viewH]      default: window.innerHeight
   * @param {Array} [a.rects]       default: hudPanelRects()
   * @param {number} [a.maxDistU]   default: the floor's free-zone top (z01 0.85, 210.1 u)
   * @returns {{mode:string, dir:object, distU:number, dShell:number, rhoPx:number}|null}
   */
  framing({ shipPos, shipVel, project, fovDeg, viewW, viewH, rects, maxDistU } = {}) {
    if (!this._active || !shipPos) return null;
    const focused = this.getFocusedCluster();
    const field = focused ? this.liveCentreOf(focused) : null;
    if (!field) return null;
    const W = Number.isFinite(viewW) ? viewW : (typeof window !== 'undefined' ? window.innerWidth : NaN);
    const H = Number.isFinite(viewH) ? viewH : (typeof window !== 'undefined' ? window.innerHeight : NaN);
    const proj = project || this._project;
    const c = proj ? proj(EARTH_CENTRE) : null;
    const centerPx = (c && Number.isFinite(c.x) && Number.isFinite(c.y)) ? { x: c.x, y: c.y } : { x: W / 2, y: H / 2 };
    const d = (this._focusDesc && this._focusDesc.id === focused.id) ? this._focusDesc : null;
    const lines = d ? [d.label, d.estimate].filter(Boolean) : [ClusterIcons.nameLine(focused)];
    const foot = ClusterIcons.footprint({ ringPx: d ? d.ringPx : ClusterIcons.ringPx(focused.count, true), lines });
    const max = Number.isFinite(maxDistU) ? maxDistU
      : distanceFromZ01(FLOOR, 1 - FloorContract.LADDER_GEOMETRY.WALL_ZONE_FRAC);
    return earthFrame({
      ship: shipPos, field, shipVel,
      fovDeg: Number.isFinite(fovDeg) ? fovDeg : FLOOR.camera.fov,
      viewW: W, viewH: H, centerPx,
      rects: Array.isArray(rects) ? rects : this.hudPanelRects(),
      foot, maxDistU: max,
    });
  }

  // ── Per-frame ────────────────────────────────────────────────────────────────

  /**
   * Render one frame of the NAVCOM costume. No-op while inactive.
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
    if (this._whereNext) this._whereNext.tick(this._now());       // the list's rows follow the gas and the pieces, about once a second
    // OrbitMFD retirement: throttled whole-field route/sweep poll so the
    // planners track the player's drifting orbit — never per frame.
    this._maybeRefreshFieldPlans();
    // u10 D2: the drawn fields' centres from their members, ≤ 2 Hz.
    const now = this._now();
    this._maybeRecomputeLiveCentres(now);
    const project = ctx.project || this._project;
    // u7 D1: the focused cluster's window is computed first so the icon layer knows whether
    // it is at the ship's own height (no trip → no fuel label at the simple level).
    const focused = this.getFocusedCluster();
    const win = this.computeWindow(focused);
    const earthPx = project ? project(EARTH_CENTRE) : null;   // u10 D3: name blocks face Earth's centre
    const icons = this._icons.render(this._clusters, project, {
      budget: FLOOR.labelBudget,
      focusId: this._focusId,
      assessments: this._getMassBudget ? this._assessments : null,
      coOrbital: !!coOrbitalReadout(win),
      centerOf: (c) => { const e = this._live.get(c.id); return e ? this._livePosition(e, now) : null; },
      labelSideX: (earthPx && Number.isFinite(earthPx.x)) ? earthPx.x : undefined,
    });
    // u10 D3: the focused icon as last painted (its text and ring size set the framing's footprint).
    if (Array.isArray(icons)) for (const d of icons) if (d && d.focused) { this._focusDesc = d; break; }
    if (ctx.shipPos && project && this._icons.renderShip) {
      this._icons.renderShip(project(ctx.shipPos), ctx.shipAngleRad || 0);
    }
    // lane 3e: the fields and the satellite by height, beside her marker (nothing is built with the fields flag off)
    if (this._heightScale) {
      this._heightScale.render({ shipPx: (ctx.shipPos && project) ? project(ctx.shipPos) : null, rects: () => this.hudPanelRects() });
    }
    const window = this._windows.refresh(win, {
      targetName: focused ? focused.name : undefined,
      assessment: focused ? (this._assessments.get(focused.id) || null) : null,
      budget: this._budget,
      route: this._routePlan,
      sweep: this._sweepPlan,
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
   * Dispatch the NAVCOM Space verb (FloorContract.byId(4).spaceVerb 'plan-transfer').
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
        route: this._routePlan,
        sweep: this._sweepPlan,
      });
    }
    if (typeof this._onPlanTransfer === 'function') this._onPlanTransfer(cluster, window);
    return { cluster, window };
  }

  /** Tear down the owned views. */
  dispose() {
    this._whereNext = null;           // main.js owns the list's life
    this._heightScale = null;         // ... and the height scale's
    if (this._icons.dispose) this._icons.dispose();
    if (this._windows.dispose) this._windows.dispose();
    if (this._orb.dispose) this._orb.dispose();
  }
}
