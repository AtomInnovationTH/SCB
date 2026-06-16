# Daughter Arm Control Redesign — Autopilot Approach + Orbital Positioning

> **Replaces:** WASD free-fly manual piloting (counterintuitive in orbit)  
> **New model:** Autopilot flies arm to standoff position → player adjusts orbital position around debris with intuitive controls  
> **Physical basis:** Tethered arm on Y-harness swivel yoke with fore/aft ion thrusters, 15° vectorable, Isp 4,000–19,000 s, up to 1.28 mN (indium FEEP)

---

## 1. Problem Statement

### 1.1 Why WASD Free-Fly Fails

The current ARM_PILOT mode gives the player WASD+QE thrust control of the daughter arm's FEEP thrusters. This is deeply counterintuitive because:

1. **Orbital mechanics**: In orbit, "forward" doesn't move you forward — it raises your orbit. "Left" doesn't move you left — it changes your orbital plane. Players expecting aerodynamic flight instincts are constantly confused.
2. **Tether constraint**: The arm is on a 500m–2km tether. WASD thrust against the tether just wastes fuel. Moving laterally beyond the tether sphere is impossible.
3. **Thrust magnitude**: Real FEEP thrust is 0.35–0.5 mN. At 11 kg (Weaver), acceleration is 0.032 mm/s². Visible response takes seconds. Players mash keys and nothing happens.
4. **No spatial reference**: When the camera follows the arm, there's no fixed reference frame. "Which way is forward?" changes constantly as the arm orbits Earth at 7.5 km/s.

### 1.2 What Players Actually Need

Players need to position the arm relative to debris for:

| Task | Range | Positioning Need |
|---|---|---|
| **Visual inspection** | 5–10 m | Orbit around to see all faces |
| **Net deployment** | 3–8 m | Approach from net-favorable angle |
| **Grappling** | 1–3 m | Precise approach to hard point |
| **Magnetic capture** | 0.5–2 m | Contact approach |
| **Adhesion pad** | 0.1–0.5 m | Docking-like final approach |
| **Web shot** | 10–50 m | Line-of-sight, any angle |

All of these are **relative to the debris**, not relative to orbital velocity or Earth. The control frame should be **debris-centric**.

---

## 2. New Control Model — "Orbital Crane"

### 2.1 Concept

After crossbow launch + tether braking + FEEP approach, the arm reaches a **standoff sphere** around the debris. The player then operates the arm like a crane on a spherical track:

```
                     MOTHERSHIP
                         │
                    tether (2 km)
                         │
                         ▼
              ╭────── ARM ──────╮
              │  (orbital crane) │
              ╰──────┬──────────╯
                     │  standoff radius (2–10 m)
                     ▼
               ┌──────────┐
               │  DEBRIS   │
               └──────────┘
```

**Key insight:** The arm auto-station-keeps at a point on the standoff sphere. Player controls WHICH point, not the raw thrust.

### 2.2 Control Mapping

| Input | Action | Physical Mechanism |
|---|---|---|
| **↑ / ↓** (Arrow keys) | Orbit debris in latitude (pitch orbit up/down) | FEEP lateral thrust, arm pivots on tether swivel |
| **← / →** (Arrow keys) | Orbit debris in longitude (yaw orbit left/right) | FEEP lateral thrust, arm pivots on tether swivel |
| **+ / =** | Move closer to debris (decrease standoff) | FEEP forward thrust toward debris |
| **- / _** | Move away from debris (increase standoff) | FEEP reverse thrust + tether tension |
| **Shift** (held) | Fine mode (¼ rate for all controls) | Reduced FEEP duty cycle |
| **N** | Deploy net / initiate capture (F is alias) | Existing net deploy mechanic |
| **ESC / P** | Exit ARM_PILOT, return to mothership camera | Existing exit path |

### 2.3 What Happens to WASD

WASD keys in ARM_PILOT mode become **no-ops** (or optionally mapped to the same orbital positioning as arrows for discoverability). The old free-fly thrust mode is removed.

---

## 3. Autopilot Approach Phase

### 3.1 Current FSM Flow (Unchanged)

```
DOCKED → LAUNCHING → TRANSIT → APPROACH → [NETTING → GRAPPLED → ...]
```

TRANSIT and APPROACH are autopilot-controlled today. The arm flies autonomously to the debris, brakes, and enters APPROACH for fine maneuvering. **This stays unchanged.**

### 3.2 New State: STATION_KEEP

After APPROACH reaches the standoff distance, instead of immediately entering NETTING, the arm enters a new **STATION_KEEP** state:

```
APPROACH → STATION_KEEP → (player commands capture) → NETTING → ...
```

| Property | Value |
|---|---|
| State name | `STATION_KEEP` |
| Entry condition | Arm within standoff sphere of target |
| Standoff distance | `debrisRadius × 3` clamped to [2 m, 10 m] |
| Station-keeping thrust | Auto FEEP to maintain position relative to debris |
| Player controls | Orbital positioning (§2.2) |
| Exit conditions | N-key capture (F alias), ESC/P disengage, fuel depleted, tether limit |

### 3.3 Standoff Distance Calculation

```
standoff_default = max(2.0, min(10.0, debris.sizeMeter * 1.5))

Examples:
  0.1 m fragment  → 2.0 m standoff (minimum)
  1.0 m panel     → 2.0 m standoff
  3.0 m cubesat   → 4.5 m standoff
  5.0 m satellite → 7.5 m standoff
  8.0 m rocketBody → 10.0 m standoff (maximum)
```

Player can override with +/- within hard limits: `[debris.sizeMeter + 0.5, 15.0]` meters.

---

## 4. Spherical Position Model

### 4.1 Coordinate System

The arm's position is defined in debris-centric spherical coordinates:

```
arm_position = debris_position + spherical_to_cartesian(r, θ, φ)

Where:
  r = standoff radius (meters, controlled by +/-)
  θ = latitude (-80° to +80°, controlled by ↑/↓)
  φ = longitude (-150° to +150°, controlled by ←/→)

Origin: debris center of mass
Reference plane: the plane containing debris, mothership, and radial-up
Reference direction (φ=0): toward mothership (tether direction)
```

### 4.2 Tether-Safe Zone (Hard Limits)

The tether runs from the arm to the mothership. If the arm orbits too far around the debris, the tether could contact the debris. Hard angular limits prevent this:

```
TETHER CLEARANCE GEOMETRY (top view):

        MOTHERSHIP
            │
       tether│
            │
            ▼
     ╭─ ─ ARM ─ ─╮        ← arm can move on this arc
    /      │       \
   /       │ r      \
  │    ┌───┴───┐     │
  │    │DEBRIS │     │
  │    └───────┘     │
   \               /
    \   EXCLUSION /       ← tether would pass through debris
     ╰─ ─ ─ ─ ─╯

Max angular excursion from tether line:
  φ_max = arcsin(r / (r + debris_radius)) - safety_margin
  
  At r=5m, debris_radius=2m:
    φ_max = arcsin(5/7) - 10° = 45.6° - 10° = 35.6°
  
  At r=10m, debris_radius=4m:
    φ_max = arcsin(10/14) - 10° = 45.6° - 10° = 35.6°

Conservative limit: ±60° longitude, ±80° latitude from tether-facing
```

The actual limit is computed dynamically based on:
- Current standoff distance `r`
- Debris bounding radius
- Tether attachment geometry (Y-harness bridle legs add 0.5 m clearance)
- 10° safety margin for tether flex/sag

### 4.3 Position Update per Frame

```js
// In STATION_KEEP state update:
_updateStationKeep(dt, parentPos) {
    const target = this._getTargetScenePos();
    if (!target) { this.recall(); return; }
    
    // Update spherical coordinates from player input
    // (input rates are set in processInput → ARM_ORBIT_ADJUST event)
    this._orbitTheta += this._thetaRate * dt;  // latitude
    this._orbitPhi   += this._phiRate * dt;    // longitude
    this._standoffR  += this._radiusRate * dt; // radius
    
    // Clamp to hard limits
    this._orbitTheta = clamp(this._orbitTheta, -MAX_LAT, MAX_LAT);
    this._orbitPhi   = clamp(this._orbitPhi, -this._phiMax, this._phiMax);
    this._standoffR  = clamp(this._standoffR, this._rMin, this._rMax);
    
    // Compute desired position in debris-centric frame
    const toMother = parentPos.clone().sub(target).normalize(); // φ=0 reference
    const radialUp = target.clone().normalize();                // latitude reference
    const lateral  = new THREE.Vector3().crossVectors(radialUp, toMother).normalize();
    
    // Spherical → Cartesian offset
    const cosTheta = Math.cos(this._orbitTheta);
    const sinTheta = Math.sin(this._orbitTheta);
    const cosPhi   = Math.cos(this._orbitPhi);
    const sinPhi   = Math.sin(this._orbitPhi);
    
    const offset = toMother.clone().multiplyScalar(cosPhi * cosTheta * this._standoffR * M)
        .add(lateral.clone().multiplyScalar(sinPhi * cosTheta * this._standoffR * M))
        .add(radialUp.clone().multiplyScalar(sinTheta * this._standoffR * M));
    
    const desiredPos = target.clone().add(offset);
    
    // Station-keep: lerp toward desired position (simulates FEEP response time)
    const stationKeepRate = 0.8; // higher = snappier (0-1)
    this.position.lerp(desiredPos, stationKeepRate * dt / (dt + 0.1));
    
    // Update tether length
    this.tetherLength = this.position.distanceTo(parentPos) / M;
    
    // Fuel consumption: proportional to thrust needed to maintain station
    const thrustNeeded = this.position.distanceTo(desiredPos) * this.config.mass;
    this._consumeFuel(thrustNeeded * dt);
}
```

---

## 5. Ion Thruster Model — All FEEP Roles

The FEEP (Field Emission Electric Propulsion) thrusters on each daughter arm are indium-fuelled ion engines on a swivel yoke. They serve **six distinct roles** across the arm's lifecycle:

### 5.1 FEEP Role Map

| Role | FSM State(s) | Isp Mode | Thrust Level | Purpose |
|---|---|---|---|---|
| **Transit assist** | TRANSIT | Low (4,000 s) | Max (1.28 mN) | Course correction after crossbow launch. Steers arm toward target if launch angle was off-axis. Not primary propulsion (crossbow spring provides that), but helps correct trajectories for off-axis targets. |
| **Approach maneuvering** | APPROACH | Mid (10,000 s) | Variable | Fine lateral corrections as arm closes on debris. Matches relative velocity. The primary FEEP task in the mission cycle. |
| **Station-keeping** | STATION_KEEP | High (19,000 s) | Micro | Holds arm's position on standoff sphere relative to debris. Minimal fuel draw — this is what high-Isp ion drive excels at. |
| **Tether tension management** | REELING, TRANSIT | Mid (10,000 s) | Variable | During reel-in/out, FEEP fires to keep tether taut and arm on the radial line. Prevents slack arcs that could tangle. At ±10 m lateral offset at 2 km: trivial thrust (0.038 N·m torque). |
| **Self-return (untethered)** | RETURNING | Low (4,000 s) | Max | If tether is severed (cut, tangled, or player-commanded detach), FEEP is the ONLY way home. Weaver: 500 m/s ΔV budget → can return from 2 km in ~2 m/s ΔV. Spinner: 297 m/s budget. This is the risk/reward of the detach mechanic — finite FEEP = finite untethered life. |
| **Emergency deorbit** | DEORBITING | Low (4,000 s) | Max sustained | Sacrifice play: arm burns all FEEP retrograde to deorbit itself (+ captured debris). High thrust mode maximises ΔV-for-time even though Isp is lower. |
| **Re-dock inertia null** | REELING (arrest sub-phase) / DOCKING | Mid (10,000 s) | Variable | **Role 7 (reel-in-redock-inertia plan, Q4).** Inside `REDOCK_FEEP.ARREST_DISTANCE_M` of the strut, FEEP nulls the residual closing-rate for a soft contact (≤ `SOFT_DOCK_VEL`). Modelled as a one-shot mass-scaled fuel debit `DEBIT_K · m_unit · v_arrest` ("don't dock hot"). The fore nozzle (+Z exhaust) brakes toward the mother — the **same side the tether runs to** — so the burn fires **only when `_tetherPlumeClearOK()` passes** (tether ≥ `MIN_TETHER_PLUME_DEG` off the plume axis under the whole-haul reel attitude). If clearance/fuel is unmet → `FUEL_FALLBACK_SLOW`: zero-fuel reel-only finish + warn (never a dead-end). Mission 1 is a free pass. |

### 5.2 Thruster Specifications

| Parameter | Current (V5) | Proposed | Source / TRL |
|---|---|---|---|
| Weaver thrust | 0.35 mN (NANO R3 Xe) | **1.28 mN** (IFM Nano 200 In) | Enpulsion indium FEEP — TRL 9 |
| Spinner thrust | 0.50 mN (IFM Nano SE Xe) | **0.80 mN** (IFM Nano SE+ In) | Scaled proportionally — TRL 9 |
| Isp range | 6,000 s (fixed) | **4,000–19,000 s** (variable) | Indium FEEP operating range — TRL 9 |
| Vectoring | None (fixed aft) | **±15°** (swivel yoke) | Fore + aft thrusters on yoke — TRL 8 |
| **Propellant** | Xenon (implied) | **Dual-metal: indium primary + 1 alt metal** (gallium/iodine/bismuth/etc) | **Multimetal FEEP is TRL 7–8 today** (Enpulsion IFM Nano series, multiple flight demos 2024–2025) |
| Thruster count | 2× per arm (aft) | 2× per arm (fore + aft on yoke) | Bidirectional thrust capability |

> **Important TRL note:** Multimetal FEEP is **not exotic future tech**. Dual-metal indium thrusters are flight-demonstrated. The V5 daughter arm ships with a single hardware module that can ionise indium (default) OR a player-refined alternative metal cartridge (gallium, iodine, bismuth). Switching is a **propellant change**, not a hardware upgrade. Higher-TRL exotic options (mercury, cesium, tungsten) gate behind Forge unlocks per [`GAME_FLOW_BRAINSTORM.md §7.2`](archive/GAME_FLOW_BRAINSTORM.md).

### 5.3 Variable Isp Trade-Off (Gameplay Mechanic)

Real FEEP thrusters allow trading Isp for thrust at constant beam power. This creates a resource management mechanic:

```
Thrust = P_beam / (Isp × g₀ × η)

At constant beam power P_beam = 40 W, efficiency η = 0.6:
  Isp  4,000 s → F = 40 / (4000 × 9.81 × 0.6) = 1.70 mN  (high thrust, guzzles fuel)
  Isp 10,000 s → F = 40 / (10000 × 9.81 × 0.6) = 0.68 mN  (balanced)
  Isp 19,000 s → F = 40 / (19000 × 9.81 × 0.6) = 0.36 mN  (sips fuel, but slow)
```

**Auto-mode (default):** The arm's OBC selects Isp automatically based on task:
- Transit correction → Low Isp (need thrust, distance is large)
- Approach → Mid Isp (balance precision + fuel)
- Station-keep → High Isp (micro-thrust, maximum fuel economy)
- Emergency return → Low Isp (maximum thrust to get home before battery dies)

**Manual override (advanced):** Player can force Isp via comms menu for edge cases (e.g. force low-Isp for fast repositioning at cost of fuel).

### 5.4 Vectoring (±15°) & Swivel Yoke

> **Correction (reel-in-redock-inertia plan, Rev-3 — user physics input).** The
> FEEP **±15° beam steering is electrostatic — it has NO moving parts.** Beam
> deflection is inherent to the indium emitter (this is *why* FEEP was selected
> for the daughter), so vectoring is **free** in both lore and sim (idealized
> impulse). The **swivel yoke** (the +Y wishbone bridle/gimbal) is therefore
> **not** what provides vectoring. The yoke's real job is **tether-plume
> clearance**: it holds the cable off the ±Z FEEP exhaust cone so the daughter
> can fire the brake (fore, +Z) toward the mother — the same side the tether
> runs to — without the plume ablating the cable (see `CAPTURE_NET.md §4.2`).
> This is modelled by `_tetherPlumeClearOK()` + the whole-haul reel attitude
> (nose +Z at the strut, +Y bridle trailing); see `YOKE_CLEARANCE` constants.

Each arm has fore and aft ion thrusters mounted on a **swivel yoke** (titanium gimbal, 360° pitch+yaw per [§15 CROSSBOW_ARMS.md](CROSSBOW_ARMS.md)). The yoke can deflect thrust ±15° from the arm's longitudinal axis. This provides:

- **Lateral thrust** without rotating the arm body → stable station-keeping
- **Bidirectional thrust** (fore + aft engines) → can push toward OR away from debris without turning
- **Roll/yaw authority** for net deployment orientation
- **Tether tension assist** → fore thruster fires gently to maintain tension during reel operations
- **Tether-plume clearance (the yoke's defining role)** → the +Y bridle keeps the cable outside the ±Z exhaust cone so FEEP can brake during reel-in/re-dock (Role 7) without ablating the tether
- Combined with tether tension from the Y-harness bridle, enables **stable debris-relative positioning** without constant attitude corrections

### 5.4 Constants to Add

```js
// In Constants.js — ION_THRUSTER namespace:
ION_THRUSTER: {
    // Indium FEEP thruster parameters
    WEAVER_MAX_THRUST: 0.00128,     // N (1.28 mN) — IFM Nano 200 class
    SPINNER_MAX_THRUST: 0.0008,     // N (0.80 mN)
    ISP_MIN: 4000,                  // s — high-thrust mode
    ISP_MAX: 19000,                 // s — high-efficiency mode  
    ISP_DEFAULT: 10000,             // s — balanced mode
    BEAM_POWER_WEAVER: 40,         // W — electrical power to thruster
    BEAM_POWER_SPINNER: 25,        // W
    EFFICIENCY: 0.6,               // overall thruster efficiency
    VECTOR_ANGLE_MAX: 15,          // degrees — swivel yoke limit
    PROPELLANT: 'indium',          // FEEP propellant type
    PROPELLANT_MASS_WEAVER: 0.15,  // kg — indium reservoir per Weaver
    PROPELLANT_MASS_SPINNER: 0.08, // kg — indium reservoir per Spinner
    THRUSTER_COUNT: 2,             // fore + aft on swivel yoke

    // Auto-Isp modes (OBC selects based on current task)
    ISP_TRANSIT: 4000,             // s — max thrust for course correction
    ISP_APPROACH: 10000,           // s — balanced for fine maneuvering
    ISP_STATIONKEEP: 19000,        // s — minimal fuel for position hold
    ISP_TENSION: 10000,            // s — tether tension management
    ISP_RETURN: 4000,              // s — max thrust for untethered self-return
    ISP_DEORBIT: 4000,             // s — max thrust for sacrifice deorbit
},

// Tether tension management (FEEP role during reel operations)
TETHER_TENSION: {
    TARGET_TENSION: 2.0,           // N — nominal tether tension during operations
    MIN_TENSION: 0.4,              // N — clock-spring minimum (prevents slack)
    MAX_TENSION_WARNING: 50,       // N — HUD warning threshold
    MAX_TENSION_CRITICAL: 200,     // N — auto-brake to prevent snap
    FEEP_RADIAL_HOLD_OFFSET: 10,   // m — max lateral drift before FEEP corrects
    FEEP_TENSION_AUTHORITY: 0.001, // N — FEEP thrust contribution to tension
},

// Station-keeping parameters
STATION_KEEP: {
    DEFAULT_STANDOFF_MULT: 1.5,     // × debris size for default standoff
    MIN_STANDOFF: 2.0,             // m — absolute minimum distance
    MAX_STANDOFF: 15.0,            // m — maximum standoff
    ORBIT_RATE: 0.5,               // rad/s — angular rate for arrow key orbiting
    ORBIT_RATE_FINE: 0.125,        // rad/s — Shift held
    RADIUS_RATE: 1.0,              // m/s — +/- key approach/retreat
    RADIUS_RATE_FINE: 0.25,        // m/s — Shift held
    MAX_LATITUDE: 80,              // degrees — hard limit
    TETHER_SAFETY_MARGIN: 10,      // degrees — clearance margin
    STATIONKEEP_LERP_RATE: 0.8,   // position tracking responsiveness
    FUEL_RATE_STATIONKEEP: 0.02,   // fuel%/s for station-keeping
    FUEL_RATE_MANEUVER: 0.1,       // fuel%/s while actively repositioning
},
```

---

## 6. FSM Changes

### 6.1 New State: STATION_KEEP

```
ARM_STATES: {
    ...existing states...
    STATION_KEEP: 'STATION_KEEP',  // NEW — debris-relative orbital positioning
}
```

### 6.2 Modified Transitions

```
Current:
  APPROACH → (auto, distance < threshold) → NETTING

Proposed:  
  APPROACH → (auto, distance < standoff) → STATION_KEEP
  STATION_KEEP → (N-key capture command; F alias) → NETTING
  STATION_KEEP → (ESC/P disengage) → RETURNING
  STATION_KEEP → (fuel depleted) → RETURNING
  STATION_KEEP → (tether limit) → RETURNING  
  STATION_KEEP → (target lost/destroyed) → RETURNING
```

### 6.3 APPROACH Phase Changes

APPROACH autopilot target changes from "fly directly to debris" to "fly to standoff sphere and decelerate":

```
Current approach target:  debris center (0 m distance)
New approach target:      standoff sphere (default_standoff meters from debris center)
```

The arm decelerates as it approaches the sphere. When velocity < 0.1 m/s and distance is within ±1 m of standoff, transition to STATION_KEEP.

---

## 7. Camera System Changes

### 7.1 STATION_KEEP Camera

During STATION_KEEP, the camera should orbit with the arm but keep the debris in frame:

```
Camera position: slightly behind + above arm (existing ARM_PILOT offset)
Camera lookAt:   debris center (NOT arm forward direction)
```

This gives the player a clear view of the debris while repositioning. The existing `_computeArmPilot()` needs a modification for STATION_KEEP:

```js
// In _computeArmPilot:
if (arm.state === 'STATION_KEEP' && arm.target && arm.target._scenePosition) {
    // Look at debris, not arm's forward
    const debrisPos = arm.target._scenePosition;
    look = debrisPos.clone();
} else {
    // Existing: look along arm forward
    look = armPos.clone().add(forwardDir.clone().multiplyScalar(0.001));
}
```

### 7.2 FOV During Station-Keep

Could narrow FOV further (30°?) for inspection close-ups, with scroll-wheel zoom. Optional — may over-scope.

---

## 8. InputManager Changes

### 8.1 New Event: ARM_ORBIT_ADJUST

```js
// New event in Events.js:
ARM_ORBIT_ADJUST: 'arm:orbit_adjust',  // { theta, phi, radius, fine }
```

### 8.2 processInput() Modification

```js
// Replace current ARM_PILOT WASD block with:
if (this.armPilotMode && !apEngaged) {
    const arm = d.cameraSystem?.getPilotedArm();
    
    if (arm && arm.state === 'STATION_KEEP') {
        // STATION_KEEP: orbital positioning controls
        let theta = 0, phi = 0, radius = 0;
        if (this.keys['ArrowUp'])    theta += 1;
        if (this.keys['ArrowDown'])  theta -= 1;
        if (this.keys['ArrowLeft'])  phi -= 1;
        if (this.keys['ArrowRight']) phi += 1;
        if (this.keys['Equal'] || this.keys['NumpadAdd'])      radius -= 1; // closer
        if (this.keys['Minus'] || this.keys['NumpadSubtract'])  radius += 1; // farther
        
        const fine = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
        
        if (theta || phi || radius) {
            eventBus.emit(Events.ARM_ORBIT_ADJUST, {
                armId: arm.id,
                theta, phi, radius, fine, dt,
            });
        }
    } else if (arm) {
        // Non-STATION_KEEP states: legacy WASD thrust (keep for TRANSIT/APPROACH manual override)
        // ... existing WASD code ...
    }
}
```

### 8.3 HUD Controls Strip Update

```
Current:  🤖 ARM PILOT │ W A S D Steer │ Q E Up/Down │ F Deploy Net │ Shift Fine │ ESC Exit
New:      🤖 ARM PILOT │ ↑↓←→ Orbit │ +/- Distance │ F Capture │ Shift Fine │ ESC Exit
```

Should dynamically switch based on arm state:
- **TRANSIT/APPROACH**: "Autopilot — intercepting target..."
- **STATION_KEEP**: "↑↓←→ Orbit │ +/- Distance │ F Capture │ Shift Fine"

---

## 9. Implementation Plan

### Phase 1: Foundation (Small, Safe)
1. Add `STATION_KEEP` state to `ARM_STATES` in [`Constants.js`](js/core/Constants.js:190)
2. Add `STATION_KEEP` constants to [`Constants.js`](js/core/Constants.js)
3. Add `ARM_ORBIT_ADJUST` event to [`Events.js`](js/core/Events.js)
4. Add `_updateStationKeep()` method to [`ArmUnit.js`](js/entities/ArmUnit.js) with spherical positioning
5. Wire state transition: APPROACH → STATION_KEEP in [`ArmUnit._updateApproach()`](js/entities/ArmUnit.js:1431)
6. Wire state transition: STATION_KEEP → NETTING on N-key capture (F is alias)

### Phase 2: Controls
7. Modify [`InputManager.processInput()`](js/systems/InputManager.js:1013) — route arrow keys + ±keys to `ARM_ORBIT_ADJUST`
8. Add `ARM_ORBIT_ADJUST` listener in [`ArmUnit`](js/entities/ArmUnit.js) or [`ArmManager`](js/entities/ArmManager.js) to set orbit rates
9. Update HUD ARM_PILOT strip in [`HUD.js`](js/ui/HUD.js:1519) with context-aware text

### Phase 3: Camera
10. Modify [`_computeArmPilot()`](js/systems/CameraSystem.js:722) to look at debris during STATION_KEEP
11. Test smooth blend between APPROACH → STATION_KEEP camera transitions

### Phase 4: Polish
12. Add ion thruster constants (Isp range, vectoring)
13. Fuel consumption tuning for station-keeping
14. Tether clearance geometry calculations
15. Dynamic φ_max limits based on debris size
16. Update [`DockingReticle`](js/ui/DockingReticle.js) to show standoff circle + angle indicators

### Test Strategy
- All 238 existing test suites must pass (no regressions)
- New unit tests for:
  - STATION_KEEP state transitions (entry from APPROACH, exit to NETTING/RETURNING)
  - Spherical coordinate clamping (lat/lon/radius within hard limits)
  - Tether clearance angle computation
  - Fuel consumption rates in STATION_KEEP

---

## 10. Risk Assessment

| Risk | Mitigation |
|---|---|
| STATION_KEEP feels sluggish (FEEP response time) | Tune `STATIONKEEP_LERP_RATE` — can be unrealistic-fast for gameplay while keeping thrust math honest |
| Players can't find N-key to capture | HUD strip shows "N Capture (F alias)" prominently; comms nudge after 5s in STATION_KEEP |
| Tether clearance too restrictive | Start generous (±80° lat, ±60° lon), tighten via playtesting |
| Existing WASD users confused | Deprecation comms message: "FEEP manual thrust unavailable — use orbital positioning" |
| Manual override needed for edge cases | Keep legacy WASD as hidden Ctrl+M toggle for power users |

---

## 11. Summary

**Before:** G → arm deploys → WASD free-fly (confusing) → F capture
**After:** G → arm deploys → autopilot flies to standoff → ↑↓←→ orbit around debris → +/- adjust distance → F capture

The "Orbital Crane" model gives players an intuitive spatial metaphor (move around the thing you're looking at) instead of raw thrust in a confusing reference frame.

### FEEP Thruster Roles (Complete)

The indium FEEP thrusters (1.28 mN, Isp 4,000–19,000 s, electrostatic ±15° beam steering — no moving parts) serve **seven roles** throughout the arm's lifecycle — never idle, always justified:

1. **Transit assist** — course correction after crossbow launch (low Isp, max thrust)
2. **Approach maneuvering** — fine lateral corrections closing on debris (mid Isp)
3. **Station-keeping** — holds position on standoff sphere (high Isp, micro-thrust, sips fuel)
4. **Tether tension management** — keeps tether taut during reel in/out; fires fore thruster to maintain radial alignment and prevent slack arcs that cause tangles
5. **Self-return (untethered)** — if tether severed, FEEP is the only way home; Weaver has 500 m/s ΔV budget for independent operations
6. **Emergency deorbit** — sacrifice play: all remaining FEEP burns retrograde
7. **Re-dock inertia null** — soft re-dock arrest inside `ARREST_DISTANCE_M`: nulls the residual closing-rate (one-shot mass-scaled fuel debit), gated by the yoke tether-plume clearance test; reel-only fallback when clearance/fuel is unmet

The crossbow provides the high-ΔV launch phase. FEEP handles everything after — precisely what ion propulsion was designed for.
