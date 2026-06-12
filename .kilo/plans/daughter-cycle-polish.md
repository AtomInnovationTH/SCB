# Daughter Cycle Polish — Launch → Net → Capture → Reel-in → Furnace

*Plan date: 2026-06-11 · Baseline: `main` @ `ce5409d` (Phase F complete, 666 suites / 2728 tests / 0 fail)*

## A. Recent work (context)

The 12-chapter mission arc (Phases A–F) is complete as of `ce5409d`. Prior capture-lifecycle work
(`b7d5fae`, `cee4994`) established: authoritative debris pin (`DebrisField.pinCapturedDebris`),
park-the-catch (`HOLDING_CATCH`, 4 s `FURNACE_TRANSFER` window → `CATCH_PROCESSED` →
salvage/scoring/removal in `GameFlowManager`), held-net lifecycle (`CaptureNet._heldByArm`), and the
two-mode failure model. This plan is the **daughter-cycle polish pass** on top of that.

## B. As-built daughter cycle (verified in code)

```
D key (InputManager:877) → GameFlowManager.deployArm → ArmManager.deployArm (guards:
  safe-mode / active-sat / arm-power; auto picks weaver vs spinner by mass)
→ ArmUnit: UNDOCKING → LAUNCHING (crossbow) → TRANSIT → APPROACH → STATION_KEEP
→ F (pilot) or auto → NETTING → _updateNettingFSM → CaptureNetSystem.fireDaughterNet
→ NetProjectile FSM: LAUNCHING(0.15s) → SPINNING_UP(0.5s, 0→SPIN_HZ) → FLIGHT
   → BRAKE → ENVELOP → CINCH_CLOSING → SECURE_CHECK → CAPTURED | MISSED
→ ArmUnit: GRAPPLED → REELING (target = strut-tip dock; net held via _heldByArm;
   debris pinned via _pinCatchToSelf + ArmManager→pinCapturedDebris)
→ DOCKING (3 s lerp to dock) → HOLDING_CATCH (4 s furnace window, catch + net parked
   at strut tip) → CATCH_PROCESSED (GameFlowManager: score/salvage/removeDebris;
   net _heldByArm releases → STOWED) → RELOADING → DOCKED
```

---

## Item 1 — Net + debris visible until chopped into pieces and fed into furnace

**Current:** Net + debris ARE visible through the haul and the 4 s park (held-net + pin work).
But at `CATCH_PROCESSED` everything vanishes in one frame: `GameFlowManager` (line ~674) calls
`removeDebris`, and `ArmUnit._updateHoldingCatch` (line ~4382) clears the pin so the net stows
instantly next tick. No visible breakdown.

**Change (user picked: staged chop into pieces):**

1. **Constants** — replace `FURNACE_TRANSFER.DURATION_S: 4.0` with a staged timeline:
   `FURNACE_TRANSFER: { HOLD_S: 2.0, CHOP_S: 3.0, FEED_S: 4.0, CHUNK_COUNT: 5 }`
   (total ~9 s; keep a derived `DURATION_S` getter for back-compat with any reader).
2. **`ArmUnit._updateHoldingCatch`** — run a 3-phase sub-state (`hold → chop → feed`) off
   `stateTimer`. Emit new events:
   - `CATCH_BREAKDOWN_START { armId, debrisId, chunkCount }` at chop start,
   - `CATCH_BREAKDOWN_CHUNK { armId, debrisId, index, total }` per chunk during feed (evenly spaced),
   - existing `CATCH_PROCESSED` only at feed end (salvage/scoring/removal timing keeps its
     current single-event contract — `GameFlowManager`, ISS/Starlink bosses unaffected).
   Keep the catch pinned (full size) through `hold`; during `chop`+`feed` release the *visual*
   ownership to the new module (set a `debris._breakdownActive` flag; keep `_capturedByArm`
   set so the held net stays cinched until chop starts, then clear it so the bag visual follows
   the breakdown choreography below).
3. **NEW `js/ui/FurnaceBreakdownVisual.js`** (THREE-side, constructed in `main.js` next to
   `CaptureNetVisual`) — listens to the events above:
   - On `CATCH_BREAKDOWN_START`: hide the instanced debris via the existing
     `pinCapturedDebris(..., scaleMul→0)` ramp OR a one-shot swap: spawn `CHUNK_COUNT` small
     irregular chunk meshes (reuse debris-atlas material) at the strut-tip catch position with a
     small separation "chop" animation (slight outward jitter + tumble).
   - On each `CATCH_BREAKDOWN_CHUNK`: animate that chunk along a curve from strut tip to the
     mother's furnace/kiln port (bus position; reuse Forge port anchor if one exists, else bus
     center offset), shrinking + warm glow, then dispose.
   - After the last chunk: animate the net bag (its visual already lives in `CaptureNetVisual`)
     being drawn in — simplest reliable approach: emit `NET_CONSUMED { armIndex }` and have
     `CaptureNetVisual` run a short shrink-toward-mother fade before removing the bag (a
     successful catch already consumes the net per §3.5, so it is fed in with the debris).
   - All node-unsafe; FSM timing in `ArmUnit` stays Node-testable.
4. **`GameFlowManager`** — no timing change needed (still keyed to `CATCH_PROCESSED`); update the
   comms line to fire at breakdown start ("chopping the catch for the furnace") vs completion.
5. **Tests** — update `test-ArmUnit-ParkCatch.js` furnace-transfer describe for the staged
   timeline + new events ordering (`BREAKDOWN_START` → N×`CHUNK` → `CATCH_PROCESSED`); assert
   catch stays pinned through `hold`; assert `CATCH_PROCESSED` payload unchanged.

## Item 2 — Net launch + capture improvements (incl. real spin physics)

**Spin-rate answer (grounded in CAPTURE_NET.md §2.5 + Constants comment block @1494):** the rim-weight
centripetal model needs only ~1–2 Hz to hold the mouth open (LARGE 2 Hz / MEDIUM 4 Hz / SMALL 6 Hz
currently give 47/79/16 N per weight — all above the 5–10 N minimum). Real flight hardware
(RemoveDEBRIS 2018) spun ~1–2 Hz. Current code is physically wrong in two ways:
spin **ramps up** 0→SPIN_HZ as the mouth opens (angular-momentum backwards), and spin **never
decays** in flight, so `f_spin` in `computeClingProbability` is always 1.0 (dead factor).

**Changes:**

1. **Yo-yo despin physics in `NetProjectile`** (`js/entities/CaptureNet.js`):
   - `_updateSpinningUp`: start at `SPIN_HZ × SPIN_FOLDED_MULT` (new constant, ~3×, capped for
     readability) and decay to `SPIN_HZ` as the mouth opens (ω ∝ 1/r² as rim weights deploy) —
     the canister visibly "unwinds fast, blossoms, settles".
   - `_updateFlight`: add slow spin decay `SPIN_DECAY_PER_S` (new constant, e.g. 2%/s from mesh
     flexing losses) so long shots arrive with `spinFraction < 1` → `f_spin` penalty becomes a
     live gameplay factor: **fire inside the envelope or the wrap is weak**.
   - `CaptureNetVisual` already renders `net.spinRate` directly — no visual code change needed
     for rotation; verify SPINNING_UP mouth-scale block (lines ~526/685) reads the new ramp.
2. **Launch lead-aim** (`ArmUnit._updateNettingFSM` @3786): launch direction currently points at
   the target's *current* position. Add first-order lead: aim at
   `targetPos + targetVel_rel × (dist / LAUNCH_SPEED)` using the debris scene velocity vs the
   arm's own velocity (both available). Close-range SK shots barely change; long shots stop
   missing for a non-obvious reason.
3. **Pre-fire capture readout**: while piloted daughter is in `STATION_KEEP` with tool=NET, show
   live `P_cling` estimate (reuse `computeClingProbability` with current range / tumble /
   roughness; `computeDistanceModifier` already exists for HUD use) + the spin/tumble advisories
   in the SK tool HUD (`TargetReticle`/`StatusPanel` tool pane). Player understands *why* to
   de-spin (U) or close distance before firing.
4. **Constants/docs**: add the two new constants with the rim-weight derivation note; sync
   CAPTURE_NET.md §2.5/§6.1.
5. **Tests**: extend `test-CaptureNet.js` — spin starts high and settles at SPIN_HZ; decays in
   FLIGHT; `_resolveCatch` spinFraction reflects decay; lead-aim unit test on a moving mock target.

## Item 3 — Guidance: user is never stuck

**Audit of dead-ends in the cycle (current state):**

| Stuck spot | Today |
|---|---|
| `D` with no target selected | `deployArm` returns false — verify comms feedback exists; add "Select a target first — press Tab" if silent |
| Daughter parked in STATION_KEEP, player idle (doesn't know `F`) | nothing after the arrival message |
| Net miss at SK | comms "Press F to retry" ✅ |
| Out of nets (F click) | `NET_EMPTY_CLICK` + comms ✅, but no follow-up telling player to recall (`R`) + buy nets (`B`) |
| Stuck in ARM_PILOT, doesn't know `7`/`Esc` to return | nothing |
| Daughter out of fuel far away | mother-initiated recall reels home on tether ✅ |
| HOLDING_CATCH | auto-resolves ✅ (item 1 keeps this) |
| Net/tether failures | `first_net_failed` / `first_tether_snap` teaching ✅ |

**Change — a small data-driven idle watchdog, not a new engine:**

1. **NEW `js/systems/ArmIdleAdvisor.js`** (Node-safe): watches `ArmManager` arm states each
   second. Data table `Constants.ARM_IDLE_HINTS`: `{ state, idleS, hintId, text }`, e.g.
   - `STATION_KEEP` + 20 s idle (no net in flight, has nets) → "Daughter holding standoff —
     press **F** to fire the net (or **P** to pilot her)."
   - `STATION_KEEP` + 0 nets → "Out of nets — press **R** to recall, restock at the shop (**B**)."
   - ARM_PILOT mode + 45 s no input progress → "Press **7** to return to the mothership."
   Each hint fires **once per deployment** (reset on state change), routed through
   `TEACHING_MOMENT_FORCE` so TeachingSystem's collision/veteran gating applies (a veteran
   player who has done 10 captures never sees them — reuse `SkillsSystem.isVeteran`).
2. **`D`-with-no-target**: confirm `GameFlowManager.deployArm` path; add the Tab hint if silent.
3. Wire in `main.js` (`init` + `update(dt)`), comms tagged `_postOnboarding`.
4. **Tests**: NEW `test-ArmIdleAdvisor.js` — fires after threshold, once per deployment, respects
   veteran gate, resets on state change; register in `run-tests.js`.

## Item 4 — Accurate reel-in + strut reattach

**Current:** `_updateReeling` already targets the strut-tip dock (good). Two accuracy gaps:

- **Orientation pop:** attitude is skipped during DOCKING, then `PlayerSatellite.postArmUpdate`
  (line ~3644) only handles `DOCKED` — so on `RELOADING→DOCKED` the quaternion **snaps** to the
  strut basis in one frame.
- **HOLDING_CATCH is unmanaged:** `postArmUpdate` skips her (not DOCKED) and ArmUnit's generic
  attitude branch (line ~2137: `skipAttitude` excludes HOLDING_CATCH; velocity=0 → slerp toward
  raw `parentQuat` at 0.1) — the parked daughter rotates to the **wrong basis** (mother bus
  orientation, not her strut's `_composeDockedArmQuat` basis) for the whole park.

**Change:**

1. ArmUnit already carries `_dockOutward` / `_azimuthDeg` (set by ArmManager @241-244). Add an
   `ArmUnit._strutDockQuat(parentQuat)` helper that mirrors `_composeDockedArmQuat`
   (deterministic forward+azimuth-radial basis — keep the roll convention identical; consider
   exporting the helper from `PlayerSatellite.js` instead of duplicating).
2. **DOCKING**: slerp `group.quaternion` toward the strut dock quat over the 3 s window (replace
   the skip) → daughter visibly aligns herself onto the strut, no pop at DOCKED.
3. **HOLDING_CATCH**: set `group.quaternion` to the strut dock quat every frame (like
   `postArmUpdate` does for DOCKED) and add `HOLDING_CATCH` to the `skipAttitude` list so the
   generic branch stops fighting it.
4. Verify REELING approach vector: she reels straight to the strut-tip dock; keep, but clamp the
   final DOCKING entry snap (`position.copy(dockWorldPos)` @4196) — already correct.
5. **Tests**: extend `test-ArmUnit-ParkCatch.js` — HOLDING_CATCH quaternion equals composed strut
   quat (mock parentQuat); DOCKING slerp converges; skipAttitude list assertion.

## Item 5 — Tether reappears in wrong direction ~1 s after return (BUG, root-caused)

**Root cause (two stacked defects):**

1. `ArmUnit._updateTether` (line 4906) hides the tether only for `DOCKED | RELOADING | detached |
   reel-CUT`. **`HOLDING_CATCH` is missing** — the `tetherLine.visible = false` written by
   `_updateHoldingCatch` (line 4367) is overridden to `true` every frame at line 4929 (update
   order: state handler → `_updateTether` @2120). So after a catch is parked, a short stray
   tether (reel anchor @85% strut → daughter @strut tip, with world-down sag) renders.
2. During that window the generic attitude branch slerps `group.quaternion` toward `parentQuat`
   (item 4 defect) while line 5068 counter-rotates tether vertices by the *pre-postArmUpdate*
   quaternion → the line points in a visibly wrong direction until the slerp converges (~1 s).

**Fix:** add `S.HOLDING_CATCH` to the `_updateTether` early-return hide list (one line; makes the
intent of line 4367 actually hold) — `_updateBridle` mirrors automatically. Item 4's attitude fix
removes the second defect for any state where the tether legitimately shows.
**Tests:** assert `_updateTether` hides in HOLDING_CATCH (mirror existing visibility tests).

## Item 6 — “?” hotkey overlay update

Audit `js/ui/HotkeyOverlay.js` `HOTKEY_GROUPS` against `InputManager` (verified gaps):

- **Missing:** `U` (hold) — mother de-spin laser (CP-2; needs target selected). Add to
  *Capture & Tools* with the "detumble before netting" hint.
- **Wrong/stale:** "1–6 Select / deploy arm" → Y0 has **4 arms**; `1–4` select/deploy arm
  (`Shift+1/2/3` = power buses already listed), `5/6` are no-ops beyond arm indices that don't
  exist — list as `1–4`. `7` (return to mothership) works **globally**, not only in pilot mode —
  keep in the daughter section but verify wording.
- **Backtick nuances:** plain `` ` `` while piloting a daughter in STATION_KEEP = **cycle tool**
  (CP-1), else Debris Map; `Shift+`` ` `` = cycle tool globally. Clarify the two rows.
- Add `Shift+A` row already present ✅; check `K` (reserved no-op — remove if listed; it isn't),
  `G` bare (no-op) vs `Shift+G` trawl ✅, `Z/Shift+Z` ✅, `F2` ✅, `F5` ✅, `X` ✅.
- Sweep the remaining handlers (lines 452–1460) one-by-one against the overlay during
  implementation; fix descriptions that drifted (e.g. `R` = abort autopilot / recall+reel,
  `Enter` approach, `W` wide scan vs WASD note).
- **Add the new keys from this plan** if any land (none planned — items 1–5 reuse existing keys).
- Keep grouping; ARCHITECTURE.md §hotkey map should be synced in the same commit.

---

## Execution order & verification

1. **Item 5** (one-line fix + tests) → 2. **Item 4** (attitude/dock basis) → 3. **Item 1**
   (staged furnace breakdown; builds on 4/5 being stable at the strut) → 4. **Item 2** (spin
   physics + lead-aim + pre-fire HUD) → 5. **Item 3** (idle advisor) → 6. **Item 6** (hotkey
   audit last, so it documents the final state).

- After each item: `node js/test/run-tests.js` (baseline 666/2728/0).
- Browser playtest checklist (items 1/2/4/5 are visual): deploy D → pilot P → F fire (watch
  spin blossom + settle, lead-aim on a mover) → catch → watch reel-in (net cinched the whole
  way) → dock (no orientation pop, **no stray tether**) → 9 s chop-and-feed into the furnace
  (chunks stream to the mother, net drawn in last) → daughter reloads → `?` overlay accurate.
- Docs: update HANDOFF.md latest-shift block, CAPTURE_NET.md §2.5/§6.1, ARCHITECTURE.md hotkeys
  + capture-FSM notes.

## Risks / notes

- Item 1 changes the `FURNACE_TRANSFER` window length (4 s → ~9 s) — bosses/teaching key off
  `CATCH_PROCESSED` (event contract unchanged, only later); `test-ArmUnit-ParkCatch.js` timing
  constants must follow the new staged values.
- Item 2's flight spin decay makes long-range shots genuinely weaker — tune `SPIN_DECAY_PER_S`
  so in-envelope (≤100 m) shots lose <10% so the Y0 difficulty doesn't regress.
- `CaptureNetVisual` net-consumed animation must handle the net being removed from
  `activeNets` (STOWED) — keep a short-lived detached visual ("ghost bag") owned by
  `FurnaceBreakdownVisual` if simpler than extending CaptureNetVisual's lifecycle.
