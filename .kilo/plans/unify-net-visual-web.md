# Unify the Capture-Net Visual — one elegant "web in space" for Mother + Daughter

> **Goal (owner's words):** *"A net in space can be simple, elegant, beautiful web."* The current
> Mother net reads as *"cold shit — big, clunky, obnoxious."* Replace the Mother net's rejected
> look and **unify Mother + Daughter on ONE shared net vocabulary** (handoff option **B**), keeping
> every functional/lifecycle win from commits `e5609e6`→`b593dbf`. Browser-playtest before "done".

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
</content>
</invoke>
