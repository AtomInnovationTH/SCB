/**
 * glossary.js — inline jargon glossary + a pure HTML decorator (master §11.8).
 *
 * The first time a hard space word (ΔV, LEO, FEEP, TRL, conjunction…) appears in
 * player-facing text we wrap it in a `<span class="glossary-term">` with a native
 * `title=` hover definition and, when the term maps to a Tech Library entry, a
 * `data-entry` deep-link the UI turns into a click → `CODEX_OPEN_ENTRY`.
 *
 * This module is deliberately **DOM-free** (mirrors codexInterpolate.js) so it
 * imports cleanly under Node for unit tests. All DOM wiring (click delegation,
 * CSS) lives at the call sites (CommsPanel, viewer, …).
 *
 * Design notes:
 *   • `decorateGlossary` is PURE: same input → same output string, no globals.
 *   • Non-term text is HTML-escaped (we are moving from raw `${text}`
 *     interpolation to span-wrapping, so escaping is mandatory — see plan §5).
 *   • The matcher is built once and cached; surface forms are sorted longest-
 *     first so "specific impulse" wins over "impulse" and "delta-v" over "v".
 *   • Per-term case rules: acronyms (LEO/GEO/TRL/RAAN) match case-SENSITIVE so
 *     "leo" in prose stays plain; phrases ("delta-v", "specific impulse") match
 *     case-INSENSITIVELY via `flags:'i'`.
 *   • Boundaries are unicode/hyphen aware: we match the raw text (never inside an
 *     already-emitted span) and reject matches flanked by word characters so
 *     "Isp" doesn't fire inside "Wispy" and "delta" doesn't fire inside "deltas".
 *
 * @module systems/codex/glossary
 */

// ============================================================================
// GLOSSARY DATA
// Each def: { term, aliases?, def, entryId?, flags? }
//   term     — canonical surface form (also the data-term key)
//   aliases  — extra surface forms that share the same def/entry
//   def      — one-line, plain-language hover definition (acronyms expanded)
//   entryId  — codex.json entry id to deep-link (omit → hover-only, no click)
//   flags    — 'i' = case-insensitive match (default: case-sensitive)
//
// Definitions are plain-language and fact-checked against the project content
// rules (acronyms expanded; humor only in framing, kept out of the defs here).
// ============================================================================

export const GLOSSARY = [
  // ── Orbital mechanics ────────────────────────────────────────────────────
  { term: 'ΔV', aliases: ['delta-v', 'delta v'], flags: 'i',
    def: 'Delta-v: the change in velocity a craft can produce — its fuel budget for every burn, in metres per second.',
    entryId: 'delta_v' },
  { term: 'specific impulse', aliases: ['Isp'], flags: 'i',
    def: 'Specific impulse: how efficiently an engine turns propellant into thrust — higher means more push per kilo of fuel.',
    entryId: 'specific_impulse' },
  { term: 'LEO',
    def: 'Low Earth Orbit: roughly 160–2,000 km up. Where most satellites, the ISS, and most debris live.' },
  { term: 'MEO',
    def: 'Medium Earth Orbit: ~2,000–35,786 km up. Home to navigation constellations like GPS.' },
  { term: 'GEO',
    def: 'Geostationary Orbit: ~35,786 km up, where a satellite circles once per day and appears fixed over one spot on Earth.' },
  { term: 'perigee',
    def: 'Perigee: the low point of an orbit — where the craft is closest to Earth and moving fastest.',
    entryId: 'keplerian_orbit' },
  { term: 'apogee',
    def: 'Apogee: the high point of an orbit — where the craft is farthest from Earth and moving slowest.',
    entryId: 'keplerian_orbit' },
  { term: 'prograde',
    def: 'Prograde: the direction of travel. Burning prograde speeds you up and raises the opposite side of the orbit.',
    entryId: 'prograde_paradox' },
  { term: 'retrograde',
    def: 'Retrograde: opposite the direction of travel. Burning retrograde slows you down and lowers the orbit.',
    entryId: 'prograde_paradox' },
  { term: 'inclination',
    def: 'Inclination: the tilt of an orbit relative to the equator, in degrees. 0° hugs the equator; 90° crosses the poles.',
    entryId: 'orbital_inclination' },
  { term: 'RAAN',
    def: 'Right Ascension of the Ascending Node: the swivel angle that fixes where an orbit\u2019s tilted plane crosses the equator.',
    entryId: 'raan_precession' },
  { term: 'eclipse',
    def: 'Eclipse: the part of each orbit spent in Earth\u2019s shadow, where solar panels make no power and the craft runs on battery.',
    entryId: 'eclipse_cycle' },
  { term: 'conjunction',
    def: 'Conjunction: a predicted close pass between two objects — the warning that a collision might be coming.',
    entryId: 'conjunction_assessment' },
  { term: 'Hohmann transfer', aliases: ['Hohmann'], flags: 'i',
    def: 'Hohmann transfer: the fuel-cheapest two-burn path between two circular orbits.',
    entryId: 'hohmann_transfer' },
  { term: 'rendezvous', flags: 'i',
    def: 'Rendezvous: matching another object\u2019s orbit and closing the gap so you can dock or capture it.',
    entryId: 'rendezvous' },
  { term: 'berthing', flags: 'i',
    def: 'Berthing: grabbing a free-flying craft with a robotic arm and bolting it on (vs. docking, which flies in under its own power).',
    entryId: 'docking_berthing' },
  { term: 'station-keeping', aliases: ['station keeping'], flags: 'i',
    def: 'Station-keeping: small regular burns that fight drag and drift to hold a craft in its assigned slot.' },
  { term: 'deorbit', aliases: ['de-orbit'], flags: 'i',
    def: 'Deorbit: deliberately dropping a craft\u2019s orbit so it re-enters and burns up instead of becoming debris.',
    entryId: 'atmospheric_drag' },

  // ── Debris & environment ──────────────────────────────────────────────────
  { term: 'Kessler syndrome', aliases: ['Kessler'], flags: 'i',
    def: 'Kessler syndrome: a runaway chain reaction where each collision makes more debris, triggering still more collisions.',
    entryId: 'kessler_syndrome' },
  { term: 'MMOD',
    def: 'Micrometeoroids and Orbital Debris: the tiny-but-hypervelocity particles that pit and puncture spacecraft.',
    entryId: 'mmod_impact' },
  { term: 'atomic oxygen', flags: 'i',
    def: 'Atomic oxygen: lone, highly reactive oxygen atoms in low orbit that slowly erode exposed spacecraft surfaces.',
    entryId: 'atomic_oxygen' },
  { term: 'Van Allen belts', aliases: ['Van Allen belt', 'Van Allen'], flags: 'i',
    def: 'Van Allen belts: doughnut-shaped zones of charged particles trapped by Earth\u2019s magnetic field that bombard electronics.',
    entryId: 'van_allen_belts' },
  { term: 'hypervelocity', flags: 'i',
    def: 'Hypervelocity: orbital impact speeds (~7–15 km/s) so high that even a paint fleck hits like a bullet.',
    entryId: 'hypervelocity' },
  { term: 'South Atlantic Anomaly', aliases: ['SAA'],
    def: 'South Atlantic Anomaly: a dip in Earth\u2019s magnetic shield over the South Atlantic where radiation reaches lower orbits.',
    entryId: 'south_atlantic_anomaly' },

  // ── Maturity / readiness ──────────────────────────────────────────────────
  { term: 'TRL',
    def: 'Technology Readiness Level: a 1–9 scale for how proven a technology is. 1 = lab idea, 9 = flight-proven in real missions.' },
  { term: 'ASAT',
    def: 'Anti-Satellite weapon: a missile or craft built to destroy satellites — tests have created some of the worst debris clouds.',
    entryId: 'fengyun_test' },
  { term: 'ADR',
    def: 'Active Debris Removal: missions that actively capture and dispose of existing junk, rather than just avoiding making more.',
    entryId: 'adr_methods_real' },
  { term: 'OSAM', aliases: ['on-orbit servicing'],
    def: 'On-orbit Servicing, Assembly and Manufacturing: refuelling, repairing or building spacecraft while they\u2019re still in space.',
    entryId: 'world_servicing' },

  // ── Propulsion ────────────────────────────────────────────────────────────
  { term: 'FEEP',
    def: 'Field-Emission Electric Propulsion: a thruster that flings ions off a charged liquid metal for ultra-precise, tiny nudges.',
    entryId: 'feep_thruster' },
  { term: 'MPD',
    def: 'Magnetoplasmadynamic thruster: a high-power electric engine that uses magnetic fields to hurl plasma for strong thrust.',
    entryId: 'mpd_burst' },
  { term: 'RCS',
    def: 'Reaction Control System: clusters of small thrusters that nudge a craft\u2019s orientation and make fine position tweaks.',
    entryId: 'rcs_attitude_control' },
  { term: 'cold gas', aliases: ['cold-gas'], flags: 'i',
    def: 'Cold-gas thruster: the simplest thruster — just compressed gas let out through a nozzle. Low performance, very reliable.',
    entryId: 'cold_gas_thruster' },
  { term: 'ion thruster', aliases: ['ion drive', 'ion engine'], flags: 'i',
    def: 'Ion thruster: electrically accelerates charged gas to very high speed — gentle thrust, but sips fuel for years.',
    entryId: 'xenon_propellant' },
  { term: 'xenon', flags: 'i',
    def: 'Xenon: a heavy inert gas, the classic ion-thruster propellant — easy to store and ionise, but expensive.',
    entryId: 'xenon_propellant' },
  { term: 'krypton', flags: 'i',
    def: 'Krypton: a cheaper, lighter cousin of xenon used as ion-thruster fuel by large constellations like Starlink.',
    entryId: 'krypton_propellant' },
  { term: 'argon', flags: 'i',
    def: 'Argon: a very cheap, abundant ion-thruster propellant — lower performance than xenon but easy to source in bulk.',
    entryId: 'argon_propellant' },

  // ── Attitude control ──────────────────────────────────────────────────────
  { term: 'reaction wheel', aliases: ['reaction wheels'], flags: 'i',
    def: 'Reaction wheel: a spinning flywheel inside the craft — speeding it up or slowing it turns the craft the other way, no fuel.',
    entryId: 'reaction_wheels' },
  { term: 'CMG',
    def: 'Control Moment Gyroscope: a fast-spinning gyro that\u2019s tilted to produce strong steering torque — used on big stations.',
    entryId: 'control_moment_gyroscope' },
  { term: 'magnetorquer', aliases: ['magnetorquers'], flags: 'i',
    def: 'Magnetorquer: an electromagnet that pushes against Earth\u2019s magnetic field to turn the craft and unload its wheels.',
    entryId: 'magnetorquers' },
  { term: 'IMU',
    def: 'Inertial Measurement Unit: gyros and accelerometers that sense how the craft is turning and accelerating.',
    entryId: 'imu_drift' },
  { term: 'star tracker', flags: 'i',
    def: 'Star tracker: a camera that reads star patterns to work out exactly which way the craft is pointing.',
    entryId: 'star_tracker' },
  { term: 'detumble', aliases: ['detumbling', 'tumble rate'], flags: 'i',
    def: 'Detumble: killing an out-of-control spin so a craft (or captured debris) holds steady enough to work with.',
    entryId: 'detumble' },
  { term: 'momentum dumping', aliases: ['momentum dump', 'desaturation'], flags: 'i',
    def: 'Momentum dumping: bleeding off spin built up in reaction wheels (via thrusters or magnetorquers) before they max out.',
    entryId: 'momentum_dumping' },

  // ── Tethers & structures ──────────────────────────────────────────────────
  { term: 'tether', flags: 'i',
    def: 'Tether: a long cable between two objects in space — used to deorbit debris, generate power, or transfer momentum.',
    entryId: 'space_tether' },
  { term: 'EDT', aliases: ['electrodynamic tether'],
    def: 'Electrodynamic Tether: a conductive cable that drags against Earth\u2019s magnetic field to lower an orbit without fuel.',
    entryId: 'edt_physics' },
  { term: 'Miura-ori', aliases: ['Miura ori', 'Miura fold'], flags: 'i',
    def: 'Miura-ori: a rigid origami fold that lets big panels or nets pack flat and deploy in one smooth pull.',
    entryId: 'miura_ori_net' },

  // ── Materials & thermal ───────────────────────────────────────────────────
  { term: 'MLI',
    def: 'Multi-Layer Insulation: the shiny gold/silver blankets that shield spacecraft from extreme heat and cold.',
    entryId: 'mli_insulation' },
  { term: 'supercapacitor', aliases: ['supercapacitors', 'supercap'], flags: 'i',
    def: 'Supercapacitor: a device that charges and discharges far faster than a battery, for quick bursts of power.',
    entryId: 'supercapacitors' },
  { term: 'RTG',
    def: 'Radioisotope Thermoelectric Generator: a nuclear battery that makes electricity from heat — powers deep-space probes for decades.',
    entryId: 'rtg_power' },

  // ── Comms & ground ────────────────────────────────────────────────────────
  { term: 'ground station', aliases: ['groundstation'], flags: 'i',
    def: 'Ground station: an antenna on Earth that talks to a satellite during the brief window it flies overhead.',
    entryId: 'ground_station_pass' },
  { term: 'TDRS',
    def: 'Tracking and Data Relay Satellite: NASA relays in high orbit that keep craft in constant contact, even out of ground sight.',
    entryId: 'tdrs_relay' },
  { term: 'telemetry', flags: 'i',
    def: 'Telemetry: the stream of health and status data a craft beams home — voltages, temperatures, attitude, and more.',
    entryId: 'telemetry' },

  // ── Avionics & reliability ────────────────────────────────────────────────
  { term: 'watchdog', aliases: ['watchdog timer'], flags: 'i',
    def: 'Watchdog timer: a chip that reboots the computer if the software stops checking in — a last-resort recovery.',
    entryId: 'watchdog_timer' },
  { term: 'TMR', aliases: ['triple redundancy', 'triple modular redundancy'], flags: 'i',
    def: 'Triple Modular Redundancy: running three copies of a circuit and voting on the answer, so one radiation glitch can\u2019t win.',
    entryId: 'triple_redundancy' },
  { term: 'SEU', aliases: ['single-event upset', 'single event upset'],
    def: 'Single-Event Upset: a stray cosmic particle flipping a bit in memory — a soft error space electronics must survive.',
    entryId: 'single_event_effects' },
  { term: 'FDIR',
    def: 'Fault Detection, Isolation and Recovery: the onboard logic that spots a failure, contains it, and switches to a backup.',
    entryId: 'fdir' },
];

// ============================================================================
// PURE DECORATOR
// ============================================================================

/**
 * Escape the five HTML-significant characters so plain text can be safely
 * assigned to innerHTML.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { escapeHtml };

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A "word char" for boundary tests: latin letters, digits, underscore. We treat
 * Δ as part of the term itself (matched literally) rather than a boundary char,
 * so "ΔV" is found, while we still reject "Ispx" / "xIsp" / "deltas".
 */
const WORD = /[A-Za-z0-9_]/;

let _matcher = null; // cached { regex, lookup }

/**
 * Build (once) the combined matcher from GLOSSARY:
 *   - every surface form → its def record
 *   - alternation sorted longest-first so greedier phrases win
 *   - case-insensitive forms lower-cased in the lookup; case-sensitive forms
 *     keyed exactly.
 * @returns {{ regex: RegExp, byForm: Map<string,object>, ci: Set<string> }}
 */
function buildMatcher() {
  if (_matcher) return _matcher;

  /** form (as-authored) → { rec, ci } */
  const forms = [];
  /** lowercased CI form → rec; exact CS form → rec */
  const byForm = new Map();

  for (const rec of GLOSSARY) {
    const ci = rec.flags && rec.flags.includes('i');
    const surfaces = [rec.term, ...(rec.aliases || [])];
    for (const surf of surfaces) {
      forms.push(surf);
      byForm.set(ci ? surf.toLowerCase() : surf, { rec, ci, surface: surf });
    }
  }

  // Longest-first so "specific impulse" beats "impulse", "delta-v" beats bits.
  forms.sort((a, b) => b.length - a.length);

  const alternation = forms.map(escapeRegExp).join('|');
  // 'gi' on the combined regex; per-form case rules are enforced at match time
  // by checking the matched substring against the case-sensitive lookup.
  const regex = new RegExp(alternation, 'gi');

  _matcher = { regex, byForm };
  return _matcher;
}

/** Test-only: clear the cached matcher (e.g. after mutating GLOSSARY in a test). */
export function _resetMatcher() { _matcher = null; }

/**
 * Resolve a raw matched substring to its glossary record, honouring case rules:
 *   - exact case-sensitive hit wins (acronyms: LEO, TRL, RAAN…)
 *   - otherwise a case-insensitive form may match on its lowercased key
 * @param {string} matched  the raw text the regex matched
 * @returns {{ rec:object, surface:string }|null}
 */
function resolveMatch(matched, byForm) {
  // Case-sensitive exact form?
  const exact = byForm.get(matched);
  if (exact && !exact.ci) return exact;
  // Case-insensitive form?
  const lower = byForm.get(matched.toLowerCase());
  if (lower && lower.ci) return lower;
  // An exact-keyed CI form (term authored already-lowercase) — accept too.
  if (exact && exact.ci) return exact;
  return null;
}

/**
 * Decorate jargon in `plainText` with hover/deep-link glossary spans.
 *
 * PURE: escapes the text, wraps recognised terms, returns an innerHTML-safe
 * string. Never wraps inside an already-emitted span (it tokenises the *raw*
 * input and escapes each piece independently).
 *
 * @param {string} plainText  raw, un-escaped source text
 * @param {object} [opts]
 * @param {boolean} [opts.once=true]  wrap only the FIRST occurrence of each
 *   distinct term per call (veteran-friendly; avoids a wall of underlines).
 * @param {(term:string)=>boolean} [opts.isNew]  optional predicate → adds the
 *   `glossary-term--new` first-use cue class when it returns true.
 * @param {(term:string)=>void} [opts.onSeen]  optional callback fired once per
 *   distinct decorated term (to persist seen-state).
 * @returns {string} HTML-safe string
 */
export function decorateGlossary(plainText, opts = {}) {
  if (typeof plainText !== 'string' || plainText.length === 0) {
    return plainText == null ? '' : escapeHtml(plainText);
  }
  const once = opts.once !== false;
  const { regex, byForm } = buildMatcher();
  regex.lastIndex = 0;

  const usedTerms = new Set();  // canonical term keys already wrapped (for `once`)
  const seenFired = new Set();  // canonical term keys onSeen already fired for
  let out = '';
  let lastIndex = 0;
  let m;

  while ((m = regex.exec(plainText)) !== null) {
    const matched = m[0];
    const start = m.index;
    const end = start + matched.length;

    // Word-boundary guard: reject a match flanked by word characters so
    // acronyms don't fire inside larger words ("Isp" in "Wispy", "leo" in
    // "Galileo"). Hyphen/space-joined forms are fine — '-' isn't a WORD char.
    const before = start > 0 ? plainText[start - 1] : '';
    const after = end < plainText.length ? plainText[end] : '';
    const firstCh = matched[0];
    const lastCh = matched[matched.length - 1];
    const boundaryBefore = !(WORD.test(before) && WORD.test(firstCh));
    const boundaryAfter = !(WORD.test(after) && WORD.test(lastCh));

    const resolved = (boundaryBefore && boundaryAfter)
      ? resolveMatch(matched, byForm) : null;

    if (!resolved) continue; // leave the regex to advance; emit verbatim later

    const termKey = resolved.rec.term;
    if (once && usedTerms.has(termKey)) continue;

    // Flush the escaped gap before this match.
    out += escapeHtml(plainText.slice(lastIndex, start));

    usedTerms.add(termKey);

    const rec = resolved.rec;
    const classes = ['glossary-term'];
    if (typeof opts.isNew === 'function' && opts.isNew(termKey)) {
      classes.push('glossary-term--new');
    }
    const dataEntry = rec.entryId ? ` data-entry="${escapeHtml(rec.entryId)}"` : '';
    out += `<span class="${classes.join(' ')}" data-term="${escapeHtml(termKey)}"`
      + `${dataEntry} title="${escapeHtml(rec.def)}">${escapeHtml(matched)}</span>`;

    lastIndex = end;
    // advance regex past this match (it already did via exec, but a `continue`
    // path above could leave lastIndex behind — exec's lastIndex is authoritative)

    if (typeof opts.onSeen === 'function' && !seenFired.has(termKey)) {
      seenFired.add(termKey);
      opts.onSeen(termKey);
    }
  }

  // Flush the trailing escaped remainder.
  out += escapeHtml(plainText.slice(lastIndex));
  return out;
}

export default decorateGlossary;
