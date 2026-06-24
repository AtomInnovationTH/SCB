# Unify the Capture-Net Visual — one elegant "web in space" for Mother + Daughter

> **Goal (owner's words):** *"A net in space can be simple, elegant, beautiful web."* The current
> Mother net reads as *"cold shit — big, clunky, obnoxious."* Replace the Mother net's rejected
> look and **unify Mother + Daughter on ONE shared net vocabulary** (handoff option **B**), keeping
> every functional/lifecycle win from commits `e5609e6`→`b593dbf`. Browser-playtest before "done".

> 🛑 **NEXT TEAM START HERE → [§10 Implementation Handover (Session 2)](#10-implementation-handover-session-2--read-this-first).**
> Sections 0–9 are the original plan. §10 records what was actually built, what was tried, what the
> owner rejected, the **still-unsolved aesthetic problem** (the net still reads as "cold shit /
> jagged"), and the owner's **fresh-look question: should the Mother net simply *be* the Daughter net
> (same ceremony, same launch sound, same mechanics) differing only in size + range?**

---

## 0. Big picture — why the net visual is load-bearing for the whole sim

The net is not a cosmetic detail; it is **the core verb and the core delight** of the entire game, and
its visual carries three of the sim's foundational theses at once. Fixing it is high-leverage; getting
it wrong undermines the product's identity.

1. **It is THE payoff moment.** [`GAME_DESIGN.md`](GAME_DESIGN.md) §1 states the core delight verbatim:
   *"Watching an arm you deployed autonomously navigate to a tumbling rocket body, **unfurl its net,
   cinch it closed, and haul it back**."* The capture cinematic — net opens, envelops, cinches, reels —
   **is** the reward loop. Debris capture is the game; the net is how capture is *seen*. A net that reads
   as a chrome cage cheapens the single most-repeated delight in the sim.

2. **It must serve the "small child holding a large balloon" thesis.** [`GAME_DESIGN.md`](GAME_DESIGN.md)
   §2.1 makes scale-tension a hard design rule: the Mother is *tiny* (~2 m barrel, 196 kg dry); catches
   are *huge* (3–8 m bodies, 500–2000 kg sats). *"Every capture cinematic must read this scale tension."*
   → **The rejected Mother net inverts the thesis.** At **8 m diameter with four 3 m chrome boulders** it
   makes the *tool* bigger than the *operator* and lets the net compete with the catch for "biggest, most
   solid object in frame." That is not merely ugly — it **destroys the core compositional intent**. The
   net must read as a **delicate web the small operator casts around an improbably large prize**; the
   *catch* stays the visual subject.

3. **It is the curriculum's first lesson and TRL anchor.** The net is the Y0, **TRL-9** baseline tool
   (real **RemoveDEBRIS 2018** heritage); the tool ladder = difficulty = curriculum = TRL tree
   ([`ROADMAP.md`](ROADMAP.md)). The Codex teaches it as *"a purse seine in orbit"* and *"the spider
   builds a better shape; we build a stronger thread"* ([`CAPTURE_NET.md`](CAPTURE_NET.md) §9). A fine,
   woven, **spider-web** look makes that lesson land; a metal cage contradicts the very words on screen.

4. **One verb across two zones — unify the vocabulary.** Capture happens in concentric zones
   ([`GAME_DESIGN.md`](GAME_DESIGN.md) §3): the **Lasso zone (50–200 m) = the Mother net (`LassoSystem`)**
   and the **Crossbow zone (2–10 km) = the Daughter nets (`CaptureNetSystem`)**. Mechanically distinct,
   but to the player they are **one capture language: the web**. Today they look like two unrelated
   objects. Unifying the visual literally unifies the concept the player is learning — which is exactly
   the owner's ask and handoff option **B**.

**Therefore the fix is strategic, not cosmetic:** make ONE elegant, restrained, translucent **web** the
shared visual vocabulary of debris capture across the whole sim — sized and styled to preserve scale
tension, reinforce the RemoveDEBRIS/purse-seine/spider lesson, and keep the catch as the hero of every
capture. Treat the look with the same rigor as the physics. (Future hook, parked: the Dyneema→Graphene
material ladder, `CAPTURE_NET.md` §2.7, could let the web's fineness/sheen *evolve with tech tier* — a
ready-made educational upgrade once the shared kit exists.)

---

## 1. Deep findings — accurate current state

### 1.1 Two completely separate net code paths
| | **Mother net** | **Daughter net** |
|---|---|---|
| File | [`js/systems/LassoSystem.js`](js/systems/LassoSystem.js) (2023 LOC) | [`js/ui/CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) (1116 LOC) |
| Trigger | **`N`** key on M1 → `InputManager.fireLasso()` → `LassoSystem.fire()` | `NET_FIRED`/`NET_CATCH_*` events from `CaptureNetSystem` (daughter arms) |
| Drive | **Self-contained.** Builds meshes in `_createVisuals()` (:419); drives per-frame in `update()` via `_applyNetMouthRadius()` (:694) + `_setNetOpacity()` (:675) + spin; owns its tether. | **Event-driven FSM.** Reads a `NetProjectile` (state/spinRate/position/launchDirection/netClass/stateTimer/catchResult); animates a ceremony in `_updateCeremonyState()` (:690), keyed by `armIndex`/`podIndex`. |
| First seen | **Mission 1** (first capture — the signature moment) | Mission 2+ (after daughters deploy) |

The two share **nothing**. `pod_*` net support exists in `CaptureNetVisual` but **no code ever fires a
pod net** — dormant. So the Mother is 100% `LassoSystem`, and is what every new player sees first.

### 1.2 Why the Mother net looks bad — exact numbers (this is a SCALE problem)
Rendered ship (`OCTOPUS_V5`, [`Constants.js`](js/core/Constants.js):613): core **2.0 m** long × **0.8 m**
across flats; struts 1.6 m; ROSA panels 2.0 m → full span ≈ **5–6 m**.

The Mother net (`_createVisuals` :419, constants :1667–1682) is built from:
- An **octagon `LineSegments` ring + 4 cross-diameters** at `NET_PERIMETER_RADIUS = 4 m` → **8 m diameter** (bigger than the whole ship), opacity driven to **0.8** (`_setNetOpacity`).
- **4 `SphereGeometry` rim weights at `NET_WEIGHT_RADIUS = 1.5 m`** → **3 m-diameter metal boulders**, each ~4× the 0.8 m hull width, `metalness 0.8`.
- The **new rejected wireframe `ConeGeometry` "bag"** bolted on top (:510, commit `b593dbf`).

Net result: an 8 m, mostly-opaque octagon-cage wrapped around 3 m chrome balls and a cone — a clunky
cage, not a web. **Root causes: too big, too opaque, too few/too-coarse lines, gigantic hard spheres,
mismatched vocabulary.**

### 1.3 The Daughter net (the "better-loved" look) — what to unify toward
`_createCeremonyVisual` (:292) builds, sized to `netClass.DIAMETER` (Large 8 / Medium 5 / Small 1.5 m):
- A **wireframe `ConeGeometry`** (16 radial × 4) at **opacity 0.55**, apex at tether, mouth forward.
- **Rim weights at `RIM_WEIGHT_RENDER_RADIUS_M = 0.08 m`** (8 cm — **19× smaller** than the Mother's 1.5 m), 4–8 of them.
- An **orange drawstring** spoke pattern (apex→weight→apex…), an **apex hub** (0.05 m), and a tether line.
- **Colour-by-phase** tinting (blue→yellow→orange→red→magenta→green) + animated open/envelop/cinch.

It's finer, far more transparent, tiny hardware, animated → reads as a real net. **But it is still a
bare low-poly wireframe cone, not yet a true "beautiful web."** The unify target can either match it
1:1 (lowest risk) or elevate both into an actual fine web (the owner's stated ideal).

### 1.4 Design canon (must honor — [`CAPTURE_NET.md`](CAPTURE_NET.md))
- **Vocabulary:** a spinning **shallow cone of woven Dyneema mesh**, octagonal topology with **cross-bracing diameters**, kept open by **rim "edge nodes"** (small tungsten spheres), apex at the tether. §2.1.
- **Heritage / aesthetic anchor:** RemoveDEBRIS (2018) real net capture; *"a purse seine in orbit"*; *"Spider orb-weaver silk… the spider builds a better shape; we build a stronger thread."* §9. → **The intended look is a fine spider-web cone, ivory/cyan Dyneema, glinting edge nodes — never a chrome cage.**
- **Material colour:** Dyneema = ivory/cool-white; tether already uses `0xddeeff` core + slate sheath. §8 specifies thin bright drawstring, **semi-transparent mesh**, glints — all the opposite of the current Mother look.
- **Cinch:** mouth contracts from `D_mesh` to ~`0.3×D_mesh`. Both nets already model this (`NET_CINCH_RADIUS_FRAC 0.25`, `DRAWSTRING_RADIUS_FRAC_CLOSED 0.15`).

### 1.5 Functional wins to PRESERVE (do not regress — all committed)
Visible throw + `LASSO_MIN_FLIGHT_TIME` gate + cosmetic recoil (`e5609e6`); open/cinch kinematics
(`0664f27`); reel-in mass/tension/break-risk physics (`dc94894`); stow→furnace lifecycle (`0717b9a`);
overshoot fix + muzzle-flash taming (`04ce6c6`); comms-spam removal + `__lassoFlags` (`2e0d1fe`);
`__lassoDebug`/`__lassoState()` (`80e19fa`). **Only the meshes are rejected — the FSM/physics/lifecycle/
events are sound.**

---

## 1.6 ⚠️ The REAL difficulty — solved frame/coordinate/motion machinery (DO NOT regress)

The daughter net is "barely acceptable" only because a long series of **orbital-mechanics / coordinate /
debris-movement** bugs were fixed. None of these live in the mesh — they live in world-positioning,
reference frames, and the debris pin pipeline. **Unification must inherit every one of them.** This is
the section that makes the difference between a clean re-skin and reopening months of bugs.

**Scene scale & why naïve world positions explode:** `1 scene unit = 100 km`, `M = 1e-5`. In LEO the
ship/arm/debris co-orbit at **~7 km/s** (and apparent motion is multiplied by `TIME_SCALE_GAMEPLAY`).
Any visual placed at an **absolute world point** drifts off-frame within **~1 s**. Everything must be
computed in a **co-orbiting (player/arm-relative) frame**, every frame.

| # | Solved problem | Where it lives | What it guarantees |
|---|---|---|---|
| **F1** | **"Net disappears" bug** — post-FLIGHT, `net.position` froze at the contact world point while the arm kept orbiting at 7 km/s → bag vanished off-frame. Fix: re-derive `net.position = arm.position + launchDir·distanceTraveled` **every frame** in CONTACT/BRAKE/ENVELOP/CINCH/SECURE. | [`CaptureNet.js`](js/entities/CaptureNet.js):537–610 | Daughter visual stays anchored in the arm's co-orbiting frame. |
| **F2** | **REELING bag-locked-to-debris** — seat bag apex one mouth-radius **behind** the debris's live `_scenePosition` so cinched net + catch never separate during haul. **Visual-only — nothing reads `net.position` back** (no station-keep feedback). | [`CaptureNet.js`](js/entities/CaptureNet.js):580–609 | Catch rides inside the net the whole haul. |
| **F3** | **Camera/visual frame agreement** — camera independently computes net pos as `arm.position + launchDir·distanceTraveled·M`; must equal the visual's frame or they diverge. | [`CameraSystem.js`](js/systems/CameraSystem.js):1862–1870 | Camera tracks the same point the visual draws. |
| **F4** | **`lookAt` convention bug** — `Object3D.lookAt` is the OPPOSITE of `Camera.lookAt`; must pass `group.position − launchDir·ε` so local **−Z = launchDir**, else rim/cinch render on the daughter side ("cinch between daughter and debris"). | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js):969–1001 | Mouth/cinch render on the target-far side. |
| **F5** | **Cinch-plane geometry (Option A)** — ENVELOP weights **overshoot** the mouth (`envZ=−coneH·(1+p)`); cinch ring contracts at the **mouth plane** (not apex); driven by `stateTimer/CINCH_CLOSE_TIME`, NOT the broken `tangleQuality` proxy (which was 0 until the CAPTURED frame → 1-frame snap). | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js):811–905 | Bag engulfs the debris smoothly. |
| **F6** | **Detached-bag hand-off at chop** — on `NET_REEL_COMPLETED` with a catch, freeze the fading bag at the **strut tip** (co-orbiting frame) so it doesn't streak away at orbital speed during the fade. | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js):505–517 | No streak when furnace breakdown starts. |
| **F7** | **CeremonyTimeScale dilation** — the net's *internal* dt is time-dilated for the ceremony; **world dt (orbital propagation, debris field, station-keep) is NOT**. Applied in `NetProjectile.update` AND again to visual dt in `CaptureNetVisual.update`. | [`CaptureNet.js`](js/entities/CaptureNet.js):526–533, [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js):465–473 | Slow-mo ceremony without slowing the world. |
| **F8** | **Mother player-relative offset (`_projOffset`)** — the Mother avoids F1 a different way: it stores a player-relative offset and rebuilds `projectilePos = playerPos + offset` every frame. | [`LassoSystem.js`](js/systems/LassoSystem.js):1393–1469 | Mother net rides the co-orbiting frame. |
| **F9** | **v2e offset-sign fix** — at contact, latch `_reelStartOffset` from **`_projOffset` directly**, never `projectilePos − playerPos` (that subtracts `playerPos_N` from `projectilePos_{N-1}`, a ~1.3 km/frame error that **flips the sign** → "shoots out front, reels in from behind"). | [`LassoSystem.js`](js/systems/LassoSystem.js):1413–1421 | Reel-in comes from the right side. |
| **F10** | **Live-target lookup honors the onboarding pin** — read the debris's live `_scenePosition` (which honors the frozen onboarding orbit), not a fresh `orbitToSceneCartesian` (stale spawn point the ship has flown past) → else the net homes 180° backward. | [`LassoSystem.js`](js/systems/LassoSystem.js):1235–1252 | Net homes toward the actual on-screen target. |
| **F11** | **Tether anchor per-frame + QuadraticBezier** — muzzle recomputed every frame as the nose reorients; QuadraticBezierCurve3 (not CatmullRom-3) so the tether can't extrapolate "out the back of the mother." | [`LassoSystem.js`](js/systems/LassoSystem.js):729–779, 1517–1539 | Tether goes muzzle→net only. |
| **F12** | **Debris pin priority + LOD-cull exemption** — `_scenePosition` SSOT priority: **onboarding pin (frozen local frame) > `_armPinned` direct copy > captor pin > orbit**; pinned/captured debris are **exempt from distance LOD** so the reeled "package" stays visible inside the net. Mother reuses `_armPinned`/`_armPinPos` for reel + cargo cells. | [`DebrisField.js`](js/entities/DebrisField.js):1755–1838 | Debris sits where the net expects; package never culled mid-haul. |

### The architectural boundary this dictates
**`NetMeshKit` is STRICTLY LOCAL-SPACE.** It builds geometry around a local origin (apex at `(0,0,0)`,
mouth along local −Z) and exposes only **local** setters (mouth fraction, color, opacity, spin angle,
rim-node local positions, drawstring rebuild). **It NEVER touches:** `group.position`, `group.quaternion`,
`lookAt`, `net.position`, `_projOffset`, `_armPinned`, `_scenePosition`, `distanceTraveled`,
`CeremonyTimeScale`, or any debris/orbit data. **All of F1–F12 stay byte-for-byte in the consumers**
(`LassoSystem`, `CaptureNetVisual`, `CaptureNet`, `DebrisField`, `CameraSystem`). The re-skin swaps the
**mesh-construction source and per-frame mesh setters only** — the frame/motion code is untouched.

Concretely:
- **Daughter re-skin (Phase 3):** keep `_updateCeremonyState` exactly — its state visibility, the F4
  `lookAt` block, the F5 `envZ`/cinch-plane math, the F6 detached-bag seat, F7 dt scaling. Only change
  *where the cone/rim/drawstring meshes come from* (kit handle) and call kit setters instead of inline
  geometry writes. The `rimWeights[i].position.set(...)` sweeps (F5) keep operating on kit-owned meshes.
- **Mother re-skin (Phase 2):** keep `update()`'s F8/F9/F10/F11 paths and `_armPinned`/cargo (F12)
  exactly. Only `_createVisuals`/`_applyNetMouthRadius`/`_setNetOpacity` change to build/drive the kit.

---

## 2. Aesthetic direction — the shared "web in space"

**Governing rule (from §0.2): the catch is the hero; the net is gossamer.** The net must never out-mass
or out-solid the operator or the prize. Sized and styled to *frame* the catch, not to be the spectacle.

A single mesh vocabulary, parameterized by diameter, used by BOTH nets:

- **Form:** a **shallow cone** (apex at tether/hub, mouth forward), per design canon — gives volume without a "bag."
- **Mesh = a real web, not a bare cone outline:** **radial spokes** (16–24) from apex to rim **+ concentric rings** (4–6 "spiral threads") → fine quad/triangle web cells. This is the orb-weaver look and reads as a *net* at a glance, and reinforces the Codex's spider/purse-seine lesson (§0.3).
- **Thin, cool, translucent:** ivory/cyan Dyneema (`~0xcfeaff`), opacity **~0.35–0.45** (down from Mother 0.8), thin lines, subtle **additive glow** so it shimmers rather than occludes. The web should *reveal* the catch through it, not hide it.
- **Edge nodes, not boulders:** tiny glints at the outer ring vertices — `~0.06–0.10 m` spheres (or `Points`), few in number; **dramatically** smaller than the Mother's current 1.5 m. Optionally none for the very smallest class.
- **Colour-by-phase retained but subtle** (the daughter's loved feedback): pre-contact cool → cinch warm → captured green, as a *tint*, low-saturation.
- **Drawstring + apex hub retained** (the daughter's cinch read) and shared by the Mother.
- **Scale-tension sanity (the load-bearing constraint):** the net is sized to its target envelope, but its *visual mass* stays subordinate to mother + catch. The Mother's diameter comes **down** (see §5) and its solidity comes **way** down (thin + translucent + tiny nodes) so that even a sizable web reads as *gossamer the small operator cast*, never a cage that dominates the frame. Validate against the "small child / large balloon" silhouette in browser (§4 Phase 4).

**Two delivery stages** (lets us unify safely first, then beautify):
- **Stage A — Unify (low risk):** shared kit reproduces the *current daughter look* (cone + tiny rim + drawstring + apex, colour-by-phase). Mother renders through it at proper scale. The clunk is gone; the daughter is visually unchanged.
- **Stage B — Beautify (tunable, browser-iterated):** upgrade the kit's cone outline → the fine **spoke+ring web** with additive shimmer and softened nodes, applied to BOTH at once. This is the owner's "beautiful web," done where it can be seen.

> Owner chose "let me decide during implementation" on the exact vocabulary — Stage B is explicitly an in-browser tuning step with knobs, not a fixed spec.

---

## 3. Architecture — a shared `js/ui/NetMeshKit.js`

A small, pure-THREE factory (no EventBus, no FSM, no DOM) that BOTH consumers call. It owns
**construction + disposal + low-level setters**; each consumer keeps its own per-frame *animation logic*
(the Mother's simple drive; the daughter's FSM sweeps). This is the lowest-risk unification and the
handoff's recommended option B.1.

```
NetMeshKit.build({
  diameter,            // m (logical mouth diameter)
  radialSpokes,        // Stage B web fineness (default from Constants)
  rings,               // Stage B concentric ring count
  weightCount,         // edge nodes (0 = none)
  weightRadiusM,       // node sphere radius (m)
  coneLengthFrac,      // apex→mouth axial length / (D/2)
  closedRadiusFrac,    // cinch radius / open radius
  color, opacity,      // base look
}) -> handle {
  group,               // THREE.Group (apex at local origin, mouth at -Z, camera-style)
  webLines,            // LineSegments (spokes + rings)  [Stage A: cone wireframe]
  rimWeights[], rimWeightMats[],
  drawstringLine,
  apexHub,
  mouthRadius, coneHeight, closedRadius, weightCount,   // params the daughter animation needs
}
// methods (operate on a handle):
setMouthFraction(h, frac)   // scales rim x/y of web + nodes; keeps apex + length
setColor(h, hex)            // tint web (+ optional node emissive)
setOpacity(h, o)
setSpinAngle(h, angle)      // rotate web about local Z
setCinchedRim(h, spinAngle) // static fully-cinched ring (daughter CAPTURED/REELING)
updateDrawstring(h)         // rebuild spoke positions from current node positions
dispose(h)
```

**Geometry convention:** apex at local origin, mouth at local **−Z** (matches the daughter's existing
`lookAt` convention at `CaptureNetVisual.js`:969–1001 — keep it so daughter envelop/cinch math is
untouched). The Mother orients via its existing quaternion path.

**Why expose meshes (not just an opaque widget):** the daughter does FSM-specific node motion (ENVELOP
overshoot `envZ = -coneHeight*(1+progress)`, cinch ring at mouth plane). The kit owns the *meshes +
params*; the daughter keeps positioning nodes with its existing, tested math. The Mother needs only the
simple setters.

---

## 4. Phased implementation

### Phase 0 — Lock the look (no code)
- Confirm Stage A→B intent with the owner if needed; otherwise proceed (Stage A is safe regardless).
- Add the shared knobs to `Constants` (§5). No behavior change yet.

### Phase 1 — Build `NetMeshKit.js` + unit tests
- New [`js/ui/NetMeshKit.js`](js/ui/NetMeshKit.js) implementing §3. **Stage A first:** reproduce the
  daughter's cone+rim+drawstring+apex exactly (extract construction from `_createCeremonyVisual` :292),
  so it's a proven look. Keep all geometry math (cone rotateX/translate, `closedRadius`, spoke pattern).
- No per-frame allocation; geometries shared per handle; `dispose()` frees geometry+materials.
- **NEW** `js/test/test-NetMeshKit.js`: build for D=8/5/1.5; assert child counts, mouth-fraction scales
  rim x/y monotonically + clamps (no NaN), `setColor/setOpacity` apply, `dispose` frees, apex at origin,
  mouth at −Z. Register in `run-tests.js`.

### Phase 2 — Re-skin the **Mother** (LassoSystem) via the kit
**Files:** `LassoSystem._createVisuals()` (:419–525), `_applyNetMouthRadius()` (:694), `_setNetOpacity()`
(:675), `update()` net block (:1482–1515), `_resetLasso()` mouth restore (:1924), `dispose()` (:1987).
- **Delete** the octagon `LineSegments` + base-position template + the 4 giant `SphereGeometry` weights
  + the `ConeGeometry` bag + their helpers. Replace `this._netGroup` contents with a `NetMeshKit` handle
  (`this._netKit`).
- Route `_applyNetMouthRadius(frac)` → `NetMeshKit.setMouthFraction`; `_setNetOpacity(o)` →
  `setOpacity`; spin → `setSpinAngle`. Add a phase tint via `setColor` (cool in flight → warm on cinch →
  green-ish on stow) to match the daughter language.
- Keep the **tether** (coaxial sheath+core), **gossamer trail**, muzzle flash, and ALL lifecycle/physics
  exactly as-is — they are not the rejected part. (Consider de-emphasizing the gossamer trail in Stage B
  if it competes with the web; tunable, not required.)
- Keep `__lassoFlags`/`__lassoDebug` working.
- **Update** `js/test/test-LassoSystem.js`: the `_netWeights`/`_netLines` assertions (:766–785) move to
  the kit handle (e.g. `lasso._netKit.rimWeights`, `setMouthFraction` no-NaN). Forward-cell routing /
  lifecycle / physics tests are untouched (no behavior change).

### Phase 3 — Re-skin the **Daughter** (CaptureNetVisual) via the kit
**Files:** `_createCeremonyVisual()` (:292), `_updateCeremonyState()` (:690), `_setCinchedRim()` (:1013),
`_updateDrawstring()` (:1036), `_removeNetVisual()` (:423).
- Replace inline construction with `NetMeshKit.build(...)`, storing the handle on the `vis` entry
  (keep `discMesh` alias = web/cone for flash-timer compat, :397).
- `_updateCeremonyState` keeps its FSM sweeps but positions the kit's `rimWeights`/sets colours via kit
  meshes; `_setCinchedRim`/`_updateDrawstring` delegate to kit methods. The `lookAt` block (:993) is
  unchanged.
- Flag-OFF (`NET_CEREMONY=false`) flat-disc path: leave as legacy or also route through a kit "flat"
  mode — **lowest risk: leave the flag-OFF disc path alone** (it's not the shipped look; `NET_CEREMONY`
  is ON).
- **Update** `js/test/test-CaptureNetVisual.js`: the cone/rim/z-plane assertions (rimWeights length,
  `coneMesh`, `z=-coneHeight`, cinch-plane invariants :721–854) point at kit-owned meshes/params. Keep
  the *behavioral* invariants (ENVELOP z < 0, cinch radius shrinks, colour-by-phase) — only the
  construction source changes. In Stage A the geometry is identical, so most assertions hold with a
  handle indirection.

### Phase 4 — Stage B beautify + tune + verify
- In `NetMeshKit`, swap the bare cone wireframe for the **spoke+ring web** (still a single
  `LineSegments`), add subtle **additive** material option, soften/shrink edge nodes. Driven by the
  Stage-B constants so it applies to BOTH nets at once.
- **Browser-playtest** (the whole reason the ugly net shipped — Node can't see meshes):
  - M1: clear `localStorage['spacecowboy_onboarding_v1']`, press **N** on welcome debris → launch from
    nose, readable throw, **web** opens then cinches, reel to forward cargo cell, furnace. Net reads as
    a delicate web, not a cage.
  - Daughter (M2+): deploy `D`, pilot, `F` fire → confirm the daughter still looks right (loved look
    preserved/elevated, colour-by-phase intact, cinch reads).
  - **Scale-tension acceptance (§0.2 — the load-bearing check):** in both cases the **mother/daughter +
    catch** must read as the subject and the net as gossamer around it. The net must NOT be the biggest
    or most-solid object in frame, must NOT crop/hide the operator, and the captured debris must remain
    clearly visible *through* the web during cinch + haul. If the net dominates, it's still wrong.
  - A/B with `window.__lassoFlags({kin:false})` to sanity-check the static web.
- **Perf:** the handoff flagged unverified fps swings (24↔120). Bisect with `__lassoFlags`; ensure the
  web's extra line segments don't allocate per-frame and node count stays low. Compare against the
  16k-instance Earth + ~5,800 debris baseline to confirm the net isn't the cause.
- Run `node js/test/run-tests.js` → **0 fail** (baseline 854 suites / 3458 tests).

---

## 5. Constants changes ([`js/core/Constants.js`](js/core/Constants.js))

**Mother net retune (the core fix), :1667–1682:**
| Const | Now | Proposed | Why |
|---|---|---|---|
| `NET_PERIMETER_RADIUS` | 4 (→8 m dia) | tune ~2.5–3.0 (browser) | shrink toward ship scale; final by eye |
| `NET_WEIGHT_RADIUS` | **1.5 m** | **~0.08–0.12 m** | kill the 3 m chrome boulders; match daughter `0.08` |
| `NET_WEIGHT_COUNT` | 4 | 4–8 | edge-node glints, not ballast |
| `NET_SEGMENTS` / `NET_CROSS_LINES` | 8 / 4 | superseded by web spoke/ring knobs | finer web |
| Mother opacity (in `fire`/reel `_setNetOpacity(0.8)`) | 0.8 | ~0.4 | translucent web |

**New shared web knobs** (under a `NET_WEB` block or extend `CAPTURE_NET.NET_CEREMONY`):
`RADIAL_SPOKES` (16–24), `RING_COUNT` (4–6), `WEB_OPACITY` (~0.4), `WEB_COLOR` (~`0xcfeaff`),
`WEB_ADDITIVE` (bool), `EDGE_NODE_RADIUS_M` (~0.08). These feed `NetMeshKit` defaults so Mother +
Daughter share one source of truth.

**Optional feature flag** `UNIFIED_NET_VISUAL` (default ON) to A/B during tuning. **If added, bump
[`test-Constants.js`](js/test/test-Constants.js):607 from `37` → `38`.** (Could also ship without a flag
since the old look is rejected; decide in Phase 0.)

**Daughter constants** (`CAPTURE_NET.NET_CEREMONY`, :1991): `RIM_WEIGHT_RENDER_RADIUS_M 0.08`,
`CONE_LENGTH_FRAC 0.85`, `DRAWSTRING_RADIUS_FRAC_CLOSED 0.15` — keep; the kit reads these so the daughter
is unchanged in Stage A.

---

## 6. Risks & mitigations
- **Reopening the F1–F12 frame/motion bugs (the BIG risk)** → enforce the §1.6 boundary: `NetMeshKit`
  is local-space only and the re-skin changes mesh construction + setters, never world-positioning. Add
  explicit "do-not-touch" diff guards: Phase 2 must leave `LassoSystem.update()`, `_armPinned`/cargo,
  `_getLiveTargetPos`, tether rebuild **unchanged**; Phase 3 must leave `_updateCeremonyState`'s
  visibility/`lookAt`/`envZ`/cinch-plane/detached-bag/dt-scale logic **unchanged** (only mesh source +
  setter calls move). Code-review the Phase 2/3 diffs specifically against the F1–F12 table.
- **Regressing the loved daughter look** → Stage A reproduces it 1:1 (extracted construction); only the
  *source module* changes. Beautify (Stage B) is a separate, browser-verified, knob-driven step on top.
- **Heavy test coupling** (`test-CaptureNetVisual.js` pins cone z-planes / cinch geometry) → keep the
  geometry math in the kit identical in Stage A so behavioral invariants pass with a handle indirection;
  update only the construction-source assertions.
- **Daughter `lookAt` (−Z) vs Mother quaternion conventions** → kit standardizes on the daughter's
  camera-style −Z mouth; Mother keeps its own orient path (only feeds the kit a group). Document it.
- **Perf (unverified fps swings)** → no per-frame allocation in the kit; low node count; bisect with
  `__lassoFlags`; verify against the pre-existing heavy-scene baseline.
- **"Not an arcade game"** → no new juice/slo-mo/flash; restrained, elegant, translucent. Owner removed
  juice before — do not reintroduce.

## 7. Definition of done
1. Mother + Daughter render through `NetMeshKit` — one shared web vocabulary (one capture language, §0.4).
2. Mother net no longer an octagon-cage + 3 m boulders + cone bag; reads as a delicate translucent web,
   and **preserves the "small child / large balloon" scale tension (§0.2)** — net subordinate to operator
   + catch; debris visible through the web during cinch + haul.
3. All lifecycle/physics/events byte-identical (throw, open/cinch, reel, stow→furnace, cooldowns, comms).
4. **Frame/motion invariants F1–F12 (§1.6) intact** — verified by (a) the unchanged-diff guard on the
   consumers' world-positioning code, (b) the existing `test-CaptureNet.js`/`test-CaptureNetVisual.js`
   position-sync + cinch-plane suites still green, and (c) **browser** confirmation that neither net
   vanishes/streaks/reels-from-behind and the catch stays inside the bag through the haul.
5. `node js/test/run-tests.js` = 0 fail (suite count adjusted for new `test-NetMeshKit.js` + any flag bump).
6. **Browser-playtested** on M1 (mother) AND M2+ (daughter); perf sane.

## 8. Open decisions for the owner
1. **Ship with or without `UNIFIED_NET_VISUAL` flag?** (Flag = safe A/B + a test-count bump; no flag = simpler, old look is already rejected.)
2. **Stage B now or land Stage A (unify) first and beautify in a follow-up?** (Stage A alone already removes the "clunky/obnoxious" problem and unifies the vocabulary.)
3. **Edge nodes:** tiny glints (keep, design-canonical) vs none (pure thread web)? — decide in browser.

## 9. Key file/line references
- Mother: [`LassoSystem._createVisuals`](js/systems/LassoSystem.js):419, `_applyNetMouthRadius`:694, `_setNetOpacity`:675, net update block :1482, reset :1924, dispose :1987.
- Daughter: [`CaptureNetVisual._createCeremonyVisual`](js/ui/CaptureNetVisual.js):292, `_updateCeremonyState`:690, `_setCinchedRim`:1013, `_updateDrawstring`:1036, colour consts :44–53.
- **Frame/motion machinery (§1.6 — read before touching either consumer):** [`CaptureNet.js`](js/entities/CaptureNet.js):526–610 (F1/F2/F7), [`CameraSystem._computeNetScenePos`](js/systems/CameraSystem.js):1862 (F3), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js):969–1001 (F4) / :811–905 (F5) / :505–517 (F6), [`LassoSystem.js`](js/systems/LassoSystem.js):1393–1469 (F8/F9) / :1235–1252 (F10) / :729–779 (F11), [`DebrisField.js`](js/entities/DebrisField.js):1755–1838 (F12).
- Constants: net look :1667–1682, `CAPTURE_NET.NET_CEREMONY` :1991, net classes :1865–1917, flags :792/:812/:835–841, ship `OCTOPUS_V5` :613.
- Design canon: [`CAPTURE_NET.md`](CAPTURE_NET.md) §2.1 geometry, §8 visual cues, §9 codex/heritage.
- Tests: [`test-LassoSystem.js`](js/test/test-LassoSystem.js):766–785, [`test-CaptureNetVisual.js`](js/test/test-CaptureNetVisual.js):292–854, [`test-CaptureNet.js`](js/test/test-CaptureNet.js) (position-sync), [`test-Constants.js`](js/test/test-Constants.js):607.

---

# 10. IMPLEMENTATION HANDOVER (Session 2) — READ THIS FIRST

> Written for the team taking a **fresh look at net visuals**. The plan above (§0–9) was executed,
> but **the look is still rejected by the owner** ("still looks like cold shit", "tether looks like a
> jagged line"). This section is the honest record: what shipped, what was tried, what failed, why,
> and the owner's proposed new direction. **You are encouraged to throw out the visual approach below
> and start fresh** — the *functional* unification (shared kit, frame-safety) is sound and worth keeping;
> the *aesthetic* (LineSegments "web") is not landing.

## 10.1 What was built (and its git state)

| State | Commit | Contents |
|---|---|---|
| **Committed** | `ef674dd` | **Stage A**: shared [`js/ui/NetMeshKit.js`](js/ui/NetMeshKit.js) factory; Mother (`LassoSystem`) + Daughter (`CaptureNetVisual`) both re-skinned through it; `NET_WEB` constants block; `test-NetMeshKit.js`. F1–F12 untouched. |
| **Committed** | `71328a3` | Cargo-cell `_firstFreeCell` fills **center-out** so a lone catch reels to the nose centerline (was off to the side). |
| **UNCOMMITTED** (working tree) | — | **Stage B** (web upgraded to spoke+ring `LineSegments` + additive shimmer), **reel-target fix** (`MOTHER_CARGO_CELL_SPREAD_M 4→0`, `FWD_OFFSET 9→4`), **tether de-jagging** (thicker tube + core de-additived), `WEB_ADDITIVE` default flipped to `false`. **Owner has NOT accepted these — verify or discard.** |

`node js/test/run-tests.js` = **858 suites / 3478 tests / 0 fail** with all of the above applied.

## 10.2 What the owner rejected, in their words
1. After Stage A + B: *"still looks like cold shit. Very annoying."*
2. *"Tether looks jagged line. WTF"*
3. *"Debris and net and tether disappear before full reel-in to mother."* — **fixed** (see 10.4).
4. *"reeling debris #2 off center cause reel in to left side of mother."* — **fixed** (see 10.4).

## 10.3 The unsolved problem: the look (aesthetic)
**Root cause we converged on:** the "web" and tether are built from **thin GL primitives**
(`THREE.LineSegments` for the web spokes/rings, `THREE.Line` for the drawstring, a thin `TubeGeometry`
for the tether). In WebGL these render **~1 px wide and alias into hard, jagged, cold-looking lines**
no matter the colour/opacity/segment count. Additive blending made it worse (harsh glint). This is a
**rendering-primitive problem, not a tuning problem** — no amount of spoke/ring/opacity tuning makes a
1-px aliased line look like an "elegant beautiful web."

**What we tried (and the result):**
- Stage A: cone *wireframe* (`MeshStandardMaterial wireframe`) — owner: still cold/clunky.
- Stage B: orb-weaver **spoke+ring `LineSegments`** (20 spokes × 5 rings) + **additive** shimmer — owner: still cold shit + jagged.
- Turned **`WEB_ADDITIVE` off** (flat translucent lines) — softer but still thin/aliased.
- Tether: **de-additived** the bright core + **thickened** (sheath 0.45→0.7 m, core 0.18→0.35 m) + more tube segments — *cause-driven, NOT browser-verified by the owner yet.*

**Honest constraint that bit us all session:** the implementing agent **cannot see the browser render**,
so every aesthetic change was a blind hypothesis. Several missed. **The next team should playtest in a
browser on every visual change** and treat Node tests as correctness-only (they say nothing about look).

**Concrete directions the next team should consider (none tried yet):**
- **Stop using GL lines.** Render threads as thin **tube/cylinder meshes** (smooth, AA'd — like the
  tether already is), OR use fat lines (`Line2`/`LineMaterial`/`LineGeometry` from `three/examples/jsm/lines/`,
  which have real screen-space width + built-in AA).
- **Or drop the "web of threads" metaphor entirely**: a soft **translucent membrane** (a thin shaded
  cone/dome mesh with a subtle fresnel/rim, low opacity) may read as "elegant net" far better than any
  wireframe, and sidesteps line aliasing completely.
- Reconsider **colour** ("cold" may be literal: base web is cool cyan `0x88aacc`; try warm ivory).
- Reconsider whether the **drawstring + edge-node glints** add value or just more thin-line clutter.

## 10.4 What WAS fixed this session (functional — keep these)
- **Reel "off to the left" + "vanishes before reaching the mother":** both were the **cargo-cell target**.
  The catch reeled to a cell placed **+9 m forward and ±4 m lateral** of the ship, then the net hid at
  stow and the debris furnaced *there* — i.e. off the nose/side, short of the hull. Fixes:
  `MOTHER_CARGO_CELL_SPREAD_M 4→0` (every catch to the centerline) + `MOTHER_CARGO_FWD_OFFSET_M 9→4`
  (reels right up to the nose). Verified the debris is **not** a separate cull bug — the stow→furnace
  handoff keeps it `_armPinned` + LOD-exempt the whole time ([`DebrisField.js`](js/entities/DebrisField.js):1817;
  [`LassoSystem._stowCatch`](js/systems/LassoSystem.js):1498 / `_updateCargo`:1556).
- **Tether jaggedness diagnosis:** it is a `TubeGeometry` (cannot be a jagged polyline by construction);
  the jaggedness was the **thin additive bright core aliasing** → de-additived + thickened.

## 10.5 ⭐ Owner's fresh-look question — likely the right reframe
> *"Should mother and daughter nets be the same? Same ceremony, same launch sound, mother's net works
> just like daughter's net — difference: size and range?"*

**This is probably the correct simplification and the next team should seriously pursue it.** Today the
two nets are **completely separate code paths** (§1.1): the Mother is `LassoSystem` (self-contained
FSM-less throw/reel/cargo/furnace), the Daughter is `CaptureNetVisual` driven by the `NetProjectile`
FSM + `NET_CEREMONY`. They already share the *mesh* (`NetMeshKit`) after Stage A, but **not** the
ceremony, sound, timing, or mechanics.

If the Mother net simply **were** a Daughter net (just a bigger `netClass` with longer range), you'd get:
- one ceremony, one launch sound, one set of states/timings/cues → far less code + far less drift;
- the "better-loved" daughter feel applied to the mother for free;
- size/range expressed purely as data (`netClass.DIAMETER` / `RANGE` / `REEL_SPEED`).

**Why it's non-trivial (scope the next team must weigh):**
- The Mother path carries real mechanics the Daughter path does **not**: aft **cargo cells + furnace
  lifecycle** (`MOTHER_CARGO_STOW`), reel **tension/CoM-pull/break risk** (`LASSO_REEL_PHYSICS`),
  cosmetic recoil, and M1-tutorial gating. Unifying mechanics means either porting these onto the
  daughter pipeline or making them shared post-capture services.
- The **frame/motion machinery (§1.6, F1–F12) was solved *differently* in each path** (Mother =
  player-relative `_projOffset`; Daughter = re-derive from `arm.position`). Merging the pipelines means
  re-solving that once, carefully — this is the hard part, not the mesh.
- Launch **sound**: confirm there's a single net-launch SFX both can fire on `NET_FIRED`/`LASSO_FIRED`.

**Recommended next-team sequence:** (1) decide membrane-vs-fat-line look in a *browser spike* first
(fast, throwaway) before any plumbing; (2) if pursuing full unification, treat it as "make the Mother a
large daughter `netClass` + keep cargo/furnace as a post-capture service," re-solving F1–F12 once.

## 10.6 Tunable knobs already in place (for quick browser A/B, no rebuild)
In [`Constants.NET_WEB`](js/core/Constants.js): `RADIAL_SPOKES` (16–24), `RING_COUNT` (4–6),
`WEB_ADDITIVE` (true/false), `WEB_COLOR`, `WEB_OPACITY`, `MOTHER_DIAMETER`, `EDGE_NODE_COUNT`,
`EDGE_NODE_RADIUS_M`, `REEL_COLOR`. Tether: `NET_TETHER_SHEATH_RADIUS`, `NET_TETHER_CORE_RADIUS`,
`NET_TETHER_RADIAL_SEGMENTS`, `NET_TETHER_SEGMENTS`. Diagnostics: `window.__lassoFlags(...)` (live
flag toggles), `window.__lassoDebug` (lifecycle trace).

## 10.7 Files touched this session
- [`js/ui/NetMeshKit.js`](js/ui/NetMeshKit.js) — **new** shared factory (Stage A) + spoke+ring web (Stage B, uncommitted).
- [`js/test/test-NetMeshKit.js`](js/test/test-NetMeshKit.js) — **new** kit unit tests; registered in [`run-tests.js`](js/test/run-tests.js).
- [`js/systems/LassoSystem.js`](js/systems/LassoSystem.js) — Mother re-skin, `_firstFreeCell` center-out, tether core de-additive.
- [`js/ui/CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) — Daughter re-skin; `_updateDrawstring` now delegates to the kit.
- [`js/core/Constants.js`](js/core/Constants.js) — `NET_WEB` block, cargo-cell + tether tuning.
- [`js/test/test-LassoSystem.js`](js/test/test-LassoSystem.js) — kit-handle assertion + center-out test.

---

# 11. SESSION 3 PLAN — fix the look (3-way spike) + reuse the Daughter pipeline for the Mother

> Written after a deep re-read of the **actual** Daughter pipeline (`CaptureNet.js`,
> `CaptureNetVisual.js`, `CaptureNetSystem`) and the Mother pipeline (`LassoSystem.js`).
> Two corrections to the §10 handover's assumptions changed the plan materially. Read §11.1.

## 11.1 What the code actually says (two handover assumptions were wrong)

**Correction A — the aesthetic root cause is mechanical, not tuning.** The whole "web" is built
from **1-px GL lines**: `NetMeshKit.build()` makes the web a `THREE.LineSegments` + `LineBasicMaterial`
([`NetMeshKit.js`](js/ui/NetMeshKit.js):149–158) and the drawstring a `THREE.Line` (:202). On
WebGL/ANGLE, `LineBasicMaterial.linewidth` is **hard-capped at 1 px** (driver-ignored), so every
spoke/ring aliases into a hard, cold, jagged thread **regardless** of spoke count / colour / opacity /
additive. The `NET_WEB` knobs (`RADIAL_SPOKES`, `RING_COUNT`, `WEB_ADDITIVE`) literally cannot fix this.
The renderer is created with **`antialias: false`** ([`SceneManager.js`](js/scene/SceneManager.js):50–55),
so the canvas has no MSAA to soften those 1-px lines either — which is exactly why fat lines (Line2 carries
its own AA) or a shaded membrane (smooth geometry, no thin lines) are the only real fixes.
The **tether is fine** — it is a `TubeGeometry` (real, smooth geometry; [`LassoSystem.js`](js/systems/LassoSystem.js):488/510/680/692);
its earlier "jagged" read was the thin additive core, already de-additived + thickened in the working tree.

> **New, decisive fact the handover missed:** this repo **already ships fat-line infrastructure**.
> [`Starfield.js`](js/scene/Starfield.js):8–10 imports `LineSegments2` / `LineMaterial` /
> `LineSegmentsGeometry` from `three/addons/lines/…`, resolved by the [`index.html`](index.html):379
> importmap (`three/addons/` → jsdelivr `examples/jsm/`, three@0.184.0). These render **screenspace-width,
> anti-aliased** lines. So "stop using GL lines → fat lines" is **proven in-repo, low-risk** (one caveat:
> `LineMaterial.resolution` must be kept in sync with the viewport each frame — Starfield does this at :375–377).

**Correction B — "make the Mother a Daughter net" is roughly half-built, not greenfield.**
- [`CaptureNetSystem.fireMotherNet(podIndex,…)`](js/entities/CaptureNet.js):1270 **already exists** — it
  builds a real `NetProjectile { netClass: CN.LARGE }`, runs the full daughter FSM, and emits
  `NET_FIRED { source:'mother' }`. It is **dormant** (no production caller — only a comment + tests).
- [`CaptureNetVisual`](js/ui/CaptureNetVisual.js) **already supports** mother/pod nets (25 `podIndex`/`source:'mother'` refs).
- The **furnace/salvage lifecycle is NOT Mother-unique**: the Daughter path already reels a catch home and
  runs a staged furnace breakdown ([`ArmUnit.js`](js/entities/ArmUnit.js):5095–5258, [`ArmManager.js`](js/entities/ArmManager.js):1505–1521),
  and the system emits a unified [`CARGO_STORE`](js/entities/CaptureNet.js):1203 (`source:'mother'|'daughter'`) on STOWED-success.

**The boundary the code dictates:** the launch → flight → CONTACT → ENVELOP → CINCH → **CAPTURED**
**ceremony + visual + sound is fully shareable** (and is the loved + owner-requested part). The
**post-CAPTURED haul-home is genuinely platform-specific** and already lives in `LassoSystem` for the
Mother. So the real gaps for full Mother reuse are exactly three (the rest is config/wiring):

| Gap | Why | Where the answer already exists |
|---|---|---|
| **G1 — Frame.** A mother `NetProjectile` has no `_sourceArm`, so the F1 position-follow ([`CaptureNet.js`](js/entities/CaptureNet.js):569–610) never runs → the bag would freeze/vanish (the F1 bug). | The FSM keys position-sync off `_sourceArm.position`. | Pass a live **player-position adapter** as `sourceArm` (the F8/F9 substitution): `{ get position(){ return playerSceneVec } }`. |
| **G2 — Haul.** The FSM does not move the debris; the Daughter relies on the ArmUnit to physically carry it home. A Mother net has no arm — something must pull the captured debris to the mother during REELING. | `_updateReeling` only animates `reelProgress` + seats the bag visual on `targetDebris._scenePosition`. | Reuse `LassoSystem`'s reel physics + `_armPinned`/`_armPinPos` haul + cargo-cell delivery (F9/F12) as a **post-CAPTURED service** driven by `NET_CATCH_SUCCESS`/reel events. |
| **G3 — Ecosystem.** `LASSO_FIRED` is consumed by AutopilotSystem (recoil), OnboardingDirector (M1 lasso beat), SkillsSystem (`collect_lasso`), CodexSystem (`bolas_weapon`), GuidanceDirector/Telemetry, TargetReticle, AudioSystem (launch SFX + flight whistle). | Switching the Mother to `NET_FIRED` would silently break all of these. | **Keep emitting `LASSO_FIRED`** from the Mother fire path (compatibility), and point both `LASSO_FIRED`/`NET_FIRED {source:'mother'}` at the **one** launch SFX → the owner's "same launch sound". |

## 11.2 Strategy

Two independent axes. The **look** is the owner's actual rejection and is cheap + high-value; the
**structural reuse** is the owner's preferred simplification but is a real (bounded) project. Do the
look first (it lands on BOTH nets at once via the shared kit), then the reuse. Verify every visual change
against a real screenshot via the Phase-0 loop — never ship a blind guess (the §10.3 lesson).

## Phase 0 — Close the "blind agent" loop with a SIMPLE screenshot method (the thing that sank Session 2)
Session 2 failed aesthetically because the implementing agent **could not see the render** and every change
was a blind guess. That constraint is removable: the agent **is multimodal** (it can `Read` PNG files
directly — proven by the repo's `screenshot.png`), and it runs bash **on this same macOS host** where the
game is open. So the simplest effective loop needs **no new dependencies and no headless browser** — just
macOS's built-in screen capture plus the game's existing pause hook.

**Primary method — macOS `screencapture` of the live game (zero new code, REAL render):**
1. Owner runs the game once (`./start.sh`) and leaves the browser window visible. (One-time: grant the
   terminal/host **Screen Recording** permission in System Settings → Privacy.)
2. Drive a deterministic moment with hooks that **already exist**:
   - fire the net (N for Mother / F for Daughter), then
   - freeze the frame with `window.__game.setPaused(true)` ([`main.js`](js/main.js):938) — the renderer keeps
     drawing the frozen frame, so the cinch moment holds still for capture. `setPaused(false)` resumes.
3. In execution mode the **agent itself** runs the built-in capture and reads it:
   - `screencapture -x -o tmp/netshot.png` (full main display, non-interactive, no shutter sound), or a
     region with `screencapture -x -R<x,y,w,h> tmp/netshot.png` to crop to the net.
   - then `Read tmp/netshot.png` and iterate (edit → owner reloads the tab → `setPaused` at cinch → capture → read).
   This satisfies the "agent-driven, repeatable" goal **without** puppeteer/SwiftShader/CDN risk, because it
   photographs the real browser the owner already trusts.

**Complement — in-game canvas grab (deterministic framebuffer, no screen-recording permission):**
- Add a dev-flagged `window.__netShot()` that, under `?shot=1`, creates the renderer with
  `preserveDrawingBuffer: true` ([`SceneManager.js`](js/scene/SceneManager.js):50 currently lacks it, so a
  plain `toDataURL` returns black) and does `renderer.domElement.toDataURL('image/png')` → programmatic
  `<a download>` to `~/Downloads/netshot-<ts>.png`. The agent `Read`s from `~/Downloads`. Use this when the
  game window isn't easily visible/foreground, or to grab the exact `#game-canvas` pixels rather than the
  composited screen.

**Optional / last resort — headless puppeteer (`scripts/netshot.mjs` + `?netspike`):** only if a fully
hands-off, owner-absent loop is later wanted. Higher setup + feasibility risk (Chromium download, WebGL via
SwiftShader, `three` from CDN). **Not needed for Phase A** — the two methods above are simpler and sufficient.

- Either way: capture **open**, **cinch**, and **haul** frames on **M1 (Mother)** and **M2+ (Daughter)** so
  the scale-tension (§0.2) and colour-by-phase are judged in context, not just a static mouth.

## Phase A — 3-way visual spike (owner picks by eye) — THROWAWAY, no production commit
**Goal:** decide the rendering primitive for the web before touching production look code.
- Add a **dev-only harness** (e.g. a `?netspike=1` query-flag path or a `window.__netLook('fatline'|'membrane'|'hybrid')` toggle) that renders the **same** kit envelope (apex/origin, mouth at −Z, `mouthRadius`/`coneHeight`) three ways:
  - **(a) Fat-line web** — port the existing spoke+ring topology to `LineSegments2` + `LineMaterial` + `LineSegmentsGeometry` (screenspace width + AA). Keep `material.resolution` synced per frame (mirror [`Starfield.js`](js/scene/Starfield.js):375–377). Keeps the spider/purse-seine "web of threads" the Codex teaches.
  - **(b) Translucent membrane** — a thin shaded cone/dome `Mesh` (reuse the Stage-A `ConeGeometry`, open-ended), low opacity, soft **fresnel/rim** (shader or `MeshStandardMaterial` + emissive rim), **no lines**. Sidesteps aliasing entirely; likely the most "elegant".
  - **(c) Hybrid** — membrane (b) + a few fat-line (a) spokes + one rim ring for an unmistakable "net" silhouette.
- Wire each variant to the existing setters (mouth-fraction scale, colour-by-phase tint, opacity) so the owner judges them **in motion** (open → cinch) on a live capture, both on M1 (Mother) and M2+ (Daughter).
- **Owner picks the winner.** Capture the choice + final knob values in this plan before Phase B.
- *Do not* commit the harness; it is a throwaway used only to make the decision.

## Phase B — Lock the chosen look into the shared kit (production)
- Replace the rejected `LineSegments`/`Line` web in [`NetMeshKit.js`](js/ui/NetMeshKit.js) with the
  Phase-A winner, **behind the existing handle/API** (`coneMesh`/`webLines` alias, `setMouthFraction`,
  `setColor`, `setOpacity`, `setSpinAngle`, `setCinchedRim`, `updateDrawstring`) so **both consumers are
  untouched** and all F1–F12 frame/motion code stays byte-identical (the §1.6 boundary).
  - If **fat-line**: kit owns a `LineMaterial`; expose a `setResolution(w,h)` the consumers call (or have the kit subscribe to a resize event). No per-frame allocation.
  - If **membrane**: kit builds a `Mesh` + material; `setMouthFraction` scales XY exactly as today; drawstring/edge-nodes optional (decide in Phase A).
- **Keep** the working-tree functional fixes that address real owner complaints: `MOTHER_CARGO_CELL_SPREAD_M 0` + `MOTHER_CARGO_FWD_OFFSET_M 4` (reel-to-centerline/nose) and the thicker de-additived tether. **Discard** only the rejected Stage-B `LineSegments` web.
- Update [`Constants.NET_WEB`](js/core/Constants.js) knobs to the chosen vocabulary (remove/repurpose `RADIAL_SPOKES`/`RING_COUNT`/`WEB_ADDITIVE` if membrane wins; add membrane knobs — colour, opacity, rim/fresnel strength, diameter).
- Update [`test-NetMeshKit.js`](js/test/test-NetMeshKit.js) for the new mesh type (child counts / handle shape), keep behavioural invariants (apex at origin, mouth at −Z, mouth-fraction scales monotonically + clamps, no NaN, dispose frees). If the winner is the **membrane** (a `Mesh`, not `LineSegments`), also update the construction-source assertions in [`test-CaptureNetVisual.js`](js/test/test-CaptureNetVisual.js) / [`test-LassoSystem.js`](js/test/test-LassoSystem.js) that reference the web child type — the **behavioural** cone-envelope/cinch-plane invariants stay (the envelope math is unchanged), only the mesh-type assertions move.
- **Browser-playtest** (§4 Phase 4 acceptance): M1 + M2+, scale-tension (net subordinate to operator + catch; catch visible through the web during cinch + haul), perf sane. `node js/test/run-tests.js` = 0 fail.
- **Commit** here. This alone removes the "cold shit" rejection and elevates BOTH nets — a complete, shippable unit even if Phase C is deferred.

## Phase B.5 — Stabilize the Daughter's live re-dock-with-debris bug FIRST (prerequisite for Phase C)
**Why before Phase C:** Phase C makes the Daughter's Layer-1 capture the **shared** front half. The Daughter
should be a clean, owner-trusted base before we build the Mother on top of it — and this is the moment the
Phase-0 screenshot/playtest loop exists to actually *verify* a fix the analysis says is browser-dependent.
This is a **Layer-2 (delivery) bug**, so the Mother won't inherit it; the goal is a stable, trusted Daughter
to unify against (and a quick standalone win). Full root-cause + fixes already exist in
[`daughter-redock-vanish-tether-analysis.md`](daughter-redock-vanish-tether-analysis.md) — execute it:
- **Symptom:** a returning daughter with a catch *vanishes ~2 s* + a *wrong-way (~180°) tether* flashes, then
  pops onto the strut.
- **Verify the live contributor first** (the doc's protocol): rule out the **service-worker stale build**
  (hard-reload / unregister SW; bump `CACHE_NAME` in [`sw.js`](sw.js):36 if that's it), then instrument one
  capture→reel→re-dock with `?debug` logging `arm.state`/`mesh.visible`/positions/tether endpoints to confirm
  whether the gap is **camera occlusion by the parked full-size catch** (contributor 1) and/or the
  **tether rendering through `DOCKING`** (contributor 2).
- **Fix A (high-confidence, unconditional):** add `S.DOCKING` to the tether hide-list in
  [`_updateTether`](js/entities/ArmUnit.js):5461 — the daughter is already at the strut tip when DOCKING
  begins, so the tether carries no information and only exposes the 180° flash. Re-check the launch-ceremony
  `TETHER_FOLLOW` camera + `recallClosestDeployed` flows.
- **Fix B (pick variant after the screenshot/playtest confirms contributor 1):** stop the parked catch
  eclipsing the daughter — **B1** push/laterally-offset the HOLDING_CATCH pin standoff
  ([`_pinCatchToSelf`](js/entities/ArmUnit.js):4370 / `ARM_HOLD_CLEARANCE_M`) off the camera→daughter axis;
  **B2** shorten `FURNACE_TRANSFER.HOLD_S` or begin a gentle chop-shrink at hold start so the full-size bag
  never fully eclipses her; **B3** render-order/depth so the daughter draws over the bag. Choose the
  least-invasive variant the browser loop confirms.
- **Tests:** extend [`test-ArmUnit-tether.js`](js/test/test-ArmUnit-tether.js) — assert `tetherLine.visible === false`
  in `DOCKING` (alongside DOCKED/RELOADING/HOLDING_CATCH); add a HOLDING_CATCH lateral-clearance assertion for a
  max in-spec catch under parent rotation; keep REELING/RETURNING strut-tip convergence green. `node js/test/run-tests.js` = 0 fail.
- **Browser smoke (now possible via Phase 0):** capture → R reel → re-dock shows **no wrong-way tether flash**,
  daughter stays visible (or the parked catch no longer eclipses her), catch breaks down on the furnace timeline.
- **Commit** here. Independent, shippable Daughter polish; de-risks Phase C by unifying against a clean base.

## Phase C — Structural reuse: the Mother net BECOMES a large Daughter net (separable)
**Only after Phase B is accepted.** Target the §10.5 owner ask: one ceremony, one launch sound, one FSM;
difference = size + range. Behind a feature flag (e.g. `MOTHER_NET_UNIFIED`, default OFF until browser-verified).
**Flag-OFF = the Phase-B path** (Mother's own FSM-less throw rendering the approved look through `NetMeshKit`)
stays as the instant fallback; **flag-ON = the shared `NetProjectile` ceremony**. Both render the same Phase-B
look, so the flag changes *mechanics/ceremony*, not the aesthetic.
1. **Fire path.** Route the Mother fire (N key → [`InputManager.fireLasso`](js/systems/InputManager.js):2016) to call `captureNetSystem.fireMotherNet(...)` with the lasso's range/ammo/forward-arc/cooldown gating preserved. Force `CINCH` (already done in `fireMotherNet`). Keep emitting `LASSO_FIRED` (G3 compat) and play the shared launch SFX on both events.
2. **Frame (G1).** Pass a live **player-position adapter** as the projectile's `sourceArm` so `CaptureNet.js`:569–610 keeps the bag in the player's co-orbiting frame (replaces F8/F9 `_projOffset`). Re-validate F1/F3/F4/F5/F7 for the Mother in browser.
3. **Haul-home (G2).** On `NET_CATCH_SUCCESS {source:'mother'}` / reel, drive the captured debris to the mother by **reusing LassoSystem's reel-physics + `_armPinned`/`_armPinPos` + cargo-cell + furnace** as a post-CAPTURED service (keep `LASSO_REEL_PHYSICS` tension/CoM/break-risk as a Mother-only option, or simplify — owner call). The unified `CARGO_STORE` (CaptureNet.js:1203) already notifies cargo/codex/HUD.
4. **Retire the Mother's bespoke meshes/throw-FSM** in `LassoSystem` (`_createVisuals`/`_applyNetMouthRadius`/`_setNetOpacity`/spin) — the ceremony + visual now come from the shared `NetProjectile` + `CaptureNetVisual`. Keep only the post-capture haul service + tether (if not also unified).
5. **Tests + browser:** new mother-pod ceremony path tests (fire → CAPTURED → reel → CARGO_STORE → furnace), F-series regression suites green, browser M1 confirms no vanish/streak/reel-from-behind and the catch stays in the bag through the haul. Onboarding M1 "press N" beat still fires (LASSO_FIRED compat).

## 11.3 Risks
- **Aesthetic still misses** → mitigated by the Phase-A browser spike (owner decides before production code).
- **Reopening F1–F12** (Phase B) → §1.6 boundary: kit is local-space only; consumers' world-positioning untouched.
- **Mother reuse regresses the F-series differently than the Daughter** (Phase C, G1/G2) → flag-gated, browser-validated, F-series suites guard it; the player-adapter + reel-service are the only new frame code.
- **Silent break of the `LASSO_FIRED` ecosystem** (Phase C, G3) → keep emitting `LASSO_FIRED`; add a test asserting it still fires on Mother launch.
- **Perf** → fat lines/membrane add no per-frame allocation; bisect with `__lassoFlags`; compare to the heavy-scene baseline.

## 11.4 Definition of done
- **Phase B:** both nets render the owner-approved look through `NetMeshKit`; no 1-px aliased web; scale-tension intact; functional cargo/tether fixes kept; all tests green; browser-verified M1 + M2+.
- **Phase C (if pursued):** Mother fires the shared `NetProjectile` ceremony with the same launch sound; `LASSO_FIRED` ecosystem intact; catch hauled to the mother + furnaced; F1–F12 invariants verified in browser; flag flippable.

## 11.5 Decisions — resolved + remaining
**Resolved with the owner (Session 3 planning):**
- **Scope:** the full plan — Phase 0 → A → B → **B.5** → C, **look first, then stabilize the Daughter's
  re-dock bug, then the S3 best-of-each reuse** (§11.6). Phase B.5 fixes the live re-dock-with-debris
  vanish/180°-tether residual so Phase C unifies against a clean, owner-trusted Daughter base.
- **Phase 0 loop:** **agent-driven `screencapture` of the live game** (macOS built-in) + the existing
  `window.__game.setPaused(true)` freeze hook — no new deps, real render. Optional in-game `?shot` canvas
  grab as a deterministic complement; puppeteer demoted to last resort.
- **Structure:** **S3** — shared Daughter front half (≤ CAPTURED) + Mother haul service (> CAPTURED),
  bridged by a player-position adapter; Phase C flag-gated (`MOTHER_NET_UNIFIED`, default OFF).
- **Mother reel-physics:** **keep** it as a tunable post-CAPTURED haul service (default ON); finalize feel in-browser.

**Remaining (decided during implementation, via the screenshot loop):**
- **Phase-A winner** — fat-line web vs membrane vs hybrid.
- **Edge nodes / drawstring** — keep as glints vs drop (per §0.3 + the chosen look).
- **Break-risk default per mission/tier** under the unified Mother haul.

## 11.6 Deep analysis — which structure, and the "best of each"

The Daughter pipeline is a **large, hard-won asset**: it is where "capture in space" was actually solved
— the FSM, the ceremony, the loved visual, and the brutal coordinate/frame bugs (F1, F3–F7). The Mother
pipeline is a **different hard-won asset**: it is where "bring the catch home **into the mother**" was
solved — the haul (reel tension / CoM-pull / break-risk), the debris-pin machinery (F8–F12), the cargo
cells, the stow→furnace lifecycle, and the whole `LASSO_FIRED` economy/tutorial/recoil ecosystem. Neither
is throwaway. The right move is **not** "replace one with the other" — it is to **split each at its natural
seam and keep the best half of each.**

**The natural seam is the `CAPTURED` state.** Everything *before* CAPTURED (aim → launch → flight →
contact → envelop → cinch → ceremony + sound + visual) is **capture**, and the Daughter solved it best.
Everything *after* CAPTURED (haul the catch to the platform → stow → furnace) is **delivery**, and the
Mother solved it best (because the Daughter cheats here — its ArmUnit physically *carries* the catch home;
the Mother, having no arm, actually had to solve "reel a heavy tumbling body to yourself").

### Three structural strategies

| Strategy | Pros | Cons | Verdict |
|---|---|---|---|
| **S1 — Keep two paths, share only the mesh** (today) | Lowest risk; ships the look fix alone; no F-series re-validation. | Two FSMs, two reel paths, two sounds, perpetual drift; Mother never gets the loved ceremony; owner's §10.5 ask unmet. | Fallback only (if Phase C is dropped). |
| **S2 — Mother fully becomes a Daughter** (route N→fireMotherNet, delete LassoSystem) | One FSM/ceremony/sound; least *future* code. | **Discards the solved Mother haul** — but the Daughter "haul" is the ArmUnit carrying; with no arm the Mother still needs a pull-to-self actor, so you'd *rebuild* a worse version of what LassoSystem already does. Re-solves F8–F12 the hard way. High risk. | Rejected — throws away solved work + re-opens F8–F12. |
| **S3 — Best of each: shared front half (Daughter), Mother haul service for the back half** | Daughter's ceremony+visual+sound+coordinate work (F1,F3–F7) shared up to CAPTURED; Mother's solved haul (reel physics, F8/F9/F12, cargo, furnace) kept as a post-CAPTURED service bridged by a player-position adapter; `LASSO_FIRED` ecosystem preserved. Owner's "same ceremony, same sound, size+range differ" met **without** discarding either investment. | A clear seam contract is required (who owns position pre- vs post-CAPTURED); one new bridge (player-position adapter, G1) and one re-pointed haul trigger (G2). Flag-gated, browser-validated. | **Recommended.** This is the "best of each." |

### The S3 seam contract (the one thing to get exactly right)
- **Pre-CAPTURED (capture, Daughter-owned):** the `NetProjectile` FSM owns the net's position in the
  player's co-orbiting frame via the **player-position adapter** passed as `sourceArm` (G1) — this is the
  F8→F1 substitution. Ceremony/visual/sound are the Daughter's, unchanged.
- **At CAPTURED:** ownership of the debris hands off from "the net seats its bag on `targetDebris._scenePosition`"
  to "the **Mother haul service** pins the debris (`_armPinned`/`_armPinPos`, F12) and reels it to the nose."
  Exactly one owner of the pin at a time — this is where a double-owner bug would hide; assert it in tests.
- **Post-CAPTURED (delivery, Mother-owned):** LassoSystem's reel physics + cargo center-out + stow→furnace
  run as today, now triggered by `NET_CATCH_SUCCESS{source:'mother'}`/reel events instead of its own FSM.

### Reel-physics decision (§11.5.3) — recommendation: **keep, but make it a tunable Mother haul service**
- **Keep (pros):** it is solved + tested; it is **pedagogically load-bearing** — tension/CoM-pull/break-risk
  is the dynamic expression of the "small child / large balloon" thesis (§0.2): a too-heavy catch *fights
  back*, teaching mass/curriculum. It is the one mechanic that legitimately makes the Mother *feel* like the
  operator rather than a bigger daughter. Deleting it discards real work for no gain.
- **Simplify to Daughter-style (cons of doing so):** the Daughter "haul" is the ArmUnit carrying — there is
  no arm on the Mother, so "simplify" still needs a Mother pull-to-self actor; you'd be rewriting, not
  reusing, and you'd lose the teaching beat. "Works just like the daughter" is satisfied by the **shared
  ceremony + sound + visual** (what the owner sees and hears), not by making the haul dumber.
- **Recommendation:** keep the reel physics as the post-CAPTURED **Mother haul service**, exposed behind a
  tuning curve/flag so its strength (and whether break-risk is on at a given mission/tier) is dialable, and
  finalize the *feel* in-browser via the Phase-0 screenshot/playtest loop. Default ON.

### Caveat the owner flagged: "Daughter not finished yet"
Sharing the front half means **Daughter improvements benefit the Mother for free** — but also that a latent
Daughter bug can surface on the Mother. Mitigations: (a) Phase C is **flag-gated** (`MOTHER_NET_UNIFIED`,
default OFF) so the Mother can fall back to S1 instantly; (b) the front half is *already* partly shared
(visual via `NetMeshKit`; FSM already has the dormant mother-pod path), so this is incremental, not a
big-bang rewrite; (c) finish/stabilize the Daughter's open issues first or in tandem, since they now also
gate the Mother.

## 11.7 Deep dive — the FULL Daughter lifecycle, and what "one net pipeline" actually means

A second, deeper read settled the structural question. The Daughter is **two layered state machines**, not one:

**Layer 1 — the net (capture).** [`NetProjectile`](js/entities/CaptureNet.js):443 FSM:
`LAUNCHING → SPINNING_UP → FLIGHT → CONTACT → BRAKE → ENVELOP → CINCH_CLOSING → SECURE_CHECK → CAPTURED →
(short) REELING → STOWED`. Owns cling/frag/tumble physics, the ceremony (`NET_CEREMONY` beats + `CeremonyTimeScale`
slow-mo), the loved visual ([`CaptureNetVisual`](js/ui/CaptureNetVisual.js)), and F1/F3–F7. This layer is the
"capture in space" the owner praised — and the **mother-pod variant already exists** (`fireMotherNet`).

**Layer 2 — the arm (vehicle delivery).** [`ArmUnit`](js/entities/ArmUnit.js) FSM:
`TRANSIT → APPROACH → FISHING → NETTING (fires the net) → GRAPPLED → [SNUG] → REELING (motor-reels the **arm
itself**, catch pinned, toward the mother) → [FEEP soft re-dock arrest] → DOCKING → HOLDING_CATCH (staged
furnace breakdown HOLD/CHOP/FEED) → CATCH_PROCESSED → RELOADING`. The net capture is just **one sub-step**
(`NETTING`) inside this larger vehicle loop. The haul home is the ArmUnit's job **because the Daughter is a
returning vehicle.**

**The Daughter's still-open issues all live in Layer 2 (the haul/re-dock), never in Layer 1 (capture):**
- **Re-dock-with-debris vanish / 180°-tether** — residual contributor still live after multiple fixes
  ([`daughter-redock-vanish-tether-analysis.md`](daughter-redock-vanish-tether-analysis.md)): daughter occluded
  ~2 s + wrong-way tether on re-attach.
- **Reel-in too slow + inertia + SNUG + FEEP soft re-dock + yoke/tether-plume clearance** — a large design
  partly landed behind `REEL_PROFILE_V2` ([`reel-in-redock-inertia.md`](reel-in-redock-inertia.md)); inertia is
  "partly moot" because frame-correction + catch-pin hide momentum; the yoke→plume clearance interlock is not
  fully modelled; tether-snap risk + Mission-1 clamp.
- Staged furnace breakdown **is** implemented (`FURNACE_TRANSFER` HOLD/CHOP/FEED + `FurnaceBreakdownVisual`),
  despite a couple of stale "furnace unsolved/deferred" comments ([`ArmUnit.js`](js/entities/ArmUnit.js):5096,5148).

### Verdict: "one pipeline" splits cleanly into capture (yes) vs delivery (no)
| Layer | Share Mother↔Daughter? | Why |
|---|---|---|
| **Capture (Layer 1, ≤ CAPTURED)** | **YES — strongly.** | Same verb, same ceremony/visual/sound the owner wants; already half-built (dormant `fireMotherNet` + mother-pod visual support). This is exactly the S3 front half. |
| **Delivery transport (Layer 2 haul→dock)** | **NO.** | The Daughter's delivery is a *vehicle-return* problem (reel profile, SNUG, FEEP arrest, yoke clearance, tether-snap, re-dock) inseparable from `ArmUnit`. The Mother has **no vehicle** — it winches the catch to its own nose. Forcing one path would either burden the Mother with return/dock concepts it has no use for, or pollute the net pipeline with vehicle FSM. |
| **Furnace breakdown (post-delivery)** | **Maybe — the one shareable delivery piece.** | Both ultimately furnace **at the mother**. The HOLD/CHOP/FEED → `CATCH_PROCESSED` stage + `FurnaceBreakdownVisual` could become a shared post-arrival service. Optional; not required for the look. |

**Two consequences that strengthen the S3 plan:**
1. **Isolation from the Daughter's open bugs.** Because the Mother shares only Layer 1 (capture), it does
   **not** inherit any of the live Layer-2 haul/re-dock issues above — the Mother has no re-dock at all. The
   §11.6 "Daughter not finished yet" risk is therefore **smaller than feared**: the unfinished work is in the
   half the Mother does **not** share.
2. **"Works just like the daughter's net" is a Layer-1 statement.** What the owner sees/hears that reads as
   "the daughter's net" — the launch, the spin-up, the cinch ceremony, the sound, the look — is **all Layer 1**,
   and is fully shareable. The Mother keeping its own direct-winch delivery (its solved haul/cargo/furnace) does
   **not** contradict "works like the daughter's"; the delivery was never the part that reads as "the net."

This is the definitive basis for S3: **unify Layer 1 (capture ceremony/visual/sound), keep each platform's
Layer-2 delivery** (Daughter = vehicle return; Mother = direct winch), and *optionally* share the furnace
breakdown as a post-arrival service.

---

# ⚑ SESSION HANDOVER — 2026-06-23 (Phase 0/A/B attempt; look REJECTED in-game)

**Status: Phase B is implemented + all 858 suites / 3478 tests green, BUT the owner
rejected the in-game result.** Two concrete defects remain, both root-caused below.
Read this whole section before touching code. The close-up look is good; the
*in-game* look is not. Do not re-litigate the primitive choice — fix the two defects.

## TL;DR for next shift
1. **Tether renders as a jagged "lightning-bolt" sawtooth.** ROOT CAUSE = **float32
   vertex precision at large world coordinates**, NOT the line primitive. Fixing the
   primitive (tube→fat-line) did NOT help and arguably made it more visible. See §A.
2. **The web reads "cold" / small / gray at the real M1 camera framing** — even though
   it looks great close-up in the throwaway spike. This is a **framing + scale +
   brightness** problem, not a primitive/colour problem. See §B.
3. Everything is uncommitted on top of HEAD `71328a3`. Tests pass. Decide per §D whether
   to keep, partially revert, or rework before committing.

## What was done this session
- **Phase 0 (DONE, good):** dev screenshot loop. `?shot=1` → `preserveDrawingBuffer`
  in `SceneManager`; `window.__netShot('name')`, `window.__netPause(bool)`,
  `window.__netAuto(bool)` in `main.js`. `?shotauto=1` auto-captures at net FSM beats
  (fired/contact/envelop/brake/cinch/captured/reel) for Mother (`lasso:*`) + Daughter
  (`net:*`). **Gotcha solved:** the composite writes alpha 0 → a raw `toDataURL` is a
  transparent PNG that viewers show as **white**; we flatten onto opaque black first.
  **Plan was WRONG:** there is no `window.__game.setPaused` (main.js:938 is an
  InputManager callback). Captures land in the browser download dir (here: project root
  and/or `~/Downloads`).
- **Phase A (DONE, good):** throwaway spike `netspike.html` + `js/spike/NetLookSpike.js`
  (NOT committed; standalone, `?auto=1` batch-captures). Compared fat-line vs membrane
  vs hybrid. **Owner chose fat-line ivory thread web + tiny rim-node glints + softer
  phase tints.** Close-up the fat-line web is genuinely good (see `spike-fatline-*.png`).
- **Phase B (IMPLEMENTED, look rejected in-game):**
  - `js/ui/NetMeshKit.js` — web rebuilt as `LineSegments2`/`LineMaterial`/`LineSegmentsGeometry`
    (was `THREE.LineSegments`+`LineBasicMaterial`, 1-px GL line — the original
    cold/jagged root cause). Handle API preserved (`coneMesh`/`webLines`/setters/dispose).
    Added `webPositions`, `lineMaterial` to handle. Added module resolution registry +
    `setResolution(w,h)` + `registerLineMaterial`/`unregisterLineMaterial`. Rim weights
    restyled to ivory emissive + additive glints. Defaults → ivory.
  - `js/scene/SceneManager.js` — imports NetMeshKit; `_syncNetMeshResolution()` drives
    `NetMeshKit.setResolution(innerW*pr, innerH*pr)` on init + resize (drawing-buffer px,
    NOT CSS px — required or Retina threads render at half width).
  - `js/core/Constants.js` — `NET_WEB`: `WEB_COLOR 0xcfeaff`, `WEB_OPACITY 0.6`,
    `RADIAL_SPOKES 28`, `RING_COUNT 8`, `LINE_WIDTH_PX 1.5`, `NODE_ADDITIVE true`,
    `REEL_COLOR 0x66dd88` (gentler green). `NET_TETHER_SHEATH_RADIUS 0.7→0.4`,
    `NET_TETHER_CORE_RADIUS 0.35→0.18`, `NET_TETHER_RADIUS 0.7→0.4` (now mostly unused —
    see §A; kept for the BOLAS_* aliases + test-BolasVisuals).
  - `js/ui/CaptureNetVisual.js` — `COL_DISC 0x88aacc→0xcfeaff` (pre-contact ivory, was
    cold cyan), `COL_CAPTURED 0x00ff44→0x66dd88` (gentler green).
  - `js/systems/LassoSystem.js` — **Mother tether converted from coaxial sheath+core
    `TubeGeometry` to a single fat-line `Line2`/`LineMaterial`** (ivory, 2 px). `_tetherCore`
    retired to `null` (all its call sites were already `if (this._tetherCore)`-guarded).
    `_rebuildTetherGeometry` now samples the catenary into `LineGeometry.setPositions`.
    **THIS DID NOT FIX THE JAGGEDNESS — see §A.**
  - Tests updated: `test-NetMeshKit.js` (isLineSegments→isLineSegments2; vertex count via
    `handle.webPositions`; additive→node-glint), `test-CaptureNetVisual.js` (captured
    green 0x00ff44→0x66dd88).

## §A — DEFECT 1: tether jagged sawtooth (float32 world-coordinate precision)
**Symptom:** the ship→net tether renders as a regular zigzag/lightning-bolt staircase
(see `netshot-auto-fired-2026-06-23T01-30-*.png`, `...contact...`). The OLD thick tube
(radius 0.7) *masked* it; slimming to 0.4 and then converting to a fat-line *exposed* it.

**ROOT CAUSE (high confidence):** vertex positions are built in **absolute world space**.
`SCENE_SCALE` makes 1 unit = 100 km; `EARTH_RADIUS = 63.71` units, so the ship orbits at
~64–84 units from the scene origin. Float32 spacing at magnitude ~64 is
`2^(6-23) ≈ 7.6e-6` units ≈ **0.76 m**. The tether's spine points are spaced ~1 m, so
they snap to a ~0.76 m grid → systematic perpendicular wobble → a regular sawtooth that a
thin line/ribbon shows starkly. **The WEB does NOT suffer** because it lives in a local
`THREE.Group` positioned at the net, with vertices a few metres from *local* origin (tiny
coords, full precision). `logarithmicDepthBuffer` fixes depth precision, NOT attribute
precision.

**THE FIX (for next shift):** build the tether in a **local/anchor-relative frame**, not
world space. Concretely: pick an anchor (the mother's world position), set the tether
object's `.position` to that anchor, and feed `LineGeometry.setPositions` with points
**relative to the anchor** (`p - anchor`, values now ~0.0003 units → precise). Same
trick the web already uses. This is primitive-agnostic — a tube would need it too.
(Quick sanity check before building: log `this.projectilePos` magnitude and confirm it's
~64–84.) **Do NOT** just revert to the thick tube — that only hides it and re-introduces
the "thick white column" the owner also disliked.

## §B — DEFECT 2: web reads "cold"/small/gray at the real in-game framing
**Symptom:** owner: "looks like cold shit." In the spike (camera framed close, net fills
~⅓ frame) the ivory web is warm + gossamer + clearly a net. In-game at the M1 fire
framing the net is **small and far** (fills <10% of frame), so the fine ivory threads
read as a faint **gray wireframe sphere** against black — cold and cheap-looking. Bloom
does not enhance it at that pixel size.

**This is NOT a primitive or hex-colour problem** — it's framing + apparent size +
luminance. Candidate fixes for next shift (needs owner taste, use `?shotauto=1` loop):
- **Camera/framing:** the Mother first-fire needs a closer ceremony cam (the Daughter has
  `NET_CEREMONY_*`; the Mother on M1 may not frame the net). The close-up is the look that
  was approved — get the camera there.
- **Apparent size:** `NET_WEB.MOTHER_DIAMETER` is 5 m; the net may simply be too small at
  this camera distance. Either enlarge or close the camera.
- **Luminance/warmth at distance:** raise thread opacity/emissive or add a faint additive
  rim so the web doesn't gray-out when small; consider a subtle self-illuminated tint so it
  doesn't depend on scene lighting (it's dim on the night side / against black).
- Re-evaluate against the spike `spike-fatline-ivory-open-*.png` (the approved target).

## §C — Dev tooling left in place (USE THIS — it's the feedback loop)
- `http://localhost:8080/?shotauto=1` → fire net (N) → PNGs auto-saved per beat. Read them
  with the image tool. `?shot=1` for manual `__netShot('name')`/`__netPause(true)`.
- `npx http-server -p 8080 -c-1 .` serves it (JS is network-first in `sw.js`, so a normal
  reload picks up edits; no hard-reload needed).
- Throwaway spike: `netspike.html` + `js/spike/NetLookSpike.js` (`?auto=1`). **Do not
  commit** the spike or the loose `netshot-*.png`/`spike-*.png` in the repo root + `tmp/`.

## §D — Decisions for next shift / owner
- **Keep vs revert:** the `NetMeshKit` fat-line web is sound (good close-up, tests green) —
  keep it; fix framing (§B). The **tether fat-line is currently broken (§A)** — either fix
  with anchor-relative coords or revert `LassoSystem` tether to its prior committed tube
  until §A is done. The Constants tether-radius slimming (0.7→0.4) is moot if the tether is
  reworked.
- **Tests:** `node js/test/run-tests.js` = 858/3478/0. Re-run after any change.
- **Not started:** Phase B.5 (Daughter re-dock vanish/180° tether — see
  `.kilo/plans/daughter-redock-vanish-tether-analysis.md`) and Phase C (Mother-as-Daughter
  S3). Both still blocked on Phase B sign-off.
- **Housekeeping:** loose capture PNGs + `tmp/` clutter the repo root; gitignore or delete.

## §E — Hard-won lessons (don't repeat)
1. **Always verify in-game at the REAL camera framing**, not just a close-up spike. The
   spike approved a look that fails at the actual M1 distance. The spike is necessary but
   not sufficient.
2. **Thin lines/ribbons far from the world origin will alias/sawtooth** due to float32
   attribute precision. Anything thin must be built in a local frame near origin (like the
   web group). This is the real reason the tether keeps looking jagged across tube AND
   fat-line — stop blaming the primitive.
3. The original "cold/jagged" web WAS correctly diagnosed (1-px `LineBasicMaterial`); the
   fat-line fixes that *up close*. The remaining "cold" is a *distance/framing* problem.

---

# ⚑ SESSION HANDOVER — 2026-06-23 (cont.) — both §A/§B defects fixed + verified in-game

**Status: both rejected defects addressed and CONFIRMED in a real headless render at
the actual M1 fire framing.** All 858 suites / 3478 tests still green. Uncommitted on
top of HEAD `71328a3` (await owner sign-off before commit / Phase B.5 / Phase C).

## DEFECT 1 (tether sawtooth) — FIXED
- **Fix:** `LassoSystem._rebuildTetherGeometry` now builds the tether in an
  **anchor-relative local frame** (exactly the §A prescription): `_tetherMesh.position`
  is parked at `startPos` and every vertex is stored as `p − startPos` (float64
  subtraction → ~0.0003-unit offsets at full float32 precision; the uniform matrix
  translation shifts the whole strand together, so no per-vertex wobble). Primitive-agnostic.
- **Verified:** in-game open AND reel frames now show a **smooth** ivory strand (was a
  regular lightning-bolt zigzag). The fat-line primitive was never the cause — float32
  world-coordinate precision was (lesson §E.2 confirmed).

## DEFECT 1b (tether "disconnect from mother") — FIXED (2nd pass, owner feedback)
- **Owner:** *"Tether seems disconnect from mother at some times."* Root-caused by
  numeric probe (Brave CDP `Runtime.evaluate` on the live `__lasso`): two independent issues.
  1. **8 m anchor gap.** The outbound (flight) tether anchored at the *spawn muzzle* —
     `LASSO_MUZZLE_OFFSET_M` = **8 m** along the **velocity** vector. That is ~4 ship-lengths
     ahead of the hull AND off the net's line whenever the cast direction ≠ prograde (the
     common case), so the strand started in empty space ahead of the mother and bowed into
     an arch → "detached." **Fix:** new `LassoSystem._computeTetherAnchor(playerPos, netPos)`
     anchors the flight tether at the **nose tip** (`min(1.5 m, dist·0.5)`) along the
     direction **to the net** (collinear, never off-axis). Spawn muzzle + muzzle-flash
     stay at 8 m (unchanged). Reel-in already anchored at `playerPos` (kept).
  2. **World-Y catenary sag.** `mid.y −= sag` bowed the strand along a fixed world axis,
     arching it over the hull at most orbital attitudes. **Fix:** sag now points toward
     **nadir** (`−normalize(mid)`, Earth at scene origin), so it hangs gently planetward
     and vanishes to taut when the tether is radial — never arches across the mother.
- **Verified (numeric + visual):** the tether geometry is a clean straight line from the
  nose to the net; anchor↔hull gap reduced 8 m → 1.5 m. The faint **arch that remains over
  the ship is NOT the tether** — it is a `PlayerSatellite` model ring (`CollarRing`/`MLI_Seam`
  torus) seen edge-on; confirmed by hiding `_tetherMesh` and watching the arch persist.

## DEFECT 1c (tether "jumps suddenly to wrong position") — FIXED (3rd pass, owner feedback)
- **Owner:** *"Tether jumps suddenly to wrong position."* Per-frame numeric trace
  (monkey-patched `_rebuildTetherGeometry` over CDP, logging raw start/end/player every
  frame) showed the flight tether **start sat ~100 m radially outward** from the hull, then
  **snapped back to the hull at the reel flip** (length 101 m → 17 m in one frame).
- **Root cause:** a **Vector3 aliasing bug in my own `_computeTetherAnchor`** (introduced in
  the 1b pass). `const dir = out.copy(...)` made `dir` and `out` the **same object**, so
  `out.copy(playerPos).addScaledVector(dir, off)` added `playerPos·off` → anchor parked at
  `playerPos·(1+off)` ≈ 100 m radially out (the trace's `start − player` = `playerPos×off`
  matched exactly). This was ALSO the real cause of the 1b "disconnect/arch" (the 8 m muzzle
  was a red herring once this bug existed).
- **Fix:** single-buffer math, no alias — `out = (net−player)`, then
  `out.multiplyScalar(off/dist).add(playerPos)`. Verified by trace: flight anchor now ~1.5 m
  from the hull, length continuous across the reel flip (no snap), and visually the tether
   is one clean straight strand from the net apex to the nose.

## DEFECT 1d (captured debris "disappears", not visible in net / at nose) — FIXED (4th pass)
- **Owner:** *"debris seems to disappear ... should be visible in the net, should be pulled
  in to the mother's nose."* Numeric CDP trace (wrapped `LassoSystem.update` to stash the
  debrisField; queried the live debris by a FIXED id through the whole lifecycle) proved the
  pin pipeline is **functionally correct**: `this.target` IS the live debris (`targetIsLive:
  true`), it is `_armPinned` + LOD-exempt through reel, reels from ~17 m → **4 m at the nose**,
  the cargo system holds the **live** instance (`cargoTargetIsLive: true`), and it stays
  pinned at the nose through the furnace — nothing is culled or removed early. (An earlier
  probe's "removed" reading was a false alarm: `_resetLasso` nulls `_targetId` at stow, so
  `getDebrisById(null)` returned null — the debris persists under its real id.)
- **Root cause:** purely **apparent size**. A captured M1 welcome FRAGMENT is ~0.6 m
  (`sceneSize` 0.000006 scene units) → sub-pixel at the gameplay camera, hidden at the net's
  cinched apex during reel and a speck at the nose. Not a frame/pin/cull bug.
- **Fix:** while a catch is **held by the Mother net** (reel → cargo/furnace) clamp its
  apparent render size up to a readable floor. `Constants.MOTHER_CATCH_MIN_RENDER_M = 1.5 m`;
  `LassoSystem` sets `debris._catchRenderMin` at every `_armPinned = true` and clears it at
  every release; `DebrisField._updateInstanceTransform` clamps `scale` up to it **only when
  `_armPinned`** (so a stale override can never inflate a released piece). Scoped to
  lasso-held catches via the opt-in field, so the **Daughter pipeline is untouched** (its
  small nets would burst with a fixed floor). Stays well under the 7 m mouth / ~1.75 m
  cinched mouth. Tunable.
- **Verified:** render scale during reel/hold = 0.000015 (1.5 m, up from 0.6 m); the catch
  now reads as a dark chunk **visible inside the net during reel and held at the nose**
  through the furnace. Tests 858/3478/0.

## DEFECT 2 (web "cold/small/gray" at the real framing) — IMPROVED + verified
- **Root cause confirmed in-game:** production had **drifted off the owner-approved spike
  spec** — D 5 m (spike 7), 28×8 spokes/rings (spike ~20–22×6), 1.5 px (spike 2.0),
  opacity 0.6 → at the distant M1 framing the over-fine thin threads collapsed into gray fuzz.
- **Fix (`Constants.NET_WEB`):** `MOTHER_DIAMETER 5→7`, `RADIAL_SPOKES 28→20`,
  `RING_COUNT 8→6`, `LINE_WIDTH_PX 1.5→2.4`, `WEB_OPACITY 0.6→0.8`, `WEB_COLOR
  0xcfeaff→0xeaf1ff` (brighter warm-ivory). Restores the approved spike vocabulary and
  keeps the threads legible/luminous when small, without dwarfing the ship (scale tension OK).
- **Verified:** in-game open (ivory) + captured (green) frames now read as a clear, bold,
  warm woven web — noticeably bigger/brighter/clearer than the rejected build.
- **Note for owner:** the net is good now but still smaller than the *spike close-up*
  (which was framed tight). If you want it to fill the frame like the spike, the remaining
  lever is a **closer Mother-fire ceremony cam** (the Daughter has `NET_CINEMATIC`; the
  Mother on M1 has none). That is Phase-C territory (shared ceremony) — deliberately NOT
  built this session to avoid a new camera mode before Phase B sign-off.

## Tooling note (closes the §C "blind agent" gap autonomously)
The screenshot loop was driven **headlessly** this session (no owner keypress needed):
Brave `--headless=new --use-angle=metal` + a throwaway Node CDP driver (Node 22 built-in
`WebSocket`) that starts the mission and mashes **Space** (the InputManager rapid-advance:
target→autopilot→net), then `Page.captureScreenshot`s the open/cinch/reel beats. Harness
lives in the external temp dir (NOT in the repo). `npx http-server -p 8080 -c-1 .` left
running for the owner's own `?shotauto=1` pass.

## Still open (unchanged): Phase B.5 (Daughter re-dock) + Phase C (Mother-as-Daughter S3),
both blocked on owner Phase B sign-off. Daughter net shares the kit defaults (now coarser/
bolder) — covered by tests + its own close ceremony cam; recommend an owner eyeball on M2+.

