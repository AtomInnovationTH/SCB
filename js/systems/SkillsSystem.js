/**
 * SkillsSystem.js — Core skill discovery engine for Space Cowboy.
 *
 * Replaces the linear 10-stage TutorialSystem with free-order skill discovery.
 * 34 skills defined in Constants.SKILLS.CATALOG are tracked through four states:
 *   undiscovered → discovered → practiced → mastered
 *
 * Event-driven: each skill's triggerEvent maps to an Events.js constant.
 * When the event fires, the skill's use count increments and state transitions
 * are evaluated. Spaced-repetition reminders nudge the player about skills
 * they haven't used recently.
 *
 * @module systems/SkillsSystem
 * @see SKILLS_ARCHITECTURE.md — Full specification
 * @see Constants.SKILLS — All tuning knobs and skill catalog
 */

import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { GameStates } from '../core/GameState.js';
import { persistenceManager } from './PersistenceManager.js';

// ── Skill state constants ──────────────────────────────────────────────────
const UNDISCOVERED = 'undiscovered';
const DISCOVERED   = 'discovered';
const PRACTICED    = 'practiced';
const MASTERED     = 'mastered';

/**
 * @typedef {Object} SkillRecord
 * @property {Object}  def              - Immutable definition from CATALOG
 * @property {string}  state            - Current state (UNDISCOVERED/DISCOVERED/PRACTICED/MASTERED)
 * @property {number}  count            - Total trigger count
 * @property {number}  discoveredAt     - Timestamp (ms) of first discovery
 * @property {number}  lastUsedAt       - Timestamp (ms) of most recent use
 * @property {number}  nextReminderAt   - Timestamp (ms) when next reminder is due
 * @property {number}  reminderInterval - Current SM-2 interval in seconds
 * @property {number}  easeFactor       - Current SM-2 ease factor
 * @property {boolean} gateUnlocked     - Whether safety gate is open (true if no gate)
 */

export class SkillsSystem {
    constructor() {
        /** @type {Map<string, SkillRecord>} All skills keyed by ID */
        this._skills = new Map();

        /** @type {Set<string>} Active HUD groups derived from discovered skills */
        this._activeGroups = new Set();

        /** @type {number} Total catches (ARM_CAPTURED + LASSO_CAPTURED) for safety gates */
        this._totalCatches = 0;

        /** @type {number} Session discovery count */
        this._discoveryCount = 0;

        /** @type {number} Timestamp (ms) of first discovery this session */
        this._firstDiscoveryTime = 0;

        /** @type {number} Timestamp (ms) of most recent discovery */
        this._lastDiscoveryTime = 0;

        /** @type {number} Accumulator for 1 Hz reminder check (seconds) */
        this._reminderAccum = 0;

        /** @type {number} Session mastery count (for largeToast threshold) */
        this._masteryCount = 0;

        /** @type {number} Reminders shown within current frequency-cap window */
        this._reminderCapCount = 0;

        /** @type {number} Timestamp (ms) when current cap window started */
        this._reminderCapStart = 0;

        /** @type {Array<Function>} Unsubscribe functions for all EventBus listeners */
        this._unsubs = [];

        /** @type {number} Timestamp (ms) when this session started */
        this._sessionStartMs = Date.now();

        // Bootstrap
        this._initSkills();
        this._setupListeners();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get the current state of a skill.
     * @param {string} skillId - Skill identifier from CATALOG
     * @returns {'undiscovered'|'discovered'|'practiced'|'mastered'}
     */
    getState(skillId) {
        const rec = this._skills.get(skillId);
        return rec ? rec.state : UNDISCOVERED;
    }

    /**
     * Check whether a skill has been discovered (i.e. is discovered, practiced
     * or mastered — anything beyond undiscovered).
     * @param {string} skillId
     * @returns {boolean}
     */
    isDiscovered(skillId) {
        return this.getState(skillId) !== UNDISCOVERED;
    }

    /**
     * Check whether a skill has reached the mastered state.
     * @param {string} skillId
     * @returns {boolean}
     */
    isMastered(skillId) {
        return this.getState(skillId) === MASTERED;
    }

    /**
     * Return all skills that have been at least discovered, with their
     * current state and use count.
     * @returns {Array<{id: string, label: string, tier: number, category: string, state: string, count: number}>}
     */
    getDiscoveredSkills() {
        const result = [];
        for (const [id, rec] of this._skills) {
            if (rec.state === UNDISCOVERED) continue;
            result.push({
                id,
                label:    rec.def.label,
                tier:     rec.def.tier,
                category: rec.def.category,
                state:    rec.state,
                count:    rec.count,
            });
        }
        return result;
    }

    /**
     * Suggest up to `n` undiscovered skills whose prerequisites are met.
     * Sorted by tier (lower first), then alphabetical by label.
     * Skips skills marked `noReminder` (discovered only through natural play).
     * @param {number} [n=3] - Maximum number of suggestions
     * @returns {Array<Object>} Skill definition objects from CATALOG
     */
    getNextSuggestions(n = 3) {
        const suggestions = [];
        for (const [, rec] of this._skills) {
            if (rec.state !== UNDISCOVERED) continue;
            if (rec.def.noReminder) continue;
            if (!this._prereqsMet(rec.def)) continue;
            suggestions.push(rec.def);
        }
        suggestions.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            return a.label.localeCompare(b.label);
        });
        return suggestions.slice(0, n);
    }

    /**
     * Get overall skill discovery progress.
     * @returns {{ discovered: number, total: number, percent: number }}
     */
    getProgress() {
        let discovered = 0;
        for (const rec of this._skills.values()) {
            if (rec.state !== UNDISCOVERED) discovered++;
        }
        const total = this._skills.size;
        return {
            discovered,
            total,
            percent: total > 0 ? Math.round((discovered / total) * 100) : 0,
        };
    }

    /**
     * Per-frame update. Manages the 1 Hz spaced-repetition reminder check.
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        this._reminderAccum += dt;
        if (this._reminderAccum < 1.0) return;
        this._reminderAccum -= 1.0;
        this._checkReminders(Date.now());
    }

    /**
     * Reset all skills to undiscovered (new game / GAME_RESET).
     * Clears timers, counters, and active HUD groups.
     */
    reset() {
        for (const rec of this._skills.values()) {
            rec.state            = UNDISCOVERED;
            rec.count            = 0;
            rec.discoveredAt     = 0;
            rec.lastUsedAt       = 0;
            rec.nextReminderAt   = 0;
            rec.reminderInterval = Constants.SKILLS.REMINDER_BASE_INTERVAL;
            rec.easeFactor       = Constants.SKILLS.REMINDER_EASE_FACTOR;
            rec.gateUnlocked     = !rec.def.safetyGate;
        }

        this._activeGroups.clear();
        this._totalCatches       = 0;
        this._discoveryCount     = 0;
        this._firstDiscoveryTime = 0;
        this._lastDiscoveryTime  = 0;
        this._reminderAccum      = 0;
        this._reminderCapCount   = 0;
        this._reminderCapStart   = 0;
        this._masteryCount       = 0;
        this._sessionStartMs     = Date.now();
    }

    /**
     * Remove all EventBus listeners and clear timers.
     * Call when the system is permanently torn down.
     */
    dispose() {
        for (const unsub of this._unsubs) {
            unsub();
        }
        this._unsubs.length = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Initialization
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Populate `_skills` Map from Constants.SKILLS.CATALOG.
     * Each entry gets mutable runtime state alongside its immutable definition.
     * @private
     */
    _initSkills() {
        const catalog = Constants.SKILLS.CATALOG;
        for (const def of catalog) {
            this._skills.set(def.id, {
                def,
                state:            UNDISCOVERED,
                count:            0,
                discoveredAt:     0,
                lastUsedAt:       0,
                nextReminderAt:   0,
                reminderInterval: Constants.SKILLS.REMINDER_BASE_INTERVAL,
                easeFactor:       Constants.SKILLS.REMINDER_EASE_FACTOR,
                gateUnlocked:     !def.safetyGate,
            });
        }
    }

    /**
     * Wire up all EventBus listeners:
     *  - Per-skill trigger events from CATALOG
     *  - Safety gate catch tracking (ARM_CAPTURED + LASSO_CAPTURED)
     *  - Persistence (PERSISTENCE_GATHER / PERSISTENCE_LOADED)
     *  - Game reset
     * @private
     */
    _setupListeners() {
        // ── Per-skill trigger events ──────────────────────────────────────
        for (const def of Constants.SKILLS.CATALOG) {
            if (!def.triggerEvent) continue;
            const eventName = Events[def.triggerEvent];
            if (!eventName) continue; // Event not yet wired — skip gracefully
            const handler = () => this._onSkillTriggered(def.id);
            this._unsubs.push(eventBus.on(eventName, handler));
        }

        // ── Safety gate catch tracking ────────────────────────────────────
        this._unsubs.push(eventBus.on(Events.ARM_CAPTURED, () => {
            this._totalCatches++;
            this._checkSafetyGates();
        }));
        this._unsubs.push(eventBus.on(Events.LASSO_CAPTURED, () => {
            this._totalCatches++;
            this._checkSafetyGates();
        }));

        // ── Persistence ───────────────────────────────────────────────────
        this._unsubs.push(eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
            saveData.skills = this._serialize();
        }));
        this._unsubs.push(eventBus.on(Events.PERSISTENCE_LOADED, () => {
            const save = persistenceManager.peek();
            if (save && save.skills) {
                this.restore(save.skills);
            }
        }));

        // ── Game reset ────────────────────────────────────────────────────
        this._unsubs.push(eventBus.on(Events.GAME_RESET, () => this.reset()));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Skill Triggering & State Transitions
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Handle a skill trigger event. Increments count, checks prerequisites,
     * and evaluates state transitions (discovered → practiced → mastered).
     * @param {string} skillId
     * @private
     */
    _onSkillTriggered(skillId) {
        const rec = this._skills.get(skillId);
        if (!rec) return;

        // Prerequisite / safety gate check
        if (!this._canTrigger(rec)) return;

        const now = Date.now();
        rec.count++;
        rec.lastUsedAt = now;

        if (rec.state === UNDISCOVERED) {
            // ── First trigger → DISCOVERED ──
            this._discoverSkill(rec, now);

        } else if (rec.state === DISCOVERED) {
            // ── Check PRACTICED threshold ──
            const threshold = this._getPracticeThreshold(rec.def);
            if (rec.count >= threshold) {
                this._transitionState(rec, PRACTICED);
            }
            this._onSkillUsed(rec, now);

        } else if (rec.state === PRACTICED) {
            // ── Check MASTERED threshold + minimum time ──
            const threshold   = this._getMasteryThreshold(rec.def);
            const elapsedSec  = (now - rec.discoveredAt) / 1000;
            if (rec.count >= threshold && elapsedSec >= Constants.SKILLS.MASTERY_MIN_TIME) {
                this._transitionState(rec, MASTERED);
            }
            this._onSkillUsed(rec, now);

        }
        // MASTERED: count increments silently, no further transitions
    }

    /**
     * Check whether a skill can be triggered given its prerequisite type.
     *
     * - `'none'`   — always allowed
     * - `'soft'`   — always allowed (prereqs are suggestions, not blockers)
     * - `'hard'`   — all prereqs must be at least discovered
     * - `'safety'` — safety gate must be unlocked (minCatches reached)
     *
     * @param {SkillRecord} rec
     * @returns {boolean}
     * @private
     */
    _canTrigger(rec) {
        const def = rec.def;
        switch (def.prereqType) {
            case 'none':
            case 'soft':
                return true;
            case 'hard':
                return def.prereqs.every(pid => this.isDiscovered(pid));
            case 'safety':
                return rec.gateUnlocked;
            default:
                return true;
        }
    }

    /**
     * First-time discovery of a skill. Sets state to DISCOVERED, activates
     * any associated HUD group, emits SKILL_DISCOVERED + SKILL_STATE_CHANGED,
     * and updates discovery tracking for blitz detection.
     * @param {SkillRecord} rec
     * @param {number} now - Current timestamp (ms)
     * @private
     */
    _discoverSkill(rec, now) {
        const prevState = rec.state;
        rec.state       = DISCOVERED;
        rec.discoveredAt = now;

        // Set up initial reminder schedule
        rec.nextReminderAt = now + rec.reminderInterval * 1000;

        // Discovery tracking (blitz detection)
        this._discoveryCount++;
        if (this._discoveryCount === 1) {
            this._firstDiscoveryTime = now;
        }
        this._lastDiscoveryTime = now;

        // Activate HUD group
        if (rec.def.hudGroup && !this._activeGroups.has(rec.def.hudGroup)) {
            this._activeGroups.add(rec.def.hudGroup);
        }

        // Emit events
        eventBus.emit(Events.SKILL_DISCOVERED, {
            skillId:  rec.def.id,
            tier:     rec.def.tier,
            label:    rec.def.label,
            hudGroup: rec.def.hudGroup || null,
        });
        eventBus.emit(Events.SKILL_STATE_CHANGED, {
            skillId: rec.def.id,
            from:    prevState,
            to:      DISCOVERED,
        });

    }

    /**
     * Transition a skill to a new state and emit SKILL_STATE_CHANGED.
     * @param {SkillRecord} rec
     * @param {string} newState
     * @private
     */
    _transitionState(rec, newState) {
        const prevState = rec.state;
        rec.state = newState;
        eventBus.emit(Events.SKILL_STATE_CHANGED, {
            skillId: rec.def.id,
            from:    prevState,
            to:      newState,
        });

        // ST-3.4: Mastery celebration — emit MASTERY_FANFARE after state change
        if (newState === MASTERED) {
            this._masteryCount++;
            eventBus.emit(Events.MASTERY_FANFARE, {
                skillId:    rec.def.id,
                label:      rec.def.label,
                tier:       rec.def.tier,
                category:   rec.def.category,
                largeToast: this._masteryCount <= Constants.SKILLS.CELEBRATION.MASTERY_TOAST_THRESHOLD,
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Prerequisite & Threshold Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check whether a skill definition's prerequisites are met
     * (for getNextSuggestions filtering — uses prereq arrays).
     * @param {Object} def - Skill definition from CATALOG
     * @returns {boolean}
     * @private
     */
    _prereqsMet(def) {
        if (!def.prereqs || def.prereqs.length === 0) return true;
        if (def.prereqType === 'none' || def.prereqType === 'soft') return true;
        // 'hard' and 'safety' — prereqs must be discovered
        return def.prereqs.every(pid => this.isDiscovered(pid));
    }

    /**
     * Category-based practice threshold (DISCOVERED → PRACTICED).
     * @param {Object} def - Skill definition
     * @returns {number} Use count required
     * @private
     */
    _getPracticeThreshold(def) {
        const S = Constants.SKILLS;
        switch (def.category) {
            case 'scan':    return S.PRACTICE_COUNT_SCAN;     // 3
            case 'collect': return S.PRACTICE_COUNT_CATCH;    // 3
            case 'manage':  return S.PRACTICE_COUNT_COMPLEX;  // 2
            default:        return S.PRACTICE_COUNT_DEFAULT;  // 5
        }
    }

    /**
     * Category-based mastery threshold (PRACTICED → MASTERED).
     * @param {Object} def - Skill definition
     * @returns {number} Use count required
     * @private
     */
    _getMasteryThreshold(def) {
        const S = Constants.SKILLS;
        switch (def.category) {
            case 'collect': return S.MASTERY_COUNT_CATCH;   // 10
            default:        return S.MASTERY_COUNT_DEFAULT; // 20
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Safety Gates
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Check all safety-gated skills and unlock any whose catch threshold
     * has been met. Emits SKILL_GATE_UNLOCKED for each newly unlocked gate.
     * @private
     */
    _checkSafetyGates() {
        for (const rec of this._skills.values()) {
            if (!rec.def.safetyGate || rec.gateUnlocked) continue;
            if (this._totalCatches >= rec.def.safetyGate.minCatches) {
                rec.gateUnlocked = true;
                eventBus.emit(Events.SKILL_GATE_UNLOCKED, {
                    skillId: rec.def.id,
                });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Spaced Repetition (SM-2 Variant)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Called when a skill is used after discovery. Adjusts SM-2 interval:
     * if the player used the skill before the reminder was due, the interval
     * grows (they remember); otherwise it stays as-is until the reminder fires.
     * @param {SkillRecord} rec
     * @param {number} now - Current timestamp (ms)
     * @private
     */
    _onSkillUsed(rec, now) {
        if (now < rec.nextReminderAt) {
            // Used before reminder was due → they remember → interval grows
            rec.reminderInterval = Math.min(
                rec.reminderInterval * rec.easeFactor,
                Constants.SKILLS.REMINDER_MAX_INTERVAL
            );
            rec.easeFactor = Math.min(rec.easeFactor + 0.1, 3.0);
        }
        // Reschedule next reminder from now
        rec.nextReminderAt = now + rec.reminderInterval * 1000;
    }

    /**
     * 1 Hz reminder check. Finds the most overdue non-mastered, non-noReminder
     * skill and emits SKILL_REMINDED for it. Respects frequency cap and
     * blitz suppression.
     * @param {number} now - Current timestamp (ms)
     * @private
     */
    _checkReminders(now) {
        const S = Constants.SKILLS;

        // Reset frequency-cap window if expired
        const capWindowMs = S.REMINDER_CAP_WINDOW * 1000;
        if (now - this._reminderCapStart > capWindowMs) {
            this._reminderCapCount = 0;
            this._reminderCapStart = now;
        }
        if (this._reminderCapCount >= S.REMINDER_FREQUENCY_CAP) return;

        // Blitz suppression — experts don't need hand-holding
        if (this._isBlitzing(now) && Math.random() < S.BLITZ_SUPPRESS_CHANCE) {
            return;
        }

        // Find the single most overdue skill
        let bestRec    = null;
        let bestOverdue = 0;

        for (const rec of this._skills.values()) {
            if (rec.state !== DISCOVERED && rec.state !== PRACTICED) continue;
            if (rec.def.noReminder) continue;
            if (now < rec.nextReminderAt) continue;

            const overdue = now - rec.nextReminderAt;
            if (overdue > bestOverdue) {
                bestOverdue = overdue;
                bestRec     = rec;
            }
        }

        if (!bestRec) return;

        // Emit reminder
        eventBus.emit(Events.SKILL_REMINDED, { skillId: bestRec.def.id });

        // Reminder was needed → shrink interval (they forgot)
        bestRec.reminderInterval = Math.max(
            bestRec.reminderInterval / bestRec.easeFactor,
            S.REMINDER_MIN_INTERVAL
        );
        bestRec.easeFactor = Math.max(bestRec.easeFactor - 0.1, 1.5);
        bestRec.nextReminderAt = now + bestRec.reminderInterval * 1000;

        this._reminderCapCount++;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Blitz Detection
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Detect "blitz mode" — a veteran player discovering many skills rapidly.
     * Returns true if ≥ BLITZ_THRESHOLD skills were discovered within
     * BLITZ_DETECTION_WINDOW seconds of the first discovery.
     * @param {number} now - Current timestamp (ms)
     * @returns {boolean}
     * @private
     */
    _isBlitzing(now) {
        if (this._discoveryCount < Constants.SKILLS.BLITZ_THRESHOLD) return false;
        const elapsed = (now - this._firstDiscoveryTime) / 1000;
        return elapsed < Constants.SKILLS.BLITZ_DETECTION_WINDOW;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL — Persistence
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Serialize current skill state for save. Only includes non-undiscovered
     * skills (sparse format).
     * @returns {Object} Serialized state
     * @private
     */
    _serialize() {
        const skills = {};
        for (const [id, rec] of this._skills) {
            if (rec.state === UNDISCOVERED) continue;
            skills[id] = {
                state:            rec.state,
                count:            rec.count,
                discoveredAt:     rec.discoveredAt,
                lastUsedAt:       rec.lastUsedAt,
                reminderInterval: rec.reminderInterval,
                easeFactor:       rec.easeFactor,
            };
        }
        return {
            version:      1,
            totalCatches: this._totalCatches,
            skills,
            activeGroups: [...this._activeGroups],
        };
    }

    /**
     * Restore skill state from loaded save data. Rehydrates individual skill
     * records, active HUD groups, and catch count. Caps overdue reminders
     * to prevent a flood after long absence (max 10 min catchup).
     * @param {Object} data - Serialized state from _serialize()
     */
    restore(data) {
        if (!data || data.version !== 1) return;

        // Restore catch count (for safety gate continuity)
        if (typeof data.totalCatches === 'number') {
            this._totalCatches = data.totalCatches;
        }

        // Restore active HUD groups
        if (Array.isArray(data.activeGroups)) {
            this._activeGroups = new Set(data.activeGroups);
        }

        // Restore individual skills
        if (data.skills) {
            const now = Date.now();
            for (const [id, saved] of Object.entries(data.skills)) {
                const rec = this._skills.get(id);
                if (!rec) continue;

                rec.state        = saved.state || DISCOVERED;
                rec.count        = saved.count || 0;
                rec.discoveredAt = saved.discoveredAt || 0;
                rec.lastUsedAt   = saved.lastUsedAt || 0;

                if (typeof saved.reminderInterval === 'number') {
                    rec.reminderInterval = saved.reminderInterval;
                }
                if (typeof saved.easeFactor === 'number') {
                    rec.easeFactor = saved.easeFactor;
                }

                // Cap overdue reminders — max 10 min catchup after absence
                rec.nextReminderAt = now + Math.min(
                    rec.reminderInterval * 1000,
                    600000
                );

                // Recheck gate status with restored catch count
                if (rec.def.safetyGate) {
                    rec.gateUnlocked = this._totalCatches >= rec.def.safetyGate.minCatches;
                }
            }
        }

        this._checkSafetyGates();

        // Notify other systems that skills are loaded
        eventBus.emit(Events.SKILLS_LOADED, { skills: this._skills });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC — Session helpers (Sprint 3 skill-based gates)
    // ═══════════════════════════════════════════════════════════════════════

    /** Returns count of LASSO_CAPTURED + ARM_CAPTURED this session. */
    getTotalCatches() { return this._totalCatches; }

    /** Returns elapsed seconds since this SkillsSystem instance was constructed. */
    getSessionElapsed() { return (Date.now() - this._sessionStartMs) / 1000; }
}

export default SkillsSystem;
