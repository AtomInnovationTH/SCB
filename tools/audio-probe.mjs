/**
 * tools/audio-probe.mjs — headless audio timeline probe (Audio Vocabulary Overhaul, P6).
 *
 * Boots the game in headless Chromium (via the repo's playwright dep), clicks
 * the start button, and records every scheduled WebAudio source start with its
 * timestamp and originating js/ call site. Use it to inspect the startup and
 * first-catch cue timelines and diff before/after an audio change.
 *
 * Usage:
 *   1. Serve the repo:            npm run serve      # http://localhost:8080
 *   2. Point PW_EXE at a Chromium build and run:
 *        PW_EXE=/path/to/Chromium node tools/audio-probe.mjs
 *      (PW_EXE is optional if playwright's bundled browser is installed.)
 *   3. Optional env:
 *        PROBE_URL=http://localhost:8080/   (default)
 *        PROBE_WAIT_MS=8000                 (post-start capture window)
 *
 * Output: CLICKED_BUTTON + AUDIO_EVENTS JSON ([{ t(ms), kind, at:'js/....:line' }]).
 * Each `at` maps directly to a play/start method connect site in AudioSystem.js.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// PW_EXE is an optional dev override for the Chromium binary. It is passed to
// chromium.launch({ executablePath }), which executes it — so only honor it
// when it resolves to an existing regular file. An unset/invalid value falls
// back to Playwright's bundled browser resolution. This tool is a local dev
// harness (never shipped, never imported by app code); the check is just to
// avoid launching an unexpected path from a stray/misconfigured env.
let exe;
if (process.env.PW_EXE) {
  const candidate = fs.realpathSync.native
    ? (() => { try { return fs.realpathSync(process.env.PW_EXE); } catch { return null; } })()
    : process.env.PW_EXE;
  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    exe = candidate;
  } else {
    console.warn(`[audio-probe] Ignoring PW_EXE (not an existing file): ${process.env.PW_EXE}`);
    exe = undefined;
  }
}
const url = process.env.PROBE_URL || 'http://localhost:8080/';
const waitMs = Number(process.env.PROBE_WAIT_MS || 8000);

const browser = await chromium.launch({ headless: true, executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Instrument audio scheduling BEFORE any app code runs.
await page.addInitScript(() => {
  window.__audioLog = [];
  const t0 = performance.now();
  const rec = (kind) => {
    const stack = new Error().stack || '';
    const line = stack.split('\n').find((l) => /\/js\//.test(l)) || '';
    window.__audioLog.push({
      t: Math.round(performance.now() - t0),
      kind,
      at: line.trim().replace(/^.*\/js\//, 'js/').replace(/:(\d+):\d+\).*$/, ':$1'),
    });
  };
  const patch = (proto, name, kind) => {
    if (!proto || !proto[name]) return;
    const orig = proto[name];
    proto[name] = function (...args) {
      try { rec(kind); } catch (_e) { /* ignore */ }
      return orig.apply(this, args);
    };
  };
  patch(window.OscillatorNode && window.OscillatorNode.prototype, 'start', 'osc.start');
  patch(window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype, 'start', 'buf.start');
});

page.on('console', (m) => {
  const t = m.text();
  if (/Codex|Unlock|target|Target|lock|Lock/.test(t)) console.log('CONSOLE:', t);
});

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1500);

// Click ONLY the start button — no stray clicks.
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, [role=button], a')];
  const b = btns.find((x) => /start mission|start|play|launch|begin/i.test(x.textContent || ''));
  if (b) { b.click(); return (b.textContent || '').trim(); }
  return null;
});

await page.waitForTimeout(waitMs);

const log = await page.evaluate(() => window.__audioLog || []);
console.log('CLICKED_BUTTON:', clicked);
console.log('AUDIO_EVENTS:', JSON.stringify(log, null, 0));

await browser.close();
