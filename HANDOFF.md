# Space Cowboy — Next-Shift Handoff Brief

*Updated: 2026-05-29 · Streamlined from 1668 → ~800 lines (doc consolidation sprint). Heritage moved to archive — see [§7 Active Docs Index](#7-active-docs-index). Prior multi-shift handoffs archived to [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md), [`archive/SK_M1_POLISH_HANDOFF.md`](archive/SK_M1_POLISH_HANDOFF.md), [`archive/CEREMONY_REDESIGN.md`](archive/CEREMONY_REDESIGN.md).*

---

## 1. Current Shift Status (2026-05-28 → 29)

### 1.1 Post-Cinch-Fix QA Pass (2026-05-28 — Items 1-3, 5, 7-9 shipped; 4, 6, 10, 11 design-only)

> **9 of 11 QA items resolved.** Tests **2316 → 2320** (+4, mutation-verified). Grep-clean. Item 4 (end-of-ceremony pose) skipped per user direction. Items 6, 10, 11 design content folded into permanent homes during the 2026-05-29 doc consolidation pass — see §6.1 below.

#### Shipped (code changes)

| # | Item | Files | Tests added |
|---|------|-------|-------------|
| 7 | Reticle range font 2× (10/11/9 → 20/22/18 px, baselines re-spaced) | [`TargetReticle.js:860-908`](js/ui/TargetReticle.js:860) | — |
| 8 | Empty-net comms feedback (NET_EMPTY_CLICK + COMMS warning in both `captureFromStationKeep` AND `manualNetDeploy`) | [`ArmUnit.js:1230-1260, 3086-3110`](js/entities/ArmUnit.js:3086) | — |
| 9 | R = reel-in (always); forge moves to K ("Kiln"). 6 sites: [`InputManager.js:701`](js/systems/InputManager.js:701), [`Constants.js:1683`](js/core/Constants.js:1683), [`StatusPanel.js:385, 1719`](js/ui/hud/StatusPanel.js:385), [`ForgeSystem.js:57`](js/systems/ForgeSystem.js:57), [`README.md:18`](README.md:18) (3×) | 6 sites | — |
| 2 | Net visual stays visible during REELING (`eff = tetherPaidOut × (1 − reelProgress)` blends contact-pos → arm-pos as net reels in) | [`CaptureNet.js:263-294`](js/entities/CaptureNet.js:263) | +4 (mutation-verified — see [`test-CaptureNet.js:1790-1860`](js/test/test-CaptureNet.js:1790)) |
| 1 | Cinch ring clears debris leading edge (`CONE_LENGTH_FRAC: 0.55 → 0.85`, gap past target D×0.05 → D×0.35). Camera CINCH lookAt 0.55→0.85, BRAKE_ENVELOP midpoint 0.275→0.425 | [`Constants.js:1357-1370`](js/core/Constants.js:1357), [`CameraSystem.js:1603-1624`](js/systems/CameraSystem.js:1603) | +1 (D×0.2 gap pin — [`test-CaptureNetVisual.js:798-836`](js/test/test-CaptureNetVisual.js:798)) |
| 3 | Captured-debris LOD skip during REELING/HAULING/DOCKING (was only skipping for SK targets; debris pinned to arm got LOD-zeroed when mother > 50 km away) | [`DebrisField.js:1271-1283`](js/entities/DebrisField.js:1271) | — (THREE-dep) |
| 5 | Spin-rate physics doc comment block (`SPIN_HZ` 2/4/6 Hz → 47.4/78.9/16.0 N per weight; comfortably above 5-10 N mouth-open threshold) | [`Constants.js:1230-1248`](js/core/Constants.js:1230) | — |

#### Deferred to design — now folded into canonical homes

- **Item 4** — end-of-ceremony "child holding balloon" pose — explicitly skipped per user priority. Metaphor preserved in [`GAME_DESIGN.md §2.1`](GAME_DESIGN.md:48) for future camera/visual work.
- **Item 6** — Apex-hub keepsake — folded into [`GAME_DESIGN.md §4.1 First-Clear Keepsake`](GAME_DESIGN.md:108).
- **Item 10** — First-clear directive comms — folded into [§4.9.2 #6 below](#492-proposed-redesign--6-concrete-improvements).
- **Item 11** — Forge chunking — folded into [`GAME_DESIGN.md §4.0 Forge v2`](GAME_DESIGN.md:108).

#### Key references for next shift

- World-frame cinch invariant tests at [`test-CaptureNetVisual.js:824-923`](js/test/test-CaptureNetVisual.js:824) + D×0.2 gap pin at [`test-CaptureNetVisual.js:798-836`](js/test/test-CaptureNetVisual.js:798) are the regression floor for any cone-geometry tuning.
- 4 new REELING position-sync tests at [`test-CaptureNet.js:1790-1860`](js/test/test-CaptureNet.js:1790) pin the `tetherPaidOut × (1 − reelProgress)` formula.
- **K is the new forge key. R is the new reel-in key.** If you reintroduce R for any other purpose, fold it into the SK-vs-anything-else conditional or pick another letter.
- `CONE_LENGTH_FRAC = 0.85` and the CameraSystem `0.85`/`0.425` lookAt offsets MUST stay in sync. Both flagged in their respective comments.

#### Possible follow-up — BRAKE_ENVELOP camera framing

Bumping `CONE_LENGTH_FRAC` 0.55 → 0.85 widens the cone by ~55%. The ENVELOP weight sweep now travels `z=−0.85 D_M` to `−1.7 D_M` (was `−0.55` → `−1.1`). The BRAKE_ENVELOP camera position `(side 1.5, fwd 0.6, up 0.5) × D_M` was tuned for the OLD cone depth — endpoint is `~0.45 D_M` further from lookAt. If user reports "weights pop out of frame near end of ENVELOP", retune to `side: 2.0, fwd: 1.0`. Existing soft-pin test at [`test-NetCinematic.js:666`](js/test/test-NetCinematic.js:666) still passes.

### 1.2 Doc Consolidation Pass (2026-05-29)

> 35 root-level `.md` files → 16 canonical + active-reference. ~19 docs moved to `archive/`. HANDOFF.md streamlined 1668 → ~800 lines. POST_CINCH_QA_DESIGN_DOCS content folded into [`GAME_DESIGN.md`](GAME_DESIGN.md:1) and [§4.9 below](#49-onboarding-flow-tutorial--skills--discovery-pane). Full audit table in [§7](#7-active-docs-index).

---

## 2. THREE.js Convention SSOT (2026-05-27 — Load-Bearing)

> **READ BEFORE TOUCHING ANY ORIENTATION / ROTATION CODE.** A single-character convention bug at [`CaptureNetVisual.js:952`](js/ui/CaptureNetVisual.js:952) made the capture-net cinch render on the DAUGHTER side of the debris for the entire life of the ceremony visual. Multiple sessions worked AROUND the bug without seeing it because every prior test inspected only LOCAL coordinates — never `getWorldPosition()`. Diagnosed via `NET_CINEMATIC_DEBUG`-gated instrumentation + a live capture log.

### Rule 1 — `Object3D.lookAt` and `Camera.lookAt` use OPPOSITE conventions

```js
// three.js Object3D.js line 266
if ( this.isCamera || this.isLight ) {
    _m1.lookAt( _position, _target, this.up );   // ← Camera: local -Z = forward
} else {
    _m1.lookAt( _target, _position, this.up );   // ← Object3D: local +Z = forward
}
```

| Receiver type | After `obj.lookAt(target)`, local **forward** axis is... |
|---|---|
| `Camera`, `Light` | local **−Z** points TOWARD `target` (OpenGL camera convention) |
| `Object3D`, `Group`, `Mesh` | local **+Z** points TOWARD `target` |

**Pre-flight checklist before calling `.lookAt(point)`:**
1. Is the receiver a `Camera`/`Light`? Local −Z = "forward" (faces target).
2. Is the receiver a `Group`/`Mesh`? Local **+Z** = "forward" (faces target).
3. Does your geometry's "front face" axis match the receiver's convention?
4. If a Group must have its **mouth on local −Z** (most "cone-shaped" geometry naturally builds toward), pass `lookAt(position − dir × ε)` — NOT `+`. Object3D rotates so local +Z = `−dir`, hence local −Z = `+dir`, hence the mouth points along `dir`.

### Rule 2 — `Matrix4.lookAt(eye, target, up)` — z = `eye − target`

When you build rotation manually with `mat.lookAt(eye, target, up)` and apply via `quaternion.setFromRotationMatrix`:
- The matrix's local **+Z** in world = `(eye − target).normalize()` ⇒ points AWAY from `target`, TOWARD `eye`.
- `local +Z = forward` is **always** the convention for the resulting quaternion (receiver-type branching is `Object3D.lookAt`-only, not `Matrix4.lookAt`).

Codebase examples (all consistent, intent-explicit):
- [`ArmUnit.js:2062`](js/entities/ArmUnit.js:2062): `mat.lookAt(pos+heading, pos, radial)` ⇒ matrix +Z = `heading`.
- [`AutopilotSystem.js:1035`](js/systems/AutopilotSystem.js:1035): `mat.lookAt(pos+wDir, pos, radial)` ⇒ matrix +Z = `wDir`.
- [`PlayerSatellite.js:3301`](js/entities/PlayerSatellite.js:3301): `mat.lookAt(pos+vel, pos, radial)` ⇒ matrix +Z = `velDir`.
- [`ActiveSatellite.js:257`](js/entities/ActiveSatellite.js:257): `mat.lookAt(pos, pos+vel, radial)` ⇒ matrix +Z = `−velDir` (sat body uses −Z forward).

**When using `Matrix4.lookAt` directly: declare what your mesh's "default forward" axis is (named constant), and pass eye/target in the order that aligns matrix +Z with that intent.**

### Rule 3 — Scene units: `M = 1e-5` everywhere

- **1 metre** = `M = 1e-5` scene units. **1 scene unit** = **100 km**.
- Entity `position` fields (`NetProjectile.position`, `ArmUnit.position`, `_scenePosition`, `target._scenePosition`) are in **metres**.
- Object3D `position` (`mesh.position`, `group.position`) is in **scene units**.
- The conversion happens at the boundary: `group.position.set(net.position.x * M, net.position.y * M, net.position.z * M)`.
- If you see an unexpected `1e+5` or `* M` factor, suspect a unit-frame mismatch.

### Rule 4 — Default geometry axes & how to align them

| Geometry | Default symmetry axis | To align with launchDir / forward |
|---|---|---|
| `ConeGeometry(r, h)` | Y (apex at +Y, base at −Y) | `geo.rotateX(PI/2)` ⇒ apex at +Z, base at −Z |
| `CylinderGeometry(r1, r2, h)` | Y | `geo.rotateX(PI/2)` ⇒ axis along Z |
| `TorusGeometry(r, t)` | normal = +Z (ring in XY plane) | typically no rotation; `rotateX(PI/2)` rotates ring into YZ plane |
| `PlaneGeometry(w, h)` | normal = +Z | no rotation for billboarded sprites |
| `SphereGeometry` | (radially symmetric) | rotation immaterial |

`geo.rotateX(PI/2)` and `geo.translate(x, y, z)` mutate the GEOMETRY (vertex positions) — applied once at construction. The Object3D's `.rotateX(angle)` rotates the OBJECT (frame-relative), which IS affected by later quaternion changes.

### Rule 5 — Quaternion setters: always with named source/target constants

`setFromAxisAngle(axis, angle)` and `setFromUnitVectors(from, to)` have no hidden sign behavior IF the source vectors are explicit. Codebase convention is to declare them as module-scope constants:

```js
const _armForward  = new THREE.Vector3(0, 0, 1);  // PlayerSatellite.js:40
const _strutFrom   = new THREE.Vector3(0, -1, 0); // PlayerSatellite.js:33
const _yUpCollar   = new THREE.Vector3(0, 1, 0);  // PlayerSatellite.js:521
```

Then `_armQuat.setFromUnitVectors(_armForward, sg.strutDir)` reads as "rotate the arm's local +Z forward to point along strut direction." Self-documenting. **Don't inline raw `new THREE.Vector3(0, 0, 1)` calls.**

### Diagnostic workflow (re-usable for any visual-vs-physics frame mismatch)

1. Add `globalThis.<FLAG>`-gated `console.log` at suspected frame-conversion sites.
2. Enable in browser console BEFORE the relevant event: `globalThis.<FLAG> = true`.
3. Capture log with one repro.
4. Compare predicted vs observed numerical values — look for sign flips, magnitude mismatches, unit-scale errors.
5. Locate the conversion site that produces the wrong sign/magnitude. Apply fix.
6. **Mutation-test the regression:** revert the fix, run tests, confirm they FAIL with localized error messages. Then re-apply.
7. Remove ALL instrumentation. Grep-clean: `grep -RIn '<FLAG>\|TEMP gated\|_dbg<...>' js/` should return only doc references.
8. Add a SSOT note here if a new convention is established or clarified.

### Files most likely to be touched by future orientation/rotation work

- [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) — cone build at line 291–301, lookAt at line 919–956, ENVELOP/CINCH placements at line 740, 770, 825.
- [`CaptureNet.js:263-274`](js/entities/CaptureNet.js:263) — post-FLIGHT position sync.
- [`CameraSystem.js:1430-1730`](js/systems/CameraSystem.js:1430) — NET_CINEMATIC beat positions + lookAt offsets.

---

## 3. Post-Cinch-Fix Learnings (2026-05-28 — Rules A-E, Load-Bearing)

*Companion SSOT to §2 THREE.js Conventions. Captured during the post-cinch QA shift that shipped Items 1-3, 5, 7-9.*

### Rule A — Hotkey rebinding requires ≥ 6 sites of audit

When changing a hotkey binding, search ALL six site categories before claiming "done":

1. [`InputManager.js`](js/systems/InputManager.js:1) handler (the binding itself)
2. [`Constants.js`](js/core/Constants.js:1) SkillsSystem definitions (`SKILLS.*.key`)
3. [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) inline HUD labels (`[X]`)
4. [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) idle-state hints (`Press [X] to ...`)
5. Module-level docstrings in the affected system
6. [`README.md`](README.md:1) — controls summary AND systems paragraph AND key-bindings table (3 sites in README alone)

The Item 9 R→K swap initially landed with 4 sites; self-audit found 2 user-visible misses ([`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) cargo hint + [`ForgeSystem.js`](js/systems/ForgeSystem.js:1) docstring). Total: 6.

### Rule B — When extending FSM-state coverage, audit ALL conditional blocks for that FSM

Item 2 bug: [`NetProjectile.update()`](js/entities/CaptureNet.js:1) had a post-FLIGHT position-sync guarded by `state === CONTACT || BRAKE || ENVELOP || CINCH_CLOSING || SECURE_CHECK`. A misleading comment claimed "REELING has its own position logic", but `_updateReeling` only updated `reelProgress` (a 0→1 scalar), not position. Pattern:

```js
// AVOID — easy to forget one state when adding REELING:
if (state === A || state === B || ...) { /* sync */ }

// PREFER — canonical set lookup, single source of truth:
if (POST_FLIGHT_STATES.has(state)) { /* sync */ }
```

When adding a new state to a FSM, search for ALL conditional blocks enumerating sibling states. Misleading "this state has its own logic" comments are a red flag — verify the claim.

### Rule C — Visual geometry constants couple to camera offsets

Bumping [`CONE_LENGTH_FRAC`](js/core/Constants.js:1) 0.55 → 0.85 (Item 1) required matching updates at two hard-coded sites in [`CameraSystem.js`](js/systems/CameraSystem.js:1) (`0.275 → 0.425` for BRAKE_ENVELOP midpoint; `0.55 → 0.85` for CINCH lookAt). Both are mathematically derived from `CONE_LENGTH_FRAC × CONE_OPEN_RADIUS_FRAC × D_M` but hard-coded as numeric literals.

**Options:** (a) read the constant lazily in the lookAt function, or (b) bullet-comment the coupling at BOTH ends (current approach — both sites reference `Constants.CAPTURE_NET.NET_CEREMONY.CONE_LENGTH_FRAC` in comments and explicitly note 2026-05-28 Item 1 tuning).

### Rule D — LOD guards must enumerate all "actively engaged" debris states

Item 3 bug: [`DebrisField._updateInstanceTransform`](js/entities/DebrisField.js:1) had `if (!debris._isStationKeepTarget) { ...LOD downscaling... }`. This missed captured debris (`_capturedByArm` set) — they got LOD-zeroed during REELING/HAULING/DOCKING because the mother was > 50 km away.

**Pattern: any "user is engaged with this debris" predicate must be a function over multiple flags, not a single field.** Future-proof variants — debris-being-trawled, ablated, lassoed — will need adding here. Candidate refactor: `_isUserEngaged(debris)` helper that ORs all relevant flags.

### Rule E — Empty-action feedback needs all 3 components

User-visible failure of an action requires all three:

1. The gameplay event (e.g. [`Events.NET_EMPTY_CLICK`](js/core/Events.js:1))
2. The audio cue ([`audioSystem.playClickFail()`](js/systems/AudioSystem.js:1))
3. The on-screen comms message ([`Events.COMMS_MESSAGE`](js/core/Events.js:1) warning)

Item 8 had only (1) and (2) — user heard a click-fail but had no on-screen explanation. Pattern landed in BOTH [`ArmUnit.captureFromStationKeep`](js/entities/ArmUnit.js:1) AND [`ArmUnit.manualNetDeploy`](js/entities/ArmUnit.js:1). Any new "action denied / inventory empty / out of charge" failure path needs all 3 components.

### Cross-rule diagnostic workflow

When the user reports a visual symptom (e.g. "X is invisible during state Y"), walk the visual pipeline in order — five places visibility can be silently broken:

1. **Position** — being POSITIONED correctly? (FSM-state position sync — Rule B)
2. **Scale** — being SCALED correctly? (LOD downscale — Rule D)
3. **Lifecycle** — being REMOVED prematurely? (state-transition cleanup)
4. **Camera framing** — is the CAMERA actually showing it? (offsets + lookAt — Rule C)
5. **Feedback** — user expected feedback but got none? (empty-action 3-component — Rule E)

The "net+debris invisible during reel-in" symptom (Items 2 + 3) collapsed into TWO independent root causes (position freeze + LOD zero); identifying both required walking the pipeline from position → scale rather than stopping at the first finding.

### Verify before push

```bash
grep -RIn 'NET_CINEMATIC_DEBUG\|\[NETSTATE\]\|\[NETVIS\]\|TEMP gated\|_dbg<' js/ | grep -v '//.*ref\|comment'
# (only doc references should remain)

node js/test/run-tests.js | tail -3
# Must show 2320 / 2320 (do not regress below 2316 baseline floor)
```

---

## Q2 — Net-Launch Ceremony Redesign (2026-05-24 — Shipped)

- **Status:** Shipped. [`FEATURE_FLAGS.NET_CEREMONY`](js/core/Constants.js:432) default **ON**.
- **Tests:** 2207 → **2281** (+74).
- 6 stages, all behind a feature flag during development; flipped to default-ON in Stage 6 after eye-validation.
- New geometry (cone + weights + drawstring + apex hub), `NET_CINEMATIC` camera mode with 7 beats (full first deploy) / 3 beats (highlights-cut on repeat), per-beat time-dilation (0.3×–0.6×), first-deploy persistence gating via [`persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY')`](js/systems/PersistenceManager.js:172).
- Orbital state proven not to diverge under slo-mo (bitwise-equal Keplerian elements at 0.3× over 5 s — [`test-NetCeremonyTimeScale.js`](js/test/test-NetCeremonyTimeScale.js:1)).
- Stage 6 patch: [`setView()`](js/systems/CameraSystem.js:332) during an active ceremony aborts cleanly via [`_abortNetCeremony()`](js/systems/CameraSystem.js:1683) helper (FOV + time-scale restored, `FIRST_NET_DEPLOY` not written).
- **To disable:** set [`FEATURE_FLAGS.NET_CEREMONY = false`](js/core/Constants.js:432). Pre-Q2 behavior preserved byte-identically.
- **Full spec:** [`archive/CEREMONY_REDESIGN.md`](archive/CEREMONY_REDESIGN.md) §7 *Implementation Status*.

### Design intent — "Small child holding large balloon"

The V5 mother is *small*; the captured debris is comparatively *huge*. The cinematic must read this scale tension at every beat. **Anti-pattern: tight-on-debris shots that crop out the mother — once you lose the operator from frame, scale tension evaporates.** Full design metaphor + camera implications in [`GAME_DESIGN.md §2.1`](GAME_DESIGN.md:48). Future ceremony camera work must keep mother + tether + bagged-debris readable as a single composite silhouette.

---

## 🔒 Locked Product Principles (2026-04-25 — Non-Negotiable)

### 1. Offline-First — No Auto-Fetch

The game **plays great offline and stays offline**. No background HTTP requests. No live TLE feeds. No telemetry.

- **News-driven content** enters via manual edits to [`data/news-events.json`](data/news-events.json) — user-driven, not API-driven.
- The only network access ever performed is loading textures + JS modules from CDN (one-time, vendorable). Note: 2026-05-17 switched the importmap to local `node_modules/three` for offline boot (see §6.3).
- Optional Codex links to NASA/Celestrak open in user-clicked new tabs; never automatic.

**Live TLE feeds, auto-fetch APIs, and online sync features are explicitly OFF the roadmap.**

(Full manifesto previously at `FINAL_ANALYSIS.md §5.4`; now archived. This bullet list IS the canonical Offline-First Principle.)

### 2. Dual-Metal FEEP Is Y0 Baseline (TRL 7–8)

Multimetal FEEP thrusters are **flight-demonstrated today** (Enpulsion IFM Nano series, 2024–2025). They are **not** future tech. The V5 daughter arm ships from factory with a dual-metal FEEP capable of running indium (default) OR a Forge-refined alternative metal cartridge (gallium / iodine / bismuth, etc).

- **Y0 baseline:** indium + 1 alt slot
- **Y1 unlock:** iodine, bismuth (TRL 6–7)
- **Y2 unlock:** mercury, cesium (TRL 5)
- **Y4 endgame:** tungsten + MPD-class power (TRL 4)

See [`DAUGHTER_ARM_CONTROLS.md §5`](DAUGHTER_ARM_CONTROLS.md:1) and [`GAME_FLOW_BRAINSTORM.md §7.2`](GAME_FLOW_BRAINSTORM.md:1).

### 3. Mother Launches from India — ISRO Heritage

The V5 mothership launches on a cost-optimised ISRO LVM3 / SSLV mission. Indian Mission Operations are part of the comms loop alongside Houston.

- **Launch sites:** Satish Dhawan Space Centre (Sriharikota, 13.7°N) and Kulasekarapattinam Spaceport (Tamil Nadu, 8.4°N — equatorial advantage for GEO).
- **Comms personas:** **BANGALORE** (ISTRAC) for mission-critical ops, **HASSAN** (MCF) for GEO operations. **Houston** retained for US-side context.

Implementation in [`data/ground-stations.json`](data/ground-stations.json) and [`CommsSystem.js`](js/systems/CommsSystem.js:1). (Full spec previously at `FINAL_ANALYSIS.md §5A`; now archived. This bullet list IS the canonical Indian Heritage Principle.)

---

## 🚀 Next Shift? Start Here

### Step 1 — Orient (15 min)

| # | Read | Why |
|---|------|-----|
| 1 | This file (§1 + §3 Post-Cinch Learnings + §4 Backlog top) | Current state + load-bearing rules + active priorities |
| 2 | [`README.md`](README.md:1) | Quick start, controls, controls reference |
| 3 | [`GAME_DESIGN.md`](GAME_DESIGN.md:1) §1–§3 | Core loop, jellyfish identity, ΔV economy, balloon metaphor (§2.1) |
| 4 | [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | File structure, module design, state machine (⚠️ needs Epic 9/10 update) |

### Step 2 — Pick a task (priority order, post-2026-05-28)

1. **Item 6 build** ([`GAME_DESIGN.md §4.1 First-Clear Keepsake`](GAME_DESIGN.md:108)) — apex hub trophy, awaiting user OK on shop-counter placement (~50 LOC, 2 tests).
2. **Item 10 build** ([§4.9.2 #6 below](#492-proposed-redesign--6-concrete-improvements)) — first-clear directive comms + `FIRST_FIELD_CLEARED` teaching moment (~150 LOC, 3 tests).
3. **Item 11 build** ([`GAME_DESIGN.md §4.0 Forge v2`](GAME_DESIGN.md:108)) — chunk-and-queue residual + cargo reservation (~150 LOC, 5 tests).
4. **§4 Backlog Tier A** — §4.4 lasso speed (1–2 h) + §4.5 lasso reusability (2 h).
5. **§4 Backlog Tier B** — §4.2 conjunction gating + §4.3 target panel + §4.1 debris visuals + §4.7 lasso visuals.
6. **Larger refactors** — centralise `_isVisibleForCurrentMission()` (tripled in [`DebrisField.js`](js/entities/DebrisField.js:1)); split [`DebrisField.js`](js/entities/DebrisField.js:1) (2093 LOC) and [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) (1869 LOC).

### Step 3 — Verify baseline

```bash
node js/test/run-tests.js | tail -3    # expect: 2320 / 2320 / 0 failures
```

If red, see [`archive/SK_M1_POLISH_HANDOFF.md §7 Appendix`](archive/SK_M1_POLISH_HANDOFF.md) for diagnostic-log grep targets.

---

## §1 Project State Summary

### What the game is

Browser-based orbital-debris-capture sim. The player pilots a V5 Crossbow mothership in LEO, finds & analyses tracked debris, flies the autopilot into a trailing rendezvous, then captures via Capture Net (spinning mesh, short-range), Spinner/Weaver crossbow arms (V5 fleet — 4 arms at Y0, expandable to 8 via tech ladder), or the Trawl sweep. Salvage is refined into fuel/parts; a Skills Discovery system surfaces 33 gameplay techniques organically as the player enacts them. The game teaches real aerospace concepts (Hohmann, inclination ΔV, Whipple shields, Kessler cascade, conjunction avoidance) through play.

Core identity is **Jellyfish Fisherman** ([`GAME_DESIGN.md §2`](GAME_DESIGN.md:48)). ΔV is the master resource, like MechWarrior 2's heat gauge.

### Tech stack

| Layer | Choice |
|---|---|
| Rendering | [`three@^0.170`](package.json:1) (WebGL, no engine) |
| Language | ES Modules, no bundler (native `<script type="module">`) |
| Server | Python `http.server` on port 8081 via [`start.sh`](start.sh:1) |
| Tests | Node-based harness, no browser; see [`js/test/TestRunner.js`](js/test/TestRunner.js:1) |

### Test suite status

**2320 / 2320 / 0 failures** as of 2026-05-28. Harness does NOT stub DOM or `THREE`; tests use the real runtime for integration-level checks. Test files in [`js/test/`](js/test/run-tests.js:1). Run with `./test.sh` or `node js/test/run-tests.js`.

### Systems & maturity (current state)

| System | File | Maturity |
|---|---|---|
| OrbitalMechanics | [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) | Stable — Y↔Z round-trip fixed & tested |
| PlayerSatellite | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) | Stable — Config G visual model |
| AutopilotSystem | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | Stable — `hasLockedTarget` HOLD fork, `[DBG-AP-DISENGAGE]` log |
| CollisionAvoidance | [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:1) | Stable — honors `AUTOPILOT_TARGET_LOCK` |
| DebrisField | [`DebrisField.js`](js/entities/DebrisField.js:1) | OK — §4.1 visuals pending, §4.8 cluster metadata underused, 2093 LOC (split candidate) |
| LassoSystem | [`LassoSystem.js`](js/systems/LassoSystem.js:1) | OK but slow — §4.4 speed, §4.7 visuals pending |
| ArmManager / ArmUnit | [`ArmManager.js`](js/entities/ArmManager.js:1), [`ArmUnit.js`](js/entities/ArmUnit.js:1) | Stable — Config G collar-mount remount |
| CaptureNet + CaptureNetVisual | [`CaptureNet.js`](js/entities/CaptureNet.js:1), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) | Stable — Q2 ceremony shipped, REELING sync fixed 2026-05-28, world-frame cinch fixed 2026-05-27 |
| ConjunctionSystem | [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:1) | OK — §4.2 timing/explanation pending |
| TrawlManager | [`TrawlManager.js`](js/systems/TrawlManager.js:1) | OK — auto-picks densest cluster; needs player-choice gate for §4.8 |
| SkillsSystem / SkillsPane | [`SkillsSystem.js`](js/systems/SkillsSystem.js:1), [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) | Functional — see §4.9 (checklist mode pending; 1869 LOC split candidate) |
| ~~TutorialSystem~~ | ~~Deleted~~ | Sprint 3 ST-3.2 — bridge hack removed, conjunction gates migrated to skills-based |
| ForgeSystem | [`ForgeSystem.js`](js/systems/ForgeSystem.js:1) | OK — Item 11 chunking pending (see [`GAME_DESIGN.md §4.0`](GAME_DESIGN.md:108)) |
| CameraSystem / InputManager / ResourceSystem / ScoringSystem / CargoSystem / PowerDistribution / SensorSystem / KesslerSystem / AudioSystem | — | Stable |

Total: 30 system modules + 6 entity modules + ~22 UI modules.

---

## §3 Key Architectural Learnings & Gotchas

These are **load-bearing** rules. Violating them silently breaks physics without triggering any existing test.

### 3.1 Y-up (Three.js) vs Z-up (ECI) — the axis convention trap

The scene frame uses **Three.js Y-up**. Classical orbital-mechanics textbooks use **ECI Z-up**. The original [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:469) was Y-up. The inverse [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129) was Z-up and **had never been exercised** until `applyCartesianImpulse()`. The swap `y↔z` makes them a faithful round-trip.

- **Rule.** Any NEW code that round-trips `(position, velocity) → elements → (position, velocity)` MUST call the corrected function. Don't write a parallel version.
- **Guard test** — [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164).

### 3.2 `TIME_SCALE_GAMEPLAY` (10×) — the silent multiplier

[`Constants.TIME_SCALE_GAMEPLAY`](js/core/Constants.js:1) scales orbital propagation so one real second advances orbits ~10 s. Any physics quantity that is "per tick" must account for this or be **10× too small**:

- **Propagation uses it:** [`DebrisField.update()`](js/entities/DebrisField.js:620) — `const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY`. ✅
- **Autopilot ΔV clamp uses it.** ✅
- **LassoSystem does NOT use it:** [`LassoSystem.js:419-422`](js/systems/LassoSystem.js:419) — `speed * dt` only. ❌ (§4.4 fix)
- **ArmUnit transit:** [`ArmUnit._updateLaunching()`](js/entities/ArmUnit.js:1207) integrates `velocity` in real `dt`. Audit if arms visibly lag the ship at high time-scale.

**Rule.** Grep: `regex: TIME_SCALE_GAMEPLAY|gameDt`. Any physics loop computing impulses/velocities in m/s AND using `dt` (not `gameDt`) is suspect.

### 3.3 `_applyThrust()` vs `applyCartesianImpulse()` — when to use which

| API | Semantics | Use from |
|---|---|---|
| [`PlayerSatellite._applyThrust()`](js/entities/PlayerSatellite.js:2125) | Treats `(x, y, z)` as **orbital-element rate channels**: `x→Δe`, `y→Δi`, `z→Δa`. Low-pass, not an impulse. | Player input (`thrustIon`, RCS) — legacy contract. |
| [`PlayerSatellite.applyCartesianImpulse(dvWorld, dt)`](js/entities/PlayerSatellite.js:2145) | Takes a **Cartesian world-frame ΔV** (m/s). Does a full round-trip via `cartesianToKeplerian`. | Autopilot, any future physically-consistent controller. |

**Rule.** If reasoning about "push the ship this-way by N m/s in world space", use `applyCartesianImpulse`. If reasoning about "bump SMA", use `_applyThrust`. Mixing causes the exact mismatch that sank the old autopilot.

### 3.4 Collision-Avoidance exemption — two axes

[`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) maintains TWO exempt IDs:

1. `_activeTargetId` — fed by `TARGET_SELECTED` / `TARGET_CLEARED` (Tab-selection).
2. `_autopilotLockId` — fed by `AUTOPILOT_TARGET_LOCK` / `_UNLOCK` (added in autopilot rewrite).

Before the fix, AP in `DEBRIS`/`TRAWL` mode → no `TARGET_SELECTED` → CA dodged the chased debris → oscillation. Now AP always emits the lock.

**Rule.** Any new "pursuit" system (hunt-and-tag, escort, docking) emits a LOCK event so CA stops fighting you.

### 3.5 Test-stub blindness

The round-trip guard in [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164) is the single most important test from the AP shift — it would have caught bug #1 the day it was introduced. **Stubs hide bugs.**

**Rules.**
1. For every physics helper: write `f⁻¹(f(x)) ≈ x` to tolerance.
2. Prefer integration tests over stubs.
3. Factor-of-10 error? Suspect `TIME_SCALE_GAMEPLAY`.
4. 90°/180° error? Suspect a local-to-world transform missing.
5. Add a regression test for every bug found.

### 3.6 Constants-first refactors

Hoist magic numbers. The AP work added 14 knobs into [`Constants.AUTOPILOT`](js/core/Constants.js:907). Every tunable is named, commented, referenced from one place. Three debug retrospectives each adjusted constants only — no control-law touches.

### 3.7 Scene-unit scale `M = 1e-5`

`M = 0.00001` = "1 metre in scene units" (scene unit = 100 km). `SCENE_SCALE = 1e-5` = "1 km in Earth-radius-scaled scene units." Collisions have occurred. **Distances in metres in Constants; multiply by `M` at the boundary.** (See §2 Rule 3.)

### 3.8 Wiring-gap pattern (2026-05-17 — Daughter SK pass)

A system class can be imported in `main.js` and have full `init()` / `update(dt)` methods, but if `main.js` doesn't actually CALL them, the system is **silently dead**. Tests pass because they instantiate modules directly; the bug is browser-only.

Confirmed gaps fixed 2026-05-17: [`CaptureNet`](js/entities/CaptureNet.js:1) (`init` + `update` never called), [`ArmManager._initArms`](js/entities/ArmManager.js:219) (`initNetInventory()` method existed but never invoked).

Confirmed orphaned wiring (pending): [`TetherReel.js`](js/systems/TetherReel.js:1), [`BridleRing.js`](js/entities/BridleRing.js:1) — neither imported nor init'd/update'd in [`main.js`](js/main.js:1). See [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md:1) §4.

**Rule.** Add `test-main-wiring.js` smoke test that asserts every system imported in `main.js` has `init()` OR `update()` called at least once during a mock boot cycle.

---

## §4 Next Steps — Improvement Backlog

> **6 open items** (was 9 — §4.6 resolved by Epic 10 V-4; §4.9 #2 TutorialSystem deletion done; §4.9 #5 skills gates partially done). New 2026-05-29: items 6, 10, 11 design-only docs folded into permanent homes (Items 6 + 11 → [`GAME_DESIGN.md`](GAME_DESIGN.md:108); Item 10 → §4.9.2 #6 below).

For each: (a) current-state cite, (b) problem, (c) proposed approach, (d) S/M/L/XL complexity, (e) dependencies.

### 4.1 Debris Visual Representation

**Symptom.** All debris looks identical — rapidly spinning spiky white crumpled paper.

**Current state.** [`DebrisField._buildInstancedMeshes()`](js/entities/DebrisField.js:444) creates one InstancedMesh per shape with single grey material. [`DebrisWireframe.js`](js/ui/DebrisWireframe.js:1) already has differentiated canvas-2D wireframes for rocket bodies, defunct sats, mission debris, fragments. Tumble rates [`DEBRIS_TYPES`](js/entities/DebrisField.js:26) are ×10 by `TIME_SCALE_GAMEPLAY` = unrealistic.

**Proposed.** (1) Port wireframe shapes from [`DebrisWireframe.js`](js/ui/DebrisWireframe.js:1) into `THREE.BufferGeometry` + `LineSegments`. (2) Per-ID variation: ~480 small geometries for fragments, 3–5 variants for rocket/defunct/mission. (3) Material by material-type (debris already tagged `material ∈ {aluminum, titanium, composite, mli_mylar, solar_cell}`). (4) Tumble cap: clamp visual tumble ≤ 30°/s, divide [`tumbleMax`](js/entities/DebrisField.js:27) by `TIME_SCALE_GAMEPLAY`.

**Acceptance.** Player names debris type without reading Target Panel.

**Complexity: M** (~6–10 h). **Synergy with §4.3.**

### 4.2 Conjunction Alerts — Timing & Clarity

**Symptom.** Alerts fire too early in new-player arc; no teaching context.

**Current state.** [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) fires every 30–120 s up to 3 alerts. Suppression gated on `tutorialStage < 7` BUT SkillsSystem force-emits `TUTORIAL_STAGE_CHANGED { stage: 9 }`, leaving gate open from second one.

**Proposed.** (1) Gate on first capture (`captureCount ≥ 1` AND `missionElapsed ≥ 120 s`). (2) Pre-alert briefing 5 s before first alert. (3) Force first alert to GREEN tier. (4) Codex pre-unlock — move `triggerEvent` from `CONJUNCTION_WARNING` to `FIRST_CAPTURE`. (5) HUD `[?]` glyph linking to Tech Library.

**Complexity: S–M** (~3–5 h). **Partial overlap with §4.9 onboarding.**

### 4.3 Target Analysis Panel Readability

**Symptom.** Selected row doesn't stand out enough; Earth rotation changes panel transparency.

**Current state.** Selected row: [`TargetPanel.js:57-60`](js/ui/hud/TargetPanel.js:57) — `rgba(0, 204, 255, 0.10)`. Wireframe panel bg: [`DebrisWireframe.js:24`](js/ui/DebrisWireframe.js:24) — `rgba(0, 10, 25, 0.75)` (25% Earth bleed).

**Proposed.** (1) Opaque backgrounds — `rgba(5,10,20,0.95)`. (2) Prominent selection — `rgba(0, 204, 255, 0.22)` + inset glow + thicker border + text-shadow. (3) 3-D reticle — thicken bracket, pulse at 0.8 Hz. (4) Earth-contrast fallback `.hud-panel--earth-overlap` with alpha 0.98.

**Complexity: S** (~2–4 h, mostly CSS).

### 4.4 Lasso Travel Speed

**Symptom.** Lasso takes ~15 s to cover 120 m.

**Current state.** [`Constants.LASSO_SPEED = 5.0 m/s`](js/core/Constants.js:756). [`LassoSystem.update()`](js/systems/LassoSystem.js:419-422) uses real `dt`, not `gameDt` (§3.2 gotcha). Reel-in: 2 s hard-coded.

**Proposed.** (1) `LASSO_SPEED = 40 m/s`. (2) Fix time-scale: `speed * dt * Constants.TIME_SCALE_GAMEPLAY`. (3) Reel-in `_reelProgress += dt * 1.5` (0.7 s). (4) `maxFlightTime = 8 s`. (5) Trail sampler 0.06 → 0.03.

**Acceptance.** Cast→contact ≤ 4 s at 120 m; cast→catch ≤ 5 s including reel.

**Complexity: S** (~1–2 h).

### 4.5 Lasso Reusability Model — Option A (recommended)

Keep reusable with cooldown, **surface it.** (1) 2-s ring progress indicator next to SPACE hint. (2) First-cast comms: *"Lasso ready in 2 s — unlimited casts, recharges from onboard power."* (3) Hoist `Constants.LASSO_COOLDOWN_CATCH`, `LASSO_COOLDOWN_MISS`.

Options B (single-use + crafting) and C (5-round mag refilling) deferred.

**Complexity: S** (~2 h).

### ~~4.6 Arm Direction (180° Bug)~~ — RESOLVED (Epic 10 V-4)

Epic 10 V-4 Arm Remount reworked dock offset architecture. Dynamic offsets via [`postArmUpdate()`](js/entities/PlayerSatellite.js:1) called from [`main.js`](js/main.js:1), with arm orientation driven by strut tip positions.

### 4.7 Lasso Visual Representation

**Symptom.** Projectile reads as a "2-D orange polyhedron"; tether is thin.

**Proposed sprint.** (1) Bolas head: torus + cylinder + 2 small weights, ~4 Hz rotation. (2) Thick tether: `TubeGeometry` along `CatmullRomCurve3` OR `LineSegmentsGeometry`. (3) Contact sparks: 12 radial sparks over 0.4 s.

**Complexity: M** (~4–6 h). **Depends on §4.4 speed first, §4.1 for context.**

### 4.8 Mission Operations Model — NASA/JPL-Style ADR Navigation (Strategic)

**Thesis.** The game is structurally an ADR operation but the pilot has no HUD surface to reason about it. Closing that gap turns "grab floating stuff" into "run a sustained orbital salvage operation."

**5 concrete sub-features (each shippable independently):**

#### A. Pre-Mission Field-Assay MFD

Left MFD that polls [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) every 5 s and ranks top 5 reachable clusters:

```
Cluster Score = (totalMassKg × varietyBonus × reachable) / (deltaV_to_cluster + conjunction_risk)
```

Displayed row: `Cluster | Alt | Inc | N | Mass | ΔV-in | Score | Risk`. Selected cluster becomes AP target via "engage cluster" (Shift+A or comms-menu).

**NEW** [`FieldAssayMFD.js`](js/ui/FieldAssayMFD.js:1) (~400 LOC) + [`HUD.js`](js/ui/HUD.js:1) wire (~100). Total ~500 LOC.

#### B. Station-Keeping Recoil Compensation

When AP is in HOLD and a tool fires, auto-command opposite-direction `applyCartesianImpulse` of equivalent magnitude via [`PlayerSatellite.applyCartesianImpulse()`](js/entities/PlayerSatellite.js:2145).

- **Listen** in AP for `LASSO_FIRED`, `CROSSBOW_FIRE`, `TRAWL_START`.
- **Compute** reaction impulse from projectile mass × velocity.
- **Budget** to a separate `stationKeepingDeltaV` counter shown in Field Assay MFD.
- **Constants** — `AUTOPILOT.STATION_KEEP_COMPENSATION = true`, `STATION_KEEP_EFFICIENCY = 0.85`.

~80 LOC.

#### C. Mission Progression — Spawn Difficulty Curve

Tie spawn to `scoring.missionNumber`:

| Mission | Field profile | Key levers |
|---|---|---|
| 1 | Welcome field, 1 cluster, low tumble, no hydrazine, no conjunctions | Ensures lasso+AP works on trip one |
| 2–3 | 2 clusters, moderate tumble, 1 tracked hydrazine 🟡 | Cluster choice + risk debris |
| 4–6 | 4 clusters across inclinations, hidden untracked, 1 synergy pair | Scan-reveals-info loop |
| 7–9 | 6 clusters, mid-mission Kessler cascade, conjunction alerts begin | Time pressure + dynamic events |
| 10+ | Full random, active sats, space weather | Endgame |

Profile table in [`Constants.js`](js/core/Constants.js:1) `MISSIONS.PROFILES`. ~150 LOC.

#### D. Dynamic Mid-Mission Events (MW2-style)

Wire scan results to mission state via 5 new event types:

| Trigger | Event | Mission change |
|---|---|---|
| `SCAN_DISCOVERY` on hydrazine | `DEBRIS_HAZARD_REVEALED` | Comms: *"Residual hydrazine — maintain 500 m standoff. +500 bonus."* AP D_TRAIL → 500 for this target. |
| `SCAN_DISCOVERY` reveals synergy pair | `SYNERGY_OPPORTUNITY` | *"Gallium + Copper pair nearby — +300 pts if captured within 5 min."* Spawns `_missionBonus` timer. |
| `KESSLER_CASCADE` in a cluster | `CASCADE_THREAT` | *"Cascade event — 8 new fragments. Priority: depart or secure first."* |
| Severe solar storm | `WEATHER_MISSION_EFFECT` | *"Sensors degraded 10 min. Scan range halved."* |
| `ConjunctionSystem` predicts cluster-wide approach | `CLUSTER_CONJUNCTION` | *"Multiple contacts converging at your altitude in 90 s. Depart NOW."* |

~200 LOC.

#### E. Tool-Tier Efficiency Teaching

Extend [`SweepReportUI`](js/ui/SweepReportUI.js:1) with per-method ΔV breakdown — Lasso vs Spinner vs Weaver vs Trawl, with stars for "most efficient." After mission 2, Houston calls out the gap. ~100 LOC.

**Total §4.8: XL (~4–7 dev days). Dependencies:** §4.4 lasso speed + §4.9 onboarding land first.

**Acceptance.** New player sees ranked Field Assay; firing lasso in HOLD does not drift > 10 m over 10 s; after mission 2, player has heard *"Trawl is more efficient"*; mission 3+ includes at least one mid-mission event.

### 4.9 Onboarding Flow — Tutorial + Skills + Discovery Pane (Strategic)

**Thesis.** The Welcome Field + comms work. The Skills discovery engine works. But the feedback chain designed in [`FIRST_EXPERIENCE.md §3`](FIRST_EXPERIENCE.md:1) — *"the action's visual/audio payoff naturally suggests the next action"* — was never fully implemented.

#### 4.9.1 Audit — what's there

| System | Status | Role |
|---|---|---|
| ~~TutorialSystem~~ (752 LOC) | **DELETED** Sprint 3 ST-3.2 | (was: 10-stage linear tutorial) |
| [`SkillsSystem`](js/systems/SkillsSystem.js:1) (720 LOC) | Active | 33-skill free-order discovery, SM-2 reminders, prereq gates |
| [`SkillsPane`](js/ui/hud/SkillsPane.js:1) (1869 LOC) | Active | Compact "Discoveries" pane (bottom-left), expanded tree on K |
| [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) design | **Partially implemented** | Welcome Field ✓; contextual comms ✓; **checklist mode NOT done**; staggered scan animation NOT done; sonar ping NOT done |

**HUD-group dim/undim gap.** Of 33 skills in [`Constants.js:999-1041`](js/core/Constants.js:999), only 7 have `hudGroup` — discovery for the other 26 produces only a pane pop-in, no persistent world change. Discovery feels inconsistent.

**No celebration of transitions.** PRACTICED and MASTERED are silent state changes — just a symbol update in the pane. Given `MASTERY_MIN_TIME: 300` (5 real minutes), mastery deserves audio + screen flash.

**HUD affordance gap.** Dormant panels at 0.5 opacity give no hint how to activate. New players stare wondering what the dim Target Panel is for.

#### 4.9.2 Proposed redesign — 6 concrete improvements

##### 1. Implement Discovery Pane Checklist Mode

Per [`FIRST_EXPERIENCE.md §4.3`](FIRST_EXPERIENCE.md:1). In NOVICE (< 5 discoveries), render [`SkillsSystem.getNextSuggestions(3)`](js/systems/SkillsSystem.js:146) as a checklist:

```
▸ NEXT STEPS
  ✓ Scan area                 [S]     ← discovered
  → Select target            [Tab]    ← current, pulsing
  ○ Approach target            [A]    ← upcoming
  ─────────────────────────
  2/34 skills discovered
```

[`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) additions — `_checklistMode` boolean, `_renderChecklist()`. ~80 LOC.

##### ~~2. Delete TutorialSystem~~ — ✅ RESOLVED (Sprint 3 ST-3.2)

##### 3. HUD dormant affordance — key-cap hint glyph

When a panel has `.hud-dormant`, overlay a corner key-cap glyph (CSS `::after`). Each panel gets `data-activate-key="S"`. ~40 LOC.

##### 4. Celebrate mastery transitions

PRACTICED: soft chime + tier-color flash on pane entry. MASTERED: 3-note arpeggio + screen-edge pulse + (first 3 masteries only) centered *"Mastery Unlocked — {label}"* toast. ~60 LOC.

##### 5. Skill-based gates for advanced systems

| System | Old gate | New gate |
|---|---|---|
| [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) first alert | `stage >= 7` | `skills._totalCatches >= 1 && missionElapsed >= 120 s` |
| [`KesslerSystem`](js/systems/KesslerSystem.js:1) first cascade | not gated | `missionNumber >= 4` |
| [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js:1) first event | not gated | `skills.isDiscovered('manage_power')` |
| [`ResourceSystem`](js/systems/ResourceSystem.js:1) `T` fuel-cycling | not gated | `skills.isDiscovered('manage_power')` |

New public API: `SkillsSystem.getTotalCatches()`, `getSessionElapsed()`. ~80 LOC.

##### 6. First-Clear Guidance — Directive Comms + Teaching Moment (Item 10, 2026-05-28)

> Folded from `POST_CINCH_QA_DESIGN_DOCS.md §10`. Net new content; ~150 LOC, 3 tests.

**Current behavior.** [`RewardSystem.js:373-380`](js/systems/RewardSystem.js:373) fires comms on cluster-clear thresholds:

| Threshold | Current message |
|---|---|
| 50% | "Houston: Half the cluster cleared. Keep it up." |
| 75% | "Houston: Three quarters cleared — keep pushing!" |
| 100% | "Houston: Field completely cleared! Perfect sweep. Bonus authorized." |

The 100% message is **celebratory but non-directive** — the player has no in-game hint what to do next. [`TeachingSystem.js`](js/systems/TeachingSystem.js:30) defines 12 teaching moments but none target `FIRST_FIELD_CLEARED`.

**Proposal — three components:**

**A. Make the 100% comms directive.** Replace celebratory text with a sentence naming the next 2 actions and their keys:

```
"Houston: Field clear! Press K to forge salvage, or scan (S/W) for the next cluster."
```

5 LOC change in [`RewardSystem.js:373`](js/systems/RewardSystem.js:373).

**B. Add `FIRST_FIELD_CLEARED` teaching moment.** Persistence-gated (once-per-profile), triggered on first `Events.FIELD_CLEAR` with `tier.pct >= 1.0`:

```js
{
  id: 'first_field_cleared',
  triggerEvent: Events.FIELD_CLEAR,
  triggerFilter: (data) => data.pct >= 1.0,
  oncePerProfile: true,
  title: 'Field Clear — What Next?',
  body: [
    'Your salvage is in cargo. Options:',
    '  • K — forge raw metals into refined ingots (2.5× value) or propellant slugs',
    '  • B — shop (refined metals + reputation unlock upgrades)',
    '  • S/W — scan for the next cluster (Tab cycles targets)',
    '  • A — autopilot once you have a target',
  ].join('\n'),
}
```

~30 LOC in [`TeachingSystem.js:30`](js/systems/TeachingSystem.js:30) + persistence key + test.

**C. (Optional) HUD hint banner.** 5–10 s ephemeral banner: `[FIELD CLEAR]  Forge (K) · Shop (B) · Scan (S/W)`. Cleared by wall-clock, suggested action, or new cluster engaged. Can reuse existing comms-toast layout. ~80 LOC.

**Sign-off checklist:**
- [ ] User confirms 2 directives "forge OR scan" is right next-step.
- [ ] User confirms `FIRST_FIELD_CLEARED` should be once-per-profile (not once-per-session).
- [ ] User approves K hotkey (depends on Item 9 — already landed ✓).
- [ ] (Optional) User approves HUD banner pattern.

**Cross-item alignment.** With Item 11 (forge chunking, [`GAME_DESIGN.md §4.0`](GAME_DESIGN.md:108)), the teaching moment should say *"Press K to forge ALL salvage"* not *"... a 5 kg batch."* Both items should ship together.

**Total Item 10: ~150 LOC, ~3 new tests. Complexity: M.**

#### 4.9.3 Files to touch

| Item | File | Est LOC |
|---|---|---|
| 1. Checklist mode | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) | ~80 |
| 3. Dormant corner glyph | [`HUD.js`](js/ui/HUD.js:1) + per-panel attributes | ~40 |
| 4. Mastery celebration | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) + [`AudioSystem.js`](js/systems/AudioSystem.js:1) | ~60 |
| 5. Skills-based gates | [`SkillsSystem.js`](js/systems/SkillsSystem.js:1) public API + 4 consumers | ~80 |
| 6. First-clear guidance | [`RewardSystem.js`](js/systems/RewardSystem.js:1) + [`TeachingSystem.js`](js/systems/TeachingSystem.js:1) (+ optional HUD banner) | ~150 |

**Total Complexity: L** (~3–5 dev days).

**Acceptance.**
- New player reaches first capture within 45–90 s (per [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1)).
- Discovery Pane never shows 0 items — NOVICE mode always displays 3 suggestions.
- After 3 masteries, player has heard 3 distinct fanfares.
- After first field-clear, player sees directive comms + `FIRST_FIELD_CLEARED` overlay.
- `grep -r 'TUTORIAL_STAGE_CHANGED' js/` returns zero hits outside event-name constants.

---

## §5 Recommended Priority Order

### Tier A — Quick Wins (ship in 1 day)

| Rank | Item | Effort | Status |
|---|---|---|---|
| 1 | §4.4 Lasso travel speed | S (1–2 h) | Pending |
| 2 | §4.5 Lasso reusability — Option A | S (2 h) | Pending |

### Tier B — Items 6/10/11 build + First-Experience UX (ship in 2–3 days)

| Rank | Item | Effort | Status |
|---|---|---|---|
| 3 | Item 6 build ([`GAME_DESIGN.md §4.1`](GAME_DESIGN.md:108)) | S (~50 LOC) | Pending — apex hub keepsake, shop counter placement |
| 4 | Item 10 build (§4.9.2 #6 above) | M (~150 LOC) | Pending — first-clear directive + teaching moment |
| 5 | Item 11 build ([`GAME_DESIGN.md §4.0`](GAME_DESIGN.md:108)) | M (~150 LOC) | Pending — forge chunk-and-queue |
| 6 | §4.2 Conjunction gating | S–M (3–5 h) | Pending |
| 7 | §4.3 Target panel readability | S (2–4 h) | Pending |
| 8 | §4.1 Debris 3-D visuals | M (6–10 h) | Pending |
| 9 | §4.7 Lasso visuals | M (4–6 h) | Pending |

### Tier C — Strategic Multi-Sprint Features

| Rank | Item | Effort | Status |
|---|---|---|---|
| 10 | §4.9 Onboarding flow (items #1, #3, #4, #5) | L (2–4 days) | Partially done (#2 ✅) |
| 11 | §4.8 Mission Operations Model | XL (4–7 days) | Each sub-feature (A–E) independently shippable |

**Total estimated:** ~10–16 dev days across 4 sprints.

### Key dependencies

```
§4.4 (lasso speed) ──┬─→ §4.1 + §4.7 ─→ §4.8.B (recoil)
§4.5 ─ − ─ − ─ ─ ─ ─ ┘
§4.2 (conjunction) ──→ §4.9 #5 (skills gates)
§4.3 (target panel) ──→ §4.8.A (Field Assay MFD)
§4.9 #1 (checklist) ──→ §4.8.C (mission profiles)
§4.9 #6 (first-clear) ── couples to Item 11 forge chunking (GAME_DESIGN §4.0)
```

---

## §6 Testing Strategy Notes

### 6.1 Harness

[`js/test/TestRunner.js`](js/test/TestRunner.js:1) — minimal `describe / it / assert`, no deps, runs under Node ≥ 18. **Does** instantiate real `three` objects (Vector3, Quaternion) for physics tests. Tests in `js/test/test-*.js`; `run-tests.js` imports all.

### 6.2 The hard-won lessons

1. For every new physics helper: **inverse-consistency test** ([`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164)).
2. Prefer integration tests over unit stubs.
3. Factor-of-10 error → suspect `TIME_SCALE_GAMEPLAY` (§3.2).
4. 90°/180° error → suspect a local-to-world transform missing (§3.1, §3.8, §2 Rule 1).
5. Add a regression test for every bug found.

### 6.3 Browser-only behaviour escape (2026-05-17 lesson L1)

Test runner does NOT cover browser-only behavior. **2320 / 2320 tests, yet the SK regression + capture wiring + offline loading were all undetected.** Run `node --check <file>` on every modified `.js` after edits (catches template-literal traps the test runner misses). Always verify visually in the browser. **Recommendation:** add `test-main-wiring.js` smoke test (see §3.8 rule).

### 6.4 Running the suite

```bash
./test.sh                               # full suite (2320 / 2320 / 0 failures)
node js/test/run-tests.js               # direct invocation
node js/test/run-tests.js --filter AP   # pattern filter
open http://localhost:8081/test.html    # browser-side diagnostics
```

---

## §7 Active Docs Index — Audit (2026-05-29)

> **Categories:**
> - **🟢 Canonical** — current source of truth; read first
> - **🟡 Active reference** — design specs / system bibles, consulted when touching their area
> - **🟠 Archive** — moved to `archive/` 2026-05-29; useful historical reference but no forward work
> - **🪦 Stub** — content folded elsewhere; file is a one-paragraph redirect (or deleted)

### 🟢 Canonical (6) — read first

| Doc | Purpose | Read When |
|---|---|---|
| [`README.md`](README.md:1) | Entry point, quick start, controls | First contact |
| [`HANDOFF.md`](HANDOFF.md:1) | **This file** — current shift, gotchas, backlog, doc audit | Every session |
| [`GAME_DESIGN.md`](GAME_DESIGN.md:1) | Design vision — core loop, jellyfish identity, ΔV economy, balloon metaphor (§2.1), Forge v2 (§4.0), Apex Hub Keepsake (§4.1) | First contact after README |
| [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | As-built technical reference (file structure, rendering, state machine) | Orient before any new work. ⚠️ Needs Epic 9/10 update |
| [`BIG_PICTURE.md`](BIG_PICTURE.md:1) | 12-month strategic roadmap — missions, tech ladder, dependency graph | Planning long-term work |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md:1) | Sprint tracker — Sprints 1–4, Epics 5–10 completion log | Picking next work. ⚠️ Needs Epic 9/10 backfill |

### 🟡 Active references (10) — read when touching their area

| Doc | Purpose | Read Before Touching |
|---|---|---|
| [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md:1) | Config G geometry bible — locked dimensions (§10.11), stowage (§10.14), ROSA (§10.15–17) | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1), [`ArmUnit.js`](js/entities/ArmUnit.js:1) |
| [`CAPTURE_NET.md`](CAPTURE_NET.md:1) | Capture Net design Rev 4: cling, tangle, fragmentation, M/LD/SD-NET classes | [`CaptureNet.js`](js/entities/CaptureNet.js:1), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) |
| [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1) | V5 crossbow arm physics & design bible | [`ArmUnit.js`](js/entities/ArmUnit.js:1), [`ArmManager.js`](js/entities/ArmManager.js:1) |
| [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md:1) | Orbital-crane control redesign + dual-metal FEEP | SK/arm-pilot input logic |
| [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md:1) | Weaver/Spinner tool differentiation spec (4-phase plan, P1 = flip CAPTURE_NET flag) | Adding new arm tools / tool HUD |
| [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md:1) | Wiring-gap survey for retrieval methods; companion to §3.8 wiring-gap rule | Auditing system orphaned wiring |
| [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) | Welcome Field + first-90-second UX + Checklist Mode design | First-experience flow changes |
| [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md:1) | Tool failure modes, FEEP metals, ISRO comms, delight catalog | Adding new game-feel content |
| [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md:1) | 17 aerospace concepts taught via play | Adding teaching moments / codex entries |
| [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md:1) | Skills Discovery system internals | [`SkillsSystem.js`](js/systems/SkillsSystem.js:1), [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) |

### 🟠 Archived 2026-05-29 (moved to `archive/`)

Heritage docs — completed work, real reference value, no forward planning.

| Doc | Status | Folded into |
|---|---|---|
| `archive/CEREMONY_REDESIGN.md` | Q2 net-launch ceremony shipped 2026-05-24 | HANDOFF Q2 section above |
| `archive/EPIC10_DEEP_ANALYSIS.md` | Epic 10 complete 2026-05-08 | HANDOFF Heritage (below) |
| `archive/EPIC10_IMPLEMENTATION.md` | Epic 10 implementation log V-1..V-11 | HANDOFF Heritage |
| `archive/EPIC10_VISUALIZATION_PLAN.md` | Epic 10 task breakdown + acceptance | HANDOFF Heritage |
| `archive/SK_M1_POLISH_HANDOFF.md` | SK/M1 polish cycle complete 2026-05-16 | HANDOFF §6.2 heritage para |
| `archive/CAPTURE_UX_AUDIT.md` | Capture flow UX audit (intent folded into §4 backlog) | §4 backlog items |
| `archive/DEPLOY_ANALYSIS.md` | GitHub Pages deployment investigation 2026-05-21 | (one-shot investigation, complete) |
| `archive/GPU_PROFILING_REPORT.md` | Sprint 3 GPU profiling — HIGH 11→3.5 ms shipped | (sprint complete) |
| `archive/PERF_SPRINT_REPORT.md` | PRs 1–6 perf sprint | (sprint complete) |
| `archive/PERF_FOLLOWUP_ANALYSIS.md` | Perf follow-up analysis | (sprint complete) |
| `archive/QUICK_WINS_PERF.md` | CPU-side per-frame wins audit | (sprint complete) |
| `archive/SPRINT_2_REPORT.md` | Sprint 2 (post-perf-sprint) | (sprint complete) |
| `archive/FINAL_ANALYSIS.md` | Old doc-state map; §5.4 Offline-First + §5A Indian Heritage **now inlined in HANDOFF Locked Product Principles** | Locked Product Principles section above |

### 🪦 Existing stubs (pre-2026-05-29) — also moved to archive

| Doc | Status |
|---|---|
| `archive/ARCHIVAL_PLAN.md` | Stub since 2026-05-16 (Phase 1–3 executed 2026-04-25) |
| `archive/ARM_PIVOT_GAPS_EXPLAINER.md` | Stub since 2026-05-16 (gaps resolved in Epic 9/10) |
| `archive/CAPTURE_NET_QA.md` | Stub since 2026-05-16 (folded into [`CAPTURE_NET.md`](CAPTURE_NET.md:1) Rev 4) |
| `archive/EPIC9_CODE_ORCHESTRATOR.md` | Stub since 2026-05-16 (Epic 9 complete 2026-04-28) |
| `archive/UX_FIXES_ROADMAP.md` | Stub since 2026-04-25 (16 UX issues complete) |
| `archive/POST_CINCH_QA_DESIGN_DOCS.md` | Stub created 2026-05-29 — Items 6/10/11 folded into [`GAME_DESIGN.md`](GAME_DESIGN.md:1) §4.0–4.1 + this file §4.9.2 #6 |

### Root layout — target end state (16 docs)

| Tier | Count | Files |
|------|-------|-------|
| 🟢 Canonical | 6 | README, HANDOFF, GAME_DESIGN, ARCHITECTURE, BIG_PICTURE, IMPLEMENTATION_PLAN |
| 🟡 Active reference | 10 | ARM_PIVOT_ANALYSIS, CAPTURE_NET, CROSSBOW_ARMS, DAUGHTER_ARM_CONTROLS, DAUGHTER_MULTITOOL_SPEC, DAUGHTER_RETRIEVAL_AUDIT, FIRST_EXPERIENCE, GAME_FLOW_BRAINSTORM, LEARNING_THROUGH_PLAY, SKILLS_ARCHITECTURE |
| **Root total** | **16** | (down from 35) |

---

## §8 Known Issues / Tech Debt

- Welcome Field debris may overlap if player orbit changes between resets.
- Drift-recovery message uses `setTimeout` (not frame-tied).
- No ETA/distance count-down in the AP chip — only phase shown.
- Discovery Pane (`bottom:180px; left:10px`) may collide with left-column panels on small viewports.
- `GAMEOVER_CONTINUE` uses direct `.reset()` calls on 3 systems (intentional).
- 6 remaining `_refs` in [`GameFlowManager.js`](js/systems/GameFlowManager.js:1): player, debrisField, armManager, cameraSystem, shopScreen, resourceSystem.
- [`StatusPanel.js:1506`](js/ui/hud/StatusPanel.js:1506) has a `TODO` placeholder for codex badge.
- CA Phase 3 not yet implemented (shop upgrades, chevron indicator, audio cues).
- V4 GSL upgrade path has stubs in [`ArmManager.js`](js/entities/ArmManager.js:1) but no implementation.
- **From AP work:** `ArmUnit` velocity integrated in real `dt` while ship orbit advances by `gameDt` — audit if arms visibly lag at high time-scale (§3.2).
- **M1 visibility predicate is tripled** in [`DebrisField.js`](js/entities/DebrisField.js:1) — checks `isMission1 && !welcomeSpawn` in 3 separate places. Should be centralised into `_isVisibleForCurrentMission(debris)`.
- **[`DebrisField.js`](js/entities/DebrisField.js:1) is 2093 LOC / 50+ methods** — split candidates: background, welcome-cluster, queries, update. See [`archive/SK_M1_POLISH_HANDOFF.md §5.2.B`](archive/SK_M1_POLISH_HANDOFF.md).
- **[`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) is 1869 LOC** — refactor candidate (not urgent).
- **From mission-ops audit:** [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) computes rich cluster metadata that only [`TrawlManager`](js/systems/TrawlManager.js:14) consumes — no player-facing surface (§4.8.A).
- `scoring.missionNumber` computed on the fly from `debrisCleared / 5` — no explicit mission lifecycle events; §4.8.C spawn profiles will need a `MISSION_START` event.
- **ST-5.2 Trail System disabled** ([`Constants.TRAILS.ENABLED: false`](js/core/Constants.js:1291)). All wiring + 54 tests in place but `THREE.Line` is 1px on WebGL (macOS/Chrome limitation). Needs `THREE.Line2`, `THREE.Points`, or Canvas2D overlay. See [`archive/HANDOFF_AUTOPILOT_RETRO.md §2.2`](archive/HANDOFF_AUTOPILOT_RETRO.md).
- **Confirmed orphaned wiring** (pending fix per §3.8): [`TetherReel.js`](js/systems/TetherReel.js:1), [`BridleRing.js`](js/entities/BridleRing.js:1) — neither imported nor init'd/update'd in [`main.js`](js/main.js:1). Web Shot ([`fireWebShot`](js/entities/ArmUnit.js:953)) has no keyboard binding. See [`DAUGHTER_RETRIEVAL_AUDIT.md §4`](DAUGHTER_RETRIEVAL_AUDIT.md:1).

---

## §9 Heritage — Prior Work Summaries

> Each prior shift gets one paragraph + archive link. Full write-ups are in the linked archive docs.

### 9.1 Epic 8 — Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage (2026-04-25, COMPLETE)

5 sprints, ~6 dev days. Test delta: +34 suites / +92 tests. 0 regressions. Key deliverables: STATION_KEEP state, orbital-crane controls, dual-metal FEEP (7 metals), news-driven missions, ISRO comms personas (BANGALORE/HASSAN), ReputationSystem. 6 files created, 18 modified. Sets up the "Indian heritage" Locked Principle (§ Locked Product Principles).

### 9.2 Epic 9 — Config G Arm System (2026-04-28, COMPLETE)

All 11 C-tasks delivered: Config G constants + 3-plane geometry, meridian sweep aim + lockable hinge, stow/deploy state machine, launch sequence + ROSA cinematic, capture net (14-state FSM, 3 net classes), strut-mounted tether reel, bridle ring, CoM tracking + thruster plume interlock, tech ladder Y0→Y1→Y3 with TRL gating, integration tests. **25 feature flags** (11 new), **~25 new events**, **~16 files created, ~30 modified.** Config G mass budget (canonical): Y0 dry = 196.4 kg, wet = 242.4 kg. See `archive/EPIC9_CODE_ORCHESTRATOR.md` stub.

### 9.3 Epic 10 — Config G Full Visualization (2026-05-08, COMPLETE)

The V3 Octopus visual is gone. Replaced by Config G: cylindrical barrel, collar-mounted struts with sweep animation, ROSA roll-out panels, FEEP nozzle polish, deploy-state LEDs, full stowage visual, launch cinematic, capture net visual, tier progression visual. All 11 V-tasks delivered (V-1..V-11; ST-9.6 ablation cancelled; ST-9.9 Reality Mode deferred to Epic 11+). Full visual API surface in [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) `_buildModel()` + companion `LaunchCinematic.js`, `CaptureNetVisual.js`, `TierVisualManager.js`. **Spacecraft anatomy reference:** Barrel (0.4m R × 2.0m H) + Collar ring (Z=+0.90m, 4 hinge brackets at 60°/120°/240°/300°) + Struts (1.60m, sweep 0–180°) + Tip nodes (daughter mount points) + ROSA panels (2.0m chamfered, roll-out). See `archive/EPIC10_VISUALIZATION_PLAN.md` for V-task spec, `archive/EPIC10_DEEP_ANALYSIS.md` for visual design + hinge spec, `archive/EPIC10_IMPLEMENTATION.md` for implementation patterns.

### 9.4 SK / Mission-1 Polish Cycle (2026-05-16, COMPLETE)

Seven polish tasks + two mid-flight additions + two diagnostic bug fixes. Test suite: 460 suites / 2060 tests / 0 failures. Key changes: SK standoff zoom 4–12 m with mouse-wheel (with [`STATION_KEEP.WHEEL_STEP_M: 0.5`](js/core/Constants.js:1)), sonar-ping restoration, mother AP `hasLockedTarget` HOLD suppression at [`AutopilotSystem.js:678`](js/systems/AutopilotSystem.js:678), M1 2 km debris cull (3-layer defence in [`DebrisField.js`](js/entities/DebrisField.js:1)), SkillsPane visibility gating, "Press any key" + ADR credits on opening screen. **Biggest lesson (L1):** A backtick inside a template literal broke the browser silently — no console error, no test failure. `node --check <file>` catches this; the test runner does not. Full file-by-file breakdown in `archive/SK_M1_POLISH_HANDOFF.md`.

### 9.5 Daughter SK + Salvage-Loop Wiring Pass (2026-05-17)

Capture-net + STATION_KEEP + R/F/ESC keymap end-to-end. Five distinct bugs in daughter-arm wiring fixed; manual-mode + wiring-gap patterns established (see §3.8). Key fixes: (1) [`ArmUnit._updateTransit`](js/entities/ArmUnit.js:2351) + [`_updateApproach`](js/entities/ArmUnit.js:2532) manual-mode blocks now contain state-transition checks before `return;`. (2) [`reelFromStationKeep()`](js/entities/ArmUnit.js:3048) — new method exits SK → REELING (zero-fuel strut motor), not RETURNING (FEEP-powered). (3) [`ArmManager._initArms()`](js/entities/ArmManager.js:219) — `initNetInventory()` now called. (4) [`main.js`](js/main.js:322) — `captureNetSystem.init()` + `update()` now wired. (5) [`index.html:352`](index.html:352) importmap switched from CDN to `./node_modules/three/` for offline boot (Locked Principle #1). (6) Three-part fix for [`CaptureNet._updateFlight`](js/entities/CaptureNet.js:277): read `_scenePosition / M`, arm-relative co-orbiting frame, `_firedNet` stored reference. **Salvage state chain (capture path):** `STATION_KEEP --F--> NETTING --(net.CAPTURED)--> GRAPPLED --(stabilize 1.5s)--> REELING --(reach mother)--> DOCKING --> RELOADING --> DOCKED`. Detached arms: GRAPPLED → DEORBITING. **Salvage exits without capture:** [`recallFromStationKeep()`](js/entities/ArmUnit.js:3041) → RETURNING (FEEP) | [`reelFromStationKeep()`](js/entities/ArmUnit.js:3052) → REELING (zero-fuel, preferred for out-of-fuel daughters) | target lost in SK → `_exitStationKeep()` → RETURNING. **Daughter control keymap during SK:** ←→↑↓ orbit (θ yaw / φ pitch), Wheel = standoff zoom (4–12 m), F = fire net, R = reel-in, ESC = recall, Shift = ¼-rate fine mode. Companion doc: [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md:1) audits the OTHER retrieval methods for the same wiring-gap pattern.

### 9.6 Earlier work

- **Doc Consolidation Apr 25, 2026** — Executed `ARCHIVAL_PLAN.md` (stub since 2026-05-16). Archived UX_FIXES_ROADMAP.md, trimmed BIG_PICTURE.md and HANDOFF.md.
- **Sessions S19–S30** — Autopilot trailing-rendezvous rewrite + trail system. See [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md).
- **2026-05-07 Debug Session** — G-key camera + strut deployment regression fixes (8 fixes + 9 improvements in CameraSystem/InputManager/ArmUnit/PlayerSatellite/Constants). Established the 3-phase launch ceremony (OBSERVE 2.25s + TETHER_FOLLOW 3.0s + HANDOFF 0.75s).

---

## §10 Convention reference card (quick lookup)

For new contributors — copy the load-bearing rules into one place:

| Rule | Source | TL;DR |
|---|---|---|
| Object3D vs Camera lookAt | §2 Rule 1 | Camera: −Z forward; Group/Mesh: +Z forward; pass `lookAt(pos − dir × ε)` to point local −Z along `dir` |
| Matrix4 lookAt sign | §2 Rule 2 | `mat.lookAt(eye, target, up)` ⇒ local +Z = `eye − target` (away from target) |
| Scene units | §2 Rule 3 + §3.7 | `M = 1e-5` (metres → scene units). Entity `.position` in metres; Object3D `.position` in scene units |
| Geometry default axes | §2 Rule 4 | Cone/Cylinder: Y-axis. Apply `geo.rotateX(PI/2)` at construction for Z-aligned |
| Quaternion sources | §2 Rule 5 | Use named module-scope const vectors for `setFromUnitVectors` |
| Hotkey audit | §3 Rule A | 6 sites: InputManager + Constants + 2× StatusPanel + system docstring + README (×3 in README) |
| FSM state lookup | §3 Rule B | Use `Set.has(state)` not `||` chains when enumerating sibling states |
| Visual ↔ camera coupling | §3 Rule C | Geometry constants and camera offsets must reference each other in comments |
| LOD predicate | §3 Rule D | `_isUserEngaged(debris)` ORs all engagement flags |
| Empty-action feedback | §3 Rule E | (event, audio, comms) — all three or it feels broken |
| Y-up vs Z-up | §3.1 | Three.js Y-up; orbital textbooks Z-up; round-trip needs `y↔z` swap |
| `gameDt` vs `dt` | §3.2 | `gameDt = dt × TIME_SCALE_GAMEPLAY` (10×). Physics-per-tick MUST use `gameDt` |
| AP impulse API | §3.3 | `_applyThrust` = element rates (legacy). `applyCartesianImpulse` = world-frame ΔV (modern) |
| CA exemption | §3.4 | Both `_activeTargetId` and `_autopilotLockId` must be cleared/set |
| Wiring-gap | §3.8 | A system class with `init()` + `update()` is silently dead if `main.js` never calls them |

---

*End of streamlined HANDOFF (~820 lines, down from 1668 on 2026-05-28). Heritage write-ups are in `archive/`; this file's §9 summarises them.*
