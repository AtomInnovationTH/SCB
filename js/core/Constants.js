/**
 * Constants.js — All game tuning knobs and physical constants
 * @module core/Constants
 */

// W1 net-reach — ONE "close enough to net" number. NET_LOCK_RANGE_M (reticle
// "in range", autolock, the OUT OF RANGE state) and LASSO_RANGE (the lasso's
// fire gate) are both this value, so the reticle can never say "in range" for a
// cast that is refused, nor the reverse. Hoisted above the literal because
// LASSO_RANGE appears before NET_LOCK_RANGE_M in it.
const NET_REACH_M = 90;

export const Constants = {
  // === VERSION ===
  // Single source of truth for the displayed app version. VERSION is the raw
  // value; VERSION_LABEL is the exact string the UI renders (menu title tag,
  // and any other ES-module UI). NON-module consumers (e.g. sw.js cache name)
  // must be updated by hand — keep them in sync here.
  VERSION: '1.01',
  VERSION_LABEL: 'V1.01',

  // Cache-busting stamp for ./data/ reads (js/core/dataUrl.js appends it as
  // ?v=<DATA_VERSION>). Deliberately SEPARATE from VERSION: a curated-content
  // edit must invalidate cached JSON without moving the user-visible release
  // number. Bump this on every ./data/ content change; leave VERSION for
  // actual releases.
  // '1003'→'1004': P2 thermal-arc codex batch (20 entries, single-stamp rule —
  // later phases add ZERO codex stamps; P1 ledger §9).
  // '1004'→'1005': Wave-4 pane-help PLAYBOOK batch (9 pane_* entries,
  // docs/ladder/08-workbench.md §11).
  // '1005'→'1006': Wave-5 (2) REFIT pane PLAYBOOK entry (pane_refit + the two
  // symmetric PLAYBOOK backlinks, docs/ladder/08-workbench.md §2).
  // '1006'→'1007': Wave-5 (Session B) TECH LIBRARY pane PLAYBOOK entry
  // (pane_library + the two symmetric backlinks, docs/ladder/08-workbench.md §2).
  // '1007'→'1008': Wave-5 (Session C) callout-bridge review — two hardwareNames
  // moves (STRUT HINGES → vacuum_mechanisms, S-BAND OMNI (AFT) →
  // frequency_bands; no entries added or removed, docs/ladder/08-workbench.md §2).
  // '1008'→'1009': Wave-5 (Session D) bridge lines — one `hardwareNote`
  // sentence on each of the 24 hardware entries (the part and what it does on
  // THIS ship, then the concept; no entries added or removed, 08-workbench §2).
  // '1009'→'1010': Wave-5 (Session D) structure briefings — five entries for
  // the briefing-less callout parts (aft_thruster_deck, fore_bulkhead,
  // sensor_deck, nav_lights, tip_hardpoints; owner decision 1) + their
  // symmetric backlinks; 215 → 220 entries (08-workbench §2 / §7).
  // '1010'→'1011': Wave-5 (Session L) cluster / band data pass — seven cluster_*
  // + five band_* briefings for the floor-4 SPECS subject; 220 → 232 entries.
  // '1011'→'1012': Mother audit — docking_berthing.hardwareNames gains the
  // DOCKING COLLAR card (the T1 nose-collar card, renamed; owner 2026-09-08);
  // no entries added or removed (232).
  // '1012'→'1013': Design 7b radiator launch fold — space_radiator.fullText
  // and vacuum_mechanisms.fullText gain the fold-in-two / launch-lock
  // sentences (GEO-comsat pattern; owner 2026-09-08); no entries added or
  // removed (232).
  // '1013'→'1014': Session U ONE workbench pane — pane_library retitled "The
  // SPECS Pane" (the click verb: portrait + the clicked name + summary, the F1
  // REFIT block inside it, the gold count, MAXIMIZE, Esc) and pane_refit
  // rewritten as the REFIT block inside SPECS at the ship close-up (Space, BUY
  // one click, hover-ghost, chips); no left/right-pane language; no entries
  // added or removed (232). Plan 1788954873769 A1.5.
  // '1014'→'1015': F1 workbench Lane D — the capture_collar hardware entry
  // (the debris-capture nose collar briefing; DOCKING COLLAR retargeted off
  // docking_berthing, which keeps DAUGHTER BERTHS; CARGO deep-links it too);
  // 232 → 233 entries. Plan 1789561832042, 2026-09-23.
  // '1015'→'1016': F1 follow-up Lane H — DAUGHTER STRUTS appended to
  // docking_berthing.hardwareNames (the daughter cradle struts callout card);
  // no entries added or removed (233). DECISIONS §13 r4, 2026-09-24.
  DATA_VERSION: '1016',

  // ============================================================================
  // === INPUT (Delegation 1, 2026-05-31) ===
  // Hotkey-handler tuning knobs.  Add new flags here when InputManager grows
  // additional feature gates.  Keep values intentionally minimal — UI key
  // labels live in their respective UI modules, not in Constants.
  // ============================================================================
  INPUT: {
    /**
     * Drop bare-`I` keydowns to defeat macOS Voice Control / dictation ASR
     * phantom keystrokes from in-game audio.  Default OFF since the bare-I
     * Inspection rebind landed (Delegation 1, 2026-05-31).  Toggle to `true`
     * if ASR regressions reappear (e.g. on certain mic/voice-control configs).
     */
    SUPPRESS_BARE_I: false,
  },

  // === SCENE SCALE ===
  // 1 unit = 100 km. Requires logarithmicDepthBuffer: true.
  SCENE_SCALE: 0.01,
  // ms — settle window after COMMS_PANEL_RESIZED during which cached panel
  // geometry is recomputed each frame. Slightly longer than the CSS height
  // transition (0.3s in CommsPanel.js) so listeners don't snap mid-animation.
  COMMS_RESIZE_SETTLE_MS: 340,
  EARTH_RADIUS: 63.71,            // 6371 km × 0.01
  EARTH_RADIUS_KM: 6371,
  // Metres → scene units: the ONE authoritative copy (CAPTURE_NET.md §11.7
  // hoist, 2026-08-27). Derivation: 1 scene unit = 100 km = 1e5 m ⇒ 1 m =
  // 1e-5 scene units; equivalently SCENE_SCALE (0.01 scene units per km)
  // ÷ 1000 m/km — 0.01/1000 === 0.00001 is exact in IEEE-754 (pinned in
  // test-CaptureNet-Bookkeeping.js). Consumed by ArmUnit.js (module `M`)
  // and every CaptureNet.js per-method `M_NET` local — both previously
  // re-declared the bare 0.00001 literal ("drift risk if scene scale ever
  // changes", §11.7). Other modules still carry historical `const M =
  // 0.00001` mirrors; point new code at this constant instead.
  SCENE_UNITS_PER_METER: 0.00001,

  // === PHYSICAL CONSTANTS ===
  MU_EARTH: 398600.4418,          // km³/s² — gravitational parameter
  J2: 1.08263e-3,                 // Earth oblateness coefficient
  G0: 9.80665,                    // m/s² — standard gravity
  SOLAR_FLUX: 1361,               // W/m² at 1 AU

  // === ORBITAL ALTITUDES (scene units = km × SCENE_SCALE) ===
  VLEO_MIN: 2.0,                  // 200 km × 0.01
  LEO_MAX: 20.0,                  // 2000 km × 0.01

  // === STARTING ORBIT ===
  START_ALTITUDE: 3.5,            // 350 km × 0.01
  START_ALTITUDE_KM: 350,

  // === MOTHER DRAG: HER MASS AND HER AREA (M1 welcome-drift fix 2026-09-09; live since Nets step 3 slice 2a, 2026-10-22) ===
  // The mother's atmospheric drag is OrbitalMechanics.atmosphericDrag(alt, v, area, mass). Her area and mass are LIVE now:
  //   • mass   = PlayerSatellite.mass, the ArmManager mass budget (gas burnt, nets fired, daughters out, catches aboard);
  //   • area   = PlayerSatellite.dragAreaM2(), MotherDragArea.js: her projected area across her velocity, from her real
  //              attitude, radiator angle and wing turn, by the CORE_AREA_M2 table below (the old bare 20 m2 was a guess:
  //              the real nose-first area is 3.2 m2 with the wings edge-on and 5.9 m2 with them facing forward).
  // The welcome cluster (DebrisField.dragDecelFor) must still SHARE her coefficient each frame, or it drifts away
  // (M1: spawned co-orbital at 350 km, the pieces' own A/m 1-17x smaller than hers, they stayed higher and, lower orbit =
  // faster, she pulled ahead: > 2 km in ~4 real minutes with no key pressed). Each frame the welcome pieces use the area
  // and mass her drag block USED that frame (PlayerSatellite.lastDragAreaM2 / lastDragMassKg, handed over by
  // DebrisField.setMotherDragSource): same coefficient => same per-frame SMA step => lock-step decay. With no source or
  // no frame yet they use her REFERENCE coefficient: MotherDragArea.referenceDragAreaM2() (nose-first, radiators 146 deg,
  // wings tracking the sun) over MASS_KG.
  //
  // MASS_KG = 294.28 kg: her START mass with both radiator pairs fitted (the game fits them at boot:
  // FLOWER_PREINSTALLED, main.js applyUpgrade flowerPairA/B). Measured 2026-10-22 on the full rig of test-LiveMass.js (a
  // real ArmManager + ResourceSystem + CaptureNetSystem, both pairs applied): ArmManager.getMassBudget().shipMassKg =
  // core dry 255.10 (incl. 51.6 kg of radiators) + cold gas 3.6 + docked daughters 17.4 + argon 12.5 + 4 nets 5.7.
  // History: 130 (a guess) -> 242.68 (slice 1, radiator pairs left out) -> 294.28. test-LiveMass.js keeps it within
  // 0.05 kg of that budget. It is the START mass: the fallback of PlayerSatellite.mass (no arm manager) and the mass
  // the reference drag is taken at.
  //
  // CORE_AREA_M2 = her projected area across each body axis, the ship WITHOUT the two ROSA blankets (booms, rolls,
  // daughters as built stay), wings at 0 deg, by radiator angle. Columns: radiator angle (deg), across X, across Y, across Z
  // (m2; Z is nose-first). Measured 2026-10-22 from the built meshes, union of the visible non-FX triangles on a 1 cm
  // grid (js/test/_projectedArea.js; tmp/step3/core-table.mjs): the same at 0.5 cm and 0.25 cm differs by <= 0.015 m2,
  // at 2 cm by <= 0.04 on X, 0.14 on Y (thin rods), 0.044 on Z. test-MotherDragArea.js re-measures every cell and
  // fails if the ship changed (a row moves by more than 5 % or 0.05 m2): re-run that probe and paste the table.
  // The model off the axes is in MotherDragArea.js (p-norm 1.5 + two flat wing plates; max 38 %, median 5.5 % against
  // the meshes on 360 poses).
  MOTHER_DRAG: {
    MASS_KG: 294.28,
    CORE_AREA_M2: [
      [0, 2.22, 2.59, 1.11],
      [30, 2.86, 3.14, 2.17],
      [60, 2.62, 2.94, 2.89],
      [90, 2.23, 2.57, 4.86],
      [120, 2.88, 3.14, 4.38],
      [146, 3.34, 3.53, 3.24],
      [180, 3.55, 3.73, 1.11],
    ],
  },

  // === DRAG CEILING (Nets step 3 slice 1, 2026-10-21) ===
  // Altitude above which atmosphericDrag is not applied (km). 1000 km is the
  // top of the published air table (OrbitalMechanics.atmosphericDensity, 0
  // above it). Read by the mother (PlayerSatellite.update) and the debris loop
  // (DebrisField.update); both used a bare 600 before.
  DRAG_CEILING_KM: 1000,

  // === RENDERING ===
  FLOATING_ORIGIN_ENABLED: true,    // UX-4: Camera-relative instanced mesh positions to avoid float32 jitter

  // Project-wide render order (FIX_PLAN §2; bands extended §2-followup round 4).
  //
  // renderOrder is a GLOBAL sort key across ALL scene objects, not per-object.
  // Mother (PlayerSatellite) and daughter (ArmUnit) are SEPARATE top-level scene
  // objects, so a shared scale makes their meshes tie at the dock seam (both at
  // DETAIL) and resolve by ambiguous depth. The bands below give each layer a
  // distinct slot and add a small DAUGHTER_BIAS so a docked daughter resolves
  // cleanly against the mother's strut tip instead of z-fighting it.
  //
  // NOTE: the renderer uses logarithmicDepthBuffer (SceneManager.js), under which
  // polygonOffset units are non-linear and only separate coplanar faces at one
  // viewing distance. Prefer renderOrder + a tiny geometric Z stagger over
  // polygonOffset for deterministic layering.
  RENDER_ORDER: {
    EARTH: 0,
    SPACECRAFT_OPAQUE: 1,
    SPACECRAFT_DETAIL: 2,    // channels, pockets, accent rings
    SPACECRAFT_TRANSPARENT: 3, // grid overlays, wireframes
    SPACECRAFT_ADDITIVE: 4,   // glow rings, plumes (drawn after solid geometry)
    // Connectors span mother↔daughter; draw just above solid geometry so they
    // sit on the hull they bridge without z-fighting either craft.
    SPACECRAFT_CONNECTOR: 5,  // tethers, bridle legs, net tether
    // Bias added to a docked daughter's meshes (group-level) so the whole craft
    // resolves in front of the strut-tip collar it overlaps. Small enough not to
    // cross into the connector/additive bands.
    DAUGHTER_BIAS: 0.5,
    HUD: 10,
  },

  // === DETAIL LOD CULL (Epic — visual-audit Phase 6) ===
  // Distance-hysteresis switch for the Mother's + daughters' mm-scale INERT
  // hardware (pins, clips, rib rings, seams, accent rings, bolts, bushings, FEEP
  // liners/grid discs/bosses, spring coils, guide rails, cable lines; daughter
  // EPM rings/hardpoints/gimbals/panel-lines). Beyond ~40 m these are sub-pixel
  // yet still cost a draw call + vertex work every frame. main.js feeds the live
  // camera→craft distance (scene units) to player/armManager.setCameraDistance();
  // the flip happens only when a threshold is CROSSED (state change, not per
  // frame). Hysteresis (hide>40, show<30) prevents flip-flop at the boundary.
  // Gameplay-communicative meshes (nav/strobe/dock lights, daughter status
  // lights, reel LEDs, plumes, tethers) are NEVER in the cull set — they carry
  // state at distance. Values in METRES (multiplied by M at the call site).
  // View configs (CameraSystem): CHASE ≈16.5 m, ARM_PILOT ≈5 m keep full detail;
  // OVERVIEW zoomed out drops it.
  DETAIL_CULL: { HIDE_M: 40, SHOW_M: 30 },

  // === LIGHT FX SIZES (z-layer-and-lights-fix Batch 1) ===
  // Single tunable block for nav/dock/status light core + halo sizes and steady
  // opacities. User feedback: the prior lights were TOO BIG — this shrinks them.
  // ALL sizes are in METRES; call sites multiply by M (1 m = 1e-5 scene units).
  // Halo values feed makeLightHalo(scaleM) — pass as `M * LIGHT_FX.<HALO>`.
  // Keep this the ONLY place these sizes live so iteration is a one-line edit.
  // STROBE_HDR is the near-white flash peak multiplier — only that peak crosses
  // the sim bloom threshold (2.5) to pop; do not drop below ~2.6 or the sim
  // strobe stops blooming (menu bloom threshold is ~1.0 — see MenuScene3D).
  LIGHT_FX: {
    NAV_CORE_R: 0.025,        // m — port/starboard/strobe core sphere radius (was 0.04)
    NAV_HALO: 0.14,           // m — nav halo sprite size (was 0.30)
    NAV_HALO_OPACITY: 0.40,   // steady port/starboard halo opacity (was 0.65)
    STROBE_HALO: 0.17,        // m — strobe halo sprite size (was 0.345 = 0.30×1.15)
    STROBE_HDR: 3.5,          // strobe flash-peak HDR multiplier (keep ≥ ~2.6)
    STATUS_HALO: 0.05,        // m — daughter status-light halo size (was 0.11)
    STATUS_HALO_OPACITY: 0.6, // daughter status-light halo opacity (was 0.85)
  },

  // === CAMERA ===
  CAMERA_NEAR: 0.00003,           // ~3 m minimum (lowered from 10m to prevent panel clipping at close zoom)
  CAMERA_FAR: 500,                // ~50,000 km maximum
  CAMERA_FOV: 55,                 // COMMAND/TACTICAL base FOV (ST-5.3: 65→55°)
  CAMERA_FOV_ARM_PILOT: 40,      // ARM_PILOT narrow FOV

  // === INSPECTION (diagnostic treatment, 2026-06-03) ===
  // Light visual treatment when the INSPECT view is active: a vignette that
  // dims the surroundings so the inspected craft reads clearly, plus an
  // optional edge-outline on the mothership hull. NOT a full scene wireframe —
  // the callouts live in the in-world ui/MotherCallouts.js overlay.
  //
  // 2026-07 (round 6): the vignette is now drawn IN-ENGINE, in the seam between
  // the far and near render passes (NearFieldRenderPass), so DIM darkens ONLY the
  // background (Earth/stars/debris) — never the ship or the callout cards. It was
  // a DOM overlay painted over the whole canvas, which unevenly dimmed the rails.
  INSPECTION: {
    DIM: 0.6,                     // background vignette peak (corner) darkness (0 = off, 1 = black)
    HULL_OUTLINE: true,           // toggle the mothership hull edge-outline
    HULL_OUTLINE_COLOR: 0x00ffcc, // cyan diagnostic tint
    HULL_OUTLINE_THRESHOLD_DEG: 20, // EdgesGeometry thresholdAngle (deg)
  },

  // === INSPECT CALLOUTS (side-rail label overhaul, 2026-07-25) ===
  // Config for the in-world inspection callouts (ui/MotherCallouts.js): system
  // identity hues, risk badge colours, screen-space side-rail layout params, and
  // per-tier on-screen label sizes. Kept here (not hardcoded in MotherCallouts)
  // so the look is tunable in one place.
  CALLOUTS: {
    // Blueprint / engineering-HUD accent family (round 4). One hue family,
    // mono type, corner brackets, hairline leaders.
    ACCENT:      '#7fd4e8',
    ACCENT_DIM:  '#3d6e7e',
    // Text ink for card titles + data rows (round 4 blueprint). Single source
    // so the card generator and any caller-side override can't drift.
    INK:         '#dfeef5',
    INK_DIM:     '#9fb8c4',
    // Hue = system identity (6 groups). Risk is shown as a small badge dot on
    // the card, NOT by label colour (the old scheme read all-green).
    // Round 4: re-valued to low-saturation tints within ~±20° of cyan so the
    // whole callout layer reads as one blueprint family.
    SYSTEM_HUES: {
      POWER:      '#9adfd2', // pale teal
      PROPULSION: '#8fb8e8', // steel blue
      PAYLOAD:    '#a8c8e0', // light slate
      SENSORS:    '#7fd4e8', // accent cyan
      COMMS:      '#74c4e6', // sky cyan
      CAPTURE:    '#8fdcc4', // seafoam
      THERMAL:    '#a3d9c9', // mint teal — P2 aft flower family (P1 ledger §7:
                             // EVERY family needs a hue row HERE or it renders
                             // fallback-hued and the miss is invisible in tests)
    },
    // Risk badge dot colours reuse the shared wireframe palette.
    RISK_COLORS: {
      GREEN:  '#3fb950',
      YELLOW: '#d29922',
      RED:    '#f85149',
    },

    // --- Side-rail layout (all NDC unless noted) ---
    RAIL_INSET_NDC:    0.16,  // rail X offset outward from the ship's screen bound
    RAIL_MARGIN_NDC:   0.06,  // keep rails at least this far inside the viewport edge
    RAIL_GAP_NDC:      0.03,  // vertical PADDING between stacked cards (min gap)
    SIDE_HYSTERESIS:   0.12,  // |ΔNDC.x| past centre before a label flips rail side
                              // wide-ish — flips should be rare; the 1.5 s dwell
                              // + fade-swap hide the rest (round 4)
    ORDER_HYSTERESIS:  0.04,  // anchor-Y separation before two labels swap stack order
    EASE_RATE:         12.0,  // screen-space position ease rate (k = 1 − exp(−rate·dt))
    OFFSCREEN_NDC:     1.1,   // hide callouts whose anchor projects beyond ±this
    ELBOW_STUB_NDC:    0.05,  // horizontal leader stub length off the card edge
    DETAIL_REVEAL_NDC: 0.25,  // T6: detail parts within this NDC radius of the
                              // focused part reveal even across systems
    FREE_STANDING_R_M: 0.6,   // Mother fixes 4/4 (c): a bound flowerGated row whose
                              // live anchor is beyond this ship-frame radius (m) rides a
                              // deployed strut clear of every hull-mounted part (hull
                              // 0.40, tracker mouths / RCS bells ≤ 0.52) — the facing
                              // gate's hull-normal proxy is skipped for it

    // --- On-screen label heights, as a fraction of viewport height (NDC-ish) ---
    // Each value is the on-screen height of the card's TITLE BLOCK (the 0-row
    // height, 106 logical px); total card height = this × card.heightFactor.
    // Sized MANUALLY from distWorld × tan(fov/2) in MotherCallouts._positionCard
    // (NOT sizeAttenuation:false — that attenuation branch is skipped, see
    // three/src/objects/Sprite.js:144). Card aspect scales the width, and
    // aspect × heightFactor = CARD_W_OVER_TITLE_H ≈ 6.04 for every card (R15;
    // card canvas widened 512→640 in round-3 T4 for plain-English titles).
    // Texture budget (R14/T4): ~46 MB resident (33 compact + 1 focused card) —
    // hover is a material-level effect, not a per-rec texture variant.
    SIZE_SYSTEM:  0.052,  // Band-1 system group labels
    SIZE_MAJOR:   0.040,  // major part cards
    SIZE_DETAIL:  0.030,  // detail-tier cards (COMPONENT band only)
    SIZE_CARD:    0.046,  // focused COMPONENT card (~15% larger than major: 0.040 × 1.15)
    DOT_SIZE:     0.016,  // anchor dot on-screen size (round 5: 0.012 → 0.016 —
                          // bracket ticks were sub-pixel over bright hull)

    LIVE_REFRESH_HZ: 2,   // max focused-card live-data refresh rate
    SHIP_BOUND_M:   1.5,  // approx ship silhouette radius (wings) in metres for rail X
    // Round 6 (binary legibility): a shown card's target opacity is floored here
    // so a card is always clearly readable, never a muddy translucent ghost.
    // Declutter is done by HIDING (target → 0), not by fading toward invisible.
    // The band crossfade still eases through lower values in-flight; this floors
    // only the TARGET. Kept in lockstep with the _pickBestRec pick gate.
    MIN_CARD_OP:    0.5,
    // §13 r3 (2026-09-24): after the pointer leaves a system (hover gone and
    // nothing new hovered/pinned), that system stays "open" this long before
    // its part labels fold back — the fold reads deliberate, not flickery.
    OPEN_LINGER_MS: 1000,
  },

  // === RESOURCE DEFAULTS ===
  XENON_FUEL_MAX: 100,            // POOL UNITS, not kg (h3-argon-engine): 100 = one full 60 L base engine tank of
                                   // whichever gas is loaded (FUELS[gas].kgFull kg). Name kept; rename is later cleanup.
  ENGINE_TANK_DRY_MASS_KG: 9.5,   // h3-argon-engine D3: the 60 L, 200 bar Ti/COPV tank itself (research §2.2 fit; the
                                   // 263 kg F2 dry figure did not count it). Carried as dry mass in getMassBudget().
  ENGINE_TANK_VOLUME_L: 60,       // h3-argon-engine: base engine tank volume (documentation; kgFull is derived from it)
  COLD_GAS_MAX: 20,               // tank units, NOT kg: 20 units = 6 kg of nitrogen (0.3 kg a unit; the start fill of 12 units = the 3.6 kg in the mass budget)
  COLD_GAS_LOW_FRAC: 0.25,        // gas-low-fail-fast D4: "steering gas low" — a fraction of COLD_GAS_MAX (coldGas / coldGasMax); the HUD
                                   // gas meter turns amber below the same fraction (VitalsPane reads this), the comms line is sent once on crossing it
  COLD_GAS_LOW_REARM_FRAC: 0.35,  // ...and re-arms only after the tank is back above this fraction (a refill), so a tank hovering at a quarter says it once
  BATTERY_MAX: 600,               // Wh — the ship's own spec (OCTOPUS_CORE_BATTERY /
                                   // OCTOPUS_V5.CORE_BATTERY, both 600; equality pinned in
                                   // test-shop-effects). Was a 100 Wh 'simplified' placeholder
                                   // while the battery recharged from a bugged 8,166 W rate.
  BATTERY_START_FRACTION: 0.5,    // w4-power D1 (owner 2026-10-12: "battery is 50% and dropping
                                   // until wings open"): every boot — new game, retry, loaded save —
                                   // starts at this fraction of the (rebased) max; saves carry no charge.
  PROPELLANT_START_FRACTION: 0.6, // h1-mother-pane D5 (owner 2026-10-14: "they start with the cheapest for
                                   // modern satellites.. and only 60% full"): the engine tank AND the cold-gas
                                   // tank start at this fraction of their max on every boot (new game, retry,
                                   // loaded save), the same paths as BATTERY_START_FRACTION.

  // g1-gas-upgrades D1 (owner 2026-10-14: "every kg is expensive to send up on rockets"; DECISIONS §2b): engine gas
  // is priced by what it costs to launch. Price per kg = (LAUNCH_USD_PER_KG + FUELS[gas].usdPerKg) / USD_PER_CREDIT.
  LAUNCH_USD_PER_KG: 7000,        // research §3: about the same whatever the gas
  USD_PER_CREDIT: 100,            // anchor: the old extra-tank row, 600 cr for +10.4 kg argon, about $121 per credit; rounded
  GAS_RESUPPLY_KG: 5,             // one "Engine Gas Resupply" load, kg
  // t1-stranded D2: both tanks empty AND the credits (plus what the cargo would sell for) cannot buy one resupply AND
  // nothing that could still pay is under way (a daughter out, a catch held, a net or lasso in flight) -> the
  // mission ends after this many seconds of running gameplay (GameFlowManager.update; a held world counts nothing).
  STRANDED_GRACE_S: 15,

  // === SHIP HEAT (w2-heat, 2026-10-08) =======================================
  // DECISIONS §15 rows 2/4/5/6 + §2 rows 5–7: the ship heats up from what the
  // player does, warns at 60 / 85 °C, and opens its radiator itself a little
  // late. ONE lump (js/systems/ThermalSystem.js):
  //   C dT/dt = P_in − P_out
  //   P_in  = every watt drawn from the battery (the ResourceSystem ledger —
  //           every drawn watt ends as heat) + SUN_HULL_W in daylight (0 in shadow)
  //   P_out = σ ε A_eff (T⁴ − SINK_K⁴),
  //   A_eff = HULL_AREA_M2 + RAD_AREA_M2 × (G_CLOSED + (1 − G_CLOSED) × openFrac) × flow
  //   flow  = the coolant loop (L4 radiator-loop, owner 2026-10-20): 0 at or below LOOP_OFF_C, 1 at or above
  //           LOOP_FULL_C, linear between — an open radiator sheds heat only while the coolant flows
  // The lump is NOT the whole 130 kg ship (≈ 117 kJ/K): it is the electronics
  // bay and the heat-pipe saddle that feeds the radiator — the mass that warms
  // first. The load table is taken AS GIVEN (base 500 W, ion 5 kW, autopilot
  // ≈ 5.6 kW at full command at any frame rate (until 2026-10-18 it grew with the frame time: 5.6 kW at
  // 60 fps, up to 25 kW at 10 fps)); its scale is a logged
  // follow-up, not tuned here. Tuning targets T1–T6 (DECISIONS §15 row 6) are
  // pinned in js/test/test-ShipHeat.js — see docs/ladder/01-numbers.md "Ship
  // heat and scan cost".
  SHIP_HEAT: {
    // ── The clock (the battery's own — do NOT retune) ──
    // ResourceSystem.update adds solarRate(W) × dt × 0.001 per REAL second and
    // a battery unit is 1 Wh = 3,600 J, so a watt moves 3.6 J per real second:
    // the battery integrates at 3.6× real time. Heat runs on the SAME clock, so
    // a watt means the same thing on the battery meter and the heat meter.
    UNIT_J: 3600,               // J per battery unit (1 Wh)
    W_PER_UNIT_S: 1000,         // HUD watts per battery unit drawn per real second (÷ 0.001)

    // ── The lump (each a physical reading; tuned to §15 row 6 by the probe) ──
    // Measured (test-ShipHeat.js "D6 targets", rest 146° and 0° alike): idle
    // daylight closed eq 35.1 °C (shadow 24.2); scripted M1 closed first warns
    // at 152 s (peak 62.4); auto-open at 70 → < 55 °C in ~21 s; M1 opened at
    // start peaks 36 °C; 3 wide scans held closed peak 93 °C.
    // v12-radiator-20 (owner 2026-10-16, "20 cm, please"): radiators 20 cm shorter, so RAD_AREA_M2 8.12 → 7.20 (real geometry, 4 × 1.50 × 0.60 × 2)
    // and the two guessed inputs nudged the least that keeps the behaviour above: SINK_K 220 → 205 (−7 %), SUN_HULL_W 120 → 110 (−8 %)
    // (all 54 test-ShipHeat tests, targets unedited; idle eq 35.2 °C vs 35.1). Sweep: tmp/probes/rs-sweep.mjs (SINK_K 190–220 × SUN_HULL_W 40–120);
    // 01-numbers.md "Ship heat, power and scan cost". (The 25 cm step, 6.96 m², had needed SINK_K 195 and the heater cap 950 W; superseded.)
    HEAT_CAPACITY_J_PER_K: 16000, // ≈ 18 kg of aluminium (900 J/kg·K): avionics boxes + bay + saddle
    EMISSIVITY: 0.85,           // white paint / OSR radiator faces (typical 0.8–0.9)
    SINK_K: 205,                // tuned (est; 220 before the 20 cm radiator step): Earth IR alone on a plate seeing ~⅓ Earth (237 W/m²)
                                // gives ≈ 193 K; daylight albedo and the warm hull in view raise it
    HULL_AREA_M2: 0.3,          // tuned (est): MLI hull leak as ε 0.85-equivalent area (~6 m² × ε* 0.03 / 0.85 + body cells' share)
    RAD_AREA_M2: 7.20,          // 4 plates × 1.50 × 0.60 m (3.60 m² rectangle; the built meshes give 3.582 — the wings end 15 mm short) × 2 faces at full bloom (was 8.12 at 1.70 m; test-RadiatorShort pins it to the geometry)
    G_CLOSED: 0.20,             // folded flat (§15 row 4) each pack shows one 0.32 m face outward (~¼ of
                                // the two-sided area), partly hidden by the barrel and wings → ~0.2
    SUN_HULL_W: 110,            // tuned (est; was 120 before the 20 cm radiator step): daylight sun reaching the bay — body cells' waste heat share + MLI leak (0 in shadow)
    // ── The coolant loop (L4 radiator-loop, owner 2026-10-20: "radiators can be open without transferring heat; a
    //    radiator can be on a running engine without cooling the engine") ──
    // A thermostat valve the ship runs by itself (no player control, no pump draw yet): flow = 0 below LOOP_OFF_C, 1
    // above LOOP_FULL_C, linear between. Real pumped loops hold the electronics near room temperature (typical
    // allowable bus-electronics range ≈ 0–40 °C; an estimate, not a measured spec), so the valve works at 20–30 °C.
    // With flow 0 the radiators — folded or open — shed nothing and only the bare hull leaks (no leak term through a dry
    // radiator). The heaters (HEATER.HOLD_C 0 °C) sit 20 K below the valve: the two never overlap. Idle daylight closed
    // equilibrium (35.2 °C) is above LOOP_FULL_C, so it, the 60 / 70 / 85 °C lines and the first scan are unchanged.
    LOOP_OFF_C: 20,             // °C — coolant fully stopped at or below this
    LOOP_FULL_C: 30,            // °C — coolant fully flowing at or above this
    START_LOAD_W: 500,          // the base load (PlayerSatellite._basePowerDraw 0.5/s × W_PER_UNIT_S): a new
                                // game starts at the closed daylight equilibrium for it — the needle
                                // does not move until the player does something (§2 row 6)

    // ── Bands and lines (§15 row 5, §2 row 5 — a ladder, never a cliff) ──
    YELLOW_C: 60,               // "Ship warming up" — economic pain starts here (later rounds)
    RED_C: 85,                  // "Ship hot" — tools refuse here (later rounds; no refusals yet)
    REARM_C: 5,                 // a line re-arms this far below its threshold (once per crossing)
    TREND_TAU_S: 2,             // real s — smoothing of dT/dt for the trend arrow
    TREND_C_PER_S: 0.02,        // °C per real second (1.2 °C/min) — slower reads as steady

    // ── Auto radiator (§15 row 4: opens itself "a little late", to OPEN_DEG 146°; it stays open — no auto-close, owner 2026-10-09) ──
    AUTO_OPEN_C: 70,            // opens at 70 °C — 10 °C past the warning, on purpose
    PLAYER_WINS_S: 30,          // a player radiator command in the last 30 s blocks the auto
    AT_REST_FRAC: 0.05,         // openFrac at or below this counts as "at rest" (folded)

    // ── Power ledger smoothing (ResourceSystem.getPowerSnapshot) ──
    POWER_TAU_S: 0.5,           // real s — in/out watts are smoothed over ~0.5 s
  },

  // === HEATERS (w4-power D7, 2026-10-12 — the "what else" in the owner's list) ===
  // Lithium cells must not get cold. Below HOLD_C the battery heaters draw the
  // power that holds HOLD_C: what the lump radiates now, minus every other heat
  // input, plus a pull toward HOLD_C (C/PULL_S W per K) — continuous, so it
  // fades out within ~1 K above HOLD_C instead of switching (ThermalSystem
  // _updateHeater). Billed through the battery like a motor, so its heat is
  // what warms the ship. No auto-close (owner ruling 2026-10-09). Since L4
  // radiator-loop (2026-10-20) the coolant stops at SHIP_HEAT.LOOP_OFF_C (20 °C),
  // so an open radiator no longer drags the ship down to the heaters; the comms
  // line just says the heaters are keeping the cells above freezing.
  HEATER: {
    ENABLED: true,              // the one-line veto
    HOLD_C: 0,                  // °C — lithium-ion charge floor (cells must stay above freezing)
    // Measured from the model (SHIP_HEAT constants, w4-power probe): radiator
    // at 180° (openFrac 1, A_eff 7.50 m²), eclipse (no SUN_HULL_W), base load
    // 500 W: σ·ε·A_eff·(273.15⁴ − 205⁴) − 500 W = 873.9 W at 7.20 m² radiators
    // → rounded up to 880 W. test-PowerCosts recomputes it. L4 radiator-loop: sized
    // with the coolant forced to flow 1 (the worst case, the valve stuck open) — in
    // normal running the coolant is off at 0 °C and the heaters need only the hull
    // leak (≈ 55 W at 0 °C), so the cap is far above any real need (a follow-up).
    // (v12-radiator-20: was 810 W at 8.12 m² and SINK_K 220; the 25 cm step had 950 W at SINK_K 195.)
    MAX_W: 880,
    PULL_S: 20,                 // battery-clock s — how hard the hold pulls back to HOLD_C
    LINE_AFTER_S: 10,           // game s of heater running before the comms line
    LINE_EVERY_S: 300,          // at most one heater line per 5 min of game time
  },

  // === MOTOR DRAW (w4-power D5, 2026-10-12 — owner: "adjusting wings and
  // open/closing costs battery and thermals … 8 motors on strut cost energy
  // and thermals. Reel on mother costs") ======================================
  // The ONE table of what each motor draws while it moves. Billed in that
  // motor's per-frame motion step, only on frames it actually moves, through
  // ResourceSystem.billWatts (W ÷ SHIP_HEAT.W_PER_UNIT_S × dt battery units —
  // the base load's own conversion), so a 15 W motor shows +15 W on the meter
  // and its heat follows through the ledger. Held frames bill nothing. Sized
  // physically (Ruling 0) — never inflated for feel. Sources: NASA Small
  // Spacecraft State of the Art 2026, ch. 6 Table 6-5 "Commercial Actuator
  // Mechanisms" (https://www.nasa.gov/smallsat-institute/sst-soa/structures-materials-and-mechanisms/).
  MOTOR_DRAW_W: {
    STRUT_HINGE: 15,            // ×4 strut hinge motor boxes (StrutMotorBox_) — a geared rotary drive
                                // swinging a strut + daughter: Moog Type 2 SADM 15 W (Table 6-5)
    WING_DRUM: 13,              // ×2 wing roll-out drums — geared motor: Comat SADM-1500 13 W (Table 6-5)
    WING_DRIVE: 5,              // ×2 wing tilt / sun-tracking drives — DHV SADA-M 5 W nominal (Table 6-5)
    RADIATOR_HINGE: 4,          // ×4 radiator hinge drives (one per strut, they swing in unison) —
                                // Comat SADM-400 4 W geared motor (Table 6-5)
    CROSSBOW_RELOAD: 15,        // daughter spring-reload worm gear — the game's own CROSSBOW_RELOAD_POWER
    // Reels bill the real mechanical power, line tension × line speed ÷ REEL_EFFICIENCY,
    // floored at their own 15 W motor constant while turning, capped at HAUL_MOTOR_POWER.
    STRUT_REEL_MIN: 15,         // ×4 strut reel cartridges (ReelCartridge_) = the daughter tether
                                // reel motor (15 W)
    MOTHER_REEL_MIN: 15,        // the mother's net reel and lasso reel — the game's own TETHER_REEL_POWER
    REEL_MAX: 2500,             // the game's own REEL_PROFILE.HAUL_MOTOR_POWER (it sets the cruise speed)
    REEL_EFFICIENCY: 0.5,       // estimate: geared DC motor ~0.7 × gearbox + spool ~0.7
    MOVE_MIN_DEG_S: 0.1,        // a hinge / tilt drive turning slower than this is holding, not moving
                                // (a tracker's sub-0.1°/s creep after it has caught the sun bills nothing)
  },

  SOLAR_PANEL_EFFICIENCY: 0.30,   // 30% efficient cells
  // Mother-wings step 4 (DECISIONS §10, "power follows the panels, realistic
  // wins"): was a generic, unrelated 20 m² placeholder (the ship never had 20
  // m² of cells). Now the REAL total: 2 ROSA wings (OCTOPUS_V5.ROSA_WIDTH ×
  // ROSA_LENGTH = 1×2 m² each) + the measured built body-mount cell area
  // (OCTOPUS_V5.BODY_MOUNT_AREA_M2 = 1.609 m², the 44-cell half-width re-lay).
  // Literal here (not a cross-reference — OCTOPUS_V5 is defined later in this
  // same object literal, so it can't be read yet); re-derive if either changes.
  // This is a peak/ceiling figure for readers that want "the panel area" as a
  // single number (the shop solarEfficiency upgrade, the launch-dance power
  // ramp, the ROSA glow's brightness normalisation) — the real per-frame power
  // path (_updateSolarPower) sums each wing's and each body cell's own area
  // and never uses this constant.
  SOLAR_PANEL_AREA: 2 * 1.0 * 2.0 + 1.609,   // m² — 5.609 (4 wing + 1.609 body); keep in sync with OCTOPUS_V5.BODY_MOUNT_AREA_M2 (drift-pinned in test-MotherPower)

  // === SCORING ===
  TIER1_BASE: 100,                // Data capture
  TIER2_BASE: 300,                // Deorbit
  TIER3_BASE: 500,                // Physical capture
  WIN_DEBRIS_COUNT: 60,           // 12 chapters × DEBRIS_PER_MISSION(5); ch12 = elevator-anchor finale (F2 Option A)
  // E1 despin doctrine tuning: the capture tumble bonus scales with the ABOVE-SPEC
  // spin the player tamed ((initialDeg - IN_SPEC_DEG) / SLOPE), capped at MAX_BONUS.
  // A 180°/s fragment despun to spec earns +~0.5×; gentle so despinning is a
  // meaningful reward without a fast fragment out-paying a whale.
  TUMBLE_DESPIN_SLOPE_DEG: 340,   // degrees/s of above-spec spin per +1.0 tumbleFactor
  TUMBLE_DESPIN_MAX_BONUS: 0.5,   // max tumbleFactor contribution (+50%)
  // E1 retune: per debris-tier scaling of the capture base so a tiny fragment
  // (tier 1) no longer earns the same flat base as a rocket body (tier 3).
  // (Register item 99, 2026-08-21: the tier-4 row — ×1.3 for a rocketBody
  // > 4,000 kg — was production-dead since S11(b)'s two populations (df24e3b):
  // the authored finale is 1,600 kg, the catalogue-finale substitution's
  // in-band yield is zero for all 7 language start regimes, boss frags are
  // small + flat-awarded, and Kessler frags force type fragment. Deleted by
  // owner ruling, item-98 shape; do not harmonise the row back in — a future
  // economy pass that wants it re-adds at a measured threshold deliberately.)
  DEBRIS_TIER_BASE_WEIGHT: { 1: 0.4, 2: 0.7, 3: 1.0 },
  // (Register item 98, 2026-08-21: the S1 salvaged-metal material bonus —
  // MATERIAL_BONUS_CR_PER_KG 2 cr/kg, MATERIAL_BONUS_CAP_CR 750 — was
  // PRODUCTION-DEAD from the initial commit (no award site ever passed
  // metalMassKg) and is deleted by owner ruling, item-42/101 shape; the
  // awardPoints block and the pacing-projector fixture went with it.)

  // === DEBRIS TYPES ===
  DEBRIS_TYPES: {
    FRAGMENT:       'fragment',
    ROCKET_BODY:    'rocketBody',
    DEFUNCT_SAT:    'defunctSat',
    MISSION_DEBRIS: 'missionDebris',
    CUBESAT:        'cubesat',
  },


  // === PHYSICS ===
  CATASTROPHIC_THRESHOLD: 40,     // J/g
  KESSLER_FRAGMENT_LIMIT: 50,
  LEO_AVG_COLLISION_VEL: 10,      // km/s
  LEO_MIN_ALT: 180,               // km — reentry threshold

  // === TIME ===
  TIME_SCALE_GAMEPLAY: 10,        // 1 real sec = 10 game sec
  ORBITAL_PERIOD_400KM: 5556,     // seconds (~92.6 min)

  // === ATMOSPHERE LAYERS (scene units, radii) ===
  CLOUD_RADIUS: 63.81,            // +10 km above surface
  ATMOSPHERE_RADIUS: 65.11,       // +140 km above surface — gives the limb-glow gradient room to fade softly (was +70 km)

  // === EARTH RENDERING (ST-5.3) ===
  EARTH: {
    CLOUD_ROTATION_RATE: 0.00007,   // rad/s — sidereal-ish, visible drift over a game hour
    LOD_16K_THRESHOLD: 16384,       // renderer.capabilities.maxTextureSize >= → 16k textures
    LOD_8K_THRESHOLD: 8192,         //                                    >= → 8k textures
    // Menu→sim handoff intro (deep-polish-4). Replaces the legacy VLEO
    // establishing shot: no dead hold, chase settles straight into formation so
    // the arrival is one continuous gesture with the menu hero's recede.
    //   INTRO_START_SCALE — chase-offset multiplier at MENU_START. Tuned (T3) so
    //     the sim ship's apparent size ≈ the receding menu hero's at the cut
    //     (match-cut, Option A). 1.0 = no zoom.
    //   INTRO_EASE_RATE   — per-second exponential ease rate back to 1.0
    //     (settle ~1.5-2 s so it overlaps the HUD power-on stagger).
    INTRO_START_SCALE: 0.30,
    INTRO_EASE_RATE: 1.35,
  },

  // === STARFIELD ===
  STAR_COUNT: 10000,
  // World-fixed shell centered on Earth (StarfieldGroup at the origin) unless
  // Starfield.setFollowCamera(true). The old note here — "must be < CAMERA_FAR
  // (500)" — encoded a FALSE invariant: for a world-fixed shell the real
  // constraint is far >= D_max + R (D = camera distance from Earth center),
  // because a star directly behind Earth sits at camera distance D + R. The
  // shipped far (500) therefore only covers D <= 100 u; the ladder's
  // Earth-anchored floors (F4 D <= 255 @ far 500, F5 D <= 1300 @ far 2000)
  // break it — far-plane clipping blacks out the F4 sky and the F5 camera
  // exits the shell entirely. Fix: follow mode (Starfield.setFollowCamera)
  // re-centers the shell on the camera each update, making stars pure
  // direction chrome at camera distance exactly R — inside every floor's far
  // plane by construction. World-fixed callers (the shipped chase ranges,
  // D ≲ 70 u) still satisfy far >= D_max + R with the shipped 500.
  STAR_SPHERE_RADIUS: 400,

  // --- Constellation stick figures (Starfield._createConstellations) ---
  // Deliberately faint: "noticeable if you look, not distracting". The earlier
  // pass (§18 Fix 3) pushed these UP to fight ACES crush, which made the lines
  // read as rocket launch trails where they were hard-clipped by the Earth
  // silhouette. The clipping — not the brightness — was the real cue, so it is
  // now solved by the LIMB_FADE_* ramp below and these can come back down.
  CONSTELLATION_LINE_COLOR: 0x7d8ba3,   // desaturated slate blue-grey (was 0x6688cc)
  CONSTELLATION_LINE_OPACITY: 0.30,     // was 0.7
  CONSTELLATION_LINE_WIDTH: 1.25,       // px — was 2.0 (no MSAA; SMAA/FXAA carries it)
  CONSTELLATION_LABEL_OPACITY: 0.28,    // was 0.34
  // Soft limb fade: constellation lines dissolve BEFORE they reach the Earth
  // limb glow instead of being hard-clipped at the silhouette by depthTest.
  // The fade band is a fraction of Earth's apparent angular radius (so it
  // behaves both in LEO, where Earth fills the frame, and in far orbit where
  // the disc is small), then clamped to absolute radians at both ends.
  CONSTELLATION_LIMB_FADE_SCALE: 0.35,
  CONSTELLATION_LIMB_FADE_MIN: 0.035,   // ~2°
  CONSTELLATION_LIMB_FADE_MAX: 0.35,    // ~20°
  // Gap trimmed off each end of a constellation line segment so it stops short
  // of the star core instead of ending on top of it (a normal-blended line over
  // an additive star dims the core). 2.5 units at radius 400 ≈ 0.36° ≈ 6 px —
  // comfortably clear of a ~4.5 px star without reading as a broken figure.
  // The per-segment trim is clamped to 25% of the segment length so the short
  // Shaula–Lesath arm (~2.9 units) is not inverted.
  CONSTELLATION_LINE_GAP: 2.5,

  // --- Named bright stars at the constellation vertices (Starfield._create) ---
  // The 49 catalogue stars are written into indices 0..48 of the main star
  // Points. Size carries the magnitude range (stars are capped at 2.0 to stay
  // under the bloom threshold, so brightness alone cannot separate mag 0.1
  // from mag 3.5 under ACES); brightness carries the truth. Both are monotone
  // in magnitude so nothing out-sizes or out-shines something genuinely
  // brighter. These are tuned from captures — keep them reachable here.
  STAR_MAG_SIZE_BASE: 4.6,    // size attribute at mag 0 (Rigel ≈ 4.5 → ~6.75 px quad)
  STAR_MAG_SIZE_SLOPE: 0.75,  // size attribute lost per magnitude
  STAR_MAG_SIZE_MIN: 1.3,     // floor so the faintest catalogue star (Eta Leo 3.49) stays visible.
                              // MUST stay strictly above STAR_FIELD_SIZE_FLOOR — the
                              // catalogue-out-sizes-field hierarchy is guarded by a test.
  STAR_MAG_BRIGHT_MIN: 0.45,  // knee, NOT a hard floor — pow(10,-0.4(mag-1)) drops below
                              // 0.45 for mag > ~1.87 (32 of the 49 catalogue stars), and
                              // a hard clamp there would flatten all of them to identical
                              // brightness. Below the knee the soft-floor curve (see
                              // STAR_MAG_BRIGHT_FLOOR_SOFT) keeps strict magnitude ordering
                              // while holding the faint end above the random field instead
                              // of crushing to invisible under ACES.
  STAR_MAG_BRIGHT_FLOOR_SOFT: 0.85, // sub-knee asymptote ratio: brightness never drops
                              // below MIN×0.85 = 0.3825 no matter how faint the raw value.
                              // MUST stay strictly above STAR_FIELD_BRIGHT (0.32) with a
                              // real margin — the faintest named star must out-peak every
                              // field star — and the test suite asserts this.
  STAR_MAG_BRIGHT_MAX: 2.0,   // ceiling — COUPLED to BLOOM_THRESHOLD (2.5): peak fragment
                              // value is 1.0 × 2.0 × uOpacity 0.95 = 1.9. Do NOT raise past
                              // 2.0 without reading that threshold — stars must not bloom
                              // (bloom is reserved for the Sun and Venus).

  // --- Bloom threshold (the one number the whole HDR sky is coupled to) ---
  // The UnrealBloom pass blooms any fragment above this value; SceneManager owns
  // the pass and reads this constant (`?bloomThreshold=N` still overrides for
  // profiling). It lives here, not as a literal in SceneManager, because three
  // separate systems are coupled to it and must agree:
  //   1. the star ceiling above (stars must stay under it),
  //   2. the planet ladder (bodyCatalog/skyBrightness — only Venus crosses it, D3),
  //   3. the bloom GATE (SunLight.isBloomSourceVisible → SceneManager.setBloomEnabled),
  //      which skips the whole mip chain when no source above this value is on screen.
  // Raising or lowering it changes which bodies bloom AND which bodies must keep
  // the pass alive, so the gate derives its source list from this same number.
  BLOOM_THRESHOLD: 2.5,

  // --- Faint random field (Starfield._create, indices 49..STAR_COUNT) ---
  // The ~10k procedural stars are the FAINT TAIL of the same magnitude→size
  // curve the catalogue stars use — the two populations sit on one curve and
  // only the faint, unrecognizable end is invented (decorative, per doctrine B).
  // Counts rise toward the faint end (log N ∝ 0.6·m, the real sky's roughly
  // exponential star-count law), so most field stars are near-invisible and the
  // few brighter ones read as a natural tail, not a uniform speckle.
  STAR_FIELD_MAG_MIN: 4.4,    // brightest random star — MUST stay strictly under the
                              // faintest catalogue star (Eta Leo 3.49 → attribute 1.98)
                              // so Stage 1's hierarchy survives. 4.4 → attribute 1.3.
  STAR_FIELD_MAG_MAX: 7.0,    // faintest random star (~naked-eye limit)
  // Field brightness is a CONSTANT, not the magnitude curve — deliberately.
  // pow(10, -0.4*(mag-1)) yields 0.044 at mag 4.4 down to 0.004 at mag 7.0, so
  // every field star is far below any floor that would keep it visible: the
  // curve cannot carry brightness information across the field's range at all.
  // Size (via the 1.2 px floor) and aAlpha carry the magnitude instead — the
  // same division of labour the catalogue stars use.
  // MUST stay strictly below the soft-floor asymptote STAR_MAG_BRIGHT_MIN ×
  // STAR_MAG_BRIGHT_FLOOR_SOFT (0.3825), which is the peak of the FAINTEST
  // catalogue star (Eta Leo). A field star at or above it ties the named stars
  // in peak luminance and breaks Stage 1's hierarchy.
  STAR_FIELD_BRIGHT: 0.32,
  STAR_FIELD_SIZE_FLOOR: 1.2, // px — size never drops below this; below the floor the
                              // per-star aAlpha carries the remaining faintness. This is
                              // the standard cure for sub-pixel crawl (a 0.5 px speck at
                              // full brightness shimmers as it crosses texel centres).
                              // MUST stay strictly below STAR_MAG_SIZE_MIN (1.3) — guarded
                              // by a test; the catalogue-out-sizes-field hierarchy depends
                              // on it (today it holds only implicitly, via MAG_MIN 4.4
                              // landing exactly at attribute 1.3).
  STAR_FIELD_ALPHA_MIN: 0.15, // aAlpha at MAG_MAX — the faintest stars are barely-there
                              // but not zero (zero would drop them from the draw entirely
                              // and leave a hard magnitude cutout).

  // --- Milky Way band (Starfield._createMilkyWay) ---
  // The band is built on the REAL galactic basis (galacticBasis() in
  // starCatalog.js: pole RA 12.85h Dec +27.13°, center RA 17.76h Dec −28.9°), so
  // it runs through Sagittarius / Cygnus / Cassiopeia as it really does. These
  // constants own the count, presence, size floor, and the licensed structure.
  MW_COUNT: 12000,              // GRAIN points. Was 5,000 — and at 5,000 the band was not
                                // merely faint, it was ABSENT. Per-point peak is capped
                                // just under STAR_FIELD_BRIGHT so the band can never
                                // out-shine a real star (see MW_OPACITY), which means
                                // presence MUST come from coverage and additive overlap —
                                // the doctrine stated at MW_CYGNUS_BOOST below, "density
                                // IS perceived brightness". 5,000 points over a band ~30°
                                // wide and 360° long is far too sparse for that overlap.
                                //
                                // Chosen by measurement, not by guess. Camera pointed at
                                // the galactic centre vs the galactic pole, sampling the
                                // SAME screen box so the HUD and vignette cancel exactly:
                                //   count    band mean   band lit%   band / pole
                                //    5,000     0.92        1.27%       3.7x
                                //   20,000     2.83        4.10%      11.6x
                                //   40,000     5.21        7.43%      21.0x
                                // The off-band background is unchanged at every count
                                // (0.25 mean / 0.31% lit), so raising this densifies ONLY
                                // the band — it cannot swamp the constellations, and
                                // Scorpius stays legible in the 40,000 capture.
                                //
                                // Cost is one buffer, not one draw call per point: frame
                                // rate measured 105 fps at 5,000 and 121 fps at 40,000
                                // (i.e. no measurable cost; the difference is noise).
                                // Do NOT instead raise MW_BRIGHT_MAX — that breaks the
                                // star hierarchy that the whole sky is built on.
                                // Total sky points = 10,000 field+catalogue + MW_COUNT.
  // ---- Haze layer: what actually makes it look like a band ----------------
  // Density alone cannot produce haze. 40,000 grain points measured 21x brighter
  // than off-band and still read as "splattered spray paint", because discrete
  // dots stay discrete no matter how many you add. These few large, very dim,
  // additively-blended sprites overlap into continuous glow instead. The grain
  // count above then drops back to a texture role rather than doing all the work.
  MW_HAZE_COUNT: 9000,          // haze sprites (cheap: same buffer, same draw call)
  MW_HAZE_SIZE_MIN: 16,         // attribute units; x uSizeScale 1.5 => ~24 px
  MW_HAZE_SIZE_MAX: 38,         //                                   => ~57 px
  MW_HAZE_BRIGHT_MULT: 1.6,     // haze colour multiplier, applied on top of the band's
                                // per-point brightness. Decouples the glow from the GRAIN
                                // brightness: grain must stay well under a real field star,
                                // while the haze needs to keep its level. Safe against the
                                // per-point peak rule because haze contribution is
                                // colour x opacity x MW_HAZE_ALPHA (~0.008), far below the
                                // 0.32 field-star value — the alpha is what gates it.
  MW_HAZE_ALPHA: 0.020,         // per-sprite alpha. MUST stay tiny — the glow comes
                                // from summing many, and the per-point peak rule
                                // (see MW_OPACITY) still holds because alpha only
                                // ever reduces a point's contribution.
  MW_OPACITY: 0.75,             // uOpacity for the band material (was 0.55 — too faint
                                // to notice). COUPLING to STAR_FIELD_BRIGHT (0.32): every
                                // band point's peak = vColor × uOpacity × vAlpha must stay
                                // BELOW 0.32 so the band never out-points an actual star.
                                // With MW_BRIGHT_MAX 0.42 and vAlpha ≤ 1 the peak is
                                // 0.42 × 0.75 = 0.315 < 0.32.
  // Band GRAIN brightness. Was 0.42, which put the brightest band point at
  // 0.42 x 0.75 = 0.315 against the faintest field star's 0.32 — technically under
  // the cap, but 98% of it, so band grain was visually indistinguishable from real
  // catalogue stars. That value dates from when grain had to carry the whole band's
  // presence; the haze layer does that now, so grain can be what it physically is.
  // The Milky Way is UNRESOLVED: its individual stars are below naked-eye
  // separation, so they must be the faintest thing in the sky, not rivals to real
  // stars. 0.21 x 0.75 = 0.158, about half a faint field star.
  MW_BRIGHT_MAX: 0.26,          // brightest band point's color multiplier (pre-opacity).
                                // See the MW_OPACITY coupling — the product must stay < 0.32.
  MW_BRIGHT_MIN: 0.05,          // faintest band point (per-point variation for texture).
  MW_SIZE_FLOOR: 1.2,           // px — MUST equal STAR_FIELD_SIZE_FLOOR. The band's old
                                // 0.4–0.9 px points were the exact sub-pixel crawl class
                                // the floor cured; band points get the same floor.
  MW_SIZE_VAR: 1.4,             // px — grain spans MW_SIZE_FLOOR … FLOOR + VAR (1.2 → 2.6); the old 4.5 max out-sized real field stars.
  // Licensed structure (per doctrine B — the shape is real, the contrast is
  // exaggerated ~2× over real so it reads at a glance):
  MW_CENTER_CONTRAST: 2.0,      // center:anticenter density/brightness ratio (licensed).
  MW_BAND_WIDTH: 0.16,          // base latitude half-width (radians) of the band.
  MW_BAND_WIDTH_CENTER: 1.6,    // width multiplier at the galactic center (band is widest
                                // near Sagittarius, like the real galaxy).
  // Halo component: a fraction of the band points are scattered 3× wider and
  // drawn dimmer, giving a bright core in a broad faint glow (like real Milky
  // Way photographs). The three-uniform scatter (Starfield.js) arrives at zero
  // smoothly; the halo carries that smooth fall past the core's own edge, so
  // the band thins out to ~30° instead of stopping dead at ~14°.
  MW_HALO_FRACTION: 0.25,       // fraction of band points in the wide faint halo
  MW_HALO_WIDTH_MULT: 3.0,      // halo scatter width multiplier
  MW_HALO_BRIGHT_MULT: 0.8,     // halo per-point brightness multiplier (only ever
                                // dims, so the MW_BRIGHT_MAX cap is untouched)
  // Great Rift — the dark lane from Cygnus to Sagittarius (negative space, not black paint).
  // The Great Rift — the dark dust lane that SPLITS the band lengthwise. This is
  // the band's second most recognisable feature after the band itself, and it was
  // previously both half-missing and far too narrow to read:
  //   - it ran l=0 → 80° only, stopping dead at Sagittarius. The published extent
  //     runs Cygnus → Serpens-Aquila → Ophiuchus → Sagittarius → CENTAURUS, so the
  //     entire Sgr-to-Centaurus half of the feature was simply absent.
  //   - the half-width was 0.05 rad (5.7° full) against a band ~29° wide. The rift
  //     "appears as clear as the bright bulge" and "divides the bright band
  //     vertically" — it cannot do that at 20% of the band's width.
  // Published span: Cygnus l≈80° to Centaurus l≈310° (= −50°), which is ~130° of
  // longitude, matching "the Great Rift covers one third of the Milky Way".
  MW_RIFT_LONG_MIN: -0.87,      // radians — Centaurus end (l≈310°).
  MW_RIFT_LONG_MAX: 1.40,       // radians — Cygnus end (l≈80°, Northern Coalsack).
  MW_RIFT_OFFSET: -0.03,        // latitude offset of the lane centre (radians off-plane),
                                // so the lane splits the band into two flanking strips.
  MW_RIFT_WIDTH: 0.075,         // lane half-width (radians, ~4.3°) at the narrow Cygnus end.
                                // Sized to SPLIT the ~29°-wide band into two flanking
                                // strips, not to erase it: at 0.09 with a 2.2 broadening
                                // the lane reached 20° at Sagittarius and swallowed the
                                // bright bulge, which the rift obscures but does not
                                // remove — the Sagittarius star clouds still flank it.
  MW_RIFT_BROADEN: 1.5,         // width multiplier where it broadens out (~12° full at Sgr).
  MW_RIFT_BROADEN_LONG: 0.26,   // radians — Ophiuchus (l≈15°), where the rift is widest.
  MW_RIFT_BROADEN_WIDTH: 0.55,  // radians — how far the broadening reaches along the lane.
  MW_RIFT_DEPTH: 0.06,          // residual density in the lane core. The rift is dust
                                // obscuration, not an empty hole, so keep a few stars.
  MW_RIFT_EDGE: 0.9,            // soft-edge fraction (the mask ramps depth→1 over this).
  // Cygnus star-cloud enhancement (the bright cloud around Cygnus).
  MW_CYGNUS_LONG: 1.4,          // radians (l≈80°).
  MW_CYGNUS_WIDTH: 0.25,        // gaussian width (radians).
  // Density multiplier at the Cygnus centre. HARD CEILING, guarded by a test:
  // the centre profile has already fallen to ~0.792 by this longitude, so any
  // boost above 1/0.792 = 1.262 makes Cygnus DENSER than Sagittarius — which is
  // what 1.7 did (1.35× denser), inverting the documented "brightest at the
  // galactic centre" structure. Because band presence comes from COVERAGE and not
  // per-point peak (see MW_OPACITY), density IS perceived brightness, so the
  // brightest region simply sat in the wrong place. Raising MW_CENTER_CONTRAST
  // cannot buy headroom — that term asymptotes near 0.585 at this longitude and
  // would need a contrast above 130. See starCatalog.mwDensity, which composes
  // the two terms for BOTH the builder and the test (they were separate before,
  // which is how a 1.35× inversion passed a "density falls monotonically" test).
  MW_CYGNUS_BOOST: 1.25,

  // ---- Bright star clouds: the band is PATCHY, not a smooth glow -----------
  // The Milky Way's naked-eye character comes from discrete bright knots flanking
  // the Great Rift. These are placed from PUBLISHED coordinates only.
  //
  // Researched, and most of the famous names turned out to be unusable: the
  // Scutum, Cygnus and Norma Star Clouds have NO published coordinates or extent
  // — no dedicated catalogue entry, no SIMBAD record under those names, they appear
  // only as examples in prose. Rather than invent plausible positions for them,
  // they are omitted. (Cygnus still gets its longitude density boost above, which
  // is a separate, already-tested mechanism.)
  //
  // Positions are RA (hours) / Dec (degrees), J2000, converted with raDecToUnit at
  // build time. Sizes are the published apparent extents, as half-widths here.
  // Semi-axes are HALF the published apparent size (a = along RA, b = along Dec).
  MW_STAR_CLOUDS: [
    // Wikipedia, "Large Sagittarius Star Cloud": apparent size 6°x4°. NOTE the
    // source gives RA/Dec only to whole hour/degree, so this is a rough locator
    // by the source's own admission — good enough for a diffuse 6° cloud.
    { name: 'Large Sagittarius Star Cloud', ra: 18.0,   dec: -29.0,   aDeg: 3.0, bDeg: 2.0 },
    // Wikipedia, "Small Sagittarius Star Cloud" (M24 / IC 4715), citing O'Meara,
    // The Messier Objects (2014) p.117: apparent size 2°x1°.
    { name: 'Small Sagittarius Star Cloud', ra: 18.283, dec: -18.483, aDeg: 1.0, bDeg: 0.5 },
    // Wikipedia, "Carina Nebula" (NGC 3372), NGC/IC Project data: 120'x120'. Not a
    // star cloud proper, but it is the bright naked-eye knot of the Carina Milky Way.
    { name: 'Carina Nebula',                ra: 10.752, dec: -59.868, aDeg: 1.0, bDeg: 1.0 },
  ],
  // Fraction of band points redirected into the clouds. Presence comes from DENSITY,
  // never from per-point brightness — boosting brightness would break the "no band
  // point out-peaks a star" cap (see MW_OPACITY).
  //
  // DERIVED, because eyeballing this failed twice. The clouds total ~23.6 sq deg and
  // the band's ambient density near the galactic centre is ~5 points/sq deg, so they
  // already contain ~117 points before any boost. A real star cloud is a 2-3x
  // brightening of the surrounding band, so the extra budget is only ~120-230 points:
  //     2.0x -> 0.0056     2.5x -> 0.0084     3.0x -> 0.0112
  // 0.14 and 0.05 were tried and both rendered as globular clusters with a visible
  // rim — 0.05 is a 10x spike, which is a cluster by definition, not a cloud.
  MW_CLOUD_EXTRA_FRACTION: 0.011,

  // =========================================================================
  // SUN / MOON / PLANETS (SunLight.js) — the naked-eye bodies
  // =========================================================================
  // Sizes live in bodyCatalog.js (displayAngularDeg) as the single source of
  // truth; these constants own the DISTANCES, opacities, halos, labels and the
  // depth-mask geometry. Every brightness ceiling notes its coupling to the
  // 2.5 bloom threshold (SceneManager) — bloom is reserved for the Sun and
  // Venus (D3), so nothing else may cross it.

  // --- Distances (world units) ---
  // The bodies are camera-facing billboards at fixed distances inside the star
  // shell. Sun/Moon/planets sit at slightly different distances so their depth
  // ordering is deterministic; the ANGULAR sizes are what matter visually and
  // those come from bodyCatalog.displayAngularDeg at these distances.
  SUN_DIST: 450,                // sun glare sprite + core reference distance
  MOON_DIST: 430,               // moon disc distance (~1.49° → radius ~5.6)
  PLANET_DIST: 440,             // planet disc distance
  PLANET_GLOW_DIST: 438,        // glow halo sits slightly BEHIND its disc
  // Depth masks are placed just INSIDE the star shell so they have smaller
  // depth values than the stars and can occlude them. COUPLED to
  // STAR_SPHERE_RADIUS (400): the mask must be < 400 or it cannot hide stars,
  // and far enough inside that the 0.98 ray-solve margin in _updateSunDisc
  // keeps it in front of the shell at altitude.
  BODY_DEPTH_MASK_DIST: 398,

  // --- Sun ---
  // The glare sprite scale and the depth-mask radius are BOTH derived from
  // bodyCatalog's Sun displayAngularDeg (1.49°, Moon parity) in bodyGeometry
  // (sunGeometry) — one source of truth so they can never desync (that desync was
  // F6: glare 1.91° vs mask 1.15° let stars show inside the glare). No
  // SUN_GLARE_SCALE constant by design.
  SUN_GLARE_OPACITY: 0.95,      // additive; multiplies the HDR peak below.
  // The Sun is the one body MEANT to bloom (D3) — and it did NOT, which was a
  // latent defect: the sprite was plain LDR (colour ≤ 1 × opacity 0.95 ≈ 0.95),
  // so it could never reach BLOOM_THRESHOLD 2.5 and the pass produced nothing
  // from it. The "halo" was only the texture's own skirt. This is the HDR peak
  // the sprite's core now renders at, applied exactly like the planet ladder
  // (tint × PEAK / (maxChannel × opacity), so the peak channel lands here).
  // COUPLING to BLOOM_THRESHOLD: must exceed 2.5 for the core to bloom at all.
  // At 3.0 the core (texture alpha ≥ 0.88) crosses it and the glow skirt
  // (alpha 0.25 → 0.75) stays under, so the solid disc blooms and the skirt does
  // not — which is the intent. Costs nothing: the bloom pass is already running
  // on every sun-visible frame (the gate is open), it just had no sun to work on.
  SUN_HDR_PEAK: 3.0,
  // How far the glare texture visibly glows, as the alpha below which it stops
  // being perceptible. The depth mask is sized to THIS extent, not to the
  // sprite's square: the sprite reaches alpha 0 at its rim, so masking to the
  // full sprite deleted stars from a ~3 px ring of effectively empty sky (an
  // invisible hole — the inverse of F6, and undetectable by a "zero stars inside
  // the mask" test, which passes trivially once the mask covers everything).
  // With the shipped gradient stops (bodyGeometry.SUN_GLARE_STOPS) 0.10 puts the
  // mask at 0.90 of the sprite = 1.341° vs the 1.49° disc.
  SUN_GLARE_VISIBLE_ALPHA: 0.10,
  SUN_LABEL_OFFSET: 15,         // world units below the disc (camera-relative)
  // --- Moon ---
  MOON_BASE_OPACITY: 0.85,      // NormalBlending disc; the shader owns phase (Stage 3
                                // replaced whole-disc dimming with a real terminator
                                // + earthshine — see _updateMoon). MUST stay under
                                // BLOOM_THRESHOLD: the Moon must never bloom.
  // Depth-mask radius as a FRACTION of the moon's disc radius (was an independent
  // literal 5.2, which is this × 5.5915 — the same desync class as F6, just
  // smaller: changing the Moon's displayAngularDeg silently changed the
  // relationship). Slightly inside the disc because the texture's limb fade makes
  // the outer rim translucent, so masking to the geometric edge would hide stars
  // behind nothing. Stays FULL-DISC at every phase — the unlit limb is still
  // solid rock and really does occlude stars.
  MOON_MASK_FRACTION: 0.93,
  MOON_LABEL_OFFSET: 14,        // ≈ radius (5.59) + 8, the planet convention
  // --- Moon Stage 3: real terminator + earthshine ---
  // (The F2 phase floors — MOON_PHASE_BRIGHTNESS_FLOOR / _OPACITY_FLOOR /
  // _OPACITY_SCALE — were deleted when Stage 3 landed the terminator: the shader
  // now shades a sphere normal, so there is no whole-disc opacity to floor.)
  // Earthshine: the ashen light on the unlit limb (Earth-reflected sunlight).
  // LICENSED — true earthshine is far dimmer than 6% of the lit side; this is
  // the value that keeps a new moon readable as a faint disc for real reasons,
  // replacing the F2 whole-disc opacity floor. Applied to the UNLIT fraction
  // only: color = tex × (lit + earthshine × (1 − lit)).
  MOON_EARTHSHINE: 0.06,
  // Terminator softness: the smoothstep half-width k on dot(normal, sunDirView).
  // Small enough that the crescent horns stay sharp, large enough that the
  // terminator doesn't alias across the 24 px disc.
  MOON_TERMINATOR_SOFTNESS: 0.05,

  // --- Planets (shared) ---
  // Stage 5 brightness mechanism (the resolved "pick one"): opacity is 1.0 and
  // the skyBrightness ladder is applied DIRECTLY as the HDR color multiplier
  // B(mag) on each disc. COUPLING to the 2.5 bloom threshold (SceneManager):
  // with NormalBlending the rendered peak is color × texture × opacity = (tint ×
  // B(mag)) × texPeak × 1.0. For flat discs (texPeak 1) the peak channel is
  // tint_peak × B(mag) — Venus (near-white) 2.74 blooms, Jupiter 2.39 / Mars
  // 2.28 / Mercury ~1.6 (tint-weighted) / Saturn 1.58 all stay under. Only Venus
  // blooms (D3). The multiplier MUST use the same skyBrightness curve the stars
  // use (starCatalog.js) or the planets and stars fork onto two curves (F5).
  PLANET_DISC_OPACITY: 1.0,
  PLANET_GLOW_OPACITY: 0.6,     // additive halo behind the disc
  PLANET_GLOW_RADIUS_FACTOR: 1.25, // halo radius = this × body radius (was 1.5×).
                                // The glow plane's full width = 2 × halo radius.
  PLANET_LABEL_OFFSET: 8,       // label sits radius + this below the disc
  BODY_LABEL_SCALE_X: 50,       // shared planetarium label sprite scale
  BODY_LABEL_SCALE_Y: 12,
  BODY_LABEL_OPACITY: 0.34,

  // --- Per-planet sun-angle offsets (decorative positions, degrees) ---
  // deg = fixed elongation from the sun angle (decorative, per doctrine B). The
  // halo radius now derives from the disc radius (PLANET_GLOW_RADIUS_FACTOR), so
  // there are no per-planet PLANET_*_GLOW constants.
  PLANET_MERCURY_DEG: 20,
  PLANET_VENUS_DEG: 40,
  PLANET_MARS_DEG: 170,
  PLANET_JUPITER_DEG: 90,
  PLANET_SATURN_DEG: 130,
  // Saturn's rings need a full-square PlaneGeometry billboard (the rings extend
  // past the globe's inscribed circle). The plane size is DERIVED in bodyGeometry
  // (planetGeometry) from the catalogue's ringSpanAngularDeg, because the drawn
  // rings fill only SATURN_RING.spanFraction (0.8626) of the texture — sizing the
  // plane to the intended span directly would render the rings 14% small (the
  // plan's trap 2). No PLANET_SATURN_PLANE_SIZE constant by design; the ring
  // proportions live once in bodyGeometry.SATURN_RING, shared by the texture and
  // the elliptical depth mask (F7).

  // =========================================================================
  // V3 OCTOPUS ADR SATELLITE (from V3 Octopus.md Appendix F)
  // 6-arm configuration: 3 Weaver (large) + 3 Spinner (small), hexagonal
  // V4 "Opussy" GSL upgrades available as unlockable tech path
  // =========================================================================

  // --- Core ("The Brain") ---
  OCTOPUS_CORE_DRY_MASS: 170,           // kg
  OCTOPUS_CORE_COLD_GAS: 6,             // kg N₂ RCS
  OCTOPUS_CORE_BATTERY: 600,            // Wh
  OCTOPUS_CORE_HALL_ISP: 1500,          // s — fallback (h3-argon-engine: the active fuel's FUELS[..].isp is the ship's Isp; xenon = 1500 too)

  // ── Rigid-body attitude dynamics (supersedes kinematic rotation) ──
  // Lives OUTSIDE FEATURE_FLAGS deliberately (D7): REALITY_MODE forces every
  // FEATURE_FLAGS.* false, and disabling *physics* is not what REALITY_MODE means.
  // (The master switch and the legacy kinematic path it restored — old mass*0.25
  // MOI + kinematic slerp — were removed 2026-10-16.)
  ATTITUDE: {
    NOZZLE_THRUST_N: 40.0,      // per-nozzle cold-gas thrust — the single feel dial (D1).
                                // 40 N chosen over raising MAX_RATE: higher thrust shortens the
                                // burn, so overshoot improves (17.1° → 10.7°) instead of degrading
                                // (17° → 24° at 0.9 rad/s), and spin-up tightens 1.01 s → 0.63 s.
    MAX_RATE: 0.6,              // rad/s angular-rate cap (D1: 34°/s)
    RECENTER_RATE: 0.1,         // rad/s (5.7°/s) — target return rate toward prograde
    RECENTER_GAIN: 1.0,         // 1/s — ω_target = clamp(GAIN·θ, RECENTER_RATE)
    HOLD_DEADBAND_RAD: 0.035,   // ~2°, no recenter inside this
    INERTIA_MAX_FACTOR: 3.0,    // D6 berthed-mass clamp: total ≤ 3× stowed transverse
    COLD_GAS_BASE_RATE: 0.5,    // tank units per second of one full couple (PlayerSatellite `_coldGasRate`, before the shop's efficiency upgrade)
    RCS_ATTITUDE_N2_FACTOR: 1.0, // the REAL steering-gas price since 2026-10-24 (owner): assigned from NOZZLE_THRUST_N, Isp, G0 right after this literal
  },

  // ── Sloth mode (owner 2026-10-23, DECISIONS §37): with the steering gas out, the four tail ion boxes turn her slowly ──
  // Each box is a quarter of her one real engine (TRIP.XENON_THRUST_N × the loaded gas's thrustScale, §33 row 10), at a
  // quarter of its 600 W. Torque comes from the box's real place and the ship's centre of mass (r − CoM) × F, never typed in.
  // The tank's last gas is kept for stopping: a cold-gas turn never spins her faster than the gas left can stop, and when the
  // tank holds less than spinning up to MIN_SPIN_DEG_S and stopping from it costs, every turn is a slow one on the boxes.
  SLOTH: {
    BOX_POWER_W: 150,            // W per lit box = 600 W (the engine) / 4; drawn through drawUpTo like the engine's power
    WARMUP_S: 30,                // s the cathodes warm before the first thrust (a heaterless Hall cathode starts in < 25 s, SETS ST-40; rounded up)
    STANDBY_W: 20,               // W hot standby once warm, while sloth mode is on (ESTIMATE); not met -> cold, warm again next use
    STOP_RESERVE: 1.05,          // a cold-gas turn keeps this x the gas the stop will bill (the arrest always may spend it)
    GAS_DUST_FRAC: 0.01,         // a tank under this fraction of G_min is empty for the selector (else the last grain fades the torque for ~18 s)
    MIN_SPIN_DEG_S: 1,           // G_min = gas to spin up to this rate + gas to stop from it; below it the boxes take every turn
    GAS_ARREST_ABOVE_DEG_S: 1,   // in sloth mode a spin faster than this is stopped with the gas that is left (the boxes finish the stop)
    SERVO_ZONE_S: 2,             // the box rate-null is proportional inside alpha x this (rad/s): full torque outside, no chatter inside
    REST_RAD_S: 1e-7,            // below this rate error the box rate-null stops firing (the cold-gas servo's 1e-4 is bigger than a sloth turn)
    COLD_START_RAD_S: 1e-4,      // a spin error under this (the cold-gas servo's own "at rest") does not start the cathodes warming: nothing is trimmed until they are warm anyway
    AIM_SLACK_S: 60,             // seconds added to a slow aim's time-out on top of twice its planned time
  },

  // ── Reaction-wheel kit (owner 2026-10-23/24, DECISIONS §2 row 9; docs/research/2026-10-reaction-wheels.md): the standard 3-wheel
  // rung. One RW4-class wheel per body axis (x pitch, y yaw, z roll), a magnetic coil per axis that slowly bleeds the stored spin
  // into the Earth's field, and the electronics. Wheels turn her for nothing but battery; the cold gas stays for fast turns and as
  // backup. The kit is structure (on the axis, z = Z_M): it counts in her dry mass and her inertia, not in her centre of mass.
  // MASS_KG and COIL_TORQUE_NM are derived below the literal, never typed.
  WHEELS: {
    COUNT: 3,
    MOMENTUM_NMS: 4,             // N·m·s each wheel holds at most (RW4 class)
    TORQUE_NM: 0.25,             // N·m each wheel gives the ship at most
    WHEEL_MASS_KG: 9.6,          // 3 wheels
    COIL_MASS_KG: 1.5,           // 3 coils of 0.5 kg
    ELECTRONICS_MASS_KG: 1.0,
    Z_M: -0.3,                   // m, the cluster on the axis, aft of the barrel origin (study: -0.2 to -0.4)
    PRICE_CR: 800,
    STANDBY_W: 10,               // W per wheel, always while the kit is aboard
    PEAK_W: 150,                 // W per wheel at full torque (power follows torque in proportion)
    COIL_W: 1.3,                 // W per coil, three coils together while any wheel holds spin
    COIL_MOMENT_AM2: 15,         // A·m² per coil
    FIELD_T: 36e-6,              // T: the study's mean field at 350 km (the game has no field model)
    FIELD_ALLOWANCE: 0.5,        // the coil works across the field, not along it: half of it on average (study)
    UNLOAD_ON_FRAC: 0.9,         // steering gas empty: the tail boxes start unloading an axis at this fraction of full ... (coordinator's assumption)
    UNLOAD_OFF_FRAC: 0.5,        // ... and stop at this one
    FULL_FRAC: 0.98,             // an axis this full cannot take more spin in that direction: the selector counts the wheels as full
    MIN_BATTERY_WH: 0.5,         // below this the wheels give no torque (AutopilotSystem BATTERY_EMPTY_WH)
    SERVO_ZONE_S: 2,             // the wheel rate-null is proportional inside alpha x this (rad/s): full torque outside, no chatter inside
    REST_RAD_S: 1e-7,            // below this rate error a wheel-made spin counts as stopped
    // F2 (moving targets): an aim at a drifting piece goes to the wheels only while their room rate covers the piece's line-of-sight
    // rate this many times over (coordinator's choice; a ship that cannot out-turn the bearing never catches it), and the aim measures
    // that rate itself (the first seconds), because no caller can say it at the request.
    LOS_COVER: 2,
    LOS_SETTLE_S: 0.3,           // s: a stateful aim provider (the lead-aim's smoothing, 20 % a frame) settles before the bearing's rate is read
    LOS_CHECK_S: 0.8,            // s: the first look at the measured rate; the aim is re-judged every LOS_RECHECK_S after
    LOS_RECHECK_S: 0.5,
    LOS_TAU_S: 0.5,              // s: the measured rate is smoothed over this time
    AIM_HANDOVER_X: 1.5,         // an aim not converged by AIM_HANDOVER_X × its plan + AIM_HANDOVER_S hands over to the gas (gas above sloth's floor)
    AIM_HANDOVER_S: 5,
  },

  // FIX_PLAN §3: Tether-aware rotation limits (exponential spring-resistance model).
  // When daughters are tethered, the mother's rotation is dampened by an "elastic" tether:
  //   effectiveRate = baseRate · (1 − |θ|/θ_max)^STIFFNESS_EXPONENT
  // — Initial keypress feels normal (rate=baseRate at θ=0).
  // — Sustained pressure builds displacement → rate falls toward 0 at the wall.
  // — Releasing arrows bleeds displacement toward neutral (spring-back).
  // — Rotation TOWARD neutral always uses full baseRate (relief direction unconstrained).
  TETHER_ROTATION: {
    // Max per-axis displacement (pitch OR yaw) before fully locked
    MAX_DISPLACEMENT_SOFT:  0.524,  // rad (~30°) — soft tier (LAUNCHING, TRANSIT, APPROACH, TRAWLING, …)
    MAX_DISPLACEMENT_BLOCK: 0.087,  // rad (~5°)  — block tier (REELING, HAULING, GRAPPLED, NETTING, …)

    // Damping curve exponent: 2 = quadratic (gentle near neutral, hard wall at θ_max)
    STIFFNESS_EXPONENT: 2,

    // Spring-back rate: how fast displacement bleeds toward 0 when no arrow pressed
    SPRINGBACK_RATE_SOFT:  0.05,    // rad/s (~2.9°/s) — slow recovery (loose tether)
    SPRINGBACK_RATE_BLOCK: 0.15,    // rad/s (~8.6°/s) — faster recovery (taut tether re-centers)

    // Fraction of MAX_DISPLACEMENT at which the comms warning fires
    SATURATION_THRESHOLD: 0.95,

    COMMS_THROTTLE_MS: 3000,        // ms — interval between "tether tension critical" comms
  },

  // --- Weaver (Large Arm) — 3 units in hexagonal config ---
  WEAVER_MASS: 11.0,                    // kg per unit
  WEAVER_DELTA_V: 500,                  // m/s total FEEP budget
  WEAVER_TOTAL_IMPULSE: 5500,           // Ns (Enpulsion NANO R3)
  WEAVER_THRUST: 0.00035,              // N (0.35 mN FEEP)
  WEAVER_TETHER_LENGTH: 2000,           // m (2 km)
  WEAVER_NET_SIZE: 3.0,                 // m (3×3 deployed Dyneema SK78; 5 m until 2026-10-23, DECISIONS §38 row 5; = CAPTURE_NET.MEDIUM.DIAMETER)
  WEAVER_MAX_CAPTURE_MASS: 500,         // kg
  WEAVER_BODY: [0.2, 0.2, 0.3],       // m [x, y, z] dimensions
  WEAVER_CAPTURES_PER_FUEL: 33,        // captures before FEEP depletion

  // --- Spinner (Small Arm) — 3 units in hexagonal config ---
  SPINNER_MASS: 3.7,                    // kg per unit
  SPINNER_DELTA_V: 297,                 // m/s total FEEP budget
  SPINNER_TOTAL_IMPULSE: 1100,          // Ns (Enpulsion IFM Nano SE)
  SPINNER_THRUST: 0.0005,             // N (0.5 mN FEEP)
  SPINNER_TETHER_LENGTH: 500,           // m (0.5 km)
  SPINNER_NET_SIZE: 1.5,                // m (1.5×1.5 deployed)
  SPINNER_MAX_CAPTURE_MASS: 50,         // kg — derived from CAPTURE_NET.SMALL.MAX_CAPTURE_MASS (drift-guard test enforces)
  SPINNER_BODY: [0.1, 0.1, 0.15],     // m [x, y, z] dimensions
  SPINNER_CAPTURES_PER_FUEL: 37,       // captures before FEEP depletion

  // --- Tether ---
  TETHER_REEL_POWER: 15,               // W per reel motor

  // --- Tether Visual ---
  // Dyneema SK78 fiber — naturally white, dyed hi-vis for space operations.
  // Nominal: cream-white matching Dyneema drum material. Stressed/Critical: warning amber/red.
  TETHER_COLOR_NOMINAL: 0xddddee,
  TETHER_COLOR_STRESSED: 0xffaa00,
  TETHER_COLOR_CRITICAL: 0xff0000,
  TETHER_SEGMENTS: 24,                 // line segments for catenary render
  TETHER_SAG_FACTOR: 0.015,           // catenary sag amplitude as fraction of current separation
  TETHER_SAG_PARALLEL_THRESHOLD: 1e-6, // threshold for tether-parallel-to-gravity degeneracy detection
  // Wave1 tension feedback (2026-08-27): the daughter tether tint is driven by
  // the TENSION fraction (tetherTension / tetherBreakStrength) through the
  // REEL_TENSION_WARNING / REEL_TENSION_CRITICAL thresholds — the same pair the
  // DockingReticle tension bar and StatusPanel stress readout already use — and
  // eased per frame with this time constant so the line can never strobe (the
  // retired always-on driver keyed off DISTANCE strain and flashed red/white in
  // the orbital frame). The creak floor rate-limits the daughter's
  // Events.TETHER_TENSION emits per arm (AudioSystem's per-armId cooldown still
  // applies downstream); see ArmUnit._updateReeling for the owner note.
  TETHER_COLOR_EASE_TAU_S: 0.25,       // s — exponential ease of the tether tint toward its tension target
  TETHER_CREAK_MIN_INTERVAL_S: 1.5,    // s — hard floor between daughter TETHER_TENSION creak emits (per arm)



  // --- Arm State Machine ---
  ARM_STATES: {
    DOCKED: 'DOCKED',
    UNDOCKING: 'UNDOCKING',
    TRANSIT: 'TRANSIT',
    APPROACH: 'APPROACH',
    NETTING: 'NETTING',
    GRAPPLED: 'GRAPPLED',
    HAULING: 'HAULING',
    RETURNING: 'RETURNING',
    DOCKING: 'DOCKING',
    TRAWLING: 'TRAWLING',          // Slow sweep — passive debris collection along orbit path
    DEORBITING: 'DEORBITING',      // One-way sacrifice — burning all fuel retrograde (Session 10)
    WEB_SHOT: 'WEB_SHOT',          // Brief GSL web shot launch animation (Sprint D1)
    LAUNCHING: 'LAUNCHING',        // V5 — Replaces UNDOCKING — crossbow spring release (0.05s)
    REELING: 'REELING',            // V5 — Replaces HAULING — strut-reel motor haul (the winch pulls; reel-gas 2026-10-21: under REEL_HOME her ion thread keeps the line tight and her cold-gas jet brakes)
    RELOADING: 'RELOADING',        // V5 — worm gear compresses spring
    HOLDING_CATCH: 'HOLDING_CATCH', // Daughter docked at strut tip holding a captured debris in-net, awaiting furnace transfer (occupied — not redeployable, not reloaded)
    ABLATING: 'ABLATING',          // V5 — 10W laser de-spin/nudge
    SCANNING: 'SCANNING',          // V5 — pulse scan distributed sensor array
    STATION_KEEP: 'STATION_KEEP',  // V8 — hold position relative to debris (orbital-crane)
    ADRIFT: 'ADRIFT',              // Out of usable FEEP but STILL TETHERED & powered — recoverable.
                                   //   Thrusters offline (no working propellant); avionics/beacon live,
                                   //   so the mother can still reel her home, the player can still
                                   //   select/pilot (1-4), and she can be disconnected. NOT lost.
    EXPENDED: 'EXPENDED',          // Genuinely lost — tether snapped, detached & out of range/fuel,
                                   //   or deorbit burn complete. Terminal; no recovery.
    MAGNETIC_GRAPPLE: 'MAGNETIC_GRAPPLE',  // P2 — EPM contact + 50 N hold + reel (DAUGHTER_MULTITOOL)
    GRIPPER_GRAPPLE:  'GRIPPER_GRAPPLE',   // P3 — 3-jaw chuck on protruding fixture (reserved)
    PAD_CONTACT:      'PAD_CONTACT',       // P4 — multi-modal pad contact attempt (reserved)
    // trip-melt-2 (carry, 2026-10-19): a daughter carries a rack catch to a radiator-tip furnace on the trip and comes home.
    CARRY_PREP:       'CARRY_PREP',        // docked: the strut and the radiators move to the carry pose
    CARRY_OUT:        'CARRY_OUT',         // clamp release, then the straight flight to the tip (her docked attitude, ship-relative)
    CARRY_HANDOFF:    'CARRY_HANDOFF',     // the catch leaves her rack for the tip, a beat at the tip
    CARRY_BACK:       'CARRY_BACK',        // the same line in reverse, wound by her strut reel
  },

  // --- Daughter multi-tool (DAUGHTER_MULTITOOL_SPEC §4.1) ---
  // Per-arm tool inventory (Y0 baseline; static-by-class, read on construction).
  // Tool kinds are the bare strings 'NET' | 'MAGNET' | 'GRIPPER' | 'PAD'.
  DAUGHTER_TOOLSETS: {
    weaver:  ['NET', 'GRIPPER', 'MAGNET'],   // ordered: primary first (§2 table)
    spinner: ['NET', 'PAD'],                 // DECISIONS §33 row 2 / u18 D7: four nets + a sticky pad, no magnet (the large daughter keeps hers)
  },

  // EPM magnetic-grapple tuning (cite EPIC10_DEEP_ANALYSIS.md:3322-3326).
  // §13 Q4 heterogeneous-spacecraft model: real sats / rocket bodies have steel
  // bolts / brackets even when the hull is Al or Ti.
  MAGNETIC_GRAPPLE: {
    CONTACT_RANGE_M:        0.5,    // EPM contact window (touch −Y face to ≤0.5 m)
    HOLD_FORCE_N:           50,     // EPIC10 line 3322
    MAX_DEBRIS_MASS_KG:     500,    // EPIC10 line 3325
    ENERGIZE_PULSE_S:       0.3,    // pole-face blue flash 1.0→0.0 over 0.3 s
    RELEASE_PULSE_S:        0.2,    // red flash 1.0→0.0 over 0.2 s
    CLOSE_TIMEOUT_S:        6.0,    // max CLOSING duration before MAGNETIC_GRIP_FAILED
    GRIP_DWELL_S:           0.4,    // dwell on contact before the P_GRIP roll
    P_GRIP_FERROUS:         0.95,   // pure-ferromagnetic target (steel hull)
    P_GRIP_FASTENERS:       0.40,   // §13 Q4 — heterogeneous target latches onto bolts/brackets
    P_GRIP_NON_FERROUS:     0.05,   // all-Al fragment / composite — residual flux only
  },

  // 3-jaw gripper tuning (P3; cite archive/V3 Octopus.md:820-828).
  GRIPPER_GRAPPLE: {
    REACH_M:            0.30,   // jaws extend 30 cm beyond −Y face
    GRIP_DIAMETER_M:    0.050,  // 50 mm aperture
    GRIP_FORCE_N:       30,
    EXTEND_TIME_S:      0.3,    // jaws extend, audible servo click
    SEEK_TIME_S:        0.4,    // raycast for a fixture within ±15° of −Y
    CLOSE_TIME_S:       1.2,    // spiral cam closes 50→0 mm
    RATCHET_HOLD:       true,   // zero-power lock once closed
    P_GRIP_FIXTURED:    0.90,   // target has docking port / strut / antenna stub
    P_GRIP_UNFIXTURED:  0.10,   // target lacks protrusion — should not be selected
    MAX_DEBRIS_MASS_KG: 2000,   // mechanical limit; doc-aspirational
  },

  // Multi-modal pad tuning (P4; cite archive/V3 Octopus.md:799-818).
  PAD_CONTACT: {
    PAD_RADIUS_M:        0.080,   // 8 cm contact patch
    CONTACT_VEL_MAX_M_S: 0.20,    // any faster and the pad bounces (soft-contact regime)
    APPROACH_TIMEOUT_S:  75.0,    // safety cap on APPROACH_SOFT, >= 2x the measured 12 m approach (35.0 s, a tiny piece); a timeout fails as 'timeout'
    // Soft final approach (nets-1b, 2026-10-20): she rides with the piece and closes to its SURFACE (reach + PAD_RADIUS_M
    // from its centre, `DebrisField.trueReachM`) at v = clamp(GAIN*gap, MIN, MAX). Gain, min and max are estimates (owner
    // may veto). Measured (test-PadApproach.js, 60 fps, 0.5 m fragment): 8 m -> contact at 26.6 s, 12 m -> 34.6 s, still or
    // drifting at 0.5 m/s alike; touch speed = the commanded closing speed at contact = 0.03 m/s (limit 0.20).
    APPROACH_GAIN_PER_S: 0.25,    // 1/s — closing speed per metre of range
    APPROACH_V_MIN_M_S:  0.03,    // m/s — the slowest she creeps in (this is her touch speed)
    APPROACH_V_MAX_M_S:  0.5,     // m/s — the fastest she closes from far
    CONTACT_HOLD_S:      1.0,     // dwell before the P_GRIP roll
    ENERGIZE_PULSE_S:    0.3,
    RELEASE_PULSE_S:     0.2,
    GECKO_TEMP_MIN_C:    -40,
    GECKO_TEMP_MAX_C:    80,
    UV_CURE_DOSES_Y0:    10,      // per-arm magazine (§13 Q3 — hard cap; 0 ⇒ uv_cure removed)
    ADHESION_MODES: ['gecko', 'hooks', 'electrostatic', 'magnet', 'uv_cure'],
    // Auto-resolved on contact by surface metadata (V3 Octopus.md:811-816):
    //  1. material ∈ {steel,iron_alloy}                          → magnet
    //  2. material ∈ {mli_mylar} OR roughness > 0.7              → hooks
    //  3. material ∈ {aluminum,kapton,glass_ceramic,solar_cell}  → gecko (warm window)
    //  4. material ∈ {composite}                                 → electrostatic
    //  5. else                                                   → uv_cure (finite doses)
    P_GRIP_BY_MODE: {
      gecko:         0.90,
      hooks:         0.95,
      electrostatic: 0.70,
      magnet:        0.95,
      uv_cure:       0.98,
    },
    P_GRIP_NO_MODE:  0.05,        // contact happened but no mode resolved
    MODE_GLYPHS: { gecko: 'g', hooks: 'h', electrostatic: 'e', magnet: 'm', uv_cure: 'u' },
  },

  // Daughter→furnace transfer (park-the-catch delivery; ARCHITECTURE.md:277, Captured-debris lifecycle). A parked
  // HOLDING_CATCH catch is handed to the mother's furnace over this window, then
  // the daughter reloads. Salvage + scoring fire on transfer COMPLETION (the
  // CATCH_PROCESSED event), not on dock arrival (ARM_RETURNED) — this is the
  // fix for the premature-scoring + indefinite-park debt.
  FURNACE_TRANSFER: {
    // Staged furnace breakdown (2026-06-11 daughter-cycle polish, Item 1): the
    // parked catch is no longer ingested in one frame. Three phases run off the
    // daughter's HOLDING_CATCH stateTimer:
    //   hold  [0, HOLD_S)            — catch held full-size, cinched in the net
    //   chop  [HOLD_S, CHOP_S)       — catch separated into CHUNK_COUNT pieces
    //   feed  [CHOP_S, FEED_S)       — chunks stream to the mother's furnace, then
    //                                  CATCH_PROCESSED fires (salvage/score/remove)
    // Boundaries are CUMULATIVE seconds from HOLDING_CATCH entry.
    HOLD_S: 2.0,
    CHOP_S: 5.0,        // chop spans [HOLD_S, CHOP_S) = 3.0 s
    FEED_S: 9.0,        // feed spans [CHOP_S, FEED_S) = 4.0 s; chunks stream in here
    CHUNK_COUNT: 5,     // pieces the catch is chopped into (visual + CHUNK events)
    // Back-compat: the total window length (was the only field pre-staging). Any
    // reader expecting "the furnace window elapsed" still gets the right total.
    get DURATION_S() { return this.FEED_S; },
    // ── Cargo-continuity S8 (2026-08-13): digestion on the TRANSIT clock ──
    // The staged hold/chop/feed timeline above stays as the ANIMATION; its
    // progress is driven by a slow per-piece digestion clock, not the 9 s
    // stateTimer window:
    //   span per piece = clamp(massKg × S_PER_KG, MIN_S, MAX_S)  (game-seconds)
    //   phase time t   = (progress / span) × FEED_S   — same fractions, same
    //   chunk cadence; the timeline code is unchanged.
    // Physics anchor (owner design review 2026-08-13): melting metal costs
    // ~1 MJ/kg. The mother's 2 kW panels need ~8 min/kg — electric cooking is
    // practical for small pieces only. A net-mouth-sized solar concentrator
    // (~50 m² → ~50 kW thermal) gives 20 game-s/kg. Progress accrues at
    // dt × TIME_SCALE_GAMEPLAY whenever the world ticks (full rate flying,
    // 0.1× crawl in menu/shop backgrounds — the world itself runs at 0.1×
    // there), scaled by sun: 1.0 in sunlight, ECLIPSE_RATE in eclipse (the
    // panel:concentrator ratio ≈ 2 kW / 50 kW — an ember trickle that finishes
    // shards but barely moves stages; "small = electric, large = solar").
    TRANSIT_DIGEST_S_PER_KG: 20,  // game-seconds per kg (50 kW thermal ÷ ~1 MJ/kg)
    TRANSIT_DIGEST_MIN_S: 60,     // floor — even a shard takes a beat (6 wall-s)
    TRANSIT_DIGEST_MAX_S: 20000,  // pacing cap — biggest transferable piece ≈ 30 wall-min of sun
    TRANSIT_DIGEST_ECLIPSE_RATE: 0.04,  // eclipse trickle = panel/concentrator ratio
    // Register item 48: the span law's ONE home (was mirrored in-line by both
    // timeline owners — ArmUnit._updateHoldingCatch and
    // CaptureNetSystem._tickCollarDigestion — and by every test's spanFor; the
    // HUD readout would have been a third home). Values byte-identical to the
    // pre-extraction in-line clamp. The HUD cook readouts divide
    // `_digestProgress` by this — one law, one computation.
    digestSpanS(massKg) {
      return Math.min(this.TRANSIT_DIGEST_MAX_S,
        Math.max(this.TRANSIT_DIGEST_MIN_S,
          (massKg || 0) * this.TRANSIT_DIGEST_S_PER_KG));
    },
    // Small-catch plan W3 (2026-08-25): the chop's scale-out ramp — the ONE
    // home (the digestSpanS precedent). Was mirrored in-line by both pin
    // writers (ArmManager's rack loop and CaptureNet._tickCollarDigestion),
    // and the collar-bag deflation (CaptureNetVisual) would have been a third
    // copy — three homes for one ramp is how the bag and the catch drift
    // apart mid-chop. Values byte-identical to the pre-extraction in-line
    // expression: 1 at/before HOLD_S, easing linearly to the 0.001 floor at
    // CHOP_S (never 0 — a zero instance scale corrupts the matrix).
    // @param {number} phaseT — progress-derived phase time on [0, FEED_S]
    //   (arm._digestPhaseT / net._digestPhaseT; callers may fall back to
    //   stateTimer for legacy mocks)
    // @returns {number} instance-scale multiplier in (0.001 … 1]
    chopScaleMul(phaseT) {
      const span = Math.max(1e-6, this.CHOP_S - this.HOLD_S);
      const frac = Math.min(1, Math.max(0, ((phaseT || 0) - this.HOLD_S) / span));
      return Math.max(0.001, 1 - frac);
    },
  },

  // Tool-selection HUD constants (DAUGHTER_MULTITOOL_SPEC §4.1).
  TOOL_HUD: {
    PANEL_WIDTH_PX:    180,
    HIGHLIGHT_COLOR:   '#ffd166',          // selected (▶)
    // ── Capture Odds Strip (capture-feedback overhaul Phase 1b) ──
    COL_WIDTH_PX:      48,                 // fixed columns in cycle order
    ODDS_FONT_PX:      14,                 // the % is the hero
    LABEL_FONT_PX:     9,                  // names are footnotes
    BLOCKER_FONT_PX:   8,                  // red blocker word under a 0% column
    COLOR_GOOD:        '#00ffaa',          // ≥ 80%
    COLOR_MID:         '#ffd166',          // 50-79%
    COLOR_LOW:         '#ff7755',          // 1-49%
    COLOR_ZERO:        'rgba(180,200,210,0.45)', // 0% / -- (dim grey)
    COLOR_BLOCKER:     '#ff5555',          // blocker word
  },

  // Unified live tool-odds model (capture-feedback overhaul Phase 1a).
  // ToolOdds.js is the SSOT for every % the HUD shows; same pure fns as the
  // resolve rolls ("honest numbers").
  TOOL_ODDS: {
    REFRESH_HZ:           10,    // arm._toolOdds recompute rate during STATION_KEEP
    DISPLAY_LERP_S:       0.3,   // displayed % eases toward truth (count-up feedback)
    RECOMMEND_MARGIN:     0.15,  // RELATIVE margin: a later-preference tool takes ▶ only when p > best × (1 + this)
    SWITCH_ADVISE_MARGIN: 0.20,  // advisory offers a switch when another tool beats selected by this
    TREND_RATE_PER_S:     0.02,  // |Δp|/s above which the ↑/↓ trend arrow shows
    DISPLAY_CAP:          0.99,  // sure-shots show 99%, never a lying 100%
    FRAG_CHIP_MIN:        0.10,  // FRAG chip renders at/above this risk
  },

  // Debris Dossier — progressive reveal "treasure chest" data
  // (capture-feedback overhaul Phase 1.5). The reticle is for ACTING; the
  // dossier pane (DebrisWireframe) is for KNOWING.
  DOSSIER: {
    DETAIL_SCAN_RANGE_M:    50,    // hold a platform within this of the target…
    SURVEY_TIME_S:          3.0,   // …for this long → automatic close-range survey
    SURVEY_BOUNTY:          75,    // credits paid ONCE per debris on first full profile
    WIREFRAME_TRACE_S:      1.0,   // scanned silhouette draw-on duration
    PROFILE_ROW_INTERVAL_S: 0.35,  // Full Profile typewriter: one row per interval
    // Salvage appraisal — credit value per unit for the decrypted manifest.
    SALVAGE_VALUES: {
      XENON_PER_KG:     400,   // ion fuel
      INDIUM_PER_KG:    2000,  // FEEP fuel (carried in small kg fractions)
      GAAS_PER_FRAC:    1500,  // per 100% panel-repair equivalent
      BATTERY_PER_WH:   2,
      HYDRAZINE_PER_KG: 60,    // hazmat — paid, but poorly
      LITHIUM_PER_UNIT: 150,   // MPD fuel
      METAL_BASE:       200,   // per salvageable metal species
    },
  },

  // Shop / depot tuning (first-credit legibility + early-shop tension plan).
  SHOP: {
    // First-depot affordability floor. On the true first depot visit only
    // (gated by the FIRST_DEPOT_VISITED ceremony flag), a one-time on-theme
    // "first cleanup contract settled" bonus tops the wallet UP TO this floor
    // if below it — enough for one 500 starter, not two and not the 800 net.
    FIRST_DEPOT_FLOOR: 600,
    // Single source of truth for the full non-consumable upgrade catalog value
    // (Σ cost×maxLevel over UPGRADES). Used by the capture-credits taper and the
    // shop-pacing guardrail test, which asserts this equals the computed sum so
    // it can never silently drift when the catalog changes.
    // Register item 101 (2026-08-21): 46 400 → 42 800 — the legacy tether cards
    // (long_tether 600 + gsl_tether_v4 3 000) retired from the catalog; the
    // tether tier ladder is the one reach track. Re-derived on the SSOT pin's
    // own sanctioned path (test-shop-pacing computes Σ UPGRADES live).
    // P2 flower hardware (2026-08-27): 42 800 → 45 000 — category #9
    // "Thermal & Services" opens with the aft-flower pair rows
    // (flower_pair_a 1 200 + flower_pair_b 1 000; placeholder economy-pass
    // prices per the charter). Same sanctioned path: the pacing test computes
    // Σ UPGRADES live and this pin re-derives with it.
    // g1-gas-upgrades (2026-10-16): 45 000 → 47 130 — the one-way gas rows gas_krypton 920 + gas_xenon 1 210
    // (priced by launch mass, ResourceSystem.gasPriceCr). The gas resupply is a consumable and is excluded,
    // like mother_net_restock.
    // Reaction-wheel kit (2026-10-24): 47 130 → 47 930 — the one card reaction_wheels 800 (Constants.WHEELS.PRICE_CR; owner 10-24).
    CATALOG_TOTAL_CR: 47930,
    // Ordered recommendation preference for the starter highlight. The shop
    // marks the first item here that is un-owned and currently affordable.
    RECOMMENDED_STARTERS: ['capture_net', 'fast_reel', 'enhanced_eo', 'efficient_ion'],
  },

  // Orientation-based capture (capture-feedback overhaul Phase 2).
  // Elongated debris presents a different width depending on the approach
  // angle: broadside = lengthM (often un-nettable), end-on = widthM (the 5 m
  // mouth swallows a 2 m cross-section lengthwise). Gated by
  // FEATURE_FLAGS.ASPECT_CAPTURE.
  ASPECT_CAPTURE: {
    // length:width ratio per procedural debris type (2a). 1.0 = symmetric.
    ASPECT_BY_TYPE: {
      rocketBody:    3.5,
      defunctSat:    1.6,
      fragment:      1.0,
      missionDebris: 1.0,
      cubesat:       1.1,
    },
    // Local long axis per type (matches DebrisWireframe geometry):
    // rocketBody = lathe around Y; defunctSat = solar wings along X;
    // cubesat = slightly long along Z (stacked-U body).
    LONG_AXIS_BY_TYPE: {
      rocketBody: { x: 0, y: 1, z: 0 },
      defunctSat: { x: 1, y: 0, z: 0 },
      cubesat:    { x: 0, y: 0, z: 1 },
    },
    // HUD: the END-ON ✓ chip shows when presented width fits with this margin.
    END_ON_FIT_MARGIN: 1.0,
  },

  // Player reel-speed control (capture-feedback overhaul Phase 3a).
  // Hold Shift during REELING for BOOST ×2 — saves time, raises tension
  // (∝ reelSpeed²) toward the NET-RIP and TETHER-SNAP thresholds. Nominal
  // reel stays risk-free for in-spec catches, so cautious play is never
  // punished.
  REEL_BOOST: {
    SPEED_MULT:        2.0,   // boosted reel speed multiplier (tension target doubles too)
    TENSION_EASE_TAU_S: 0.4,  // boosted tension eases toward target — the bar visibly
                              //   climbs into the red, giving time to release Shift
    RIP_PROB_PER_S:    0.10,  // per-second net-rip chance at 100% rated mass while
                              //   boosting (linear from NET_STRAIN_SAFE_FRACTION;
                              //   recoverable — reuses the strain-slip path)
  },

  // ── Reel-in / re-dock inertia overhaul (FEATURE_FLAGS.REEL_PROFILE_V2) ──────
  // See plan reel-in-redock-inertia.md. All speeds are game-scale m/s applied
  // over REAL dt (matching the legacy REELING convention; NOT game-time).

  // Q1 — Daughter reel-in trapezoidal velocity profile (accel → cruise → decel).
  // Replaces the constant REEL_IN_SPEED_* haul speed when the flag is ON; the
  // legacy constants are retained as the V_DOCK-band fallback / test-mock compat.
  REEL_PROFILE: {
    V_CRUISE_MAX:        60,    // m/s — cruise cap (empty / light catch)
    V_DOCK:              1.0,   // m/s — gentle speed entering the soft-dock window
    ACCEL:               3.4,   // m/s² — ramp-down magnitude: sets the recall speed from 50 m / 200 m
                                //   (decel bound √(1+2·a·d), below the 60 m/s cap there). Was 8.0;
                                //   3.4 makes a recall ~1.5× slower (owner 2026-10-16: "a little
                                //   slower would be realistic"; lane arms-default).
    DECEL_DISTANCE_M:    15,    // m — begin ramp-down within this of the strut dock
    HAUL_MOTOR_POWER:    2500,  // sets v_cruise = POWER / max(T_reel, T_MIN)
    T_MIN:               5,     // N — denominator floor so light catches hit V_CRUISE_MAX
    CRUISE_TENSION_FRACTION: 0.85, // cap cruise so T_reel ≤ break×this (snap invariant:
                                   //   any in-spec catch stays under the tether break strength)
    BOOST_LOCKOUT_IN_DECEL: true, // disable REEL_BOOST inside DECEL_DISTANCE_M
    // reel-gas (owner 2026-10-21, DECISIONS §REEL-IN PHYSICS): under REEL_HOME the reel PULLS HER UP to speed at this rate
    // (no jump from 0 to peak), then cruises, then brakes on her cold-gas jet (DAUGHTER_COLD_GAS) at min(ACCEL, jet / MARGIN).
    // Game-scale m/s per REAL s (true accel = /100: 10 -> 0.1 m/s^2; a 27 kg catch then pulls ~2.7 N, far under the 100 N line).
    // The legacy path (REEL_HOME off, detached arms) never reads it. (est)
    PULL_ACCEL:          10,
  },

  // reel-gas (owner 2026-10-21: "Add a gas jet": "A small gas jet on each daughter, refilled from the mother's gas at the
  // strut. She comes in about as fast as today and brakes in the last 15 m."). A cold-gas (N2) thruster on each daughter, aft
  // (-Z, which faces the mother on the tail-first reel). It brakes the reel-home haul (ArmUnit._rhReelStep); the mother's
  // `coldGas` refills the bottle while she is docked (ArmUnit._updateColdGasRefill). Values marked (est) are estimates the
  // owner may veto. Tests: js/test/test-ReelGas.js.
  DAUGHTER_COLD_GAS: {
    THRUST_N:   { weaver: 1.0, spinner: 0.5 },   // N (est) - jet thrust; her FEEP ion thruster stays 1.28 / 0.8 mN (ION_THRUSTER)
    ISP_S:      60,                              // s - same as the mother's cold-gas thrusters (CROSSBOW_ARMS.md)
    BOTTLE_KG:  { weaver: 0.5, spinner: 0.2 },   // kg (est) - starts full; the gas counts in her reel mass
    REFILL_KG_PER_GAME_S: 0.01,                  // kg per GAME second (x10 per real second) from the mother's coldGas, docked only
    MARGIN:     1.2,                             // the jet pushes MARGIN x what braking needs, the reel holds the rest (and the gas bill is MARGIN x)
    EMPTY_KG:   1e-5,                            // kg - below this the bottle is empty: no jet, her ion thruster is the only brake
  },

  // Nets step 3 lane 3f (owner 2026-10-23, "Cold gas and ion fuel"; DECISIONS §4 docked servicing, §34 rows 5 and 10): what the
  // resupply satellite sells for the daughters. A nitrogen buy fills the mother's cold-gas tank (which tops up docked daughters,
  // §34 row 5). An ion-fuel cartridge (cast indium: a cartridge, never a fluid, §4) is handed over by the satellite's arm into the
  // mother's indium store; a docked daughter swaps cartridges with it over SWAP_GAME_S. Values marked (est) are the coordinator's
  // estimates the owner may veto. Prices follow "mass is money" (§2b): (LAUNCH_USD_PER_KG + the commodity's USD per kg) per kg,
  // like gasPriceCr. Tests: js/test/test-DaughterSupply.js.
  DAUGHTER_SUPPLY: {
    N2_BUY_KG: 5,                  // kg of nitrogen per buy (the same load as the engine gas buy, GAS_RESUPPLY_KG)
    N2_USD_PER_KG: 5,              // USD per kg of high-purity nitrogen (est); a named constant of its own, never an entry in FUELS
    INDIUM_CARTRIDGE_KG: 0.15,     // kg of indium in one cartridge = one large daughter's full FEEP tank (INDIUM_FULL_TANK_WEAVER, pinned equal)
    INDIUM_USD_PER_KG: 350,        // USD per kg of indium metal (est, a recent market price)
    INDIUM_STORE_MAX_KG: 0.6,      // kg: the mother's indium store holds four cartridges (est); a new run starts it EMPTY
    SWAP_GAME_S: 30,               // game seconds a docked cartridge swap takes (est; the same time base as the cold-gas refill, so 3 real s)
  },

  // reel-home (2026-10-19, FEATURE_FLAGS.REEL_HOME, owner design): a daughter's catch comes home on reels. No jump at net
  // close: her net winds the catch to its rack cell on her nose (NET only, no fuel, centre of mass kept:
  // ArmUnit._rhNetReelStep). Then REELING goes TAIL FIRST (no winding while she is more than TAIL_FIRST_TOL_DEG off), her
  // strut follows her (STRUT_MIN..MAX_DEG, _aimReserved: ArmManager._updateReelHome) and the mother turns to put the line
  // in the strut's swing plane, and her angle inside the strut's range, when nothing limits her
  // (_motherTurnBlock(exceptArm)). At ALIGN_DIST_M a line more than ALIGN_TOL_DEG off the strut axis holds the reel; after
  // ALIGN_WAIT_S she lines herself up on her thrusters (mass-scaled fuel, ARM_RESERVE_FUEL included: it is kept for a safe
  // reel-home), else she holds for the mother and looks again every second. DOCKING no longer flips her or bills thruster
  // fuel; a catch already in its cell has no glide. reel-gas (owner 2026-10-20/21) SUPERSEDES the old "no thruster fires on
  // the reel": the strut reel is a sim now - her aft ion thread keeps the line tight (a tiny billed FEEP cost), the reel pulls
  // her up (REEL_PROFILE.PULL_ACCEL) and she brakes on her cold-gas jet (DAUGHTER_COLD_GAS); only the 2 m line-up is her own
  // fore burn. Tests: js/test/test-ReelHome.js, test-ReelGas.js. Values marked (est) are estimates, not measurements.
  REEL_HOME: {
    NET_REEL_MPS:        0.5,   // m/s (est) — her net winds the catch in to her nose at this CLOSING speed (line shortening)
    TAIL_FIRST_TOL_DEG:  10,    // the strut reel does not wind until her -Z points at the strut tip within this
    STRUT_MIN_DEG:       34,    // strut angle floor while she is hauled home (measured: 0° scrapes hull and radiators)
    STRUT_MAX_DEG:       180,   // strut angle ceiling
    PLANE_TOL_DEG:       5,     // she is "in the strut's plane" within this; beyond it the mother turns, and the turn ends inside half of it (reel-turn: closed loop, test-ReelTurnSettle.js)
    ALIGN_DIST_M:        2.0,   // m from the strut tip: the line-up check and hold
    ALIGN_TOL_DEG:       10,    // the line (tip -> her) must be within this of the strut axis to go on in
    ALIGN_WAIT_S:        5,     // s the mother gets to line her up before she uses her own thrusters
    ALIGN_SPEED_MPS:     0.5,   // m/s (est) — her own line-up speed on the circle round the tip
    ALIGN_CLEAR_M:       0.15,  // m — the line-up arc stays this far off the ship (keep-out query)
    ARRIVE_TOL_DEG:      0.5,   // the catch is brought on to her axis only once her nose is this close to the line
    TURN_RETRY_S:        1.0,   // s between mother-turn requests for one reel (D11a: was a lifetime cap of 6 requests; a refusal counts too)
    TURN_MAX_DEG:        60,    // a mother turn bigger than this is not asked for (she lines herself up instead); a running plane turn stops when more than this is left (her lever on the axis is gone)
  },

  // reel-hold (owner 2026-10-23: a daughter waits out until the floor turn is done and the radiators are clear). One rule:
  // while any radiator wing is between BAND_LO and BAND_HI, no docked daughter holding a catch is below LIFT_DEG and no reeling
  // daughter with a catch is inside HOLD_M of her strut tip; and no daughter comes inside HOLD_M while her approach is short of
  // the 34 deg floor (REEL_HOME.STRUT_MIN_DEG) by more than REEL_HOME.PLANE_TOL_DEG with a mother turn running or askable.
  // Measured 2026-10-23 (tmp/plans/reel-hold.md T0/T1, real meshes, exact point-to-triangle): a 0.95 m catch on a 34 deg strut
  // touches a wing at 75-90 deg and is under 0.15 m at 75-100 deg (at 69 deg: >= 0.41 m); the last 5 m of a reel with a catch is
  // 0.00 m from a wing at 60-110 deg; a bare daughter is >= 0.25 m. ArmUnit._rhReelStep (the hold brakes to rest),
  // ArmManager.reelHoldReason / radiatorBandBlocked, PlayerSatellite._updateFlower (the wings wait at the band's edge).
  // Tests: js/test/test-ReelHold.js.
  REEL_HOLD: {
    HOLD_M:        5,      // m from her strut tip: the reel stops her here (at rest) while there is a reason; no catch comes inside
    BAND_LO_DEG:   45,     // wing angles (deg) a catch near the hull is not clear of: the radiators wait before this edge ... (T1: 0 of 1408 catches bad at 45, 16 bad at 50)
    BAND_HI_DEG:   130,    // ... and before this one (a wing already inside keeps moving: leaving is the safe way). hold-clear round 1 F1: was 115. Measured on 3520 configs (2112 random attitudes + the 1408 grid), net refusals + 'never' fall 425 (115) -> 268 (130) -> 175 (145) as the edge rises, because the angles above 115 move from the set her hold pose must clear to the set her lift must clear. 145 is NOT shipped (coordinator 2026-10-24): it reaches into 133-146, where the wings stand or carry in normal play (park 135, tip cargo 134-146, CARRY.OTHERS_RANGES_DEG), so a C hand-off lifted the neighbour holder mid-carry; 130 is the highest edge below them.
    LIFT_DEG:      69,     // a holder lifts her catch to at least this while the wings move (the carry's measured-clear angle)
    // T1 (tmp/rh/band.md, real meshes: 11 shapes x 8 sizes x arms 0/1 x 8 rack attitudes = 1408, wings 0-180 per 5 deg): the lowest strut
    // angle at which EVERY catch of that size (worst of all types and attitudes) is CLEAR_M off every wing in the band and plume-clear.
    // [max catch size m, deg]. 13 of the 1408 (sizes 3-5 m, rocket bodies / mission debris at rack attitudes 4-5) have no clear pose up to
    // 100 deg: they are lifted to 100 like their size (coordinator 2026-10-23: worst case per size; a size table cannot name them without
    // shutting the radiators for every big catch). A real 'never' is only a pose that is plume-blocked at every angle (`_radClearPose`).
    CLEAR_ROWS:    [[1, 69], [1.5, 84], [2, 94], [3, 99], [Infinity, 100]],
    CLEAR_M:       0.158,  // m: the carry gate's clearance line; a pose whose catch comes nearer than this to a wing in the band is not clear
    FLOOR_LINE_S:  3,      // s held before the "waits 5 m out until the mother has turned" line is said
    WAIT_CAP_S:    20,     // s the radiators wait for a holder before the move is dropped (with a line): never an endless wait
    FLOOR_CAP_S:   30,     // s a floor hold lasts at most: then she comes in as before the hold existed
    STOP_TOL_M:    0.25,   // m: a reeler this much inside HOLD_M counts as "inside" for the wings (a held one never does)
    SLACK_M:       0.25,   // m: she brakes to rest this far short of HOLD_M (the strut tip moves toward her while the mother turns), so she is never stopped dead at the point
    REST_TOL_M:    0.1,    // m: she counts as "resting at the hold point" within SLACK_M + this (at < 0.01 m/s): the hold's timer, its cap and its lines run only then
  },

  // hold-clear (owner 2026-10-23: "a held catch never touches a radiator wing"): HoldWingClear.js judges every daughter's held catch,
  // from its real mesh and its frozen attitude, against the radiator parts (REEL_HOLD.CLEAR_M off every part, REEL_HOLD.BAND_*
  // for the band). Numbers measured in tmp/plans/hold-clear.md T1 (this block's Log lines carry the sources); ArmManager,
  // CoMCalculator.suggestCargoArm and HoldWingClear read them.
  HOLD_CLEAR: {
    ENABLED:        true,                 // false = today's plume-only hold pose everywhere (the pre-wing tests pin the plume / net / band rules with it off)
    REST_STEP_DEG:  5,                    // sampling step of the wing angles outside the band (0 .. BAND_LO and BAND_HI .. 180; both band edges, 180 and the stands below are always in)
    REST_STAND_DEG: [0, 135, 146, 180],   // the angles the wings stand at outside the band (closed/launch 0, park 135, open 146, vent 180: THERMAL.FLOWER)
    REST_MARGIN_M:  0.01,                 // m added to REEL_HOLD.CLEAR_M for the rest check: the angles are sampled, the wings sweep (round 1 F1: 5° steps need <= 0.005 m, twice that is set)
    BAND_STEP_DEG:  3,                    // sampling step of the band (REEL_HOLD.BAND_LO_DEG .. BAND_HI_DEG, both edges in)
    BAND_MARGIN_M:  0.01,                 // m added to REEL_HOLD.CLEAR_M for the band check (round 1 F1: 3° steps need <= 0.005 m, twice that is set)
    UNITS_PER_FRAME: 150000,              // work points one frame may run (HoldWingClear: 1 point is about 10 ns of distance-query work; T1 calibrates)
    CELL_M:         0.25,                 // m: cell of the radiator triangle grid
    SIMPLIFY_TRIS:  12,                   // a radiator part finer than this many triangles is replaced by its bounding box (it contains it)
    LEAF_M:         0.02,                 // m: a piece of a catch surface this small that is still not provably clear counts as blocked
    BALL_CAP_POINTS: 40000,               // work points the whole-piece pre-test (one big ball query) may spend before the exact way takes over: bounds a frame's overrun
    MAX_QUERIES:    6000,                 // distance queries one pose may spend on one grid before the rest of it counts as blocked
    SPLIT_M:        0.3,                  // m: the catch's triangles are cut to this size once, before the pose loop
    MAX_HOLD_REACH_M: 4.5,                // m: a mother-net catch of more reach than this goes to no daughter (T1: 2608 configs, 6..12 m included; the smallest reach with no wing-clear hold pose is 4.519 m, missionDebris 8 m; every catch up to 4.5 m has one)
    PENDING_FORCE_POINTS: 10000000,       // the most work points a press spends finishing her pending profiles itself, ALL of them together (T1: 3.5-6 ns per point = 35-60 ms); round 1 F3: counted as work actually done (the old estimate was 3-6x low); what is left stays pending, the press says she is still stowing
  },

  // fail-reel (owner 2026-10-21, DECISIONS: a failed catch winds her home): when a catch fails (pad bounce, net miss, slip,
  // rip) under REEL_HOME, a daughter within AUTO_REEL_MAX_M of her strut tip is reeled straight home on her strut line;
  // farther out she holds near the piece for a retry and the comms line gives the reel-in time, so he can choose
  // (owner 12:37Z: "auto reel-in on failure for close debris. over 500 meters, consider retry versus reel-in time").
  // 2026-10-22 (owner, play feedback): "yes, straight home ... maybe <200 meters?" -> 200 m; the line says what happened,
  // the distance and the time. Reel times (probe, weaver/spinner, no catch): see tmp/plans/feedback-1022.md Log (B5).
  // Tests: js/test/test-FailReel.js, test-ReelView.js.
  FAIL_REEL: {
    AUTO_REEL_MAX_M: 200,   // m from her strut tip (owner 2026-10-22; was 500)
  },

  // trip-melt-2 "carry" (2026-10-19, owner: catches "need to be melted down in the furnace during the long ion burn";
  // DECISIONS §29 row 4): while the trip burns a daughter carries the catch on her rack to HER radiator's tip furnace and
  // comes home (ArmUnit CARRY_PREP/OUT/HANDOFF/BACK, ArmManager.requestCarry, TransferTrip's once-a-second scheduler).
  // The pose of each carry (strut angle, radiator angle) and whether a size row may be carried at all come from the
  // measured gate table below (GATE); everything else is a number the coordinator chose (est).
  // Tests: js/test/test-TripCarry.js.
  CARRY: {
    PAYOUT_MPS:        0.2,    // m/s (est) — the flight speed (smoothstep ends); her strut line pays out and winds in at this speed
    CLAMP_S:           1.5,    // s — the clamp release before CARRY_OUT moves (the LAUNCHING clamp's length)
    HANDOFF_S:         1.0,    // s (est) — the beat at the tip once the bag is seated, before CARRY_BACK starts
    STRUT_ARRIVE_DEG:  0.05,   // CARRY_PREP's strut is over when it is this close to the carry angle: the carry re-arms the strut's target until it lands EXACTLY (the driver alone stops 0.57° short), and the gate is certified for this tolerance (js/test/_carryGate.js STRUT_ARRIVE_DEG)
    THETA_ARRIVE_DEG:  0.01,   // ... and her petal this close to the carry angle (it lands exactly: PlayerSatellite._stepPetalHolds)
    // petal-single (Decisions 4, 7): the carry is certified for the other three petals standing anywhere in these shared-angle
    // ranges (closed, or open - 146°, or lower when a bag on a tip caps it: TipCargo TIP_BAND 134..146 less the 0.57° settle) and for the other three
    // struts within NEIGHBOUR_TOL_DEG of NEIGHBOUR_REST_DEG (the strut driver stops within 0.01 rad of its target). A carry
    // outside them waits (it is not a give-up). STRUT_REC_*: the recorded strut angles the strut sweep was certified for.
    OTHERS_RANGES_DEG: [[0, 1], [133, 146]],
    NEIGHBOUR_REST_DEG: 34,
    NEIGHBOUR_TOL_DEG:  0.6,
    // hold-catch FA3 (2026-10-22): the gate above was measured with the other three daughters EMPTY at the rest angle. A neighbour
    // holding a catch stands at her hold pose with the catch on her nose, and a carry now also accepts that (a neighbour within
    // NEIGHBOUR_TOL_DEG of her own hold pose, `ArmManager.holdPoseFor`). The whole carry path (strut sweep, flight, swing back, petal
    // sweep) was measured against such a neighbour at her REAL hold pose, 10 722 cases: every catch shape (11) x size x rack attitude
    // (js/test/_carryNeighbour.js, test-HoldCatchNeighbour.js; the table is in the plan Log). The line is the gate's, 0.158 m.
    //   - catches up to 1.5 m (0.3, 1, 1.25, 1.5 m; all 30 attitudes): never closer than 0.218 m. The first failure is a 1.75 m rocket
    //     body (0.123 m); 2 m catches fail in 24 of 1 344 cases at 34° (down to 0.062 m); 155 of 10 722 cases fail in all.
    //   - catches over 2 m stand at 34-59° and fail in a few per cent of the shape x attitude cases (to a touch); they stand at 64° and up
    //     clear: 0 of 461 cases fail from 64° up (0.195 m at 64°, 0.31 m at 69° and up; 2.8-5 m).
    // hold-clear round 1 F2 (2026-10-24): the radiator-wing rule raises a hold pose (BAND_HI_DEG 130: 1103 of 3520 configs - 2112 random attitudes + the
    // 1408 grid - by 5-40°), so the figures above, taken at the plume poses, were taken again at the NEW pose of every raised catch, against all three
    // other carriers (3309 full measurements: tmp/f2-nb.mjs, plan Log): catches <= 1.5 m (stand at 39° or 44°): 372, none below the line, the worst
    // +0.229 m over it; catches over 1.5 m at 69° and up: 216, none below, +0.154 m; over 1.5 m below 69°: 2721, 4 below (down to -0.121 m) - those the rule
    // below already refuses and lifts, so no pass exists for a pose that was not measured. The lift poses of a neighbour are unchanged in all 1103.
    // A neighbour holding a catch that passes neither test blocks the carry ('neighbour-catch'; it clears when that catch goes).
    NEIGHBOUR_CATCH_MAX_SIZE_M: 1.5,
    NEIGHBOUR_CATCH_HIGH_POSE_DEG: 69,     // a neighbour standing at/above this angle (measured clear with margin) ...
    NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M: 5,    // ... may hold any catch up to this size (the biggest measured)
    STRUT_REC_LO_DEG:   34,
    STRUT_REC_HI_DEG:   180,
    THETA_MAX_DEG:      133,   // no gate entry holds her petal higher: the tip band (>= 133.4°) would push it down mid-carry
    MISSION_CHECK_S:    1.0,   // s of game time between two looks of the mission carry scheduler (ArmManager; the trip has its own, CHECK_S)
    PREP_MAX_S:        40,     // s (est) — a prep that has not arrived by now gives up: she stays docked, one comms line
    CHECK_S:           1.0,    // real seconds between two looks of the trip's carry scheduler
    FINISH_GRACE_S:    60,     // real seconds past TRIP.MAX_REAL_S an in-flight carry gets to finish; then it is aborted
    CLEAR_M:           0.15,   // m — the clearance the gate table was measured to (js/test/_carryGate.js CLEAR_M)
    OWN_STRUT_FREE_M:  0.4,    // m — the gate was measured with her own strut not counted for the first 0.4 m of the flight (plan: 0.3; she is leaving its tip collar)
    OWN_TIP_FREE_M:    0.4,    // m — ... and, for the last 0.4 m, the DELIVERED catch alone is not counted against the receiving tip's pad, stalk and cone (it is seated against them); her body, her strut and her other catch keep CLEAR_M to the whole radiator (Decision 7a)
    SEAT_CLEAR_M:      0.10,   // m — in that last 0.4 m the DELIVERED catch keeps this (not CLEAR_M) to the rest of the receiving petal: seated against the cone it is 0.12-0.19 m from the boom end whatever she does (measured, js/test/_carryGate.js OWN_TIP_SEAT_CLEAR_M; DEVIATION from Decision 7a)
    // The measured gate table (Decision 5; petal-single: one swinging petal and a TURNING flight), generated offline:
    // `node scripts/probes/carry-gate-gen.mjs --all` (js/test/_carryGate.js: exact point-to-triangle clearance on the real ship,
    // 30 fixed attitudes, every shape of the size row, BOTH daughters of the pair, every certified shared angle of the other
    // petals) -> js/test/fixtures/carry-gate.json; this block is `node scripts/probes/carry-gate-to-constants.mjs` of that file
    // and test-TripCarryGate.js pins the two equal. Key '<size row>|<delivered rack cell>' (rows = PLUME_CARGO_ALPHA_LADDER:
    // 0 = up to 0.5 m, 1 = up to 1.5 m; the larger rows hold no catch that fits a tip). strutDeg / thetaDeg = her strut and HER
    // petal at the seat; dir = how her body trails while she seats the catch (ArmDockBasis carryDirInto: 0 = along the boom
    // outward). A missing key = no pose clears the line for that row (the daughter keeps the catch, one comms line). Pair = the
    // body type (weaver: 64 and 244 deg; spinner: 116 and 296 deg). Generated 2026-10-20, run times in the plan Log.
    // 2026-10-23 roll-90 (hinge roll above strut 90 deg): weaver 130/30 re-verified (min 0.1585 m); spinner regenerated
    // exhaustively (571 candidates tried): 124/34 -> 126/36 (min 0.1581 m, flight 1.104 m, swing-back closed 0.282 -> 0.263 m).
    // Result: only row 0 (catch up to 0.5 m), cell 0 (one catch on the rack) has a pose, for both pairs; the other six entries
    // (row 1, and cell 1 = a second catch on the rack) were searched exhaustively and none passes: those catches stay on the rack.
    // swingBackReachM (review R8): the way BACK, with the catch in the tip bag - the largest catch reach (m, `DebrisField.trueReachM`)
    // whose petal swing back keeps 0.15 m to the ship, her strut and her body, per shared angle of the radiators: closed
    // (0-1 deg) or open (133-146 deg). A bigger catch waits for the other range (ArmManager.carryCheck 'swing-back').
    GATE: {
      weaver: { '0|0': { strutDeg: 130, thetaDeg: 30, dir: 0, swingBackReachM: { closed: 0.229, open: 0.649 } } },
      spinner: { '0|0': { strutDeg: 126, thetaDeg: 36, dir: 0, swingBackReachM: { closed: 0.263, open: 0.75 } } },
    },

    // u20-nose (2026-10-23; owner 01:55Z "yes, can hand debris from daughter to mother nose"; 12:55Z "Nose route for longer catches"):
    // a catch the direct carry never takes (longer than 0.5 m: no GATE row) goes the other way round: the daughter flies it from her strut tip
    // to the mother's nose collar, the nose adopts it (CaptureNet.adoptDaughterCatch), she flies home body only, and the leash takes it on to a
    // free tip (the mother-catch path). Measured in scripts/probes/nose-handoff-path.mjs, nothing here is a guess unless marked (est);
    // docs/research/2026-10-nose-handoff.md ("As built" and "Her line, measured") has the run lines. The route itself is ONE function,
    // js/entities/NoseRoute.js (game and probe), so what flies is what was certified. Tests: js/test/test-NoseRoute.js.
    NOSE: {
      ENABLED: true,
      STRUT_DEG:        145,    // her strut at the seat (the probe's `a145`); she swings there from her hold pose with the catch on her nose
      HOLD_DEG:         34,     // the strut angle the swing starts from (= NEIGHBOUR_REST_DEG; a catch up to 0.75 m is held at 34°, ArmManager.holdPoseFor)
      BACKOFF_M:        0.5,    // m along her strut line before she turns (no turn: her own strut is not yet clear). Measured: the 0.75 m container and 0.75 m bag pass at 0.5 (a longer one changes nothing: the own-strut reading sits at the 0.4 m free mark)
      STANDOFF_M:       1.4,    // m: the stand-off height above the seat (the probe's `s1.4`)
      STANDOFF_MIN_Z_M: 3.227,  // m: the stand-off height is never lower than this (the 0.5 m catch's own: 1.827 + 1.4), the `nose-high` route: the plain route failed 0.30 m catches (164/330)
      TRAIL_DEG:        30,     // her body trails up the axis tilted this far to the side (the probe's `tan30`)
      MAX_REACH_M:      0.75,   // m: TipCargo.fits (a tip takes a bag up to 0.75 m); also the biggest catch a NEIGHBOUR may hold (measured clear: rocket body, reach 0.75)
      NEIGHBOUR_CATCH_MAX_REACH_M: 0.75,
      // Certified reach buckets (probe `--bucket R`): the route is flown for a VIRTUAL catch of the bucket's top reach (NoseRoute.js), a
      // smaller real catch goes on to its own seat (the "extension", <= 0.4 m). A catch with reach in (loM, topM] is offered the route when
      // the radiators stand in one of the bucket's windows: `windowsDeg` = [[loDeg, hiDeg, bagMaxM], ...], read by `noseRadiatorsOk`: the
      // shared angle in [lo, hi] AND no bag on any tip bigger than bagMaxM (reach, m; 0 = none on a tip). A window is the span between two
      // angles the rows were run at (<= 2 deg apart), with a bag of radius bagMaxM on all four tips where bagMaxM > 0.
      // Fix round 1 (coordinator 2026-10-23): a window is offered only where it was run. u22-nose-tipbags (2026-10-24): a bag on a tip caps
      // the radiators (TipCargo.TIP_BAND) and nothing moves them back, so the windows must cover the angles the cap holds them at; the rows
      // are in docs/research/2026-10-nose-tipbags.md (commands and pass counts); CLOSED is offered with NO bag on any tip (bagMaxM 0) in every bucket: with a bag the seat climbs with the bag's size (a 0.30 m catch, 0°: 1.620 m with a 0.15 bag, 1.759 at 0.18, 1.900 at 0.22) and the rows (0.15, 0.22, 0.32, 0.42, 0.50 only) are not monotone in the radius (the 0.30 bucket fails at 0.15, 329/330), so a window with a bag between the radii run would be unrun (fix round 1, 2026-10-24). Reaches at or below the first loM, above the last
      // topM, or in no bucket refuse in plain words; so do radiators settled outside every window ('radiators-angle', never clears by waiting).
      // Fix round 1 F3 (2026-10-24): the 134° band (bags of reach 0.60-0.75) settles at 132.86-134.00° depending on the frame step (60 Hz 134.000, 120 Hz 133.875,
      // from closed 132.9), so the three smaller buckets' lowest open window starts at 132.75 (rows at 132.75 and 133.25 all 330/330, tipbags doc §3b); the 0.75 bucket stays at 138° (134° and 136° fail 329/330).
      BUCKETS: [
        { loM: 0.27, topM: 0.30, windowsDeg: [[0, 1, 0], [132.75, 136, 0.75], [136, 138, 0.60], [138, 140, 0.50], [140, 142, 0.40], [142, 144, 0.30], [144, 146, 0.15], [145.5, 146.5, 0]] },   // route certified from reach 0.25; her line (0.03 m rule) passes from 0.27 (0.265 misses by 0.0003 m): reach 0.27 and below refuse.
        { loM: 0.30, topM: 0.50, windowsDeg: [[0, 1, 0], [132.75, 136, 0.75], [136, 138, 0.60], [138, 140, 0.50], [140, 142, 0.40], [142, 144, 0.30], [144, 146, 0.15], [145.5, 146.5, 0]] },
        { loM: 0.50, topM: 0.63, windowsDeg: [[0, 1, 0], [132.75, 136, 0.75], [136, 138, 0.60], [138, 140, 0.50], [140, 142, 0.40], [142, 144, 0.30], [144, 146, 0.15], [145.5, 146.5, 0]] },
        { loM: 0.63, topM: 0.75, windowsDeg: [[0, 1, 0], [138, 140, 0.50], [140, 142, 0.40], [142, 144, 0.30], [144, 146, 0.15], [145.5, 146.5, 0]] },   // its 134° and 136° fail 329/330 (a swing-out item at a radiator wing frame) with or without bags: from 138°
      ],
      SEAT_BEAT_S:      1.0,    // s at the seat before the checks (the carry's HANDOFF_S)
      SEAT_TOL_M:       0.06,   // m: the catch's centre must be this close to the collar axis point at the seat (the leash latch funnel, docs/research/2026-10-leash.md)
      SEAT_SPEED_MPS:   0.03,   // m/s: and at rest (the leash latch's own limit)
      TUG_M:            0.03,   // m she backs along the axis after the nose has the catch, before she lets go (2-5 cm)
      TUG_HOLD_M:       0.01,   // m: while she backs, the catch must stay this close to its seat (the nose holds it); else the hand-over is taken back (est: a latch that holds keeps it within a centimetre)
      RETRY_BACKOFF_M:  0.4,    // m a refused seat backs out along the way she came, ...
      RETRY_WAIT_S:     2.0,    // s (est) she waits there, then comes in again
      TRIES:            3,      // seat attempts; after the third she flies home holding the catch
    },
  },

  // Q3 — Stage-1 net snug-up (rigidize daughter+net+debris into one unit).
  CATCH_SNUG: {
    TENSION_TARGET_N:    8,     // N — snug pull tightening the bag to the −Y face
    SETTLE_S:            0.4,   // s — settle so the cinch impulse damps before haul
    // over-strain reuses NET_STRAIN_* + _checkNetIntegrityOnReel (recoverable rip)
  },

  // Q4 — FEEP soft re-dock (mass-scaled fuel debit; abstract model — see plan §Q4).
  REDOCK_FEEP: {
    SOFT_DOCK_VEL:       0.10,  // m/s — max |v_rel| to strut allowed at contact
    ARREST_DISTANCE_M:   8,     // m — arrest active within this of dock
    DEBIT_K:             0.0008,// fuel% per (kg·(m/s)) — tune so a hot 500 kg dock stings
    FUEL_FALLBACK_SLOW:  true,  // insufficient fuel OR no plume clearance → slow reel-only finish + warn
    MISSION1_FREE:       true,  // no debit during the learning mission
  },

  // Rev-3 — Yoke / tether-plume clearance (prerequisite for FEEP-during-reel).
  // The +Y wishbone bridle keeps the tether outside the ±Z FEEP exhaust cone;
  // ±15° beam steering is electrostatic (no moving parts, free) — the yoke's
  // job is tether-plume clearance, NOT vectoring.
  //
  // Wave2 arrest-gate reconciliation (see ArmUnit._tetherPlumeClearance):
  // MIN_TETHER_PLUME_DEG 30 is the LEGACY worst-case budget — plume half-angle
  // 20° + 10° of UNCOMMANDED vector wander (CROSSBOW_ARMS.md: "FEEP plume
  // half-angle: 20° + vectoring 10° = 30° worst case"). The Rev-3 whole-haul
  // reel attitude converges the nose ONTO the dock line (probe: 0.00° at the
  // arrest window), so a nose-referenced 30° test can never pass in production
  // dock geometry. During the arrest the vector loop is actively COMMANDED, so
  // the wander term collapses to STEER_JITTER_DEG and the requirement
  // decomposes into PLUME_HALF_ANGLE_DEG + STEER_JITTER_DEG against the
  // STEERED axis, fundable by a deliberate attitude offset + electrostatic
  // beam steer. Geometry at arrest entry (d = ARREST_DISTANCE_M 8, weaver):
  //   bridle standoff  atan(0.70·by/d) = atan(0.14/8)          ≈  1.0°
  //   arrest attitude offset ARREST_STEER_DEG                  = 15.0°
  //   commanded electrostatic steer (≤ VECTOR_ENVELOPE_DEG)    =  6.0° used
  //   total plume-axis-to-tether angle 15+1+6 = 22 = 20 + 2    ⇒ clear
  // The bridle standoff alone is ~1° at 8 m (daughters are 0.1–0.3 m craft) —
  // real, but it cannot carry the clearance; the attitude offset must.
  YOKE_CLEARANCE: {
    MIN_TETHER_PLUME_DEG:   30,   // legacy no-assist clearance (= 20° cone + 10° uncommanded wander); at/above this no steer is engaged
    REEL_ATTITUDE_SLERP:    0.1,  // slew rate to the nose-at-strut / bridle-trailing attitude
    PLUME_HALF_ANGLE_DEG:   20,   // indium FEEP exhaust cone half-angle (CROSSBOW_ARMS.md §FEEP; plan Rev-3 §1.2)
    VECTOR_ENVELOPE_DEG:    15,   // electrostatic beam-steer authority — free, no moving parts (plan Rev-3)
    STEER_JITTER_DEG:        2,   // closed-loop residual pointing error when the vector is COMMANDED (replaces the 10° open-loop wander term)
    ARREST_STEER_DEG:       15,   // deliberate arrest-window nose offset AWAY from the bridle side; thrust-along-travel loss 1−cos(15°) ≈ 3.4% is priced into the arrest debit
    ARREST_STEER_LEAD_M:     6,   // blend lead ahead of ARREST_DISTANCE_M: w(d)=clamp01(((ARREST+LEAD)−d)/LEAD) — engages at 14 m (inside DECEL_DISTANCE_M 15, so the whole maneuver lives in the braking approach), FULL at 8 m, because the one-shot gate/debit fires on the FIRST frame inside the window; a strictly-inside blend would leave the entry-frame nose un-steered and re-create the always-fouls bug. Sized 6 m so the REEL_ATTITUDE_SLERP (per-frame 0.1) still delivers enough of the offset at entry (steerNeeded ≤ VECTOR_ENVELOPE_DEG) even at ~20 fps through the ~12–14 m/s decel band.
    BRIDLE_APEX_Y_FRAC:   0.70,   // hardware SSOT: bridle gimbal apex at local (0, +0.70·by, 0) — MUST match the bridle-leg geometry in ArmUnit._createMesh (weaver by=0.2 m ⇒ 0.14 m tether standoff)
  },


  // Eddy-current detumble (capture-feedback overhaul Phase 3c).
  // MAGNET secondary: while station-keeping with MAGNET selected near a
  // CONDUCTIVE target, the EPM's rotating field induces eddy currents that
  // bleed tumble — a daughter-local detumble option independent of the
  // mother's laser (slower, shorter-ranged; no new key).
  EDDY_DAMP: {
    RANGE_M:             30,     // must hold standoff at/inside this
    DESPIN_RATE_RAD_S2:  0.10,   // ~⅓ of DESPIN_LASER.DESPIN_RATE_RAD_S2 (0.30)
    CONDUCTIVE_MATERIALS: ['aluminum', 'steel', 'titanium'],
  },

  // Fragmentation severity tiers (capture-feedback overhaul Phase 3b).
  // The dormant frag risk (computeFragRisk at _resolveCatch) is now ROLLED;
  // severity scales with vRel excess × brittleness:
  //   crack   — debris survives, 1-2 frags shed, capture continues, score ding
  //   breakup — target destroyed → 3-6 fragments replace it, capture fails
  //   shatter — brittle + hot approach: 8-12 fragments + Kessler + comms alert
  FRAG_SEVERITY: {
    BREAKUP_SEVERITY: 0.45,   // severity ≥ this → breakup
    SHATTER_SEVERITY: 0.75,   // severity ≥ this → shatter
    CRACK_FRAGS:   [1, 2],
    BREAKUP_FRAGS: [3, 6],
    SHATTER_FRAGS: [8, 12],
    CRACK_MASS_FRACTION: 0.05,  // mass shed by a crack (target survives)
  },

  // --- Arm Operations ---
  ARM_DETACH_DURATION: 2.0,            // seconds (real-time undock animation)
  ARM_DOCK_DURATION: 3.0,              // seconds (real-time re-dock)
  // Standoff between the daughter and her pinned catch (Issue 13, 2026-06-12):
  // the catch is held at arm.position + holdDir × (sizeMeter/2 + clearance) so
  // the daughter never renders INSIDE a catch larger than herself. ≈ daughter
  // half-length + net bag slack.
  // catch-snug (2026-10-18): this 1.0 m is NO LONGER the in-hand standoff for a
  // catch that has a drawn mesh (owner: "debris seems to float .5 meter away from
  // end of daughter, should be reeled in firmly"). A typed catch in hand sits
  // ARM_HOLD_NET_GAP_M off her end, recomputed each frame from the two drawn
  // shapes (ArmUnit catchHoldStandoffM -> debris._holdStandoffM). It remains the
  // typeless in-hand fallback (`_pinCatchToSelf`: a catch with no type — old saves, rigs).
  // rack-snug (2026-10-18): it is NOT the rack's standoff any more — a rack cell is a place
  // on the daughter (ArmUnit.rackCellOffsetInto: her +Z support + the catch's drawn extent +
  // ARM_HOLD_NET_GAP_M, on her axis; rack-centre 2026-10-19), nothing here enters it.
  ARM_HOLD_CLEARANCE_M: 1.0,           // metres
  // catch-snug: air gap (the net, ~3 cm) between the daughter's end and the nearest
  // drawn point of a catch held in hand (pulled in, reeling, docking).
  // rack-snug: the SAME number seats a parked rack catch against her +Z end
  // (one number, the net). rack-centre: and spaces cell 1 from cell 0's catch along her axis.
  ARM_HOLD_NET_GAP_M: 0.03,            // metres
  // catch-snug: the move from the tight in-hand pin to the rack slot at the end of
  // docking glides over this long (smoothstep) instead of jumping in one frame.
  ARM_HOLD_GLIDE_S: 1.0,               // seconds
  // (rack-snug 2026-10-18: the rack no longer uses this — a parked catch sits beside her end, out of
  // the swing plane, fixed in HER frame. Its one remaining reader is CoMCalculator's booking of a
  // catch held IN HAND, which keeps its base geometry: hold axis from the net's launch direction,
  // slot-0 lateral bias along world up.) While in hand the full-size catch is biased laterally
  // (perpendicular to the outboard hold axis) by this factor × catch radius so
  // the bag never eclipses the ~1 m daughter on the camera→daughter view axis
  // (re-dock "daughter disappeared for 2 s" fix). 0 = pure outboard (old).
  ARM_HOLD_LATERAL_BIAS: 1.0,
  // Cargo-continuity S6 (2026-08-12): a parked daughter's hold is a cargo RACK — capacity in pieces pinned at the strut tip.
  // one-catch (owner 2026-10-22 13:01Z, after a mother catch landed on a daughter that already held one: "Currently daughter
  // can only hold one debris"): ONE piece, her own or one the mother puts on her. Cell 0's place and the trip's carry of it
  // are the same as before; cell 1 (rack-centre: stacked on cell 0's catch along her axis) is no longer reached.
  // rack-snug: a parked catch is a place on her, fixed in her frame. rack-centre (2026-10-19, owner "debris is off
  // center from daughter"): cell 0 is centred on her axis.
  DAUGHTER_CARGO_CELLS: 1,

  // ── S9 strut posing (2026-08-22, register item 32): the held-cargo plume
  // band. Measured, not guessed — tmp/i32s9-box-probe.log (the item-32 sweep
  // re-run under the BOX volume model: dims from setDebrisSize lengthM/widthM,
  // oriented by the booking's hold frame, enclosed exactly by a 4-ball chain).
  // Each row: any piece whose sizeMeter is <= maxSizM bites a 35° aft cone
  // somewhere on the attitude ring at aim angles UP TO maxBiteADeg (worst
  // aspect; the fat defunctSat hull, not the skinny rocketBody). safeAlphaMin
  // adds a +10° margin and is the re-pose DESTINATION FLOOR — a loaded
  // HOLDING_CATCH daughter parked at α >= her floor can never present cargo to
  // a plume at ANY attitude (the ring is the bound, i32 V9). The sphere's old
  // "clear at α >= 71°" bound is FALSIFIED by the box: a 12.4 m fat hull bites
  // to 106° (exact-box 80°, the chain's rounding is the margin's room).
  // RE-MEASURED 2026-09-24 (DECISIONS §5a): re-run against the corrected
  // Constants.THRUSTERS (apex 0.200 m / z −1.075 — was falsely 0.500 m /
  // z −2.000). Every row but the largest needed its floor raised (the
  // nearer, wider corrected cone bites farther for a small piece close to
  // the axis); the largest class barely moved (106° here vs 107° before —
  // the two errors partly offset at that extreme). Old → new (maxBiteADeg):
  // 11→16, 30→33, 45→48, 65→67, 86→87, 107→106.
  // RE-MEASURED 2026-10-19 (lane rack-snug): a parked rack catch is no longer slotted
  // round a world-up ring at the strut tip — it sits in a cell ON the daughter, beside
  // her end, fixed in her frame (ArmUnit.rackCellOffsetInto). The ring phase is gone;
  // the probe (tmp/rack-snug-plume-probe.mjs → js/test/fixtures/rack-snug-plume.json,
  // shared code js/test/_rackSnugPlume.js) calls the REAL cell function and CoMCalculator's
  // box-chain over 4 daughters × cells 0,1 × 30 catch attitudes in her frame (6 axis-aligned
  // + 24 seeded, js/test/_rackSnugAttitudes.js) × α 0–180° (1° grid) × every size/aspect
  // case (aspect bound as before: all three aspect types at every named size, plus every
  // fragment mesh and the cubesat). The deepest row is measured over pieces the game can
  // spawn there (defunctSat ≤ 8 × 1.15 jitter = 9.2 m, rocketBody ≤ 12.65 m): the old
  // "fat 12.4 m hull" (a 12.4 m defunctSat) is a test fixture, not a spawnable piece, and
  // under the new cells it bites at every α to 180° so no floor could express it. Old → new
  // (maxBiteADeg): 16→10, 33→28, 48→48, 67→75, 87→115, 106→141 (the large pieces now sit
  // 4–6 m to the side of her end, which brings the fat hulls into the cone farther out;
  // the small ones sit nearer her axis than the old √2·(size/2 + 1 m) standoff).
  // RE-MEASURED 2026-10-19 (lane rack-centre, owner "debris is off center from daughter"): the cells moved ONTO her axis —
  // cell 0 centred, cell 1 stacked on the same axis beyond cell 0's catch (ArmUnit.rackCellOffsetInto). Same generator
  // (tmp/rack-snug-plume-probe.mjs → js/test/fixtures/rack-snug-plume.json, js/test/_rackSnugPlume.js) and sampling
  // (4 daughters × cells 0,1 × the 30 attitudes × α 0–180° 1° grid × every size/aspect case, deepest row over spawnable
  // pieces only); a cell-1 placement now has a second piece of the SAME case in cell 0 (in 3 of the 30 attitudes:
  // the same as cell 1's, and the two that put cell 1 nearest / farthest: js/test/_rackSnugAttitudes.js
  // `belowAttitudeIndices`), and the plume check reads both pieces. Old → new (maxBiteADeg): 10→15, 28→31, 48→55,
  // 75→89, 115→115, 141→124 (measured, not explained: the causes were not separated; the new worst cases are named
  // in the fixture's `worst` per row — cell 1 sets the two smallest rows, cell 0 the rest).
  // Read by ArmManager's re-pose driver and the S9 tests; the plume CHECK
  // itself is band-free (it tests geometry, not policy).
  // 2026-10-23 roll-90 (hinge roll): these two rows re-measure at 120° / 130°; the floors 125° / 134° still clear, by 5° / 4°.
  PLUME_CARGO_ALPHA_LADDER: [
    { maxSizM: 0.5,  maxBiteADeg: 15,  safeAlphaMinRad: 25 * Math.PI / 180 },
    { maxSizM: 1.5,  maxBiteADeg: 31,  safeAlphaMinRad: 41 * Math.PI / 180 },
    { maxSizM: 2.8,  maxBiteADeg: 55,  safeAlphaMinRad: 65 * Math.PI / 180 },
    { maxSizM: 5.0,  maxBiteADeg: 89,  safeAlphaMinRad: 99 * Math.PI / 180 },
    { maxSizM: 8.0,  maxBiteADeg: 115, safeAlphaMinRad: 125 * Math.PI / 180 },
    { maxSizM: Infinity, maxBiteADeg: 124, safeAlphaMinRad: 134 * Math.PI / 180 },
  ],
  // The ONE band read (the digestSpanS in-table-method precedent): the piece's
  // re-pose floor for its size class — ceil to the NEXT row (intermediate
  // sizes inherit the deeper floor; conservative direction preserved).
  plumeCargoSafeAlphaMin(sizeMeter) {
    const s = Number.isFinite(sizeMeter) ? sizeMeter : Infinity;
    for (const row of this.PLUME_CARGO_ALPHA_LADDER) {
      if (s <= row.maxSizM) return row.safeAlphaMinRad;
    }
    return this.PLUME_CARGO_ALPHA_LADDER[this.PLUME_CARGO_ALPHA_LADDER.length - 1].safeAlphaMinRad;
  },

  ARM_NET_DEPLOY_TIME: 3.0,            // seconds (Miura-ori unfold + SMA cinch)
  ARM_GRAPPLE_STABILIZE: 1.5,          // seconds (stabilization after capture)
  ARM_CAPTURE_SUCCESS_RATE: 0.85,      // 85% net capture success (legacy; gated off when CAPTURE_NET ON)

  // Per-arm net inventory capacity (§13 Q5 — depletion is a real Y0 fail state)
  // These values MUST equal CAPTURE_NET.MEDIUM/SMALL.MAGAZINE_SIZE (drift-guard
  // test enforces). Payload-fraction invariant justifying 4/4:
  //   Large Daughter (weaver): 4 × 0.317 kg / 6.6 kg ≈ 19% (was 2 × 0.68 kg ≈ 21% until 2026-10-23, DECISIONS §38 row 5:
  //     four 3 m nets in place of two 5 m nets)
  //   Small Daughter (spinner): 4 × 0.12 kg / 2.1 kg ≈ 23%
  ARM_NET_CAPACITY: {
    weaver:  4,
    spinner: 4,
  },

  // --- Arm Approach Speeds (scene units/s — 1 unit = 100 km) ---
  // 0.5 m/s real = 0.000005 scene units/s
  ARM_APPROACH_SPEED: 0.000005,        // m/s (0.5 m/s closing)
  ARM_HAUL_SPEED: 0.0000025,           // m/s (0.25 m/s loaded return)

  // --- Total System (3W + 3S configuration) ---
  OCTOPUS_TOTAL_DRY_MASS: 214,         // kg (without propellant)
  OCTOPUS_ARM_COUNT: 6,                // 3 Weaver + 3 Spinner

  // --- Web Shot (Sprint D1) ---
  WEB_SHOT_DURATION: 2.0,                // seconds — launch animation
  WEB_SHOT_COOLDOWN: 10.0,               // seconds between shots
  WEB_SHOT_DRAG_MULT: 5.0,               // drag multiplier applied to hit debris
  WEB_SHOT_FUEL_COST: 3.0,               // fuel % consumed per shot
  WEB_SHOT_DEORBIT_ALT_KM: 150,          // altitude below which debris burns up (km)
  WEB_SHOT_DECAY_RATE: 0.00002,          // SMA decay per second (scene units) at 1× drag
  WEB_SHOT_DEORBIT_SCORE: 300,           // points awarded for web-shot de-orbit

  // --- V4 "Opussy" GSL Upgrade Multipliers (unlockable) ---
  V4_TETHER_LENGTH_MULT: 6.25,        // Same mass → 6.25× longer reach (12.5 km)
  V4_NET_SIZE_MULT: 10.0,             // Same mass → 10× net area (50×50m)

  // ============================================================================
  // OCTOPUS V5 BASELINE (Epic 9 — V5 Hardware)
  // Consolidated parameter block for the V5 satellite (Hex Umbrella default).
  // Mirrors V3 OCTOPUS_* flat-key structure for downstream consistency.
  // Detailed crossbow/tether/spring sub-systems remain in their own blocks below.
  // ============================================================================
  OCTOPUS_V5: {
    // ── Barrel Geometry (CHANGED: 1.2×1.0 → 2.0×0.8 Config G) ──
    CORE_LENGTH: 2.0,              // m — was 1.2
    CORE_ACROSS_FLATS: 0.8,        // m — was 1.0
    CORE_ASPECT_RATIO: 2.5,        // NEW

    // ── Collar (NEW) ──
    // DECISIONS §11 (2026-09-23, ratified): the strut hinge moves 10 cm
    // forward onto the FRONT ring (was the back/middle collar at 0.90,
    // matched to the original quad-ring frame). The front ring is the
    // strongest part of the body ("the ends, right? Strongest part of mother
    // is end hoops?" — owner). Everything hanging off the pivot (stow
    // channels, reel/spring stations, dock offsets, callout/blueprint
    // anchors) derives from this constant — see PlayerSatellite.js
    // _buildStruts and _carveStowGrooves.
    COLLAR_Y: 1.00,                // m from barrel center (+Y) — was 0.90
    COLLAR_RADIUS: 0.40,           // m

    // ── Nose berthing collar (S13(c) — B is doctrine) ──
    // The fore docking port reborn as functional hardware: whale-class cargo
    // mates rigidly, on-axis, at the nose. The ring sits at the seat plane
    // (z = 1.30); the net leaves from just behind it. Seat rule: cargo surface at the ring plane — cargo centre
    // at BERTH_COLLAR_Z_M + sizeMeter/2 + CAPTURE_NET.BERTH_CLEARANCE_M 1.0
    // (mirrors ARM_HOLD_CLEARANCE_M).
    // History: S13(e) (2026-08-14) moved the two Large Net pods to ±0.45 m off
    // the boresight (until 2026-10-13) so the collar owned the axis alone,
    // which brought back a launch-recoil yaw lever (billed in N₂). Owner 2026-10-13 ("now there are
    // 2 large net launchers at nose of mother. Should be one, centered.") —
    // ONE launcher, on the axis, INSIDE the collar, firing through its bore;
    // the collar and the berth anchor are untouched. The muzzle sits at
    // x = y = 0, so the shot has no lever about the centre of mass (the turning
    // kick is gone). See NET_LAUNCHER_* below.
    BERTH_COLLAR_Z_M: 1.30,        // m — collar seat plane, ship-local z (the net now leaves 30 mm behind it, from NET_LAUNCHER_MUZZLE_Z_M)
    BERTH_COLLAR_INNER_R_M: 0.16,  // m — bore radius
    // Design 6 (2026-09-08, "sensors need visual clearance to see"): the collar
    // is a SKELETON — a thin capture ring (tube r 0.020 → R = INNER + TUBE =
    // 0.180, outer 0.200) on four inclined struts whose feet stand on the sensor
    // turntable at radial 0.30. The old torus (tube 0.07, annulus 0.16–0.30)
    // stood 2–6 cm in front of the four ring optics and blocked 80–100 % of
    // their cones (plan §1a); BERTH_COLLAR_OUTER_R_M (0.30, the guide-cone
    // root) retired with the cone — the same 0.30 lives on as the strut
    // footprint. Bore and seat plane unchanged: the DOCKING COLLAR card and the
    // CARGO blueprint print "0.32 m bore" from INNER_R.
    BERTH_COLLAR_TUBE_R_M: 0.020,  // m — capture-ring tube radius (ring R = INNER_R + TUBE_R)
    BERTH_COLLAR_STRUT_FOOT_R_M: 0.30, // m — strut foot radial on the turntable top (z 1.05)
    // ── The one Large Net launcher (owner 2026-10-13: "one, centered") ──
    // A gunmetal cylinder on the long axis (x = y = 0), standing on the sensor
    // turntable INSIDE the collar bore and firing through it. Probe-sited
    // 2026-10-13 (tmp/netpod-centre-candidate.log, gaps good to ~1.5 mm): at
    // r 0.12 with its front face at z 1.27 it keeps ring tube 47.1 mm, optics
    // (IR / EO / LIDAR / LaserBaffle) 40.0 mm, collar struts 54.8 mm, fore sun
    // pucks 57.8 mm; 15 mm to everything is reached only at r 0.145. The
    // corridor along the nose from z 1.27 is clear to radius 0.155 (set by the
    // sun pucks; the ring's inner edge is at 0.1597).
    NET_LAUNCHER_R_M: 0.12,        // m — launcher housing radius
    NET_LAUNCHER_MUZZLE_Z_M: 1.27, // m — front face = muzzle plane, 10 mm behind the ring (ring tube spans z 1.28-1.32)
    NET_LAUNCHER_BASE_Z_M: 1.050,  // m — base buried 5 mm in the turntable (top 1.055), through the berth plate (z 1.055-1.060)

    // ── Strut (NEW — replaces short-strut spec) ──
    // DECISIONS §11: +10 cm to match the +10 cm hinge move, so the stowed
    // daughter keeps the same pocket (pocket z = COLLAR_Y − STRUT_LENGTH is
    // an invariant of the move: 0.90 − 1.60 == 1.00 − 1.70 == −0.70).
    STRUT_LENGTH: 1.70,            // m (hinge to daughter dock) — was 1.60
    STRUT_TUBE_OD: 0.050,          // m
    STRUT_TUBE_WALL: 0.002,        // m
    STRUT_MASS: 4.5,               // kg (structure + reel + spring + hinge)
    STRUT_SWEEP_MIN: 0,            // rad
    STRUT_SWEEP_MAX: Math.PI,      // rad (180°) — the RANGE; unchanged by the opening-dance plan
    STRUT_SLEW_RATE: 15 * Math.PI / 180, // rad/s (15°/s — slowed 50% so new players can see strut deploy)
    // launch-smooth: the strut of a daughter being aimed (the launch ceremony) does not jump to 15°/s and stop dead:
    // it speeds up at this rate, coasts at its peak (never above STRUT_SLEW_RATE) and slows at this rate, so it starts
    // and ends together with the mother's own turn (her ramps are ~0.3 s). Only a caller that passes an `ease` to
    // `setAimAlpha` is eased; every other strut move keeps the constant rate above.
    STRUT_EASE_ACCEL: 50 * Math.PI / 180, // rad/s² (50°/s²: 15°/s in 0.3 s)

    // The "." strut toggle has two angles, both measured from the tail
    // (0° along the hull toward the tail, 90° straight out, 180° along the nose).
    // STRUT_REST_ALPHA: ONE press opens here, 34° — swept back from the nose at
    // the radiators' angle, mirrored (radiators are 146° from the nose; owner
    // 2026-10-14: "try daughter struts at swept back ... opposite 146 degree",
    // "I said 146 but meant 34"). Measured (tmp/probes/strut34/): tips z -0.41,
    // 1.34 m off axis, never fouls the 1.30 m catch plane; strut-to-radiator
    // >= 51 mm over the whole radiator sweep, hull 176 mm, neighbours 305 mm;
    // swing 0->34 2.27 s, 136 J for four struts.
    STRUT_REST_ALPHA: 34 * Math.PI / 180, // rad (34°)
    // hold-catch (owner 2026-10-22: "daughters that catch debris should hold it, and their strut should move to default
    // position"): a daughter aboard with a catch keeps her strut at the lowest of 34°, 39°, 44° ... where her catch is clear
    // of the thruster plumes (ArmManager.holdPoseAlpha, the exact box check at the real angle), and never above
    // HOLD_POSE_MAX_DEG: the mother-net path (CaptureNet._corridorClear) is clear of a strut tip for every inbound size up to
    // 100° (the tip crosses the muzzle plane at about 100°, probe 2026-10-22, DECISIONS §35). 0° is never a hold pose: the rest
    // cradle touches the hull, and a 5 m catch touches the open radiators there (tmp/probe-hold-0deg.mjs). The slew and a
    // "." press leave 1° of slack (DEADBAND) so the driver does not chase the strut driver's own 0.57° arrival tolerance.
    HOLD_POSE_MAX_DEG: 100,
    HOLD_POSE_STEP_DEG: 5,
    HOLD_POSE_DEADBAND_DEG: 1,
    // STRUT_DEPLOY_ALPHA: a DOUBLE TAP opens to 90°, straight out sideways; it is
    // also the catch-duck angle (ArmManager duck target/release). Was the single-
    // press target 2026-10-12 and 146° before that (opening-dance plan, 2026-09-16).
    // Measured: at 90° the tip is aft of the muzzle plane (z 1.0 vs 1.30), so no
    // catch of any size can touch it; swing 34->90 3.73 s, 224 J.
    // STRUT_SWEEP_MAX above is untouched — the RANGE stays [0, π].
    STRUT_DEPLOY_ALPHA: 90 * Math.PI / 180, // rad (90°)
    // "Open" means past HALF the rest angle (17°): a strut that arrives at
    // 33.99° — or is stopped short — still reads open, so the toggle closes it
    // and the DAUGHTERS pane gate opens from the first press. Read by
    // ArmManager.strutsDeployed() and toggleStruts(); derived so it cannot drift.
    get STRUT_OPEN_THRESHOLD() { return this.STRUT_REST_ALPHA / 2; },
    // Double-tap window: a second "." press inside it opens to STRUT_DEPLOY_ALPHA
    // (90°) whatever the first press did; no tap sequence targets 180° (the range
    // allows it, the button does not — owner 2026-10-14). Matches the radiator's
    // VENT_DOUBLE_TAP_MS so one gesture means one thing everywhere.
    STRUT_PUSH_WINDOW_MS: 600,

    // Daughter-arm automation (lane arms-auto; DECISIONS §25 ruling 5): the struts
    // start closed at 0° and stay closed until the first opening of the run (a piece
    // within NET_LOCK_RANGE_M (90 m), a catch under way, or a "." press); from then on
    // they REST at STRUT_REST_ALPHA (34°, lane arms-default, owner 2026-10-16) and never
    // fold flat on their own. They ease back to 34° OVERRIDE_S after a "." press. Real
    // motor rate throughout (STRUT_SLEW_RATE); nothing here teleports. Read by
    // systems/StrutAuto.js.
    // DEMO_TOP_RAD: the once-per-player full-range show goes out to this angle. Probe
    // 2026-10-15: strut 0-180° in 2° steps x 20 radiator/wing states, clear from 4° (0-2° is
    // the rest cradle, touching by design). Tightest gaps: 22 mm hull at 4°, 30 mm radiator
    // plate at 6° (radiator then at 2°; it rests at 0° since 2026-10-16), 54 mm wing clamp at 8° (tilt -30°); neighbours 190 mm and
    // nose collar 207 mm at 180°. So DEMO_TOP_RAD = 180°.
    STRUT_AUTO: {
      OVERRIDE_S: 10,                 // s after the arm ARRIVES at the player's angle
      HANDOFF_S: 3,                   // s hands-off after a launch/leash/duck ends
      SCAN_INTERVAL_S: 0.5,           // s between debris scans (2 Hz)
      LEAVE_FACTOR: 1.1,              // enter at <= 90 m, leave only past 99 m
      DEADBAND_RAD: 2 * Math.PI / 180, // rad — no re-command inside 2°
      DEMO_TOP_RAD: Math.PI,          // rad (180°) — measured clear
      DEMO_CLEAR_M: 0.006,            // m — the show turns back if the gap falls under this (proxy at radiator 0°: min 7.3 mm at strut 162°, measured 2026-10-17)
      DEMO_CHECK_FROM_RAD: 30 * Math.PI / 180, // rad — below this the strut is near its rest cradle (touching by design); the coarse proxy (55 mm capsule + 0.13 m sphere) reads -4.9..9.9 mm at 9-29° with the radiator at 0° while the real meshes measure >= 9.6 mm (log in plan)
    },

    // ── Recoil Safety (NEW — ST-9.3 C-3) ──
    HIGH_RECOIL_ALPHA_LOW:  Math.PI / 6,     // rad (30°) — below this = high axial recoil
    HIGH_RECOIL_ALPHA_HIGH: 5 * Math.PI / 6, // rad (150°) — above this = high axial recoil
    HINGE_SETTLE_TIME: 0.5,                   // seconds — auto-unlock delay after fire recoil settles

    // ── 3-Plane Layout (NEW) ──
    ROSA_PLANE_AZIMUTH: 0,         // rad (0° and 180° plane)
    ARM_PLANE_OFFSET: 64 * Math.PI / 180, // rad (64° from ROSA)
    // Derived: arm azimuths [64°, 116°, 244°, 296°] for Y0 Quad (strut re-clock
    // trial: each azimuth moved 4° away from its nearest ROSA root to clear the
    // radiator fold; read by nothing at runtime — Y0_QUAD.azimuths is the SSOT)

    // ── ROSA Panels (NEW — replaces rigid wing spec) ──
    // Square-cornered rectangle (Option B accuracy pass): real ROSA wings are
    // plain rectangles, so the former ROSA_CHAMFER corner cut was dropped.
    ROSA_WIDTH: 1.0,               // m
    ROSA_LENGTH: 2.0,              // m
    // Mother-wings step 4 (DECISIONS §10, "power follows the panels, realistic
    // wins"): ROSA_POWER/BODY_MOUNT_POWER/TOTAL_SOLAR_POWER and the furl/feather
    // fractions derived from them are REMOVED. _updateSolarPower now sums each
    // wing's and each body cell's own real area × incidence × furl instead of
    // scaling a table peak by a generic sunAngle. BODY_MOUNT_AREA_M2 is the one
    // number kept from the table era — the real, measured total body-cell face
    // area (44 built BarrelSolarPanel_* cells after the 2026-09-24 half-width
    // re-lay; drift-pinned against the built ship in test-MotherPower) — used by the real power path AND to correct the top-level
    // `Constants.SOLAR_PANEL_AREA` (was a generic, unrelated 20 m² placeholder;
    // now the real total = 2 wings + this). Re-measure if the cells lane
    // changes the layout.
    BODY_MOUNT_AREA_M2: 1.609,      // m² — measured, sum of built body-cell faces
    // Body-cell shading estimate (mother-wings step 4): a per-cell sun-ray vs
    // wings/struts/radiator raycast, throttled to this rate — cos(sun,normal)
    // stays live every frame, only the (pricier) occlusion test is cached.
    BODY_SHADE_UPDATE_S: 0.5,      // s — throttle period (2 Hz), per plan §4 "≤1-2 Hz"
    BODY_SHADE_MAX_DIST_M: 3.0,    // m — beyond this nothing on the ship can shade a cell

    // ── ROSA fidelity geometry (verified vs. real Redwire/NASA ROSA) ──
    // Real ROSA: flexible PV "center wing" with a high-strain composite slit-tube
    // boom along EACH long edge, rolled onto a root spool/mandrel ("like a tape
    // measure"). Deploys passively via boom strain energy. The Mother is a
    // (gameplay-liberty) motorised re-furlable variant — real ROSA is one-way.
    // Evidence for the one-way claim, re-verified 2026-09-22: the June 2017 ISS
    // flight test is the only time anyone tried to take one back. After a
    // 12-day test, controllers could not lock the array in its stowed
    // configuration and it was jettisoned on 30 June rather than retrieved. The
    // codex entry `rosa_solar_array` tells the player exactly this, so the
    // fiction is disclosed rather than quietly assumed.
    ROSA_BOOM_OD: 0.020,           // m — slit-tube edge boom diameter (both long edges)
    ROSA_DRUM_R: 0.050,            // m — root roller drum / mandrel radius
    // Rolled stack thickness, the INPUT to the furled-coil radius (see
    // PlayerSatellite.rosaFurledCoilRadiusM: R = sqrt(drumR² + width·t/π)).
    // A real ROSA blanket — IMM/thin-film cells on a flexible substrate — is
    // well under 1 mm; the balance here is the flattened slit-tube booms, which
    // ride the long edges and thicken the wrap at z = ±1.0. 1.5 mm over the
    // 1.0 m width puts the furled coil at r ≈ 0.0546 m. With the spool axis at
    // 0.49 (see ROSA_BRACKET_LEN) its inboard face sits at 0.4354 m; measured
    // on the built model by test-RosaFurl, that is 35 mm clear of the hull and
    // 24 mm clear of the nearest body PV corner.
    ROSA_BLANKET_T: 0.0015,        // m — blanket + flattened-boom stack thickness
    ROSA_SPREADER_OD: 0.010,      // m — slim tip spreader / leading-edge deploy bar
    // Root mounting bracket standoff from the bus. This is what holds the
    // furled roll off the hull, so it is sized BY the coil: with
    // ROSA_ROOT_DRUM_FRAC the spool axis lands at COLLAR_RADIUS + 0.070 +
    // 0.4·0.050 = 0.49 m (PlayerSatellite.rosaSpoolAxisM), and a furled coil of
    // r 0.0546 then reaches in to 0.4354 m.
    // Was 0.060 (spool at 0.48). The body PV is tiled on FLAT 22.5° facets, so
    // a panel's azimuth corners lift to ~1.034·R ≈ 0.4136 — well proud of the
    // 1.014·R face — and at 0.48 the nearest corner (BarrelSolarPanel_11, the
    // 11.25° facet) cleared a furled coil by only 13.6 mm, under the 20 mm gate.
    // Note the ±8° `rosaKeep` PV keep-out in _buildBodyPanels cannot help here:
    // facet CENTRES land at 11.25°, so no facet is ever within 8° of a ROSA
    // root and the keep-out never fires. 10 mm more standoff is the honest
    // lever — it is the part whose job this is. Pinned by test-RosaFurl.
    ROSA_BRACKET_LEN: 0.070,      // m — root mounting bracket standoff from bus
    // The spool axis sits this fraction of a drum radius beyond the bracket:
    //   spoolAxis = COLLAR_RADIUS + ROSA_BRACKET_LEN + FRAC·ROSA_DRUM_R.
    // Named because PlayerSatellite.rosaSpoolAxisM() is the single source the
    // runtime AND the coil-clearance pins all read; it was a bare 0.4 literal
    // typed out in three places.
    ROSA_ROOT_DRUM_FRAC: 0.4,     // — spool-axis standoff, in drum radii
    // Furl/unfurl runtime control (",") — snappy ~2.5 s full cycle (fraction/s).
    ROSA_FURL_RATE: 0.40,          // 1/s — progress change per second when furling/unfurling
    // Feather (Shift+",") — park the wings edge-on to a hazard. Snappier than a
    // full furl (it only swings the tilt pivot, no roll-out), so retract is fast
    // and most power is retained until the edge turns away from the sun.
    ROSA_FEATHER_RATE: 0.60,       // 1/s — feather progress change per second
    // Tier-aware sun-track tilt clamp. Y0 struts sit 64° off the ROSA plane, so
    // the loose ±30° clamp clears them; Y1+ tiers add 30°/330° struts only 30°
    // from the plane, so when a strut is within ~30° the clamp tightens to this.
    ROSA_TILT_CLAMP_TIGHT_DEG: 18, // deg — tighter sun-track tilt at higher tiers
    // Mother-wings step 4: ROSA_POWER_FRACTION / BODY_MOUNT_POWER_FRACTION
    // REMOVED (see the note by BODY_MOUNT_AREA_M2 above) — each surface now
    // earns its own power from its own real area × incidence × furl.

    // ── Mid-ring + wing motor box (mother-wings step 1/2, DECISIONS §10) ──
    // The inside ring frame at mid-body (z=0) that wing hardware bolts to,
    // instead of the three brackets that used to hang off the tilting
    // sun-tracking pivot and swing clear of the hull at high tilt (owner:
    // "3 black pillars seem to float on top of solar cells").
    MID_RING_INSET: 0.010,        // m — ring radius = COLLAR_RADIUS − this (just inside the skin)
    MID_RING_TUBE_R: 0.006,       // m — ring frame tube radius
    // Fixed motor box: bolted to the body (child of the ship, NOT the tilting
    // pivot) at each wing root (az 0°/180°, z=0). The drum's own axis is ON
    // the tilt rotation axis (rosaSpoolAxisM = 0.49 m from the ship axis,
    // drum radius ROSA_DRUM_R = 0.05 m — tilt-invariant, only spins in place),
    // so its closest approach to the hull is a HARD ceiling: 0.49 − 0.05 =
    // 0.44 m. The box's outer face (COLLAR_RADIUS + pad + deep = 0.40 + 0.003
    // + 0.015 = 0.418 m) clears that by 22 mm at every tilt, by construction —
    // measured `tmp/probe-rosa-tilt.mjs`. The on-axis yoke
    // (`ROSA_Bracket_{0,180}deg`, −0.010…+0.060 pivot-local x = 0.390…0.460 m
    // ship-frame) necessarily passes THROUGH this box — that is the design:
    // the box is the fixed motor housing, the yoke is the output coupling
    // shaft poking out through it to the drum (measured 1.7–2.2 mm to the
    // housing wall — a real close-fit shaft seal, not a floating gap).
    WING_MOTOR_BOX_LEN: 0.080,    // m — axial (Z) extent
    WING_MOTOR_BOX_WIDE: 0.070,   // m — tangential (Y) extent
    WING_MOTOR_BOX_DEEP: 0.015,   // m — radial (X) extent
    WING_MOTOR_PAD_H: 0.003,      // m — standoff pad between the hull and the motor box

    // ── Wing-drum launch clamps (mother-wings step 3, DECISIONS §10) ──
    // Each drum end is held to the front/back end ring (z = ±CORE_LENGTH/2)
    // by a re-latchable hold-down latch (closed when the wings are fully
    // rolled up, open before the wing unrolls or tilts). The drum-half
    // rides the drum (a collar at the drum's own tip, z ±1.02·ROSA_LENGTH/2).
    // The BODY half is a hold-down BRACKET BOLTED TO THE END RING: a block
    // bearing on the barrel's last WING_CLAMP_LAND of length and overhanging
    // the rim under the drum collar, its top WING_CLAMP_SEAT_GAP below the
    // collar. A release PIN (the real part: a pin-puller) bridges that gap
    // while latched and withdraws into the bracket at release; the bracket
    // itself never moves. Owner 2026-09-24 ("4 new floating black discs"):
    // the first build put the body half on the DRUM's axis, 30 mm off the
    // skin with no mount — measured tmp/clamp-float.mjs — so once the wing
    // tilted away it hung in space. Why the bracket can never be hit: the
    // wing tilts about the radial (x) axis, so no wing point ever changes its
    // height x above that side of the body; the wing's lowest point at the ends is the drum collar
    // (spoolAxis − 1.2·ROSA_DRUM_R = 0.430 m), and the bracket top is
    // SEAT_GAP under it at every tilt. Measured: tmp/clamp-site.mjs.
    WING_CLAMP_LEN: 0.012,        // m — drum collar axial length
    WING_CLAMP_SEAT_GAP: 0.005,   // m — bracket top below the drum collar (the pin bridges it)
    WING_CLAMP_W: 0.030,          // m — bracket width (tangential)
    WING_CLAMP_LAND: 0.025,       // m — bracket length bearing on the barrel inboard of the end ring
    WING_CLAMP_PIN_R: 0.005,      // m — release-pin radius
    WING_CLAMP_RELATCH_TILT_DEG: 0.5,  // deg — both wing tilts within this of 0 lets the re-stow latch close (owner 2026-09-25; tilt then snaps to exactly 0)

    // ── Hinge (NEW) ──
    HINGE_LOCK_TORQUE: 1000,       // N·m
    HINGE_MOTOR_TORQUE: 10,        // N·m
    HINGE_BEARING: 'Si3N4_MoS2',

    // ── Launch Vehicle (NEW) ──
    // Design 7b (2026-09-08) re-pinned the envelope from the built model in its
    // launch state (daughters in their channels, ROSA furled, the aft flower
    // fore-folded along the barrel — probe 7b.4c B′). At that time the furled
    // coils set the diameter at Ø1.275.
    //
    // ROSA coil-physics fix: the coil radius is now DERIVED (see
    // PlayerSatellite.rosaFurledCoilRadiusM) instead of being a styled ×3 scale,
    // and the standoff bracket grew to hold it off the body PV, so a furled coil
    // reaches 0.49 + 0.0546 = 0.5446 → Ø1.089 and NO LONGER sets the diameter.
    // The widest stowed item is now the folded flower pack (r_max 0.546 →
    // Ø1.092), measured by test-FlowerLaunchFold T7(ii).
    // The stack got 18 cm narrower purely by telling the truth about the coil.
    // Length (until 2026-10-15): FEEP exits (z −1.075) to folded flower tips (z 1.505); now set by the sun-sensor windows (z 1.332) — see STOWED_ENVELOPE_LEN.
    LAUNCH_VEHICLE: 'SSLV',
    STOWED_ENVELOPE_DIA: 1.13,     // m — folded flower packs Ø1.121 (was Ø1.092 before the 20 mm wing gap cleared the boom; furled ROSA coils Ø1.089 sit inside)

    // v12-radiator-20 (owner 2026-10-16): the folded tips now end at +1.305, inside the docking collar (ring z 1.280–1.320), so
    // they no longer set the length. Measured (tmp/probes/rs-top.mjs, LAUNCH hull state, real meshes): hull z −1.085 (FEEP neutralisers)
    // … +1.332 (SunSensor windows) = 2.417 m → 2.42. Was 2.58 = FEEP −1.075 … folded tips +1.505.
    STOWED_ENVELOPE_LEN: 2.42,     // m — FEEP/neutralisers −1.085 … sun-sensor windows +1.332 (folded flower tips +1.305 are inside)

    // ── Mass Budget (UPDATED for Config G — §10.11 canonical) ──
    // Cargo-continuity S13(c): +15 kg for the nose berthing collar (B is
    // doctrine — the 2026-08-14 owner ruling): coreDry 161 → 176, the budget's
    // ship is 179 → 194 kg, wet 242.4 → 257.4, ΔV 3096 → 2897 m/s empty (the
    // S12 memo's structural row, measured M1).
    TOTAL_DRY_MASS: 211.4,         // was 196.4
    CORE_DRY_MASS: 176.0,          // was 161 — bus + ROSA + body-mount + collar (S13(c))
    CORE_WET_MASS: 222,            // was 216 — 176 + 40 + 6 (collar-era dry + carried propellant; register item 56)
    WEAVER_MASS: 6.6,              // unchanged
    SPINNER_MASS: 2.1,             // unchanged
    FRONT_ARM_MASS: 6.6,           // retained for Y3
    BACK_ARM_MASS: 6.6,            // retained for Y3

    // ── Arm Counts (keeping same structure) ──
    ARM_COUNT: 4,
    WEAVER_COUNT: 2,
    SPINNER_COUNT: 2,
    FRONT_ARM_COUNT: 0,
    BACK_ARM_COUNT: 0,

    // ── Geometry (DEPRECATED equatorial values → Config G replacements) ──
    BACK_ARM_OFFSET: 0.3,          // DEPRECATED — no back arm at Y0

    // ── Power & Thrust (carried forward) ──
    CORE_BATTERY: 600,             // Wh
    CORE_SOLAR_AREA: 5.0,          // m²
    CORE_SOLAR_POWER: 1900,        // W — DEPRECATED legacy Epic-9 mass-table figure;
                                    // the live power path is _updateSolarPower's
                                    // per-cell/per-wing sum (top-level
                                    // Constants.SOLAR_PANEL_AREA is the current
                                    // real-total-area figure, mother-wings step 4)
    CORE_LASER_POWER: 200,         // W
    CORE_LASER_OPTICAL: 120,       // W
    CORE_HALL_THRUST: 0.01,        // N
    CORE_HALL_ISP: 1500,           // s

    // ── Tether (unchanged) ──
    TETHER_LENGTH_DEFAULT: 2000,   // m
    TETHER_MATERIAL: 'Dyneema SK78',
  },

  // ============================================================================
  // ST-9.2 ARM TECH LADDER — Quad Y0 → Hex Y1 → Octo Y3
  // Progression from 4 to 8 arms. Only Quad ships; Hex/Octo are reserved rows
  // (the shipyard-refit switch that once gated them was removed).
  // See CROSSBOW_ARMS.md §12.5 + §25 for mass derivation.
  // ============================================================================
  ARM_LADDER: {
    // S13(c): every tier's bus carries the +15 kg nose collar (the collar is
    // core hardware, not tier hardware) — Y0 211.4/257.4, deltas unchanged.
    Y0_QUAD: { armCount: 4, weaverCount: 2, spinnerCount: 2, frontArmCount: 0, backArmCount: 0, dryMass: 211.4, wetMass: 257.4, unlocked: true,  tier: 0, azimuths: [64, 116, 244, 296] },
    Y1_HEX:  { armCount: 6, weaverCount: 3, spinnerCount: 3, frontArmCount: 0, backArmCount: 0, dryMass: 223.0, wetMass: 269.0, unlocked: false, tier: 1, azimuths: [30, 90, 150, 210, 270, 330] },
    Y3_OCTO: { armCount: 8, weaverCount: 3, spinnerCount: 3, frontArmCount: 1, backArmCount: 1, dryMass: 237.0, wetMass: 283.0, unlocked: false, tier: 3, azimuths: [30, 90, 150, 210, 270, 330], endFaceArms: ['+Z', '-Z'] },
  },

  // ============================================================================
  // THERMAL (P2 — flower hardware, observe-only; block reserved by the P1
  // ledger .kilo/plans/1787831047000-aft-rim-allocation-and-reservations.md §5)
  // ============================================================================
  // AFT FLOWER — 4 rigid aft-pivot struts with radiator plates and inert tip
  // hardpoints. The struts "open LIKE A FLOWER" (owner grammar — keep verbatim).
  // OBSERVE-ONLY at P2: they draw and slew, throttle nothing; thermal state and
  // numbers are P3, throttle P4, tip cargo booking P5.
  //
  // Every number below is pinned by tmp/flower-pose-band.mjs (probe 2, byte-
  // stable; P1 re-derivation gate passed: margin = 0.21199·R + 0.20021,
  // conservative ceiling 147.35° at R=4, straight-aft limit R=1.714 m, cargo
  // pose 1.9 m bag +0.780 m) and tmp/flower-mass-budget.mjs (probe 4).
  // The P1 allocation table is BINDING: stations at az 45/135/225/315
  // ± 11.25° (Design 7b clocks the hinges to 40/140/220/320 — INSIDE those
  // grants), hinge band z −1.000..−0.886 at r 0.34..0.51 (Design 7b widened
  // the bracket band from 0.46 — the owner-approved launch-only amendment),
  // deployed envelope z ≤ −1.0, pose band θ ∈ [90°,146°] under thrust,
  // θ ≥ 90° in orbit; θ ∈ [0°, 90°) exists ONLY under the one-shot launch
  // lock (Design 7b, .kilo/plans/1788863400000-radiator-launch-fold-redesign.md).
  THERMAL: {
    FLOWER: {
      // ── Stations (allocation table rows FLOWER-NE/NW/SW/SE, binding) ──
      // Design 7b (2026-09-08, "has to fold to fit in rocket for launch"): the
      // flower folds FORE along the barrel for launch (θ 0), so the fore-folded
      // boom root must thread the lane between the docked weaver bodies (az
      // 60 ± 12.5°, r to 0.528 in the pocket band) on the OUTBOARD side and the
      // MGA patch (az 9.8..40.2, r 0.424), the net-launcher pods (two at
      // ±0.45 m until 2026-10-13; one centred launcher now) and the furled
      // ROSA coil on the INBOARD side. That balance landed on 41°.
      //
      // ROSA coil-physics fix: the coil radius became derived rather than
      // styled (PlayerSatellite.rosaFurledCoilRadiusM ≈ 0.0546 vs the old
      // 0.1575), moving the coil wall 103 mm inboard and lifting the constraint
      // that had held the stations OFF the ROSA plane — the old note's "40° →
      // coil 23 mm" is now "40° → coil 129 mm".
      //
      // But the coil was never the only inboard wall, and the one that binds
      // now is the PLUME CONE at the STOW pose. The main FEEP sit at az
      // 0/90/180/270, so the stations are squeezed between a thruster at 0° and
      // a daughter at 64°; STOW (146°) is the thrust-band ceiling, i.e. the one
      // ladder pose held while the engines burn — a higher STOW-specific gate
      // WAS intended here (vs the 0.15 m P1 floor for PARK/CARGO) precisely
      // because that is where exhaust would play on a radiator, but the 0.70 m
      // number below was never actually derived from a stated margin (DECISIONS
      // §5a, 2026-09-24: it was fitted to a Constants.THRUSTERS table that did
      // not match the built ship). Re-measured on the CORRECTED table (real
      // apexes r 0.200 m / z −1.075, tmp/flower-reclock-probe.mjs convention):
      //
      //     az   hull(MGA)  weaver   coil    STOW cone (corrected 2026-09-24)
      //     41     0.023    0.025    0.137     0.267     <- old station
      //     40     0.022    0.032    0.129     0.265     <- new station
      //     39     0.022    0.040    0.121     0.262
      //     38     0.023    0.048    0.112     0.260
      //     36     0.026    0.063    0.096     0.255
      //
      // Every row now fails the 0.70 m gate (they always did — the gate was
      // reading a defective 0.71-ish measurement, not the real ~0.26 m); the
      // RELATIVE ordering across stations is unchanged (the correction scales
      // every row by the same wider-cone factor), so 40° is still the least
      // costly station on this axis. What the real STOW floor should be is an
      // owner call (HANDOFF "Open / owed"); it does not reopen the 40° choice.
      //
      // So the coil fix buys 2° of honest room, not the ~11° an azimuth-only
      // reading of it suggests. 40° takes it: +28 % docked-daughter clearance
      // (25 → 32 mm) with 12 mm still in hand on the binding cone gate and 2°
      // to its cliff. Going further trades a years-long plume-contamination
      // margin for millimetres of visual gap — the wrong trade, and the lever
      // for a larger gain is the MGA patch or the STOW angle, not this number.
      // Pairs stay exact diagonals (trim-neutral); 40° is inside the P1
      // ±11.25° station grant (33.75..56.25).
      AZIMUTHS_DEG: [40, 140, 220, 320],
      PAIR_A_AZ_DEG: [40, 220],    // trim-neutral diagonal (S12 ⟂-CoM 0.0000)
      PAIR_B_AZ_DEG: [140, 320],   // second diagonal — shop stages pairs
      // Hinge pin r 0.475 (was 0.40 = the rim). The clevis stands 7.5 cm above
      // the rim so the fore-folded boom's inner surface (0.475 − 0.03 = 0.445)
      // passes OVER the body-PV facet corners (r 0.412) and the MGA patch's
      // near corner (az 39.5°, r 0.4236) — measured on the built model (T7,
      // exact point-to-triangle): PV 0.036 / MGA 0.023 m. The plan's 0.47 came
      // from the probe's 8-point boom sampling (MGA "0.023"); the real Ø60 mm
      // tube at 0.47 clears the MGA corner by only 0.0178 — under the T7 (i)
      // gate of 0.020 — so the pin rose 5 mm (WING_GAP_M shrank 5 mm to keep
      // the pack r_max at 0.546; it later grew to 0.020 to clear the boom, r_max
      // 0.560 — see WING_GAP_M). The P1 ring is still the rim r 0.40; the
      // bracket box spans r 0.37..0.51 (the amended band's top).
      HINGE_R_M: 0.475,
      HINGE_Z_M: -1.0,             // rim plane

      // ── Design 7b two-layer folding plate (GEO-comsat pattern) ──
      // Each 1.50 × 0.60 plate (1.70 before 2026-10-16) is a 0.30 m CENTRE panel on the boom plus two
      // FULL 0.15 m wings hinged along the boom line on 2.5 cm offset hinges
      // (butt-jointed when open — width 0.60, area 3.582 m² built: 3.60 less the
      // wings' 15 mm tip inset; test-FlowerPose). For launch the wings fold onto the centre side by side
      // (one layer, meeting edge-to-edge at the boom line) and the strut
      // swings to θ 0: four 0.32 × 0.117 × 1.50 m packs (hinges included) along the
      // barrel. Wing angle is a pure function of θ (lanyard law, T4) — no new
      // persisted state; orbit always shows them open.
      PLATE_CENTRE_HALF_WIDTH_M: 0.15,   // centre panel ±0.15 (wings 0.15..0.30)
      // Folded layer gap. Was 0.005 — measured 2026-09-24 (owner: "some magic
      // handwaving", tmp/radiator-fold-audit.mjs): the Ø60 mm boom stands
      // 15 mm proud of the centre panel's faces, so at 5 mm the folded wings
      // sat 10 mm deep in the boom along their whole length. 0.015 exactly
      // touches it; 0.020 clears it by 5 mm (tmp/radiator-fold-fix.mjs).
      // Hinge-axis standoff = (gap + thick) / 2 = 0.025 below the mid-plane.
      WING_GAP_M: 0.020,
      // The wings stop this far short of the plate's tip end: folded, they
      // move under the centre panel, where the Ø100 mm tip boss (boom x
      // 2.44…2.505 at the old 2.5 m boom; it moves with the boom end, so about
      // 2.24…2.305 at 2.30 m — shifted by 0.20, not re-probed) would otherwise
      // hold their last 10 mm (measured, same probes). 15 mm → 5 mm clear of the boss.
      WING_TIP_INSET_M: 0.015,
      // Real hinge hardware on each fold line (the design booked 0.4 kg per
      // strut for "the two wing hinge lines" and never built them — nothing
      // joined a wing to the centre panel). Two hinges per line, each a
      // panel-side lug and a wing-side lug on one axis: a barrel of radius
      // (standoff − thick/2) = 10 mm, which touches the centre panel's lower
      // edge AND the wing's inner edge in every pose, with a 2 mm leaf bolted
      // along the face it belongs to.
      WING_HINGE_X_M: [-0.6, 0.6],  // hinge centres, along the strut from the plate centre
      WING_HINGE_LUG_M: 0.04,       // each lug's length along the axis (lugs 10 mm apart)
      WING_HINGE_LEAF_M: 0.03,      // leaf reach from the axis across the panel face
      WING_SEAM_M: 0.02,           // dark hinge-seam strip on the centre panel's edge (reads at 3 m)
      SEAM_END_INSET_M: 0.01,      // both seam sets stop 1 cm short of each panel end (log-depth: end caps never coplanar)
      // (KNUCKLE_M [0.08, 0.03] — the buried centre-panel knuckle blocks — removed 2026-09-09 with the set itself, owner's request; the wing knuckles are sized inline in _buildFlowerPair)
      WING_OPEN_DEG: 180,          // deployed dihedral — 180 = wings flat in the plate plane (owner Q4)
      WING_OPEN_START_DEG: 60,     // lanyard: the wings start opening at θ 60° …
      WING_OPEN_END_DEG: 90,       // … and latch flat by θ 90° (the full bloom)

      // ── Geometry (probe 2 §1/§4: min enforced-cone clearance with THIS
      //    plate at stow/park/cargo = 0.571/0.746/1.062 m — all ≥ 0.15 floor;
      //    plate root 0.601 m off the Y3 X=0 sweep plane vs 0.28 grant) ──
      STRUT_LENGTH_M: 2.30,        // v12-radiator-20 (owner 2026-10-16, "20 cm, please"): was 2.5; tips end just inside the docking collar (closed 2° pad top z 1.305 vs ring front face 1.320). Bare-strut band ceiling 148.76° > reserved 146° was measured at 2.5
      STRUT_RADIUS_M: 0.030,       // boom tube
      PLATE_HALF_WIDTH_M: 0.30,    // TANGENTIAL half-width (allocation clause)
      PLATE_START_M: 0.75,         // ≥ w/2 + 0.28/sin45 off the sweep plane (probe §1e)
      PLATE_END_M: 2.25,           // 0.05 m bare at the tip for the hardpoint (was 2.45)
      PLATE_THICK_M: 0.03,

      // ── Pose ladder (probe 2 §4; θ from +Z, α_aft = 180° − θ — P1 ledger
      //    §10 row 7 convention). The orbit band was [90°,146°] until
      //    DECISIONS §15 row 4 (2026-10-08) added CLOSED below it. ──
      //
      // CLOSED — the orbit REST pose, FULLY FOLDED at 0° (owner 2026-10-16: "radiator struts should start in fully
      // closed position. The slightly open position after clamp release is just too much reality for a sim,
      // confusing, not needed now. Perhaps later for advanced players or flight engineers that care about every
      // detail"). It was 2° (DECISIONS §15 row 4, 2026-10-08/09) only to keep the repo's 20 mm design margin while a
      // daughter strut swings past. Measured 2026-10-16 on the built model (probe on main 01c96e30; real meshes
      // incl. the daughters and hinge parts, exact point-to-triangle, ±3 mm):
      //
      //                                      radiator 0°            radiator 2°
      //   min gap, strut sweep 0-180°        9.6 mm (strut 9.0°)    26.1 mm (strut 6.9°)
      //   strut held at 0° / at 34°          50.9 mm / 23.5 mm      54.9 / 50.6 mm
      //   strut angles under 20 mm           3-15° (25 of 361)      none
      //
      // No contact anywhere (closest pair: the daughter clip on strut 3 vs that radiator's plate). Net-launch path
      // 305 mm (385 at 2°), plume cones 0.325 m (0.326). So a stowed radiator
      // is held to a 9 mm margin (test-StartPose D0), every other angle keeps 20 mm. Older rows, 2026-10-09
      // (tmp/probes/start-pose-fold.mjs, 20 mm gate): θ 1 → 18.5 mm, 1.5 → 22.5, 5 → ≥ 40; fixed hull 21.8 mm
      // at 0° (MGA patch), 45.2 at 2°; wings at their 5° dodge 40.9 mm at 0°, 78.3 at 2°.
      // Every θ 0-90 sits fore of every FEEP apex (3-D ≥ 0.325 m to the 35° cones), so thrust is allowed over the
      // whole driver band [0°, 146°]. The side-wings fold on the lanyard below 60°. Power/sensor costs of a folded
      // radiator (measured at 2°, 2026-10-09; not re-measured at 0°): solar sphere average 527 W vs 634 W at the
      // bloom, the folded packs block most of the MGA patch and sun sensors 2/3.
      POSE_CLOSED_DEG: 0,
      REST_POSE: 'CLOSED',         // the orbit rest (D4 contract: boot, the
                                   // opening dance, every endState(), O's
                                   // closed end); 'STOW' is the old bud
      // The OPEN pose — 146° (owner 2026-10-09, DECISIONS §15 "Radiator
      // angles"): what O, the F1 bar, the REFIT chip and the heat auto-open
      // all open a closed radiator to, and where it settles back to from 180°
      // (RETURN_TO_OPEN_S below, or at once when ion thrust is commanded).
      // The player can still push on to POSE_VENT_DEG (180°) or fold to 0°.
      OPEN_POSE: 'STOW',
      // θ of REST_POSE — the ONE rest-pose → angle mapping (PlayerSatellite.
      // _flowerRestDeg and OpeningDance both read it). An unknown name falls
      // back to the 146° bud, the owner's stated fallback.
      get REST_DEG() {
        const F = Constants.THERMAL.FLOWER;
        const map = { CLOSED: F.POSE_CLOSED_DEG, STOW: F.POSE_STOW_DEG, PARK: F.POSE_PARK_DEG, CARGO: F.POSE_CARGO_DEG };
        const deg = map[F.REST_POSE];
        return Number.isFinite(deg) ? deg : F.POSE_STOW_DEG;
      },
      // θ of OPEN_POSE — same mapping as REST_DEG; an unknown name falls back
      // to POSE_STOW_DEG (146°), the owner's stated open angle.
      get OPEN_DEG() {
        const F = Constants.THERMAL.FLOWER;
        const map = { CLOSED: F.POSE_CLOSED_DEG, STOW: F.POSE_STOW_DEG, PARK: F.POSE_PARK_DEG, CARGO: F.POSE_CARGO_DEG };
        const deg = map[F.OPEN_POSE];
        return Number.isFinite(deg) ? deg : F.POSE_STOW_DEG;
      },
      // Real seconds a radiator pushed past OPEN_DEG (to POSE_VENT_DEG) may
      // sit there after the player's last radiator command before it settles
      // back to OPEN_DEG by itself (DECISIONS §15, owner 2026-10-09).
      RETURN_TO_OPEN_S: 30,
      // "…unless debris blocks the path" (owner 2026-10-09). Measured
      // 2026-10-10 (lane w3-radiator-146, tmp/radiator-intrusion-probe2.mjs,
      // real petal + ArmUnit meshes, spheres of the cargo's size at the game's
      // own heldSlotAnchorInto slot, lateral axis swept 360°): the struts, the
      // docked daughters and the nose-collar catch clear the petals over
      // θ 146–180° (≥ 158 mm; the gate is 20 mm), but CARGO HELD ON A DOCKED
      // DAUGHTER overlaps them while that daughter's strut angle α is low.
      // Rows [sizeMeter ≤, first α in degrees (5° grid) that clears 20 mm for
      // petals anywhere in 146–180°]; a size between rows takes the next
      // (deeper) row, unknown size the last. Coarse: sphere model, ±~40 mm
      // point-cloud thinning. While any such cargo sits below its row the
      // automatic swings to OPEN_DEG (the 30 s settle, the ion-thrust swing)
      // wait; the player's own commands are untouched (DECISIONS §11: held
      // cargo is out of scope for the fold corridor).
      // RE-MEASURED 2026-10-19 (lane rack-snug, Decision 6): a parked rack catch is no longer a sphere on a world-up ring at
      // the strut tip — it is the REAL drawn mesh in a cell on the daughter, beside her end, fixed in her frame
      // (ArmUnit.rackCellOffsetInto). tmp/rack-snug-radiator-probe.mjs (shared code js/test/_rackSnugRadiator.js, fixture
      // js/test/fixtures/rack-snug-radiator.json): 4 real daughters × cells 0,1 × the 30 seeded catch attitudes in her frame
      // (js/test/_rackSnugAttitudes.js) × α 0–90° (5° grid) × every size/type case (every fragment mesh; defunctSat to
      // 9.2 m and rocketBody to 12.65 m, the largest the game spawns) against every petal triangle over θ 146–180° (2°
      // steps), clear = 20 mm. A case's value is the smallest grid α from which every higher α clears. Old → new:
      // 25→15 (≤ 0.5 m), 30→25 (≤ 1 m), 35→30 (≤ 1.5 m), 40→55 (beyond: rocketBody 8 m sets it; defunctSat 9.2 m 55,
      // 8 m 50). Small cargo now clears sooner (it sits beside her end, not 1 m round the ring); the large rows rise
      // (a long body parked beside her end reaches the petals farther out). Every row still sits below the plume floor.
      // RE-MEASURED 2026-10-19 (lane rack-centre, owner "debris is off center from daughter"): the cells moved ONTO her
      // axis (cell 0 centred, cell 1 stacked beyond it: ArmUnit.rackCellOffsetInto). Same probe
      // (tmp/rack-snug-radiator-probe.mjs → js/test/fixtures/rack-snug-radiator.json) and sampling; a cell-1 placement
      // has a second piece of the SAME case in cell 0 (3 of the 30 attitudes: js/test/_rackSnugAttitudes.js
      // `belowAttitudeIndices`). Old → new: 15→20 (≤ 0.5 m), 25→30 (≤ 1 m), 30→35 (≤ 1.5 m), 55→80 (beyond: defunctSat
      // 8 / 9.2 m and rocketBody 8 / 11 / 12.65 m all 80, rocketBody 5 m 75, defunctSat 5 m 65, rocketBody 3 m 55,
      // defunctSat 3 m 45, defunctSat 2.2 m 35).
      // FIX ROUND 1 (lane rack-centre, 2026-10-19, review): the single beyond row (80°, set by 8–12.65 m hulls) sat above
      // the plume floor of the 1.6–2.8 m class (65°), so a 2.2 m catch re-posed to its plume floor would still have held
      // the radiator's automatic swing back until 80°. Rows added at ≤ 2.8 m and ≤ 5 m (the plume ladder's bounds); same
      // probe (cases defunctSat/rocketBody 2.8 m added; --skip-checks), same fixture. Old → new (this lane's first
      // numbers → now): 80 → 50 (1.5–2.8 m: rocketBody 2.8 m 50, 2.8 defunctSat 40, 2.2 defunctSat 35), 80 → 75 (2.8–5 m:
      // rocketBody 5 m 75, defunctSat 5 m 65, rocketBody 3 m 55, defunctSat 3 m 45), beyond 80 (unchanged: defunctSat 8 /
      // 9.2 m, rocketBody 8 / 11 / 12.65 m). Every row now sits below the plume floor of its class (25/41/65/99/125/134°).
      CARGO_CLEAR_ALPHA_ROWS: [[0.5, 20], [1, 30], [1.5, 35], [2.8, 50], [5, 75], [Infinity, 80]],
      POSE_STOW_DEG: 146,          // band-edge bud: θ→180° camps the Y3 axial
                                   // reserve (r ≤ 0.45, ANY R — probe §2
                                   // discovery) and is plume-illegal for
                                   // R > 1.714 m under thrust
      POSE_PARK_DEG: 135,          // radiator-duty pose (P3/P5 consume via
                                   // setFlowerPose; brief §2.1 pose grammar)
      POSE_CARGO_DEG: 90,          // the 90° bloom — tips at the rim plane, fore
                                   // of the cone apexes, plume-clear at any R.
                                   // Still a valid angle (dev flag, openFrac's
                                   // full scale); nothing in play commands it
                                   // since OPEN_POSE became 146°
      POSE_FLOOR_DEG: 0,           // θ ≥ CLOSED in ORBIT — enforced IN the driver
                                   // (= POSE_CLOSED_DEG = POSE_LAUNCH_DEG since
                                   // 2026-10-16; it was 2, and 90 (the bloom)
                                   // before DECISIONS §15 row 4). Also the low
                                   // edge of the thrust band.
      // Tip stalks (leash tip hardware, PlayerSatellite._updateTipStalks): retracted at or below this θ and linearly out
      // over the next 1° — 2°..3°, as when the closed floor was 2°. Its own constant: the floor is now 0°.
      STALK_FROM_DEG: 2,
      POSE_THRUST_MAX_DEG: 146,    // P1 global keep-out 7 (reserved band edge)
      // VENT — the deliberate over-open pose past the bud, reached only by a
      // double-command (PlayerSatellite.toggleFlowerDeploy) and warned in COMMS.
      //
      // Owner ask was "almost 180", then explicitly "full 180 for radiators,
      // into exhaust cone, with warnings" (2026-09-22). An earlier pass set
      // this to 158 — the last θ clear of BOTH hazards — which confused a
      // HAZARD with a WALL. Re-measured on the built model
      // (tmp/full180-collision-probe.mjs): nothing physically blocks the swing.
      //
      //     θ     cone clear   Y3 camped   nearest hull mesh
      //    146      0.712        0.000       0.0531   ← the bud
      //    158      0.094        0.000       0.0487
      //    160     -0.005        0.000       0.0481   ← enters the plume cone
      //    171.5    ~-0.6        0.000+      0.0458   ← starts camping Y3
      //    180      -0.935       1.662       0.0452   ← full open
      //
      // The tightest PHYSICAL gap over the whole 146→180 sweep is 45.2 mm to
      // Barrel_ConfigG at 180°, against the project's 20 mm gate; furled-coil
      // penetration is 0.000 throughout and deck clearance never drops below
      // 0.145 m. So 180 is reachable and the arm never touches the ship.
      //
      // What 180 costs is real but is not a collision: the panel sits 0.935 m
      // INSIDE an exhaust cone and camps 1.662 m of the Y3 axial reserve. Both
      // are warned in COMMS (POSE_VENT_CONE_DEG / POSE_VENT_Y3_DEG below).
      // Thrust is already refused above POSE_THRUST_MAX_DEG by
      // _flowerPoseBandGuard, so the cone is only dangerous if the drive could
      // fire — and it cannot. No safety rule is relaxed to allow this pose.
      //
      // 146 still is not arbitrary: it is exactly where exhaust standoff
      // reaches its 0.70 m floor, which is why the bud sits there.
      POSE_VENT_DEG: 180,
      // Measured warning thresholds on the way out (0.5° sweep,
      // tmp/vent-thresholds.mjs). Used for the escalating COMMS lines only —
      // neither is a limit, and neither stops the swing.
      POSE_VENT_CONE_DEG: 160,     // first θ inside an enforced plume cone
      POSE_VENT_Y3_DEG: 171.5,     // first θ camping the Y3 axial reserve
      // Window for the second bud command that pushes through to the vent.
      // Long enough to be a comfortable deliberate double-tap, short enough
      // that two unrelated stow presses never read as one.
      VENT_DOUBLE_TAP_MS: 600,
      // Design 7b LAUNCH pose: θ 0 — the strut lies FORE along the barrel with
      // its wings folded (four 0.30 × 0.101 × 1.50 m packs at r ≤ 0.560, tips
      // z 1.305 at the 2.30 m boom; 0.546 and 1.505 when the probe 7b.4c B′ below was run: MGA 0.023 / PV 0.031 / weaver 0.025 / coil
      // 0.032 m). Reachable ONLY under the launch lock: setFlowerPose('LAUNCH')
      // while a launch driver is active, the ?shot=1 dev hook with
      // { force: true }, or — owner amendment 2026-09-09 — the SAFETY OVERRIDE
      // sweep with { override: true } (PlayerSatellite.toggleFlowerOverride);
      // the lock clears the frame the release swing reaches POSE_FLOOR_DEG and
      // re-arms from orbit ONLY under OVERRIDE. The driver targets
      // POSE_LAUNCH_DEG − 0.5° and lets the floor clamp hold θ at exactly 0
      // (no SETTLE_EPS residual — the mock stopped 0.5° short).
      POSE_LAUNCH_DEG: 0,
      // DECISIONS §10 (2026-09-23) — the automatic solar-wing dodge. The
      // wings never make the radiator wait: the tilt law itself clamps to a
      // clearance curve measured against the REAL meshes (the rebuilt
      // tmp/probe-rosa-tilt.mjs and tmp/every-door-fine.mjs; validation: the
      // bloom clash reproduces the DECISIONS §5 Debt number exactly — 16.7 mm
      // at tilt 18°, θ 90). Two curves, one clamp (the minimum):
      //
      //   θ-curve (petals ↔ wings, tightest tilt keeping the 20 mm gate):
      //     7° at θ 0, 20° at θ 10, 18° at θ 20, 15° plateau θ 30–90,
      //     unconstrained (≥30°) above θ 100; non-monotone at θ 80–90 (the
      //     gap recovers at 25–30°) — the law uses the conservative prefix.
      //   α-curve (struts+daughters ↔ wings, at the orbit rest): no
      //     constraint at α 0–5 and α 80–180; inside α 10–75 the ceiling
      //     runs 30–60° with contacts at every feather-range tilt — i.e.
      //     only FEATHERING (60–120°) clashes, never the ±30° tracking.
      //
      // With margin (the limits sit ≥3° under the measured safe prefix at
      // every grid point):
      //
      // 2026-10-09 re-measure (lane w2-start-pose, tmp/probes/start-pose-fold.mjs
      // §A, 1° tilt steps, conservative prefix): safe tilt 6° at θ 0, 8° at
      // θ 2 (CLOSED), 15° at θ 5, 15–16° across θ 10–90, 17° at θ 95–97 and
      // unconstrained (30°) from θ 98. The MID threshold was 95, so the law
      // let a wing track 18–30° at θ 95–97: raised to 100 (the "above θ 100"
      // the curve above already said). And the clamp now takes the LOWEST θ
      // of a commanded swing from the command on (`_rosaDodgeLimitRad`): with
      // the θ thresholds alone (MID 100) a close 146° → 2° with the wings
      // feathered touched a petal (0.0 mm at θ 80), 90° → 2° came to 18.1 mm
      // and the 146° → 90° O-press 13.5 mm (14.8 with MID 95, as shipped);
      // with the early clamp they are 78.5 / 66.9 / 59.1 mm (§G).
      WING_DODGE_LOW_THETA_DEG: 8,    // below this θ (folded flat): 5° limit
      WING_DODGE_LOW_LIMIT_DEG: 5,    // (measured 7° at θ 0; 8° at θ 2)
      WING_DODGE_MID_THETA_DEG: 100,  // below this θ (fold corridor + bloom): 12°
      WING_DODGE_MID_LIMIT_DEG: 12,   // (measured ≥15° across θ 20–90, 17° at 95–97)
      WING_DODGE_ALPHA_LO_DEG: 5,     // strut-α band inside which feathering
      WING_DODGE_ALPHA_HI_DEG: 80,    // contacts the wing root hardware
      WING_DODGE_ALPHA_LIMIT_DEG: 25, // (measured ceiling ≥30° across α 10–75)
      // DECISIONS §11 (2026-09-23, hinge +10cm / strut +10cm) re-measured
      // (tmp/every-door-fine.mjs, tmp/every-door-dodge-limit.mjs): the raw
      // (undodged) contact zone is α≈14–54 (worst 1.29 mm at α24, feather120)
      // — still inside the [5,80] band with margin on both sides — and at the
      // clamped 25° limit the worst gap across α 0–90 is 100.7 mm, nowhere
      // near the 20 mm gate. All three constants stand unchanged.
      // The clamp is applied AFTER the feather blend (the dodge wins over a
      // feather request while the radiator is low or a strut is swung), and a
      // fold in flight uses the LOW limit from the moment it arms — the wing
      // motor (rate 1.75/s, τ ≈ 0.57 s) then beats the radiator to every θ
      // by ≥1 s (feather 120° → 5° takes 2.05 s; the constraint first binds
      // below θ 95, 3.4 s into the 15°/s swing). Power cost: the clamp only
      // binds when the sun is off the wing plane by more than the limit —
      // worst case ~5% of wing power at the bloom park (cos 18°), ~9% folded
      // (cos 25°, while a folded radiator shadows the wings anyway), ~0.4%
      // with struts aimed (cos 5°).

      // The ROSA is not the only thing in the fold corridor. The DAUGHTER ARMS
      // root at z +0.90 r 0.40 (az 64/116/244/296) and the petals fold FORE
      // past them — the folded plate and a swung-out strut can occupy the
      // same space (tmp/fold-vs-strut-fine.mjs, tmp/interlock-numbers.mjs).
      // DECISIONS §11 (2026-09-23, ratified): a new player can't read a
      // halfway-stop interlock, so the fold no longer waits for the struts —
      // FOLD_ARM_STOW_TOL_DEG and the wait it drove (`_armsStowedForFold`,
      // `_noteArmStowWait`) are REMOVED. Held cargo in the corridor stays out
      // of scope (not measured here).

      // ── Slew (daughter-stack mirror; drift-guarded ===
      //    OCTOPUS_V5.STRUT_SLEW_RATE by test-FlowerPose.js) ──
      SLEW_RATE_RAD_S: 15 * Math.PI / 180,   // 15°/s — full O swing 146°→90° in 3.73 s
      SETTLE_EPS_RAD: 0.01,        // latch clears within 0.01 rad (daughter contract)

      // ── Mass (probe 4: plate 1.02 m² × 9 kg/m² sandwich + 2.5 m boom
      //    ≈ 1.0 kg/m + bracket/bosses/tip 0.82 kg = 12.5 kg per strut).
      //    Design 7b re-price: +0.4 kg/strut for the two wing hinge lines
      //    (piano hinges, torsion springs, two latches, the taller clevis — an
      //    engineering estimate, not a probe number) → 12.9 / 25.8. Budget
      //    taxes at full tanks re-derived with tmp/flower-mass-budget.mjs:
      //    pair A −288.7 m/s (2896 → 2607), pair B −236.3 m/s (2607 → 2371)
      //    (the shop rows SAY this out loud — §8.1 doctrine). ──
      STRUT_DRY_MASS_KG: 12.9,
      PAIR_DRY_MASS_KG: 25.8,

      // v12-radiator-20: STRUT_LENGTH_M is now 2.30 (was 2.5). These bands were derived at R 2.5 and are NOT re-derived for 2.30 (tmp/flower-pose-band.mjs
      // hard-codes its R 2.5 gates); nothing in js/ reads TIP_BAG_BANDS (rg), only test-FlowerPose's paper-pin check. A rough re-sweep at the earlier
      // 25 cm step (R 2.25; tmp/probes/rs-bands.mjs, a coarser method that does not reproduce the 2.5 figures) said the bands move by a few degrees;
      // none was run at 2.30: re-derive before P5 uses them.
      // ── Per-size tip-bag pose bands (probe 2 §1c′, R=2.5, exact tip-sphere
      //    vs enforced cones at the LIVE pin — hinge r 0.475, stations
      //    40/140/220/320; tmp/flower-pose-band.mjs reads both from this
      //    block: exact 146.0000 / 137.6014 / 125.7107 / 115.5860). Design 7b
      //    re-derived them (was 146.0 / 136.7 / 124.8 / 114.6 at 45 / 0.40 —
      //    kept in the probe as its §0-class gate): every band widens slightly
      //    because the taller clevis moves the tip outboard, farther from the
      //    cones. PAPER PIN for P5 — tips are INERT at P2 (no booking, no
      //    cargo logic). Whale-class NEVER goes aft. ──
      TIP_BAG_BANDS: [
        { bagRadiusM: 0.5, maxThetaDeg: 146.0 },
        { bagRadiusM: 1.0, maxThetaDeg: 137.6 },
        { bagRadiusM: 1.5, maxThetaDeg: 125.7 },
        { bagRadiusM: 1.9, maxThetaDeg: 115.6 },
      ],
    },
  },

  // ============================================================================
  // EPIC 9 FEATURE FLAGS (default false; flipped on per shipyard/shop unlock)
  // ST-9.9 Reality Mode toggle forces ALL of these to false at runtime.
  // ============================================================================
  FEATURE_FLAGS: {
    LASER_DESPIN:          true,   // CP-2 ON — mother-mounted de-spin laser (hold L) + net tumble coupling
    REALITY_MODE:          false,  // ST-9.9 — locks all FEATURE_* false (master)

    // The OPENING DANCE (2026-09-16) — the ship unpacks itself. Starts in the
    // menu as the EVA astronaut jets off the hull she is welding, cascades
    // radiator → solar wings → daughters at the SHIPPED hardware rates, and
    // hands the player the wheel ~7.8 s after the menu cuts away. Off = the
    // ship simply boots deployed (OpeningDance.endState), exactly as before.
    // This REPLACED the 60 s rocket launch (that sequence, its cinematic and
    // its switch were removed 2026-10-16); no scaffolding for a "full launch"
    // exists, deliberately.
    OPENING_DANCE:             true,
    // Scripted launch-plume cameo from the player's home spaceport during the
    // opening orbital pass (js/scene/LaunchCameo.js). AMBIENT extends it: any
    // pad fires a plume as it orbits into visual range (rate-limited, silent).
    LAUNCH_CAMEO:              true,
    LAUNCH_CAMEO_AMBIENT:      true,
    COM_TRACKING:              false,  // ST-9.12 — center-of-mass tracking
    THRUSTER_INTERLOCK:        false,  // ST-9.12 — plume geometry check
    SEMI_AUTO_AIM:             true,   // ST-9.3  — Mother auto-rotation aim (aim-before-launch)
    LOCKABLE_HINGE:            false,  // ST-9.3  — ROTATE ↔ LOCKED hinge

    // Manual-flight navigation aids: prograde/retrograde velocity markers +
    // closure-rate/ETA readouts on the target reticle. OFF by default — the
    // mother flies on autopilot and is nudged with the arrow keys, so KSP-style
    // burn-vector tooling is just orbital flavor in the core loop. Reserved for
    // advanced missions where the autopilot is degraded/damaged and the pilot
    // must hand-fly the rendezvous. (AP heading cue rides along with these.)
    MANUAL_NAV:                false,

    // NEW — ST-9.4 C-6: Capture Net System
    CAPTURE_NET:               true,   // ST-9.4  — full capture net projectile + inventory (P1 ON)

    // NEW — CP-1 / DAUGHTER_MULTITOOL_SPEC: real per-arm tool choice
    DAUGHTER_MULTITOOL:        true,   // P2 ON — tool-selection HUD, backtick cycle, MAGNETIC_GRAPPLE
    WEAVER_GRIPPER:            true,   // P3 ON — Weaver tertiary gripper jaws (GRIPPER_GRAPPLE)
    SPINNER_PAD:               true,   // P4 ON — Spinner secondary multi-modal pad (PAD_CONTACT)

    // NEW — P2 aft flower preview (owner ruling 2026-08-27: "just flip it on.
    // you can flip it off later p3"). ON: both flower pairs are pre-installed
    // at boot (stowed bud; O deploys) and the two shop rows are HIDDEN so
    // nobody pays credits for hardware already aboard. The 50 kg mass tax
    // rides along honestly (hardware aboard = mass aboard). P3 flips this to
    // false when the thermal loop lands and the shop becomes the real gate —
    // that flip is a licensed FEATURE_FLAGS-pin re-derive (43→…, count pin in
    // test-Constants.js) plus nothing else: the purchase path, mass carrier,
    // and byte-identity tests below it are already flag-agnostic.
    FLOWER_PREINSTALLED:       true,

    // NEW — C-11 Integration: Recoil Physics (deferred from C-3)
    RECOIL_PHYSICS:            true,   // C-11 — angular impulse from dual-fire + mother-net launch applied to Mother (2026-07-23: wired to a real transient-attitude integrator; was a dead accumulator)

    // NEW — Q2 Net-Launch Ceremony (CEREMONY_REDESIGN.md §5)
    NET_CEREMONY:              true,   // Q2 net-launch ceremony; default ON (Stage 6 flip, 2026-05-24)

    // NEW — CP-3 / BIG_PICTURE §24: cluster transfer-ellipse + launch-window countdown
    CLUSTER_TRANSFER_WINDOW:   true,   // CP-3 ON — DebrisMap shows Depart/Arrive/ΔV + countdown per selected cluster

    // NEW — capture-feedback overhaul Phase 2: orientation-based capture.
    // Presented-width gating (broadside 0% → end-on ~100%) at contact +
    // reel; togglable during tuning like CAPTURE_NET / LASER_DESPIN.
    ASPECT_CAPTURE:            true,

    // NEW — capture-feedback overhaul Phase 3a: hold Shift → boost reel ×2.
    // Impatience is allowed but priced: boost raises net-rip + snap risk.
    REEL_BOOST:                true,

    // NEW — reel-in/re-dock inertia overhaul (reel-in-redock-inertia plan).
    // Trapezoidal haul velocity profile (Q1) + combined-mass tension (Q2) +
    // explicit SNUG rigidize (Q3) + FEEP soft re-dock arrest with yoke
    // tether-plume clearance (Q4). ON since 2026-08-27 (wave1 flip): catch mass
    // now prices the haul home — power-bounded cruise v=√(P/(m_unit·coeff)),
    // snap-invariant tension cap, SNUG cinch, one-shot FEEP arrest debit
    // (MISSION1_FREE). The legacy constant-speed reel (REEL_IN_SPEED_*) remains
    // the flag-OFF fallback, unchanged and test-covered.
    REEL_PROFILE_V2:           true,

    // reel-home (2026-10-19, owner design): a daughter does not jump to her catch. Her net winds the catch in to her
    // nose first (the pair's centre of mass stays put), then the strut reel winds her home TAIL-FIRST onto the strut
    // tip, catch leading away, the strut swinging and the mother turning to meet her line. Off: the old path
    // (jump to the catch, nose-first reel, catch outboard of her). Read through Constants.isFeatureEnabled('REEL_HOME'),
    // so REALITY_MODE can never turn it on.
    REEL_HOME:                 true,

    // NEW — mother-net capture ceremony (.kilo/plans/mother-net-capture-ceremony.md)
    // Phase 2: kinematic net open-on-launch + cinch-on-capture animation.
    LASSO_NET_KINEMATICS:      true,   // Phase 2 — net opens on spin-up, cinches on contact (visual only)
    // Phase 3: mass-driven reel tension, CoM pull, tangle/break risk. Still hard-
    // gated OFF on M1 and for ≤ LASSO_MAX_CAPTURE_MASS regardless of this flag.
    LASSO_REEL_PHYSICS:        true,   // Phase 3 — real reel tension + ship pull + break risk (M2+/heavy only)
    // 2026-08-26 — the SHORT lasso-catch cut (owner: "the capture deserves a
    // tasteful, SHORT presentation — never a beat reel"). A single continuous
    // ~3 s catch-framed shot from wrap contact through the reel escort,
    // S4 grammar (catch framed, ship as context), the HUD dimmed only while it
    // runs (the black letterbox bars left 2026-09-09), released before
    // digestion, aborted instantly by ANY player input, skipped under
    // prefers-reduced-motion and while any key is already held.
    // Rides NET_CEREMONY (the cinema-mode HUD contract); OFF = post-4988797
    // player-cam-only behaviour, byte-identical.
    LASSO_CATCH_CUT:           true,

    // 2026-08-27 — CAPTURE_NET.md §11.4/§11.3 momentum-torque audit, daughter
    // side. ON: a daughter net launch (fireDaughterNet via ArmUnit NETTING)
    // kicks the daughter back by Δv = m_net·LAUNCH_SPEED / m_daughter
    // (≈1.03 m/s MEDIUM/Weaver, ≈0.57 m/s SMALL/Spinner — derived live from
    // Constants, never hardcoded), modeled as a critically-damped transient
    // the SK/NETTING hold loop visibly fights and re-absorbs (~1–2 s), with a
    // FUEL_RATE_MANEUVER-style RCS surcharge billed for the recovery, plus the
    // §11.3 reaction-wheel scalar (per-fire increment, slow bleed, saturation
    // ⇒ paid RCS desat per subsequent fire). Tuning: Constants.DAUGHTER_NET_RECOIL.
    // OFF = byte-identical legacy behaviour (zero displacement, zero billing).
    // Mother pod recoil (PlayerSatellite._applyMotherNetRecoil) is untouched.
    DAUGHTER_NET_RECOIL:       true,

    // 2026-08-27 — CAPTURE_NET.md §11.5 momentum-torque audit, daughter side
    // (the audit's "highest gameplay value" item, #1 in the §11.8 order).
    // ON: a daughter NET catch no longer arrests the target's spin angular
    // momentum for free. L = Iω is computed from the debris' LIVE tumble at
    // the cinch (I = 0.1·m·d², solid-sphere model) and transferred into a
    // visible critically-damped settle of the caught bundle over
    // t_settle = L/τ_tether (clamped ~2–4 s; the audit's τ = L/t_settle,
    // solved for time). A cleanly settled catch ends de-spun (tumbleRate 0).
    // Above STRAIN_GATE_DEG_S the wrench rolls a recoverable net rip
    // (NET_FAILED/NET_TORN, boost-rip idiom): the catch drifts free with the
    // UN-transferred remainder resumed as real tumble — lasing a tumbler
    // below the gate before netting is now the correct play, which is what
    // makes LASER_DESPIN a torque-management necessity instead of a
    // cling-probability buff. Tuning: Constants.CAPTURE_TORQUE_SETTLE.
    // Daughter net-FSM captures only; the mother lasso/berth spine (M1
    // onboarding) is untouched. OFF = byte-identical instant-arrest legacy.
    CAPTURE_TORQUE_SETTLE:     true,

    // Debris cutting step 5 — call the cut planner when a collared catch is
    // too heavy for one daughter's rack (over CARGO_TRANSFER.MAX_KG): the
    // collar refuses once, plans pieces at the receiver's limit, and cuts one
    // piece at a time at the nose; each piece flies the same crane arc as a
    // whole catch, and the held remainder leaves last by the ordinary
    // transfer. No cooking while cutting. Tuning: Constants.CAPTURE_NET.CUT_S.
    // OFF = byte-identical legacy (the whole body rides the collar until the
    // furnace takes it, or jettison [K]).
    CUT_AT_NOSE:              true,

    // Leash hand-off (lane l5b-wire; docs/research/2026-10-leash.md, DECISIONS §1):
    // a small mother catch (radius <= 0.75 m, TipCargo MAX_BAG_R_M) leaves the nose on its own leash and
    // is reeled onto a radiator tip (js/systems/LeashDriver.js). OFF = the catch
    // goes by today's flight to a daughter's rack (CaptureNetSystem._updateCargoTransfer).
    LEASH_HANDOFF:            true,

    // Daughter-arm automation (lane arms-auto; DECISIONS §25 ruling 5): the struts
    // move on their own (0° idle, 34° when a piece is within 90 m), a "." press
    // holds 10 s, and the full range is shown once per player. OFF = manual only.
    STRUT_AUTO:               true,

    // Launch-aim (lane launch-aim, 2026-10-16): a daughter's strut first swings (at its real
    // 15°/s) to the best angle toward where she is going, then the spring pushes her along the
    // strut; the launch cut-scene never moves a strut. OFF = today's bearing launch + 4x swing.
    LAUNCH_AIMS_STRUT:        true,

    // Furnace cook (lane no-melt, owner 2026-10-18: "debris still magically shrinks, should handoff and stay same size
    // until furnace works and is activated" -> "Stay full size, no melting"). DECISIONS §12 Q3: the collar cook has no
    // hardware behind it. OFF: nothing cooks, melts, chops or shrinks a catch anywhere (radiator tip, nose collar,
    // daughter rack): a catch stays full size where it was parked until the station takes it at the resupply stop.
    // ON: today's staged cook (hold, chop, feed, digested CATCH_PROCESSED), kept for the day a real furnace exists.
    // Read through Constants.isFeatureEnabled('FURNACE_COOK'), so REALITY_MODE can never turn it on.
    FURNACE_COOK:             false,

    // Transfer trip (lane trip-melt-1, owner 2026-10-19, DECISIONS §29 rows 1 and 4: "they need to be melted down in the
    // furnace during the long ion burn/transition to next debris field"). ON: a completed mission does not start the
    // next one at once - the ship burns to the next field for a while (js/systems/TransferTrip.js), the four radiator-tip
    // furnaces melt the catches parked on them (the tip cook runs on the trip only; FURNACE_COOK stays off for the nose
    // collar and the daughter racks), and the next mission starts when the trip ends. OFF: the next mission starts at once
    // and nothing melts. Read through Constants.isFeatureEnabled('TRANSFER_TRIP').
    TRANSFER_TRIP:            true,

    // Fields by height (Nets step 3 slice 2b, DECISIONS §33 rows 6 and 10; js/systems/FieldRegistry.js, TripProfile.js).
    // ON (the default since slice 4, 2026-10-23: the map goes live with the second satellite and the high fields): the debris
    // fields are destinations stacked by height (Constants.FIELDS); a mission boundary flies the mother to another field with
    // her real thruster (the trip plays a climb or descent from the drag-and-thrust profile), fields keep the pieces nobody
    // caught, and the field state and the ship days are saved. OFF (`?fields=0` for a boot): today's game exactly (the flat
    // 20 m/s trip that does not move her, a fresh welcome field every mission, the stop after every mission).
    // Read through Constants.isFeatureEnabled('FIELDS_BY_HEIGHT'), so REALITY_MODE can never turn it on.
    FIELDS_BY_HEIGHT:         true,

    // Melt a big piece for metal (Nets step 3 slice 5, lane 5c adds the flag, lane 5e builds the melt; plan C7). ON since
    // the slice-5 integration (2026-10-24, after 5c and 5e merged; test-BigPieceChain.js runs the chain). Off: the fate
    // list's melt row says "the furnaces cannot take it yet" and cannot be picked. Read through Constants.isFeatureEnabled('BIG_MELT').
    BIG_MELT:                 true,
  },

  // =========================================================================
  // CONFIG G HINGE STATES (NEW — for ST-9.3 #9)
  // =========================================================================
  HINGE_STATES: {
    ROTATE: 'ROTATE',   // motor active, brake disengaged
    LOCKED: 'LOCKED',   // brake engaged, motor off
  },

  // =========================================================================
  // CONFIG G PLUME CLEARANCE (NEW — for ST-9.12 #8)
  // =========================================================================
  PLUME_HALF_ANGLE: 35 * Math.PI / 180,  // rad — sourced: 25.5°±2.5° measured In-FEEP
                                         // beam divergence (LISA Pathfinder qualification) ×1.25
                                         // charge-exchange margin; a real shielded design caps at 60°
  COM_DRIFT_WARN_THRESHOLD: 0.020,       // m (20mm)
  COM_BALANCED_THRESHOLD: 0.005,         // m (5mm)

  // =========================================================================
  // MAIN THRUSTER NOZZLE GEOMETRY (NEW — ST-9.12 C-9, Gap #8)
  // =========================================================================
  // 4 main dual-metal FEEP thrusters on the aft face (−Z), cross pattern.
  // Positions match PlayerSatellite._buildThrusters() visual placement (in
  // meters): radius 0.200 m (mainPositions ±M*0.2), bell exit z −1.075
  // (nozzle body z −1.0, half-length 0.075 — the same plane STOWED_ENVELOPE_LEN
  // calls "FEEP exits −1.075"). CORRECTED 2026-09-24 (DECISIONS §5a): this
  // table used to read 0.500 m / z −2.000 while its own comment claimed a
  // match — apexes were 0.300 m too far outboard and 0.925 m too far aft, so
  // every plume cone under-reached (the real cone is WIDER: at the STOW petal
  // tip the modelled radius was 0.751 m vs the true 1.399 m). A drift-guard
  // test (test-FlowerLaunchFold.js) now measures the built MainFEEP_* meshes
  // against this table so the two cannot silently disagree again — it does
  // not read this table INTO the builder (PlayerSatellite.js is out of this
  // fix's scope), so a future change to either side still needs both edited.
  // Config G clearance analysis (ARM_PIVOT_GAPS_EXPLAINER §8):
  //   Arms sit at azimuths 64°/116°/244°/296° (ROSA at 0°/180°). The measured plume gate is the
  //   radiator's (DECISIONS §5a; test-FlowerLaunchFold.js). The daughter struts have no clearance
  //   floor: `CoMCalculator.checkPlumeInterference` tests each strut tip and any held cargo against
  //   the −Z plume cone at runtime (every frame, via the thrust-block list). Edge case (register item 61's reconciled rows): the Y3 Octo
  //   (flag-gated, unlocked:false) aft end-face arm (−Z) at α≈π/2 places its tip at
  //   z ≈ −2.6 m — past the corrected nozzle plane (−1.075). NOT RE-VERIFIED under
  //   this fix (dormant tier, dormant interlock, out of scope — DECISIONS §5a); any
  //   HELD cargo there still books further aft, where S9's box-chain check sees the
  //   foul on the LIVE Y0_QUAD tier regardless.
  THRUSTERS: [
    { id: 'HT_TOP',    nozzlePos: { x:  0,    y:  0.2,  z: -1.075 }, thrustDir: { x: 0, y: 0, z: -1 } },
    { id: 'HT_BOTTOM', nozzlePos: { x:  0,    y: -0.2,  z: -1.075 }, thrustDir: { x: 0, y: 0, z: -1 } },
    { id: 'HT_RIGHT',  nozzlePos: { x:  0.2,  y:  0,    z: -1.075 }, thrustDir: { x: 0, y: 0, z: -1 } },
    { id: 'HT_LEFT',   nozzlePos: { x: -0.2,  y:  0,    z: -1.075 }, thrustDir: { x: 0, y: 0, z: -1 } },
  ],

  // =========================================================================
  // TAIL ION-BOX GLOW — lerp rate and nozzle-liner emissive for the four tail boxes.
  // (Name kept from the old per-nozzle turn mapping, removed 2026-10-22: turns are cold
  // gas and light only the bells; these boxes glow only while the ion engine pushes.)
  // =========================================================================
  DIFFERENTIAL_THRUST: {
    LERP_RATE: 8,                    // per-second exponential approach rate (matches legacy glow lerp)
    INNER_EMISSIVE_BASE: 0.3,       // idle emissive intensity for nozzle interior liner
    INNER_EMISSIVE_FIRE_SCALE: 1.2, // additional emissiveIntensity per unit firing intensity
  },

  // =========================================================================
  // ION START-UP (owner 2026-10-25, DECISIONS §37 row 7: "seeing them flicker to life and ramp up to full power [is] a
  // great visual reward at the end of each mission"). The first seconds of a trip's burn (js/systems/TransferTrip.js):
  // the four tail boxes light in two opposite pairs (top+bottom, then right+left, so the push stays balanced), each
  // pair sputtering and then swelling to full; the camera swings behind her, a hum rises, and the trip line shows once
  // all four burn. The push, the gas and the world clock follow the lit share (TransferTrip header). Colours are
  // today's (argon's real plume colour is unconfirmed).
  // =========================================================================
  ION_STARTUP: {
    PAIR_GAP_S: 1.0,       // the second pair starts this long after the first
    FLICKER_S: 0.6,        // each pair sputters this long (the pulses below), then swells
    // The sputter: [from s, to s, level] on the pair's own clock; dark between the pulses and from the last one to FLICKER_S
    // (uneven on purpose, and non-monotonic: she catches, dies, catches again, then the swell takes over).
    FLICKERS: [[0.00, 0.07, 0.40], [0.18, 0.24, 0.25], [0.34, 0.47, 0.65]],
    RAMP_S: 1.5,           // a smooth swell (smoothstep) from the sputter to full output
    SETTLE_S: 0.9,         // all four steady at full before the line shows and the clock may speed up
    // Camera (CameraSystem): it eases to a view behind and a little to the side of the tail, holds while they light and for
    // CAM_HOLD_S after the line shows (so he sees all four at full power), then eases back to her previous view over CAM_OUT_S;
    // his own camera input ends it at once. Metres in her own frame (+Z nose; the tail face is z = -1.075).
    CAM_IN_S: 1.5,
    CAM_HOLD_S: 1.5,       // the close view stays this long after all four are lit (F1.4, 10-25 visual check)
    CAM_OUT_S: 2.0,
    CAM_AFT_M: 5.5,        // camera this far aft of her centre
    CAM_SIDE_M: 2.6,       // ... this far to her side (+X)
    CAM_UP_M: 1.0,         // ... and this far above (+Y)
    CAM_LOOK_AFT_M: 1.6,   // looks at this point on her axis, aft of her centre (the tail boxes and the plumes)
    // Hum (AudioSystem): a sine that rises in gain and pitch with the lit share, then holds quiet for the rest of the burn.
    HUM_FREQ_LOW_HZ: 60,
    HUM_FREQ_HIGH_HZ: 80,
    HUM_GAIN_PEAK: 0.07,
    HUM_GAIN_CRUISE: 0.025,
  },

  // =========================================================================
  // OPENING DANCE (2026-09-16) — the beat table for the ship unpacking itself.
  // Every beat-table figure of the plan's table lives HERE, in ONE block. The
  // DURATIONS are not repeated: they are derived in js/systems/OpeningDance.js
  // from the shipped hardware rates (OCTOPUS_V5.ROSA_FURL_RATE 0.40/s → 2.5 s
  // per wing; THERMAL.FLOWER.SLEW_RATE_RAD_S 15°/s for the radiator), so the
  // dance always teaches the speeds the player will later command. t = 0 is
  // jet-off, NOT the departure start.
  //
  // DECISIONS §15 row 4 (2026-10-08, lane w2-start-pose): the ship starts
  // CLOSED. The radiator stays folded (it rests at its 0° launch latch, no ease
  // to 2° any more — owner 2026-10-16) and the daughter struts stay shut, so the
  // two solar wings ARE the unfold, and the hand-over is the moment wing 2 is
  // out — 8.70 s (was 9.73). The wings keep 5.20 / 6.20: they start as the
  // camera's dive lands, so the intro DOLLY (LadderController
  // INTRO_DANCE_DOLLY_MS) finishes before the hand-over pulls the camera
  // back (measured on :8092 2026-10-09: a 6.70 s hand-over arrived in the
  // dive's landing frame, so every boot skipped the dolly).
  // =========================================================================
  OPENING_DANCE: {
    BEAT_JETOFF: 0.26,            // fraction of the menu departure at which the EVA astronaut jets off (t = 0 = start + 0.26 × durationMs)
    MENU_DEPARTURE_MS: 3650,      // the MenuScreen departure the beat table is measured against (fallback when the payload carries none)
    T_CUT_S: 2.70,                // the menu→game cut (MENU_START) in dance time: 0.95 s jet-off + 2.70 s = the 3.65 s departure
    WING1_START_S: 5.20,          // ROSA wing 1 roll-out start, as the intro dive lands (2.5 s at ROSA_FURL_RATE → seated 7.70)
    WING2_START_S: 6.20,          // ROSA wing 2 roll-out start (→ seated 8.70 = the hand-over)
    SKIP_FADE_S: 0.5,             // any input fast-forwards the remaining unfold over this window (decision 10)
  },

  // =========================================================================
  // V5 CROSSBOW ARMS — Spring-launched tethered arms with reel-in capture
  // See CROSSBOW_ARMS.md for full specification
  // =========================================================================

  // ── V5 Crossbow Arms ──

  // --- Crossbow Spring Physics ---
  CROSSBOW_DRAW_DISTANCE: 0.25,           // meters — spring compression distance
  CROSSBOW_SPRING_K_WEAVER: 17600,        // N/m — spring constant for 11kg Weaver at 10 m/s
  CROSSBOW_SPRING_K_SPINNER: 5920,        // N/m — spring constant for 3.7kg Spinner at 10 m/s
  CROSSBOW_RELEASE_TIME: 0.05,            // seconds — spring release duration (40ms)
  CROSSBOW_UNDOCK_TIME: 1.5,              // seconds — magnetic clamp release + crossbow charge
                                           // (increased from 0.3s so player sees strut aim + charge before launch)
  CROSSBOW_LAUNCH_SPEED_DEFAULT: 10.0,    // m/s — default launch speed (physically justified)
  CROSSBOW_LAUNCH_SPEED_MIN: 3.0,         // m/s — minimum selectable launch speed
  // Register item 76(b) (2026-08-16): CROSSBOW_LAUNCH_SPEED_MAX (was 20.0) removed —
  // import-only; the real clamp is setLaunchSpeed's [MIN, tier.maxSpeed] (ArmUnit.js).
  // Register item 100 (2026-08-21): the speed DIAL shipped — `;` down / `'` up,
  // fleet-wide via ArmManager.setFleetLaunchSpeed (default stays DEFAULT; the API
  // clamps to the equipped spring tier's ceiling). HUD readout lives in the arms
  // panel header (StatusPanel._renderArmPanel).
  CROSSBOW_SPEED_STEP: 0.5,               // m/s — one dial notch per keypress (hold to sweep)

  // --- Reload Mechanism ---
  CROSSBOW_RELOAD_POWER: 15,              // watts — worm gear motor power draw
  CROSSBOW_WORM_GEAR_EFFICIENCY: 0.80,    // 80% mechanical efficiency

  // --- Tether Reel (on mothership) ---
  REEL_IN_SPEED_EMPTY: 2.0,              // m/s — reel-in speed unloaded (game-scale)
  REEL_IN_SPEED_LOADED: 4.0,             // m/s — reel-in speed with captured debris (POLISH: bumped from 1.4 for snappier retrieval)
  // Register item 76(c) (2026-08-17): REEL_MOTOR_POWER (was 25 W) removed —
  // import-only, zero reads. Reel and reload power bill through MOTOR_DRAW_W
  // since w4-power D5 (ArmUnit reload: CROSSBOW_RELOAD_POWER; the reels:
  // tension × speed ÷ efficiency). The reel's live rows
  // surround this note: the speeds above, the brake/tension rows below.
  REEL_BRAKE_FORCE_MAX: 500,             // N — maximum magnetic clutch brake force
  REEL_TENSION_WARNING: 0.7,             // fraction of break strength → yellow HUD
  REEL_TENSION_CRITICAL: 0.9,            // fraction of break strength → red HUD
  // Register item 83(b) (2026-08-17, owner-ruled DELETE): REEL_LEVEL_WIND_SPEED
  // (was 0.02 m/s — traverse speed for even spooling) removed — zero reads in
  // tracked history (grep- AND git-proven); no spool/traverse is modelled. The
  // level-wind mechanism is design narrative (CROSSBOW_ARMS §14.6, :1802); the
  // reel's live rows are the speeds above and the brake/tension rows here.

  // --- Capture-failure model & release dynamics ---
  // Two distinct post-capture failure modes (see ArmUnit._updateGrappled /
  // _updateReeling):
  //   1. NET FAILURE (recoverable): the net loses its grip on a near-rated,
  //      heavy catch. Debris slips free and drifts (re-capturable); the
  //      daughter keeps her mother-tether and returns to reload. Probabilistic,
  //      scaling with how close the payload is to the net's rated mass.
  //   2. TETHER SNAP (catastrophic): the mother↔daughter cable parts under
  //      reel load. Daughter + catch are cut loose and drift off together.
  //      Deterministic on overload; retuned so an in-spec catch never snaps.
  REEL_TENSION_COEFF: 0.04,              // tension(N) = (armMass+payloadMass)×reelSpeed×coeff.
                                         //   Tuned so a max in-spec Weaver catch
                                         //   (~500 kg) reels home under the default
                                         //   Dyneema 100 N break strength; only genuine
                                         //   overload snaps the tether.
  NET_STRAIN_SAFE_FRACTION: 0.8,         // payload ≤ 80% of net rated mass → guaranteed hold.
  NET_STRAIN_FAIL_PROB_MAX: 0.35,        // net-failure chance at 100% rated mass (linear
                                         //   ramp from SAFE_FRACTION → 1.0). Set 0 to disable.
  CAPTURE_RELEASE_SEPARATION_MPS: 1.2,   // m/s separation/recoil imparted to the daughter
                                         //   when a catch is lost (snap dynamics).
  TETHER_SNAP_RELEASE_DELAY_S: 8.0,      // s — after a tether snap the catch drifts pinned
                                         //   to the EXPENDED daughter for this long (so it
                                         //   reads as "tumbling off with her"), then the pin
                                         //   is released so the runaway debris resumes its
                                         //   orbit + normal LOD instead of leaking full detail.


  // --- Dual-Fire / Recoil ---
  DUALFIRE_SYNC_WINDOW: 0.01,            // seconds — max timing offset for dual fire
  DUALFIRE_RECOIL_WEAVER: 0.509,         // m/s — single Weaver recoil on 130kg mothership
  DUALFIRE_RECOIL_SPINNER: 0.171,        // m/s — single Spinner recoil
  DUALFIRE_RCS_COMPENSATION_N2: 3.7,     // grams N₂ — RCS cost per single Weaver shot
  // The net recoil's ANGULAR channel (an off-axis muzzle; zero since the one
  // centred launcher, owner 2026-10-13) is billed as real couple gas by
  // PlayerSatellite._billTurnNullN2 (turn-gas, 2026-10-23; the 0.44 m
  // doghouse-lever conversion it replaced was ~39x too cheap).

  // --- Pulse Scan ---
  PULSE_SCAN_DURATION: 2.0,              // seconds — all arms fire simultaneously
  PULSE_SCAN_RANGE_MULT: 1.5,            // range multiplier vs single arm sensor
  PULSE_SCAN_COOLDOWN: 30.0,             // seconds — cooldown between pulse scans
  PULSE_SCAN_POWER: 50,                  // watts — total power draw during scan

  // =========================================================================
  // ACTIVE SCAN SYSTEM — Player-initiated scanning for treasure hunting
  // =========================================================================
  SCAN: {
    REVEAL_BASE_RANGE: 5.0,   // 500 km in scene units — base radius for scan target reveal (UX-3 #9)
    REVEAL_STAGGER_MS: 120,   // ms between each target reveal (smooth, snappy cadence)
    SESSION_SCAN_CAP: 5000,   // S2.4: max total scan credits per session (anti-spam)
    // w2-heat D2 (DECISIONS §15 row 2 — "scanning costs battery and heat, like
    // mana … noticeable until upgraded"). A scan costs POWER_COST × the 600 Wh
    // base battery (BATTERY_MAX) × COST_MULT, in Wh. SWEEP_SHARE of it is the
    // sweep, paid the instant the scan starts (refused — "Battery too low to
    // scan." — when the battery cannot pay it); the rest is the onboard
    // computer's analysis, a steady load over ANALYSIS_S real seconds. Every
    // drawn watt ends as heat (ThermalSystem). Read by SensorSystem.getScanCost.
    COST_MULT: 1,             // the one upgrade lever (later rounds; no shop item yet)
    SWEEP_SHARE: 1 / 3,       // the sweep's share; the computer's analysis is the rest
    // w4-power D6 (owner 2026-10-12: "first scan should hit thermals and battery
    // harder"): with no tracks yet the first scan of every boot searches the
    // whole sky, so it costs at least the wide scan's energy whatever scan is
    // pressed (× COST_MULT; the normal sweep / analysis split, the analysis over
    // WIDE.ANALYSIS_S). Later scans pay their own cost. Not persisted.
    // 90 → 160 Wh (owner 2026-10-18, "First scan hotter": mission 1 must warn
    // about heat through normal play; replay tmp/heat-opts/replay2.mjs, option 2).
    COLD_SEARCH_WH: 160,
    QUICK: {
      DURATION: 0.3,          // seconds to complete quick scan (fast S→reward feedback)
      COOLDOWN: 5.0,          // seconds between quick scans (raised from 3.0 — anti-spam)
      POWER_COST: 0.06,       // × 600 Wh = 36 Wh: 12 Wh sweep + 24 Wh analysis
      ANALYSIS_S: 3.5,        // real s → 24 Wh / 3.5 s = 6.9 kW on the battery clock
      DISCOVERY_CHANCE: 0.20, // 20% chance to find hidden debris
      REWARD: 50,             // base credits for survey data (modified by diminishing returns)
      RANGE_MULTIPLIER: 1.0,  // uses current sensor range
      MAX_REVEALS: 5,         // targets discovered per quick scan (UX-3 #9)
    },
    WIDE: {
      DURATION: 4.0,          // seconds for wide aperture scan
      COOLDOWN: 8.0,          // seconds between wide scans
      POWER_COST: 0.15,       // × 600 Wh = 90 Wh: 30 Wh sweep + 60 Wh analysis
      ANALYSIS_S: 6.0,        // real s → 60 Wh / 6 s = 10 kW on the battery clock
      DISCOVERY_CHANCE: 0.40, // 40% chance to find hidden debris
      REWARD: 150,            // credits for deep survey data
      DISCOVERY_REWARD: 100,  // bonus per new contact found
      RANGE_MULTIPLIER: 2.0,  // double current sensor range
      MAX_DISCOVERIES: 3,     // up to 3 hidden objects per scan
      MAX_REVEALS: 10,        // targets discovered per wide scan (UX-3 #9)
    },
  },

  // =========================================================================
  // AUTO-TOOL RECOMMENDATION — MW2-style auto-pick for best capture tool
  // =========================================================================
  TOOL_RECOMMENDATION: {
    LASSO_MAX_MASS: 10,         // kg — lasso effective up to this mass
    SPINNER_MAX_MASS: 50,       // kg — spinner arm for small/medium
    GRAPPLE_MAX_MASS: 500,      // kg — grapple for medium/large
    WEAVER_MIN_MASS: 200,       // kg — weaver for large debris
    TRAWL_MIN_COUNT: 3,         // minimum cluster size for trawl recommendation
    TRAWL_MAX_INDIVIDUAL_MASS: 20, // kg — trawl only for small fragments
    // Whale band: above WEAVER_MAX_CAPTURE_MASS (500 kg) no daughter tool can
    // take the catch (ArmUnit hard-refuses > 500 kg, lasso caps at 10, trawl at
    // 50) — the mother's Large Net pod is the only legal tool. Recommend
    // 'mother' so the tool chip stops reading WEAVER for a whale and the
    // autopilot trail distance picks up D_TRAIL_NET instead of D_TRAIL_ARMS.
    MOTHER_MIN_MASS: 500,       // kg — mother Large Net pod above this mass
  },

  // =========================================================================
  // TARGET RANKING — Composite Target Priority Index (TPI) (FIX_PLAN §4)
  // =========================================================================
  // TPI = W_DIST * distScore + W_DV * dvScore + W_THREAT * threatScore + W_VALUE * valueScore
  // Each factor normalized to 0..1; lower TPI = higher priority
  TARGET_RANKING: {
    W_DIST: 0.35,        // distance weight — closer targets score better
    W_DV: 0.30,          // delta-v weight — cheaper transfers score better
    W_THREAT: 0.20,      // MOID threat weight — dangerous debris scores better (urgent)
    W_VALUE: 0.15,       // estimated points weight — valuable targets score better
    DIST_REF_KM: 100,    // reference distance for normalization (debris at this distance scores 1.0)
    DV_REF_MS: 50,       // reference delta-v for normalization (m/s)
    MOID_THREAT_MAP: {   // MOID badge → threat score (lower = more threatening → higher TPI)
      'HI': 0.0,         // high threat → best (lowest) score
      'MD': 0.3,
      'LO': 0.6,
      null: 1.0,         // no MOID data → worst score
    },
    VALUE_REF_PTS: 500,  // reference point value for normalization
  },

  // --- Ablation ---
  ABLATION_LASER_POWER: 10,              // watts — onboard laser for de-spin/nudge
  ABLATION_RANGE_MAX: 50,                // meters — max effective ablation range
  ABLATION_DURATION_MAX: 30,             // seconds — max continuous ablation
  ABLATION_DESPIN_RATE: 0.1,             // rad/s² — angular deceleration applied

  // CP-2 — mother-mounted de-spin laser (BIG_PICTURE §16; GAME_DESIGN "10W laser de-spin").
  // Hold-to-fire assist that bleeds a tumbling target's spin down until a net can cling.
  DESPIN_LASER: {
    RANGE_M:            5000,     // mother optic reach (scene-wide; >> the 50 m daughter ablation)
    DESPIN_RATE_RAD_S2: 0.30,     // angular deceleration applied while firing
    IN_SPEC_DEG:        10,       // tumble at/below this is net-safe → "tumble in spec, net it"
    BEAM_COLOR:         0x66ddff, // cyan glow (BIG_PICTURE §16.4)
    BEAM_OPACITY:       0.7,
  },
  // Net cling tumble penalty (CP-2) — high target tumble reduces cling; detumble restores it.
  // This is the live-path coupling that makes the de-spin laser actually matter for capture.
  NET_TUMBLE_PENALTY: {
    IN_SPEC_DEG: 10,     // no penalty at/below this tumble
    PER_DEG:     0.012,  // cling-multiplier loss per °/s above in-spec
    FLOOR:       0.4,    // minimum multiplier (never makes a catch strictly impossible)
    // Wave-4 QA #3 (CAPTURE_NET.md §10 concern 3): tumble-factor cache
    // invalidation epsilon for the pre-fire odds lock cache
    // (ToolOdds.makeNetOddsLockCache). |Δ tumbleRate| beyond this recomputes
    // f_tumble. tumbleRate only changes via discrete writes (despin laser
    // 0.30 rad/s², eddy damp 0.10 rad/s², torque settle → 0, remainder
    // resume), so the smallest real per-frame step is ~0.10 × dt ≈ 4e-4 rad/s
    // even at 240 fps — 5 orders above this epsilon. Every real write
    // therefore recomputes (the displayed odds stay numerically identical to
    // a fresh computation), while bit-stable re-reads skip the work.
    RATE_EPS_RAD_S: 1e-9,
  },

  // --- V5 Arm Configuration ---
  V5_ARM_COUNT: 4,                       // Total arms: 2W + 2S (Y0 Quad baseline — ST-9.2)
  V5_WEAVER_MASS: 6.6,                   // kg — 40% lighter (reel on mothership)
  V5_SPINNER_MASS: 2.1,                  // kg — 40% lighter (reel on mothership)
  V5_FRONT_ARM_TYPE: 'spinner',          // prograde arm type
  V5_BACK_ARM_TYPE: 'spinner',           // retrograde arm type

  // --- Tether Materials (upgrade tiers) ---
  // 2026-10-21 (DECISIONS §33 row 5, lane nets-step2): the tether tier IS the line-fibre upgrade. One purchase raises the
  // tether length (maxLength, as before) AND the net capacities: `nets` = mother / large daughter / small daughter
  // (4/2/4 at the start tier = CAPTURE_NET.LARGE/MEDIUM/SMALL.MAGAZINE_SIZE, drift-tested). `label` is what the player
  // reads (Ruling 0: plain words; `name` stays the code-side key and the purchase payload). `netMassKg` is the mass of
  // ONE packed mother / large / small net at that fibre: MESH_MASS * mf + RIM_WEIGHT_COUNT * RIM_WEIGHT_MASS + HUB_MASS,
  // mf = [1, 0.970, 0.469, 0.0375, 0.0156] (strength and density per fibre: Dyneema 3.5 GPa 0.97 g/cm3, Zylon 5.8 GPa
  // 1.56, carbon nanotube yarn 10 GPa 1.3 (speculative), graphene from the game's own GSL rows 2.0 (future tech; the best
  // graphene fibre made today is 5.9 GPa)). ESTIMATES from the probe tmp/netpack/step2.mjs (packing fraction 0.5), not
  // measurements; the drawn cartridges (netCellLayout) are sized to hold them (test-NetPack).
  // 2026-10-23 (DECISIONS §38 row 5): the LARGE daughter now carries four 3 m nets (0.317 kg each at the start tier) in
  // place of two 5 m nets, so `nets.large` is 4 / 6 / 8 / 10 / 10 (was 2 / 3 / 4 / 5 / 5; the ladder doubles, the last two
  // tiers still tie) and `netMassKg.large` follows the same MESH x mf + rim + hub formula with the 3 m net's parts
  // (MESH 0.149, 4 x 0.030, hub 0.048). Packed, every tier fits the large can (js/test/_netPack.js; 73 % full at the
  // start tier, was 92 %).
  TETHER_TIERS: [
    { name: 'Dyneema',   label: 'Dyneema',          breakStrength: 100,  mass_per_km: 0.8,  maxLength: 2000,  cost: 0,
      nets: { mother: 4,  large: 4,  small: 4  }, netMassKg: { mother: 1.425, large: 0.317, small: 0.120 } },
    { name: 'Zylon',     label: 'Zylon',            breakStrength: 200,  mass_per_km: 0.6,  maxLength: 4000,  cost: 1500,
      nets: { mother: 6,  large: 6,  small: 6  }, netMassKg: { mother: 1.405, large: 0.313, small: 0.119 } },
    { name: 'CNT',       label: 'Carbon nanotube',  breakStrength: 350,  mass_per_km: 0.3,  maxLength: 6000,  cost: 5000,
      nets: { mother: 8,  large: 8,  small: 8  }, netMassKg: { mother: 1.067, large: 0.238, small: 0.099 } },
    { name: 'GSL-50',    label: 'Graphene',         breakStrength: 500,  mass_per_km: 0.15, maxLength: 8000,  cost: 15000,
      nets: { mother: 10, large: 10, small: 10 }, netMassKg: { mother: 0.775, large: 0.174, small: 0.082 } },
    { name: 'GSL-100',   label: 'Graphene, 10 km',  breakStrength: 800,  mass_per_km: 0.10, maxLength: 10000, cost: 40000,
      nets: { mother: 10, large: 10, small: 10 }, netMassKg: { mother: 0.761, large: 0.170, small: 0.081 } },
  ],

  // --- Spring Upgrade Tiers ---
  // Register item 76(a) (2026-08-16): reloadMult (0.5 / 1.0 / 2.25 / 4.0 / 6.25)
  // removed from all five rows — read nowhere; the shipped reloads carry no tier
  // multiplier (the FSM reaches reload duration only via the maxSpeed clamp).
  SPRING_TIERS: [
    { name: 'Steel T1',      maxSpeed: 7.1,  cost: 0 },
    { name: 'Maraging T2',   maxSpeed: 10.0, cost: 800 },
    { name: 'Composite T3',  maxSpeed: 15.0, cost: 3000 },
    { name: 'Nanolam T4',    maxSpeed: 20.0, cost: 10000 },
    { name: 'Metamat T5',    maxSpeed: 25.0, cost: 30000 },
  ],

  // =========================================================================
  // SALVAGE SYSTEM — Recoverable resources from captured debris (Session 10)
  // =========================================================================

  // --- Salvage Probabilities (by debris type) ---
  SALVAGE_PROB_DEFUNCT_SAT_XENON: 0.15,        // Ion-propelled satellites
  SALVAGE_PROB_DEFUNCT_SAT_XENON_LARGE: 0.25,  // Large sats (>500 kg)
  SALVAGE_PROB_DEFUNCT_SAT_GAAS: 0.20,         // Solar panel fragments
  SALVAGE_PROB_DEFUNCT_SAT_BATTERY: 0.15,      // Residual Li-ion charge
  SALVAGE_PROB_ROCKET_BODY_HYDRAZINE: 0.10,    // Residual propellant (hazardous)
  SALVAGE_PROB_ROCKET_BODY_XENON: 0.05,        // Electric upper stages (rare)
  SALVAGE_PROB_MISSION_DEBRIS_INDIUM: 0.12,    // FEEP thruster components
  SALVAGE_PROB_MISSION_DEBRIS_BATTERY: 0.10,   // Small power systems
  SALVAGE_PROB_FRAGMENT_GAAS: 0.30,            // Broken solar panel shards
  SALVAGE_PROB_FRAGMENT_INDIUM: 0.05,          // Trace alloy amounts
  SALVAGE_PROB_DEFUNCT_SAT_LITHIUM: 0.25,      // Lithium from defunct satellite batteries/propulsion

  // --- Salvage Amount Ranges ---
  SALVAGE_XENON_MIN: 2,               // pool units (100 = a full argon tank)
  SALVAGE_XENON_MAX: 8,               // pool units (standard sat)
  SALVAGE_XENON_LARGE_MIN: 5,         // pool units (large sat >500kg)
  SALVAGE_XENON_LARGE_MAX: 15,        // pool units
  SALVAGE_INDIUM_MIN: 0.01,           // kg
  SALVAGE_INDIUM_MAX: 0.05,           // kg
  SALVAGE_GAAS_MIN: 0.005,            // fraction (0.5% panel health)
  SALVAGE_GAAS_MAX: 0.03,             // fraction (3% panel health)
  SALVAGE_BATTERY_MIN: 2,             // Wh
  SALVAGE_BATTERY_MAX: 20,            // Wh
  SALVAGE_HYDRAZINE_MIN: 2,           // kg
  SALVAGE_HYDRAZINE_MAX: 10,          // kg
  SALVAGE_HYDRAZINE_COLDGAS_RATIO: 0.6, // 60% conversion to cold gas equivalent
  SALVAGE_LITHIUM_MIN: 5,               // units (F16: MPD thruster propellant)
  SALVAGE_LITHIUM_MAX: 15,              // units (reasonable for 100 capacity)

  // --- Indium FEEP Fuel Tank Sizes (for arm refueling calculation) ---
  INDIUM_FULL_TANK_WEAVER: 0.15,      // kg Indium for 100% Weaver FEEP
  INDIUM_FULL_TANK_SPINNER: 0.05,     // kg Indium for 100% Spinner FEEP

  // --- Salvage Scoring ---
  SALVAGE_SCORE_MULTIPLIER: 1.15,     // ×1.15 when salvage recovered
  // E1 retune: soft-cap on the PRODUCT of situational capture multipliers
  // (assessment ×1.3 · manual ×2 · fuel-eff ×1.25 · salvage ×1.15 · detach ×2 ·
  // deorbit). Stacked, these reached ~×7.5 and made a single lucky catch pay a
  // whole shop tier. Capped so the ceiling is a deliberate skill target, tunable.
  SITUATIONAL_MULT_SOFT_CAP: 2.5,
  // S1 credits rebalance (2026-07-23): a SEPARATE, lower soft cap applied only to
  // the CREDITS ledger's situational product inside awardPoints(). The score
  // ledger keeps the 2.5 cap (skill rating untouched); the wallet is capped
  // lower so skilled manual play earns ~+50% credits over auto-capture rather
  // than the pre-fix ~6–7× catalog that let a skilled player buy out the shop
  // early and kill the accumulate-and-upgrade loop. Tunable; must stay
  // ≤ SITUATIONAL_MULT_SOFT_CAP (guardrail test asserts this).
  SITUATIONAL_MULT_SOFT_CAP_CREDITS: 1.5,
  // S1 credits rebalance: per-RUN capture-credits taper. Capture credits pay
  // full value until cumulative per-run capture earnings reach START_X×catalog,
  // then scale down linearly so cumulative capture credits asymptotically
  // approach CEILING_X×catalog. Multiples of SHOP.CATALOG_TOTAL_CR. Sales and
  // contract income (addCredits) are OUTSIDE the taper by design — the late-game
  // money loop shifts from raw captures to refine-and-contribute.
  CAPTURE_CREDITS_TAPER: { START_X: 1.5, CEILING_X: 2.5 },

  // =========================================================================
  // DEORBIT SACRIFICE SYSTEM — One-way arm missions (Session 10)
  // =========================================================================

  DEORBIT_MULTIPLIER_BASE: 1.5,       // Standard sacrifice bonus
  DEORBIT_MULTIPLIER_HIGH_DV: 1.8,    // >20 m/s retrograde burn achieved
  DEORBIT_MULTIPLIER_REENTRY: 2.5,    // Perigee < 200 km (actual reentry)
  DEORBIT_MULTIPLIER_EMERGENCY: 1.2,  // < 5% fuel at sacrifice
  DEORBIT_HIGH_DV_THRESHOLD: 20,      // m/s — threshold for high-ΔV bonus
  DEORBIT_REENTRY_PERIGEE: 200,       // km — perigee for reentry bonus

  // =========================================================================
  // METAL SALVAGE ECONOMY — Recoverable metals from debris (Phase 2)
  // =========================================================================

  METALS: {
    ALUMINUM: {
      id: 'aluminum',
      name: 'Aluminum',
      density: 2700,          // kg/m³
      ispAsThrust: 800,       // seconds (metal-ion propulsion)
      marketValue: 2.5,       // credits per kg
      color: '#C0C0C0',
      abundance: 0.40,        // 40% of debris mass is aluminum
    },
    TITANIUM: {
      id: 'titanium',
      name: 'Titanium',
      density: 4507,
      ispAsThrust: 900,
      marketValue: 12.0,
      color: '#8B8682',
      abundance: 0.08,
    },
    STEEL: {
      id: 'steel',
      name: 'Steel',
      density: 7850,
      ispAsThrust: 500,       // iron-based
      marketValue: 1.0,
      color: '#71797E',
      abundance: 0.15,
    },
    COPPER: {
      id: 'copper',
      name: 'Copper',
      density: 8960,
      ispAsThrust: 600,
      marketValue: 8.0,
      color: '#B87333',
      abundance: 0.05,
    },
    CARBON_COMPOSITE: {
      id: 'carbon_composite',
      name: 'Carbon Composite',
      density: 1600,
      ispAsThrust: 0,         // not usable as propellant
      marketValue: 15.0,
      color: '#2C2C2C',
      abundance: 0.10,
    },
    GALLIUM: {
      id: 'gallium',
      name: 'Gallium',
      density: 5910,
      ispAsThrust: 3000,      // excellent as propellant
      marketValue: 50.0,
      color: '#7B8D8E',
      abundance: 0.02,        // rare — found in electronics
    },
    GLASS_CERAMIC: {
      id: 'glass_ceramic',
      name: 'Glass/Ceramic',
      density: 2500,
      ispAsThrust: 0,
      marketValue: 0.5,
      color: '#E8E8E8',
      abundance: 0.12,
    },
    IRIDIUM: {
      id: 'iridium',
      name: 'Iridium',
      density: 22560,
      ispAsThrust: 1200,
      marketValue: 150.0,     // very valuable
      color: '#E8E0D0',
      abundance: 0.01,        // very rare — from Iridium constellation debris
    },
    KEVLAR: {
      id: 'kevlar',
      name: 'Kevlar/MLI',
      density: 1440,
      ispAsThrust: 0,
      marketValue: 3.0,
      color: '#DAA520',
      abundance: 0.07,
    },
  },

  // Debris type → metal composition overrides (which metals are more likely)
  // Keys match game debris type IDs from DEBRIS_TYPES
  DEBRIS_METAL_PROFILES: {
    rocketBody:   { aluminum: 0.55, steel: 0.20, titanium: 0.10, copper: 0.05, kevlar: 0.05, glass_ceramic: 0.05 },
    defunctSat:   { aluminum: 0.30, gallium: 0.05, copper: 0.10, carbon_composite: 0.15, glass_ceramic: 0.15, titanium: 0.10, kevlar: 0.10, steel: 0.05 },
    fragment:     { aluminum: 0.45, steel: 0.25, titanium: 0.05, glass_ceramic: 0.15, kevlar: 0.10 },
    missionDebris: { aluminum: 0.20, glass_ceramic: 0.30, carbon_composite: 0.20, copper: 0.15, kevlar: 0.10, gallium: 0.03, iridium: 0.02 },
    cubesat:      { aluminum: 0.35, copper: 0.15, gallium: 0.08, glass_ceramic: 0.12, carbon_composite: 0.15, titanium: 0.05, iridium: 0.05, steel: 0.05 },
  },

  // --- Cargo Hold ---
  CARGO_CAPACITY_KG: 500,        // base cargo hold capacity in kg
  CARGO_CAPACITY_SLOTS: 20,      // max distinct material stacks
  // E2 Cargo Bay upgrade chain — absolute hold targets (CargoSystem.applyUpgrade
  // assigns, not accumulates, so restore-replay is idempotent). The elevator win
  // needs throughput: 12 depots × TIER3 (3,000) ≫ the 10,000 kg contract.
  CARGO_BAY_TIER2_KG: 1500,      // cargo_bay_2: base 500 → 1,500 (+1,000)
  CARGO_BAY_TIER3_KG: 3000,      // cargo_bay_3: 1,500 → 3,000 (+1,500)

  // =========================================================================
  // FUELS — Dual-Mode Hall Thruster Propellant Definitions (Phase 4)
  // One thruster, multiple fuels. T key cycles. Isp affects ΔV efficiency.
  // =========================================================================

  FUELS: {
    // h3-argon-engine (owner 2026-10-15, DECISIONS §23 row 2: "Argon, 60 L tank"): the ship's own tank
    // holds ONE engine gas — argon by default, krypton / xenon are later upgrades. All three burn
    // from the same pool (`res.xenon`, kept name: 100 = one full 60 L, 200 bar base tank), so each has
    // resourceKey 'xenon'. isp / thrustScale / kgFull are sourced in
    // docs/research/2026-10-propellant-and-tanks.md §2.2-2.3 / §5.2.
    // kgFull = gas mass that fills the 60 L, 200 bar tank at 20 C (NIST density, research §2.2 table).
    argon: {
      id: 'argon',
      name: 'Argon',
      isp: 1700,          // seconds — ESTIMATE (research §2.3: small Hall thrusters get ~Kr's Isp on Ar)
      thrustScale: 0.46,  // 18 / 39 mN at 600 W (CAMILA anode-efficiency ratio vs xenon, research §2.3)
      kgFull: 20.8,       // kg in 60 L @ 200 bar (research §2.2)
      usdPerKg: 10,       // g1-gas-upgrades D1: gas price, research §2.4 (the launch cost per kg is LAUNCH_USD_PER_KG)
      color: '#9fb8c8',   // cool grey-blue
      resourceKey: 'xenon', // burns from the ship tank pool (pool key kept; it holds whichever gas is loaded)
      fromCargo: false,
    },
    krypton: {
      id: 'krypton',
      name: 'Krypton',
      isp: 1650,          // seconds — Busek 1.5 kW lab data: Kr +140..190 s over Xe (IEPC-2017-26), research §2.3
      thrustScale: 0.67,  // 26 / 39 mN at 600 W (research §2.3)
      kgFull: 58.0,       // kg in 60 L @ 200 bar (research §2.2)
      usdPerKg: 400,      // g1-gas-upgrades D1 (research §2.4)
      color: '#b39ddb',
      resourceKey: 'xenon',
      fromCargo: false,
    },
    xenon: {
      id: 'xenon',
      name: 'Xenon',
      isp: 1500,          // seconds — Busek BHT-600 "up to 1500 s"; equals OCTOPUS_CORE_HALL_ISP (was 1600 here)
      thrustScale: 1.0,   // baseline thrust (39 mN at 600 W, Busek BHT-600)
      kgFull: 129.2,      // kg in 60 L @ 200 bar (research §2.2)
      usdPerKg: 2700,     // g1-gas-upgrades D1 (research §2.4)
      color: '#4fc3f7',   // light blue
      resourceKey: 'xenon', // consumes from ResourceSystem xenon tank
      fromCargo: false,    // uses ship's built-in tank
    },
    aluminum: {
      id: 'aluminum',
      name: 'Aluminum',
      isp: 800,
      thrustScale: 1.4,   // higher thrust, lower efficiency
      color: '#C0C0C0',
      resourceKey: null,
      fromCargo: true,     // consumed from cargo prop_aluminum
      cargoMetalId: 'prop_aluminum',
    },
    gallium: {
      id: 'gallium',
      name: 'Gallium',
      isp: 3000,
      thrustScale: 0.6,   // lower thrust, very high efficiency
      color: '#7B8D8E',
      resourceKey: null,
      fromCargo: true,
      cargoMetalId: 'prop_gallium',
    },
    copper: {
      id: 'copper',
      name: 'Copper',
      isp: 600,
      thrustScale: 1.2,
      color: '#B87333',
      resourceKey: null,
      fromCargo: true,
      cargoMetalId: 'prop_copper',
    },
    iridium: {
      id: 'iridium',
      name: 'Iridium',
      isp: 1200,
      thrustScale: 0.9,
      color: '#E8E0D0',
      resourceKey: null,
      fromCargo: true,
      cargoMetalId: 'prop_iridium',
    },
  },

  DEFAULT_FUEL: 'argon',   // h3-argon-engine: the cheapest gas for modern satellites (DECISIONS §23)

  // =========================================================================
  // MPD THRUSTER — Magnetoplasmadynamic Tier 3 Propulsion (F16)
  // High-thrust lithium-propellant system with cathode erosion mechanic
  // =========================================================================

  MPD_CATHODE_LIFE: 600,             // seconds of operation before erosion
  MPD_LITHIUM_CAPACITY: 100,         // max lithium units
  MPD_PASSIVE_THRUST_MULT: 1.5,      // F2: passive ion-drive boost while MPD installed (folds MPD gain into the normal drive; the burst path stays dormant). +50% primary thrust for the GEO/ch11 climb.

  // --- MPD Burst Mode (S3b) ---
  MPD_BURST_COOL_RATE: 0.3,               // heat units/s passive dissipation
  MPD_BURST_COOL_RATE_SUPERCAP: 0.5,      // heat dissipation with supercap upgrade
  MPD_BURST_OVERHEAT_THRESHOLD: 40,       // heat units for thermal shutdown



  // =========================================================================
  // MARKET & BOUNTY SYSTEM (Phase 5)
  // =========================================================================

  MARKET: {
    // Bounty premiums by debris type (multiplier on base capture score)
    // Keys must match DEBRIS_TYPES values (camelCase game IDs)
    BOUNTY_PREMIUMS: {
      fragment: 1.2,         // E1 retune: was 1.8 — fragments are the bulk of catches;
      missionDebris: 1.5,    // mission debris: moderate premium
      defunctSat: 1.0,       // base rate
      rocketBody: 0.8,       // large bodies: lower bounty but more salvage metal
      cubesat: 1.4,          // small whole microsat: dense/valuable graduation catch
    },

    // Selling price modifier (cargo sells at this fraction of listed marketValue)
    SELL_PRICE_MODIFIER: 0.85,  // 85% of listed value (market spread)

    // Bulk bonus: selling > 50kg at once gets a bonus
    BULK_THRESHOLD_KG: 50,
    BULK_BONUS_MULTIPLIER: 1.15,
  },

  // =========================================================================
  // SPACE ELEVATOR CONTRACT — Endgame Win Condition (Phase 5)
  // =========================================================================

  ELEVATOR_CONTRACT: {
    TARGET_MASS_KG: 10000,     // 10,000 kg to complete the contract
    CONTRIBUTION_TYPES: ['refined_aluminum', 'refined_titanium', 'refined_steel', 'refined_copper', 'refined_iridium'],
    // Only REFINED metals count towards the contract (incentivizes using the Forge)
    BONUS_CREDITS_PER_KG: 5,  // bonus credits on top of selling price for contributing
    WIN_BONUS: 50000,          // credits bonus for completing the contract
  },

  // =========================================================================
  // TRAWLING — Passive debris collection along orbit path (Phase 6)
  // =========================================================================

  TRAWLING: {
    MAX_TRAWL_ARMS: 3,                    // max arms that can trawl simultaneously
    TRAWL_RADIUS_KM: 0.05,               // capture radius while trawling (50m)
    TRAWL_SPEED_SCALE: 0.3,              // trawling arm moves at 30% normal speed
    FUEL_RATE_TRAWL: 0.002,              // fuel consumption per second while trawling (very low)
    AUTO_CAPTURE_MASS_MAX: 50,            // auto-capture debris up to 50kg
    TRAWL_DURATION_MAX: 120,              // max trawl time before auto-recall (seconds)
    TRAVERSE_SPEED_DEFAULT: 0.000002,     // scene units/s (~0.2 m/s)
    SPEED_ADAPT_UP: 1.5,                  // multiplier when catch ratio > 80%
    SPEED_ADAPT_DOWN: 0.6,               // multiplier when catch ratio < 30%
    SPEED_MIN: 0.0000005,                // minimum traverse speed
    SPEED_MAX: 0.00002,                   // maximum traverse speed
    IDLE_TIMEOUT: 60,                     // seconds with no targets → auto-end
    WINDOW_CLOSING_THRESHOLD: 0.8,        // fraction of max range → warning
    SPEED_MAINTAIN_HIGH: 0.8,             // catch ratio above this → speed up
    SPEED_MAINTAIN_LOW: 0.3,              // catch ratio below this → slow down
    NET_MASS: 5,                          // kg — trawl net mass (for recoil compensation)
    DEPLOY_SPEED: 2,                      // m/s — trawl net deployment speed
  },

  // =========================================================================
  // EDT — Electrodynamic Tether deployment to attract small debris (Phase 6)
  // =========================================================================

  EDT: {
    DEPLOY_LENGTH_KM: 0.1,     // 100m tether
    POWER_DRAW: 0.05,          // Wh per second (an absolute draw, NOT a fraction of capacity)
    ATTRACTION_RADIUS_KM: 0.2, // 200m — draws small debris closer
    ATTRACTION_FORCE: 0.0001,  // km/s² — gentle pull
    MAX_ATTRACT_MASS: 20,      // only affects debris < 20kg
    DEPLOY_TIME: 5,            // seconds to deploy
  },

  // =========================================================================
  // ROUTE PLANNER — ΔV-optimal multi-target visit order (Phase 6)
  // =========================================================================

  ROUTE_PLANNER: {
    MAX_WAYPOINTS: 6,          // max targets in a planned route
    DISPLAY_DV_THRESHOLD: 0.01, // don't show ΔV < 10 m/s legs
  },

  // === HUD Configuration (Phase R4) ===
  HUD: {
    COLORS: {
      GREEN: '#00ff88',
      AMBER: '#ffaa00',
      RED: '#ff4444',
      BLUE: '#4488ff',
      WHITE: '#ccddcc',
    },
    THRESHOLDS: {
      BAR_AMBER: 0.30,     // 30% — bar turns amber
      BAR_RED: 0.15,        // 15% — bar turns red
      BAR_PULSE: 0.05,      // 5% — bar starts pulsing
      BAR_CRITICAL: 0.01,   // 1% — continuous alarm
    },
    PANEL_WIDTH: 220,
    LABEL_WIDTH: 42,
    DV_ALARM_INTERVALS: [15, 8, 3, 0],  // seconds between beeps per tier
    // Calm-HUD ceiling: no HUD pulse may exceed this rate. Standing states
    // read steady (colour/glyph carry severity); events pulse finitely.
    // Route retained pulses through js/ui/hudPulse.js, which enforces this.
    MAX_ALERT_PULSE_HZ: 0.5,
  },

  // === Audio Configuration (Phase R4) ===
  AUDIO: {
    AMBIENT_GAIN: 0.01,
    // §14.6 (Sprint 4) removed SFX_GAIN: 0.15 — declared but never referenced
    // anywhere in the codebase. The SFX bus uses a hardcoded 0.7 gain at
    // [`AudioSystem.js:116`](js/systems/AudioSystem.js:116). Keep AMBIENT_GAIN
    // (used by opt-in `?ambient=1`) and ALERT_GAIN (used by warning/conjunction
    // earcons — see AudioSystem.js:1820, 1848).
    ALERT_GAIN: 0.20,
    // §13 Sprint 4 escalation — gameplay ambient loop default OFF.
    //
    // Root cause investigation: even after the low-power AudioContext fix
    // (latencyHint:'playback' + sampleRate:22050, §13.5), the user reported
    // the fan still triggered on sim-start (MENU → ORBITAL_VIEW). A/B test
    // with ?noAudio=1 confirmed the audio thread is still the trigger.
    //
    // The ambient loop creates two continuously-looping BufferSource nodes
    // (white noise) + two BiquadFilter nodes (bandpass) that keep the audio
    // render thread permanently busy from the moment ORBITAL_VIEW starts.
    // Even at 22 kHz the filters process every render quantum (~46 ms at
    // 1024-sample 'playback' buffer = ~22 wakeups/s per filter chain, plus
    // every gain ramp scheduled via linearRampToValueAtTime). On Apple
    // Silicon this is enough to push Energy Impact across the SMC fan-trip
    // threshold.
    //
    // Toggling the ambient loop off means the AudioContext still exists
    // (so SFX play instantly without resume-latency) but no continuous
    // sources are running between SFX events. The audio thread can c-state
    // park between callbacks.
    //
    // URL flag override: `?ambient=1` enables it for users who want the
    // engine-room sound (and accept the energy cost). `?noAmbient=1` is
    // also accepted for symmetry but is the default.
    AMBIENT_LOOP_ENABLED: false,
    EARCON_FREQUENCIES: {
      SUCCESS: [261, 329, 392],    // C4, E4, G4 — ascending major
      ALERT: [392, 329],            // G4, E4 — descending third
      CONFIRM: [600, 600],          // two same-pitch blips
      CYCLE: [400, 450, 500, 550, 600],  // ascending steps for T key
    },
    // Audio Vocabulary Overhaul (2026-07-23) — per-family bus default gains.
    // Tuning-only table (see plan §P2); NOT surfaced as settings sliders.
    // Every family bus routes → sfxBus → master. Start flat at 1.0 except a
    // slightly quieter TICK so input confirms sit under informative cues.
    FAMILY_GAIN: {
      physical: 1.0,
      radio: 1.0,
      ping: 1.0,
      tick: 0.8,
      deny: 1.0,
      alarm: 1.0,
      reward: 1.0,
      pad: 1.0,
    },
    // P6 — core-loop range-closing ticker: a soft PING blip whose cadence
    // rises as the player closes on a selected out-of-net-range target (the
    // audio partner of the reticle distance readout).
    RANGE_TICKER: {
      ENABLED: true,
      START_M: 2000, // only tick when distM < START_M
      MIN_HZ: 0.5,   // cadence at START_M (far)
      MAX_HZ: 3,     // cadence just outside net range (close)
      GAIN: 0.05,
    },
    // Startup legibility (2026-07-24): several cues fire from AUTOMATION in
    // the first seconds of a mission with zero player action — the dossier
    // manifest typewriter (auto-locked target's passive survey) and the first
    // onboarding hint chime. Each lands as an unexplained noise while the
    // player is still parsing the departure handoff. Suppress these
    // non-essential cues for this window after entering gameplay from the
    // menu; their visuals (typewriter rows, hint card) still appear, and cues
    // fired after the window keep their voice. Danger/ALARM cues are never
    // gated by this.
    STARTUP_CUE_GRACE_S: 30,
  },

  // =========================================================================
  // GAMEPLAY LOOP — Phase 1 Core Feel (from GAMEPLAY_LOOP.md)
  // =========================================================================

  // --- Lasso System ---
  LASSO_RANGE: NET_REACH_M,            // meters — === NET_LOCK_RANGE_M (W1 net-reach D1: the gate is the in-range ring the player sees; was 200)
  LASSO_SPEED: 10,                     // m/s launch velocity — 10 m/s (50% slower) for deliberate space-sim cast feel
                                       // accounts for TIME_SCALE_GAMEPLAY×10 so apparent speed is 100 m/s game-time
  LASSO_MAX_FLIGHT_TIME: 8,            // seconds real-time before auto-retract. MEASURED (c64c911, static target): the head flies
                                       // LASSO_SPEED × TIME_SCALE_GAMEPLAY = 100 m/s per REAL second, so 8 s ≈ 808 m of physical reach —
                                       // far past the 90 m LASSO_RANGE gate. test-NetReachTruth.js pins reach ≥ 1.1 × NET_LOCK_RANGE_M.
  LASSO_REEL_SPEED: 0.33,             // reel-in progress per real second (0→1; ~3 s total) — SLOWER than outbound to avoid tangles
  LASSO_MAX_CAPTURE_MASS: 10,          // kg
  // LASSO_AMMO_MAX retired 2026-10-20 (DECISIONS §33): the mother has ONE count of nets,
  // CAPTURE_NET.LARGE.MAGAZINE_SIZE (4), owned by CaptureNetSystem. The old 50 "small net shots" are gone.
  LASSO_FORWARD_ARC_DOT: 0.3,         // UX-3 #4 — min dot product for forward hemisphere (~72° cone)
  LASSO_CAST_WINDUP: 0.15,            // seconds — brief charging delay before lasso fires (cast feel)
  LASSO_COOLDOWN_CATCH: 2,            // seconds — cooldown after successful catch before next cast
  LASSO_COOLDOWN_MISS: 1,             // seconds — cooldown after miss/retract before next cast
  LASSO_PROJECTILE_MASS: 2.5,         // kg — mass of lasso net projectile (for recoil compensation)

  // --- Mother-net capture ceremony Phase 1 (visible throw) ---
  // .kilo/plans/mother-net-capture-ceremony.md §1A/1B/1C.
  // The first guided catch was invisible: contact fired at LASSO_CONTACT_RADIUS_M
  // (20 m) while guided #1 is pinned at ~22 m, so the net travelled ~2 m (~0.02 s)
  // at the 100 m/real-s rate. These make even a point-blank throw read as a real
  // arc that leaves the nose canister and travels.
  LASSO_MIN_FLIGHT_TIME: 0.8,         // seconds real-time — contact cannot fire before this, so the throw is always clearly seen
  LASSO_CONTACT_RADIUS_M: 6,          // metres — base contact radius (replaces the flat 20 m). Scaled down for near targets.
  LASSO_CONTACT_RADIUS_FRACTION: 0.35,// contactRadius = min(LASSO_CONTACT_RADIUS_M, fraction × launchDistance), floored
  LASSO_CONTACT_RADIUS_FLOOR_M: 3,    // metres — never shrink the contact test below this (so contact still triggers)
  LASSO_MUZZLE_OFFSET_M: 8,           // metres — forward (+Z/prograde) muzzle offset; net spawns/anchors at the nose, not the hull centre
  LASSO_RECOIL_KICK_M: 2.5,           // metres — peak cosmetic mesh kick opposite launch (visual only; no orbit/fuel change)
  LASSO_RECOIL_DECAY: 5.0,            // 1/s — critically-damped spring rate for the recoil kick to settle back
  LASSO_MUZZLE_FLASH_TIME: 0.25,      // seconds — brief muzzle puff lifetime
  // Round 3 (2026-08-26, V4): the launch frame read as a blown-out white blob
  // on every take (tmp/lasso9-day f001) — a 5 m near-solid white sphere
  // (10 m geo × 0.5 scale at 0.95 opacity) parked at the nose right where the
  // opening web crosses it in screen space. Tamed to a genuine sub-bloom puff:
  // ~1.8 m radius at 0.4 peak opacity — the thwip stays visible, the frame
  // stays readable. Same 0.25 s life.
  LASSO_MUZZLE_FLASH_SCALE: 0.18,     // multiplier on the muzzle-flash sphere (small puff, not a hull-sized white blob)
  LASSO_MUZZLE_FLASH_OPACITY: 0.4,    // peak opacity at launch (was a hardcoded 0.95 — solid white)

  // --- Mother-net capture ceremony Phase 3 (reel-in physics) ---
  // .kilo/plans/mother-net-capture-ceremony.md §PHASE 3 (flag LASSO_REEL_PHYSICS).
  // GATED OFF on Mission 1 AND for capturedMass ≤ LASSO_MAX_CAPTURE_MASS (10 kg),
  // so M1 / welcome catches reel EXACTLY as today regardless of the flag. Only
  // heavier later catches feel mass-driven tension, a CoM pull, and break risk.
  LASSO_TENSION_BASE_N: 1.0,          // N — baseline tether tension (mirrors CaptureNet.js:879)
  LASSO_TENSION_PER_KG: 0.1,          // N per kg of captured mass (mirrors CaptureNet model)
  LASSO_NET_RATED_MASS_KG: 50,        // kg — Mother-net rated payload; strain = capturedMass / rated
  LASSO_REEL_PULL_GAIN: 0.6,          // dimensionless — CoM nudge scale (× mass/shipMass × reelRate), clamped by RCS_MAX_SPEED
  LASSO_REEL_TORQUE_GAIN: 0.8,        // dimensionless — attitude tug scale: reeling a heavy OFF-AXIS catch swings the Mother's nose toward it (× massRatio × lateral tether dir), fed to the recoil-attitude springs and RCS-nulled (2026-07-23)
  LASSO_NET_BREAK_TIME_S: 2.0,        // seconds above NET_STRAIN_SAFE_FRACTION before the tether snaps

  // --- Mother-net capture ceremony: net-held catch readability floor ---
  // A captured M1 welcome FRAGMENT is physically tiny (~0.6 m → 0.000006 scene
  // units), so at the gameplay camera distance it rendered sub-pixel: the catch
  // was pinned + reeled to the nose correctly but was INVISIBLE inside the net
  // and at the hull (owner: "debris seems to disappear ... should be visible in
  // the net"). While a catch is HELD by the Mother net (reel → cargo/furnace),
  // clamp its apparent render size up to this floor so it reads as a real catch.
  // Scoped to lasso-held catches only (via debris._catchRenderMin) so the
  // Daughter's small nets are unaffected. Stays well under the 7 m net mouth /
  // ~1.75 m cinched mouth, so it reads as "in the net", never bursting out.
  // This is a RENDERED RADIUS in metres — the write sites divide by the mesh's
  // bounding radius via DebrisWireframe.scaleForRenderRadiusM (whale-in-cone
  // item 8: stored as a raw scale the real floor was minM × br, mesh-dependent).
  // NAME COLLISION (register item 23): CAPTURE_NET.MOTHER_CATCH_MIN_RENDER_M
  // (2.0, :2676) is a DIFFERENT floor with the same name — THIS top-level one
  // (1.5) is the lasso FLIGHT-WEB floor; the CAPTURE_NET one is the ceremony
  // bag's.
  MOTHER_CATCH_MIN_RENDER_M: 1.5,     // metres — min apparent size of a net-held catch


  // --- Net-lock range SSOT (onboarding reward-first spine) ---
  // Single source of truth for "close enough to net". Drives (a) the autolock
  // in-range test, (b) the in-range-only lock earcon, (c) the OUT OF RANGE
  // reticle state, and (d) TARGET_IN_RANGE/OUT_OF_RANGE events. Reconciles the
  // old split between CaptureNet.BASELINE_RANGE_MAX (75 m) and LASSO_RANGE
  // (was a 200 m fire gate; W1 net-reach D1 made LASSO_RANGE this same number).
  // 90 m sits well inside the lasso's measured physical reach (~808 m, see
  // LASSO_MAX_FLIGHT_TIME) while reading as "right on top of it" for a new player.
  NET_LOCK_RANGE_M: NET_REACH_M,

  // --- Front-arc autolock (reward-first onboarding) ---
  // The reticle auto-selects the nearest forward, in-range debris so a new
  // player gets the satisfying lock + first catch in the first ~10 s. Permanent
  // assist for all players (Settings toggle can disable); manual T/click always
  // overrides. See .kilo/plans/new-player-onboarding-flow.md Phase 1.
  AUTOLOCK: {
    ENABLED: true,                     // master toggle (Settings can flip per-save)
    ARC_DOT: 0.5,                      // min dot(forward, toDebris) — ~60° half-cone front arc
    RANGE_M: 5000,                     // candidate search radius (m); the in-range test uses NET_LOCK_RANGE_M
    REACQUIRE: true,                   // auto-advance to next candidate after a capture
    REACQUIRE_DELAY_MS: 800,           // pause after a catch before the next lock (lets the reward register)
    // Guided-chapter fallback (M1 guidance, 2026-09-09): when the forward arc
    // holds nothing, a GUIDED chapter (MISSIONS.PROFILES[].guidedCluster —
    // missions 1–3) locks the nearest alive piece ANYWHERE within
    // GUIDED_FALLBACK_RANGE_M instead of leaving the reticle empty. The
    // selected-target off-screen arrow then points at it (behind-camera is
    // handled by TargetReticle._getEdgePosition) and the yellow OUT OF RANGE
    // state says "press A" — so a player whose cluster drifted behind the
    // mother is never left with nothing to steer toward. Cost: one extra O(n)
    // getDebrisNear pass, only on frames with no target and an empty arc.
    GUIDED_FALLBACK_ANY_ARC: true,     // fall back to nearest-any in guided chapters (DebrisField.isGuidedChapter())
    GUIDED_FALLBACK_RANGE_M: 100000,   // metres — the fallback search radius (100 km: the whole drifted cluster, not the whole field)
  },

  // --- Capture Net Visual (ST-2.4 → FIX-2.4a → v2 polish) ---
  NET_SPIN_HZ: 4,                       // rotations per second during flight (gyroscopic stabilisation)
  NET_COMPACT_SCALE: 0.45,              // scale factor during reel-in (was 0.15 — too small to see)
  // Phase 2 net kinematics (flag LASSO_NET_KINEMATICS) — open-on-launch + cinch-on-capture.
  NET_SPIN_UP_TIME: 0.4,                // seconds — net opens from compact to full as gyro spin ramps
  NET_LAUNCH_COMPACT_FRAC: 0.3,         // mouth radius fraction at launch (leaves the canister compact, then opens)
  // Tether catenary
  NET_TETHER_SAG: 2.0,                   // metres — catenary sag at tether midpoint
  NET_TETHER_SEGMENTS: 24,              // segments along tether curve (more = smoother sag — was 20)


  // --- Unified "web in space" net look (NetMeshKit — both Mother + Daughter) ---
  // The Mother net (LassoSystem) renders through the shared NetMeshKit, sized +
  // styled by these knobs so it reads as a delicate translucent WEB the small
  // operator casts — never the rejected 8 m chrome octagon-cage + 3 m boulders.
  // The "small child / large balloon" scale rule (GAME_DESIGN.md §2.1): the net
  // is subordinate to mother + catch. (The old 8 m perimeter / 1.5 m weight
  // spheres and their BOLAS_* aliases were deleted 2026-10-17: nothing read them.)
  NET_WEB: {
    MOTHER_DIAMETER:    6.0,    // m — Mother net mouth diameter. 6 m since 2026-10-20 (DECISIONS §33
                                // row 1: four nets must each fit in their own cartridge; was 7 m,
                                // and the large net itself was 8 m). Matches CAPTURE_NET.LARGE.DIAMETER.
    WEB_COLOR:          0xffe9c8, // warm ivory Dyneema (V5 nudge from 0xeaf1ff —
                                // the threads read warmer against black + the
                                // Earth limb; still bright enough not to gray-out
                                // at the in-game (distant) framing).
    WEB_OPACITY:        0.8,    // translucent but luminous — at the real fire
                                // distance the fine threads must not gray out
                                // (was 0.6, read cold/faint in-game — §B luminance).
    EDGE_NODE_COUNT:    6,      // edge-node glints (was 4 boulders)
    EDGE_NODE_RADIUS_M: 0.10,   // m — tiny glints, not ballast (was 1.5 m; ~match daughter 0.08)
    // (removed 2026-06-30) REEL_COLOR — the web no longer tints green on capture.
    // A real net doesn't change colour when it grips; capture state lives on the
    // HUD/comms now (see LassoSystem reel-in + CaptureNetVisual realism pass).
    // The web is a fat-line orb-weaver spoke+ring mesh (LineSegments2 +
    // LineMaterial from three/addons/lines): RADIAL_SPOKES radial threads
    // (apex→rim) + RING_COUNT concentric "spiral thread" rings. Fat-lines carry
    // real screen-space width + built-in AA, so an ultralight (physically sub-mm
    // Dyneema) thread renders as a soft, legible ivory web — never the rejected
    // cold 1-px aliased line. Browser-tunable.
    // Counts restored to the owner-approved spike (22×6, ~20×6): finer than this
    // reads as gray fuzz at the distant in-game framing; coarser cells read
    // clearly as a *net*. Width bumped so threads stay legible when small.
    RADIAL_SPOKES:      20,     // radial threads — clear web cells at distance (16–24)
    RING_COUNT:         6,      // concentric rings — clear mesh (4–6)
    LINE_WIDTH_PX:      2.4,    // fat-line thread width px — legible ivory strand at the in-game distance
    NODE_ADDITIVE:      true,   // edge-node glints use additive sparkle (threads stay flat/translucent)
    // V3 — tether width in METRES for the worldUnits Line2 variant: the strand
    // carries real geometry-like thickness (thickens on approach, AA-smooth at
    // distance), replacing fixed screen px. Physically sub-mm Dyneema — 5 cm is
    // the honest gossamer read at the 5–60 m ceremony framing (the rejected
    // TubeGeometry at r ≈ 0.06 m staircased; the fat line does not).
    TETHER_WIDTH_M:     0.05,
    // V4 — per-thread depth shading (depthWrite stays FALSE by design): vertex
    // colours dim toward this fraction of the base colour across the bag's own
    // view-depth extent, so the far side of the bag recedes. Self-normalized
    // per frame (bag min/max distance), so it reads at any camera range.
    DEPTH_DIM_FRACTION: 0.5,
    // V6 — cinch flash: rim-node emissive ramps briefly past the 2.5 bloom
    // threshold (SceneManager bloomPass.threshold) as the bag seats, then
    // settles back down. The cinch snap lands at fraction ≥ 0.85, so the ramp
    // peaks there and holds through the weld, decaying over NODE_FLASH_SETTLE_S
    // (wall clock — a garnish transient, not a state signal).
    NODE_EMISSIVE_BASE: 0.6,        // resting rim-node glint (sub-bloom)
    NODE_EMISSIVE_CINCH_PEAK: 3.2,  // cinch flash peak — 28% over the 2.5 threshold
    NODE_FLASH_SETTLE_S: 1.2,       // seconds to decay peak → base after the weld
    // V8 — sell contact: the membrane compresses where the catch presses into
    // the bag (an inward dent peaked at the catch's seat, scaled by the same
    // drape parameter driving ENVELOP), and a brief sub-bloom rim light marks
    // the first touch (V6's cinch flash owns the bloom crossing).
    CONTACT_COMPRESS_FRAC: 0.08,    // mouthRadius × this — press depth at the seat
    CONTACT_FLASH_PEAK: 1.5,        // rim-node emissive bump at first touch (sub-bloom)
    CONTACT_FLASH_SETTLE_S: 0.6,    // seconds the touch glow takes to settle
    // V2 — lit membrane under the threads (the hybrid web). A MeshPhysicalMaterial
    // film driven by the SAME drape functions as the threads, so sun + earthshine
    // read on the bag while the web reveals the catch through it. Inherits the
    // threads' reveal rule: transparent, depthWrite:false. envMap comes from
    // getOrbitalFoilEnv(renderer) via NetMeshKit.setEnvTexture (null headless →
    // scene.environment applies).
    MEMBRANE_OPACITY:   0.28,   // faint film — reads as fabric, never a wall (× web opacity fade)
    // 2026-08-25 (bubble-look fix): as the drawstring closes, the film fades
    // toward this rest so the CATCH reads through its own wrap — the closed
    // bag was a flat opaque tent ("party balloon / paper airplane" in the
    // tmp/cinema PARK_HOLD frames) because 0.28 × DoubleSide self-overlap
    // compounds to ~0.5. Lerped by cinchFrac in NetMeshKit.updateWebDrape, so
    // it is smooth by construction and reverses on a failure release.
    MEMBRANE_OPACITY_WELDED: 0.13,
    // 2026-08-25 (small-catch plan W2a): the welded rest is SIZE-AWARE. 0.13
    // was derived on the ~2 m cubesat — a catch you look INTO the bag at, its
    // silhouette carrying the read. A sub-metre fragment's closed bag is a
    // thin near-axis bundle (measured tmp/frag-before: drawn rim 0.36–0.42 m
    // at cinch=1, film 0.13 ⇒ effectively invisible — the owner's "just a
    // cone, nothing looks like fabric"). The welded target now lerps toward
    // this SMALL rest as the catch's LOGICAL size (sizeMeter — stable through
    // the whole ceremony, unlike the floored rendered radius) drops through
    // the band below: sizeM ≥ LARGE_SIZE_M keeps the 0.13 whale look
    // bit-identical; sizeM ≤ SMALL_SIZE_M reads as bunched fabric at 0.24.
    // Applied in NetMeshKit.updateWebDrape (the one welded-fade home); a
    // missing/zero catch size keeps the plain welded rest, so legacy mocks
    // and empty (miss) bags are byte-identical.
    MEMBRANE_OPACITY_WELDED_SMALL: 0.24,
    MEMBRANE_WELDED_LARGE_SIZE_M: 2.0,   // ≥ this logical size → welded 0.13 (whale class)
    MEMBRANE_WELDED_SMALL_SIZE_M: 0.8,   // ≤ this logical size → welded 0.24 (fragment class)
    MEMBRANE_ROUGHNESS: 0.8,    // cloth, not film gloss
    MEMBRANE_TRANSMISSION: 0.15, // low — a hint of light through the film
    MEMBRANE_SHEEN:     0.5,    // fabric sheen response
    MEMBRANE_ENV_INTENSITY: 0.9,
    // 2026-08-26 (night readability): the membrane is the bag's ONLY lit body
    // surface (MeshPhysicalMaterial) — in Earth shadow the directional sun
    // drops to 0.05 and the film goes pitch black, so an active capture reads
    // as bare threads ("no bag, just a cone" — tmp/lasso-take f019,
    // tmp/lasso2-night-before f003–f008). A tiny UNCONDITIONAL emissive floor
    // (the DebrisField.js:1304–1329 night-side precedent: heavily desaturated
    // tint, intensity low enough to vanish in daylight) keeps the film's
    // silhouette readable at night without moving any day value: the fabric/
    // pixel gates are day-lit + one-sided (fail only BELOW baseline − tol),
    // and every opacity constant above is untouched. The web/tether threads
    // are unlit LineMaterials and never needed this. Nets only exist during
    // captures, so this IS "active capture reads on the night side".
    MEMBRANE_EMISSIVE_FLOOR: 0.12,
    // 2026-08-26 (owner round 2) — the wrap/berth ENGULF seat: the caught
    // piece rides at this fraction of the cone height INSIDE the web/bag
    // (fabric on both sides = engulfed), never at the apex tip where it read
    // "alongside the net" (owner: "the debris is not even inside the net").
    // The pod path already does this (whale-in-cone follow-up 2: _catchSeatM
    // = the depth the capture left the catch at); this is the lasso/adoption
    // counterpart, one dial for both kits.
    WRAP_SEAT_FRAC: 0.42,
    // 2026-08-26 (owner round 2) — organic flight web: the cast net billows
    // (per-spoke sinusoidal undulation, the kit's jiggle channel) instead of
    // flying as a mathematically perfect cone (owner: "a net does NOT need to
    // look like a boring symmetric cone"). Amp is a fraction of the mouth
    // radius; drape stays 0 in flight so contents floors and the welded fade
    // are untouched by construction.
    FLIGHT_BILLOW_FRAC: 0.08,
    FLIGHT_BILLOW_HZ: 0.9,
    // 2026-08-27 (§11.2 deferred presentation — the "windsock-flutter" beat
    // missFailureKind deliberately left unstaged in Wave 2): a SMALL net whose
    // rim spin bled through MOUTH_TENSION_FLOOR_N latches the one-way
    // NetProjectile.mouthCollapsed; the RENDER side alone (CaptureNetVisual)
    // eases the mouth toward the drawstring-closed radius and ripples the
    // slack fabric. Keyed off the queryable latch only — the visual never
    // recomputes tension physics.
    MOUTH_COLLAPSE_CINCH_FRAC: 0.65,   // fraction of a FULL drawstring close the dead mouth pinches to — rim lands ≈45% of open: clearly slack, never the welded 1.0 only a real catch earns
    MOUTH_COLLAPSE_EASE_S: 0.4,        // s, latch → full slack pose — inside the <0.5 s read budget, slow enough not to pop
    MOUTH_COLLAPSE_FLUTTER_FRAC: 0.10, // mouthRadius × this — windsock ripple amp, seated between the ENVELOP (0.12) / CINCH (0.06) settle-jiggles; garnish-gated like both
    // 2026-08-26 (owner round 2) — the held bag over a SUB-METRE catch read
    // as a bare thread lattice ("WTF is that geodesic globe") because the
    // floored contents box inflates the dome while the film rests near-clear:
    // the BERTHED/COLLARED thread opacity now lerps 0.55 → this rest across
    // the same [SMALL_SIZE_M … LARGE_SIZE_M] band as the welded film, so the
    // fabric (film + rosette) carries the small-bag read and the lattice
    // recedes. Whale-class (≥ LARGE_SIZE_M) and size-less mocks stay at the
    // 0.55 byte — the gated pod subjects never move.
    THREAD_OPACITY_HELD_SMALL: 0.30,
    // 2026-08-26 (round 3, V3) — sock gather: after the cinch the mouth-side
    // fabric trailed as an EMPTY gathered sock behind the bundle (the mouth
    // ring + drawstring park on the mouth plane, ~3 m behind a sub-metre
    // piece). The LASSO wrap now gathers the mouth ring toward the contents'
    // far face (drawstring-rosette language) — a ring-z lever of the lasso
    // kit only (NetMeshKit updateWebDrape `mouthGather`); the pod-path bag
    // never passes it, so every gate-pinned geometry family is untouched by
    // construction. FRAC = how far toward the far face the rosette lands
    // (1 = ON the face); RAMP = reel-progress span after WRAP_END over which
    // the gather eases in (the wrap itself stays the round-2 look).
    WRAP_SOCK_GATHER_FRAC: 0.75,
    WRAP_SOCK_GATHER_RAMP: 0.25,
  },

  // =========================================================================
  // CAPTURE NET SYSTEM — ST-9.4 C-6 (Config G)
  // Per CAPTURE_NET.md §2–§6 canonical spec. Gated by FEATURE_FLAGS.CAPTURE_NET.
  // =========================================================================
  CAPTURE_NET: {
    // ── Net Projectile States ──
    STATES: {
      FOLDED:        'FOLDED',
      LAUNCHING:     'LAUNCHING',
      SPINNING_UP:   'SPINNING_UP',
      FLIGHT:        'FLIGHT',
      CONTACT:       'CONTACT',       // slam-wrap contact
      BRAKE:         'BRAKE',         // tether-brake (cinch path)
      ENVELOP:       'ENVELOP',       // rim weights sweep past (cinch)
      CINCH_CLOSING: 'CINCH_CLOSING', // drawstring cinch
      SECURE_CHECK:  'SECURE_CHECK',  // cling/cinch success roll
      CAPTURED:      'CAPTURED',      // debris secured
      MISSED:        'MISSED',        // cling failed / timeout
      REELING:       'REELING',       // motor reel-in
      STOWED:        'STOWED',        // back at platform
      RELEASED:      'RELEASED',      // player abort — net+debris float free
      // Mother-net-reel plan §8 A2: terminal mother-catch state. The catch is
      // pinned at the pod muzzle standoff, visible in the cinched net, adds
      // translational mass, and slews/burns with the ship until the securing
      // timer (BERTH_SECURE_S) commits it for score + salvage and parks it
      // (cargo-continuity S3), or the player jettisons it [K]. Replaces STOWED
      // for mother catches.
      BERTHED:       'BERTHED',       // catch docked at the mother launcher
      // Cargo-continuity S3 → S13(c): after the securing timer (BERTH_SECURE_S)
      // commits the credit, the catch MATES at the nose berthing collar — the
      // rigid on-axis station the owner ruling made doctrine (2026-08-14, B).
      // Held at the collar seat inside its net until the mother-side digestion
      // clock consumes it (the S8 transit clock at the collar), the S7 transfer
      // hands it to a daughter rack, or it is jettisoned [K]. Nothing is
      // removed on camera; the berth hold pins it every frame;
      // getDockedCatch()/getBerthedMassKg() count COLLARED. S13(e): the
      // occupancy refusal is gone — the pods are off the boresight and a shot
      // refuses only when its own corridor fouls the mated cargo (per-shot,
      // geometric). The net IS the container — the bag is never faded. (Named
      // PARKED pre-S13(c), when the same hold swung on the tether pendulum —
      // a rigid mate does not.)
      COLLARED:      'COLLARED',      // credited catch mated at the nose berthing collar
      // Cargo-continuity S7: the catch is in flight from the collar seat to a
      // daughter's cargo rack, still inside its net (the bag is the container in
      // transit). The mass keeps counting as berthed for the whole beat — it
      // drops at arrival, when the rack picks the piece up, so the cargo ledger
      // is continuous across the hand-off. S13(e): getDockedCatch() survives as
      // an accessor (HUD/status + the per-shot foul read); it no longer gates
      // the launcher.
      TRANSFERRING:  'TRANSFERRING',  // collared catch flying nose → strut tip
    },

    // ── Capture Modes ──
    MODES: {
      SLAM_WRAP: 'SLAM_WRAP',   // durable targets
      CINCH:     'CINCH',       // delicate targets (tether-brake bag)
    },

    // ── Phase Timings (seconds) — per CAPTURE_NET.md §2.4 ──
    CAST_WINDUP:          0.15,   // crossbow spring release (§2.4 phase 1)
    SPIN_UP_TIME:         0.5,    // yo-yo despin (§2.4 phase 2)
    // ── Yo-yo despin spin visual (2026-06-11 Item 2; §11.6 doc fix 2026-08-27:
    //    STYLIZED, not L-conserving) ──
    // A folded net canister spins FAST and DESPINS as the rim weights deploy and
    // the radius grows — the DIRECTION of the effect is the real yo-yo despin
    // (I ∝ r², so ω falls as the mouth blossoms; RemoveDEBRIS 2018 flight HW spun
    // ~1–2 Hz once blossomed). The MAGNITUDE is a deliberate visual
    // simplification: closed-form L = Iω conservation from a ~5 cm folded radius
    // would demand a ~(r_open/r_fold)² = (4.0/0.05)² ≈ 6400× spin ratio on LARGE
    // — an invisible blur at 12 kHz-equivalent. The 3× below instead implies a
    // fictional folded radius of r_open/√3 (≈ 2.3 m on LARGE — not a canister),
    // chosen so the "unwind fast, blossom, settle" beat reads at
    // animation-legible rates. So spin STARTS high and SETTLES to the class
    // SPIN_HZ as the mouth opens — the previous 0→SPIN_HZ ramp was
    // angular-momentum backwards in DIRECTION, which is the part worth keeping
    // honest. The rim-weight tension table below shows SPIN_HZ alone already
    // holds the mouth open (>10 N per spoke), so the elevated folded spin is
    // purely the "unwind" transient.
    SPIN_FOLDED_MULT:     3.0,    // canister starts at SPIN_HZ × this, decays to SPIN_HZ (stylized visual ratio — see note above)
    // Slow in-flight spin decay (mesh flexing + rim drag). Makes spinFraction a
    // LIVE gameplay factor in computeClingProbability: long shots arrive with
    // spinFraction < 1 → f_spin penalty → "fire inside the envelope or the wrap is
    // weak". Tuned (Item 2 risk note) so an in-envelope (≤100 m / ≤~1 s) shot loses
    // <10% spin → Y0 difficulty does not regress. Shared default for the
    // daughter classes; LARGE carries a per-class override (the
    // MAX_FLIGHT_TIME idiom: netClass.SPIN_DECAY_PER_S ?? this) — §11.2
    // LARGE resolution, derivation at the LARGE block.
    SPIN_DECAY_PER_S:     0.08,   // fraction of SPIN_HZ lost per second of flight (SMALL/MEDIUM; LARGE overrides — see class block)
    // ── §11.2 mouth-collapse floor (2026-08-27) ──
    // The mouth-open condition (§11.1 audit table + the test-Crossbow-Constants
    // derivation guard) is F/wt = RIM_WEIGHT_MASS · (2π·spin)² · (DIAMETER/2)
    // ≥ 10 N per rim weight — this constant IS that audit figure. With the
    // linear in-flight decay above (spin(t) = SPIN_HZ · (1 − SPIN_DECAY_PER_S·t))
    // and F ∝ ω², live tension falls as F(t) = F₀ · (1 − SPIN_DECAY_PER_S·t)²,
    // so the floor is crossed at
    //   t* = (1 − √(MOUTH_TENSION_FLOOR_N / F₀)) / SPIN_DECAY_PER_S,
    // where F₀ = F/wt at the settled SPIN_HZ. From the live class constants
    // (re-derived + pinned in test-CaptureNet-MouthCollapse.js):
    //   SMALL  F₀ ≈ 16.0 N → t* ≈ 2.61 s ≈ 26 m at 10 m/s — INSIDE its 8 s /
    //          100 m envelope: the §11.2 gap. NetProjectile latches
    //          `mouthCollapsed` in flight and contact resolves as a distinct
    //          'mouth_collapsed' MISS (§11.2 floor-check fix).
    //   MEDIUM F₀ ≈ 79.0 N → t* ≈ 8.05 s — beyond its 8 s MAX_FLIGHT_TIME by
    //          only ~51 ms: unreachable, enforcement provably inert.
    //   LARGE  F₀ ≈ 47.4 N → t* ≈ 13.51 s ≈ 135 m at its per-class
    //          SPIN_DECAY_PER_S 0.04 override (§11.2 LARGE resolution,
    //          2026-08-27 — see the LARGE block for the full derivation).
    //          OUTSIDE every reachable contact (tether pay-out 10 s,
    //          MAX_FLIGHT_TIME 11 s) by ≥ 2.5 s: enforcement live for the
    //          class and provably inert, and the 100 m whale envelope stays
    //          honest (worst reachable arrival ≈ 17.1 N ≥ floor). The former
    //          LARGE.MOUTH_COLLAPSE_DEFERRED escape hatch is retired.
    MOUTH_TENSION_FLOOR_N: 10,    // N per rim weight — mouth-open floor (§11.1/§11.2)
    MAX_FLIGHT_TIME:      8,      // max tether pay-out (§2.4 phase 3)
    SLAM_CONTACT_TIME:    0.5,    // slam-wrap wrap duration (§2.4 phase 5a, min)
    BRAKE_TIME:           0.5,    // tether-brake application (§2.4 phase 5b)
    ENVELOP_TIME:         1.5,    // rim-weight sweep (§2.4 phase 5b)
    CINCH_CLOSE_TIME:     2.0,    // drawstring cinch + settle (§2.4 phase 5b+§8)
    SECURE_CHECK_TIME:    0.2,    // capture probability roll (§2.4 phase 6)
    MAGAZINE_ADVANCE_TIME: 0.5,   // next net rotates into position (§2.4 phase 8)

    // ── Cooldowns (seconds) ──
    COOLDOWN_CATCH:       2,      // after success before re-fire (LASSO_COOLDOWN_CATCH)
    COOLDOWN_MISS:        1,      // after miss before re-fire (LASSO_COOLDOWN_MISS)

    // ── Failure staging (cargo-continuity S5, owner item 7) ──
    // A failure used to be a state flip to MISSED plus an empty reel-back:
    // nothing deformed, nothing slid off, nothing tore. The three modelled
    // failures now get a staged beat built from kit drives that already exist:
    // a broadside BOUNCE pulses the drape up then recoils (the mouth never
    // closes), a STRAIN SLIP releases the cinch so the catch slides out of the
    // mouth, and a boost-reel RIP zeroes a wedge of spokes in the web's
    // per-vertex colour buffer (a visible hole) for the catch to drift out of.
    // The net holds MISSED for FAILURE_STAGING_S so the beat plays at the
    // contact point before the empty reel-back starts. Real seconds —
    // CaptureNet runs on wall-clock dt (ARCHITECTURE §13).
    FAILURE_STAGING_S:    1.4,
    NET_TEAR_SPOKE_START: 2,    // first spoke of the torn wedge (kit web layout)
    NET_TEAR_SPOKE_COUNT: 5,    // wedge width — 5 of 20 spokes = a 90° gash

    // ── Mother berth (mother-net-reel plan §8) ──
    // Berth clearance: the reel completes when the catch's near face is this
    // far from the muzzle (mirrors ARM_HOLD_CLEARANCE_M). Completion range =
    // debris.sizeMeter/2 + BERTH_CLEARANCE_M.
    BERTH_CLEARANCE_M:    1.0,
    // 2026-08-26 (owner round 2) — the ADOPTED catch's interior seat depth:
    // the lasso hand-off previously set _catchSeatM = 0, pinning the piece AT
    // the bag apex — visually "alongside the bag", never inside it (owner:
    // "net/Bag is supposed to be AROUND the debris, engulfing"). The pod path
    // already seats catches INSIDE the bag at their capture depth (whale-in-
    // cone follow-up 2); adoption now uses this fixed seat, and the lasso
    // reel delivers the piece to collar-seat + fwd × THIS so the hand-off
    // still lands pin-exact (no snap). ONE-HOME LAW: byte-equal to
    // WRAP_SEAT_FRAC × the CN.LARGE bag cone height —
    //   (DIAMETER/2 × CONE_OPEN_RADIUS_FRAC) × 2 × CONE_LENGTH_FRAC ×
    //   WRAP_SEAT_FRAC = 3.0 × 2 × 0.85 × 0.42 = 2.142 —
    // pinned by test so the derivation cannot drift from the drawn bag.
    // (2.856 until the large net went 8 -> 6 m, DECISIONS §33 row 1, 2026-10-20: 4.0 -> 3.0 m radius.)
    ADOPT_CATCH_SEAT_M:   2.142,
    // l8-reel-collar (DECISIONS §25, owner 2026-10-15: "debris should be reeled-in
    // firm against docking collar"): the reel goes ALL THE WAY to the collar —
    // no 1.0 m standoff, no parked seat. HOME = the catch centre on the collar
    // axis: max(RING_TOUCH_Z_M + r, clearZ(r)), clearZ(r) the smallest bag-centre
    // z that clears every ship part by CLEARANCE_M (ShipKeepOut, measured once
    // per catch at reel entry; tmp/probes collar/RESULTS.md: 1.390 … 1.828 for
    // r 0.10 … 0.50). On the 2.30 m radiators the home is the same at every
    // radiator angle for r <= 1.4 (measured 2026-10-17 at EVERY whole degree
    // 0-180°: spread 0.00 mm on the rows 0.15 … 1.4; the 2.466-at-3° figure was
    // the 2.5 m arms). A bigger bag's home moves with the angle (r 2-3: 16-41 mm;
    // r 4.0: 5.349 at 146°, 5.402 at 3°, set by the radiator tip cone), so a
    // single query at reel entry is the home for THAT angle only — a catch
    // parked there fouls the cone when the radiators close later (r 4.0 at 146°,
    // then 3°: -32.4 mm). big-catch-every-angle (2026-10-17): ALL_ANGLE_HOME
    // (below) lifts the home of every catch above angleFreeMaxR so it clears at
    // EVERY angle; catchHomeDistM reads it. Big catches (a later boss level,
    // owner 2026-10-15) are OPEN: this block makes today's biggest piece (the
    // act-3 rocket body, sizeM 8 -> r 4.0) correct and designs no boss.
    // big-catch-home (2026-10-17): the sweep used to start at SEARCH_TOP_Z_M
    // only, so for r >= 3.2 (ring-touch z 1.32 + r above 4.5) it never ran and
    // the home was the UNCHECKED ring-touch z: r 4.0 z 5.320 where the true
    // clear home is 5.349 (5.402 at 3°) — 8.7 mm inside a sun-sensor window at
    // 7 angles, 61.0 mm inside the tip cone at 3° (r 3.2: 7.9 / 50.8 mm), all
    // measured on the real meshes. The sweep now starts at
    // max(SEARCH_TOP_Z_M, ring-touch z + MAX_ABOVE_TOUCH_M) — SEARCH_TOP_Z_M
    // is only the floor of that start (r <= 1.18 m: unchanged). If the sphere
    // at that start is itself blocked, the ring-touch z is kept but flagged
    // (`unchecked`, home source 'unchecked', one console.warn per catch).
    // BERTH_CLEARANCE_M above stays as the CORRIDOR / queue-spacing radius only.
    REEL_HOME: {
      RING_TOUCH_Z_M:   1.32,   // ship-local z of the ring's fore face: a bag of radius r touches it at 1.32 + r
      CLEARANCE_M:      0.02,   // bag surface to every ship part at home (owner rule)
      SEARCH_TOP_Z_M:   4.5,    // the keep-out sweep starts at max(this, RING_TOUCH_Z_M + r + MAX_ABOVE_TOUCH_M) and walks down the axis
      SEARCH_STEP_M:    0.05,   // sweep step before the bisection
      BISECT_M:         0.001,  // bisection stops at 1 mm
      MAX_ABOVE_TOUCH_M: 2.0,   // a clearZ more than this above ring-touch is a bad query: fall back to ring-touch
      APEX_AT_RING_M:   0.02,   // the bag's mouth (the tether end) sits this far fore of the collar plane at home = the ring's fore face
      // big-catch-every-angle (2026-10-17): the home that clears the bare ship at EVERY radiator angle. MEASURED on the
      // real meshes (tmp/probes/followups-1017/allangle/allangle.mjs): catchHomeZ(keep-out, r) at every whole degree
      // 0-180°, no tip bags, no held catches, arms as built. liftM[i] = max over the angles of (home z) minus the
      // ring-touch z (RING_TOUCH_Z_M + r), rounded UP to 0.1 mm; it includes the hull part (r 0.5: 0.0075 m) and, above
      // angleFreeMaxR, the radiator tip cone at 3° (r 4.0: 5.402 vs 5.320 = 0.082). Each row's home spread over the
      // angles: 0.00 mm for 0.15 … 1.4, then 16.4 (r 2.0), 31.3, 40.6, 47.7, 53.1 (r 4.0), 57.0, 60.2 mm (r 5.0) —
      // the worst angle is 3° on every row above 1.4. angleFreeMaxR = the largest row whose spread AND every smaller
      // row's is < BISECT_M: at or below it the home does not move with the angle, so catchHomeDistM adds NO term (the
      // current-pose home, byte-identical to before). Above it: home z = max(current-pose home, RING_TOUCH_Z_M + r +
      // lift(r)), lift linear between the two rows that bracket r (the test checks every row and the midpoints on the
      // meshes: test-BigCatchHome p1). Above the last row there is no measurement: the home is flagged `unchecked`.
      ALL_ANGLE_HOME: {
        radiiM: [0.15, 0.30, 0.50, 0.75, 1.0, 1.4, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0],
        liftM:  [0, 0, 0.0075, 0.0160, 0.0197, 0.0235, 0.0422, 0.0586, 0.0688, 0.0766, 0.0821, 0.0868, 0.0899],
        angleFreeMaxR: 1.4,
      },
      // Speed profile for the CATCH centre (the nominal speed is the net class reel speed): full speed, then a
      // constant-deceleration (DECEL_MPS2, an estimate) slow-down that reaches SLOW_MPS at SLOW_ZONE_M from home and
      // holds it to arrival.
      SLOW_ZONE_M:      0.30,
      SLOW_MPS:         0.10,   // <= 0.10 m/s arrival and in the last 0.30 m (LATCH_ALIGNED_MPS class contact speed); fb16 2026-10-25: was 0.08 (the crawl lasted 5 s)
      DECEL_MPS2:       1.0,    // m/s^2 — estimate: 2 m/s -> 0.08 m/s over ~2 m
      DECEL_LEAD_M:     0.10,   // the slow-down reaches SLOW_MPS this much BEFORE the slow zone, so a frame that straddles its edge is already slow
      // Drawn size (D3): the net-held readability floor applies at >= FLOOR_FAR_M from the collar, eases to the true
      // size by FLOOR_NEAR_M (smoothstep). Per frame the drawn size never moves more than FLOOR_MAX_STEP_FRAC of the floor.
      FLOOR_FAR_M:      20,
      FLOOR_NEAR_M:     3,
      FLOOR_MAX_STEP_FRAC: 0.15,
    },
    // Securing ceremony: after NET_BERTHED the catch sits at the launcher for
    // this long while Houston reads the mass, then CATCH_PROCESSED fires with
    // source:'mother' (score + salvage + clearDebris + autosave via the
    // existing GameFlowManager path — plan §19) and the catch PARKS (S3: the
    // body is KEPT at the nose — { parked: true } skips only the field
    // removal). Jettison [K] before expiry aborts with NO score and the whale
    // back in the field.
    BERTH_SECURE_S:       1.5,
    // Long-tether reel speed-up: at REEL_SPEED 2.0 a 100 m shot would reel for
    // ~50 s wall-clock. The ease below is monotonic (never decelerates mid-
    // reel, so the tether cannot re-slack and re-snap) and lands the duration
    // in the ~5–25 s window. remainingM is the single source for reelProgress.
    REEL_LONG_TETHER_M:   40,     // beyond this the reel speeds up
    REEL_LONG_TETHER_MULT: 3.0,   // speed multiplier at/above the long-tether range

    // ── Reel corridor clearance (mother-net-reel plan §10 Phase C-lite) ──
    // The reel pauses its final approach CORRIDOR_HOLD_M from the muzzle until
    // the corridor test passes (a cylinder along ship-local +Z from the muzzle,
    // radius = debris.sizeMeter/2 + BERTH_CLEARANCE_M, must contain no strut
    // tip / held daughter catch / lasso cargo cell). Analytic — no mesh
    // collision exists anywhere in this codebase. On CORRIDOR_TIMEOUT_S the
    // reel berths at CORRIDOR_EXTENDED_STANDOFF_M instead of clipping through.
    // Full clear-the-deck choreography (auto-park intruding struts) is
    // deferred until playtest shows real clipping.
    // big-catch-home (2026-10-17): the gate ALSO reads the ship keep-out for the
    // RADIATORS and the bags on their tips — the catch as a capsule (radius
    // sizeMeter/2) on the collar axis from its current distance down to its
    // home; any radiator part or tip bag closer than REEL_HOME.CLEARANCE_M holds
    // the reel (read only, no radiator command). The r + BERTH_CLEARANCE_M
    // cylinder is deliberately NOT applied to them: the closed radiators' tips
    // (2-13°) sit inside it for every r, yet a catch clears them by 0.085 m or
    // more (measured), so the cylinder would hold every catch whenever they are
    // closed. A home found before the radiators moved is not refreshed: this
    // read holds it and the timeout below berths it.
    CORRIDOR_HOLD_M:              10,   // m from the muzzle where the gate arms
    CORRIDOR_TIMEOUT_S:           8,    // s held before berthing at extended standoff
    // Extended standoff: berth here on timeout. Must be ≥ CORRIDOR_HOLD_M —
    // the hold range is already clear of every intruder: a π-swept strut tip
    // reaches only ~2.5 m fore, and at the 10 m hold even an 11 m whale's near
    // face sits at 4.5 m — also clear of the 4 m lasso cargo row. That is the
    // §4.13 overlap settlement: the gate holds until the furnace feed
    // (FEED_S ≤ 9 s) frees the cell, else the timeout berth is geometrically
    // clear of it. No lateral-spread constant needed.
    CORRIDOR_EXTENDED_STANDOFF_M: 10,
    // Berthed-mass translational effect (plan §8 A2 / §4.4). Applied ONLY in
    // PlayerSatellite._applyThrust as one massFactor scaling ti AND mag;
    // rotation stays kinematic and applyCartesianImpulse is deliberately
    // unscaled (the AP models RCS/station-keeping, not the main engine).
    // The clamp is NOT optional: raw (130+5000)/130 ≈ 39× and 23 t ≈ 178×
    // would leave thrust authority at 0.5–2.5% — a soft-lock.
    MASS_EFFECT_MULT:     1.0,
    MASS_EFFECT_MAX:      2.0,    // max massFactor divisor (2–3× per plan)
    // Render floor for a pinned mother catch — a RENDERED RADIUS in metres,
    // converted to an instance scale at the write sites via
    // DebrisWireframe.scaleForRenderRadiusM (÷ mesh bounding radius —
    // whale-in-cone item 8) — keeps a 500 kg+ catch legible at the muzzle
    // standoff.
    // NAME COLLISION (register item 23): the top-level
    // MOTHER_CATCH_MIN_RENDER_M (1.5, :2377) is a DIFFERENT floor with the
    // same name — THIS CAPTURE_NET-scoped one (2.0) is the CEREMONY-BAG
    // floor; the top-level one is the lasso flight-web floor.
    MOTHER_CATCH_MIN_RENDER_M: 2.0,
    // Reel-entry engagement ramp for the floor above (whale-in-cone item 15,
    // 2026-08-09 — owner decision: RAMP, plan 1786237166000). Pre-item-15 the
    // floor engaged at full strength on the FIRST reel frame — a measured
    // one-frame pop of 1.31× (2 m catch) to 3.33× (0.6 m fragment) at exactly
    // the instant the ceremony camera is on the catch. The reel/berth write
    // sites now ease the WRITTEN VALUE base → floor over this many NET-domain
    // seconds (the ceremony-scaled dt the net's own update applies, so the
    // ramp stretches under slow-mo like every other net animation). Readers
    // are untouched — the one clamp-aware SSOT effectiveRenderScale still owns
    // the predicate — and the scenario's _catchRenderMin property freeze
    // swallows the write whatever its value, so every gate stays bit-identical.
    // 0 degenerates to the pre-item-15 step. Feel knob: retune freely; it is
    // not a gate quantity.
    MOTHER_CATCH_MIN_RENDER_RAMP_S: 0.6,

    // ── Cargo hand-off: parked catch → daughter rack (cargo-continuity S7) ──
    // The mother's nose is the only place a tethered mass can be towed (it must
    // ride the thrust axis or every burn torques a non-rigid line), and it is
    // also where the one launcher fires from (on the axis, through the collar
    // bore). So a parked catch blocks the launcher by PHYSICS, and the only rigid attachment
    // point this ship models is a daughter's strut tip. Hence the hand-off.
    //
    // Owner ruling (2026-08-12 design review): AUTOMATIC, no hotkey — the player
    // holds no information the ship lacks (fuel, rack occupancy and the CG
    // arithmetic are all better known to the ship), so a keypress would be a
    // confirmation dialog with one option. The ship acts, names the carrier in
    // comms, and refuses ONCE when it cannot.
    CARGO_TRANSFER: {
      // UNREAD since the T2 race fix (2026-09-23): the hand-off is decided on
      // the first COLLARED tick, not after a dwell — the collar chop commits
      // +1.33 s (3 kg) to +4.43 s (10 kg) after the mate in sunlight, so any
      // dwell loses the race. Kept, value unchanged, only as a possible
      // duration for the later camera slice (T6b); the PARK_HOLD beats it
      // might ride are 4.0/6.0 s.
      DELAY_S:        5.0,
      // Retry cadence after a declined hand-off (no carrier qualifies, or the
      // furnace guard owns the piece). The scorer runs computeCoM, which
      // allocates — the net path must not allocate per frame (plan §13), and a
      // catch can sit unstowable for minutes.
      RETRY_S:        0.5,
      // Flight time nose → strut tip. Short deliberately: the physically honest
      // version is a 20–40 s slow walk (a 3 s toss implies ~5 m/s and ~1.5 m/s of
      // reaction on the mother before arrest), but that needs momentum
      // bookkeeping and an abort path — a separate order. 3 s matches the
      // FurnaceBreakdownVisual chunk-arc idiom this beat reuses.
      FLIGHT_S:       3.0,
      // Outward bulge of the quadratic Bézier control point (metres), so the
      // catch arcs around the hull instead of shearing through it. Same shape as
      // the furnace chunk arc, run backwards.
      ARC_BULGE_M:    2.0,
      // Mass gate (kg). Above this a body stays on the tether at the nose until
      // it is digested or jettisoned — it does NOT go to a strut tip. Physical
      // rationale: at 44–114× the 201 kg mother (SL-16 8.9 t, CZ-5B 23 t) the
      // system CoM sits inside the cargo, so moving that mass OFF the thrust axis
      // is the wrong move. Measured against data/debris-catalog.json: 24 objects
      // in 500–2000 kg are stowable, 22 heavier ones are not — so the whale's
      // SIZE decides the player's options. Tuning, not doctrine.
      MAX_KG:         2000,
      // Carrier scorer weights (plan §2.2.1): CG-drift improvement first,
      // "this daughter can't usefully deploy anyway" second. Deployability is
      // propellant ONLY — there is no per-arm panel-health field in the tree.
      W_CG:           1.0,
      W_DEPLOY:       0.5,
    },

    // Debris cutting step 5 (CUT_AT_NOSE): one cut takes this many GAME
    // seconds at the nose (dt × TimeAuthority.BASE_SCALE, deliberately NOT
    // sun-scaled — the cutter is a machine, not a plant). 60 game-s = 6 real
    // seconds per piece.
    // PLACEHOLDER — unsourced; electron-beam cut rate research is owed
    // (cutting plan §6 step 2). Tuning, not doctrine.
    CUT_S: 60,

    // ── Line-taut tug (mother-net-reel plan §9 Phase B) ──
    // When the net cinches onto a whale with residual relative velocity, the
    // tether goes taut and the catch yanks the Mother. The honest momentum
    // ratio is up to 177:1 (23 t vs 130 kg), so the cap below does nearly all
    // the work — it is the difference between "the Mother is visibly yanked"
    // and "the Mother is flung off-station". The tug is applied two ways:
    //   1. a 0.5–0.8 s critically damped spring window into _rcsVelocity
    //      (the shock absorber — feel-only, decays), and
    //   2. a REAL orbit impulse via applyCartesianImpulse with billing
    //      SKIPPED (passive momentum transfer costs no propellant) — the kept
    //      Δv is a genuine ΔV-economy event, comms'd and cancellable with RCS.
    // Do NOT call _autoRcsCompensation on the tug (keep-or-cancel by design).
    NET_TUG_MAX_DV_MS:    0.5,    // m/s — cap on the kept orbit impulse
    NET_TUG_WINDOW_S:     0.65,   // s — spring soft-capture window (0.5–0.8)
    // Share of the tug Δv that also drives _rcsVelocity (the feel component,
    // spread over NET_TUG_WINDOW_S — dt-robust by construction). The same
    // magnitude drives the orbit AND _rcsVelocity, so at 1.0 the transient
    // reads as ~2× the permanent Δv for the window duration: that overshoot is
    // the yank, now deliberate and tunable rather than accidental. Lower it
    // (0.5) if playtest says the yank overshoots.
    NET_TUG_FEEL_MULT:    1.0,

    // ── Phase D.7 garnish (mother-net-reel plan §11.7) ──
    // (a) Tumble carryover: the wrapped bundle keeps a decaying spin at ENVELOP
    // instead of the hard tumble freeze (_advanceTumble returns early on
    // _armPinned). The residual decays over TUMBLE_CARRYOVER_DECAY_S and feeds
    // a small extra pitch term into the berth-hold orientation. Shares the
    // orientation channel with §1.2 (ship-frame qLocal), so the two are built
    // together: the carryover is an offset ON TOP of the ship-rigid attitude.
    TUMBLE_CARRYOVER_DECAY_S: 5.0,   // s — residual spin decays to ~0 over 4–6 s
    TUMBLE_CARRYOVER_MAX_RAD_S: 0.6, // rad/s — cap on the carried residual
    // (b) Berthed pendulum: the berthed bundle swings on the same critically
    // damped spring the reel-direction lag uses (~0.5 Hz), re-excited by RCS
    // translation. Angle is an offset off the lagged-forward axis; the spring is
    // semi-implicit (dt-robust at 30/120 fps). NOTE: at critical damping (zeta=1)
    // the decay time is fully determined by FREQ_HZ — there is deliberately no
    // separate DECAY_S knob, because a second constant would not be read and
    // would drift from the real behaviour (~1 s to 1/e at 0.5 Hz).
    BERTH_PENDULUM_FREQ_HZ:  0.5,    // Hz — swing frequency (also sets the decay)
    BERTH_PENDULUM_MAX_RAD:  0.15,   // rad — cap (~8.6°). V7 garnish rescale from
                                    // 0.06 (~3.4°, ~1–2% of the bag's silhouette —
                                    // invisible at the ceremony framing) into the
                                    // ~5–8% band. Clearance is standoff-INVARIANT,
                                    // which is why raising the cap is safe: the
                                    // call site applies tan(angle) × berthStandoffM,
                                    // i.e. the bundle sways on a fixed-angle cone
                                    // about the muzzle, so the axial
                                    // BERTH_CLEARANCE_M margin is untouched and the
                                    // lateral excursion grows only in proportion to
                                    // how far out the catch already is. Read the cap
                                    // as the 8.6° cone half-angle, NOT as "0.68 m at
                                    // the 4.5 m standoff" — that framing invites the
                                    // false conclusion that a larger standoff
                                    // (rocketBody 6.5 m, CORRIDOR_EXTENDED_STANDOFF_M
                                    // 10 m) erodes clearance.
    // rad/s of swing velocity per METRE of RCS drift. The call site converts
    // _rcsVelocity to m/s and scales by dt, so the total kick over a burst is the
    // RCS displacement — framerate-independent. Tuned against real input: RCS
    // equilibrium was ~0.38 m/s (the removed RCS_IMPULSE vs RCS_DAMPING) and RCS_MAX_SPEED is
    // 0.5 m/s, so a ~1 s burst gives ~0.02 rad (~⅓ of MAX_RAD) and a short tap
    // reads as a gentle sway. Do NOT tune this against a single-frame kick.
    BERTH_PENDULUM_RCS_EXCITE: 0.6,
    // Phase D.8 (§11.8): every garnish item sits behind its own constant so a
    // LOW tier (or a tuning pass) can drop it without touching the structure.
    // The pendulum is a physics-side garnish (it feeds the berth-hold pin), so
    // its gate lives here rather than in CaptureNetVisual's tier check.
    BERTH_PENDULUM_ENABLED:  true,
    // 2026-08-25 (capture-lock direction): OFF by default — a caught debris is
    // WELDED to the ship the moment the wrap takes. The V7 "spins down inside
    // the bag" garnish read as the catch still tumbling after capture, which
    // contradicts the capture read (docked = locked, mother and daughter both).
    // The mechanism + its tests stay (test-CaptureNet-MotherBerth.js forces the
    // flag on to pin the maths); this default is the shipped behaviour.
    TUMBLE_CARRYOVER_ENABLED: false,

    // ── Reel-cycle lifetime ──
    REEL_CYCLE_LIFE:      20,     // §6.6: deploy/reel cycles before tether replacement

    // ── Distance zones (metres) — per §3.3 + QA Q-4 ──
    CLOSE_RANGE:          30,     // <30 m = bonus zone (f_distance = 1.1)
    BASELINE_RANGE_MAX:   75,     // 30–75 m = standard (f_distance = 1.0)
    ENVELOPE_RANGE:       100,    // max engagement envelope

    // ── UX-11 #1: close-range catch forgiveness + off-axis warning ──
    // The net mouth physically wraps a little beyond its disc at close range,
    // so a near-graze inside CLOSE_RANGE counts as contact. Conservative —
    // applies ONLY inside CLOSE_RANGE; the cling-probability physics is
    // untouched, so this never trivialises long-range aim.
    CATCH_RADIUS_FORGIVENESS: 1.25,  // effective mouth-radius multiplier (< CLOSE_RANGE only)
    OFF_AXIS_WARN_DEG:        12,    // pre-fire HUD warns when lead angle exceeds this

    // ── Cling-probability gameplay floors (2026-06-11 tuning) ──
    // Without these, the multiplicative factor stack made a PERFECT
    // point-blank shot on common materials nearly hopeless (aluminum sat:
    // ~28%, solar-cell sat: ~16%) — players read it as "nets don't work".
    // ROUGHNESS_FLOOR: smooth surfaces are harder, not 5× harder — the
    //   f_roughness multiplier never drops below this.
    // SURE_SHOT_MIN_CLING: a WELL-EXECUTED shot (inside CLOSE_RANGE, target
    //   de-tumbled to in-spec, nominal launch speed, fresh net spin) is
    //   floored here — "set up the shot properly and it sticks". Distant,
    //   tumbling, or sloppy shots keep the full physics stack.
    ROUGHNESS_FLOOR:      0.6,
    SURE_SHOT_MIN_CLING:  0.8,

    // ── Cling probability base values — per §3.4 ──
    SLAM_P_BASE: {
      RIGHT_RIGHT:   0.90,   // right net, right target
      RIGHT_HARDER:  0.80,   // right net, harder target
      RIGHT_FRAGILE: 0.70,   // right net, fragile target
      WRONG_NET:     0.50,   // wrong net size
    },
    CINCH_P_BASE: {
      RIGHT_RIGHT:   0.95,
      RIGHT_HARDER:  0.93,
      RIGHT_FRAGILE: 0.92,
      WRONG_NET:     0.85,
    },

    // ── Tangle base probabilities — per §4.6 (the tangle mechanic and its switch are gone) ──
    TANGLE_SELF_P:          0.015,
    TANGLE_MOTHER_P:        0.02,
    TANGLE_DAUGHTER_P:      0.05,
    TANGLE_CROSS_DEBRIS_P:  0.008,
    TANGLE_REEL_IN_P:       0.04,

    // ── Fragmentation ──
    FRAG_REP_PENALTY:       10,     // reputation lost per fragment (§5.5)
    FRAG_CREDIT_PENALTY:    50,     // credits lost per fragment (§5.5)
    FRAG_MERCY_FIRST_FREE:  true,   // first-fragmentation waives penalties (§5.7)

    // ── Mother launcher config — per §2.9 ──
    // Owner 2026-10-13: ONE launcher, centred on the nose (was 2 symmetric pods
    // A and B at +-0.45 m). The magazine total is unchanged at 4 nets
    // (LARGE.MAGAZINE_SIZE 4 x 1 launcher; was 2 x 2). Name kept: it counts
    // launchers, and the `podIndex` API stays (always 0).
    MOTHER_POD_COUNT:       1,      // 1 launcher (was 2 symmetric pods A and B, until 2026-10-13)
    MOTHER_POD_SPRING_E:    100,    // J per launcher (§2.8)
    GUIDE_RING_MASS:        0.080,  // kg (§2.9.3)

    // ═══════════════════════════════════════════════════════════
    // Per-Platform Net Class Specs — per §6.1
    // ═══════════════════════════════════════════════════════════

    // ── Rim Weight Spin-Rate Physics (2026-05-28 Item 5 doc, no code change) ──
    //
    //   F_centripetal_per_weight = m × ω² × r,  where ω = 2π × SPIN_HZ
    //
    //   In 0g this tension keeps the net mouth open against any residual
    //   bag-drag.  Required minimum: ~5-10 N per radial spoke for Dyneema SK78
    //   (8 spokes total = 40-80 N total ring tension on LARGE).  Numbers at
    //   the current SPIN_HZ values:
    //
    //   | Class  | D (m) | RIM_WT_COUNT | RIM_WT_MASS (kg) | SPIN_HZ | RPM | r (m) | ω (rad/s) | F/wt (N) |
    //   |--------|-------|--------------|------------------|---------|-----|-------|-----------|----------|
    //   | LARGE  | 6.0   | 8            | 0.075            | 2       | 120 | 3.0   | 12.57     | 35.5     |
    //   | MEDIUM | 3.0   | 4            | 0.030            | 6.667   | 400 | 1.5   | 41.89     | 78.9     |   (5 m / 0.050 kg / 4 Hz until 2026-10-23: same rim speed, same pull)
    //   | SMALL  | 1.5   | 4            | 0.015            | 6       | 360 | 0.75  | 37.70     | 16.0     |
    //
    //   Re-derived 2026-06-12 (Item 3 audit): all three classes hold > 10 N per
    //   rim weight at the SETTLED (mouth-open) spin — the design floor for
    //   keeping the bag mouth open in 0g. Guarded by a derivation test in
    //   test-Crossbow-Constants.js (asserts F/wt ≥ 10 N), so future SPIN_HZ /
    //   RIM_WEIGHT_MASS retunes can't silently collapse a net mouth.
    //
    //   Where does the torque go? (the player-facing physics, also taught in
    //   the Codex "Net spin & the yo-yo despin" entry + first-launch SCI line):
    //   the launcher spin-table torques the canister at launch; the equal-and-
    //   opposite reaction goes into the daughter's reaction wheel/body. The
    //   mouth-open "despin" from SPIN_HZ × SPIN_FOLDED_MULT down to SPIN_HZ is
    //   radius growth (I ∝ r², yo-yo effect), NOT an external torque — though
    //   the 3× RATIO is a stylized visual, not closed-form L conservation (see
    //   the SPIN_FOLDED_MULT note above), and in flight SPIN_DECAY_PER_S
    //   deliberately bleeds a little L (mesh flex + rim drag) for gameplay.
    //
    //   All three are comfortably above the 5-10 N tension threshold and well
    //   below Dyneema SK78 break strength (~3500 N for a 1 mm² strand).  If
    //   you bump SPIN_HZ to dial in visual spin speed, re-derive F/wt to ensure
    //   you stay > 10 N per weight; if F/wt < 5 N, the bag mouth collapses.
    //
    // ── Large Net (M-NET) — Mother pod ──
    LARGE: {
      CODE:             'M-NET',
      NAME:             'Large Net',
      DIAMETER:         6.0,       // m deployed (§2.1; 8.0 until 2026-10-20, DECISIONS §33 row 1)
      MASS:             1.425,     // kg total net+hub (§2.3): mesh + 8 rim weights + hub (was 1.95 at 8 m)
      MESH_MASS:        0.675,     // kg mesh only (Dyneema Y0); mesh scales with area: 1.200 x (6/8)^2
      RIM_WEIGHT_COUNT: 8,         // (§2.1)
      RIM_WEIGHT_MASS:  0.075,     // kg each (§2.1)
      HUB_MASS:         0.150,     // kg (§2.3)
      CONE_HALF_ANGLE:  15,        // degrees (§2.1)
      SPIN_HZ:          2,         // (§6.1)
      MAX_CAPTURE_MASS: 5000,      // kg (§6.1)
      // Net ladder: 4 nets in the Mother's one centred launcher (§2.9; was
      // 2 nets/pod x 2 pods until 2026-10-13, the same 4 whale captures per
      // load). Whale hunts are the Mother's premium, delta-v-costly job — the
      // scarce magazine enforces "burn only for whales" doctrine.
      MAGAZINE_SIZE:    4,         // nets in the one launcher, Dyneema Y0 (§6.4)
      // No RELOAD_TIME in any net class (register items 42 + 68, swept
      // 2026-08-15): the documented 30/15/5 s reloads were never in the sim —
      // nothing read them. The mother's live re-fire gate is the per-pod
      // COOLDOWN_CATCH (2 s) / COOLDOWN_MISS (1 s) plus the magazine above —
      // scarcity is quantity, not rate. Daughter magazines refill instantly
      // (seeded full at arm init; a recovered net returns via
      // setNetInventory(+1)) — the daughter RELOADING state is the worm-gear
      // spring re-charge timed by E = ½·m·v² launch energy ÷ (15 W × 0.80)
      // (ArmUnit.js), not a net timer. Wiring real reload timers would be a
      // NEW mechanic (an owner question).
      REEL_SPEED:       2.0,       // m/s (§6.1)
      TETHER_MAX:       100,       // m (§6.1)
      RANGE:            100,       // m engagement envelope (§2.8)
      LAUNCH_SPEED:     10.0,      // m/s (§2.8)
      // Per-class flight-time override (mother-net-reel plan §7.5): the shared
      // CN.MAX_FLIGHT_TIME (8 s) caps the LARGE net at 80 m — short of the
      // 100 m tether and the 100 m ENVELOPE_RANGE the reticle advertises.
      // 11 s puts reach at min(100 tether, 10×11) = 100 m so reticle, odds,
      // refusal and doc all agree. Daughters keep the shared 8 s default.
      MAX_FLIGHT_TIME:  11,        // s — overrides CN.MAX_FLIGHT_TIME for this class
      // §11.2 mouth-collapse floor — LARGE RESOLVED by physics retune
      // (2026-08-27 owner rebalance; replaces the MOUTH_COLLAPSE_DEFERRED
      // escape hatch that lived here). History: the 2026-06-12 audit called
      // LARGE "fine" against the then-shared 8 s cap; the 2026-07-26
      // MAX_FLIGHT_TIME override above (8 s → 11 s, for 100 m reach) put the
      // shared-decay floor crossing t* ≈ 6.76 s ≈ 68 m INSIDE the flight
      // window (min(11 s, 10 s tether pay-out)), exposing every 68–100 m
      // whale shot; wave-2 shipped the floor SMALL-enforced with LARGE
      // consciously deferred. Resolution: a per-class in-flight spin-decay
      // override (read as netClass.SPIN_DECAY_PER_S ?? CN.SPIN_DECAY_PER_S —
      // the MAX_FLIGHT_TIME idiom above), NOT an F-side retune, because
      // t* = (1 − √(FLOOR/F₀))/decay is √-limited on the F side: clearing
      // the 11 s window at the shared 0.08 decay needs F₀ ≥ 10/(1−0.08·11)²
      // ≈ 694 N (14.6×) — SPIN_HZ 7.65 Hz (rim speed ~192 m/s, breaks the
      // big-slow/small-fast class ladder and the 3× folded-spin visual) or
      // 1.1 kg rim weights (8.8 kg of rim on a 1.95 kg net — breaks the
      // MASS/SPRING_ENERGY/LAUNCH_SPEED triple, ½·1.95·10² ≈ 97.5 J ≈ 100 J).
      // The decay knob is linear in t*, and the physics is honest: the
      // 8 %/s bleed (mesh flex + rim drag) was tuned on the daughter
      // classes, while fractional decay scales ∝ τ_drag/(I_rim·ω) and the
      // whale net carries far more rim inertia per kg of flexing mesh
      // (LARGE 8×0.075×4² = 9.6 kg·m² / 1.2 kg mesh = 8.0; MEDIUM 3.1;
      // SMALL 0.84) — halving its fractional bleed is conservative against
      // that ≥ 2.6× scaling. [Numbers below are the 8 m net's; at the 6 m net of 2026-10-20 (DECISIONS §33)
      // F₀ = 35.53 N, t* = 11.74 s ≈ 117 m, worst 100 m arrival 12.8 N: still outside both caps, margins
      // 1.74 s (tether) / 0.74 s (MAX_FLIGHT) — pinned in test-CaptureNet-MouthCollapse.js.]
      // Result: F₀ ≈ 47.37 N crosses the 10 N floor at
      // t* = (1 − √(10/47.37))/0.04 ≈ 13.51 s ≈ 135 m — OUTSIDE every
      // reachable contact (tether pay-out ends flight at 10 s / 100 m,
      // MAX_FLIGHT_TIME at 11 s) with ≥ 2.5 s margin against BOTH caps, so
      // the floor latch (now live for LARGE — no class is skipped) is
      // provably inert and the taught 100 m envelope stays honest: worst
      // reachable arrival = 47.37·(1 − 0.04·10)² ≈ 17.1 N ≥ 10 N floor.
      // f_spin knock-on (disclosed, §12.2 re-derived — the cling CURVE and
      // its clamps are byte-untouched): long-shot arrival spinFraction rises
      // (80 m: 0.36 → 0.68), lifting long-whale odds; SMALL/MEDIUM carry no
      // override and keep the shared 0.08 bit-identically. Pre-fire odds
      // (ToolOdds.estimateSpinFractionAtContact) honour this override so
      // displayed % and resolve roll agree. Derivation + margins pinned in
      // test-CaptureNet-MouthCollapse.js; retunes of SPIN_HZ /
      // RIM_WEIGHT_MASS / DIAMETER / this override / MAX_FLIGHT_TIME /
      // TETHER_MAX break those pins so the decision is re-derived
      // consciously.
      SPIN_DECAY_PER_S: 0.04,      // fraction of SPIN_HZ lost per second — LARGE-only override of CN.SPIN_DECAY_PER_S (§11.2 resolution)
      SPRING_ENERGY:    100,       // J (§2.8)
      REPLACEMENT_COST: 250,       // credits (§6.1)
    },

    // ── Medium Net (LD-NET) — Weaver / Large Daughter ──
    // 2026-10-23 (DECISIONS §38 row 5; owner: "3m is a guess ... daughters may need more smaller nets"): the large daughter
    // carries FOUR 3 m nets, each lighter, in place of two 5 m nets (doc docs/research/2026-10-debris-sizes.md §6: takes 9 of
    // the 11 targets from mission 2 on any way round, 11 of 11 pointed well; misses only the 4.5 m satellite sideways, the
    // mother's job). Mass method (doc §6, estimates): mesh 0.0165 kg/m^2 x 3^2 = 0.149 kg; rim weights and hub scale with the
    // mouth (x 3/5: 4 x 0.030 kg, 0.048 kg) => 0.317 kg per net, 1.268 kg for four (the 5 m pair weighed 1.36 kg).
    // MAX_CAPTURE_MASS stays 500 kg: that rating was never derived from mesh, rim or thread count (it is the "target
    // envelope" row of CAPTURE_NET.md §6.1; its one physics tie is the tether: (arm + 500 kg) x 2 m/s x REEL_TENSION_COEFF
    // = 40.5 N under the start tier's 100 N break strength). The 3 m net's own cords (8 spokes of 1.0 mm Dyneema SK78,
    // 3.6 GPa = 22.6 kN; 8.1 kN even at 0.6 mm cord) carry far more than any tether can pull, so the net is not the weak link.
    // SPIN_HZ 4 -> 20/3 keeps the RIM SPEED (62.8 m/s) and so the pull per weight exactly as it was: F = m w^2 r =
    // 0.030 x (2 pi 20/3)^2 x 1.5 = 78.96 N, the 5 m net's value (0.050 x (2 pi 4)^2 x 2.5). At 4 Hz the 3 m net would pull
    // 28.4 N and its mouth would collapse past ~51 m (floor 10 N, 8 %/s bleed), where today's never does inside its 8 s
    // flight window (test-CaptureNet-MouthCollapse pins 8.051 s). SPRING_ENERGY = 1/2 x 0.317 x 10^2 = 15.9 J (read nowhere).
    MEDIUM: {
      CODE:             'LD-NET',
      NAME:             'Medium Net',
      DIAMETER:         3.0,       // was 5.0 until 2026-10-23
      MASS:             0.317,     // was 0.68
      MESH_MASS:        0.149,     // was 0.400 (area: 0.0165 kg/m^2 x 3^2)
      RIM_WEIGHT_COUNT: 4,
      RIM_WEIGHT_MASS:  0.030,     // was 0.050 (x 3/5)
      HUB_MASS:         0.048,     // was 0.080 (x 3/5)
      CONE_HALF_ANGLE:  12,
      SPIN_HZ:          20 / 3,    // was 4: same rim speed, same 78.96 N per weight (see above)
      MAX_CAPTURE_MASS: 500,
      MAGAZINE_SIZE:    4,         // was 2
      REEL_SPEED:       2.0,
      TETHER_MAX:       100,
      RANGE:            100,
      LAUNCH_SPEED:     10.0,
      SPRING_ENERGY:    16,        // J, was 34 (1/2 x 0.317 x 10^2)
      REPLACEMENT_COST: 100,
    },

    // ── Small Net (SD-NET) — Spinner / Small Daughter ──
    SMALL: {
      CODE:             'SD-NET',
      NAME:             'Small Net',
      DIAMETER:         1.5,
      MASS:             0.12,
      MESH_MASS:        0.040,
      RIM_WEIGHT_COUNT: 4,
      RIM_WEIGHT_MASS:  0.015,
      HUB_MASS:         0.020,
      CONE_HALF_ANGLE:  10,
      SPIN_HZ:          6,
      MAX_CAPTURE_MASS: 50,
      MAGAZINE_SIZE:    4,
      REEL_SPEED:       3.0,
      TETHER_MAX:       100,
      RANGE:            100,
      LAUNCH_SPEED:     10.0,
      SPRING_ENERGY:    6,
      REPLACEMENT_COST: 25,
    },

    // ═══════════════════════════════════════════════════════════
    // Q2 NET-LAUNCH CEREMONY — per CEREMONY_REDESIGN.md §5.1
    // Scaffolding only (Stage 0); no read sites until Stages 1–3.
    // Gated by FEATURE_FLAGS.NET_CEREMONY.
    // ═══════════════════════════════════════════════════════════
    NET_CEREMONY: {
      // ── Per-beat physics time scales (apply ONLY to NetProjectile / CaptureNetVisual) ──
      // 2026-05-25 pacing retune (post-Q2 visibility fix):
      //   The engulf (ENVELOP, 1.5 g) and cinch (CINCH_CLOSING, 2.0 g) animations
      //   are the only beats where the user reads the *mechanism* — brake event,
      //   inertial overshoot, drawstring close. Each must play end-to-end inside
      //   its named camera beat. Pre-retune the named beats only delivered 2.06 g
      //   of physics across BRAKE_ENVELOP+CINCH+SECURED_SETTLE vs the 4.0 g the
      //   animation needs (0.5+1.5+2.0); 48% of the cinch finished AFTER the
      //   cinematic exited at 1.0× from ARM_PILOT, reading as "too fast."
      //   New scales 0.5/0.5 keep clear "cinematic slowmo" feel while permitting
      //   wall-clock beats short enough to hold attention (≤4 s each).
      TIME_SCALE_PRE_FLIGHT:  0.4,   // beats 1–2 (§5.1)
      TIME_SCALE_GLAMOUR:     0.5,   // beat 3 (§5.1)
      TIME_SCALE_APPROACH:    0.6,   // beat 4 (§5.1)
      TIME_SCALE_BRAKE:       0.5,   // beat 5 — 50% slowmo (was 0.3, too heavy)
      TIME_SCALE_CINCH:       0.5,   // beat 6 — match BRAKE scale (was 0.4)

      // ── Wall-clock beat durations (seconds, NOT physics-time) — §5.1 ──
      // Invariant (enforced by tests): for beats whose name maps to an FSM state
      // animation, beat.duration × beat.timeScale ≥ corresponding state duration.
      //   BRAKE_ENVELOP × TIME_SCALE_BRAKE ≥ BRAKE_TIME + ENVELOP_TIME (= 2.0 g)
      //   CINCH         × TIME_SCALE_CINCH ≥ CINCH_CLOSE_TIME           (= 2.0 g)
      //   SECURED_SETTLE × 1.0            ≥ SECURE_CHECK_TIME           (= 0.2 g)
      BEAT_DURATIONS_S: {
        POD_MUZZLE_PREFIRE: 1.2,
        MUZZLE_EXIT_SPINUP: 1.0,
        GLAMOUR_SHOT:       1.5,
        APPROACH_DOLLY_MIN: 1.5,    // beat 4 variable, clamped [min, max]
        APPROACH_DOLLY_MAX: 2.5,
        BRAKE_ENVELOP:      4.0,    // 4.0 × 0.5 = 2.0 g → BRAKE(0.5) + full ENVELOP(1.5) (was 2.2)
        CINCH:              4.0,    // 4.0 × 0.5 = 2.0 g → full CINCH_CLOSING(2.0) (was 2.0)
        SECURED_SETTLE:     1.0,    // 1.0 × 1.0 = 1.0 g → SECURE_CHECK + held "captured" beat (was 0.6)
      },

      // ── Subsequent-deploy highlights cut — §4 + §5.1 ──
      // 2026-05-25 retune: previous 3-beat cut (GLAMOUR + BRAKE_ENVELOP + CINCH
      // at 0.7×) totalled 6.65 s wall × 0.5 scale = 3.33 g of physics. The
      // FSM needs ~3.95 g (LAUNCHING 0.15 + SPINNING_UP 0.5 + FLIGHT 3.3 for a
      // 33 m target) just to CONTACT the target — the ceremony was exiting
      // BEFORE the net touched the debris, so the engulf and cinch then played
      // at 1.0× from ARM_PILOT, off-frame. New cut includes APPROACH_DOLLY
      // (the FLIGHT-framing beat, which force-advances on NET_BRAKE_FIRED so
      // it doesn't over-run) and SECURED_SETTLE (the "captured" hold beat).
      // HIGHLIGHTS_TIME_SCALE raised to 1.0 because the FSM-vs-camera physics
      // alignment fixed in the engulf/cinch retune assumes full-duration beats.
      // Only beats 1–2 (POD_MUZZLE_PREFIRE, MUZZLE_EXIT_SPINUP) remain skipped
      // for subsequent deploys — those are the first-time "look, the pod fires
      // a net!" teaching moments, redundant after the player has seen them.
      HIGHLIGHTS_CUT_BEATS:   ['GLAMOUR_SHOT', 'APPROACH_DOLLY', 'BRAKE_ENVELOP', 'CINCH', 'SECURED_SETTLE'],
      HIGHLIGHTS_TIME_SCALE:  1.0,

      // ── REEL_IN beat (mother-net-reel plan §11.2 Phase D.2) ──
      // A trailing beat chained after SECURED_SETTLE for mother catches only,
      // released to the player cam at berth (NET_BERTHED → the PARK_HOLD chain,
      // S4) or at this wall-clock cap — whichever first. The cap exists so a
      // corridor hold (≤ 8 s) or a 100 m long-tether reel never holds a
      // cinematic for the full ~25 s. The beat runs at 1.0× timeScale:
      // CeremonyTimeScale multiplies the reel's dt (§4.15), so a slowmo beat
      // would literally slow the winch — the reel IS the spectacle, don't
      // dilate it. Skipped entirely under prefers-reduced-motion and for
      // daughter catches (arm-framed already).
      // S4 (2026-08-11): the old "3/4 view framing mother + incoming catch"
      // spec was the measured retreat (REELING 22.6 m / BERTHED 22.9 m — a
      // 1.5 m catch read ~68 px). REEL_IN now frames THE CATCH (~8–12 m hold,
      // mother as context) — see CameraSystem._netCeremonyBeatPos.
      REEL_BEAT_MAX_S:      12.0,   // wall-clock cap (never hold for 40 s)
      REEL_BEAT_FOV:        42,
      // 2026-08-25 (ceremony filmstrip analysis): the REEL_IN dolly used to
      // ease across its WHOLE duration (up to 12 s), so the camera spent most
      // of the beat mid-flight between the muzzle-side SECURED_SETTLE pose and
      // the catch-framed hold — the package read ~100 px against empty stars
      // for 6–8 s (frames 021–027 of the tmp/cinema strip). The dolly now
      // saturates in this many seconds, then HOLDS the catch-framed escort
      // shot while the winch does the work (motion comes from the catch
      // closing on the nose, not from a camera still in transit).
      REEL_DOLLY_IN_S:      2.5,

      // ── PARK_HOLD beat (cargo-continuity S4) ──
      // Chained at NET_BERTHED from the REEL_IN beat: under S3 the catch PARKS
      // at the nose instead of being deleted, so the berth IS the payoff — the
      // camera holds on the parked catch (same ~8–12 m catch-framed hold as
      // REEL_IN, so the chain is seamless) then releases by the clock. The
      // first-ever mother catch holds longer — the first_net_park teaching
      // moment (TeachingSystem, fired by CATCH_PROCESSED { parked: true })
      // lands during it.
      // 2026-08-25 trim (filmstrip analysis): 5/10 s → 4/6 s. The hold is a
      // static shot of a parked bag — the payoff lands in the first ~2 s and
      // the collar digestion continues on the player cam afterwards. The
      // first-ever hold keeps enough length for the teaching toast, no more.
      PARK_HOLD_S:          4.0,
      PARK_HOLD_FIRST_S:    6.0,
      // ── Small-catch plan W4 (2026-08-25) — size-aware hold + clean exit ──
      // HOLD_BUNDLE_FRAME_K: the REEL_IN/PARK_HOLD hold distance tracks the
      // DRAWN bundle (net.heldBundleRadiusM — the readability floor draws a
      // sub-metre catch at ~2.0 m radius from reel entry): hold K bundle-radii
      // off, so the bundle's diameter subtends 2·atan(1/K) ≈ 28° of the 42°
      // beat FOV at K = 4 — the verified after2 whale composition expressed
      // as an invariant. The 8 m clamp floor = K × MOTHER_CATCH_MIN_RENDER_M:
      // both verified subjects sit exactly ON the old 8 m hold.
      HOLD_BUNDLE_FRAME_K:  4,
      // Sub-metre catches digest fast (digestSpanS floors at 60 game-s ≈ 6
      // wall-s sunlit) and the chop used to run right as the PARK_HOLD clock
      // released the camera — the ball shrank IN THE OPEN over the exit
      // transition (the owner's "camera drifts after the geometric ball
      // shrinks"; measured tmp/frag-before f40–f45). For catches under
      // PARK_HOLD_DIGEST_MAX_SIZE_M the park hold now extends through berth
      // secure + digestion up to CHOP END (+ pad, capped — eclipse dilates
      // the digest clock ×25, the cap is the release valve), so the W3
      // deflate-and-fade plays INSIDE the held shot and the beat ends on a
      // clean cut. The PARK_HOLD guard also releases the frame `_digestedOut`
      // lands, whichever comes first.
      PARK_HOLD_DIGEST_MAX_SIZE_M: 1.0,   // sizeMeter < this → hold through the chop
      PARK_HOLD_DIGEST_PAD_S:      1.0,   // breath after chop end, before the cut
      PARK_HOLD_DIGEST_CAP_S:      12.0,  // hard cap (eclipse trickle, huge spans)
      // Exit cut for tiny subjects: the standard 0.5 s view transition eased
      // over a subject that just got consumed reads as aimless drift — cut in
      // this many seconds instead when the parked bundle was sub-metre.
      EXIT_CUT_SMALL_S:            0.2,

      // ── Lasso catch cut (FEATURE_FLAGS.LASSO_CATCH_CUT, 2026-08-26) ──
      // One continuous catch-framed shot: enter at LASSO_CONTACT (hard cut),
      // hold the S4 grammar off the wrapped piece while the reel escorts it
      // to the nose, release ≤ LASSO_CUT_MAX_S after entry (adoption lands at
      // ~3 s: 0.6 s wrap + 2.4 s haul at LASSO_REEL_SPEED 0.33), well before
      // the berth-secure clock (4 s) starts digestion. The exit reuses
      // EXIT_CUT_SMALL_S — every lasso subject is sub-metre class.
      LASSO_CUT_MAX_S:             4.0,   // hard release valve (binding 2–4 s)
      LASSO_CUT_SETTLE_S:          0.4,   // breath after the reel resolves, before the cut
      // 2026-08-26 round 2: the cut is TWO shots — wrap close-up
      // (catch-anchored, the piece is stationary through the wrap window),
      // then a hard cut to the ARRIVAL shot: ship-anchored at this hold, the
      // nose steady in frame while the PIECE flies in. The round-1 escort
      // rode the catch, so the converging ship read as "mother moving to
      // debris" (owner report) — anchoring shot 2 to the ship makes the
      // causality unambiguous: debris gets reeled in to mother.
      LASSO_CUT_ARRIVAL_HOLD_M:    9.0,

      // ── Visual geometry ratios — §5.1 ──
      CONE_OPEN_RADIUS_FRAC:         1.0,    // mouth radius / (D_mesh × 0.5)
      // 2026-05-28 (Item 1 tuning): CONE_LENGTH_FRAC bumped from 0.55 → 0.85.
      // The cinch ring contracts at local z = -coneHeight (mouth plane).
      // With CONE_OPEN_RADIUS_FRAC=1.0, target sits at z ≈ -mouthRadius =
      // -0.5 × D.  At the previous 0.55 value, coneH = 0.55 × D and the
      // gap |z_ring - z_target| = 0.05 × D ≈ 0.4 m for D=8 — well inside
      // the half-extent of any LARGE-bin debris.  Result: the ring cinched
      // through the middle of the debris instead of past its leading edge.
      // At 0.85: coneH = 0.85 × D → gap = 0.35 × D = 2.8 m (LARGE) / 1.75 m
      // (MEDIUM) / 0.525 m (SMALL), so the ring closes around the debris's
      // forward leading edge rather than its midpoint.  Camera CINCH /
      // BRAKE_ENVELOP lookAt offsets in CameraSystem._netCeremonyBeatLook
      // are kept in sync (they reference 0.85 / 0.425 = coneH/2 directly).
      CONE_LENGTH_FRAC:              0.85,   // apex-to-mouth axial length / (D_mesh × 0.5)
      DRAWSTRING_RADIUS_FRAC_CLOSED: 0.15,   // weight radius at end of cinch / r_open
      // Whale-in-cone phase 3 (D2): the drawn bag floors on a spherical
      // envelope around its contents — margin × the ball's cross-section
      // radius at each ring z (NetMeshKit.contentsFloorRadius). 1.1 = the bag
      // tightens ONTO the catch with a 10% gap, never through it.
      CONTENTS_FLOOR_MARGIN:           1.1,
      RIM_WEIGHT_RENDER_RADIUS_M:    0.08,   // visual sphere radius (NOT physics — 75 g tungsten ≈ 1 cm real)
      RIM_WEIGHT_EMISSIVE_BRAKE:     0x66ccff, // colour-tint on NET_BRAKE_FIRED
      TETHER_TENSION_THICKEN_FACTOR: 2.5,    // line width × this on NET_BRAKE_FIRED
    },

    // ── Phase D.4/D.5 tether + web-drape garnish (§11.8: one tuning surface) ──
    // Moved out of CaptureNetVisual module-locals so every garnish item lives
    // behind a Constant. The catenary strand bows with slack, snaps taut with a
    // decaying lateral twang, and pulses emissive above the bloom threshold; the
    // web settle-jiggles as it drapes and shrink-wraps.
    NET_TETHER: {
      SEGMENTS:          20,      // catenary samples (16–24 per plan)
      TWANG_S:           0.2,     // decaying lateral twang window (s)
      TWANG_AMP_M:       0.35,    // peak lateral twang amplitude (m)
      SAG_FRAC:          0.06,    // sag = slack × this (of straight distance)
      TAUT_SLACK:        0.02,    // slack ratio below which the line is taut
      EMISSIVE_S:        0.35,    // bloom pulse window at line-taut (s)
      EMISSIVE_HDR:      2.8,     // > 2.5 bloom threshold (SceneManager)
      BASE_COLOR:        0xddddee,
      DRAPE_JIGGLE_ENVELOP_FRAC: 0.12,  // mouthRadius × this — V7 garnish rescale
                                    // (was 0.04 ≈ 2% of the bag silhouette —
                                    // invisible; now ~6% — the settle reads)
      DRAPE_JIGGLE_CINCH_FRAC:   0.06,  // mouthRadius × this — V7 rescale (was 0.02)
      DRAPE_JIGGLE_HZ:           2.5,   // settle-jiggle rate
    },
  },

  // --- Leash hand-off (mother nose -> radiator tip) -----------------------
  // docs/research/2026-10-leash.md + DECISIONS §1/§19. Used by
  // js/systems/LeashTransfer.js (pure; the wiring lane reads it, nothing else).
  // Each number carries its source; "estimate" = no measured source.
  // Metres, seconds, newtons, kg.
  LEASH: {
    // Ship turn (the turn itself belongs to the autopilot; passed through)
    TURN_MAX_RATE_DEG:   5,      // °/s peak — tmp/research/leash/turn-dynamics.md
    TURN_ACCEL_DEG:      4,      // °/s² ramp — turn-dynamics.md; fb16 2026-10-25: was 2. Gas is set by the PEAK rate (TURN_MAX_RATE_DEG, unchanged at 5), not the ramp: measured 174.6 g per hand-off at ramps 2, 4 and 8 °/s²; the turn takes 38° in 10.2 s / 8.9 s / 8.3 s
    PAYOUT_DURING_FOLD:  true,   // fb16 2026-10-25: the nose lets go and the line pays out while the receiving radiator folds (the turn still waits for it); false = the old order, fold first
    PAYOUT_FOLD_MARGIN_S: 0.3,   // s — fb16: the payout is timed to end this long before the fold lands (LeashTransfer._payoutDue)
    UNFOLD_DURING_SWING: true,   // fb16 2026-10-25: the radiator opens while the bag swings onto the boom; false = the old order, swing first
    HOLD_SLEW_DEG_S:     25,     // °/s — fb16 (owner 2026-10-25, "a little faster"): the held radiator petal's fold to the hand-off angle, unfold and way home. A hinge motor commanded faster is still physical; the player's radiators and the struts stay at THERMAL.FLOWER.SLEW_RATE_RAD_S (15°/s, readability), a daughter's carry too. Read by LeashDriver (the slew it passes to the ship) and by LeashTransfer._payoutDue (how long the fold still has to run, to time the payout).
    WHEEL_TURN_X:        1.5,    // F2.4: the reaction wheels take the hand-off turn only when they need at most this many times the gas plan (the swing is tuned to the gas profile)
    // Reel
    REEL_SPEED_MPS:      0.05,   // estimate; <= LATCH_ALIGNED_MPS (arrival speed = reel speed)
    REEL_ACCEL_MPS2:     0.05,   // estimate; TSS-1 ramped the reel (NTRS 19970011947)
    PAYOUT_PUSH_MPS:     0.05,   // estimate (separation spring); fb16 2026-10-25: was 0.02 (the payout took 8-18 s and looked frozen)
    PAYOUT_MAX_MPS:      0.25,   // clutch cap; peak line demand 0.113 m/s in a 5°/s turn (reviewer probe)
    TAKEUP_MPS:          0.05,   // estimate
    BACK_TENSION_PER_KG: 5e-4,   // N/kg — estimate (line never slack, TSS); bag drifts <= 0.05 m over a turn
    BACK_TENSION_MAX_N:  0.2,    // N — estimate
    // The line: one pull-only soft constraint (Box2D "soft step")
    LINE_RADIUS_M:       0.005,  // estimate
    LINE_FREQ_HZ:        1,      // 1-D probe tmp/research/leash/probe2.mjs: stable at dt 0.02-1 s
    LINE_DAMPING:        1,      // critically damped
    // Snag
    SNAG_TENSION_N:      5,      // DECISIONS §1 "a few newtons"
    SNAG_MEAN_S:         0.25,   // s — mean tension window
    // Latch (swivel cone at the radiator tip)
    LATCH_OK_MPS:        0.03,   // Orbital Express capture <= 3 cm/s
    LATCH_ALIGNED_MPS:   0.10,   // IDSS IDD Rev A Table 3-1 (5-10 cm/s, 5°)
    LATCH_ALIGN_DEG:     5,      // IDSS IDD Rev A Table 3-1
    FUNNEL_MOUTH_R_M:    0.06,   // estimate
    RESTITUTION:         0.5,    // estimate, no measured source
    MAX_BOUNCES:         3,      // DECISIONS §19
    CATCH_TOL_M:         0.05,   // estimate: latch point to the line, at the end of the turn
    // Hand-off geometry
    D_MIN_M:             0.3,    // m — bag-to-tip range on the line, probe d range
    D_MIN_PER_R:         1.2,    // radii — l8-reel-collar D5: a bag of radius r starts its line at least this many radii from the tip (r 0.50: 0.6 m; at 0.3 m it snagged the tip's own strut); r <= 0.25 m stays at D_MIN_M
    D_MAX_M:             2.0,    // m — estimate; d up to 2.0 is used as is (REEL covers the extra length); beyond → 'too far' (fix round 1 F4)
    HANDOFF_THETA_DEG:   3,      // radiator angle when LeashTransfer is built without one (tests); the game asks handoffThetaDeg(), whose no-bag-held answer is HANDOFF_THETA_TABLE.noneDeg (3° up to a 0.60 m catch, 18° for 0.75 m) — measured tmp/probes/leash/lat15b/ at 2.5 m, re-measured at 2.30 m below
    // Waits and tolerances
    THETA_TOL_DEG:       1.0,    // ° — FOLD/UNFOLD wait; the radiator arrival latch stops 0.5° short of a 146°→3° target at every frame step 1/120–1/20 s (l5b-hold plan check 2026-10-14)
    HOME_REEL_MPS:       0.025,  // m/s — estimate; REEL_HOME reels in this fast at most: the bag passes the nose at <= LATCH_OK_MPS (a pull-only line cannot slow it once the reel stops)
    HOME_TOL_M:          0.05,   // m — estimate; REEL_HOME ends when the bag is this close to its nose spot (and slow)
    SLACK_S:             1.0,    // s of slack before the SLACK event
    SLACK_MIN_M:         0.15,   // m — estimate; the anchor's own approach in a 30° turn leaves ~0.07 m of normal slack (measured, test (c))
    RAMP_TAU_S:          0.5,    // s — estimate; smooth tail of the reel speed ramp (a hard end overshoots the 1 Hz line by 3 mm/s)
    RING_IGNORE_R_M:     0.10,   // m — the line bends over the ring rim within this distance of the anchor
    CONE_IGNORE_R_M:     0.05,   // m — the swivel cone sits at the latch point; contacts inside this ball are ignored
    LIFT_OUT_M:          0.10,   // m — estimate; REEL_HOME from the tip pays out this much to lift out of the slot
    CONTACT_M:           0.005,  // m — estimate; latch contact when the neck is within this of the tip
    PAYOUT_ACCEPT_M:     0.02,   // m — estimate; PAYOUT replan accepts |payoutM| below this
    // Wiring (lane l5b-wire)
    NOSE_REEL_MPS:       0.10,   // m/s — estimate (lane l5c-reach): the winch pulls a catch seated deep in the bag in to the nose before the hand-off; the same <= 10 cm/s contact limit as the tip latch (LATCH_ALIGNED_MPS). fb16 fix round 1: now only the START and ARRIVAL speed (it was the whole pull-in: 2.6 m took 26.4 s)
    NOSE_REEL_FAST_MPS:  0.35,   // m/s — fb16 fix round 1 (estimate; the net's own reel-in cruises at 2 m/s): the pull-in's cruise speed. 2.64 m now takes ~8 s (measured tmp/fb16/deep.mjs)
    NOSE_REEL_ZONE_M:    0.30,   // m — fb16: the pull-in brakes at a constant rate over the last 0.30 m, down to NOSE_REEL_MPS at the nose (the net's own reel-in uses SLOW_ZONE_M 0.30 too)
    NOSE_REEL_ACCEL_MPS2: 0.5,   // m/s^2 — fb16: the pull-in's start-up ramp (estimate), 0.10 -> 0.35 m/s in 0.5 s
    MISSION_WAIT_MAX_S:  240,    // game s — estimate (lane l5c-reach): the longest the next mission waits for a leash hand-off (GameFlowManager); the 20 s MISSIONS.START_AFTER_CATCH_MAX_S cap does not run while the hand-off is busy
    EXPECTED_S:          23,     // s — fb16 2026-10-25: was 45 (an estimate: two radiator slews + a 30° turn + reel, at the old rates). MEASURED on the probe rig (tmp/fb16/probe.mjs, machine start to DONE): 22.7 s for a 1.0 m piece (26.0 s for a 0.3 m piece, the payout there outlasts the fold), rounded up; the constant itself is read only by LeashDriver (start(), _beginMachine(): net._cargoDur = EXPECTED_S; and the cap of net._cargoS while the machine runs). The cargo bar and the camera's park-hold (CameraSystem, the catch focus) read that net field, never this constant
    ANCHOR_AZ_R_M:       0.16,   // m — line anchor radius on the capture ring rim = OCTOPUS_V5.BERTH_COLLAR_INNER_R_M (probes tmp/probes/leash/lat15b/lib3.mjs:10 measured with 0.16)
    // Radiator angle for the hand-off (degrees) by arriving bag radius (row) and the largest bag already
    // held on a tip (column; `noneDeg` = nothing held). Measured at the 2.30 m radiators, v12-big-bags 2026-10-16
    // (tmp/probes/arm-length/ho5.mjs, summary tmp/v12bb/summ.txt, table in docs/research/2026-10-leash.md): every
    // clearance >= 0.02 m on the real ship meshes, tilts 0/±limit, the same for all four tips, the other three tips each
    // holding a bag of the column's radius, the line starting minHandoffD(Ra) = max(0.3, 1.2·Ra) from the tip. A cell is
    // the lowest angle >= 3° where it AND the next degree pass (the radiators stop up to ~1° above a target). A radius
    // rounds UP to the next row/column. The 0.60 and 0.75 rows sit at 13° and 18° because the bag's clearance to its own
    // strut dips to 19.2 mm (0.60 m) and 16.7 mm (0.75 m) at 8-9° and only clears 0.02 m again from 13° / 18°.
    // 0.50/0.40 raised 5→6 2026-10-17: 0.41–0.46 m arriving with 0.40 m held need 6° (0.01 m sweep).
    // RE-MEASURED 2026-10-18 (lane leash-held-angle) with the catch AT THE NOSE, as the game starts it (the 2026-10-16 table was
    // measured with the catch off the nose): at the old angle the arriving catch overlapped the held bag and the line "touched a
    // held catch" (mission 1 catch 2, reach 0.373 m beside catch 1, r 0.32 m: 4° snagged, 6° passes). Method: the whole hand-off on
    // the real ship (LeashWiring rig, 30 fps, typed fragments, arriving 4 kg, furnace cook off), the cell's angle forced; a pass
    // = a latch AND the end of the hand-off (DONE, no snag). Every held bag at the column's radius, three fills in the game's
    // tip order 0, 2, 1, 3 (held {0} → arriving tip 2; {0,2} → tip 1; {0,2,1} → tip 3), and three arriving radii per row: the row's
    // edge, the midpoint to the row below and just above the row below (the pass angle is U-shaped in the arriving radius: a
    // small catch sits lower and needs MORE, so the bottom of a low row binds; row 0.15 uses 0.15 and 0.125). A cell is the
    // smallest angle that passes in all of those, plus 1° (so the angle below it passes too). No cell was lowered: the 16 that pass at
    // their old value and one degree under it keep it (3° cells in the low rows and columns, the 13° cells of row 0.60, the 18° cells
    // of row 0.75 up to column 0.60); the other 48 rose, by up to 6°.
    // No bag held (`noneDeg`) re-checked at 3° and 2°, arriving tips 0 and 2, all three radii: unchanged. Every cell is under the 45°
    // cap (the hull touches at 52°). The new cells were run again through the game's own lookup (552 runs, all pass) and with all 12
    // single-held tip pairs (768 runs, all pass). Probe: tmp/probe/grid.mjs (gitignored; raw runs in tmp/probe/out/);
    // summary in docs/research/2026-10-leash.md.
    HANDOFF_THETA_TABLE: {
      radiiM: [0.15, 0.22, 0.30, 0.35, 0.40, 0.50, 0.60, 0.75],
      noneDeg: [3, 3, 3, 3, 3, 3, 3, 18],   // nothing held: one entry per row
      deg: [
        [3, 5, 7, 9, 10, 12, 15, 18],       // Ra 0.15
        [3, 4, 6, 7, 9, 11, 13, 16],        // Ra 0.22
        [3, 3, 5, 7, 8, 10, 12, 14],        // Ra 0.30
        [3, 4, 6, 7, 8, 11, 13, 15],        // Ra 0.35
        [3, 4, 7, 8, 9, 11, 13, 16],        // Ra 0.40
        [4, 6, 8, 9, 10, 12, 14, 17],       // Ra 0.50
        [5, 7, 13, 13, 13, 14, 16, 18],     // Ra 0.60
        [18, 18, 18, 18, 18, 18, 18, 20],   // Ra 0.75
      ],
    },
    SUBSTEP_MAX_S:       1/60,   // s — line substep ceiling
    SUBSTEP_MAX_MOVE_M:  0.05,   // m — a substep moves the bag at most this far
    CUT_DWELL_S:         0.3,    // s after the cutter fires; fb16 2026-10-25: was 1.0 (a still second after the latch)
    PHASE_TIMEOUT_S: {           // s — estimates; a stall in any phase starts the recovery
      FOLD: 60, RELEASE: 5, PAYOUT: 60, TURN: 90, CATCH: 10,
      REEL: 90, CUT: 5, SWING: 30, UNFOLD: 60, REEL_HOME: 120,
    },
  },

  // --- Mothership RCS Fine Positioning ---
  RCS_MAX_SPEED: 0.000005,            // scene units/s — max RCS drift speed (0.5 m/s real)
  RCS_DAMPING: 0.95,                  // velocity damping per frame when not thrusting (stops quickly)

  // --- Reel push (lane reel-push, owner 2026-10-22: "make the reel pull move and turn the mother, like real physics") ---
  // The reel line pulls both ends: the mother feels the line tension toward the daughter at her strut tip (a Δv in
  // her real orbit through applyCartesianImpulse, a torque into her attitude springs), and the daughter's arrival speed
  // as one latch bump. Momentum, not a burn: unbilled. Units: the tension is true newtons and acts for game seconds
  // (real dt x TIME_SCALE_GAMEPLAY), so the Δv is T x dt_game / mass in true m/s, the unit the mother-net tug hands over.
  REEL_PUSH: {
    ENABLED: true,                    // false = the mother stays put during a reel (the old behaviour)
    MIN_DV_MS: 1e-4,                  // m/s - smaller Δv is gathered until it passes this, then applied in one call. The
                                      // orbit element round trip inside applyCartesianImpulse is only good to about 1e-6..1e-5 m/s
                                      // (measured 2026-10-22), and the ion thread alone adds ~7e-7 m/s a frame.
    // Fix round 1 (coordinator review of 357ad486, 2026-10-22): the push is momentum, but two things that take it back out
    // are NOT free. (1) The autopilot HOLD copies the locked target's orbit into hers every frame, which erases the Δv: that
    // is a station-keeping burn on her cold-gas thrusters. m = M x Δv / (Isp x g0), billed through RESOURCE_CONSUME coldGas.
    // (2) Her attitude hold takes the turn back out: billed as real couple gas, |L| x 2F / (tau x Isp x g0)
    // (PlayerSatellite._billTurnNullN2, turn-gas 2026-10-23).
    HOLD_ISP_S: 60,                   // s - her cold-gas thrusters (the same 60 as DAUGHTER_COLD_GAS.ISP_S)
    PUFF_EVERY_S: 0.3,                // s (real) - at most one burst of cold-gas puffs this often, so it reads as puffs not a plume
  },

  // --- Catch Juice (S4 — Core Feel) ---
  CATCH_SHAKE_DURATION: 0.3,           // seconds — camera micro-shake on capture
  CATCH_SHAKE_INTENSITY: 0.000003,     // scene units (= 0.3 m) — shake amplitude.
                                       // Was 0.003 "scene units" — a metres-vs-scene-units
                                       // mis-read that put ±300 m of random jitter on the
                                       // camera for the whole shake window, in every view,
                                       // ceremony included (measured 2026-08-02, P1 probe:
                                       // 150–420 m camera arcs scrambling the mother catch's
                                       // SECURED_SETTLE frames). A micro-shake is ~0.3 m.


  // =========================================================================
  // SALVAGE SYNERGIES — Complementary metal bonuses (Phase 5 Rewards)
  // =========================================================================

  SALVAGE_SYNERGIES: [
    { metals: ['GALLIUM', 'COPPER'],           name: 'Complete Solar Array',   points: 300 },
    { metals: ['TITANIUM', 'KEVLAR'],          name: 'Shielding Kit',          points: 250 },
    { metals: ['ALUMINUM', 'STEEL'],           name: 'Structural Alloy',       points: 200 },
    { metals: ['GALLIUM', 'IRIDIUM'],          name: 'Avionics Suite',         points: 500 },
    { metals: ['CARBON_COMPOSITE', 'COPPER'],  name: 'Propulsion Package',     points: 350 },
    { metals: ['GLASS_CERAMIC', 'GALLIUM'],    name: 'Sensor Package',         points: 250 },
  ],
  FIELD_CLEAR_THRESHOLDS: [
    { pct: 0.50, bonus: 200,  label: 'Half Clear' },
    { pct: 0.75, bonus: 500,  label: 'Three-Quarter Clear' },
    { pct: 1.00, bonus: 2000, label: 'Perfect Sweep' },
  ],
  SWEEP_REPORT_TIMEOUT: 15,             // seconds before auto-dismiss of sweep report

  // --- Tether Detach (Phase 6 — Risk-Reward Redline Mechanic) ---
  DETACH_SCORE_MULT: 2.0,              // untethered catch multiplier
  DETACH_SACRIFICE_MULT: 2.5,          // deorbit sacrifice multiplier
  DETACH_FAIL_PENALTY: -500,           // score penalty for lost arm
  DETACH_FUEL_WARNING_25: 0.25,        // fraction triggers warning comms
  DETACH_FUEL_WARNING_10: 0.10,        // fraction triggers critical comms
  DETACH_SLOWMO_DURATION: 0.3,         // seconds of slo-mo on detach (slightly longer than catch)
  DETACH_SLOWMO_FACTOR: 0.08,          // time scale during detach slo-mo
  DETACH_MAX_DISTANCE: 50000,          // meters (50 km) — auto-destroy detached arm if it drifts beyond this

  // --- Emergency FEEP reserve (tethered reel-home safety margin) ---
  // A NON-detached daughter never burns her tank to zero on a job. She keeps
  // this much FEEP (% of tank) in reserve so that, when reeled home on the
  // mother's winch, she can maintain tether tension and fire the soft-dock
  // arrest (REDOCK_FEEP) — neutralizing inertia so neither she nor her catch
  // slams the strut/mother. When a working/flying daughter hits this floor she
  // does NOT die: she goes ADRIFT (recoverable, still commandable on the tether).
  // The reserve is only ever spent on the way home (REELING / DOCKING) or a
  // deorbit burn; if it runs dry mid-reel the winch still finishes the job.
  // (Detached daughters have no tether to winch, so the reserve cannot help
  //  them — they still expend at zero. See ArmUnit._consumeFuel.)
  ARM_RESERVE_FUEL: 5,                 // % of tank held back for a safe reel-home

  // --- Deploy gate + daughter fuel economy (register item 100, 2026-08-21) ---
  // The deploy gate is tether-tier-aware: a daughter may launch at a target out
  // to tetherMax × ARM_DEPLOY_RANGE_FRACTION. The fraction keeps 0.15 of slack
  // to the 0.95× auto-recall guard against in-transit drift (measured metres-
  // scale; instrument tmp/i100-sweep.mjs). Replaces the pre-GSL-ladder literal
  // min(500, tetherMax × 0.5) — at T5 GSL-100 the weaver radius is 8 km, the
  // 16 km sweep doctrine (item 76(d), owner-ruled).
  ARM_DEPLOY_RANGE_FRACTION: 0.8,
  // Daughter FEEP tank as total Δv (m/s) — the economy anchor the HUD's
  // remainingDeltaV already assumed (ArmUnit.getStatus). TRANSIT/APPROACH
  // autopilot fuel is billed against it as commanded impulse (Σ|dv| / 50 ×
  // 100 %): the spring pays launch kinetic energy, the FEEP pays only for
  // corrections + the arrival kill. Replaces the time-based 1.5 %/s TRANSIT
  // rate that capped any powered sortie at ~63 s (630 m @10 m/s — measured,
  // tmp/i100-sweep.mjs) and billed slow shots MORE than fast ones.
  ARM_TOTAL_DELTAV: 50,                  // m/s of FEEP Δv per 100% daughter tank

  // --- NavSphere Tether Zones (Phase 3 — reserve constants) ---
  NAVSPHERE_LASSO_RING_COLOR: 'rgba(255, 255, 255, 0.3)',
  NAVSPHERE_SPINNER_RING_COLOR: 'rgba(0, 255, 136, 0.25)',
  NAVSPHERE_WEAVER_RING_COLOR: 'rgba(0, 204, 255, 0.2)',

  // --- NavSphere Distance Encoding (Sprint S5-A) ---
  NAVSPHERE: {
    SPHERE_RADIUS: 140,               // px (matches current value)
    INNER_ZONE_KM: 5,                 // tactical zone boundary
    OUTER_ZONE_KM_MAX: 100,           // max awareness zone
    ZONE_SPLIT: 0.50,                 // fraction of radius for inner zone
    RANGE_RINGS_KM: [0.2, 0.5, 2, 5, 10, 25, 50],
    DOT_MIN_PX: 1.5,
    DOT_MAX_PX: 8,
    VELOCITY_TAIL_MAX_PX: 15,
    VELOCITY_SCALE_FACTOR: 200,
    VELOCITY_MIN_CONTACTS_KM: 10,
    CLOSURE_APPROACHING_THRESHOLD: -0.0001,
    CLOSURE_RECEDING_THRESHOLD: 0.0001,
    COLOR_APPROACHING: '#ff4444',
    COLOR_ORBIT_CROSS: '#ffaa00',
    COLOR_RECEDING: '#00ff88',
    COLOR_ZONE_BOUNDARY: 'rgba(255, 170, 0, 0.25)',
    MAX_VELOCITY_TAILS: 50,
    MAX_SHAPE_CONTACTS_VISIBLE: 200,
    // ST-5.4: NavSphere stalks, lock-on ring, geo readout, velocity arrows
    STALK_MAX_FRACTION: 0.25,            // stalk length as fraction of sphere radius R
    STALK_LINE_WIDTH: 0.8,
    STALK_ALPHA: 0.5,
    // Calm-HUD: LOCK_ON_PULSE_RATE removed — the lock-on ring is steady for all
    // MOID badges (colour differentiates threat); no standing ring oscillation.
    LOCK_ON_OUTER_RADIUS_MULT: 1.5,      // × dot radius
    LOCK_ON_INNER_RADIUS_MULT: 1.1,      // × dot radius
    GEO_UPDATE_HZ: 2,                    // geolocation readout refresh rate
    VELOCITY_ARROW_RANGE_KM: 50,         // contacts within this range get arrows
    VELOCITY_ARROW_MAX_KMS: 2,           // closure rate that maps to MAX_LENGTH
    VELOCITY_ARROW_MAX_LENGTH_PX: 4,
  },

  // =========================================================================
  // CODEX (Phase 7 — Learning Systems)
  // =========================================================================
  CODEX: {
    UNLOCK_COOLDOWN: 20,              // seconds between unlocks (reduced from 30 for better game feel)
    // Startup legibility (2026-07-24): passive codex triggers (e.g. the first
    // delayed comms message) fire 5-20 s into a mission — the original 3 s
    // grace still let the 3-note unlock chime land inside the opening
    // comms/departure cluster with zero player action. Unlocks QUEUE during
    // grace (not dropped): toast + chime release together once the opening
    // settles, so the pairing that teaches the sound stays intact.
    STARTUP_GRACE_S: 30,
  },

  // =========================================================================
  // CONJUNCTION GATING (ST-2.1 — prevents early-game alert panic)
  // + MOID badge thresholds & CA speed-up (ST-6.3)
  // =========================================================================
  CONJUNCTION: {
    MIN_CAPTURES: 1,            // Minimum captures before first alert allowed
    MIN_ELAPSED_S: 120,         // Seconds after first capture before first alert
    PRIMER_LEAD_S: 5,           // Comms primer fires this many seconds before first overlay

    // ST-6.3: MOID badge thresholds (metres)
    MOID_HI_M: 5_000,          // <5 km  → HI (red, "imminent")
    MOID_MD_M: 25_000,         // <25 km → MD (yellow, "monitor")
    MOID_LO_M: 100_000,        // <100 km → LO (blue-green, "noted")
    MOID_SAFE_M: Infinity,     // ≥100 km → SAFE (not surfaced)

    // ST-6.3: Badge UI colours & labels
    BADGE_COLOR_HI: '#ff3344',
    BADGE_COLOR_MD: '#ddcc00',
    BADGE_COLOR_LO: '#22aadd',
    BADGE_LABEL_HI: 'HI',
    BADGE_LABEL_MD: 'MD',
    BADGE_LABEL_LO: 'LO',

    // ST-6.3: CA speed-up — only top-N MOID-ranked pairs enter the CA hot loop
    CA_TOP_N: 32,
    CA_MOID_PREFILTER_M: 150_000, // objects with MOID above this excluded from CA

    // ST-6.3: MOID recompute cadence (game-time seconds)
    MOID_RECOMPUTE_INTERVAL_S: 5.0,
    MOID_COARSE_SAMPLES: 8,
    MOID_REFINE_SAMPLES: 8,
  },

  // =========================================================================
  // SPACE WEATHER (Phase 7 — Learning Systems)
  // =========================================================================
  SPACE_WEATHER: {
    SOLAR_FLARE_MIN_INTERVAL: 300,
    SOLAR_FLARE_MAX_INTERVAL: 600,
    SOLAR_FLARE_MIN_DURATION: 60,
    SOLAR_FLARE_MAX_DURATION: 120,
    GEOMAGNETIC_MIN_INTERVAL: 600,
    GEOMAGNETIC_MAX_INTERVAL: 1200,
    GEOMAGNETIC_MIN_DURATION: 90,
    GEOMAGNETIC_MAX_DURATION: 180,
    SAA_DURATION: 45,
    SAA_INTERVAL: 5400,
    ECLIPSE_DURATION: 2100,
    ECLIPSE_INTERVAL: 5520,
  },

  // =========================================================================
  // SUBSYSTEM EVENTS (Phase 7B — Spacecraft Subsystems)
  // =========================================================================
  SUBSYSTEMS: {
    GROUND_STATION_INTERVAL: [300, 400],   // min/max seconds
    GROUND_STATION_WINDOW: [30, 90],       // min/max seconds of contact
    STAR_TRACKER_INTERVAL: 600,
    IMU_DRIFT_INTERVAL: 900,
    GPS_DENIED_INTERVAL: 1200,
    REACTION_WHEEL_INTERVAL: 800,
    GYRO_CHECK_INTERVAL: 1500,
    BATTERY_CYCLE_INTERVAL: 1000,
    TELEMETRY_INTERVAL: 500,
    WATCHDOG_INTERVAL: 1200,
    ECC_INTERVAL: 2000,
    TMR_INTERVAL: 1800,
    ATOMIC_OXYGEN_INTERVAL: 700,
    UV_DEGRADATION_INTERVAL: 1000,
    MMOD_INTERVAL: 2500,
    RADIATION_DOSE_INTERVAL: 900,
  },

  // =========================================================================
  // COLLISION AVOIDANCE — Semi-autonomous evasive maneuver system
  // =========================================================================
  COLLISION_AVOIDANCE: {
    SCAN_RADIUS: 0.05,              // scene units (5 km)
    SCAN_RADIUS_SQ: 0.0025,         // pre-computed squared
    AVOIDANCE_RADIUS_M: 100,        // meters — dodge threshold
    AVOIDANCE_RADIUS: 0.001,        // scene units (100 m)
    WARN_THRESHOLD_M: 300,          // meters — warning threshold (no dodge)
    WARN_THRESHOLD: 0.003,          // scene units (300 m)
    TRAWL_AVOIDANCE_RADIUS_M: 50,   // meters — tighter threshold during trawl
    TRAWL_AVOIDANCE_RADIUS: 0.0005, // scene units (50 m)
    LOOK_AHEAD_S: 10,               // seconds — prediction window (WORLD/orbital-mechanics
                                     // seconds — see real-dodge lane clock-consistency note
                                     // on _evaluateAndDodge: `tca` is derived from the same
                                     // physical orbital-velocity vectors that drive orbit
                                     // propagation via gameDt = dtReal × TIME_SCALE_GAMEPLAY,
                                     // so 10 "TCA seconds" here elapse in ~1 real wall-clock
                                     // second at the shipped 10× rate. CA's own scan/cooldown/
                                     // override timers below run on REAL dt. The contact
                                     // sweep (_scanAndProcessContacts) now also measures its
                                     // look-ahead window in WORLD seconds — main.js passes
                                     // dtWorld to update().)
    SCAN_INTERVAL: 0.25,            // seconds — scan every 250 ms (4 Hz)
    // Contact sweep (q2-contact-sweep): the contact scan's look-ahead window is the
    // WORLD seconds that passed since the previous scan (main.js passes dtWorld),
    // not SCAN_INTERVAL real seconds; it is clamped to this many world seconds.
    // s2-fast-time-hits (2026-10-17): it ALSO sets the world-time cadence — the contact
    // scan runs every SCAN_INTERVAL real s OR every this many world s, whichever comes
    // first (F4 ~every 3 frames, F5 every frame); the dodge scan stays at 4 Hz real.
    CONTACT_WINDOW_MAX_S: 10,       // world seconds — max contact look-ahead window
    // Backward chord: longest world gap it spans; a chord between true positions errs ~1/4 of a straight line (25 s: 13 m at 2 km/s, 67 m at 10 km/s, so <= ~17 m).
    CONTACT_CHORD_MAX_S: 25,        // world seconds
    // The contact pre-filter reaches SCAN_RADIUS + this speed x the window: the
    // fastest crossing in LEO (measured max relative speed 15.6 km/s at mission-2 start).
    CONTACT_PREFILTER_SPEED_MS: 16000, // m/s
    // real-dodge lane (2026-09-15): BASE_DODGE_DV is now a FLOOR, not a peak.
    // The dodge magnitude is geometry-driven (see DODGE_DV_CEILING_MS below);
    // this is the minimum committed burn once a dodge fires, so a threat that
    // technically needs less than this still gets a meaningful nudge.
    BASE_DODGE_DV: 0.5,             // m/s — minimum dodge burn (floor)
    // Per-dodge Δv ceiling — thruster authority + economic sanity. Sized so a
    // dodge fired at the full LOOK_AHEAD_S TCA can just reach AVOIDANCE_RADIUS_M
    // (100 m / 10 s = 10 m/s); demands above this are honestly reported
    // insufficient (CA_DODGE_INSUFFICIENT / "BRACE") rather than silently
    // under-delivered.
    DODGE_DV_CEILING_MS: 10.0,      // m/s — per-dodge Δv ceiling
    // Floor for the Δv-needed division (desiredMiss − predictedMiss) / tca —
    // guards against a near-zero TCA blowing up the requested burn. Any threat
    // this close is already ceiling-clamped to BRACE regardless of this floor.
    DV_MIN_TCA_S: 0.5,              // seconds (world time, same clock as `tca`)
    // Nominal billing window passed to applyCartesianImpulse for a one-shot
    // dodge burn (the burn itself is instantaneous; this only scales the
    // rate-based fuel/battery charge inside applyCartesianImpulse). Kept equal
    // to SCAN_INTERVAL — the system's own decision cadence — rather than a
    // second invented constant.
    DODGE_BILLING_WINDOW_S: 0.25,   // seconds
    // Reserve floor (fraction of XENON_FUEL_MAX / BATTERY_MAX): below this,
    // CA declines to spend the player's last margin autonomously and reports
    // an explicit refusal instead of firing (applyCartesianImpulse's own
    // gates only trip at exactly empty/interlocked — this is a proactive
    // floor above that).
    PROPELLANT_RESERVE_FRAC: 0.05,  // 5% of tank/battery capacity
    COOLDOWN: 3.0,                  // seconds between dodges
    OVERRIDE_WINDOW: 1.5,           // seconds — player input cancels dodge
    ALERT_DISPLAY_TIME: 3.0,        // seconds — HUD threat indicator duration
    /** @deprecated Tutorial system removed Sprint 3. Retained for reference only. */
    TUTORIAL_MIN_STAGE: 7,          // suppress during tutorial stages 0-6 (DEPLOY stage onward in new 10-stage tutorial)
    ENABLED_DEFAULT: true,          // system on by default

    // --- Comms quieting (Delegation 1 follow-up, 2026-05-31) -----------------
    // Reviewer feedback after the rebind verification pass: CA dodge comms
    // ("CAUTION: COLLISION AVOIDANCE. Dodge burn fired …") were spamming the
    // new player on mission 1, drowning out the welcoming onboarding tone we
    // want. Dodges still fire silently — only the COMMS_MESSAGE side-channel
    // is gated, and only for the routine/sufficient case (real-dodge lane,
    // 2026-09-15: insufficient-dodge and refusal comms bypass this gate —
    // those are safety-critical and must always reach the player).  Two layers:
    //   1. Mission-number floor — no CA comms below missionNumber < N.
    //   2. Rate limit — at most one CA comms every COMMS_RATE_LIMIT_S seconds
    //      once the floor is reached (so even mid-game the channel stays
    //      readable instead of becoming a wall of yellow).
    // Tune freely; the system reads these every emit-site.
    COMMS_MIN_MISSION:    3,    // mission number at which CA comms first speak
                                // (mission = floor(debrisCleared / 5) + 1, so
                                //  3 ≈ after 10 captures — a true "veteran" gate)
    COMMS_RATE_LIMIT_S:  12,    // seconds between consecutive CA comms
  },

  // =========================================================================
  // COLLISION MODEL (D2, ROADMAP §4 P2) — graduated debris-contact consequences
  // Consumed by the pure classifier `js/systems/collisionModel.js` and emitted
  // from CollisionAvoidanceSystem's existing 4 Hz scan (no new per-frame scan).
  // CA (when enabled) dodges most threats before contact; this model fires on
  // the genuine failures CA can't prevent (CA off, manual ramming, kessler
  // storms). All distances metres, speeds m/s, energy kJ. See COLLISION_MODEL
  // classifier + KesslerSystem GAME_COLLISION router.
  // =========================================================================
  COLLISION_MODEL: {
    HULL_RADIUS_M:        12,   // mother-ship contact radius (fallback when caller omits it)
    CONTACT_MARGIN_M:     8,    // added to hull radius → physical-contact envelope (~20 m)
    WARN_RADIUS_M:        300,  // D2 near-miss proximity-warning envelope (this model's own knob; the CA dodge path has a separate, currently-unused WARN_THRESHOLD_M)
    GLANCING_MIN_SPEED_MS: 2,   // below this closing speed a contact is inert (docking/reel drift-in); also the floor for a dodge (r1-release-dodge) and a proximity warning (r3-slow-warning)
    HARD_IMPACT_KJ:       250,  // kinetic energy ≥ this → 'hard' (shield/game-over); else 'glancing'
    // Per-debris re-fire cooldowns so a single lingering pass ≠ machine-gun events.
    WARN_COOLDOWN_S:      6,    // seconds between repeat COLLISION_WARNING for the same debris
    CONTACT_COOLDOWN_S:   5,    // seconds between repeat contact consequences for the same debris
    // Load-bearing new-player guard: the emitter stays disarmed for this many
    // gameplay seconds after entering play, and while onboarding runs, and for
    // any welcome-field / captured / pinned debris (see CollisionAvoidanceSystem).
    SPAWN_GRACE_S:        6,    // gameplay seconds before the emitter arms
    // Glancing-hit subsystem consequence (applied via ResourceSystem).
    GLANCING_SOLAR_DAMAGE_FRAC: 0.12, // solar-panel health lost per glancing hit
    GLANCING_BATTERY_DRAIN:     30,   // Wh battery drained per glancing hit
  },


  // =========================================================================
  // AUTOPILOT — Trailing-rendezvous controller (see AUTOPILOT_ANALYSIS.md §D)
  // All distances in metres, velocities in m/s unless noted. Scene conversion
  // uses M = 1e-5 scene units / metre. See AutopilotSystem.js for usage.
  // =========================================================================
  // ==========================================================================
  // AIM-BEFORE-LAUNCH (aim-before-launch plan §Tolerances)
  // Physical alignment tolerances + rotation rate for the Mother net /
  // daughter launch ceremony. Kept in one block for playtest tuning.
  // ==========================================================================
  AIM: {
    /** Mother net: ship +Z must align with the lead-intercept dir this tightly. */
    NET_AIM_TOLERANCE_DEG: 0.5,
    /** Daughter deploy: physical strut fire dir vs target (TRANSIT corrects the rest). launch-smooth: 1°, was 5°.
     *  The aim now slows to a stop at the target (eased, `_tickAimEased`), so it ends with ~0 rate instead of
     *  stopping the turn dead 5° short and snapping the last degrees. */
    DAUGHTER_AIM_TOLERANCE_DEG: 1,
    /** Abort the aim sequence if it cannot converge within this many seconds. */
    AIM_TIMEOUT_S: 30,
    /** Autopilot-managed slew rate (rad/s) — matches AutopilotSystem AP_ROT_RATE. */
    AP_ROT_RATE: 0.2,
    /** Onboarding may scale AP_ROT_RATE for the very first net/daughter beats. */
    ONBOARDING_ROT_RATE_MULT: 1.0,
  },

  // ==========================================================================
  // CHEST SHOT (owner 2026-10-25, DECISIONS §38 row 5; plan daughter-pairs-1025 S1): a daughter launched along the line through
  // the mother's centre of mass kicks her not at all. The daughter aim picks, per shot, the cheaper (gas) of today's angle and that
  // chest angle (Q1 a); with the wheel kit AND a wheel axis over half full it also scans the strut's angles, keeps those whose kick lowers that axis, and credits the kick (F1.1).
  // ==========================================================================
  CHEST_SHOT: {
    ENABLED: true,
    SCAN_STEP_DEG: 5,        // the kit's scan over the strut's reachable angle (T3)
    WHEEL_CREDIT_FRAC: 0.5,  // the kit's scan of other angles runs, and a kick that lowers the fullest wheel axis is credited, only when that axis is over this full (T3)
    EMPTIES_SAY_NMS: 1,      // "This launch also empties the wheels." only when the credit changed the pick and the fullest axis ends this much lower, N·m·s
    TIE_FRAC: 0.02,          // two shots whose gas differs by less than this (or TIE_G) cost the same: the quicker one is taken
    TIE_G: 0.5,              // g
    QUICK_FRAC: 0.10,        // the aim line names the other way ("quick: ...") only when its gas differs by more than this
  },

  // ==========================================================================
  // PAIR SHOT (owner 2026-10-25 00:11Z / 02:23Z "2 a", DECISIONS §38 row 5; plan daughter-pairs-1025 S2): two opposite daughters of one
  // type (struts 0+2 weavers, 1+3 spinners) leave in the same frame at the SAME strut angle, so their kicks cancel (measured: net 0 at every
  // angle). The mother turns (yaw/pitch only, her roll kept) so that each launch line lies within MISS_DEG of its own piece; each daughter
  // steers the rest herself on her own fuel (measured, tmp/pairs/s2/RESULT.md: 0.37 g per degree of miss for a weaver, 0.125 g a spinner).
  // ==========================================================================
  PAIR_SHOT: {
    ENABLED: true,
    MISS_DEG: 10,            // each daughter's launch line within this of her piece (measured: practical for 100 % of start-field pairs)
    TURN_DEG: 30,            // the mother's barrel turns at most this far for the pair (measured: 81 % of start-field pairs fit)
    FUEL_G: { weaver: 8, spinner: 2.5 },          // the pair's extra daughter fuel, g (both misses summed x the rate below)
    FUEL_G_PER_DEG: { weaver: 0.37, spinner: 0.125 },   // one daughter, per degree of miss (flat in range beyond 150 m)
    MIN_SEP_DEG: 4,          // two pieces seen less than this apart (one clump) are not a pair: the net scoops the clump whole
    ALPHA_MIN_DEG: { weaver: 7, spinner: 3 },     // the strut angles the real launch gate leaves clear for a pair (measured, 1 deg steps)
    ALPHA_MAX_DEG: 180,
    MAX_CANDIDATES: 8,       // the nearest pieces by bearing tried as the second piece
    REPLAN_S: 0.5,           // the offer is looked at again at most this often (and sooner when she turns or a piece is picked)
    HOLD_RATIO: 0.8,         // a standing offer is kept until a new pair beats its cost by this ratio
    FIRE_MISS_DEG: 12,       // at the spring: a pair whose lines have drifted past this is not fired (the gap over MISS_DEG is the aim's own stop error)
    SPREAD_MIN_DEG: 0,       // P5: the least flight angle between the two daughters (set from the measured closest approach; 0 = none)
  },

  // ==========================================================================
  // WHEEL PRE-TURN (owner 2026-10-25 02:23Z: "if a target is selected, the reaction wheel could intelligently immediately start pivoting
  // mother for best angle ... save gas"; plan daughter-pairs-1025 S1b): with the wheel kit, a docked daughter picked (keys 1-4) and a piece
  // picked, the wheels start turning her toward the shot the chooser would take, no gas, at the wheels' own pace; firing hands the rest to
  // the normal aim. Daughters only (the mother's own net shots get none yet).
  // ==========================================================================
  WHEEL_PRETURN: {
    ENABLED: true,
    MIN_BATTERY_FRAC: 0.30,  // the pre-turn starts, and goes on, only with the battery over this fraction (each wheel draws up to 150 W)
    REENGAGE_DEG: 3,         // holding on the shot: she turns again only once the line has drifted this far off
    RECHECK_S: 0.25,         // how often the slower gates (a net or catch on the piece, a line across another) are asked again
  },

  AUTOPILOT: {
    // --- Tool-aware trailing distance (metres behind debris along V_d) ---
    D_TRAIL_LASSO:   70,   // m — park INSIDE the 90 m lasso/net range (LASSO_RANGE === NET_LOCK_RANGE_M); 70 + POS_TOL 15 < 90. Was 120 (inside the old 200 m gate, outside the new one)
    D_TRAIL_ARMS:    35,   // m — spinner/weaver arm reach (~50 m)
    D_TRAIL_TRAWL:   150,  // m — trawl sweep trailing centroid
    D_TRAIL_DEFAULT: 80,   // m — fallback when no tool recommendation
    // Mother Large Net (whale) hold. Must sit INSIDE the sure-shot band:
    // SURE_SHOT_MIN_CLING needs range ≤ CLOSE_RANGE(30) AND spinFraction ≥ 0.8,
    // and spinFraction = 1 − 0.08·(range/10) hits 0.8 at exactly 25 m. 20 m
    // leaves margin against the AP's own VEL_TOL (0.5 m/s orbital = 5 m/s
    // apparent) residual, which moves the range ~45 m over a 9 s slew+flight.
    D_TRAIL_NET:     20,   // m — mother pod Large Net sure-shot hold

    // --- In-reach rotate-only thresholds ------------------------------------
    // When the debris is ALREADY within the active tool's capture reach there
    // is no need to translate (fly in) to the tight trailing point — the
    // mother only needs to ROTATE to point at the target and hold position.
    // The per-tool reach is NOT duplicated here: AutopilotSystem._getToolReach()
    // derives it directly from the canonical tool constants so retuning the
    // tether length / projectile range automatically propagates:
    //   weaver  → WEAVER_TETHER_LENGTH  (2000 m tether)
    //   spinner → SPINNER_TETHER_LENGTH (500 m tether)
    //   lasso   → LASSO_RANGE           (90 m = NET_LOCK_RANGE_M, the lasso fire gate)
    //   trawl   → D_TRAIL_TRAWL          (150 m sweep stand-off; ≥ trail so the
    //             rotate-only optimization can engage rather than overflying it)
    // Only the AP-owned policy values live here:
    REACH_DEFAULT:   200,  // m — conservative fallback when no tool recommendation. NOTE: nothing reads this today (the AutopilotSystem._getToolReach() named above does not exist — grep c64c911); the per-tool reach is the tool's own constant (lasso = LASSO_RANGE = 90 m)

    // Hysteresis band around the reach boundary. Once inside REACH the
    // autopilot enters rotate-only mode and will only resume translating if
    // the target drifts beyond REACH·(1 + REACH_HYSTERESIS). Prevents
    // translate↔rotate-only oscillation right at the boundary.
    REACH_HYSTERESIS: 0.15, // +15 % exit band

    // --- Tolerance bands (state machine transitions) ---
    POS_TOL:          15,  // m — |P_m − P_m*| considered on-station
    VEL_TOL:          0.5, // m/s — |V_m − V_d| considered velocity-matched
    ANG_TOL_DEG:      3,   // degrees — nose vs. v̂_d alignment tolerance

    // --- Phase transition thresholds ---
    FAR_TO_MATCH_POS: 500, // m — RENDEZVOUS_FAR → MATCH_ORBIT when pos err below this
    HOLD_DURATION:    1.5, // s — HOLD phase duration before auto-disengage

    // Dwell/debounce before HOLD → TRAIL_ALIGN demotion. A station-keeping
    // excursion (posErr > 4·POS_TOL OR velErr > 4·VEL_TOL) must persist for at
    // least this long before the phase drops back to TRAIL_ALIGN. Absorbs
    // single-frame transients (CA dodge settling, one-frame measurement lag,
    // frame-boundary drag mismatch) that previously flickered the phase chip
    // ALIGN ↔ HOLD indefinitely. See .kilo/plans/autopilot-align-hold-loop.md.
    HOLD_EXIT_DWELL_S: 0.3, // s — sustained-excursion time before HOLD demotes

    // --- Control law ---
    // Predictive quadratic-braking velocity profile (see AUTOPILOT_ANALYSIS.md §D
    // Retrospective #2 for rationale). Desired closing speed:
    //   v*(r) = min(V_CAP, √(2·A_BRAKE·max(r − POS_TOL, 0)))
    // where A_BRAKE = MAX_ACCEL·BRAKE_FRACTION leaves headroom for transverse
    // corrections. Commanded ΔV = KP_VEL·(v*·goalDir + relV_mps), clamped by
    // MAX_ACCEL·dt. This replaces a proportional-only law that had no
    // predictive-braking term and overshot by hundreds of metres from >500 m
    // engage distance.
    MAX_ACCEL:        2.0, // m/s² — clamp per-tick commanded acceleration
    KP_VEL:           0.8, // dimensionless — velocity tracking gain
    BRAKE_FRACTION:   0.5, // fraction of MAX_ACCEL reserved for along-track braking
    V_CAP:           50.0, // m/s — hard cap on commanded closing speed v*
    KP_POS:           0.2, // 1/s — deprecated; retained for compatibility, not used in control law

    // --- Station-keeping recoil compensation (ST-4.B) ---
    STATION_KEEP_COMPENSATION: true,  // master toggle for tool-fire recoil compensation in HOLD
    STATION_KEEP_EFFICIENCY:   0.85,  // fraction of theoretical ΔV applied (thruster losses)
  },

  // =========================================================================
  // SKILLS DISCOVERY — Replaces linear 10-stage tutorial
  // See archive/SKILLS_ARCHITECTURE.md for full specification (34 discoverable skills)
  // =========================================================================
  SKILLS: {
    // --- State Transition Thresholds ---
    PRACTICE_COUNT_DEFAULT: 5,       // uses to reach PRACTICED state
    PRACTICE_COUNT_SCAN: 3,          // quick actions need fewer uses
    PRACTICE_COUNT_CATCH: 3,         // significant actions need fewer uses
    PRACTICE_COUNT_COMPLEX: 2,       // complex skills (arm_pilot) need fewer uses
    MASTERY_COUNT_DEFAULT: 20,       // uses to reach MASTERED state
    MASTERY_COUNT_CATCH: 10,         // catch skills master faster
    MASTERY_MIN_TIME: 300,           // seconds (5 min minimum before mastery)

    // --- UI Timing ---
    PANE_SHOW_DURATION: 4000,        // ms — how long pane stays visible after discovery
    PANE_FIRST_SKILL_DURATION: 8000, // ms — first 3 discoveries get longer display
    PANE_FADE_DURATION: 600,         // ms — fade out animation
    MASTERED_FADE_DELAY: 30000,      // ms — delay before mastered skills fade from pane

    // --- Spaced Repetition (SM-2 variant) ---
    REMINDER_BASE_INTERVAL: 45,      // seconds — base interval between reminders
    REMINDER_MAX_INTERVAL: 86400,    // seconds — cap at 24h
    REMINDER_MIN_INTERVAL: 30,       // seconds — floor
    REMINDER_EASE_FACTOR: 2.5,       // SM-2 ease factor
    REMINDER_FREQUENCY_CAP: 3,       // max reminders per cap window
    REMINDER_CAP_WINDOW: 300,        // seconds — window for frequency cap

    // --- CP-4 universal hint-gating rule (GUIDANCE_ARBITER_SPEC §3 / §3.1) ---
    MAX_UNHEEDED_NUDGES: 3,          // per-skill: fall silent after this many unheeded nudges
    RECENT_FAILURE_TTL_S: 30,        // a failure counts as "recent" for this long (s)
    RECENT_FAILURE_BUFFER: 12,       // ring-buffer size for recent-failure causes
    VETERAN_SKILL_THRESHOLD: 0.7,    // fraction of skills discovered ⇒ veteran (ticker, not modal)
    // Failure-event → cause tag for the _recentFailures ring buffer.
    FAILURE_CAUSES: {
      NET_FAILED:          'net-fail',
      NET_CATCH_MISS:      'net-miss',
      LASSO_MISSED:        'lasso-miss',
      LASSO_DENIED:        'lasso-denied',
      PAD_BOUNCED:         'pad-bounce',
      ARM_CAPTURE_FAILED:  'capture-fail',
    },

    // --- Blitz Detection (veteran/expert player) ---
    BLITZ_WINDOW: 8000,              // ms — variable ratio window for early rapid discovery
    BLITZ_SUPPRESS_CHANCE: 0.3,      // probability of suppressing reminder during blitz
    BLITZ_THRESHOLD: 15,             // skills in detection window → expert mode
    BLITZ_DETECTION_WINDOW: 300,     // seconds (5 min) — window for blitz rate calculation

    // --- Discovery Queue ---
    DISCOVERY_COOLDOWN: 3,           // seconds between pane popups
    DISCOVERY_BATCH_THRESHOLD: 5,    // above this → batch notification
    EARLY_DISCOVERY_COUNT: 10,       // first N discoveries get variable ratio reinforcement

    // --- Safety Gates ---
    DETACH_MIN_CATCHES: 2,           // mastery_detach requires ≥2 total catches
    TRAWL_MIN_CATCHES: 1,            // collect_trawl requires ≥1 total catch

    // --- Tier Definitions (5 tiers with progression colors) ---
    TIERS: [
      { id: 'orientation',  tier: 1, label: 'Orientation',  color: '#00ff88' },
      { id: 'core_tools',   tier: 2, label: 'Core Tools',   color: '#44ddff' },
      { id: 'proficiency',  tier: 3, label: 'Proficiency',  color: '#4488ff' },
      { id: 'advanced',     tier: 4, label: 'Advanced',     color: '#8866ff' },
      { id: 'mastery',      tier: 5, label: 'Mastery',      color: '#cc44dd' },
    ],

    // --- Skill Catalog (41 skills) -----------------------------------------------------------
    // Fields: id, label, key, say?, tier, category, hudGroup, prereqs, prereqType, noReminder, triggerEvent, triggerFilter?
    // say: the plain phrase a stale-skill reminder shows ("Press S to scan."), nets-1b; none -> the label alone, no key glue.
    // triggerEvent: Events.js constant name (string key) or null if auto/timer/needs new event
    // triggerFilter: OPTIONAL (data) => boolean — payload predicate so several skills can share one
    //   triggerEvent but discriminate by payload (e.g. ARM_CAPTURED{manual:true}, SCAN_INITIATED{type:'wide'}).
    //   Omit for fire-on-every-event behavior. See GUIDANCE_ARBITER_SPEC §5 / SkillsSystem._setupListeners.
    // prereqType: 'none' | 'soft' | 'hard' | 'safety'
    //   none   — independent, discoverable any time in any order
    //   soft   — works without prereq but system provides contextual guidance
    //   hard   — physically impossible without prior game state
    //   safety — irreversible destructive action gated by catch count
    CATALOG: [
      // ── Tier 1: Orientation (6 skills — independent, any order) ─────────
      { id: 'nav_zoom',         label: 'Zoom',         key: 'Scroll', say: 'Scroll to zoom.',    tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CAMERA_ZOOM' },
      { id: 'nav_rotate',       label: 'Rotate View',  key: 'Drag', say: 'Drag to look around.',      tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CAMERA_ORBIT_DRAG' },
      { id: 'nav_camera',       label: 'Camera Views', key: 'V', say: 'Press V to change the camera view.',         tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CAMERA_VIEW_CHANGE' },
      { id: 'nav_arrows',       label: 'Ship Rotation', key: '←↑↓→', say: 'Use the arrow keys to turn.',    tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'TUTORIAL_ARROW_INPUT' },
      { id: 'nav_throttle',     label: 'Throttle',     key: '+/-', say: 'Press Shift and plus or minus to change the thrust.', tier: 1, category: 'nav',      hudGroup: 'propulsion',    prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'THROTTLE_CHANGE' },
      { id: 'scan_quick',       label: 'Quick Scan',   key: 'S', say: 'Press S to scan.',         tier: 1, category: 'scan',      hudGroup: 'targets',       prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'SCAN_QUICK' },
      // ── Delegation 4 (2026-05-31): two Tier-1 skills added to back the onboarding `struts` and `inspect` beats. ──
      { id: 'arm_struts',       label: 'Strut Deployment', key: '.', say: 'Press the period key to move the struts out or in.',      tier: 1, category: 'collect',   hudGroup: 'fleet',         prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'STRUT_DEPLOY_INPUT' },
      { id: 'inspect_mother',   label: 'Spacecraft Inspection (V, then scroll in)', key: 'V', say: 'Press V, then scroll in, to look over the ship.', tier: 1, category: 'awareness', hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'INSPECTION_TOGGLE' },
      // ── Tier 2: Core Tools (6 skills) ───────────────────────────────────
      { id: 'scan_wide',            label: 'Wide Scan',    key: 'Shift+S', say: 'Press Shift S for a wide scan.',     tier: 2, category: 'scan',      hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'SCAN_WIDE' },
      { id: 'nav_target',           label: 'Target Selection', key: 'T', say: 'Press T to pick the next target.', tier: 2, category: 'nav',     hudGroup: 'target-info',   prereqs: [],  prereqType: 'soft', noReminder: false, triggerEvent: 'TARGET_SELECTED' },
      { id: 'nav_autopilot',        label: 'Autopilot',    key: 'A', say: 'Press A to fly to your target.',     tier: 2, category: 'nav',       hudGroup: 'orbit-mfd',     prereqs: [],  prereqType: 'soft', noReminder: false, triggerEvent: 'AUTOPILOT_ENGAGE' },
      { id: 'collect_deploy',       label: 'Deploy Daughter',   key: 'D', say: 'Press D to send a daughter.',     tier: 2, category: 'collect',   hudGroup: 'fleet',         prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'ARM_DEPLOYED' },
      { id: 'collect_lasso',        label: 'Lasso',        key: 'N', say: 'Press N to launch the net.', tier: 2, category: 'collect',   hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'LASSO_FIRED' },
      { id: 'awareness_mouse_look', label: 'Mouse Look',   key: null,    tier: 2, category: 'awareness', hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: true,  triggerEvent: 'CAMERA_FREE_LOOK' },

      // ── Tier 3: Proficiency (7 skills) ──────────────────────────────────
      { id: 'nav_autopilot_no_target', label: 'Autopilot w/o Target', key: null, tier: 3, category: 'nav',    hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: true,  triggerEvent: 'AUTOPILOT_NO_TARGET' },
      { id: 'scan_discovery',          label: 'Scan Discovery',       key: null, tier: 3, category: 'scan',   hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'SCAN_DISCOVERY' },
      { id: 'collect_dual_fire',       label: 'Dual Launch',            key: null, tier: 3, category: 'collect', hudGroup: null,          prereqs: [],  prereqType: 'hard', noReminder: false, triggerEvent: 'DUAL_FIRE' },
      { id: 'manage_power',            label: 'Power Distribution',   key: 'Shift+1/2/3', say: 'Press Shift and 1, 2 or 3 to pick a power line.', tier: 3, category: 'manage', hudGroup: 'power',    prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'POWER_BUS_SELECTED' },
      { id: 'manage_comms',            label: 'Comms Menu',           key: '7', say: 'Press 7 for comms.',  tier: 3, category: 'manage', hudGroup: 'comms',       prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'COMMS_OPENED' },
      { id: 'manage_codex',            label: 'SPECS',                key: 'I', say: 'Press I to read the specs.',  tier: 3, category: 'manage', hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CODEX_OPENED' },
      // ── CP-4 ch2 (MissionCoach): Daughter piloting (payload-discriminated via triggerFilter) ──
      { id: 'arm_pilot',         label: 'Daughter Piloting', key: '1-4', say: 'Press 1 to 4 to pick a daughter to fly.', tier: 3, category: 'collect', hudGroup: 'fleet', prereqs: [], prereqType: 'none', noReminder: false, triggerEvent: 'CONTROL_MODE_CHANGE', triggerFilter: (d) => d && d.mode === 'ARM_PILOT' },
      { id: 'arm_pilot_capture', label: 'Manual Capture',    key: 'N', say: 'Press N to use the daughter\'s tool.', tier: 3, category: 'collect', hudGroup: 'fleet', prereqs: [], prereqType: 'none', noReminder: false, triggerEvent: 'ARM_CAPTURED',        triggerFilter: (d) => d && d.manual === true },
      // ── CP-4 ch4 (MissionCoach): Cluster/transfer agency on the Debris Map (CP-3) ──
      // M retired 2026-10-09 (H1): the F4 plan-transfer / F3 approach emit
      // DEBRIS_MAP_CLUSTER_SELECTED through LadderBridge, so no key opens this skill.
      { id: 'strategic_map',     label: 'Transfer Map',      key: null, tier: 3, category: 'nav',     hudGroup: null,    prereqs: [], prereqType: 'none', noReminder: false, triggerEvent: 'DEBRIS_MAP_CLUSTER_SELECTED' },
      // ── CP-4 Phase D (MissionCoach chapters 8/9/11) ──────────────────────────
      // ch8 confirm-before-fire: discovered when the player trips the active-sat treaty
      //   guard (ActiveSatGuard emits CONJUNCTION_ALERT{reason:'ACTIVE_SAT_ARMING'}).
      // ch9 fleet command: the C-hold radial wheel was REMOVED (UX-11 #9) —
      //   dual-arm throughput is taught via direct keys. The skill keeps its
      //   historical id ('radial_menu') so old saves restore cleanly, but it
      //   now tracks the fleet-recall verb (Shift+R → ARM_RECALL_ALL; was
      //   H / Shift+O before the 2026-06-12 hotkey cleanup).
      // ch11 orbital_hohmann (u16a): discovered when the ch11_hohmann lesson is finished, i.e. the
      //   player flew a cluster transfer (FLY THERE / Space) after the lesson pointed at the LEO
      //   window pane. The old CLUSTER_WINDOW_OPEN trigger only fired from a dev key (Shift+A);
      //   the porkchop viz is deferred (EN-5/6).
      { id: 'confirm_before_fire', label: 'Confirm Before Launch', key: null, tier: 3, category: 'awareness', hudGroup: null, prereqs: [], prereqType: 'none', noReminder: true,  triggerEvent: 'CONJUNCTION_ALERT', triggerFilter: (d) => d && d.reason === 'ACTIVE_SAT_ARMING' },
      { id: 'radial_menu',         label: 'Fleet Recall',        key: 'Shift+R', say: 'Press Shift R to reel in all daughters.',  tier: 3, category: 'collect',   hudGroup: 'fleet', prereqs: [], prereqType: 'none', noReminder: false, triggerEvent: 'ARM_RECALL_ALL' },
      // ── item 100 (2026-08-21): the launch-speed dial. Discovered by moving
      //   the dial (LAUNCH_SPEED_CHANGED); the ch10 wide-sweep beat teaches its
      //   application (ARM_CAPTURED rangeM ≥ 1000 — the tether-gated unlock).
      { id: 'speed_dial',          label: 'Launch-Speed Dial',   key: "; / '", say: 'Press the semicolon or apostrophe key to change the launch speed.',   tier: 3, category: 'collect',   hudGroup: 'fleet', prereqs: [], prereqType: 'none', noReminder: false, triggerEvent: 'LAUNCH_SPEED_CHANGED' },
      { id: 'orbital_hohmann',     label: 'Hohmann Window',      key: null, tier: 4, category: 'nav',       hudGroup: null,    prereqs: [], prereqType: 'soft', noReminder: false, triggerEvent: 'MISSION_BEAT_SATISFIED', triggerFilter: (d) => !!d && d.beatId === 'ch11_hohmann' },

      // ── Tier 4: Advanced (8 skills) ─────────────────────────────────────
      // F5: was triggerEvent 'ORBIT_MFD_TOGGLE' — that event has NO emitter
      // (OrbitMFD is constructed + frame-updated but its toggle() was never
      // wired to a key), so this skill was undiscoverable and gated nav_hohmann.
      // Repointed to the live orbital-survey read (Debris Map cluster select),
      // which is the surface that now teaches orbital-element reading. Revive
      // the OrbitMFD panel + repoint back if it ships.
      { id: 'nav_orbit_mfd',      label: 'Orbit MFD Reading',   key: null,  tier: 4, category: 'nav',       hudGroup: null,  prereqs: ['nav_autopilot'],  prereqType: 'soft',   noReminder: false, triggerEvent: 'DEBRIS_MAP_CLUSTER_SELECTED' },
      { id: 'collect_pulse_scan', label: 'Pulse Scan',           key: null, tier: 4, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'PULSE_SCAN_START' },
      { id: 'collect_lasso_miss', label: 'Lasso Miss Recovery',  key: null, tier: 4, category: 'collect',   hudGroup: null,  prereqs: ['collect_lasso'],   prereqType: 'hard',   noReminder: true,  triggerEvent: 'LASSO_MISSED' },
      // defer-trawl: "Dragnet" (formerly "Trawl"). Re-tiered to Advanced and
      // hard-gated behind `dragnet_unlock` — a flag the (future) advanced
      // Dragnet mission grants. Until then this stays UNDISCOVERED for new
      // players: Shift+G still emits TRAWL_START (testable) but the skill never
      // surfaces in the Discovery pane / reminders. noReminder keeps it silent.
      { id: 'collect_trawl',      label: 'Dragnet',              key: 'Shift+G', tier: 4, category: 'collect', hudGroup: null,  prereqs: ['dragnet_unlock'],  prereqType: 'hard',   noReminder: true,  triggerEvent: 'TRAWL_START' },
      // F is the furnace joke until a furnace is built (DECISIONS §15): id/key/event stay, the game never nags for it.
      { id: 'manage_forge',       label: 'Furnace',              key: 'F', tier: 4, category: 'manage',    hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: true,  triggerEvent: 'FORGE_TOGGLE' },
      // Salvage is fuel / hold cargo (GameFlowManager → CARGO_STORE); taught by the ch6 beat.
      { id: 'collect_salvage',    label: 'Salvage',              key: null, tier: 4, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: true,  triggerEvent: 'CARGO_STORE' },
      { id: 'manage_shop',        label: 'Shop Navigation',      key: null, tier: 4, category: 'manage',    hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'UPGRADE_PURCHASED' },
      { id: 'awareness_kessler',  label: 'Kessler Event',        key: null, tier: 4, category: 'awareness', hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: true,  triggerEvent: 'KESSLER_CASCADE' },
      { id: 'awareness_weather',  label: 'Space Weather',        key: null, tier: 4, category: 'awareness', hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: true,  triggerEvent: 'WEATHER_EFFECT_START' },

      // ── Tier 5: Mastery (7 skills) ──────────────────────────────────────
      { id: 'nav_hohmann',        label: 'Hohmann Transfer',     key: null,  tier: 5, category: 'nav',       hudGroup: null,  prereqs: ['nav_orbit_mfd'],  prereqType: 'soft',   noReminder: false, triggerEvent: 'AUTOPILOT_ARRIVED' },
      { id: 'collect_arm_pilot',  label: 'DAUGHTER PILOT Mode',       key: '1-4', say: 'Press 1 to 4 to pick a daughter to fly.',   tier: 5, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'soft',   noReminder: false, triggerEvent: 'ARM_SELECT' },
      { id: 'mastery_detach',     label: 'Risk Detach',          key: 'X', say: 'Press X to cut a daughter loose.',   tier: 5, category: 'collect',   hudGroup: null,  prereqs: ['collect_deploy'],  prereqType: 'safety', noReminder: false, triggerEvent: 'ARM_DETACHED',       safetyGate: { minCatches: 2 } },
      // F5: was key 'T' + triggerEvent 'TOOL_CYCLE'. T is now "Target debris"
      // and TOOL_CYCLE has no emitter; the tool-cycle verb moved to Backquote in
      // ARM_PILOT/STATION_KEEP, which emits TOOL_SELECTED (ArmUnit cycleTool).
      // Repointed so the skill is discoverable; glyph updated to the live key.
      { id: 'mastery_tool_cycle', label: 'Tool Cycling',         key: '`', say: 'Press the backtick key for the next tool.', tier: 5, category: 'manage', hudGroup: null, prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'TOOL_SELECTED' },
      { id: 'mastery_ca_dodge',   label: 'CA Manual Override',   key: null,  tier: 5, category: 'awareness', hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'CA_DODGE_EXECUTED' },
      { id: 'mastery_synergy',    label: 'Synergistic Salvage',  key: null,  tier: 5, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'hard',   noReminder: false, triggerEvent: 'SYNERGY_BONUS' },
      { id: 'mastery_full_sweep', label: 'Full Sweep',           key: null,  tier: 5, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'hard',   noReminder: false, triggerEvent: 'TRAWL_SWEEP_COMPLETE' },
    ],

    // --- Celebration (ST-3.4: PRACTICED / MASTERED feedback) ---
    CELEBRATION: {
        PRACTICE_FLASH_MS: 650,
        MASTERY_FLASH_MS: 1200,
    },

    // --- Discovery Pane (ST-3.1: NOVICE checklist mode) ---
    DISCOVERY_PANE: {
        CHECKLIST_SUGGESTION_COUNT: 3,
        CHECKLIST_DONE_LINGER_MS: 3000,
        CHECKLIST_PULSE_PERIOD_MS: 1400,
    },
  },

  // === HUD PANEL READABILITY (ST-2.2) ===
  SELECTED_ROW_ALPHA: 0.22,             // Target list selected‐row highlight
  SELECTED_ROW_GLOW_ALPHA: 0.4,         // Inset box-shadow glow
  SELECTED_ROW_TEXT_GLOW: 0.5,          // Text-shadow on selected name
  WIREFRAME_BG_ALPHA: 0.95,             // Debris wireframe panel background
  RETICLE_BRACKET_WIDTH: 2.0,           // Unselected bracket lineWidth (up from 1.5)
  RETICLE_BRACKET_WIDTH_SELECTED: 3.0,  // Selected bracket lineWidth (up from 2.5)

  // === DEBRIS VISUAL MATERIALS (ST-2.3) ===
  DEBRIS_MATERIALS: {
    aluminum:   { metalness: 0.9,  roughness: 0.3,  color: 0xC0C0C0 },   // bright reflective
    titanium:   { metalness: 0.85, roughness: 0.4,  color: 0x8A9BA8 },   // darker metallic
    composite:  { metalness: 0.2,  roughness: 0.7,  color: 0x3A3A3A },   // dark matte
    mli_mylar:  { metalness: 0.95, roughness: 0.15, color: 0xFFD700 },   // gold foil
    solar_cell: { metalness: 0.6,  roughness: 0.5,  color: 0x1A237E },   // dark blue
    steel:      { metalness: 0.85, roughness: 0.55, color: 0x808890 },   // ferromagnetic hull (P2 magnet target)
  },

  // === DEBRIS VISUAL TUMBLE CLAMPING (ST-2.3 → v2e) ===
  // v2e: Reduced from 30°/s → 10°/s per user feedback ("jagged object rotating fast").
  // At 60fps that's 0.17°/frame — much smoother perceived motion on small
  // jagged geometry without compromising the "actively tumbling" feel.
  DEBRIS_MAX_VISUAL_TUMBLE_DEG_S: 10,   // max visual tumble rate in °/s (real time) — 3D scene
  WIREFRAME_MAX_TUMBLE_DEG_S: 8,        // max wireframe tumble rate in °/s — lower for Canvas2D comfort

  // === DEBRIS FRAGMENT VARIATION (ST-2.3) ===
  DEBRIS_FRAGMENT_VARIANTS: 7,           // number of distinct fragment geometry variants

  // =========================================================================
  // SKILL_GATES — Sprint 3 skill-based feature gating thresholds
  // Replaces removed TutorialSystem stage-number gates.
  // =========================================================================
  SKILL_GATES: {
    CONJUNCTION_MIN_CATCHES: 1,          // minimum captures before conjunction alerts fire
    CONJUNCTION_MIN_ELAPSED_S: 120,      // seconds after first capture before conjunction alerts
    KESSLER_MIN_MISSION: 4,             // mission number before Kessler warnings activate
    SUBSYSTEM_MIN_CATCHES: 1,           // minimum captures before subsystem chatter
  },

  // =========================================================================
  // DEBRIS MAP (ST-4.A — Cluster-ranked strategic sweep planning overlay)
  // =========================================================================
  DEBRIS_MAP: {
    POLL_INTERVAL_S: 5,       // seconds between cluster re-polls
    MAX_DISPLAY: 5,           // top-N clusters shown in the map
    MAX_DV_MS: 500,           // clusters requiring > this ΔV (m/s) are "unreachable"
    WINDOW_IMMINENT_S: 10,    // CP-3 — countdown turns cyan + beeps at this T-minus (s)
  },

  // =========================================================================
  // TRIP - the burn to the next debris field (lane trip-melt-1, owner 2026-10-19, DECISIONS §29;
  // js/systems/TransferTrip.js, FEATURE_FLAGS.TRANSFER_TRIP)
  // =========================================================================
  TRIP: {
    TIME_RATE: 100,        // world-clock target while the trip burns (the F5 rate, FloorContract timeCap)
    HANDOFF_RATE: 1,       // world-clock target while a leash hand-off or a carry runs on the trip (the base rate: 10x game time; trip-melt-2 D12b)
    DV_MPS: 20,            // m/s billed per trip: the gas of a small altitude change (coordinator ESTIMATE, owner may tune); spread over the first MIN_REAL_S
    MIN_REAL_S: 10,        // real seconds: the shortest burn, even with nothing to melt
    MAX_REAL_S: 120,       // real seconds: the longest; an unfinished melt keeps its progress for the next trip
    WAIT_DOCK_MAX_S: 60,   // real seconds the trip waits for daughters to come home; then it burns as the ship points
    REFUSAL_GAP_S: 2,      // real seconds between two "Burning to the next field." refusal lines of one kind

    // ── Fields by height (FEATURE_FLAGS.FIELDS_BY_HEIGHT; TripProfile.js, TransferTrip.js) ────────────────────────────────
    // The real thruster (DECISIONS §33 row 10): the Busek BHT-600 pushes 39 mN on xenon at 600 W; the loaded gas pushes
    // `FUELS[gas].thrustScale` of that (argon 0.46 = 18 mN). The research doc quotes both ("18 / 39 mN at 600 W").
    XENON_THRUST_N: 0.039,
    PROFILE_STEP_S: 60,    // game seconds per step of the trip profile (the integrator of TripProfile.js)
    PROFILE_MAX_DAYS: 400, // a profile that has not arrived by then does not (drag beats the push, or a typo): not flyable
    // The trip PLAYS the profile (row 10: "sped up to 1-2 minutes"): P = clamp(PLAY_BASE_S + PLAY_PER_DAY_S x days, PLAY_MIN_S,
    // PLAY_MAX_S) real seconds. A 5-day climb plays in 68 s, a 17-day one in 86 s, a 40-day one in 120 s.
    PLAY_BASE_S: 60,
    PLAY_PER_DAY_S: 1.5,
    PLAY_MIN_S: 60,
    PLAY_MAX_S: 120,
    BURN_POSE_MAX_DEG: 146, // the radiators the profile is flown at (THERMAL.FLOWER.POSE_THRUST_MAX_DEG, the burn band's edge)
    TURN_OK_DEG: 10,        // the push counts once her nose is within this of the burn attitude (a descent turns a half turn first)
    TURN_WAIT_MAX_S: 45,    // ... but the profile never waits longer than this for the turn (real s; the turn itself takes about 16 s)
    // Review R1: at an empty battery (under 0.5 Wh) the ship cannot hold her nose and the trip's turn lets go; the trip asks for
    // it again once the battery holds this much (Wh). Higher than the off line on purpose: at the trip's 100x clock an eclipse
    // lasts ~2 real s and the base load takes ~1 Wh of it (measured 2026-10-22, research doc), so 2 Wh rides one out and the
    // turn does not let go again at the next shadow. No time limit: without power she waits for it.
    TURN_POWER_WH: 2,
  },

  // =========================================================================
  // HIGH_FIELD - the rows of a HIGH field: dead satellites and rocket stages (Nets step 3 slice 4, lane 4a; DECISIONS §33 row 6:
  // "dead satellites and rocket stages at 750-900 km"; DebrisField._spawnWelcomeField, FieldRegistry)
  // =========================================================================
  // The same 7 rows lay out every `kind: 'high'` field in FIELDS.LIST, through the field spawn path that lays out WELCOME_FIELD
  // for a low field: row i of the table is piece i of the field. Per field: 2 upper stages (800-1,500 kg), 2 dead satellites over
  // 500 kg (the mother net takes them: a daughter's net stops at 500 kg) and 3 dead satellites of 50-500 kg (a large daughter or the
  // mother net). The field's seed rolls where each piece sits along the track and, inside each row's ranges, how heavy it is: the
  // SAME roll picks mass and size, so a heavier piece is a bigger one (the four fields differ). Every piece is a real catalogue
  // class (names below; data/debris-catalog.json at 700-960 km), in HER orbit's tilt (the catalogue's own 70-99 deg is not used),
  // and every piece is something she can catch: its largest side stays at or under CATCH_MAX_SIDE_M (a margin under the
  // 6 m mother net, CAPTURE_NET.LARGE.DIAMETER), its mass under the mother net's 5,000 kg, its tumble under the net's 10 deg/s
  // limit (DEBRIS_TYPES / assessNetFit). The numbers are ESTIMATES to tune except where a catalogue entry is named: the catalogue's own
  // stage sizes (SL-14 R/B 6 m, Meteor-1 R/B 6.5 m, SL-8 R/B 6.5 m) are over the mouth, so the stage rows are named estimates
  // cut to fit (a stage whose side the net cannot swallow would be a piece she could never catch, which is not what a field is for).
  // Row fields: `types`/`material` (which parked spare a row claims: DebrisField._claimHeavySpare), `massMin..massMax` kg and
  // `sizeMin..sizeMax` m (one roll), `tumbleDegS` (the spin, deg/s), and the placement in HER frame as for WELCOME_FIELD: `fwdMinM..
  // fwdMaxM` ahead along-track (m; the seed rolls inside), `latM` right (+), `radM` up (+). Bands never overlap; all of them stay
  // inside RESEAT.DIST_M (3,000 m).
  HIGH_FIELD: [
    { name: 'Dead upper stage (SL-14 class)',     types: ['rocketBody'], material: 'aluminum',  massMin: 1200, massMax: 1500, sizeMin: 5.2, sizeMax: 5.5, tumbleDegS: 2.5,
      fwdMinM: 150,  fwdMaxM: 230,  latM: -35,  radM: 15,      // #1 catalogue SL-14 R/B 1,400 kg / 6 m: cut to 5.2-5.5 m (estimate)
      owner: { name: 'Russia', status: 'owner', launchYear: 1988, notable: 'Tsyklon-3 upper stage, launched by the USSR.' },
      areaM2: 12.3 },   // cylinder 5.35 m x 2.4 m (surface / 4, tumbling mean)
    { name: 'Dead upper stage (Meteor-1 class)',  types: ['rocketBody'], material: 'steel',     massMin: 800,  massMax: 1000, sizeMin: 5.0, sizeMax: 5.4, tumbleDegS: 4,
      fwdMinM: 380,  fwdMaxM: 500,  latM: 90,   radM: -30,     // #2 catalogue Meteor-1 R/B 880 kg / 6.5 m: cut to 5.0-5.4 m (estimate)
      owner: { name: 'Russia', status: 'owner', launchYear: 1970, notable: 'Molniya-M upper stage, launched by the USSR.' },
      areaM2: 13.3 },   // cylinder 5.2 m x 2.6 m
    { name: 'Dead satellite (Cosmos 1175 class)', types: ['defunctSat'], material: 'aluminum',  massMin: 1000, massMax: 1300, sizeMin: 3.8, sizeMax: 4.2, tumbleDegS: 3,
      fwdMinM: 620,  fwdMaxM: 780,  latM: -140, radM: 50,      // #3 catalogue Cosmos 1175 1,100 kg / 4 m
      owner: { name: 'Russia', status: 'owner', launchYear: 1980, notable: 'Defunct Tsikada navigation satellite.' },
      areaM2: 5.2 },    // cylinder 4.0 m x 1.4 m (body only)
    { name: 'Dead satellite (Meteor 2 class)',    types: ['defunctSat'], material: 'solar_cell', massMin: 1800, massMax: 2700, sizeMin: 4.4, sizeMax: 5.0, tumbleDegS: 1.5,
      fwdMinM: 900,  fwdMaxM: 1100, latM: 190,  radM: -70,     // #4 catalogue Meteor 2-18 2,750 kg / 5 m
      owner: { name: 'Russia', status: 'owner', launchYear: 1989, notable: 'Defunct Soviet weather satellite.' },
      areaM2: 5.9 },    // cylinder 4.7 m x 1.4 m (body only)
    { name: 'Dead satellite (Vespa class)',       types: ['defunctSat'], material: 'mli_mylar', massMin: 100,  massMax: 250,  sizeMin: 2.0, sizeMax: 2.6, tumbleDegS: 6,
      fwdMinM: 1250, fwdMaxM: 1450, latM: -230, radM: 90,      // #5 catalogue Vespa 112 kg / 2.6 m
      owner: { name: 'ESA', status: 'owner', launchYear: 2012, notable: 'ESA has paid to have one of these removed (ClearSpace-1).' },
      areaM2: 2.0 },    // cone shell (frustum) 2.3 m base, 0.9 m top, 1.4 m tall (estimate)
    { name: 'Dead microsatellite (est.)',         types: ['defunctSat'], material: 'composite', massMin: 250,  massMax: 450,  sizeMin: 2.2, sizeMax: 2.6, tumbleDegS: 5,
      fwdMinM: 1650, fwdMaxM: 1850, latM: 280,  radM: -110,    // #6 a named estimate (no catalogue entry between 112 and 556 kg)
      owner: { name: 'its insurer', status: 'insurer', launchYear: 2006, notable: 'Its insurer paid out and owns it now.' },   // estimate
      areaM2: 3.6 },    // box 2.4 x 1.2 x 1.2 m
    { name: 'Dead small satellite (est.)',        types: ['defunctSat'], material: 'aluminum',  massMin: 50,   massMax: 120,  sizeMin: 1.4, sizeMax: 2.0, tumbleDegS: 8,
      fwdMinM: 2050, fwdMaxM: 2300, latM: -330, radM: 120,     // #7 a named estimate
      owner: { name: null, status: 'abandoned', launchYear: 2009, notable: 'Its company is gone.' },   // estimate; always set: an abandoned piece is still big
      areaM2: 1.9 },    // box 1.7 x 0.9 x 0.9 m
  ],
  // BIG_PIECES - what a big piece (a HIGH_FIELD stage or satellite: `owner` set) pays when it is DISPOSED OF, not at the catch (slice 5, lane 5a;
  // DECISIONS §33 row 16-17; BigPieceValues.js, OrbitLifetime.js). Estimates to tune. Metal in orbit is priced like her gas: the launch price
  // per kg (`IN_ORBIT_CR_PER_KG`, derived, never a literal). The anchor pays that plus the elevator contract's bonus per kg.
  BIG_PIECES: {
    TYPES: ['rocketBody', 'defunctSat'],                          // the types a big piece can be
    METAL_FRACTION: { rocketBody: 0.6, defunctSat: 0.45 },        // share of the mass that is scrap metal
    PARTS_FRACTION: { rocketBody: 0.05, defunctSat: 0.15 },       // share of the mass that is parts to reuse
    FEE_CR_PER_KG: 10,                                            // removal fee its owner pays, per kg, when it is gone within RULE_YEARS
    CONSENT_SHARE: 0.2,                                           // the owner's (or insurer's) share of what is sold or reused
    COLLECTOR: { EARLY_BEFORE_YEAR: 1975, EARLY_CR: 10000, MID_UNTIL_YEAR: 1989, MID_CR: 3000 },   // launched before 1975 / 1975-1989 / later: 0
    SAIL: { areaM2: 25, massKg: 9.5, priceCr: 1200 },             // drag sail: HPS ADEO-L class; price = launch mass 665 + 500 hardware (est.)
    RULE_YEARS: 25,                                               // IADC: out of orbit within 25 years
    PUSH_TARGET_YEARS: 24,                                        // a push aims at 24 years' life: a year's margin
    PUSH_STEP_KM: 5,                                              // the push height is floored to this step
    get IN_ORBIT_CR_PER_KG() { return Constants.LAUNCH_USD_PER_KG / Constants.USD_PER_CREDIT; },          // 70
    get ANCHOR_PREMIUM_CR_PER_KG() { return Constants.ELEVATOR_CONTRACT.BONUS_CREDITS_PER_KG; },           // 5: the anchor's bonus per kg
  },
  // BIG_MELT - melting a big piece for metal in the four radiator-tip furnaces, on the SHIP'S clock during trip burns (slice 5, lane 5e;
  // DECISIONS §33 rows 16-17: "4 furnaces, one on each radiator strut", "many hours or days of realtime to melt debris"; BigMelt.js). The
  // trip's days and the hold set the pace, not the delivery. Every number is an ESTIMATE to tune except where it says measured.
  BIG_MELT: {
    PACKED_KG_M3: 100,          // a cut part is folded wall sections packed to this density; sets the part size (BigMelt.PART_KG) and the bag's size
    REACH_LIMIT_M: 0.70,        // m: a part's drawn reach limit - a margin under the tip's 0.75 m fit (TipCargo MAX_BAG_R_M); its band row is 134 deg
    FURNACE_S_PER_KG: 1000,     // ship-seconds of furnace time per kg: about 1 kW at the focus (1.2 m2 mirror, 60 %) into an insulated crucible, about
                                //   1.0 MJ/kg to heat aluminium or steel from cold and melt it; a 63 kg part is about 18 h of furnace time. The dish size is
                                //   the owner's to set: this one constant
    DELIVERY_S: 1070,           // ship-seconds to take one part rack -> nose -> leash -> tip (measured: 59 + 48 real s at trip rate 1 = about 1,070 s at 10 ship-s per real s); one at a time
    TRIP_SUN: 0.6,              // share of the ship's time a furnace sits in sunlight (orbit average)
    METAL_ID: 'refined_orbit',  // the hold's id for melted metal: the 'refined_' prefix is what the elevator contract takes (ShopScreen)
    METAL_NAME: 'Orbit metal',
    METAL_COLOR: '#b9c4d2',
  },
  CATCH_MAX_SIDE_M: 5.5,    // m: no HIGH_FIELD piece is longer than this (the mother net's 6 m mouth less a margin)

  // The parked heavy spares (lane 4a, H2a): `DebrisField._generateDebris` builds ONE spare for every row of every high field (4 x 7 = 28),
  // of that row's type and material, after the live pool. A spare is parked out of play (not alive, not tracked, not drawn, not counted
  // in any total or mission) until a high field claims it; a stored, claimed or caught spare is parked again on a new run.
  // PARK_SIZE_M is the size a spare is built at: under the flag size (DEBRIS_VISUAL.FLAG_MIN_SIZE_M), so it never gets a flag overlay.
  // SEED_XOR keys the spares' own random stream off the boot seed (disjoint from the assembly's and the background's, so neither moves).
  HEAVY_SPARES: {
    PARK_SIZE_M: 0.5,
    SEED_XOR: 0x4EA77A5E,
    // u20-debris v2: more parked defunctSat bodies for the MISSION satellites (MISSION_SAT below), appended after the 28 so the high
    // fields' spares keep their ids and draws. A mission satellite claims from THIS pool only and a high field never takes one, so
    // neither can starve the other; a body whose piece has been cleared (removed from the sky) is parked again and claimable by the
    // next mission satellite (DebrisField._claimHeavySpare, pool 'mission'). The pool holds `Constants.missionPoolMaterials()` bodies:
    // one per field (the "absent" rule lets each field hold one uncaught mission satellite, so that many can be out at once) plus
    // MISSION_POOL_EXTRA for satellites caught and still on their way to credit (fix round 1, F3: the owner's "one dead satellite
    // every mission" must not run dry). Materials cycle through MISSION_POOL_CYCLE (the two the cast's satellites use).
    MISSION_POOL_CYCLE: ['mli_mylar', 'aluminum'],
    MISSION_POOL_EXTRA: 2,
  },

  // =========================================================================
  // SMALL_GROUP and MISSION_SAT - the small-piece group and the dead satellite of every mission from mission 4 on (lane u20-debris
  // v2, owner 2026-10-23/24, DECISIONS §38 rows 3 and 4; DebrisField.groupSpec / missionSatSpec / _spawnWelcomeField,
  // FieldRegistry; docs/research/2026-10-debris-sizes.md). Missions 1-3 are untouched (mission 1 is the training mission).
  // =========================================================================
  // A group is COUNT_MIN..COUNT_MAX pieces (the field's seed rolls the count) of SIZE_MIN_M..SIZE_MAX_M, every one inside a
  // flat disc of SPREAD_R_M radius (so any two are at most 2 x SPREAD_R_M = 2.8 m apart, under the 3 m a large daughter's net
  // scoops: BALL_M), laid out in her frame (along-track and cross-track offsets, the same radial height) so the cloud neither
  // drifts nor breathes past BALL_M: the pieces share her semi-major axis and the welcome field's drag rule. All numbers
  // are ESTIMATES to tune. Each piece and the satellite draw from their OWN seeded stream (field seed ^ SEED_XOR, the variant
  // and the row mixed in), never the global Math.random, so no other piece moves.
  // `variant` 0 is a low field's OWN group (f375-f450, its content in place of the welcome rows: nearer, OWN_*); variant 1 is
  // the group a mission adds to f350 or a high field (EXTRA_*: in the gap of both tables, 60-90 m from every other row).
  // Rows beyond a field's own table: EXTRA_ROW0 + i is the i-th piece of the extra group, SAT_ROW the extra satellite.
  SMALL_GROUP: {
    FROM_MISSION: 4,
    COUNT_MIN: 8,
    COUNT_MAX: 12,
    SIZE_MIN_M: 0.10,
    SIZE_MAX_M: 0.30,
    BALL_M: 3,
    SPREAD_R_M: 1.4,
    TUMBLE_MIN_DEG_S: 3,
    TUMBLE_MAX_DEG_S: 12,
    SEED_XOR: 0x6B0A57E1,
    OWN_FWD_MIN_M: 150, OWN_FWD_MAX_M: 260, OWN_LAT_M: 25,            // a low field's own group: centre ahead, lateral +-OWN_LAT_M/2
    EXTRA_FWD_MIN_M: 330, EXTRA_FWD_MAX_M: 370, EXTRA_LAT_MIN_M: 15, EXTRA_LAT_MAX_M: 25,
    EXTRA_ROW0: 200,
    SAT_ROW: 300,
  },

  // =========================================================================
  // PAIR_FIELDS - pieces laid out in pairs so a two-daughter shot comes up (owner 2026-10-25, DECISIONS §38 row 7; DebrisField.pairSpec,
  // FieldRegistry._addPairRows; docs/research/2026-10-debris-sizes.md)
  // =========================================================================
  // From mission FROM_MISSION on, the field she starts at gets PAIRS pairs of small fragments (rows ROW0 .. ROW0 + 2 x PAIRS - 1; row
  // ROW0 + 2p + m is member m of pair p), unless it still holds an uncaught one. Pair p is built for the struts of KINDS[p]: the two OPPOSITE
  // struts at ONE angle alpha (equal alpha = the two launch kicks cancel, a pair shot). Each piece sits on the launch line of its strut at
  // that alpha from the strut's tip, `range` m out, as she is at ARRIVAL (nose along track: ship x = left = -latM, ship y = up = radM, ship
  // z = ahead = fwdM; measured with js/test/_fieldsRig.js, which flies her the way a trip ends), so from there both lines hit their pieces
  // with no turn. A pair is "weaver-size" or "spinner-size" by the struts it is built for and the range it sits at: the weaver pair 420-620 m
  // out (a weaver's deploy range is 1,600 m), the spinner pair 135-200 m (a spinner's is 400 m). Every piece is a fragment of the group's
  // size law (<= 5 kg, so either net takes it); the weaver pair is the bigger. PF1.2 (review 10-25): the pieces drift against her while she
  // holds her attitude (the radial and cross-track offsets of a piece swing round once an orbit; 1 real s = 10 game s), and the swing is the
  // piece's offset off her track, 0.9 x range x sin(alpha): so alpha is 152-162 (weaver) and 160-168 (spinner), a spinner pair 135-200 m out.
  // The two daughters leave 24-62 deg apart (2 x asin(sin alpha)): apart, never parallel. MEASURED (tmp/rv/window.mjs, her nose forward /
  // nose backwards / rolled 30 deg, LVLH held, 9 fields): both pairs stay hittable (<= 10 deg after a turn of <= 30 deg, roll kept) for >= 180 s
  // real time (the old bands: 80-110 s on six fields). Own seeded stream (SEED_XOR), so no other piece moves; all numbers are ESTIMATES to tune.
  // HINGE_R_M / HINGE_Z_M are the strut hinge ring's radius and height in the ship frame (measured with strutTipMeters; test-PairFields
  // re-measures them against the live ship); the strut is OCTOPUS_V5.STRUT_LENGTH long.
  PAIR_FIELDS: {
    FROM_MISSION: 2,
    ROW0: 400,
    PAIRS: 2,
    SEED_XOR: 0x2D9A17C3,
    HINGE_R_M: 0.4,
    HINGE_Z_M: 1.0,
    RANGE_SPREAD: 0.08,        // each member's range is the pair's +-8 %, so the two pieces are not mirror images
    KINDS: [
      { name: 'weaver',  struts: [0, 2], alphaMin: 152, alphaMax: 162, rangeMin: 420, rangeMax: 620, sizeMin: 0.30, sizeMax: 0.50 },
      { name: 'spinner', struts: [1, 3], alphaMin: 160, alphaMax: 168, rangeMin: 135, rangeMax: 200, sizeMin: 0.10, sizeMax: 0.30 },
    ],
  },
  // The mission satellite: a dead satellite of the cast's own type (FOREGROUND_CAST: 120 kg / 2.2 m and 480 kg / 4.5 m), ONE roll
  // picks mass and size so a heavier one is a bigger one, put FWD_AFTER_GROUP_M beyond the group's centre and LAT_BESIDE_M to
  // the other side of her track (about 70 m from the group). A job for the mother's big net: 50-500 kg is over the 10 kg
  // net-only ceiling of mission 1 and at or under a daughter's 500 kg net cap.
  MISSION_SAT: {
    FROM_MISSION: 4,
    SIZE_MIN_M: 1.0, SIZE_MAX_M: 4.5,
    MASS_MIN_KG: 50, MASS_MAX_KG: 500,
    TUMBLE_MIN_DEG_S: 2, TUMBLE_MAX_DEG_S: 8,
    MATERIALS: ['mli_mylar', 'aluminum'],
    FWD_AFTER_GROUP_MIN_M: 45, FWD_AFTER_GROUP_MAX_M: 65, LAT_BESIDE_M: 45,
    SEED_XOR: 0x5A7E111E,
  },

  // =========================================================================
  // FIELDS - the debris fields, stacked by height in the start orbit's tilt and node (Nets step 3 slice 2b,
  // DECISIONS §33 row 6; js/systems/FieldRegistry.js, FEATURE_FLAGS.FIELDS_BY_HEIGHT)
  // =========================================================================
  // The start field (350 km, mission 1) is today's welcome field, unchanged. The four small fields above it follow row 6:
  // "small pieces at 350-450 km" in the SAME tilt and node as the start orbit (tilting costs 134 m/s per degree, research doc).
  // The START field holds PIECES pieces laid out like DebrisField's WELCOME_FIELD rows (3-10 kg fragments and a cubesat, the rows' own
  // masses); `seed` fixes the along-track rolls of the free rows, so the same field always looks the same.
  // u20-debris v2 (DECISIONS §38 row 4): each of the four other low fields holds ONE small-piece group (SMALL_GROUP: 8-12 pieces of
  // 0.10-0.30 m inside 3 m; the count is `smallGroupCount(seed)`) in place of the welcome rows, from its own seeded stream; and from
  // mission 4 on the mission adds to the field it starts at the extras SMALL_GROUP / MISSION_SAT describe (rows 200+ and 300).
  // Slice 4 (lane 4a): every field has a `kind`. `low` = the WELCOME_FIELD rows above (PIECES of them); `high` = the HIGH_FIELD rows
  // (one piece per row: HIGH_FIELD.length). A field with no `kind` is `low`. Four high fields at 750-900 km (row 6: "dead
  // satellites and rocket stages at 750-900 km"): 7 start + the four low groups (8-12 each: 8 to 12 x 4 = 32-48; 40 for the seeds as listed)
  // + 28 high = about 75 pieces (before the mission extras), and a run is won at 60 (WIN_DEBRIS_COUNT).
  // Heights, counts and seeds are ESTIMATES to tune (§33: "counts and prices are estimates to tune").
  FIELDS: {
    PIECES: 7,
    LIST: [
      { id: 'f350', altKm: 350, seed: 350, kind: 'low', start: true },
      { id: 'f375', altKm: 375, seed: 375, kind: 'low' },
      { id: 'f400', altKm: 400, seed: 400, kind: 'low' },
      { id: 'f425', altKm: 425, seed: 425, kind: 'low' },
      { id: 'f450', altKm: 450, seed: 450, kind: 'low' },
      { id: 'f750', altKm: 750, seed: 750, kind: 'high' },
      { id: 'f800', altKm: 800, seed: 800, kind: 'high' },
      { id: 'f850', altKm: 850, seed: 850, kind: 'high' },
      { id: 'f900', altKm: 900, seed: 900, kind: 'high' },
    ],
  },

  // =========================================================================
  // RESUPPLY - the resupply satellite (Nets step 3 slice 3, DECISIONS §33 rows 2, 7, 10; js/systems/FieldRegistry.js,
  // GameFlowManager; FEATURE_FLAGS.FIELDS_BY_HEIGHT)
  // =========================================================================
  // Row 7: "Resupply satellite about 150 km above the start fields (about 85 m/s): it berths the mother at her nose collar, its arm
  // swaps net cartridges, it pumps gas; all buying moves there." One satellite at 500 km (350 -> 500 km = 84.5 m/s, research doc
  // 2026-10-trips-by-height), in the start orbit's tilt and node like the fields. Slice 4 (lane 4a, H4) adds the second one at 825 km, in
  // the same tilt and node, between the 800 and 850 km high fields: the same place with the same buying (a trip from one to the other is
  // an ordinary trip by `planTo`). Both are listed here, in height order; every satellite reader goes through `FieldRegistry.satellites()`.
  // It is a PLACE, not a field: she is at a field or berthed at a satellite, and nothing is laid out while she is berthed.
  // CALL_CREDITS is row 7's "Stuck: call it to you for 1,000 credits" (slice 3 lane 3c: the "where next" list's call row,
  // GameFlowManager._callSatellite). CALL_DAYS_EST is an ESTIMATE, not a measurement: the days a called satellite takes when the
  // real trip profile to its height cannot be read (the thruster cannot fly it); 16 = the 350 -> 500 km trip's days with drag off
  // (research doc 2026-10-trips-by-height). The satellite's own thruster is not modelled; with a readable profile the row and the
  // wait use that profile's days.
  RESUPPLY: {
    SATS: [
      { id: 'sat500', altKm: 500, name: 'Resupply satellite' },
      { id: 'sat825', altKm: 825, name: 'Resupply satellite' },      // slice 4 (lane 4a, H4): the second, near the high fields
    ],
    CALL_CREDITS: 1000,
    CALL_DAYS_EST: 16,
  },

  // =========================================================================
  // RANGE_MAP - the orbital range map beside the "where next" list (range-map lane, owner 2026-10-25: "an orbital map to clearly
  // understand their range and choices with current fuel and salvage fuel"; "rings around Earth"; js/systems/RangeMapModel.js,
  // js/ui/RangeMap.js). Screens: a 16" MacBook (1728x1117) and a 13" iPad held sideways (about 1366x1024), DECISIONS §32.
  // =========================================================================
  // Where it sits (F1.1, 2026-10-25): the LEFT side, in the height column's place (the column yields while the map shows), below the top HUD
  // strip (about y 0-262), clear of the list (bottom centre: WhereNextList.js BOTTOM_PX, WIDTH_PX, TOP_CLEAR_PX; test-RangeMapModel pins these copies
  // to the list's own), the floor rail (right edge, mid-height: RAIL_*) and the footer band (REFIT tab, detail slider: top 164 px up). The open
  // drawer (left, z 35) may cover it: he opened it. The ring sizes are not to scale (rank of height, not kilometres) so eleven rings can be read:
  // EARTH_FRAC, BREAK_KM and BREAK_EXTRA set the look; the label box is an ESTIMATE of the drawn text (LABEL_CHAR_PX per mono character), the view
  // draws inside it.
  RANGE_MAP: {
    TOP_PX: 280,              // the map's top edge, below the top HUD strip
    LEFT_PX: 8,               // the left edge (the height column's own: HeightScale SIDE_MIN_PX)
    BOTTOM_PX: 172,           // the text lines end this far above the bottom: the footer band's top is 164 px up (RailGeometry.footerBand), 8 px air
    SIDE_CHOOSE_PX: 460,      // the biggest square while the list is open
    SIDE_TRIP_PX: 560,        // the list is closed during the trip: the map may grow
    MIN_SIDE_PX: 240,         // narrower than this the map is not shown
    LIST_BOTTOM_PX: 164,      // copies of the list's CSS (WhereNextList.js): bottom edge 164 px up,
    LIST_WIDTH_PX: 580,       // width min(580, 100vw - 24) at the bottom centre,
    LIST_SIDE_PX: 12,         // (the 12 of that 24, per side),
    LIST_TOP_CLEAR_PX: 280,   // and a height that never passes 100vh - 444, i.e. its top is never above y 280
    LIST_GAP_PX: 16,          // clear space between the map and the list
    RAIL_EDGE_PX: 16,         // the floor rail (RailIndicator): 16 px in from the right edge (RailGeometry EDGE_PX), mid-height,
    RAIL_W_PX: 140,           // about 135 px wide and 165 px tall (measured in the 10-25 shots at 1728x1117 and 1366x1024; rounded up);
    RAIL_H_PX: 170,           // the live left/bottom edges (leftPx(), bottomPx()) replace these when the rail is measured
    RAIL_GAP_PX: 12,          // clear space between the map and the rail
    TEXT_LINES: 5,            // the lines under the canvas, packed top-down (gas aboard, catches, her own moves, orbits, day), at most this many
    TEXT_LINE_PX: 15,         // one line's height
    TEXT_FONT_PX: 11,         // their font size (the mono token), so a line's width is characters x TEXT_CHAR_PX
    TEXT_CHAR_PX: 7.2,        // per character: at least TEXT_FONT_PX x B612 Mono's 0.65 em advance (pinned by test-RangeMapModel, like LABEL_CHAR_PX)
    TEXT_PAD_PX: 8,           // the text block's padding left and right (a line is clipped at the canvas width less this on both sides)
    TEXT_PX: 84,              // the text block under the canvas: 4 px air + TEXT_LINES x TEXT_LINE_PX + 5 px padding; the panel's room below its top edge is the screen less this
    PAD_PX: 4,                // between the outer ring's label and the canvas edge
    EARTH_FRAC: 0.16,         // the Earth disc's radius as a share of the outer ring (the rule: at least 0.15)
    RING_MAX_STEP_PX: 28,     // few rings: spacing stops growing here and the map shrinks to fit
    BREAK_KM: 100,            // a height gap this big between neighbouring rings is drawn as a visible break
    BREAK_EXTRA: 1.5,         // ... of this many extra ring spacings
    MIN_GAP_PX: 14,           // adjacent rings are at least this far apart from a 440 px side up (the Mac)
    MIN_GAP_SMALL_PX: 9,      // ... and at least this on the smaller iPad side
    GAP_SIDE_PX: 440,         // the side from which MIN_GAP_PX is asked
    LABEL_FONT_PX: 11,
    LABEL_H_PX: 14,
    LABEL_CHAR_PX: 7.2,       // the label box's width per character: at least LABEL_FONT_PX x B612 Mono's 0.65 em advance (Typeface.MONO_ADVANCE_EM), pinned by test-RangeMapModel
    LABEL_PAD_PX: 6,          // the box's padding left and right of the text
    HIT_MIN_PX: 12,           // a tap is a ring's when it lands within this (or half the local spacing, if more) of the ring
    DIM_RING_ALPHA: 0.5,      // trip mode: the rings that are neither hers nor the target are dimmed to this (F1.9: 0.35 left the labels unreadable in the shots),
    DIM_LABEL_ALPHA: 0.72,    // their labels to this
    UNFLOWN_ALPHA: 0.8,       // the part of her path not yet flown (F1.9: at 0.45 over its dark stroke it read as dark green)
    PATH_PX: 3.5,             // her path's line width (F1.4; the part flown is 1 px wider)
    ARROW_PX: 11,             // the arrowhead at the target end of her path
    SPIRAL_TURNS: 2,          // stylised turns drawn over the whole climb
    SPIRAL_POINTS: 240,       // the spiral's drawn points
    FADE_MS: 600,             // the map fades in when the trip is under way
    REDRAW_MS: 100,           // at most 10 redraws a second during a trip
    COLORS: {
      OK: 'rgba(140,220,255,0.95)',        // a ring she can reach
      GREY: 'rgba(150,160,170,0.55)',      // a ring she cannot reach (also dashed)
      CLEARED: 'rgba(120,130,140,0.35)',
      HERE: 'rgba(255,225,168,1)',         // her own ring (and her dot)
      FOCUS: '#4488ff',                    // the focused ring (VisualLaw.COLORS.SELECTION)
      REACH: 'rgba(0,204,255,0.24)',       // the reach band (F1.4: was 0.10, not told from the Earth's glow in the shots)
      REACH_EDGE: 'rgba(130,235,255,0.95)', // its firm outer edge, at the furthest ring she can reach
      REACH_EDGE_SOFT: 'rgba(130,235,255,0.45)', // and its inner edge
      EARTH: 'rgba(40,90,170,0.9)',
      SPIRAL: 'rgba(0,255,136,0.9)',       // her path
      TEXT: 'rgba(225,240,255,0.95)',
      TEXT_DIM: 'rgba(170,180,190,0.85)',
      BACK: 'rgba(0,16,32,0.92)',          // a ring label's own box (F1.3: no ring line crosses its text)
      BACKING: 'rgba(0,10,22,0.72)',       // behind the whole panel, canvas and text block (F1.3: rings and words read over the 3-D Earth)
      BACKING_EDGE: 'rgba(0,204,255,0.28)',
      PATH_UNDER: 'rgba(0,0,0,0.6)',       // a dark stroke under her path
    },
  },

  // =========================================================================
  // MISSIONS — ST-4.C Mission Spawn Difficulty Profiles
  // Each profile applies when missionNumber >= minMission (highest matching wins).
  // =========================================================================
  MISSIONS: {
    DEBRIS_PER_MISSION: 5,    // matches existing Math.floor(debrisCleared / 5) + 1
    // Wave 5 Session E — the chapter ceremony (docs/ladder/08-workbench.md §5
    // D3; numbers in docs/ladder/01-numbers.md "Depot and chapters"). Both
    // gate on Constants.LADDER.ENABLED — a ?ladder=0 boot keeps the shipped
    // catch → comms → 2500 ms → SHOP path byte-identical.
    // Owner ruling 2026-10-05 (docs/DECISIONS.md §14): after EVERY mission the depot
    // is an invitation — non-blocking, from chapter 1. false = no forced stop (the
    // boundary always takes GameFlowManager._openDepotInvitation); true restores the
    // old chapters-1..FORCED_DEPOT_CHAPTERS card → workbench stop. Ladder off ignores it.
    FORCED_DEPOT_STOP: false,
    FORCED_DEPOT_CHAPTERS: 3, // the GUIDED chapters 1..N (guidedCluster, per-catch progress line, boss hold rule); the end of each forces the depot stop ONLY when FORCED_DEPOT_STOP is true — otherwise every chapter's depot is an INVITATION
    COMPLETE_CARD_MS: 2500,   // "MISSION N COMPLETE" card → SHOP dwell (owner decision 1: a fixed dwell, the old silent timer's length); the card holds for this minus TEACHING.FADE_OUT_MS so it has faded when the depot opens
    START_AFTER_CATCH_MAX_S: 20, // game seconds: the longest the next mission waits, after a boundary catch that is parked at the nose, for that catch to leave it (c2-fifth-catch D2) — cap only; the catch leaving (hand-off done / digested / released) starts it sooner
    // RESEAT (M1 guidance T6, owner decision 2026-09-09): the welcome-cluster
    // re-seat safety net in DebrisField._reseatDriftedWelcome — GUIDED chapters
    // only (the guidedCluster profiles below). A welcomeSpawn piece that has
    // been farther than DIST_M from the mother for DWELL_S of REAL time (seen
    // far at every ~2 s scan across the dwell; back in range once resets it)
    // AND is not being approached (no AUTOPILOT_TARGET_LOCK on it, no daughter
    // flying to it) is put back on its cone-fan slot ahead of the ship. "Far AND
    // not being approached" is the whole gate: a piece the autopilot or a
    // daughter is closing on is never moved, however far. It is a teleport, so
    // it exists only because a player who cannot finish an early mission may
    // quit for good (root causes fixed by T1/T2/T4 — this catches the
    // unforeseen, e.g. a manual impulse). DIST_M sits well outside the 1.4 km
    // fan + its breathing and inside the 5 km AutoLock search; DWELL_S is
    // wall-clock (player-experience timer), not game time.
    RESEAT: { DIST_M: 3000, DWELL_S: 10 },
    // guidedCluster (M1 guidance, 2026-09-09): the GUIDED chapters are missions
    // 1–3 — the same FORCED_DEPOT_CHAPTERS boundary (profiles 'Orientation' +
    // 'First Operations'). In a guided chapter the welcome cluster is kept
    // findable: AutoLock falls back to the nearest piece ANYWHERE when the
    // forward arc is empty (AUTOLOCK.GUIDED_FALLBACK_ANY_ARC) and HOUSTON
    // posts a per-catch progress line (GameFlowManager); the re-seat safety
    // net (T6, DebrisField._reseatDriftedWelcome, RESEAT above) reads the same
    // flag via DebrisField.isGuidedChapter().
    // Owner rationale: a player who cannot finish an early mission may quit
    // for good; later missions have many small pieces and some will always
    // drift — accepted there, so it is false from mission 4 on. Explicit on
    // EVERY entry; readers treat a missing flag as false
    // (core/missionProgress.isGuidedChapterNumber, DebrisField.isGuidedChapter).
    PROFILES: [
      {
        minMission: 1,
        label: 'Orientation',
        guidedCluster: true,  // guided chapter (see the note above PROFILES)
        clusters: 1,          // nearby cluster count to guarantee
        hydrazine: false,     // exclude hydrazine from salvage
        conjunction: false,   // suppress conjunction events
        kessler: false,       // suppress Kessler cascade
        synergy: false,       // no synergy pairs forced
        untracked: 0,         // count of untracked (scan-reveal) debris
        weather: false,       // suppress weather events
        activeSats: false,    // no active satellite hazards
        collisionWarnings: false, // Phase 3: mission 1 is onboarding — suppress
                                  // the steady debris-proximity warning strip
      },
      {
        minMission: 2,
        label: 'First Operations',
        guidedCluster: true,  // guided chapter — covers missions 2 AND 3 (highest matching minMission wins)
        clusters: 2,
        hydrazine: true,      // tracked hydrazine tank allowed
        conjunction: false,
        kessler: false,
        synergy: false,
        untracked: 0,
        weather: false,
        activeSats: false,
        collisionWarnings: true, // steady-display collision warnings from mission 2
      },
      {
        minMission: 4,
        label: 'Expanding Field',
        guidedCluster: false, // past FORCED_DEPOT_CHAPTERS — pieces may drift; no guidance fallback
        clusters: 4,
        hydrazine: true,
        conjunction: false,
        kessler: false,
        synergy: true,        // 1 synergy pair forced
        untracked: 2,         // 2 scan-reveal untracked debris
        weather: false,
        activeSats: false,
        collisionWarnings: true,
      },
      {
        minMission: 7,
        label: 'Full Operations',
        guidedCluster: false,
        clusters: 6,
        hydrazine: true,
        conjunction: true,
        kessler: true,
        synergy: true,
        untracked: 4,
        weather: false,
        activeSats: false,
        collisionWarnings: true,
      },
      {
        minMission: 10,
        label: 'Unrestricted',
        guidedCluster: false,
        clusters: null,       // null = no limit, full random
        hydrazine: true,
        conjunction: true,
        kessler: true,
        synergy: true,
        untracked: null,      // null = random distribution
        weather: true,
        activeSats: true,
        collisionWarnings: true,
      },
    ],
  },

  // =========================================================================
  // MISSION EVENTS — ST-4.D Dynamic Mid-Mission Event System
  // =========================================================================
  MISSION_EVENTS: {
    COOLDOWN_MS: 30000,                         // minimum 30s between repeated events of same type
    SYNERGY_TIMER_MS: 300000,                   // 5 minutes for synergy opportunity window
    CONJUNCTION_ACCUMULATION_WINDOW_MS: 60000,  // 1 min window for counting conjunctions
    MIN_CONJUNCTION_ALERTS: 2,                  // number of warnings needed for cluster conjunction
    HYDRAZINE_BONUS_POINTS: 500,                // points awarded for hydrazine hazard discovery
  },

  // =========================================================================
  // CH5 ISS CONJUNCTION BOSS — MISSION_ARC_IMPLEMENTATION.md §6
  //
  // The "protect-the-asset" boss. On SHOP_DEPLOY into mission 5, spawn FRAG_COUNT
  // Cosmos-1408 fragments in the ISS forward track and start a TCA_HOURS game-time
  // countdown. Outcomes (emergent from play — no modal):
  //   • Intercept: clear all frags before TCA → +INTERCEPT_BONUS_KG + credits + SAVER codex
  //   • Decline:   clear none (or ISS_BOSS_DECLINE) → ISS autonomous reboost, PDAM codex, no penalty
  //   • Miss:      cleared ≥1 but not all by TCA → ISS reboosts, HYDRAZINE codex, bonus lost
  //                (the frags they DID clear still score normally via the capture flow)
  // =========================================================================
  ISS_BOSS: {
    MISSION: 5,                       // chapter / mission number that triggers the boss
    FRAG_COUNT: 6,                    // Cosmos-1408 threat fragments to clear
    TCA_HOURS: 38,                    // game-time hours until closest approach
    IMMINENT_HOURS: 4,               // final-warning threshold (game-time hours remaining)
    INTERCEPT_BONUS_KG: 200,          // elevator-contract mass awarded on a full intercept
    INTERCEPT_BONUS_CREDITS: 500,     // credits awarded on a full intercept
    PERSISTENCE_KEY: 'spacecowboy_iss_boss_v1',
    CODEX: { SAVER: 'iss_saver', PDAM: 'iss_pdam', HYDRAZINE: 'iss_hydrazine_burn' },
    // ISS forward-track orbit the threat frags are spawned into (NORAD 25544 ≈).
    ORBIT: {
      altKm: 408,
      incDeg: 51.6,
      raanDeg: 123.4,
      argPerigeeDeg: 45,
      eccentricity: 0.0003,
      fragMassKg: 45,                 // per-fragment mass
      trackSpreadDeg: 8,              // true-anomaly spread ahead of the lead frag
    },
  },

  // =========================================================================
  // CH9 STARLINK FRAGMENTATION BOSS — MISSION_ARC §6
  //
  // The "race-the-cascade" boss. On SHOP_DEPLOY into mission 9, burst-spawn
  // FRAG_COUNT Starlink fragments and start a WINDOW_MIN game-time timer. The
  // tension (a Kessler cascade) is narrative comms — the boss does NOT force a
  // KesslerSystem game-over (decline/failure is never a hard punishment, §9).
  // Outcomes (emergent from play):
  //   • Contained: clear all frags before the window → +CONTAIN_BONUS_KG + credits + CONTAINED codex
  //   • Partial:   clear ≥ PARTIAL_FRACTION by the window → reduced credit, no codex penalty
  //   • Cascade:   clear < PARTIAL_FRACTION by the window → CASCADE codex, bonus lost
  // =========================================================================
  STARLINK_BOSS: {
    MISSION: 9,
    FRAG_COUNT: 35,                   // fragments burst-spawned
    WINDOW_MIN: 5,                    // game-time minutes to contain
    IMMINENT_MIN: 1,                  // final-warning threshold (minutes remaining)
    CONTAIN_BONUS_KG: 300,            // elevator mass on a full containment
    CONTAIN_BONUS_CREDITS: 750,       // credits on a full containment
    PARTIAL_CREDITS: 250,             // credits on a partial containment
    PARTIAL_FRACTION: 0.6,            // ≥60% cleared by the window = partial (else cascade)
    PERSISTENCE_KEY: 'spacecowboy_starlink_boss_v1',
    CODEX: { CONTAINED: 'starlink_contained', CASCADE: 'starlink_cascade' },
    // Starlink shell orbit the fragments are spawned into (~550 km / 53°).
    ORBIT: {
      altKm: 550,
      incDeg: 53,
      raanDeg: 80,
      argPerigeeDeg: 0,
      eccentricity: 0.0001,
      fragMassKg: 12,                 // small Starlink-frag mass
      trackSpreadDeg: 45,             // wider spread — a fragmentation cloud, not a string
    },
  },

  // === COMMS SYSTEM (ST-5.1) ===
  COMMS: {
    CHANNELS: ['CMD', 'ALERT', 'HOUSTON', 'SCI', 'FLAVOR', 'MISSION'],
    CHANNEL_COLORS: {
      CMD: '#ffaa00',
      ALERT: '#ff4444',
      HOUSTON: '#88ffcc',
      SCI: '#00ccff',
      FLAVOR: '#888888',
      MISSION: '#ffd700',
    },
    DEFAULT_CHANNEL: 'FLAVOR',
    COALESCE_THRESHOLD_COUNT: 3,
    COALESCE_WINDOW_MS: 2000,
    // CP-4 guidance arbiter — graduated post-onboarding suppression ramp (s of play).
    // Tier 1 (0→TIER2) HOUSTON+MISSION only · Tier 2 (→TIER3) +ALERT+CMD · Tier 3 all.
    SUPPRESSION_RAMP: { TIER2_AFTER_S: 30, TIER3_AFTER_S: 60 },
    // q3-mother-pane D3: the 'line' step's height is MOTHER's collapsed height (VITALS_COLLAPSED_HEIGHT_PX, js/ui/hud/VitalsPane.js —
    // Constants must not import UI); it shows PANE_LINES_MIN messages (≥1 full message always visible).
    // rev 3 — the right arm's top follows it; 144/300 on demand
    PANE_STEP_DEFAULT: 'line',
    PANE_HEIGHT_PX: 144,
    PANE_WIDTH_PX: 480,                   // fits ~70 chars per line (UX-2 #11)
    PANE_LINES_MIN: 2,                    // 'line' step message count (2 → at least one full message visible)
    PANE_LINES_DEFAULT: 4,                // collapsed line count (UX-2 #11)
    PANE_LINES_EXPANDED: 10,              // expanded line count (UX-2 #10)
    PANE_EXPAND_HEIGHT_PX: 300,
    PANE_EXPAND_HOLD_MS: 3000,
    // comms-min-show (owner 2026-10-20, "Each stays 3 seconds"): the pane shows messages one at a time - a new one
    // replaces the newest row only after the last one has been on screen PANE_MIN_SHOW_S seconds; warnings jump the
    // queue. At most PANE_QUEUE_MAX messages wait; past that the oldest waiting one is skipped (it stays in the log).
    PANE_MIN_SHOW_S: 3,
    PANE_QUEUE_MAX: 4,
    STRIPE_WIDTH_PX: 3,
    // (UX-11 #9: C_HOLD_THRESHOLD_MS / C_TAP_MAX_MS / RADIAL_* removed with
    // the C-hold radial menu — C acts on keydown with zero delay.)
  },

  // ============================================================================
  // ST-6.6: TECHNOLOGY READINESS LEVEL (TRL) — NASA scale 1–9
  // Used for colour-coded badges on Codex entries, Shop upgrades, and the
  // active-tool indicator. Display-only metadata — NEVER used for gating.
  // See BIG_PICTURE.md §25 for TRL rationale and V5 composition baseline.
  // ============================================================================
  TRL: {
    // --- Tier threshold levels ---
    FLIGHT_PROVEN_MIN: 9,      // exactly TRL 9 → flight-proven
    MATURE_MIN:        7,      // TRL 7–8 → mature
    RESEARCH_MIN:      4,      // TRL 4–6 → research
    SPECULATIVE_MIN:   1,      // TRL 1–3 → speculative

    // --- Badge colours ---
    COLOR_FLIGHT_PROVEN: '#22dd44', // green   — TRL 9
    COLOR_MATURE:        '#ddcc00', // yellow  — TRL 7–8
    COLOR_RESEARCH:      '#ff9900', // amber   — TRL 4–6
    COLOR_SPECULATIVE:   '#ff3344', // red     — TRL 1–3

    // --- Label strings for tooltips / screen readers ---
    LABEL_FLIGHT_PROVEN: 'Flight-proven',
    LABEL_MATURE:        'Mature',
    LABEL_RESEARCH:      'Research',
    LABEL_SPECULATIVE:   'Speculative',

    // --- Validation range ---
    MIN_VALID: 1,
    MAX_VALID: 9,
  },

  // ============================================================================
  // ST-6.1: OFFLINE CATALOGUE (CatalogLoader paths + timeouts)
  // Paths are relative to index.html; loader issues parallel fetches from META.
  // ============================================================================
  CATALOG: {
    BASE_PATH: './data/',
    META_FILE: 'META.json',
    LOAD_TIMEOUT_MS: 10000,
    MAX_PARALLEL_FETCHES: 8,
  },

  // ============================================================================
  // ST-6.1: DEBRIS FIELD ALTITUDE BANDS (7-band layout — VLEO + MEO added)
  // Weights sum to ~1.0. Shared by interactive debris + background Points.
  // Real catalogue entries predominantly occupy VLEO (ISS-class), LEO, and MEO.
  // ============================================================================
  DEBRIS: {
    INTERACTIVE_COUNT: 800,
    BACKGROUND_COUNT: 5000,
    // S11(a) — a field is ONE orbital regime (plan 1786401864178-cargo-continuity
    // S11; register item 38). The interactive field is assembled inside the
    // player's start plane: altitude = the containing ALT_BANDS cell below,
    // inclination/RAAN = the start orbit ± these half-widths. ±0.5° keeps the
    // worst-case pairwise plane difference ≈ 1° (~135 m/s at VLEO) — neighbours,
    // not the km/s strangers the owner ruled out ("objects in different planes
    // are not in the same field"). Catalogue admission filters on alt+inc ONLY:
    // real entries keep their real RAANs (the Zenit shell's RAANs really are
    // spread 60° apart — measured in data/debris-catalog.json).
    FIELD_REGIME: {
      INC_TOL_DEG: 0.5,
      RAAN_TOL_DEG: 0.5,
    },
    // S11(b) — TWO POPULATIONS, TWO RULES (plan 1786401864178-cargo-continuity
    // §5 S11 piece (b)). The field = a dense power-law BACKGROUND/HAZARD cloud
    // (numerous, uncapturable, feeds ConjunctionSystem + the look of the sky)
    // + exactly DEBRIS_PER_MISSION authored FOREGROUND targets with a
    // three-act shape (owner: "the first mission needs a beginning, middle,
    // end… the whale as act three, not as 24 % of the furniture").
    //
    // The hazard cloud's fragment SIZES follow the NASA Standard Breakup
    // Model cumulative count law N(≥Lc) ∝ Lc^−LAMBDA (collision 1.71 /
    // explosion 1.6; characteristic length Lc). Range is sub-half-metre
    // shards: honestly uncapturable (no net weave or grapple engages them) —
    // that is what makes the cloud furniture and a collision hazard, not a
    // target list. The mass LAW for interactive debris shipped in S11(c)
    // (MASS_LAW below; register item 39 CLOSED).
    //
    // u20-debris (owner 2026-10-23, DECISIONS §38 row 1: "the background cloud becomes mostly 2–10 cm pieces, as in real space;
    // only pieces over 10 cm count as known to radar. Nothing new to catch, the sky looks the same"): from mission
    // LATER_FROM_MISSION the shards span SIZE_MIN_M–SIZE_MAX_M (2–50 cm) and a shard is `tracked` iff it is TRACKED_MIN_M or
    // bigger (ESA/NASA: radar follows pieces from about 10 cm; research doc 2026-10-debris-sizes §2). Mission 1 is left alone
    // (§38 rows 1 and 4): its cloud keeps the old 0.10–0.50 m edge (FIRST_SIZE_MIN_M), all untracked, and so does the sky's
    // dot cloud (DOT_SIZE_MIN_M: the dots' look is unchanged). Both laws read the SAME seeded draw, so the stream never moves.
    // MASS_MIN_KG: the mass floor of a background shard (fragment massMin 0.01 kg is shared with the mission targets and
    // stays); a 2 cm shard follows the mass law, about 0.002 kg.
    HAZARD_CLOUD: {
      LAMBDA: 1.71,          // SBM collision exponent (explosion: 1.6 — the band is [1.6, 1.71])
      SIZE_MIN_M: 0.02,      // m — lower edge of the shard cloud from mission LATER_FROM_MISSION (real: mostly 2–10 cm)
      SIZE_MAX_M: 0.5,       // m — upper edge (sub-half-metre ⇒ uncapturable-class)
      FIRST_SIZE_MIN_M: 0.1, // m — lower edge in mission 1 (unchanged: DECISIONS §38 rows 1 and 4)
      DOT_SIZE_MIN_M: 0.1,   // m — the 5000 sky dots' size mapping keeps today's edge (the sky looks the same)
      LATER_FROM_MISSION: 2, // the shard law above applies from this mission on
      TRACKED_MIN_M: 0.1,    // m — a shard of this size or bigger is tracked (known to radar); smaller is not
      MASS_MIN_KG: 0.0001,   // kg — floor of a background shard's mass from mission LATER_FROM_MISSION (the law gives ≈0.002 kg at 2 cm)
    },
    // S11(c) — THE MASS LAW (plan 1786401864178-cargo-continuity §5 S11 piece
    // (c); register item 39). NASA Standard Breakup Model (Johnson et al. 2001,
    // "NASA's New Breakup Model of EVOLVE 4.0", Adv. Space Res. 28(9):1377):
    //   • cross-sectional area from characteristic length: A = AREA_COEF·Lc^AREA_EXP
    //     (the SBM's Lc↔A relation, Lc = (A/AREA_COEF)^(1/AREA_EXP));
    //   • area-to-mass ratio χ = log10(A/M [m²/kg]) log-normal — collision
    //     fragments in the shard regime carry μ = −0.9, σ = 0.45 (the SOCIT/
    //     on-orbit collision fit; the <8 cm explosion fit is size-dependent and
    //     deliberately not modelled — the cloud is a collision-fragment population);
    //   • hazard mass = A / 10^χ (CatalogConverter.sampleSbmMassKg — size is
    //     drawn first, mass DERIVES; the measured cumulative mass exponent lands
    //     ≈0.6 over the cloud's range, inside the SBM band 0.6–0.85 — the
    //     log-normal scatter flattens the λ/AREA_EXP ≈ 0.853 asymptote).
    // MASS_CUM_EXP is the interactive fragment/missionDebris draw's cumulative
    // mass exponent N(≥m) ∝ m^−MASS_CUM_EXP (inverse-CDF, same clamped discipline
    // as samplePowerLawSize): the collision asymptote λ/AREA_EXP = 1.71/2.0047
    // ≈ 0.853. Intact bodies are NOT a power law — they are launch history and
    // draw from the catalogue's real masses (CatalogConverter.buildIntactMassPools).
    MASS_LAW: {
      AREA_COEF: 0.556945,   // m² — SBM area–length coefficient
      AREA_EXP: 2.0047,      // SBM area–length exponent
      AM_LOG10_MEAN: -0.9,   // μ of log10(A/M [m²/kg]) — collision fragments
      AM_LOG10_SIGMA: 0.45,  // σ of log10(A/M [m²/kg]) — collision fragments
      MASS_CUM_EXP: 0.85,    // cumulative mass exponent, interactive fragment draw
    },
    // The authored foreground cast — exactly MISSIONS.DEBRIS_PER_MISSION rows
    // (drift-guarded in test-DebrisFieldPopulations.js), in engagement order:
    //   act 1 — one easy warm-up: small, slow, every tool works.
    //   act 2 — three pieces that demand the tools and a decision.
    //   act 3 — the finale: the intact body (mother-net only; the ONE member
    //           over TOOL_RECOMMENDATION.MOTHER_MIN_MASS).
    // Mass/size/tumble are AUTHORED (not drawn) — this is the only place
    // S11(b) reshapes type/mass/material; orbits are still the seeded
    // in-regime draw from DebrisField. A real in-band catalogue whale
    // (> MOTHER_MIN_MASS) substitutes the act-3 row when one exists
    // (buildRegimeDebrisSeeds owns the pick; the start regime has none —
    // register item 51 — so the production cast is all-procedural today).
    // altKm is authored ONLY where gate-critical (see row 4's note); every
    // other orbit element stays the seeded in-band draw.
    FOREGROUND_CAST: [
      { act: 1, type: 'missionDebris', massKg: 1.5, sizeM: 0.35, tumbleDeg: 4, material: 'composite',
        note: 'warm-up — slow small operational debris; lasso/spinner/daughter all work' },
      { act: 2, type: 'defunctSat', massKg: 120, sizeM: 2.2, tumbleDeg: 45, material: 'mli_mylar',
        note: 'the fast tumbler — de-spin [L] first, or take poor net odds (NET_TUMBLE_PENALTY)' },
      { act: 2, type: 'defunctSat', massKg: 480, sizeM: 4.5, tumbleDeg: 8, material: 'aluminum',
        note: 'at the daughter cap (500 kg) — the haul decision: ties a daughter up, pays well' },
      { act: 2, type: 'cubesat', massKg: 6, sizeM: 0.45, tumbleDeg: 12, material: 'aluminum', altKm: 250,
        note: 'small intact microsat — the precision catch. altKm pinned FAR (never within 3 km of the 350 km start) so the M1 welcome cluster row #7 always finds a cubesat mesh slot — the dev net scenario stages its whale on that slot (gate-critical)' },
      { act: 3, type: 'rocketBody', massKg: 1600, sizeM: 8, tumbleDeg: 15, material: 'aluminum',
        note: 'the finale — the intact body; mother-net only, end-on aspect lesson, under the S7 transfer mass gate (2000 kg) so the cargo chain works on it' },
    ],
    ALT_BANDS: [
      { label: 'VLEO',     min:   180, max:  400, weight: 0.12 },  // ISS, Tiangong, early-reentry debris
      { label: 'LEO-low',  min:   400, max:  600, weight: 0.14 },  // Sentinel, Hubble, Starlink
      { label: 'LEO-mid',  min:   600, max:  900, weight: 0.26 },  // Fengyun-1C, Iridium-33, dense debris belt
      { label: 'LEO-high', min:   900, max: 1200, weight: 0.18 },  // Cosmos constellations
      { label: 'LEO-top',  min:  1200, max: 2000, weight: 0.12 },  // Globalstar, legacy military
      { label: 'MEO',      min:  2000, max:21000, weight: 0.12 },  // GPS, GLONASS, Galileo, BeiDou
      { label: 'GEO',      min: 33000, max:36000, weight: 0.06 },  // GEO graveyard, GOES, comms sats
    ],
  },

  // ============================================================================
  // ST-6.2: DEBRIS VISUAL — Type texture atlas + Flag decal atlas constants
  // Procedural Canvas2D textures; no external image files.
  // ============================================================================
  DEBRIS_VISUAL: {
    ATLAS_SIZE: 2048,           // px; type texture atlas dimension (2048 = crisp surface detail on close approach)
    FLAG_ATLAS_SIZE: 1024,      // px; flag decal atlas dimension (1024 = crisp decals up close)
    FLAG_SLOT_SIZE: 256,        // px per flag slot in atlas
    TYPE_SLOT_COLS: 3,          // atlas grid layout columns
    TYPE_SLOT_ROWS: 2,          // atlas grid layout rows
    FLAG_SLOT_COLS: 4,          // flag atlas grid columns
    FLAG_SLOT_ROWS: 4,          // flag atlas grid rows

    // Type base colours (hex strings)
    COLOR_DEBRIS:      '#666666',
    COLOR_ROCKET_BODY: '#aaaabb',
    COLOR_INACTIVE:    '#333366',
    COLOR_ACTIVE:      '#eeeeff',
    COLOR_UNKNOWN:     '#665544',
    COLOR_FRAGMENT:    '#333333',

    // MOID emissive glow intensities
    EMISSIVE_HI_INTENSITY: 0.3,
    EMISSIVE_MD_INTENSITY: 0.15,

    // Wireframe / textured toggle
    DEFAULT_MODE: 'textured',   // 'textured' | 'wireframe'

    // Item 12 (2026-06-12): flag decal gating + physical sizing.
    // Flags are SIZE-gated: any object at least this wide carries a national
    // marking (rocket bodies, defunct sats, and large derelict satellites the
    // catalog tags "debris"). Small operational debris (missionDebris) and
    // sub-threshold fragments never get flags:
    FLAG_MIN_SIZE_M: 2,         // m — fragments/small junk never get flags
    // Decal width = clamp(sizeMeter × FACTOR, MIN..MAX) metres (was a fixed
    // 0.7-local-unit plane that read tiny on an 8 m rocket body):
    FLAG_SIZE_FACTOR: 0.12,
    FLAG_DECAL_MIN_M: 0.4,
    FLAG_DECAL_MAX_M: 1.6,
  },

  // ============================================================================
  // ST-6.5: TEACHING SYSTEM — First-encounter contextual overlays
  // Non-blocking, show-once teaching moments triggered by game events.
  // ============================================================================
  TEACHING: {
    OVERLAY_WIDTH_PX: 400,
    OVERLAY_MIN_WIDTH_PX: 280,
    OVERLAY_TOP_MARGIN_PX: 20,
    // u13-polish D1 (screens at least OVERLAY_WIDE_MIN_PX wide; narrower = phones, frozen, keep the 20 px margin):
    // the card sits OVERLAY_GAP_PX below the lowest of the score strip, the line under it, the collision warning and
    // the autopilot badge (drawn on the canvas at y 92 + 19 = 111, js/ui/TargetReticle.js AP_BADGE_TOP_PX). The strip fallback is used only when the strip's element
    // is not in the page: top 8 + 28 tall, times the HUD scale (--hud-scale 1.25 on big screens).
    OVERLAY_WIDE_MIN_PX: 920,
    OVERLAY_GAP_PX: 8,
    OVERLAY_STRIP_TOP_PX: 8,
    OVERLAY_STRIP_H_PX: 28,
    OVERLAY_AP_BADGE_BOTTOM_PX: 111,
    OVERLAY_BG: 'rgba(0, 10, 20, 0.85)',
    OVERLAY_BORDER_COLOR: '#00ccff',
    OVERLAY_TITLE_COLOR: '#00ccff',
    OVERLAY_BODY_COLOR: '#ccddee',
    FADE_IN_MS: 300,
    FADE_OUT_MS: 500,
    MAX_QUEUE_DEPTH: 3,
    DEFAULT_DURATION_MS: 7000,
    PERSISTENCE_KEY: 'teachingSeen',
    QUEUE_DRAIN_INTERVAL_S: 6,   // CP-4 §4 — drain queued overlays at ≤1 per this many seconds
    TOTAL_MOMENTS: 29,           // UX-3 N1: +first_scan/first_arm_deploy; +first_net_failed/first_tether_snap; Phase 0.6: +first_high_tumble_target/first_despin_in_spec; Phase 1.5: +first_detail_scan; Phase 2: +first_aspect_target; Phase 3b: +first_fragmentation; Net ladder: +first_small_daughter_deploy/first_large_daughter_deploy/first_whale_target/first_deltav_waste; cargo-continuity S4: +first_net_park; item 100 (2026-08-21): +speed_dial (29→30); t6: -the strategic-map moment (30→29)
  },

  // ============================================================================
  // ZOOM LADDER (M0 — docs/ladder/00-spec.md)
  // Master switches only. Deliberately NOT in FEATURE_FLAGS (test-Constants.js
  // pins that object at exactly 43 entries) — named block per the
  // TEACHING/ONBOARDING precedent. Floor data lives in js/core/FloorContract.js
  // (pure data, validated by js/test/test-FloorContract.js); visual rules in
  // js/core/VisualLaw.js.
  // ============================================================================
  LADDER: {
    ENABLED: true,           // master switch — ON since 2026-09-02 (owner decision, early M6 flip; docs/ladder/03-plan.md); ?ladder=0 forces off for this boot (A/B), ?ladder=1 is now a no-op
    DEV_FULL_ACCESS: true,   // INERT since the Session H renumber: no shipping floor carries entryRequiresDock (03-plan Session H FINDINGS (d)); the ZoomLadder gate mechanism stays live for the M6 campaign-gating roadmap
    INVERT_SCROLL: false,    // S2 WheelRouter: invert scroll direction (00-spec §4 "an invert setting exists")
    COPILOT_VOICE: false,    // owner 2026-09-08 rev 3: the Autopilot voice is off by default; a constant, not a setting
  },

  // ============================================================================
  // MISSION COACH (CP-4 — MISSION_ARC_IMPLEMENTATION.md §2)
  //
  // The per-chapter coaching engine. Triggers on SHOP_DEPLOY into a mission,
  // runs that mission's beat table on top of the guidance arbiter (every beat's
  // comms is `_postOnboarding`-tagged; interactive beats emit MISSION_BEAT_*).
  // A chapter is DATA, not code: add/split chapters by editing BEATS_BY_MISSION.
  // Chapter 1 is owned by OnboardingDirector, not MissionCoach.
  // ============================================================================
  MISSION_COACH: {
    PERSISTENCE_KEY: 'spacecowboy_mission_coach_v1',
    NARRATIVE_HOLD_MS: 5000,   // narrative beat dwell before auto-advancing
    ESCALATE_MS: 22000,        // interactive beat → re-prompt (TEACHING_MOMENT_FORCE) after this idle
    /**
     * Per-mission beat tables. Each beat:
     *   { id, type:'narrative'|'interactive'|'reactive', text, source?, channel?,
     *     skillId?, triggerEvent? (Events key), triggerFilter?(data)=>bool,
     *     holdMs?, escalateMs?, title?, body? (escalation overlay),
     *     mapText? (lane 3d: the words when fields by height is on and the LEO map is there to ask on; `{km}` = the height of the
     *     field she is at, read by MissionCoach from the field registry; absent or no registry = `text`, exactly as before) }
     */
    BEATS_BY_MISSION: {
      // ── Chapter 2 — First Operations: Daughter piloting ──
      2: [
        {
          id: 'ch2_intro',
          type: 'narrative',
          source: 'BANGALORE',
          text: 'ISRO Bangalore here. Good to have a second set of eyes. Your daughter craft can do the close work. Take manual control and you\'ll capture heavier debris than autopilot ever could.',
          mapText: 'ISRO Bangalore here. You\'re at the {km} km field. Your daughter craft can do the close work: take manual control and you\'ll capture heavier debris than autopilot ever could. Low on nets or gas? Fly to the resupply satellite.',
        },
        {
          id: 'ch2_pilot',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Deploy a daughter (D), then press 1-4 to pilot her directly. On station you\'ll see the live capture odds strip. Every tool, every %.',
          skillId: 'arm_pilot',
          triggerEvent: 'CONTROL_MODE_CHANGE',
          triggerFilter: (d) => d && d.mode === 'ARM_PILOT',
          title: 'PILOT YOUR DAUGHTER',
          body: 'Press 1-4 while a daughter is deployed to fly her yourself.',
        },
        {
          id: 'ch2_manual_capture',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Line up on a target and capture by hand (N). Manual catches score double. Watch the odds strip: de-spin (L) or close in and the % climbs before you commit.',
          skillId: 'arm_pilot_capture',
          triggerEvent: 'ARM_CAPTURED',
          triggerFilter: (d) => d && d.manual === true,
          title: 'MANUAL CAPTURE',
          body: 'Close on a target under manual pilot and press N to net it for 2× score.',
        },
      ],

      // ── Chapter 3 — Sensor Trade: Wide Scan + the Codex (any field with the map on; LEO-Low 400 km without) ──
      3: [
        {
          id: 'ch3_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'You\'re climbing into the LEO-Low traffic lanes. And the ISS tracks through here on 51.6°. Quick pings won\'t reach the far contacts. Trade dwell time for range with a wide scan.',
          mapText: 'You\'re at the {km} km field. Quick pings won\'t reach the far contacts. Trade dwell time for range with a wide scan. Every trip costs gas and days: the LEO map shows both.',
        },
        {
          id: 'ch3_wide_scan',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Press Shift+S for a wide-aperture deep scan. Slower, but it paints debris your quick ping (S) can\'t see.',
          skillId: 'scan_wide',
          triggerEvent: 'SCAN_WIDE',
          title: 'WIDE SCAN',
          body: 'Press Shift+S to run a wide-aperture scan and reveal distant contacts.',
        },
        {
          id: 'ch3_codex',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'New contacts logged to SPECS. Press I to open Info. Know what you\'re grabbing before you commit fuel to it.',
          skillId: 'manage_codex',
          triggerEvent: 'CODEX_OPENED',
          title: 'THE CODEX',
          body: 'Press I to open Info and read up on a contact.',
        },
      ],

      // ── Chapter 4 — Cargo Discipline: cluster/transfer agency (CP-3) ──
      4: [
        {
          id: 'ch4_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'Debris travels in clusters, and space is periodic. A transfer window opens, then closes, then comes around again. Stop chasing one fragment at a time. Plan the whole sweep.',
        },
        {
          id: 'ch4_map',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Zoom out to LEO. The best cluster is picked for you; click another to change it, then press Space to fly the transfer. The launch window shows when it is cheapest.',
          skillId: 'strategic_map',
          triggerEvent: 'DEBRIS_MAP_CLUSTER_SELECTED',
          title: 'TRANSFER MAP',
          body: 'Zoom out to LEO (Esc), pick a cluster, press Space to fly to it.',
        },
      ],

      // ── Chapter 5 is the ISS conjunction boss (IssConjunctionBoss.js / Constants.ISS_BOSS);
      //    these beats teach the manual burn timing the intercept needs. The boss
      //    system owns the spawn, TCA countdown, choice resolution + codex/awards. ──
      5: [
        {
          id: 'ch5_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'Cowboy, we have a situation. A Cosmos-1408 fragment cloud is converging on the ISS. 51.6° inclination, closest approach in 38 hours. There are people aboard that station. You can clear the threat, or we let CSA dodge it on the station\'s own thrusters. Your call.',
        },
        {
          id: 'ch5_burn',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Reaching them in time takes precise timing. Trim your closing rate on the throttle (+/-) to nail the intercept window.',
          skillId: 'nav_throttle',
          triggerEvent: 'THROTTLE_CHANGE',
          title: 'BURN TIMING',
          body: 'Use + / - to throttle and time your intercept burn on the ISS threat frags.',
        },
      ],

      // ── Chapter 6 — Salvage is fuel: indium, xenon and metals from catches ──
      6: [
        {
          id: 'ch6_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'That cargo isn\'t just mass for the elevator. Salvage feeds you: indium refuels the daughters, xenon tops up the engine, and metals ride in the hold to the next resupply stop.',
        },
        {
          id: 'ch6_forge',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Catch a piece that carries metal and watch comms: it goes straight into the hold.',
          skillId: 'collect_salvage',
          triggerEvent: 'CARGO_STORE',
          triggerFilter: (d) => typeof d?.metalId === 'string',
          title: 'SALVAGE',
          body: 'Catch a metal-bearing piece; its metal is stored in the hold.',
        },
      ],

      // ── Chapter 7 — Inclination Tax: plane-change ΔV, clear a whole cluster (SSO 98°) ──
      7: [
        {
          id: 'ch7_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'Sun-synch orbit, 98° retrograde. Plane changes up here are brutally expensive. Every degree of inclination costs ΔV you don\'t get back. So work one cluster at a time: clear it out before you move planes.',
        },
        {
          id: 'ch7_cluster',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'At LEO pick this cluster and press Space to fly there. Then target (T), autopilot (A), and net it piece by piece until it\'s clear. Cheaper than re-planning every grab.',
          skillId: 'strategic_map',
          triggerEvent: 'DEBRIS_MAP_CLUSTER_SELECTED',
          title: 'WORK THE CLUSTER',
          body: 'At LEO pick the cluster and press Space, then clear it with Target (T) and Autopilot (A).',
        },
      ],

      // ── Chapter 8 — Hubble Watch: consolidation + confirm-before-fire (LEO-Mid 540) ──
      //    No new tool (the 80% reinforced). The active-sat treaty guard is the
      //    teaching moment for the `confirm_before_fire` skill (discovered when the
      //    player trips ActiveSatGuard's CONJUNCTION_ALERT), so these beats are
      //    narrative — no blocking interactive/reactive beat.
      8: [
        {
          id: 'ch8_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'LEO-Mid now, 540 km. And Hubble shares this band. She\'s a working observatory, not salvage: the daughter will refuse to launch on her, or on any crewed or active asset. Identify before you commit.',
        },
        {
          id: 'ch8_discipline',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'No new gear this stretch. Just discipline. Clear the dead stuff, plan your transfers at LEO, and confirm every target before you launch. The treaty guard is your backstop, not your plan.',
        },
      ],

      // ── Chapter 9 is the Starlink cascade boss (StarlinkCascadeBoss.js); this
      //    beat teaches dual-arm throughput for the 35-frag race. The C-hold
      //    radial wheel was removed (UX-11 #9) — direct keys now: D deploys,
      //    1-4 select & switch/pilot daughters, Shift+R recalls the fleet.
      //    Satisfied by any daughter deployment during the chapter. ──
      9: [
        {
          id: 'ch9_radial',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Field\'s getting thick. Two daughters beat one. Run both daughters: [D] deploys, [1-4] select and pilot (press again to switch back), [Shift+R] recalls the whole fleet. You\'ll need the throughput.',
          skillId: 'radial_menu',
          triggerEvent: 'ARM_DEPLOYED',
          title: 'DUAL-DAUGHTER COMMAND',
          body: 'Press D twice to deploy both daughters, then [1]/[2] to switch between them.',
        },
      ],

      // ── Chapter 10 — Belt Transit: radiation-belt timing (MEO 19,000, GPS band) ──
      //    Narrative consolidation (reinforces ch9 dual-arm); the "new concept" is
      //    SAA/Van-Allen timing, taught as briefing comms — no new skill.
      10: [
        {
          id: 'ch10_intro',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'You\'re climbing toward MEO. 19,000 km, GPS country. Which means crossing the Van Allen belts. Charged-particle flux up here browns out sensors and trips safe-mode. Time your transits through the gaps.',
        },
        {
          id: 'ch10_saa',
          type: 'narrative',
          source: 'HOUSTON',
          text: 'Watch the South Atlantic Anomaly. The belt dips low there and dose spikes. Run both daughters through the clean windows together; don\'t get caught reeling mid-belt.',
        },
        // Register item 100 (2026-08-21): the first mission beat that NEEDS the
        // wide sweep — a capture past 1 km from Mother is impossible under the
        // pre-feature 500 m deploy gate. Reachable at Zylon T2 tether (gate
        // 3.2 km) with any spring; the escalation names the paired purchase +
        // the dial (100 s transit @10 m/s vs 50 s @20 — the reload∝v² trade).
        {
          id: 'ch10_widesweep',
          type: 'interactive',
          source: 'HOUSTON',
          text: 'Belt crossings scatter fragments wide. Don\'t chase every shard with the Mother — reach out. Long tether, hot spring, dial the fleet launch speed up with [\'] (down with [;]) and take a catch past a kilometre.',
          skillId: 'speed_dial',
          triggerEvent: 'ARM_CAPTURED',
          triggerFilter: (d) => !!d && typeof d.rangeM === 'number' && d.rangeM >= 1000,
          title: 'THE WIDE SWEEP',
          body: 'Capture debris more than 1,000 m from the Mother. You need reach: a Zylon-or-better tether (Shop → Tether Materials) extends the deploy gate, and a hotter spring plus the [;]/[\'] launch-speed dial makes the transit worth the reload.',
        },
      ],

      // ── Chapter 11 — GEO Transit / Thaicom 4: Hohmann window + Hassan handover (GEO 35,786) ──
      //    The porkchop/Lambert viz is deferred to ROADMAP EN-5/6. u16a (owner 2026-10-22):
      //    the lesson teaches the transfer-window pane on the LEO view (it shows when the
      //    cheapest climb lines up) and finishes when the player flies a cluster transfer
      //    (DEBRIS_MAP_CLUSTER_SELECTED, as ch7); `orbital_hohmann` is discovered with it.
      11: [
        {
          id: 'ch11_intro',
          type: 'narrative',
          source: 'HASSAN',
          text: 'Cowboy, this is Hassan at ISTRAC, Bangalore. I\'ll be your conn for the GEO leg. There\'s a graveyard contract on Thaicom 4: a dead three-tonne comms bird at 35,786 km. Getting there is a patience game.',
        },
        {
          id: 'ch11_hohmann',
          type: 'interactive',
          source: 'HASSAN',
          text: 'The cheapest climb to a cluster is a Hohmann transfer. On the LEO view, pick a cluster. The line right under its name counts down, like T-2h10m, to that climb. It says OPEN NOW when it lines up, or LAUNCH ANYTIME when the timing does not matter. Press Space to fly there.',
          skillId: 'orbital_hohmann',
          triggerEvent: 'DEBRIS_MAP_CLUSTER_SELECTED',
          title: 'READ THE WINDOW',
          body: 'On the LEO view, pick a cluster: the line right under its name counts down to the cheapest climb, or says LAUNCH ANYTIME. Press Space to fly there.',
        },
        {
          id: 'ch11_mpd',
          type: 'narrative',
          source: 'HASSAN',
          text: 'For a climb this big you\'ll want the MPD thruster. High thrust, thirsty for power. Its passive drive trims your transfer burns once it\'s aboard. First launch is yours, Cowboy. Welcome to the high country.',
        },
      ],

      // ── Chapter 12 — Anchor Set: the elevator finale (F2 Option A) ──
      //    Consolidation chapter — NO new plate/tool (ROADMAP §4 guardrail). Caps
      //    the 12-chapter arc: HASSAN frames the final contract mass, one interactive
      //    beat lands on a live elevator contribution (CONTRACT_UPDATE — emitted from
      //    ShopScreen._contributeToElevator and _bossLifecycle.awardElevatorMass), then
      //    a closing narrative. The elevator win itself is owned by CONTRACT_COMPLETE /
      //    the debris-count GAME_WIN; these beats only narrate the home stretch.
      12: [
        {
          id: 'ch12_intro',
          type: 'narrative',
          source: 'HASSAN',
          text: 'This is the last leg, Cowboy. Every tonne you\'ve hauled has been climbing a tether to geostationary. The anchor counterweight needs its final mass — and there\'s no crew but you left to carry it. Bring the rest home.',
        },
        {
          id: 'ch12_contribute',
          type: 'interactive',
          source: 'HASSAN',
          text: 'Dock, open the Shop at a resupply stop, and contribute your salvage to the elevator contract. Watch the anchor-mass gauge climb — top it off and the tether holds on its own.',
          skillId: 'manage_shop',
          triggerEvent: 'CONTRACT_UPDATE',
          title: 'SET THE ANCHOR',
          body: 'Contribute metal to the space elevator contract from the Shop to raise the anchor mass.',
        },
        {
          id: 'ch12_outro',
          type: 'narrative',
          source: 'HASSAN',
          text: 'That\'s it. The counterweight\'s locked and the ribbon\'s taut from ground station to GEO. First permanent road off Earth — and you paved it out of the junk that used to threaten it. Anchor set, Cowboy. Ride easy.',
        },
      ],
    },
  },

  // ============================================================================
  // ONBOARDING (Delegation 2 — 2026-05-31)
  //
  // Bottom-screen hint ticker + OnboardingDirector beat lifecycle.  See:
  //   • [`js/systems/OnboardingDirector.js`](js/systems/OnboardingDirector.js:1)
  //   • [`js/ui/hud/HintTicker.js`](js/ui/hud/HintTicker.js:1)
  //
  // All tuning knobs for the 16-beat first-experience pipeline live here.
  // Persistence key is versioned so a future redesign can bump it without
  // colliding with the v1 storage layout.
  // ============================================================================
  ONBOARDING: {
    /** localStorage key for the OnboardingDirector save blob.
     *  v3 (2026-06-17): reward-first capture spine replaces the 18-beat
     *  camera/attitude lecture (new beat ids). Bumped so v1/v2 saves don't
     *  resume mid-pipeline against the new beat list.
     *  v4 (2026-09-06, Wave 5 Session N): the intro ride now lands a first-time
     *  player on the workbench (floor 1) where the MAP pane's beat runs before
     *  the flying lessons; a mid-pipeline v3 blob would resume the flying beats
     *  against the new opening — bumped so every player starts the spine
     *  fresh (04-test-pins 5). */
    STORAGE_KEY: 'spacecowboy_onboarding_v4',

    /** Default credit award per satisfied beat (where `credit` not set). */
    DEFAULT_CREDIT: 10,

    /** Idle ms before a posted beat escalates to a center-screen overlay. */
    IDLE_ESCALATION_MS: 15000,

    /** Unrelated-input count threshold for repeated-fail escalation. */
    UNRELATED_INPUT_THRESHOLD: 6,

    /** Tiered-skip window: a beat is "already known" if its trigger key
     *  was pressed in the last N ms before the beat was about to post. */
    RECENT_INPUT_WINDOW_MS: 3000,

    /** Default ms to wait after `HINT_SATISFIED` before advancing to next beat. */
    ADVANCE_DELAY_MS: 1500,

    /** Default ticker hint duration (overridable per-beat). */
    DEFAULT_HINT_MS: 12000,

    /** Poll interval (ms) for re-checking a HELD beat's gate (e.g. waiting for
     *  a scan to reveal a contact, or the player to close on a target). */
    GATE_POLL_MS: 1200,

    /** Veteran-skip threshold: fraction of relevant skills already practiced. */
    VETERAN_SKILL_THRESHOLD: 0.5,

    /** Bottom-screen ticker layout (CSS px). */
    TICKER: {
      BOTTOM_PX: 88,                   // distance above viewport bottom
      ROW_HEIGHT_PX: 36,               // single-line row height
      MAX_WIDTH_PX: 1100,              // longest the row can grow
      MAX_VISIBLE: 4,                  // 5th displaces the rightmost
      FADE_OUT_MS: 300,                // fade-on-clear duration
      SHIFT_MS: 250,                   // left-shift animation when slot opens
      FONT_LATEST_PX: 16,              // leftmost / latest hint font size
      FONT_OLDER_PX: 13,               // older hints font size
      SCALE_OLDER: 0.95,               // gentle scale for older hints
      KEY_CHIP_BG_GAMEPLAY: '#0a2a3a', // cyan tinted background pill
      KEY_CHIP_BG_MODIFIER: '#3a2a0a', // amber for Shift/Ctrl combos
      KEY_CHIP_BG_MOUSE: '#2a0a3a',    // purple for mouse glyphs
      ACCENT_BORDER: '#00ccff',
    },
  },

  // ============================================================================
  // INVENTORY (Delegation 4 — 2026-05-31)
  //
  // Thresholds + cooldowns for [`NetInventoryPanel.js`](js/ui/hud/NetInventoryPanel.js:1)
  // and the HOUSTON low-ammo comms hint.  All edits to this namespace are
  // safe to ship — purely cosmetic UX tuning.
  // ============================================================================
  INVENTORY: {
    LASSO_LOW_THRESHOLD:     1,       // chip turns yellow at this remaining count (the mother's nets: 4 at start; 5 until 2026-10-20, when the 50-shot lasso count went)
    LASSO_CRITICAL_THRESHOLD: 0,      // chip turns red at this remaining count
    NETS_LOW_THRESHOLD:      3,       // chip turns yellow at this net total
    NETS_CRITICAL_THRESHOLD: 0,       // chip turns red at this net total
    LOW_HINT_COOLDOWN_MS:    60000,   // suppress repeat low-ammo comms within this window
  },

  // ============================================================================
  // ST-6.7: ENVIRONMENT HAZARD SYSTEM — Five periodic/altitude-dependent effects
  // that create strategic pressure on the player. Degradation rates are tuned
  // for "long-session gradually accumulates" not "instant death".
  // ============================================================================
  ENVIRONMENT: {
    // ── Atomic Oxygen ──────────────────────────────────────────────────────
    AO_THRESHOLD_KM: 600,
    AO_TICK_INTERVAL_S: 10,
    AO_ARM_DEGRADATION: 0.002,         // 0.2% per tick
    AO_PANEL_DEGRADATION: 0.001,       // 0.1% per tick
    AO_SKILL_MITIGATION: 0.5,          // halved with manage_power

    // ── MMOD (Micro-Meteoroid / Orbital Debris) ───────────────────────────
    MMOD_CHECK_INTERVAL_S: 30,
    MMOD_BASE_PROBABILITY: 0.02,       // 2% per check
    MMOD_DAMAGE_FRACTION: 0.05,        // 5% of subsystem health
    MMOD_SUBSYSTEM_WEIGHTS: { arms: 0.4, sensors: 0.25, comms: 0.2, power: 0.15 },
    MMOD_SKILL_MITIGATION: 0.5,        // halved with advanced_sensors
    MMOD_WEATHER_AMPLIFIER: 1.5,       // during CME → ×1.5 probability

    // ── Safe Mode ─────────────────────────────────────────────────────────
    SAFE_MODE_CHECK_INTERVAL_S: 10,
    SAFE_MODE_HEALTH_THRESHOLD: 0.25,
    SAFE_MODE_RECOVERY_THRESHOLD: 0.40,
    SAFE_MODE_SENSOR_PENALTY: 0.5,

    // ── Radiation Belt ────────────────────────────────────────────────────
    RADIATION_BELT_LOW_KM: 2000,
    RADIATION_BELT_HIGH_KM: 12000,
    RADIATION_SENSOR_PENALTY: 0.3,
    RADIATION_COMMS_DELAY_S: 2,
    RADIATION_NOISE_INTERVAL_S: 15,
    RADIATION_SKILL_MITIGATION: 0.6,   // 60% reduction with radiation_hardening

    // ── Battery Depth-of-Discharge ────────────────────────────────────────
    DOD_DEEP_DISCHARGE_THRESHOLD: 0.2,
    DOD_RECHARGE_THRESHOLD: 0.8,
    DOD_CYCLE_PENALTY_INTERVAL: 10,
    DOD_CAPACITY_LOSS: 0.02,           // 2% per penalty interval
    DOD_SKILL_MITIGATION: 0.5,         // halved with manage_power
  },

  // =========================================================================
  // EPIC 8 — STATION_KEEP & FEEP ION THRUSTER PARAMETERS
  // =========================================================================

  // === ION_THRUSTER — FEEP engine parameters ===
  ION_THRUSTER: {
    WEAVER_MAX_THRUST: 0.00128,    // N — peak thrust Weaver arm
    SPINNER_MAX_THRUST: 0.0008,    // N — peak thrust Spinner arm
    ISP_MIN: 4000,                 // s — minimum specific impulse
    ISP_MAX: 19000,                // s — maximum specific impulse
    ISP_DEFAULT: 10000,            // s — default operating ISP
    BEAM_POWER_WEAVER: 40,         // W — beam power Weaver
    BEAM_POWER_SPINNER: 25,        // W — beam power Spinner
    EFFICIENCY: 0.6,               // η — overall thruster efficiency
    VECTOR_ANGLE_MAX: 15,          // deg — max thrust vectoring angle
    PROPELLANT: 'indium',          // default propellant
    THRUSTER_COUNT: 2,             // thrusters per arm
    // Auto-ISP modes for different flight phases
    ISP_TRANSIT: 12000,            // s — high-ISP cruise
    ISP_APPROACH: 8000,            // s — moderate for maneuvering
    ISP_STATIONKEEP: 15000,        // s — high-ISP low-thrust hold
    ISP_TENSION: 6000,             // s — medium for tether control
    ISP_RETURN: 10000,             // s — balanced return
    ISP_DEORBIT: 4000,             // s — max thrust for deorbit
  },

  // === STATION_KEEP — orbital-crane positioning ===
  // ── Idle-watchdog hints (Item 3, 2026-06-11) — data-driven anti-stuck guidance ──
  // ArmIdleAdvisor watches each arm's FSM state once per second. When an arm sits
  // in `state` for ≥ `idleS` seconds AND the `when` predicate holds, it fires the
  // hint ONCE per deployment (reset on any state change), routed through
  // TEACHING_MOMENT_FORCE. Veterans (SkillsSystem.isVeteran) are skipped entirely.
  // `icon` is the short text tag TeachingOverlay shows beside the title (plan D-J:
  // no pictographs; <= 4 chars).
  // `when` keys: 'noNetInFlightHasNets' | 'noNetInFlight' | 'outOfNets' | 'always'.
  // `tool` (optional, hold-catch 2026-10-22): the row applies only while her selected tool is this one (an arm with no
  // selectedTool counts as 'NET'); rows without it apply to every tool.
  ARM_IDLE_HINTS: [
    {
      // Guidance cleanup (Phase 2/3): the manual-pilot nudge formerly lived in
      // ArmUnit (fired raw on the first 3 deploys, no veteran gating). It now
      // lives here so it is veteran-gated + deployment-scoped like every other
      // idle hint. Carries the 2× score incentive the old line had.
      state: 'TRANSIT', idleS: 3, when: 'always',
      hintId: 'transit_pilot_nudge', title: 'Daughter in transit',
      text: 'Press 1-4 to take manual control. A piloted capture scores 2×.',
      icon: 'FLY',
      // u2-one-voice D7: the chip form (HintTicker step chip: cap = glyph, body = chip).
      chip: 'Fly her: 2× score', glyph: '1-4', keys: ['Digit1', 'Digit2', 'Digit3', 'Digit4'],
    },
    {
      state: 'STATION_KEEP', idleS: 0, when: 'noNetInFlightHasNets', tool: 'NET',
      hintId: 'sk_idle_fire_or_pilot', title: 'Daughter holding standoff',
      text: 'She is holding station on the target. Press N to launch the net (or 1-4 to pilot her).',
      icon: 'NET',
      chip: 'Launch her net', glyph: 'N', keys: ['KeyN'],
    },
    // hold-catch (owner 2026-10-22: "Hints at bottom of screen say press N for net, but default is sticky pad"): the same
    // chip for the tool she is holding (ArmUnit.selectedTool, set by the tool recommender when she enters station-keep, which
    // runs before this fires). One row per tool, each fires once per deployment; N works the selected tool (InputManager
    // KeyN). PAD, MAGNET and GRIPPER need no nets, so their rows only need a free line (no net in flight).
    {
      state: 'STATION_KEEP', idleS: 0, when: 'noNetInFlight', tool: 'PAD',
      hintId: 'sk_idle_pad_or_pilot', title: 'Daughter holding standoff',
      text: 'She is holding station on the target. Press N to stick the pad on (or 1-4 to pilot her).',
      icon: 'PAD',
      chip: 'Stick the pad on', glyph: 'N', keys: ['KeyN'],
    },
    {
      state: 'STATION_KEEP', idleS: 0, when: 'noNetInFlight', tool: 'MAGNET',
      hintId: 'sk_idle_magnet_or_pilot', title: 'Daughter holding standoff',
      text: 'She is holding station on the target. Press N to use the magnet (or 1-4 to pilot her).',
      icon: 'MAG',
      chip: 'Use the magnet', glyph: 'N', keys: ['KeyN'],
    },
    {
      state: 'STATION_KEEP', idleS: 0, when: 'noNetInFlight', tool: 'GRIPPER',
      hintId: 'sk_idle_grip_or_pilot', title: 'Daughter holding standoff',
      text: 'She is holding station on the target. Press N to grip it (or 1-4 to pilot her).',
      icon: 'GRIP',
      chip: 'Grip it', glyph: 'N', keys: ['KeyN'],
    },
    {
      state: 'STATION_KEEP', idleS: 6, when: 'outOfNets',
      hintId: 'sk_out_of_nets', title: 'Out of nets',
      text: 'Out of nets. Restock at the resupply stop.',   // = netRouting.DAUGHTER_OUT_OF_NETS_LINE (DECISIONS §33 row 8)
      icon: 'NETS',
      // Review R3: no key to press (nets are bought at the stop, nothing reloads on docking), so a glyph-only '!' cap.
      chip: 'Restock at the stop', glyph: '!', keys: [],
    },
  ],
  // ARM_PILOT idle hint is mode-based (not an FSM state), handled directly by the
  // advisor against InputManager's pilot mode.
  ARM_PILOT_IDLE: {
    idleS: 45, hintId: 'arm_pilot_return',
    title: 'Piloting a daughter', icon: 'FLY',
    text: 'Press her number again (1-4) or Esc to back out to Command view.',
    chip: 'Back to the ship', glyph: 'Esc', keys: ['Escape'],
  },

  STATION_KEEP: {
    DEFAULT_STANDOFF_MULT: 1.5,    // × debris size for initial standoff
    DEFAULT_STANDOFF: 8.0,         // m — initial standoff on SK entry (mid-band of
                                   //     4–12 m so ±/=/wheel give equal zoom range
                                   //     in either direction. Debug session
                                   //     2026-05-17 polish.
    MIN_STANDOFF: 4.0,             // m — minimum standoff distance (debug session
                                   //     2026-05-15 polish: widened 8→4 per user.
                                   //     At a 50° FOV the near plane (≥0.01 scene
                                   //     units = 1m world) still clears comfortably.
                                   //     The pilot now has room for close-inspection
                                   //     framing while ±/=/wheel give live zoom
                                   //     control over the full 4–12 m band.
    MAX_STANDOFF: 12.0,            // m — maximum standoff distance (debug session
                                   //     2026-05-15 polish: tightened 15→12 so the
                                   //     debris stays a meaningful size in frame
                                   //     even at the far end; 12 m also fits the
                                   //     mouse-wheel granularity (0.5 m / tick →
                                   //     16 ticks to traverse the full band).
    WHEEL_STEP_M: 0.5,             // m per mouse-wheel tick — instantaneous
                                   //     radius delta (not rate-based). 16 ticks
                                   //     covers the 4→12 m range.
    ORBIT_RATE: 0.5,               // rad/s — orbit angular rate
    ORBIT_RATE_FINE: 0.125,        // rad/s — fine orbit angular rate
    RADIUS_RATE: 1.0,              // m/s — radial approach/retreat rate
    RADIUS_RATE_FINE: 0.25,        // m/s — fine radial rate
    MAX_LATITUDE: 80,              // deg — max phi angle from equator
    TETHER_SAFETY_MARGIN: 10,      // deg — phi margin for tether clearance
    THETA_LIMIT_DEG: 120,          // deg — max θ swing ±around entry value during SK.
                                   // Prevents tether wrap (mother→arm tether tangles
                                   // around the debris past ~180°) and pilot
                                   // disorientation (mother leaves peripheral view
                                   // past ~90°). 120° = comfortable 240° inspection
                                   // arc keeping mother in view and tether unwound.
                                   // See debug session 2026-05-15.
    // ── Auto-return (Pattern C: dwell-then-ease) ──
    // 1. Hold arrow → daughter rotates.
    // 2. Release → daughter freezes for AUTO_RETURN_DWELL_S (no motion).
    // 3. After dwell → exponential ease back to entry (τ = AUTO_RETURN_TIME_CONSTANT_S).
    // 4. Press any arrow → cancel ease, reset dwell.
    // Recentering is fully automatic (dwell-then-ease); there is no manual
    // recenter key.
    AUTO_RETURN_DWELL_S:        3.0,  // s — quiet time before auto-return begins.
                                      // Long enough to read a label or line up a
                                      // screenshot without the camera fighting you.
    AUTO_RETURN_TIME_CONSTANT_S: 4.0, // s — exponential time constant during
                                      // ease-back.  Gentle: 92 % returned by
                                      // t_dwell+9 s ≈ 12 s.
    AUTO_RETURN_DEADZONE_DEG:   2.0,  // deg — once |θ| AND |φ| are inside this
                                      // band, snap to exact 0 so the camera
                                      // doesn't asymptote forever.
    STATIONKEEP_LERP_RATE: 0.8,   // lerp factor for position smoothing
    STANDOFF_SETTLE_TAU_S: 0.6,   // s — exponential time constant for easing the
                                  //     standoff radius from the ACTUAL SK-entry
                                  //     distance down to the nominal standoff.
                                  //     The SK gate fires at ENTRY_DISTANCE_MULT ×
                                  //     standoff (up to ~2×) while the daughter is
                                  //     still closing, so without this ease the
                                  //     0.8/frame position lerp yanks the daughter
                                  //     (and the rigidly-attached pilot camera) the
                                  //     whole gate→standoff gap in ~3 frames — the
                                  //     "speeds up then camera jumps" artifact.
                                  //     ~0.6s glides her in. Pilot radius input
                                  //     cancels the settle immediately.
    FUEL_RATE_STATIONKEEP: 0.02,  // kg/s — fuel consumption holding
    FUEL_RATE_MANEUVER: 0.1,      // kg/s — fuel consumption maneuvering
    ENTRY_MAX_VELOCITY: 3.0,      // m/s — max relative vel to enter SK.  Raised from 2.0: realistic arrivals show relV ~1.9 m/s (controller residual after drift cancellation + V_CAP*0.3 ≈ 2.1 m/s nominal approach speed) which is INSIDE the 2.0 m/s gate by only 0.1 m/s — not enough margin for variation.  3.0 m/s gives 1.0 m/s headroom and matches the actual achievable steady-state of the proportional controller.  See debug session 2026-05-09.
    ENTRY_DISTANCE_MULT: 2.0,     // ×standoff — distance gate for SK entry.  Widened from 1.3 hardcoded: the APPROACH controller's brake profile + EMA-smoothed drift compensation produces a settling band of ~1.5–2.0× standoff (e.g. observed dist=17m for standoff=10m, see debug logs).  1.3× gate (13 m) was inside the achievable band so SK never fired.  2.0× = 20 m comfortably captures the band so the daughter actually transitions to STATION_KEEP and the SK lerp pulls her into the standoff sphere.
  },

  // =========================================================================
  // DAUGHTER_NET_RECOIL — CAPTURE_NET.md §11.4 (linear recoil) + §11.3 (wheel
  // saturation scalar), daughter side. Gated by FEATURE_FLAGS.DAUGHTER_NET_RECOIL.
  //
  // The kick itself carries NO magnitude constants — Δv is derived at fire
  // time from the ACTUAL net class (CAPTURE_NET.*.MASS × LAUNCH_SPEED) over
  // the arm's config.mass (V5_WEAVER_MASS / V5_SPINNER_MASS). This block only
  // tunes the RECOVERY response and the §11.3 wheel bookkeeping.
  //
  // The daughter's SK/NETTING hold is kinematic (STATIONKEEP_LERP_RATE pulls
  // position onto the hold sphere at 0.8/frame), so the kick is modeled as a
  // critically-damped controller transient: an offset x with ẍ = −2ωẋ − ω²x
  // seeded by the impulse (x=0, ẋ=−Δv·launchDir). The hold goal is displaced
  // by x each frame — she is visibly shoved off the hold sphere, the RCS
  // "fights" it, and x returns to 0 with no teleport and no permanent offset.
  // ω = 3.0 ⇒ peak displacement Δv/(ω·e) (≈13 cm Weaver/MEDIUM, ≈7 cm
  // Spinner/SMALL) at t≈0.33 s, residual < 5 % of peak by t≈1.95 s — inside
  // the "hold loop visibly fights over ~1–2 s" design window and settled
  // before a typical net flight resolves (SK standoff 4–12 m ⇒ contact at
  // ~0.5–1.3 s, capture phases add ~1+ s). SK entry gates (ENTRY_MAX_VELOCITY
  // 3.0) and all STATION_KEEP constants are deliberately untouched.
  // =========================================================================
  DAUGHTER_NET_RECOIL: {
    CONTROLLER_OMEGA: 3.0,        // rad/s — critically-damped RCS null response
    SETTLE_EPS_OFFSET_M: 0.01,    // m — |offset| below this (with vel eps) snaps to settled
    SETTLE_EPS_VEL_MPS: 0.02,     // m/s — |recoil vel| settle epsilon
    // §11.3 reaction-wheel scalar — normalized "launch-reaction budget" units.
    // Each class's launcher spin-table is sized for its own net, so one fire =
    // one budget unit (deliberately NOT L=Iω per class, which would spread
    // 20:1 across classes; the audit's fix is a flavor loop, not an attitude sim).
    WHEEL_INCREMENT_PER_FIRE: 1.0,
    WHEEL_SATURATION_THRESHOLD: 3.0,  // ≥ 3 fires without recovery ⇒ saturated
    WHEEL_DECAY_PER_S: 1 / 30,        // magnetorquer bleed — one fire-unit per 30 s
    WHEEL_DESAT_FUEL_COST: 0.5,       // % tank — RCS desat burn billed per fire while saturated
    WHEEL_DESAT_DUMP: 1.0,            // momentum units the paid desat burn removes
  },

  // =========================================================================
  // CAPTURE_TORQUE_SETTLE — CAPTURE_NET.md §11.5, daughter side. Gated by
  // FEATURE_FLAGS.CAPTURE_TORQUE_SETTLE. Makes captured-debris angular
  // momentum real: the cinch transfers L into the tether instead of deleting
  // it (legacy: DebrisField._advanceTumble simply stops advancing).
  //
  // I MODEL — uniform solid sphere of diameter sizeMeter:
  //   I = (2/5)·m·(d/2)² = INERTIA_COEFF·m·d², INERTIA_COEFF = 0.1.
  //   Real debris brackets this: a thin rod tumbling transverse is
  //   (1/12)·m·L² ≈ 0.083·m·L², a solid sphere is exactly 0.1·m·d². Both
  //   inputs (mass, sizeMeter = max extent) already live on every debris
  //   record, so the model needs no new authored data.
  //
  // τ DERIVATION — the audit's fix sketch is τ = L/t_settle. We hold the
  //   TORQUE budget fixed (the tether/net rig can only damp so hard) and
  //   solve for time:  t_settle = L / TETHER_DAMP_TORQUE_NM, clamped to
  //   [T_SETTLE_MIN_S, T_SETTLE_MAX_S] so every settle stays readable.
  //   Reference tumbler (the audit's example): 500 kg, 6 m, 10°/s ⇒
  //   I = 0.1·500·36 = 1800 kg·m²; ω₀ = 0.17453 rad/s; L = 314.16 N·m·s;
  //   t_settle = 314.16/105 ≈ 2.99 s (mid-band); implied τ ≈ 105 N·m.
  //   Light fragments clamp to the 2 s floor (tether authority dwarfs their
  //   L); >420 N·m·s whales clamp to the 4 s ceiling.
  //
  // TRANSIENT — same critically-damped closed form as DAUGHTER_NET_RECOIL
  //   (_updateRecoilKick), one angular DOF about the debris' own tumbleAxis:
  //   θ̈ = −2λθ̇ − λ²θ with θ(0)=0, θ̇(0)=ω₀ ⇒ θ(t) = ω₀·t·e^(−λt).
  //   λ = SETTLE_U / t_settle: the envelope vs peak is u·e^(1−u) (u = λt),
  //   ≈ 4% at u = 6 — so the transient is visually done AT t_settle and the
  //   eps snap zeroes the sub-degree residue there (no asymptote). The catch
  //   wrenches forward to θ_peak = ω₀/(λe) at t = t_settle/6, then the
  //   tether visibly hauls it back to the cinched pose. Reference tumbler:
  //   θ_peak ≈ 1.84° real ≈ 18.4° rendered (×TIME_SCALE_GAMEPLAY, the same
  //   visual convention _advanceTumble applies to free tumble) at t ≈ 0.5 s.
  //   The debris' rendered channel is seedAngle + θ·TIME_SCALE_GAMEPLAY, so
  //   the wrench rate is continuous with the pre-capture visual spin.
  //
  // STRAIN GATE — while the residual wrench rate |θ̇| exceeds
  //   STRAIN_GATE_DEG_S (real °/s) during GRAPPLED/REELING, the net rolls a
  //   per-second recoverable rip (REEL_BOOST.RIP_PROB_PER_S idiom; the
  //   consequence path mirrors _ripNetDuringBoost / NET_STRAIN_*'s
  //   recoverable slip): rip probability = RIP_PROB_PER_S × band × dt with
  //   band = clamp((rate − GATE)/(RATED − GATE), 0, 1). The band is anchored
  //   to ABSOLUTE rates rather than strainBandT's rated-mass fractions
  //   because the gate is a rate line, not a capacity fraction. GATE = 5°/s
  //   (audit's number) sits below DESPIN_LASER.IN_SPEC_DEG = 10°/s: a
  //   just-in-spec catch carries only ~⅕ band for well under a second of
  //   exposure (≈1% rip), so "Tumble in spec. Net it." stays honest, while
  //   an un-lased 30°/s+ tumbler rides the full band and rips often.
  //   On rip the UN-transferred remainder resumes as real tumble
  //   (tumbleRate = |θ̇|, axis flipped if the tether was mid counter-swing).
  // =========================================================================
  CAPTURE_TORQUE_SETTLE: {
    INERTIA_COEFF: 0.1,            // I = coeff·m·d² — solid sphere of diameter sizeMeter
    TETHER_DAMP_TORQUE_NM: 105,    // N·m — tether damping-torque budget (τ in τ = L/t_settle)
    T_SETTLE_MIN_S: 2.0,           // s — settle-duration floor (light catches)
    T_SETTLE_MAX_S: 4.0,           // s — settle-duration ceiling (whales)
    SETTLE_U: 6.0,                 // λ = SETTLE_U/t_settle; envelope ≈ 4% of peak at u = 6
    MIN_SEED_RATE_DEG_S: 0.1,      // °/s — below this the cinch is torque-free (no transient;
                                   //   keeps scenario-pinned zero-rate attitudes byte-frozen)
    SNAP_EPS_THETA_RAD: 0.02,      // rad, RENDERED (×TIME_SCALE_GAMEPLAY) — ≈1.1° residue snap
    SNAP_EPS_RATE_RAD_S: 0.05,     // rad/s, RENDERED — ≈2.9°/s residue snap (both eps + t ≥ T)
    STRAIN_GATE_DEG_S: 5.0,        // °/s — at/below: guaranteed hold (the despin play)
    STRAIN_RATE_RATED_DEG_S: 30.0, // °/s — full rip band at this residual wrench rate
    RIP_PROB_PER_S: 1.0,           // /s — rip chance at full band (× band × dt per frame)
  },

  // =========================================================================
  // DAUGHTER_AUTOPILOT — Proportional controller for arm TRANSIT + APPROACH
  // Mirrors mother AutopilotSystem.js control law (§D quadratic braking + relV
  // velocity matching). Values scaled for FEEP micro-thrusters on daughter arms.
  //
  // V_CAP = 10 m/s matches CROSSBOW_LAUNCH_SPEED_DEFAULT so the braking profile
  // sqrt(2·A_BRAKE·r) is the dominant control term, not the cap. Old V_CAP=0.5
  // caused the profile to saturate at 2.5m, making the arm brake immediately
  // from 10 m/s launch speed and then crawl. See debug session 2026-05-04.
  // =========================================================================
  DAUGHTER_AUTOPILOT: {
    MAX_ACCEL:      0.5,   // m/s² — game-feel acceleration (was 0.1; 4× less than mother's 2.0)
    KP_VEL:         0.8,   // dimensionless — velocity tracking gain (same as mother)
    BRAKE_FRACTION: 0.5,   // fraction of MAX_ACCEL for along-track braking
    V_CAP:          7.1,   // m/s — fallback cap (T1 spring speed). TRANSIT uses _launchSpeedMps dynamically.
    DRIFT_EMA_ALPHA: 0.1,  // EMA smoothing factor for orbital drift velocity (0=frozen, 1=raw)
  },

  // === TETHER_TENSION — tether force parameters ===
  TETHER_TENSION: {
    TARGET_TENSION: 2.0,           // N — nominal tether tension
    MIN_TENSION: 0.4,              // N — minimum safe tension
    MAX_TENSION_WARNING: 50,       // N — warning threshold
    MAX_TENSION_CRITICAL: 200,     // N — critical / snap threshold
    FEEP_RADIAL_HOLD_OFFSET: 10,  // m — radial hold offset
    FEEP_TENSION_AUTHORITY: 0.001, // N — FEEP authority for tension
  },

  // === ION_THRUSTER_METALS — FEEP propellant characteristics ===
  // Based on real FEEP research: Enpulsion IFM Nano (indium), ESA studies (gallium, bismuth)
  ION_THRUSTER_METALS: {
    indium:   { ispMin: 4000,  ispMax: 19000, thrustPerW: 0.032, mass: 114.8, unlock: 'default',        trl: 9 },
    gallium:  { ispMin: 6000,  ispMax: 25000, thrustPerW: 0.028, mass: 69.7,  unlock: 'forge_gallium',  trl: 7, heater_W: 2 },
    bismuth:  { ispMin: 2500,  ispMax: 8000,  thrustPerW: 0.045, mass: 209.0, unlock: 'forge_bismuth',  trl: 6 },
    iodine:   { ispMin: 2000,  ispMax: 4500,  thrustPerW: 0.060, mass: 126.9, unlock: 'forge_iodine',   trl: 7 },
    mercury:  { ispMin: 3000,  ispMax: 10000, thrustPerW: 0.040, mass: 200.6, unlock: 'forge_mercury',  trl: 5, codex_warning: 'toxic' },
    cesium:   { ispMin: 8000,  ispMax: 22000, thrustPerW: 0.030, mass: 132.9, unlock: 'forge_cesium',   trl: 5, codex_warning: 'reactive' },
    tungsten: { ispMin: 1500,  ispMax: 3500,  thrustPerW: 0.080, mass: 183.8, unlock: 'forge_tungsten', trl: 4, requires: 'mpd_class_power' },
  },

  // ============================================================================
  // EPIC 9 FEATURE HELPERS
  // ============================================================================

  /** u20-debris v2 (fix round 1, F3): the material of each parked mission-satellite body: FIELDS.LIST.length + MISSION_POOL_EXTRA of them. */
  missionPoolMaterials() {
    const hs = this.HEAVY_SPARES;
    const n = ((this.FIELDS && this.FIELDS.LIST) ? this.FIELDS.LIST.length : 0) + (hs.MISSION_POOL_EXTRA | 0);
    return Array.from({ length: n }, (_, i) => hs.MISSION_POOL_CYCLE[i % hs.MISSION_POOL_CYCLE.length]);
  },

  smallGroupCount(seed, variant = 0) {
    // u20-debris v2: how many pieces a field's small-piece group holds (SMALL_GROUP.COUNT_MIN..COUNT_MAX), a pure function of the
    // field's seed and the variant (0 = a low field's own group, 1 = the group a mission adds). Lives here, not in DebrisField,
    // so FieldRegistry can read it without importing a file that pulls in three.
    const G = this.SMALL_GROUP;
    let h = (Math.imul((seed | 0) ^ G.SEED_XOR, 0x9E3779B1) + Math.imul((variant | 0) + 1, 0x85EBCA6B)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297A2D39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return G.COUNT_MIN + Math.floor((h / 4294967296) * (G.COUNT_MAX - G.COUNT_MIN + 1));
  },

  /**
   * Returns true if a feature flag is enabled.
   * Reality Mode globally forces ALL feature flags to false.
   */
  isFeatureEnabled(flagName) {
    if (this.FEATURE_FLAGS.REALITY_MODE) return false;
    return this.FEATURE_FLAGS[flagName] === true;
  },

  /**
   * Reality Mode helper — returns true when the player is restricted to TRL 9 baseline.
   */
  isRealityMode() {
    return this.FEATURE_FLAGS.REALITY_MODE === true;
  },

  // === DEBUG / DIAGNOSTICS (PR 5) ===
  // Verbose runtime logging — off by default. Enable per-session via
  // ?debug=1 in the URL (see main.js bootstrap), which flips the flags
  // below to true before any module reads them.
  DEBUG: {
    // SceneManager._logDiagnostics() + Earth LOD selection log.
    // When false these blocks are cheap no-ops.
    LOG_RENDERER_DIAGNOSTICS: false,
    // PR 6 / P3.15: Per-60-frame draw-call profiling log.
    // Enable via ?profile=1 URL flag (see main.js bootstrap).
    LOG_DRAW_CALLS: false,
    // Sprint 2 / Phase A: 1 Hz performance report overlay.
    // Enable via ?perfReport=1 URL flag (see main.js bootstrap).
    PERF_REPORT_OVERLAY: false,
    // Ctrl+D debug-overlay hotkey. Off in production so Ctrl+D stays the
    // browser's bookmark shortcut; flipped by ?debug=1 (see main.js bootstrap).
    DEBUG_OVERLAY_HOTKEY: false,
  },

  // === PERFORMANCE TUNING (PR 3 + PR 4) ===
  PERF: {
    // --- Session I (2026-09-05): the adaptive frame schedule (plan D-G/D-F).
    // Pacing is "draw every Nth refresh" by FRAME COUNTING against the
    // measured rAF period (js/core/FrameSched.js), never a time threshold —
    // the old opt-in FRAME_CAP ms-gate is RETIRED (it skipped unevenly against
    // a 120 Hz rAF stream; its null default had shipped no cap since PR 3).
    // The skip factor clamps at N = max(1, round(measuredHz / target)), so a
    // display at or below the target (60 Hz at rest, headless SwiftShader)
    // never skips a frame.
    REST_FPS: 60,        // gameplay at rest: draw ~60 fps (native during input/rides)
    BOOST_MS: 1000,      // native-refresh window after any input in gameplay
    HOLD_FPS: 10,        // drawer-open heartbeat (world clock 0 — D-F held world)
    HOLD_BOOST_MS: 500,  // native window after input while a drawer is open

    // --- PR 4 / P1.5: Quality tier system ---
    // Each tier is a config object consumed by SceneManager._setupPostProcessing()
    // and the renderer pixelRatio setter. QualityManager.selectInitialTier()
    // picks one of these at bootstrap; runtimeAdapt() can downshift live.
    //   msaaSamples     — MultisampledRenderTarget samples (0 = none)
    //   enableBloom     — UnrealBloomPass added to composer when true
    //   enableSMAA      — SMAAPass added to composer when true
    //   pixelRatioCap   — renderer.setPixelRatio(min(devicePR, cap))
    //   useFXAAFallback — adds an FXAA ShaderPass (post-OutputPass) when SMAA is
    //                     off, for lighter edge AA on top of MSAA. Wired in
    //                     SceneManager._setupPostProcessing. Chain when active:
    //                     RenderPass + UnrealBloomPass + OutputPass + FXAA.
    // Sprint 3 GPU profiling — Phase C.1 (2026-05-23): HIGH `pixelRatioCap` lowered
    // from 2 → 1.5 based on round-2 sweep data. At pr=2 the M4 Max renders at
    // 5760×3600 (20.7 M fragments) and every fragment-bound pass (Earth FS,
    // bloom mip chain, SMAA, MSAA resolve) pays for it. Post-C.1 measurement:
    // baseline 10.52 → 4.82 ms MENU (-5.7 ms), 11.07 → 5.12 IN-MISSION (-5.95 ms).
    // The 54% cost reduction from a 44% fragment reduction is the cache /
    // bandwidth-pressure signature — at pr=2 we were over the M4 Max memory
    // ceiling; at pr=1.5 we drop below it and gain super-linearly.
    //
    // Sprint 3 GPU profiling — Phase C.2 (2026-05-23): HIGH `enableSMAA` flipped
    // false. With 4× MSAA still active on the customRT, geometric edges already
    // get smoothed; SMAA's marginal contribution (shader / transparent-edge AA)
    // costs 1.77 ms IN-MISSION at pr=1.5 — too high for the visual benefit at
    // retina-class density.
    //
    // Polish pass 2 (2026-07-10): HIGH `useFXAAFallback` flipped true. The
    // OutputPass now sits before FXAA (MSAA → bloom → OutputPass → FXAA), so
    // FXAA receives tone-mapped sRGB luma — the input it needs and was denied
    // pre-OutputPass, which is why it was previously judged ineffective. MSAA-4
    // alone leaves residual stair-stepping on the extreme-contrast Earth limb;
    // FXAA (~0.3 ms) kills that sawtooth for far less than SMAA's 1.77 ms.
    // C2 (Earth-visuals): HIGH `useFXAAFallback` flipped back to false. 4× MSAA in
    // the composer RT already resolves geometric edges; the earlier polish-pass
    // rationale (FXAA kills residual limb sawtooth) was calibrated against the
    // A1-bug wash. With Phase A landed, FXAA's ~0.3 ms full-frame luma smear reads
    // as redundant texture softening on the now-crisp disc. Kept ON for MEDIUM,
    // where MSAA is only 2× and the extra edge cleanup still earns its keep.
    QUALITY_TIERS: {
      HIGH:   { msaaSamples: 4, enableBloom: true,  enableSMAA: false, pixelRatioCap: 1.5, useFXAAFallback: false },
      MEDIUM: { msaaSamples: 2, enableBloom: true,  enableSMAA: false, pixelRatioCap: 1.5, useFXAAFallback: true  },
      LOW:    { msaaSamples: 0, enableBloom: false, enableSMAA: false, pixelRatioCap: 1,   useFXAAFallback: false },
    },
    // Default initial tier when auto-detection isn't conclusive.
    DEFAULT_QUALITY_TIER: 'HIGH',
    // Sliding-window size for the FPS history feeding runtimeAdapt() (frames).
    FPS_HISTORY_SIZE: 180,
    // Median FPS below this triggers a tier drop.
    ADAPT_FPS_THRESHOLD: 50,
    // Cooldown frames after a tier change before another change is allowed.
    ADAPT_COOLDOWN_FRAMES: 300,
    // Sprint 2 / PR B — auto-upshift gate. Median FPS at or above this triggers
    // a tier promotion (one step up). Wider hysteresis band than downshift (50 → 58)
    // prevents HIGH ↔ MEDIUM ping-pong when the workload sits near the threshold.
    ADAPT_UPSHIFT_FPS_THRESHOLD: 58,
    // Sprint 2 / PR B — upshift cooldown (frames). Longer than the downshift
    // cooldown (300) because upshifting is optimistic — we want to be sure the
    // workload really has eased before re-enabling heavier post-FX.
    ADAPT_UPSHIFT_COOLDOWN_FRAMES: 600,
    // PR 6 / P3.11: GPU runtime probe — EXT_disjoint_timer_query_webgl2.
    // If the median GPU frame time over the probe window exceeds this (ms),
    // request a tier downshift. Only runs once at startup.
    // P3 (2026-07-20): 14 → 7. Calibrated against the pre-Sprint-3 23.65 ms
    // warm-GPU baseline; post-fix HIGH runs ~3.5-4 ms so 14 could never trigger
    // and runtime adapt was effectively disabled (GPU_PROFILING_REPORT §10.4).
    // 7 ms ≈ 2× the post-fix HIGH baseline: fires only on genuinely struggling
    // devices, still far under the 16.7 ms frame budget.
    GPU_PROBE_THRESHOLD_MS: 7,
    // Number of frames in the probe sampling window.
    GPU_PROBE_FRAMES: 60,
    // Warmup/settle guard (ms). Adaptive tier changes — both the one-shot GPU
    // startup probe and the runtime FPS adapt loop — are suppressed for this
    // long after boot AND after each transition into a heavier state (menu →
    // briefing → sim). One-time startup costs (shader compilation, 16K Earth
    // texture decode/upload, debris-field build) spike GPU time and FPS well
    // past steady state; without this window the probe/adapt would read that
    // transient as sustained load and permanently downshift a capable machine
    // (e.g. an M4 Max that holds HIGH at ~5 ms/frame — see Phase C.1 note above).
    // A genuinely slow device still downshifts once the window elapses.
    ADAPT_WARMUP_MS: 2500,
  },

  // ============================================================================
  // === WIREFRAMES (Delegation 3, 2026-05-31) ===
  // Shared visual constants for Mother / Daughter / Debris wireframe panels.
  // DaughterWireframe imports these; existing DebrisWireframe keeps its own
  // internal constants for backward compatibility.
  // ============================================================================
  WIREFRAMES: {
    PANEL_SIZE_NORMAL:    { w: 280, h: 200 },
    PANEL_SIZE_EXPANDED:  { w: 380, h: 280 },
    AUTO_ROTATE_MS:       2000,   // ms per zone in auto-tour
    COLOR_GREEN:          '#3fb950',
    COLOR_YELLOW:         '#d29922',
    COLOR_RED:            '#f85149',
    COLOR_LINE:           '#58a6ff',
    COLOR_LABEL:          '#c9d1d9',
  },
};

// Steering-gas price: REAL since 2026-10-24 (owner "2 A", DECISIONS §1, §37 row 11). The factor multiplies the base rate
// (COLD_GAS_BASE_RATE units/s) into the bill, so it is derived, never typed: one couple (two nozzles) burns
// 2 x NOZZLE_THRUST_N / (HOLD_ISP_S x G0) kg/s, and a tank unit is OCTOPUS_CORE_COLD_GAS / COLD_GAS_MAX kg (0.3).
// 0.136 kg/s over 0.3 kg x 0.5 units/s = 0.906. It was 1.6 until then (an old rule, to make the wheels worth buying;
// MEASURED 2026-10-17: a 60 degree arrow turn cost 5.7% of the tank).
Constants.ATTITUDE.RCS_ATTITUDE_N2_FACTOR =
  (2 * Constants.ATTITUDE.NOZZLE_THRUST_N / (Constants.REEL_PUSH.HOLD_ISP_S * Constants.G0)) /
  ((Constants.OCTOPUS_CORE_COLD_GAS / Constants.COLD_GAS_MAX) * Constants.ATTITUDE.COLD_GAS_BASE_RATE);

// Reaction-wheel kit: derived, never typed. 9.6 + 1.5 + 1.0 = 12.1 kg. A coil of 15 A·m² across a 36 µT field, half of it
// (the allowance) = 0.27 mN·m, so a full 4 N·m·s axis empties in 4 / 0.00027 = 14,800 s of game time (4.1 h).
Constants.WHEELS.MASS_KG =
  Constants.WHEELS.WHEEL_MASS_KG + Constants.WHEELS.COIL_MASS_KG + Constants.WHEELS.ELECTRONICS_MASS_KG;
Constants.WHEELS.COIL_TORQUE_NM =
  Constants.WHEELS.COIL_MOMENT_AM2 * Constants.WHEELS.FIELD_T * Constants.WHEELS.FIELD_ALLOWANCE;

// ============================================================================
// ST-6.6: TRL PURE HELPERS — exported for UI and tests.
// These are intentionally side-effect-free and DOM-free so they can run in
// Node.js test context.
// ============================================================================

/**
 * Validate a TRL value (must be integer in [MIN_VALID..MAX_VALID]).
 * @param {number} trl
 * @param {object} [C=Constants.TRL] — constants namespace (for injection)
 * @returns {boolean}
 */
export function isValidTRL(trl, C) {
  const k = C || Constants.TRL;
  return Number.isInteger(trl) && trl >= k.MIN_VALID && trl <= k.MAX_VALID;
}

/**
 * Map a TRL integer to one of four badge colours.
 * TRL 9   → COLOR_FLIGHT_PROVEN  (green)
 * TRL 7–8 → COLOR_MATURE         (yellow)
 * TRL 4–6 → COLOR_RESEARCH       (amber)
 * TRL 1–3 → COLOR_SPECULATIVE    (red)
 * Invalid TRL → COLOR_SPECULATIVE (fail-loud red).
 * @param {number} trl
 * @param {object} [C=Constants.TRL]
 * @returns {string} hex colour
 */
export function trlToBadgeColor(trl, C) {
  const k = C || Constants.TRL;
  if (!isValidTRL(trl, k)) return k.COLOR_SPECULATIVE;
  if (trl >= k.FLIGHT_PROVEN_MIN) return k.COLOR_FLIGHT_PROVEN;
  if (trl >= k.MATURE_MIN)        return k.COLOR_MATURE;
  if (trl >= k.RESEARCH_MIN)      return k.COLOR_RESEARCH;
  return k.COLOR_SPECULATIVE;
}

/**
 * Map a TRL integer to its label string.
 * @param {number} trl
 * @param {object} [C=Constants.TRL]
 * @returns {string}
 */
export function trlToLabel(trl, C) {
  const k = C || Constants.TRL;
  if (!isValidTRL(trl, k)) return k.LABEL_SPECULATIVE;
  if (trl >= k.FLIGHT_PROVEN_MIN) return k.LABEL_FLIGHT_PROVEN;
  if (trl >= k.MATURE_MIN)        return k.LABEL_MATURE;
  if (trl >= k.RESEARCH_MIN)      return k.LABEL_RESEARCH;
  return k.LABEL_SPECULATIVE;
}

/**
 * UX-11 #10: player-facing "Tech Level" presentation strings.
 * The internal data keys stay TRL (Constants.TRL, entry.trl) — only the
 * vocabulary shown to the player changes. Badge: "Tech Level n"; full label:
 * "Tech Level n: <tier word>". Apply in BOTH CodexViewerUI and ShopScreen
 * so "TRL" never survives anywhere player-facing.
 * @param {number} trl
 * @param {object} [C=Constants.TRL]
 * @returns {string} e.g. "Tech Level 9: Flight-proven"
 */
export function trlToTechLevelLabel(trl, C) {
  return `Tech Level ${trl}: ${trlToLabel(trl, C)}`;
}

/**
 * Short badge text for cards/chips: "Tech Level n".
 * @param {number} trl
 * @returns {string}
 */
export function techLevelBadgeText(trl) {
  return `Tech Level ${trl}`;
}

// CJS guard — expose pure helpers for Node.js tests (same pattern as Epic 5).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Constants, trlToBadgeColor, trlToLabel, isValidTRL,
    trlToTechLevelLabel, techLevelBadgeText,
  };
}

/**
 * Is a daughter in this state still attached to the mother (on her strut, prepping a carry, holding a catch at the tip,
 * reloading)? Such a daughter is part of the ship: she hides with the mother, and so does a catch she holds. ONE list,
 * read by ArmManager.syncAttachedWithMother and DebrisField.carrierHidden.
 * @param {string} state  an ARM_STATES value
 * @returns {boolean}
 */
export function isArmAttachedToMother(state) {
  const S = Constants.ARM_STATES;
  return state === S.DOCKED || state === S.CARRY_PREP || state === S.HOLDING_CATCH || state === S.RELOADING;
}

export default Constants;
