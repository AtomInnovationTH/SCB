# Mother Hero Scene — Fidelity, EVA Suit, Rendering Notes & Upgrade Backlog

This note documents the **main-menu hero scene** (`js/ui/MenuScene3D.js` +
`js/ui/MenuScreen.js`): how it relates to the **canonical Mother**, the EVA-suit
design rules it follows, the **load-bearing rendering learnings**, what is
**deliberately culled** because the camera never sees it, and hardware a real
serviceable Mother would need but the current spec lacks.

Guiding rule: *don't invent hardware in the hero scene; if something essential is
missing from the canonical model, note it here instead of faking it.*

---

## 1. Source of truth (Mother)
- Geometry: `js/entities/PlayerSatellite.js` → `_buildModel()` and its
  sub-builders (`_buildMainBus`, `_buildCollar`, `_buildStruts`,
  `_buildThrusters`, `_buildSolarPanels`, `_buildSensors`, `_buildDockingPort`,
  `_buildNavLights`).
- Dimensions / mass: `Constants.OCTOPUS_V5` (Config G).
- Daughters: `js/entities/ArmUnit.js` (`Constants.WEAVER_BODY` 0.2³×0.3 m blue,
  `SPINNER_BODY` 0.1³×0.15 m green) — hex-prism free-flyers deployed on struts.

The menu builds a **standalone** model in a **separate WebGL context** (it does
NOT import `PlayerSatellite`, which has heavy side effects: scene-add, eventBus
subscriptions, system deps, and a different unit scale of 1 unit = 100 km). The
hero uses 1 unit = 1 m and mirrors the real ship **rolled −90° about its long
axis** so that:
- the two ROSA wings sit at **±Y** (top/bottom), leaving the **+X** side clear
  for the welding astronaut, and
- the forward optics (laser aperture + EO/IR/LIDAR gimbal) face **+X**, toward
  the camera and the astronaut servicing them.

## 2. Hero ↔ canonical mapping
| Hero scene element | Canonical source |
|---|---|
| Gold MLI barrel (2.0 m × 0.8 m) | `_buildMainBus`, `OCTOPUS_V5.CORE_LENGTH/ACROSS_FLATS` |
| Body-mount GaAs cells (front hemisphere only) + MLI seams | `_buildMainBus` (`BODY_MOUNT_POWER`) |
| Forward laser aperture + gold ring | `_buildMainBus` (20 cm Cassegrain) |
| EO camera / IR / LIDAR sensor gimbal | `_buildSensors` |
| Collar ring | `_buildCollar`, `COLLAR_Y/COLLAR_RADIUS` |
| 4 crossbow struts (hinge, root/tip collars, rib rings, reel cartridge + LED) | `_buildStruts`, `STRUT_*` |
| Docked **Weaver** daughter on a strut tip | `ArmUnit` (`WEAVER_BODY`) |
| 2 ROSA wings (cells + gold edge + tip spreader/root yoke) | `_buildSolarPanels`, `ROSA_*` |
| 4 FEEP main nozzles + 8 RCS nubs | `_buildThrusters` |
| Nav lights (port red / starboard green) | `_buildNavLights` |

> **Framing-only deviations (not spec changes):** `STRUT_LEN` trimmed 1.6 m → 1.2 m
> for a tidy frame; ROSA wings rolled to ±Y; docking port present in canon but
> **omitted from the hero** because it sits on the −X face the camera never sees
> (see §5).

## 3. EVA astronaut — NASA EMU design rules
The astronaut is procedural (`buildAstronaut`). It is **human-scale (~1.85 m)** on
purpose — a size reference that reads "the Mother is a compact ~2 m servicer."
Hard-won realism rules (these were iterated against feedback — honor them):

- **Soft goods are BAGGY, not skin-tight.** Limbs are fat, near-uniform white
  TMG fabric tubes (thigh r≈0.10, shin r≈0.085, upper arm r≈0.078). Earlier thin
  tapered tubes read as "spandex tights."
- **Minimal exposed metal — no chrome ring ladders.** Real EMUs show very few
  bright rings. Convolutes (accordion folds) are the **same off-white cloth**
  (`mat.suitFold`), and the only metal bearings are subtle **anodized** rings
  (`mat.suitRing`, low metalness) at the neck, waist, and wrists.
- **Convolutes bunch ONLY at flex joints** (elbow, knee, ankle) — they do NOT
  ladder the whole limb. An arm = shoulder scye → smooth upper arm → elbow
  convolute → smooth forearm → wrist bearing → glove. (We regressed to "5 rings
  per arm" once; the fix was joint-only folds.)
- **PLSS backpack + SAFER.** White PLSS with access panel, latches, caution
  decal; a **SAFER** propulsion module wraps the base with corner thruster pods.
  The PLSS/SAFER is the **camera-facing** side (see §5) so detail belongs here.
- **Hands grip the tools.** Gloves are fists (palm, four wrapped fingers,
  opposed thumb) closed around the welding torch / secondary tool handle.
- **Chunky fabric boots** with a dark sole and relaxed plantar-flexed toes
  (micro-g), slight L/R asymmetry so the pose reads as drifting, not a mannequin.
- **Markings:** gold sun visor, red EV1 ID stripes on the thighs, and a curved
  **Thai flag** patch wrapped onto the upper arm (cylinder-segment bands, not a
  flat floating decal).

## 4. Rendering & menu-scene learnings (LOAD-BEARING)
These cost real debugging time; change with care.

1. **Full-bleed layout.** The canvas is a background layer (`position:absolute;
   inset:0; z-index:0; pointer-events:none`) behind translucent UI panels; the
   START button stays clickable because the canvas ignores pointer events.
2. **Size with a `ResizeObserver`, not just `window` resize.** `init()` runs
   while the menu is `display:none` (so `clientWidth === 0`). Nothing re-sizes
   the canvas on the hidden→visible transition unless a `ResizeObserver` (and a
   resize-on-`start()`) handles it — otherwise the composer renders into a 1×1
   buffer and you get a grey screen.
3. **An `EffectComposer` bypasses the renderer's built-in MSAA.** Render into a
   **multisampled HalfFloat `WebGLRenderTarget`** (`samples: 4`, matches
   `SceneManager` HIGH tier) or the full-screen hero looks pixelated/aliased.
4. **Bloom does not composite over a transparent canvas.** Give the scene an
   **opaque space-gradient background** so the bloom pass has an opaque base; the
   canvas then IS the page backdrop. A CSS vignette sits on top for contrast.
5. **Bloom must be restrained.** `UnrealBloomPass` strength ≈ 0.28, threshold
   ≈ 1.0, exposure 1.0 — only the arc / lights / glints bloom, not the gold body.
   High values were "almost blinding."
6. **Reflections need an environment map.** PBR gold/metals read flat without
   `scene.environment` (PMREM from `RoomEnvironment`, low `environmentIntensity`).
7. **Pipeline order:** `RenderPass → UnrealBloomPass → OutputPass`; `OutputPass`
   applies ACES tone-mapping + sRGB (don't double-encode).

## 5. What the fixed camera never sees (deliberately culled for perf)
The satellite never rotates and the camera only **sways across the +X/+Z side**,
and the astronaut welds **away** from the camera (chest at −X toward the Mother;
camera sees the **back** — PLSS/SAFER, back of helmet/limbs, boot soles). So we
removed geometry that is provably never visible:

- **Back-hemisphere body solar cells** (facets with `cos(az) < −0.30`).
- **Docking port + guide cone** (−X face).
- **ROSA back-substrate meshes** (both wings face cells at the camera; the back
  is never seen).
- **Chest DCM module + knobs + gauge** (−X chest, toward the Mother).
- **Per-frame visor flash update** (the gold visor faces the Mother, not us).

> **Composition trade-off:** because the welder faces the work, the iconic gold
> visor is essentially never seen. The back-view (PLSS + SAFER + arms reaching to
> the glowing weld) is the hero surface, which is why detail was invested there.
> To feature the visor would require re-framing the camera to the −X (Mother)
> side or turning the helmet ~40°.

## 6. Recommended Mother upgrades (essential hardware absent from the canon)
Prototyped in the hero, then **removed** to keep it faithful to the *current*
model. When adding, update **both** `Constants.OCTOPUS_V5` and
`PlayerSatellite._buildModel()`, then re-introduce to `buildSatellite()`.

1. **Thermal radiators.** No heat-rejection surfaces exist. Suggested: body-mount
   OSR radiator panels on anti-sun facets (clear of ROSA 0°/180° and arm planes
   60°/120°/240°/300°). Add `OCTOPUS_V5.RADIATOR_AREA_M2` + dissipation budget.
2. **Communications antennas.** Comms/telemetry logic exists but no antenna
   geometry. Suggested: steerable high-gain dish + low-gain omni for safe-mode.
3. **EVA crew aids.** Handrails / translation path + tether attach points near
   the optics bench and collar, if on-orbit servicing is canon.
4. **Robotic grapple / berthing fixture** (FRGF-class) near the CoM/collar.
5. **Dedicated star tracker(s)** with sun-shades (separate from the EO/IR/LIDAR
   target gimbal) for attitude determination.
