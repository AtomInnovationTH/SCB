# Daughter Retrieval Audit — Wiring Survey + Session Knowledge Transfer

> **Created:** 2026-05-17 (immediately after Daughter SK + Salvage-Loop Wiring Pass).
> **Author:** Project-research audit. Read-only investigation; no source files modified.
> **Companion docs:** [`HANDOFF.md §10`](HANDOFF.md), [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md), [`CAPTURE_NET.md`](CAPTURE_NET.md), [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md).
>
> **Purpose:** Capture the verbatim session findings from the SK + capture-net debug pass AND systematically audit the OTHER retrieval methods listed in the [`ArmUnit.js update() switch`](js/entities/ArmUnit.js:1891) for the same wiring-gap pattern (system imported but never `init()`'d / `update()`'d).
>
> The capture-net path is now end-to-end functional. This document maps which of the remaining retrieval methods are also functional, which look wired but have latent issues, and which are dead on the vine.
>
> **✅ RESOLVED (2026-06-06, commit `b7d5fae`):** The reel-in disappearance bug (catch + net drifting ~600 m away on the debris's own orbit and vanishing during REELING) is fixed. Root cause was frame-update ordering — `DebrisField.update()` runs before `ArmManager.update()`, so the orbit branch overwrote the arm-relative position. Replaced the fragile per-frame `_capturedByArm` pin with an authoritative [`DebrisField.pinCapturedDebris()`](js/entities/DebrisField.js:1) called from `ArmManager` *after* arms move, plus a held-net lifecycle. See [`CAPTURE_NET.md §7.7`](CAPTURE_NET.md) and [`HANDOFF.md §1.1`](HANDOFF.md).
>
> **✅ Follow-up — "vanishes at the mother" (2026-06-06, park-the-catch, uncommitted):** the catch no longer shrinks-and-removes at the dock. The daughter now **parks** it cinched in the net at her strut tip (new `ARM_STATES.HOLDING_CATCH`), full-size, indefinitely — occupied while the other daughters stay free. Furnace transfer + breakdown are deferred. See [`HANDOFF.md §1.9`](HANDOFF.md) and [`CAPTURE_NET.md §7.7`](CAPTURE_NET.md).

---

## Table of Contents

1. [Session Knowledge Transfer (verbatim)](#1-session-knowledge-transfer-verbatim)
   - 1.1 Five-plus fixes shipped this session
   - 1.2 Architecture insights
   - 1.3 Daughter control keymap during STATION_KEEP
2. [Spec Inventory — Retrieval Methods the Design Calls For](#2-spec-inventory--retrieval-methods-the-design-calls-for)
3. [Implementation Status Matrix](#3-implementation-status-matrix)
4. [Confirmed Wiring Gaps](#4-confirmed-wiring-gaps)
5. [Suspected Functional Gaps](#5-suspected-functional-gaps)
6. [Recommended Fix Order](#6-recommended-fix-order)
7. [Open Questions for User](#7-open-questions-for-user)

---

## §1 Session Knowledge Transfer (verbatim)

This section reproduces the findings from the immediately-prior debug session so this document is self-contained. The same content is mirrored in [`HANDOFF.md §10`](HANDOFF.md) — keep them in sync if either is edited.

### §1.1 Fixes shipped this session

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | [`ArmUnit.js _updateTransit`](js/entities/ArmUnit.js:2351) | Manual-mode block now contains APPROACH-threshold check before `return;` | `enableManual()` fires during `LAUNCH_CEREMONY_COMPLETE` while arm is in TRANSIT; old `return;` skipped state transitions, arm coasted past target forever |
| 2 | [`ArmUnit.js _updateApproach`](js/entities/ArmUnit.js:2532) | Manual-mode block now contains distance-only SK gate check before `return;` (no velocity gate — controller is skipped) | Same root cause as #1 for APPROACH → STATION_KEEP transition |
| 3 | [`ArmUnit.js reelFromStationKeep()`](js/entities/ArmUnit.js:3048) (new method) | Exits SK → REELING (zero-fuel strut motor), not RETURNING (FEEP-powered). Mirrors `_exitStationKeep` cleanup pattern. | User-requested: "daughter out of fuel can't fly back" — REELING uses the mothership's strut reel motor via tether, no propellant |
| 4 | [`ArmManager.js _initArms()`](js/entities/ArmManager.js:219) | Added `arm.initNetInventory();` after every `new ArmUnit(...)` | The method existed but was NEVER called anywhere in production code. `_netInventory` stayed at 0; F-key capture blocked with `NET_EMPTY_CLICK` every press |
| 5 | [`main.js`](js/main.js:322) | Added `captureNetSystem.init()` before existing `captureNetVisual.init()`. Added `captureNetSystem.update(dt)` immediately before `captureNetVisual.update(dt)` in game loop. | The system was imported but `init()` and `update()` were NEVER called. Mother pod inventory uninitialized; net projectile FSM frozen (never advanced past FOLDED) |
| 6 | [`index.html`](index.html:352) importmap | Switched `three` and `three/addons/` from `cdn.jsdelivr.net` to `./node_modules/three/build/...` and `./node_modules/three/examples/jsm/` | Locked Product Principle #1 (Offline-First). Sim wouldn't start offline because THREE.js was CDN-loaded. The local node_modules already had the right version. |
| 7 | [`InputManager.js _onKeyDown R-key`](js/systems/InputManager.js:634) | During SK, R now calls `reelFromStationKeep()` (was: nothing useful; recenter handled in processInput which was removed). Forge toggle now suppressed during SK to avoid conflicting side-effect. | User said "automatically recenters" already works (auto-return Pattern C). R should now mean "reel in" — the daughter is on the strut tether and can be reeled back at zero fuel cost. |
| 8 | [`ArmUnit.js captureFromStationKeep()`](js/entities/ArmUnit.js:3032) | Added `COMMS_MESSAGE "Deploying net — stand by for capture"` on successful F-press. | Player feedback was silent before; F appeared to do nothing visually. |
| 9 | [`ArmUnit.js _updateNettingFSM`](js/entities/ArmUnit.js:3177) | Added `console.warn` on `fireDaughterNet` returning null (with inventory + flag details), and `console.log` on success. Tag: `[NETTING-FSM <armId>]` | Diagnostic — future regressions in net-fire path will print exact reason for fallback to APPROACH |

### §1.2 Architecture insights

1. **Update-loop order ([`main.js:505-523`](js/main.js:505)):** `inputManager.processInput` → `autopilotSystem.update` → `player.update` → `debrisField.update` → `armManager.update` → `captureNetSystem.update` (newly wired) → `captureNetVisual.update` → ... Order matters: input must precede physics; debris propagation must precede arm consumption of `target._scenePosition`; net system must advance projectile state before visual reads it.

2. **Wiring-gap pattern (CRITICAL — search for more):** A system class can be imported in `main.js` and have full `init()` / `update(dt)` methods, but if `main.js` doesn't actually CALL them, the system is silently dead. **Both** must be called. Tests pass because tests instantiate modules directly; the bug is browser-only. This was the cause for CAPTURE_NET in this session — look for the same pattern in other Epic 9/10 systems.

3. **Manual-mode (`_manualMode`) is a foot-gun.** `enableManual()` is called by `_enterArmPilotCamera()` (P-key + G-key entry) AND by the `LAUNCH_CEREMONY_COMPLETE` event handler ([`InputManager.js:129`](js/systems/InputManager.js:129)). It sets `_manualMode = true` even if the arm is in TRANSIT/APPROACH (not yet at SK). Manual-mode branches in `_updateTransit`/`_updateApproach` short-circuit autopilot AND state transitions. **Rule:** when adding new states with manual-mode branches, INJECT the state-transition check inside the manual block before `return;`, do NOT delete the manual block (it intentionally suppresses pings/thruster audio/AP-disengage-guard during ARM_PILOT mode).

4. **STATION_KEEP entry gate** ([`_updateApproach`](js/entities/ArmUnit.js:2638) line ~2638): `distMetres <= standoff * ENTRY_DISTANCE_MULT (2.0) && relVel < ENTRY_MAX_VELOCITY (3.0)`. In manual-mode branch, the velocity gate is DROPPED (distance-only). Rationale: the proportional braking controller is skipped in manual mode so the arm arrives at coast velocity; the SK lerp (`STATIONKEEP_LERP_RATE = 0.8`) converges in ~3 frames regardless. Imperceptible.

5. **`_initSkFrame()`** establishes the frozen entry triad so arrow keys map to screen-aligned yaw (θ around `_skPolarAxis = Earth radial at debris`) and pitch (φ around `_skRightVec = equator0 × polar`). The triad never recomputes mid-SK so the camera does not roll regardless of orbital inclination.

6. **Salvage state chain (capture path):** `STATION_KEEP --F--> NETTING --(net.CAPTURED)--> GRAPPLED --(stabilize 1.5s)--> REELING --(reach mother)--> DOCKING --> RELOADING --> DOCKED`. Detached arms cannot return: GRAPPLED → DEORBITING instead.

7. **Salvage exits without capture:**
   - `recallFromStationKeep()` → RETURNING (FEEP-powered, uses propellant)
   - `reelFromStationKeep()` → REELING (zero-fuel, mothership strut motor pulls via tether) — preferred for out-of-fuel daughters
   - Target lost / fuel depleted in SK → `_exitStationKeep()` → RETURNING (legacy behavior)

8. **CAPTURE_NET FSM gating:** When [`Constants.FEATURE_FLAGS.CAPTURE_NET === true`](js/core/Constants.js:417) (current default), `_updateNetting` delegates to `_updateNettingFSM`. Otherwise legacy 85% dice-roll path runs. The FSM lives in [`CaptureNet.js`](js/entities/CaptureNet.js) (14 states: FOLDED → LAUNCHING → SPINNING_UP → FLIGHT → CONTACT → ...).

9. **Diagnostic log convention reaffirmed:** `[DBG-<TAG>]` or `[<SUBSYS>-<EVENT>]` prefix. Use `console.warn` so logs appear in default DevTools filter. Examples in code: `[DBG-ARM]`, `[DAP-TRANSIT]`, `[DAP-APPROACH]`, `[SK-ENTER]`, `[SK-EXIT]`, `[NETTING-FSM]` (this session).

10. **Test runner does NOT cover browser-only behavior.** 464 suites / 2,067 tests / 0 failures, yet the SK regression + capture wiring + offline loading were all undetected. Run `node --check <file>` on every modified `.js` after edits (catches template-literal traps that test runner misses). Always verify visually in the browser.

### §1.3 Daughter control keymap (during STATION_KEEP)

| Key | Action | Code path |
|-----|--------|-----------|
| ← → ↑ ↓ | Orbit debris (θ yaw / φ pitch) | [`processInput`](js/systems/InputManager.js:1391) line ~1391 emits `ARM_ORBIT_ADJUST` → [`ArmUnit:288`](js/entities/ArmUnit.js:288) listener sets rate |
| Mouse wheel | Zoom standoff (4–12 m) | [`processInput _onWheel`](js/systems/InputManager.js:1391) → `ARM_ORBIT_ADJUST {radiusStep}` |
| **F** | Fire net → NETTING → GRAPPLED → auto-REELING | [`_onKeyDown:838`](js/systems/InputManager.js:838) → [`captureFromStationKeep()`](js/entities/ArmUnit.js:3032) |
| **R** | Reel in (zero-fuel strut motor → REELING → DOCKING) | [`_onKeyDown:640`](js/systems/InputManager.js:640) (during SK) → [`reelFromStationKeep()`](js/entities/ArmUnit.js:3052) |
| **ESC** | Recall via FEEP (RETURNING → DOCKING) | [`_onKeyDown:541`](js/systems/InputManager.js:541) → [`recallFromStationKeep()`](js/entities/ArmUnit.js:3041) |
| Shift | Fine mode (¼ rate) for orbit/zoom | Modifier on ARM_ORBIT_ADJUST |

---

## §2 Spec Inventory — Retrieval Methods the Design Calls For

Sources cross-referenced: [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) §1.2 (player task envelope), [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md), [`CAPTURE_NET.md`](CAPTURE_NET.md), and the [`ArmUnit.js update() switch`](js/entities/ArmUnit.js:1891).

> **Note:** No `DAUGHTER_MULTITOOL_SPEC.md` file exists in the repo (workspace search returned 0 results). The closest analog is [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) §1.2's task-envelope table ("Visual inspection / Net deployment / Grappling / Magnetic capture / Adhesion pad / Web shot"). Where this audit talks about "retrieval methods the spec calls for", it means the union of states present in the FSM switch + capabilities documented in the design docs above.

### §2.1 Capture / retrieval methods catalogued in the FSM

| Spec name | One-sentence summary | Intended input | Source doc |
|---|---|---|---|
| **Capture Net** (active F-press from SK) | Daughter at standoff fires a spinning mesh net; on cling, NETTING → GRAPPLED → REELING | `F` key in ARM_PILOT during SK | [`CAPTURE_NET.md §1`](CAPTURE_NET.md), [`DAUGHTER_ARM_CONTROLS.md §2.2`](DAUGHTER_ARM_CONTROLS.md) |
| **Fishing / passive ambush** | Arm deploys to end-of-tether and hibernates; auto-captures any debris that drifts within `netSize/2` | Comms-menu `ARM_FISH` event (no direct key) | [`ArmUnit._updateFishing`](js/entities/ArmUnit.js:3462), [`ArmManager.deployFishing`](js/entities/ArmManager.js:437) |
| **Trawl sweep** | Slow tethered sweep through a dense cluster; auto-captures small (`mass ≤ 50 kg`) debris along orbit path | `Shift+G` → `TRAWL_START` event | [`TrawlManager`](js/systems/TrawlManager.js), [`ArmUnit._updateTrawling`](js/entities/ArmUnit.js:3508) |
| **Web shot (GSL)** | Brief 2 s launch animation; sticks a drag-multiplying web to target — debris deorbits over time (no physical retrieval) | None bound in `_onKeyDown` (only via `ArmManager.fireWebShot()` API or comms radial) | [`ArmUnit.fireWebShot`](js/entities/ArmUnit.js:953) (Sprint D1) |
| **Ablation (laser de-spin)** | Onboard 10 W laser fires at target for ≤30 s; reduces angular velocity by `ABLATION_DESPIN_RATE` so debris is easier to capture later | None bound; gated by `FEATURE_FLAGS.ABLATION_MODULE` (false) | [`ArmUnit.startAblation`](js/entities/ArmUnit.js:1299) — V5 design, not retrieval per se |
| **Scanning (distributed sensor node)** | Arm holds position and acts as a sensor pulse emitter; orchestrated by ArmManager | None bound for the *arm-based* path (S-key fires mother-based `SCAN_QUICK`) | [`ArmUnit.startScan`](js/entities/ArmUnit.js:1330) |
| **Tangled (auto-recovery)** | Intermediate state — not a player retrieval method. Tether tangle resolves via gentle slack pulses over `TANGLE_RESOLVE_TIME`. | n/a (auto) | [`_updateTangled`](js/entities/ArmUnit.js:3792) |
| **Deorbiting (sacrifice burn)** | Arm burns all remaining fuel retrograde, taking captured debris (if any) with it. One-way. | `Ctrl+Shift+D` → `ARM_DEORBIT_CMD` event | [`_updateDeorbiting`](js/entities/ArmUnit.js:3644), [`InputManager:778`](js/systems/InputManager.js:778) |
| **Hauling (legacy tow)** | After GRAPPLED, legacy path was FEEP-powered tow back to mother. Burns fuel. | n/a — replaced by REELING in V5 | [`_updateHauling`](js/entities/ArmUnit.js:3268) — kept for back-compat, mostly orphaned |
| **Reeling (V5 zero-fuel return)** | After GRAPPLED or `reelFromStationKeep()`, mother's strut reel motor pulls the daughter (+ debris) back via tether. Zero propellant cost. | `R` during SK; also automatic post-capture | [`_updateReeling`](js/entities/ArmUnit.js:3306) |
| **Returning (FEEP self-return)** | Daughter flies itself back to mother under FEEP thrust — used when target is lost or player presses ESC during SK. Burns fuel. | `ESC` during SK; auto on target loss | [`_updateReturning`](js/entities/ArmUnit.js:3365), [`recallFromStationKeep`](js/entities/ArmUnit.js:3041) |

### §2.2 Retrieval methods called for by the design docs but NOT in the FSM switch

| Spec name | Where mentioned | FSM coverage |
|---|---|---|
| **Magnetic capture** | [`DAUGHTER_ARM_CONTROLS.md §1.2`](DAUGHTER_ARM_CONTROLS.md) (0.5–2 m range) | None — would need a new state (currently rolled into the slam-wrap net cling) |
| **Adhesion pad / docking-like contact** | [`DAUGHTER_ARM_CONTROLS.md §1.2`](DAUGHTER_ARM_CONTROLS.md) (0.1–0.5 m) | None — rolled into NETTING-cinch path |
| **Tether-brake cinch (delicate targets)** | [`CAPTURE_NET.md §2.4.1`](CAPTURE_NET.md) | Implemented inside the NETTING FSM (mode selection in [`CaptureNet.js`](js/entities/CaptureNet.js)) |
| **Bridle ring load-distribution** | [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md), implemented in [`BridleRing.js`](js/entities/BridleRing.js) | Gated by `FEATURE_FLAGS.BRIDLE_RING` (false) — see §4 |
| **Per-arm tether reel** | [`CAPTURE_NET.md §2.4`](CAPTURE_NET.md) phase 7 (reel-in), implemented in [`TetherReel.js`](js/systems/TetherReel.js) | Gated by `FEATURE_FLAGS.TETHER_REEL` (false) — see §4 |

---

## §3 Implementation Status Matrix

Column legend:
- **Init wired?** — is the system's `.init()` (or singleton constructor's listeners) actually called from [`main.js`](js/main.js)?
- **Update wired?** — is `.update(dt)` actually called each frame from [`main.js`](js/main.js)?
- **Inventory wired?** — for stateful retrieval methods (nets, fuel, reel cycles), is the per-instance inventory initialised?

| Method | ArmUnit state(s) | Input key(s) | System module | Init wired? | Update wired? | Inventory wired? | Feature flag (state) | Notes |
|---|---|---|---|---|---|---|---|---|
| **Capture Net** (active) | `NETTING` (via FSM) → `GRAPPLED` → `REELING` | `F` (SK only) | [`CaptureNet.js`](js/entities/CaptureNet.js) (`captureNetSystem` singleton) | ✅ [`main.js:323`](js/main.js:322) — fixed prior session | ✅ [`main.js:536`](js/main.js:536) — fixed prior session | ✅ `arm.initNetInventory()` at [`ArmManager.js:219`](js/entities/ArmManager.js:219) — fixed prior session | `CAPTURE_NET = true` ([`Constants.js:417`](js/core/Constants.js:417)) | **✅ Verified end-to-end functional** (follow-up debug fixed `_updateFlight` scene-position access + co-orbiting frame + `_firedNet` ref — see [HANDOFF §10.1 row 10](HANDOFF.md)). Console-confirmed: SK → NETTING → GRAPPLED → REELING. |
| **Fishing / ambush** | `FISHING` | None bound in `_onKeyDown`. Comms-menu emits [`ARM_FISH`](js/core/Events.js) | None — logic lives in [`ArmUnit._updateFishing`](js/entities/ArmUnit.js:3462), entered via [`ArmManager.deployFishing`](js/entities/ArmManager.js:437) | n/a (no dedicated module) | n/a (handled inside `ArmUnit.update`) | n/a | None | **Functional logic, no key.** ArmManager listens for `ARM_FISH` ([`ArmManager.js:242`](js/entities/ArmManager.js:242)); only a comms-menu item can fire it today. Auto-capture radius is `config.netSize × M × 0.5` — see §5 concern. |
| **Trawl sweep** | `TRAWLING` | `Shift+G` → `TRAWL_START` ([`InputManager.js:724`](js/systems/InputManager.js:724)) | [`TrawlManager.js`](js/systems/TrawlManager.js) (singleton) | ✅ self-managed via `GAME_STATE_CHANGE` listener ([`TrawlManager.js:54`](js/systems/TrawlManager.js:54)); auto-start on ORBITAL_VIEW | ✅ [`main.js:555`](js/main.js:555) | n/a | None | **Functional.** TrawlManager auto-picks `clusters[0]` (densest) — no player-choice gate (§4.8 backlog in HANDOFF). |
| **Web Shot (GSL)** | `WEB_SHOT` | **None bound in `_onKeyDown`** | None — logic in [`ArmUnit.fireWebShot`](js/entities/ArmUnit.js:953); dispatched via [`ArmManager.fireWebShot`](js/entities/ArmManager.js:504) | n/a | n/a (inside `ArmUnit.update`) | Fuel-only ([`WEB_SHOT_FUEL_COST = 3.0`](js/core/Constants.js:245)) | None | **Functional API but unreachable from keyboard.** No `case 'KeyB'` / `case 'KeyV'` / etc. handler emits the call. Either comms-radial wires it, or it is currently dormant — see §4 #C. |
| **Ablation (de-spin laser)** | `ABLATING` | **None bound** | None — logic in [`ArmUnit.startAblation`](js/entities/ArmUnit.js:1299) | n/a | n/a (inside `ArmUnit.update`) | n/a | `ABLATION_MODULE = false` ([`Constants.js:403`](js/core/Constants.js:403)) | **Flag-OFF + no key.** Even if flag flipped, no input path fires `startAblation`. ST-9.6 was explicitly cancelled per [`HANDOFF.md §Epic 10`](HANDOFF.md) ("ST-9.6 (ablation): Cancelled/skipped"). |
| **Scanning (arm sensor node)** | `SCANNING` | **None bound** (S-key fires mother-based `SCAN_QUICK`, not arm-based) | None — logic in [`ArmUnit.startScan`](js/entities/ArmUnit.js:1330); requires orchestration via ArmManager | n/a | n/a | n/a | None | **Functional method, no player trigger.** State exists, FSM is honoured, but no UI / key path invokes it. Likely orphaned V5 prep work. |
| **Tangled** | `TANGLED` | n/a (auto-entry on tangle-detect) | None — auto-resolves via `_updateTangled` | n/a | n/a | n/a | None | Intermediate failure state, not a player retrieval method. |
| **Deorbit sacrifice** | `DEORBITING` | `Ctrl+Shift+D` → `ARM_DEORBIT_CMD` ([`InputManager.js:778`](js/systems/InputManager.js:778)) | None | n/a | n/a (inside `ArmUnit.update`) | Fuel-only | None | **Functional.** Listener handler in [`ArmManager.js:258`](js/entities/ArmManager.js:258) picks the best candidate arm. |
| **Hauling (legacy)** | `HAULING` | n/a (auto-entry post-GRAPPLED in old code path) | None | n/a | n/a (inside `ArmUnit.update`) | n/a | None | **Functional but mostly orphaned in V5.** REELING is the V5 replacement; the few remaining paths into HAULING burn fuel for the tow. Audit if any GRAPPLED→HAULING transition still fires — initial inspection of `_updateNettingFSM` etc. suggests GRAPPLED→REELING is the dominant path now. |
| **Reeling (V5 zero-fuel)** | `REELING` | `R` during SK ([`InputManager.js:640`](js/systems/InputManager.js:640)) | Soft dependency on [`TetherReel.js`](js/systems/TetherReel.js) for cable-physics state machine | ❌ TetherReel **not** init'd in main.js — see §4 #A | ❌ TetherReel **not** update'd in main.js — see §4 #A | n/a | `TETHER_REEL = false` ([`Constants.js:420`](js/core/Constants.js:420)) | **State logic functional via ArmUnit; reel cable-physics layer is dead.** `_updateReeling` uses simple position lerp; it does not consult `TetherReel.getReelRecord(i)`. When `TETHER_REEL` flag flips ON, the system will not work because of the wiring gap. **✅ 2026-06-06 (`b7d5fae`):** captured-debris positioning during REELING is now welded to the daughter via the authoritative [`pinCapturedDebris`](js/entities/DebrisField.js:1) path (fixes the reel-in disappearance — see §1 resolution note). |
| **Returning (FEEP)** | `RETURNING` | `ESC` during SK ([`InputManager.js:541`](js/systems/InputManager.js:541)) | None | n/a | n/a | n/a | None | **Functional.** `_updateReturning` ([`ArmUnit.js:3365`](js/entities/ArmUnit.js:3365)) handles detached vs tethered branches. |
| **BridleRing load-distribution** | n/a (not a state — metadata layer on top of strut tip) | n/a | [`BridleRing.js`](js/entities/BridleRing.js) (module-level singletons via `_rings` Map) | ❌ **No init wiring** — module-level `_rings` Map is empty; nothing calls `create(armIndex)` in main.js | ❌ no `update()` exported / called | n/a | `BRIDLE_RING = false` ([`Constants.js:423`](js/core/Constants.js:423)) | **Dead.** Even when the flag is turned on, no consumer calls `create()` per arm. Methods are pure-functional but every getter will return defaults. See §4 #B. |

---

## §4 Confirmed Wiring Gaps

These are the **exact same pattern** as the CAPTURE_NET gap fixed this session: the file exists, the class/API is complete, but `main.js` neither initialises it nor ticks it. Tests pass because they exercise the modules directly; the bug is browser-only.

### §4.A TetherReel — fully orphaned

**Module:** [`TetherReel.js`](js/systems/TetherReel.js) (583 LOC, exports `tetherReelSystem` singleton class with `.init()` and `.update()`).

**Feature flag:** [`FEATURE_FLAGS.TETHER_REEL`](js/core/Constants.js:420) — `false`.

**Evidence:**
- `grep` for `tetherReel` / `TetherReel` in [`js/main.js`](js/main.js) returned **0 results**. The module is not even imported. ([`main.js`](js/main.js:1) imports `launchSequence`, `trawlManager`, etc. — but not the reel system.)
- [`TetherReel.init(armManager, tierName)`](js/systems/TetherReel.js:85) is referenced only in the test suite [`test-TetherReel.js`](js/test/test-TetherReel.js).
- [`HANDOFF.md`](HANDOFF.md) Epic 10 V-8 section mentions "[`tetherReel.getReelRecord(i)`](js/systems/TetherReel.js) — cable length/state (drives tether visual)" — implying that visualisation reads from it, but the system was never wired so all reads will see an empty Map.

**Consequence:** Even if `TETHER_REEL` flag is flipped to `true` in [`Constants.js:420`](js/core/Constants.js:420), `tetherReelSystem._reels` is empty (no records were created), all `getReelRecord(i)` calls return `null`, and the `update(dt)` time-step that would have driven `PAYING_OUT → STATIC` transitions never runs. The full 6-state reel machine (`STOWED → PAYING_OUT → STATIC ↔ REELING_IN`, plus `JAMMED` / `CUT`) is dormant.

**Where ArmUnit reels today:** [`_updateReeling`](js/entities/ArmUnit.js:3306) uses a direct position lerp toward `parentPos`. It does NOT consult `TetherReel`. So the V5 zero-fuel return still works — but with no cable-physics, no JAMMED state, no MAX cable length enforcement from the reel layer, and no `tensionWarnTimer` debounce.

### §4.B BridleRing — module-level singleton, never `create()`d

**Module:** [`BridleRing.js`](js/entities/BridleRing.js) (359 LOC, exports `create`, `attach`, `detach`, `getStatus`, `computeLoadBalance`).

**Feature flag:** [`FEATURE_FLAGS.BRIDLE_RING`](js/core/Constants.js:423) — `false`.

**Evidence:**
- `grep` for `bridleRing` / `BridleRing` in [`js/main.js`](js/main.js) returned **0 results**. Not imported.
- The module's `_rings` Map ([`BridleRing.js:28`](js/entities/BridleRing.js:28)) is empty. `create(armIndex)` is referenced only in tests ([`test-BridleRing.js`](js/test/test-BridleRing.js)).
- [`ArmManager._initArms()`](js/entities/ArmManager.js:202) never calls `BridleRing.create(arm.index)` after constructing each arm. (Compare to the `arm.initNetInventory();` we added this session — same pattern would be needed here when `BRIDLE_RING` is flipped on.)

**Consequence:** When the flag is enabled, every `getStatus(armIndex)` will return `undefined` and `attach()` will return `false`. Net deployment paths that try to mark a strut-tip attach point as occupied will silently fail.

### §4.C Web Shot — fireable from API, but no keyboard binding

**Function:** [`ArmUnit.fireWebShot(target)`](js/entities/ArmUnit.js:953) (Sprint D1 — "fire and forget" drag-multiplier web).

**Evidence:**
- [`InputManager.js _onKeyDown`](js/systems/InputManager.js) has **no** `case 'KeyB'` / `'KeyN'` / `'KeyV'` / etc. that emits a `WEB_SHOT_*` event or calls `armManager.fireWebShot(...)`.
- `grep` of `fireWebShot|WEB_SHOT|fireWebShot` in [`InputManager.js`](js/systems/InputManager.js) returned only the FSM-state filter at [`InputManager.js:686`](js/systems/InputManager.js:686) (allowing ARM_PILOT entry from `S.FISHING`). No invocation.
- The function is exposed via [`ArmManager.fireWebShot(target, preferType)`](js/entities/ArmManager.js:504); could be triggered from the comms radial or a HUD action, but I found no such caller in a quick `grep` (search for `armManager.fireWebShot|fireWebShot(` shows hits only in the class definition itself and the test suite).

**Consequence:** Web Shot is a Sprint D1 capability that no player can fire today. It is silent dead code from a UX perspective.

### §4.D Ablation — explicitly cancelled, but logic still present

**Function:** [`ArmUnit.startAblation(target)`](js/entities/ArmUnit.js:1299) and [`_updateAblating`](js/entities/ArmUnit.js:3725) / [`_endAblation`](js/entities/ArmUnit.js:3762).

**Feature flag:** [`FEATURE_FLAGS.ABLATION_MODULE`](js/core/Constants.js:403) — `false`.

**Evidence:**
- No key binding in [`InputManager.js _onKeyDown`](js/systems/InputManager.js) calls `startAblation`. `grep` confirms zero hits.
- [`HANDOFF.md Epic 10 status header`](HANDOFF.md:36): "ST-9.6 (ablation): Cancelled/skipped."

**Consequence:** Dead by design. Code present for possible future reactivation. Worth removing the `ABLATING` case from [`update() switch`](js/entities/ArmUnit.js:1908) if confirmed permanently dropped — but DO NOT delete the method bodies without explicit user approval (see §7 Q3).

### §4.E Arm-based scanning — no player trigger

**Function:** [`ArmUnit.startScan()`](js/entities/ArmUnit.js:1330) — distributed sensor pulse node.

**Evidence:**
- The S-key in [`InputManager.js:816`](js/systems/InputManager.js:816) emits mother-based `SCAN_QUICK`, which is consumed by [`SensorSystem`](js/systems/SensorSystem.js) — not by ArmUnit.
- Nothing in the codebase (outside tests) calls `arm.startScan()`.

**Consequence:** The `SCANNING` state in the FSM is unreachable in production. Either the design intends ArmManager to orchestrate it on a future Wide Scan path, or it is orphaned. See §7 Q2.

---

## §5 Suspected Functional Gaps

These are paths that look wired but have logic concerns that could strand the arm or behave incorrectly. **Marked SUSPECTED — needs runtime verification.**

### §5.A FISHING auto-capture radius may be too small

Per [`_updateFishing`](js/entities/ArmUnit.js:3481):

```js
const captureRadius = this.config.netSize * M * 0.5; // half net size as capture radius
```

For a Spinner (Small Net, `D_mesh = 1.5 m` per [`CAPTURE_NET.md §2.1`](CAPTURE_NET.md)), `captureRadius = 0.75 m × M = 7.5×10⁻⁶ scene units` ≈ a target must pass within **0.75 m** of the hibernating arm before the proximity check triggers. With debris at orbital relative-velocity (often 0.05–5 m/s relative), the **time-window for the per-frame distance check is one or two frames**. At a typical 60 fps, that is 16–33 ms — entirely plausible to miss between frames.

**Mitigation candidates:**
- Use a swept-volume check (`prevPos → curPos`) instead of point-distance.
- Use `(captureRadius + relVel*dt)` as the effective capture distance.
- Increase `captureRadius` to `netSize × M × 1.0` (full net diameter) for FISHING.

Cite: [`ArmUnit.js:3481`](js/entities/ArmUnit.js:3481).

### §5.B HAULING redirects detached arms to DEORBITING

Per [`_updateHauling`](js/entities/ArmUnit.js:3270):

```js
if (this.isDetached) {
  this._transitionTo(S.DEORBITING);
  eventBus.emit(Events.COMMS_MESSAGE, {
    text: `${this.id}: No tether — committing to deorbit burn. Sacrificial play.`,
    priority: 'warning',
  });
  return;
}
```

This is **intended** per the salvage state chain (§1.2 #6), but two concerns:
1. If REELING is the new V5 path and HAULING is mostly orphaned, why is the detached-redirect-to-DEORBITING logic still inside `_updateHauling`? Should it be inside `_updateReeling` as well? Today, `_updateReeling` does NOT check `isDetached` — see [`ArmUnit.js:3306`](js/entities/ArmUnit.js:3306). A detached daughter that somehow enters REELING would attempt to fly to mother via tether logic with no tether → indeterminate behaviour.
2. Worth confirming: under what condition does an arm enter HAULING in the V5 code path? If the answer is "never", the method is dead code (parallel to the legacy NETTING 85%-dice-roll path).

Cite: [`ArmUnit.js:3268`](js/entities/ArmUnit.js:3268) (HAULING), [`ArmUnit.js:3306`](js/entities/ArmUnit.js:3306) (REELING, no detach guard).

### §5.C `_endAblation` returns to TRANSIT with no target

Per [`_endAblation`](js/entities/ArmUnit.js:3762):

```js
this.ablationTimer = 0;
this.ablationTarget = null;
this._transitionTo(S.TRANSIT); // Return to transit to come back
```

The arm transitions to `TRANSIT` but `this.target` may still be set (or stale). [`_updateTransit`](js/entities/ArmUnit.js:2351) drives toward `this.target._scenePosition`; if that debris was the ablation target and is still alive, fine. If the target was destroyed mid-ablation, behaviour depends on `_updateTransit`'s null-target handling.

Cite: [`ArmUnit.js:3769`](js/entities/ArmUnit.js:3769). Low priority because ABLATION_MODULE is OFF.

### §5.D TRAWLING auto-end forces tether-bound arms into REELING with no payload

Per [`_updateTrawling`](js/entities/ArmUnit.js:3516):

```js
if (this._trawlTimer >= maxDuration) {
  this._trawlingMode = false;
  eventBus.emit(Events.TRAWL_END, { armId: this.id });
  if (this.isDetached) { /* go TRANSIT */ }
  else { this._transitionTo(S.REELING); }
}
```

REELING with no `capturedDebris` is valid — `_updateReeling` checks `hasPayload` ([`ArmUnit.js:3307`](js/entities/ArmUnit.js:3307)) and uses `REEL_IN_SPEED_EMPTY` — but then on reach-mother the arm goes to DOCKING. **Functionally correct**, but worth confirming the audio/visual cues do not promise "salvage returning" when the trawl was empty.

Cite: [`ArmUnit.js:3531`](js/entities/ArmUnit.js:3531).

### §5.E FISHING fallback dock-direction may not be world-aligned

Per [`_updateFishing`](js/entities/ArmUnit.js:3473):

```js
const dir = this._fishingDir || this._worldDockDirection(this._lastParentQuat);
```

If `_fishingDir` is null and `_lastParentQuat` is stale (e.g. fishing entered before any parent-quat update), the dock direction may be wrong. The §4.6 arm-deployment-direction bug from [`HANDOFF.md`](HANDOFF.md) was the 180° version of exactly this. Worth a runtime check that fishing arms extend in the intended direction.

Cite: [`ArmUnit.js:3473`](js/entities/ArmUnit.js:3473).

### §5.F Trawl-capture mass cap is hardcoded

Per [`_updateTrawling`](js/entities/ArmUnit.js:3602):

```js
const maxCaptureMass = (Constants.TRAWLING && Constants.TRAWLING.AUTO_CAPTURE_MASS_MAX) || 50;
```

A debris with `mass > 50 kg` floating right through the trawl is silently skipped ([`ArmUnit.js:3616`](js/entities/ArmUnit.js:3616) `if (debris.mass > maxCaptureMass) continue;`). For new players this could feel like a phantom miss — "I drove right through it and nothing happened." Worth a comms ping ("Target too massive for trawl — use net") on near-miss-by-mass.

Cite: [`ArmUnit.js:3602`](js/entities/ArmUnit.js:3602), [`Constants.TRAWLING.AUTO_CAPTURE_MASS_MAX`](js/core/Constants.js:973).

---

## §6 Recommended Fix Order

Smallest blast radius first. Each item is one surgical change targeting a single file (or a paired file + constant) so it can be tested in isolation. Mirrors the Sprint A → B → C tier convention from [`HANDOFF.md §5`](HANDOFF.md).

### Tier 0 — Decision items (no code; ask user first)

- **§7 open questions** below. Resolving them tells us whether Web Shot / Ablation / Scanning should be wired up, removed, or left dormant.

### Tier A — Quick wins (1–2 hours each)

1. **Wire a key binding for Web Shot** (only if §7 Q1 says "keep"). Add e.g. `case 'KeyV'` (or via existing comms radial) to [`InputManager.js _onKeyDown`](js/systems/InputManager.js) that calls `d.armManager.fireWebShot(target, 'spinner')` when there's an active target and a docked/fishing arm with cooldown=0. Surgical: ~15 LOC.
2. **Add `_updateReeling` detached-arm guard.** Mirror the `if (this.isDetached) { ... DEORBITING; return; }` block from `_updateHauling`. If a detached arm somehow reaches REELING, redirect to DEORBITING. Surgical: ~6 LOC in [`ArmUnit.js _updateReeling`](js/entities/ArmUnit.js:3306).
3. **Widen FISHING auto-capture radius.** Change `netSize * M * 0.5` → `netSize * M * 1.0` AND add a swept-volume check (`prevPos → curPos`). Surgical: ~10 LOC in [`ArmUnit.js _updateFishing`](js/entities/ArmUnit.js:3481).
4. **Comms ping on trawl-mass-too-big.** In [`_updateTrawling`](js/entities/ArmUnit.js:3616) emit a one-shot `COMMS_MESSAGE` per debris ID when `debris.mass > maxCaptureMass` AND `dist < captureRadius`. Surgical: ~8 LOC.

### Tier B — Wiring gaps (2–4 hours each — mirrors this session's CAPTURE_NET pattern)

5. **Wire TetherReel into main.js.** When `FEATURE_FLAGS.TETHER_REEL === true`:
   - `import { tetherReelSystem } from './systems/TetherReel.js';` at top of [`main.js`](js/main.js:1).
   - After `armManager = new ArmManager(scene);` (around [`main.js:212`](js/main.js:212)), call `tetherReelSystem.init(armManager, currentTierName);`.
   - In the game-loop block (around [`main.js:524`](js/main.js:524)), after `armManager.update(dt);`, call `tetherReelSystem.update(dt);`.
   - Visual layer [`ArmUnit.js`](js/entities/ArmUnit.js) tether-render already reads `tetherReel.getReelRecord(i)` per [`HANDOFF.md`](HANDOFF.md) — verify those getters return non-null after wiring.
6. **Wire BridleRing into ArmManager._initArms().** Inside the for-loop at [`ArmManager.js:207`](js/entities/ArmManager.js:207), after `arm.initNetInventory();`, add: `if (Constants.FEATURE_FLAGS.BRIDLE_RING) { BridleRing.create(arm.index); }`. Import the module at the top of [`ArmManager.js`](js/entities/ArmManager.js). Mirrors the exact wiring pattern used for `initNetInventory` this session.

### Tier C — Hygiene (verify before deletion)

7. **Confirm HAULING is dead code path-by-path.** Run a coverage scan: search for `_transitionTo(S.HAULING)` everywhere. If GRAPPLED→HAULING is no longer fired by any path in V5, mark `_updateHauling` `@deprecated` (NOT delete — keep for back-compat reading). One commit, ~5 LOC of comments.
8. **Remove ABLATING from the FSM switch** (only after §7 Q3 confirms it's permanently cancelled). Branch deletion guarded by `// ST-9.6 cancelled` comment. ~3 LOC in [`ArmUnit.js`](js/entities/ArmUnit.js:1908).

### Tier D — Tests for prevented regressions

9. **Add a "wiring smoke test" runner.** New file `js/test/test-main-wiring.js` (Node-only mock of `main.js` boot sequence) that asserts: for every system imported in `main.js`, either `system.init` was called OR `system.update` was called at least once during a 1-frame simulated loop. This is the test that would have caught the original CAPTURE_NET wiring gap.

---

## §7 Open Questions for User

These design decisions cannot be resolved from the codebase alone. Answers will determine which Tier-A and Tier-B items move forward.

### Q1 — Web Shot: ship, hide, or remove?

[`ArmUnit.fireWebShot`](js/entities/ArmUnit.js:953) is a complete Sprint D1 capability (drag-multiplying web that increases debris atmospheric decay), but there is **no key binding** and **no comms-radial caller** that fires it. Three options:

- **A.** Wire it to a key (suggest `V` or a comms-radial entry). 1–2 h.
- **B.** Leave it dormant as future-tech. 0 h. But: dead-code smell.
- **C.** Delete `fireWebShot` + `_updateWebShot` + `WEB_SHOT` state + `WEB_SHOT_*` constants. 2–3 h plus test updates.

### Q2 — Arm-based SCANNING: who triggers it?

[`ArmUnit.startScan()`](js/entities/ArmUnit.js:1330) exists, [`_updateScanning`](js/entities/ArmUnit.js:3778) ticks the timer, and the `SCANNING` ARM_STATE is wired into the switch. But the only player-facing scan key (`S`) fires the mother-based `SCAN_QUICK`. Should the arm-based variant be:

- **A.** Bound to a key (e.g. `Shift+S` = orchestrated Wide Scan that puts all docked arms into SCANNING for a sensor-pulse)?
- **B.** Removed?
- **C.** Reserved for a future Mission-Operations §4.8 feature (Field Assay MFD) and left dormant?

### Q3 — Ablation Module: permanently cancelled, or paused?

[`HANDOFF.md`](HANDOFF.md) Epic 10 status reads "ST-9.6 (ablation): Cancelled/skipped." But the code is intact: `startAblation`, `_updateAblating`, `_endAblation`, `ABLATION_*` constants, `ABLATION_MODULE` flag. Two options:

- **A.** Cancelled = permanently dropped. Delete the FSM case + methods + constants. ~2 h.
- **B.** Paused = re-enable in a future epic. Leave intact; add a `@deprecated` JSDoc tag.

### Q4 — Should HAULING (legacy fuel-burning tow) be removed?

GRAPPLED → REELING is the V5 path. GRAPPLED → HAULING was the V3/V4 path. Worth confirming with the user that NO V5 code path still enters HAULING. If confirmed, mark `_updateHauling` as legacy-only and remove the switch case in a future cleanup. Today the switch case still runs if anything calls `_transitionTo(S.HAULING)` — a `grep` shows two such call sites still in [`ArmUnit.js`](js/entities/ArmUnit.js) (need detailed re-audit).

### Q5 — Should auto-FISHING be exposed to a key?

Today, FISHING is reachable only via the comms-menu `ARM_FISH` event. There is no `case 'KeyJ'` (or whatever) in `_onKeyDown` for "deploy all spinners as fish". Was the intent that fishing is a comms-tactical decision (cinematic feel), or that it should be a hotkey? If the latter, suggest `Shift+H` (mirror of `H = recall all`).

### Q6 — Is the BridleRing intended to be a V5 baseline?

`FEATURE_FLAGS.BRIDLE_RING` is `false`. The module is 359 LOC and fully tested. Is the plan to:

- **A.** Enable on Y0 (default) and wire it in this session?
- **B.** Gate behind Y1+ tier upgrade?
- **C.** Defer indefinitely?

The answer changes whether §6 Tier-B #6 is shippable immediately or needs to wait for a tier-rebalance epic.

### Q7 — Should the wiring-smoke-test (§6 #9) be mandatory?

This test would have caught the CAPTURE_NET regression at HEAD~1. Cost: a small mock of `main.js` and one new test file (~150 LOC). Worth the diligence, or premature scaffolding?

---

*End of audit.*

> **Maintenance note:** when any of the above gaps is closed, update the **§3 status matrix** in this document. The matrix is the single source of truth for "is daughter retrieval method X wired?".
