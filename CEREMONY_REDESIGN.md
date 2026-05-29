# First Web Launch Ceremony — Deep Redesign

> **Scope:** the *first* time a player witnesses a Capture Net deploy, fly to debris, engulf it, and cinch the bag closed. This document targets the **net-launch cinematic** (deploy → flight → brake → envelop → cinch), distinct from the **daughter-arm launch ceremony** in [`CameraSystem._updateLaunchCeremony()`](js/systems/CameraSystem.js:987) (that one ends when the daughter reaches station-keep; this one starts when the player presses **F** to fire the net).
>
> **Author posture:** read-the-code first, redesign second. Every claim about today's behaviour is anchored to a file:line. The redesign extends existing systems — no rewrites — and is gated behind a new `FEATURE_FLAGS.NET_CEREMONY` flag so it can ship dark.
>
> **TL;DR:** Today the net is a *flat, 16-segment wireframe circle* that scales itself down to fake "closure." There are no visible weights, no drawstring, no cone, no close-up, no time-dilation. The player can't see what's happening because there's nothing to see. Redesign adds (a) physical rim weights, (b) a continuous drawstring threaded through eyelets, (c) a cone-shaped mesh bag, (d) a dedicated `NET_CINEMATIC` camera mode with 6 beats over ~9 s wall-clock at `ceremonyTimeScale ∈ [0.3, 0.5]`.

---

## Table of Contents

1. [Current State (with code refs)](#1-current-state-with-code-refs)
2. [Physics Model (plausible, game-grade)](#2-physics-model-plausible-game-grade)
3. [Bagging-Mechanism Trade Study](#3-bagging-mechanism-trade-study)
4. [Redesigned Ceremony — Beat Sheet](#4-redesigned-ceremony--beat-sheet)
5. [Implementation Hooks](#5-implementation-hooks)
6. [Risks & Open Questions](#6-risks--open-questions)

---

## 1. Current State (with code refs)

### 1.1 The two "ceremonies" — do not confuse them

The codebase already contains **two distinct cinematic sequences** that the brief conflates. Both are relevant; the user's request targets #2.

| # | Name | What it covers | Entry point | Duration |
|---|------|----------------|-------------|----------|
| 1 | **Daughter-arm launch ceremony** | Daughter detaches from mother strut tip, tether streams out, daughter cruises toward station-keep | [`CameraSystem.startLaunchCeremony()`](js/systems/CameraSystem.js:905) emitted from [`InputManager`](js/systems/InputManager.js:817) on G-key | **6.0 s** (2.25 + 3.0 + 0.75 — see [`DURATIONS = [0, 2.25, 3.0, 0.75]`](js/systems/CameraSystem.js:990)) |
| 2 | **Net-launch ceremony** *(no dedicated camera mode today)* | Net fires from arm/pod, spins up, flies to debris, brakes, envelops, cinches, secures | F-key → [`ArmUnit.captureFromStationKeep()`](js/entities/ArmUnit.js:3086) → `_transitionTo(S.NETTING)` → [`_updateNettingFSM()`](js/entities/ArmUnit.js:3248) → [`NetProjectile`](js/entities/CaptureNet.js:150) FSM | Variable: ~0.65 s pre-flight + flight time + ~4.2 s cinch path (see §1.3) |

Ceremony #1 is solid and recently re-tuned (50 % slower for new players — comment at [`CameraSystem.js:990`](js/systems/CameraSystem.js:990)). **Do not touch it.** This document concerns Ceremony #2, which currently has **no dedicated camera staging or time-dilation at all** — the player watches a stable but tiny wireframe disc cross 30–80 m of orbital space at ARM_PILOT range.

### 1.2 Today's net visual — what the player actually sees

[`CaptureNetVisual._createNetVisual()`](js/ui/CaptureNetVisual.js:182) builds **three** Three.js objects per net:

| Object | Geometry | Material | Visible during |
|---|---|---|---|
| `canisterMesh` | [`THREE.CylinderGeometry(0.08m, 0.08m, 0.25m, 8)`](js/ui/CaptureNetVisual.js:187) | `MeshStandardMaterial`, slate-grey, metallic | `FOLDED`, `LAUNCHING` only |
| `discMesh` | [`THREE.CircleGeometry(diameter/2, 16)`](js/ui/CaptureNetVisual.js:199) — **flat 16-segment disc**, wireframe | `wireframe: true`, opacity 0.6, `DoubleSide` | `SPINNING_UP` through `REELING` |
| `tetherLine` | 2-vertex [`THREE.BufferGeometry`](js/ui/CaptureNetVisual.js:214) | `LineBasicMaterial`, light-grey, opacity 0.7 | All in-flight states |

**Spin is faked** by [`discMesh.rotation.z += net.spinRate × 2π × dt`](js/ui/CaptureNetVisual.js:355). With a 16-segment flat circle this reads as **flicker, not rotation** — no rim asymmetry, no edge motion-blur, no weights to track angularly. The "cone" specified by [`CONE_HALF_ANGLE: 12–15°`](js/core/Constants.js:1237) in [`Constants.CAPTURE_NET.LARGE`](js/core/Constants.js:1228) is **never rendered** — the disc stays flat.

**Closure is faked** by shrinking `discMesh.scale`: see [`ENVELOP`](js/ui/CaptureNetVisual.js:373) (scale → `1 − tangleQuality × 0.5`, so ~0.5–0.8) and [`CINCH_CLOSING`](js/ui/CaptureNetVisual.js:382) (scale → `1 − tangleQuality × 0.7`, so ~0.3–0.6). Colour changes to amber, then cyan. **Nothing rotates inward, nothing tightens, no drawstring is drawn.**

**Rim weights specified in [`CAPTURE_NET.md §2.1`](CAPTURE_NET.md:69) and [`Constants.CAPTURE_NET.LARGE.RIM_WEIGHT_COUNT: 8`](js/core/Constants.js:1234) are NOT MODELED.** The legacy [`NET_WEIGHT_COUNT: 4`](js/core/Constants.js:1106) constant is still used by the older [`LassoSystem.js`](js/systems/LassoSystem.js:142) wire-frame builder, but `CaptureNetVisual.js` ignores them. This is the single largest legibility gap.

### 1.3 Today's net state machine — beat-by-beat with timing

From [`NetProjectile.update()`](js/entities/CaptureNet.js:204) state switch and [`Constants.CAPTURE_NET`](js/core/Constants.js:1144):

| Beat | State | Duration | Code | What the visual does today |
|---|---|---|---|---|
| 1 | `LAUNCHING` | [`CAST_WINDUP: 0.15 s`](js/core/Constants.js:1170) | [`_updateLaunching()`](js/entities/CaptureNet.js:237) | canister visible, no disc |
| 2 | `SPINNING_UP` | [`SPIN_UP_TIME: 0.5 s`](js/core/Constants.js:1171) | [`_updateSpinningUp()`](js/entities/CaptureNet.js:244) — `spinRate = fraction × SPIN_HZ` | disc scales 0→1, wireframe blue |
| 3 | `FLIGHT` | variable, capped at [`MAX_FLIGHT_TIME: 8 s`](js/core/Constants.js:1172) — typical 3–6 s at 10 m/s | [`_updateFlight()`](js/entities/CaptureNet.js:254) | disc spins (flicker), tether line follows |
| 4a | `CONTACT` *(slam-wrap path)* | [`SLAM_CONTACT_TIME: 0.5 s`](js/core/Constants.js:1173) | [`_updateContact()`](js/entities/CaptureNet.js:329) | disc turns amber |
| 4b | `BRAKE` *(cinch path)* | [`BRAKE_TIME: 0.5 s`](js/core/Constants.js:1174) | [`_updateBrake()`](js/entities/CaptureNet.js:336) | disc turns amber — **no visible brake event** |
| 5b | `ENVELOP` | [`ENVELOP_TIME: 1.5 s`](js/core/Constants.js:1175) | [`_updateEnvelop()`](js/entities/CaptureNet.js:343) | disc shrinks to ~0.5× — **opposite of envelopment** |
| 6b | `CINCH_CLOSING` | [`CINCH_CLOSE_TIME: 2.0 s`](js/core/Constants.js:1176) | [`_updateCinchClosing()`](js/entities/CaptureNet.js:350) | disc shrinks to ~0.3×, turns cyan |
| 7 | `SECURE_CHECK` | [`SECURE_CHECK_TIME: 0.2 s`](js/core/Constants.js:1177) | [`_updateSecureCheck()`](js/entities/CaptureNet.js:357) | disc opacity pulses |
| 8 | `CAPTURED` / `MISSED` | instant | [`_resolveCatch()`](js/entities/CaptureNet.js:391) | green / red flash via [`_flashTimers`](js/ui/CaptureNetVisual.js:150) |
| 9 | `REELING` | progress per [`netClass.REEL_SPEED`](js/core/Constants.js:1242) | [`_updateReeling()`](js/entities/CaptureNet.js:364) | disc trails back to strut tip |

**Total cinch-path wall-clock:** 0.15 + 0.5 + (flight) + 0.5 + 1.5 + 2.0 + 0.2 ≈ **4.85 s + flight**. The visual is the same flat blue/amber/cyan disc for the entire 4.85 s post-flight, plus a colour swap.

### 1.4 Today's camera during net flight

There **is no net-specific camera mode**. The camera stays in whatever view was active when the player pressed F:

| Active view | Net visibility | Source |
|---|---|---|
| `CHASE` (default after Ceremony #1) | Net is a sub-pixel speck 30–80 m away from a camera that's ~120 m back | [`CameraSystem._computeChase()`](js/systems/CameraSystem.js:1189) |
| `ARM_PILOT` (after P-key or some ceremony branches) | Net cluster is visible but flat; camera tracks **daughter**, not net | [`CameraSystem._computeArmPilot()`](js/systems/CameraSystem.js:1224) |
| `TARGET_LOCK` | Camera frames debris; net flies *across* the frame | n/a |

No `Events.NET_FIRED` listener exists in [`CameraSystem`](js/systems/CameraSystem.js) — verified by regex scan. The capture beats fire events ([`Events.NET_FIRED`](js/core/Events.js:485), [`NET_CATCH_SUCCESS`](js/core/Events.js:487), [`NET_REEL_STARTED`](js/core/Events.js:491)) but only [`CaptureNetVisual`](js/ui/CaptureNetVisual.js:113) and [`AudioSystem`](js/systems/AudioSystem.js) subscribe.

### 1.5 Diagnosed legibility gaps (what the player misses)

| # | Gap | Why it happens | Player effect |
|---|---|---|---|
| **L1** | **Rim weights invisible** | [`CaptureNetVisual`](js/ui/CaptureNetVisual.js:182) renders no weights; legacy [`NET_WEIGHT_COUNT`](js/core/Constants.js:1106) ignored | "What's keeping the net open? Where's the rotation?" |
| **L2** | **Rotation reads as flicker** | Flat 16-seg wireframe + 4 Hz spin = symmetrical strobing | Player can't tell the net is spinning at all |
| **L3** | **Net is flat, not cone** | [`CircleGeometry`](js/ui/CaptureNetVisual.js:199) ignores [`CONE_HALF_ANGLE`](js/core/Constants.js:1237) | No "mouth direction." Forward face vs. trailing face is ambiguous |
| **L4** | **Brake event has no visual** | [`_updateBrake()`](js/entities/CaptureNet.js:336) only changes colour | "What just happened? Did it hit?" |
| **L5** | **Envelopment scale-shrinks** | [`ENVELOP scale = 1 − q × 0.5`](js/ui/CaptureNetVisual.js:373) — counter-intuitive | The bag *appears to retreat from the debris* during the only beat where it should be swallowing it |
| **L6** | **No drawstring drawn** | No geometry for the cinch cord — only `discMesh.scale` shrinks | The defining mechanical action (drawstring closure) is invisible |
| **L7** | **No close-up framing** | Camera never re-frames for the net | At 30–80 m the whole beat fits in ~5 % of screen height |
| **L8** | **No time dilation** | No [`ceremonyTimeScale`](js/core/Constants.js) exists; physics dt is real-time | 4.85 s of state changes plus several seconds of flight pass in a flash relative to the player's perceptual load on a first viewing |
| **L9** | **Tether shows no tension** | Single [`LineBasicMaterial`](js/ui/CaptureNetVisual.js:217) — no kink, no taut/slack flicker, no thickness change | The "tether yanks taut and brakes the hub" causality chain is invisible |
| **L10** | **No "tail" of the bag** | Tether terminates at *disc centre*, not at a visible apex hub | Player can't see *what* the tether is pulling on. No purse-seine reading |

---

## 2. Physics Model (plausible, game-grade)

### 2.1 Spin Imparting Mechanism

**The question:** what physically rotates the net package, and what couples that rotation from the mother/daughter launcher into the net?

**Today's answer in [`CAPTURE_NET.md §2.4 Phase 2`](CAPTURE_NET.md:127):** "yo-yo despin mechanism — the package is wound with a twisted cord that unwinds on release." Real, TRL 9, but **invisible** — by the time the net is in [`SPINNING_UP`](js/core/Constants.js:1149) the unwinding has already happened off-camera inside the canister.

**Recommended physics model — hybrid rifled-bore + tip-mass despin** (one sentence for the player: *"The spring-gun has a spiral groove, so the bag exits spinning like a rifle bullet, and the unwinding tip-cord flings the weights outward."*):

1. **Linear KE: spring** — the crossbow/pod spring (E=100 J for Large Net, [`Constants.CAPTURE_NET.MOTHER_POD_SPRING_E`](js/core/Constants.js:1220)) provides the 10 m/s muzzle velocity already in [`netClass.LAUNCH_SPEED`](js/core/Constants.js:1245). No change.
2. **Angular KE: rifled bore** — the launch tube has a helical groove. As the canister rides down the rail, an outer tab follows the groove and spins the canister about its long axis. This converts a small fraction of the spring energy into ω. Same mechanism as a rifle bullet. TRL 9 (every firearm ever).
3. **Spin amplification: tip-mass yo-yo** — once free of the barrel, the canister contains the mesh wound around a central hub with the rim weights at the *innermost* coil. A pull-pin (driven by the same trigger that released the spring, ~50 ms delay) releases the spool. The weights, already moving tangentially from the rifled exit, fling outward, and angular-momentum conservation transfers the canister-axis spin into rim-tangential motion at the deployed radius. End state: rim weights at full radius with the design spin rate ([`Constants.CAPTURE_NET.LARGE.SPIN_HZ: 2`](js/core/Constants.js:1238)).

**Why this is the right pick:**
- **Legibility** — the player sees a *physical helix* on the strut tip pod muzzle (a couple of polished grooves in the alloy ring), watches the canister exit *already rotating*, then watches the weights *fling outward* on visible cords. Cause → effect → effect in three discrete frames.
- **Plausibility** — both mechanisms are real, both work in vacuum, both are passive (no powered actuator).
- **Computational cheapness** — already implemented as a state transition (`LAUNCHING → SPINNING_UP`). Just needs the canister mesh to actually rotate during `LAUNCHING` and the unfurl to be drawn during `SPINNING_UP`.

**Rejected alternatives:**
- *Pyrotechnic radial squibs* — too much KE delivered impulsively; weights would shred mesh. Also no thrust margin for a 0.6 kg net.
- *Twin counter-rotating tubes inside the launcher* — adds a powered motor to a passive pod. Cost and reliability hit.
- *Pure yo-yo despin* — today's spec, but the spin source happens *inside* an opaque canister, so it's invisible. Failing the legibility test by definition.

### 2.2 Tail-Tension → Mouth-Cinch Coupling

**The question:** the tether holds the **tail** (apex) of the bag steady — how does that tension transfer to the **mouth** (rim) to cinch it closed?

**Recommended mechanism — single coupled drawstring with apex pulley:** *(one-sentence player explanation: "The drawstring loops through every weight and ties to the tether — so when the tether yanks the tail, every weight pulls inward at the same time.")*

```
                     ╭─── rim weight + eyelet ───╮
            weight ●──┼━━┓                      ┃
                      eyelet ━━━━━━━━━━━━━━━━━━╲ ┃
            weight ●──┼━━┫                       ╲┃
   mouth →   ⋮         ┃   ← drawstring (one      ╲  apex hub
            weight ●──┼━━┫     continuous loop)    ╲┃         ╲
                      eyelet ━━━━━━━━━━━━━━━━━━━━━━╳━━━━━━━━━━ tether ━━━ daughter
            weight ●──┼━━┛                        ╱┃         ╱
            weight ●──┼━━┓                       ╱ ┃
                      eyelet ━━━━━━━━━━━━━━━━━━╱  ┃
            weight ●──┼━━┛                      ┃
                     ╰─── mesh skirt to apex ──╯
```

The drawstring is one continuous loop:
1. It threads through an **eyelet** at each rim weight (the weight slides along the cord like a bead, but is centripetally held in place by the spinning mesh skirt's stiffness until cinch begins).
2. Both ends of the loop terminate at the **apex hub** at the bag's tail, passing through a frictionless pulley/Y-junction.
3. The tether ties to the apex hub. **The drawstring and the tether are mechanically the same line at the apex** — pulling the tether *is* pulling both ends of the drawstring.

**How brake → cinch propagates (this is the physics the player must intuit):**

| Step | Mechanical event | Visible cue |
|---|---|---|
| (a) | Net mouth reaches debris. Tether goes from slack-ish to **fully taut** in <50 ms because the rim weights' forward momentum has carried the mouth *past* the apex's stationary tether radius. | Tether kink straightens; sudden brightness flash on the line |
| (b) | Tether tension **decelerates the apex hub** (Newton's 3rd: tether pulls back on hub). | Apex hub stops translating; visible "snap" recoil |
| (c) | Drawstring tension **= tether tension** (they're the same line). Each rim weight now feels an inward radial force through its eyelet. | Each rim weight starts visibly drifting toward central axis |
| (d) | Rim weights' angular momentum continues — they spiral inward as they cinch (conservation of L: r ↓ ⇒ ω ↑). | Mouth closes in a *swirling* motion, not a straight contraction |
| (e) | Drawstring length at apex reduces (gets pulled into the hub), mouth diameter goes from `D_mesh = 5–8 m` to `~0.3 × D_mesh ≈ 1.5–2.4 m`. | Bag mouth shrinks visibly around debris |
| (f) | Mesh skirt material between mouth and apex bunches into a loose pouch *behind* the cinched mouth. | Bag silhouette goes from open cone → closed pouch with debris-shaped bulge |

**Why this works in space (and why it doesn't need solenoids):**

The current [`CAPTURE_NET.md`](CAPTURE_NET.md:238) spec uses **solenoid pin-pull edge nodes** with CR2032 batteries — clever but failure-prone (radio sync, battery shelf life, 8 independent firings, single point of failure per node). The coupled-drawstring model needs **zero power, zero solenoids, zero radio**. The only actuator is the *tether reel motor on the daughter* — already required for reel-in. The same motor that drags the bag home is the motor that cinches it.

You can keep the solenoid spec as the *backup* / belt-and-braces ("if cinch tension falls below threshold within 1.5 s of brake, edge nodes fire") — that's redundancy, not the primary mechanism.

### 2.3 Are the weights coupled to the drawstring, or independent?

**Recommended: lightly coupled, ride-along.** Each weight is a tungsten bead with a polished eyelet bored through it (1.5 mm dia for Dyneema SK78 [`d_cord`](CAPTURE_NET.md:78)). The drawstring **passes through** the eyelet — the weight rides the cord but isn't clamped to it.

| Coupling regime | Forces |
|---|---|
| **During spin-up + flight** | Centripetal force on weight: `m_w × ω² × r ≈ 0.075 × 12.6² × 4 ≈ 47 N` per weight (Large Net at 2 Hz). This holds the weight at the mesh skirt's outer rim against the cord's eyelet — the weight effectively floats free on the cord. |
| **During brake/envelop** | Spin still active; weights stay at rim by centripetal force. Drawstring tension is still near zero (no tether yank yet). |
| **During cinch** | Tether yanks → drawstring tension spikes to ~80–150 N. This *exceeds* centripetal force, so each weight slides inward along the cord toward the apex. Mesh skirt drags inward with them. Spin radius shrinks; angular velocity rises by `r₁ω₁ = r₂ω₂` conservation, but kinetic energy is bled into the tether (work done against tension). |

The "ride-along" coupling means the same mechanical part (the drawstring) acts as both **the structural mesh perimeter** during deployment *and* **the closure cord** during cinch — the geometry change is what changes its function. This is elegant and matches how a real laundry-bag drawstring works.

### 2.4 Does a drawstring bag work in space? (verdict + caveats)

**Verdict: Yes, the drawstring bag is the right primary mechanism. It works in space, requires no power, and is the most legible option by a wide margin.**

| Concern | Resolution |
|---|---|
| **No gravity to settle debris in the bag** | Not needed. Debris is captured by the bag *closing around its forward inertia* — the bag is moving forward at v_launch, the debris is roughly stationary relative to the daughter (already at SK standoff), so the closure encloses by geometry, not gravity. |
| **No air drag to slow rim weights into cinch** | Beneficial: in vacuum the weights retain their angular momentum perfectly, so the spiral-inward cinch motion (§2.2 step d) is sharp and clean. On Earth a real net would slow and miss. |
| **Cold-vacuum stiffness of cordage** | Dyneema SK78 functions to −150 °C (eclipse spec). UHMWPE doesn't outgas. Cord retains 95 % of breaking strength at LEO temps. |
| **Drawstring tangling during deploy** | Real risk. Mitigated by: (a) the cord is *under tension* the whole flight (centripetal force on weights pulls it taut from the inside-out), (b) the apex pulley/Y-junction guides it cleanly, (c) the mesh skirt provides geometric constraint — the cord can't wander off the mesh perimeter. |
| **Single-line failure mode** | A cut drawstring breaks the cinch entirely. Backup: solenoid edge nodes (CAPTURE_NET.md §2.6) fire if cinch tension doesn't develop within 1.5 s of brake. Player-visible only as a separate Codex entry. |
| **Real-world precedent** | RemoveDEBRIS (Surrey/SSTL, 2018) successfully deployed a tether-pulled mesh bag in LEO. The mission did not use a drawstring cinch (it relied on entanglement), but the bag-geometry physics is identical. |

**Caveat:** the cinch's closing force is bounded by tether-reel motor torque, *not* by drawstring tension or weight inertia. If the reel motor can pull at 200 N steady-state, the cinch closes; if it stalls, the cinch hangs open. This is a single point of failure and should be Codex-noted but not gameplay-modelled at Y0.

---

## 3. Bagging-Mechanism Trade Study

Ratings: **★** = poor, **★★★★★** = excellent. Legibility = "can a new player describe what just happened in one sentence after watching it once?"

| Mechanism | Reliability | Visual Legibility | Implementation Cost | Realism (TRL) | Notes |
|---|---|---|---|---|---|
| **Drawstring bag (recommended)** | ★★★★★ | ★★★★★ | ★★★★ (extend [`CaptureNetVisual`](js/ui/CaptureNetVisual.js)) | ★★★★★ (TRL 9, every laundry bag, RemoveDEBRIS precedent) | Single passive cord, no power, no sync. Tether reel motor *is* the cinch actuator. |
| **Iris/aperture petal closure** | ★★ | ★★★★ | ★★ (8 hinged petals, hinge state machine, debris-jam logic) | ★★ (TRL 4, never flown for capture) | Petals can't conform to irregular debris; jam risk on protrusions; high mass. |
| **Throw-net + bolas-cinch hybrid** | ★★★ | ★★★ | ★★★ (already partially in [`LassoSystem.js`](js/systems/LassoSystem.js:1)) | ★★★ (TRL 6) | "Cinch" here means weighted tendrils wrap around debris from outside — closure depends on debris geometry. Unreliable on smooth/symmetric targets. |
| **Inflatable toroidal collar** | ★★★ | ★★★★ | ★★ (gas inflation system + thermal mgmt) | ★★ (TRL 4) | Collar inflates to hold mouth open, deflates to close. Gas leak = mission abort; thermal cycling kills bladder. |
| **Shape-memory alloy frame** | ★★ | ★★★ | ★★★ | ★★ (TRL 4) | **Already rejected** in [`CAPTURE_NET.md §1`](CAPTURE_NET.md:57) Q-1: eclipse thermal budget (−150 °C) breaks the activation phase transition. |
| **Magnetic / electrostatic net** | ★ | ★★ | ★ (totally new system) | ★★ (TRL 3) | Only works on ferromagnetic / charged targets — wrong tool for VLEO debris (mostly aluminium, MLI, composites). |

**Recommendation:** **Drawstring bag (current proposed, extended visualisation).** The current code already names it correctly throughout [`CAPTURE_NET.md`](CAPTURE_NET.md:53) and the state machine ([`STATES.CINCH_CLOSING`](js/core/Constants.js:1154)) — only the *visual* lies about what's happening.

---

## 4. Redesigned Ceremony — Beat Sheet

> **Trigger:** First player-issued net deploy *ever* in a save (gated by `PersistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY')`). Subsequent deploys play a stripped-down "highlights cut" — beats 3 + 5 + 6 only, all at 0.7× time scale.
>
> **Global time scale:** A new `Constants.NET_CEREMONY.TIME_SCALE = 0.4` is applied to **physics dt** during beats 1–6 via the existing time-scale plumbing used by [`CATCH_SLOWMO_FACTOR: 0.1`](js/core/Constants.js:1304). The state-machine timings in [`CAPTURE_NET`](js/core/Constants.js:1144) are *not* changed — only the wall-clock pacing is.
>
> **Skip:** Space / Enter cuts to next beat. Escape exits ceremony, snaps to ARM_PILOT, retains physics state (mirrors the existing pattern at [`InputManager.js:513`](js/systems/InputManager.js:513)).

### Beat sheet (all timings are wall-clock seconds at the chosen time scale)

| # | Name | Camera shot | Duration (wall) | Time scale | Player must understand | Code hooks |
|---|---|---|---|---|---|---|
| **1** | **Pod muzzle pre-fire** | **Close-up** — 0.6 m from pod muzzle, looking down the bore (slight 15° pitch). Pod ring fills 60 % frame height. | **1.2 s** | 0.4× | "The bag is in there, the rifled bore is going to spin it on the way out." | New `NET_CINEMATIC` mode in [`CameraSystem`](js/systems/CameraSystem.js); rifled-helix decal on muzzle in [`PlayerSatellite`](js/entities/PlayerSatellite.js) (mother pod) and [`ArmUnit`](js/entities/ArmUnit.js) strut tip |
| **2** | **Muzzle exit & spin-up** | **Side-tracking** — 2.5 m perpendicular to launch axis; canister exits left-to-right; rifled groove visible on muzzle for first 0.2 s. Canister already rotating at exit. | **1.0 s** | 0.4× | "It came out of a rifled gun, that's why it's spinning. The yo-yo cord is now unspooling and flinging the weights outward." | Animate `canisterMesh.rotation.y` during `LAUNCHING` (currently static, [`CaptureNetVisual.js:330`](js/ui/CaptureNetVisual.js:330)); new `unfurlProgress` 0→1 over `SPIN_UP_TIME` drives weight sphere appearance from r=0 to r=D/2 |
| **3** | **Bag fully deployed — flight glamour shot** | **Tracking from behind** — camera at net-apex anchor, 0.8 × D_mesh behind the rim, looking forward through the open mouth toward debris. Debris visible centred in mouth. Rim weights orbit visibly at ~2 Hz. | **1.5 s** | 0.5× (slight slowmo only) | "This is the bag. Those 8 spheres are the weights holding it open. The drawstring runs through each of them. The tether trails from the tail." | New cone-shape `discMesh` (replace [`CircleGeometry`](js/ui/CaptureNetVisual.js:199) with [`THREE.ConeGeometry(radius, height, segments, 1, true)`](https://threejs.org/docs/#api/en/geometries/ConeGeometry) open-ended); render 8 [`SphereGeometry`](https://threejs.org/docs/#api/en/geometries/SphereGeometry) instances at rim per [`netClass.RIM_WEIGHT_COUNT`](js/core/Constants.js:1234); add [`THREE.Line`](https://threejs.org/docs/#api/en/objects/Line) drawstring through weights and apex |
| **4** | **Approach — closing distance** | **Cinematic dolly** — camera slides from behind-net to *beside-net*, half a net-diameter to the port-quarter, looking at the mouth and debris together. Debris fills 30 % of frame opposite the mouth. | variable, ≈ flight time / 2 (typically 1.5–2.5 s) | 0.6× | "The mouth is closing on the debris. Brake is about to fire." | Camera lerp during `FLIGHT` state; on `_updateFlight` distance check ([`CaptureNet.js:290`](js/entities/CaptureNet.js:290)), emit new `Events.NET_BRAKE_IMMINENT` 0.3 s before contact |
| **5** | **Brake & envelop — THE MONEY SHOT** | **Orbital** — camera holds half a net-diameter to the side, perpendicular to closure axis, **fixed in world space** so the net visibly flies *into* frame, mouth-first. Debris is centred. Tether snaps taut visibly. | **2.2 s** (covers `BRAKE` 0.5 s + `ENVELOP` 1.5 s of game-time at 0.3×, plus 0.5 s settle) | **0.3×** (heavy slowmo) | "Tether yanked the tail. Rim weights had forward momentum, they swept past on both sides, the bag is now around the debris." | Tether-tension visual: thicken [`tetherLine`](js/ui/CaptureNetVisual.js:221) by 2× and brighten on `Events.NET_BRAKE_FIRED` (new event from [`_updateBrake()`](js/entities/CaptureNet.js:336)); during `ENVELOP`, animate rim weight world-positions by linear forward drift while apex hub holds — visible "wrap" motion |
| **6** | **Cinch — drawstring closes mouth** | **Pull-back medium** — camera dollies back to 1.5 × D_mesh, low side angle so the player sees the mouth *closing* in profile. Drawstring brightens with tension flow (cyan emission). Debris glow visible *through* the closing mouth, then occluded as it cinches. | **2.0 s** (covers `CINCH_CLOSING` 2.0 s at 0.4×) | 0.4× | "The drawstring is pulling each weight inward. The bag is closing exactly like a backpack drawstring." | Animate each rim weight's *radial* position from `r = D/2` to `r = 0.15 × D` over `CINCH_CLOSE_TIME`; animate drawstring `Line` vertices to match weight positions; emissive on drawstring material pulses with reel-motor "torque" curve |
| **7** | **Secured — release to gameplay** | **Settle-out wide** — camera pulls back to ARM_PILOT framing (the destination view). Catch flash, score popup, tether straightens. | **0.6 s** | 1.0× (back to normal) | "Got it. Now reel it in." | Existing [`LAUNCH_CEREMONY_COMPLETE`](js/core/Events.js:45)-style flow; emit new `Events.NET_CEREMONY_COMPLETE`; [`CameraSystem`](js/systems/CameraSystem.js) lerps to `ARM_PILOT` over 0.6 s |

**Total wall-clock for first-deploy ceremony: ~9.5–10.5 s** (1.2 + 1.0 + 1.5 + ~2.0 + 2.2 + 2.0 + 0.6, with beat 4 variable).

**Total for subsequent deploys (beats 3 + 5 + 6 at 0.7×): ~3.8 s.**

### 4.1 Where the user can't tell what's happening today — and which beat fixes it

| Today's gap (§1.5) | Fixed by beat | How |
|---|---|---|
| L1 (weights invisible) | **3** | Render `RIM_WEIGHT_COUNT` sphere meshes at perimeter |
| L2 (rotation as flicker) | **3** | Spheres at rim give asymmetric reference — true rotation reads |
| L3 (flat not cone) | **3** | Replace `CircleGeometry` with open `ConeGeometry` |
| L4 (brake has no visual) | **5** | Tether-taut snap + apex recoil + `NET_BRAKE_FIRED` event |
| L5 (envelop counterproductive scale-shrink) | **5** | Weights drift *forward* past debris instead of disc shrinking |
| L6 (no drawstring) | **3, 6** | Render drawstring `THREE.Line` and animate during cinch |
| L7 (no close-up) | **1, 5, 6** | `NET_CINEMATIC` camera mode |
| L8 (no time dilation) | **1–6** | `ceremonyTimeScale ∈ [0.3, 0.5]` |
| L9 (tether shows no tension) | **5** | Width/colour pulse on `NET_BRAKE_FIRED` |
| L10 (no visible tail) | **3, 5** | Apex hub as small sphere at tether termination |

---

## 5. Implementation Hooks

### 5.1 New constants — add to [`Constants.js CAPTURE_NET`](js/core/Constants.js:1144)

```js
NET_CEREMONY: {
  TIME_SCALE_PRE_FLIGHT:  0.4,  // beats 1–2
  TIME_SCALE_GLAMOUR:     0.5,  // beat 3
  TIME_SCALE_APPROACH:    0.6,  // beat 4
  TIME_SCALE_BRAKE:       0.3,  // beat 5 — heavy slowmo
  TIME_SCALE_CINCH:       0.4,  // beat 6
  BEAT_DURATIONS_S: {           // wall-clock seconds (NOT physics-time)
    POD_MUZZLE_PREFIRE: 1.2,
    MUZZLE_EXIT_SPINUP: 1.0,
    GLAMOUR_SHOT:       1.5,
    APPROACH_DOLLY_MIN: 1.5,    // approach beat 4 is variable, clamped [min, max]
    APPROACH_DOLLY_MAX: 2.5,
    BRAKE_ENVELOP:      2.2,
    CINCH:              2.0,
    SECURED_SETTLE:     0.6,
  },
  HIGHLIGHTS_CUT_BEATS: ['GLAMOUR_SHOT', 'BRAKE_ENVELOP', 'CINCH'],
  HIGHLIGHTS_TIME_SCALE: 0.7,
  CONE_OPEN_RADIUS_FRAC: 1.0,     // mouth radius / D_mesh × 0.5
  CONE_LENGTH_FRAC: 0.55,         // apex-to-mouth axial length / D_mesh × 0.5
  DRAWSTRING_RADIUS_FRAC_CLOSED: 0.15, // r at end of cinch / r_open
  RIM_WEIGHT_RENDER_RADIUS_M: 0.08,    // visual sphere radius (NOT physics — 75 g tungsten ≈ 1 cm real)
  RIM_WEIGHT_EMISSIVE_BRAKE: 0x66ccff, // colour-tint on brake event
  TETHER_TENSION_THICKEN_FACTOR: 2.5,  // line width × this on NET_BRAKE_FIRED
}
```

### 5.2 New events — add to [`Events.js`](js/core/Events.js:484) under net section

```js
NET_CEREMONY_START:        'net:ceremonyStart',    // { armIndex, podIndex, netClass, firstEver: boolean }
NET_BRAKE_IMMINENT:        'net:brakeImminent',    // { armIndex, podIndex, tMinus: 0.3 }
NET_BRAKE_FIRED:           'net:brakeFired',       // { armIndex, podIndex, tetherTensionN }
NET_ENVELOP_PEAK:          'net:envelopPeak',      // { armIndex, podIndex } — fires mid-ENVELOP for audio sting
NET_CINCH_PROGRESS:        'net:cinchProgress',    // { armIndex, podIndex, fraction: 0..1 } — emitted from CINCH_CLOSING tick
NET_CEREMONY_COMPLETE:     'net:ceremonyComplete', // { armIndex, podIndex, mode, success }
```

`NET_BRAKE_IMMINENT` is emitted from [`_updateFlight()`](js/entities/CaptureNet.js:254) when `distance_to_target ≤ launch_speed × 0.3 s + DIAMETER/2` (predictive lookahead). `NET_BRAKE_FIRED` is emitted from [`_updateBrake()`](js/entities/CaptureNet.js:336) on state-entry. `NET_ENVELOP_PEAK` at `ENVELOP_TIME × 0.5`. `NET_CINCH_PROGRESS` every frame during [`CINCH_CLOSING`](js/core/Constants.js:1154).

### 5.3 New camera mode — extend [`CameraSystem`](js/systems/CameraSystem.js)

Add `NET_CINEMATIC` to [`CameraViews`](js/systems/CameraSystem.js); add `this._netCeremony = { active, beat, timer, arm, net, ... }` state object mirroring `_launchCeremony` at [`CameraSystem.js:221`](js/systems/CameraSystem.js:221). Add `_updateNetCeremony(dt, ...)` method following the same phase-switch pattern as [`_updateLaunchCeremony()`](js/systems/CameraSystem.js:987). The override block at [`CameraSystem.js:415`](js/systems/CameraSystem.js:415) gets a sibling check for `this._netCeremony.active`.

**Camera waypoints needed** (all in arm-local frame, M = 1e-5 scene units / m):

| Beat | Position (relative to pod muzzle or net apex) | Look-at | FOV |
|---|---|---|---|
| 1 | strut tip + 0.6 m back, +0.15 m up | pod muzzle centre | 35° (narrow for tight close-up) |
| 2 | strut tip + 1.0 m above, 2.5 m perpendicular to launch axis | canister centroid | 40° |
| 3 | net apex − 0.8 × D back along launch axis | target debris | 50° |
| 4 | lerp from beat-3 endpoint to beat-5 start (half D port-side) | midpoint(net mouth, debris) | 45° |
| 5 | net mouth + 0.5 × D port-side, **fixed in world space** for duration | net mouth centre | 38° (slight tighten for impact) |
| 6 | lerp from beat-5 endpoint to (mouth + 1.5 × D side, low angle) | bag silhouette centroid | 42° |
| 7 | standard ARM_PILOT offsets ([`armPilot.offsetBehind/Above`](js/systems/CameraSystem.js:1019)) | net+debris bag | 40° → 45° eased |

### 5.4 Extend [`CaptureNetVisual`](js/ui/CaptureNetVisual.js)

Add to `_createNetVisual()` ([`:182`](js/ui/CaptureNetVisual.js:182)):

```js
// (a) Replace flat disc with open cone
const halfAngle = THREE.MathUtils.degToRad(netProjectile.netClass.CONE_HALF_ANGLE);
const mouthR = M * netProjectile.netClass.DIAMETER / 2;
const coneH  = mouthR / Math.tan(halfAngle);
const meshGeo = new THREE.ConeGeometry(mouthR, coneH, 16, 4, true /*open-ended*/);
// rotate so apex points -Z (back toward platform), mouth +Z (forward)
meshGeo.rotateX(Math.PI / 2);
meshGeo.translate(0, 0, coneH / 2);
const meshMat = new THREE.MeshStandardMaterial({
  color: COL_DISC, transparent: true, opacity: 0.55,
  side: THREE.DoubleSide, wireframe: true,
});
const meshCone = new THREE.Mesh(meshGeo, meshMat);
group.add(meshCone);

// (b) Rim weight spheres
const weightCount = netProjectile.netClass.RIM_WEIGHT_COUNT;
const weightGeo = new THREE.SphereGeometry(M * 0.08, 8, 8);
const weightMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.9, roughness: 0.3 });
const rimWeights = [];
for (let i = 0; i < weightCount; i++) {
  const w = new THREE.Mesh(weightGeo, weightMat.clone());
  rimWeights.push(w);
  group.add(w);
}

// (c) Drawstring — one closed loop through all weights + apex
const drawstringPos = new Float32Array((weightCount * 2 + 2) * 3); // through each weight + back to apex
const drawstringGeo = new THREE.BufferGeometry();
drawstringGeo.setAttribute('position', new THREE.BufferAttribute(drawstringPos, 3));
const drawstringMat = new THREE.LineBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.8 });
const drawstring = new THREE.Line(drawstringGeo, drawstringMat);
group.add(drawstring);

// (d) Apex hub — small sphere where tether terminates
const apexGeo = new THREE.SphereGeometry(M * 0.05, 8, 8);
const apexMat = new THREE.MeshStandardMaterial({ color: 0x665544, metalness: 0.7 });
const apexHub = new THREE.Mesh(apexGeo, apexMat);
apexHub.position.set(0, 0, 0); // local -z apex
group.add(apexHub);
```

In `update()` ([`:271`](js/ui/CaptureNetVisual.js:271)), per-state weight + drawstring placement:

- **SPINNING_UP:** weight radius lerps `0 → mouthR` over [`SPIN_UP_TIME`](js/core/Constants.js:1171); each weight at angle `θ_i = 2π × i / N + spinAngle`.
- **FLIGHT:** weight radius = `mouthR`; `spinAngle += spinRate × 2π × dt`.
- **BRAKE:** weight radius held; tether line widened (set `tetherLine.material.linewidth` *if WebGL allows*, else use a tubular `MeshLine` substitute).
- **ENVELOP:** **do not shrink scale** (delete [`discMesh.scale.setScalar(...)`](js/ui/CaptureNetVisual.js:373)). Instead, advance each weight along +Z (forward) by `t × ENVELOP_PROGRESS × 0.6 × mouthR` to visibly sweep past the debris.
- **CINCH_CLOSING:** weight radius lerps `mouthR → 0.15 × mouthR` over [`CINCH_CLOSE_TIME`](js/core/Constants.js:1176); drawstring vertices follow.

### 5.5 Trigger wiring

| Event source | Listener add |
|---|---|
| [`Events.NET_FIRED`](js/core/Events.js:485) emitted from [`CaptureNetSystem.fireDaughterNet()`](js/entities/CaptureNet.js) | Add listener in new `NetCeremony` controller (parallel to [`LaunchCinematic`](js/scene/LaunchCinematic.js)). Check `PersistenceManager` for `firstNetDeployFlag`; if true, start full ceremony; else start highlights cut. |
| [`Events.NET_FIRED`](js/core/Events.js:485) | [`CameraSystem`](js/systems/CameraSystem.js) starts `NET_CINEMATIC` mode. |
| [`Events.NET_CEREMONY_COMPLETE`](js/core/Events.js) (new) | [`CameraSystem`](js/systems/CameraSystem.js) lerps back to ARM_PILOT (same pattern as [`LAUNCH_CEREMONY_COMPLETE`](js/core/Events.js:45) → [`InputManager.js:122`](js/systems/InputManager.js:122)). |
| [`Events.NET_BRAKE_FIRED`](js/core/Events.js) (new) | [`AudioSystem`](js/systems/AudioSystem.js) plays new `playNetBrakeSting()` (sub-bass thump + tether-creak). [`CaptureNetVisual`](js/ui/CaptureNetVisual.js) widens tether + flashes apex hub white. |
| [`Events.NET_CINCH_PROGRESS`](js/core/Events.js) (new) | [`AudioSystem`](js/systems/AudioSystem.js) ramps a cinch-whine pitch with `fraction`. |

### 5.6 Persistence

Add to [`PersistenceManager`](js/systems/PersistenceManager.js):

```js
ceremonyFlags: {
  FIRST_DAUGHTER_DEPLOY: true|false,  // existing intent
  FIRST_NET_DEPLOY:      true|false,  // NEW — set false on first NET_CEREMONY_COMPLETE
}
```

### 5.7 Systems to extend (no rewrites)

| System | File | What changes |
|---|---|---|
| [`CaptureNetVisual`](js/ui/CaptureNetVisual.js) | extend `_createNetVisual` (cone, weights, drawstring, apex), rewrite `update` state branches |
| [`CameraSystem`](js/systems/CameraSystem.js) | add `NET_CINEMATIC` view, `_netCeremony` state, `_updateNetCeremony()` |
| [`CaptureNet.js`](js/entities/CaptureNet.js) | emit `NET_BRAKE_IMMINENT` / `NET_BRAKE_FIRED` / `NET_ENVELOP_PEAK` / `NET_CINCH_PROGRESS` from existing state methods |
| [`AudioSystem`](js/systems/AudioSystem.js) | new `playNetBrakeSting()`, `playNetCinchWhine(fraction)`, `playNetSecure()` |
| [`InputManager`](js/systems/InputManager.js) | mirror Space/Esc handling at [`:503`](js/systems/InputManager.js:503) for net-ceremony skip |
| [`Constants.js`](js/core/Constants.js) | new `NET_CEREMONY` block under [`CAPTURE_NET`](js/core/Constants.js:1144); add [`FEATURE_FLAGS.NET_CEREMONY`](js/core/Constants.js:417) (default false initially) |
| [`PersistenceManager`](js/systems/PersistenceManager.js) | `ceremonyFlags.FIRST_NET_DEPLOY` save/load + `GAME_RESET` reset |

**No system rewrites required.** All extensions are additive and feature-flag gated.

---

## 6. Risks & Open Questions

| # | Risk / Question | Severity | Mitigation |
|---|---|---|---|
| R1 | **Time-dilation bleed into game state.** Slowing physics dt slows the daughter's orbital propagation, the mother's RCS drift, and any conjunction-system collisions. | High | Apply `ceremonyTimeScale` *only* to the [`NetProjectile.update()`](js/entities/CaptureNet.js:204) call and [`CaptureNetVisual.update()`](js/ui/CaptureNetVisual.js:271). Leave game-world dt at 1.0×. Camera waypoints already lerp in wall-clock. |
| R2 | **Network/cinematic divergence on miss-path.** Beats 5 and 6 assume successful brake-envelop-cinch. If [`_resolveCatch()`](js/entities/CaptureNet.js:391) rolls a miss, the cinch beat shows debris already escaping. | Medium | Branch beat 6: on `MISSED`, play a "drawstring closes around empty space + debris drifts free" variant. Reuses same camera position. |
| R3 | **Beat 4 (approach) variable duration** breaks pacing if flight time is sub-1.5 s (close-range engagement at 30 m, ~3 s flight at 10 m/s — actually OK; but a 20 m engagement is 2 s flight). | Medium | Clamp beat 4 to `[1.5 s, 2.5 s]` wall-clock; if physics flight < 1.5 s, the camera dolly extends the *visual* approach by holding the net at 2 × debris radius for the remainder. Codex-acceptable cheat. |
| R4 | **`THREE.LineBasicMaterial.linewidth` is broken in WebGL2** on most platforms — the tether thickening on brake won't actually thicken. | Medium | Use [`Line2`](https://threejs.org/examples/?q=line#webgl_lines_fat) from `three/addons/lines/Line2.js` (already imported via [`Starfield.js`](js/scene/Starfield.js:8)). Pre-wired. |
| R5 | **Open question: do we render the *helical rifling groove* on the pod muzzle?** Beat 1 sells the spin-imparting physics with the player. If we skip it, the spin still happens but the *causal chain* is implied not shown. | Low | Yes — a single decal texture on the [`PlayerSatellite`](js/entities/PlayerSatellite.js) pod ring is ~10 LOC. Cheap legibility win. |
| R6 | **Open question: solenoid edge-node backup mechanism — do we still spec it?** §2.2 makes the drawstring the primary, but [`CAPTURE_NET.md §2.6`](CAPTURE_NET.md:233) sells the solenoid story. | Low | Keep solenoid as Codex flavour text ("redundancy: each weight can fire a backup pin-pull"). Don't model it visually. |
| R7 | **Open question: subsequent-deploy "highlights cut" — should it skip beat 4 entirely** (jump from glamour shot directly to brake)? | Low | Yes — beats 3 + 5 + 6 only at 0.7×, total ~3.8 s. Player has already learned the physics on first viewing. |
| R8 | **Multi-net simultaneous deploys** (Mother fires both pods + a daughter fires too). The ceremony controller would conflict. | Medium | First-ever fire grabs the ceremony; concurrent fires play stripped-down highlights cuts with no camera takeover. |
| R9 | **Camera return after ceremony if player presses ESC mid-flight** — does the net continue in flight, or abort? | Low | Mirror [`InputManager.js:504`](js/systems/InputManager.js:504): ESC → `skipNetCeremony(false)` returns camera to ARM_PILOT but **does not abort the net**. Net continues its FSM independently. |
| R10 | **Performance.** Cone + 8 weights + drawstring × up to 4 simultaneous nets = ~40 extra meshes. | Low | Negligible at single-net counts. Stress-test with 4 concurrent. Already cheap geometry (sphere 8×8, cone 16×4). |

---

*Document complete. See §4 beat sheet for the player-facing redesign; §2 for the physics rationale; §5 for the implementation map.*

---

## 7. Implementation Status — Q2 Shipped (2026-05-24)

The Q2 sprint shipped this redesign across 6 stages, all gated behind [`FEATURE_FLAGS.NET_CEREMONY`](js/core/Constants.js:432). The flag default flipped to **`true`** in Stage 6 after end-to-end test validation; the ceremony is now the default experience on every net launch.

### 7.1 Stage-by-stage status

| Stage | Description | Status | Test delta | Files |
|---|---|---|---|---|
| 0 | Foundations (flag, events, persistence stub) | ✅ Complete | +0 | [`Constants.js`](js/core/Constants.js:432), [`Events.js`](js/core/Events.js:1), [`PersistenceManager.js`](js/systems/PersistenceManager.js:172) |
| 1 | Event emission from net FSM | ✅ Complete | +14 | [`CaptureNet.js`](js/entities/CaptureNet.js:1) |
| 2 | Visual rewrite (cone + weights + drawstring + apex hub) | ✅ Complete | +20 | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) |
| 3 | NET_CINEMATIC camera mode (7 beats / 3 highlights) | ✅ Complete | +11 | [`CameraSystem.js`](js/systems/CameraSystem.js:1) |
| 4 | Per-beat time-dilation (orbital-state safe) | ✅ Complete | +15 | [`CeremonyTimeScale.js`](js/systems/CeremonyTimeScale.js:1), [`CaptureNet.js`](js/entities/CaptureNet.js:1), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1), [`CameraSystem.js`](js/systems/CameraSystem.js:1) |
| 5 | First-deploy persistence + E2E wire test | ✅ Complete | +14 | [`test-NetCeremonyFirstDeploy.js`](js/test/test-NetCeremonyFirstDeploy.js:1) (test-only) |
| 6 | setView abort + flag flip + docs | ✅ Complete | +0 | [`CameraSystem.js`](js/systems/CameraSystem.js:332), [`Constants.js`](js/core/Constants.js:432), [`test-NetCeremonyFirstDeploy.js`](js/test/test-NetCeremonyFirstDeploy.js:1), this doc, [`HANDOFF.md`](HANDOFF.md:1) |

**Final test count:** 2207 Q1 baseline → **2281** after Q2. Delta: **+74**.

### 7.2 Feature flag state

```js
// js/core/Constants.js:432
NET_CEREMONY: true,   // Q2 net-launch ceremony; default ON (Stage 6 flip, 2026-05-24)
```

### 7.3 Beats actually live (Stage 3)

| # | Key | Wall-clock | Time-scale | Camera positioning |
|---|---|---|---|---|
| 1 | `POD_MUZZLE_PREFIRE` | 0.6 s | 0.5× | Tight over-the-shoulder on pod muzzle (player pos + small forward offset) |
| 2 | `MUZZLE_EXIT_SPINUP` | 0.8 s | 0.4× | Tracks net just outside muzzle along launch direction |
| 3 | `GLAMOUR_SHOT` | 1.6 s | 0.6× | Profile shot — perpendicular to net velocity, framing full cone + weights |
| 4 | `APPROACH_DOLLY` | 2.0 s (fixed) | 0.5× | Behind-net dolly chasing target; net foreground, debris growing |
| 5 | `BRAKE_ENVELOP` | 1.2 s | 0.3× | Close-up on net-debris contact point, weights swinging inward |
| 6 | `CINCH` | 1.4 s | 0.3× | Hold on apex hub as drawstring tightens; emissive flash on hub |
| 7 | `SECURED_SETTLE` | 1.0 s | 0.6× | Pull back to wider frame, settles back toward ARM_PILOT pose |

**Highlights cut (subsequent deploys):** beats 3, 5, 6 only, all at `HIGHLIGHTS_TIME_SCALE` (0.7×). Total wall-clock ≈ 2.94 s vs. ≈ 8.6 s for the full sequence.

### 7.4 Deviations from the original design doc

- **APPROACH_DOLLY duration:** fixed 2.0 s rather than `clamp(time-to-impact, MIN, MAX)` (Stage 3 deferral). R3 mitigation as designed; just hardcoded for predictability.
- **Apex hub anchor:** net scene-position approximation rather than `captureNetVisual.getTetherAttachPoint()` — Stage 3 deferral to avoid a UI → Camera coupling.
- **`firstEver` payload:** deliberately omitted from `NET_CEREMONY_START` event. CameraSystem reads `persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY')` directly (Stage 1 design choice — keeps the event payload schema-stable).
- **Cinch progress throttle:** 10 buckets per progress update (Stage 1).
- **Tether tension thickening:** deferred. Line width is owned by [`TetherReel.js`](js/systems/TetherReel.js:1); coupling the ceremony to it was out of scope (Stage 2).
- **BRAKE emissive flash:** permanent emissive set on state ≥ BRAKE; animated flash curve deferred (Stage 2).
- **Canister rifle-rotation:** deferred (Stage 2).
- **setView during ceremony:** initially Stage 3's beats stayed live; Stage 6 patched [`setView()`](js/systems/CameraSystem.js:332) to call a new [`_abortNetCeremony()`](js/systems/CameraSystem.js:1683) helper that restores FOV + time-scale + state without writing `FIRST_NET_DEPLOY`. The requested view then wins via setView's normal flow.

### 7.5 Known gaps / follow-ups

- **Time-dilation bleed (R1):** proven safe by [`test-NetCeremonyTimeScale.js`](js/test/test-NetCeremonyTimeScale.js:1) — Keplerian elements are bitwise-equal at 0.3× over 5 s. No follow-up.
- **Multi-net simultaneous deploys (R8):** first fire grabs the ceremony; concurrent fires currently fall through with no camera takeover (acceptable per R8 mitigation). Polish opportunity if multi-pod fire becomes common.
- **R4 (fat tether line):** still deferred — tether thickening was never wired to ceremony state. If desired post-ship, route through [`TetherReel`](js/systems/TetherReel.js:1) on `NET_CEREMONY_START`.
- **R5 (helical rifling groove decal):** not added. Beat 1 sells spin via canister rotation alone.

### 7.6 How to disable

If you need to disable the ceremony, set [`FEATURE_FLAGS.NET_CEREMONY = false`](js/core/Constants.js:432) in `Constants.js`. The pre-Q2 net visual + camera behavior is preserved byte-identically under this flag (validated by [`test-NetCeremonyFirstDeploy.js`](js/test/test-NetCeremonyFirstDeploy.js:592) Test 10).
