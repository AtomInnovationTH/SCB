# Quick-Wins Performance Audit

*Generated 2026-05-24 — static-analysis pass over [`js/main.js`](js/main.js:1), [`js/entities/DebrisField.js`](js/entities/DebrisField.js:1), [`js/entities/OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1), the conjunction/avoidance stack, and the HUD/reticle/NavSphere update loops, against the prior `GPU_PROFILING_REPORT` §1–§14 and `PERF_SPRINT_REPORT` PRs 1–6. Scope is strictly **CPU-side, per-frame waste the user genuinely won't notice**.*

---

## Executive Summary

The GPU side is in good shape: Sprint 3 cut HIGH/IN-MISSION render cost from ~11 ms → ~3.5 ms (-68 %) via pixel-ratio + SMAA + bloom cuts (see [`GPU_PROFILING_REPORT.md` §10.1](GPU_PROFILING_REPORT.md:519)), and Sprint 4 §12-§14 closed the "40 % GPU while paused" + ambient-audio fan triggers. PR-5 already migrated 48 timers and pre-allocated bloom Vec2 + the DebrisField orbit-propagation scratch (see [`PERF_SPRINT_REPORT.md` §2.5](PERF_SPRINT_REPORT.md:290)). What remains is a **CPU-side per-frame allocation story**: the heaviest single offender is [`DebrisField.getDebrisNear()`](js/entities/DebrisField.js:1673) which still re-derives Keplerian Cartesian state for all 800 debris on every call (often 2–3 calls/frame from different consumers), allocating fresh `{position, velocity}` objects per debris despite the same positions already living on `debris._scenePosition` from the same frame's main update. Two related per-frame Vector3 allocations in [`TargetReticle._drawDebrisReticle()`](js/ui/TargetReticle.js:680) and a few admitted-redundant `console.log` / `updateMatrixWorld(true)` calls round out the low-risk pile. None of these affect the rendered image; all are GC-pressure + main-thread JS time wins.

---

## Top 3 Prioritized Optimizations

### #1 — `DebrisField.getDebrisNear()` should reuse `debris._scenePosition` instead of re-propagating  [Impact: **High** | Risk: Low | Effort: ~1 hr]

- **What's wasteful today**
  - [`DebrisField.getDebrisNear()`](js/entities/DebrisField.js:1697) iterates `this.debrisList` (800 entries) and calls [`orbitToSceneCartesian(debris.orbit)`](js/entities/OrbitalMechanics.js:490) **per debris**. That function allocates a fresh nested object `{ position: {x,y,z}, velocity: {x,y,z} }` and chains through [`orbitToKm()`](js/entities/OrbitalMechanics.js:1) + [`keplerianToCartesian()`](js/entities/OrbitalMechanics.js:76) which each spawn additional temporary closures (Kepler solver loop, six trig calls, the perifocal-to-ECI matrix multiply).
  - The exact same per-debris Cartesian position has **already been computed this frame** by [`DebrisField._updateInstanceTransform()`](js/entities/DebrisField.js:1256) via the allocation-free [`orbitToSceneCartesianInto()`](js/entities/OrbitalMechanics.js:571) and stored on `debris._scenePosition` ([line 1265-1269](js/entities/DebrisField.js:1265)). [`CollisionAvoidanceSystem._scanForThreats()`](js/systems/CollisionAvoidanceSystem.js:320) already does the right thing — it reads `debris._scenePosition` for the cheap pre-filter — so the pattern exists.
  - The frame-level cache at [`DebrisField.js:1688`](js/entities/DebrisField.js:1688) **only hits when caller + position + radius are bit-identical**. The three consumers each pass different radii (TargetReticle = 1.0 = 100 km, NavSphere = `sensorSystem.range`, SensorSystem._revealNearbyDebris = its own value), so the cache **never** hits across them and the 800-debris orbital propagation runs ~2–3× per frame.
  - Each successful hit also pushes `{ ...debris, distance, distanceKm, _cartesian: cart }` ([line 1708-1713](js/entities/DebrisField.js:1708)) — the `...debris` spread is a full property copy of the debris object per visible result, and `_cartesian` is only consumed by NavSphere's `_drawDebrisDot` which itself re-runs `orbitToSceneCartesian` ([`NavSphere.js:705`](js/ui/NavSphere.js:705)) — i.e. nobody actually uses the `_cartesian` field.

- **Proposed change**
  1. Inside the loop at [`DebrisField.js:1697`](js/entities/DebrisField.js:1697), prefer `debris._scenePosition` for the distance-squared test; only fall back to `orbitToSceneCartesian` when `_scenePosition` is undefined (first frame, or a debris that was just restored from mission-1 hiding).
  2. Drop `_cartesian: cart` from the pushed result (no consumer reads it).
  3. Replace the `{ ...debris, distance, distanceKm }` spread with a return shape that **points to** the debris (`{ debris, distance, distanceKm }`) — the existing consumers either read `.id` / `.orbit` / `.alive` / `.distanceKm` (all preservable) or already iterate via raw property names. (Alternative low-risk variant: keep the spread but precompute once and recycle in a pool.)
  4. Bonus: rewrite [`NavSphere._drawDebrisDot()`](js/ui/NavSphere.js:704) to read `target._scenePosition` rather than calling `orbitToSceneCartesian` again — same elimination one layer down.

- **Expected gain**
  - Eliminates ~1600–2400 `orbitToSceneCartesian` calls / frame at 800-debris steady state (1 call/debris × 2–3 callers/frame). Each call avoids: 1 nested-object allocation, 2 `Math.sin`/`Math.cos` pairs in `keplerianToCartesian`, the Kepler Newton-Raphson loop in `meanToTrueAnomaly` (already done by main update — pure duplication), and the 9-element perifocal rotation product.
  - **Estimate**: 0.8–1.5 ms/frame off the main thread on a 60-fps full-debris scene, plus a substantial drop in minor-GC frequency (currently a few-hundred-KB nursery turnover from these objects per second). On a 120 Hz target, this is ~10–20 % of the 8.33 ms budget.

- **Why user won't notice the change**
  - `_scenePosition` is **the position the renderer already drew** this frame — sub-mm identical. The change just stops asking Kepler the same question twice.
  - Result shape change is internal; only TargetReticle / NavSphere / SensorSystem touch the array, and each is straightforward to migrate (already test-covered).

- **Validation**
  - Snapshot before/after via the existing `?perfReport=1` overlay ([`PerfReportOverlay.js:1`](js/ui/PerfReportOverlay.js:1)); read median frame time + GC counts.
  - Add a one-shot `console.count('getDebrisNear-fullScan')` (DEBUG flag) before the patch to confirm scan frequency, remove after.
  - All existing tests under [`test-DebrisVisuals.js`](js/test/test-DebrisVisuals.js:1) / [`test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js:1) must still pass (positions are bit-identical because `_scenePosition` is the same calc).

---

### #2 — Stop allocating Vector3 per visible target in `TargetReticle._drawDebrisReticle()`  [Impact: Med | Risk: Low | Effort: ~30 min]

- **What's wasteful today**
  - [`TargetReticle._drawDebrisReticle()`](js/ui/TargetReticle.js:677-680) calls `orbitToSceneCartesianInto(target.orbit, this._tmpCartPos, this._tmpCartVel)` to fill a pre-allocated scratch — **then immediately allocates a new** `new THREE.Vector3(this._tmpCartPos.x, this._tmpCartPos.y, this._tmpCartPos.z)` because `_project()` wants a `THREE.Vector3` interface.
  - This runs **per visible debris target per frame**. `MAX_RETICLE_RANGE = 1.0` (= 100 km), so a typical mid-mission scene shows 10–30 brackets. At 120 Hz that's **1200–3600 Vector3 allocations / sec** for an effect that already has `this._tempVec3` / `this._tempVec4` scratch fields ([line 88-89](js/ui/TargetReticle.js:88)) sitting unused on the same code path.
  - Same anti-pattern lives in `_drawActiveSatReticle()` and the lead-indicator paths (search the file for `new THREE.Vector3(` — ~6–8 hits in the draw stack, none of which need a fresh allocation).
  - The orbit→scene call is itself a duplicate of work already done by [`DebrisField._updateInstanceTransform()`](js/entities/DebrisField.js:1256) — `target._scenePosition` (a real `THREE.Vector3`) is already populated this frame and is exactly the value `_project()` consumes.

- **Proposed change**
  1. Replace `const worldPos = new THREE.Vector3(this._tmpCartPos.x, ...)` with reuse of the pre-allocated `this._tempVec3.set(target._scenePosition.x, target._scenePosition.y, target._scenePosition.z)` — or just pass `target._scenePosition` directly to `_project()` (it accepts the `THREE.Vector3` interface).
  2. Audit the other `new THREE.Vector3` sites in the same file (grep `js/ui/TargetReticle.js` for the pattern); each can use `_tempVec3` or `target._scenePosition`.
  3. Same audit pass through [`NavSphere.js:389`](js/ui/NavSphere.js:389) — `playerPos.clone().negate().normalize()` and [`NavSphere.js:401`](js/ui/NavSphere.js:401) `new THREE.Vector3(playerVel.x, playerVel.y, playerVel.z)` are 10 Hz so each is cheaper (~10/sec) but the change is free.

- **Expected gain**
  - 1200–3600 Vector3 allocations / sec eliminated at 120 Hz, plus the corresponding orbital math that #1 also kills (this fix piggy-backs on #1's cached `_scenePosition`).
  - **Estimate**: 0.1–0.3 ms/frame plus a meaningful drop in nursery-GC tick rate (Vector3 is 64 bytes minimum; 3600/sec ≈ 230 KB/sec nursery churn just from this site).

- **Why user won't notice the change**
  - `target._scenePosition` is the same coordinate the renderer drew the debris at this frame. The reticle bracket lands on the exact same pixel.
  - The pre-allocated `_tempVec3` is sized identically to the discarded fresh Vector3 — no mathematical change.

- **Validation**
  - Visual A/B: load a mission with 20+ visible debris, compare reticle bracket pixel positions frame-by-frame (DevTools Performance → frame capture). Pixel-identical expected.
  - DevTools Memory → record allocation profile for 5 s of gameplay → confirm `Vector3` allocations drop to near-zero.

---

### #3 — Hot-loop hygiene: kill `Mission 1: per-frame culled` log spam + admitted-redundant `group.updateMatrixWorld(true)`  [Impact: Med | Risk: Very Low | Effort: ~20 min]

- **What's wasteful today**
  - [`DebrisField.update()` line 1067](js/entities/DebrisField.js:1067) — `console.log('[DebrisField] Mission 1: per-frame culled ${culled} debris beyond 2 km')` fires **every frame any cull happened**. Once a debris drifts past 2 km it gets `_hiddenForMission1=true` so the *next* frame it's `!d.alive` and skipped — but a fresh drifter on any subsequent frame re-trips the log. On a long Mission 1, this can spam dozens of lines/sec into DevTools console, and `console.log` on a hot path is non-trivial (string interpolation + DevTools backend round-trip; can cost ~0.2–1 ms each when DevTools is open).
  - [`DebrisField.update()` line 949-960](js/entities/DebrisField.js:949) — the `this.group.updateMatrixWorld(true)` call has a comment that **literally says** *"this call is technically redundant"* and exists only as "belt-and-suspenders" defensive coding. Every frame, costs one matrix multiply + child traversal of the entire `DebrisField` group (which contains all instanced meshes + flag overlays + background points).
  - [`DebrisField.update()` line 1205-1214](js/entities/DebrisField.js:1205-1213) — `mesh.instanceMatrix.needsUpdate = true` is set unconditionally on every instanced mesh **and on every flag-overlay mesh** even on frames where the loop skipped them (e.g. dead debris, M1 with only welcome cluster alive). Each `needsUpdate=true` schedules a full GPU re-upload of the entire instance Matrix4 buffer (`800 × 64 bytes = 51,200 bytes` per mesh). At MENU/BRIEFING/SHOP background rate (30 fps × `dt × 0.1` time-dilation) almost no instance moved — yet the upload still happens.
  - **Bonus**: [`DebrisField._updateInstanceTransform()` line 1316-1330](js/entities/DebrisField.js:1316-1330) does `this._tempMatrix.compose(...)` + `mesh.setMatrixAt(...)` even for debris where the LOD computed `scale = 0` (invisible). For the typical 800-debris field with player at LEO, most debris sit beyond the `vfar = 0.5` (= 50 km) cutoff at [line 1289](js/entities/DebrisField.js:1289), so we're authoring a zero-matrix for ~700/800 invisible debris every frame.

- **Proposed change**
  1. Remove the per-frame `console.log` at [`DebrisField.js:1067`](js/entities/DebrisField.js:1067). If the diagnostic is still useful, gate it behind `Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS` (already wired for `?debug=1`).
  2. Delete the "technically redundant" `this.group.updateMatrixWorld(true)` at [`DebrisField.js:960`](js/entities/DebrisField.js:960) — the comment already admits the renderer's natural traversal handles this on the same frame.
  3. Track a per-frame `_anyInstanceMoved` flag in `DebrisField.update()`; only set `mesh.instanceMatrix.needsUpdate = true` if it flipped true. On menu-background frames where `dt * 0.1` produces sub-pixel motion, this can short-circuit the GPU re-upload entirely.
  4. In `_updateInstanceTransform()`, store the previous scale on `debris._lastDrawnScale`. If both the previous and current scale are 0 (was invisible, still invisible), `continue` before the compose / `setMatrixAt` call — the matrix in the instance buffer is already zero-scale from the prior write.

- **Expected gain**
  - Per-frame `console.log` removal: 0.0–1.0 ms / frame depending on whether DevTools is open. Even with DevTools closed, browser still serializes the log args.
  - `updateMatrixWorld(true)` removal: ~0.05–0.15 ms / frame (small, but free).
  - Skipping `instanceMatrix.needsUpdate` when no instance moved + skipping compose for already-invisible debris: ~0.2–0.5 ms / frame **and** a meaningful GPU bandwidth saving on the background MENU/BRIEFING scene (which currently re-uploads ~150 KB / frame of stale instance data at 30 fps = 4.5 MB/sec PCIe traffic for nothing visible). The MENU/BRIEFING audit at [`GPU_PROFILING_REPORT.md` §12.12.1](GPU_PROFILING_REPORT.md:864) already throttled these to 30 fps render; this further reduces their CPU/bus cost.
  - Combined: 0.3–1.5 ms / frame, with the bonus that MENU/BRIEFING screens become measurably lighter.

- **Why user won't notice the change**
  - Diagnostic console output is invisible to the player; visual output unchanged.
  - `updateMatrixWorld(true)` is **already going to run** at the next render-time scene traversal — Three.js does this automatically with `matrixAutoUpdate=true` (default). The "before render" timing the comment was hedging against is empty; nothing reads `group.matrixWorld` between `DebrisField.update()` and `renderer.render()`.
  - Skipping a redundant GPU upload of unchanged data — by definition no pixel changes.
  - Skipping `setMatrixAt(zero)` on a debris whose matrix is already zero — the InstancedMesh buffer stays zero either way.

- **Validation**
  - `node js/test/run-tests.js` — must stay green (current 2207/2207 baseline).
  - Manual M1 playthrough with DevTools console visible: confirm console no longer spams.
  - GPU probe (`?perfReport=1`) on MENU/BRIEFING — confirm reduced render-side cost or unchanged CPU-side cost (it should drop).

---

## Runner-Up Findings

These are smaller / more invasive / less certain. Listed in case a future sprint wants to keep going. **Not prioritized into top 3.**

- **`ConjunctionSystem.updateMOID()` is never called from anywhere** — grep found exactly one match, the definition itself at [`ConjunctionSystem.js:207`](js/systems/ConjunctionSystem.js:207). Side-effects:
  - `debris.moidBadge` is never set → the MOID-color tint path at [`DebrisField.js:1156-1174`](js/entities/DebrisField.js:1156) never runs (silent dead code per frame, cheap).
  - [`CollisionAvoidanceSystem._scanForThreats()`](js/systems/CollisionAvoidanceSystem.js:273) always takes the no-MOID branch and scans the full 800-debris list every 250 ms. Wiring `updateMOID()` into the gameLoop would let CA scan ~top-N pairs instead — but that's a feature change, not a free win, so this stays in runner-ups.
- **`getEnhancedTargetList()` at [`DebrisField.js:1875`](js/entities/DebrisField.js:1875)** has the same `orbitToSceneCartesian` per-debris pattern as `getDebrisNear()` (called 2 Hz from HUD — lower frequency but identical fix).
- **`activeSatellites.getSatelliteList(playerPos)` is called 3× per frame** — once each from HUD ([`HUD.js:956`](js/ui/HUD.js:956)), NavSphere ([`NavSphere.js:451`](js/ui/NavSphere.js:451)), and TargetReticle ([`TargetReticle.js:491`](js/ui/TargetReticle.js:491)). HUD is 2 Hz, NavSphere is 10 Hz, TargetReticle is per-frame. Each call recomputes its own distance sort. A frame-level cache like the one DebrisField already has would unify these.
- **`CollisionAvoidanceSystem` `console.log` at [line 296](js/systems/CollisionAvoidanceSystem.js:296)** — fires 1 Hz when MOID prefilter is active. Currently dormant because of the dead-code finding above; **will activate the moment someone wires `updateMOID()` in.** Pre-emptively gate behind a DEBUG flag.
- **[`DebrisField.update()` line 1071-1144](js/entities/DebrisField.js:1071) — Kepler propagation loop** allocates an [`atmosphericDrag`](js/entities/OrbitalMechanics.js:1) result and computes `orbitalVelocity` for **every** alive debris below 600 km, every frame. Above ~500 km, drag is essentially zero — this entire block can early-out at, say, 500 km with a single `if (debrisAltKm > 500) continue;` before the velocity math. Below 500 km is uncommon (debris would already be deorbiting fast); the saving is exact ms per debris per frame in the rare hot-drag band.
- **[`Earth.update()`](js/scene/Earth.js:783)** mutates `uTime` uniforms unconditionally every frame even when the cloud + atmosphere shaders are visually identical (cloud rotation is 1 sidereal day per game hour — sub-pixel motion at typical viewing distance). Could update uniforms at 10 Hz without any perceptible change. Saves one float upload per shader per frame.
- **[`StatusPanel.update()`](js/ui/hud/StatusPanel.js:632) at 10 Hz** still does ~50 `getElementById` calls per invocation (~500/s). Documented as future tidy at [`GPU_PROFILING_REPORT.md` §13.7.5](GPU_PROFILING_REPORT.md:1318); fix is mechanical (cache element refs in `_build()`).
- **[`DebrisField._updateBackground()`](js/entities/DebrisField.js:1334)** propagates 1/4 of 5000 background points per frame (= 1250 propagations × 4 trig calls each). When background points are `visible = false` (e.g. Mission 1, see [line 1023](js/entities/DebrisField.js:1023)), this loop still runs and dirties the position attribute. Gate the work on `this.backgroundPoints.visible`.
- **[`TrailSystem.js`](js/ui/TrailSystem.js:1)** rebuilds the position+color BufferAttributes every frame the trail is dirty. Sample additions are 10 Hz but the geometry rewrite + `needsUpdate=true` runs whenever a sample arrives — could batch the GPU upload at 10 Hz max instead of as-frequently-as-the-sample-event-fires.
- **[`SensorSystem.update()`](js/systems/SensorSystem.js:258)** — `_revealNearbyDebris` calls `getDebrisNear()` from the same hot path. Benefits from #1 directly.

---

## Things NOT to touch

(Things that *look* suspicious in a perf grep but are actually correct or already-optimized — recording so the next audit doesn't re-litigate.)

- **`audioCtx.suspend()` / `resume()` policy in [`main.js`](js/main.js:1)** — looks fragile but is the canonical implementation of the §12.11 / §12.12 / §13.5 / §13.11 fix stack. Single point of truth at [`_syncAudioCtxState()`](js/main.js:316). Leave alone; the autoplay-unlock `audioSystem.resume()` bypasses listed in [`GPU_PROFILING_REPORT.md` §14.3.1](GPU_PROFILING_REPORT.md:1751) are **necessary** for the user-gesture unlock and are not bugs.
- **`_rafScheduled` + setTimeout(200) throttle in [`main.js`](js/main.js:149)** — the `gameLoop` "wake" wires depend on this. Don't replace with a naive rAF reschedule; the §12.4 fix specifically requires no rAF during pause so the browser compositor sleeps.
- **`debris._scenePosition` writes inside `_updateInstanceTransform`** — these are load-bearing for `CollisionAvoidanceSystem` and `ConjunctionSystem`'s pre-filter. They were *added* to avoid re-propagating; do not "optimise" them out.
- **`TimerManager`'s `Map` keyed on owner+id** — looks like a leak vector but is correct: PR-5 audit (§12.11.6, §13.7.3) showed bounded growth and explicit `clearByOwner` / `clearByState` cleanup.
- **`renderer.compile()` at boot ([`main.js`](js/main.js:851))** — looks redundant after §13.3 found the 2.3 s first-frame stall but the call is the only thing keeping per-material PSO compile *down* from "even worse". Leave in.
- **`Earth.setLowDetail()` + `?disableEarthNoise=1` flag** — looks like dead diagnostic, but is the canonical Sprint-3 verification path. `LOW_DETAIL` define is also pinned via `?disableEarthNoise=1`; do not collapse into the regular tier path.
- **PR-5 pre-allocated `_tmpKmOrbit` / `_tmpBgOrbit` scratch objects in DebrisField** — looks like premature optimisation, but PR-5 measured this was an 800-allocations-per-frame leak. Keep.
- **`AmbientLoop` default-off (§13.11)** — looks "missing" to anyone grepping for ambient audio. It is intentionally default-off; opt in with `?ambient=1`. Do not "fix" by re-enabling.
- **`?perfReport=1` / `?autoProfile=1` per-frame loops in [`PerfReportOverlay`](js/ui/PerfReportOverlay.js:1) / [`AutoProfileSweep`](js/systems/AutoProfileSweep.js:1)** — these *are* unconditional rAF loops, but they are opt-in diagnostics gated behind URL flags; per §14.3.2 they are deliberately exempt from the §12.12 throttling policy.
- **`navSphere._frameSkip % 6 !== 0` throttle to 10 Hz** — looks like it could go higher (e.g. 5 Hz) but the radar's perceived smoothness at 10 Hz is the user-facing contract. Do not throttle further.

---

*End of audit.*
