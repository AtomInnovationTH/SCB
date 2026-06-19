# New-Player Onboarding & Guidance — Deep Analysis + Cross-Persona Design

> **Status:** Plan / design draft v2 (2026-06-17). Maps the *actual* 18-beat tutorial AND the proposed reward-first opening, extracts the best of each, then designs **one capture-first spine that adapts to four player personas** (new / returning / middle / experienced) using the guidance machinery that already exists.
> **Grounded in:** `OnboardingDirector.js`, `SkillsSystem.js`, `TargetSelector.js`, `TargetReticle.js`, `AudioSystem.js`, `DebrisField.js`, `GameFlowManager.js`, `RewardSystem.js`, `MissionMilestones.js`, `DebrisMap.js`, `CommsSystem.js`, `TeachingSystem.js`, `MenuScreen.js`, `Constants.js`.

---

## PART A — The two flows, mapped

### A.1 Current 18-beat tutorial (verified from `OnboardingDirector.js:38`)

Runs on first `ORBITAL_VIEW` entry (`:507`). Each beat posts a HOUSTON comms line + (for key beats) a sticky hint chip, awards credit on satisfy, and advances on its trigger event (or a timer for narrative beats).

| # | Beat id | Type | Teaches | Gate / trigger | Credit | Time-to-here |
|---:|---|---|---|---|---:|---|
| 1 | `boot` | narrative | — | auto 3 s | 0 | T+0 |
| 2 | `handshake` | narrative | — | auto 2.5 s | 0 | T+3 |
| 3 | `arrows` | key | RCS rotate (←→↑↓) | `TUTORIAL_ARROW_INPUT` | 10 | T+6 |
| 4 | `struts` | key | deploy struts (`.`) | `STRUT_DEPLOY_INPUT` | 10 | T+10 |
| 5 | `view` | key (optional) | camera toggle (`V`) | `CAMERA_VIEW_CHANGE` (skip 25 s) | 10 | T+15 |
| 6 | `look` | mouse (optional) | drag-look | `CAMERA_ORBIT_DRAG` (skip 20 s) | 10 | T+20 |
| 7 | `zoom` | mouse/key | zoom | `CAMERA_ZOOM_INPUT` | 10 | T+25 |
| 8 | `inspect` | mouse | zoom to hull callouts | `MOTHER_INSPECTION_ENGAGED` | 10 | T+30 |
| 9 | `scan` | key | scan (`S`) earns credits | `SCAN_INITIATED` | 10 | T+40 |
| 10 | `target` | key | cycle target (`T`) | `TARGET_SELECTED` (gated: needs ≥1 contact) | 10 | T+45 |
| 11 | `autopilot` | key | autopilot (`A`) | `AUTOPILOT_ENGAGE` | 10 | T+50 |
| 12 | `decision` | narrative | net vs daughter | auto 4 s | 0 | T+55 |
| 13 | `lasso` ‖ `daughter` | key | fire net (`N`) / deploy (`D`) | `LASSO_FIRED`/`ARM_DEPLOYED` (gated: ≤60 m) | 10 | **T+60 (first catch attempt)** |
| 14 | `captured` | narrative | confirm catch + economy | `ARM_CAPTURED` / auto 6 s | 0 | T+65 |
| 15 | `solo_intro` | narrative | "you're solo" | auto 3.5 s | 0 | T+70 |
| 16 | `solo_practice` | counter | one unguided capture | `DEBRIS_CAPTURED`×1 (skip 90 s) | 0 | T+75–120 |
| 17 | `final` | narrative | "clear the field" + `mastered=true` | auto 4 s | 0 | T+120 |

**Adaptive machinery already attached to this pipeline:**
- **Tiered-skip** (`_isAlreadyKnown`, `:1044`): a beat is auto-skipped if its skill is already `practiced`/`mastered`, OR its trigger key was pressed in the last 3 s (`RECENT_INPUT_WINDOW_MS`).
- **Jump-ahead** (`_preSatisfy`, `:917`): performing a *future* beat's action while an earlier beat is on-screen credits + completes it, so the sequence skips it later.
- **Idle escalation** (`:996`): a beat idle ≥15 s fires its `escalationText` as a center-screen `TEACHING_MOMENT_FORCE`.
- **Unrelated-input escalation:** >6 wrong inputs → same overlay.
- **Conditional gating:** `requiresContacts` (Tab needs a contact), `requiresProximityM` (net hint waits until ≤60 m) — holds the beat with a contextual nudge instead of posting an unactionable instruction.
- **Veteran-skip** (`_checkVeteranSkip`, `:1067`): if the player previously `mastered` AND ≥50 % of relevant skills are `practiced` (`ONBOARDING.VETERAN_SKILL_THRESHOLD 0.5`), the **entire** pipeline is skipped → immediate `ONBOARDING_COMPLETE`.
- **Persistence** (`localStorage spacecowboy_onboarding_v2`) + `GAME_RESET` full reset.

### A.2 Proposed reward-first opening (~15 s to first reward)

| # | Beat | Player sees/hears | Teaches | Time |
|---:|---|---|---|---|
| 1 | **boot** | systems online, reticle activates | stage-set | T+0–6 |
| 2 | **tease lock** | low-value solar-panel fragment **glinting ~25–35 m dead ahead** (physically ~2–3 m so it's unmistakable, see F.2 visibility check); reticle **autolocks** (front-arc + in-range) with bracket ceremony + **lock sound**; chip "`N` Net" | the lock sound = reward; net fires what's locked | T+6 |
| 3 | **first catch** | `N` → whoosh→clamp→salvage→ka-ching | the core reward | T+8–12 |
| 4 | **second catch** | reticle auto-advances to next in-front piece (more valuable), already locked; `N` | repetition; "this is fun" | T+14 |
| 5 | **range wall** | 3rd piece is **beyond net range**: **no lock, no sound**, brackets **yellow + `OUT OF RANGE`**; HOUSTON "Too far — `A` to autopilot in" | range exists; `A` closes it | T+20 |
| 6 | **close & catch** | `A` → `playAPArrived` → range met → yellow→cyan + **lock sound** → `N` → reward | autopilot = reach | T+22–30 |
| 7 | **free clear** | remaining cluster, A→N loop; ΔV ticks; one-time "longer reach saves ΔV" | the loop; ΔV is a resource | T+30–90 |
| 8 | **cluster-clear ceremony** | "CLUSTER CLEARED" star report + sweep sting + 100 % bonus | closure + payoff | T+~90 |
| 9 | **orbit-map handoff** | map of nearest clusters with **ΔV cost**; "mind your ΔV" | the strategic layer | T+~95 |
| 10 | **the hook** | sees inefficiency, richer/farther clusters, daughter/upgrade affordances | replay / progression | — |

Spine: **reward before instruction.** A key is taught only at the moment the game withholds the reward (range wall → `A`). The lock sound is the heartbeat and must fire *only* on a real, in-range, actionable lock.

---

## PART B — Best parts of each side

| Dimension | Current 18-beat | Reward-first 15 s |
|---|---|---|
| **Time to first reward** | ~60 s (catch attempt), ~75–120 s (real solo catch) | ~10 s |
| **Coverage** | ✅ every control explicitly taught | ⚠️ camera/attitude keys deferred |
| **Motivation model** | teach-then-do (abstract first) | do-then-teach (need-driven) |
| **Expert tax** | ❌ 9 camera/attitude lessons before action | ✅ none — action is the path |
| **Struggler safety net** | ✅ idle/unrelated escalation, gating | ⚠️ must be ported in |
| **Graduation proof** | ✅ `solo_practice` requires a real catch | ✅ free-clear is inherently solo |
| **Agency** | ✅ manual throughout | ⚠️ autolock must keep manual override |
| **Economy/strategy reveal** | weakly (told, not shown) | ✅ shown via catch→salvage→ΔV→map |
| **Adaptivity present** | ✅ rich (skip/jump/escalate) — but binary veteran path | (inherits the same machinery) |

**Keep from current:** the *entire adaptive substrate* (tiered-skip, jump-ahead, idle/unrelated escalation, conditional gating, graduation proof, persistence, comms suppression tiers, `SkillsSystem` states + `canFireHint`/`isVeteran`).
**Keep from reward-first:** the *sequence and motivation model* — capture first, teach-by-withholding, show the economy by doing, end on the strategic hook.

**Synthesis thesis:** *Replace the linear lecture order with a capture-first spine, but run it through the existing adaptive machinery.* The action (lock→catch→close→clear) is identical for everyone; only the **amount of talking** scales to the player. This is what simultaneously serves the new player (full talk, no time pressure) and the expert (near-zero talk, instant action) without two separate code paths.

---

## PART C — The four personas

| Persona | Signal we can read | Needs | Today's treatment | Ideal treatment |
|---|---|---|---|---|
| **New** (never played) | no save, all skills `undiscovered` | Learn at *their own pace*, no overwhelm, a quick win to stay hooked | Full 18-beat lecture; reward 60 s away | Capture-first spine, full comms, **no time pressure** — idle help arrives only when *they* stall |
| **Returning-rusty** (played before, gap) | save exists; some skills `practiced`, many stale (SM-2 reminders) | A *few pointers* on the bits they forgot; skip what they know | Either full restart (fresh browser) or all-or-nothing veteran-skip | Spine runs, but known beats tiered-skip; stale skills get ticker reminders; only forgotten keys surface |
| **Middle** (a few sessions in) | mixed skill states, not yet veteran | Light touch; pointers at hesitation only | Mostly full pipeline unless 50 % practiced | Spine + `canFireHint`-gated nudges (only on undiscovered/struggling); ticker not modal |
| **Experienced** (mastered) | `mastered` flag + ≥70 % discovered (`isVeteran`) | **Jump straight to action**, zero nagging | Binary veteran-skip → onboarding entirely off (good) but *fragile* (localStorage only) | Spine still gives the satisfying autolock+catch (which experts *want*), but with **zero coaching** — the action IS the reward; explicit opt-out for fresh-browser experts |

**The core realization:** the capture-first spine is *itself* the cross-persona solution. A new player and an expert both want to lock-and-catch in the first 10 seconds — the new player needs the chip + comms around it, the expert doesn't. The current design fails experts (lecture tax) and under-serves the middle (binary skip). The reward-first spine + the existing per-skill adaptive gating closes both gaps with **one path**.

---

## PART D — The unified adaptive design

### D.1 One spine, three guidance depths (replace binary veteran-skip)
A graduated `guidanceLevel ∈ { GUIDED, POINTERS, MINIMAL }`. The level is **seeded** from prior signals (skill states / save) but is **primarily driven by in-session behavior** (D.5) — the player's own actions move them up or down. The first-launch prompt (D.3) is only a courtesy fast-path.

| Level | Seeded when | Comms | Hint chips | Escalation | Control teaching |
|---|---|---|---|---|---|
| **GUIDED** | new (all skills undiscovered) | full HOUSTON lines per beat | modal/sticky | idle help on (player-paced) | contextual JIT (D.6) |
| **POINTERS** | middle (mixed states, not veteran) | terse one-liners | ticker only, undiscovered/struggling (`canFireHint`) | idle help on, longer threshold | JIT, ticker only |
| **MINIMAL** | `isVeteran()` (≥70 %) or behavior-detected expert | none (atmosphere only) | none | off | none — pure action |

- This **supersedes** the binary `_checkVeteranSkip` all-or-nothing branch: even MINIMAL players still get the autolock+catch spine (which they enjoy), just with no coaching — instead of onboarding vanishing entirely.
- Reuses `SkillsSystem.isVeteran()`, `getHintPresentation()`, `canFireHint()`, and the `CommsSystem` suppression tiers (0–3). The Director consults `guidanceLevel` per beat. **The level is mutable mid-session** (D.5), not fixed at start.

### D.2 Player-paced, not clock-paced (the "learn at your pace" fix)
- **Interactive beats must never auto-advance on a timer** (already true) — they wait for the action. New players control tempo.
- **Idle help is opt-in by stalling:** the escalation overlay is the safety net, not a metronome. Keep `IDLE_ESCALATION_MS` but raise it for GUIDED (or make it the *only* pressure). No "hurry up" anywhere.
- **Narrative beats keep short auto-advance** (read-and-go) — fine for all personas.

### D.3 Explicit affordance — Settings toggle only (no startup popup)
Behavior (D.5) is the opt-out, so **no first-launch prompt is needed** — the game reaches MINIMAL from an expert's first ~10 s of play on its own.
- The only explicit control is a **Settings toggle** (Guidance: Guided / Pointers / Off) via `SettingsManager`, overriding the behavior-driven level whenever the player wants.
- No interruptive popup on START.

### D.4 Catch-up safety net for jump-ahead / deferred content
Because experts and behavior-de-escalated players skip explicit teaching, the *never-seen* concepts must remain learnable later — already exists, lean on it:
- `TeachingSystem` first-encounter overlays (queue/drain, veteran→ticker).
- `SkillsSystem` SM-2 spaced-repetition reminders resurface stale skills.
- Codex + `HotkeyOverlay (?)` always-available reference.

### D.5 Behavior-driven auto-tuning — "the action is the opt-out" (the core of this revision)
The player's own actions move `guidanceLevel` **both directions**, in-session, with no prompt. This is the generalization of the existing `_preSatisfy` jump-ahead and `RECENT_INPUT_WINDOW_MS` tiered-skip — promoted from "silently credit a future beat" to "advance the on-screen lecture AND retune the whole guidance level."

**Competence signals (de-escalate — "I've got this"):** an *advanced action performed before the spine coaches it* —
`LASSO_FIRED`, `AUTOPILOT_ENGAGE`, `SCAN_INITIATED`, manual `TARGET_SELECTED`, `DEBRIS_CAPTURED`, map opened.
- **Rule:** an "ahead-of-coaching" action **dismisses the current beat's lecture**, fast-forwards the spine to the player's demonstrated position, and drops one tier. A **successful `DEBRIS_CAPTURED` before any coaching** is decisive → jump straight to MINIMAL.
- *This is exactly the returning player:* they will immediately try to capture. The first net-fire / capture **is** the opt-out — the lecture should not linger while they demonstrate mastery (today's bug: the active beat stays on screen even as future beats pre-satisfy).
- **Guard against false positives:** a single stray keypress must not de-escalate. Require either (a) a *successful* capture, or (b) **two distinct** advanced actions, before dropping below GUIDED. Cold-gas/arrow taps alone don't count as competence.

**Struggle signals (re-escalate — "give me a hand"):** idle-stall past `IDLE_ESCALATION_MS`, `NET_EMPTY_CLICK`/`LASSO_DENIED`, repeated misses, `failedRecently(cause)`.
- **Rule:** a struggling MINIMAL/POINTERS player gets bumped back up one tier (re-enable the relevant chip/comms) — but `canFireHint`'s `MAX_UNHEEDED_NUDGES` still caps it so a player who ignores help is left alone. Two-way, self-correcting, never naggy.

**Net effect per persona:**
- *New:* does nothing advanced → stays GUIDED, paced by their own stalls.
- *Returning-rusty:* captures the tease fine → de-escalates to POINTERS; fumbles the range wall → re-escalates the `A` pointer only.
- *Expert (fresh browser):* lock→N→A→catch in ~10 s → silently at MINIMAL before HOUSTON finishes the second line. **No prompt required.**

### D.6 Contextual, just-in-time control teaching (each key where it's needed)
The current tutorial front-loads keys abstractly ("test attitude control"). Instead, **every control is taught at the first moment it becomes useful** — and several are never forced because another control subsumes them.

| Control | Taught when (JIT trigger) | Why deferred / contextual |
|---|---|---|
| **Net `N`** | tease autolock (spine beat 2) | the first reward — the only key forced at the very start |
| **Autopilot `A`** | first `TARGET_OUT_OF_RANGE` (range wall) | the one nav key the opening forces — because range withholds the reward |
| **Arrows (RCS)** | `STATION_KEEP_ENTERED` (daughter parked → "arrows rotate the mother to line up your daughter"), or first manual close attempt without AP | **An autopilot user never needs arrows to travel** — so don't teach them up front. They first matter when assisting a station-keeping daughter or aborting AP. This is the user's "reminder when daughter is station-keeping." |
| **Scan `S`** | front-arc has no discovered debris left after a catch | only useful once the obvious targets are gone |
| **Target `T`** | player presses `T`, or wants a non-autolocked piece | autolock removes the *need* to teach manual cycling first; surfaces only on reach-for-it |
| **Struts `.` / Daughter `D` / pilot `1-4` / reel `R`** | daughter introduction (later mission) | irrelevant until distant/heavy debris needs a daughter |
| **View / Look / Zoom / Inspect** | hazard/active-sat proximity (`Inspect` to read owner) | situational awareness; never force in M1 |

- Each JIT nudge is `canFireHint(skillId)`-gated (fires only if undiscovered/struggling, silent after the cap) and respects `getHintPresentation()` (ticker for veterans).
- This **replaces** the "defer the six camera/attitude beats" hand-wave: they're not deferred to a fixed point, they're *event-contextual* and many never appear for an AP-driving player.

---

## PART E — What else is needed (gaps beyond the two flows)

1. **Graduated guidance level** (D.1) — replaces the brittle binary veteran-skip; serves the middle player. *New.*
2. **Behavior-driven auto-tuning** (D.5) — the *primary* opt-out: advanced actions de-escalate, struggle re-escalates, two-way. Promotes the existing jump-ahead/tiered-skip from "credit a future beat" to "retune guidance + dismiss the lingering lecture." *New (builds on existing signals).*
3. **Contextual just-in-time control teaching** (D.6) — each key taught at first use; arrows surface on `STATION_KEEP_ENTERED`, never forced for an AP user. *New (replaces front-loaded camera/attitude beats).*
4. **Optional first-launch prompt** (D.3) — now a courtesy fast-path, not load-bearing. *New, small.*
5. **Range-gated front-arc autolock** + **OUT OF RANGE reticle state** + **lock-sound gating** — mechanical core of the spine (Part F). *New.*
6. **Welcome-field curation** — deterministic tease (glint, low value) + value ramp + intentionally out-of-range 3rd piece. *Tune existing.*
7. **Director resequence** to capture-first spine. *Restructure.*
8. **Cluster-clear → orbit-map ΔV handoff** as the M1 finale + the "be more efficient" hook. *Wire existing.*
9. **Pace philosophy pass** — interactive beats never time-pressure; idle help is the only nudge. *Tune.*
10. **Manual-override guarantee** — autolock never blocks `T`/click reselect; manual input instantly yields agency.
11. **Hotkey reconciliation** — `DebrisMap` `M` vs Backquote (`MissionMilestones`/Constants say `M`; `DebrisMap.js:8` says Backquote).
12. **Net-range SSOT** — one `NET_LOCK_RANGE_M` for the in-range test (reconcile `CaptureNet.BASELINE_RANGE_MAX 75` vs `LASSO_RANGE 200`).
13. **Telemetry hooks** (optional) — time-to-first-catch, tier transitions, escalations fired, to tune against real funnels.

---

## PART F — Implementation phases

### Phase 1 — Autolock + OUT OF RANGE + lock-sound gating
- Front-arc autolock (±~35° of ship/camera forward, nearest in-range `welcomeSpawn`), auto-reacquire on capture. New `Constants.AUTOLOCK = { ARC_DEG, RANGE_M, REACQUIRE, ENABLED }`. Build on `GameFlowManager._tryAutoTargetWelcome` (`:120`).
- In-range test vs a single `NET_LOCK_RANGE_M`. `playTargetLock` fires **only** in-range; out-of-range selection is **silent**.
- `TargetReticle._drawOnScreenReticle`: yellow brackets + `OUT OF RANGE` label when out of range; flip to cyan + fire lock chain the frame it enters range. Emit `TARGET_IN_RANGE`/`TARGET_OUT_OF_RANGE`. Keep allocation-free.
- Manual override: any `T`/click/direction input cancels autolock for that frame and selects manually.

### Phase 2 — Welcome-field curation (`DebrisField._spawnWelcomeField` / `WELCOME_FIELD` specs `:209`)

> **AS‑BUILT (2026‑06‑18) — supersedes parts of F.2 below.** Phase 2 shipped, but with two
> corrections found in playtest (see `.kilo/plans/onboarding-tease-debris-pin.md` for the full
> record):
> - **Appearance is junk, not a satellite.** F.2's "large flat **solar‑panel / `box`/`defunctSat`**
>   shape" was wrong: a box reads as a *high‑value satellite*. The spawn does **not** rebind the
>   instanced‑mesh slot, so the rendered shape is the reused candidate's. We therefore **prefer
>   `fragment` candidates** (irregular icosahedron = low‑value junk) and use a `sizeM` override
>   (bypassing the per‑type size cap) for visibility — #1 ≈ 3 m, #2/#3 ≈ 2.4 m. No `solar_cell`.
> - **Net‑catchable + pinned.** M1 is net‑only, so every welcome mass is ≤ `LASSO_MAX_CAPTURE_MASS`
>   (10 kg). #1 (dead centre) and #2 (off to one side) are **pinned in the mother's local frame**
>   via `_scenePosition` (forward + lateral); #3 stays a free out‑of‑range orbit (the autopilot
>   target). `OUT OF RANGE` is now a brief flash, not a persistent label.

**F.2 visibility check (verified).** The chase camera sits **~15 m behind the mother** (`CameraSystem.chase.offsetBehind ~15 m`, `:130`), FOV 55° (`CAMERA_FOV`, `Constants.js:83`). Today's closest tease piece is a `fragment` at 1–3 kg → **~0.46 m across** (`fragment sizeMin 0.1`/`sizeMax 1.0`, `:45`). The welcome offsets are **trueAnomaly arc offsets** (`:205`), so #1 is ~30–55 m ahead = **~45–70 m from the camera**. Apparent height at 55° FOV / 1080p:
- 0.46 m fragment @ ~45–70 m → **~7–12 px — a dim speck (NOT visible as a panel).**
- 2.5 m flat panel @ ~30–40 m → **~70–94 px — unmistakable, reads as a glinting panel.**

**∴ the tease must be sized/shaped, not just placed.** Decouple physical size from value (a solar panel is large but low-mass/low-value — realistic):

- **#1 tease (in range):** a **physically large, flat, shiny solar-panel object (~2–3 m)**, placed **~25–35 m ahead** (≈35–50 m from camera; clear of the ~3 m near-plane), **low salvage value**, with a **sun-facing specular glint** to grab the eye. NOT a sub-meter `fragment`. Pre-discovered + pre-locked.
- **#2 second easy catch (in range):** recognizable piece **~1.5–3 m**, reliably **≤ `NET_LOCK_RANGE_M`** (~50–65 m), slightly higher value. Pre-revealed.
- **#3 range wall (out of range):** **clearly beyond `NET_LOCK_RANGE_M`** (~130–180 m). The reticle bracket + `OUT OF RANGE` label guarantees *targetability* even though the mesh is small at that distance.
- Remaining 4–5 fragments for free-clear (existing medium/far tiers are fine).
- Implementation note: this means **adjusting the first 2–3 `WELCOME_FIELD` spec rows** (type/mass→size, offsets) so size and range match the spine — the current rows pick small `fragment` masses precisely to be "trivial," which is what makes them invisible. Add a panel-style shape (flat `box`/`defunctSat` or a dedicated panel mesh) + glint flag for the tease piece, and verify the M1 instanced-mesh path renders it (use an attached glint sprite if per-instance specular is costly).

### Phase 3 — Director resequence + guidance levels + behavior auto-tuning
- New beat order: `boot → tease_lock → first_catch → second_catch → range_wall → close_and_catch → free_clear → (CLUSTER_CLEARED handoff)`.
- **Behavior-driven tuner** (D.5): a small controller subscribes to the competence/struggle signals, mutates `guidanceLevel`, and — crucially — **dismisses the current beat's lecture** when the player performs an ahead-of-coaching action (fixing the "lecture lingers while future beats pre-satisfy" gap). Decisive de-escalation on first unguided `DEBRIS_CAPTURED`.
- **Contextual JIT control teaching** (D.6): drop the front-loaded `arrows/struts/view/look/zoom/inspect` beats; wire each to its event trigger (`STATION_KEEP_ENTERED` → arrows, post-catch empty-arc → scan, hazard → inspect), all `canFireHint`-gated.
- Add `guidanceLevel` (D.1); Director gates comms/chips/escalation on it. Keep tiered-skip, jump-ahead, conditional gating, persistence, `GAME_RESET`.
- Graduation guarantee preserved: free-clear catches are inherently unguided (the `solo_practice` intent, without a separate beat).

### Phase 4 — Range → Autopilot teaching gate
- First `TARGET_OUT_OF_RANGE` in M1 (GUIDED/POINTERS) posts `range_wall` (sticky `A` chip). Satisfy on `AUTOPILOT_ENGAGE`; payoff via `playAPArrived` + range-flip lock. Reuse `requiresProximityM`/`farNudge` plumbing.
- A player who engages `A` *before* the wall (returning player) trips D.5 de-escalation — the wall coaching never fires.

### Phase 5 — Cluster-clear → orbit-map ΔV handoff
- Ensure M1 cluster size seeds `RewardSystem._fieldTotal` so 100 % bonus + star report fire on the last welcome catch.
- After the ceremony, present/strongly-nudge the orbit map (ΔV per cluster via `DebrisMap.dvMs`). Reconcile `M`/Backquote. HOUSTON ties ΔV to the orbital ladder (the efficiency/replay seed).

### Phase 6 — Guidance toggle + sound + pace
- Settings guidance toggle (Guided / Pointers / Off) via `SettingsManager`; no startup popup (D.3).
- Sound: protect `playTargetLock` as the in-range-only earcon; silence out-of-range; fire lock on the range-flip; verify catch chain order (whoosh→clamp→salvage→ka-ching); cluster-clear sting kept.
- Pace: interactive beats never time-pressure; idle help is the only nudge; tune `IDLE_ESCALATION_MS` per level.

### Phase 7 — Catch-up + telemetry
- Lean on TeachingSystem + SM-2 reminders + Codex for deferred/skipped concepts. Optional funnel telemetry.

---

## PART G — Decisions

**Confirmed (2026-06-17):**
1. ✅ **Guidance levels:** 3-level **GUIDED / POINTERS / MINIMAL** (replaces binary veteran-skip). (D.1)
2. ✅ **Behavior is the primary opt-out** (D.5): advanced actions de-escalate + dismiss the lingering lecture; struggle re-escalates; two-way.
3. ✅ **Pace:** **player-paced, no clock** — interactive beats wait indefinitely; idle-stall escalation is the only nudge. (D.2)
4. ✅ **Camera/attitude keys:** **contextual just-in-time** (D.6) — arrows surface on `STATION_KEEP_ENTERED`/manual-close, scan post-catch, inspect on hazard; an AP-driving player may never see arrows.
5. ✅ **Autolock scope:** **permanent for everyone**, with a Settings toggle to disable. Auto-aim never fades out — keeps the lock-sound reward in every catch and the opening universal.
6. ✅ **Daughters in M1:** **net-only opening**; Daughters (`D`) and the arrows-on-station-keep reminder arrive in a later mission.
7. ✅ **Hotkey + range SSOT:** orbit map opens with **`M`** (reconcile the `DebrisMap` backtick reference); replace the two mismatched catch distances with **one `NET_LOCK_RANGE_M` (~75–100 m)** driving both the in-range/autolock/lock-sound test and net grab.
8. ✅ **First-launch prompt:** **dropped** — behavior detection (D.5) + a Settings guidance toggle suffice; no startup popup. (D.3 simplified accordingly.)

---

## PART H — Risks & test impact
- `OnboardingDirector` + `SkillsSystem` are heavily tested — resequencing and the guidance-level branch must update beat-order/persistence/veteran tests.
- `TargetReticle` is a hot per-frame path — OUT OF RANGE branch must be allocation-free.
- Autolock must not fight manual selection or the `autoTarget:true` comms-skip tag; manual override must be instant.
- Welcome curation must respect M1 hide logic + the `welcomeField` consolidation noted in `ROADMAP.md`.
- Don't regress the live-asset `DO NOT APPROACH` reticle path when adding OUT OF RANGE.
- Gating `playTargetLock` must not double-fire on range-flip + manual reselect.
- Guidance-level auto-derivation must be stable across save/reset and degrade gracefully on corrupted localStorage (default GUIDED).

## PART I — Suggested delivery order
P1 (autolock + OUT OF RANGE) → P2 (welcome curation) → P3 (resequence + guidance levels) → P4 (range→AP gate) → P6 (affordance/sound/pace) → P5 (ceremony→map) → P7 (catch-up/telemetry). P1+P2 alone make the opening demonstrably reward-first and testable; P3 is where cross-persona adaptivity lands.
