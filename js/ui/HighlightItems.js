/**
 * HighlightItems.js — the three lists of the Highlight menu on the floor 4 globe (Sky 23, lane H3; DECISIONS §95;
 * docs/research/2026-11-floor4-highlight.md §3). Pure: no DOM, no scene. Built from `layer.catalogue()` (data/sky.json) and
 * `layer.highlights()` (data/highlights.json); RealSkyCard draws them and hands `toHighlight(item)` to `layer.setHighlight`.
 *
 *   Famous             the hand list of data/highlights.json, one object or group a row, its plain line beside the name;
 *   Your country       the menu language's country (flag -> GCAT State code): its working, dead, "satellite" and unknown objects, Starlink
 *                      left out, listed by kind with the biggest named; "+ stages" and "+ debris" add those kinds;
 *   Heaviest leftovers `isHeavyRow` (over 1,000 kg, not working, mean height under 2,000 km): all of them lit, the heaviest 25 listed
 *                      grouped by family.
 *   Families           Navigation, Weather, Internet fleets, Spy satellites (the catalogue's `fam` column), People on board (data/highlights.json
 *                      `crew`): working ones lit first, "+ dead" adds the rest (Sky 33, DECISIONS §105 rows 1-3).
 *
 * Nothing here is made up: names, masses and owners are the catalogue's; a row with no mass says nothing about mass.
 *
 * @module ui/HighlightItems
 */

import { isHeavyRow } from './SkyLook.js';

export const ID_FAMOUS = 'menu-famous';
export const ID_COUNTRY = 'menu-country';
export const ID_HEAVY = 'menu-heavy';
/** The ids of the three items, in menu order (the five Families come after them: FAMILY_IDS). */
export const ITEM_IDS = [ID_FAMOUS, ID_COUNTRY, ID_HEAVY];
/** True for an id that is one of this menu's items, a family included (another item's highlight is not the menu's to list). */
export const isMenuId = (id) => ITEM_IDS.includes(id) || FAMILY_IDS.includes(id);

/** How many heavy objects the list shows (grouped by family into a few rows; all of them are lit). */
export const HEAVY_LIST_TOP = 25;
/** At most this many names go to the layer for a country (it draws 8 on a mouse, 6 on touch). */
export const COUNTRY_NAMES_MAX = 12;

// sky.json class numbers (scripts/skyPack.mjs CLS) and the Starlink rule (RealSkyCard.isStarlinkRow: class working + a name starting with STARLINK;
// copied here because RealSkyCard imports this module; a test pins the two equal).
const CLS_DEBRIS = 0, CLS_STAGE = 1, CLS_DEAD = 2, CLS_WORKING = 3, CLS_SATELLITE = 4, CLS_UNKNOWN = 5;
export const isStarlink = (row) => !!row && row[2] === CLS_WORKING && /^STARLINK/i.test(String(row[1]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');

/** "17 Nov 2026" (UTC) from an ISO string, or ''. */
export function snapshotDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Column numbers of the fields this module reads (by name from the catalogue's header, so a column that moves is still found). */
function columns(cat) {
  const f = cat.fields || [];
  const at = (n, d) => { const i = f.indexOf(n); return i >= 0 ? i : d; };
  return { norad: at('norad', 0), name: at('name', 1), cls: at('cls', 2), lenM: at('lenM', 3), massKg: at('massKg', 6), state: f.indexOf('state') };
}

const _byNoradCache = new WeakMap();
/** Map norad -> row for a catalogue (kept per rows array). */
function byNorad(cat) {
  let m = _byNoradCache.get(cat.rows);
  if (!m) { m = new Map(); for (const r of cat.rows) m.set(r[0], r); _byNoradCache.set(cat.rows, m); }
  return m;
}

/** The credit line of every list: "catalogue 17 Nov 2026". */
export const creditLine = (cat) => { const d = snapshotDate(cat && cat.snapshotUtc); return d ? `catalogue ${d}` : 'catalogue'; };

/**
 * The short name a globe label uses for a Famous row: the entry's own `short` (data/highlights.json) when it has one, else up to a comma or a
 * bracket ("Tiangong, China's station" -> "Tiangong"); the ISS has its usual short form either way.
 * @param {string} id @param {string} label @param {string} [short] the entry's `short` field
 */
export function shortName(id, label, short) {
  if (typeof short === 'string' && short.trim()) return short.trim();
  if (id === 'iss') return 'ISS';
  return String(label).split(/,| \(/)[0].trim();
}

/** Lower-case letters and digits only ("ISS (ZARYA)" -> "isszarya"), to ask whether a catalogue name already says a short name. */
const normName = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The Famous entry that lists a NORAD number, or null. @param {{famous?:Array}|null} hl */
export function famousEntryOf(hl, norad) {
  if (!hl || !Array.isArray(hl.famous)) return null;
  return hl.famous.find((f) => Array.isArray(f.norads) && f.norads.includes(norad)) || null;
}

/**
 * The story line for the tap card: the Famous entry's `line`, with the entry's short name and ": " before it unless the catalogue name already
 * contains that short name ("HST" -> "Hubble: Launched ..."; "ISS (ZARYA)" -> the line alone). '' when the object is not in the Famous list.
 * @param {{famous?:Array}|null} hl @param {number} norad @param {string} catName the name the card shows
 */
export function famousStory(hl, norad, catName) {
  const f = famousEntryOf(hl, norad);
  if (!f || !f.line) return '';
  const short = shortName(f.id, f.label, f.short);
  return normName(catName).includes(normName(short)) ? f.line : `${short}: ${f.line}`;
}

/** The name the Highlight lists and the tap card give a catalogue row: data/highlights.json `names` (e.g. 58016 "T2V" -> "THEOS-2"), else the catalogue's own. */
export function displayName(hl, norad, name) {
  const n = hl && hl.names && hl.names[String(norad)];
  return n && typeof n.name === 'string' && n.name ? n.name : String(name);
}

/** The first of `norads` that the catalogue has, or null. */
function firstIn(cat, norads) {
  const m = byNorad(cat);
  for (const n of norads) if (m.has(n)) return n;
  return null;
}

/**
 * Famous: one row per entry of data/highlights.json `famous`, in the file's order.
 * @param {{rows:Array[], fields:string[], snapshotUtc:string}} cat @param {{famous:Array}} hl
 */
export function buildFamous(cat, hl) {
  if (!cat || !hl || !Array.isArray(hl.famous)) return null;
  const norads = new Set(), names = new Map(), rows = [];
  for (const f of hl.famous) {
    const ns = (f.norads || []).filter((n) => byNorad(cat).has(n));
    if (ns.length === 0) continue;
    for (const n of ns) norads.add(n);
    names.set(ns[0], shortName(f.id, f.label, f.short));
    rows.push({ key: f.id, label: f.label, sub: f.line || '', norads: ns, first: ns[0], count: ns.length });
  }
  if (rows.length === 0) return null;
  return {
    id: ID_FAMOUS, title: 'Famous', count: rows.length, header: `Famous \u00b7 ${rows.length}`, credit: creditLine(cat),
    honesty: 'hand list, sourced', rows, norads, names, litCount: norads.size,
  };
}

/** Kind words for the country list's rows (the card's own words for each kind). */
const COUNTRY_KINDS = [
  { cls: CLS_WORKING, one: 'working satellite', many: 'working satellites' },
  { cls: CLS_DEAD, one: 'dead satellite', many: 'dead satellites' },
  { cls: CLS_SATELLITE, one: 'satellite, no report on whether it works', many: 'satellites, no report on whether they work' },   // Sky 32: the key's "no report" kind
  { cls: CLS_UNKNOWN, one: 'unknown object', many: 'unknown objects' },
];

/** The biggest first: mass (a row with none last), then length, then the lowest NORAD number. */
function biggestFirst(c) {
  return (a, b) => ((b[c.massKg] != null ? b[c.massKg] : -1) - (a[c.massKg] != null ? a[c.massKg] : -1))
    || ((b[c.lenM] != null ? b[c.lenM] : -1) - (a[c.lenM] != null ? a[c.lenM] : -1)) || (a[c.norad] - b[c.norad]);
}

/** The country entry for a flag code ('USA', 'THA' ...), or null: `{ code, name }` from data/highlights.json `countries`. */
export function countryOf(hl, flag) {
  const c = hl && hl.countries && hl.countries[flag];
  return c && c.code ? c : null;
}

/**
 * The rows of one country: `{ sats: [rows of kinds working/dead/satellite/unknown, Starlink left out], stages: [...], debris: [...] }`, each biggest first.
 * @param {{rows:Array[], fields:string[], states:string[]}} cat @param {string} code the GCAT State code
 * @returns {{sats:Array[], stages:Array[], debris:Array[]}|null} null when the data has no State column or does not know the code
 */
export function countryRows(cat, code) {
  const c = columns(cat);
  const si = (cat.states || []).indexOf(code);
  if (c.state < 0 || si < 0) return null;
  const out = { sats: [], stages: [], debris: [] };
  for (const r of cat.rows) {
    if (r[c.state] !== si) continue;
    const k = r[c.cls];
    if (k === CLS_STAGE) out.stages.push(r);
    else if (k === CLS_DEBRIS) out.debris.push(r);
    else if (k === CLS_WORKING && isStarlink(r)) continue;
    else out.sats.push(r);
  }
  const cmp = biggestFirst(c);
  out.sats.sort(cmp); out.stages.sort(cmp); out.debris.sort(cmp);
  return out;
}

/**
 * Your country: the language's country. `extras` = { stages, debris } add those kinds to what is lit (the list gets a row for each).
 * @param {object} cat @param {object} hl @param {string} flag the language's flag code (Languages.js: 'USA', 'THA' ...)
 * @param {{stages?:boolean, debris?:boolean}} [extras]
 */
export function buildCountry(cat, hl, flag, extras = {}) {
  const country = countryOf(hl, flag);
  if (!cat || !country) return null;
  const r = countryRows(cat, country.code);
  if (!r) return null;
  const c = columns(cat);
  const rows = [], names = new Map(), norads = new Set();
  const groups = COUNTRY_KINDS.map((k) => ({ k, list: r.sats.filter((x) => x[c.cls] === k.cls) })).filter((g) => g.list.length > 0);
  for (const { list } of groups) for (const x of list) norads.add(x[c.norad]);
  // names: the biggest of each kind first, then the second of each, so a few names cover every kind (the layer shows 8 on a mouse, 6 on touch)
  for (let rank = 0; names.size < COUNTRY_NAMES_MAX && groups.some((g) => g.list.length > rank); rank++) {
    for (const g of groups) if (rank < g.list.length && names.size < COUNTRY_NAMES_MAX) names.set(g.list[rank][c.norad], displayName(hl, g.list[rank][c.norad], g.list[rank][c.name]));
  }
  for (const g of groups) {
    const big = g.list[0];
    const kg = big[c.massKg] != null ? ` (${fmtInt(big[c.massKg])} kg)` : '';
    rows.push({
      key: `kind-${g.k.cls}`, label: `${fmtInt(g.list.length)} ${g.list.length === 1 ? g.k.one : g.k.many}`, sub: `biggest: ${displayName(hl, big[c.norad], big[c.name])}${kg}`,
      norads: g.list.map((x) => x[c.norad]), first: big[c.norad], count: g.list.length,
    });
  }
  const extra = [['stages', r.stages, 'stage', 'stages'], ['debris', r.debris, 'debris piece', 'debris pieces']];
  for (const [key, list, one, many] of extra) {
    if (list.length === 0) continue;
    const on = extras[key] === true;
    if (on) for (const x of list) norads.add(x[c.norad]);
    rows.push({
      key: `extra-${key}`, toggle: key, on, label: `${on ? '\u2713 ' : '+ '}${fmtInt(list.length)} ${list.length === 1 ? one : many}`,
      sub: on ? 'lit too (tap to take away)' : 'tap to light them too', norads: list.map((x) => x[c.norad]), first: list[0][c.norad], count: list.length,
    });
  }
  return {
    id: ID_COUNTRY, title: 'Your country', count: norads.size, header: `${country.name} \u00b7 ${fmtInt(norads.size)}`, country, credit: creditLine(cat),
    honesty: 'owner per GCAT', rows, norads, names, litCount: norads.size, extras: { stages: extras.stages === true, debris: extras.debris === true },
  };
}

/** Rows that `isHeavyRow` calls heavy, heaviest first (ties by NORAD number). */
export function heavyRows(cat) {
  const c = columns(cat);
  return cat.rows.filter(isHeavyRow).sort((a, b) => (b[c.massKg] - a[c.massKg]) || (a[c.norad] - b[c.norad]));
}

/**
 * Heaviest leftovers: all heavy objects lit; the list is the heaviest 25 grouped by family (the name), each row with its kg.
 * @param {object} cat
 */
export function buildHeaviest(cat) {
  if (!cat) return null;
  const c = columns(cat);
  const heavy = heavyRows(cat);
  if (heavy.length === 0) return null;
  const norads = new Set(heavy.map((r) => r[c.norad]));
  const groups = [];
  for (const r of heavy.slice(0, HEAVY_LIST_TOP)) {
    let g = groups.find((x) => x.name === r[c.name]);
    if (!g) { g = { name: r[c.name], cls: r[c.cls], list: [] }; groups.push(g); }
    g.list.push(r);
  }
  const rows = [], names = new Map();
  for (const g of groups) {
    const hi = g.list[0][c.massKg], lo = g.list[g.list.length - 1][c.massKg];
    const kg = hi === lo ? `${fmtInt(hi)} kg` : `${fmtInt(lo)} to ${fmtInt(hi)} kg`;
    const kind = g.cls === CLS_STAGE ? 'stage' : g.cls === CLS_DEAD ? 'dead satellite' : g.cls === CLS_DEBRIS ? 'debris' : g.cls === CLS_SATELLITE ? 'satellite, no report' : 'object';   // Sky 32: "no report" is the key's word for this kind
    const n = g.list.length;
    const kindMany = g.cls === CLS_SATELLITE ? 'satellites, no report' : `${kind}s`;
    rows.push({
      key: `heavy-${g.list[0][c.norad]}`, label: n > 1 ? `${g.name} \u00d7 ${n}` : String(g.name), sub: `${kg} \u00b7 ${n > 1 && kind !== 'debris' ? kindMany : kind}`,
      norads: g.list.map((x) => x[c.norad]), first: g.list[0][c.norad], count: n,
    });
    names.set(g.list[0][c.norad], n > 1 ? `${g.name} \u00d7 ${n}` : String(g.name));
  }
  return {
    id: ID_HEAVY, title: 'Heaviest leftovers', count: heavy.length, header: `Heaviest leftovers \u00b7 ${fmtInt(heavy.length)} over 1,000 kg`, credit: creditLine(cat),
    honesty: 'mass per GCAT; a few are estimates there', rows, norads, names, litCount: norads.size,
  };
}

/**
 * The menu's items, in order, each null-free (an item the data cannot give is left out): Famous, Your country, Heaviest leftovers, then the
 * Families (`group: 'families'`; the card draws them under a "Families" row).
 * @param {object|null} cat `layer.catalogue()` @param {object|null} hl `layer.highlights()` @param {string|null} flag the language's flag code
 * @param {{stages?:boolean, debris?:boolean}} [extras] the Your country extras now on
 * @param {{joined?:boolean, famDead?:string|null}} [opts] `joined` = the catalogue's working / dead status is trusted (default: the data's own
 *   `statusJoined`); `famDead` = the id of the family whose "+ dead" is on (the card keeps that state)
 * @returns {Array<object>}
 */
export function buildItems(cat, hl, flag, extras, opts = {}) {
  if (!cat || !Array.isArray(cat.rows)) return [];
  const joined = typeof opts.joined === 'boolean' ? opts.joined : cat.statusJoined !== false;
  return [buildFamous(cat, hl), flag ? buildCountry(cat, hl, flag, extras) : null, buildHeaviest(cat), ...buildFamilies(cat, hl, { joined, famDead: opts.famDead || null })].filter(Boolean);
}

/* ---------------------------------------------------------------- Families (Sky 33, DECISIONS §105 rows 1-3)
 * Five rows under "Families": Navigation, Weather, Internet fleets, Spy satellites, People on board. A family lights its working satellites
 * first; its last list row "+ dead (N)" adds the ones that stopped working or have no report. The code of each satellite is the catalogue's
 * `fam` column (scripts/skyPack.mjs `FAM`); People on board is the dated hand list in data/highlights.json `crew`. */

export const ID_FAM_NAV = 'fam-nav', ID_FAM_WEATHER = 'fam-weather', ID_FAM_NET = 'fam-net', ID_FAM_SPY = 'fam-spy', ID_FAM_CREW = 'fam-crew';
/** The ids of the five family items, in menu order. */
export const FAMILY_IDS = [ID_FAM_NAV, ID_FAM_WEATHER, ID_FAM_NET, ID_FAM_SPY, ID_FAM_CREW];

const HONESTY_PUBLIC = 'From the public catalogue of 17 Nov 2026; a few new satellites have no job listed yet.';
const HONESTY_SPY = 'Countries keep some spy satellites secret; these are the ones in the public list.';
const COUNTRY_TOP = 3;

/** Plain names for the GCAT State codes the country rows can show (anything else is shown by its code); the Soviet Union rows count as Russia. */
const STATE_NAMES = {
  US: 'United States', CN: 'China', RU: 'Russia', SU: 'Russia', F: 'France', J: 'Japan', IN: 'India', UK: 'United Kingdom', D: 'Germany', I: 'Italy',
  KR: 'South Korea', TW: 'Taiwan', E: 'Spain', CA: 'Canada', 'I-EUM': 'EUMETSAT (Europe)', 'I-ESA': 'ESA (Europe)', SG: 'Singapore', TR: 'Turkey',
  MA: 'Morocco', EG: 'Egypt', DZ: 'Algeria', NL: 'Netherlands', P: 'Portugal', AU: 'Australia', UAE: 'United Arab Emirates', KP: 'North Korea',
};
const stateName = (code) => STATE_NAMES[code] || code;
/** The state codes that read as the same country (a row's `state` for the Soviet Union and for Russia). */
const stateKey = (code) => (code === 'SU' ? 'RU' : code);

/** The groups of a code family: the list rows. `codes` = the `fam` values it takes; `rows` = [fam code, label, note]; or `by: 'state'` (the top countries). */
const FAMILY_DEFS = [
  { id: ID_FAM_NAV, title: 'Navigation', honesty: HONESTY_PUBLIC,
    tag: 'Satellites that tell phones, ships and planes where they are: GPS (USA), GLONASS (Russia), Galileo (Europe), BeiDou (China).',
    rows: [[11, 'GPS', 'the US system'], [12, 'GLONASS', 'the Russian system'], [13, 'Galileo', 'the European system'], [14, 'BeiDou', 'the Chinese system'],
      [19, 'Other navigation', 'India, Japan and older systems']] },
  { id: ID_FAM_WEATHER, title: 'Weather', honesty: HONESTY_PUBLIC, by: 'state', codes: [20],
    tag: 'Satellites that watch clouds, storms and the air for weather forecasts.' },
  { id: ID_FAM_NET, title: 'Internet fleets', honesty: HONESTY_PUBLIC,
    tag: 'Big fleets that carry internet and phone links from space: OneWeb, Kuiper, Qianfan, Guowang, Iridium. Starlink has its own box.',
    rows: [[31, 'OneWeb', 'a British fleet'], [32, 'Kuiper', 'Amazon\u2019s fleet'], [33, 'Qianfan', 'a Chinese fleet'], [34, 'Guowang', 'a Chinese fleet'], [35, 'Iridium', 'phone links']] },
  { id: ID_FAM_SPY, title: 'Spy satellites', honesty: HONESTY_SPY, by: 'state', codes: [40],
    tag: 'Military satellites that take pictures, listen to radio signals or watch for missile launches.' },
];
for (const d of FAMILY_DEFS) if (!d.codes) d.codes = d.rows.map((r) => r[0]);

const _famCache = new WeakMap();
/** The catalogue's rows per `fam` code (kept per rows array): Map code -> rows in catalogue order. null when the data has no `fam` column. */
function familyRows(cat) {
  let m = _famCache.get(cat.rows);
  if (m === undefined) {
    const fi = (cat.fields || []).indexOf('fam');
    if (fi < 0) m = null;
    else { m = new Map(); for (const r of cat.rows) { const k = r[fi]; if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } } }
    _famCache.set(cat.rows, m);
  }
  return m;
}

/** "GPS · 31" (a count of 1 stays bare in People on board: "Soyuz MS-29 · 1" would say nothing). */
const withCount = (label, n) => `${label} \u00b7 ${fmtInt(n)}`;

/** One code family as an item, or null when none of its satellites is in the data. */
function buildCodeFamily(cat, def, byCode, joined, dead) {
  const c = columns(cat);
  const members = [];
  for (const code of def.codes) for (const r of byCode.get(code) || []) members.push(r);
  if (members.length === 0) return null;
  members.sort((a, b) => a[c.norad] - b[c.norad]);
  // statuses not trusted: every member is lit and nothing is said about working; else the working ones, and "+ dead" adds the rest
  const working = joined ? members.filter((r) => r[c.cls] === CLS_WORKING) : members;
  const rest = joined ? members.filter((r) => r[c.cls] !== CLS_WORKING) : [];
  const on = joined && rest.length > 0 && dead === true;
  const lit = on ? [...working, ...rest] : working;
  const names = new Map(), rows = [];
  const isRest = new Set(rest.map((r) => r[c.norad]));
  /** A list row for a group of lit rows: the working ones first, then the rest. */
  const pushRow = (key, label, note, list) => {
    if (list.length === 0) return;
    const ordered = [...list.filter((r) => !isRest.has(r[c.norad])), ...list.filter((r) => isRest.has(r[c.norad]))];
    rows.push({ key, label: withCount(label, ordered.length), sub: note, norads: ordered.map((r) => r[c.norad]), first: ordered[0][c.norad], count: ordered.length });
    names.set(ordered[0][c.norad], label);
  };
  if (def.by === 'state') {
    // the top countries by their members (all of them, so the rows do not change with "+ dead"), then "Other countries"
    const tally = new Map();
    for (const r of members) { const k = c.state >= 0 && r[c.state] >= 0 ? stateKey(cat.states[r[c.state]]) : ''; tally.set(k, (tally.get(k) || 0) + 1); }
    const top = [...tally.entries()].filter(([k]) => k !== '').sort((a, b) => (b[1] - a[1]) || stateName(a[0]).localeCompare(stateName(b[0]))).slice(0, COUNTRY_TOP).map(([k]) => k);
    const keyOf = (r) => (c.state >= 0 && r[c.state] >= 0 ? stateKey(cat.states[r[c.state]]) : '');
    for (const k of top) pushRow(`state-${k}`, stateName(k), k === 'RU' ? 'Russia, with the old Soviet Union' : `run by ${stateName(k)}`, lit.filter((r) => keyOf(r) === k));
    pushRow('state-other', 'Other countries', 'every other country, and those the catalogue does not name', lit.filter((r) => !top.includes(keyOf(r))));
  } else {
    const fi = (cat.fields || []).indexOf('fam');
    for (const [code, label, note] of def.rows) pushRow(`fam-${code}`, label, note, lit.filter((r) => r[fi] === code));
  }
  if (joined && rest.length > 0) {
    rows.push({
      key: 'extra-dead', toggle: 'famDead', on,
      label: `${on ? '\u2713 ' : '+ '}dead (${fmtInt(rest.length)})`,
      sub: on ? 'lit too (tap to take away)' : `adds the ${fmtInt(rest.length)} that stopped working or have no report`,
      norads: rest.map((r) => r[c.norad]), first: rest[0][c.norad], count: rest.length,
    });
  }
  const norads = new Set(lit.map((r) => r[c.norad]));
  return {
    id: def.id, title: def.title, group: 'families', family: true, count: working.length, all: members.length, joined,
    header: `${def.title} \u00b7 ${fmtInt(norads.size)} of ${fmtInt(members.length)} shown`, tag: def.tag, credit: creditLine(cat), honesty: def.honesty,
    rows, norads, names, litCount: norads.size, working: working.map((r) => r[c.norad]), rest: rest.map((r) => r[c.norad]), famDead: on,
  };
}

/** People on board: the two stations (the module lists of the Famous entries data/highlights.json `crew.stations` names) and the crewed ships docked to them on the list's date. */
function buildCrew(cat, hl) {
  const crew = hl && hl.crew;
  if (!crew || !Array.isArray(hl.famous)) return null;
  const m = byNorad(cat);
  const rows = [], names = new Map(), norads = new Set();
  let stations = 0, ships = 0;
  // This family counts craft, not catalogue pieces (a station is 3-6 pieces): a child reads "12" as 12 people. So the rows carry no count; the lit set is every piece.
  const push = (key, label, note, list) => {
    const have = list.filter((n) => m.has(n));
    if (have.length === 0) return false;
    for (const n of have) norads.add(n);
    rows.push({ key, label, sub: note, norads: have, first: have[0], count: have.length });
    names.set(have[0], label);
    return true;
  };
  for (const id of crew.stations || []) {
    const f = hl.famous.find((x) => x.id === id);
    if (f && push(`crew-${id}`, shortName(f.id, f.label, f.short), 'a station with people living on it', f.norads || [])) stations++;
  }
  for (const s of crew.ships || []) {
    if (s && Number.isFinite(s.norad) && push(`crew-${s.norad}`, s.label, `a crew ship docked to ${s.at || 'the station'}`, [s.norad])) ships++;
  }
  if (rows.length === 0) return null;
  const date = crew.date ? snapshotDate(`${crew.date}T12:00:00Z`) : '17 Nov 2026';
  const parts = [];
  if (stations) parts.push(`${stations} ${stations === 1 ? 'station' : 'stations'}`);
  if (ships) parts.push(`${ships} crew ${ships === 1 ? 'ship' : 'ships'}`);
  return {
    id: ID_FAM_CREW, title: 'People on board', group: 'families', family: true, noCount: true, count: norads.size, all: norads.size, joined: false,
    header: `People on board \u00b7 ${parts.join(', ')}`, tag: `The two space stations with people living on them, and the crew ships docked to them on ${date}.`,
    credit: creditLine(cat), honesty: HONESTY_PUBLIC, rows, norads, names, litCount: norads.size, working: [...norads], rest: [], famDead: false,
  };
}

/**
 * The family items, in menu order, those with nothing in the data left out (the whole list is empty when the data has no `fam` column).
 * @param {object} cat @param {object|null} hl @param {{joined: boolean, famDead: string|null}} o
 */
export function buildFamilies(cat, hl, o) {
  const byCode = cat && Array.isArray(cat.rows) ? familyRows(cat) : null;
  if (!byCode) return [];
  const out = FAMILY_DEFS.map((d) => buildCodeFamily(cat, d, byCode, o.joined, o.famDead === d.id));
  out.splice(4, 0, buildCrew(cat, hl));   // People on board comes last
  return out.filter(Boolean);
}

/** What `layer.setHighlight` takes for an item (the layer adds the fade, the rings and the names' boxes). */
export function toHighlight(item) {
  return { id: item.id, label: item.header, norads: new Set(item.norads), names: new Map(item.names), honesty: item.honesty };
}
