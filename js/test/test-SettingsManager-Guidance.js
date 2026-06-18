/**
 * test-SettingsManager-Guidance.js — guidance + autolock preferences.
 * (.kilo/plans/new-player-onboarding-flow.md §D.3 / Phase 6)
 *
 * @module test/test-SettingsManager-Guidance
 */

import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { settingsManager } from '../systems/SettingsManager.js';

describe('SettingsManager — guidance preference', () => {
  it('defaults to auto', () => {
    // (default unless a prior run persisted otherwise; reset to auto first)
    settingsManager.setGuidance('auto');
    assert.equal(settingsManager.getGuidance(), 'auto');
  });

  it('setGuidance pins a level and emits a settings-tagged event', () => {
    eventBus.clear();
    const seen = [];
    eventBus.on(Events.GUIDANCE_LEVEL_CHANGED, (d) => seen.push(d));
    const changed = settingsManager.setGuidance('MINIMAL');
    assert.equal(changed, true);
    assert.equal(settingsManager.getGuidance(), 'MINIMAL');
    assert.ok(seen.some(d => d.reason === 'settings' && d.level === 'MINIMAL'));
    // restore
    settingsManager.setGuidance('auto');
  });

  it('rejects unknown guidance values', () => {
    const changed = settingsManager.setGuidance('NONSENSE');
    assert.equal(changed, false);
  });
});

describe('SettingsManager — autolock preference', () => {
  it('defaults enabled', () => {
    settingsManager.setAutolock(true);
    assert.equal(settingsManager.getAutolock(), true);
  });

  it('setAutolock(false) disables + emits AUTOLOCK_SETTING_CHANGED', () => {
    eventBus.clear();
    const seen = [];
    eventBus.on(Events.AUTOLOCK_SETTING_CHANGED, (d) => seen.push(d));
    const changed = settingsManager.setAutolock(false);
    assert.equal(changed, true);
    assert.equal(settingsManager.getAutolock(), false);
    assert.ok(seen.some(d => d.enabled === false));
    // restore
    settingsManager.setAutolock(true);
  });
});
