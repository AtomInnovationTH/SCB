/**
 * RealSkyCard.js — the DOM panel of the real sky on floors 4-5 (plan sky-1116, lane L-sky): a search field (name or number), the card
 * of the tapped object (name, number, kind, size, mass, launch year, height, tilt, "orbit as of <snapshot date>"), the legend of the 6
 * colours and the credit line. Styles are inline in this module. DOM-guarded: with no document it is inert (headless tests use
 * `cardFields`, which is pure).
 *
 * The panel itself takes pointer events (so the input and the close button work); everything around it stays click-through. Keys typed
 * in the field never reach the game (InputManager ignores keys typed into an INPUT, and the field also stops them here).
 *
 * @module ui/RealSkyCard
 */

export const CLASS_NAMES = ['debris', 'rocket stage', 'dead', 'working', 'satellite', 'unknown'];
/** One colour per class (index = skyPack.CLS), readable on the dark map. */
export const CLASS_COLORS = ['#ff8a3d', '#c77dff', '#8f98a8', '#52f08a', '#4fb4ff', '#ffe14d'];
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
  return glass && floor === FLOOR_GLOBE
    ? { top: 'auto', bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))', maxHeight: 'calc(100vh - 260px)' }
    : { top: '176px', bottom: 'auto', maxHeight: 'calc(100vh - 260px)' };
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
    this._shown = false;
    this._built = false;
    this._info = null;
    this._credit = '';
    this._statusJoined = false;
    this._loadFailed = false;
    this._els = {};
  }

  /** The layer wires these: onSearch(query) => row index or -1; onClose() => void. */
  setHandlers({ onSearch, onClose } = {}) {
    this._onSearch = onSearch || null;
    this._onClose = onClose || null;
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

    const legend = el('div', 'margin-top:7px;display:flex;flex-wrap:wrap;gap:2px 9px;color:#aebbd6');
    const legendItems = [];
    CLASS_NAMES.forEach((n, i) => {
      const item = el('span', 'white-space:nowrap');
      const sw = el('span', `display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;background:${CLASS_COLORS[i]}`);
      item.append(sw, d.createTextNode(n));
      legend.append(item);
      legendItems.push(item);
    });
    const credit = el('div', 'margin-top:7px;font-size:10px;line-height:1.3;color:#8392b3');
    credit.id = 'real-sky-credit';
    const fail = el('div', 'display:none;margin-top:7px;color:#ffb06b', 'The sky data could not be loaded.');
    fail.id = 'real-sky-load-failed';

    root.append(input, msg, fail, card, legend, credit);
    d.body.appendChild(root);
    Object.assign(this._els, { root, input, msg, card, nameEl, dot, body, credit, legend, legendItems, fail });
    this._place();
    this._render();
  }

  /**
   * Touch (glass) or mouse, and the floor: the layer tells the card each frame; the placement changes only when the answer changes.
   * @param {boolean} glass
   * @param {number|null} floor
   */
  setLayout(glass, floor) {
    const g = glass === true, f = floor === FLOOR_GLOBE ? FLOOR_GLOBE : null;
    if (g === this._glass && f === this._floor && this._placed) return;
    this._glass = g;
    this._floor = f;
    this._place();
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
    e.legend.style.display = this._loadFailed ? 'none' : 'flex';
    e.credit.style.display = this._loadFailed ? 'none' : 'block';
    CLASS_NAMES.forEach((n, i) => {
      const hide = (i === CLS_DEAD || i === CLS_WORKING) && !this._statusJoined;
      e.legendItems[i].style.display = hide ? 'none' : '';
    });
  }

  show() {
    if (this._isGlass) this._glass = this._isGlass() === true;
    this._build();
    this._shown = true;
    this._place();
    if (this._els.root) this._els.root.style.display = 'block';
  }

  hide() {
    this._shown = false;
    if (this._els.root) this._els.root.style.display = 'none';
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
    if (this._els.credit) this._els.credit.textContent = this._credit;
  }

  _render() {
    const e = this._els;
    if (!e.root) return;
    this._renderLegend();
    e.credit.textContent = this._credit;
    const i = this._info;
    e.card.style.display = i ? 'block' : 'none';
    if (!i) return;
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
  }
}
