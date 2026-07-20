/**
 * commsSuppression.js — CP-4 guidance-arbiter suppression core (pure).
 *
 * The graduated "who's allowed to talk right now" model from
 * GUIDANCE_ARBITER_SPEC.md §2–§2.1, extracted as a dependency-light module
 * (imports only Constants — no AudioSystem/DOM) so CommsSystem AND the Node
 * test harness share ONE implementation (no copy-drift).
 *
 * Replaces the old binary `_onboardingActive` gate with a 0–3 tier model:
 *   Tier 0 — OnboardingDirector running: only tag-bypassed lines pass.
 *   Tier 1 — 0–30 s after ONBOARDING_COMPLETE: + HOUSTON, MISSION.
 *   Tier 2 — 30–60 s after: + ALERT, CMD.
 *   Tier 3 — 60 s+ (steady state, and the DEFAULT for non-onboarding play): all.
 *
 * @module systems/commsSuppression
 */

import { Constants } from '../core/Constants.js';

/** Channels allowed at each ramp tier (tiers 0 and 3 handled specially). */
export const SUPPRESSION_TIER_CHANNELS = {
  1: new Set(['HOUSTON', 'MISSION']),
  2: new Set(['HOUSTON', 'MISSION', 'ALERT', 'CMD']),
};

/**
 * Decide whether a message passes the current suppression tier.
 *
 * Tag bypasses (spec §2.1):
 *   • `_critical: true`     — passes at ANY tier (live-asset/conjunction, survival).
 *   • `_reactive: true`     — direct feedback to a key the player JUST pressed
 *                             (e.g. a display toggle). Never muted at any tier —
 *                             suppressing a line the player's own keypress caused
 *                             reads as a broken control (same rationale as the
 *                             `_lassoFeedback` capture-denial bypass).
 *   • `_lassoFeedback: true`— actionable capture-DENIAL (player pressed a key, it
 *                             failed), always passes (reactive feedback).
 *   • `_onboarding: true`   — the Director's own lines (the only thing at tier 0).
 *   • `_postOnboarding:true`— MissionCoach beats; pass at tiers ≥ 1.
 * Plus: from tier 1 up, a CRITICAL-priority message is never muted.
 *
 * NOTE: `_proactive: true` is deliberately NOT a bypass. Proactive teach/nudge
 * lines (e.g. the "Target in lasso range. Press N" invitation) must obey the
 * tier gate so they never punch through tier 0 and contradict the Director.
 * They are classified onto a normal channel (usually CMD) and gated like any
 * other message — the tag exists only for telemetry/intent, not bypass.
 *
 * @param {number} tier      — current suppression tier (0..3)
 * @param {string} channel   — classified channel (CMD/ALERT/HOUSTON/SCI/FLAVOR/MISSION)
 * @param {object} [data]    — message payload (carries the bypass tags)
 * @param {string} [priority]— message priority ('INFO'|'WARNING'|'CRITICAL'|…)
 * @returns {boolean} true ⇒ show the message; false ⇒ suppress it
 */
export function messagePassesSuppression(tier, channel, data = {}, priority = null) {
  const d = data || {};

  // Explicit critical tag bypasses every tier (incl. 0) — never mute these.
  if (d._critical === true) return true;
  // Reactive feedback for a key the player JUST pressed (e.g. a display toggle)
  // is never muted — otherwise the control reads as broken while the Director
  // runs (tier 0) or right after a GAME_RESET restarts the pipeline. Same
  // rationale as the `_lassoFeedback` capture-denial bypass below.
  if (d._reactive === true) return true;
  // Actionable lasso/net DENIAL always reaches the player (reactive: they
  // pressed a key and it failed). Proactive invitations (`_proactive`) do NOT
  // get this bypass — they are tier-gated below so they never override tier 0.
  if (d._lassoFeedback && !d._proactive) return true;
  // The Director's own onboarding script (the only non-critical line at tier 0).
  if (d._onboarding) return true;

  // Tier 0 (onboarding): nothing else passes.
  if (tier <= 0) return false;

  // From tier 1 up: a CRITICAL-priority alert is never suppressed.
  if (priority && String(priority).toUpperCase() === 'CRITICAL') return true;
  // MissionCoach beats pass once onboarding has ended.
  if (d._postOnboarding) return true;
  // Steady state.
  if (tier >= 3) return true;

  // Ramp tiers 1–2: gate by the allowed-channel set.
  const allowed = SUPPRESSION_TIER_CHANNELS[tier];
  return allowed ? allowed.has(channel) : true;
}

/**
 * Map elapsed seconds since ONBOARDING_COMPLETE to the ramp tier (1→2→3).
 * @param {number} elapsedS — seconds since onboarding completed
 * @param {{TIER2_AFTER_S:number, TIER3_AFTER_S:number}} [ramp]
 * @returns {1|2|3}
 */
export function rampSuppressionTier(elapsedS, ramp) {
  const R = ramp || (Constants.COMMS && Constants.COMMS.SUPPRESSION_RAMP)
    || { TIER2_AFTER_S: 30, TIER3_AFTER_S: 60 };
  if (elapsedS >= R.TIER3_AFTER_S) return 3;
  if (elapsedS >= R.TIER2_AFTER_S) return 2;
  return 1;
}

/**
 * Decide the suppression tier to enter on ONBOARDING_COMPLETE.
 *
 * Guidance cleanup (Phase 1): the graduated wake ramp (tier 1 → 3 over ~60 s)
 * should only run when the Director pipeline ACTUALLY ran. A returning veteran
 * is veteran-skipped — the Director emits ONBOARDING_COMPLETE WITHOUT a prior
 * ONBOARDING_STARTED — and must stay at the steady-state default tier 3 rather
 * than starting muted for a minute.
 *
 * @param {boolean} onboardingWasRun — did ONBOARDING_STARTED fire this session?
 * @returns {1|3} 1 ⇒ begin the wake ramp; 3 ⇒ steady state (no ramp).
 */
export function postOnboardingStartTier(onboardingWasRun) {
  return onboardingWasRun ? 1 : 3;
}
