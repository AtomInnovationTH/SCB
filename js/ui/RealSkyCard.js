/**
 * RealSkyCard.js — the DOM panel of the real sky on floors 4-5 (plan sky-1116, lane L-sky): a search field (name or number), the card
 * of the tapped object (name, number, kind, size, mass, launch year, height, tilt, "orbit as of <snapshot date>"), a one-row colour key
 * and one small credit line (a tap opens the full wording). By default only the field, the key and the credit show; the card opens on a
 * tapped dot or a search hit and never repeats the key or the credit (owner 2026-11-17, DECISIONS §74 row 3). Styles are inline in this module. DOM-guarded: with no document it is inert (headless tests use
 * `cardFields`, which is pure).
 *
 * The panel itself takes pointer events (so the input and the close button work); everything around it stays click-through. Keys typed
 * in the field never reach the game (InputManager ignores keys typed into an INPUT, and the field also stops them here).
 *
 * @module ui/RealSkyCard
 */

import { buildItems, toHighlight, isMenuId, ID_COUNTRY } from './HighlightItems.js';

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
/** The one-row colour key's short words (same order as CLASS_NAMES; the full name is each item's tooltip). */
export const LEGEND_LABELS = ['debris', 'stage', 'dead', 'working', 'sat', 'unknown', 'Starlink'];

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
/** Class number -> the kind line on the card. A satellite says which: working, dead, or "status not known". */
const KIND_TEXT = ['debris', 'rocket stage', 'dead satellite (not working)', 'working satellite',
  'satellite (working or dead not known)', 'unknown object'];
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
    height: `${fmtInt(heights.perKm)} to ${fmtInt(heights.apoKm)} km`,
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
 * Where the panel sits (plan sky-1116-lsky-card, owner 2026-11-17: "move it clear of Earth"). Measured (tmp/sky-card-probe.mjs):
 * with the ISS card open (272 x 342 px) at top:176px the iPad (1366 x 1024, touch) card sat 0 to 18 px over Earth's right edge on
 * floor 4 (Earth r 393-417 px, widest point at the screen's middle height, x 1076-1100 vs the card's left edge 1082) and 11 px over the
 * HUD's right-hand status strip (bottom y 187). No top offset clears it: the card is taller than the gap above Earth's widest point.
 * On touch, floor 4, the panel therefore sits in the bottom-right corner (card top y 670; Earth's edge at that height x 1069),
 * growing upward. (Until Sky 20, on floor 5 the top-right stayed: Earth's disc there ends at x 917 (card left 1082), and the bottom-right held the
 * Kessler timeline (a bottom-right card covered it in the probe's screenshot).) The Mac (1728 x 1117, mouse) has 151 px between Earth's
 * edge and the card on floor 4, so its placement stays as it was.
 * Sky 20 (owner 2026-11-23: the object card "in same position as Floor 4 top"): floor 5's page 1 takes floor 4's place on both screens,
 * and the Kessler timeline moved to the bottom, clear of the iPad's bottom-right corner (see SdaChart `STRIP_*`).
 * @param {boolean} glass touch device
 * @param {number|null} [floor] 4 or 5
 * @returns {{top:string, bottom:string, maxHeight:string}} CSS values
 */
export function panelPlacement(glass, floor) {
  // Sky 23 (Highlight menu, plan sky-1124-highlight): the iPad panel is at most 342 px high (the ISS card's size, the tallest state before the menu), so its top
  // edge stays at y 670 or lower on a 1024 px screen and clears Earth's rim (13 px at that height); anything taller scrolls inside the panel.
  if (glass && (floor === FLOOR_GLOBE || floor === FLOOR_CHART)) return { top: 'auto', bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))', maxHeight: `min(${PANEL_MAX_PX_GLASS}px, calc(100vh - 260px))` };
  // Mac floor 4 (lane sky-skylook-1119, owner 2026-11-19: "move the right panel to top right to improve visibility of the object cloud"):
  // the panel's top edge is 12 px from the top. The radio box and the right column (Targets, Target info, NEXT when `+` brings it back; NEXT is gone on floor 4 by default since DECISIONS §78 row 11) that sat there move out of its way (see `SKY_PANEL_TOP_ATTR`).
  // Floor 5 = page 1 of the page row (Sky 19, owner 2026-11-22: "a cleaner layout, remove irrelevant panes"; Sky 20: the card only, see `_place`):
  // with a mouse it keeps the floor-4 place.
  if (!glass && (floor === FLOOR_GLOBE || floor === FLOOR_CHART)) return { top: 'calc(12px + env(safe-area-inset-top, 0px))', bottom: 'auto', maxHeight: 'calc(100vh - 260px)' };
  return { top: '176px', bottom: 'auto', maxHeight: 'calc(100vh - 260px)' };
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
/** Touch floor 4: the panel's height + gap (px) while it shows in the bottom-right corner; the speed control's bottom edge adds it. */
export const SKY_PANEL_LIFT_VAR = '--sky-panel-lift';
export const SKY_PANEL_TOP_CSS = `html[${SKY_PANEL_TOP_ATTR}] #hud-comms-panel, html[${SKY_PANEL_TOP_ATTR}] #hud-right-column { translate: 0 var(${SKY_PANEL_DY_VAR}, 0px); }`;
/** Gap between the panel's bottom edge and the radio box / right column under it, px. */
export const SKY_PANEL_GAP_PX = 12;
/**
 * Touch page 1 with no card open: the speed control stands where it does on the globe, above the globe's always-shown panel (iPad: panel 208 px
 * high with no card + SKY_PANEL_GAP_PX, measured 2026-11-23 by tmp/sky20-pages/p1.mjs: control y 722-792 of 1024). The lift var holds this until a
 * card opens, then the card's own height + gap.
 */
export const SKY_PANEL_GLOBE_LIFT_PX = 220;
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
  'position:fixed', 'right:12px', 'overflow:auto', 'width:272px', 'z-index:36', 'display:none', 'pointer-events:auto',
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
   */
  constructor(deps = {}) {
    this._doc = deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null);
    this._isGlass = deps.isGlass || null;           // optional; the layer also calls setLayout() every frame
    this._getFlag = typeof deps.getFlag === 'function' ? deps.getFlag : null;
    this._now = typeof deps.now === 'function' ? deps.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._layer = null;                             // the RealSkyLayer, through attachLayer (the Highlight menu calls it)
    this._hlView = 'closed';                        // the Highlight menu: 'closed' (one row) | 'menu' (the three items) | 'list' (an item is on)
    this._hlExtras = { stages: false, debris: false };   // Your country: "+ stages" / "+ debris" lit too
    this._hlItems = null;                           // the built items (cache) and what they were built from
    this._hlItemsKey = null;
    this._hlStrip = '';                             // the line under the header: the last tapped row's note
    this._hlHover = '';                             // the note of the row under the pointer (Mac): shown on that line while it is there
    this._hlTickMs = -Infinity;
    this._offLanguage = null;
    this._offHl = null;
    if (typeof deps.onLanguage === 'function') this._offLanguage = deps.onLanguage(() => this._hlLanguageChanged());
    this._glass = false;
    this._floor = null;
    this._onSearch = null;
    this._onClose = null;
    this._onToggleKind = null;
    this._isKindHidden = null;
    this._onFlyName = null;
    this._shown = false;
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

  /** The layer wires these: onSearch(query) => row index or -1; onClose() => void; onToggleKind(name) flips a legend box; isKindHidden(name) => bool (the boxes read it); onFlyName() turns floor 4's globe to the open object. */
  setHandlers({ onSearch, onClose, onToggleKind, isKindHidden, onFlyName } = {}) {
    this._onSearch = onSearch || null;
    this._onClose = onClose || null;
    this._onToggleKind = onToggleKind || null;
    this._isKindHidden = isKindHidden || null;
    this._onFlyName = onFlyName || null;
  }

  /** The legend's boxes again (the layer changed a kind). */
  refreshKinds() { this._renderLegend(); }

  /** Legend state for tests and the browser probe: kind name -> true when its box is ticked (shown). Entries the legend does not show are left out. */
  legendState() {
    const out = {};
    const e = this._els;
    if (e.legendItems) CLASS_NAMES.forEach((n, i) => { if (e.legendItems[i].style.display !== 'none') out[n] = !(this._isKindHidden && this._isKindHidden(n)); });
    return out;
  }

  isShown() { return this._shown; }
  info() { return this._info; }
  get root() { return this._els.root || null; }
  /** The legend entries that show now (class names), for tests and the browser probe. */
  legendNames() {
    const e = this._els;
    return e.legendItems ? CLASS_NAMES.filter((n, i) => e.legendItems[i].style.display !== 'none') : [];
  }
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
    input.placeholder = 'Search name or number';
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

    // The colour key is also the show/hide switch (owner 2026-11-18, DECISIONS §75 row 4): one tick box per kind; the whole entry
    // (box + swatch + word) toggles. A 3-column grid: 44 px tall chips on glass, 22 px with a mouse (_renderLegend sets the height).
    const legend = el('div', 'margin-top:7px;display:grid;grid-template-columns:repeat(3,1fr);gap:2px 4px;font-size:10px;letter-spacing:0;color:#aebbd6');
    legend.id = 'real-sky-key';
    const legendItems = [];
    CLASS_NAMES.forEach((n, i) => {
      const item = el('div', 'display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer;box-sizing:border-box;min-height:22px;padding:0 3px;border-radius:4px;touch-action:manipulation');
      item.title = `${n} (tap to show or hide)`;
      item.setAttribute('role', 'checkbox');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', n);
      const box = el('span', 'flex:none;display:inline-block;width:12px;height:12px;box-sizing:border-box;border:1px solid #9fb0d0;border-radius:2px;line-height:10px;text-align:center;font-size:10px;color:#e8eefc');
      const sw = el('span', `flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:${CLASS_COLORS[i]}`);
      const word = el('span', null, LEGEND_LABELS[i]);
      item.append(box, sw, word);
      const toggle = () => { if (this._onToggleKind) this._onToggleKind(n); this._renderLegend(); };
      // A click (mouse or finger) must not leave keyboard focus on the chip, or Space (floor 4's approach command) would go to it
      // instead of the game. A chip reached by Tab toggles with Enter only; Space is never handled here, so it always reaches InputManager.
      item.addEventListener('click', () => { toggle(); if (typeof item.blur === 'function') item.blur(); });
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggle(); } });
      legend.append(item);
      legendItems.push(item);
    });
    // One small credit line naming every source; a tap opens the full wording, a second tap closes it (owner 2026-11-17, DECISIONS §74 row 3).
    const credit = el('div', 'margin-top:2px;padding:4px 0 0;font-size:10px;line-height:1.3;color:#8392b3;cursor:pointer');
    credit.id = 'real-sky-credit';
    credit.setAttribute('role', 'button');
    credit.setAttribute('tabindex', '0');
    credit.setAttribute('aria-expanded', 'false');
    credit.title = 'Tap for the full credit';
    credit.addEventListener('click', () => this.toggleCredit());
    credit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.toggleCredit(); } });
    const fail = el('div', 'display:none;margin-top:7px;color:#ffb06b', 'The sky data could not be loaded.');
    fail.id = 'real-sky-load-failed';
    const hl = this._hlBuildDom(el);

    root.append(input, msg, fail, hl.wrap, card, legend, credit);
    d.body.appendChild(root);
    // A size change the render calls do not see (the full credit wording opened, a late font) moves the panel's bottom too.
    if (typeof ResizeObserver !== 'undefined') { try { this._ro = new ResizeObserver(() => this._syncDodge()); this._ro.observe(root); } catch (_) { this._ro = null; } }
    Object.assign(this._els, { root, input, msg, card, nameEl, dot, body, credit, legend, legendItems, fail, hl });
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
    if (g === this._glass && f === this._floor && this._placed) return;
    this._glass = g;
    this._floor = f;
    this._place();
    this._renderLegend();                           // the chips are taller on glass
  }

  /** Applies panelPlacement(glass, floor) to the panel (no-op before the panel is built). */
  _place() {
    const root = this._els.root;
    if (!root) return;
    const p = panelPlacement(this._glass, this._floor);
    root.style.top = p.top;
    root.style.bottom = p.bottom;
    root.style.maxHeight = p.maxHeight;
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
    const want = this._shown && (!this._page1() || !!this._info || !!this._hlHeadOn);
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
    const o = this._box;
    if ((!o && !b) || (o && b && o.x0 === b.x0 && o.y0 === b.y0 && o.x1 === b.x1 && o.y1 === b.y1)) return;
    this._box = b;
    if (this._layer && typeof this._layer.setKeepOut === 'function') this._layer.setKeepOut(b);   // the highlight's name boxes keep clear of the panel
  }

  /**
   * The room the panel takes at the bottom right, for the map speed control (lane sky-floor4-1119, DECISIONS §78 row 12): on touch, floors 4
   * and 5's page 1, the panel sits in the bottom-right corner and grows upward, so the speed control stands just above it. `--sky-panel-lift`
   * on <html> is the panel's height + SKY_PANEL_GAP_PX while it shows there, else removed (page 1 with no card open: the globe's no-card lift
   * SKY_PANEL_GLOBE_LIFT_PX, so the control stays in the globe's spot; a card opened there lifts it by the card's height); MapClockSlider's bottom edge adds it (CSS only, so the control moves with the panel when a tapped dot's card opens, with no
   * per-frame work). Same write-on-change and same rect-read moments as the dodge.
   * @private
   */
  _syncLift(de, root) {
    const on = !!root && this._shown && this._glass && (this._floor === FLOOR_GLOBE || this._floor === FLOOR_CHART);
    if (!on) {
      if (this._liftPx !== undefined) { de.style.removeProperty(SKY_PANEL_LIFT_VAR); this._liftPx = undefined; }
      return;
    }
    let lift = SKY_PANEL_GLOBE_LIFT_PX;   // page 1 with no card: the globe's spot
    if (this._floor === FLOOR_GLOBE || this._info || this._hlHeadOn) {
      const r = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
      lift = Math.round((r && r.height) || 0) + SKY_PANEL_GAP_PX;
    }
    if (lift !== this._liftPx) { de.style.setProperty(SKY_PANEL_LIFT_VAR, `${lift}px`); this._liftPx = lift; }
  }

  /**
   * Mouse + floor 4 or 5 + showing: put the radio box and the right column (Targets / Target info panes, NEXT when shown) under the panel (attribute + the panel's
   * bottom + SKY_PANEL_GAP_PX as a CSS variable on <html>); in every other state take it all back. Floor 5 (D7, review of 2026-11-19):
   * the panel stays at top 176 px, right 12 px, 272 px wide, over `#hud-right-column` (right 0, 350 px), and `+` after a scan shows the
   * panes there as on floor 4 (no floor test in the `+` walk: PaneDensity, HUD `_densityIsAvailable`; the `+` / `-` KEYS are locked on floor 5 since Sky 20, the slider is not), so the same dodge applies. Writes
   * only on change; reads the panel's rect only here (a show, a re-render, a size change), never per frame.
   */
  _syncDodge() {
    const d = this._doc, de = d && d.documentElement;
    if (!de || !de.style || typeof de.setAttribute !== 'function') return;
    const root = this._els.root;
    this._syncDisplay();
    this._measure();
    this._syncLift(de, root);
    // Page 1 shows the panel only with a card open: with none there is nothing to dodge.
    const on = !!root && this._shown && !this._glass && (this._floor === FLOOR_GLOBE || (this._floor === FLOOR_CHART && (!!this._info || !!this._hlHeadOn)));
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
    const r = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    const dy = Math.round((r && r.bottom) || 0) + SKY_PANEL_GAP_PX;
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
    CLASS_NAMES.forEach((n, i) => {
      const hide = (i === CLS_DEAD || i === CLS_WORKING || i === CLS_STARLINK) && !this._statusJoined;   // Starlink is a working satellite: no status, no Starlink
      const item = e.legendItems[i];
      item.style.display = hide ? 'none' : 'flex';
      item.style.minHeight = this._glass ? '44px' : '22px';
      const off = !!(this._isKindHidden && this._isKindHidden(n));
      item.style.opacity = off ? '0.45' : '1';
      item.setAttribute('aria-checked', off ? 'false' : 'true');
      item.children[0].textContent = off ? '' : '\u2713';
    });
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
    const head = mk('real-sky-hl-head', 'display:none;align-items:center;gap:6px');
    const nameBtn = mk('real-sky-hl-name', 'flex:1;min-width:0;display:flex;align-items:center;box-sizing:border-box;font-size:12px;line-height:15px;font-weight:bold;color:#e8eefc;cursor:pointer;touch-action:manipulation;overflow:hidden;white-space:normal;overflow-wrap:anywhere');
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
    return { wrap, btn, items, head, nameBtn, off, tag, strip, list, more, itemEls: [], rowEls: [], listKey: '', itemsKey: '', press };
  }

  /** The built items for the layer's data and the menu language (cached; rebuilt when the data, the language or the country extras change). */
  _hlItemList(cat) {
    const L = this._layer, hl = L && typeof L.highlights === 'function' ? L.highlights() : null;
    const flag = this._getFlag ? this._getFlag() : null;
    const key = `${flag}|${this._hlExtras.stages ? 1 : 0}${this._hlExtras.debris ? 1 : 0}`;
    if (!this._hlItems || this._hlItemsKey !== key || this._hlItemsCat !== cat || this._hlItemsHl !== hl) {
      this._hlItems = buildItems(cat, hl, flag, this._hlExtras);
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
    if (!h) { this._hlView = 'closed'; this._hlStrip = ''; this._hlExtras = { stages: false, debris: false }; }
    else if (this._hlView === 'closed') this._hlView = 'list';
    this._hlRender();
    this._hlTick(true);
  }

  /** The Highlight row (closed, or an item is on and the menu is asked for) opens or closes the three items. */
  _hlToggleMenu() {
    const cur = this._layer && this._layer.highlight ? this._layer.highlight() : null;
    this._hlView = this._hlView === 'menu' ? (cur ? 'list' : 'closed') : 'menu';
    this._hlRender();
  }

  /** Turn an item on (replacing the one that is on). @param {string} id @returns {boolean} */
  hlPick(id) {
    const L = this._layer;
    const cat = L && L.catalogue ? L.catalogue() : null;
    if (!cat) return false;
    const cur = L.highlight ? L.highlight() : null;
    if (cur && cur.id === id) { this._hlView = 'list'; this._hlRender(); return true; }
    if (id !== ID_COUNTRY || !cur || cur.id !== ID_COUNTRY) this._hlExtras = { stages: false, debris: false };
    const it = this._hlItemList(cat).find((i) => i.id === id);
    if (!it) return false;
    this._hlView = 'list';
    this._hlStrip = '';
    L.setHighlight(toHighlight(it));
    this._hlRender();
    return true;
  }

  /** The "Off" button: the normal sky is back. */
  _hlOff() { if (this._layer && this._layer.clearHighlight) this._layer.clearHighlight(); }

  /** A list row: Your country's "+ stages" / "+ debris" rows add that kind; any other turns the globe to the object (the first of a group) and opens its card. */
  hlTapRow(row) {
    const L = this._layer;
    if (!L || !row) return false;
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
      tag: vis(e.tag) ? e.tag.textContent : '', strip: vis(e.strip) ? e.strip.textContent : '', list: vis(e.list), more: vis(e.more) ? e.more.textContent : '',
      offShown: vis(e.off), keyFolded: this._els.legend.style.display === 'none',
      items: e.itemEls.map((n) => n.textContent),
      rows: e.rowEls.map((r) => ({ label: r.label, sub: r.sub, state: r.state, tag: r.tagEl.textContent })),
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
      const text = state === 'behind' ? (this._glass ? 'behind Earth, tap to turn' : 'behind Earth')
        : state === 'off' ? (this._glass ? 'off screen, tap to turn' : 'off screen') : state === 'hidden' ? '(hidden in the key)' : '';
      r.tagEl.textContent = text;
      r.el.title = state === 'behind' ? 'behind Earth, tap to turn' : state === 'off' ? 'off screen, tap to turn' : state === 'hidden' ? 'its kind is hidden in the key' : (r.sub || '');
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
    // the header: name, count, "Off"
    set(e.head, headOn, 'flex');
    e.head.style.minHeight = rowH;
    e.off.style.minHeight = glass ? `${HL_ROW_PX_GLASS}px` : '20px';
    e.off.style.minWidth = glass ? '64px' : '36px';
    e.nameBtn.style.minHeight = e.head.style.minHeight;
    if (headOn) {
      const name = mine ? mine.header : String((cur && (cur.label || cur.id)) || '');
      const text = mine && !p1 ? `${name} \u25be` : name;
      if (e.nameBtn.textContent !== text) e.nameBtn.textContent = text;
      e.nameBtn.style.cursor = mine && !p1 ? 'pointer' : 'default';
      const honesty = mine ? `${mine.credit} \u00b7 ${mine.honesty}` : (L && L.highlightHonesty ? L.highlightHonesty() : '');
      e.tag.textContent = honesty;
    }
    set(e.tag, headOn && !!e.tag.textContent);
    // the line under the header: the last tapped row's note (touch rows carry their own note, so it shows only when the list is folded)
    const stripOn = headOn && !p1 && !!mine && (folded || !glass);   // on the Mac its place is always kept: a line that came and went would move the rows under the pointer
    e.strip.textContent = stripOn ? (this._hlHover || this._hlStrip) : '';
    set(e.strip, stripOn);
    // the list
    set(e.list, showList);
    set(e.more, false);
    if (!showList) this._hlHover = '';
    if (!headOn && e.listKey) { e.listKey = ''; e.rowEls = []; e.list.textContent = ''; }
    if (showList) this._hlDrawList(e, mine, glass);
    if (headOn !== this._hlHeadOn) { this._hlHeadOn = headOn; this._syncCardGap(); this._syncDisplay(); }
    if (!fromParent) this._renderLegend();
  }

  _hlDrawItems(e, items, cur, rowH) {
    const key = `${items.map((i) => `${i.id}:${i.count}:${i.country ? i.country.name : ''}`).join('|')}|${cur ? cur.id : ''}|${rowH}`;
    if (e.itemsKey === key) return;
    e.itemsKey = key;
    e.items.textContent = '';
    e.itemEls = [];
    const d = this._doc;
    for (const it of items) {
      const row = d.createElement('div');
      row.id = `real-sky-hl-item-${it.id}`;
      row.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:6px;box-sizing:border-box;padding:0 8px;margin-top:2px;min-height:${rowH};${HL_BTN_CSS}`;
      const a = d.createElement('span'); a.textContent = `${cur && cur.id === it.id ? '\u2713 ' : ''}${it.title}`;
      const b = d.createElement('span'); b.style.cssText = 'color:#8392b3;font-size:10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis'; b.textContent = it.country ? it.country.name : String(it.count);
      row.append(a, b);
      e.press(row, () => this.hlPick(it.id));
      e.items.append(row);
      e.itemEls.push(row);
    }
  }

  _hlDrawList(e, item, glass) {
    const visible = glass ? HL_LIST_ROWS_GLASS : HL_LIST_ROWS;
    const rowPx = glass ? HL_LIST_ROW_PX_GLASS : HL_LIST_ROW_PX;
    const key = `${item.id}|${glass ? 1 : 0}|${item.rows.map((r) => `${r.key}${r.on ? '+' : ''}${r.label}`).join(',')}`;
    e.list.style.maxHeight = `${visible * rowPx}px`;
    if (e.listKey !== key) {
      e.listKey = key;
      e.list.textContent = '';
      e.rowEls = [];
      const d = this._doc;
      for (const row of item.rows) {
        const el = d.createElement('div');
        el.style.cssText = `display:flex;flex-direction:${glass ? 'column' : 'row'};${glass ? 'justify-content:center;' : 'align-items:center;'}box-sizing:border-box;min-height:${rowPx}px;padding:0 6px;border-radius:3px;cursor:pointer;touch-action:manipulation;${glass ? '' : 'line-height:18px;'}`;
        el.title = row.sub || '';
        const top = d.createElement('div');
        top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;width:100%';
        const label = d.createElement('span'); label.style.cssText = 'flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#e8eefc'; label.textContent = row.label;
        const tagEl = d.createElement('span'); tagEl.style.cssText = 'flex:none;font-size:9px;color:#ffb06b';
        top.append(label);
        el.append(top);
        if (glass) {
          // touch: the "behind Earth, tap to turn" tag stands above the note (beside the name it squeezed the name down to "1527 work...")
          tagEl.style.display = 'block';   // its own line, so the note's name is never cut to "biggest: IS..." (empty: no height)
          const sub = d.createElement('div'); sub.style.cssText = 'font-size:10px;line-height:12px;max-height:24px;color:#8392b3;overflow:hidden;white-space:normal;width:100%';   // two lines at most: the tag and the note
          const note = d.createElement('span'); note.textContent = row.sub || '';
          sub.append(tagEl, note);
          el.append(sub);
        } else top.append(tagEl);
        e.press(el, () => this.hlTapRow(row));
        if (!glass) {
          // the line under the header takes the hovered row's note; its place is always kept (it never shows or hides on a hover: the rows below would move under the pointer)
          el.addEventListener('mouseenter', () => { this._hlHover = row.sub || ''; if (this._hlHover) e.strip.textContent = this._hlHover; });
          el.addEventListener('mouseleave', () => { this._hlHover = ''; e.strip.textContent = this._hlStrip; });
        }
        e.list.append(el);
        e.rowEls.push({ el, tagEl, label: row.label, sub: row.sub || '', first: row.first, norads: row.norads || null, toggle: row.toggle || null, state: '' });
      }
    this._hlTickMs = -Infinity;
    this._hlHeadOn = false;                         // the Highlight header shows (an item is on): page 1 then shows the panel with no card
    }
    const more = item.rows.length - visible;
    if (more > 0) { e.more.textContent = `+ ${more} more below`; e.more.style.display = 'block'; }
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
    const rows = [
      ['number', i.norad], ['kind', i.kind], i.sizeNote ? [null, i.sizeNote] : null, ['size', i.size], i.mass ? ['mass', i.mass] : null,
      i.launched ? ['launched', i.launched] : null, ['height', i.height], ['tilt', i.tilt],
    ].filter(Boolean);
    e.body.textContent = '';
    for (const [k, v] of rows) {
      const line = this._doc.createElement('div');
      if (k === null) {                                // a note line (whose size and mass these are), full width
        line.style.cssText = 'margin-top:2px;color:#ffb06b;font-size:10px';
        line.textContent = v;
        e.body.append(line);
        continue;
      }
      line.style.cssText = 'display:flex;gap:8px';
      const a = this._doc.createElement('span'); a.style.cssText = 'flex:0 0 62px;color:#8392b3'; a.textContent = k;
      const b = this._doc.createElement('span'); b.style.cssText = 'flex:1'; b.textContent = v;
      line.append(a, b);
      e.body.append(line);
    }
    const asOf = this._doc.createElement('div');
    asOf.style.cssText = 'margin-top:3px;color:#8392b3';
    asOf.textContent = i.asOf;
    e.body.append(asOf);
    this._syncDodge();                              // a card opened or closed: the panel's bottom moved
  }
}
