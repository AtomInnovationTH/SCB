# Guidance Arbiter Spec — "Who's Allowed to Talk Right Now"

> **Status:** Build spec (2026-06-07). The single SSOT for coordinating the three guidance layers so new players are guided and experts are never nagged. Blocks CP-4 (the 12-mission arc) — build this **before** any per-chapter coaching content.
>
> **Grounded in code:** [`CommsSystem.js`](js/systems/CommsSystem.js), [`OnboardingDirector.js`](js/systems/OnboardingDirector.js), [`TeachingSystem.js`](js/systems/TeachingSystem.js), [`SkillsSystem.js`](js/systems/SkillsSystem.js). Current-state facts verified in [`ARCHITECTURE.md §10`](ARCHITECTURE.md).

---

## 1. The problem

There are three systems that can put text on screen, and today they don't coordinate well:

| Layer | File | Today | Scope |
|---|---|---|---|
| **OnboardingDirector** | `OnboardingDirector.js` | 16-beat pipeline, chapter 1 only | First-experience |
| **TeachingSystem** | `TeachingSystem.js` | 19 first-encounter overlays, always-on | All play |
| **MissionCoach** | *(does not exist)* | — | Chapters 2–11 (CP-4) |
| **CommsSystem** | `CommsSystem.js` | **binary** `_onboardingActive` gate | All comms |

The current gate is all-or-nothing: during onboarding everything except Director-tagged lines is suppressed; after onboarding **everything** is live at once. That produces two failure modes the arc will make worse: (a) the moment onboarding ends, the full atmosphere channel + alerts wake simultaneously and overwhelm; (b) there is no mechanism to teach one new thing per chapter without either nagging veterans or muting critical alerts.

**This spec replaces the binary gate with a graduated tier model + one universal hint-gating rule + a 3-layer arbitration table.**

---

## 2. Graduated suppression tiers (replaces `_onboardingActive`)

Replace `CommsSystem._onboardingActive: boolean` with `_suppressionTier: 0..3`.

| Tier | Active when | Allowed channels | Suppressed |
|---|---|---|---|
| **0** | OnboardingDirector running (chapter 1) | HOUSTON (Director-tagged only) | everything else |
| **1** | 0–30 s after `ONBOARDING_COMPLETE`, or a MissionCoach beat requested protection | + MISSION (MissionCoach, BANGALORE/HASSAN) | FLAVOR, ALERT, SCI, CMD |
| **2** | 30–60 s after | + ALERT, CMD | FLAVOR, SCI |
| **3** | 60 s+ (steady state) | all channels | — |

- Tier escalation timers run through `TimerManager` with `respectPause:true` and are cleared on `GAME_RESET`.
- A MissionCoach beat may call `commsSystem._tempDropToTier(1, durationMs)` to protect its highest-cognitive-load beat, then auto-restore.
- Existing channels (`CMD, ALERT, HOUSTON, SCI, FLAVOR, MISSION`) and personas (HOUSTON, ISRO BANGALORE/HASSAN) are unchanged.

### 2.1 Tag exceptions (the bypass system)

Three message tags bypass tier suppression. Today only `_onboarding` (+ `_lassoFeedback`) exist; add the other two.

| Tag | Bypasses | Use for |
|---|---|---|
| `_onboarding: true` | always passes at tier 0 | OnboardingDirector's own lines |
| `_postOnboarding: true` | always passes at tiers ≥ 1 | MissionCoach beats |
| `_critical: true` | **passes at ANY tier** | live-asset conjunction alerts (ISS/Hubble), reentry/fuel warnings |

> `_critical` is the mechanism that lets an ISS conjunction alert reach a player still in tier 1. Wire it into `CONJUNCTION_ALERT` and `RESOURCE_DEPLETED`/reentry comms.

---

## 3. The universal hint-gating rule

Every guidance nudge (Director escalation, MissionCoach beat, TeachingSystem overlay, post-onboarding skill nudge) obeys **one rule**:

> A hint for skill/concept **X** may fire **only if** X is `undiscovered` OR (X discovered AND failed-recently), **AND** it has not fired before, **AND** fewer than 3 unheeded nudges have been shown for X. After 3 unheeded nudges, fall silent and trust the player.

- "discovered/practiced/mastered" come from `SkillsSystem` (35 skills; mastery needs count AND `MASTERY_MIN_TIME=300s`).
- "failed-recently" requires a lightweight `_recentFailures` ring buffer keyed by cause (net-tumble-fail, wrong-tool, lasso-miss, …). This is new and small — wire it from the existing failure events (`NET_FAILED`, `LASSO_MISSED`, etc.).
- This single rule subsumes the pity mechanic, the post-onboarding coach, and the L4 "Houston intervention." It is the "respect the player" invariant.

### 3.1 Veteran downgrade

When `SkillsSystem` veteran threshold trips (`VETERAN_SKILL_THRESHOLD`, raise to 0.7), all tutorial-class pop-ins convert to one-line `HintTicker` entries — the veteran never sees a modal overlay. (Onboarding's veteran-skip already exists in `OnboardingDirector.start()`.)

---

## 4. Three-layer arbitration

**Invariants:**
1. At most one of {OnboardingDirector, MissionCoach} is active at a time.
2. Tier 0 ⇔ OnboardingDirector active.
3. TeachingSystem **queues** single-fire overlays while the radial menu (`C`) or deploy ceremony (`D`) is on screen; drains at ≤ 1 per 6 s when both idle.
4. `_critical:true` bypasses all suppression tiers.
5. `GAME_RESET` clears all queued/pending state in all three layers.

**Collision rule — a TeachingSystem moment AND a coach beat target the same player action:**
- OnboardingDirector active → moment **queues**; the Director beat owns the screen.
- MissionCoach active AND the moment's id matches the beat's `skillId` → moment is **dropped permanently** (the beat already taught it; the overlay would be redundant).
- Otherwise → moment queues, drains 6 s after the coach beat satisfies.

---

## 5. The `triggerFilter` extension (required by the arc)

`SkillsSystem` currently wires each skill 1:1 to a `triggerEvent` with no payload filtering. The arc needs payload-discriminated skills (e.g. "manual capture" = `ARM_CAPTURED{manual:true}`, "wide scan" = `SCAN_INITIATED{type:'wide'}`). Add optional `triggerFilter` to catalog defs:

```js
// SkillsSystem._setupListeners
on(def.triggerEvent, (data) => {
  if (def.triggerFilter && !def.triggerFilter(data)) return;
  this._onSkillTriggered(def.id);
});
```

Two payload flags must be emitted for this to work (both are cheap, additive, ignored by existing consumers):
- `ARM_CAPTURED { manual: this._manualCapture }` at all 5 emit sites in `ArmUnit.js`.
- `SCAN_INITIATED { type: 'quick' | 'wide' }` (audit `SensorSystem` emit sites — `type` already present per FIRST_EXPERIENCE A.1).

---

## 6. Build order & acceptance

| Step | Change | Burden | Acceptance |
|---|---|---|---|
| 1 | `_suppressionTier` 0–3 + timers (replace `_onboardingActive`) | M | extend `test-CommsSystem.js`: tier table gates the right channels |
| 2 | `_postOnboarding` + `_critical` tag exceptions | S | ISS `_critical` alert reaches a tier-1 player |
| 3 | `triggerFilter` + `ARM_CAPTURED.manual` + `SCAN_INITIATED.type` | S | filtered skills fire only on matching payloads |
| 4 | `_recentFailures` ring buffer + universal hint-gating rule | M | a 4th nudge for the same skill never fires; veteran sees ticker not modal |
| 5 | 3-layer arbitration (queue/drain + collision rule) in TeachingSystem | M | overlay drops when a coach beat already taught the skill id |

Once steps 1–5 are green, MissionCoach (CP-4) can be built as **data** (`BEATS_BY_MISSION[N]`) on top of this arbiter — see [`MISSION_ARC_IMPLEMENTATION.md`](MISSION_ARC_IMPLEMENTATION.md).

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Muting a critical alert during tier 1 | `_critical` tag is mandatory on live-asset + survival comms; unit-test it |
| Nagging an expert | universal hint-gating rule + veteran downgrade; "silent after 3" |
| Timer leaks on pause/reset | all timers via `TimerManager` with `respectPause`; cleared on `GAME_RESET` |
| `CommsSystem` is well-tested — regressions | extend `test-CommsSystem.js` per the acceptance column before refactor |

*Design predecessor: [`MISSION_GUIDANCE_DESIGN.md §5`](MISSION_GUIDANCE_DESIGN.md) (graduated tiers, PostOnboardingCoach) — this spec is the buildable extraction.*
