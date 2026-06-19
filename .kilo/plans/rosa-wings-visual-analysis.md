# ROSA Wings — Visual Analysis: glint / reflection / bloom (top, bottom, edges)

Scope: the Mother's two ROSA solar wings (`_buildSolarPanels` +
`_buildRosaStructure` in `js/entities/PlayerSatellite.js`). This documents how
each surface currently lights/reflects/blooms, the asymmetries between the
**gameplay** scene and the **menu hero**, and concrete findings (incl. a latent
bug). No source edits yet — this is analysis + options for sign-off.

---

## Lighting / post-FX environment the wings live in

| Factor | Gameplay (`SceneManager`) | Menu hero (`MenuScene3D`) |
|---|---|---|
| Directional sun | `0xffffff` @ **2.0** (`SunLight.js:159`) | own sun rig |
| Hemisphere fill | `0x4488bb`/`0x111122` @ **0.03** (negligible) | — |
| **`scene.environment` (IBL)** | **NONE** (`background`=black, `SceneManager.js:74-75`) | **PMREM `RoomEnvironment` @ 0.30** (`MenuScene3D.js:979-982`) |
| Tone mapping | ACES Filmic, exposure 1.0 (`SceneManager.js:66-67`) | — |
| Bloom | UnrealBloom strength **0.08**, radius 0.4, **threshold 4.0** (`SceneManager.js:263-271`) | — |

**Consequence (most important):** `panelMatFront` is a `MeshPhysicalMaterial`
relying on `metalness`, `clearcoat`, and `iridescence`. Those three only produce
their "glassy AR-coating" reflections from an **environment map**. The menu has
one; **gameplay does not**. So the rich iridescent/reflective sheen the front
material is tuned for is **only visible in the menu** — in actual play the front
falls back to a single broad directional-sun specular highlight and reads much
flatter than intended. This is the central glint/reflection asymmetry.

---

## TOP surface — front PV face (`ROSA_Panel_Front_*`, `FrontSide`)

`PlayerSatellite.js:1536-1551`
- `MeshPhysicalMaterial`, `map`/`emissiveMap` = shared procedural cell texture
  (`solarCellTexture.js`: near-black GaAs cells, silver fingers/busbars).
- `metalness 0.25`, `roughness 0.62` → deliberately soft/broad highlight (comment
  says lowered to stop sun glint blowing out under the 2.0 sun + ACES).
- `clearcoat 0.3 / clearcoatRoughness 0.5`, `iridescence 0.5`, IOR 1.8,
  thickness 120–420 nm → **no visible effect in gameplay** (needs env map).
- Emissive driven every frame by `_animateRosaGlow` (`:2566`): intensity
  `0.10 → 0.55`, hue indigo→cyan, **modulated by `emissiveMap`** so busbars/fingers
  self-glow more than cells. Scan-flash can override to cyan.

Glint/bloom behaviour:
- **Glint:** only the directional sun's GGX specular; with roughness 0.62 it's a
  large soft lobe, not a sharp sparkle. No env reflections in play.
- **Bloom:** none. Bloom `threshold` was raised 1.5→4.0 *specifically* to stop the
  panel/hull glint blooming as the ship rolls; the emissive max (~0.55) is also far
  below 4.0. So the wings never contribute bloom — by design, but it means zero
  "sun-catching sparkle" in play.

## BOTTOM surface — back substrate (`ROSA_Panel_Back_*`, `BackSide`)

`PlayerSatellite.js:1560-1564`, meshes at `z=0` (`:1609-1613`, `:1640-1643`)
- `MeshStandardMaterial`, copper-Kapton `0xc8a878`, `metalness 0.08`,
  `roughness 0.85` (near-matte), `emissive 0x6a5638 @ 0.26` self-lit floor
  (the prior "inverted wings vanish" fix; floor asserted in `test-RosaFurl.js`).
- No `map` → flat uniform copper; no glint by design; reads correctly when the
  Mother is inverted. three.js 0.184 auto-flips `BackSide` normals (`FLIP_SIDED`),
  so it is lit correctly. Front+back are coincident at `z=0` and mutually
  back-face-culled — correct (the old `−0.001` offset was really −100 m and is
  fixed; see `:1602-1608`).

Asymmetry note: front = glassy/detailed cell texture; back = plain matte copper.
Realistic, but the two faces look very different across an inversion.

## EDGES

1. **Zero-thickness blanket.** The blanket is a `PlaneGeometry` (`:1573`) with no
   thickness, so viewed edge-on each wing collapses to a ~1 px line / vanishes.
   The only thing that should give the edge visual mass is the boom/spreader
   structure — see finding below.

2. **★ LATENT BUG — edge booms & tip spreader float ~80 m off the blanket.**
   In `_buildRosaStructure` the booms and spreader are positioned with a **raw,
   non-`M`-scaled** `z = 0.0008` (`:1758` booms, `:1767` spreader):
   ```js
   boom.position.set(sign * rosaW / 2, edgeY, 0.0008);
   spreader.position.set(sign * rosaW, 0, 0.0008);
   ```
   But `M = 1e-5` (1 unit = 100 km), so the blanket is ~`1e-5` units (~1 m) and
   the booms are `ROSA_BOOM_OD*M = 2e-7` units (2 cm). A raw `0.0008` = **~80 m**
   along the panel normal — i.e. the booms/spreader are flung ~80× the panel width
   off the blanket (and ~4000× the boom diameter). This is the **exact same
   unit-mismatch class** as the just-fixed back-face `−0.001 = −100 m` bug
   (`:1605-1608`), which was patched on the panel but **not** on the structure.
   Net effect: the wing's long-edge booms and tip spreader render far away /
   effectively absent, so the wings currently have **no edge detailing** — just
   the bare thin blanket edge. (The root drum/bracket/curls use `M`-scaled
   positions and are unaffected.)
   - Likely intent: a tiny anti-z-fight nudge, e.g. `boomOD` or `~0.5 mm`:
     `0.0005 * M` (= `5e-9`) rather than the raw `0.0008`.

---

## Decisions (from review) & work items

**A. Fix the boom/spreader z-offset (bug fix — CONFIRMED).**
Replace the raw `0.0008` at `:1758` (boom) and `:1767` (spreader) with an
`M`-scaled epsilon (e.g. `boomOD * 0.6` or `0.5 * M` ≈ `5e-9`) so the slit-tube
booms + tip spreader sit on the blanket edges and the wings regain edge structure
(and edge-on mass). Add a headless guard asserting their local `z` is within a
tiny `M`-scaled bound of the blanket plane (mirror the existing back-face
coplanar test at `test-RosaFurl.js:374`).

**B. Reflection parity — CONFIRMED B1: add a cheap gameplay env map.**
Add a low-intensity `scene.environment` to the gameplay `SceneManager` (PMREM
from `RoomEnvironment`, `environmentIntensity ≈ 0.15–0.20` — lower than the
menu's 0.30 because the back-overbright issue in D means we must NOT add much
extra GI). Bake once at init; dispose the PMREM RT. **Verify** hull, daughters,
and especially the back substrate don't get too hot (re-check D after enabling).

**D. ★ Back substrate "almost blinding" within ±15° of direct sun — FIX (CONFIRMED: D1 + D2).**
Root cause: when the Mother is inverted, sun-tracking (front clamped to ±30°)
leaves the **back** roughly sun-normal. The back is a bright copper Lambertian
(`0xc8a878`, albedo ≈ 0.78) lit by the 2.0 sun, and the **0.26 emissive floor
stacks additively on top** of that already-bright diffuse → a uniform overbright
slab (no texture to break it up). Do **both**:
   - **D1 (darker base — CONFIRMED):** drop the back `color` to a deeper amber-bronze
     (e.g. `~0x9a754a` or darker). Real copper-Kapton backing is darker than the
     current light copper; lowers peak direct-sun diffuse with no code.
   - **D2 (sun-gate the emissive — CONFIRMED):** make the back emissive adaptive
     like `_animateRosaGlow` does for the front — hold it at the `0.26` floor only
     when the back is **not** strongly sunlit (in shadow / facing away), and ramp
     it toward ~0 as the back's sun incidence rises. This removes the additive
     overbright in direct sun while preserving the inverted-in-shadow visibility
     floor (the never-vanish fix). Needs a `_rosaBackMats` handle + a few lines in
     an animate pass; reuse the sun-incidence already available.
   - Test impact: `test-RosaFurl.js:364` asserts the **static build-time**
     `emissiveIntensity >= ROSA_BACK_EMISSIVE_MIN (0.24)`. Initialize the material
     at the `0.26` floor (test still passes); the runtime gate only lowers it when
     sunlit. Optionally add a test that the gated value drops under strong back-sun
     and returns to the floor in shadow.

**C. Glint / bloom — CONFIRMED: keep tamped, no bloom.**
Do **not** lower the global bloom threshold or front roughness for sparkle. Leave
the current anti-blowout tuning. (The env map from B will add a little front
sheen, which is the intended richness without bloom.) The only brightness change
in scope is reducing the back-face overbright (D), not adding glint.

**E. Edge-on vanishing.** Mostly addressed by A (booms back on the edge). Giving
the blanket a hair of thickness is optional / lowest priority — skip unless still
objectionable after A.

---

## Suggested verification
- Manual: deploy ROSA; view face-on + edge-on + **inverted within ±15° of the
  sun**, in **both** gameplay and menu. Confirm: booms/spreader hug the blanket
  (A); front shows subtle AR sheen in gameplay (B); back is clearly visible in
  shadow yet **not blinding** when sun-normal (D); no new bloom (C).
- Headless: extend `js/test/test-RosaFurl.js` (or new `test-RosaPanels.js`):
  boom/spreader local `z` within an `M`-scaled bound (A); back static emissive
  still ≥ floor (D); optional gated-emissive shadow/sun assertions (D2).
- `node js/test/run-tests.js`.

## Files implicated
- `js/entities/PlayerSatellite.js` — `_buildSolarPanels` (front/back mats),
  `_buildRosaStructure` (boom/spreader z-offset), `_animateRosaGlow`.
- `js/scene/SceneManager.js` — env map / bloom (options B/C).
- `js/scene/solarCellTexture.js` — cell map (reference only).
- `js/test/test-RosaFurl.js` — regression assertions.
