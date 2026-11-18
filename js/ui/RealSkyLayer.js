/**
 * RealSkyLayer.js — the real catalogue as small fixed-size dots on floors 4 (NAVCOM) and 5 (SDA) (plan sky-1116, lane L-sky).
 *
 * Data: `data/sky.json` (scripts/build-sky.mjs: Space-Track GP mean elements, GCAT sizes, CelesTrak working / dead), fetched once on the
 * first entry to floor 4 or 5 (never at boot). Positions: SkyPropagator (two-body + J2 secular rates from the dated snapshot) at
 * "sky time" = the game date (`dateMs()`, moves when a trip lands) + the game seconds that have run since it last changed. Nothing is
 * invented: no hashed nodes, no hand-placed objects.
 *
 *   floor 4: one THREE.Points (screen-fixed size, one colour per class) in the same scene frame as the Earth, plus the picked
 *            object's orbit as one THREE.Line and a bigger highlight dot;
 *   floor 5: SdaChart is a screen-static 2D canvas with its own altitude -> radius map, so 3D dots would not line up. The layer paints
 *            its own canvas just above the chart: radius = SdaChart's `radiusPxForAltKm` of the object's height, angle = the direction
 *            of the object as the camera sees it, measured from Earth's projected centre. Repainted at most once a second.
 *
 * Gates: shows on floors 4 and 5 only, never in training 1-3 (`isTraining`). The cost is bounded: ROWS_PER_FRAME rows propagated per
 * frame (the whole sky refreshes in under a second), one `Points` draw call.
 *
 * Everything the game gives it is injected (scene, camera getter, viewport, fetch, clock, gates, card), so it runs headless.
 *
 * @module ui/RealSkyLayer
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { fetchData } from '../core/dataUrl.js';
import { SkyPropagator } from '../systems/SkyPropagator.js';
import { meoRadialMap, radiusPxForAltKm, chartTextBoxes, chartTextVersion } from './SdaChart.js';
import { cardFields, CLASS_COLORS } from './RealSkyCard.js';

export { CLASS_COLORS };

/** Rows propagated per frame: about 1 ms on the dev Mac (measured: 0.38 ms per 1,500 rows in Node); the whole sky refreshes in 9 frames, 0.15 s at 60 fps. */
export const ROWS_PER_FRAME = 4000;
/** Dot size, CSS px: mouse / glass. */
export const DOT_PX = 2;
export const DOT_PX_GLASS = 3;
/** Tap radius, CSS px: mouse / glass (the nearest painted dot inside it opens the card). */
export const PICK_PX = 12;
export const PICK_PX_GLASS = 24;
/** Floor 5 repaints at most this often (ms), or at once when the selection or window changes. */
export const PAINT_5_MS = 1000;
/** The picked object's orbit ring on floor 4: this many segments (129 points), redrawn this often (ms). */
export const ORBIT_SEGMENTS = 128;
export const ORBIT_REFRESH_MS = 2000;

const FLOOR_NAVCOM = 4;
const FLOOR_SDA = 5;
const KM_PER_UNIT = 1 / Constants.SCENE_SCALE;
const DAY_S = 86400;

/** Search: a number finds that NORAD number; text ranks exact name > name starts with > a word starts with > contains. @returns {number} row index or -1 */
export function searchRows(rows, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return -1;
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    for (let i = 0; i < rows.length; i++) if (rows[i][0] === n) return i;
    return -1;
  }
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i][1]).toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    let rank;
    if (name === q) rank = 0;
    else if (at === 0) rank = 1;
    else if (/[\s(\-[/]/.test(name[at - 1])) rank = 2;
    else rank = 3;
    // class: the working / satellite objects before debris, then the shorter name, then the lower number (rows are sorted by NORAD)
    const kind = rows[i][2] === 3 || rows[i][2] === 4 || rows[i][2] === 2 ? 0 : 1;
    const score = rank * 1e6 + kind * 1e5 + name.length;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

const defaultFetchJson = async (url) => {
  const res = await fetchData(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export class RealSkyLayer {
  /**
   * @param {object} [deps] every one optional (headless tests inject stubs)
   * @param {object} [deps.scene] THREE.Scene (add / remove)
   * @param {function} [deps.getCamera] () => THREE.PerspectiveCamera
   * @param {function} [deps.getViewport] () => {w, h} CSS px of the game canvas
   * @param {function} [deps.fetchJson] (url) => Promise<object>; default: fetchData(url).json()
   * @param {function} [deps.dateMs] () => game date ms (SunStorms.dateMs); NaN before the first start
   * @param {function} [deps.isTraining] () => true in training 1..3 (TrainingHintGate.isTrainingNow)
   * @param {function} [deps.isGlass] () => true on touch (bigger dots, bigger tap radius)
   * @param {function} [deps.pixelRatio] () => device pixel ratio
   * @param {function} [deps.now] () => monotonic ms
   * @param {object} [deps.card] RealSkyCard (show / hide / setObject / setNoMatch / setCredit)
   * @param {Document} [deps.document]
   * @param {number} [deps.rowsPerFrame]
   */
  constructor(deps = {}) {
    this._scene = deps.scene || null;
    this._getCamera = deps.getCamera || (() => null);
    this._getViewport = deps.getViewport || (() => ({ w: 1728, h: 1117 }));
    this._fetchJson = deps.fetchJson || defaultFetchJson;
    this._dateMs = deps.dateMs || (() => NaN);
    this._isTraining = deps.isTraining || (() => false);
    this._isGlass = deps.isGlass || (() => false);
    this._pixelRatio = deps.pixelRatio || (() => (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._card = deps.card || null;
    if (this._card && this._card.setHandlers) this._card.setHandlers({ onSearch: (q) => this.search(q), onClose: () => this.select(-1) });
    this._doc = deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null);
    this._rowsPerFrame = deps.rowsPerFrame || ROWS_PER_FRAME;
    // Objects that draw made-up positions on floors 4-5 (ActiveSatellites' group): hidden while the layer shows, restored after.
    this._hideWhileActive = Array.isArray(deps.hideWhileActive) ? deps.hideWhileActive : [];
    this._hidden = null;                // [{obj, was}] while they are hidden
    this._loadPromise = null;

    this._floor = null;                 // 4 or 5 while a floor asks for the layer, else null
    this._loadState = 'idle';           // idle | loading | ready | failed
    this._fetchCount = 0;
    this._sky = null;                   // data/sky.json
    this._rows = [];
    this._prop = null;
    this._snapshotMs = NaN;
    this._pos = null;                   // Float32Array(3N): scene units, the Points' position attribute too
    this._cursor = 0;
    this._lastBatch = 0;
    this._points = null;
    this._geo = null;
    this._posAttr = null;
    this._hiPoints = null;
    this._orbitLine = null;
    this._selected = -1;
    this._lastOrbitMs = -Infinity;
    this._tmp = new Float64Array(3 * (ORBIT_SEGMENTS + 1));
    this._tmp3 = new Float64Array(3);

    // the clock
    this._sumS = 0;
    this._lastDate = undefined;

    // floor 5
    this._canvas = null;
    this._ctx = null;
    this._sx = null;
    this._sy = null;
    this._cls = null;                   // Uint8Array(N): class per row, clamped to the 6 colours (floor 5 paints by class from it)
    this._lastPaintMs = -Infinity;
    this._lastPaintKey = '';
    this._painted5 = 0;

    this._vp = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this._gate = '';
    this._creditShown = '';
  }

  /* ---------------------------------------------------------------- gates and loading */

  /** A floor (4 or 5) asks for the layer. The first call starts the one fetch of data/sky.json. */
  show(floor) {
    if (floor !== FLOOR_NAVCOM && floor !== FLOOR_SDA) return;
    this._floor = floor;
    if ((this._loadState === 'idle' || this._loadState === 'failed') && !this._isTraining()) this._loadPromise = this._load();
    this._lastPaintMs = -Infinity;      // a re-show repaints floor 5 at once
    this._apply();
  }

  /** The floor that asked leaves; ignored when another floor has taken the layer since (activation order is not guaranteed). */
  hide(floor) {
    if (floor != null && this._floor !== floor) return;
    this._floor = null;
    this._apply();
  }

  /** Floors 4-5 are showing the layer's slot and training is not on: the layer draws (once loaded). */
  isActive() { return this._floor !== null && !this._isTraining(); }

  floor() { return this._floor; }
  fetchCount() { return this._fetchCount; }
  loadState() { return this._loadState; }
  dotCount() { return this._rows.length; }
  rows() { return this._rows; }
  snapshotUtc() { return this._sky ? this._sky.snapshotUtc : null; }
  selected() { return this._selected; }
  lastBatch() { return this._lastBatch; }
  propagator() { return this._prop; }
  /** The Points (floor 4) and the 2D canvas (floor 5), for the browser probe. */
  points() { return this._points; }
  canvas() { return this._canvas; }
  /** Number of dots the last floor-5 paint drew. */
  paintedCount() { return this._painted5; }

  /** Resolves when the load that a show() started has finished (tests, probes). */
  whenLoaded() { return this._loadPromise || Promise.resolve(); }

  async _load() {
    this._loadState = 'loading';
    this._fetchCount++;
    try {
      const sky = await this._fetchJson('data/sky.json');
      if (!sky || !Array.isArray(sky.rows)) throw new Error('data/sky.json: no rows');
      this._ingest(sky);
      this._loadState = 'ready';
      this._apply();
    } catch (err) {
      this._loadState = 'failed';
      this._apply();                    // the card says the data could not load; the game's own objects stay visible
      if (typeof console !== 'undefined') console.warn('[RealSkyLayer] data/sky.json not loaded:', err && err.message);
    }
  }

  _ingest(sky) {
    this._sky = sky;
    this._rows = sky.rows;
    this._snapshotMs = Date.parse(sky.snapshotUtc);
    this._prop = new SkyPropagator(sky.rows, sky.fields);
    const N = sky.rows.length;
    this._pos = new Float32Array(3 * N);
    this._sx = new Float32Array(N).fill(NaN);
    this._sy = new Float32Array(N).fill(NaN);
    const col = new Float32Array(3 * N);
    this._cls = new Uint8Array(N);
    const c = new THREE.Color();
    const palette = CLASS_COLORS.map((h) => { c.setStyle(h); return [c.r, c.g, c.b]; });
    for (let i = 0; i < N; i++) {
      const k = sky.rows[i][2];
      const ci = k >= 0 && k < palette.length ? k : palette.length - 1;   // an unknown class number draws as "unknown"
      this._cls[i] = ci;
      const p = palette[ci];
      col[3 * i] = p[0]; col[3 * i + 1] = p[1]; col[3 * i + 2] = p[2];
    }
    if (this._card && this._card.setStatusJoined) this._card.setStatusJoined(sky.statusJoined === true);
    this._buildScene(col);
    this.refreshAll();
  }

  _buildScene(col) {
    const geo = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(this._pos, 3);
    this._posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: DOT_PX, sizeAttenuation: false, vertexColors: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;                       // positions move every frame; no bounding sphere to keep right
    pts.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
    pts.visible = false;
    pts.name = 'real-sky-dots';
    this._geo = geo;
    this._points = pts;

    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const hm = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xffffff, depthWrite: false });
    this._hiPoints = new THREE.Points(hg, hm);
    this._hiPoints.frustumCulled = false;
    this._hiPoints.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT + 0.1;
    this._hiPoints.visible = false;
    this._hiPoints.name = 'real-sky-selected';

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * (ORBIT_SEGMENTS + 1)), 3));
    this._orbitLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
    this._orbitLine.frustumCulled = false;
    this._orbitLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
    this._orbitLine.visible = false;
    this._orbitLine.name = 'real-sky-orbit';

    if (this._scene && this._scene.add) {
      this._scene.add(this._points);
      this._scene.add(this._hiPoints);
      this._scene.add(this._orbitLine);
    }
  }

  /**
   * Apply the gates to everything drawn: Points on floor 4, canvas on floor 5, card on both. The dots, the highlight and the hiding of
   * the game's own template satellites wait for the data (`ready`); the card shows when the data is ready or when the fetch failed
   * (then it says so, and the game's own objects stay visible).
   */
  _apply() {
    const on = this.isActive();
    const ready = this._loadState === 'ready';
    const failed = this._loadState === 'failed';
    const showSky = on && ready;
    const f4 = showSky && this._floor === FLOOR_NAVCOM;
    const f5 = showSky && this._floor === FLOOR_SDA;
    if (this._points) {
      this._points.visible = f4;
      this._points.material.size = this._isGlass() ? DOT_PX_GLASS : DOT_PX;   // 3 px on glass, 2 px with a mouse
      const sel = this._selected >= 0;
      this._hiPoints.visible = f4 && sel;
      this._orbitLine.visible = f4 && sel;
    }
    if (this._canvas) this._canvas.style.opacity = f5 ? '1' : '0';
    if (this._card) {
      if (this._card.setLayout) this._card.setLayout(this._isGlass(), this._floor);
      if (this._card.setLoadFailed) this._card.setLoadFailed(on && failed);
      if (on && (ready || failed)) this._card.show(); else this._card.hide();
    }
    this._gate = `${on}|${this._loadState}`;
    if (showSky && !this._hidden) {
      this._hidden = this._hideWhileActive.map((obj) => ({ obj, was: obj.visible }));
      for (const h of this._hidden) h.obj.visible = false;
    } else if (!showSky && this._hidden) {
      for (const h of this._hidden) h.obj.visible = h.was;
      this._hidden = null;
    }
  }

  /* ---------------------------------------------------------------- the clock */

  _syncDate() {
    const d = this._dateMs();
    const same = Object.is(d, this._lastDate) || (Number.isNaN(d) && Number.isNaN(this._lastDate));
    if (!same) { this._sumS = 0; this._lastDate = d; }
  }

  /**
   * Game seconds that ran this frame (the world clock, held and warped as the game holds and warps it). Called every frame from the
   * game loop, on every floor: a game date change (a trip landed) restarts the sum.
   */
  tickClock(dtWorldS) {
    this._syncDate();
    if (dtWorldS > 0 && Number.isFinite(dtWorldS)) this._sumS += dtWorldS;
  }

  /** Game seconds since `dateMs()` last changed. */
  sinceDateS() { this._syncDate(); return this._sumS; }

  /** Sky time as seconds after the snapshot: the game date (else the snapshot itself) + the seconds since it last changed. */
  skySeconds() {
    this._syncDate();
    const d = this._dateMs();
    const base = Number.isFinite(d) ? d : this._snapshotMs;
    return (base + this._sumS * 1000 - this._snapshotMs) / 1000;
  }

  /** The credit line; after a year the snapshot is called old. Without the CelesTrak status join it does not claim "Working / not working: CelesTrak." */
  creditLine() {
    if (!this._sky) return '';
    let credit = this._sky.credit;
    if (this._sky.statusJoined !== true) credit = credit.replace(/\s*Working \/ not working: CelesTrak\.?/, '');
    const days = Math.floor(this.skySeconds() / DAY_S);
    return days > 365 ? `${credit} Snapshot ${days} days old.` : credit;
  }

  /* ---------------------------------------------------------------- per frame */

  /** One frame: propagate the row budget, move the highlight, repaint floor 5 when due. No-op while the layer is off. */
  update() {
    const on = this.isActive();
    if (`${on}|${this._loadState}` !== this._gate) this._apply();
    if (this._card && this._card.setLayout) this._card.setLayout(this._isGlass(), this._floor);   // a first touch / a floor change moves the panel clear of Earth
    if (this._points) { const s = this._isGlass() ? DOT_PX_GLASS : DOT_PX; if (this._points.material.size !== s) this._points.material.size = s; }
    if (!on || this._loadState !== 'ready') { this._lastBatch = 0; return; }
    const t = this.skySeconds();
    this._propagateBatch(t);
    const credit = this.creditLine();
    if (credit !== this._creditShown) { this._creditShown = credit; if (this._card && this._card.setCredit) this._card.setCredit(credit); }
    if (this._selected >= 0) this._moveSelection(t);
    if (this._floor === FLOOR_SDA) this._paint5(t);
  }

  _propagateBatch(t) {
    const N = this._rows.length;
    const n = Math.min(this._rowsPerFrame, N);
    let c = this._cursor;
    const attr = this._posAttr;
    attr.clearUpdateRanges();
    let left = n;
    while (left > 0) {
      const take = Math.min(left, N - c);
      this._propagateRange(c, c + take, t);
      attr.addUpdateRange(3 * c, 3 * take);
      left -= take;
      c = (c + take) % N;
    }
    this._cursor = c;
    attr.needsUpdate = true;
    this._lastBatch = n;
  }

  _propagateRange(from, to, t) {
    const prop = this._prop, pos = this._pos, o = this._tmp3, S = Constants.SCENE_SCALE;
    for (let i = from; i < to; i++) {
      prop.positionInto(i, t, o, 0);
      pos[3 * i] = o[0] * S; pos[3 * i + 1] = o[1] * S; pos[3 * i + 2] = o[2] * S;
    }
  }

  /** Every row now (first load, and tests). */
  refreshAll() {
    if (!this._prop) return;
    this._propagateRange(0, this._rows.length, this.skySeconds());
    this._posAttr.needsUpdate = true;
    this._posAttr.clearUpdateRanges();
  }

  /** Scene-unit position of row i as of the last propagation. @returns {{x:number,y:number,z:number}} */
  positionOf(i) { return { x: this._pos[3 * i], y: this._pos[3 * i + 1], z: this._pos[3 * i + 2] }; }

  /** Exact (not budgeted) position and orbit ring of the selected row. */
  _moveSelection(t) {
    const i = this._selected, S = Constants.SCENE_SCALE, o = this._tmp3;
    this._prop.positionInto(i, t, o, 0);
    const a = this._hiPoints.geometry.attributes.position;
    a.array[0] = o[0] * S; a.array[1] = o[1] * S; a.array[2] = o[2] * S;
    a.needsUpdate = true;
    const now = this._now();
    if (now - this._lastOrbitMs >= ORBIT_REFRESH_MS) { this._lastOrbitMs = now; this._fillOrbit(t); }
  }

  _fillOrbit(t) {
    const i = this._selected, S = Constants.SCENE_SCALE;
    this._prop.orbitLineInto(i, t, ORBIT_SEGMENTS, this._tmp);
    const arr = this._orbitLine.geometry.attributes.position.array;
    for (let k = 0; k < arr.length; k++) arr[k] = this._tmp[k] * S;
    this._orbitLine.geometry.attributes.position.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- floor 5 canvas */

  _build5() {
    if (this._canvas || !this._doc || !this._doc.body) return;
    const canvas = this._doc.createElement('canvas');
    canvas.id = 'ladder-real-sky';
    // z-index 34: just above the SdaChart canvas (33); the card (z 35+) sits over both.
    canvas.style.cssText = ['position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%', 'pointer-events:none',
      'z-index:34', `opacity:${this._floor === FLOOR_SDA && this.isActive() ? 1 : 0}`, 'transition:opacity 0.3s'].join(';');
    this._doc.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext ? canvas.getContext('2d') : null;
  }

  /** The projection of the camera as a flat matrix (row-major access via .elements, column-major storage) or null. */
  _viewProj() {
    const cam = this._getCamera();
    if (!cam) return null;
    cam.updateMatrixWorld();
    this._inv.copy(cam.matrixWorld).invert();
    this._vp.multiplyMatrices(cam.projectionMatrix, this._inv);
    return cam;
  }

  _paint5(t) {
    if (!this._canvas) this._build5();
    const g = this._ctx;
    if (!g) return;
    const vpSize = this._getViewport();
    const W = vpSize.w, H = vpSize.h;
    const key = `${W}x${H}|${this._selected}|${chartTextVersion()}`;   // the chart's text moved or repainted: clear its boxes again
    const now = this._now();
    if (key === this._lastPaintKey && now - this._lastPaintMs < PAINT_5_MS) return;
    if (!this._viewProj()) return;
    this._lastPaintKey = key;
    this._lastPaintMs = now;

    const dpr = this._pixelRatio();
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (this._canvas.width !== cw || this._canvas.height !== ch) { this._canvas.width = cw; this._canvas.height = ch; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // No per-row allocation: the projection is inlined, screen points go into the preallocated _sx / _sy, and each class is painted
    // by a pass over the preallocated class array (6 cheap passes, no arrays built, nothing grown by push).
    const m = this._vp.elements;
    const m0 = m[0], m1 = m[1], m3 = m[3], m4 = m[4], m5 = m[5], m7 = m[7], m8 = m[8], m9 = m[9], m11 = m[11], m12 = m[12], m13 = m[13], m15 = m[15];
    const map = meoRadialMap({ wPx: W, hPx: H });
    const cx = W / 2, cy = H / 2;
    const px = this._isGlass() ? DOT_PX_GLASS : DOT_PX;
    const half = px / 2;
    const pos = this._pos, N = this._rows.length, sx = this._sx, sy = this._sy, cls = this._cls;
    sx.fill(NaN); sy.fill(NaN);
    const w0 = m15;                                    // Earth's centre is the origin: clip w = m15
    if (!(w0 > 1e-9)) { this._painted5 = 0; return; }
    const c0x = (m12 / w0 * 0.5 + 0.5) * W, c0y = (-m13 / w0 * 0.5 + 0.5) * H;
    const rEarthU = Constants.EARTH_RADIUS, geoPx = map.geoPx;
    for (let i = 0; i < N; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      const w = m3 * x + m7 * y + m11 * z + m15;
      if (!(w > 1e-9)) continue;                       // behind the camera
      let dx = ((m0 * x + m4 * y + m8 * z + m12) / w * 0.5 + 0.5) * W - c0x;
      let dy = (-(m1 * x + m5 * y + m9 * z + m13) / w * 0.5 + 0.5) * H - c0y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
      const altKm = Math.max(0, Math.sqrt(x * x + y * y + z * z) - rEarthU) * KM_PER_UNIT;
      const r = Math.min(radiusPxForAltKm(map, altKm), geoPx);   // above the GEO ring: on the ring (the chart's edge)
      sx[i] = cx + dx * r; sy[i] = cy + dy * r;
    }
    let n = 0;
    for (let c = 0; c < CLASS_COLORS.length; c++) {
      g.fillStyle = CLASS_COLORS[c];
      for (let i = 0; i < N; i++) {
        if (cls[i] !== c || sx[i] !== sx[i]) continue;   // sx[i] !== sx[i]: NaN, not painted
        g.fillRect(sx[i] - half, sy[i] - half, px, px);
        n++;
      }
    }
    this._painted5 = n;
    // The chart's own text (ring labels, tag, bottom lines, strip title) is on the canvas UNDER this one: wipe the dots out of each
    // string's box, 3 px of margin, so every label reads (lane fix F1, 2026-11-18; the dense LEO shells covered the top labels).
    for (const b of chartTextBoxes()) g.clearRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    const s = this._selected;
    if (s >= 0 && Number.isFinite(sx[s])) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(sx[s], sy[s], 7, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /** Screen point (CSS px) a row was last painted at on floor 5, or null. */
  paintedPoint(i) { return this._sx && Number.isFinite(this._sx[i]) ? { x: this._sx[i], y: this._sy[i] } : null; }

  /** The radius (CSS px from the screen centre) floor 5 gives an object at this height, through the chart's own map. */
  radiusPxFor(altKm) {
    const v = this._getViewport();
    return radiusPxForAltKm(meoRadialMap({ wPx: v.w, hPx: v.h }), altKm);
  }

  /* ---------------------------------------------------------------- pick, select, search */

  /**
   * The nearest painted dot to a tap (CSS px) inside the tap radius, or -1. Floor 5: the dots as last painted. Floor 4: the dots as the
   * camera sees them now, those behind Earth excluded (they are not painted).
   * @param {number} x @param {number} y @param {{glass?: boolean}} [opts]
   * @returns {number} row index or -1
   */
  pick(x, y, opts = {}) {
    if (!this.isActive() || this._loadState !== 'ready') return -1;
    const glass = opts.glass !== undefined ? opts.glass : this._isGlass();
    const R = glass ? PICK_PX_GLASS : PICK_PX;
    return this._floor === FLOOR_SDA ? this._pick5(x, y, R) : this._pick4(x, y, R);
  }

  _pick5(x, y, R) {
    const sx = this._sx, sy = this._sy;
    let best = -1, bd = R * R;
    for (let i = 0; i < sx.length; i++) {
      const dx = sx[i] - x, dy = sy[i] - y;          // NaN (unpainted) compares false
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  }

  _pick4(x, y, R) {
    const cam = this._viewProj();
    if (!cam) return -1;
    const v = this._getViewport(), W = v.w, H = v.h;
    const m = this._vp.elements;
    const cp = cam.position;
    const pos = this._pos, N = this._rows.length, RE = Constants.EARTH_RADIUS;
    let best = -1, bd = R * R;
    for (let i = 0; i < N; i++) {
      const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (!(w > 1e-9)) continue;
      const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * W;
      const sy = (-(m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5) * H;
      const dx = sx - x, dy = sy - y;
      const d = dx * dx + dy * dy;
      if (d > bd) continue;
      // behind Earth? the camera-to-dot segment enters the sphere before it reaches the dot
      const ex = px - cp.x, ey = py - cp.y, ez = pz - cp.z;
      const a = ex * ex + ey * ey + ez * ez;
      const b = cp.x * ex + cp.y * ey + cp.z * ez;
      const c = cp.x * cp.x + cp.y * cp.y + cp.z * cp.z - RE * RE;
      const disc = b * b - a * c;
      if (disc > 0) {
        const t1 = (-b - Math.sqrt(disc)) / a;
        if (t1 > 0 && t1 < 1) continue;
      }
      bd = d; best = i;
    }
    return best;
  }

  /** The card's content for row i (strings). */
  describe(i) {
    if (i < 0 || !this._prop) return null;
    const g = this._sky.gcatNames;
    return cardFields(this._rows[i], this._prop.heightsKm(i), this._sky.snapshotUtc, g ? g[this._rows[i][0]] : undefined);
  }

  /** Open the card on row i (or close with -1), highlight its dot, draw its orbit (floor 4). */
  select(i) {
    this._selected = i >= 0 && i < this._rows.length ? i : -1;
    if (this._card) this._card.setObject(this._selected >= 0 ? this.describe(this._selected) : null);
    if (this._selected >= 0) {
      this._lastOrbitMs = -Infinity;
      const t = this.skySeconds();
      this._moveSelection(t);
    }
    this._lastPaintMs = -Infinity;
    this._apply();
    return this._selected;
  }

  /** Tap resolver: pick, and open the card when a dot was hit. @returns {boolean} true when a dot was hit (the tap is used) */
  tap(x, y, opts) {
    const i = this.pick(x, y, opts);
    if (i < 0) return false;
    this.select(i);
    if (this._card && this._card.clearSearch) this._card.clearSearch();
    return true;
  }

  /** Search by name or NORAD number: opens the best match's card and highlights its dot. No camera move. @returns {number} row index or -1 */
  search(query) {
    if (this._loadState !== 'ready') return -1;
    const i = searchRows(this._rows, query);
    if (i >= 0) this.select(i);
    else if (this._card && this._card.setNoMatch) this._card.setNoMatch(String(query == null ? '' : query).trim());
    return i;
  }

  dispose() {
    if (this._scene && this._scene.remove) {
      for (const o of [this._points, this._hiPoints, this._orbitLine]) if (o) this._scene.remove(o);
    }
    for (const o of [this._points, this._hiPoints, this._orbitLine]) {
      if (o) { o.geometry.dispose(); o.material.dispose(); }
    }
    if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null; this._ctx = null;
  }
}
