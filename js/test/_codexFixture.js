/**
 * _codexFixture.js — Node test helper: load data/codex.json synchronously so
 * suites can construct `new CodexSystem(CODEX_DATA)`.
 *
 * CodexSystem is data-injected (Phase 1); the browser fetches the JSON, but
 * Node tests read it from disk here. Keeping node:fs in test-only code means
 * the browser-loaded modules never import it.
 *
 * @module test/_codexFixture
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const _here = dirname(fileURLToPath(import.meta.url));
const _root = resolve(_here, '../..');

/** Parsed data/codex.json (the real shipped content). */
export const CODEX_DATA = JSON.parse(
  readFileSync(resolve(_root, 'data/codex.json'), 'utf8'),
);

export default CODEX_DATA;
