/**
 * ProxNetFloor.js — the Zoom Ladder PROX NET floor (id 3) content orchestrator (FloorContract.FLOORS[4]).
 *
 * PROX NET is the ship-anchored tactical floor (100 m – 120 km, debrisMode 'tactical'). This is the floor's "costume"
 * controller: it owns the tactical overlay (ProxOverlay) and the data behind it:
 *   - VALUE MARKERS: DebrisField.getEnhancedTargetList() entries (estimatedPoints/risk) merged with each target's LIVE
 *     canonical debris ref (getDebrisById → _scenePosition), so positions track orbits per frame while the LIST re-polls on
 *     a throttle;
 *   - DENSITY SHELLS: FieldRiskModel shell counts around the ship (getDebrisNear), drawn as translucent rings in the orbital plane;
 *   - INSERTION PLAN: with a target cluster aimed, InsertionPlanner's edge/mid/core arrival candidates with risk-colored
 *     trajectories. The cluster comes from the injected `getFocusedCluster` (the NAVCOM→PROX NET HANDOFF; production:
 *     () => navcomFloor.getFocusedCluster());
 *   - the Space verb 'approach' (00-spec.md §5): approach() commits the SELECTED arrival point and hands (cluster,
 *     arrivalPoint) to the injected `onApproach` sink (production: AutopilotSystem.engageCluster(cluster, { arrivalPoint })).
 *     The verb dispatch itself is LadderController's _dispatchVerb (`verb === 'approach'` → proxNet.approach());
 *   - the CORNER MINIMAP (costume 'NavSphere:corner-minimap'): with the OPTIONAL `navSphere` dep a ProxMiniSphere adapter
 *     shrinks the orb into the corner on activate, restores it on deactivate, and update() feeds it the focused cluster
 *     bearing + selected insertion point. Rendering stays on the shipped main.js NavSphere ticker. Absent dep ⇒ no adapter;
 *   - the 'tactical-approach' CONTEXT PANEL: ProxContextPanel (TransferWindows house pattern: DOM-guarded, write-on-change)
 *     mounted with the floor and fed {cluster, candidates, selectedIndex, approach} per frame. Self-contained (no generic
 *     context-panel framework exists).
 *
 * DESIGN (archive/ladder/03-plan.md, the NavcomFloor pattern):
 *   - Every dependency is INJECTED and optional: headless-testable (no THREE, no DOM, no EventBus) and a dep-less
 *     construction is a no-op (no debris reads, no clock reads, no DOM). The projector is passed per frame by the ticker.
 *   - Emits NO events. LadderController drives activate/deactivate (arrival floor's fidelity.debrisMode === 'tactical');
 *     main.js is the single per-frame ticker (update({project, shipPos, shipAngleRad}) right after cameraSystem.update).
 *   - Debris scans (target list, shell counts, insertion risk) run on a REFRESH_MS throttle + on activate/selection, never
 *     per frame; per frame is projection + painting only.
 *   - SELECTION is cycled, not clicked (click/keyboard-free per the PROX NET brief): cycleInsertion(±1) steps edge→mid→core;
 *     the selected zone survives re-plans.
 *
 * @module systems/ProxNetFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { ProxOverlay } from '../ui/ProxOverlay.js';
import { ProxMiniSphere } from '../ui/ProxMiniSphere.js';
import { ProxContextPanel } from '../ui/ProxContextPanel.js';
import { shellCounts, SHELL_RADII_KM } from '../entities/FieldRiskModel.js';
import { plan as planInsertion } from '../entities/InsertionPlanner.js';

/** The PROX NET (id 3) contract row: by id, never by index. */
const FLOOR = FloorContract.byId(3);

/** Minimum real-time interval between debris re-polls (target list, shell counts, insertion re-plan) while the floor is
 *  active. Own-module tunable (house rule: not FloorContract/Constants). */
export const REFRESH_MS = 500;

/** Marker search radius: the working range's outer edge (120 km in scene units); matches camera.distU[1] of the floor. */
export const TACTICAL_RANGE_U = FLOOR.camera.distU[1];

const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** @private Wrap a plain {x,y,z} for DebrisField.getDebrisNear, whose frame cache calls position.distanceToSquared()
 *  (a Vector3 method) on the arg. */
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
   * @param {object} [deps] ALL optional; absent ⇒ no-op
   * @param {object} [deps.debrisSource] DebrisField-shaped: getEnhancedTargetList, getDebrisNear, getDebrisById (each optional)
   * @param {object} [deps.player] getPosition/getVelocity + orbit / getOrbitalElements() (ΔV estimates, shell plane)
   * @param {function} [deps.getFocusedCluster] the NAVCOM→PROX NET handoff: the aimed cluster
   *                 (NavcomFloor.getFocusedCluster) or null
   * @param {function} [deps.onApproach] verb sink (cluster, arrivalPoint) => void
   * @param {object} [deps.proxOverlay] ProxOverlay instance (default: fresh)
   * @param {object} [deps.navSphere] the SHIPPED NavSphere instance for the corner minimap, wrapped in a ProxMiniSphere
   *                 adapter; absent (with no miniSphere) ⇒ no minimap
   * @param {object} [deps.miniSphere] ProxMiniSphere-shaped adapter override (tests); takes precedence over deps.navSphere
   * @param {object} [deps.contextPanel] ProxContextPanel instance (default: fresh, DOM-guarded, inert headless)
   * @param {function} [deps.now] monotonic ms clock (tests)
   */
  constructor(deps = {}) {
    this._debrisSource = deps.debrisSource || null;
    this._player = deps.player || null;
    this._getFocusedCluster = deps.getFocusedCluster || null;
    this._onApproach = deps.onApproach || null;
    this._overlay = deps.proxOverlay || new ProxOverlay();
    // Corner minimap: only ever constructed AROUND an injected NavSphere (the shipped singleton), never fresh.
    this._mini = deps.miniSphere
      || (deps.navSphere ? new ProxMiniSphere({ navSphere: deps.navSphere }) : null);
    // Default fresh: DOM-guarded ⇒ headless-inert.
    this._panel = deps.contextPanel || new ProxContextPanel({ simple: deps.simple });   // the simple-level getter rides in
    this._now = deps.now || _nowMs;

    this._active = false;
    this._markers = [];          // [{entry, debris}] — live canonical refs
    this._shells = [];           // FieldRiskModel shell reads (ship-centered)
    this._plan = null;           // InsertionPlanner.plan() result
    this._selectedZone = null;   // selection survives re-plans by zone id
    this._lastInsertionPoints = null; // last drawn candidate screen points (tap hit-test)
    this._cluster = null;        // last refreshed focused cluster (panel/minimap)
    this._approachCommit = null; // {clusterId, zone} after the approach verb
    this._lastRefreshMs = -Infinity;
    this._lastShipPos = null;    // last ticked ship position (refresh anchor)
  }

  isActive() { return this._active; }

  get overlay() { return this._overlay; }

  /** The corner-minimap adapter (null without the navSphere dep) — tests. */
  get miniSphere() { return this._mini; }

  /** The 'tactical-approach' context panel — tests. */
  get contextPanel() { return this._panel; }

  /** The current insertion plan (read-only probe for rail/context panels). */
  getPlan() { return this._plan; }

  activate() {
    if (this._active) return;
    this._active = true;
    this.refresh();
    if (this._overlay.show) this._overlay.show();
    if (this._mini) this._mini.mount();
    if (this._panel && this._panel.show) this._panel.show();
  }

  /** Leave PROX NET: hide the costume (state kept so re-entry is cheap). */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    this._lastInsertionPoints = null;   // no stale tap targets off the floor
    if (this._overlay.hide) this._overlay.hide();
    // Restore the shipped orb (its 8-key state resumes) + drop the panel.
    if (this._mini) this._mini.unmount();
    if (this._panel && this._panel.hide) this._panel.hide();
  }

  /**
   * Re-poll the debris source + the focused cluster and rebuild the marker / shell / insertion caches. Called on activate,
   * selection change, and the REFRESH_MS throttle from update(). A total no-op without deps.
   * @param {{x,y,z}} [shipPos] defaults to the player's live position
   */
  refresh(shipPos) {
    // Stamp the throttle window here so an activate()/approach() refresh also resets the poll. Dep-less instances read
    // NOTHING, not even the clock.
    if (this._debrisSource || this._getFocusedCluster) this._lastRefreshMs = this._now();
    const pos = shipPos
      || this._lastShipPos
      || (this._player && this._player.getPosition && this._player.getPosition())
      || null;

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

    this._shells = [];
    if (this._debrisSource && this._debrisSource.getDebrisNear && pos) {
      const near = (p, r) => this._debrisSource.getDebrisNear(vecLike(p), r);
      this._shells = shellCounts(near, pos, SHELL_RADII_KM).shells;
    }

    this._plan = null;
    const cluster = (typeof this._getFocusedCluster === 'function')
      ? (this._getFocusedCluster() || null)
      : null;
    this._cluster = cluster;
    // A re-aim (or losing the aim) invalidates a committed approach: the panel's EN ROUTE line must never survive it.
    if (this._approachCommit && (!cluster || this._approachCommit.clusterId !== cluster.id)) {
      this._approachCommit = null;
    }
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
    // Selection survives re-plans while the zone still exists; default = edge (index 0, the safe outermost corridor).
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

  getSelectedIndex() {
    if (!this._plan || this._selectedZone == null) return -1;
    return this._plan.candidates.findIndex((c) => c.zone === this._selectedZone);
  }

  getSelectedInsertion() {
    const i = this.getSelectedIndex();
    return i >= 0 ? this._plan.candidates[i] : null;
  }

  /**
   * Select the insertion candidate by ZONE id ('edge' | 'mid' | 'core') ("a tap on a candidate selects it"). Returns the
   * selected candidate, or null when there is no plan / no such zone (selection left as it was). Survives re-plans by zone,
   * like cycleInsertion's.
   * @param {string} zone
   */
  selectInsertion(zone) {
    if (!this._plan || !this._plan.candidates.length || typeof zone !== 'string') return null;
    const c = this._plan.candidates.find((x) => x.zone === zone);
    if (!c) return null;
    this._selectedZone = c.zone;
    return c;
  }

  /**
   * The candidate screen points the overlay drew on the LAST update, `[{ zone, x, y, visible, selected, ... }]` in the
   * projector's space (the ticker's `project` → CSS px), or null while inactive / no plan / never drawn. Read-only; the
   * hub's tap path hit-tests them.
   * @returns {Array<{zone:string,x:number,y:number,visible:boolean}>|null}
   */
  lastInsertionPoints() {
    return this._active ? (this._lastInsertionPoints || null) : null;
  }

  /** Step the insertion selection through the plan's candidates (edge→mid→core, wrapping). No-op without a plan. */
  cycleInsertion(dir = 1) {
    if (!this._plan || !this._plan.candidates.length) return null;
    const n = this._plan.candidates.length;
    let i = this.getSelectedIndex();
    if (i < 0) i = 0;
    else i = ((i + (dir < 0 ? -1 : 1)) % n + n) % n;
    this._selectedZone = this._plan.candidates[i].zone;
    return this._plan.candidates[i];
  }

  /**
   * Render one frame of the PROX NET costume; no-op while inactive. Debris scans are throttled (REFRESH_MS); per frame is
   * marker position reads + projection + painting.
   * @param {function} [ctx.project] world→screen (worldVec3)->{x,y,visible}
   * @param {{x,y,z}} [ctx.shipPos] ship world position
   * @param {number} [ctx.shipAngleRad] ship velocity heading on screen
   * @returns {{markers:Array, ship:object|null, shells:Array, insertion:object|null}|null} rendered descriptors (tests),
   *          or null while inactive
   */
  update(ctx = {}) {
    if (!this._active) return null;
    if (ctx.shipPos) this._lastShipPos = ctx.shipPos;

    // Throttled refresh, only when something can be read (dep-less instances never touch the clock). refresh() stamps
    // _lastRefreshMs itself, so an activate/approach refresh also resets this window.
    if (this._debrisSource || this._getFocusedCluster) {
      const now = this._now();
      if (now - this._lastRefreshMs >= REFRESH_MS) {
        this.refresh(ctx.shipPos);
      }
    }

    // Live marker positions from the canonical refs; a despawned id drops off this frame's draw.
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

    const frame = this._overlay.render({
      targets,
      shipPos: ctx.shipPos || this._lastShipPos || undefined,
      shipAngleRad: ctx.shipAngleRad || 0,
      shipVel: (this._player && this._player.getVelocity && this._player.getVelocity()) || null,
      shells: this._shells,
      insertion: this._plan
        ? { candidates: this._plan.candidates, selectedIndex: this.getSelectedIndex() }
        : null,
      labelBudget: FLOOR.labelBudget,
    }, ctx.project);
    // Remember THIS frame's candidate screen points so the hub's tap path can hit-test them (the overlay canvas is
    // pointer-events:none). A reference to the overlay's returned descriptors, not a copy: no allocation.
    this._lastInsertionPoints = (frame && frame.insertion && Array.isArray(frame.insertion.points))
      ? frame.insertion.points : null;

    // Feed the corner minimap + context panel. Cheap per frame: the adapter mutates ONE reused descriptor (the NavSphere
    // ticker paints at its own 10 Hz), and the panel's write-on-change gate (html cache + ≤4 Hz cap) bounds DOM writes.
    if (this._mini) {
      this._mini.update({ cluster: this._cluster, selected: this.getSelectedInsertion() });
    }
    if (this._panel && this._panel.refresh) {
      this._panel.refresh({
        cluster: this._cluster,
        candidates: this._plan ? this._plan.candidates : null,
        selectedIndex: this.getSelectedIndex(),
        approach: this._approachCommit,
      });
    }
    return frame;
  }

  /**
   * Dispatch the PROX NET Space verb (FloorContract.byId(3).spaceVerb 'approach'): commits the SELECTED arrival point
   * against the aimed cluster and hands (cluster, arrivalPoint) to the injected sink (production: AutopilotSystem.engageCluster).
   * The verb decision itself arrives via LadderController's _dispatchVerb.
   * @returns {{cluster:object, arrivalPoint:object|null}|null} null when nothing is aimed
   */
  approach() {
    if (!this._active) this.refresh();
    const cluster = (typeof this._getFocusedCluster === 'function')
      ? (this._getFocusedCluster() || null)
      : null;
    if (!cluster) return null;
    if (!this._plan || this._plan.clusterId !== cluster.id) this.refresh();
    const arrivalPoint = this.getSelectedInsertion();
    if (typeof this._onApproach === 'function') this._onApproach(cluster, arrivalPoint);
    // Remember the commitment for the context panel's autopilot state line (cleared by refresh() when the aim changes) and
    // surface it immediately: the readout doubles as the "approach committed" cue.
    if (arrivalPoint) {
      this._approachCommit = { clusterId: cluster.id, zone: arrivalPoint.zone };
      if (this._panel && this._panel.refresh) {
        this._panel.refresh({
          cluster: this._cluster,
          candidates: this._plan ? this._plan.candidates : null,
          selectedIndex: this.getSelectedIndex(),
          approach: this._approachCommit,
        });
      }
    }
    return { cluster, arrivalPoint };
  }

  /** Tear down the owned view (the shared NavSphere is only unmounted). */
  dispose() {
    if (this._overlay.dispose) this._overlay.dispose();
    if (this._mini) this._mini.unmount();
    if (this._panel && this._panel.dispose) this._panel.dispose();
  }
}
