# Spacebar rapid-advance — "do the next thing"

> Make **Space** always perform the next logical step in the guided gameplay loop, so anyone
> (devs especially) can mash Space to rip through a full cycle: **Scan → Target → Autopilot →
> Daughter launch → Capture**. Decisions confirmed with user:
> **always-on for everyone**, **synthesize the full capture loop when no guidance beat is active**,
> **prefer daughter launch, fall back to the Mother net**.

---

## 1. Current behavior (grounded)

- `InputManager` keydown `case 'Space':` ([`InputManager.js:1087`](js/systems/InputManager.js:1087))
  fires **only** when `isGameplay && currentState === GameStates.ORBITAL_VIEW` **and**
  `onboardingDirector.pressActiveHint(this)` returns `true`.
- `OnboardingDirector.pressActiveHint(inputManager)`
  ([`OnboardingDirector.js:386`](js/systems/OnboardingDirector.js:386)) maps the **active onboarding
  beat's** primary key → an InputManager helper, and returns `false` when there is no active beat
  or onboarding is `mastered`. So **after onboarding, Space does nothing.**
- Public InputManager helpers already exist and each mirror the real key handler:
  `fireScan()` (1969), `cycleTarget()` (1977), `engageAutopilot()` (2002), `fireLasso()` (2015),
  `deployDaughter()` (2033), `toggleInspection()` (2055), `cycleView()` (2070).
- The **capture-while-piloting** action has **no public helper** — it lives inline in the
  `case 'KeyN':` ARM_PILOT branch ([`InputManager.js:972-1008`](js/systems/InputManager.js:972)):
  SK → `dispatchSelectedTool()`/`captureFromStationKeep()`; TRANSIT/APPROACH → `manualNetDeploy()`.
- `_autoTargetAndLaunch()` (the Shift+N path, [`InputManager.js:968`](js/systems/InputManager.js:968))
  auto-acquires the best in-range target and launches all docked daughters at it.
- During a launch ceremony, Space already skips the ceremony and returns early
  ([`InputManager.js:520-523`](js/systems/InputManager.js:520)) — so repeated Space presses keep flowing.
- Live game-state snapshot already assembled for the OnboardingDirector's `contextProvider`
  in [`main.js:625-646`](js/main.js:625): `{ trackedContacts, nearestDebrisM, hasTarget }`.

---

## 2. Design

Keep the onboarding path first; add a **dev sequence resolver** as the fall-through. Each Space
press performs **exactly one** step, advancing the capture loop based on live state.

```
Space pressed (gameplay)
  └─ onboardingDirector.pressActiveHint(this) === true?  → consume (unchanged)
       else → resolveNextDevAction(snapshot) → dispatch one InputManager helper
```

Put the decision logic in a **new pure module** so it is unit-testable in Node:
`js/systems/DevSequenceAdvancer.js`, exporting `resolveNextDevAction(snapshot) -> actionId|null`.
InputManager builds the snapshot from its deps and dispatches the returned action.

### 2.1 Step resolution order (one step per press)

Given a snapshot `{ armPilotMode, pilotedArmState, hasTarget, trackedContacts, inCaptureRange,
canDeployDaughter, autopilotActive }`:

| # | Condition | Action id | Helper dispatched |
|---|---|---|---|
| 1 | `armPilotMode` and piloted arm is `STATION_KEEP`/`TRANSIT`/`APPROACH` | `capture` | new `captureWithPilotedArm()` |
| 2 | `trackedContacts === 0` | `scan` | `fireScan()` |
| 3 | `!hasTarget` | `target` | `cycleTarget()` |
| 4 | `hasTarget && !inCaptureRange && !autopilotActive` | `autopilot` | `engageAutopilot()` |
| 5 | `hasTarget && inCaptureRange && canDeployDaughter` | `deploy` | `deployDaughter()` |
| 6 | `hasTarget && inCaptureRange && !canDeployDaughter` | `net` | `fireLasso()` |
| — | none match | `null` | no-op |

- **Daughter-first** capture is satisfied by ordering step 5 (deploy) before step 6 (net).
- Step 1 takes priority so that once a daughter is launched and piloting, further Space presses
  drive it to the catch (`capture`) instead of re-deploying.
- `inCaptureRange` derives from `nearestDebrisM` vs the net range used by onboarding's `lasso`
  beat (`requiresProximityM: 60`); reuse `Constants` net-range if a named constant exists, else 60 m.

### 2.2 New InputManager helper — `captureWithPilotedArm()`

Extract the body of the `case 'KeyN':` ARM_PILOT branch
([`InputManager.js:972-1008`](js/systems/InputManager.js:972)) into a public method and have both
the `KeyN` handler and the Space resolver call it (same dedup pattern used for `fireLasso()`).
Returns a boolean for whether a capture action was dispatched.

### 2.3 Always-on wiring + state-guard relaxation

Rewrite `case 'Space':` so that:

1. If `!isGameplay` → break (never steal Space from menus/briefing/typing).
2. Onboarding first: if `onboardingDirector?.pressActiveHint(this)` → `preventDefault()`, break.
3. Else build the snapshot and call the resolver; dispatch the mapped helper; `preventDefault()`.

Relax the current `currentState === ORBITAL_VIEW` restriction so the loop also works while piloting
a daughter and during approach. Allow Space when:
`currentState === ORBITAL_VIEW || this.armPilotMode || currentState === GameStates.APPROACH`
(launch-ceremony skip is already handled earlier and returns before the switch).

### 2.4 Snapshot assembly (in InputManager)

Reuse the same data the `contextProvider` computes, but read it from the same deps InputManager
already holds (`debrisField`, `player`, `targetSelector`, `armManager`, `cameraSystem`,
`autopilotSystem`):
- `armPilotMode` = `this.armPilotMode`
- `pilotedArmState` = `d.cameraSystem?.getPilotedArm?.()?.state ?? null`
- `hasTarget` = `!!d.targetSelector?.getActiveTarget?.()`
- `trackedContacts` = `d.debrisField?.getDiscoveredCount?.(true) ?? 0`
- `nearestDebrisM` → from `d.debrisField.getDebrisNear(playerPos, 5.0)` (same as main.js)
- `inCaptureRange` = `Number.isFinite(nearestDebrisM) && nearestDebrisM <= NET_RANGE_M`
- `autopilotActive` = `d.autopilotSystem?.isActive?.()` (confirm method name; else `.active`)
- `canDeployDaughter` = there is a `DOCKED` arm and `!this.armPilotMode`
  (confirm via `d.armManager.arms` states, mirroring `deployDaughter()` at
  [`InputManager.js:2040`](js/systems/InputManager.js:2040))

### 2.5 Optional dev feedback

Reuse the existing one-time "Smart default" comms pattern, or emit a transient low-priority
`COMMS_MESSAGE`/`HINT_POSTED` naming the action performed (`Scan`, `Target`, `Autopilot`,
`Daughter`, `Net`, `Capture`) so the operator sees what Space did. Keep it lightweight; throttle to
avoid spam on rapid presses.

---

## 3. Files to change

| File | Change |
|---|---|
| `js/systems/DevSequenceAdvancer.js` *(new)* | Pure `resolveNextDevAction(snapshot)` + exported action-id constants. CJS guard for Node tests (mirror `OnboardingDirector.js` tail). |
| `js/systems/InputManager.js` | Rewrite `case 'Space':` (always-on + resolver fallthrough); relax state guard; add `captureWithPilotedArm()` and refactor `case 'KeyN':` ARM_PILOT branch to call it; add `_buildDevSnapshot()` + dispatch switch; optional feedback. |
| `js/test/test-DevSequenceAdvancer.js` *(new)* | Unit tests for every resolver branch + priority ordering. |

No change needed in `main.js` (InputManager already receives all required deps).

---

## 4. Tests (acceptance)

New `test-DevSequenceAdvancer.js` (pure, no DOM):
- empty field → `scan`
- contacts but no target → `target`
- target, out of range, autopilot off → `autopilot`
- target, in range, daughter available → `deploy` (**daughter-first**)
- target, in range, no daughter available → `net` (**fallback**)
- piloting arm in `STATION_KEEP`/`TRANSIT`/`APPROACH` → `capture` (**highest priority**)
- nothing actionable → `null`

Regression: run the existing suite, especially
[`test-hud-activate-keys.js`](js/test/test-hud-activate-keys.js),
[`test-GuidanceHotkeyDrift.js`](js/test/test-GuidanceHotkeyDrift.js), and any InputManager/Space
coverage, to confirm the onboarding `pressActiveHint` path is unchanged and N-key capture still works
after the helper extraction.

---

## 5. Edge cases & risks

- **Onboarding precedence:** during onboarding, beats still own Space (resolver only runs when
  `pressActiveHint` returns false). No double-action.
- **Re-entrancy / windup:** `fireLasso()` already guards `_lassoWindingUp`; `deployDaughter()`
  no-ops while `armPilotMode`. Resolver ordering prevents deploy-spam (step 1 captures instead).
- **Ceremony overlap:** ceremony Space-skip returns before the switch, so a Space during the
  daughter launch ceremony skips the ceremony rather than resolving — acceptable and keeps flow.
- **No target / nothing to do:** resolver returns `null` → Space is a no-op (no error, no sound).
- **Always-on UX shift:** Space was intentionally freed in the 2026-06-13 revamp. This re-binds it
  globally per user decision. Document it in the help/hotkey overlay
  ([`HotkeyOverlay.js`](js/ui/HotkeyOverlay.js)) as "Space — auto-advance (do the next step)" and add
  it to the `test-GuidanceHotkeyDrift.js` awareness if a glyph assertion is appropriate.
- **Method-name verification before coding:** confirm `autopilotSystem.isActive()` vs `.active`,
  `armManager` docked-arm query, and `debrisField.getDiscoveredCount(true)` signatures at
  implementation time (all referenced above are already used elsewhere in the codebase).

---

## 6. Out of scope

- Auto-entering ARM_PILOT camera mode after a deploy (the dev can press the existing key, or a
  follow-up can add it). The resolver handles capture once piloting is active.
- Driving daughter thrust (1-4) automatically — Space advances discrete loop steps, not continuous
  piloting.
