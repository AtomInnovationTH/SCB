# As-built: First-mission tease cluster — appearance, placement, pin & net fixes

> **Status:** Implemented & shipped. This started as "pin the tease debris ahead of the
> mother" and grew, through playtest feedback, into a full rework of how the Mission‑1
> welcome cluster looks, is placed, is captured, and is kept stable. This document is the
> **as‑built** record (it supersedes the original single‑pin plan).

Primary code: `js/entities/DebrisField.js` (`WELCOME_FIELD`, `_spawnWelcomeField`,
`update`, `_updateInstanceTransform`, `_clearOnboardingPin`), `js/systems/TargetSelector.js`,
`js/systems/LassoSystem.js`, `js/systems/CollisionAvoidanceSystem.js`, `js/ui/TargetReticle.js`.
Design context: `.kilo/plans/new-player-onboarding-flow.md` (Phase 1/2 — partly superseded by
the appearance decision below).

---

## Symptoms reported during playtest (in order), and the fix each drove

1. **"Debris drifts out of view in ~2 s; the mother passes it."**
   Cause: `CollisionAvoidanceSystem` fired silent RCS dodges against the welcome cluster
   (the only thing it can see on M1), shoving the mother off station. → **CA exemption.**
2. **"Don't see debris in front."** The first pin captured its offset from
   `debris.orbit.trueAnomaly`, which still had the one‑frame `_frameComp` subtracted (~km
   arc), freezing the piece far behind. → **steady‑state offset.**
3. **"In front, but not selected/selectable and drifting."** Split brain: the pin set only
   `_scenePosition` while selection/targeting read the **orbit**. → **single source of
   truth = `_scenePosition`.**
4. **"Target too massive for Mother net. Try deploying a Daughter [D]."** Welcome masses
   (8–180 kg) exceeded `LASSO_MAX_CAPTURE_MASS = 10`, but M1 onboarding is **net‑only**.
   → **clamp welcome masses ≤ 10 kg (in data + spawn).**
5. **"They look like high‑value satellites."** The spawn reuses a debris' existing
   instanced‑mesh slot (it does **not** rebind geometry), so the rendered shape is the
   *candidate's* original shape — box `defunctSat`/`rocketBody` read as satellites.
   → **prefer `fragment` candidates (icosahedron junk) + visible `sizeM`.**
6. **"#1 dead centre, #2 to one side, #3 other side & out of range."**
   → **mother‑local‑frame pin (forward + lateral); #3 free out‑of‑range.**
7. **"OUT OF RANGE shows too long / when in range."** → **brief flash, cleared in range.**
8. **"Net fired 180° the wrong way!"** The net's in‑flight homing (`_getLiveTargetPos`)
   still read the **orbit**, which is **frozen** for pinned pieces → it chased the stale
   spawn point the mother had already flown past. → **homing prefers `_scenePosition`.**

---

## As‑built design

### Single source of truth: `_scenePosition`
Every consumer that needs "where is this debris in the scene" reads `debris._scenePosition`
(set each frame by `DebrisField._updateInstanceTransform`). The orbit is a fallback only.
- `TargetSelector.getActiveTargetPosition()` — prefers `_scenePosition` (was orbit).
- `LassoSystem._getDebrisScenePos` (fire) and `_getLiveTargetPos` (flight homing) — both
  prefer `_scenePosition`. The flight one was the straggler that caused the 180° bug.
- `AutoLockController` (`getDebrisNear` + `_trackRange`) already use `_scenePosition`.

For normal debris `_scenePosition` equals the orbit position, so these are no‑ops there.

### Appearance — low‑value junk, visible
- `_spawnWelcomeField` candidate selection **prefers `fragment`‑type** debris (rendered as
  irregular icosahedron = junk), then other far debris, then any. Rationale: the spawn does
  not rebind the instanced‑mesh slot, so the rendered shape is the candidate's original.
- All `WELCOME_FIELD` rows are `types: ['fragment']`; the `solar_cell` paint was removed.
- `sizeM` is a **deliberate** size override that **bypasses the per‑type sizeMax cap**, so a
  fragment renders as a clearly visible chunk (#1 ≈ 3 m, #2/#3 ≈ 2.4 m) instead of a speck.

### Net‑catchable — M1 is net‑only
- Every `WELCOME_FIELD` mass is authored ≤ `LASSO_MAX_CAPTURE_MASS` (10 kg). The spawn also
  clamps `debris.mass` to that ceiling as a belt‑and‑suspenders guard if the constant moves.
- There is **no Daughter beat** in M1 onboarding (`tease_lock`→N, `second_catch`→N,
  `range_wall`→A then net, `free_clear`→net the rest), so the whole cluster must be netable.

### Placement — mother‑local frame
Co‑orbital elements **cannot** hold a constant sideways offset (cross‑track oscillates to
zero), so the pinned pieces are placed in the mother's local frame, recomputed each frame:
- Basis (once per frame in `update()`): `fwd = normalize(velocity)`,
  `radial = normalize(playerPos)`, `right = normalize(fwd × radial)`. Stored on
  `this._motherFwd` / `this._motherRight` (only when a pin is active).
- `_updateInstanceTransform` pin branch: `_scenePosition = playerPos + fwd·fwdM + right·latM`.
- Spec fields for pinned pieces: `pin: true`, `fwdM`, `latM` (metres → scene via `METRE_SCENE`).
- The **first three** pieces are forced ahead (prograde, inside AutoLock's forward arc);
  only #4+ alternate ahead/behind for spread (`sign = (i < 3) ? 1 : …`).

Resulting layout:
| Piece | What | Placement | Pinned? |
|------|------|-----------|---------|
| #1 TEASE | 3 m fragment, 6–8 kg | 30 m **dead centre**, in net range | yes (local frame) |
| #2 | 2.4 m fragment, 8–10 kg | 65 m fwd + 45 m lateral (≈79 m, in range, in arc) | yes (local frame) |
| #3 RANGE WALL | 2.4 m fragment, 7–9 kg | ~130–180 m ahead, **out of net range** | **no** — free co‑orbital orbit (the autopilot approach target; a local‑frame pin would run away from the closing ship) |
| #4–#7 | fragments ≤10 kg | orbital `offsetMin/Max`, alternating spread | no |

> #3 is intentionally **centred** (not offset to the far side). It must be a real fixed orbit
> so Autopilot can fly to it; a lateral pin would recede from the approaching ship and an
> orbital cross‑track oscillates. Centred‑and‑out‑of‑range still teaches the range wall.

### Pin lifecycle (`DebrisField`)
- `this._onboardingPinIds : Set` — ids of all currently pinned pieces.
- Per debris: `_onboardingPinned`, `_onboardingPinFwd`, `_onboardingPinLat` (all initialised
  on **every** debris in `_createDebrisData`/`_finaliseRealDebris` so the hot‑path read stays
  a single hidden class).
- Pinned pieces **skip propagation** in `update()` (their orbit is a frozen fallback).
- `_clearOnboardingPin(id?)` — release one piece (by id) or all.
- Release wiring: `ARM_CAPTURED` (arm secures it — fires before `DEBRIS_CAPTURED`, so the
  authoritative arm pin takes over), `DEBRIS_REMOVED` (the reliable "tease consumed" signal —
  the Mother‑net/lasso path emits this, **not** `DEBRIS_CAPTURED`), `ONBOARDING_COMPLETE`,
  `GAME_RESET`, `MISSION_START`. Released **per id**, so catching #1 doesn't unpin #2.
- A *missed* shot leaves the piece pinned for unlimited retries.

### Collision avoidance — mission‑scoped exemption
`CollisionAvoidanceSystem._scanForThreats`: `if (debris.welcomeSpawn && this._missionNumber <= 1) continue;`
Removes the silent ship‑lurch on M1 without leaving surviving welcome pieces invisible to CA
in later missions.

### OUT OF RANGE — brief feedback (`TargetReticle`)
The reticle still turns yellow while genuinely out of range (honest state), but the big
"OUT OF RANGE" **text** is a brief flash: `_outOfRangeFlashT` is set (`_outOfRangeFlashDur`
≈ 1.6 s) only on the in→out crossing, fades over its last 0.5 s, and is cleared immediately
on `TARGET_IN_RANGE` and on target select/clear — so it never shows while in range.

---

## Invariants / gotchas for future work
- **Read `_scenePosition`, not the orbit**, for any "where is the locked/target debris"
  query — pinned pieces have a frozen orbit. The 180° net bug was exactly this.
- Pinned pieces must stay **inside the forward arc** (`fwd/dist ≥ 0.5`) and **< `NET_LOCK_RANGE_M`**
  (90 m) to remain auto‑lockable and net‑catchable from station (#1 = 30 m, #2 ≈ 79 m).
- Changing a welcome piece's `type`/`material` in the spec affects **salvage only**, not the
  rendered shape (no mesh rebind) — control appearance via **candidate type preference**.
- Don't pin #3 (or any autopilot‑approach target): a mother‑relative pin recedes from the
  closing ship.

## Tests
- `js/test/test-WelcomeField.js` — fragment/junk + ≤10 kg net‑catchable; two pieces pinned
  (#1 centre `latM = 0`, #2 farther + lateral); local‑frame offsets independent of spawn‑frame
  dt; in‑range + forward‑arc invariants; per‑id release.
- `js/test/test-CollisionAvoidance.js` — `welcomeSpawn` debris is exempt on M1.
- `js/test/test-LassoSystem.js` — `_getLiveTargetPos` prefers live `_scenePosition` (the 180°
  regression), orbit fallback only when absent.
- Full suite: `node js/test/run-tests.js` (3189 passing at time of writing).
