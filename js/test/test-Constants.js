/**
 * Constants validation tests — verify structural integrity of Constants.js.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

describe('Constants - Integrity', () => {
    
    it('SCENE_SCALE is valid positive number', () => {
        assert.isType(Constants.SCENE_SCALE, 'number');
        assert.ok(Constants.SCENE_SCALE > 0, 'SCENE_SCALE must be positive');
    });
    
    it('altitude range is ordered: VLEO_MIN < VLEO_MAX', () => {
        assert.ok(Constants.VLEO_MIN < Constants.VLEO_MAX, 
            `VLEO_MIN (${Constants.VLEO_MIN}) should be < VLEO_MAX (${Constants.VLEO_MAX})`);
    });
    
    it('tether lengths are ordered: LASSO < SPINNER < WEAVER', () => {
        assert.ok(Constants.LASSO_RANGE < Constants.SPINNER_TETHER_LENGTH,
            `LASSO_RANGE (${Constants.LASSO_RANGE}) should be < SPINNER (${Constants.SPINNER_TETHER_LENGTH})`);
        assert.ok(Constants.SPINNER_TETHER_LENGTH < Constants.WEAVER_TETHER_LENGTH,
            `SPINNER (${Constants.SPINNER_TETHER_LENGTH}) should be < WEAVER (${Constants.WEAVER_TETHER_LENGTH})`);
    });
    
    it('START_ALTITUDE_KM × SCENE_SCALE ≈ START_ALTITUDE', () => {
        const computed = Constants.START_ALTITUDE_KM * Constants.SCENE_SCALE;
        assert.closeTo(computed, Constants.START_ALTITUDE, 0.01,
            `${Constants.START_ALTITUDE_KM} × ${Constants.SCENE_SCALE} = ${computed}, expected ${Constants.START_ALTITUDE}`);
    });
    
    it('NAVSPHERE constants exist and are valid', () => {
        assert.ok(Constants.NAVSPHERE, 'NAVSPHERE block should exist');
        assert.ok(Constants.NAVSPHERE.INNER_ZONE_KM > 0, 'INNER_ZONE_KM must be positive');
        assert.ok(Constants.NAVSPHERE.ZONE_SPLIT > 0 && Constants.NAVSPHERE.ZONE_SPLIT < 1,
            'ZONE_SPLIT must be between 0 and 1');
        assert.ok(Constants.NAVSPHERE.DOT_MIN_PX < Constants.NAVSPHERE.DOT_MAX_PX,
            'DOT_MIN_PX must be < DOT_MAX_PX');
    });
    
    it('DEBUG block exists with LOG_RENDERER_DIAGNOSTICS off by default (PR 5 / P2.10)', () => {
        assert.ok(Constants.DEBUG, 'DEBUG block should exist');
        assert.equal(Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS, false,
            'LOG_RENDERER_DIAGNOSTICS must be false by default (enable per-session via ?debug=1)');
    });

    it('TRAWLING constants exist and are valid', () => {
        assert.ok(Constants.TRAWLING, 'TRAWLING block should exist');
        assert.ok(Constants.TRAWLING.SPEED_MIN < Constants.TRAWLING.SPEED_MAX,
            'SPEED_MIN must be < SPEED_MAX');
        assert.ok(Constants.TRAWLING.SPEED_ADAPT_UP > 1, 'Speed up multiplier should be > 1');
        assert.ok(Constants.TRAWLING.SPEED_ADAPT_DOWN < 1, 'Speed down multiplier should be < 1');
    });
    
    it('FORGE phase times exist and total > 0', () => {
        assert.ok(Constants.FORGE, 'FORGE block should exist');
        const pt = Constants.FORGE.PHASE_TIMES;
        assert.ok(pt, 'PHASE_TIMES should exist');
        const total = Object.values(pt).reduce((sum, v) => sum + v, 0);
        assert.ok(total > 0, `Total phase time should be > 0, got ${total}`);
    });
    
    it('no undefined in critical constants', () => {
        const critical = [
            'SCENE_SCALE', 'START_ALTITUDE', 'START_ALTITUDE_KM',
            'LASSO_RANGE', 'SPINNER_TETHER_LENGTH', 'WEAVER_TETHER_LENGTH',
            'MU_EARTH', 'EARTH_RADIUS_KM',
        ];
        for (const key of critical) {
            assert.notEqual(Constants[key], undefined, `Constants.${key} should not be undefined`);
        }
    });
    
    it('EARTH_RADIUS ≈ EARTH_RADIUS_KM × SCENE_SCALE', () => {
        const computed = Constants.EARTH_RADIUS_KM * Constants.SCENE_SCALE;
        assert.closeTo(computed, Constants.EARTH_RADIUS, 0.01,
            `${Constants.EARTH_RADIUS_KM} × ${Constants.SCENE_SCALE} = ${computed}, expected ${Constants.EARTH_RADIUS}`);
    });

    // PR 3 / P1.7 — PERF namespace + frame cap default
    it('PERF namespace exists', () => {
        assert.ok(Constants.PERF, 'Constants.PERF block should exist');
        assert.equal(typeof Constants.PERF, 'object');
    });

    it('PERF.FRAME_CAP exists and defaults to null (no cap)', () => {
        assert.ok('FRAME_CAP' in Constants.PERF,
            'Constants.PERF.FRAME_CAP must be defined (use null for no cap)');
        assert.equal(Constants.PERF.FRAME_CAP, null,
            `FRAME_CAP default must be null (got ${Constants.PERF.FRAME_CAP}). ` +
            'Hard-capping to 60 on 120/144 Hz displays causes judder.');
    });
});

// ============================================================================
// ST-6.1: CATALOG + DEBRIS namespaces
// ============================================================================
describe('Constants - CATALOG namespace (ST-6.1)', () => {

    it('CATALOG block exists with 4 fields', () => {
        assert.ok(Constants.CATALOG, 'Constants.CATALOG must be defined');
        assert.equal(typeof Constants.CATALOG.BASE_PATH, 'string');
        assert.equal(typeof Constants.CATALOG.META_FILE, 'string');
        assert.equal(typeof Constants.CATALOG.LOAD_TIMEOUT_MS, 'number');
        assert.equal(typeof Constants.CATALOG.MAX_PARALLEL_FETCHES, 'number');
    });

    it('CATALOG.BASE_PATH ends with a separator', () => {
        assert.ok(/\/$/.test(Constants.CATALOG.BASE_PATH),
            `BASE_PATH "${Constants.CATALOG.BASE_PATH}" should end with "/"`);
    });

    it('CATALOG.LOAD_TIMEOUT_MS is a sane positive number', () => {
        assert.ok(Constants.CATALOG.LOAD_TIMEOUT_MS >= 1000);
        assert.ok(Constants.CATALOG.LOAD_TIMEOUT_MS <= 60000);
    });

    it('CATALOG.META_FILE points at META.json', () => {
        assert.ok(/META\.json$/i.test(Constants.CATALOG.META_FILE));
    });
});

describe('Constants - DEBRIS namespace (ST-6.1: 7-band ALT_BANDS)', () => {
    it('DEBRIS block exists', () => {
        assert.ok(Constants.DEBRIS, 'Constants.DEBRIS must be defined');
    });

    it('INTERACTIVE_COUNT + BACKGROUND_COUNT are positive integers', () => {
        assert.ok(Number.isInteger(Constants.DEBRIS.INTERACTIVE_COUNT));
        assert.ok(Constants.DEBRIS.INTERACTIVE_COUNT > 0);
        assert.ok(Number.isInteger(Constants.DEBRIS.BACKGROUND_COUNT));
        assert.ok(Constants.DEBRIS.BACKGROUND_COUNT > 0);
    });

    it('ALT_BANDS extended to 7 bands (VLEO + LEO-* + MEO + GEO)', () => {
        const bands = Constants.DEBRIS.ALT_BANDS;
        assert.ok(Array.isArray(bands));
        assert.equal(bands.length, 7, `expected 7 bands, got ${bands.length}`);
    });

    it('each ALT_BANDS entry has { min, max, weight } with min<max and positive weight', () => {
        for (const b of Constants.DEBRIS.ALT_BANDS) {
            assert.equal(typeof b.min, 'number');
            assert.equal(typeof b.max, 'number');
            assert.equal(typeof b.weight, 'number');
            assert.ok(b.min < b.max, `band ${JSON.stringify(b)} must have min<max`);
            assert.ok(b.weight > 0, `band ${JSON.stringify(b)} must have positive weight`);
        }
    });

    it('ALT_BANDS weights sum to ~1.0 (±0.02)', () => {
        const total = Constants.DEBRIS.ALT_BANDS.reduce((s, b) => s + b.weight, 0);
        assert.closeTo(total, 1.0, 0.02, `weights sum ${total.toFixed(3)} ≉ 1.0`);
    });

    it('a VLEO band with min<400 exists (ISS-altitude coverage)', () => {
        const hasVLEO = Constants.DEBRIS.ALT_BANDS.some(b => b.min < 400);
        assert.ok(hasVLEO, 'at least one band must cover VLEO (<400 km)');
    });

    it('a MEO band with min≥2000 exists (GPS/Galileo/GLONASS coverage)', () => {
        const hasMEO = Constants.DEBRIS.ALT_BANDS.some(b => b.min >= 2000);
        assert.ok(hasMEO, 'at least one band must cover MEO (≥2000 km)');
    });
});

// ============================================================================
// ST-6.3: CONJUNCTION MOID namespace
// ============================================================================
describe('Constants - CONJUNCTION MOID namespace (ST-6.3)', () => {

    it('CONJUNCTION block exists with all ST-6.3 MOID fields (≥14 fields)', () => {
        const C = Constants.CONJUNCTION;
        assert.ok(C, 'Constants.CONJUNCTION must be defined');
        // Count all fields
        const keys = Object.keys(C);
        assert.ok(keys.length >= 14, `expected ≥14 fields, got ${keys.length}: ${keys.join(', ')}`);
    });

    it('MOID threshold ordering: HI < MD < LO', () => {
        const C = Constants.CONJUNCTION;
        assert.ok(C.MOID_HI_M < C.MOID_MD_M, `MOID_HI_M (${C.MOID_HI_M}) < MOID_MD_M (${C.MOID_MD_M})`);
        assert.ok(C.MOID_MD_M < C.MOID_LO_M, `MOID_MD_M (${C.MOID_MD_M}) < MOID_LO_M (${C.MOID_LO_M})`);
    });

    it('MOID_SAFE_M is Infinity', () => {
        assert.equal(Constants.CONJUNCTION.MOID_SAFE_M, Infinity);
    });

    it('badge colours are non-empty hex strings', () => {
        const C = Constants.CONJUNCTION;
        const hexRe = /^#[0-9a-fA-F]{3,8}$/;
        assert.ok(hexRe.test(C.BADGE_COLOR_HI), `BADGE_COLOR_HI (${C.BADGE_COLOR_HI}) must be hex`);
        assert.ok(hexRe.test(C.BADGE_COLOR_MD), `BADGE_COLOR_MD (${C.BADGE_COLOR_MD}) must be hex`);
        assert.ok(hexRe.test(C.BADGE_COLOR_LO), `BADGE_COLOR_LO (${C.BADGE_COLOR_LO}) must be hex`);
    });

    it('badge labels are HI/MD/LO strings', () => {
        const C = Constants.CONJUNCTION;
        assert.equal(C.BADGE_LABEL_HI, 'HI');
        assert.equal(C.BADGE_LABEL_MD, 'MD');
        assert.equal(C.BADGE_LABEL_LO, 'LO');
    });

    it('CA speed-up constants are valid', () => {
        const C = Constants.CONJUNCTION;
        assert.ok(C.CA_TOP_N > 0 && Number.isInteger(C.CA_TOP_N), 'CA_TOP_N must be positive integer');
        assert.ok(C.CA_MOID_PREFILTER_M > C.MOID_LO_M, 'CA_MOID_PREFILTER_M should be > MOID_LO_M');
    });

    it('MOID recompute cadence constants exist', () => {
        const C = Constants.CONJUNCTION;
        assert.ok(C.MOID_RECOMPUTE_INTERVAL_S > 0, 'MOID_RECOMPUTE_INTERVAL_S must be positive');
        assert.ok(C.MOID_COARSE_SAMPLES >= 4, 'MOID_COARSE_SAMPLES must be ≥ 4');
        assert.ok(C.MOID_REFINE_SAMPLES >= 4, 'MOID_REFINE_SAMPLES must be ≥ 4');
    });

    it('existing gating fields (MIN_CAPTURES, MIN_ELAPSED_S, PRIMER_LEAD_S) still present', () => {
        const C = Constants.CONJUNCTION;
        assert.equal(typeof C.MIN_CAPTURES, 'number');
        assert.equal(typeof C.MIN_ELAPSED_S, 'number');
        assert.equal(typeof C.PRIMER_LEAD_S, 'number');
    });
});

// ============================================================================
// ST-6.6: TRL namespace shape (primary tests live in test-TRL.js)
// ============================================================================
// ============================================================================
// ST-6.2: DEBRIS_VISUAL namespace
// ============================================================================
describe('Constants - DEBRIS_VISUAL namespace (ST-6.2)', () => {

    it('DEBRIS_VISUAL block exists with ≥14 fields', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(DV, 'Constants.DEBRIS_VISUAL must be defined');
        const keys = Object.keys(DV);
        assert.ok(keys.length >= 14, `expected ≥14 fields, got ${keys.length}: ${keys.join(', ')}`);
    });

    it('atlas size constants are positive integers', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(Number.isInteger(DV.ATLAS_SIZE) && DV.ATLAS_SIZE > 0);
        assert.ok(Number.isInteger(DV.FLAG_ATLAS_SIZE) && DV.FLAG_ATLAS_SIZE > 0);
        assert.ok(Number.isInteger(DV.FLAG_SLOT_SIZE) && DV.FLAG_SLOT_SIZE > 0);
    });

    it('grid layout constants are positive integers', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(Number.isInteger(DV.TYPE_SLOT_COLS) && DV.TYPE_SLOT_COLS > 0);
        assert.ok(Number.isInteger(DV.TYPE_SLOT_ROWS) && DV.TYPE_SLOT_ROWS > 0);
        assert.ok(Number.isInteger(DV.FLAG_SLOT_COLS) && DV.FLAG_SLOT_COLS > 0);
        assert.ok(Number.isInteger(DV.FLAG_SLOT_ROWS) && DV.FLAG_SLOT_ROWS > 0);
    });

    it('TYPE_SLOT_COLS × TYPE_SLOT_ROWS ≥ 6 (enough for 6 types)', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(DV.TYPE_SLOT_COLS * DV.TYPE_SLOT_ROWS >= 6);
    });

    it('FLAG_SLOT_COLS × FLAG_SLOT_ROWS ≥ 16 (enough for 15 countries + unknown)', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(DV.FLAG_SLOT_COLS * DV.FLAG_SLOT_ROWS >= 16);
    });

    it('all 6 type colour constants are hex strings', () => {
        const DV = Constants.DEBRIS_VISUAL;
        const hexRe = /^#[0-9a-fA-F]{6}$/;
        const colorKeys = [
            'COLOR_DEBRIS', 'COLOR_ROCKET_BODY', 'COLOR_INACTIVE',
            'COLOR_ACTIVE', 'COLOR_UNKNOWN', 'COLOR_FRAGMENT',
        ];
        for (const key of colorKeys) {
            assert.ok(hexRe.test(DV[key]), `${key} "${DV[key]}" must be #RRGGBB hex`);
        }
    });

    it('EMISSIVE intensities are valid numbers in [0, 1]', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(DV.EMISSIVE_HI_INTENSITY > 0 && DV.EMISSIVE_HI_INTENSITY <= 1);
        assert.ok(DV.EMISSIVE_MD_INTENSITY > 0 && DV.EMISSIVE_MD_INTENSITY <= 1);
        assert.ok(DV.EMISSIVE_HI_INTENSITY > DV.EMISSIVE_MD_INTENSITY,
            'HI intensity should exceed MD intensity');
    });

    it('DEFAULT_MODE is "textured" or "wireframe"', () => {
        const DV = Constants.DEBRIS_VISUAL;
        assert.ok(DV.DEFAULT_MODE === 'textured' || DV.DEFAULT_MODE === 'wireframe');
    });
});

describe('Constants - TRL namespace', () => {

    it('TRL block exists', () => {
        assert.ok(Constants.TRL, 'Constants.TRL must be defined');
    });

    it('TRL threshold constants are ordered', () => {
        const T = Constants.TRL;
        assert.ok(T.SPECULATIVE_MIN < T.RESEARCH_MIN, 'SPECULATIVE_MIN < RESEARCH_MIN');
        assert.ok(T.RESEARCH_MIN    < T.MATURE_MIN,   'RESEARCH_MIN < MATURE_MIN');
        assert.ok(T.MATURE_MIN      < T.FLIGHT_PROVEN_MIN + 1, 'MATURE_MIN < FLIGHT_PROVEN_MIN (inclusive boundary)');
        assert.equal(T.MIN_VALID, 1);
        assert.equal(T.MAX_VALID, 9);
    });

    it('TRL colour constants are non-empty hex strings', () => {
        const T = Constants.TRL;
        const hexRe = /^#[0-9a-fA-F]{3,8}$/;
        assert.ok(hexRe.test(T.COLOR_FLIGHT_PROVEN), `COLOR_FLIGHT_PROVEN (${T.COLOR_FLIGHT_PROVEN}) must be hex`);
        assert.ok(hexRe.test(T.COLOR_MATURE),        `COLOR_MATURE (${T.COLOR_MATURE}) must be hex`);
        assert.ok(hexRe.test(T.COLOR_RESEARCH),      `COLOR_RESEARCH (${T.COLOR_RESEARCH}) must be hex`);
        assert.ok(hexRe.test(T.COLOR_SPECULATIVE),   `COLOR_SPECULATIVE (${T.COLOR_SPECULATIVE}) must be hex`);
    });

    it('TRL label constants are non-empty strings', () => {
        const T = Constants.TRL;
        assert.ok(typeof T.LABEL_FLIGHT_PROVEN === 'string' && T.LABEL_FLIGHT_PROVEN.length > 0);
        assert.ok(typeof T.LABEL_MATURE        === 'string' && T.LABEL_MATURE.length > 0);
        assert.ok(typeof T.LABEL_RESEARCH      === 'string' && T.LABEL_RESEARCH.length > 0);
        assert.ok(typeof T.LABEL_SPECULATIVE   === 'string' && T.LABEL_SPECULATIVE.length > 0);
    });
});

// ============================================================================
// ST-6.5: TEACHING namespace
// ============================================================================
describe('Constants - TEACHING namespace (ST-6.5)', () => {

    it('TEACHING block exists with ≥12 fields', () => {
        const T = Constants.TEACHING;
        assert.ok(T, 'Constants.TEACHING must be defined');
        const keys = Object.keys(T);
        assert.ok(keys.length >= 12, `expected ≥12 fields, got ${keys.length}: ${keys.join(', ')}`);
    });

    it('overlay dimension constants are valid positive numbers', () => {
        const T = Constants.TEACHING;
        assert.ok(T.OVERLAY_WIDTH_PX > 0, 'OVERLAY_WIDTH_PX must be positive');
        assert.ok(T.OVERLAY_MIN_WIDTH_PX > 0, 'OVERLAY_MIN_WIDTH_PX must be positive');
        assert.ok(T.OVERLAY_MIN_WIDTH_PX < T.OVERLAY_WIDTH_PX, 'min < max width');
        assert.ok(T.OVERLAY_TOP_MARGIN_PX >= 0, 'OVERLAY_TOP_MARGIN_PX must be ≥0');
    });

    it('colour constants are non-empty strings', () => {
        const T = Constants.TEACHING;
        assert.ok(typeof T.OVERLAY_BG === 'string' && T.OVERLAY_BG.length > 0);
        assert.ok(typeof T.OVERLAY_BORDER_COLOR === 'string' && T.OVERLAY_BORDER_COLOR.length > 0);
        assert.ok(typeof T.OVERLAY_TITLE_COLOR === 'string' && T.OVERLAY_TITLE_COLOR.length > 0);
        assert.ok(typeof T.OVERLAY_BODY_COLOR === 'string' && T.OVERLAY_BODY_COLOR.length > 0);
    });

    it('fade timing constants are positive', () => {
        const T = Constants.TEACHING;
        assert.ok(T.FADE_IN_MS > 0, 'FADE_IN_MS must be positive');
        assert.ok(T.FADE_OUT_MS > 0, 'FADE_OUT_MS must be positive');
    });

    it('queue depth and duration are valid', () => {
        const T = Constants.TEACHING;
        assert.ok(Number.isInteger(T.MAX_QUEUE_DEPTH) && T.MAX_QUEUE_DEPTH > 0);
        assert.ok(T.DEFAULT_DURATION_MS > 0, 'DEFAULT_DURATION_MS must be positive');
    });

    it('persistence key is a non-empty string', () => {
        const T = Constants.TEACHING;
        assert.ok(typeof T.PERSISTENCE_KEY === 'string' && T.PERSISTENCE_KEY.length > 0);
    });

    it('TOTAL_MOMENTS is 19', () => {
        assert.equal(Constants.TEACHING.TOTAL_MOMENTS, 19);
    });
});

// ============================================================================
// ST-6.7: ENVIRONMENT namespace
// ============================================================================
describe('Constants - ENVIRONMENT namespace (ST-6.7)', () => {

    it('ENVIRONMENT block exists', () => {
        assert.ok(Constants.ENVIRONMENT, 'Constants.ENVIRONMENT must be defined');
    });

    it('Atomic Oxygen fields are valid', () => {
        const E = Constants.ENVIRONMENT;
        assert.equal(typeof E.AO_THRESHOLD_KM, 'number');
        assert.ok(E.AO_THRESHOLD_KM > 0, 'AO_THRESHOLD_KM must be positive');
        assert.equal(typeof E.AO_TICK_INTERVAL_S, 'number');
        assert.ok(E.AO_TICK_INTERVAL_S > 0);
        assert.equal(typeof E.AO_ARM_DEGRADATION, 'number');
        assert.ok(E.AO_ARM_DEGRADATION > 0 && E.AO_ARM_DEGRADATION < 1);
        assert.equal(typeof E.AO_PANEL_DEGRADATION, 'number');
        assert.ok(E.AO_PANEL_DEGRADATION > 0 && E.AO_PANEL_DEGRADATION < 1);
        assert.equal(typeof E.AO_SKILL_MITIGATION, 'number');
        assert.ok(E.AO_SKILL_MITIGATION > 0 && E.AO_SKILL_MITIGATION <= 1);
    });

    it('MMOD fields are valid', () => {
        const E = Constants.ENVIRONMENT;
        assert.equal(typeof E.MMOD_CHECK_INTERVAL_S, 'number');
        assert.ok(E.MMOD_CHECK_INTERVAL_S > 0);
        assert.equal(typeof E.MMOD_BASE_PROBABILITY, 'number');
        assert.ok(E.MMOD_BASE_PROBABILITY > 0 && E.MMOD_BASE_PROBABILITY < 1);
        assert.equal(typeof E.MMOD_DAMAGE_FRACTION, 'number');
        assert.ok(E.MMOD_DAMAGE_FRACTION > 0 && E.MMOD_DAMAGE_FRACTION < 1);
        assert.equal(typeof E.MMOD_SUBSYSTEM_WEIGHTS, 'object');
        const w = E.MMOD_SUBSYSTEM_WEIGHTS;
        assert.ok(w.arms && w.sensors && w.comms && w.power, 'All 4 subsystem weights must exist');
        const wSum = w.arms + w.sensors + w.comms + w.power;
        assert.closeTo(wSum, 1.0, 0.01, 'Subsystem weights should sum to 1.0');
        assert.equal(typeof E.MMOD_SKILL_MITIGATION, 'number');
        assert.equal(typeof E.MMOD_WEATHER_AMPLIFIER, 'number');
        assert.ok(E.MMOD_WEATHER_AMPLIFIER > 1, 'Weather amplifier should be > 1');
    });

    it('Safe Mode fields are valid', () => {
        const E = Constants.ENVIRONMENT;
        assert.equal(typeof E.SAFE_MODE_CHECK_INTERVAL_S, 'number');
        assert.ok(E.SAFE_MODE_CHECK_INTERVAL_S > 0);
        assert.equal(typeof E.SAFE_MODE_HEALTH_THRESHOLD, 'number');
        assert.ok(E.SAFE_MODE_HEALTH_THRESHOLD > 0 && E.SAFE_MODE_HEALTH_THRESHOLD < 1);
        assert.equal(typeof E.SAFE_MODE_RECOVERY_THRESHOLD, 'number');
        assert.ok(E.SAFE_MODE_RECOVERY_THRESHOLD > E.SAFE_MODE_HEALTH_THRESHOLD,
            'Recovery threshold must be > health threshold');
        assert.equal(typeof E.SAFE_MODE_SENSOR_PENALTY, 'number');
    });

    it('Radiation Belt fields are valid', () => {
        const E = Constants.ENVIRONMENT;
        assert.equal(typeof E.RADIATION_BELT_LOW_KM, 'number');
        assert.equal(typeof E.RADIATION_BELT_HIGH_KM, 'number');
        assert.ok(E.RADIATION_BELT_HIGH_KM > E.RADIATION_BELT_LOW_KM,
            'HIGH must be > LOW');
        assert.equal(typeof E.RADIATION_SENSOR_PENALTY, 'number');
        assert.equal(typeof E.RADIATION_COMMS_DELAY_S, 'number');
        assert.equal(typeof E.RADIATION_NOISE_INTERVAL_S, 'number');
        assert.equal(typeof E.RADIATION_SKILL_MITIGATION, 'number');
    });

    it('Battery DOD fields are valid', () => {
        const E = Constants.ENVIRONMENT;
        assert.equal(typeof E.DOD_DEEP_DISCHARGE_THRESHOLD, 'number');
        assert.ok(E.DOD_DEEP_DISCHARGE_THRESHOLD > 0 && E.DOD_DEEP_DISCHARGE_THRESHOLD < 1);
        assert.equal(typeof E.DOD_RECHARGE_THRESHOLD, 'number');
        assert.ok(E.DOD_RECHARGE_THRESHOLD > E.DOD_DEEP_DISCHARGE_THRESHOLD,
            'Recharge threshold must be > discharge threshold');
        assert.equal(typeof E.DOD_CYCLE_PENALTY_INTERVAL, 'number');
        assert.ok(Number.isInteger(E.DOD_CYCLE_PENALTY_INTERVAL));
        assert.equal(typeof E.DOD_CAPACITY_LOSS, 'number');
        assert.ok(E.DOD_CAPACITY_LOSS > 0 && E.DOD_CAPACITY_LOSS < 1);
        assert.equal(typeof E.DOD_SKILL_MITIGATION, 'number');
    });

    it('has all ~26 expected fields', () => {
        const E = Constants.ENVIRONMENT;
        const keys = Object.keys(E);
        assert.ok(keys.length >= 25, `Expected ≥25 fields, got ${keys.length}`);
    });
});

// ============================================================================
// ST-6.4: STRATEGIC_MAP namespace
// ============================================================================
describe('Constants - STRATEGIC_MAP namespace (ST-6.4)', () => {

    it('STRATEGIC_MAP block exists', () => {
        assert.ok(Constants.STRATEGIC_MAP, 'Constants.STRATEGIC_MAP must be defined');
    });

    it('camera fields are valid numbers', () => {
        const SM = Constants.STRATEGIC_MAP;
        assert.equal(typeof SM.CAMERA_FOV, 'number');
        assert.equal(typeof SM.CAMERA_NEAR, 'number');
        assert.equal(typeof SM.CAMERA_FAR, 'number');
        assert.equal(typeof SM.CAMERA_INITIAL_DISTANCE, 'number');
        assert.equal(typeof SM.CAMERA_ELEVATION_DEG, 'number');
        assert.equal(typeof SM.CAMERA_TRANSITION_MS, 'number');
    });

    it('zoom limits are ordered', () => {
        const SM = Constants.STRATEGIC_MAP;
        assert.ok(SM.ZOOM_MIN < SM.ZOOM_MAX,
            `ZOOM_MIN (${SM.ZOOM_MIN}) should be < ZOOM_MAX (${SM.ZOOM_MAX})`);
    });

    it('ALT_BAND_COLORS and ALT_BAND_OPACITY match ALT_BANDS count', () => {
        const SM = Constants.STRATEGIC_MAP;
        const bandCount = Constants.DEBRIS.ALT_BANDS.length;
        assert.equal(SM.ALT_BAND_COLORS.length, bandCount);
        assert.equal(SM.ALT_BAND_OPACITY.length, bandCount);
    });

    it('has all expected fields (≥30)', () => {
        const keys = Object.keys(Constants.STRATEGIC_MAP);
        assert.ok(keys.length >= 30, `Expected ≥30 fields, got ${keys.length}`);
    });
});

// ============================================================================
// ST-9.1: OCTOPUS_V5 Block (Epic 9)
// ============================================================================
describe('OCTOPUS_V5 Block (Epic 9 ST-9.1)', () => {

    it('Constants.OCTOPUS_V5 exists and is an object', () => {
        assert.ok(Constants.OCTOPUS_V5, 'OCTOPUS_V5 must be defined');
        assert.equal(typeof Constants.OCTOPUS_V5, 'object');
    });

    it('all listed keys present with expected types', () => {
        const V = Constants.OCTOPUS_V5;
        const numberKeys = [
            'TOTAL_DRY_MASS', 'TOTAL_WET_MASS', 'CORE_DRY_MASS', 'CORE_WET_MASS',
            'WEAVER_MASS', 'SPINNER_MASS', 'FRONT_ARM_MASS', 'BACK_ARM_MASS',
            'ARM_COUNT', 'WEAVER_COUNT', 'SPINNER_COUNT', 'FRONT_ARM_COUNT', 'BACK_ARM_COUNT',
            'CORE_ACROSS_FLATS', 'CORE_LENGTH', 'BACK_ARM_OFFSET',
            'CORE_BATTERY', 'CORE_SOLAR_AREA', 'CORE_SOLAR_POWER',
            'CORE_LASER_POWER', 'CORE_LASER_OPTICAL',
            'CORE_HALL_THRUST', 'CORE_HALL_ISP',
            'TETHER_LENGTH_DEFAULT',
        ];
        for (const key of numberKeys) {
            assert.equal(typeof V[key], 'number', `OCTOPUS_V5.${key} should be a number`);
        }
        assert.equal(typeof V.TETHER_MATERIAL, 'string', 'TETHER_MATERIAL should be a string');
    });

    it('TOTAL_WET_MASS === 242.4, TOTAL_DRY_MASS === 196.4, ARM_COUNT === 4 (Y0 Quad — Config G)', () => {
        const V = Constants.OCTOPUS_V5;
        assert.equal(V.TOTAL_WET_MASS, 242.4);
        assert.equal(V.TOTAL_DRY_MASS, 196.4);
        assert.equal(V.ARM_COUNT, 4);
    });

    it('mass arithmetic: TOTAL_WET_MASS - TOTAL_DRY_MASS ≈ 46 (propellant load)', () => {
        const V = Constants.OCTOPUS_V5;
        const propellant = V.TOTAL_WET_MASS - V.TOTAL_DRY_MASS;
        assert.closeTo(propellant, 46, 0.01,
            `Propellant load ${propellant} should be ≈ 46`);
    });

    it('arm counts sum: WEAVER + SPINNER + FRONT + BACK === ARM_COUNT', () => {
        const V = Constants.OCTOPUS_V5;
        const sum = V.WEAVER_COUNT + V.SPINNER_COUNT + V.FRONT_ARM_COUNT + V.BACK_ARM_COUNT;
        assert.equal(sum, V.ARM_COUNT,
            `Arm sum ${sum} should equal ARM_COUNT ${V.ARM_COUNT}`);
    });

    it('TETHER_MATERIAL === "Dyneema SK78"', () => {
        assert.equal(Constants.OCTOPUS_V5.TETHER_MATERIAL, 'Dyneema SK78');
    });
});

// ============================================================================
// ST-9.1: EPIC 9 FEATURE_FLAGS
// ============================================================================
describe('Epic 9 FEATURE_FLAGS', () => {

    it('Constants.FEATURE_FLAGS is an object', () => {
        assert.ok(Constants.FEATURE_FLAGS, 'FEATURE_FLAGS must be defined');
        assert.equal(typeof Constants.FEATURE_FLAGS, 'object');
    });

    it('every flag exists and is exactly false', () => {
        const flags = [
            'SHIPYARD_REFIT', 'CROSSBOW_MECHANISM', 'DUAL_OPPOSITE_FIRE',
            'NET_TERMINOLOGY', 'NET_PRIMARY_DOCTRINE',
            'NET_CLING_MODEL', 'NET_TANGLE_MECHANICS', 'PER_PLATFORM_NETS',
            'DYNEEMA_TETHER', 'REEL_CYCLE_RESOURCE',
            'ABLATION_MODULE', 'BRIDLE_RING_GEOMETRY',
            'TECH_LADDER_SHOP', 'REALITY_MODE',
            'BRIDLE_RING',
        ];
        for (const flag of flags) {
            assert.equal(Constants.FEATURE_FLAGS[flag], false,
                `FEATURE_FLAGS.${flag} should be false`);
        }
    });

    it('isFeatureEnabled("SHIPYARD_REFIT") returns false', () => {
        assert.equal(Constants.isFeatureEnabled('SHIPYARD_REFIT'), false);
    });

    it('Reality Mode override: isFeatureEnabled returns false even when flag is true', () => {
        // Enable both Reality Mode and a feature flag
        Constants.FEATURE_FLAGS.REALITY_MODE = true;
        Constants.FEATURE_FLAGS.SHIPYARD_REFIT = true;

        assert.equal(Constants.isFeatureEnabled('SHIPYARD_REFIT'), false,
            'isFeatureEnabled should return false when REALITY_MODE is true');

        // Restore defaults
        Constants.FEATURE_FLAGS.REALITY_MODE = false;
        Constants.FEATURE_FLAGS.SHIPYARD_REFIT = false;
    });

    it('isRealityMode() returns false by default', () => {
        assert.equal(Constants.isRealityMode(), false);
    });
});

// ============================================================================
// ST-9.4a: NET_TERMINOLOGY rename + new Capture Net flags
// ============================================================================
describe('ST-9.4a NET_TERMINOLOGY + new flags', () => {

    it('FEATURE_FLAGS has exactly 26 entries', () => {
        assert.equal(Object.keys(Constants.FEATURE_FLAGS).length, 26,
            'Expected 26 FEATURE_FLAGS (14 original + 6 Config G + 1 Capture Net + 1 Tether Reel + 1 Bridle Ring + 1 Tier Upgrades + 1 Recoil Physics + 1 Q2 Net Ceremony)');
    });

    it('BOLA_RENAME is not present (stale flag removed)', () => {
        assert.equal('BOLA_RENAME' in Constants.FEATURE_FLAGS, false,
            'BOLA_RENAME should have been renamed to NET_TERMINOLOGY');
        assert.equal(Constants.FEATURE_FLAGS.BOLA_RENAME, undefined);
    });

    it('NET_CLING_MODEL, NET_TANGLE_MECHANICS, PER_PLATFORM_NETS exist and default false', () => {
        assert.equal(Constants.FEATURE_FLAGS.NET_CLING_MODEL, false,
            'NET_CLING_MODEL should default false');
        assert.equal(Constants.FEATURE_FLAGS.NET_TANGLE_MECHANICS, false,
            'NET_TANGLE_MECHANICS should default false');
        assert.equal(Constants.FEATURE_FLAGS.PER_PLATFORM_NETS, false,
            'PER_PLATFORM_NETS should default false');
    });

    it('Reality Mode override applies to new NET_CLING_MODEL flag', () => {
        Constants.FEATURE_FLAGS.REALITY_MODE = true;
        Constants.FEATURE_FLAGS.NET_CLING_MODEL = true;

        assert.equal(Constants.isFeatureEnabled('NET_CLING_MODEL'), false,
            'isFeatureEnabled should return false when REALITY_MODE is true');

        // Restore defaults
        Constants.FEATURE_FLAGS.REALITY_MODE = false;
        Constants.FEATURE_FLAGS.NET_CLING_MODEL = false;
    });
});

// ============================================================================
// ST-9.2: ARM_LADDER + ARM_COUNT 4 (Y0 Quad baseline)
// ============================================================================
describe('ST-9.2 ARM_LADDER + ARM_COUNT 4', () => {

    it('Constants.OCTOPUS_V5.ARM_COUNT === 4 (Y0 default)', () => {
        assert.equal(Constants.OCTOPUS_V5.ARM_COUNT, 4,
            'ARM_COUNT should be 4 (Y0 Quad baseline)');
    });

    it('Constants.OCTOPUS_V5 mass budget: dry=196.4, wet=242.4 (Y0 Config G)', () => {
        assert.equal(Constants.OCTOPUS_V5.TOTAL_DRY_MASS, 196.4,
            'Y0 TOTAL_DRY_MASS should be 196.4');
        assert.equal(Constants.OCTOPUS_V5.TOTAL_WET_MASS, 242.4,
            'Y0 TOTAL_WET_MASS should be 242.4');
    });

    it('Constants.ARM_LADDER exists and is an object', () => {
        assert.ok(Constants.ARM_LADDER, 'ARM_LADDER must be defined');
        assert.equal(typeof Constants.ARM_LADDER, 'object');
    });

    it('ARM_LADDER.Y0_QUAD.armCount === 4, Y1_HEX.armCount === 6, Y3_OCTO.armCount === 8', () => {
        assert.equal(Constants.ARM_LADDER.Y0_QUAD.armCount, 4);
        assert.equal(Constants.ARM_LADDER.Y1_HEX.armCount, 6);
        assert.equal(Constants.ARM_LADDER.Y3_OCTO.armCount, 8);
    });

    it('Y0 is unlocked by default; Y1 and Y3 are locked', () => {
        assert.equal(Constants.ARM_LADDER.Y0_QUAD.unlocked, true,
            'Y0_QUAD should be unlocked (always true)');
        assert.equal(Constants.ARM_LADDER.Y1_HEX.unlocked, false,
            'Y1_HEX should be locked by default');
        assert.equal(Constants.ARM_LADDER.Y3_OCTO.unlocked, false,
            'Y3_OCTO should be locked by default');
    });

    it('all three tiers have well-formed dry/wet mass matching Config G', () => {
        const Y0 = Constants.ARM_LADDER.Y0_QUAD;
        const Y1 = Constants.ARM_LADDER.Y1_HEX;
        const Y3 = Constants.ARM_LADDER.Y3_OCTO;

        // Y0: dry=196.4, wet=242.4
        assert.equal(Y0.dryMass, 196.4, 'Y0 dryMass');
        assert.equal(Y0.wetMass, 242.4, 'Y0 wetMass');

        // Y1: dry=208.0, wet=254.0
        assert.equal(Y1.dryMass, 208.0, 'Y1 dryMass');
        assert.equal(Y1.wetMass, 254.0, 'Y1 wetMass');

        // Y3: dry=222.0, wet=268.0
        assert.equal(Y3.dryMass, 222.0, 'Y3 dryMass');
        assert.equal(Y3.wetMass, 268.0, 'Y3 wetMass');
    });

    it('propellant load is 46.0 for all tiers (wet - dry)', () => {
        for (const key of ['Y0_QUAD', 'Y1_HEX', 'Y3_OCTO']) {
            const tier = Constants.ARM_LADDER[key];
            const prop = tier.wetMass - tier.dryMass;
            assert.closeTo(prop, 46.0, 0.01,
                `${key} propellant ${prop} should be ≈ 46.0`);
        }
    });

    it('tier numbers are 0, 1, 3', () => {
        assert.equal(Constants.ARM_LADDER.Y0_QUAD.tier, 0);
        assert.equal(Constants.ARM_LADDER.Y1_HEX.tier, 1);
        assert.equal(Constants.ARM_LADDER.Y3_OCTO.tier, 3);
    });

    it('per-type counts match armCount for each tier', () => {
        for (const key of ['Y0_QUAD', 'Y1_HEX', 'Y3_OCTO']) {
            const t = Constants.ARM_LADDER[key];
            const sum = t.weaverCount + t.spinnerCount + t.frontArmCount + t.backArmCount;
            assert.equal(sum, t.armCount,
                `${key} type sum ${sum} should equal armCount ${t.armCount}`);
        }
    });
});

// ============================================================================
// ST-9.2: Config G Dock Geometry — azimuth-based 3-plane layout + antipodal pairs
// Pure math tests (no THREE.js). Validates ARM_LADDER azimuths and pairing.
// ============================================================================
describe('ST-9.2 Config G Dock Geometry (azimuth + antipodal pairs)', () => {

    /**
     * Build unit-direction array from ARM_LADDER azimuth table (degrees).
     * Returns array of { x, z, azDeg }.
     */
    function dockDirsFromAzimuths(azimuths) {
        return azimuths.map(deg => {
            const rad = deg * Math.PI / 180;
            return { x: Math.cos(rad), z: Math.sin(rad), azDeg: deg };
        });
    }

    it('Y0 Quad: 4 ring arms at [60°, 120°, 240°, 300°]', () => {
        const az = Constants.ARM_LADDER.Y0_QUAD.azimuths;
        assert.equal(az.length, 4);
        const docks = dockDirsFromAzimuths(az);
        assert.equal(docks.length, 4);
        // Verify 3-plane layout: arms avoid 0°/180° ROSA plane
        for (const d of docks) {
            assert.ok(d.azDeg !== 0 && d.azDeg !== 180,
                `Arm at ${d.azDeg}° must avoid ROSA plane (0°/180°)`);
        }
    });

    it('Y1 Hex: 6 ring arms at 60° spacing', () => {
        const az = Constants.ARM_LADDER.Y1_HEX.azimuths;
        assert.equal(az.length, 6);
        for (let i = 1; i < az.length; i++) {
            const gap = az[i] - az[i - 1];
            assert.closeTo(gap, 60, 0.1,
                `Gap between ${az[i - 1]}° and ${az[i]}° should be 60°`);
        }
    });

    it('Y3 Octo: 6 ring + 2 end-face = armCount 8', () => {
        const tier = Constants.ARM_LADDER.Y3_OCTO;
        assert.equal(tier.armCount, 8);
        assert.equal(tier.azimuths.length, 6, '6 ring azimuths');
        assert.ok(Array.isArray(tier.endFaceArms), 'endFaceArms must exist');
        assert.equal(tier.endFaceArms.length, 2, '2 end-face arms');
    });

    it('Y0 Quad: every arm has an antipodal partner (azimuth + 180°)', () => {
        const az = Constants.ARM_LADDER.Y0_QUAD.azimuths;
        const docks = dockDirsFromAzimuths(az);
        for (let i = 0; i < docks.length; i++) {
            const targetAz = (docks[i].azDeg + 180) % 360;
            const found = docks.some((d, j) => j !== i && Math.abs(d.azDeg - targetAz) < 0.1);
            assert.ok(found, `Arm at ${docks[i].azDeg}° must have antipodal at ${targetAz}°`);
        }
    });

    it('Y1 Hex: every arm has an antipodal partner', () => {
        const az = Constants.ARM_LADDER.Y1_HEX.azimuths;
        const docks = dockDirsFromAzimuths(az);
        for (let i = 0; i < docks.length; i++) {
            const targetAz = (docks[i].azDeg + 180) % 360;
            const found = docks.some((d, j) => j !== i && Math.abs(d.azDeg - targetAz) < 0.1);
            assert.ok(found, `Arm at ${docks[i].azDeg}° must have antipodal at ${targetAz}°`);
        }
    });

    it('Y3 Octo ring arms: every arm has an antipodal partner', () => {
        const az = Constants.ARM_LADDER.Y3_OCTO.azimuths;
        const docks = dockDirsFromAzimuths(az);
        for (let i = 0; i < docks.length; i++) {
            const targetAz = (docks[i].azDeg + 180) % 360;
            const found = docks.some((d, j) => j !== i && Math.abs(d.azDeg - targetAz) < 0.1);
            assert.ok(found, `Ring arm at ${docks[i].azDeg}° must have antipodal at ${targetAz}°`);
        }
    });

    it('Y3 Octo end-face arms form an antipodal pair (+Z ↔ −Z)', () => {
        const ef = Constants.ARM_LADDER.Y3_OCTO.endFaceArms;
        assert.ok(ef.includes('+Z'), '+Z face arm');
        assert.ok(ef.includes('-Z'), '-Z face arm');
    });
});

// ============================================================================
// ST-9.1: Config G Constants — barrel-axial rewrite validation
// ============================================================================
describe('Config G Constants (ST-9.1)', () => {

    it('OCTOPUS_V5.COLLAR_Y === 0.90', () => {
        assert.equal(Constants.OCTOPUS_V5.COLLAR_Y, 0.90);
    });

    it('OCTOPUS_V5.COLLAR_RADIUS === 0.40', () => {
        assert.equal(Constants.OCTOPUS_V5.COLLAR_RADIUS, 0.40);
    });

    it('OCTOPUS_V5.CORE_ASPECT_RATIO === 2.5', () => {
        assert.equal(Constants.OCTOPUS_V5.CORE_ASPECT_RATIO, 2.5);
    });

    it('OCTOPUS_V5.STRUT_LENGTH === 1.60', () => {
        assert.equal(Constants.OCTOPUS_V5.STRUT_LENGTH, 1.60);
    });

    it('OCTOPUS_V5.STRUT_SWEEP_MAX === Math.PI', () => {
        assert.equal(Constants.OCTOPUS_V5.STRUT_SWEEP_MAX, Math.PI);
    });

    it('OCTOPUS_V5.STRUT_SLEW_RATE ≈ 15°/s in radians', () => {
        assert.closeTo(Constants.OCTOPUS_V5.STRUT_SLEW_RATE, 15 * Math.PI / 180, 0.0001);
    });

    it('OCTOPUS_V5.ARM_PLANE_OFFSET === Math.PI/3', () => {
        assert.equal(Constants.OCTOPUS_V5.ARM_PLANE_OFFSET, Math.PI / 3);
    });

    it('OCTOPUS_V5.TOTAL_SOLAR_POWER === 2450', () => {
        assert.equal(Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER, 2450);
    });

    it('OCTOPUS_V5.ROSA_POWER + BODY_MOUNT_POWER === TOTAL_SOLAR_POWER', () => {
        const V = Constants.OCTOPUS_V5;
        assert.equal(V.ROSA_POWER + V.BODY_MOUNT_POWER, V.TOTAL_SOLAR_POWER,
            `${V.ROSA_POWER} + ${V.BODY_MOUNT_POWER} should equal ${V.TOTAL_SOLAR_POWER}`);
    });

    it('OCTOPUS_V5.HINGE_LOCK_TORQUE === 1000', () => {
        assert.equal(Constants.OCTOPUS_V5.HINGE_LOCK_TORQUE, 1000);
    });

    it('OCTOPUS_V5.HINGE_MOTOR_TORQUE === 10', () => {
        assert.equal(Constants.OCTOPUS_V5.HINGE_MOTOR_TORQUE, 10);
    });

    it('OCTOPUS_V5.HINGE_BEARING === "Si3N4_MoS2"', () => {
        assert.equal(Constants.OCTOPUS_V5.HINGE_BEARING, 'Si3N4_MoS2');
    });

    it('OCTOPUS_V5.LAUNCH_VEHICLE === "SSLV"', () => {
        assert.equal(Constants.OCTOPUS_V5.LAUNCH_VEHICLE, 'SSLV');
    });

    it('OCTOPUS_V5.FAIRING_DIAMETER === 2.1', () => {
        assert.equal(Constants.OCTOPUS_V5.FAIRING_DIAMETER, 2.1);
    });

    it('OCTOPUS_V5.STOWED_ENVELOPE_DIA fits inside fairing', () => {
        const V = Constants.OCTOPUS_V5;
        assert.ok(V.STOWED_ENVELOPE_DIA < V.FAIRING_DIAMETER,
            `Stowed dia ${V.STOWED_ENVELOPE_DIA} must be < fairing ${V.FAIRING_DIAMETER}`);
    });

    it('OCTOPUS_V5.CORE_DRY_MASS === 161.0 (Config G bus)', () => {
        assert.equal(Constants.OCTOPUS_V5.CORE_DRY_MASS, 161.0);
    });

    it('DEPLOY_STATES exists with exactly 5 states', () => {
        assert.ok(Constants.DEPLOY_STATES, 'DEPLOY_STATES must be defined');
        const keys = Object.keys(Constants.DEPLOY_STATES);
        assert.equal(keys.length, 5, `Expected 5 deploy states, got ${keys.length}`);
        assert.equal(Constants.DEPLOY_STATES.LOCKED, 'LOCKED');
        assert.equal(Constants.DEPLOY_STATES.STOWED, 'STOWED');
        assert.equal(Constants.DEPLOY_STATES.DEPLOYING, 'DEPLOYING');
        assert.equal(Constants.DEPLOY_STATES.DEPLOYED, 'DEPLOYED');
        assert.equal(Constants.DEPLOY_STATES.STOWING, 'STOWING');
    });

    it('HINGE_STATES exists with exactly 2 states', () => {
        assert.ok(Constants.HINGE_STATES, 'HINGE_STATES must be defined');
        const keys = Object.keys(Constants.HINGE_STATES);
        assert.equal(keys.length, 2, `Expected 2 hinge states, got ${keys.length}`);
        assert.equal(Constants.HINGE_STATES.ROTATE, 'ROTATE');
        assert.equal(Constants.HINGE_STATES.LOCKED, 'LOCKED');
    });

    it('new Config G FEATURE_FLAGS all default false', () => {
        const newFlags = [
            'STOW_DEPLOY_STATE_MACHINE', 'LAUNCH_SEQUENCE',
            'COM_TRACKING', 'THRUSTER_INTERLOCK',
            'SEMI_AUTO_AIM', 'LOCKABLE_HINGE',
        ];
        for (const flag of newFlags) {
            assert.equal(Constants.FEATURE_FLAGS[flag], false,
                `FEATURE_FLAGS.${flag} should be false`);
        }
    });

    it('PLUME_HALF_ANGLE ≈ 35° in radians', () => {
        assert.closeTo(Constants.PLUME_HALF_ANGLE, 35 * Math.PI / 180, 0.0001);
    });

    it('COM thresholds: BALANCED < DRIFT_WARN', () => {
        assert.ok(Constants.COM_BALANCED_THRESHOLD < Constants.COM_DRIFT_WARN_THRESHOLD,
            `BALANCED (${Constants.COM_BALANCED_THRESHOLD}) must be < DRIFT_WARN (${Constants.COM_DRIFT_WARN_THRESHOLD})`);
    });

    it('Launch sequence constants exist', () => {
        assert.equal(Constants.LAUNCH_SEQUENCE_ENABLED, true);
        assert.equal(Constants.LAUNCH_PYRO_DELAY, 40);
        assert.equal(Constants.LAUNCH_LOCK_COUNT, 3);
        assert.equal(Constants.PYRO_PIN_MASS, 0.005);
    });

    it('ARM_LADDER.Y0_QUAD has azimuths array [60, 120, 240, 300]', () => {
        const az = Constants.ARM_LADDER.Y0_QUAD.azimuths;
        assert.ok(Array.isArray(az), 'azimuths must be an array');
        assert.equal(az.length, 4);
        assert.equal(az[0], 60);
        assert.equal(az[1], 120);
        assert.equal(az[2], 240);
        assert.equal(az[3], 300);
    });

    it('ARM_LADDER.Y1_HEX has azimuths array with 6 entries', () => {
        const az = Constants.ARM_LADDER.Y1_HEX.azimuths;
        assert.ok(Array.isArray(az), 'azimuths must be an array');
        assert.equal(az.length, 6);
    });

    it('ARM_LADDER.Y3_OCTO has endFaceArms ["+Z", "-Z"]', () => {
        const ef = Constants.ARM_LADDER.Y3_OCTO.endFaceArms;
        assert.ok(Array.isArray(ef), 'endFaceArms must be an array');
        assert.equal(ef.length, 2);
        assert.equal(ef[0], '+Z');
        assert.equal(ef[1], '-Z');
    });
});
