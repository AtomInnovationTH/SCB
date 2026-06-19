# Fix: ROSA solar panels "disappear" when the Mother is upside down

## Symptom
On the Mother (PlayerSatellite), the deployed ROSA solar wings appear to vanish
when the ship is flipped upside down (viewed from the panel back side).

## Root cause (regression in commit `0d5abe8` — "v.99 ROSA furl/feather + visuals")

Each ROSA wing blanket is a zero-thickness plane rendered as **two coincident
meshes** sharing one geometry:

- `ROSA_Panel_Front_*` — `MeshPhysicalMaterial`, `side: THREE.FrontSide`
  (the recognizable dark-blue glowing PV cell face). Visible only from the
  panel's `+Y` (body) side.
- `ROSA_Panel_Back_*` — `MeshStandardMaterial`, `side: THREE.BackSide`
  (the substrate). Visible only from the `-Y` (body) side.

When the Mother inverts, the camera looks at the **back** side: the FrontSide PV
face is back-face-culled (correct), so the only thing left to render is the
BackSide substrate. The v.99 rewrite made that substrate far too dark/dim, so it
reads as "gone" against black space / Earth.

Substrate material, before vs after the rewrite (`js/entities/PlayerSatellite.js`):

| | Pre-v.99 (worked) | Current (`_buildSolarPanels`, ~line 1549) |
|---|---|---|
| `color`    | `0xccccdd` (bright silver) | `0xb08d57` (copper) |
| `emissive` | `0xccccdd` | `0x3a2c18` |
| `emissiveIntensity` | **0.4** (self-lit, never goes black) | **0.18** (dim) |

The pre-v.99 bright/self-illuminated back was the *explicit fix* for this exact
"inverted panel vanishes / dark shadow on Earth" bug (see
`archive/HANDOFF_2026-05-30_four-fix.md` Issue 4 and `archive/FIX_PLAN.md`).
The v.99 visual overhaul reintroduced the regression by dimming the back face.

### Not the cause (ruled out)
- **Back-face lighting / normals.** three.js `0.184.0` auto-flips normals for
  `BackSide` (`#ifdef FLIP_SIDED transformedNormal = -transformedNormal` in
  `defaultnormal_vertex.glsl`), so the current unflipped-geometry + `BackSide`
  back mesh is lit correctly. Do **not** re-add a manual normal flip — that would
  double-flip and darken it.
- **Furl/feather.** Default state is fully deployed (`_rosaFurlProgress = 1`);
  furl/feather are manual (`,` / `Shift+,`) and not orientation-driven.
- **Sun-tracking math.** `_animateSolarTracking` only changes tilt (clamped
  ±30°); it cannot hide the mesh.
- **Frustum culling.** Not enabled on these meshes.

## Fix

**Context confirmed:** the disappearance is seen in **gameplay** while rolling
the Mother (not just the menu hero).

Make the ROSA blanket read as a present, visible wing from **both** sides, so an
inverted Mother still clearly shows its arrays — restoring the known-good
behavior while keeping the new copper-Kapton look.

### Primary approach (recommended) — keep copper-Kapton, make it visible
Edit the `panelMatBack` definition in `_buildSolarPanels()`
(`js/entities/PlayerSatellite.js`, ~line 1549):

- Raise `emissiveIntensity` back to a self-illuminating floor (~`0.35`–`0.4`) so
  the substrate never collapses to black when its face is away from the sun /
  in shadow.
- Lighten the substrate so it reads against space — bump `emissive` toward a
  brighter copper (e.g. `0x6a5638`) and/or lighten `color`. Keep it visually
  distinct from the blue PV front (still reads as the wing's back, not the cell
  face).

This restores the pre-v.99 "self-lit, never-black" back-face behavior with the
new copper look.

### Accepted alternatives (user also approved these)
- **Bright silver substrate (pre-v.99):** set the back `color`/`emissive` back to
  silver (`~0xccccdd`) at `emissiveIntensity ~0.4`. Simplest exact restore.
- **PV cells on both sides:** give the back mesh the same cell texture/map as the
  front (or reuse a front-style material on the back) so the wing looks identical
  from any angle and can never read as "gone." Most robust against vanishing;
  least physically accurate. (Do this via the back mesh's material — do NOT switch
  the front to `DoubleSide`, which reintroduces the original dark-back "shadow on
  Earth" bug.)

Pick one during implementation; the recommended copper option is the default.

## Verification
1. **Manual:** Launch, deploy ROSA, roll the Mother 180° (and orbit the menu
   hero past upside-down). The wings must remain clearly visible from the back —
   no vanishing, no dark rectangle on Earth.
2. **Automated (regression guard):** In a headless test (e.g. extend
   `js/test/test-RosaFurl.js` or a new `test-RosaPanels.js`), assert that after
   `_buildSolarPanels()` each wing has both a Front (`FrontSide`) and Back
   (`BackSide`) mesh and that the back material's `emissiveIntensity` is above a
   minimum threshold (so a future dimming can't silently re-break it).
3. Run the full suite: `node js/test/run-tests.js`.

## Files touched
- `js/entities/PlayerSatellite.js` — `panelMatBack` in `_buildSolarPanels()`.
- (optional) `js/test/test-RosaFurl.js` or new test file — regression assertion.
