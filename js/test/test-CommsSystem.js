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
    'TETHER SEVERED — daughter and catch cut loose and drifting. Reload not possible; send another daughter to chase it down.',
    { channel: 'ALERT' },
    messages
  );
}

/**
 * Simulates the NET_FAILED listener in CommsSystem._setupEventListeners().
 * Mirrors: this.addMessage('WARNING', data?.armId || 'SYSTEM', ..., { channel: 'ALERT' })
 */
function simulateNetFailedListener(data, messages) {
  return simulateAddMessage(
    'WARNING',
    data?.armId || 'SYSTEM',
    'NET FAILED — debris slipped the net and is drifting. Daughter returning to reload; re-net to retry.',
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
    : '[N] capture · [1-4] pilot for a closer look.';
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
    `${daughterName} is holding station on the debris. Press N to capture, or its number key (1-4) to pilot it in closer.`,
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

describe('CommsSystem – NET_FAILED listener (recoverable net failure)', () => {
  it('NET_FAILED with armId stores WARNING message on ALERT channel', () => {
    const messages = [];
    const msg = simulateNetFailedListener({ armId: 'Weaver-1', armIndex: 0, debrisId: 42, strain: 0.95 }, messages);
    assert.ok(msg, 'message should be stored');
    assert.equal(msg.source, 'Weaver-1');
    assert.equal(msg.priority, 'WARNING');
    assert.equal(msg.channel, 'ALERT');
    assert.ok(msg.text.includes('NET FAILED'), 'text should contain NET FAILED');
    assert.ok(msg.text.toLowerCase().includes('retry'), 'text should tell the player they can retry');
  });

  it('NET_FAILED without armId falls back to SYSTEM', () => {
    const messages = [];
    const msg = simulateNetFailedListener({ armIndex: 1, debrisId: 7 }, messages);
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
    assert.ok(msg.text.includes('holding 8m from'), 'standoff should be rounded to 8');
    assert.ok(msg.text.includes('#142'), 'targetId should appear');
    assert.ok(msg.text.includes('[N] capture'), 'should include N capture hint');
    assert.ok(msg.text.includes('[1-4] pilot'), 'should include 1-4 pilot hint');
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
    assert.ok(followUp.text.includes('(1-4) to pilot'), 'tells player to press its number key');
  });

  it('SK_ENTERED with missing standoffR renders ? placeholder', () => {
    const messages = [];
    const msg = simulateStationKeepEnteredListener(
      { armId: 'Weaver-1', targetId: 42 },
      messages
    );
    assert.ok(msg.text.includes('holding ?m from'), 'missing standoff should show ?');
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

// ============================================================================
// CP-4 — guidance-arbiter suppression tiers (commsSuppression.js, shared core)
// ============================================================================

import {
  messagePassesSuppression,
  rampSuppressionTier,
  postOnboardingStartTier,
  SUPPRESSION_TIER_CHANNELS,
} from '../systems/commsSuppression.js';

describe('CommsSystem – suppression tier gate', () => {
  it('tier 3 (default / steady state) passes every channel', () => {
    for (const ch of ['CMD', 'ALERT', 'HOUSTON', 'SCI', 'FLAVOR', 'MISSION']) {
      assert.equal(messagePassesSuppression(3, ch, {}, 'INFO'), true, `${ch} should pass at tier 3`);
    }
  });

  it('tier 0 (onboarding) suppresses everything untagged', () => {
    assert.equal(messagePassesSuppression(0, 'FLAVOR', {}, 'INFO'), false);
    assert.equal(messagePassesSuppression(0, 'HOUSTON', {}, 'INFO'), false);
    assert.equal(messagePassesSuppression(0, 'ALERT', {}, 'WARNING'), false);
  });

  it('tier 0 still passes the Director\'s own _onboarding lines', () => {
    assert.equal(messagePassesSuppression(0, 'HOUSTON', { _onboarding: true }, 'INFO'), true);
  });

  it('tier 1 allows HOUSTON + MISSION only', () => {
    assert.equal(messagePassesSuppression(1, 'HOUSTON', {}, 'INFO'), true);
    assert.equal(messagePassesSuppression(1, 'MISSION', {}, 'INFO'), true);
    assert.equal(messagePassesSuppression(1, 'CMD', {}, 'INFO'), false);
    assert.equal(messagePassesSuppression(1, 'ALERT', {}, 'WARNING'), false);
    assert.equal(messagePassesSuppression(1, 'FLAVOR', {}, 'INFO'), false);
    assert.equal(messagePassesSuppression(1, 'SCI', {}, 'INFO'), false);
  });

  it('tier 2 adds ALERT + CMD, still gates FLAVOR/SCI', () => {
    assert.equal(messagePassesSuppression(2, 'ALERT', {}, 'WARNING'), true);
    assert.equal(messagePassesSuppression(2, 'CMD', {}, 'INFO'), true);
    assert.equal(messagePassesSuppression(2, 'FLAVOR', {}, 'INFO'), false);
    assert.equal(messagePassesSuppression(2, 'SCI', {}, 'INFO'), false);
  });

  it('_critical tag bypasses ANY tier (incl. 0) — ISS/Hubble conjunction', () => {
    assert.equal(messagePassesSuppression(0, 'ALERT', { _critical: true }, 'WARNING'), true);
    assert.equal(messagePassesSuppression(1, 'FLAVOR', { _critical: true }, 'INFO'), true);
  });

  it('CRITICAL priority is never muted from tier 1 up, but NOT at tier 0', () => {
    assert.equal(messagePassesSuppression(1, 'FLAVOR', {}, 'CRITICAL'), true);
    assert.equal(messagePassesSuppression(2, 'SCI', {}, 'critical'), true); // case-insensitive
    // Tier 0 protects the onboarding script — only explicit tags escape it.
    assert.equal(messagePassesSuppression(0, 'FLAVOR', {}, 'CRITICAL'), false);
  });

  it('_postOnboarding (MissionCoach beats) passes at tiers ≥ 1 but not at tier 0', () => {
    assert.equal(messagePassesSuppression(1, 'MISSION', { _postOnboarding: true }, 'INFO'), true);
    assert.equal(messagePassesSuppression(2, 'FLAVOR', { _postOnboarding: true }, 'INFO'), true);
    assert.equal(messagePassesSuppression(0, 'MISSION', { _postOnboarding: true }, 'INFO'), false);
  });

  it('_lassoFeedback (actionable denial) always passes', () => {
    assert.equal(messagePassesSuppression(0, 'CMD', { _lassoFeedback: true }, 'INFO'), true);
    assert.equal(messagePassesSuppression(1, 'CMD', { _lassoFeedback: true }, 'INFO'), true);
  });

  it('_proactive prompt is tier-gated even with _lassoFeedback (Phase 0)', () => {
    // The in-range "Press N" invitation is proactive — it must NOT punch through
    // tier 0 (the Director owns onboarding) the way a reactive denial does.
    assert.equal(
      messagePassesSuppression(0, 'CMD', { _lassoFeedback: true, _proactive: true }, 'INFO'),
      false, 'proactive invite suppressed at tier 0');
    // But once steady-state (tier 3) it passes like any other CMD line.
    assert.equal(
      messagePassesSuppression(3, 'CMD', { _lassoFeedback: true, _proactive: true }, 'INFO'),
      true, 'proactive invite passes at tier 3');
    // A reactive denial (no _proactive) still bypasses tier 0.
    assert.equal(
      messagePassesSuppression(0, 'CMD', { _lassoFeedback: true }, 'WARNING'),
      true, 'reactive denial still bypasses tier 0');
  });

  it('tier channel sets match the spec table', () => {
    assert.deepEqual([...SUPPRESSION_TIER_CHANNELS[1]].sort(), ['HOUSTON', 'MISSION']);
    assert.deepEqual([...SUPPRESSION_TIER_CHANNELS[2]].sort(), ['ALERT', 'CMD', 'HOUSTON', 'MISSION']);
  });
});

describe('CommsSystem – suppression ramp (rampSuppressionTier)', () => {
  const RAMP = { TIER2_AFTER_S: 30, TIER3_AFTER_S: 60 };

  it('0–30 s → tier 1', () => {
    assert.equal(rampSuppressionTier(0, RAMP), 1);
    assert.equal(rampSuppressionTier(29.9, RAMP), 1);
  });

  it('30–60 s → tier 2', () => {
    assert.equal(rampSuppressionTier(30, RAMP), 2);
    assert.equal(rampSuppressionTier(59.9, RAMP), 2);
  });

  it('60 s+ → tier 3 (steady state)', () => {
    assert.equal(rampSuppressionTier(60, RAMP), 3);
    assert.equal(rampSuppressionTier(600, RAMP), 3);
  });

  it('uses Constants.COMMS.SUPPRESSION_RAMP when no ramp passed', () => {
    const R = Constants.COMMS.SUPPRESSION_RAMP;
    assert.ok(R && R.TIER2_AFTER_S > 0 && R.TIER3_AFTER_S > R.TIER2_AFTER_S, 'ramp constant present + ordered');
    assert.equal(rampSuppressionTier(R.TIER3_AFTER_S), 3);
  });
});

describe('CommsSystem – post-onboarding start tier (veteran mis-ramp fix, Phase 1)', () => {
  it('onboarding actually ran → begin the wake ramp at tier 1', () => {
    assert.equal(postOnboardingStartTier(true), 1);
  });

  it('veteran-skip (ONBOARDING_COMPLETE without ONBOARDING_STARTED) → steady tier 3', () => {
    // A returning veteran must NOT be muted for ~60 s — there was no onboarding
    // atmosphere to wake from.
    assert.equal(postOnboardingStartTier(false), 3);
  });
});
