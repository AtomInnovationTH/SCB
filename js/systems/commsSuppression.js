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
 *   • `_lassoFeedback: true`— actionable capture-denial, always passes (legacy).
 *   • `_onboarding: true`   — the Director's own lines (the only thing at tier 0).
 *   • `_postOnboarding:true`— MissionCoach beats; pass at tiers ≥ 1.
 * Plus: from tier 1 up, a CRITICAL-priority message is never muted.
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
  // Actionable lasso/net denial always reaches the player (legacy behaviour).
  if (d._lassoFeedback) return true;
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
