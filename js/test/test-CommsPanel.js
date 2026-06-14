/**
 * test-CommsPanel.js — ST-5.1: Filter persistence, pane dimensions, priority colours
 * Tests pure helpers from CommsPanel.js.
 * (UX-11 #9: the tap/hold discrimination suite was removed with the C-hold radial.)
 *
 * Functions are copied from CommsPanel.js since that module imports
 * DOM/EventBus (unavailable in Node). Tests validate the algorithms.
 * @module test/test-CommsPanel
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

const COMMS = Constants.COMMS;

// ============================================================================
// ALGORITHM COPIES (mirror CommsPanel.js module-level helpers exactly)
// ============================================================================

function filterRoundTrip(filters) {
  const json = JSON.stringify(filters);
  const parsed = JSON.parse(json);
  const result = {};
  for (const ch of COMMS.CHANNELS) {
    result[ch] = parsed[ch] !== undefined ? parsed[ch] : true;
  }
  return result;
}

// ============================================================================
// Filter persistence round-trip
// ============================================================================

describe('CommsPanel – filter persistence', () => {
  it('filterRoundTrip: all enabled → JSON → parse → all enabled', () => {
    const filters = { CMD: true, ALERT: true, HOUSTON: true, SCI: true, FLAVOR: true, MISSION: true };
    const json = JSON.stringify(filters);
    const parsed = JSON.parse(json);
    for (const ch of COMMS.CHANNELS) {
      assert.equal(parsed[ch], true);
    }
  });

  it('filterRoundTrip: CMD disabled → survives JSON round-trip', () => {
    const filters = { CMD: false, ALERT: true, HOUSTON: true, SCI: true, FLAVOR: true, MISSION: true };
    const result = filterRoundTrip(filters);
    assert.equal(result.CMD, false);
    assert.equal(result.ALERT, true);
  });

  it('filterRoundTrip: missing channels default to true', () => {
    const result = filterRoundTrip({ CMD: false });
    assert.equal(result.CMD, false);
    assert.equal(result.ALERT, true);
    assert.equal(result.FLAVOR, true);
  });
});

// ============================================================================
// Pane dimensions match constants
// ============================================================================

describe('CommsPanel – pane dimensions', () => {
  it('PANE_HEIGHT_PX is 144', () => {
    assert.equal(COMMS.PANE_HEIGHT_PX, 144);
  });

  it('PANE_WIDTH_PX is 480 (UX-2 #11)', () => {
    assert.equal(COMMS.PANE_WIDTH_PX, 480);
  });

  it('PANE_LINES_DEFAULT is 4 (UX-2 #11)', () => {
    assert.equal(COMMS.PANE_LINES_DEFAULT, 4);
  });

  it('PANE_LINES_EXPANDED is 10 (UX-2 #10)', () => {
    assert.equal(COMMS.PANE_LINES_EXPANDED, 10);
  });

  it('PANE_EXPAND_HEIGHT_PX is 300', () => {
    assert.equal(COMMS.PANE_EXPAND_HEIGHT_PX, 300);
  });

  it('PANE_LINES_MIN is 2 (line step shows ≥1 full message)', () => {
    assert.equal(COMMS.PANE_LINES_MIN, 2);
  });

  it('PANE_HEIGHT_MIN_PX fits the 2-message line step (~33px/msg + 12px chrome)', () => {
    assert.equal(COMMS.PANE_HEIGHT_MIN_PX, 80);
    // The log container (height − 12) must hold PANE_LINES_MIN messages at the
    // normal step's per-message ratio so neither row is clipped.
    const perMsg = (COMMS.PANE_HEIGHT_PX - 12) / COMMS.PANE_LINES_DEFAULT;
    const logHeight = COMMS.PANE_HEIGHT_MIN_PX - 12;
    assert.ok(logHeight >= perMsg * COMMS.PANE_LINES_MIN,
      `line-step log (${logHeight}px) must hold ${COMMS.PANE_LINES_MIN} msgs (~${(perMsg * COMMS.PANE_LINES_MIN).toFixed(1)}px)`);
  });

});

// ============================================================================
// PRIORITY → COLOUR (mirrors CommsPanel.getPriorityColor exactly)
// Green = info/guidance/nominal, Yellow = warning/alert, Red = danger/critical.
// ============================================================================

const COMMS_COLOR_NORMAL = '#00ff88';
const COMMS_COLOR_WARNING = '#ffaa00';
const COMMS_COLOR_CRITICAL = '#ff4444';

function getPriorityColor(priority) {
  const p = String(priority || '').toLowerCase();
  if (p === 'critical' || p === 'danger' || p === 'emergency' ||
      p === 'risk' || p === 'fatal' || p === 'error') {
    return COMMS_COLOR_CRITICAL;
  }
  if (p === 'warning' || p === 'warn' || p === 'alert' || p === 'caution') {
    return COMMS_COLOR_WARNING;
  }
  return COMMS_COLOR_NORMAL;
}

describe('CommsPanel – getPriorityColor (3-colour semantics, case-insensitive)', () => {
  it('canonical enum INFO/WARNING/CRITICAL map correctly', () => {
    assert.equal(getPriorityColor('INFO'), COMMS_COLOR_NORMAL);
    assert.equal(getPriorityColor('WARNING'), COMMS_COLOR_WARNING);
    assert.equal(getPriorityColor('CRITICAL'), COMMS_COLOR_CRITICAL);
  });

  it('lowercase emitter values map correctly (regression: was all green)', () => {
    assert.equal(getPriorityColor('info'), COMMS_COLOR_NORMAL);
    assert.equal(getPriorityColor('warning'), COMMS_COLOR_WARNING);
    assert.equal(getPriorityColor('critical'), COMMS_COLOR_CRITICAL);
  });

  it('danger vocabulary → red', () => {
    for (const p of ['danger', 'emergency', 'risk', 'Emergency', 'DANGER']) {
      assert.equal(getPriorityColor(p), COMMS_COLOR_CRITICAL, `"${p}" should be red`);
    }
  });

  it('alert/caution vocabulary → yellow', () => {
    for (const p of ['alert', 'caution', 'Alert', 'WARN']) {
      assert.equal(getPriorityColor(p), COMMS_COLOR_WARNING, `"${p}" should be yellow`);
    }
  });

  it('guidance / attaboy / nominal / empty → green (the default, all-good band)', () => {
    for (const p of ['guidance', 'attaboy', 'nominal', '', null, undefined, 'chatter']) {
      assert.equal(getPriorityColor(p), COMMS_COLOR_NORMAL, `"${p}" should be green`);
    }
  });
});
