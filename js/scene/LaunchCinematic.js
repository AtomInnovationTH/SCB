/**
 * LaunchCinematic.js — Visual effects driver for the launch sequence.
 *
 * Subscribes to LaunchSequence (`Events.LAUNCH_PHASE_CHANGED`,
 * `Events.LAUNCH_LOCK_RELEASED`) and renders the cinematic dressing:
 *
 *   • Translucent fairing halves enclosing the stowed spacecraft
 *   • Orange liftoff exhaust glow (PointLight under -Z face)
 *   • Lateral fairing-jettison animation w/ tumble + opacity fade
 *   • Per-arm pyro flash (white PointLight + LED flash) on lock release
 *   • FEEP main-thruster plume opacity ramp during ORBIT_INSERTION
 *   • ROSA panel emissive ramp at POWER_NOMINAL
 *
 * Feature-flag gated — completely inert when
 * `Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE` is false.
 *
 * All real-world distances are converted via `M = 1e-5` (scene units / metre).
 *
 * @module scene/LaunchCinematic
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** 1 metre in scene units (matches AutopilotSystem & PlayerSatellite). */
const M = 1e-5;

/** Fairing lateral separation velocity (m/s). */
const FAIRING_SEP_VEL = 2.0;
/** Fairing tumble rate (rad/s). */
const FAIRING_TUMBLE = 0.5;
/** Fairing fade-out duration (s). */
const FAIRING_FADE_S = 4.0;
/** FEEP plume terminal opacity (matches PlayerSatellite default). */
const FEEP_TERMINAL_OPACITY = 0.3;
/** ORBIT_INSERTION phase length (s) — matches Constants.LAUNCH_PYRO_DELAY. */
const FEEP_RAMP_DURATION_S = 40.0;
/** ROSA panel base / nominal emissive intensities. */
const ROSA_EMISSIVE_BASE = 0.15;
const ROSA_EMISSIVE_NOMINAL = 0.4;
/** Pyro flash lifetime (s). */
const PYRO_FLASH_LIFETIME_S = 0.3;

export class LaunchCinematic {
    constructor() {
        this._scene = null;
        this._player = null;
        this._sceneManager = null;
        this._enabled = false;
        this._disposed = false;

        // Fairing state
        this._fairingLeft = null;
        this._fairingRight = null;
        this._fairingSepTimer = 0;
        this._fairingSeparating = false;

        // Liftoff exhaust glow
        this._liftoffLight = null;

        // FEEP plume ramp
        this._feepRampActive = false;
        this._feepProgress = 0;

        // Per-arm pyro flashes — { light, led, prevColor, prevEmissive, timer }
        this._pyroFlashes = [];

        // EventBus unsubscribe handles
        this._unsubPhase = null;
        this._unsubLock = null;
    }

    // ------------------------------------------------------------------
    // INIT / DISPOSE
    // ------------------------------------------------------------------

    /**
     * Initialise the cinematic. No-op when feature flag is disabled.
     * @param {THREE.Scene} scene — root scene (used for any world-space FX)
     * @param {THREE.Object3D} player — PlayerSatellite group
     * @param {import('./SceneManager.js').SceneManager} [sceneManager] — optional;
     *   used to enroll the liftoff/pyro PointLights in the near-field depth pass
     *   so their falloff cutoff is scaled into the ×S sub-render and they keep
     *   lighting the hull during launch (z-layer fix).
     */
    init(scene, player, sceneManager = null) {
        if (!Constants.FEATURE_FLAGS || !Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) {
            this._enabled = false;
            return;
        }
        this._scene = scene;
        this._player = player;
        this._sceneManager = sceneManager || null;
        this._enabled = true;
        this._disposed = false;

        try { this._buildFairing(); } catch (e) {
            console.error('[LaunchCinematic] _buildFairing:', e);
        }

        // Bind handlers so we can unsubscribe symmetrically
        this._onPhaseChangedBound = (p) => this._onPhaseChanged(p || {});
        this._onLockReleasedBound = (p) => this._onLockReleased(p || {});
        this._unsubPhase = eventBus.on(Events.LAUNCH_PHASE_CHANGED, this._onPhaseChangedBound);
        this._unsubLock = eventBus.on(Events.LAUNCH_LOCK_RELEASED, this._onLockReleasedBound);
    }

    dispose() {
        if (this._unsubPhase) { this._unsubPhase(); this._unsubPhase = null; }
        if (this._unsubLock)  { this._unsubLock();  this._unsubLock  = null; }
        this._disposeFairing();
        this._disposeLiftoffLight();
        this._clearPyroFlashes();
        this._enabled = false;
        this._disposed = true;
    }

    // ------------------------------------------------------------------
    // FAIRING CONSTRUCTION
    // ------------------------------------------------------------------

    _buildFairing() {
        if (!this._player) return;
        const V5 = Constants.OCTOPUS_V5 || {};
        const fairingD = (V5.FAIRING_DIAMETER || 2.1);
        const fairingL = (V5.FAIRING_LENGTH || 2.5);
        const collarY  = (V5.COLLAR_Y || 0.90);

        const radius = (fairingD * 0.5) * M;
        const height = fairingL * M;
        // Centre fairing on barrel: from collar (~0.9 m) up by half its length.
        const centreY = (collarY + (fairingL * 0.5)) * M;

        const matLeft = new THREE.MeshStandardMaterial({
            color: 0xcccccc,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            metalness: 0.3,
            roughness: 0.7,
        });
        const matRight = matLeft.clone();

        // ConeGeometry: (radiusTop, radiusBottom, height, radialSegs, heightSegs, openEnded, thetaStart, thetaLength)
        const geomLeft  = new THREE.ConeGeometry(0, radius, height, 16, 1, false, 0, Math.PI);
        const geomRight = new THREE.ConeGeometry(0, radius, height, 16, 1, false, Math.PI, Math.PI);

        this._fairingLeft  = new THREE.Mesh(geomLeft,  matLeft);
        this._fairingRight = new THREE.Mesh(geomRight, matRight);

        this._fairingLeft.name  = 'LaunchFairing_Left';
        this._fairingRight.name = 'LaunchFairing_Right';

        // Spacecraft "up" axis is +Z (per PlayerSatellite frame). ConeGeometry
        // is built around +Y; rotate -90° about X to align cone-axis with +Z.
        for (const half of [this._fairingLeft, this._fairingRight]) {
            half.rotation.x = -Math.PI / 2;
            half.position.set(0, 0, centreY);
            half.renderOrder = 2;
            this._player.add(half);
        }
    }

    _disposeFairing() {
        for (const key of ['_fairingLeft', '_fairingRight']) {
            const m = this[key];
            if (m) {
                if (m.parent) m.parent.remove(m);
                if (m.geometry) m.geometry.dispose();
                if (m.material) m.material.dispose();
                this[key] = null;
            }
        }
    }

    _disposeLiftoffLight() {
        if (this._liftoffLight) {
            if (this._sceneManager && typeof this._sceneManager.unregisterNearFieldLight === 'function') {
                this._sceneManager.unregisterNearFieldLight(this._liftoffLight);
            }
            if (this._liftoffLight.parent) this._liftoffLight.parent.remove(this._liftoffLight);
            this._liftoffLight = null;
        }
    }

    // ------------------------------------------------------------------
    // EVENT HANDLERS
    // ------------------------------------------------------------------

    _onPhaseChanged(payload) {
        if (!this._enabled) return;
        const toPhase = payload.toPhase;
        switch (toPhase) {
            case 'LIFTOFF':
                this._beginLiftoff();
                break;
            case 'FAIRING_SEPARATION':
                this._beginFairingSeparation();
                break;
            case 'ORBIT_INSERTION':
                this._beginFeepRamp();
                break;
            case 'LAUNCH_LOCK_RELEASE':
                // per-arm — handled in _onLockReleased
                break;
            case 'ROSA_DEPLOY_PRIMARY':
            case 'ROSA_DEPLOY_SECONDARY':
                // No-op — PlayerSatellite._updateRosaPanels handles geometry roll-out.
                break;
            case 'POWER_NOMINAL':
                this._rampRosaEmissive(ROSA_EMISSIVE_NOMINAL);
                break;
            case 'READY':
                this._disposeFairing();
                this._disposeLiftoffLight();
                this._enabled = false;
                break;
            default:
                break;
        }
    }

    _beginLiftoff() {
        if (!this._player) return;
        // Orange exhaust glow attached to the player group, offset along -Z
        // (spacecraft tail in PlayerSatellite frame).
        const light = new THREE.PointLight(0xff6600, 2, M * 50);
        light.position.set(0, 0, -(Constants.OCTOPUS_V5?.CORE_LENGTH || 2.0) * M * 0.5);
        light.name = 'LiftoffExhaustGlow';
        this._player.add(light);
        this._liftoffLight = light;
        // z-layer fix: scale this ship-child light's `distance` cutoff into ×S
        // space during the near render so it still reaches the (S× larger) hull.
        if (this._sceneManager && typeof this._sceneManager.registerNearFieldLight === 'function') {
            this._sceneManager.registerNearFieldLight(light);
        }
    }

    _beginFairingSeparation() {
        this._fairingSeparating = true;
        this._fairingSepTimer = 0;
        // Liftoff exhaust no longer relevant — fairings are separating in vac.
        this._disposeLiftoffLight();
    }

    _beginFeepRamp() {
        this._feepRampActive = true;
        this._feepProgress = 0;
    }

    _rampRosaEmissive(target) {
        if (!this._player) return;
        const setEmissive = (group) => {
            if (!group || typeof group.traverse !== 'function') return;
            group.traverse((obj) => {
                if (obj.material && obj.material.emissive !== undefined) {
                    obj.material.emissiveIntensity = target;
                }
            });
        };
        setEmissive(this._player.panelRightPivot);
        setEmissive(this._player.panelLeftPivot);
    }

    _onLockReleased(payload) {
        if (!this._enabled || !this._player) return;
        const idx = payload.armIndex;
        const leds = this._player.hingeLEDs;
        if (!leds || idx == null || !leds[idx]) return;
        const led = leds[idx];

        // Capture original colour / emissive so we can restore on flash decay.
        let prevColor = null;
        let prevEmissive = 0;
        if (led.material) {
            if (led.material.color && typeof led.material.color.getHex === 'function') {
                prevColor = led.material.color.getHex();
                if (typeof led.material.color.set === 'function') {
                    led.material.color.set(0xffffff);
                }
            }
            if (led.material.emissiveIntensity !== undefined) {
                prevEmissive = led.material.emissiveIntensity;
                led.material.emissiveIntensity = 2.0;
            }
        }

        // Brief white PointLight at the LED's local position.
        const flashLight = new THREE.PointLight(0xffffff, 3, M * 20);
        if (led.position) {
            flashLight.position.copy(led.position);
        }
        flashLight.name = `PyroFlash_${idx}`;
        const parent = led.parent || this._player;
        parent.add(flashLight);
        // z-layer fix: scale this ship-child light's cutoff into ×S space.
        if (this._sceneManager && typeof this._sceneManager.registerNearFieldLight === 'function') {
            this._sceneManager.registerNearFieldLight(flashLight);
        }

        this._pyroFlashes.push({
            light: flashLight,
            led,
            prevColor,
            prevEmissive,
            timer: PYRO_FLASH_LIFETIME_S,
        });
    }

    // ------------------------------------------------------------------
    // FRAME UPDATE
    // ------------------------------------------------------------------

    update(dt) {
        if (!this._enabled) return;

        // --- Fairing separation ---
        if (this._fairingSeparating) {
            this._fairingSepTimer += dt;
            const dx = M * FAIRING_SEP_VEL * dt;
            if (this._fairingLeft) {
                this._fairingLeft.position.x += dx;
                this._fairingLeft.rotation.z += FAIRING_TUMBLE * dt;
                if (this._fairingLeft.material) {
                    this._fairingLeft.material.opacity =
                        Math.max(0, 0.3 * (1 - this._fairingSepTimer / FAIRING_FADE_S));
                }
            }
            if (this._fairingRight) {
                this._fairingRight.position.x -= dx;
                this._fairingRight.rotation.z -= FAIRING_TUMBLE * dt;
                if (this._fairingRight.material) {
                    this._fairingRight.material.opacity =
                        Math.max(0, 0.3 * (1 - this._fairingSepTimer / FAIRING_FADE_S));
                }
            }
            if (this._fairingSepTimer >= FAIRING_FADE_S) {
                this._disposeFairing();
                this._fairingSeparating = false;
            }
        }

        // --- FEEP plume ramp ---
        if (this._feepRampActive) {
            this._feepProgress += dt / FEEP_RAMP_DURATION_S;
            if (this._feepProgress >= 1.0) {
                this._feepProgress = 1.0;
                this._feepRampActive = false;
            }
            const plumes = this._player && this._player.mainThrusterPlumes;
            if (plumes && plumes.length) {
                const op = FEEP_TERMINAL_OPACITY * this._feepProgress;
                for (const plume of plumes) {
                    if (plume && plume.material) {
                        plume.material.opacity = op;
                    }
                }
            }
        }

        // --- Pyro flash decay ---
        if (this._pyroFlashes.length) {
            for (let i = this._pyroFlashes.length - 1; i >= 0; i--) {
                const flash = this._pyroFlashes[i];
                flash.timer -= dt;
                if (flash.timer <= 0) {
                    if (this._sceneManager && typeof this._sceneManager.unregisterNearFieldLight === 'function') {
                        this._sceneManager.unregisterNearFieldLight(flash.light);
                    }
                    if (flash.light && flash.light.parent) flash.light.parent.remove(flash.light);
                    if (flash.led && flash.led.material) {
                        if (flash.prevColor != null && flash.led.material.color
                            && typeof flash.led.material.color.set === 'function') {
                            flash.led.material.color.set(flash.prevColor);
                        }
                        if (flash.led.material.emissiveIntensity !== undefined) {
                            flash.led.material.emissiveIntensity = flash.prevEmissive;
                        }
                    }
                    this._pyroFlashes.splice(i, 1);
                }
            }
        }
    }

    _clearPyroFlashes() {
        for (const flash of this._pyroFlashes) {
            if (this._sceneManager && typeof this._sceneManager.unregisterNearFieldLight === 'function') {
                this._sceneManager.unregisterNearFieldLight(flash.light);
            }
            if (flash.light && flash.light.parent) flash.light.parent.remove(flash.light);
            if (flash.led && flash.led.material) {
                if (flash.prevColor != null && flash.led.material.color
                    && typeof flash.led.material.color.set === 'function') {
                    flash.led.material.color.set(flash.prevColor);
                }
                if (flash.led.material.emissiveIntensity !== undefined) {
                    flash.led.material.emissiveIntensity = flash.prevEmissive;
                }
            }
        }
        this._pyroFlashes.length = 0;
    }

    // ------------------------------------------------------------------
    // SKIP / FAST-FORWARD
    // ------------------------------------------------------------------

    /**
     * Snap all visual effects to their READY-state values: dispose fairing,
     * set plume opacity to terminal, set ROSA emissive to nominal, clear flashes.
     */
    skipToReady() {
        this._disposeFairing();
        this._disposeLiftoffLight();
        this._clearPyroFlashes();
        this._fairingSeparating = false;
        this._feepRampActive = false;
        this._feepProgress = 1.0;

        const plumes = this._player && this._player.mainThrusterPlumes;
        if (plumes && plumes.length) {
            for (const plume of plumes) {
                if (plume && plume.material) plume.material.opacity = FEEP_TERMINAL_OPACITY;
            }
        }
        this._rampRosaEmissive(ROSA_EMISSIVE_NOMINAL);
        this._enabled = false;
    }
}

/** Singleton instance — match codebase convention. */
export const launchCinematic = new LaunchCinematic();
export default launchCinematic;
