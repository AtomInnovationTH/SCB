/**
 * MotherCallouts.js — in-world 3D inspection callouts for the mothership.
 *
 * Part labels, leader lines and detail cards are anchored onto the real model (no 2D schematic pane). A screen-space
 * side-rail layout flanks the ship with two stacked columns of cards joined to their anchors by elbow leaders.
 *
 * Labels in steps (DECISIONS §13 r3): system names show in EVERY band; a system's part labels appear only while that
 * system is OPEN — pinned by click/tap, held by hovering any of its parts or its name, lingered
 * CALLOUTS.OPEN_LINGER_MS after the pointer leaves, or (inside the close lens) held by the part nearest screen centre.
 * At rest only the system names show (six; seven once the radiators are bought).
 *
 * Zoom bands (camera-to-ship distance, with hysteresis):
 *   Band 1  SYSTEM    (far, > ~9 m)   : system names only (no hull hover).
 *   Band 2  PART      (mid, ~9–4 m)   : + the OPEN system's major part cards.
 *   Band 3  COMPONENT (close, < ~4 m) : + the open system's detail cards and a proximity reveal around the focused
 *                                       part. Cards stay compact; the full detail card lives on hover (the dossier).
 *
 * Hull-part hover: parts with `pick:` hull-object names raycast alongside the card sprites at 10 Hz. Hovering a part
 * outlines it in house cyan (see _ensureOutline) and brightens its card; a click equals clicking the card (one hover
 * state `_hoverRec`, one CODEX_OPEN_ENTRY emitter). Hull MESHES are pickable whenever they can be on screen in the
 * PART/COMPONENT bands, regardless of the card's rail cull, facing gate or detail tier; the CARD keeps its visibility
 * gate (_recPickable).
 *
 * HOVER DOSSIER (docs/ladder/08-workbench.md §2 Motion): after 400 ms dwell on ONE rec, one reusable sprite beside the
 * pointer shows the full detail card (see _updateDossier). Touch never sees it.
 *
 * REFIT ghosts: setGhostOutline(partIds) / getPartsBySystem(); the optional onPartClick hook routes a resolved
 * part/card click to the REFIT card instead of the Library emit.
 *
 * PART PORTRAIT: getPartFrame(partId) and withHiddenForPortrait(fn) serve the SPECS pane's one-shot portrait render.
 *
 * Gating mirrors the hull outline: active while the INSPECTION view (CAMERA_VIEW_CHANGE) or the OVERVIEW zoom
 * sub-state (INSPECT_HULL_OUTLINE) reports inspection on.
 *
 * Render pipeline: the callout group is a child of `player`, and SceneManager._updateNearCamera() re-tags every
 * near-field subtree onto NEAR_FIELD_LAYER EVERY FRAME, so sprites render in the NEAR pass after clearDepth() and the
 * hull can never overpaint them. The pass's ×1e5 camera-relative scale applies to the shared root and every position
 * here goes through player.worldToLocal / local anchors, so screen size and position are preserved. Near-plane
 * clipping of dots/leader tips cannot happen: min inspect distance is 2 m (CameraSystem) vs a 1.33 m clip threshold
 * for the fore-most anchor (1.3 m).
 *
 * @module ui/MotherCallouts
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { PlayerSatellite } from '../entities/PlayerSatellite.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { createCardTexture, CARD_W_OVER_TITLE_H, wrapHint } from '../scene/labelTexture.js';
import { fontEpoch as defaultFontEpoch } from '../core/Typeface.js';
import { orderRail } from '../scene/railOrder.js';
import { RAIL_GEOMETRY } from './RailGeometry.js';
import { GestureHints } from './hud/GestureHints.js';
import { TAP_SLOP_PX, TAP_SLOP_MS } from '../systems/TapPick.js';
import { engineGasKg } from '../systems/ResourceSystem.js';
import { DEG2RAD, degToRad, clamp01, clamp } from '../core/MathUtil.js';
import { VisualLaw } from '../core/VisualLaw.js';

// 1 metre in scene units (mirrors PlayerSatellite's M = 0.00001).
const M = 0.00001;

const CFG = Constants.CALLOUTS;
const HUES = CFG.SYSTEM_HUES;
const RISK = CFG.RISK_COLORS;

// Flower struts' card row. Desktop names the O key; glass has no such key, so its row names no control (chosen in `specRow`).
const FLOWER_ROW = 'They open LIKE A FLOWER \u2014 O opens to 146\u00B0 / folds flat';
const FLOWER_ROW_GLASS = 'They open LIKE A FLOWER \u2014 146\u00B0 open / folds flat';
const specRow = (row) => (row === FLOWER_ROW && GestureHints.isGlass() ? FLOWER_ROW_GLASS : row);

// Anchors are LOCAL model coordinates (parented to the PlayerSatellite group), in metres × M, from the real model
// build in PlayerSatellite.js (+Z fore, −Z aft, XY radial; barrel r=0.40, L=2.0 → caps at z=±1.0).
//
// Per part: id (stable key for tests + internals; display copy may change freely), massKg/specs (detail card),
// priority (higher = kept when a rail overflows), risk (GREEN/YELLOW/RED badge dot), codexId (deep-link), live (id read
// by _liveRows()), and:
//   tier     'major' → PART + COMPONENT bands; 'detail' → COMPONENT band only, and only when its system owns the
//            focused part OR it sits near the focused part on screen (proximity reveal).
//   mesh     PlayerSatellite mesh name; the anchor resolves from the live mesh instead of the static `anchor` (which
//            stays as the fallback, with a one-time console.warn if the name doesn't resolve).
//   dynamic  re-resolve the mesh anchor EVERY frame (the mesh moves, e.g. strut-mounted reel cartridges).
//   meshOffset  optional [x, y, z] (ship frame, metres × M) ADDED to the resolved mesh position, for a feature the mesh
//            origin is not at; rides a `dynamic` mesh too. Ignored without `mesh`; the static `anchor` is never offset.
//   pick     PlayerSatellite object names used ONLY for hull hover (raycast targets + cyan edge outline); NEVER moves an
//            anchor. Resolved via player.traverse collecting EVERY match, so the sets must be DISJOINT subtrees across
//            parts. Absent → `mesh ? [mesh] : []`. Card-only parts (berths/mli, anchorless structure plates) carry no
//            `pick` on purpose; the THERMAL family and the daughters pick through `pickPrefixes` / live arm groups.
//   pickPrefixes  optional name PREFIXES completing the parent-part roll-up (DECISIONS §13 ruling 4): every object
//            under `player` whose name STARTS WITH one joins this part's pick targets, so small pieces (bolts, clips,
//            mounts, booms, panels) highlight their part and block the pointer for the part behind. Same traverse-all
//            rule as `pick`, so prefixes must stay disjoint across parts; the pick-table test pins both.
//   flowerGated  the part's mesh exists only after the aft radiator flower is bought: until then the mesh lookup is
//            skipped (no warn, static `anchor` used) and re-armed on the gone→present edge (_resolveAnchor).
const SYSTEMS = [
  {
    id: 'POWER', label: 'POWER',
    anchor: [ 1.0 * M, 0, 0 ],
    role: 'solar wings + hull cells',
    parts: [
      { id: 'rosa_wings', name: 'ROLL-OUT SOLAR WINGS', risk: 'GREEN', tier: 'major', codexId: 'rosa_solar_array',
        massKg: 22, priority: 9, live: 'rosa',
        // Peak figures measured with the real ship builder and settle loop (`test-MotherPower.js` method).
        specs: ['2× 1×2 m roll-out arrays', 'Wings-only peak ~1.63 kW, ~1.83 kW with body cells'],
        pick: ['ROSA_Panel_Front_0deg', 'ROSA_Panel_Back_0deg', 'ROSA_Panel_Front_180deg', 'ROSA_Panel_Back_180deg'],
        pickPrefixes: ['ROSA_Boom', 'ROSA_Bracket', 'ROSA_Spreader', 'ROSA_SpoolCurl'],
        // Leader follows the +X blanket centre through sun-tracking tilt and furl; static anchor stands in until the mesh binds.
        mesh: 'ROSA_Panel_Front_0deg', dynamic: true,
        anchor: [ 1.1 * M, 0, 0 ] },
      { id: 'body_cells', name: 'HULL SOLAR CELLS', risk: 'GREEN', tier: 'detail', codexId: 'gallium_arsenide',
        massKg: 3, priority: 2, specs: ['Body-mounted gallium-arsenide cells'],
        // az 33.75° facet centre, central PV row (face radius barrelR×1.014); az 0° sits in the ROSA-root keep-out
        // (40 facet cells + 4 end-band gap cells; keep-out clearances measured in `PlayerSatellite` `_buildMainBus`).
        pick: [
          ...Array.from({ length: 40 }, (_, i) => `BarrelSolarPanel_${i}`),
          'BarrelSolarPanel_gap_94.65_F', 'BarrelSolarPanel_gap_94.65_A',
          'BarrelSolarPanel_gap_274.65_F', 'BarrelSolarPanel_gap_274.65_A',
        ],
        anchor: [ 0.337 * M, 0.2254 * M, 0 ] },
      { id: 'array_roll', name: 'SOLAR WING SPOOL', risk: 'GREEN', tier: 'detail', codexId: 'solar_power',
        massKg: 4, priority: 2, specs: ['Roll-out drum + drive'],
        // DERIVED, never typed: ROSA_BRACKET_LEN is a live lever, so a literal would strand the leader (rosaSpoolAxisM).
        pick: ['ROSA_Spool_0deg', 'ROSA_Spool_180deg'],
        // §13 r4 roll-up: wing clamp bodies are spool hardware (the motor boxes/pads belong to WING MOTOR BOX).
        pickPrefixes: ['WingClamp'],
        anchor: [ PlayerSatellite.rosaSpoolAxisM() * M, 0, 0 ] },
      // One motor box per wing (DECISIONS §10). DERIVED anchor: COLLAR_RADIUS + WING_MOTOR_PAD_H + WING_MOTOR_BOX_DEEP/2.
      { id: 'wing_motor_box', name: 'WING MOTOR BOX', risk: 'GREEN', tier: 'detail', codexId: 'solar_power',
        massKg: 3, priority: 2, specs: ['Turns the wing', 'Bolted to the mid-body ring'],
        pick: ['WingMotorBox_0deg', 'WingMotorBox_180deg', 'WingMotorPad_0deg', 'WingMotorPad_180deg'],
        anchor: [ (Constants.OCTOPUS_V5.COLLAR_RADIUS + Constants.OCTOPUS_V5.WING_MOTOR_PAD_H
                   + Constants.OCTOPUS_V5.WING_MOTOR_BOX_DEEP / 2) * M, 0, 0 ] },
    ],
  },
  {
    id: 'PROPULSION', label: 'PROPULSION',
    anchor: [ 0, 0, -1.0 * M ],
    role: 'ion thrust + cold-gas steering',
    parts: [
      { id: 'feep', name: 'ION THRUSTERS (FEEP)', risk: 'YELLOW', tier: 'major', codexId: 'feep_thruster',
        massKg: 8, priority: 8, live: 'feep',
        specs: ['4× emitter clusters', 'Specific impulse ~4000 s'],
        // The 4 emitter cluster bodies (FEEP_Boss/FEEP_GridDisc share duplicate names and are cull-hidden mm detail).
        pick: ['MainFEEP_0', 'MainFEEP_1', 'MainFEEP_2', 'MainFEEP_3'],
        anchor: [ 0, -0.20 * M, -1.05 * M ] },
      { id: 'rcs', name: 'COLD-GAS STEERING', risk: 'GREEN', tier: 'major', codexId: 'cold_gas_rcs',
        massKg: 3, priority: 5, specs: ['Nitrogen thruster ring'],
        pick: ['RCSPod_0', 'RCSPod_1', 'RCSPod_2', 'RCSPod_3'],
        // §13 r4 roll-up: pod boots, bolts, thruster bells, liners and throats ('RCSPod' also carries boots and bolts; 60 meshes).
        pickPrefixes: ['RCSPod', 'RCSThruster', 'RCSLiner', 'RCSThroat'],
        anchor: [ -0.03 * M, 0.42 * M, -0.795 * M ] },
      { id: 'mli', name: 'THERMAL BLANKET (MLI)', risk: 'GREEN', tier: 'detail', codexId: 'mli_insulation',
        massKg: 2, priority: 2, specs: ['Multi-layer insulation'],
        // Bare-MLI shoulder band above the fore cell row (cells end at z=0.72).
        anchor: [ 0.404 * M, 0, 0.78 * M ] },
      { id: 'aft_deck', name: 'AFT THRUSTER DECK', risk: 'GREEN', tier: 'detail', codexId: 'aft_thruster_deck',
        massKg: 4, priority: 1, specs: ['Aft plate — 0.6 m deck'],
        mesh: 'AftThrusterDeck',
        anchor: [ 0, 0.20 * M, -1.008 * M ] },
    ],
  },
  {
    id: 'PAYLOAD', label: 'PAYLOAD',
    // On collar hardware, not in the bore: the outboard skin of the az-90 BerthCollarStrut_1 at z ≈ 1.15.
    anchor: [ 0, 0.265 * M, 1.156 * M ],
    role: 'net launcher + spin-brake',
    parts: [
      { id: 'despin', name: 'SPIN-BRAKE LASER', risk: 'RED', tier: 'major', codexId: 'detumble',
        massKg: 9, priority: 9, live: 'despin',
        specs: ['Photon-pressure despin', '~5 W fibre laser'],
        // Gimbal child — dynamic so the anchor tracks the turret. LaserMuzzle is the ANCHOR mesh but a geometry-less
        // Object3D, so it can't outline: the two real gimbal meshes (telescope, baffle) carry the hover.
        mesh: 'LaserMuzzle', dynamic: true,
        pick: ['LaserTelescope', 'LaserBaffle'],
        anchor: [ -0.184 * M, 0.184 * M, 1.20 * M ] },
      { id: 'net_launcher', name: 'LARGE NET LAUNCHER', risk: 'GREEN', tier: 'major', codexId: 'miura_ori_net',
        massKg: 5, priority: 7, specs: ['Miura-ori net, ~5 m span'],
        // ONE launcher, centred inside the collar bore: bind the HOUSING; the static fallback is its top surface. The
        // cells are children of the housing, so the exact-name pick outlines the whole assembly.
        mesh: 'NetLauncher',
        pick: ['NetLauncher'],
        anchor: [ 0, 0.12 * M, 1.16 * M ] },
      { id: 'berth_collar', name: 'DOCKING COLLAR', risk: 'GREEN', tier: 'detail', codexId: 'capture_collar',
        massKg: 3, priority: 3,
        // Links its own debris-capture briefing: the nose collar is where CAUGHT DEBRIS mates rigidly on-axis
        // (`capture_collar` lists this card's name in hardwareNames; the search bridge test pins it). The id
        // `berth_collar` (refitIndex, tests) and the mesh name NetBerthCollar are frozen.
        // SKELETON: BerthCollarRing (R 0.180, tube 0.020, bore 0.16) on BerthCollarStrut_0..3, BerthFace plate on the
        // turntable top. BerthTunnel / BerthFlange / BerthCollarGuideCone are retired (they blocked the ring optics:
        // test-SensorClearance).
        specs: [
          `Nose collar \u00b7 ${(2 * (Constants.OCTOPUS_V5?.BERTH_COLLAR_INNER_R_M ?? 0.16)).toFixed(2)} m bore`,
          `Seat plane z ${(Constants.OCTOPUS_V5?.BERTH_COLLAR_Z_M ?? 1.30).toFixed(2)} m \u00b7 cargo mates on-axis`,
          'Open capture ring on 4 struts',
        ],
        mesh: 'BerthCollarRing',
        pick: ['BerthCollarRing', 'BerthCollarStrut_0', 'BerthCollarStrut_1', 'BerthCollarStrut_2', 'BerthCollarStrut_3', 'BerthFace'],
        pickPrefixes: ['BerthCollarFoot', 'BerthCollarLamp', 'BerthCollarFlange'],
        // Offset to the ring's OUTER equator at az 60 (R + tube = 0.200): BerthCollarRing's origin is the bore centre
        // (the live anchor would sit in the hole). The ±Y ring face carries the fore sun sensors (az 90/270); az 60 is
        // above the telescope top and off the ±Y struts, so the leader tip sits on the tube from fore-on / fore-q-stbd /
        // fore-q-top. Mode B harness (`scripts/visual-ab/mother-audit-shots.mjs`): BerthCollarRing, gap ∈ [−0.02, +0.005].
        // The static tuple is the same point.
        meshOffset: [ 0.100 * M, 0.1732 * M, 0 ],
        anchor: [ 0.100 * M, 0.1732 * M, 1.30 * M ] },
    ],
  },
  {
    id: 'SENSORS', label: 'SENSORS',
    // The deck lip (r 0.34–0.38, z 1.03).
    anchor: [ 0, 0.37 * M, 1.03 * M ],
    role: 'tracking turret + cameras',
    parts: [
      { id: 'gimbal', name: 'SENSOR TURRET', risk: 'GREEN', tier: 'major', codexId: 'docking_precision',
        massKg: 5, priority: 6, specs: ['2-axis pointing platform'],
        // SensorGimbal itself is a geometry-less Group; pick the turntable body (SensorHubRing). Anchor on its top face
        // at az 105: 50 mm clear of the az-90 collar strut's foot pad rim, 55 mm outside the telescope barrel
        // (az 135, r 0.10) and clear of the ring / puck. Mode B: SensorHubRing, gap 0.
        pick: ['SensorHubRing'],
        anchor: [ -0.080 * M, 0.299 * M, 1.055 * M ] },
      { id: 'eo_cam', name: 'DAYLIGHT CAMERA', risk: 'GREEN', tier: 'major', codexId: 'pose_estimation',
        massKg: 2, priority: 4, specs: ['Visible-band imager'],
        pick: ['EO_Camera'],
        anchor: [ 0.184 * M, 0.184 * M, 1.11 * M ] },
      { id: 'ir_cam', name: 'HEAT (INFRARED) CAM', risk: 'GREEN', tier: 'major', codexId: 'trackable_vs_dark',
        massKg: 2, priority: 4, specs: ['Long-wave infrared — spots dark debris'],
        pick: ['IR_Sensor'],
        anchor: [ -0.1715 * M, -0.1715 * M, 1.145 * M ] },   // IR box on the turret (centre r 0.2425, mid-height 1.145)
      { id: 'lidar', name: 'LASER RANGEFINDER', risk: 'GREEN', tier: 'major', codexId: 'lidar_ranging',
        massKg: 3, priority: 5, specs: ['Flash LIDAR — range + pose'],
        pick: ['LIDAR_Dome'],
        pickPrefixes: ['LIDAR_Drum'],
        anchor: [ 0.184 * M, -0.184 * M, 1.10 * M ] },
      { id: 'star_trackers', name: 'STAR TRACKERS', risk: 'GREEN', tier: 'major', codexId: 'star_tracker',
        massKg: 1, priority: 3, specs: ['2× — attitude from starfield'],
        pick: ['StarTracker_0', 'StarTracker_1'],
        pickPrefixes: ['StarTracker_'],
        anchor: [ 0.042 * M, 0.398 * M, 0.90 * M ] },
      { id: 'fore_bulkhead', name: 'FORE BULKHEAD', risk: 'GREEN', tier: 'major', codexId: 'fore_bulkhead',
        massKg: 6, priority: 3, specs: ['Fore end cap — 0.8 m plate', 'Carries the sensor deck'],
        mesh: 'FrontCap_ConfigG',
        anchor: [ 0.30 * M, -0.28 * M, 1.005 * M ] },
      { id: 'sensor_deck', name: 'SENSOR DECK', risk: 'GREEN', tier: 'detail', codexId: 'sensor_deck',
        massKg: 2, priority: 2, specs: ['Instrument mounting annulus'],
        mesh: 'SensorDeck',
        // SensorDeck's origin is the bore centre, inside the collar bore: point at the deck lip, 1 mm proud of the plate
        // (the static stays; its ≥ 4 cm envelope is measured). Lip az 65: az 90 sits between the star trackers (az
        // 82/98) and the leader landed on StarTracker_0; az 65–69 is the stable window over the 12 audit poses.
        meshOffset: [ 0.156 * M, 0.335 * M, 0.001 * M ],
        anchor: [ 0, 0.30 * M, 1.03 * M ] },
      { id: 'sun_sensors', name: 'SUN SENSORS', risk: 'GREEN', tier: 'detail', codexId: 'sun_sensor',
        massKg: 0.5, priority: 2, specs: ['Coarse sun sensing, 4×'],
        // Fore pair on the capture ring's fore face at (0, ±0.180, 1.3235): the turntable site was 58 % blind behind the
        // ring instruments (test-SensorClearance register S7/S8). Bind the +Y puck; the static is its centre.
        mesh: 'SunSensor_0',
        pick: ['SunSensor_0', 'SunSensor_1', 'SunSensor_2', 'SunSensor_3'],
        anchor: [ 0, 0.180 * M, 1.3235 * M ] },
      { id: 'nav_lights', name: 'NAVIGATION LIGHTS', risk: 'GREEN', tier: 'detail', codexId: 'nav_lights',
        massKg: 1, priority: 1, specs: ['Port/starboard running lights'],
        // Fore shoulder at z 0.76, az 336/204: the core clears the FURLED ROSA coil (r 0.158) — (0.376, −0.168). Bind the
        // starboard core (no pick array: the default pick is the mesh).
        mesh: 'NavLight_Starboard',
        // The port light's housing (the starboard one is a child of the bound core).
        pickPrefixes: ['NavHousing_Port'],
        anchor: [ 0.376 * M, -0.168 * M, 0.76 * M ] },
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
        // §13 r4 roll-up: the fore omni's base. The _1 names stay with the
        // AFT whip below — one prefix per end, never both.
        pickPrefixes: ['TTC_Omni_0'],
        anchor: [ 0, -0.40 * M, 0.92 * M ] },
      { id: 'mga', name: 'MEDIUM-GAIN ANTENNA', risk: 'GREEN', tier: 'detail', codexId: 'bandwidth_limits',
        massKg: 1, priority: 2, specs: ['Tangent patch, higher rate'],
        pick: ['MGA_Patch'],
        pickPrefixes: ['MGA_Bezel'],
        anchor: [ 0.363 * M, 0.169 * M, 0.87 * M ] },
      { id: 'gps', name: 'GPS ANTENNAS', risk: 'GREEN', tier: 'detail', codexId: 'gps_denied',
        massKg: 0.5, priority: 2, specs: ['GPS patch pair'],
        pick: ['GPS_Patch_0', 'GPS_Patch_1'],
        pickPrefixes: ['GPS_Bezel_'],
        anchor: [ 0.376 * M, -0.137 * M, 0.87 * M ] },
      // codexId (owner 2026-09-03): the aft whip is the second half of the omni PAIR — one S-band radio system, one briefing
      // (`frequency_bands`). `comms_blackout` stays reachable by its own unlock and the frequency_bands related chip.
      { id: 'ttc_aft', name: 'S-BAND OMNI (AFT)', risk: 'GREEN', tier: 'detail', codexId: 'frequency_bands',
        massKg: 1, priority: 1, specs: ['Aft whip of the omni pair'],
        pick: ['TTC_Omni_1'],
        pickPrefixes: ['TTC_Omni_1'],
        anchor: [ 0.40 * Math.cos(degToRad(78)) * M, 0.40 * Math.sin(degToRad(78)) * M, -0.92 * M ] },
    ],
  },
  {
    id: 'CAPTURE', label: 'CAPTURE',
    // Berth groove, centreline — next to the docked daughters, the only capture hardware the player can SEE.
    anchor: [ 0, 0.35 * M, -0.75 * M ],
    role: '4× daughter craft + berths',
    parts: [
      { id: 'berths', name: 'DAUGHTER BERTHS', risk: 'GREEN', tier: 'major', codexId: 'docking_berthing',
        massKg: 6, priority: 6, specs: ['4× — 2 large, 2 small', 'Spring ejector + hinge strut'],
        // az 64° pocket's aft-lip CORNER, on the hull radius (r 0.40) at z=-0.85 — a real hull edge, ~15 cm clear of the
        // docked daughter's own callout (anchor: craft body mid-pocket, z=-0.70).
        anchor: [ 0.0512 * M, 0.3967 * M, -0.85 * M ] },
      { id: 'tether_reels', name: 'TETHER WINCHES', risk: 'GREEN', tier: 'major', codexId: 'reel_mechanics',
        massKg: 4, priority: 6, specs: ['4× Dyneema fiber reels'],
        // Reel cartridges ride the struts (stowed z≈−0.46, deployed ≈1.5 m out). ReelCartridge_0 stays the ANCHOR mesh
        // (reel #0 only); pick all 4 reel housings. Stand-in at az 64 (r 0.40, the trial strut azimuth).
        mesh: 'ReelCartridge_0', dynamic: true,
        pick: ['ReelHousing_0', 'ReelHousing_1', 'ReelHousing_2', 'ReelHousing_3'],
        pickPrefixes: ['ReelDrum', 'ReelLED'],
        anchor: [ 0.1754 * M, 0.3595 * M, -0.46 * M ] },
      // codexId (owner 2026-09-03): the Double-A clevises are the cradle struts' HINGES — `vacuum_mechanisms` is their briefing;
      // `robotic_arm` describes the DAUGHTER craft.
      { id: 'hinges', name: 'STRUT HINGES', risk: 'YELLOW', tier: 'detail', codexId: 'vacuum_mechanisms',
        massKg: 2, priority: 2, specs: ['Double-A clevis, 4×'],
        pick: ['AFrame_64_L', 'AFrame_64_R', 'AFrame_116_L', 'AFrame_116_R',
          'AFrame_244_L', 'AFrame_244_R', 'AFrame_296_L', 'AFrame_296_R'],
        pickPrefixes: ['HingePad', 'HingePin', 'HingeLED', 'AFrame_'],   // AFrame_ also takes encoder, stops, latch, harness (AFrame_<az>_<part>)
        // DERIVED: first strut azimuth, hinge radius 0.44 m, hinge plane z = COLLAR_Y (the front ring). A literal would
        // point 10 cm aft of the real hinge.
        anchor: [ 0.44 * Math.cos(degToRad(Constants.ARM_LADDER.Y0_QUAD.azimuths[0])) * M,
                  0.44 * Math.sin(degToRad(Constants.ARM_LADDER.Y0_QUAD.azimuths[0])) * M,
                  Constants.OCTOPUS_V5.COLLAR_Y * M ] },
      { id: 'cradle_spring', name: 'CROSSBOW SPRING', risk: 'YELLOW', tier: 'detail', codexId: 'spring_energy',
        massKg: 1, priority: 2, specs: ['Spring ejector — launches daughters'],
        // Spring group rides the strut (stowed z≈−0.62, deployed ≈1.7 m out). CrossbowSpring_0 stays the ANCHOR mesh
        // (reel #0 only); pick all 4 spring housings. Stand-in at az 64 (r 0.40, the trial strut azimuth).
        mesh: 'CrossbowSpring_0', dynamic: true,
        pick: ['SpringHousing_0', 'SpringHousing_1', 'SpringHousing_2', 'SpringHousing_3'],
        pickPrefixes: ['GuideRail', 'SpringCoil'],
        anchor: [ 0.1754 * M, 0.3595 * M, -0.62 * M ] },
      // §13 r4: the four daughter cradle struts. Dimensions are the builder's (PlayerSatellite._buildStruts:
      // STRUT_LENGTH 1.70 m, STRUT_TUBE_OD 0.050 m, CFRP T800/M21); no documented set mass, so a labelled ESTIMATE.
      { id: 'daughter_struts', name: 'DAUGHTER STRUTS', risk: 'GREEN', tier: 'detail', codexId: 'docking_berthing',
        massKg: 7, priority: 2,
        specs: ['4× 1.70 m CFRP tubes, 50 mm OD', 'Sweep drive + brake at each hinge', 'Set mass ≈ 7 kg (estimate)'],
        // The anchor rides strut 0's mid-point (its mesh origin; the cylinder is centred) through every sweep pose; the
        // static fallback is the measured stowed mid-strut (0.548, 1.123, 1.00).
        mesh: 'Strut_0', dynamic: true,
        pickPrefixes: ['Strut_', 'RootCollar', 'TipCollar', 'RibRing', 'PClip', 'StrutMotorBox', 'StrutRest', 'Bushing', 'CClip'],
        anchor: [ 0.548 * M, 1.123 * M, 1.00 * M ] },
      // No net-launcher part for the daughters: that hardware lives on the ArmUnit, never on the Mother.
    ],
  },
  {
    // The AFT FLOWER family; hue row in Constants.CALLOUTS.SYSTEM_HUES.THERMAL — BOTH places, or the family renders
    // fallback-hued. Purchase-gated: every rec carries `flowerGated` and hides until a pair is bought (the daughter
    // `_armGone` idiom). Every rec keeps a STATIC station tuple as the pre-purchase stand-in; the two pose-following
    // rows (RADIATOR PLATES, TIP HARDPOINTS) also carry `mesh` + `dynamic: true`, armed by _resolveAnchor on the
    // gone→present edge, so the leader rides the plate / tip boss through the bloom.
    // Stations are az 40/140/220/320, clocked to the ROSA plane, clevis pin at r 0.475: the family anchor and the two
    // static rows (STRUTS az 40, HINGE BRACKETS az 320) sit on the hinge (0.3639, 0.3053). HINGE BRACKETS massKg 2.6
    // so the family total follows the 51.6 kg budget pin (37 + 10 + 2 + 2.6).
    id: 'THERMAL', label: 'THERMAL',
    anchor: [ 0.3639 * M, 0.3053 * M, -1.02 * M ],
    role: 'aft flower — struts open LIKE A FLOWER',
    flowerGated: true,
    parts: [
      { id: 'flower_plates', name: 'RADIATOR PLATES', risk: 'GREEN', tier: 'major', codexId: 'space_radiator',
        massKg: 37, priority: 6, flowerGated: true,
        specs: ['4× 1.50×0.60 m tri-panel radiators, fold flat for launch', 'Reject heat as infrared — numbers come with the loop refit'],
        // Leader follows plate 0 (pair A, az 40); the flowerGated one-shot binds the frame after purchase. The static
        // stand-in sits on pair A's other station side (az 225, not a hardware pin), clear of the STRUTS card at az 40.
        mesh: 'FlowerStrutPlate_0', dynamic: true,
        // §13 r4 roll-up: ALL twelve radiator panels (4 plates, 8 wings, seams, knuckles) answer as the plates (44 meshes).
        pickPrefixes: ['FlowerStrutPlate_', 'FlowerStrutWing_', 'FlowerStrutWingSeam', 'FlowerStrutWingKnuckle'],
        anchor: [ -0.30 * M, -0.30 * M, -1.15 * M ] },
      { id: 'flower_struts', name: 'AFT FLOWER STRUTS', risk: 'GREEN', tier: 'major', codexId: 'vacuum_mechanisms',
        massKg: 10, priority: 6, flowerGated: true,
        specs: ['4× aft-pivot booms, 2.30 m — fold fore along the bus for launch', FLOWER_ROW],
        // §13 r4 roll-up: the 4 booms and their seams (the wing hinge lugs stay with the hinge brackets).
        pickPrefixes: ['FlowerStrut_', 'FlowerStrutSeam'],
        anchor: [ 0.3639 * M, 0.3053 * M, -1.10 * M ] },
      { id: 'flower_tips', name: 'TIP HARDPOINTS', risk: 'GREEN', tier: 'detail', codexId: 'tip_hardpoints',
        massKg: 2, priority: 2, flowerGated: true,
        specs: ['Inert cargo bosses at the strut tips', 'Cold-cell refit will bolt on here'],
        // Leader rides tip boss 0 (az 40) through the pose (static stands in pre-purchase, then the gated one-shot binds).
        mesh: 'FlowerStrutTipPad_0', dynamic: true,
        // §13 r4 roll-up: all four tip pads (pad 0 already answers via the mesh default).
        pickPrefixes: ['FlowerStrutTipPad', 'FlowerStrutTipStalk', 'FlowerStrutTipCone'],   // stalk tubes and cone roll up with their pad
        anchor: [ -0.283 * M, -0.283 * M, -1.12 * M ] },
      { id: 'flower_hinges', name: 'FLOWER HINGE BRACKETS', risk: 'YELLOW', tier: 'detail', codexId: 'vacuum_mechanisms',
        massKg: 2.6, priority: 2, flowerGated: true,
        specs: ['Rim-band clevises r 0.475, molybdenum-disulfide-filmed pins; wing piano hinges + one-shot latches', 'Hinges are the honest jam risk'],
        // §13 r4 roll-up: brackets, pins, rim mount bolts, the wing piano-hinge LUGS (hinge leaves between boom and
        // panel), and the launch hold-down (hull cradles + pin, boom latch lugs).
        pickPrefixes: ['FlowerStrutBracket', 'FlowerStrutPin', 'MountBolt_Flower', 'FlowerStrutHingeLug', 'FlowerStrutCradle', 'FlowerStrutLatch'],
        anchor: [ 0.3639 * M, -0.3053 * M, -0.94 * M ] },
    ],
  },
  {
    // Docked daughters — dynamic recs that follow each docked ArmUnit. Titles are static (berth i%2 alternates
    // Large/Small in ArmManager), so cards are built once; visibility is gated per frame on the arm's state.
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

// PORTRAIT POSE TABLE — per-card overrides for the SPECS pane's one-shot PART PORTRAIT (getPartFrame), keyed by part
// `id`. A card WITHOUT a row is photographed from the player's current side (it was just seen from there, so it is
// un-occluded); a row says that side is known-bad (occluded) and gives the side that works. Ship frame: +X stbd / +Y
// up / +Z fore. Distance is NEVER authored: it is solved from the pick-mesh box.
//   dir      [x, y, z] part → camera direction (normalised downstream).
//   stowDir  the flower family's alternative while the aft flower is CLOSED, STOWED or on a SLEW under half open
//            (getFlowerStatus: CLOSED, STOW, or SLEW with openFrac < 0.5; an aft-on look hits AftThrusterDeck). The family
//            frames only while a flower pair exists.
//   fill     the fraction of the frame's limiting axis the part's LARGEST projected extent spans (portraitCameraFit,
//            default 0.8; the sphere fallback reads it as its diameter fill). The pucks (sun sensors 0.35, nav lights 0.5) and the
//            patch antennas (MGA 0.6, GPS 0.5) frame LOOSE so the hull context stays (owner 2026-09-08 (Q3):
//            small parts framed loose); the MLI skin IS the hull, 0.85.
//   single   a SPREAD multi-instance part (pods / pucks / reels / A-frames) frames ONE instance: the pick target
//            nearest the player's camera (ties → the lowest index; no camera → the first). The union of the whole ring
//            framed the whole ship.
//   frame    portrait-ONLY geometry for a card-only row: mesh names under `player` (a nested list = one instance made
//            of several meshes; `{ arm: i }` = berth i's DOCKED daughter group). Replaces the hover picks as the frame
//            source, so card-only parts (mli, berths, flower struts, hinges) get no hover. owner 2026-09-03 (hull hover):
//            card-only, so no hull hover or outline for mli, berths, flower struts and hinges
//            (`test-MotherCallouts` `CARD_ONLY_IDS` pins it).
//   tangent  with `radial`: a component along the azimuthal tangent at the instance (+ = counter-clockwise from fore),
//            the side view for a part that a radially-outboard neighbour covers.
//   radial   `dir` = the framed box centre's own outward radial in the ship's XY plane + this [x, y, z] bias — the
//            camera sits outside the hull looking AT that instance (with `single`: the chosen one); an on-axis centre
//            keeps the row's `dir`. The docked DAUGHTERS use it on the docked arm.group (resolved live, DOCKED only).
const PORTRAIT_OVERRIDES = {
  // POWER — the blanket's FRONT face (+Y) is clear from top / hinge / aft-q; fore-on / aft-on hit the boom
  // §13 r4 roll-up pins: the `frame` rows freeze each portrait to the pre-roll-up pick list; a `single` portrait must
  // keep framing the INSTANCE, not the nearest bolt.
  rosa_wings:    { dir: [0.15, 1.0, 0.1], single: true, radial: [0, 1.2, 0.1], frame: ['ROSA_Panel_Front_0deg', 'ROSA_Panel_Back_0deg', 'ROSA_Panel_Front_180deg', 'ROSA_Panel_Back_180deg'] },   // ONE blanket face-on from above its own radial (the pair + barrel read as a whole-ship shot)
  body_cells:    { dir: [0.6, -0.8, 0.4] },             // from below-stbd — the cell wrap with both wings edge-on and far
  array_roll:    { dir: [1.0, 0.35, 0.2], single: true, radial: [0, 0.6, 0.8], frame: ['ROSA_Spool_0deg', 'ROSA_Spool_180deg'] },   // ONE spool from its fore-up radial (the blanket hides it from abeam)
  // PROPULSION — aft-end hardware; the aft-q-d3.2 pose is clear
  feep:          { dir: [0.6, 0.4, -1.0] },
  rcs:           { dir: [0.6, 0.4, -1.0], fill: 0.7, single: true, radial: [0, 0, 0.15], frame: ['RCSPod_0', 'RCSPod_1', 'RCSPod_2', 'RCSPod_3'] },   // ONE pod, bells face-on; fill 0.7 so the doghouse reads as a unit
  aft_deck:      { dir: [0.6, 0.4, -1.0] },
  mli:           { dir: [1.0, 0.35, 0.2], fill: 0.85, frame: ['Barrel_ConfigG'] },   // the skin IS the hull: the barrel fills the frame (portrait-only; hover stays card-only)
  // PAYLOAD — own mesh from fore-q-stbd / side / hinge; BerthFace gap 0.009 from the fore quarters
  despin:        { dir: [-0.9, 0.3, 0.8], fill: 0.7 },  // port-fore, tighter — the telescope tube through the open ring
  net_launcher:  { dir: [0.3, 0.3, 1.0] },              // ONE centred housing inside the collar
  berth_collar:  { dir: [0.4, 0.25, 1.0] },             // dead-ahead ([0.15, 0.15, 1]) let the whole sensor farm steal the frame
  // SENSORS — the turret cluster; instrument sides (+X EO / −X IR / −Y LIDAR dome / +Y canted trackers / the FrontCap)
  gimbal:        { dir: [0.5, 0.9, 0.5] },              // above-fore: from dead-ahead the turret hid behind the ring
  eo_cam:        { dir: [0.8, 0.4, 1.0], fill: 0.85 },  // stbd-fore-up — the aperture faces fore
  ir_cam:        { dir: [-0.8, 0.4, 1.0], fill: 0.85 }, // port-fore-up — the aperture side (mirror of eo_cam)
  lidar:         { dir: [0.2, -1.0, 0.3] },             // from below — the dome without the collar in front
  star_trackers: { dir: [0.3, 1.0, 1.0], fill: 0.7 },   // fore-up 45° — the two canted tubes read as tubes with openings
  fore_bulkhead: { dir: [1.0, 0.7, 0.3] },              // abeam-up — the plate's rim (the collar sits in front of its face)
  sensor_deck:   { dir: [0.6, 1.0, 0.4] },              // from above-fore
  sun_sensors:   { dir: [0.3, 0.8, 1.0], fill: 0.35, single: true, radial: [0, 0, 0.3] },   // ONE 5 cm puck, loose; the side radial reads the puck ON the ring-face rim where a fore-heavy radial read the hub
  nav_lights:    { dir: [0.8, -0.4, 0.6], fill: 0.5, radial: [0, 0, 0.3] },   // 3 cm core — loose (0.7 blew the core out), from its own radial
  // COMMS — the HGA faces nadir-ish; the patches face-on from the stbd grazes. MGA_Patch sits on the FORE shoulder at
  // z 0.87, az 25 (the stbd-graze-mga pose).
  ttc:           { dir: [0.4, -0.9, 0.7], fill: 0.6, radial: [0, 0, 0.5] },   // the omni from its own radial, fore-biased, with hull context
  mga:           { dir: [1.0, 0.4, 0.3], fill: 0.6 },   // a 20 cm patch, not a puck — 0.35 showed the whole forebody
  gps:           { dir: [0.9, 0.35, 0.2], fill: 0.5, single: true, radial: [0, 0, 0.2] },
  ttc_aft:       { dir: [0.6, 0.4, -1.0], fill: 0.6, radial: [0, 0, -0.5] },   // the aft omni from its own radial, aft-biased, with hull context
  // CAPTURE — the reel-close pose (upper reel cans from +Y); berths from the az-64 tunnel side
  // One berth = the az-64 daughter seated in its pocket ({ arm: 0 } — the docked arm.group, away → omitted) plus the
  // strut-root hardware on the fore hinge line (hinge pad, A-frame clevises, spring ejector, reel); the pocket itself
  // is carved into the barrel (no mesh). Hover stays card-only; the frame is portrait-only.
  berths:        { dir: [0.5, 0.87, 0.35], frame: [{ arm: 0 }, 'SpringHousing_0', 'ReelHousing_0'] },   // the seated daughter + its ejector / reel (the fore hinge line made it a whole-ship shot)
  tether_reels:  { dir: [0.2, 1.0, -0.3], single: true, radial: [0, 0, 0.2], frame: ['ReelHousing_0', 'ReelHousing_1', 'ReelHousing_2', 'ReelHousing_3'] },   // ONE reel can
  hinges:        { dir: [0.2, 1.0, -0.3], single: true, radial: [0, 0, 0.4], frame: ['AFrame_64_L', 'AFrame_64_R', 'AFrame_116_L', 'AFrame_116_R', 'AFrame_244_L', 'AFrame_244_R', 'AFrame_296_L', 'AFrame_296_R'] },   // ONE A-frame clevis
  cradle_spring: { dir: [0.2, 1.0, -0.3], fill: 0.5, single: true, radial: [0, 0, 0.3], tangent: 0.9, frame: ['SpringHousing_0', 'SpringHousing_1', 'SpringHousing_2', 'SpringHousing_3'] },   // ONE housing from the SIDE (tangent) — radially outboard sits its docked daughter
  // §13 r4: the new struts card frames ONE boom from its own radial.
  daughter_struts: { dir: [0.5, 0.5, 0.4], single: true, radial: [0, 0, 0.2], frame: ['Strut_0', 'Strut_1', 'Strut_2', 'Strut_3'] },
  // THERMAL — CARGO / PARK plates face-on from aft; STOW from aft-on hits AftThrusterDeck
  flower_plates: { dir: [0.6, 0.6, -0.8], stowDir: [1.0, 0.6, -0.5], frame: ['FlowerStrutPlate_0'] },   // stowDir abeam-aft-up: folded plates in profile along the barrel (aft-on read as a whole-ship 3/4); §13 r4 pin: the pick grew 12 panels + wings, the portrait keeps the one plate
  flower_struts: { dir: [0.6, 0.6, -0.8], stowDir: [1.0, 0.6, -0.5], single: true, radial: [0, 0, -0.8], frame: ['FlowerStrut_0', 'FlowerStrut_1', 'FlowerStrut_2', 'FlowerStrut_3'] },   // the booms (portrait-only); ONE boom from its radial-aft
  flower_tips:   { dir: [0.6, 0.6, -0.8], stowDir: [1.0, 0.6, -0.5], frame: ['FlowerStrutTipPad_0'] },   // stowDir abeam (the aft hub hid the stowed pad); §13 r4 pin: the pick grew 4 pads, the portrait keeps pad 0
  // One hinge = its clevis bracket + pin (one group = one instance); `single` frames the one nearest the camera.
  flower_hinges: { dir: [0.6, 0.6, -0.8], stowDir: [1.0, 0.6, -0.5], single: true, radial: [0, 0, -0.4], tangent: 0.8,   // from the side — the swung-out boom covered the clevis from its radial
                   frame: [['FlowerStrutBracket_0', 'FlowerStrutPin_0'], ['FlowerStrutBracket_1', 'FlowerStrutPin_1'], ['FlowerStrutBracket_2', 'FlowerStrutPin_2'], ['FlowerStrutBracket_3', 'FlowerStrutPin_3']] },
  // DAUGHTERS — the docked body from its own radial, fore-biased (frame = the docked arm.group)
  daughter_0:    { radial: [0, 0, 0.3] },
  daughter_1:    { radial: [0, 0, 0.3] },
  daughter_2:    { radial: [0, 0, 0.3] },
  daughter_3:    { radial: [0, 0, 0.3] },
};

// LOD band edges, in METRES of camera-to-ship distance. Hysteresis: descend (zoom in) on the lower number, ascend
// (zoom out) on the higher. compIn/compOut are the 4 m lens split (§13 r3; 00-spec "Lens split at 4 m"; FloorContract
// lens-split-4m): F1's camera is 2–6 m. partIn/partOut (8/9 m) still serve the ?ladder=0 inspect path.
const BAND = {
  partIn:  8.0,  partOut:  9.0,
  compIn:  4.0,  compOut:  4.5,
};

const GUIDE_STEP_S = 1.1;
const GUIDE_HOLD_S = 0.6;

// §13 r3: the one-line hint's copy, VERBATIM from the ruling (owner 2026-09-24). Shown while active and not yet
// dismissed (once per page load), centred in the pane-free strip inside the transient band (_buildHint/_updateHint).
const HINT_TEXT = 'Point at a part to see what it does. Click to upgrade it.';
// Glass wording: a tap opens the SPECS drawer with the REFIT card (WorkbenchPane.showPart), where the upgrade is bought.
// Read when the hint is DRAWN: the hub flips glass after this is built.
const HINT_TEXT_GLASS = 'Tap a part to see what it does and upgrade it.';
const hintText = () => (GestureHints.isGlass() ? HINT_TEXT_GLASS : HINT_TEXT);

// The caption in the hint strip (showCaption): wraps inside the pane-free strip between these widths (CSS px).
const CAPTION_MIN_PX = 200;
const CAPTION_MAX_PX = 640;

const FADE_RATE = 6.0;      // opacity ease rate for band crossfades

// Typeface-epoch redraw budget per frame: compact cards rasterised before the B612 faces settled are re-rasterised at
// most this many per frame (≈ 37 cards → 7 frames). Each card is redrawn ONCE per epoch; this only spreads it.
export const CARD_EPOCH_REDRAWS_PER_FRAME = 6;

// Scratch for _recBounds (a per-click edge, never per frame).
const _recBoundsScratch = new THREE.Vector3();
// getPartFrame scratch (per click): the ship's world → local inverse and a centre / instance-distance vector.
const _frameInv = new THREE.Matrix4();
const _frameV = new THREE.Vector3();
const LINE_OP_SCALE = 0.8;  // line opacity = labelOp × this
const LINE_HALF_WIDTH_FRAC = 0.0012; // leader ribbon half-width / camera-ship dist

// Hover stickiness: the stationary 10 Hz re-pick (_refreshHover) keeps a held hover through this many consecutive
// misses minus one and clears it on the Nth (3 ticks ≈ 300 ms at 10 Hz). Only the stationary re-pick is sticky.
const HOVER_MISS_TICKS = 3;
/** Canvas width behind the pane/rail NDC law: clientWidth forces a synchronous layout when the DOM is dirty, so it is
 *  re-read at most this often on the per-frame path (the rails' own 1 Hz cadence); a resize is picked up in one tick. */
const VW_READ_MS = 1000;

// Hover-outline depth stagger (metres toward the camera per frame; see the DEPTH note on _ensureOutline): ~150× the
// log-depth resolution at F3 (~10 µm at 7.7 m), under the ROSA blanket's 4 mm front/back gap, ~0.15 px on screen.
const HOVER_OUTLINE_STAGGER_M = 0.0015;

// REFIT ghost pulse (docs/ladder/08-workbench.md §2): GHOST_PULSE_MIN×–1× of the base opacity (lines 0.85, shell 0.3).
const GHOST_PULSE_HZ = 1.2;
const GHOST_PULSE_MIN = 0.35;

// HOVER DOSSIER dwell: restarts on every hover CHANGE; no second timer — a per-frame timestamp compare (the module
// carries no timer anywhere, pinned by the suite).
const HOVER_DOSSIER_DELAY_MS = 400;
// Gap between the pointer and the dossier card's near edge (NDC); flips toward screen centre at a pane-aware edge.
const HOVER_DOSSIER_OFFSET_NDC = 0.12;
// The dossier draws above every rail card (30…230) and dot (31…231): one pointer-anchored object, always on top.
const DOSSIER_RENDER_ORDER = 260;

/**
 * One rec's outline-layer pull toward the camera already in `self._vStagCam` (only caller: _updateOutlineStagger). A module
 * function, not a method, so prototype-borrowing test rigs that lift `_updateOutlineStagger` onto plain objects keep working.
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

/**
 * True when the player ship's centre (an NDC point) is inside the view and in front of the camera (projected z in
 * [-1, 1]); no projection yet (a rig without one) = on screen.
 * @param {{x:number,y:number,z:number}|null|undefined} n
 */
export function shipOnScreen(n) {
  if (!n) return true;
  const { x, y, z } = n;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return true;
  return Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1;
}

export class MotherCallouts {
  /**
   * @param {THREE.Object3D} playerGroup  The PlayerSatellite group (labels parent here).
   * @param {THREE.Camera}   camera
   * @param {object} [opts]
   * @param {HTMLCanvasElement|null} [opts.canvas]  Render canvas for pointer events.
   * @param {function|null} [opts.onPartClick]  When set, a resolved part/card click calls
   *   `onPartClick(getHoveredPart())` INSTEAD of emitting CODEX_OPEN_ENTRY — main.js wires it to the REFIT pane ONLY
   *   while the ladder flag is on. With the hook set, parts WITHOUT a briefing are pickable and fire it too (record
   *   codexId null; the hub gates its library actions on it). Absent, the click emits as shipped and briefing-less
   *   parts stay unpickable.
   * @param {import('../core/Typeface.js').FontEpoch} [opts.fontEpoch]  The typeface epoch the card textures are
   *   stamped with — the document's by default; tests inject their own so the shared one is never bumped. A card
   *   rasterised before the four B612 faces settled is redrawn ONCE (at its existing refresh point) when the epoch moves.
   */
  constructor(playerGroup, camera, { canvas = null, onPartClick = null, fontEpoch = defaultFontEpoch } = {}) {
    this.player = playerGroup;
    this.camera = camera;
    this.canvas = canvas;
    this._fontEpoch = fontEpoch;
    this._onPartClick = onPartClick;

    this._active = false;
    this._band = 'SYSTEM';
    this._guideT = -1;
    this._guidedDone = false;
    // §13 r3 labels in steps: the OPEN system (one id or null) is resolved every frame by _resolveOpenSys: pinned >
    // hovered (any part of it, or its name) > lingered > (close lens) the focus part's system.
    this._pinnedSys = null;   // a click/tap pin (a system-name tap toggles it)
    this._lingerSys = null;   // the last hovered system, held OPEN_LINGER_MS
    this._lingerAt = 0;       // frame clock (ms) of the last hovered frame
    this._openSys = null;     // resolved in update(), read by _targetOpacity
    // The one-line hint: once per page load; the element is built in _build (DOM).
    this._hintDone = false;
    this._hintEl = null;
    this._focusPart = null;
    this._liveCtx = null;       // late-bound live-data context
    this._lastLiveT = 0;        // live-refresh cadence guard
    this._bandChangedAt = 0;    // timestamp of last band change (scan-in hold)
    this._revealSeq = 0;        // stagger sequence counter
    this._nowMs = 0;            // frame timestamp stored for _positionCard

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
    this._vStag = new THREE.Vector3();
    this._vStagDir = new THREE.Vector3();
    this._vStagCam = new THREE.Vector3();

    this._halfH = 1; this._halfW = 1;
    this._railL = -0.5; this._railR = 0.5;
    // Rail-card fit scale: 1 unless the uncovered strip cannot hold both columns at full size (1024×768 + drawer: a
    // 508 px strip vs a 544 px need); then rail cards shrink uniformly, applied in _sizeFrac (rail tiers only).
    this._railScale = 1;
    // Pane insets (CSS px, LEFT = REFIT, RIGHT = TECH LIBRARY; see setPaneInsets). Both default 0 = no-pane constants.
    this._paneInsetL = 0;
    this._paneInsetR = 0;
    // Rail insets (see setRailInsets): merged with the pane insets by max per side in _updatePaneEdges.
    this._railInsetL = 0;
    this._railInsetR = 0;
    /** The canvas width behind the NDC law, read ≤ 1 Hz (VW_READ_MS) on the frame clock. */
    this._vwCache = 0;
    this._vwReadAt = null;
    // Derived per frame in _updatePaneEdges(): the usable screen edges + the uncovered strip's centre X (NDC).
    this._edgeL = -1;
    this._edgeR = 1;
    this._stripCX = 0;

    // Hover and click share one pick path: card sprites FIRST, then the parts' `pick` hull meshes (one hover state
    // `_hoverRec`, written only by _setHoverRec; one CODEX_OPEN_ENTRY emitter in _handlePointerUp).
    this._raycaster = new THREE.Raycaster();
    // The callouts group rides inside the player subtree, a NEAR_FIELD root: SceneManager moves every sprite to
    // NEAR_FIELD_LAYER (layer 1) at close range, and a default raycaster tests only layer 0, so every pick would
    // silently miss at inspection depth. Test all layers: the pick loop only sees these ~37 sprites.
    this._raycaster.layers.enableAll();
    this._ndc = new THREE.Vector2();
    this._pointerDown = null;
    this._hoverT = 0;
    this._cursorSet = false;
    this._listening = false;
    // HOVER DOSSIER: one reusable sprite + a card-shape wrapper rec, built in _build(). The dwell clock restarts in
    // _setHoverRec; the pointer NDC is cached by _refreshHover at 10 Hz so placement never reads the DOM.
    this._dossierSprite = null;
    this._dossierRec = null;
    this._dossierShownFor = null;
    this._dossierDwellStart = 0;
    this._dossierNX = NaN; this._dossierNY = NaN;
    this._dossierPrimed = false;
    this._dossierSX = 0; this._dossierSY = 0;
    this._setHoverRec(null);   // one hover state, initialized through its ONE writer (source-pinned)
    // REFIT ghost outlines: the ONE ghost set (reuses _ensureOutline/_setOutlineVisible). Source-pinned in
    // test-MotherCallouts: constructed HERE exactly once — every other site mutates, never replaces.
    this._ghostRecs = new Set();
    this._ghostPulse = true;    // setGhostOutline({ pulse }) — false = steady
    this._ghostPhaseT = 0;      // pulse phase clock (s), reset on empty→shown
    this._pointerPos = null;   // last pointer client coords, for hover re-pick
    this._hoverPickT = 0;      // hover re-pick cadence guard
    this._hoverMisses = 0;     // consecutive stationary re-pick misses with a hover held (stickiness)
    // The system-label sprite under the pointer, picked by _refreshHover/_handlePointerMove on their own refreshed ray
    // and only READ by the per-frame _resolveOpenSys, which must not raycast at 60 Hz for an NDC that changes at 10 Hz.
    this._sysLabelHover = null;
    // The flower PAIR COUNT the pick state is armed against — each _installFlowerPair BUILDS new meshes, so a count
    // change re-arms every flowerGated rec's pick cache and outline (_checkFlowerGen).
    this._flowerPairsSeen = undefined;
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
    this._allRecs = []; // cached union of system + part labels
    this._leftRail = [];  // persistent rail arrays
    this._rightRail = [];
    this._build();

    this._viewInspect = false;
    this._zoomInspect = false;
    // A TRANSIENT show/hide gate mirroring CityLabels.setSuppressed: active = (viewInspect || zoomInspect) &&
    // !suppressed; never persisted. NOT used by the Zoom Ladder (MotherCallouts IS the F3 costume,
    // docs/ladder/08-workbench.md §2); nothing calls setSuppressed in production today.
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

    // §13 r4 blocker-raycast state: one mesh→rec owner map and one blocker-mesh list over the whole ship (Meshes under
    // `player` plus the DOCKED daughters' arm groups), rebuilt lazily when _pickGenKey changes (see _ensurePickIndex).
    this._pickOwnerGen = null;
    this._pickOwners = null;      // Map<THREE.Mesh, part rec>
    this._blockerMeshes = null;   // THREE.Mesh[]
  }

  /** @returns {boolean} true while the transient gate hides the sprite cards (unused in production today). */
  isSuppressed() { return this._suppressed; }

  /** Transient show/hide gate (CityLabels.setSuppressed parity); never persisted. Unused in production today. */
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
   * Late-bind the live-data context (motherCallouts is built before commsSystem); every reference is optional — cards
   * degrade to static rows.
   * @param {object} ctx { resourceSystem, commsSystem, codexSystem,
   *   powerDistribution, despinLaser, player }
   */
  setLiveCtx(ctx) {
    this._liveCtx = ctx || null;
  }

  /**
   * Workbench pane insets: CSS-px widths of the LEFT (REFIT) and RIGHT (TECH LIBRARY) panes while open, 0 when closed.
   * Fed from main.js `_syncWorkbenchPanes()` on the panes' onOpenChange edge (the ONE pane-edge signal, never per
   * frame; see _updatePaneEdges). Non-finite / negative values clamp to 0.
   */
  setPaneInsets(leftPx, rightPx) {
    this._paneInsetL = (Number.isFinite(leftPx) && leftPx > 0) ? leftPx : 0;
    this._paneInsetR = (Number.isFinite(rightPx) && rightPx > 0) ? rightPx : 0;
  }

  /**
   * Rail insets: the SECOND inset source beside the drawers. `leftPx` = the DISPLAY rail's right edge (px from the left
   * screen edge; the hub passes null now that the footer-band DETAIL slider replaced that rail), `rightPx` = the WHERE
   * rail's reach from the RIGHT screen edge (`innerWidth − railIndicator.leftPx()`), null while hidden / unmeasured.
   * Each non-null value gains RAIL_GEOMETRY.DODGE_GAP_PX. Safe to call per frame (the hub does, off the rails' 1 Hz
   * reads): write-on-change; a change re-derives the edges at once. Merged with the pane insets by max per side in
   * _updatePaneEdges. Non-finite / negative / null → 0.
   * @param {number|null} leftPx
   * @param {number|null} rightPx
   * @returns {boolean} whether the stored rail insets changed
   */
  setRailInsets(leftPx, rightPx) {
    const gap = RAIL_GEOMETRY.DODGE_GAP_PX;
    const l = (Number.isFinite(leftPx) && leftPx > 0) ? leftPx + gap : 0;
    const r = (Number.isFinite(rightPx) && rightPx > 0) ? rightPx + gap : 0;
    if (l === this._railInsetL && r === this._railInsetR) return false;
    this._railInsetL = l;
    this._railInsetR = r;
    this._updatePaneEdges();
    return true;
  }

  /**
   * Derive the usable screen edges (NDC) + the uncovered strip's centre from the pane/rail insets — once per update(),
   * before the rail X computation reads them. The px→NDC conversion follows the CameraSystem pane-bias law: the
   * viewport width is the render CANVAS's clientWidth (SceneManager sizes it to innerWidth, the number camera.aspect is
   * built from; never `window`), and an unknown width means NO inset — never a guess. A degenerate strip (< 0.2 NDC ≈
   * 10 % of the screen) falls back to the full edges rather than inverting the rails (it trips only when the two insets
   * cover > 90 % of the width; the rails alone cover ~22 %). Insets 0 → (-1, 1, 0). The EFFECTIVE inset per side is
   * max(pane, rail).
   * @private
   */
  _updatePaneEdges() {
    const inL = Math.max(this._paneInsetL, this._railInsetL);
    const inR = Math.max(this._paneInsetR, this._railInsetR);
    let eL = -1, eR = 1;
    if (inL > 0 || inR > 0) {
      // clientWidth is a layout-affected read: cached for VW_READ_MS on the frame clock (_nowMs; 0 in bare test rigs,
      // where the first read serves the rig for good). An unknown width is never cached, so "no inset, never a guess"
      // is retried. The INSETS are not cached: a drawer or rail change re-derives the edges at once.
      const now = this._nowMs || 0;
      let vw = (this._vwCache > 0 && this._vwReadAt != null && (now - this._vwReadAt) < VW_READ_MS) ? this._vwCache : -1;
      if (vw < 0) {
        const cw = this.canvas ? this.canvas.clientWidth : NaN;   // ONE read
        vw = Number.isFinite(cw) ? cw : 0;
        this._vwCache = vw;
        this._vwReadAt = now;
      }
      if (vw > 0) {
        eL = -1 + 2 * inL / vw;
        eR = 1 - 2 * inR / vw;
        if (eR - eL < 0.2) { eL = -1; eR = 1; }
      }
    }
    this._edgeL = eL;
    this._edgeR = eR;
    this._stripCX = (eL + eR) / 2;
  }

  /**
   * The rail X positions (_railL/_railR) from the pane-aware edges and the ship's screen silhouette radius. Two laws:
   *   1. The reserved card width is the WIDEST tier on the rails — SIZE_SYSTEM (0.052), not SIZE_MAJOR (0.040), or
   *      system name cards under-reserve (~78 px at 1920×1080). widthNDC = 2·frac·CARD_W_OVER_TITLE_H/camAspect for
   *      every card, so the max frac alone picks the widest: a constant, no per-rec loop, no frame lag.
   *   2. FIT: both columns must fit the uncovered strip with a margin each (railL ≤ railR). When they cannot (1024×768
   *      + the 380 px drawer: a 508 px strip vs a 544 px need), the rail cards shrink uniformly (_railScale, applied in
   *      _sizeFrac) rather than overlap or slide under a pane.
   * The ship-bound operand can never cross the pair once the edge-derived positions fit, so railL ≤ railR holds on exit.
   * @param {number} screenR the ship silhouette's NDC half-width on screen
   * @private
   */
  _updateRailX(screenR) {
    const margin = CFG.RAIL_MARGIN_NDC;
    const camAspect = this.camera.aspect || 1;
    const railFrac = Math.max(CFG.SIZE_SYSTEM, CFG.SIZE_MAJOR, CFG.SIZE_DETAIL);
    let railCardW = 2 * railFrac * CARD_W_OVER_TITLE_H / camAspect;
    this._railScale = 1;
    const maxCardW = (this._edgeR - this._edgeL) / 2 - margin;
    if (maxCardW > 0 && railCardW > maxCardW) {
      this._railScale = maxCardW / railCardW;
      railCardW = maxCardW;
    }
    this._railL = Math.max(this._edgeL + margin + railCardW, this._shipNDC.x - screenR - CFG.RAIL_INSET_NDC);
    this._railR = Math.min(this._edgeR - margin - railCardW, this._shipNDC.x + screenR + CFG.RAIL_INSET_NDC);
  }

  /**
   * The part the player is looking at — the F1 deep-link source (docs/ladder/08-workbench.md D1/D2). In the COMPONENT
   * band (< BAND.compIn, §13 r3) `_focusPart` is the major part nearest screen-centre, re-picked every update();
   * outside it this returns null. Pure read; main.js calls it only on an F1 arrival (ArchiveFloor.getSubject) and on
   * the LIBRARY pane's entry-less open edge, never per frame. `codexId` is the part table's entry id/alias as
   * CodexSystem resolves it; parts without a briefing report null ("no link"). `screen` / `bounds`: see _partRecord.
   * @returns {{ id: string, name: string, codexId: string|null, systemId: string,
   *   screen: {x:number,y:number}|null, bounds: {x0:number,y0:number,x1:number,y1:number}|null }|null}
   */
  getFocusedPart() {
    if (this._band !== 'COMPONENT') return null;
    const rec = this._focusPart;
    if (!rec || !rec.def) return null;
    return this._partRecord(rec);
  }

  /**
   * The part under the pointer — card sprite or hull `pick` mesh, one hover state (`_hoverRec`), same record shape as
   * getFocusedPart(). NO band gate: hover exists wherever a part's card is eligible (PART and COMPONENT bands). Null
   * when nothing is hovered. Pure read; allocates per call (once per click, never per frame).
   * @returns {{ id: string, name: string, codexId: string|null, systemId: string,
   *   screen: {x:number,y:number}|null, bounds: {x0:number,y0:number,x1:number,y1:number}|null }|null}
   */
  getHoveredPart() {
    const rec = this._hoverRec;
    if (!rec || !rec.def) return null;
    return this._partRecord(rec);
  }

  /**
   * The ONE record builder behind getHoveredPart()/getFocusedPart(). Besides id/name/codexId/systemId it carries WHERE
   * the part is on screen, in DRAWING-BUFFER px (`canvas.width/height`, as main.js's photoSource), so the LIBRARY pane
   * can crop its photo around the part:
   *   screen — the callout ANCHOR's projection (rec._anchorX/_anchorY, the NDC written by _layout) × the canvas size;
   *            null when the canvas is unknown or the anchor is off screen.
   *   bounds — the projected pick-mesh box: every pick target's mesh geometry boxes, 8 corners each through a refreshed
   *            matrixWorld (in-frame matrices are a frame stale, the STALE WORLD MATRICES note) and the camera →
   *            {x0,y0,x1,y1} in drawing-buffer px; null for card-only parts or when nothing projects in front.
   * Computed once per call (per click). Never throws: any missing dep degrades that field to null.
   * @private @param {object} rec
   */
  _partRecord(rec) {
    const def = rec.def;
    return {
      id: def.id,
      name: def.name,
      codexId: (typeof def.codexId === 'string') ? def.codexId : null,
      systemId: rec.sysId,
      screen: this._recScreen(rec),
      bounds: this._recBounds(rec),
    };
  }

  _bufferSize() {
    const cv = this.canvas;
    const w = cv ? Number(cv.width) : 0, h = cv ? Number(cv.height) : 0;
    return (w > 0 && h > 0) ? { w, h } : null;
  }

  _recScreen(rec) {
    const size = this._bufferSize();
    if (!size) return null;
    const ax = rec._anchorX, ay = rec._anchorY, az = rec._anchorZ;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
    if (Number.isFinite(az) && az > 1) return null;          // behind the camera
    return { x: (ax * 0.5 + 0.5) * size.w, y: (-ay * 0.5 + 0.5) * size.h };
  }

  _recBounds(rec) {
    const size = this._bufferSize();
    if (!size || !this.camera || typeof this._pickTargets !== 'function') return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    const v = _recBoundsScratch;
    for (const target of this._pickTargets(rec)) {
      if (typeof target.updateWorldMatrix === 'function') target.updateWorldMatrix(true, true);
      target.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position || o.userData.partId) return;   // never our own outline shells
        const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        if (!bb) return;
        for (let k = 0; k < 8; k++) {
          v.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z);
          v.applyMatrix4(o.matrixWorld).project(this.camera);
          if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1) continue;
          const px = (v.x * 0.5 + 0.5) * size.w, py = (-v.y * 0.5 + 0.5) * size.h;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          any = true;
        }
      });
    }
    return any ? { x0, y0, x1, y1 } : null;
  }

  /**
   * REFIT ghost outlines: show the hover outline steady-on for a set of parts (the pane's "hover an alternative → the
   * hardware pulses cyan on the hull"). REUSES the one outline system (_ensureOutline + _setOutlineVisible); update()
   * pulses the ghost recs' OWN materials and _updateOutlineStagger staggers them like the hover.
   *
   * Rules:
   *   - card-only parts (no pick geometry → _ensureOutline null) and unknown ids are SKIPPED, never thrown on; when
   *     inactive (`!_active`) nothing is shown (every id reports skipped);
   *   - `setGhostOutline(null)` clears: hides every ghost that is not the live `_hoverRec` and restores base opacities;
   *   - the hover rec wins on overlap (steady base, no pulse) and clearing ghosts never hides a live hover.
   * Allocates (a scratch set + the report) — call on hover edges, never per frame.
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
    // Recs leaving the set: restore base opacities and hide — unless the rec is the live hover (keeps its outline).
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
   * The callout parts of one system — the REFIT pane's focusPart/ghost bookkeeping read. `hasGeometry` reports whether
   * the part can outline on the hull (its pick subtree resolves to ≥1 real Mesh): card-only parts (mli, berths,
   * nav_lights…) and the docked daughters report false. Allocates a fresh array of fresh records — never per frame.
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

  /**
   * The SPECS pane's one-shot PART PORTRAIT: the box a portrait camera must frame for a part, plus its pose row. The
   * box is SHIP-LOCAL (the player group's frame) and comes with the ship's live `matrix` (matrixWorld): a WORLD
   * axis-aligned box of a rotated ship is FAT (the wings' 3.06 × 0.00 × 2.00 m local box measured 3.23 × 2.26 × 2.62 m
   * in world under the LVLH attitude), while every hull part is ship-aligned, so the local box is tight and the
   * framing fits its 8 corners through `matrix` (portraitFraming.portraitCameraFit). Union rule: the same traverse
   * `_recBounds` uses (real geometry, our own outline shells `userData.partId` skipped; refreshed `matrixWorld`, the
   * STALE WORLD MATRICES note), never `Box3.expandByObject`, which recurses INTO those shells. Hidden meshes count as
   * in `_recBounds` (a furled wing's blanket box still frames the drum region).
   *
   * Returns null for an unknown id, a card-only part without a `frame` row (the pane keeps the ship photo), a gone
   * flower / an away daughter, or an empty box; never throws. Per click, never per frame. Without a `player` the box
   * is WORLD and `matrix` null (`local: false`) — the render then falls to the sphere law.
   * @param {string} partId — a MotherCallouts part id (the click record's `id`)
   * @param {THREE.Vector3|null} [cameraPos] — the player's camera world position (the `single` rule's tie-breaker)
   * @returns {{ box: THREE.Box3, matrix: THREE.Matrix4|null, local: boolean, dir: number[]|null,
   *   fill: number|null, instance: string|null, id: string, name: string }|null}
   *   `box` ship-local (scene units) with `matrix` = the ship's matrixWorld; `dir` a SHIP-frame [x, y, z] override or
   *   null (the hub turns it into a world direction); `fill` a frame fill override or null; `instance` the framed pick
   *   target's name under the `single` rule.
   */
  getPartFrame(partId, cameraPos = null) {
    if (typeof partId !== 'string' || !partId) return null;
    const rec = this._partLabels.find((p) => p.def && p.def.id === partId) || null;
    if (!rec) return null;
    const def = rec.def;
    const ov = PORTRAIT_OVERRIDES[def.id] || null;
    let dir = (ov && Array.isArray(ov.dir)) ? ov.dir.slice() : null;
    const fill = (ov && Number.isFinite(ov.fill) && ov.fill > 0) ? ov.fill : null;
    const player = this.player;
    const hasFrame = !!(player && player.matrixWorld && typeof player.updateWorldMatrix === 'function');
    if (hasFrame) player.updateWorldMatrix(true, false);
    const toLocal = hasFrame ? _frameInv.copy(player.matrixWorld).invert() : null;
    const matrix = hasFrame ? player.matrixWorld.clone() : null;
    const radialDir = (box) => {
      if (!ov || !Array.isArray(ov.radial) || !toLocal) return dir;
      const c = box.getCenter(_frameV);
      const r = Math.hypot(c.x, c.y);
      if (r <= 1e-12) return dir;
      // `tangent`: see PORTRAIT_OVERRIDES — the side view for a part that a radially-outboard neighbour covers.
      const t = Number.isFinite(ov.tangent) ? ov.tangent : 0;
      return [c.x / r + ov.radial[0] - t * (c.y / r), c.y / r + ov.radial[1] + t * (c.x / r), ov.radial[2]];
    };
    const box = new THREE.Box3();
    if (def.armIndex !== undefined) {
      const arm = this._liveCtx?.armManager?.arms?.[def.armIndex];
      if (!arm || arm.state !== Constants.ARM_STATES.DOCKED || !arm.group) return null;
      // The docked BODY (`arm.mesh`, the hex-prism group) with only its VISIBLE meshes — the arm group also carries idle
      // plume cones, bridle legs and the tether kit, which stretched the box to the whole strut line.
      const body = arm.mesh || arm.group;
      this._unionMeshBox(body, box, toLocal, true);
      if (box.isEmpty()) this._unionMeshBox(arm.group, box, toLocal);      // a body with nothing visible: the whole arm
      if (box.isEmpty()) return null;
      return { box, matrix, local: hasFrame, dir: radialDir(box), fill, instance: arm.group.name || null, id: def.id, name: def.name };
    }
    if (def.flowerGated) {
      if (!this._flowerOn()) return null;
      if (ov && Array.isArray(ov.stowDir)) {
        const st = (typeof player?.getFlowerStatus === 'function') ? player.getFlowerStatus() : null;
        const stowed = !!st && (st.pose === 'CLOSED' || st.pose === 'STOW' || (st.pose === 'SLEW' && st.openFrac < 0.5));
        if (stowed) dir = ov.stowDir.slice();
      }
    }
    // The frame source: the hover picks (`pick` → `mesh`), or the row's `frame` groups (portrait-only geometry for the
    // card-only rows, so hover / outlines are unaffected). One group = one instance.
    let groups;
    if (ov && Array.isArray(ov.frame) && ov.frame.length) {
      groups = ov.frame.map((entry) => this._frameTargets(entry)).filter((g) => g.length);
    } else {
      groups = this._pickTargets(rec).map((t) => [t]);
    }
    if (!groups.length) return null;
    let instance = null;
    if (ov && ov.single && groups.length > 1) {
      let best = 0;
      const cam = cameraPos && Number.isFinite(cameraPos.x) && Number.isFinite(cameraPos.y) && Number.isFinite(cameraPos.z) ? cameraPos : null;
      if (cam) {
        let bestD = Infinity;
        for (let i = 0; i < groups.length; i++) {
          const b = new THREE.Box3();
          for (const t of groups[i]) this._unionMeshBox(t, b, null);   // world, for the camera distance
          if (b.isEmpty()) continue;
          const d = b.getCenter(_frameV).distanceToSquared(cam);
          if (d < bestD) { bestD = d; best = i; }              // strict: an earlier index keeps a tie
        }
      }
      groups = [groups[best]];
      instance = groups[0].map((t) => t.name).filter(Boolean).join('+') || null;
    }
    for (const g of groups) for (const target of g) this._unionMeshBox(target, box, toLocal);
    if (box.isEmpty()) return null;
    return { box, matrix, local: hasFrame, dir: radialDir(box), fill, instance, id: def.id, name: def.name };
  }

  /**
   * @private Resolve one `frame` table entry (a mesh name, or a list of names that together make ONE instance — e.g. a
   * hinge's bracket + pin) to the objects of those names under `player`: the `_pickTargets` rule (every object of that
   * name, by traverse) without its per-rec cache, so a flower pair bought after the first hover still frames.
   * Portrait-only: hover never reads it. Per click.
   * @param {string|string[]} entry
   * @returns {THREE.Object3D[]}
   */
  _frameTargets(entry) {
    const items = Array.isArray(entry) ? entry : [entry];
    const out = [];
    const wanted = new Set();
    for (const it of items) {
      if (typeof it === 'string' && it) wanted.add(it);
      else if (it && typeof it === 'object' && Number.isInteger(it.arm)) {
        // `{ arm: i }` — the docked daughter of berth i (DOCKED only, resolved live); away → the berth's own hardware alone.
        const arm = this._liveCtx?.armManager?.arms?.[it.arm];
        if (arm && arm.state === Constants.ARM_STATES.DOCKED && arm.group) out.push(arm.group);
      }
    }
    if (wanted.size && this.player && typeof this.player.traverse === 'function') {
      this.player.traverse((o) => { if (o.name && wanted.has(o.name)) out.push(o); });
    }
    return out;
  }

  /**
   * @private The `_recBounds` traverse with a Box3 sink: every real Mesh under
   * `target` (outline shells skipped), its geometry box's 8 corners through a
   * refreshed matrixWorld — and then `toLocal` (the ship's inverse) when given
   * — expanded into `box` (scene units; world without `toLocal`).
   */
  _unionMeshBox(target, box, toLocal = null, visibleOnly = false) {
    if (!target || typeof target.traverse !== 'function') return;
    if (typeof target.updateWorldMatrix === 'function') target.updateWorldMatrix(true, true);
    const v = _recBoundsScratch;
    target.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || o.userData.partId) return;   // never our own outline shells
      if (visibleOnly && !this._chainVisible(o, target)) return;                          // idle plumes / stowed kit under a daughter
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      for (let k = 0; k < 8; k++) {
        v.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z);
        v.applyMatrix4(o.matrixWorld);
        if (toLocal) v.applyMatrix4(toLocal);
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
        box.expandByPoint(v);
      }
    });
  }

  /**
   * Run `fn` with everything of ours that rides the ship's render layer HIDDEN, so a portrait render of the near set
   * shows the hardware and nothing else: the callout group (`_group`, a child of `player`) and every hover / REFIT-ghost
   * outline layer (`rec._outline.lines` / `.shells` — children of the hull meshes, NOT of `_group`, so `_group.visible`
   * cannot hide them — plus any leftover `userData.partId` mesh under `player`). Restores exactly what was visible in a
   * `finally`; already-hidden layers stay hidden. `setSuppressed` is the WRONG handle (it resets band / pointer state).
   * @template T @param {() => T} fn @returns {T}
   */
  withHiddenForPortrait(fn) {
    const group = this._group || null;
    const wasVisible = group ? group.visible : undefined;
    const shown = new Set();
    for (const rec of (this._allRecs && this._allRecs.length) ? this._allRecs : (this._partLabels || [])) {
      const out = rec && rec._outline;
      if (!out) continue;
      for (const line of out.lines || []) if (line && line.visible) shown.add(line);
      for (const shell of out.shells || []) if (shell && shell.visible) shown.add(shell);
    }
    if (this.player && typeof this.player.traverse === 'function') {
      this.player.traverse((o) => { if (o.userData && o.userData.partId && o.visible) shown.add(o); });
    }
    for (const o of shown) o.visible = false;
    if (group) group.visible = false;
    try {
      return fn();
    } finally {
      if (group) group.visible = wasVisible;
      for (const o of shown) o.visible = true;
    }
  }

  /** @private Restore a ghost rec's outline materials to their build-time base opacities (tolerates hand-built
   *  outlines without base fields). */
  _restoreGhostBase(rec) {
    const out = rec && rec._outline;
    if (!out) return;
    if (out.lineBaseOp != null) out.material.opacity = out.lineBaseOp;
    if (out.shellBaseOp != null && out.shellMaterial) out.shellMaterial.opacity = out.shellBaseOp;
  }

  /** @private Empty the ghost set: bases restored, non-hover outlines hidden. Guarded so rigs without the set skip it. */
  _clearGhosts() {
    if (!this._ghostRecs || !this._ghostRecs.size) return;
    for (const rec of this._ghostRecs) {
      this._restoreGhostBase(rec);
      if (rec !== this._hoverRec) this._setOutlineVisible(rec, false);
    }
    this._ghostRecs.clear();
  }

  /**
   * @private Per-frame ghost pulse (update() tail): every ghost rec's OWN outline materials oscillate
   * GHOST_PULSE_MIN×–1× of base at GHOST_PULSE_HZ — never a hull material, never the hover rec (hover wins on overlap:
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

  /** Shared target-bracket texture for leader anchor markers. @private */
  static _dotTexture() {
    if (MotherCallouts._dotTex) return MotherCallouts._dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    // White: _makeDot tints via material.color and hover brightening reads it. Thick strokes (5 px ≈ 1.3 px on screen)
    // and the r=4 core keep the point readable over bright hull (gold MLI / white dome).
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 5;
    const t = 16; // tick length
    const m = 4;  // margin from edge
    ctx.beginPath(); ctx.moveTo(m, m + t); ctx.lineTo(m, m); ctx.lineTo(m + t, m); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(64 - m - t, m); ctx.lineTo(64 - m, m); ctx.lineTo(64 - m, m + t); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m, 64 - m - t); ctx.lineTo(m, 64 - m); ctx.lineTo(m + t, 64 - m); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(64 - m - t, 64 - m); ctx.lineTo(64 - m, 64 - m); ctx.lineTo(64 - m, 64 - m - t); ctx.stroke();
    ctx.beginPath(); ctx.arc(32, 32, 4, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    MotherCallouts._dotTex = tex;
    return tex;
  }

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
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24), 3));
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
        cardKey: null, card: null, _cardEpoch: -1,
        anchor: new THREE.Vector3(...sys.anchor),
        _mesh: null, _meshTried: false,
        _pickObjs: null, _pickTried: false,
        _outline: null, _outlineTried: false,
        _cardCache: null, _railOrder: null, _targetOp: 0,
        _h: 0,
        _anchorX: 0, _anchorY: 0, _anchorZ: 0,
        _armGone: false, _revealAt: null,
        _pendingSide: null, _sideT: 0,
      };
      this._applyCard(sRec); // initial static card
      this._allRecs.push(sRec);
      // The DAUGHTERS pseudo-group has no visible system label — its parts are the docked craft themselves; keep the
      // rec for the tour but never show.
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
          cardKey: null, card: null, _cardEpoch: -1,
          anchor: new THREE.Vector3(...part.anchor),
          _mesh: null, _meshTried: false,
          _pickObjs: null, _pickTried: false,
          _outline: null, _outlineTried: false,
          _cardCache: null, _railOrder: null, _targetOp: 0,
          _h: 0,
          _anchorX: 0, _anchorY: 0, _anchorZ: 0,
          _armGone: false, _revealAt: null,
          _pendingSide: null, _sideT: 0,
        };
        this._applyCard(rec);
        this._partLabels.push(rec);
        this._allRecs.push(rec);
      }
    }

    // The ONE hover dossier sprite + card-shape wrapper rec: it carries its own cardKey/card/_cardCache, so a hover never
    // touches a rail rec's card identity, and exactly ONE full texture is resident at a time.
    this._dossierSprite = this._makeCardSprite();
    this._dossierSprite.renderOrder = DOSSIER_RENDER_ORDER;
    this._dossierSprite.visible = false;
    this._group.add(this._dossierSprite);
    this._dossierRec = {
      def: null, isSystem: false, hue: '#ffffff', riskColor: null,
      sprite: this._dossierSprite,
      cardKey: null, card: null, _cardEpoch: -1, _cardCache: null,
    };

    // §13 r3: the one-line hint (DOM — no canvas 2D needed).
    this._buildHint();
  }

  /**
   * Resolve a rec's anchor for this frame. Static parts copy their table coordinate; `mesh` parts resolve from the
   * live PlayerSatellite mesh (once, cached; `dynamic` parts every frame because the mesh moves; `meshOffset` is added
   * AFTER the world→local copy so the card can point at a feature without a static tuple that drifts); daughter recs
   * follow their docked ArmUnit. A mesh miss warns once and falls back to the static coordinate. `flowerGated` recs
   * skip the lookup while the family is gone and re-arm it on the gone→present edge, so a `dynamic: true` card binds on
   * the first frame after purchase instead of caching a miss (and a warn) forever.
   * @private
   */
  _resolveAnchor(rec) {
    const def = rec.def;
    // The THERMAL family hides until a flower pair is purchased (the daughter `_armGone` idiom).
    if (def.flowerGated) {
      const gone = !this._flowerOn();
      if (rec._flowerGone && !gone) {
        // gone → present edge — re-arm the one-shot mesh lookup.
        rec._meshTried = false;
        rec._mesh = null;
        rec._meshResolved = false;
      }
      rec._flowerGone = gone;
    }
    // Daughter recs follow their docked ArmUnit.
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
    // flowerGated family gone: no lookup, no warn (the static anchor stands in; the card is hidden anyway).
    if (!rec._mesh && !rec._meshTried && !rec._flowerGone) {
      rec._meshTried = true;
      rec._mesh = this.player.getObjectByName(def.mesh) || null;
      if (!rec._mesh && typeof console !== 'undefined') {
        console.warn(`[MotherCallouts] mesh "${def.mesh}" not found for "${def.name}" — using static anchor`);
      }
    }
    if (rec._mesh) {
      if (rec._meshResolved && !def.dynamic) return;
      rec._mesh.getWorldPosition(this._vTmp);
      this.player.worldToLocal(this._vTmp);
      rec.anchor.copy(this._vTmp);
      const mo = def.meshOffset;
      if (mo) { rec.anchor.x += mo[0]; rec.anchor.y += mo[1]; rec.anchor.z += mo[2]; }
      rec._meshResolved = true;
    } else {
      rec.anchor.set(def.anchor[0], def.anchor[1], def.anchor[2]);
    }
  }

  /** Codex link state for a part: 'linked' | 'locked' | null. @private */
  _codexState(def) {
    if (!def.codexId) return null;
    const cs = this._liveCtx?.codexSystem;
    if (!cs || typeof cs.getEntry !== 'function') return 'linked';
    const entry = cs.getEntry(def.codexId);
    if (!entry) {
      // A codexId that no longer resolves would render a clickable ▸ that silently no-ops (CodexViewerUI.openEntry
      // returns false). Treat it as unlinked and warn once so the drift is loud, not invisible.
      if (!MotherCallouts._warnedMissingCodex) MotherCallouts._warnedMissingCodex = new Set();
      if (typeof console !== 'undefined' && !MotherCallouts._warnedMissingCodex.has(def.codexId)) {
        MotherCallouts._warnedMissingCodex.add(def.codexId);
        console.warn(`[MotherCallouts] codexId "${def.codexId}" for "${def.name || def.id}" does not resolve — no deep-link`);
      }
      return null;
    }
    return entry.unlocked ? 'linked' : 'locked';
  }

  _codexTitle(def) {
    if (!def.codexId) return null;
    const cs = this._liveCtx?.codexSystem;
    if (!cs || typeof cs.getEntry !== 'function') return null;
    const e = cs.getEntry(def.codexId);
    return (e && e.title) ? e.title : null;
  }

  _partTRL(def) {
    const cs = this._liveCtx?.codexSystem;
    if (!def.codexId || !cs || typeof cs.getEntry !== 'function') return null;
    const e = cs.getEntry(def.codexId);
    return (e && typeof e.trl === 'number') ? e.trl : null;
  }

  /**
   * Build the spec for a rec's current state and (re)generate its card texture only when the content string changes.
   * `full` → the full detail card with spec/TRL/live rows (the hover dossier's content); otherwise a compact title-only
   * card (the only variant the rails carry). Cached per rec by VARIANT ('compact' | 'hover'), not by content, so a
   * live-data refresh on the full card never evicts the permanently-resident compact card.
   * @private
   */
  _applyCard(rec, { full = false } = {}) {
    const def = rec.def;
    const codex = rec.isSystem ? null : this._codexState(def);
    let rows = [];
    // System cards get a single dim role line (a title-only chip left the player guessing what the system IS).
    if (rec.isSystem && def.role) rows.push({ text: def.role });
    if (full && !rec.isSystem) {
      // Deterministic row budget: 6 slots total.
      // Locked: reserve hint lines (1-2), fill [mass, ...specs, ...live(≤2)], append hint last. TRL dropped.
      // Unlocked: [mass, ...specs(≤2), ...live(≤2), TRL], capped at 6.
      const isLocked = codex === 'locked';
      // Only the first two live rows survive the budget.
      const live = this._liveRows(def).slice(0, 2);

      // Pre-wrap the unlock hint with the single shared wrap implementation; its line count IS the budget reservation,
      // so budget and draw agree.
      let hintLines = [];
      if (isLocked) {
        const hintText = this._liveCtx?.codexSystem?.getUnlockHint?.(def.codexId) || null;
        if (hintText) hintLines = wrapHint(hintText, 2);
      }

      const budget = 6 - hintLines.length;
      if (typeof def.massKg === 'number') rows.push({ text: `Mass: ${def.massKg} kg` });
      if (Array.isArray(def.specs)) {
        for (const s of def.specs.slice(0, 2)) rows.push({ text: specRow(s) });
      }
      for (const lr of live) rows.push({ text: lr, dim: false });

      // The deep-link row NAMES its destination: the exact Tech Library entry the click opens. Pushed before TRL so it
      // survives the budget slice.
      const codexTitle = codex ? this._codexTitle(def) : null;
      if (codex === 'linked') {
        rows.push({ text: `▸ ${codexTitle || 'open SPECS'}`, dim: true, color: rec.hue });
        const trl = this._partTRL(def);
        if (trl != null) rows.push({ text: `Readiness: L${trl}`, dim: true });
      } else if (codex === 'locked' && codexTitle) {
        // Locked cards still name where the ▸ leads (amber, matches the hint).
        rows.push({ text: `▸ ${codexTitle}`, dim: true, color: VisualLaw.COLORS.CAUTION });
      } else if (codex === null) {
        // Structural part with no briefing — explain the dead click.
        rows.push({ text: 'structure — no briefing', dim: true });
      }

      rows = rows.slice(0, budget);

      // Hint lines appended last, amber.
      for (const line of hintLines) {
        rows.push({ text: line, dim: false, color: VisualLaw.COLORS.CAUTION });
      }
    }
    const title = rec.isSystem ? def.label : def.name;
    const variant = full ? 'hover' : 'compact';
    // The typeface epoch leads the content key: a card rasterised before the B612 faces settled misses here once the
    // epoch moves, and the redraw below is the ONE redraw that texture is owed.
    const epoch = this._fontEpoch.value();
    const key = [
      epoch,
      title, rec.isSystem ? 'sys' : def.risk, codex || '-',
      full ? rows.map((r) => r.text).join('|') : 'compact',
    ].join('::');

    // Early-out: content unchanged → keep the current texture. The key carries the epoch, so this exit is only reached
    // under the stamped epoch; the stamp is re-asserted defensively so every exit of _applyCard leaves
    // `_cardEpoch === epoch` and the per-frame branch can never spin on a rec whose key was written without it.
    if (rec.cardKey === key && rec.card) { rec._cardEpoch = epoch; return; }

    // Reuse the cached variant if its content key still matches.
    if (!rec._cardCache) rec._cardCache = new Map();
    const cached = rec._cardCache.get(variant);
    if (cached && cached.contentKey === key) {
      rec.card = cached;
      rec.cardKey = key;
      rec._cardEpoch = epoch;
      rec.sprite.material.map = cached.texture;
      rec.sprite.material.needsUpdate = true;
      return;
    }

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
    rec._cardEpoch = epoch;
    rec.sprite.material.map = card.texture;
    rec.sprite.material.needsUpdate = true;
  }

  /**
   * Dynamic live-data rows for a part ([] if the live context or a referenced system is absent). @private
   */
  _liveRows(def) {
    const ctx = this._liveCtx;
    if (!ctx || !def.live) return [];
    const out = [];
    try {
      switch (def.live) {
        case 'rosa': {
          // Wings state: makes the furl state legible on the card (battery is already on the HUD).
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
            // currentFuelName may be a cargo-fed metal (fromCargo), which is NOT drawn from the xenon tank — don't
            // report xenon kg under its name.
            const fuel = rs.getCurrentFuel?.();
            if (fuel && !fuel.fromCargo) {
              out.push(`Fuel: ${st.currentFuelName} ${engineGasKg(st).toFixed(1)}/${engineGasKg({ xenon: st.xenonMax, tankGasId: st.tankGasId }).toFixed(1)} kg`);   // real kg, not tank percent
            } else if (fuel) {
              out.push(`Fuel: ${st.currentFuelName} (cargo)`);
            } else {
              out.push(`Fuel: ${engineGasKg(st).toFixed(1)}/${engineGasKg({ xenon: st.xenonMax, tankGasId: st.tankGasId }).toFixed(1)} kg`);
            }
          }
          // No "Thrust" row: its data source (player.thrustInput) is dead — the manual thrust methods that wrote it are
          // gone and _applyThrust zeroes the accumulator before callouts update.
          break;
        }
        case 'ttc': {
          const cm = ctx.commsSystem;
          if (cm?.getSuppressionTier) {
            const tier = cm.getSuppressionTier();
            // tier 3 = nothing suppressed (`tier > 0` reads it backwards).
            out.push(`Link: ${tier < 3 ? `SUPPRESSED (${tier})` : 'NOMINAL'}`);
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

  _setActive(on) {
    if (this._active === on) return;
    this._active = on;
    this._group.visible = on;
    if (on) {
      if (!this._guidedDone) this._guideT = -GUIDE_HOLD_S;
      this._band = 'SYSTEM';
      this._attachPointer();
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: 'SYSTEM' });
      // Refresh all compact cards so codex lock state is current (unchanged cards are a no-op by content key). A card
      // stamped under an OLDER typeface epoch is left to _layout's capped branch (≤ CARD_EPOCH_REDRAWS_PER_FRAME per
      // frame), which redraws it with the current codex state anyway; this loop would otherwise burst every card.
      const fontEpochNow = this._fontEpoch.value();
      for (const rec of this._allRecs) {
        rec._revealAt = null; // no stale reveal hold across re-entry
        rec._pendingSide = null; // no stale flip across re-entry
        rec._sideT = 0;
        if (rec._cardEpoch !== fontEpochNow) continue;
        this._applyCard(rec, { full: false });
      }
    } else {
      this._guideT = -1;
      this._focusPart = null;
      // §13 r3: a re-arrival is the rest state (system names only) — pins and lingers do not survive leaving inspection.
      this._pinnedSys = null;
      this._lingerSys = null;
      this._openSys = null;
      this._sysLabelHover = null;   // the hovered-name cache does not survive leaving inspection
      this._capText = '';           // a caption does not outlive inspection
      if (this._hintEl) this._hintEl.style.display = 'none';
      // The guided tour is a one-shot: mark it done on the first exit so a quick dip in/out of inspection can't replay it.
      this._guidedDone = true;
      this._detachPointer();
      this._setHoverRec(null); // canvas-less instances never attach — clear hover explicitly
      // REFIT ghost outlines clear with the costume (guarded: prototype-borrowing rigs without the set skip it).
      if (this._ghostRecs) this._clearGhosts();
      // Hover outlines are children of the hull meshes, NOT of this._group, so hide each one explicitly.
      for (const p of this._partLabels) this._setOutlineVisible(p, false);
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: null });
    }
  }

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
   * Card/part pick eligibility — ONE gate for hover, click, card and mesh, so they can never drift apart. Two tiers:
   *   CARD (`mesh` false — the sprite loop): the sprite is drawn and past the legibility gate, so a card is pickable
   *   precisely when the player can read it.
   *   MESH (`mesh` true — the hull loop in _pickBestRec): the part's `pick` hull meshes are pickable whenever they can
   *   be ON SCREEN in the PART/COMPONENT bands, REGARDLESS of the card's rail cull, facing gate or detail tier — the
   *   mesh is literally under the pointer. Only pickability widens: the card stays governed by its own rules
   *   (_targetOpacity / _stackRail). Hidden hardware never picks: the SYSTEM band, purchase-gated flower parts before
   *   the buy, daughters away from their berth.
   * The briefing gate (both tiers): a RESOLVABLE codexId (a drifted id renders "structure — no briefing" and must not
   * stay clickable) — OR the injected onPartClick hook, whose REFIT verb never needed an entry (the hub gates its own
   * codexId-dependent actions). Absent hook + no briefing (the `?ladder=0` boot): unpickable.
   * @private @param {object} p part rec @param {boolean} [mesh] the hull-mesh tier
   * @returns {boolean}
   */
  _recPickable(p, mesh = false) {
    if (this._codexState(p.def) === null && !this._onPartClick) return false;
    if (!mesh) {
      if (!p.sprite.visible) return false;
      // Gate on whichever is larger of eased vs target opacity, so picking follows what the player can see; derived from
      // the legibility floor (MIN_CARD_OP) so the two can't drift. The 0.8 factor keeps the gate strictly below the floor.
      if (Math.max(p.op ?? 0, p._targetOp ?? 0) <= (CFG.MIN_CARD_OP ?? 0.5) * 0.8) return false;
      return true;
    }
    if (this._band === 'SYSTEM') return false;
    if (p._neverShow || p._armGone || p._flowerGone) return false;
    return true;
  }

  /**
   * Resolve a rec's `pick` hull objects (lazy, once). Default when the table row carries no `pick`:
   * `mesh ? [mesh] : []`. Resolution collects EVERY object with a matching name via player.traverse
   * (getObjectByName returns only the FIRST match), so a future shared pick name still outlines whole. §13 r4:
   * `pickPrefixes` also collect every object whose name STARTS WITH a prefix, same rule, deduped against the exact
   * names. Daughter recs (`armIndex`) resolve LIVE from the docked arm group each call — the craft are scene children,
   * not `player` children, and a dock/undock must never serve a cached group. `flowerGated` rows never cache a miss
   * while the family is gone. One-time console.warn per rec for names that resolve to nothing. Never throws when
   * `player` is absent.
   * @private @returns {THREE.Object3D[]}
   */
  _pickTargets(rec) {
    // daughter recs — the live docked arm group, never cached.
    if (rec.def.armIndex !== undefined) {
      const arm = this._liveCtx?.armManager?.arms?.[rec.def.armIndex];
      if (arm && arm.state === Constants.ARM_STATES.DOCKED && arm.group) return [arm.group];
      return [];
    }
    // §13 r4: while a flowerGated family is gone its meshes do not exist —
    // resolve nothing, cache nothing; the gone→present edge resolves fresh.
    if (rec.def.flowerGated && !this._flowerOn()) {
      rec._pickTried = false;
      rec._pickObjs = null;
      return [];
    }
    if (rec._pickTried) return rec._pickObjs || [];
    rec._pickTried = true;
    rec._pickObjs = [];
    const def = rec.def;
    const names = Array.isArray(def.pick) ? def.pick : (def.mesh ? [def.mesh] : []);
    const prefixes = Array.isArray(def.pickPrefixes) ? def.pickPrefixes : [];
    if ((!names.length && !prefixes.length) || !this.player) return rec._pickObjs;
    const wanted = new Set(names);
    const found = new Set();
    const seen = new Set();
    this.player.traverse((o) => {
      if (!o.name) return;
      let match = wanted.has(o.name);
      if (match) found.add(o.name);
      else for (const p of prefixes) { if (o.name.startsWith(p)) { match = true; break; } }
      if (match && !seen.has(o)) { seen.add(o); rec._pickObjs.push(o); }
    });
    if (found.size < wanted.size && typeof console !== 'undefined') {
      const missing = names.filter((n) => !found.has(n));
      console.warn(`[MotherCallouts] pick name(s) "${missing.join('", "')}" not found for "${def.name}" — hull hover reduced`);
    }
    return rec._pickObjs;
  }

  /**
   * True when `obj` and every parent up to and including `root` are `.visible`, and `obj` is drawn (not all of its
   * materials `visible === false`). Raycaster.intersectObject tests LAYERS only, never `.visible` — hidden plumes,
   * furled panels and docked daughter bodies would otherwise be hit.
   * @private
   */
  _chainVisible(obj, root) {
    // A mesh whose every material is `visible = false` is not drawn (the radiator rail / seam boxes, painted on the
    // face instead: PlayerSatellite, CONVENTIONS 11.17), so it must not be picked, outlined or counted in bounds.
    if (obj && obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (mats.length > 0 && mats.every((m) => m && m.visible === false)) return false;
    }
    let o = obj;
    while (o) {
      if (!o.visible) return false;
      if (o === root) return true;
      o = o.parent;
    }
    return true;
  }

  /**
   * §13 r4: the pick generation key — the only events that move meshes in or out of pick subtrees are a flower-pair
   * install and an arm docking / undocking. The flower state is keyed on the PAIR COUNT, not a boolean: each pair
   * BUILDS new meshes (`_installFlowerPair`), so buying pair B must rebuild the owner map and the blocker list too.
   * A key change rebuilds both on the next pick (see _ensurePickIndex). Cheap; called per pick.
   * @private @returns {string}
   */
  _pickGenKey() {
    const arms = this._liveCtx?.armManager?.arms;
    const pairs = this.player?.getFlowerPairCount?.() ?? 0;
    return pairs + '|' + (arms ? arms.map((a) => a && a.state).join(',') : '');
  }

  /**
   * A flower-pair PURCHASE builds NEW meshes (`_installFlowerPair`, one set per pair), so a pair-count change
   * invalidates every flowerGated rec's cached pick subtree (`_pickObjs`) AND its outline: dispose/detach each outline
   * via the ONE teardown (`_disposeOutline`), re-arm `_pickTried/_pickObjs` and `_outlineTried/_outline`, and rebuild
   * the outline at once for a rec that is hovered or ghosted. The first call only records the baseline count. Called
   * per frame from update() and from _ensurePickIndex ahead of its generation check; cheap when the count is steady.
   * @private
   */
  _checkFlowerGen() {
    const pairs = this.player?.getFlowerPairCount?.() ?? 0;
    if (this._flowerPairsSeen === pairs) return;
    const first = this._flowerPairsSeen === undefined;
    this._flowerPairsSeen = pairs;
    if (first) return;
    for (const rec of this._allRecs || []) {
      if (!rec?.def?.flowerGated) continue;
      this._disposeOutline(rec);
      rec._pickTried = false;
      rec._pickObjs = null;
      rec._outlineTried = false;
      if (rec === this._hoverRec || (this._ghostRecs && this._ghostRecs.has(rec))) {
        this._ensureOutline(rec);
        this._setOutlineVisible(rec, true);
      }
    }
  }

  /**
   * §13 r4: build, lazily and per generation, (a) the mesh→rec OWNER map — every Mesh inside some part's pick subtree
   * (exact names, `pickPrefixes` matches, the docked daughters' live arm groups) — and (b) the BLOCKER list: every real
   * Mesh under `player` plus every Mesh under a DOCKED daughter's arm group, minus our own callout layer (children of
   * `_group`) and every hover/REFIT outline layer (`userData.partId`). First-wins on ownership; the pick-table
   * disjoint-subtree test keeps the sets conflict-free. Never throws with no `player`.
   * @private
   */
  _ensurePickIndex() {
    // A pair-count change re-arms the flowerGated recs BEFORE the generation check below rebuilds the owner map /
    // blockers.
    this._checkFlowerGen();
    const gen = this._pickGenKey();
    if (this._pickOwnerGen === gen && this._pickOwners) return;
    this._pickOwnerGen = gen;
    const owners = new Map();
    const blockers = [];
    const group = this._group || null;
    const inCalloutLayer = (o) => {
      for (let p = o; p; p = p.parent) if (p === group) return true;
      return false;
    };
    if (this.player && typeof this.player.traverse === 'function') {
      this.player.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;   // no Lines/Points/Sprites
        if (o.userData.partId) return;                                 // our own outline layers
        if (group && inCalloutLayer(o)) return;                        // cards / leaders / dots / dossier
        blockers.push(o);
      });
    }
    const arms = this._liveCtx?.armManager?.arms;
    if (Array.isArray(arms)) {
      for (const arm of arms) {
        if (!arm || arm.state !== Constants.ARM_STATES.DOCKED || !arm.group
          || typeof arm.group.traverse !== 'function') continue;
        arm.group.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          if (o.userData.partId) return;
          blockers.push(o);
        });
      }
    }
    for (const p of this._partLabels) {
      for (const t of this._pickTargets(p)) {
        if (!t || typeof t.traverse !== 'function') continue;
        t.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          if (o.userData.partId) return;
          if (!owners.has(o)) owners.set(o, p);
        });
      }
    }
    this._pickOwners = owners;
    this._blockerMeshes = blockers;
  }

  /**
   * Shared raycast pick with the camera ray already set: the card sprites FIRST (a card hit ALWAYS beats a mesh hit —
   * cards are depthTest:false and draw on top of the hull), then the ONE blocker raycast (§13 r4): every chain-visible
   * Mesh under the ray — ship or docked daughter — sorted by distance, and the FIRST hit decides. It either answers as
   * the part it belongs to (owner map → `_recPickable` mesh tier) or it BLOCKS: a piece no part owns (the bare hull
   * skin) or a part that is not pickable stops the pointer — nothing lights up THROUGH a piece in front of it. This
   * replaces the per-rec pick loop, which lit parts behind non-pickable meshes (archive/DECISIONS-evidence.md §13: the
   * barrel block, the rear cap). Single source for the pick so hover and click can never drift apart.
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
    // §13 r4: the blocker raycast — first chain-visible hit decides.
    if (typeof this._raycaster.intersectObject !== 'function' || !this._partLabels) return null;
    this._ensurePickIndex();
    const hits = [];
    for (const mesh of this._blockerMeshes) {
      const h = this._raycaster.intersectObject(mesh, false);
      if (h.length) hits.push(h[0]);   // per-mesh calls are distance-sorted; h[0] is this mesh's nearest
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.distance - b.distance);
    for (const hit of hits) {
      // Fake rigs can hand back non-Mesh objects; the list itself is Mesh-only by construction.
      if (!hit.object || !hit.object.isMesh) continue;
      // Skip hits whose ancestor chain is hidden (the list is built per generation, visibility is checked live, here).
      if (!this._chainVisible(hit.object, null)) continue;
      const rec = this._pickOwners.get(hit.object) || null;
      if (rec && this._recPickable(rec, true)) return rec;
      return null;   // the FIRST visible hit decides — unowned or ineligible = blocked
    }
    return null;
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
   * The SOLE writer of `_hoverRec` (source-pinned in test-MotherCallouts): one hover state whatever the source — card
   * sprite or hull mesh. Swaps the part outline and keeps the hand cursor in sync; the card treatment reads `_hoverRec`
   * in _positionCard. Every applied pick result — a hit or an explicit clear — also ends the stationary miss run
   * (`_hoverMisses`, see _refreshHover), so a stale count can never shorten the next hover.
   * @private @param {object|null} rec
   */
  _setHoverRec(rec) {
    const next = rec || null;
    // §13 r3: the first non-null hover ends the one-time sweep (the player takes over) and dismisses the hint line —
    // both once per load.
    if (next) { this._guidedDone = true; this._hintDone = true; }
    this._hoverMisses = 0;
    if (next === this._hoverRec) return;
    const old = this._hoverRec;
    this._hoverRec = next;
    // The dossier's 400 ms dwell restarts on every hover CHANGE (the same rec held keeps counting) and a cleared hover
    // hides it at once. Guarded on the sprite — prototype-borrowing rigs without the dossier skip that write.
    this._dossierDwellStart = next
      ? (typeof performance !== 'undefined' ? performance.now() : Date.now())
      : 0;
    this._dossierShownFor = null;
    this._dossierPrimed = false;
    if (this._dossierSprite) {
      this._dossierSprite.visible = false;
      this._dossierSprite.material.opacity = 0;
    }
    // A rec that is ALSO ghosted keeps its outline on hover-out (the REFIT ghost pulse resumes in update()).
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

  /** Pointer left the canvas: clear the hover and stop re-picking. @private */
  _handlePointerLeave() {
    this._setHoverRec(null);
    this._pointerPos = null;   // stop re-picking once the pointer exits
    this._sysLabelHover = null;   // the hovered-name cache clears with the hover
  }

  /** Hull-outline master switch (a method so tests can stub it). @private */
  _outlineEnabled() {
    return Constants.INSPECTION?.HULL_OUTLINE !== false;
  }

  /**
   * Lazily build a rec's hover outline (once, cached), two layers per Mesh in the pick subtrees, both parented to THAT
   * MESH so they follow every live transform (gimbal, furl, strut ride):
   *
   *   1. House-style EdgesGeometry LineSegments (same threshold as the hull outline). SCALE TRAP: EdgesGeometry hashes
   *      vertices at a fixed 1e4 precision and the ship is built at M = 1e-5 scene units per metre — raw hull geometry
   *      collapses into ONE hash bucket and yields ZERO edges (silently: an empty, invisible LineSegments). Edge a ×1/M
   *      clone at metre scale, then scale the edges back down. The house threshold is untouched.
   *   2. A translucent cyan shell: a Mesh SHARING the hull mesh's geometry (never disposed here), inflated 3% (edge
   *      lines alone are near-invisible on the flat ROSA panels).
   *
   * DEPTH: BOTH layers keep `depthTest` ON and `depthWrite` OFF, and are pulled HOVER_OUTLINE_STAGGER_M (1.5 mm) toward
   * the camera every frame (_updateOutlineStagger) — the house "tiny geometric Z stagger" SceneManager prescribes over
   * polygonOffset under the logarithmic depth buffer. Why not scale, why not depth-free:
   *   - The flat ROSA panels are PlaneGeometry with zero z-extent: `scale.setScalar(1.03)` cannot lift a z=0 plane off
   *     itself, so the layers would sit coplanar with the hull and shimmer (equal-depth fragments flip the LESS test
   *     frame to frame). The camera pull lifts them whatever the geometry.
   *   - depthTest:false is steady, but far-side layers (the 4 RCS pods, the back ROSA face, the 28 barrel cells) show
   *     THROUGH the mother (owner playtest: confusing). With the depth test on, the hull's own depth hides them.
   *
   * One LineBasicMaterial + one MeshBasicMaterial per rec — their own, never a hull material, never shared. Caches null
   * when outlines are disabled or nothing picks — EXCEPT a flowerGated rec whose family is not bought yet: that miss is
   * never latched, so a pre-purchase REFIT ghost cannot cache null forever (later purchases re-arm via _checkFlowerGen).
   * @private @returns {{lines: THREE.LineSegments[], shells: THREE.Mesh[],
   *   material: THREE.LineBasicMaterial, shellMaterial: THREE.MeshBasicMaterial}|null}
   */
  _ensureOutline(rec) {
    if (rec._outlineTried) return rec._outline;
    // While a flowerGated family is gone its meshes do not exist — resolve nothing and LATCH nothing; the gone→present
    // edge (purchase) resolves fresh.
    if (rec.def.flowerGated && !this._flowerOn()) { rec._outline = null; return null; }
    rec._outlineTried = true;
    rec._outline = null;
    if (!this._outlineEnabled()) return null;
    const targets = this._pickTargets(rec);
    if (!targets.length) return null;
    const INS = Constants.INSPECTION || {};
    // Both materials: depth test ON (the hull occludes far-side layers), depth write OFF (an overlay never writes
    // depth) — see the DEPTH note above. The stagger that wins the test against the part's own surface is geometric
    // (_updateOutlineStagger), never polygonOffset.
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
        // Meshes with real geometry only — skip Sprites/Lines/Points, outline layers (userData.partId), no-position geometry.
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        if (o.userData.partId) return;
        // §13 r4: pieces hidden at build time never carry layers (they show/hide as one; a shell over an idle plume cone
        // inside a docked daughter's arm group would draw fx geometry as hardware).
        if (!this._chainVisible(o, target)) return;
        const src = o.geometry.clone();
        src.scale(NORM, NORM, NORM);
        const edges = new THREE.EdgesGeometry(src, INS.HULL_OUTLINE_THRESHOLD_DEG ?? 20);
        edges.scale(M, M, M);
        src.dispose();
        const line = new THREE.LineSegments(edges, material);
        line.name = 'MotherCalloutOutline';
        line.userData.partId = rec.def.id;
        line.raycast = () => {};          // never hit by our own recursive pick
        line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
        line.visible = false;
        o.add(line);
        lines.push(line);
        const shell = new THREE.Mesh(o.geometry, shellMaterial); // SHARED geometry
        shell.name = 'MotherCalloutOutline';
        shell.userData.partId = rec.def.id;
        shell.raycast = () => {};         // a shell must never self-hit
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
      // Build-time base opacities — the REFIT ghost pulse oscillates around these and _restoreGhostBase puts them back.
      lineBaseOp: material.opacity,
      shellBaseOp: shellMaterial.opacity,
    };
    return rec._outline;
  }

  /**
   * @private Detach + dispose a rec's hover/ghost outline — the ONE teardown, shared by dispose() and the pair-count
   * re-arm (_checkFlowerGen): each LineSegments is removed from its parent hull mesh and its OWN EdgesGeometry
   * disposed, then the rec's two materials; the shells are only REMOVED from their parent mesh — their geometry is
   * SHARED with the live hull mesh and is never disposed here.
   */
  _disposeOutline(rec) {
    const o = rec._outline;
    if (!o) return;
    for (const line of o.lines) {
      line.parent?.remove(line);
      line.geometry.dispose();
    }
    for (const shell of o.shells || []) {
      shell.parent?.remove(shell);
    }
    o.material.dispose();
    o.shellMaterial?.dispose();
    rec._outline = null;
  }

  /** Toggle a rec's hover outline (no-op when it has none). @private */
  _setOutlineVisible(rec, on) {
    if (!rec._outline) return;
    for (const line of rec._outline.lines) line.visible = !!on;
    for (const shell of rec._outline.shells || []) shell.visible = !!on;
  }

  /**
   * Pull EVERY outlined rec's layers (hover + REFIT ghosts) HOVER_OUTLINE_STAGGER_M toward the camera in each parent
   * mesh's LOCAL frame, so they win the depth test against their own surface while the hull still occludes far-side
   * layers (see the DEPTH note on _ensureOutline). Runs per frame at the end of update() (after _layout's re-pick) and
   * once from _setHoverRec / setGhostOutline, so a new outline is staggered on its first drawn frame. Each parent's
   * world matrix is refreshed first (in-frame they are one frame stale); the offset goes through worldToLocal, so it is
   * exact under any parent rotation and non-uniform scale (the ROSA roll-out wrapper scales x). No per-frame
   * allocation; no-op without a real camera (test stubs) or any outlined rec.
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
    // Always record the latest position so _layout can re-pick under a stationary pointer as cards slide; the pick
    // itself is throttled.
    this._pointerPos = { clientX: e.clientX, clientY: e.clientY };
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._hoverT < 100) return;   // ~10 Hz
    this._hoverT = now;
    if (!this.camera) return;
    // The SAME pick order as click — the system-name sprites are drawn on top, so a name under the pointer suppresses
    // the part hover and is recorded as the hovered name (the pin stays the tap's verb). Guarded like _refreshHover for
    // prototype-borrowing rigs.
    this._raycaster.setFromCamera(this._pointerNDC(e), this.camera);
    this._sysLabelHover = (typeof this._pickSystemLabelRay === 'function') ? this._pickSystemLabelRay() : null;
    if (this._sysLabelHover) { this._setHoverRec(null); return; }
    this._setHoverRec(this._pickBestRec());
  }

  /**
   * Re-pick the hover from the stored pointer position: cards slide in screen space as the ship rotates (and the hull
   * meshes rotate under a stationary pointer), so the hover would otherwise go stale. Runs at ~10 Hz from _layout;
   * system-name sprites FIRST (the ONE pick order shared with click), then card sprites, then the parts' pick meshes.
   *
   * STALE WORLD MATRICES: this runs inside the frame's update, BEFORE the render's scene.updateMatrixWorld(), and
   * update() refreshes only the player itself — every hull mesh and card sprite still carries LAST frame's matrixWorld
   * while the camera is at THIS frame's pose. The ship covers ~7.7 km/s along its orbit (~130 m per 60 Hz frame, 60×
   * its own length), so a ray through a still pointer missed on every frame the camera did not look along the
   * velocity. Refresh the player subtree first (396 objects, ~0.06 ms, at 10 Hz).
   *
   * HOVER STICKINESS: thin parts, part edges and the ship turning under a still pointer can miss for a frame, so the
   * outline would blink. The rule, in order:
   *   1. a hit on the HELD rec confirms it (miss run reset, nothing else);
   *   2. a hit on a DIFFERENT pickable rec switches immediately (old outline hidden, new shown — the pointer really is
   *      on something else);
   *   3. a miss with a hover held KEEPS it, unless the held rec is no longer `_recPickable` (facing gate dropped,
   *      rail-culled, band left, briefing gone — cleared at once) or this is the HOVER_MISS_TICKS-th consecutive miss
   *      (3 ticks ≈ 300 ms at 10 Hz — cleared);
   *   4. a miss with nothing held does nothing.
   * Only this path is sticky. The explicit clears stay immediate: _handlePointerLeave, _detachPointer,
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
    // The dossier follows the pointer — cache the NDC here (its ONE writer, at this 10 Hz cadence) so the per-frame
    // placement never reads the DOM; the position ease smooths the cadence.
    this._dossierNX = this._ndc.x;
    this._dossierNY = this._ndc.y;
    // In-frame: bring the hull meshes + card sprites to THIS frame's pose before casting (see STALE WORLD MATRICES).
    this.player.updateWorldMatrix(true, true);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    // ONE pick order for hover and click, matching what is drawn on top — system-NAME sprites first, on this refreshed
    // ray (_resolveOpenSys only reads the _sysLabelHover cache per frame). A name under the pointer means NO part
    // hover: the part behind it must not light up while a click pins the system (guarded for prototype-borrowing rigs).
    this._sysLabelHover = (typeof this._pickSystemLabelRay === 'function') ? this._pickSystemLabelRay() : null;
    if (this._sysLabelHover) {
      this._setHoverRec(null);
      return;
    }
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
    // PINCH GUARD: a second finger landing mid-gesture NULLS the slot instead of overwriting it, so an anchored pinch
    // can never register a part click whichever finger is the still one: the primary's later up finds no slot, the
    // secondary's up returns below. `=== false` keeps mouse events and unit rigs (no isPrimary field) on the primary path.
    if (e.isPrimary === false) { this._pointerDown = null; return; }
    this._pointerDown = {
      x: e.clientX, y: e.clientY,
      t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    };
  }

  _handlePointerUp(e) {
    if (!this._active) return;
    if (e.isPrimary === false) { this._pointerDown = null; return; }   // pinch guard belt (see _handlePointerDown)
    if (!this._pointerDown) return;
    const down = this._pointerDown;
    this._pointerDown = null;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > TAP_SLOP_PX || (now - down.t) > TAP_SLOP_MS) return;   // drag / long-press → ignore (TapPick's ONE slop law)
    // §13 r3: the first tap ends the one-time sweep — the player takes over (drags and long-presses returned above).
    this._guidedDone = true;
    // A tap on a system NAME toggles its pin (§13 r3) — touch has no hover, so the pin is how a tap "opens" a system.
    // Never the part-click path. (Guarded: the prototype-borrowing test rigs predate the method.)
    const sysRec = (typeof this._pickSystemLabelAt === 'function') ? this._pickSystemLabelAt(e) : null;
    if (sysRec) {
      this._hintDone = true;
      this._pinnedSys = (this._pinnedSys === sysRec.def.id) ? null : sysRec.def.id;
      return;
    }
    const hit = this._pickLabel(e);
    if (!hit) {
      // §13 r3: a tap or click on empty space clears the pin.
      this._pinnedSys = null;
      return;
    }
    // §13 r3: a part hit pins its system, then today's path runs.
    this._hintDone = true;
    this._pinnedSys = hit.sysId;
    // The WHOLE card is clickable — hover and click agree (hull-part clicks arrive through the same _pickLabel, so
    // clicking a part IS clicking its card). owner 2026-09-03: with the REFIT hook a part click opens its REFIT card
    // INSTEAD of the Library: the hook receives the getHoveredPart() record (the clicked rec goes through the ONE hover
    // writer first) and fires for parts WITHOUT a briefing too; the hub gates its codexId-dependent actions on the
    // record. Absent hook: the one CODEX_OPEN_ENTRY emit below runs, still gated on a codexId.
    if (this._onPartClick) {
      this._setHoverRec(hit);
      this._onPartClick(this.getHoveredPart());
    } else if (hit.def.codexId) {
      eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: hit.def.codexId });
    }
  }

  update(dt) {
    if (!this._active || !this.camera) return;

    // Re-arm the flowerGated pick caches / outlines on a pair purchase (cheap when the count has not moved).
    this._checkFlowerGen();

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
    // Ship world-quaternion, hoisted so _pickFocusPart (below) and _layout both read the CURRENT rotation.
    this.player.getWorldQuaternion(this._qTmp);
    const shipBoundR = CFG.SHIP_BOUND_M * M;
    this._vTmp.copy(this._vShip).addScaledVector(this._camRight, shipBoundR).project(this.camera);
    const screenR = Math.abs(this._vTmp.x - this._shipNDC.x);

    // Workbench panes: the usable screen edges. With no pane open _edgeL/_edgeR are exactly -1/+1.
    this._updatePaneEdges();
    this._updateRailX(screenR);

    this._updateBand(distM);
    this._updateGuide(dt);

    this._vCamDir.copy(this._vCam).sub(this._vShip).normalize();

    // Resolve every rec's anchor for this frame BEFORE focus picking and layout read them (mirrors the quaternion hoist).
    for (const rec of this._allRecs) this._resolveAnchor(rec);

    if (this._band === 'COMPONENT') this._focusPart = this._pickFocusPart();
    else this._focusPart = null;

    // §13 r3: resolve the OPEN system before _layout reads it.
    this._openSys = (typeof this._resolveOpenSys === 'function') ? this._resolveOpenSys() : null;

    this._layout(dt);
    // §13 r3: the one-line hint's visibility + placement — after _layout so the pane-aware strip centre is this frame's.
    this._updateHint?.();
    // After the re-pick inside _layout: pull every outlined rec (hover + REFIT ghosts) toward the camera for THIS
    // frame's pose (see _ensureOutline), then advance the ghost pulse.
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
      // clear stale reveal holds so every rec gets a fresh stagger slot.
      for (const rec of this._allRecs) rec._revealAt = null;
      eventBus.emit(Events.CALLOUT_BAND_CHANGE, { band: this._band });
    }
  }

  /** Is any aft-flower pair purchased? Gates the THERMAL family. @private */
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
   *  recs are the docked craft), THERMAL excluded pre-purchase. @private */
  _tourableSystems() {
    return SYSTEMS.filter((s) => !s.daughters && !(s.flowerGated && !this._flowerOn()));
  }

  _guideSystemId() {
    if (this._guidedDone || this._guideT < 0) return null;
    const tourable = this._tourableSystems();
    const idx = Math.floor(this._guideT / GUIDE_STEP_S);
    return tourable[idx]?.id ?? null;
  }

  /**
   * §13 r3: resolve the OPEN system (one id or null), every frame, in the locked order:
   *   1. the PINNED system (a click/tap on a system name toggles it; a part click sets it — see _handlePointerUp);
   *   2. the system of the hovered rec — any part of it (`_hoverRec`), or its NAME: the name pick runs in _refreshHover
   *      / _handlePointerMove FIRST (one pick order shared with click), so a name under the pointer means NO part
   *      hover. This resolver only READS the `_sysLabelHover` cache those two write at ~10 Hz — no per-frame raycast;
   *   3. LINGER: the last hovered system, held CALLOUTS.OPEN_LINGER_MS after the pointer leaves it;
   *   4. in the COMPONENT band, the system of the focus part (_pickFocusPart);
   *   5. otherwise null (rest: the system names only).
   * A system-NAME hover also ends the sweep and dismisses the hint — the part path does the same in _setHoverRec.
   * @private @param {number} [now] frame clock (ms) — tests inject; default performance.now()
   * @returns {string|null}
   */
  _resolveOpenSys(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    if (this._pinnedSys) return this._pinnedSys;
    const h = this._hoverRec;
    const hoverSys = h ? (h.isSystem ? h.def.id : h.sysId) : null;
    if (hoverSys) {
      this._lingerSys = hoverSys;
      this._lingerAt = now;
      return hoverSys;
    }
    const label = this._sysLabelHover || null;   // the cache _refreshHover writes
    if (label) {
      this._guidedDone = true;
      this._hintDone = true;
      this._lingerSys = label.def.id;
      this._lingerAt = now;
      return label.def.id;
    }
    if (this._lingerSys && (now - this._lingerAt) < (CFG.OPEN_LINGER_MS ?? 1000)) return this._lingerSys;
    if (this._band === 'COMPONENT' && this._focusPart) return this._focusPart.sysId;
    return null;
  }

  /**
   * @private Raycast the system-label sprites with the raycaster's CURRENT ray; the nearest hit wins. The gate mirrors
   * _recPickable's card tier (visible + legible) without its briefing clause — system labels carry no codexId by
   * design, and a dimmed name stays pointable (pointing at a system name opens it).
   */
  _pickSystemLabelRay() {
    let best = null, bestDist = Infinity;
    const gate = (CFG.MIN_CARD_OP ?? 0.5) * 0.8;
    for (const rec of this._allRecs) {
      if (!rec.isSystem || rec._neverShow) continue;
      if (!rec.sprite || !rec.sprite.visible) continue;
      if (Math.max(rec.op ?? 0, rec._targetOp ?? 0) <= gate) continue;
      const hits = this._raycaster.intersectObject(rec.sprite, false);
      if (hits.length && hits[0].distance < bestDist) { bestDist = hits[0].distance; best = rec; }
    }
    return best;
  }

  /**
   * @private The system-label sprite under a POINTER EVENT (a click/tap): sets the ray from the event's NDC — matrices
   * refreshed first, because a tap is the touch player's only verb and must not miss on a stale frame — then raycasts
   * the system labels. Used by _handlePointerUp for the pin toggle.
   */
  _pickSystemLabelAt(e) {
    if (!this.camera || !this.canvas) return null;
    if (this.player && typeof this.player.updateWorldMatrix === 'function') {
      this.player.updateWorldMatrix(true, true);
    }
    this._raycaster.setFromCamera(this._pointerNDC(e), this.camera);
    return this._pickSystemLabelRay();
  }

  _pickFocusPart() {
    let best = null, bestD = Infinity;
    for (const p of this._partLabels) {
      if (p.isDetail) continue;
      // Skip hull-hidden parts (far side of ship) so focus doesn't reveal a system detail tier at ~0 opacity.
      if (this._anchorVisible(p.anchor, p) < 0.2) continue;
      this._vAnchor.copy(p.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vTmp.copy(this._vAnchor).project(this.camera);
      if (this._vTmp.z > 1) continue;
      // "Nearest screen-centre" measures from the centre of the UNCOVERED strip — with a workbench pane open the
      // camera's look-at bias puts the ship there. No pane → _stripCX 0.
      const dx = this._vTmp.x - this._stripCX;
      const d = dx * dx + this._vTmp.y * this._vTmp.y;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * Anchor visibility gate (camera-facing dot proxy): anchors on the far side of the hull fade to 0. Returns 0..1. Uses
   * the ship world-quaternion hoisted in update(). The anchor's RADIAL component is the surface normal; near-axial
   * parts (net launcher, turret, FEEP) are exempt — they read in silhouette at every angle. A flowerGated row whose
   * LIVE anchor rides a deployed strut beyond the hull's hardware envelope (radial > FREE_STANDING_R_M) is a
   * free-standing panel 1–2 m off the skin: it reads from either side and the hull never occludes it, so the proxy
   * does not apply. Stowed (radial < 0.6) the gate applies as before.
   * @param {THREE.Vector3} anchorLocal ship-frame anchor
   * @param {object} [rec] the rec (for the free-standing exemption)
   * @private
   */
  _anchorVisible(anchorLocal, rec) {
    // Near-axial anchor: no meaningful radial normal → always face-visible.
    const r2 = anchorLocal.x * anchorLocal.x + anchorLocal.y * anchorLocal.y;
    const axialFloor = 0.15 * M;
    if (r2 < axialFloor * axialFloor) return 1;
    const freeR = (CFG.FREE_STANDING_R_M ?? 0.6) * M;
    if (rec && rec.def && rec.def.flowerGated && rec._mesh && r2 > freeR * freeR) return 1;
    this._vFace.set(anchorLocal.x, anchorLocal.y, 0); // radial component only
    this._vFace.applyQuaternion(this._qTmp); // hoisted in update()
    if (this._vFace.lengthSq() < 1e-20) return 1;
    this._vFace.normalize();
    const d = this._vFace.dot(this._vCamDir);
    // Softened ramp: a part 90° off still reads ~0.42 instead of ~0.22.
    return clamp01((d + 0.25) / 0.6);
  }

  /** On-screen height fraction (of viewport height) for a rec's tier. @private
   * Rail tiers carry _railScale (the strip-fit law, _updateRailX): 1 wherever
   * both columns fit at full size, < 1 only on an over-constrained strip. */
  _sizeFrac(rec, isFocus) {
    if (isFocus) return CFG.SIZE_CARD;
    const k = (Number.isFinite(this._railScale) && this._railScale > 0 && this._railScale < 1) ? this._railScale : 1;
    if (rec.isSystem) return CFG.SIZE_SYSTEM * k;
    return (rec.isDetail ? CFG.SIZE_DETAIL : CFG.SIZE_MAJOR) * k;
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
    const ease = 1 - Math.exp(-CFG.EASE_RATE * Math.max(dt, 0));
    const fadeK = Math.min(1, FADE_RATE * Math.max(dt, 0));

    // Refresh the focused card's live data at ≤ LIVE_REFRESH_HZ.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._nowMs = now;
    const liveDue = (now - this._lastLiveT) >= (1000 / (CFG.LIVE_REFRESH_HZ || 2));
    if (liveDue) this._lastLiveT = now;
    // The typeface epoch this frame. A compact card stamped under an older epoch (rasterised before the B612 faces
    // settled — _build() draws every card at construction) is redrawn once below, ≤ CARD_EPOCH_REDRAWS_PER_FRAME/frame.
    const fontEpochNow = this._fontEpoch.value();
    let epochRedraws = 0;

    // Re-pick hover from the stored pointer position so it tracks cards sliding under a stationary pointer.
    this._refreshHover();

    // Reuse persistent rail arrays (zero per-frame alloc).
    const leftList = this._leftRail;
    const rightList = this._rightRail;
    leftList.length = 0;
    rightList.length = 0;

    // Project the focused part's anchor once so detail parts NEAR it on screen can reveal even when they belong to
    // another system.
    let focusNX = 0, focusNY = 0;
    if (focus) {
      this._vTmp.copy(focus.anchor);
      this.player.localToWorld(this._vTmp);
      this._vTmp.project(this.camera);
      focusNX = this._vTmp.x; focusNY = this._vTmp.y;
    }

    for (const rec of this._allRecs) {
      // Anchor NDC (computed before target opacity: the proximity reveal reads it).
      this._vAnchor.copy(rec.anchor);
      this.player.localToWorld(this._vAnchor);
      this._vAnchor.project(this.camera);
      const ax = this._vAnchor.x, ay = this._vAnchor.y, az = this._vAnchor.z;
      rec._anchorX = ax; rec._anchorY = ay; rec._anchorZ = az;

      // Facing ramp (0..1) — applied to the dot + leader (which sit on the hull)
      // in _positionCard, NOT to the card. Stored once per frame.
      rec._facing = this._anchorVisible(rec.anchor, rec);

      let targetOp = this._targetOpacity(rec, band, guideId, this._openSys, focusNX, focusNY, rec._facing);
      const off = CFG.OFFSCREEN_NDC;
      if (az > 1 || ax < -off || ax > off || ay < -off || ay > off) targetOp = 0;

      rec._targetOp = targetOp;

      // Scan-in stagger — assign a reveal timestamp when a card goes hidden → visible after a band change: 150 ms hold
      // so the old band clears, then 40 ms/card stagger capped at 300 ms.
      if (rec._targetOp > 0.02 && rec.op <= 0.02 && rec._revealAt == null) {
        rec._revealAt = this._bandChangedAt + 150 + Math.min(300, (this._revealSeq++) * 40);
      }
      if (rec.op > 0.05) rec._revealAt = null;

      // Card content: compact only (the full variant is the dossier's); the epoch branch below is the rails' one refresh.
      if (rec._cardEpoch !== fontEpochNow && epochRedraws < CARD_EPOCH_REDRAWS_PER_FRAME) {
        // Its ONE owed redraw: the face question settled after this card was drawn (the key inside misses on the epoch).
        this._applyCard(rec, { full: false });
        epochRedraws++;
      }

      // Pending side-flip — commit when faded out, force fade otherwise. Placed BEFORE the hidden early-continue so a
      // rec fading out for a band change while a flip is pending can't get stuck invisible.
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
        rec.op += (0 - rec.op) * fadeK;
        if (rec.op <= 0.02) {
          rec.primed = false; // reappear snaps to new slot, no sweep
          rec._railOrder = null; // reset rail ordinal when hidden
          rec._pendingSide = null; // clear pending flip on hide
          rec.side = null; // fresh side assignment on reappear (sets _sideT=now)
          rec._sideT = 0;
        }
        this._hideRec(rec);
        continue;
      }

      // Side assignment with hysteresis + 1.5 s dwell (fade-swap, never sweep).
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
    // the hover dossier — after the rails, so it never joins their layout.
    this._updateDossier(now, liveDue, ease);
  }

  /** Target opacity for a rec given band/guide/open-system, before anchor gating. @private
   * Binary legibility: opacity is band/guide/open only — the facing ramp (hardware on the hull, not a card on a
   * screen-edge rail) is a hard GATE here (back-facing → 0) and a soft fade only on the dot + leader in _positionCard.
   * Non-hidden targets are floored to MIN_CARD_OP so a shown card is always readable.
   * §13 r3 — labels in steps:
   *   - system labels show in EVERY band. SYSTEM band: all full (the sweep's guided system full, the rest 0.5).
   *     PART/COMPONENT: the open system's name is full, the others dimmed to MIN_CARD_OP; all full at rest, and during
   *     the sweep the guided system is full and the rest dim (its first hover/tap ends it);
   *   - major parts show ONLY when their system is open; in COMPONENT the non-focus majors keep 0.8;
   *   - detail parts show in COMPONENT for the open system, plus the proximity reveal around the focus part.
   * @param {string|null} [openSys] the OPEN system id (from _resolveOpenSys; the COMPONENT focus reaches it via rule 4)
   * @param {number} [focusNX] focused part's anchor NDC (proximity reveal)
   * @param {number} [focusNY]
   * @param {number} [facing] pre-computed _anchorVisible(rec.anchor) for this frame; recomputed only if not supplied. */
  _targetOpacity(rec, band, guideId, openSys, focusNX, focusNY, facing) {
    if (rec._neverShow) return 0; // DAUGHTERS pseudo-group has no system label
    if (rec._armGone) return 0;   // daughter away from its berth
    if (rec._flowerGone) return 0; // THERMAL family pre-purchase
    // Hard facing gate: a card whose anchor faces away is hidden outright
    // (the dot/leader carry the on-hull fade; the card does not).
    const face = (facing != null) ? facing : this._anchorVisible(rec.anchor, rec);
    if (face < 0.15) return 0;
    const floor = CFG.MIN_CARD_OP ?? 0.5;
    if (rec.isSystem) {
      if (band === 'SYSTEM') {
        if (guideId) return (rec.def.id === guideId) ? 1 : 0.5;
        return 1;
      }
      // §13 r3: the names show in every band. During the sweep the guided system is full and the rest dim; otherwise
      // the open system's name is full, the others dim, and every name is full at rest.
      if (guideId) return (rec.def.id === guideId) ? 1 : floor;
      return (openSys == null || rec.def.id === openSys) ? 1 : floor;
    }
    if (rec.isDetail) {
      if (band !== 'COMPONENT') return 0;
      let reveal = rec.sysId === openSys;
      // Proximity reveal — detail parts near the focused part on screen appear even when they belong to another system.
      if (!reveal && this._focusPart) {
        const dx = rec._anchorX - focusNX, dy = rec._anchorY - focusNY;
        const r = CFG.DETAIL_REVEAL_NDC || 0.25;
        if (dx * dx + dy * dy < r * r) reveal = true;
      }
      return reveal ? 1 : 0;
    }
    // Major part: only the open system's majors show (§13 r3). During the sweep no system is open (the first hover/tap
    // ends it), so the sweep shows names only.
    const showParts = band === 'PART' || band === 'COMPONENT';
    if (!showParts) return 0;
    if (rec.sysId !== openSys) return 0;
    let op = 1;
    // COMPONENT band, not the focused part: recede a little (still readable).
    const isFocus = band === 'COMPONENT' && rec === this._focusPart;
    if (band === 'COMPONENT' && !isFocus) op = Math.min(op, 0.8);
    return Math.max(op, floor);
  }

  /**
   * Stack one rail's cards: order top → bottom (hysteresis via the pure `orderRail`), priority-cull on overflow, assign
   * slot Ys centred on the anchors' mean, then ease + place.
   * @private
   */
  _stackRail(list, railX, dt, ease, fadeK) {
    if (list.length === 0) return;

    // Top → bottom order with persistent ordinals + hysteresis.
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
          drop._railOrder = null; // renumber when it re-enters
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

  /**
   * The hover dossier: after HOVER_DOSSIER_DELAY_MS of dwell on ONE rec (the dwell restarts on every change, see
   * _setHoverRec), a single reusable full-content card appears beside the pointer: _applyCard's `full` variant rendered
   * onto the wrapper rec's OWN sprite, so no rail rec's card identity is touched. It never joins rail layout and its
   * live rows re-rasterise at ≤ LIVE_REFRESH_HZ.
   *
   * GLASS HAS NO HOVER: a tap runs the click path only — pointerleave follows pointerup on touch and clears the hover
   * long before any dwell elapses.
   * @private
   */
  _updateDossier(now, liveDue, ease) {
    const sprite = this._dossierSprite;
    if (!sprite) return;
    const rec = this._hoverRec;
    if (!rec || !rec.def || (now - this._dossierDwellStart) < HOVER_DOSSIER_DELAY_MS) {
      this._hideDossier();
      return;
    }
    if (this._dossierShownFor !== rec) {
      // First frame past the dwell: build the hovered rec's full card.
      const d = this._dossierRec;
      d.def = rec.def;
      d.isSystem = !!rec.isSystem;
      d.hue = rec.hue;
      d.riskColor = rec.riskColor;
      this._applyCard(d, { full: true });
      this._dossierShownFor = rec;
    } else if (liveDue) {
      this._applyCard(this._dossierRec, { full: true });
    }
    this._positionDossier(ease);
  }

  /** Hide the dossier and reset its shown/prime state. @private */
  _hideDossier() {
    this._dossierShownFor = null;
    this._dossierPrimed = false;
    if (!this._dossierSprite) return;
    this._dossierSprite.visible = false;
    this._dossierSprite.material.opacity = 0;
  }

  /**
   * Place the dossier beside the pointer, never under it. Unproject the cached pointer NDC (written by _refreshHover
   * at its 10 Hz cadence; the position ease smooths the cadence) on the ship-centre depth plane — the same law
   * _positionCard uses — then offset the card a fixed gap off the pointer, flipping toward screen centre when it would
   * cross the pane-aware RIGHT edge, and clamp against the pane-aware edges (never ±1: the card must not slide under a
   * drawer). The clamp is source-pinned by the suite.
   * @private
   */
  _positionDossier(ease) {
    const sprite = this._dossierSprite;
    const px = this._dossierNX, py = this._dossierNY;
    if (!sprite || !Number.isFinite(px) || !Number.isFinite(py)) { this._hideDossier(); return; }

    // Card geometry at the dossier's size tier (aspect × heightFactor = CARD_W_OVER_TITLE_H for every card).
    const frac = this._sizeFrac(this._dossierRec, true);
    const heightFactor = this._dossierRec.card?.heightFactor || 1;
    const camAspect = this.camera.aspect || 1;
    const cardW = 2 * frac * CARD_W_OVER_TITLE_H / camAspect;
    const cardH = 2 * frac * heightFactor;
    const margin = CFG.RAIL_MARGIN_NDC;

    let side = 'R';
    let tx = px + HOVER_DOSSIER_OFFSET_NDC;
    if (tx + cardW > this._edgeR - margin) { side = 'L'; tx = px - HOVER_DOSSIER_OFFSET_NDC; }
    // Clamp X: card extends outward from its anchor edge, so reserve width on that side — against the PANE-AWARE edges
    // (the dossier never sits under a workbench pane; no pane → -1/+1).
    if (side === 'L') tx = Math.max(tx, this._edgeL + margin + cardW);
    else {
      // Right-extending card: its left edge only needs to clear a LEFT pane (matters for a stale pointer under a drawer).
      tx = Math.max(tx, this._edgeL + margin);
      tx = Math.min(tx, this._edgeR - margin - cardW);
    }
    // Clamp Y: a small nudge below the pointer so the card reads "beside", never "under".
    let ty = py - HOVER_DOSSIER_OFFSET_NDC * 0.5;
    ty = clamp(ty, -1 + margin + cardH / 2, 1 - margin - cardH / 2);

    if (!this._dossierPrimed) { this._dossierSX = tx; this._dossierSY = ty; this._dossierPrimed = true; }
    else {
      this._dossierSX += (tx - this._dossierSX) * ease;
      this._dossierSY += (ty - this._dossierSY) * ease;
    }

    // Unproject at the ship-centre depth plane (the _positionCard law), so the sizing math matches.
    this._vAttach.copy(this._vShip)
      .addScaledVector(this._camRight, (this._dossierSX - this._shipNDC.x) * this._halfW)
      .addScaledVector(this._camUp, (this._dossierSY - this._shipNDC.y) * this._halfH);
    this._vTmp.copy(this._vAttach);
    this.player.worldToLocal(this._vTmp);
    sprite.position.copy(this._vTmp);

    // Screen-constant sizing (manual dist scaling — see _positionCard).
    const h = frac * 2 * this._halfH * heightFactor;
    const aspect = CARD_W_OVER_TITLE_H / heightFactor;
    sprite.scale.set(h * aspect, h, 1);
    sprite.center.x = (side === 'L') ? 1 : 0;
    sprite.material.opacity = 1;
    sprite.visible = true;
  }

  /**
   * Given a rec's eased NDC slot: unproject to local space, size the sprite, ease opacity, rebuild the leader + dot.
   * @private
   */
  _positionCard(rec, nx, ny, isFocus, side, fadeK) {
    // Unproject NDC slot at ship-centre depth → world → local, relative to the ship's actual screen position (absolute
    // NDC would double-shift when the inspection look-at carries a forward offset).
    this._vAttach.copy(this._vShip)
      .addScaledVector(this._camRight, (nx - this._shipNDC.x) * this._halfW)
      .addScaledVector(this._camUp, (ny - this._shipNDC.y) * this._halfH);
    this._vTmp.copy(this._vAttach);
    this.player.worldToLocal(this._vTmp);
    rec.sprite.position.copy(this._vTmp);

    // Screen-constant sizing (manual dist scaling). SIZE_* defines the on-screen height of the TITLE BLOCK; scale by
    // heightFactor so the whole card grows proportionally and text stays the same size. aspect × heightFactor =
    // CARD_W_OVER_TITLE_H for every card, so derive the width factor from the invariant, not a possibly-stale card.
    const frac = this._sizeFrac(rec, isFocus);
    const heightFactor = rec.card?.heightFactor || 1;
    const h = frac * 2 * this._halfH * heightFactor;
    const aspect = CARD_W_OVER_TITLE_H / heightFactor;
    rec.sprite.scale.set(h * aspect, h, 1);

    // Ease opacity; hold at 0 while waiting for the scan-in reveal slot. Hover lifts it a little; the colour lift below
    // carries the affordance at full opacity where this boost is a no-op.
    const tgt = (rec._revealAt != null && this._nowMs < rec._revealAt) ? 0 : rec._targetOp;
    rec.op += (tgt - rec.op) * fadeK;
    const hovered = this._hoverRec === rec;
    const op = hovered ? Math.min(1, rec.op + 0.15) : rec.op;
    const visible = op > 0.02;
    rec.sprite.material.opacity = op;
    rec.sprite.visible = visible;
    // Cards are full-bright (a global dim only muddied them). The hover cue is carried by the leader whitening
    // (below), the +0.15 opacity lift, and a small screen-constant scale bump.
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
    // Anchor in local space (Vector3, resolved per frame).
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

  /**
   * @private Build the one-line hint: a DOM chip (inline style, the HintTicker pattern) vertically centred in the
   * transient band (88–124 px from the bottom, read from the same ONBOARDING.TICKER tuning as the hint ticker so the
   * two cannot drift), horizontally centred in the pane-free strip by _updateHint. `pointer-events:none`; disposed in
   * dispose(). No-op without a DOM (the Node test rigs).
   */
  _buildHint() {
    if (typeof document === 'undefined' || !document.body) return;
    const T = Constants.ONBOARDING?.TICKER || {};
    const el = document.createElement('div');
    el.id = 'mother-callout-hint';
    el.textContent = hintText();
    // Individual assignments (not one cssText string) so headless DOM shims read back every pinned property.
    const s = el.style;
    s.position = 'fixed';
    s.bottom = `${T.BOTTOM_PX ?? 88}px`;
    s.height = `${T.ROW_HEIGHT_PX ?? 36}px`;
    s.display = 'none';
    s.alignItems = 'center';
    s.padding = '0 14px';
    s.border = '1px solid rgba(0,204,255,0.35)';
    s.borderRadius = '4px';
    s.background = 'rgba(0,10,20,0.78)';
    s.color = CFG.INK;
    s.fontSize = `${T.FONT_OLDER_PX ?? 13}px`;
    s.letterSpacing = '0.02em';
    s.whiteSpace = 'nowrap';
    s.pointerEvents = 'none';
    s.transform = 'translateX(-50%)';
    s.zIndex = '8000';
    document.body.appendChild(el);
    this._hintEl = el;
  }

  /**
   * @private The hint's per-frame drive (from update()): show while ACTIVE and not yet dismissed (`_hintDone` is never
   * reset — once per page load), else hide. A caption (showCaption) takes the same element for its `ms`, dismissed or
   * not, then the strip returns to its normal state. Placement (the pane-free strip's centre X in CSS px) is re-derived
   * at most once per VW_READ_MS and on every pane/rail-edge change; a canvas rect read is layout-affected, never per frame.
   */
  _updateHint() {
    const el = this._hintEl;
    if (!el) return;
    const now = this._nowMs || 0;
    if (this._capText && now >= this._capUntil) this._capText = '';        // the caption's time is up
    const capOn = !!this._capText && this._active;
    // The hint waits for the ship ("point at a part"): it shows only while the ship's centre is on screen and in front
    // of the camera (checked only while the hint is still to be shown). Words unchanged (§13 r3).
    const show = capOn || (this._active && !this._hintDone && shipOnScreen(this._shipNDC));
    const want = show ? 'flex' : 'none';
    if (show) { const t = capOn ? this._capText : hintText(); if (el.textContent !== t) el.textContent = t; }   // draw-time glass read
    if (el.style.display !== want) el.style.display = want;
    if (!show) {
      if (this._hintMode === 'cap') { this._styleHint(el, false); this._hintMode = 'hint'; }   // the hint's own style, restored once the caption is gone
      return;
    }
    const mode = capOn ? 'cap' : 'hint';
    if ((this._hintMode || 'hint') !== mode) { this._styleHint(el, capOn); this._hintReadAt = null; }
    this._hintMode = mode;
    if (this._hintEdgeL === this._edgeL && this._hintEdgeR === this._edgeR
      && this._hintReadAt != null && (now - this._hintReadAt) < VW_READ_MS) return;
    this._hintEdgeL = this._edgeL;
    this._hintEdgeR = this._edgeR;
    this._hintReadAt = now;
    const rect = (this.canvas && typeof this.canvas.getBoundingClientRect === 'function')
      ? this.canvas.getBoundingClientRect() : null;
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.width)) return;
    el.style.left = `${Math.round((this._stripCX * 0.5 + 0.5) * rect.width + rect.left)}px`;
    if (capOn) {
      // A caption wraps inside the pane-free strip (never wider than CAPTION_MAX_PX), so it cannot run under a pane.
      const strip = (this._edgeR - this._edgeL) * 0.5 * rect.width;
      const w = Number.isFinite(strip) ? Math.max(CAPTION_MIN_PX, Math.min(CAPTION_MAX_PX, Math.round(strip - 24))) : CAPTION_MAX_PX;
      el.style.maxWidth = `${w}px`;
    }
  }

  /**
   * @private The hint element's two looks. Hint: one nowrap row of the band's height (as built). Caption: wraps, grows
   * upward from the same bottom edge (height auto), shrink-wrapped to its text (`width: max-content`, capped by
   * maxWidth, set by _updateHint from the pane-free strip). The hint's own style is restored afterwards.
   */
  _styleHint(el, caption) {
    const T = Constants.ONBOARDING?.TICKER || {};
    const row = `${T.ROW_HEIGHT_PX ?? 36}px`;
    const s = el.style;
    if (caption) {
      s.whiteSpace = 'normal';
      s.height = 'auto';
      s.minHeight = row;
      s.width = 'max-content';
      s.padding = '6px 14px';
      s.textAlign = 'center';
      s.lineHeight = '1.35';
      s.boxSizing = 'border-box';
    } else {
      s.whiteSpace = 'nowrap';
      s.height = row;
      s.minHeight = '';
      s.width = '';
      s.maxWidth = '';
      s.padding = '0 14px';
      s.textAlign = '';
      s.lineHeight = '';
      s.boxSizing = '';
    }
  }

  /**
   * A short caption in the F1 hint strip (FloorMask hides the comms panel on floor 1, so the furnace test's lines come
   * here). Shown for `ms` (a new caption replaces the old) whether or not the "Point at a part" hint was dismissed,
   * only while F1 inspection is active; then the strip returns to its normal state. Empty text (or ms <= 0) clears it now.
   * @param {string} text
   * @param {number} ms
   */
  showCaption(text, ms) {
    if (typeof text !== 'string' || !text || !(ms > 0)) {
      this._capText = '';
      this._updateHint?.();
      return;
    }
    if (!this._active) return;
    if (!this._nowMs) this._nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());   // before the first frame
    this._capText = text;
    this._capUntil = this._nowMs + ms;
    this._updateHint?.();
  }

  /** @private Drop the hint element (the dispose path). */
  _disposeHint() {
    const el = this._hintEl;
    if (!el) return;
    this._hintEl = null;
    if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
    else if (typeof el.remove === 'function') el.remove();
  }

  dispose() {
    this._detachPointer();
    this._sysLabelHover = null;   // the hovered-name cache leaves with the layer
    // §13 r3: the hint element leaves with the layer.
    this._disposeHint?.();
    // Drop the REFIT ghost set before the outline teardown below (the materials are about to dispose, but the set must
    // not hold freed recs). Guarded like _setActive for rig stubs.
    if (this._ghostRecs && this._ghostRecs.size) this._clearGhosts();
    // If inspection was active, tell the HUD breadcrumb to hide before we tear down — otherwise it stays on screen
    // permanently.
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
      // Hover outlines live under the hull meshes (not _group) — the ONE teardown detaches + disposes them (shells
      // SHARE the hull meshes' geometry: removed but never disposed — see _disposeOutline).
      this._disposeOutline(s);
    }
    // The dossier wrapper's cached card + its sprite material (the wrapper is not in _allRecs).
    if (this._dossierRec?._cardCache) {
      for (const card of this._dossierRec._cardCache.values()) {
        card?.texture?.dispose();
      }
      this._dossierRec._cardCache.clear();
    }
    this._dossierRec?.card?.texture?.dispose();
    this._dossierSprite?.material?.dispose();
    this.player.remove(this._group);
  }
}

// Exported for tests (drift guard on the label table / codexId mapping).
export { SYSTEMS as MOTHER_CALLOUT_SYSTEMS, PORTRAIT_OVERRIDES as MOTHER_PORTRAIT_OVERRIDES };
