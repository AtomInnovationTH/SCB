# Mother-Net Capture Ceremony & Physics

Make the Mother net (the "N" verb on Mission 1) a believable, visible, physical
capture: a visible throw from a front launcher, a net that opens and cinches,
real reel-in tension that can pull the ship, and a catch that is delivered to
hull cargo and fed to the furnace — instead of the current "fire from ship
centre, teleport to contact, vanish into nothing for a flat +500."

## Scope & decisions (locked with user)

- **All 6 items, risk-ordered into 4 phases.** Phases 1–2 are detailed for
  immediate implementation; phases 3–4 are fully specified but staged.
- **Item 5 — reel-in physics:** real mass-driven tension + a subtle centre-of-mass
  pull toward the catch, with tangle/break risk, **gated OFF on Mission 1 and for
  ≤ `LASSO_MAX_CAPTURE_MASS` (10 kg) welcome pieces**; meaningful only for heavier
  later catches.
- **Item 6 — catch resolution:** route the Mother-net catch through a real
  **stow → clamp/slice → furnace** pipeline that reuses the existing daughter
  `FURNACE_TRANSFER` staging + `CATCH_PROCESSED` salvage/score path. This changes
  the Mother-net economy from a flat +500 to salvage-on-process.

## Critical framing fact

Two net systems exist. **"N" on M1 = `LassoSystem`**
(`InputManager.fireLasso()` `js/systems/InputManager.js:2016` → `LassoSystem.fire()`
`js/systems/LassoSystem.js:632`). The elaborate cone/drawstring "ceremony"
(`js/ui/CaptureNetVisual.js`, flag `NET_CEREMONY`) is driven by `NET_FIRED`/
`NET_CATCH_SUCCESS` from `CaptureNetSystem` (daughter / Config-G nets) and is
**never seen on M1**. All work here targets `LassoSystem` + a new stow path,
reusing daughter `FURNACE_TRANSFER` plumbing where noted.

## Verified anchors (current behavior)

- **Launch origin = ship centre.** `LassoSystem.js:790` `this.projectilePos =
  playerPos.clone()`; tether rebuilt `playerPos → projectilePos` every frame
  (`:1093`); `_muzzleFlash` at ship centre (`:351`).
- **Throw is invisible on the guided catch.** Contact fires at `distToTarget <
  M*20` (20 m) `:1001`. Guided #1 is pinned at ~22 m, so flight ≈ 2 m ≈ **0.02 s**
  at the 100 m/real-s flight rate (`LASSO_SPEED 10 × TIME_SCALE_GAMEPLAY 10`,
  `:1042`, `Constants.js:140`). #2 (~48 m) ≈ 0.28 s.
- **Net is rigid + decorative.** Octagonal `LineSegments` ring radius
  `NET_PERIMETER_RADIUS=4`, 4 rim weights `NET_WEIGHT_RADIUS=1.5`, gyroscopic spin
  `NET_SPIN_HZ=4` (`:1072`). No open/close; reel-in just scales group 1.0→
  `NET_COMPACT_SCALE=0.45` over `_reelProgress ∈ [0,0.2]` (`:956-963`).
- **Recoil is a compensation, not a kick.** `LASSO_FIRED` (`:817`) →
  `AutopilotSystem._applyRecoilCompensation` (`:1182-1221`) applies
  ΔV=(2.5·10)/m ≈ 0.19 m/s via `applyCartesianImpulse(reactionDv, 0)` **only in AP
  HOLD**. `RECOIL_PHYSICS=false` (`Constants.js:809`); no torque anywhere.
  `applyCartesianImpulse` (`PlayerSatellite.js:4053`) **charges fuel/power** — wrong
  channel for recoil. Fuel-free, self-damping channel is `_rcsVelocity`
  (`PlayerSatellite.js:2297-2303`, `:3726`; used by collision dodge
  `CollisionAvoidanceSystem.js:571-583`).
- **Reel ignores mass.** Fixed `LASSO_REEL_SPEED=0.33` (`:940`); `TETHER_TENSION`
  carries `tensionFraction=_reelProgress` (`:949`) — progress, not Newtons.
  (CaptureNet models real `tensionN=1+mass·0.1` at `CaptureNet.js:878` — reusable
  pattern.)
- **Catch vanishes for flat points.** `_completeCatch` `:1100-1145`:
  `removeDebris` immediately (`:1105`), `LASSO_CAPTURED`/`ARM_CAPTURED`/
  `INTERACTION_CAPTURE`/`SCORING_AWARD` flat `TIER3_BASE=500`, 2 s cooldown. No
  cargo, no salvage, no furnace.
- **`ARM_CAPTURED` "juice" is audio only** (`AudioSystem.js:213`); no slo-mo/flash
  despite the `:1116` comment.
- **Geometry:** nose **+Z = forward/prograde** (optics/laser), **−Z = aft**
  (FEEP/RCS thrusters + dock) (`PlayerSatellite.js:2162`); struts at azimuths
  `[60,120,240,300]°` (`ARM_LADDER.Y0_QUAD`); nose auto-tracks velocity
  (`_orientAlongVelocity()` `:2307`). Local frame basis (prograde/radialUp/
  crossTrack) is already computed in `PlayerSatellite.js:3705-3715`.
- **Stow precedent:** daughter parks a catch at `arm.position + holdDir ×
  (sizeMeter/2 + ARM_HOLD_CLEARANCE_M)` (`ArmUnit.js:4443`,
  `_pinCatchToSelf`). Debris drag during haul uses `_armPinned`/`_armPinPos`
  (`LassoSystem.js:988-993`). Furnace staging `HOLD 2s → CHOP 5s → FEED 9s →
  CATCH_PROCESSED` (`Constants.FURNACE_TRANSFER`, `Constants.js:376`;
  `GameFlowManager.js:700-759`).

---

## PHASE 1 — Make the throw real (Items 1, 2, 4)

Highest reward / lowest risk / highest visual. The first successful capture is
the signature moment and is currently invisible. Pairs the visible launch point
(2) with the visible flight (1) and a cosmetic kick (4).

### 1A. Visible throw (Item 1)
**File:** `LassoSystem.js` flight→contact transition (`:1001`), `fire()` (`:785-799`).

- Add a **minimum visible flight duration** so even a point-blank guided catch
  shows an arc. Introduce `Constants.LASSO_MIN_FLIGHT_TIME` (~0.45–0.6 s real).
  Gate the contact test so it cannot trigger before `flightTimer >=
  LASSO_MIN_FLIGHT_TIME` (still also requires proximity). This guarantees the
  player sees the net leave the canister and travel.
- **Shrink the contact radius** from the flat `M*20` (20 m) to a value that
  scales with target distance / net size so a 22 m target doesn't insta-contact:
  `contactRadius = min(NET_PERIMETER_RADIUS_M, 0.35 × launchDistance)` clamped to
  a small floor (e.g. 3–6 m). New constant `LASSO_CONTACT_RADIUS_M` (or derive).
  Preserve the v2e offset-sign fix at `:1003-1011` exactly (use `_projOffset`,
  never `projectilePos − playerPos`).
- **Ease the flight speed** to a constant apparent throw that reads at human
  scale over `LASSO_MIN_FLIGHT_TIME` rather than the current 100 m/real-s blink
  for near targets. Keep far targets within `LASSO_MAX_FLIGHT_TIME=8`.
- **Catch hit-stop (juice):** on `LASSO_CONTACT`, emit a short, gated time-scale
  dip (hit-stop) + bracket flash so contact registers. Implement as a new
  optional juice hook (small, M1-friendly; respects "not an arcade game" — keep
  ≤120 ms, subtle). This is the only place we add "juice"; verify it does not
  fight onboarding or autopilot.

**Risk:** MED. The flight/contact path has a historical offset-sign bug
(`:1003`). Mitigation: do not touch `_projOffset` math; only add a time gate +
radius parameter. Regression-test that #1 and #2 still capture and that the
onboarding `tease_lock`/`second_catch` beats still satisfy.

### 1B. Front-center launcher canister + nose-anchored tether (Item 2)
**Files:** `LassoSystem.js` (`_createVisuals` `~:207-418`, `fire()` `:785-822`,
`update()` net/tether positioning `:1060-1094`); a muzzle offset helper.

- Define a **launcher muzzle offset** in the mother's local frame: along the nose
  (+Z / prograde) at the front face. New constant
  `LASSO_MUZZLE_OFFSET_M` (forward distance) + optional small radial offset.
  Compute world muzzle as `playerPos + progradeDir × LASSO_MUZZLE_OFFSET_M`
  (prograde = the already-passed `playerVelDir`; fall back to +Z). Reuse the
  prograde basis (cf. `PlayerSatellite.js:3705-3715`).
- **Spawn the projectile and anchor the tether at the muzzle**, not `playerPos`:
  `this.projectilePos = muzzleWorld.clone()`; `_projOffset` starts at the muzzle
  offset relative to player; `_rebuildTetherGeometry(muzzleWorld, projectilePos)`
  (`:1093`); `_muzzleFlash.position = muzzleWorld` (`:351`).
- **Add a small canister/launcher prop** at the nose so the net visibly emerges
  from hardware. Two options: (a) add a lightweight canister mesh to the mother
  model in `PlayerSatellite._buildModel` at the +Z front face; or (b) a canister
  mesh owned by `LassoSystem` positioned at the muzzle each frame. Prefer (a) for
  a permanent hull feature; (b) is lower-risk/self-contained. **Decide at
  implementation** (lean (b) first for isolation, promote to (a) if it should be
  always-visible hull hardware).

**Risk:** LOW. Pure visual offset + a prop. No physics change. Verify the tether
no longer originates from the hull centroid and the muzzle tracks the nose as the
ship reorients.

### 1C. Cosmetic launch recoil (Item 4)
**Files:** `PlayerSatellite.js` (mesh group), `LassoSystem.fire()` emit, or an
`LASSO_FIRED` listener.

- The real recoil ΔV (~0.19 m/s) is invisible and the impulse API costs fuel — so
  do recoil as a **visual-only model kick**: a brief spring offset/shudder of the
  mother mesh opposite the launch direction that springs back over ~0.3 s. No
  orbit change, no fuel, no `_rcsVelocity`. Implement as a transient local mesh
  offset (e.g. on the model group) decaying with a critically-damped spring.
- Optionally add a tiny **muzzle puff** at the canister (reuse `_muzzleFlash`).
- Explicitly **do NOT** apply an orbital/RCS impulse here — that risks disturbing
  the M1 pin / station-keep. The existing AP-HOLD compensation (`:1218`) stays as
  is.

**Risk:** LOW. Self-contained cosmetic. Verify no drift on M1 and the kick reads
without nausea.

**Phase 1 tests:** `LASSO_MIN_FLIGHT_TIME` enforced (contact cannot fire before
it); contact radius scales and #1/#2 still capture; muzzle offset places spawn/
tether at nose not centroid; onboarding beats still satisfy (mock/integration).

---

## PHASE 2 — Make the net behave (Item 3)

Believable kinematic open-on-launch + cinch-on-capture. **Not a cloth/physics
sim** — a parameterized geometry animation. Medium reward, medium risk, high
visual.

**Files:** `LassoSystem.js` `_createVisuals` (`~:207-418`), `update()` net block
(`:1060-1082`), reel block (`:954-993`).

- **Spin-up open:** the net leaves the canister compact and **opens over a
  spin-up window** as gyroscopic spin ramps — rim weights swing outward to the
  full `NET_PERIMETER_RADIUS` over `~SPIN_UP_TIME` (cf. CaptureNet
  `SPIN_UP_TIME=0.5`). Parameterize the ring radius + weight radius by an
  `openFrac(t)` driven by spin. This is the "fast enough to stay open" answer:
  model it as **spin ramps → centrifugal opening**, a kinematic mapping (spin Hz →
  open fraction), not a force sim.
- **Cinch-close on contact:** replace the plain scale-shrink (`:959-963`) with a
  **drawstring cinch** — the mouth radius closes around the debris over the WRAP
  phase, weights drawing together, so it reads as "bag closing on the catch."
  Reuse the WRAP `[0,0.2]` window; map to a closing `cinchFrac`.
- Keep the 4 Hz gyroscopic spin as the visual carrier; tie spin rate to the
  open/close state (spin-up while opening, settle during haul).
- Optionally unify the look with the daughter ceremony's color language
  (`CaptureNetVisual._updateCeremonyState` `:690`) for consistency — flight blue
  → contact yellow → cinch — without depending on its event stream.

**Risk:** MED. Contained to LassoSystem visuals; no gameplay/physics change. Risk
is mostly visual tuning + not regressing the reel scale behavior. Add a feature
flag (`LASSO_NET_KINEMATICS`) so it can be toggled during tuning.

**Phase 2 tests:** openFrac/cinchFrac are monotonic and clamped [0,1]; ring +
weight radii follow them; reel still completes; no NaNs in geometry rebuild.

---

## PHASE 3 — Make it physical: reel-in tension & mother motion (Item 5)

Higher-risk physics. **Gated OFF on M1 and for ≤10 kg pieces.** Real mass-driven
tension, a subtle CoM pull, and tangle/break risk for heavier later catches.

**Files:** `LassoSystem.js` reel block (`:938-993`), `_completeCatch` (`:1100`),
new failure path; `PlayerSatellite._rcsVelocity` channel; `Constants.js`.

- **Mass-driven tension:** replace `tensionFraction=_reelProgress` (`:949`) with a
  real `tensionN = base + capturedMass × k` (mirror `CaptureNet.js:878`). Drive
  HUD/tether tautness + audio from real tension.
- **Reel-in pulls the mother (momentum):** while reeling a mass `m` toward the
  ship over the tether, apply an equal/opposite **CoM nudge toward the catch** via
  `_rcsVelocity` (fuel-free, self-damping) — magnitude scaled by `m / m_ship` and
  reel rate. The catch likewise reels faster/slower based on relative mass
  (closing both ends, not just the debris). Keep it subtle; clamp via existing
  `RCS_MAX_SPEED`.
- **Tangle / break risk:** if tension exceeds a safe fraction
  (`NET_STRAIN_SAFE_FRACTION=0.8`, `BREAKING_TENSION_N` — see `Constants.js:1001`)
  for too long, or reel is fought by thrust, roll a **tether break/tangle**
  failure → emit `LASSO_TANGLED`/`LASSO_SNAPPED`, drop the catch, cooldown. This
  is the depth: heavy catches need steady hands / detumble first.
- **Gating (mandatory):** all of the above is **disabled when
  `isMission1` OR `capturedMass ≤ LASSO_MAX_CAPTURE_MASS` (10 kg)**. M1 welcome
  pieces are all ≤10 kg, so the first-time experience is unchanged — the throw +
  cinch + reel still feel great but cannot punish a new player. Activates on
  later missions / heavier catches.

**Risk:** HIGH. Touches ship motion + adds failure modes. Mitigation: the M1/mass
gate keeps it entirely out of the onboarding; feature-flag
(`LASSO_REEL_PHYSICS`); extensive tests that M1 reels exactly as today.

**Phase 3 tests:** with `isMission1` or mass ≤10, no `_rcsVelocity` delta, no
break rolls, reel timing identical to current; with mass >10 on M2, tension rises
with mass, CoM nudge is bounded by `RCS_MAX_SPEED`, break path fires above
threshold and drops the catch cleanly (no orphaned pins).

---

## PHASE 4 — Make it go somewhere: stow → clamp/slice → furnace (Item 6)

Biggest feature, highest visual payoff, largest scope. Replaces instant
`removeDebris`+flat-500 with a real lifecycle reusing the daughter furnace path.

**Files:** `LassoSystem._completeCatch` (`:1100`), new stow controller (new file
e.g. `js/systems/MotherCargoSystem.js` or extend an existing cargo system),
`PlayerSatellite._buildModel` (aft cargo anchors), `Constants.js`
(`FURNACE_TRANSFER`, new cargo caps), `GameFlowManager.js:708` (`CATCH_PROCESSED`).

### 4A. Hull cargo anchors (aft netting between struts)
- Define **N cargo cells** in the mother local frame at the **aft (−Z) end,
  between struts** (azimuths offset from `[60,120,240,300]°`), expressed in the
  prograde/radial/crossTrack basis (cf. `PlayerSatellite.js:3705-3715`). Add a
  light **cargo-netting prop** per cell to the model so stowed catches read as
  "cargo in netting near the thruster end."
- Capacity constant `MOTHER_CARGO_CELLS` (e.g. 3–4). Reuse the
  `MAGAZINE_SIZE`/inventory pattern conceptually.

### 4B. Reel routes to a cargo cell, not the ship centre
- Change the REEL target (`:975-978`) so the package lerps from contact to the
  **chosen empty cargo cell offset** (player-relative), not `_zeroVec` (centre).
  Keep `_armPinned`/`_armPinPos` driving the debris (`:988-993`); on arrival, pin
  the debris to the cell anchor (persisting on the hull) instead of removing it.
- This is literally "how the package is moved so the front is clear": the catch
  is hauled to the **aft** cells, leaving the **forward** canister clear for the
  next launch.

### 4C. Clamp / slice-free hand-off
- On reel-complete, a **clamp/arm grabs the net base and slices it free** of the
  tether (the user's model): emit `LASSO_STOWED` + a short clamp animation; the
  net mouth stays cinched on the debris in the cell; the tether detaches and the
  launcher resets/reloads (consume one `_ammo`, already decremented at fire).
- The debris now lives in a **STOWED** state pinned to the cell anchor (reuse the
  hold-catch offset math `ArmUnit._pinCatchToSelf` `:4443` as the pattern).

### 4D. Furnace feed (reuse daughter pipeline)
- When the furnace is ready (and the catch is at the head of the cargo queue),
  run the **staged breakdown** using `Constants.FURNACE_TRANSFER`
  (`HOLD 2s → CHOP 5s → FEED 9s`), emitting `CATCH_BREAKDOWN_START` then
  `CATCH_PROCESSED` for this debris id. The **existing** `CATCH_PROCESSED` handler
  (`GameFlowManager.js:708`) then does salvage extraction + scoring + `removeDebris`
  — so the Mother-net catch now yields **salvage (xenon/indium/metals/…) instead
  of a flat +500**, consistent with daughter catches.
- **Remove the instant resolution** from `_completeCatch`: it no longer calls
  `removeDebris`/`INTERACTION_CAPTURE`/flat `SCORING_AWARD`. Scoring/removal move
  to `CATCH_PROCESSED`. Keep `LASSO_CAPTURED` (tutorial/onboarding advance) firing
  at **stow** time so the `tease_lock`/`second_catch`/`first_catch` beats still
  advance promptly (they key off capture events, not furnace completion).
- **Capacity full:** if all cargo cells are occupied, either block new launches
  with a comms hint ("Cargo full — furnace processing") or auto-prioritize feeding
  the furnace. **Decide at implementation;** default to a soft block + hint.

**Risk:** HIGH (new lifecycle, debris-removal relocation, double-score avoidance,
onboarding timing). Mitigations:
- **Preserve onboarding cadence:** fire `LASSO_CAPTURED`/`ARM_CAPTURED` at stow
  (not furnace end) so beats and reacquire (`AUTOLOCK.REACQUIRE_DELAY_MS=800`)
  behave as today. Verify `first_catch`/`second_catch` autoAdvance windows
  (6000/—) still fit.
- **No double scoring:** scoring happens exactly once, at `CATCH_PROCESSED`.
- **Feature flag** `MOTHER_CARGO_STOW`; when off, fall back to current
  instant-remove `_completeCatch` so the feature can be staged/tuned.
- **M1 consideration:** confirm with playtest whether M1 should use the full
  furnace economy or keep the simple flat-500 for the very first mission (the
  flag + an `isMission1` check can keep M1 on flat-500 while M2+ uses salvage, if
  the furnace ceremony is too heavy for the tutorial). **Open question flagged
  below.**

**Phase 4 tests:** reel routes to an aft cell offset (not centre); stow pins
debris to the cell and does not remove it; furnace stage emits
`CATCH_BREAKDOWN_START`+`CATCH_PROCESSED` once; `removeDebris` happens exactly
once at process; scoring fires once; `LASSO_CAPTURED` still fires at stow so
onboarding advances; capacity-full path blocks/hints; flag-off restores current
behavior.

---

## Cross-cutting

- **New constants** (all in `js/core/Constants.js`): `LASSO_MIN_FLIGHT_TIME`,
  `LASSO_CONTACT_RADIUS_M`, `LASSO_MUZZLE_OFFSET_M`, `LASSO_REEL_PHYSICS` (flag),
  `LASSO_NET_KINEMATICS` (flag), `MOTHER_CARGO_CELLS`, `MOTHER_CARGO_STOW` (flag),
  plus reuse of `NET_STRAIN_SAFE_FRACTION`/`BREAKING_TENSION_N` and
  `FURNACE_TRANSFER`.
- **Feature-flag every risky phase** (2/3/4) so each can ship/tune independently
  and fall back to current behavior.
- **Onboarding is sacred:** every phase must leave the M1 guided first/second
  catch feeling at least as good and never harder. Phases 3 & 4 are explicitly
  gated/flagged to keep M1 safe.
- **Tests:** `node js/test/run-tests.js` green after each phase (was 3431). Add
  per-phase unit tests above; keep `test-OnboardingDirector.js` /
  `test-InputManager-Hotkeys.js` green (they gate the tutorial cadence).
- **Verification (playtest):** clear `localStorage['spacecowboy_onboarding_v1']`,
  start M1, press N on #1: confirm visible launch from the nose canister, a
  readable throw arc, net opens then cinches, reel to (Phase 4) an aft cargo cell,
  clamp/slice, furnace feed + salvage. Confirm front canister is clear for the
  next launch. Sanity later mission for Phase 3 tension/break on a heavy catch.

## Suggested sequencing

1. **Phase 1** (1A visible throw → 1B canister/tether → 1C cosmetic recoil) — ship
   first; immediate, low-risk transformation of the first-capture moment.
2. **Phase 2** net open/cinch kinematics.
3. **Phase 3** reel physics (gated/flagged).
4. **Phase 4** stow→furnace lifecycle (gated/flagged; largest).

## Open questions to resolve during implementation

- **Canister as permanent hull hardware** (model in `_buildModel`) vs
  LassoSystem-owned prop? (Lean prop-first.)
- **M1 economy:** does the very first mission use the full furnace/salvage
  resolution (Phase 4) or stay on the simpler flat-500 while still showing the
  stow animation? (Flag + `isMission1` can split it.)
- **Cargo-full behavior:** soft-block launches with a hint vs auto-feed furnace.
