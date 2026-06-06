/**
 * MenuScene3D.js — 3D hero scene for the menu screen.
 * Shows an EVA astronaut repairing the V5 Crossbow mother satellite,
 * with welding sparks and a slow orbiting camera.
 *
 * Self-contained second WebGL context — independent of the game renderer.
 * @module ui/MenuScene3D
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Constants } from '../core/Constants.js';   // FIX_PLAN §2-followup — RENDER_ORDER enum

// ─── Constants (mirror key OCTOPUS_V5 values so the menu hero reads as the
//     SAME spacecraft the player flies — see PlayerSatellite / Constants.OCTOPUS_V5) ─
const M         = 1;          // scale factor (1 unit = 1 metre)
const BUS_LEN   = 2.0 * M;   // CORE_LENGTH — barrel length (2.0 m)
const BUS_R     = 0.4 * M;   // COLLAR_RADIUS — barrel radius (0.40 m, 0.8 m across)
const COLLAR_Y  = 0.90 * M;  // COLLAR_Y — collar plane offset from bus centre
const ROSA_W    = 1.0 * M;   // ROSA_WIDTH — wing extension per side
const ROSA_L    = 2.0 * M;   // ROSA_LENGTH — panel chord
const ROSA_CH   = 0.30 * M;  // ROSA_CHAMFER — outboard tip chamfer
const STRUT_LEN = 1.20 * M;  // crossbow strut reach (trimmed from sim's 1.6 m for a tidy hero frame)
// Crossbow strut azimuths (deg) — matches Constants.ARM_LADDER.Y0_QUAD.
const STRUT_AZ  = [60, 120, 240, 300];
// ROSA wings live at ±Y (top/bottom) in the menu so the welding astronaut on the
// +X hull stays clear of the wing roots. (In sim the wings sit at 0°/180°; the
// satellite is simply rolled 90° about its long axis for this hero shot.)
const ROSA_AZ   = [90, 270];

const SPARK_COUNT = 70;
const SPARK_SPEED = 2.80;     // fast — sparks streak away before accumulating
const SPARK_LIFE  = 0.45;     // short — die quickly for crisp look

// ─── Space backdrop ─────────────────────────────────────────────────────────
// Vertical gradient used as an OPAQUE scene background: a faint blue glow up top
// fading to near-black below. Opaque so the bloom pass composites cleanly and
// the canvas works as a full-bleed hero plate behind the menu UI.
function makeSpaceGradient() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#0a1a3a');   // upper space haze
  grad.addColorStop(0.45, '#050d22');
  grad.addColorStop(1.0, '#01030a');   // deep shadow below
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── Starfield ──────────────────────────────────────────────────────────────
// Distant stars on a large shell — adds depth/parallax behind the ship as the
// camera sways. Slightly varied warm/cool tints; brightest ones catch the bloom.
function buildStarfield() {
  const N = 1400;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 60 + Math.random() * 40;
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3]     = r * s * Math.cos(t);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(t);
    // Most stars dim; a few bright. Power curve biases toward faint.
    const w = Math.pow(Math.random(), 2.2) * 1.1 + 0.15;
    const tint = Math.random();
    col[i * 3]     = w * (0.82 + 0.18 * tint);
    col[i * 3 + 1] = w * 0.9;
    col[i * 3 + 2] = w * (0.9 + 0.1 * (1 - tint));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 0.5, sizeAttenuation: true, vertexColors: true,
    transparent: true, depthWrite: false,
  });
  const pts = new THREE.Points(g, m);
  pts.name = 'Starfield';
  return pts;
}

// ─── Soft additive glow sprite (weld pool / hot spot) ───────────────────────
function makeGlowSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0,  'rgba(255,244,214,1)');
  grad.addColorStop(0.28, 'rgba(255,170,70,0.85)');
  grad.addColorStop(0.7,  'rgba(255,110,30,0.25)');
  grad.addColorStop(1.0,  'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({
    map: tex, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0,
  });
  return new THREE.Sprite(m);
}

// ─── Material palette ────────────────────────────────────────────────────────
// Spacecraft materials mirror PlayerSatellite._buildModel so the hero ship reads
// as the real Mother: GOLD MLI blanket body, dark GaAs cells, copper FEEP nozzles.
function makeMaterials() {
  return {
    // Body shell = gold MLI thermal blanket (matches PlayerSatellite._matGoldMLI)
    goldMLI:  new THREE.MeshStandardMaterial({ color: 0xd6a43e, metalness: 0.85, roughness: 0.28,
                emissive: 0x4a3008, emissiveIntensity: 0.16 }),
    // Darker gold "tape" for MLI quilting seams
    mliSeam:  new THREE.MeshStandardMaterial({ color: 0x8a6d24, metalness: 0.7, roughness: 0.5 }),
    // Structural plates (end caps / optics bench / thruster deck) — dark metal
    cap:      new THREE.MeshStandardMaterial({ color: 0x4a4a52, metalness: 0.7, roughness: 0.5 }),
    dark:     new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.6, roughness: 0.4 }),
    // Anodized 7075 collar / rings (matches PlayerSatellite collarMat)
    collar:   new THREE.MeshStandardMaterial({ color: 0x8888a0, metalness: 0.75, roughness: 0.28 }),
    strut:    new THREE.MeshStandardMaterial({ color: 0x9090a8, metalness: 0.7, roughness: 0.32 }),
    strutRing:new THREE.MeshStandardMaterial({ color: 0xaabbcc, metalness: 0.85, roughness: 0.18 }),
    // Dark GaAs solar cells (ROSA front + body-mount), bluish
    solar:    new THREE.MeshStandardMaterial({ color: 0x0a1133, metalness: 0.4, roughness: 0.5,
                emissive: 0x0a0a40, emissiveIntensity: 0.15, side: THREE.DoubleSide }),
    // ROSA Kapton substrate back
    solarBack:new THREE.MeshStandardMaterial({ color: 0xccccdd, metalness: 0.3, roughness: 0.4,
                emissive: 0xccccdd, emissiveIntensity: 0.35, side: THREE.DoubleSide }),
    // Copper/bronze FEEP nozzle (matches PlayerSatellite._matFEEP)
    feep:     new THREE.MeshStandardMaterial({ color: 0x996644, metalness: 0.8, roughness: 0.35 }),
    rcs:      new THREE.MeshStandardMaterial({ color: 0x555566, metalness: 0.65, roughness: 0.45 }),
    // Glowing laser aperture / sensor glass
    aperture: new THREE.MeshStandardMaterial({ color: 0x112244, metalness: 0.3, roughness: 0.2,
                emissive: 0x1133aa, emissiveIntensity: 0.5 }),

    // ── EVA suit (NASA EMU) — mostly soft white TMG fabric; very few bright
    //    metal parts (the bearings are subtle anodized rings, not chrome). ──
    suitWhite: new THREE.MeshStandardMaterial({ color: 0xe9eaec, metalness: 0.0, roughness: 0.95 }),
    suitGray:  new THREE.MeshStandardMaterial({ color: 0xb9bcc4, metalness: 0.0, roughness: 0.9 }),
    // Soft fabric fold/convolute — same family as the suit, slightly shaded so
    // the accordion joints read as cloth, NOT as silver hoops.
    suitFold:  new THREE.MeshStandardMaterial({ color: 0xd5d7dc, metalness: 0.0, roughness: 1.0 }),
    visor:     new THREE.MeshStandardMaterial({ color: 0xc8951f, metalness: 0.95, roughness: 0.08,
                 envMapIntensity: 1.5 }),
    plss:      new THREE.MeshStandardMaterial({ color: 0xdcdce0, metalness: 0.06, roughness: 0.85 }),
    glove:     new THREE.MeshStandardMaterial({ color: 0xc6c7cc, metalness: 0.0, roughness: 0.95 }),
    boot:      new THREE.MeshStandardMaterial({ color: 0xcfd0d5, metalness: 0.0, roughness: 0.92 }),
    bootSole:  new THREE.MeshStandardMaterial({ color: 0x33343a, metalness: 0.1, roughness: 0.8 }),
    // Anodized bearing ring — muted aluminium, NOT chrome (used sparingly)
    suitRing:  new THREE.MeshStandardMaterial({ color: 0xb4b0a6, metalness: 0.35, roughness: 0.6 }),
    tool:      new THREE.MeshStandardMaterial({ color: 0x55565f, metalness: 0.6, roughness: 0.4 }),
    thaiRed:   new THREE.MeshStandardMaterial({ color: 0xed1c24, metalness: 0.0, roughness: 0.9 }),
    thaiBlue:  new THREE.MeshStandardMaterial({ color: 0x003893, metalness: 0.0, roughness: 0.85 }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SATELLITE — "Mother" (Octopus V5 / Config G), faithful to PlayerSatellite.js
//   • gold MLI barrel (2.0 m × 0.8 m) with dark GaAs body cells + quilting seams
//   • anodized collar ring + 4 radial crossbow struts (rib rings, dock nodes)
//   • two chamfered ROSA solar wings (dark cells, gold edge frame)
//   • forward laser aperture (glowing) + gold rim, aft FEEP nozzle cluster
// ═════════════════════════════════════════════════════════════════════════════
const DEG = Math.PI / 180;

// ─── Daughter spacecraft (Weaver / Spinner) ─────────────────────────────────
// Small hex-prism free-flyers the Mother deploys on her crossbow struts
// (faithful to ArmUnit: Weaver 0.2³×0.3 m blue, Spinner 0.1³×0.15 m green —
// solar-cell facets, bare metal caps, an aft FEEP nozzle and a gimbal ring).
function buildDaughter(mat, type = 'weaver') {
  const g = new THREE.Group();
  g.name = `Daughter_${type}`;
  const isW = type === 'weaver';
  const len     = (isW ? 0.30 : 0.18) * M;
  const apothem = (isW ? 0.10 : 0.06) * M;
  const hexR    = apothem / Math.cos(Math.PI / 6);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: isW ? 0x4488aa : 0x88aa44, metalness: 0.6, roughness: 0.4,
    emissive: 0x060614, emissiveIntensity: 0.1,
  });
  const cellMat = new THREE.MeshStandardMaterial({
    color: 0x0a1133, metalness: 0.4, roughness: 0.5,
    emissive: 0x0a0a40, emissiveIntensity: 0.12,
  });

  // Hex prism body (axis along Z after the rotation)
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(hexR, hexR, len, 6, 1, false, Math.PI / 6), bodyMat);
  body.rotation.x = Math.PI / 2;
  g.add(body);

  // Solar-cell facets on 5 of 6 sides (one left as bare metal, like ArmUnit)
  const facetGeo = new THREE.PlaneGeometry(hexR * 0.92, len * 0.9);
  for (let k = 0; k < 6; k++) {
    if (k === 1) continue;
    const az = Math.PI / 6 + k * (Math.PI / 3);
    const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
    const up = new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(up, radial).normalize();
    const facet = new THREE.Mesh(facetGeo, cellMat);
    facet.position.set(radial.x * apothem * 1.02, radial.y * apothem * 1.02, 0);
    facet.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, radial));
    facet.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    g.add(facet);
  }

  // Aft FEEP nozzle + forward gimbal ring (ArmUnit signature)
  const noz = new THREE.Mesh(
    new THREE.CylinderGeometry(hexR * 0.3, hexR * 0.42, len * 0.25, 6, 1, true), mat.feep);
  noz.rotation.x = Math.PI / 2;
  noz.position.z = -len * 0.6;
  g.add(noz);
  const gimbalRing = new THREE.Mesh(
    new THREE.TorusGeometry(hexR * 0.5, hexR * 0.09, 6, 10), mat.rcs);
  gimbalRing.position.z = len * 0.5;
  g.add(gimbalRing);

  return g;
}

function buildSatellite(mat) {
  const sat = new THREE.Group();
  sat.name = 'MotherSatellite';

  const RO = Constants.RENDER_ORDER;

  // ── Barrel — gold MLI thermal blanket (the body skin IS the blanket) ──
  const busGeo = new THREE.CylinderGeometry(BUS_R, BUS_R, BUS_LEN, 16, 1, true);
  const bus = new THREE.Mesh(busGeo, mat.goldMLI);
  bus.rotation.x = Math.PI / 2;   // align to Z-forward
  bus.renderOrder = RO.SPACECRAFT_OPAQUE;
  sat.add(bus);

  // ── Structural end caps (dark metal: optics bench fwd / thruster deck aft) ──
  const capGeo = new THREE.CircleGeometry(BUS_R, 16);
  const fCap = new THREE.Mesh(capGeo, mat.cap);
  fCap.position.z = BUS_LEN * 0.5;
  fCap.renderOrder = RO.SPACECRAFT_OPAQUE;
  sat.add(fCap);
  const rCap = new THREE.Mesh(capGeo, mat.cap);
  rCap.position.z = -BUS_LEN * 0.5;
  rCap.rotation.y = Math.PI;
  rCap.renderOrder = RO.SPACECRAFT_OPAQUE;
  sat.add(rCap);

  // ── Body-mount GaAs solar cells — flat dark panels on the clear facets ──
  // (matches PlayerSatellite: a central tall row + fore/aft rows, skipping the
  //  facets occupied by the ROSA roots and the crossbow struts).
  const FACETS = 16, facetStep = (Math.PI * 2) / FACETS;
  const facetW = 2 * (BUS_R * 1.006) * Math.tan(facetStep / 2);
  const angDist = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };
  const strutRad = STRUT_AZ.map(d => d * DEG);
  const rosaRad  = ROSA_AZ.map(d => d * DEG);
  const cellMat = mat.solar.clone();
  cellMat.side = THREE.FrontSide;
  cellMat.depthWrite = false;
  const pvRows = [
    { z: 0,              h: BUS_LEN * 0.46 },
    { z: BUS_LEN * 0.30, h: BUS_LEN * 0.12 },
    { z: -BUS_LEN * 0.30, h: BUS_LEN * 0.12 },
  ];
  for (let f = 0; f < FACETS; f++) {
    const az = f * facetStep + facetStep / 2;
    // Cull the back hemisphere: the satellite never rotates and the camera only
    // sways across the +X/+Z side, so −X facets are never seen — don't build them.
    if (Math.cos(az) < -0.30) continue;
    if (strutRad.some(s => angDist(az, s) < 18 * DEG)) continue;
    if (rosaRad.some(r => angDist(az, r) < 12 * DEG)) continue;
    const rr = BUS_R * 1.02;
    const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
    const up = new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(up, radial).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, up, radial);
    for (const row of pvRows) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(facetW * 0.9, row.h), cellMat);
      panel.position.set(Math.cos(az) * rr, Math.sin(az) * rr, row.z);
      panel.quaternion.setFromRotationMatrix(basis);
      panel.renderOrder = RO.SPACECRAFT_DETAIL;
      sat.add(panel);
    }
  }

  // ── MLI quilting seams — thin darker-gold tape rings dividing the blanket ──
  const seamGeo = new THREE.TorusGeometry(BUS_R * 1.006, M * 0.006, 4, 24);
  for (const z of [-BUS_LEN * 0.40, -BUS_LEN * 0.23, BUS_LEN * 0.23, BUS_LEN * 0.40]) {
    const seam = new THREE.Mesh(seamGeo, mat.mliSeam);
    seam.position.z = z;
    seam.rotation.x = Math.PI / 2;
    seam.renderOrder = RO.SPACECRAFT_DETAIL;
    sat.add(seam);
  }

  // ── Forward laser aperture (glowing) + gold rim ──
  const aperture = new THREE.Mesh(new THREE.CircleGeometry(M * 0.12, 16), mat.aperture);
  aperture.position.set(0, 0, BUS_LEN * 0.5 + M * 0.006);
  aperture.renderOrder = RO.SPACECRAFT_DETAIL;
  sat.add(aperture);
  const apRing = new THREE.Mesh(new THREE.RingGeometry(M * 0.12, M * 0.16, 16), mat.goldMLI);
  apRing.position.set(0, 0, BUS_LEN * 0.5 + M * 0.010);
  apRing.renderOrder = RO.SPACECRAFT_DETAIL;
  sat.add(apRing);

  // ── Collar ring (anodized) at the +Z end ──
  const collar = new THREE.Mesh(new THREE.TorusGeometry(BUS_R * 1.03, M * 0.018, 8, 32), mat.collar);
  collar.rotation.x = Math.PI / 2;
  collar.position.z = COLLAR_Y;
  collar.renderOrder = RO.SPACECRAFT_DETAIL;
  sat.add(collar);

  // ── Crossbow struts — radial tubes from the collar, faithful to
  //    PlayerSatellite._buildStruts: hinge, root collar, rib rings, tip dock
  //    collar + node, and a tether reel cartridge with status LED. One strut
  //    carries a docked Weaver daughter (the struts exist to deploy daughters). ──
  const strutTube  = new THREE.CylinderGeometry(M * 0.025, M * 0.025, STRUT_LEN, 8);
  const ribGeo     = new THREE.TorusGeometry(M * 0.030, M * 0.008, 6, 12);
  const dockNode   = new THREE.SphereGeometry(M * 0.045, 8, 6);
  const hingeGeo   = new THREE.BoxGeometry(M * 0.07, M * 0.06, M * 0.06);
  const rootColGeo = new THREE.CylinderGeometry(M * 0.045, M * 0.045, M * 0.09, 10);
  const tipColGeo  = new THREE.CylinderGeometry(M * 0.038, M * 0.038, M * 0.06, 10);
  const reelGeo    = new THREE.BoxGeometry(M * 0.055, M * 0.07, M * 0.045);
  for (const azDeg of STRUT_AZ) {
    const az = azDeg * DEG;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(az) * BUS_R, Math.sin(az) * BUS_R, COLLAR_Y);
    // local -Y → radial outward
    pivot.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(Math.cos(az), Math.sin(az), 0));

    const hinge = new THREE.Mesh(hingeGeo, mat.collar);
    hinge.renderOrder = RO.SPACECRAFT_DETAIL;
    pivot.add(hinge);

    // Root joint collar (just outboard of the hinge)
    const rootCol = new THREE.Mesh(rootColGeo, mat.collar);
    rootCol.position.y = -M * 0.07;
    rootCol.renderOrder = RO.SPACECRAFT_DETAIL;
    pivot.add(rootCol);

    const strut = new THREE.Mesh(strutTube, mat.strut);
    strut.position.y = -STRUT_LEN * 0.5;
    pivot.add(strut);

    for (const frac of [0.3, 0.55, 0.8]) {
      const ring = new THREE.Mesh(ribGeo, mat.strutRing);
      ring.position.y = -STRUT_LEN * frac;
      ring.rotation.x = Math.PI / 2;
      ring.renderOrder = RO.SPACECRAFT_DETAIL;
      pivot.add(ring);
    }

    // Tether reel cartridge (+ green status LED) near the tip
    const reel = new THREE.Mesh(reelGeo, mat.cap);
    reel.position.set(M * 0.05, -STRUT_LEN * 0.82, 0);
    reel.renderOrder = RO.SPACECRAFT_DETAIL;
    pivot.add(reel);
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(M * 0.009, 5, 5),
      new THREE.MeshBasicMaterial({ color: 0x33ff66 }));
    led.position.set(M * 0.08, -STRUT_LEN * 0.82, 0);
    pivot.add(led);

    // Tip dock collar + node
    const tipCol = new THREE.Mesh(tipColGeo, mat.collar);
    tipCol.position.y = -STRUT_LEN + M * 0.03;
    tipCol.renderOrder = RO.SPACECRAFT_DETAIL;
    pivot.add(tipCol);
    const node = new THREE.Mesh(dockNode, mat.collar);
    node.position.y = -STRUT_LEN;
    pivot.add(node);

    sat.add(pivot);

    // Docked Weaver daughter on the upper-right strut (visible to the camera).
    if (azDeg === 60) {
      const daughter = buildDaughter(mat, 'weaver');
      const outDist = BUS_R + STRUT_LEN + M * 0.17;
      daughter.position.set(Math.cos(az) * outDist, Math.sin(az) * outDist, COLLAR_Y);
      // Body long-axis (Z) along the strut radial → docked aft-to-tip, nose out.
      daughter.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(Math.cos(az), Math.sin(az), 0));
      sat.add(daughter);
    }
  }

  // ── ROSA solar wings — chamfered dark-cell panels with gold edge frame ──
  // Built spanning local X (width) × local Z (chord), then oriented to each azimuth.
  const halfL = ROSA_L / 2;
  const shape = new THREE.Shape();
  shape.moveTo(ROSA_CH, -halfL);
  shape.lineTo(ROSA_W - ROSA_CH, -halfL);
  shape.lineTo(ROSA_W, -halfL + ROSA_CH);
  shape.lineTo(ROSA_W, halfL);
  shape.lineTo(0, halfL);
  shape.lineTo(0, -halfL + ROSA_CH);
  shape.closePath();
  const wingGeo = new THREE.ShapeGeometry(shape);
  const edgeGeo = new THREE.EdgesGeometry(wingGeo, 1);
  const goldEdgeMat = new THREE.LineBasicMaterial({ color: 0xccaa44 });
  const gridMat = new THREE.MeshBasicMaterial({
    color: 0x2244aa, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false });

  for (const azDeg of ROSA_AZ) {
    const az = azDeg * DEG;
    const wing = new THREE.Group();
    // Root sits on the barrel surface. Both wings are COPLANAR (in the Y-Z plane
    // through the axis) with their CELL faces pointing the SAME way (+X = sun &
    // camera) — exactly like the real ROSA pair. Previously each wing's normal was
    // the local tangent, which flipped ±X between the two sides, so the bottom
    // wing presented its gray substrate to the camera (the "one gray panel" bug).
    //   local X (width)  → radial outward (cos az, sin az, 0)
    //   local Y (chord)  → ±Z  (keeps the basis right-handed)
    //   local Z (normal) → +X  (cell face toward the sun / camera)
    wing.position.set(Math.cos(az) * BUS_R, Math.sin(az) * BUS_R, 0);
    const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
    const normal = new THREE.Vector3(1, 0, 0);
    const chord  = new THREE.Vector3(0, 0, Math.sin(az));   // +Z for +Y wing, −Z for −Y wing
    wing.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(radial, chord, normal));

    const front = new THREE.Mesh(wingGeo, mat.solar);
    front.renderOrder = RO.SPACECRAFT_OPAQUE;
    wing.add(front);
    // (Kapton-substrate back mesh removed — both wings face their cells at the
    //  camera, so the −X back is never seen.)
    const edge = new THREE.LineSegments(edgeGeo, goldEdgeMat);
    edge.position.z = 0.002;
    edge.renderOrder = RO.SPACECRAFT_DETAIL;
    wing.add(edge);
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(ROSA_W * 0.95, ROSA_L * 0.92, 9, 20), gridMat);
    grid.position.set(ROSA_W * 0.5, 0, 0.003);
    grid.renderOrder = RO.SPACECRAFT_TRANSPARENT;
    wing.add(grid);

    // Tensioning spreader bar at the wing tip + root yoke (ISS ROSA signature).
    const barGeo = new THREE.CylinderGeometry(M * 0.018, M * 0.018, ROSA_L, 6);
    const tipBar = new THREE.Mesh(barGeo, mat.strut);
    tipBar.position.set(ROSA_W, 0, 0);   // local Y = chord → bar spans the tip
    tipBar.renderOrder = RO.SPACECRAFT_DETAIL;
    wing.add(tipBar);
    const rootYoke = new THREE.Mesh(barGeo, mat.collar);
    rootYoke.position.set(0, 0, 0);
    rootYoke.scale.set(1, 0.96, 1);
    rootYoke.renderOrder = RO.SPACECRAFT_DETAIL;
    wing.add(rootYoke);

    // Roll-out spool at the wing root
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(M * 0.04, M * 0.04, ROSA_L, 8), mat.dark);
    roll.position.set(Math.cos(az) * (BUS_R + M * 0.04), Math.sin(az) * (BUS_R + M * 0.04), 0);
    roll.rotation.x = Math.PI / 2;
    sat.add(roll);

    sat.add(wing);
  }

  // ── Aft FEEP thruster cluster (4 copper nozzles in a cross) ──
  const nozzleGeo = new THREE.CylinderGeometry(M * 0.03, M * 0.06, M * 0.15, 8, 1, true);
  for (const [x, y] of [[0, 0.2], [0, -0.2], [0.2, 0], [-0.2, 0]]) {
    const nz = new THREE.Mesh(nozzleGeo, mat.feep);
    nz.position.set(x * M, y * M, -BUS_LEN * 0.5 - M * 0.06);
    nz.rotation.x = Math.PI / 2;
    nz.renderOrder = RO.SPACECRAFT_DETAIL;
    sat.add(nz);
  }

  // ── Nav lights (port red / starboard green) on the clear ±X sides ──
  const navGeo = new THREE.SphereGeometry(M * 0.022, 6, 6);
  const portLight = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: 0xff2222 }));
  portLight.position.set(-BUS_R - M * 0.02, 0, M * 0.3);
  sat.add(portLight);
  const starLight = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: 0x22ff22 }));
  starLight.position.set(BUS_R + M * 0.02, 0, M * 0.3);
  sat.add(starLight);

  // ── FEEP nozzle throats — faint emissive interior discs (depth in the cluster) ──
  const throatGeo = new THREE.CircleGeometry(M * 0.026, 10);
  const throatMat = new THREE.MeshBasicMaterial({ color: 0x5577bb, side: THREE.DoubleSide });
  for (const [x, y] of [[0, 0.2], [0, -0.2], [0.2, 0], [-0.2, 0]]) {
    const th = new THREE.Mesh(throatGeo, throatMat);
    th.position.set(x * M, y * M, -BUS_LEN * 0.5 - M * 0.13);
    th.renderOrder = RO.SPACECRAFT_DETAIL;
    sat.add(th);
  }

  // ── RCS attitude-thruster nubs — 8, on the diagonals (clear of wings/struts) ──
  const rcsGeo = new THREE.CylinderGeometry(M * 0.017, M * 0.030, M * 0.055, 6, 1, true);
  for (let q = 0; q < 4; q++) {
    const a = q * Math.PI / 2 + Math.PI / 4;
    const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    for (const zc of [BUS_LEN * 0.32, -BUS_LEN * 0.32]) {
      const nub = new THREE.Mesh(rcsGeo, mat.rcs);
      nub.position.set(radial.x * BUS_R, radial.y * BUS_R, zc);
      nub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), radial);
      nub.renderOrder = RO.SPACECRAFT_DETAIL;
      sat.add(nub);
    }
  }

  // ── Forward sensor gimbal — EO camera / IR / LIDAR turret (faithful to
  //    PlayerSatellite._buildSensors). Sits on the +X/+Y front quadrant: this
  //    is the unit the EVA astronaut is servicing. ──
  const gimbal = new THREE.Group();
  gimbal.position.set(M * 0.10, M * 0.20, BUS_LEN * 0.5 + M * 0.02);
  const basePlate = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.17, M * 0.17, M * 0.04, 10), mat.cap);
  basePlate.rotation.x = Math.PI / 2;
  basePlate.renderOrder = RO.SPACECRAFT_DETAIL;
  gimbal.add(basePlate);
  // EO camera (dark lens cylinder)
  const eoCam = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.06, M * 0.06, M * 0.16, 10), mat.dark);
  eoCam.rotation.x = Math.PI / 2;
  eoCam.position.set(M * 0.07, 0, M * 0.08);
  gimbal.add(eoCam);
  const eoLens = new THREE.Mesh(new THREE.CircleGeometry(M * 0.05, 12), mat.aperture);
  eoLens.position.set(M * 0.07, 0, M * 0.165);
  eoLens.renderOrder = RO.SPACECRAFT_DETAIL;
  gimbal.add(eoLens);
  // IR sensor (gold-foil box)
  const irBox = new THREE.Mesh(new THREE.BoxGeometry(M * 0.11, M * 0.09, M * 0.11), mat.goldMLI);
  irBox.position.set(-M * 0.08, 0, M * 0.07);
  gimbal.add(irBox);
  // LIDAR dome + green pulse light
  const lidar = new THREE.Mesh(
    new THREE.SphereGeometry(M * 0.055, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat.collar);
  lidar.position.set(0, M * 0.085, M * 0.09);
  gimbal.add(lidar);
  const lidarLight = new THREE.Mesh(
    new THREE.SphereGeometry(M * 0.02, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0x00ff44 }));
  lidarLight.position.set(0, M * 0.115, M * 0.10);
  gimbal.add(lidarLight);
  sat.add(gimbal);

  // (Docking port omitted — it lives on the −X face, away from the camera, and
  //  is never visible in this fixed hero framing.)

  return sat;
}


// ═════════════════════════════════════════════════════════════════════════════
// ASTRONAUT — procedural EVA suit (NASA EMU inspired)
// ═════════════════════════════════════════════════════════════════════════════

// Bulky EVA glove modelled as a fist GRIPPING a tool handle. The handle is
// assumed to run vertically (local Y) through the palm, offset forward (+Z);
// four curled fingers wrap over the front and an opposed thumb closes the grip.
// `thumbSide` = +1 / −1 selects which side the thumb sits (left vs right hand).
function buildGrippingGlove(mat, thumbSide) {
  const g = new THREE.Group();
  // Palm / back-of-hand mass
  const palm = new THREE.Mesh(new THREE.SphereGeometry(M * 0.05, 10, 8), mat.glove);
  palm.scale.set(1.05, 0.92, 1.12);
  g.add(palm);
  // Knuckle ridge across the back of the hand
  const knuckles = new THREE.Mesh(
    new THREE.CapsuleGeometry(M * 0.016, M * 0.06, 3, 6), mat.glove);
  knuckles.rotation.z = Math.PI / 2;          // lie across the hand (local X)
  knuckles.position.set(0, M * 0.018, M * 0.03);
  g.add(knuckles);
  // Four curled fingers wrapping the front of the vertical handle — each a
  // horizontal capsule (across the grip), stacked down local Y like a real fist.
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(M * 0.0115, M * 0.034, 3, 6), mat.glove);
    f.rotation.z = Math.PI / 2;               // capsule axis → local X (across handle)
    f.position.set(0, M * (0.032 - i * 0.019), M * 0.05);
    g.add(f);
  }
  // Opposed thumb closing over the handle from the side
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(M * 0.015, M * 0.036, 3, 6), mat.glove);
  thumb.position.set(thumbSide * M * 0.042, -M * 0.008, M * 0.036);
  thumb.rotation.set(0.7, 0, thumbSide * 0.9);
  g.add(thumb);
  return g;
}

function buildAstronaut(mat) {
  const astro = new THREE.Group();
  astro.name = 'EVAAstronaut';

  // Soft-goods convolute folds — the ribbed FABRIC joints of a pressure suit.
  // Broad, low-relief, and the same off-white cloth as the suit so they read as
  // accordion fabric, NOT shiny hoops. Tube radius scales with the limb so the
  // fold sits just proud of the surface.
  const addConvolutes = (parent, count, yTop, yBot, radius) => {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, M * 0.016, 6, 16), mat.suitFold);
      ring.position.y = yTop + (yBot - yTop) * t;
      ring.rotation.x = Math.PI / 2;
      ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      parent.add(ring);
    }
  };

  // ── Helmet — realistic NASA EMU bubble (≈ 0.32 m dia, true human proportion) ──
  // Anthropometric target: ~1.85 m suited astronaut. Shoulders (arm roots) sit
  // at y=0.50; the helmet centre rides ~0.22 m above that on a short neck.
  const helmetGeo = new THREE.SphereGeometry(M * 0.16, 18, 16);
  const helmet = new THREE.Mesh(helmetGeo, mat.suitWhite);
  helmet.position.y = M * 0.72;
  helmet.scale.set(1.0, 1.04, 1.08);   // slightly deeper front-back (EMU bubble)
  astro.add(helmet);

  // Gold sun visor — reflective shield over the front hemisphere of the helmet.
  // Hemisphere dome faces local +Z by default → R_y(-π/2) → world -X (toward Mother) ✓
  const visorGeo = new THREE.SphereGeometry(M * 0.165, 18, 14,
    0, Math.PI, 0, Math.PI * 0.74);
  const visorMat = mat.visor.clone();
  visorMat.polygonOffset = true;
  visorMat.polygonOffsetFactor = -2;
  visorMat.polygonOffsetUnits  = -2;
  const visor = new THREE.Mesh(visorGeo, visorMat);
  visor.position.y = M * 0.72;
  visor.scale.set(1.06, 1.05, 1.10);   // wrap just outside the helmet shell
  visor.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(visor);
  // Expose so the render loop can flash the visor when the weld arc strikes.
  astro.userData.visorMat = visorMat;

  // EVA lights / antenna boss on top of helmet (TV camera assembly)
  const camBoss = new THREE.Mesh(
    new THREE.BoxGeometry(M * 0.10, M * 0.04, M * 0.06), mat.suitGray);
  camBoss.position.set(0, M * 0.86, -M * 0.02);
  astro.add(camBoss);
  // Twin helmet floodlights (front of the camera boss) + lenses
  for (const lx of [-M * 0.065, M * 0.065]) {
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.015, M * 0.015, M * 0.03, 8), mat.suitGray);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(lx, M * 0.85, M * 0.11);
    astro.add(lamp);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(M * 0.012, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff2cc }));
    lens.position.set(lx, M * 0.85, M * 0.126);
    lens.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    astro.add(lens);
  }

  // Neck pressure ring (connects helmet to HUT)
  const neckRing = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.105, M * 0.018, 8, 20), mat.suitRing);
  neckRing.position.y = M * 0.555;
  neckRing.rotation.x = Math.PI / 2;
  astro.add(neckRing);

  // ── Torso (HUT — Hard Upper Torso) — wide shoulders tapering to waist ──
  const hutGeo = new THREE.CylinderGeometry(M * 0.235, M * 0.185, M * 0.34, 14);
  const hut = new THREE.Mesh(hutGeo, mat.suitWhite);
  hut.position.y = M * 0.39;
  astro.add(hut);
  // (DCM chest module, knobs and gauge removed — they sit on the −X chest face,
  //  which points at the Mother and is never visible to the camera.)

  // ── PLSS backpack (Primary Life Support System) — tall slab behind the HUT ──
  // Real EMU PLSS ≈ 0.80 × 0.58 × 0.25 m. Defines the bulky EVA silhouette.
  const plssGeo = new THREE.BoxGeometry(M * 0.44, M * 0.56, M * 0.24);
  const plss = new THREE.Mesh(plssGeo, mat.plss);
  plss.position.set(0, M * 0.42, -M * 0.205);
  astro.add(plss);
  // PLSS upper cover + lower SOP detail strips
  const plssTop = new THREE.Mesh(new THREE.BoxGeometry(M * 0.42, M * 0.05, M * 0.22), mat.suitGray);
  plssTop.position.set(0, M * 0.70, -M * 0.205);
  astro.add(plssTop);
  const plssBot = new THREE.Mesh(new THREE.BoxGeometry(M * 0.40, M * 0.06, M * 0.20), mat.suitGray);
  plssBot.position.set(0, M * 0.15, -M * 0.205);
  astro.add(plssBot);

  // ── PLSS surface detail (back face at z ≈ −0.325) ──
  const plssBackZ = -M * 0.205 - M * 0.12;
  // Recessed central access panel
  const accessPanel = new THREE.Mesh(
    new THREE.BoxGeometry(M * 0.30, M * 0.34, M * 0.015), mat.suitGray);
  accessPanel.position.set(0, M * 0.44, plssBackZ - M * 0.006);
  accessPanel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(accessPanel);
  // Latch tabs down each side of the panel
  for (const sx of [-1, 1]) {
    for (const ly of [0.56, 0.44, 0.32]) {
      const latch = new THREE.Mesh(
        new THREE.BoxGeometry(M * 0.03, M * 0.04, M * 0.03), mat.suitRing);
      latch.position.set(sx * M * 0.17, M * ly, plssBackZ + M * 0.01);
      latch.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      astro.add(latch);
    }
  }
  // Yellow caution-label decal (upper-left of the pack)
  const caution = new THREE.Mesh(
    new THREE.PlaneGeometry(M * 0.10, M * 0.05),
    new THREE.MeshStandardMaterial({ color: 0xd8b021, roughness: 0.7,
      emissive: 0x3a2c00, emissiveIntensity: 0.15 }));
  caution.position.set(-M * 0.10, M * 0.62, plssBackZ - M * 0.013);
  caution.rotation.y = Math.PI;   // face aft (−Z)
  caution.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(caution);
  // Low-profile UHF antenna stub on the PLSS top
  const antStub = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.006, M * 0.006, M * 0.08, 6), mat.suitGray);
  antStub.position.set(M * 0.15, M * 0.74, -M * 0.26);
  antStub.rotation.x = -0.25;
  astro.add(antStub);

  // ── SAFER (Simplified Aid For EVA Rescue) — the propulsive module that wraps
  //    the base of the PLSS, with thruster pods at the corners. Iconic EVA kit. ──
  const safer = new THREE.Group();
  safer.position.set(0, M * 0.12, -M * 0.30);
  const saferBase = new THREE.Mesh(new THREE.BoxGeometry(M * 0.52, M * 0.10, M * 0.18), mat.suitGray);
  safer.add(saferBase);
  for (const sx of [-1, 1]) {
    // Side tower rising along the lower pack
    const tower = new THREE.Mesh(new THREE.BoxGeometry(M * 0.055, M * 0.22, M * 0.16), mat.suitGray);
    tower.position.set(sx * M * 0.235, M * 0.13, 0);
    safer.add(tower);
    // Thruster pods at top & bottom of each tower
    for (const sy of [-1, 1]) {
      const py = M * (0.13 + sy * 0.12);
      const pod = new THREE.Mesh(new THREE.BoxGeometry(M * 0.06, M * 0.06, M * 0.07), mat.cap);
      pod.position.set(sx * M * 0.255, py, 0);
      safer.add(pod);
      // Outward (±X) nozzle + vertical (±Y) nozzle on each pod
      const nozX = new THREE.Mesh(
        new THREE.CylinderGeometry(M * 0.008, M * 0.013, M * 0.03, 6, 1, true), mat.rcs);
      nozX.rotation.z = Math.PI / 2;
      nozX.position.set(sx * M * 0.29, py, 0);
      safer.add(nozX);
      const nozY = new THREE.Mesh(
        new THREE.CylinderGeometry(M * 0.008, M * 0.013, M * 0.03, 6, 1, true), mat.rcs);
      nozY.position.set(sx * M * 0.255, py + sy * M * 0.04, 0);
      safer.add(nozY);
      const nozZ = new THREE.Mesh(
        new THREE.CylinderGeometry(M * 0.008, M * 0.013, M * 0.03, 6, 1, true), mat.rcs);
      nozZ.rotation.x = Math.PI / 2;
      nozZ.position.set(sx * M * 0.255, py, -M * 0.05);
      safer.add(nozZ);
    }
  }
  safer.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(safer);

  // Oxygen hoses arcing from PLSS to chest
  for (const side of [-1, 1]) {
    const hoseGeo = new THREE.CylinderGeometry(M * 0.016, M * 0.016, M * 0.24, 5);
    const hose = new THREE.Mesh(hoseGeo, mat.suitGray);
    hose.position.set(side * M * 0.10, M * 0.52, -M * 0.04);
    hose.rotation.z = side * 0.28;
    astro.add(hose);
  }

  // ── Lower torso assembly (LTA — brief + hip) ──
  const ltaGeo = new THREE.CylinderGeometry(M * 0.185, M * 0.165, M * 0.22, 14);
  const lta = new THREE.Mesh(ltaGeo, mat.suitWhite);
  lta.position.y = M * 0.11;
  astro.add(lta);

  // Waist bearing ring
  const waist = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.185, M * 0.016, 6, 20), mat.suitRing);
  waist.position.y = M * 0.235;
  waist.rotation.x = Math.PI / 2;
  astro.add(waist);
  // Hip / brief bearing ring
  const hipRing = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.165, M * 0.016, 6, 20), mat.suitRing);
  hipRing.position.y = M * 0.01;
  hipRing.rotation.x = Math.PI / 2;
  astro.add(hipRing);

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

  const armGeo = new THREE.CylinderGeometry(M * 0.078, M * 0.068, M * 0.28, 12);
  const lUpper = new THREE.Mesh(armGeo, mat.suitWhite);
  lUpper.position.y = -M * 0.14;
  lShoulder.add(lUpper);

  // Elbow — soft fabric joint (cloth, not a gray ball)
  const elbowGeo = new THREE.SphereGeometry(M * 0.068, 8, 7);
  const lElbow = new THREE.Mesh(elbowGeo, mat.suitFold);
  lElbow.position.y = -M * 0.28;
  lShoulder.add(lElbow);

  const lForearmGroup = new THREE.Group();
  lForearmGroup.position.y = -M * 0.28;
  lForearmGroup.rotation.z = +0.38;   // moderate inward bend for purposeful hold
  lForearmGroup.rotation.x = +0.05;   // slight forward tilt

  const foreGeo = new THREE.CylinderGeometry(M * 0.066, M * 0.058, M * 0.24, 12);
  const lFore = new THREE.Mesh(foreGeo, mat.suitWhite);
  lFore.position.y = -M * 0.12;
  lForearmGroup.add(lFore);

  // EMU wrist disconnect — subtle anodized ring (not chrome)
  const lWristGeo = new THREE.TorusGeometry(M * 0.062, M * 0.012, 6, 14);
  const lWrist = new THREE.Mesh(lWristGeo, mat.suitRing);
  lWrist.position.y = -M * 0.24;
  lWrist.rotation.x = Math.PI / 2;
  lForearmGroup.add(lWrist);

  // Gripping glove (anatomical right hand) wrapping the secondary tool
  const lHand = buildGrippingGlove(mat, +1);
  lHand.position.y = -M * 0.27;
  lForearmGroup.add(lHand);

  // Secondary utility tool held in the fist (inspection/support role)
  const secToolGeo = new THREE.CylinderGeometry(M * 0.018, M * 0.014, M * 0.16, 6);
  const secTool = new THREE.Mesh(secToolGeo, mat.tool);
  secTool.position.set(0, -M * 0.31, M * 0.05);   // runs through the finger curl
  secTool.rotation.x = +0.18;
  lForearmGroup.add(secTool);
  // Tool head accent (blunt end cap — different from welding tip)
  const secHeadGeo = new THREE.CylinderGeometry(M * 0.022, M * 0.018, M * 0.03, 6);
  const secHead = new THREE.Mesh(secHeadGeo, mat.collar);
  secHead.position.set(0, -M * 0.39, M * 0.063);
  secHead.rotation.x = +0.18;
  lForearmGroup.add(secHead);

  lShoulder.add(lForearmGroup);

  // Soft-goods convolutes on the upper arm + forearm
  // Convolutes ONLY at the elbow joint — a real EMU arm is smooth fabric
  // between the shoulder scye bearing and the wrist disconnect; the accordion
  // folds bunch at the elbow, they don't ladder the whole arm. (Was 5 rings.)
  addConvolutes(lShoulder, 2, -M * 0.20, -M * 0.26, M * 0.073);      // elbow, upper side
  addConvolutes(lForearmGroup, 1, -M * 0.035, -M * 0.035, M * 0.064); // elbow, forearm side
  // Wrist checklist (the iconic EVA cuff checklist) on the forearm
  const cuffList = new THREE.Mesh(new THREE.BoxGeometry(M * 0.055, M * 0.06, M * 0.018), mat.suitWhite);
  cuffList.position.set(-M * 0.05, -M * 0.15, 0);
  cuffList.rotation.y = -0.4;
  cuffList.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  lForearmGroup.add(cuffList);

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

  const rElbow = new THREE.Mesh(elbowGeo.clone(), mat.suitFold);
  rElbow.position.y = -M * 0.28;
  rShoulder.add(rElbow);

  const rForearmGroup = new THREE.Group();
  rForearmGroup.position.y = -M * 0.28;
  rForearmGroup.rotation.z = -0.10;   // slight inward cant
  rForearmGroup.rotation.x = -0.75;   // strong elbow bend — forearm sweeps well forward

  const rFore = new THREE.Mesh(foreGeo.clone(), mat.suitWhite);
  rFore.position.y = -M * 0.12;
  rForearmGroup.add(rFore);

  // EMU wrist disconnect (right) — subtle anodized ring
  const rWristGeo = new THREE.TorusGeometry(M * 0.062, M * 0.012, 6, 14);
  const rWrist = new THREE.Mesh(rWristGeo, mat.suitRing);
  rWrist.position.y = -M * 0.24;
  rWrist.rotation.x = Math.PI / 2;
  rForearmGroup.add(rWrist);

  const rGlove = buildGrippingGlove(mat, -1);
  rGlove.position.y = -M * 0.27;
  rForearmGroup.add(rGlove);

  // Welding tool — gripped in the fist, tip aimed at the satellite hull
  const toolGeo = new THREE.CylinderGeometry(M * 0.012, M * 0.016, M * 0.20, 6);
  const tool = new THREE.Mesh(toolGeo, mat.tool);
  tool.position.set(M * 0.01, -M * 0.32, M * 0.05);  // runs through the finger curl
  tool.rotation.x = -0.30;   // tip angles forward toward surface
  tool.rotation.z =  0.08;   // slight inward tilt matching wrist pronation
  rForearmGroup.add(tool);
  // Glowing tool-tip accent (closest point to weld arc)
  const tipGeo = new THREE.CylinderGeometry(M * 0.008, M * 0.012, M * 0.04, 5);
  const tip = new THREE.Mesh(tipGeo, mat.tool);
  tip.position.set(M * 0.012, -M * 0.43, M * 0.058);
  tip.rotation.x = -0.30;
  tip.rotation.z =  0.08;
  rForearmGroup.add(tip);

  rShoulder.add(rForearmGroup);

  // Soft-goods convolutes on the welding arm + forearm
  addConvolutes(rShoulder, 2, -M * 0.20, -M * 0.26, M * 0.073);      // elbow, upper side
  addConvolutes(rForearmGroup, 1, -M * 0.035, -M * 0.035, M * 0.064); // elbow, forearm side

  astro.add(rShoulder);

  // ── Legs — BAGGY soft-goods (TMG) lower body, not skin-tight tubes. Fat,
  //    near-uniform fabric segments with cloth convolute folds at the joints and
  //    almost no exposed metal. Relaxed, slightly asymmetric micro-g float. ──
  for (const side of [-1, 1]) {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * M * 0.085, M * 0.0, 0);
    legGroup.rotation.z = side * 0.12;                       // splay apart at the hips
    legGroup.rotation.x = side < 0 ? -0.04 : -0.24;          // asymmetric hip flex

    // Soft fabric hip/brief bulge (no shiny bearing on the leg itself)
    const hip = new THREE.Mesh(new THREE.SphereGeometry(M * 0.10, 10, 8), mat.suitWhite);
    hip.scale.set(1.0, 0.85, 1.0);
    legGroup.add(hip);

    // Thigh — fat, near-uniform baggy fabric tube
    const thigh = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.108, M * 0.100, M * 0.42, 14), mat.suitWhite);
    thigh.position.y = -M * 0.22;
    legGroup.add(thigh);

    // Knee — fabric joint (no metal bearing/cap). Shank pivots here.
    const kneeY = -M * 0.43;
    const shankGroup = new THREE.Group();
    shankGroup.position.y = kneeY;
    shankGroup.rotation.x = side < 0 ? 0.55 : 0.28;

    const shin = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.094, M * 0.082, M * 0.40, 14), mat.suitWhite);
    shin.position.y = -M * 0.20;
    shankGroup.add(shin);

    // Calf — fabric bulge on the back of the shank
    const calf = new THREE.Mesh(new THREE.SphereGeometry(M * 0.062, 9, 7), mat.suitWhite);
    calf.scale.set(1.0, 1.5, 0.95);
    calf.position.set(0, -M * 0.13, -M * 0.028);
    shankGroup.add(calf);

    // ── Boot — chunky SOFT-FABRIC overshoe with a dark sole (no metal cuff). A
    //    plantar-flexed foot sub-group gives relaxed, slightly pointed toes. ──
    const bootGroup = new THREE.Group();
    bootGroup.position.set(0, -M * 0.42, 0);
    const ankleSoft = new THREE.Mesh(new THREE.SphereGeometry(M * 0.072, 10, 8), mat.boot);
    ankleSoft.scale.set(1.0, 0.9, 1.05);
    bootGroup.add(ankleSoft);

    const footGroup = new THREE.Group();          // plantar-flex pivot at the ankle
    footGroup.rotation.x = side < 0 ? 0.40 : 0.22; // relaxed pointed toes (asymmetric)
    const bootBody = new THREE.Mesh(new THREE.SphereGeometry(M * 0.072, 10, 8), mat.boot);
    bootBody.scale.set(1.05, 0.9, 1.5);
    bootBody.position.set(0, -M * 0.03, M * 0.07);
    footGroup.add(bootBody);
    const toe = new THREE.Mesh(new THREE.SphereGeometry(M * 0.06, 9, 7), mat.boot);
    toe.scale.set(1.0, 0.8, 1.2);
    toe.position.set(0, -M * 0.03, M * 0.17);
    footGroup.add(toe);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(M * 0.115, M * 0.03, M * 0.27), mat.bootSole);
    sole.position.set(0, -M * 0.082, M * 0.075);
    sole.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    footGroup.add(sole);
    bootGroup.add(footGroup);
    shankGroup.add(bootGroup);

    // Cloth convolute folds bunched at the knee joint (broad, soft, NO metal)
    addConvolutes(legGroup,   2, -M * 0.35, -M * 0.42, M * 0.101);  // lower thigh → knee
    addConvolutes(shankGroup, 2, -M * 0.02, -M * 0.09, M * 0.093);  // knee → upper shin
    addConvolutes(shankGroup, 1, -M * 0.36, -M * 0.36, M * 0.083);  // ankle

    // Single dark restraint line down the thigh front (subtle webbing, not chrome)
    const tCable = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.005, M * 0.005, M * 0.30, 4), mat.bootSole);
    tCable.position.set(0, -M * 0.22, M * 0.103);
    tCable.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    legGroup.add(tCable);

    // Red EV-crew identification stripe on the thigh (NASA EV1 marking)
    const idStripe = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.112, M * 0.106, M * 0.055, 14, 1, true), mat.thaiRed);
    idStripe.position.y = -M * 0.27;
    idStripe.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    legGroup.add(idStripe);

    legGroup.add(shankGroup);
    astro.add(legGroup);
  }

  // ── Thai flag — curved shoulder patch wrapped onto the left upper arm ──
  // Proportions R:W:B:W:R = 1:1:2:1:1 (6 units). Built as concentric cylinder
  // SEGMENTS so the patch hugs the arm instead of floating as a flat decal.
  const flagH = M * 0.085;
  const fu    = flagH / 6;
  const armR  = M * 0.076;                  // upper-arm radius near the patch (fattened arm)
  const arc   = 1.6;                         // ~92° wrap, centred on the outer (−X) face
  const flagGroup = new THREE.Group();
  flagGroup.position.y = -M * 0.12;
  const wrapBand = (material, yc, h, r, a, bias) => {
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, h, 16, 1, true, 3 * Math.PI / 2 - a / 2, a), material);
    seg.position.y = yc;
    seg.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL + bias;
    flagGroup.add(seg);
  };
  // Dark border (slightly taller + wider arc, just beneath the flag field)
  wrapBand(new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 1, side: THREE.DoubleSide }),
           0, flagH + M * 0.012, armR * 0.996, arc * 1.14, 0);
  // White field
  wrapBand(new THREE.MeshStandardMaterial({ color: 0xf2f2f4, roughness: 0.85, side: THREE.DoubleSide }),
           0, flagH, armR * 1.002, arc, 1);
  // Red top + bottom stripes (1 unit each)
  wrapBand(mat.thaiRed, +2.5 * fu, fu, armR * 1.004, arc, 2);
  wrapBand(mat.thaiRed, -2.5 * fu, fu, armR * 1.004, arc, 2);
  // Blue centre band (2 units)
  wrapBand(mat.thaiBlue, 0, 2 * fu, armR * 1.004, arc, 2);
  lShoulder.add(flagGroup);   // child of arm group — rotates with the arm

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
    this._composer = null;      // EffectComposer (bloom)
    this._bloom    = null;      // UnrealBloomPass
    this._envRT    = null;      // PMREM environment render target
    this._canvas   = null;      // canvas ref (for resize-on-show)
    this._resizeObserver = null;
    this._weldGlow = null;      // molten weld-pool glow sprite
    this._visorMat = null;      // visor material (flashes with the arc)
  }

  /**
   * Initialise the 3D scene into the given canvas element.
   * @param {HTMLCanvasElement} canvas
   */
  init(canvas) {
    this._canvas = canvas;
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Scene
    this.scene = new THREE.Scene();

    // Opaque space backdrop (vertical gradient). An opaque background lets the
    // bloom composite cleanly and turns the canvas into a full-bleed hero plate.
    this.scene.background = makeSpaceGradient();

    // Image-based reflections so the gold MLI hull, gold visor and metal rings
    // read as real specular surfaces (not flat matte). Low intensity keeps the
    // space mood while still catching highlights. Non-fatal: skip on any failure.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this._envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = 0.30;
      pmrem.dispose();
    } catch (err) {
      console.warn('MenuScene3D: environment map skipped:', err);
    }

    // Camera
    const aspect = canvas.clientWidth / canvas.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 200);
    this.camera.position.set(4.2, 1.4, 3.0);
    this.camera.lookAt(0, -0.05, 0);

    // ── Lighting ──
    // Sun (strong directional)
    const sun = new THREE.DirectionalLight(0xfff8ec, 2.5);
    sun.position.set(5, 3, 4);
    this.scene.add(sun);

    // Fill (cool blue from opposite side)
    const fill = new THREE.DirectionalLight(0x4466cc, 0.4);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    // Rim / back light — cool kicker from behind to peel the white EVA suit and
    // gold hull off the dark backdrop (key to a readable hero silhouette).
    const rim = new THREE.DirectionalLight(0xbcd0ff, 1.6);
    rim.position.set(-4, 2.5, -5);
    this.scene.add(rim);

    // Ambient
    this.scene.add(new THREE.AmbientLight(0x223055, 0.35));

    // Weld arc flash — slightly wider range so it reaches the gold visor
    this._weldLight = new THREE.PointLight(0x88aaff, 0.25, 0.55);
    this._weldLight.position.set(0, 0, 0); // updated each frame
    this.scene.add(this._weldLight);

    // ── Build scene objects ──
    const mat = makeMaterials();

    // Distant starfield for depth/parallax (added to scene root, not the orbit
    // pivot, so it reads as a fixed sky behind the slowly-swaying camera).
    this.scene.add(buildStarfield());

    // Orbit pivot — everything rotates around this
    this._pivot = new THREE.Group();
    this.scene.add(this._pivot);

    // Satellite
    const sat = buildSatellite(mat);
    this._pivot.add(sat);

    // Astronaut — human-scale EVA reference welding the +X hull near the front
    // rim. Kept at the tuned weld pose (chest toward the barrel, tool tip at the
    // weld point) so the realistic suit lines up with the arc; the ROSA wings
    // sit at ±Y so this +X working side stays clear.
    const astro = buildAstronaut(mat);
    astro.position.set(M * 0.97, -M * 0.24, M * 0.63);
    astro.rotation.y = -Math.PI / 2;   // local +Z → world -X (chest toward satellite)
    astro.rotation.z = 0.08;           // subtle micro-g tilt
    this._pivot.add(astro);
    this._visorMat = astro.userData.visorMat || null;

    // Weld at front end-cap of barrel: z = BUS_LEN*0.5 = 1.0, x = BUS_R = 0.40
    this._weldPos.set(BUS_R, M * 0.12, BUS_LEN * 0.5);

    // Molten weld-pool glow on the hull — pulses with the arc (see _tick).
    this._weldGlow = makeGlowSprite();
    this._weldGlow.position.copy(this._weldPos);
    this._weldGlow.scale.setScalar(M * 0.22);
    this._pivot.add(this._weldGlow);

    // EVA safety tether — slack line from the astronaut's waist to a hull
    // anchor by the sensor turret (the work site), reinforcing the EVA read.
    astro.updateWorldMatrix(true, false);
    const tetherStart = astro.localToWorld(new THREE.Vector3(0, M * 0.18, -M * 0.05));
    const tetherEnd   = new THREE.Vector3(M * 0.24, M * 0.12, BUS_LEN * 0.5 - M * 0.02);
    const tetherMid   = tetherStart.clone().add(tetherEnd).multiplyScalar(0.5);
    tetherMid.y -= M * 0.22;   // gravity-free slack sag
    tetherMid.x += M * 0.10;
    const tetherCurve = new THREE.CatmullRomCurve3([tetherStart, tetherMid, tetherEnd]);
    const tether = new THREE.Mesh(
      new THREE.TubeGeometry(tetherCurve, 28, M * 0.013, 6, false),
      new THREE.MeshStandardMaterial({ color: 0xd8d8de, metalness: 0.1, roughness: 0.8 }));
    tether.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this._pivot.add(tether);

    // Spark system
    this._sparkSystem = buildSparkSystem();
    this._pivot.add(this._sparkSystem.points);

    // ── Post-processing: bloom so the weld arc, glowing aperture, nav lights
    //    and visor glints actually radiate (the difference between a static
    //    diagram and a living hero shot). Threshold keeps the bloom on bright
    //    highlights only, not the whole gold body. ──
    // Crucial: an EffectComposer bypasses the renderer's built-in MSAA, so we
    // render into a MULTISAMPLED HalfFloat target (matches SceneManager's HIGH
    // tier: msaaSamples=4). Without this the full-bleed hero looks pixelated.
    const pr = this.renderer.getPixelRatio();
    const cw = Math.max(1, canvas.clientWidth);
    const ch = Math.max(1, canvas.clientHeight);
    const isWebGL2 = this.renderer.capabilities.isWebGL2;
    const rt = new THREE.WebGLRenderTarget(
      Math.floor(cw * pr), Math.floor(ch * pr),
      { type: THREE.HalfFloatType, samples: isWebGL2 ? 4 : 0 },
    );
    this._composer = new EffectComposer(this.renderer, rt);
    this._composer.setPixelRatio(pr);
    this._composer.addPass(new RenderPass(this.scene, this.camera));
    this._bloom = new UnrealBloomPass(
      new THREE.Vector2(cw, ch),
      0.28,   // strength — subtle glow, not a blinding halo
      0.5,    // radius
      1.0,    // threshold — only genuinely bright sources (arc, lights) bloom
    );
    this._composer.addPass(this._bloom);
    this._composer.addPass(new OutputPass());

    // Handle resize. A ResizeObserver is essential here: init() runs while the
    // menu is display:none (clientWidth = 0), so we must re-size when the canvas
    // actually becomes visible (0 → full-screen) — a window 'resize' never fires
    // for that transition. Without it the composer renders into a 1×1 buffer.
    this._resizeHandler = () => this._onResize(canvas);
    window.addEventListener('resize', this._resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._onResize(canvas));
      this._resizeObserver.observe(canvas);
    }
    this._onResize(canvas);
  }

  /** Start the render + animation loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    // The menu just became visible — force a correct size once layout is live
    // (clientWidth was 0 during init while hidden).
    if (this._canvas) requestAnimationFrame(() => this._onResize(this._canvas));
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
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._composer) {
      this._composer.dispose?.();
      this._composer = null;
    }
    if (this._envRT) {
      this._envRT.dispose();
      this._envRT = null;
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
    this._orbitAngle += dt;

    // Camera — a slow, eased SWAY across the work side (not a full 360° spin),
    // so the welding astronaut + arc stay the framed centerpiece at all times.
    // Centre angle ~0.5 rad puts the camera in the +X/+Z front-right octant
    // looking back at the weld; the gentle vertical bob adds life.
    const orbitR = 5.5;
    const ang  = 0.5 + Math.sin(this._orbitAngle * 0.16) * 0.62;
    const camY = 0.85 + Math.sin(this._orbitAngle * 0.12) * 0.42;
    this.camera.position.set(
      Math.cos(ang) * orbitR,
      camY,
      Math.sin(ang) * orbitR,
    );
    this.camera.lookAt(0.12, 0.0, 0.34);   // bias framing toward the weld / astronaut

    // Weld arc flicker — arc welding pulse: mostly steady with occasional spikes
    let arc = 0;
    if (this._weldLight) {
      this._weldLight.position.copy(this._weldPos);
      const base  = 0.12 + Math.random() * 0.06;
      const spike = Math.random() < 0.16 ? (0.35 + Math.random() * 0.7) : 0.0;
      arc = spike;
      this._weldLight.intensity = base + spike;
    }

    // Molten weld-pool glow — opacity + size track the arc spikes (hot when
    // striking, dim-red afterglow between strikes). Kept modest so it reads as
    // a hot spot, not a flare.
    if (this._weldGlow) {
      this._weldGlow.material.opacity = Math.min(0.7, 0.14 + arc * 0.32);
      this._weldGlow.scale.setScalar(M * (0.16 + arc * 0.05));
    }

    // Sparks
    if (this._sparkSystem) {
      updateSparks(this._sparkSystem, this._weldPos, dt);
    }

    if (this._composer) this._composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  _onResize(canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    if (this._composer) this._composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

export default MenuScene3D;
