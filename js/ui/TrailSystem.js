/**
 * TrailSystem.js — I-War-heritage trail lines for player satellite and arms.
 * Renders thin glowing lines showing trajectory history, coloured by velocity
 * direction (prograde=green, retrograde=red, radial=amber), plus thinner white
 * arm trails that shorten during reel-in.
 *
 * Uses THREE.Line with per-vertex RGBA ShaderMaterial — no ribbon geometry,
 * no z-fighting, no degenerate triangles. Clean 1-pixel lines inspired by
 * Independence War's elegant trajectory visualisation.
 *
 * ST-5.2 — Epic 5 Q1 UX Foundation
 * @module ui/TrailSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// ============================================================================
// PURE HELPERS (exported for Node tests via CJS guard at EOF)
// ============================================================================

/**
 * Classify trail colour by prograde dot product.
 * @param {number} dot - dot(velocity_unit, orbit_tangent_unit)
 * @param {number} threshold - positive threshold (default 0.7)
 * @returns {'prograde'|'retrograde'|'normal'}
 */
function classifyColorByProgradeDot(dot, threshold) {
  if (dot > threshold) return 'prograde';
  if (dot < -threshold) return 'retrograde';
  return 'normal';
}

/**
 * Compute per-vertex fade alpha (linear ramp from minAlpha at oldest → 1.0 at newest).
 * @param {number} indexFromOldest - 0 = oldest visible sample
 * @param {number} totalCount - total visible samples
 * @param {number} minAlpha - alpha of the oldest point (e.g. 0.05)
 * @returns {number} alpha in [minAlpha, 1.0]
 */
function computeFadeAlpha(indexFromOldest, totalCount, minAlpha) {
  if (totalCount <= 1) return 1.0;
  const t = indexFromOldest / (totalCount - 1);
  return minAlpha + t * (1.0 - minAlpha);
}

/**
 * Advance a ring buffer write head and count.
 * @param {number} head - current write index
 * @param {number} count - number of valid entries
 * @param {number} capacity - max buffer size
 * @returns {{ head: number, count: number }}
 */
function advanceRingBuffer(head, count, capacity) {
  const newHead = (head + 1) % capacity;
  const newCount = Math.min(count + 1, capacity);
  return { head: newHead, count: newCount };
}

/**
 * Sample-rate gating accumulator.
 * @param {number} accum - accumulated time since last sample
 * @param {number} dt - delta time to add
 * @param {number} hz - target sample rate in Hz
 * @returns {{ accum: number, shouldSample: boolean }}
 */
function sampleRateGate(accum, dt, hz) {
  accum += dt;
  const interval = 1 / hz;
  const shouldSample = accum >= interval;
  if (shouldSample) accum -= interval;
  return { accum, shouldSample };
}

/**
 * Process an arm state change for trail lifecycle.
 * @param {string} newState - new arm state name
 * @param {number} trimOffset - current trim offset
 * @param {number} count - current sample count
 * @returns {{ isReeling: boolean, trimOffset: number, count: number, cleared: boolean }}
 */
function processArmStateChange(newState, trimOffset, count) {
  if (newState === 'REELING') {
    return { isReeling: true, trimOffset, count, cleared: false };
  } else if (newState === 'DOCKED' || newState === 'RELOADING') {
    return { isReeling: false, trimOffset: 0, count: 0, cleared: true };
  }
  return { isReeling: false, trimOffset: 0, count, cleared: false };
}

/**
 * Advance the reel-in trim offset.
 * @param {number} trimOffset - current trim offset
 * @param {number} count - current sample count
 * @param {number} dt - real-time delta
 * @param {number} trimRate - samples per second to trim
 * @returns {number} new trim offset
 */
function updateReelTrim(trimOffset, count, dt, trimRate) {
  if (count <= 0) return trimOffset;
  return Math.min(trimOffset + trimRate * dt, count);
}

// ============================================================================
// SHADER SOURCE — simple pass-through for per-vertex RGBA on lines
// ============================================================================

const TRAIL_VERTEX_SHADER = /* glsl */ `
  attribute vec4 aColor;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vColor;
  void main() {
    if (vColor.a < 0.01) discard;
    gl_FragColor = vColor;
  }
`;

// ============================================================================
// TRAILSYSTEM CLASS
// ============================================================================

/** 1 metre in scene units (1 scene unit = 100 km) */
const M = 0.00001;

export class TrailSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} eb - EventBus instance
   */
  constructor(scene, eb) {
    this._scene = scene;
    this._eventBus = eb || eventBus;

    const T = Constants.TRAILS || {};
    this._enabled = T.ENABLED !== false;
    this._active = false; // only process samples during gameplay states
    this._minSampleDistSq = ((T.MIN_SAMPLE_DIST_M || 2) * M) ** 2; // squared min distance

    if (!this._enabled) return;

    // Player trail
    const playerCap = (T.MOTHER_BUFFER_SECONDS || 90) * (T.SAMPLE_RATE_HZ || 10);
    this._playerTrail = this._createTrail(playerCap, false);

    // Arm trails (created on demand)
    this._armTrails = new Map();

    // Subscribe to events
    this._setupEventListeners();
  }

  // --------------------------------------------------------------------------
  // TRAIL CREATION
  // --------------------------------------------------------------------------

  /**
   * Create a trail structure: ring-buffer + THREE.Line.
   * Uses per-vertex RGBA via custom ShaderMaterial for clean thin lines.
   * @param {number} capacity - max samples
   * @param {boolean} isArm - true for arm trails (white, thinner)
   * @returns {object} trail state object
   * @private
   */
  _createTrail(capacity, isArm) {
    // Ring buffer for samples
    const samples = new Array(capacity);
    for (let i = 0; i < capacity; i++) samples[i] = null;

    // Geometry: 1 vertex per sample (simple line strip)
    const positions = new Float32Array(capacity * 3);
    const colors = new Float32Array(capacity * 4);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 4));
    geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERTEX_SHADER,
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });

    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false; // trail can span large arcs
    line.renderOrder = -1;     // render behind most scene objects
    line.visible = false;      // hidden until thrust samples arrive
    this._scene.add(line);

    return {
      samples,
      head: 0,
      count: 0,
      capacity,
      mesh: line, // keep key name for compatibility with visibility logic
      geometry,
      positions,
      colors,
      isArm,
      dirty: false,
      trimOffset: 0,
      isReeling: false,
    };
  }

  // --------------------------------------------------------------------------
  // EVENT LISTENERS
  // --------------------------------------------------------------------------

  /** @private */
  _setupEventListeners() {
    const eb = this._eventBus;

    // Track gameplay state — show/hide all trail meshes
    eb.on(Events.GAME_STATE_CHANGE, (data) => {
      const gameplay = ['ORBITAL_VIEW', 'APPROACH', 'INTERACTION'];
      const wasActive = this._active;
      this._active = gameplay.includes(data.to);

      if (this._active && !wasActive) {
        this._setMeshVisibility(true);
      } else if (!this._active && wasActive) {
        this._setMeshVisibility(false);
      }
    });

    eb.on(Events.PLAYER_TRAIL_SAMPLE, (data) => {
      if (!this._enabled || !this._active) return;
      this._addSample(this._playerTrail, data.pos, data.vel, false);
    });

    eb.on(Events.ARM_TRAIL_SAMPLE, (data) => {
      if (!this._enabled || !this._active) return;
      let trail = this._armTrails.get(data.armId);
      if (!trail) {
        const T = Constants.TRAILS || {};
        const cap = (T.ARM_BUFFER_SECONDS || 30) * (T.SAMPLE_RATE_HZ || 10);
        trail = this._createTrail(cap, true);
        this._armTrails.set(data.armId, trail);
      }
      this._addSample(trail, data.pos, data.vel, true);
    });

    eb.on(Events.ARM_STATE_CHANGE, (data) => {
      if (!this._enabled) return;
      const trail = this._armTrails.get(data.armId);
      if (!trail) return;

      const result = processArmStateChange(data.to, trail.trimOffset, trail.count);
      trail.isReeling = result.isReeling;
      trail.trimOffset = result.trimOffset;
      if (result.cleared) {
        trail.count = 0;
        trail.head = 0;
      }
      trail.dirty = true;
    });

    eb.on(Events.ARM_TRAIL_CLEAR, (data) => {
      if (!this._enabled) return;
      const trail = this._armTrails.get(data.armId);
      if (!trail) return;
      trail.count = 0;
      trail.head = 0;
      trail.trimOffset = 0;
      trail.isReeling = false;
      trail.dirty = true;
    });

    // Clear all trails on game reset
    eb.on(Events.GAME_RESET, () => {
      if (!this._enabled) return;
      this._clearAll();
    });
  }

  // --------------------------------------------------------------------------
  // SAMPLE ADDITION
  // --------------------------------------------------------------------------

  /**
   * Add a position+velocity sample to a trail.
   * Computes prograde dot for player trails; arm trails store 0.
   * @param {object} trail - trail state object
   * @param {{ x: number, y: number, z: number }} pos - position in scene units
   * @param {{ x: number, y: number, z: number }} vel - velocity in scene units/s
   * @param {boolean} isArm - true for arm trails (skip prograde dot)
   * @private
   */
  _addSample(trail, pos, vel, isArm) {
    const px = pos.x, py = pos.y, pz = pos.z;

    // Minimum distance gate: skip if too close to previous sample
    if (trail.count > 0) {
      const prevIdx = (trail.head - 1 + trail.capacity) % trail.capacity;
      const prev = trail.samples[prevIdx];
      if (prev) {
        const dx = px - prev.x, dy = py - prev.y, dz = pz - prev.z;
        if (dx * dx + dy * dy + dz * dz < this._minSampleDistSq) return;
      }
    }

    let progradeDot = 0;

    if (!isArm && vel) {
      const vx = vel.x, vy = vel.y, vz = vel.z;

      // Radial direction (from Earth centre = origin)
      const rLen = Math.sqrt(px * px + py * py + pz * pz) || 1;
      const rx = px / rLen, ry = py / rLen, rz = pz / rLen;

      // Angular momentum h = pos × vel
      const hx = py * vz - pz * vy;
      const hy = pz * vx - px * vz;
      const hz = px * vy - py * vx;

      // Prograde = h × r (orbit tangent in the orbital plane)
      const tx = hy * rz - hz * ry;
      const ty = hz * rx - hx * rz;
      const tz = hx * ry - hy * rx;
      const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;

      // Velocity unit
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;

      // Prograde dot = dot(vel_unit, orbit_tangent_unit)
      progradeDot = (vx * tx + vy * ty + vz * tz) / (vLen * tLen);
    }

    // Store sample in ring buffer
    trail.samples[trail.head] = { x: px, y: py, z: pz, progradeDot };
    const adv = advanceRingBuffer(trail.head, trail.count, trail.capacity);
    trail.head = adv.head;
    trail.count = adv.count;
    trail.dirty = true;
  }

  // --------------------------------------------------------------------------
  // GEOMETRY REBUILD
  // --------------------------------------------------------------------------

  /**
   * Rebuild a trail's vertex buffers from its ring buffer.
   * Simple line strip: 1 vertex per sample, per-vertex RGBA colour.
   * @param {object} trail
   * @private
   */
  _rebuildGeometry(trail) {
    const { samples, head, count, capacity, positions, colors, geometry, isArm, trimOffset } = trail;

    const visibleStart = Math.floor(Math.min(trimOffset, count));
    const visibleCount = count - visibleStart;

    if (visibleCount < 2) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const T = Constants.TRAILS || {};
    const threshold = T.PROGRADE_DOT_THRESHOLD || 0.7;
    const fadeAlphaMin = T.FADE_ALPHA_MIN || 0.05;

    // Pre-compute colour constants
    const cProg = this._hexToRGB(T.COLOR_PROGRADE || 0x22ff66);
    const cRetro = this._hexToRGB(T.COLOR_RETROGRADE || 0xff3344);
    const cNorm = this._hexToRGB(T.COLOR_NORMAL || 0xffaa22);
    const cArm = this._hexToRGB(T.COLOR_ARM || 0xe6e6ff);

    // Oldest absolute index in the ring buffer
    const oldest = count < capacity ? 0 : head;

    for (let i = 0; i < visibleCount; i++) {
      const sampleIdx = (oldest + visibleStart + i) % capacity;
      const sample = samples[sampleIdx];
      if (!sample) continue;

      // Write vertex position (1 vertex per sample)
      const pi = i * 3;
      positions[pi] = sample.x;
      positions[pi + 1] = sample.y;
      positions[pi + 2] = sample.z;

      // Vertex colour + alpha fade
      const alpha = computeFadeAlpha(i, visibleCount, fadeAlphaMin);
      let cr, cg, cb;
      if (isArm) {
        cr = cArm.r; cg = cArm.g; cb = cArm.b;
      } else {
        const cls = classifyColorByProgradeDot(sample.progradeDot, threshold);
        if (cls === 'prograde')    { cr = cProg.r; cg = cProg.g; cb = cProg.b; }
        else if (cls === 'retrograde') { cr = cRetro.r; cg = cRetro.g; cb = cRetro.b; }
        else                       { cr = cNorm.r; cg = cNorm.g; cb = cNorm.b; }
      }

      const ci = i * 4;
      colors[ci] = cr;
      colors[ci + 1] = cg;
      colors[ci + 2] = cb;
      colors[ci + 3] = alpha;
    }

    // Line strip: visibleCount vertices = visibleCount points connected
    geometry.setDrawRange(0, visibleCount);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aColor.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  /**
   * Convert a hex colour to normalised RGB.
   * @param {number} hex
   * @returns {{ r: number, g: number, b: number }}
   * @private
   */
  _hexToRGB(hex) {
    return {
      r: ((hex >> 16) & 0xFF) / 255,
      g: ((hex >> 8) & 0xFF) / 255,
      b: (hex & 0xFF) / 255,
    };
  }

  // --------------------------------------------------------------------------
  // PER-FRAME UPDATE
  // --------------------------------------------------------------------------

  /**
   * Per-frame update: advance reeling trims and rebuild dirty geometry.
   * @param {number} dt - real-time delta (seconds)
   */
  update(dt) {
    if (!this._enabled) return;

    const T = Constants.TRAILS || {};

    // Handle arm reeling (trim from oldest end)
    for (const [, trail] of this._armTrails) {
      if (trail.isReeling && trail.count > 0) {
        // Trim at 2× the sample rate so the trail vanishes in ~half the buffer time
        const trimRate = (T.SAMPLE_RATE_HZ || 10) * 2;
        trail.trimOffset = updateReelTrim(trail.trimOffset, trail.count, dt, trimRate);
        trail.dirty = true;
      }
    }

    // Rebuild dirty geometries
    if (this._playerTrail && this._playerTrail.dirty) {
      this._rebuildGeometry(this._playerTrail);
      this._playerTrail.dirty = false;
    }

    for (const [, trail] of this._armTrails) {
      if (trail.dirty) {
        this._rebuildGeometry(trail);
        trail.dirty = false;
      }
    }
  }

  // --------------------------------------------------------------------------
  // CLEAR / DISPOSE
  // --------------------------------------------------------------------------

  /** Show or hide all trail meshes. */
  _setMeshVisibility(visible) {
    if (this._playerTrail) this._playerTrail.mesh.visible = visible;
    for (const [, trail] of this._armTrails) {
      trail.mesh.visible = visible;
    }
  }

  /** Clear all trails (player + arms). */
  _clearAll() {
    if (this._playerTrail) {
      this._playerTrail.count = 0;
      this._playerTrail.head = 0;
      this._playerTrail.dirty = true;
    }
    for (const [, trail] of this._armTrails) {
      trail.count = 0;
      trail.head = 0;
      trail.trimOffset = 0;
      trail.isReeling = false;
      trail.dirty = true;
    }
  }

  /** Dispose of all GPU resources. */
  dispose() {
    if (!this._enabled) return;

    const disposeMesh = (trail) => {
      if (trail.mesh) {
        this._scene.remove(trail.mesh);
        trail.geometry.dispose();
        trail.mesh.material.dispose();
      }
    };

    if (this._playerTrail) disposeMesh(this._playerTrail);
    for (const [, trail] of this._armTrails) {
      disposeMesh(trail);
    }
    this._armTrails.clear();
  }

  // --------------------------------------------------------------------------
  // DEBUG / STATS
  // --------------------------------------------------------------------------

  /** Return current vertex counts for debug overlay. */
  getVertexCount() {
    let total = 0;
    if (this._playerTrail) total += this._playerTrail.count;
    for (const [, trail] of this._armTrails) {
      total += Math.max(0, trail.count - Math.floor(trail.trimOffset));
    }
    return total;
  }
}

// ============================================================================
// CJS EXPORT GUARD — Node test compatibility
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyColorByProgradeDot,
    computeFadeAlpha,
    advanceRingBuffer,
    sampleRateGate,
    processArmStateChange,
    updateReelTrim,
    TrailSystem,
  };
}
