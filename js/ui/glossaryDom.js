/**
 * glossaryDom.js — shared DOM affordances for the inline glossary (§11.8).
 *
 * glossary.js stays DOM-free (pure decorator, Node-testable). This thin sibling
 * holds the two browser-only pieces every glossary surface needs so they aren't
 * copy-pasted across CommsPanel / ShopScreen / the viewer / etc:
 *   • ensureGlossaryCss(doc) — inject the `.glossary-term` stylesheet ONCE.
 *   • delegateGlossaryClicks(el) — one delegated click handler that turns a
 *     click on a `.glossary-term[data-entry]` into a CODEX_OPEN_ENTRY emit.
 *
 * Both are idempotent and guarded for non-DOM environments.
 *
 * @module ui/glossaryDom
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const CSS_ID = 'glossary-term-css';

/**
 * Inject the shared `.glossary-term` stylesheet exactly once. Reuses the menu's
 * `.adr-name` look: a dotted underline that glows on hover. Deep-linkable terms
 * (`data-entry`) get a pointer cursor; hover-only terms get `help`. The
 * first-use cue (`--new`) is a brighter, solid underline that drops once seen.
 * @param {Document} [doc=document]
 */
export function ensureGlossaryCss(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || typeof doc.createElement !== 'function') return;
  if (typeof doc.getElementById === 'function' && doc.getElementById(CSS_ID)) return;
  // Mount on <head>, falling back to <html>/<body>. Guard against minimal DOM
  // shims (used in headless tests) that expose createElement but no mount node.
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
 * Attach a single delegated click handler to `el` so a click on any
 * `.glossary-term[data-entry]` descendant deep-links the viewer. Idempotent:
 * tags the element so repeated calls don't stack handlers.
 *
 * On a term hit the event is stopped (`stopPropagation`) so the glossary action
 * cleanly wins over any underlying click target (e.g. a selectable briefing
 * card or shop row). When the container's own descendants carry their own click
 * handlers that would otherwise fire first during bubbling, pass
 * `{ capture: true }` so this handler runs in the capture phase and can suppress
 * them.
 *
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
    // A term click is a distinct intent — don't let it also trigger an
    // underlying selectable card/row.
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    eventBus.emit(Events.CODEX_OPEN_ENTRY, { id });
  }, capture);
}
