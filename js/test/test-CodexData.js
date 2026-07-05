/**
 * test-CodexData.js — Codex Overhaul Phase 0a: data-integrity guards.
 *
 * CodexSystem.js is Node-safe (imports only EventBus/Events/Constants — no
 * DOM/THREE), so we assert against the REAL entries rather than duplicating
 * id lists. These guards make the dedupe/rewrite/extraction work safe:
 *   - no duplicate entry ids (the _byId Map would silently swallow collisions)
 *   - every triggerEvent is a real Events.* value (no typo'd dead triggers)
 *   - every entry has a callable triggerCondition + required content fields
 *   - every entry is TRL-annotated (1..9) and unlock-hinted (post-processing)
 *   - per-category counts sum to entries.length (counts derive from data)
 *
 * @module test/test-CodexData
 */

import { describe, it, assert } from './TestRunner.js';
import { CodexSystem, CodexCategory, ALIASES, entryMatchesQuery } from '../systems/CodexSystem.js';
import { CODEX_DATA } from './_codexFixture.js';
import { Events } from '../core/Events.js';

const codex = new CodexSystem(CODEX_DATA);
const entries = codex.entries;
const EVENT_VALUES = new Set(Object.values(Events));
const CATEGORY_VALUES = new Set(Object.values(CodexCategory));

describe('Codex Phase 0 — entry id integrity', () => {
  it('has entries', () => {
    assert.ok(entries.length > 0, 'buildEntries() returned entries');
  });

  it('no duplicate entry ids', () => {
    const seen = new Map();
    const dupes = [];
    for (const e of entries) {
      if (seen.has(e.id)) dupes.push(e.id);
      else seen.set(e.id, true);
    }
    assert.equal(dupes.length, 0, `duplicate ids: ${dupes.join(', ') || 'none'}`);
  });

  it('_byId index size equals entries.length (no swallowed collisions)', () => {
    assert.equal(codex.entries.length, new Set(entries.map(e => e.id)).size,
      'every entry id is unique');
  });
});

describe('Codex Phase 0 — required content fields', () => {
  it('every entry has id/title/category/shortText/fullText/icon', () => {
    const bad = entries.filter(e =>
      !e.id || !e.title || !e.category || !e.shortText || !e.fullText || !e.icon);
    assert.equal(bad.length, 0,
      `entries missing required fields: ${bad.map(e => e.id || '?').join(', ')}`);
  });

  it('every entry.category is a valid CodexCategory', () => {
    const bad = entries.filter(e => !CATEGORY_VALUES.has(e.category));
    assert.equal(bad.length, 0,
      `entries with unknown category: ${bad.map(e => `${e.id}:${e.category}`).join(', ')}`);
  });
});

describe('Codex Phase 0 — trigger reachability (structural)', () => {
  it('every entry.triggerEvent is a real Events.* value', () => {
    const bad = [];
    for (const e of entries) {
      for (const t of codex.getTriggers(e.id)) {
        if (!EVENT_VALUES.has(t.event)) bad.push(`${e.id}:${t.event}`);
      }
    }
    assert.equal(bad.length, 0, `triggers with non-Events event: ${bad.join(', ')}`);
  });

  it('every entry has at least one callable trigger', () => {
    const bad = entries.filter(e => {
      // start-unlocked reference/onboarding entries (PLAYBOOK, WORLD_INDUSTRY)
      // are open from the first render and need no unlock trigger.
      if (e.unlocked) return false;
      const trigs = codex.getTriggers(e.id);
      return trigs.length === 0 || trigs.some(t => typeof t.match !== 'function');
    });
    assert.equal(bad.length, 0,
      `entries with missing/non-function triggers: ${bad.map(e => e.id).join(', ')}`);
  });

  it('no trigger.match throws on an empty payload', () => {
    const threw = [];
    for (const e of entries) {
      for (const t of codex.getTriggers(e.id)) {
        try { t.match({}); } catch (err) { threw.push(e.id); }
      }
    }
    assert.equal(threw.length, 0, `trigger.match threw on {}: ${threw.join(', ')}`);
  });
});

describe('Codex Phase 0 — metadata annotations applied', () => {
  it('every entry with a trl has it in 1..9', () => {
    const bad = entries.filter(e => e.trl != null && !(Number.isInteger(e.trl) && e.trl >= 1 && e.trl <= 9));
    assert.equal(bad.length, 0,
      `entries with bad trl: ${bad.map(e => `${e.id}:${e.trl}`).join(', ')}`);
  });

  it('PLAYBOOK/CATALOG/WORLD_INDUSTRY entries have no trl badge', () => {
    const NON_TECH = new Set(['PLAYBOOK', 'CATALOG', 'WORLD_INDUSTRY']);
    const bad = entries.filter(e => NON_TECH.has(e.category) && e.trl != null).map(e => e.id);
    assert.equal(bad.length, 0, `non-tech entries with trl: ${bad.join(', ')}`);
  });

  it('every entry with a trl has a non-empty trlRationale', () => {
    const bad = entries.filter(e => e.trl != null && (!e.trlRationale || !e.trlRationale.trim()));
    assert.equal(bad.length, 0, `tech entries missing trlRationale: ${bad.map(e => e.id).join(', ')}`);
  });

  it('every entry has a non-empty unlockHint', () => {
    const bad = entries.filter(e => !e.unlockHint || !e.unlockHint.trim());
    assert.equal(bad.length, 0, `entries missing unlockHint: ${bad.map(e => e.id).join(', ')}`);
  });
});

describe('Codex Phase 0 — counts derive from data', () => {
  it('per-category counts sum to entries.length', () => {
    let sum = 0;
    for (const cat of CATEGORY_VALUES) {
      sum += codex.getCategory(cat).length;
    }
    assert.equal(sum, entries.length, 'category partition covers all entries');
  });

  it('getProgress().total equals entries.length', () => {
    assert.equal(codex.getProgress().total, entries.length, 'progress total derives from data');
  });
});

describe('Codex Phase 0 — persistence round-trip', () => {
  it('getState() returns a versioned envelope { v, entries }', () => {
    const st = codex.getState();
    assert.equal(st.v, 1, 'envelope carries codex-local version');
    assert.ok(Array.isArray(st.entries), 'envelope.entries is an array');
    assert.equal(st.entries.length, entries.length, 'one record per entry');
  });

  it('restore() round-trips unlocked/seen via the envelope', () => {
    const src = new CodexSystem(CODEX_DATA);
    // Use a discovery (locked) entry so the round-trip is a real lock→unlock.
    const target = src.entries.find(e => !e.unlocked);
    const id = target.id;
    target.unlocked = true;
    target.seen = true;
    const dst = new CodexSystem(CODEX_DATA);
    dst.restore(src.getState());
    assert.ok(dst.getEntry(id).unlocked, 'unlocked restored');
    assert.ok(dst.getEntry(id).seen, 'seen restored');
  });

  it('restore() accepts the legacy bare array form', () => {
    const dst = new CodexSystem(CODEX_DATA);
    const id = dst.entries.find(e => !e.unlocked).id;
    dst.restore([{ id, unlocked: true, seen: false }]);
    assert.ok(dst.getEntry(id).unlocked, 'legacy array restored');
  });

  it('restore() ignores unknown ids and bad input without throwing', () => {
    const dst = new CodexSystem(CODEX_DATA);
    dst.restore({ v: 1, entries: [{ id: '__nope__', unlocked: true }] });
    dst.restore(null);
    dst.restore(undefined);
    dst.restore({});
    assert.ok(true, 'no throw on malformed restore data');
  });

  it('ALIASES (if any) all point to live entry ids', () => {
    const bad = Object.entries(ALIASES).filter(([, newId]) => !codex.getEntry(newId));
    assert.equal(bad.length, 0,
      `ALIASES targets that do not exist: ${bad.map(([o, n]) => `${o}->${n}`).join(', ')}`);
  });

  it('ALIASES old ids are NOT also live entry ids (they were retired)', () => {
    const conflict = Object.keys(ALIASES).filter(oldId => codex.getEntry(oldId));
    assert.equal(conflict.length, 0,
      `ALIASES keys still present as live entries: ${conflict.join(', ')}`);
  });
});

describe('Codex Phase 0 — search includes fullText', () => {
  it('entryMatchesQuery matches on fullText, not just title/shortText', () => {
    const probe = {
      title: 'Zzz', shortText: 'Zzz', category: 'PROPULSION',
      fullText: 'The Tsiolkovsky rocket equation relates delta-v to exhaust velocity.',
    };
    assert.ok(entryMatchesQuery(probe, 'tsiolkovsky'), 'fullText-only term matches');
    assert.ok(!entryMatchesQuery(probe, 'nonexistentterm'), 'unrelated term does not match');
  });

  it('searchEntries finds an entry by a fullText-only keyword', () => {
    // "Faraday" appears in EDT fullText bodies but not in any title/shortText.
    const hits = codex.searchEntries('faraday');
    assert.ok(hits.length > 0, 'fullText keyword surfaces at least one entry');
    const titlesContain = hits.every(e => !(e.title || '').toLowerCase().includes('faraday'));
    assert.ok(titlesContain, 'match came from fullText, not the title');
  });
});

// ===========================================================================
// PHASE 1 — data-driven model: dedupe, relations, tracks, categories, interp
// ===========================================================================
describe('Codex Phase 1 — dedupe + ALIASES', () => {
  const EXPECTED_ALIASES = {
    specific_impulse_explained: 'specific_impulse',
    saa_radiation: 'south_atlantic_anomaly',
    atomic_oxygen_erosion: 'atomic_oxygen',
    laser_comms_optical: 'laser_comms',
    edt_propulsion: 'edt_physics',
    star_tracker_nav: 'star_tracker',
    cmg_gyroscopes: 'reaction_wheels',
    mmod_impact_physics: 'mmod_impact',
    space_aluminum: 'aluminum_space',
    titanium: 'titanium_alloys',
    carbon_composite: 'carbon_composites',
  };

  it('exactly the 11 expected merges are aliased', () => {
    assert.deepEqual(ALIASES, EXPECTED_ALIASES, 'ALIASES matches the §13.3 dedupe list');
  });

  it('every merged-away loser id is gone from the entry set', () => {
    const stillPresent = Object.keys(EXPECTED_ALIASES).filter(id => codex.getEntry(id));
    assert.equal(stillPresent.length, 0, `losers still present: ${stillPresent.join(', ')}`);
  });

  it('every surviving alias target exists', () => {
    const missing = [...new Set(Object.values(EXPECTED_ALIASES))].filter(id => !codex.getEntry(id));
    assert.equal(missing.length, 0, `missing survivors: ${missing.join(', ')}`);
  });
});

describe('Codex Phase 1 — related graph integrity', () => {
  it('no entry.related contains a dangling id', () => {
    const dangling = [];
    for (const e of entries) {
      for (const rid of (e.related || [])) {
        if (!codex.getEntry(rid)) dangling.push(`${e.id}→${rid}`);
      }
    }
    assert.equal(dangling.length, 0, `dangling related ids: ${dangling.join(', ')}`);
  });

  it('no entry lists itself as related', () => {
    const selfRef = entries.filter(e => (e.related || []).includes(e.id)).map(e => e.id);
    assert.equal(selfRef.length, 0, `self-referential related: ${selfRef.join(', ')}`);
  });

  it('getRelated resolves to entry objects', () => {
    const withRel = entries.find(e => (e.related || []).length > 0);
    assert.ok(withRel, 'at least one entry has related ids (PROPULSION slice)');
    const resolved = codex.getRelated(withRel.id);
    assert.equal(resolved.length, withRel.related.length, 'all related ids resolved');
    assert.ok(resolved.every(r => r && r.id), 'resolved to entry objects');
  });
});

describe('Codex Phase 1 — tracks', () => {
  it('every entry.track references a defined track', () => {
    const tracks = codex.getTracks();
    const bad = entries.filter(e => e.track && !tracks[e.track]).map(e => `${e.id}:${e.track}`);
    assert.equal(bad.length, 0, `entries on undefined tracks: ${bad.join(', ')}`);
  });

  it('the propellant_story track is populated and ordered', () => {
    const t = codex.getTrack('propellant_story');
    assert.ok(t, 'propellant_story track exists');
    assert.ok(t.entries.length >= 5, `track has members (got ${t.entries.length})`);
    const orders = t.entries.map(e => e.trackOrder);
    const sorted = [...orders].sort((a, b) => a - b);
    assert.deepEqual(orders, sorted, 'track entries are returned in trackOrder');
  });
});

describe('Codex Phase 1 — categories', () => {
  it('getCategories returns ordered meta with a colour per category', () => {
    const cats = codex.getCategories();
    assert.ok(cats.length >= 14, `expected the expanded category set (got ${cats.length})`);
    assert.ok(cats.every(c => /^#[0-9a-fA-F]{6}$/.test(c.color)), 'every category has a hex colour');
    const orders = cats.map(c => c.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'categories are order-sorted');
  });

  it('WORLD_INDUSTRY uses the menu green bridge colour', () => {
    const meta = codex.getCategoryMeta('WORLD_INDUSTRY');
    assert.ok(meta, 'WORLD_INDUSTRY meta exists');
    assert.equal(meta.color.toLowerCase(), '#00ff88', 'bridges to the menu palette');
  });

  it('SENSORS was split into ATTITUDE + AVIONICS', () => {
    assert.ok(codex.getCategory('ATTITUDE').length > 0, 'ATTITUDE has entries');
    assert.ok(codex.getCategory('AVIONICS').length > 0, 'AVIONICS has entries');
    // The attitude/avionics entries are no longer filed under SENSORS.
    const sensorIds = codex.getCategory('SENSORS').map(e => e.id);
    for (const id of ['reaction_wheels', 'magnetorquers', 'detumble', 'triple_redundancy', 'watchdog_timer', 'telemetry', 'ecc_memory']) {
      assert.ok(!sensorIds.includes(id), `${id} moved out of SENSORS`);
    }
  });
});

describe('Codex Phase 1 — live-value interpolation', () => {
  it('no entry has an unresolved {{...}} placeholder', () => {
    const leftover = [];
    for (const e of entries) {
      for (const field of ['shortText', 'fullText', 'realWorld']) {
        const v = e[field];
        if (typeof v === 'string' && v.includes('{{')) leftover.push(`${e.id}.${field}`);
      }
    }
    assert.equal(leftover.length, 0, `unresolved placeholders: ${leftover.join(', ')}`);
  });

  it('net_yo_yo_despin RPM resolves from Constants.CAPTURE_NET (120/240/360)', () => {
    const e = codex.getEntry('net_yo_yo_despin');
    assert.ok(e, 'net entry exists');
    assert.ok(e.fullText.includes('120/240/360 RPM'),
      'settled-spin RPM interpolated from live constants');
  });
});

describe('Codex Phase 2 — content slice', () => {
  const NEW_IDS = ['cnt', 'carbyne', 'solar_wind', 'rendezvous', 'docking_berthing',
    'welcome_cowboy', 'catalog_envisat', 'world_adr_mandate'];

  it('PLAYBOOK/CATALOG/WORLD_INDUSTRY each have at least one entry', () => {
    assert.ok(codex.getCategory('PLAYBOOK').length >= 1, 'PLAYBOOK populated');
    assert.ok(codex.getCategory('CATALOG').length >= 1, 'CATALOG populated');
    assert.ok(codex.getCategory('WORLD_INDUSTRY').length >= 1, 'WORLD_INDUSTRY populated');
  });

  it('all 8 new entries resolve via getEntry', () => {
    const missing = NEW_IDS.filter(id => !codex.getEntry(id));
    assert.equal(missing.length, 0, `missing new entries: ${missing.join(', ')}`);
  });

  it('every PROPULSION entry has a non-empty realWorld', () => {
    const bad = codex.getCategory('PROPULSION')
      .filter(e => !e.realWorld || !e.realWorld.trim())
      .map(e => e.id);
    assert.equal(bad.length, 0, `PROPULSION entries missing realWorld: ${bad.join(', ')}`);
  });

  it('non-tech card has null TRL; cnt has TRL 3', () => {
    assert.equal(codex.getEntryTRL('welcome_cowboy'), null, 'welcome_cowboy has no TRL badge');
    const cnt = codex.getEntryTRL('cnt');
    assert.ok(cnt, 'cnt has a TRL badge');
    assert.equal(cnt.trl, 3, 'cnt TRL is 3');
  });

  it('space_elevator related includes cnt and carbyne (bidirectional graph)', () => {
    const rel = codex.getRelated('space_elevator').map(e => e.id);
    assert.ok(rel.includes('cnt'), 'space_elevator → cnt');
    assert.ok(rel.includes('carbyne'), 'space_elevator → carbyne');
  });

  it('entry count is 175', () => {
    assert.equal(entries.length, 175, 'Phase 2 + 2b + 2c + 2d yields 175 entries');
  });
});

describe('Codex Phase 2b — newbie onboarding', () => {
  it('lead orientation categories are populated (not a single card)', () => {
    assert.ok(codex.getCategory('PLAYBOOK').length >= 8, 'PLAYBOOK is a real quick-start');
    assert.ok(codex.getCategory('WORLD_INDUSTRY').length >= 3, 'WORLD_INDUSTRY expanded');
    assert.ok(codex.getCategory('CATALOG').length >= 4, 'CATALOG expanded');
  });

  it('PLAYBOOK is start-unlocked and readable immediately (no trigger needed)', () => {
    const playbook = codex.getCategory('PLAYBOOK');
    const locked = playbook.filter(e => !e.unlocked).map(e => e.id);
    assert.equal(locked.length, 0, `PLAYBOOK entries still locked: ${locked.join(', ')}`);
  });

  it('WORLD_INDUSTRY exposition is start-unlocked', () => {
    const locked = codex.getCategory('WORLD_INDUSTRY').filter(e => !e.unlocked).map(e => e.id);
    assert.equal(locked.length, 0, `WORLD_INDUSTRY entries still locked: ${locked.join(', ')}`);
  });

  it('CATALOG stays a discovery set (locked until encountered)', () => {
    const unlocked = codex.getCategory('CATALOG').filter(e => e.unlocked).map(e => e.id);
    assert.equal(unlocked.length, 0, `CATALOG entries unexpectedly start-unlocked: ${unlocked.join(', ')}`);
  });

  it('the lead category (order 0) is PLAYBOOK', () => {
    assert.equal(codex.getCategories()[0].key, 'PLAYBOOK', 'new players land on PLAYBOOK');
  });
});

describe('Codex Phase 2c — Catalog & News expansion', () => {
  const CATALOG_NEW = ['catalog_kosmos482', 'catalog_telstar1', 'catalog_sl16',
    'catalog_cz5b', 'catalog_kosmos1408'];
  const NEWS_NEW = ['news_starlink_storm', 'news_tiangong_dodge', 'news_iss_pallet',
    'news_aeolus_reentry', 'news_mev1_servicing', 'news_yunhai_collision'];

  it('CATALOG and NEWS are well-stocked', () => {
    assert.ok(codex.getCategory('CATALOG').length >= 9, 'CATALOG expanded to a real set');
    assert.ok(codex.getCategory('NEWS').length >= 8, 'NEWS expanded to a real set');
  });

  it('all 11 new Catalog/News entries resolve via getEntry', () => {
    const missing = [...CATALOG_NEW, ...NEWS_NEW].filter(id => !codex.getEntry(id));
    assert.equal(missing.length, 0, `missing: ${missing.join(', ')}`);
  });

  it('new Catalog/News entries are discovery cards (locked + reachable trigger)', () => {
    for (const id of [...CATALOG_NEW, ...NEWS_NEW]) {
      assert.ok(!codex.getEntry(id).unlocked, `${id} should start locked`);
      assert.ok(codex.entryUnlocksOn(id, Events.SCORE_UPDATE, { debrisCleared: 50 }),
        `${id} unlocks via debris progress`);
    }
  });

  it('every new Catalog/News entry carries a realWorld source line', () => {
    const bad = [...CATALOG_NEW, ...NEWS_NEW]
      .filter(id => { const e = codex.getEntry(id); return !e.realWorld || !e.realWorld.trim(); });
    assert.equal(bad.length, 0, `missing realWorld: ${bad.join(', ')}`);
  });
});

describe('Codex Phase 2d — thin-category fill', () => {
  const TECH_NEW = [
    // ATTITUDE
    'attitude_control_system', 'control_moment_gyroscope', 'rcs_attitude_control',
    'momentum_dumping', 'gravity_gradient_stabilization',
    // AVIONICS
    'onboard_computer', 'rad_hard_processor', 'single_event_effects', 'spacewire_bus', 'fdir',
    // HERITAGE
    'heritage_solar_max', 'heritage_ldef', 'heritage_hubble_servicing',
    // SENSORS
    'sun_sensor', 'pose_estimation',
  ];
  const WORLD_NEW = ['world_the_rules', 'world_liability', 'world_five_year_rule',
    'world_servicing', 'world_sustainability_rating'];

  it('thin categories are filled out', () => {
    assert.ok(codex.getCategory('ATTITUDE').length >= 8, 'ATTITUDE filled');
    assert.ok(codex.getCategory('AVIONICS').length >= 9, 'AVIONICS filled');
    assert.ok(codex.getCategory('WORLD_INDUSTRY').length >= 9, 'WORLD_INDUSTRY filled');
    assert.ok(codex.getCategory('HERITAGE').length >= 10, 'HERITAGE filled');
    assert.ok(codex.getCategory('SENSORS').length >= 10, 'SENSORS filled');
  });

  it('all 20 new Phase 2d entries resolve via getEntry', () => {
    const missing = [...TECH_NEW, ...WORLD_NEW].filter(id => !codex.getEntry(id));
    assert.equal(missing.length, 0, `missing: ${missing.join(', ')}`);
  });

  it('new tech entries are discovery cards (locked + reachable debris trigger)', () => {
    for (const id of TECH_NEW) {
      assert.ok(!codex.getEntry(id).unlocked, `${id} should start locked`);
      assert.ok(codex.entryUnlocksOn(id, Events.SCORE_UPDATE, { debrisCleared: 50 }),
        `${id} unlocks via debris progress`);
    }
  });

  it('new WORLD_INDUSTRY entries are start-unlocked reference (no trigger needed)', () => {
    for (const id of WORLD_NEW) {
      assert.ok(codex.getEntry(id).unlocked, `${id} should start unlocked`);
    }
  });

  it('every new Phase 2d entry carries a realWorld source line', () => {
    const bad = [...TECH_NEW, ...WORLD_NEW]
      .filter(id => { const e = codex.getEntry(id); return !e.realWorld || !e.realWorld.trim(); });
    assert.equal(bad.length, 0, `missing realWorld: ${bad.join(', ')}`);
  });
});

// ===========================================================================
// PHASE 6a — Content batch A: deep-dive editorial template conformance.
// Activated per batch as categories are rewritten (see the deep-dive overhaul
// plan §2/§5 + the Slice-1 review-fixes plan Part 2A). Scope EXPANDS as later
// slices land — add 'DEBRIS' and 'SPACE_ENVIRONMENT' here once phase6a rewrites
// them so the guards only police already-rewritten copy.
// ===========================================================================
describe('Codex Phase 6a — batch A template conformance', () => {
  const REWRITTEN_A = ['ORBITAL_MECHANICS', 'DEBRIS', 'SPACE_ENVIRONMENT'];
  const batchA = entries.filter(e => REWRITTEN_A.includes(e.category));

  it('batch A has entries to police', () => {
    assert.ok(batchA.length > 0, `rewritten categories populated: ${REWRITTEN_A.join(', ')}`);
  });

  it('shortText ≤140 chars (ELI5 quick-glance)', () => {
    const bad = batchA.filter(e => (e.shortText || '').length > 140)
      .map(e => `${e.id}:${e.shortText.length}`);
    assert.equal(bad.length, 0, `shortText over 140: ${bad.join(', ')}`);
  });

  it('fullText is multi-paragraph (≥1 blank-line break)', () => {
    const bad = batchA.filter(e => !(e.fullText || '').includes('\n\n')).map(e => e.id);
    assert.equal(bad.length, 0, `single-paragraph fullText: ${bad.join(', ')}`);
  });

  it('every entry carries ≥2 related links', () => {
    const bad = batchA.filter(e => (e.related || []).length < 2)
      .map(e => `${e.id}:${(e.related || []).length}`);
    assert.equal(bad.length, 0, `under-linked entries: ${bad.join(', ')}`);
  });

  it('related links are symmetric (every target links back)', () => {
    const oneway = [];
    for (const e of batchA) {
      for (const rid of (e.related || [])) {
        const t = codex.getEntry(rid);
        if (!t || !(t.related || []).includes(e.id)) oneway.push(`${e.id}→${rid}`);
      }
    }
    assert.equal(oneway.length, 0, `asymmetric related: ${oneway.join(', ')}`);
  });

  it('every trl-bearing entry has a realWorld line', () => {
    const bad = batchA.filter(e => e.trl != null && (!e.realWorld || !e.realWorld.trim()))
      .map(e => e.id);
    assert.equal(bad.length, 0, `tech entries missing realWorld: ${bad.join(', ')}`);
  });

  // Part 2A — actionable-hint rule: no passive / vague unlock hints. Every hint
  // must name a concrete player action or an observable threshold.
  it('unlockHints name a concrete action (no banned passive patterns)', () => {
    const BANNED = [
      /keep flying/i,
      /finds you/i,
      /discover through gameplay/i,               // CodexSystem default → unset hint
      /^scan, capture, and clear debris\.?$/i,     // old generic ×17
      /maneuvers and transfers reveal orbital concepts/i, // old ORBITAL generic ×6
    ];
    const bad = [];
    for (const e of batchA) {
      const h = e.unlockHint || '';
      if (BANNED.some(re => re.test(h))) bad.push(`${e.id}:"${h}"`);
    }
    assert.equal(bad.length, 0, `passive/vague unlock hints: ${bad.join(' | ')}`);
  });

  it('no banned voice phrases in i18n copy', () => {
    const BANNED = [
      /delve/i, /unleash/i, /revolutionar|revolutioni[sz]e/i, /game.?chang/i, /tapestry/i,
      /testament to/i, /in the world of/i, /it.s not just .*,? it.s/i,
      /\bcrucial\b/i, /\bvital\b/i,
    ];
    const bad = [];
    for (const e of batchA) {
      const txt = [e.shortText, e.fullText, e.realWorld, e.trlRationale].filter(Boolean).join('  ');
      for (const re of BANNED) if (re.test(txt)) bad.push(`${e.id}:${re}`);
      if (/!/.test(txt)) bad.push(`${e.id}:exclamation`);
    }
    assert.equal(bad.length, 0, `banned voice patterns: ${bad.join(', ')}`);
  });
});

// ===========================================================================
// PHASE 6b — Content batch B template conformance (POWER + TETHERS + COMMS +
// SENSORS). Same rules as 6a; scope expands as later slices rewrite more.
// ===========================================================================
describe('Codex Phase 6b — batch B template conformance', () => {
  const REWRITTEN_B = ['POWER', 'TETHERS', 'COMMS', 'SENSORS'];
  const batchB = entries.filter(e => REWRITTEN_B.includes(e.category));

  it('batch B has entries to police', () => {
    assert.ok(batchB.length > 0, `rewritten categories populated: ${REWRITTEN_B.join(', ')}`);
  });

  it('shortText ≤140 chars (ELI5 quick-glance)', () => {
    const bad = batchB.filter(e => (e.shortText || '').length > 140)
      .map(e => `${e.id}:${e.shortText.length}`);
    assert.equal(bad.length, 0, `shortText over 140: ${bad.join(', ')}`);
  });

  it('fullText is multi-paragraph (≥1 blank-line break)', () => {
    const bad = batchB.filter(e => !(e.fullText || '').includes('\n\n')).map(e => e.id);
    assert.equal(bad.length, 0, `single-paragraph fullText: ${bad.join(', ')}`);
  });

  it('every entry carries ≥2 related links', () => {
    const bad = batchB.filter(e => (e.related || []).length < 2)
      .map(e => `${e.id}:${(e.related || []).length}`);
    assert.equal(bad.length, 0, `under-linked entries: ${bad.join(', ')}`);
  });

  it('related links are symmetric (every target links back)', () => {
    const oneway = [];
    for (const e of batchB) {
      for (const rid of (e.related || [])) {
        const t = codex.getEntry(rid);
        if (!t || !(t.related || []).includes(e.id)) oneway.push(`${e.id}→${rid}`);
      }
    }
    assert.equal(oneway.length, 0, `asymmetric related: ${oneway.join(', ')}`);
  });

  it('every trl-bearing entry has a realWorld line', () => {
    const bad = batchB.filter(e => e.trl != null && (!e.realWorld || !e.realWorld.trim()))
      .map(e => e.id);
    assert.equal(bad.length, 0, `tech entries missing realWorld: ${bad.join(', ')}`);
  });

  it('unlockHints name a concrete action (no banned passive patterns)', () => {
    const BANNED = [
      /keep flying/i, /finds you/i, /discover through gameplay/i,
      /^scan, capture, and clear debris\.?$/i,
      /manage the power buses and battery during operations/i, // old POWER generic
      /work the daughters. tethers, reels, and nets/i,          // old TETHERS generic
      /use comms and downlink to ground stations/i,             // old COMMS generic
      /run scans .* and read the sensor suite/i,                // old SENSORS generic
    ];
    const bad = [];
    for (const e of batchB) {
      const h = e.unlockHint || '';
      if (BANNED.some(re => re.test(h))) bad.push(`${e.id}:"${h}"`);
    }
    assert.equal(bad.length, 0, `passive/vague unlock hints: ${bad.join(' | ')}`);
  });

  it('no banned voice phrases in i18n copy', () => {
    const BANNED = [
      /delve/i, /unleash/i, /revolutionar|revolutioni[sz]e/i, /game.?chang/i, /tapestry/i,
      /testament to/i, /in the world of/i, /it.s not just .*,? it.s/i,
      /\bcrucial\b/i, /\bvital\b/i,
    ];
    const bad = [];
    for (const e of batchB) {
      const txt = [e.shortText, e.fullText, e.realWorld, e.trlRationale].filter(Boolean).join('  ');
      for (const re of BANNED) if (re.test(txt)) bad.push(`${e.id}:${re}`);
      if (/!/.test(txt)) bad.push(`${e.id}:exclamation`);
    }
    assert.equal(bad.length, 0, `banned voice patterns: ${bad.join(', ')}`);
  });
});
