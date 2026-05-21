/**
 * RadialMenu.js — Target-anchored radial command menu (ST-5.1)
 * Replaces the center-screen FS2-style popup.
 * Opens on C-hold, anchors to target reticle screen position.
 * 6 options at equal angles with arm-state gating.
 * @module ui/hud/RadialMenu
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';

const COMMS = Constants.COMMS;

// ============================================================================
// RADIAL OPTION DEFINITIONS
// ============================================================================

/**
 * The 6 radial options — ported from CommsPanel._buildCommsMenu.
 * Each has: label, cmdIndex, channel (for stripe colour), gatingKey.
 */
const RADIAL_OPTIONS = [
  { label: 'Deploy Weaver', cmdIndex: 1, channel: 'CMD', gatingKey: 'deployWeaver' },
  { label: 'Deploy Spinner', cmdIndex: 2, channel: 'CMD', gatingKey: 'deploySpinner' },
  { label: 'Fish (cast all)', cmdIndex: 3, channel: 'CMD', gatingKey: 'fish' },
  { label: 'Recall All', cmdIndex: 4, channel: 'CMD', gatingKey: 'recallAll' },
  { label: 'Pilot Arm [P]', cmdIndex: 5, channel: 'CMD', gatingKey: 'pilotArm' },
  { label: 'DEORBIT [D]', cmdIndex: 6, channel: 'ALERT', gatingKey: 'deorbit' },
];

// ============================================================================
// PURE HELPERS (CJS-exportable for tests)
// ============================================================================

/**
 * Compute arm-state gating flags from arm status summary.
 * @param {object} armStatus — { weaverDocked, spinnerDocked, anyDocked, anyDeployed, anyPilotable }
 * @returns {object} — { deployWeaver, deploySpinner, fish, recallAll, pilotArm, deorbit }
 */
function computeArmGating(armStatus) {
  return {
    deployWeaver: !!armStatus.weaverDocked,
    deploySpinner: !!armStatus.spinnerDocked,
    fish: !!armStatus.anyDocked,
    recallAll: !!armStatus.anyDeployed,
    pilotArm: !!armStatus.anyPilotable,
    deorbit: true, // always available (game handles edge cases)
  };
}

/**
 * Get option angles for N options, starting at top (-π/2).
 * @param {number} n — number of options
 * @returns {number[]} — angles in radians
 */
function getOptionAngles(n) {
  const step = (2 * Math.PI) / n;
  const angles = [];
  for (let i = 0; i < n; i++) {
    angles.push(-Math.PI / 2 + i * step);
  }
  return angles;
}

/**
 * Given a mouse angle (radians), find the closest option index.
 * @param {number} angle — angle in radians
 * @param {number} n — number of options
 * @returns {number} — 0-based option index
 */
function getOptionAtAngle(angle, n) {
  const step = (2 * Math.PI) / n;
  // Normalize angle relative to first option
  let rel = angle - (-Math.PI / 2);
  // Normalize to [0, 2π)
  rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(rel / step) % n;
}

/**
 * Get channel stripe colour for a given option index.
 * @param {number} optionIndex
 * @returns {string} — hex colour
 */
function getOptionChannelColor(optionIndex) {
  const opt = RADIAL_OPTIONS[optionIndex];
  if (!opt) return COMMS.CHANNEL_COLORS.FLAVOR;
  return COMMS.CHANNEL_COLORS[opt.channel] || COMMS.CHANNEL_COLORS.FLAVOR;
}

// ============================================================================
// RADIAL MENU CLASS (DOM-based, browser only)
// ============================================================================

export class RadialMenu {
  constructor() {
    this._visible = false;
    this._anchorX = 0;
    this._anchorY = 0;
    this._highlightedIndex = -1;
    this._gating = {};
    this._el = null;
    this._optionEls = [];
    this._armManager = null;

    this._onMouseMove = this._handleMouseMove.bind(this);

    this._build();
    this._setupListeners();
  }

  /** Inject ArmManager reference for gating. */
  setArmManager(armManager) {
    this._armManager = armManager;
  }

  /** @returns {boolean} */
  isVisible() {
    return this._visible;
  }

  /**
   * Open the radial menu at the given screen position.
   * @param {number} x — screen X
   * @param {number} y — screen Y
   */
  open(x, y) {
    this._anchorX = x;
    this._anchorY = y;
    this._highlightedIndex = -1;
    this._updateGating();
    this._position();
    this._el.style.display = 'block';
    this._visible = true;
    window.addEventListener('mousemove', this._onMouseMove);
  }

  /** Close without selecting. */
  close() {
    this._el.style.display = 'none';
    this._visible = false;
    window.removeEventListener('mousemove', this._onMouseMove);
  }

  /**
   * Close and execute the highlighted option (if any and enabled).
   * @returns {number|null} cmdIndex of executed option, or null
   */
  closeAndSelect() {
    const idx = this._highlightedIndex;
    this.close();
    if (idx >= 0 && idx < RADIAL_OPTIONS.length) {
      const opt = RADIAL_OPTIONS[idx];
      if (this._gating[opt.gatingKey]) {
        return opt.cmdIndex;
      }
    }
    return null;
  }

  dispose() {
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
    window.removeEventListener('mousemove', this._onMouseMove);
  }

  // ==========================================================================
  // PRIVATE — Build
  // ==========================================================================

  _build() {
    const el = document.createElement('div');
    el.id = 'radial-command-menu';
    Object.assign(el.style, {
      position: 'fixed',
      width: `${COMMS.RADIAL_RADIUS_PX * 2 + 40}px`,
      height: `${COMMS.RADIAL_RADIUS_PX * 2 + 40}px`,
      display: 'none',
      pointerEvents: 'none',
      zIndex: '200',
    });

    const angles = getOptionAngles(RADIAL_OPTIONS.length);
    const r = COMMS.RADIAL_RADIUS_PX;
    const cx = r + 20;
    const cy = r + 20;

    // Inject stylesheet
    if (!document.getElementById('radial-menu-style')) {
      const style = document.createElement('style');
      style.id = 'radial-menu-style';
      style.textContent = `
        .radial-opt {
          position: absolute;
          width: 100px;
          padding: 4px 6px;
          font-family: 'Courier New', monospace;
          font-size: 11px;
          text-align: center;
          color: #00ff88;
          background: rgba(0,0,0,0.8);
          border: 1px solid rgba(0,255,136,0.3);
          border-radius: 4px;
          pointer-events: auto;
          cursor: pointer;
          transition: background 0.1s, border-color 0.1s;
          white-space: nowrap;
        }
        .radial-opt.highlighted {
          background: rgba(0,255,136,0.15);
          border-color: rgba(0,255,136,0.7);
        }
        .radial-opt.disabled {
          color: #555;
          opacity: 0.4;
          cursor: default;
        }
      `;
      document.head.appendChild(style);
    }

    this._optionEls = [];
    for (let i = 0; i < RADIAL_OPTIONS.length; i++) {
      const opt = RADIAL_OPTIONS[i];
      const angle = angles[i];
      const ox = cx + r * Math.cos(angle) - 50; // center the 100px wide element
      const oy = cy + r * Math.sin(angle) - 12;

      const optEl = document.createElement('div');
      optEl.className = 'radial-opt';
      optEl.dataset.index = i;
      Object.assign(optEl.style, {
        left: `${ox}px`,
        top: `${oy}px`,
        borderLeft: `${COMMS.STRIPE_WIDTH_PX}px solid ${getOptionChannelColor(i)}`,
      });
      optEl.textContent = opt.label;
      el.appendChild(optEl);
      this._optionEls.push(optEl);
    }

    // Center dot
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'absolute',
      left: `${cx - 3}px`,
      top: `${cy - 3}px`,
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#00ff88',
      opacity: '0.5',
    });
    el.appendChild(dot);

    document.body.appendChild(el);
    this._el = el;
  }

  _setupListeners() {
    // EventBus-driven open/close
    eventBus.on(Events.COMMS_RADIAL_OPEN, (data) => {
      const x = data?.x ?? window.innerWidth / 2;
      const y = data?.y ?? window.innerHeight / 2;
      this.open(x, y);
    });

    eventBus.on(Events.COMMS_RADIAL_CLOSE, (data) => {
      if (data?.select && this._visible) {
        const cmdIndex = this.closeAndSelect();
        if (cmdIndex != null) {
          this._executeCommand(cmdIndex);
        }
      } else {
        this.close();
      }
    });
  }

  _position() {
    if (!this._el) return;
    const r = COMMS.RADIAL_RADIUS_PX;
    const size = r * 2 + 40;
    this._el.style.left = `${this._anchorX - size / 2}px`;
    this._el.style.top = `${this._anchorY - size / 2}px`;
  }

  _updateGating() {
    const am = this._armManager;
    if (!am) {
      this._gating = computeArmGating({
        weaverDocked: false, spinnerDocked: false,
        anyDocked: false, anyDeployed: false, anyPilotable: false,
      });
    } else {
      const hasWeaverDocked = am.getArmsByType ? am.getArmsByType('weaver').some(
        a => a.state === Constants.ARM_STATES.DOCKED
      ) : false;
      const hasSpinnerDocked = am.getArmsByType ? am.getArmsByType('spinner').some(
        a => a.state === Constants.ARM_STATES.DOCKED
      ) : false;
      const hasAnyDocked = am.getDockedCount ? am.getDockedCount() > 0 : false;
      const hasAnyDeployed = am.getDeployedCount ? am.getDeployedCount() > 0 : false;
      const hasPilotable = am.arms ? am.arms.some(
        a => a.state === Constants.ARM_STATES.TRANSIT ||
             a.state === Constants.ARM_STATES.APPROACH ||
             a.state === Constants.ARM_STATES.FISHING
      ) : false;

      this._gating = computeArmGating({
        weaverDocked: hasWeaverDocked,
        spinnerDocked: hasSpinnerDocked,
        anyDocked: hasAnyDocked,
        anyDeployed: hasAnyDeployed,
        anyPilotable: hasPilotable,
      });
    }

    // Apply gating visuals
    for (let i = 0; i < RADIAL_OPTIONS.length; i++) {
      const opt = RADIAL_OPTIONS[i];
      const el = this._optionEls[i];
      if (!el) continue;
      if (this._gating[opt.gatingKey]) {
        el.classList.remove('disabled');
      } else {
        el.classList.add('disabled');
      }
    }
  }

  _handleMouseMove(e) {
    if (!this._visible) return;
    const dx = e.clientX - this._anchorX;
    const dy = e.clientY - this._anchorY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 20) {
      // Too close to center — no highlight
      this._setHighlight(-1);
      return;
    }

    const angle = Math.atan2(dy, dx);
    const idx = getOptionAtAngle(angle, RADIAL_OPTIONS.length);
    this._setHighlight(idx);
  }

  _setHighlight(idx) {
    if (idx === this._highlightedIndex) return;
    this._highlightedIndex = idx;
    for (let i = 0; i < this._optionEls.length; i++) {
      this._optionEls[i].classList.toggle('highlighted', i === idx);
    }
  }

  /**
   * Execute a radial command by index (1-6).
   * Mirrors CommsPanel.executeCommsCommand — emits the same arm events.
   * @private
   * @param {number} cmdIndex — 1-based command index
   */
  _executeCommand(cmdIndex) {
    switch (cmdIndex) {
      case 1:
        eventBus.emit(Events.ARM_DEPLOY, { preferType: 'weaver' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Deploy Weaver — executing',
          priority: 'info', source: 'COMMS', channel: 'CMD',
        });
        break;
      case 2:
        eventBus.emit(Events.ARM_DEPLOY, { preferType: 'spinner' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Deploy Spinner — executing',
          priority: 'info', source: 'COMMS', channel: 'CMD',
        });
        break;
      case 3:
        eventBus.emit(Events.ARM_FISH);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Fish mode — casting all',
          priority: 'info', source: 'COMMS', channel: 'CMD',
        });
        break;
      case 4:
        eventBus.emit(Events.ARM_RECALL_ALL);
        break;
      case 5:
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Use P key to toggle ARM PILOT mode',
          priority: 'info', source: 'COMMS', channel: 'CMD',
        });
        break;
      case 6:
        eventBus.emit(Events.ARM_DEORBIT_CMD);
        break;
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  computeArmGating,
  getOptionAngles,
  getOptionAtAngle,
  getOptionChannelColor,
  RADIAL_OPTIONS,
};

// ST-5.1: CJS guard — expose pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeArmGating,
    getOptionAngles,
    getOptionAtAngle,
    getOptionChannelColor,
    RADIAL_OPTIONS,
  };
}
