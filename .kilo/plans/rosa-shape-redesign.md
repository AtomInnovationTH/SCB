# ROSA Panel Shape — Accuracy Audit + Gameplay-Aware Redesign Options

## 0. Purpose
Answer four things the user asked, with **verified** facts (not guesses):
1. What is the actual shape of real ROSA panels?
2. What is the shape of the panels currently on the Mother?
3. What shape / mod would coexist best with the Mother's tethers (reel-in at
   various angles), struts (open at various angles), and daughter launch/reattach
   with debris?
4. What visual improvements would make the panels look better within reasonable
   artistic limits?

This is a PLAN ONLY. No source files change until a direction is chosen.

---

## 1. Real ROSA — verified shape (source: en.wikipedia.org/wiki/Roll_Out_Solar_Array, Redwire/NASA)
- **Flat rectangular flexible blanket** ("center wing") of PV cell strings. Real
  ROSA wings are **plain rectangles — no chamfered/clipped corners.**
- **Two high-strain composite slit-tube booms run the full length along BOTH long
  edges.** They look like split tubes (flattened, rolled lengthwise) and are the
  structural spars. Booms are **dark carbon-composite** (read near-black), not pale.
- **Stows by rolling the whole wing onto a root spool/mandrel into a compact
  cylinder** ("like a tape measure"). **Deploys passively** (boom strain energy,
  no motor).
- **Proportions are LONG and NARROW, and the deploy axis is the LONG axis** — the
  wing unrolls lengthwise:
  - ROSA flight test wing: **1.6 m wide**.
  - DART arrays: **8.53 m (28 ft) long** when unrolled.
  - iROSA: **~half the width of the legacy ISS wings (~6 m wide), ~18–19 m long**
    (~3:1), mounted on a bracket and **canted ~10°** off the host plane.
- **Re-stow is NOT a normal capability** — the 2017 test could not re-lock stowed
  and was jettisoned. (So the Mother's furlable array is a deliberate sci-fi mod.)

**Key takeaway:** real ROSA = a *long, narrow, square-cornered* rectangle whose
**long dimension is the deploy/roll-out direction**, with dark booms down both
long edges and a root spool.

---

## 2. Mother's current panel shape (verified from code)
Source: `PlayerSatellite._buildSolarPanels` + `OCTOPUS_V5` constants.
- Two wings at **azimuth 0° / 180° (±X)**, on a shared `_solarArrayPivot`, each
  pivoting at the barrel surface (`barrelR`) at **Z = 0 (barrel center)**.
- Blanket is **`ROSA_WIDTH` 1.0 m × `ROSA_LENGTH` 2.0 m** with **0.30 m chamfered
  outboard corners** (`ROSA_CHAMFER`).
- Wrapper maps local XY→world XZ: the **roll-out / deploy direction is the SHORT
  1.0 m radial (X) axis**; the **2.0 m dimension runs AXIALLY along the barrel
  (Z), spanning Z ≈ [−1.0, +1.0]** (the full `CORE_LENGTH` 2.0 m hull).
- Deployed tip sits at radius ≈ `barrelR(0.4) + 1.0 = 1.4 m`.
- Sun tracking: single-axis tilt about the boom (X) axis, **clamped ±30°**, with a
  code comment that the clamp exists *specifically to stop the ROSA trailing edge
  hitting the arm struts* (0.20 m clearance at 30°).
- My recent furl work added edge booms, a tip spreader, a root drum, and the `,`
  furl/unfurl toggle.

**Differences vs real ROSA (the inaccuracies):**
| Aspect | Real ROSA | Mother now |
|---|---|---|
| Corners | square rectangle | 0.30 m chamfer |
| Aspect & deploy axis | long, deploys along long axis | short radial deploy, long along hull |
| Radial reach | very long (8.5–19 m scaled) | short (1.0 m) — clearance-friendly |
| Boom color | dark composite | pale (`0xb8b29a`) |
| Cell pattern | longitudinal cell strings | uniform 12×24 grid |

The Mother's short-radial / long-axial choice is actually **good for clearance**
but **reads less like ROSA**. That tension drives the options in §4.

---

## 3. The gameplay envelope the panels must share (verified)
- **Struts:** azimuths **[60,120,240,300]°** at Y0 (`ARM_LADDER.Y0_QUAD`), hinged
  at radius `COLLAR_RADIUS` 0.40 at **Z = +0.90** (forward band), length 1.60 m,
  sweeping **α = 0 (aft −Z) → π/2 (radial) → π (zenith +Z)**. Higher tiers add
  **30° / 330°** struts → only **30° from the 0° ROSA plane** (tighter clearance).
- **Tethers / reel-in:** reel cartridge at **85% along each strut**; captured
  debris is winched from far out **toward that reel point along the strut's
  azimuth plane**, and swings on the tether — a large, moving swept volume per arm.
- **Daughters:** dock at strut tips, **launch outward and return/reattach** —
  flight paths radiate from the strut tips.
- **Panels:** occupy the 0°/180° plane, Z ≈ [−1,+1], radius 0.4→1.4, and the
  ±30° sun-tilt swings their long edges **toward** the 60°/120° strut planes.

**Conflict summary:** the panels are deliberately parked in the widest azimuth gap
(60° from struts at Y0), but (a) tier upgrades shrink that gap to 30°, (b) tilt
tracking pushes panel edges toward struts, and (c) tethered/​swinging debris and
daughter paths sweep the radial shell the panel tips also sit in. The new furl is
the dynamic escape hatch; shape choices below reduce the static risk.

---

## 4. Chosen direction — Option B (radial plane; accuracy pass + feather + tier-aware clamp)
Decision (user): **Option B, WITHOUT auto-protect.** Stay in the clearance-friendly
0°/180° radial plane at the current compact size; make the wings read as real ROSA;
add a **manual feather** control and a **tier-aware tilt clamp** so the panels
coexist better with struts/tethers/daughters. No event-driven auto furl/feather.

---

## 5. Implementation plan (Option B)

### 5.1 Visual accuracy pass (`PlayerSatellite._buildSolarPanels` + `_buildRosaStructure`)
1. **True rectangle (drop chamfer).** Set `ROSA_CHAMFER` usage aside: build the
   blanket as a plain `rosaW × rosaL` rectangle. Real ROSA are square-cornered.
   - Replace the chamfered `Shape`/`ShapeGeometry` front+back with **`PlaneGeometry`
     (rosaW × rosaL)**. Plane gives clean 0..1 UVs for the cell texture and removes
     the bespoke normal-flip clone logic.
   - Keep `ROSA_CHAMFER` constant defined but unused, or remove it and its
     `test-Constants` reference if present (grep first).
2. **Cell-string surface via the existing texture.** Reuse
   `getSolarCellTexture()` (`js/scene/solarCellTexture.js`) as the front material
   `map` + `emissiveMap` (it already renders dark GaAs cells with silver fingers +
   busbars; cells are "tall", so orient UVs/repeat so strings run **along the
   deploy/X axis**). Set `repeat` to roughly (cells across width)×(cells along
   length); tune `cols/rows`.
   - This **retires the separate wireframe grid mesh + its ShaderMaterial** and the
     gold-edge `EdgesGeometry` decal stack — the texture now carries cell detail,
     so the coplanar grid/edge depth-fighting layers (and their `depthTest:false`
     workarounds) go away entirely. Net simplification.
   - Keep one slim **gold frame** as real boom/edge geometry if a bright rim is
     wanted (the booms in 5.1.4 already provide edge structure).
3. **Two-tone blanket.** Front = textured dark cells (slight emissive for shadow
   readability, as today). Back substrate = warmer copper-Kapton
   `MeshStandardMaterial` (e.g. ~`0xb08d57`, low metalness) instead of the current
   light grey, with a subtle sheen.
4. **Dark composite booms + spool curl.** Recolor the edge booms (added in the
   furl work) from pale `0xb8b29a` to **near-black carbon** (~`0x1c1c20`, low
   metalness, mid roughness). Add a short **curved slit-tube segment** where each
   boom meets the root drum (a quarter-torus / bent cylinder) so the tape-spring
   "uncoiling" read is visible — the signature ROSA silhouette.
5. **Slim tip bar.** Keep the tip spreader but thin it (smaller `ROSA_SPREADER_OD`)
   so it reads as a leading-edge deployment bar, not a fat rod.
6. **Hero scene:** no code change needed — `MenuScene3D` reuses the real
   `PlayerSatellite`, so it inherits all of the above. Re-check framing visually.

### 5.2 Tier-aware tilt clamp (`_animateSolarTracking`)
- Today the sun-track tilt is clamped to ±30° (comment: avoids hitting struts at
  60°/120°). At Y1+ tiers, struts appear at **30°/330°** — only 30° from the ROSA
  plane — so the existing clamp is too loose.
- Read the active tier's `azimuths` (via `armManager`/`ARM_LADDER`) and compute the
  **smallest azimuth gap** between the ROSA plane (0°/180°) and any strut. Derive a
  tighter `maxTilt` when a strut sits within ~30° of the plane (e.g. clamp to
  ±15–20°). Fall back to ±30° at Y0.
- Add a constant like `ROSA_TILT_CLAMP_TIGHT_DEG` / keep `±30` as the loose default.

### 5.3 Manual feather control (complements furl)
A "feather" parks the wings **edge-on** (cross-section minimized) to a hazard —
faster than a full furl, retains more power. Make it **manual** (no auto-protect).
- **State:** `_rosaFeather` (0 = sun-facing/normal tracking, 1 = feathered edge-on),
  animated toward a target at a feather rate; reuses the existing per-panel tilt
  pivots (`panelRightPivot/panelLeftPivot` rotation about the boom X axis ≈ 90°).
- **Interaction with tracking:** when feathered, `_animateSolarTracking` yields to
  the feather angle (skip sun-track, like the existing furl `<0.5` early-return).
- **Interaction with power:** edge-on → near-zero sun incidence, so existing
  `_updateSolarPower` `sunAngle` term already drops power naturally (no separate
  multiplier needed). Document that feather cuts power via geometry, furl via the
  ROSA-share multiplier.
- **Control:** `Shift+,` (Shift+Comma) toggles feather, parallel to `,` = furl.
  Add to `InputManager` Comma case (branch on `e.shiftKey`), emit a
  `ROSA_FEATHER_INPUT` event (Events.js) for audio/telemetry parity, add a help-
  overlay line `[['⇧,'], 'toggle: Feather']`.
- **API on `PlayerSatellite`:** `toggleRosaFeather()` / `setRosaFeather(v)`, and
  reset in `resetRosaFurlState()` (rename to `resetRosaState()` or extend it) so a
  retry starts sun-tracking, not feathered.

### 5.4 Constants (`OCTOPUS_V5`)
- Adjust `ROSA_SPREADER_OD` smaller; add `ROSA_FEATHER_RATE` (~0.6/s, snappy),
  `ROSA_TILT_CLAMP_TIGHT_DEG` (~18). Keep `ROSA_FURL_RATE` etc.
- Decide chamfer constant fate (remove + update any test, or leave unused).

### 5.5 Files to change
- `js/entities/PlayerSatellite.js` — rectangle/plane geometry, cell texture,
  two-tone back, dark booms + spool curl, slim tip; tier-aware clamp; feather state
  + `toggleRosaFeather`/`setRosaFeather`; extend `resetRosaFurlState`.
- `js/scene/solarCellTexture.js` — reuse as-is (maybe a ROSA-tuned `cols/rows`).
- `js/core/Constants.js` — spreader/feather/clamp constants; chamfer decision.
- `js/core/Events.js` — `ROSA_FEATHER_INPUT`.
- `js/systems/InputManager.js` — `Shift+,` feather branch in the Comma case.
- `js/ui/HotkeyOverlay.js` — feather legend line.
- Tests: extend `test-RosaFurl.js` (feather toggle/animate/reset, tier-aware clamp
  math) and `test-InputManager-Hotkeys.js` (Shift+Comma feathers; bare Comma still
  furls).

### 5.6 Risks / watch-items
- Removing the grid/edge shader stack: verify no other code references those mesh
  names (`ROSA_Grid_*`, `ROSA_GoldEdge_*`) — grep before deleting.
- UV orientation on the cell texture (strings must run along deploy, not across).
- Headless tests: `getSolarCellTexture` returns `null` without DOM — build code
  must already tolerate null map (confirm guard).
- Feather + furl interaction: define precedence (furl wins; feather only acts when
  unfurled) to avoid fighting animations.

### 5.7 Validation
- `npm test` green incl. new feather/clamp cases.
- Manual: panels read as ROSA (dark cell strings, dark booms, square corners);
  `,` furls, `Shift+,` feathers, both restore; tier upgrade tightens tilt so edges
  clear 30° struts; menu hero scene still frames correctly.

---

## 6. Decisions (resolved)
- **Direction:** Option B — radial plane, accuracy pass + manual feather +
  tier-aware tilt clamp. **No auto-protect** (no event-driven furl/feather).
- Furl (`,`) from prior work stays; feather added on `Shift+,`.
