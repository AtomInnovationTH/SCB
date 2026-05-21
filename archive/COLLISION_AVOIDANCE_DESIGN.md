# Collision Avoidance AI — System Design

*Module: `js/systems/CollisionAvoidanceSystem.js`*  
*Author: Architect mode — 2026-04-12*

---

## A. System Overview

### What IS Collision Avoidance?

A **semi-autonomous evasive maneuver system** that continuously monitors nearby debris trajectories and, when an imminent collision is detected, automatically fires a small lateral thrust to dodge — unless the player has explicitly targeted that debris for capture.

It is **not** a warning system (that's [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:61)), and it is **not** path planning (that's [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:31)). It sits between them: it consumes conjunction-style predictions and produces autopilot-style thrust commands, but only for **emergency evasion**.

**Real-world analogue:** The ISS Pre-Determined Debris Avoidance Maneuver (PDAM) system — when a tracked object's miss distance falls below a threshold, a small ΔV burn is executed perpendicular to the threat vector.

### Separate System vs. Extend AutopilotSystem?

**Separate system** — [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js). Rationale:

| Factor | AutopilotSystem | CollisionAvoidanceSystem |
|--------|----------------|--------------------------|
| Purpose | Navigate toward a goal | Avoid a threat |
| Priority | Low — player convenience | High — survival |
| Active when | Manually toggled (A key) | Always on (toggleable) |
| Thrust pattern | Continuous toward heading | Brief impulse perpendicular |
| ΔV budget | Uses until disengage threshold | Minimal — single dodge pulse |

The two can run simultaneously: autopilot steers toward a target while collision avoidance fires a brief lateral correction if debris threatens from the side. They share the same thrust API ([`PlayerSatellite.thrustIon()`](js/entities/PlayerSatellite.js:1632) / [`applyRCS()`](js/entities/PlayerSatellite.js:1979)) but never conflict because avoidance is a short impulse perpendicular to the velocity vector.

### Player Input Model

| Mode | Behavior |
|------|----------|
| **Default (on)** | System auto-dodges. Brief comms message. No player action needed. |
| **Manual override** | Player arrow/WASD input within 2s of an avoidance alert cancels the dodge (player knows what they're doing). |
| **Disabled** | Player can toggle off via comms menu. HUD indicator shows "CA OFF". |
| **ARM_PILOT** | Suppressed — don't interfere with fine motor arm control. |
| **Active target approach** | Suppressed for the selected target's debris ID — don't dodge what you're trying to catch. |

---

## B. Detection Algorithm

### Data Available

From [`DebrisField.js`](js/entities/DebrisField.js:130), each debris object exposes:

- `debris.orbit` — Keplerian elements (scene-unit SMA)
- `debris._scenePosition` — cached `THREE.Vector3` (updated each frame at [line 685](js/entities/DebrisField.js:685))
- `debris.alive` — boolean
- `debris.id` — unique identifier
- `debris.mass` — kg

From [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:33):

- [`getPosition()`](js/entities/PlayerSatellite.js:2248) → `THREE.Vector3` (scene units)
- [`getVelocity()`](js/entities/PlayerSatellite.js:2253) → `{x,y,z}` (km/s via `_cartesian.velocity`)
- [`orbit`](js/entities/PlayerSatellite.js:44) — Keplerian elements

### Prediction: Linear Closest-Approach (reuse ConjunctionSystem math)

[`ConjunctionSystem._predictClosestApproach()`](js/systems/ConjunctionSystem.js:264) already implements the exact algorithm needed:

```
TCA = −(Δr · Δv) / (Δv · Δv)   clamped to [0, LOOK_AHEAD_S]
miss = |Δr + Δv × TCA|
```

The Collision Avoidance System will **reuse this math** (extract to a shared utility or inline) with different parameters:

| Parameter | ConjunctionSystem | CollisionAvoidanceSystem |
|-----------|------------------|--------------------------|
| Look-ahead | 60 s | 10 s (shorter — only imminent threats) |
| Scan radius | 0.5 scene units (50 km) | 0.05 scene units (5 km) |
| Check frequency | Random 30–120 s | Every frame (throttled to 4 Hz) |
| Threshold | GREEN 5 km / YELLOW 500 m / RED 200 m | Single threshold: 100 m |

### Distinguishing Collision from Safe Pass from Target Approach

```
for each nearby debris:
  if debris.id === activeTarget.id → SKIP (player wants this one)
  if TCA < 0 → SKIP (receding)
  if miss > AVOIDANCE_RADIUS → SKIP (safe pass)
  if miss ≤ AVOIDANCE_RADIUS AND TCA ≤ LOOK_AHEAD → THREAT
```

The **active target exemption** is critical. The system checks:
1. [`TargetSelector.getActiveTarget()`](js/systems/TargetSelector.js) — currently selected debris
2. Any arm with a `.target` matching this debris ID (arm is approaching it)

### Performance Budget

- **800 interactive debris** in [`DebrisField.debrisList`](js/entities/DebrisField.js:144)
- **Pre-filter**: Use `debris._scenePosition` distance² check (no `orbitToSceneCartesian` call). Cost: 800 subtractions + 800 multiplies ≈ negligible.
- **Full prediction**: Only for debris within 5 km scan radius. At 350 km altitude, typically 5–20 debris in range.
- **Throttle**: Run full scan at **4 Hz** (every 250 ms), not every frame. Use `_scanTimer` accumulator.
- **Estimated cost**: < 0.1 ms per scan cycle. Zero GC pressure (pre-allocated temporaries).

---

## C. Avoidance Strategy

### Maneuver Selection

When a threat is detected (miss distance < 100 m, TCA < 10 s):

1. **Compute evasion direction** — perpendicular to both the threat approach vector and the player's velocity vector (cross product). This is the minimum-ΔV dodge direction. Reuse [`ConjunctionSystem._generateEvasionVector()`](js/systems/ConjunctionSystem.js:328) logic.

2. **Compute required ΔV magnitude** — proportional to threat severity:
   ```
   dodgeDV = BASE_DODGE_DV × (1 - miss / AVOIDANCE_RADIUS)
   ```
   Where `BASE_DODGE_DV` ≈ 0.5 m/s (tiny — real ISS avoidance maneuvers are 0.3–1.5 m/s).

3. **Apply as RCS impulse** — use [`PlayerSatellite.applyRCS(direction, dt)`](js/entities/PlayerSatellite.js:1979) for a single frame burst. RCS is appropriate because:
   - No fuel cost beyond cold gas (cheap)
   - Instant response (no spool-up)
   - Small magnitude (within RCS capability)
   - Doesn't trigger thruster interlock checks

### Interference Prevention

| Situation | Response |
|-----------|----------|
| **Arm is deploying** (any arm in LAUNCHING/TRANSIT/APPROACH) | Dodge anyway — mothership safety > arm trajectory |
| **Active target approach** | Skip dodge for that specific debris ID |
| **Trawl sweep active** | Reduce sensitivity (raise threshold to 50 m) — trawl expects close passes |
| **ARM_PILOT mode** | Fully suppress — player has fine control |
| **Autopilot engaged** | Fire dodge, then emit event so autopilot can re-acquire heading |

### Fuel Cost

- Single dodge: ~0.001 kg N₂ cold gas (negligible — [`Constants.COLD_GAS_MAX`](js/core/Constants.js:36) = 20 kg)
- Per-mission average: 3–5 dodges × 0.001 kg = 0.005 kg (invisible to player resource budget)
- **No ΔV budget concern** — this is RCS, not ion thrust

### Priority Hierarchy

```
1. AVOID COLLISION (override everything except ARM_PILOT)
2. Maintain autopilot heading (re-acquire after dodge)
3. Conserve fuel (minimal impulse — just enough to clear)
```

---

## D. Player Experience

### Visual Feedback

1. **HUD indicator** — persistent small icon in status area:
   - `●` green: CA system active, no threats
   - `●` amber: threat detected, evaluating
   - `●` red + pulse: evasion executing
   - `○` gray: CA disabled

2. **Threat direction marker** — brief red chevron on screen edge pointing toward incoming debris (similar to conjunction warning, but smaller and faster). Appears 2–3 seconds before dodge fires. Fades after dodge completes.

3. **Dodge trail** — subtle particle puff from RCS nozzles (already exists via [`_fireRcsPuff()`](js/entities/PlayerSatellite.js:2032)) during the evasion impulse.

4. **No full-screen overlay** — this is NOT a conjunction alert. It's a quiet, competent system that just handles things.

### Audio Cues

| Event | Sound |
|-------|-------|
| Threat detected | Soft double-blip (200 Hz, 50 ms × 2) |
| Evasion firing | Brief hiss (white noise, 100 ms) — reuse RCS sound |
| Threat cleared | Single ascending tone (300→400 Hz, 80 ms) |
| CA re-enabled | Click |

### Comms Messages

```
Threat detected:  "[CA] Debris ${id} — TCA ${tca}s, miss ${miss}m — evaluating"
Evasion firing:   "[CA] Evasion burn — ${dvMs} m/s ${direction}"
Threat cleared:   "[CA] Clear. Resume heading."
Suppressed:       "[CA] Threat ${id} suppressed — active target" (only on first occurrence)
```

All at `priority: 'info'` (below conjunction warnings but visible in comms panel).

### Toggle & Upgrade Path

| Feature | Method | When |
|---------|--------|------|
| **Toggle on/off** | Comms menu command #7 or new key binding | Always available |
| **Upgradeable: Enhanced CA** | Shop purchase | Doubles look-ahead to 20 s, adds second-order (acceleration-aware) prediction |
| **Upgradeable: Predictive Shield** | Shop purchase | Auto-activates Whipple shield allocation for unavoidable impacts |

### Avoiding Player Frustration

The biggest risk: **dodging debris the player is trying to catch.**

Mitigations:
1. **Active target exemption** — if the player Tab-selected a debris, CA ignores it entirely
2. **Arm target exemption** — if any deployed arm has this debris as `.target`, CA ignores it
3. **Proximity suppression** — within 200 m (close approach for capture), CA reduces sensitivity
4. **Manual override window** — any player input (WASD/arrow) within 1.5 s of a dodge alert cancels the dodge and emits "[CA] Override — manual control"
5. **Trawl mode leniency** — during active trawl, threshold tightened to 50 m (debris will be close)

---

## E. Integration Points

### Events to Listen For

| Event | Source | Action |
|-------|--------|--------|
| [`Events.CONJUNCTION_WARNING`](js/core/Events.js:182) | ConjunctionSystem | Boost alert state (CA knows a macro-threat exists) |
| [`Events.CONJUNCTION_CLEAR`](js/core/Events.js:183) | ConjunctionSystem | Clear boosted state |
| [`Events.TARGET_SELECTED`](js/core/Events.js:37) | TargetSelector | Cache active target ID for exemption |
| [`Events.TARGET_CLEARED`](js/core/Events.js:38) | TargetSelector | Clear exemption |
| [`Events.TRAWL_START`](js/core/Events.js:168) | TrawlManager | Enter trawl-leniency mode |
| [`Events.TRAWL_END`](js/core/Events.js:169) | TrawlManager | Exit trawl-leniency mode |
| [`Events.TRAWL_SWEEP_COMPLETE`](js/core/Events.js:189) | TrawlManager | Exit trawl-leniency mode |
| [`Events.TUTORIAL_STAGE_CHANGED`](js/core/Events.js:207) | TutorialSystem | Suppress during early tutorial (stage < 5) |
| [`Events.GAME_RESET`](js/core/Events.js:47) | GameFlowManager | Reset all state |

### Events to Emit

| Event (new) | When | Payload |
|-------------|------|---------|
| `Events.CA_THREAT_DETECTED` | Threat enters threshold | `{ debrisId, tca, missDistance, evasionVector }` |
| `Events.CA_EVASION_FIRING` | Dodge impulse applied | `{ debrisId, direction, magnitude }` |
| `Events.CA_THREAT_CLEARED` | Threat receded or dodged | `{ debrisId }` |
| `Events.CA_OVERRIDE` | Player input cancelled dodge | `{ debrisId }` |
| `Events.CA_TOGGLE` | System enabled/disabled | `{ enabled }` |

### Update Loop Position

```
main.js game loop:
  1. inputManager.processInput(dt)        ← player input (may override CA)
  2. autopilotSystem.update(dt)            ← steering + thrust
  3. collisionAvoidanceSystem.update(dt)   ← HERE: after autopilot, before player.update
  4. player.update(dt, sunDirection)        ← applies accumulated thrust
  5. debrisField.update(dt, playerPos)
  6. conjunctionSystem.update(...)
  7. kesslerSystem.update(dt)
```

Placing it **after autopilot but before player.update** ensures:
- Autopilot's thrust is already queued (CA adds on top)
- Player input has been processed (CA can detect override)
- Player hasn't moved yet (CA uses current-frame position)

### System Interactions

| System | Interaction |
|--------|------------|
| [`AutopilotSystem`](js/systems/AutopilotSystem.js:31) | CA fires alongside AP thrust. AP already listens to `CONJUNCTION_WARNING` for tier ≥ 2 disengage ([line 373](js/systems/AutopilotSystem.js:373)). CA handles the actual dodge. |
| [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:61) | Complementary. Conjunction = strategic warning (30–120 s intervals, 3 per mission). CA = tactical dodge (continuous, unlimited). CA listens to conjunction events to boost awareness. |
| [`KesslerSystem`](js/systems/KesslerSystem.js:34) | If CA fails to dodge and collision occurs, Kessler handles shield absorption / game-over ([line 79](js/systems/KesslerSystem.js:79)). CA is the first line of defense. |
| [`InputManager`](js/systems/InputManager.js:15) | CA checks `inputManager.keys` for recent WASD/arrow input to detect manual override. CA also respects `isArmPilotMode()` ([line 112](js/systems/InputManager.js:112)). |

### Constants to Add

Add to [`Constants.js`](js/core/Constants.js:6):

```javascript
// =========================================================================
// COLLISION AVOIDANCE — Semi-autonomous evasive maneuver system
// =========================================================================

COLLISION_AVOIDANCE: {
  SCAN_RADIUS: 0.05,              // scene units (5 km)
  SCAN_RADIUS_SQ: 0.0025,         // pre-computed squared
  AVOIDANCE_RADIUS_M: 100,        // meters — dodge threshold
  AVOIDANCE_RADIUS: 0.001,        // scene units (100 m)
  TRAWL_AVOIDANCE_RADIUS_M: 50,   // meters — tighter threshold during trawl
  TRAWL_AVOIDANCE_RADIUS: 0.0005, // scene units (50 m)
  LOOK_AHEAD_S: 10,               // seconds — prediction window
  SCAN_INTERVAL: 0.25,            // seconds — scan every 250 ms (4 Hz)
  BASE_DODGE_DV: 0.5,             // m/s — peak dodge impulse
  OVERRIDE_WINDOW: 1.5,           // seconds — player input cancels dodge
  ALERT_DISPLAY_TIME: 3.0,        // seconds — HUD threat indicator duration
  TUTORIAL_MIN_STAGE: 5,          // suppress during tutorial stages 0-4
  M: 0.00001,                     // 1 meter in scene units
  KM_TO_SCENE: 0.01,              // velocity conversion: km/s → scene-units/s
},
```

### Events to Add

Add to [`Events.js`](js/core/Events.js:13):

```javascript
// === COLLISION AVOIDANCE ===
CA_THREAT_DETECTED:    'ca:threatDetected',    // { debrisId, tca, missDistance, evasionVector }
CA_EVASION_FIRING:     'ca:evasionFiring',     // { debrisId, direction, magnitude }
CA_THREAT_CLEARED:     'ca:threatCleared',      // { debrisId }
CA_OVERRIDE:           'ca:override',           // { debrisId }
CA_TOGGLE:             'ca:toggle',             // { enabled }
```

---

## F. Implementation Plan

### File Structure

```
js/systems/CollisionAvoidanceSystem.js   ← NEW (main system)
js/core/Constants.js                      ← ADD COLLISION_AVOIDANCE block
js/core/Events.js                         ← ADD 5 CA events
js/main.js                                ← Wire into game loop + init()
js/test/test-CollisionAvoidance.js        ← Unit tests
```

### Estimated LOC

| File | Lines | Notes |
|------|-------|-------|
| `CollisionAvoidanceSystem.js` | ~280 | Constructor, init, update, scan, predict, dodge, events |
| Constants additions | ~15 | COLLISION_AVOIDANCE block |
| Events additions | ~8 | 5 event constants + comment |
| main.js wiring | ~15 | Import, construct, init, update call |
| Tests | ~120 | Scan, exemption, dodge, override, toggle |
| **Total** | **~440** | |

### Dependencies

```
CollisionAvoidanceSystem
  ├── imports: THREE, eventBus, Events, Constants
  ├── init deps: player (PlayerSatellite), debrisField (DebrisField),
  │              targetSelector (TargetSelector), inputManager (InputManager),
  │              armManager (ArmManager)
  └── optional: audioSystem (AudioSystem) — for dodge sounds
```

### Class Skeleton

```javascript
export class CollisionAvoidanceSystem {
  constructor()
    _enabled: boolean (true)
    _scanTimer: number
    _currentThreat: object|null
    _overrideTimer: number
    _trawlActive: boolean
    _tutorialStage: number
    _activeTargetId: number|null
    _lastDodgeTime: number
    _setupListeners()

  init(deps: { player, debrisField, targetSelector, inputManager, armManager })

  get enabled(): boolean
  toggle(): void

  update(dt: number): void
    if disabled or ARM_PILOT or tutorial < 5 → return
    accumulate _scanTimer
    if _scanTimer < SCAN_INTERVAL → return (throttle to 4 Hz)
    _scanTimer = 0
    check override window (recent player input → cancel)
    threat = _scanForThreats()
    if threat → _evaluateAndDodge(threat)
    else → _clearThreat()

  _scanForThreats(): object|null
    for each debris in debrisList:
      if !alive → skip
      if debris.id === _activeTargetId → skip
      if any arm.target.id === debris.id → skip
      distance² pre-filter with _scenePosition
      _predictClosestApproach() → miss, tca
      if miss < threshold AND tca > 0 AND tca < LOOK_AHEAD → candidate
    return worst candidate (smallest miss)

  _predictClosestApproach(dPos, dVel, pPos, pVel): { tca, minDist, threatDir }
    (same linear extrapolation as ConjunctionSystem)

  _evaluateAndDodge(threat): void
    compute evasion vector (cross product: threat × radial)
    compute dodge magnitude (proportional to severity)
    apply RCS impulse via player.applyRCS()
    emit CA_EVASION_FIRING
    comms message

  _clearThreat(): void
    if _currentThreat was set → emit CA_THREAT_CLEARED

  _getAvoidanceRadius(): number
    return trawlActive ? TRAWL_AVOIDANCE_RADIUS : AVOIDANCE_RADIUS

  reset(): void

  getStatus(): { enabled, currentThreat, lastDodgeTime }
}
```

### Phased Implementation

#### Phase 1: Basic Detection + Dodge (MVP)
- Constant-velocity linear prediction
- Single dodge threshold (100 m)
- RCS impulse perpendicular to threat
- Active target exemption
- Comms messages
- HUD status indicator

#### Phase 2: Enhanced Integration
- Trawl-mode leniency
- ARM_PILOT suppression
- Manual override detection
- Audio cues (double-blip, hiss, ascending tone)
- Arm target exemption

#### Phase 3: Upgrades (Future)
- Shop item: "Enhanced CA" — longer look-ahead, acceleration-aware prediction
- Shop item: "Predictive Shield" — auto-shield activation for unavoidable impacts
- Visual: threat direction chevron on screen edge

### Testing Strategy

```javascript
// test-CollisionAvoidance.js

test('scan detects approaching debris within threshold')
test('scan ignores receding debris (TCA < 0)')
test('scan ignores active target debris ID')
test('scan ignores arm-targeted debris')
test('dodge applies RCS impulse perpendicular to threat')
test('dodge magnitude proportional to severity')
test('system suppressed during ARM_PILOT mode')
test('system suppressed during early tutorial stages')
test('trawl mode tightens avoidance radius')
test('toggle enables/disables system')
test('manual override cancels pending dodge')
test('reset clears all state')
test('events emitted: CA_THREAT_DETECTED, CA_EVASION_FIRING, CA_THREAT_CLEARED')
```

---

## Summary: Recommended Approach

Build [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js) as a **new standalone system** that:

1. **Scans at 4 Hz** using cached `_scenePosition` data (zero-allocation pre-filter)
2. **Predicts closest approach** via constant-velocity linear extrapolation (proven math from ConjunctionSystem)
3. **Fires a brief RCS impulse** perpendicular to the threat vector when miss distance < 100 m
4. **Respects gameplay context** — exempts active targets, suppresses during ARM_PILOT and trawl, allows manual override
5. **Communicates quietly** — comms panel messages + small HUD indicator, no intrusive overlays
6. **Costs nearly nothing** — cold gas impulse, runs at 4 Hz, pre-filters by distance²

The system fills the gap between strategic conjunction warnings (rare, dramatic) and the Kessler game-over check (too late). It's the "airbag" that prevents frustrating deaths from debris the player didn't notice.
