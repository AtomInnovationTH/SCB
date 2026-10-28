/**
 * @module systems/LadderBridge — legacy-compatibility shim for the Zoom Ladder (docs/ladder/05-bridge.md), so the one
 * wire the Debris Map owned keeps firing after M / ` stopped opening it. Deleted whole at ladder M7.
 *
 * Rule 2: the bridge EMITS legacy events, it implements no feature. Rule 3: every emission has the payload shape the
 * legacy emitter used (DebrisMap._emitSelection → { clusterId, name, count }).
 */

/**
 * Re-emit DEBRIS_MAP_CLUSTER_SELECTED for a cluster the ladder just committed to (plan-transfer, approach). Feeds
 * RewardSystem._beginCluster, the `strategic_map` / `nav_orbit_mfd` skills and coach beats ch4_map / ch7_cluster.
 * A missing cluster emits nothing; returns true when an event was emitted.
 * @param {{id: *, name?: string, count?: number}|null|undefined} cluster
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
