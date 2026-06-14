# Plan: Soften Violent Terminology (User-Facing Strings Only)

## Goal
Make the game's **player-visible language** less violent / weapon-like, leaning into the
Mother/Daughter theme and positive-neutral words. Per the user's scope decision this touches
**user-facing strings only** — no code identifiers, event names, constants, comments, file
renames, or design docs.

## Confirmed scope
- **Layer:** User-facing strings only (HUD/canvas labels, comms & mission dialogue, shop,
  codex, teaching cards, on-screen hints, displayed emoji). Low risk.
- **Terms in scope:** `crossbow`, `arm`/`arms`, `fire` (weapon sense). Everything else
  (`recoil`, `barrel`, `boss`, `grapple`, `harpoon`, `net`, `lasso`, `target`, lasers) is
  **left as-is**.

## Term mapping (apply to displayed text only)
| From (displayed) | To |
|---|---|
| `🏹` (crossbow/bow emoji) | `🛰️` (neutral satellite) |
| `CROSSBOW FLEET` | `DAUGHTERS` (the fleet of arms = the daughters) |
| `Crossbow Arm(s)` / standalone `arm`/`arms` referring to the units | `Daughter(s)` |
| `CROSSBOW SPRINGS` / `CROSSBOW SPRING` | `CRADLE SPRINGS` / `CRADLE SPRING` |
| `V5 CROSSBOW` (mother config title) | `V5 CRADLE` |
| `crossbow` (mechanism, in prose) | `cradle` |
| `fire` / `firing` (weapon sense: "fire the net", "first fire", "refuse to fire", "Dual-fire") | `launch` / `release` |

Notes / coherence:
- `cradle` = the spring mechanism that gently holds and releases daughters (positive, maternal,
  fits Mother/Daughter theme; this was the option chosen).
- Where the crossbow metaphor appears in the **same sentence** as `bolt` (the crossbow
  projectile = the launched daughter), rewrite for coherence so the prose still reads cleanly
  (e.g. "accelerates the 2–7 kg bolt" → "accelerates the 2–7 kg daughter"). `bolt` is part of
  the crossbow vocabulary, so neutralizing it here is in-spirit. `recoil` stays (out of scope)
  but read each rewritten sentence to ensure it isn't left dangling.

## MUST NOT change (leave untouched)
These appear in the same files and must be preserved so the game keeps working:
- **Code identifiers:** class names (`ArmUnit`, `ArmManager`), variables/props
  (`isCrossbowFireSafe`, `_crossbowFireFlash`, `renderArmPanel`).
- **Event names / keys:** `Events.CROSSBOW_FIRE`, `ARM_*`, `LASSO_FIRED`, `NET_FIRED`,
  `DUAL_FIRE`, codex/teaching `id:` and `triggerEvent:` values.
- **Constant names & values:** `CROSSBOW_*`, `FIRE_RATE_INTERLOCK`, `ARM_STATES`, etc.
- **Comments** (`// V5 Crossbow ...`, `// crossbow fire flash`).
- **CSS selectors / HTML ids/classes** in `index.html` and template strings
  (`.arm-hover-detail`, `#hud-arms-panel`).
- **Non-violent "fire"** tokens: `fire-and-forget`, event "fired"/"Fired", battery "fire risk",
  audio envelope "attack".
- **Substring false positives:** `skill`, `warm`, `alarm`, `harm`, `barrel`/`recoil` (out of
  scope), `event.target`/render `target`.
- **Tests, design docs (`*.md`), and `archive/`** — out of scope EXCEPT see "Tests" below.

## Known edit locations (user-facing strings)

### UI / HUD (canvas + HTML)
- `js/ui/hud/StatusPanel.js`
  - L516: `🏹 CROSSBOW FLEET` → `🛰️ DAUGHTERS`.
  - Arm status panel: any displayed `ARM`/`Arm N`/`arms` labels → `Daughter`/`Daughters`.
- `js/ui/ShopScreen.js`
  - L618: `🏹 CROSSBOW SPRINGS` → `🛰️ CRADLE SPRINGS`.
  - Category `cat: 'Arms'` (tab) and item text: `Arm Fuel Reserve`, `+50% arm FEEP fuel`,
    `Faster arm docking`, `${tier.armCount} arms ...` stat lines, confirm-dialog
    `replaces ALL current arms` → use "Daughter"/"Daughters".
  - **Edge case:** `cat: 'Arms'` is both a display label AND a grouping key (`.shop-arm-tier-btn`,
    `querySelectorAll`). Safest: keep the internal grouping key/CSS class as `Arms` and only
    change the **rendered tab label** to "Daughters" (introduce a label map or change the
    display-only string). Do NOT blindly rename the key everywhere — verify all comparisons.
- `js/ui/MotherWireframe.js`
  - L461: `ctx.fillText('V5 CROSSBOW [V]', ...)` → `'V5 CRADLE [V]'`.
  - L282: zone `name: 'Crossbow Arms'` → `'Daughters'`. **This name is also the dictionary key
    used at L548** (`if (zone.name === 'Crossbow Arms' ...)`) — update both consistently, OR
    keep the key and map the display label. (Also see Tests below.)
- `js/ui/MotherCallouts.js`
  - L140: callout `name: 'CROSSBOW SPRING'` → `'CRADLE SPRING'`.
- `js/ui/HUD.js`
  - Displayed warnings/prompts referencing weapon-`fire` (e.g. STABILIZE-for-fire warning text,
    net-launch prompts). Change **strings only**; leave the `// V5 Crossbow ...` comments and
    the `isCrossbowFireSafe()` call.
- Sweep other display-bearing UI for in-scope tokens in **rendered strings**:
  `js/ui/HotkeyOverlay.js`, `js/ui/NavSphere.js`, `js/ui/DockingReticle.js`,
  `js/ui/DebrisMap.js`, `js/ui/SweepReportUI.js`, `js/ui/hud/NetInventoryPanel.js`,
  `js/ui/hud/TargetPanel.js`, `js/ui/hud/SkillsPane.js`, `js/ui/DaughterWireframe.js`.

### Codex / Teaching content
- `js/systems/CodexSystem.js` — entries' `title`, `shortText`, `fullText`, `icon` (NOT `id`/
  `triggerEvent`). Known: the `crossbow_arms` entry (L782–788, `🏹`) and `recoil_cancellation`
  (L791–794, "Dual-fire launches two bolts"). "crossbow arms" → "cradle / daughters",
  "Dual-fire" → "Dual-launch", `🏹` → `🛰️`, "bolt(s)" → "daughter(ies)" for coherence.
- `js/systems/TeachingSystem.js` — cards' `title`, `body`, `icon`. Known: L146 title
  `'Crossbow Arm Deployed'` → `'Daughter Deployed'`; L147 body ("Arms capture...", "launched
  daughter") → daughter wording; L149 `icon: '🏹'` → `'🛰️'`.

### Mission / comms dialogue
- `js/core/Constants.js` — mission script `text:` fields. Known lines: 2812, 2818, 2832, 2882,
  3084 (e.g. "the arm will refuse to fire on her" → "the daughter will refuse to launch on
  her"; "confirm every target before you fire" → "...before you launch"; "First fire is yours"
  → "First launch is yours"; "press N to fire the net" → "press N to launch the net"). Scan the
  whole mission-script block for additional `arm`/`fire` in `text:`.
- Comms emitters (search each for displayed `COMMS_MESSAGE`/comms `text:`/hint/label strings
  containing in-scope tokens; change strings only): `MissionCoach.js`, `OnboardingDirector.js`,
  `MissionEventSystem.js`, `MissionMilestones.js`, `CommsSystem.js`, `ArmIdleAdvisor.js`,
  `NavRecoveryAdvisor.js`, `AutopilotSystem.js`, `CollisionAvoidanceSystem.js`,
  `ConjunctionSystem.js`, `ActiveSatGuard.js`, `IssConjunctionBoss.js`,
  `StarlinkCascadeBoss.js`, `TargetSelector.js`, `ToolRecommender.js`, `RewardSystem.js`,
  `ScoringSystem.js`, `CameraSystem.js` (comms-on-spring-fire text like
  `"${arm.id}: Spring fired — separating"` — note `arm.id` is an identifier, only the literal
  prose changes: "Spring fired" → "Spring released").

## Discovery methodology (for the implementer)
Because comms strings are scattered across ~40 files, use a targeted recipe rather than blind
replace:
1. Find candidate **string literals** in display contexts:
   `grep -rnE "(text:|body:|title:|name:|desc:|label:|shortText|fullText|fillText|innerHTML|textContent|COMMS_MESSAGE)" js | grep -iE "\b(arm|arms|fire|firing|crossbow)\b"`.
2. For each hit, confirm it is **rendered** (template/HTML/canvas/comms), not a comment, an
   identifier, an event key, or a constant. Skip if not displayed.
3. Apply the mapping table. Re-read each edited sentence for grammar/coherence (singular/plural,
   "an arm" → "a daughter", leftover "bolt"/"recoil").
4. Preserve surrounding code exactly (only the quoted display substring changes).

## Tests (keep the suite green)
Tests are out of scope as content, BUT some assert on display strings that this plan changes —
they must be updated so the suite passes:
- `js/test/test-MotherWireframe.js` (L26, L39) asserts the zone label `'Crossbow Arms'` →
  update to the new label if the zone `name` is changed. (If instead you keep the internal key
  and only map the display label, leave the test alone — pick one approach and stay consistent.)
- Re-run the full suite and grep test files for any other assertions on changed display strings
  (`test-TeachingSystem.js`, `test-DaughterWireframe.js`, codex/HUD tests) and update those.

## Verification
1. Run the test suite (`./test.sh` or open `test.html`) — must be all green.
2. Manual spot-check in-game: HUD daughter/fleet panel, Shop (Daughters tab + Cradle Springs),
   Mother wireframe title + zone label, Mother callouts, Codex entries, Teaching popups, and
   early-mission comms — confirm no remaining 🏹 or weapon-`fire`/`crossbow`/standalone `arm`
   in visible text, and no broken layout/logic.
3. Final grep sanity: no `🏹` left in `js/`; remaining `crossbow`/`arm`/`fire` hits in `js/`
   are only comments, identifiers, event/constant names, or non-violent senses.

## Out of scope (explicitly not done)
- Code identifiers, file renames, event/constant renames, comments.
- Design docs (`*.md`) and `archive/`.
- Terms `recoil`, `barrel`, `boss`, `grapple`, `harpoon`, `net`, `lasso`, `target`, lasers.
