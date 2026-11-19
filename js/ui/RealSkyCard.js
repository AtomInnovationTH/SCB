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

/**
 * Where the panel sits (plan sky-1116-lsky-card, owner 2026-11-17: "move it clear of Earth"). Measured (tmp/sky-card-probe.mjs):
 * with the ISS card open (272 x 342 px) at top:176px the iPad (1366 x 1024, touch) card sat 0 to 18 px over Earth's right edge on
 * floor 4 (Earth r 393-417 px, widest point at the screen's middle height, x 1076-1100 vs the card's left edge 1082) and 11 px over the
 * HUD's right-hand status strip (bottom y 187). No top offset clears it: the card is taller than the gap above Earth's widest point.
 * On touch, floor 4, the panel therefore sits in the bottom-right corner (card top y 670; Earth's edge at that height x 1069),
 * growing upward. On floor 5 the top-right stays: Earth's disc there ends at x 917 (card left 1082), and the bottom-right holds the
 * Kessler timeline (a bottom-right card covered it in the probe's screenshot). The Mac (1728 x 1117, mouse) has 151 px between Earth's
 * edge and the card on floor 4, so its placement stays as it was.
 * @param {boolean} glass touch device
 * @param {number|null} [floor] 4 or 5
 * @returns {{top:string, bottom:string, maxHeight:string}} CSS values
 */
export function panelPlacement(glass, floor) {
  if (glass && floor === FLOOR_GLOBE) return { top: 'auto', bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))', maxHeight: 'calc(100vh - 260px)' };
  // Mac floor 4 (lane sky-skylook-1119, owner 2026-11-19: "move the right panel to top right to improve visibility of the object cloud"):
  // the panel's top edge is 12 px from the top. The radio box and the right column (Targets, Target info, NEXT when `+` brings it back; NEXT is gone on floor 4 by default since DECISIONS §78 row 11) that sat there move out of its way (see `SKY_PANEL_TOP_ATTR`).
  if (!glass && floor === FLOOR_GLOBE) return { top: 'calc(12px + env(safe-area-inset-top, 0px))', bottom: 'auto', maxHeight: 'calc(100vh - 260px)' };
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
   */
  constructor(deps = {}) {
    this._doc = deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null);
    this._isGlass = deps.isGlass || null;           // optional; the layer also calls setLayout() every frame
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

    root.append(input, msg, fail, card, legend, credit);
    d.body.appendChild(root);
    // A size change the render calls do not see (the full credit wording opened, a late font) moves the panel's bottom too.
    if (typeof ResizeObserver !== 'undefined') { try { this._ro = new ResizeObserver(() => this._syncDodge()); this._ro.observe(root); } catch (_) { this._ro = null; } }
    Object.assign(this._els, { root, input, msg, card, nameEl, dot, body, credit, legend, legendItems, fail });
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
    this._placed = true;
    this._syncDodge();
  }

  /**
   * The room the panel takes at the bottom right, for the map speed control (lane sky-floor4-1119, DECISIONS §78 row 12): on touch, floor 4,
   * the panel sits in the bottom-right corner and grows upward, so the speed control stands just above it. `--sky-panel-lift` on <html> is the
   * panel's height + SKY_PANEL_GAP_PX while it shows there, else removed; MapClockSlider's bottom edge adds it (CSS only, so the control moves
   * with the panel when a tapped dot's card opens, with no per-frame work). Same write-on-change and same rect-read moments as the dodge.
   * @private
   */
  _syncLift(de, root) {
    const on = !!root && this._shown && this._glass && this._floor === FLOOR_GLOBE;
    if (!on) {
      if (this._liftPx !== undefined) { de.style.removeProperty(SKY_PANEL_LIFT_VAR); this._liftPx = undefined; }
      return;
    }
    const r = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    const lift = Math.round((r && r.height) || 0) + SKY_PANEL_GAP_PX;
    if (lift !== this._liftPx) { de.style.setProperty(SKY_PANEL_LIFT_VAR, `${lift}px`); this._liftPx = lift; }
  }

  /**
   * Mouse + floor 4 or 5 + showing: put the radio box and the right column (Targets / Target info panes, NEXT when shown) under the panel (attribute + the panel's
   * bottom + SKY_PANEL_GAP_PX as a CSS variable on <html>); in every other state take it all back. Floor 5 (D7, review of 2026-11-19):
   * the panel stays at top 176 px, right 12 px, 272 px wide, over `#hud-right-column` (right 0, 350 px), and `+` after a scan shows the
   * panes there as on floor 4 (no floor test in the `+` walk: PaneDensity, HUD `_densityIsAvailable`), so the same dodge applies. Writes
   * only on change; reads the panel's rect only here (a show, a re-render, a size change), never per frame.
   */
  _syncDodge() {
    const d = this._doc, de = d && d.documentElement;
    if (!de || !de.style || typeof de.setAttribute !== 'function') return;
    const root = this._els.root;
    this._syncLift(de, root);
    const on = !!root && this._shown && !this._glass && (this._floor === FLOOR_GLOBE || this._floor === FLOOR_CHART);
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
    e.fail.style.display = this._loadFailed ? 'block' : 'none';
    e.legend.style.display = this._loadFailed ? 'none' : 'grid';
    e.credit.style.display = this._loadFailed ? 'none' : 'block';
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
    if (this._els.root) this._els.root.style.display = 'block';
    this._place();
  }

  hide() {
    this._shown = false;
    if (this._els.root) this._els.root.style.display = 'none';
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

  _render() {
    const e = this._els;
    if (!e.root) return;
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
