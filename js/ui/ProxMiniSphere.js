/**
 * ProxMiniSphere.js — the Zoom Ladder F5 (PROX NET) corner minimap adapter
 * (S4, FloorContract.FLOORS[4].costume 'NavSphere:corner-minimap',
 * transform 'navsphere-to-minimap').
 *
 * On F5 "the NavSphere shrinks into a corner minimap" (00-spec.md §3 F5).
 * DESIGN CHOICE (over forking rendering code or a second NavSphere instance):
 * the shipped NavSphere does NOT fit a second mount cleanly — it is a
 * singleton full-screen canvas (fixed element id), self-manages visibility
 * over the EventBus (VIEW_CONFIG_CHANGE / GAME_STATE_CHANGE / MISSION_START),
 * and is ticked per frame by main.js with live radar data. A second instance
 * would duplicate the canvas id, double-subscribe every listener, and need a
 * second ticker. So this adapter RE-MOUNTS the one shipped instance — exactly
 * the costume transform the FloorContract names — through two ADDITIVE
 * NavSphere opts (both absent ⇒ shipped behavior byte-identical):
 *   - setCornerMount(radiusPx|null): shrink the sphere in place (same
 *     top-right, comms-anchored corner, smaller radius) and force the layer
 *     on while mounted (the minimap is the floor costume, not the 8-key orb);
 *   - setTacticalOverlay(ov|null):   the floor-fed layer NavSphere draws on
 *     top of its radar — focused cluster bearing + the selected insertion
 *     point (VisualLaw grammar: gold ring = cluster, white ring+ticks =
 *     selection).
 *
 * RENDERING STAYS ON THE SHIPPED TICKER: main.js already calls
 * navSphere.update(dt, {playerPos, playerVel, debrisField, ...}) every frame
 * (js/main.js "Nav Sphere update"), which keeps drawing the mounted minimap —
 * player position/heading (center dot + prograde marker) and live contacts
 * come from that call. This adapter therefore never calls navSphere.update();
 * it only mounts/unmounts and feeds the overlay DESCRIPTOR from the floor's
 * own data (ProxNetFloor.update → this.update({cluster, selected})).
 *
 * HEADLESS + DUCK-TYPED: no THREE, no DOM, no EventBus imports — the wrapped
 * navSphere is injected and feature-detected (a stale NavSphere without the
 * additive opts degrades to a safe no-op). Absent navSphere ⇒ inert.
 *
 * The overlay descriptor is ONE reused object (mutated in place, handed to
 * NavSphere once per mount): zero per-frame allocation, zero DOM writes —
 * NavSphere repaints on its own 10 Hz throttle (02-traps G1 friendly).
 *
 * @module ui/ProxMiniSphere
 */

/** Corner-minimap sphere radius (px) while F5 is active — the "shrink" of the
 *  280 px shipped orb (SPHERE_RADIUS 140) to a 168 px minimap. Own-module
 *  tunable (house rule: not FloorContract/Constants). */
export const MINI_RADIUS_PX = 84;

export class ProxMiniSphere {
  /**
   * @param {object} [deps] - ALL optional; absent navSphere ⇒ inert adapter
   * @param {object} [deps.navSphere] - the SHIPPED NavSphere instance
   *                 (js/main.js `navSphere`); duck-typed — only the additive
   *                 setCornerMount/setTacticalOverlay opts are used
   * @param {number} [deps.radiusPx]  - mount radius override (default MINI_RADIUS_PX)
   */
  constructor(deps = {}) {
    this._nav = deps.navSphere || null;
    this._radiusPx = (deps.radiusPx > 0) ? deps.radiusPx : MINI_RADIUS_PX;
    this._mounted = false;
    this._fed = false; // overlay descriptor handed to NavSphere this mount?
    /** The single reused overlay descriptor (see header — no per-frame allocs). */
    this._ov = { clusterPos: null, clusterName: null, insertionPos: null, insertionZone: null };
  }

  /** @returns {boolean} mounted (activate/deactivate lifecycle probe) */
  isMounted() { return this._mounted; }

  /** @returns {number} the mount radius (px) this adapter applies. */
  get radiusPx() { return this._radiusPx; }

  /** The live overlay descriptor (tests / debugging). */
  get overlay() { return this._ov; }

  /**
   * Enter F5: shrink the shipped NavSphere into the corner minimap.
   * Idempotent; inert without a navSphere or without the additive opt.
   */
  mount() {
    if (this._mounted || !this._nav) return;
    if (typeof this._nav.setCornerMount !== 'function') return; // stale NavSphere: no-op
    this._nav.setCornerMount(this._radiusPx);
    this._mounted = true;
  }

  /**
   * Leave F5: restore the shipped orb (its 8-key/view-config state resumes
   * untouched) and clear the tactical overlay. Idempotent.
   */
  unmount() {
    if (!this._mounted) return;
    this._mounted = false;
    this._fed = false;
    if (!this._nav) return;
    if (typeof this._nav.setTacticalOverlay === 'function') this._nav.setTacticalOverlay(null);
    if (typeof this._nav.setCornerMount === 'function') this._nav.setCornerMount(null);
  }

  /**
   * Per-frame feed from ProxNetFloor.update(): refresh the overlay descriptor
   * from the floor's own data. Mutates the reused descriptor in place; the
   * descriptor itself is handed to NavSphere ONCE per mount (write-on-change:
   * no repeated store calls, no DOM — NavSphere paints at its own 10 Hz).
   * @param {object} [ctx]
   * @param {object|null} [ctx.cluster]  - the focused cluster (F6→F5 handoff):
   *                 {center:{x,y,z}, name} — bearing marker source
   * @param {object|null} [ctx.selected] - the SELECTED InsertionPlanner
   *                 candidate: {pos:{x,y,z}, zone} — insertion marker source
   * @returns {object|null} the live overlay descriptor, or null while unmounted
   */
  update(ctx = {}) {
    if (!this._mounted || !this._nav) return null;
    const ov = this._ov;
    const cluster = ctx.cluster || null;
    const selected = ctx.selected || null;
    ov.clusterPos = (cluster && cluster.center) ? cluster.center : null;
    ov.clusterName = cluster ? (cluster.name || String(cluster.id != null ? cluster.id : '')) : null;
    ov.insertionPos = (selected && selected.pos) ? selected.pos : null;
    ov.insertionZone = (selected && selected.zone) ? selected.zone : null;
    if (!this._fed && typeof this._nav.setTacticalOverlay === 'function') {
      this._nav.setTacticalOverlay(ov);
      this._fed = true;
    }
    return ov;
  }

  /** Tear down: just unmount — the NavSphere is SHARED, never disposed here. */
  dispose() { this.unmount(); }
}

export default ProxMiniSphere;
