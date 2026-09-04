/**
 * MotherCallouts.js — In-world 3D inspection callouts for the mothership.
 *
 * Part labels, leader lines and detail cards are anchored onto the real model
 * in the world (no separate 2D schematic pane). A screen-space side-rail layout
 * flanks the ship with two stacked columns of cards joined to their anchors by
 * elbow leaders, so labels never crowd the fore cap or cross each other.
 *
 * Zoom-driven level-of-detail keeps clutter under control:
 *
 *   Band 1  SYSTEM   (far, ~12–8 m)  : 6 system-group labels only.
 *   Band 2  PART     (mid, ~8–5.5 m) : every major part card; system labels fade.
 *   Band 3  COMPONENT(close, <5.5 m) : the part nearest screen-centre gets a
 *                                       full detail card (specs + TRL + live data)
 *                                       placed by its anchor; its system's detail
 *                                       sub-parts appear on the rails.
 *
 * Identity: hue = system (6 hues), risk = a small badge dot on the card. Anchors
 * on the far side of the hull fade by camera-facing angle (dot-product proxy).
 * Card positions ease in SCREEN space (NDC) so ship rotation reads as smooth
 * sliding rather than object-space wobble. Rail side and stack order use
 * hysteresis so orbiting doesn't thrash sides or flash leader crossings.
 *
 * First time inspection engages, a one-shot "guided pulse" sweeps a highlight
 * through the systems so a new player learns the vocabulary passively.
 *
 * Hull-part hover (D2's first verb, Wave 5): parts with `pick:` hull-object
 * names raycast alongside the card sprites at the same 10 Hz — hovering the
 * part outlines it in the house cyan (EdgesGeometry lines + a translucent
 * inflated shell, children of the picked meshes, depth-tested and pulled
 * 1.5 mm toward the camera so the hull hides far-side layers) and brightens
 * its card; clicking the part is identical to clicking its card (one hover
 * state `_hoverRec`, one CODEX_OPEN_ENTRY emitter). The stationary re-pick is
 * sticky (see _refreshHover) so the highlight is steady. Since Wave 5
 * Session D the hull MESHES are pickable whenever they can be on screen in
 * the PART/COMPONENT bands — regardless of the card's rail cull, facing gate
 * or detail tier (the mesh is literally under the pointer) — while the CARD
 * keeps the shipped visibility gate; see _recPickable's two tiers.
 *
 * REFIT ghosts (Wave 5 (2)): setGhostOutline(partIds) shows the SAME outline
 * steady-on for a set of parts (the pane's alternative hover), pulsed
 * 0.35×–1× at 1.2 Hz on the recs' own materials; getPartsBySystem() feeds the
 * pane's bookkeeping; the optional onPartClick hook (D-a) routes a resolved
 * part/card click to the REFIT card instead of the Library emit.
 *
 * Gating mirrors the hull outline: active while either the discrete INSPECTION
 * view (CAMERA_VIEW_CHANGE) or the OVERVIEW zoom sub-state (INSPECT_HULL_OUTLINE)
 * reports inspection on.
 *
 * Render pipeline (corrects the round-1 plan note): the callout group is a child
 * of `player`, and SceneManager._updateNearCamera() re-tags every near-field root
 * subtree onto NEAR_FIELD_LAYER EVERY FRAME (SceneManager.js:966-975), so these
 * sprites render in the NEAR pass alongside the hull — after clearDepth(), so the
 * hull can never overpaint them. The pass's uniform ×1e5 camera-relative scale is
 * applied to the shared root, and every position here goes through
 * player.worldToLocal / local anchors, so screen size and position are preserved
 * exactly. Near-plane clipping of dots/leader tips is provably dead: min inspect
 * distance is 2 m (CameraSystem.js:208) vs a 1.33 m clip threshold for the
 * fore-most anchor (1.3 m) — unreachable.
 *
 * @module ui/MotherCallouts
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { createCardTexture, CARD_W_OVER_TITLE_H, wrapHint } from '../scene/labelTexture.js';
import { orderRail } from '../scene/railOrder.js';

// 1 metre in scene units (mirrors PlayerSatellite's M = 0.00001).
const M = 0.00001;
const DEG2RAD = Math.PI / 180;

const CFG = Constants.CALLOUTS;
const HUES = CFG.SYSTEM_HUES;
const RISK = CFG.RISK_COLORS;

// ----------------------------------------------------------------------------
// SYSTEM / PART ANCHOR TABLE
// ----------------------------------------------------------------------------
// Anchors are LOCAL model coordinates (parented to the PlayerSatellite group),
// in metres × M, taken from the real model build in PlayerSatellite.js
// (+Z fore, −Z aft, XY radial; barrel r=0.40, L=2.0 → caps at z=±1.0).
//
// Per part:
//   id       stable lookup key (tests + internal; display copy may change freely).
//   tier     'major' → PART + COMPONENT bands; 'detail' → COMPONENT band only,
//            and only when its system owns the focused part OR it sits near the
//            focused part on screen (proximity reveal, T6).
//   massKg   real-flavoured dry mass (kg) shown on the detail card.
//   specs    1–2 static spec lines for the detail card.
//   priority higher = kept when a rail overflows (culling drops lowest first).
//   risk     GREEN/YELLOW/RED → badge dot colour.
//   codexId  existing codex entry id/alias → clickable deep-link.
//   live     id consumed by _liveRows() for phase-2 dynamic rows (optional).
//   mesh     PlayerSatellite mesh name; the anchor is resolved from the live
//            mesh position instead of the static coordinate (T1). Falls back to
//            `anchor` with a one-time console.warn if the name doesn't resolve.
//   dynamic  re-resolve the mesh anchor EVERY frame (the mesh moves, e.g. the
//            strut-mounted reel cartridges). Static meshes resolve once.
//   pick     PlayerSatellite object names used ONLY for hull hover: the raycast
//            targets and the cyan edge outline (D2's first verb — hover the part
//            itself, not just its card). NEVER moves an anchor (anchors are
//            `mesh`/`anchor` only), so every leader/dot/card stays byte-identical
//            with or without `pick`. Names resolve via player.traverse collecting
//            ALL matches (SensorSpoke ×4 etc. share a name), so the sets must be
//            DISJOINT subtrees across parts. Absent → defaults to
//            `mesh ? [mesh] : []`. Card-only parts (berths/mli/daughters/THERMAL
//            + the anchorless structure plates) carry no `pick` on purpose — see
//            the FINDINGS in the Wave-5 hull-hover report for each reason.
const SYSTEMS = [
  {
    id: 'POWER', label: 'POWER',
    anchor: [ 1.0 * M, 0, 0 ],
    role: 'solar wings + hull cells',
    parts: [
      { id: 'rosa_wings', name: 'ROLL-OUT SOLAR WINGS', risk: 'GREEN', tier: 'major', codexId: 'rosa_solar_array',
        massKg: 22, priority: 9, live: 'rosa',
        specs: ['2× 1×2 m roll-out arrays', '~2.2 kW peak (BOL)'],
        pick: ['ROSA_Panel_Front_0deg', 'ROSA_Panel_Back_0deg', 'ROSA_Panel_Front_180deg', 'ROSA_Panel_Back_180deg'],
        anchor: [ 1.1 * M, 0, 0 ] },
      { id: 'body_cells', name: 'HULL SOLAR CELLS', risk: 'GREEN', tier: 'detail', codexId: 'gallium_arsenide',
        massKg: 3, priority: 2, specs: ['Body-mounted GaAs cells'],
        // az 33.75° facet centre, central PV row (face radius barrelR×1.014).
        // The old az-0° anchor sat in the ROSA-root keep-out on bare hull and
        // collided with NAV LIGHTS (2 cm).
        // pick: the 28 barrel PV boxes (0..27, verified 2026-09-02 — the model
        // builds 28 not 30: aft rows near the strut azimuths are skipped) plus
        // the 4 end-band gap cells.
        pick: [
          ...Array.from({ length: 28 }, (_, i) => `BarrelSolarPanel_${i}`),
          'BarrelSolarPanel_gap_90_F', 'BarrelSolarPanel_gap_90_A',
          'BarrelSolarPanel_gap_270_F', 'BarrelSolarPanel_gap_270_A',
        ],
        anchor: [ 0.337 * M, 0.2254 * M, 0 ] },
      { id: 'array_roll', name: 'SOLAR WING SPOOL', risk: 'GREEN', tier: 'detail', codexId: 'solar_power',
        massKg: 4, priority: 2, specs: ['Roll-out drum + drive'],
        // The real spool/drum sits rootX = brkLen + drumR×0.4 = 0.08 outboard
        // of the pivot at barrelR → x = 0.48.
        pick: ['ROSA_Spool_0deg', 'ROSA_Spool_180deg'],
        anchor: [ 0.48 * M, 0, 0 ] },
    ],
  },
  {
    id: 'PROPULSION', label: 'PROPULSION',
    anchor: [ 0, 0, -1.0 * M ],
    role: 'ion + cold-gas steering',
    parts: [
      { id: 'feep', name: 'ION THRUSTERS (FEEP)', risk: 'YELLOW', tier: 'major', codexId: 'feep_thruster',
        massKg: 8, priority: 8, live: 'feep',
        specs: ['4× emitter clusters', 'Isp ~4000 s'],
        // The 4 emitter cluster bodies (NOT FEEP_Boss/FEEP_GridDisc — those share
        // duplicate names and are cull-hidden mm detail).
        pick: ['MainFEEP_0', 'MainFEEP_1', 'MainFEEP_2', 'MainFEEP_3'],
        anchor: [ 0, -0.20 * M, -1.05 * M ] },
      { id: 'rcs', name: 'COLD-GAS STEERING', risk: 'GREEN', tier: 'major', codexId: 'cold_gas_rcs',
        massKg: 3, priority: 5, specs: ['GN2 thruster ring'],
        pick: ['RCSPod_0', 'RCSPod_1', 'RCSPod_2', 'RCSPod_3'],
        anchor: [ -0.03 * M, 0.42 * M, -0.795 * M ] },
      { id: 'mli', name: 'THERMAL BLANKET (MLI)', risk: 'GREEN', tier: 'detail', codexId: 'mli_insulation',
        massKg: 2, priority: 2, specs: ['Multi-layer insulation'],
        // Bare-MLI shoulder band above the fore cell row (cells end at z=0.72).
        // The old z=0.50 anchor pointed at MLI seam rings deleted 2026-07-23.
        anchor: [ 0.404 * M, 0, 0.78 * M ] },
      // Briefings for the structure parts (Session D, owner decision 1): the
      // five blanks got short codex entries so every click lands somewhere.
      { id: 'aft_deck', name: 'AFT THRUSTER DECK', risk: 'GREEN', tier: 'detail', codexId: 'aft_thruster_deck',
        massKg: 4, priority: 1, specs: ['Aft plate — 0.6 m deck'],
        mesh: 'AftThrusterDeck',
        anchor: [ 0, 0.20 * M, -1.008 * M ] },
    ],
  },
  {
    id: 'PAYLOAD', label: 'PAYLOAD',
    anchor: [ 0, 0.10 * M, 1.05 * M ],
    role: 'net launcher + spin-brake',
    parts: [
      { id: 'despin', name: 'SPIN-BRAKE LASER', risk: 'RED', tier: 'major', codexId: 'detumble',
        massKg: 9, priority: 9, live: 'despin',
        specs: ['Photon-pressure despin', '~5 W fibre laser'],
        // Gimbal child — dynamic so the anchor tracks if the turret articulates.
        // pick: the telescope + baffle bodies. LaserMuzzle stays the ANCHOR mesh
        // but is a geometry-less Object3D (PlayerSatellite.js:3255), so it can't
        // outline — the two real gimbal meshes carry the hover instead.
        mesh: 'LaserMuzzle', dynamic: true,
        pick: ['LaserTelescope', 'LaserBaffle'],
        anchor: [ -0.184 * M, 0.184 * M, 1.20 * M ] },
      { id: 'net_launcher', name: 'LARGE NET LAUNCHER', risk: 'GREEN', tier: 'major', codexId: 'miura_ori_net',
        massKg: 5, priority: 7, specs: ['Miura-ori net, ~5 m span'],
        pick: ['NetLauncher_0', 'NetLauncher_1'],
        anchor: [ 0, 0, 1.30 * M ] },
    ],
  },
  {
    id: 'SENSORS', label: 'SENSORS',
    anchor: [ 0, 0.26 * M, 1.12 * M ],
    role: 'tracking turret + cameras',
    parts: [
      { id: 'gimbal', name: 'SENSOR TURRET', risk: 'GREEN', tier: 'major', codexId: 'docking_precision',
        massKg: 5, priority: 6, specs: ['2-axis pointing platform'],
        // SensorGimbal itself is a geometry-less Group; pick its hub ring + the
        // four spokes (SensorSpoke ×4 share a name → traverse collects all).
        pick: ['SensorHubRing', 'SensorSpoke'],
        anchor: [ 0, 0, 1.00 * M ] },
      { id: 'eo_cam', name: 'DAYLIGHT CAMERA', risk: 'GREEN', tier: 'major', codexId: 'pose_estimation',
        massKg: 2, priority: 4, specs: ['Visible-band imager (EO)'],
        pick: ['EO_Camera'],
        anchor: [ 0.184 * M, 0.184 * M, 1.11 * M ] },
      { id: 'ir_cam', name: 'HEAT (INFRARED) CAM', risk: 'GREEN', tier: 'major', codexId: 'trackable_vs_dark',
        massKg: 2, priority: 4, specs: ['LWIR — spots dark debris'],
        pick: ['IR_Sensor'],
        anchor: [ -0.184 * M, -0.184 * M, 1.08 * M ] },
      { id: 'lidar', name: 'LASER RANGEFINDER', risk: 'GREEN', tier: 'major', codexId: 'lidar_ranging',
        massKg: 3, priority: 5, specs: ['Flash LIDAR — range + pose'],
        pick: ['LIDAR_Dome'],
        anchor: [ 0.184 * M, -0.184 * M, 1.10 * M ] },
      { id: 'star_trackers', name: 'STAR TRACKERS', risk: 'GREEN', tier: 'major', codexId: 'star_tracker',
        massKg: 1, priority: 3, specs: ['2× — attitude from starfield'],
        pick: ['StarTracker_0', 'StarTracker_1'],
        anchor: [ 0.042 * M, 0.398 * M, 0.90 * M ] },
      { id: 'fore_bulkhead', name: 'FORE BULKHEAD', risk: 'GREEN', tier: 'major', codexId: 'fore_bulkhead',
        massKg: 6, priority: 3, specs: ['Fore end cap — 0.8 m plate', 'Carries the sensor deck'],
        mesh: 'FrontCap_ConfigG',
        anchor: [ 0.30 * M, -0.28 * M, 1.005 * M ] },
      { id: 'sensor_deck', name: 'SENSOR DECK', risk: 'GREEN', tier: 'detail', codexId: 'sensor_deck',
        massKg: 2, priority: 2, specs: ['Instrument mounting annulus'],
        mesh: 'SensorDeck',
        anchor: [ 0, 0.30 * M, 1.03 * M ] },
      { id: 'sun_sensors', name: 'SUN SENSORS', risk: 'GREEN', tier: 'detail', codexId: 'sun_sensor',
        massKg: 0.5, priority: 2, specs: ['Coarse sun sensing, 4×'],
        pick: ['SunSensor_0', 'SunSensor_1', 'SunSensor_2', 'SunSensor_3'],
        anchor: [ 0.28 * M, -0.20 * M, 1.0 * M ] },
      { id: 'nav_lights', name: 'NAVIGATION LIGHTS', risk: 'GREEN', tier: 'detail', codexId: 'nav_lights',
        massKg: 1, priority: 1, specs: ['Port/starboard running lights'],
        anchor: [ 0.42 * M, 0, 0.30 * M ] },
    ],
  },
  {
    id: 'COMMS', label: 'COMMS',
    anchor: [ 0.363 * M, 0.169 * M, 0.87 * M ],
    role: 'radio omnis + antennas',
    parts: [
      { id: 'ttc', name: 'S-BAND RADIO OMNIS', risk: 'GREEN', tier: 'major', codexId: 'frequency_bands',
        massKg: 2, priority: 5, live: 'ttc', specs: ['Pair — command + telemetry'],
        pick: ['TTC_Omni_0'],
        anchor: [ 0, -0.40 * M, 0.92 * M ] },
      { id: 'mga', name: 'MEDIUM-GAIN ANTENNA', risk: 'GREEN', tier: 'detail', codexId: 'bandwidth_limits',
        massKg: 1, priority: 2, specs: ['Tangent patch, higher rate'],
        pick: ['MGA_Patch'],
        anchor: [ 0.363 * M, 0.169 * M, 0.87 * M ] },
      { id: 'gps', name: 'GPS ANTENNAS', risk: 'GREEN', tier: 'detail', codexId: 'gps_denied',
        massKg: 0.5, priority: 2, specs: ['GNSS patch pair'],
        pick: ['GPS_Patch_0', 'GPS_Patch_1'],
        anchor: [ 0.376 * M, -0.137 * M, 0.87 * M ] },
      // codexId remap (owner review, 2026-09-03): the aft whip is the second
      // half of the omni PAIR — one S-band radio system, one briefing
      // (`frequency_bands`: "a small omnidirectional antenna holds the link"),
      // like the two flower parts share theirs. `comms_blackout` (ionospheric
      // scintillation, reentry plasma) stays reachable by its own gameplay
      // unlock and the frequency_bands related chip.
      { id: 'ttc_aft', name: 'S-BAND OMNI (AFT)', risk: 'GREEN', tier: 'detail', codexId: 'frequency_bands',
        massKg: 1, priority: 1, specs: ['Aft whip of the omni pair'],
        pick: ['TTC_Omni_1'],
        anchor: [ 0, 0.40 * M, -0.92 * M ] },
    ],
  },
  {
    id: 'CAPTURE', label: 'CAPTURE',
    // Berth groove, centreline — next to the docked daughters, the only
    // capture hardware the player can actually SEE. The old fore-deck anchor
    // (z=+0.90, the hinge line) pointed at the opposite end from 3 of the
    // system's 4 parts and contradicted what it summarized (round 5).
    anchor: [ 0, 0.35 * M, -0.75 * M ],
    role: '4× daughter craft + berths',
    parts: [
      { id: 'berths', name: 'DAUGHTER BERTHS', risk: 'GREEN', tier: 'major', codexId: 'docking_berthing',
        massKg: 6, priority: 6, specs: ['4× — 2 large, 2 small', 'Spring ejector + hinge strut'],
        // az 60° pocket's aft lip (z=-0.85, hull rim of the carved groove) —
        // real hull edge, ~15 cm clear of the docked daughter's own callout,
        // whose anchor is the craft body mid-pocket (z=-0.70).
        anchor: [ 0.20 * M, 0.346 * M, -0.85 * M ] },
      { id: 'tether_reels', name: 'TETHER WINCHES', risk: 'GREEN', tier: 'major', codexId: 'reel_mechanics',
        massKg: 4, priority: 6, live: 'tether', specs: ['4× Dyneema SK78 reels'],
        // Reel cartridges ride the struts (stowed z≈−0.46, deployed ≈1.5 m out).
        // ReelCartridge_0 stays the ANCHOR mesh (reel #0 only); pick the 4 reel
        // housings so hover covers all four winches.
        mesh: 'ReelCartridge_0', dynamic: true,
        pick: ['ReelHousing_0', 'ReelHousing_1', 'ReelHousing_2', 'ReelHousing_3'],
        anchor: [ 0.20 * M, 0.346 * M, -0.46 * M ] },
      // codexId remap (owner review, 2026-09-03): the Double-A clevises are
      // the cradle struts' HINGES — `vacuum_mechanisms` ("Mechanisms in
      // Vacuum": cold-welding hinges, dry films) is their briefing, beside the
      // flower hinge family; `robotic_arm` describes the DAUGHTER craft, whose
      // cards already deep-link weaver_gripper / spinner_pad.
      { id: 'hinges', name: 'STRUT HINGES', risk: 'YELLOW', tier: 'detail', codexId: 'vacuum_mechanisms',
        massKg: 2, priority: 2, specs: ['Double-A clevis, 4×'],
        pick: ['AFrame_60_L', 'AFrame_60_R', 'AFrame_120_L', 'AFrame_120_R',
          'AFrame_240_L', 'AFrame_240_R', 'AFrame_300_L', 'AFrame_300_R'],
        anchor: [ 0.22 * M, 0.381 * M, 0.90 * M ] },
      { id: 'cradle_spring', name: 'CROSSBOW SPRING', risk: 'YELLOW', tier: 'detail', codexId: 'spring_energy',
        massKg: 1, priority: 2, specs: ['Spring ejector — launches daughters'],
        // Spring group rides the strut (stowed z≈−0.62, deployed ≈1.7 m out).
        // CrossbowSpring_0 stays the ANCHOR mesh (reel #0 only); pick the 4 spring
        // housings so hover covers all four ejectors.
        mesh: 'CrossbowSpring_0', dynamic: true,
        pick: ['SpringHousing_0', 'SpringHousing_1', 'SpringHousing_2', 'SpringHousing_3'],
        anchor: [ 0.20 * M, 0.346 * M, -0.62 * M ] },
      // NET LAUNCHERS (DAUGHTERS) deleted: that hardware lives on the ArmUnit
      // (ArmUnit.js:660-667), never on the Mother. The fact moved into the
      // daughter cards' specs (T3).
    ],
  },
  {
    // P2 thermal arc — the AFT FLOWER family (charter
    // .kilo/plans/1787839542000-phase2-flower-hardware-charter.md TASK F; hue
    // row lives in Constants.CALLOUTS.SYSTEM_HUES.THERMAL — BOTH places, or
    // the family renders fallback-hued). Purchase-gated hardware: every rec
    // carries `flowerGated` and hides until a pair is bought (the daughter
    // `_armGone` idiom), so no callout ever points at empty rim. Anchors are
    // STATIC station coordinates (the meshes may not exist pre-purchase, so
    // no `mesh:` refs here). The ship already carries the diegetic thermal
    // sensor — the HEAT (INFRARED) CAM callout under SENSORS.
    id: 'THERMAL', label: 'THERMAL',
    anchor: [ 0.283 * M, 0.283 * M, -1.02 * M ],
    role: 'aft flower — struts open LIKE A FLOWER',
    flowerGated: true,
    parts: [
      { id: 'flower_plates', name: 'RADIATOR PLATES', risk: 'GREEN', tier: 'major', codexId: 'space_radiator',
        massKg: 37, priority: 6, flowerGated: true,
        specs: ['4× 1.70×0.60 m panels along the struts', 'Reject heat as infrared — numbers come with the loop refit'],
        anchor: [ -0.30 * M, 0.30 * M, -1.15 * M ] },
      { id: 'flower_struts', name: 'AFT FLOWER STRUTS', risk: 'GREEN', tier: 'major', codexId: 'vacuum_mechanisms',
        massKg: 10, priority: 6, flowerGated: true,
        specs: ['4× aft-pivot booms, 2.5 m', 'They open LIKE A FLOWER — O deploys / stows'],
        anchor: [ 0.283 * M, 0.283 * M, -1.10 * M ] },
      { id: 'flower_tips', name: 'TIP HARDPOINTS', risk: 'GREEN', tier: 'detail', codexId: 'tip_hardpoints',
        massKg: 2, priority: 2, flowerGated: true,
        specs: ['Inert cargo bosses at the strut tips', 'Cold-cell refit will bolt on here'],
        anchor: [ -0.283 * M, -0.283 * M, -1.12 * M ] },
      { id: 'flower_hinges', name: 'FLOWER HINGE BRACKETS', risk: 'YELLOW', tier: 'detail', codexId: 'vacuum_mechanisms',
        massKg: 1, priority: 2, flowerGated: true,
        specs: ['Rim-band clevises, MoS₂-filmed pins', 'Hinges are the honest jam risk'],
        anchor: [ 0.283 * M, -0.283 * M, -0.94 * M ] },
    ],
  },
  {
    // Docked daughters — dynamic recs that follow each docked ArmUnit (T3).
    // Titles are static (berth i%2 alternates Large/Small, ArmManager.js:113),
    // so cards are built once; visibility is gated per frame on the arm's state.
    id: 'DAUGHTERS', label: 'DAUGHTERS',
    anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ],
    daughters: true,
    parts: [
      { id: 'daughter_0', name: 'LARGE DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'weaver_gripper',
        massKg: 6.6, priority: 7, live: 'daughter', armIndex: 0,
        specs: ['Weaver — medium net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
      { id: 'daughter_1', name: 'SMALL DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'spinner_pad',
        massKg: 3.7, priority: 7, live: 'daughter', armIndex: 1,
        specs: ['Spinner — small net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
      { id: 'daughter_2', name: 'LARGE DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'weaver_gripper',
        massKg: 6.6, priority: 7, live: 'daughter', armIndex: 2,
        specs: ['Weaver — medium net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
      { id: 'daughter_3', name: 'SMALL DAUGHTER', risk: 'GREEN', tier: 'major', codexId: 'spinner_pad',
        massKg: 3.7, priority: 7, live: 'daughter', armIndex: 3,
        specs: ['Spinner — small net', 'Tethered capture craft'],
        anchor: [ 0.20 * M, 0.35 * M, -0.70 * M ] },
    ],
  },
];

// LOD band edges, in METRES of camera-to-ship distance. Hysteresis: descend
// (zoom in) on the lower number, ascend (zoom out) on the higher.
const BAND = {
  partIn:  8.0,  partOut:  9.0,
  compIn:  5.5,  compOut:  6.5,
};

const GUIDE_STEP_S = 1.1;   // seconds each system stays highlighted in the tour
const GUIDE_HOLD_S = 0.6;   // initial hold before the tour starts

const FADE_RATE = 6.0;      // opacity ease rate for band crossfades
const LINE_OP_SCALE = 0.8;  // line opacity = labelOp × this (round 4: hairline)
const LINE_HALF_WIDTH_FRAC = 0.0012; // leader ribbon half-width / camera-ship dist (round 4: hairline)

// Hover stickiness (playtest 2026-09-03 "parts flicker"): the stationary 10 Hz
// re-pick (_refreshHover) keeps a held hover through this many consecutive
// misses minus one and clears it on the Nth (3 ticks ≈ 300 ms at 10 Hz). Only
// the stationary re-pick is sticky — see _refreshHover.
const HOVER_MISS_TICKS = 3;

// Hover-outline depth stagger (owner, 2026-09-03: "parts on the far side show
// through the mother — confusing"): the outline layers keep the depth test
// (so the hull occludes far-side layers and anything crossing in front of the
// part) and are pulled this far toward the camera each frame so they win the
// test against their OWN surface. 1.5 mm is ~150× the log-depth resolution at
// F3 (~10 µm at 7.7 m), under the ROSA blanket's 4 mm front/back gap (the
// hidden face's layer stays hidden), and ~0.15 px on screen at F3.
const HOVER_OUTLINE_STAGGER_M = 0.0015;

// REFIT ghost pulse (Wave 5 (2), 08-workbench §2: hovering an alternative
// "pulses the part's ghost outline on the hull"). Ghost recs' OWN outline
// materials oscillate between GHOST_PULSE_MIN× and 1× of their base opacity
// (lines 0.85, shell 0.3 — captured at _ensureOutline build) at
// GHOST_PULSE_HZ; bases are restored on clear. The hover rec never pulses
// (hover wins on overlap) and hull materials are never touched.
const GHOST_PULSE_HZ = 1.2;
const GHOST_PULSE_MIN = 0.35;

/**
 * One rec's outline-layer pull toward the camera already captured in
 * `self._vStagCam` (see _updateOutlineStagger — the only caller). A module
 * function, not a prototype method, so prototype-borrowing test rigs that
 * lift `_updateOutlineStagger` onto plain objects keep working; uses only
 * the rig-provided scratch vectors.
 * @param {MotherCallouts|object} self
 * @param {{lines:THREE.LineSegments[], shells:THREE.Mesh[]}|null} out
 */
function staggerOutlineLayers(self, out) {
  if (!out) return;
  const eps = HOVER_OUTLINE_STAGGER_M * M;
  const lines = out.lines;
  const shells = out.shells || [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parent = line.parent;
    if (!parent) continue;
    parent.updateWorldMatrix(true, false);
    parent.getWorldPosition(self._vStag);                         // P (parent origin, world)
    self._vStagDir.copy(self._vStagCam).sub(self._vStag);         // P → C
    const len = self._vStagDir.length();
    if (len > 1e-30) {
      self._vStag.addScaledVector(self._vStagDir, eps / len);     // P + ε·dir (world)
      parent.worldToLocal(self._vStag);                           // → offset in the parent's frame
    } else {
      self._vStag.set(0, 0, 0);
    }
    line.position.copy(self._vStag);
    const shell = shells[i];                                      // built pairwise with lines[i]
    if (shell) shell.position.copy(self._vStag);
  }
}

export class MotherCallouts {
  /**
   * @param {THREE.Object3D} playerGroup  The PlayerSatellite group (labels parent here).
   * @param {THREE.Camera}   camera
   * @param {object} [opts]
   * @param {HTMLCanvasElement|null} [opts.canvas]  Render canvas for pointer events.
   * @param {function|null} [opts.onPartClick]  Wave 5 (2) D-a hook (owner,
   *   2026-09-03): when set, a resolved part/card click calls
   *   `onPartClick(getHoveredPart())` INSTEAD of emitting CODEX_OPEN_ENTRY —
   *   main.js wires it to the REFIT pane ONLY while the ladder flag is on.
   *   Session D: with the hook set, parts WITHOUT a briefing are pickable and
   *   fire it too (their REFIT verb needs no entry; the record's codexId is
   *   null and the hub gates its library actions on it). Absent (the shipped
   *   default and every ?ladder=0 boot), the click emits exactly as shipped —
   *   briefing-less parts stay unpickable there. The ONE emitter in
   *   _handlePointerUp stays the one.
   */
  constructor(playerGroup, camera, { canvas = null, onPartClick = null } = {}) {
    this.player = playerGroup;
    this.camera = camera;
    this.canvas = canvas;
    this._onPartClick = onPartClick;

    this._active = false;
    this._band = 'SYSTEM';
    this._guideT = -1;
    this._guidedDone = false;
    this._focusPart = null;
    this._liveCtx = null;       // late-bound live-data context (task 7)
    this._lastLiveT = 0;        // live-refresh cadence guard
    this._bandChangedAt = 0;    // T3: timestamp of last band change (scan-in hold)
    this._revealSeq = 0;        // T3: stagger sequence counter
    this._nowMs = 0;            // T3: frame timestamp stored for _positionCard

    // Reusable scratch vectors (zero per-frame alloc).
    this._vShip = new THREE.Vector3();
    this._vCam = new THREE.Vector3();
    this._vAnchor = new THREE.Vector3();
    this._vTmp = new THREE.Vector3();
    this._vFace = new THREE.Vector3();
    this._vCamDir = new THREE.Vector3();
    this._qTmp = new THREE.Quaternion();
    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._shipNDC = new THREE.Vector3();
    this._vAttach = new THREE.Vector3();
    this._vElbow = new THREE.Vector3();
    // Ribbon-leader scratch.
    this._rA = new THREE.Vector3();
    this._rB = new THREE.Vector3();
    this._rDir = new THREE.Vector3();
    this._rView = new THREE.Vector3();
    this._rPerp = new THREE.Vector3();
    this._rMid = new THREE.Vector3();
    this._rC0 = new THREE.Vector3();
    this._rC1 = new THREE.Vector3();
    this._rC2 = new THREE.Vector3();
    this._rC3 = new THREE.Vector3();
    this._vCamLocal = new THREE.Vector3();
    this._leaderHalfWidth = 0;
    // Hover-outline stagger scratch (_updateOutlineStagger).
    this._vStag = new THREE.Vector3();
    this._vStagDir = new THREE.Vector3();
    this._vStagCam = new THREE.Vector3();

    // Per-frame projection state (populated in update()).
    this._halfH = 1; this._halfW = 1;
    this._railL = -0.5; this._railR = 0.5;
    // Workbench pane insets (Wave 5 Session B, 08-workbench §2): CSS-px widths
    // of the LEFT (REFIT) and RIGHT (TECH LIBRARY) panes while open, fed on
    // the panes' onOpenChange edge from main.js _syncWorkbenchPanes (the ONE
    // pane edge — never per frame). The column layout treats the covered
    // strips as the screen edges and the focus pick measures from the centre
    // of the UNCOVERED strip — where the camera's look-at bias puts the ship.
    // Both default 0: every formula below reduces to the shipped constants
    // and a ?ladder=0 boot (which never constructs a pane) is byte-identical.
    this._paneInsetL = 0;
    this._paneInsetR = 0;
    // Derived per frame in _updatePaneEdges(): the usable screen edges (NDC)
    // and the uncovered strip's centre X (NDC).
    this._edgeL = -1;
    this._edgeR = 1;
    this._stripCX = 0;

    // Clickable-label interaction (codex deep-links) + hull-part hover (D2's
    // first verb): the same 10 Hz pick tests the card sprites FIRST, then the
    // parts' `pick` hull meshes, so hovering/clicking the part itself behaves
    // exactly like its card (one hover state `_hoverRec`, written only by
    // _setHoverRec; one CODEX_OPEN_ENTRY emitter in _handlePointerUp).
    this._raycaster = new THREE.Raycaster();
    // The callouts group rides inside the player subtree, which SceneManager
    // registers as a NEAR_FIELD root — moving every sprite to
    // NEAR_FIELD_LAYER (layer 1) at close range. A default raycaster only
    // tests layer 0, so every pick silently missed at inspection depth and
    // click-to-open was dead (round 5 autopsy: spriteLayers 2 vs rcLayers 1,
    // ray dead-centre at 2.8e-14 miss distance). Test all layers: the pick
    // loop only ever sees these ~37 sprites, so the mask costs nothing.
    this._raycaster.layers.enableAll();
    this._ndc = new THREE.Vector2();
    this._pointerDown = null;
    this._hoverT = 0;
    this._cursorSet = false;
    this._listening = false;
    this._setHoverRec(null);   // one hover state, initialized through its ONE writer (source-pinned)
    // REFIT ghost outlines (Wave 5 (2)): the ONE ghost set — recs whose hover
    // outline is shown steady-on by the pane's alternative hover (reusing
    // _ensureOutline/_setOutlineVisible, 06-core-api: never a second outline
    // system). Pulsed in update() on the recs' OWN materials; the hover rec
    // wins on overlap. Source-pinned in test-MotherCallouts row l: the set is
    // constructed HERE exactly once — every other site mutates, never replaces.
    this._ghostRecs = new Set();
    this._ghostPulse = true;    // setGhostOutline({ pulse }) — false = steady
    this._ghostPhaseT = 0;      // pulse phase clock (s), reset on empty→shown
    this._pointerPos = null;   // last pointer client coords, for hover re-pick (R13)
    this._hoverPickT = 0;      // hover re-pick cadence guard (R13)
    this._hoverMisses = 0;     // consecutive stationary re-pick misses with a hover held (stickiness)
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onPointerCancel = () => { this._pointerDown = null; };
    this._onPointerLeave = () => this._handlePointerLeave();

    this._group = new THREE.Group();
    this._group.name = 'MotherCallouts';
    this._group.visible = false;
    this.player.add(this._group);

    this._partLabels = [];
    this._allRecs = []; // cached union of system + part labels (LOW-16)
    this._leftRail = [];  // persistent rail arrays (LOW-16)
    this._rightRail = [];
    this._build();

    this._viewInspect = false;
    this._zoomInspect = false;
    // A general TRANSIENT show/hide gate mirroring CityLabels.setSuppressed:
    // active = (viewInspect || zoomInspect) && !suppressed. Never persisted;
    // the inspection signals (CAMERA_VIEW_CHANGE / INSPECT_HULL_OUTLINE) keep
    // owning the resting state, so clearing it restores exactly what they say.
    // NOT used by the Zoom Ladder since 2026-09-02: the morning's "F3 single
    // costume" suppressed these cards on the hull floor and the owner's
    // playtest overturned it the same day — MotherCallouts IS the F3 costume
    // (docs/ladder/08-workbench.md §2). Nothing calls setSuppressed in
    // production today; with `_suppressed` false `_applyActive()` reduces to
    // the pre-ladder `viewInspect || zoomInspect`.
    this._suppressed = false;
    this._onViewChange = ({ view } = {}) => {
      this._viewInspect = (view === 'INSPECTION');
      this._applyActive();
    };
    this._onHullOutline = ({ visible } = {}) => {
      this._zoomInspect = !!visible;
      this._applyActive();
    };
    eventBus.on(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.on(Events.INSPECT_HULL_OUTLINE, this._onHullOutline);
  }

  /** @returns {boolean} true while the transient gate hides the sprite cards (unused in production today). */
  isSuppressed() { return this._suppressed; }

  /**
   * General transient show/hide gate (CityLabels.setSuppressed parity): hides
   * the in-world sprite cards while the hull outline (INSPECT_HULL_OUTLINE)
   * keeps working unmodified. NEVER persists and never touches the inspection
   * flags: `active = inspecting && !suppressed`. Not used by the ladder since
   * 2026-09-02 (the F3 "single costume" was overturned by playtest —
   * MotherCallouts is the F3 costume); nothing calls it in production today.
   * Kept as the house gate for any future per-floor suppression.
   * @param {boolean} v
   */
  setSuppressed(v) {
    v = !!v;
    if (v === this._suppressed) return;
    this._suppressed = v;
    this._applyActive();
  }

  /** @private Resolve the activation gate: inspecting (either signal) and not suppressed. */
  _applyActive() {
    this._setActive((this._viewInspect || this._zoomInspect) && !this._suppressed);
  }

  /**
   * Late-bind the live-data context (task 7). Called from main.js after all
   * systems are constructed (construction-order gotcha: motherCallouts is built
   * before commsSystem). Every reference is optional — cards degrade to static
   * rows if a system is missing.
   * @param {object} ctx { resourceSystem, commsSystem, codexSystem,
   *   powerDistribution, tetherReel, despinLaser, player }
   */
  setLiveCtx(ctx) {
    this._liveCtx = ctx || null;
  }

  /**
   * Workbench pane insets (Wave 5 Session B — the 06-core-api "Known
   * non-consumer" FINDINGS, now consumed): the CSS-px widths of the LEFT
   * (REFIT) and RIGHT (TECH LIBRARY) panes while open, 0 when closed. Fed
   * from main.js `_syncWorkbenchPanes()` on the panes' onOpenChange edge —
   * the ONE pane-edge signal (beside the D10 calm cap and the camera's
   * look-at inset), NEVER per frame. Effect (see _updatePaneEdges): the
   * callout columns treat the left screen edge as `leftPx` and the right
   * edge as `W − rightPx` (cards never under a pane), and _pickFocusPart
   * measures "nearest screen-centre" from the centre of the UNCOVERED strip
   * — which is where the camera's pane bias now puts the ship. Non-finite /
   * negative values clamp to 0 (never a guess).
   * @param {number} leftPx  - LEFT pane width while open (REFIT), else 0
   * @param {number} rightPx - RIGHT pane width while open (TECH LIBRARY), else 0
   */
  setPaneInsets(leftPx, rightPx) {
    this._paneInsetL = (Number.isFinite(leftPx) && leftPx > 0) ? leftPx : 0;
    this._paneInsetR = (Number.isFinite(rightPx) && rightPx > 0) ? rightPx : 0;
  }

  /**
   * Derive the usable screen edges (NDC) + the uncovered strip's centre from
   * the pane insets — once per update(), before the rail X computation reads
   * them. The px→NDC conversion follows the CameraSystem pane-bias law: the
   * viewport width is the render CANVAS's clientWidth (SceneManager sizes it
   * to innerWidth — the same number camera.aspect is built from; never
   * `window`), and an unknown width means NO inset — never a guess. A
   * degenerate strip (panes covering ~everything, < 0.2 NDC ≈ 10 % of the
   * screen) falls back to the full edges rather than inverting the rails —
   * the hub's <1100 px one-pane rule keeps real layouts far from this.
   * Insets 0 (every shipped boot) → (-1, 1, 0): the exact shipped operands.
   * @private
   */
  _updatePaneEdges() {
    let eL = -1, eR = 1;
    if (this._paneInsetL > 0 || this._paneInsetR > 0) {
      const vw = (this.canvas && Number.isFinite(this.canvas.clientWidth))
        ? this.canvas.clientWidth : 0;
      if (vw > 0) {
        eL = -1 + 2 * this._paneInsetL / vw;
        eR = 1 - 2 * this._paneInsetR / vw;
        if (eR - eL < 0.2) { eL = -1; eR = 1; }
      }
    }
    this._edgeL = eL;
    this._edgeR = eR;
    this._stripCX = (eL + eR) / 2;
  }

  /**
   * The part the player is looking at — the Zoom Ladder's F1 deep-link source
   * (docs/ladder/08-workbench.md D1/D2: the Tech Library opens FROM the part
   * you were looking at). In the COMPONENT band (< BAND.compIn, the close lens
   * of the 5 m split) `_focusPart` is the major part nearest screen-centre,
   * re-picked every update(); outside that band there is no focus and this
   * returns null. Pure read; the small allocation is fine — main.js calls it
   * only on an F1 arrival (ArchiveFloor.getSubject), never per frame.
   * `codexId` is the part table's entry id/alias exactly as CodexSystem
   * resolves it (the same string the card click emits in CODEX_OPEN_ENTRY);
   * parts without a briefing report `codexId: null`, which ArchiveFloor treats
   * as "no link" (plain arrival).
   * @returns {{ id: string, name: string, codexId: string|null, systemId: string }|null}
   */
  getFocusedPart() {
    if (this._band !== 'COMPONENT') return null;
    const rec = this._focusPart;
    if (!rec || !rec.def) return null;
    const def = rec.def;
    return {
      id: def.id,
      name: def.name,
      codexId: (typeof def.codexId === 'string') ? def.codexId : null,
      systemId: rec.sysId,
    };
  }

  /**
   * The part under the pointer — card sprite or hull `pick` mesh, one hover
   * state (`_hoverRec`), same record shape as getFocusedPart(). NO band gate:
   * hover exists wherever a part's card is eligible (PART and COMPONENT bands;
   * in the SYSTEM band nothing on the hull hovers). Null when nothing is
   * hovered. Pure read; allocates a fresh object per call — never call it per
   * frame.
   * @returns {{ id: string, name: string, codexId: string|null, systemId: string }|null}
   */
  getHoveredPart() {
    const rec = this._hoverRec;
    if (!rec || !rec.def) return null;
    const def = rec.def;
    return {
      id: def.id,
      name: def.name,
      codexId: (typeof def.codexId === 'string') ? def.codexId : null,
      systemId: rec.sysId,
    };
  }

  /**
   * REFIT ghost outlines (Wave 5 (2)): show the hover outline steady-on for a
   * set of parts — the pane's "hover an alternative → the hardware pulses
   * cyan on the hull" affordance. REUSES the one outline system
   * (_ensureOutline + _setOutlineVisible, 06-core-api.md:551-553: "do not
   * build a second outline system"); update() pulses the ghost recs' OWN
   * materials 0.35×–1× of base at 1.2 Hz and _updateOutlineStagger staggers
   * them exactly like the hover.
   *
   * Rules:
   *   - ids resolving to card-only parts (no pick geometry → _ensureOutline
   *     null) and unknown ids are SKIPPED, never thrown on (D-c: unowned
   *     hardware without a mesh cannot ghost — a FINDING, not a feature);
   *   - inactive (`!_active`): nothing is shown (every id reports skipped);
   *   - `setGhostOutline(null)` clears: hides every ghost that is not the
   *     live `_hoverRec` and restores base opacities;
   *   - the hover rec wins on overlap (steady base, no pulse) and clearing
   *     ghosts never hides a live hover.
   * Allocates (a scratch set + the report) — call on hover edges, never per
   * frame.
   * @param {string[]|null} partIds — MotherCallouts part ids (refitIndex.partsForSubsystem output)
   * @param {{ pulse?: boolean }} [opts] — pulse=false holds the ghosts steady at base
   * @returns {{ shown: string[], skipped: string[] }}
   */
  setGhostOutline(partIds, { pulse = true } = {}) {
    const shown = [];
    const skipped = [];
    const want = Array.isArray(partIds) ? partIds : [];
    const next = new Set();
    for (const id of want) {
      const rec = this._active ? this._partLabels.find((p) => p.def.id === id) : null;
      if (!rec || !this._ensureOutline(rec)) { skipped.push(id); continue; }
      next.add(rec);
      shown.push(id);
    }
    // Recs leaving the set: restore base opacities and hide — unless the rec
    // is the live hover, which keeps its outline (steady, as a plain hover).
    for (const rec of this._ghostRecs) {
      if (next.has(rec)) continue;
      this._restoreGhostBase(rec);
      if (rec !== this._hoverRec) this._setOutlineVisible(rec, false);
    }
    const hadAny = this._ghostRecs.size > 0;
    this._ghostRecs.clear();
    for (const rec of next) {
      this._ghostRecs.add(rec);
      this._setOutlineVisible(rec, true);
    }
    this._ghostPulse = !!pulse;
    if (!hadAny && this._ghostRecs.size) this._ghostPhaseT = 0; // pulse starts at full
    // Staggered on their very first drawn frame (the hover-write precedent).
    this._updateOutlineStagger();
    return { shown, skipped };
  }

  /**
   * The callout parts of one MotherCallouts system — the REFIT pane's
   * focusPart/ghost bookkeeping read. `hasGeometry` reports whether the part
   * can outline on the hull (its pick subtree resolves to ≥1 real Mesh):
   * card-only parts (mli, berths, nav_lights…) and the docked daughters
   * report false — D-c: no unowned-hardware ghosts. Allocates a fresh array
   * of fresh records — never call per frame.
   * @param {string} systemId — a MOTHER_CALLOUT_SYSTEMS id (e.g. 'POWER')
   * @returns {Array<{ id: string, name: string, codexId: string|null, systemId: string, hasGeometry: boolean }>}
   */
  getPartsBySystem(systemId) {
    const out = [];
    for (const rec of this._partLabels) {
      if (rec.sysId !== systemId) continue;
      const def = rec.def;
      let hasGeometry = false;
      for (const target of this._pickTargets(rec)) {
        target.traverse((o) => {
          if (o.isMesh && o.geometry?.attributes?.position && !o.userData.partId) hasGeometry = true;
        });
        if (hasGeometry) break;
      }
      out.push({
        id: def.id,
        name: def.name,
        codexId: (typeof def.codexId === 'string') ? def.codexId : null,
        systemId: rec.sysId,
        hasGeometry,
      });
    }
    return out;
  }

  /** @private Restore a ghost rec's outline materials to their build-time base
   *  opacities (no-op without an outline; tolerates hand-built outlines
   *  without base fields by leaving their current opacity). */
  _restoreGhostBase(rec) {
    const out = rec && rec._outline;
    if (!out) return;
    if (out.lineBaseOp != null) out.material.opacity = out.lineBaseOp;
    if (out.shellBaseOp != null && out.shellMaterial) out.shellMaterial.opacity = out.shellBaseOp;
  }

  /** @private Empty the ghost set: bases restored, non-hover outlines hidden.
   *  Used by _setActive(false), dispose() and guarded so rigs without the set
   *  never reach it. */
  _clearGhosts() {
    if (!this._ghostRecs || !this._ghostRecs.size) return;
    for (const rec of this._ghostRecs) {
      this._restoreGhostBase(rec);
      if (rec !== this._hoverRec) this._setOutlineVisible(rec, false);
    }
    this._ghostRecs.clear();
  }

  /**
   * @private Per-frame ghost pulse (update() tail): every ghost rec's OWN
   * outline materials oscillate GHOST_PULSE_MIN×–1× of base at GHOST_PULSE_HZ
   * — never a hull material, never the hover rec (hover wins on overlap:
   * held steady at base). pulse=false ghosts hold base. No allocation.
   */
  _updateGhostPulse(dt) {
    const ghosts = this._ghostRecs;
    if (!ghosts || !ghosts.size) return;
    this._ghostPhaseT += dt;
    // 1 → GHOST_PULSE_MIN → 1 (starts at full brightness on a fresh set).
    const f01 = 0.5 - 0.5 * Math.cos(2 * Math.PI * GHOST_PULSE_HZ * this._ghostPhaseT);
    const factor = 1 - (1 - GHOST_PULSE_MIN) * f01;
    for (const rec of ghosts) {
      const out = rec._outline;
      if (!out) continue;
      const steady = (rec === this._hoverRec) || !this._ghostPulse;
      if (out.lineBaseOp != null) {
        out.material.opacity = steady ? out.lineBaseOp : out.lineBaseOp * factor;
      }
      if (out.shellBaseOp != null && out.shellMaterial) {
        out.shellMaterial.opacity = steady ? out.shellBaseOp : out.shellBaseOp * factor;
      }
    }
  }

  // --------------------------------------------------------------------------
  // BUILD
  // --------------------------------------------------------------------------

  /** Shared target-bracket texture for leader anchor markers. @private */
  static _dotTexture() {
    if (MotherCallouts._dotTex) return MotherCallouts._dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    // White — _makeDot tints via material.color, and hover brightening reads it.
    // Round 5: thicker strokes + bigger centre dot — at DOT_SIZE 0.016 the
    // sprite lands ~17 px at 1080p; 5 px texture strokes ≈ 1.3 px on screen,
    // and the r=4 core keeps a solid point readable even when ticks blur over
    // bright hull (gold MLI / white dome washed the old 3 px/r=2 version out).
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 5;
    const t = 16; // tick length
    const m = 4;  // margin from edge
    // Four corner ticks (L-shaped brackets).
    // top-left
    ctx.beginPath(); ctx.moveTo(m, m + t); ctx.lineTo(m, m); ctx.lineTo(m + t, m); ctx.stroke();
    // top-right
    ctx.beginPath(); ctx.moveTo(64 - m - t, m); ctx.lineTo(64 - m, m); ctx.lineTo(64 - m, m + t); ctx.stroke();
    // bottom-left
    ctx.beginPath(); ctx.moveTo(m, 64 - m - t); ctx.lineTo(m, 64 - m); ctx.lineTo(m + t, 64 - m); ctx.stroke();
    // bottom-right
    ctx.beginPath(); ctx.moveTo(64 - m - t, 64 - m); ctx.lineTo(64 - m, 64 - m); ctx.lineTo(64 - m, 64 - m - t); ctx.stroke();
    // Centre dot.
    ctx.beginPath(); ctx.arc(32, 32, 4, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    MotherCallouts._dotTex = tex;
    return tex;
  }

  /** Card sprite (texture assigned lazily). @private */
  _makeCardSprite() {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
    }));
    sprite.renderOrder = 30;
    sprite.frustumCulled = false;
    return sprite;
  }

  /**
   * Two-segment elbow leader as camera-facing ribbon quads (8 verts / 4 tris).
   * Positions rewritten each frame in _setElbowLocal.
   * @private
   */
  _makeLine(color) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24), 3)); // 8 verts
    geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    const line = new THREE.Mesh(geo, mat);
    line.renderOrder = 29;
    line.frustumCulled = false;
    return line;
  }

  /** Small filled marker where a leader touches its part. @private */
  _makeDot(color) {
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: MotherCallouts._dotTexture(),
      color: new THREE.Color(color),
      transparent: true, opacity: 0.0, depthWrite: false, depthTest: false,
    }));
    dot.renderOrder = 31;
    dot.frustumCulled = false;
    return dot;
  }

  _build() {
    for (const sys of SYSTEMS) {
      const hue = HUES[sys.id] || HUES.CAPTURE; // DAUGHTERS reuses the CAPTURE hue
      const sLabel = this._makeCardSprite();
      const sLine = this._makeLine(hue);
      const sDot = this._makeDot(hue);
      this._group.add(sLine, sDot, sLabel);
      const sRec = {
        def: sys, isSystem: true, hue, sprite: sLabel, line: sLine, dot: sDot,
        op: 0, side: null, sx: 0, sy: 0, primed: false,
        cardKey: null, card: null,
        anchor: new THREE.Vector3(...sys.anchor),
        _mesh: null, _meshTried: false,
        _pickObjs: null, _pickTried: false,
        _outline: null, _outlineTried: false,
        _cardCache: null, _railOrder: null, _targetOp: 0,
        _h: 0, _wasFocus: false, _isFocus: false,
        _anchorX: 0, _anchorY: 0, _anchorZ: 0,
        _armGone: false, _revealAt: null,
        _pendingSide: null, _sideT: 0,
      };
      this._applyCard(sRec); // initial static card
      this._allRecs.push(sRec);
      // The DAUGHTERS pseudo-group has no visible system label — its parts are
      // the docked craft themselves (T3); keep the rec for the tour but never show.
      if (sys.daughters) sRec._neverShow = true;

      for (const part of sys.parts) {
        const pLabel = this._makeCardSprite();
        const color = RISK[part.risk] || RISK.GREEN;
        const pLine = this._makeLine(hue);
        const pDot = this._makeDot(hue);
        this._group.add(pLine, pDot, pLabel);
        const rec = {
          def: part, sysId: sys.id, hue, isDetail: part.tier === 'detail',
          riskColor: color, sprite: pLabel, line: pLine, dot: pDot,
          op: 0, side: null, sx: 0, sy: 0, primed: false,
          cardKey: null, card: null,
          anchor: new THREE.Vector3(...part.anchor),
          _mesh: null, _meshTried: false,
          _pickObjs: null, _pickTried: false,
          _outline: null, _outlineTried: false,
          _cardCache: null, _railOrder: null, _targetOp: 0,
          _h: 0, _wasFocus: false, _isFocus: false,
          _anchorX: 0, _anchorY: 0, _anchorZ: 0,
          _armGone: false, _revealAt: null,
          _pendingSide: null, _sideT: 0,
        };
        this._applyCard(rec);
        this._partLabels.push(rec);
        this._allRecs.push(rec);
      }
    }
  }

  /**
   * Resolve a rec's anchor for this frame (T1). Static parts copy their table
   * coordinate; `mesh` parts resolve from the live PlayerSatellite mesh (once,
   * cached); `dynamic` parts re-resolve every frame because the mesh moves
   * (strut-mounted reels/springs); daughter recs follow their docked ArmUnit.
   * Falls back to the static coordinate with a one-time warn on a mesh miss.
   * @private
   */
  _resolveAnchor(rec) {
    const def = rec.def;
    // P2: the THERMAL family hides until a flower pair is purchased (the
    // daughter `_armGone` idiom) — purchase-gated hardware never gets a
    // floating label pointing at empty rim.
    if (def.flowerGated) {
      rec._flowerGone = !this._flowerOn();
    }
    // Daughter recs follow their docked ArmUnit (T3).
    if (def.armIndex !== undefined) {
      const arm = this._liveCtx?.armManager?.arms?.[def.armIndex];
      if (arm && arm.state === Constants.ARM_STATES.DOCKED && arm.group) {
        arm.group.getWorldPosition(this._vTmp);
        this.player.worldToLocal(this._vTmp);
        rec.anchor.copy(this._vTmp);
        rec._armGone = false;
      } else {
        rec._armGone = true; // away or missing → hidden by _targetOpacity
      }
      return;
    }
    if (!def.mesh) {
      rec.anchor.set(def.anchor[0], def.anchor[1], def.anchor[2]);
      return;
    }
    if (!rec._mesh && !rec._meshTried) {
      rec._meshTried = true;
      rec._mesh = this.player.getObjectByName(def.mesh) || null;
      if (!rec._mesh && typeof console !== 'undefined') {
        console.warn(`[MotherCallouts] mesh "${def.mesh}" not found for "${def.name}" — using static anchor`);
      }
    }
    if (rec._mesh) {
      // Static meshes resolve once and cache; `dynamic` meshes (strut-mounted
      // reels/springs, gimbal children) re-resolve every frame.
      if (rec._meshResolved && !def.dynamic) return;
      rec._mesh.getWorldPosition(this._vTmp);
      this.player.worldToLocal(this._vTmp);
      rec.anchor.copy(this._vTmp);
      rec._meshResolved = true;
    } else {
      rec.anchor.set(def.anchor[0], def.anchor[1], def.anchor[2]);
    }
  }

  // --------------------------------------------------------------------------
  // CARD TEXTURE MANAGEMENT
  // --------------------------------------------------------------------------

  /** Codex link state for a part: 'linked' | 'locked' | null. @private */
  _codexState(def) {
    if (!def.codexId) return null;
    const cs = this._liveCtx?.codexSystem;
    if (!cs || typeof cs.getEntry !== 'function') return 'linked';
    const entry = cs.getEntry(def.codexId);
    if (!entry) {
      // A codexId that no longer resolves would render a clickable ▸ that
      // silently no-ops (CodexViewerUI.openEntry returns false). Treat it as
      // unlinked and warn once so the drift is loud, not invisible.
      if (!MotherCallouts._warnedMissingCodex) MotherCallouts._warnedMissingCodex = new Set();
      if (typeof console !== 'undefined' && !MotherCallouts._warnedMissingCodex.has(def.codexId)) {
        MotherCallouts._warnedMissingCodex.add(def.codexId);
        console.warn(`[MotherCallouts] codexId "${def.codexId}" for "${def.name || def.id}" does not resolve — no deep-link`);
      }
      return null;
    }
    return entry.unlocked ? 'linked' : 'locked';
  }

  /** Codex entry title for a part's linked entry, or null. @private */
  _codexTitle(def) {
    if (!def.codexId) return null;
    const cs = this._liveCtx?.codexSystem;
    if (!cs || typeof cs.getEntry !== 'function') return null;
    const e = cs.getEntry(def.codexId);
    return (e && e.title) ? e.title : null;
  }

  /** Read TRL for a part's codex entry, or null. @private */
  _partTRL(def) {
    const cs = this._liveCtx?.codexSystem;
    if (!def.codexId || !cs || typeof cs.getEntry !== 'function') return null;
    const e = cs.getEntry(def.codexId);
    return (e && typeof e.trl === 'number') ? e.trl : null;
  }

  /**
   * Build the spec for a rec's current state and (re)generate its card texture
   * only when the content string changes. `full` → focused detail card with
   * spec/TRL/live rows; otherwise a compact title-only card.
   *
   * Cards are cached per rec by VARIANT ('compact' | 'focused'), not by content,
   * so a live-data refresh on the focused card regenerates only that variant and
   * never evicts the permanently-resident compact card (round-2 R3/R14).
   * @private
   */
  _applyCard(rec, { full = false } = {}) {
    const def = rec.def;
    const codex = rec.isSystem ? null : this._codexState(def);
    let rows = [];
    // Round 5: system cards get a single dim role line — a title-only chip
    // made the player guess what the system IS (CAPTURE was the worst case:
    // it pointed at an invisible hinge line with no explanation).
    if (rec.isSystem && def.role) rows.push({ text: def.role });
    if (full && !rec.isSystem) {
      // Deterministic row budget: 6 slots total.
      // Locked: reserve hint lines (1-2), fill [mass, ...specs, ...live(≤2)], append hint last. TRL dropped.
      // Unlocked: [mass, ...specs(≤2), ...live(≤2), TRL], capped at 6.
      const isLocked = codex === 'locked';
      // Only the first two live rows survive the budget (R12).
      const live = this._liveRows(def).slice(0, 2);

      // Pre-wrap the unlock hint with the single shared wrap implementation;
      // its line count IS the budget reservation, so budget and draw agree (review).
      let hintLines = [];
      if (isLocked) {
        const hintText = this._liveCtx?.codexSystem?.getUnlockHint?.(def.codexId) || null;
        if (hintText) hintLines = wrapHint(hintText, 2);
      }

      const budget = 6 - hintLines.length;
      if (typeof def.massKg === 'number') rows.push({ text: `Mass: ${def.massKg} kg` });
      if (Array.isArray(def.specs)) {
        for (const s of def.specs.slice(0, 2)) rows.push({ text: s });
      }
      for (const lr of live) rows.push({ text: lr, dim: false });

      // Deep-link affordance NAMES its destination (round 6): the row shows the
      // exact Tech Library entry the click opens, not a generic "open tech
      // library". Pushed before TRL so it survives the budget slice.
      const codexTitle = codex ? this._codexTitle(def) : null;
      if (codex === 'linked') {
        rows.push({ text: `▸ ${codexTitle || 'open tech library'}`, dim: true, color: rec.hue });
        const trl = this._partTRL(def);
        if (trl != null) rows.push({ text: `Readiness: L${trl}`, dim: true });
      } else if (codex === 'locked' && codexTitle) {
        // Locked cards still name where the ▸ leads (amber, matches the hint).
        rows.push({ text: `▸ ${codexTitle}`, dim: true, color: '#ffaa00' });
      } else if (codex === null) {
        // Structural part with no briefing — explain the dead click (round 6).
        rows.push({ text: 'structure — no briefing', dim: true });
      }

      rows = rows.slice(0, budget);

      // Hint lines appended last, amber (R8).
      for (const line of hintLines) {
        rows.push({ text: line, dim: false, color: '#ffaa00' });
      }
    }
    const title = rec.isSystem ? def.label : def.name;
    const variant = full ? 'focused' : 'compact';
    const key = [
      title, rec.isSystem ? 'sys' : def.risk, codex || '-',
      full ? rows.map((r) => r.text).join('|') : 'compact',
    ].join('::');

    // Early-out: content unchanged → keep the current texture (R3).
    if (rec.cardKey === key && rec.card) return;

    // Reuse the cached variant if its content key still matches.
    if (!rec._cardCache) rec._cardCache = new Map();
    const cached = rec._cardCache.get(variant);
    if (cached && cached.contentKey === key) {
      rec.card = cached;
      rec.cardKey = key;
      rec.sprite.material.map = cached.texture;
      rec.sprite.material.needsUpdate = true;
      return;
    }

    // Generate a fresh card for this variant.
    const card = createCardTexture({
      title,
      titleColor: rec.isSystem ? rec.hue : CFG.INK,
      rows,
      riskColor: rec.isSystem ? null : rec.riskColor,
      systemColor: rec.hue,
      inkColor: CFG.INK,
      inkDimColor: CFG.INK_DIM,
      codex,
    });
    card.contentKey = key;
    // Dispose only the previous entry for THIS variant (not the other variant).
    if (cached && cached.texture) cached.texture.dispose();
    rec._cardCache.set(variant, card);
    rec.card = card;
    rec.cardKey = key;
    rec.sprite.material.map = card.texture;
    rec.sprite.material.needsUpdate = true;
  }

  /**
   * Dynamic live-data rows for a part (graceful degradation: returns [] if the
   * live context or a referenced system is absent). @private
   */
  _liveRows(def) {
    const ctx = this._liveCtx;
    if (!ctx || !def.live) return [];
    const out = [];
    try {
      switch (def.live) {
        case 'rosa': {
          if (ctx.powerDistribution?.getSolarInput) {
            out.push(`Solar: ${Math.round(ctx.powerDistribution.getSolarInput())} W`);
          }
          // Wings state (round-3 T10): makes the furl state legible on the card.
          // Supersedes round-2 R12's Battery row — battery is already on the HUD.
          const furl = ctx.player?._rosaFurlProgress;
          if (typeof furl === 'number') {
            out.push(furl >= 0.98 ? 'Wings: DEPLOYED' : furl <= 0.02 ? 'Wings: FURLED' : `Wings: ${Math.round(furl * 100)}%`);
          }
          break;
        }
        case 'feep': {
          const rs = ctx.resourceSystem;
          if (rs?.getStatus && typeof rs.getStatus === 'function') {
            const st = rs.getStatus();
            // currentFuelName may be a cargo-fed metal (fromCargo), which is NOT
            // drawn from the xenon tank — don't report xenon kg under its name (R4).
            const fuel = rs.getCurrentFuel?.();
            if (fuel && !fuel.fromCargo) {
              out.push(`Fuel: ${st.currentFuelName} ${Math.round(st.xenon)}/${st.xenonMax} kg`);
            } else if (fuel) {
              out.push(`Fuel: ${st.currentFuelName} (cargo)`);
            } else {
              out.push(`Fuel: ${Math.round(st.xenon)}/${st.xenonMax} kg`);
            }
          }
          // No "Thrust" row: its data source (player.thrustInput) is dead —
          // thrustIon/thrustColdGas/thrustMPD have no production callers and
          // _applyThrust zeroes the accumulator before callouts update (review).
          break;
        }
        case 'tether': {
          const tr = ctx.tetherReel;
          if (tr?.getAllReelStates) {
            const states = tr.getAllReelStates() || [];
            const active = states.filter((s) => s?.state && s.state !== 'STOWED').length;
            out.push(`Reels active: ${active}/${states.length || 4}`);
          } else if (tr?.getReelState) {
            out.push(`Reel 0: ${tr.getReelState(0) ?? '—'}`);
          }
          break;
        }
        case 'ttc': {
          const cm = ctx.commsSystem;
          if (cm?.getSuppressionTier) {
            const tier = cm.getSuppressionTier();
            out.push(`Link: ${tier > 0 ? `SUPPRESSED (${tier})` : 'NOMINAL'}`);
          }
          break;
        }
        case 'despin': {
          if (ctx.despinLaser?.isFiring) {
            out.push(`Laser: ${ctx.despinLaser.isFiring() ? 'FIRING' : 'safe'}`);
          }
          break;
        }
        case 'daughter': {
          const arm = ctx.armManager?.arms?.[def.armIndex];
          if (arm) {
            if (typeof arm.fuel === 'number') out.push(`Fuel: ${Math.round(arm.fuel)}%`);
            out.push(`Spring: ${arm.springCharged ? 'charged' : 'reloading'}`);
          }
          break;
        }
      }
    } catch (_e) { /* live data is best-effort; never throw from a card build */ }
    return out;
  }

  // --------------------------------------------------------------------------
  // ACTIVATION
  // --------------------------------------------------------------------------

  _setActive(on) {
    if (this._active === on) return;
    this._active = on;
    this._group.visible = on;
    if (on) {
      if (!this._guidedDone) this._guideT = -GUIDE_HOLD_S;
      this._band = 'SYSTEM';
      this._attachPointer();
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: 'SYSTEM' });
      // Refresh all compact cards so codex lock state is current (MED-9).
      // Content-key check makes unchanged cards a no-op (R3).
      for (const rec of this._allRecs) {
        rec._revealAt = null; // T3: no stale reveal hold across re-entry
        rec._pendingSide = null; // T4: no stale flip across re-entry
        rec._sideT = 0;
        this._applyCard(rec, { full: false });
      }
    } else {
      this._guideT = -1;
      this._focusPart = null;
      // Round 6: the guided tour is a one-shot. Mark it done on the first exit so
      // a quick dip in/out of inspection can't replay the dim tour indefinitely.
      this._guidedDone = true;
      this._detachPointer();
      this._setHoverRec(null); // canvas-less instances never attach — clear hover explicitly
      // Wave 5 (2): REFIT ghost outlines clear with the costume (bases
      // restored, set emptied) — guarded so prototype-borrowing rigs without
      // the set skip it; the explicit hide-all below catches every layer.
      if (this._ghostRecs) this._clearGhosts();
      // T4: hover outlines are children of the hull meshes, NOT of this._group,
      // so `_group.visible = false` cannot hide them — hide each one explicitly.
      for (const p of this._partLabels) this._setOutlineVisible(p, false);
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: null });
    }
  }

  // --------------------------------------------------------------------------
  // CLICKABLE LABELS → CODEX DEEP-LINKS
  // --------------------------------------------------------------------------

  _attachPointer() {
    if (this._listening || !this.canvas) return;
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this._listening = true;
  }

  _detachPointer() {
    if (!this._listening || !this.canvas) return;
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this._listening = false;
    this._pointerDown = null;
    this._handlePointerLeave();   // clears _hoverRec (outline off), _pointerPos, cursor
    this._restoreCursor();
  }

  _restoreCursor() {
    if (this._cursorSet && typeof document !== 'undefined') {
      document.body.style.cursor = '';
      this._cursorSet = false;
    }
  }

  _pointerNDC(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this._ndc;
  }

  /**
   * Card/part pick eligibility — ONE gate for hover, click, card and mesh, so
   * they can never drift apart (round 6). Two tiers since Wave 5 Session D:
   *
   *   CARD (`mesh` false — the sprite loop): EXACTLY the shipped visibility
   *   filter — the sprite is drawn and past the legibility gate — so a card
   *   is pickable precisely when the player can read it.
   *
   *   MESH (`mesh` true — the hull loop in _pickBestRec): the part's `pick`
   *   hull meshes are pickable whenever they can be ON SCREEN in the
   *   PART/COMPONENT bands, REGARDLESS of the card's rail cull, facing gate or
   *   detail tier — the mesh is literally under the pointer (a rail-culled
   *   wing, a barrel PV box at the PART band whose card waits for the
   *   COMPONENT band). Only pickability widens: the card itself stays
   *   governed by its own rules (_targetOpacity / _stackRail), anchors,
   *   leaders and layout are untouched. Hidden hardware never picks: the
   *   SYSTEM band (nothing on the hull hovers there), purchase-gated flower
   *   parts before the buy, daughters away from their berth.
   *
   * The briefing gate (both tiers): a RESOLVABLE codexId (round 6: a drifted
   * id renders "structure — no briefing" and must not stay clickable with a
   * dead no-op click) — OR the injected onPartClick hook, whose D-a REFIT
   * verb never needed an entry (Session D; the hub gates its own
   * codexId-dependent actions). Absent hook + no briefing (the shipped
   * `?ladder=0` boot): unpickable, exactly as shipped.
   * @private @param {object} p part rec @param {boolean} [mesh] the hull-mesh tier
   * @returns {boolean}
   */
  _recPickable(p, mesh = false) {
    if (this._codexState(p.def) === null && !this._onPartClick) return false;
    if (!mesh) {
      if (!p.sprite.visible) return false;
      // Gate on whichever is larger of eased vs target opacity, so picking
      // follows what the player can actually see. Derived from the legibility
      // floor (MIN_CARD_OP) so the two can't drift: a card is either clearly
      // readable-and-clickable or hidden — no muddy half-pickable band. The
      // 0.8 factor keeps the gate strictly below the floor (round 6).
      if (Math.max(p.op ?? 0, p._targetOp ?? 0) <= (CFG.MIN_CARD_OP ?? 0.5) * 0.8) return false;
      return true;
    }
    if (this._band === 'SYSTEM') return false;
    if (p._neverShow || p._armGone || p._flowerGone) return false;
    return true;
  }

  /**
   * Resolve a rec's `pick` hull objects (lazy, once). Default when the table
   * row carries no `pick`: `mesh ? [mesh] : []`. Resolution collects ALL
   * objects with a matching name via player.traverse — getObjectByName returns
   * only the FIRST match and several pick names are shared (SensorSpoke ×4).
   * One-time console.warn per rec for names that resolve to nothing (mirrors
   * the anchor mesh-miss warn). Never throws when `player` is absent.
   * @private @returns {THREE.Object3D[]}
   */
  _pickTargets(rec) {
    if (rec._pickTried) return rec._pickObjs || [];
    rec._pickTried = true;
    rec._pickObjs = [];
    const def = rec.def;
    const names = Array.isArray(def.pick) ? def.pick : (def.mesh ? [def.mesh] : []);
    if (!names.length || !this.player) return rec._pickObjs;
    const wanted = new Set(names);
    const found = new Set();
    this.player.traverse((o) => {
      if (o.name && wanted.has(o.name)) {
        rec._pickObjs.push(o);
        found.add(o.name);
      }
    });
    if (found.size < wanted.size && typeof console !== 'undefined') {
      const missing = names.filter((n) => !found.has(n));
      console.warn(`[MotherCallouts] pick name(s) "${missing.join('", "')}" not found for "${def.name}" — hull hover reduced`);
    }
    return rec._pickObjs;
  }

  /**
   * True when `obj` and every parent up to and including `root` are `.visible`.
   * Raycaster.intersectObject tests LAYERS only, never `.visible` (T1) — hidden
   * plumes, furled panels and docked daughter bodies would otherwise be hit.
   * @private
   */
  _chainVisible(obj, root) {
    let o = obj;
    while (o) {
      if (!o.visible) return false;
      if (o === root) return true;
      o = o.parent;
    }
    return true;
  }

  /**
   * Shared raycast pick with the camera ray already set: the card sprites
   * FIRST (a card hit ALWAYS beats a mesh hit — cards are depthTest:false and
   * draw on top of the hull), then the eligible parts' `pick` hull meshes.
   * Returns the nearest eligible rec or null. Single source for the pick so
   * hover and click can never drift apart (review).
   * @private
   */
  _pickBestRec() {
    let best = null, bestDist = Infinity;
    for (const p of this._partLabels) {
      if (!this._recPickable(p)) continue;
      const hits = this._raycaster.intersectObject(p.sprite, false);
      if (hits.length && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        best = p;
      }
    }
    if (best) return best;
    // Hull-part pick (D2's first verb): the same ray against each eligible
    // part's `pick` meshes — the MESH tier of _recPickable (Session D: on
    // screen in the PART/COMPONENT bands, whatever the card is doing).
    // Nearest visible-Mesh hit across all recs wins.
    for (const p of this._partLabels) {
      if (!this._recPickable(p, true)) continue;
      for (const target of this._pickTargets(p)) {
        const hits = this._raycaster.intersectObject(target, true);
        for (const hit of hits) {
          // T2: raycaster.params.Line.threshold is 1 WORLD UNIT and the ship is
          // 2e-5 units long — any Line child (CableHarness_*, our own outline)
          // hits from anywhere. Meshes only.
          if (!hit.object.isMesh) continue;
          // T1: skip hits whose chain up to the pick target is hidden.
          if (!this._chainVisible(hit.object, target)) continue;
          if (hit.distance < bestDist) { bestDist = hit.distance; best = p; }
          break; // hits are distance-sorted — the first eligible is this target's nearest
        }
      }
    }
    return best;
  }

  /**
   * Nearest clickable label sprite or hull pick mesh under the pointer.
   * @private @returns {object|null}
   */
  _pickLabel(e) {
    if (!this.camera) return null;
    this._raycaster.setFromCamera(this._pointerNDC(e), this.camera);
    return this._pickBestRec();
  }

  /**
   * The SOLE writer of `_hoverRec` (source-pinned in test-MotherCallouts): one
   * hover state whatever the source — card sprite or hull mesh. Swaps the part
   * outline and keeps the hand cursor in sync; the card treatment (opacity
   * lift, scale bump, leader whitening) reads `_hoverRec` in _positionCard.
   * Every applied pick result — a hit (same rec or a switch) or an explicit
   * clear — also ends the stationary miss run (`_hoverMisses`, see
   * _refreshHover), so a stale count can never shorten the next hover.
   * @private @param {object|null} rec
   */
  _setHoverRec(rec) {
    const next = rec || null;
    this._hoverMisses = 0;
    if (next === this._hoverRec) return;
    const old = this._hoverRec;
    this._hoverRec = next;
    // A rec that is ALSO ghosted keeps its outline on hover-out (the REFIT
    // ghost pulse resumes in update()); plain hovers hide as shipped.
    if (old && !(this._ghostRecs && this._ghostRecs.has(old))) {
      this._setOutlineVisible(old, false);
    }
    if (next) {
      if (!this._cursorSet && typeof document !== 'undefined') {
        document.body.style.cursor = 'pointer';
        this._cursorSet = true;
      }
      this._ensureOutline(next);
      this._setOutlineVisible(next, true);
      this._updateOutlineStagger();   // staggered on its very first drawn frame
    } else {
      this._restoreCursor();
    }
  }

  /** Pointer left the canvas: clear the hover and stop re-picking (R13). @private */
  _handlePointerLeave() {
    this._setHoverRec(null);
    this._pointerPos = null;   // stop re-picking once the pointer exits (R13)
  }

  /** Hull-outline master switch (a method so tests can stub it). @private */
  _outlineEnabled() {
    return Constants.INSPECTION?.HULL_OUTLINE !== false;
  }

  /**
   * Lazily build a rec's hover outline (once, cached), two layers per Mesh in
   * the pick subtrees, both parented to THAT MESH so they follow every live
   * transform (gimbal, furl, strut ride):
   *
   *   1. House-style EdgesGeometry LineSegments (the hull-outline look, same
   *      threshold). SCALE TRAP: EdgesGeometry hashes vertices at a fixed 1e4
   *      precision and the ship is built at M = 1e-5 scene units per metre —
   *      raw hull geometry collapses into ONE hash bucket and yields ZERO
   *      edges (silently: an empty, invisible LineSegments; the shipped hull
   *      outline has the same trap). Edge a ×1/M clone at metre scale, then
   *      scale the edges back down. The house threshold is untouched.
   *   2. A translucent cyan shell (the pre-approved fallback for weak edges):
   *      a Mesh SHARING the hull mesh's geometry (never disposed here),
   *      inflated 3% — closed bodies read as a soft cyan tint + silhouette
   *      halo, flat panels as a cyan rim + tint. The witness showed edge
   *      lines alone are near-invisible on the flat ROSA panels.
   *
   * DEPTH (refinements, 2026-09-03): BOTH layers keep `depthTest` ON and
   * `depthWrite` OFF, and are pulled HOVER_OUTLINE_STAGGER_M (1.5 mm) toward
   * the camera every frame (_updateOutlineStagger) — the house "tiny geometric
   * Z stagger" SceneManager prescribes over polygonOffset under the
   * logarithmic depth buffer (the ROSA blanket's own 2 mm front/back standoff
   * is the precedent). Why not scale, why not depth-free:
   *   - The flat ROSA panels are PlaneGeometry with zero z-extent: a uniform
   *     `scale.setScalar(1.03)` cannot lift a z=0 plane off its own plane, so
   *     the shell and the edge lines sat exactly coplanar with the hull that
   *     had already written depth and shimmered (equal-depth fragments flip
   *     the LESS test frame to frame). The pull toward the camera does lift
   *     them, whatever the geometry.
   *   - Session 1b first drew both layers `depthTest:false` (the card/dot/
   *     leader treatment): steady, but far-side layers (the 4 RCS pods, the
   *     back ROSA face, the 28 barrel cells) showed THROUGH the mother and a
   *     radiator plate crossing a wing was tinted over — owner playtest:
   *     confusing. With the depth test on, the hull's own depth hides them.
   *
   * One LineBasicMaterial + one MeshBasicMaterial per rec — their own, never
   * a hull material, never shared across recs. Caches null when outlines are
   * disabled or nothing picks.
   * @private @returns {{lines: THREE.LineSegments[], shells: THREE.Mesh[],
   *   material: THREE.LineBasicMaterial, shellMaterial: THREE.MeshBasicMaterial}|null}
   */
  _ensureOutline(rec) {
    if (rec._outlineTried) return rec._outline;
    rec._outlineTried = true;
    rec._outline = null;
    if (!this._outlineEnabled()) return null;
    const targets = this._pickTargets(rec);
    if (!targets.length) return null;
    const INS = Constants.INSPECTION || {};
    // Both materials: depth test ON (the hull occludes far-side layers), depth
    // write OFF (an overlay never writes depth) — see the DEPTH note above. The
    // stagger that wins the test against the part's own surface is geometric
    // (_updateOutlineStagger), never polygonOffset. Never a hull material.
    const material = new THREE.LineBasicMaterial({
      color: INS.HULL_OUTLINE_COLOR ?? 0x00ffcc,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const shellMaterial = new THREE.MeshBasicMaterial({
      color: INS.HULL_OUTLINE_COLOR ?? 0x00ffcc,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const NORM = 1 / M; // metre-scale normalization for the EdgesGeometry hash
    const lines = [];
    const shells = [];
    for (const target of targets) {
      target.traverse((o) => {
        // Meshes with real geometry only — skip Sprites/Lines/Points, the
        // outline layers themselves (userData.partId), and position-less
        // geometry (EdgesGeometry would throw).
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        if (o.userData.partId) return;
        const src = o.geometry.clone();
        src.scale(NORM, NORM, NORM);
        const edges = new THREE.EdgesGeometry(src, INS.HULL_OUTLINE_THRESHOLD_DEG ?? 20);
        edges.scale(M, M, M);
        src.dispose();
        const line = new THREE.LineSegments(edges, material);
        line.name = 'MotherCalloutOutline';
        line.userData.partId = rec.def.id;
        line.raycast = () => {};          // T2: never hit by our own recursive pick
        line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
        line.visible = false;
        o.add(line);
        lines.push(line);
        const shell = new THREE.Mesh(o.geometry, shellMaterial); // SHARED geometry
        shell.name = 'MotherCalloutOutline';
        shell.userData.partId = rec.def.id;
        shell.raycast = () => {};         // T2 again — a shell must never self-hit
        shell.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
        shell.scale.setScalar(1.03);
        shell.visible = false;
        o.add(shell);
        shells.push(shell);
      });
    }
    if (!lines.length) { material.dispose(); shellMaterial.dispose(); return null; }
    rec._outline = {
      lines, shells, material, shellMaterial,
      // Build-time base opacities — the REFIT ghost pulse oscillates around
      // these and _restoreGhostBase puts them back on clear.
      lineBaseOp: material.opacity,
      shellBaseOp: shellMaterial.opacity,
    };
    return rec._outline;
  }

  /** Toggle a rec's hover outline (no-op when it has none). @private */
  _setOutlineVisible(rec, on) {
    if (!rec._outline) return;
    for (const line of rec._outline.lines) line.visible = !!on;
    for (const shell of rec._outline.shells || []) shell.visible = !!on;
  }

  /**
   * Pull EVERY outlined rec's layers HOVER_OUTLINE_STAGGER_M toward the
   * camera — the hovered rec AND the REFIT ghost recs (Wave 5 (2) extended
   * the shipped hover-only stagger per the 06-core-api note: "extend it if a
   * second rec ever shows an outline") — in each parent mesh's LOCAL frame,
   * so they win the depth test against their own surface while the hull still
   * occludes far-side layers (see the DEPTH note on _ensureOutline). Runs per
   * frame at the end of update() (after _layout's re-pick, so a switched
   * hover is staggered before it is drawn), once from _setHoverRec and once
   * from setGhostOutline (both are drawn staggered on their very first
   * frame). Each parent's world matrix is refreshed first (in-frame they are
   * one frame stale — see _refreshHover); the offset is exact under any
   * parent rotation and non-uniform scale (the ROSA roll-out wrapper scales
   * x) because it goes through worldToLocal. ≤ 32 small objects per rec
   * (body_cells) — ~tens of µs. No per-frame allocation; no-op without a
   * real camera (test stubs) or without any outlined rec.
   * @private
   */
  _updateOutlineStagger() {
    const cam = this.camera;
    if (!cam || !cam.matrixWorld) return;
    const hover = this._hoverRec;
    const ghosts = (this._ghostRecs && this._ghostRecs.size) ? this._ghostRecs : null;
    if (!hover && !ghosts) return;
    cam.getWorldPosition(this._vStagCam);                           // C (never mutated below)
    if (hover) staggerOutlineLayers(this, hover._outline);
    if (ghosts) {
      for (const rec of ghosts) {
        if (rec !== hover) staggerOutlineLayers(this, rec._outline);
      }
    }
  }

  _handlePointerMove(e) {
    if (!this._active) return;
    // Always record the latest position so _layout can re-pick under a
    // stationary pointer as cards slide (R13); the pick itself is throttled.
    this._pointerPos = { clientX: e.clientX, clientY: e.clientY };
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._hoverT < 100) return;   // ~10 Hz
    this._hoverT = now;
    this._setHoverRec(this._pickLabel(e));
  }

  /**
   * Re-pick the hover from the stored pointer position (R13). Cards slide in
   * screen space as the ship rotates (and the hull meshes rotate under a
   * stationary pointer), so the hover would otherwise go stale. Runs at
   * ~10 Hz from _layout; cheap (the card sprites, then the eligible parts'
   * pick meshes via _pickBestRec).
   *
   * STALE WORLD MATRICES (the witnessed cause of the stationary blink,
   * 2026-09-03): this runs inside the frame's update, BEFORE the render's
   * scene.updateMatrixWorld(), and update() refreshes only the player itself
   * (updateWorldMatrix(true, false)) — every hull mesh and card sprite still
   * carries LAST frame's matrixWorld while the camera is already at THIS
   * frame's pose. The ship covers ~7.7 km/s along its orbit (~130 m per 60 Hz
   * frame, 60× its own length), so the ray through a still pointer met the
   * panel where it WAS and missed on every frame the camera did not look
   * along the velocity — the in-frame pick missed while the same pick run
   * after the render hit every time (headless witness: panel matrixWorld
   * 7,700 m stale per tick; hover cleared 3 ticks after each pointer event).
   * Refresh the player subtree first (396 objects, ~0.06 ms, at 10 Hz).
   *
   * HOVER STICKINESS (refinement, playtest 2026-09-03 "parts flicker"): this
   * stationary re-pick used to clear the hover on ANY miss, and thin parts,
   * part edges and the ship turning under a still pointer can still miss for
   * a frame — the outline blinked on/off. The rule, in order:
   *   1. a hit on the HELD rec confirms it (miss run reset, nothing else);
   *   2. a hit on a DIFFERENT pickable rec switches immediately (old outline
   *      hidden, new shown — the pointer really is on something else);
   *   3. a miss with a hover held KEEPS it, unless the held rec is no longer
   *      `_recPickable` (facing gate dropped, rail-culled, band left, briefing
   *      gone — cleared at once) or this is the HOVER_MISS_TICKS-th
   *      consecutive miss (3 ticks ≈ 300 ms at 10 Hz — cleared);
   *   4. a miss with nothing held does nothing.
   * Only this path is sticky. The explicit clears stay immediate and
   * unchanged: _handlePointerLeave (pointerleave), _detachPointer,
   * _setActive(false), and a real _handlePointerMove onto empty space.
   * @private
   */
  _refreshHover() {
    if (!this._pointerPos || !this.canvas) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._hoverPickT < 100) return;
    this._hoverPickT = now;
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(
      ((this._pointerPos.clientX - rect.left) / rect.width) * 2 - 1,
      -((this._pointerPos.clientY - rect.top) / rect.height) * 2 + 1,
    );
    // In-frame: bring the hull meshes + card sprites to THIS frame's pose
    // before casting (see STALE WORLD MATRICES above).
    this.player.updateWorldMatrix(true, true);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this._pickBestRec();
    if (hit) { this._setHoverRec(hit); return; }          // rules 1 + 2 (same rec → no-op + reset)
    const held = this._hoverRec;
    if (!held) return;                                      // rule 4
    // Rule 3: tolerate a transient miss; clear when the held rec is genuinely
    // ineligible on BOTH tiers (card hidden AND its hull meshes out of reach —
    // band left, briefing gone) or the miss run reaches the threshold.
    if (!(this._recPickable(held) || this._recPickable(held, true)) || ++this._hoverMisses >= HOVER_MISS_TICKS) {
      this._setHoverRec(null);
    }
  }

  _handlePointerDown(e) {
    if (!this._active) return;
    this._pointerDown = {
      x: e.clientX, y: e.clientY,
      t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    };
  }

  _handlePointerUp(e) {
    if (!this._active || !this._pointerDown) return;
    const down = this._pointerDown;
    this._pointerDown = null;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > 5 || (now - down.t) > 400) return;   // drag / long-press → ignore
    const hit = this._pickLabel(e);
    // T7: the WHOLE card is clickable — hover and click agree (the old
    // title-strip UV gate made ~⅔ of a focused card a dead zone with a hand
    // cursor). Hull-part clicks arrive through the same _pickLabel (the mesh
    // loop in _pickBestRec), so clicking a part IS clicking its card.
    if (!hit) return;
    // Wave 5 (2) D-a (owner, 2026-09-03): with the REFIT hook injected the
    // click opens the part's REFIT card INSTEAD of the Library — the hook
    // receives the getHoveredPart() record (the clicked rec is written
    // through the ONE hover writer first, so hovered == clicked even on a
    // synthetic click). Session D: the hook fires for parts WITHOUT a
    // briefing too — the REFIT verb never needed an entry; the hub gates its
    // own codexId-dependent actions (library retarget, scan) on the record.
    // Absent hook (shipped / ?ladder=0): the one CODEX_OPEN_ENTRY emit below
    // runs exactly as today, still gated on a codexId.
    if (this._onPartClick) {
      this._setHoverRec(hit);
      this._onPartClick(this.getHoveredPart());
    } else if (hit.def.codexId) {
      eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: hit.def.codexId });
    }
  }

  // --------------------------------------------------------------------------
  // PER-FRAME UPDATE
  // --------------------------------------------------------------------------

  update(dt) {
    if (!this._active || !this.camera) return;

    this.player.updateWorldMatrix(true, false);
    this.camera.updateMatrixWorld();

    this.player.getWorldPosition(this._vShip);
    this._vCam.copy(this.camera.position);
    const distWorld = this._vCam.distanceTo(this._vShip);
    const distM = distWorld / M;

    // Camera basis (world) + view metrics at the ship-centre depth plane.
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const fov = (this.camera.fov || 55) * DEG2RAD;
    this._halfH = distWorld * Math.tan(fov / 2);
    this._halfW = this._halfH * (this.camera.aspect || 1);

    // Camera position in player-local space + leader ribbon half-width.
    this._vCamLocal.copy(this._vCam);
    this.player.worldToLocal(this._vCamLocal);
    this._leaderHalfWidth = distWorld * LINE_HALF_WIDTH_FRAC;

    // Ship centre + silhouette radius in NDC → rail X positions.
    this._shipNDC.copy(this._vShip).project(this.camera);
    // Ship world-quaternion, hoisted here so _pickFocusPart (below) and _layout
    // both read the CURRENT rotation, not last frame's or identity (R6).
    this.player.getWorldQuaternion(this._qTmp);
    const shipBoundR = CFG.SHIP_BOUND_M * M;
    this._vTmp.copy(this._vShip).addScaledVector(this._camRight, shipBoundR).project(this.camera);
    const screenR = Math.abs(this._vTmp.x - this._shipNDC.x);
    const margin = CFG.RAIL_MARGIN_NDC;

    // Reserve the widest rail-card width on both sides (R15). aspect × heightFactor
    // is invariant (= CARD_W_OVER_TITLE_H ≈ 6.04) for every card, so the widest rail
    // card is always the SIZE_MAJOR tier — a constant, no per-rec loop, no frame lag.
    const camAspect = this.camera.aspect || 1;
    const railCardW = 2 * CFG.SIZE_MAJOR * CARD_W_OVER_TITLE_H / camAspect;

    // Workbench panes (Wave 5 Session B): the usable screen edges. With no
    // pane open _edgeL/_edgeR are exactly -1/+1 and every line below is the
    // shipped arithmetic, byte-identical.
    this._updatePaneEdges();

    this._railL = Math.max(this._edgeL + margin + railCardW, this._shipNDC.x - screenR - CFG.RAIL_INSET_NDC);
    this._railR = Math.min(this._edgeR - margin - railCardW, this._shipNDC.x + screenR + CFG.RAIL_INSET_NDC);

    this._updateBand(distM);
    this._updateGuide(dt);

    this._vCamDir.copy(this._vCam).sub(this._vShip).normalize();

    // Resolve every rec's anchor for this frame BEFORE focus picking and layout
    // read them (T1; mirrors the R6 quaternion hoist).
    for (const rec of this._allRecs) this._resolveAnchor(rec);

    if (this._band === 'COMPONENT') this._focusPart = this._pickFocusPart();
    else this._focusPart = null;

    this._layout(dt);
    // After the re-pick inside _layout: pull every outlined rec (hover +
    // REFIT ghosts) toward the camera for THIS frame's pose (depth-honest
    // highlight, see _ensureOutline), then advance the ghost pulse.
    this._updateOutlineStagger();
    this._updateGhostPulse(dt);
  }

  _updateBand(distM) {
    const b = this._band;
    const prev = b;
    if (b === 'SYSTEM') {
      if (distM < BAND.partIn) this._band = 'PART';
    } else if (b === 'PART') {
      if (distM > BAND.partOut) this._band = 'SYSTEM';
      else if (distM < BAND.compIn) this._band = 'COMPONENT';
    } else {
      if (distM > BAND.compOut) this._band = 'PART';
    }
    if (this._band !== prev) {
      this._bandChangedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._revealSeq = 0;
      // T3: clear stale reveal holds so every rec gets a fresh stagger slot.
      for (const rec of this._allRecs) rec._revealAt = null;
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: this._band });
    }
  }

  /** P2: is any aft-flower pair purchased? Gates the THERMAL family. @private */
  _flowerOn() {
    return typeof this.player?.getFlowerPairCount === 'function'
      && this.player.getFlowerPairCount() > 0;
  }

  _updateGuide(dt) {
    if (this._guideT < -GUIDE_HOLD_S - 0.001 || this._guidedDone) return;
    this._guideT += dt;
    const total = this._tourableSystems().length * GUIDE_STEP_S;
    if (this._guideT >= total) { this._guidedDone = true; this._guideT = -1; }
  }

  /** Tourable groups: visible system labels only — DAUGHTERS excluded (its
   *  recs are the docked craft), THERMAL excluded pre-purchase (P2). @private */
  _tourableSystems() {
    return SYSTEMS.filter((s) => !s.daughters && !(s.flowerGated && !this._flowerOn()));
  }

  _guideSystemId() {
    if (this._guidedDone || this._guideT < 0) return null;
    const tourable = this._tourableSystems();
    const idx = Math.floor(this._guideT / GUIDE_STEP_S);
    return tourable[idx]?.id ?? null;
  }

  _pickFocusPart() {
    let best = null, bestD = Infinity;
    for (const p of this._partLabels) {
      if (p.isDetail) continue;
      // Skip hull-hidden parts (far side of ship) so focus doesn't reveal
      // a system detail tier at ~0 opacity (LOW-13).
      if (this._anchorVisible(p.anchor) < 0.2) continue;
      this._vAnchor.copy(p.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vTmp.copy(this._vAnchor).project(this.camera);
      if (this._vTmp.z > 1) continue;
      // "Nearest screen-centre" measures from the centre of the UNCOVERED
      // strip (Wave 5 Session B) — with a workbench pane open the camera's
      // look-at bias puts the ship there, so the focused part stays the one
      // the player is actually looking at. No pane → _stripCX 0, shipped.
      const dx = this._vTmp.x - this._stripCX;
      const d = dx * dx + this._vTmp.y * this._vTmp.y;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * Anchor visibility gate (camera-facing dot proxy). Anchors on the far side
   * of the hull fade to 0. Returns 0..1.
   * Uses the ship world-quaternion hoisted in update() (R6).
   * T8: the anchor's RADIAL component is the surface normal; near-axial parts
   * (net launcher, turret, FEEP) are exempt — they read in silhouette at every
   * angle and must not fade to ~0.2 when viewed broadside.
   * @private
   */
  _anchorVisible(anchorLocal) {
    // Near-axial anchor: no meaningful radial normal → always face-visible.
    const r2 = anchorLocal.x * anchorLocal.x + anchorLocal.y * anchorLocal.y;
    const axialFloor = 0.15 * M;
    if (r2 < axialFloor * axialFloor) return 1;
    this._vFace.set(anchorLocal.x, anchorLocal.y, 0); // radial component only
    this._vFace.applyQuaternion(this._qTmp); // hoisted in update()
    if (this._vFace.lengthSq() < 1e-20) return 1;
    this._vFace.normalize();
    const d = this._vFace.dot(this._vCamDir);
    // Softened ramp: a part 90° off still reads ~0.42 instead of ~0.22 (T8).
    return Math.max(0, Math.min(1, (d + 0.25) / 0.6));
  }

  // --------------------------------------------------------------------------
  // RAIL LAYOUT
  // --------------------------------------------------------------------------

  /** On-screen height fraction (of viewport height) for a rec's tier. @private */
  _sizeFrac(rec, isFocus) {
    if (isFocus) return CFG.SIZE_CARD;
    if (rec.isSystem) return CFG.SIZE_SYSTEM;
    return rec.isDetail ? CFG.SIZE_DETAIL : CFG.SIZE_MAJOR;
  }

  /**
   * Full per-frame layout: compute target opacity + anchor NDC for every rec,
   * assign rail sides (with hysteresis), stack + cull each rail, ease positions
   * in NDC, then unproject to local sprite positions and rebuild leaders.
   * @private
   */
  _layout(dt) {
    const band = this._band;
    const guideId = this._guideSystemId();
    const focus = this._focusPart;
    const focusSys = focus?.sysId ?? null;
    const ease = 1 - Math.exp(-CFG.EASE_RATE * Math.max(dt, 0));
    const fadeK = Math.min(1, FADE_RATE * Math.max(dt, 0));

    // Refresh the focused card's live data at ≤ LIVE_REFRESH_HZ.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._nowMs = now;
    const liveDue = (now - this._lastLiveT) >= (1000 / (CFG.LIVE_REFRESH_HZ || 2));
    if (liveDue) this._lastLiveT = now;

    // Re-pick hover from the stored pointer position so it tracks cards sliding
    // under a stationary pointer (R13).
    this._refreshHover();

    // Reuse persistent rail arrays (LOW-16: zero per-frame alloc).
    const leftList = this._leftRail;
    const rightList = this._rightRail;
    leftList.length = 0;
    rightList.length = 0;

    // T6: project the focused part's anchor once so detail parts NEAR it on
    // screen can reveal even when they belong to another system.
    let focusNX = 0, focusNY = 0;
    if (focus) {
      this._vTmp.copy(focus.anchor);
      this.player.localToWorld(this._vTmp);
      this._vTmp.project(this.camera);
      focusNX = this._vTmp.x; focusNY = this._vTmp.y;
    }

    for (const rec of this._allRecs) {
      const isFocus = !rec.isSystem && band === 'COMPONENT' && rec === focus;

      // Anchor NDC (computed before target opacity: T6 proximity reveal reads it).
      this._vAnchor.copy(rec.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vAnchor.project(this.camera);
      const ax = this._vAnchor.x, ay = this._vAnchor.y, az = this._vAnchor.z;
      rec._anchorX = ax; rec._anchorY = ay; rec._anchorZ = az;

      // Facing ramp (0..1) — applied to the dot + leader (which sit on the hull)
      // in _positionCard, NOT to the card. Stored once per frame.
      rec._facing = this._anchorVisible(rec.anchor);

      let targetOp = this._targetOpacity(rec, band, guideId, focusSys, focusNX, focusNY, rec._facing);
      const off = CFG.OFFSCREEN_NDC;
      if (az > 1 || ax < -off || ax > off || ay < -off || ay > off) targetOp = 0;

      rec._targetOp = targetOp;

      // T3: scan-in stagger — assign a reveal timestamp when a card transitions
      // from hidden to visible after a band change. 150 ms hold so the old band
      // clears, then 40 ms/card stagger capped at 300 ms.
      if (rec._targetOp > 0.02 && rec.op <= 0.02 && rec._revealAt == null) {
        rec._revealAt = this._bandChangedAt + 150 + Math.min(300, (this._revealSeq++) * 40);
      }
      if (rec.op > 0.05) rec._revealAt = null;

      // Card content: focused → full detail card, else compact (R14: no hover variant).
      if (isFocus) {
        if (liveDue || !rec._wasFocus) this._applyCard(rec, { full: true });
        rec._wasFocus = true;
      } else if (rec._wasFocus) {
        this._applyCard(rec, { full: false });
        rec._wasFocus = false;
      }

      // T4: pending side-flip — commit when faded out, force fade otherwise.
      // Placed BEFORE the hidden early-continue so a rec fading out for a band
      // change while a flip is pending can't get stuck invisible.
      if (rec._pendingSide) {
        if (rec.op <= 0.05) {
          rec.side = rec._pendingSide;
          rec._pendingSide = null;
          rec._railOrder = null;
          rec.primed = false;
          rec._sideT = now;
        } else {
          targetOp = 0;
          rec._targetOp = 0;
        }
      }

      if (targetOp <= 0.001 && rec.op <= 0.02) {
        // Fully hidden — still ease opacity down, keep off rails.
        rec._isFocus = false;
        rec.op += (0 - rec.op) * fadeK;
        if (rec.op <= 0.02) {
          rec.primed = false; // reappear snaps to new slot, no sweep
          rec._railOrder = null; // reset rail ordinal when hidden
          rec._pendingSide = null; // T4: clear pending flip on hide
          rec.side = null; // T4: fresh side assignment on reappear (sets _sideT=now)
          rec._sideT = 0;
        }
        this._hideRec(rec);
        continue;
      }

      // Focused card is placed by its anchor, not on a rail.
      rec._isFocus = isFocus;
      if (isFocus) continue;

      // Side assignment with hysteresis + 1.5 s dwell (T4: fade-swap, never sweep).
      const desired = (ax < this._shipNDC.x) ? 'L' : 'R';
      // Cancel a queued flip if the anchor reverted back to the committed side.
      if (rec._pendingSide != null && desired === rec.side) {
        rec._pendingSide = null;
      }
      if (rec.side == null) {
        rec.side = desired;
        rec._railOrder = null; // reset ordinal on side entry
        rec._sideT = now;
      } else if (rec.side !== desired
        && Math.abs(ax - this._shipNDC.x) > CFG.SIDE_HYSTERESIS
        && (now - rec._sideT) > 1500) {
        rec._pendingSide = desired; // commit happens in the block above next frames
      }

      (rec.side === 'L' ? leftList : rightList).push(rec);
    }

    this._stackRail(leftList, this._railL, dt, ease, fadeK);
    this._stackRail(rightList, this._railR, dt, ease, fadeK);
    this._placeFocus(dt, ease, fadeK);
  }

  /** Target opacity for a rec given band/guide/focus, before anchor gating. @private
   * Round 6: binary legibility. The card's opacity is band/guide/focus only —
   * the facing ramp (which belongs to hardware on the hull, not a card on a
   * screen-edge rail) is a hard GATE here (back-facing → 0) and is applied as a
   * soft fade only to the dot + leader in _positionCard. Non-hidden targets are
   * floored to MIN_CARD_OP so a shown card is always readable, never muddy.
   * @param {number} [facing] pre-computed _anchorVisible(rec.anchor) for this
   *   frame (from _layout); recomputed only if not supplied (e.g. unit tests). */
  _targetOpacity(rec, band, guideId, focusSys, focusNX, focusNY, facing) {
    if (rec._neverShow) return 0; // DAUGHTERS pseudo-group has no system label
    if (rec._armGone) return 0;   // daughter away from its berth (T3)
    if (rec._flowerGone) return 0; // THERMAL family pre-purchase (P2)
    // Hard facing gate: a card whose anchor faces away is hidden outright
    // (the dot/leader carry the on-hull fade; the card does not).
    const face = (facing != null) ? facing : this._anchorVisible(rec.anchor);
    if (face < 0.15) return 0;
    const floor = CFG.MIN_CARD_OP ?? 0.5;
    if (rec.isSystem) {
      if (band !== 'SYSTEM') return 0;
      // Guided tour: highlighted system full, the rest dimmed (but still legible).
      if (guideId) return (rec.def.id === guideId) ? 1 : 0.5;
      return 1;
    }
    if (rec.isDetail) {
      let reveal = band === 'COMPONENT' && rec.sysId === focusSys;
      // T6: proximity reveal — detail parts near the focused part on screen
      // appear even when they belong to another system.
      if (!reveal && band === 'COMPONENT' && this._focusPart) {
        const dx = rec._anchorX - focusNX, dy = rec._anchorY - focusNY;
        const r = CFG.DETAIL_REVEAL_NDC || 0.25;
        if (dx * dx + dy * dy < r * r) reveal = true;
      }
      return reveal ? 1 : 0;
    }
    // Major part.
    const showParts = band === 'PART' || band === 'COMPONENT';
    if (!showParts) return 0;
    let op = 1;
    // Guided tour: non-highlighted systems dimmed but legible.
    if (guideId && rec.sysId !== guideId) op = 0.5;
    // COMPONENT band, not the focused part: recede a little (still readable).
    const isFocus = band === 'COMPONENT' && rec === this._focusPart;
    if (band === 'COMPONENT' && !isFocus) op = Math.min(op, 0.8);
    return Math.max(op, floor);
  }

  /**
   * Stack one rail's cards: order top → bottom (with hysteresis, via the pure
   * `orderRail` helper), priority-cull on overflow, assign slot Ys centred on
   * the anchors' mean, then ease + place.
   * @private
   */
  _stackRail(list, railX, dt, ease, fadeK) {
    if (list.length === 0) return;

    // Top → bottom order with persistent ordinals + hysteresis (R2).
    orderRail(list, CFG.ORDER_HYSTERESIS || 0.04);

    const gap = CFG.RAIL_GAP_NDC;
    const marginY = CFG.RAIL_MARGIN_NDC;
    const avail = 2 - 2 * marginY;

    // Heights (NDC full height = 2 * sizeFrac * heightFactor).
    for (const rec of list) {
      const heightFactor = rec.card?.heightFactor || 1;
      rec._h = 2 * this._sizeFrac(rec, false) * heightFactor;
    }

    // Priority culling if the stack overflows.
    let total = list.reduce((s, r) => s + r._h, 0) + gap * (list.length - 1);
    if (total > avail) {
      const sorted = [...list].sort((a, b) => this._cullScore(a) - this._cullScore(b));
      let i = 0;
      while (total > avail && i < sorted.length && list.length > 1) {
        const drop = sorted[i++];
        const idx = list.indexOf(drop);
        if (idx >= 0) {
          list.splice(idx, 1);
          drop._targetOp = 0;
          // Fade out and hide the culled rec this frame so it doesn't freeze.
          drop.op += (0 - drop.op) * fadeK;
          if (drop.op <= 0.02) drop.primed = false;
          drop._railOrder = null; // renumber when it re-enters (R2)
          this._hideRec(drop);
          total = list.reduce((s, r) => s + r._h, 0) + gap * (list.length - 1);
        }
      }
      // Renumber the survivors so ordinals stay contiguous after a cull.
      for (let i = 0; i < list.length; i++) list[i]._railOrder = i;
    }

    // Centre the stack on the anchors' mean Y, clamped to the viewport.
    let meanY = 0;
    for (const rec of list) meanY += rec._anchorY;
    meanY /= list.length;
    total = list.reduce((s, r) => s + r._h, 0) + gap * (list.length - 1);
    let topY = meanY + total / 2;
    const hiLimit = 1 - marginY;
    const loLimit = -1 + marginY;
    if (topY > hiLimit) topY = hiLimit;
    if (topY - total < loLimit) topY = loLimit + total;

    let cursor = topY;
    for (const rec of list) {
      const slotY = cursor - rec._h / 2;
      cursor -= rec._h + gap;
      this._placeRailRec(rec, railX, slotY, dt, ease, fadeK);
    }
  }

  /** Higher = keep. Detail tier culled first, then low priority/mass. @private */
  _cullScore(rec) {
    const tierBonus = rec.isDetail ? 0 : 1000;
    return tierBonus + (rec.def.priority || 0) * 10 + (rec.def.massKg || 0);
  }

  /** Ease a rail rec to (railX, slotY) NDC and place its sprite + leader. @private */
  _placeRailRec(rec, railX, slotY, dt, ease, fadeK) {
    if (!rec.primed) { rec.sx = railX; rec.sy = slotY; rec.primed = true; }
    else { rec.sx += (railX - rec.sx) * ease; rec.sy += (slotY - rec.sy) * ease; }

    const side = rec.side;
    // Card inner edge sits on the rail: left rail → right edge (center.x=1),
    // right rail → left edge (center.x=0). Leader attaches at sprite.position.
    rec.sprite.center.x = (side === 'L') ? 1 : 0;
    this._positionCard(rec, rec.sx, rec.sy, false, side, fadeK);
  }

  /** Place the focused COMPONENT card near its anchor (not on a rail). @private */
  _placeFocus(dt, ease, fadeK) {
    const rec = this._focusPart;
    if (!rec || !rec._isFocus) return;
    const now = this._nowMs;
    const desired = (rec._anchorX < this._shipNDC.x) ? 'L' : 'R';
    // T4: same 1.5 s dwell as rail flips — keep the last committed side until
    // dwell + hysteresis allow the change.
    if (rec.side == null) {
      rec.side = desired;
      rec._sideT = now;
    } else if (rec.side !== desired
      && Math.abs(rec._anchorX - this._shipNDC.x) > CFG.SIDE_HYSTERESIS
      && (now - rec._sideT) > 1500) {
      rec.side = desired;
      rec._sideT = now;
    }
    const side = rec.side;

    // Clamp focus card to viewport, accounting for card width on the extending side.
    // aspect × heightFactor = CARD_W_OVER_TITLE_H for every card (R15).
    const frac = this._sizeFrac(rec, true);
    const heightFactor = rec.card?.heightFactor || 1;
    const camAspect = this.camera.aspect || 1;
    const cardW = 2 * frac * CARD_W_OVER_TITLE_H / camAspect;
    const cardH = 2 * frac * heightFactor;
    const margin = CFG.RAIL_MARGIN_NDC;

    // Small fixed offset toward the nearer rail side.
    let tx = rec._anchorX + (side === 'L' ? -0.12 : 0.12);
    let ty = rec._anchorY + 0.07;

    // Clamp X: card extends outward from anchor, so reserve width on that
    // side — against the PANE-AWARE edges (Wave 5 Session B: the focus card
    // never sits under a workbench pane; no pane → -1/+1, shipped).
    if (side === 'L') tx = Math.max(tx, this._edgeL + margin + cardW);
    else tx = Math.min(tx, this._edgeR - margin - cardW);
    // Clamp Y: card is centred vertically on ty.
    ty = Math.max(-1 + margin + cardH / 2, Math.min(1 - margin - cardH / 2, ty));

    if (!rec.primed) { rec.sx = tx; rec.sy = ty; rec.primed = true; }
    else { rec.sx += (tx - rec.sx) * ease; rec.sy += (ty - rec.sy) * ease; }
    rec.sprite.center.x = (side === 'L') ? 1 : 0;
    this._positionCard(rec, rec.sx, rec.sy, true, side, fadeK);
  }

  /**
   * Given a rec's eased NDC slot, unproject to local space, size the sprite
   * screen-constant, ease opacity, and rebuild the elbow leader + dot.
   * @private
   */
  _positionCard(rec, nx, ny, isFocus, side, fadeK) {
    // Unproject NDC slot at ship-centre depth → world → local.
    // Use (nx − shipNDC.x) and (ny − shipNDC.y) so the offset is relative to
    // the ship's actual screen position, not absolute NDC (which would double-
    // shift when the inspection look-at carries a forward offset).
    this._vAttach.copy(this._vShip)
      .addScaledVector(this._camRight, (nx - this._shipNDC.x) * this._halfW)
      .addScaledVector(this._camUp, (ny - this._shipNDC.y) * this._halfH);
    this._vTmp.copy(this._vAttach);
    this.player.worldToLocal(this._vTmp);
    rec.sprite.position.copy(this._vTmp);

    // Screen-constant sizing (manual dist scaling; see plan task 6 fallback).
    // SIZE_* defines the on-screen height of the TITLE BLOCK; scale by heightFactor
    // so the whole card grows proportionally and text stays the same size.
    // aspect × heightFactor = CARD_W_OVER_TITLE_H for every card (R15), so derive
    // the width factor from the invariant instead of reading a possibly-stale card.
    const frac = this._sizeFrac(rec, isFocus);
    const heightFactor = rec.card?.heightFactor || 1;
    const h = frac * 2 * this._halfH * heightFactor;
    const aspect = CARD_W_OVER_TITLE_H / heightFactor;
    rec.sprite.scale.set(h * aspect, h, 1);

    // Ease opacity. T3: hold at 0 while waiting for the scan-in reveal slot.
    // Hover lifts it a little; the colour lift below carries the affordance at
    // full opacity where this boost is a no-op.
    const tgt = (rec._revealAt != null && this._nowMs < rec._revealAt) ? 0 : rec._targetOp;
    rec.op += (tgt - rec.op) * fadeK;
    const hovered = this._hoverRec === rec;
    const op = hovered ? Math.min(1, rec.op + 0.15) : rec.op;
    const visible = op > 0.02;
    rec.sprite.material.opacity = op;
    rec.sprite.visible = visible;
    // Round 6: cards are full-bright (no non-hover dim scalar — the vignette no
    // longer touches them, so a global dim only muddied them). The hover cue is
    // carried by the leader whitening (below), the +0.15 opacity lift, and a
    // small screen-constant scale bump.
    rec.sprite.material.color.setScalar(1.0);
    const hoverScale = hovered ? 1.04 : 1.0;
    rec.sprite.scale.multiplyScalar(hoverScale);
    // Depth sort: nearer anchor draws last.
    rec.sprite.renderOrder = 30 + Math.round((1 - rec._anchorZ) * 200);

    // Dot at the anchor. The facing ramp fades the on-hull marker (not the card).
    const facing = rec._facing != null ? rec._facing : 1;
    const dotWorldH = CFG.DOT_SIZE * 2 * this._halfH;
    rec.dot.position.copy(rec.anchor);
    rec.dot.scale.set(dotWorldH, dotWorldH, 1);
    rec.dot.material.opacity = op * facing;
    rec.dot.visible = visible;
    rec.dot.renderOrder = 31 + Math.round((1 - rec._anchorZ) * 200);

    // Elbow leader (opacity tracks the card, slightly dimmer, faded by facing).
    const lineOp = visible ? op * LINE_OP_SCALE * facing : 0;
    if (hovered) rec.line.material.color.set('#ffffff');
    else rec.line.material.color.set(rec.hue);
    this._setElbowLocal(rec.line, this._vAttach, rec.anchor, side, lineOp);
    rec.line.visible = visible;
  }

  /** Hide a rec fully (opacity 0), keeping it off the rails. @private */
  _hideRec(rec) {
    const vis = rec.op > 0.02;
    rec.sprite.material.opacity = rec.op;
    rec.sprite.visible = vis;
    rec.line.material.opacity = rec.op * LINE_OP_SCALE;
    rec.line.visible = vis;
    rec.dot.material.opacity = rec.op;
    rec.dot.visible = vis;
  }

  /**
   * Build a two-segment elbow leader ribbon: a horizontal screen-space stub off
   * the card edge (toward the ship), then a straight run to the anchor.
   * `attachWorld` is the card's on-rail edge (world); `anchorLocal` the part.
   * @private
   */
  _setElbowLocal(line, attachWorld, anchorLocal, side, opacity) {
    // Attach point in local space.
    this._rA.copy(attachWorld);
    this.player.worldToLocal(this._rA);
    // Anchor in local space (Vector3, resolved per frame — T1).
    const anchorL = this._rB.copy(anchorLocal);
    // Elbow joint: attach + a horizontal screen stub toward the ship.
    const stubWorld = CFG.ELBOW_STUB_NDC * this._halfW;
    const dir = (side === 'L') ? 1 : -1; // left rail → stub goes right (toward ship)
    this._vElbow.copy(attachWorld).addScaledVector(this._camRight, dir * stubWorld);
    this.player.worldToLocal(this._vElbow);

    const pos = line.geometry.attributes.position;
    this._ribbonQuad(pos, 0, this._rA, this._vElbow);
    this._ribbonQuad(pos, 4, this._vElbow, anchorL);
    pos.needsUpdate = true;
    line.material.opacity = opacity;
  }

  /** Write a 4-vertex camera-facing ribbon quad (local space) at index base. @private */
  _ribbonQuad(pos, base, aLocal, bLocal) {
    this._rMid.copy(aLocal).add(bLocal).multiplyScalar(0.5);
    this._rView.copy(this._vCamLocal).sub(this._rMid);
    this._rDir.copy(bLocal).sub(aLocal);
    this._rPerp.copy(this._rDir).cross(this._rView);
    if (this._rPerp.lengthSq() < 1e-30) this._rPerp.set(0, 1, 0).cross(this._rDir);
    this._rPerp.normalize().multiplyScalar(this._leaderHalfWidth || 0);

    this._rC0.copy(aLocal).add(this._rPerp);
    this._rC1.copy(aLocal).sub(this._rPerp);
    this._rC2.copy(bLocal).sub(this._rPerp);
    this._rC3.copy(bLocal).add(this._rPerp);
    pos.setXYZ(base + 0, this._rC0.x, this._rC0.y, this._rC0.z);
    pos.setXYZ(base + 1, this._rC1.x, this._rC1.y, this._rC1.z);
    pos.setXYZ(base + 2, this._rC2.x, this._rC2.y, this._rC2.z);
    pos.setXYZ(base + 3, this._rC3.x, this._rC3.y, this._rC3.z);
  }

  dispose() {
    this._detachPointer();
    // Wave 5 (2): drop the REFIT ghost set before the outline teardown below
    // (bases restored is moot — the materials are about to dispose — but the
    // set must not hold freed recs). Guarded like _setActive for rig stubs.
    if (this._ghostRecs && this._ghostRecs.size) this._clearGhosts();
    // T2a: if inspection was active, tell the HUD breadcrumb to hide before
    // we tear down — otherwise it stays on screen permanently.
    if (this._active) {
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: null });
      this._active = false;
    }
    eventBus.off?.(Events.CAMERA_VIEW_CHANGE, this._onViewChange);
    eventBus.off?.(Events.INSPECT_HULL_OUTLINE, this._onHullOutline);
    for (const s of this._allRecs) {
      // Dispose all cached card variants.
      if (s._cardCache) {
        for (const card of s._cardCache.values()) {
          card?.texture?.dispose();
        }
        s._cardCache.clear();
      }
      s.card?.texture?.dispose();
      s.sprite?.material?.dispose();
      s.line?.geometry?.dispose();
      s.line?.material?.dispose();
      s.dot?.material?.dispose();
      // Hover outlines live under the hull meshes (not _group) — detach and
      // dispose each LineSegments' own EdgesGeometry, then the rec's materials.
      // Shell meshes SHARE the hull meshes' geometry: remove them but NEVER
      // dispose that geometry (it belongs to the live model).
      if (s._outline) {
        for (const line of s._outline.lines) {
          line.parent?.remove(line);
          line.geometry.dispose();
        }
        for (const shell of s._outline.shells || []) {
          shell.parent?.remove(shell);
        }
        s._outline.material.dispose();
        s._outline.shellMaterial?.dispose();
        s._outline = null;
      }
    }
    this.player.remove(this._group);
  }
}

// Exported for tests (drift guard on the label table / codexId mapping).
export { SYSTEMS as MOTHER_CALLOUT_SYSTEMS };
