/**
 * soundVocabulary.js — the audio design law, made enforceable.
 *
 * Audio Vocabulary Overhaul (2026-07-23, P7). Every remaining play/start
 * sound method on AudioSystem is registered here with its family, its single
 * meaning, and the trigger that fires it. The taxonomy (see the plan's "Design
 * law" table) is now testable: `audio-vocabulary.test.js` fails CI if a sound
 * is added without a classification, if an entry points at a missing method, or
 * if two sounds claim the same meaning.
 *
 * Families: PHYSICAL | RADIO | PING | TICK | DENY | ALARM | REWARD | PAD.
 * (`meaning` strings MUST be unique — one sound = one meaning.)
 *
 * @typedef {Object} VocabEntry
 * @property {'PHYSICAL'|'RADIO'|'PING'|'TICK'|'DENY'|'ALARM'|'REWARD'|'PAD'} family
 * @property {string} meaning — the single thing this sound says.
 * @property {string} trigger — what fires it.
 *
 * @type {Record<string, VocabEntry>}
 */
export const soundVocabulary = {
  // ---- PHYSICAL — a mechanical event actually happened (self-labeling) ----
  playMagnetic:        { family: 'PHYSICAL', meaning: 'magnetic field hum',        trigger: 'magnetic capture assist' },
  playCatchClamp:      { family: 'PHYSICAL', meaning: 'net clamp on catch',        trigger: 'ARM_CAPTURED' },
  playCollision:       { family: 'PHYSICAL', meaning: 'collision impact',          trigger: 'GAME_KESSLER' },
  playNetWhoosh:       { family: 'PHYSICAL', meaning: 'net launch whoosh',         trigger: 'net fired at target' },
  playDockClick:       { family: 'PHYSICAL', meaning: 'arm docked to mother',      trigger: 'arm dock' },
  playArmDeploy:       { family: 'PHYSICAL', meaning: 'arm deployed',              trigger: 'arm deploy' },
  playTetherSnap:      { family: 'PHYSICAL', meaning: 'tether snap',               trigger: 'tether snap' },
  playDeorbitBurn:     { family: 'PHYSICAL', meaning: 'deorbit burn',              trigger: 'arm deorbit sacrifice' },
  playCargoStored:     { family: 'PHYSICAL', meaning: 'cargo stored',              trigger: 'cargo stored' },
  playEvaPuff:         { family: 'PHYSICAL', meaning: 'EVA thruster puff',         trigger: 'astronaut departure jets' },
  playTetherTension:   { family: 'PHYSICAL', meaning: 'tether tension creak',      trigger: 'TETHER_TENSION' },
  playLassoFire:       { family: 'PHYSICAL', meaning: 'lasso fire',                trigger: 'lasso launched' },
  startLassoWireWhistle:{ family: 'PHYSICAL', meaning: 'lasso wire whistle',       trigger: 'lasso wire in flight' },
  playLassoWinch:      { family: 'PHYSICAL', meaning: 'lasso winch',               trigger: 'lasso reel-in' },
  playMPDArm:          { family: 'PHYSICAL', meaning: 'MPD burst armed',           trigger: 'MPD_BURST_START' },
  playMPDDisarm:       { family: 'PHYSICAL', meaning: 'MPD burst disarmed',        trigger: 'MPD burst end' },
  startForgeHum:       { family: 'PHYSICAL', meaning: 'forge hum',                 trigger: 'forge active' },
  startThrusterHum:    { family: 'PHYSICAL', meaning: 'thruster hum',              trigger: 'thrust active' },

  // ---- RADIO — comms channel activity ----
  playCommsCrackle:    { family: 'RADIO', meaning: 'comms channel activity',       trigger: 'comms online at mission handoff (squelch only — no blips)' },
  playRadioNotice:     { family: 'RADIO', meaning: 'comms message notice',         trigger: 'comms priority message' },

  // ---- PING — sensor/lock/docking state change ----
  playTerminalBlip:    { family: 'PING', meaning: 'terminal/manifest row reveal',  trigger: 'salvage manifest typewriter (silent during mission-start grace)' },
  playApproachBeep:    { family: 'PING', meaning: 'approach proximity beep',       trigger: 'ARM_APPROACH_PING' },
  playTargetLock:      { family: 'PING', meaning: 'sensor lock acquired',          trigger: 'target in net range / manual lock' },
  playTargetLost:      { family: 'PING', meaning: 'sensor lock lost',          trigger: 'player deselect / lock lost while target persists (capture+removal clears are silent)' },
  playDockingBeep:     { family: 'PING', meaning: 'docking range beep',            trigger: 'docking reticle range tier' },
  playWindowImminent:  { family: 'PING', meaning: 'transfer window imminent',      trigger: 'CLUSTER_WINDOW_IMMINENT' },
  playWindowOpen:      { family: 'PING', meaning: 'transfer window open',          trigger: 'CLUSTER_WINDOW_OPEN' },
  startAlignmentTone:  { family: 'PING', meaning: 'docking alignment tone',        trigger: 'docking alignment held' },
  playAPEngage:        { family: 'PING', meaning: 'autopilot engaged',             trigger: 'AUTOPILOT_ENGAGE (off->on)' },
  playAPDisengage:     { family: 'PING', meaning: 'autopilot disengaged',          trigger: 'AUTOPILOT_DISENGAGE' },
  playAPArrived:       { family: 'PING', meaning: 'autopilot arrived',             trigger: 'AUTOPILOT_ARRIVED' },
  playScan:            { family: 'PING', meaning: 'sensor scan sweep',             trigger: 'SCAN_INITIATED' },

  // ---- TICK — your input registered ----
  playClick:           { family: 'TICK', meaning: 'input registered',              trigger: 'UI click / key press' },
  playFuelCycle:       { family: 'TICK', meaning: 'fuel type cycled',              trigger: 'T key fuel cycle' },

  // ---- DENY — input refused, nothing broke ----
  playDeny:            { family: 'DENY', meaning: 'input refused',                 trigger: 'invalid/empty action, LASSO_DENIED, shop refusal' },

  // ---- ALARM — danger, act now (repeats until resolved / outranks all) ----
  playWarning:         { family: 'ALARM', meaning: 'danger warning',               trigger: 'ARM_EXPENDED / Whipple / impact' },
  playGameOver:        { family: 'ALARM', meaning: 'game over',                    trigger: 'GAME_OVER' },
  playFailBuzz:        { family: 'ALARM', meaning: 'catch failed (arm lost)',      trigger: 'ARM_CAPTURE_FAILED' },
  playWeatherAlert:    { family: 'ALARM', meaning: 'space weather alert',          trigger: 'weather alert' },
  playConjunctionAlert:{ family: 'ALARM', meaning: 'conjunction proximity alert',  trigger: 'conjunction tier' },
  playMPDOverheat:     { family: 'ALARM', meaning: 'MPD overheat',                 trigger: 'MPD overheat' },

  // ---- REWARD — you gained something ----
  playCaptureSuccess:  { family: 'REWARD', meaning: 'debris captured',             trigger: 'ARM_RETURNED' },
  playScoreTally:      { family: 'REWARD', meaning: 'score tick (reserved HUD count-up)', trigger: 'reserved (unsubscribed)' },
  playVictory:         { family: 'REWARD', meaning: 'run victory',                 trigger: 'victory' },
  playForgeComplete:   { family: 'REWARD', meaning: 'forge complete',              trigger: 'forge done' },
  playTrawlCapture:    { family: 'REWARD', meaning: 'trawl catch',                 trigger: 'trawl capture' },
  playSalvageReveal:   { family: 'REWARD', meaning: 'salvage revealed',            trigger: 'salvage reveal' },
  playCodexUnlock:     { family: 'REWARD', meaning: 'codex entry unlocked',        trigger: 'codex unlock' },
  playSweepComplete:   { family: 'REWARD', meaning: 'trawl sweep complete',        trigger: 'TRAWL_SWEEP_COMPLETE' },
  playFieldCleared:    { family: 'REWARD', meaning: 'field/cluster cleared milestone', trigger: "AUDIO_CUE{cue:'fieldCleared'}" },
  playCashRegister:    { family: 'REWARD', meaning: 'credits earned',              trigger: 'SCORING_AWARD' },
  playPurchase:        { family: 'REWARD', meaning: 'credits spent (shop)',        trigger: 'shop purchase' },
  playPracticeChime:   { family: 'REWARD', meaning: 'practiced-skill transition',  trigger: 'skill PRACTICED' },
  playMasteryFanfare:  { family: 'REWARD', meaning: 'mastered-skill transition',   trigger: 'skill MASTERED' },
  playHintPost:        { family: 'REWARD', meaning: 'onboarding hint posted',      trigger: "AUDIO_CUE{cue:'hint_post'} (silent during mission-start grace)" },

  // ---- PAD — scene transition mood ----
  startAmbientLoop:    { family: 'PAD', meaning: 'ambient engine-room loop',       trigger: 'gameplay ambient (opt-in)' },
  playDepartureSwell:  { family: 'PAD', meaning: 'departure scene swell',          trigger: 'astronaut departure' },
};

export default soundVocabulary;
