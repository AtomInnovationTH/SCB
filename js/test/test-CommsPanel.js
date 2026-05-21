/**
 * test-CommsPanel.js — ST-5.1: Tap/hold discrimination, filter persistence, pane dimensions
 * Tests pure helpers from CommsPanel.js.
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

function discriminateKeyEvent(downTs, upTs, threshold) {
  const t = threshold != null ? threshold : COMMS.C_HOLD_THRESHOLD_MS;
  return (upTs - downTs) >= t ? 'hold' : 'tap';
}

function filterRoundTrip(filters) {
  const json = JSON.stringify(filters);
  const parsed = JSON.parse(json);
  const result = {};
  for (const ch of COMMS.CHANNELS) {
    result[ch] = parsed[ch] !== undefined ? parsed[ch] : true;
  }
  return result;
}

function getChannelColor(channel) {
  return COMMS.CHANNEL_COLORS[channel] || COMMS.CHANNEL_COLORS[COMMS.DEFAULT_CHANNEL];
}

// ============================================================================
// discriminateKeyEvent
// ============================================================================

describe('CommsPanel – discriminateKeyEvent (C-tap vs C-hold)', () => {
  it('press+release in 100 ms → tap', () => {
    assert.equal(discriminateKeyEvent(1000, 1100, 300), 'tap');
  });

  it('press+release in 250 ms → tap (at boundary)', () => {
    assert.equal(discriminateKeyEvent(1000, 1250, 300), 'tap');
  });

  it('press+release in 400 ms → hold', () => {
    assert.equal(discriminateKeyEvent(1000, 1400, 300), 'hold');
  });

  it('press+release in exactly 300 ms → hold (>=threshold)', () => {
    assert.equal(discriminateKeyEvent(1000, 1300, 300), 'hold');
  });

  it('default threshold uses Constants.COMMS.C_HOLD_THRESHOLD_MS', () => {
    assert.equal(discriminateKeyEvent(0, 200), 'tap');
    assert.equal(discriminateKeyEvent(0, 350), 'hold');
  });
});

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

  it('C_HOLD_THRESHOLD_MS is 300', () => {
    assert.equal(COMMS.C_HOLD_THRESHOLD_MS, 300);
  });

  it('C_TAP_MAX_MS is 250', () => {
    assert.equal(COMMS.C_TAP_MAX_MS, 250);
  });
});

// ============================================================================
// Channel color lookup
// ============================================================================

describe('CommsPanel – getChannelColor', () => {
  it('CMD → amber #ffaa00', () => {
    assert.equal(getChannelColor('CMD'), '#ffaa00');
  });

  it('ALERT → red #ff4444', () => {
    assert.equal(getChannelColor('ALERT'), '#ff4444');
  });

  it('HOUSTON → mint #88ffcc', () => {
    assert.equal(getChannelColor('HOUSTON'), '#88ffcc');
  });

  it('unknown channel → FLAVOR grey', () => {
    assert.equal(getChannelColor('BOGUS'), COMMS.CHANNEL_COLORS.FLAVOR);
  });
});
