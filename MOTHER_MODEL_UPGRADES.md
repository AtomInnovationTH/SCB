# Mother Model — Hero Scene Fidelity & Recommended Upgrades

This note documents how the **main-menu hero scene** (`js/ui/MenuScene3D.js`)
relates to the **canonical Mother** spacecraft, and records hardware that a real
serviceable Mother would need but that the current model/spec does **not** yet
include. It exists so the canonical model can be upgraded later (per the rule:
*don't invent hardware in the hero scene; if something essential is missing, note
it here instead of faking it*).

## Source of truth
- Geometry: `js/entities/PlayerSatellite.js` → `_buildModel()` and its
  sub-builders (`_buildMainBus`, `_buildCollar`, `_buildStruts`,
  `_buildThrusters`, `_buildSolarPanels`, `_buildSensors`, `_buildDockingPort`,
  `_buildNavLights`).
- Dimensions / mass: `Constants.OCTOPUS_V5` (Config G).

## What the hero scene shows (and why)
The menu builds a **standalone** model (separate WebGL context) that mirrors the
real Mother, **rolled −90° about its long axis** so that:
- the two ROSA solar wings sit at **±Y** (top/bottom), leaving the **+X** side
  clear for the EVA astronaut, and
- the forward optics (laser aperture + EO/IR/LIDAR sensor gimbal) face **+X**,
  i.e. toward the camera and the working astronaut.

Every Mother component in the hero scene maps to a real one:

| Hero scene element | Canonical source |
|---|---|
| Gold MLI barrel (2.0 m × 0.8 m) | `_buildMainBus`, `OCTOPUS_V5.CORE_LENGTH/ACROSS_FLATS` |
| Body-mount GaAs cells + MLI seams | `_buildMainBus` body cells (`BODY_MOUNT_POWER`) |
| Forward laser aperture + gold ring | `_buildMainBus` (20 cm Cassegrain) |
| EO camera / IR / LIDAR sensor gimbal | `_buildSensors` |
| Docking port + guide cone | `_buildDockingPort` |
| Collar ring | `_buildCollar`, `COLLAR_Y/COLLAR_RADIUS` |
| 4 crossbow struts (hinge, root/tip collars, rib rings, reel cartridge + LED) | `_buildStruts`, `STRUT_*` |
| Docked **Weaver** daughter on a strut tip | `ArmUnit` (`WEAVER_BODY`), deployed via struts |
| 2 ROSA wings (cells + gold edge + tip spreader/root yoke) | `_buildSolarPanels`, `ROSA_*` |
| 4 FEEP main nozzles + 8 RCS nubs | `_buildThrusters` |
| Nav lights (port/starboard) | `_buildNavLights` |

> **Note on the strut length:** the hero trims `STRUT_LEN` to 1.2 m (spec is
> `OCTOPUS_V5.STRUT_LENGTH = 1.60 m`) purely to keep the composition tidy. This
> is a framing choice, not a spec change.

## Recommended Mother upgrades (essential hardware absent from the current model)
These were briefly prototyped in the hero scene, then **removed** to keep the
menu faithful to the *current* canonical model. They are genuine spacecraft
subsystems the Mother should gain. When adding them, update **both**
`Constants.OCTOPUS_V5` and `PlayerSatellite._buildModel()`.

1. **Thermal radiators (heat rejection).**
   - Current model has no radiators; a powered bus (FEEP, avionics, laser,
     battery) must reject waste heat.
   - Suggested: body-mounted OSR/second-surface-mirror radiator panels on the
     anti-sun facets (clear of ROSA at 0°/180° and the arm planes at
     60°/120°/240°/300°). Add `OCTOPUS_V5.RADIATOR_AREA_M2` + dissipation budget.

2. **Communications antennas.**
   - Code references comms/telemetry (`_lastThrustOfflineWarning`, downlink) but
     there is **no antenna geometry**.
   - Suggested: one steerable high-gain dish (boom-mounted) + a low-gain
     omni/patch for safe-mode. Tie to the existing comms/power logic.

3. **EVA crew aids (handrails / translation path + tether attach points).**
   - The Mother is depicted being serviced by an EVA crew member, but has no
     grab rails or tether anchors. If on-orbit servicing is canon, add WIF-style
     handrails along a translation path near the optics bench + collar.

4. **Robotic grapple / berthing fixture.**
   - For capture, berthing, or robotic servicing the Mother needs a standard
     grapple fixture (FRGF-class) near the CoM/collar. Currently absent.

5. **Star tracker(s).**
   - Attitude determination implies star trackers; the model only has the
     EO/IR/LIDAR target-tracking gimbal. Consider adding 1–2 dedicated star
     tracker heads with sun-shades on a shaded facet.

If/when these are added to `PlayerSatellite`, re-introduce them to
`MenuScene3D.buildSatellite()` so the hero scene stays a faithful mirror.
