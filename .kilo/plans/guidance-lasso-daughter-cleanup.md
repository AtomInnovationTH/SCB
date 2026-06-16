# Guidance Cleanup — Mother Net (Lasso) & Daughter

> **STATUS: IMPLEMENTED (all phases).** Full test suite green (3112 tests).
> See §8 for the as-built change log.
>
> Scope: clean up / improve / remove overlapping hints, guidance and help for the
> **mother net (lasso)** and **daughter** capture paths; fix the prompt collisions a new
> player hits; stop nagging seasoned players; decide on instrumentation.
>
> Grounded in verified code (file:line), not design docs:
> [`LassoSystem.js`](js/systems/LassoSystem.js), [`OnboardingDirector.js`](js/systems/OnboardingDirector.js),
> [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`ArmUnit.js`](js/entities/ArmUnit.js),
> [`DebrisField.js`](js/entities/DebrisField.js), [`commsSuppression.js`](js/systems/commsSuppression.js),
> [`CommsSystem.js`](js/systems/CommsSystem.js), [`TeachingSystem.js`](js/systems/TeachingSystem.js),
> [`SkillsSystem.js`](js/systems/SkillsSystem.js), [`InputManager.js`](js/systems/InputManager.js),
> [`main.js`](js/main.js).

---

## 1. New player — the first 90 seconds, second by second

Traced from code. This is what actually happens, and where it breaks.

| ~t | What fires | Source | Player sees |
|---|---|---|---|
| 0 s | Enter `ORBITAL_VIEW` → Director `start()` → `ONBOARDING_STARTED` → suppression **tier 0** | [`OnboardingDirector.js:449`](js/systems/OnboardingDirector.js:449), [`CommsSystem.js:386`](js/systems/CommsSystem.js:386) | — |
| 0 s | `boot` beat: "Powering up. Telemetry online." (3 s auto-advance) | Director beat | HOUSTON line |
| 3 s | `handshake`: "Cowboy, Houston. Comms up…" (2.5 s) | Director | HOUSTON line |
| ~3 s | **Auto-target nearest welcome debris (30–55 m)**; emits "Multiple contacts nearby. Press S to scan." (untagged → tier-0 **suppressed**, player never sees it) | [`GameFlowManager.js:1094`](js/systems/GameFlowManager.js:1094), [`DebrisField.js:2000`](js/entities/DebrisField.js:2000) | nothing — but a target is now **selected and in lasso range** |
| ~3 s+ | Every frame: `lassoSystem.update(…, getActiveTarget())` → `_updateInRangePrompt` sees an idle/loaded cast + in-range target → emits **"Target in lasso range. Press N to cast."** tagged `_lassoFeedback` which **bypasses tier 0** | [`main.js:1464`](js/main.js:1464), [`LassoSystem.js:486`](js/systems/LassoSystem.js:486), [`commsSuppression.js:48`](js/systems/commsSuppression.js:48) | **"Press N to cast"** — appears *over* the early beats |
| ~5.5 s | `arrows` beat: "Check attitude control. The arrow keys fire your RCS thrusters." | [`OnboardingDirector.js:55`](js/systems/OnboardingDirector.js:55) | HOUSTON line — now **contradicting** the "Press N" CMD line still on screen |

The player is simultaneously told "learn the arrow keys" and "Press N to cast." Two outcomes:

- **They press N and the target is in the forward arc** → the net actually fires. `LASSO_FIRED`
  is emitted ([`LassoSystem.js:689`](js/systems/LassoSystem.js:689) — note: only on a *successful*
  cast; denials emit `LASSO_DENIED` and never reach here). That fire routes into the Director's
  `_onTrigger(lassoBeat)`; the active beat is `arrows`, so it falls through to **`_preSatisfy`**
  ([`OnboardingDirector.js:896`](js/systems/OnboardingDirector.js:896)), which **credits and marks
  the `lasso` beat *and its parallel `daughter` beat* completed** ([`:953`](js/systems/OnboardingDirector.js:953)).
  Result: the player is auto-graduated past both capture lessons *before being taught scan, target,
  or autopilot*. They later never see the lasso or daughter beats (skipped), and the ordering is
  incoherent: they captured something before "learning" to find it.
- **They press N and the target has drifted out of the ~72° forward cone** → `fire()` rejects with
  **"Target not in forward arc. Align with autopilot first"** ([`LassoSystem.js:648`](js/systems/LassoSystem.js:648)),
  also `_lassoFeedback`/tier-0-bypassing. This is the exact third message in the user's report,
  layered on top of the RCS beat and the "Press N" invite — three contradictory instructions.

### Why the invite is wrong even in isolation

`_updateInRangePrompt` gates on `!active && cooldown<=0 && ammo>0 && inRange && !tooHeavy`
([`LassoSystem.js:462`](js/systems/LassoSystem.js:462)) but **omits the forward-arc test** that
`fire()` enforces ([`LASSO_FORWARD_ARC_DOT = 0.3`, `LassoSystem.js:645`](js/systems/LassoSystem.js:645)).
So the prompt invites an action the system will then refuse. Invite ⇎ success.

## 2. Seasoned player — two distinct experiences

**(a) Returning veteran with persisted skills (the common expert case).**
`start()` calls `_checkVeteranSkip()` ([`OnboardingDirector.js:1067`](js/systems/OnboardingDirector.js:1067));
if ≥70% of onboarding skills are practiced/mastered (`VETERAN_SKILL_THRESHOLD=0.7`), it sets
`mastered=true` and emits **`ONBOARDING_COMPLETE` without ever emitting `ONBOARDING_STARTED`**
([`:440`](js/systems/OnboardingDirector.js:440)). But CommsSystem listens for `ONBOARDING_COMPLETE`
→ `_beginPostOnboardingRamp()` → **forces `_suppressionTier = 1`** for ~60 s
([`CommsSystem.js:389`](js/systems/CommsSystem.js:389), [`:1023`](js/systems/CommsSystem.js:1023)).
**Bug:** a veteran who skipped the whole tutorial is *punished* with a muted-atmosphere start
(FLAVOR/SCI/ALERT/CMD suppressed, ramping 1→2→3 over a minute) for no reason — the default for
non-onboarding play is supposed to be tier 3. The ramp should only run when onboarding was
*actually run* (i.e. when `ONBOARDING_STARTED` had fired).

**(b) Experienced player on a fresh save (skills undiscovered).** Veteran-skip does *not* fire,
so they sit through the full beat sequence. Because they act fast, `_preSatisfy`/jump-ahead
([`:875`](js/systems/OnboardingDirector.js:875)) and the 3 s recent-input window
([`:1058`](js/systems/OnboardingDirector.js:1058)) skip some beats — but the lasso in-range prompt,
the GameFlowManager "On station, press N/D" line, and the pilot nudge all fire regardless of
expertise.

**Nag sources that ignore the player's skill level (both expert cases):**
- **In-range prompt** re-arms whenever a target leaves range ([`LassoSystem.js:495`](js/systems/LassoSystem.js:495)),
  so an expert clearing 30+ targets gets "Target in lasso range. Press N to cast." on *every*
  approach. It never consults `SkillsSystem.canFireHint`/`isVeteran`.
- **GameFlowManager** first-time lines ("On station. Press N to lasso… or D…", "Got it! Press T",
  "Target drifting. Press A") fire once per session via `_firstTimeComms`
  ([`GameFlowManager.js:1170`](js/systems/GameFlowManager.js:1170)) regardless of mastery.
- **ArmUnit pilot nudge** fires on the first 3 deploys of every run
  ([`ArmUnit.js:2564`](js/entities/ArmUnit.js:2564)) — `_pilotNudgeCount` resets on `GAME_RESET`
  ([`:2083`](js/entities/ArmUnit.js:2083)) — and a second redundant "Manual pilot available…" line
  exists at [`:4013`](js/entities/ArmUnit.js:4013).

The whole universal hint-gating system (`canFireHint`, `isVeteran`, `getHintPresentation`,
`_recentFailures`, `MAX_UNHEEDED_NUDGES=3`, `VETERAN_SKILL_THRESHOLD=0.7`,
[`Constants.js:2145`](js/core/Constants.js:2145)) already exists and was built for exactly this —
but none of these lasso/daughter prompts call into it.

## 3. Root causes (consolidated)

- **R1 — proactive teach prompt uses a reactive-denial bypass.** `_lassoFeedback` was meant for
  "you pressed a key and it failed"; the in-range *invitation* reuses it and so punches through
  tier 0 and contradicts the Director.
- **R2 — invite ⇎ success.** The in-range gate is weaker than `fire()` (no forward-arc / windup),
  so the game invites then refuses.
- **R3 — auto-target collides with guided order.** Auto-selecting welcome debris at 30–55 m before
  scan/target/autopilot are taught hands the player an in-range target the lasso layer then
  advertises, short-circuiting the lesson (and the jump-ahead pre-satisfy silently eats the
  lasso+daughter beats).
- **R4 — veteran-skip mis-ramps comms.** `ONBOARDING_COMPLETE` without `ONBOARDING_STARTED` still
  triggers the wake ramp, muting a veteran's start.
- **R5 — proactive prompts ignore skill state.** No `canFireHint`/veteran downgrade, so experts get
  nagged on every target.

## 4. Design principle — two classes of guidance

- **Reactive denial** (player pressed a key, it failed): keep an always-pass bypass — the player
  acted and deserves feedback at any tier. Dedupe + reword for consistency.
- **Proactive teach/nudge** (game volunteers "press X"): must
  1. obey suppression tiers (never bypass tier 0 — Director owns onboarding);
  2. defer to an active Director/Coach beat teaching the same verb;
  3. fire only when the action would actually succeed right now (invite ⇔ success);
  4. respect the universal hint-gating rule (`canFireHint` / veteran downgrade / silent-after-3).

## 5. Phased changes

### Phase 0 — Fix the new-player collision (small, high value, shippable alone)

- **Reclassify the in-range prompt as proactive** ([`_updateInRangePrompt`](js/systems/LassoSystem.js:460)):
  drop `_lassoFeedback` here (or add a `_proactive:true` tag the gate treats as tier-bound), so
  tier 0 suppresses it during onboarding automatically.
- **Match invite to success:** add the forward-arc check (`fwdDot >= LASSO_FORWARD_ARC_DOT`) and the
  windup/active guard to the prompt's gate, reusing `fire()`'s vectors; add boundary **hysteresis**
  (e.g. re-arm only after leaving range×1.1 or dropping below the arc by a margin) so it can't
  flicker as a target hovers at the edge.
- **Gate "outside_arc" denial at tier 0** unless the Director `lasso` beat is the active beat
  ([`LassoSystem.js:648`](js/systems/LassoSystem.js:648)) — never let it contradict an unrelated beat.
- **Decouple auto-target from the lasso advertisement (R3) — DECIDED:** during onboarding, keep the
  single pre-discovered welcome target *visible* but **do not auto-SELECT it until the Director
  reaches the `target` beat** ([`GameFlowManager.js:1094`](js/systems/GameFlowManager.js:1094)).
  With nothing selected, `lassoSystem.update(…, getActiveTarget()=null)` cannot fire the in-range
  prompt early, and the guided scan→target→approach order is preserved. Gate the auto-target block
  on `!director || director.getActiveBeatId()` being at/after `target` (or onboarding mastered).
  Confirm `_preSatisfy` then can't silently eat `lasso`/`daughter` from a stray early N.
- **Acceptance:** during onboarding no lasso prompt appears before its beat; "Press N" only shows
  when N will fire *and* hit; the arrows→press-N→"not in arc" sequence cannot occur. Extend
  [`test-LassoSystem.js`](js/test/test-LassoSystem.js) in-range mirror for arc gate + tier
  suppression; add a Director test that an early `LASSO_FIRED` during `arrows` does not pre-complete
  `lasso`/`daughter` when auto-target is deferred.

### Phase 1 — Fix the veteran mis-ramp (R4)

- In CommsSystem, only run `_beginPostOnboardingRamp()` if `ONBOARDING_STARTED` actually fired this
  session (track a `_onboardingWasRun` flag set on `ONBOARDING_STARTED`, cleared on `GAME_RESET`).
  A veteran who skips stays at the default tier 3. Extend
  [`test-CommsSystem.js`](js/test/test-CommsSystem.js): `ONBOARDING_COMPLETE` without a prior
  `ONBOARDING_STARTED` ⇒ tier stays 3.

### Phase 2 — De-duplicate overlapping help

- **Director `lasso` beat:** remove the stale `Space` alias — `keys:['KeyN']`, drop "Space works
  too"; `Space` was removed as a lasso verb in the 2026-06-13 cleanup
  ([`InputManager.js:973`](js/systems/InputManager.js:973)).
- **GameFlowManager `autopilot_arrived` "press N/D"** ([`:1174`](js/systems/GameFlowManager.js:1174)):
  it re-teaches what the Director `decision` beat covers. Gate to post-onboarding only and only if
  N/D were never taught; or remove. Same review for `first_capture` "Press T" and `drift_recovery`.
- **TeachingSystem `first_lasso` / `first_arm_deploy`:** verify the arbiter's skill-id collision rule
  covers `collect_lasso` / `collect_deploy` so they drop when the matching beat already taught the
  verb ([`TeachingSystem.js:102`,`:145`](js/systems/TeachingSystem.js:102)).
- **Daughter pilot nudges:** collapse the two ArmUnit lines ([`:2571`](js/entities/ArmUnit.js:2571),
  [`:4013`](js/entities/ArmUnit.js:4013)) into one, routed through the Phase-3 proactive rule; keep
  the first-3-deploys cap.

### Phase 3 — New-player vs veteran gating (use existing infra) (R5)

- Before any proactive lasso/daughter prompt (in-range "Press N", pilot nudge), call
  `skillsSystem.canFireHint(skillId)` (`collect_lasso`, `arm_pilot`) and skip if false (mastered, or
  3 unheeded nudges shown).
- For veterans (`isVeteran()`), downgrade to a one-line `HintTicker` entry or stay silent via
  `getHintPresentation()` instead of a comms line.
- Feed lasso/daughter failures into `_recentFailures` (causes already defined:
  `LASSO_DENIED`→`lasso-denied`, net-miss, capture-fail, [`Constants.js:2151`](js/core/Constants.js:2151))
  so a *struggling* player still gets nudged while an expert does not.

### Phase 4 — Instrumentation (answers the user's question)

**Yes — a lightweight, dev-only guidance telemetry is worth it**, and the codebase already has the
exact precedent: `Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS` gated by `?debug=1`
([`Constants.js:3262`](js/core/Constants.js:3262)) and `window.__bootMark` /
`window.__dumpBootTimeline()` ([`main.js:155`](js/main.js:155)). Reuse the pattern; nothing ships in
the default build.

`GuidanceTelemetry` (dev flag `?guidanceLog=1`, otherwise a no-op):
- Subscribes to existing events only — `COMMS_MESSAGE`, `onboarding:beatEnter`/`HINT_SATISFIED`,
  `LASSO_FIRED`/`LASSO_DENIED`, `ARM_DEPLOYED`/`ARM_CAPTURED`, key inputs — no gameplay coupling.
- Ring-buffer metrics:
  - **prompt → action latency** (proactive "Press X" → matching key): tunes `autoAdvanceAfter`,
    `IDLE_ESCALATION_MS`, in-range debounce.
  - **contradiction events** — a proactive invite followed by a matching *denial* within T s (the
    exact bug class above); a regression metric that should read 0 after Phase 0.
  - **overlap events** — ≥2 guidance comms within a short window (the "too fast" feeling).
  - **beat dwell / escalation fires / unheeded-nudge counts** per skill.
- Output: `window.__dumpGuidanceLog()` → `console.table` + a session summary (median latency,
  contradiction count, overlap count). Optionally persist last N to `localStorage` for cross-session
  tuning.

This turns onboarding tuning into measured iteration and gives Phases 0–2 an objective acceptance
gate (contradictions → 0; median press latency within a reaction budget).

## 6. Order & risk

1. **Phase 0** first — directly fixes the reported bug; independently shippable.
2. **Phase 1** (veteran mis-ramp) — tiny, isolated, high value for experts.
3. **Phase 4** instrumentation early (with/after Phase 0) so dedup is data-driven.
4. **Phase 2** dedup, then **Phase 3** veteran gating.

| Risk | Mitigation |
|---|---|
| Suppressing a *useful* denial (out of nets, too heavy) | Only **proactive** prompts get tier-gated; reactive denials keep the bypass. |
| Deferring auto-target hurts the "one obvious target" UX | Keep the single pre-discovered target visible; only delay *selecting* it until the `target` beat. |
| Hiding the in-range prompt for a legit new player | Arc-aware gate still fires when a cast will succeed — just not during a contradicting beat. |
| Regressions in well-tested LassoSystem/CommsSystem | Extend `test-LassoSystem.js` + `test-CommsSystem.js` per acceptance before refactor. |
| Telemetry shipping in prod | Hard-gate behind `?guidanceLog=1`, default off, matching existing DEBUG precedent. |

## 7. Bugs surfaced by the deep read (net-new vs. the first plan)

- **R3 jump-ahead:** an early `LASSO_FIRED` (lured by the bypassing prompt) silently pre-completes
  the `lasso` *and* `daughter` beats out of order — the player is graduated past both capture
  lessons before learning to scan/target/approach.
- **R4 veteran mis-ramp:** veteran-skip drops the comms tier to 1 for ~60 s with no onboarding
  actually running — a quieter-than-normal start that penalizes the expert.
- Auto-target convenience structurally conflicts with the guided scan→target→approach order.

## 8. As-built change log

**Phase 0 — new-player collision**
- [`commsSuppression.js`](js/systems/commsSuppression.js): `_proactive` tag is NOT a bypass —
  `_lassoFeedback && !_proactive` keeps reactive denials always-on while proactive invites are
  tier-gated (suppressed at tier 0).
- [`LassoSystem.js`](js/systems/LassoSystem.js): tracks `_onboardingActive` (via
  `ONBOARDING_STARTED`/`COMPLETE`); `_updateInRangePrompt` now suppresses during onboarding, adds
  a forward-arc test (mirrors `fire()`), boundary hysteresis (range×1.1), and tags the prompt
  `_proactive`. `update()` takes `playerVelDir`; the `outside_arc` denial is `_proactive` during
  onboarding. [`main.js`](js/main.js) passes the player velocity dir.
- [`GameFlowManager.js`](js/systems/GameFlowManager.js): welcome-debris auto-select is deferred
  during onboarding until the `target` beat (`_tryAutoTargetWelcome` + `_autoTargetAllowed`,
  driven by `onboarding:beatEnter`).

**Phase 1 — veteran comms mis-ramp**
- [`CommsSystem.js`](js/systems/CommsSystem.js): `_onboardingWasRun` flag; `_beginPostOnboardingRamp`
  uses `postOnboardingStartTier()` — veteran-skip (COMPLETE without STARTED) stays at tier 3.

**Phase 2 — de-duplication**
- [`OnboardingDirector.js`](js/systems/OnboardingDirector.js): `lasso` beat drops the stale `Space`
  alias (`keys:['KeyN']`).
- [`GameFlowManager.js`](js/systems/GameFlowManager.js): `autopilot_arrived` N/D prompt + `first_capture`
  "Press T" gated to post-onboarding only.
- [`ArmUnit.js`](js/entities/ArmUnit.js): two duplicated raw-`setTimeout` pilot nudges removed;
  the dead `_pilotNudgeCount` static deleted; the high-tumble auto-capture-fail line reworded.
  The nudge now lives as `transit_pilot_nudge` in `Constants.ARM_IDLE_HINTS` (veteran-gated +
  deployment-scoped via [`ArmIdleAdvisor.js`](js/systems/ArmIdleAdvisor.js)).

**Phase 3 — new-player vs veteran gating**
- [`LassoSystem.js`](js/systems/LassoSystem.js): `setSkillsSystem()`; the in-range prompt consults
  `canFireHint('collect_lasso',{cause:'lasso-denied'})` (silent when mastered / after 3 unheeded),
  downgrades veterans to a `HintTicker` line, and calls `noteNudgeShown`. `LASSO_DENIED` already
  feeds `_recentFailures` via `FAILURE_CAUSES`. Wired in [`main.js`](js/main.js).

**Phase 4 — instrumentation**
- New [`GuidanceTelemetry.js`](js/systems/GuidanceTelemetry.js) (dev flag `?guidanceLog=1`,
  no-op otherwise): prompt→action latency, contradiction + overlap counts; `window.__dumpGuidanceLog()`.

**Tests**
- `test-CommsSystem.js`: `_proactive` tier-gating; `postOnboardingStartTier` veteran path.
- `test-LassoSystem.js`: onboarding suppression + forward-arc gate for the in-range prompt.
- Full suite: 3112 passing.
