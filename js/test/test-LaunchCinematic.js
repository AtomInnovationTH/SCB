/**
 * test-LaunchCinematic.js — V-7 cinematic visual driver
 *
 * Verifies the LaunchCinematic state-machine logic without exercising the full
 * THREE.js render pipeline. The module imports THREE for geometry + lights, but
 * its phase / event handlers are pure logic that can be driven via mock player
 * objects (mainThrusterPlumes, hingeLEDs, panel*Pivot).
 */

import { describe, it, assert } from './TestRunner.js';
import { LaunchCinematic } from '../scene/LaunchCinematic.js';
import { Constants } from '../core/Constants.js';

// --- helpers ---------------------------------------------------------------

function makeMockPlayer() {
    // Minimal THREE.Object3D-compatible stub. The module only calls
    // `player.add(child)` from `_buildFairing` / `_beginLiftoff`, plus
    // child.parent for cleanup, so we mimic that contract.
    const player = {
        children: [],
        add(child) { child.parent = player; this.children.push(child); },
        remove(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
            if (child.parent === player) child.parent = null;
        },
        // PlayerSatellite properties touched by the cinematic
        hingeLEDs: [],
        mainThrusterPlumes: [],
        panelRightPivot: null,
        panelLeftPivot:  null,
    };
    return player;
}

function makeMockLed() {
    return {
        position: { x: 0, y: 0, z: 0, copy(p){ this.x=p.x; this.y=p.y; this.z=p.z; } },
        material: {
            color: {
                _hex: 0x00ff00,
                getHex() { return this._hex; },
                set(h) { this._hex = (typeof h === 'number') ? h : 0xffffff; },
            },
            emissiveIntensity: 0.5,
        },
        parent: null,
    };
}

function makeMockPlume() {
    return { material: { opacity: 0 } };
}

function withFlag(value, fn) {
    const prev = Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE;
    Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE = value;
    try { fn(); } finally { Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE = prev; }
}

// --- suites ----------------------------------------------------------------

describe('LaunchCinematic — feature-flag gating', () => {
    it('init does nothing when LAUNCH_SEQUENCE flag is false', () => {
        withFlag(false, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            assert.equal(lc._enabled, false, 'cinematic must remain inert');
            assert.equal(lc._fairingLeft, null, 'no fairing when flag off');
        });
    });

    it('init enables when LAUNCH_SEQUENCE flag is true', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            assert.equal(lc._enabled, true, 'cinematic enabled when flag on');
            lc.dispose();
        });
    });
});

describe('LaunchCinematic — phase handlers', () => {
    it('_onPhaseChanged to FAIRING_SEPARATION starts separation', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            lc._onPhaseChanged({ fromPhase: 'LIFTOFF', toPhase: 'FAIRING_SEPARATION' });
            assert.equal(lc._fairingSeparating, true);
            assert.equal(lc._fairingSepTimer, 0);
            lc.dispose();
        });
    });

    it('_onPhaseChanged to ORBIT_INSERTION activates FEEP ramp', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            lc._onPhaseChanged({ fromPhase: 'FAIRING_SEPARATION', toPhase: 'ORBIT_INSERTION' });
            assert.equal(lc._feepRampActive, true);
            assert.equal(lc._feepProgress, 0);
            lc.dispose();
        });
    });

    it('_onPhaseChanged to LIFTOFF attaches an exhaust glow', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            const player = makeMockPlayer();
            lc.init({ add() {} }, player);
            lc._onPhaseChanged({ fromPhase: 'STOWED_IN_FAIRING', toPhase: 'LIFTOFF' });
            assert.ok(lc._liftoffLight !== null, 'liftoff light created');
            lc.dispose();
        });
    });

    it('_onPhaseChanged to READY disables cinematic', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            lc._onPhaseChanged({ fromPhase: 'POWER_NOMINAL', toPhase: 'READY' });
            assert.equal(lc._enabled, false);
            assert.equal(lc._fairingLeft, null, 'fairing disposed at READY');
        });
    });

    it('_onPhaseChanged to POWER_NOMINAL ramps ROSA emissive on panel pivots', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            const player = makeMockPlayer();

            // Build a tiny pivot tree for both wings — each contains one mesh
            // with an emissive material. The cinematic's traverse() callback
            // should mutate each material.emissiveIntensity to 0.4.
            const makePivot = () => {
                const meshes = [
                    { material: { emissive: 1, emissiveIntensity: 0.15 } },
                    { material: { emissive: 1, emissiveIntensity: 0.15 } },
                ];
                return {
                    traverse(cb) { cb(this); meshes.forEach(cb); },
                    _meshes: meshes,
                };
            };
            player.panelRightPivot = makePivot();
            player.panelLeftPivot  = makePivot();

            lc.init({ add() {} }, player);
            lc._onPhaseChanged({ fromPhase: 'ROSA_DEPLOY_SECONDARY', toPhase: 'POWER_NOMINAL' });

            for (const m of player.panelRightPivot._meshes) {
                assert.closeTo(m.material.emissiveIntensity, 0.4, 1e-6);
            }
            for (const m of player.panelLeftPivot._meshes) {
                assert.closeTo(m.material.emissiveIntensity, 0.4, 1e-6);
            }
            lc.dispose();
        });
    });
});

describe('LaunchCinematic — lock release', () => {
    it('_onLockReleased creates a pyro flash entry', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            const player = makeMockPlayer();
            const led = makeMockLed();
            led.parent = player; // simulate LED attached to the player group
            player.hingeLEDs = [led];
            lc.init({ add() {} }, player);

            lc._onLockReleased({ armIndex: 0 });
            assert.equal(lc._pyroFlashes.length, 1, 'one flash queued');
            assert.equal(led.material.color._hex, 0xffffff, 'LED set white');
            assert.closeTo(led.material.emissiveIntensity, 2.0, 1e-6);
            lc.dispose();
        });
    });

    it('pyro flash decays and restores LED on update', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            const player = makeMockPlayer();
            const led = makeMockLed();
            led.material.color._hex = 0x33ff33;
            const origEm = led.material.emissiveIntensity;
            led.parent = player;
            player.hingeLEDs = [led];
            lc.init({ add() {} }, player);

            lc._onLockReleased({ armIndex: 0 });
            // Advance well past PYRO_FLASH_LIFETIME_S (0.3s)
            lc.update(1.0);
            assert.equal(lc._pyroFlashes.length, 0, 'flash cleared');
            assert.equal(led.material.color._hex, 0x33ff33, 'LED colour restored');
            assert.closeTo(led.material.emissiveIntensity, origEm, 1e-6);
            lc.dispose();
        });
    });
});

describe('LaunchCinematic — update loop', () => {
    it('update advances fairing separation timer', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            lc._fairingSeparating = true;
            lc._fairingSepTimer = 0;
            lc.update(1.0);
            assert.closeTo(lc._fairingSepTimer, 1.0, 1e-6);
            lc.dispose();
        });
    });

    it('update completes fairing separation after 4s', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            lc.init({ add() {} }, makeMockPlayer());
            lc._fairingSeparating = true;
            lc._fairingSepTimer = 3.5;
            lc.update(1.0); // 3.5 + 1.0 = 4.5 → past threshold
            assert.equal(lc._fairingSeparating, false, 'separation flag cleared');
            assert.equal(lc._fairingLeft, null, 'fairing disposed');
            assert.equal(lc._fairingRight, null);
            lc.dispose();
        });
    });

    it('update ramps FEEP plume opacity proportionally to phase progress', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            const player = makeMockPlayer();
            const plume = makeMockPlume();
            player.mainThrusterPlumes = [plume];
            lc.init({ add() {} }, player);

            lc._feepRampActive = true;
            lc._feepProgress = 0;
            // 20s of a 40s phase → progress 0.5 → opacity 0.15
            lc.update(20.0);
            assert.closeTo(plume.material.opacity, 0.15, 1e-3);
            // Finish — opacity reaches 0.3, ramp clears
            lc.update(25.0);
            assert.equal(lc._feepRampActive, false);
            assert.closeTo(plume.material.opacity, 0.3, 1e-3);
            lc.dispose();
        });
    });

    it('update is a no-op when not _enabled', () => {
        const lc = new LaunchCinematic();
        // Never init'd → disabled
        lc._fairingSeparating = true;
        lc._fairingSepTimer = 0;
        lc.update(1.0);
        assert.equal(lc._fairingSepTimer, 0, 'timer untouched when disabled');
    });
});

describe('LaunchCinematic — skipToReady', () => {
    it('skipToReady clears all state and locks plumes/ROSA at terminal values', () => {
        withFlag(true, () => {
            const lc = new LaunchCinematic();
            const player = makeMockPlayer();
            const plume = makeMockPlume();
            player.mainThrusterPlumes = [plume];
            const meshes = [{ material: { emissive: 1, emissiveIntensity: 0.15 } }];
            player.panelRightPivot = {
                traverse(cb) { cb(this); meshes.forEach(cb); },
            };
            lc.init({ add() {} }, player);
            lc._fairingSeparating = true;
            lc._feepRampActive = true;
            lc._pyroFlashes.push({
                light: { parent: null },
                led: null,
                prevColor: null,
                prevEmissive: 0,
                timer: 0.2,
            });

            lc.skipToReady();
            assert.equal(lc._enabled, false);
            assert.equal(lc._fairingSeparating, false);
            assert.equal(lc._feepRampActive, false);
            assert.equal(lc._pyroFlashes.length, 0);
            assert.closeTo(plume.material.opacity, 0.3, 1e-6);
            assert.closeTo(meshes[0].material.emissiveIntensity, 0.4, 1e-6);
        });
    });
});
