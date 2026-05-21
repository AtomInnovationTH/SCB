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
