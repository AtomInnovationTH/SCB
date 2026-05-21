# Autopilot Analysis — Trailing-Rendezvous Redesign

> **⚠️ ARCHIVED — 2026-04-22.** The autopilot was fully rewritten in Sessions 28-30 based on this analysis. All issues identified here (B.1–B.10) are resolved. The 4-phase state machine is now in production. This document + 3 debug retrospectives retained for historical reference. **Move to `archive/`.**

> **Scope:** Analysis & design only. Target: [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) and its immediate collaborators.
> **Goal:** Diagnose why the OLD autopilot did not produce an easy lasso shot, and specify a trailing-rendezvous controller that leaves the mother ship **directly behind** the targeted debris along the debris's velocity vector at a small offset, velocity-matched, nose-on-target.

---

## TL;DR

- The autopilot does **position-seek a trailing point** in theory (the `_targetPrograde` subtract at [`AutopilotSystem.js:270-273`](js/systems/AutopilotSystem.js:270)), but in practice:
  1. **The trail offset equals the arrival distance**, so the ship "arrives" before ever forming the trailing geometry ([`AutopilotSystem.js:249-262`](js/systems/AutopilotSystem.js:249)).
  2. **Thrust intent is mapped through an element-basis API that doesn't actually push the ship in the intended world direction**; it grows orbital elements instead ([`AutopilotSystem.js:289-293`](js/systems/AutopilotSystem.js:289) → [`PlayerSatellite.js:2139-2151`](js/entities/PlayerSatellite.js:2139)).
  3. **There is no velocity-matching phase** — at "arrival" the mother ship's velocity is still its own orbital velocity, not the target's, so the geometry disintegrates within seconds.
  4. **There is a non-physical teleport**: AP nudges `orbit.trueAnomaly` directly each frame to fake phase correction ([`AutopilotSystem.js:297-304`](js/systems/AutopilotSystem.js:297)).
- **Recommended fix:** convert the control loop into a small 4-state machine (`RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD`) that operates on real Cartesian state, computes a trailing rendezvous point `P_m = P_d − (V_d/|V_d|)·D_trail`, and drives Cartesian ΔV via a new thin API on [`PlayerSatellite`](js/entities/PlayerSatellite.js:33) that translates world-frame impulses into the existing element-updater instead of mis-using the `thrustIon({x,y,z})` channels.

---

## A. Current Behavior (reverse-engineered)

### A.1 Engage / disengage surface

| Event | Source | Effect |
|---|---|---|
| `A` key (single press) | [`InputManager.js:389-393`](js/systems/InputManager.js:389) | `autopilotSystem.toggle()` → [`AutopilotSystem.toggle()`](js/systems/AutopilotSystem.js:107) |
| Arrow key press while engaged | [`InputManager.js:145-149`](js/systems/InputManager.js:145) | `disengage('ARROW_INPUT')` |
| Frame ΔV check | [`AutopilotSystem.js:207-211`](js/systems/AutopilotSystem.js:207) | `disengage('DELTAV')` if `ΔV < 30 m/s` |
| Conjunction tier ≥ 2 | [`AutopilotSystem.js:515-519`](js/systems/AutopilotSystem.js:515) | `disengage('COLLISION')` |
| Real trawl start (with cluster) | [`AutopilotSystem.js:524-530`](js/systems/AutopilotSystem.js:524) | `disengage('TRAWL')` |
| Target destroyed | [`AutopilotSystem.js:214-218`](js/systems/AutopilotSystem.js:214) | `disengage('TARGET_LOST')` |
| Target-space distance `< arrivalDist` | [`AutopilotSystem.js:254-262`](js/systems/AutopilotSystem.js:254) | Emits `AUTOPILOT_ARRIVED`, then `disengage('ARRIVED')` |
| Tutorial stage `< 4` | [`AutopilotSystem.js:117-118,542-545`](js/systems/AutopilotSystem.js:117) | Engage is silently blocked |

Emitted events: [`AUTOPILOT_ENGAGE`](js/core/Events.js:282), [`AUTOPILOT_DISENGAGE`](js/core/Events.js:283), [`AUTOPILOT_ARRIVED`](js/core/Events.js:284), and the onboarding hook [`AUTOPILOT_NO_TARGET`](js/core/Events.js:255) emitted in `engage()` when no target is selected ([`AutopilotSystem.js:138-141`](js/systems/AutopilotSystem.js:138)).

### A.2 What target pose is currently tried?

The controller tries to steer toward a single world-space **point** with two uses of that point:

1. **Visual aim:** `aimWorldDir = normalize(targetPos − playerPos)` ([`AutopilotSystem.js:265`](js/systems/AutopilotSystem.js:265)). Slerped into ship `quaternion` via [`_rotateTowardWorld()`](js/systems/AutopilotSystem.js:449) at `AP_ROT_RATE = 0.2 rad/s` with a `0.01 rad` dead-zone ([`AutopilotSystem.js:21-24`](js/systems/AutopilotSystem.js:21)).
2. **Thrust target:** `approachPos = targetPos − prograde_target · arrivalDist` ([`AutopilotSystem.js:270-273`](js/systems/AutopilotSystem.js:270)), then `thrustWorldDir = normalize(approachPos − playerPos)` ([`AutopilotSystem.js:274`](js/systems/AutopilotSystem.js:274)).

`_targetPrograde` is the target's **velocity unit vector** cached from `orbitToSceneCartesian(target.orbit).velocity` at [`AutopilotSystem.js:222`](js/systems/AutopilotSystem.js:222). So in principle the aim-point is "behind the debris along its velocity by `arrivalDist`" — i.e. a trailing offset. However, see issue B.2: `arrivalDist` is also the disengage trigger.

**No target orientation, no target velocity match, no explicit `P_m, V_m, Q_m` goal state** is maintained. The "pose" is a single 3-D point.

### A.3 Control law

- **Rotation law:** compute `targetQuat = lookAt(playerPos, playerPos + aimWorldDir, radialUp)` then `quaternion.slerp(targetQuat, min(AP_ROT_RATE·dt/angle, 1))` ([`AutopilotSystem.js:449-466`](js/systems/AutopilotSystem.js:449)). Monotonic, rate-limited — no PID, no oscillation by design.
- **Thrust law:**
  - Project `thrustWorldDir` onto the **orbital frame** (radial, cross-track, prograde) at [`AutopilotSystem.js:418-438`](js/systems/AutopilotSystem.js:418).
  - Feed the resulting `{x: radialDot, y: crossDot, z: progradeDot}` into [`PlayerSatellite.thrustIon()`](js/entities/PlayerSatellite.js:1661) every frame.
  - Magnitude is **not modulated by range or closure rate** — it's full ion thrust scaled only by `throttleLevel` ([`PlayerSatellite.js:1699-1702`](js/entities/PlayerSatellite.js:1699)).
- **Phase teleport:** an extra block directly mutates `this._player.orbit.trueAnomaly` toward the target's true anomaly at a rate of `0.01·dt·TIME_SCALE_GAMEPLAY` radians per frame ([`AutopilotSystem.js:297-304`](js/systems/AutopilotSystem.js:297)). This is **not physics** — it is a solver hack to force along-track convergence regardless of what the thrust commands did.

### A.4 How it interacts with orbital mechanics

Two different "physics layers" run simultaneously and partially fight each other:

1. **Thrust applied via [`_applyThrust()`](js/entities/PlayerSatellite.js:2125):**
   - `ti.z` → `semiMajorAxis += 2a·ti.z/v · SCENE_SCALE` (altitude change from prograde component)
   - `ti.y` → `inclination += ti.y/v` (plane change from cross-track)
   - `ti.x` → `eccentricity += ti.x/(2v)` (shape change from radial)
   - So a "world-space radial push" requested by the autopilot ends up as an **eccentricity tweak**, not an actual radial displacement this frame.
2. **Orbit propagation via [`propagateOrbit()`](js/entities/OrbitalMechanics.js:206):** advances `trueAnomaly` with mean motion — the principled piece.
3. **RCS nudge via `_rcsVelocity`:** unused by autopilot.
4. **Direct mutation of `trueAnomaly`** in the AP phase-correction block — see A.3.

So the autopilot treats the target as **moving** (it re-reads `orbitToSceneCartesian` every frame) but treats its own ship as if thrust = world-space displacement. This mismatch is the root of the counter-intuitive symptoms.

### A.5 Termination conditions

- `dist(player, targetPos) < arrivalDist` where `arrivalDist` ∈ {lasso 150 m, spinner/weaver 50 m, trawl 200 m, default 100 m} keyed off [`TargetSelector._recommendedTool`](js/systems/TargetSelector.js:27) — [`AutopilotSystem.js:27-33,478-486`](js/systems/AutopilotSystem.js:27).
- ΔV budget below `DISENGAGE_DV_MIN = 30 m/s` ([`AutopilotSystem.js:17-18`](js/systems/AutopilotSystem.js:17)).
- Target dead (`alive === false`).
- Conjunction tier ≥ 2, trawl start, arrow-key override, manual toggle.

On `ARRIVED` the system fully disengages and the ship resumes prograde tracking via [`_orientAlongVelocity()`](js/entities/PlayerSatellite.js:2177). The assumption in the comment at [`AutopilotSystem.js:253-253`](js/systems/AutopilotSystem.js:253) — *"Ship resumes prograde tracking → naturally faces debris ahead → easy lasso shot"* — only holds if the ship's velocity is coincidentally aligned with "debris-ahead-of-me," which requires the trailing geometry to actually have formed and the orbits to be matched. Neither is guaranteed.

---

## B. Identified Issues

### B.1 ❌ Arrival radius = trail offset ⇒ the trailing geometry never forms

At [`AutopilotSystem.js:270-273`](js/systems/AutopilotSystem.js:270):

```js
const approachPos = targetPos.clone().sub(
  this._targetPrograde.clone().multiplyScalar(arrivalDist)
);
```

…and at [`AutopilotSystem.js:249-254`](js/systems/AutopilotSystem.js:249):

```js
const dist = playerPos.distanceTo(targetPos);
const arrivalDist = this._getArrivalDistance();
if (dist < arrivalDist) { ... disengage('ARRIVED') ... }
```

The **aim point behind the debris** is at distance `arrivalDist`, but the **disengage trigger** is also `arrivalDist` measured **to the debris itself**. Any trajectory that enters a sphere of radius `arrivalDist` around the debris — from *any angle*, including head-on — terminates the autopilot. In practice, because the ship typically approaches from a different orbit (different SMA/inclination), it crosses the debris's neighborhood from above/below and triggers arrival far from the intended trail point.

### B.2 ❌ No velocity matching

There is **no `V_m ≈ V_d` term** anywhere in the controller. The ship arrives with whatever orbital velocity its current elements imply. Because `orbitalVelocity` depends on SMA ([`OrbitalMechanics.js:239-241`](js/entities/OrbitalMechanics.js:239)), and debris orbits span altitudes 200–2000 km ([`DebrisField.js:76-81`](js/entities/DebrisField.js:76)), the relative velocity at "arrival" can easily exceed **hundreds of m/s** — far outside the lasso's `5 m/s` projectile speed ([`Constants.js:756`](js/core/Constants.js:756)). The lasso then misses or the debris drifts out of its 200 m range ([`Constants.js:755`](js/core/Constants.js:755)) within seconds.

### B.3 ❌ Thrust-intent / thrust-API mismatch

[`AutopilotSystem._worldToOrbitalFrame()`](js/systems/AutopilotSystem.js:418) produces `{x: dot(dir, radial), y: dot(dir, cross), z: dot(dir, prograde)}`. That looks like a world-to-local projection — but the receiver, [`PlayerSatellite._applyThrust()`](js/entities/PlayerSatellite.js:2125), treats those fields as **orbital-element rates**:

- `z` → `da` (altitude growth),
- `y` → `di` (inclination),
- `x` → `de` (eccentricity).

A "pure radial thrust" (`x = 1, y = 0, z = 0`) does **not** push the ship radially this frame; it just raises eccentricity. The ship will eventually experience that change in its trajectory, but it's a low-pass, time-integrated response, not the Cartesian impulse the controller geometrically asked for. This is the single biggest reason the approach feels counter-intuitive: the autopilot "aims the thrust vector" but the thrust vector is an **element-basis pseudo-command**.

### B.4 ❌ Non-physical true-anomaly teleport

[`AutopilotSystem.js:297-304`](js/systems/AutopilotSystem.js:297):

```js
const dTA = targetOrbit.trueAnomaly - this._player.orbit.trueAnomaly;
...
const maxPhase = 0.01 * dt * Constants.TIME_SCALE_GAMEPLAY;
this._player.orbit.trueAnomaly += clamp(dTA, -maxPhase, +maxPhase);
```

This directly warps the ship along its orbit each frame, ignoring any physics. It looks like a hack to cover for B.3. It also breaks conservation (energy, momentum), conflicts with [`propagateOrbit()`](js/entities/OrbitalMechanics.js:206) which is about to run again next frame, and produces behavior the player cannot see or learn ("why did my ship jump ahead 0.1°?"). **Must be removed.**

### B.5 ❌ Arrival is position-only

[`AutopilotSystem.js:254`](js/systems/AutopilotSystem.js:254) checks `dist < arrivalDist`. No check on:

- relative velocity magnitude,
- forward-cone angle (is the debris actually in front of `+Z_local`?),
- whether the ship is on the *trailing* side of the debris (signed dot with `V_d`).

Consequence: flyby "arrivals" are indistinguishable from stable station-keeping arrivals.

### B.6 ⚠ Magnitude control missing

Thrust is called every frame at full throttle when engaged — see [`AutopilotSystem.js:293`](js/systems/AutopilotSystem.js:293). There is no reduction when `dist < 2·arrivalDist`, no closure-rate limiter, no deceleration phase. For a distant target this wastes ΔV; for a close target it guarantees overshoot once physics catches up.

### B.7 ⚠ Visual aim ≠ thrust direction

At [`AutopilotSystem.js:264-277`](js/systems/AutopilotSystem.js:264), `aimWorldDir` points at the debris but `thrustWorldDir` points at the trail offset. For most of the transit these differ meaningfully, which would be fine — if the ship actually thrusted along `thrustWorldDir`. With issue B.3, the ship does neither reliably, and the visual promise ("nose pointed at target") doesn't match motion.

### B.8 ⚠ Collision-avoidance interference during DEBRIS / TRAWL modes

[`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:36) only exempts debris whose ID matches the active `TARGET_SELECTED` payload ([`CollisionAvoidanceSystem.js:104-106,267`](js/systems/CollisionAvoidanceSystem.js:104)). When autopilot is in `DEBRIS` or `TRAWL` mode — i.e. there is no Tab-selected target — CA will happily dodge the very object the AP is converging on, producing a tug-of-war. Trawl mode has a tighter threshold via `_trawlActive` ([`CollisionAvoidanceSystem.js:112-114`](js/systems/CollisionAvoidanceSystem.js:112)), but not an exemption.

### B.9 ⚠ Edge-case cancels missing

- No cancel if target leaves the recoverable ΔV envelope after engage (e.g. debris moves to a very different inclination). Only the raw ΔV remaining is checked.
- No cancel when the active target changes to a different debris than `_lockedTargetRef` (the lock is *intentional* per [`AutopilotSystem.js:159-163`](js/systems/AutopilotSystem.js:159), but there's no UI/HUD hint, and no way for the player to "update lock" short of disengaging).
- No handling of `RESOURCE_DEPLETED` events.
- No re-engage suggestion when trawl ends for the current cluster (only the next cluster — [`AutopilotSystem.js:532-539`](js/systems/AutopilotSystem.js:532)).

### B.10 ⚠ Tests

`js/test/` contains [`test-OrbitalMechanics.js`](js/test/test-OrbitalMechanics.js:1) and [`test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js:1) but **no `test-AutopilotSystem.js`**. There is zero automated coverage for engage conditions, heading priority, arrival, or re-engage logic. This made the above bugs easy to miss during refactors.

---

## C. Desired Behavior Specification

### C.1 Goal pose (what "behind the debris" means mathematically)

Given the target debris's scene-Cartesian state:

- `P_d` ∈ ℝ³ — debris position (scene units)
- `V_d` ∈ ℝ³ — debris velocity (km/s, per [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:469))
- `v̂_d = V_d / |V_d|` — unit prograde
- `r̂_d = P_d / |P_d|` — unit radial (Earth-center origin)

The **goal mother-ship pose** is:

```
P_m*  = P_d − v̂_d · D_trail           // position: D_trail metres behind along velocity
V_m*  = V_d                            // velocity matched (co-orbital)
+Z_m* = v̂_d                            // nose → along debris velocity → debris is ahead of ship
+Y_m* = r̂_d                            // up → radial out (matches _orientAlongVelocity convention)
```

Equivalently: forward = `normalize(P_d − P_m*) = v̂_d`, so at the goal pose the debris sits at bearing (0, 0) in the ship's reticle, at range `D_trail` along `+Z_local`. This is the "easy shot" configuration.

**`D_trail` sizing** (tool-aware):

| Tool | Capture range (from [`Constants.js`](js/core/Constants.js:755)) | Recommended `D_trail` | Rationale |
|---|---|---|---|
| lasso | `LASSO_RANGE = 200 m` | **120 m** (0.6×) | Inside projectile ballistic range with margin for 2 s reel-out. |
| spinner | 50 m arm reach | **35 m** | Arm needs final close-in via [`ArmUnit`](js/entities/ArmUnit.js:1). |
| weaver | 50 m arm reach | **35 m** | Same. |
| trawl | 200 m sweep | **150 m** | Ship trails cluster centroid; sweep runs cross-track. |

Constant proposal: `AUTOPILOT.D_TRAIL_M = { lasso: 120, spinner: 35, weaver: 35, trawl: 150, default: 80 }` (convert to scene units via `× M = × 0.00001`).

### C.2 Multi-phase approach

```
         ┌────────────────────┐
engage → │ RENDEZVOUS_FAR     │  range > 5 km OR |v_rel| > 50 m/s
         │ — Hohmann-like     │     change SMA to create along-track drift
         │   altitude offset  │     null inclination error via cross-track burns
         └─────────┬──────────┘
                   │ range < 5 km AND |v_rel| < 50 m/s
                   ▼
         ┌────────────────────┐
         │ MATCH_ORBIT        │  match SMA, e, inc within ±(5 m, 1e-4, 0.05°)
         │ — kill Δelements   │     point-aim at target for player orientation
         └─────────┬──────────┘
                   │ Δelements small
                   ▼
         ┌────────────────────┐
         │ TRAIL_ALIGN        │  drive (P_m − P_m*) to zero using small
         │ — P_m → P_m*       │     Cartesian impulses via new API
         │   V_m → V_m*       │     and null residual v_rel
         └─────────┬──────────┘
                   │ position < POS_TOL AND |v_rel| < VEL_TOL AND angle < ANG_TOL
                   ▼
         ┌────────────────────┐
         │ HOLD               │  station-keep; emit AUTOPILOT_ARRIVED
         │                    │     optionally auto-disengage on player input
         └────────────────────┘
```

Phases are internal; the public `_headingMode` string can stay (`TARGET`/`TRAWL`/`DEBRIS`/`PROGRADE`) while a new `_phase` describes rendezvous progress.

### C.3 Tolerance bands

| Symbol | Meaning | Proposed value | Source rationale |
|---|---|---|---|
| `POS_TOL` | ‖P_m − P_m*‖ to call TRAIL_ALIGN complete | 15 m (lasso) / 5 m (arm) | Well within `LASSO_RANGE − D_trail = 80 m` margin; arm capture tolerance is ~5 m. |
| `VEL_TOL` | |V_m − V_d| | 0.5 m/s | Below lasso's 5 m/s projectile speed; matches [`RCS_MAX_SPEED ≈ 0.5 m/s`](js/core/Constants.js:762). |
| `ANG_TOL` | `acos(dot(+Z_local, v̂_d))` | 0.05 rad (~3°) | Lasso auto-aim cone is ±30° ([`LassoSystem.js:247`](js/systems/LassoSystem.js:247)); 3° is *ten times tighter* → trivial shot. |
| `FAR_RANGE` | exit RENDEZVOUS_FAR | 5 km | Matches CA scan radius ([`Constants.js:884`](js/core/Constants.js:884)); inside this, CW-like linear dynamics dominate. |
| `MATCH_RANGE` | enter TRAIL_ALIGN | 1 km | Well inside any CA dodge envelope. |
| `HOLD_RANGE` | max drift before re-entering TRAIL_ALIGN | 2 × `POS_TOL` | Hysteresis against chatter. |

### C.4 Interaction with collision avoidance and player override

- When AP is engaged **and** has a lock (`TARGET`, `DEBRIS`-cached, or `TRAWL` cluster), emit `AUTOPILOT_TARGET_LOCK { id }` so [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:36) can exempt the *locked* debris even when no `TARGET_SELECTED` fired (B.8 fix). This lets DEBRIS- and TRAWL-mode autopilot coexist with CA.
- Keep existing tier-≥2 conjunction auto-disengage ([`AutopilotSystem.js:515-519`](js/systems/AutopilotSystem.js:515)) but **re-engage automatically** after `COOLDOWN = 3 s` if the threat cleared and the lock is still alive. Emit `AUTOPILOT_REENGAGE` so HUD can show it.
- Arrow-key override remains instantaneous ([`InputManager.js:145-149`](js/systems/InputManager.js:145)).
- WASD/RCS inputs during `HOLD` should **not** disengage; they should nudge the ship and `HOLD` should re-assert the goal pose (station-keeping is the whole point). Today, WASD is only active in ARM_PILOT anyway ([`InputManager.js:839-841`](js/systems/InputManager.js:839)), so this is a future-compat note.

---

## D. Proposed Fix / Redesign

### D.1 New thin Cartesian-impulse API on `PlayerSatellite`

Root cause B.3 must be fixed at the boundary. Add a new method on [`PlayerSatellite`](js/entities/PlayerSatellite.js:33) that the autopilot can call **instead of** misusing `thrustIon({x,y,z})`:

```js
// Pseudocode, ~30 LOC near PlayerSatellite.js:1661
applyCartesianImpulse(dvWorld_kmps, dt) {
    // 1) charge resources as usual (xenon + battery) via ResourceSystem
    // 2) decompose dvWorld into (radial, cross, prograde) using current velocity
    //    and position vectors — same math as _worldToOrbitalFrame
    // 3) update orbital elements via the closed-form vis-viva derivatives:
    //       Δa   = 2 a² v / μ · (dvWorld · v̂)
    //       Δe ≈ ... (Gauss's planetary equations, radial/tangential terms)
    //       Δi ≈ (dvWorld · ĥ) / v · cos(argLat)
    //    (already effectively what _applyThrust does, but driven by real dv)
    // 4) leave _rcsVelocity alone — this is an orbital-level impulse
}
```

With this in place the autopilot can reason about world-space impulses and the element update is done exactly once, correctly. `thrustIon()` stays for player input and backward compatibility.

> Alternative: keep `thrustIon()` as-is but add a sibling `applyLVLHImpulse(radial, cross, prograde, dt)` that takes a **signed triple in LVLH frame** and interprets it as an impulse, not element deltas. Either works; Cartesian is simpler at the AP call site.

### D.2 State machine in `AutopilotSystem`

Introduce a `_phase` field and a `_transitionPhase()` helper. Pseudocode, replacing the body of [`AutopilotSystem.update()`](js/systems/AutopilotSystem.js:203) roughly between lines 239 and 305:

```js
// Gather state (once per frame)
const Pm = player.getPosition();
const Vm = player.getVelocity();           // km/s
const { Pd, Vd } = resolveTargetState();   // handles TARGET / TRAWL / DEBRIS / PROGRADE
const vhat = normalize(Vd);
const Dtrail = this._getTrailDistance();   // scene units; tool-aware (§C.1)
const Pm_goal = Pd.clone().sub(vhat.clone().multiplyScalar(Dtrail));
const relP = Pm_goal.clone().sub(Pm);      // scene units
const relV = Vd.clone().sub(Vm);           // km/s
const range = Pm.distanceTo(Pd);
const vrelMag = relV.length() * 1000;      // m/s

// Phase dispatch
switch (this._phase) {
  case 'RENDEZVOUS_FAR':
    // drop SMA by a small amount if behind in true anomaly, raise if ahead
    // (Hohmann-lite): this creates along-track drift naturally
    applyAlongTrackOffsetBurn(Pm, Vm, Pd, Vd, dt);
    if (range < FAR_RANGE && vrelMag < 50) this._phase = 'MATCH_ORBIT';
    break;

  case 'MATCH_ORBIT':
    // null Δa, Δe, Δi via Cartesian impulses along -relV direction
    const dv = clampMag(relV.clone().multiplyScalar(GAIN_V), MAX_DV_STEP);
    player.applyCartesianImpulse(dv, dt);
    if (elementsClose(player.orbit, target.orbit)) this._phase = 'TRAIL_ALIGN';
    break;

  case 'TRAIL_ALIGN':
    // PD controller on (relP, relV) in world frame
    const dvCmd = relP.clone().multiplyScalar(KP)
                  .add(relV.clone().multiplyScalar(KD));
    player.applyCartesianImpulse(clampMag(dvCmd, MAX_DV_STEP), dt);
    if (relP.length() < POS_TOL && vrelMag < VEL_TOL) this._phase = 'HOLD';
    break;

  case 'HOLD':
    // tiny station-keeping nudges, mostly coasting
    if (relP.length() > 2 * POS_TOL || vrelMag > 2 * VEL_TOL)
      this._phase = 'TRAIL_ALIGN';       // hysteresis
    else
      eventBus.emit(Events.AUTOPILOT_ON_STATION, { id: targetId });
    break;
}

// Rotation (unchanged conceptually but aim at Pd, up = radial)
this._rotateTowardWorld(normalize(Pd.clone().sub(Pm)), dt);
```

Gains to tune empirically (starting values):

- `KP = 0.2  ` (per-second), `KD = 0.5` — critically damped-ish with `MAX_DV_STEP = 0.05 m/s` per frame.
- `GAIN_V = 0.3` — lazy velocity match, avoids overshoot.

**Delete** the true-anomaly teleport block at [`AutopilotSystem.js:297-304`](js/systems/AutopilotSystem.js:297).

### D.3 File-by-file change list

| File | Line(s) | Change | Notes |
|---|---|---|---|
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | 27-33 | Add `D_TRAIL_DISTANCES` dictionary (tool-keyed) separate from `TOOL_ARRIVAL_DISTANCES`. | Arrival becomes `POS_TOL`-based, not `D_trail`-based. |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:41) | 41-82 | Add `_phase`, `_lastDodgeRecoveryAt`, `_relPSmoothed`, `_relVSmoothed` to constructor state. | |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:203) | 203-305 | Rewrite `update()` body to run the 4-phase state machine; remove phase-anomaly teleport. | ~80 LOC net. |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:254) | 249-262 | Replace distance-only arrival with `TRAIL_ALIGN → HOLD` transition (pos + vel + angle). | |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:418) | 418-438 | Keep `_worldToOrbitalFrame()` only if `applyLVLHImpulse` path is chosen; otherwise delete. | |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:165) | 165, 232 | Enrich `AUTOPILOT_ENGAGE` payload with `{ phase, targetId }`. Emit new `AUTOPILOT_PHASE_CHANGE`. | HUD needs this. |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:512) | 512-549 | Add auto re-engage after conjunction clear; emit `AUTOPILOT_TARGET_LOCK` on engage/mode-change. | |
| [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js:1661) | ~1660 | Add `applyCartesianImpulse(dvWorld, dt)` (~30 LOC). Route fuel/battery through existing [`ResourceSystem`](js/systems/ResourceSystem.js:1). | Does **not** touch `_rcsVelocity`. |
| [`js/systems/CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:102) | 102-109 | Subscribe to `AUTOPILOT_TARGET_LOCK` / `AUTOPILOT_TARGET_UNLOCK`; maintain `_autopilotLockId` and exempt it alongside `_activeTargetId`. | Closes B.8. |
| [`js/core/Events.js`](js/core/Events.js:281) | 281-285 | Add `AUTOPILOT_TARGET_LOCK`, `AUTOPILOT_TARGET_UNLOCK`, `AUTOPILOT_PHASE_CHANGE`, `AUTOPILOT_ON_STATION`, `AUTOPILOT_REENGAGE`. | |
| [`js/core/Constants.js`](js/core/Constants.js:1) | new block | `AUTOPILOT: { D_TRAIL_M, POS_TOL_M, VEL_TOL_MPS, ANG_TOL_RAD, FAR_RANGE_KM, MATCH_RANGE_KM, KP, KD, MAX_DV_STEP_MPS, REENGAGE_COOLDOWN_S }`. | Single source of truth. |
| [`js/ui/HUD.js`](js/ui/HUD.js:1) or [`js/ui/TargetReticle.js`](js/ui/TargetReticle.js:1) | — | Render `_phase` string + range/closure in the AP indicator. | §D.4. |
| [`js/test/test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js:1) | NEW | See §D.5. | |

### D.4 UI/UX implications

- **HUD phase indicator:** existing autopilot indicator (referenced in [`FULL_HUD_STRATEGY.md`](archive/FULL_HUD_STRATEGY.md:86)) should now show one of `FAR · MATCH · ALIGN · HOLD` plus "ETA X s" based on closure rate. Minimal: text-only line under the AP chip.
- **Cancel hint:** today [`AutopilotSystem.js:258`](js/systems/AutopilotSystem.js:258) emits `"✓ ON STATION — ready for capture"`. Move this message to the `HOLD` transition, and keep it posted (not a one-shot) while in HOLD. Add "[A] release" to the HUD chip during HOLD.
- **"AP gave up" messaging:** when a phase takes longer than a timeout (e.g. `RENDEZVOUS_FAR` > 120 s of game time) emit a warning and fall back to `disengage('STUCK')` so the player learns the ΔV envelope.
- **Tutorial:** the AUTOPILOT stage in the skills system ([`Constants.js:973`](js/core/Constants.js:973)) should observe `AUTOPILOT_ON_STATION` instead of `AUTOPILOT_ENGAGE` for mastery progression — "engaging" is easy; "arriving" is the skill.

### D.5 Testability — proposed unit tests

Create `js/test/test-AutopilotSystem.js` alongside the existing [`test-OrbitalMechanics.js`](js/test/test-OrbitalMechanics.js:1):

**OrbitalMechanics helpers (extend existing file):**

1. `hohmannDeltaV` returns known values for 400→800 km transfer (spot-check against textbook).
2. `orbitToSceneCartesian` round-trips through `cartesianToKeplerian` to within 1e-6 km.
3. New helper `trailingRendezvousPoint(orbitD, Dtrail)` returns `P_d − v̂_d · Dtrail` with correct magnitude.

**Autopilot state transitions (new file):**

1. `engage` with selected target + ΔV ≥ 50 m/s sets `_phase = 'RENDEZVOUS_FAR'` and emits `AUTOPILOT_TARGET_LOCK`.
2. With mocked player/target at `range = 6 km, vrel = 60 m/s` → stays in FAR.
3. Decrease `range` to 4 km, `vrel` to 40 m/s → transitions to MATCH_ORBIT.
4. Null Δelements → transitions to TRAIL_ALIGN.
5. `relP < POS_TOL ∧ vrel < VEL_TOL ∧ ang < ANG_TOL` → HOLD + `AUTOPILOT_ON_STATION`.
6. In HOLD, if the target is suddenly moved `> 2 × POS_TOL` away → re-enters TRAIL_ALIGN (hysteresis test).
7. `CONJUNCTION_WARNING { tier: 2 }` in TRAIL_ALIGN → disengages; after `REENGAGE_COOLDOWN_S` with threat cleared, auto-re-engages and restores phase.
8. `target.alive = false` during any phase → `disengage('TARGET_LOST')`.
9. `engage()` while `ΔV < 50` → emits COMMS warning, stays disengaged.
10. `_getTrailDistance()` respects `TargetSelector._recommendedTool`.

**Integration with CollisionAvoidance (light):**

11. Fire `AUTOPILOT_TARGET_LOCK { id }` → [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:36) ignores that debris in the next `_scanForThreats` call (can be asserted by stubbing `debrisList`).

**Geometry sanity:**

12. After `HOLD`, assert `dot( normalize(Pd − Pm), Vd_hat ) > cos(ANG_TOL)` (debris in the forward cone). This is the property the user actually cares about.

---

## E. Risks & Follow-ups

### E.1 Eccentric / inclined targets

Real debris distribution ([`DebrisField.js:75-92`](js/entities/DebrisField.js:75)) spans 200–2000 km altitude and 28.5°–97.5° inclination. `RENDEZVOUS_FAR` with Hohmann-like SMA offset handles coplanar cases cheaply; **plane change** is ΔV-dominant ([`OrbitalMechanics.planeChangeDeltaV`](js/entities/OrbitalMechanics.js:276)). For inclination deltas > ~5° the AP should emit an advisory ("High plane change — ΔV X m/s") and disengage rather than burn the ship dry. The `totalDeltaV()` helper already exists at [`OrbitalMechanics.js:288`](js/entities/OrbitalMechanics.js:288).

Eccentric target orbits distort `v̂_d` near apogee/perigee (not purely along the "track"); the trailing-point math remains correct (it uses instantaneous velocity), but the `Dtrail` may need to be *radial-compensated* for very eccentric targets (e > 0.05). The existing game caps player eccentricity at 0.1 ([`PlayerSatellite.js:2150`](js/entities/PlayerSatellite.js:2150)); debris rarely exceeds this in the generated field, so a simple check `if (e > 0.05) D_trail *= 0.7` is sufficient.

### E.2 Near-Earth / re-entry cases

`DISENGAGE_DV_MIN` already stops AP, but `RENDEZVOUS_FAR` shouldn't *command* an altitude drop that would violate `VLEO_MIN = 200 km` ([`Constants.js:20`](js/core/Constants.js:20)). The new Cartesian impulse API should clamp `da` the way [`_applyThrust`](js/entities/PlayerSatellite.js:2153) already does. Add an explicit check: if the Hohmann-lite burn would cross `VLEO_MIN`, abort and disengage with reason `'ALTITUDE_FLOOR'`.

### E.3 Zero-velocity / degenerate targets

A captured/destroyed debris can momentarily have zero velocity magnitude. Guard `v̂_d` by `if (|V_d| < 1e-10) ...` and fall back to ship's own prograde (`+Z_local` on [`PlayerSatellite`](js/entities/PlayerSatellite.js:33)). [`AutopilotSystem.js:424-428`](js/systems/AutopilotSystem.js:424) already does this for the player; mirror it for the target.

### E.4 Co-orbital targets (nearly identical elements)

If the target shares the mother's orbit within tolerances, `RENDEZVOUS_FAR` has nothing to do — jump straight to `TRAIL_ALIGN`. Add an early `if (elementsAlmostEqual(player.orbit, target.orbit)) this._phase = 'TRAIL_ALIGN'` guard at engage time. This is the most common *tutorial* case (welcome-field debris at the same altitude — [`DebrisField.js:61-72`](js/entities/DebrisField.js:61)).

### E.5 Performance

Cost per frame: two `orbitToSceneCartesian` calls (player doesn't need one — use `this._cartesian`; target does — same as today) and a handful of vector ops. **Flat vs. today.** The 4-phase switch is O(1). No new allocations if the gradient vectors are pre-allocated as class fields (follow the pattern used in [`DebrisField`](js/entities/DebrisField.js:135-143)).

### E.6 Tutorial / onboarding impact

- The existing tutorial gate at `_tutorialBlocksAutopilot` ([`AutopilotSystem.js:542-545`](js/systems/AutopilotSystem.js:542)) stays.
- The AUTOPILOT tutorial stage now has a clearer teachable moment: "The ship parked 120 m behind the debris. Press Space." — a concrete demonstration of orbital rendezvous for beginners.
- Consider a one-time Houston comms line on first `AUTOPILOT_ON_STATION`: *"On station — debris dead ahead. Range 120 m. Reel it in, Cowboy."* Aligns with [`FULL_HUD_STRATEGY.md`](archive/FULL_HUD_STRATEGY.md:86-89).
- Skills discovery: `nav_hohmann` ([`Constants.js:997`](js/core/Constants.js:997)) currently fires on `AUTOPILOT_ARRIVED`. Retarget to `AUTOPILOT_ON_STATION` (post-rename) so it only counts once the real Hohmann-lite phase ran, not a manual proximity fly-by.

### E.7 Follow-ups

- Drop the `trueAnomaly` teleport *without* replacing functionality and you'll see the slow-convergence problem the hack was papering over. The new `RENDEZVOUS_FAR` Hohmann-lite burn is the principled replacement — but it must land before the first playtest or the AP will feel like it does nothing.
- Consider exposing the `{ Pm_goal, range, eta }` triple to [`NavSphere.js`](js/ui/NavSphere.js:1) so the player sees the trailing marker as a distinct glyph on the tactical display.
- A future `ExpertMode` could replace the `_phase` state machine with a Clohessy–Wiltshire Lambert solver for "one-burn rendezvous" bragging rights — but that is out of scope for this fix.

---

## Appendix — Key Call-Graph Touchpoints

```
InputManager (A key)
      │
      ▼
AutopilotSystem.toggle()  ──► engage()
                               │
                               ├─ _determineHeading()        [TARGET / TRAWL / DEBRIS / PROGRADE]
                               ├─ player.autopilotEngaged = true
                               └─ _lockedTargetRef, _headingTarget, _phase='RENDEZVOUS_FAR'

main.js  gameLoop (per frame, after InputManager.processInput)
      │
      ▼
autopilotSystem.update(dt)
      │
      ├─ ΔV safety  ────────────────────────► disengage('DELTAV')
      ├─ resolve target state (Pd, Vd)
      ├─ compute Pm*, relP, relV
      ├─ switch(_phase)
      │     ├─ RENDEZVOUS_FAR → applyAlongTrackOffsetBurn()  ──► player.applyCartesianImpulse()
      │     ├─ MATCH_ORBIT    → null Δelements via Cartesian impulses
      │     ├─ TRAIL_ALIGN    → PD on (relP, relV)
      │     └─ HOLD           → emit AUTOPILOT_ON_STATION
      └─ _rotateTowardWorld(aim = normalize(Pd − Pm))

collisionAvoidanceSystem.update(dt)    [after AP, same frame]
      │
      └─ scans debris; if debris.id === _autopilotLockId → skip (NEW)

player.update(dt)                      [after CA]
      │
      ├─ _applyThrust()  (element math; unchanged)
      ├─ propagateOrbit()
      └─ _orientAlongVelocity()  → skipped while autopilotEngaged
```

---

## Implementation Retrospective (2026-04-17)

### Symptom

Immediately after shipping the trailing-rendezvous redesign, engaging autopilot on any target caused the mother ship to **oscillate violently and flash on-screen**, never reaching the goal pose. Unit tests (381/381) continued to pass because they stub [`PlayerSatellite.applyCartesianImpulse`](js/entities/PlayerSatellite.js:2145) and monkey-patch [`AutopilotSystem._resolveTargetState`](js/systems/AutopilotSystem.js:454) — so the physics bridge was never exercised end-to-end.

### Root cause

An **axis-convention mismatch** between [`keplerianToCartesian()`](js/entities/OrbitalMechanics.js:76) and [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129). The former outputs positions in the game's Y-up Three.js scene frame (angular momentum axis ≡ Y). The latter was written against the textbook **Z-up standard ECI** convention and treated `hz` as the polar angular-momentum component.

Prior to the autopilot redesign this was merely latent: `cartesianToKeplerian` was only called by `totalDeltaV()` (a scalar-only consumer) and by a round-trip unit test that explicitly skipped the angular elements (see the now-obsolete comment at [`test-OrbitalMechanics.js:165`](js/test/test-OrbitalMechanics.js:165)).

The new [`applyCartesianImpulse()`](js/entities/PlayerSatellite.js:2145) is the first call site that performs a **full** round-trip `(r, v) → elements → (r, v)` and immediately renders the result. Each call scrambled Y↔Z in the output position, teleporting the ship **~1,500 km per tick** → `posErr` discontinuities of 10⁶ m → controller commanded full `MAX_ACCEL` reversals → 60 Hz alternating full-thrust impulses → screen flash.

### Fix

Single-point patch in [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129): swap `y ↔ z` on the input position and velocity so the interior element math operates in the textbook Z-up frame that its formulas assume. The returned `(a, e, i, Ω, ω, ν)` are then in the same frame that `keplerianToCartesian()` consumes as input, closing the loop. Also added a circular-orbit fallback (argument of latitude) so the near-zero-eccentricity player orbit does not numerically collapse `trueAnomaly → 0`.

Round-trip position drift: **1,450,646 m → 0.00003 m** per call (verified by `scratch/harness-roundtrip.mjs`, removed).

### Architectural decision: did **not** switch to Cartesian-authoritative state

The task brief (§4) allowed a switch to Cartesian-authoritative player state if the round-trip proved fundamentally fragile. With the frame bug fixed, the round-trip is exact to floating-point precision for all orbits tested (circular through `e = 0.3`). Keeping Keplerian elements authoritative preserves:

- Existing orbit propagation (`propagateOrbit`) and HUD readouts.
- Save/load schema (persisted orbits serialize as six elements).
- `_applyThrust` element-rate path for manual ion thrust.

An architectural overhaul was therefore unnecessary. The `applyCartesianImpulse` bridge is now a provably consistent layer over the Keplerian state.

### Controller status (untouched)

Hypotheses H1 (unit mismatch), H3 (gain mis-scaling), H4 (rotation/position coupling), and H5 (render cache staleness) were each investigated and ruled out:

- **Units.** `M = 1e-5 scene/m`; position errors converted scene→m before KP_POS scaling; velocity errors converted km/s→m/s before KP_VEL scaling. All correct at [`AutopilotSystem.js:353-354`](js/systems/AutopilotSystem.js:353).
- **Gains.** `KP_POS = 0.2 /s`, `KP_VEL = 0.8`, clamp `MAX_ACCEL·dt` produce ~0.033 m/s per 60 Hz tick — well-behaved once the round-trip is consistent.
- **Rotation.** `_rotateTowardWorld()` only slerps `quaternion`; no position side-effects.
- **Cache.** `applyCartesianImpulse` already calls `this._cartesian = orbitToSceneCartesian(this.orbit)` post-write — no staleness once the elements are correct.

### Test coverage added

- [`test-OrbitalMechanics.js`](js/test/test-OrbitalMechanics.js:164) — round-trip now checks inclination + full position invariance (would have caught the bug from day 0).
- [`test-AutopilotSystem.js` — SUITE 9](js/test/test-AutopilotSystem.js:1) — two integration tests that drive `AutopilotSystem.update()` with a realish player that delegates to the **real** `PlayerSatellite.prototype.applyCartesianImpulse`. Asserts per-tick position jumps < 10 km (pre-fix was 10⁶ m) and monotonic `posErr` decrease over a 0.5 s engage.
- [`test-AutopilotSystem.js` — SUITE 8](js/test/test-AutopilotSystem.js:539) — added a targeted round-trip-stability guard (`round-trip preserves position (< 1 m drift per impulse)`).

Final count: **384 / 384 passing**.

---

## Implementation Retrospective #2 (2026-04-17, post Y↔Z fix)

### Symptom

After the Y↔Z axis fix eliminated the oscillation, user reported the mother ship now **arrived smoothly but passed through the goal with significant velocity and continued past** — classic orbital rendezvous overshoot. Unit tests still passed (they monkey-patched `_resolveTargetState` and ran for ≤0.5 s, never reaching the braking-critical phase).

### Root cause

The per-phase control law was a **pure proportional P-D on Cartesian errors**:

```
dvCmd = KP_POS · relP + KP_VEL · relV   (then clamped by MAX_ACCEL·dt)
```

This has no predictive-braking term. In an impulse-limited rendezvous, a P-only controller **always** overshoots from sufficient range because it has no "start braking early" information. Characterisation via a Node harness driving the real [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) against a Cartesian-integrating player stub:

| Start offset | Start closing | Peak closing vel | Phase at closest approach | Overshoot distance |
|---|---|---|---|---|
| 1 km matched | 0 m/s | 59 m/s | RENDEZVOUS_FAR | 600+ m |
| 500 m closing 5 m/s | 5 m/s | 39 m/s | RENDEZVOUS_FAR | 600+ m |
| 2 km separating 3 m/s | −3 m/s | 87 m/s | RENDEZVOUS_FAR | 1250+ m |

Thrust was saturated at `MAX_ACCEL = 2 m/s²` for the entire approach; closing velocity built up at +2 m/s² until it hit `V_CAP` or the goal. Braking distance for 60 m/s at 2 m/s² is 900 m — but the proportional law only starts commanding deceleration around `posErr ≈ KP_POS⁻¹·velClosing ≈ 25 m`, far too late. The phase machine also never transitioned out of RENDEZVOUS_FAR because the ship blew through the `posErr < FAR_TO_MATCH = 500 m` band faster than one tick (briefly satisfying the condition, then shooting past).

### Fix

**Predictive quadratic-braking velocity tracker** (Option B from the task brief) replacing the P-D law in all three active phases (RENDEZVOUS_FAR / MATCH_ORBIT / TRAIL_ALIGN). HOLD keeps its damping-only law. The four-phase state machine is preserved; only the per-phase control *computation* changed, and one transition gate was adjusted.

```
v*(r)       = min(V_CAP, √(2·A_BRAKE·r))
A_BRAKE     = MAX_ACCEL · BRAKE_FRACTION
velCtrlErr  = v*·goalDir + relV_mps          // m/s
dvCmd       = KP_VEL · velCtrlErr            // clamped by MAX_ACCEL·dt as before
```

The ship is commanded to **close at the braking profile** — fast far out, asymptotically slow near the goal. At `r=0`, `v*=0` so the law reduces to pure velocity damping (ship arrives at rest). `A_BRAKE = 0.5·MAX_ACCEL` leaves 50 % of the thrust budget for transverse corrections and tracking error.

### Secondary change: MATCH→TRAIL transition gate

The old gate `velErr < 4·VEL_TOL` (2 m/s) was incompatible with the new law: under predictive braking `|velErr|` approaches `v*(r)` by design, so a tight velErr gate would defer TRAIL_ALIGN entry until sub-metre `posErr`. New gate:

```
posErrM < D_trail && velErrMps < √(2·A_BRAKE·D_trail)
```

The velErr bound is the profile velocity at the transition radius, so the gate fires naturally when the ship enters the terminal-phase band.

### Configuration changes ([`Constants.AUTOPILOT`](js/core/Constants.js:907))

| Key | Before | After | Rationale |
|---|---|---|---|
| `MAX_ACCEL` | 2.0 m/s² | 2.0 m/s² | Unchanged |
| `KP_VEL` | 0.8 | 0.8 | Unchanged (now the sole active gain) |
| `KP_POS` | 0.2 /s | 0.2 /s (deprecated) | Retained for backward compatibility, no longer used in the control law |
| `BRAKE_FRACTION` | — | **0.5** | Reserve 50 % of MAX_ACCEL for transverse/residual corrections |
| `V_CAP` | — | **50 m/s** | Hard cap on commanded closing speed (prevents absurd v* at 10+ km ranges) |

### Test coverage added

- [`test-AutopilotSystem.js` — SUITE 9](js/test/test-AutopilotSystem.js:809) — new integration test `approaches from 500 m without overshoot (closest-approach < POS_TOL, sustained)`. Uses a Cartesian-integrating player stub, drives the full [`AutopilotSystem.update()`](js/systems/AutopilotSystem.js:266) loop for 60 s with a deterministic moving-target injection, and asserts three guarantees:
  1. Closest approach `< POS_TOL` (the user-facing convergence guarantee).
  2. Maximum posErr in the final 1 s `< 2·POS_TOL` (sustained convergence — guards the pre-fix "arrive, then fly away" failure mode).
  3. Final phase ∈ { TRAIL_ALIGN, HOLD, OFF } (phase machine reached a terminal phase, not stuck in far-field approach).

### Harness notes

A diagnostic Node harness (`js/test/harness-autopilot-overshoot.js`) was used during debugging to reproduce the overshoot across four scenarios. It was deleted after the fix — the integration test above covers the regression guard. The harness surfaced one additional non-issue: the autopilot is sensitive to loop ordering (target-advance vs. player-integrate relative to `ap.update()`). The real game loop advances both at the same frame boundary, which is consistent with what the controller expects; harness-style "target-then-AP-then-player" ordering produces a spurious 750 m phase offset. Documented here so future harnesses don't reproduce it.

Final count: **385 / 385 passing** (+1 from the new overshoot integration test).

---

## Implementation Retrospective #3 (2026-04-18, post predictive-braking fix)

### Symptom

After the predictive-braking fix eliminated the single catastrophic overshoot, user reported the ship now **oscillated ~10 times** through the goal before eventually settling. Additionally: (1) autopilot never turned off after reaching position, (2) no arrival notification fired, (3) thrusters fired continuously even in station-keeping, (4) lasso/arms sometimes fired 180° wrong direction (ship momentarily past target from oscillation).

### Root cause: TIME_SCALE_GAMEPLAY mismatch

[`player.update(dt)`](js/entities/PlayerSatellite.js:941) propagates orbits at `gameDt = dt × TIME_SCALE_GAMEPLAY` where [`TIME_SCALE_GAMEPLAY = 10`](js/core/Constants.js:73). The autopilot receives raw `dt` (~0.016 s at 60 FPS) and clamps each tick's impulse at `MAX_ACCEL × dt`. But the orbit evolves 10× faster, so:

| Metric | AP's assumption | Reality |
|---|---|---|
| Available ΔV budget per game-second | `MAX_ACCEL` = 2 m/s² | 2/10 = **0.2 m/s²** |
| A_BRAKE (braking law) | 1 m/s² | **0.1 m/s²** effective |
| Braking distance from 14 m/s | 98 m | **980 m** |

The controller was **10× underdamped**, producing classic decaying-oscillation through the goal. HOLD was unreachable because the ship could never settle within the tolerance band — each oscillation crossed the POS_TOL threshold too briefly and with too much velocity to stay within the hysteresis window.

All five reported symptoms traced to this single root cause:
1. **Oscillation**: 10× underdamped approach
2. **No auto-off**: ship cycled HOLD↔TRAIL_ALIGN faster than HOLD_DURATION
3. **No notification**: TRAIL→HOLD transition never sustained (requires posErr + velErr + angle all within tolerance simultaneously)
4. **Continuous thrust**: HOLD velocity-damping fought perpetual oscillation residual
5. **180° arms**: ship oscillated past target → target temporarily behind → lasso fired away

### Fix (three parts)

#### Fix 1 — Game-time acceleration budget

```js
// BEFORE (bug):
const maxDv = AP.MAX_ACCEL * dt;

// AFTER:
const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;
const maxDv = AP.MAX_ACCEL * gameDt;
```

The control law's impulse clamp now matches the actual dynamics. Raw `dt` is still passed to `applyCartesianImpulse` for resource bookkeeping (fuel consumption stays physical).

#### Fix 2 — Dead-band station-keeping (NASA prox-ops style)

In HOLD, replaced continuous proportional velocity-damping with a **dead-band coast controller**:
- Inside the tolerance box (`posErr < POS_TOL` AND `velErr < VEL_TOL`): **coast** — zero thrust. Conserves ΔV.
- Outside the box: fire a correction pulse (`KP_VEL·0.5 · relV_mps`) to drift back in.

Box dimensions chosen to balance capture-tool accuracy and ΔV conservation:
- POS_TOL = 15 m — well within lasso range (200 m projectile from 120 m trail distance) and arm reach (50 m from 35 m trail). At worst 12.5% of lasso trail distance.
- VEL_TOL = 0.5 m/s — drift rate at which target moves ≤ 5 m during a 10 s lasso aiming window.

#### Fix 3 — Widened HOLD hysteresis

HOLD → TRAIL_ALIGN exit threshold changed from `2×POS_TOL / 2×VEL_TOL` to `4×POS_TOL / 4×VEL_TOL` (60 m / 2 m/s). This prevents rapid HOLD↔TRAIL cycling on minor orbital perturbations and gives the dead-band controller room to operate. The wider band is still well within lasso/arm engagement range.

### Configuration changes

No new [`Constants.AUTOPILOT`](js/core/Constants.js:907) entries. The changes are structural (code-level), not tuning. The existing constants are now applied correctly.

### Test coverage

Existing 385 tests continue to pass. The integration test from Retrospective #2 (`approaches from 500 m without overshoot`) validates the control law in its Cartesian-integrating stub — which uses `dt` directly (no TIME_SCALE), confirming the braking profile itself is correct. The TIME_SCALE fix is a game-loop integration concern not exercisable in the stub tests (which deliberately isolate the controller from the Keplerian propagator).

Final count: **385 / 385 passing**.
