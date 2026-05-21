# GameFlowManager._refs Decoupling Plan

*Date: 2026-04-12 | Analysis of 17 remaining direct references*

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Ref Catalog — All 17 Entries](#ref-catalog)
3. [Categorization](#categorization)
4. [EASY Refs — Detailed Plans](#easy-refs)
5. [MEDIUM Refs — Detailed Plans](#medium-refs)
6. [HARD Refs — Analysis](#hard-refs)
7. [KEEP Refs — Justification](#keep-refs)
8. [Execution Plan](#execution-plan)

---

## Executive Summary

[`GameFlowManager.js`](js/systems/GameFlowManager.js) currently holds **17 direct references** in its `_refs` object, down from 23 after the first decoupling pass (see [`HANDOFF.md`](HANDOFF.md)). This plan categorizes each ref and provides concrete decoupling strategies.

| Category | Count | Refs |
|----------|-------|------|
| **EASY** | 4 | sensorSystem, tutorialSystem, commsSystem, inputManager |
| **MEDIUM** | 7 | hud, subsystemEvents, debrisWireframe, targetSelector, kesslerSystem, briefingScreen, trawlManager |
| **HARD** | 4 | shopScreen, resourceSystem, player, armManager |
| **KEEP** | 2 | cameraSystem, debrisField |

**Projected outcome:** 11 refs removable (EASY + MEDIUM), reducing `_refs` from 17 → 6. The 4 HARD refs can be addressed in a future architectural pass.

---

## Ref Catalog

### Complete usage matrix

| # | Ref | Type | Call Sites | Methods Called | Pattern |
|---|-----|------|-----------|---------------|---------|
| 1 | `player` | PlayerSatellite | 5 | `getOrbitalElements()`, `orbit.semiMajorAxis=`, `orbit.trueAnomaly=`, `applyUpgrade()` | Read state, mutate props, call method |
| 2 | `debrisField` | DebrisField | 9 | `getTargetList()`, `getDebrisClusters()`, `getDebrisById()`, `removeDebris()` | Query data, modify collection |
| 3 | `armManager` | ArmManager | 9 | `arms.find()`, `deployArm()`, `deployTrawl()`, `reset()`, `applyUpgrade()` | Query state, call methods |
| 4 | `cameraSystem` | CameraSystem | 8 | `getView()`, `currentView`, `setView()`, `setLockTarget()`, `getPilotedArm()`, `clearPilotArm()` | Read + write state (multiple accesses per location) |
| 5 | `hud` | HUD | 12 | `hide()`, `show()`, `setViewConfig()`, `setSelectedTarget()`, `hidePause()` | Call methods (fire-and-forget) |
| 6 | `briefingScreen` | BriefingScreen | 1 | `setTargets()` | Call method with complex payload |
| 7 | `shopScreen` | ShopScreen | 8 | `restorePurchases()`, `setContractMass()`, `getContractMass()`, `forEachPurchasedUpgrade()`, `getSerializableUpgrades()` | Iterator, serialize, restore |
| 8 | `debrisWireframe` | DebrisWireframe | 8 | `setTarget()`, `hasAssessedTarget()` | Call method + sync query |
| 9 | `commsSystem` | CommsSystem | 7 | `stop()`, `start()`, `_active` (read), `reset()`, `addMessage()` | Lifecycle + messaging |
| 10 | `resourceSystem` | ResourceSystem | 10 | `reset()`, `restore()`, `serialize()`, `replenish()`, `replenishPanelHealth()`, `addLithium()`, `applyUpgrade()` | Many methods, save/load |
| 11 | `sensorSystem` | SensorSystem | 1 | `applyUpgrade()` | Single call method |
| 12 | `kesslerSystem` | KesslerSystem | 5 | `shieldHits` (read + decrement), `reset()`, `applyUpgrade()` | Read state, call methods |
| 13 | `targetSelector` | TargetSelector | 8 | `setTarget()`, `getActiveTarget()` | Write + sync query |
| 14 | `inputManager` | InputManager | 4 | `isArmPilotMode()`, `setArmPilotMode()` | Read + write state |
| 15 | `trawlManager` | TrawlManager | 5 | `active` (read), `startTrawl()`, `endTrawl()` | Read state, call methods |
| 16 | `tutorialSystem` | TutorialSystem | 2 | `active` (read), `stage` (read), `advanceTo()`, `skip()` | Read state, call methods |
| 17 | `subsystemEvents` | SubsystemEvents | 2 | `restore()`, `getState()` | Save/load only |

### Detailed call-site map

<details>
<summary><b>1. player</b> — 5 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`transitionToState(BRIEFING)`](js/systems/GameFlowManager.js:127) | 127 | `player.getOrbitalElements()` — read state for target list |
| [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:150) | 150 | Passed as arg to `trawlManager.startTrawl(nearest, player)` |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:374) | 374 | `player.orbit.semiMajorAxis = ...`, `player.orbit.trueAnomaly = 0` — mutate orbit |
| [`resetGame()`](js/systems/GameFlowManager.js:1043) | 1043 | `player.orbit.semiMajorAxis = ...`, `player.orbit.trueAnomaly = 0` — mutate orbit |
| [`applyUpgradeEffect()`](js/systems/GameFlowManager.js:1096) | 1096 | `player.applyUpgrade(data)` — propulsion upgrades |

</details>

<details>
<summary><b>2. debrisField</b> — 9 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`transitionToState(BRIEFING)`](js/systems/GameFlowManager.js:127) | 127 | `debrisField.getTargetList(player.getOrbitalElements())` |
| [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:147) | 147 | `debrisField.getDebrisClusters()` |
| [`BRIEFING_COMMENCE`](js/systems/GameFlowManager.js:309) | 309 | `debrisField.getDebrisById(data.target.id)` |
| [`HUD_TARGET_CLICK`](js/systems/GameFlowManager.js:417) | 417 | `debrisField.getDebrisById(data.id)` |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:621) | 621 | `debrisField.getDebrisById(data.debrisId)` |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:637) | 637 | `debrisField.removeDebris(data.debrisId)` |
| [`ARM_DEORBIT`](js/systems/GameFlowManager.js:837) | 837 | `debrisField.getDebrisById(debrisId)` |
| [`ARM_DEORBIT`](js/systems/GameFlowManager.js:864) | 864 | `debrisField.removeDebris(debrisId)` |
| [`TRAWL_START`](js/systems/GameFlowManager.js:965) | 965 | `df.getDebrisClusters()` |

</details>

<details>
<summary><b>3. armManager</b> — 9 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`ARM_DEPLOYED`](js/systems/GameFlowManager.js:598) | 598 | `armManager.arms.find(a => a.id === data.armId)` — auto-fail chance |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:624) | 624 | `armManager.arms.find(a => a.id === data.armId)` — get arm for scoring |
| [`ARM_DEORBIT`](js/systems/GameFlowManager.js:842) | 842 | `armManager.arms.find(a => a.id === armId)` — get arm for ΔV calc |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:382) | 382 | `armManager.reset()` |
| [`resetGame()`](js/systems/GameFlowManager.js:1051) | 1051 | `armManager.reset()` |
| [`ARM_DEPLOY`](js/systems/GameFlowManager.js:937) | 937 | `armManager.deployArm(target, data.preferType)` |
| [`TRAWL_START`](js/systems/GameFlowManager.js:981) | 981 | `armManager.deployTrawl()` |
| [`applyUpgradeEffect()`](js/systems/GameFlowManager.js:1118) | 1118 | `armManager.applyUpgrade(data)` |
| [`deployArm()`](js/systems/GameFlowManager.js:1206) | 1206 | `armManager.deployArm(target)` |

</details>

<details>
<summary><b>4. cameraSystem</b> — 8 locations (multiple accesses per location)</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`applyViewConfig()`](js/systems/GameFlowManager.js:76) | 76 | `cameraSystem.getView()` — read current view |
| [`transitionToState(APPROACH)`](js/systems/GameFlowManager.js:161) | 161 | `cameraSystem.setLockTarget(targetPos)` |
| [`ARM_DEPLOYED`](js/systems/GameFlowManager.js:577) | 577 | `cameraSystem.currentView`, `cameraSystem.setLockTarget()`, `cameraSystem.setView()` |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:612) | 612 | `cameraSystem.getPilotedArm()?.id`, `cameraSystem.clearPilotArm()` |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:787) | 787 | `cameraSystem.currentView`, `cameraSystem.setView()` — cinematic hold |
| [`ARM_EXPENDED`](js/systems/GameFlowManager.js:816) | 816 | `cameraSystem.getPilotedArm()?.id`, `cameraSystem.clearPilotArm()` |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:388) | 388 | `cameraSystem.setView(CameraViews.CHASE)` |
| [`resetGame()`](js/systems/GameFlowManager.js:1057) | 1057 | `cameraSystem.setView(CameraViews.CHASE)` |

</details>

<details>
<summary><b>5. hud</b> — 12 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`applyViewConfig()`](js/systems/GameFlowManager.js:78) | 78 | `hud.setViewConfig(config)` |
| [`transitionToState(MENU)`](js/systems/GameFlowManager.js:119) | 119 | `hud.hide()` |
| [`transitionToState(BRIEFING)`](js/systems/GameFlowManager.js:125) | 125 | `hud.hide()` |
| [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:132) | 132 | `hud.show()` |
| [`transitionToState(APPROACH)`](js/systems/GameFlowManager.js:157) | 157 | `hud.show()` |
| [`transitionToState(INTERACTION)`](js/systems/GameFlowManager.js:168) | 168 | `hud.show()` |
| [`transitionToState(SHOP)`](js/systems/GameFlowManager.js:173) | 173 | `hud.hide()` |
| [`transitionToState(GAME_OVER)`](js/systems/GameFlowManager.js:178) | 178 | `hud.hide()` |
| [`transitionToState(WIN)`](js/systems/GameFlowManager.js:184) | 184 | `hud.hide()` |
| [`HUD_TARGET_CLICK`](js/systems/GameFlowManager.js:421) | 421 | `hud.setSelectedTarget(data.id)` |
| [`PAUSE_RESUME`](js/systems/GameFlowManager.js:1011) | 1011 | `hud.hidePause()` |
| [`PAUSE_MENU`](js/systems/GameFlowManager.js:1016) | 1016 | `hud.hidePause()` |

</details>

<details>
<summary><b>6. briefingScreen</b> — 1 call site</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`transitionToState(BRIEFING)`](js/systems/GameFlowManager.js:127) | 127 | `briefingScreen.setTargets(targets, player.getOrbitalElements())` |

</details>

<details>
<summary><b>7. shopScreen</b> — 8 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`MENU_CONTINUE`](js/systems/GameFlowManager.js:261) | 261 | `shopScreen.restorePurchases(save.upgrades)` |
| [`MENU_CONTINUE`](js/systems/GameFlowManager.js:264) | 264 | `shopScreen.setContractMass(save.contractMassKg)` |
| [`MENU_CONTINUE`](js/systems/GameFlowManager.js:283) | 283 | `shopScreen.forEachPurchasedUpgrade(cb)` — re-apply effects |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:395) | 395 | `shopScreen.forEachPurchasedUpgrade(cb)` — re-apply effects |
| [`saveGame()`](js/systems/GameFlowManager.js:1145) | 1145 | `shopScreen.getSerializableUpgrades()` |
| [`saveGame()`](js/systems/GameFlowManager.js:1155) | 1155 | `shopScreen.getContractMass()` |
| [`resetGame()`](js/systems/GameFlowManager.js:1066) | 1066 | `shopScreen.setContractMass(0)` |
| [`_hasUpgrade()`](js/systems/GameFlowManager.js:1181) | 1181 | `shopScreen.forEachPurchasedUpgrade(cb)` — query |

</details>

<details>
<summary><b>8. debrisWireframe</b> — 8 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`HUD_TARGET_CLICK`](js/systems/GameFlowManager.js:420) | 420 | `debrisWireframe.setTarget(debris)` |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:379) | 379 | `debrisWireframe.setTarget(null)` |
| [`resetGame()`](js/systems/GameFlowManager.js:1048) | 1048 | `debrisWireframe.setTarget(null)` |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:641) | 641 | `debrisWireframe.hasAssessedTarget()` — sync query for scoring |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:784) | 784 | `debrisWireframe.setTarget(null)` — post-capture clear |
| [`ARM_DEORBIT`](js/systems/GameFlowManager.js:869) | 869 | `debrisWireframe.hasAssessedTarget()` — sync query for scoring |
| [`ARM_DEORBIT`](js/systems/GameFlowManager.js:894) | 894 | `debrisWireframe.setTarget(null)` — post-deorbit clear |
| [`DEBRIS_REMOVED`](js/systems/GameFlowManager.js:916) | 916 | `debrisWireframe.setTarget(null)` — clear dead target |

</details>

<details>
<summary><b>9. commsSystem</b> — 7 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`transitionToState(MENU)`](js/systems/GameFlowManager.js:120) | 120 | `commsSystem.stop()` |
| [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:134) | 134 | `commsSystem._active` (read), `commsSystem.start()` |
| [`transitionToState(GAME_OVER)`](js/systems/GameFlowManager.js:179) | 179 | `commsSystem.stop()` |
| [`transitionToState(WIN)`](js/systems/GameFlowManager.js:185) | 185 | `commsSystem.stop()` |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:392) | 392 | `commsSystem.reset()` |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:665) | 665 | `commsSystem.addMessage(...)` — capture delivery notification |
| [`COMMS_SEND`](js/systems/GameFlowManager.js:557) | 557 | `commsSystem.addMessage(...)` — generic forwarding |

</details>

<details>
<summary><b>10. resourceSystem</b> — 10 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`MENU_CONTINUE`](js/systems/GameFlowManager.js:255) | 255 | `resourceSystem.restore(save.resourceMaxes)` |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:371) | 371 | `resourceSystem.reset()` |
| [`resetGame()`](js/systems/GameFlowManager.js:1041) | 1041 | `resourceSystem.reset()` |
| [`ARM_RETURNED` salvage](js/systems/GameFlowManager.js:676) | 676 | `resourceSystem.replenish('xenon', ...)` |
| [`ARM_RETURNED` salvage](js/systems/GameFlowManager.js:701) | 701 | `resourceSystem.replenishPanelHealth(...)` |
| [`ARM_RETURNED` salvage](js/systems/GameFlowManager.js:710) | 710 | `resourceSystem.replenish('battery', ...)` |
| [`ARM_RETURNED` salvage](js/systems/GameFlowManager.js:722) | 722 | `resourceSystem.replenish('coldGas', ...)` |
| [`ARM_RETURNED` salvage](js/systems/GameFlowManager.js:739) | 739 | `resourceSystem.addLithium(...)` |
| [`applyUpgradeEffect()`](js/systems/GameFlowManager.js:1091) | 1091 | `resourceSystem.applyUpgrade(data)` |
| [`saveGame()`](js/systems/GameFlowManager.js:1143) | 1143 | `resourceSystem.serialize()` |

</details>

<details>
<summary><b>11. sensorSystem</b> — 1 call site</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`applyUpgradeEffect()`](js/systems/GameFlowManager.js:1109) | 1109 | `sensorSystem.applyUpgrade(data)` |

</details>

<details>
<summary><b>12. kesslerSystem</b> — 5 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`GAME_KESSLER`](js/systems/GameFlowManager.js:466) | 466 | `kesslerSystem.shieldHits` (read + decrement) |
| [`GAME_COLLISION`](js/systems/GameFlowManager.js:481) | 481 | `kesslerSystem.shieldHits` (read + decrement) |
| [`ACTIVE_SAT_COLLISION`](js/systems/GameFlowManager.js:498) | 498 | `kesslerSystem.shieldHits` (read + decrement) |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:393) | 393 | `kesslerSystem.reset()` |
| [`applyUpgradeEffect()`](js/systems/GameFlowManager.js:1131) | 1131 | `kesslerSystem.applyUpgrade(data)` |

</details>

<details>
<summary><b>13. targetSelector</b> — 8 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`BRIEFING_COMMENCE`](js/systems/GameFlowManager.js:312) | 312 | `targetSelector.setTarget(debris)` |
| [`HUD_TARGET_CLICK`](js/systems/GameFlowManager.js:419) | 419 | `targetSelector.setTarget(debris)` |
| [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:378) | 378 | `targetSelector.setTarget(null)` |
| [`resetGame()`](js/systems/GameFlowManager.js:1047) | 1047 | `targetSelector.setTarget(null)` |
| [`ARM_DEPLOYED`](js/systems/GameFlowManager.js:579) | 579 | `targetSelector.getActiveTarget()` (read) |
| [`ARM_DEPLOY`](js/systems/GameFlowManager.js:929) | 929 | `targetSelector.getActiveTarget()` (read) |
| [`DEBRIS_REMOVED`](js/systems/GameFlowManager.js:917) | 917 | `targetSelector.getActiveTarget()` (read) |
| [`deployArm()`](js/systems/GameFlowManager.js:1196) | 1196 | `targetSelector.getActiveTarget()` (read) |

</details>

<details>
<summary><b>14. inputManager</b> — 4 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:612) | 612 | `inputManager.isArmPilotMode()` (read) |
| [`ARM_RETURNED`](js/systems/GameFlowManager.js:613) | 613 | `inputManager.setArmPilotMode(false)` (write) |
| [`ARM_EXPENDED`](js/systems/GameFlowManager.js:816) | 816 | `inputManager.isArmPilotMode()` (read) |
| [`ARM_EXPENDED`](js/systems/GameFlowManager.js:817) | 817 | `inputManager.setArmPilotMode(false)` (write) |

</details>

<details>
<summary><b>15. trawlManager</b> — 5 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:146) | 146 | `trawlManager.active` (read), `trawlManager.startTrawl(cluster, player)` |
| [`TRAWL_START`](js/systems/GameFlowManager.js:950) | 950 | `tm.active` (read) |
| [`TRAWL_START`](js/systems/GameFlowManager.js:957) | 957 | `tm.endTrawl()` |
| [`TRAWL_START`](js/systems/GameFlowManager.js:964) | 964 | `tm.startTrawl(clusters[0], pl)` |

</details>

<details>
<summary><b>16. tutorialSystem</b> — 2 locations (4 individual accesses)</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:139) | 139 | `tutorialSystem.active`, `tutorialSystem.stage` (read), `tutorialSystem.advanceTo(LOOK_AROUND)` |
| [`MENU_CONTINUE`](js/systems/GameFlowManager.js:295) | 295 | `tutorialSystem.skip()` |

</details>

<details>
<summary><b>17. subsystemEvents</b> — 2 call sites</summary>

| Location | Line | Usage |
|----------|------|-------|
| [`MENU_CONTINUE`](js/systems/GameFlowManager.js:274) | 274 | `subsystemEvents.restore(save.subsystemEvents)` |
| [`saveGame()`](js/systems/GameFlowManager.js:1156) | 1156 | `subsystemEvents.getState()` |

</details>

---

## Categorization

### EASY (4 refs) — Single event emission/listener replacement

| Ref | Call Sites | Why Easy |
|-----|-----------|----------|
| **sensorSystem** | 1 | Only `applyUpgrade()` — can self-listen for `UPGRADE_PURCHASED` |
| **tutorialSystem** | 2 | Fire-and-forget commands; can self-manage via `GAME_STATE_CHANGE` + `PERSISTENCE_LOADED` |
| **commsSystem** | 7 | Lifecycle (start/stop) maps to `GAME_STATE_CHANGE`; `addMessage` → `COMMS_MESSAGE`; already self-resets via `GAME_RESET` |
| **inputManager** | 4 | Arm pilot exit — can self-manage via `ARM_RETURNED` / `ARM_EXPENDED` listeners |

### MEDIUM (7 refs) — New events or bidirectional communication

| Ref | Call Sites | Challenge |
|-----|-----------|-----------|
| **hud** | 12 | `show()`/`hide()` → `GAME_STATE_CHANGE`; other methods → existing/new events. Volume is high but pattern is uniform |
| **subsystemEvents** | 2 | Save/load orchestration — needs `SAVE_REQUESTED` / `PERSISTENCE_LOADED` events |
| **debrisWireframe** | 8 | `setTarget()` → `TARGET_SELECTED`/`TARGET_CLEARED`; `hasAssessedTarget()` → sync query needs cached flag |
| **targetSelector** | 8 | `setTarget()` → events; `getActiveTarget()` → sync query, but all callers could access TargetSelector's singleton directly or receive target in event payloads |
| **kesslerSystem** | 5 | Shield absorption logic → KesslerSystem self-manages, emits `SHIELD_ABSORBED` or lets collision through |
| **briefingScreen** | 1 | Single call but needs data from debrisField + player for payload |
| **trawlManager** | 5 | Auto-start → self-manage via `GAME_STATE_CHANGE`; toggle → self-manage via `TRAWL_START` with debrisField access |

### HARD (4 refs) — Deep refactoring needed

| Ref | Call Sites | Challenge |
|-----|-----------|-----------|
| **shopScreen** | 8 | Iterator pattern (`forEachPurchasedUpgrade`), serialize/restore, `_hasUpgrade()` helper |
| **resourceSystem** | 10 | Multiple replenish paths in ARM_RETURNED salvage handler, serialize, restore, upgrade |
| **player** | 5 | Direct orbit property mutation, passed as argument to other systems, upgrade routing |
| **armManager** | 9 | `arms.find()` state queries in scoring paths, deployArm, deployTrawl, upgrade routing |

### KEEP (2 refs) — Core orchestration

| Ref | Call Sites | Justification |
|-----|-----------|---------------|
| **cameraSystem** | 8 | Deep read/write interleaving with game logic. Camera transitions ARE game flow orchestration (cinematic holds, arm pilot detection, lock targets). Decoupling would split orchestration logic across camera+GFM with no net simplification. |
| **debrisField** | 9 | Core data store queried synchronously across many handlers. Every debris lookup feeds into immediate scoring/removal logic. Event-based queries would add latency and complexity with no benefit — debrisField IS the model that GFM operates on. |

---

## EASY Refs — Detailed Plans

### E1. sensorSystem → Self-listen for UPGRADE_PURCHASED

**Current** ([`GameFlowManager.js:1109`](js/systems/GameFlowManager.js:1109)):
```js
// In applyUpgradeEffect():
case 'sensorRange':
case 'detectUntracked':
case 'scanRange':
case 'salvageScan':
  if (sensorSystem) sensorSystem.applyUpgrade(data);
  break;
```

**After** — SensorSystem self-manages:
```js
// In SensorSystem constructor or init():
eventBus.on(Events.UPGRADE_PURCHASED, (data) => {
  const SENSOR_EFFECTS = new Set(['sensorRange', 'detectUntracked', 'scanRange', 'salvageScan']);
  if (SENSOR_EFFECTS.has(data.effect)) {
    this.applyUpgrade(data);
  }
});
```

**GFM change** — Remove case block from [`applyUpgradeEffect()`](js/systems/GameFlowManager.js:1109):
```js
// DELETE these lines:
case 'sensorRange':
case 'detectUntracked':
case 'scanRange':
case 'salvageScan':
  if (sensorSystem) sensorSystem.applyUpgrade(data);
  break;
```

**Events needed:** None — `UPGRADE_PURCHASED` already exists
**Files changed:** [`SensorSystem.js`](js/systems/SensorSystem.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js)
**Estimated LOC:** +8 / −5 = net +3

---

### E2. tutorialSystem → Self-manage via GAME_STATE_CHANGE

**Current** ([`GameFlowManager.js:139`](js/systems/GameFlowManager.js:139), [`GameFlowManager.js:295`](js/systems/GameFlowManager.js:295)):
```js
// transitionToState(ORBITAL_VIEW):
if (this._refs.tutorialSystem && this._refs.tutorialSystem.active
    && this._refs.tutorialSystem.stage === TutorialStage.INTRO) {
  this._refs.tutorialSystem.advanceTo(TutorialStage.LOOK_AROUND);
}

// MENU_CONTINUE handler:
if (this._refs.tutorialSystem) {
  this._refs.tutorialSystem.skip();
}
```

**After** — TutorialSystem self-manages:
```js
// In TutorialSystem constructor/init():
eventBus.on(Events.GAME_STATE_CHANGE, ({ from, to }) => {
  if (to === 'ORBITAL_VIEW' && this.active && this.stage === TutorialStage.INTRO) {
    this.advanceTo(TutorialStage.LOOK_AROUND);
  }
});

eventBus.on(Events.PERSISTENCE_LOADED, () => {
  // Veteran player loading a save — skip tutorial
  this.skip();
});
```

**New event needed:** `PERSISTENCE_LOADED` — emitted by GFM in `MENU_CONTINUE` after successful save restore. (Or reuse the existing `PERSISTENCE_LOADED` constant already in [`Events.js`](js/core/Events.js) — it exists but isn't emitted yet.)

**GFM change:**
1. Remove tutorial block from [`transitionToState(ORBITAL_VIEW)`](js/systems/GameFlowManager.js:139)
2. Remove `tutorialSystem.skip()` from [`MENU_CONTINUE`](js/systems/GameFlowManager.js:295)
3. Add `eventBus.emit(Events.PERSISTENCE_LOADED)` after save restore in MENU_CONTINUE

**Files changed:** [`TutorialSystem.js`](js/systems/TutorialSystem.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`Events.js`](js/core/Events.js) (if PERSISTENCE_LOADED not already emitted)
**Estimated LOC:** +12 / −8 = net +4

---

### E3. commsSystem → Self-manage lifecycle via GAME_STATE_CHANGE

**Current** — 7 call sites across [`transitionToState()`](js/systems/GameFlowManager.js:120), [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:392), [`ARM_RETURNED`](js/systems/GameFlowManager.js:665), [`COMMS_SEND`](js/systems/GameFlowManager.js:557).

**After** — CommsSystem self-manages lifecycle:
```js
// In CommsSystem init():
eventBus.on(Events.GAME_STATE_CHANGE, ({ from, to }) => {
  const ACTIVE_STATES = new Set(['ORBITAL_VIEW', 'APPROACH', 'INTERACTION']);
  if (ACTIVE_STATES.has(to) && !this._active) {
    this.start();
  } else if (!ACTIVE_STATES.has(to) && this._active) {
    this.stop();
  }
});

// Already self-resets via GAME_RESET ✓
```

**For COMMS_SEND forwarding** — CommsSystem listens directly:
```js
// In CommsSystem init():
eventBus.on(Events.COMMS_SEND, (data) => {
  if (data.source && data.text) {
    const pri = data.priority === 'WARNING' ? 'WARNING'
              : data.priority === 'CRITICAL' ? 'CRITICAL' : 'INFO';
    this.addMessage(pri, data.source, data.text);
  }
});
```

**For ARM_RETURNED direct `addMessage`** — Replace with event:
```js
// Before (GFM):
if (commsSystem) {
  commsSystem.addMessage('INFO', armLabel, 'Delivery complete...');
}
// After (GFM):
eventBus.emit(Events.COMMS_MESSAGE, {
  text: `${armLabel}: Delivery complete — debris secured for deorbit`,
  priority: 'info',
});
```

**`GAMEOVER_CONTINUE` reset** — This path does a partial reset (not full `GAME_RESET`). The `commsSystem.reset()` call clears queued messages and resets state, while `stop()` only pauses processing. Solution: make CommsSystem's `stop()` also clear stale messages (merge reset into stop), or detect the GAME_OVER → SHOP transition in the GAME_STATE_CHANGE listener and call `this.reset()` instead of `this.stop()`:

```js
eventBus.on(Events.GAME_STATE_CHANGE, ({ from, to }) => {
  const ACTIVE_STATES = new Set(['ORBITAL_VIEW', 'APPROACH', 'INTERACTION']);
  if (ACTIVE_STATES.has(to) && !this._active) {
    this.start();
  } else if (!ACTIVE_STATES.has(to) && this._active) {
    // Full reset when leaving gameplay via GAME_OVER continue path
    if (from === 'GAME_OVER') this.reset();
    else this.stop();
  }
});
```

**Events needed:** None new — uses `GAME_STATE_CHANGE`, `COMMS_SEND`, `COMMS_MESSAGE`, `GAME_RESET`
**Files changed:** [`CommsSystem.js`](js/systems/CommsSystem.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js)
**Estimated LOC:** +22 / −15 = net +7

---

### E4. inputManager → Self-manage arm pilot exit

**Current** ([`GameFlowManager.js:612`](js/systems/GameFlowManager.js:612), [`GameFlowManager.js:816`](js/systems/GameFlowManager.js:816)):
```js
// ARM_RETURNED + ARM_EXPENDED handlers:
if (inputManager.isArmPilotMode() && cameraSystem && cameraSystem.getPilotedArm()?.id === data.armId) {
  inputManager.setArmPilotMode(false);
  const pilotedArm = cameraSystem.getPilotedArm();
  if (pilotedArm && pilotedArm.disableManual) pilotedArm.disableManual();
  cameraSystem.clearPilotArm();
}
```

**After** — InputManager self-manages exit:
```js
// In InputManager init():
const handleArmExit = (data) => {
  if (this.isArmPilotMode() && this._cameraSystem?.getPilotedArm()?.id === data.armId) {
    this.setArmPilotMode(false);
    const pilotedArm = this._cameraSystem.getPilotedArm();
    if (pilotedArm?.disableManual) pilotedArm.disableManual();
    this._cameraSystem.clearPilotArm();
  }
};
eventBus.on(Events.ARM_RETURNED, handleArmExit);
eventBus.on(Events.ARM_EXPENDED, (data) => {
  const wasThisArm = this.isArmPilotMode()
    && this._cameraSystem?.getPilotedArm()?.id === data.armId;
  handleArmExit(data);
  if (wasThisArm) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'ARM PILOT disengaged — arm expended',
      priority: 'warning',
    });
  }
});
```

**Note:** InputManager already has a direct ref to cameraSystem for its own purposes. This moves the arm-pilot-exit logic to InputManager where it belongs (input mode management). No new refs needed — InputManager already has cameraSystem.

**Events needed:** None new
**Files changed:** [`InputManager.js`](js/systems/InputManager.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js)
**Estimated LOC:** +18 / −16 = net +2

---

## MEDIUM Refs — Detailed Plans

### M1. hud → Self-manage visibility via GAME_STATE_CHANGE

**Pattern:** HUD joins the same pattern as MenuScreen, GameOverScreen, etc. — already proven in the first decoupling pass.

**After** — HUD self-manages:
```js
// In HUD constructor/init():
const SHOW_STATES = new Set(['ORBITAL_VIEW', 'APPROACH', 'INTERACTION']);
const HIDE_STATES = new Set(['MENU', 'BRIEFING', 'SHOP', 'GAME_OVER', 'WIN']);

eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
  if (SHOW_STATES.has(to)) this.show();
  else if (HIDE_STATES.has(to)) this.hide();
});

eventBus.on(Events.VIEW_CONFIG_CHANGE, (config) => {
  this.setViewConfig(config);
});

eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
  this.setSelectedTarget(data.id);
});

eventBus.on(Events.PAUSE_RESUME, () => this.hidePause());
eventBus.on(Events.PAUSE_MENU, () => this.hidePause());
```

**GFM changes:**
- Remove all `hud.hide()` / `hud.show()` from [`transitionToState()`](js/systems/GameFlowManager.js:119)
- Remove `hud.setViewConfig()` from [`applyViewConfig()`](js/systems/GameFlowManager.js:78) (VIEW_CONFIG_CHANGE already emitted)
- Remove `hud.setSelectedTarget()` from [`HUD_TARGET_CLICK`](js/systems/GameFlowManager.js:421) handler
- Remove `hud.hidePause()` from [`PAUSE_RESUME`](js/systems/GameFlowManager.js:1011) / [`PAUSE_MENU`](js/systems/GameFlowManager.js:1016) handlers

**Events needed:** None new — all events already exist
**Files changed:** [`HUD.js`](js/ui/HUD.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js)
**Estimated LOC:** +18 / −20 = net −2
**Risk:** LOW — exact same pattern as first 6 decouplings

---

### M2. subsystemEvents → Save/load via events

**Current:**
```js
// MENU_CONTINUE:
if (save.subsystemEvents && this._refs.subsystemEvents) {
  this._refs.subsystemEvents.restore(save.subsystemEvents);
}
// saveGame():
subsystemEvents: this._refs.subsystemEvents ? this._refs.subsystemEvents.getState() : null,
```

**After** — SubsystemEvents self-manages persistence:
```js
// In SubsystemEvents init():
eventBus.on(Events.PERSISTENCE_LOADED, (save) => {
  if (save.subsystemEvents) this.restore(save.subsystemEvents);
});

// Provide save data when requested
eventBus.on(Events.SAVE_GATHER, (bag) => {
  bag.subsystemEvents = this.getState();
});
```

**New events needed:**
- `SAVE_GATHER` — `{ /* mutable bag object */ }` — emitted by GFM's `saveGame()` to collect serializable state from all systems. Each system appends its data to the bag.

**GFM changes:**
```js
// saveGame() — before building save object:
const saveBag = {};
eventBus.emit(Events.SAVE_GATHER, saveBag);
// Then include saveBag.subsystemEvents in the persistence payload
```

**Events needed:** 1 new (`SAVE_GATHER`), reuse `PERSISTENCE_LOADED`
**Files changed:** [`SubsystemEvents.js`](js/systems/SubsystemEvents.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`Events.js`](js/core/Events.js)
**Estimated LOC:** +15 / −5 = net +10
**Risk:** LOW — but introduces the `SAVE_GATHER` mutable-bag pattern which is a minor architectural decision

---

### M3. debrisWireframe → Self-manage target via TARGET_SELECTED + cached assessment flag

**Challenge:** `hasAssessedTarget()` is a synchronous boolean query used in scoring. The wireframe already knows this state — we just need GFM to access it differently.

**After:**
```js
// In DebrisWireframe init():
eventBus.on(Events.TARGET_SELECTED, (data) => {
  this.setTarget(data.debris);
});
eventBus.on(Events.TARGET_CLEARED, () => {
  this.setTarget(null);
});
eventBus.on(Events.GAME_RESET, () => {
  this.setTarget(null);
});
```

**For `hasAssessedTarget()` sync query** — Emit assessment state when it changes:
```js
// In DebrisWireframe (when assessment completes):
eventBus.emit(Events.TARGET_ASSESSED, { assessed: true });
// And GFM caches it:
this._targetAssessed = false;
eventBus.on(Events.TARGET_ASSESSED, (data) => { this._targetAssessed = data.assessed; });
eventBus.on(Events.TARGET_SELECTED, () => { this._targetAssessed = false; });
```

Alternatively, the simpler approach: **keep debrisWireframe ref ONLY for `hasAssessedTarget()`** and use events for everything else. This reduces coupling from 8 call sites to 1 sync query.

**New events needed:**
- `TARGET_ASSESSED` — `{ assessed: boolean }` — emitted by DebrisWireframe when analysis completes

**Current `TARGET_SELECTED`/`TARGET_CLEARED` already exist** in [`Events.js`](js/core/Events.js)

**Files changed:** [`DebrisWireframe.js`](js/ui/DebrisWireframe.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`Events.js`](js/core/Events.js)
**Estimated LOC:** +20 / −12 = net +8
**Risk:** MEDIUM — the cached `_targetAssessed` flag must stay in sync. Race conditions unlikely since it's single-threaded.

---

### M4. targetSelector → Self-manage target via events + singleton access for reads

**Challenge:** `setTarget()` is fire-and-forget (easy to event-ify). `getActiveTarget()` is a sync query used in 4 places.

**After:**
```js
// TargetSelector already emits TARGET_SELECTED / TARGET_CLEARED ✓
// So GFM just stops calling setTarget() directly and emits events instead.

// For BRIEFING_COMMENCE:
eventBus.emit(Events.TARGET_SELECTED, { debris });
// For HUD_TARGET_CLICK:
eventBus.emit(Events.TARGET_SELECTED, { debris });
// For resetGame/GAMEOVER_CONTINUE:
eventBus.emit(Events.TARGET_CLEARED);
```

**For `getActiveTarget()` reads:** TargetSelector is already a singleton-style module. The simplest approach is: **GFM replaces the `targetSelector` ref with a direct `import`** (singleton), not a `_refs` entry. This removes it from the god-object pattern while keeping direct access for sync queries. The `setTarget()` calls remain direct — TargetSelector emits `TARGET_SELECTED` / `TARGET_CLEARED` for other consumers.

```js
// GameFlowManager.js — top-level import (replaces _refs.targetSelector):
import { targetSelector } from './TargetSelector.js';

// Then use targetSelector.setTarget() and targetSelector.getActiveTarget() directly
// No need for event-based indirection — this is a singleton import, not a _refs entry
```

This avoids circular emit issues and is the lowest-risk approach for refs that need sync query access.

**Events needed:** None new — TARGET_SELECTED/TARGET_CLEARED already exist
**Files changed:** [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`TargetSelector.js`](js/systems/TargetSelector.js) (minor)
**Estimated LOC:** +10 / −8 = net +2
**Risk:** LOW — singleton import is the simplest resolution for sync query refs

---

### M5. kesslerSystem → Self-manage shield absorption

**Current** — GFM checks `kesslerSystem.shieldHits` in 3 collision handlers and decides whether to absorb or game-over.

**After** — KesslerSystem intercepts collision events and self-manages absorption:
```js
// In KesslerSystem init():
const handleCollision = (eventName, data) => {
  if (!gameState.isGameplay()) return;
  if (this.shieldHits > 0) {
    this.shieldHits--;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `⚡ WHIPPLE SHIELD absorbed — ${this.shieldHits} hits remaining`,
      priority: 'warning',
    });
    audioSystem.playWarning(0.5);
    eventBus.emit(Events.SHIELD_ABSORBED, { remainingHits: this.shieldHits });
    // Don't re-emit — the collision is absorbed
  } else {
    // Pass through to game-over
    eventBus.emit(Events.COLLISION_GAME_OVER, { cause: data?.type || 'kessler' });
  }
};

eventBus.on(Events.GAME_KESSLER, (data) => handleCollision('kessler', data));
eventBus.on(Events.GAME_COLLISION, (data) => {
  if (data.type === 'activeSatellite') handleCollision('collision', data);
});
eventBus.on(Events.ACTIVE_SAT_COLLISION, (data) => handleCollision('collision', data));
```

**GFM change** — Replace 3 collision handlers with single game-over listener:
```js
eventBus.on(Events.COLLISION_GAME_OVER, (data) => {
  if (gameState.isGameplay()) {
    this.transitionToState(GameStates.GAME_OVER, data.cause);
  }
});
// DELETE the GAME_KESSLER, GAME_COLLISION, ACTIVE_SAT_COLLISION handlers
```

**For `GAMEOVER_CONTINUE` reset** — KesslerSystem already self-resets via `GAME_RESET`. The `kesslerSystem.reset()` call in `GAMEOVER_CONTINUE` is redundant if we emit `GAME_RESET` in that path (or add separate listener).

**For `applyUpgrade`** — Same pattern as sensorSystem (E1): KesslerSystem self-listens for `UPGRADE_PURCHASED`.

**New events needed:**
- `SHIELD_ABSORBED` — `{ remainingHits }` — informational, for HUD/comms
- `COLLISION_GAME_OVER` — `{ cause }` — shield failed, proceed to game over

**Files changed:** [`KesslerSystem.js`](js/systems/KesslerSystem.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`Events.js`](js/core/Events.js)
**Estimated LOC:** +30 / −35 = net −5
**Risk:** MEDIUM — collision handling is critical-path. Must ensure no double-handling or missed events. Test with all 3 collision types.

---

### M6. briefingScreen → Receive data via GAME_STATE_CHANGE payload

**Current** ([`GameFlowManager.js:127`](js/systems/GameFlowManager.js:127)):
```js
case GameStates.BRIEFING: {
  hud.hide();
  const targets = debrisField.getTargetList(player.getOrbitalElements());
  briefingScreen.setTargets(targets, player.getOrbitalElements());
  break;
}
```

**After** — BriefingScreen receives data via event:
```js
// GFM transitionToState(BRIEFING):
case GameStates.BRIEFING: {
  // Gather briefing data (still uses debrisField + player — KEEP refs)
  const orbitalElements = player.getOrbitalElements();
  const targets = debrisField.getTargetList(orbitalElements);
  eventBus.emit(Events.BRIEFING_DATA, { targets, orbitalElements });
  break;
}

// BriefingScreen init():
eventBus.on(Events.BRIEFING_DATA, ({ targets, orbitalElements }) => {
  this.setTargets(targets, orbitalElements);
});
// BriefingScreen already self-manages visibility via GAME_STATE_CHANGE ✓
```

**New events needed:**
- `BRIEFING_DATA` — `{ targets, orbitalElements }` — briefing payload

**Files changed:** [`BriefingScreen.js`](js/ui/BriefingScreen.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`Events.js`](js/core/Events.js)
**Estimated LOC:** +10 / −3 = net +7
**Risk:** LOW — straightforward data-via-event pattern

---

### M7. trawlManager → Self-manage auto-start + toggle

**Current** — GFM handles auto-start in ORBITAL_VIEW transition and toggle in TRAWL_START handler.

**After** — TrawlManager self-manages:
```js
// TrawlManager already has access to DebrisField or can receive clusters via event

// Auto-start on ORBITAL_VIEW:
eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
  if (to === 'ORBITAL_VIEW' && !this.active) {
    // Self-gather cluster data
    eventBus.emit(Events.SENSOR_QUERY_TARGETS); // or query debrisField directly
    // Alternatively, receive cluster data via a TRAWL_AUTO_START event from GFM
  }
});

// Toggle via TRAWL_START:
eventBus.on(Events.TRAWL_START, (data) => {
  if (data?.cluster || data?.armId) return; // not a keyboard toggle
  if (this.active) {
    const report = this.endTrawl();
    eventBus.emit(Events.TRAWL_END, report);
  } else {
    // Gather clusters and start
    // Needs debrisField access — import singleton or receive via event
  }
});
```

**Challenge:** TrawlManager needs `debrisField` and `player` to start a trawl. Two approaches:
1. **TrawlManager imports debrisField/player singletons directly** — simplest, but adds its own coupling
2. **GFM emits `TRAWL_AUTO_START` with cluster + player data** — keeps data flow explicit

Recommend approach (2) for the auto-start, and singleton import for the keyboard toggle (since TrawlManager is a system that naturally needs field data).

**New events needed:**
- `TRAWL_AUTO_START` — `{ cluster, player }` — emitted by GFM for auto-trawl on ORBITAL_VIEW

**Files changed:** [`TrawlManager.js`](js/systems/TrawlManager.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`Events.js`](js/core/Events.js)
**Estimated LOC:** +25 / −20 = net +5
**Risk:** MEDIUM — trawl auto-start has error handling and state checks that must transfer cleanly

---

## HARD Refs — Analysis

### H1. shopScreen (8 call sites)

**Why HARD:**
- **Iterator pattern:** `forEachPurchasedUpgrade(callback)` is called in [`MENU_CONTINUE`](js/systems/GameFlowManager.js:283), [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:395), and [`_hasUpgrade()`](js/systems/GameFlowManager.js:1181). The iterator feeds into `applyUpgradeEffect()` which dispatches to 5+ other systems.
- **Serialization:** `getSerializableUpgrades()` and `getContractMass()` feed into [`saveGame()`](js/systems/GameFlowManager.js:1141) — sync queries.
- **Restore:** `restorePurchases()` and `setContractMass()` in [`MENU_CONTINUE`](js/systems/GameFlowManager.js:261).
- **`_hasUpgrade()`:** Called during ARM_RETURNED salvage processing to check for `refinery_arm` and `hazmat_handler` upgrades — sync boolean query at runtime.

**Future approach:** Extract an `UpgradeManager` service that:
1. Owns the purchased-upgrade registry
2. Emits `UPGRADES_RESTORED` after save load (systems self-apply)
3. Provides `hasUpgrade(id)` as a public API (singleton import, not _refs)
4. Participates in `SAVE_GATHER` pattern for serialization

**Estimated effort:** 80–120 LOC across 4–5 files

---

### H2. resourceSystem (10 call sites)

**Why HARD:**
- **Salvage processing:** The [`ARM_RETURNED`](js/systems/GameFlowManager.js:670) handler calls 5 different ResourceSystem methods (`replenish('xenon')`, `replenishPanelHealth()`, `replenish('battery')`, `replenish('coldGas')`, `addLithium()`) based on salvage contents. This is a domain-specific dispatch that belongs in a `SalvageProcessor` or in ResourceSystem itself.
- **Save/load:** `serialize()` + `restore()` — fits the `SAVE_GATHER` / `PERSISTENCE_LOADED` pattern.
- **Reset paths:** Called in both `resetGame()` and `GAMEOVER_CONTINUE` — different reset scopes.
- **Upgrade routing:** `applyUpgrade()` for resource pool upgrades — same pattern as sensorSystem (E1).

**Future approach:**
1. ResourceSystem self-listens for `UPGRADE_PURCHASED` (same as E1)
2. ResourceSystem self-resets via `GAME_RESET` (partially done — needs `GAMEOVER_CONTINUE` path)
3. Extract salvage processing into a `SalvageProcessor` that listens for `ARM_RETURNED` and calls ResourceSystem directly
4. Save/load via `SAVE_GATHER` + `PERSISTENCE_LOADED`

**Estimated effort:** 100–150 LOC, requires new `SalvageProcessor` service

---

### H3. player (5 call sites)

**Why HARD:**
- **Direct orbit mutation:** `player.orbit.semiMajorAxis = Constants.EARTH_RADIUS + Constants.START_ALTITUDE` and `player.orbit.trueAnomaly = 0` in [`resetGame()`](js/systems/GameFlowManager.js:1043) and [`GAMEOVER_CONTINUE`](js/systems/GameFlowManager.js:374). This is setting physics state directly.
- **Passed as argument:** `trawlManager.startTrawl(nearest, player)` — player entity itself is needed by trawl.
- **Read state:** `player.getOrbitalElements()` — sync read for briefing data.
- **Upgrade routing:** `player.applyUpgrade(data)` — propulsion upgrades.

**Future approach:**
1. Player self-resets orbit via `GAME_RESET` event listener
2. Player self-applies upgrades via `UPGRADE_PURCHASED` listener
3. `getOrbitalElements()` query: Emit telemetry on demand, or import PlayerSatellite singleton
4. Trawl start: TrawlManager gets player ref at its own init time (not through GFM)

**Estimated effort:** 40–60 LOC but risk is higher (physics state mutation)

---

### H4. armManager (9 call sites)

**Why HARD:**
- **State queries:** `armManager.arms.find(a => a.id === data.armId)` used 3 times in [`ARM_DEPLOYED`](js/systems/GameFlowManager.js:598), [`ARM_RETURNED`](js/systems/GameFlowManager.js:624), [`ARM_DEORBIT`](js/systems/GameFlowManager.js:842) for scoring flags, fuel tracking, and ΔV calculations. These queries are deeply interleaved with scoring logic.
- **Deploy calls:** `deployArm(target)` and `deployTrawl()` — could be events.
- **Reset:** `armManager.reset()` — could use `GAME_RESET`.
- **Upgrade routing:** `armManager.applyUpgrade(data)` — same pattern as E1.

**Future approach:**
1. Event payloads enriched: `ARM_RETURNED`, `ARM_DEPLOYED`, `ARM_DEORBIT` events include arm state data (fuel, type, manualCapture, isDetached) so GFM doesn't need to query armManager
2. Deploy → `ARM_DEPLOY` event (already partially implemented)
3. Self-reset via `GAME_RESET`
4. Self-upgrade via `UPGRADE_PURCHASED`

**Estimated effort:** 60–80 LOC — requires enriching 3 event payloads in ArmManager/ArmUnit

---

## KEEP Refs — Justification

### K1. cameraSystem (8 locations, ~16 individual accesses)

**Why KEEP:** Camera orchestration IS game flow management. Examples:
- [`ARM_DEPLOYED`](js/systems/GameFlowManager.js:577): Read `currentView`, conditionally `setLockTarget()` + `setView(TARGET_LOCK)` based on active target orbit data — requires multi-system coordination
- [`ARM_RETURNED`](js/systems/GameFlowManager.js:612): Check `getPilotedArm()` to auto-exit arm pilot mode — interleaved with inputManager + arm state
- [`transitionToState(APPROACH)`](js/systems/GameFlowManager.js:161): Compute target position from orbital elements, feed to `setLockTarget()` — requires orbital mechanics + camera API
- Cinematic camera holds with `setTimeout` — timing-dependent orchestration

Decoupling camera would split orchestration logic across CameraSystem + GFM with no net simplification — it would just move complexity from one file to two.

**Future note:** If CameraSystem ever gets an `AutoCinematicDirector` subsystem, the ARM_DEPLOYED/ARM_RETURNED camera logic could move there. But that's a feature, not a refactor.

### K2. debrisField (9 call sites)

**Why KEEP:** DebrisField is the core game entity store. GFM needs synchronous access to:
- `getDebrisById()` — look up debris for targeting, scoring, removal (4 call sites)
- `removeDebris()` — mutate game state after capture/deorbit (2 call sites)
- `getTargetList()` — generate briefing data (1 call site)
- `getDebrisClusters()` — feed trawl system (2 call sites)

Every query directly feeds into immediate game logic (scoring decisions, state transitions, UI updates). Async event patterns would add complexity with no benefit. DebrisField is the canonical data model — direct access is correct.

---

## Execution Plan

### Batch 1 — EASY (4 refs, ~14 net LOC, LOW risk)

Execute first. Each is independent — can be done in any order or parallel.

| Step | Ref | Events Needed | Est. LOC | Files |
|------|-----|---------------|----------|-------|
| 1a | `sensorSystem` | None | +3 | SensorSystem.js, GameFlowManager.js |
| 1b | `tutorialSystem` | Emit PERSISTENCE_LOADED | +4 | TutorialSystem.js, GameFlowManager.js |
| 1c | `commsSystem` | None | +5 | CommsSystem.js, GameFlowManager.js |
| 1d | `inputManager` | None | +2 | InputManager.js, GameFlowManager.js |

**Test after batch:** Run all 225 tests + manual playtest collision/comms/tutorial/sensor flows.

**Result:** _refs reduced from 17 → 13.

---

### Batch 2 — MEDIUM Low-Risk (3 refs, ~8 net LOC, LOW-MEDIUM risk)

| Step | Ref | Events Needed | Est. LOC | Files |
|------|-----|---------------|----------|-------|
| 2a | `hud` | None | −2 | HUD.js, GameFlowManager.js |
| 2b | `subsystemEvents` | SAVE_GATHER (new) | +10 | SubsystemEvents.js, GameFlowManager.js, Events.js |
| 2c | `briefingScreen` | BRIEFING_DATA (new) | +7 | BriefingScreen.js, GameFlowManager.js, Events.js |

**Test after batch:** Run all tests + manual playtest HUD visibility across all states, save/load, briefing screen data.

**Result:** _refs reduced from 13 → 10.

---

### Batch 3 — MEDIUM Higher-Risk (4 refs, ~10 net LOC, MEDIUM risk)

These involve sync query replacements or logic restructuring.

| Step | Ref | Events Needed | Est. LOC | Files |
|------|-----|---------------|----------|-------|
| 3a | `debrisWireframe` | TARGET_ASSESSED (new) | +8 | DebrisWireframe.js, GameFlowManager.js, Events.js |
| 3b | `targetSelector` | None (singleton import) | +2 | GameFlowManager.js |
| 3c | `kesslerSystem` | SHIELD_ABSORBED, COLLISION_GAME_OVER (new) | −5 | KesslerSystem.js, GameFlowManager.js, Events.js |
| 3d | `trawlManager` | TRAWL_AUTO_START (new) | +5 | TrawlManager.js, GameFlowManager.js, Events.js |

**Test after batch:** Run all tests + manual playtest: target selection, wireframe assessment scoring, all 3 collision types with shield, trawl auto-start and toggle.

**Result:** _refs reduced from 10 → 6.

---

### Batch 4 — HARD (4 refs, future work)

Not recommended for immediate execution. Requires architectural decisions:

| Step | Ref | Prerequisite | Est. LOC |
|------|-----|-------------|----------|
| 4a | `player` | GAME_RESET self-orbit-reset; UPGRADE_PURCHASED self-listen | 40–60 |
| 4b | `armManager` | Enrich ARM_* event payloads; GAME_RESET self-reset | 60–80 |
| 4c | `resourceSystem` | Extract SalvageProcessor; SAVE_GATHER pattern | 100–150 |
| 4d | `shopScreen` | Extract UpgradeManager service | 80–120 |

**Recommended trigger for Batch 4:** When any of these systems needs refactoring for a new feature, include the decoupling as part of that work.

---

## Summary

| Metric | Value |
|--------|-------|
| Total refs analyzed | 17 |
| EASY (Batch 1) | 4 refs → 13 remaining |
| MEDIUM (Batch 2+3) | 7 refs → 6 remaining |
| HARD (Batch 4, future) | 4 refs |
| KEEP (permanent) | 2 refs (cameraSystem, debrisField) |
| New events needed | 6 (PERSISTENCE_LOADED emit, SAVE_GATHER, BRIEFING_DATA, TARGET_ASSESSED, SHIELD_ABSORBED, COLLISION_GAME_OVER) |
| Net LOC change (Batch 1–3) | ~+32 (more listeners, fewer direct calls) |
| Files touched (Batch 1–3) | ~15 |

**End state after all 3 batches:** GameFlowManager._refs holds 6 entries:
`{ player, debrisField, armManager, cameraSystem, shopScreen, resourceSystem }`

These 6 represent genuine orchestration dependencies — the core game entities and systems that GameFlowManager coordinates as its primary responsibility.
