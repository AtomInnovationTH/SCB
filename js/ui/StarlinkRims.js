/**
 * StarlinkRims.js — the rings, bands and labels the Starlink layers draw on the floor 4 globe (Sky 37, lane R; DECISIONS §93 row 3, §95 row 1,
 * §110; plan `tmp/plans/sky-1126-starlink.md`, "The interface between M and R"; research `docs/research/2026-11-starlink-layers.md` §6).
 *
 *   ring:  a thin line at the latitude where a layer's satellites turn back (+lat and -lat), at the layer's height. Solid for a layer,
 *          dashed for a shell SpaceX may still add. Earth hides the far half (depth test on, nothing written).
 *   band:  a faint see-through shell between two heights (Gen3 filed, the data-centre plan). 4.5 km of shell is 0.3 px at the arrival camera, so it
 *          is drawn as a ring at the shell's silhouette (the circle the camera sees round the shell's edge, always facing the camera) at least
 *          BAND_MIN_PX thick on screen, as the dots have a fixed size; its true heights are unchanged. (A back-side additive sphere, as the
 *          atmosphere glow, has the same sub-pixel width at the rim: measured in test-StarlinkRims.js "band thickness", so it was not worth its shader.)
 *   label: one small line of text per ring or band that has one ("53° · 463 km"), at most MAX_LABELS at once (the first four, rings then bands).
 *          DOM, not canvas: no canvas text drawing, so nothing for test-Fonts.js to pin.
 *
 * It is the overlay `RealSkyLayer.setHighlight` takes (`attach`, `update`, `dispose`) plus `setSpec` and `marks`. The card hands the factory
 * `{ isGlass, isOn }`; main.js adds `getViewport`. Pure of the game: only THREE, Constants and the height radius.
 *
 * @module ui/StarlinkRims
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Constants } from '../core/Constants.js';
import { GP_HEIGHT_RADIUS_KM } from '../systems/SkyPropagator.js';

/** A ring's width, CSS px: mouse / touch (plan R task 1: about 1.5, and 2 on glass). */
export const RIM_RING_PX = 1.5;
export const RIM_RING_PX_GLASS = 2;
/** The dark edge under a ring is this much wider (CSS px, both sides together) so a line reads over bright land and cloud. */
export const RIM_EDGE_PX = 1.5;
/** A band is drawn at least this thick on screen (CSS px), whatever its true height. */
export const BAND_MIN_PX = 3;
/** Labels: at most this many at once; they sit at least LABEL_CLEAR_PX outside Earth's outline (plan R task 3). */
export const MAX_LABELS = 4;
export const LABEL_CLEAR_PX = 12;
/** Label text 11 px, box height, and the box's width = LABEL_PAD_PX + LABEL_CHAR_PX per character (B612 Mono is 0.6 em wide: 6.6 px at 11 px). */
export const LABEL_FONT_PX = 11;
export const LABEL_H_PX = 18;
const LABEL_PAD_PX = 16;   // 5 + 5 px padding + the 3 px left edge + 3 px slack (Sky 39 pictures: at 10 the "m" of "km" was cut off)
const LABEL_CHAR_PX = 6.8;
/** Two labels keep this much air between them (CSS px). */
const LABEL_GAP_PX = 4;
/** The label may slide round Earth's outline in steps of this many degrees, at most this many steps each way, to find free room. */
const LABEL_STEP_DEG = 3;
const LABEL_STEPS = 30;

/** Circle samples: a ring's line has RING_SEGMENTS + 1 points; a band's silhouette BAND_SEGMENTS + 1. */
export const RING_SEGMENTS = 128;
export const BAND_SEGMENTS = 96;
/** Dashes of a planned ring are this long / this far apart on screen (CSS px), kept as the camera zooms. */
const DASH_PX = 7;
const GAP_PX = 5;
/** Earth for hiding and for the outline (scene units); a ring's height is measured from the GP radius. */
const EARTH_U = Constants.EARTH_RADIUS;
const S = Constants.SCENE_SCALE;
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

const OPACITY_RING = 0.95;
const OPACITY_DASHED = 0.8;
const OPACITY_BAND = 0.55;

/** A scene radius (units) of a height in km above the GP radius. @param {number} heightKm */
export const rimRadiusU = (heightKm) => (GP_HEIGHT_RADIUS_KM + heightKm) * S;

/**
 * Make a Starlink rims overlay.
 * @param {{isGlass?: () => boolean, isOn?: () => boolean, getViewport?: () => ({w: number, h: number}), doc?: Document, edge?: boolean}} [opts]
 *   `edge` (default true): the dark edge under each ring.
 */
export function createStarlinkRims(opts = {}) {
  const isGlass = typeof opts.isGlass === 'function' ? opts.isGlass : () => false;
  const isOn = typeof opts.isOn === 'function' ? opts.isOn : () => true;
  const getViewport = typeof opts.getViewport === 'function' ? opts.getViewport
    : () => ({ w: globalThis.innerWidth || 1728, h: globalThis.innerHeight || 1117 });
  const getDoc = () => (opts.doc !== undefined ? opts.doc : globalThis.document);
  const withEdge = opts.edge !== false;

  const group = new THREE.Group();
  group.name = 'starlink-rims';
  group.visible = false;
  let scene = null;
  let disposed = false;
  /** @type {Array<any>} */ let rings = [];
  /** @type {Array<any>} */ let bands = [];
  let unitCircle = null;                                 // the band lines share one unit circle
  const owned = new Set();                               // every geometry and material made here, each disposed once
  const mats = [];                                       // every LineMaterial still in use
  const vp = new THREE.Matrix4(), inv = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const tv = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  let resW = 0, resH = 0, lastGlass = null;
  let on = false;
  let marksOut = [];                                     // filled by update from the scratch below
  const scr = { x: 0, y: 0 };
  const sx = new Float32Array(RING_SEGMENTS), sy = new Float32Array(RING_SEGMENTS), st = new Uint8Array(RING_SEGMENTS);
  const bsx = new Float32Array(BAND_SEGMENTS), bsy = new Float32Array(BAND_SEGMENTS);
  const placed = new Float64Array(4 * MAX_LABELS);       // left, top, right, bottom of each placed label
  const pend = [];                                       // items that want a label this frame, in spec order
  let labelEls = [], labelShown = [];

  // ---- building (setSpec) ----
  const own = (o) => { owned.add(o); return o; };
  const lineMaterial = (hex, px, opacity, dashed) => {
    const m = own(new LineMaterial({ color: new THREE.Color(hex), linewidth: px, transparent: true, opacity, depthWrite: false, depthTest: true }));
    m.resolution.set(resW || 1, resH || 1);
    if (dashed) { m.dashed = true; m.dashSize = 1; m.gapSize = 1; }
    mats.push(m);
    return m;
  };
  const dropMaterial = (m) => { const i = mats.indexOf(m); if (i >= 0) mats.splice(i, 1); owned.delete(m); m.dispose(); };

  function ringKey(r) { return `${r.latDeg}|${r.heightKm}|${r.color}|${r.dashed ? 1 : 0}`; }

  /** Build the two circles (+lat, -lat) of one ring. World points of the northern circle are kept for the screen tests. */
  function buildRing(r) {
    const phi = r.latDeg * DEG, R = rimRadiusU(r.heightKm), rad = R * Math.cos(phi), y = R * Math.sin(phi);
    const n = RING_SEGMENTS;
    const pts = new Float32Array(3 * (n + 1));
    for (let i = 0; i <= n; i++) {
      const a = (i % n) / n * TWO_PI;
      pts[3 * i] = rad * Math.cos(a); pts[3 * i + 1] = y; pts[3 * i + 2] = rad * Math.sin(a);
    }
    const px = isGlass() ? RIM_RING_PX_GLASS : RIM_RING_PX;
    const rec = { key: ringKey(r), spec: r, obj: new THREE.Group(), pts, lines: [], widths: [], dashed: !!r.dashed, mats: [], geos: [] };
    rec.obj.name = 'starlink-ring';
    for (let side = 0; side < 2; side++) {
      const p = side === 0 ? pts : pts.map((v, i) => (i % 3 === 1 ? -v : v));
      const g = own(new LineGeometry());
      g.setPositions(p);
      rec.geos.push(g);
      const m = lineMaterial(r.color, px, r.dashed ? OPACITY_DASHED : OPACITY_RING, r.dashed);
      const line = new Line2(g, m);
      line.frustumCulled = false;
      line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
      line.name = side === 0 ? 'starlink-ring-north' : 'starlink-ring-south';
      if (r.dashed) line.computeLineDistances();
      rec.mats.push(m); rec.lines.push(line); rec.widths.push(0);
      rec.obj.add(line);
      if (withEdge) {
        const em = lineMaterial(0x000000, px + RIM_EDGE_PX, 0.6, r.dashed);
        const edge = new Line2(g, em);
        edge.frustumCulled = false;
        edge.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT - 0.1;
        edge.name = 'starlink-ring-edge';
        line.add(edge);                                  // a child, so it shows and hides with the line
        rec.mats.push(em);
      }
    }
    return rec;
  }

  function disposeRecord(rec) {
    for (const m of rec.mats) dropMaterial(m);
    for (const g of rec.geos) { owned.delete(g); g.dispose(); }
    group.remove(rec.obj);
  }

  function bandKey(b) { return `${b.loKm}|${b.hiKm}|${b.color}`; }

  function buildBand(b) {
    if (!unitCircle) {
      const n = BAND_SEGMENTS, p = new Float32Array(3 * (n + 1));
      for (let i = 0; i <= n; i++) { const a = (i % n) / n * TWO_PI; p[3 * i] = Math.cos(a); p[3 * i + 1] = Math.sin(a); p[3 * i + 2] = 0; }
      unitCircle = own(new LineGeometry());
      unitCircle.setPositions(p);
    }
    const m = lineMaterial(b.color, BAND_MIN_PX, OPACITY_BAND, false);
    const line = new Line2(unitCircle, m);
    line.frustumCulled = false;
    line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
    line.name = 'starlink-band';
    line.visible = false;
    return { key: bandKey(b), spec: b, line, mat: m, thickPx: BAND_MIN_PX, ok: false };
  }

  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  function setSpec(spec) {
    if (disposed) return;
    const rs = spec && Array.isArray(spec.rings) ? spec.rings : [];
    const bs = spec && Array.isArray(spec.bands) ? spec.bands : [];
    const oldR = new Map(rings.map((r) => [r.key, r])), oldB = new Map(bands.map((b) => [b.key, b]));
    const nextR = [], nextB = [];
    for (const raw of rs) {
      const r = { latDeg: Math.abs(num(raw.latDeg, 0)), heightKm: num(raw.heightKm, 0), color: raw.color || '#ffffff', dashed: !!raw.dashed, label: typeof raw.label === 'string' ? raw.label : '' };
      const k = ringKey(r), hit = oldR.get(k);
      if (hit && !nextR.includes(hit)) { hit.spec = r; nextR.push(hit); oldR.delete(k); } else nextR.push(buildRing(r));
    }
    for (const raw of bs) {
      const b = { loKm: num(raw.loKm, 0), hiKm: num(raw.hiKm, 0), color: raw.color || '#ffffff', label: typeof raw.label === 'string' ? raw.label : '' };
      const k = bandKey(b), hit = oldB.get(k);
      if (hit && !nextB.includes(hit)) { hit.spec = b; nextB.push(hit); oldB.delete(k); } else nextB.push(buildBand(b));
    }
    for (const r of oldR.values()) disposeRecord(r);
    for (const b of oldB.values()) { group.remove(b.line); dropMaterial(b.mat); }
    rings = nextR; bands = nextB;
    for (const r of rings) if (r.obj.parent !== group) group.add(r.obj);
    for (const b of bands) if (b.line.parent !== group) group.add(b.line);
    lastGlass = null;                                    // re-apply the widths on the next update
    marksOut = [];
    group.visible = on = !!isOn();
    if (!on) hideLabels(true);
  }

  // ---- labels (DOM) ----
  function labelEl(k) {
    if (labelEls[k]) return labelEls[k];
    const doc = getDoc();
    if (!doc || !doc.body || !doc.createElement) return null;
    const el = doc.createElement('div');
    el.className = 'starlink-rim-label';
    el.style.cssText = ['position:fixed', 'left:0', 'top:0', 'visibility:hidden', 'pointer-events:none', 'z-index:34', `height:${LABEL_H_PX}px`,
      `line-height:${LABEL_H_PX}px`, 'box-sizing:border-box', 'padding:0 5px', 'border-radius:4px', 'border-left:3px solid #ffffff', 'background:rgba(8,12,22,0.8)',
      'color:#e8eefc', 'font-family:var(--font-mono)', `font-size:${LABEL_FONT_PX}px`, 'white-space:nowrap', 'overflow:hidden', 'text-align:center',
      'user-select:none', '-webkit-user-select:none'].join(';');
    doc.body.appendChild(el);
    labelEls[k] = el;
    labelShown[k] = { on: false, x: NaN, y: NaN, text: '', color: '', w: NaN };
    return el;
  }
  function labelAt(k, show, x, y, text, color, w) {
    const el = labelEl(k);
    if (!el) return;
    const s = labelShown[k];
    if (!show) { if (s.on) { el.style.visibility = 'hidden'; s.on = false; } return; }
    if (s.text !== text) { el.textContent = text; s.text = text; }
    if (s.color !== color) { el.style.borderLeftColor = color; s.color = color; }
    if (s.w !== w) { el.style.width = `${w}px`; s.w = w; }
    if (s.x !== x || s.y !== y) { el.style.transform = `translate(${x}px, ${y}px)`; s.x = x; s.y = y; }
    if (!s.on) { el.style.visibility = 'visible'; s.on = true; }
  }
  function hideLabels(force) {
    for (let k = 0; k < labelEls.length; k++) {
      if (!labelEls[k]) continue;
      if (force || labelShown[k].on) { labelEls[k].style.visibility = 'hidden'; labelShown[k].on = false; }
    }
  }

  // ---- screen tests (no allocation) ----
  /** Project a scene point into `scr` (CSS px, y down); false when it is behind the camera. */
  function project(px, py, pz, W, H) {
    const m = vp.elements;
    const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
    if (!(w > 1e-9)) return false;
    scr.x = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * W;
    scr.y = (0.5 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5) * H;
    return true;
  }
  /** True when Earth (a sphere of EARTH_U at the origin) is between the camera and the point. */
  function behindEarth(px, py, pz) {
    const cx = camPos.x, cy = camPos.y, cz = camPos.z;
    const dx = px - cx, dy = py - cy, dz = pz - cz, L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(L > 1e-9)) return false;
    const b = (cx * dx + cy * dy + cz * dz) / L, c = cx * cx + cy * cy + cz * cz - EARTH_U * EARTH_U;
    const disc = b * b - c;
    if (!(disc > 0)) return false;
    const s1 = -b - Math.sqrt(disc);
    return s1 > 0 && s1 < L;
  }

  /** The nearest distance from (cx, cy) to a w x h box centred t along the unit direction (ux, uy) from it. */
  const boxDist = (t, ux, uy, w, h) => {
    const dx = Math.max(Math.abs(t * ux) - w / 2, 0), dy = Math.max(Math.abs(t * uy) - h / 2, 0);
    return Math.sqrt(dx * dx + dy * dy);
  };

  /**
   * Find a spot for a label: start at the anchor's bearing round Earth's centre, move out until the box is `clearR` from the centre, and if
   * that is taken or off screen slide round the centre in LABEL_STEP_DEG steps (alternating sides, at most LABEL_STEPS each way).
   * Writes left, top into `scr`; false when nothing fits.
   */
  function place(nPlaced, ax, ay, cx, cy, clearR, w, h, W, H) {
    let a0 = Math.atan2(ay - cy, ax - cx);
    if (!Number.isFinite(a0) || (Math.abs(ax - cx) < 1e-6 && Math.abs(ay - cy) < 1e-6)) a0 = -Math.PI / 2;
    for (let j = 0; j <= 2 * LABEL_STEPS; j++) {
      const k = (j + 1) >> 1, a = a0 + (j === 0 ? 0 : ((j & 1) ? 1 : -1) * k * LABEL_STEP_DEG * DEG);
      const ux = Math.cos(a), uy = Math.sin(a);
      let lo = 0, hi = clearR + w + h + 2;
      for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (boxDist(mid, ux, uy, w, h) >= clearR + 1) hi = mid; else lo = mid; }   // +1 px: the whole-pixel rounding below moves the box by under 0.8 px
      const left = cx + hi * ux - w / 2, top = cy + hi * uy - h / 2;
      if (left < 2 || top < 2 || left + w > W - 2 || top + h > H - 2) continue;
      let free = true;
      for (let p = 0; p < nPlaced; p++) {
        const o = 4 * p;
        if (left < placed[o + 2] + LABEL_GAP_PX && left + w > placed[o] - LABEL_GAP_PX && top < placed[o + 3] + LABEL_GAP_PX && top + h > placed[o + 1] - LABEL_GAP_PX) { free = false; break; }
      }
      if (!free) continue;
      scr.x = Math.round(left); scr.y = Math.round(top);
      return true;
    }
    return false;
  }

  // ---- the frame ----
  function setResolution(W, H) {
    if (W === resW && H === resH) return;
    resW = W; resH = H;
    for (const m of mats) m.resolution.set(W, H);
  }

  /** Visible samples of one circle (+lat when sign is 1, -lat when -1): fills the per-ring scratch; returns the topmost crossing / visible index. */
  function scanCircle(rec, sign, W, H, out) {
    const pts = rec.pts, n = RING_SEGMENTS;
    for (let i = 0; i < n; i++) {
      const px = pts[3 * i], py = sign * pts[3 * i + 1], pz = pts[3 * i + 2];
      if (!project(px, py, pz, W, H)) { st[i] = 0; sx[i] = sy[i] = NaN; continue; }
      sx[i] = scr.x; sy[i] = scr.y;
      if (behindEarth(px, py, pz)) st[i] = 2;
      else st[i] = (scr.x >= 0 && scr.x <= W && scr.y >= 0 && scr.y <= H) ? 1 : 0;
    }
    let cross = -1, top = -1;
    for (let i = 0; i < n; i++) {
      if (st[i] !== 1) continue;
      out.count++;
      if (sx[i] < out.minX) out.minX = sx[i]; if (sx[i] > out.maxX) out.maxX = sx[i];
      if (sy[i] < out.minY) out.minY = sy[i]; if (sy[i] > out.maxY) out.maxY = sy[i];
      if (top < 0 || sy[i] < sy[top]) top = i;
      if ((st[(i + 1) % n] === 2 || st[(i + n - 1) % n] === 2) && (cross < 0 || sy[i] < sy[cross])) cross = i;
    }
    return cross >= 0 ? cross : top;
  }

  const ana = { count: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const anaReset = () => { ana.count = 0; ana.minX = ana.minY = Infinity; ana.maxX = ana.maxY = -Infinity; };

  /** @param {number} tSec @param {THREE.Camera|null} camera */
  function update(tSec, camera) {
    if (disposed) return;
    const want = !!isOn();
    if (!want) {
      if (on || group.visible) { group.visible = false; on = false; hideLabels(false); }
      marksOut = [];
      return;
    }
    if (!on) { on = true; group.visible = true; }
    if (!camera) return;
    const v = getViewport() || {}, W = Math.max(1, v.w || 1728), H = Math.max(1, v.h || 1117);
    setResolution(W, H);
    const glass = !!isGlass();

    camera.updateMatrixWorld();
    inv.copy(camera.matrixWorld).invert();
    vp.multiplyMatrices(camera.projectionMatrix, inv);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    const d = camPos.length();
    const f = camera.projectionMatrix.elements[5] * H / 2;   // px per unit at distance 1
    if (glass !== lastGlass) {
      lastGlass = glass;
      const px = glass ? RIM_RING_PX_GLASS : RIM_RING_PX;
      for (const r of rings) { for (let k = 0; k < r.mats.length; k++) r.mats[k].linewidth = (withEdge && (k & 1) === 1) ? px + RIM_EDGE_PX : px; }
    }
    // Earth's outline on screen: a circle round the projected centre
    let cxs = W / 2, cys = H / 2, outR = 0;
    if (project(0, 0, 0, W, H)) { cxs = scr.x; cys = scr.y; }
    if (d > EARTH_U * 1.0001) outR = f * Math.tan(Math.asin(EARTH_U / d));
    const pxPerU = d > 1e-6 ? f / d : 1;
    const dash = DASH_PX / Math.max(pxPerU, 1e-6), gap = GAP_PX / Math.max(pxPerU, 1e-6);

    const mk = [];
    let np = 0;
    pend.length = 0;

    for (const r of rings) {
      if (r.dashed) for (let k = 0; k < r.mats.length; k++) { r.mats[k].dashSize = dash; r.mats[k].gapSize = gap; }
      anaReset();
      const north = scanCircle(r, 1, W, H, ana);
      let ax = NaN, ay = NaN;
      if (north >= 0) { ax = sx[north]; ay = sy[north]; }
      const south = scanCircle(r, -1, W, H, ana);
      if (north < 0 && south >= 0) { ax = sx[south]; ay = sy[south]; }
      if (ana.count > 0) {
        mk.push({ kind: 'ring', text: r.spec.label, x: ana.minX, y: ana.minY, w: ana.maxX - ana.minX, h: ana.maxY - ana.minY });
        if (r.spec.label && pend.length < MAX_LABELS && ax === ax) pend.push({ text: r.spec.label, color: r.spec.color, ax, ay, clear: outR + LABEL_CLEAR_PX });
      }
    }

    for (const b of bands) {
      const line = b.line, spec = b.spec;
      const rLo = rimRadiusU(spec.loKm), rHi = rimRadiusU(spec.hiKm), rMid = (rLo + rHi) / 2;
      b.ok = false;
      if (!(d > rHi * 1.0001)) { line.visible = false; continue; }
      const sil = (R) => { const k = R / d; const z = d - R * k; return f * R * Math.sqrt(1 - k * k) / z; };   // silhouette radius, px, for a camera looking at the centre
      const pLo = sil(rLo), pHi = sil(rHi), thick = Math.max(BAND_MIN_PX, Math.abs(pHi - pLo));
      b.thickPx = thick;
      if (b.mat.linewidth !== thick) b.mat.linewidth = thick;
      // the circle: centre R²/d towards the camera, radius R·sqrt(1-(R/d)²), in the plane facing the camera
      const k = rMid / d, cen = rMid * k, rho = rMid * Math.sqrt(1 - k * k);
      nn.copy(camPos).divideScalar(d);
      if (Math.abs(nn.y) > 0.999) tv.set(1, 0, 0); else tv.set(0, 1, 0);
      e1.crossVectors(tv, nn).normalize();
      e2.crossVectors(nn, e1);
      basis.makeBasis(e1, e2, nn);
      line.quaternion.setFromRotationMatrix(basis);
      line.position.copy(nn).multiplyScalar(cen);
      line.scale.setScalar(rho);
      line.visible = true;
      anaReset();
      let ax = NaN, ay = NaN;
      for (let i = 0; i < BAND_SEGMENTS; i++) {
        const a = i / BAND_SEGMENTS * TWO_PI, ca = Math.cos(a) * rho, sa = Math.sin(a) * rho;
        const px = nn.x * cen + e1.x * ca + e2.x * sa, py = nn.y * cen + e1.y * ca + e2.y * sa, pz = nn.z * cen + e1.z * ca + e2.z * sa;
        if (!project(px, py, pz, W, H) || scr.x < 0 || scr.x > W || scr.y < 0 || scr.y > H) continue;
        bsx[i] = scr.x; bsy[i] = scr.y; ana.count++;
        if (scr.x < ana.minX) ana.minX = scr.x; if (scr.x > ana.maxX) ana.maxX = scr.x;
        if (scr.y < ana.minY) ana.minY = scr.y;
        if (scr.y > ana.maxY) ana.maxY = scr.y;
        if (!(ay <= scr.y)) { ax = scr.x; ay = scr.y; }
      }
      if (ana.count > 0) {
        b.ok = true;
        mk.push({ kind: 'band', text: spec.label, x: ana.minX, y: ana.minY, w: ana.maxX - ana.minX, h: ana.maxY - ana.minY, thickPx: thick });
        // a band's label clears its own outer edge too
        if (spec.label && pend.length < MAX_LABELS) pend.push({ text: spec.label, color: spec.color, ax, ay, clear: Math.max(outR, Math.max(pLo, pHi) + thick / 2) + LABEL_CLEAR_PX });
      }
    }

    // labels
    const lm = [];
    for (let i = 0; i < pend.length; i++) {
      const p = pend[i], w = Math.round(LABEL_PAD_PX + LABEL_CHAR_PX * p.text.length);
      if (place(np, p.ax, p.ay, cxs, cys, p.clear, w, LABEL_H_PX, W, H)) {
        placed[4 * np] = scr.x; placed[4 * np + 1] = scr.y; placed[4 * np + 2] = scr.x + w; placed[4 * np + 3] = scr.y + LABEL_H_PX;
        labelAt(np, true, scr.x, scr.y, p.text, p.color, w);
        lm.push({ kind: 'label', text: p.text, x: scr.x, y: scr.y, w, h: LABEL_H_PX });
        np++;
      }
    }
    for (let k = np; k < labelEls.length; k++) labelAt(k, false, 0, 0, '', '', 0);
    marksOut = mk.concat(lm);
  }

  function attach(sc) {
    if (disposed || !sc) return;
    scene = sc;
    if (scene.add) scene.add(group);
    group.visible = on = !!isOn();
  }

  /** What the last `update` put on screen, CSS px (tests and probes; it allocates). */
  function marks() { return on ? marksOut.slice() : []; }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (scene && scene.remove) scene.remove(group);
    group.remove(...group.children);
    for (const o of owned) o.dispose();
    owned.clear(); mats.length = 0; rings = []; bands = []; unitCircle = null; marksOut = [];
    for (const el of labelEls) { if (el && el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el); }
    labelEls = []; labelShown = [];
    scene = null;
  }

  return { attach, update, dispose, setSpec, marks, group };
}
