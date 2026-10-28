/**
 * NetInventoryPanel.js — Compact lasso + net inventory chips, mounted under the right-column StatusPanel.
 *
 *   • LASSO chip — the mother's nets remaining / max (ONE count, DECISIONS §33), from
 *     `Events.NET_INVENTORY_CHANGED` `{ source:'mother', motherNets }`.
 *   • NETS chip — per-arm net total summed, from the same event; hover tooltip shows the per-arm breakdown.
 *
 * Threshold crossings into the low/critical band emit `Events.INVENTORY_LOW` once, gated by a cooldown.
 *
 * Node-safe: no-ops when DOM is unavailable. Thresholds and cooldown come from `Constants.INVENTORY`.
 *
 * @module ui/hud/NetInventoryPanel
 */

import { eventBus } from '../../core/EventBus.js';
import { Events }   from '../../core/Events.js';
import { Constants } from '../../core/Constants.js';
import { restockTail } from '../../systems/resupplyWords.js';

const COLOR_OK       = 'var(--hud-normal, #88ffcc)';
const COLOR_LOW      = 'var(--hud-caution, #ffcc44)';
const COLOR_CRIT     = 'var(--hud-warning, #ff5555)';
const BG_OK          = 'rgb(var(--hud-ink-rgb, 0 30 22) / 0.85)';
const BG_LOW         = 'rgb(var(--hud-ink-rgb, 60 50 0) / 0.85)';
const BG_CRIT        = 'rgb(var(--hud-ink-rgb, 60 0 0) / 0.85)';
const BORDER_OK      = 'rgb(var(--hud-normal-rgb, 0 255 136) / 0.35)';
const BORDER_LOW     = 'rgb(var(--hud-caution-rgb, 255 204 68) / 0.55)';
const BORDER_CRIT    = 'rgb(var(--hud-warning-rgb, 255 85 85) / 0.65)';

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

/** Classify a remaining/threshold pair into 'ok' | 'low' | 'critical'. */
export function classifySeverity(remaining, lowThreshold, critThreshold) {
  if (remaining <= critThreshold) return 'critical';
  if (remaining <= lowThreshold)  return 'low';
  return 'ok';
}

export class NetInventoryPanel {
  /**
   * @param {HTMLElement} [container] — DOM mount point (defaults to document.body)
   * @param {object} [opts] — eventBus, armManager, lassoSystem, now (clock injection for tests)
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

  /** Force a re-poll of arm + lasso state; HUD calls it once the deps (wired in a multi-stage init) exist. */
  refresh() {
    this._pollInitial();
    this._render();
  }

  setArmManager(armManager) { this._armManager = armManager; this.refresh(); }
  setLassoSystem(lassoSystem) { this._lasso = lassoSystem; this.refresh(); }

  /** Show or hide the chip row (hidden during the onboarding pipeline). */
  setVisible(visible) {
    if (!this._root) return;
    this._root.style.display = visible ? 'flex' : 'none';
  }

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
      "font-family: var(--font-mono)",
      'font-size:12px',
      'white-space:nowrap',
      // mounts hidden until onboarding completes (or a veteran save)
      'display:none',
    ].join(';') + ';';
    this._root = row;

    // Inline label is total/max; the per-arm breakdown lives in the chip title only.
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

  _wireListeners() {
    const eb = this._eventBus;
    if (!eb) return;
    const on = (evt, h) => {
      const u = eb.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };
    on(Events.NET_INVENTORY_CHANGED, (d) => this._onNetInventory(d));

    // SUSPENDED: never displayed (too cryptic). It stays mounted so event wiring and state tracking
    // still work, but setVisible is never called.
  }

  /** Poll the initial state from injected systems (events only fire on change). */
  _pollInitial() {
    if (this._lasso && typeof this._lasso.getAmmo === 'function') {
      const cur = this._lasso.getAmmo() ?? 0;
      const max = (Constants && Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE
        && Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE) || cur;
      this._lasso_state.remaining = cur;
      this._lasso_state.max = max;
    }
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

  _onNetInventory(d) {
    // DECISIONS §33: the mother's one count rides on every mother event as `motherNets`.
    if (d && d.source === 'mother' && Number.isFinite(d.motherNets)) {
      this._lasso_state.remaining = d.motherNets;
      // capacity grows with the line-fibre upgrade; the mother's events carry it as podMax.
      const podCap = Array.isArray(d.podMax) ? d.podMax.reduce((a, b) => a + (b || 0), 0) : 0;
      const mag = podCap > 0 ? podCap : (this._lasso_state.max || (Constants && Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE
        && Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE));
      if (mag) this._lasso_state.max = mag;
    }
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

    // Only emit on rising severity (ok→low/critical, low→critical), not on recovery.
    const RANK = { ok: 0, low: 1, critical: 2 };
    const lassoEsc = RANK[newLasso] > RANK[prevLasso];
    const netEsc   = RANK[newNet]   > RANK[prevNet];
    if (!lassoEsc && !netEsc) return;

    // Cooldown gate; the first ever emit (`_lastLowEmitAt === 0`) always passes.
    const now = this._now();
    if (this._lastLowEmitAt > 0
        && (now - this._lastLowEmitAt) < (T.LOW_HINT_COOLDOWN_MS || 60000)) {
      return;
    }

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

    // No comms line from here: the player's net lines are the one-line prompts of DECISIONS §33 row 3.
    // INVENTORY_LOW above stays for any listener.
  }

  _render() {
    if (!_hasDOM() || !this._root) return;
    if (this._lassoChip) {
      const remaining = this._lasso_state.remaining ?? 0;
      const max       = this._lasso_state.max ?? 0;
      const label = max > 0 ? `${remaining}/${max}` : `${remaining}`;
      this._lassoChip._textNode.textContent = label;
      this._lassoChip.title = `Lasso shots: ${label}.  ${restockTail()}`;
      this._styleChip(this._lassoChip, this._lasso_state.severity);
    }
    // Inline label is ALWAYS just `total/max`; the per-arm breakdown is only in the hover tooltip.
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
