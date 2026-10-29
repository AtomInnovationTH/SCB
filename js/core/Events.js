/** @module core/Events — event-name constants; use them instead of typed strings (a typo'd string fails silently). */

export const Events = {
  // ARM LIFECYCLE
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
  // No ARM_DEPLOY / ARM_FISH (RadialMenu deleted); preferType deploy rides ARM_DEPLOY_TO. The fishing / cast-all verb
  // (`deployFishing`, the FISHING state) was deleted on purpose: bringing it back is a fresh design, not a restore.
  ARM_MANUAL_THRUST:  'arm:manualThrust',
  ARM_REFUELED:       'arm:refueled',     // Daughter ion fuel swapped in from her indium store (docked swap)
  ARM_SELECT:         'arm:select',       // Player selected arm by number key 1-6
  ARM_DESELECT:       'arm:deselect',     // Player deselected arm — back to mothership (key 7)
  LAUNCH_SPEED_CHANGED: 'arm:launchSpeedChanged', // { speed } — clamped fleet launch speed after a dial move
  WEB_SHOT_HIT:       'arm:webShotHit',   // { debrisId, dragMultiplier } — GSL web shot hit debris

  // TARGET SELECTION
  TARGET_SELECTED:    'target:selected',
  TARGET_CLEARED:     'target:cleared',
  TARGET_DISCOVERED:  'target:discovered',   // { target } — staggered reveal
  /** Selected target crossed INTO net-lock range (≤ NET_LOCK_RANGE_M): cyan reticle flip + the in-range-only lock
   *  earcon. Payload: { id, distanceM } */
  TARGET_IN_RANGE:    'target:inRange',
  /** Selected target is OUTSIDE net-lock range (> NET_LOCK_RANGE_M): yellow "OUT OF RANGE" reticle + the
   *  range→autopilot teaching gate; lock earcon suppressed. Payload: { id, distanceM } */
  TARGET_OUT_OF_RANGE: 'target:outOfRange',
  /** Throttled (~4 Hz) range readout for the selected out-of-range target; drives the range-closing audio ticker.
   *  Payload: { id, distM, netRangeM } */
  TARGET_RANGE:        'target:range',

  // CAMERA
  CAMERA_VIEW_CHANGE: 'camera:viewChange',
  VIEW_CONFIG_CHANGE: 'view:configChange',   // { showClosureRate, showNavSphere, ... } — view info-level config
  LAUNCH_CEREMONY_START:    'camera:launchCeremonyStart',    // { arm }
  LAUNCH_CEREMONY_COMPLETE: 'camera:launchCeremonyComplete', // { arm }
  // ABORT: the ceremony ended WITHOUT the pilot handoff (ESC/Space/Enter/D skip, or the mid-ceremony dead-arm guard).
  // COMPLETE means "deployed, hand the player the daughter" (ArmPilot entry, FOV keep, enableManual); ABORT only tells
  // the ceremony-STATE listeners to stand down (main.js _launchCeremonyLive, TeachingSystem 'launchCeremony' blocker,
  // CollisionAvoidanceSystem._ceremonyActive).
  LAUNCH_CEREMONY_ABORT:    'camera:launchCeremonyAbort',    // { arm }

  // GAME STATE
  STATE_CHANGE:       'state:change',
  GAME_STATE_CHANGE:  'game:stateChange',     // { from, to, payload } — emitted by GameFlowManager after transition
  GAME_RESET:         'game:reset',            // { } — emitted by GameFlowManager.resetGame()
  GAME_KESSLER:       'game:kesslerEvent',
  GAME_COLLISION:     'game:collision',
  GAME_WIN:           'game:win',

  // SCORING
  SCORE_UPDATE:       'score:update',
  SCORING_AWARD:      'scoring:award',

  // MISSION
  /** Mission number incremented (every DEBRIS_PER_MISSION captures). Payload:
   *  { missionNumber: number, profile: object } Fires ON the boundary catch: the credited clear that makes
   *  debrisCleared = DEBRIS_PER_MISSION × (N−1) starts mission N (5th catch → 2, 20th → 5, 40th → 9); GameFlowManager
   *  calls ScoringSystem.checkMissionTransition() right after each clearDebris(). Boss / chapter-coach onsets key on it
   *  (arm here, fire on the first gameplay frame with no depot stop pending — _bossLifecycle.MissionOnset). Not emitted
   *  for mission 1, nor at a continue (the first clear after a resume re-asserts the restored mission). */
  MISSION_START:      'mission:start',
  /** "Where next" choice at a mission boundary (FEATURE_FLAGS.FIELDS_BY_HEIGHT). Emitted by TransferTrip
   *  (phase `choose`) as `{ open: true }` when it opens (`again: true` when a refused pick puts it back) and
   *  `{ open: false }` when it closes (pick, Stay, game over, new run). main.js turns `open: true` into the jump to
   *  floor 4 and shows ui/WhereNextList.js. Never emitted with the flag off, with `?ladder=0`, or by the old flat trip. */
  WHERE_NEXT:         'trip:whereNext',
  /** Ion start-up (DECISIONS §37 row 7): the four tail engines of a burning trip light pair by pair. Emitted by
   *  TransferTrip: BEGIN the frame the burn starts (`{}`; CameraSystem swings behind her, AudioSystem starts the hum),
   *  HUM every lighting frame (`{ lit: 0..1 }`: hum gain and pitch follow it), LIT once when all four burn
   *  (`{}`; trip line shows, camera hold begins, clock may speed up), END when the trip ends or is aborted
   *  (`{}`; hum stops, a camera still out comes back). END always follows a BEGIN. */
  ION_STARTUP_BEGIN:  'trip:ionStartupBegin',
  ION_STARTUP_HUM:    'trip:ionStartupHum',
  ION_STARTUP_LIT:    'trip:ionStartupLit',
  ION_STARTUP_END:    'trip:ionStartupEnd',
  /** Mother berths at the resupply satellite or lets go (FIELDS_BY_HEIGHT, DECISIONS §33 row 7). Emitted by
   *  GameFlowManager: `{ phase: 'berthed', satId, altKm }` once when a trip to the satellite has arrived
   *  (the satellite takes any catch mated at her nose collar first, buying opens, the first berth tops credits up);
   *  `{ phase: 'left', satId, altKm }` once when a field pick from the berth begins its trip (buying closes). A trip
   *  from the berth that could not go puts her back with a second `berthed`. Only the berth look and teaching listen.
   *  Never emitted with the flag off. */
  RESUPPLY_BERTH:     'resupply:berth',
  /** Player picked a fate for a still-pending big piece (DECISIONS §33 row 16; the fate list emits it after `setFate`).
   *  Payload: `{ debrisId, fate }`, fate in `satellite|push|sail|keep|melt`. GameFlowManager `_wireBigPieceFates` hands
   *  it to that fate's executor (`_fateSatellite`, `_fateSail`, `_fateMelt`); push and keep have none. */
  BIG_PIECE_FATE:     'bigpiece:fate',
  /** A big piece was disposed of and paid (`GameFlowManager.disposeBigPiece`). Payload: `{ debrisId, fate, totalCr }`.
   *  The fate list refreshes, and closes when nothing is left. */
  BIG_PIECE_DISPOSED: 'bigpiece:disposed',
  /** A mission's last catch landed: HUD "MISSION N COMPLETE" headline (fades by itself) + one success cue. Emitted ONCE
   *  per mission boundary from GameFlowManager._openDepotInvitation (live ladder-on path), just before the "UPGRADES
   *  AVAILABLE" comms line; never on the forced-card path. Not a stop: no world hold.
   *  Payload: { mission: number (missionsCompleted: 1 at the 5th catch), debrisCleared: number } */
  MISSION_COMPLETE:   'mission:complete',

  // MISSION MID-FLIGHT
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

  // CH5 ISS CONJUNCTION BOSS
  /** Boss engaged: 6 Cosmos-1408 threat frags spawned in the ISS forward track.
   *  Payload: { threatIds: number[], tcaHours: number } */
  ISS_BOSS_STARTED:   'iss:bossStarted',
  /** TCA window closing — final warning. Payload: { tcaRemainingHours, cleared, total } */
  ISS_BOSS_IMMINENT:  'iss:bossImminent',
  /** Player explicitly declines the intercept (lets CSA reboost the station). Payload: {} */
  ISS_BOSS_DECLINE:   'iss:bossDecline',
  /** Boss resolved. Payload: { outcome: 'intercept'|'decline'|'miss', cleared, total } */
  ISS_BOSS_RESOLVED:  'iss:bossResolved',

  // CH9 STARLINK FRAGMENTATION BOSS
  /** Boss engaged: N Starlink frags burst-spawned. Payload: { threatIds: number[], windowMin: number } */
  STARLINK_BOSS_STARTED:  'starlink:bossStarted',
  /** Containment window closing — final warning. Payload: { remainingMin, cleared, total } */
  STARLINK_BOSS_IMMINENT: 'starlink:bossImminent',
  /** Boss resolved. Payload: { outcome: 'contained'|'partial'|'cascade', cleared, total } */
  STARLINK_BOSS_RESOLVED: 'starlink:bossResolved',

  // DEBRIS
  DEBRIS_CLEARED:     'debris:cleared',
  DEBRIS_CAPTURED:    'debris:captured',
  CATCH_PROCESSED:    'catch:processed',   // furnace-transfer complete — { armId, debrisId, type }; owns salvage+scoring — mother path: { parked: true } credits at the collar mate; { digested: true } closes it (no second credit — enforced handler-side by the per-body debris._credited ledger)
  // Staged furnace breakdown: visual-only choreography on the way to CATCH_PROCESSED
  // (gameplay still keys off that one event). Consumed by FurnaceBreakdownVisual + CaptureNetVisual. The collar's
  // mother-side beat carries `{ anchor: { kind:'collar', podIndex } }` in place of an armFaced payload
  // (armId 'mother').
  CATCH_BREAKDOWN_START: 'catch:breakdownStart', // { armId, debrisId, chunkCount, [anchor] } — chop begins
  CATCH_BREAKDOWN_CHUNK: 'catch:breakdownChunk', // { armId, debrisId, index, total, [anchor] } — one chunk fed
  CATCH_BREAKDOWN_CANCEL: 'catch:breakdownCancel', // { armId, debrisId, anchor } — a mid-cook jettison [K] ends the collar's beat WITHOUT the draw-in (the body left the furnace, not into it)
  NET_CONSUMED:          'net:consumed',         // { armIndex } | collar: { podIndex, anchor } — fed-in bag draws toward the mother / freeze-fades
  // Cargo hand-off: the collared mother catch is carried, still in its net, from the collar seat to a daughter's cargo
  // rack. Own pair because the breakdown events key their chunk pool and bag map by armIndex
  // (`resolveArmIndex` returns −1 for an arm-less payload); `from`/`to` are {kind,…} anchors so a listener resolves
  // either end without knowing which system owns it.
  //   START:    { debrisId, massKg, podIndex, armIndex, armId, durationS,
  //               from: { kind:'collar', podIndex }, to: { kind:'strutTip', armIndex } }
  //   COMPLETE: { debrisId, massKg, podIndex, armIndex, armId, cellIndex }
  CARGO_TRANSFER_START:    'cargo:transferStart',
  CARGO_TRANSFER_COMPLETE: 'cargo:transferComplete',
  DEBRIS_REMOVED:     'debris:removed',
  DEBRIS_KESSLER:     'debris:kesslerEvent',
  DEBRIS_COLLISION:   'debris:collision',

  // RESOURCES
  RESOURCE_CHANGED:   'resource:changed',
  RESOURCE_DEPLETED:  'resource:depleted',
  RESOURCE_CONSUME:   'resource:consume',
  RESOURCE_REPLENISH: 'resource:replenish',
  RESOURCE_UPGRADED:  'resource:upgraded',

  // SALVAGE
  SALVAGE_RECOVERED:  'salvage:recovered',
  SALVAGE_SCAN:       'salvage:scan',

  // PLAYER
  PLAYER_TELEMETRY:   'player:telemetry',
  PLAYER_THRUST_FAILED: 'player:thrustFailed',
  PLAYER_LOW_BATTERY: 'player:lowBattery',
  PLAYER_LOW_XENON:   'player:lowXenon',

  // COLLISION
  COLLISION_WARNING:  'collision:warning',
  COLLISION_EVASION:  'collision:evasion',

  // INTERACTION
  INTERACTION_DATA_CAPTURE: 'interaction:dataCapture',
  INTERACTION_DEORBIT:      'interaction:deorbit',
  INTERACTION_CAPTURE:      'interaction:capture',
  INTERACTION_FRAGMENTATION: 'interaction:fragmentation',

  // COMMS
  /**
   * Payload: { strutGroups: Array<{pivotGroup, strut, tipNode, azRad}>, durationMs: number }. Emitted by
   * PlayerSatellite.highlightStrutsForBeat(); consumed by StrutLabels.
   */
  STRUT_LABELS_SHOW: 'ui:strutLabelsShow',

  /** Payload: { text, priority, source, channel?, link? }. `channel`: one of Constants.COMMS.CHANNELS
   *  (omitted → receiver classifies by source, default FLAVOR). `link: { term, entryId, anchor? }`: per-message deep
   *  link — CommsPanel wraps the FIRST whole-word `term` in the body as a
   *  `.glossary-term.glossary-link[data-entry=entryId]` that opens the SPECS viewer on that entry
   *  (the CODEX_OPEN_ENTRY route); `anchor` rides as `data-anchor`. CommsSystem copies it only when it is an object
   *  with BOTH strings (else `null`). Not markup: the text stays plain. */
  COMMS_MESSAGE:      'comms:message',
  /** Payload: { subject: 'mother'|'debris', targetId?: number|null }. An omitted `subject` MUST default to 'mother'.
   *  'debris' is reserved for the daughter-piloted wireframe render path; CameraSystem handles only 'mother'. */
  INSPECTION_TOGGLE:  'inspection:toggle',
  /** Idempotent hull-outline on/off for close inspection. Payload: { visible: boolean }. Emitted by the OVERVIEW
   *  zoom-driven inspection sub-state (camera view stays ORBIT, so it can't use the INSPECTION CAMERA_VIEW_CHANGE);
   *  separate from INSPECTION_TOGGLE because a toggle desyncs. */
  INSPECT_HULL_OUTLINE: 'inspection:hullOutline',
  /** MotherCallouts: inspection zoom band changed (SYSTEM / PART / COMPONENT) or inspection (de)activated. Payload:
   *  `{ band: 'SYSTEM'|'PART'|'COMPONENT'|null }`. HUD shows a depth breadcrumb + one-time zoom hint. */
  CALLOUT_BAND_CHANGE: 'callout:bandChange',
  /** Fired ONCE each time the OVERVIEW zoom-driven inspection sub-state ENGAGES for the mothership
   *  (hull callouts visible). Unlike INSPECTION_TOGGLE: engage only (never exit), mother only — onboarding's "player
   *  actually saw the callouts" signal. Payload: {} */
  MOTHER_INSPECTION_ENGAGED: 'inspection:motherEngaged',
  COMMS_SEND:         'comms:send',
  COMMS_SOLAR_STORM:  'comms:solarStorm',
  COMMS_GEO_STORM:    'comms:geoStorm',
  // The start's lines wait until comms can be seen. OpeningDance.start() emits HOLD; OpeningDance
  // (just before OPENING_DANCE_HANDOVER, and in endState) and OnboardingDirector (veteran skip) emit RELEASE.
  COMMS_HOLD:         'comms:hold',
  COMMS_RELEASE:      'comms:release',

  // COMMS UI
  COMMS_FOCUS:            'comms:focus',           // C-tap → expand pane
  // No COMMS_RADIAL_OPEN/CLOSE (RadialMenu deleted).
  COMMS_SCROLL_UP:        'comms:scrollUp',        // PageUp → scroll history
  COMMS_SCROLL_DOWN:      'comms:scrollDown',       // PageDown → scroll history
  COMMS_PANEL_RESIZED:    'comms:panelResized',    // { step, height } — pane stepped to a new size (line/normal/large)

  // CITY LABELS
  CITY_LABELS_TOGGLE:     'cityLabels:toggle',     // 5 key → toggle Earth city labels

  // LOCALE / LANGUAGE
  /**
   * Player changed the menu language / region. Payload: { code, lang }, `lang` = the full entry from core/Languages.js
   * (flag + start city).
   */
  LANGUAGE_CHANGED:       'locale:languageChanged',

  // PAUSE
  PAUSE_RESUME:       'pause:resume',
  PAUSE_MENU:         'pause:menu',

  // MENU / UI
  MENU_START:         'menu:start',
  MENU_FAST_START:    'menu:fastStart',
  MENU_CONTINUE:      'menu:continue',
  // START of the menu→sim departure pull-back (before MENU_START/MENU_CONTINUE, which fire at the END); drives the
  // departure audio pad swell. { event } = the terminal event that will fire.
  MENU_DEPARTURE_START: 'menu:departureStart',
  // Once at ~65% of the pull-back: lets the sim unhide the real player ship EARLY, while the receding menu hero still
  // masks it (no visibility pop).
  MENU_DEPARTURE_REVEAL: 'menu:departureReveal',
  // Per SAFER cold-gas puff during the astronaut jet-off exit; drives a tiny filtered-noise "pfft". Full new-game exit
  // only (not continue/reduced).
  MENU_EVA_PUFF: 'menu:evaPuff',
  // A menu→sim departure begins: announces the random orientation treatment { mode: 'partial' | 'flyaround' }. main.js
  // fires the power-up cut flash only for 'partial' (the fly-around is orientation-seamless and needs no mask).
  MENU_ORIENT_MODE: 'menu:orientMode',
  UPDATE_AVAILABLE: 'app:updateAvailable',   // { hash, tag, bullets } — UpdateWatch → MenuScreen
  UPDATE_AUTO_APPLY: 'app:updateAutoApply',  // { hash, tag, bullets } — UpdateWatch → MenuScreen: switch now, on the menu, before a game began
  BRIEFING_COMMENCE:  'briefing:commence',
  BRIEFING_SKIP:      'briefing:skip',
  SHOP_DEPLOY:        'shop:deploy',
  /** Depot INVITATION (docs/ladder/08-workbench.md §5 D3). After every mission
   *  (DECISIONS §14 — from chapter 1; from chapter MISSIONS.FORCED_DEPOT_CHAPTERS+1 only if MISSIONS.FORCED_DEPOT_STOP
   *  is turned back on) a mission-boundary catch never forces the depot stop. GameFlowManager
   *  (the ONE depot decision per catch) emits `{ open: true, chapter, debrisCleared, firstInvitation }`; the rail's
   *  DEPOT notch glows (VisualLaw VALUE, steady) until the player pushes into the doorway
   *  (`{ open: false, reason: 'entered' }` on any SHOP entry), the window lapses on the next credited catch
   *  (`reason: 'lapsed'`; owner 2026-09-04) or the game resets (`reason: 'reset'`). Own key because it carries the
   *  doorway's open/closed STATE: MISSION_START never will, DEBRIS_CLEARED would make the rail re-derive the chapter
   *  rule (two owners of one decision), COMMS_MESSAGE is prose. Consumer: main.js → RailIndicator.setDepotInvitation
   *  (registered inside the LADDER.ENABLED gate; never emitted with the ladder off). */
  DEPOT_INVITATION:   'depot:invitation',
  /** WORKBENCH BREAK (ONE SHOP). With the ladder on, gameplay never enters the SHOP GameState: every depot entry
   *  (chapter 1–3 boundary dwell, B key, glass STORE chip, any legacy transitionToState(SHOP) caller) is redirected by
   *  GameFlowManager (the ONE redirect) into `WORKBENCH_STOP` `{ chapter, missionsCompleted, firstDepotVisit, boundary
   *  }`: the hub rides the player down to the workbench floor at the crossing duration and opens the REFIT drawer (the
   *  one shop). The world is held under the drawer; `isDepotStopPending()` stays true until the hub emits
   *  `WORKBENCH_RESUME` `{ reason }` (both drawers closed; a ride up closes REFIT), which does what SHOP_DEPLOY did for
   *  the full-screen shop (saveGame + milestone recap). Neither key is ever emitted with the ladder off: the ?ladder=0
   *  boot keeps the full-screen ShopScreen byte-identical, and the GAME_OVER → SHOP continue (not gameplay) still uses
   *  it with the ladder on. */
  WORKBENCH_STOP:     'workbench:stop',
  WORKBENCH_RESUME:   'workbench:resume',
  GAMEOVER_RETRY:     'gameover:retry',
  GAMEOVER_MENU:      'gameover:menu',
  GAMEOVER_CONTINUE:  'gameover:continue',
  HUD_TARGET_CLICK:   'hud:targetClick',
  HUD_GROUP_ACTIVATE: 'hud:groupActivate',   // { group } — directly activate a HUD reveal-group
  // Once per mission when the HUD power-on stagger plays; drives the comms-crackle cue.
  HUD_POWER_ON:       'hud:powerOn',
  /** A tech library entry unlocked; consumed by SkillsPane (Discovery Pane "NEW TECH"). Separate from CODEX_UNLOCKED
   *  (full-screen viewer refresh + chime) so the two surfaces evolve independently. */
  TECH_UNLOCKED:      'tech:unlocked',        // { id, title, shortText, category } — tech entry unlocked

  // ACTIVE SATELLITES
  ACTIVE_SAT_PROXIMITY: 'activeSat:proximity',
  ACTIVE_SAT_COLLISION: 'activeSat:collision',

  // SENSOR
  SENSOR_UPGRADE:     'sensor:upgrade',
  SENSOR_UPGRADED:    'sensor:upgraded',
  SENSOR_QUERY_TARGETS:    'sensor:queryTargets',
  SENSOR_DETECTED_TARGETS: 'sensor:detectedTargets',

  // ACTIVE SCAN
  SCAN_QUICK:         'scan:quick',              // S key — quick ping scan
  SCAN_WIDE:          'scan:wide',               // W key — wide aperture deep scan
  SCAN_INITIATED:     'scan:initiated',           // { type: 'quick'|'wide' } — scan actually started (for audio/visual feedback)
  SCAN_COMPLETE:      'scan:complete',            // { type: 'quick'|'wide', results: {...} }
  SCAN_REVEALS_SETTLED: 'scan:revealsSettled',    // { revealed: number, scanType: 'quick'|'wide' } — staggered scan reveals finished discovering; scan auto-select fills the pane
  SCAN_DISCOVERY:     'scan:discovery',           // { debrisId, type, mass, salvage?: { hydrazine, metals[] } } — hidden debris found

  // KESSLER
  KESSLER_FRAGMENTS_ADDED: 'kessler:fragmentsAdded',
  KESSLER_WARNING:         'kessler:warning',
  KESSLER_CASCADE:         'kessler:cascadeTriggered',
  COLLISION_GAME_OVER:     'collision:gameOver',     // { reason } — KesslerSystem: shields depleted, GFM should game-over

  // UPGRADES
  UPGRADE_PURCHASED:  'upgrade:purchased',
  UPGRADE_V4_TECH:    'upgrade:v4Tech',
  UPGRADE_PINNED:     'upgrade:pinned',   // player pinned a shop upgrade as the next chase target

  // POWER
  POWER_CHANGED:      'power:changed',
  POWER_BUS_SELECTED: 'power:busSelected',

  // PERSISTENCE
  PERSISTENCE_SAVED:  'persistence:saved',
  PERSISTENCE_LOADED: 'persistence:loaded',
  PERSISTENCE_GATHER: 'persistence:gather',  // { saveData } — systems attach their state before save

  // CARGO
  CARGO_STORE:         'cargo:store',
  CARGO_UPDATED:       'cargo:updated',
  CARGO_SELL:          'cargo:sell',
  CARGO_FUEL_TRANSFER: 'cargo:fuelTransfer',

  // FORGE
  FORGE_TOGGLE:        'forge:toggle',   // the F key; the furnace itself is gone, the event feeds the journal skill + chapter beat

  // FUEL
  FUEL_CHANGED:        'fuel:changed',        // fuel type switched — { fuelId, name, isp, color }
  FUEL_DEPLETED:       'fuel:depleted',       // current fuel ran out

  // MARKET & CONTRACT
  CARGO_SELL_ALL:      'cargo:sellAll',
  CONTRACT_CONTRIBUTE: 'contract:contribute',
  CONTRACT_UPDATE:     'contract:update',
  CONTRACT_COMPLETE:   'contract:complete',

  // TRAWLING & EDT
  TRAWL_START:         'trawl:start',
  TRAWL_CAPTURE:       'trawl:capture',
  TRAWL_END:           'trawl:end',
  /**
   * Cancel an active trawl sweep — { reason } — TrawlManager ends it and emits TRAWL_SWEEP_COMPLETE so dependent flags
   * self-clear.
   */
  TRAWL_ABORT:         'trawl:abort',
  TRAWL_TARGET_ENTERING:      'trawl:target_entering',
  TRAWL_TARGET_EXITED:        'trawl:target_exited',
  TRAWL_TARGET_WINDOW_CLOSING: 'trawl:target_window_closing',
  EDT_DEPLOY:          'edt:deploy',
  EDT_RETRACT:         'edt:retract',
  EDT_ATTRACT:         'edt:attract',
  ROUTE_PLAN_UPDATE:   'route:planUpdate',

  // CLUSTER TRANSFER WINDOW
  CLUSTER_WINDOW_IMMINENT: 'cluster:windowImminent',  // T-minus threshold reached (beep/cyan)
  CLUSTER_WINDOW_OPEN:     'cluster:windowOpen',       // optimal departure window open ("burn now")

  // MISSION COACH BEATS (emitted by MissionCoach)
  MISSION_BEAT_STARTED:   'mission:beatStarted',   // { skillId, … } a coach beat now owns the screen
  MISSION_BEAT_SATISFIED: 'mission:beatSatisfied', // { skillId } the beat's action was performed

  // DELTAV TELEMETRY
  DELTAV_UPDATE:       'deltav:update',

  // CONJUNCTION
  CONJUNCTION_WARNING: 'conjunction:warning',  // { tier, debrisId, tca, distance, evasionVector }
  CONJUNCTION_CLEAR:   'conjunction:clear',    // alert expired
  /** Generic conjunction alert for gameplay red-lines that are not routine TCA warnings
   *  (e.g. arming against an active satellite). Payload: { severity: 'RED'|'YELLOW'|'GREEN', reason: string, targetId?,
   *  targetName?, norad? }; `reason` includes 'ACTIVE_SAT_ARMING' (treaty-violation guard). */
  CONJUNCTION_ALERT:   'conjunction:alert',

  // CATALOG (offline data catalogue)
  /** Fired once when CatalogLoader finishes initial META + file fetches.
   *  Payload: { ready: boolean, counts: { debris, active_sats, launches, weather_events, ground_stations, constellations }, version }
   *  `ready:false` indicates a load failure — systems must default to procedural/random behaviour. */
  CATALOG_LOADED:      'catalog:loaded',

  // REWARDS
  SYNERGY_BONUS:          'reward:synergyBonus',       // { name, points, metals }
  SWEEP_REPORT:           'reward:sweepReport',        // compiled sweep report data
  SWEEP_REPORT_DISMISSED: 'reward:sweepReportDismissed', // player closed report overlay
  TRAWL_SWEEP_COMPLETE:   'trawl:sweepComplete',       // trawl sweep finished { duration, targetsEntered }

  // TETHER DETACH
  ARM_DETACHED:           'arm:detached',              // { armId, position, fuelRemaining } — tether severed
  ARM_LOST:               'arm:lost',                  // { armId } — detached arm fuel depleted, inert

  // CODEX
  /** Internal event for CodexViewerUI + AudioSystem. See TECH_UNLOCKED for Discovery Pane. */
  CODEX_UNLOCKED:         'codex:unlocked',            // { id, title, shortText, icon, category }
  CODEX_VIEWED:           'codex:viewed',              // { id } — player viewed full entry
  CODEX_UNLOCK_REQUEST:   'codex:unlockRequest',       // { id } — force-unlock a specific entry (e.g. from tutorial)
  CODEX_OPEN_ENTRY:       'codex:open-entry',          // { id, anchor? } — deep-link: open the viewer on a specific entry; optional `anchor: 'warning'` lands on the page's .codex-warning

  // LASSO
  LASSO_FIRED:            'lasso:fired',               // { targetId, projectileMass, launchDirection, speed }
  LASSO_CONTACT:          'lasso:contact',
  LASSO_CAPTURED:         'lasso:captured',
  LASSO_DENIED:           'lasso:denied',
  LASSO_MISSED:           'lasso:missed',    // lasso fired but failed to capture
  LASSO_SNAPPED:          'lasso:snapped',   // { targetId, tensionN } — Phase 3 tether broke under strain (heavy catch dropped)
  LASSO_STOWED:           'lasso:stowed',    // { debrisId, podIndex } — catch reeled in, adopting onto the nose-collar berth (the one holding model); no cellIndex exists
  LASSO_COOLDOWN_START:   'lasso:cooldownStart',  // { duration } — cooldown timer began
  LASSO_COOLDOWN_END:     'lasso:cooldownEnd',    // {} — cooldown expired, ready to fire
  // No LASSO_AMMO_CHANGED: the mother's one net count rides on NET_INVENTORY_CHANGED { source:'mother', motherNets }
  // (DECISIONS §33).
  /** NetInventoryPanel: total capture-tool stocks crossed the low or critical thresholds in Constants.INVENTORY.
   *  Payload: { kind: 'lasso'|'nets'|'both', severity: 'low'|'critical', lasso: { remaining, max }, nets: { total, max
   *  } } */
  INVENTORY_LOW:          'inventory:low',

  // TOOL RECOMMENDATION
  TOOL_RECOMMENDED:       'tool:recommended',      // { tool: 'lasso'|'spinner'|'grapple'|'weaver'|'trawl'|'mother', targetId }
  TOOL_CYCLE:             'tool:cycle',             // T key — cycle tool alternatives
  // No TOOL_DEPLOY: deploy is via FOCUS_ACTION / F; T emits TOOL_CYCLE. Don't re-add.

  // DAUGHTER MULTI-TOOL
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
  PAD_BOUNCED:            'pad:bounced',            // { armId, targetId, reason: 'too_fast'|'timeout'|'no_mode'|'p_roll' }
  PAD_RELEASED:           'pad:released',           // { armId, targetId }
  PAD_UV_DOSE_USED:       'pad:uvDoseUsed',         // { armId, dosesRemaining }

  // FOCUS ACTION
  FOCUS_ACTION:           'focus:action',           // F key — context-sensitive smart action

  // TUTORIAL
  /** @deprecated Tutorial system removed. Kept for save-file compatibility; no emitters remain. */
  TUTORIAL_STAGE_CHANGED: 'tutorial:stage_changed',
  TUTORIAL_SKIPPED:       'tutorial:skipped',
  TUTORIAL_TETHER_LIMIT:  'tutorial:tetherLimitHit',
  TUTORIAL_ARROW_INPUT:   'tutorial:arrowInput',
  TUTORIAL_THROTTLE_INPUT:'tutorial:throttleInput',
  TUTORIAL_WASD_INPUT:    'tutorial:wasdInput',
  TUTORIAL_SCAN_INPUT:    'tutorial:scanInput',     // S or W key during tutorial
  TUTORIAL_TAB_INPUT:     'tutorial:tabInput',      // Tab during tutorial
  TUTORIAL_DEPLOY_INPUT:  'tutorial:deployInput',   // D key during tutorial
  /** Comma / Period strut deploy/stow. Payload: {} (fire-and-forget — OnboardingDirector subscribes). */
  STRUT_DEPLOY_INPUT:     'tutorial:strut_input',
  /** ROSA solar-array furl/unfurl toggle (Comma key). Fire-and-forget, for audio/telemetry parity with the strut toggle
   *  (NOT a tracked onboarding skill). Payload: { target: 0|1 } (0 = furling, 1 = unfurling). */
  ROSA_FURL_INPUT:        'tutorial:rosa_furl_input',
  /** ROSA solar-array feather toggle (Shift+Comma): parks the wings edge-on to a hazard
   *  (fast, retains more power than a full furl). Fire-and-forget, for audio/telemetry parity with the furl toggle.
   *  Payload: { feathered: boolean }. */
  ROSA_FEATHER_INPUT:     'tutorial:rosa_feather_input',
  /**
   * Mouse-wheel zoom or +/- zoom; once per wheel tick / keypress regardless of consumer. Payload: {} (fire-and-forget).
   */
  CAMERA_ZOOM_INPUT:      'tutorial:zoom_input',

  // THERMAL ('thermal:*' family)
  /** O key — aft flower deploy/stow toggle (all four struts; ROSA-furl input idiom). Fire-and-forget for
   *  audio/telemetry/codex parity. Payload: { deploying: boolean } (true = swinging to CARGO full bloom). */
  THERMAL_FLOWER_INPUT:   'thermal:flowerInput',
  /** Flower slew driver settled on its target pose (latch cleared). Payload:
   *  { thetaDeg: number, pose: 'STOW'|'PARK'|'CARGO'|'LAUNCH'|'CUSTOM' }
   *  ('LAUNCH' = θ 0, fore-folded along the barrel; reachable only under the one-shot launch lock). */
  THERMAL_FLOWER_POSE:    'thermal:flowerPose',
  /** The one-shot flower launch lock CLEARED: the release swing carried θ up through the orbit ladder floor (90°); from
   *  here the flower is an ordinary orbit actuator and the lock can never be re-armed from orbit. Emitted exactly once
   *  per arming, by the driver, the frame θ reaches the floor (before the pose latch settles). Payload:
   *  { thetaDeg: number }. */
  THERMAL_FLOWER_RELEASED: 'thermal:flowerReleased',
  /** The radiator was deliberately VENTED past the 146° thrust band to POSE_VENT_DEG, by a double-command into the bud.
   *  The drive is inhibited there under the pose-band law, and metal FEEP exhaust would plate the panels — the COMMS
   *  warning says so. Emitted once per push-through by PlayerSatellite._warnFlowerVent. Payload: { thetaDeg: number }. */
  THERMAL_FLOWER_VENTED:  'thermal:flowerVented',

  // ONBOARDING (bottom-screen hint ticker + director)
  /** OnboardingDirector posts a hint to the bottom-screen ticker.
   *  Payload: { id, text, glyph?, keys?:string[], skillId?, duration?, priority?:'normal'|'high' }
   *  Re-emitting the same `id` while the hint is alive is a no-op (idempotent). */
  HINT_POSTED:            'hint:posted',
  /** Trigger fired — fade the bottom-screen hint that matches `id`.
   *  Payload: { id } */
  HINT_SATISFIED:         'hint:satisfied',
  /** First-ever entry into the onboarding pipeline (fresh save). CommsSystem suppresses non-HOUSTON INFO noise while it
   *  runs; HUD panels (NetInventoryPanel) defer their reveal until onboarding completes. Payload: {} */
  ONBOARDING_STARTED:     'onboarding:started',
  /** The tutorial is over: the rest of the game switches on (collision consequences, teaching cards, bounties,
   *  tips...). Fired once per run: at the tutorial's real end right after ONBOARDING_MASTERED, by the veteran skip, or
   *  by an all-done start. Payload: {} — or { atTutorialEnd: true } at the tutorial's real end
   *  (DebrisField then keeps uncaught welcome pieces held). */
  ONBOARDING_COMPLETE:    'onboarding:complete',
  /** The tutorial's beat list is finished (the `final` beat's timer, the aim-slew end, or an all-done start). Fired
   *  ONCE per run by OnboardingDirector (reset() re-arms it); CommsSystem leaves tier 0 and lets the useful lines
   *  through. ONBOARDING_COMPLETE follows it on these paths; the veteran skip emits ONBOARDING_COMPLETE alone. Payload:
   *  {} */
  ONBOARDING_MASTERED:    'onboarding:mastered',
  /** Guidance depth changed by the behavior-driven tuner or Settings toggle.
   *  Payload: { level: 'GUIDED'|'POINTERS'|'MINIMAL', reason: string } */
  GUIDANCE_LEVEL_CHANGED: 'guidance:levelChanged',
  /** Front-arc autolock assist toggled in Settings. Payload: { enabled: boolean } */
  AUTOLOCK_SETTING_CHANGED: 'guidance:autolockChanged',
  /** OnboardingDirector escalation: feed a synthetic TeachingMoment into TeachingSystem's queue
   *  (bypasses the once-per-save guard). Payload: { id, title, body, duration?, icon? } */
  TEACHING_MOMENT_FORCE:  'teaching:force',

  // SKILLS DISCOVERY
  SKILL_DISCOVERED:     'skill:discovered',        // { skillId, tier, label }
  SKILL_REMINDED:       'skill:reminded',           // { skillId }
  SKILL_STATE_CHANGED:  'skill:stateChanged',       // { skillId, from, to }
  /** Fired after a skill transitions to MASTERED state.
   *  Payload: { skillId: string, label: string, tier: number, category: string }
   *  Only the skills pane listens (row flash); no popup or sound (owner 2026-10-21). */
  MASTERY_FANFARE:      'skill:masteryFanfare',
  SKILL_GATE_UNLOCKED:  'skill:gateUnlocked',       // { skillId }
  SKILLS_PANE_TOGGLE:   'skills:paneToggle',        // { expanded: bool }
  SKILLS_LOADED:        'skills:loaded',            // { skills: Map }

  // INPUT / CAMERA (Skills Discovery triggers)
  CAMERA_ZOOM:          'camera:zoom',              // scroll wheel zoom (any view)
  CAMERA_ORBIT_DRAG:    'camera:orbitDrag',         // mouse drag in orbit view
  CAMERA_FREE_LOOK:     'camera:freeLook',          // mouse free-look in first-person
  AUTOPILOT_NO_TARGET:  'autopilot:noTarget',       // A key with no selected target
  COMMS_OPENED:         'comms:opened',             // C key comms toggle
  CODEX_OPENED:         'codex:opened',             // L key codex opened
  SHOP_OPENED:          'shop:opened',              // Shop screen displayed (teaching trigger)
  ORBIT_MFD_TOGGLE:     'orbitMfd:toggle',          // UNEMITTED: M opens the Debris Map; the Orbit MFD has no toggle key

  // SPACE WEATHER
  WEATHER_EFFECT_START:   'weather:effectStart',       // { type, effects, duration }
  WEATHER_EFFECT_END:     'weather:effectEnd',         // { type }
  WEATHER_ACTIVE:         'weather:active',            // every update — merged active effects

  // UPGRADE (Propellant Teaching trigger)
  UPGRADE_APPLIED:        'upgrade:applied',           // { id, name } — upgrade applied to ship

  // SUBSYSTEMS
  SUBSYSTEM_EVENT:        'subsystem:event',           // generic subsystem event for logging
  GROUND_STATION_PASS:    'ground:stationPass',        // ground station in view

  // AUDIO & POLISH
  ARM_APPROACH_PING:      'arm:approachPing',          // { distanceFraction, armId }
  TETHER_TENSION:         'tether:tension',            // { tensionFraction, armId }
  SALVAGE_REVEAL:         'salvage:reveal',            // { metals, totalMass, debrisType }
  WIREFRAME_ASSESSED:     'wireframe:assessed',        // {} — DebrisWireframe: player cycled all zones

  // THROTTLE
  THROTTLE_CHANGE:        'throttle:change',           // { level } — 0.0–1.0 throttle level

  // AUTOPILOT
  AUTOPILOT_ENGAGE:       'autopilot:engage',          // { mode: 'TARGET'|'TRAWL'|'DEBRIS'|'PROGRADE' }
  AUTOPILOT_DISENGAGE:    'autopilot:disengage',       // { reason: 'MANUAL'|'DELTAV'|'COLLISION'|'ARROW_INPUT'|'TRAWL' }
  AUTOPILOT_ARRIVED:      'autopilot:arrived',         // { mode } — AP reached target, holding heading
  AUTOPILOT_TARGET_LOCK:   'autopilot:targetLock',     // { debrisId } — AP acquired a debris lock (exempt from CA)
  AUTOPILOT_TARGET_UNLOCK: 'autopilot:targetUnlock',   // { debrisId } — AP released debris lock

  // AIM-BEFORE-LAUNCH
  AIM_SEQUENCE_START:     'aim:sequenceStart',         // { mode: 'net'|'daughter'|'turn' }
  AIM_SEQUENCE_END:       'aim:sequenceEnd',           // { mode: 'net'|'daughter'|'turn', result: 'resolved'|'rejected', reason? }
  MOTHER_MANUAL_ROTATE:   'mother:manualRotate',       // arrow-key attitude input in mother mode (cancels aim seq)

  // THRUST VISUAL
  THRUST_VISUAL:          'thrust:visual',             // { magnitude, direction, type }

  // MPD THRUSTER
  LITHIUM_CHANGE:         'resource:lithium_change',   // { lithium, lithiumMax, delta }

  // MPD BURST MODE
  MPD_BURST_START:        'mpd:burstStart',            // { armed } — no emitter (the arming verb was deleted); codexTriggers mpd_burst still names it
  MPD_BURST_END:          'mpd:burstEnd',              // { reason: 'manual'|'overheat'|'battery_depleted'|'lithium_depleted' }

  // CONTROL MODE
  CONTROL_MODE_CHANGE:    'control:modeChange',        // { mode: 'RCS'|'COLD_GAS'|'ARM_PILOT'|'MPD_BURST' }

  // CROSSBOW

  // Lifecycle
  CROSSBOW_FIRE:            'crossbow:fire',             // { armIndex, speed, springTier, armMass, launchDirection, launchPosition, launchMassKg }
  CROSSBOW_RELOAD_START:    'crossbow:reloadStart',      // { armIndex, duration }
  CROSSBOW_RELOAD_COMPLETE: 'crossbow:reloadComplete',   // { armIndex }

  // Tether
  TETHER_TENSION_UPDATE:    'tether:tensionUpdate',      // { armIndex, tension, fraction }
  TETHER_SNAP:              'tether:snap',               // { armIndex, cause }
  TETHER_REEL_STATE:        'tether:reelState',          // { armIndex, reeling, speed }

  // Reel-in / re-dock inertia (FEATURE_FLAGS.REEL_PROFILE_V2)
  /** Stage-1 net cinched tight; daughter+net+debris is now one rigid unit. Payload: { armIndex, debrisId, mUnit } */
  CATCH_SNUGGED:            'reel:catchSnugged',
  /** Daughter entered the FEEP soft-dock arrest window. Payload: { armIndex, mUnit, vArrest } */
  REDOCK_ARREST_START:      'reel:redockArrestStart',
  /** Re-dock arrest could not be funded by FEEP (or plume blocked) → slow reel-only finish. Payload: { armIndex, fuel, needed } */
  REDOCK_FUEL_LOW:          'reel:redockFuelLow',

  // Dual-fire
  DUAL_FIRE:                'crossbow:dualFire',         // { armIndex1, armIndex2 }
  DUAL_FIRE_RECOIL:         'crossbow:dualFireRecoil',   // { cancelled, residualDv }
  PAIR_LESSON_SKIP:         'mission:pairLessonSkip',    // { reason } the Mission 2 double-shot lesson cannot be set up: MissionCoach ends the beat

  // Pulse scan
  PULSE_SCAN_START:         'pulseScan:start',           // { armCount }
  PULSE_SCAN_COMPLETE:      'pulseScan:complete',        // { detections[] }

  // Ablation
  ABLATION_START:           'ablation:start',            // { armIndex, targetId }
  ABLATION_END:             'ablation:end',              // { armIndex, despinAchieved }
  DESPIN_IN_SPEC:           'despin:inSpec',             // { targetId, tumbleDeg } target detumbled below net-safe spin

  // COLLISION AVOIDANCE
  CA_THREAT_DETECTED:       'ca:threatDetected',         // { debrisId, tca, missDistance, evasionVector }
  // Dodge magnitude is a real, geometry-driven Δv (m/s) billed through applyCartesianImpulse; `insufficient: true` when
  // DODGE_DV_CEILING_MS clamped it below what the geometry needed (CA_DODGE_INSUFFICIENT fires alongside).
  CA_DODGE_EXECUTED:        'ca:dodgeExecuted',          // { debrisId, direction, magnitude, insufficient }
  CA_DODGE_INSUFFICIENT:    'ca:dodgeInsufficient',      // { debrisId, magnitude, requiredDvMs } — fired burn could not fully clear
  CA_DODGE_REFUSED:         'ca:dodgeRefused',           // { debrisId, reason, requiredDvMs } — no burn, no orbit change
  CA_THREAT_CLEARED:        'ca:threatCleared',          // { debrisId }
  CA_TOGGLED:               'ca:toggled',                // { enabled }
  CA_SUPPRESSED:            'ca:suppressed',             // { debrisId, reason }

  // DEBRIS MAP
  DEBRIS_MAP_CLUSTER_SELECTED: 'debrisMap:clusterSelected',  // { clusterId, name?, count? }

  // CLUSTER CLEARING
  /** The last alive member of an orbital cluster bucket was removed via active capture/deorbit. Anchors the "field
   *  cleared" ceremony + bonus onto the guided loop. Payload: { clusterId: string, name: string, count: number } */
  CLUSTER_CLEARED:     'cluster:cleared',

  // ENVIRONMENT HAZARDS
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

  // NOTIFICATION ZONE
  /** Transient pilot notification (bottom-center). Payload: { text: string, duration?: number, kind?: string } —
   *  `kind`: 'prompt' (default) | 'confirm' | 'notice' | 'view' | 'inspect' | 'memo' | 'alert-red' | 'alert-amber'; the
   *  HUD's engaged toast policy drops the kinds below prompt (TOAST_DROP_WHILE_ENGAGED) and the alert hierarchy
   *  (ui/hud/AlertHierarchy.js) levels the rest. */
  SHOW_NOTIFICATION:      'ui:showNotification',

  // HUD PANE DENSITY
  /** Bare `-`: hide the lowest-priority visible HUD pane (one rung per press; last press = pure space scenery). Emitted
   *  by InputManager, consumed by the PaneDensity ladder. Payload: {} */
  HUD_DENSITY_DOWN:       'hud:densityDown',
  /** Bare `+`/`=`: restore the highest-priority hidden HUD pane (reverse of HUD_DENSITY_DOWN). Payload: {} */
  HUD_DENSITY_UP:         'hud:densityUp',
  /** A HUD pane's ONE visibility bit flipped on a PLAYER edge. Emitted AFTER the bit flips by the four edges that
   *  change it without a floor change: TargetPanel.toggleVisible (0 key), DebrisWireframe.toggleMinimized
   *  (9 key; its two visibility-bit paths, never the minimize fold), NavSphere.toggleMinimized
   *  (8 key; the un-hide path, the minimize fold is not the intent bit), and the PaneDensity ladder
   *  (`-`/`+`/iPad slider; once per FLIPPED rung, via HUD's onFlip wire; PaneDensity itself stays EventBus-free). No-op
   *  presses emit nothing. The emitters fire regardless of the ladder; the ONE consumer lives inside main.js's
   *  LADDER.ENABLED gate → LadderController.noteRoomChange() → FloorMask.capture() → the player store
   *  (write-on-change), so a ?ladder=0 boot registers no listener and does no work. Payload: { pane, shown } — pane =
   *  the density rung id ('targets', 'debris', 'navsphere', …); shown = the bit's new value. */
  HUD_PANE_VISIBILITY:    'hud:paneVisibility',

  // STATION_KEEP & FEEP
  /** Orbit adjust input. Payload: { armId, theta, phi, radius, fine, dt } */
  ARM_ORBIT_ADJUST:        'arm:orbit_adjust',
  /** Arm entered station-keep. Payload: { armId, targetId, standoffR } */
  STATION_KEEP_ENTERED:    'arm:stationKeepEntered',
  /** Arm exited station-keep. Payload: { armId, reason: 'capture'|'recall'|'fuel'|'lost' } */
  STATION_KEEP_EXITED:     'arm:stationKeepExited',
  /** FEEP propellant metal changed. Payload: { armId, metal, ispRange } */
  FEEP_METAL_CHANGED:      'arm:feepMetalChanged',
  /** News/bounty event triggered. Payload: { eventId, name, bounty, debris[] } */
  NEWS_EVENT_TRIGGERED:    'mission:newsEventTriggered',

  // Dual-fire
  /** Daughter net-fire recoil kick (FEATURE_FLAGS.DAUGHTER_NET_RECOIL); visuals hook (counter-burn flash), emitted by
   *  ArmUnit.applyNetFireRecoil. Payload: { armIndex, armId, dv: {x,y,z} (m/s, world axes), dvMps, netClass } */
  ARM_RECOIL_KICK:         'arm:recoilKick',

  // Opening dance: the deployment cinematic that replaces the launch sequence at boot. Starts in the MENU as the EVA
  // astronaut jets off the hull and finishes at the ship with the player taking the wheel. TWO completion points: the
  // camera hands over at HANDOVER (radiator and solar wings done) while the daughters keep opening to 146° for ~7.8 s
  // with the player already flying.
  /** The opening's camera hand-over: the camera pulls back to F2 and control is the player's. Payload: {} */
  OPENING_DANCE_HANDOVER:    'openingDance:handover',
  /** The dance's last beat is done; the dance owns nothing any more. Payload: {} */
  OPENING_DANCE_COMPLETE:    'openingDance:complete',

  // Capture net
  /** Net projectile launched. Payload: { source:'mother'|'daughter', armIndex?, podIndex?, netClass, remaining } */
  NET_FIRED:                 'net:fired',
  /** A lassoed catch was ADOPTED onto the nose collar as a fresh BERTHED mother net (CaptureNetSystem.adoptLassoCatch).
   *  Only consumer: CaptureNetVisual, which attaches the standard berthed-bag visual
   *  (adoption suppresses NET_FIRED / NET_BERTHED / NET_CEREMONY_START, so without this the catch would sit at the nose
   *  as a bare icosahedron). Payload: { podIndex, armIndex:-1 } */
  NET_ADOPTED:               'net:adopted',
  /** Net hit target and secured debris. Payload: { armIndex, podIndex, debrisId, tangleQuality, capturedMass, mode } */
  NET_CATCH_SUCCESS:         'net:catchSuccess',
  /** Net missed / cling failed. Payload: { armIndex, podIndex, debrisId?, probability?, reason } */
  NET_CATCH_MISS:            'net:catchMiss',
  /** §11.2 mouth-collapse floor: in-flight rim tension fell below CAPTURE_NET.MOUTH_TENSION_FLOOR_N; the bag mouth is
   *  collapsed and any contact resolves as a 'mouth_collapsed' MISS. Emitted once per net at the latch
   *  (also queryable as NetProjectile.mouthCollapsed / .rimTensionN). Payload:
   *  { armIndex, podIndex, netClass, flightTime, rimTensionN } */
  NET_MOUTH_COLLAPSED:       'net:mouthCollapsed',
  /** Reel-in motor started. Payload: { armIndex, podIndex, hasCatch } */
  NET_REEL_STARTED:          'net:reelStarted',
  /** Reel-in completed — debris at strut tip / pod. Payload: { armIndex, podIndex, capturedMass, debrisId?, releasedMass? }
   *  capturedMass is what the reel DELIVERED. A failure stow (the arm lost the held catch: integrity slip / boost rip /
   *  tether-snap drift-end /
   *  reset drop) reports capturedMass 0 and the lost catch's mass as releasedMass (0 on every other path). */
  NET_REEL_COMPLETED:        'net:reelCompleted',
  /** Player aborted — net + debris released. Payload: { armIndex, podIndex, debrisId? } */
  NET_RELEASED:              'net:released',
  /** Mother catch berthed at the launcher. Payload: { debrisId, mass, podIndex } */
  NET_BERTHED:               'net:berthed',
  /** Line-taut tug on a mother catch. Fired once at CAPTURED with the imparted Δv so the camera can scale the whale-tug
   *  micro-shake. Payload: { podIndex, dvMs, windowS } */
  NET_MOTHER_TUG:            'net:motherTug',
  /** Net lost grip on a captured catch (recoverable). Payload: { armId, armIndex, debrisId, strain, recoverable } */
  NET_FAILED:                'net:failed',
  /** The net TORE (boost-reel rip): hook for the visible tear (a wedge of spokes zeroed in the bag's colour buffer) and
   *  for audio/comms/teaching. Payload: { armId, armIndex, debrisId, strain } */
  NET_TORN:                  'net:torn',
  /** Net inventory changed (fire/reload). Payload: { source:'mother'|'daughter', armIndex?, podInventory?, remaining? } */
  NET_INVENTORY_CHANGED:     'net:inventoryChanged',
  /** Cross-debris warning during flight. Payload: { netId, crossDebrisId } */
  NET_CROSS_DEBRIS_WARNING:  'net:crossDebrisWarning',
  /** Fragmentation event. Payload: { debrisId, fragmentCount, mercyApplied } */
  NET_FRAGMENTATION:         'net:fragmentation',
  /** Close-range survey completed — Full Profile unlocked for one debris. Payload: { debrisId, target, bountyPaid } */
  DEBRIS_PROFILED:           'debris:profiled',
  /** First successful cinch capture (for TeachingSystem). Payload: { debrisId } */
  CINCH_FIRST_SUCCESS:       'net:cinchFirstSuccess',
  /** Net empty click — F-press with 0 nets remaining. Payload: { armId } */
  NET_EMPTY_CLICK:           'net:emptyClick',

  // Net-launch ceremony
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
  /** Camera entered NET_CINEMATIC (the ceremony cut is live on screen). Distinct from NET_CEREMONY_START
   *  (the net FSM's intent): fires only when CameraSystem actually takes the view, so HUD cinema-dim can never latch on
   *  a ceremony the camera refused (no launcher / launch ceremony active). Payload: { armIndex, podIndex, isFirstEver } */
  NET_CINEMATIC_ENTERED:     'net:cinematicEntered',
  /** Camera left NET_CINEMATIC (beats done, miss truncation, skip, or an
   *  external view change aborting the ceremony). Always paired with a prior
   *  NET_CINEMATIC_ENTERED. Payload: { completedNormally: boolean } */
  NET_CINEMATIC_EXITED:      'net:cinematicExited',

  // AUDIO UNLOCK
  /** AudioContext still suspended 200ms after first user gesture.
   *  Payload: {} */
  AUDIO_UNLOCK_FAILED:       'audio:unlockFailed',

  // PERFORMANCE / QUALITY TIER
  /** Quality tier changed by QualityManager (initial selection or runtime auto-downshift).
   *  Payload: { from: 'HIGH'|'MEDIUM'|'LOW', to: 'HIGH'|'MEDIUM'|'LOW', reason: string } */
  PERF_TIER_CHANGED:         'perf:tier-changed',

  // LAUNCH LINE (ArmManager keep-out gate)
  /** A daughter launch was refused: a part of the ship is in the way (or opening struts never cleared it in 8 s).
   *  Payload: { armIndex, armId, part: plain-words part, cat: 'hull'|'wing'|'rad'|'nose'|'strutN'|'dauN'|'catch', reason: 'blocked'|'timeout' } */
  ARM_LAUNCH_HELD:           'arm:launchHeld',
};

export default Events;
