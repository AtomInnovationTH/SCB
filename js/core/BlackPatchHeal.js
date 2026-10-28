/**
 * @module core/BlackPatchHeal — notice the black box on F4/F5, heal it, record what healed it. PRODUCTION module
 * (unlike the dev-only BlackFrameProbe). Off switch: `?heal=0`.
 * No feature flag, no Events key.
 *
 * Problem (owner 2026-10-08; BLACK_SCREEN_TRIAGE.md "Producer 4"): on F4 the slightest zoom can flash a black box in
 * the middle of the picture while the left/right edges keep drawing, and ANY window resize fixes it. The owner's bfp
 * dump (Brave 155, ANGLE-Metal) read the game's own framebuffer centre at 0.000 with live edges for ~5 s, no GL error,
 * no context loss. Never reproduced headless. A full composer rebuild in that dump did NOT heal it, so which step heals
 * is unknown: this module tries cheap steps first and records which one worked.
 *
 * Reads three 4×4 patches of the default framebuffer (same positions and luma as the probe), only on F4/F5, never while
 * a ride is in flight, every 120 frames (every 30 = BlackFrameProbe's READ_EVERY for 10 s after a zoom input); each
 * read is a synchronous GPU drain.
 *
 * The black box (all of):
 *   - centre luma < BLACK_LUMA on 2 consecutive reads;
 *   - max(left, right) ≥ EDGE_LIVE (the picture is drawing, only the middle died);
 *   - the camera's centre ray hits the Earth's day side (sun dot ≥ SUN_DOT_MIN), so the centre SHOULD be lit.
 *   Open space or night side → no action.
 *
 * Steps (stops at the first after which the centre reads ≥ HEALED_LUMA on the next 2 rendered frames):
 *   S1 projection — camera.updateProjectionMatrix() (invisible)
 *   S2 canvas     — a same-size resize (reallocates the drawing buffer, renders)
 *   S3 targets    — SceneManager.reallocateRenderTargets() (composer targets)
 *   S4 composer   — SceneManager.applyTier(current tier) (full rebuild, flashes)
 * If none heals: record healedBy null and back off 60 s; at most 3 runs per 5 minutes. It never touches the tier,
 * pinTier or the adapt counters.
 *
 * Every detection writes ONE record (before any step): time, floor, tier, camera distance, clip planes, canvas, lumas,
 * the expectation, and the first ≤ 3 meshes the centre ray hits. An unexpected object in front of the Earth = a scene
 * bug; the Earth itself first = a buffer/pipeline bug.
 */

import * as THREE from 'three';
import { Constants } from './Constants.js';
import { StorageKeys } from './StorageKeys.js';

// Thresholds
/** Sampled patch size in device pixels (same as BlackFrameProbe). */
export const PATCH = 4;
/** Below this mean luma a patch counts as black (8-bit noise floor). */
export const BLACK_LUMA = 0.004;
/** An edge patch at or above this is "the picture is drawing". */
export const EDGE_LIVE = 0.02;
/** A centre read at or above this after a step counts as healed. */
export const HEALED_LUMA = 0.02;
/** Day-side test: dot(surface normal, sun direction) must be at least this. */
export const SUN_DOT_MIN = 0.2;
/**
 * Read cadence in frames: inside the post-zoom window / otherwise. 30 = the probe's READ_EVERY
 * (15 meant 8 GPU drains/s at 120 Hz right after every zoom).
 */
export const READ_EVERY_FAST = 30;
export const READ_EVERY_SLOW = 120;
/** The post-zoom window: ms after the last tick whose ladder holdoff was true. */
export const POST_ZOOM_WINDOW_MS = 10000;
/** Rendered frames the centre must stay lit after a step to count as healed. */
export const HEAL_CONFIRM_FRAMES = 2;
/** After a run that healed nothing, no new run for this long. */
export const BACKOFF_MS = 60000;
/** At most this many runs in any RUN_CAP_WINDOW_MS. */
export const RUN_CAP = 3;
export const RUN_CAP_WINDOW_MS = 5 * 60 * 1000;
/** A running ladder with no tick for this long was interrupted (cover, map, hidden). */
export const STALE_RUN_MS = 4000;
/** Records kept in memory and in localStorage. */
export const LOG_MAX = 20;
/** Meshes recorded from the centre-ray raycast. */
export const HITS_MAX = 3;
/** localStorage key for the persisted ring (registered in StorageKeys.js). */
export const HEAL_STORAGE_KEY = StorageKeys.BLACK_HEAL;
/** Ladder floors the heal watches (Earth-anchored, where the owner sees it). */
const WATCHED_FLOORS = [4, 5];
/** Step names, in the order they run. */
export const STEP_NAMES = ['projection', 'canvas', 'targets', 'composer'];

// Pure helpers

/**
 * Is the centre patch the black box? `expect` (from rayHitsLitEarth) is only consulted when the centre is black
 * (pass null otherwise).
 * @returns {'ok'|'black'|'skip'} ok = centre drawing; black = the box, act; skip = dark but legitimately
 * (edges dead too, open space, night side, or unknown expectation)
 */
export function centreVerdict(lumas, expect) {
  if (!lumas || !(lumas.c < BLACK_LUMA)) return 'ok';
  if (!(Math.max(lumas.l, lumas.r) >= EDGE_LIVE)) return 'skip';
  if (!expect || !expect.hit || !(expect.sunDot >= SUN_DOT_MIN)) return 'skip';
  return 'black';
}

/**
 * Does the camera centre ray hit the Earth sphere, and how lit is the point it hits? Pure math on any {x,y,z}. camDir
 * is a unit vector; sunDir points TO the sun (world space); radius in scene units. hit=false when the ray misses, the
 * sphere is behind the camera, or the camera is inside it.
 * @returns {{hit:boolean, sunDot:number, lit:boolean, t:number}}
 */
export function rayHitsLitEarth(camPos, camDir, earthCentre, radius, sunDir) {
  const miss = { hit: false, sunDot: 0, lit: false, t: -1 };
  const ox = camPos.x - earthCentre.x;
  const oy = camPos.y - earthCentre.y;
  const oz = camPos.z - earthCentre.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c < 0) return miss; // camera inside the sphere
  const b = ox * camDir.x + oy * camDir.y + oz * camDir.z;
  const disc = b * b - c;
  if (disc < 0) return miss; // line misses the sphere
  const t = -b - Math.sqrt(disc);
  if (t < 0) return miss; // sphere is behind the camera
  const nx = (ox + camDir.x * t) / radius;
  const ny = (oy + camDir.y * t) / radius;
  const nz = (oz + camDir.z * t) / radius;
  const sl = Math.hypot(sunDir.x, sunDir.y, sunDir.z) || 1;
  const sunDot = (nx * sunDir.x + ny * sunDir.y + nz * sunDir.z) / sl;
  return { hit: true, sunDot, lit: sunDot >= SUN_DOT_MIN, t };
}

/**
 * The heal-step state machine, free of GL and the DOM. `steps` is an ordered array of `{ name, run }`; `run` is called
 * synchronously the moment its step begins. Feed it one centre-luma read per rendered frame via `observe`.
 *  - start() runs step 1 at once; each `observe(c)` then judges the step just run: c ≥ HEALED_LUMA for
 *    HEAL_CONFIRM_FRAMES reads in a row = healed by that step; any read below it = next step (run now);
 *  - the steps running out = healedBy null + a BACKOFF_MS back-off;
 *  - abort() = healedBy 'aborted' (counts toward the run cap, no back-off);
 *  - canStart() is false inside a back-off or once RUN_CAP runs started within RUN_CAP_WINDOW_MS.
 * @param {{ steps: Array<{name:string, run:function(): void}>, now?: function(): number }} opts
 */
export function createHealLadder({ steps, now = () => performance.now() } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  let running = false;
  let idx = -1;
  let okFrames = 0;
  let startMs = 0;
  let backoffUntil = -Infinity;
  let runStarts = [];
  let result = null;
  let entry = null;

  function prune(nowMs) {
    if (runStarts.length && nowMs - runStarts[0] >= RUN_CAP_WINDOW_MS) {
      runStarts = runStarts.filter((t) => nowMs - t < RUN_CAP_WINDOW_MS);
    }
  }

  function finish(healedBy, nowMs) {
    running = false;
    result.healedBy = healedBy;
    result.ms = Math.round(nowMs - startMs);
    if (healedBy === null) backoffUntil = nowMs + BACKOFF_MS;
    const out = result;
    result = null;
    entry = null;
    return out;
  }

  /** Begin the next step; returns the finished result when the steps ran out. */
  function advance(nowMs) {
    idx++;
    okFrames = 0;
    if (idx >= list.length) return finish(null, nowMs);
    entry = { name: list[idx].name, cAfter: null };
    result.steps.push(entry);
    try {
      list[idx].run();
    } catch (e) {
      entry.error = String((e && e.message) || e);
    }
    return null;
  }

  return {
    get running() { return running; },
    canStart(nowMs = now()) {
      if (running || !list.length) return false;
      if (nowMs < backoffUntil) return false;
      prune(nowMs);
      return runStarts.length < RUN_CAP;
    },
    /** @returns {boolean} true when a run began (step 1 already ran) */
    start(nowMs = now()) {
      if (!this.canStart(nowMs)) return false;
      running = true;
      startMs = nowMs;
      runStarts.push(nowMs);
      result = { steps: [], healedBy: null, ms: 0 };
      idx = -1;
      advance(nowMs); // never finishes here: canStart() refuses an empty list
      return true;
    },
    /**
     * @param {number} c centre luma read this frame  @returns {object|null} the finished run `{steps, healedBy, ms}`,
     * else null
     */
    observe(c, nowMs = now()) {
      if (!running) return null;
      entry.cAfter = c;
      if (c >= HEALED_LUMA) {
        okFrames++;
        if (okFrames >= HEAL_CONFIRM_FRAMES) return finish(entry.name, nowMs);
        return null;
      }
      return advance(nowMs);
    },
    /** @returns {object|null} the finished run, healedBy 'aborted' */
    abort(nowMs = now()) {
      if (!running) return null;
      return finish('aborted', nowMs);
    },
  };
}

// The log (in memory + localStorage)
const ring = [];

/** @returns {object[]} a copy of the last (up to LOG_MAX) heal records, oldest first */
export function getHealLog() {
  return ring.slice();
}

/** Test seam: empty the in-memory ring (does not touch storage). */
export function _resetHealLogForTest() {
  ring.length = 0;
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_e) {
    return null; // Brave/Safari can throw on access
  }
}

function loadPersisted(storage) {
  if (!storage || ring.length) return;
  try {
    const raw = storage.getItem(HEAL_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) {
      for (const rec of arr.slice(-LOG_MAX)) {
        if (rec && typeof rec === 'object') ring.push(rec);
      }
    }
  } catch (_e) { /* corrupt blob: start empty */ }
}

function pushRecord(rec, storage) {
  ring.push(rec);
  while (ring.length > LOG_MAX) ring.shift();
  if (!storage) return;
  try { storage.setItem(HEAL_STORAGE_KEY, JSON.stringify(ring)); } catch (_e) { /* quota/private mode */ }
}

const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

/** One raycast hit → the plain-words record fields. `drawn` = the main camera draws this object's layer: the raycast
 *  also sees layer 1 (near-field subtree), so a layer-1 hit with drawn false is NOT the occluder on a floor whose
 *  near-field pass is off. */
function describeHit(h, camLayers) {
  const o = h.object;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  const parents = [];
  for (let p = o.parent; p && parents.length < 2; p = p.parent) parents.push(p.name || p.type);
  return {
    name: o.name || '',
    type: o.type,
    material: m ? m.type : null,
    renderOrder: o.renderOrder,
    transparent: !!(m && m.transparent),
    depthTest: m ? m.depthTest !== false : null,
    depthWrite: m ? m.depthWrite !== false : null,
    layers: o.layers ? o.layers.mask : null,
    drawn: (camLayers && o.layers) ? o.layers.test(camLayers) : null,
    parents,
    dist: round(h.distance, 3),
  };
}

/** The one console line per run. */
function warnLine(rec) {
  const hit = rec.hits && rec.hits[0] ? (rec.hits[0].name || rec.hits[0].type) : 'nothing';
  const head = `[BLACK-HEAL] F${rec.floor} centre black (${rec.lumas.c.toFixed(3)}, edges ${Math.max(rec.lumas.l, rec.lumas.r).toFixed(2)})`;
  let verdict;
  if (rec.healedBy === null) verdict = `not healed (tried ${rec.steps.map((s) => s.name).join(', ')}) in ${rec.ms} ms`;
  else if (rec.healedBy === 'aborted') verdict = `run aborted after ${rec.ms} ms (floor, ride, tab or paint changed, centre no longer expected lit, or a read failed)`;
  else verdict = `healed by "${rec.healedBy}" in ${rec.ms} ms`;
  return `${head} — ${verdict}; first hit: ${hit}`;
}

/**
 * Install the heal (once, after SceneManager + Earth exist). Returns null when `?heal=0` or there is no WebGL context,
 * so the per-frame hook is a single falsy check. Heavy objects are allocated here, once; `tick` allocates nothing on a
 * frame that does not read. deps: `getLadder` is a getter on purpose
 * (main.js assigns its ladderController AFTER this install point, and never on a ?ladder=0 boot); `steps` overrides
 * individual steps by name (main.js passes `canvas`); the rest (search, now, isVisible, storage, warn) are test seams
 * with production defaults.
 * @returns {{ tick: function(number): void }|null}
 */
export function installBlackPatchHeal({
  sceneManager, earth, getLadder, steps, search,
  now = () => performance.now(),
  isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible',
  storage = defaultStorage(),
  warn = (line) => { try { console.warn(line); } catch (_e) { /* noop */ } },
} = {}) {
  let q = search;
  if (q === undefined) {
    q = (typeof window !== 'undefined' && window.location) ? window.location.search : '';
  }
  try {
    if (new URLSearchParams(q || '').get('heal') === '0') return null;
  } catch (_e) { /* unparsable query → default on */ }
  if (!sceneManager || !sceneManager.renderer) return null;
  const renderer = sceneManager.renderer;
  const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
  if (!gl || typeof gl.readPixels !== 'function') return null;

  loadPersisted(storage);

  // Heal steps (names fixed; `steps` may replace any)
  const table = {
    projection: () => {
      if (sceneManager.camera) sceneManager.camera.updateProjectionMatrix();
      if (sceneManager.nearCamera) sceneManager.nearCamera.updateProjectionMatrix();
    },
    canvas: () => sceneManager.resize(),
    targets: () => sceneManager.reallocateRenderTargets(),
    composer: () => sceneManager.applyTier(sceneManager.currentTier),
    ...(steps || {}),
  };
  const ladderSteps = STEP_NAMES.map((name) => ({ name, run: table[name] }));
  const healLadder = createHealLadder({ steps: ladderSteps, now });

  // Allocated once
  const pxBuf = new Uint8Array(PATCH * PATCH * 4);
  const lumas = { c: 0, l: 0, r: 0 };
  const rc = new THREE.Raycaster();
  rc.layers.enableAll(); // the near-field subtree is on layer 1
  const ndc = new THREE.Vector2(0, 0);
  const earthC = new THREE.Vector3();
  const hitBuf = [];
  const visit = (o) => {
    if (!(o.isMesh || o.isSprite) || !o.layers.test(rc.layers)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.visible === false) return; // never drawn
    o.raycast(rc, hitBuf);
  };

  // State
  let sinceRead = 0;
  let suspect = false;            // one black read seen, a second one confirms
  let lastHoldoffTrueMs = -Infinity;
  let lastTickMs = -Infinity;
  let current = null;             // the record of the run in flight
  let runFloor = 0;

  function readLuma(x, y) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const rx = Math.max(0, Math.min(w - PATCH, Math.round(x)));
    const ry = Math.max(0, Math.min(h - PATCH, Math.round(y)));
    gl.readPixels(rx, ry, PATCH, PATCH, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf);
    let sum = 0;
    for (let i = 0; i < pxBuf.length; i += 4) {
      sum += 0.2126 * pxBuf[i] + 0.7152 * pxBuf[i + 1] + 0.0722 * pxBuf[i + 2];
    }
    return sum / ((pxBuf.length / 4) * 255);
  }

  /** @returns {boolean} false when the buffer cannot be read right now */
  function canRead() {
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return false;
    return gl.drawingBufferWidth >= PATCH && gl.drawingBufferHeight >= PATCH;
  }

  /** Centre only (the ladder's per-frame read). -1 on failure. */
  function readCentre() {
    try {
      if (!canRead()) return -1;
      return readLuma((gl.drawingBufferWidth - PATCH) / 2, (gl.drawingBufferHeight - PATCH) / 2);
    } catch (_e) { return -1; }
  }

  /** Centre + left + right into `lumas`. @returns {boolean} */
  function readPatches() {
    try {
      if (!canRead()) return false;
      const w = gl.drawingBufferWidth;
      const midY = (gl.drawingBufferHeight - PATCH) / 2;
      lumas.c = readLuma((w - PATCH) / 2, midY);
      lumas.l = readLuma(4, midY);
      lumas.r = readLuma(w - PATCH - 4, midY);
      return true;
    } catch (_e) { return false; }
  }

  /**
   * Aim the raycaster down the camera's centre ray and test it against the Earth sphere; leaves `rc` aimed for
   * collectHits. Null when unknowable.
   */
  function computeExpectation() {
    const cam = sceneManager.camera;
    const mesh = earth && earth.surfaceMesh;
    const uni = earth && earth.surfaceMaterial && earth.surfaceMaterial.uniforms;
    if (!cam || !mesh || !uni || !uni.uSunDirection) return null;
    rc.setFromCamera(ndc, cam);
    rc.near = cam.near;
    rc.far = cam.far;
    mesh.getWorldPosition(earthC);
    return rayHitsLitEarth(rc.ray.origin, rc.ray.direction, earthC, Constants.EARTH_RADIUS, uni.uSunDirection.value);
  }

  /** First ≤ HITS_MAX drawn meshes/sprites on the centre ray (rc must be aimed). */
  function collectHits() {
    hitBuf.length = 0;
    try {
      const scene = typeof sceneManager.getScene === 'function' ? sceneManager.getScene() : null;
      if (scene) scene.traverseVisible(visit);
    } catch (_e) { /* a raycast failure must not cost the heal */ }
    hitBuf.sort((a, b) => a.distance - b.distance);
    const out = [];
    const camLayers = sceneManager.camera ? sceneManager.camera.layers : null;
    for (let i = 0; i < hitBuf.length && out.length < HITS_MAX; i++) out.push(describeHit(hitBuf[i], camLayers));
    hitBuf.length = 0;
    return out;
  }

  function buildRecord(floor, expect) {
    const cam = sceneManager.camera;
    return {
      t: new Date().toISOString(),
      floor,
      tier: sceneManager.currentTier,
      camDist: round(rc.ray.origin.distanceTo(earthC), 3),
      near: cam.near,
      far: cam.far,
      fov: cam.fov,
      canvas: {
        w: gl.drawingBufferWidth, h: gl.drawingBufferHeight,
        pr: typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : null,
      },
      lumas: { c: round(lumas.c, 4), l: round(lumas.l, 4), r: round(lumas.r, 4) },
      expect: { hit: expect.hit, sunDot: round(expect.sunDot, 3) },
      hits: collectHits(),
      steps: [],
      healedBy: null,
      ms: 0,
    };
  }

  function finalize(res) {
    const rec = current;
    current = null;
    suspect = false;
    sinceRead = 0;
    if (!rec) return;
    rec.steps = res.steps;
    rec.healedBy = res.healedBy;
    rec.ms = res.ms;
    pushRecord(rec, storage);
    warn(warnLine(rec));
  }

  /** One frame of an in-flight run: abort checks, then judge the step. */
  function runFrame(nowMs, lad, stale) {
    let res = null;
    if (stale || !lad || !lad.isActive() || lad.isRiding() || !isVisible() || lad.currentFloor() !== runFloor) {
      res = healLadder.abort(nowMs);
    } else {
      const c = readCentre();
      let expect = null;
      if (c >= 0 && c < HEALED_LUMA) expect = computeExpectation();
      if (c < 0 || (c < HEALED_LUMA && !(expect && expect.lit))) res = healLadder.abort(nowMs);
      else res = healLadder.observe(c, nowMs);
    }
    if (res) finalize(res);
  }

  /** A scheduled read on F4/F5: judge it; a second black read starts a run. */
  function readOnce(nowMs, floor) {
    if (!readPatches()) { suspect = false; return; }
    const expect = lumas.c < BLACK_LUMA ? computeExpectation() : null;
    if (centreVerdict(lumas, expect) !== 'black') { suspect = false; return; }
    if (!suspect) { suspect = true; return; }
    suspect = false;
    current = buildRecord(floor, expect);
    runFloor = floor;
    if (!healLadder.start(nowMs)) current = null;
  }

  return {
    /**
     * Call once per DRAWN frame, right after the final render in the same rAF task (the buffer is read before present).
     * @param {number} _ts rAF timestamp (unused: the clock is `now`)
     */
    tick(_ts) {
      const nowMs = now();
      const gap = nowMs - lastTickMs;
      lastTickMs = nowMs;
      const lad = getLadder ? getLadder() : null;
      if (lad && typeof lad.adaptHoldoff === 'function' && lad.adaptHoldoff(nowMs)) lastHoldoffTrueMs = nowMs;

      if (healLadder.running) {
        runFrame(nowMs, lad, gap > STALE_RUN_MS);
        lastTickMs = now(); // a step's own stall (a composer rebuild) is not a gap in ticks
        return;
      }

      sinceRead++;
      const interval = (suspect || nowMs - lastHoldoffTrueMs < POST_ZOOM_WINDOW_MS) ? READ_EVERY_FAST : READ_EVERY_SLOW;
      if (sinceRead < interval) return;
      // Due. Cheapest gates first; a failure leaves the read due, except those that cost an allocation.
      if (!lad || !lad.isActive()) { suspect = false; return; }
      if (!healLadder.canStart(nowMs)) { sinceRead = 0; suspect = false; return; }
      if (lad.isRiding() || !isVisible()) { suspect = false; return; }
      sinceRead = 0;
      const floor = lad.currentFloor(); // allocates a snapshot: only on a frame that reads
      if (WATCHED_FLOORS.indexOf(floor) < 0) { suspect = false; return; }
      readOnce(nowMs, floor);
    },
  };
}

export default installBlackPatchHeal;
