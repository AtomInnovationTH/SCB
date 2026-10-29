/**
 * The ONE key→gesture table, consulted at RENDER time.
 *
 * Every verb hint names a KEY (ticker `keys: ['KeyN']` chip, TargetAcquisition's "[N] net · [D] daughter", the stall
 * card's "Press N to launch the net.", MissionMilestones' `keys: ['M']`). On a touch device the same hint must
 * render its GESTURE ("HOLD → NET", "TAP → SELECT", "PINCH → ZOOM"). The DATA stays key-based everywhere; only the
 * presenters (HintTicker, TeachingOverlay) consult this table when they paint, so desktop is byte-identical: with
 * the switch off `chipFor` is always null and `speak` returns the very string instance it was handed.
 *
 * Pure statics: no DOM, no eventBus, no Constants. The module switch (`setGlass`) defaults OFF; the hub (main.js)
 * flips it exactly once under its `TouchControls.detect()` gate. Tests that turn it on MUST turn it back off in a
 * `finally` — the switch is process-global.
 *
 * Grammar of `speak(text)` on glass (idempotent: a rewritten string contains no lone bracketed / parenthesised
 * capital or "Press X" token):
 *   `[N]`      → `[HOLD → NET]`                (bracketed single capital)
 *   `(N)`      → `(HOLD → NET)`                (parenthesised single capital)
 *   `Press N`  → `Hold the target for NET`     (word-bounded, single capital;
 *   `press N`  → `hold the target for NET`      the phrase takes the verb's case)
 * Letters without a table row (`[Q]`, `[K]` jettison, `(F)` forge, `(L)` despin, `[V]` view) and everything else
 * (lower-case letters, multi-key tokens like `[1-4]` / `[Shift+R]`, digits) are left untouched.
 *
 * @module ui/hud/GestureHints
 */

/** @typedef {{ chip: string, phrase: string }} GestureRow */

/**
 * Key code → { chip, phrase }. `chip` is the ticker's key-chip text (short, caps, gesture → verb); `phrase` is the
 * prose replacement for a "Press X" fragment. Frozen: nothing may edit rows.
 * @type {Readonly<Record<string, Readonly<GestureRow>>>}
 */
const TABLE = Object.freeze({
  // Left thumb: long-press the selected target → radial verbs; NET and DAUGHTER are hold-to-fire.
  KeyN:  Object.freeze({ chip: 'HOLD → NET',        phrase: 'hold the target for NET' }),
  KeyD:  Object.freeze({ chip: 'HOLD → DAUGHTER',   phrase: 'hold the target for DAUGHTER' }),
  KeyA:  Object.freeze({ chip: 'HOLD → AUTOPILOT',  phrase: 'hold the target for AUTOPILOT' }),
  KeyR:  Object.freeze({ chip: 'HOLD → REEL',       phrase: 'hold the target for REEL' }),
  KeyS:  Object.freeze({ chip: 'TAP EMPTY → SCAN',  phrase: 'tap empty space to scan' }),
  // ONE selection universe (HUD_TARGET_CLICK).
  Tab:   Object.freeze({ chip: 'TAP → SELECT',      phrase: 'tap a target to select it' }),
  KeyT:  Object.freeze({ chip: 'TAP → SELECT',      phrase: 'tap a target to select it' }),
  Enter: Object.freeze({ chip: 'TAP → SELECT',      phrase: 'tap a target to select it' }),
  // Left thumb: the turn pad (lower left); the rest of the glass looks.
  ArrowUp:        Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  ArrowDown:      Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  ArrowLeft:      Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  ArrowRight:     Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  Equal:          Object.freeze({ chip: '− / + → HUD PANES', phrase: 'fewer / more HUD panes' }),
  Minus:          Object.freeze({ chip: '− / + → HUD PANES', phrase: 'fewer / more HUD panes' }),
  NumpadAdd:      Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  NumpadSubtract: Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  PageUp:         Object.freeze({ chip: 'PINCH → FLOOR', phrase: 'pinch to change floor' }),
  PageDown:       Object.freeze({ chip: 'PINCH → FLOOR', phrase: 'pinch to change floor' }),
  KeyM:           Object.freeze({ chip: 'PINCH OUT → MAP', phrase: 'pinch out to the map' }),
  // The drawer: the right edge-band swipe (ONE workbench pane on the RIGHT; the left band opens nothing, so B (shop)
  // and I (library) teach the same swipe).
  KeyI:   Object.freeze({ chip: 'SWIPE ← SPECS',  phrase: 'swipe in from the right edge for SPECS' }),
  KeyB:   Object.freeze({ chip: 'SWIPE ← SPECS',  phrase: 'swipe in from the right edge for SPECS' }),
  Space:  Object.freeze({ chip: 'HOLD → ACT',     phrase: 'hold to act' }),
  Escape: Object.freeze({ chip: 'SWIPE → CLOSE',  phrase: 'swipe the drawer closed' }),
  // 1-4 pick a daughter; on glass a tap on her row in the DAUGHTERS list sends the same Digit key (StatusPanel).
  Digit1: Object.freeze({ chip: 'DAUGHTERS', phrase: 'tap her row in DAUGHTERS' }),
  Digit2: Object.freeze({ chip: 'DAUGHTERS', phrase: 'tap her row in DAUGHTERS' }),
  Digit3: Object.freeze({ chip: 'DAUGHTERS', phrase: 'tap her row in DAUGHTERS' }),
  Digit4: Object.freeze({ chip: 'DAUGHTERS', phrase: 'tap her row in DAUGHTERS' }),
  // The two floor-1 buttons the comms lines name: wings (`,`) and radiator (O); pinch down to floor 1.
  Comma:  Object.freeze({ chip: 'FLOOR 1 → WINGS',      phrase: 'tap WINGS on floor 1' }),
  KeyO:   Object.freeze({ chip: 'FLOOR 1 → RADIATORS',  phrase: 'tap RADIATORS on floor 1' }),
});

/** The module switch. OFF by default — desktop never consults the table. */
let _glass = false;
let _chipLineListener = null;   // TouchActionChip hears which action keys a stored comms line named
const _glassListeners = new Set();   // text built once at construction is re-applied when glass turns on

// The three prose token shapes. Each captures the ONE key (a capital letter or a comma); the replacer keeps the
// original token when the key has no table row. A Press token also captures a trailing " to <verb>" so a phrase
// that already ends with it does not say it twice ("Press S to scan" → "Tap empty space to scan"; the verb may be
// capitalised: "Press S to Scan." → "Tap empty space to Scan.").
const RE_BRACKET = /\[([A-Z,])\]/g;
const RE_PAREN   = /\(([A-Z,])\)/g;
const RE_PRESS   = /\b([Pp])ress (?:([A-Z])\b|(,)(?: \(the comma key\))?(?=\s|$))( to [A-Za-z]+\b)?/g;

/** `S` → 'KeyS', `,` → 'Comma'. */
function rowFor(ch) { return TABLE[ch === ',' ? 'Comma' : 'Key' + ch]; }

function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Action keys whose touch chip is a floor-2/3 button (TouchActionChip / the step chips) → that button's label. */
const CHIP_LABELS = Object.freeze({ N: 'LAUNCH NET', D: 'SEND DAUGHTER', A: 'AUTOPILOT', S: 'SCAN', R: 'REEL' });

const RE_KEY_HINT = /\s*[(\[][A-Z][)\]]/g;
// A raw key glyph: one letter or digit, "1-4", "Esc", "Shift+S", "?", a bare arrow set. '!', '…', '✓', '◆' and button words are not.
const RE_RAW_GLYPH = /^(?:[A-Za-z0-9?,.;']|[1-4]\s*[-–]\s*[1-4]|Esc|Tab|Space|Enter|Shift[^]*|Scroll|Drag|\+\/-|←↑↓→|←→↑↓|[←→↑↓]+)$/;
/**
 * Skill id → the word a glass player sees where desktop shows its key: the chip button (CHIP_LABELS) or a touch word;
 * every other skill has none. scan_wide is absent on purpose: WIDE SCAN is a floor 2-3 control, not a ticker chip, so
 * its reminder stays off glass.
 */
const SKILL_WORDS = Object.freeze({
  scan_quick: CHIP_LABELS.S, collect_lasso: CHIP_LABELS.N, arm_pilot_capture: CHIP_LABELS.N, collect_deploy: CHIP_LABELS.D,
  nav_autopilot: CHIP_LABELS.A, manage_codex: 'READ MORE',
  nav_target: 'TAP', nav_zoom: 'PINCH', nav_rotate: 'DRAG', nav_arrows: 'TURN PAD', arm_pilot: 'DAUGHTERS',
});
const LETGO_LABEL = 'LET GO';      // K: lets the catch at the collar go
const READ_LABEL = 'READ MORE';    // I: the full-screen library (the SPECS tab opens a different view)
const CHOOSE_LABEL = 'CHOOSE';     // U: the fate list of a big catch (ui/FateList.js)
const RE_PAD_CHIP = /\b([Pp])ress N to stick the pad on\b/g;   // the daughter's pad tool: its own button
// Her gripper and magnet are their own buttons too (the in-position comms line, CommsSystem).
const RE_GRIP_CHIP = /\b([Pp])ress N to grip it\b/g;
const RE_MAGNET_CHIP = /\b([Pp])ress N to use the magnet\b/g;
const RE_NEXT_CHIP = /\b([Pp])ress T for next target\b/g;   // no chip: a tap on the piece itself selects it
// Reminder lines whose key / mouse gesture HAS a touch control, worded for it on glass (no chip: the control is the
// glass itself): "Press T to pick the next target." -> "Tap a piece to ..."; "Scroll to zoom." -> "Pinch to zoom.";
// "Use the arrow keys to turn." -> "Use the turn pad to turn." ("Drag to look around." is true on glass as it stands).
const RE_PICK_CHIP = /\b([Pp])ress T to pick the next target\b/g;
const RE_ZOOM_WORDS = /\b([Ss])croll to zoom\b/g;
const RE_ARROW_WORDS = /\b([Uu])se the arrow keys to turn\b/g;
const RE_FLY_HER = /\b([Pp])ress [1-4] to fly her, then N\b/g;
// "Esc, then N to cast" (a mother-net line said while he flies a daughter): glass has no Esc, her row is the way back
const RE_ESC_THEN_N = /(^|[.!?:]\s+)?\b(Press )?Esc, then N\b/g;
const RE_PRESS_CHIP = /\b([Pp])ress ([NDASR])\b( to [A-Za-z]+\b)?/g;
// K lets the catch go, I reads more. Their tails say what the button already says, so they are dropped:
// "Press K to let it go." -> "Tap LET GO."; "or press K to let the catch go." -> "or tap LET GO.";
// "Press I to read more." / "Press I to read the specs." -> "Tap READ MORE.".
const RE_LETGO_CHIP = /\b([Pp])ress K\b( to let (?:it|the catch) go\b)?/g;
const RE_READ_CHIP = /\b([Pp])ress I\b( to (?:read more|read the specs|open Info)\b)?/g;
// "press U to choose" is the CHOOSE button on glass.
const RE_CHOOSE_CHIP = /\b([Pp])ress U\b( to choose\b)?/g;

/**
 * Skill reminders (SKILLS.CATALOG, OnboardingDirector `remind_<skillId>`) whose key has a touch button, so the line
 * can name it on glass: S, N, the daughter's tool, D, A (action chips) and I (READ MORE). Must equal the keys of
 * TouchActionChip.REMINDER_KIND (a test ties them). Every other reminder that names a key or a mouse gesture (V, 7,
 * 1-4, X, Shift R / 1-3 / +/-, period, ; ', Scroll, Drag) has no touch control, so on glass it is not posted.
 * (Shift S has one, the floor 2-3 WIDE SCAN button, but it is not a chip, so scan_wide is still not posted.)
 */
export const GLASS_REMINDER_SKILLS = Object.freeze(['scan_quick', 'collect_lasso', 'arm_pilot_capture', 'collect_deploy', 'nav_autopilot', 'manage_codex']);

/**
 * Reminders whose key / mouse gesture has a touch control but no chip: they ARE posted on glass, in touch words
 * (`chipPhrase`; nav_rotate's "Drag to look around." is already true on glass). Kept apart from
 * GLASS_REMINDER_SKILLS, which a test ties to TouchActionChip.REMINDER_KIND.
 */
export const GLASS_TOUCH_WORD_SKILLS = Object.freeze(['nav_target', 'nav_zoom', 'nav_rotate', 'nav_arrows']);

/**
 * Whole-phrase rows, exact source text → the touch wording ("words must be true": no keys on glass). Applied by
 * `speak` AND `chipPhrase` (comms, ticker, cards agree) BEFORE their token rules. Each `to` names only a control that
 * exists on glass: FLY THERE / WIDE SCAN / DE-SPIN, the DAUGHTERS list row, the chips of CHIP_LABELS, READ MORE,
 * LET GO, ORB, RADIATORS (floor 1). A sentence whose control has no touch form (the launch-speed dial, throttle, power
 * bus keys) is left out instead of naming a key. test-NoKeysOnGlass.js sweeps every source through the real path, so a
 * source edit that breaks a row's `from` text fails there.
 * @type {ReadonlyArray<readonly [string,string]>}
 */
const GLASS_LINES = Object.freeze([
  // travel: pinch out to the map, FLY THERE (the Space verb on floor 4)
  ['Scroll out to LEO and press Space to fly to the next cluster.', 'Pinch out to LEO, then tap FLY THERE to fly to the next cluster.'],
  ['Zoom out to LEO. The best cluster is picked for you; click another to change it, then press Space to fly the transfer.', 'Pinch out to LEO. The best cluster is picked for you; tap another to change it, then tap FLY THERE to fly the transfer.'],
  ['Zoom out to LEO (Esc), pick a cluster, press Space to fly to it.', 'Pinch out to LEO, pick a cluster, tap FLY THERE to fly to it.'],
  ['At LEO pick this cluster and press Space to fly there. Then target (T), autopilot (A), and net it piece by piece', 'At LEO pick this cluster and tap FLY THERE. Then tap a piece to target it, tap AUTOPILOT, and net it piece by piece'],
  ['At LEO pick the cluster and press Space, then clear it with Target (T) and Autopilot (A).', 'At LEO pick the cluster and tap FLY THERE, then clear it: tap a piece to target it and tap AUTOPILOT.'],
  // ch11_hohmann (READ THE WINDOW): the pane is on the floor-4 view (LEO); the Space verb is FLY THERE
  ['when the timing does not matter. Press Space to fly there.', 'when the timing does not matter. Tap FLY THERE.'],
  ['or says LAUNCH ANYTIME. Press Space to fly there.', 'or says LAUNCH ANYTIME. Tap FLY THERE.'],
  // daughters: a tap on her row in DAUGHTERS sends her number
  ['Deploy a daughter (D), then press 1-4 to pilot her directly.', 'Hold the target for DAUGHTER, then tap her row in DAUGHTERS to pilot her directly.'],
  ['Press 1-4 while a daughter is deployed to fly her yourself.', 'Tap her row in DAUGHTERS while she is deployed to fly her yourself.'],
  ['Press 1-4 to take manual control. A piloted capture scores 2×.', 'Tap her row in DAUGHTERS to take manual control. A piloted capture scores 2×.'],
  ['Press N to launch the net (or 1-4 to pilot her).', 'Tap LAUNCH NET to launch the net (or tap her row in DAUGHTERS to pilot her).'],
  // the station-keep hint names her tool; on glass N is her tool's chip (STICK PAD for the pad, else LAUNCH NET)
  ['Press N to stick the pad on (or 1-4 to pilot her).', 'Tap STICK PAD to stick the pad on (or tap her row in DAUGHTERS to pilot her).'],
  ['Press N to use the magnet (or 1-4 to pilot her).', 'Tap USE MAGNET to use the magnet (or tap her row in DAUGHTERS to pilot her).'],
  ['Press N to grip it (or 1-4 to pilot her).', 'Tap CLOSE GRIPPER to grip it (or tap her row in DAUGHTERS to pilot her).'],
  ['Press her number again (1-4) or Esc to back out to Command view.', 'Tap her row in DAUGHTERS again to back out to Command view.'],
  ['Daughters capture heavier targets at longer range. Press 1-4 to pilot a launched daughter.', 'Daughters capture heavier targets at longer range. Tap her row in DAUGHTERS to pilot a launched daughter.'],
  ['Run both daughters: [D] deploys, [1-4] select and pilot (press again to switch back), [Shift+R] recalls the whole fleet.', 'Run both daughters: hold the target for DAUGHTER to send one, and tap her row in DAUGHTERS to pilot her (tap again to switch back).'],
  ['Press D twice to deploy both daughters, then [1]/[2] to switch between them.', 'Hold the target for DAUGHTER twice to send both daughters, then tap a daughter\'s row in DAUGHTERS to switch between them.'],
  ['Line up on a target and capture by hand (N). Manual catches score double. Watch the odds strip: de-spin (L) or close in', 'Line up on a target and capture by hand with LAUNCH NET. Manual catches score double. Watch the odds strip: hold DE-SPIN or close in'],
  ['Close on a target under manual pilot and press N to net it for 2× score.', 'Close on a target under manual pilot and tap LAUNCH NET for 2× score.'],
  // owner 2026-10-26 (pair lesson): the Q key has the PAIR button (TouchControls, shown while a pair is offered)
  ['Press Q to fire the pair.', 'Tap PAIR to fire the pair.'],
  ['Press Q when two pieces are marked to launch both daughters together.', 'Tap PAIR when two pieces are marked to launch both daughters together.'],
  // scan: WIDE SCAN is the mission-3 lesson chip, then the WIDE SCAN button on floors 2-3; the quick ping is SCAN
  ['Press Shift+S for a wide-aperture deep scan. Slower, but it paints debris your quick ping (S) can\'t see.', 'Tap WIDE SCAN for a wide-aperture deep scan. Slower, but it paints debris your quick ping (SCAN) can\'t see.'],
  ['Press Shift+S to run a wide-aperture scan and reveal distant contacts.', 'Tap WIDE SCAN to run a wide-aperture scan and reveal distant contacts.'],
  ['; Shift+S runs a Wide Scan for longer range.', '.'],
  // other key words
  ['Press A to autopilot toward it, or deploy a daughter with D.', 'Tap AUTOPILOT to fly toward it, or hold the target for DAUGHTER.'],
  // no READ MORE button is up on this teaching card (the chip only follows a comms line that says "Press I"), so the sentence is left out
  [' Open the Codex (I) to learn more.', ''],
  ['until you jettison it with K.', 'until you tap LET GO.'],
  ['Launch another daughter (D) to chase', 'Hold the target for DAUGHTER to send another daughter to chase'],
  ['Hold L to fire the de-spin laser', 'Hold DE-SPIN to fire the de-spin laser'],
  ['Hand-flying in orbit is a black-belt skill. For almost everything, press A and let the computer do it.', 'Hand-flying in orbit is a black-belt skill. For almost everything, tap AUTOPILOT and let the computer do it.'],
  [' Set the fleet launch speed with [\'] up and [;] down — a hotter shot reaches farther', ' A hotter shot reaches farther'],
  [', dial the fleet launch speed up with [\'] (down with [;]) and take a catch', ' and take a catch'],
  [' plus the [;]/[\'] launch-speed dial makes the transit', ' makes the transit'],
  // The THROTTLE UP beat chip (Shift+=) is up for the whole ch5_burn lesson, the only place these two lines show.
  [' Trim your closing rate on the throttle (+/-) to nail the intercept window.', ' Tap THROTTLE UP to trim your closing rate and nail the intercept window.'],
  ['Use + / - to throttle and time your intercept burn on the ISS threat frags.', 'Tap THROTTLE UP and time your intercept burn on the ISS threat frags.'],
  ['They open LIKE A FLOWER: press O.', 'They open LIKE A FLOWER: tap RADIATORS on floor 1.'],
  [' O opens them to ', ' RADIATORS on floor 1 opens them to '],
  ['Nav orb shown (8 to hide)', 'Nav orb shown (tap ORB to fold it)'],
  ['Nav orb hidden (8 to show)', 'Nav orb folded (tap ORB to show it)'],
  ['Select a target with Tab first.', 'Tap a piece first.'],
  // skill names (SkillsPane rows) that carry a key or a mouse
  ['Spacecraft Inspection (V, then scroll in)', 'Spacecraft Inspection'],
  ['Mouse Look', 'Free Look'],
  // the codex: sentences whose control has no touch form
  [', and you can shift the balance: Shift+1/2/3 selects a bus, then [ and ] trim it.', '.'],
  ['fills toward the next floor as you scroll', 'fills toward the next floor as you pinch'],
  ['Space opens the pane; clicking any hull part or its card lands the block on', 'Tapping any hull part or its card opens the pane and lands the block on'],
  ['you clicked', 'you tapped'],
  ['BUY is one click', 'BUY is one tap'],
  ['BUY one click away', 'BUY one tap away'],
  ['Clicking a part whose page', 'Tapping a part whose page'],
  ['Esc slides the pane away and leaves you exactly where you were', 'CLOSE × slides the pane away and leaves you exactly where you were'],
  // u16b D6 (the glass-words sweep, test-NoKeysOnGlass "every player line in js/"): appended rows. Each `to` names only a
  // control that exists on glass in that moment, or leaves the key out.
  // the ticker's fallback body when no OPEN THE WINGS step button is up (on glass the row IS the button whenever the ticker has
  // its step sink, main.js). What really opens the wings then: the WINGS button of the floor 1 bar (OverridePane).
  ['Open the wings (comma key)', 'Open the wings: tap WINGS on floor 1'],
  // daughter refusals (ticker hints and comms)
  ['Wait for charge, or deploy another daughter [1-4]', 'Wait for charge, or use another daughter'],
  ['Deploy another [1-4] or refuel', 'Use another daughter or refuel'],
  ['Pick a lighter one [T]', 'Pick a lighter one'],
  ['Press [A] to autopilot closer first', 'Hold the target for AUTOPILOT to get closer first'],
  ['Pilot her in manually (1-4) for a better grip.', 'Pilot her in manually (tap her row in DAUGHTERS) for a better grip.'],
  ['Pilot daughters with 1-4 for 2× score bonus.', 'Pilot daughters by tapping their rows in DAUGHTERS for 2× score bonus.'],
  ['de-spin the target (hold L), then re-fire.', 'de-spin the target, then re-fire.'],
  // the catch at the collar: K is LET GO (speak, the ticker's path, needs the row too)
  ['Press K to let it go.', 'Tap LET GO.'],
  ['press K to let the catch go.', 'tap LET GO.'],
  // the fate list of a big catch: U is CHOOSE
  ['Press U to choose.', 'Tap CHOOSE.'],
  ['press U to choose.', 'tap CHOOSE.'],
  // the radiator refusal: O is RADIATORS on floor 1
  ['Tap O to fold it', 'Tap RADIATORS on floor 1 to fold it'],
  ['(O / RADIATORS) to thrust.', '(RADIATORS on floor 1) to thrust.'],
  // autopilot and the camera
  ['launch the net (N).', 'tap LAUNCH NET.'],
  ['you took over with the reel key (R).', 'you took over with REEL.'],
  ['you steered with the arrow keys.', 'you steered with the turn pad.'],
  ['Release arrow keys. Autopilot has control.', 'Release the turn pad. Autopilot has control.'],
  ['hinge LOCKED — release the hinge brake [H]', 'hinge LOCKED'],
  ['Arrow keys orbit debris, ESC to recall', 'Use the turn pad to orbit the debris once she holds station'],
  // target and fleet refusals
  ['Press [T] to cycle targets', 'Tap a piece to pick a target'],
  ['All arms deployed or returning. Press [Shift+R] to reel in all', 'All arms deployed or returning'],
  ['Match velocity first [A].', 'Match velocity first: hold the target for AUTOPILOT.'],
  ['. [N] net · [D] daughter.', '. Net it, or send a daughter.'],
  // the same line said while he flies a daughter (Esc leaves her, then N is the mother's net)
  ['Esc, then [N] net · [D] daughter.', 'Tap her row in DAUGHTERS to go back, then net it, or send a daughter.'],
  ['. [A] autopilot to close.', '. Hold the target for AUTOPILOT to close in.'],
  // reactive lines to a key press (a hardware keyboard on glass): the toggles keep the sentence, drop the key
  [' (6 to hide)', ''],
  [' (6 to show)', ''],
  [' (9 to hide)', ''],
  [' (9 to show)', ''],
  [' (0 to hide)', ''],
  [' (0 to show)', ''],
  [' (5 to hide)', ''],
  [' (5 to show)', ''],
  [' after your first scan (S)', ' after your first scan'],
  [' when you analyse a target (Z)', ' when you analyse a target'],
  // The hold-catch lines (ArmManager) name C. The "Press C" line posts only when some daughter's hand-off is possible
  // now, and her row then carries a TO RADIATOR button (StatusPanel), so that sentence names the button. The too-big
  // warning ("; move it to a radiator (Press C).") can show while no such button is up, so it leaves the sentence out.
  ['All daughters are holding catches. Press C to move one to a radiator.', 'All daughters are holding catches. Tap one in DAUGHTERS; if her catch can go, tap TO RADIATOR.'],
  ['; move it to a radiator (Press C).', '.'],
]);
// Only the INSTRUCTION form of "click" becomes "tap": a bare Click / click, then a space and a word, at the start of a
// sentence or after , ; : ( or a joining word ("click another to change it"). "right-click", "double-click" and a noun
// ("the relay click") stay raw, so test-NoKeysOnGlass' K2 sweep still catches them.
const RE_CLICK = /(^|[.!?:;,(]\s+|\n\s*|\b(?:and|or|then|to|can|will|just|simply|please|should|must)\s+)([Cc])lick(?=\s+[A-Za-z])/g;

/** Shared first step of `speak` and `chipPhrase`: the whole-phrase rows, then click -> tap. */
function applyLines(text) {
  let out = text;
  for (const [from, to] of GLASS_LINES) if (out.indexOf(from) >= 0) out = out.split(from).join(to);
  // "Press 2 to fly her, then N to ...": her number key is a tap on her row; the N part then reads as its button
  // (shown only once she is the one N works).
  out = out.replace(RE_FLY_HER, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' her row in DAUGHTERS to fly her, then press N');
  out = out.replace(RE_ESC_THEN_N, (tok, lead, press, off) => (lead || '') + ((lead || press || off === 0) ? 'Tap' : 'tap') + ' her row in DAUGHTERS to go back, then press N');
  return out.replace(RE_CLICK, (tok, lead, c) => lead + (c === 'C' ? 'T' : 't') + 'ap');
}

export class GestureHints {
  /** @returns {Readonly<Record<string, Readonly<GestureRow>>>} the frozen table */
  static get TABLE() { return TABLE; }

  /** Flip the module switch. The hub calls `setGlass(true)` once under its `TouchControls.detect()` gate. */
  static setGlass(on) {
    const was = _glass;
    _glass = on === true;
    // Text a module wrote once at build time is re-applied when glass turns on.
    if (_glass && !was) for (const fn of Array.from(_glassListeners)) { try { fn(); } catch (_e) { /* a listener must not break boot */ } }
  }

  /**
   * Call `fn` whenever glass turns ON (not at registration); returns the remover. Draw-time `isGlass()` reads are
   * preferred; this is for text set once at build (MotherCallouts' hint, MenuScreen's start hint).
   */
  static onGlassOn(fn) {
    if (typeof fn !== 'function') return () => {};
    _glassListeners.add(fn);
    return () => { _glassListeners.delete(fn); };
  }

  static isGlass() { return _glass; }

  /** A hint's `keys[]` entry in the table's spelling: 'N' / 'n' → 'KeyN', '7' → 'Digit7', ',' → 'Comma', else unchanged. */
  static normalizeKey(k) {
    const s = String(k);
    if (s.length === 1) {
      if (/[A-Za-z]/.test(s)) return 'Key' + s.toUpperCase();
      if (/[0-9]/.test(s)) return 'Digit' + s;
      if (s === ',') return 'Comma';
    }
    return s;
  }

  /**
   * The gesture chip for a keyed hint, or null. ON glass: the chip of the FIRST key with a table row. OFF glass:
   * ALWAYS null, so the caller falls through to its key glyph, byte-identical.
   * @param {Array<string>|*} keys  the hint payload's `keys`
   */
  static chipFor(keys) {
    if (!_glass) return null;
    if (!Array.isArray(keys)) return null;
    for (const k of keys) {
      const row = TABLE[GestureHints.normalizeKey(k)];
      if (row) return row.chip;
    }
    return null;
  }

  /**
   * Comms text on glass. "Press N / D / A / S" becomes "Tap LAUNCH NET / SEND DAUGHTER / AUTOPILOT / SCAN" (case of
   * the verb and the punctuation after it kept; a " to <verb>" that repeats the whole button name is dropped:
   * "Press S to scan" -> "Tap SCAN"). Other key names ("[K]", Esc, Tab) are left as they are. OFF glass or for a
   * non-string the SAME value comes back. This is NOT `speak`: its N/D/A rows name the long-press radial, which is
   * not what the chip does.
   */
  static chipPhrase(text) {
    if (!_glass || typeof text !== 'string') return text;
    return applyLines(text).replace(RE_PAD_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' STICK PAD')
      .replace(RE_GRIP_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' CLOSE GRIPPER')
      .replace(RE_MAGNET_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' USE MAGNET')
      .replace(RE_NEXT_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' a piece to pick the next target')
      .replace(RE_PICK_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' a piece to pick the next target')
      .replace(RE_ZOOM_WORDS, (tok, s) => (s === 'S' ? 'Pinch' : 'pinch') + ' to zoom')
      .replace(RE_ARROW_WORDS, (tok, u) => (u === 'U' ? 'Use' : 'use') + ' the turn pad to turn')
      .replace(RE_LETGO_CHIP, (tok, p) => (p === 'P' ? 'Tap ' : 'tap ') + LETGO_LABEL)
      .replace(RE_READ_CHIP, (tok, p) => (p === 'P' ? 'Tap ' : 'tap ') + READ_LABEL)
      .replace(RE_CHOOSE_CHIP, (tok, p) => (p === 'P' ? 'Tap ' : 'tap ') + CHOOSE_LABEL)
      .replace(RE_PRESS_CHIP, (tok, p, letter, toVerb) => {
      const label = CHIP_LABELS[letter];
      const lead = (p === 'P' ? 'Tap ' : 'tap ') + label;
      if (!toVerb) return lead;
      const verb = toVerb.slice(4).toLowerCase();
      // "Press R to reel her home" keeps its verb: "Tap REEL her home" would read like a command to the button.
      return (label.toLowerCase() === verb && letter !== 'R') ? lead : lead + toVerb;
    });
  }

  /**
   * Codex text (QUICK LOOK, body, real-world, unlock hints) on glass. `chipPhrase` first, then a single-capital key
   * hint "(S)" / "[T]" is dropped (a key letter names a control a touch player does not have). OFF glass or for a
   * non-string the SAME value comes back.
   */
  static glassWords(text) {
    if (!_glass || typeof text !== 'string') return text;
    return GestureHints.chipPhrase(text).replace(RE_KEY_HINT, '');
  }

  /**
   * The touch word for a skill's key on glass ('' when it has none). Desktop: always '' (callers keep their key text).
   * @param {{id?:string}|null} def  the SKILLS.CATALOG entry
   * @param {string} [skillId]
   */
  static skillWord(def, skillId) {
    if (!_glass) return '';
    return GestureHints.wordForSkill((def && def.id) || skillId);
  }

  /** The touch word for a skill id, NOT glass-gated (for a pane that knows it is on glass by its own flag). */
  static wordForSkill(id) {
    return (typeof id === 'string' && SKILL_WORDS[id]) || '';
  }

  /**
   * The ticker badge text for a hint on glass, or undefined when this is not a reminder-style key glyph (the caller
   * keeps its own). Never a raw key glyph or "?" on glass: a skill reminder shows its skill word or nothing (null).
   * @param {{glyph?:string, skillId?:string|null}} payload
   * @returns {string|null|undefined}
   */
  static badgeFor(payload) {
    if (!_glass || !payload) return undefined;
    const g = payload.glyph;
    if (typeof g !== 'string' || !RE_RAW_GLYPH.test(g)) return undefined;
    return SKILL_WORDS[payload.skillId] || null;
  }

  /**
   * Which chips a line's "Press N/D/A/S/R/K/I" (and the pad line) asks for, in reading order, as chip kinds
   * ('net'|'pad'|'daughter'|'autopilot'|'scan'|'reel'|'letgo'|'read'|'choose'). Not glass-gated: the same tokens
   * `chipPhrase` rewrites.
   */
  static chipKinds(text) {
    if (typeof text !== 'string') return [];
    const found = [];
    const KIND = { N: 'net', D: 'daughter', A: 'autopilot', S: 'scan', R: 'reel' };
    const rest = text.replace(RE_PAD_CHIP, (tok, p, off) => { found.push([off, 'pad']); return ' '.repeat(tok.length); })
      .replace(RE_GRIP_CHIP, (tok, p, off) => { found.push([off, 'grip']); return ' '.repeat(tok.length); })
      .replace(RE_MAGNET_CHIP, (tok, p, off) => { found.push([off, 'magnet']); return ' '.repeat(tok.length); });
    rest.replace(RE_PRESS_CHIP, (tok, p, letter, toVerb, off) => { found.push([off, KIND[letter]]); return tok; });
    rest.replace(RE_LETGO_CHIP, (tok, p, tail, off) => { found.push([off, 'letgo']); return tok; });
    rest.replace(RE_READ_CHIP, (tok, p, tail, off) => { found.push([off, 'read']); return tok; });
    rest.replace(RE_CHOOSE_CHIP, (tok, p, tail, off) => { found.push([off, 'choose']); return tok; });
    return found.sort((a, b) => a[0] - b[0]).map(f => f[1]);
  }

  /**
   * May a stale-skill reminder for this skill be posted now? Desktop: always. Glass: only when the skill has no key
   * or its key has a touch button (GLASS_REMINDER_SKILLS / GLASS_TOUCH_WORD_SKILLS).
   * @param {{id?:string, key?:(string|null)}} def  the SKILLS.CATALOG entry
   * @param {string} [skillId]  the reminder's skill id (when the entry carries none)
   */
  static reminderFitsGlass(def, skillId) {
    if (!_glass) return true;
    if (!def || !def.key) return true;
    const id = def.id || skillId;
    return GLASS_REMINDER_SKILLS.includes(id) || GLASS_TOUCH_WORD_SKILLS.includes(id);
  }

  /**
   * The ONE place a stored comms line is reported to the touch chip: on glass, when the line named an action key,
   * the registered listener gets the chip kinds. Desktop or no listener: nothing happens.
   * @param {string} text  the line as emitted (before `chipPhrase`)
   */
  static noteChipLine(text) {
    if (!_glass || !_chipLineListener) return;
    const kinds = GestureHints.chipKinds(text);
    if (kinds.length) { try { _chipLineListener(kinds, text); } catch (_e) { /* a listener must not break comms */ } }
  }

  /** Register (or clear with null) the one listener for `noteChipLine` (TouchActionChip). */
  static setChipLineListener(fn) { _chipLineListener = (typeof fn === 'function') ? fn : null; }

  /**
   * Rewrite key tokens in prose as gestures (grammar: module header). OFF glass (or for a non-string) the SAME
   * instance comes back (`decorateGlossary` sees the identical string). Idempotent: `speak(speak(t)) === speak(t)`.
   *
   * Two doubles are dropped: a " to <verb>" right after a Press token whose phrase already ends with it, and a
   * " or [word] <object>" right after a phrase that names the same button (object = the phrase minus its verb:
   * "Press , or WINGS on floor 1" → "Tap WINGS on floor 1").
   */
  static speak(text) {
    if (!_glass || typeof text !== 'string') return text;
    const used = [];
    let out = applyLines(text)
      .replace(RE_BRACKET, (tok, key) => {
        const row = rowFor(key);
        return row ? '[' + row.chip + ']' : tok;
      })
      .replace(RE_PAREN, (tok, key) => {
        const row = rowFor(key);
        return row ? '(' + row.chip + ')' : tok;
      })
      .replace(RE_PRESS, (tok, p, letter, comma, toVerb) => {
        const row = rowFor(letter || comma);
        if (!row) return tok;
        used.push(row.phrase);
        // The phrase takes the verb's case: "Press N" opens a sentence.
        let phrase = p === 'P' ? row.phrase.charAt(0).toUpperCase() + row.phrase.slice(1) : row.phrase;
        // The phrase already ends with that verb (any case): keep the OLD text's spelling of it.
        if (toVerb) {
          if (row.phrase.toLowerCase().endsWith(toVerb.toLowerCase())) phrase = phrase.slice(0, phrase.length - toVerb.length) + toVerb;
          else phrase += toVerb;
        }
        return phrase;
      });
    for (const ph of used) {
      const obj = ph.slice(ph.indexOf(' ') + 1);
      const re = new RegExp('(' + reEscape(ph) + ') or (?:[A-Za-z]+ )?' + reEscape(obj) + '(?!\\w)', 'gi');
      out = out.replace(re, '$1');
    }
    return out;
  }
}

export default GestureHints;
