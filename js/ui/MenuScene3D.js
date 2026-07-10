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
import { eventBus } from '../core/EventBus.js';       // tier-change subscription (menu renderer QoS)
import { Events } from '../core/Events.js';
// The hero ship is the REAL gameplay Mother + daughters (not a hand replica), so
// the menu can never drift from the sim. Any change to these models shows here.
import { PlayerSatellite } from '../entities/PlayerSatellite.js';
import { ArmUnit } from '../entities/ArmUnit.js';
// EVA shoulder-patch flag is painted by the shared procedural flag system so the
// menu can swap it to match the player's selected language (core/Languages.js).
import { FlagDecalSystem } from './FlagDecalSystem.js';
import { settingsManager } from '../systems/SettingsManager.js';
import { getLanguage } from '../core/Languages.js';

// Lazily-created singleton flag painter (Canvas2D). Reused for every patch
// repaint — cheap, browser-only, and independent of the debris flag atlas.
let _flagPainter = null;
/** @returns {HTMLCanvasElement|null} a freshly painted flag canvas for `code`. */
function flagCanvasFor(code) {
  if (typeof document === 'undefined') return null;
  if (!_flagPainter) _flagPainter = new FlagDecalSystem();
  return _flagPainter.makeFlagCanvas(code);
}


// ─── Scale + hull anchors ────────────────────────────────────────────────────
// The hero Mother is a real PlayerSatellite (built at the sim's 1-unit=100-km
// scale) scaled up so 1 unit = 1 metre. At that scale its barrel radius lands on
// BUS_R and its front cap on BUS_LEN*0.5 — the anchor points the EVA astronaut,
// weld glow and safety tether hang off of.
const M       = 1;          // scale factor (1 unit = 1 metre)
const BUS_LEN = 2.0 * M;    // Constants.OCTOPUS_V5.CORE_LENGTH — barrel length (2.0 m)
const BUS_R   = 0.4 * M;    // Constants.OCTOPUS_V5.COLLAR_RADIUS — barrel radius (0.40 m)

// PlayerSatellite builds at 1 scene unit = 100 km (1 metre = 1e-5 units). Scaling
// the instance by 1/SIM_M makes its sim-metre geometry read at the hero's 1 m
// scale, so the hull matches BUS_R / BUS_LEN above exactly.
const SIM_M   = 0.00001;

const SPARK_COUNT = 70;
const SPARK_SPEED = 2.80;     // fast — sparks streak away before accumulating
const SPARK_LIFE  = 0.45;     // short — die quickly for crisp look

// ─── Menu render quality per tier ───────────────────────────────────────────
// The menu hero is a SINGLE ship on an otherwise empty scene — it has none of
// the main scene's fragment-bound cost (the Earth fullscreen atmosphere shader,
// full 40k-debris field, active-sat swarm). SceneManager's HIGH pixelRatioCap
// was deliberately lowered 2→1.5 in Sprint 3 (Constants.js C.1 note) to tame
// THAT fragment cost — a cap the cheap menu scene shouldn't inherit, or the
// hero silhouette aliases against the now-live backdrop. So the menu keeps its
// own table: crisp at HIGH (pixelRatio 2, the menu's original value), stepping
// down only on weaker tiers. MSAA is 4× on HalfFloat (RGBA16F) — the proven-
// portable ceiling; higher sample counts aren't guaranteed for float targets on
// all GPUs. bloom-enable still matches QUALITY_TIERS (HIGH/MEDIUM on, LOW off).
const MENU_QUALITY = {
  HIGH:   { pixelRatioCap: 2,   msaaSamples: 4, enableBloom: true  },
  MEDIUM: { pixelRatioCap: 1.5, msaaSamples: 4, enableBloom: true  },
  LOW:    { pixelRatioCap: 1,   msaaSamples: 0, enableBloom: false },
};
function menuQualityFor(tier) {
  return MENU_QUALITY[tier] || MENU_QUALITY.HIGH;
}


// ─── Space backdrop ─────────────────────────────────────────────────────────
// Backdrop reveal (Option A): the menu canvas is now TRANSPARENT so the live
// game scene (Earth, the real Starfield with constellations, the background
// debris cloud, active satellites) shows through from the main renderer behind
// it. No scene.background, no menu-local starfield — those would occlude or
// double-up the reveal. See init(): scene.background = null + clear alpha 0.

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
    // Red EV-crew identification stripe (NASA EV1 marking on the thigh).
    evRed:     new THREE.MeshStandardMaterial({ color: 0xed1c24, metalness: 0.0, roughness: 0.9 }),
  };
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

// NASA EMU orbital EVA boot, modelled from flight-hardware photos. Rather than a
// pile of blobs, the boot is a single EXTRUDED side-profile (heel → ankle →
// instep → up-turned toe) with a beveled, puffy fabric edge — the recognizable
// EMU "bootie" silhouette. A curved black flexible OUTSOLE follows the foot and
// rises with the toe (the EMU "toe-spring"), and a soft gathered cuff rolls the
// LTA leg fabric into the boot. NO deep tread — orbital EVA needs no traction
// (the cleated waffle sole is the Apollo LUNAR overshoe, not this). The boot is
// built in its own frame: ankle opening at +Y, foot extends +Z, sole faces −Y.
function buildEVABoot(mat) {
  const boot = new THREE.Group();
  const S = M;   // profile coords are in metres, same scale as the rest of the suit

  const shapeFrom = (pts) => {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0] * S, pts[0][1] * S);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0] * S, pts[i][1] * S);
    s.closePath();
    return s;
  };
  const extrude = (pts, width, bevel) => {
    const geo = new THREE.ExtrudeGeometry(shapeFrom(pts), {
      depth: Math.max(0.001, (width - 2 * bevel) * S), bevelEnabled: true,
      bevelThickness: bevel * S, bevelSize: bevel * S, bevelSegments: 4,
      steps: 1, curveSegments: 14,
    });
    geo.rotateY(-Math.PI / 2);                 // profile X(=Z_boot)→+Z, extrude(width)→X
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    geo.translate(-(bb.max.x + bb.min.x) / 2, 0, 0);   // centre the width on X
    return geo;
  };

  // Side profile (Z_boot, Y_boot): rounded heel, low ankle column, instep slope,
  // and a blunt toe with a GENTLE up-curl (toe-spring). Wide and short — a chunky
  // bootie, not a tall narrow boot.
  const upper = [
    [-0.085, -0.080], [-0.098, -0.030], [-0.092, 0.020], [-0.065, 0.052],
    [ 0.005,  0.058], [ 0.070,  0.020], [ 0.140, -0.005],
    [ 0.200,  0.012], [ 0.218, -0.030], [ 0.180, -0.080],
  ];
  // Curved outsole band — thin, gentle toe lift.
  const soleP = [
    [-0.087, -0.050], [-0.087, -0.086], [0.180, -0.086],
    [ 0.220, -0.040], [ 0.200, -0.005], [0.140, -0.050],
  ];

  const footUpper = new THREE.Mesh(extrude(upper, 0.150, 0.024), mat.boot);
  boot.add(footUpper);

  const footSole = new THREE.Mesh(extrude(soleP, 0.128, 0.014), mat.bootSole);
  footSole.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  boot.add(footSole);

  // Gathered ankle cuff — soft rolled fabric ring at the leg→boot junction
  const cuff = new THREE.Mesh(new THREE.TorusGeometry(M * 0.066, M * 0.020, 8, 18), mat.suitFold);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, M * 0.052, -M * 0.02);
  boot.add(cuff);

  return boot;
}

function buildAstronaut(mat, flagCode = 'USA') {
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
  // Expose the tool tip so the scene can lock the weld glow/sparks to it (the
  // tip is the closest point to the arc — the weld must originate here).
  astro.userData.toolTip = tip;

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

    // ── Boot — NASA EMU orbital EVA boot (see buildEVABoot): an extruded
    //    foot-profile bootie with a gathered ankle cuff, blunt up-turned toe and
    //    a thin curved black sole. The ankle joint cants slightly for a relaxed,
    //    asymmetric micro-g float. ──
    const bootGroup = new THREE.Group();
    bootGroup.position.set(0, -M * 0.42, 0);

    const footGroup = new THREE.Group();           // ankle pivot
    footGroup.rotation.x = side < 0 ? 0.10 : 0.04; // slight relaxed cant (asymmetric)

    const boot = buildEVABoot(mat);
    boot.position.y = -M * 0.03;                   // drop so the cuff meets the shin
    footGroup.add(boot);

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
      new THREE.CylinderGeometry(M * 0.112, M * 0.106, M * 0.055, 14, 1, true), mat.evRed);
    idStripe.position.y = -M * 0.27;
    idStripe.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    legGroup.add(idStripe);

    legGroup.add(shankGroup);
    astro.add(legGroup);
  }

  // ── National flag — curved shoulder patch wrapped onto the left upper arm ──
  // The flag adjusts to the player's selected menu language (core/Languages.js
  // → flag code). Rather than per-stripe geometry (which only suits horizontal
  // tricolours like the old hardcoded Thai patch), the flag is painted to a
  // canvas by FlagDecalSystem and mapped onto a single curved cylinder segment,
  // so ANY flag design wraps the arm and can be swapped at runtime.
  const flagH = M * 0.085;
  const armR  = M * 0.076;                  // upper-arm radius near the patch
  const arc   = 1.6;                         // ~92° wrap, centred on the outer (−X) face
  const thetaStart = 3 * Math.PI / 2 - arc / 2;
  const flagGroup = new THREE.Group();
  flagGroup.position.y = -M * 0.12;

  // Dark stitched border just beneath the field (slightly taller + wider arc)
  const flagBorder = new THREE.Mesh(
    new THREE.CylinderGeometry(armR * 0.996, armR * 0.996, flagH + M * 0.012, 20, 1, true,
      3 * Math.PI / 2 - (arc * 1.14) / 2, arc * 1.14),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 1, side: THREE.DoubleSide }));
  flagBorder.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  flagGroup.add(flagBorder);

  // Flag field — procedural flag canvas mapped onto the curved segment. The
  // cylinder's V (height) carries the flag's vertical axis and U (arc) its
  // horizontal axis, so painted horizontal stripes wrap the arm as bands.
  const flagTex = new THREE.CanvasTexture(flagCanvasFor(flagCode));
  flagTex.colorSpace = THREE.SRGBColorSpace;
  flagTex.wrapS = THREE.ClampToEdgeWrapping;
  flagTex.wrapT = THREE.ClampToEdgeWrapping;
  const flagField = new THREE.Mesh(
    new THREE.CylinderGeometry(armR * 1.004, armR * 1.004, flagH, 24, 1, true, thetaStart, arc),
    new THREE.MeshStandardMaterial({ map: flagTex, roughness: 0.85, metalness: 0.0,
      side: THREE.DoubleSide }));
  flagField.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL + 1;
  flagGroup.add(flagField);

  // Swap hook — lets the menu repaint the patch when the player picks a new
  // language, without rebuilding the astronaut. Tracks the active code so the
  // scene can no-op redundant sets.
  astro.userData.flagCode = flagCode;
  astro.userData.setFlagCode = (code) => {
    if (code === astro.userData.flagCode) return;
    const c = flagCanvasFor(code);
    if (!c) return;
    flagTex.image = c;
    flagTex.needsUpdate = true;
    astro.userData.flagCode = code;
  };

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
  constructor(initialTier = null) {
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
    this._outputPass = null;    // OutputPass (tonemap + sRGB)
    this._lastDpr  = window.devicePixelRatio || 1;  // tracked for DPR-change rebuild
    this._envRT    = null;      // PMREM environment render target
    this._canvas   = null;      // canvas ref (for resize-on-show)
    this._resizeObserver = null;
    this._weldGlow = null;      // molten weld-pool glow sprite
    this._visorMat = null;      // visor material (flashes with the arc)
    this._mother   = null;      // real PlayerSatellite instance (hero ship)
    this._daughters = [];       // real ArmUnit instances docked on the struts
    this._sunDir   = null;      // world-space sun direction (solar tracking)
    this._lookTarget = new THREE.Vector3(0.12, 0, 0.34);  // camera aim (set to weld)

    // ── Quality-tier compliance ──
    // Menu renderer tracks SceneManager's tier (HIGH/MEDIUM/LOW) so weak devices
    // don't pay full pixelRatio / MSAA / bloom cost on the menu. The per-tier
    // values come from MENU_QUALITY (above) — deliberately crisper at HIGH than
    // the fragment-bound main-scene tiers, since the hero scene is cheap. Initial
    // tier is handed in from main.js (SceneManager.currentTier); live changes
    // arrive via Events.PERF_TIER_CHANGED (the adapt loop runs during MENU).
    this._tier = initialTier || Constants.PERF.DEFAULT_QUALITY_TIER || 'HIGH';
    this._tierHandler = null;

    // ── prefers-reduced-motion ──
    // When set, the camera sway freezes at the sway centre and the weld arc runs
    // as a constant faint glow (no spark emission / light flicker). Live-toggled
    // via a matchMedia 'change' listener.
    this._reducedMotion = false;
    this._motionMedia = null;
    this._motionHandler = null;

    // ── Departure animation (Item 6 — menu→sim transition) ──
    // When START is pressed, beginDeparture() ramps this 0→1 over
    // _departureDur seconds: the weld arc/glow/sparks fade out and the camera
    // eases its orbit radius back (5.5 → 8) so the hero recedes as the live
    // gameplay scene behind the transparent menu takes over. null = idle.
    this._departure = null;         // { t, dur } while animating, else null
    this._departureDur = 1.6;       // seconds (skippable)
    this._departureBaseOrbitR = 5.5;
    this._departureOrbitR = 8.0;

    // Frame gate — the menu hero render loop is capped to ~60 fps (30 under
    // reduced motion) so it doesn't run at 120 fps on ProMotion displays while
    // the rest of the app throttles to 30 Hz during MENU (energy policy §12.12).
    this._lastFrameT = 0;
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
      // The composer's multisampled HalfFloat target does all AA (see
      // _buildComposer, samples>0), so a context-level MSAA backbuffer would be
      // dead memory at pr 2 fullscreen. Trade-off: the composer-failure fallback
      // path (_tick's renderer.render when _composer is null) becomes aliased —
      // acceptable, it only triggers if _buildComposer throws.
      antialias: false,
      alpha: true,
    });
    // Pixel ratio is tier-driven (see MENU_QUALITY). _applyTierSettings() at the
    // end of init() sets the authoritative value from this._tier; this initial
    // cap of 2 is just a safe pre-composer default (matches the HIGH cap).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Backdrop reveal: fully transparent clear so the live game scene composites
    // through from the main renderer behind this canvas.
    this.renderer.setClearColor(0x000000, 0);

    // Scene
    this.scene = new THREE.Scene();

    // Transparent backdrop (Option A). No scene.background — the real orbital
    // scene (Earth, constellations, debris) renders behind the menu canvas.
    this.scene.background = null;

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
    // World-space sun direction, reused to drive the Mother's solar sun-tracking.
    this._sunDir = sun.position.clone().normalize();

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

    // (Backdrop reveal) No menu-local starfield: the real Starfield.js — with
    // its 8 constellations — now shows through from the main scene behind the
    // transparent canvas, so a second star shell here would double up / occlude.

    // Orbit pivot — everything rotates around this
    this._pivot = new THREE.Group();
    this.scene.add(this._pivot);

    // Mother satellite — the REAL in-game PlayerSatellite, so the hero ship is
    // literally the same mesh the player flies (no hand replica to drift from).
    // The constructor parents the satellite into whatever "scene" we pass, so we
    // hand it the orbit pivot. It also seeds an orbital position + 6 eventBus
    // listeners; we zero the position and otherwise leave it static (never call
    // update()), exactly as the old replica was static.
    const mother = new PlayerSatellite(this._pivot);
    mother.position.set(0, 0, 0);            // ignore the orbital position the ctor set
    mother.scale.setScalar(1 / SIM_M);       // 1e5 → sim-metre geometry reads at 1 m
    // Roll −90° about the long axis: in sim the solar wings sit at ±X and the
    // sensor turret at +Y. The hero needs wings at ±Y (clear of the +X weld) and
    // the sensor facing +X (the unit the astronaut services). This roll does both
    // and matches the framing the hand replica was hand-built to. Struts + ROSA
    // come out of _buildModel already in their deployed pose, so nothing else to do.
    mother.rotation.z = -Math.PI / 2;

    // This hero ship is a full gameplay PlayerSatellite, so its constructor wired
    // the sim's eventBus handlers (crossbow recoil, EDT toggle, dual-fire). The
    // menu instance lives for the whole app and would otherwise ALSO react to
    // those gameplay events during a live session — emitting duplicate COMMS
    // messages and consuming cold-gas on a phantom ship. We only want the MODEL,
    // not the behaviour, so neutralise the handlers that emit events / mutate
    // resources. (The remaining handlers — scan-flash timer, hull outline — are
    // display-only and inert because we never run this satellite's update loop.)
    mother.toggleEDT = () => {};
    mother._applyCrossbowRecoil = () => {};
    mother._applyDualFireRecoil = () => {};
    // The hero has no gameplay power subsystem driving solarRate, so give the
    // ROSA cell faces a constant energized power-flow glow (see _animateRosaGlow).
    mother._rosaGlowIdleFloor = 0.55;
    this._mother = mother;

    // Cull geometry the fixed hero framing never shows: the docking port sits on
    // the −X face (away from the camera) after the roll.
    if (mother.dockingPort) mother.dockingPort.visible = false;

    // Daughters — the REAL ArmUnit models docked on the Mother's actual strut
    // tips (drift-proof, same as the mother). Full Y0 Quad loadout: 2 Weavers +
    // 2 Spinners, using the sim's CANONICAL per-index type assignment
    // (ArmManager._initArms: type = i % 2 === 0 ? 'weaver' : 'spinner'), i.e.
    // ['weaver','spinner','weaver','spinner']. That puts the two big Weavers at
    // indices 0 & 2 (sim-local 60°/240° → ANTIPODAL, 180° apart) and the Spinners
    // at 1 & 3 (120°/300°, also antipodal) — matching the sim, where the large
    // daughters sit on OPPOSITE sides, not the same side.
    this._daughters = [];
    const loadout = [
      ['menu-weaver-1', 'weaver'],    // index 0 — sim 60° (front-lower)
      ['menu-spinner-1', 'spinner'],  // index 1 — sim 120° (front-upper)
      ['menu-weaver-2', 'weaver'],    // index 2 — sim 240° (aft, opposite weaver-1)
      ['menu-spinner-2', 'spinner'],  // index 3 — sim 300° (aft, opposite spinner-1)
    ];
    const tips = mother.strutTipNodes || [];
    for (let i = 0; i < loadout.length; i++) {
      const tip = tips[i];
      if (!tip) continue;
      const [id, type] = loadout[i];
      // ArmUnit's ctor adds its visual root (.group) to the scene we pass; we
      // immediately reparent it onto the strut tip. It also hides its body until
      // a docked-state animation runs in-game, so force it visible here.
      const arm = new ArmUnit(id, type, new THREE.Vector3(), this.scene);
      arm.mesh.visible = true;
      if (arm.tetherLine) arm.tetherLine.visible = false;   // no stray dock tether
      tip.add(arm.group);                    // inherits the tip's deployed pose + scale
      arm.group.position.set(0, 0, 0);
      // Daughter forward (+Z) → strut-outward (tip-local −Y): nose points away.
      arm.group.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, -1, 0),
      );
      this._daughters.push(arm);
    }

    // Astronaut — human-scale EVA reference servicing a strut hinge. Faces −X
    // (chest toward the barrel). Nudged +5 cm to the astronaut's anatomical right
    // (−Z, since they face −X). Final placement is SNAPPED below so the tool tip
    // lands exactly on an aluminium strut hinge.
    const astro = buildAstronaut(mat, getLanguage(settingsManager.getLanguage()).flag);
    astro.position.set(M * 0.97, -M * 0.21, M * 0.58);
    astro.rotation.y = -Math.PI / 2;   // local +Z → world -X (chest toward satellite)
    astro.rotation.z = 0.08;           // subtle micro-g tilt
    this._pivot.add(astro);
    this._astro = astro;
    this._visorMat = astro.userData.visorMat || null;

    // Weld site — the astronaut welds a real ALUMINIUM strut hinge, NOT the gold
    // MLI foil (you can't weld a thermal blanket; a cracked/serviced hinge is the
    // believable EVA job). We snap the whole astronaut so its TOOL TIP lands on
    // the strut hinge nearest its current aim (keeps the natural reaching pose),
    // then put the weld glow + sparks ON the tool tip. This guarantees the arc
    // originates at the tool — not at the safety-tether anchor (earlier bug).
    this._pivot.updateMatrixWorld(true);
    const toolTip = astro.userData.toolTip;
    const groups = (this._mother.strutGroups || []).filter((g) => g && g.pivotGroup);
    if (toolTip && groups.length) {
      const tPos = toolTip.getWorldPosition(new THREE.Vector3());
      const scratch = new THREE.Vector3();
      let hinge = null;
      let bestD = Infinity;
      for (const sg of groups) {
        sg.pivotGroup.getWorldPosition(scratch);
        const d = scratch.distanceToSquared(tPos);
        if (d < bestD) { bestD = d; hinge = scratch.clone(); }
      }
      // Translate astronaut so tool tip → hinge, then re-read the tip as the weld.
      astro.position.add(hinge.sub(tPos));
      astro.updateMatrixWorld(true);
      toolTip.getWorldPosition(this._weldPos);
    } else {
      this._weldPos.set(BUS_R, M * 0.12, BUS_LEN * 0.5);   // fallback: old barrel spot
    }

    // Re-aim the camera toward the work site (partway, so the astronaut + arc are
    // framed without over-tilting). The old fixed target was tuned to the barrel.
    this._lookTarget.copy(this._weldPos).multiplyScalar(0.7);

    // Molten weld-pool glow on the hinge — pulses with the arc (see _tick).
    this._weldGlow = makeGlowSprite();
    this._weldGlow.position.copy(this._weldPos);
    this._weldGlow.scale.setScalar(M * 0.22);
    this._pivot.add(this._weldGlow);

    // EVA safety tether — slack line from the astronaut's waist to a SEPARATE
    // hull hardpoint near the front collar (deliberately offset from the weld so
    // the anchor and the arc don't sit on top of each other).
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
    //    diagram and a living hero shot). The composer is built in
    //    _buildComposer() (invoked via _applyTierSettings below) so a tier
    //    change can tear it down and rebuild at new MSAA / bloom settings.

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

    // Tier-change subscription: the main-loop adapt check runs during MENU, so
    // PERF_TIER_CHANGED can fire while the menu is up. Rebuild the composer to
    // the new tier's pixelRatio / MSAA / bloom settings.
    this._tierHandler = ({ to }) => this._applyTier(to);
    eventBus.on(Events.PERF_TIER_CHANGED, this._tierHandler);

    // prefers-reduced-motion — read once and live-listen for changes.
    this._initReducedMotion();

    // Apply the initial tier (sets pixelRatio + bloom enable) before the first
    // size pass so the composer target is created at the right resolution.
    this._applyTierSettings();
    this._onResize(canvas);
  }

  /**
   * @private Build (or rebuild) the EffectComposer for the current tier.
   * An EffectComposer bypasses the renderer's built-in MSAA, so we render into a
   * MULTISAMPLED HalfFloat target (matches SceneManager's tier msaaSamples).
   * Bloom is added only when the tier enables it; otherwise the enlarged weld
   * glow sprite (see _tick) carries the arc read on its own (LOW-tier fallback).
   *
   * Backdrop reveal note: the composer runs over a TRANSPARENT clear. A HalfFloat
   * target + OutputPass keeps the alpha channel intact so the hero composites
   * cleanly over the live game scene; UnrealBloomPass is purely additive (it only
   * lightens bright pixels) so it can only ADD glow, never punch a dark halo into
   * the transparent region — the old opaque-background workaround is no longer
   * needed. The bloom threshold (1.0) keeps it on genuinely bright sources only.
   */
  _buildComposer() {
    // Tear down any prior composer (tier rebuild path). EffectComposer.dispose()
    // does NOT dispose added passes, so the bloom mip-chain targets and the
    // OutputPass ShaderMaterial would leak on every tier rebuild — dispose the
    // added passes explicitly first.
    if (this._composer) {
      this._bloom?.dispose?.();
      this._outputPass?.dispose?.();
      this._composer.dispose?.();
      this._composer = null;
      this._bloom = null;
      this._outputPass = null;
    }

    const tierCfg = menuQualityFor(this._tier);
    const pr = this.renderer.getPixelRatio();
    const canvas = this._canvas;
    const cw = Math.max(1, canvas.clientWidth || 1);
    const ch = Math.max(1, canvas.clientHeight || 1);
    const isWebGL2 = this.renderer.capabilities.isWebGL2;
    // 4× MSAA on the HalfFloat target (three clamps to gl.MAX_SAMPLES). Kept at
    // 4 rather than higher because float (RGBA16F) multisample support above 4×
    // isn't guaranteed across GPUs and would risk an incomplete framebuffer.
    const samples = isWebGL2 ? (tierCfg.msaaSamples || 0) : 0;
    const rt = new THREE.WebGLRenderTarget(
      Math.floor(cw * pr), Math.floor(ch * pr),
      { type: THREE.HalfFloatType, samples },
    );
    this._composer = new EffectComposer(this.renderer, rt);
    this._composer.setPixelRatio(pr);
    this._composer.addPass(new RenderPass(this.scene, this.camera));
    if (tierCfg.enableBloom) {
      this._bloom = new UnrealBloomPass(
        new THREE.Vector2(cw, ch),
        0.28,   // strength — subtle glow, not a blinding halo
        0.5,    // radius
        1.0,    // threshold — only genuinely bright sources (arc, lights) bloom
      );
      this._composer.addPass(this._bloom);
    }
    this._outputPass = new OutputPass();
    this._composer.addPass(this._outputPass);
  }

  /**
   * @private Apply renderer-level settings for the current tier (pixelRatio) and
   * (re)build the composer so MSAA / bloom match. Split from _applyTier so init()
   * can call it once without re-reading a tier arg.
   */
  _applyTierSettings() {
    const tierCfg = menuQualityFor(this._tier);
    const cap = tierCfg.pixelRatioCap || 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this._lastDpr = window.devicePixelRatio || 1;
    this._buildComposer();
  }

  /**
   * @private Handle a tier change (from PERF_TIER_CHANGED). No-ops if the tier is
   * unchanged or unknown. Rebuilds renderer pixelRatio + composer, then re-sizes.
   * @param {string} tier — 'HIGH' | 'MEDIUM' | 'LOW'
   */
  _applyTier(tier) {
    if (!tier || tier === this._tier) return;
    if (!MENU_QUALITY[tier]) return;   // ignore unknown tiers
    this._tier = tier;
    if (!this.renderer) return;
    this._applyTierSettings();
    if (this._canvas) this._onResize(this._canvas);
  }

  /**
   * @private Initialise prefers-reduced-motion detection + live listener.
   */
  _initReducedMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      this._motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotion = !!this._motionMedia.matches;
      this._motionHandler = (e) => {
        this._reducedMotion = !!e.matches;
        // Snap the camera to the sway centre immediately when motion is reduced.
        if (this._reducedMotion) this._applyReducedMotionPose();
      };
      // addEventListener is the modern API; addListener is the deprecated fallback.
      if (typeof this._motionMedia.addEventListener === 'function') {
        this._motionMedia.addEventListener('change', this._motionHandler);
      } else if (typeof this._motionMedia.addListener === 'function') {
        this._motionMedia.addListener(this._motionHandler);
      }
    } catch (err) {
      console.warn('MenuScene3D: prefers-reduced-motion unavailable:', err);
    }
  }

  /** @private Place the camera at the frozen sway-centre pose (reduced motion). */
  _applyReducedMotionPose() {
    if (!this.camera) return;
    const orbitR = 5.5;
    const ang  = 0.5;    // sway centre (see _tick)
    const camY = 0.85;   // sway centre
    this.camera.position.set(Math.cos(ang) * orbitR, camY, Math.sin(ang) * orbitR);
    this.camera.lookAt(this._lookTarget);
  }

  /** Start the render + animation loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    // A fresh MENU entry (first show, or returning from a game) must not carry
    // over a prior departure ramp — reset so the weld/glow/sparks + orbit
    // radius return to their idle values.
    this._departure = null;
    // Reset the frame gate so resume renders immediately rather than bursting.
    this._lastFrameT = 0;
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

  /**
   * Begin the departure animation (Item 6 — menu→sim transition). Ramps the
   * weld arc / molten glow / sparks down to nothing and eases the camera's
   * orbit radius back (5.5 → 8) so the hero recedes while the live gameplay
   * scene behind the transparent menu becomes the focus. Idempotent — a second
   * call is ignored so a fast double-click can't restart the ramp. Under
   * reduced motion the visual ramp still runs (it only fades, no new motion),
   * but callers should keep the total handoff short.
   * @param {number} [durationSec] — override the default ramp duration
   */
  beginDeparture(durationSec) {
    if (this._departure) return;
    this._departure = { t: 0 };
    if (typeof durationSec === 'number' && durationSec > 0) {
      this._departureDur = durationSec;
    }
  }

  /** True while the departure ramp is in progress. */
  get isDeparting() {
    return !!this._departure;
  }

  /**
   * Update the astronaut's shoulder-patch flag (e.g. when the menu language
   * changes). Safe to call before/after init and while paused — repaints the
   * existing patch texture, no geometry rebuild.
   * @param {string} flagCode — flag code understood by FlagDecalSystem
   */
  setFlag(flagCode) {
    if (this._astro && this._astro.userData.setFlagCode) {
      this._astro.userData.setFlagCode(flagCode);
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
    if (this._tierHandler) {
      eventBus.off?.(Events.PERF_TIER_CHANGED, this._tierHandler);
      this._tierHandler = null;
    }
    if (this._motionMedia && this._motionHandler) {
      if (typeof this._motionMedia.removeEventListener === 'function') {
        this._motionMedia.removeEventListener('change', this._motionHandler);
      } else if (typeof this._motionMedia.removeListener === 'function') {
        this._motionMedia.removeListener(this._motionHandler);
      }
      this._motionMedia = null;
      this._motionHandler = null;
    }
    if (this._composer) {
      // Match _buildComposer teardown: dispose added passes (EffectComposer
      // disposes neither) before the composer's own RTs.
      this._bloom?.dispose?.();
      this._outputPass?.dispose?.();
      this._composer.dispose?.();
      this._composer = null;
      this._bloom = null;
      this._outputPass = null;
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

    // Frame gate: cap to ~60 fps (30 under reduced motion). Return BEFORE
    // _clock.getDelta() so dt accumulates across skipped frames — spark physics
    // and camera sway speed stay correct on the frames we actually render. The
    // −2 ms epsilon avoids beat-frequency lock on 120 Hz displays, where an exact
    // 16.67 ms threshold would skip alternate vsync ticks.
    const now = performance.now();
    const minInterval = (this._reducedMotion ? 1000 / 30 : 1000 / 60) - 2;
    if (now - this._lastFrameT < minInterval) return;
    this._lastFrameT = now;

    const dt = Math.min(this._clock.getDelta(), 0.05); // cap for tab-away
    this._orbitAngle += dt;

    // Departure ramp (Item 6): advance toward 1 with an ease-out curve. `dep`
    // 0→1 drives the camera pull-back + weld/glow/spark fade below. `depFade`
    // (1→0) is the multiplier that dims the work-site effects out.
    let dep = 0;
    if (this._departure) {
      this._departure.t = Math.min(this._departureDur, this._departure.t + dt);
      const raw = this._departure.t / this._departureDur; // 0→1 linear
      dep = 1 - Math.pow(1 - raw, 3);                      // ease-out cubic
    }
    const depFade = 1 - dep;

    // Camera — a slow, eased SWAY across the work side (not a full 360° spin),
    // so the welding astronaut + arc stay the framed centerpiece at all times.
    // Centre angle ~0.5 rad puts the camera in the +X/+Z front-right octant
    // looking back at the weld; the gentle vertical bob adds life.
    // prefers-reduced-motion: freeze at the sway centre (ang=0.5, camY=0.85).
    // During departure the orbit radius eases 5.5 → 8 so the hero recedes.
    const orbitR = this._departureBaseOrbitR +
      (this._departureOrbitR - this._departureBaseOrbitR) * dep;
    if (this._reducedMotion) {
      this.camera.position.set(Math.cos(0.5) * orbitR, 0.85, Math.sin(0.5) * orbitR);
    } else {
      const ang  = 0.5 + Math.sin(this._orbitAngle * 0.16) * 0.62;
      const camY = 0.85 + Math.sin(this._orbitAngle * 0.12) * 0.42;
      this.camera.position.set(
        Math.cos(ang) * orbitR,
        camY,
        Math.sin(ang) * orbitR,
      );
    }
    this.camera.lookAt(this._lookTarget);   // work site (weld / astronaut)

    // Living hero — drive the Mother's OWN animators (nav-light blink/strobe,
    // LIDAR pulse, solar sun-tracking). These only mutate materials/transforms on
    // the model and emit nothing, so they're safe to run without the gameplay
    // update() loop. Guarded individually in case a future refactor renames them.
    if (this._mother) {
      this._mother._animateNavLights?.(dt);
      this._mother._animateLidarPulse?.(dt);
      this._mother._animateSolarTracking?.(dt, this._sunDir);
      this._mother._animateRosaGlow?.(dt);
    }

    // Weld arc flicker — arc welding pulse: mostly steady with occasional spikes.
    // prefers-reduced-motion: hold a constant faint glow (no random flicker).
    // During departure `depFade` ramps the arc out (the weld "stops").
    let arc = 0;
    if (this._weldLight) {
      this._weldLight.position.copy(this._weldPos);
      if (this._reducedMotion) {
        this._weldLight.intensity = 0.14 * depFade;   // steady faint arc, fading
      } else {
        const base  = 0.12 + Math.random() * 0.06;
        const spike = Math.random() < 0.16 ? (0.35 + Math.random() * 0.7) : 0.0;
        arc = spike * depFade;
        this._weldLight.intensity = (base + spike) * depFade;
      }
    }

    // Molten weld-pool glow — opacity + size track the arc spikes (hot when
    // striking, dim-red afterglow between strikes). Kept modest so it reads as
    // a hot spot, not a flare. Reduced motion → static faint glow. Departure
    // fades it out with the arc.
    if (this._weldGlow) {
      this._weldGlow.material.opacity = Math.min(0.7, 0.14 + arc * 0.32) * depFade;
      this._weldGlow.scale.setScalar(M * (0.16 + arc * 0.05));
    }

    // Sparks — suppressed entirely under reduced motion (no streaking particles)
    // and once the departure ramp is well underway (the weld has stopped).
    if (this._sparkSystem && !this._reducedMotion && dep < 0.5) {
      updateSparks(this._sparkSystem, this._weldPos, dt);
    }

    if (this._composer) this._composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  _onResize(canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    // DPR change (e.g. dragging the window between a retina and a 1× monitor):
    // re-apply tier settings first so pixelRatio + composer targets rebuild at the
    // new device pixel ratio (otherwise 2× is wasteful on 1×, and 1.5×/1× is blurry
    // on retina). No recursion: _applyTierSettings does not call _onResize.
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this._lastDpr) {
      this._applyTierSettings();   // sets _lastDpr + rebuilds composer at new pr
    }
    this.renderer.setSize(w, h, false);
    if (this._composer) this._composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

export default MenuScene3D;
