/**
 * MenuScene3D.js — 3D hero scene for the menu: an EVA astronaut repairing the mother satellite, welding sparks, a
 * slow orbiting camera. Self-contained second WebGL context, independent of the game renderer.
 * @module ui/MenuScene3D
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';       // tier-change subscription (menu renderer QoS)
import { Events } from '../core/Events.js';
// The hero ship is the REAL gameplay Mother + daughters, so the menu can never drift from the sim.
import { PlayerSatellite } from '../entities/PlayerSatellite.js';
import { ArmUnit } from '../entities/ArmUnit.js';
// The shared flag painter lets the menu swap the shoulder patch to the selected language (core/Languages.js).
import { FlagDecalSystem } from './FlagDecalSystem.js';
import { settingsManager } from '../systems/SettingsManager.js';
import { getLanguage } from '../core/Languages.js';
// Imported DIRECTLY as a module singleton: MenuScene3D is constructed inside MenuScreen with no dependency channel.
// _tick reads progress() while the dance is active: the SAME wall-clock value the sim ship reads after the cut, so
// the unmasked 'flyaround' departure stays continuous across the menu→game hand-off.
import { openingDance } from '../systems/OpeningDance.js';
import { degToRad, lerp, smoothstep01 } from '../core/MathUtil.js';
import { composeDockedArmQuat, strutLocalDirection } from '../entities/ArmDockBasis.js';

// Lazy singleton Canvas2D flag painter, independent of the debris flag atlas.
let _flagPainter = null;
/** @returns {HTMLCanvasElement|null} a freshly painted flag canvas for `code`. */
function flagCanvasFor(code) {
  if (typeof document === 'undefined') return null;
  if (!_flagPainter) _flagPainter = new FlagDecalSystem();
  return _flagPainter.makeFlagCanvas(code);
}

// The hero Mother is a real PlayerSatellite (built at 1 unit = 100 km) scaled so 1 unit = 1 metre. Its barrel
// radius then lands on BUS_R and its front cap on BUS_LEN*0.5: the anchors the astronaut, weld glow and tether use.
const M       = 1;          // scale factor (1 unit = 1 metre)
const BUS_LEN = 2.0 * M;    // Constants.OCTOPUS_V5.CORE_LENGTH — barrel length (2.0 m)
const BUS_R   = 0.4 * M;    // Constants.OCTOPUS_V5.COLLAR_RADIUS — barrel radius (0.40 m)

// 1 metre = 1e-5 scene units in PlayerSatellite; scaling the instance by 1/SIM_M matches BUS_R / BUS_LEN exactly.
const SIM_M   = 0.00001;

const SPARK_COUNT = 70;
const SPARK_SPEED = 2.80;     // fast — sparks streak away before accumulating
const SPARK_LIFE  = 0.45;     // short — die quickly for crisp look

// Astronaut exit-beat tunables. Beat timings are FRACTIONS of the departure duration (see _updateAstronautExit), so
// the whole cinematic scales with _departureDur.
const EXIT_TURN_Y   = 0.52;   // acknowledgment turn about Y (~30°), toward camera
const EXIT_ARM_TUCK = -0.42;  // welding-arm shoulder pitch delta (tucks tool to chest)
const EXIT_BODY_ROLL = 0.12;  // slight roll during translation (not a rigid statue)
const BEAT_TURN_START   = 0.06;  // fraction of dur — glance-back begins
const BEAT_TURN_END     = 0.24;  // glance-back complete
const BEAT_TETHER_START = 0.14;  // umbilical pulls taut
const BEAT_TETHER_END   = 0.24;  // umbilical fully reeled (before jet-off)
const BEAT_JETOFF       = 0.26;  // cold-gas push-off begins (early → long coast, more travel)
const BEAT_ORIENT_GATE  = 0.29;  // de-roll / fly-around begins (AFTER push-off)
// 'flyaround' camera arc gets its OWN earlier gate so the rotation has time to sweep and finish calmly.
const BEAT_FLYAROUND_GATE = 0.22;
// Jet-off is a Newtonian push-off: a brief cold-gas IMPULSE to a modest drift speed, then CONSTANT-velocity coast
// (no ease-in "whip"). Both treatments share ONE calm pace; distance = speed x coast time, so the slow speed only
// reaches the screen edge before the cut because the push-off starts early.
const EXIT_DRIFT_SPEED  = 1.4;   // m/s constant drift after the impulse (partial)
const EXIT_IMPULSE_RAMP = 0.45;  // s to accelerate from rest to drift speed
// 'flyaround' mirrors 'partial' (same drift + ramp); its camera rotation is ~20% slower (see FLYAROUND_ANG_END).
const EXIT_DRIFT_SPEED_FLY  = 1.4;   // m/s — flyaround drift (mirrors partial)
const EXIT_IMPULSE_RAMP_FLY = 0.45;  // s  — flyaround impulse ramp
// Drift direction: screen DOWN-and-RIGHT. She welds on the camera-near (+X) side, so lower-right carries her off the
// near edge WITHOUT crossing in front of the hull.
const EXIT_RIGHT_BIAS = 0.86;
const EXIT_DOWN_BIAS  = 0.52;
// 'partial' uses a STEEPER downward angle so she drops off the BOTTOM of the screen.
const EXIT_RIGHT_BIAS_PARTIAL = 0.55;
const EXIT_DOWN_BIAS_PARTIAL  = 0.85;
// Orientation continuity: TWO treatments, chosen at RANDOM per new-game departure (beginDeparture → this._orientMode):
//   'partial'   — migrate the camera sway centre modestly toward the sim view + gently de-roll (~28°, gated after
//                 push-off); a power-up FLASH (main.js) masks the residual face-flip.
//   'flyaround' — the camera ARCS fully behind the ship while the hull de-rolls to native orientation, so the cut is
//                 orientation-seamless; the astronaut dissolves out. No flash.
// Continue/reduced always use 'partial' framing (no roll change).
const MOTHER_BASE_ROLL_Z = -Math.PI / 2;   // the menu build roll (wings vertical)
const EXIT_DEROLL       = Math.PI / 6.4;    // 'partial': ~28° de-roll toward horizontal
const EXIT_CAM_ANG_SHIFT = 0.55;            // 'partial': the sway centre moves this far (rad) by the cut (it was 0.5 → 1.05)
const EXIT_CAM_CAMY_END = 0.45;             // 'partial': sway-centre elevation at the cut
const FLYAROUND_ANG_END  = -1.157;          // 'flyaround': camera azimuth arc end (the sim's behind-and-above chase)
const FLYAROUND_CAMY_END = 2.0;             // 'flyaround': slightly above (sim radial-above chase)
// Exit free-flyer pose (CPU-only rotation deltas): after jet-off legs trail + deep knee bend + left arm opens +
// slight chest-open arch. Times are SECONDS after jet-off; poseE (eased 0→1 over EXIT_POSE_DUR) scales the deltas.
const EXIT_POSE_DUR   = 0.9;   // seconds to ease into the full free-flyer pose
const EXIT_LEG_L_X    = 0.30;  // left leg trails back (base ≈ -0.20)
const EXIT_LEG_R_X    = 0.50;  // right leg trails further (base ≈ -0.44)
const EXIT_SHANK_L_X  = 1.25;  // left knee folds deep under the trailing leg
const EXIT_SHANK_R_X  = 1.40;  // right knee folds deeper
const EXIT_ARM_Z      = -0.85; // free left arm swings outward, away from the work
const EXIT_ARM_X      = -0.55; // ...and opens up from the tool-hold raise
const EXIT_CHEST_OPEN = -0.18; // chest opens skyward (astro pitch relaxing back)
// Camera sway, shared by BOTH orientation branches in _tick and by _applyReducedMotionPose.
// Flower theme phase 2 (DECISIONS §55 row 2, "menu seen from behind"): the camera position is (cos a·R, camY, sin a·R)
// around the ship, the ship's nose is +Z, so the TAIL side is a = -PI/2 (dead behind). The sway runs between a 3/4 view
// from the astronaut's side and dead behind, and back: a = SWAY_ANG_CENTRE ± SWAY_ANG_AMP covers -0.80 to -1.57 (dead
// behind). Measured with `menuCameraPosition` over three periods: 3° (closest) to 45° (widest) off the tail axis, 2°-7°
// up (at R 5.5). It stops at dead behind rather than swinging on to the far side, where the hull and plates would hide the astronaut.
const SWAY_ANG_CENTRE  = -1.185;  // idle azimuth centre, midway between the 3/4 end and dead behind
// Camera height (m): phase 2's 0.7 ± 0.40 at R 8.6, scaled by 5.5 / 8.6 when the camera came back in (DECISIONS §55 row 7),
// so the view angles stay the ones the owner looked at. Measured over the whole sway (rays from the camera to the
// astronaut's helmet, real menu scene, 2026-10-29): the upper-left plate hides his helmet 5.7% of the time at this
// height, 18.3% if 0.7 ± 0.40 had been kept at 5.5 m (14.8% in the phase-2 build at 8.6 m).
const SWAY_CAMY_CENTRE = 0.45;    // idle elevation centre (a little above: about 5°)
const SWAY_ANG_FREQ  = 0.16, SWAY_ANG_AMP  = 0.385;   // azimuth bob
const SWAY_CAMY_FREQ = 0.12, SWAY_CAMY_AMP = 0.26;    // elevation bob (camY 0.19-0.71)
// Reduced motion holds the 3/4 end of the sway (the astronaut's side), not the middle.
const REDUCED_ANG = SWAY_ANG_CENTRE + SWAY_ANG_AMP;
// Idle orbit radius (m): 5.5, the old menu's distance, so the astronaut is his old size on screen (DECISIONS §55 row 7,
// owner 2026-10-29: "the now flower pose makes the astronaut look too small"). With the radiators open to 146° the plates
// run off the screen edges at this distance; the owner accepted that cropping. Phase 2 had moved the camera out to 8.6 to
// fit the plates, with the iPad a further 1.16 times out. The same 5.5 on every screen: the vertical field of view is
// fixed, so the astronaut's size depends only on this distance; a narrower window just crops more of the plates.
const SWAY_ORBIT_R = 5.5;
const TAIL_LIGHT_INTENSITY = 2.0;   // warm key from behind (see init); tuned with scripts/probes/menu-frames.mjs

/** The sway's centre elevation (m) and orbit radius (m), for tests and the frame probe. */
export const MENU_SWAY_CENTRE = { camY: SWAY_CAMY_CENTRE, orbitR: SWAY_ORBIT_R };

/** One full azimuth sway period in seconds. Exported for the frame probe and tests. */
export const MENU_SWAY_PERIOD_S = (2 * Math.PI) / SWAY_ANG_FREQ;
/** Sway times (s on the scene's orbit clock) at which the camera is at the 3/4 end and at dead behind. */
export const MENU_SWAY_POINTS = {
  threeQuarterS: (0.5 * Math.PI) / SWAY_ANG_FREQ,   // sin = +1: a = CENTRE + AMP
  behindS: (1.5 * Math.PI) / SWAY_ANG_FREQ,         // sin = -1: a = CENTRE - AMP
};

/**
 * The two title-screen styles the dev tick box (MenuScreen, "Old menu pose") switches between. `old`, the DEFAULT (owner
 * 2026-10-29, DECISIONS §55 row 9: "Old pose by default" after comparing both live), is the menu as commit 57b98ba7 had it
 * (before DECISIONS §55 rows 1-2): struts at the build default 90°, radiators folded (0°) with the wings rolled (a
 * reduced-motion or dance-off hero is shown deployed instead: 146° and wings out), a front-right 3/4 sway, no tail light,
 * and no strut/radiator fold when she departs. `new` is the flower-phase-2 menu above, kept behind the tick box for
 * comparison. The astronaut is the same in both.
 *   centreAng/centreCamY/angAmp/camYAmp/orbitR: the sway (`menuCameraPosition`); reducedAng: the azimuth the camera holds
 *   under reduced motion; tailLight: the warm key from behind; strutRad: hero strut sweep angle (rad); departureFold:
 *   whether the START departure folds the struts and radiators (`applyHeroDepartureFold`).
 */
export const MENU_POSE_STYLES = {
  new: {
    centreAng: SWAY_ANG_CENTRE, centreCamY: SWAY_CAMY_CENTRE, angAmp: SWAY_ANG_AMP, camYAmp: SWAY_CAMY_AMP,
    orbitR: SWAY_ORBIT_R, reducedAng: REDUCED_ANG, tailLight: true, strutRad: Math.PI, departureFold: true,
  },
  old: {
    centreAng: 0.5, centreCamY: 0.85, angAmp: 0.62, camYAmp: 0.42,
    orbitR: 5.5, reducedAng: 0.5, tailLight: false, strutRad: Math.PI / 2, departureFold: false,
  },
};

/** The style a fresh page shows (DECISIONS §55 row 9, owner 2026-10-29: "Old pose by default"). */
export const MENU_POSE_DEFAULT = 'old';

// The style shown now, remembered across menu returns in the same page (a new MenuScene3D starts in it).
let _rememberedPoseStyle = MENU_POSE_DEFAULT;

/** @returns {'new'|'old'} the title-screen pose style in force (the dev tick box reads it for its initial state) */
export function getMenuPoseStyle() { return _rememberedPoseStyle; }

/**
 * The menu camera position at orbit-clock time `orbitT`: the single source of the sway math (the live camera, reduced
 * motion and the tests all use it).
 * @param {number} orbitT - orbit clock, seconds
 * @param {{centreAng?: number, centreCamY?: number, orbitR?: number, damp?: number, angAmp?: number, camYAmp?: number}} [o]
 *   sway centre azimuth and elevation, orbit radius (m), sway scale (0 = frozen on the centre, 1 = full), azimuth and
 *   elevation amplitudes (default: the new style's; `MENU_POSE_STYLES.old` carries the old menu's)
 * @param {THREE.Vector3} [out]
 * @returns {THREE.Vector3} camera position, ship frame (m)
 */
export function menuCameraPosition(orbitT, o = {}, out = new THREE.Vector3()) {
  const centreAng = o.centreAng ?? SWAY_ANG_CENTRE;
  const centreCamY = o.centreCamY ?? SWAY_CAMY_CENTRE;
  const orbitR = o.orbitR ?? SWAY_ORBIT_R;
  const damp = o.damp ?? 1;
  const angAmp = o.angAmp ?? SWAY_ANG_AMP;
  const camYAmp = o.camYAmp ?? SWAY_CAMY_AMP;
  const ang  = centreAng  + Math.sin(orbitT * SWAY_ANG_FREQ)  * angAmp  * damp;
  const camY = centreCamY + Math.sin(orbitT * SWAY_CAMY_FREQ) * camYAmp * damp;
  return out.set(Math.cos(ang) * orbitR, camY, Math.sin(ang) * orbitR);
}

// The hero's menu pose (DECISIONS §55 rows 1-2): struts straight forward (180°, "the same pivot math as the game ship"),
// radiators at the 146° stow angle, wings rolled up.
const HERO_STRUT_RAD = Math.PI;

// The menu hero is a SINGLE ship on an empty scene, without the main scene's fragment-bound cost, so it must not
// inherit SceneManager's lowered HIGH pixelRatioCap (1.5, Constants.js C.1 note) or the silhouette aliases against the
// live backdrop. Own table: crisp at HIGH (2), stepping down on weaker tiers. MSAA is 4× on HalfFloat (RGBA16F), the
// proven-portable ceiling for float targets. Bloom still matches QUALITY_TIERS (HIGH/MEDIUM on, LOW off).
const MENU_QUALITY = {
  HIGH:   { pixelRatioCap: 2,   msaaSamples: 4, enableBloom: true  },
  MEDIUM: { pixelRatioCap: 1.5, msaaSamples: 4, enableBloom: true  },
  LOW:    { pixelRatioCap: 1,   msaaSamples: 0, enableBloom: false },
};
function menuQualityFor(tier) {
  return MENU_QUALITY[tier] || MENU_QUALITY.HIGH;
}

// The menu canvas is TRANSPARENT so the live game scene (Earth, Starfield, debris, satellites) shows through from
// the main renderer. No scene.background and no menu-local starfield (they would occlude or double up the reveal):
// see init().

function _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function _easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

// Relaxed coiled umbilical control points from anchor `a` (PLSS) to hull `h`: one soft belly loop reads as an
// untensioned line in micro-g. The STATIC idle shape and the start state the reel-in straightens.
function tetherCoilPoints(a, h) {
  const mid = a.clone().add(h).multiplyScalar(0.5);
  const p1 = a.clone().add(new THREE.Vector3(M * 0.08, -M * 0.15, M * 0.06));
  const p2 = mid.clone().add(new THREE.Vector3(M * 0.03, -M * 0.36, M * 0.13)); // belly bottom
  const p3 = mid.clone().add(new THREE.Vector3(-M * 0.07, -M * 0.05, -M * 0.03)); // loop back up
  const p4 = h.clone().add(new THREE.Vector3(M * 0.02, -M * 0.11, -M * 0.02));
  return [a.clone(), p1, p2, p3, p4, h.clone()];
}

// Soft additive glow sprite (weld pool / hot spot).
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

// Astronaut/prop materials only (the hero ship is a real PlayerSatellite with its own); cap/collar/rcs stay because
// the astronaut's SAFER + tool accents use them.
function makeMaterials() {
  return {
    cap:      new THREE.MeshStandardMaterial({ color: 0x4a4a52, metalness: 0.7, roughness: 0.5 }),
    // Matches PlayerSatellite collarMat
    collar:   new THREE.MeshStandardMaterial({ color: 0x8888a0, metalness: 0.75, roughness: 0.28 }),
    rcs:      new THREE.MeshStandardMaterial({ color: 0x555566, metalness: 0.65, roughness: 0.45 }),

    // EVA suit (NASA EMU): mostly soft white fabric, few bright metal parts. Laddered values: the suit in a warm,
    // quiet band, the PLSS pack a clear step below (≈0.65× suit) so head and pack separate from the rear quarter,
    // red accents against the cool field.
    suitWhite: new THREE.MeshStandardMaterial({ color: 0xede9e1, metalness: 0.0, roughness: 0.95 }),
    suitGray:  new THREE.MeshStandardMaterial({ color: 0x9ea1a9, metalness: 0.0, roughness: 0.9 }),
    // Fabric folds: slightly shaded so the accordion joints read as cloth, NOT silver hoops.
    suitFold:  new THREE.MeshStandardMaterial({ color: 0xd6cfc4, metalness: 0.0, roughness: 1.0 }),
    visor:     new THREE.MeshStandardMaterial({ color: 0xc8951f, metalness: 0.95, roughness: 0.08,
                 envMapIntensity: 1.5 }),
    plss:      new THREE.MeshStandardMaterial({ color: 0xb6aea4, metalness: 0.06, roughness: 0.8 }),
    glove:     new THREE.MeshStandardMaterial({ color: 0xcfc9bf, metalness: 0.0, roughness: 0.95 }),
    boot:      new THREE.MeshStandardMaterial({ color: 0xccc6bc, metalness: 0.0, roughness: 0.92 }),
    bootSole:  new THREE.MeshStandardMaterial({ color: 0x33343a, metalness: 0.1, roughness: 0.8 }),
    // Muted aluminium bearing ring, NOT chrome
    suitRing:  new THREE.MeshStandardMaterial({ color: 0xa79e90, metalness: 0.35, roughness: 0.6 }),
    tool:      new THREE.MeshStandardMaterial({ color: 0x55565f, metalness: 0.6, roughness: 0.4 }),
    // Red EV-crew stripe (EV1 marking on the thigh)
    evRed:     new THREE.MeshStandardMaterial({ color: 0xed1c24, metalness: 0.0, roughness: 0.9 }),
  };
}

// Bulky EVA glove as a fist GRIPPING a tool handle running vertically (local Y) through the palm, offset forward
// (+Z); four curled fingers wrap the front, an opposed thumb closes the grip. `thumbSide` = +1 / −1: left / right hand.
function buildGrippingGlove(mat, thumbSide) {
  const g = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.SphereGeometry(M * 0.05, 10, 8), mat.glove);
  palm.scale.set(1.05, 0.92, 1.12);
  g.add(palm);
  const knuckles = new THREE.Mesh(
    new THREE.CapsuleGeometry(M * 0.016, M * 0.06, 3, 6), mat.glove);
  knuckles.rotation.z = Math.PI / 2;          // lie across the hand (local X)
  knuckles.position.set(0, M * 0.018, M * 0.03);
  g.add(knuckles);
  // Four fingers: horizontal capsules stacked down local Y.
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(M * 0.0115, M * 0.034, 3, 6), mat.glove);
    f.rotation.z = Math.PI / 2;               // capsule axis → local X (across handle)
    f.position.set(0, M * (0.032 - i * 0.019), M * 0.05);
    g.add(f);
  }
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(M * 0.015, M * 0.036, 3, 6), mat.glove);
  thumb.position.set(thumbSide * M * 0.042, -M * 0.008, M * 0.036);
  thumb.rotation.set(0.7, 0, thumbSide * 0.9);
  g.add(thumb);
  return g;
}

// NASA EMU orbital EVA boot: a single EXTRUDED side-profile (heel → ankle → instep → up-turned toe) with a
// beveled puffy edge, a curved black OUTSOLE that rises with the toe, and a gathered cuff. NO deep tread: orbital
// EVA needs no traction (the waffle sole is the Apollo LUNAR overshoe). Own frame: ankle opening +Y, foot +Z, sole −Y.
function buildEVABoot(mat) {
  const boot = new THREE.Group();
  const S = M;   // profile coords are in metres, same scale as the rest of the suit

  const shapeFrom = (pts) => {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0] * S, pts[0][1] * S);
    // splineThru (Catmull-Rom), not lineTo: a ROUNDED soft-goods bootie, not a faceted wedge.
    s.splineThru(pts.slice(1).map((p) => new THREE.Vector2(p[0] * S, p[1] * S)));
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

  // Side profile (Z_boot, Y_boot): rounded heel, low ankle, instep slope, blunt ROUNDED toe (EMU booties are bulbous).
  const upper = [
    [-0.085, -0.080], [-0.098, -0.030], [-0.092, 0.020], [-0.065, 0.052],
    [ 0.005,  0.058], [ 0.075,  0.028], [ 0.140,  0.004],
    [ 0.184,  0.000], [ 0.202, -0.038], [ 0.182, -0.082],
  ];
  const soleP = [
    [-0.087, -0.050], [-0.087, -0.086], [0.182, -0.086],
    [ 0.208, -0.048], [ 0.192, -0.010], [0.140, -0.052],
  ];

  const footUpper = new THREE.Mesh(extrude(upper, 0.150, 0.024), mat.boot);
  boot.add(footUpper);

  const footSole = new THREE.Mesh(extrude(soleP, 0.128, 0.014), mat.bootSole);
  footSole.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  boot.add(footSole);

  const cuff = new THREE.Mesh(new THREE.TorusGeometry(M * 0.066, M * 0.020, 8, 18), mat.suitFold);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, M * 0.052, -M * 0.02);
  boot.add(cuff);

  return boot;
}

function buildAstronaut(mat, flagCode = 'USA') {
  const astro = new THREE.Group();
  astro.name = 'EVAAstronaut';

  // Convolute folds: broad, low-relief FABRIC joints, not shiny hoops. Tube radius scales with the limb.
  const addConvolutes = (parent, count, yTop, yBot, radius) => {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, M * 0.016, 6, 16), mat.suitFold);
      ring.position.y = lerp(yTop, yBot, t);
      ring.rotation.x = Math.PI / 2;
      ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      parent.add(ring);
    }
  };

  // Helmet: EMU bubble, ≈ 0.32 m dia. Target ~1.85 m suited astronaut; shoulders (arm roots) at y=0.50, helmet
  // centre ~0.22 m above on a short neck.
  const helmetGeo = new THREE.SphereGeometry(M * 0.16, 18, 16);
  const helmet = new THREE.Mesh(helmetGeo, mat.suitWhite);
  helmet.position.y = M * 0.72;
  helmet.scale.set(1.0, 1.04, 1.08);   // slightly deeper front-back (EMU bubble)
  astro.add(helmet);

  // Gold sun visor over the front hemisphere. The dome faces local +Z by default → R_y(-π/2) → world -X (toward
  // Mother). Sweep 0.80π so the gold wraps low over the rim and shows from the rear-quarter camera.
  const visorGeo = new THREE.SphereGeometry(M * 0.165, 18, 14,
    0, Math.PI, 0, Math.PI * 0.80);
  const visorMat = mat.visor;          // sole consumer — set polygonOffset in place (no clone)
  visorMat.polygonOffset = true;
  visorMat.polygonOffsetFactor = -2;
  visorMat.polygonOffsetUnits  = -2;
  const visor = new THREE.Mesh(visorGeo, visorMat);
  visor.position.y = M * 0.72;
  visor.scale.set(1.06, 1.05, 1.10);   // wrap just outside the helmet shell
  visor.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(visor);
  // The render loop flashes the visor when the weld arc strikes.
  astro.userData.visorMat = visorMat;

  // From the rear quarter the white helmet merges into the white PLSS: a crown valence ridge (ear-to-ear arc) reads
  // as the helmet cap, and a dark neck ring fakes an AO gap above the HUT torso.
  const crownValence = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.148, M * 0.02, 8, 24, Math.PI), mat.suitGray);
  crownValence.rotation.y = Math.PI / 2;   // arc over the crown, face-on to the rear camera
  crownValence.position.y = M * 0.72;
  crownValence.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(crownValence);
  const neckCollar = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.112, M * 0.112, M * 0.045, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x35383f, roughness: 1, metalness: 0 }));
  neckCollar.position.y = M * 0.545;   // fake AO gap detaching helmet from torso
  astro.add(neckCollar);

  // TV camera boss on top of the helmet
  const camBoss = new THREE.Mesh(
    new THREE.BoxGeometry(M * 0.10, M * 0.04, M * 0.06), mat.suitGray);
  camBoss.position.set(0, M * 0.86, -M * 0.02);
  astro.add(camBoss);
  for (const lx of [-M * 0.065, M * 0.065]) {
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.015, M * 0.015, M * 0.03, 8), mat.suitGray);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(lx, M * 0.85, M * 0.11);
    astro.add(lamp);
  }

  const neckRing = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.105, M * 0.018, 8, 20), mat.suitRing);
  neckRing.position.y = M * 0.555;
  neckRing.rotation.x = Math.PI / 2;
  astro.add(neckRing);

  // HUT (Hard Upper Torso)
  const hutGeo = new THREE.CylinderGeometry(M * 0.235, M * 0.185, M * 0.34, 14);
  const hut = new THREE.Mesh(hutGeo, mat.suitWhite);
  hut.position.y = M * 0.39;
  astro.add(hut);
  // No DCM chest module: the −X chest face points at the Mother, never at the camera.

  // PLSS backpack, a tall slab behind the HUT (real EMU PLSS ≈ 0.80 × 0.58 × 0.25 m); defines the bulky silhouette.
  const plssGeo = new THREE.BoxGeometry(M * 0.44, M * 0.56, M * 0.24);
  const plss = new THREE.Mesh(plssGeo, mat.plss);
  plss.position.set(0, M * 0.42, -M * 0.205);
  astro.add(plss);
  const plssTop = new THREE.Mesh(new THREE.BoxGeometry(M * 0.42, M * 0.05, M * 0.22), mat.suitGray);
  plssTop.position.set(0, M * 0.70, -M * 0.205);
  astro.add(plssTop);
  const plssBot = new THREE.Mesh(new THREE.BoxGeometry(M * 0.40, M * 0.06, M * 0.20), mat.suitGray);
  plssBot.position.set(0, M * 0.15, -M * 0.205);
  astro.add(plssBot);

  // PLSS back face at z ≈ −0.325
  const plssBackZ = -M * 0.205 - M * 0.12;
  const accessPanel = new THREE.Mesh(
    new THREE.BoxGeometry(M * 0.30, M * 0.34, M * 0.015), mat.suitGray);
  accessPanel.position.set(0, M * 0.44, plssBackZ - M * 0.006);
  accessPanel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(accessPanel);
  for (const sx of [-1, 1]) {
    for (const ly of [0.56, 0.44, 0.32]) {
      const latch = new THREE.Mesh(
        new THREE.BoxGeometry(M * 0.03, M * 0.04, M * 0.03), mat.suitRing);
      latch.position.set(sx * M * 0.17, M * ly, plssBackZ + M * 0.01);
      latch.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      astro.add(latch);
    }
  }
  const caution = new THREE.Mesh(
    new THREE.PlaneGeometry(M * 0.10, M * 0.05),
    new THREE.MeshStandardMaterial({ color: 0xd8b021, roughness: 0.7,
      emissive: 0x3a2c00, emissiveIntensity: 0.15 }));
  caution.position.set(-M * 0.10, M * 0.62, plssBackZ - M * 0.013);
  caution.rotation.y = Math.PI;   // face aft (−Z)
  caution.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  astro.add(caution);
  const antStub = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.006, M * 0.006, M * 0.08, 6), mat.suitGray);
  antStub.position.set(M * 0.15, M * 0.74, -M * 0.26);
  antStub.rotation.x = -0.25;
  astro.add(antStub);

  // SAFER (Simplified Aid For EVA Rescue): propulsive module wrapping the PLSS base, thruster pods at the corners.
  const safer = new THREE.Group();
  safer.position.set(0, M * 0.12, -M * 0.30);
  const saferBase = new THREE.Mesh(new THREE.BoxGeometry(M * 0.52, M * 0.10, M * 0.18), mat.suitGray);
  safer.add(saferBase);
  for (const sx of [-1, 1]) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(M * 0.055, M * 0.22, M * 0.16), mat.suitGray);
    tower.position.set(sx * M * 0.235, M * 0.13, 0);
    safer.add(tower);
    for (const sy of [-1, 1]) {
      const py = M * (0.13 + sy * 0.12);
      const pod = new THREE.Mesh(new THREE.BoxGeometry(M * 0.06, M * 0.06, M * 0.07), mat.cap);
      pod.position.set(sx * M * 0.255, py, 0);
      safer.add(pod);
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

  for (const side of [-1, 1]) {
    const hoseGeo = new THREE.CylinderGeometry(M * 0.016, M * 0.016, M * 0.24, 5);
    const hose = new THREE.Mesh(hoseGeo, mat.suitGray);
    hose.position.set(side * M * 0.10, M * 0.52, -M * 0.04);
    hose.rotation.z = side * 0.28;
    astro.add(hose);
  }

  // LTA (lower torso assembly: brief + hip)
  const ltaGeo = new THREE.CylinderGeometry(M * 0.185, M * 0.165, M * 0.22, 14);
  const lta = new THREE.Mesh(ltaGeo, mat.suitWhite);
  lta.position.y = M * 0.11;
  astro.add(lta);

  const waist = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.185, M * 0.016, 6, 20), mat.suitRing);
  waist.position.y = M * 0.235;
  waist.rotation.x = Math.PI / 2;
  astro.add(waist);
  const hipRing = new THREE.Mesh(
    new THREE.TorusGeometry(M * 0.165, M * 0.016, 6, 20), mat.suitRing);
  hipRing.position.y = M * 0.01;
  hipRing.rotation.x = Math.PI / 2;
  astro.add(hipRing);

  // Shoulder caps (EMU scye bearings, rounded white epaulets) are attached to astro, NOT to the arm groups, so they
  // stay fixed while the arms rotate. They intersect the HUT side wall (inner edge ~0.107 < HUT top radius 0.24), so
  // renderOrder makes the cap surface win the depth tie.
  for (const side of [-1, 1]) {
    const sCapGeo = new THREE.SphereGeometry(M * 0.092, 10, 8);
    const sCap = new THREE.Mesh(sCapGeo, mat.suitWhite);
    sCap.position.set(side * M * 0.225, M * 0.51, 0);
    sCap.scale.set(1.28, 0.76, 1.12);
    sCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    astro.add(sCap);
  }

  // LEFT arm (anatomical RIGHT arm), secondary-tool hold pose
  const lShoulder = new THREE.Group();
  lShoulder.position.set(-M * 0.24, M * 0.50, 0);
  lShoulder.rotation.z = -0.45;   // moderate outward splay
  lShoulder.rotation.x = -0.20;   // forward raise — arm actively holds tool
  lShoulder.rotation.y = -0.10;   // inward twist for natural grip posture

  const armGeo = new THREE.CylinderGeometry(M * 0.078, M * 0.068, M * 0.28, 12);
  const lUpper = new THREE.Mesh(armGeo, mat.suitWhite);
  lUpper.position.y = -M * 0.14;
  lShoulder.add(lUpper);

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

  const lWristGeo = new THREE.TorusGeometry(M * 0.062, M * 0.012, 6, 14);
  const lWrist = new THREE.Mesh(lWristGeo, mat.suitRing);
  lWrist.position.y = -M * 0.24;
  lWrist.rotation.x = Math.PI / 2;
  lForearmGroup.add(lWrist);

  // Red forearm band echoes the thigh stripe (the only feature proven to survive small sizes), so the figure reads from the rear.
  const lBand = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.064, M * 0.060, M * 0.045, 14, 1, true), mat.evRed);
  lBand.position.y = -M * 0.16;
  lBand.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  lForearmGroup.add(lBand);

  const lHand = buildGrippingGlove(mat, +1);
  lHand.position.y = -M * 0.27;
  lForearmGroup.add(lHand);

  const secToolGeo = new THREE.CylinderGeometry(M * 0.018, M * 0.014, M * 0.16, 6);
  const secTool = new THREE.Mesh(secToolGeo, mat.tool);
  secTool.position.set(0, -M * 0.31, M * 0.05);   // runs through the finger curl
  secTool.rotation.x = +0.18;
  lForearmGroup.add(secTool);
  const secHeadGeo = new THREE.CylinderGeometry(M * 0.022, M * 0.018, M * 0.03, 6);
  const secHead = new THREE.Mesh(secHeadGeo, mat.collar);
  secHead.position.set(0, -M * 0.39, M * 0.063);
  secHead.rotation.x = +0.18;
  lForearmGroup.add(secHead);

  lShoulder.add(lForearmGroup);

  // Convolutes ONLY at the elbow: a real EMU arm is smooth between the scye bearing and the wrist; the folds bunch
  // at the elbow, they don't ladder the whole arm.
  addConvolutes(lShoulder, 2, -M * 0.20, -M * 0.26, M * 0.073);      // elbow, upper side
  addConvolutes(lForearmGroup, 1, -M * 0.035, -M * 0.035, M * 0.064); // elbow, forearm side
  // Quilting: broader self-shadowing bands restore the puffy fabric read that flat lighting erases (same for the legs).
  addConvolutes(lForearmGroup, 2, -M * 0.08, -M * 0.17, M * 0.066);
  // Wrist cuff checklist
  const cuffList = new THREE.Mesh(new THREE.BoxGeometry(M * 0.055, M * 0.06, M * 0.018), mat.suitWhite);
  cuffList.position.set(-M * 0.05, -M * 0.15, 0);
  cuffList.rotation.y = -0.4;
  cuffList.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  lForearmGroup.add(cuffList);

  astro.add(lShoulder);

  // RIGHT arm — WELDING ARM (anatomical LEFT). Solved so tool_parent_x=0.90-0.432=0.468≈weld.x 0.48 and
  // tool_parent_z=astro.z+0.686=0.85; the tool tip stays outside the hull (radial dist 0.491 > bus_radius 0.40).
  const rShoulder = new THREE.Group();
  rShoulder.position.set(M * 0.24, M * 0.50, 0);
  rShoulder.rotation.z =  0.00;
  rShoulder.rotation.x = -0.80;
  rShoulder.rotation.y = +0.40;   // ry gives tool_astro_x=0.473, so the body sits at z≈0.53 (near barrel end)

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

  const rWristGeo = new THREE.TorusGeometry(M * 0.062, M * 0.012, 6, 14);
  const rWrist = new THREE.Mesh(rWristGeo, mat.suitRing);
  rWrist.position.y = -M * 0.24;
  rWrist.rotation.x = Math.PI / 2;
  rForearmGroup.add(rWrist);

  const rBand = new THREE.Mesh(
    new THREE.CylinderGeometry(M * 0.064, M * 0.060, M * 0.045, 14, 1, true), mat.evRed);
  rBand.position.y = -M * 0.16;
  rBand.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  rForearmGroup.add(rBand);

  const rGlove = buildGrippingGlove(mat, -1);
  rGlove.position.y = -M * 0.27;
  rForearmGroup.add(rGlove);

  // Welding tool, tip aimed at the hull
  const toolGeo = new THREE.CylinderGeometry(M * 0.012, M * 0.016, M * 0.20, 6);
  const tool = new THREE.Mesh(toolGeo, mat.tool);
  tool.position.set(M * 0.01, -M * 0.32, M * 0.05);  // runs through the finger curl
  tool.rotation.x = -0.30;   // tip angles forward toward surface
  tool.rotation.z =  0.08;   // slight inward tilt matching wrist pronation
  rForearmGroup.add(tool);
  const tipGeo = new THREE.CylinderGeometry(M * 0.008, M * 0.012, M * 0.04, 5);
  const tip = new THREE.Mesh(tipGeo, mat.tool);
  tip.position.set(M * 0.012, -M * 0.43, M * 0.058);
  tip.rotation.x = -0.30;
  tip.rotation.z =  0.08;
  rForearmGroup.add(tip);
  // The weld glow/sparks lock to the tool tip (closest point to the arc).
  astro.userData.toolTip = tip;

  rShoulder.add(rForearmGroup);

  addConvolutes(rShoulder, 2, -M * 0.20, -M * 0.26, M * 0.073);      // elbow, upper side
  addConvolutes(rForearmGroup, 1, -M * 0.035, -M * 0.035, M * 0.064); // elbow, forearm side
  addConvolutes(rForearmGroup, 2, -M * 0.08, -M * 0.17, M * 0.066);   // quilting

  astro.add(rShoulder);

  // Legs: BAGGY soft-goods, not skin-tight tubes; fat near-uniform segments, cloth folds at the joints, almost no
  // exposed metal. Relaxed, slightly asymmetric micro-g float. Both leg/shank groups are collected for the exit pose.
  const legPose = [];
  for (const side of [-1, 1]) {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * M * 0.085, M * 0.0, 0);
    legGroup.rotation.z = side * 0.13;                       // splay apart at the hips
    // Thighs flexed FORWARD (toward the work), asymmetric so she isn't a rigid standing figure.
    legGroup.rotation.x = side < 0 ? -0.20 : -0.44;

    const hip = new THREE.Mesh(new THREE.SphereGeometry(M * 0.10, 10, 8), mat.suitWhite);
    hip.scale.set(1.0, 0.85, 1.0);
    legGroup.add(hip);

    const thigh = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.108, M * 0.100, M * 0.42, 14), mat.suitWhite);
    thigh.position.y = -M * 0.22;
    legGroup.add(thigh);

    // Fabric knee (no metal); the shank pivots here.
    const kneeY = -M * 0.43;
    const shankGroup = new THREE.Group();
    shankGroup.position.y = kneeY;
    shankGroup.rotation.x = side < 0 ? 0.72 : 0.48;         // knees bent (floating, not standing)

    const shin = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.094, M * 0.082, M * 0.40, 14), mat.suitWhite);
    shin.position.y = -M * 0.20;
    shankGroup.add(shin);

    const calf = new THREE.Mesh(new THREE.SphereGeometry(M * 0.062, 9, 7), mat.suitWhite);
    calf.scale.set(1.0, 1.5, 0.95);
    calf.position.set(0, -M * 0.13, -M * 0.028);
    shankGroup.add(calf);

    // Boot: see buildEVABoot. The ankle cants slightly, asymmetrically.
    const bootGroup = new THREE.Group();
    bootGroup.position.set(0, -M * 0.42, 0);

    const footGroup = new THREE.Group();           // ankle pivot
    footGroup.rotation.x = side < 0 ? 0.10 : 0.04; // slight relaxed cant (asymmetric)

    const boot = buildEVABoot(mat);
    boot.position.y = -M * 0.03;                   // drop so the cuff meets the shin
    footGroup.add(boot);

    bootGroup.add(footGroup);
    shankGroup.add(bootGroup);

    addConvolutes(legGroup,   2, -M * 0.35, -M * 0.42, M * 0.101);  // lower thigh → knee
    addConvolutes(shankGroup, 2, -M * 0.02, -M * 0.09, M * 0.093);  // knee → upper shin
    addConvolutes(shankGroup, 1, -M * 0.36, -M * 0.36, M * 0.083);  // ankle
    addConvolutes(legGroup,   3, -M * 0.10, -M * 0.30, M * 0.106);  // thigh puff bands
    addConvolutes(shankGroup, 2, -M * 0.16, -M * 0.28, M * 0.090);  // shank puff bands

    const tCable = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.005, M * 0.005, M * 0.30, 4), mat.bootSole);
    tCable.position.set(0, -M * 0.22, M * 0.103);
    tCable.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    legGroup.add(tCable);

    const idStripe = new THREE.Mesh(
      new THREE.CylinderGeometry(M * 0.112, M * 0.106, M * 0.055, 14, 1, true), mat.evRed);
    idStripe.position.y = -M * 0.27;
    idStripe.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    legGroup.add(idStripe);

    legGroup.add(shankGroup);
    legPose.push({ leg: legGroup, shank: shankGroup });
    astro.add(legGroup);
  }

  // National flag shoulder patch on the left upper arm, following the selected menu language (core/Languages.js →
  // flag code). FlagDecalSystem paints a canvas mapped onto one curved cylinder segment, so ANY flag wraps the arm
  // and can be swapped at runtime.
  const flagH = M * 0.085;
  const armR  = M * 0.076;                  // upper-arm radius near the patch
  const arc   = 1.6;                         // ~92° wrap, centred on the outer (−X) face
  const thetaStart = 3 * Math.PI / 2 - arc / 2;
  const flagGroup = new THREE.Group();
  flagGroup.position.y = -M * 0.12;

  const flagBorder = new THREE.Mesh(
    new THREE.CylinderGeometry(armR * 0.996, armR * 0.996, flagH + M * 0.012, 20, 1, true,
      3 * Math.PI / 2 - (arc * 1.14) / 2, arc * 1.14),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 1, side: THREE.DoubleSide }));
  flagBorder.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
  flagGroup.add(flagBorder);

  // The cylinder's V (height) carries the flag's vertical axis and U (arc) its horizontal axis.
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

  // Swap hook: repaint on a language change without rebuilding the astronaut; no-ops redundant sets.
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

  // Exit-beat handles: welding arm (tucks to chest on the acknowledgment turn), SAFER pack (cold-gas puff anchor at
  // jet-off), left (free) shoulder + both leg/shank groups (posed and reset by the exit beat).
  astro.userData.weldArm = rShoulder;
  astro.userData.safer = safer;
  astro.userData.lShoulder = lShoulder;
  astro.userData.legPose = legPose;

  return astro;
}

function buildSparkSystem() {
  const positions = new Float32Array(SPARK_COUNT * 3);
  const colors    = new Float32Array(SPARK_COUNT * 3);
  const sizes     = new Float32Array(SPARK_COUNT);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

  // Hard bright core, rapid falloff (not a soft blob)
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
  // 28%: arc-flash core, for visor reflection
  const isFlash = Math.random() < 0.28;
  spark.isFlash = isFlash;
  spark.life = isFlash
    ? SPARK_LIFE * (0.15 + Math.random() * 0.25)   // flash: 0.07–0.16s
    : SPARK_LIFE * (0.50 + Math.random() * 0.65);   // spark: 0.22–0.52s
  // Tight cone around +X (away from the hull normal)
  const theta   = Math.random() * Math.PI * 2;
  const coneMax = isFlash ? 0.20 : 0.55;           // directional spray
  const phi     = Math.random() * coneMax;
  const spd     = SPARK_SPEED * (isFlash
    ? (0.90 + Math.random() * 0.40)                 // flash
    : (0.45 + Math.random() * 0.70));               // spark: wide speed spread
  spark.vx = Math.cos(phi) * spd;
  spark.vy = Math.sin(phi) * Math.cos(theta) * spd * 0.65;
  spark.vz = Math.sin(phi) * Math.sin(theta) * spd * 0.65;
}

function updateSparks(sparkSystem, weldPos, dt, emitRate = 30) {
  const { sparks, geo } = sparkSystem;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;
  const siz = geo.attributes.size.array;

  // sparks/s; emitRate 0 (departure) integrates existing sparks to death without new emission.
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

      pos[i * 3]     += s.vx * dt;
      pos[i * 3 + 1] += s.vy * dt;
      pos[i * 3 + 2] += s.vz * dt;

      // Drag (molten droplets lose energy fast)
      s.vx *= 0.96;
      s.vy *= 0.96;
      s.vz *= 0.96;
      // Gravity arc
      s.vy -= 0.50 * dt;

      const t = s.age / s.life;

      if (s.isFlash) {
        // Arc flash: warm-white burst, bright enough to reflect off the gold visor
        const f0 = Math.max(0, 1.0 - t * 2.5);
        col[i * 3]     = f0 * 1.0;
        col[i * 3 + 1] = f0 * 0.98;
        col[i * 3 + 2] = f0 * 0.95;
        siz[i] = f0 * 2.2;
      } else {
        // Normal spark: white-hot core → electric blue → dim cyan → gone
        if (t < 0.20) {
          const k = t / 0.20;
          col[i * 3]     = 1.00 - k * 0.40;   // 1.0 → 0.60
          col[i * 3 + 1] = 1.00 - k * 0.20;   // 1.0 → 0.80
          col[i * 3 + 2] = 1.00;
        } else if (t < 0.60) {
          const k = (t - 0.20) / 0.40;
          col[i * 3]     = 0.60 - k * 0.50;   // 0.60 → 0.10
          col[i * 3 + 1] = 0.80 - k * 0.60;   // 0.80 → 0.20
          col[i * 3 + 2] = 1.00;
        } else {
          const fade = (1.0 - t) * 1.67;       // 0.67→0.0
          col[i * 3]     = 0.06 * fade;
          col[i * 3 + 1] = 0.15 * fade;
          col[i * 3 + 2] = 0.70 * fade;
        }
        // Grow briefly, then shrink
        const bloom = t < 0.15 ? t / 0.15 : (1.0 - t) / 0.85;
        siz[i] = bloom * 0.75 + 0.05;
      }
    }
  }

  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate    = true;
  geo.attributes.size.needsUpdate     = true;
}

// One-shot burst of up to n dead sparks from the weld tip (the "final spark" as the welder releases the trigger).
function emitSparkBurst(sparkSystem, weldPos, n) {
  const { sparks, geo } = sparkSystem;
  const pos = geo.attributes.position.array;
  let emitted = 0;
  for (let i = 0; i < sparks.length && emitted < n; i++) {
    const s = sparks[i];
    if (s.alive) continue;
    emitSpark(s);
    pos[i * 3]     = weldPos.x;
    pos[i * 3 + 1] = weldPos.y;
    pos[i * 3 + 2] = weldPos.z;
    emitted++;
  }
  geo.attributes.position.needsUpdate = true;
}

/**
 * Neutralize the gameplay handlers of a display-only PlayerSatellite. Its constructor subscribes to the GLOBAL
 * eventBus, so a hero kept alive outside a live session would react to real gameplay events (duplicate COMMS
 * messages, cold-gas consumed on a phantom ship). We want the MODEL only: stub the handlers that emit events or
 * mutate resources.
 *
 * KEEP THIS LIST IN SYNC: any new PlayerSatellite listener wired at construction whose handler emits an event or
 * bills a resource must be stubbed here too (js/test/test-MenuHeroNeutralization.js pins the list). The remaining
 * handlers (scan-flash timer, hull outline, inertia invalidation, net muzzle/brake FX, net-inventory cap visibility)
 * are display-only or inert because a phantom's update loop never runs.
 *
 * Exported so the test applies the REAL helper to a REAL PlayerSatellite headlessly.
 *
 * @param {PlayerSatellite} mother - phantom, display-only satellite instance
 */
export function neutralizePhantomSatellite(mother) {
  mother.toggleEDT = () => {};
  mother._applyCrossbowRecoil = () => {};
  mother._applyDualFireRecoil = () => {};
  // Emits RESOURCE_CONSUME coldGas (twice, via _autoRcsCompensation) on every NET_FIRED with source==='mother'.
  mother._applyMotherNetRecoil = () => {};
}

// The opening-dance hero helpers below are exported so the hero-pose suite drives the REAL helpers against a REAL
// PlayerSatellite headlessly.

/**
 * Install both aft flower pairs on the menu hero, mirroring the sim ship's FLOWER_PREINSTALLED boot state (main.js
 * applies both pairs through applyUpgrade). Deliberately NOT routed through PlayerSatellite._installFlowerPair: it
 * emits a COMMS_MESSAGE on the global bus, and neutralizePhantomSatellite stubs HANDLERS, not bus emits; a phantom
 * must never talk on the comms channel. Same path minus the comms line: set the pair flag, build, then one
 * detail-mesh re-collect for the new MountBolt_* hardware.
 * @param {PlayerSatellite} mother - phantom, display-only satellite instance
 */
export function installHeroFlowerPairs(mother) {
  if (!Constants.FEATURE_FLAGS.FLOWER_PREINSTALLED) return;
  for (const pairKey of ['A', 'B']) {
    if (mother._flowerPairs[pairKey]) continue;
    mother._flowerPairs[pairKey] = true;
    mother._buildFlowerPair(pairKey);
  }
  // Refresh the DETAIL-LOD cull set, as _installFlowerPair does after each pair.
  mother._collectDetailMeshes();
}

/**
 * Point the hero's four struts at sweep angle `alphaRad` the way the game ship does (`PlayerSatellite._updateStruts`:
 * `strutLocalDirection` → `setFromUnitVectors(-Y, dir)` on the pivot), and turn each docked daughter the way the game
 * turns it (`composeDockedArmQuat`, which `postArmUpdate` applies in the ship frame; here the daughter is a child of
 * the strut tip, so the pivot's turn is divided out). Pure transform writes; emits nothing.
 * @param {PlayerSatellite} mother - phantom, display-only satellite instance
 * @param {ArmUnit[]} daughters - the docked daughters, index i on strut i (may be empty)
 * @param {number} alphaRad - strut sweep angle: 0 aft along the barrel, PI/2 radially out, PI straight forward
 */
export function poseHeroStruts(mother, daughters, alphaRad) {
  const groups = mother.strutGroups || [];
  for (let i = 0; i < groups.length; i++) {
    const sg = groups[i];
    if (!sg || !sg.pivotGroup) continue;
    strutLocalDirection(alphaRad, sg.azRad, _heroDir);
    _heroPivotQ.setFromUnitVectors(_HERO_NEG_Y, _heroDir);
    sg.pivotGroup.setRotationFromQuaternion(_heroPivotQ);
    if (sg.strutDir) sg.strutDir.copy(_heroDir);
    const arm = daughters && daughters[i];
    if (arm && arm.group) {
      composeDockedArmQuat(_heroDir, sg.azRad, _heroDockQ);
      arm.group.quaternion.copy(_heroPivotQ).invert().multiply(_heroDockQ);
    }
  }
}
const _HERO_NEG_Y = new THREE.Vector3(0, -1, 0);
const _heroDir = new THREE.Vector3();
const _heroPivotQ = new THREE.Quaternion();
const _heroDockQ = new THREE.Quaternion();

/**
 * Write the radiator angle on the hero (theta in radians). The launch lock stays armed so an angle below the orbit
 * floor, which the departure fold passes through on its way to closed, is legal. Emits nothing.
 * @param {PlayerSatellite} mother
 * @param {number} thetaRad
 */
function setHeroRadiators(mother, thetaRad) {
  mother._flowerLaunchLock = true;
  mother._flowerOverrideFold = false;
  mother._flowerTargetTheta = undefined;
  mother._flowerThetaRad = thetaRad;
  mother._updateFlower(0);
}

/**
 * Snap the hero to the MENU pose (DECISIONS §55 rows 1-2): struts straight forward (180°), radiators open at the 146°
 * stow angle, wings rolled up. The launch lock is armed so the departure fold below the orbit floor stays legal.
 * Idempotent; emits nothing (the hero must never talk on the bus).
 * @param {PlayerSatellite} mother - phantom, display-only satellite instance
 * @param {ArmUnit[]} [daughters] - the docked daughters, turned with their struts
 */
export function applyHeroMenuPose(mother, daughters = []) {
  const FL = Constants.THERMAL.FLOWER;
  poseHeroStruts(mother, daughters, HERO_STRUT_RAD);
  setHeroRadiators(mother, degToRad(FL.POSE_STOW_DEG));
  mother._setRosaWingProgress(1, 0);
  mother._setRosaWingProgress(2, 0);
  // The hero never runs update()/_updateRosaPanels, so the furl state _animateSolarTracking's blend reads is written
  // here: a furled wing parks its pivot at 0° tilt instead of sun-tracking the rolled cylinder (as on the flown ship).
  mother._rosaFurlProgress = 0;
}

/**
 * The hero's departure fold: from the first frame of the menu departure ("she folds to fly") the struts swing from 180°
 * toward 0° at the real strut rate and the radiators from 146° toward 0° at the real radiator rate, so nothing moves
 * faster than the hardware (DECISIONS §0). The menu cuts to the game's closed ship before the fold ends, as it already
 * skipped the struts' 90° → 0° swing.
 * @param {number} depT - seconds since the departure began (the scene's own `_departure.t`)
 * @returns {{ strutRad: number, radiatorRad: number }}
 */
export function heroDepartureFold(depT) {
  const t = Math.max(0, depT);
  const FL = Constants.THERMAL.FLOWER;
  return {
    strutRad: Math.max(0, HERO_STRUT_RAD - Constants.OCTOPUS_V5.STRUT_SLEW_RATE * t),
    radiatorRad: Math.max(0, degToRad(FL.POSE_STOW_DEG) - FL.SLEW_RATE_RAD_S * t),
  };
}

/**
 * Apply `heroDepartureFold(depT)` to the hero: struts, their daughters and radiators. Wings are not touched (they stay
 * rolled until the cut; see applyHeroDanceProgress). Emits nothing.
 * @param {PlayerSatellite} mother
 * @param {ArmUnit[]} daughters
 * @param {number} depT - seconds since the departure began
 */
export function applyHeroDepartureFold(mother, daughters, depT) {
  const f = heroDepartureFold(depT);
  poseHeroStruts(mother, daughters, f.strutRad);
  setHeroRadiators(mother, f.radiatorRad);
}

/**
 * Drive the hero's WINGS from the opening-dance clock for one frame; MenuScene3D._tick calls it with
 * openingDance.progress() (the phantom's update() never runs). Pure mesh writes, emits nothing. Radiators and struts
 * are NOT driven from the dance clock: its `flower` is 0 until after the cut (it would snap the open radiators shut on
 * the first departure frame), so applyHeroDepartureFold drives them from the departure's own clock.
 * @param {PlayerSatellite} mother - phantom, display-only satellite instance
 * @param {{ wing1?: number, wing2?: number }} p - dance progress
 */
export function applyHeroDanceProgress(mother, p) {
  // Clamp: a driver bug must not push the pose past the hardware band (the wing roll-out scale has no internal bound).
  const wing1 = _clamp01(p.wing1 ?? 0);
  const wing2 = _clamp01(p.wing2 ?? 0);
  mother._setRosaWingProgress(1, wing1);
  mother._setRosaWingProgress(2, wing2);
  // Mirrors _updateRosaPanels' dance branch: the AVERAGE, not the min. It must stay identical to it or the tracking
  // blend jumps at the menu→game cut (half of departures are unmasked).
  mother._rosaFurlProgress = (wing1 + wing2) / 2;
}

/**
 * The OLD menu's hero pose (commit 57b98ba7, the `old` style of MENU_POSE_STYLES): struts at the build default 90°
 * (radially out; `poseHeroStruts` writes the same pivot and daughter turns the build left, measured 2026-10-29).
 * Packed (`deployed` false): radiators folded to POSE_LAUNCH_DEG (0°) with the launch lock armed, wings furled.
 * Deployed (reduced motion, or the dance flag off): radiators at 146°, wings fully rolled out, launch lock off (by hand,
 * not snapFlowerToStow(): that emits on the bus). Idempotent; emits nothing.
 * @param {PlayerSatellite} mother - phantom, display-only satellite instance
 * @param {ArmUnit[]} [daughters]
 * @param {boolean} deployed
 */
export function applyHeroOldMenuPose(mother, daughters = [], deployed = false) {
  const FL = Constants.THERMAL.FLOWER;
  poseHeroStruts(mother, daughters, MENU_POSE_STYLES.old.strutRad);
  if (deployed) {
    mother._flowerLaunchLock = false;
    mother._flowerOverrideFold = false;
    mother._flowerTargetTheta = undefined;
    mother._flowerThetaRad = degToRad(FL.POSE_STOW_DEG);
    mother._updateFlower(0);
    mother._setRosaWingProgress(1, 1);
    mother._setRosaWingProgress(2, 1);
    mother._rosaFurlProgress = 1;
  } else {
    setHeroRadiators(mother, degToRad(FL.POSE_LAUNCH_DEG));
    mother._setRosaWingProgress(1, 0);
    mother._setRosaWingProgress(2, 0);
    mother._rosaFurlProgress = 0;
  }
}

/**
 * The OLD menu's dance drive (commit 57b98ba7's `applyHeroDanceProgress`): radiators from POSE_LAUNCH_DEG to POSE_STOW_DEG
 * by the dance's `flower`, plus the wings. Used only in the `old` style. Emits nothing.
 * @param {PlayerSatellite} mother
 * @param {{ flower?: number, wing1?: number, wing2?: number }} p - dance progress
 */
export function applyHeroDanceProgressOld(mother, p) {
  const FL = Constants.THERMAL.FLOWER;
  const flower = _clamp01(p.flower ?? 0);
  mother._flowerThetaRad = lerp(degToRad(FL.POSE_LAUNCH_DEG), degToRad(FL.POSE_STOW_DEG), flower);
  mother._updateFlower(0);
  applyHeroDanceProgress(mother, p);
}

export class MenuScene3D {
  constructor(initialTier = null) {
    this.renderer = null;
    this.scene    = null;
    this.camera   = null;
    this._raf     = null;
    this._clock   = new THREE.Clock(false);
    this._running = false;
    this._paused  = false;       // pause(): own rAF cancelled by the show-mode menu freeze; resume() restarts it
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
    this._contactShadowMat = null;  // contact shadow under the astro
    this._visorMat = null;      // visor material (flashes with the arc)
    this._mother   = null;      // real PlayerSatellite instance (hero ship)
    this._daughters = [];       // real ArmUnit instances docked on the struts
    this._sunDir   = null;      // world-space sun direction (solar tracking)
    this._lookTarget = new THREE.Vector3(0.12, 0, 0.34);  // camera aim (set to weld)

    // Tracks SceneManager's tier so weak devices don't pay full pixelRatio / MSAA / bloom on the menu (values from
    // MENU_QUALITY). Initial tier comes from main.js (SceneManager.currentTier); live changes arrive via
    // Events.PERF_TIER_CHANGED (the adapt loop runs during MENU).
    this._tier = initialTier || Constants.PERF.DEFAULT_QUALITY_TIER || 'HIGH';
    this._tierHandler = null;

    // prefers-reduced-motion: the camera sway freezes at the sway centre and the weld arc is a constant faint glow
    // (no sparks, no flicker). Live-toggled via a matchMedia 'change' listener.
    this._reducedMotion = false;
    this._motionMedia = null;
    this._motionHandler = null;

    // START: beginDeparture() ramps this 0→1 over _departureDur seconds: the weld arc/glow/sparks fade out and the
    // camera eases its orbit radius back (5.5 → 8) so the hero recedes as the live scene behind takes over. null = idle.
    this._departure = null;         // { t, dur } while animating, else null
    this._departureDur = 1.6;       // seconds (skippable)
    this._departureBaseOrbitR = SWAY_ORBIT_R;
    this._departureOrbitR = 8.0;

    // True while the hero sits in the packed pose (set at build and by the menu-return reset). Gates the dance
    // driving in _tick: a reduced-motion or flag-off hero is never packed, so nothing may snap a deployed hero back to theta 0.
    this._heroPacked = false;

    // 'new' or 'old' (MENU_POSE_STYLES): the pose, sway table and tail light in force; switched live by setPoseStyle and
    // remembered across menu returns (module-level _rememberedPoseStyle).
    this._poseStyle = _rememberedPoseStyle;

    // Exit beat: refs + captured base poses are populated in init(); per-departure keyframe state is this._exit
    // (created in beginDeparture).
    this._astroWeldArm = null;
    this._astroSafer = null;
    this._astroBasePos = null;
    this._astroBaseRotY = 0;
    this._astroBaseRotX = 0;   // free-flyer pose base
    this._astroBaseRotZ = 0;
    this._weldArmBaseRotX = 0;
    this._astroLShoulder = null;
    this._lShoulderBaseRotX = 0;
    this._lShoulderBaseRotZ = 0;
    this._astroLegPose = null;
    this._astroLegPoseBase = null;
    this._tether = null;
    this._tetherAnchorLocal = null;
    this._tetherEnd = null;
    this._tetherRadius = 0;
    this._tetherCoil = null;
    this._exitPuffs = [];
    this._exit = null;
    // Per-departure orientation treatment ('partial' | 'flyaround'), random in beginDeparture; plus the opacity-dissolve
    // state of the fly-around exit.
    this._orientMode = 'partial';
    this._astroMats = null;
    this._astroFaded = false;
    this._tmpLook = new THREE.Vector3();   // scratch for the fly-around lookAt (no per-frame alloc)

    // Frame gate: the hero loop is capped to ~60 fps (30 under reduced motion), not 120 on ProMotion, while the rest
    // of the app throttles to 30 Hz during MENU (energy policy §12.12).
    this._lastFrameT = 0;
  }

  /** Initialise the 3D scene into the given canvas element. */
  init(canvas) {
    this._canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // The composer's multisampled HalfFloat target does all AA (_buildComposer, samples>0); a context MSAA backbuffer
      // would be dead memory at pr 2 fullscreen. Trade-off: the composer-failure fallback (_tick's renderer.render when
      // _composer is null) is aliased, acceptable since it only runs if _buildComposer throws.
      antialias: false,
      alpha: true,
    });
    // Tier-driven: _applyTierSettings() at the end of init() sets the authoritative value; 2 is a pre-composer default.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Fully transparent clear: the live game scene composites through from behind this canvas.
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    this.scene.background = null;

    // Image-based reflections so the hull, gold visor and metal rings catch highlights; low intensity keeps the
    // space mood. Non-fatal: skipped on any failure.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this._envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = 0.30;
      pmrem.dispose();
    } catch (err) {
      console.warn('MenuScene3D: environment map skipped:', err);
    }

    const aspect = canvas.clientWidth / canvas.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 200);
    this.camera.position.set(4.2, 1.4, 3.0);
    this.camera.lookAt(0, -0.05, 0);

    // Sun. Deliberately NOT aligned to the sim sun (SunLight.js (1,0.3,0.5)): captures showed the shading change at the
    // handoff is dominated by the camera swing, not the ~16.5° sun delta, and the aligned light over-shadowed the hero.
    const sun = new THREE.DirectionalLight(0xfff8ec, 2.5);
    sun.position.set(5, 3, 4);
    this.scene.add(sun);
    // World-space sun direction; drives the Mother's solar sun-tracking.
    this._sunDir = sun.position.clone().normalize();

    const fill = new THREE.DirectionalLight(0x4466cc, 0.4);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);

    // Cool back light: peels the white suit and gold hull off the dark backdrop (key to a readable silhouette).
    const rim = new THREE.DirectionalLight(0xbcd0ff, 1.6);
    rim.position.set(-4, 2.5, -5);
    this.scene.add(rim);

    // Tail light: the menu now sways to dead behind the ship, where the sun, fill and rim above lit the tail side far
    // dimmer than the old front-right views (ship-pixel mean luminance 116 vs 130-162 for the old menu, probe frames).
    // A warm second key from behind-right-above lifts the tail side to 144 (2.4 and up pushes the plates into the bloom).
    this._tailLight = new THREE.DirectionalLight(0xfff0dc, this._style().tailLight ? TAIL_LIGHT_INTENSITY : 0);
    this._tailLight.position.set(2.5, 2.2, -6);
    this.scene.add(this._tailLight);

    this.scene.add(new THREE.AmbientLight(0x223055, 0.35));

    // Wide enough range to reach the gold visor
    this._weldLight = new THREE.PointLight(0x88aaff, 0.25, 0.55);
    this._weldLight.position.set(0, 0, 0); // updated each frame
    this.scene.add(this._weldLight);

    // Runs BEFORE the hero ship is built so the packed-pose decision below sees the real preference.
    this._initReducedMotion();

    const mat = makeMaterials();

    // Orbit pivot: everything rotates around this
    this._pivot = new THREE.Group();
    this.scene.add(this._pivot);

    // Mother: the REAL PlayerSatellite. The constructor parents it into whatever "scene" we pass, so we hand it the
    // orbit pivot. It also seeds an orbital position + 11 eventBus listeners (10 in the constructor body, plus one
    // wired deeper in _buildModel → _buildNetPods); we zero the position and leave it static (never call update()).
    const mother = new PlayerSatellite(this._pivot);
    mother.position.set(0, 0, 0);            // ignore the orbital position the ctor set
    mother.scale.setScalar(1 / SIM_M);       // 1e5 → sim-metre geometry reads at 1 m
    // Roll −90° about the long axis: in sim the solar wings sit at ±X and the sensor turret at +Y; the hero needs
    // wings at ±Y (clear of the +X weld) and the sensor facing +X (the unit the astronaut services). Struts + ROSA
    // come out of _buildModel already deployed.
    mother.rotation.z = -Math.PI / 2;

    // The constructor wired the sim's eventBus handlers (crossbow recoil, EDT toggle, dual-fire, mother-net recoil);
    // this instance lives for the whole app, so neutralise them with the shared helper (see its doc).
    neutralizePhantomSatellite(mother);
    // No power subsystem drives solarRate here: constant energized ROSA glow (see _animateRosaGlow).
    mother._rosaGlowIdleFloor = 0.55;
    this._mother = mother;

    // Menu pose (DECISIONS §55 rows 1-2): the hero mirrors the sim ship's FLOWER_PREINSTALLED hardware and sits with
    // struts at 180°, radiators at 146° and wings rolled. Applied BEFORE the weld-site snap below reads strutGroups
    // (the daughters, which turn with their struts, are mounted after; the pose is applied again then). Every motion
    // setting shows the same pose; only a motion-allowed hero with the dance flag on may fold when she departs.
    installHeroFlowerPairs(mother);
    this._applyHeroStylePose(mother, []);

    // Only the gold MLI materials get a synthetic orbital env map (sun + void + Earth) so the near-mirror foil reads
    // as broken white/dark patchwork, not a smooth brass pipe; scene.environment stays RoomEnvironment for the
    // astronaut. A per-material envMap ignores scene.environmentIntensity, so brightness is envMapIntensity here.
    mother.applyFoilEnv(this.renderer, 1.0);

    // Daughters: the REAL ArmUnit models docked on the Mother's strut tips. Full Y0 Quad loadout, the sim's CANONICAL
    // per-index types (ArmManager._initArms: i % 2 === 0 ? 'weaver' : 'spinner'): the two big Weavers at 0 & 2
    // (sim-local 60°/240°, ANTIPODAL), the Spinners at 1 & 3 (120°/300°), so the large daughters sit on OPPOSITE sides.
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
      // The ctor adds .group to the scene we pass; reparent it onto the strut tip. It hides its body until an
      // in-game docked animation runs, so force it visible.
      const arm = new ArmUnit(id, type, new THREE.Vector3(), this.scene);
      arm.mesh.visible = true;
      if (arm.tetherLine) arm.tetherLine.visible = false;   // no stray dock tether
      tip.add(arm.group);                    // inherits the tip's deployed pose + scale
      arm.group.position.set(0, 0, 0);
      this._daughters.push(arm);
    }
    // Daughter forward (+Z) → strut direction, the game's own docked-arm basis (poseHeroStruts, via the style's pose).
    this._applyHeroStylePose(mother, this._daughters);

    // Human-scale EVA reference servicing a strut hinge; faces −X (chest toward the barrel). Final placement is
    // SNAPPED below so the tool tip lands exactly on an aluminium strut hinge.
    const astro = buildAstronaut(mat, getLanguage(settingsManager.getLanguage()).flag);
    astro.position.set(M * 0.97, -M * 0.21, M * 0.58);
    astro.rotation.y = -Math.PI / 2;   // local +Z → world -X (chest toward satellite)
    astro.rotation.z = 0.08;           // subtle micro-g tilt
    this._pivot.add(astro);
    this._astro = astro;
    this._visorMat = astro.userData.visorMat || null;

    // Weld site: a real ALUMINIUM strut hinge, NOT the gold MLI foil (you can't weld a thermal blanket). Snap the
    // whole astronaut so its TOOL TIP lands on the hinge nearest its current aim (keeps the reaching pose), then
    // put the weld glow + sparks ON the tool tip, so the arc originates at the tool, not the tether anchor.
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
      astro.position.add(hinge.sub(tPos));
      astro.updateMatrixWorld(true);
      toolTip.getWorldPosition(this._weldPos);
    } else {
      this._weldPos.set(BUS_R, M * 0.12, BUS_LEN * 0.5);   // fallback: barrel
    }

    // Aim the camera partway to the work site, framing the astronaut + arc without over-tilting.
    this._lookTarget.copy(this._weldPos).multiplyScalar(0.7);

    // Contact shadow: a soft radial gradient in an opacity 0.32 quad just past the weld point, facing her; anchors
    // her to the hull for one quad.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 64;
    const sctx = shadowCanvas.getContext('2d');
    const sgrad = sctx.createRadialGradient(32, 32, 4, 32, 32, 32);
    sgrad.addColorStop(0.0, 'rgba(0,0,0,0.55)');
    sgrad.addColorStop(1.0, 'rgba(0,0,0,0)');
    sctx.fillStyle = sgrad;
    sctx.fillRect(0, 0, 64, 64);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shadowCanvas),
      transparent: true, opacity: 0.32, depthWrite: false,
    });
    const shadowQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(M * 1.1, M * 1.6), shadowMat);
    const n = this._astro.position.clone().sub(this._weldPos).normalize();
    shadowQuad.position.copy(this._weldPos).addScaledVector(n, 0.02);
    shadowQuad.lookAt(this._astro.position);
    this._pivot.add(shadowQuad);
    this._contactShadowMat = shadowMat;

    // STATIC point light: set once here after _weldPos is final, not every frame in _tick.
    this._weldLight.position.copy(this._weldPos);

    // Weld-pool glow on the hinge; pulses with the arc (see _tick).
    this._weldGlow = makeGlowSprite();
    this._weldGlow.position.copy(this._weldPos);
    this._weldGlow.scale.setScalar(M * 0.22);
    this._pivot.add(this._weldGlow);

    // EVA umbilical from the lower PLSS/SAFER to a hull hardpoint (offset from the weld so anchor + arc don't stack).
    // Gently COILED at idle (a STATIC shape, no per-frame cost); on departure it pulls TAUT then reels into the pack.
    this._tetherAnchorLocal = new THREE.Vector3(0, M * 0.20, -M * 0.24); // lower PLSS back
    this._tetherEnd = new THREE.Vector3(M * 0.24, M * 0.12, BUS_LEN * 0.5 - M * 0.02);
    this._tetherRadius = M * 0.018;
    astro.updateWorldMatrix(true, false);
    const umbAnchor = astro.localToWorld(this._tetherAnchorLocal.clone());
    this._tetherCoil = tetherCoilPoints(umbAnchor, this._tetherEnd);
    const tether = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(this._tetherCoil), 44, this._tetherRadius, 7, false),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d2, metalness: 0.0, roughness: 0.92 }));
    tether.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this._pivot.add(tether);

    // Base poses: the exit animates from a known rest state and _resetAstronautExit() restores them.
    this._astroWeldArm = astro.userData.weldArm || null;
    this._astroSafer = astro.userData.safer || null;
    this._astroBasePos = astro.position.clone();
    this._astroBaseRotY = astro.rotation.y;
    this._astroBaseRotZ = astro.rotation.z;
    this._weldArmBaseRotX = this._astroWeldArm ? this._astroWeldArm.rotation.x : 0;
    this._astroBaseRotX = astro.rotation.x;
    this._astroLShoulder = astro.userData.lShoulder || null;
    this._lShoulderBaseRotX = this._astroLShoulder ? this._astroLShoulder.rotation.x : 0;
    this._lShoulderBaseRotZ = this._astroLShoulder ? this._astroLShoulder.rotation.z : 0;
    this._astroLegPose = astro.userData.legPose || [];
    this._astroLegPoseBase = this._astroLegPose.map((lp) => ({
      legX: lp.leg.rotation.x,
      shankX: lp.shank.rotation.x,
    }));
    this._tether = tether;
    // Two cold-gas puff sprites, hidden until the jet-off beat.
    this._exitPuffs = [];
    for (let i = 0; i < 2; i++) {
      const puff = makeGlowSprite();
      puff.material.color = new THREE.Color(0xcfe4ff);
      puff.material.opacity = 0;
      puff.scale.setScalar(M * 0.05);
      puff.visible = false;
      this._pivot.add(puff);
      this._exitPuffs.push(puff);
    }
    this._exit = null;

    this._sparkSystem = buildSparkSystem();
    this._pivot.add(this._sparkSystem.points);

    // The composer (bloom) is built in _buildComposer() via _applyTierSettings below, so a tier change can rebuild it.

    // A ResizeObserver is essential: init() runs while the menu is display:none (clientWidth = 0), and a window
    // 'resize' never fires when the canvas becomes visible. Without it the composer renders into a 1×1 buffer.
    this._resizeHandler = () => this._onResize(canvas);
    window.addEventListener('resize', this._resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._onResize(canvas));
      this._resizeObserver.observe(canvas);
    }

    // PERF_TIER_CHANGED can fire while the menu is up (the adapt check runs during MENU): rebuild the composer.
    // ZOMBIE GUARD: this subscription outlives hide() by design (hide() only stop()s; dispose() unsubscribes), so a
    // gameplay tier change would rebuild the STOPPED menu's composer, disposing ~13 GPU textures per change that
    // are never re-initialized (a stopped scene never renders). Defer: while not running, record the tier and apply
    // it on the next start().
    this._pendingTier = null;
    this._tierHandler = ({ to }) => {
      if (!this._running) { this._pendingTier = to; return; }
      this._applyTier(to);
    };
    eventBus.on(Events.PERF_TIER_CHANGED, this._tierHandler);

    // Before the first size pass, so the composer target is created at the right resolution.
    this._applyTierSettings();
    this._onResize(canvas);
  }

  /**
   * @private Build (or rebuild) the EffectComposer for the current tier. A composer bypasses the renderer's MSAA, so
   * it renders into a MULTISAMPLED HalfFloat target. Bloom only when the tier enables it; otherwise the enlarged weld
   * glow sprite (see _tick) carries the arc (LOW tier).
   *
   * The composer runs over a TRANSPARENT clear: HalfFloat + OutputPass keep alpha intact so the hero composites over
   * the live scene, and UnrealBloomPass is purely additive (it can only ADD glow, never punch a dark halo into the
   * transparent region). Bloom threshold 1.0: genuinely bright sources only.
   */
  _buildComposer() {
    // EffectComposer.dispose() does NOT dispose added passes (bloom mip-chain targets, OutputPass ShaderMaterial leak
    // on every tier rebuild): dispose them explicitly first.
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
    // three clamps to gl.MAX_SAMPLES; float (RGBA16F) multisample above 4× isn't guaranteed across GPUs (incomplete
    // framebuffer risk).
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
        0.28,   // strength
        0.5,    // radius
        1.0,    // threshold
      );
      this._composer.addPass(this._bloom);
    }
    this._outputPass = new OutputPass();
    this._composer.addPass(this._outputPass);
  }

  /** @private Apply the tier's pixelRatio and (re)build the composer so MSAA / bloom match. */
  _applyTierSettings() {
    const tierCfg = menuQualityFor(this._tier);
    const cap = tierCfg.pixelRatioCap || 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this._lastDpr = window.devicePixelRatio || 1;
    this._buildComposer();
  }

  /** @private PERF_TIER_CHANGED handler: no-op if unchanged or unknown. @param {string} tier 'HIGH' | 'MEDIUM' | 'LOW' */
  _applyTier(tier) {
    if (!tier || tier === this._tier) return;
    if (!MENU_QUALITY[tier]) return;
    this._tier = tier;
    if (!this.renderer) return;
    this._applyTierSettings();
    if (this._canvas) this._onResize(this._canvas);
  }

  _initReducedMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      this._motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotion = !!this._motionMedia.matches;
      this._motionHandler = (e) => {
        this._reducedMotion = !!e.matches;
        if (this._reducedMotion) this._applyReducedMotionPose();
        // Same pose in every motion setting; a toggle only decides whether the next departure may fold the hero.
        // Skipped while a departure runs.
        if (!this._mother || this._departure) return;
        this._restoreHeroMenuPose();
      };
      // addListener is the deprecated fallback.
      if (typeof this._motionMedia.addEventListener === 'function') {
        this._motionMedia.addEventListener('change', this._motionHandler);
      } else if (typeof this._motionMedia.addListener === 'function') {
        this._motionMedia.addListener(this._motionHandler);
      }
    } catch (err) {
      console.warn('MenuScene3D: prefers-reduced-motion unavailable:', err);
    }
  }

  _applyReducedMotionPose() {
    if (!this.camera) return;
    const st = this._style();
    this._positionSwayCamera(st.reducedAng, st.centreCamY, st.orbitR, 0); // damp 0 = frozen (new: the 3/4 view; old: the centre)
    this.camera.lookAt(this._lookTarget);
  }

  /**
   * @private Orbit camera at a swaying pose around `centreAng` / `centreCamY` at radius `orbitR`, sway scaled by
   * `damp` (0 = frozen on the centre). Both orientation branches + reduced motion go through `menuCameraPosition`,
   * with the amplitudes of the pose style in force.
   */
  _positionSwayCamera(centreAng, centreCamY, orbitR, damp) {
    const st = this._style();
    menuCameraPosition(this._orbitAngle, { centreAng, centreCamY, orbitR, damp, angAmp: st.angAmp, camYAmp: st.camYAmp },
      this.camera.position);
  }

  /** @private The MENU_POSE_STYLES row in force. */
  _style() {
    return MENU_POSE_STYLES[this._poseStyle] || MENU_POSE_STYLES.new;
  }

  /** @private Where the sway centre sits now: the sway's middle, or (reduced motion) the style's held azimuth. */
  _swayCentreAng() {
    const st = this._style();
    return this._reducedMotion ? st.reducedAng : st.centreAng;
  }

  /**
   * Switch the title-screen hero live between the `new` menu and the `old` one (commit 57b98ba7), for the dev tick box
   * (MenuScreen "Old menu pose"). Re-poses the hero now, swaps the sway table (the sway clock `_orbitAngle` keeps
   * running, so the camera glides to the other path with no jump in time) and the tail light, and is remembered for the
   * next menu return. Ignored while a departure runs or for an unknown style. The astronaut is untouched.
   * @param {'new'|'old'} style
   * @returns {boolean} true if the switch was applied
   */
  setPoseStyle(style) {
    if (!MENU_POSE_STYLES[style] || this._departure) return false;
    _rememberedPoseStyle = style;
    this._poseStyle = style;
    if (this._tailLight) this._tailLight.intensity = this._style().tailLight ? TAIL_LIGHT_INTENSITY : 0;
    this._restoreHeroMenuPose();
    if (this.camera && this._lookTarget) {
      if (this._reducedMotion) this._applyReducedMotionPose();
      else {
        const st = this._style();
        this._positionSwayCamera(st.centreAng, st.centreCamY, st.orbitR, 1);
        this.camera.lookAt(this._lookTarget);
      }
    }
    return true;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    // A tier change deferred by the zombie guard, BEFORE the first frame.
    if (this._pendingTier) {
      const t = this._pendingTier;
      this._pendingTier = null;
      this._applyTier(t);
    }
    // A fresh MENU entry must not carry over a prior departure ramp.
    this._departure = null;
    this._exit = null;
    this._resetAstronautExit();
    this._restoreHeroMenuPose();
    this._lastFrameT = 0;
    // clientWidth was 0 during init while hidden.
    if (this._canvas) requestAnimationFrame(() => this._onResize(this._canvas));
    this._tick();
  }

  /**
   * Show-mode menu freeze (owner 2026-10-28): stop drawing and leave the last picture on the canvas. Only the rAF is
   * cancelled: no departure, pose or clock reset, so `resume()` carries on without a jump. No-op unless running.
   */
  pause() {
    if (!this._running || this._paused) return;
    this._paused = true;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  /** Wake from `pause()`: restart the rAF. No-op unless running and paused (a stopped scene stays stopped). */
  resume() {
    if (!this._running || !this._paused) return;
    this._paused = false;
    this._lastFrameT = 0;   // draw the very next frame; `_tick` caps dt at 50 ms, so the sway does not jump
    this._tick();
  }

  stop() {
    this._running = false;
    this._paused = false;
    this._clock.stop();
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  /**
   * Begin the menu→sim departure: weld arc / glow / sparks ramp to nothing and the camera orbit eases back (5.5 → 8).
   * Idempotent, so a fast double-click can't restart the ramp. Under reduced motion the ramp still runs (it only
   * fades), but callers should keep the handoff short.
   * @param {number} [durationSec] — override the default ramp duration
   */
  beginDeparture(durationSec) {
    if (this._departure) return;
    this._departure = { t: 0 };
    if (typeof durationSec === 'number' && durationSec > 0) {
      this._departureDur = durationSec;
    }
    // fullExit gates tether-reel + jet-off + removal to the full new-game pull-back; a short (continue) departure
    // plays arc-snap + acknowledgment turn only ("she stays"). Reduced motion skips the beat (handled in _tick).
    this._exit = {
      sparkBurstDone: false,
      fullExit: this._departureDur >= 1.0,
      exitDir: null,       // cached screen down-right world vector (set at jet-off)
      tetherRemoved: false,
      puffFired: [false, false],
      puffAge: [0, 0],
    };
    // Only the full new-game exit may get 'flyaround'. main.js listens for MENU_ORIENT_MODE to fire the power-up
    // flash ('partial' only; the fly-around is seamless).
    this._orientMode = (this._exit.fullExit && !this._reducedMotion && Math.random() < 0.5)
      ? 'flyaround' : 'partial';
    eventBus.emit(Events.MENU_ORIENT_MODE, { mode: this._orientMode });
  }

  /**
   * Jump the departure + astronaut exit to their end state (arc off, astronaut cleared, dep = 1) when the player
   * SKIPS the menu departure (MenuScreen fast-forward), so the astronaut isn't frozen mid-beat behind the sim ship.
   */
  skipDeparture() {
    if (!this._departure) return;
    this._departure.t = this._departureDur;
    if (this._exit && this._exit.fullExit && !this._reducedMotion) {
      if (this._astro) this._astro.visible = false;
      this._removeTether();
      this._exit.tetherRemoved = true;
    }
    if (this._weldLight) this._weldLight.intensity = 0;
    if (this._weldGlow) this._weldGlow.material.opacity = 0;
  }

  /** @private Restore the astronaut + tether + puffs to their built rest state (fresh MENU entry). */
  _resetAstronautExit() {
    if (this._astro) {
      this._astro.visible = true;
      if (this._astroBasePos) this._astro.position.copy(this._astroBasePos);
      this._astro.rotation.x = this._astroBaseRotX;
      this._astro.rotation.y = this._astroBaseRotY;
      this._astro.rotation.z = this._astroBaseRotZ;
    }
    if (this._astroWeldArm) this._astroWeldArm.rotation.x = this._weldArmBaseRotX;
    if (this._astroLShoulder) {
      this._astroLShoulder.rotation.x = this._lShoulderBaseRotX;
      this._astroLShoulder.rotation.z = this._lShoulderBaseRotZ;
    }
    if (this._astroLegPose && this._astroLegPoseBase) {
      this._astroLegPose.forEach((lp, i) => {
        const b = this._astroLegPoseBase[i];
        if (!lp || !b) return;
        lp.leg.rotation.x = b.legX;
        lp.shank.rotation.x = b.shankX;
      });
    }
    this._setAstroOpacity(1);   // undo any fly-around exit dissolve
    if (this._mother) this._mother.rotation.z = MOTHER_BASE_ROLL_Z; // undo any de-roll
    if (this._exitPuffs) {
      for (const p of this._exitPuffs) { p.visible = false; p.material.opacity = 0; }
    }
    this._rebuildTether(0);
  }

  /**
   * @private Restore the hero's menu pose (start()'s menu-return reset): struts 180°, radiators 146°, wings rolled,
   * undoing what the previous departure's fold left. `_heroPacked` says whether the next departure may fold her (a
   * reduced-motion or flag-off hero shows the same pose but never folds).
   */
  _restoreHeroMenuPose() {
    if (!this._mother) return;
    this._applyHeroStylePose(this._mother, this._daughters);
  }

  /**
   * @private Write the pose of the style in force on `mother` and set `_heroPacked`: the new menu pose, or the old menu's
   * (applyHeroOldMenuPose: packed, or deployed under reduced motion / a flag-off build, as 57b98ba7 did).
   */
  _applyHeroStylePose(mother, daughters) {
    const mayFold = !this._reducedMotion && !!Constants.FEATURE_FLAGS.OPENING_DANCE;
    if (this._poseStyle === 'old') applyHeroOldMenuPose(mother, daughters, !mayFold);
    else applyHeroMenuPose(mother, daughters);
    this._heroPacked = mayFold;
  }

  /**
   * @private Astronaut opacity (0-1) for the fly-around dissolve. Lazily collects her unique materials. k<1 flips
   * them transparent (depthWrite off to avoid sort artifacts); k≈1 restores opaque.
   */
  _setAstroOpacity(k) {
    if (!this._astro) return;
    if (!this._astroMats) {
      this._astroMats = new Set();
      this._astro.traverse((o) => {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => this._astroMats.add(m));
      });
    }
    const opaque = k >= 0.999;
    if (opaque && this._astroFaded === false) return;
    // Flip flags only on the opaque<->faded TRANSITION: needsUpdate every frame forces a per-frame program-key
    // recompute. The per-frame write during a fade is opacity alone.
    const transition = this._astroFaded !== !opaque;
    this._astroFaded = !opaque;
    this._astroMats.forEach((m) => {
      m.opacity = k;
      if (transition) {
        m.transparent = !opaque;
        m.depthWrite = opaque;
        m.needsUpdate = true;
      }
    });
  }

  /**
   * Repaint the shoulder-patch flag (menu language change); safe before/after init and while paused.
   * @param {string} flagCode — flag code understood by FlagDecalSystem
   */
  setFlag(flagCode) {
    if (this._astro && this._astro.userData.setFlagCode) {
      this._astro.userData.setFlagCode(flagCode);
    }
  }

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
      // As in _buildComposer: dispose the added passes before the composer's own RTs.
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

  _tick() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._tick());

    // Frame gate. Return BEFORE _clock.getDelta() so dt accumulates across skipped frames (spark physics and sway
    // speed stay correct). The −2 ms epsilon avoids beat-frequency lock on 120 Hz displays, where an exact 16.67 ms
    // threshold would skip alternate vsync ticks.
    const now = performance.now();
    const minInterval = (this._reducedMotion ? 1000 / 30 : 1000 / 60) - 2;
    if (now - this._lastFrameT < minInterval) return;
    this._lastFrameT = now;

    const dt = Math.min(this._clock.getDelta(), 0.05); // cap for tab-away
    this._orbitAngle += dt;

    // `dep` 0→1 (ease-out) drives the camera pull-back + weld/glow/spark fade; `depFade` (1→0) dims the work-site effects.
    let dep = 0;
    if (this._departure) {
      this._departure.t = Math.min(this._departureDur, this._departure.t + dt);
      const raw = this._departure.t / this._departureDur; // 0→1 linear
      dep = 1 - Math.pow(1 - raw, 3);                      // ease-out cubic
    }
    const depFade = 1 - dep;

    // A slow SWAY between a 3/4 view from the work side and dead behind (not a 360° spin) keeps the astronaut + arc
    // framed (see SWAY_ANG_CENTRE). During departure the orbit radius eases 5.5 → 8 (the camera pulls back).
    const orbitR = lerp(this._departureBaseOrbitR, this._departureOrbitR, dep);
    const swayCentre = this._swayCentreAng();
    // `bt` is the beat clock (fraction of dur); the orientation move is gated to BEAT_ORIENT_GATE (after the push-off)
    // so the hull never rotates while she's still anchored.
    const bt = this._departure ? this._departure.t / this._departureDur : 0;
    const orientGate = _clamp01((bt - BEAT_ORIENT_GATE) / Math.max(0.001, 1 - BEAT_ORIENT_GATE));
    const flyaround = this._orientMode === 'flyaround'
      && this._departure && !this._reducedMotion && this._exit && this._exit.fullExit;

    if (flyaround) {
      // Camera ARCS behind + hull FULLY de-rolls in lockstep, look target recentres on the hull, sway damps to 0: the
      // last menu frame lands on the sim chase framing (seamless). Own gate, earlier than the shared one.
      const flyGate = _clamp01((bt - BEAT_FLYAROUND_GATE) / Math.max(0.001, 1 - BEAT_FLYAROUND_GATE));
      const fa = smoothstep01(flyGate);
      const angCentre  = lerp(swayCentre, FLYAROUND_ANG_END, fa);
      const camYCentre = lerp(this._style().centreCamY, FLYAROUND_CAMY_END, fa);
      this._positionSwayCamera(angCentre, camYCentre, orbitR, 1 - fa);
      if (this._mother) this._mother.rotation.z = MOTHER_BASE_ROLL_Z * (1 - fa);
      this._tmpLook.copy(this._lookTarget).multiplyScalar(1 - fa);   // → hull centre (no per-frame alloc)
      this.camera.lookAt(this._tmpLook);
      // She fades out over the final 14% of the gate (_setAstroOpacity) instead of drifting away.
      const k = fa > 0.86 ? 1 - Math.min(1, (fa - 0.86) / 0.14) : 1;
      this._setAstroOpacity(k);
    } else {
      // End pose: the sway centre shifted by EXIT_CAM_ANG_SHIFT + a ~28° de-roll (gated after push-off). Since the sway
      // centres behind the ship (DECISIONS §55 row 2, 2026-10-29) the shift turns toward the side, away from the chase
      // angle, not toward the sim view; the power-up flash (main.js) masks the cut. Reduced motion lands on it too.
      const angCentre  = lerp(swayCentre, swayCentre + EXIT_CAM_ANG_SHIFT, dep);
      const camYCentre = lerp(this._style().centreCamY, EXIT_CAM_CAMY_END, dep);
      this._positionSwayCamera(angCentre, camYCentre, orbitR, this._reducedMotion ? 0 : 1 - dep * 0.85);
      this.camera.lookAt(this._lookTarget);   // work site (weld / astronaut)
      let rollEase = 0;
      if (this._departure && !this._reducedMotion && this._exit && this._exit.fullExit) {
        rollEase = orientGate * orientGate;   // ease-in: gentle while she's still visible
      }
      if (this._mother) this._mother.rotation.z = MOTHER_BASE_ROLL_Z + EXIT_DEROLL * rollEase;
      this._setAstroOpacity(1);   // 'partial' never dissolves
    }

    // The departure fold and the wings (see _driveHeroFromDeparture).
    this._driveHeroFromDeparture();

    // The Mother's OWN animators (nav lights, LIDAR pulse, solar tracking): they only mutate materials/transforms and
    // emit nothing, so they are safe without update(). Guarded individually in case a refactor renames them.
    if (this._mother) {
      this._mother._animateNavLights?.(dt);
      this._mother._animateLidarPulse?.(dt);
      this._mother._animateSolarTracking?.(dt, this._sunDir);
      this._mother._animateRosaGlow?.(dt);
    }

    // Keyframed off the ABSOLUTE departure seconds. Reduced motion skips the beat (straight cut). Returns the
    // acknowledgment-turn ease (0→1) for the visor glint.
    let exitTurn = 0;
    if (this._departure && !this._reducedMotion) {
      exitTurn = this._updateAstronautExit(this._departure.t, dt);
    }

    // Welding is a flickering point light; at departure it SNAPS off (the luminance step is the exit's attention
    // "bell"). Reduced motion: a faint fade with dep.
    let arc = 0;
    if (this._weldLight) {
      if (this._departure && !this._reducedMotion) {
        this._weldLight.intensity = this._departure.t < 0.05 ? 1.1 : 0; // one last strike, then off
      } else if (this._reducedMotion) {
        this._weldLight.intensity = 0.14 * depFade;   // steady faint arc, fading
      } else {
        const base  = 0.12 + Math.random() * 0.06;
        const spike = Math.random() < 0.16 ? (0.35 + Math.random() * 0.7) : 0.0;
        arc = spike;
        this._weldLight.intensity = base + spike;
      }
    }

    // Fades with the departure so no dark patch lingers as the weld glow dies.
    if (this._contactShadowMat) this._contactShadowMat.opacity = 0.32 * depFade;

    // Idle: opacity/size track the arc spikes. Departure: a SLOW cooling decay (~1 s) decoupled from the arc snap, so
    // the pool stays hot a beat after the arc dies.
    if (this._weldGlow) {
      if (this._departure && !this._reducedMotion) {
        const cool = Math.max(0, 1 - this._departure.t / 1.0);
        this._weldGlow.material.opacity = 0.34 * cool * cool;   // ease-out cool
        this._weldGlow.scale.setScalar(M * (0.16 * cool));
      } else {
        this._weldGlow.material.opacity = Math.min(0.7, 0.14 + arc * 0.32) * depFade;
        this._weldGlow.scale.setScalar(M * (0.16 + arc * 0.05));
      }
    }

    // Visor glint on the acknowledgment turn (the arc is dead; the key light alone is too weak at this distance).
    // Peaks mid-turn.
    if (this._visorMat) {
      const glint = exitTurn > 0 ? Math.sin(Math.min(1, exitTurn) * Math.PI) : 0;
      if (glint > 0.001) {
        this._visorMat.emissive.setHex(0xffcf87);
        this._visorMat.emissiveIntensity = glint * 0.6;
      } else if (this._visorMat.emissiveIntensity !== 0) {
        this._visorMat.emissiveIntensity = 0;
      }
    }

    // At departure no new steady emission: the final burst (_updateAstronautExit) and its tail integrate to death.
    // Suppressed under reduced motion.
    if (this._sparkSystem && !this._reducedMotion) {
      if (!this._departure) {
        updateSparks(this._sparkSystem, this._weldPos, dt);
      } else if (this._departure.t < 0.9) {
        updateSparks(this._sparkSystem, this._weldPos, dt, 0); // decay-only
      }
    }

    if (this._composer) this._composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * @private Drive the hero for one frame of a NEW-GAME departure ("she folds to fly"): the struts and radiators fold
   * from the menu pose toward closed at the real hardware rates, from the departure's own clock `_departure.t`
   * (`heroDepartureFold`), and the wings follow the opening-dance wall clock, the SAME progress() the sim ship reads
   * after the cut, so the unmasked 'flyaround' cut stays continuous (they are still rolled up before it). The dance
   * clock cannot drive the fold: its `flower` is 0 until after the cut. Same gate as the dance: a full exit, motion
   * allowed, the dance armed (CONTINUE never arms it) and the hero in the menu pose (`_heroPacked`).
   */
  _driveHeroFromDeparture() {
    if (!this._mother || !this._heroPacked || !this._departure) return;
    if (!this._exit || !this._exit.fullExit || this._reducedMotion || !openingDance.isActive()) return;
    if (!this._style().departureFold) {
      // Old style (commit 57b98ba7): no strut/radiator fold; the dance clock alone drives radiators (its flower, 0 until
      // after the cut) and wings.
      applyHeroDanceProgressOld(this._mother, openingDance.progress());
      return;
    }
    applyHeroDanceProgress(this._mother, openingDance.progress());
    applyHeroDepartureFold(this._mother, this._daughters, this._departure.t);
  }

  /**
   * @private Advance the astronaut exit keyframe machine. `t` is absolute departure seconds; beats are FRACTIONS of
   * _departureDur (bt = t/dur). Returns the turn ease (0→1) for the visor glint. Beat sheet (fractions of dur):
   *   ~0            arc snap + one final spark burst (arc handled in _tick)
   *   TURN_START..END   torso/helmet turn toward camera + welding-arm tuck (+glint)
   *   TETHER_START..END umbilical pulls taut then reels into the pack (fullExit)
   *   JETOFF..          SAFER puffs + Newtonian push-off (impulse→coast) down-right
   * Continue (short) departure plays turn only; she stays. fullExit gates the
   * reel + jet-off + removal.
   */
  _updateAstronautExit(t, dt) {
    const ex = this._exit;
    if (!ex || !this._astro || !this._astroBasePos) return 0;
    const dur = this._departureDur;
    const bt = t / dur;

    if (!ex.sparkBurstDone && t >= 0.02) {
      ex.sparkBurstDone = true;
      if (this._sparkSystem) emitSparkBurst(this._sparkSystem, this._weldPos, 22);
    }

    // Acknowledgment turn (~30°) + welding-arm tuck to chest.
    const turnE = _easeOutCubic(_clamp01((bt - BEAT_TURN_START) / (BEAT_TURN_END - BEAT_TURN_START)));
    this._astro.rotation.y = this._astroBaseRotY + EXIT_TURN_Y * turnE;
    if (this._astroWeldArm) {
      this._astroWeldArm.rotation.x = this._weldArmBaseRotX + EXIT_ARM_TUCK * turnE;
    }

    if (!ex.fullExit) return turnE; // continue path: turn only, she stays

    if (!ex.tetherRemoved && bt >= BEAT_TETHER_START) {
      const reel = _clamp01((bt - BEAT_TETHER_START) / (BEAT_TETHER_END - BEAT_TETHER_START));
      this._rebuildTether(reel);
      if (reel >= 1) { this._removeTether(); ex.tetherRemoved = true; }
    }

    // Jet-off: cold-gas puffs, then a Newtonian push-off drifting DOWN-and-RIGHT, off the near edge.
    const jetoffT = BEAT_JETOFF * dur;   // absolute push-off time
    if (t >= jetoffT) {
      if (!ex.exitDir) ex.exitDir = this._computeExitDir();
      this._maybeFirePuff(0, jetoffT + 0.06, t);
      this._maybeFirePuff(1, jetoffT + 0.28, t);
      const tm = t - jetoffT;                            // seconds since push-off
      const fly = this._orientMode === 'flyaround';
      const v = fly ? EXIT_DRIFT_SPEED_FLY : EXIT_DRIFT_SPEED;
      const ramp = fly ? EXIT_IMPULSE_RAMP_FLY : EXIT_IMPULSE_RAMP;
      const dist = tm < ramp
        ? 0.5 * (v / ramp) * tm * tm                     // impulse: x = ½at²
        : 0.5 * v * ramp + v * (tm - ramp);              // then constant-velocity coast
      this._astro.position.copy(this._astroBasePos)
        .addScaledVector(ex.exitDir, dist);
      // Roll eases in over the push-off, then holds.
      this._astro.rotation.z = this._astroBaseRotZ
        + EXIT_BODY_ROLL * _easeOutCubic(_clamp01(tm / 0.7));
      // Free-flyer pose: eases each captured base rotation toward its target after jet-off (CPU-only).
      const poseE = _easeOutCubic(_clamp01(tm / EXIT_POSE_DUR));
      if (this._astroLegPose && this._astroLegPoseBase) {
        const legs = this._astroLegPose;
        const bases = this._astroLegPoseBase;
        if (legs[0]) {
          legs[0].leg.rotation.x = lerp(bases[0].legX, EXIT_LEG_L_X, poseE);
          legs[0].shank.rotation.x = lerp(bases[0].shankX, EXIT_SHANK_L_X, poseE);
        }
        if (legs[1]) {
          legs[1].leg.rotation.x = lerp(bases[1].legX, EXIT_LEG_R_X, poseE);
          legs[1].shank.rotation.x = lerp(bases[1].shankX, EXIT_SHANK_R_X, poseE);
        }
      }
      if (this._astroLShoulder) {
        this._astroLShoulder.rotation.z = lerp(this._lShoulderBaseRotZ, EXIT_ARM_Z, poseE);
        this._astroLShoulder.rotation.x = lerp(this._lShoulderBaseRotX, EXIT_ARM_X, poseE);
      }
      this._astro.rotation.x = this._astroBaseRotX + EXIT_CHEST_OPEN * poseE;
    }
    this._updatePuffs(dt);
    return turnE;
  }

  /** @private Exit drift direction: screen DOWN-and-RIGHT in world space, off the near edge without crossing the hull. */
  _computeExitDir() {
    const fwd = this._lookTarget.clone().sub(this.camera.position).normalize();
    const right = fwd.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const up = right.clone().cross(fwd).normalize();
    const fly = this._orientMode === 'flyaround';
    const rb = fly ? EXIT_RIGHT_BIAS : EXIT_RIGHT_BIAS_PARTIAL;
    const db = fly ? EXIT_DOWN_BIAS  : EXIT_DOWN_BIAS_PARTIAL;
    return right.multiplyScalar(rb)
      .addScaledVector(up, -db)
      .normalize();
  }

  /** @private Fire cold-gas puff `i` once, at t≥fireT, anchored on the SAFER. */
  _maybeFirePuff(i, fireT, t) {
    const ex = this._exit;
    if (!ex || ex.puffFired[i]) return;
    if (t < fireT) return;
    ex.puffFired[i] = true;
    const puff = this._exitPuffs[i];
    if (!puff) return;
    const anchor = new THREE.Vector3();
    if (this._astroSafer) this._astroSafer.getWorldPosition(anchor);
    else anchor.copy(this._astro.position);
    // Offset toward the thrust side (opposite the exit vector), with a per-pod spread so the puffs don't stack.
    if (ex.exitDir) anchor.addScaledVector(ex.exitDir, -M * 0.18);
    anchor.x += (i === 0 ? -1 : 1) * M * 0.12;
    puff.position.copy(anchor);
    puff.visible = true;
    puff.material.opacity = 0.85;
    puff.scale.setScalar(M * 0.05);
    ex.puffAge[i] = 0.0001; // > 0 marks active
    // Cold-gas "pfft" audio; fires only on the full jet-off exit (not continue/reduced); noAudio-safe.
    eventBus.emit(Events.MENU_EVA_PUFF);
  }

  /** @private Expand + fade active cold-gas puffs (~0.3 s each). */
  _updatePuffs(dt) {
    const ex = this._exit;
    if (!ex) return;
    for (let i = 0; i < this._exitPuffs.length; i++) {
      if (ex.puffAge[i] <= 0) continue;
      ex.puffAge[i] += dt;
      const life = 0.32;
      const a = ex.puffAge[i] / life;
      const puff = this._exitPuffs[i];
      if (a >= 1) { puff.visible = false; puff.material.opacity = 0; ex.puffAge[i] = 0; continue; }
      puff.material.opacity = 0.85 * (1 - a);
      puff.scale.setScalar(M * (0.05 + a * 0.22));    // expands as it dissipates
    }
  }

  /**
   * @private Rebuild the umbilical at retract progress `p` (0 = idle coil, 1 = reeled into the pack). The first ~35%
   * pulls the coil TAUT (toward a straight anchor→hull line); the rest REELS the hull end back to the PLSS anchor.
   * Disposes the previous geometry each rebuild (leak guard).
   */
  _rebuildTether(p) {
    const tether = this._tether;
    if (!tether || !this._astro || !this._tetherEnd || !this._tetherCoil
        || !this._tetherAnchorLocal) return;
    if (p >= 0.999) { tether.visible = false; return; }
    this._astro.updateWorldMatrix(true, false);
    const a = this._astro.localToWorld(this._tetherAnchorLocal.clone());
    const taut = _clamp01(p / 0.35);              // 0→1 straighten the coil
    const reel = _clamp01((p - 0.35) / 0.65);     // 0→1 hull end → pack
    const end = this._tetherEnd.clone().lerp(a, reel);
    const n = this._tetherCoil.length;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const straight = a.clone().lerp(end, i / (n - 1));
      pts.push(this._tetherCoil[i].clone().lerp(straight, taut));
    }
    const oldGeo = tether.geometry;
    tether.geometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(pts), 40, this._tetherRadius, 7, false);
    if (oldGeo && oldGeo.dispose) oldGeo.dispose();
    tether.visible = true;
  }

  _removeTether() {
    if (this._tether) this._tether.visible = false;
  }

  _onResize(canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    // DPR change (window dragged between a retina and a 1× monitor): rebuild pixelRatio + composer targets first.
    // No recursion: _applyTierSettings does not call _onResize.
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this._lastDpr) {
      this._applyTierSettings();   // sets _lastDpr + rebuilds composer at new pr
    }
    this.renderer.setSize(w, h, false);
    if (this._composer) this._composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Show-mode menu freeze: a resize clears the canvas and no tick will redraw it, so draw the still picture once.
    if (this._paused) {
      if (this._composer) this._composer.render();
      else this.renderer.render(this.scene, this.camera);
    }
  }
}

export default MenuScene3D;
