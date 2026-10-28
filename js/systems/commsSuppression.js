/**
 * @module systems/commsSuppression — guidance-arbiter suppression core (pure): the graduated "who's allowed to talk
 * right now" model from archive/GUIDANCE_ARBITER_SPEC.md §2–§2.1, dependency-light (imports only Constants — no
 * AudioSystem/DOM) so CommsSystem AND the Node test harness share ONE implementation (no copy-drift).
 *
 * 0–3 tier model:
 *   Tier 0 — OnboardingDirector running: only tag-bypassed lines pass.
 *   Tier 1 — 0–30 s after ONBOARDING_COMPLETE: + HOUSTON, MISSION. (The real tutorial end, ONBOARDING_MASTERED, goes
 *            straight to tier 3; the ramp only runs for a COMPLETE that follows STARTED without it.)
 *   Tier 2 — 30–60 s after: + ALERT, CMD.
 *   Tier 3 — 60 s+ (steady state, and the DEFAULT for non-onboarding play): all.
 */

import { Constants } from '../core/Constants.js';

/** Channels allowed at each ramp tier (tiers 0 and 3 handled specially). */
export const SUPPRESSION_TIER_CHANNELS = {
  1: new Set(['HOUSTON', 'MISSION']),
  2: new Set(['HOUSTON', 'MISSION', 'ALERT', 'CMD']),
};

/**
 * Whether a message passes the current suppression tier.
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
 *   • `_quiet: true`        — NOT a bypass: the opposite. Dropped at every tier (D3).
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
 * @returns {boolean} true ⇒ show the message; false ⇒ suppress it
 */
export function messagePassesSuppression(tier, channel, data = {}, priority = null) {
  const d = data || {};

  // A `_quiet` line (per-metal weights, ground-station passes, praise, scenery and display tips: the owner's "stay
  // hidden" kinds) is dropped at EVERY tier, veterans included. This is the ONE check; both CommsSystem gates
  // (listener + addMessage) run it before a line is stored or counted toward coalescing. It outranks even
  // `_critical`: a hidden kind is never urgent.
  if (d._quiet === true) return false;

  // Explicit critical tag bypasses every tier (incl. 0).
  if (d._critical === true) return true;
  // Reactive feedback for a key the player JUST pressed is never muted (the control would read as broken while the
  // Director runs or right after a GAME_RESET).
  if (d._reactive === true) return true;
  // Actionable lasso/net DENIAL always reaches the player; proactive invitations (`_proactive`) are tier-gated below.
  if (d._lassoFeedback && !d._proactive) return true;
  if (d._onboarding) return true;

  // Tier 0 (onboarding): nothing else passes.
  if (tier <= 0) return false;

  if (priority && String(priority).toUpperCase() === 'CRITICAL') return true;
  if (d._postOnboarding) return true;
  if (tier >= 3) return true;

  const allowed = SUPPRESSION_TIER_CHANNELS[tier];
  return allowed ? allowed.has(channel) : true;
}

/** Elapsed seconds since ONBOARDING_COMPLETE → ramp tier (1→2→3). */
export function rampSuppressionTier(elapsedS, ramp) {
  const R = ramp || (Constants.COMMS && Constants.COMMS.SUPPRESSION_RAMP)
    || { TIER2_AFTER_S: 30, TIER3_AFTER_S: 60 };
  if (elapsedS >= R.TIER3_AFTER_S) return 3;
  if (elapsedS >= R.TIER2_AFTER_S) return 2;
  return 1;
}

/**
 * Suppression tier to enter on ONBOARDING_COMPLETE. The wake ramp (tier 1 → 3 over ~60 s) runs only when the Director
 * pipeline ACTUALLY ran: a returning veteran is veteran-skipped (ONBOARDING_COMPLETE WITHOUT a prior
 * ONBOARDING_STARTED) and must stay at the steady-state tier 3 rather than start muted for a minute.
 *
 * @param {boolean} onboardingWasRun — did ONBOARDING_STARTED fire this session?
 * @returns {1|3} 1 ⇒ begin the wake ramp; 3 ⇒ steady state (no ramp).
 */
export function postOnboardingStartTier(onboardingWasRun) {
  return onboardingWasRun ? 1 : 3;
}
