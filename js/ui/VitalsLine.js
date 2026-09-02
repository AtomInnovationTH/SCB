/**
 * VitalsLine.js — the always-on one-line safety readout (08-workbench §2
 * "Always present, faint": **fuel/ΔV · power · time rate**).
 *
 * D6: safety readouts about the player's own ship go FAINT (~30 %), never
 * gone — hover or tap brightens. D7 + the §4 always-set: this line is never
 * maskable; FloorMask registers it in the always-on set and only ever calls
 * setVisible (engage/disengage), never a tier.
 *
 * Data feeds (no hub wire needed for two of three):
 *   - fuel/ΔV + power ride the EXISTING 10 Hz `DELTAV_UPDATE` telemetry
 *     (StatusPanel emits pct/deltaV/batteryPct — the ΔV-alarm driver, register
 *     item 43), subscribed here exactly like every other pane subscribes.
 *   - time rate is an injected zero-arg getter (`() => timeAuthority.rate`,
 *     main.js — see the FloorMask HANDOFF), sampled on the same 10 Hz beat.
 *
 * G1 (docs/ladder/02-traps.md): write on change only — every segment caches
 * its last-written string and skips identical writes; the time-rate segment
 * additionally throttles a CHANGED label to ≤ 4 Hz (RailIndicator.setRate
 * semantics: unchanged is free, changed inside the window is held and lands
 * on a later beat). No per-frame DOM churn: the only recurring driver is the
 * 10 Hz telemetry event.
 *
 * Placement: bottom-left, mounted on document.body (the _createTopPanel
 * idiom) so per-view hudOpacity dims, callout dims, and net-cinema ghosting
 * never touch it — "never leaves the screen".
 *
 * Deps optional (LadderAudioBeds pattern): without a document every method
 * is a state-only no-op; unconstructed (flag-off / unwired) it does not
 * exist at all — shipped DOM byte-identical.
 *
 * @module ui/VitalsLine
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// ── Tunables (own-module exports; house rule: never FloorContract/Constants) ─

/** Resting opacity of the line (D6 "~30 %, never gone"). */
export const VITALS_FAINT_OPACITY = 0.3;

/** Opacity ease for faint↔bright (08-workbench §2 motion: one curve, 240–300 ms). */
export const VITALS_FAINT_TRANSITION_MS = 240;

/** How long a tap holds the line bright before it eases back faint, ms. */
export const VITALS_BRIGHT_HOLD_MS = 2000;

/** Min interval between CHANGED time-rate writes (≤ 4 Hz — the rail's G1 law). */
export const VITALS_RATE_WRITE_MIN_MS = 250;

/**
 * Time-rate label: integers stay integers ('4×'), sub-decade ramps keep one
 * decimal ('4.9×'), ≥ 9.5 rounds ('20×'), non-finite/≤0 reads '—'.
 * @param {number} rate
 * @returns {string}
 */
export function rateLabel(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return '—';
  if (r >= 9.5) return `${Math.round(r)}×`;
  const one = Math.round(r * 10) / 10;
  return `${one % 1 === 0 ? one.toFixed(0) : one.toFixed(1)}×`;
}

export class VitalsLine {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.doc]       - document (default: the global one).
   *   Absent ⇒ nothing builds and every method no-ops (headless-safe).
   * @param {object}   [deps.bus]       - event bus (default: house eventBus).
   * @param {object}   [deps.events]    - event-name table (default: Events).
   * @param {function} [deps.getTimeRate] - zero-arg getter for the live time
   *   rate (main.js wires `() => timeAuthority.rate`). Absent ⇒ the rate
   *   segment rests at '—'.
   * @param {function} [deps.now]       - monotonic ms clock (tests).
   * @param {object}   [deps.timers]    - { set, clear } (tests; default global).
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._bus = deps.bus || eventBus;
    this._events = deps.events || Events;
    this._getTimeRate = deps.getTimeRate || null;
    this._now = deps.now || (() => (typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now()));
    this._timers = deps.timers || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (id) => clearTimeout(id),
    };

    this._row = null;
    this._seg = { dv: null, power: null, rate: null };
    /** Last-written strings — the G1 write guard (never re-read the DOM). */
    this._last = { dv: null, power: null, rate: null };
    this._rateWriteMs = -Infinity;
    this._visible = true;
    this._brightTimer = null;
    this._unsub = null;
    this._disposed = false;

    if (this._doc) {
      this._build();
      // Fuel/ΔV + power: the shipped 10 Hz telemetry beat (register item 43's
      // one honest driver). The handler also samples the time-rate getter, so
      // the whole line has exactly ONE recurring driver and zero new events.
      this._unsub = this._bus.on(this._events.DELTAV_UPDATE, (data) => {
        if (!data) return;
        this.update({
          dvPct: data.pct,
          batteryPct: data.batteryPct,
          timeRate: this._getTimeRate ? this._getTimeRate() : null,
        });
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Write the three segments; each write is guarded on the last-written
   * string (G1), and a CHANGED rate label is additionally throttled to
   * VITALS_RATE_WRITE_MIN_MS (unchanged labels are always free).
   * @param {object} data
   * @param {number} [data.dvPct]     - ΔV remaining, 0..1 (DELTAV_UPDATE pct)
   * @param {number} [data.batteryPct]- battery, 0..100 (DELTAV_UPDATE batteryPct)
   * @param {number|null} [data.timeRate] - live rate, or null to leave as-is
   */
  update(data = {}) {
    if (this._disposed || !this._row) return;
    if (typeof data.dvPct === 'number' && Number.isFinite(data.dvPct)) {
      const dv = `ΔV ${Math.round(Math.max(0, Math.min(1, data.dvPct)) * 100)}%`;
      if (dv !== this._last.dv) { this._last.dv = dv; this._seg.dv.textContent = dv; }
    }
    if (typeof data.batteryPct === 'number' && Number.isFinite(data.batteryPct)) {
      const pw = `⚡ ${Math.round(Math.max(0, Math.min(100, data.batteryPct)))}%`;
      if (pw !== this._last.power) { this._last.power = pw; this._seg.power.textContent = pw; }
    }
    if (data.timeRate != null) {
      const label = rateLabel(data.timeRate);
      if (label !== this._last.rate) {
        const t = this._now();
        // RailIndicator.setRate law: unchanged = free; changed inside the
        // window (measured from the last WRITE) = held for a later beat.
        if (t - this._rateWriteMs >= VITALS_RATE_WRITE_MIN_MS) {
          this._last.rate = label;
          this._rateWriteMs = t;
          this._seg.rate.textContent = label;
        }
      }
    }
  }

  /**
   * Show/hide the whole line (FloorMask drives this on engage/disengage —
   * the shipped cockpit has no vitals line, so disengage hides it).
   * @param {boolean} v
   */
  setVisible(v) {
    if (this._disposed || !this._row) return;
    const want = !!v;
    if (want === this._visible) return;
    this._visible = want;
    this._row.style.display = want ? '' : 'none';
  }

  /** Whether the line is currently shown (tests/debug). */
  isVisible() { return !!(this._row && this._visible); }

  /** Tear down: unsubscribe, clear the tap timer, remove the DOM. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._unsub) { try { this._unsub(); } catch (_e) { /* stub */ } this._unsub = null; }
    if (this._brightTimer != null) { this._timers.clear(this._brightTimer); this._brightTimer = null; }
    if (this._row) {
      try {
        if (this._row.remove) this._row.remove();
        else if (this._row.parentNode) this._row.parentNode.removeChild(this._row);
      } catch (_e) { /* stub */ }
      this._row = null;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** @private Tap-to-brighten (D6 "hover or tap"): hold bright, then ease back. */
  _onTap() {
    if (this._disposed || !this._row) return;
    this._row.classList.add('vitals-bright');
    if (this._brightTimer != null) this._timers.clear(this._brightTimer);
    this._brightTimer = this._timers.set(() => {
      this._brightTimer = null;
      if (this._row) this._row.classList.remove('vitals-bright');
    }, VITALS_BRIGHT_HOLD_MS);
  }

  /** @private Build the line + inject its stylesheet (idempotent by id). */
  _build() {
    const doc = this._doc;
    if (!doc.getElementById('vitals-line-style') && doc.head) {
      const style = doc.createElement('style');
      style.id = 'vitals-line-style';
      style.textContent = `
        #vitals-line {
          position: fixed; left: 12px; bottom: 10px; z-index: 60;
          font-family: 'Courier New', monospace; font-size: 11px;
          letter-spacing: 0.06em; color: #aaffdd; white-space: nowrap;
          background: rgba(0, 10, 20, 0.45);
          border: 1px solid rgba(0, 255, 136, 0.18); border-radius: 3px;
          padding: 2px 8px; pointer-events: auto;
          opacity: ${VITALS_FAINT_OPACITY};
          transition: opacity ${VITALS_FAINT_TRANSITION_MS}ms ease;
        }
        #vitals-line:hover, #vitals-line.vitals-bright { opacity: 1; }
        @media (prefers-reduced-motion: reduce) {
          #vitals-line { transition: none; }
        }
      `;
      doc.head.appendChild(style);
    }
    const row = doc.createElement('div');
    row.id = 'vitals-line';
    row.title = 'Vitals — fuel/ΔV · power · time rate (dims, never hides; hover or tap to brighten)';
    const mk = (id, text) => {
      const s = doc.createElement('span');
      if (id) { s.id = id; this._seg[id.replace('vitals-', '')] = s; }
      s.textContent = text;
      row.appendChild(s);
      return s;
    };
    mk('vitals-dv', 'ΔV —');
    mk(null, ' · ');
    mk('vitals-power', '⚡ —');
    mk(null, ' · ');
    mk('vitals-rate', '—');
    row.addEventListener('pointerdown', () => this._onTap());
    if (doc.body) doc.body.appendChild(row);
    this._row = row;
  }
}

export default VitalsLine;
