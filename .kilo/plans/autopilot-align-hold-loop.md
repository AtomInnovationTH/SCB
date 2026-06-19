# Autopilot "align → hold → align → hold" loop

## Symptom
While **approaching a selected target (no arms deployed)**, the mothership autopilot
oscillates indefinitely between the `TRAIL_ALIGN` ("ALIGN") and `HOLD` phases. The
HUD phase chip flickers ALIGN ↔ HOLD and the autopilot never settles or auto‑disengages.

Phase labels (confirmed): [`StatusPanel.js:29`](js/ui/hud/StatusPanel.js:29) — `FAR / MATCH / ALIGN / HOLD`.
The loop is specifically `TRAIL_ALIGN ⇄ HOLD`, not `MATCH ⇄ ALIGN`.

## Why it never stops
In HOLD the auto‑disengage timer is suppressed while a locked target is alive
([`AutopilotSystem.js:676-679`](js/systems/AutopilotSystem.js:676)). So once the
ALIGN↔HOLD chatter starts it persists forever instead of timing out via
`HOLD_DURATION`.

## Root cause (deterministic, no CA / arms / eccentricity needed)
In HOLD with a locked target, **two mutually‑inconsistent control actions run on the
same frame**:

1. **Continuous orbit‑sync** ([`AutopilotSystem.js:601-641`](js/systems/AutopilotSystem.js:601))
   overwrites `player.orbit` (`semiMajorAxis/eccentricity/inclination/raan/argPerigee/meanMotion`)
   with the target's, keeping the player's own `trueAnomaly` (the trailing offset).
   Because `propagateOrbit` advances both bodies with the same mean motion, this
   **alone** holds the mother exactly at the trailing point — it *is* perfect
   station‑keeping.

2. **Per‑frame velocity‑damping pulse** ([`AutopilotSystem.js:650-652`](js/systems/AutopilotSystem.js:650))
   fires whenever `posErr > POS_TOL || velErr > VEL_TOL` and calls
   [`PlayerSatellite.applyCartesianImpulse`](js/entities/PlayerSatellite.js:3711).
   That method **re-derives `player.orbit` from the cached `_cartesian` state plus the
   impulse** ([`PlayerSatellite.js:3741-3776`](js/entities/PlayerSatellite.js:3741)),
   which **discards the orbit‑sync that just ran on the same frame**. The sync does
   not refresh `_cartesian`, so the impulse uses a stale Cartesian state.

### The divergence
Orbital sensitivity makes this catastrophic: a sub‑m/s prograde Δv maps to a
**hundreds‑of‑metres semi‑major‑axis change** (`da/dv ≈ 2a²v/μ ≈ 1.8 km per 1 m/s`
at LEO). So any damping pulse replaces the synced orbit with one whose SMA is wrong
by hundreds of metres. Over the next frames that wrong SMA produces along‑track drift
faster than the sync can heal it — and on every frame where `velErr` stays above
`VEL_TOL` the damping fires *again*, wiping the sync *again*. `posErr` climbs past the
`4·POS_TOL` (60 m) exit gate → `HOLD → TRAIL_ALIGN`. The predictive‑braking law then
re‑converges to the tight 3‑way entry gate → `HOLD` → marginal state re‑fires the
damping → diverge → `ALIGN`. Loop.

### Contributing structural defects
- **Error metric vs. control authority mismatch.** `posErr/velErr` are computed from
  [`getPosition()`](js/entities/PlayerSatellite.js:4004) (which is one frame stale and
  includes the additive `_rcsVelocity` offset, [`PlayerSatellite.js:2067-2068`](js/entities/PlayerSatellite.js:2067))
  and [`getVelocity()`](js/entities/PlayerSatellite.js:4009), while the sync governs
  only the orbit‑derived state. The controller measures a quantity it cannot null with
  `applyCartesianImpulse`.
- **Tight, asymmetric gates with no debounce.** Entry `TRAIL_ALIGN→HOLD` requires
  `posErr<15 m AND velErr<0.5 m/s AND angle<3°` ([`:511`](js/systems/AutopilotSystem.js:511));
  exit needs only `posErr>60 m OR velErr>2 m/s` ([`:657`](js/systems/AutopilotSystem.js:657)).
  A single transient frame demotes the phase, and re‑entry then takes visible time —
  producing the ALIGN flicker.

### Why existing tests miss it
- SUITE 3 hysteresis tests monkey‑patch `_resolveTargetState` and use a fake player
  whose `applyCartesianImpulse` is a no‑op spy — the real Keplerian round‑trip never runs
  ([`test-AutopilotSystem.js:346-392`](js/test/test-AutopilotSystem.js:346)).
- SUITE 9 convergence test stubs `applyCartesianImpulse` to integrate position with
  explicit Euler (no orbital coupling) and stubs `_resolveTargetState`
  ([`test-AutopilotSystem.js:857-895`](js/test/test-AutopilotSystem.js:857)).
No test exercises real `PlayerSatellite` + real Keplerian target propagation + real
`applyCartesianImpulse` through the HOLD orbit‑sync.

### Ruled out (verified)
- **Debris eccentricity** ≤ 0.02 ([`DebrisField.js:699,1162`](js/entities/DebrisField.js:699)) → trailing‑geometry mismatch is sub‑mm at `D_trail≈80 m`.
- **Collision‑avoidance dodges**: capped at `RCS_MAX_SPEED = 0.5 m/s` with `RCS_DAMPING=0.95`
  ([`Constants.js:1929-1930`](js/core/Constants.js:1929)) → ≈0.17 m displacement, far below the 15/60 m bands. The locked target is CA‑exempt ([`CollisionAvoidanceSystem.js:372`](js/systems/CollisionAvoidanceSystem.js:372)).
- **Drag differential**: sub‑metre per frame and reset by the sync.
- **Arms**: user confirmed none deployed.

## Fix

### 1. HOLD with a synced locked target must be pure coast (primary fix)
When the continuous orbit‑sync is active (locked target with an orbit), the sync alone
holds station exactly. The per‑frame velocity‑damping `applyCartesianImpulse` is both
redundant and the direct cause of the divergence. **Skip the damping pulse whenever the
HOLD orbit‑sync ran this frame.**

- In `update()` HOLD case, set a local `const syncedThisFrame = (locked target with orbit)`
  flag at the top of the sync block.
- Guard the damping pulse ([`:650-652`](js/systems/AutopilotSystem.js:650)) with
  `if (!syncedThisFrame && (posErrM > POS_TOL || velErrMps > VEL_TOL))`.
- Result: synced HOLD issues **zero** `applyCartesianImpulse` per frame → orbit elements
  stay equal to the target's → mother rides the trailing point with no drift. Rotation
  toward `v̂_d` ([`_rotateTowardWorld`](js/systems/AutopilotSystem.js:995)) is unaffected
  (it only mutates the quaternion, not the orbit).

### 2. Base HOLD→TRAIL_ALIGN demotion on the synced/orbital state + add debounce
So a legitimately lost station still demotes, but transient spikes don't flicker:
- When `syncedThisFrame`, compute the demotion `posErr/velErr` from the **orbit‑derived**
  player state (e.g. `orbitToSceneCartesian(this._player.orbit)`), excluding the stale
  `_rcsVelocity` offset, so the decision matches what the sync controls.
- Add a small **dwell/debounce**: only demote to `TRAIL_ALIGN` after the excursion
  (`posErr>4·POS_TOL || velErr>4·VEL_TOL`) persists for `≥ HOLD_EXIT_DWELL_S`
  (new constant, ~0.3 s) of accumulated time; reset the accumulator on any in‑band frame.
  This absorbs single‑frame transients (CA settling, one‑frame lag) regardless of cause.

### 3. (Optional, same file) Make the non‑synced HOLD path consistent too
For HOLD without a synced locked target (cluster/debris modes — out of scope for the
reported bug but the same latent hazard), keep the damping but apply the dwell/debounce
from step 2 and document that those modes still auto‑disengage on `HOLD_DURATION`.
No behavioural change required for the reported scenario.

## Files to change
- [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js) — HOLD case
  (`~601-684`): add `syncedThisFrame`, gate the damping pulse, switch demotion metric to
  orbit‑derived state when synced, add dwell accumulator (reset on `_setPhase`/disengage).
- [`js/core/Constants.js`](js/core/Constants.js) `AUTOPILOT` block (`~2163-2170`): add
  `HOLD_EXIT_DWELL_S: 0.3`.

## Tests (new — close the coverage gap)
Add a SUITE to [`test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js) that uses a
**real** `PlayerSatellite` (or a faithful Keplerian harness) and a real co‑orbital target
debris, with `applyCartesianImpulse` doing the real `(r,v)→elements→(r,v)` round‑trip and
`PlayerSatellite.update` propagating each tick:
1. **No ALIGN↔HOLD oscillation**: engage on a co‑orbital locked target, drive to HOLD,
   run ~30 s at 60 Hz, assert the count of `HOLD→TRAIL_ALIGN` transitions is `0`
   (or ≤1) and final phase is `HOLD`.
2. **Synced HOLD issues no per‑frame impulse**: assert `applyCartesianImpulse` is not
   called on coast frames while synced.
3. **Genuine loss still demotes (with dwell)**: teleport the target >4·POS_TOL for longer
   than `HOLD_EXIT_DWELL_S` → assert demotion to `TRAIL_ALIGN`; a sub‑dwell 1‑frame spike
   → assert it stays in `HOLD`.

Verify existing SUITE 3 / SUITE 9 still pass (they stub the impulse path, so step‑1 fix is
neutral to them). Run `node js/test/run-tests.js`.

## Risks / notes
- Removing the synced‑HOLD damping relies on the sync truly holding station. The entry
  snap ([`:526-577`](js/systems/AutopilotSystem.js:526)) already seeds the correct trailing
  `trueAnomaly`; the per‑frame sync preserves it. Confirmed mean‑motion is recomputed from
  the (synced) SMA in [`propagateOrbit`](js/entities/OrbitalMechanics.js:279), so the
  player and target advance in lock‑step.
- Station‑keeping recoil compensation ([`_applyRecoilCompensation`](js/systems/AutopilotSystem.js:1152))
  is event‑driven (`dt=0`) and unaffected by step 1; note it is also redundant under an
  active sync but harmless to leave.
