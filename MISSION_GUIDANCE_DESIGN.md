# Space Cowboy — Campaign Arc & Mission Guidance Design

**Author:** Architect (Delegation 5)
**Date:** 2026-05-31
**Status:** Design draft. Implementation tickets in §13.
**Predecessors:** Delegation 4 onboarding fixes; [`BIG_PICTURE.md §3`](BIG_PICTURE.md:80) mission architecture; [`FINAL_ANALYSIS.md`](archive/FINAL_ANALYSIS.md:1) orbital ladder; [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md:1) Forge cycle.

---

## 0. The story, in one paragraph

You launch from Kulasekarapattinam in late 2026 as the operator of an autonomous octopus-armed scavenger working a quiet VLEO band. Houston (then Bangalore, then Hassan) talk you through your first catches. After a dozen tons of mass-equivalent fragments, the work expands: defunct boosters in ISS's lane, a Starlink fragmentation event, a Hubble overflight you cannot disturb, a Thaicom 4 contract bound for the GEO graveyard. The economy runs on what you scavenge — indium for thrust today, cesium for the long burns tomorrow. The mission spine runs upward through the orbital ladder. The win condition is not "score" — it is **10,000 kg of refined material delivered to GEO**, where it becomes counterweight for humanity's first space-elevator anchor. The James Webb Space Telescope, 1.5 million kilometres away at L2, watches your handiwork through a borrowed downlink and reports clean skies. The cowboys come home.

---

## 1. Reference index

The campaign arc rests on infrastructure that mostly exists. Critical anchors:

- **Win condition wiring** — [`ShopScreen._contributeToElevator()`](js/ui/ShopScreen.js:535) totals `_contractMassKg`; on cross of [`Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG`](js/core/Constants.js:1) it emits [`Events.CONTRACT_COMPLETE`](js/core/Events.js:229) → [`GameFlowManager`](js/systems/GameFlowManager.js:594) flags `_elevatorWinTriggered=true` → on next [`Events.SHOP_DEPLOY`](js/core/Events.js:155) emits [`Events.GAME_WIN`](js/core/Events.js:1) with `winType: 'elevator'`. Anchor meter renders in [`StatusPanel hud-anchor-mass`](js/ui/hud/StatusPanel.js:528).
- **Mission cadence** — [`ScoringSystem.getMissionNumber()`](js/systems/ScoringSystem.js:463) `= floor(debrisCleared/5)+1`. [`Constants.MISSIONS.PROFILES`](js/core/Constants.js:1893) ramps difficulty in 5 tiers (1, 2, 4, 7, 10). [`GameFlowManager`](js/systems/GameFlowManager.js:856) opens SHOP every 5 captures.
- **Pipeline driver** — [`OnboardingDirector.js`](js/systems/OnboardingDirector.js:38) for M1; per-mission MissionCoach proposed in §6 as the template that scales to all chapters.
- **Comms gate** — [`CommsSystem`](js/systems/CommsSystem.js:1) `_onboardingActive` binary today; promoted to graduated tiers in §5.
- **Skills** — 34 entries in [`Constants.SKILLS.CATALOG`](js/core/Constants.js:1774); `practiced` after `PRACTICE_COUNT_*` uses; `mastered` after `MASTERY_COUNT_*` uses AND `MASTERY_MIN_TIME = 300 s` elapsed.
- **Teaching overlays** — [`TeachingSystem.js`](js/systems/TeachingSystem.js:30); 17 `first_*` moments; persistent dedup in `localStorage['teachingSeen']`.
- **Hint ticker** — [`HintTicker.js`](js/ui/hud/HintTicker.js:1) bottom 88–124 px strip.
- **News-event hooks** — [`data/news-events.json`](data/news-events.json:1) contains AST SpaceMobile tumble, Starlink fragmentation, Thaicom 4 graveyard. Wired via [`MissionEventSystem`](js/systems/MissionEventSystem.js:1).
- **FEEP metal economy** — [`Constants.METALS`](js/core/Constants.js:407) (indium, gallium, bismuth, cesium, tungsten + 4 more). [`ForgeSystem.js`](js/systems/ForgeSystem.js:1) refines salvage into fuel.
- **Mother control mode** — [`Events.CONTROL_MODE_CHANGE`](js/core/Events.js:412) `{ mode: 'RCS'|'COLD_GAS'|'ARM_PILOT'|'MPD_BURST' }`.
- **Real catalog** — [`data/active-sats.json`](data/active-sats.json:1) (ISS, Hubble, Starlink, GPS, Sentinel, JWST entries via NORAD).
- **Active-sat treaty guard** — [`Events.CONJUNCTION_ALERT`](js/core/Events.js:1) with `reason: 'ACTIVE_SAT_ARMING'` blocks arming on protected assets ([`TeachingSystem.first_active_sat_warning`](js/systems/TeachingSystem.js:109)).
- **Forge / Shop progression** — [`ShopScreen.js`](js/ui/ShopScreen.js:1) auto-opens between missions; tutorial pause-point between chapters.

The story arc requires **zero new economy**. It requires **a tighter narrative thread** binding existing systems into a 12-chapter campaign.

---

## 2. The 12-chapter campaign arc

The campaign is one anchor contract with **12 chapters** of escalating difficulty. Each chapter:

- Introduces **exactly one** new tool or concept (the 20%).
- Reinforces the 80% via difficulty profile, not coach pressure.
- Adds **one new altitude band or hazard class** to the player's working envelope.
- Contributes a **mass quota** to the running elevator anchor (cumulative).
- Has a **narrative beat** (mission brief comms, news-event hook, or codex unlock).

The table below is the canonical arc. Mass figures are deliberate — they sum to 9,985–10,150 kg across chapters 2–11, with chapter 12 either banking the final balance (if the player has stockpiled) or running an explicit GEO sortie.

| Ch | Mission name | Altitude band | New tool / concept (20%) | Reinforced (80%) | Anchor mass | Narrative hook |
|---:|---|---|---|---|---:|---|
| **1** | **Orientation** | VLEO 220 km | The toolkit itself (S, Tab, A, N/D, P/R) | — | 5 kg | First contact, first catch. Houston handshake. |
| **2** | **First Operations** | VLEO → LEO-Low | **Daughter piloting** (P → arrows → Space → R, 2× score) | M1 toolkit | 30 kg | Bangalore steps in. "Same toolkit + one new trick." |
| **3** | **Sensor Trade** | LEO-Low 400 km | **Wide Scan (W)** + Codex catalog | M1+M2 | 80 kg | First ISS overflight. "Don't approach 25544 — that's the ISS." First `ACTIVE_SAT_ARMING` lockout. |
| **4** | **Cargo Discipline** | LEO-Low | **Strategic Map (V)** + cluster picking via [`BriefingScreen`](js/ui/BriefingScreen.js:1) | + Wide Scan | 150 kg | Hydrazine event spawns ([`MissionEventSystem`](js/systems/MissionEventSystem.js:140)). Synergy pair bonus. |
| **5** | **ISS Conjunction** | LEO-Low (51.6°) | **Manual burn timing** (Shift/Ctrl throttle) for prograde nudge | + Map | 200 kg + 500 bonus | **First boss event.** 38-h conjunction warning. Clear 6 fragments from ISS forward track. Failure → ISS burns hydrazine; codex unlock + zero bonus. |
| **6** | **The Forge** | SHOP/FORGE (not in flight) | **Forge cycle** — refine salvage into FEEP metals | + manual burn | 300 kg + scrap dump option | First metals out. "Bismuth burns hot — use it now." vs "Cesium for the long way up." |
| **7** | **Inclination Tax** | SSO 780 km / 98° | **Trawl mode (Shift+G)** + plane-change ΔV | + Forge planning | 500 kg | First retrograde-launch site appears in Briefing. Plane change costs documented in comms. |
| **8** | **Hubble Watch** | LEO-Mid 540 km | **Confirm-before-fire** discipline | + Trawl, + Map | 700 kg | Hubble in band. Active-sat clearance teaching moment fires again with higher specificity. |
| **9** | **Starlink Fragmentation** | LEO-Mid/Low | **Dual-arm coordination** (radial menu C → mode select) | + everything | 1,000 kg burst | **News-event boss.** 35 fragments spawn over 5 min. Race against Kessler cascade. Auto-fail-on-tumble rolled into the meta. |
| **10** | **Belt Transit** | MEO 19,000 km (GPS band) | **Radiation-belt management** — timed SAA-pass burn windows | + dual-arm | 1,500 kg | First Van Allen transit. Cesium FEEP minimum. "Hubble shut down its instruments here — you should too." |
| **11** | **GEO Transit** | GEO 35,786 km (Thaicom 4) | **Hohmann window planning** — [`OrbitMFD`](js/ui/OrbitMFD.js:1) porkchop arc | + belts | 2,500 kg | **News-event contract.** Thaicom 4 graveyard boost. Hassan takes the conn. Tungsten + MPD thruster required. |
| **12** | **Anchor Run** | GEO graveyard | **The deposit** — drop refined mass at GEO anchor coordinates | + GEO ops | balance to 10,000 kg | **Win condition.** [`CONTRACT_COMPLETE`](js/core/Events.js:229) fires. Final cinematic: JWST L2 narration. |

**Anchor mass roll-up:** 5 + 30 + 80 + 150 + 700 + 300 + 500 + 700 + 1,000 + 1,500 + 2,500 + ≈ 2,535 to reach 10,000. The mass quotas are *cumulative goals*, not per-mission gates — a player who over-performs in chapter 9 can short-cut later chapters.

**Why exactly 12 chapters and not 6 or 20.** Three constraints:

1. **Skill mastery floor.** [`MASTERY_MIN_TIME = 300 s`](js/core/Constants.js:1726) sets a 5-minute minimum per skill. A 12-chapter arc at ~10 minutes per chapter = 120 minutes total play, which means at least 24 distinct skill-mastery opportunities — enough that every Tier-1 and Tier-2 skill can mature naturally during the campaign without forced grind.
2. **Mission-profile ladder.** [`Constants.MISSIONS.PROFILES`](js/core/Constants.js:1893) already has 5 difficulty tiers tied to mission numbers 1, 2, 4, 7, 10. Twelve chapters lets the arc cross all five tiers with breathing room.
3. **One new thing per chapter.** The codebase contains roughly 12 distinct teachable tools/concepts that aren't part of M1's onboarding. Spreading them out at one per chapter respects the 80/20 rule throughout.

---

## 3. The two-tempo design — "spinning plates"

The campaign feels like spinning plates because it deliberately runs **two overlapping tempos**:

- **Tactical tempo** (seconds): the capture loop — scan → lock → close → catch. Familiar from M1. Players spend most of their attention here.
- **Strategic tempo** (minutes to hours): the elevator-mass meter, Forge cycle progress, ISS-conjunction countdown, weather window, current FEEP fuel type.

A well-paced session is one where the player must briefly **pivot from tactical to strategic** every 30–90 seconds, then drop back. The strategic systems are designed so that letting one slip is recoverable but costly:

| Strategic plate | Spin rate | Drop cost | Recovery |
|---|---|---|---|
| Elevator anchor mass | Continuous, gated by capture | Slow progress | Capture more / dump cargo at next shop |
| Forge cycle | 2–8 min per cycle | Stalled metals | Wait or pay credits to expedite |
| ISS conjunction countdown | 38-h game-time warning | Cosmetic + codex penalty | Decline → ISS reboosts itself (real-world realism) |
| FEEP fuel reserve | Depletes with each Hall burn | Stranded at wrong altitude | Refuel from salvaged xenon/indium |
| Sensor range vs weather | Sudden drop on solar storm | Targets vanish briefly | Wait out the Kp spike (Ground-station comms wisecracks help) |
| Kessler density | Climbs with each chapter, drops with captures | Cascade events | Aggressive clearing in dense bands |

**Plate-spinning is taught, not narrated.** No "ATTENTION — your Forge is idle!" pop-up. Instead the StatusPanel and Codex meters do the work; the player learns to glance at them between catches. The MissionCoach (§6) introduces each new plate with one beat then steps back.

**Critical rule: at most three plates per chapter.** Adding a fourth plate to a chapter where the player is still mastering the third creates frustration spikes. The arc table in §2 is calibrated so that each chapter adds one new plate (the 20%) while the prior plates remain on the same axes.

---

## 4. M1 polish — Chapter 1 of the arc

This section is what the original task brief covered. It is presented here as **the opening chapter** of the campaign, not as a standalone fix.

### 4.1 Already landed in Delegation 4

The Delegation 4 browser-playtest session shipped: `GAME_RESET` clears Director persistence ([`OnboardingDirector._setupListeners`](js/systems/OnboardingDirector.js:390)); `_onboarding:true` tag on Director comms with [`CommsSystem`](js/systems/CommsSystem.js:417) gate; recent-input buffer gated on active beat ([`_onAnyInput`](js/systems/OnboardingDirector.js:633)); reworked beat texts for `inspect`, `decision`, `lasso`, `daughter`, `complete`; `NetInventoryPanel` hidden; `StrutLabels.getWorldPosition` crash fixed; HUD overlay positions corrected.

### 4.2 Pacing audit

Measured analysis of [`Constants.ONBOARDING`](js/core/Constants.js:2136) against playtester feedback ("hints flash briefly and I don't notice"):

| Knob | Current | Recommendation | Reason |
|---|---:|---:|---|
| `IDLE_ESCALATION_MS` | 15 000 | **10 000** | Escalation overlay arrived after the player had spent 15 s pressing wrong keys. 10 s reduces that floundering window. |
| `VETERAN_SKILL_THRESHOLD` | 0.5 | **0.7** | Half of M1's skills are Tier-1 keyboard basics; 50% threshold too easily flagged a returning new player as a veteran. |
| `HintTicker DEFAULT_HINT_MS` | 12 000 | **sticky** | Interactive-beat chips should never auto-fade while the beat is open. Add a `sticky: true` payload field on `HINT_POSTED` honoured by [`HintTicker`](js/ui/hud/HintTicker.js:1). Director sets it on all interactive beats. |
| `decision.autoAdvanceAfter` | 3 500 | **5 500** | 20-word two-concept comms text needs ~6 s to read. |
| `handshake.autoAdvanceAfter` | 2 500 | **3 000** | Marginal increase for non-native English readers. |
| Director timers | raw `setTimeout` | **`TimerManager` with `respectPause: true`** | Pausing the game during a beat currently leaves the escalation timer running. |

### 4.3 Beat-text micro-tweaks beyond Delegation 4

The `arrows` beat ([line 53](js/systems/OnboardingDirector.js:53)) assumes "attitude control" is familiar; rewrite as `"Welcome aboard, Cowboy. Try the arrow keys — they aim your ship."` with escalation `"Arrow keys rotate the ship on its centre of mass. Hold to spin, release to coast. Try all four."`

The `zoom` beat glyph `🖱️ + −` mixes mouse/keyboard symbols awkwardly; use `⊕ ⊖` (Unicode plus/minus circles) to read as keys-or-wheel.

### 4.4 The graduation problem and the solo-flight fix

**Diagnosis.** Today the `lasso` beat triggers on `LASSO_FIRED` and `daughter` on `ARM_DEPLOYED`. Neither implies `DEBRIS_CAPTURED`. A lasso can miss; a deployed daughter takes 30–90 s to land its catch. `ONBOARDING_COMPLETE` therefore fires in a state where the player has **demonstrably never captured anything**, the entire atmosphere channel wakes up at once, the daughter is still in flight, and the player feels abandoned.

**Fix.** Split the current `complete` beat into four:

1. `complete_recap` (narrative, 4 000 ms) — "Catch confirmed. You ran the whole loop — scan, lock, close, capture. Houston is impressed."
2. `solo_intro` (narrative, 3 500 ms) — "You're solo from here, Cowboy. One more on your own — lasso or daughter, your call."
3. `solo_practice` (counter beat) — listens for `DEBRIS_CAPTURED`; satisfies on the **first** capture; `optional: true` with `skipAfter: 90000` so a player who runs out of nets isn't stuck.
4. `final` (narrative, 4 000 ms, `onEnter: 'mastered=true'`) — "That's a real cowboy. Good luck up there."

**Counter beat mechanic.** New field `counterTarget: N` on the beat schema. In [`_onTrigger`](js/systems/OnboardingDirector.js:566), increment `_active.count` and re-post the hint chip (with running tally `×N`) until the target is reached, then call `_satisfy`. `_isAlreadyKnown` returns `false` for counter beats to prevent recent-input-buffer false skips.

**Why counter = 1 and not 2.** The lasso/daughter beat completes on FIRE/DEPLOY; a real capture usually lands during the `complete_recap → solo_intro` auto-advance window (~7.5 s). Asking for 2 *more* captures feels like 3 total to the player. Counter=1 reads as "do it one more time, unguided" — exactly the graduation step.

**No-net edge case.** If [`Events.NET_EMPTY_CLICK`](js/core/Events.js:1) fires while `solo_practice` is active, the Director triggers the optional-skip path with a consolation HOUSTON line: "Out of nets — graduating you anyway, Cowboy." The pipeline still hits `final` and `ONBOARDING_COMPLETE`.

### 4.5 Anchor-mass tie-in for chapter 1

Chapter 1's 5 kg mass quota is achieved by the player's first lasso/daughter capture plus the solo_practice capture. Two fragments at ~2–4 kg each, both pre-tagged `welcomeSpawn:true` in [`DebrisField`](js/entities/DebrisField.js:1) (existing). At the end of chapter 1 the StatusPanel anchor-mass meter reads `5 / 10,000 kg` — the first visible commitment to the elevator goal. The shop screen for chapter 1→2 transition contains a one-line briefing: "5 kg banked. The elevator will need 9,995 more."

---

## 5. Graduated comms suppression and post-onboarding coaching

### 5.1 Three-tier comms ramp

Replace [`CommsSystem._onboardingActive: boolean`](js/systems/CommsSystem.js:359) with `_suppressionTier: 0..3`:

| Tier | Active when | Allowed channels | Suppressed |
|---|---|---|---|
| 0 | Onboarding running | HOUSTON (Director-tagged only) | Everything else |
| 1 | 0–30 s after `ONBOARDING_COMPLETE` | + MISSION (MissionCoach, BANGALORE) | FLAVOR, ALERT, SCI, CMD |
| 2 | 30–60 s after | + ALERT, CMD | FLAVOR, SCI |
| 3 | 60 s+ | All channels live | — |

Tier escalation uses [`TimerManager`](js/systems/TimerManager.js:1)-owned timeouts so `GAME_RESET` cleans them. Tag exceptions: `_onboarding:true` always passes at tier 0; `_postOnboarding:true` always passes at tiers ≥ 1; explicit `_critical:true` (for live-asset warnings) passes at any tier. This is the only mechanism that lets ISS conjunction alerts reach a player still in tier 1.

### 5.2 PostOnboardingCoach — three skill nudges

After graduation, three Tier-2 skills remain undiscovered for most players: Wide Scan (W), Radial Menu (C), post-onboarding inspect (I with a target locked). A new private block inside [`OnboardingDirector`](js/systems/OnboardingDirector.js:1) — `_postOnboardingCoach` — listens for natural triggers and fires a one-shot HOUSTON nudge tagged `_postOnboarding:true`:

| Trigger | Nudge |
|---|---|
| 3rd `SCAN_INITIATED` of type `quick` | "Hold S for Wide Scan — bigger sweep, more candidates." |
| 1st `TARGET_SELECTED` with `mass > 50 kg` | "Press C for the radial menu — choose arm mode and tools." |
| 2nd `TARGET_SELECTED` of any mass | "Press I with a target locked to inspect debris up close." |

20 s minimum gap between coach nudges; each fires at most once per save (persisted in the Director's localStorage blob under `coached:{}`).

### 5.3 Why these three nudges and not more

Beyond these three, every Tier-2+ skill either belongs to a later chapter's MissionCoach pipeline (e.g. Strategic Map at chapter 4) or fires naturally during play (e.g. `nav_throttle` whenever Shift/Ctrl pressed). Adding more post-onboarding nudges would compete with MissionCoach for tier-1 comms bandwidth.

---

## 6. The MissionCoach — one architecture, twelve chapters

### 6.1 Module spec

New file [`js/systems/MissionCoach.js`](js/systems/MissionCoach.js:1). Shares beat-lifecycle helpers with [`OnboardingDirector`](js/systems/OnboardingDirector.js:1) — refactor common logic (`_postBeat`, `_satisfy`, `_escalate`, counter-beat mechanic) into a [`js/systems/_beatLifecycle.js`](js/systems/_beatLifecycle.js:1) module imported by both.

Key behaviours:

- **Trigger on `SHOP_DEPLOY`**, not `MISSION_START`. [`Events.MISSION_START`](js/core/Events.js:62) fires on the first capture of a new mission ([`ScoringSystem._checkAndEmitMissionStart`](js/systems/ScoringSystem.js:451)) — too late to introduce a tool. `SHOP_DEPLOY` fires when the player exits the shop into the upcoming mission, which is the correct hook.
- **Per-mission beat tables** in `Constants.MISSION_COACH.BEATS_BY_MISSION[N]`. Each table is 2–4 beats: opening narrative → 1–2 interactive beats teaching the new tool → optional bonus beat.
- **No tier 0**. MissionCoach operates inside the §5 graduated tiers using `_postOnboarding:true` tags. Optional helper `commsSystem._tempDropToTier(1, 20000)` protects the highest-cognitive-load beat in each chapter (typically beat 2).
- **Persistence** under `localStorage['spacecowboy_mission_coach_v1']` as `{ completedByMission: { 2: ['m2_opening', …], 3: [...], … } }`. `GAME_RESET` clears it.

### 6.2 Per-chapter beat tables (canonical)

Below are the beat tables for chapters 2–11. Chapter 12 is a single-fire `TeachingSystem` cinematic, not a coach pipeline (§9.4).

#### Chapter 2 — First Operations (daughter piloting)

Three beats. The new tool is daughter piloting (P → arrows → Space → R, 2× score multiplier). Filter `CONTROL_MODE_CHANGE.mode === 'ARM_PILOT'` for beat 2; filter `ARM_CAPTURED.manual === true` for beat 3 (requires the §10 wiring fix to include `manual:` in the ARM_CAPTURED payload).

```javascript
BEATS_BY_MISSION[2] = [
  { id: 'm2_opening',  source: 'HOUSTON',    autoAdvanceAfter: 4500,
    commsText: "Welcome back, Cowboy. Two clusters today — same toolkit, plus one new trick." },
  { id: 'm2_pilot_daughter', source: 'BANGALORE', keys: ['KeyP'], glyph: 'P',
    triggerEvent: 'CONTROL_MODE_CHANGE',
    triggerFilter: d => d?.mode === 'ARM_PILOT',
    skillId: 'arm_pilot', credit: 15, sticky: true,
    precondition: 'daughterDeployed',
    commsText: "Next time your daughter's out, take the stick — press P.",
    commsAck: "Pilot link active. Drive her home, Cowboy.",
    escalationText: "Deploy a daughter with D first. Once she's out, press P to steer. R recalls." },
  { id: 'm2_manual_capture', source: 'BANGALORE', keys: ['Space'], glyph: '␣',
    triggerEvent: 'ARM_CAPTURED',
    triggerFilter: d => d?.manual === true,
    skillId: 'arm_pilot_capture', credit: 30, sticky: true,
    optional: true, skipAfter: 120000,
    commsText: "Now the payoff — fire the net manually with Space while piloting. 2× score.",
    commsAck: "Manual catch confirmed. That's pilot pay grade.",
    escalationText: "While piloting (P), steer the daughter within 50 m of the locked target. Reticle goes green. Press Space to fire the net." },
];
```

#### Chapter 3 — Sensor Trade (Wide Scan + ISS proximity)

```javascript
BEATS_BY_MISSION[3] = [
  { id: 'm3_opening', source: 'BANGALORE', autoAdvanceAfter: 4500,
    commsText: "Climbing to 400 km. Heads up — ISS is in this band. Norad 25544. Don't approach." },
  { id: 'm3_wide_scan', source: 'BANGALORE', keys: ['KeyS'], glyph: 'S+', sticky: true,
    triggerEvent: 'SCAN_INITIATED',
    triggerFilter: d => d?.type === 'wide',
    skillId: 'scan_wide', credit: 20,
    commsText: "More targets out there than quick-scan sees. Hold S for Wide Scan.",
    commsAck: "Wide return locked. That's the full board, Cowboy.",
    escalationText: "S is quick scan ($50, 1.5 s). HOLD S for wide scan ($150, 4 s, 4× range)." },
  { id: 'm3_iss_lockout', source: 'HOUSTON', autoAdvanceAfter: 5000,
    precondition: 'firstActiveSatLockout',  // triggers when first CONJUNCTION_ALERT reason==='ACTIVE_SAT_ARMING' fires
    commsText: "Treaty guard kicked in. You can't arm against the ISS — it's a crewed asset. Pick another target." },
];
```

Note beat 3 uses a different precondition mechanic — it lies dormant until the player's natural play accidentally triggers the active-sat lockout, then fires as a *response* to that event rather than a prompt for an action. This is the template for **reactive coaching** — used in chapters 5, 8, 10, 11.

#### Chapter 4 — Cargo Discipline (Strategic Map)

```javascript
BEATS_BY_MISSION[4] = [
  { id: 'm4_opening', source: 'BANGALORE', autoAdvanceAfter: 4500,
    commsText: "Four clusters today. We need 150 kg this mission. Pick smart." },
  { id: 'm4_strategic_map', keys: ['KeyV'], glyph: 'V', sticky: true,
    triggerEvent: 'STRATEGIC_MAP_OPENED',
    skillId: 'strategic_map', credit: 20,
    commsText: "Press V to see the whole field. Drag to rotate, scroll to zoom. Cheap targets glow green.",
    commsAck: "Strategic map up. Pick your line.",
    escalationText: "V opens the full 3D strategic overlay. Closer clusters are cheaper ΔV. Click a cluster to set it as the trawl target." },
  { id: 'm4_synergy_hint', source: 'HASSAN', autoAdvanceAfter: 5000,
    precondition: 'firstSynergyPairFired',  // listens for MissionEventSystem SYNERGY_OPPORTUNITY
    commsText: "Synergy spotted — hydrazine + aluminum in the same cluster. Catch both within 5 min for the bonus." },
];
```

#### Chapter 5 — ISS Conjunction (manual burn timing) — first boss event

Two coach beats plus a reactive overlay system tied to [`MissionEventSystem`](js/systems/MissionEventSystem.js:1) and conjunction alerts.

```javascript
BEATS_BY_MISSION[5] = [
  { id: 'm5_opening', source: 'HOUSTON', autoAdvanceAfter: 6000,
    commsText: "Conjunction alert. Cosmos-1408 fragments on ISS intersect. 38 hours to TCA — game-time. Decision time, Cowboy." },
  { id: 'm5_decision', source: 'HOUSTON', glyph: '?', autoAdvanceAfter: 5500,
    commsText: "Intercept and clear the 6 marked fragments — saves the crew a burn. Decline — ISS reboosts itself. No penalty either way." },
  { id: 'm5_burn_timing', source: 'BANGALORE', keys: ['ShiftLeft','ControlLeft'], glyph: '⇧/⌃', sticky: true,
    triggerEvent: 'THROTTLE_CHANGE',
    triggerFilter: d => d?.level !== 0,
    skillId: 'nav_throttle', credit: 25,
    precondition: 'firstISSInterceptAccept',
    commsText: "Approach phase. Shift/Ctrl gives you fine prograde control — line up early.",
    commsAck: "Burn line accurate. ISS thanks you, Cowboy.",
    escalationText: "Shift increases throttle; Ctrl decreases. Watch the orbit-MFD ellipse — it stretches as you burn." },
];
```

The "Decline" branch sets `_missionDeclined=true` and skips beat 3 entirely. The mission still ends with the 200 kg quota but with no 500-credit ISS bonus. Both branches unlock the `iss_first_dodge` Codex entry.

#### Chapter 6 — The Forge (between-mission, not in flight)

Chapters 1–5 use in-flight coach beats. Chapter 6 is **structurally different**: it's taught at the SHOP/FORGE screen, not in ORBITAL_VIEW. MissionCoach observes [`Events.FORGE_TOGGLE`](js/core/Events.js:1) instead of beat-lifecycle triggers. The teach is a single overlay on the FORGE pane:

```javascript
// Not in BEATS_BY_MISSION — uses TeachingSystem moment with longer duration
TEACHING_MOMENTS.push({
  id: 'first_forge',
  title: 'The Forge',
  body: 'Refine salvaged metals into FEEP fuel. Bismuth burns hot — use it now. Cesium for the long way up.',
  duration: 12000,
  icon: '🔥',
});
```

Plus a follow-up beat that posts when the player closes the FORGE for the first time and lands back in ORBITAL_VIEW: "Forge cycle takes 2-8 minutes. You catch debris while it runs."

#### Chapters 7–11 — same template

Each follows the same 3-beat pattern (opening + skill-teach + reactive). Compressed beat tables:

| Chapter | Beat 1 (opening) | Beat 2 (new tool) | Beat 3 (reactive) |
|---|---|---|---|
| 7 — Inclination Tax | "Going polar today. 98° is retrograde from the launch site." | Trawl mode `Shift+G`, skill `arm_trawl` | First plane-change ΔV cost overlay |
| 8 — Hubble Watch | "Hubble at 540 km. Read before you fire." | Confirm-before-fire — TeachingSystem `first_confirm_fire` overlay | Active-sat lockout fires a second time (reinforcement) |
| 9 — Starlink Fragmentation | "Starlink V2 just broke up. 35 frags coming through your lane. Race." | Radial menu `C` for arm-mode select, skill `radial_menu` | First Kessler cascade warning |
| 10 — Belt Transit | "Crossing the Van Allen. SAA is on the down side." | SAA pass-window prompt (read-only, no key) | First radiation-belt sensor noise event |
| 11 — GEO Transit | "Thaicom 4 contract. Hassan has the conn now." | Hohmann window via OrbitMFD porkchop arc, skill `orbital_hohmann` | First MPD thruster fire — high-power burn ceremony |

Each chapter's beat 2 corresponds to **exactly one** new skill in [`Constants.SKILLS.CATALOG`](js/core/Constants.js:1774). Two skills (`arm_pilot`, `arm_pilot_capture`) ship in chapter 2; new skills required for chapters 4, 7, 9, 11 — see §10.

### 6.3 Why this scales

The MissionCoach is identical code across all 12 chapters. The only data that changes is `BEATS_BY_MISSION[N]`. Designers can add a chapter 13 (or split chapter 9 into 9a/9b) by editing a table — no system rewrite. This is why the §6.1 architecture explicitly separates the lifecycle helpers into a shared module: chapter design becomes content design.

---

## 7. Story-arc pacing — the spinning plates per chapter

The §3 plate framework, expanded chapter by chapter. Each row lists the plates that are *new in that chapter*; prior plates remain on the player's task list.

| Ch | New plate | How introduced | How the player drops it |
|---|---|---|---|
| 1 | (none — single tempo) | — | — |
| 2 | Daughter piloting timer (R-key recall window before max-distance signal loss) | Beat 3 `m2_manual_capture` — first piloting attempt | Daughter strays > max range → `ARM_LOST`. -100 credits, -1 daughter. Recoverable next shop. |
| 3 | ISS-proximity awareness — don't approach within 50 km | Beat 3 `m3_iss_lockout` | `ACTIVE_SAT_ARMING` lockout. No score penalty, just rejection. |
| 4 | Cluster mass quota | Beat 1 `m4_opening` ("we need 150 kg") | Under-quota = no chapter completion. Player must run extra clusters. |
| 5 | TCA countdown (game-time) | Beat 1 `m5_opening` | Miss the window → ISS reboosts. Codex unlock, zero bonus. |
| 6 | Forge cycle | TeachingSystem `first_forge` + chapter-6 follow-up | Letting the Forge sit idle wastes potential metals. Visible meter. |
| 7 | Inclination ΔV economy | Beat 1 + beat 3 reactive | Bad plane change = fuel exhaustion mid-mission. Recoverable via Forge salvage. |
| 8 | Hubble (don't capture) | Active-sat lockout #2 | Same as chapter 3, but tighter — Hubble in narrow band, harder to avoid. |
| 9 | Kessler cascade timer | Beat 3 reactive — first cascade warning | Cascade adds 20-30 fragments. Faster clearing pace forced. |
| 10 | Radiation-belt transit timing | Beat 2 SAA-pass overlay | Mid-transit hit = sensor noise + comms delay for 5 min game-time. |
| 11 | Hohmann window (real game-time minutes per attempt) | Beat 2 porkchop arc | Miss window → +12 h game-time wait. |
| 12 | None — the win itself | — | — |

**Cognitive ceiling.** By chapter 8 the player is juggling 6 active plates simultaneously (anchor mass, FEEP fuel, Forge cycle, ISS/Hubble proximity, cluster quota, Kessler density). [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md:1) confirms this is the design target. The MissionCoach explicitly does NOT teach a new plate in chapters 8 and 12 — the player has caught up; new chapters reinforce instead of introduce.

---

## 8. Protected assets — the live-satellite layer

The "protect live satellites" arc element is enforced by **three coexisting mechanisms** that all already exist or are close:

### 8.1 Active-sat treaty guard

The existing [`ACTIVE_SAT_ARMING`](js/systems/CollisionAvoidanceSystem.js:1) conjunction reason already blocks the player from arming a daughter against any entry in [`data/active-sats.json`](data/active-sats.json:1). On the first lockout, [`TeachingSystem.first_active_sat_warning`](js/systems/TeachingSystem.js:109) fires.

**Chapter binding:**
- Chapter 3 introduces ISS (NORAD 25544). First lockout fires here, locked in by the chapter-3 reactive beat.
- Chapter 8 reinforces with Hubble (20580). Reuses the moment but with a tighter spawn band.
- Chapter 10 introduces GPS constellation (multiple NORADs). Brief overlay only — by now the player understands.
- Chapter 11 introduces commercial GEO sats around Thaicom 4. Same.

### 8.2 ISS dodge contract — the boss event archetype

Chapter 5 is the canonical "save the live asset" mission. It's modeled per [`BIG_PICTURE.md §3.3`](BIG_PICTURE.md:97):

- 38-hour game-time TCA countdown.
- 6 specific Cosmos-1408 fragments tagged `iss_threat: true` spawn in the ISS forward track.
- Player choice: **Intercept** (clear all 6 → 200 kg + 500 credit + "ISS Saver" codex) or **Decline** (ISS performs autonomous 0.5 m/s reboost — no penalty but no bonus, codex entry "ISS PDAM" unlocks).
- Failure path: player accepts intercept but misses TCA. ISS reboosts on its own. Codex: "ISS burned 3 kg hydrazine at ~$40k — your miss cost them." Anchor mass still increments by 200 kg (the player did the work; only the bonus is lost).

**Why not earlier than chapter 5.** Chapters 1–4 need conflict-free room for the player to learn the toolkit. Chapter 5 is exactly when MissionCoach has covered: piloting (ch 2), Wide Scan (ch 3), Strategic Map (ch 4). Player has the tools for the boss.

### 8.3 Hubble watch — the harder version

Chapter 8 raises the difficulty by putting Hubble at 540 km in a narrow inclination band where multiple cluster targets exist nearby. The teach is `first_confirm_fire`:

```javascript
TEACHING_MOMENTS.push({
  id: 'first_confirm_fire',
  title: 'Confirm Before Fire',
  body: 'Hubble shares this band. Inspect (I) every target before you arm — wireframe shows owner_country and asset class.',
  duration: 10000,
  icon: '🔭',
});
```

Inspecting a target (existing [`debrisWireframe`](js/ui/DebrisWireframe.js:1)) reveals the `owner_country` and `is_active` flags. The player must learn to glance at wireframe before pressing D or N.

### 8.4 James Webb at L2 — the codex finale

The James Webb Space Telescope is 1.5 million km away at the Sun-Earth L2 Lagrange point. Reaching it requires interplanetary-scale ΔV that this game does not simulate. So Webb is **never a playable target**. Instead Webb appears in three places:

1. **Codex entry** unlocked at chapter 10's MEO transit: "JWST observes from L2, 1.5M km — 4× the Moon's distance. Out of range, even for cesium FEEP."
2. **News-event flavor** during the chapter 11 GEO transit: a one-line BANGALORE comms line — "JWST L2 confirms clean line-of-sight. Your work is buying their downlinks more bandwidth."
3. **Endgame cinematic** (§9.4) — Webb is the narrator's eye in the final cinematic. "Webb has been watching."

Honouring the user's "protect James Webb" beat without forcing an unrealistic mission preserves the simulation's hard-physics credibility.

---

## 9. The endgame — chapter 12 and the win cinematic

### 9.1 The deposit mechanic

The Space Elevator anchor contract already exists ([`ShopScreen._contributeToElevator`](js/ui/ShopScreen.js:535)). The mechanic is: player visits SHOP, transfers refined cargo into the anchor contract, mass counter ticks up, on cross of 10,000 kg → [`Events.CONTRACT_COMPLETE`](js/core/Events.js:229) → `_elevatorWinTriggered=true` → next SHOP_DEPLOY emits [`Events.GAME_WIN`](js/core/Events.js:1) with `winType: 'elevator'`.

**Chapter 12 reframes this as the final mission.** The shop screen between chapter 11 and chapter 12 surfaces a new UI section: **"GEO Anchor Contract — Finalize."** If the player's cargo + refined-metals + already-contributed mass ≥ 10,000 kg, they can press a single button to deposit and win. If they're short, chapter 12 is **a free-roam GEO graveyard mission** with no time limit and no quota beyond "bank enough kg to cross 10,000."

### 9.2 Why no MissionCoach for chapter 12

By chapter 12 the player has mastered all 12 plates. A MissionCoach pipeline would be insulting. Chapter 12 uses two TeachingSystem overlays only:

- `final_briefing` (12 s, appears on SHOP_DEPLOY into chapter 12): "Hassan: 'You're closer than anyone has ever been. Deposit the mass — the elevator anchor is waiting.'"
- `final_deposit` (8 s, appears on `CONTRACT_COMPLETE`): "Bangalore: 'Anchor seated. We did it, Cowboy.'"

### 9.3 The win cinematic

`GAME_WIN { winType: 'elevator', totalMassKg, missionsCompleted, elapsed }` triggers a new `GameOverScreen` variant for elevator-win (existing GameOverScreen.js variant — currently shows only debris-clear-win). New cinematic copy:

> "10,000 kilograms — refined, scavenged, escorted to GEO. Half of it used to be other people's rockets, the other half their satellites. Earth's first space elevator has its anchor.
>
> Bangalore acquired your final downlink at 03:47 IST.
> Hassan released your contract.
> Webb confirmed clean skies.
>
> The cowboys come home."

Below this: kg-of-debris-delivered as the **final score line** (per the user's spec: "Kg of debris delivered to GEO is the final score"). Format: `Final delivery: ${totalMassKg.toFixed(0)} kg`. Bonus stats: missions completed, total captures, fuel burned, ISS dodge result.

### 9.4 Codex unlocks at win

Three Codex entries unlock at win, irrespective of prior reading:

- "The Space Elevator" — real-world context, Bradley Edwards' 2000 NIAC report, Liftport Group history.
- "What 10,000 kg buys" — at carbon-nanotube tensile strength, 10,000 kg is enough for a 50-km counterweight section. Real numbers.
- "James Webb's perspective" — Webb has been watching since chapter 10.

---

## 10. Skills to add to the catalog

The arc requires these new entries in [`Constants.SKILLS.CATALOG`](js/core/Constants.js:1774) (currently 34; this brings it to ~40). All Tier 3 except as noted; all use the new `triggerFilter` extension (§11.4) for payload filtering.

| Id | Tier | Cat | Trigger | Filter | Chapter |
|---|---:|---|---|---|---|
| `arm_pilot` | 3 | collect | `CONTROL_MODE_CHANGE` | `d.mode === 'ARM_PILOT'` | 2 |
| `arm_pilot_capture` | 3 | collect | `ARM_CAPTURED` | `d.manual === true` | 2 |
| `scan_wide` | 2 | scan | `SCAN_INITIATED` | `d.type === 'wide'` | 3 (already in catalog without filter — extend) |
| `strategic_map` | 3 | nav | `STRATEGIC_MAP_OPENED` | — | 4 |
| `arm_trawl` | 3 | collect | `TRAWL_START` | `!d?.armId && !d?.cluster` (keyboard-initiated) | 7 |
| `radial_menu` | 3 | collect | `RADIAL_MENU_OPENED` | — | 9 |
| `orbital_hohmann` | 4 | nav | `HOHMANN_TRANSFER_EXECUTED` | — | 11 |
| `confirm_before_fire` | 3 | awareness | (no trigger — discovered via teaching moment) | — | 8 |

`PRACTICE_COUNT_COMPLEX = 2` ([Constants line 1723](js/core/Constants.js:1723)) applies to `arm_pilot` automatically. New events for `STRATEGIC_MAP_OPENED`, `RADIAL_MENU_OPENED`, `HOHMANN_TRANSFER_EXECUTED` need wiring in [`Events.js`](js/core/Events.js:1) and emission sites.

---

## 11. Wiring deltas

Concrete codebase changes required by the arc, beyond the M1 polish in §4.

### 11.1 `ARM_CAPTURED.manual` flag

[`ArmUnit._manualCapture`](js/entities/ArmUnit.js:130) is set in [`captureFromStationKeep`](js/entities/ArmUnit.js:1320) and [line 3215](js/entities/ArmUnit.js:3215) but is **not** in the `ARM_CAPTURED` event payload at any of its 5 emit sites ([lines 3316](js/entities/ArmUnit.js:3316), [3424](js/entities/ArmUnit.js:3424), [3475](js/entities/ArmUnit.js:3475), [3820](js/entities/ArmUnit.js:3820), [3955](js/entities/ArmUnit.js:3955)). Add `manual: this._manualCapture` to each. Existing consumers ignore unknown fields — no breaking change.

### 11.2 `SCAN_INITIATED.type`

[`SensorSystem`](js/systems/SensorSystem.js:1) emits `SCAN_INITIATED` but the payload's `type` discriminator must include `'quick'` vs `'wide'`. Audit emit sites.

### 11.3 Legacy pilot nudge gating

[`ArmUnit._pilotNudgeCount`](js/entities/ArmUnit.js:2422) currently emits "Press P to take manual control" on the first 3 daughter deploys. Gate this on `!missionCoach?.isActive() && coach.getActiveBeatId() !== 'm2_pilot_daughter'`. Long-term, delete the legacy nudge after MissionCoach proves stable; for D5 keep dual-path with a clean gate.

### 11.4 SkillsSystem triggerFilter

[`SkillsSystem._setupListeners`](js/systems/SkillsSystem.js:262) currently wires unconditional handlers. Add filter support:

```javascript
on(def.triggerEvent, (data) => {
  if (def.triggerFilter && !def.triggerFilter(data)) return;
  this._onSkillTriggered(def.id);
});
```

### 11.5 Pause-aware timers

Director and MissionCoach timers must run through [`TimerManager`](js/systems/TimerManager.js:1) with `owner=this, respectPause=true` so ESC-pause doesn't keep escalation timers running.

### 11.6 Comms tag exceptions

Add `_critical: true` as a third comms tag (alongside `_onboarding` and `_postOnboarding`) that bypasses all suppression tiers. Use for live-asset conjunction alerts so they always reach the player even at tier 1.

### 11.7 `STRATEGIC_MAP_OPENED` already exists

[`Events.STRATEGIC_MAP_OPENED`](js/core/Events.js:1) is already referenced by [`TeachingSystem first_strategic_map`](js/systems/TeachingSystem.js:130). No new wiring — just bind the new skill to it.

### 11.8 New events to add

- `Events.RADIAL_MENU_OPENED` — emitted by [`RadialMenu`](js/ui/hud/RadialMenu.js:1) on first C-press
- `Events.HOHMANN_TRANSFER_EXECUTED` — emitted by [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) when autopilot mode completes a Hohmann transfer (heuristic: time-of-flight > 1 orbit period)

---

## 12. Three-layer interaction matrix

After all changes, three guidance layers coexist:

1. **OnboardingDirector** — chapter 1 only.
2. **MissionCoach** — chapters 2–11 (chapter 12 is TeachingSystem-only).
3. **TeachingSystem** — single-fire overlays, always-on, queues during D and C.

**Invariants:**

1. At most one of {Director, Coach} active at a time.
2. Tier 0 ⇔ Director active.
3. TeachingSystem queues triggers when D or C active, drains at 1-per-6 s when both idle.
4. `_critical:true` tag bypasses all suppression tiers.
5. `GAME_RESET` clears all queued/pending state in all three.

**Decision rule when a TeachingSystem moment AND a coach beat target the same player action:**
- If Director is active → moment queues; coach beat takes the screen.
- If Coach is active and the moment id matches the beat's `skillId` → moment is **dropped permanently** (Director already taught the skill via the beat; the overlay would be redundant).
- Otherwise → moment queues and drains 6 s after coach beat satisfies.

---

## 13. Implementation tickets

Ordered for delivery. D5-1 through D5-6 are M1/M2 immediate work; D5-7 onward span the arc. Each ticket is 2–6 hours of focused work plus tests.

**Phase A — M1 polish (chapters 1 fundamentals)**

- **D5-1.** M1 pacing knobs + sticky hint chips + pause-aware timers + beat-text tweaks. Tests extend [`test-OnboardingDirector.js`](js/test/test-OnboardingDirector.js:1) (§4.2, §4.3).
- **D5-2.** Solo-flight beats: `complete_recap` / `solo_intro` / `solo_practice` / `final`; counter-beat mechanic; `NET_EMPTY_CLICK` consolation skip (§4.4). New tests for counter satisfy + no-net path.
- **D5-3.** Graduated comms suppression: replace `_onboardingActive` with `_suppressionTier` 0..3; tag exceptions for `_onboarding`/`_postOnboarding`/`_critical` (§5.1). Extend [`test-CommsSystem.js`](js/test/test-CommsSystem.js:1).
- **D5-4.** PostOnboardingCoach with 3 skill nudges (§5.2). Persistence under `coached:{}`. Anti-spam 20 s gap.

**Phase B — Chapter 2 (first MissionCoach)**

- **D5-5.** Wire `ARM_CAPTURED.manual` flag (§11.1) at all 5 emit sites. Add `arm_pilot` + `arm_pilot_capture` skills with `triggerFilter` support (§11.4). New tests.
- **D5-6.** Build MissionCoach module + shared [`_beatLifecycle.js`](js/systems/_beatLifecycle.js:1) helpers + `BEATS_BY_MISSION[2]` table (§6.2). Gate legacy pilot nudge (§11.3). Trigger on `SHOP_DEPLOY`. New `first_arm_pilot` TeachingSystem moment. Tests.

**Phase C — Arc backbone**

- **D5-7.** `BEATS_BY_MISSION[3]` + chapter 3's `m3_iss_lockout` reactive beat. Active-sat skill binding. (Builds on Delegation 4's `first_active_sat_warning`.)
- **D5-8.** `BEATS_BY_MISSION[4]` + Strategic Map skill + cluster picker integration with [`BriefingScreen`](js/ui/BriefingScreen.js:1).
- **D5-9.** Chapter 5 ISS boss event. Conjunction-warning subscriber + 38-h TCA countdown UI. Accept/decline path. Reactive `m5_burn_timing` beat. Bonus mass + Codex unlock.
- **D5-10.** Chapter 6 Forge teach. `first_forge` TeachingSystem moment + chapter-6 follow-up coach beat. Forge-cycle progress bar enhancement.
- **D5-11.** Chapter 7 Trawl + plane-change. Trawl skill. SSO band briefing copy. Plane-change ΔV overlay.
- **D5-12.** Chapter 8 Hubble watch. `first_confirm_fire` TeachingSystem moment. Active-sat lockout #2 (reinforcement, no new Director beat).
- **D5-13.** Chapter 9 Starlink fragmentation news-event boss. Burst-spawn 35 fragments. Kessler-cascade warning beat. Radial-menu skill.
- **D5-14.** Chapter 10 Belt transit. SAA-pass overlay. Radiation sensor noise. Cesium FEEP requirement enforced.
- **D5-15.** Chapter 11 Thaicom 4 contract. Hassan persona handover. Hohmann window porkchop. MPD thruster first-fire ceremony.

**Phase D — Endgame**

- **D5-16.** Chapter 12 "Anchor Run" SHOP UI extension — "GEO Anchor Contract — Finalize" button (§9.1).
- **D5-17.** Win cinematic — new `GameOverScreen` elevator-win variant. Final mass as primary score line. 3 Codex unlocks. JWST narration (§9.3, §9.4).

**Phase E — Polish (lower priority)**

- **D5-18.** Three-layer interaction matrix queue/drain in TeachingSystem (§12). Skill-id matching → drop overlay if coach already taught.
- **D5-19.** Decision-beat centre-screen card (§6.2 chapter 5 + chapter 11). TEACHING_MOMENT_FORCE for highest-cognitive-load beats.
- **D5-20.** Codex polish — JWST entries, ISS PDAM history, real elevator-anchor numbers.

---

## 14. Failure-mode catalogue (arc-wide)

| Scenario | Design response |
|---|---|
| Player rage-quits at chapter 5 ISS boss | `_missionDeclined=true` path is a real path, not a punishment. Codex unlock instead of bonus. |
| Player exhausts FEEP fuel at chapter 10 belt transit | Drift back via station-keeping until next Forge cycle yields more. -1 chapter completion, +recovery comms from Hassan. |
| Player accidentally captures Hubble (active-sat guard fails) | Treaty guard MUST hold. If a bug lets it through: `GAME_OVER { reason: 'treaty_violation' }` + Codex entry "International liability". |
| Player banks 10,000 kg before chapter 11 | Win condition fires immediately on `CONTRACT_COMPLETE`. Skip remaining chapters. (This is by design — speed-run path.) |
| Player saves mid-boss | All MissionCoach state persists. TCA countdown is game-time so save/load preserves it. |
| Player dies during chapter 9 cascade | `GAME_OVER` → retry. Anchor mass preserved across deaths. Mission re-runs. |
| Localstorage corrupted | Graceful fallback — all coach state goes empty. Player gets re-coached. Anchor mass restored from `ScoringSystem` serialization. |
| Player imports save from before Delegation 5 | `completedByMission:{}` defaults; coach pipelines re-fire from current mission number forward. Anchor mass preserved. |
| Win cinematic plays twice (multiple `CONTRACT_COMPLETE`) | `_elevatorWinTriggered` already idempotent ([line 47](js/systems/GameFlowManager.js:47)). |

---

## 15. Summary

**The campaign arc** is a 12-chapter narrative climb from VLEO to GEO, structured around one win condition: 10,000 kg of refined debris-mass deposited at the GEO anchor for humanity's first space elevator. Each chapter introduces exactly one new tool or concept (the 20%), reinforces every prior skill (the 80%), and adds one strategic "plate" to the player's working memory. Live satellites (ISS, Hubble, GPS, JWST-at-L2) are protected by an extended active-sat treaty guard; boss missions in chapters 5, 9, and 11 dramatize the protection. James Webb appears as a narrative narrator at the win cinematic, not as a playable target, preserving physics realism.

**Guidance architecture:**

- **Chapter 1** uses [`OnboardingDirector`](js/systems/OnboardingDirector.js:1) — fully suppressed comms tier 0. M1 polish in §4 (10 s escalation, sticky chips, solo-flight beats, pause-aware timers).
- **Chapters 2–11** use **MissionCoach** — a new module sharing beat-lifecycle helpers with the Director, but operating in graduated comms tiers (§5) so atmosphere chatter is never fully muted. Each chapter has 2–4 beats from [`Constants.MISSION_COACH.BEATS_BY_MISSION[N]`](js/core/Constants.js:1).
- **Chapter 12** uses [`TeachingSystem`](js/systems/TeachingSystem.js:1) overlays only — by then the player has mastered all systems and a coach pipeline would be insulting.
- **TeachingSystem** runs continuously, queuing single-fire overlays when Director or Coach is active and draining at 1-per-6 s when both idle. Skill-id collisions with a satisfied coach beat permanently drop the overlay.

**Pacing as "spinning plates"** is achieved by **two overlapping tempos**: the capture loop (seconds) inside the strategic loop (minutes-to-hours). The player pivots tactical-to-strategic every 30–90 s. At most three plates per chapter; cognitive ceiling reached around chapter 8 (6 plates), no new plate added in chapters 8 or 12 to allow consolidation.

**Win condition** is `contractMassKg >= 10,000` triggering [`Events.CONTRACT_COMPLETE`](js/core/Events.js:229) → win cinematic where **kg of debris delivered to GEO is the final score line** per the user's spec. JWST closes the narration: "Webb confirmed clean skies. The cowboys come home."

**Twenty delegation tickets (D5-1 … D5-20)** are scoped, ordered, and bounded at 2–6 hours each. Phase A (D5-1 to D5-4) is M1 polish, deliverable in the next sprint. Phase B (D5-5, D5-6) ships chapter 2. Phases C and D ship the full arc across roughly 8–10 delegation sessions. Phase E is polish that can be deferred. The codebase has the bones of every system this arc needs; what's missing is the connective tissue of MissionCoach + the per-chapter beat tables + the win cinematic copy.
