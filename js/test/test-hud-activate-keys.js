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

describe('HUD codex unlock — stays out of the flight view', () => {
    // User-facing rule: no popups over the flight HUD. Codex unlock feedback
    // lives on the Discoveries pane (SkillsPane, TECH_UNLOCKED) + the audio
    // chime (AudioSystem, CODEX_UNLOCKED) — never a center-screen toast. These
    // inverted grep-style guards (this file's precedent) lock that in against
    // regression of the removed showCodexUnlockToast popup.
    const hudSrc = fs.readFileSync(path.join(uiRoot, 'HUD.js'), 'utf8');

    it('does not subscribe to CODEX_UNLOCKED', () => {
        assert.ok(!/Events\.CODEX_UNLOCKED/.test(hudSrc),
            'HUD must not listen for CODEX_UNLOCKED; unlock feedback belongs to the Discoveries pane + chime');
    });

    it('defines no showCodexUnlockToast method', () => {
        assert.ok(!/showCodexUnlockToast/.test(hudSrc),
            'HUD must not define a codex unlock toast');
    });

    it('renders no toast element over the flight view', () => {
        assert.ok(!/hud-codex-toast/.test(hudSrc),
            'no codex toast element class may exist in the HUD');
    });
});
