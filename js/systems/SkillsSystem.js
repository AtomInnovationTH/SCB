/**
 * SkillsSystem.js — free-order skill discovery engine (replaced the linear TutorialSystem).
 * 35 skills defined in Constants.SKILLS.CATALOG are tracked through four states:
 *   undiscovered → discovered → practiced → mastered
 *
 * Event-driven: each skill's triggerEvent maps to an Events.js constant; when it fires, the use count increments and
 * state transitions are evaluated. Spaced-repetition reminders nudge skills not used recently.
 *
 * @module systems/SkillsSystem
 * @see archive/SKILLS_ARCHITECTURE.md — full specification
 * @see Constants.SKILLS — tuning knobs and skill catalog
 */

import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { persistenceManager } from './PersistenceManager.js';

const UNDISCOVERED = 'undiscovered';
const DISCOVERED   = 'discovered';
const PRACTICED    = 'practiced';
const MASTERED     = 'mastered';

/**
 * @typedef {Object} SkillDef  Immutable definition from Constants.SKILLS.CATALOG.
 * @property {string}   id
 * @property {string}   label
 * @property {number}   tier          - 1..5 progression tier
 * @property {string}   category      - nav|scan|collect|awareness|manage
 * @property {string}   [triggerEvent] - Events.js constant key that fires this skill
 * @property {(data:any)=>boolean} [triggerFilter] - Optional payload predicate: the skill triggers only if it returns
 *           truthy, so several skills can share one triggerEvent (e.g. ARM_CAPTURED{manual:true},
 *           SCAN_INITIATED{type:'wide'}). Omit to fire on every event.
 * @property {string}   prereqType    - none|soft|hard|safety
 * @property {string[]} prereqs       - prerequisite skill ids
 * @property {boolean}  noReminder    - skip from spaced-repetition reminders
 * @property {Object}   [safetyGate]  - { minCatches } gate for destructive skills
 */

/**
 * @typedef {Object} SkillRecord
 * @property {Object}  def              - immutable definition from CATALOG
 * @property {string}  state            - UNDISCOVERED/DISCOVERED/PRACTICED/MASTERED
 * @property {number}  count            - total trigger count
 * @property {number}  discoveredAt     - ms timestamp of first discovery
 * @property {number}  lastUsedAt       - ms timestamp of most recent use
 * @property {number}  nextReminderAt   - ms timestamp when the next reminder is due
 * @property {number}  reminderInterval - current SM-2 interval in seconds
 * @property {number}  easeFactor       - current SM-2 ease factor
 * @property {boolean} gateUnlocked     - safety gate open (true if no gate)
 */

export class SkillsSystem {
    constructor() {
        /** @type {Map<string, SkillRecord>} keyed by skill id */
        this._skills = new Map();

        /** @type {Set<string>} HUD groups derived from discovered skills */
        this._activeGroups = new Set();

        /** @type {number} ARM_CAPTURED + LASSO_CAPTURED, for safety gates */
        this._totalCatches = 0;

        /** @type {number} */
        this._discoveryCount = 0;

        /** @type {number} ms timestamp */
        this._firstDiscoveryTime = 0;

        /** @type {number} ms timestamp */
        this._lastDiscoveryTime = 0;

        /** @type {number} seconds, for the 1 Hz reminder check */
        this._reminderAccum = 0;

        /** @type {number} reminders shown in the current frequency-cap window */
        this._reminderCapCount = 0;

        /** @type {number} ms timestamp */
        this._reminderCapStart = 0;

        /** @type {Array<Function>} EventBus unsubscribes */
        this._unsubs = [];

        /**
         * Ring buffer of recent failure causes (GUIDANCE_ARBITER_SPEC §3): the hint-gating rule nudges a *discovered*
         * skill only if "discovered AND failed-recently".
         * @type {Array<{cause: string, at: number}>}
         */
        this._recentFailures = [];

        /**
         * Per-skill unheeded nudges shown; the rule falls silent after MAX_UNHEEDED_NUDGES; cleared when the skill is used.
         * @type {Map<string, number>}
         */
        this._unheededNudges = new Map();

        /** @type {number} ms timestamp */
        this._sessionStartMs = Date.now();

        /**
         * Optional CodexSystem, via setCodexSystem() from main.js (absent in headless tests unless stubbed): enriches the
         * `manage_codex` reminder with a "did you know?" pick.
         * @type {?Object}
         */
        this._codex = null;

        this._initSkills();
        this._setupListeners();
    }

    /**
     * No codex ref means the `manage_codex` reminder stays the generic "SPECS" nudge.
     * @param {Object} codex - CodexSystem instance (getUnlockedEntries/getCategories)
     */
    setCodexSystem(codex) {
        this._codex = codex || null;
    }

    /**
     * Deterministically pick one unlocked-but-unseen codex entry for the `manage_codex` reminder: longest-unread first
     * (lowest `unlockContext.tSim`), entries without a context last, then category order, then id. Null when there is no
     * codex reference or nothing qualifies.
     * @returns {?{id:string, icon:string, title:string}}
     */
    _pickDidYouKnow() {
        const codex = this._codex;
        if (!codex || typeof codex.getUnlockedEntries !== 'function') return null;
        const unseen = codex.getUnlockedEntries().filter(e => e && !e.seen);
        if (!unseen.length) return null;

        // Category order for the final tiebreak.
        const catOrder = new Map();
        if (typeof codex.getCategories === 'function') {
            const cats = codex.getCategories() || [];
            cats.forEach((c, i) => { if (c && c.key != null) catOrder.set(c.key, i); });
        }
        const catRank = (e) => (catOrder.has(e.category) ? catOrder.get(e.category) : Number.MAX_SAFE_INTEGER);
        const tSimOf = (e) => {
            const c = e.unlockContext;
            return (c && typeof c === 'object' && Number.isFinite(c.tSim)) ? c.tSim : Number.POSITIVE_INFINITY;
        };

        const best = unseen.slice().sort((a, b) => {
            const ta = tSimOf(a);
            const tb = tSimOf(b);
            if (ta !== tb) return ta - tb;           // longest-unread first; no-ctx last
            const ca = catRank(a);
            const cb = catRank(b);
            if (ca !== cb) return ca - cb;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        })[0];

        // `icon` is a data passthrough only (never an invented glyph).
        return { id: best.id, icon: best.icon || '', title: best.title || best.id };
    }

    // PUBLIC API

    /** @returns {'undiscovered'|'discovered'|'practiced'|'mastered'} */
    getState(skillId) {
        const rec = this._skills.get(skillId);
        return rec ? rec.state : UNDISCOVERED;
    }

    /** Discovered, practiced or mastered: anything beyond undiscovered. */
    isDiscovered(skillId) {
        return this.getState(skillId) !== UNDISCOVERED;
    }

    isMastered(skillId) {
        return this.getState(skillId) === MASTERED;
    }

    /**
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
     * Up to `n` undiscovered skills whose prerequisites are met, by tier then label. Skips `noReminder` skills
     * (discovered only through natural play).
     * @returns {Array<Object>} definitions from CATALOG
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

    // Universal hint-gating rule (GUIDANCE_ARBITER_SPEC §3 / §3.1)

    /**
     * Wired from failure events (NET_FAILED, LASSO_MISSED, …); also callable directly.
     * @param {string} cause - short cause tag (see Constants.SKILLS.FAILURE_CAUSES)
     */
    recordFailure(cause, now = Date.now()) {
        if (!cause) return;
        this._recentFailures.push({ cause, at: now });
        const max = Constants.SKILLS.RECENT_FAILURE_BUFFER || 12;
        if (this._recentFailures.length > max) {
            this._recentFailures.splice(0, this._recentFailures.length - max);
        }
    }

    /** Whether `cause` occurred within RECENT_FAILURE_TTL_S. */
    failedRecently(cause, now = Date.now()) {
        const ttl = Constants.SKILLS.RECENT_FAILURE_TTL_S * 1000;
        return this._recentFailures.some(f => f.cause === cause && (now - f.at) <= ttl);
    }

    /** Any failure within the TTL (for a hint with no specific cause). */
    _failedRecentlyAny(now = Date.now()) {
        const ttl = Constants.SKILLS.RECENT_FAILURE_TTL_S * 1000;
        return this._recentFailures.some(f => (now - f.at) <= ttl);
    }

    /**
     * THE universal hint-gating rule (GUIDANCE_ARBITER_SPEC §3): a hint for skill X may fire only if X is undiscovered OR
     * (X discovered/practiced AND failed-recently), AND fewer than MAX_UNHEEDED_NUDGES unheeded nudges were shown for X.
     * Mastered skills are never nudged. The "respect the player" invariant shared by every guidance layer.
     * @param {string} skillId
     * @param {{ cause?: string|null, now?: number }} [opts]  `cause`: the failure cause for this hint; omitted, any
     *        recent failure satisfies "failed-recently".
     * @returns {boolean}
     */
    canFireHint(skillId, { cause = null, now = Date.now() } = {}) {
        const rec = this._skills.get(skillId);
        if (!rec) return false;
        if (rec.state === MASTERED) return false;
        if ((this._unheededNudges.get(skillId) || 0) >= Constants.SKILLS.MAX_UNHEEDED_NUDGES) {
            return false;
        }
        if (rec.state === UNDISCOVERED) return true; // first encounter: always eligible
        // Discovered/practiced: only when the player is struggling.
        return cause ? this.failedRecently(cause, now) : this._failedRecentlyAny(now);
    }

    /** Counts toward the unheeded cap. */
    noteNudgeShown(skillId) {
        this._unheededNudges.set(skillId, (this._unheededNudges.get(skillId) || 0) + 1);
    }

    getUnheededCount(skillId) {
        return this._unheededNudges.get(skillId) || 0;
    }

    /** Veteran (GUIDANCE_ARBITER_SPEC §3.1): discovered ≥ VETERAN_SKILL_THRESHOLD of all skills; gets one-line ticker hints, not modal overlays. */
    isVeteran() {
        const p = this.getProgress();
        const thr = Constants.SKILLS.VETERAN_SKILL_THRESHOLD ?? 0.7;
        return p.total > 0 && (p.discovered / p.total) >= thr;
    }

    getHintPresentation() {
        return this.isVeteran() ? 'ticker' : 'modal';
    }

    /** Per frame; runs the 1 Hz reminder check. @param {number} dt seconds */
    update(dt) {
        this._reminderAccum += dt;
        if (this._reminderAccum < 1.0) return;
        this._reminderAccum -= 1.0;
        this._checkReminders(Date.now());
    }

    /** New game / GAME_RESET: all skills back to undiscovered. */
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
        this._sessionStartMs     = Date.now();
        this._recentFailures     = [];
        this._unheededNudges.clear();
    }

    /** Remove all EventBus listeners; for permanent teardown. */
    dispose() {
        for (const unsub of this._unsubs) {
            unsub();
        }
        this._unsubs.length = 0;
    }

    // INTERNAL: initialization


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


    _setupListeners() {
        // Per-skill trigger events. `triggerFilter(data)` (see SkillDef) discriminates skills sharing a triggerEvent;
        // defs without one fire on every event (GUIDANCE_ARBITER_SPEC §5).
        for (const def of Constants.SKILLS.CATALOG) {
            if (!def.triggerEvent) continue;
            const eventName = Events[def.triggerEvent];
            if (!eventName) continue; // event not wired yet
            const handler = (data) => {
                if (def.triggerFilter && !def.triggerFilter(data)) return;
                this._onSkillTriggered(def.id);
            };
            this._unsubs.push(eventBus.on(eventName, handler));
        }

        // Safety gate catch tracking
        this._unsubs.push(eventBus.on(Events.ARM_CAPTURED, () => {
            this._totalCatches++;
            this._checkSafetyGates();
        }));
        this._unsubs.push(eventBus.on(Events.LASSO_CAPTURED, () => {
            this._totalCatches++;
            this._checkSafetyGates();
        }));

        // Recent-failure tracking (feeds the hint-gating rule)
        const FC = Constants.SKILLS.FAILURE_CAUSES || {};
        for (const [eventKey, cause] of Object.entries(FC)) {
            const eventName = Events[eventKey];
            if (!eventName) continue;
            this._unsubs.push(eventBus.on(eventName, () => this.recordFailure(cause)));
        }

        this._unsubs.push(eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
            saveData.skills = this._serialize();
        }));
        this._unsubs.push(eventBus.on(Events.PERSISTENCE_LOADED, () => {
            const save = persistenceManager.peek();
            if (save && save.skills) {
                this.restore(save.skills);
            }
        }));

        this._unsubs.push(eventBus.on(Events.GAME_RESET, () => this.reset()));
    }

    // INTERNAL: skill triggering & state transitions


    _onSkillTriggered(skillId) {
        const rec = this._skills.get(skillId);
        if (!rec) return;

        if (!this._canTrigger(rec)) return;

        const now = Date.now();
        rec.count++;
        rec.lastUsedAt = now;
        // Using the skill means they heeded prior nudges: reset so future struggling can nudge again.
        this._unheededNudges.delete(skillId);

        if (rec.state === UNDISCOVERED) {
            this._discoverSkill(rec, now);

        } else if (rec.state === DISCOVERED) {
            const threshold = this._getPracticeThreshold(rec.def);
            if (rec.count >= threshold) {
                this._transitionState(rec, PRACTICED);
            }
            this._onSkillUsed(rec, now);

        } else if (rec.state === PRACTICED) {
            // MASTERED needs the count threshold AND a minimum time.
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
     * By prereqType: `'none'` and `'soft'` always (soft prereqs are suggestions); `'hard'` needs all prereqs discovered;
     * `'safety'` needs the gate unlocked (minCatches reached).
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

    /** First discovery: activates the HUD group, emits SKILL_DISCOVERED + SKILL_STATE_CHANGED, feeds blitz detection. */
    _discoverSkill(rec, now) {
        const prevState = rec.state;
        rec.state       = DISCOVERED;
        rec.discoveredAt = now;

        rec.nextReminderAt = now + rec.reminderInterval * 1000;

        this._discoveryCount++;
        if (this._discoveryCount === 1) {
            this._firstDiscoveryTime = now;
        }
        this._lastDiscoveryTime = now;

        if (rec.def.hudGroup && !this._activeGroups.has(rec.def.hudGroup)) {
            this._activeGroups.add(rec.def.hudGroup);
        }

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


    _transitionState(rec, newState) {
        const prevState = rec.state;
        rec.state = newState;
        eventBus.emit(Events.SKILL_STATE_CHANGED, {
            skillId: rec.def.id,
            from:    prevState,
            to:      newState,
        });

        // Mastery celebration, after the state change.
        if (newState === MASTERED) {
            eventBus.emit(Events.MASTERY_FANFARE, {
                skillId:    rec.def.id,
                label:      rec.def.label,
                tier:       rec.def.tier,
                category:   rec.def.category,
            });
        }
    }

    // INTERNAL: prerequisite & threshold helpers

    /** Prerequisites met, for getNextSuggestions. */
    _prereqsMet(def) {
        if (!def.prereqs || def.prereqs.length === 0) return true;
        if (def.prereqType === 'none' || def.prereqType === 'soft') return true;
        // 'hard' and 'safety': prereqs must be discovered
        return def.prereqs.every(pid => this.isDiscovered(pid));
    }

    /** Category-based use count for DISCOVERED → PRACTICED. */
    _getPracticeThreshold(def) {
        const S = Constants.SKILLS;
        switch (def.category) {
            case 'scan':    return S.PRACTICE_COUNT_SCAN;     // 3
            case 'collect': return S.PRACTICE_COUNT_CATCH;    // 3
            case 'manage':  return S.PRACTICE_COUNT_COMPLEX;  // 2
            default:        return S.PRACTICE_COUNT_DEFAULT;  // 5
        }
    }

    /** Category-based use count for PRACTICED → MASTERED. */
    _getMasteryThreshold(def) {
        const S = Constants.SKILLS;
        switch (def.category) {
            case 'collect': return S.MASTERY_COUNT_CATCH;   // 10
            default:        return S.MASTERY_COUNT_DEFAULT; // 20
        }
    }


    /** Unlocks safety-gated skills whose catch threshold is met; emits SKILL_GATE_UNLOCKED per gate. */
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

    // INTERNAL: spaced repetition (SM-2 variant)

    /** SM-2 adjustment on use after discovery: used before the reminder was due → the interval grows; else it stays until the reminder fires. */
    _onSkillUsed(rec, now) {
        if (now < rec.nextReminderAt) {
            rec.reminderInterval = Math.min(
                rec.reminderInterval * rec.easeFactor,
                Constants.SKILLS.REMINDER_MAX_INTERVAL
            );
            rec.easeFactor = Math.min(rec.easeFactor + 0.1, 3.0);
        }
        rec.nextReminderAt = now + rec.reminderInterval * 1000;
    }

    /** 1 Hz: emits SKILL_REMINDED for the most overdue non-mastered, non-noReminder skill, within the frequency cap and blitz suppression. */
    _checkReminders(now) {
        const S = Constants.SKILLS;

        const capWindowMs = S.REMINDER_CAP_WINDOW * 1000;
        if (now - this._reminderCapStart > capWindowMs) {
            this._reminderCapCount = 0;
            this._reminderCapStart = now;
        }
        if (this._reminderCapCount >= S.REMINDER_FREQUENCY_CAP) return;

        // Blitz suppression: experts don't need hand-holding.
        if (this._isBlitzing(now) && Math.random() < S.BLITZ_SUPPRESS_CHANCE) {
            return;
        }

        let bestRec    = null;
        let bestOverdue = 0;

        for (const rec of this._skills.values()) {
            if (rec.state !== DISCOVERED && rec.state !== PRACTICED) continue;
            if (rec.def.noReminder) continue;
            if (now < rec.nextReminderAt) continue;
            // Silent after MAX_UNHEEDED_NUDGES for this skill.
            if ((this._unheededNudges.get(rec.def.id) || 0) >= Constants.SKILLS.MAX_UNHEEDED_NUDGES) continue;

            const overdue = now - rec.nextReminderAt;
            if (overdue > bestOverdue) {
                bestOverdue = overdue;
                bestRec     = rec;
            }
        }

        if (!bestRec) return;

        // Veterans get a one-line ticker, not a modal; each reminder counts toward the per-skill unheeded cap (reset on
        // use); manage_codex gets a "did you know?" pick when a codex ref exists.
        const payload = {
            skillId: bestRec.def.id,
            presentation: this.getHintPresentation(),
        };
        if (bestRec.def.id === 'manage_codex') {
            payload.didYouKnow = this._pickDidYouKnow();
        }
        eventBus.emit(Events.SKILL_REMINDED, payload);
        this.noteNudgeShown(bestRec.def.id);

        // Reminder was needed: shrink the interval (they forgot).
        bestRec.reminderInterval = Math.max(
            bestRec.reminderInterval / bestRec.easeFactor,
            S.REMINDER_MIN_INTERVAL
        );
        bestRec.easeFactor = Math.max(bestRec.easeFactor - 0.1, 1.5);
        bestRec.nextReminderAt = now + bestRec.reminderInterval * 1000;

        this._reminderCapCount++;
    }


    /** "Blitz mode": ≥ BLITZ_THRESHOLD skills discovered within BLITZ_DETECTION_WINDOW seconds of the first discovery. */
    _isBlitzing(now) {
        if (this._discoveryCount < Constants.SKILLS.BLITZ_THRESHOLD) return false;
        const elapsed = (now - this._firstDiscoveryTime) / 1000;
        return elapsed < Constants.SKILLS.BLITZ_DETECTION_WINDOW;
    }


    /** Sparse: only non-undiscovered skills. */
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

    /** Caps overdue reminders (max 10 min catchup) so a long absence causes no flood. @param {Object} data from _serialize() */
    restore(data) {
        if (!data || data.version !== 1) return;

        if (typeof data.totalCatches === 'number') {
            this._totalCatches = data.totalCatches;
        }

        if (Array.isArray(data.activeGroups)) {
            this._activeGroups = new Set(data.activeGroups);
        }

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

                rec.nextReminderAt = now + Math.min(
                    rec.reminderInterval * 1000,
                    600000
                );

                if (rec.def.safetyGate) {
                    rec.gateUnlocked = this._totalCatches >= rec.def.safetyGate.minCatches;
                }
            }
        }

        this._checkSafetyGates();

        eventBus.emit(Events.SKILLS_LOADED, { skills: this._skills });
    }


    getTotalCatches() { return this._totalCatches; }

    /** Seconds since construction. */
    getSessionElapsed() { return (Date.now() - this._sessionStartMs) / 1000; }
}

export default SkillsSystem;
