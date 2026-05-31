/**
 * MenuScene3D.js — 3D hero scene for the menu screen.
 * Shows an EVA astronaut repairing the V5 Crossbow mother satellite,
 * with welding sparks and a slow orbiting camera.
 *
 * Self-contained second WebGL context — independent of the game renderer.
 * @module ui/MenuScene3D
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';   // FIX_PLAN §2-followup — RENDER_ORDER enum

// ─── Constants (mirror key OCTOPUS_V5 values to avoid import weight) ─────────
const M         = 1;          // scale factor (1 unit = 1 metre)
const BUS_LEN   = 2.0 * M;   // barrel length
const BUS_R     = 0.4 * M;   // across-flats radius
const COLLAR_Y  = 0.90 * M;  // collar offset from bus centre
const ROSA_W    = 1.0 * M;   // wing extension per side
const ROSA_L    = 2.0 * M;   // panel chord

const SPARK_COUNT = 70;
const SPARK_SPEED = 2.80;     // fast — sparks streak away before accumulating
const SPARK_LIFE  = 0.45;     // short — die quickly for crisp look

// ─── Material palette ────────────────────────────────────────────────────────
function makeMaterials() {
  return {
    body:     new THREE.MeshStandardMaterial({ color: 0x5c5c64, metalness: 0.7, roughness: 0.55 }),
    goldMLI:  new THREE.MeshStandardMaterial({ color: 0xccaa44, metalness: 0.75, roughness: 0.4,
                emissive: 0x332200, emissiveIntensity: 0.05 }),
    dark:     new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.6, roughness: 0.4 }),
    collar:   new THREE.MeshStandardMaterial({ color: 0x8888a0, metalness: 0.75, roughness: 0.28 }),
    strut:    new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.15, roughness: 0.65 }),
    solar:    new THREE.MeshStandardMaterial({ color: 0x0a1133, metalness: 0.4, roughness: 0.5,
                side: THREE.DoubleSide }),
    suitWhite: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 0.05, roughness: 0.85 }),
    suitGray:  new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.15, roughness: 0.7 }),
    visor:     new THREE.MeshStandardMaterial({ color: 0xcc8800, metalness: 0.9, roughness: 0.1,
                 envMapIntensity: 1.5 }),
    plss:      new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 0.1, roughness: 0.8 }),
    glove:     new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.05, roughness: 0.9 }),
    boot:      new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.1, roughness: 0.8 }),
    tool:      new THREE.MeshStandardMaterial({ color: 0x666677, metalness: 0.7, roughness: 0.3 }),
    thaiRed:   new THREE.MeshStandardMaterial({ color: 0xed1c24, metalness: 0.0, roughness: 0.9 }),
    thaiBlue:  new THREE.MeshStandardMaterial({ color: 0x003893, metalness: 0.0, roughness: 0.85 }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SATELLITE — simplified V5 Crossbow
// ═════════════════════════════════════════════════════════════════════════════
function buildSatellite(mat) {
  const sat = new THREE.Group();
  sat.name = 'MotherSatellite';

  // Bus (octagonal prism ≈ 16-segment cylinder)
  // FIX_PLAN §2-followup: openEnded=true so we don't have two coplanar caps
  // (bus's own end caps would z-fight with the colored fCap/rCap overlays).
  const busGeo = new THREE.CylinderGeometry(BUS_R, BUS_R, BUS_LEN, 16, 1, true);   // FIX_PLAN §2-followup
  const bus = new THREE.Mesh(busGeo, mat.body);
  bus.rotation.x = Math.PI / 2;   // align to Z-forward
  bus.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;   // FIX_PLAN §2-followup
  sat.add(bus);

  // Gold MLI bands
  // FIX_PLAN §2-followup: clone material + polygonOffset so band draws cleanly
  // on top of the bus surface (was visible Z-stitching at grazing angles).
  const bandMat = mat.goldMLI.clone();                          // FIX_PLAN §2-followup
  bandMat.polygonOffset = true;                                 // FIX_PLAN §2-followup
  bandMat.polygonOffsetFactor = -1;                             // FIX_PLAN §2-followup
  bandMat.polygonOffsetUnits  = -1;                             // FIX_PLAN §2-followup
  const bandGeo = new THREE.CylinderGeometry(BUS_R * 1.02, BUS_R * 1.02, M * 0.04, 16);
  for (const zOff of [BUS_LEN * 0.35, -BUS_LEN * 0.35]) {
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.rotation.x = Math.PI / 2;
    band.position.z = zOff;
    band.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2-followup
    sat.add(band);
  }

  // End caps
  const capGeo = new THREE.CircleGeometry(BUS_R * 0.98, 16);
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x444455, metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide,
  });
  // FIX_PLAN §2-followup: pushed caps 1 mm past bus end to belt-and-braces
  // even though bus is now openEnded (paranoia / future-proof).
  const fCap = new THREE.Mesh(capGeo, capMat);
  fCap.position.z = BUS_LEN * 0.5 + 0.001;                       // FIX_PLAN §2-followup
  fCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
  sat.add(fCap);
  const rCap = new THREE.Mesh(capGeo, capMat);
  rCap.position.z = -BUS_LEN * 0.5 - 0.001;                      // FIX_PLAN §2-followup
  rCap.rotation.y = Math.PI;
  rCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
  sat.add(rCap);

  // ── Collar ring ──
  const collarGeo = new THREE.TorusGeometry(BUS_R * 1.05, M * 0.015, 8, 32);
  const collar = new THREE.Mesh(collarGeo, mat.collar);
  collar.rotation.x = Math.PI / 2;
  collar.position.z = COLLAR_Y;
  sat.add(collar);

  // ── ROSA solar panels ──
  const panelThick = M * 0.01;
  for (const side of [-1, 1]) {
    const panelGeo = new THREE.BoxGeometry(ROSA_W, ROSA_L * 0.9, panelThick);
    const panel = new THREE.Mesh(panelGeo, mat.solar);
    panel.position.set(side * (BUS_R + ROSA_W * 0.5), 0, 0);
    sat.add(panel);

    // Grid lines suggesting cells
    // FIX_PLAN §2-followup (round 3): added depthWrite:false + renderOrder so
    // the transparent wireframe doesn't poke through other transparent layers
    // and always sorts above the opaque panel beneath.
    const gridGeo = new THREE.PlaneGeometry(ROSA_W * 0.95, ROSA_L * 0.85);
    const gridMat = new THREE.MeshBasicMaterial({
      color: 0x2244aa, wireframe: true, transparent: true, opacity: 0.25,
      depthWrite: false,                                              // FIX_PLAN §2-followup (round 3)
    });
    const grid = new THREE.Mesh(gridGeo, gridMat);
    grid.position.set(side * (BUS_R + ROSA_W * 0.5), 0, panelThick * 0.6);
    grid.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT; // FIX_PLAN §2-followup (round 3)
    sat.add(grid);

    // Roll-out mechanism (thin cylinder at root)
    const rollGeo = new THREE.CylinderGeometry(M * 0.02, M * 0.02, ROSA_L * 0.7, 6);
    const roll = new THREE.Mesh(rollGeo, mat.dark);
    roll.position.set(side * (BUS_R + M * 0.03), 0, 0);
    sat.add(roll);
  }

  // ── Sensor dome (front) ──
  const domeGeo = new THREE.SphereGeometry(M * 0.1, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const dome = new THREE.Mesh(domeGeo, new THREE.MeshStandardMaterial({
    color: 0x888888, metalness: 0.7, roughness: 0.3,
  }));
  dome.position.set(0, M * 0.15, BUS_LEN * 0.5 + M * 0.02);
  dome.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
  sat.add(dome);

  // ── Docking port (front) ──
  // FIX_PLAN §2-followup: pushed z 0.01→0.02 so torus inner rim doesn't graze
  // the front cap (cap now at z=0.5+0.001, dock at z=0.5+0.02).
  const dockGeo = new THREE.TorusGeometry(M * 0.2, M * 0.03, 6, 12);
  const dock = new THREE.Mesh(dockGeo, mat.collar);
  dock.position.set(0, -M * 0.1, BUS_LEN * 0.5 + M * 0.02);      // FIX_PLAN §2-followup
  dock.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
  sat.add(dock);

  // ── Hall thruster nozzle (rear) ──
  const nozzleGeo = new THREE.ConeGeometry(M * 0.06, M * 0.1, 8, 1, true);
  const nozzle = new THREE.Mesh(nozzleGeo, new THREE.MeshStandardMaterial({
    color: 0x996644, metalness: 0.8, roughness: 0.35,
  }));
  nozzle.position.z = -BUS_LEN * 0.5 - M * 0.05;
  nozzle.rotation.x = Math.PI;
  sat.add(nozzle);

  // Nav lights
  const navGeo = new THREE.SphereGeometry(M * 0.02, 4, 4);
  const portLight = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  portLight.position.set(-BUS_R - M * 0.02, 0, M * 0.3);
  sat.add(portLight);
  const starLight = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
  starLight.position.set(BUS_R + M * 0.02, 0, M * 0.3);
  sat.add(starLight);

  return sat;
}


// ═════════════════════════════════════════════════════════════════════════════
// ASTRONAUT — procedural EVA suit (NASA EMU inspired)
// ═════════════════════════════════════════════════════════════════════════════
function buildAstronaut(mat) {
  const astro = new THREE.Group();
  astro.name = 'EVAAstronaut';

  // ── Oversized helmet (iconic NASA EMU bubble — dominates silhouette) ──
  // Real EMU helmet ≈ 380 mm dia; game scale oversized to ~500 mm for readability
  const helmetGeo = new THREE.SphereGeometry(M * 0.25, 16, 14);
  const helmet = new THREE.Mesh(helmetGeo, mat.suitWhite);
  helmet.position.y = M * 0.74;
  helmet.scale.set(1.0, 1.06, 1.10);   // deeper front-back for EMU bubble shape
  astro.add(helmet);

  // Gold sun visor — iconic reflective golden shield on front of helmet
  // THREE.js SphereGeometry vertex: x = -r·cos(phi)·sin(theta), z = r·sin(phi)·sin(theta)
  // At phi=0 → x=-r,z=0; at phi=PI/2 → x=0,z=+r; at phi=PI → x=+r,z=0
  // → hemisphere dome faces local +Z by default (no rotation.y needed)
  // local +Z → R_y(-π/2) → world -X (toward satellite) ✓
  const visorGeo = new THREE.SphereGeometry(M * 0.256, 16, 12,
    0, Math.PI, 0, Math.PI * 0.72);
  // FIX_PLAN §2-followup: visor scale Z=1.04 was INSIDE helmet Z=1.10 → torus
  // of z-fight at the visor rim. Clone material with polygonOffset + renderOrder
  // so the visor always draws cleanly on top of the helmet sphere.
  const visorMat = mat.visor.clone();                              // FIX_PLAN §2-followup
  visorMat.polygonOffset = true;                                   // FIX_PLAN §2-followup
  visorMat.polygonOffsetFactor = -2;                               // FIX_PLAN §2-followup
  visorMat.polygonOffsetUnits  = -2;                               // FIX_PLAN §2-followup
  const visor = new THREE.Mesh(visorGeo, visorMat);
  visor.position.y = M * 0.74;
  visor.rotation.y = 0;              // dome already faces local +Z → world -X (toward satellite)
  visor.scale.set(1.10, 1.08, 1.12); // FIX_PLAN §2-followup — Z 1.04→1.12 so visor fully wraps outside helmet (0.25*1.10=0.275)
  visor.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;    // FIX_PLAN §2-followup
  astro.add(visor);

  // Neck ring (thick metallic collar — scaled to match larger helmet base)
  const neckRingGeo = new THREE.TorusGeometry(M * 0.195, M * 0.024, 8, 20);
  const neckRing = new THREE.Mesh(neckRingGeo, mat.collar);
  neckRing.position.y = M * 0.57;
  neckRing.rotation.x = Math.PI / 2;
  astro.add(neckRing);

  // ── Torso (HUT — Hard Upper Torso) — wider top to meet shoulder caps flush ──
  const hutGeo = new THREE.CylinderGeometry(M * 0.24, M * 0.19, M * 0.32, 12);
  const hut = new THREE.Mesh(hutGeo, mat.suitWhite);
  hut.position.y = M * 0.40;
  astro.add(hut);

  // ── PLSS backpack (Life Support — boxy, makes torso look very wide from rear) ──
  // Real EMU PLSS ≈ 660×450×280 mm; scaled for game character height
  const plssGeo = new THREE.BoxGeometry(M * 0.36, M * 0.42, M * 0.22);
  const plss = new THREE.Mesh(plssGeo, mat.plss);
  plss.position.set(0, M * 0.42, -M * 0.18);
  astro.add(plss);
  // PLSS top detail strip
  const plssTopGeo = new THREE.BoxGeometry(M * 0.34, M * 0.04, M * 0.20);
  const plssTop = new THREE.Mesh(plssTopGeo, mat.suitGray);
  plssTop.position.set(0, M * 0.65, -M * 0.18);
  astro.add(plssTop);

  // Oxygen hoses
  for (const side of [-1, 1]) {
    const hoseGeo = new THREE.CylinderGeometry(M * 0.016, M * 0.016, M * 0.22, 5);
    const hose = new THREE.Mesh(hoseGeo, mat.suitGray);
    hose.position.set(side * M * 0.08, M * 0.58, -M * 0.05);
    hose.rotation.z = side * 0.3;
    astro.add(hose);
  }

  // ── Lower torso ──
  const ltaGeo = new THREE.CylinderGeometry(M * 0.18, M * 0.15, M * 0.20, 12);
  const lta = new THREE.Mesh(ltaGeo, mat.suitWhite);
  lta.position.y = M * 0.16;
  astro.add(lta);

  // Waist ring
  const waistGeo = new THREE.TorusGeometry(M * 0.18, M * 0.013, 5, 18);
  const waist = new THREE.Mesh(waistGeo, mat.collar);
  waist.position.y = M * 0.25;
  waist.rotation.x = Math.PI / 2;
  astro.add(waist);

  // ── Shoulder joint caps — fixed to torso, bridge HUT edge → arm root ──
  // EMU scye bearings appear as rounded white epaulets at each shoulder.
  // Attached to astro (NOT to arm groups) so they stay fixed while arms rotate.
  // HUT top radius at y=0.50 ≈ 0.231 m; arm group origins at ±0.24 → very small gap.
  // FIX_PLAN §2-followup: caps intersect HUT side wall (sCap radius 0.092 at
  // x=±0.225 with scale 1.28 → outer edge ~0.343, inner edge ~0.107 < HUT top
  // radius 0.24). Apply renderOrder so cap surface wins the depth tie.
  for (const side of [-1, 1]) {
    const sCapGeo = new THREE.SphereGeometry(M * 0.092, 10, 8);
    const sCap = new THREE.Mesh(sCapGeo, mat.suitWhite);
    // Centred just outside HUT surface; scale wider than tall for EMU pad shape
    sCap.position.set(side * M * 0.225, M * 0.51, 0);
    sCap.scale.set(1.28, 0.76, 1.12);
    sCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;  // FIX_PLAN §2-followup
    astro.add(sCap);
  }

  // ── LEFT arm — anatomical RIGHT arm, secondary-tool hold pose ──
  const lShoulder = new THREE.Group();
  lShoulder.position.set(-M * 0.24, M * 0.50, 0);
  lShoulder.rotation.z = -0.45;   // moderate outward splay
  lShoulder.rotation.x = -0.20;   // forward raise — arm actively holds tool
  lShoulder.rotation.y = -0.10;   // inward twist for natural grip posture

  const armGeo = new THREE.CylinderGeometry(M * 0.065, M * 0.055, M * 0.28, 8);
  const lUpper = new THREE.Mesh(armGeo, mat.suitWhite);
  lUpper.position.y = -M * 0.14;
  lShoulder.add(lUpper);

  // EMU scye bearing ring (shoulder joint detail)
  const elbowGeo = new THREE.SphereGeometry(M * 0.060, 6, 6);
  const lElbow = new THREE.Mesh(elbowGeo, mat.suitGray);
  lElbow.position.y = -M * 0.28;
  lShoulder.add(lElbow);

  const lForearmGroup = new THREE.Group();
  lForearmGroup.position.y = -M * 0.28;
  lForearmGroup.rotation.z = +0.38;   // moderate inward bend for purposeful hold
  lForearmGroup.rotation.x = +0.05;   // slight forward tilt

  const foreGeo = new THREE.CylinderGeometry(M * 0.052, M * 0.046, M * 0.24, 8);
  const lFore = new THREE.Mesh(foreGeo, mat.suitWhite);
  lFore.position.y = -M * 0.12;
  lForearmGroup.add(lFore);

  // EMU wrist pressure ring
  const lWristGeo = new THREE.TorusGeometry(M * 0.050, M * 0.013, 6, 12);
  const lWrist = new THREE.Mesh(lWristGeo, mat.collar);
  lWrist.position.y = -M * 0.24;
  lWrist.rotation.x = Math.PI / 2;
  lForearmGroup.add(lWrist);

  // Right glove (bulky EVA glove) — anatomical right hand
  const gloveGeo = new THREE.SphereGeometry(M * 0.054, 6, 5);
  const lGlove = new THREE.Mesh(gloveGeo, mat.glove);
  lGlove.position.y = -M * 0.27;
  lGlove.scale.set(1.0, 0.75, 1.25);
  lForearmGroup.add(lGlove);

  // Secondary utility tool in right hand — compact handle tool (inspection/support role)
  const secToolGeo = new THREE.CylinderGeometry(M * 0.018, M * 0.014, M * 0.14, 6);
  const secTool = new THREE.Mesh(secToolGeo, mat.tool);
  secTool.position.set(0, -M * 0.33, M * 0.01);
  secTool.rotation.x = +0.20;   // handle angled gently — stable two-hand working grip
  lForearmGroup.add(secTool);
  // Tool head accent (blunt end cap — different from welding tip)
  const secHeadGeo = new THREE.CylinderGeometry(M * 0.022, M * 0.018, M * 0.03, 6);
  const secHead = new THREE.Mesh(secHeadGeo, mat.collar);
  secHead.position.set(0, -M * 0.40, M * 0.016);
  secHead.rotation.x = +0.20;
  lForearmGroup.add(secHead);

  lShoulder.add(lForearmGroup);
  astro.add(lShoulder);

  // ── RIGHT arm — WELDING ARM (anatomical LEFT) ──
  // Exact solution: tool_parent_x=0.90-0.432=0.468≈weld.x 0.48 ✓  tool_parent_z=astro.z+0.686=0.85 ✓
  // With ry=0.85, rz=0: upper arm (0.539,-0.697,0.473), forearm (0.702,-0.019,0.714) in astro-local.
  // Tool tip outside satellite hull: radial dist 0.491 > bus_radius 0.40 ✓
  const rShoulder = new THREE.Group();
  rShoulder.position.set(M * 0.24, M * 0.50, 0);
  rShoulder.rotation.z =  0.00;
  rShoulder.rotation.x = -0.80;
  rShoulder.rotation.y = +0.40;   // reduced ry → tool_astro_x=0.473 so body sits at z≈0.53 (near barrel end)

  const rUpper = new THREE.Mesh(armGeo.clone(), mat.suitWhite);
  rUpper.position.y = -M * 0.14;
  rShoulder.add(rUpper);

  const rElbow = new THREE.Mesh(elbowGeo.clone(), mat.suitGray);
  rElbow.position.y = -M * 0.28;
  rShoulder.add(rElbow);

  const rForearmGroup = new THREE.Group();
  rForearmGroup.position.y = -M * 0.28;
  rForearmGroup.rotation.z = -0.10;   // slight inward cant
  rForearmGroup.rotation.x = -0.75;   // strong elbow bend — forearm sweeps well forward

  const rFore = new THREE.Mesh(foreGeo.clone(), mat.suitWhite);
  rFore.position.y = -M * 0.12;
  rForearmGroup.add(rFore);

  // EMU wrist pressure ring (right)
  const rWristGeo = new THREE.TorusGeometry(M * 0.050, M * 0.013, 6, 12);
  const rWrist = new THREE.Mesh(rWristGeo, mat.collar);
  rWrist.position.y = -M * 0.24;
  rWrist.rotation.x = Math.PI / 2;
  rForearmGroup.add(rWrist);

  const rGlove = new THREE.Mesh(gloveGeo.clone(), mat.glove);
  rGlove.position.y = -M * 0.27;
  rGlove.scale.set(1.0, 0.75, 1.25);
  rForearmGroup.add(rGlove);

  // Welding tool — held naturally in bent-wrist grip, tip aimed at satellite hull
  const toolGeo = new THREE.CylinderGeometry(M * 0.012, M * 0.016, M * 0.18, 5);
  const tool = new THREE.Mesh(toolGeo, mat.tool);
  tool.position.set(M * 0.01, -M * 0.33, M * 0.04);  // slight lateral offset for natural grip
  tool.rotation.x = -0.30;   // tip angles forward toward surface
  tool.rotation.z =  0.08;   // slight inward tilt matching wrist pronation
  rForearmGroup.add(tool);
  // Glowing tool-tip accent (closest point to weld arc)
  const tipGeo = new THREE.CylinderGeometry(M * 0.008, M * 0.012, M * 0.04, 5);
  const tip = new THREE.Mesh(tipGeo, mat.collar);
  tip.position.set(M * 0.012, -M * 0.43, M * 0.048);
  tip.rotation.x = -0.30;
  tip.rotation.z =  0.08;
  rForearmGroup.add(tip);

  rShoulder.add(rForearmGroup);
  astro.add(rShoulder);

  // ── Legs (micro-g float — shank group pivots at knee for natural bend) ──
  for (const side of [-1, 1]) {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * M * 0.08, M * 0.05, 0);
    legGroup.rotation.z = side * 0.10;
    legGroup.rotation.x = -0.15;

    const uLegGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.07, M * 0.32, 8);
    const uLeg = new THREE.Mesh(uLegGeo, mat.suitWhite);
    uLeg.position.y = -M * 0.16;
    legGroup.add(uLeg);

    // ── Knee — larger and more prominent than elbow, with visible cap ──
    // FIX_PLAN §2-followup: knee + kneeRing + kneePad all co-located at y=-0.32
    // and overlap radially. Apply renderOrder so layering is deterministic:
    // knee sphere (OPAQUE) ← kneeRing torus (DETAIL) ← kneePad (DETAIL+offset).
    const kneeGeo = new THREE.SphereGeometry(M * 0.082, 8, 7);
    const knee = new THREE.Mesh(kneeGeo, mat.suitGray);
    knee.position.y = -M * 0.32;
    knee.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;    // FIX_PLAN §2-followup
    legGroup.add(knee);

    // Knee bearing ring (EMU articulation joint)
    const kneeRingGeo = new THREE.TorusGeometry(M * 0.082, M * 0.014, 6, 16);
    const kneeRing = new THREE.Mesh(kneeRingGeo, mat.collar);
    kneeRing.position.y = -M * 0.32;
    kneeRing.rotation.x = Math.PI / 2;
    kneeRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2-followup
    legGroup.add(kneeRing);

    // Kneecap protective pad — oval pad on front of knee (stays with thigh)
    // FIX_PLAN §2-followup: pad clones suitWhite so we can polygonOffset it
    // forward without affecting other suit pieces.
    const kneePadMat = mat.suitWhite.clone();                       // FIX_PLAN §2-followup
    kneePadMat.polygonOffset = true;                                // FIX_PLAN §2-followup
    kneePadMat.polygonOffsetFactor = -1.5;                          // FIX_PLAN §2-followup
    kneePadMat.polygonOffsetUnits  = -1.5;                          // FIX_PLAN §2-followup
    const kneePadGeo = new THREE.SphereGeometry(M * 0.060, 6, 5);
    const kneePad = new THREE.Mesh(kneePadGeo, kneePadMat);
    kneePad.position.set(0, -M * 0.32, M * 0.07);
    kneePad.scale.set(1.0, 0.70, 0.50);
    kneePad.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2-followup
    legGroup.add(kneePad);

    // Shank group pivots AT the knee
    const shankGroup = new THREE.Group();
    shankGroup.position.y = -M * 0.32;
    shankGroup.rotation.x = +0.38;

    const lLegGeo = new THREE.CylinderGeometry(M * 0.065, M * 0.060, M * 0.28, 8);
    const lLeg = new THREE.Mesh(lLegGeo, mat.suitWhite);
    lLeg.position.y = -M * 0.14;
    shankGroup.add(lLeg);

    // Ankle pressure ring (like wrist/neck rings — EMU joint)
    const ankleGeo = new THREE.TorusGeometry(M * 0.060, M * 0.013, 6, 12);
    const ankle = new THREE.Mesh(ankleGeo, mat.collar);
    ankle.position.set(0, -M * 0.27, 0);
    ankle.rotation.x = Math.PI / 2;
    shankGroup.add(ankle);

    // ── EMU Boot — bulky galosh-style overshoe ──
    // Larger capsule: radius 0.065 → 0.13m tall, 0.27m long (squarer, more massive)
    const bootGeo = new THREE.CapsuleGeometry(M * 0.065, M * 0.14, 5, 10);
    const boot = new THREE.Mesh(bootGeo, mat.boot);
    boot.rotation.x = Math.PI / 2 - 0.10;   // lies along Z, slight toe-up
    boot.scale.set(1.22, 1.08, 1.0);          // nearly square cross-section — chunky EMU look
    boot.position.set(0, -M * 0.288, M * 0.04);
    shankGroup.add(boot);

    // Boot cuff — metallic joint ring at shin-to-boot junction (like wrist/ankle rings)
    const cuffGeo = new THREE.TorusGeometry(M * 0.066, M * 0.016, 6, 14);
    const cuff = new THREE.Mesh(cuffGeo, mat.collar);
    cuff.position.set(0, -M * 0.255, M * 0.01);
    cuff.rotation.x = Math.PI / 2;
    shankGroup.add(cuff);


    legGroup.add(shankGroup);
    astro.add(legGroup);
  }

  // ── Thai flag patch — attached to left upper arm (moves with arm rotation) ──
  // Thai flag proportions: R:W:B:W:R = 1:1:2:1:1 (6 equal units total)
  // Attached to lShoulder so it stays on the outer arm surface
  const flagW = M * 0.090;           // width along arm circumference
  const flagH = M * 0.060;           // height along arm length
  const fu    = flagH / 6;           // single stripe unit (1/6 of flag height)
  const flagGroup = new THREE.Group();
  // Outer face of upper arm in lShoulder-local: -X side, midway down arm
  flagGroup.position.set(-M * 0.068, -M * 0.11, 0);
  // PlaneGeometry normal defaults to +Z; rotation.y = -PI/2 → normal faces -X (outer arm) ✓
  flagGroup.rotation.y = -Math.PI / 2;

  // Dark backing border (frames the flag, visible against white suit)
  const borderGeo = new THREE.PlaneGeometry(flagW + M * 0.006, flagH + M * 0.006);
  const borderMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1 });
  const border = new THREE.Mesh(borderGeo, borderMat);
  border.position.z = -0.001;
  flagGroup.add(border);

  // White base — fills the full flag area (white stripe background)
  const bgGeo = new THREE.PlaneGeometry(flagW, flagH);
  const bg = new THREE.Mesh(bgGeo, mat.suitWhite);
  flagGroup.add(bg);

  // Red stripe top  (unit 1 — top)     center at +2.5·fu from flag centre
  // White stripe    (unit 2)           center at +1.5·fu  ← covered by white bg
  // Blue stripe     (units 3+4 — mid)  center at  0
  // White stripe    (unit 5)           center at −1.5·fu  ← covered by white bg
  // Red stripe bot  (unit 6 — bottom)  center at −2.5·fu

  const redGeo = new THREE.PlaneGeometry(flagW, fu);
  for (const yOff of [fu * 2.5, -fu * 2.5]) {
    const red = new THREE.Mesh(redGeo, mat.thaiRed);
    red.position.set(0, yOff, 0.001);
    flagGroup.add(red);
  }

  const blueGeo = new THREE.PlaneGeometry(flagW, fu * 2.0);   // 2 units wide
  const blue = new THREE.Mesh(blueGeo, mat.thaiBlue);
  blue.position.set(0, 0, 0.001);
  flagGroup.add(blue);

  lShoulder.add(flagGroup);   // child of arm group — rotates with left arm ✓

  return astro;
}


// ═════════════════════════════════════════════════════════════════════════════
// WELDING SPARK PARTICLE SYSTEM
// ═════════════════════════════════════════════════════════════════════════════
function buildSparkSystem() {
  const positions = new Float32Array(SPARK_COUNT * 3);
  const colors    = new Float32Array(SPARK_COUNT * 3);
  const sizes     = new Float32Array(SPARK_COUNT);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

  // Sharp spark shader — hard bright core, rapid falloff (not a soft glowing blob)
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (120.0 / -mvPos.z);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float core  = 1.0 - smoothstep(0.0, 0.14, d);   // hard bright pinpoint
        float outer = 1.0 - smoothstep(0.14, 0.50, d);   // faint narrow halo
        float a = core + outer * 0.22;
        a = clamp(a, 0.0, 1.0);
        gl_FragColor = vec4(vColor * (core * 2.8 + outer * 0.4), a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  const points = new THREE.Points(geo, sparkMat);
  points.name = 'WeldingSparks';

  // Per-particle state
  const sparks = [];
  for (let i = 0; i < SPARK_COUNT; i++) {
    sparks.push({
      alive: false,
      age: 0,
      life: 0,
      vx: 0, vy: 0, vz: 0,
    });
  }

  return { points, sparks, geo };
}

function emitSpark(spark) {
  spark.alive = true;
  spark.age   = 0;
  // 28% chance: arc-flash core — more frequent bright flashes for visor reflection
  const isFlash = Math.random() < 0.28;
  spark.isFlash = isFlash;
  spark.life = isFlash
    ? SPARK_LIFE * (0.15 + Math.random() * 0.25)   // flash: 0.07–0.16s
    : SPARK_LIFE * (0.50 + Math.random() * 0.65);   // spark: 0.22–0.52s
  // Spray in tight cone around +X (away from satellite hull normal)
  const theta   = Math.random() * Math.PI * 2;
  const coneMax = isFlash ? 0.20 : 0.55;           // much tighter — directional spray
  const phi     = Math.random() * coneMax;
  const spd     = SPARK_SPEED * (isFlash
    ? (0.90 + Math.random() * 0.40)                 // flash: fast but not too crazy
    : (0.45 + Math.random() * 0.70));               // spark: wide speed spread
  spark.vx = Math.cos(phi) * spd;
  spark.vy = Math.sin(phi) * Math.cos(theta) * spd * 0.65;
  spark.vz = Math.sin(phi) * Math.sin(theta) * spd * 0.65;
}

function updateSparks(sparkSystem, weldPos, dt) {
  const { sparks, geo } = sparkSystem;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;
  const siz = geo.attributes.size.array;

  const emitRate = 30; // sparks/s — fast enough to look active, short life = no piling
  let toEmit = emitRate * dt;

  for (let i = 0; i < SPARK_COUNT; i++) {
    const s = sparks[i];

    if (!s.alive && toEmit > 0) {
      emitSpark(s);
      pos[i * 3]     = weldPos.x;
      pos[i * 3 + 1] = weldPos.y;
      pos[i * 3 + 2] = weldPos.z;
      toEmit--;
    }

    if (s.alive) {
      s.age += dt;
      if (s.age > s.life) {
        s.alive = false;
        siz[i] = 0;
        continue;
      }

      // Integrate position
      pos[i * 3]     += s.vx * dt;
      pos[i * 3 + 1] += s.vy * dt;
      pos[i * 3 + 2] += s.vz * dt;

      // Drag: sparks slow quickly (molten droplets lose energy fast)
      s.vx *= 0.96;
      s.vy *= 0.96;
      s.vz *= 0.96;
      // Gravity arc — sparks curve downward naturally
      s.vy -= 0.50 * dt;

      const t = s.age / s.life;

      if (s.isFlash) {
        // Arc-flash core: pure white burst — bright enough to reflect off gold visor
        const f0 = Math.max(0, 1.0 - t * 2.5);   // slightly longer bright phase
        col[i * 3]     = f0 * 1.0;   // full white
        col[i * 3 + 1] = f0 * 0.98;
        col[i * 3 + 2] = f0 * 0.95;  // warm white (not cool blue)
        siz[i] = f0 * 2.2;            // significantly bigger flash — visible arc burst
      } else {
        // Normal spark: white-hot core → electric blue → dim cyan → gone
        if (t < 0.20) {
          // White-hot birth burst
          const k = t / 0.20;
          col[i * 3]     = 1.00 - k * 0.40;   // 1.0 → 0.60
          col[i * 3 + 1] = 1.00 - k * 0.20;   // 1.0 → 0.80
          col[i * 3 + 2] = 1.00;
        } else if (t < 0.60) {
          // Electric blue mid-life
          const k = (t - 0.20) / 0.40;
          col[i * 3]     = 0.60 - k * 0.50;   // 0.60 → 0.10
          col[i * 3 + 1] = 0.80 - k * 0.60;   // 0.80 → 0.20
          col[i * 3 + 2] = 1.00;
        } else {
          // Dim dying tail
          const fade = (1.0 - t) * 1.67;       // 0.67→0.0
          col[i * 3]     = 0.06 * fade;
          col[i * 3 + 1] = 0.15 * fade;
          col[i * 3 + 2] = 0.70 * fade;
        }
        // Size: grow briefly then shrink — each spark "blooms" as it births
        const bloom = t < 0.15 ? t / 0.15 : (1.0 - t) / 0.85;
        siz[i] = bloom * 0.75 + 0.05;
      }
    }
  }

  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate    = true;
  geo.attributes.size.needsUpdate     = true;
}


// ═════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC: MenuScene3D
// ═════════════════════════════════════════════════════════════════════════════
export class MenuScene3D {
  constructor() {
    this.renderer = null;
    this.scene    = null;
    this.camera   = null;
    this._raf     = null;
    this._clock   = new THREE.Clock(false);
    this._running = false;
    this._weldPos = new THREE.Vector3();
    this._weldLight = null;
    this._sparkSystem = null;
    this._orbitAngle = 0;
    this._pivot   = null;       // scene root that orbits
  }

  /**
   * Initialise the 3D scene into the given canvas element.
   * @param {HTMLCanvasElement} canvas
   */
  init(canvas) {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    const aspect = canvas.clientWidth / canvas.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 200);
    this.camera.position.set(3.5, 1.5, 2.5);
    this.camera.lookAt(0, 0.2, 0);

    // ── Lighting ──
    // Sun (strong directional)
    const sun = new THREE.DirectionalLight(0xfff8ec, 2.5);
    sun.position.set(5, 3, 4);
    this.scene.add(sun);

    // Fill (cool blue from opposite side)
    const fill = new THREE.DirectionalLight(0x4466cc, 0.4);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    // Ambient
    this.scene.add(new THREE.AmbientLight(0x222244, 0.35));

    // Weld arc flash — slightly wider range so it reaches the gold visor
    this._weldLight = new THREE.PointLight(0x88aaff, 0.25, 0.55);
    this._weldLight.position.set(0, 0, 0); // updated each frame
    this.scene.add(this._weldLight);

    // ── Build scene objects ──
    const mat = makeMaterials();

    // Orbit pivot — everything rotates around this
    this._pivot = new THREE.Group();
    this.scene.add(this._pivot);

    // Satellite
    const sat = buildSatellite(mat);
    this._pivot.add(sat);

    // Astronaut — positioned to the right of weld (lower Z) so welding arm reaches at ~20° angle
    const astro = buildAstronaut(mat);
    // Moved anatomical-left (z += 0.10) — user confirmed tool still short of weld
    astro.position.set(M * 0.97, -M * 0.24, M * 0.63);
    astro.rotation.y = -Math.PI / 2;   // local +Z → world -X (chest toward satellite)
    astro.rotation.z = 0.08;           // subtle micro-g tilt
    this._pivot.add(astro);

    // Weld at front end-cap of barrel: z = BUS_LEN*0.5 = 1.0, x = BUS_R = 0.40
    this._weldPos.set(BUS_R, M * 0.12, BUS_LEN * 0.5);

    // Spark system
    this._sparkSystem = buildSparkSystem();
    this._pivot.add(this._sparkSystem.points);

    // Handle resize
    this._resizeHandler = () => this._onResize(canvas);
    window.addEventListener('resize', this._resizeHandler);
    this._onResize(canvas);
  }

  /** Start the render + animation loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    this._tick();
  }

  /** Stop the render loop (paused). */
  stop() {
    this._running = false;
    this._clock.stop();
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  /** Clean up WebGL resources. */
  dispose() {
    this.stop();
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }

  // ── Private ──

  _tick() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._tick());

    const dt = Math.min(this._clock.getDelta(), 0.05); // cap for tab-away
    this._orbitAngle += dt * 0.12;  // slow orbit

    // Orbit camera around scene
    const orbitR = 4.2;
    const camY = 1.0 + Math.sin(this._orbitAngle * 0.5) * 0.4;
    this.camera.position.set(
      Math.cos(this._orbitAngle) * orbitR,
      camY,
      Math.sin(this._orbitAngle) * orbitR,
    );
    this.camera.lookAt(0, 0.1, 0);

    // Weld light flicker — arc welding pulse: mostly steady with occasional spikes
    if (this._weldLight) {
      this._weldLight.position.copy(this._weldPos);
      const base  = 0.20 + Math.random() * 0.10;
      // More frequent bright spikes — visor catches arc flashes
      const spike = Math.random() < 0.18 ? (0.8 + Math.random() * 1.8) : 0.0;
      this._weldLight.intensity = base + spike;
    }

    // Sparks
    if (this._sparkSystem) {
      updateSparks(this._sparkSystem, this._weldPos, dt);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _onResize(canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

export default MenuScene3D;
