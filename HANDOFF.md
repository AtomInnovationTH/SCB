# Space Cowboy — Next-Shift Handoff Brief

*Updated: 2026-06-06 · Daughter capture-lifecycle polish complete (commit `b7d5fae`). Prior shift archived to [`archive/HANDOFF_2026-05-30_four-fix.md`](archive/HANDOFF_2026-05-30_four-fix.md). Earlier shifts at [`archive/HANDOFF_2026-05-29_post-cinch-qa.md`](archive/HANDOFF_2026-05-29_post-cinch-qa.md), [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md), [`archive/SK_M1_POLISH_HANDOFF.md`](archive/SK_M1_POLISH_HANDOFF.md), [`archive/CEREMONY_REDESIGN.md`](archive/CEREMONY_REDESIGN.md).*

---

## 🚀 Next Shift? Start Here

### Step 1 — Orient (15 min)

| # | Read | Why |
|---|------|-----|
| 1 | [`§1 Session Summary`](#1-session-summary-2026-06-06) + [`§5 Recommended Next Steps`](#5-recommended-next-steps) | What just shipped + what's ready to pick up |
| 2 | [`§9 THREE.js Convention SSOT`](#9-threejs-convention-ssot-load-bearing) + [`§10 Post-Cinch Learnings`](#10-post-cinch-fix-learnings-load-bearing) | Load-bearing rules — read BEFORE touching orientation, FSM, capture lifecycle, or visual code |
| 3 | [`README.md`](README.md:1) | Quick start, controls, controls reference |
| 4 | [`GAME_DESIGN.md`](GAME_DESIGN.md:1) §1–§3 | Core loop, jellyfish identity, ΔV economy |
| 5 | [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | File structure, module design, state machine (⚠️ needs Epic 9/10 update) |

### Step 2 — Verify baseline

```bash
node js/test/run-tests.js | tail -3    # expect: 608 suites / 2530 tests / 0 failures
```

If red, see [`archive/SK_M1_POLISH_HANDOFF.md §7 Appendix`](archive/SK_M1_POLISH_HANDOFF.md) for diagnostic-log grep targets.

### Step 3 — Pick a task

See [`§5 Recommended Next Steps`](#5-recommended-next-steps). Items are ordered by effort/impact and ready for Orchestrator to research+architect+code.

---

## §1 Session Summary (2026-06-06)

**Daughter capture-lifecycle polish.** Commit `b7d5fae` — *"feat(capture): daughter capture lifecycle polish — reel-in fix, failure overhaul, log strip."* This session chased a headline reel-in disappearance bug to ground, replaced the fragile per-frame capture pin with an authoritative path, built a two-mode capture-failure model, added first-time-player guidance for failures, smoothed station-keep entry, hardened `getDebrisNear`, and stripped all diagnostic logging from hot paths. Test delta: **556 suites / 2364 tests → 608 suites / 2530 tests / 0 failures** (+52 suites / +166 tests).

### What shipped

| # | Change | One-line outcome |
|---|---|---|
| 1 | **Reel-in disappearance fix** (headline) | Catch now reels in welded to the daughter instead of drifting ~600 m away on the debris's own orbit and vanishing |
| 2 | **Net stays visible through the haul** | Daughter's net is held cinched on the debris in REELING until the arm delivers, instead of stowing on its own short timeline mid-haul |
| 3 | **Docking delivery no longer pops out** | Debris removal deferred to dock completion; catch stays visible at the mother with a stow-shrink, then removed cleanly |
| 4 | **Capture-failure overhaul** | Two distinct modes — recoverable NET FAILURE vs catastrophic TETHER SNAP — each with distinct comms + HUD alerts; in-spec catches never snap |
| 5 | **First-time player guidance** | Two new teaching moments (`first_net_failed`, `first_tether_snap`) explaining what happened + recovery |
| 6 | **Station-keep entry smoothing** | Ease standoff radius from SK-entry distance to nominal; removes the "speeds up then camera jumps" artifact; gentler launch ceremony |
| 7 | **`getDebrisNear` hardening + canonical resolve** | `getDebrisNear` returns read-only snapshots; ArmManager resolves fishing/web-shot lists to canonical objects by id |
| 8 | **Debug-log strip** | Removed all `DBG-*` / `[AUTO-TARGET]` / `[DAP-*]` / `[SK-ENTER/EXIT]` / `[NETTING-FSM]` console logging + dead diagnostic blocks + `_dbg*` helpers |

### 1.1 Reel-in disappearance fix (the headline bug)

**Symptom.** After a daughter netted debris, the net + debris drifted ~600 m away on the debris's *own* orbit and vanished during reel-in.

**Root-cause investigation.** It was NOT a duplicate/clone object — a one-shot `[DBG-ID]` diagnostic proved `capturedRef === canonical, idCountInList = 1`. The real cause: `DebrisField`'s per-frame `_capturedByArm` pin did not reliably keep the *rendered* instance on the arm during the haul, because **`DebrisField.update()` runs BEFORE `ArmManager.update()` each frame** (line ordering in [`js/main.js`](js/main.js:1) ~1274 vs ~1278). The debris instance transform was being recomputed from the orbit branch after the arm had already moved.

**Fix.** New authoritative [`DebrisField.pinCapturedDebris(debrisRef, armScenePos, scaleMul)`](js/entities/DebrisField.js:1), called from [`ArmManager.update()`](js/entities/ArmManager.js:1) **AFTER** the arms move. It looks the canonical debris up by id (the same key [`_instanceLookup`](js/entities/DebrisField.js:1) / [`removeDebris`](js/entities/DebrisField.js:1) use) and forces both the canonical debris and its instanced-mesh matrix onto the arm position, overriding the orbit branch. [`ArmUnit`](js/entities/ArmUnit.js:1) also calls `_pinCatchToSelf()` during REELING/DOCKING. **Net effect: the catch reels in welded to the daughter.**

### 1.2 Net stays visible through the haul

The net projectile used to stow on its own short timeline (`tetherPaidOut / REEL_SPEED`) and the bag visual vanished mid-haul. Now [`CaptureNet`](js/entities/CaptureNet.js:1) holds a daughter's net in REELING (`_heldByArm`, set in [`CaptureNetSystem`](js/systems/CaptureNetSystem.js:1) auto-reel for `armIndex >= 0` successful catches) so the bag stays cinched on the debris until the arm delivers. It auto-releases/stows once the catch is no longer pinned (`targetDebris._capturedByArm` cleared). **Mother-pod captures are unaffected.**

### 1.3 Docking delivery no longer pops out

Debris removal was deferred from `ARM_RETURNED` (dock arrival) to `DEBRIS_CAPTURED` (dock completion, ~3 s later) — see [`GameFlowManager`](js/systems/GameFlowManager.js:1)'s new `DEBRIS_CAPTURED` handler and the NOTE in its `ARM_RETURNED` handler. The catch stays visible at the mother through docking with a stow-shrink (1.0 → 0.15) applied via `pinCapturedDebris`'s `scaleMul`, then is removed cleanly. [`ArmUnit._updateDocking`](js/entities/ArmUnit.js:1) releases the pin **BEFORE** emitting `DEBRIS_CAPTURED` so the deferred `removeDebris` doesn't warn about an active captor.

### 1.4 Capture-failure overhaul ([`ArmUnit`](js/entities/ArmUnit.js:1))

Two distinct modes:

- **(a) NET FAILURE (recoverable)** via `_checkNetIntegrityOnReel()` at GRAPPLED → REELING:
  - **OVERSIZE** (deterministic) — debris wider than net mouth `_netDiameter`.
  - **STRAIN** (probabilistic) — payload near `_netRatedMass`, scaling to `NET_STRAIN_FAIL_PROB_MAX`.
  - Outcome: debris drifts free and re-capturable; daughter keeps tether and RETURNS to reload.
- **(b) TETHER SNAP (catastrophic)** via `_snapTether()`:
  - Only on genuine overload — reel tension retuned via `REEL_TENSION_COEFF = 0.04` so in-spec catches never snap.
  - Daughter + catch cut loose and **drift TOGETHER** (never silently vanish); recoil impulse applied; severed line hidden; bounded drift via `TETHER_SNAP_RELEASE_DELAY_S` then pin released.

Shared release helper `_releaseCapturedDebris({ keepPinned })`. New event [`Events.NET_FAILED`](js/core/Events.js:1). Distinct comms ([`CommsSystem`](js/systems/CommsSystem.js:1)) + HUD alerts ([`HUD.showNetFailedAlert`](js/ui/HUD.js:1) amber, vs tether-snap red).

### 1.5 First-time player guidance ([`TeachingSystem`](js/systems/TeachingSystem.js:1))

Two new teaching moments `first_net_failed` and `first_tether_snap` (`TOTAL_MOMENTS` 17 → 19), triggered by the new events, explaining what happened + recovery.

### 1.6 Station-keep entry smoothing

Ease standoff radius from the actual SK-entry distance to nominal over `STATION_KEEP.STANDOFF_SETTLE_TAU_S = 0.6 s` (removes the "speeds up then camera jumps" artifact, since the SK gate fires at up to 2× standoff while still closing). Gentler launch-ceremony pacing in [`CameraSystem`](js/systems/CameraSystem.js:1) (durations + FOV ease).

### 1.7 `getDebrisNear` hardening + canonical resolve

[`DebrisField.getDebrisNear`](js/entities/DebrisField.js:1) now returns read-only **snapshots** (cloned `_scenePosition` / `orbit`) instead of sharing the canonical's mutable refs — prevents a caller mutating a result from corrupting real debris. [`ArmManager`](js/entities/ArmManager.js:1) now resolves the fishing/web-shot `_nearbyDebris` list to canonical objects by id. (Finding: `getDebrisNear` was the only "shared-mutable-ref clone factory"; most consumers already re-resolve via `getDebrisById`, and [`SensorSystem._revealNearbyDebris`](js/systems/SensorSystem.js:1) already does.)

### 1.8 Debug-log strip

Removed all `DBG-*` / `[AUTO-TARGET]` / `[DAP-*]` / `[SK-ENTER/EXIT]` / `[NETTING-FSM]` console logging from hot paths ([`ArmUnit`](js/entities/ArmUnit.js:1), [`DebrisField`](js/entities/DebrisField.js:1), [`CameraSystem`](js/systems/CameraSystem.js:1), [`AutopilotSystem`](js/systems/AutopilotSystem.js:1), [`InputManager`](js/systems/InputManager.js:1), [`GameFlowManager`](js/systems/GameFlowManager.js:1), [`TargetSelector`](js/systems/TargetSelector.js:1), [`TargetPanel`](js/ui/hud/TargetPanel.js:1), [`HUD`](js/ui/HUD.js:1)) plus dead diagnostic blocks; removed the `_dbg*` helper fns.

### Test suite

**608 suites / 2530 tests / 0 failures** as of 2026-06-06. New files: [`test-ArmUnit-CaptureFailure.js`](js/test/test-ArmUnit-CaptureFailure.js:1), [`test-DebrisField-PinCatch.js`](js/test/test-DebrisField-PinCatch.js:1) (both registered in [`run-tests.js`](js/test/run-tests.js:1)); updated CommsSystem / Constants / TeachingSystem / CaptureNet suites.

---

## §2 Architecture Changes

### 2.1 Authoritative captured-debris pin ([`DebrisField`](js/entities/DebrisField.js:1) + [`ArmManager`](js/entities/ArmManager.js:1))

New method [`DebrisField.pinCapturedDebris(debrisRef, armScenePos, scaleMul)`](js/entities/DebrisField.js:1) is the **canonical** way to keep a captured debris welded to a hauling arm. It is called from [`ArmManager.update()`](js/entities/ArmManager.js:1) **after** the arms move (because `debrisField.update()` runs first each frame — see [`§10 Rule G`](#rule-g-new-this-shift--frame-update-order-debris-before-arms)). It resolves the canonical debris by id, then forces both the debris and its instanced-mesh matrix onto the arm position with an optional `scaleMul` (used for the docking stow-shrink). This **overrides** the orbit branch in `_updateInstanceTransform`. The old per-frame `_capturedByArm` pin remains but is no longer load-bearing for daughter hauls.

### 2.2 New tuning constants ([`js/core/Constants.js`](js/core/Constants.js:1))

| Constant | Value | Purpose |
|---|---|---|
| `REEL_TENSION_COEFF` | `0.04` | Reel-tension scaling; retuned so in-spec catches never trigger tether snap |
| `NET_STRAIN_SAFE_FRACTION` | `0.8` | Fraction of `_netRatedMass` below which strain failure cannot occur |
| `NET_STRAIN_FAIL_PROB_MAX` | `0.35` | Max probabilistic net-strain failure chance near rated mass; **set `0` to disable random net loss** |
| `CAPTURE_RELEASE_SEPARATION_MPS` | `1.2` | Separation velocity imparted to debris on recoverable release |
| `TETHER_SNAP_RELEASE_DELAY_S` | `8.0` | Bounded drift duration after a tether snap before the pin is released |
| `STATION_KEEP.STANDOFF_SETTLE_TAU_S` | `0.6` | Time constant for easing SK standoff radius from entry distance to nominal |

### 2.3 New event ([`js/core/Events.js`](js/core/Events.js:1))

| Event | Emitted by | Consumed by |
|---|---|---|
| `Events.NET_FAILED` | [`ArmUnit`](js/entities/ArmUnit.js:1) `_checkNetIntegrityOnReel()` | [`CommsSystem`](js/systems/CommsSystem.js:1), [`HUD`](js/ui/HUD.js:1), [`TeachingSystem`](js/systems/TeachingSystem.js:1) |

### 2.4 Held-net lifecycle ([`CaptureNet`](js/entities/CaptureNet.js:1) + [`CaptureNetSystem`](js/systems/CaptureNetSystem.js:1))

A daughter's net carries a `_heldByArm` flag, set by the auto-reel path in [`CaptureNetSystem`](js/systems/CaptureNetSystem.js:1) for `armIndex >= 0` successful catches. While held, the net does not stow on its own `tetherPaidOut / REEL_SPEED` timeline; the bag stays cinched on the debris through REELING. It auto-releases/stows once `targetDebris._capturedByArm` is cleared. Mother-pod captures (`armIndex < 0`) keep the legacy stow timeline.

### 2.5 Deferred dock removal ([`GameFlowManager`](js/systems/GameFlowManager.js:1))

Debris removal moved from the `ARM_RETURNED` handler (dock arrival) to a new `DEBRIS_CAPTURED` handler (dock completion, ~3 s later). The `ARM_RETURNED` handler carries a NOTE documenting the deferral. [`ArmUnit._updateDocking`](js/entities/ArmUnit.js:1) releases the pin **before** emitting `DEBRIS_CAPTURED`, so the deferred `removeDebris` does not warn about an active captor.

### 2.6 New tests

| File | Coverage |
|---|---|
| [`js/test/test-ArmUnit-CaptureFailure.js`](js/test/test-ArmUnit-CaptureFailure.js:1) **NEW** | Net-failure (oversize/strain) vs tether-snap branching; in-spec catches never snap; release helper behaviour; `NET_FAILED` emission |
| [`js/test/test-DebrisField-PinCatch.js`](js/test/test-DebrisField-PinCatch.js:1) **NEW** | `pinCapturedDebris` canonical-by-id resolve; matrix override of orbit branch; `scaleMul` stow-shrink |
| [`js/test/run-tests.js`](js/test/run-tests.js:1) | Imports both new test files |

---

## §3 State of the Code

### 3.1 Test suite

```bash
$ node js/test/run-tests.js | tail -3
608 suites / 2530 tests / 0 failures
```

Run with `./test.sh` or `node js/test/run-tests.js`. Pattern filter: `node js/test/run-tests.js --filter CaptureFailure`.

### 3.2 Files modified this session

| File | Change summary |
|---|---|
| [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:1) | Two-mode capture-failure model (`_checkNetIntegrityOnReel`, `_snapTether`, `_releaseCapturedDebris`); `_pinCatchToSelf` during REELING/DOCKING; `_updateDocking` releases pin before `DEBRIS_CAPTURED`; debug-log strip |
| [`js/entities/DebrisField.js`](js/entities/DebrisField.js:1) | New `pinCapturedDebris(debrisRef, armScenePos, scaleMul)`; `getDebrisNear` returns read-only snapshots; debug-log strip |
| [`js/entities/ArmManager.js`](js/entities/ArmManager.js:1) | Calls `pinCapturedDebris` after arms move; resolves fishing/web-shot `_nearbyDebris` to canonical by id |
| [`js/entities/CaptureNet.js`](js/entities/CaptureNet.js:1) | `_heldByArm` held-net lifecycle for daughter REELING |
| [`js/systems/CaptureNetSystem.js`](js/systems/CaptureNetSystem.js:1) | Sets `_heldByArm` on `armIndex >= 0` successful auto-reel |
| [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js:1) | New `DEBRIS_CAPTURED` handler (deferred removal); NOTE in `ARM_RETURNED`; debug-log strip |
| [`js/systems/CommsSystem.js`](js/systems/CommsSystem.js:1) | Distinct net-failure vs tether-snap comms |
| [`js/ui/HUD.js`](js/ui/HUD.js:1) | `showNetFailedAlert` (amber) vs tether-snap (red); debug-log strip |
| [`js/systems/TeachingSystem.js`](js/systems/TeachingSystem.js:1) | `first_net_failed` + `first_tether_snap` moments; `TOTAL_MOMENTS` 17 → 19 |
| [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js:1) | Gentler launch-ceremony pacing (durations + FOV ease); debug-log strip |
| [`js/core/Constants.js`](js/core/Constants.js:1) | New tuning constants (§2.2); `STATION_KEEP.STANDOFF_SETTLE_TAU_S` |
| [`js/core/Events.js`](js/core/Events.js:1) | New `Events.NET_FAILED` |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:1), [`js/systems/InputManager.js`](js/systems/InputManager.js:1), [`js/systems/TargetSelector.js`](js/systems/TargetSelector.js:1), [`js/ui/hud/TargetPanel.js`](js/ui/hud/TargetPanel.js:1) | Debug-log strip only |

### 3.3 Active terminals / running processes

None expected. If a browser dev session was left open, `Cmd+Shift+R` to force-reload.

---

## §4 Known Issues & Deferred Items

### 4.1 Latent design question (not a bug)

The `getDebrisNear`-clone pattern is still used widely. Consider migrating callers to a `{ debris, distance }` shape long-term, or documenting the "snapshot, resolve-by-id to mutate" contract on the method. See [`§5`](#5-recommended-next-steps).

### 4.2 Perf tradeoff to watch

`getDebrisNear` now clones `_scenePosition` / `orbit` per result (bounded by nearby debris, range-gated). If profiling flags it, the caching approach noted in [`archive/QUICK_WINS_PERF.md`](archive/QUICK_WINS_PERF.md:1) / [`archive/GPU_PROFILING_REPORT.md`](archive/GPU_PROFILING_REPORT.md:1) is the follow-up.

### 4.3 Carried-forward backlog from prior shifts

The four-fix sprint's deferred items (differential `setThrusterFire`, `test-TargetRanking.js`, `SpacecraftMaterials.js` extraction, `RENDER_ORDER` extension, dynamic `DIST_REF_KM`, the two remaining inline ARM_STATES sites) remain open — full detail in [`archive/HANDOFF_2026-05-30_four-fix.md §4`](archive/HANDOFF_2026-05-30_four-fix.md). The [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md:1) wiring gaps (TetherReel, BridleRing, Web Shot key binding) are likewise still open.

---

## §5 Recommended Next Steps

Ordered by effort/impact. Each is ready for Orchestrator to research+architect+code.

| Rank | Task | Effort | Notes / Acceptance |
|---|---|---|---|
| 1 | **In-game playtest verification of the capture lifecycle** | ~1h | Verify reel-in (catch welded to daughter), dock stow-shrink, net-failure on oversize/heavy debris, tether-snap drift, and the two new teaching cards (`first_net_failed`, `first_tether_snap`) all read correctly in the browser |
| 2 | **Verify fishing/trawl behavior in-game** | ~1h | Resolving `_nearbyDebris` to canonical now makes fishing proximity-capture **actually functional** (it was effectively dead because the sparse wrappers lacked `_scenePosition`). Fishing may now auto-capture where it previously never did — confirm intended behavior |
| 3 | **`getDebrisNear` perf profile** | ~30 min | Profile the per-result `_scenePosition` / `orbit` clone under dense-debris load. If hot, apply the caching approach from [`archive/QUICK_WINS_PERF.md`](archive/QUICK_WINS_PERF.md:1) |
| 4 | **Document / migrate the `getDebrisNear` snapshot contract** | ~1.5h | Either migrate callers to a `{ debris, distance }` shape, or formalize the "snapshot, resolve-by-id to mutate" contract as a JSDoc on the method + a guard test |
| 5 | **Pick up the four-fix backlog** | varies | `setThrusterFire`, `test-TargetRanking.js`, `SpacecraftMaterials.js`, `RENDER_ORDER` extension — see [`archive/HANDOFF_2026-05-30_four-fix.md §5`](archive/HANDOFF_2026-05-30_four-fix.md) |

---

## §9 THREE.js Convention SSOT (load-bearing)

> **READ BEFORE TOUCHING ANY ORIENTATION / ROTATION / VISIBILITY CODE.** Carried forward across shifts. A single-character convention bug at [`CaptureNetVisual.js:952`](js/ui/CaptureNetVisual.js:952) made the capture-net cinch render on the DAUGHTER side of the debris for the entire life of the ceremony visual. Multiple sessions worked AROUND the bug without seeing it because every prior test inspected only LOCAL coordinates — never `getWorldPosition()`. The 2026-05-30 ROSA fix hit the SAME class of bug (DoubleSide hiding back-face semantics until the ship inverted). **This shift's reel-in disappearance bug is the FRAME-ORDER variant** — the captured debris was POSITIONED correctly by the arm, then immediately overwritten by `DebrisField.update()` running first. Pattern repeats: the symptom is a visual disappearance; the root cause is a pipeline-ordering / convention mismatch, not a missing object.

### Rule 1 — `Object3D.lookAt` and `Camera.lookAt` use OPPOSITE conventions

| Receiver type | After `obj.lookAt(target)`, local **forward** axis is... |
|---|---|
| `Camera`, `Light` | local **−Z** points TOWARD `target` (OpenGL camera convention) |
| `Object3D`, `Group`, `Mesh` | local **+Z** points TOWARD `target` |

**Pre-flight checklist before calling `.lookAt(point)`:**
1. Is the receiver a `Camera`/`Light`? Local −Z = "forward" (faces target).
2. Is the receiver a `Group`/`Mesh`? Local **+Z** = "forward" (faces target).
3. Does your geometry's "front face" axis match the receiver's convention?
4. If a Group must have its **mouth on local −Z**, pass `lookAt(position − dir × ε)` — NOT `+`.

### Rule 2 — `Matrix4.lookAt(eye, target, up)` — z = `eye − target`

When you build rotation manually with `mat.lookAt(eye, target, up)` and apply via `quaternion.setFromRotationMatrix`:
- The matrix's local **+Z** in world = `(eye − target).normalize()` ⇒ points AWAY from `target`, TOWARD `eye`.
- `local +Z = forward` is **always** the convention for the resulting quaternion (receiver-type branching is `Object3D.lookAt`-only, not `Matrix4.lookAt`).

**When using `Matrix4.lookAt` directly: declare what your mesh's "default forward" axis is (named constant), and pass eye/target in the order that aligns matrix +Z with that intent.**

### Rule 3 — Scene units: `M = 1e-5` everywhere

- **1 metre** = `M = 1e-5` scene units. **1 scene unit** = **100 km**.
- Entity `position` fields (`NetProjectile.position`, `ArmUnit.position`, `_scenePosition`, `target._scenePosition`) are in **metres**.
- Object3D `position` (`mesh.position`, `group.position`) is in **scene units**.
- The conversion happens at the boundary: `group.position.set(net.position.x * M, ...)`.
- If you see an unexpected `1e+5` or `* M` factor, suspect a unit-frame mismatch.

### Rule 4 — Default geometry axes & how to align them

| Geometry | Default symmetry axis | To align with launchDir / forward |
|---|---|---|
| `ConeGeometry(r, h)` | Y (apex at +Y, base at −Y) | `geo.rotateX(PI/2)` ⇒ apex at +Z, base at −Z |
| `CylinderGeometry(r1, r2, h)` | Y | `geo.rotateX(PI/2)` ⇒ axis along Z |
| `TorusGeometry(r, t)` | normal = +Z (ring in XY plane) | typically no rotation |
| `PlaneGeometry(w, h)` | normal = +Z | no rotation for billboarded sprites |
| `ShapeGeometry(shape)` | normal = +Z | **single face range — cannot split into front/back via material groups; use two coincident meshes (Issue 4 pattern)** |

`geo.rotateX(PI/2)` and `geo.translate(x, y, z)` mutate the GEOMETRY (vertex positions) — applied once at construction. The Object3D's `.rotateX(angle)` rotates the OBJECT (frame-relative).

### Rule 5 — Quaternion setters: always with named source/target constants

Use module-scope const vectors:

```js
const _armForward  = new THREE.Vector3(0, 0, 1);  // PlayerSatellite.js:40
const _strutFrom   = new THREE.Vector3(0, -1, 0); // PlayerSatellite.js:33
const _yUpCollar   = new THREE.Vector3(0, 1, 0);  // PlayerSatellite.js:521
```

Then `_armQuat.setFromUnitVectors(_armForward, sg.strutDir)` reads as "rotate the arm's local +Z forward to point along strut direction." Self-documenting. **Don't inline raw `new THREE.Vector3(0, 0, 1)` calls.**

### Rule 6 — RENDER_ORDER is the deterministic tiebreaker

`polygonOffset` is a finer-grained tool but cannot order across transparency passes and varies across GPUs. **Every mesh in a spacecraft hierarchy MUST declare a `renderOrder` from the [`RENDER_ORDER`](js/core/Constants.js:1) enum.** The 6-tier convention:

```
EARTH=0  →  SPACECRAFT_OPAQUE=1  →  DETAIL=2  →  TRANSPARENT=3  →  ADDITIVE=4  →  HUD=10
```

Within the same renderOrder, Three.js sorts opaque front-to-back automatically; renderOrder is the explicit override for z-fight tiebreaking AND the only way to order Additive transparency.

### Rule 7 — GL_LINES has no face culling

If your wireframe must hide on back-facing surfaces (e.g., to avoid back-side grid bleeding through a panel-back substrate), `BufferGeometry` + `LineSegments` with `side: FrontSide` does **not** cull — GL_LINES primitives have no face. Solution: **custom ShaderMaterial with view-dot-normal discard at the fragment level** (implementation in [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1)).

### Diagnostic workflow (re-usable)

1. Add `globalThis.<FLAG>`-gated `console.log` at suspected frame-conversion sites.
2. Enable: `globalThis.<FLAG> = true`. Capture log.
3. Compare predicted vs observed values — look for sign flips, magnitude mismatches, unit-scale errors.
4. Locate conversion site producing wrong sign/magnitude. Apply fix.
5. **Mutation-test the regression:** revert fix, run tests, confirm they FAIL with localized error. Re-apply.
6. Remove ALL instrumentation. Grep-clean. *(This shift's debug-log strip is the cleanup step for the prior sessions' instrumentation — keep this discipline.)*
7. Add SSOT note here if a new convention is established.

---

## §10 Post-Cinch-Fix Learnings (load-bearing)

*Companion SSOT to §9. Captured during the post-cinch QA shift; reinforced across subsequent shifts.*

### Rule A — Hotkey rebinding requires ≥ 6 sites of audit

1. [`InputManager.js`](js/systems/InputManager.js:1) handler (the binding itself)
2. [`Constants.js`](js/core/Constants.js:1) SkillsSystem definitions (`SKILLS.*.key`)
3. [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) inline HUD labels
4. [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) idle-state hints
5. Module-level docstrings in the affected system
6. [`README.md`](README.md:1) — controls summary AND systems paragraph AND key-bindings table (3 sites in README alone)

### Rule B — When extending FSM-state coverage, audit ALL conditional blocks for that FSM

```js
// AVOID — easy to forget one state when adding a new state:
if (state === A || state === B || ...) { /* sync */ }

// PREFER — canonical set lookup, single source of truth:
if (POST_FLIGHT_STATES.has(state)) { /* sync */ }
```

The 2026-05-30 Issue 2 fix is the textbook application — `_HIGH_RISK_ROT_STATES` and `_SOFT_ROT_STATES` sets in [`ArmManager.js`](js/entities/ArmManager.js:1), with `getRotationLockTier()` and `hasTetheredArm()` as the named predicates.

### Rule C — Visual geometry constants couple to camera offsets

Bumping a geometry constant (e.g., `CONE_LENGTH_FRAC`) requires matching updates at all hard-coded sites in [`CameraSystem.js`](js/systems/CameraSystem.js:1). Either (a) read the constant lazily in the lookAt function, or (b) bullet-comment the coupling at BOTH ends.

### Rule D — LOD guards must enumerate all "actively engaged" debris states

Any "user is engaged with this debris" predicate must be a function over multiple flags, not a single field. Future variants — debris-being-trawled, ablated, lassoed — will need adding. Candidate refactor: `_isUserEngaged(debris)` helper that ORs all relevant flags.

### Rule E — Empty-action feedback needs all 3 components

1. The gameplay event (e.g. [`Events.NET_EMPTY_CLICK`](js/core/Events.js:1))
2. The audio cue ([`audioSystem.playClickFail()`](js/systems/AudioSystem.js:1))
3. The on-screen comms message ([`Events.COMMS_MESSAGE`](js/core/Events.js:1) warning)

This shift's capture-failure overhaul applies the same pattern: `NET_FAILED` event → distinct comms ([`CommsSystem`](js/systems/CommsSystem.js:1)) → HUD alert ([`HUD.showNetFailedAlert`](js/ui/HUD.js:1)) → teaching moment. Both failure modes (net failure amber, tether snap red) get the full triad.

### Rule F — Spring/exponential models need a release path

A novel "spring resistance" gameplay mechanic was added to InputManager's rotation block (2026-05-30). The model needs *both* an opposing force (resistance) AND a release/recovery path (springback). Both were implemented. Test: holding arrows builds displacement; releasing arrows triggers springback to zero.

### Capture lifecycle learnings (NEW this shift — 2026-06-06)

These are **load-bearing** for anyone touching capture, reel-in, docking, or debris positioning.

#### Rule G (NEW this shift) — Frame update order: debris BEFORE arms

[`debrisField.update()`](js/entities/DebrisField.js:1) runs **BEFORE** [`armManager.update()`](js/entities/ArmManager.js:1) in [`js/main.js`](js/main.js:1) (~line 1274 vs ~1278). Anything that must position captured debris **from the arm's fresh position** must run AFTER arms move — that is exactly why [`pinCapturedDebris`](js/entities/DebrisField.js:1) is called from `ArmManager` post-arm-update, not from the debris update pass. **Symptom of getting this wrong: the captured object appears at its orbit position (drifting away / vanishing) instead of welded to the arm**, because the orbit branch in `_updateInstanceTransform` overwrites the arm-relative position later in the same frame.

#### Rule H (NEW this shift) — Pin/remove captured debris by canonical id, never by holding a ref

[`getDebrisNear`](js/entities/DebrisField.js:1) / [`getTargetList`](js/entities/DebrisField.js:1) / `getUntrackedDebrisNear` return throwaway **wrappers/snapshots** (post-this-shift, `getDebrisNear` clones `_scenePosition` / `orbit`). To mutate / hold / flag / remove a debris, resolve the canonical object via [`getDebrisById(id)`](js/entities/DebrisField.js:1) first. The reel-in bug investigation confirmed the capture was operating on the canonical object (`idCountInList = 1`) — the failure was positional ordering (Rule G), not a stale ref — but the **safe contract is: snapshot to read, resolve-by-id to mutate.**

#### Rule I (NEW this shift) — Prefer the authoritative pin path over per-frame flags

The `_capturedByArm` per-frame pin in [`DebrisField._updateInstanceTransform`](js/entities/DebrisField.js:1) is **fragile** for station-keep / welcome-field debris (it competes with the orbit branch and depends on update ordering). The authoritative `_armPinned` / `_armPinPos` + [`pinCapturedDebris`](js/entities/DebrisField.js:1) path is the reliable one and should be used for any new "hold this object on a moving arm" requirement.

### Cross-rule diagnostic workflow

When the user reports a visual symptom (e.g. "X is invisible during state Y", "X reads as a shadow", or "X drifts away during reel-in"), walk the visual pipeline:

1. **Position** — being POSITIONED correctly, and is the position SURVIVING the frame? (FSM-state position sync — Rule B; **frame-update order — Rule G**)
2. **Scale** — being SCALED correctly? (LOD downscale — Rule D; stow-shrink `scaleMul`)
3. **Lifecycle** — being REMOVED prematurely? (state-transition cleanup; **deferred dock removal §2.5**)
4. **Material/Face** — back face vs front face, DoubleSide hiding semantics?
5. **Camera framing** — is the CAMERA actually showing it? (offsets + lookAt — Rule C)
6. **Feedback** — user expected feedback but got none? (empty-action 3-component — Rule E)

This shift's "catch drifts ~600 m away and vanishes during reel-in" symptom collapsed into a **step-1 frame-order root cause** (Rule G): the arm positioned the debris, then `debrisField.update()` — already run earlier that frame — had left the orbit branch in control. The fix moved positioning to an authoritative post-arm pin.

---

## §11 Key Architectural Learnings & Gotchas

These are **load-bearing** rules. Violating them silently breaks physics without triggering any existing test.

### 11.1 Y-up (Three.js) vs Z-up (ECI) — the axis convention trap

The scene frame uses **Three.js Y-up**. Classical orbital-mechanics textbooks use **ECI Z-up**. The original [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:469) was Y-up. The inverse [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129) was Z-up. The swap `y↔z` makes them a faithful round-trip.

- **Rule.** Any NEW code that round-trips `(position, velocity) → elements → (position, velocity)` MUST call the corrected function.
- **Guard test** — [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164).

### 11.2 `TIME_SCALE_GAMEPLAY` (10×) — the silent multiplier

[`Constants.TIME_SCALE_GAMEPLAY`](js/core/Constants.js:1) scales orbital propagation so one real second advances orbits ~10 s. Any physics quantity that is "per tick" must account for this or be **10× too small**.

**Rule.** Grep: `regex: TIME_SCALE_GAMEPLAY|gameDt`. Any physics loop computing impulses/velocities in m/s AND using `dt` (not `gameDt`) is suspect.

### 11.3 `_applyThrust()` vs `applyCartesianImpulse()` — when to use which

| API | Semantics | Use from |
|---|---|---|
| [`PlayerSatellite._applyThrust()`](js/entities/PlayerSatellite.js:2125) | Treats `(x, y, z)` as orbital-element rate channels: `x→Δe`, `y→Δi`, `z→Δa`. | Player input (`thrustIon`, RCS) — legacy contract |
| [`PlayerSatellite.applyCartesianImpulse(dvWorld, dt)`](js/entities/PlayerSatellite.js:2145) | Cartesian world-frame ΔV (m/s). Full round-trip via `cartesianToKeplerian`. | Autopilot, any new physically-consistent controller |

### 11.4 Collision-Avoidance exemption — two axes

[`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) maintains TWO exempt IDs: `_activeTargetId` (Tab-selection) and `_autopilotLockId` (autopilot lock event). **Any new "pursuit" system emits a LOCK event so CA stops fighting you.**

### 11.5 Test-stub blindness

**Stubs hide bugs.** Prefer integration tests over stubs. Factor-of-10 error? Suspect `TIME_SCALE_GAMEPLAY`. 90°/180° error? Suspect a local-to-world transform missing.

### 11.6 Scene-unit scale `M = 1e-5`

`M = 0.00001` = "1 metre in scene units" (scene unit = 100 km). Collisions have occurred. **Distances in metres in Constants; multiply by `M` at the boundary.**

### 11.7 Wiring-gap pattern (2026-05-17)

A system class can be imported in `main.js` and have full `init()` / `update(dt)` methods, but if `main.js` doesn't actually CALL them, the system is **silently dead**. Tests pass because they instantiate modules directly; the bug is browser-only.

**Confirmed orphaned wiring (still pending):** [`TetherReel.js`](js/systems/TetherReel.js:1), [`BridleRing.js`](js/entities/BridleRing.js:1) — neither imported nor init'd/update'd in [`main.js`](js/main.js:1). See [`DAUGHTER_RETRIEVAL_AUDIT.md §4`](DAUGHTER_RETRIEVAL_AUDIT.md:1).

**Rule.** Add `test-main-wiring.js` smoke test that asserts every system imported in `main.js` has `init()` OR `update()` called at least once during a mock boot cycle.

### 11.8 Inline ARM_STATES checks — three known bugs, two remain

**Pattern:** code that enumerates a subset of `ARM_STATES` inline with `||` chains is a recurring source of bugs. Three known cases:

1. ✅ **AutopilotSystem `armsActive`** — fixed 2026-05-30; now uses `armManager.hasTetheredArm()`.
2. ⚠️ **AutopilotSystem inline list at line ~697** — still inline. Different semantic from `hasTetheredArm()` (it checks "active maneuver" not "tethered"); needs a separate named predicate.
3. ⚠️ **RadialMenu inline check at line ~306** — still inline. Probably can adopt `hasTetheredArm()` directly.

**Rule.** Any inline `state === A || state === B || ...` over ARM_STATES is a code smell; promote to a named predicate on `ArmManager`.

### 11.9 Captured-debris positioning must run after arms move (2026-06-06)

See [`§10 Rule G`](#rule-g-new-this-shift--frame-update-order-debris-before-arms). `debrisField.update()` runs before `armManager.update()`; the authoritative [`pinCapturedDebris`](js/entities/DebrisField.js:1) must be invoked from the arm-update pass to survive the frame.

---

## §12 Project State Summary

### 12.1 What the game is

Browser-based orbital-debris-capture sim. The player pilots a V5 Crossbow mothership in LEO, finds & analyses tracked debris, flies the autopilot into a trailing rendezvous, then captures via Capture Net, Spinner/Weaver crossbow arms, or the Trawl sweep. Salvage refines into fuel/parts; a Skills Discovery system surfaces 33 gameplay techniques organically. The game teaches real aerospace concepts through play.

Core identity is **Jellyfish Fisherman** ([`GAME_DESIGN.md §2`](GAME_DESIGN.md:1)). ΔV is the master resource.

### 12.2 Tech stack

| Layer | Choice |
|---|---|
| Rendering | [`three@^0.170`](package.json:1) (WebGL, no engine) |
| Language | ES Modules, no bundler (native `<script type="module">`) |
| Server | Python `http.server` on port 8081 via [`start.sh`](start.sh:1) |
| Tests | Node-based harness, no browser; see [`js/test/TestRunner.js`](js/test/TestRunner.js:1) |

### 12.3 Test suite status

**608 suites / 2530 tests / 0 failures** as of 2026-06-06. Harness uses the real `three` runtime (not stubbed) for physics tests.

### 12.4 Systems & maturity

| System | File | Maturity |
|---|---|---|
| OrbitalMechanics | [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) | Stable |
| PlayerSatellite | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) | Stable — Config G + renderOrder pass + ROSA front/back |
| ArmManager / ArmUnit | [`ArmManager.js`](js/entities/ArmManager.js:1), [`ArmUnit.js`](js/entities/ArmUnit.js:1) | Stable — 2026-06-06 capture-failure model + authoritative catch pin + canonical `_nearbyDebris` resolve |
| AutopilotSystem | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | Stable |
| InputManager | [`InputManager.js`](js/systems/InputManager.js:1) | Stable — spring-resistance rotation model |
| DebrisField | [`DebrisField.js`](js/entities/DebrisField.js:1) | Stable — 2026-06-06 `pinCapturedDebris` + `getDebrisNear` snapshots. 2093+ LOC (split candidate) |
| CaptureNet + CaptureNetVisual | [`CaptureNet.js`](js/entities/CaptureNet.js:1), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) | Stable — 2026-06-06 held-net lifecycle for daughter REELING |
| GameFlowManager | [`GameFlowManager.js`](js/systems/GameFlowManager.js:1) | Stable — 2026-06-06 deferred dock removal (`DEBRIS_CAPTURED`) |
| CommsSystem | [`CommsSystem.js`](js/systems/CommsSystem.js:1) | Stable — 2026-06-06 net-failure vs tether-snap comms |
| TargetPanel | [`TargetPanel.js`](js/ui/hud/TargetPanel.js:1) | Stable — 4-way sort + MOID badges |
| CollisionAvoidance | [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:1) | Stable |
| LassoSystem | [`LassoSystem.js`](js/systems/LassoSystem.js:1) | OK but slow — backlog |
| ConjunctionSystem | [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:1) | OK — MOID badges consumed by TPI |
| TrawlManager | [`TrawlManager.js`](js/systems/TrawlManager.js:1) | OK |
| SkillsSystem / SkillsPane | [`SkillsSystem.js`](js/systems/SkillsSystem.js:1), [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) | Functional. 1869 LOC (split candidate) |
| ForgeSystem | [`ForgeSystem.js`](js/systems/ForgeSystem.js:1) | OK |
| TeachingSystem | [`TeachingSystem.js`](js/systems/TeachingSystem.js:1) | Functional — 2026-06-06 `first_net_failed` + `first_tether_snap` (19 moments) |

---

## §13 Active Docs Index

### 🟢 Canonical (6) — read first

| Doc | Purpose |
|---|---|
| [`README.md`](README.md:1) | Entry point, quick start, controls |
| [`HANDOFF.md`](HANDOFF.md:1) | **This file** — current shift, gotchas, next steps |
| [`GAME_DESIGN.md`](GAME_DESIGN.md:1) | Design vision — core loop, jellyfish identity, ΔV economy |
| [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | As-built technical reference (⚠️ Epic 9/10 update pending) |
| [`BIG_PICTURE.md`](BIG_PICTURE.md:1) | 12-month strategic roadmap |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md:1) | Sprint tracker — Sprints 1–4, Epics 5–10 + recent sprints |

### 🟡 Active references — read when touching their area

[`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md:1), [`CAPTURE_NET.md`](CAPTURE_NET.md:1), [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1), [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md:1), [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md:1), [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md:1), [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1), [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md:1), [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md:1), [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md:1).

### 🟠 Archives

[`archive/HANDOFF_2026-05-30_four-fix.md`](archive/HANDOFF_2026-05-30_four-fix.md:1) (prior shift), [`archive/HANDOFF_2026-05-29_post-cinch-qa.md`](archive/HANDOFF_2026-05-29_post-cinch-qa.md:1), [`archive/FIX_PLAN.md`](archive/FIX_PLAN.md:1), and the rest under [`archive/`](archive/).

---

## §14 Heritage — Prior Work Summaries

### 14.0 Four-Fix Architectural Sprint (2026-05-29/30, COMPLETE)

ROSA panel front/back split (solar-panel-shadow fix), tethered-arm rotation-lock spring model, RENDER_ORDER 6-tier enum + 50+ annotations, TPI composite target ranking. Tests 2320 → 2364 (+44). Service worker v4. Full write-up at [`archive/HANDOFF_2026-05-30_four-fix.md`](archive/HANDOFF_2026-05-30_four-fix.md:1).

### 14.1 Post-Cinch QA Pass + Doc Consolidation (2026-05-28/29, COMPLETE)

9 of 11 QA items resolved (cinch ring leading edge, net visibility during REELING, captured-debris LOD skip, reticle range font 2×, empty-net comms, R=reel + K=forge hotkey swap, spin-rate physics doc). Items 6/10/11 design content folded into [`GAME_DESIGN.md`](GAME_DESIGN.md:1). Tests +4, 2316→2320. Doc consolidation: 35 root .md → 16 canonical+active. Full write-up at [`archive/HANDOFF_2026-05-29_post-cinch-qa.md`](archive/HANDOFF_2026-05-29_post-cinch-qa.md:1).

### 14.2 Q2 Net-Launch Ceremony (2026-05-24, SHIPPED)

[`FEATURE_FLAGS.NET_CEREMONY`](js/core/Constants.js:1) default ON. 6 stages, [`NET_CINEMATIC`](js/systems/CameraSystem.js:1) camera mode with 7 beats / 3 beats on repeat. Tests 2207→2281 (+74). Full spec: [`archive/CEREMONY_REDESIGN.md`](archive/CEREMONY_REDESIGN.md:1).

### 14.3 Epic 10 — Config G Full Visualization (2026-05-08, COMPLETE)

V3 Octopus replaced with Config G: cylindrical barrel, collar-mounted struts, ROSA roll-out panels, FEEP nozzle polish, deploy-state LEDs, full stowage visual, launch cinematic, capture net visual, tier progression visual. 11 V-tasks delivered. Spacecraft anatomy: Barrel (0.4m R × 2.0m H) + Collar (Z=+0.90m, 4 hinge brackets at 60°/120°/240°/300°) + Struts (1.60m, sweep 0–180°) + ROSA panels. Archive specs in [`archive/EPIC10_VISUALIZATION_PLAN.md`](archive/EPIC10_VISUALIZATION_PLAN.md:1).

### 14.4 Epic 9 — Config G Arm System (2026-04-28, COMPLETE)

All 11 C-tasks delivered. Mass budget canonical: Y0 dry = 196.4 kg, wet = 242.4 kg. **25 feature flags** (11 new), **~25 new events**.

### 14.5 Epic 8 — Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage (2026-04-25, COMPLETE)

5 sprints, ~6 dev days. STATION_KEEP state, orbital-crane controls, dual-metal FEEP (7 metals), news-driven missions, ISRO comms personas (BANGALORE/HASSAN), ReputationSystem.

### 14.6 SK / Mission-1 Polish (2026-05-16) + Daughter SK Wiring (2026-05-17)

SK standoff zoom, sonar-ping restoration, mother AP HOLD suppression, M1 2 km debris cull, SkillsPane visibility gating. **Biggest lesson:** A backtick inside a template literal broke the browser silently — `node --check <file>` catches this; the test runner does not. Salvage state chain (capture path): `STATION_KEEP --F--> NETTING --(net.CAPTURED)--> GRAPPLED --(stabilize 1.5s)--> REELING --(reach mother)--> DOCKING --> RELOADING --> DOCKED`. See [`archive/SK_M1_POLISH_HANDOFF.md`](archive/SK_M1_POLISH_HANDOFF.md:1).

### 14.7 Sessions S19–S30 — Autopilot Rewrite + Trail System

See [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md:1).

---

## §15 Convention Reference Card (quick lookup)

| Rule | Source | TL;DR |
|---|---|---|
| Object3D vs Camera lookAt | §9 Rule 1 | Camera: −Z forward; Group/Mesh: +Z forward |
| Matrix4 lookAt sign | §9 Rule 2 | `mat.lookAt(eye, target, up)` ⇒ local +Z = `eye − target` |
| Scene units | §9 Rule 3 + §11.6 | `M = 1e-5` (metres → scene units). Entity `.position` in metres; Object3D `.position` in scene units |
| Geometry default axes | §9 Rule 4 | Cone/Cylinder: Y-axis → `geo.rotateX(PI/2)` for Z-aligned; ShapeGeometry single face range → two coincident meshes for front/back |
| Quaternion sources | §9 Rule 5 | Use named module-scope const vectors |
| RENDER_ORDER | §9 Rule 6 | Every spacecraft mesh declares `renderOrder` from the 6-tier enum |
| GL_LINES face culling | §9 Rule 7 | No face culling on line primitives; use ShaderMaterial view-dot-normal discard |
| Hotkey audit | §10 Rule A | 6 sites: InputManager + Constants + 2× StatusPanel + system docstring + README (×3) |
| FSM state lookup | §10 Rule B | Use `Set.has(state)` not `||` chains |
| Visual ↔ camera coupling | §10 Rule C | Geometry constants and camera offsets must reference each other in comments |
| LOD predicate | §10 Rule D | `_isUserEngaged(debris)` ORs all engagement flags |
| Empty-action feedback | §10 Rule E | (event, audio, comms) — all three or it feels broken |
| Spring/exponential models | §10 Rule F | Resistance + release/recovery path; release behaviour creates emergent skill depth |
| Frame update order | §10 Rule G (**NEW**) | `debrisField.update()` BEFORE `armManager.update()`; position captured debris AFTER arms move (authoritative pin) |
| Resolve debris by id | §10 Rule H (**NEW**) | `getDebrisNear`/`getTargetList` return snapshots/wrappers; `getDebrisById(id)` to mutate/hold/remove |
| Authoritative pin path | §10 Rule I (**NEW**) | `_armPinned` + `pinCapturedDebris` over the fragile per-frame `_capturedByArm` flag |
| Y-up vs Z-up | §11.1 | Three.js Y-up; orbital textbooks Z-up; round-trip needs `y↔z` swap |
| `gameDt` vs `dt` | §11.2 | `gameDt = dt × TIME_SCALE_GAMEPLAY` (10×). Physics-per-tick MUST use `gameDt` |
| AP impulse API | §11.3 | `_applyThrust` = element rates (legacy); `applyCartesianImpulse` = world-frame ΔV (modern) |
| CA exemption | §11.4 | Both `_activeTargetId` and `_autopilotLockId` must be set |
| Wiring-gap | §11.7 | A system imported in `main.js` is silently dead if `init()`/`update()` never called |
| Inline ARM_STATES | §11.8 | Three known bugs from this anti-pattern; promote to named predicate on ArmManager |

---

*End of HANDOFF.md (2026-06-06 rewrite). Current shift: daughter capture-lifecycle polish complete (`b7d5fae`). Next shift: see [`§5`](#5-recommended-next-steps).*
