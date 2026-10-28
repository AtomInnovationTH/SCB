/**
 * ProxMiniSphere.js — Zoom Ladder F5 (PROX NET) corner minimap adapter (FloorContract.FLOORS[4].costume
 * 'NavSphere:corner-minimap', 00-spec.md §3 F5).
 *
 * NavSphere is a singleton full-screen canvas (fixed element id) that subscribes to the EventBus itself and is
 * ticked every frame by main.js, so a second instance would duplicate the id and listeners. This adapter instead
 * RE-MOUNTS the one shipped instance through two ADDITIVE NavSphere opts (both absent ⇒ shipped behavior unchanged):
 *   - setCornerMount(radiusPx|null): shrink in place (same bottom-right spot) and force the layer on while mounted;
 *   - setTacticalOverlay(ov|null): floor-fed layer drawn over the radar — focused cluster bearing (gold ring) and
 *     selected insertion point (white ring + ticks).
 *
 * Rendering stays on main.js's navSphere.update(); this adapter never calls it, it only mounts/unmounts and feeds
 * the overlay descriptor (ProxNetFloor.update → this.update({cluster, selected})).
 *
 * Headless and duck-typed: no THREE/DOM/EventBus; a NavSphere without the opts degrades to a no-op, absent ⇒ inert.
 * The descriptor is ONE reused object handed over once per mount: no per-frame allocation or DOM writes.
 *
 * @module ui/ProxMiniSphere
 */

/** Corner-minimap sphere radius (px) while F5 is active: 168 px minimap vs the 280 px shipped orb (SPHERE_RADIUS 140).
 *  Own-module tunable (house rule: not FloorContract/Constants). */
export const MINI_RADIUS_PX = 84;

export class ProxMiniSphere {
  /** @param {{navSphere?:object, radiusPx?:number}} [deps] all optional; navSphere = the SHIPPED instance (main.js). */
  constructor(deps = {}) {
    this._nav = deps.navSphere || null;
    this._radiusPx = (deps.radiusPx > 0) ? deps.radiusPx : MINI_RADIUS_PX;
    this._mounted = false;
    this._fed = false; // overlay descriptor handed to NavSphere this mount?
    /** The single reused overlay descriptor. */
    this._ov = { clusterPos: null, clusterName: null, insertionPos: null, insertionZone: null };
  }

  isMounted() { return this._mounted; }

  /** Mount radius (px). */
  get radiusPx() { return this._radiusPx; }

  get overlay() { return this._ov; }

  /** Enter F5. Idempotent; inert without a navSphere or the additive opt. */
  mount() {
    if (this._mounted || !this._nav) return;
    if (typeof this._nav.setCornerMount !== 'function') return; // stale NavSphere: no-op
    this._nav.setCornerMount(this._radiusPx);
    this._mounted = true;
  }

  /** Leave F5: restore the shipped orb and clear the tactical overlay. Idempotent. */
  unmount() {
    if (!this._mounted) return;
    this._mounted = false;
    this._fed = false;
    if (!this._nav) return;
    if (typeof this._nav.setTacticalOverlay === 'function') this._nav.setTacticalOverlay(null);
    if (typeof this._nav.setCornerMount === 'function') this._nav.setCornerMount(null);
  }

  /**
   * Per-frame feed from ProxNetFloor.update(): mutates the reused descriptor in place (handed to NavSphere once).
   * @param {{cluster?:{center:{x,y,z},name:string}|null, selected?:{pos:{x,y,z},zone:string}|null}} [ctx]
   *   cluster = focused cluster (F6→F5 handoff, bearing marker); selected = SELECTED InsertionPlanner candidate.
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

  /** Unmount only: the NavSphere is SHARED, never disposed here. */
  dispose() { this.unmount(); }
}

export default ProxMiniSphere;
