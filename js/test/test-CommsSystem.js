/**
 * test-CommsSystem.js — ST-5.1: Channel classifier + coalescing tests
 * Tests sourceToChannel() and shouldCoalesce() pure helpers.
 *
 * Functions are copied from CommsSystem.js since that module imports
 * AudioSystem (unavailable in Node). Tests validate the algorithms.
 * @module test/test-CommsSystem
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// ALGORITHM COPIES (mirror CommsSystem.js module-level helpers exactly)
// ============================================================================

const COMMS = Constants.COMMS || {};
const VALID_CHANNELS = new Set(COMMS.CHANNELS || ['CMD', 'ALERT', 'HOUSTON', 'SCI', 'FLAVOR', 'MISSION']);
const DEFAULT_CHANNEL = COMMS.DEFAULT_CHANNEL || 'FLAVOR';

function sourceToChannel(source, payload) {
  const p = payload || {};
  if (p.channel) {
    const ch = String(p.channel).toUpperCase();
    return VALID_CHANNELS.has(ch) ? ch : DEFAULT_CHANNEL;
  }
  const src = (source || '').toUpperCase();
  if (src === 'HOUSTON') return 'HOUSTON';
  if (src === 'MISSION' || src === 'MISSION_EVENT') return 'MISSION';
  if (src === 'BANGALORE' || src === 'HASSAN') return 'HOUSTON';
  if (src === 'NEWS') return 'MISSION';
  const text = (p.text || '').toUpperCase();
  if (/^(ALERT:|WARNING:|⚠|CONJUNCTION)/.test(text)) return 'ALERT';
  if (/^(DISCOVERY|CODEX|IDENTIFIED)/.test(text)) return 'SCI';
  if (/^(DEPLOY|REEL|DETACH|COMMS: DEPLOY|COMMS: FISH|COMMS: RECALL)/.test(text)) return 'CMD';
  return DEFAULT_CHANNEL;
}

function shouldCoalesce(recentWindow, newChannel, thresholdCount) {
  const threshold = thresholdCount || COMMS.COALESCE_THRESHOLD_COUNT || 3;
  const sameChannel = recentWindow.filter(m => m.channel === newChannel);
  const count = sameChannel.length + 1;
  return {
    shouldCoalesce: count >= threshold,
    count,
  };
}

// ============================================================================
// sourceToChannel
// ============================================================================

describe('CommsSystem – sourceToChannel', () => {
  it('source HOUSTON → HOUSTON channel', () => {
    assert.equal(sourceToChannel('HOUSTON'), 'HOUSTON');
  });

  it('source houston (lowercase) → HOUSTON via uppercasing', () => {
    assert.equal(sourceToChannel('houston'), 'HOUSTON');
  });

  it('explicit channel ALERT beats source inference', () => {
    assert.equal(sourceToChannel(undefined, { channel: 'ALERT' }), 'ALERT');
  });

  it('explicit channel beats HOUSTON source', () => {
    assert.equal(sourceToChannel('HOUSTON', { channel: 'SCI' }), 'SCI');
  });

  it('no source, no channel → FLAVOR (default)', () => {
    assert.equal(sourceToChannel(undefined, {}), 'FLAVOR');
  });

  it('unknown channel string → FLAVOR', () => {
    assert.equal(sourceToChannel(undefined, { channel: 'BOGUS' }), 'FLAVOR');
  });

  it('source MISSION → MISSION channel', () => {
    assert.equal(sourceToChannel('MISSION'), 'MISSION');
  });

  it('text starting with ALERT: → ALERT via heuristic', () => {
    assert.equal(sourceToChannel('SDA', { text: 'ALERT: conjunction imminent' }), 'ALERT');
  });

  it('text starting with Deploy → CMD via heuristic', () => {
    assert.equal(sourceToChannel('SPACECRAFT', { text: 'Deploy Weaver — executing' }), 'CMD');
  });

  it('text starting with Discovery → SCI via heuristic', () => {
    assert.equal(sourceToChannel('GROUND STN', { text: 'Discovery: new material found' }), 'SCI');
  });

  it('generic source + generic text → FLAVOR', () => {
    assert.equal(sourceToChannel('NORAD', { text: 'Routine catalog maintenance' }), 'FLAVOR');
  });
});

// ============================================================================
// shouldCoalesce
// ============================================================================

describe('CommsSystem – shouldCoalesce', () => {
  it('3 CMD messages in window → shouldCoalesce = true', () => {
    const window = [
      { channel: 'CMD', timestamp: 100 },
      { channel: 'CMD', timestamp: 200 },
    ];
    const result = shouldCoalesce(window, 'CMD', 3);
    assert.equal(result.shouldCoalesce, true);
    assert.equal(result.count, 3);
  });

  it('2 CMD in window + 1 new CMD → count=3, shouldCoalesce=true', () => {
    const window = [
      { channel: 'CMD', timestamp: 500 },
      { channel: 'CMD', timestamp: 1000 },
    ];
    const result = shouldCoalesce(window, 'CMD', 3);
    assert.equal(result.shouldCoalesce, true);
    assert.equal(result.count, 3);
  });

  it('1 CMD in window + 1 new → count=2, shouldCoalesce=false', () => {
    const window = [
      { channel: 'CMD', timestamp: 500 },
    ];
    const result = shouldCoalesce(window, 'CMD', 3);
    assert.equal(result.shouldCoalesce, false);
    assert.equal(result.count, 2);
  });

  it('mixed channels do not coalesce (3 different in 1s → 3 separate)', () => {
    const window = [
      { channel: 'CMD', timestamp: 100 },
      { channel: 'ALERT', timestamp: 200 },
    ];
    const result = shouldCoalesce(window, 'SCI', 3);
    assert.equal(result.shouldCoalesce, false);
    assert.equal(result.count, 1);
  });

  it('empty window → count=1, no coalescing', () => {
    const result = shouldCoalesce([], 'CMD', 3);
    assert.equal(result.shouldCoalesce, false);
    assert.equal(result.count, 1);
  });

  it('threshold of 2 triggers earlier', () => {
    const window = [
      { channel: 'ALERT', timestamp: 100 },
    ];
    const result = shouldCoalesce(window, 'ALERT', 2);
    assert.equal(result.shouldCoalesce, true);
    assert.equal(result.count, 2);
  });
});

// === ST-8.4: ISRO Persona Routing ===
describe('CommsSystem – ISRO & NEWS source routing (ST-8.4)', () => {
  it('source BANGALORE routes to HOUSTON', () => {
    assert.equal(sourceToChannel('BANGALORE'), 'HOUSTON');
  });

  it('source HASSAN routes to HOUSTON', () => {
    assert.equal(sourceToChannel('HASSAN'), 'HOUSTON');
  });

  it('source bangalore (lowercase) routes to HOUSTON', () => {
    assert.equal(sourceToChannel('bangalore'), 'HOUSTON');
  });

  it('source NEWS routes to MISSION', () => {
    assert.equal(sourceToChannel('NEWS'), 'MISSION');
  });

  it('source HOUSTON still routes to HOUSTON', () => {
    assert.equal(sourceToChannel('HOUSTON'), 'HOUSTON');
  });

  it('source MISSION still routes to MISSION', () => {
    assert.equal(sourceToChannel('MISSION'), 'MISSION');
  });
});

// ============================================================================
// §0.1 source-fallback: missing source defaults to 'SYSTEM'
// ============================================================================

/**
 * Mirrors the COMMS_MESSAGE listener logic from CommsSystem.js (~lines 363-410)
 * after the §0.1 fix. Copied here because CommsSystem imports AudioSystem
 * (WebAudio, unavailable in Node).
 *
 * Returns the stored message object, or null if the listener would bail.
 */
function simulateCommsMessageListener(data, messages) {
  if (!data || data._internal) return null;
  // §0.1 fix: normalize source, default to 'SYSTEM'
  const rawSrc = data.source || data.sender || data.speaker;
  const src = rawSrc || 'SYSTEM';
  if (!data.text) return null;

  const channel = sourceToChannel(src, data);
  const msg = {
    id: messages.length + 1,
    timestamp: '00:00:00',
    source: src,
    text: data.text,
    priority: data.priority || 'INFO',
    channel,
    age: 0,
  };
  messages.push(msg);
  return msg;
}

/**
 * Mirrors addMessage() from CommsSystem.js (~lines 742-810) after §0.1 fix.
 * Returns the stored message object, or null if it would bail.
 */
function simulateAddMessage(priority, source, text, extra, messages) {
  // §0.1 fix: default missing source
  if (!source) source = 'SYSTEM';
  if (!text) return null;

  const channel = sourceToChannel(source, { text, ...(extra || {}) });
  const msg = {
    id: messages.length + 1,
    timestamp: '00:00:00',
    source,
    text,
    priority,
    channel,
    age: 0,
  };
  messages.push(msg);
  return msg;
}

describe('CommsSystem – source fallback to SYSTEM (§0.1)', () => {
  it('sourceless COMMS_MESSAGE emit is stored with source SYSTEM', () => {
    const messages = [];
    const msg = simulateCommsMessageListener(
      { text: 'hello', channel: 'CMD' },  // no source
      messages
    );
    assert.ok(msg, 'message should not be dropped');
    assert.equal(msg.source, 'SYSTEM');
    assert.equal(msg.text, 'hello');
    assert.equal(msg.channel, 'CMD');
    assert.equal(messages.length, 1);
  });

  it('COMMS_MESSAGE with source HOUSTON preserves original source (regression)', () => {
    const messages = [];
    const msg = simulateCommsMessageListener(
      { source: 'HOUSTON', text: 'Go for EVA', channel: 'HOUSTON' },
      messages
    );
    assert.ok(msg, 'message should not be dropped');
    assert.equal(msg.source, 'HOUSTON');
    assert.equal(msg.channel, 'HOUSTON');
    assert.equal(messages.length, 1);
  });

  it('COMMS_MESSAGE with sender field uses sender (not SYSTEM)', () => {
    const messages = [];
    const msg = simulateCommsMessageListener(
      { sender: 'Weaver-1', text: 'deploying net' },
      messages
    );
    assert.equal(msg.source, 'Weaver-1');
  });

  it('COMMS_MESSAGE with no text is still dropped', () => {
    const messages = [];
    const msg = simulateCommsMessageListener(
      { source: 'HOUSTON' },  // no text
      messages
    );
    assert.equal(msg, null);
    assert.equal(messages.length, 0);
  });

  it('addMessage() defaults missing source to SYSTEM', () => {
    const messages = [];
    const msg = simulateAddMessage('INFO', null, 'test line', null, messages);
    assert.ok(msg, 'message should not be dropped');
    assert.equal(msg.source, 'SYSTEM');
    assert.equal(messages.length, 1);
  });

  it('addMessage() preserves explicit source', () => {
    const messages = [];
    const msg = simulateAddMessage('INFO', 'HOUSTON', 'status OK', null, messages);
    assert.equal(msg.source, 'HOUSTON');
  });

  it('addMessage() bails on missing text', () => {
    const messages = [];
    const msg = simulateAddMessage('INFO', 'HOUSTON', null, null, messages);
    assert.equal(msg, null);
    assert.equal(messages.length, 0);
  });

  it('SYSTEM-defaulted source routes to FLAVOR via sourceToChannel', () => {
    const ch = sourceToChannel('SYSTEM', { text: 'generic message' });
    assert.equal(ch, 'FLAVOR');
    // explicit channel still overrides
    const ch2 = sourceToChannel('SYSTEM', { text: 'hello', channel: 'CMD' });
    assert.equal(ch2, 'CMD');
  });
});

// ============================================================================
// §4 items 2-5: Phase 1 capture-flow listener simulations
// ============================================================================

/**
 * Simulates the TETHER_SNAP listener in CommsSystem._setupEventListeners().
 * Mirrors: this.addMessage('CRITICAL', data?.armId || 'SYSTEM', ..., { channel: 'ALERT' })
 */
function simulateTetherSnapListener(data, messages) {
  return simulateAddMessage(
    'CRITICAL',
    data?.armId || 'SYSTEM',
    'TETHER SEVERED — arm lost. Payload jettisoned. Reload not possible.',
    { channel: 'ALERT' },
    messages
  );
}

/**
 * Simulates the ARM_RETURNED listener (captured === true path).
 */
function simulateArmReturnedListener(data, messages) {
  if (data?.captured !== true) return null;
  return simulateAddMessage(
    'INFO',
    data.armId || 'SYSTEM',
    'Docking — 3 s.',
    { channel: 'CMD' },
    messages
  );
}

/**
 * Simulates the CROSSBOW_RELOAD_COMPLETE listener.
 */
function simulateReloadCompleteListener(data, messages) {
  return simulateAddMessage(
    'INFO',
    data?.armId || 'SYSTEM',
    'Spring re-charged — ready for next deploy.',
    { channel: 'CMD' },
    messages
  );
}

/**
 * Simulates the STATION_KEEP_ENTERED listener.
 */
function simulateStationKeepEnteredListener(data, messages) {
  const standoff = data?.standoffR != null ? Math.round(data.standoffR) : '?';
  const targetId = data?.targetId != null ? data.targetId : '?';
  const armId = data?.armId || 'SYSTEM';
  const hint = data?.isPiloted
    ? 'Arrow keys orbit the debris · +/- adjust distance · [N] capture.'
    : '[N] capture · [P] pilot for a closer look.';
  const onStation = simulateAddMessage(
    'INFO',
    armId,
    `ON STATION — holding ${standoff}m from debris #${targetId}. ${hint}`,
    { channel: 'CMD' },
    messages
  );
  // Plain-language follow-up (new-player guidance).
  const daughterName = data?.armId || 'your daughter';
  simulateAddMessage(
    'INFO',
    'HOUSTON',
    `${daughterName} is holding station on the debris. Press N to capture, or P to pilot it in closer.`,
    { channel: 'CMD' },
    messages
  );
  return onStation;
}

describe('CommsSystem – TETHER_SNAP listener (§4 item 2)', () => {
  it('TETHER_SNAP with armId stores CRITICAL message on ALERT channel', () => {
    const messages = [];
    const msg = simulateTetherSnapListener({ armId: 'Weaver-1', armIndex: 0, cause: 'overload' }, messages);
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'Weaver-1');
    assert.equal(msg.priority, 'CRITICAL');
    assert.equal(msg.channel, 'ALERT');
    assert.ok(msg.text.includes('TETHER SEVERED'), 'text should contain TETHER SEVERED');
  });

  it('TETHER_SNAP without armId falls back to SYSTEM', () => {
    const messages = [];
    const msg = simulateTetherSnapListener({ armIndex: 0, cause: 'overload' }, messages);
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'SYSTEM');
    assert.equal(msg.channel, 'ALERT');
  });
});

describe('CommsSystem – ARM_RETURNED captured listener (§4 item 3)', () => {
  it('ARM_RETURNED captured=true stores Docking comms on CMD channel', () => {
    const messages = [];
    const msg = simulateArmReturnedListener({ armId: 'Weaver-1', captured: true }, messages);
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'Weaver-1');
    assert.equal(msg.channel, 'CMD');
    assert.ok(msg.text.includes('Docking'), 'text should say Docking');
  });

  it('ARM_RETURNED captured=false produces no comms', () => {
    const messages = [];
    const msg = simulateArmReturnedListener({ armId: 'Weaver-1', captured: false }, messages);
    assert.equal(msg, null);
    assert.equal(messages.length, 0);
  });

  it('ARM_RETURNED without armId falls back to SYSTEM', () => {
    const messages = [];
    const msg = simulateArmReturnedListener({ captured: true }, messages);
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'SYSTEM');
  });
});

describe('CommsSystem – CROSSBOW_RELOAD_COMPLETE listener (§4 item 3)', () => {
  it('RELOAD_COMPLETE stores Spring re-charged comms on CMD channel', () => {
    const messages = [];
    const msg = simulateReloadCompleteListener({ armId: 'Spinner-2', armIndex: 1 }, messages);
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'Spinner-2');
    assert.equal(msg.channel, 'CMD');
    assert.ok(msg.text.includes('Spring re-charged'), 'text should mention spring');
  });

  it('RELOAD_COMPLETE without armId falls back to SYSTEM', () => {
    const messages = [];
    const msg = simulateReloadCompleteListener({ armIndex: 0 }, messages);
    assert.equal(msg.source, 'SYSTEM');
  });
});

describe('CommsSystem – STATION_KEEP_ENTERED listener (§4 item 4)', () => {
  it('SK_ENTERED with full payload renders standoff + targetId + hints', () => {
    const messages = [];
    const msg = simulateStationKeepEnteredListener(
      { armId: 'Weaver-1', standoffR: 8.3, targetId: 142 },
      messages
    );
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'Weaver-1');
    assert.equal(msg.channel, 'CMD');
    assert.ok(msg.text.includes('ON STATION'), 'text should say ON STATION');
    assert.ok(msg.text.includes('8m standoff'), 'standoff should be rounded to 8');
    assert.ok(msg.text.includes('#142'), 'targetId should appear');
    assert.ok(msg.text.includes('[N] capture'), 'should include N capture hint');
    assert.ok(msg.text.includes('[P] pilot'), 'should include P pilot hint');
  });

  it('SK_ENTERED posts a plain-language follow-up naming the daughter', () => {
    const messages = [];
    simulateStationKeepEnteredListener(
      { armId: 'Weaver-1', standoffR: 8.3, targetId: 142 },
      messages
    );
    const followUp = messages.find(m =>
      m.source === 'HOUSTON' && m.text.includes('holding station'));
    assert.ok(followUp, 'a plain-language HOUSTON follow-up should be posted');
    assert.ok(followUp.text.includes('Weaver-1'), 'follow-up names the daughter');
    assert.ok(followUp.text.includes('Press N to capture'), 'tells player to press N');
    assert.ok(followUp.text.includes('P to pilot'), 'tells player to press P');
  });

  it('SK_ENTERED with missing standoffR renders ? placeholder', () => {
    const messages = [];
    const msg = simulateStationKeepEnteredListener(
      { armId: 'Weaver-1', targetId: 42 },
      messages
    );
    assert.ok(msg.text.includes('?m standoff'), 'missing standoff should show ?');
  });

  it('SK_ENTERED without armId falls back to SYSTEM', () => {
    const messages = [];
    const msg = simulateStationKeepEnteredListener(
      { standoffR: 10, targetId: 99 },
      messages
    );
    assert.equal(msg.source, 'SYSTEM');
  });
});
