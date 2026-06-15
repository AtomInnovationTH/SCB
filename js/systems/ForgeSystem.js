/**
 * ForgeSystem — Electromagnetic Levitation Melting (EML) furnace.
 * Based on ISS TEMPUS facility (TRL 8-9). Processes salvaged metals
 * from CargoSystem into refined ingots or propellant slugs.
 * 
 * State machine: IDLE → INTAKE → SEPARATE → MELT → COOL → IDLE
 * 
 * Outputs:
 *   - 'refine' mode: produces refined ingots (2.5× market value, same mass)
 *   - 'propellant' mode: produces propellant slugs (85% mass, usable as fuel)
 * 
 * @module systems/ForgeSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const FORGE = Constants.FORGE;

const PHASES = ['IDLE', 'INTAKE', 'SEPARATE', 'MELT', 'COOL'];

export class ForgeSystem {
    constructor(cargoSystem, resourceSystem) {
        this._cargo = cargoSystem;
        this._resources = resourceSystem;

        this._phase = 'IDLE';
        this._phaseTimer = 0;
        this._phaseDuration = 0;

        // Current batch being processed
        this._currentBatch = null;  // { metalId, name, massKg, outputMode, meltPointScale }

        // Processing queue
        this._queue = [];  // array of { metalId, massKg, outputMode: 'refine'|'propellant' }

        // Output buffer (completed items awaiting collection)
        this._outputBuffer = [];

        // ST-8.3.5: Refined FEEP metals inventory (metal → kg)
        this.refinedMetals = {};

        // Stats
        this._totalProcessedKg = 0;
        this._totalBatches = 0;

        this._setupListeners();
    }

    _setupListeners() {
        eventBus.on(Events.FORGE_QUEUE_ADD, (data) => this.queueBatch(data));
        eventBus.on(Events.FORGE_CANCEL, () => this.cancel());
        eventBus.on(Events.FORGE_TOGGLE, () => this.toggle());
    }

    /**
     * Toggle forge mode: OFF → REFINE → PROPELLANT → OFF
     * K key cycles through modes ("Kiln"; rebound from R on 2026-05-28
     * because R now drives reel-in via InputManager).  Auto-starts with the
     * heaviest available metal.
     */
    toggle() {
        const isActive = this._phase !== 'IDLE';

        if (!isActive) {
            // OFF → start forge in REFINE mode with heaviest metal in cargo
            const manifest = this._cargo.getManifest();
            const metals = manifest.filter(m => m.massKg > 0 && !m.metalId.startsWith('refined_') && !m.metalId.startsWith('prop_'));
            if (metals.length === 0) {
                eventBus.emit(Events.COMMS_MESSAGE, {
                    sender: 'FORGE', text: 'No raw metals in cargo to process', priority: 'warning'
                });
                return;
            }
            // Pick heaviest metal
            metals.sort((a, b) => b.massKg - a.massKg);
            const heaviest = metals[0];
            this.queueBatch({
                metalId: heaviest.metalId,
                massKg: heaviest.massKg,
                outputMode: 'refine',
            });
        } else if (this._currentBatch && this._currentBatch.outputMode === 'refine') {
            // REFINE → switch to PROPELLANT mode (same batch continues)
            this._currentBatch.outputMode = 'propellant';
            eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'FORGE',
                text: `Switched to PROPELLANT mode`,
                priority: 'info'
            });
            this._emitStateUpdate();
        } else {
            // PROPELLANT → OFF (cancel with partial loss)
            this.cancel();
        }
    }

    /** @private Emit current state for HUD updates */
    _emitStateUpdate() {
        eventBus.emit(Events.FORGE_PHASE_CHANGE, {
            phase: this._phase,
            duration: this._phaseDuration,
            batch: this._currentBatch,
        });
    }

    /**
     * Queue a batch for processing.
     * @param {object} data - { metalId, massKg, outputMode: 'refine'|'propellant' }
     */
    queueBatch(data) {
        const { metalId, massKg, outputMode = 'refine' } = data;

        // Validate
        const manifest = this._cargo.getManifest();
        const cargoItem = manifest.find(m => m.metalId === metalId);
        if (!cargoItem || cargoItem.massKg < massKg) {
            eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'FORGE', text: `Insufficient ${metalId} in cargo`, priority: 'warning'
            });
            return false;
        }

        const batchMass = Math.min(massKg, FORGE.BATCH_SIZE_KG);

        // Find metal definition for melt point scaling
        const metalDef = Object.values(Constants.METALS).find(m => m.id === metalId);
        let meltPointScale = 'medium';
        if (metalDef) {
            const mp = metalDef.meltPoint;
            if (mp < 500) meltPointScale = 'low';
            else if (mp < 1500) meltPointScale = 'medium';
            else if (mp < 2000) meltPointScale = 'high';
            else meltPointScale = 'extreme';
        }

        this._queue.push({
            metalId,
            name: metalDef ? metalDef.name : metalId,
            massKg: batchMass,
            outputMode,
            meltPointScale,
            ispAsThrust: metalDef ? metalDef.ispAsThrust : 0,
            marketValue: metalDef ? metalDef.marketValue : 0,
            color: metalDef ? metalDef.color : '#CCC',
        });

        eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'FORGE',
            text: `Queued ${batchMass.toFixed(1)}kg ${metalDef ? metalDef.name : metalId} → ${outputMode}`,
            priority: 'info'
        });

        // Auto-start if idle
        if (this._phase === 'IDLE') {
            this._startNextBatch();
        }

        return true;
    }

    _startNextBatch() {
        if (this._queue.length === 0) {
            this._phase = 'IDLE';
            this._currentBatch = null;
            return;
        }

        const batch = this._queue.shift();

        // Remove metal from cargo
        const removed = this._cargo.removeMetal(batch.metalId, batch.massKg);
        if (removed < 0.01) {
            eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'FORGE', text: `${batch.name} no longer in cargo. Skipping`, priority: 'warning'
            });
            this._startNextBatch(); // Try next
            return;
        }

        batch.massKg = removed; // actual amount removed
        this._currentBatch = batch;
        this._transitionTo('INTAKE');

        eventBus.emit(Events.FORGE_START, {
            metalId: batch.metalId,
            name: batch.name,
            massKg: batch.massKg,
            outputMode: batch.outputMode,
        });

        eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'FORGE',
            text: `Processing ${batch.massKg.toFixed(1)}kg ${batch.name}...`,
            priority: 'info'
        });
    }

    _transitionTo(phase) {
        this._phase = phase;
        const timeScale = FORGE.MELT_POINT_TIME_SCALE[this._currentBatch.meltPointScale] || 1.0;

        if (phase === 'IDLE') {
            this._phaseTimer = 0;
            this._phaseDuration = 0;
        } else {
            const baseTime = FORGE.PHASE_TIMES[phase] || 5;
            // Only MELT phase is affected by melt point scaling
            this._phaseDuration = phase === 'MELT' ? baseTime * timeScale : baseTime;
            this._phaseTimer = 0;
        }

        eventBus.emit(Events.FORGE_PHASE_CHANGE, {
            phase,
            duration: this._phaseDuration,
            batch: this._currentBatch,
        });
    }

    /**
     * Main update loop. Call each frame.
     * @param {number} dt - delta time in seconds
     */
    update(dt) {
        if (this._phase === 'IDLE') return;
        if (!this._currentBatch) return;

        // Check power availability during MELT phase
        if (this._phase === 'MELT' || this._phase === 'SEPARATE') {
            const powerNeeded = FORGE.POWER_DRAW * dt;
            if (this._resources && !this._resources.canAfford('battery', powerNeeded)) {
                // Pause — not enough power
                eventBus.emit(Events.COMMS_MESSAGE, {
                    sender: 'FORGE', text: 'Low power. Forge paused', priority: 'warning'
                });
                return; // Don't advance timer
            }
            // Consume power
            if (this._resources) {
                this._resources.consume('battery', powerNeeded);
            }
        }

        this._phaseTimer += dt;

        if (this._phaseTimer >= this._phaseDuration) {
            this._advancePhase();
        }
    }

    _advancePhase() {
        const currentIdx = PHASES.indexOf(this._phase);

        if (this._phase === 'COOL') {
            // Processing complete — produce output
            this._produceOutput();
            this._totalBatches++;
            this._totalProcessedKg += this._currentBatch.massKg;

            eventBus.emit(Events.FORGE_COMPLETE, {
                batch: this._currentBatch,
                totalProcessed: this._totalProcessedKg,
                totalBatches: this._totalBatches,
            });

            // Start next batch or go idle
            this._currentBatch = null;
            this._startNextBatch();
        } else if (currentIdx < PHASES.length - 1) {
            this._transitionTo(PHASES[currentIdx + 1]);
        }
    }

    _produceOutput() {
        const batch = this._currentBatch;
        if (!batch) return;

        if (batch.outputMode === 'refine') {
            // Refined ingot: same mass, higher value
            const refinedValue = batch.marketValue * FORGE.REFINE_MULTIPLIER;
            this._outputBuffer.push({
                type: 'refined_ingot',
                metalId: batch.metalId,
                name: `Refined ${batch.name}`,
                massKg: batch.massKg,
                marketValue: refinedValue,
                totalValue: Math.round(batch.massKg * refinedValue),
                color: batch.color,
            });

            // Store back in cargo as refined version
            eventBus.emit(Events.CARGO_STORE, {
                metalId: `refined_${batch.metalId}`,
                name: `Refined ${batch.name}`,
                massKg: batch.massKg,
                color: batch.color,
                ispAsThrust: batch.ispAsThrust,
                marketValue: refinedValue,
            });

            eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'FORGE',
                text: `Refined ${batch.massKg.toFixed(1)}kg ${batch.name} → ${Math.round(batch.massKg * refinedValue)} credits value`,
                priority: 'info'
            });

        } else if (batch.outputMode === 'propellant') {
            // ST-8.3.5: Check FORGE_METAL_YIELDS for FEEP-usable metals
            const debrisType = batch.debrisType || 'electronics';
            const yields = Constants.FORGE_METAL_YIELDS ? Constants.FORGE_METAL_YIELDS[debrisType] : null;
            const feepMetals = Constants.ION_THRUSTER_METALS || {};
            const feepKeys = new Set(Object.keys(feepMetals));

            if (yields) {
                // Extract FEEP-usable metals from yield fractions
                const propMass = batch.massKg * FORGE.PROPELLANT_EFFICIENCY;
                let feepYielded = false;

                for (const [metal, fraction] of Object.entries(yields)) {
                    const metalMass = propMass * fraction;
                    if (metalMass < 0.001) continue;

                    // Track all refined metals
                    this.refinedMetals[metal] = (this.refinedMetals[metal] || 0) + metalMass;

                    // If this is a FEEP-usable metal, emit availability event
                    if (feepKeys.has(metal)) {
                        feepYielded = true;
                        eventBus.emit(Events.COMMS_MESSAGE, {
                            sender: 'FORGE',
                            text: `Refined ${metalMass.toFixed(2)}kg ${metal} (FEEP-grade)`,
                            priority: 'info',
                        });
                    }
                }

                if (!feepYielded) {
                    // No FEEP metals in this debris type — fall back to standard propellant
                    eventBus.emit(Events.COMMS_MESSAGE, {
                        sender: 'FORGE',
                        text: `${debrisType}: no FEEP metals. ${propMass.toFixed(1)}kg general propellant`,
                        priority: 'info',
                    });
                }

                // Store propellant slug in cargo
                eventBus.emit(Events.CARGO_STORE, {
                    metalId: `prop_${batch.metalId}`,
                    name: `${batch.name} Propellant`,
                    massKg: propMass,
                    color: batch.color,
                    ispAsThrust: batch.ispAsThrust,
                    marketValue: batch.marketValue * 0.5,
                });

                this._outputBuffer.push({
                    type: 'propellant_slug',
                    metalId: batch.metalId,
                    name: `${batch.name} Slug`,
                    massKg: propMass,
                    ispAsThrust: batch.ispAsThrust,
                    color: batch.color,
                    feepYields: yields,
                });

                eventBus.emit(Events.COMMS_MESSAGE, {
                    sender: 'FORGE',
                    text: `Forged ${propMass.toFixed(1)}kg from ${debrisType} (FEEP yield mode)`,
                    priority: 'info',
                });
            } else {
                // No yield mapping — legacy propellant path
                if (batch.ispAsThrust <= 0) {
                    eventBus.emit(Events.COMMS_MESSAGE, {
                        sender: 'FORGE',
                        text: `${batch.name} cannot be used as propellant. Storing as refined`,
                        priority: 'warning'
                    });
                    const refinedValue = batch.marketValue * FORGE.REFINE_MULTIPLIER;
                    eventBus.emit(Events.CARGO_STORE, {
                        metalId: `refined_${batch.metalId}`,
                        name: `Refined ${batch.name}`,
                        massKg: batch.massKg,
                        color: batch.color,
                        ispAsThrust: 0,
                        marketValue: refinedValue,
                    });
                    return;
                }

                const propMass = batch.massKg * FORGE.PROPELLANT_EFFICIENCY;

                this._outputBuffer.push({
                    type: 'propellant_slug',
                    metalId: batch.metalId,
                    name: `${batch.name} Slug`,
                    massKg: propMass,
                    ispAsThrust: batch.ispAsThrust,
                    color: batch.color,
                });

                eventBus.emit(Events.CARGO_STORE, {
                    metalId: `prop_${batch.metalId}`,
                    name: `${batch.name} Propellant`,
                    massKg: propMass,
                    color: batch.color,
                    ispAsThrust: batch.ispAsThrust,
                    marketValue: batch.marketValue * 0.5,
                });

                eventBus.emit(Events.COMMS_MESSAGE, {
                    sender: 'FORGE',
                    text: `Forged ${propMass.toFixed(1)}kg ${batch.name} propellant slug (Isp ${batch.ispAsThrust}s)`,
                    priority: 'info'
                });
            }
        }
    }

    /**
     * Cancel current processing. Returns unprocessed metal to cargo.
     */
    cancel() {
        if (this._phase === 'IDLE') return;

        if (this._currentBatch) {
            // Return metal to cargo (with some loss if past INTAKE)
            const phaseIdx = PHASES.indexOf(this._phase);
            const lossFraction = phaseIdx <= 1 ? 0 : 0.1 * phaseIdx; // 0-40% loss
            const returnMass = this._currentBatch.massKg * (1 - lossFraction);

            if (returnMass > 0.01) {
                eventBus.emit(Events.CARGO_STORE, {
                    metalId: this._currentBatch.metalId,
                    name: this._currentBatch.name,
                    massKg: returnMass,
                    color: this._currentBatch.color,
                    ispAsThrust: this._currentBatch.ispAsThrust,
                    marketValue: this._currentBatch.marketValue,
                });
            }

            eventBus.emit(Events.COMMS_MESSAGE, {
                sender: 'FORGE',
                text: `Cancelled. Returned ${returnMass.toFixed(1)}kg ${this._currentBatch.name}`,
                priority: 'info'
            });
        }

        this._phase = 'IDLE';
        this._currentBatch = null;
        this._phaseTimer = 0;
        this._queue = [];
    }

    getState() {
        return {
            phase: this._phase,
            phaseTimer: this._phaseTimer,
            phaseDuration: this._phaseDuration,
            phaseProgress: this._phaseDuration > 0 ? this._phaseTimer / this._phaseDuration : 0,
            currentBatch: this._currentBatch,
            queueLength: this._queue.length,
            totalProcessedKg: Math.round(this._totalProcessedKg * 10) / 10,
            totalBatches: this._totalBatches,
            isActive: this._phase !== 'IDLE',
        };
    }

    serialize() {
        return {
            phase: this._phase,
            phaseTimer: this._phaseTimer,
            phaseDuration: this._phaseDuration,
            currentBatch: this._currentBatch,
            queue: this._queue,
            outputBuffer: this._outputBuffer,
            totalProcessedKg: this._totalProcessedKg,
            totalBatches: this._totalBatches,
        };
    }

    restore(data) {
        if (!data) return;
        this._phase = data.phase || 'IDLE';
        this._phaseTimer = data.phaseTimer || 0;
        this._phaseDuration = data.phaseDuration || 0;
        this._currentBatch = data.currentBatch || null;
        this._queue = data.queue || [];
        this._outputBuffer = data.outputBuffer || [];
        this._totalProcessedKg = data.totalProcessedKg || 0;
        this._totalBatches = data.totalBatches || 0;
    }

    reset() {
        this._phase = 'IDLE';
        this._phaseTimer = 0;
        this._phaseDuration = 0;
        this._currentBatch = null;
        this._queue = [];
        this._outputBuffer = [];
        this.refinedMetals = {};
        this._totalProcessedKg = 0;
        this._totalBatches = 0;
    }

    dispose() {
        this.cancel();
    }
}
