/**
 * test-no-tutorial-legacy.js — Sprint 3: Verify TutorialSystem is fully removed.
 *
 * Grep-style assertion tests ensuring no source file imports, emits, or
 * references TutorialSystem after its deletion.
 *
 * Node-safe: filesystem checks only.
 */
import { describe, it, assert } from './TestRunner.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = path.resolve(__dirname, '..');

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, files);
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

describe('No Tutorial Legacy', () => {

    it('TutorialSystem.js does not exist', () => {
        const p = path.join(jsRoot, 'systems', 'TutorialSystem.js');
        assert.ok(!fs.existsSync(p), 'TutorialSystem.js must be deleted');
    });

    it('No source file imports TutorialSystem', () => {
        const files = walk(jsRoot).filter(f => !f.includes('/test/'));
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            assert.ok(!/from\s+['"][^'"]*TutorialSystem[^'"]*['"]/.test(src),
                `${path.relative(jsRoot, f)} still imports TutorialSystem`);
        }
    });

    it('No source file emits TUTORIAL_STAGE_CHANGED', () => {
        const files = walk(jsRoot).filter(f => !f.includes('/test/') && !f.endsWith('Events.js'));
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            assert.ok(!/eventBus\.emit\([^)]*TUTORIAL_STAGE_CHANGED/.test(src),
                `${path.relative(jsRoot, f)} still emits TUTORIAL_STAGE_CHANGED`);
        }
    });

    it('No source file has _tutorialStage field', () => {
        const files = walk(jsRoot).filter(f => !f.includes('/test/'));
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            assert.ok(!/_tutorialStage/.test(src),
                `${path.relative(jsRoot, f)} still has _tutorialStage`);
        }
    });

    it('No source file has _tutorialBlocksAutopilot field', () => {
        const files = walk(jsRoot).filter(f => !f.includes('/test/'));
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            assert.ok(!/_tutorialBlocksAutopilot/.test(src),
                `${path.relative(jsRoot, f)} still has _tutorialBlocksAutopilot`);
        }
    });
});
