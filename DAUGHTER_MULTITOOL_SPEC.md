# Daughter-Arm Multi-Tool Capture — Y0 Baseline Spec

> **Author:** Architect mode · **Date:** 2026-05-16 · **Audience:** next-shift Code-mode implementer.
> **Project root:** `/Users/j/Space Cowboy` · **Test baseline:** 460 suites / 2,060 tests / 0 failures ([`HANDOFF.md:6`](HANDOFF.md:6)).
>
> Scope: enable the dormant Capture Net FSM, then differentiate Weaver (Large Daughter) and Spinner (Small Daughter) by giving each its own secondary/tertiary tool set, with a player-facing tool-selection HUD on the STATION_KEEP overlay. **4 phases**, each independently shippable. Every behavioural claim cites `file:line`; every design claim cites `doc:line`.

---

## §1 — TL;DR

- **Problem.** Weaver and Spinner are functionally identical today — both rely on the legacy 85% net dice-roll in [`ArmUnit._updateNetting()`](js/entities/ArmUnit.js:2972) ([line 3009](js/entities/ArmUnit.js:3009)). The Large Daughter class has no reason to exist.
- **Canonical Y0 design** ([`archive/V3 Octopus.md:724`](archive/V3%20Octopus.md:724)): *"Both Weavers AND Spinners carry nets as their **primary** capture system. Spinners additionally carry a multi-modal pad as secondary (for tiny fragments where netting is impractical). Weavers additionally carry a miniature gripper as backup (for grappling protruding features)."* Plus, the EPM on every daughter's −Y face ([`EPIC10_DEEP_ANALYSIS.md:3320-3326`](archive/EPIC10_DEEP_ANALYSIS.md:3320)) doubles as a magnetic capture tool for ferrous debris.
- **End state.** Weaver = `Net (M)` + `EPM Magnet` + `Gripper Jaws`. Spinner = `Net (S)` + `Multi-modal Pad` + `EPM Magnet` (per §13 Q2). Player cycles tools per arm with `` ` `` (backtick); `F` dispatches the **selected** tool — not always a net.
- **Phasing.**
  1. **P1 Foundation** — flip [`FEATURE_FLAGS.CAPTURE_NET`](js/core/Constants.js:409) ON.
  2. **P2 Magnetic grapple + tool HUD** — new `ARM_STATES.MAGNETIC_GRAPPLE`, SK overlay tool list, `` ` `` cycle, F dispatch.
  3. **P3 Gripper jaws (Weaver)** — `ARM_STATES.GRIPPER_GRAPPLE` for protruding fixtures.
  4. **P4 Multi-modal pad (Spinner)** — `ARM_STATES.PAD_CONTACT`, auto-selects gecko/electrostatic/hooks on contact ([`GAME_FLOW_BRAINSTORM.md:173`](archive/GAME_FLOW_BRAINSTORM.md:173) — *"the pad figures it out."*).
- Every phase keeps the **460 / 2,060 / 0** suite green and adds its own regression tests. **Out of scope:** tether tension reel-in mini-game, Y1+ tools, tier-ladder arm-count progression, mission-2 planning, skills-system gating. *(Decisions log added 2026-05-16; supersedes original §13. Net economy is now **in scope** per Q5 — see §13.)*

---

## §2 — Canonical Y0 Tool Inventory

Verbatim from [`archive/V3 Octopus.md:723-725`](archive/V3%20Octopus.md:723):

> *"Both Weavers AND Spinners carry nets as their **primary** capture system. Spinners additionally carry a multi-modal pad as secondary (for tiny fragments where netting is impractical). Weavers additionally carry a miniature gripper as backup (for grappling protruding features)."*

Plus per [`EPIC10_DEEP_ANALYSIS.md:3320-3326`](archive/EPIC10_DEEP_ANALYSIS.md:3320), the EPM on every daughter's −Y face is *dual-role* (docking + ferrous-debris grapple, 50 N hold, ~500 kg in microgravity).

| Class | Mass (kg) | Primary | Secondary | Tertiary | Doc-cite |
|---|---|---|---|---|---|
| **Weaver** (Large Daughter) | 6.6 ([`Constants.js:312`](js/core/Constants.js:312)) | **Medium Net** `LD-NET` 5 m, 500 kg cap ([`Constants.js:1213-1234`](js/core/Constants.js:1213); spec §7.2 of [`archive/V3 Octopus.md:726`](archive/V3%20Octopus.md:726)) | **Gripper jaws** — 3-jaw chuck, 30 N grip, 50 mm aperture ([`archive/V3 Octopus.md:820-828`](archive/V3%20Octopus.md:820); [`GAME_FLOW_BRAINSTORM.md:131`](archive/GAME_FLOW_BRAINSTORM.md:131)) | **EPM magnetic face** — 50 N hold on ferrous targets ([`EPIC10_DEEP_ANALYSIS.md:3322-3326`](archive/EPIC10_DEEP_ANALYSIS.md:3322); [`GAME_FLOW_BRAINSTORM.md:72`](archive/GAME_FLOW_BRAINSTORM.md:72) failure-mode #2) |
| **Spinner** (Small Daughter) | 2.1 ([`Constants.js:313`](js/core/Constants.js:313)) | **Small Net** `SD-NET` 1.5 m, 50 kg cap ([`Constants.js:1237-1257`](js/core/Constants.js:1237); [`archive/V3 Octopus.md:786-794`](archive/V3%20Octopus.md:786)) | **Multi-modal pad** — gecko / hooks / electrostatic / magnet / UV-cure, auto-mode-select on contact ([`archive/V3 Octopus.md:795-818`](archive/V3%20Octopus.md:795); [`GAME_FLOW_BRAINSTORM.md:153-178`](archive/GAME_FLOW_BRAINSTORM.md:153)) | **EPM magnetic face** — 50 N hold on ferrous-fastener targets, 500 kg cap (§13 Q2 — Spinner EPM is now player-facing, matching Weaver). Same hardware as docking, dual-role per [`EPIC10_DEEP_ANALYSIS.md:3322-3326`](archive/EPIC10_DEEP_ANALYSIS.md:3322). |

**Design intent split.** The Weaver chooses tools deliberately (net / gripper / magnet). The Spinner now has the same 3-tool choice space (net / pad / magnet) per §13 Q2, but the **pad** still encodes the "positioning over tool-selection" philosophy from [`GAME_FLOW_BRAINSTORM.md:172-175`](archive/GAME_FLOW_BRAINSTORM.md:172): *"The player's job is to GET THE PAD TO TOUCH the debris. The pad figures out which adhesion mode wins."* MAGNET is the third, optional Spinner verb when the target has ferrous fasteners (rocket bodies, defunct sats).

---

## §3 — Current-State Audit

| Tool | Implemented? | Flag-gated? | Evidence |
|---|---|---|---|
| **Net (Weaver/Spinner)** | **Partial.** The full 14-state FSM exists in [`CaptureNet.js`](js/entities/CaptureNet.js:1) (886 LOC; states at [`Constants.js:1109-1124`](js/core/Constants.js:1109)). Visual layer is built ([`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js)). However, the **live** capture path is the legacy 85% dice-roll in [`ArmUnit._updateNetting()`](js/entities/ArmUnit.js:2972) at [line 3009](js/entities/ArmUnit.js:3009) (`Math.random() < Constants.ARM_CAPTURE_SUCCESS_RATE`). | **YES — OFF.** [`FEATURE_FLAGS.CAPTURE_NET: false`](js/core/Constants.js:409). Visual gated identically in [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js). Per-platform class sizes already encode Weaver/Spinner differentiation ([`Constants.js:1213-1257`](js/core/Constants.js:1213)). |
| **EPM Magnetic Grapple** | **Not implemented as a capture tool.** EPM **exists as docking hardware** ([`EPIC10_DEEP_ANALYSIS.md:3312-3451`](archive/EPIC10_DEEP_ANALYSIS.md:3312); constants [`DOCK_EPM_HOLD_FORCE`](js/core/Constants.js:177–183)). State-vis hooks present ([`EPIC10_DEEP_ANALYSIS.md:3438-3440`](archive/EPIC10_DEEP_ANALYSIS.md:3438) — blue-flash on energize; `_epmPoleMat` on each ArmUnit, see PlayerSatellite build path). Audio cue ready: [`AudioSystem.playMagnetic()`](js/systems/AudioSystem.js:433) at [line 433](js/systems/AudioSystem.js:433) (square 2400 Hz + 4 Hz LFO). | n/a (no flag yet). |
| **Weaver Gripper Jaws** | **Missing.** No state, no method, no constants. Only doc-level: [`archive/V3 Octopus.md:820-828`](archive/V3%20Octopus.md:820). | n/a. |
| **Spinner Multi-modal Pad** | **Missing.** No state, no method, no constants. Doc-level: [`archive/V3 Octopus.md:795-818`](archive/V3%20Octopus.md:795); [`GAME_FLOW_BRAINSTORM.md:153-178`](archive/GAME_FLOW_BRAINSTORM.md:153). | n/a. |
| **Tool-selection HUD on SK** | **Missing.** SK overlay exists ([`DockingReticle._drawStationKeepOverlay()`](js/ui/DockingReticle.js:684) at [line 684](js/ui/DockingReticle.js:684)) but shows only θ/φ/R. Backtick is *already wired* but lives behind `Shift+`` ` `` and routes to legacy lasso/spinner/weaver tool list ([`InputManager.js:1166-1168`](js/systems/InputManager.js:1166); [`TargetSelector._cycleTool()`](js/systems/TargetSelector.js:149) at [line 149](js/systems/TargetSelector.js:149)). `F` in SK currently *only* calls [`ArmUnit.captureFromStationKeep()`](js/entities/ArmUnit.js:2949) → `NETTING` ([`InputManager.js:836-839`](js/systems/InputManager.js:836)). |

**Net-count inventory** (`armNetCounts[]`) is already plumbed through save/load ([`PersistenceManager.js:238-258`](js/systems/PersistenceManager.js:238); [`test-ArmTierCatalog.js:756-841`](js/test/test-ArmTierCatalog.js:756)) and through [`CaptureNet.getState()`](js/entities/CaptureNet.js:1). **Per §13 Q5, net expenditure IS enabled at Y0:** NETTING entry decrements `armNetCounts[i]`; depletion (count === 0) is a hard-fail state — F-press plays click-fail audio and the recommender drops NET to score 0 so another tool takes the ▶ marker. Carry counts seed from `ARM_NET_CAPACITY = { weaver: 2, spinner: 4 }` (§4.1; net ladder — Large Daughter 2, Small Daughter 4). No auto-refill at Y0; resupply UX deferred to Y1.

---

## §4 — New Constants & Events

### 4.1 Additions to [`Constants.js`](js/core/Constants.js)

```js
// === ARM_STATES additions (insert after EXPENDED at Constants.js:213) ===
MAGNETIC_GRAPPLE: 'MAGNETIC_GRAPPLE',  // P2 — EPM contact + 50 N hold + reel
GRIPPER_GRAPPLE:  'GRIPPER_GRAPPLE',   // P3 — 3-jaw chuck on protruding fixture
PAD_CONTACT:      'PAD_CONTACT',       // P4 — multi-modal pad contact attempt

// === TOOL_KIND enum (new block, beside ARM_STATES) ===
TOOL_KIND: {
  NET:     'NET',        // primary, both classes
  MAGNET:  'MAGNET',     // tertiary, Weaver (Spinner: implicit docking only)
  GRIPPER: 'GRIPPER',    // secondary, Weaver
  PAD:     'PAD',        // secondary, Spinner
},

// === Per-arm tool inventory (Y0 baseline; data, not state) ===
// §13 Q6 — static-by-class: read on ArmUnit construction, NOT persisted.
DAUGHTER_TOOLSETS: {
  weaver:  ['NET', 'GRIPPER', 'MAGNET'],   // ordered: primary first; matches §2 table
  spinner: ['NET', 'PAD', 'MAGNET'],       // §13 Q2 — Spinner EPM is player-facing (was: docking-only)
},

// === Per-arm net inventory capacity (§13 Q5 — depletion is a real Y0 fail state) ===
// Net ladder: values MUST equal CAPTURE_NET.MEDIUM/SMALL.MAGAZINE_SIZE (drift-guard
// test enforces). Payload-fraction invariant justifying 2/4:
//   Large Daughter (weaver): 2 × 0.68 kg / 6.6 kg ≈ 21%
//   Small Daughter (spinner): 4 × 0.12 kg / 2.1 kg ≈ 23%
ARM_NET_CAPACITY: {
  weaver:  2,   // Large Daughter — Medium net magazine
  spinner: 4,   // Small Daughter — Small net magazine
},

// === MAGNETIC_GRAPPLE tuning (cite EPIC10_DEEP_ANALYSIS.md:3322-3326) ===
// §13 Q4 — material-purity model replaced with heterogeneous-spacecraft model:
// real sats / rocket bodies have steel bolts / brackets even when the hull is Al or Ti.
MAGNETIC_GRAPPLE: {
  CONTACT_RANGE_M:        0.5,    // EPM contact window (must touch −Y face to ≤0.5 m)
  HOLD_FORCE_N:           50,     // EPIC10 line 3322
  MAX_DEBRIS_MASS_KG:     500,    // EPIC10 line 3325 — "sufficient for ~500 kg in microgravity"
  ENERGIZE_PULSE_S:       0.3,    // EPIC10 line 3438 — pole-face blue flash 1.0→0.0 over 0.3 s
  RELEASE_PULSE_S:        0.2,    // EPIC10 line 3440 — red flash 1.0→0.0 over 0.2 s
  P_GRIP_FERROUS:         0.95,   // base cling on pure-ferromagnetic target (steel hull) — rare in Y0 pool
  P_GRIP_FASTENERS:       0.40,   // §13 Q4 — heterogeneous target (rocketBody/defunctSat) latches onto bolts/brackets
  P_GRIP_NON_FERROUS:     0.05,   // all-Al fragment / composite — sticks only via residual flux
  APPROACH_SPEED_M_S:     0.3,    // m/s closing speed for contact attempt
  REEL_SPEED_LOADED_M_S:  1.4,    // reuse REEL_IN_SPEED_LOADED contract for consistency
},

// === GRIPPER_GRAPPLE tuning (new block; cite V3 Octopus.md:820-828) ===
GRIPPER_GRAPPLE: {
  REACH_M:           0.30,    // jaws extend 30 cm beyond −Y face
  GRIP_DIAMETER_M:   0.050,   // 50 mm aperture (V3 Octopus.md:826)
  GRIP_FORCE_N:      30,      // V3 Octopus.md:826
  CLOSE_TIME_S:      1.2,     // spiral cam close duration
  RATCHET_HOLD:      true,    // zero-power lock once closed (V3 Octopus.md:825)
  P_GRIP_FIXTURED:   0.90,    // target has docking port / strut / antenna stub
  P_GRIP_UNFIXTURED: 0.10,    // target lacks protrusion — should not be selected
  MAX_DEBRIS_MASS_KG: 2000,   // mechanical limit; doc-aspirational
},

// === PAD_CONTACT tuning (new block; cite V3 Octopus.md:799-818, GAME_FLOW_BRAINSTORM.md:153-178) ===
PAD_CONTACT: {
  PAD_RADIUS_M:      0.080,         // 8 cm contact patch (V3 Octopus.md:807, "~105g")
  CONTACT_VEL_MAX_M_S: 0.20,        // any faster and pad bounces — soft-contact regime
  ADHESION_MODES: ['gecko', 'hooks', 'electrostatic', 'magnet', 'uv_cure'],
  // Mode-selection priority (auto-resolves on contact per surface, V3 Octopus.md:811-816):
  // 1. material in {steel, iron_alloy}                            → magnet
  // 2. material in {mli_mylar} OR roughness > 0.7                 → hooks
  // 3. material in {aluminum, kapton, glass_ceramic, solar_cell}  → gecko (warm window)
  // 4. material in {composite}                                    → electrostatic
  // 5. else                                                       → uv_cure (last resort, finite doses)
  GECKO_TEMP_MIN_C:  -40,           // V3 Octopus.md:801; pad-mode warm-window check
  GECKO_TEMP_MAX_C:   80,
  UV_CURE_DOSES_Y0:   10,           // V3 Octopus.md:805 — per-arm magazine; §13 Q3 — hard cap ENFORCED at Y0; once 0, 'uv_cure' is removed from the priority list so exotic surfaces return NO_MODE (visible failure mode)
  P_GRIP_BY_MODE: {
    gecko:         0.90,
    hooks:         0.95,
    electrostatic: 0.70,
    magnet:        0.95,
    uv_cure:       0.98,            // strong but consumes a dose
  },
  P_GRIP_NO_MODE:   0.05,           // contact happened but no mode resolved
  CONTACT_HOLD_S:   1.0,            // dwell before P_GRIP roll
  RELEASE_PULSE_S:  0.2,
},

// === Tool-selection HUD constants ===
TOOL_HUD: {
  ROW_HEIGHT_PX:     16,
  PANEL_WIDTH_PX:    220,
  HIGHLIGHT_COLOR:   '#ffd166',     // selected
  RECOMMEND_COLOR:   '#00ffaa',     // matches SK theme (DockingReticle.js:702-715)
  DIMMED_COLOR:      'rgba(180,200,210,0.55)',
  GLYPHS: {                          // single-char identifier per tool (no emoji)
    NET:     'N',
    MAGNET:  'M',
    GRIPPER: 'G',
    PAD:     'P',
  },
},
```

### 4.2 Additions to [`FEATURE_FLAGS`](js/core/Constants.js:384)

| Flag | Default | Lifted in phase | Purpose |
|---|---|---|---|
| `CAPTURE_NET` | currently `false` ([`Constants.js:409`](js/core/Constants.js:409)) | **P1 — flip ON** | Enables the real FSM in [`CaptureNet.js`](js/entities/CaptureNet.js:1) and the visual layer. |
| `DAUGHTER_MULTITOOL` | `false` (new) | **P2 — flip ON** | Master gate for §2 multi-tool inventory; HUD, ARM_STATES.MAGNETIC_GRAPPLE, backtick cycling. Default OFF until P2 lands so P1 can ship with net-only behaviour. |
| `WEAVER_GRIPPER` | `false` (new) | **P3 — flip ON** | `ARM_STATES.GRIPPER_GRAPPLE`, Weaver tertiary entry. |
| `SPINNER_PAD` | `false` (new) | **P4 — flip ON** | `ARM_STATES.PAD_CONTACT`, Spinner secondary entry, surface-mode auto-resolver. |

Hierarchy: `DAUGHTER_MULTITOOL` is the prerequisite for `WEAVER_GRIPPER` / `SPINNER_PAD`. The flag check in [`Constants.isFeatureEnabled()`](js/core/Constants.js:2120) already short-circuits when `REALITY_MODE` is ON; honour this.

### 4.3 Additions to [`Events.js`](js/core/Events.js)

```js
// === DAUGHTER MULTITOOL (new block, append after TOOL_DEPLOY at line 277) ===
TOOL_SELECTED:           'tool:selected',          // { armId, tool: 'NET'|'MAGNET'|'GRIPPER'|'PAD' }
TOOL_ARMSET_CHANGED:     'tool:armsetChanged',     // { armId, toolset: string[] } — emitted on deploy + ARM_PILOT entry
MAGNETIC_GRIP_ATTEMPT:   'magnet:gripAttempt',     // { armId, targetId, pBase }
MAGNETIC_GRIP_ACQUIRED:  'magnet:gripAcquired',    // { armId, targetId, mass }
MAGNETIC_GRIP_FAILED:    'magnet:gripFailed',      // { armId, targetId, reason: 'non_ferrous'|'too_heavy'|'p_roll'|'standoff' }
MAGNETIC_RELEASE:        'magnet:release',         // { armId, targetId } — explicit pulse-off

GRIPPER_LATCH_ATTEMPT:   'gripper:latchAttempt',   // { armId, targetId, fixtureType }
GRIPPER_LATCHED:         'gripper:latched',        // { armId, targetId }
GRIPPER_SLIPPED:         'gripper:slipped',        // { armId, targetId, reason: 'no_fixture'|'p_roll'|'oversize' }
GRIPPER_RELEASED:        'gripper:released',       // { armId, targetId }

PAD_CONTACT_ATTEMPT:     'pad:contactAttempt',     // { armId, targetId, contactVel }
PAD_ADHERED:             'pad:adhered',            // { armId, targetId, mode: 'gecko'|'hooks'|... }
PAD_BOUNCED:             'pad:bounced',            // { armId, targetId, reason: 'too_fast'|'no_mode'|'p_roll'|'bad_temp' }
PAD_RELEASED:            'pad:released',           // { armId, targetId }
```

`TOOL_CYCLE` already exists at [`Events.js:276`](js/core/Events.js:276); we **reuse** it, but the payload now carries the arm's local toolset (P2 supersedes the legacy lasso/spinner/weaver/trawl global enum).

---

## §5 — State-Machine Diagrams (P2 / P3 / P4)

All three new states are **entered from** [`ArmUnit.captureFromStationKeep()`](js/entities/ArmUnit.js:2949) at [line 2949](js/entities/ArmUnit.js:2949) when the selected tool ≠ `NET`. When `NET` is selected, the existing path → `NETTING` (P1) is taken unchanged.

### 5.1 `MAGNETIC_GRAPPLE` (P2)

```
                ┌──────────────────────────┐
                │      STATION_KEEP        │  selected tool = MAGNET
                └──────────────┬───────────┘
                               │ F pressed
                               ▼
                ┌──────────────────────────┐
                │  ENERGIZING  (0.3 s)     │  EPM blue flash, playMagnetic()
                │  emits MAGNETIC_GRIP_    │
                │  ATTEMPT                 │
                └──────────────┬───────────┘
                               │ pulse done
                               ▼
                ┌──────────────────────────┐
                │   CLOSING  (≤6 s)        │  proportional approach toward
                │   close at 0.3 m/s along │  target along −Y face vector
                │   debris approach vector │  (collision-avoid EXEMPT)
                └──────┬────────────┬──────┘
                       │ standoff   │ standoff
                       │ < 0.5 m    │ timeout / drift > 8 m
                       ▼            ▼
            ┌───────────────────┐   ┌──────────────────┐
            │  GRIP_ROLL        │   │  MAGNETIC_GRIP_  │
            │  P = P_GRIP_*     │   │  FAILED          │
            │  (per material)   │   │  → RETURNING     │
            └───────┬─────┬─────┘   └──────────────────┘
                    │     │
            success │     │ fail
                    ▼     ▼
        ┌──────────────┐  ┌──────────────────┐
        │ MAGNETIC_    │  │ MAGNETIC_GRIP_   │
        │ GRIP_ACQUIRED│  │ FAILED →         │
        │ → GRAPPLED   │  │ RETURNING        │
        │ → REELING    │  │ (red pulse 0.2s) │
        └──────────────┘  └──────────────────┘
```

**Entry conditions** — `arm.state === STATION_KEEP` AND `arm.selectedTool === 'MAGNET'` AND tool is in `DAUGHTER_TOOLSETS[arm.type]` AND F pressed.

**Exit conditions** — `GRAPPLED → REELING` on success; `RETURNING` on fail; ESC/P aborts as in NETTING.

**Timing constants** — see §4.1 `MAGNETIC_GRAPPLE.{ENERGIZE_PULSE_S, RELEASE_PULSE_S}`.

**Collision-avoidance exemption (§3.4 gotcha).** During `CLOSING`, the arm intentionally drives within `< 0.5 m` of the target — CA's 5 km scan radius will mark it as a threat and dodge it. **MUST** emit `AUTOPILOT_TARGET_LOCK` (or the new equivalent on entry) so [`CollisionAvoidanceSystem._autopilotLockId`](js/systems/CollisionAvoidanceSystem.js:59) is set. The same exemption already covers `NETTING` and `STATION_KEEP`; extend the exempt-set predicate to include `MAGNETIC_GRAPPLE / GRIPPER_GRAPPLE / PAD_CONTACT`.

### 5.2 `GRIPPER_GRAPPLE` (P3)

```
   STATION_KEEP (tool=GRIPPER, F)
            │
            ▼
   ┌──────────────────────┐
   │  EXTEND  (0.3 s)     │  jaws extend, audible servo click
   └──────────┬───────────┘
              │ reach ≥ 0.30 m
              ▼
   ┌──────────────────────┐                     ┌─────────────────────────┐
   │  SEEK_FIXTURE        │── no fixture ──────►│  GRIPPER_SLIPPED (P_roll │
   │  (raycast within     │   in N° cone        │   fails) → RETURNING    │
   │   ±15° of −Y face)   │                     └─────────────────────────┘
   └──────────┬───────────┘
              │ fixture acquired
              ▼
   ┌──────────────────────┐
   │  CLOSE  (1.2 s)      │  spiral cam closes 50→0 mm
   │  emits GRIPPER_LATCH_│
   │  ATTEMPT             │
   └──────────┬───────────┘
              │ ratchet engages
              ▼
   ┌──────────────────────┐
   │  GRIPPER_LATCHED     │  zero-power hold (V3 Octopus.md:825)
   │  → GRAPPLED          │  → REELING
   └──────────────────────┘
```

**Fixture detection (P3 cheap-and-cheerful).** A target has a "fixture" if `target.hasGrappleFixture === true` (see §6 schema). When that field is absent, **derive** from existing data: `type ∈ {defunctSat, rocketBody}` AND `mass ≥ 50 kg` defaults to `hasGrappleFixture: true`. Fragments default `false`. This avoids a full inspection-data dependency for Y0.

**Collision-avoidance exemption.** Same pattern as §5.1.

### 5.3 `PAD_CONTACT` (P4)

```
   STATION_KEEP (tool=PAD, F)
            │
            ▼
   ┌──────────────────────────┐
   │ APPROACH_SOFT (≤4 s)     │  brake to ≤0.20 m/s relative
   │ closing toward target    │  along −Y vector
   │ surface point            │  collision-avoid EXEMPT
   └──────────┬───────────────┘
              │ standoff ≈ pad_radius      │ contact_vel > CONTACT_VEL_MAX
              ▼                            ▼
   ┌──────────────────────┐        ┌────────────────────────┐
   │ CONTACT (instant)    │        │ PAD_BOUNCED            │
   │ emits PAD_CONTACT_   │        │  reason: 'too_fast'    │
   │ ATTEMPT              │        │  → RETURNING           │
   └──────────┬───────────┘        └────────────────────────┘
              │ resolve mode (§4.1 priority)
              ▼
   ┌──────────────────────────────────────────────────────┐
   │  MODE_RESOLVED (mode ∈ {gecko/hooks/electro/magnet/  │
   │  uv_cure} or NONE) — see PAD_CONTACT.GLYPHS in HUD   │
   └──────────┬───────────────────────────────────────────┘
              │ dwell 1.0 s
              ▼
   ┌──────────────────────┐                  ┌──────────────────────┐
   │  GRIP_ROLL           │── fail ─────────►│  PAD_BOUNCED → RETURNING
   │  P = P_GRIP_BY_MODE  │  (reason='p_roll')│  (no UV-cure consumed
   │  [resolvedMode] OR   │                  │   on fail roll)      │
   │  P_GRIP_NO_MODE      │                  └──────────────────────┘
   └──────────┬───────────┘
              │ success
              ▼
   ┌──────────────────────────┐
   │  PAD_ADHERED  → GRAPPLED │  emits PAD_ADHERED { mode }
   │  → REELING                │  (decrement UV dose IFF mode=uv_cure)
   └──────────────────────────┘
```

**Mode resolution** is deterministic by target metadata at contact instant — see §6 for inputs. **No player choice required** — this is the load-bearing line from [`GAME_FLOW_BRAINSTORM.md:173`](archive/GAME_FLOW_BRAINSTORM.md:173): *"the pad figures it out."*

**Gecko warm-window check.** If `mode === 'gecko'` and target surface temperature outside `[GECKO_TEMP_MIN_C, GECKO_TEMP_MAX_C]`, fall back through priority list (`gecko → hooks → electrostatic → ...`). Y0 lacks per-debris temperature data, so default to "warm window OK" until a sensor scan provides `surfaceTempC` (out of scope this cycle; doc-cite for future: [`archive/V3 Octopus.md:809-818`](archive/V3%20Octopus.md:809)).

---

## §6 — Debris-Catalog Schema Extension

### 6.1 Fields needed

| Field | Type | Used by | Default | Derivable? |
|---|---|---|---|---|
| `ferromagnetic` | `bool` | P2 magnetic recommender + `P_GRIP_FERROUS` (pure-steel hull, rare) | from `material` | **YES** — `material === 'steel' \|\| material === 'iron_alloy'`; fallback `false`. |
| `hasFerrousFasteners` | `bool` | P2 magnet recommender — §13 Q4 heterogeneous-spacecraft model + `P_GRIP_FASTENERS` selection | from `type` | **YES** — `type === 'rocketBody' \|\| type === 'defunctSat'`; fallback `false`. Real sats / rocket bodies have steel bolts, brackets, hinges even when the hull is Al or Ti. Fragments / missionDebris default `false`. |
| `hasGrappleFixture` | `bool` | P3 gripper recommender (§13 Q1 — gripper rule trigger) | derive | **YES (heuristic)** — `type ∈ {defunctSat, rocketBody}` AND `mass ≥ 50` (V3 Octopus rocket bodies + sats have antenna stubs / docking adapters). Fragments / missionDebris default `false`. |
| `surfaceRoughness` | `float` 0..1 | P4 pad-mode resolver | derive | **YES** — map `material` → roughness: `mli_mylar: 0.9`, `solar_cell: 0.2`, `aluminum: 0.4`, `titanium: 0.5`, `composite: 0.6`. Fallback `0.5`. |
| `surfaceTempC` | `float` | P4 gecko warm-window | unknown | **NO** at Y0 (no thermal sensor). Default `25` (assume warm window). |

### 6.2 Where the values come from

- **Procedural debris** ([`DebrisField._generateDebris*`](js/entities/DebrisField.js:443-503), [line 502](js/entities/DebrisField.js:502)) already tags `material` from the 5-value pool `['aluminum', 'titanium', 'composite', 'mli_mylar', 'solar_cell']` ([`DebrisField.js:46`](js/entities/DebrisField.js:46)). Add derivations to the debris-data factory:
  ```js
  data.ferromagnetic       = (material === 'steel');                                // §6.2 — steel added to MATERIALS pool
  data.hasFerrousFasteners = (type === 'rocketBody' || type === 'defunctSat');      // §13 Q4 — heterogeneous-spacecraft model
  data.hasGrappleFixture   = (type === 'defunctSat' || type === 'rocketBody') && mass >= 50;
  data.surfaceRoughness    = SURFACE_ROUGHNESS_BY_MATERIAL[material] ?? 0.5;
  data.surfaceTempC        = 25;
  ```
  > **Note.** The current `MATERIALS` pool at [`DebrisField.js:46`](js/entities/DebrisField.js:46) has no ferromagnetic entry. For P2 to be **observably** magnetic, extend the pool: add `'steel'` to `MATERIALS` and add a Constants entry under `DEBRIS_MATERIALS` ([`Constants.js:1620`](js/core/Constants.js:1620)) with `metalness: 0.85, roughness: 0.55, color: 0x808890`. Without this, every roll of the recommender lands on "non-ferrous → net" and the magnet tool feels dead. **This is the load-bearing data change for P2.**

- **Catalog rows** ([`debris-catalog.json`](data/debris-catalog.json:1)): The catalog stores `material` implicitly via [`CatalogConverter.js:89`](js/entities/CatalogConverter.js:89) (`MATERIALS[seed % MATERIALS.length]`). After extending the pool to 6, real entries auto-redistribute deterministically; no JSON edits needed. Names like `"COSMOS"`, `"R/B"`, `"DELTA"` should ideally be tagged steel-rich, but **out of scope for Y0** — that would require a hand-curated material override map in the JSON.

- **Test coverage.** Add a constants test that asserts `SURFACE_ROUGHNESS_BY_MATERIAL` covers every value in `MATERIALS` (and the new `'steel'` entry) — protects against silent `undefined` propagation.

### 6.3 Migration plan

1. **No JSON migration needed.** Procedural and catalog debris both go through factory functions, so derived fields appear on first object construction post-deploy.
2. **Save-game compatibility.** `armNetCounts` schema in [`PersistenceManager.js`](js/systems/PersistenceManager.js:238) is untouched. Debris objects are *not* persisted (they regenerate); the new derived fields therefore can't break loads. Verified via [`PersistenceManager.setNetInventory()`](js/systems/PersistenceManager.js:242) shape.
3. **Selected tool persistence.** `arm.selectedTool` should be persisted in the per-arm save block (see [`PersistenceManager.js:373-378`](js/systems/PersistenceManager.js:373)). Add `selectedTool: 'NET'` to the per-arm save shape; default to `'NET'` on missing (back-compat).
4. **UV-cure dose persistence (§13 Q3).** Add `padUvCureDosesRemaining: number[]` to the per-arm save block, length = arm count, default value = `PAD_CONTACT.UV_CURE_DOSES_Y0` on missing. Decrement on `mode === 'uv_cure'` adhered. Length-mismatch validation mirrors the `armNetCounts` pattern at [`PersistenceManager.js:373-378`](js/systems/PersistenceManager.js:373).
5. **Toolset NOT persisted (§13 Q6).** Toolset is reconstructed from `Constants.DAUGHTER_TOOLSETS[arm.type]` on load — no save field. Y1+ unlocks ship via Constants edits + feature flags only.

---

## §7 — Recommendation Engine Extension

Extends [`TargetSelector._updateRecommendation()`](js/systems/TargetSelector.js:103) at [line 103](js/systems/TargetSelector.js:103). Must **degrade gracefully** when new fields are absent (catalog rows pre-§6 migration tick).

```js
// Pseudocode — _updateRecommendation() Phase 2+ extension
_updateRecommendation() {
  const t = this.activeTarget;
  if (!t) { this._reset(); return; }

  const TR    = Constants.TOOL_RECOMMENDATION;
  const mass  = t.mass || 0;
  const tools = [];   // list of (toolKind, score) — score for HUD ★ indicator

  // ── Hard exclusions ─────────────────────────────────────────────
  if (t.type === 'active') {                              // treaty guard
    eventBus.emit(Events.CONJUNCTION_ALERT, { severity:'RED', reason:'ACTIVE_SAT_ARMING' });
    this._reset(); return;
  }

  // ── §6-derived flags (graceful defaults) ────────────────────────
  const ferro    = t.ferromagnetic       === true;     // pure-steel hull (rare in Y0 pool)
  const fasten   = t.hasFerrousFasteners === true;     // §13 Q4 — heterogeneous-spacecraft model
  const fixture  = t.hasGrappleFixture   === true;
  const armType  = this._armContext?.type;             // 'weaver' | 'spinner'
  const armIdx   = this._armContext?.index;
  // Per-class net cap for §13 Q1 oversize rule:
  const netCapKg = (armType === 'weaver')
    ? Constants.CAPTURE_NET.MEDIUM.MAX_CAPTURE_MASS
    : (armType === 'spinner') ? Constants.CAPTURE_NET.SMALL.MAX_CAPTURE_MASS : Infinity;
  const netOversize = mass > netCapKg;
  const tooHeavyForMagnet  = mass > Constants.MAGNETIC_GRAPPLE.MAX_DEBRIS_MASS_KG;
  const tooHeavyForGripper = mass > Constants.GRIPPER_GRAPPLE.MAX_DEBRIS_MASS_KG;

  // §13 Q5 — graceful degradation: empty net magazine forces NET score to 0
  const netsLeft    = (armIdx != null) ? (this._netInventoryFn?.(armIdx) ?? Infinity) : Infinity;
  const netDepleted = netsLeft === 0;

  // ── 1. Primary fork: net coverage ────────────────────────────────
  if (netDepleted) {
    tools.push({ k:'NET', score: 0, hint:'magazine empty' });                       // §13 Q5 — dimmed, never recommended
  } else if (netOversize) {
    tools.push({ k:'NET', score: 1, hint:'class oversize — Mother only' });         // §13 Q1 — NET self-demotes
  } else if (mass <= Constants.CAPTURE_NET.SMALL.MAX_CAPTURE_MASS) {
    tools.push({ k:'NET', score: 3, hint:'Spinner SD-NET' });
  } else if (mass <= Constants.CAPTURE_NET.MEDIUM.MAX_CAPTURE_MASS) {
    tools.push({ k:'NET', score: 3, hint:'Weaver LD-NET' });
  }

  // ── 2. Magnet fork (§13 Q2 + Q4) — both Weaver AND Spinner; fastener-driven ──
  if ((ferro || fasten) && !tooHeavyForMagnet) {
    tools.push({
      k:'MAGNET',
      score: ferro ? 3 : 2,
      hint:  ferro ? 'ferrous hull — direct grip' : 'ferrous fasteners — bolt-latch',
    });
  }

  // ── 3. Gripper fork (§13 Q1) — oversize / rocketBody / substantial fixture ──
  const awkwardShape = (t.type === 'rocketBody') || (fixture && mass >= 50);
  if (!tooHeavyForGripper && (netOversize || awkwardShape)) {
    tools.push({ k:'GRIPPER', score: 3, hint: netOversize ? 'oversize for net' : 'awkward shape / fixture' });
  } else if (fixture) {
    tools.push({ k:'GRIPPER', score: 1, hint:'available' });                        // visible, not recommended
  }

  // ── 4. Tiny-fragment fork → pad (Spinner) ───────────────────────
  if (mass <= 10 && t.type === 'fragment') {
    tools.push({ k:'PAD', score: 3, hint:'pad will auto-resolve adhesion' });
  }

  // ── Filter to the arm's toolset (if armId context provided) ─────
  const armType = this._armContext?.type;            // 'weaver' | 'spinner'
  const allowed = armType
    ? new Set(Constants.DAUGHTER_TOOLSETS[armType])
    : null;
  const filtered = allowed
    ? tools.filter(x => allowed.has(x.k))
    : tools;

  // ── Rank: highest score wins; ties broken by primary-first order ──
  filtered.sort((a,b) => b.score - a.score);
  const top = filtered[0] || { k:'NET', score:1 };

  this._recommendedTool   = top.k;
  this._toolAlternatives  = filtered.map(x => x.k);
  this._toolHints         = filtered.map(x => x.hint);
  this._toolIndex         = 0;

  eventBus.emit(Events.TOOL_RECOMMENDED, {
    tool: top.k,
    alternatives: this._toolAlternatives,
    targetId: t.id,
  });
}
```

**Graceful degradation.** When `ferromagnetic` / `hasFerrousFasteners` / `hasGrappleFixture` are `undefined`, the falsy `=== true` checks skip the new tools and the engine falls through to the **net-first** recommendation it produces today ([`TargetSelector.js:118-136`](js/systems/TargetSelector.js:118)). No catalog migration is therefore *required* to ship P2. **Empty-magazine guard (§13 Q5):** `netDepleted === true` forces NET score to 0 so the recommender promotes whichever other tool best fits — e.g. on a 100 kg Al rocket body with no nets left, GRIPPER (awkward-shape rule) becomes ▶.

**Per-arm context.** P2 must pass `_armContext = { type: 'weaver'|'spinner' }` whenever an arm is in `STATION_KEEP`. Source: `playerSatellite.armManager.getSelectedArm()` / `_armManager.armsList[i]` already exposes `arm.type` (see [`Constants.OCTOPUS_V5.WEAVER_COUNT/SPINNER_COUNT`](js/core/Constants.js:319-320)). Wire it on `STATION_KEEP_ENTERED` (existing event family — search `STATION_KEEP_ENTERED`/`STATION_KEEP_EXITED` in [`ArmUnit.js`](js/entities/ArmUnit.js:2949)).

---

## §8 — SK Tool-Selection HUD

Lives in [`DockingReticle.js`](js/ui/DockingReticle.js) alongside the existing `_drawStationKeepOverlay()` at [line 684](js/ui/DockingReticle.js:684). The new panel renders **below** the θ/φ/R readout, so the existing SK 4–12 m standoff polish from [`SK_M1_POLISH_HANDOFF.md §1.1-1.3`](archive/SK_M1_POLISH_HANDOFF.md:18) is preserved (wheel zoom, standoff bar, sonar ping). **No vertical real-estate is reclaimed above the crosshair.**

### 8.1 Mockup

```
                   ┌─────────────────────────────┐
                   │  STATION KEEP               │  ← existing box (DockingReticle.js:711)
                   │  θ:+12.3°  φ:-5.1°  R:6.8m  │
                   │  ▬▬▬●▬▬▬▬▬▬                 │  ← min/max range bar
                   └─────────────────────────────┘

                   ┌─────────────────────────────────┐
                   │  TOOL   (Weaver)                │
                   │ ▶  N · **NET (2)**       ★★★    │  ← recommended (bold + cyan ★s)
                   │    M · MAGNET                   │
                   │    G · GRIPPER           —      │  ← not viable (no fixture)
                   │ [`] cycle  [F] dispatch         │
                   └─────────────────────────────────┘

                   ┌─────────────────────────────────┐
                   │  TOOL   (Spinner)               │  ← §13 Q2 → 3 rows
                   │    N · NET (2)                  │
                   │ ▶  P · **PAD** [u:10/10] ★★★    │  ← recommended (bold) — fragment target
                   │    M · MAGNET            ★      │  ← visible, low score (no fasteners on this target)
                   │ [`] cycle  [F] dispatch         │
                   └─────────────────────────────────┘
```

- ▶ indicates the **player-selected** tool (yellow `#ffd166`).
- `★★★ / ★★ / ★` reflects `score` from §7. `—` = filtered out (greyed).
- The hint line under each row (e.g. *"Weaver LD-NET"* / *"ferrous fasteners — bolt-latch"*) renders to the right of the row when there's space, else suppresses.
- **Recommended-row visual (§13 Q7):** **bold text weight** on the row whose `score` is the current top; cyan `#00ffaa` ★s. No pulse / no animation — honours [`SK_M1_POLISH_HANDOFF.md:221-227`](archive/SK_M1_POLISH_HANDOFF.md:221) "no SK animation" ethos.
- **NET row format (§13 Q5):** always `NET (n)` where `n = armNetCounts[i]`. At `n === 0` the row renders dimmed (`TOOL_HUD.DIMMED_COLOR`) and the recommender drops it to score 0.
- **Both Weaver and Spinner show 3 rows** at Y0 per §13 Q2 (`NET / [GRIPPER|PAD] / MAGNET`). When PAD is selected post-resolve, the resolved-mode glyph (`g/h/e/m/u`) prints under the row (P4).
- **UV-cure dose counter (§13 Q3):** when PAD is the selected tool, the row appends ` [u:n/10]` showing the arm's remaining UV doses. At `n === 0`, the counter renders dimmed and `'uv_cure'` is filtered out of the priority list in `_resolvePadMode()`.

### 8.2 Behaviour

| Input | Effect |
|---|---|
| `` ` `` (Backquote, **no shift**) when arm in `STATION_KEEP` | Cycle `selectedTool` through `arm.toolset` (= `DAUGHTER_TOOLSETS[arm.type]`). Emit `TOOL_SELECTED { armId, tool }`. Audio: `audioSystem.playClick()`. |
| `F` | Dispatch selected tool: `NET → captureFromStationKeep()` (P1 path, decrements `armNetCounts[i]`), `MAGNET → magneticGrapple()` (P2), `GRIPPER → gripperGrapple()` (P3), `PAD → padContact()` (P4). **Empty-NET guard (§13 Q5):** if `selectedTool === 'NET'` AND `armNetCounts[i] === 0`, F-press routes to `audioSystem.playClickFail()` and emits `NET_EMPTY_CLICK { armId }` — no FSM transition. |
| ESC / P | Exit ARM_PILOT (unchanged). |
| Shift + `` ` `` | Legacy cycle (lasso/spinner/weaver/trawl in [`InputManager.js:1166`](js/systems/InputManager.js:1166)). **Keep** so the orbital-view tool recommendation still works; just be sure the SK-mode plain backtick is captured first and `preventDefault`'d. |

### 8.3 Code touch-points

| File | Change | Est. LOC |
|---|---|---|
| [`DockingReticle.js`](js/ui/DockingReticle.js:684) | Add `_drawToolSelectionPanel(ctx, cx, cy)` directly under `_drawStationKeepOverlay()`. Read from `arm.toolset`, `arm.selectedTool`, `arm._toolHints`. | ~80 |
| [`InputManager.js`](js/systems/InputManager.js:407) | Add early-return in the `Backquote` handler at [line 407](js/systems/InputManager.js:407): if `armPilotMode && armState === STATION_KEEP`, route to `armManager.getPilotedArm().cycleTool()` instead of legacy `TOOL_CYCLE`. | ~10 |
| [`InputManager.js`](js/systems/InputManager.js:836) | Replace the unconditional `captureFromStationKeep()` call with a `dispatchSelectedTool()` switch. | ~15 |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | New methods `cycleTool()`, `setTool(kind)`, `dispatchSelectedTool()`. Init `this.selectedTool = 'NET'` and `this.toolset = Constants.DAUGHTER_TOOLSETS[this.type]`. | ~40 |

**SK polish guard.** Manual smoke #6 from [`SK_M1_POLISH_HANDOFF.md:244`](archive/SK_M1_POLISH_HANDOFF.md:244) (sonar ping during APPROACH) and #7 (no green ring) and #8 (wheel zoom 4–12 m) must remain green. Add the new panel BELOW the existing box (no overlap), and gate the panel render on `_arm.state === 'STATION_KEEP'` (same guard line as [`DockingReticle.js:685`](js/ui/DockingReticle.js:685)).

---

## §9 — Per-Phase Implementation Plan

### Phase 1 — Foundation: flip `CAPTURE_NET` ON

| File | Change |
|---|---|
| [`Constants.js`](js/core/Constants.js:409) | `CAPTURE_NET: false → true`. Add `ARM_NET_CAPACITY = { weaver: 2, spinner: 4 }` (§13 Q5; net ladder). |
| [`ArmUnit.js`](js/entities/ArmUnit.js:2972) | Gate `_updateNetting()` legacy path on `!Constants.FEATURE_FLAGS.CAPTURE_NET`. New path: bind `CaptureNet.getActiveNetForArm(armIndex)` and drive transitions off the FSM ([`CaptureNet.js`](js/entities/CaptureNet.js:1) §1-§4). **§13 Q5:** decrement `armNetCounts[armIndex]` on NETTING entry; F-press routes to `audioSystem.playClickFail()` + emits `NET_EMPTY_CLICK { armId }` when count === 0 (no FSM transition). |
| [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) | Already gated on the same flag — no source change needed. |
| [`main.js`](js/main.js) | Verify [`captureNetVisual.init(scene, player, captureNetSystem)`](js/scene/LaunchCinematic.js) (per [`HANDOFF.md:79`](HANDOFF.md:79)) is wired pre-flip. Stub if not. |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | Add `playClickFail()` — short low-pitched click (or reuse existing fail cue). §13 Q5. |
| [`DockingReticle.js`](js/ui/DockingReticle.js:684) | Render NET count `NET (n)` beside the existing SK readout pre-P2 (full tool panel lands P2). §13 Q5. |
| [`Events.js`](js/core/Events.js) | Add `NET_EMPTY_CLICK: 'net:emptyClick'`. §13 Q5. |
| [`PersistenceManager.js`](js/systems/PersistenceManager.js) | `armNetCounts` seed value validation — update default-fill from previous value to `ARM_NET_CAPACITY[arm.type]` (§13 Q5). |

**Tests to add.**
- [`test-CaptureNet.js`](js/test/test-CaptureNet.js) — already covers FSM transitions; bump to assert post-flag-flip success path: launching a Weaver fires a `LD-NET` (5 m), launching a Spinner fires `SD-NET` (1.5 m). Use [`getNetClassForType()`](js/entities/CaptureNet.js:35).
- New `test-Net-FlagOn-Smoke.js` — full integration test: deploy → STATION_KEEP → F → CAPTURED via real FSM, not legacy dice-roll. Asserts `captureNetSystem.getState().nets[armIdx].state` cycles `FOLDED→…→CAPTURED`.
- New `test-ArmUnit-NetInventory.js` (§13 Q5) — decrement on NETTING entry; a net reeled home empty is refunded to the magazine (refund-on-miss, CAPTURE_NET.md §3.5), only a wrapped/snapped net is spent; F at 0 emits `NET_EMPTY_CLICK`; no FSM transition; persisted counts round-trip through save/load.
- Update existing fixtures (`[3,3,3,3]` → `[2,2,2,2]`) in [`test-ArmTierCatalog.js:759`](js/test/test-ArmTierCatalog.js:759), [`test-Epic9-Integration.js:722`](js/test/test-Epic9-Integration.js:722), [`test-ArmTierCatalog.js:785`](js/test/test-ArmTierCatalog.js:785), [`test-ArmTierCatalog.js:821`](js/test/test-ArmTierCatalog.js:821) to match the new `ARM_NET_CAPACITY` seed.

**LOC delta:** ~60–80 modified source, ~140 net new test code (was: ~30 / ~80 pre-Q5).

**Risks.** The 886-LOC FSM may surface dormant bugs the legacy path was masking. Mitigation: keep the flag commit isolated; if `test.sh` regresses, the bisect is one commit. See §11 R1. **Q5 risk addition:** test-fixture churn (~4 files) — mitigate by grepping `armNetCounts.*\[3` and updating in one commit.

**Acceptance.**
- `node js/test/run-tests.js` → still 460/2060/0 plus the new test file's adds.
- Manual smoke: ORBITAL_VIEW → deploy Weaver → F at SK → see net visual (M-NET disc) spin up, fly out, cling, reel; no console errors; capture arrives ≤8 s after F.
- **§13 Q5 acceptance:** fire both Weaver nets (count 2 → 1 → 0); SK NET row dims to `NET (0)`; F-press on selected NET plays click-fail audio; no FSM transition; recommender swaps ▶ marker to next-best tool (GRIPPER or MAGNET).
- L1 ([`SK_M1_POLISH_HANDOFF.md:109-113`](archive/SK_M1_POLISH_HANDOFF.md:109)) — run `node --check js/entities/CaptureNet.js` and every modified `.js`.

### Phase 2 — Magnetic grapple + Tool-Selection HUD

| File | Change | LOC |
|---|---|---|
| [`Constants.js`](js/core/Constants.js) | Add `ARM_STATES.MAGNETIC_GRAPPLE`, `TOOL_KIND`, `DAUGHTER_TOOLSETS`, `MAGNETIC_GRAPPLE` block, `TOOL_HUD` block, `SURFACE_ROUGHNESS_BY_MATERIAL`, `DAUGHTER_MULTITOOL` flag, extend `MATERIALS` with `'steel'` ([`DebrisField.js:46`](js/entities/DebrisField.js:46)), add `DEBRIS_MATERIALS.steel` entry. | ~80 |
| [`Events.js`](js/core/Events.js:277) | Add 5 new `MAGNETIC_*` events + `TOOL_SELECTED` + `TOOL_ARMSET_CHANGED`. | ~10 |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | Add `selectedTool`, `toolset`, `cycleTool()`, `setTool()`, `dispatchSelectedTool()`, `magneticGrapple()`, `_updateMagneticGrapple(dt)` sub-state machine. Plumb on `STATION_KEEP_ENTERED`. | ~180 |
| [`DebrisField.js`](js/entities/DebrisField.js:443) | Add `ferromagnetic`/`paramagnetic`/`hasGrappleFixture`/`surfaceRoughness`/`surfaceTempC` derivations in the procedural factory (~5 lines) and [`CatalogConverter.js`](js/entities/CatalogConverter.js:140) return-object (~5 lines). | ~15 |
| [`TargetSelector.js`](js/systems/TargetSelector.js:103) | Extend `_updateRecommendation()` per §7. Add `_armContext` setter; subscribe to a `STATION_KEEP_ENTERED` to set context; clear on exit. | ~80 |
| [`DockingReticle.js`](js/ui/DockingReticle.js:684) | New `_drawToolSelectionPanel(ctx, cx, cy)` per §8.1. | ~80 |
| [`InputManager.js`](js/systems/InputManager.js:407-839) | Plain-backtick branch (SK→cycle); F branch (SK→dispatch). | ~25 |
| [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:109) | Extend exempt-state predicate to include `MAGNETIC_GRAPPLE`. The `_autopilotLockId` path already covers the active-target ID; verify it triggers for the magnet-acquired debris. | ~10 |
| [`PersistenceManager.js`](js/systems/PersistenceManager.js:373) | Persist `selectedTool` per arm; round-trip test. | ~15 |

**Tests to add.**
- `test-ArmUnit-MagneticGrapple.js` (new) — drives a Weaver from `STATION_KEEP` → `MAGNETIC_GRAPPLE` → `GRAPPLED` with `ferromagnetic: true` target; opposite case with `ferromagnetic: false` asserts `MAGNETIC_GRIP_FAILED`.
- `test-TargetSelector-MultiTool.js` (new) — table-driven: for each (target.material, target.mass, arm.type) row, assert recommended tool matches the §7 priority. Covers `undefined` flags = graceful net fallback.
- `test-DockingReticle-ToolPanel.js` (new) — instantiates the reticle, sets `_arm.state = 'STATION_KEEP'`, calls `_drawToolSelectionPanel`, asserts canvas2D draw calls (read fillText calls) include "NET" + "MAGNET" rows for Weaver, "NET" + "PAD" for Spinner.
- Extend [`test-StationKeep.js`](js/test/test-StationKeep.js) — assert F-key dispatch routes by `selectedTool`.
- Extend [`test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js) — `MAGNETIC_GRAPPLE` arm-state must be in the exempt set.

**LOC delta:** ~495 source modified, ~300 test code.

**Risks.**
- R2 — CA dodging a magnet-grappling arm: §3.4 dual-exempt. Mitigation: explicit unit test above.
- R3 — Magnetic recommender feels dead because no debris is steel. Mitigation: §6.2 `MATERIALS` extension + a single steel `WELCOME_FIELD` entry on mission ≥ 2 (manual playtest item).

**Acceptance.**
- Tests: 460 + N pass, 0 fail.
- Manual: select a steel rocket-body target → SK overlay shows ▶ MAGNET as ★★★; press F → see EPM blue flash via [`AudioSystem.playMagnetic()`](js/systems/AudioSystem.js:433) firing → debris reels in.
- Backtick cycles Weaver tools in order `NET → GRIPPER → MAGNET → NET …`; cycles Spinner `NET → PAD → MAGNET → NET …` (§13 Q2 — Spinner now 3 tools).
- SK polish: wheel zoom still works; sonar ping unchanged; no green ring; tool panel below readout, not overlapping.

### Phase 3 — Gripper jaws (Weaver tertiary)

| File | Change | LOC |
|---|---|---|
| [`Constants.js`](js/core/Constants.js) | Add `ARM_STATES.GRIPPER_GRAPPLE`, `GRIPPER_GRAPPLE` block, `WEAVER_GRIPPER` flag. | ~25 |
| [`Events.js`](js/core/Events.js) | `GRIPPER_LATCH_ATTEMPT`, `GRIPPER_LATCHED`, `GRIPPER_SLIPPED`, `GRIPPER_RELEASED`. | ~5 |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | `gripperGrapple()`, `_updateGripperGrapple(dt)` sub-states (EXTEND, SEEK_FIXTURE, CLOSE, LATCHED, SLIPPED). Add `dispatchSelectedTool()` GRIPPER branch. | ~140 |
| [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js) | Extend exempt predicate (`GRIPPER_GRAPPLE`). | ~5 |
| [`TargetSelector.js`](js/systems/TargetSelector.js:103) | Already wired via `tools.push({ k:'GRIPPER' })` in §7 — verify `WEAVER_GRIPPER` flag check. | ~5 |
| Visual (optional) | Stub. Weaver-arm 3D mesh extension deferred (visual polish is decoupled — keeps P3 small). | 0 |

**Tests.** `test-ArmUnit-GripperGrapple.js` (new) — fixture target → LATCHED → GRAPPLED; unfixtured target → SLIPPED → RETURNING.

**LOC delta:** ~180.

**Risks.** R4 — `hasGrappleFixture` heuristic too generous (all defunctSat+rocketBody get fixtures). Mitigation: keep `P_GRIP_FIXTURED=0.90` so failure rolls still happen; add a debug overlay flag for the heuristic during playtest.

**Acceptance.**
- All previous tests stay green; new GripperGrapple suite passes.
- Manual: Weaver in SK against a `rocketBody` target → `GRIPPER` shows ★★ (or ★★★ if non-ferrous); F dispatches; arm extends, latches, reels. Same target against Spinner → `GRIPPER` is *not* in the Spinner toolset, so it never appears.

### Phase 4 — Multi-modal pad (Spinner secondary)

| File | Change | LOC |
|---|---|---|
| [`Constants.js`](js/core/Constants.js) | Add `ARM_STATES.PAD_CONTACT`, `PAD_CONTACT` block, `SPINNER_PAD` flag. | ~30 |
| [`Events.js`](js/core/Events.js) | `PAD_CONTACT_ATTEMPT`, `PAD_ADHERED`, `PAD_BOUNCED`, `PAD_RELEASED`, `PAD_UV_DOSE_USED` (§13 Q3). | ~5 |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | `padContact()`, `_updatePadContact(dt)` (APPROACH_SOFT, CONTACT, MODE_RESOLVED, GRIP_ROLL, ADHERED/BOUNCED). Pure function `_resolvePadMode(target)` — testable in isolation. **§13 Q3:** per-arm `_padUvCureDosesRemaining` counter (seed = `PAD_CONTACT.UV_CURE_DOSES_Y0 = 10`); decrement on `mode === 'uv_cure'` adhered (not on fail-roll); `_resolvePadMode` filters `'uv_cure'` out of priority list when count === 0 → contact returns NO_MODE on exotic surfaces. | ~210 |
| [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js) | Extend exempt predicate (`PAD_CONTACT`). | ~5 |
| [`PersistenceManager.js`](js/systems/PersistenceManager.js:373) | Persist `padUvCureDosesRemaining: number[]` per arm; length-mismatch validation mirrors `armNetCounts`. §13 Q3. | ~20 |
| [`DockingReticle.js`](js/ui/DockingReticle.js) | When `selectedTool === 'PAD'`, show resolved mode glyph (`g/h/e/m/u`) under the row, **only after** entering PAD_CONTACT → MODE_RESOLVED. **§13 Q3:** append ` [u:n/10]` UV dose counter to PAD row; dim when n=0. | ~40 |

**Tests.** `test-ArmUnit-PadContact.js` (new) — drive `_resolvePadMode` with each surface row from §5.3 priority table; assert returned mode. Then full FSM integration on a Spinner. **§13 Q3 additions:** assert UV count decrements ONLY on success; count=0 removes `'uv_cure'` from resolver → exotic surface returns NO_MODE; persistence round-trip on `padUvCureDosesRemaining`.

**LOC delta:** ~310 (was ~250 pre-Q3).

**Risks.** R5 — mode priority disagreement with [`archive/V3 Octopus.md:811-816`](archive/V3%20Octopus.md:811) under non-default surface temps. Mitigation: priority table is constants-first ([`PAD_CONTACT.ADHESION_MODES`](#)), tune via Constants without touching code.

**Acceptance.** Spinner in SK against a `fragment` (mass ≤ 10) → PAD shows ★★★; F dispatches; CONTACT → resolved mode glyph appears (e.g. `g` gecko for Al fragment); ADHERED → REELING.

---

## §10 — Test Plan

| New test file | What it tests |
|---|---|
| `test-Net-FlagOn-Smoke.js` | Post-flag-flip: real FSM path through CAPTURE_NET states; Weaver gets LD-NET, Spinner gets SD-NET. |
| `test-ArmUnit-MagneticGrapple.js` | Ferrous target → grip; non-ferrous → fail; mass > 500 kg → fail with reason `'too_heavy'`; collision-avoidance sees arm as exempt during MAGNETIC_GRAPPLE. |
| `test-TargetSelector-MultiTool.js` | Recommendation table per (material, mass, type, armType). Includes graceful fallback with `undefined` fields. |
| `test-DockingReticle-ToolPanel.js` | Render-call assertions for the new SK panel; Weaver vs Spinner row count; ▶ marker moves on cycle. |
| `test-ArmUnit-GripperGrapple.js` | Fixture vs no-fixture; oversize fail; LATCHED zero-power hold (state lingers without thrust). |
| `test-ArmUnit-PadContact.js` | `_resolvePadMode()` priority table; bounce on too-fast contact; **§13 Q3 — UV-cure dose decrement only on success; count=0 removes 'uv_cure' from priority list; persistence round-trip on `padUvCureDosesRemaining[]`.** |
| `test-ArmUnit-NetInventory.js` (new, §13 Q5) | NETTING entry decrements `armNetCounts[i]`; a net reeled home empty is refunded (refund-on-miss, CAPTURE_NET.md §3.5) — only a wrapped/snapped net is spent; F-press at 0 emits `NET_EMPTY_CLICK` and plays click-fail audio with no FSM transition; recommender drops NET to score 0 when depleted. |
| Extension to [`test-CaptureNet.js`](js/test/test-CaptureNet.js) | Net-class-by-platform assertions. |
| Extension to [`test-StationKeep.js`](js/test/test-StationKeep.js) | F dispatches by `selectedTool`; backtick cycles arm-local toolset. |
| Extension to [`test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js) | All 3 new ARM_STATES included in the dodge-exempt predicate; matches §3.4 dual-axis pattern. |
| Extension to [`test-ArmUnit-DeployState.js`](js/test/test-ArmUnit-DeployState.js) | Selected-tool round-trip through deploy/recall (`selectedTool` is preserved). |

**Test philosophy** — follows [`HANDOFF.md §3.5`](HANDOFF.md:535): integration tests over stubs, real `three` objects via [`TestRunner.js`](js/test/TestRunner.js:1). Every new state has at least one integration test that drives the **real** ArmUnit through entry → success and entry → failure paths.

**§3.2 audit.** All new physics — pad approach velocity, magnetic closing rate — must multiply real `dt` by `Constants.TIME_SCALE_GAMEPLAY` or read from per-state `gameDt`. Author the velocity-clamp test that catches a 10× error (compare against [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164) pattern).

---

## §11 — Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | Flipping `CAPTURE_NET` surfaces dormant bugs in the 886-LOC FSM ([`CaptureNet.js`](js/entities/CaptureNet.js:1)). | Med | High | Isolate the flag flip to its own commit. Pre-run [`test-CaptureNet.js`](js/test/test-CaptureNet.js) + [`test-CaptureNetVisual.js`](js/test/test-CaptureNetVisual.js). Add `test-Net-FlagOn-Smoke.js` before flipping. Bisect-friendly. |
| **R2** | Collision Avoidance dodges the arm while it's deliberately closing on a magnet target (§3.4 gotcha). | High | High | Explicit exempt-state predicate in [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:109) for `MAGNETIC_GRAPPLE / GRIPPER_GRAPPLE / PAD_CONTACT`. Test in `test-CollisionAvoidance.js`. Manual smoke: approach steel target with magnet selected; assert no `CA_DODGE_EXECUTED` events fire. |
| **R3** | Save-game corruption from new per-arm `selectedTool` field. | Low | Med | Default to `'NET'` on missing field in [`PersistenceManager`](js/systems/PersistenceManager.js:373). Add a round-trip test in `test-ArmUnit-DeployState.js`. |
| **R4** | `hasGrappleFixture` heuristic too broad → gripper recommended for every rocket body. | Med | Low | Heuristic ships behind `WEAVER_GRIPPER` flag with `P_GRIP_FIXTURED=0.90` (10% slip rate). Plan to refine using SensorSystem scan data in a later cycle (out of scope here). |
| **R5** | Pad mode-resolution disagreement with V3 Octopus design intent on edge materials. | Low | Low | All mode priorities live in `PAD_CONTACT.ADHESION_MODES` Constants. Tune without code change. |
| **R6** | SK overlay vertical real-estate: new panel pushes against bottom-screen NavSphere. | Low | Med | Panel sits **immediately below** the existing θ/φ/R box (boxY+70 from [`DockingReticle.js:693`](js/ui/DockingReticle.js:693)). At default 1920×1080 there is ≥300 px headroom. Manual visual check in P2 acceptance. |
| **R7** | Backtick already wired with Shift+ in legacy path → keybind conflict. | Low | Low | Plain `` ` `` in SK = arm-local cycle; Shift+`` ` `` in orbital view = legacy global TOOL_CYCLE. Existing handler at [`InputManager.js:1166`](js/systems/InputManager.js:1166) is shift-gated already — leave unchanged. |
| **R8** | `MATERIALS` pool extension (adding `'steel'`) breaks existing texture-atlas assertions in [`test-DebrisVisuals.js:30`](js/test/test-DebrisVisuals.js:30). | Med | Low | Update the EXPECTED_TAGS list in test; add `DEBRIS_MATERIALS.steel` entry with distinct color. |
| **R9** | L1 silent-break trap ([`SK_M1_POLISH_HANDOFF.md:109-113`](archive/SK_M1_POLISH_HANDOFF.md:109)) — template-literal/backtick issue. | Med | Med | `node --check` every modified `.js` before commit. Mandatory in every phase's acceptance gate. |
| **R10** | `TIME_SCALE_GAMEPLAY` 10× multiplier silently scales approach speeds in new sub-state machines (§3.2). | Med | Med | Audit all `velocity = X * dt` computations in new `_update*` functions; use `gameDt = dt * TIME_SCALE_GAMEPLAY` where applicable, matching the pattern in [`DebrisField.update()`](js/entities/DebrisField.js:620). |

---

## §12 — Feature Flags

| Flag | Default | Flip in | Effect when ON |
|---|---|---|---|
| `FEATURE_FLAGS.CAPTURE_NET` ([`Constants.js:409`](js/core/Constants.js:409)) | currently `false` | **P1** | Live 14-state net FSM via [`CaptureNet.js`](js/entities/CaptureNet.js:1); per-platform net classes (M/LD/SD); visual layer ([`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js)) renders. |
| `FEATURE_FLAGS.DAUGHTER_MULTITOOL` (new) | `false` | **P2** | `ARM_STATES.MAGNETIC_GRAPPLE` + tool-selection HUD + backtick-cycle-in-SK + F-dispatch-by-selected. |
| `FEATURE_FLAGS.WEAVER_GRIPPER` (new) | `false` | **P3** | `ARM_STATES.GRIPPER_GRAPPLE` enabled; appears in Weaver toolset; recommended on `hasGrappleFixture`. |
| `FEATURE_FLAGS.SPINNER_PAD` (new) | `false` | **P4** | `ARM_STATES.PAD_CONTACT` enabled; Spinner toolset adds `PAD`; mode-resolver active. |

**Reality-mode interaction.** [`Constants.isFeatureEnabled()`](js/core/Constants.js:2120) currently force-disables all flags when `REALITY_MODE === true` ([`Constants.js:2121`](js/core/Constants.js:2121)). All four new flags inherit this — Reality Mode disables multitool too. This is correct: Reality Mode is the all-flags-off integration baseline ([`HANDOFF.md:398`](HANDOFF.md:398)).

---

## §13 — Decisions Log

> *Resolved 2026-05-16 in architect-mode interactive review with the user. Supersedes the original §13 "Open Questions for the Human."*

### §13.1 — Decision Table

| Q# | Question (short) | Decision (verbatim from user) | Rationale | Sections updated |
|---|---|---|---|---|
| **Q1** | Gripper score vs. net | "GRIPPER scores 3 (recommended) when (mass > arm's net cap) OR (type === 'rocketBody') OR (hasGrappleFixture && mass >= 50). NET self-demotes to score 1 on oversize. Otherwise GRIPPER stays at score 1 (visible, not highlighted)." | Gripper's player-facing role is **class-oversize / unusual-shape / spar-blocking-net** — concrete testable rules instead of fuzzy weights. Preserves V3 Octopus "nets-first" doctrine for in-class targets. | §7 |
| **Q2** | Spinner EPM player-facing? | "Add MAGNET to Spinner. `DAUGHTER_TOOLSETS.spinner = ['NET', 'PAD', 'MAGNET']`. Honours EPIC10 verbatim. Spinner HUD shows 3 rows. Same MAX_DEBRIS_MASS_KG (500) as Weaver." | EPIC10 spec'd dual-role EPMs on **every** daughter; this honours the hardware doc. Spinner's choice space now matches Weaver's. | §1, §2, §4.1 (`DAUGHTER_TOOLSETS`), §7 (recommender per-arm filter), §8.1 (Spinner mockup → 3 rows), §9.2 |
| **Q3** | UV-cure dose enforcement | "Enforce cap now — 10 doses/arm, hard limit. Exhausted UV-cure removes it from the priority list (contact returns NO_MODE on exotic surfaces). HUD shows dose counter; persisted to save. ~30 LOC, 1 new test." | UV-cure becomes a real Y0 resource matching V3 Octopus's "finite-magazine" intent. Forces the pad to **fail visibly** on unsupported surfaces once doses are spent. | §4.1 (PAD_CONTACT comment), §5.3, §6.3, §8.1 (HUD), §9.4, §10, §14 |
| **Q4** | Titanium / paramagnetic | "Heterogeneous-spacecraft model — Drop paramagnetic. Add `hasFerrousFasteners` (derived from type === 'rocketBody' \|\| 'defunctSat'). Those get P_GRIP=0.40 (latches onto bolts). All-Al fragments get P=0.05." | Real spacecraft are heterogeneous (steel bolts in Al/Ti hulls). Material-purity model replaced with structure-realism model. Eliminates the physically-bogus `P_GRIP_PARAMAGNETIC=0.55` line. | §4.1 (MAGNETIC_GRAPPLE constants), §6.1, §6.2, §7 |
| **Q5** | Net-count decrement | "Decrement on launch, hard-fail at 0, no auto-refill. Out-of-nets becomes a real fail state requiring manual resupply UX (deferred)." Carry counts (net ladder): **Large Daughter (weaver)=2, Small Daughter (spinner)=4** (payload-fraction invariant ~21% / ~23%). **Refund-on-miss (code wins over the original "no refund" draft, CAPTURE_NET.md §3.5):** a net reeled home empty returns to the magazine; only a net wrapped around a catch or lost to snap is spent — magazine count = successful captures per load. | Inventory becomes meaningful at Y0. Counts honour the mass budget. Graceful degradation: at `armNetCounts[i]===0` the NET row dims to count `0`, recommender drops NET to score 0, F-dispatch plays click-fail audio so the player learns to backtick to another tool. | §1, §3, §4.1 (new `ARM_NET_CAPACITY`), §7 (zero-net handling), §8.1 (NET shows `(n)`), §8.2 (click-fail audio), §9.1 (P1 scope grows), §10 (`test-ArmUnit-NetInventory.js` added), §14 (line removed) |
| **Q6** | Toolsets runtime-mutable? | "Static-by-class. `Constants.DAUGHTER_TOOLSETS[arm.type]` read on construction; not persisted. Y1 unlocks via Constants edits + feature flags. Cheapest, smallest save schema." | Matches §4.1 draft; lowest-risk schema; Y1+ unlocks remain cheap (Constants edit + new flag). | §4.1 (annotation only) |
| **Q7** | SK panel pulse? | "Static cyan ★s + yellow ▶ selector. No animation. Quietest; trusts the player to read the panel. Recommended tool is bold or highlighted." | Honours [`SK_M1_POLISH_HANDOFF.md:221-227`](archive/SK_M1_POLISH_HANDOFF.md:221) "no SK animation" ethos. **Bold text weight** on the recommended row carries the affordance without motion. | §8.1, §8.2 |

### §13.2 — Emergent questions (Q8+)

None. The dialogue surfaced one implementation-level corollary — graceful degradation when net inventory hits 0 — but it follows deterministically from Q5 and is encoded into §7 / §8.1 / §9.1 below.

### §13.3 — Phase-1 readiness statement

**YES — Phase 1 is unblocked**, with one scope adjustment from Q5: P1 now implements net-count decrement + hard-fail at 0 + click-fail audio + HUD count display, **in addition to** the original "flip flag + bind FSM" minimum. Revised P1 LOC delta: **~60–80 source + ~140 test code** (was ~30 / ~80). Phase-1 acceptance bar gains: *"depleting an arm's nets dims its NET row in the SK HUD; recommender promotes another tool; F-press on empty NET plays click-fail cue."* Decisions Q2 (Spinner MAGNET), Q3 (UV-cure cap), Q4 (fasteners), Q7 (bold) do not affect P1 — they reshape P2 / P4 acceptance only.

---

## §14 — Out of Scope

Restated so future readers don't expand scope:

- ~~**Net expenditure economy**~~ — *Removed by §13 Q5.* Net decrement + hard-fail + HUD `NET (n)` count are now **in scope at Y0**. Still out of scope: auto-refill, return-to-mother resupply UX, shop replenishment, cost-of-failure penalties — those remain Y1+.
- **Tether tension reel-in mini-game.** Reel-in remains the existing motor reel ([`Constants.js:343-356`](js/core/Constants.js:343)).
- **Y1+ tool unlocks** — gecko-only Y1, harpoon/EDT Y2, UV-cure Y3, MPD Y4. All Y0 doors closed.
- **Tier-ladder arm-count progression** — Y0_QUAD → Y1_HEX → Y3_OCTO. Stays gated behind `SHIPYARD_REFIT` ([`Constants.js:385`](js/core/Constants.js:385)).
- **Mission-2 planning** — no mission-arc work; only Mission 1 must remain green.
- **Skills-system gating of tool unlocks.** All four tools available from mission 1 once their flag is ON.
- **Inspection-data-driven recommendations** — Y0 uses heuristics (§6.1). Sensor-scan-driven refinement is a later cycle.
- **Daughter-arm 3D mesh additions** for gripper jaws or pad — visual polish deferred; functional only at Y0.
- **Recoil-into-mother compensation** for tool firing (§4.8 of [`HANDOFF.md`](HANDOFF.md:758)). Handled by existing `STATION_KEEP_COMPENSATION` (line 1484) — no new wiring needed for the three new tools because none of them produce significant recoil (all sub-50 N forces).

---

## §15 — Tool Selection & Net-Failure Modes (folded from GAME_FLOW_BRAINSTORM.md)

> Consolidated 2026-06-07. The brainstorm source is archived at [`archive/GAME_FLOW_BRAINSTORM.md`](archive/GAME_FLOW_BRAINSTORM.md) (delight/reward/journey color retained there). The load-bearing design — *why the net fails and which tool counters each failure* — lives here because it is the design contract for the §2 multi-tool inventory and the §7 recommender.

### §15.1 The four root-cause families (the mental model to teach)

Every net failure reduces to one of four physics causes. Each has a counter-tool the recommender (§7) should surface:

1. **Angular momentum beats the net (tumble > ~10°/s).** Compliant low-mass net's near edge is whipped off / tangles. → **Laser de-spin first**, then net. The canonical 2-step combo (ROADMAP CP-2).
2. **No purchase geometry (smooth/convex, no protrusions).** Cinched net slides off. → **MAGNET** if ferrous (or ferrous fasteners — see §6 heterogeneous-spacecraft model); **PAD** (gecko/electrostatic) if not; **GRIPPER** if a fixture exists.
3. **Scale mismatch.** Sub-mesh fragment passes through; >2000 kg body can't be enveloped/reeled. → **PAD** (Spinner) for tiny; **harpoon/ablation-deorbit** for massive (sheriff play, not scavenger).
4. **Hostile surface state.** Charge/arc, fragile panels crushed by cinch, cabled debris dragging neighbours. → discharge / compression-free pad / cable-cut before net.

### §15.2 The eight observable failure modes (symptom → counter)

| # | Symptom | Root cause | Counter-tool | TRL |
|---|---|---|---|---|
| 1 | Net slings off a corner | high tumble (>10°/s) | laser detumble | 5 |
| 2 | Net slides off curved hull | smooth ferromagnetic, no entanglement | magnetic grapple (EPM) | 9 |
| 3 | Net flies past it | fragment < mesh aperture | gecko/electrostatic pad (Spinner) | 4–5 |
| 4 | Net contacts but can't envelop | massive intact body (>2000 kg) | harpoon + slow drag, or ablation-deorbit | 7 |
| 5 | Net captures but breaks panels | cinch crushes thin structure | adhesion pad (no compression) | 4 |
| 6 | Net repelled / arcs | spacecraft charging | discharge wand → grapple | 6 |
| 7 | Net snags a trailing cable | cabled/MLI debris drags neighbours | cable-cut laser pulse first | 6 |
| 8 | Houston REFUSES (RED) | treaty-protected active sat | none — `ActiveSatGuard` blocks arming | n/a |

**Design principle:** every failure must answer three questions visibly — *what failed (symptom), why (root-cause readout), what now (a counter-tool owned or shop-visible)*. The STATION_KEEP inspect step must be **mandatory and rewarded** — "inspect before commit" is the doctrine that makes the tool ladder matter. Net failures should prefer **partial/recoverable** outcomes (TANGLED decision: settle vs yank) over binary loss — see ROADMAP EN-2.

### §15.3 The seven-tool kit (range / best-for / mechanism)

| Tool | Range | Best for | Mechanism | TRL | Build phase |
|---|---|---|---|---|---|
| Bolas/Lasso | 50 m | small, slow, near | spinning weighted line | 9 | shipped |
| Net (Weaver) | 2 km | medium, tumbling, mesh-grippable | Miura-ori + SMA cinch | 7 | shipped (P1) |
| Net (Spinner) | 500 m | small, fast-react | 1.5 m fast net | 7 | shipped (P1) |
| Magnetic grapple | 5–50 m contact | ferrous hull / fasteners | EPM | 9 | **P2 (CP-1 priority)** |
| Gripper jaws | contact | protruding fixtures | 3-jaw chuck | 7 | P3 |
| Multi-modal pad | contact | smooth/fragile/tiny | gecko/hooks/electro/magnet/UV | 4–5 | P4 |
| Laser detumble | 500 m (mother) | anything tumbling >10°/s | photon ablation | 5 | CP-2 |

**Multi-modal pad doctrine (Spinner secondary):** the pad auto-resolves adhesion mode on contact (gecko/hooks/electrostatic/magnet/UV-cure). *The player's job is to get the pad to TOUCH the debris; the pad figures out which mode wins.* This rewards positioning over tool-selection — the load-bearing line for §5.3's `PAD_CONTACT` resolver.

### §15.4 Acquisition ladder (each tool opens NEW debris types, not "more damage")

Y0: bolas, Spinner/Weaver net → **magnet, laser detumble** (first capture failures teach the need) → Y1 gecko/multi-modal pad → Y2 electrostatic, EDT, harpoon → Y3 mussel-catechol adhesive → Y4 MPD, 500 W beam. This ladder = the difficulty ladder = the TRL curriculum (ROADMAP §0).

---

*End of spec. Total: 15 sections. Cross-reference: [`HANDOFF.md`](HANDOFF.md), [`ROADMAP.md`](ROADMAP.md) (CP-1/CP-2), [`CAPTURE_NET.md`](CAPTURE_NET.md), [`archive/V3 Octopus.md`](archive/V3%20Octopus.md), [`archive/GAME_FLOW_BRAINSTORM.md`](archive/GAME_FLOW_BRAINSTORM.md), [`archive/EPIC10_DEEP_ANALYSIS.md`](archive/EPIC10_DEEP_ANALYSIS.md), [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md).*
