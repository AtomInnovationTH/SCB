# Defer "Trawl", Focus the Guided Capture Loop

## Goal

Remove the **trawl** mechanic from the new-player experience and re-anchor the
"debris field cleared" payoff onto the **guided active-capture loop** the
onboarding already teaches (Target → Autopilot → Net/Daughter → Capture).

Trawl today is:
- **Undiscoverable** — bound to `Shift+G` (`InputManager.js:763`) but absent
  from the `?` help overlay (`HotkeyOverlay.js:28-93`). Dev comments document a
  hotkey revamp that stripped it from the player-facing list.
- **Invisible / agency-stealing** — silently auto-starts on entering orbital
  view and moves the mothership for the player (`TrawlManager.js:54-64`,
  motion at `:169-180`).
- **Badly named** — "trawl"/"sweep"/"fishing"/"netting run" is jargon, never
  explained to a newcomer.
- **Boring** — passive auto-drag; even the developers forgot it exists.

Decision (user): keep the code, but **gate trawl behind a later/advanced
mission** with a better name. For now a new, already-overwhelmed player should
only see the well-guided loop.

## Critical coupling to fix (the turn-1 "field cleared" question)

The "field cleared" celebration is currently **hostage to trawl**:

- `RewardSystem._checkFieldClearing` (`RewardSystem.js:352`) early-returns when
  `_fieldTotal <= 0`.
- `_fieldTotal` only increments on `TRAWL_TARGET_ENTERING`
  (`RewardSystem.js:99-101`) — a trawl-only event.
- The Sweep Report ceremony (`SweepReportUI`) only fires on
  `TRAWL_SWEEP_COMPLETE` (`RewardSystem.js:103-104`, `TrawlManager.js:347`).

So simply hiding trawl makes the 25/50/75/100 % comms, the tiered credit
bonuses, **and** the star ceremony **never fire**. We must re-anchor field
progress + ceremony to the active loop so clearing a cluster by hand still
pays off.

---

## Decisions (confirmed)

1. **New name for the deferred mechanic: "Dragnet".** Replace all player-facing
   "trawl"/"sweep"/"fishing"/"netting run" wording with **Dragnet**. (Internal
   code identifiers — `TrawlManager`, `TRAWL_*` events — may stay as-is to limit
   churn; only player-facing strings/labels rename.)
2. **Gating model: keep `Shift+G` bound but hidden.** Do not unbind it. It stays
   functional for testing/power users but remains absent from the `?` help
   overlay and all new-player guidance until an advanced mission surfaces it
   (with a "Dragnet" help row + teaching card).
3. **Ceremony anchor: new `CLUSTER_CLEARED` event.** Drive the celebration +
   bonus from active captures emptying a cluster. Retire the Sweep Report from
   the core loop and reuse it later for the advanced Dragnet mission.

---

## Changes

Ordered by player impact.

### 1. Stop the silent trawl auto-start — `TrawlManager.js`

- **Remove the `GAME_STATE_CHANGE → ORBITAL_VIEW` auto-start** block
  (`TrawlManager.js:53-64`). This is the root of the invisible self-moving
  ship. With it gone the mother stays put until the player pilots/autopilots —
  consistent with the guided loop.
- Leave `startTrawl`/`endTrawl`/`update` intact (code preserved for the future
  advanced mission), but they are only reachable via an explicit, gated entry
  point.

### 2. Leave `Shift+G` bound but hidden — `InputManager.js`

- **No change to the binding** (`InputManager.js:762-768`). `Shift+G` keeps
  emitting `TRAWL_START` so the mechanic stays testable. It is already absent
  from the `?` overlay; the work is to ensure nothing in the new-player path
  *points* to it (steps 3–4) until an advanced mission adds a "Dragnet" help row.

### 3. Demote the skill — `Constants.js`

- `collect_trawl` skill (`Constants.js:2213`, tier 3): re-tier to an advanced
  tier and/or add a hard prereq so it is `undiscovered` for new players and only
  becomes discoverable once the advanced mission unlocks it. Rename label
  `'Trawl'` → **`'Dragnet'`**.

### 4. Scrub trawl from new-player guidance

- **MissionCoach / synergy nudges** (`Constants.js:2798`, `:2802`): remove or
  rewrite the two lines that instruct `Shift+G` to "trawl the net through the
  cluster" — they must not appear in the new-player path. Replace with
  active-loop guidance (Target → Autopilot → Net), or move into the advanced
  Dragnet-mission beat table.
- **Codex guidance string** (`CodexSystem.js:1905`):
  `orbital_inclination: 'Start a trawl sweep (Shift+G).'` → rewrite to an
  active-loop action (e.g. "Target debris (T), then Autopilot (A)."). The two
  codex entries that *trigger* on `TRAWL_START` (`CodexSystem.js:82,758`) must
  be re-pointed to a still-firing event (e.g. `TARGET_SELECTED` or
  `AUTOPILOT_ENGAGE`) so the orbital-mechanics lessons still unlock.
- Confirm no onboarding beat references trawl (it does not today — good).

### 5. Re-anchor field progress + ceremony to active capture (core fix)

New event: **`CLUSTER_CLEARED`** (add to `Events.js`).

- **DebrisField.removeDebris** (`DebrisField.js`, ~`:2650`): after marking a
  piece dead, check the piece's parent cluster bucket via
  `getDebrisClusters()` membership; when the last alive member of that bucket
  drops to 0, emit `CLUSTER_CLEARED { clusterId, name, count }`.
- **RewardSystem field-progress rework** (`RewardSystem.js:352-394`):
  - Seed `_fieldTotal` from the **engaged cluster's real size** (on cluster
    selection / first capture within a cluster) instead of from
    `TRAWL_TARGET_ENTERING`.
  - Keep `_fieldCaptured++` on every `_onCapture` (already happens, `:162`).
  - Keep the 25/50/75/100 % comms + tiered bonuses — they now track real
    cluster clearance, so "Perfect sweep. Bonus authorized." (`:375`) finally
    means the cluster is actually empty.
- **Ceremony**: on `CLUSTER_CLEARED`, fire a celebration — reuse
  `AudioSystem.playVictory()` (`AudioSystem.js:857`) or `playSweepComplete()`
  (`:2302`) and show a compact "Cluster Cleared" summary card (adapt
  `SweepReportUI`, or a lighter new card). Retire `SweepReportUI`'s
  `TRAWL_SWEEP_COMPLETE` trigger from the core loop (keep it for the advanced
  Salvage Pass).

### 6. Close the loop — "what next" (carryover from turn 1)

- On `CLUSTER_CLEARED` (after the card dismisses), post a `HINT_POSTED` ticker:
  "Cluster clear. Press `M` for the Debris Map and pick your next cluster."
- Also fire `MissionMilestones.formatObjectiveRecap` (`MissionMilestones.js:82`)
  on `CLUSTER_CLEARED`, not only on `SHOP_DEPLOY`, so progress + next step is
  restated whenever a chunk of work finishes.

### 7. Preserve trawl as a future "Dragnet" advanced mission

- Keep `TrawlManager`, `SweepReportUI`, the `TRAWL_*` events, and the
  `Shift+G` binding intact. A future advanced-mission plan wires the
  help-overlay "Dragnet" row, the unlock flag that re-tiers the skill, and a
  proper teaching card under the **Dragnet** name.

---

## Out of scope

- Building the advanced Salvage Pass mission itself (future plan).
- Broader economy / difficulty / content tuning.
- Terminology softening of net/lasso/arm (owned by
  `.kilo/plans/reduce-violent-terminology.md`).

## Test impact

- `test-TrawlManager.js`, `test-CollisionAvoidance.js`,
  `test-AutopilotSystem.js` emit/expect `TRAWL_*` directly — they should still
  pass (events preserved) but the auto-start removal may need a test update.
- `test-GuidanceHotkeyDrift.js` scans guidance for freed/moved keys — updating
  the trawl guidance strings (step 4) must keep this guard green.
- Add coverage: `CLUSTER_CLEARED` fires when the last cluster member is removed;
  field-progress thresholds fire on active captures with no trawl active.

## Net effect

A new player sees one coherent, well-guided loop — target, approach, capture,
clear the cluster, get a real celebration, and a clear pointer to the next
cluster — with no invisible self-moving ship and no undiscoverable jargon
verb. "Trawl" survives as **Dragnet**: still bound to `Shift+G` for testing but
hidden from new players until an intentional advanced-mission unlock.
