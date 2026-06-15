/**
 * NetInventoryPanel.js — Compact lasso + net inventory chips
 *
 * Delegation 4 (2026-05-31). A small flat-row widget mounted under the
 * right-column [`StatusPanel`](js/ui/hud/StatusPanel.js:1).  Renders two chips:
 *
 *   [🤠 12/20]   [🪢 3+2+1=6/12]
 *
 *   • 🤠 chip — lasso shots remaining / max, driven by
 *     [`Events.LASSO_AMMO_CHANGED`](js/core/Events.js:288).
 *   • 🪢 chip — per-arm net total summed, driven by
 *     [`Events.NET_INVENTORY_CHANGED`](js/core/Events.js:541).  Hover
 *     tooltip shows the per-arm breakdown (browser `title` attribute).
 *
 * Threshold-based colour transitions emit
 * [`Events.INVENTORY_LOW`](js/core/Events.js:1) once per crossing into the
 * low/critical band, gated by a configurable cooldown so the HOUSTON comms
 * hint does not spam the player.
 *
 * Node-safe: gracefully no-ops when DOM is unavailable.  All thresholds and
 * the cooldown window come from [`Constants.INVENTORY`](js/core/Constants.js:1).
 *
 * @module ui/hud/NetInventoryPanel
 */

import { eventBus } from '../../core/EventBus.js';
import { Events }   from '../../core/Events.js';
import { Constants } from '../../core/Constants.js';

// ───────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────

const COLOR_OK       = '#88ffcc';
const COLOR_LOW      = '#ffcc44';
const COLOR_CRIT     = '#ff5555';
const BG_OK          = 'rgba(0, 30, 22, 0.85)';
const BG_LOW         = 'rgba(60, 50, 0, 0.85)';
const BG_CRIT        = 'rgba(60, 0, 0, 0.85)';
const BORDER_OK      = 'rgba(0, 255, 136, 0.35)';
const BORDER_LOW     = 'rgba(255, 204, 68, 0.55)';
const BORDER_CRIT    = 'rgba(255, 85, 85, 0.65)';

function _tuning() {
  return (Constants && Constants.INVENTORY) || {
    LASSO_LOW_THRESHOLD: 5,
    LASSO_CRITICAL_THRESHOLD: 0,
    NETS_LOW_THRESHOLD: 3,
    NETS_CRITICAL_THRESHOLD: 0,
    LOW_HINT_COOLDOWN_MS: 60000,
  };
}

function _hasDOM() {
  return typeof document !== 'undefined';
}

// ───────────────────────────────────────────────────────────────────────────
// PURE LOGIC (exported for tests)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Classify a remaining/threshold pair into 'ok' | 'low' | 'critical'.
 * @param {number} remaining
 * @param {number} lowThreshold
 * @param {number} critThreshold
 * @returns {'ok'|'low'|'critical'}
 */
export function classifySeverity(remaining, lowThreshold, critThreshold) {
  if (remaining <= critThreshold) return 'critical';
  if (remaining <= lowThreshold)  return 'low';
  return 'ok';
}

// ───────────────────────────────────────────────────────────────────────────
// PANEL
// ───────────────────────────────────────────────────────────────────────────

export class NetInventoryPanel {
  /**
   * @param {HTMLElement} [container] — DOM mount point (defaults to document.body)
   * @param {object} [opts]
   * @param {object} [opts.eventBus] — override (tests pass a mock)
   * @param {object} [opts.armManager] — for initial-state polling of net counts
   * @param {object} [opts.lassoSystem] — for initial-state polling of lasso ammo
   * @param {Function} [opts.now] — clock injection for tests; defaults to Date.now
   */
  constructor(container, opts = {}) {
    this._eventBus   = opts.eventBus   || eventBus;
    this._armManager = opts.armManager || null;
    this._lasso      = opts.lassoSystem || null;
    this._now        = opts.now || (() => Date.now());

    this._container  = container || (_hasDOM() ? document.body : null);

    /** @type {{ remaining:number, max:number, severity:string }} */
    this._lasso_state = { remaining: 0, max: 0, severity: 'ok' };
    /** @type {{ perArm:number[], total:number, max:number, severity:string }} */
    this._net_state   = { perArm: [], total: 0, max: 0, severity: 'ok' };

    /** @type {number} timestamp of last INVENTORY_LOW emit (for cooldown) */
    this._lastLowEmitAt = 0;

    /** @type {boolean} */
    this._disposed = false;

    /** @type {Array<Function>} unsubscribe handles */
    this._unsubs = [];

    /** @type {HTMLElement|null} root chip row */
    this._root = null;
    /** @type {HTMLElement|null} */
    this._lassoChip = null;
    /** @type {HTMLElement|null} */
    this._netChip   = null;

    this._build();
    this._wireListeners();
    this._pollInitial();
    this._render();
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /** Test helper — returns the current state snapshot. */
  getState() {
    return {
      lasso: { ...this._lasso_state },
      nets:  { perArm: this._net_state.perArm.slice(), total: this._net_state.total,
               max: this._net_state.max, severity: this._net_state.severity },
      lastLowEmitAt: this._lastLowEmitAt,
    };
  }

  /** Test helper — returns root DOM element. */
  getElement() { return this._root; }

  /** Tear down — unsubscribes + removes DOM. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const u of this._unsubs) {
      if (typeof u === 'function') u();
    }
    this._unsubs.length = 0;
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = this._lassoChip = this._netChip = null;
  }

  /**
   * Force a re-poll of arm + lasso state.  Public so HUD can call when the
   * dependencies become available after construction (lassoSystem and
   * armManager are wired in a multi-stage init).
   */
  refresh() {
    this._pollInitial();
    this._render();
  }

  setArmManager(armManager) { this._armManager = armManager; this.refresh(); }
  setLassoSystem(lassoSystem) { this._lasso = lassoSystem; this.refresh(); }

  /**
   * Show or hide the chip row.  Browser-playtest Bug 3 (Delegation 4):
   * keeps the widget hidden during the onboarding pipeline so the
   * "50/50, 8/8" emoji noise no longer distracts first-run players.
   * @param {boolean} visible
   */
  setVisible(visible) {
    if (!this._root) return;
    this._root.style.display = visible ? 'flex' : 'none';
  }

  // ─── INTERNAL — DOM ───────────────────────────────────────────────────

  _build() {
    if (!_hasDOM() || !this._container) return;
    const row = document.createElement('div');
    row.id = 'hud-net-inventory';
    row.className = 'sc-net-inv';
    row.style.cssText = [
      'display:flex',
      'flex-direction:row',
      'align-items:center',
      'gap:6px',
      'margin-top:6px',
      'padding:0',
      'pointer-events:auto',          // chip tooltip works on hover
      "font-family:'Courier New', monospace",
      'font-size:12px',
      'white-space:nowrap',
      // Delegation 4 (2026-05-31) — Browser-playtest Bug 3:
      // hide until onboarding completes (or on a veteran save).  Mounts
      // hidden; HUD un-hides on ONBOARDING_COMPLETE (and constructor
      // un-hides immediately when there is no pipeline to wait for).
      'display:none',
    ].join(';') + ';';
    this._root = row;

    // Delegation 4 — Browser-playtest Bug 3: plain text glyphs (no emoji)
    // and short labels.  Per-arm net breakdown lives in the chip title
    // tooltip only — inline label is total/max.
    this._lassoChip = this._buildChip('LASSO', '. /. ', '');
    this._netChip   = this._buildChip('NETS',  '. /. ', '');
    row.appendChild(this._lassoChip);
    row.appendChild(this._netChip);

    this._container.appendChild(row);
  }

  _buildChip(label, text, tooltip) {
    const chip = document.createElement('span');
    chip.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'padding:3px 8px',
      `background:${BG_OK}`,
      `border:1px solid ${BORDER_OK}`,
      'border-radius:3px',
      `color:${COLOR_OK}`,
      'letter-spacing:0.06em',
      'min-height:22px',
    ].join(';') + ';';
    const g = document.createElement('span');
    g.textContent = label;
    g.style.cssText = 'font-size:10px;opacity:0.75;font-weight:bold;';
    const t = document.createElement('span');
    t.textContent = text;
    chip.appendChild(g);
    chip.appendChild(t);
    if (tooltip) chip.title = tooltip;
    chip._textNode = t;   // expose for cheap updates
    return chip;
  }

  _styleChip(chip, severity) {
    if (!chip) return;
    let bg = BG_OK, border = BORDER_OK, color = COLOR_OK;
    if (severity === 'low')      { bg = BG_LOW;  border = BORDER_LOW;  color = COLOR_LOW; }
    if (severity === 'critical') { bg = BG_CRIT; border = BORDER_CRIT; color = COLOR_CRIT; }
    chip.style.background  = bg;
    chip.style.borderColor = border;
    chip.style.color       = color;
  }

  // ─── INTERNAL — EVENT WIRING ───────────────────────────────────────────

  _wireListeners() {
    const eb = this._eventBus;
    if (!eb) return;
    const on = (evt, h) => {
      const u = eb.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };
    on(Events.LASSO_AMMO_CHANGED,    (d) => this._onLassoAmmo(d));
    on(Events.NET_INVENTORY_CHANGED, (d) => this._onNetInventory(d));

    // Delegation 4 (2026-05-31) — Browser-playtest: NetInventoryPanel is
    // SUSPENDED (never displayed). The widget is too cryptic for the current
    // UX maturity level. It stays mounted so event wiring and state tracking
    // still work (tests pass), but setVisible is never called.
    // See ROADMAP.md for the redesign ticket.
  }

  /** Poll the initial state from injected systems (events only fire on change). */
  _pollInitial() {
    // Lasso ammo — direct query.
    if (this._lasso && typeof this._lasso.getAmmo === 'function') {
      const cur = this._lasso.getAmmo() ?? 0;
      const max = (Constants && Constants.LASSO_AMMO_MAX) || cur;
      this._lasso_state.remaining = cur;
      this._lasso_state.max = max;
    }
    // Per-arm net inventory.
    if (this._armManager) {
      const arms = (this._armManager.arms || this._armManager.getArms?.() || []);
      const perArm = [];
      let total = 0, max = 0;
      for (const arm of arms) {
        if (!arm) { perArm.push(0); continue; }
        const cur = (typeof arm.getNetInventory === 'function')
          ? arm.getNetInventory()
          : (arm.netInventory ?? arm._netInventory ?? 0);
        const cap = (typeof arm.getNetInventoryMax === 'function')
          ? arm.getNetInventoryMax()
          : (arm._netInventoryMax ?? 0);
        perArm.push(cur);
        total += cur;
        max   += cap;
      }
      this._net_state.perArm = perArm;
      this._net_state.total  = total;
      this._net_state.max    = max;
    }
    this._reclassify(/*emit=*/false);
  }

  // ─── EVENT HANDLERS ────────────────────────────────────────────────────

  _onLassoAmmo(d) {
    if (!d || typeof d.remaining !== 'number') return;
    this._lasso_state.remaining = d.remaining;
    if (typeof d.max === 'number') this._lasso_state.max = d.max;
    this._reclassify(/*emit=*/true);
    this._render();
  }

  _onNetInventory(_d) {
    // Event payload is "something changed somewhere"; re-poll authoritatively.
    if (this._armManager) {
      const arms = (this._armManager.arms || this._armManager.getArms?.() || []);
      const perArm = [];
      let total = 0, max = 0;
      for (const arm of arms) {
        if (!arm) { perArm.push(0); continue; }
        const cur = (typeof arm.getNetInventory === 'function')
          ? arm.getNetInventory()
          : (arm.netInventory ?? arm._netInventory ?? 0);
        const cap = (typeof arm.getNetInventoryMax === 'function')
          ? arm.getNetInventoryMax()
          : (arm._netInventoryMax ?? 0);
        perArm.push(cur);
        total += cur;
        max   += cap;
      }
      this._net_state.perArm = perArm;
      this._net_state.total  = total;
      this._net_state.max    = max;
    }
    this._reclassify(/*emit=*/true);
    this._render();
  }

  // ─── CORE — CLASSIFY + COMMS ───────────────────────────────────────────

  _reclassify(emit) {
    const T = _tuning();
    const prevLasso = this._lasso_state.severity;
    const prevNet   = this._net_state.severity;
    const newLasso  = classifySeverity(this._lasso_state.remaining,
                                       T.LASSO_LOW_THRESHOLD,
                                       T.LASSO_CRITICAL_THRESHOLD);
    const newNet    = classifySeverity(this._net_state.total,
                                       T.NETS_LOW_THRESHOLD,
                                       T.NETS_CRITICAL_THRESHOLD);
    this._lasso_state.severity = newLasso;
    this._net_state.severity   = newNet;

    if (!emit) return;

    // Determine kind of low event to emit (transition from ok→low/critical
    // or low→critical). Only emit on rising severity — not on recovery.
    const RANK = { ok: 0, low: 1, critical: 2 };
    const lassoEsc = RANK[newLasso] > RANK[prevLasso];
    const netEsc   = RANK[newNet]   > RANK[prevNet];
    if (!lassoEsc && !netEsc) return;

    // Cooldown gate.  The first ever emit (`_lastLowEmitAt === 0`) always
    // passes — players who run out of capture tools immediately should still
    // hear the warning.  Subsequent emits are throttled by LOW_HINT_COOLDOWN_MS.
    const now = this._now();
    if (this._lastLowEmitAt > 0
        && (now - this._lastLowEmitAt) < (T.LOW_HINT_COOLDOWN_MS || 60000)) {
      return;
    }

    // Determine kind + severity for payload.
    let kind = lassoEsc && netEsc ? 'both' : (lassoEsc ? 'lasso' : 'nets');
    let critical = (newLasso === 'critical' && (kind === 'lasso' || kind === 'both'))
                || (newNet   === 'critical' && (kind === 'nets'  || kind === 'both'));
    const severity = critical ? 'critical' : 'low';

    this._lastLowEmitAt = now;
    this._eventBus?.emit?.(Events.INVENTORY_LOW, {
      kind,
      severity,
      lasso: { remaining: this._lasso_state.remaining, max: this._lasso_state.max },
      nets:  { total: this._net_state.total,           max: this._net_state.max  },
    });

    // Fire the HOUSTON comms hint.
    const bothZero = (this._lasso_state.remaining === 0 && this._net_state.total === 0);
    const text = bothZero
      ? 'Out of capture tools. Shop (B) or Forge (5) to reload.'
      : 'Low on nets, Cowboy. Visit the Shop (B) or Forge new ones (5).';
    this._eventBus?.emit?.(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      channel: 'HOUSTON',
      priority: bothZero ? 'warning' : 'info',
      text,
    });
  }

  // ─── RENDER ────────────────────────────────────────────────────────────

  _render() {
    if (!_hasDOM() || !this._root) return;
    // Lasso chip text + colour.
    if (this._lassoChip) {
      const remaining = this._lasso_state.remaining ?? 0;
      const max       = this._lasso_state.max ?? 0;
      const label = max > 0 ? `${remaining}/${max}` : `${remaining}`;
      this._lassoChip._textNode.textContent = label;
      this._lassoChip.title = `Lasso shots: ${label}.  Press B for shop or 5 to forge.`;
      this._styleChip(this._lassoChip, this._lasso_state.severity);
    }
    // Net chip text + breakdown tooltip + colour.
    // Delegation 4 (2026-05-31) — Browser-playtest Bug 3: inline label is
    // ALWAYS just `total/max` (e.g. "8/8").  The per-arm breakdown
    // ("2+2+2+2") is preserved only in the chip's hover tooltip — it was
    // adding noise to first-run players staring at "🪢 2+2+2+2=8/8".
    if (this._netChip) {
      const perArm = this._net_state.perArm;
      const total  = this._net_state.total;
      const max    = this._net_state.max;
      this._netChip._textNode.textContent = `${total}/${max}`;
      const breakdown = perArm.length
        ? perArm.map((n, i) => `Arm ${i + 1}: ${n}`).join('  ·  ')
        : 'No daughters deployed';
      this._netChip.title = `Nets: ${total}/${max}.  ${breakdown}`;
      this._styleChip(this._netChip, this._net_state.severity);
    }
  }
}

export default NetInventoryPanel;
