/**
 * glossaryDom.js — browser-only glossary pieces, so glossary.js stays DOM-free (§11.8):
 *   - ensureGlossaryCss(doc) injects the `.glossary-term` stylesheet once.
 *   - delegateGlossaryClicks(el) turns a click on `.glossary-term[data-entry]` into CODEX_OPEN_ENTRY.
 * Both are idempotent and guarded for non-DOM environments.
 * @module ui/glossaryDom
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const CSS_ID = 'glossary-term-css';

/**
 * Inject the shared `.glossary-term` stylesheet once. Terms with `data-entry` get a pointer cursor,
 * hover-only terms get `help`; `--new` is the first-use cue (brighter, solid underline).
 * @param {Document} [doc=document]
 */
export function ensureGlossaryCss(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || typeof doc.createElement !== 'function') return;
  if (typeof doc.getElementById === 'function' && doc.getElementById(CSS_ID)) return;
  // Minimal DOM shims (headless tests) may expose createElement but no mount node.
  const mount = doc.head || doc.documentElement || doc.body;
  if (!mount || typeof mount.appendChild !== 'function') return;
  const style = doc.createElement('style');
  style.id = CSS_ID;
  style.textContent = `
    .glossary-term {
      border-bottom: 1px dotted currentColor;
      cursor: help;
      transition: text-shadow 0.15s, border-color 0.15s;
    }
    .glossary-term[data-entry] { cursor: pointer; }
    .glossary-term:hover { text-shadow: 0 0 6px currentColor; }
    .glossary-term--new {
      border-bottom-style: solid;
      border-bottom-color: currentColor;
    }
  `;
  mount.appendChild(style);
}

/**
 * One delegated click handler on `el` for `.glossary-term[data-entry]` descendants. Idempotent (tags `el`).
 * stopPropagation on a hit, so the glossary wins over an underlying card/row; pass `{ capture: true }` when
 * descendants' own click handlers would otherwise fire first.
 * Payload is `{ id }`, plus `anchor` ONLY when the span carries `data-anchor` (`decorateGlossary` `opts.links`).
 * @param {HTMLElement} el  the container that will hold decorated spans
 * @param {{ capture?: boolean }} [opts]
 */
export function delegateGlossaryClicks(el, opts = {}) {
  if (!el || (el.dataset && el.dataset.glossaryDelegated === '1')) return;
  if (el.dataset) el.dataset.glossaryDelegated = '1';
  const capture = opts.capture === true;
  el.addEventListener('click', (e) => {
    const span = e.target && e.target.closest && e.target.closest('.glossary-term');
    if (!span) return;
    const id = span.dataset && span.dataset.entry;
    if (!id) return;
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    const anchor = span.dataset.anchor;
    eventBus.emit(Events.CODEX_OPEN_ENTRY, anchor ? { id, anchor } : { id });
  }, capture);
}
