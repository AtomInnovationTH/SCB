# Mission Arc Implementation — 12-Chapter Build Contract

> **Status:** Build spec (2026-06-07). Turns the [`MISSION_GUIDANCE_DESIGN.md`](MISSION_GUIDANCE_DESIGN.md) narrative arc into per-chapter tickets a coding team can execute. Depends on [`GUIDANCE_ARBITER_SPEC.md`](GUIDANCE_ARBITER_SPEC.md) (build that first). Absorbs the still-valid chapter-1 onboarding content from the former `FIRST_EXPERIENCE.md` (now archived).
>
> **Grounded in code:** mission number = `floor(debrisCleared/5)+1` (`ScoringSystem.getMissionNumber`); 5 difficulty profiles (`MISSIONS.PROFILES`, keyed `minMission` 1/2/4/7/10); two win conditions (50 debris OR 10,000 kg elevator); active-sat guard over 52 sats (`ActiveSatGuard` in `ArmManager`). See [`ARCHITECTURE.md §11`](ARCHITECTURE.md).

---

## 1. What exists vs what this spec adds

**Exists (reuse, don't rebuild):** mission-number cadence + 5 difficulty profiles; SHOP every 5 clears; `MissionEventSystem` (hydrazine/synergy/kessler/weather/conjunction + 3 news events); elevator contract win path (`ShopScreen._contributeToElevator` → `CONTRACT_COMPLETE`); active-sat treaty guard; BriefingScreen target picker; ForgeSystem dual-metal FEEP.

**Adds (this spec + GUIDANCE_ARBITER):** `MissionCoach.js` engine + `BEATS_BY_MISSION[N]` data tables; ~6 new skills; chapter mass-quota tracking; the boss events (ISS ch5, Starlink ch9, Thaicom ch11); the win cinematic. **No new economy is required** — only connective tissue.

---

## 2. The MissionCoach engine

New [`js/systems/MissionCoach.js`](js/systems/MissionCoach.js) + a shared [`js/systems/_beatLifecycle.js`](js/systems/_beatLifecycle.js) refactored out of `OnboardingDirector` (`_postBeat`, `_satisfy`, `_escalate`, counter-beat).

- **Trigger on `SHOP_DEPLOY`** (player exits shop into the upcoming mission) — NOT `MISSION_START` (fires on first capture, too late to introduce a tool).
- **Per-mission beat tables** `Constants.MISSION_COACH.BEATS_BY_MISSION[N]` — each 2–4 beats: opening narrative → 1–2 interactive skill-teach beats → optional reactive beat.
- **Operates inside the graduated comms tiers** (GUIDANCE_ARBITER) via `_postOnboarding:true` tags; may `_tempDropToTier(1, ms)` to protect the highest-load beat.
- **Persistence** `localStorage['spacecowboy_mission_coach_v1'] = { completedByMission: {2:[...],...} }`; cleared on `GAME_RESET`.
- **Reactive beats** lie dormant until the player's own play trips a precondition (e.g. active-sat lockout), then fire as a *response* — the strongest teaching pattern (experience→consequence→explanation).

A chapter is therefore **data, not code**: adding/splitting chapters = editing `BEATS_BY_MISSION`. This is why the engine is built once and the arbiter is a prerequisite.

---

## 3. Chapter 1 — Onboarding (folds former FIRST_EXPERIENCE.md)

Chapter 1 is owned by `OnboardingDirector` (16 beats), not MissionCoach. The still-relevant onboarding design:

- **Welcome field** — `DebrisField.spawnWelcomeField(playerOrbit)` seeds 7–8 fragments in the player's own orbit on first-ever `MISSION_START` so scan/target beats have guaranteed contacts. *(Implemented.)*
- **Feedback chain** — each action's payoff suggests the next: `S` (ping + targets stream in) → `Tab` (wireframe + reticle) → `A` (transit milestones) → `Space` (catch). *(Implemented; sonar ping/bong scan sounds in AudioSystem.)*
- **Checklist mode (NOVICE)** — SkillsPane shows a persistent "NEXT STEPS" 3-item checklist instead of pop-ins until first capture. *(Implemented via SkillsPane experience-level policy.)*
- **Out-of-order tolerance** — every key works in any order; nothing is punished. *(Implemented.)*
- **Still open (build):** the **solo-flight graduation beats** (`complete_recap → solo_intro → solo_practice → final`) with a `counterTarget:1` counter-beat mechanic, and the `NET_EMPTY_CLICK` consolation skip. These prevent `ONBOARDING_COMPLETE` firing before the player has actually captured anything. *(MISSION_GUIDANCE_DESIGN §4.4 — not yet in code.)*
- **Superseded:** the dormant-opacity HUD reveal (FIRST_EXPERIENCE §8) — progressive luminance dimming is disabled in `HUD._applySkillReveal`; panels render full-bright. Do **not** re-introduce dimming.

Chapter-1 mass quota: 5 kg (two welcome-field fragments) → first visible anchor-meter commitment.

---

## 4. The 12-chapter canonical table

One new tool/concept per chapter (the 20%); everything prior reinforced (the 80%); one new "plate" per chapter; **no new plate in chapters 8 and 12** (consolidation). Mass quotas are cumulative goals toward 10,000 kg, not per-mission gates.

| Ch | Name | Band | New tool/concept (skill id) | Reinforced | Quota | Hook / boss |
|---:|---|---|---|---|---:|---|
| 1 | Orientation | VLEO 220 | the toolkit (onboarding) | — | 5 kg | First contact (Houston) |
| 2 | First Operations | VLEO→LEO-Low | **Daughter piloting** `arm_pilot`, `arm_pilot_capture` | M1 | 30 kg | Bangalore steps in |
| 3 | Sensor Trade | LEO-Low 400 | **Wide Scan** `scan_wide` + Codex | +pilot | 80 kg | First ISS overflight + active-sat lockout |
| 4 | Cargo Discipline | LEO-Low | **Cluster/transfer agency** `strategic_map` (CP-3) | +wide scan | 150 kg | Hydrazine event + synergy pair |
| 5 | ISS Conjunction | LEO-Low 51.6° | **Manual burn timing** `nav_throttle` | +map | 200 +500★ | **BOSS:** 38h TCA, clear 6 frags or decline |
| 6 | The Forge | SHOP/FORGE | **Forge cycle** (FEEP metals) | +burn | 300 kg | Bismuth-now vs cesium-later choice |
| 7 | Inclination Tax | SSO 780/98° | **Trawl** `arm_trawl` + plane-change ΔV | +forge | 500 kg | Retrograde launch site, plane-change cost |
| 8 | Hubble Watch | LEO-Mid 540 | **Confirm-before-fire** (consolidation) | +trawl,+map | 700 kg | Hubble in band; lockout #2 |
| 9 | Starlink Fragmentation | LEO-Mid/Low | **Dual-arm coordination** `radial_menu` | +everything | 1,000 kg | **BOSS:** 35 frags / 5 min vs Kessler |
| 10 | Belt Transit | MEO 19,000 (GPS) | **Radiation-belt timing** (SAA windows) | +dual-arm | 1,500 kg | First Van Allen transit; cesium min |
| 11 | GEO Transit | GEO 35,786 (Thaicom) | **Hohmann window** `orbital_hohmann` (porkchop) | +belts | 2,500 kg | **BOSS/news:** Thaicom 4; Hassan conn; MPD |
| 12 | Anchor Run | GEO graveyard | **The deposit** (win) | +GEO ops | balance→10,000 | Win cinematic; JWST narration |

Quotas sum to ~10,000 by ch12. A player who over-performs early can short-cut later chapters (the elevator win fires immediately on `CONTRACT_COMPLETE`).

---

## 5. New skills to add (`Constants.SKILLS.CATALOG`: 35 → ~41)

All use the `triggerFilter` extension from [`GUIDANCE_ARBITER_SPEC §5`](GUIDANCE_ARBITER_SPEC.md).

| id | Tier | Cat | Trigger | Filter | Ch |
|---|---:|---|---|---|---|
| `arm_pilot` | 3 | collect | `CONTROL_MODE_CHANGE` | `mode==='ARM_PILOT'` | 2 |
| `arm_pilot_capture` | 3 | collect | `ARM_CAPTURED` | `manual===true` | 2 |
| `scan_wide` | 2 | scan | `SCAN_INITIATED` | `type==='wide'` | 3 (extend existing) |
| `strategic_map` | 3 | nav | `STRATEGIC_MAP_OPENED` | — | 4 |
| `arm_trawl` | 3 | collect | `TRAWL_START` | keyboard-initiated | 7 |
| `radial_menu` | 3 | collect | `RADIAL_MENU_OPENED` | — | 9 |
| `orbital_hohmann` | 4 | nav | `HOHMANN_TRANSFER_EXECUTED` | — | 11 |
| `confirm_before_fire` | 3 | awareness | (teaching-moment only) | — | 8 |

New events to add/emit: `RADIAL_MENU_OPENED`, `HOHMANN_TRANSFER_EXECUTED` (`STRATEGIC_MAP_OPENED` already exists). Per-payload flags `ARM_CAPTURED.manual` + `SCAN_INITIATED.type` per the arbiter spec.

---

## 6. Boss events (the protect-the-asset archetype)

- **Ch5 ISS Conjunction** — 38h game-time TCA countdown; 6 `iss_threat:true` Cosmos-1408 frags spawn in the ISS forward track. Player choice: **Intercept** (clear all 6 → 200 kg + 500 credits + "ISS Saver" codex) or **Decline** (ISS autonomous 0.5 m/s reboost — no penalty, "ISS PDAM" codex). Failure path (accept but miss TCA): ISS reboosts, codex "burned 3 kg hydrazine ~$40k," mass still increments, bonus lost.
- **Ch9 Starlink Fragmentation** — news-event burst-spawn 35 frags over 5 min; race a Kessler cascade.
- **Ch11 Thaicom 4** — news-event GEO graveyard contract; Hassan persona handover; MPD thruster first-fire ceremony.

Active-sat guard already protects ISS (25544), Hubble (20580), GPS, etc. from arming. **JWST is intentionally never a playable target** (L2, out of scope) — it appears only as codex + the win-cinematic narrator.

---

## 7. Endgame (ch12) & win cinematic

- ShopScreen surfaces "GEO Anchor Contract — Finalize"; if cargo+refined+contributed ≥ 10,000 kg, one button deposits and wins. Otherwise ch12 is a free-roam GEO mission to bank the balance.
- `GAME_WIN { winType:'elevator', totalMassKg, ... }` → new GameOverScreen elevator-win variant. **Final score line = kg delivered to GEO.** Three codex unlocks (Space Elevator, "What 10,000 kg buys," JWST). No MissionCoach in ch12 (player has mastered everything) — TeachingSystem overlays only.

---

## 8. Build order (maps to ROADMAP CP-4)

| Phase | Ships | Burden |
|---|---|---|
| A | GUIDANCE_ARBITER steps 1–5 (prerequisite) | M–L |
| B | `MissionCoach.js` + `_beatLifecycle.js` + `BEATS_BY_MISSION[2]` + ch2 skills | M |
| C | Chapters 3–7 beat tables + their skills + ISS boss (ch5) | M (S per chapter) |
| D | Chapters 8–11 + Starlink boss (ch9) + Thaicom (ch11) + porkchop (ties to ROADMAP EN-5/6) | L |
| E | Chapter 12 anchor-run UI + win cinematic + codex unlocks | M |
| F | Solo-flight onboarding beats (ch1 graduation, §3) | S |

Each chapter's acceptance test: the one new skill is discoverable via its trigger; the coach beats fire on `SHOP_DEPLOY` into that mission; a veteran sees ticker-only; the mass quota increments the anchor meter; tests stay green.

---

## 9. Failure-mode catalogue (arc-wide)

| Scenario | Response |
|---|---|
| Rage-quit at ch5 boss | Decline path is a real path, not a punishment (codex instead of bonus) |
| FEEP exhausted at ch10 belt | Drift via station-keeping until next Forge yields fuel; −1 chapter, recovery comms |
| Accidental Hubble capture | Treaty guard MUST hold; if a bug slips it → `GAME_OVER{reason:'treaty_violation'}` + codex |
| Bank 10,000 kg before ch11 | Win fires immediately (speed-run path, by design) |
| Save mid-boss | MissionCoach state + game-time TCA persist |
| Localstorage corrupt | Graceful empty coach state; player re-coached; anchor mass restored from ScoringSystem |

*Design predecessor: [`MISSION_GUIDANCE_DESIGN.md`](MISSION_GUIDANCE_DESIGN.md) (full narrative + per-chapter beat JS). This spec is the buildable contract; the design doc remains the prose reference.*
