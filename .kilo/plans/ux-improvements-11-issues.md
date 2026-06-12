# Space Cowboy — UX/Gameplay Improvement Plan (11 issues + mission-clarity)

> Front-to-back analysis of the 11 reported issues plus a derived #12 (mission-completion
> clarity), with root cause and a concrete fix for each, mapped to files/lines.
> Architecture spine: everything talks through `eventBus`; `main.js` owns the loop;
> `GameFlowManager` owns transitions. Net capture is `CaptureNet.js` (FSM) +
> `CaptureNetVisual.js` (THREE render). Mother nav is `AutopilotSystem.js`. Tech library is
> `CodexSystem.js` (113 entries / 11 categories) + `CodexViewerUI.js`.
> Tests: `node js/test/run-tests.js` (Node-only).

## Conventions (must respect — HANDOFF §9/§10)
- `M = 1e-5` (1 m in scene units). Multiply metres by `M` at the Object3D boundary.
- `TIME_SCALE_GAMEPLAY = 10×` silent multiplier; per-tick physics uses `gameDt`.
- `debrisField.update()` runs **before** `armManager.update()`; captured debris is
  re-pinned post-arm-update via `DebrisField.pinCapturedDebris()`.
- `Object3D.lookAt` (+Z fwd) vs `Camera.lookAt` (−Z fwd) — opposite conventions.
- Add tests for every pure-logic change; keep the suite green.

---

## Priority ordering (recommended build order)
1. **#4 Autopilot "trawl in progress" deadlock** (blocks mission completion — P0)
2. **#11 Empty-scan + one-tap re-acquire** & **#12 mission-completion clarity** (never
   stuck / always know what's next — P0/P1)
3. **#1 missed-net feedback + forgiveness** & **#2 / #3 Net visibility + pulsing**
   (capture readability — P1)
4. **#6 Hotkey overlay one-page** + **#8 Forge→5, fuel→6** + **#9 remove C-hold** (polish — P1)
5. **#10 Tech library** + **#7 Strategic map guidance** (teaching surfaces — P2)
6. **#5 City labels toggle** (spectacle — P2)

---

## #4 — Autopilot "A" refuses to fly to last debris / "trawl sweep in progress" (P0)

**Symptom:** `[CommsSystem] … ⚠ AUTOPILOT DENIED — trawl sweep in progress`. Mother
won't autopilot, blocking mission completion.

**Root cause(s):**
- `AutopilotSystem.engage()` ([`AutopilotSystem.js:167`](js/systems/AutopilotSystem.js:167))
  hard-refuses while `this._trawlActive` is true.
- `_trawlActive` is set `true` on `TRAWL_START` (with `.cluster`) and only cleared on
  `TRAWL_SWEEP_COMPLETE` ([`AutopilotSystem.js:1018`/`1026`](js/systems/AutopilotSystem.js:1018)).
- `TrawlManager` sets `this.active=true` on `startTrawl` and emits
  `TRAWL_SWEEP_COMPLETE` only at `_completeSweep` ([`TrawlManager.js:326`](js/systems/TrawlManager.js:326)).
  If a sweep never reaches completion (cluster emptied, target invalid, edge state),
  `_trawlActive` is stuck `true` forever → autopilot permanently denied.
- Secondary: even when no trawl, `engage()` also refuses with "no target selected"
  ([`:186`](js/systems/AutopilotSystem.js:186)). On the *last* debris the auto-target
  may have cleared; the player has no clear path to re-acquire.

**Fix:**
1. **Make trawl-block self-healing.** In `AutopilotSystem`, treat `_trawlActive` as
   advisory: re-derive it from `this._trawlManager.active` at engage time rather than
   trusting a possibly-stuck flag. Replace the guard at `:168` with:
   `const trawlBusy = this._trawlActive && this._trawlManager?.active;` and clear the
   stale flag (`this._trawlActive=false`) when `_trawlManager.active===false`.
2. **Allow override.** When a trawl sweep is genuinely active, a second `A` press (or
   `Shift+A`) should *abort the trawl and engage* rather than just nag. Emit a
   `TRAWL_ABORT` (add to `Events.js`) → `TrawlManager` cancels + emits
   `TRAWL_SWEEP_COMPLETE`. Wire the denial comms to say "press A again to abort trawl".
3. **TrawlManager robustness.** In `TrawlManager.update`, if `active` and the active
   cluster has zero remaining live members (or target lost), call `_completeSweep()`
   (which already emits `TRAWL_SWEEP_COMPLETE`). This guarantees the flag clears.
4. **Last-debris guidance** (overlaps #11): if `engage()` fails on "no target", instead
   of only nagging, auto-select the nearest live debris (reuse
   `AutopilotSystem._findNearestLargeDebris` / `DebrisField.getDebrisNear`) and engage
   in `DEBRIS` mode, OR post an actionable hint "No target — press Tab to select, or
   `Shift+G` cleared".

**Files:** `js/systems/AutopilotSystem.js` (engage guard, listeners), `js/systems/TrawlManager.js`
(`update` auto-complete, abort handler), `js/core/Events.js` (`TRAWL_ABORT`).
**Tests:** extend autopilot trawl-gate test (stuck-flag self-heal, abort-on-second-press);
TrawlManager auto-complete on empty cluster.

---

## #1 — Daughter net misaligned / misses / off to one side (P1)

**Symptom:** when the net is not aligned with debris (off-axis, leading error), the shot
misses and the player gets little feedback / recovery.

**Root cause:** Aim uses lead-prediction (`_updateNettingFSM`: `targetPos + relVel ×
dist/LAUNCH_SPEED`). Intersection is a sphere test: `distScene <= radiusScene`
([`CaptureNet.js:464`](js/entities/CaptureNet.js:464)). If the lead is wrong or the
launch direction is off-axis, the net flies past, hits `MAX_FLIGHT_TIME`/`TETHER_MAX`
→ `_miss('timeout'|'tether_limit')`. The net **does** reel back and inventory is
restored on miss ([`CaptureNet.js:863`](js/entities/CaptureNet.js:863)), so it's
recoverable — but the player isn't told *why* or *what to do*.

**Fix (feedback + forgiveness — user chose feedback + small close-range forgiveness):**
1. **Miss reason → comms.** `NET_CATCH_MISS` already carries `reason`
   ([`:687`](js/entities/CaptureNet.js:687)). Add a `CommsSystem` handler that maps
   reason → plain text: `timeout`/`tether_limit` → "Net overshot — line up the reticle
   and re-fire"; `cling_failed` → "Net grazed it — get closer / detumble (hold U)".
   (CommsSystem already maps `NET_FAILED` at [`:663`](js/systems/CommsSystem.js:663) —
   extend that path with the reason.)
2. **Aim-quality pre-fire readout.** The SK tool HUD already shows `P_cling`. Add a
   simple **alignment indicator**: angle between launch dir and bearing-to-target. If
   off by > threshold, show "OFF AXIS — re-aim" before firing (cheaper than fixing
   physics; teaches the player to align).
3. **Near-miss capture-assist (small, bounded).** Widen the effective catch radius
   slightly when the net mouth *brushes* the target within `CLOSE_RANGE` (the net
   physically wraps a bit beyond its disc). Add `CN.CATCH_RADIUS_FORGIVENESS` (e.g.
   1.25×) applied only at close range, tunable, default conservative. This reduces
   frustrating "1 cm miss" without trivializing aim.
4. **Auto-reel-and-retry stays as-is** (it already restores inventory on miss). Just
   make sure the daughter clearly returns to a re-fire-ready state and the hint says so.

**Files:** `js/entities/CaptureNet.js` (forgiveness radius), `js/systems/CommsSystem.js`
(miss-reason text), SK tool HUD (`DockingReticle.js` tool panel — alignment indicator).
**Tests:** `computeClingProbability`/intersection forgiveness unit; comms miss-reason mapping.

---

## #2 — Net should stay visible during reel-in AND during daughter reattachment (P1)

**Symptom:** net visual vanishes during reel-in / when the daughter re-docks with the catch.

**Root cause (two gaps):**
- **Reel-in:** Already partly fixed — for a *successful* daughter catch the net is
  `_heldByArm` and follows the debris ([`CaptureNet.js:309–339`](js/entities/CaptureNet.js:309)).
  But the visual is removed on `NET_REEL_COMPLETED`/`NET_RELEASED`
  ([`CaptureNetVisual.js:184–193`](js/ui/CaptureNetVisual.js:184)). The hold releases
  when the debris is unpinned (`_capturedByArm` cleared) — which happens at the **chop
  phase** of `HOLDING_CATCH` ([`ArmUnit.js:4481`](js/entities/ArmUnit.js:4481)), not at
  furnace-feed. So the bag can disappear *before* the daughter visibly reattaches/parks.
- **Reattachment / HOLDING_CATCH:** `_updateTether` hides the tether in `HOLDING_CATCH`
  ([`ArmUnit.js:5040`](js/entities/ArmUnit.js:5040)) and the held-net hold ends at chop,
  so there's no net visual during the park while the catch is still full-size.

**Fix:**
1. **Keep the bag through the whole reel + park-until-chop.** Extend the `_heldByArm`
   hold so the net visual persists through `REELING → DOCKING → HOLDING_CATCH` up to the
   chop boundary (`HOLD_S`). Currently the hold ends as soon as `_capturedByArm` is
   cleared; ensure `_capturedByArm` stays set through the `hold` phase (it is set during
   `hold`, cleared at chop — confirm and align so the visual covers the full hold).
2. **Drive the bag from the debris/strut position during the park.** During
   `HOLDING_CATCH` hold phase, the net visual should track the catch (which is pinned to
   the strut via `_pinCatchToSelf`). The `REELING` follow already seats the bag on the
   debris `_scenePosition`; make `CaptureNetVisual` keep rendering while the catch is
   pinned (don't remove on reel-complete if `_heldByArm`/catch still pinned).
3. **Explicit fade at chop.** When the chop begins (`CATCH_BREAKDOWN_START`), the bag
   should visibly draw into the furnace (there's `FurnaceBreakdownVisual` + `NET_CONSUMED`
   for the draw-in) rather than pop out. Ensure the net visual hands off to the breakdown
   visual instead of being culled.

**Files:** `js/entities/CaptureNet.js` (`_updateReeling` hold window), `js/entities/ArmUnit.js`
(`_capturedByArm` lifecycle through hold), `js/ui/CaptureNetVisual.js` (don't remove while
catch pinned; hand off at chop).
**Tests:** FSM timing test — net `_heldByArm` true through REELING→HOLDING_CATCH hold,
released at chop; visual-removal guard (Node-safe: assert via captureNetSystem state).

---

## #3 — Net pulses (expands/contracts) while daughter + debris are attached to mother (P1)

**Symptom:** the net visual visibly pulses during HOLDING_CATCH / docked state.

**Root cause:** The ceremony visual's `SECURE_CHECK` state pulses opacity via
`Date.now()` ([`CaptureNetVisual.js:885`](js/ui/CaptureNetVisual.js:885):
`0.35 + 0.25 * Math.sin(Date.now() * 0.01)`), and several states animate `spinAngle`
and rim-weight radii each frame. If the net visual is still alive while the daughter is
parked at the strut (HOLDING_CATCH) — because of the #2 hold extension or a stale visual
— the rim-weight/cinch animation keeps running, producing the expand/contract pulse. The
net FSM is in `REELING`/terminal but the cling/secure pulse + spin animation never freezes.

**Fix:**
1. **Freeze the bag once captured + parked.** When the net is `CAPTURED`/`REELING` and
   `_heldByArm` (or the catch is pinned at the strut), stop the per-frame `spinAngle`
   advance and the rim-weight radius animation — render a static cinched bag. Gate the
   `vis.spinAngle += …` and `setScalar` calls behind `state !== CAPTURED && !heldByArm`.
2. **No opacity pulse outside SECURE_CHECK.** SECURE_CHECK is a sub-second resolve state;
   the pulse should never be visible during a multi-second park. Confirm the visual is in
   a steady `CAPTURED`/`REELING` appearance (solid green, fixed scale) during the park.
3. **Tie removal to chop** (see #2): once the park's chop starts, hand off to the furnace
   draw-in, so the steady bag never lingers/pulses indefinitely.

**Files:** `js/ui/CaptureNetVisual.js` (`_updateCeremonyState` CAPTURED/REELING freeze;
remove time-based pulse during park).
**Tests:** N/A in Node for THREE; add a guard unit asserting the net projectile reaches
a terminal/held steady state and CaptureNetVisual stops animating (state-flag assertion).

---

## #5 — Earth city labels (on/off toggle) (P2)

**Question:** Is labeling major cities practical? **Yes**, and cheaply.

**Approach:** Earth is a `SphereGeometry(EARTH_RADIUS)` with NASA day/night textures
([`Earth.js:625`](js/scene/Earth.js:625)). **Decision (user):** show labels in **both
command view and the Strategic Map**, off by default, toggled with **`Shift+C`**
(freed up because the C-hold radial is being removed in #9), persisted. Add a curated
`data/cities.json`.

1. Curated list (~20–40 major cities) `{name, lat, lon}` in new `data/cities.json`
   (offline-first preserved). Convert lat/lon → surface point with the same convention as
   `StrategicMap.latLonToPosition` ([`StrategicMap.js:113`](js/ui/StrategicMap.js:113)).
2. Render each city as a **small glowing dot + text name** billboard (DOM/CSS2D label or
   `Sprite`), parented to the Earth group so they rotate with it. **Cull far-hemisphere
   labels** (dot(surfaceNormal, cameraDir) < 0) and fade by distance to avoid clutter
   (user's chosen treatment). Reuse the same city list in the Strategic Map's wireframe Earth.
3. **Toggle `Shift+C`** in command view (and while the Strategic Map is open). Off by
   default; persist on/off in PersistenceManager. Add to HotkeyOverlay "Camera & Views".
4. Performance: update only on meaningful Earth/camera motion; hard cap count.

**Files:** new `data/cities.json`, new `js/scene/CityLabels.js`, wire in `main.js` boot +
`InputManager` (`Shift+C` toggle) + `StrategicMap.js` (reuse list) + `HotkeyOverlay` row.
**Tests:** reuse `latLon→position`; add city-list parse + far-hemisphere cull unit.

---

## #6 — Hotkey overlay (`?`) on one page, no scroll (P1)

**Symptom:** `HotkeyOverlay` is a scrolling grid of 9 cards with ~50 rows — overflows.

**Root cause:** `HOTKEY_GROUPS` ([`HotkeyOverlay.js:16`](js/ui/HotkeyOverlay.js:16)) lists
every binding, body is `overflowY:auto` ([`:214`](js/ui/HotkeyOverlay.js:214)).

**Fix:**
1. **Curate to essentials + a compact "advanced" column.** Collapse duplicate rows
   (`H` and `Shift+O` both "Recall all"; `O`/`Shift+O`; multiple R meanings into one).
2. **Tighten the grid** to a fixed 3–4 column layout sized to fit `maxHeight:760px`
   without scroll; smaller row font/gap; merge "Power Distribution" + "System" cards.
3. **Two-tier reveal:** show core groups by default; a "More ▸" link expands advanced
   (daughter-pilot) — OR simply ensure the curated set fits one screen at 1080p.
4. Verify against the **authoritative** binding list in `InputManager._handleKeyDown`
   and ARCHITECTURE §6 so the overlay doesn't drift. Update F4→5 (see #8) here too.

**Files:** `js/ui/HotkeyOverlay.js` (groups + layout). No new tests (DOM-only); manual
verify no scrollbar at 1366×768 and 1920×1080.

---

## #7 — Strategic map needs guidance (P2)

**Symptom:** `StrategicMap` (Shift+V) shows bands/debris/hazards/MOID but doesn't guide
the player ("what do I do here?"). It's also view-only (can't select clusters — DebrisMap
does that).

**Root cause:** `StrategicMap.js` renders data + a threat list but has no actionable
prompts, no "cheapest next target", no legend-to-action bridge. Cluster selection +
transfer-window agency live in `DebrisMap` (CP-3), creating a split-brain UX.

**Fix:**
1. **Add a guidance panel** (DOM overlay, like the existing threat list): "RECOMMENDED
   NEXT" — pick the lowest-ΔV / highest-value reachable cluster (reuse
   `LaunchWindow.computeTransferWindow` + MOID), with a one-line "why" and a
   `[Engage in Debris Map]` pointer (or wire selection directly).
2. **Legend → meaning tooltips.** Hover a band/threat → short teaching line
   (reuse `LEARNING_THROUGH_PLAY` concepts; tie to MOID/SSO/ISS bands).
3. **On-open hint:** first-time `STRATEGIC_MAP_OPEN` posts a comms/overlay: "Red = high
   MOID threat. Green stations = downlink. Pick your next cluster, then `Shift+A`."
4. **Unify or cross-link with DebrisMap:** **Decision (user):** keep cluster selection in
   the Debris Map (avoid split-brain). The Strategic Map stays view-only but adds a clear
   callout: "Cluster selection is on the Debris Map (`` ` ``) → then `Shift+A` to engage."
   The guidance panel's recommendation points the player there. (No `engageCluster` from
   StrategicMap.)

**Files:** `js/ui/StrategicMap.js` (guidance panel + tooltips + open hint), reuse
`js/entities/LaunchWindow.js`, `MoidCalculator`. Optional `Events.STRATEGIC_MAP_OPEN`.
**Tests:** pure "recommend next cluster" scorer (ΔV/value/MOID) unit.

---

## #8 — Furnace key F4 → "5" (number keys 1–4 are daughters) (P1)

**Symptom:** Forge is `F4`; player wants `5` (since `1–4` select daughters and `5` is free).

**Root cause:** Forge bound to `case 'F4'` ([`InputManager.js:790`](js/systems/InputManager.js:790)).
Number keys `1–4` select/pilot arms; `7` returns to mother. `5` and `6` appear unused for
arm selection (Y0 has 4 arms).

**Decision (user):** Replace F4 with `5`, **and move fuel-cycle F5→`6`**. Remove the
`F4`/`F5` bindings entirely (no aliases).

**Fix:**
1. Add `case 'Digit5':` → `FORGE_TOGGLE` and `case 'Digit6':` → fuel-cycle (the event
   currently behind `F5`), both gameplay-guarded. **Remove** the `case 'F4':`
   ([`InputManager.js:790`](js/systems/InputManager.js:790)) and the `F5` fuel-cycle case.
2. Guard ARM_PILOT: in ARM_PILOT `1–4` switch piloted daughter; `5`/`6` are free there —
   ensure Forge/fuel on `5`/`6` work (or are intentionally inert) in ARM_PILOT without
   colliding with arm-switch. `F2` (metal cycle in ARM_PILOT) is unaffected.
3. Update **all surfaces**: README key table ([`README.md:212`](README.md:212)),
   ARCHITECTURE §6 ([`ARCHITECTURE.md:204`](ARCHITECTURE.md:204)), `HotkeyOverlay`
   "System" card ([`HotkeyOverlay.js:132`](js/ui/HotkeyOverlay.js:132)), StatusPanel
   inline "Forge F4" label, and the DAUGHTER section's `F5`/`F2` references.

**Files:** `js/systems/InputManager.js`, `js/ui/HotkeyOverlay.js`, `js/ui/hud/StatusPanel.js`
(inline forge label), README.md, ARCHITECTURE.md.
**Tests:** InputManager key-dispatch test: `Digit5`→`FORGE_TOGGLE`, `Digit6`→fuel-cycle;
assert `F4`/`F5` are no longer handled.

---

## #9 — Press-and-hold `C`: what does it do? Needed / useful / obsolete? (P1)

**What it does:** Tap `C` = focus/expand comms; **hold `C`** (≥ `COMMS.C_HOLD_THRESHOLD_MS`)
opens the **RadialMenu** ([`InputManager.js:1016`](js/systems/InputManager.js:1016) →
`COMMS_RADIAL_OPEN`). The radial offers: Deploy Weaver/Spinner, Fish, Recall All,
Pilot [P], Deorbit [D] ([`ARCHITECTURE.md:223`](ARCHITECTURE.md:223)).

**Assessment:** **Useful but redundant** — every radial action already has a direct key
(`D` deploy, `H`/`Shift+O` recall, `P` pilot, `Ctrl+Shift+D` deorbit). The tap/hold
discrimination on `C` also adds input latency to the common "expand comms" tap.

**Decision (user): REMOVE the hold-radial entirely.** Rely on direct keys + the `?`
overlay (which #6 makes a clean one-page reference).

**Fix:**
1. In `InputManager` `case 'KeyC'`, drop the `setTimeout` hold-timer / `COMMS_RADIAL_OPEN`
   path ([`:1016`](js/systems/InputManager.js:1016)) and the C-release hold branch
   ([`:1469`](js/systems/InputManager.js:1469)). `C` becomes a plain tap → expand/focus
   comms with **zero hold delay**. Remove `_cHoldTimeout`/`_cRadialOpen`/`_cKeyDownTs`
   state.
2. Retire the `RadialMenu` wiring (stop constructing/init in `main.js`; keep the file or
   delete — prefer removing dead wiring per the orphan-trap guidance). Remove its
   `COMMS_RADIAL_OPEN`/close listeners.
3. Update `HotkeyOverlay` Comms card: drop the "Hold: comms radial" row; `C` = expand
   comms only ([`HotkeyOverlay.js:104`](js/ui/HotkeyOverlay.js:104)).
4. Update ARCHITECTURE §6 + §7 (RadialMenu) and README to reflect removal.

**Files:** `js/systems/InputManager.js`, `js/ui/hud/RadialMenu.js` (remove wiring),
`js/main.js` (drop construction/init), `js/ui/HotkeyOverlay.js`, ARCHITECTURE.md, README.md.
**Tests:** InputManager test: `C` tap toggles comms, no radial event emitted on hold.

---

## #10 — Tech library (Codex) more user-friendly (P2)

**Current:** `CodexViewerUI` (L) — sidebar categories + card grid + detail
([`CodexViewerUI.js`](js/ui/CodexViewerUI.js)). `CodexSystem` has **113 entries / 11
categories**; entries are `unlocked:false` by default and revealed *whole* on a trigger
event (`_performUnlock` [`CodexSystem.js:2002`](js/systems/CodexSystem.js:2002)). Locked
cards show `???` with a **blurred title** ([`CodexViewerUI.js:294`](js/ui/CodexViewerUI.js:294))
and "Discover through gameplay". TRL 1–9 with 4 tier words (Flight-proven/Mature/Research/
Speculative) in `Constants.TRL` ([`Constants.js:2371`](js/core/Constants.js:2371)).

### Decisions (user)
- **Reveal model: title + 1-liner ALWAYS visible; depth (fullText + rationale + Tech-Level
  detail) earned through play.** The library becomes a visible "syllabus" / roadmap — you
  always see *what topics exist*, but the explanation unlocks when you encounter the
  concept. (Removes the `???`/blur entirely.)
- **Relabel "TRL" → "Tech Level 1–9" + tier word** everywhere player-facing (cards, detail,
  shop, tooltips). Keep the 1–9 number and the 4 tier words; drop the "TRL" acronym.
- **Nav upgrades to build:** live search, per-category progress (e.g. `Propulsion 3/7`),
  and "how to unlock" hints on locked entries. (Sort/filter chips + cross-links deferred.)

### Fix
1. **New reveal model.** Show every entry's `title`, `icon`, `category`, and `shortText`
   regardless of unlock. Replace the `isLocked` blur/`???` branch
   ([`CodexViewerUI.js:270–299`](js/ui/CodexViewerUI.js:270)) with a "locked-depth"
   style: card readable but visibly *not-yet-detailed* (dimmed border, a small 🔒 on the
   Tech-Level badge / detail body). Detail view: if not unlocked, show the 1-liner + the
   **how-to-unlock hint** + a greyed "Full briefing unlocks when you ___" instead of
   `fullText`.
2. **How-to-unlock hints.** Add a `unlockHint` string per entry in `CodexSystem`
   (human phrasing of the `triggerEvent`/`triggerCondition` intent, e.g. "First Hohmann
   transfer", "Scan a debris field", "Engage autopilot"). Surface on the locked detail
   view + as a card tooltip. (Authoring task: ~113 short hints; can default to a generic
   per-category hint and override the important ones first.)
3. **Tech-Level relabel.** Add `trlToTechLevelLabel()` (or reuse `trlToLabel`) and change
   UI strings: badge `TRL n` → `Tech Lvl n`, header tooltips "NASA Technology Readiness
   Level" → "Tech Level (real-world readiness)". Keep `Constants.TRL` keys internally;
   only the *presentation* changes. Apply the same relabel in **ShopScreen** TRL badges so
   the vocabulary is consistent across the game.
4. **Live search box** in the header (filter title/shortText/category as you type; works
   across all categories, ignores the sidebar selection while a query is active).
5. **Per-category progress** in the sidebar tabs (`getCategoryProgress(cat)` →
   `{unlocked,total}`; render `Propulsion 3/7`) + keep the global header count
   (`getProgress` already exists [`CodexSystem.js:2102`](js/systems/CodexSystem.js:2102)).
6. **Reading polish (light):** wider detail column, keyboard nav (arrows/Enter/Esc).

**Files:** `js/ui/CodexViewerUI.js` (reveal model, search, progress, relabel, hints),
`js/systems/CodexSystem.js` (`unlockHint` data + `getCategoryProgress`), `js/ui/ShopScreen.js`
(Tech-Level relabel), optionally `js/core/Constants.js` (a `TECH_LEVEL` label alias).
**Tests:** `CodexSystem` getters (per-category progress, unlockHint presence); pure
`trlToTechLevelLabel` mapping. UI rendering is DOM-only (manual verify).

---

## #11 — Mother drifts out of range of all debris / empty scan → no guidance (P0/P1)

**Symptom:** scan shows empty, no debris in range, player doesn't know where to go next.

**Root cause:** There is *some* first-experience guidance (`GameFlowManager`
drift_recovery one-shot at [`:1158`](js/systems/GameFlowManager.js:1158); opening
"Multiple contacts nearby" hint) but **no persistent "you're lost" recovery**. Once the
one-shot `_firstTimeComms` flags are consumed, an empty scan / out-of-range state produces
silence. `SensorSystem` computes an `'empty'` reward kind ([`SensorSystem.js:425`](js/systems/SensorSystem.js:425))
but doesn't route it to actionable guidance.

**Fix (a small, reusable "Navigator/Recovery advisor") — user chose bearing + one-tap re-acquire:**
1. **Empty-scan → directions with bearing.** On a scan that finds nothing in range
   (`SensorSystem` 'empty' result [`SensorSystem.js:425`](js/systems/SensorSystem.js:425)),
   post a HOUSTON line with **bearing + distance** to the nearest live debris / next
   recommended cluster (reuse `AutopilotSystem._findNearestLargeDebris` + a pure
   bearing helper; `LaunchWindow`/cluster recommend for clusters). E.g. "Nearest contact
   ~12 km, prograde-low — press A to approach."
2. **Out-of-range watchdog.** Add a lightweight advisor (extend the `ArmIdleAdvisor`
   pattern, or a new `NavRecoveryAdvisor`) that, when the player has no selected target
   AND no live debris within sensor range for N seconds, fires a single throttled hint
   pointing at the nearest contact + the Debris/Strategic map. Respect the universal
   hint-gating rule (`SkillsSystem.canFireHint`) so veterans aren't nagged.
3. **One-tap re-acquire (the key affordance).** Pressing **`A` with no target** should
   (per #4 fix) **auto-select the nearest live debris and engage** in one press — never a
   dead end. If literally nothing is alive in the field, fall through to map guidance.
   (This is the "Bearing + one-tap re-acquire" choice: guidance text PLUS the single-key
   recovery.)
4. **Mission-complete vs lost disambiguation.** If the field is genuinely cleared toward a
   win condition (50 debris / contract), post the mission-progress line (see #12), not a
   "lost" hint.

**Files:** `js/systems/SensorSystem.js` (route 'empty' → guidance event), new/extended
advisor (`js/systems/ArmIdleAdvisor.js` sibling), `js/systems/AutopilotSystem.js`
(nearest-target fallback), `js/systems/GameFlowManager.js` (persistent recovery, not just
first-time). Reuse `LaunchWindow`/cluster recommend.
**Tests:** advisor trigger conditions (no target + empty range + cooldown), pure
nearest-debris bearing helper, empty-scan→event mapping.

---

---

## #12 — Mission completion clarity (NEW — persistent objective + milestone comms) (P1)

**Why:** Two win conditions exist — **50 debris cleared** and **10,000 kg refined metal to
the elevator contract** ([`ARCHITECTURE.md:289`](ARCHITECTURE.md:289)) — but progress is
easy to lose track of, so completion feels ambiguous (related to #4/#11 "what next?").

**Current:** StatusPanel has a body-mounted "CLEARED n/50" + credits bar
([`ARCHITECTURE.md:220`](ARCHITECTURE.md:220)). No periodic milestone calls; the elevator
contract progress lives only in the ShopScreen.

**Decision (user): persistent objective HUD + milestone comms.**

### Fix
1. **Always-visible dual objective line.** Ensure the HUD objective bar shows BOTH win
   tracks at a glance: `CLEARED n/50` and `CONTRACT x,xxx / 10,000 kg`. Keep it compact;
   it's the player's "am I winning?" anchor every frame.
2. **Milestone comms** at 25 / 50 / 75 / 90% of *either* track — HOUSTON/MISSION lines via
   the comms arbiter (`_postOnboarding`/MISSION channel so they pass suppression). E.g.
   "Halfway — 25 of 50 cleared" / "Contract at 7,500 kg — one good cluster to go."
3. **Clear "next mission" prompt at the shop.** On `SHOP_DEPLOY`, post a one-line recap +
   recommended next cluster (reuse the #7 recommender + #11 nearest-contact). MissionCoach
   already runs on `SHOP_DEPLOY` — hook the prompt there to avoid a new system.
4. **Win/again handoff:** the GameOverScreen already rates WIN; ensure the final objective
   state reads unambiguously (which condition completed).

**Files:** `js/ui/hud/StatusPanel.js` (dual objective line), `js/systems/GameFlowManager.js`
or `js/systems/ScoringSystem.js` (milestone-threshold emitters), `js/systems/MissionCoach.js`
(shop next-step prompt), `js/systems/CommsSystem.js` (milestone line text/tags).
**Tests:** pure milestone-threshold crossing emitter (fires once per threshold per track);
objective-string formatter.

---

## Cross-cutting notes
- **Comms suppression:** new guidance lines must use the right tags so the CP-4 arbiter
  (`commsSuppression.js`) lets them through (`_critical` for safety, `_postOnboarding`
  for coaching) and so veterans get ticker not modal.
- **Offline-first:** any new data (cities) is a local JSON; no network.
- **Drift discipline:** when keys change (#8) update README + ARCHITECTURE §6 + drift
  table in the same change.
- **Vocabulary consistency:** the Tech-Level relabel (#10) must be applied to BOTH the
  Codex and ShopScreen so "TRL" doesn't survive anywhere player-facing.
- **Test baseline:** run `node js/test/run-tests.js` after each change; keep 0 failures.

## Suggested sequencing into shippable slices
- **Slice A (P0):** #4 + #11 + #12 (autopilot/trawl self-heal + empty-scan/lost guidance +
  one-tap re-acquire + objective clarity — the "never stuck, always know what's next" set).
- **Slice B (P1):** #2 + #3 (net visibility through reel/park + stop the pulse) + #1
  (miss feedback + close-range forgiveness).
- **Slice C (P1 polish):** #6 (one-page hotkeys) + #8 (Forge→5, fuel→6) + #9 (remove C-hold).
- **Slice D (P2):** #10 (tech library reveal + Tech-Level relabel + search/progress/hints) +
  #7 (strategic map guidance) + #5 (city labels).

## Resolved decisions (from user)
1. **#8:** Forge → `5`, fuel-cycle F5 → `6`; remove `F4`/`F5` (no aliases).
2. **#9:** Remove the C-hold radial entirely; `C` tap = expand comms (zero delay).
3. **#5:** City labels in command view **and** Strategic Map; toggle `Shift+C` (off by
   default, persisted); curated `data/cities.json`; **dot + text label, far-hemisphere culled**.
4. **#1:** Feedback (miss-reason comms + alignment indicator) **plus** a conservative
   1.25× close-range catch-radius forgiveness.
5. **#7:** Strategic Map guides to the Debris Map; **no** direct cluster selection added.
6. **#10 reveal:** Title + 1-liner ALWAYS visible; full depth/rationale earned (drop `???`/blur).
7. **#10 vocabulary:** Rename "TRL" → "Tech Level 1–9" + tier word (Codex + Shop).
8. **#10 nav:** Live search + per-category progress + "how to unlock" hints (sort/filter
   chips + cross-links deferred).
9. **#11:** Bearing + distance guidance AND one-tap re-acquire (`A` with no target
   auto-selects + engages nearest live debris).
10. **#12:** Persistent dual-objective HUD + milestone comms + shop next-step prompt.
