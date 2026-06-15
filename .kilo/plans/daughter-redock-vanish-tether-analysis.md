# Daughter re-dock with debris: "disappears ~2 s + wrong-way (180°) tether, then pops onto the strut" — root-cause analysis & fix plan

## Observed symptom (user report)
A daughter returns a captured debris to her strut tip. On re-attach:
1. The daughter **disappears for ~2 seconds**.
2. A **new tether becomes visible for ~2 seconds, extending the wrong way — ~180° opposite** the strut.
3. The daughter **re-appears on the strut later**.

This is the exact signature of the known **"#8 re-dock vanish / 180°-tether"** bug class, documented in
[`.kilo/plans/daughter-lifecycle-debug-polish.md`](daughter-lifecycle-debug-polish.md) §8 and
[`HANDOFF.md`](../../HANDOFF.md) line 12.

---

## The mechanism (why this LOOKS like it does)

The bug class has two independent mechanisms; both produce the same picture.

### Mechanism A — daughter steered to the wrong dock target → hull occlusion + inward tether
The mother-side tether anchor is the **reel cartridge at 85 % of the strut**, computed in
[`getTetherAnchorWorldPosition`](../../js/entities/ArmUnit.js:1968) from `_reelOffset`
(set in [`PlayerSatellite._updateStruts`](../../js/entities/PlayerSatellite.js:3522)). If the daughter is
driven toward the **mother bus centre** (`parentPos`) instead of the **strut-tip dock**
(`parentPos + parentQuat × dockOffset`), she flies *into / behind the hull* — reading as **"disappears"**
(occluded) — while the strut-tip-anchored tether draws *from the strut tip inward through the ship* to her
body: visually a tether pointing **180° opposite** the strut. [`_updateDocking`](../../js/entities/ArmUnit.js:4758)
then lerps her back out to the strut tip over `ARM_DOCK_DURATION = 3.0 s`
([`Constants.js:507`](../../js/core/Constants.js:507)) → **"re-appears on the strut later."**

### Mechanism B — one-frame-stale tether counter-rotation during DOCKING
[`_updateTether`](../../js/entities/ArmUnit.js:5614) bakes `tetherLine.quaternion = group.quaternion⁻¹`
during `armManager.update()`. Immediately afterward,
[`PlayerSatellite.postArmUpdate`](../../js/entities/PlayerSatellite.js:3618) **slerps `group.quaternion`**
toward the strut basis. The rendered tether is then rotated by that frame's slerp delta — **worst at DOCKING
entry, where the pose error can approach 180°** (see the comment at
[`PlayerSatellite.js:3625-3634`](../../js/entities/PlayerSatellite.js:3625)).

---

## What is ALREADY fixed (do NOT re-fix)
Working tree is clean (committed). The following are present and correct:
- **REELING** (the captured-debris path) reels to the **strut-tip** dock world pos and snaps there before
  `→ DOCKING` — [`_updateReeling`](../../js/entities/ArmUnit.js:4580-4617) (Issue 1, 2026-05-26).
- **RETURNING** (empty-handed) also targets the strut tip — [`_updateReturning`](../../js/entities/ArmUnit.js:4730-4751) (Issue 8).
- **postArmUpdate re-syncs** `tetherLine.quaternion` after its DOCKING / LAUNCHING / HOLDING_CATCH quat write
  — [`PlayerSatellite.js:3632-3634`](../../js/entities/PlayerSatellite.js:3632).
- **Catch pin standoff** (Issue 13): the catch hangs outboard via
  [`_pinCatchToSelf`](../../js/entities/ArmUnit.js:4354) using `ARM_HOLD_CLEARANCE_M`
  ([`Constants.js:512`](../../js/core/Constants.js:512)) so the daughter is not pinned *inside* the catch.

Because Mechanism A is fixed for **both** the empty (RETURNING) and captured (REELING) paths, and Mechanism B
is mitigated by the re-sync, the captured-debris path should — in theory — re-dock cleanly. The fact that the
user still sees it **with debris** means a residual contributor is live. The capture path is unambiguous:
[`GRAPPLED → REELING`](../../js/entities/ArmUnit.js:4287) → snap to strut tip → `DOCKING` → `HOLDING_CATCH`
([`ArmUnit.js:4794-4810`](../../js/entities/ArmUnit.js:4794)).

---

## Most-likely live contributors (in priority order)

### 1. HOLDING_CATCH "hold" phase occludes the daughter for exactly ~2 s  → the "disappears for 2 seconds"
The staged furnace breakdown timeline ([`FURNACE_TRANSFER`](../../js/core/Constants.js:374)) is:
`HOLD_S = 2.0`, `CHOP_S = 5.0`, `FEED_S = 9.0`. During the **hold window [0, 2.0 s)**
([`_updateHoldingCatch`](../../js/entities/ArmUnit.js:4892-4896)) the catch is parked **full size** (e.g. a 5 m
MEDIUM-net bag) outboard of the ~1 m daughter at the strut tip. From the usual gameplay camera (behind/around
the mother looking outward) the full-size catch **occludes the daughter for ≈2.0 s** — the "disappears for 2
seconds" — and she only "re-appears" once chop/feed shrinks and consumes the catch at `FEED_S`
(`→ RELOADING → DOCKED`, daughter clamped visibly to the strut). `HOLD_S = 2.0` is the **exact match** for the
reported 2-second duration and the "re-appears later" tail.

### 2. The tether stays VISIBLE through DOCKING → the residual 180° flash
The tether hide-list at [`_updateTether`](../../js/entities/ArmUnit.js:5461) covers `DOCKED`, `RELOADING`,
`HOLDING_CATCH` — **but NOT `DOCKING`**. So for the whole ≤3 s DOCKING window the tether renders. Even with the
strut-tip snap and the postArmUpdate re-sync, the DOCKING-entry frame is the single most fragile point for
Mechanism B (pose error ~180°, slerp 0.12/frame, re-sync gated on `sg.strutDir.lengthSq() > 0` and
`tetherLine.visible`). Any 1-frame ordering slip shows the tether briefly flipped. Since the daughter is
**already reeled home to the strut tip** by the time DOCKING begins, the tether carries no information here —
hiding it removes the flash entirely and unconditionally.

### 3. Stale build via the service worker (lower probability)
[`sw.js`](../../sw.js) serves JS **network-first** (`isJsRequest` → network-first, line 106/130), so a normal
online reload gets fresh code. But an offline/failed fetch falls back to the cached `space-cowboy-v5` entry.
Worth ruling out before chasing code further.

---

## Verification protocol (confirm which contributor is live before editing)
1. **Rule out stale build:** hard-reload with cache disabled / unregister the service worker, repeat one
   debris re-dock. If the symptom vanishes → it was contributor 3; bump `CACHE_NAME` and stop.
2. **Instrument with `?debug`** (per §8 of the polish plan): during one debris capture→reel→re-dock, log per
   frame: `arm.state`, `arm.getDeployState()`, `arm.mesh.visible`, `arm.position`, the strut-tip world pos,
   the tether endpoints (`getTetherAnchorWorldPosition` and `arm.position`), and `capturedDebris.sizeMeter`.
   - If `mesh.visible` is **true** throughout the 2 s gap and the gap aligns with `HOLDING_CATCH` stateTimer
     `[0, 2.0)` → contributor **1** (camera occlusion by the parked catch), not a true hide.
   - If the wrong-way tether endpoints both sit outboard yet still render during `DOCKING` → contributor **2**.

---

## Scope decision
**Full fix — both symptoms.** Ship **Fix A** (wrong-way tether flash) and **Fix B** (parked-catch eclipsing
the daughter) together. The verification protocol above still runs first to pick the exact Fix-B variant
(B1/B2/B3) and to rule out the service-worker contributor, but both A and B are in scope for this change.

## Proposed fixes (smallest, highest-confidence first)

### Fix A — hide the tether during DOCKING (kills the 180° flash unconditionally)
Add `S.DOCKING` to the early-out in [`_updateTether`](../../js/entities/ArmUnit.js:5461):
```js
if (this.state === S.DOCKED || this.state === S.DOCKING ||
    this.state === S.RELOADING || this.state === S.HOLDING_CATCH) {
  this.tetherLine.visible = false;
  return;
}
```
Rationale: after the REELING/RETURNING strut-tip fixes the daughter is already AT the strut tip when DOCKING
begins, so the tether spans ~0 and carries no information; rendering it only exposes the Mechanism-B flash.
Mirrors the existing DOCKED/RELOADING/HOLDING_CATCH treatment. (Re-check the launch-ceremony TETHER_FOLLOW
camera and `recallClosestDeployed` flows — note in polish-plan §8 risk register.)

### Fix B — stop the parked catch from occluding the daughter ("disappears 2 s")
Confirm contributor 1 first, then choose the least-invasive option:
- **B1 (visual):** push the HOLDING_CATCH pin standoff further outboard, and/or offset the catch *laterally*
  (not directly along the camera→daughter axis) so the full-size bag never overlaps the daughter sprite —
  tune in [`_pinCatchToSelf`](../../js/entities/ArmUnit.js:4370-4373) / `ARM_HOLD_CLEARANCE_M`.
- **B2 (pacing):** if the 2 s full-size hold itself reads as "she vanished," shorten `HOLD_S` or begin a
  gentle chop-shrink at hold start so the catch never fully eclipses her
  ([`Constants.js:383`](../../js/core/Constants.js:383)).
- **B3 (render order):** ensure the daughter mesh renders on top of / not depth-occluded by the catch bag at
  the dock (renderOrder / depth), if the occlusion is purely a layering artifact.

### Fix C — service-worker cache hygiene (if contributor 3 confirmed)
Bump `CACHE_NAME` in [`sw.js:36`](../../sw.js:36) so returning players evict the stale shell.

---

## Tests
- Extend [`test-ArmUnit-tether.js`](../../js/test/test-ArmUnit-tether.js): assert `tetherLine.visible === false`
  in `DOCKING` (alongside existing DOCKED/RELOADING/HOLDING_CATCH expectations).
- HOLDING_CATCH occlusion: assert the catch `_armPinPos` standoff keeps a minimum lateral clearance from
  `arm.position` for a max in-spec catch (MEDIUM net, 5 m) under parent rotation.
- Regression: existing strut-tip convergence tests for REELING/RETURNING remain green
  (`node js/test/run-tests.js`).

## Manual smoke
Capture a debris → R reel → watch re-dock: **no wrong-way tether flash during DOCKING**, daughter stays
visible (or the parked catch no longer eclipses her), catch breaks down on the furnace timeline, daughter
clamped to the strut at DOCKED.
