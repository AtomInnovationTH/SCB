/**
 * RealSkyCard.js — the DOM panel of the real sky on floors 4-5 (plan sky-1116, lane L-sky): a search field (name or number), the card
 * of the tapped object (name, kind, mass, launch year, height; its number, tilt, size and "orbit as of <snapshot date>" are in the name's hover, Sky 34) and a
 * one-row colour key. By default only the field and the key show; the card opens on a
 * tapped dot or a search hit and never repeats the key (owner 2026-11-17, DECISIONS §74 row 3). The credit line is gone from the panel since Sky 34 (owner 2026-11-25;
 * the Tech library carries the sources). Styles are inline in this module. DOM-guarded: with no document it is inert (headless tests use
 * `cardFields`, which is pure).
 *
 * The panel itself takes pointer events (so the input and the close button work); everything around it stays click-through. Keys typed
 * in the field never reach the game (InputManager ignores keys typed into an INPUT, and the field also stops them here).
 *
 * @module ui/RealSkyCard
 */

import { buildItems, toHighlight, isMenuId, ID_COUNTRY, ID_FAMOUS } from './HighlightItems.js';
import { StorageKeys } from '../core/StorageKeys.js';

export const CLASS_NAMES = ['debris', 'rocket stage', 'dead', 'working', 'satellite', 'unknown', 'starlink'];
/** The seventh kind (lane sky-skylook-1119, owner 2026-11-19): a working satellite whose name starts with STARLINK. It is not a data class: RealSkyLayer assigns it at load. */
export const CLS_STARLINK = 6;
/** True for a row (data/sky.json: [norad, name, cls, ...]) that draws as the Starlink kind: class "working" and a name starting with STARLINK. A dead or unknown-status Starlink stays in its own class. */
export function isStarlinkRow(row) {
  return !!row && row[2] === CLS_WORKING && /^STARLINK/i.test(String(row[1]));
}
/**
 * One colour per kind (index = CLASS_NAMES index = skyPack.CLS, Starlink last). Warm = she can remove it, cool grey = live traffic (owner
 * pick 2026-11-19, DECISIONS §78, from "dots are bright green, very visible, a bit cartoony"): debris amber, rocket stage orange, dead
 * satellite dusty tan, working satellite cool slate-blue, "satellite" grey, unknown dim grey, Starlink a dim slate that sits under the rest.
 * Red stays free for threats near her path. Floor 4's dots go through the composer's OutputPass (ACES), so the on-screen colour is darker
 * and less saturated than the hex (sampled 2026-11-19: debris 175,139,71; working 93,117,133; stage 178,112,51).
 */
export const CLASS_COLORS = ['#d8a050', '#e07f3a', '#c89070', '#6f8fa8', '#8a96a0', '#6a7078', '#3f4a58'];
/**
 * The key's words (same order as CLASS_NAMES; the full sentence is each box's tooltip). Sky 32 (owner 2026-11-24, DECISIONS §104 row 1): the
 * "debris" kind reads "pieces" (it sits under the Debris group), "sat" reads "no report", the rocket stage is the group row "Rocket stages".
 */
export const LEGEND_LABELS = ['pieces', 'Rocket stages', 'dead', 'working', 'no report', 'unknown', 'Starlink'];
/**
 * The order the kinds are drawn in, top to bottom, one column in three groups (Sky 32, DECISIONS §104 row 1): Satellites (working, Starlink, dead,
 * no report), Rocket stages, Debris (pieces, unknown). CLASS_NAMES, CLASS_COLORS and the data's class numbers keep their order.
 */
export const LEGEND_ORDER = Object.freeze([3, CLS_STARLINK, 2, 4, 1, 0, 5]);
/**
 * What each box means, one plain sentence per kind (same order as CLASS_NAMES), true to how the catalogue sorts objects
 * (scripts/skyPack.mjs `classify`: Space-Track's object type, and CelesTrak's status letter for satellites). The hover text is this + "(tap to show or hide)".
 */
export const LEGEND_HINTS = Object.freeze([
  'pieces: broken pieces and fragments left by launches, breakups and collisions',
  'Rocket stages: a used rocket stage left in orbit after a launch',
  'dead: satellites that have stopped working',
  'working: satellites still doing their job (Starlink has its own box)',
  'no report: satellites we can place and size, but nobody reports whether they still work',
  // Source: Space-Track FAQ (space-track.org/documentation): "analyst" objects, tracked but not tied to a launch, "generally debris objects";
  // McDowell (planet4589.org/space/gcat/web/intro/analyst.html) agrees. All 525 on the globe are numbered 80000-89999 or 270000+ (measured 11-25).
  'unknown: pieces the Space Force tracks but has not tied to a launch; most are debris',
  'Starlink: the working Starlink internet satellites',
]);
/**
 * The three groups of the key (Sky 32, DECISIONS §104 row 1). `id` is a code name (the player sees `word`); `kinds` are CLASS_NAMES entries top to
 * bottom; the dot is the colour of a kind in it (coordinator's call: Satellites wears "working", Debris "debris", Rocket stages its own); `open`
 * groups have an arrow and rows under them, the Rocket stages row is one box. The hover line is `hint` + " (tap to show or hide)".
 */
export const KEY_GROUPS = Object.freeze([
  Object.freeze({ id: 'satellites', word: 'Satellites', kinds: Object.freeze(['working', 'starlink', 'dead', 'satellite']), color: CLASS_COLORS[3], open: true,
    hint: 'Satellites: machines built to do a job in orbit, working or not' }),
  Object.freeze({ id: 'rocket stages', word: 'Rocket stages', kinds: Object.freeze(['rocket stage']), color: CLASS_COLORS[1], open: false, hint: LEGEND_HINTS[1] }),
  Object.freeze({ id: 'debris', word: 'Debris', kinds: Object.freeze(['debris', 'unknown']), color: CLASS_COLORS[0], open: true,
    hint: 'Debris: broken pieces and objects nobody has identified' }),
]);
/**
 * The "military" mark inside Satellites (DECISIONS §104 row 3): not a kind and not part of the Satellites tick; it puts a thin ring round each
 * military satellite whose kind is shown. A quiet lilac that reads on day and night Earth and is not red (red is for threats near her path).
 */
export const MIL_NAME = 'military';
export const MIL_COLOR = '#b9a8ff';
export const MIL_HINT = 'military: satellites run by armed forces or spy agencies (the US keeps some secret ones off the public list)';

/**
 * A group's tick from its kinds: 'on' (all ticked), 'off' (none) or 'dash' (some). Pure.
 * @param {string[]} kinds the kinds the key shows in the group @param {(name: string) => boolean} isHidden
 * @returns {'on'|'off'|'dash'}
 */
export function groupState(kinds, isHidden) {
  let on = 0;
  for (const k of kinds) if (!isHidden(k)) on++;
  return on === 0 ? 'off' : (on === kinds.length ? 'on' : 'dash');
}
/**
 * The last box of the key: the blue see-through band around Earth (ReachOrb). Its name in `legendDrawOrder()`, its word, its swatch (the band's
 * own cyan, ReachOrb `_paint` rgba(0,204,255)) and its hover text (owner 2026-11-24, DECISIONS §103 row 5).
 */
export const REACH_NAME = 'range';
export const REACH_COLOR = '#00ccff';
export const REACH_HINT = 'range: the band of heights your gas can take you to';

/**
 * The one small credit line: every source the full credit names, in a few words. Built from the full text (never typed
 * apart from it), so a source the data does not claim (CelesTrak without the status join) is not named, and an old
 * snapshot still says so.
 * @param {string} full the layer's credit line
 * @returns {string}
 */
export function shortCredit(full) {
  const t = String(full || '');
  if (!t) return '';
  const names = [];
  if (/Space-Track/i.test(t)) names.push('Space-Track');
  if (/GCAT/i.test(t)) names.push('GCAT');
  if (/CelesTrak/i.test(t)) names.push('CelesTrak');
  const old = t.match(/Snapshot (\d+) days old\./);
  return `Data: ${names.join(', ')}${old ? ` \u00b7 snapshot ${old[1]} days old` : ''}`;
}
/** Class number -> the kind line on the card. A satellite says which: working, dead, or "no report" (the key's word, Sky 32). */
const KIND_TEXT = ['debris', 'rocket stage', 'dead satellite (not working)', 'working satellite',
  'satellite, no report on whether it works', 'unknown object'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RCS_TEXT = [null, 'small', 'medium', 'large'];
/** Class numbers of the two status classes (skyPack.CLS): the legend hides them when the status was not joined. */
const CLS_DEAD = 2;
const CLS_WORKING = 3;

const fmt1 = (v) => (Math.round(v * 10) / 10).toString();
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');

/** "17 Nov 2026" (UTC) from an ISO string, or '' */
export function dateText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The card's strings for one data/sky.json row (all derived from the data; nothing is made up).
 * @param {Array} row [norad, name, cls, lenM, diaM, rcs, massKg, year, ...]
 * @param {{perKm:number, apoKm:number}} heights km above the equatorial radius
 * @param {string} snapshotUtc
 * @param {string} [gcatName] GCAT's own name for this NORAD when it is not the GP name (data/sky.json `gcatNames`): the size and mass
 *   are GCAT's figures for that object (e.g. the ISS row carries the Zarya module's), so the card says whose they are
 * @returns {{name:string, norad:string, kind:string, size:string, mass:string|null, launched:string|null, height:string, tilt:string, asOf:string, cls:number, sizeNote:string|null}}
 */
export function cardFields(row, heights, snapshotUtc, gcatName) {
  const [norad, name, cls, lenM, diaM, rcs, massKg, year] = row;
  let size;
  if (lenM != null && diaM != null) size = `${fmt1(lenM)} x ${fmt1(diaM)} m`;
  else if (lenM != null) size = `${fmt1(lenM)} m long`;
  else if (diaM != null) size = `${fmt1(diaM)} m across`;
  else if (rcs) size = `${RCS_TEXT[rcs]} (radar size)`;
  else size = 'not known';
  const fromGcat = lenM != null || diaM != null || massKg != null;
  return {
    name: String(name),
    norad: String(norad),
    kind: KIND_TEXT[cls] || KIND_TEXT[5],
    size,
    mass: massKg != null ? `${fmtInt(massKg)} kg` : null,
    sizeNote: gcatName && fromGcat ? `Size and mass (GCAT: ${gcatName})` : null,
    launched: year != null ? String(year) : null,
    height: `${fmtInt(heights.perKm)}\u2013${fmtInt(heights.apoKm)} km`,
    tilt: `${fmt1(row[11])}\u00b0`,
    asOf: `orbit as of ${dateText(snapshotUtc)}`,
    cls,
  };
}

/** Floor 4 = the NAVCOM globe (Earth big); floor 5 = the SDA chart (Earth a small disc, its bottom right holds the Kessler timeline). */
const FLOOR_GLOBE = 4;
const FLOOR_CHART = 5;
/** Two clicks or taps on the open object's name within this many ms = "fly to it" (floor 4). */
const NAME_DOUBLE_MS = 350;
/** The touch panel's tallest allowed height, px (Sky 23): see `panelPlacement`. */
export const PANEL_MAX_PX_GLASS = 342;
/** The Highlight menu's sizes (research doc 2026-11-floor4-highlight.md 2.1): row heights and the list's visible rows, mouse / touch. */
export const HL_ROW_PX = 24, HL_ROW_PX_GLASS = 44;
export const HL_LIST_ROW_PX = 18, HL_LIST_ROW_PX_GLASS = 44;
export const HL_LIST_ROWS = 8, HL_LIST_ROWS_GLASS = 4;
/** How often the list re-reads where its objects are (behind Earth or not), ms. */
const HL_TICK_MS = 400;

/**
 * The time buttons' box in the top-right corner (Sky 30 F, owner 2026-11-24 14:45Z: "comms pane is really top right. all the way top, all the way
 * right"): it sits where the radio box (`#hud-comms-panel`) sits on floor 2, flush at the top and right edges (measured 1728 x 1117 and 1366 x 1024:
 * top 0, right 0), SKY_CLOCK_H_PX tall (measured 70 px on both screens: 5 px top padding, the 12 px caption, 2 px gap, 44 px buttons, 6 px padding,
 * 1 px bottom border; `MapClockSlider` BUTTON_MIN_PX). The object panel stands directly under it, on the Mac and the iPad alike, sharing its
 * bottom border (SKY_CLOCK_OVERLAP_PX), flush right like it, and is SKY_PANEL_W_PX wide whatever the box's width (Sky 34, owner 2026-11-25: "why is it still
 * so wide"); the radio box and right column dodge under the panel, or under the buttons when no panel is up.
 */
export const SKY_CLOCK_EDGE_PX = 0;
export const SKY_CLOCK_H_PX = 70;
export const SKY_CLOCK_OVERLAP_PX = 1;
/** The panel's width, px: the same on the Mac and the iPad, floors 4 and 5 (Sky 34; the old panel was 284 px, then the box + 16 = 238 px). */
export const SKY_PANEL_W_PX = 150;
/** The time buttons' element (MapClockSlider.MAP_CLOCK_SLIDER_ID; spelled here so the card does not import the control). */
const CLOCK_ID = 'map-clock-slider';

/**
 * Where the panel sits (plan sky-1116-lsky-card, owner 2026-11-17: "move it clear of Earth"). Measured (tmp/sky-card-probe.mjs):
 * with the ISS card open (272 x 342 px) at top:176px the iPad (1366 x 1024, touch) card sat 0 to 18 px over Earth's right edge on
 * floor 4 (Earth r 393-417 px, widest point at the screen's middle height, x 1076-1100 vs the card's left edge 1082) and 11 px over the
 * HUD's right-hand status strip (bottom y 187). That is why the iPad's card sat bottom right (Sky 17-30). Sky 30 F (owner 2026-11-24 14:45Z: "object info pane
 * should be directly below time button pane"): both screens put it directly under the time buttons in the top-right corner, flush right; the iPad keeps
 * its 342 px height limit (PANEL_MAX_PX_GLASS), so with a card open it covers a sliver of Earth's right edge again (his pick; the lane's test allows
 * up to 6 px at the measured arrival distance, and a closer view covers more).
 * Mac floors 4 and 5 (Sky 19-20: "move the right panel to top right"; "the object card in same position as Floor 4 top"; floor 5 = page 1 shows the card there only).
 * @param {boolean} glass touch device
 * @param {number|null} [floor] 4 or 5
 * @param {boolean} [clockUp=true] the time buttons are on screen (the `-` steps can hide them): the panel then stands under them, else at the very top
 * @returns {{top:string, bottom:string, right:string, maxHeight:string}} CSS values
 */
export function panelPlacement(glass, floor, clockUp = true) {
  if (floor === FLOOR_GLOBE || floor === FLOOR_CHART) {
    const inset = 'env(safe-area-inset-top, 0px)';
    return {
      top: clockUp ? `calc(${inset} + ${SKY_CLOCK_EDGE_PX + SKY_CLOCK_H_PX - SKY_CLOCK_OVERLAP_PX}px)` : inset,
      bottom: 'auto',
      right: 'env(safe-area-inset-right, 0px)',
      // Sky 23: the iPad panel is at most 342 px high (the ISS card's size); anything taller scrolls inside the panel.
      maxHeight: glass ? `min(${PANEL_MAX_PX_GLASS}px, calc(100vh - 260px))` : 'calc(100vh - 260px)',
    };
  }
  return { top: '176px', bottom: 'auto', right: '12px', maxHeight: 'calc(100vh - 260px)' };
}

/**
 * Mac floor 4: the panel sits at the top right, so the radio box (`#hud-comms-panel`) and the right column (Targets / Target info, and NEXT where it shows: it is gone on floor 4 by default since §78 row 11, `+` brings it back; `#hud-right-column`),
 * which live there, move DOWN to just under it (lane sky-skylook-1119). Measured (tmp/sky10-look/probe-rects.js, 1728 x 1117, dots not
 * hidden by Earth, NEXT then still on floor 4): moved to the LEFT of the panel the 600 px wide radio box covered 1,555 dots and NEXT 260-288; moved below, 519-882 and
 * 26-157 (panel closed / card open). Below wins on both, and it is the side that never reaches Earth. How: `<html data-sky-panel-top>`
 * and `--sky-panel-dy` (the panel's bottom + 12 px) feed the one rule below; the individual `translate` property sits outside the HUD's
 * own `scale` and `transform` (index.html), so neither is disturbed. Set only while the panel shows with a mouse on floor 4 or 5 (floor 5: the panel keeps top 176 px; the column's Targets / Target info panes dodge too).
 */
export const SKY_PANEL_TOP_ATTR = 'data-sky-panel-top';
export const SKY_PANEL_DY_VAR = '--sky-panel-dy';
export const SKY_PANEL_STYLE_ID = 'real-sky-panel-dodge-style';
export const SKY_PANEL_TOP_CSS = `html[${SKY_PANEL_TOP_ATTR}] #hud-comms-panel, html[${SKY_PANEL_TOP_ATTR}] #hud-right-column { translate: 0 var(${SKY_PANEL_DY_VAR}, 0px); }`;
/** Gap between the panel's bottom edge and the radio box / right column under it, px. */
export const SKY_PANEL_GAP_PX = 12;
/**
 * How far the dodge rule has moved the radio box and the right column down right now, px (0 when it is off). HUD reads it so the right
 * column's layout top (radio box bottom + 10) is measured without the radio box's own translate: both carry the same one, and counting it
 * twice left the Targets pane 166 px too low (and NEXT off the screen with a card open; measured 1728 x 1117, lane sky-skylook-1119 D7).
 * @param {Document|null} [doc]
 * @returns {number}
 */
export function skyPanelDodgePx(doc = typeof document !== 'undefined' ? document : null) {
  const el = doc && doc.documentElement;
  if (!el || !el.hasAttribute || !el.hasAttribute(SKY_PANEL_TOP_ATTR) || !el.style) return 0;
  const v = parseFloat(el.style.getPropertyValue(SKY_PANEL_DY_VAR));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** The look of the Highlight menu's buttons (the row, the three items, "Off"). */
const HL_BTN_CSS = 'border:1px solid rgba(160,180,220,0.35);border-radius:4px;cursor:pointer;color:#e8eefc;background:rgba(40,60,100,0.35);touch-action:manipulation;font-size:11px;user-select:none;-webkit-user-select:none';

const PANEL_CSS = [
  'position:fixed', 'right:0', 'overflow:auto', `width:${SKY_PANEL_W_PX}px`, 'z-index:36', 'display:none', 'pointer-events:auto',
  'box-sizing:border-box', 'padding:8px 10px', 'border-radius:6px', 'background:rgba(8,12,22,0.82)',
  'border:1px solid rgba(160,180,220,0.28)', 'color:#dbe4f5', 'font-family:var(--font-mono)', 'font-size:11px',
  'line-height:1.35', 'letter-spacing:0.02em', 'user-select:none', '-webkit-user-select:none',
].join(';');

export class RealSkyCard {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.document]
   * @param {function} [deps.isGlass] () => touch device (bigger controls)
   * @param {function} [deps.getFlag] () => the menu language's flag code ('USA', 'THA' ...): "Your country" in the Highlight menu (main.js passes the settings' language)
   * @param {function} [deps.onLanguage] (fn) => unsubscribe: fn runs when the menu language changes
   * @param {function} [deps.now] () => monotonic ms
   * @param {string} [deps.defaultHighlight] the Highlight menu item that is on when the globe opens (main.js: Famous; owner 2026-11-24); none without it
   */
  constructor(deps = {}) {
    this._doc = deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null);
    this._isGlass = deps.isGlass || null;           // optional; the layer also calls setLayout() every frame
    this._getFlag = typeof deps.getFlag === 'function' ? deps.getFlag : null;
    this._now = typeof deps.now === 'function' ? deps.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._layer = null;                             // the RealSkyLayer, through attachLayer (the Highlight menu calls it)
    this._hlView = 'closed';                        // the Highlight menu: 'closed' (one row) | 'menu' (the three items) | 'list' (an item is on)
    this._hlExtras = { stages: false, debris: false };   // Your country: "+ stages" / "+ debris" lit too
    this._hlFamDead = null;                         // the id of the family whose "+ dead" is on (Sky 33: per family item, kept here, not in _hlExtras which is Your country's)
    this._hlFamOpen = false;                        // the "Families" row is open (not saved)
    this._hlShownKey = '';                          // what the family header's "shown" count was made from
    this._hlShownItem = null;
    this._hlShown = 0;
    this._hlItems = null;                           // the built items (cache) and what they were built from
    this._hlItemsKey = null;
    this._hlStrip = '';                             // the last tapped row's note: in the header's hover (Sky 34), not printed
    this._hlTickMs = -Infinity;
    this._hlDefault = typeof deps.defaultHighlight === 'string' ? deps.defaultHighlight : null;   // then the last item the player turned on
    this._hlPicked = false;                         // the player has picked an item this session: his pick, not the language's country, is the default
    this._hlDefaultArmed = false;                   // the globe was entered; the default goes on once the catalogue is in
    this._hlUserOff = false;                        // the player turned a highlight off (Off or Esc): no default until the game reloads
    this._offLanguage = null;
    this._offHl = null;
    if (typeof deps.onLanguage === 'function') this._offLanguage = deps.onLanguage(() => this._hlLanguageChanged());
    this._glass = false;
    this._floor = null;
    this._onSearch = null;
    this._onClose = null;
    this._onToggleKind = null;
    this._isKindHidden = null;
    this._isMilitary = null;              // () => the "military" mark is on (the layer; Sky 32)
    this._onToggleMilitary = null;
    this._hasMilitary = null;              // () => the data carries the military flag (false: the row stays out)
    this._storage = deps.storage !== undefined ? deps.storage : (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; } })();
    this._open = new Set();               // the key groups that are open (ids from KEY_GROUPS); saved
    this._loadOpen();
    this._memory = new Map();             // group id -> the kinds that were ticked when the group was unticked (a tap on the box or `-`); `+` or a tap brings them back
    this._reachSwitch = null;             // the "reach" box's switch (setReachSwitch)
    this._onFlyName = null;
    this._shown = false;
    this._panelHidden = false;            // the player hid the panel (globe `-` step): nothing drawn, no dodge, no keep-out box
    this._clockShown = true;              // the time buttons are on screen (main.js: `setClockShown`); the panel stands under them
    this._built = false;
    this._info = null;
    this._credit = '';
    this._creditOpen = false;
    this._statusJoined = false;
    this._loadFailed = false;
    this._els = {};
    this._dodgeOn = false;                // <html data-sky-panel-top> is set (the radio box and the right column are moved under the panel)
    this._dodgeDy = NaN;                  // the --sky-panel-dy written now, px
    this._ro = null;
  }

  /** The layer wires these: onSearch(query) => row index or -1; onClose() => void; onToggleKind(name) flips a legend box; isKindHidden(name) => bool (the boxes read it); onFlyName() turns floor 4's globe to the open object; isMilitary() / onToggleMilitary() are the "military" mark inside Satellites (the row shows only with both, and while hasMilitary() is not false: data with no `mil` field has nothing to ring). */
  setHandlers({ onSearch, onClose, onToggleKind, isKindHidden, onFlyName, isMilitary, onToggleMilitary, hasMilitary } = {}) {
    this._onSearch = onSearch || null;
    this._onClose = onClose || null;
    this._onToggleKind = onToggleKind || null;
    this._isKindHidden = isKindHidden || null;
    this._onFlyName = onFlyName || null;
    this._isMilitary = typeof isMilitary === 'function' && typeof onToggleMilitary === 'function' ? isMilitary : null;
    this._onToggleMilitary = this._isMilitary ? onToggleMilitary : null;
    this._hasMilitary = typeof hasMilitary === 'function' ? hasMilitary : null;
  }

  /** The legend's boxes again (the layer changed a kind); a family's "shown" count follows the boxes. */
  refreshKinds() { this._renderLegend(); this._hlRender(true); }

  /**
   * Wire the "reach" box at the end of the key (main.js): `isOn()` = the blue band is shown, `setOn(on)` shows or hides it. Without it the box is not shown.
   * @param {{isOn: () => boolean, setOn: (on: boolean) => void}|null} sw
   */
  setReachSwitch(sw) {
    this._reachSwitch = sw && typeof sw.isOn === 'function' && typeof sw.setOn === 'function' ? sw : null;
    this._renderLegend();
  }

  /** True when the key lists this kind (the status-less data has no working, dead or Starlink: DECISIONS §75). Not about the group being open. */
  _kindInKey(name) {
    const i = CLASS_NAMES.indexOf(name);
    if (i < 0) return false;
    return this._statusJoined || !(i === CLS_DEAD || i === CLS_WORKING || i === CLS_STARLINK);   // Starlink is a working satellite: no status, no Starlink
  }

  _hidden(name) { return !!(this._isKindHidden && this._isKindHidden(name)); }

  /** Legend state for tests and the browser probe: kind name -> true when its box is ticked (shown). Kinds the key does not list are left out. */
  legendState() {
    const out = {};
    if (this._els.legendItems) CLASS_NAMES.forEach((n) => { if (this._kindInKey(n)) out[n] = !this._hidden(n); });
    return out;
  }

  isShown() { return this._shown; }
  info() { return this._info; }
  get root() { return this._els.root || null; }
  /** The kinds the key lists now (class names, CLASS_NAMES order), open group or not, for tests and the browser probe. */
  legendNames() {
    return this._els.legendItems ? CLASS_NAMES.filter((n) => this._kindInKey(n)) : [];
  }
  /** The kinds the key lists, in the order they are drawn, top to bottom (LEGEND_ORDER). */
  legendDrawOrder() {
    return this._els.legendItems ? LEGEND_ORDER.map((i) => CLASS_NAMES[i]).filter((n) => this._kindInKey(n)) : [];
  }

  /**
   * The boxes `-` and `+` count on the globe, top to bottom (Sky 32, DECISIONS §104 row 4): the three groups (a group is ONE box, open or closed),
   * then "reach" when its switch is wired. The "military" mark is not one of them.
   */
  keyBoxes() {
    if (!this._els.legendItems) return [];
    const out = KEY_GROUPS.map((g) => g.id);
    if (this._reachSwitch) out.push(REACH_NAME);
    return out;
  }

  _groupKinds(g) { return g.kinds.filter((n) => this._kindInKey(n)); }

  /** A group's tick, from its kinds that the key lists: 'on', 'off' or 'dash' (some). The kinds the layer holds are the one truth. */
  groupState(id) {
    const g = KEY_GROUPS.find((x) => x.id === id);
    return g ? groupState(this._groupKinds(g), (n) => this._hidden(n)) : 'off';
  }

  /**
   * Tick or untick a whole group. Unticking remembers which kinds were ticked; ticking an unticked group brings those back (all of them when
   * none are remembered); ticking a half-ticked group ticks all (a tap on the dash). The "military" mark is never touched.
   * @param {string} id a KEY_GROUPS id @param {boolean} on
   */
  setGroupTicked(id, on) {
    const g = KEY_GROUPS.find((x) => x.id === id);
    if (!g || !this._onToggleKind) return;
    const kinds = this._groupKinds(g);
    const st = groupState(kinds, (n) => this._hidden(n));
    let want;
    if (!on) {
      if (st === 'off') return;
      this._memory.set(id, kinds.filter((n) => !this._hidden(n)));
      want = new Set();
    } else {
      if (st === 'on') return;
      const mem = st === 'off' ? (this._memory.get(id) || []).filter((n) => kinds.includes(n)) : [];
      want = new Set(mem.length ? mem : kinds);
      this._memory.delete(id);
    }
    for (const n of kinds) if (this._hidden(n) === want.has(n)) this._onToggleKind(n);   // flips each kind that is not as wanted
    this._renderLegend();
  }

  /** Whether a group is open (its rows show). */
  groupOpen(id) { return this._open.has(id); }

  /**
   * Open or close a group (saved). With a touch screen opening one closes the other: the iPad's rows are 44 px tall, so Satellites open (9 rows)
   * already fills the panel and both open (11 rows) would not fit.
   */
  setGroupOpen(id, open) {
    const g = KEY_GROUPS.find((x) => x.id === id);
    if (!g || !g.open) return;
    if (open === this._open.has(id)) return;
    if (open) { if (this._glass) this._open.clear(); this._open.add(id); } else this._open.delete(id);
    this._saveOpen();
    this._renderLegend();
    // The iPad panel is 342 px high and scrolls (PANEL_MAX_PX_GLASS), and 44 px rows do not fit under the highlight menu: bring the opened group to the top of the view
    const ge = this._els.groupEls && this._els.groupEls[id], root = this._els.root;
    if (open && this._glass && ge && root && typeof ge.row.offsetTop === 'number') root.scrollTop = Math.max(0, ge.row.offsetTop - 6);
  }

  _loadOpen() {
    try {
      const raw = this._storage ? this._storage.getItem(StorageKeys.REAL_SKY_GROUPS) : null;
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list)) for (const id of list) { const g = KEY_GROUPS.find((x) => x.id === id); if (g && g.open) this._open.add(id); }
    } catch (_) { /* a bad value = all closed */ }
    this._clampOpenForTouch();
  }

  /**
   * The iPad opens one group at a time (11 rows of 44 px do not fit): when both were saved open (from a Mac, or before this rule) only Satellites comes back
   * (Sky 33 review c). Not saved: the saved list still holds both, so the Mac gets them back. Runs at load and when the card learns it is on touch.
   */
  _clampOpenForTouch() {
    const glass = this._glass || (typeof this._isGlass === 'function' && this._isGlass() === true);
    if (glass && this._open.size > 1) this._open = new Set([this._open.has('satellites') ? 'satellites' : [...this._open][0]]);
  }

  _saveOpen() {
    try { if (this._storage) this._storage.setItem(StorageKeys.REAL_SKY_GROUPS, JSON.stringify(KEY_GROUPS.filter((g) => this._open.has(g.id)).map((g) => g.id))); } catch (_) { /* private mode: not saved */ }
  }

  /** The "military" mark is on (the layer draws rings). False with no layer. */
  militaryOn() { return !!(this._isMilitary && this._isMilitary()); }

  /**
   * The player hides or shows the whole panel (the globe's `-` / `+` steps, DECISIONS §102 row 3). The panel still counts as shown for the layer
   * (`isShown`); it just draws nothing, reports no box, and the radio box / right column's dodge and the touch lift go with it. A tapped dot
   * (`setObject` with an object) shows it again.
   * @param {boolean} hidden
   */
  setPanelHidden(hidden) {
    const h = hidden === true;
    if (h === this._panelHidden) return;
    this._panelHidden = h;
    if (this._els.root) {
      if (h && this._doc && this._doc.activeElement && this._els.root.contains && this._els.root.contains(this._doc.activeElement) && typeof this._doc.activeElement.blur === 'function') this._doc.activeElement.blur();
      this._syncDisplay();
      this._syncDodge();
    }
  }

  /** True while the player has the panel hidden. */
  panelHidden() { return this._panelHidden === true; }

  /** True while the card shows its "could not be loaded" line. */
  loadFailedShown() { return !!(this._els.fail && this._els.fail.style.display === 'block'); }

  _build() {
    if (this._built || !this._doc || !this._doc.body) return;
    this._built = true;
    const d = this._doc;
    const el = (tag, css, text) => { const e = d.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
    const root = el('div', PANEL_CSS);
    root.id = 'real-sky-panel';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Real satellites and debris');

    const input = d.createElement('input');
    input.type = 'search';
    input.id = 'real-sky-search';
    input.placeholder = 'Search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search the real catalogue by name or number');
    input.style.cssText = ['width:100%', 'box-sizing:border-box', 'padding:5px 7px', 'border-radius:4px', 'border:1px solid rgba(160,180,220,0.35)',
      'background:rgba(0,0,0,0.45)', 'color:#e8eefc', 'font:inherit', 'font-size:12px', 'outline:none', 'user-select:text', '-webkit-user-select:text'].join(';');
    const stop = (e) => e.stopPropagation();       // typing never reaches the game's key handlers
    for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, stop);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.search(input.value); }
      else if (e.key === 'Escape') { input.blur(); }
    });
    input.addEventListener('input', () => { this._els.msg.textContent = ''; });

    const msg = el('div', 'min-height:0;color:#ffb06b;margin-top:3px');
    const card = el('div', 'display:none;margin-top:7px;padding-top:6px;border-top:1px solid rgba(160,180,220,0.2)');
    const head = el('div', 'display:flex;align-items:flex-start;gap:6px');
    const title = el('div', 'flex:1;font-size:13px;font-weight:bold;word-break:break-word');
    const dot = el('span', 'display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:baseline');
    const nameEl = el('span');
    title.append(dot, nameEl);
    const close = el('button', 'flex:none;border:0;background:transparent;color:#9fb0d0;font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 2px', '\u00d7');
    close.setAttribute('aria-label', 'Close the object card');
    close.addEventListener('click', () => { this.setObject(null); if (this._onClose) this._onClose(); });
    head.append(title, close);
    const body = el('div', 'margin-top:3px');
    card.append(head, body);

    // The colour key is also the show/hide switch (owner 2026-11-18, DECISIONS §75 row 4), in ONE column of three groups (Sky 32, owner 2026-11-24,
    // DECISIONS §104 row 1): Satellites (working, Starlink, dead, no report, military), Rocket stages, Debris (pieces, unknown), then "reach". A group row
    // has a tick box (its own tap target), a dot, its word and an open/close arrow; the word and the arrow open it, the box ticks all its kinds. Rows
    // under an open group are indented. 44 px tall rows on glass, 22 px with a mouse (_renderLegend sets the height).
    const legend = el('div', 'margin-top:7px;display:grid;grid-template-columns:1fr;gap:2px 4px;font-size:10px;letter-spacing:0;color:#aebbd6');
    legend.id = 'real-sky-key';
    const ROW_CSS = 'display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer;box-sizing:border-box;min-height:22px;padding:0 3px;border-radius:4px;touch-action:manipulation';
    const BOX_CSS = 'flex:none;display:inline-block;width:12px;height:12px;box-sizing:border-box;border:1px solid #9fb0d0;border-radius:2px;line-height:10px;text-align:center;font-size:10px;color:#e8eefc';
    const dotCss = (c) => `flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:${c}`;
    const legendItems = new Array(CLASS_NAMES.length);   // legendItems[i] is class i's row (the Rocket stages group row for the stage class)
    // A click (mouse or finger) must not leave keyboard focus on a row, or Space (floor 4's approach command) would go to it instead of the game.
    // A row reached by Tab acts with Enter only; Space is never handled here, so it always reaches InputManager.
    const wire = (node, act) => {
      node.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); act(); if (typeof node.blur === 'function') node.blur(); });
      node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); act(); } });
    };
    const kindRow = (i) => {
      const n = CLASS_NAMES[i];
      const item = el('div', `${ROW_CSS};margin-left:18px`);
      item.title = `${LEGEND_HINTS[i]} (tap to show or hide)`;
      item.setAttribute('role', 'checkbox');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', LEGEND_LABELS[i]);
      item.append(el('span', BOX_CSS), el('span', `flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:${CLASS_COLORS[i]}`), el('span', null, LEGEND_LABELS[i]));
      wire(item, () => { if (this._onToggleKind) this._onToggleKind(n); this._renderLegend(); });
      legendItems[i] = item;
      return item;
    };
    // The "military" mark, the last row inside Satellites: a ring, not a dot (DECISIONS §104 row 3). Not a kind: the layer draws the rings; shown only when wired.
    const milItem = el('div', `${ROW_CSS};margin-left:18px`);
    milItem.id = 'real-sky-key-military';
    milItem.title = `${MIL_HINT} (tap to show or hide)`;
    milItem.setAttribute('role', 'checkbox');
    milItem.setAttribute('tabindex', '0');
    milItem.setAttribute('aria-label', MIL_NAME);
    milItem.append(el('span', BOX_CSS),
      el('span', `flex:none;display:inline-block;width:9px;height:9px;box-sizing:border-box;border:1px solid ${MIL_COLOR};border-radius:50%;margin:-1px`),
      el('span', null, MIL_NAME));
    wire(milItem, () => { if (this._onToggleMilitary) this._onToggleMilitary(); this._renderLegend(); });
    const groupEls = {};
    for (const g of KEY_GROUPS) {
      const row = el('div', ROW_CSS);
      row.setAttribute('aria-label', g.word);
      const boxWrap = el('span', 'flex:none;display:flex;align-items:center;justify-content:center;align-self:stretch;width:12px');
      const box = el('span', BOX_CSS);
      boxWrap.append(box);
      const arrow = el('span', 'flex:none;margin-left:auto;padding:0 4px;color:#9fb0d0;font-size:11px;line-height:1', '\u25b8');
      const kids = [];
      if (g.open) {
        row.title = `${g.hint} (tap to show or hide)`;   // Sky 33 review (d): the same plain line on the whole row as on its box (it said "tap the box ... tap the word")
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-expanded', 'false');
        boxWrap.setAttribute('role', 'checkbox');
        boxWrap.setAttribute('tabindex', '0');
        boxWrap.setAttribute('aria-label', g.word);
        boxWrap.title = `${g.hint} (tap to show or hide)`;
        row.append(boxWrap, el('span', dotCss(g.color)), el('span', null, g.word), arrow);
        wire(row, () => this.setGroupOpen(g.id, !this._open.has(g.id)));
        // the box ticks the group; a dash (some kinds ticked) ticks all (setGroupTicked)
        wire(boxWrap, () => this.setGroupTicked(g.id, this.groupState(g.id) !== 'on'));
        legend.append(row);
        for (const n of g.kinds) { const kr = kindRow(CLASS_NAMES.indexOf(n)); kids.push(kr); legend.append(kr); }
        if (g.id === 'satellites') { kids.push(milItem); legend.append(milItem); }
      } else {
        row.title = `${g.hint} (tap to show or hide)`;
        row.setAttribute('role', 'checkbox');
        row.setAttribute('tabindex', '0');
        row.append(boxWrap, el('span', dotCss(g.color)), el('span', null, g.word));
        wire(row, () => this.setGroupTicked(g.id, this.groupState(g.id) !== 'on'));
        legendItems[CLASS_NAMES.indexOf(g.kinds[0])] = row;
        legend.append(row);
      }
      groupEls[g.id] = { row, boxWrap, box, arrow, kids };
    }
    // The last box: the blue see-through band around Earth, her reach (owner 2026-11-24, DECISIONS §103 row 5). Not a kind of object: the switch is
    // wired by main.js (`setReachSwitch`), so it shows only when one is wired.
    const reachItem = el('div', 'display:none;align-items:center;gap:4px;white-space:nowrap;cursor:pointer;box-sizing:border-box;min-height:22px;padding:0 3px;border-radius:4px;touch-action:manipulation');
    reachItem.id = 'real-sky-key-reach';
    reachItem.title = `${REACH_HINT} (tap to show or hide)`;
    reachItem.setAttribute('role', 'checkbox');
    reachItem.setAttribute('tabindex', '0');
    reachItem.setAttribute('aria-label', REACH_NAME);
    reachItem.append(
      el('span', 'flex:none;display:inline-block;width:12px;height:12px;box-sizing:border-box;border:1px solid #9fb0d0;border-radius:2px;line-height:10px;text-align:center;font-size:10px;color:#e8eefc'),
      el('span', `flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:${REACH_COLOR}`),
      el('span', null, REACH_NAME));
    const toggleReach = () => { const sw = this._reachSwitch; if (sw) sw.setOn(!sw.isOn()); this._renderLegend(); };
    reachItem.addEventListener('click', () => { toggleReach(); if (typeof reachItem.blur === 'function') reachItem.blur(); });
    reachItem.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggleReach(); } });
    legend.append(reachItem);
    // One small credit line naming every source; a tap opens the full wording, a second tap closes it (owner 2026-11-17, DECISIONS §74 row 3).
    const credit = el('div', 'margin-top:2px;padding:4px 0 0;font-size:10px;line-height:1.3;color:#8392b3;cursor:pointer');
    credit.id = 'real-sky-credit';
    credit.setAttribute('role', 'button');
    credit.setAttribute('tabindex', '0');
    credit.setAttribute('aria-expanded', 'false');
    credit.title = 'Tap for the full credit';
    credit.addEventListener('click', () => this.toggleCredit());
    credit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.toggleCredit(); } });
    // The credit line is not on the panel any more (Sky 34, owner 2026-11-25; the Tech library names the sources): the element stays detached so the credit calls keep working.
    const fail = el('div', 'display:none;margin-top:7px;color:#ffb06b', 'The sky data could not be loaded.');
    fail.id = 'real-sky-load-failed';
    const hl = this._hlBuildDom(el);

    root.append(input, msg, fail, hl.wrap, card, legend);
    d.body.appendChild(root);
    // A size change the render calls do not see (a late font) moves the panel's bottom too.
    if (typeof ResizeObserver !== 'undefined') { try { this._ro = new ResizeObserver(() => this._syncDodge()); this._ro.observe(root); } catch (_) { this._ro = null; } }
    Object.assign(this._els, { root, input, msg, card, titleEl: title, nameEl, dot, body, credit, legend, legendItems, groupEls, milItem, reachItem, fail, hl });
    // A double-click or double-tap on the object's name turns floor 4's globe to it (two clicks within 350 ms; a click fires for mouse and finger).
    let lastNameClick = -Infinity;
    title.style.cursor = 'pointer';
    title.addEventListener('click', () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - lastNameClick <= NAME_DOUBLE_MS) { lastNameClick = -Infinity; if (this._onFlyName) this._onFlyName(); } else lastNameClick = now;
    });
    this._place();
    this._render();
  }

  /**
   * Touch (glass) or mouse, and the floor: the layer tells the card each frame; the placement changes only when the answer changes.
   * @param {boolean} glass
   * @param {number|null} floor
   */
  setLayout(glass, floor) {
    this._hlTick();                                 // the list's "behind Earth" tags follow the camera (a few times a second)
    const g = glass === true, f = floor === FLOOR_GLOBE ? FLOOR_GLOBE : (floor === FLOOR_CHART ? FLOOR_CHART : null);
    const arrived = f === FLOOR_GLOBE && this._floor === null;   // the globe entered from a floor without the layer (page 1 -> globe is not)
    if (g !== this._glass || f !== this._floor || !this._placed) {
      this._glass = g;
      this._clampOpenForTouch();
      this._floor = f;
      this._place();
      this._renderLegend();                         // the chips are taller on glass
    }
    if (this._hlDefault) this._hlDefaultStep(f, arrived);
  }

  /**
   * The default highlight (owner 2026-11-24, "turn it on by default"): on each arrival at the globe the default item goes on once the catalogue is
   * in, unless one is on already or the player turned one off since the game loaded. Until the player has picked an item, the default is Your
   * country when the menu language (read now, it can change in the menu) is not USA and that item exists, else Famous; after a pick it is the
   * item last turned on.
   */
  _hlDefaultStep(f, arrived) {
    if (f !== FLOOR_GLOBE) { this._hlDefaultArmed = false; return; }
    if (arrived && !this._hlUserOff) this._hlDefaultArmed = true;
    if (!this._hlDefaultArmed) return;
    const L = this._layer;
    if (!L || typeof L.catalogue !== 'function' || !L.catalogue()) return;   // the data is still loading
    this._hlDefaultArmed = false;
    if (typeof L.highlight === 'function' && L.highlight()) return;
    let id = this._hlDefault;
    if (!this._hlPicked) {
      const flag = this._getFlag ? this._getFlag() : null;
      if (flag && flag !== 'USA' && this._hlItemList(L.catalogue()).some((it) => it.id === ID_COUNTRY)) id = ID_COUNTRY;
    }
    if (!this._hlItemList(L.catalogue()).some((it) => it.id === id)) id = ID_FAMOUS;   // a family (or any item) the data no longer has: today's default
    this.hlPick(id, true);
  }

  /** Applies panelPlacement(glass, floor, clock shown) to the panel (no-op before the panel is built). */
  _place() {
    const root = this._els.root;
    if (!root) return;
    const p = panelPlacement(this._glass, this._floor, this._clockShown);
    root.style.top = p.top;
    root.style.bottom = p.bottom;
    root.style.right = p.right;
    root.style.maxHeight = p.maxHeight;
    // On the globe and page 1 the panel is the second box of the corner column (Sky 30 F): flush with the screen's right edge like the radio box (no right border,
    // no round corners on the sides that touch the screen or the buttons), round only at the bottom left.
    const column = this._floor === FLOOR_GLOBE || this._floor === FLOOR_CHART;
    root.style.borderRightWidth = column ? '0' : '1px';
    root.style.borderRadius = column ? '0 0 0 6px' : '6px';
    // Page 1 (floor 5, Sky 20): the panel is the object card ONLY: no search box, tick boxes or credit row (the page has its own buttons and the
    // credit is in the Tech library), and nothing at all while no dot is picked (`_syncDisplay`).
    const page1 = this._floor === FLOOR_CHART;
    root.style.visibility = 'visible';
    const e = this._els;
    if (e.input) e.input.style.display = page1 ? 'none' : '';
    if (e.msg) e.msg.style.display = page1 ? 'none' : '';
    this._syncCardGap();
    if (page1 && e.input && this._doc && this._doc.activeElement === e.input) e.input.blur();
    this._placed = true;
    this._syncDisplay();
    this._hlRender(true);
    this._renderLegend();
    this._syncDodge();
  }

  /**
   * Whether the time buttons are on screen (main.js tells the card each frame; the globe's `-` steps can hide them). The panel then stands under them,
   * else at the top, and the radio box and right column dodge to match.
   * @param {boolean} shown
   */
  setClockShown(shown) {
    const s = shown !== false;
    if (s === this._clockShown) return;
    this._clockShown = s;
    if (this._els.root && this._placed) { this._place(); this._measure(); }
  }

  /** The card's own top rule and gap separate it from what is above it; page 1 shows the card alone, or under the Highlight header when one is on. */
  _syncCardGap() {
    const e = this._els;
    if (!e.card) return;
    const alone = this._page1() && !this._hlHeadOn;
    e.card.style.marginTop = alone ? '0' : '7px';
    e.card.style.paddingTop = alone ? '0' : '6px';
    e.card.style.borderTop = alone ? 'none' : '1px solid rgba(160,180,220,0.2)';
  }

  /** @returns {boolean} the card shows the debris page's card-only form (floor 5) */
  _page1() { return this._floor === FLOOR_CHART; }

  /** The panel's own display: on the globe it shows whenever the card is on; on page 1 only while a dot is picked or a highlight is on (its header and "Off"). */
  _syncDisplay() {
    const root = this._els.root;
    if (!root) return;
    const want = this._shown && this._panelHidden !== true && (!this._page1() || !!this._info || !!this._hlHeadOn);
    const v = want ? 'block' : 'none';
    if (root.style.display !== v) root.style.display = v;
  }

  /**
   * The panel's box on screen (CSS px) as measured at the last write moment (a show, a render, a size change), or null while it is not on
   * screen. Cached so the chart can keep its labels clear of an open card without a per-frame layout read (Sky 20).
   * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
   */
  box() { return this._box || null; }

  /** @private Measure the panel's box now (write moments only). */
  _measure() {
    const root = this._els.root;
    let b = null;
    if (root && this._shown && root.style.display !== 'none' && typeof root.getBoundingClientRect === 'function') {
      const r = root.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) b = { x0: Math.round(r.left), y0: Math.round(r.top), x1: Math.round(r.right), y1: Math.round(r.bottom) };
    }
    // The time buttons above the panel are part of the corner column: the highlight's names keep clear of them too (Sky 30 F), whether or not the panel is up.
    const clock = this._shown && this._clockShown && this._floor != null && this._doc && this._doc.getElementById ? this._doc.getElementById(CLOCK_ID) : null;
    if (clock && clock.style && clock.style.display !== 'none' && typeof clock.getBoundingClientRect === 'function') {
      const c = clock.getBoundingClientRect();
      if (c && c.width > 0 && c.height > 0) {
        const cb = { x0: Math.round(c.left), y0: Math.round(c.top), x1: Math.round(c.right), y1: Math.round(c.bottom) };
        b = b ? { x0: Math.min(b.x0, cb.x0), y0: Math.min(b.y0, cb.y0), x1: Math.max(b.x1, cb.x1), y1: Math.max(b.y1, cb.y1) } : cb;
      }
    }
    const o = this._box;
    if ((!o && !b) || (o && b && o.x0 === b.x0 && o.y0 === b.y0 && o.x1 === b.x1 && o.y1 === b.y1)) return;
    this._box = b;
    if (this._layer && typeof this._layer.setKeepOut === 'function') this._layer.setKeepOut(b);   // the highlight's name boxes keep clear of the panel
  }

  /**
   * Floor 4 or 5 + showing: put the radio box and the right column (Targets / Target info panes, NEXT when shown) under the panel (attribute + the panel's
   * bottom + SKY_PANEL_GAP_PX as a CSS variable on <html>), on the Mac and the iPad alike (Sky 30 F: the panel is directly under the time buttons on both);
   * with no panel up on the globe they go under the time buttons; in every other state take it all back. Floor 5 (D7, review of 2026-11-19):
   * the panes of the right column are there on page 1 after a `+` as on floor 4 (no floor test in the `+` walk: PaneDensity, HUD `_densityIsAvailable`; the `+` / `-` KEYS are locked on floor 5 since Sky 20, the slider is not), so the same dodge applies. Writes
   * only on change; reads the panel's rect only here (a show, a re-render, a size change), never per frame.
   */
  _syncDodge() {
    const d = this._doc, de = d && d.documentElement;
    if (!de || !de.style || typeof de.setAttribute !== 'function') return;
    const root = this._els.root;
    this._syncDisplay();
    this._measure();
    // Page 1 shows the panel only with a card open: with none there is nothing to dodge.
    const panelUp = !!root && this._shown && this._panelHidden !== true && (this._floor === FLOOR_GLOBE || (this._floor === FLOOR_CHART && (!!this._info || !!this._hlHeadOn)));
    // Sky 30 (§102 row 7): on the globe the time buttons stand at the top right on every screen, so with no panel under them (the player hid it with `-`)
    // the radio box and right column still start under the buttons; with the buttons hidden too (a second `-`) they go back to the top.
    const clockOnly = !panelUp && !!root && this._floor === FLOOR_GLOBE && this._clockShown;
    const on = panelUp || clockOnly;
    if (!on) {
      if (this._dodgeOn) { de.removeAttribute(SKY_PANEL_TOP_ATTR); de.style.removeProperty(SKY_PANEL_DY_VAR); this._dodgeOn = false; this._dodgeDy = NaN; }
      return;
    }
    if (!this._dodgeStyle && d.head && d.createElement) {
      const st = d.createElement('style');
      st.id = SKY_PANEL_STYLE_ID;
      st.textContent = SKY_PANEL_TOP_CSS;
      d.head.appendChild(st);
      this._dodgeStyle = st;
    }
    const r = panelUp && typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    const dy = panelUp ? Math.round((r && r.bottom) || 0) + SKY_PANEL_GAP_PX : SKY_CLOCK_EDGE_PX + SKY_CLOCK_H_PX + SKY_PANEL_GAP_PX;
    if (!this._dodgeOn) { de.setAttribute(SKY_PANEL_TOP_ATTR, ''); this._dodgeOn = true; }
    if (dy !== this._dodgeDy) { de.style.setProperty(SKY_PANEL_DY_VAR, `${dy}px`); this._dodgeDy = dy; }
  }

  /** Whether the CelesTrak status was joined into the data: when not, no dot is working or dead, so those two legend entries are hidden. */
  setStatusJoined(joined) {
    this._statusJoined = joined === true;
    this._renderLegend();
  }

  /** The fetch of the sky data failed: the card says so instead of showing an empty legend. */
  setLoadFailed(failed) {
    this._loadFailed = failed === true;
    this._renderLegend();
  }

  _renderLegend() {
    const e = this._els;
    if (!e.root) return;
    const p1 = this._page1();                       // page 1 (Sky 20): the card only: no failure line, key or credit row
    e.fail.style.display = this._loadFailed && !p1 ? 'block' : 'none';
    // Touch: the six-kind key folds while the Highlight menu or a list is open, so the panel stays within its 342 px (research 2.1)
    e.legend.style.display = this._loadFailed || p1 || (this._glass && this._hlView !== 'closed') ? 'none' : 'grid';
    e.credit.style.display = this._loadFailed || p1 ? 'none' : 'block';
    const minH = this._glass ? '44px' : '22px';
    const tick = (item, off) => {   // a kind row: the box holds a tick or nothing; a row that is off is dimmed
      item.style.minHeight = minH;
      item.style.opacity = off ? '0.45' : '1';
      item.setAttribute('aria-checked', off ? 'false' : 'true');
      item.children[0].textContent = off ? '' : '\u2713';
    };
    for (const g of KEY_GROUPS) {
      const ge = e.groupEls[g.id];
      const kinds = this._groupKinds(g);
      const st = groupState(kinds, (n) => this._hidden(n));
      const open = g.open && this._open.has(g.id);
      ge.row.style.display = kinds.length ? 'flex' : 'none';
      ge.row.style.minHeight = minH;
      ge.row.style.opacity = st === 'off' ? '0.45' : '1';
      ge.box.textContent = st === 'on' ? '\u2713' : (st === 'dash' ? '\u2013' : '');
      const mixed = st === 'dash' ? 'mixed' : (st === 'on' ? 'true' : 'false');
      if (g.open) {
        ge.boxWrap.style.width = this._glass ? '40px' : '20px';
        ge.boxWrap.setAttribute('aria-checked', mixed);
        ge.row.setAttribute('aria-expanded', open ? 'true' : 'false');
        ge.arrow.textContent = open ? '\u25be' : '\u25b8';
        ge.arrow.style.padding = this._glass ? '0 10px' : '0 4px';
      } else {
        ge.boxWrap.style.width = this._glass ? '40px' : '20px';
        ge.row.setAttribute('aria-checked', mixed);
      }
    }
    CLASS_NAMES.forEach((n, i) => {
      const item = e.legendItems[i];
      const inGroup = KEY_GROUPS.find((g) => g.open && g.kinds.includes(n));
      if (!inGroup) return;                                                     // the Rocket stages row was drawn with its group above
      item.style.display = this._kindInKey(n) && this._open.has(inGroup.id) ? 'flex' : 'none';
      tick(item, this._hidden(n));
    });
    const mi = e.milItem;
    if (mi) {   // the "military" mark: inside Satellites, shown with its handlers while Satellites is open; ticked while the rings are on
      const onM = this.militaryOn();
      mi.style.display = this._onToggleMilitary && (!this._hasMilitary || this._hasMilitary()) && this._open.has('satellites') ? 'flex' : 'none';
      tick(mi, !onM);
    }

    const ri = e.reachItem;
    if (ri) {   // the reach box: shown with its switch, ticked while the band is on
      const sw = this._reachSwitch, offR = !!sw && !sw.isOn();
      ri.style.display = sw ? 'flex' : 'none';
      ri.style.minHeight = this._glass ? '44px' : '22px';
      ri.style.opacity = offR ? '0.45' : '1';
      ri.setAttribute('aria-checked', offR ? 'false' : 'true');
      ri.children[0].textContent = offR ? '' : '\u2713';
    }
    this._syncDodge();                              // the panel's height may have changed (rows shown or hidden)
  }

  show() {
    if (this._isGlass) this._glass = this._isGlass() === true;
    this._build();
    this._shown = true;
    this._place();
  }

  hide() {
    this._shown = false;
    this._syncDisplay();
    this._syncDodge();
    if (this._els.input && this._doc && this._doc.activeElement === this._els.input) this._els.input.blur();
  }

  /** The field's Enter: runs the search through the layer. */
  search(query) {
    if (!this._onSearch) return -1;
    return this._onSearch(query);
  }

  /** A tap picked an object: the search text no longer describes the card, so it goes. */
  clearSearch() { if (this._els.input) this._els.input.value = ''; }

  /** The object's card (fields from cardFields) or null to close it. */
  setObject(info) {
    this._info = info || null;
    if (info && this._panelHidden === true) this.setPanelHidden(false);   // a tapped dot shows the panel again (DECISIONS §102 row 3)
    if (this._els.msg) this._els.msg.textContent = '';
    this._render();
  }

  setNoMatch(query) {
    if (this._els.msg) this._els.msg.textContent = query ? `No match for "${query}"` : '';
  }

  setCredit(text) {
    this._credit = text || '';
    this._renderCredit();
  }

  /** Opens / closes the full credit wording (the default is the one short line). */
  toggleCredit() {
    this._creditOpen = !this._creditOpen;
    this._renderCredit();
  }

  /** True while the full credit wording shows. */
  creditOpen() { return this._creditOpen === true; }

  /** The credit line as drawn now (short by default, the full wording when opened). */
  creditText() { return this._els.credit ? this._els.credit.textContent : ''; }

  _renderCredit() {
    const c = this._els.credit;
    if (!c) return;
    c.textContent = this._creditOpen ? this._credit : shortCredit(this._credit);
    c.setAttribute('aria-expanded', this._creditOpen ? 'true' : 'false');
    c.title = this._creditOpen ? 'Tap to shorten' : 'Tap for the full credit';
  }

  /* ---------------------------------------------------------------- the Highlight menu (Sky 23, lane H3; DECISIONS §95)
   * One row "Highlight" under the search box; it opens the three items (Famous, Your country, Heaviest leftovers); an item that is on shows its
   * header (name, count, "Off") and its list; a list row turns the globe to the object and opens its card. The lists come from HighlightItems,
   * the drawing (fade, rings, names) from the layer's setHighlight. With a card open the list folds to its header; on page 1 only the header and
   * "Off" show; on touch the six-kind key folds while the menu or a list is open. The panel is 342 px at most on the iPad (`panelPlacement`). */

  /** The layer gives the card its highlight calls (`setHighlight`, `clearHighlight`, `setKeepOut`, `flyTo`, `select`, `rowOf`, `catalogue`, `highlights`). main.js calls this right after building the layer. */
  attachLayer(layer) {
    if (this._offHl) { this._offHl(); this._offHl = null; }
    this._layer = layer || null;
    if (layer && typeof layer.onHighlightChange === 'function') this._offHl = layer.onHighlightChange((h) => this._hlOnLayer(h));
    this._hlItems = null;
    this._hlRender();
  }

  _hlBuildDom(el) {
    const mk = (id, css) => { const e = el('div', css); e.id = id; return e; };
    // a button: a click (mouse or finger) or Enter; never Space (the game's own key), and no focus is left on it
    const press = (node, fn) => {
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(); if (typeof node.blur === 'function') node.blur(); });
      node.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); fn(); } });
    };
    const wrap = mk('real-sky-highlight', 'display:none;margin-top:7px');
    const btn = mk('real-sky-hl-btn', `display:none;align-items:center;justify-content:space-between;box-sizing:border-box;padding:0 8px;${HL_BTN_CSS}`);
    press(btn, () => this._hlToggleMenu());
    const items = mk('real-sky-hl-items', 'display:none;margin-top:3px');
    const head = mk('real-sky-hl-head', 'display:none;align-items:center;gap:4px');
    const nameBtn = mk('real-sky-hl-name', 'flex:1;min-width:0;display:flex;align-items:center;box-sizing:border-box;font-size:11px;line-height:14px;font-weight:bold;color:#e8eefc;cursor:pointer;touch-action:manipulation;overflow:hidden;white-space:normal;overflow-wrap:anywhere');
    press(nameBtn, () => this._hlToggleMenu());
    const off = mk('real-sky-hl-off', `flex:none;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0 10px;${HL_BTN_CSS}`);
    off.textContent = 'Off';
    off.setAttribute('aria-label', 'Turn the highlight off');
    press(off, () => this._hlOff());
    head.append(nameBtn, off);
    const tag = mk('real-sky-hl-tag', 'display:none;margin-top:2px;font-size:10px;line-height:1.3;color:#8392b3');
    const strip = mk('real-sky-hl-strip', 'display:none;margin-top:3px;font-size:10px;line-height:1.3;color:#c9d6ef;min-height:13px');
    const list = mk('real-sky-hl-list', 'display:none;margin-top:3px;overflow-y:auto;overflow-x:hidden;touch-action:pan-y;-webkit-overflow-scrolling:touch');
    const more = mk('real-sky-hl-more', 'display:none;margin-top:2px;font-size:10px;color:#8392b3');
    wrap.append(btn, items, head, tag, strip, list, more);
    return { wrap, btn, items, head, nameBtn, off, tag, strip, list, more, itemEls: [], rowEls: [], listKey: '', itemsKey: '', famRow: null, press };
  }

  /** The built items for the layer's data and the menu language (cached; rebuilt when the data, the language, the country extras, the status or a family's "+ dead" change). */
  _hlItemList(cat) {
    const L = this._layer, hl = L && typeof L.highlights === 'function' ? L.highlights() : null;
    const flag = this._getFlag ? this._getFlag() : null;
    const key = `${flag}|${this._hlExtras.stages ? 1 : 0}${this._hlExtras.debris ? 1 : 0}|${this._statusJoined ? 1 : 0}|${this._hlFamDead || ''}`;
    if (!this._hlItems || this._hlItemsKey !== key || this._hlItemsCat !== cat || this._hlItemsHl !== hl) {
      this._hlItems = buildItems(cat, hl, flag, this._hlExtras, { joined: this._statusJoined, famDead: this._hlFamDead });
      this._hlItemsKey = key; this._hlItemsCat = cat; this._hlItemsHl = hl;
    }
    return this._hlItems;
  }

  /** The menu's items as built now (tests and the browser probe). */
  hlItems() {
    const cat = this._layer && this._layer.catalogue ? this._layer.catalogue() : null;
    return cat ? this._hlItemList(cat) : [];
  }

  /** The highlight changed in the layer (set, swapped, cleared, or cleared by leaving the floors). */
  _hlOnLayer(h) {
    // cleared while floor 4 or page 1 still has the layer: Off or Esc (leaving the floors clears it with no floor)
    if (!h && this._layer && typeof this._layer.isActive === 'function' && this._layer.isActive()) this._hlUserOff = true;
    if (!h) { this._hlView = 'closed'; this._hlStrip = ''; this._hlExtras = { stages: false, debris: false }; this._hlFamDead = null; }
    else if (this._hlView === 'closed') this._hlView = 'list';
    this._hlRender();
    this._hlTick(true);
  }

  /** The header of the item that is on: a family counts how many of its lit dots are drawn ("Navigation \u00b7 289 of 642 shown"); the others keep their own. */
  _hlHeaderOf(item) {
    if (!item.family || item.noCount) return item.header;   // People on board counts craft, so its header is fixed ("2 stations, 3 crew ships")
    return `${item.title} \u00b7 ${fmtInt(this._hlShownOf(item))} of ${fmtInt(item.all)} shown`;
  }

  /**
   * How many of a family's lit dots are drawn now: the lit NORAD numbers minus those whose kind the player hid in the key (a hidden kind is not drawn
   * and not counted; its list rows keep their "hidden" tag). Counted when the item or the hidden kinds change (the key's boxes call refreshKinds), never per frame.
   */
  _hlShownOf(item) {
    const L = this._layer, rows = L && typeof L.rows === 'function' ? L.rows() : null;
    const hid = CLASS_NAMES.map((n, k) => (this._hidden(n) ? k : -1)).filter((k) => k >= 0);
    if (!rows || typeof L.rowOf !== 'function' || hid.length === 0) return item.litCount;
    const key = `${item.id}|${item.litCount}|${item.famDead ? 1 : 0}|${hid.join(',')}`;
    if (this._hlShownKey !== key || this._hlShownItem !== item) {
      let n = 0;
      for (const norad of item.norads) { const i = L.rowOf(norad); if (i >= 0 && !hid.includes(rows[i][2])) n++; }
      this._hlShownKey = key; this._hlShownItem = item; this._hlShown = n;
    }
    return this._hlShown;
  }

  /** The Highlight row (closed, or an item is on and the menu is asked for) opens or closes the three items. */
  _hlToggleMenu() {
    const cur = this._layer && this._layer.highlight ? this._layer.highlight() : null;
    this._hlView = this._hlView === 'menu' ? (cur ? 'list' : 'closed') : 'menu';
    this._hlRender();
  }

  /** The "Families" row opens or closes the five family rows under it (not saved). On touch the menu is taller than the panel: the opened rows are scrolled into view. */
  _hlToggleFamilies() {
    this._hlFamOpen = !this._hlFamOpen;
    this._hlRender();
    const fe = this._els.hl && this._els.hl.famRow, root = this._els.root;
    if (this._hlFamOpen && this._glass && fe && root && typeof fe.offsetTop === 'number') root.scrollTop = Math.max(0, fe.offsetTop - 6);
  }

  /**
   * Turn an item on (replacing the one that is on).
   * @param {string} id @param {boolean} [auto] the default step, not the player: it does not count as a pick
   * @param {{extras?: {stages?: boolean, debris?: boolean}, famDead?: boolean}|null} [state] the item's own state to come back with (the globe's `+` after a `-`)
   * @returns {boolean}
   */
  hlPick(id, auto = false, state = null) {
    const L = this._layer;
    const cat = L && L.catalogue ? L.catalogue() : null;
    if (!cat) return false;
    const cur = L.highlight ? L.highlight() : null;
    if (cur && cur.id === id) { if (this._hlDefault && !auto) { this._hlDefault = id; this._hlPicked = true; } this._hlView = 'list'; this._hlRender(); return true; }
    if (id !== ID_COUNTRY || !cur || cur.id !== ID_COUNTRY) this._hlExtras = { stages: false, debris: false };
    this._hlFamDead = null;
    if (state && id === ID_COUNTRY && state.extras) this._hlExtras = { stages: state.extras.stages === true, debris: state.extras.debris === true };
    if (state && state.famDead === true) this._hlFamDead = id;
    const it = this._hlItemList(cat).find((i) => i.id === id);
    if (!it) { this._hlFamDead = null; return false; }
    this._hlView = 'list';
    this._hlStrip = '';
    if (it.group === 'families') this._hlFamOpen = true;   // the menu, opened again, shows the family rows so another one is one tap away
    if (this._hlDefault && !auto) { this._hlDefault = id; this._hlPicked = true; }   // the next arrival at the globe brings back the item the player last turned on
    this._hlUserOff = false;                        // a pick after an Off: the default is back
    L.setHighlight(toHighlight(it));
    this._hlRender();
    return true;
  }

  /** The "Off" button: the normal sky is back. */
  _hlOff() { if (this._layer && this._layer.clearHighlight) this._layer.clearHighlight(); }

  /** A menu highlight is on (the globe's `-` turns it off first; GlobeSteps `highlight.isOn`). */
  hlIsOn() {
    const cur = this._layer && this._layer.highlight ? this._layer.highlight() : null;
    return !!cur && isMenuId(cur.id);
  }

  /**
   * The globe's `-`: turn the highlight off and hand back what is needed to put it back exactly (GlobeSteps `highlight.off`).
   * @returns {{id: string, extras: {stages: boolean, debris: boolean}, famDead: boolean}|null} null when no menu highlight was on
   */
  hlTurnOff() {
    const cur = this._layer && this._layer.highlight ? this._layer.highlight() : null;
    if (!cur || !isMenuId(cur.id)) return null;
    const snap = { id: cur.id, extras: { ...this._hlExtras }, famDead: this._hlFamDead === cur.id };
    this._hlOff();
    return snap;
  }

  /** The globe's `+` after that `-`: the same item on again, with the same extras / "+ dead" state (GlobeSteps `highlight.restore`). @param {{id: string, extras?: object, famDead?: boolean}|null} snap @returns {boolean} */
  hlRestore(snap) {
    if (!snap || typeof snap.id !== 'string') return false;
    return this.hlPick(snap.id, true, snap);
  }

  /** A list row: Your country's "+ stages" / "+ debris" rows add that kind; any other turns the globe to the object (the first of a group) and opens its card. */
  hlTapRow(row) {
    const L = this._layer;
    if (!L || !row) return false;
    if (row.toggle === 'famDead') {                 // a family's "+ dead": the item's own state, kept here; the sets swap, nothing else moves
      const cur = L.highlight ? L.highlight() : null;
      const cat = L.catalogue ? L.catalogue() : null;
      if (!cur || !cat) return false;
      this._hlFamDead = this._hlFamDead === cur.id ? null : cur.id;
      const it = this._hlItemList(cat).find((i) => i.id === cur.id);
      if (it) L.setHighlight(toHighlight(it));
      return true;
    }
    if (row.toggle) {
      this._hlExtras = { ...this._hlExtras, [row.toggle]: !this._hlExtras[row.toggle] };
      const cat = L.catalogue ? L.catalogue() : null;
      const it = cat ? this._hlItemList(cat).find((i) => i.id === ID_COUNTRY) : null;
      if (it) L.setHighlight(toHighlight(it));        // same id: the sets swap, nothing else moves
      return true;
    }
    if (this._floor !== FLOOR_GLOBE) return false;
    const i = L.rowOf(row.first);
    if (i < 0) return false;
    this._hlStrip = row.sub || '';
    this.clearSearch();
    L.select(i);
    if (L.flyTo) L.flyTo(i);
    return true;
  }

  /** The menu language changed: Your country follows it while it is on (and goes off when the new language has no list). */
  _hlLanguageChanged() {
    this._hlItems = null;
    const L = this._layer, cur = L && L.highlight ? L.highlight() : null;
    if (cur && cur.id === ID_COUNTRY) {
      const cat = L.catalogue ? L.catalogue() : null;
      const it = cat ? this._hlItemList(cat).find((i) => i.id === ID_COUNTRY) : null;
      if (it) L.setHighlight(toHighlight(it)); else L.clearHighlight();
    }
    this._hlRender();
  }

  /** What the highlight menu shows now (tests and the browser probe). */
  hlState() {
    const e = this._els.hl;
    const vis = (n) => !!n && n.style.display !== 'none';
    if (!e) return { view: this._hlView, wrap: false };
    return {
      view: this._hlView, wrap: vis(e.wrap), button: vis(e.btn), buttonText: e.btn.textContent, menu: vis(e.items), head: vis(e.head), headText: e.nameBtn.textContent,
      tag: vis(e.tag) ? e.tag.textContent : '', strip: vis(e.strip) ? e.strip.textContent : '', headTitle: e.head.title || '', list: vis(e.list), more: vis(e.more) ? e.more.textContent : '',
      offShown: vis(e.off), keyFolded: this._els.legend.style.display === 'none',
      items: e.itemEls.map((n) => n.textContent),
      rows: e.rowEls.map((r) => ({ label: r.label, sub: r.sub, state: r.state, dim: r.labelEl.style.opacity === '0.45', title: r.el.title })),
    };
  }

  /** The list's rows know where their objects are: "behind Earth, tap to turn" (a few times a second; never per frame). */
  _hlTick(force) {
    const e = this._els.hl, L = this._layer;
    if (!e || !L || typeof L.rowView !== 'function' || e.rowEls.length === 0 || e.list.style.display === 'none') return;
    const now = this._now();
    if (!force && now - this._hlTickMs < HL_TICK_MS) return;
    this._hlTickMs = now;
    for (const r of e.rowEls) {
      if (r.toggle) continue;
      const i = L.rowOf(r.first);
      const v = i >= 0 ? L.rowView(i) : '';
      let state = v === 'behind' || v === 'off' || v === 'hidden' ? v : '';
      // A row of several objects is tagged only when every one of them is in that state ("1,527 working satellites · behind Earth"
      // read as the whole group; review 11-24). The loop stops at the first object that differs, so a spread group costs a few calls.
      if (state && r.norads && r.norads.length > 1) {
        for (const n of r.norads) {
          const j = L.rowOf(n);
          if (j >= 0 && L.rowView(j) !== state) { state = ''; break; }
        }
      }
      if (state === r.state) continue;
      r.state = state;
      // Sky 34 (owner 2026-11-25: "what is this noise (hidden in the key)"): no state is printed; behind Earth, off screen and hidden in the key all dim the row's name,
      // and on the Mac the hover says which.
      r.labelEl.style.opacity = state ? '0.45' : '';
      const hover = state === 'behind' ? 'behind Earth, click to turn' : state === 'off' ? 'off screen, click to turn' : state === 'hidden' ? 'its kind is hidden in the key' : (r.sub || '');
      r.el.title = this._glass ? '' : hover;
    }
  }

  /** Draw the Highlight menu from the layer's state. `fromParent`: the caller redraws the key and the panel's place itself afterwards. */
  _hlRender(fromParent) {
    const e = this._els.hl;
    if (!e) return;
    const L = this._layer;
    const cat = L && typeof L.catalogue === 'function' ? L.catalogue() : null;
    const items = cat ? this._hlItemList(cat) : [];
    const cur = L && typeof L.highlight === 'function' ? L.highlight() : null;
    const mine = cur ? items.find((i) => i.id === cur.id) || null : null;
    const p1 = this._page1(), glass = this._glass, folded = !!this._info;
    const avail = items.length > 0 && !this._loadFailed;
    let view = this._hlView;
    if (cur && view === 'closed') view = 'list';
    if (!cur && view === 'list') view = 'closed';
    if (!avail && !cur) view = 'closed';
    if (p1 && view === 'menu') view = cur ? 'list' : 'closed';
    this._hlView = view;
    const headOn = view === 'list' && !!cur;
    const showBtn = !p1 && avail && view !== 'list';
    const showItems = !p1 && avail && view === 'menu';
    const showList = headOn && !p1 && !!mine && !folded;
    const set = (n, on, kind = 'block') => { const v = on ? kind : 'none'; if (n.style.display !== v) n.style.display = v; };
    const rowH = `${glass ? HL_ROW_PX_GLASS : HL_ROW_PX}px`;
    set(e.wrap, showBtn || showItems || headOn);
    // the Highlight row
    set(e.btn, showBtn, 'flex');
    e.btn.style.minHeight = rowH;
    e.btn.textContent = '';
    if (showBtn) {
      const a = this._doc.createElement('span'); a.textContent = 'Highlight';
      const b = this._doc.createElement('span'); b.style.cssText = 'color:#8392b3;font-size:10px'; b.textContent = view === 'menu' ? '\u25b4' : '\u25be';
      e.btn.append(a, b);
    }
    e.btn.setAttribute('aria-expanded', view === 'menu' ? 'true' : 'false');
    // the three items
    set(e.items, showItems);
    if (showItems) this._hlDrawItems(e, items, cur, rowH);
    // the header: name, "Off" (the count is in the header's hover)
    set(e.head, headOn, 'flex');
    e.head.style.minHeight = rowH;
    e.off.style.minHeight = glass ? `${HL_ROW_PX_GLASS}px` : '20px';
    e.off.style.minWidth = glass ? '44px' : '36px';
    e.nameBtn.style.minHeight = e.head.style.minHeight;
    if (headOn) {
      const name = mine ? (mine.country ? mine.country.name : mine.title) : String((cur && (cur.label || cur.id)) || '');
      const text = mine && !p1 ? `${name} \u25be` : name;
      if (e.nameBtn.textContent !== text) e.nameBtn.textContent = text;
      e.nameBtn.style.cursor = mine && !p1 ? 'pointer' : 'default';
      // a family says what it is in one plain sentence, then how far the list can be trusted; the other items show the catalogue date and their honesty word.
      // Sky 34 (owner 2026-11-25): the count ("Navigation · 289 of 642 shown"), that sentence and the last tapped row's note are not printed: they are the header's hover (a title).
      const honesty = mine ? (mine.family ? `${mine.tag} ${mine.honesty}` : `${mine.credit} \u00b7 ${mine.honesty}`) : (L && L.highlightHonesty ? L.highlightHonesty() : '');
      const hover = [mine ? this._hlHeaderOf(mine) : '', honesty, this._hlStrip].filter(Boolean).join('\n');
      if (e.head.title !== hover) e.head.title = hover;
    }
    set(e.tag, false);
    // the line under the header is not printed either (Sky 34): the last tapped row's note is in the header's hover, a row's own note in the row's hover
    set(e.strip, false);
    // the list
    set(e.list, showList);
    set(e.more, false);
    if (!headOn && e.listKey) { e.listKey = ''; e.rowEls = []; e.list.textContent = ''; }
    if (showList) this._hlDrawList(e, mine, glass);
    if (headOn !== this._hlHeadOn) { this._hlHeadOn = headOn; this._syncCardGap(); this._syncDisplay(); }
    if (!fromParent) this._renderLegend();
  }

  _hlDrawItems(e, items, cur, rowH) {
    const top = items.filter((i) => i.group !== 'families'), fams = items.filter((i) => i.group === 'families');
    const famOpen = fams.length > 0 && this._hlFamOpen;
    const key = `${items.map((i) => `${i.id}:${i.count}:${i.country ? i.country.name : ''}`).join('|')}|${cur ? cur.id : ''}|${rowH}|${famOpen ? 1 : 0}`;
    if (e.itemsKey === key) return;
    e.itemsKey = key;
    e.items.textContent = '';
    e.itemEls = [];
    e.famRow = null;
    const d = this._doc;
    for (const it of top) {
      const row = d.createElement('div');
      row.id = `real-sky-hl-item-${it.id}`;
      row.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:6px;box-sizing:border-box;padding:3px 8px;margin-top:2px;min-height:${rowH};${HL_BTN_CSS}`;
      // Sky 34 (owner 2026-11-25): the title only, wrapped onto a second line when long; the count and the country are the row's hover.
      row.title = it.country ? `${it.country.name} \u00b7 ${fmtInt(it.count)}` : fmtInt(it.count);
      const a = d.createElement('span'); a.style.cssText = 'min-width:0;white-space:normal;overflow-wrap:anywhere'; a.textContent = `${cur && cur.id === it.id ? '\u2713 ' : ''}${it.title}`;
      row.append(a);
      e.press(row, () => this.hlPick(it.id));
      e.items.append(row);
      e.itemEls.push(row);
    }
    if (fams.length === 0) return;
    // "By job" (the families; owner 11-25 "Choose another name." for "Families"): one row that opens five, indented under it ("Navigation · 289": the count of its working ones)
    const fr = d.createElement('div');
    fr.id = 'real-sky-hl-families';
    fr.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:6px;box-sizing:border-box;padding:0 8px;margin-top:2px;min-height:${rowH};${HL_BTN_CSS}`;
    const fa = d.createElement('span'); fa.textContent = 'By job';
    const fb = d.createElement('span'); fb.style.cssText = 'color:#8392b3;font-size:10px'; fb.textContent = famOpen ? '\u25b4' : '\u25be';
    fr.append(fa, fb);
    fr.setAttribute('aria-expanded', famOpen ? 'true' : 'false');
    e.press(fr, () => this._hlToggleFamilies());
    e.items.append(fr);
    e.itemEls.push(fr);
    e.famRow = fr;
    if (!famOpen) return;
    for (const it of fams) {
      const row = d.createElement('div');
      row.id = `real-sky-hl-item-${it.id}`;
      row.style.cssText = `display:flex;align-items:center;gap:6px;box-sizing:border-box;padding:3px 8px;margin:2px 0 0 14px;min-height:${rowH};${HL_BTN_CSS}`;
      if (!it.noCount) row.title = fmtInt(it.count);
      const a = d.createElement('span'); a.style.cssText = 'min-width:0;white-space:normal;overflow-wrap:anywhere';
      a.textContent = `${cur && cur.id === it.id ? '\u2713 ' : ''}${it.title}`;
      row.append(a);
      e.press(row, () => this.hlPick(it.id));
      e.items.append(row);
      e.itemEls.push(row);
    }
  }

  _hlDrawList(e, item, glass) {
    const visible = glass ? HL_LIST_ROWS_GLASS : HL_LIST_ROWS;
    const rowPx = glass ? HL_LIST_ROW_PX_GLASS : HL_LIST_ROW_PX;
    const key = `${item.id}|${glass ? 1 : 0}|${item.rows.map((r) => `${r.key}${r.on ? '+' : ''}${r.short || r.label}`).join(',')}`;
    e.list.style.maxHeight = `${visible * rowPx}px`;
    if (e.listKey !== key) {
      e.listKey = key;
      e.list.textContent = '';
      e.rowEls = [];
      const d = this._doc;
      for (const row of item.rows) {
        // Sky 34 (owner 2026-11-25): a row is its name and nothing else, on both screens: the short name when the data has one ("ISS"); a row that is behind Earth, off screen or hidden
        // in the key is dimmed (`_hlTick`); the grey note under a row is gone (the Mac shows it as the row's hover; on touch the card shows the story when the row is tapped).
        const el = d.createElement('div');
        el.style.cssText = `display:flex;align-items:center;box-sizing:border-box;min-height:${rowPx}px;padding:0 6px;border-radius:3px;cursor:pointer;touch-action:manipulation;line-height:18px;`;
        el.title = glass ? '' : (row.sub || '');
        const labelText = row.short || row.label;
        const label = d.createElement('span'); label.style.cssText = 'flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere;color:#e8eefc'; label.textContent = labelText;
        el.append(label);
        e.press(el, () => this.hlTapRow(row));
        e.list.append(el);
        e.rowEls.push({ el, labelEl: label, label: labelText, sub: row.sub || '', first: row.first, norads: row.norads || null, toggle: row.toggle || null, state: '' });
      }
    this._hlTickMs = -Infinity;
    this._hlHeadOn = false;                         // the Highlight header shows (an item is on): page 1 then shows the panel with no card
    }
    const more = item.rows.length - visible;
    if (more > 0) { e.more.textContent = `+${more} more`; e.more.style.display = 'block'; }
    this._hlTick(true);
  }

  _render() {
    const e = this._els;
    if (!e.root) return;
    this._hlRender(true);
    this._renderLegend();
    this._renderCredit();
    const i = this._info;
    e.card.style.display = i ? 'block' : 'none';
    if (!i) { this._syncDodge(); return; }
    e.dot.style.background = CLASS_COLORS[i.cls] || CLASS_COLORS[5];
    e.nameEl.textContent = i.name;
    // Sky 34 (owner 2026-11-25): the card prints the story, then the values only, one per line (kind, height, mass, "launched <year>"), no label column; the rest is the name's hover.
    if (e.titleEl) e.titleEl.title = [`number ${i.norad}`, `tilt ${i.tilt}`, `size ${i.size}`, i.sizeNote, i.asOf].filter(Boolean).join('\n');
    const rows = [
      i.story ? [null, i.story, true] : null,          // a Famous object's line (HighlightItems.famousStory), full width, quiet
      i.kind, i.height, i.mass || null,
      i.launched ? `launched ${i.launched}` : null,
    ].filter(Boolean);
    e.body.textContent = '';
    for (const r of rows) {
      const line = this._doc.createElement('div');
      if (Array.isArray(r)) {                          // the story
        const [, v, quiet] = r;
        line.style.cssText = quiet ? 'margin-top:1px;margin-bottom:3px;color:#c9d6ef;font-size:10px;line-height:1.3' : 'margin-top:2px;color:#ffb06b;font-size:10px';
        line.textContent = v;
      } else {
        line.style.cssText = 'overflow-wrap:anywhere';
        line.textContent = r;
      }
      e.body.append(line);
    }
    this._syncDodge();                              // a card opened or closed: the panel's bottom moved
  }
}
