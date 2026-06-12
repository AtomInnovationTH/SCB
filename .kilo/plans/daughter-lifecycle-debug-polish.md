# Daughter Lifecycle Debug & Polish — D-launch → ceremony → autopilot → station-keep → tool use → net → recall → re-dock

Analysis + fix plan for the 13 reported issues. Verified against code 2026-06-12.
Test baseline before starting: `node js/test/run-tests.js` (≈694 suites / 2823 tests / 0 fail).
SSOT rules apply: HANDOFF §9 (THREE conventions), §10 (capture lifecycle rules A–I). Update `ARCHITECTURE.md` §6 hotkey table + drift register in the same shift.

---

## 1. "Woosh" plays before the daughter actually leaves the strut

**Root cause (confirmed).** `AudioSystem` plays `playArmDeploy()` on `ARM_DEPLOYED` ([AudioSystem.js:195](js/systems/AudioSystem.js:195)). But `ARM_DEPLOYED` is emitted in `deploy()` at the *moment the LAUNCHING state is entered* ([ArmUnit.js:871](js/entities/ArmUnit.js:871)) — i.e. at the start of the magnetic-clamp-release hold. The spring (actual departure) fires **1.5 s later** at `CROSSBOW_UNDOCK_TIME` inside `_updateLaunching` ([ArmUnit.js:2481-2484](js/entities/ArmUnit.js:2481)). So the woosh leads departure by 1.5 s, worse under launch-ceremony time dilation.

**Fix.**
- Add `Events.ARM_SPRING_FIRED` (Events.js) and emit it in `_updateLaunching` exactly where `_springFired = true` + `_applyLaunchImpulse()` runs (both the V5 path at :2483 and the legacy path at :2442 if reachable). Payload: `{ armId, type, speed }`.
- AudioSystem: move the deploy woosh (and any "daughter laugh" voice cue) from `ARM_DEPLOYED` → `ARM_SPRING_FIRED`. Keep `ARM_DEPLOYED` wiring for HUD/skills/teaching untouched (they key off intent, not departure).
- Optional polish: play a quieter "clamp release" click on `ARM_DEPLOYED` so the 1.5 s wind-up reads as deliberate.

**Tests.** Extend `test-Crossbow-ArmUnit.js`: stepping past `CROSSBOW_UNDOCK_TIME` emits `ARM_SPRING_FIRED` exactly once; not emitted during clamp phase.

---

## 2. Net fired from STATION_KEEP drifts instead of going straight at debris

**Root cause (high confidence).** The net is propagated **in the arm's co-orbiting frame** — every flight frame `net.position = arm.position + launchDir × distanceTraveled` ([CaptureNet.js:503-507](js/entities/CaptureNet.js:503)). Therefore the correct lead velocity is *target velocity relative to the arm*. But `_leadTargetVel` is the **raw per-frame delta of `target._scenePosition`** ([ArmUnit.js:2072-2091](js/entities/ArmUnit.js:2072)) — absolute scene velocity, not arm-relative. In SK the daughter is deliberately co-moving with the debris (velocity initialized to the EMA drift, [ArmUnit.js:2860](js/entities/ArmUnit.js:2860)), so true relVel ≈ 0 and the shot should go **dead straight** — instead `computeLeadAim` ([CaptureNet.js:159](js/entities/CaptureNet.js:159)) offsets the aim by shared orbital drift the net does not actually experience. The comment at :2071 ("raw delta is the relative velocity we want") is wrong for a net anchored to the arm frame.

**Fix.**
- In the per-frame lead estimator (:2072), also record the arm's own per-frame position delta and store `_leadTargetVel = (targetDelta − armDelta) / dt` (scene-units/s). Equivalently subtract `this.velocity` plus the parent-frame correction; using position deltas for both sides is the most robust (same sampling).
- Fix the stale "metres/s" comment — everything is scene units (`_scenePosition` and `arm.position` are both scene-space; `launchSpeedScene = LAUNCH_SPEED × M` already matches).
- `DockingReticle._drawNetPreFireReadout` already calls the same `computeLeadAim` with the same `_leadTargetVel` ([DockingReticle.js:929-932](js/ui/DockingReticle.js:929)) — SSOT preserved automatically; the OFF-AXIS advisory will now correctly read ~0° in a settled SK.
- Instrument first (one debug session, `?debug`): log `|_leadTargetVel|`, off-axis deg at fire time from SK — confirm the pre-fix magnitude and the post-fix ≈0 result.

**Acceptance.** From a settled SK hold, `offAxisDeg < 2°` and the net flies visually straight at the debris; long manual TRANSIT shots still lead moving targets (relative velocity genuinely nonzero there).

**Tests.** New node test: mock arm + target both translating with identical frame drift → lead dir ≈ direct bearing; target with genuine transverse relVel → lead offsets in the transverse direction only.

---

## 3. Net weights / diameter / spin RPM — physics audit, and "where does the torque go"

**Current state (verified).** `Constants.CAPTURE_NET` classes ([Constants.js:1546-1630](js/core/Constants.js:1546)): LARGE 8 m @ 2 Hz, MEDIUM 5 m @ 4 Hz, SMALL 1.5 m @ 6 Hz, with a rim-weight centripetal tension table in comments (F/wt = m·ω²·r). Yo-yo despin is modeled: canister starts at `SPIN_HZ × SPIN_FOLDED_MULT(3.0)` and settles to class `SPIN_HZ` as the mouth blossoms (L = Iω, I ∝ r²) ([CaptureNet.js:464-478](js/entities/CaptureNet.js:464)); in-flight decay `SPIN_DECAY_PER_S = 0.08` feeds the live `f_spin` cling factor ([CaptureNet.js:487-493](js/entities/CaptureNet.js:487)).

**Work items.**
1. **Verify the numbers**: re-derive the rim table (e.g. MEDIUM: ω = 2π·4 = 25.1 rad/s, r = 2.5 m → F/wt = m·ω²·r). Confirm mouth-open tension >10 N per weight at settled SPIN_HZ for all three classes; adjust `RIM_WT_MASS`/`SPIN_HZ` if any class falls below. Express the answer in RPM in the comment (2 Hz = 120 RPM, 4 Hz = 240 RPM, 6 Hz = 360 RPM) since the design question is asked in RPM.
2. **Torque accounting (the physics answer, surfaced to the player):** the launcher spins the canister; angular momentum rides with the net; despin happens by **radius growth, not external torque** (yo-yo effect); the equal-and-opposite reaction torque goes into the daughter's reaction wheel/body at launch. Add a short Codex entry ("Net spin & the yo-yo despin") + one comms SCI line on first net launch. No new mechanics — document and teach what's already simulated.
3. **Visual check:** confirm `CaptureNetVisual` rotates the bag at `net.spinRate` so the on-screen RPM matches constants (fix if it uses a hardcoded rate).

**Tests.** Constants-derivation test asserting F/wt ≥ 10 N at settled spin for each class (guards future SPIN_HZ retunes).

---

## 4. Pre-shot guidance: detumble needed / too massive / too wide

**Current state.**
- Detumble: SK pre-fire readout shows `P-CLING %` + "tumbling — de-spin [U]" ([DockingReticle.js:941-945](js/ui/DockingReticle.js:941)); CP-2 `DESPIN_IN_SPEC` comms exists. ✅
- Too massive: `deploy()` refuses targets over `maxCaptureMass` with a comms line ([ArmUnit.js:828](js/entities/ArmUnit.js:828)); ToolRecommender demotes NET on mass-oversize ([ToolRecommender.js:60,78](js/systems/ToolRecommender.js:60)). ✅ (mostly)
- **Too wide: only discovered AFTER the catch** — `_checkNetIntegrityOnReel` hard-fails `sizeMeter > netDiameter` at GRAPPLED→REELING ([ArmUnit.js:4083](js/entities/ArmUnit.js:4083)), wasting a net + the player's time. ❌ No pre-fire width warning anywhere.

**Fix.**
- Add a **width fork** to `ToolRecommender`: pass `sizeMeter`; when `sizeMeter > netClass.DIAMETER`, score NET 0/hint "too wide for net mouth" and let GRIPPER win (it already triggers on `netOversize` mass; extend to width).
- Add a width advisory to `_drawNetPreFireReadout` ahead of the tumble advisory: `'too wide — use GRIPPER [\`]'` (red).
- Add a compact capture-fit badge to the **TargetPanel** expanded row: `NET ✓ / TOO WIDE / TOO HEAVY / DE-SPIN FIRST` derived from the same pure helpers (single source: a small `assessNetFit(target, netClass)` exported from CaptureNet.js, reused by reticle + panel + recommender).
- Keep the post-hoc reel-time failure as the consequence path; the guidance now exists *before* the player commits.

**Tests.** Unit tests for `assessNetFit` + ToolRecommender width fork.

---

## 5 & 6. Early-mission stuck-state audit (learning missions must never dead-end)

Walk the full beginner loop (D → ceremony → autopilot → SK → F/N → R) and close every dead end. Known traps found in code review, each with the fix:

| # | Trap | Today | Fix |
|---|---|---|---|
| a | Deploy refused (spring not charged / no fuel / >500 m / too massive) | comms warning only ([ArmUnit.js:812-858](js/entities/ArmUnit.js:812)) | fine — but route through `canFireHint` so the *next action* ("press A first") also lands as a HintTicker entry, not just a scrolling comms line |
| b | `fireDaughterNet` returns null (cooldown/inventory) → silent fall back to SK ([ArmUnit.js:3845-3851](js/entities/ArmUnit.js:3845)) | no player-facing reason | emit comms + reticle line with the actual reason (cooldown s remaining / magazine empty) |
| c | U advisory while piloting: SK readout says "de-spin [U]" but `KeyU` is gated `!this.armPilotMode` ([InputManager.js:687-688](js/systems/InputManager.js:687)) and the held-poll likewise ([InputManager.js:1662](js/systems/InputManager.js:1662)) | **advisory tells player to press a dead key** | allow U (hold) in ARM_PILOT when the piloted arm has an SK target — drive the same mother `DespinLaser` at `targetSelector`/SK target; or if mother lacks line-of-sight context, change the advisory to "exit pilot (P), hold U" — prefer the former |
| d | Daughter EXPENDED / tether snap in mission 1 | exists, harsh | guard: while `missionNumber === 1`, clamp tether-snap to a warning (no snap) and keep `DETACH_MAX_DISTANCE` kill messaging explicit — verify `NavRecoveryAdvisor`/`ArmIdleAdvisor` cover "all daughters out + nothing targeted" |
| e | All daughters HOLDING_CATCH simultaneously | staged furnace breakdown auto-drains (FT timeline) — verify FEED_S end-to-end with 4 parked catches; no deploy pool starvation beyond the window | test only |
| f | Player in ARM_PILOT, target dies mid-flight | handled (Issue-B guards :3906-3932) | test only |
| g | Esc/R from SK | handled (`recallFromStationKeep`/`reelFromStationKeep`) | keep, document in overlay |

Deliverable: a `test-EarlyMission-StuckStates.js` suite that scripts each row's event sequence and asserts a recoverable state + at least one guidance emission. This is the "learning to think in space" guarantee: every refusal names the next verb.

---

## 7. Hotkey cleanup — R / Shift+R recall scheme (per decision: **Shift+R only**)

**Changes in `InputManager.js`:**
- `KeyR` (no shift): keep the context behavior — ARM_PILOT+SK → reel; autopilot engaged → abort; else recall **closest** deployed daughter (this *is* "recall current": piloted arm wins, else nearest).
- `KeyR` + shift: **new** → emit `Events.ARM_RECALL_ALL`.
- `KeyH`: **remove** binding (free the key; leave a `// reserved` marker like KeyK).
- `KeyO`: keep O = deploy-all; **remove Shift+O** recall-all branch.
- Mind ordering: shift check must come before the R context chain; `e.preventDefault()` both.

**Ripple updates (all must land same shift):**
- `HotkeyOverlay.js` rows (R / Shift+R; delete H, Shift+O recall rows).
- `ARCHITECTURE.md` §6 table + drift register entry.
- Skills/teaching defs that mention H or Shift+O for recall (grep `'H'`, `recall` in Constants SKILLS defs, OnboardingDirector beats, TeachingSystem moments, Codex entries) — repoint text to R/Shift+R; the underlying `ARM_RECALL_ALL` event is unchanged so triggers keep working.
- README/HANDOFF mentions if any.

**Tests.** Input-routing test: Shift+R emits `ARM_RECALL_ALL`; H emits nothing; Shift+O emits nothing.

---

## 8. Re-dock bug: daughter vanishes ~2 s, tether points 180° the wrong way, then she pops onto the strut

**Root-cause analysis (two compounding defects):**

1. **Empty-handed returns target the mother CORE, not the strut tip.** `_updateReturning` flies to `parentPos` (bus centre) and enters DOCKING when within `bodyDims×8` of the **core** ([ArmUnit.js:4304-4316](js/entities/ArmUnit.js:4304)). The daughter flies *into/behind the mother hull* (= "disappears", occluded), while the tether — anchored at the **strut tip** ([ArmUnit.js:5082-5085](js/entities/ArmUnit.js:5082)) — draws from the strut tip *inward through the ship* to her position: visually a tether extending 180° opposite the strut. `_updateDocking` then lerps her back out to the strut tip over `ARM_DOCK_DURATION = 3.0 s` ([Constants.js:400](js/core/Constants.js:400)) → "reappears on strut later". This is the exact symptom; note REELING already got this fix in 2026-05-26 ("Issue 1", [ArmUnit.js:4196-4203](js/entities/ArmUnit.js:4196)) but **RETURNING never did**.
2. **One-frame-stale tether counter-rotation during DOCKING.** `_updateTether` bakes `tetherLine.quaternion = group.quaternion⁻¹` ([ArmUnit.js:5188](js/entities/ArmUnit.js:5188)) during `armManager.update()`, but `PlayerSatellite.postArmUpdate` slerps `group.quaternion` toward the strut basis *afterwards* ([PlayerSatellite.js:3615-3618](js/entities/PlayerSatellite.js:3615)) — the rendered tether is rotated by that frame's slerp delta (worst at DOCKING entry when the pose error can approach 180°).

**Fix.**
- Mirror the REELING fix into `_updateReturning`: steer toward `dockOffset`-derived strut-tip world position (same `_tmpDockTarget` math as [ArmUnit.js:4214-4219](js/entities/ArmUnit.js:4214)); dock-threshold measured against that point. The daughter then approaches her own strut from outside — never enters the hull, tether stays outboard.
- Stale-quat: in `postArmUpdate`, after slerping `arm.group.quaternion` for DOCKING/LAUNCHING/HOLDING_CATCH, re-set `arm.tetherLine.quaternion.copy(arm.group.quaternion).invert()` when the tether is visible (cheap, keeps single-owner rule). 
- Instrument before/after with `?debug`: log state timeline + mesh.visible + tether endpoints during an R-recall to confirm both defects and their resolution.

**Tests.** `_updateReturning` converges to strut-tip world pos (not parentPos) with a rotated parentQuat; DOCKING transition fires within threshold-of-strut-tip; existing `test-ArmUnit-tether.js` extended: after a simulated postArmUpdate quat change, tether world-space endpoints still span anchor→arm.

---

## 9. What does U do now — and what should it do

**Now:** hold-U = mother-mounted de-spin laser (CP-2, `LASER_DESPIN` ON) on the Tab-locked target; keydown without target → warning ([InputManager.js:687-699](js/systems/InputManager.js:687), held-poll :1662, [DespinLaser.js](js/systems/DespinLaser.js)). Bleeds `tumbleRate`, cyan beam, `DESPIN_IN_SPEC` comms; couples into net cling via `computeTumbleModifier`. Blocked in ARM_PILOT.

**Should (keep + fix the gap):**
- Keep as the despin verb — it's load-bearing for the detumble→net teaching loop.
- Fix item 5c: usable while piloting in SK (the advisory promises it).
- Add visible progress: TargetReticle already shows `_despinning` label ([TargetReticle.js:927](js/ui/TargetReticle.js:927)) — add °/s countdown to the SK readout line so holding U shows live convergence toward `IN_SPEC_DEG`.
- Document in HotkeyOverlay (already listed :85) + Codex unlockHint.

---

## 10. Bottom-edge daughter hints cleanup (e.g. obsolete "SPACE to launch net")

**Confirmed obsolete:** `DockingReticle._drawNetStatus` renders `'● NET READY — [SPACE] Deploy'` ([DockingReticle.js:643](js/ui/DockingReticle.js:643)). Space in ARM_PILOT only works via `manualNetDeploy()` in TRANSIT/APPROACH and **does nothing in STATION_KEEP** ([InputManager.js:1201-1218](js/systems/InputManager.js:1201)) — in SK the real verbs are **F** (dispatch selected tool) and **N** (net) ([InputManager.js:966-1014](js/systems/InputManager.js:966)).

**Fix — make `_drawNetStatus` state-aware (single hint line, no stacking):**
- `STATION_KEEP`: `● [F] {TOOL} · [\`] cycle · [R] reel · [Esc] recall` (tool name from `selectedTool`; the P-cling readout above stays).
- `TRANSIT/APPROACH` + net ready: `● NET READY — [F]/[N] fire` (drop SPACE, or keep `[Space]` only if we keep that alias — recommend dropping the text, leaving the alias functional).
- Not ready: keep `○ NET — get closer`.
- Audit the rest of the lower-edge surface: `HintTicker` (max 4, bottom strip) — grep all `HINT_POSTED` producers for stale key names (H/Shift+O recall from item 7, F4/F5 leftovers, "G to deploy"); fix text only, no mechanism changes.

---

## 11. Tether visualization (per decision: **solid gradient line now**)

Current: `LineDashedMaterial`, 1 px, catenary sag, REELING dash-flow ([ArmUnit.js:5087-5180](js/entities/ArmUnit.js:5087)).

**Fix (cheap, contained in ArmUnit tether construction + `_updateTether`):**
- Switch base material to `LineBasicMaterial` with `vertexColors: true`; per-vertex color/alpha gradient — bright at the strut anchor → dimmer at the daughter (reads as a lit cable, not a broken line). Keep catenary sag.
- Keep a motion cue for REELING: animate a brightness pulse traveling anchor-ward by cycling per-vertex colors (replaces dash-phase; remove `computeLineDistances` calls once dashes go).
- Keep state tints: nominal Dyneema grey-green, EXPENDED dim (opacity 0.2 path stays).
- Update `test-ArmUnit-tether.js` expectations (no `lineDistance` attribute assertions; sag math unchanged).

(Fat-line/Line2 ribbon deferred; noted in ROADMAP as a polish follow-up.)

---

## 12. Flags on satellites & rocket bodies only

**Current state:** a full country-flag decal system already exists (ST-6.2): procedural 4×4 atlas ([FlagDecalSystem.js](js/ui/FlagDecalSystem.js)), per-country `InstancedMesh` overlays built in `DebrisField._buildFlagOverlays` ([DebrisField.js:1013](js/entities/DebrisField.js:1013)), surface-mounted per frame (:1442-1493). Today eligibility = "debris has a known country code" — **type/size is not considered**, and procedural debris without a country gets nothing.

**Fix.**
- Gate flag assignment by class: only `type === 'rocketBody' || type === 'defunctSat'` **and** `sizeMeter ≥ FLAG_MIN_SIZE_M` (new `Constants.DEBRIS_VISUAL.FLAG_MIN_SIZE_M ≈ 2`). Fragments/small junk: never.
- Ensure eligible **procedural** sats/rockets get a country at spawn (weighted pick from the existing 15-country atlas; deterministic from debris id so saves agree) so flags actually appear in early missions, not just catalog rows.
- Scale the decal with `sizeMeter` (current fixed 0.7×0.47 plane reads tiny on an 8 m rocket body): `clamp(sizeMeter × 0.12 …)`.
- Test: eligibility function (type/size gating) pure-unit tested.

---

## 13. Daughter appears inside the debris after capture (reel-in too far)

**Root cause (confirmed).** `_pinCatchToSelf` pins the debris **exactly at the daughter's position** — `d._armPinPos = this.position` ([ArmUnit.js:4051-4056](js/entities/ArmUnit.js:4051)); `DebrisField.pinCapturedDebris`/render path places the instance at `_armPinPos` (:1596-1604). For any debris larger than the daughter (~1 m), she renders inside the catch through GRAPPLED → REELING → DOCKING → HOLDING_CATCH.

**Fix.**
- Give the pin a standoff: `_armPinPos = arm.position + holdDir × (debris.sizeMeter/2 + ARM_HOLD_CLEARANCE_M)` where `holdDir` is the capture axis — use the net's `launchDirection` when present, else `(debrisPos − motherPos)` normalized (so the catch always hangs *outboard* of the daughter, and outboard of the strut in HOLDING_CATCH). New constant `ARM_HOLD_CLEARANCE_M ≈ 1.0` (daughter half-length + net bag).
- Apply consistently in all `_pinCatchToSelf` call sites (GRAPPLED/REELING/DOCKING/HOLDING_CATCH — it's one function, so one change) and verify `CaptureNet` REELING bag-seating math (apex one mouth-radius behind debris, [CaptureNet.js:409-414](js/entities/CaptureNet.js:409)) still wraps the far side with the new offset.
- Check the dock geometry: with the offset, HOLDING_CATCH parks the catch beyond the strut tip — confirm no clipping with mother panels for max-size in-spec catches (MEDIUM net: 5 m).
- Tests: pin position = arm position + expected offset; never coincident; HOLDING_CATCH re-pin keeps offset under parent rotation.

---

## Implementation order

1. **Bug fixes first:** #8 (re-dock), #13 (pin offset), #2 (SK lead aim), #1 (woosh timing) — each independently testable.
2. **Input/UX pass:** #7 (hotkeys + doc ripple), #10 (reticle/ticker hints), #9 (U in ARM_PILOT + readout).
3. **Guidance/content:** #4 (width fit + badges), #5/#6 (stuck-state suite + guard rails), #3 (physics audit + codex), #12 (flag gating), #11 (tether visual).
4. Run full suite `node js/test/run-tests.js` after each phase; manual smoke per phase: D-deploy ceremony → A autopilot → SK → F net → R reel → re-dock, watching for the four fixed symptoms.
5. Update `ARCHITECTURE.md` (§6 hotkeys, §9 FSM notes, drift register) + `HANDOFF.md` shift state at the end.

## Risks / notes

- #8 fix changes RETURNING trajectory — re-check the launch ceremony's TETHER_FOLLOW camera and `ArmManager.recallClosestDeployed` flows still look right.
- #2: instrument before changing — if `|_leadTargetVel|` in SK is already ≈0 in practice (i.e. `_scenePosition` is mother-relative somewhere I haven't seen), the drift has another source (e.g. `STATIONKEEP_LERP_RATE` chase during NETTING, :3862-3884); the instrumentation step decides.
- #7 removes H/Shift+O — anyone with muscle memory loses them; HotkeyOverlay + onboarding text updated in the same commit, and freed keys documented as reserved.
