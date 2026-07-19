/**
 * Events.js — Centralized event name constants
 * Prevents silent failures from event name typos.
 * 
 * Usage (gradual migration):
 *   import { Events } from '../core/Events.js';
 *   eventBus.emit(Events.ARM_DEPLOYED, { armId, targetId });
 *   eventBus.on(Events.ARM_DEPLOYED, handler);
 *
 * @module core/Events
 */

export const Events = {
  // === ARM LIFECYCLE ===
  ARM_DEPLOYED:       'arm:deployed',
  ARM_SPRING_FIRED:   'arm:springFired',  // { armId, type, speed } — crossbow spring released, daughter actually departs (1.5 s after ARM_DEPLOYED)
  ARM_STATE_CHANGE:   'arm:stateChange',
  ARM_CAPTURED:       'arm:captured',
  ARM_RETURNED:       'arm:returned',
  ARM_DOCKED:         'arm:docked',
  ARM_RECALLED:       'arm:recalled',
  ARM_CAPTURE_FAILED: 'arm:captureFailed',
  ARM_EXPENDED:       'arm:expended',
  ARM_DEPLOY_TO:      'arm:deployTo',
  ARM_RECALL_ONE:     'arm:recallOne',
  ARM_RECALL_ALL:     'arm:recallAll',
  // ARM_DEPLOY / ARM_FISH removed 2026-06-12 (UX-11 #9): their only emitters
  // were the RadialMenu + CommsPanel.executeCommsCommand, both deleted.
  // preferType deploy survives via ARM_DEPLOY_TO (TargetSelector); the orphaned
  // fishing/cast-all verb (deployFishing + the FISHING FSM state) was fully
  // deleted in the P1 integrity sweep — reintroducing it is a fresh design.
  ARM_MANUAL_THRUST:  'arm:manualThrust',
  ARM_DEORBIT:        'arm:deorbit',      // One-way sacrifice command (Session 10)
  ARM_REFUELED:       'arm:refueled',     // Arm refueled from salvaged Indium (Session 10)
  ARM_DEORBIT_CMD:    'arm:deorbitCmd',   // Comms menu / D key deorbit command
  ARM_SELECT:         'arm:select',       // Player selected arm by number key 1-6 (Sprint C2)
  ARM_DESELECT:       'arm:deselect',     // Player deselected arm — back to mothership (key 7)
  WEB_SHOT_HIT:       'arm:webShotHit',   // { debrisId, dragMultiplier } — GSL web shot hit debris (Sprint D1)

  // === TARGET SELECTION ===
  TARGET_SELECTED:    'target:selected',
  TARGET_CLEARED:     'target:cleared',
  TARGET_DISCOVERED:  'target:discovered',   // { target } — UX-3 #9 staggered reveal
  /** Selected target crossed INTO net-lock range (≤ NET_LOCK_RANGE_M).
   *  Drives the cyan reticle flip + the in-range-only lock earcon.
   *  Payload: { id, distanceM } */
  TARGET_IN_RANGE:    'target:inRange',
  /** Selected target is OUTSIDE net-lock range (> NET_LOCK_RANGE_M).
   *  Drives the yellow "OUT OF RANGE" reticle state + the range→autopilot
   *  teaching gate. Lock earcon is SUPPRESSED in this state.
   *  Payload: { id, distanceM } */
  TARGET_OUT_OF_RANGE: 'target:outOfRange',

  // === CAMERA ===
  CAMERA_VIEW_CHANGE: 'camera:viewChange',
  VIEW_CONFIG_CHANGE: 'view:configChange',   // { showClosureRate, showNavSphere, ... } — view info-level config
  LAUNCH_CEREMONY_START:    'camera:launchCeremonyStart',    // { arm }
  LAUNCH_CEREMONY_COMPLETE: 'camera:launchCeremonyComplete', // { arm }

  // === GAME STATE ===
  STATE_CHANGE:       'state:change',
  GAME_STATE_CHANGE:  'game:stateChange',     // { from, to, payload } — emitted by GameFlowManager after transition
  GAME_RESET:         'game:reset',            // { } — emitted by GameFlowManager.resetGame()
  GAME_KESSLER:       'game:kesslerEvent',
  GAME_COLLISION:     'game:collision',
  GAME_WIN:           'game:win',

  // === SCORING ===
  SCORE_UPDATE:       'score:update',
  SCORING_AWARD:      'scoring:award',

  // === MISSION (ST-4.C) ===
  /** Emitted when mission number increments (every DEBRIS_PER_MISSION captures).
   *  Payload: { missionNumber: number, profile: object } */
  MISSION_START:      'mission:start',

  // === MISSION MID-FLIGHT EVENTS (ST-4.D) ===
  /** Scanned debris revealed as hydrazine hazard. Payload: { debrisId, type, hazardType } */
  DEBRIS_HAZARD_REVEALED: 'mission:debrisHazardRevealed',
  /** Synergy pair opportunity found. Payload: { synergyName, matchedMetals, missingMetals, bonusPoints, expiresMs } */
  SYNERGY_OPPORTUNITY:    'mission:synergyOpportunity',
  /** Kessler cascade threatening operations. Payload: { fragmentCount } */
  CASCADE_THREAT:         'mission:cascadeThreat',
  /** Severe weather reducing sensor capability. Payload: { type, sensorReduction, duration } */
  WEATHER_MISSION_EFFECT: 'mission:weatherEffect',
  /** Multiple conjunctions in same altitude band. Payload: { alertCount } */
  CLUSTER_CONJUNCTION:    'mission:clusterConjunction',

  // === CH5 ISS CONJUNCTION BOSS (MISSION_ARC §6) ===
  /** Boss engaged: 6 Cosmos-1408 threat frags spawned in the ISS forward track.
   *  Payload: { threatIds: number[], tcaHours: number } */
  ISS_BOSS_STARTED:   'iss:bossStarted',
  /** TCA window closing — final warning. Payload: { tcaRemainingHours, cleared, total } */
  ISS_BOSS_IMMINENT:  'iss:bossImminent',
  /** Player explicitly declines the intercept (lets CSA reboost the station). Payload: {} */
  ISS_BOSS_DECLINE:   'iss:bossDecline',
  /** Boss resolved. Payload: { outcome: 'intercept'|'decline'|'miss', cleared, total } */
  ISS_BOSS_RESOLVED:  'iss:bossResolved',

  // === CH9 STARLINK FRAGMENTATION BOSS (MISSION_ARC §6) ===
  /** Boss engaged: N Starlink frags burst-spawned. Payload: { threatIds: number[], windowMin: number } */
  STARLINK_BOSS_STARTED:  'starlink:bossStarted',
  /** Containment window closing — final warning. Payload: { remainingMin, cleared, total } */
  STARLINK_BOSS_IMMINENT: 'starlink:bossImminent',
  /** Boss resolved. Payload: { outcome: 'contained'|'partial'|'cascade', cleared, total } */
  STARLINK_BOSS_RESOLVED: 'starlink:bossResolved',

  // === DEBRIS ===
  DEBRIS_CLEARED:     'debris:cleared',
  DEBRIS_CAPTURED:    'debris:captured',
  CATCH_PROCESSED:    'catch:processed',   // furnace-transfer complete — { armId, debrisId, type }; owns salvage+scoring
  // Staged furnace breakdown (Item 1, 2026-06-11). Visual-only choreography on the
  // way to CATCH_PROCESSED; gameplay (salvage/score/remove) still keys off the
  // single CATCH_PROCESSED above. Consumed by FurnaceBreakdownVisual + CaptureNetVisual.
  CATCH_BREAKDOWN_START: 'catch:breakdownStart', // { armId, debrisId, chunkCount } — chop begins
  CATCH_BREAKDOWN_CHUNK: 'catch:breakdownChunk', // { armId, debrisId, index, total } — one chunk fed
  NET_CONSUMED:          'net:consumed',         // { armIndex } — fed-in bag draws toward the mother
  DEBRIS_REMOVED:     'debris:removed',
  DEBRIS_KESSLER:     'debris:kesslerEvent',
  DEBRIS_COLLISION:   'debris:collision',

  // === RESOURCES ===
  RESOURCE_CHANGED:   'resource:changed',
  RESOURCE_DEPLETED:  'resource:depleted',
  RESOURCE_CONSUME:   'resource:consume',
  RESOURCE_REPLENISH: 'resource:replenish',
  RESOURCE_UPGRADED:  'resource:upgraded',

  // === SALVAGE (Session 10) ===
  SALVAGE_RECOVERED:  'salvage:recovered',
  SALVAGE_SCAN:       'salvage:scan',

  // === PLAYER ===
  PLAYER_TELEMETRY:   'player:telemetry',
  PLAYER_THRUST_FAILED: 'player:thrustFailed',
  PLAYER_LOW_BATTERY: 'player:lowBattery',
  PLAYER_LOW_XENON:   'player:lowXenon',

  // === COLLISION ===
  COLLISION_WARNING:  'collision:warning',
  COLLISION_EVASION:  'collision:evasion',

  // === INTERACTION ===
  INTERACTION_DATA_CAPTURE: 'interaction:dataCapture',
  INTERACTION_DEORBIT:      'interaction:deorbit',
  INTERACTION_CAPTURE:      'interaction:capture',
  INTERACTION_FRAGMENTATION: 'interaction:fragmentation',

  // === COMMS ===
  /**
   * COMMS_MESSAGE payload:
   *   { text, priority, source, channel? }
   * ST-5.1: Optional `channel` key — one of Constants.COMMS.CHANNELS.
   * If omitted, receiver classifies via source heuristic (default FLAVOR).
   */
  /**
   * STRUT_LABELS_SHOW (Delegation 3, 2026-05-31)
   * Payload: { strutGroups: Array<{pivotGroup, strut, tipNode, azRad}>, durationMs: number }
   * Emitted by PlayerSatellite.highlightStrutsForBeat(); consumed by StrutLabels.
   */
  STRUT_LABELS_SHOW: 'ui:strutLabelsShow',

  COMMS_MESSAGE:      'comms:message',
  /**
   * INSPECTION_TOGGLE (Delegation 1, 2026-05-31).
   * Payload: { subject: 'mother'|'debris', targetId?: number|null }
   * If `subject` is omitted, receivers MUST default to 'mother' for
   * backward compatibility.  The 'debris' subject is reserved for the
   * Delegation 3 daughter-piloted wireframe render path; until that ships,
   * CameraSystem only handles 'mother'.
   */
  INSPECTION_TOGGLE:  'inspection:toggle',
  /**
   * Explicit-boolean hull-outline control for close inspection. Payload:
   * { visible: boolean }. Emitted by the OVERVIEW zoom-driven inspection
   * sub-state (which keeps the camera view as ORBIT, so it can't rely on the
   * INSPECTION CAMERA_VIEW_CHANGE that the bare-I/discrete path uses). Kept
   * separate from INSPECTION_TOGGLE because that event is a toggle, whereas the
   * hull outline needs an idempotent on/off to avoid desync.
   */
  INSPECT_HULL_OUTLINE: 'inspection:hullOutline',
  /**
   * MOTHER_INSPECTION_ENGAGED (2026-06-04 onboarding).
   * Fired ONCE each time the OVERVIEW zoom-driven inspection sub-state ENGAGES
   * for the mothership (i.e. the player pushed in close enough that the hull
   * callouts/overlays became visible). Unlike INSPECTION_TOGGLE this fires only
   * on engage (never on exit) and only for the mother, so onboarding can use it
   * as an unambiguous "the player actually saw the callouts" completion signal.
   * Payload: {}
   */
  MOTHER_INSPECTION_ENGAGED: 'inspection:motherEngaged',
  COMMS_SEND:         'comms:send',
  COMMS_SOLAR_STORM:  'comms:solarStorm',
  COMMS_GEO_STORM:    'comms:geoStorm',

  // === COMMS UI (ST-5.1) ===
  COMMS_FOCUS:            'comms:focus',           // C-tap → expand pane
  // UX-11 #9: COMMS_RADIAL_OPEN/CLOSE removed with the C-hold RadialMenu.
  COMMS_SCROLL_UP:        'comms:scrollUp',        // PageUp → scroll history
  COMMS_SCROLL_DOWN:      'comms:scrollDown',       // PageDown → scroll history
  COMMS_PANEL_RESIZED:    'comms:panelResized',    // { step, height } — pane stepped to a new size (line/normal/large)

  // === CITY LABELS (UX-11 #5) ===
  CITY_LABELS_TOGGLE:     'cityLabels:toggle',     // Shift+C → toggle Earth city labels

  // === LOCALE / LANGUAGE ===
  /** Player changed the menu language / region. Payload: { code, lang } where
   *  `lang` is the full entry from core/Languages.js (flag + start city). A
   *  future i18n layer can subscribe to re-render translated UI strings. */
  LANGUAGE_CHANGED:       'locale:languageChanged',

  // === PAUSE ===
  PAUSE_RESUME:       'pause:resume',
  PAUSE_MENU:         'pause:menu',

  // === MENU / UI ===
  MENU_START:         'menu:start',
  MENU_FAST_START:    'menu:fastStart',
  MENU_CONTINUE:      'menu:continue',
  // Emitted at the START of the menu→sim departure pull-back (before MENU_START/
  // MENU_CONTINUE, which fire at the END). Drives the departure audio pad swell
  // (T10). { event } = the terminal event that will fire.
  MENU_DEPARTURE_START: 'menu:departureStart',
  // Emitted once at ~65% of the departure pull-back (deep-polish-4 T4). Lets the
  // sim unhide the real player ship EARLY — while the receding menu hero still
  // masks it — so the swap at the cut has no visibility pop / first-render hitch.
  MENU_DEPARTURE_REVEAL: 'menu:departureReveal',
  // Emitted per SAFER cold-gas puff during the astronaut jet-off exit
  // (deep-polish-4 T6). Drives a tiny filtered-noise "pfft"; fires only on the
  // full new-game exit (not continue/reduced). noAudio-safe via AudioSystem.
  MENU_EVA_PUFF: 'menu:evaPuff',
  // Emitted when a menu→sim departure begins, announcing the randomly-chosen
  // orientation treatment (deep-polish-4 #5). { mode: 'partial' | 'flyaround' }.
  // main.js fires the power-up cut flash only for 'partial' (the fly-around is
  // orientation-seamless and needs no mask).
  MENU_ORIENT_MODE: 'menu:orientMode',
  BRIEFING_COMMENCE:  'briefing:commence',
  BRIEFING_SKIP:      'briefing:skip',
  SHOP_DEPLOY:        'shop:deploy',
  GAMEOVER_RETRY:     'gameover:retry',
  GAMEOVER_MENU:      'gameover:menu',
  GAMEOVER_CONTINUE:  'gameover:continue',
  HUD_TARGET_CLICK:   'hud:targetClick',
  HUD_GROUP_ACTIVATE: 'hud:groupActivate',   // { group } — directly activate a HUD reveal-group
  // Emitted once per mission when the HUD power-on stagger plays (T7 reset makes
  // it per-mission). Drives the comms-crackle cue (T10).
  HUD_POWER_ON:       'hud:powerOn',
  /**
   * Emitted when a tech library entry unlocks. Consumed by SkillsPane
   * (Discovery Pane) for the "NEW TECH" section. Separate from
   * CODEX_UNLOCKED (which drives the full-screen Tech Library viewer
   * refresh + audio chime) to allow independent evolution of the two
   * surfaces.
   */
  TECH_UNLOCKED:      'tech:unlocked',        // { id, title, shortText, category } — tech entry unlocked (for Discovery Pane)

  // === ACTIVE SATELLITES ===
  ACTIVE_SAT_PROXIMITY: 'activeSat:proximity',
  ACTIVE_SAT_COLLISION: 'activeSat:collision',

  // === SENSOR ===
  SENSOR_UPGRADE:     'sensor:upgrade',
  SENSOR_UPGRADED:    'sensor:upgraded',
  SENSOR_QUERY_TARGETS:    'sensor:queryTargets',
  SENSOR_DETECTED_TARGETS: 'sensor:detectedTargets',

  // === ACTIVE SCAN ===
  SCAN_QUICK:         'scan:quick',              // S key — quick ping scan
  SCAN_WIDE:          'scan:wide',               // W key — wide aperture deep scan
  SCAN_INITIATED:     'scan:initiated',           // { type: 'quick'|'wide' } — scan actually started (for audio/visual feedback)
  SCAN_COMPLETE:      'scan:complete',            // { type: 'quick'|'wide', results: {...} }
  SCAN_REVEALS_SETTLED: 'scan:revealsSettled',    // { revealed: number, scanType: 'quick'|'wide' } — staggered scan reveals finished discovering; scan auto-select fills the pane
  SCAN_DISCOVERY:     'scan:discovery',           // { debrisId, type, mass, salvage?: { hydrazine, metals[] } } — hidden debris found (ST-4.D enriched)

  // === KESSLER ===
  KESSLER_FRAGMENTS_ADDED: 'kessler:fragmentsAdded',
  KESSLER_WARNING:         'kessler:warning',
  KESSLER_CASCADE:         'kessler:cascadeTriggered',
  COLLISION_GAME_OVER:     'collision:gameOver',     // { reason } — KesslerSystem: shields depleted, GFM should game-over

  // === UPGRADES ===
  UPGRADE_PURCHASED:  'upgrade:purchased',
  UPGRADE_V4_TECH:    'upgrade:v4Tech',

  // === POWER ===
  POWER_CHANGED:      'power:changed',
  POWER_BUS_SELECTED: 'power:busSelected',

  // === PERSISTENCE ===
  PERSISTENCE_SAVED:  'persistence:saved',
  PERSISTENCE_LOADED: 'persistence:loaded',
  PERSISTENCE_GATHER: 'persistence:gather',  // { saveData } — systems attach their state before save

  // === CARGO (Phase 2) ===
  CARGO_STORE:         'cargo:store',
  CARGO_UPDATED:       'cargo:updated',
  CARGO_SELL:          'cargo:sell',
  CARGO_FUEL_TRANSFER: 'cargo:fuelTransfer',

  // === FORGE (Phase 3) ===
  FORGE_START:         'forge:start',
  FORGE_PHASE_CHANGE:  'forge:phaseChange',
  FORGE_COMPLETE:      'forge:complete',
  FORGE_CANCEL:        'forge:cancel',
  FORGE_QUEUE_ADD:     'forge:queueAdd',
  FORGE_TOGGLE:        'forge:toggle',

  // === FUEL (Phase 4) ===
  FUEL_CHANGED:        'fuel:changed',        // fuel type switched — { fuelId, name, isp, color }
  FUEL_DEPLETED:       'fuel:depleted',       // current fuel ran out

  // === MARKET & CONTRACT (Phase 5) ===
  CARGO_SELL_ALL:      'cargo:sellAll',
  CONTRACT_CONTRIBUTE: 'contract:contribute',
  CONTRACT_UPDATE:     'contract:update',
  CONTRACT_COMPLETE:   'contract:complete',

  // === TRAWLING & EDT (Phase 6) ===
  TRAWL_START:         'trawl:start',
  TRAWL_CAPTURE:       'trawl:capture',
  TRAWL_END:           'trawl:end',
  /** UX-11 #4: request to cancel an active trawl sweep — { reason } — TrawlManager
   *  ends the sweep and emits TRAWL_SWEEP_COMPLETE so dependent flags self-clear. */
  TRAWL_ABORT:         'trawl:abort',
  TRAWL_TARGET_ENTERING:      'trawl:target_entering',
  TRAWL_TARGET_EXITED:        'trawl:target_exited',
  TRAWL_TARGET_WINDOW_CLOSING: 'trawl:target_window_closing',
  EDT_DEPLOY:          'edt:deploy',
  EDT_RETRACT:         'edt:retract',
  EDT_ATTRACT:         'edt:attract',
  ROUTE_PLAN_UPDATE:   'route:planUpdate',

  // === CLUSTER TRANSFER WINDOW (CP-3) ===
  CLUSTER_WINDOW_IMMINENT: 'cluster:windowImminent',  // T-minus threshold reached (beep/cyan)
  CLUSTER_WINDOW_OPEN:     'cluster:windowOpen',       // optimal departure window open ("burn now")

  // === MISSION COACH BEATS (CP-4 §4 — emitted by the future MissionCoach) ===
  MISSION_BEAT_STARTED:   'mission:beatStarted',   // { skillId, … } a coach beat now owns the screen
  MISSION_BEAT_SATISFIED: 'mission:beatSatisfied', // { skillId } the beat's action was performed

  // === DELTAV TELEMETRY (Phase R9) ===
  DELTAV_UPDATE:       'deltav:update',

  // === CONJUNCTION (Sprint C1) ===
  CONJUNCTION_WARNING: 'conjunction:warning',  // { tier, debrisId, tca, distance, evasionVector }
  CONJUNCTION_CLEAR:   'conjunction:clear',    // alert expired
  /**
   * ST-6.1: Generic conjunction alert for gameplay-level red-lines that are
   * not routine TCA warnings — e.g. attempted arming against an active
   * satellite. Payload shape:
   *   { severity: 'RED'|'YELLOW'|'GREEN', reason: string, targetId?, targetName?, norad? }
   * `reason` values include: 'ACTIVE_SAT_ARMING' (treaty-violation guard).
   */
  CONJUNCTION_ALERT:   'conjunction:alert',

  // === CATALOG (ST-6.1: offline data catalogue) ===
  /** Fired once when CatalogLoader finishes initial META + file fetches.
   *  Payload: { ready: boolean, counts: { debris, active_sats, launches, weather_events, ground_stations, constellations }, version }
   *  `ready:false` indicates a load failure — systems must default to procedural/random behaviour. */
  CATALOG_LOADED:      'catalog:loaded',

  // === REWARD SYSTEM (Phase 5 Rewards) ===
  SYNERGY_BONUS:          'reward:synergyBonus',       // { name, points, metals }
  SWEEP_REPORT:           'reward:sweepReport',        // compiled sweep report data
  SWEEP_REPORT_DISMISSED: 'reward:sweepReportDismissed', // player closed report overlay
  TRAWL_SWEEP_COMPLETE:   'trawl:sweepComplete',       // trawl sweep finished { duration, targetsEntered }

  // === TETHER DETACH (Phase 6 — Risk-Reward) ===
  ARM_DETACHED:           'arm:detached',              // { armId, position, fuelRemaining } — tether severed
  ARM_LOST:               'arm:lost',                  // { armId } — detached arm fuel depleted, inert

  // === CODEX (Phase 7 — Learning Systems) ===
  /** Internal event for CodexViewerUI + AudioSystem. See TECH_UNLOCKED for Discovery Pane. */
  CODEX_UNLOCKED:         'codex:unlocked',            // { id, title, shortText, icon, category }
  CODEX_VIEWED:           'codex:viewed',              // { id } — player viewed full entry
  CODEX_UNLOCK_REQUEST:   'codex:unlockRequest',       // { id } — force-unlock a specific entry (e.g. from tutorial)
  CODEX_OPEN_ENTRY:       'codex:open-entry',          // { id } — deep-link: open the viewer on a specific entry (glossary §11.8)

  // === LASSO SYSTEM ===
  LASSO_FIRED:            'lasso:fired',               // { targetId, projectileMass, launchDirection, speed }
  LASSO_CONTACT:          'lasso:contact',
  LASSO_CAPTURED:         'lasso:captured',
  LASSO_DENIED:           'lasso:denied',
  LASSO_MISSED:           'lasso:missed',    // lasso fired but failed to capture
  LASSO_SNAPPED:          'lasso:snapped',   // { targetId, tensionN } — Phase 3 tether broke under strain (heavy catch dropped)
  LASSO_STOWED:           'lasso:stowed',    // { debrisId, cellIndex } — Phase 4 catch reeled to an aft cargo cell (pre-furnace)
  LASSO_COOLDOWN_START:   'lasso:cooldownStart',  // { duration } — cooldown timer began (ST-1.3)
  LASSO_COOLDOWN_END:     'lasso:cooldownEnd',    // {} — cooldown expired, ready to fire (ST-1.3)
  LASSO_AMMO_CHANGED:     'lasso:ammoChanged',    // { remaining, max } — UX-3 #7 ammo system
  /**
   * Delegation 4 (2026-05-31) — emitted by [`NetInventoryPanel`](js/ui/hud/NetInventoryPanel.js:1)
   * when total capture-tool stocks cross the low or critical thresholds defined
   * in [`Constants.INVENTORY`](js/core/Constants.js:1).
   * Payload: { kind: 'lasso'|'nets'|'both', severity: 'low'|'critical', lasso: { remaining, max }, nets: { total, max } }
   */
  INVENTORY_LOW:          'inventory:low',

  // === TOOL RECOMMENDATION ===
  TOOL_RECOMMENDED:       'tool:recommended',      // { tool: 'lasso'|'spinner'|'grapple'|'weaver'|'trawl', targetId }
  TOOL_CYCLE:             'tool:cycle',             // T key — cycle tool alternatives
  // TOOL_DEPLOY removed 2026-06-14 (was deprecated 2026-06-13b with no emitter;
  // deploy is via FOCUS_ACTION / F). Do not re-add — T emits TOOL_CYCLE.

  // === DAUGHTER MULTI-TOOL (DAUGHTER_MULTITOOL_SPEC §4.3) ===
  TOOL_SELECTED:          'tool:selected',          // { armId, tool: 'NET'|'MAGNET'|'GRIPPER'|'PAD' }
  TOOL_ARMSET_CHANGED:    'tool:armsetChanged',     // { armId, toolset: string[] }
  MAGNETIC_GRIP_ATTEMPT:  'magnet:gripAttempt',     // { armId, targetId, pBase }
  MAGNETIC_GRIP_ACQUIRED: 'magnet:gripAcquired',    // { armId, targetId, mass }
  MAGNETIC_GRIP_FAILED:   'magnet:gripFailed',      // { armId, targetId, reason }
  MAGNETIC_RELEASE:       'magnet:release',         // { armId, targetId } — explicit pulse-off
  GRIPPER_LATCH_ATTEMPT:  'gripper:latchAttempt',   // { armId, targetId, fixtured }
  GRIPPER_LATCHED:        'gripper:latched',        // { armId, targetId }
  GRIPPER_SLIPPED:        'gripper:slipped',        // { armId, targetId, reason: 'no_fixture'|'p_roll'|'oversize' }
  GRIPPER_RELEASED:       'gripper:released',       // { armId, targetId }
  PAD_CONTACT_ATTEMPT:    'pad:contactAttempt',     // { armId, targetId, contactVel }
  PAD_ADHERED:            'pad:adhered',            // { armId, targetId, mode }
  PAD_BOUNCED:            'pad:bounced',            // { armId, targetId, reason: 'too_fast'|'no_mode'|'p_roll' }
  PAD_RELEASED:           'pad:released',           // { armId, targetId }
  PAD_UV_DOSE_USED:       'pad:uvDoseUsed',         // { armId, dosesRemaining } — §13 Q3

  // === FOCUS ACTION ===
  FOCUS_ACTION:           'focus:action',           // F key — context-sensitive smart action

  // === TUTORIAL ===
  /** @deprecated Tutorial system removed Sprint 3. Constant retained for save-file compatibility only. No emitters remain in source. */
  TUTORIAL_STAGE_CHANGED: 'tutorial:stage_changed',
  TUTORIAL_SKIPPED:       'tutorial:skipped',
  TUTORIAL_TETHER_LIMIT:  'tutorial:tetherLimitHit',
  TUTORIAL_ARROW_INPUT:   'tutorial:arrowInput',
  TUTORIAL_THROTTLE_INPUT:'tutorial:throttleInput',
  TUTORIAL_WASD_INPUT:    'tutorial:wasdInput',
  TUTORIAL_SCAN_INPUT:    'tutorial:scanInput',     // S or W key during tutorial
  TUTORIAL_TAB_INPUT:     'tutorial:tabInput',      // Tab during tutorial
  TUTORIAL_DEPLOY_INPUT:  'tutorial:deployInput',   // D key during tutorial
  /** Delegation 2 onboarding (2026-05-31). Comma / Period strut deploy/stow.
   *  Payload: {} (fire-and-forget — OnboardingDirector subscribes). */
  STRUT_DEPLOY_INPUT:     'tutorial:strut_input',
  /** ROSA solar-array furl/unfurl toggle (Comma key). Fire-and-forget — used for
   *  audio/telemetry parity with the strut toggle (NOT a tracked onboarding skill).
   *  Payload: { target: 0|1 } (0 = furling, 1 = unfurling). */
  ROSA_FURL_INPUT:        'tutorial:rosa_furl_input',
  /** ROSA solar-array feather toggle (Shift+Comma). Parks the wings edge-on to
   *  a hazard (fast, retains more power than a full furl). Fire-and-forget —
   *  audio/telemetry parity with the furl toggle.
   *  Payload: { feathered: boolean }. */
  ROSA_FEATHER_INPUT:     'tutorial:rosa_feather_input',
  /** Delegation 2 onboarding (2026-05-31). Mouse-wheel zoom or +/- zoom.
   *  Emitted once per wheel tick / +/- keypress regardless of consumer.
   *  Payload: {} (fire-and-forget). */
  CAMERA_ZOOM_INPUT:      'tutorial:zoom_input',

  // === ONBOARDING (Delegation 2 — bottom-screen hint ticker + director) ===
  /** OnboardingDirector posts a hint to the bottom-screen ticker.
   *  Payload: { id, text, glyph?, keys?:string[], skillId?, duration?, priority?:'normal'|'high' }
   *  Re-emitting the same `id` while the hint is alive is a no-op (idempotent). */
  HINT_POSTED:            'hint:posted',
  /** Trigger fired — fade the bottom-screen hint that matches `id`.
   *  Payload: { id } */
  HINT_SATISFIED:         'hint:satisfied',
  /** First-ever entry into the onboarding pipeline (fresh save).
   *  Delegation 4 (2026-05-31) — used by CommsSystem to suppress
   *  non-HOUSTON INFO noise while the player is still being walked
   *  through the basics, and by HUD panels (NetInventoryPanel) to
   *  defer their reveal until onboarding completes.
   *  Payload: {} */
  ONBOARDING_STARTED:     'onboarding:started',
  /** Final onboarding beat completed; veteran path is now active.
   *  Payload: {} */
  ONBOARDING_COMPLETE:    'onboarding:complete',
  /** Guidance depth changed by the behavior-driven tuner or Settings toggle.
   *  Payload: { level: 'GUIDED'|'POINTERS'|'MINIMAL', reason: string } */
  GUIDANCE_LEVEL_CHANGED: 'guidance:levelChanged',
  /** Front-arc autolock assist toggled in Settings. Payload: { enabled: boolean } */
  AUTOLOCK_SETTING_CHANGED: 'guidance:autolockChanged',
  /** OnboardingDirector escalation — feed a synthetic TeachingMoment directly
   *  into TeachingSystem's queue (bypasses the once-per-save guard).
   *  Payload: { id, title, body, duration?, icon? } */
  TEACHING_MOMENT_FORCE:  'teaching:force',

  // ── SKILLS DISCOVERY ──────────────────────────────────────
  SKILL_DISCOVERED:     'skill:discovered',        // { skillId, tier, label }
  SKILL_REMINDED:       'skill:reminded',           // { skillId }
  SKILL_STATE_CHANGED:  'skill:stateChanged',       // { skillId, from, to }
  /** Fired after a skill transitions to MASTERED state.
   *  Payload: { skillId: string, label: string, tier: number, category: string, largeToast: boolean }
   *  `largeToast` is true for the first MASTERY_TOAST_THRESHOLD masteries in the session. */
  MASTERY_FANFARE:      'skill:masteryFanfare',
  SKILL_GATE_UNLOCKED:  'skill:gateUnlocked',       // { skillId }
  SKILLS_PANE_TOGGLE:   'skills:paneToggle',        // { expanded: bool }
  SKILLS_LOADED:        'skills:loaded',            // { skills: Map }

  // ── INPUT / CAMERA EVENTS (Skills Discovery triggers) ─────────
  CAMERA_ZOOM:          'camera:zoom',              // scroll wheel zoom (any view)
  CAMERA_ORBIT_DRAG:    'camera:orbitDrag',         // mouse drag in orbit view
  CAMERA_FREE_LOOK:     'camera:freeLook',          // mouse free-look in first-person
  AUTOPILOT_NO_TARGET:  'autopilot:noTarget',       // A key with no selected target
  COMMS_OPENED:         'comms:opened',             // C key comms toggle
  CODEX_OPENED:         'codex:opened',             // L key codex opened
  SHOP_OPENED:          'shop:opened',              // Shop screen displayed (ST-6.5 teaching trigger)
  ORBIT_MFD_TOGGLE:     'orbitMfd:toggle',          // UNEMITTED as of 2026-06-16 — M opens the Debris Map; the Orbit MFD has no toggle key

  // === SPACE WEATHER (Phase 7 — Learning Systems) ===
  WEATHER_EFFECT_START:   'weather:effectStart',       // { type, effects, duration }
  WEATHER_EFFECT_END:     'weather:effectEnd',         // { type }
  WEATHER_ACTIVE:         'weather:active',            // every update — merged active effects

  // === UPGRADE (Phase 7 — Propellant Teaching trigger) ===
  UPGRADE_APPLIED:        'upgrade:applied',           // { id, name } — upgrade applied to ship

  // === SUBSYSTEM EVENTS (Phase 7B — Spacecraft Subsystems) ===
  SUBSYSTEM_EVENT:        'subsystem:event',           // generic subsystem event for logging
  GROUND_STATION_PASS:    'ground:stationPass',        // ground station in view

  // === AUDIO & POLISH (Phase 8 — Final Juice) ===
  ARM_APPROACH_PING:      'arm:approachPing',          // { distanceFraction, armId }
  TETHER_TENSION:         'tether:tension',            // { tensionFraction, armId }
  SALVAGE_REVEAL:         'salvage:reveal',            // { metals, totalMass, debrisType }
  WIREFRAME_ASSESSED:     'wireframe:assessed',        // {} — DebrisWireframe: player cycled all zones

  // === THROTTLE (F14) ===
  THROTTLE_CHANGE:        'throttle:change',           // { level } — 0.0–1.0 throttle level

  // === AUTOPILOT (F15) ===
  AUTOPILOT_ENGAGE:       'autopilot:engage',          // { mode: 'TARGET'|'TRAWL'|'DEBRIS'|'PROGRADE' }
  AUTOPILOT_DISENGAGE:    'autopilot:disengage',       // { reason: 'MANUAL'|'DELTAV'|'COLLISION'|'ARROW_INPUT'|'TRAWL' }
  AUTOPILOT_ARRIVED:      'autopilot:arrived',         // { mode } — AP reached target, holding heading
  AUTOPILOT_TARGET_LOCK:   'autopilot:targetLock',     // { debrisId } — AP acquired a debris lock (exempt from CA)
  AUTOPILOT_TARGET_UNLOCK: 'autopilot:targetUnlock',   // { debrisId } — AP released debris lock

  // === THRUST VISUAL (Phase 4 — Velocity Streaks) ===
  THRUST_VISUAL:          'thrust:visual',             // { magnitude, direction, type }

  // === MPD THRUSTER (F16) ===
  MPD_FIRE:               'mpd:fire',                  // { direction, thrust, cathodeHealth }
  MPD_CATHODE_WORN:       'mpd:cathode_worn',          // { cathodeTime, degradedFactor }
  LITHIUM_CHANGE:         'resource:lithium_change',   // { lithium, lithiumMax, delta }

  // === MPD BURST MODE (S3b) ===
  MPD_BURST_START:        'mpd:burstStart',            // { armed } — player armed MPD
  MPD_BURST_END:          'mpd:burstEnd',              // { reason: 'manual'|'overheat'|'battery_depleted'|'lithium_depleted' }
  MPD_OVERHEAT:           'mpd:overheat',              // { heat } — thermal shutdown triggered
  MPD_POWER_WARNING:      'mpd:powerWarning',          // { batteryFraction } — battery low during MPD

  // === CONTROL MODE (S4 — Core Feel) ===
  CONTROL_MODE_CHANGE:    'control:modeChange',        // { mode: 'RCS'|'COLD_GAS'|'ARM_PILOT'|'MPD_BURST' }

  // ── V5 Crossbow Events ──

  // --- Crossbow Lifecycle ---
  CROSSBOW_FIRE:            'crossbow:fire',             // { armIndex, speed, springTier, armMass, launchDirection }
  CROSSBOW_RELOAD_START:    'crossbow:reloadStart',      // { armIndex, duration }
  CROSSBOW_RELOAD_COMPLETE: 'crossbow:reloadComplete',   // { armIndex }

  // --- Tether Events ---
  TETHER_TENSION_UPDATE:    'tether:tensionUpdate',      // { armIndex, tension, fraction }
  TETHER_TANGLE:            'tether:tangle',             // { armIndices[] }
  TETHER_SNAP:              'tether:snap',               // { armIndex, cause }
  TETHER_REEL_STATE:        'tether:reelState',          // { armIndex, reeling, speed }

  // --- Reel-in / re-dock inertia overhaul (FEATURE_FLAGS.REEL_PROFILE_V2) ---
  /** Stage-1 net cinched tight; daughter+net+debris is now one rigid unit. Payload: { armIndex, debrisId, mUnit } */
  CATCH_SNUGGED:            'reel:catchSnugged',
  /** Daughter entered the FEEP soft-dock arrest window. Payload: { armIndex, mUnit, vArrest } */
  REDOCK_ARREST_START:      'reel:redockArrestStart',
  /** Re-dock arrest could not be funded by FEEP (or plume blocked) → slow reel-only finish. Payload: { armIndex, fuel, needed } */
  REDOCK_FUEL_LOW:          'reel:redockFuelLow',

  // --- Dual-Fire ---
  DUAL_FIRE:                'crossbow:dualFire',         // { armIndex1, armIndex2 }
  DUAL_FIRE_RECOIL:         'crossbow:dualFireRecoil',   // { cancelled, residualDv }

  // --- Pulse Scan ---
  PULSE_SCAN_START:         'pulseScan:start',           // { armCount }
  PULSE_SCAN_COMPLETE:      'pulseScan:complete',        // { detections[] }

  // --- Ablation ---
  ABLATION_START:           'ablation:start',            // { armIndex, targetId }
  ABLATION_END:             'ablation:end',              // { armIndex, despinAchieved }
  DESPIN_IN_SPEC:           'despin:inSpec',             // CP-2 — { targetId, tumbleDeg } target detumbled below net-safe spin

  // === COLLISION AVOIDANCE ===
  CA_THREAT_DETECTED:       'ca:threatDetected',         // { debrisId, tca, missDistance, evasionVector }
  CA_DODGE_EXECUTED:        'ca:dodgeExecuted',          // { debrisId, direction, magnitude }
  CA_THREAT_CLEARED:        'ca:threatCleared',          // { debrisId }
  CA_TOGGLED:               'ca:toggled',                // { enabled }
  CA_SUPPRESSED:            'ca:suppressed',             // { debrisId, reason }

  // === DEBRIS MAP (ST-4.A) ===
  DEBRIS_MAP_CLUSTER_SELECTED: 'debrisMap:clusterSelected',  // { clusterId, name?, count? }

  // === CLUSTER CLEARING (defer-trawl / guided-loop) ===
  /** The last alive member of an orbital cluster bucket was removed via active
   *  capture/deorbit. Anchors the "field cleared" ceremony + bonus onto the
   *  guided loop (replaces TRAWL_SWEEP_COMPLETE in the core flow).
   *  Payload: { clusterId: string, name: string, count: number } */
  CLUSTER_CLEARED:     'cluster:cleared',

  // === TRAIL SYSTEM (ST-5.2) ===
  PLAYER_TRAIL_SAMPLE:    'player:trailSample',      // { pos: {x,y,z}, vel: {x,y,z} } — scene units
  ARM_TRAIL_SAMPLE:       'arm:trailSample',          // { armId, pos: {x,y,z}, vel: {x,y,z} } — scene units
  ARM_TRAIL_CLEAR:        'arm:trailClear',            // { armId } — arm docked/reloading, clear buffer

  // === STRATEGIC MAP (ST-6.4) ===
  STRATEGIC_MAP_TOGGLE:  'ui:strategic_map_toggle',   // Shift+V — toggle strategic map overlay
  STRATEGIC_MAP_OPENED:  'ui:strategic_map_opened',   // map opened (camera transition started)
  STRATEGIC_MAP_CLOSED:  'ui:strategic_map_closed',   // map closed (camera returned to gameplay)

  // === ENVIRONMENT HAZARDS (ST-6.7) ===
  /** Generic environment effect event.
   *  Payload varies by type: { type: 'atomic_oxygen'|'mmod_impact'|'radiation_belt'|'battery_dod', ...typeSpecificData } */
  ENVIRONMENT_EFFECT:     'environment:effect',
  /** Spacecraft entered safe mode (2+ subsystems below critical threshold).
   *  Payload: { subsystemsBelowThreshold: string[] } */
  SAFE_MODE_ENTERED:      'environment:safe_mode_on',
  /** Spacecraft exited safe mode (all subsystems recovered).
   *  Payload: {} */
  SAFE_MODE_EXITED:       'environment:safe_mode_off',
  /** Audio cue hint for AudioSystem (fire-and-forget, may be ignored).
   *  Payload: { cue: string } */
  AUDIO_CUE:              'audio:cue',

  // === NOTIFICATION ZONE (UX-2 Sprint) ===
  /** Transient pilot notification (bottom-center).
   *  Payload: { text: string, duration?: number } */
  SHOW_NOTIFICATION:      'ui:showNotification',

  // === Epic 8 events — STATION_KEEP & FEEP ===
  /** Orbit adjust input. Payload: { armId, theta, phi, radius, fine, dt } */
  ARM_ORBIT_ADJUST:        'arm:orbit_adjust',
  /** Arm entered station-keep. Payload: { armId, targetId, standoffR } */
  STATION_KEEP_ENTERED:    'arm:stationKeepEntered',
  /** Arm exited station-keep. Payload: { armId, reason: 'capture'|'recall'|'fuel'|'lost' } */
  STATION_KEEP_EXITED:     'arm:stationKeepExited',
  /** FEEP propellant metal changed. Payload: { armId, metal, ispRange, thrustPerW } */
  FEEP_METAL_CHANGED:      'arm:feepMetalChanged',
  /** News/bounty event triggered. Payload: { eventId, name, bounty, debris[] } */
  NEWS_EVENT_TRIGGERED:    'mission:newsEventTriggered',

  // ── ST-9.3 Config G Arm Hinge + Dual-Fire Events ─────────────────────
  /** Hinge brake engaged. Payload: { armIndex } */
  ARM_HINGE_LOCKED:        'arm:hingeLocked',
  /** Hinge brake released. Payload: { armIndex } */
  ARM_HINGE_UNLOCKED:      'arm:hingeUnlocked',
  /** Dual-fire rejected (pre-fire gating). Payload: { pairIndex, reason } */
  ARM_DUAL_FIRE_REJECTED:  'arm:dualFireRejected',
  /** Fire blocked — Mother angular rate too high. Payload: { omega, threshold } */
  ARM_FIRE_BLOCKED_HIGH_RATE: 'arm:fireBlockedHighRate',
  /** Recoil compensation applied after crossbow fire. Payload: { residualImpulse, rcsN2Used } */
  ARM_RECOIL_COMPENSATED:  'arm:recoilCompensated',

  // ── ST-9.10 C-4: Deploy State Machine Events ──────────────────────────
  /** Deploy started (STOWED → DEPLOYING). Payload: { armIndex, fromState } */
  ARM_DEPLOY_STARTED:      'arm:deployStarted',
  /** Deploy completed (DEPLOYING → DEPLOYED). Payload: { armIndex } */
  ARM_DEPLOY_COMPLETED:    'arm:deployCompleted',
  /** Stow started (DEPLOYED → STOWING). Payload: { armIndex, fromAlpha } */
  ARM_STOW_STARTED:        'arm:stowStarted',
  /** Stow completed (STOWING → STOWED). Payload: { armIndex } */
  ARM_STOW_COMPLETED:      'arm:stowCompleted',
  /** Deploy/stow/unlock rejected (invalid transition). Payload: { armIndex, currentState, reason } */
  ARM_DEPLOY_REJECTED:     'arm:deployRejected',

  // ── ST-9.11 C-5: Launch Sequence Events ─────────────────────────────────
  /** Phase transition. Payload: { fromPhase, toPhase, elapsedTotalS } */
  LAUNCH_PHASE_CHANGED:      'launch:phaseChanged',
  /** Per-arm pyro release. Payload: { armIndex } */
  LAUNCH_LOCK_RELEASED:      'launch:lockReleased',
  /** ROSA wing deploy started. Payload: { wing: 1|2 } */
  ROSA_DEPLOY_STARTED:       'launch:rosaDeployStarted',
  /** ROSA wing deploy finished. Payload: { wing: 1|2, powerW } */
  ROSA_DEPLOY_COMPLETED:     'launch:rosaDeployCompleted',
  /** Launch sequence finished — control handed to player. Payload: {} */
  LAUNCH_SEQUENCE_COMPLETE:  'launch:sequenceComplete',

  // ── ST-9.12 C-9: Center-of-Mass + Plume Interlock Events ───────────────
  /** CoM drift exceeds threshold. Payload: { offsetM, threshold, suggestedStowArm } */
  COM_DRIFT_WARNING:         'com:driftWarning',
  /** CoM drift returns below threshold. Payload: { offsetM } */
  COM_DRIFT_CLEARED:         'com:driftCleared',
  /** Thruster blocked by strut in plume cone. Payload: { thrusterId, conflictingArms, reason } */
  THRUSTER_BLOCKED_PLUME:    'thruster:blockedPlume',
  /** Thruster unblocked (strut moved out of cone). Payload: { thrusterId } */
  THRUSTER_UNBLOCKED:        'thruster:unblocked',

  // ── ST-9.4 C-6: Capture Net Events ───────────────────────────────────────
  /** Net projectile launched. Payload: { source:'mother'|'daughter', armIndex?, podIndex?, netClass, remaining } */
  NET_FIRED:                 'net:fired',
  /** Net hit target and secured debris. Payload: { armIndex, podIndex, debrisId, tangleQuality, capturedMass, mode } */
  NET_CATCH_SUCCESS:         'net:catchSuccess',
  /** Net missed / cling failed. Payload: { armIndex, podIndex, debrisId?, probability?, reason } */
  NET_CATCH_MISS:            'net:catchMiss',
  /** Reel-in motor started. Payload: { armIndex, podIndex, hasCatch } */
  NET_REEL_STARTED:          'net:reelStarted',
  /** Reel-in completed — debris at strut tip / pod. Payload: { armIndex, podIndex, capturedMass, debrisId? } */
  NET_REEL_COMPLETED:        'net:reelCompleted',
  /** Player aborted — net + debris released. Payload: { armIndex, podIndex, debrisId? } */
  NET_RELEASED:              'net:released',
  /** Net lost grip on a captured catch (recoverable). Payload: { armId, armIndex, debrisId, strain, recoverable } */
  NET_FAILED:                'net:failed',
  /** Net inventory changed (fire/reload). Payload: { source:'mother'|'daughter', armIndex?, podInventory?, remaining? } */
  NET_INVENTORY_CHANGED:     'net:inventoryChanged',
  /** Cross-debris warning during flight. Payload: { netId, crossDebrisId } */
  NET_CROSS_DEBRIS_WARNING:  'net:crossDebrisWarning',
  /** Fragmentation event. Payload: { debrisId, fragmentCount, mercyApplied } */
  NET_FRAGMENTATION:         'net:fragmentation',
  /** Phase 1.5 (capture-feedback overhaul): close-range survey completed — Full
   *  Profile unlocked for one debris. Payload: { debrisId, target, bountyPaid } */
  DEBRIS_PROFILED:           'debris:profiled',
  /** First successful cinch capture (stub for TeachingSystem). Payload: { debrisId } */
  CINCH_FIRST_SUCCESS:       'net:cinchFirstSuccess',
  /** Net empty click — F-press with 0 nets remaining. Payload: { armId } */
  NET_EMPTY_CLICK:           'net:emptyClick',

  // ── Q2 Net-Launch Ceremony Events (CEREMONY_REDESIGN.md §5.2) ────────────
  /** First-fire ceremony begins. Payload: { armIndex, podIndex, netClass, firstEver: boolean } */
  NET_CEREMONY_START:        'net:ceremonyStart',
  /** Predictive 0.3 s lookahead before brake state-entry. Payload: { armIndex, podIndex, tMinus: 0.3 } */
  NET_BRAKE_IMMINENT:        'net:brakeImminent',
  /** BRAKE state entered — tether yanks taut. Payload: { armIndex, podIndex, tetherTensionN } */
  NET_BRAKE_FIRED:           'net:brakeFired',
  /** Mid-ENVELOP audio sting cue. Payload: { armIndex, podIndex } */
  NET_ENVELOP_PEAK:          'net:envelopPeak',
  /** Per-frame cinch progress during CINCH_CLOSING. Payload: { armIndex, podIndex, fraction: 0..1 } */
  NET_CINCH_PROGRESS:        'net:cinchProgress',
  /** Ceremony complete — camera returns to ARM_PILOT. Payload: { armIndex, podIndex, mode, success } */
  NET_CEREMONY_COMPLETE:     'net:ceremonyComplete',

  // ── ST-9.5 C-7: Tether Reel Events (strut-mounted, Config G §10.4) ──────
  /** Tether payout started. Payload: { armIndex, targetLengthM } */
  TETHER_PAYOUT_STARTED:     'tether:payoutStarted',
  /** Tether reel-in started. Payload: { armIndex, payloadMassKg } */
  TETHER_REELIN_STARTED:     'tether:reelinStarted',
  /** Tether reel-in completed (cable fully spooled). Payload: { armIndex } */
  TETHER_REELIN_COMPLETED:   'tether:reelinCompleted',
  /** Reel jammed. Payload: { armIndex, lengthM } */
  TETHER_JAMMED:             'tether:jammed',
  /** Tether cut (emergency or overload). Payload: { armIndex, reason } */
  TETHER_CUT:                'tether:cut',
  /** Tension > 75% of breaking — debounced warning. Payload: { armIndex, tensionN, breakingN } */
  TETHER_TENSION_HIGH:       'tether:tensionHigh',

  // ── ST-9.7 C-8: Bridle Ring Events (simplified Config G) ──────────────────
  /** Payload attached to bridle ring point. Payload: { armIndex, pointId, payloadId, loadKg } */
  BRIDLE_ATTACH:             'bridle:attach',
  /** Payload detached from bridle ring point. Payload: { armIndex, pointId, payloadId } */
  BRIDLE_DETACH:             'bridle:detach',
  /** Bridle ring point overloaded (load > OVERLOAD_FACTOR × max). Payload: { armIndex, pointId, loadKg, maxKg } */
  BRIDLE_OVERLOAD:           'bridle:overload',

  // ── ST-9.8 C-10: Arm Tier Upgrade Events ──────────────────────────────────
  /** Tier upgrade is available to purchase. Payload: { fromTier, toTier, costCredits, prereqMet } */
  TIER_UPGRADE_AVAILABLE:    'tier:upgradeAvailable',
  /** Tier upgrade rejected (pre-condition failed). Payload: { fromTier, toTier, reason } */
  TIER_UPGRADE_REJECTED:     'tier:upgradeRejected',
  /** Tier upgrade applied. Payload: { fromTier, toTier, newArmCount, newMassDryKg } */
  TIER_UPGRADED:             'tier:upgraded',

  // === AUDIO UNLOCK (PR 6 / P3.13) ===
  /** AudioContext still suspended 200ms after first user gesture.
   *  Payload: {} */
  AUDIO_UNLOCK_FAILED:       'audio:unlockFailed',

  // === PERFORMANCE / QUALITY TIER (PR 4 / P1.5) ===
  /** Quality tier changed by QualityManager (initial selection or runtime auto-downshift).
   *  Payload: { from: 'HIGH'|'MEDIUM'|'LOW', to: 'HIGH'|'MEDIUM'|'LOW', reason: string } */
  PERF_TIER_CHANGED:         'perf:tier-changed',
};

export default Events;
