/**
 * ScanMarks.js — the scan-first predicate, in one small module so the HUD
 * (NavSphere, TargetReticle) and AutoLockController share it without the HUD
 * importing the controller.
 * @module systems/ScanMarks
 */

/**
 * Scan-first law (DECISIONS §15 row 1): is this piece MARKED — allowed a HUD
 * bracket, an off-screen arrow, a radar dot or an auto-lock? A piece is marked
 * once a scan has revealed it (or the player selected it, which discovers it).
 * Hazard shards stay marked without a scan: scans never reveal them
 * (SensorSystem skips `hazard`), so gating them would hide a danger cue
 * forever. Gate on `discovered === false`, never `!discovered`: snapshot
 * fixtures and non-debris targets carry no `discovered` field and stay marked.
 * The 3D meshes are not gated by this — you can see a piece with your eyes;
 * only the HUD marks need a scan.
 *
 * Slice 5 (lane 5d, D4): a piece that was DISPOSED OF (`_disposed`: let go by a push-down or a drag sail, or broke loose) is never marked,
 * hazard or not, scanned or not: it stays a drawn collision object, but no bracket, arrow, radar dot or auto-lock ever points at it. Checked
 * FIRST: before this, `hazard === true` alone made a piece marked.
 * @param {{hazard?: boolean, discovered?: boolean, _disposed?: boolean}|null|undefined} d
 * @returns {boolean}
 */
export function isMarked(d) {
  if (!d || d._disposed === true) return false;
  return d.hazard === true || d.discovered !== false;
}

export default isMarked;
