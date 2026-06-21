# Plan: Make Mission-1 welcome debris #1 and #2 clearly visible

> Playtest feedback: "Debris 1 is NOT visible — too small/far/dim. 1 and 2 must be visible."
> The new Ctrl+D welcome-debris diagnostics confirm #1 renders ~0.34 m at 30 m (a ~12 px speck).

## Root cause (verified in code + history)

The first-mission cluster is the curated `WELCOME_FIELD` (`js/entities/DebrisField.js:227`).
Pieces #1/#2 are *pinned* in the mother's local frame (`_spawnWelcomeField` → per-frame
`_updateInstanceTransform` pin branch). Their on-screen size is governed by:

- **Render size** = geometry bounding radius (normalised 0.95, ×1.3 in `DebrisWireframe.getGeometry`,
  `js/ui/DebrisWireframe.js:1090`) × `sceneSize` (`sizeMeter × 1e-5`). Net result the team
  documents as **render ≈ 1.9 × `sizeMeter`** (metres).
- **`sizeM`** overrides: #1 = `0.18` (render ~0.34 m), #2 = `0.30` (render ~0.57 m)
  (`js/entities/DebrisField.js:256-259`).
- **Distance**: #1 pinned 30 m ahead (`fwdM:30, latM:0`); #2 ~69 m (`fwdM:65, latM:25`).

At FOV 55° (`Constants.CAMERA_FOV`) the mother core is 2.0 m long
(`PlayerSatellite.js:455`). A 0.34 m chunk at 30 m subtends ~12 px; #2 (~0.57 m at 69 m)
~7 px and additionally **dim** (shared material `emissiveIntensity: 0.06`,
`DebrisField.js:1018`).

### Why it's this small on purpose (the tension to respect)

`.kilo/plans/onboarding-tease-2-lateral-tune.md` deliberately shrank fragments from
~3 m to sub-metre to enforce a **physical hierarchy invariant**: *a `fragment` must never
render larger than the ~2 m mother / a ~1 m whole satellite*. This is **test-locked**:
`js/test/test-WelcomeField.js:434` asserts every welcome `sizeMeter < 1.1`.

That same plan's **Decision D3 explicitly anticipated this feedback**:
> "#1 anchor: literal daughter (`sizeM 0.18`, ~0.34 m). **Tunable in playtest (bump to
> ~0.25 or pull #1 to ~25 m if it reads too small).**"

So this is a sanctioned tuning pass, not a redesign. We stay under the `< 1.1` cap.

## Findability already exists (context, not the fix)

`TargetReticle` brackets every welcome piece within 2 km (`getDebrisNear`, M1-clamped),
so a HUD bracket already floats on #1/#2. The complaint is that the **object itself** is an
invisible speck inside that bracket. The fix must make the rendered mesh bigger/closer/brighter.

---

## Approach — tune SIZE + DISTANCE (+ optional BRIGHTNESS), keep all invariants

Three levers, all within the documented constraints:

### 1. SIZE (stay < 1.1 m cap → still smaller than the 2 m mother)
`js/entities/DebrisField.js:256-259`:
- **#1** `sizeM: 0.18 → 0.60` (render ~1.15 m; was ~0.34 m)
- **#2** `sizeM: 0.30 → 0.70` (render ~1.33 m; was ~0.57 m)

Both render clearly under the 2 m mother (hierarchy preserved) and pass `sizeMeter < 1.1`.

### 2. DISTANCE (pull the pins closer; keep net-range + forward-arc invariants)
`js/entities/DebrisField.js:256-259`:
- **#1** `fwdM: 30 → 22`, `latM: 0` (unchanged, dead-centre)
- **#2** `fwdM: 65 → 45`, `latM: 25 → 18` (stays right-of-centre, on-screen, in arc)

Resulting apparent size (FOV 55°, ~900 px tall viewport):
- #1: ~1.15 m / 22 m ≈ **~54 px** (was ~12 px)
- #2: ~1.33 m / √(45²+18²)=48 m ≈ **~26 px** (was ~7 px)

Invariants still satisfied:
- Net range (`dist < 90 m`): #1 = 22 m, #2 = 48 m. ✓ (`test-WelcomeField.js:292`)
- Forward arc (`fwdM/dist ≥ 0.5`): #1 = 1.0, #2 = 45/48 = 0.94. ✓ (`:293`)
- `#2 fwd > #1 fwd`: 45 > 22. ✓ (`:270`)

### 3. BRIGHTNESS — per-instance (CONFIRMED: included)
The shared material is dim by design (real debris is sun-lit only). To guarantee #1/#2
catch the eye even on the shadow side, brighten **just those instances** via the existing
per-instance colour channel (`setColorAt`, already used by the web-shot tint at
`DebrisField.js:1931`). In `_spawnWelcomeField`, after `welcomeSpawn = true`, for the two
pinned pieces set `instanceColor` to a boosted near-white (e.g. `1.5, 1.5, 1.5`) and flag
`instanceColor.needsUpdate`. Isolated to #1/#2; no shared-material/emissive change.

---

## Files to change

1. **`js/entities/DebrisField.js`** (`WELCOME_FIELD`, lines 256-259) — the four spec edits
   above (#1 `sizeM`/`fwdM`; #2 `sizeM`/`fwdM`/`latM`). Update the inline `// #1`/`// #2`
   distance/size comments to match.
2. *(Lever 3 — confirmed)* **`js/entities/DebrisField.js`** (`_spawnWelcomeField`, after
   `debris.welcomeSpawn = true;` ~line 2279) — per-instance brightness boost for pinned pieces.
3. **`js/test/test-WelcomeField.js`** — update the locked pin constants to the new values:
   - `:265` `#1 _onboardingPinFwd == 30*ms` → `22*ms`
   - `:268` `#2 _onboardingPinFwd == 65*ms` → `45*ms`
   - `:280-281` `#1 fwd == 30*ms` → `22*ms`
   The invariant tests (`:292` net range, `:293` forward arc, `:434` sub-metre) stay green
   unchanged. `latM>0` (`:269`) still holds (18 > 0).

## Out of scope / unchanged
- #3–#7 placement/size (diagnostics overlay now lets us tune them later if needed).
- `discovered` gating: #1 stays pre-discovered, #2 stays scan-to-discover. The *mesh*
  renders regardless of `discovered`, so enlarging #2 makes the object visible without
  changing the scan-teaching beat.
- Pin lifecycle, CA exemption, reticle flash logic, public `spawnWelcomeField` planner,
  the `< 1.1` hierarchy invariant, and the reward-by-value progression.

## Verification
- `node js/test/run-tests.js` green (after updating the three pin constants).
- Playtest: clear `localStorage['spacecowboy_onboarding_v1']`, start M1, press **Ctrl+D**:
  - #1 reads clearly dead-centre and net-catchable with **N**; visibly smaller than mother.
  - #2 visible to the right, in range.
  - Diagnostics show #1 `~22m`, #2 `~48m`, both `✓vis ... LOD:full`, #1 `net✓`, #2 `net✓`.

## Decisions (resolved)
- **Approach: Size + distance + brightness** (recommended) — confirmed by user.
- Size: #1 `sizeM 0.18→0.60`, #2 `0.30→0.70` (both < 1.1 cap).
- Distance: #1 `fwdM 30→22`; #2 `fwdM 65→45`, `latM 25→18`.
- Brightness: per-instance `instanceColor` boost (~1.5×) on #1/#2 only (lever 3).
