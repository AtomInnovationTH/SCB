/**
 * test-DossierSystem.js — progressive debris-data reveal + close-range survey
 * (capture-feedback overhaul Phase 1.5).
 *
 * Coverage: tier transitions by scan/profile state, survey accumulation by
 * proximity (mother OR daughter), DEBRIS_PROFILED emission, once-per-debris
 * bounty, ring progress, reset, salvage appraisal math.
 */
import { describe, it, assert } from './TestRunner.js';
import { DossierSystem, DOSSIER_TIERS, appraiseSalvage } from '../systems/DossierSystem.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

const M = 0.00001;

function makeDebris(over = {}) {
  return {
    id: over.id ?? 42,
    discovered: true,
    alive: true,
    _scenePosition: { x: 0, y: 0, z: 0 },
    mass: 200,
    salvage: { xenon: 2.1, metals: ['TITANIUM'] },
    hasSalvage: true,
    ...over,
  };
}

/** Collect events of given names while fn runs. */
function collect(names, fn) {
  const got = {};
  const offs = names.map(n => {
    got[n] = [];
    return eventBus.on(n, (d) => got[n].push(d));
  });
  try { fn(); } finally {
    for (const off of offs) { if (typeof off === 'function') off(); }
  }
  return got;
}

describe('DossierSystem — reveal tiers', () => {
  it('undiscovered → UNSCANNED; discovered → SCANNED; surveyed → PROFILED', () => {
    const ds = new DossierSystem();
    const d = makeDebris();
    assert.equal(ds.getTier({ ...d, discovered: false }), DOSSIER_TIERS.UNSCANNED);
    assert.equal(ds.getTier(d), DOSSIER_TIERS.SCANNED);
    ds._profiled.add(d.id);
    assert.equal(ds.getTier(d), DOSSIER_TIERS.PROFILED);
    assert.ok(ds.isProfiled(d.id));
  });

  it('null target reads UNSCANNED (no data leaks)', () => {
    const ds = new DossierSystem();
    assert.equal(ds.getTier(null), DOSSIER_TIERS.UNSCANNED);
  });
});

describe('DossierSystem — close-range survey', () => {
  it('holding within DETAIL_SCAN_RANGE_M for SURVEY_TIME_S profiles the target', () => {
    const ds = new DossierSystem();
    const d = makeDebris({ id: 'rb-1' });
    const near = { x: 30 * M, y: 0, z: 0 };   // 30 m < 50 m
    const got = collect([Events.DEBRIS_PROFILED], () => {
      for (let i = 0; i < 35; i++) {
        ds.update(0.1, { playerPos: near, target: d });
      }
    });
    assert.equal(got[Events.DEBRIS_PROFILED].length, 1, 'profiled exactly once');
    assert.equal(got[Events.DEBRIS_PROFILED][0].debrisId, 'rb-1');
    assert.ok(ds.isProfiled('rb-1'));
  });

  it('survey ring progress fills 0→1 and resets when range is broken', () => {
    const ds = new DossierSystem();
    const d = makeDebris({ id: 7 });
    const near = { x: 40 * M, y: 0, z: 0 };
    const far = { x: 500 * M, y: 0, z: 0 };
    ds.update(1.5, { playerPos: near, target: d });
    const half = ds.getSurveyProgress(7);
    assert.ok(half > 0.4 && half < 0.6, `~50% after 1.5 s (got ${half})`);
    ds.update(0.1, { playerPos: far, target: d });
    assert.equal(ds.getSurveyProgress(7), 0, 'breaking range drains the ring');
  });

  it('a deployed daughter in range surveys too (mother far away)', () => {
    const ds = new DossierSystem();
    const d = makeDebris({ id: 9 });
    const armManager = {
      arms: [
        { state: 'DOCKED', position: { x: 10 * M, y: 0, z: 0 } },          // docked: ignored
        { state: 'STATION_KEEP', position: { x: 20 * M, y: 0, z: 0 } },    // 20 m: counts
      ],
    };
    const got = collect([Events.DEBRIS_PROFILED], () => {
      for (let i = 0; i < 35; i++) {
        ds.update(0.1, { playerPos: { x: 1, y: 0, z: 0 }, armManager, target: d });
      }
    });
    assert.equal(got[Events.DEBRIS_PROFILED].length, 1, 'daughter proximity completes the survey');
  });

  it('undiscovered targets cannot be surveyed (scan first)', () => {
    const ds = new DossierSystem();
    const d = makeDebris({ id: 11, discovered: false });
    const got = collect([Events.DEBRIS_PROFILED], () => {
      for (let i = 0; i < 50; i++) {
        ds.update(0.1, { playerPos: { x: 10 * M, y: 0, z: 0 }, target: d });
      }
    });
    assert.equal(got[Events.DEBRIS_PROFILED].length, 0);
  });
});

describe('DossierSystem — data bounty (once per debris)', () => {
  it('first profile pays SURVEY_BOUNTY exactly once; reset clears knowledge', () => {
    const ds = new DossierSystem();
    const d = makeDebris({ id: 'pay-1' });
    const near = { x: 10 * M, y: 0, z: 0 };
    const run = () => { for (let i = 0; i < 35; i++) ds.update(0.1, { playerPos: near, target: d }); };

    const got = collect([Events.SCORING_AWARD, Events.DEBRIS_PROFILED], run);
    const awards = got[Events.SCORING_AWARD].filter(a => a.reason === 'Close-range survey data');
    assert.equal(awards.length, 1, 'bounty paid once');
    assert.equal(awards[0].points, Constants.DOSSIER.SURVEY_BOUNTY);
    assert.equal(got[Events.DEBRIS_PROFILED][0].bountyPaid, true);

    // Force a re-profile of the same debris: no second bounty.
    ds._profiled.delete('pay-1');
    const got2 = collect([Events.SCORING_AWARD, Events.DEBRIS_PROFILED], run);
    const awards2 = got2[Events.SCORING_AWARD].filter(a => a.reason === 'Close-range survey data');
    assert.equal(awards2.length, 0, 're-profile pays nothing');
    assert.equal(got2[Events.DEBRIS_PROFILED][0].bountyPaid, false);

    ds.reset();
    assert.ok(!ds.isProfiled('pay-1'), 'reset clears profiles');
  });
});

describe('DossierSystem — salvage appraisal (pure)', () => {
  it('appraises each manifest line and totals the credits', () => {
    const V = Constants.DOSSIER.SALVAGE_VALUES;
    const { rows, total } = appraiseSalvage({ xenon: 2.0, metals: ['TITANIUM', 'COPPER'] });
    assert.equal(rows.length, 3, 'xenon + 2 metals');
    const expected = Math.round(2.0 * V.XENON_PER_KG) + 2 * V.METAL_BASE;
    assert.equal(total, expected);
  });

  it('empty / missing salvage appraises to zero', () => {
    assert.equal(appraiseSalvage(null).total, 0);
    assert.equal(appraiseSalvage({}).total, 0);
  });
});
