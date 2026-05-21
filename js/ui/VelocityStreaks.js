/**
 * VelocityStreaks.js — Full-screen Canvas2D velocity streak overlay
 * I-War heritage: radial streaks from screen center colored by thrust direction.
 * Blue/cyan for prograde, red/orange for retrograde, white for lateral.
 * Provides visceral screen-space feedback for acceleration.
 * @module ui/VelocityStreaks
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Maximum simultaneous streak particles */
const MAX_STREAKS = 60;

/** Streak color palettes per direction */
const COLORS = {
  prograde:       { inner: '#4488ff', outer: '#44ffff' },  // blue → cyan
  retrograde:     { inner: '#ff4444', outer: '#ff8844' },  // red → orange
  lateral:        { inner: '#aacccc', outer: '#aacccc' },  // white/gray
  'lateral-left': { inner: '#aacccc', outer: '#aacccc' },  // white/gray
  'lateral-right':{ inner: '#aacccc', outer: '#aacccc' },  // white/gray
};

/** Angle bias per direction — parallax: scenery streams OPPOSITE to ship motion
 * (radians — 0=right, π/2=down, π=left, -π/2=up) */
const ANGLE_BIAS = {
  prograde:       null,           // uniform radial from center
  retrograde:     null,           // uniform radial from center
  lateral:        null,           // uniform — no directional info
  'lateral-left': 0,             // ship moves left → scenery streams right
  'lateral-right': Math.PI,      // ship moves right → scenery streams left
};
const ANGLE_SPREAD = Math.PI * 0.6; // ±54° spread around bias direction

/** Streak visual parameters */
const STREAK_MIN_LENGTH = 15;   // px at minimum thrust
const STREAK_MAX_LENGTH = 90;   // px at full thrust
const STREAK_MIN_ALPHA = 0.20;
const STREAK_MAX_ALPHA = 0.50;
const STREAK_LINE_WIDTH = 2.0;
const STREAK_LIFETIME = 0.7;    // seconds per streak particle
const SPAWN_RADIUS_MIN = 0.08;  // fraction of screen diagonal (near center)
const SPAWN_RADIUS_MAX = 0.42;  // fraction of screen diagonal (mid-screen)

// ============================================================================
// VELOCITY STREAKS OVERLAY
// ============================================================================

export class VelocityStreaks {
  constructor() {
    /** @type {HTMLCanvasElement} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = null;

    this._width = 0;
    this._height = 0;
    this._halfW = 0;
    this._halfH = 0;
    this._diagonal = 0;
    this.dpr = 1;

    // Current thrust state (updated via event)
    this._thrustMagnitude = 0;
    this._thrustDirection = 'prograde'; // 'prograde' | 'retrograde' | 'lateral'
    this._thrustType = 'ion';

    // Smoothed magnitude for fade-out
    this._smoothMagnitude = 0;

    // Particle pool
    this._streaks = [];
    for (let i = 0; i < MAX_STREAKS; i++) {
      this._streaks.push({
        alive: false,
        x: 0,           // spawn position (CSS px from center)
        y: 0,
        angle: 0,       // radial angle from center
        progress: 0,    // 0 → 1 lifetime progress
        speed: 1,       // lifetime speed multiplier
        length: 30,     // streak length in px
        colorInner: '#4488ff',
        colorOuter: '#44ffff',
        alpha: 0.2,
        inward: false,  // retrograde: streaks converge toward center
      });
    }

    this._spawnAccumulator = 0;
    this._prevThrottleLevel = 0;  // Track previous throttle for direction detection

    this._createCanvas();
    this._onResize();
    window.addEventListener('resize', () => this._onResize());

    // Listen for thrust visual events (from WASD / Shift+WASD / autopilot)
    eventBus.on(Events.THRUST_VISUAL, (data) => {
      this._thrustMagnitude = Math.max(this._thrustMagnitude, data.magnitude || 0);
      this._thrustDirection = data.direction || 'prograde';
      this._thrustType = data.type || 'ion';
    });

    // Listen for throttle changes (+/- keys) — brief visual pulse on throttle adjustment
    eventBus.on(Events.THROTTLE_CHANGE, (data) => {
      const level = data.level || 0;
      if (level > 0 || this._prevThrottleLevel > 0) {
        // Detect direction: throttle up = prograde (accelerating), down = retrograde (braking)
        const dir = level >= this._prevThrottleLevel ? 'prograde' : 'retrograde';
        this._thrustMagnitude = Math.max(this._thrustMagnitude, Math.max(level, 0.3));
        this._thrustDirection = dir;
        this._thrustType = 'ion';
      }
      this._prevThrottleLevel = level;
    });

    // Auto-show/hide based on game state (avoids modifying GameFlowManager)
    eventBus.on(Events.STATE_CHANGE, ({ to }) => {
      const gameplay = gameState.isGameplay ? gameState.isGameplay() :
        ['ORBITAL_VIEW', 'APPROACH', 'INTERACTION'].includes(to);
      this.setVisible(gameplay);
      if (!gameplay) {
        // Clear all streaks when leaving gameplay
        this._smoothMagnitude = 0;
        this._thrustMagnitude = 0;
        for (let i = 0; i < MAX_STREAKS; i++) this._streaks[i].alive = false;
        this.ctx.clearRect(0, 0, this._width, this._height);
      }
    });
  }

  // ==========================================================================
  // CANVAS SETUP
  // ==========================================================================

  /** @private Create the 2D canvas overlay */
  _createCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'velocity-streaks-canvas';
    this.canvas.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 5;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  /** @private Handle window resize */
  _onResize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.dpr = dpr;
    this._width = window.innerWidth;
    this._height = window.innerHeight;
    this._halfW = this._width / 2;
    this._halfH = this._height / 2;
    this._diagonal = Math.sqrt(this._width * this._width + this._height * this._height);
    this.canvas.width = this._width * dpr;
    this.canvas.height = this._height * dpr;
    this.canvas.style.width = this._width + 'px';
    this.canvas.style.height = this._height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Show or hide the overlay.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  // ==========================================================================
  // UPDATE & RENDER
  // ==========================================================================

  /**
   * Update and render streaks. Called every frame from game loop.
   * @param {number} dt — delta time in seconds
   */
  update(dt) {
    const ctx = this.ctx;

    // Smooth magnitude toward target (fast attack, slow decay)
    const attackRate = 12.0;
    const decayRate = 3.0;
    if (this._thrustMagnitude > this._smoothMagnitude) {
      this._smoothMagnitude += (this._thrustMagnitude - this._smoothMagnitude) * Math.min(1, attackRate * dt);
    } else {
      this._smoothMagnitude += (this._thrustMagnitude - this._smoothMagnitude) * Math.min(1, decayRate * dt);
    }

    // Reset thrust magnitude each frame (event-driven: no event = no thrust)
    this._thrustMagnitude = 0;

    const mag = this._smoothMagnitude;

    // Clear canvas
    ctx.clearRect(0, 0, this._width, this._height);

    // Skip if effectively zero thrust
    if (mag < 0.01) {
      // Update any remaining alive streaks to let them fade out
      this._updateAliveStreaks(dt, ctx);
      return;
    }

    // --- Spawn new streaks ---
    const streakCount = Math.floor(mag * 30);
    this._spawnAccumulator += streakCount * dt * 60; // normalize to 60fps spawn rate

    while (this._spawnAccumulator >= 1) {
      this._spawnAccumulator -= 1;
      this._spawnStreak(mag);
    }

    // --- Update and draw alive streaks ---
    this._updateAliveStreaks(dt, ctx);
  }

  /**
   * Spawn a single streak particle.
   * @param {number} mag — current smoothed thrust magnitude (0-1)
   * @private
   */
  _spawnStreak(mag) {
    // Find a dead particle slot
    let streak = null;
    for (let i = 0; i < MAX_STREAKS; i++) {
      if (!this._streaks[i].alive) {
        streak = this._streaks[i];
        break;
      }
    }
    if (!streak) return; // pool full

    // Angle: uniform for prograde/retrograde, biased for lateral-left/right
    const bias = ANGLE_BIAS[this._thrustDirection];
    let angle;
    if (bias !== null && bias !== undefined) {
      // Biased angle: concentrate streaks around the thrust direction
      angle = bias + (Math.random() - 0.5) * ANGLE_SPREAD * 2;
    } else {
      // Uniform radial distribution for prograde/retrograde
      angle = Math.random() * Math.PI * 2;
    }

    // Retrograde: spawn at outer edge and converge inward
    const isRetrograde = this._thrustDirection === 'retrograde';
    let spawnFrac;
    if (isRetrograde) {
      // Spawn at outer ring (edges toward center)
      spawnFrac = 0.30 + Math.random() * 0.25; // outer region
    } else {
      spawnFrac = SPAWN_RADIUS_MIN + Math.random() * (SPAWN_RADIUS_MAX - SPAWN_RADIUS_MIN);
    }
    const spawnDist = spawnFrac * this._diagonal * 0.5;

    // Spawn position relative to center
    streak.x = Math.cos(angle) * spawnDist;
    streak.y = Math.sin(angle) * spawnDist;
    streak.angle = angle;
    streak.progress = 0;
    streak.speed = 0.8 + Math.random() * 0.4 + mag * 0.5; // faster at higher thrust
    streak.inward = isRetrograde;

    // Streak length proportional to thrust
    streak.length = STREAK_MIN_LENGTH + mag * (STREAK_MAX_LENGTH - STREAK_MIN_LENGTH);
    streak.length *= (0.7 + Math.random() * 0.6); // slight variation

    // Color based on direction
    const palette = COLORS[this._thrustDirection] || COLORS.lateral;
    streak.colorInner = palette.inner;
    streak.colorOuter = palette.outer;

    // Alpha based on magnitude
    streak.alpha = STREAK_MIN_ALPHA + mag * (STREAK_MAX_ALPHA - STREAK_MIN_ALPHA);

    streak.alive = true;
  }

  /**
   * Update and draw all alive streak particles.
   * @param {number} dt — delta time
   * @param {CanvasRenderingContext2D} ctx
   * @private
   */
  _updateAliveStreaks(dt, ctx) {
    const cx = this._halfW;
    const cy = this._halfH;

    for (let i = 0; i < MAX_STREAKS; i++) {
      const s = this._streaks[i];
      if (!s.alive) continue;

      // Advance lifetime
      s.progress += (dt / STREAK_LIFETIME) * s.speed;
      if (s.progress >= 1) {
        s.alive = false;
        continue;
      }

      // Fade: ramp up quickly then fade out
      const lifeFade = s.progress < 0.2
        ? s.progress / 0.2                        // fade in
        : 1.0 - ((s.progress - 0.2) / 0.8);     // fade out
      const alpha = s.alpha * Math.max(0, lifeFade);
      if (alpha < 0.005) continue;

      // Move along radial: outward for prograde/lateral, inward for retrograde
      const driftDir = s.inward ? -1 : 1;
      const drift = s.progress * s.length * 1.5 * driftDir;
      const sx = cx + s.x + Math.cos(s.angle) * drift;
      const sy = cy + s.y + Math.sin(s.angle) * drift;

      // Streak tail: extends outward (prograde) or inward toward center (retrograde)
      const len = s.length * (0.3 + s.progress * 0.7); // grows as it moves
      const tailAngle = s.inward ? s.angle + Math.PI : s.angle; // flip for inward
      const ex = sx + Math.cos(tailAngle) * len;
      const ey = sy + Math.sin(tailAngle) * len;

      // Draw the streak line with gradient
      const grad = ctx.createLinearGradient(sx, sy, ex, ey);
      grad.addColorStop(0, this._colorWithAlpha(s.colorInner, alpha * 0.3));
      grad.addColorStop(0.4, this._colorWithAlpha(s.colorInner, alpha));
      grad.addColorStop(1, this._colorWithAlpha(s.colorOuter, alpha * 0.6));

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = grad;
      ctx.lineWidth = STREAK_LINE_WIDTH;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  /**
   * Convert hex color + alpha to rgba string.
   * @param {string} hex — e.g. '#4488ff'
   * @param {number} alpha — 0-1
   * @returns {string} rgba color string
   * @private
   */
  _colorWithAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }

  /**
   * Clean up DOM element.
   */
  dispose() {
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
