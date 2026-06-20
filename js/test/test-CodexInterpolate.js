/**
 * test-CodexInterpolate.js — Codex Overhaul Phase 1: live-value interpolation
 * + the offline-first data loader (both Node-safe pure modules).
 *
 * @module test/test-CodexInterpolate
 */

import { describe, it, assert } from './TestRunner.js';
import { interpolate, placeholderPaths } from '../systems/codex/codexInterpolate.js';
import { loadCodexData } from '../systems/codex/codexData.js';

const C = {
  CAPTURE_NET: { LARGE: { SPIN_HZ: 2 }, MEDIUM: { SPIN_HZ: 4 }, SMALL: { SPIN_HZ: 6 } },
  ISP: { XENON: 3000 },
};

describe('codexInterpolate — placeholder resolution', () => {
  it('passes through text with no placeholders unchanged', () => {
    assert.equal(interpolate('plain text', C), 'plain text');
  });

  it('resolves a bare dotted path', () => {
    assert.equal(interpolate('Isp {{ISP.XENON}}s', C), 'Isp 3000s');
  });

  it('applies * multiplication (Hz → RPM)', () => {
    assert.equal(interpolate('{{CAPTURE_NET.LARGE.SPIN_HZ*60}} RPM', C), '120 RPM');
  });

  it('applies / division', () => {
    assert.equal(interpolate('{{ISP.XENON/1000}}k', C), '3k');
  });

  it('resolves multiple placeholders in one string', () => {
    assert.equal(
      interpolate('{{CAPTURE_NET.LARGE.SPIN_HZ*60}}/{{CAPTURE_NET.MEDIUM.SPIN_HZ*60}}/{{CAPTURE_NET.SMALL.SPIN_HZ*60}}', C),
      '120/240/360');
  });

  it('leaves an unresolvable path verbatim (does not throw)', () => {
    assert.equal(interpolate('{{NOPE.MISSING}}', C), '{{NOPE.MISSING}}');
  });

  it('tolerates whitespace inside the braces', () => {
    assert.equal(interpolate('{{  ISP.XENON  *  2 }}', C), '6000');
  });

  it('placeholderPaths lists referenced paths', () => {
    const paths = placeholderPaths('{{A.B}} and {{C.D*2}}');
    assert.deepEqual(paths, ['A.B', 'C.D']);
  });
});

describe('codexData — offline-first loader', () => {
  it('parses a valid JSON payload via an injected fetch', async () => {
    const payload = { version: 1, entries: [{ id: 'x' }] };
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => payload });
    const data = await loadCodexData({ fetchImpl });
    assert.ok(data, 'returned data');
    assert.equal(data.entries.length, 1, 'entries parsed');
  });

  it('falls back to null on HTTP failure (graceful)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const data = await loadCodexData({ fetchImpl });
    assert.equal(data, null, 'null on 404');
  });

  it('falls back to null on a malformed payload', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) });
    const data = await loadCodexData({ fetchImpl });
    assert.equal(data, null, 'null when entries[] missing');
  });

  it('falls back to null when no fetch is available', async () => {
    const data = await loadCodexData({ fetchImpl: null, basePath: './data/' });
    // In Node with no global fetch this resolves null; if a global fetch exists
    // it would attempt a real request — guard only the no-fetch contract here.
    if (typeof fetch !== 'function') assert.equal(data, null, 'null without fetch');
    else assert.ok(true, 'global fetch present — skipped');
  });
});
