/**
 * test-hud-activate-keys.js — ST-3.3: Dormant panel corner-glyph affordance.
 *
 * Grep-style assertions verifying data-activate-key attributes are set
 * on the correct HUD panels and the CSS rule exists in HUD.js.
 *
 * Node-safe: filesystem checks only.
 */
import { describe, it, assert } from './TestRunner.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..', 'ui');

describe('ST-3.3 HUD Activate Keys', () => {

    const statusSrc = fs.readFileSync(path.join(uiRoot, 'hud', 'StatusPanel.js'), 'utf8');
    const targetSrc = fs.readFileSync(path.join(uiRoot, 'hud', 'TargetPanel.js'), 'utf8');
    const hudSrc    = fs.readFileSync(path.join(uiRoot, 'HUD.js'), 'utf8');

    it('StatusPanel sets activateKey on fuel-group', () => {
        assert.ok(/activateKey\s*=\s*'A'/.test(statusSrc), 'fuel-group should have activateKey A');
    });

    it('StatusPanel sets activateKey on arms-group', () => {
        assert.ok(/activateKey\s*=\s*'D'/.test(statusSrc), 'arms-group should have activateKey D');
    });

    it('TargetPanel sets activateKey on target-list', () => {
        assert.ok(/activateKey\s*=\s*'S'/.test(targetSrc), 'target-list should have activateKey S');
    });

    it('HUD.js sets activateKey on target-detail', () => {
        assert.ok(/activateKey\s*=\s*'Tab'/.test(hudSrc), 'target-detail should have activateKey Tab');
    });

    it('HUD.js contains dormant keycap ::after CSS rule', () => {
        assert.ok(/\.hud-dormant\[data-activate-key\]::after/.test(hudSrc),
            'CSS must include .hud-dormant[data-activate-key]::after selector');
    });

    it('HUD.js contains hud-keycap-pulse keyframe', () => {
        assert.ok(/hud-keycap-pulse/.test(hudSrc),
            'CSS must include hud-keycap-pulse keyframe');
    });
});

describe('HUD codex unlock toast — source guards', () => {
    // HUD is not instantiated in the Node suite (its constructor builds heavy
    // DOM), so these are grep-style guards matching this file's precedent.
    // Behavior (coalesce / viewer-open suppression / placement) is verified by
    // the Playwright spot-check.
    const hudSrc = fs.readFileSync(path.join(uiRoot, 'HUD.js'), 'utf8');

    it('subscribes to CODEX_UNLOCKED', () => {
        assert.ok(/Events\.CODEX_UNLOCKED/.test(hudSrc),
            'HUD must listen for CODEX_UNLOCKED');
    });

    it('defines showCodexUnlockToast', () => {
        assert.ok(/showCodexUnlockToast\s*\(/.test(hudSrc),
            'HUD must define showCodexUnlockToast');
    });

    it('consumes the CODEX.NOTIFICATION_DURATION constant', () => {
        assert.ok(/Constants\.CODEX\.NOTIFICATION_DURATION/.test(hudSrc),
            'toast duration must derive from NOTIFICATION_DURATION');
    });

    it('suppresses the toast while the codex viewer is open', () => {
        assert.ok(/codex-overlay/.test(hudSrc),
            'toast must probe the codex viewer overlay to suppress-when-open');
    });

    it('is non-interactive (pointer-events:none)', () => {
        assert.ok(/hud-codex-toast/.test(hudSrc), 'toast element has its own class');
        assert.ok(/pointer-events:\s*none/.test(hudSrc),
            'toast must be non-interactive like the mastery toast');
    });
});
