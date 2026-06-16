# Reel-In Speed + Catch-Inertia + FEEP Soft Re-Dock

> **Status:** Plan (design + implementation). Plan mode — no source edited yet.
> **Author/date:** 2026-06-16 (Rev 3 — deep code dig + edge cases + yoke = tether-plume clearance).
> **Answers four design questions:** (1) reel-in too slow at distance, (2) how the
> daughter manages debris/inertia on reel-in, (3) does she cinch the net tight so
> daughter/net/debris become one unit, (4) does she use FEEP to null inertia on
> final approach to the mother/strut for re-docking.
>
> **Decisions locked (2026-06-16) — all forks resolved, see §8:**
> - Reel speed → **trapezoidal velocity profile** (fast cruise, gentle dock).
> - FEEP re-dock → **burns FEEP fuel, scaled by catch mass** (abstract debit).
> - Yoke clearance → **geometric test + whole-haul reel attitude**; reel-only fallback; no ablation sim.
> - FEEP ±15° steering is **electrostatic/free**; the yoke's job is **tether-plume clearance**.
> - Deliverable → **design-doc sections + code/constants/test plan**.
>
> **Rev-2 corrections after reading the code:**
> - **Fuel is per-state-rate, not ΔV-coupled** → Q4 needs a *new* discrete fuel
>   debit; it cannot fall out of the existing model. `REELING` is **zero-fuel**.
> - **Orbital inertia is already hidden** by the frame-correction + catch pin →
>   "neutralize inertia" is partly moot in-sim; see §Q4 for the honest framing
>   (abstract mass-scaled debit chosen).
>
> **Rev-3 corrections (user physics input — the crux):**
> - **FEEP ±15° vectoring is electrostatic, NO moving parts** — it is inherent to
>   the emitter (beam steering) and is *why FEEP was selected for the daughter*.
>   So vectoring is free in both lore and sim (idealized impulse). My earlier
>   "build vectoring first" framing was wrong; **nothing to build for vectoring.**
> - **The yoke (the +Y wishbone bridle/gimbal) is essential — its job is to keep
>   the TETHER clear of the FEEP exhaust plume.** It is currently **visual-only**
>   (geometry at [ArmUnit.js:691-730](js/entities/ArmUnit.js:691)); there is **no
>   functional tether-vs-plume model** and **no interlock** (the
>   `CAPTURE_NET.md §4.2` "FEEP prohibited during reel" is lore, not code).
> - **Consequence:** Q2/Q4 fire FEEP *while the tether is taut toward the mother*.
>   Braking uses the **fore nozzle (+Z exhaust)** and the daughter points **+Z at
>   the mother**, so the braking plume fires **toward the mother — the same side
>   the tether runs to.** Without a modelled yoke clearance this is precisely the
>   §4.2 plume-ablation→snap failure. **The yoke clearance is therefore a real
>   prerequisite for the FEEP-during-reel behaviours** (see new §1.2 + open Qs).

---

## 1. Current State (verified in code)

Retrieval is **two reel stages**, not one:

| Stage | Code | Tether | Speed today | Problem |
|---|---|---|---|---|
| **1. Net reel** (net+debris → daughter) | [`CaptureNet._updateReeling()`](js/entities/CaptureNet.js:843) | ≤100 m net tether | `netClass.REEL_SPEED` 2–3 m/s over `tetherPaidOut`; while `_heldByArm` just holds the cinch ([CaptureNet.js:852](js/entities/CaptureNet.js:852)) | No explicit "snug / rigidize" |
| **2. Daughter reel** (daughter+catch → strut) | [`ArmUnit._updateReeling()`](js/entities/ArmUnit.js:4555) | ≤2 km arm tether | **constant** `REEL_IN_SPEED_LOADED 4.0`/`_EMPTY 2.0` m/s ([Constants.js:896](js/core/Constants.js:896)) over **real dt**; Shift ×2 ([`REEL_BOOST`](js/core/Constants.js:470)) | 2 km ÷ 4 ≈ **500 s real**; linear, no taper |
| **3. Final dock** | [`ArmUnit._updateDocking()`](js/entities/ArmUnit.js:4753) | — | `position.lerp(dockWorldPos, 0.05)` over `ARM_DOCK_DURATION 3.0` s | kinematic snap; no momentum match |

### 1.1 Control + physics primitives that already exist (reuse these)

- **Proportional velocity-matching autopilot** ([`_updateTransit`](js/entities/ArmUnit.js:2704), [`DAUGHTER_AUTOPILOT`](js/core/Constants.js:3210)): quadratic braking `v*=min(V_CAP,√(2·a·r))`, relative-velocity matching, impulse `velocity.add(KP·err)` clamped by `MAX_ACCEL·gameDt`. **This is exactly a soft-dock controller** — Q4 reuses its math against the strut-tip dock instead of re-inventing it.
- **Thrust is idealized world-space impulse.** `applyManualThrust` ([4329](js/entities/ArmUnit.js:4329)) and the autopilot apply force along world axes regardless of arm attitude. `_computeMetalThrust` ([4422](js/entities/ArmUnit.js:4422)) gives a real Newton value. FEEP's ±15° steering is **electrostatic (no moving parts)**, so vectoring is free — but the sim does not yet model the **plume direction** or whether it crosses the tether (see §1.2).
- **Fuel** = `this.fuel` 0–100, drained by **per-state %/s** in [`_consumeFuel`](js/entities/ArmUnit.js:5381) (`REELING 0.0`, `DOCKING 0.2`, `RETURNING 1.2`). Impulse magnitude does **not** debit fuel.
- **Orbital frame-correction** ([2111](js/entities/ArmUnit.js:2111)): every state except DOCKED/DOCKING gets `parentDelta` added to position each frame, so deployed arms ride the mother's co-moving frame. **DOCKING is excluded** (that's why the lerp works).
- **Catch pin** ([`_pinCatchToSelf`](js/entities/ArmUnit.js:4330)): debris is force-set to the daughter's position+standoff every frame. Combined with the frame-correction, **the catch carries no independent momentum in-sim.**
- **REELING entry points (3 of them):** GRAPPLED→REELING after `ARM_GRAPPLE_STABILIZE` ([4257](js/entities/ArmUnit.js:4257), gated by `_checkNetIntegrityOnReel`); [`reelFromStationKeep()`](js/entities/ArmUnit.js:3354) (zero-fuel abort, no catch); mother-initiated [`recall()`](js/entities/ArmUnit.js:1237). `recallFromStationKeep()` → **RETURNING** (FEEP-powered) is the deliberate fuel-burning counterpart.
- **Failure paths already wired:** net-rip recoverable ([`_checkNetIntegrityOnReel`](js/entities/ArmUnit.js:4257), boost-rip [4642](js/entities/ArmUnit.js:4642)), tether snap catastrophic ([4671](js/entities/ArmUnit.js:4671)) with a **Mission-1 clamp** ([4674](js/entities/ArmUnit.js:4674)), detached-arm → DEORBITING ([4246](js/entities/ArmUnit.js:4246)) / TRANSIT ([4715](js/entities/ArmUnit.js:4715)).

Scale facts: `M = 0.00001` scene-units/m; reel moves use **real dt** (not game-time). `V5_WEAVER_MASS 6.6`, `V5_SPINNER_MASS 2.1` kg; `WEAVER_THRUST 0.35 mN`, `SPINNER_THRUST 0.5 mN`; Weaver net cap ~500 kg.

### 1.2 Yoke / tether-plume geometry (the Rev-3 crux)

Verified daughter geometry:

| Element | Local position | Direction | Role |
|---|---|---|---|
| **Bridle gimbal (yoke)** | `(0, +0.70·by, 0)` ([:696](js/entities/ArmUnit.js:696)) | +Y (top) | **Tether anchor** — Y-fork legs to hardpoints at `(±0.45·bx, +0.30·by, 0)` ([:704](js/entities/ArmUnit.js:704)) |
| **Aft FEEP nozzle** | `(0, 0, −0.52·bz)` ([:540](js/entities/ArmUnit.js:540)) | −Z exhaust | Accelerate (push +Z, toward target) |
| **Fore FEEP nozzle** | `(+0.25·bx, 0, +0.45·bz)` ([:568](js/entities/ArmUnit.js:568)) | +Z exhaust | **Brake** (decelerate) |

Daughter convention: **nose +Z points at the target/mother** ([:2274-2286](js/entities/ArmUnit.js:2274)). Therefore the tether (from +Y) and the thrust axis (±Z) are nominally orthogonal — *that orthogonality is the whole point of the yoke.*

**The problem the yoke solves, and why it matters here:** to brake the closing motion while being reeled home, the daughter fires the **fore nozzle (+Z exhaust) toward the mother** — and the tether also runs to the mother (off the +Y bridle, angling toward +Z). So the braking plume and the cable are on the **same side**. The yoke's +Y offset + fork angle are what hold the cable outside the plume cone. **None of this is modelled today:**
- The tether/plume are visual meshes; there is no clearance test.
- `REELING`/arrest **attitude is uncontrolled** for this (`REELING` not in `skipAttitude`, [:2277](js/entities/ArmUnit.js:2277); falls to a prograde/inherited heading).
- No interlock gates FEEP during reel (§4.2 is lore).

⇒ **Firing FEEP during reel-in/re-dock (Q2/Q4) is only physically valid if we model the yoke clearance + a defined reel/arrest attitude.** This is the prerequisite the user flagged. Options in §8.

---

## 2. Design Answers (the four questions)

### Q1 — Faster reel, especially when far. → **Trapezoidal velocity profile**

Replace the constant `reelSpeed` in [`_updateReeling`](js/entities/ArmUnit.js:4571) with accel → cruise → decel, in the **same units** (game-scale m/s over real dt) so it slots into the existing per-frame `moveDistance = speed·M·dt` step:

```
v_cruise = clamp( HAUL_MOTOR_POWER / max(T_reel, T_MIN), V_DOCK, V_CRUISE_MAX )
v(dist)  = ramp toward v_cruise at ACCEL, then ramp DOWN to V_DOCK
           once remaining dist ≤ DECEL_DISTANCE_M
```

- **Cruise is power-bounded ⇒ heavier catch is honestly slower** (`v=P/T`, `T` from the existing `(armMass+payloadMass)·v·coeff`). This doubles as the balance lever.
- **Preserve the invariant "an in-spec catch never snaps"** ([Constants.js:915](js/core/Constants.js:915)): the cruise auto-throttle must keep `T_reel < tetherBreakStrength` for any ≤rated catch. Only **Boost** may push past (keeps the existing risk mechanic). Add a unit test asserting a max in-spec Weaver catch at `V_CRUISE_MAX` stays under break strength after throttle.
- **Boost (`REEL_BOOST` ×2)** multiplies `v_cruise` only, and is **disabled inside `DECEL_DISTANCE_M`** so the player can't slam the dock (keeps Q4 arrest meaningful). Tension still ∝ speed² → boost-rip path ([4642](js/entities/ArmUnit.js:4642)) unchanged.
- **Edge — short reel** (point-blank capture, `dist < DECEL_DISTANCE_M`): skip cruise, go straight to the ramp-down; the existing `moveDistance >= dist` snap ([4601](js/entities/ArmUnit.js:4601)) still terminates cleanly.
- **Edge — heavy catch / low power:** `V_DOCK` floor + `T_MIN` denominator floor prevent a 0-speed stall.
- **Edge — save/load mid-reel:** profile is **stateless** (derived from current distance + payload each frame), so no persistence schema change.

Targets (tunable, §6): `V_CRUISE_MAX ≈ 60`, `V_DOCK ≈ 1.0` m/s, `ACCEL ≈ 8` m/s², `DECEL_DISTANCE_M ≈ 15`. ⇒ 2 km empty ≈ ~33 s (was ~500 s); near-rated loaded throttled to ~60–90 s; <50 m capture ≈ seconds.

### Q2 — Managing debris + inertia on reel-in. → **Combined-mass tension + honest scope note**

What the sim *can* honestly model without re-architecting:

1. **Combined mass for tension/throttle.** Extend `payloadMass` ([4629](js/entities/ArmUnit.js:4629)) to `m_unit = m_daughter + m_net + m_debris`; the cruise throttle (Q1) and snap model already key off this. (Net mass is small but makes `m_unit` the single source of truth for Q3/Q4.)
2. **Cinch impulse spike.** The one-time momentum handoff when the bag cinches the debris to the daughter is represented as a brief tension transient at SNUG (Q3), feeding the existing snap/rip path — not a new physics system.
3. **Honest limitation (important):** because of the **frame-correction + catch pin** (§1.1), the catch has **no independent orbital velocity in-sim** during REELING — the only relative motion is the reel closing-rate. So "inertia management" reduces to *ramping the closing-rate down* (Q1) and *not slamming the dock* (Q4). True 6-DOF momentum (a tumbling 500 kg unit fighting the daughter) is **not** modeled today and is out of scope unless we adopt the real-momentum option in §Q4.
4. **Lateral-drift damping via FEEP** — with the **whole-haul reel attitude** held (nose +Z at the strut, +Y bridle trailing so the cable stays off the ±Z plume, §Q4/§1.2), FEEP tension/drift management (DAUGHTER_ARM_CONTROLS §5.1 role 4) is available throughout the haul, gated by `_tetherPlumeClearOK()`. Attitude slew is reaction-control (negligible fuel); the haul stays zero-fuel — only the **translational arrest** debits FEEP (Q4).

### Q3 — Reel net tight so daughter/net/debris are one unit. → **Yes; formalize the implicit SNUG**

This is *already implicit*: GRAPPLED co-locates the arm with the debris (`position.copy(tPos)`, [4242](js/entities/ArmUnit.js:4242)), then the pin rigidizes them through REELING/DOCKING. We make it explicit and physical:

- Add a short **SNUG sub-phase** at the GRAPPLED→REELING boundary (extend `ARM_GRAPPLE_STABILIZE`, or a `CATCH_SNUG` window): the **stage-1 net reel** finishes pulling `tetherPaidOut → 0` and tightens to `CATCH_SNUG.TENSION_TARGET_N`, settling `SETTLE_S`, so daughter+net+debris is one rigid body with one CoM (`m_unit`) before the haul. Emit `CATCH_SNUGGED { armIndex, debrisId, mUnit }`.
- **Tangle benefit:** a rigid, snugged unit removes the trailing-bag pendulum → directly mitigates the reel-in asymmetric-collapse tangle ([`CAPTURE_NET.md §4.5`](CAPTURE_NET.md:602)).
- **Edge — over-rated catch can't snug:** reuse the existing `_checkNetIntegrityOnReel` ([4257](js/entities/ArmUnit.js:4257)) — over-strain → recoverable net-rip (debris drifts free, daughter returns). No new failure path.
- **Edge — empty reel** (`reelFromStationKeep`, abort): no catch ⇒ **skip SNUG** entirely.
- **Edge — catch cleared mid-reel** (debris removed/destroyed): if `capturedDebris` becomes null during REELING, continue as an empty return (mirror the HOLDING_CATCH→RELOADING fallback at [4848](js/entities/ArmUnit.js:4848)); do not strand the FSM.

### Q4 — FEEP to null inertia on final re-dock. → **Yes, as a new mass-scaled fuel debit (reuse autopilot math)**

**Honest framing first.** Given §1.1, the only relative velocity to arrest in-sim is the reel closing-rate, which Q1's ramp-down already brings to `V_DOCK`. So Q4, implemented faithfully to the current kinematics, is: *FEEP pays a fuel cost to perform the final arrest, and the dock contacts at `≤ SOFT_DOCK_VEL`*. Two ways to make it real:

- **(Recommended) Abstract mass-scaled debit** — keep the proven frame-correction/pin/reel path; add a **one-shot fuel debit** when the unit enters the arrest window: `fuel -= REDOCK_FEEP.DEBIT_K · m_unit · v_arrest` where `v_arrest` is the closing-rate killed (≈ `V_DOCK` + any boost overshoot). This delivers the design intent ("burns FEEP, scaled by catch mass", a "don't dock hot" skill) **without re-architecting** the inertia model. Needs the new debit because `_consumeFuel` is state-rate-only.
- **(Stretch / bigger) Real residual-momentum model** — stop frame-correcting the catch, give `m_unit` a true velocity vs the strut, and drive it to `≤ SOFT_DOCK_VEL` with the **existing `DAUGHTER_AUTOPILOT` controller** (velocity-matching + quadratic braking) targeting the moving strut-tip dock; fuel debited per impulse. Physically honest and reuses the controller, but touches the stable reel/dock/pin path and the snap-on-overload invariant — higher regression risk.

Either way:
- **Bulk REELING stays zero-fuel** (doctrine preserved); FEEP is charged **only in the arrest sub-phase / DOCKING** within `ARREST_DISTANCE_M`.
- **Fuel-insufficient fallback** (`FUEL_FALLBACK_SLOW`): if `fuel` can't cover the debit, the reel motor finishes the dock at a slower ramp (longer, zero-fuel) and comms warn — **never a dead-end**. Mirrors the Mission-1 snap clamp philosophy ([4674](js/entities/ArmUnit.js:4674)); consider a Mission-1 free pass.
- **Replaces** the bare `position.lerp(dockWorldPos, 0.05)` with: arrest closing-rate first, then the visual settle lerp once `v_rel ≤ SOFT_DOCK_VEL`.
- **Yoke clearance (decided):** model the tether-plume clearance with a **geometric test** (`_tetherPlumeClearOK()`: angle between tether line and active-nozzle axis ≥ `MIN_TETHER_PLUME_DEG`) and a **whole-haul reel attitude** — the daughter slews to nose +Z at the strut with the +Y bridle trailing so the cable rides outside the ±Z plume cone for the entire REELING haul (not just the arrest). FEEP (drift-hold + arrest) fires only when the test passes; otherwise **reel-motor-only** (zero-fuel, slower) — no ablation simulated. Add FEEP role 7 "Re-dock inertia null" to `DAUGHTER_ARM_CONTROLS.md §5.1`; **correct §5.4** (±15° steering is electrostatic/no-moving-parts/free; the yoke's role is plume-tether clearance).

---

## 3. Constants (additions to [`Constants.js`](js/core/Constants.js))

```js
// --- Daughter reel-in velocity profile (trapezoidal; game-scale m/s over real dt) ---
REEL_PROFILE: {
  V_CRUISE_MAX:        60,    // m/s — cruise cap (empty/light catch)
  V_DOCK:              1.0,   // m/s — gentle speed entering the soft-dock window
  ACCEL:               8.0,   // m/s² — ramp-up / ramp-down magnitude
  DECEL_DISTANCE_M:    15,    // m — begin ramp-down within this of the strut dock
  HAUL_MOTOR_POWER:    2500,  // sets v_cruise = POWER / max(T_reel, T_MIN)
  T_MIN:               5,     // N — denominator floor so light catches hit V_CRUISE_MAX
  BOOST_LOCKOUT_IN_DECEL: true, // disable REEL_BOOST inside DECEL_DISTANCE_M
},

// --- Stage-1 net snug-up (rigidize into one unit) ---
CATCH_SNUG: {
  TENSION_TARGET_N:    8,     // N — snug pull tightening the bag to the −Y face
  SETTLE_S:            0.4,   // s — settle so the cinch impulse damps before haul
  // over-strain reuses NET_STRAIN_* + _checkNetIntegrityOnReel (recoverable rip)
},

// --- FEEP soft re-dock (mass-scaled fuel debit; abstract model — see §Q4) ---
REDOCK_FEEP: {
  SOFT_DOCK_VEL:       0.10,  // m/s — max |v_rel| to strut allowed at contact
  ARREST_DISTANCE_M:   8,     // m — arrest active within this of dock
  DEBIT_K:             0.0008,// fuel% per (kg·(m/s)) — tune so a hot 500 kg dock stings
  FUEL_FALLBACK_SLOW:  true,  // insufficient fuel OR no plume clearance → slow reel-only finish + warn
  MISSION1_FREE:       true,  // no debit during the learning mission
},

// --- Yoke / tether-plume clearance (Rev-3 prerequisite for FEEP-during-reel) ---
YOKE_CLEARANCE: {
  PLUME_HALF_ANGLE_DEG:   20,   // ion exhaust cone half-angle to keep the tether out of
  VECTOR_ENVELOPE_DEG:    15,   // electrostatic beam-steer authority (free, no moving parts)
  MIN_TETHER_PLUME_DEG:   30,   // required angle between tether line and plume axis to fire FEEP
  REEL_ATTITUDE_SLERP:    0.1,  // slew rate to the tether-trail / nose-at-strut attitude
},

```

`REEL_IN_SPEED_LOADED/EMPTY` ([Constants.js:896](js/core/Constants.js:896)) are **retired as haul speed** but kept as the `V_DOCK`-band fallback for test mocks / pre-flag compat. Gate behaviour behind a flag (e.g. `FEATURE_FLAGS.REEL_PROFILE_V2`) so it ships isolated and bisectable.

---

## 4. FSM / Code Touch-Points

| File | Change |
|---|---|
| [`ArmUnit._updateReeling()`](js/entities/ArmUnit.js:4555) | Replace constant `reelSpeed` with the trapezoidal profile; cruise throttled by `m_unit`-tension; ramp-down within `DECEL_DISTANCE_M`; boost lockout in decel. Keep RIP/SNAP + Mission-1 clamp exactly. |
| [`ArmUnit._updateGrappled()`](js/entities/ArmUnit.js:4239) | Insert SNUG window before `_transitionTo(S.REELING)`: pull stage-1 net to `tetherPaidOut→0`, settle, emit `CATCH_SNUGGED`. Over-strain stays in `_checkNetIntegrityOnReel`. |
| [`CaptureNet._updateReeling()`](js/entities/CaptureNet.js:843) | Make the `_heldByArm` "hold" an explicit snug-tension target during SNUG (it already holds; add the tension target + completion signal). |
| New `ArmUnit._updateRedockArrest()` or fold into [`_updateDocking()`](js/entities/ArmUnit.js:4753) | Within `ARREST_DISTANCE_M`: drive closing-rate → `SOFT_DOCK_VEL`; apply one-shot fuel debit `DEBIT_K·m_unit·v_arrest`; `FUEL_FALLBACK_SLOW` if short OR if plume clearance unmet; visual settle lerp only after `v_rel ≤ SOFT_DOCK_VEL`. |
| **Reel attitude (whole haul) + yoke clearance (Rev-3, decided)** — [attitude block ~2277](js/entities/ArmUnit.js:2277) + new helper | Give `REELING` an explicit heading = **toward the strut-tip dock** (nose +Z at strut, +Y bridle trailing), held for the entire haul (remove REELING from the prograde/inherited fallback). Add `_tetherPlumeClearOK()` (angle between tether line and active-nozzle axis ≥ `MIN_TETHER_PLUME_DEG`). FEEP (drift-hold + arrest) fires only when true; else reel-only. Attitude slew = reaction-control (no fuel debit). |
| [`ArmUnit._consumeFuel()`](js/entities/ArmUnit.js:5381) | Keep state-rate model; the redock debit is applied **outside** it (discrete), so don't double-charge in DOCKING. Consider zeroing `DOCKING` rate when the debit fires. |
| Catch-cleared-mid-reel guard | In `_updateReeling`, if `capturedDebris` nulled, convert to empty return (mirror [4848](js/entities/ArmUnit.js:4848)). |
| [`Events.js`](js/core/Events.js) | Add `CATCH_SNUGGED`, `REDOCK_ARREST_START`, `REDOCK_FUEL_LOW`. |
| [`HUD.js`](js/ui/HUD.js) / tension bar | Show reel phase (HAUL/RAMP/ARREST) + closing-rate readout so "docking hot" is legible. |
| [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md:239) | Add FEEP role 7 "Re-dock inertia null"; **correct §5.4**: ±15° steering is electrostatic (no moving parts, free); the yoke's role is **tether-plume clearance**, not vectoring. |
| [`CAPTURE_NET.md §4.2`](CAPTURE_NET.md:559) | Reconcile the "FEEP prohibited during reel" lore with the new yoke-clearance rule (FEEP permitted only within the plume-clearance cone). |
| [`CAPTURE_NET.md`](CAPTURE_NET.md) | New §2.4.x "Two-stage retrieval: snug → trapezoidal haul → soft dock"; update §4.5 noting the rigid unit cuts pendulum collapse. |

---

## 5. Tests

- `test-ReelProfile.js` — light catch → `V_CRUISE_MAX`; near-rated → throttled; ramp-down hits `V_DOCK` within `DECEL_DISTANCE_M`; 2 km haul within target band; **in-spec catch never exceeds break strength at full cruise** (protects the snap invariant); boost lockout inside decel.
- `test-CatchSnug.js` — GRAPPLED→SNUG→REELING with rigid `m_unit`; over-strain → recoverable rip; empty reel skips SNUG; `CATCH_SNUGGED` emitted.
- `test-RedockArrest.js` — contact at `≤ SOFT_DOCK_VEL`; debit `∝ m_unit·v_arrest`; low-fuel → `FUEL_FALLBACK_SLOW` (no slam, no dead-end, warning); Mission-1 free pass; no double-charge with `_consumeFuel`.
- `test-Reel-CatchCleared.js` — debris nulled mid-REELING → empty return, FSM not stranded.
- Update constant-speed assertions: [`test-LassoSystem.js:36`](js/test/test-LassoSystem.js:36), [`test-Crossbow-Constants.js:58`](js/test/test-Crossbow-Constants.js:58), [`test-ReelBoost.js:57`](js/test/test-ReelBoost.js:57). Keep RIP/SNAP + Mission-1 clamp coverage.
- Whole suite green (baseline 460/2060/0, [`HANDOFF.md:6`](HANDOFF.md:6)).

---

## 6. Phasing & Tuning

1. **P1 — Trapezoidal haul (Q1) + `m_unit` tension (Q2) + whole-haul reel attitude (Rev-3).** Biggest felt win; give REELING an explicit nose-at-strut heading (also reads better visually). Isolated behind `REEL_PROFILE_V2`. Tune `V_CRUISE_MAX`, `DECEL_DISTANCE_M`, `HAUL_MOTOR_POWER`; verify snap invariant.
2. **P2 — SNUG rigidize (Q3)** + catch-cleared guard + tangle-doc note.
3. **P3 — FEEP soft re-dock (Q4)** + **yoke clearance gate**: `_tetherPlumeClearOK()` + arrest using the P1 reel attitude, abstract debit + fallback (reel-only when clearance/fuel unmet) + Mission-1 free + HUD closing-rate + doc role 7 / §5.4 correction / §4.2 reconcile. (Real-momentum stretch only if chosen.)

Each phase independently shippable; suite stays green.

---

## 7. Edge Cases & Risks

| Item | Handling |
|---|---|
| In-spec catch must never snap | Cruise auto-throttle keeps `T<break`; unit test guards it; only Boost may exceed |
| Player slams dock with Boost | Boost lockout inside `DECEL_DISTANCE_M` |
| Point-blank / very short reel | Skip cruise → ramp-down; existing `moveDistance≥dist` snap terminates |
| Heavy catch / low motor power | `V_DOCK` + `T_MIN` floors prevent stall |
| Detached arm (no tether) | No REELING/arrest; existing GRAPPLED→DEORBITING ([4246](js/entities/ArmUnit.js:4246)) / RETURNING→TRANSIT ([4715](js/entities/ArmUnit.js:4715)) unchanged |
| Catch destroyed/removed mid-reel | Convert to empty return (mirror [4848](js/entities/ArmUnit.js:4848)) |
| Over-rated catch at SNUG | Recoverable net-rip via `_checkNetIntegrityOnReel` |
| Fuel can't cover arrest | `FUEL_FALLBACK_SLOW`: slow zero-fuel finish + warn; Mission-1 free |
| Double fuel charge (debit + DOCKING rate) | Zero `DOCKING` rate (or skip debit) so it's charged once |
| Mother maneuvering during dock | Arrest targets the **recomputed** strut-tip `dockWorldPos` each frame (already frame-aware) |
| Save/load mid-reel | Profile stateless (derived from distance+payload) → no schema change |
| Yoke/gimbal not real | **Yoke = tether-plume clearance** (not vectoring). Must be modelled (clearance test + reel attitude) for FEEP-during-reel; else reel-only fallback. Vectoring itself is free (electrostatic). |
| Brake plume on tether side | Fore-nozzle (+Z) brake fires toward mother = tether side; **whole-haul reel attitude** (nose +Z at strut, +Y bridle trailing) + `_tetherPlumeClearOK()` gate keep the cable ≥ `MIN_TETHER_PLUME_DEG` off the plume axis, else no FEEP (reel-only; no §4.2 ablation simulated) |
| Reel attitude vs moving strut | Heading recomputed each frame toward the live strut-tip `dockWorldPos`; slew `REEL_ATTITUDE_SLERP`. Mother maneuvering / boost / short reel all tolerated (slew tracks; clearance re-tested each frame) |
| Inertia hidden by frame-correction/pin | Abstract debit chosen → no re-architecture; real-momentum is the riskier stretch (open question) |

---

## 8. Resolved Decisions

1. **Reel speed (Q1):** trapezoidal velocity profile. ✓
2. **Inertia fidelity (Q4):** abstract mass-scaled fuel debit (not real residual-momentum). ✓
3. **Yoke clearance:** geometric clearance test + reel attitude; reel-only fallback when clearance unmet; **no** ablation→snap simulation. ✓
4. **Reel attitude span:** held for the **whole reel-in haul** (nose +Z at strut, bridle trailing), not just the arrest window. ✓
5. **FEEP vectoring:** electrostatic ±15° (no moving parts, free); yoke's role is **tether-plume clearance**, not vectoring — docs to be corrected. ✓
6. **Deliverable:** design-doc sections + code/constants/test plan. ✓

No open questions remain — plan ready for implementation.

