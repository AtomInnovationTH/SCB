# Space Cowboy — Game Design Document

*Consolidated from ROADMAP.md, GAMEPLAY_LOOP.md, and MASTER_PLAN.md*
*Last updated: 2026-04-14 (V7 — autopilot-first control redesign, active scanning, auto-tool recommendation)*

---

## 1. Design Vision & Heritage

Space Cowboy is a **Newtonian-physics orbital mechanics simulation** dressed as a game. The player commands an ADR platform — the V5 "Crossbow" — deploying autonomous arms to capture orbital debris. The game teaches real orbital mechanics, real ADR techniques, and real space physics through progressively challenging gameplay.

**Core tension:** Every action costs ΔV. ΔV is finite and never regenerates. The player who plans efficiently captures more debris with less fuel. This is MechWarrior 2's heat gauge — the master resource that creates strategic tension.

**Core delight:** Watching an arm you deployed autonomously navigate to a tumbling rocket body, unfurl its net, cinch it closed, and haul it back — while you're already planning the next capture.

**Autopilot-first paradigm (V7):** Manual piloting to debris in orbit is counterintuitive and burns ΔV wastefully. Autopilot handles all navigation. WASD becomes a command cluster (Autopilot / Scan / Wide-scan / Deploy). Free flight is a 1% mastery skill — the game never requires it. Players enjoy treasure hunting, upgrading, plate spinning, and resource management.

### Four-Game Heritage

| Game | Key Contribution |
|------|-----------------|
| **Independence War** (1997) | NavSphere (3D radar hemisphere with vertical stalks), velocity vector markers (⊙/⊗ teach orbital mechanics by existing), sensor tiers (progressive reveal), flight assist toggle |
| **MechWarrior 2** (1995) | Resource tension (heat gauge → ΔV budget with color/audio warnings), damage wireframe (applied to *target* debris — fragility zones, safe capture points), F1/F2/F3 progressive views |
| **FreeSpace 2** (1999) | Target wireframe box (rotating 3D wireframe with subsystem color-coding), hotkey comms menu (C→number), escort list (→ arm status list), lead indicator (→ arm intercept marker) |
| **Orbiter** (2000+) | MFD panels (independently configurable left/right displays), Orbit MFD (visual Hohmann planning with ΔV cost), Docking MFD (→ ARM PILOT cross-hair), tape gauges |

### The Grand Synthesis

| Concept | Source | Space Cowboy Implementation |
|---------|--------|---------------------------|
| 3D spatial awareness | I-War NavSphere | NavSphere with vertical stalks, range brightness, distance encoding |
| Target information | FS2 wireframe box | Debris wireframe with structural zone cycling (Z key) |
| Resource tension | MW2 heat gauge | ΔV gauge with color transitions + audio alarm |
| Navigation aids | I-War + Orbiter | Velocity markers + OrbitMFD with Hohmann transfer |
| Command interface | FS2 comms menu | C→number comms menu |
| View modes | MW2 F1/F2/F3 | COMMAND / TACTICAL / OVERVIEW / ARM PILOT / COCKPIT |
| Information panels | Orbiter MFD | Configurable left/right panels |
| Proximity ops | Orbiter Docking MFD | ARM PILOT cross-hair display |

### Three UI Layers

1. **THE WORLD** (Solid 3D) — Earth, satellite, arms, tethers, sun/moon/stars
2. **THE INFORMATION** (Wireframe/Vector) — NavSphere, brackets, velocity markers, orbit ellipses, debris wireframes
3. **THE PANELS** (HTML/Canvas) — Left MFD, right MFD, top/bottom bars — configurable per camera view

---

## 2. Core Loop: Jellyfish Trawl

**Core identity:** Space Jellyfish Fisherman — the player drifts through debris fields, extending tethered arms to catch orbital junk.

The mothership is a **lion's mane jellyfish**: central bell drifts on the orbital current, tentacles (tethered arms) extend in a sphere, anything touching a tentacle gets caught and reeled in. The mothership doesn't match orbits with each piece — it passes within tether range. The tether absorbs velocity differential during reel-in.

### Trawl Sequence

```
MOTHERSHIP ENTERS DEBRIS CLUSTER
    ├── Radar detects targets entering tether sphere
    ├── Player deploys daughter (Cast or Manual Pilot)
    ├── Daughter: approach → inspect → detumble → attach
    ├── CAPTURE! → tether reels in (no mothership ΔV spent!)
    │   └── Salvage reveal: what's inside?
    ├── Meanwhile: other targets entering/exiting range
    │   └── Player deploys additional daughters (plate-spinning)
    └── Target exits tether sphere (MISSED)
        └── Motivates faster action next time
```

### Time Window — The Difficulty Knob

Each piece of debris is within tether range for a **limited window** — natural time pressure without artificial timers.

| Traverse Speed | Window (2 km Weaver) | Real Time (10× scale) |
|---------------|---------------------|----------------------|
| 2 m/s (easy) | 33 minutes | 3.3 minutes |
| 10 m/s (hard) | 6.7 minutes | 40 seconds |

### Why Tether Reel-In Costs Zero ΔV

The tether applies a continuous, low-force constraint. At 1 m/s relative, 100 kg debris = 50 J to absorb (a AA battery holds 14,000 J). **This is the entire economic advantage of the jellyfish design.**

---

## 3. Retrieval Methods & V5 Crossbow

| Method | Range | Best For |
|--------|-------|----------|
| **Lasso** | 50–200 m | Fragments near mothership |
| **Crossbow arms** (V5) | 2–10 km tether, 3–25 m/s spring-loaded | Primary capture method |
| **Trawl sweep** | Field-wide | Mass collection of dense clusters |
| **Pulse Scan** | All-arm sensor burst | Target detection (30s cooldown) |
| **Ablation** | 50 m range | 10W laser de-spin |

### Concentric Zones

```
                ┌─────────────────────────────────────┐
                │        CROSSBOW ZONE (2–10 km)       │
                │   ┌───────────────────────────────┐   │
                │   │     LASSO ZONE (50–200 m)      │   │
                │   │         🛰 MOTHERSHIP           │   │
                │   └───────────────────────────────┘   │
                └─────────────────────────────────────┘
```

---

## 4. Scavenger Economy

The game evolves from "catch debris for points" to **"run a profitable orbital scavenging operation."** Revenue from three sources: government cleanup bounties, processed material sales, and anchor mass contracts.

**Core tension:** Every maneuver costs ΔV, every capture potentially yields ΔV and saleable mass. The pilot who plans the most fuel-positive route wins.

| Phase | Description | Status |
|-------|-------------|--------|
| **Phase 0** | Basic forge + salvage + cargo pipeline | ✅ IMPLEMENTED |
| **Phase 1** | Retrograde guidance, thrust feedback, directional audio | Partial |
| **Phase 2** | Metal salvage economy (Al, Cu, Ga, Fe, I yields per debris type) | Partial — needs TargetPanel net ΔV |
| **Phase 3** | Forge visual on mothership + forge audio | Partial — core FSM done |
| **Phase 4** | Dual-mode fuel cycling (T key, 5 fuel types) | ✅ IMPLEMENTED |
| **Phase 5** | Market dynamics, shop extensions, space elevator win condition | ❌ NOT YET |
| **Phase 6** | Route planner in OrbitMFD, trawl fishing mode, EDT bait | ❌ NOT YET |

### Synergistic Salvage Sets (Phase 5 — ✅ IMPLEMENTED)

*Implementation uses flat point bonuses instead of score multipliers (simpler, better integrated with existing scoring). Concept pairings from design adopted, mapped to actual `metalId` keys.*

| Combination | Bonus | Label |
|------------|-------|-------|
| Gallium + Copper | +300 pts | Complete Solar Array |
| Titanium + Kevlar | +250 pts | Shielding Kit |
| Aluminum + Steel | +200 pts | Structural Alloy |
| Gallium + Iridium | +500 pts | Avionics Suite (rare!) |
| Carbon Composite + Copper | +350 pts | Propulsion Package |
| Glass Ceramic + Gallium | +250 pts | Sensor Package |

### Space Elevator Win Condition (Phase 5)

Accumulate 10,000 kg of bulk material contributed to space elevator counterweight. Reward: 50,000 credits. Alternative endgame path alongside the 50-debris capture win.

---

## 5. Difficulty Progression

### Autopilot-First Skill Progression

The V7 control redesign shifts the skill curve from "learn to fly" to "learn to command":

| Player Level | Behavior | Tools Used | What They Learn |
|-------------|----------|------------|-----------------|
| **Newbie (0-5)** | S scan → Tab → A autopilot → D deploy | Auto-pick only | Tools exist. Captures happen. Dopamine. |
| **Learner (5-15)** | Notice auto-pick sometimes fails | Start pressing ` to cycle | "Spinners for small stuff, Weavers for big" |
| **Intermediate (15-30)** | W deep scan → Z wireframe → manual tool selection | Backtick + Z + specific arms | "Structural analysis shows where to attach" |
| **Advanced (30+)** | 1-6 for specific arms + arm pilot (P) | All tools, manual piloting | "I need Weaver-2 on that rocket body's docking port" |
| **Expert** | Manual flight (hidden), fuel-optimal approaches | Everything + manual thrust | The 1% who navigate without autopilot |

### Traverse Speed Adaptation

| Catch Ratio | Speed Change | Comms |
|------------|-------------|-------|
| > 80% | ×1.5 faster | "Increasing sweep speed. Let's push it." |
| 50–80% | Maintain | — |
| < 30% | ×0.6 slower | "Slowing sweep. Take your time." |

### Debris Difficulty Escalation

| Phase | Debris | Challenge |
|-------|--------|-----------|
| Tutorial (stages 0-6) | Fragments, no tumble, close | Guaranteed lasso catch |
| Tutorial (stages 7-8) | + Mission debris, slight tumble | First arm deploy, tool cycling |
| Early | + Mission debris, moderate tumble | Scanning for discovery, arm selection |
| Mid | + Defunct sats, moderate tumble | Mass assessment, deep scan, wireframe analysis |
| Late | + Rocket bodies, fast traverse | Time pressure, multi-arm juggling |
| Endgame | Dense Kessler fields, active sats | Survival + efficiency |

---

## 6. Risk-Reward: Tether Plays

Borrowed from MechWarrior's "redline" mechanic: risk overheating for one more kill shot.

**Scenario:** A high-value Iridium-bearing defunct sat drifts out of tether range. 10 seconds until tether goes taut.

| Choice | Outcome | Reward |
|--------|---------|--------|
| **Safe:** Recall arm | Lose target, keep arm | — |
| **Risky:** Detach tether | Free-flying arm on own FEEP fuel | ×2.0 score ("COWBOY!" callout) |
| **Sacrifice:** Deorbit arm+debris | Arm lost permanently | ×2.5 score ("Godspeed.") |
| **Failure:** Miss + stranded | Arm lost, missed target | −500 penalty |

V5 crossbow adds **TANGLED** state as a natural decision point — when an arm's tether tangles with debris, the player must choose: retract (safe) or cut free and pursue (risky).

Never forced. First hint after ~15 captures. The game presents the opportunity; the player decides.

---

## 7. Reward Systems (Planned)

### Sweep Report Card

```
╔══════════════════════════════════╗
║  CLUSTER SWEEP REPORT            ║
║  Targets:    18/22 captured      ║
║  Arms lost:  0                   ║
║  ΔV spent:   3.2 m/s (budget 8) ║
║  Salvage:    47 kg (3 synergies) ║
║  Rating:     ★★★★☆ EXCELLENT     ║
╚══════════════════════════════════╝
```

### Field Clearing Bonuses

*Implementation uses 25/50/75/100% thresholds (lower than original 80/90/100% design) for better pacing — reaching 80% as the first milestone was too demanding for early trawls.*

| Cleared | Comms | Reward |
|---------|-------|--------|
| 25% | "Quarter of this cluster secured." | — (comms only) |
| 50% | "Half the cluster cleared. Keep it up." | +200 credits |
| 75% | "Three-quarters clean. Almost there." | +500 credits |
| 100% | "Field completely cleared! Perfect sweep." | +2000 credits |

### Context-Sensitive Comms Feedback

Houston provides real-time operational commentary: efficiency observations, salvage opportunities, risk warnings. Not arcade announcements — mission control dialogue.

---

## 8. Implementation Status

| System | Status | Notes |
|--------|--------|-------|
| Core orbital mechanics | ✅ | Kepler propagation, J2, Hohmann |
| 8-arm crossbow (V5) | ✅ | Spring physics, dual-fire, pulse scan |
| Trawl system | ✅ | Adaptive speed, cluster generation |
| Forge system | ✅ | 5-phase pipeline, auto-start |
| Cargo system | ✅ | 9 metal types, shop integration |
| Dual-mode fuel cycling | ✅ | 5 fuel types, T-key switch |
| Shop upgrades | ✅ | 15+ items + spring/tether tiers |
| Tutorial system | ✅ | 10-stage curiosity-driven progressive discovery (V7 resequence: Beauty→Scan→Target→Autopilot→Camera→Lasso→Deploy→Mastery) |
| 5 camera views | ✅ | COMMAND/TACTICAL/OVERVIEW/ARM PILOT/COCKPIT |
| FS2 comms menu | ✅ | C-key, 6 commands |
| NavSphere | ✅ | Log distance, type shapes, range rings |
| Target panel | ✅ | CSS grid, color tiers, progressive reveal |
| Power distribution ETS | ✅ | 3 buses (Thrust/Sensors/Arms) |
| 30+ audio generators | ✅ | Procedural + forge textures |
| Synergistic salvage | ✅ | 6 metal pairs, flat bonuses (V6 Session 18) |
| Market dynamics | ❌ | Phase 5 planned |
| Space elevator win | ❌ | Phase 5 planned |
| Route planner | ❌ | Phase 6 planned |
| Risk-reward detach | ✅ | X key, ×2.0/×2.5 multipliers, ARM_LOST penalty (V6 Session 18) |
| Sweep report cards | ✅ | Wired via EventBus, stars/synergies/stats (V6 Session 18) |
| Codex expansion | ✅ | 105 entries across 9 categories (V6 Session 18) |
| Tutorial V5 vocabulary | ✅ | Crossbow metaphor, reduced thresholds (V6 Session 18) |
| SubsystemEvents | ✅ | 6 generators, persistence, codex bridge (V6 Session 18) |
| Collision avoidance AI | ✅ | Semi-autonomous RCS dodge, 4 Hz scan, target/arm exempt (Session 19) |
| _refs decoupling | ✅ | 23→6 refs, EventBus migration, singleton exports (Session 19) |
| **Control redesign** | ✅ | Autopilot-first WASD command cluster, active scanning (S/W), auto-tool (D), focus action (F), tool cycling (`) (Session 22) |
| **Active scan system** | ✅ | S=quick ping ($50, 20% discovery), W=deep scan ($150, 40% discovery), cooldowns, data overrides |
| **Auto-tool recommendation** | ✅ | Mass-based tool selection on Tab, D-deploy, backtick-cycle alternatives |

---

## 9. Collision Avoidance AI

A **semi-autonomous evasive manoeuvre system** that continuously monitors nearby debris and auto-fires RCS dodges when an imminent collision is detected — unless the player has targeted that debris for capture.

**Real-world analogue:** The ISS Pre-Determined Debris Avoidance Manoeuvre (PDAM) system.

| Feature | Implementation |
|---------|---------------|
| Detection | 4 Hz scan, linear TCA prediction, 100 m threshold |
| Dodge | Perpendicular RCS impulse, 0.5 m/s max |
| Exemptions | Active target, arm targets, ARM_PILOT mode |
| Trawl leniency | Threshold tightened to 50 m during active trawl |
| Player override | WASD/arrow input within 1.5 s cancels dodge |
| Toggle | Comms menu or API, `CA_TOGGLED` event |
| Cooldown | 3 s between dodges |

**Phase 3 (not yet built):** Shop upgrades (Enhanced CA, Predictive Shield), visual chevron threat indicator, audio cues.

---

*Design heritage: Independence War (1997), MechWarrior 2 (1995), FreeSpace 2 (1999), Orbiter (2000).*
*Core identity: Jellyfish Fisherman. Not a pilot sim. A fishing game in orbit.*
*V7 paradigm: Autopilot-first. WASD = command cluster. Free flight is the 1% mastery skill.*
