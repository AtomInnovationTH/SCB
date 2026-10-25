/**
 * LeashVisual.js — what the leash hand-off looks like (lane l6-look).
 *
 * Reads `player.leashDriver.view()` (lane l5b/l5c) and draws, every frame:
 *   1. the LINE — one Line2 in the SCENE (not under the ship: ShipKeepOut reads every mesh under the ship):
 *      anchor -> bag before the catch, anchor -> tip (straight) then tip -> bag (a little sag) once the line
 *      runs through the tip. Same material kit as the net's own tether, but the line's true width (2 x LEASH.LINE_RADIUS_M). Hidden while the hand-off
 *      is not running, when the line is cut, and in the nose reel (the net's own tether is drawn then).
 *   2. the REAL-SIZE BAG — a low-poly wire sphere (catch radius + 3 cm) with a steel washer at its neck, one for
 *      each tip plus one for the hand-off, created once and swapped in/out (never scaled from the big net bag).
 *      A tip's bag stays drawn while its slot is filled — through stow and cooking — and goes when it is digested.
 *   3. the CONE SWIVEL — each tip's slotted cone hangs on a pivot at its narrow end (PlayerSatellite owns the
 *      pivot's POSITION); this class sets only its ROTATION: along the line while the line runs through that tip,
 *      along the boom otherwise, eased.
 * net-bag (2026-10-24): a catch that wears its own net (`netVisual.wearsNet`) gets no wire sphere: its net IS the bag, and
 * CaptureNetVisual keeps it on the catch to the tip. The washer ring and the line stay. A net-less catch keeps the sphere.
 *
 * WHERE IT DRAWS (fix round 1, F2): the ship is drawn in a second pass after a depth clear (NearFieldRenderPass), so
 * anything left in the first pass is painted over by the hull. Everything here hangs on ONE root group
 * (`this.root`, a child of the scene — NOT of the ship, ShipKeepOut reads every mesh under the ship) that is
 * registered with `sceneManager.registerNearFieldRoot` the same way the ship is: the near pass then scales it x1e5
 * about the camera (1 unit = 1 metre) and depth-tests it against the hull. The root sits at the ship every frame and
 * its children are placed relative to it (so the near-field depth bracket, which is taken around the roots, is not
 * stretched to the world origin). In that pass a world-unit line width is in METRES: 2 x LEASH.LINE_RADIUS_M = the true 1 cm line.
 *
 * Units: scene units (1 m = 1e-5) for everything handed in/out of `view()`. No per-frame allocation.
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { Constants } from '../core/Constants.js';
import { NetMeshKit } from './NetMeshKit.js';
import { DebrisWireframe } from './DebrisWireframe.js';
import { DebrisField } from '../entities/DebrisField.js';

const M = Constants.SCENE_UNITS_PER_METER;
const SEGMENTS = 20;                 // line segments (21 points) — the net tether's count
const TIP_SEGMENTS = 6;              // of those, anchor -> tip while the line runs through the tip
const SAG_FRAC = Constants.CAPTURE_NET.NET_TETHER.SAG_FRAC;   // the net tether's sag idiom
const BAG_MARGIN_M = 0.03;           // the drawn bag stands this far outside the catch
/**
 * Radius (m) the catch is DRAWN at, measured from the point the catch is pinned and the bag is centred on: the render
 * scale the renderer really uses (DebrisField.effectiveRenderScale, floor included) times the mesh's farthest vertex
 * from its origin. `sizeMeter` is not the drawn size (test-DebrisField-SizeSSOT): this is 0.76 - 1.8 x sizeMeter.
 * @param {{sizeMeter?: number, sceneSize?: number, type?: string, id?: number}|null} d the catch
 * @returns {number}
 */
export function drawnCatchRadiusM(d) {
  const scale = (d && DebrisField.effectiveRenderScale(d)) || 0.4 * Constants.SCENE_UNITS_PER_METER;
  return scale / Constants.SCENE_UNITS_PER_METER * DebrisWireframe.getOriginRadius(d ? d.type : undefined, d ? d.id : 0);
}
/**
 * Radius (m) of the wire bag the leash hand-off draws round a catch: the catch as drawn plus the margin, so the bag
 * encloses it. CaptureNetVisual cinches the net bag to this size over the hand-off, so the swap at the latch does not
 * change the bag's size.
 * @param {{sizeMeter?: number}|null} d the catch
 * @returns {number}
 */
export function wireBagRadiusM(d) {
  return Math.max(0.02, drawnCatchRadiusM(d)) + BAG_MARGIN_M;
}
const BAG_FADE_S = 0.5;              // real-size bag fades in/out over this long
const BAG_OPACITY = 0.55;
const CONE_EASE_PER_S = 8;           // cone swivel easing rate (1/s)
const WASHER_RADIUS_M = 0.028;       // fits the 40 mm cone mouth
const WASHER_TUBE_M = 0.008;

const _X = new THREE.Vector3(1, 0, 0);
const _Z = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _vA = new THREE.Vector3();   // this frame's anchor / tip / bag point (the view's, moved to where the catch is NOW)
const _vT = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _qT = new THREE.Quaternion();
const _qI = new THREE.Quaternion();

export class LeashVisual {
  /**
   * @param {{ scene: THREE.Scene, player: object, sceneManager?: object }} deps — `player.leashDriver`,
   *   `player.tipCargo` and `player._flowerGroups` are read each frame (any may be absent: nothing is drawn then);
   *   `sceneManager.registerNearFieldRoot` (when present) puts the root in the near-field pass with the ship.
   *   `netVisual` (optional, `wearsNet(debris)`): a catch that wears its own net bag gets no wire sphere (the net IS the
   *   bag; net-bag, owner 2026-10-24) — its washer ring and the line stay. Absent: every catch gets the sphere.
   */
  constructor({ scene, player, sceneManager = null, netVisual = null }) {
    this.scene = scene;
    this.player = player;
    this.sceneManager = sceneManager;
    this.netVisual = netVisual;

    // ONE root, registered as a near-field root (see the header); line and bags are its children.
    this.root = new THREE.Group();
    this.root.name = 'LeashVisualRoot';
    scene.add(this.root);

    // ── the line ──
    this.positions = new Float32Array((SEGMENTS + 1) * 3);          // anchor-relative, scene units
    const geo = new LineGeometry();
    geo.setPositions(this.positions);
    this.lineMaterial = new LineMaterial({
      color: Constants.NET_WEB.WEB_COLOR,
      transparent: true,
      opacity: 0.7,
      linewidth: 2 * Constants.LEASH.LINE_RADIUS_M,       // the real line's diameter (1 cm): world units, and in the near pass 1 unit = 1 m
      worldUnits: true,
      dashed: false,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    NetMeshKit.registerLineMaterial(this.lineMaterial);
    this.line = new Line2(geo, this.lineMaterial);
    this.line.name = 'LeashLine';
    this.line.visible = false;
    this.line.frustumCulled = false;
    this.line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    this.segBuffer = geo.attributes.instanceStart.data;             // written in place every frame
    this.root.add(this.line);

    // ── real-size bags: slots 0-3 = tips, 4 = the hand-off ──
    this.wireGeo = new THREE.IcosahedronGeometry(1, 2);             // unit sphere, 320 faces, drawn as wire
    this.washerGeo = new THREE.TorusGeometry(WASHER_RADIUS_M * M, WASHER_TUBE_M * M, 8, 48);
    this.washerMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.8, roughness: 0.35 });
    this.bags = [];
    this._handDebris = null;                                        // the catch the hand-off bag was last drawn for
    for (let i = 0; i < 5; i++) {
      const group = new THREE.Group();
      group.name = i < 4 ? `LeashBag_${i}` : 'LeashBag_handoff';
      group.visible = false;
      const wireMat = new THREE.MeshBasicMaterial({
        color: Constants.NET_WEB.WEB_COLOR, wireframe: true, transparent: true, opacity: 0, depthWrite: false,
      });
      const wire = new THREE.Mesh(this.wireGeo, wireMat);
      wire.name = `${group.name}_Wire`;
      wire.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
      wire.frustumCulled = false;
      const washer = new THREE.Mesh(this.washerGeo, this.washerMat);
      washer.name = `${group.name}_Washer`;
      washer.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      washer.frustumCulled = false;
      group.add(wire);
      group.add(washer);
      this.root.add(group);
      this.bags.push({ group, wire, wireMat, washer, alpha: 0 });
    }

    // Same as the ship (main.js registerNearFieldRoot(player)): drawn in the depth-cleared near pass, so the hull
    // cannot paint over the line or the bags and they are depth-tested against it.
    if (sceneManager && typeof sceneManager.registerNearFieldRoot === 'function') sceneManager.registerNearFieldRoot(this.root);
  }

  /** Per frame, after the capture-net visual and the leash driver / tip cargo have run. @param {number} dt seconds */
  update(dt) {
    const driver = this.player && this.player.leashDriver;
    const view = driver && typeof driver.view === 'function' ? driver.view() : null;
    this._placeRoot(view);
    this._framePoints(view);
    this._updateLine(view);
    this._updateBags(view, dt);
    this._updateCones(view, dt);
  }

  /** The root rides the ship (children are root-relative): near-field depth brackets are taken around the roots. */
  _placeRoot(view) {
    const pp = this.player && this.player.position;
    if (pp && Number.isFinite(pp.x) && Number.isFinite(pp.y) && Number.isFinite(pp.z)) this.root.position.copy(pp);
    else if (view && view.anchorWorld) this.root.position.copy(view.anchorWorld);
    else this.root.position.set(0, 0, 0);
  }

  /**
   * l8b: the view's points are copied in the driver's step, BEFORE the ship and the catch move for the frame, so they
   * trail the live scene by one frame of orbital travel (browser probe 2026-10-15: 0.04 scene units = km, the
   * hand-off bag and the line drawn a frame behind the root, i.e. nowhere near the catch). The catch's own
   * `_scenePosition` is live, so every view point is shifted by (live catch - view.bagWorld); the points then agree
   * with the root and the catch in the same frame.
   */
  _framePoints(view) {
    this._fp = false;
    if (!view || !view.bagWorld) return;
    _vB.copy(view.bagWorld);
    const live = view.debris && view.debris._scenePosition;
    let dx = 0, dy = 0, dz = 0;
    if (live && Number.isFinite(live.x) && Number.isFinite(live.y) && Number.isFinite(live.z)) {
      dx = live.x - view.bagWorld.x; dy = live.y - view.bagWorld.y; dz = live.z - view.bagWorld.z;
      _vB.copy(live);
    }
    if (view.anchorWorld) _vA.set(view.anchorWorld.x + dx, view.anchorWorld.y + dy, view.anchorWorld.z + dz);
    if (view.tipWorld) _vT.set(view.tipWorld.x + dx, view.tipWorld.y + dy, view.tipWorld.z + dz);
    this._fp = true;
  }

  // ── the line ──────────────────────────────────────────────────────────────

  _updateLine(view) {
    const line = this.line;
    if (!view || view.lineCut || view.phase === 'NOSE_REEL' || !view.anchorWorld || !view.bagWorld) {
      line.visible = false;
      return;
    }
    line.visible = true;
    const P = this.positions;
    line.position.copy(_vA).sub(this.root.position);                // root-relative; vertices are anchor-relative
    _c.copy(_vB).sub(_vA);                                          // anchor -> bag
    const through = !!view.tipEngaged && !!view.tipWorld;
    let total;                                                      // chord length(s), scene units
    if (through) {
      _b.copy(_vT).sub(_vA);                                        // anchor -> tip
      _d.copy(_c).sub(_b);                                          // tip -> bag
      total = _b.length() + _d.length();
    } else {
      _d.copy(_c);
      total = _c.length();
    }
    const slack = Math.max(0, (view.reelLenM || 0) * M - total);
    const sag = slack * SAG_FRAC;
    // sag direction: perpendicular to the sagging chord, biased "up" the way the net tether does:
    // lateral = normalize(cross(up, axis)), up = +Y (or +X when the axis is nearly vertical)
    _a.copy(_d);
    if (_a.lengthSq() > 1e-30) _a.normalize(); else _a.set(1, 0, 0);
    const ux = Math.abs(_a.y) > 0.95 ? 1 : 0, uy = ux ? 0 : 1;
    let lx = uy * _a.z, ly = -ux * _a.z, lz = ux * _a.y - uy * _a.x;
    const ln = Math.hypot(lx, ly, lz) || 1;
    lx /= ln; ly /= ln; lz /= ln;

    const first = through ? TIP_SEGMENTS : 0;
    for (let i = 0; i <= SEGMENTS; i++) {
      let x, y, z;
      if (i <= first) {                                             // straight anchor -> tip
        const t = first > 0 ? i / first : 0;
        x = _b.x * t; y = _b.y * t; z = _b.z * t;
      } else {                                                      // (tip ->) bag with the sag
        const s = (i - first) / (SEGMENTS - first);
        const bow = 4 * s * (1 - s) * sag;
        const ox = through ? _b.x : 0, oy = through ? _b.y : 0, oz = through ? _b.z : 0;
        x = ox + _d.x * s + lx * bow; y = oy + _d.y * s + ly * bow; z = oz + _d.z * s + lz * bow;
      }
      P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
    }
    const arr = this.segBuffer.array;
    for (let j = 0; j < SEGMENTS; j++) {
      const a = j * 3, b = a + 3, o = j * 6;
      arr[o] = P[a]; arr[o + 1] = P[a + 1]; arr[o + 2] = P[a + 2];
      arr[o + 3] = P[b]; arr[o + 4] = P[b + 1]; arr[o + 5] = P[b + 2];
    }
    this.segBuffer.needsUpdate = true;
  }

  // ── the real-size bags ────────────────────────────────────────────────────

  _updateBags(view, dt) {
    const tc = this.player && this.player.tipCargo;
    const hand = this.bags[4];
    // l8b D2: exactly one bag around the catch in every frame. The hand-off bag (slot 4) is drawn while the view
    // runs and has a bag point; a tip bag (from tipCargo) is drawn for a held catch UNLESS the hand-off bag is
    // drawn for that same catch this frame. When one takes over from the other the opacity is carried over and the
    // old one goes in the same frame (no cross-fade of two bags, no frame with neither).
    const handShown = !!(view && view.bagWorld && Number.isFinite(view.bagWorld.x));
    const hd = view ? view.debris : null;
    const prevHandD = this._handDebris;
    for (let i = 0; i < 4; i++) {
      const d = tc && typeof tc.debrisAt === 'function' ? tc.debrisAt(i) : null;
      const pos = d && d._scenePosition;
      const bag = this.bags[i];
      if (d && pos && !(handShown && hd === d)) {
        if (tc.latchWorldInto && tc.latchWorldInto(i, _a)) _b.copy(_a).sub(pos); else _b.set(1, 0, 0);
        if (prevHandD === d && hand.alpha > 0) { bag.alpha = Math.max(bag.alpha, hand.alpha); this._hideNow(hand); }
        this._showBag(bag, pos, _b, this._radiusM(d), dt, true, !this._netted(d));
      } else {
        if (handShown && hd && hd === d && bag.alpha > 0) { hand.alpha = Math.max(hand.alpha, bag.alpha); this._hideNow(bag); }
        this._showBag(bag, null, null, 0, dt, false);
      }
    }
    if (handShown) {
      // the neck faces the line: toward the tip once the line runs through it, else toward the anchor
      const toward = view.tipEngaged && view.tipWorld ? _vT : (view.anchorWorld ? _vA : null);
      if (toward) _b.copy(toward).sub(_vB); else _b.set(0, 0, 1);
      this._showBag(hand, _vB, _b, this._radiusM(hd), dt, true, !this._netted(hd));
      this._handDebris = hd;
    } else {
      this._showBag(hand, null, null, 0, dt, false);
      if (hand.alpha <= 0) this._handDebris = null;
    }
  }

  /** net-bag: true when the catch wears its own net bag, so no wire sphere is drawn round it. */
  _netted(d) {
    const nv = this.netVisual;
    return !!(nv && typeof nv.wearsNet === 'function' && d && nv.wearsNet(d));
  }

  /** Drop a bag at once (its opacity went to the bag that takes over). */
  _hideNow(bag) {
    bag.alpha = 0;
    bag.wireMat.opacity = 0;
    bag.group.visible = false;
  }

  _radiusM(d) {
    return wireBagRadiusM(d) - BAG_MARGIN_M;
  }

  /** Place one bag (or fade it out). `neck` = direction from the bag centre to its neck (any length). */
  _showBag(bag, pos, neck, radiusM, dt, show, wire = true) {
    const step = dt > 0 ? dt / BAG_FADE_S : 1;                                // a held world (dt 0) jumps to the end
    if (show) {
      bag.alpha = Math.min(1, bag.alpha + step);
      const R = radiusM + BAG_MARGIN_M;
      bag.group.position.copy(pos).sub(this.root.position);          // root-relative
      bag.wire.scale.setScalar(R * M);
      bag.wire.visible = wire;         // net-bag: set only while shown, so a fade-out keeps what the bag last drew (never a sphere for a netted catch)
      if (neck.lengthSq() > 1e-30) {
        neck.normalize();
        bag.washer.position.copy(neck).multiplyScalar(R * M);
        bag.washer.quaternion.setFromUnitVectors(_Z, neck);
      }
    } else {
      bag.alpha = Math.max(0, bag.alpha - step);
    }
    bag.wireMat.opacity = BAG_OPACITY * bag.alpha;
    bag.group.visible = bag.alpha > 0;
  }

  // ── the cone swivel ───────────────────────────────────────────────────────

  _updateCones(view, dt) {
    const groups = this.player && this.player._flowerGroups;
    if (!groups) return;
    const k = dt > 0 ? 1 - Math.exp(-CONE_EASE_PER_S * dt) : 0;
    for (let g = 0; g < groups.length; g++) {
      const hw = groups[g].tipHw;
      if (!hw) continue;
      const pivot = hw.conePivot;
      const engaged = !!(view && view.tipEngaged && !view.lineCut && view.tipIndex === hw.index && view.bagWorld);
      if (engaged) {
        const tip = pivot.parent;
        _inv.copy(tip.matrixWorld).invert();
        _a.copy(_vB).applyMatrix4(_inv).sub(pivot.position);     // tip-local, from the cone's narrow end
        if (_a.lengthSq() > 1e-30) _qT.setFromUnitVectors(_X, _a.normalize()); else _qT.identity();
        hw.swivelled = true;
        if (k > 0) pivot.quaternion.slerp(_qT, k);
      } else if (hw.swivelled) {                                          // back along the boom
        if (k > 0) pivot.quaternion.slerp(_qI.identity(), k);
        if (pivot.quaternion.angleTo(_qI.identity()) < 1e-4) { pivot.quaternion.identity(); hw.swivelled = false; }
      }
    }
  }

  dispose() {
    this.line.geometry.dispose();
    NetMeshKit.unregisterLineMaterial(this.lineMaterial);
    this.lineMaterial.dispose();
    for (const b of this.bags) {
      this.root.remove(b.group);
      b.wireMat.dispose();
    }
    this.root.remove(this.line);
    if (this.sceneManager && typeof this.sceneManager.unregisterNearFieldRoot === 'function') this.sceneManager.unregisterNearFieldRoot(this.root);
    this.scene.remove(this.root);
    this.wireGeo.dispose();
    this.washerGeo.dispose();
    this.washerMat.dispose();
  }
}
