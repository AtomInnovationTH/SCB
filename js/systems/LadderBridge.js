/**
 * LadderBridge.js — legacy-compatibility shim for the Zoom Ladder
 * (docs/ladder/05-bridge.md). Created 2026-10-09 (H1) in the commit that
 * stopped M / ` from opening the Debris Map, so the one wire that map owned
 * keeps firing. Deleted whole at ladder M7.
 *
 * Rule 2 of the design: the bridge EMITS legacy events, it implements no
 * feature. Rule 3: every emission has the payload shape the legacy emitter
 * used (DebrisMap._emitSelection → { clusterId, name, count }).
 *
 * @module systems/LadderBridge
 */

/**
 * Re-emit DEBRIS_MAP_CLUSTER_SELECTED for a cluster the ladder just committed
 * to (F4 plan-transfer, F3 approach). Feeds RewardSystem._beginCluster, the
 * `strategic_map` / `nav_orbit_mfd` skills and coach beats ch4_map / ch7_cluster.
 * A missing cluster emits nothing.
 *
 * @param {{emit: Function}} bus      the event bus
 * @param {object} events             the Events table
 * @param {{id: *, name?: string, count?: number}|null|undefined} cluster
 * @returns {boolean} true when an event was emitted
 */
export function clusterSelected(bus, events, cluster) {
  if (!cluster || !bus || !events || !events.DEBRIS_MAP_CLUSTER_SELECTED) return false;
  bus.emit(events.DEBRIS_MAP_CLUSTER_SELECTED, {
    clusterId: cluster.id,
    name: cluster.name,
    count: cluster.count,
  });
  return true;
}

export default { clusterSelected };
