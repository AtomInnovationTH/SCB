/**
 * test-GuidanceHotkeyDrift.js — guidance ⇄ hotkey drift guard.
 *
 * Scans the new-player guidance surfaces (onboarding beats, teaching moments,
 * mission-coach beat tables, arm-idle hints, and the skills catalog key glyphs)
 * for references to keys that were FREED or MOVED in the 2026-06-14 hotkey
 * revamp. Catches the class of regression where a hotkey is re-bound but the
 * guidance copy that names it is left stale.
 *
 * Canonical bindings (InputManager / HotkeyOverlay) at the time of writing:
 *   wide scan = Shift+S (W freed) · target = T (Tab alias only) ·
 *   pilot daughter = 1-4 (P/Shift+P removed) · forge = F (5/F4 retired) ·
 *   map = M (backtick alias only) · struts = . (comma freed) ·
 *   return-to-mother = re-press digit / Esc / V (7 retired) ·
 *   de-spin laser = L (was H; H freed) · Info/Codex = I (was L) — 2026-06-15.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { ONBOARDING_BEATS } from '../systems/OnboardingDirector.js';
import { TEACHING_MOMENTS } from '../systems/TeachingSystem.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const _HERE = dirname(fileURLToPath(import.meta.url));
const _JS_ROOT = resolve(_HERE, '..');
const readSrc = (rel) => readFileSync(resolve(_JS_ROOT, rel), 'utf8');

// Collect every player-facing string from a guidance beat / moment.
function beatStrings(b) {
  return [b.commsText, b.commsAck, b.text, b.escalationText, b.noContactNudge,
          b.farNudge, b.netEmptyComms, b.body, b.title, b.glyph]
    .filter(s => typeof s === 'string');
}

// Forbidden substrings → human-readable reason. Case-insensitive where noted.
// These are tuned to avoid false positives (e.g. plain "W" or "5" inside prose):
// each pattern targets the imperative "press X" / glyph / bracketed-key forms
// the guidance actually uses.
const FORBIDDEN = [
  { re: /\bpress w\b/i,             why: 'wide scan moved to Shift+S (W freed)' },
  { re: /\bpress tab\b/i,           why: 'target cycle is taught as T (Tab is alias-only)' },
  { re: /\bpress p\b/i,             why: 'P/Shift+P removed — pilot with 1-4' },
  { re: /\bpress 5\b/i,             why: 'Forge moved to F (5 retired)' },
  { re: /\b5 to forge\b/i,          why: 'Forge moved to F (5 retired)' },
  { re: /\[5\]/,                    why: 'Forge moved to F (5 retired)' },
  { re: /\bpress 7\b/i,             why: 'return-to-mother is re-press digit / Esc / V (7 retired)' },
  { re: /\bF4\b/,                   why: 'Forge no longer on F4' },
  { re: /\bWASD\b/,                 why: 'WASD daughter thrust removed — arrow keys steer' },
  // 2026-06-15 remap: de-spin laser H → L; Codex/Info L → I.
  { re: /\bhold h\b/i,             why: 'de-spin laser moved to L (H freed) — 2026-06-15' },
  { re: /de-spin \(h\)/i,          why: 'de-spin laser is L, not H — 2026-06-15' },
  { re: /\bpress l\b/i,            why: 'Info/Codex moved to I (L is the de-spin laser) — 2026-06-15' },
];

function scan(label, strings, problems) {
  for (const s of strings) {
    for (const f of FORBIDDEN) {
      if (f.re.test(s)) {
        problems.push(`${label}: "${s}" — ${f.why}`);
      }
    }
  }
}

describe('Guidance ⇄ hotkey drift guard (2026-06-14 revamp)', () => {
  it('onboarding beats name no freed/moved keys', () => {
    const problems = [];
    for (const b of ONBOARDING_BEATS) scan(`onboarding:${b.id}`, beatStrings(b), problems);
    assert.equal(problems.length, 0, problems.join('\n'));
  });

  it('teaching moments name no freed/moved keys', () => {
    const problems = [];
    for (const m of TEACHING_MOMENTS) scan(`teaching:${m.id}`, beatStrings(m), problems);
    assert.equal(problems.length, 0, problems.join('\n'));
  });

  it('mission-coach beat tables name no freed/moved keys', () => {
    const problems = [];
    const byMission = Constants.MISSION_COACH?.BEATS_BY_MISSION || {};
    for (const mission of Object.keys(byMission)) {
      for (const b of byMission[mission]) {
        scan(`coach:m${mission}:${b.id}`, beatStrings(b), problems);
      }
    }
    assert.equal(problems.length, 0, problems.join('\n'));
  });

  it('arm-idle hints name no freed/moved keys', () => {
    const problems = [];
    for (const h of (Constants.ARM_IDLE_HINTS || [])) {
      scan(`idle:${h.hintId}`, [h.text, h.title], problems);
    }
    const pilot = Constants.ARM_PILOT_IDLE;
    if (pilot) scan(`idle:${pilot.hintId}`, [pilot.text, pilot.title], problems);
    assert.equal(problems.length, 0, problems.join('\n'));
  });

  it('skills-catalog key glyphs match the post-revamp bindings', () => {
    const expected = {
      arm_struts: '.', scan_wide: 'Shift+S', nav_target: 'T',
      arm_pilot: '1-4', strategic_map: 'M', manage_power: 'Shift+1/2/3',
      manage_forge: 'F', manage_codex: 'I',
    };
    const byId = new Map((Constants.SKILLS?.CATALOG || []).map(s => [s.id, s]));
    for (const [id, key] of Object.entries(expected)) {
      const def = byId.get(id);
      assert.ok(def, `catalog has ${id}`);
      assert.equal(def.key, key, `${id} key glyph is "${key}" (was stale)`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UI-panel guidance scan (2026-06-16). The HUD/shop panels build DOM at
// runtime, so the data-import scan above never saw their on-screen strings —
// which is exactly where the stale-key promises hid ("[M] to arm burst mode",
// "[M] Toggle", "[T] Xenon", "5 to forge"). Scan the source text directly so a
// future re-bind that leaves these panels stale fails loudly here too.
//
// Each entry asserts that a corrected source file no longer contains a banned
// substring tied to a key that moved.
// ───────────────────────────────────────────────────────────────────────────
const UI_BANNED = [
  { file: 'ui/ShopScreen.js',          bad: ['[M] to arm', 'arm burst mode'],
    why: 'M is the Debris Map; MPD is a passive thrust upgrade with no hotkey' },
  { file: 'ui/OrbitMFD.js',            bad: ['[M] Toggle'],
    why: 'M opens the Debris Map; the Orbit MFD has no toggle key' },
  { file: 'ui/hud/StatusPanel.js',     bad: ['[T] Xenon', '[T] ${fuelData.name}'],
    why: 'T = Target debris; fuel has no cycle hotkey' },
  { file: 'ui/hud/NetInventoryPanel.js', bad: ['5 to forge'],
    why: 'Forge moved to F (5 = City names)' },
];

describe('Guidance ⇄ hotkey drift guard — UI panels (2026-06-16)', () => {
  for (const { file, bad, why } of UI_BANNED) {
    it(`${file} names no stale keys (${why})`, () => {
      const src = readSrc(file);
      const hits = bad.filter(b => src.includes(b));
      assert.equal(hits.length, 0,
        `${file} still contains stale key reference(s): ${hits.join(', ')} — ${why}`);
    });
  }

  it('InputManager has no live bare-C comms handler (C was freed 2026-06-16)', () => {
    const src = readSrc('systems/InputManager.js');
    assert.ok(!/case 'KeyC':/.test(src),
      "InputManager must not bind bare C — comms expand lives on the 7 key");
  });
});

