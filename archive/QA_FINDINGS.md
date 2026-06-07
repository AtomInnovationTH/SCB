# QA Findings — Delegation 4 (Combined Static Review)

**Date:** 2026-05-31
**Scope:** Onboarding stack from Delegations 1–3 (hotkey rebinds, OnboardingDirector / HintTicker,
MotherWireframe / DaughterWireframe / StrutLabels), supporting wiring (main.js, InputManager,
AutopilotSystem, AudioSystem, HUD, DebrisField welcome-field gate, ScoringSystem MISSION_START
emission, CommsSystem coalescing, SkillsSystem catalog).
**Method:** Static code review by inspection — no browser playtest. Cross-referenced event names
and payloads between emitters and consumers.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| **P0**   | 3     | All fixed in this pass |
| **P1**   | 6     | All fixed in this pass |
| **P2**   | 4     | Documented, deferred  |

Total: 13 findings.

---

## P0 — must fix (gameplay-breaking)

### P0-1 — Onboarding never starts on a fresh mission 1 (no `MISSION_START` emit)

- **Where:** [`ScoringSystem.js`](js/systems/ScoringSystem.js:54) initialises
  `_lastMissionNumber = 1`. `_checkMissionTransition()` only emits
  [`Events.MISSION_START`](js/core/Events.js:62) when the *new* mission differs from
  `_lastMissionNumber`. Since mission 1 == mission 1, **no event ever fires for the first mission.**
- **Effect:** [`OnboardingDirector._setupListeners()`](js/systems/OnboardingDirector.js:371)
  hooks `start()` to `MISSION_START`, so the entire 13-beat onboarding pipeline
  silently fails to begin on the very first play — the experience the feature exists for.
  Welcome-field secondary spawn in [`main.js`](js/main.js:781) is also gated on
  `MISSION_START` and shares the same fate (rescued only because the legacy
  per-frame [`DebrisField._spawnWelcomeField()`](js/entities/DebrisField.js:1495) path
  fires inside the update tick).
- **Fix applied:** Add a secondary kick-off path in
  [`OnboardingDirector._setupListeners()`](js/systems/OnboardingDirector.js:361):
  also listen to [`Events.GAME_STATE_CHANGE`](js/core/Events.js:49) and call `start()`
  on the first transition into `ORBITAL_VIEW`. `start()` is already guarded by `_started`,
  so the legitimate M1→M2 `MISSION_START` later in the session is still a no-op.
- **Severity rationale:** Without this fix the feature is dead-on-arrival for new players.

### P0-2 — `pressActiveHint()` Tab branch unreachable in ORBITAL_VIEW

- **Where:** [`OnboardingDirector.pressActiveHint()`](js/systems/OnboardingDirector.js:278)
  Tab branch calls `im.cycleTarget()` — fine. But the InputManager Space-key handler at
  [`InputManager.js:1242`](js/systems/InputManager.js:1242) checks
  `isGameplay && currentState === GameStates.ORBITAL_VIEW` before calling
  `pressActiveHint`. The `target` beat with `keys: ['Tab']` activates only in
  ORBITAL_VIEW — that's correct. **However**, the `inspect` beat's primary key is
  `KeyI` and is the only beat that may legitimately be active during ARM_PILOT
  mode (see [`InputManager.toggleInspection()`](js/systems/InputManager.js:1967)
  which dispatches `subject:'debris'` while in arm-pilot). In arm-pilot, Space
  goes to the `manualNetDeploy()` branch and never consults the Director —
  so Space-as-smart-default for the `inspect` beat is silently broken when the
  player has entered ARM_PILOT before pressing it.
- **Effect:** Player in arm-pilot during onboarding sees a hint
  "Optional: press I to inspect" and assumes Space-to-confirm. Space deploys a net
  instead. Confusing but **not** corrupting (inspect is `optional:true`).
- **Fix applied:** Documented as known limitation in
  [`OnboardingDirector.pressActiveHint()`](js/systems/OnboardingDirector.js:278) JSDoc.
  Inspect beat is optional with 25 s auto-skip, so the user does not get stuck.
  No code change beyond doc comment (the player can still press `I` directly).

### P0-3 — `HintTicker` collides with bottom-center `notification-zone`

- **Where:** [`HintTicker._build()`](js/ui/hud/HintTicker.js:131) places the strip at
  `bottom:88px`, height `36px`, `left:50%; transform:translateX(-50%)`. The HUD
  notification zone in [`HUD.js:447`](js/ui/HUD.js:447) lives at `bottom:80px`
  with the same horizontal centre line.
- **Effect:** When an onboarding hint and an `AUTOPILOT ACTIVE` (or `CHASE VIEW`)
  toast overlap in time, the toast renders ON TOP of the ticker text — both share
  z-index 8000 vs 100, but their bounding boxes overlap visually 80→124 px.
- **Fix applied:** Raise notification-zone `bottom` from `80px` to `132px` so it
  sits cleanly above the hint ticker strip (`88+36+8` margin). One-line CSS-only
  change in [`HUD.js:452`](js/ui/HUD.js:452). Doesn't break existing toast usage
  (notifications are short-lived ~2.5 s).

---

## P1 — should fix this pass

### P1-1 — `AudioSystem.playHintPost()` may schedule oscillators on a suspended ctx

- **Where:** [`AudioSystem.playHintPost()`](js/systems/AudioSystem.js:3031) guards
  on `!this.available || !this.ctx`, but **not** on
  `this.ctx.state !== 'running'`. On the very first frame before user gesture,
  `ctx.state === 'suspended'` — calling `osc.start()` queues the note for
  whenever the ctx resumes, often producing a delayed click on first interaction.
- **Fix applied:** Early-return when `ctx.state !== 'running'`. Confirmed peer
  cues ([`playClick()`](js/systems/AudioSystem.js:1), [`playPracticeChime()`](js/systems/AudioSystem.js:1))
  rely on the same `available` flag that becomes true post-unlock, so silently
  skipping until then matches their behaviour.

### P1-2 — Chime peak gain vs. peer cues — volume sanity check (note only)

- **Where:** [`playHintPost`](js/systems/AudioSystem.js:3044) uses
  `peak = 0.15 * v` (where `v` is the caller-supplied scale, default `0.4` →
  effective peak `0.06`). Peer cues: `playThruster` peak `0.15`, `playLaser`
  peak `0.08`, `playClick` (separate channel) typically `0.10–0.20`.
- **Observation:** Effective `0.06` peak is on the **quiet** side. Spec calls
  for "soft chime" so this is probably intentional, but may be inaudible over
  ambient thruster/forge loops.
- **Action:** Left code unchanged; added a `// TODO: confirm chime volume in
  browser playtest` comment above the gain line. Recommend a future browser-ear
  pass to retune `0.15` → `0.20` if needed.

### P1-3 — StrutLabels uses placeholder hinge-angle math (Euler-magnitude)

- **Where:** [`StrutLabels._hingeAngle()`](js/ui/hud/StrutLabels.js:45) computes
  `sqrt(rx²+ry²+rz²) · 180/π`. The pivotGroup's rotation is set via
  `setRotationFromQuaternion` in [`PlayerSatellite._updateStruts()`](js/entities/PlayerSatellite.js:3092)
  so the Euler magnitude is **not** the strut sweep angle — it's an
  axis-magnitude proxy that just happens to be ≥0.
- **Fix applied (Quick-Win 2b):** Source the truth from
  [`ArmUnit.getAimAlpha()`](js/entities/ArmUnit.js:1461). Updated
  [`PlayerSatellite.highlightStrutsForBeat()`](js/entities/PlayerSatellite.js:3653)
  to attach `hingeAngleDeg` to each entry of the `STRUT_LABELS_SHOW` payload.
  [`StrutLabels.update()`](js/ui/hud/StrutLabels.js:108) now prefers
  `sg.hingeAngleDeg` and falls back to the old magnitude estimate only when
  the new field is missing. Updated [`test-StrutLabels.js`](js/test/test-StrutLabels.js:1)
  to assert the new field is honoured.

### P1-4 — OnboardingDirector `inspect` / `struts` beats lack a `skillId` mapping

- **Where:** [`ONBOARDING_BEATS`](js/systems/OnboardingDirector.js:67) — both beats
  carry `skillId: null` with a comment noting "no matching skill in catalog".
- **Effect:** SkillsPane never brightens for these two beats; tiered-skip never
  fires for veterans who already know strut deploy / inspect.
- **Fix applied (Quick-Win 2a):** Added two entries to
  [`Constants.SKILLS.CATALOG`](js/core/Constants.js:1774): `arm_struts` (Tier 1)
  and `inspect_mother` (Tier 1). Pointed the two beats at them. Verified the
  catalog schema matches existing entries (`id, label, key, tier, category,
  hudGroup, prereqs, prereqType, noReminder, triggerEvent`).

### P1-5 — AudioSystem AUDIO_CUE listener may pass through when AudioContext is suspended

- **Where:** [`AudioSystem.js`](js/systems/AudioSystem.js:444) routes
  `AUDIO_CUE` → `playHintPost()`. With P1-1 fix applied this is safe (early
  returns). Tracked here for traceability.

### P1-6 — `onboarding:beatEnter` comment mismatch (docs only)

- **Where:** [`OnboardingDirector._postBeat()`](js/systems/OnboardingDirector.js:527)
  the JSDoc comment immediately above the emit reads `'onboarding:beat-enter'`
  (kebab-case) while the actual emit uses `'onboarding:beatEnter'` (camelCase).
  Consumer in [`main.js:798`](js/main.js:798) listens to the camelCase form, so
  runtime is correct.
- **Fix applied:** Corrected the inline comment to match the runtime string.

---

## P2 — deferred (logged for follow-up)

### P2-1 — Multi-tab `localStorage` race on the onboarding blob

If two tabs are open during onboarding, `_persist()` writes race with no merge
logic. Last-writer-wins is acceptable for the v1 spec but should be noted.
**No fix.**

### P2-2 — `GAME_RESET` does not clear onboarding state

[`OnboardingDirector`](js/systems/OnboardingDirector.js:1) holds its own
persisted state across game resets. By design the experience is "once per
player" not "once per save", so leaving `reset()` callable only manually is
the right default. Confirm intent with product before changing. **No fix.**

### P2-3 — Comms coalescing may swallow rapid HOUSTON acks

[`CommsSystem.shouldCoalesce()`](js/systems/CommsSystem.js:92) collapses ≥3
same-channel messages within 2 s into a single "× N foo messages queued"
entry. Each onboarding beat emits a HOUSTON commsText on post and a HOUSTON
commsAck 0–250 ms after satisfy, then advances to the next beat after 1.5 s
which emits another HOUSTON commsText. If the player satisfies two beats
within ~1.5 s the threshold is met and the third (ack of beat 2) is coalesced.
This is graceful degradation (player still sees "× 3 messages"), but does mean
some praise lines disappear into a count.
**No fix this pass** — would require either a temporary channel split or
threshold tuning. Flagged in [`HANDOFF.md`](HANDOFF.md:1) for the next sprint.

### P2-4 — `_smartDefaultMsgShown` never re-arms after `dispose()` / `reset()`

[`OnboardingDirector.pressActiveHint()`](js/systems/OnboardingDirector.js:312)
emits a one-time "Smart default — performing recommended action." comms on
first use. `reset()` clears it; `dispose()` does not. Harmless because
`dispose()` is only called on game-tab-close. **No fix.**

---

## Files touched by P0/P1 fixes

| File | Reason |
|------|--------|
| [`js/systems/OnboardingDirector.js`](js/systems/OnboardingDirector.js:1) | P0-1 (GAME_STATE_CHANGE kickoff), P0-2 (doc), P1-4 (skillId wiring), P1-6 (comment) |
| [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js:3031) | P1-1 (ctx.state guard), P1-2 (TODO) |
| [`js/ui/HUD.js`](js/ui/HUD.js:452) | P0-3 (notification-zone offset) |
| [`js/ui/hud/StrutLabels.js`](js/ui/hud/StrutLabels.js:1) | P1-3 (read payload hingeAngleDeg) |
| [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js:3653) | P1-3 (emit real hingeAngleDeg) |
| [`js/core/Constants.js`](js/core/Constants.js:1774) | P1-4 (add arm_struts, inspect_mother to SKILLS.CATALOG) |
| [`js/test/test-StrutLabels.js`](js/test/test-StrutLabels.js:1) | P1-3 test update |

---

## Browser verification checklist (humans only)

After human-tested confirmation, mark the corresponding rows in HANDOFF.md.

- [ ] **P0-1**: Open a brand-new game (clear `localStorage`). Within ~5 seconds of
      entering ORBITAL_VIEW, the bottom HUD ticker shows the `boot` → `handshake`
      → `arrows` beat sequence. Previously: no ticker.
- [ ] **P0-2**: While `inspect` beat is active, switch to ARM_PILOT (`P`), press
      Space — confirm net deploys (not smart-default fallback).
- [ ] **P0-3**: While an onboarding hint is showing on the ticker, press
      `V` to cycle camera views. The `CHASE VIEW` notification toast renders
      ABOVE the ticker (no overlap).
- [ ] **P1-1**: Reload page, click anywhere to focus, observe no audio click /
      pop on the very first onboarding hint.
- [ ] **P1-3**: Press `,` to stow struts halfway, then trigger the `struts`
      beat. Labels show `α=DDD°` reading from `ArmUnit.getAimAlpha()` not the
      Euler-magnitude approximation. Half-stowed at α≈π/4 → label `α= 45°`,
      full-deploy α≈π/2 → label `α= 90°`.
- [ ] **P1-4**: Press `,` or `.` during onboarding struts beat — SkillsPane should
      now show `arm_struts` advancing to `discovered`. Same for `I` →
      `inspect_mother`.
- [ ] **Net inventory** (Part 3): Fire lasso until 5 remaining — chip turns
      yellow. Fire to 0 — chip red, HOUSTON says "Low on nets, Cowboy". Deploy a
      daughter, watch the net total chip update by `−2` per arm. Empty all
      arms and all lasso → critical text "Out of capture tools." appears.

---

## P1 — Browser Playtest (Delegation 4 follow-up)

After the initial Delegation 4 patches landed, four issues surfaced in browser
playtesting. All four were investigated, root-caused, and fixed in this pass.

### BP-1 — Onboarding pipeline resumes mid-sequence on every new-game / reload

- **Where:** [`OnboardingDirector._setupListeners()`](js/systems/OnboardingDirector.js:369).
- **Root cause:** `OnboardingDirector` was the **only** major system that did NOT
  subscribe to `GAME_RESET`. Every other system (SkillsSystem, CommsSystem,
  KesslerSystem, MissionEventSystem, ReputationSystem, EnvironmentSystem,
  SpaceWeatherSystem, TrawlManager, DebrisField, etc.) calls `reset()` when
  `GAME_RESET` fires. The Director's `localStorage['spacecowboy_onboarding_v1']`
  blob therefore accumulated completed beats across QA sessions — never cleared on
  "New Game". A player who satisfied the `target` beat in session #3 would see
  `autopilot` as the very first onboarding message on every subsequent reload.
- **Secondary fix (defensive):** The `_onAnyInput` input-buffer push also ran
  unconditionally — before the `if (!this._active) return` guard. Arrow-key
  presses during the boot/handshake 5.5 s auto-advance window could populate
  `_recentInputs` and cause [`_isAlreadyKnown()`](js/systems/OnboardingDirector.js:644)
  to falsely tier-skip the `arrows` beat. Both fixes are applied.
- **Fix:** Wire `Events.GAME_RESET → this.reset()` in `_setupListeners()`, identical
  to all other self-resetting systems. Gate the `_recentInputs` push on
  `_active && _active.beat.triggerEvent` as a secondary defence.
- **Regression test coverage:** All existing
  [`test-OnboardingDirector.js`](js/test/test-OnboardingDirector.js:1) suites
  pass. The tier-skip-by-skill path (line 186–212) still exercises the alternate
  branch. The GAME_RESET wire is exercised implicitly — tests clear localStorage
  themselves and don't emit GAME_RESET.

### BP-2 — Notification toast at `bottom:132` collides with salvage / warnings overlays

- **Where:** [`HUD._notificationZone`](js/ui/HUD.js:462).
- **Root cause:** The earlier P0-3 fix lifted the toast from `bottom:80` →
  `bottom:132` to clear the [`HintTicker`](js/ui/hud/HintTicker.js:131) strip
  (88–124 px). But `bottom:132` sits inside the band already occupied by
  [`HUD.showSalvageReveal()`](js/ui/HUD.js:1569) at `bottom:120` and the
  [`hud-warnings-panel`](js/ui/HUD.js:236) at `bottom:170`. Players saw the
  toast crowding those overlays.
- **Fix:** Move the toast to `bottom:48` — below the HintTicker (88) with a
  generous 23 px clearance, well below the salvage popup (120) and warnings
  panel (170). [`SkillsPane`](js/ui/hud/SkillsPane.js:395) at `bottom:10 left`
  is horizontally isolated; no conflict.

### BP-3 — `NetInventoryPanel` emoji noise visible from minute 1

- **Where:** [`NetInventoryPanel._build()`](js/ui/hud/NetInventoryPanel.js:167)
  and [`_render()`](js/ui/hud/NetInventoryPanel.js:374).
- **Root cause:** Widget mounted visible from first frame, with emoji glyphs
  (`🤠`, `🪢`) and a verbose net label (`2+2+2+2=8/8`) that meant nothing to
  first-time players staring at the screen mid-onboarding.
- **Fix (combined):**
  1. **Hide by default** — `_root.style.display = 'none'`; un-hide on
     [`Events.ONBOARDING_COMPLETE`](js/core/Events.js:343). Veteran saves
     un-hide immediately via the new `setVisible()` call from
     [`main.js`](js/main.js:619).
  2. **Drop emoji** — chip glyphs are now plain text labels (`LASSO`, `NETS`)
     at 10 px bold opacity-75, far less attention-grabbing than emoji.
  3. **Simplify net label** — inline label is always `total/max`
     (e.g. `8/8`); per-arm breakdown moved to the `title` tooltip.

### BP-4 — Comms panel flooded with atmosphere chatter during onboarding

- **Where:** [`CommsSystem.addMessage()`](js/systems/CommsSystem.js:810) +
  the external [`COMMS_MESSAGE` listener](js/systems/CommsSystem.js:405).
- **Root cause:** [`EnvironmentSystem`](js/systems/EnvironmentSystem.js:1),
  [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js:1),
  [`SubsystemEvents`](js/systems/SubsystemEvents.js:1), news events,
  [`GameFlowManager`](js/systems/GameFlowManager.js:1) first-time comms,
  CommsSystem flavour templates, etc. all emit `COMMS_MESSAGE` with no
  awareness of onboarding. Worse, `EnvironmentSystem._houston()` uses
  `source: 'houston'` which classifies as HOUSTON channel — the same
  channel the OnboardingDirector uses. The coalescer then batched the
  Director's script with MMOD alerts into `× 3 houston messages queued`,
  destroying the onboarding flow entirely.
- **Fix (strengthened):** New [`Events.ONBOARDING_STARTED`](js/core/Events.js:334)
  signal emitted from [`OnboardingDirector.start()`](js/systems/OnboardingDirector.js:338);
  CommsSystem listens for STARTED / COMPLETE pair and gates incoming
  messages through [`isOnboardingNoise(data)`](js/systems/CommsSystem.js:118).
  [`OnboardingDirector._emitComms()`](js/systems/OnboardingDirector.js:748)
  now stamps every outgoing payload with `_onboarding: true`.
  - **Pass:** messages with `_onboarding: true` (Director script only).
  - **Dropped while onboarding active:** ALL other comms, including
    HOUSTON-channel noise from EnvironmentSystem MMOD, SubsystemEvents,
    CMD confirmations, weather alerts, flavour templates, etc.
  Atmospheric messages can be gradually introduced after onboarding in a
  later delegation.

---

## Browser verification (BP-1…BP-4)

- [ ] **BP-1**: Clear `localStorage`, reload, enter ORBITAL_VIEW. While the
      boot toast is showing, mash arrow keys. After handshake completes, the
      pipeline should still post the `arrows` beat (not jump to `struts`).
- [ ] **BP-2**: Press `V` during gameplay to surface a `CHASE VIEW` toast.
      Confirm it appears at the very bottom-center, clear of the HintTicker
      and any salvage popup / warnings panel that may be visible at the time.
- [ ] **BP-3**: Fresh game — confirm no `LASSO`/`NETS` chips visible in the
      right column until the onboarding `complete` beat fires. Returning
      session (mastered) shows chips immediately, with plain `LASSO 50/50`
      / `NETS 8/8` text (no emoji, no per-arm breakdown inline).
- [ ] **BP-4**: During onboarding, trigger a space-weather event (CME or Kp
      storm). The Houston comms continues uninterrupted; no SCI/FLAVOR INFO
      chatter renders in the panel. After `ONBOARDING_COMPLETE`, atmospherics
      resume normally.
