/**
 * egoLayout.js — Pure, deterministic ego-map layout for the codex viewer.
 *
 * Given a focus entry, computes a two-ring radial "ego network":
 *   • ring 0: the focus entry, centred.
 *   • ring 1: its direct `related` entries (1-hop), in array order, evenly
 *     spaced starting at −90° (12 o'clock).
 *   • ring 2: the related-of-related entries (2-hop), deduped against the focus
 *     and ring 1, capped, ghosted.
 *
 * No DOM / THREE / EventBus imports — this is testable in the Node harness.
 * Same inputs always yield identical output (angles, ordering, coordinates).
 *
 * @module systems/codex/egoLayout
 */

// Fixed viewBox the SVG renderer maps into. Centre is (500, 350).
const VIEW_W = 1000;
const VIEW_H = 700;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const RING1_RADIUS = 210;
const RING2_RADIUS = 320;
const RING2_CAP = 12;

/**
 * @typedef {Object} EgoNode
 * @property {string} id       - entry id
 * @property {number} x        - x coordinate within the 1000×700 viewBox
 * @property {number} y        - y coordinate within the 1000×700 viewBox
 * @property {0|1|2} ring      - 0 focus, 1 direct related, 2 two-hop related
 * @property {boolean} locked  - whether the entry is still locked
 * @property {string} icon     - entry icon glyph
 * @property {string} title    - entry title
 * @property {string} category - entry category key
 */

/**
 * @typedef {Object} EgoEdge
 * @property {string} from - source node id
 * @property {string} to   - target node id
 */

/**
 * @typedef {Object} EgoMap
 * @property {EgoNode[]} nodes
 * @property {EgoEdge[]} edges
 */

/** Build an EgoNode from a codex entry + position. @private */
function toNode(entry, x, y, ring) {
  return {
    id: entry.id,
    x,
    y,
    ring,
    locked: !entry.unlocked,
    icon: entry.icon || '📄',
    title: entry.title || entry.id,
    category: entry.category || '',
  };
}

/**
 * Compute the ego-map layout for a focus entry.
 *
 * @param {Object} deps
 * @param {string} deps.focusId - id of the entry at the centre.
 * @param {(id:string)=>(Object|null)} deps.getEntry - resolve an entry by id.
 * @param {(id:string)=>Object[]} deps.getRelated - direct related entries for an
 *        id, in authored order (the codex `related` array resolved to entries).
 * @param {Object} [opts] - reserved for future tuning; currently unused.
 * @returns {EgoMap} `{ nodes, edges }`; `{ nodes: [], edges: [] }` for an
 *          unknown focusId.
 */
export function layoutEgoMap({ focusId, getEntry, getRelated }, opts = {}) {
  const focus = (typeof getEntry === 'function') ? getEntry(focusId) : null;
  if (!focus) return { nodes: [], edges: [] };

  const nodes = [];
  const edges = [];

  // Ring 0 — focus at centre.
  nodes.push(toNode(focus, CENTER_X, CENTER_Y, 0));

  // Ring 1 — direct related, authored order, evenly spaced from −90°. Filter
  // out self-references and duplicates FIRST so the angle spacing is derived
  // from the surviving-node count (a duplicate/self-ref in `related` must not
  // leave an empty angular gap).
  const rawRing1 = (typeof getRelated === 'function') ? (getRelated(focusId) || []) : [];
  const seen = new Set([focus.id]);
  const ring1 = [];
  for (const entry of rawRing1) {
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    ring1.push(entry);
  }
  const n1 = ring1.length;
  const ring1Ids = [];

  ring1.forEach((entry, i) => {
    ring1Ids.push(entry.id);
    // Start at −90° (top), distribute evenly clockwise.
    const angle = (-Math.PI / 2) + (n1 > 0 ? (2 * Math.PI * i) / n1 : 0);
    const x = CENTER_X + RING1_RADIUS * Math.cos(angle);
    const y = CENTER_Y + RING1_RADIUS * Math.sin(angle);
    nodes.push(toNode(entry, x, y, 1));
    edges.push({ from: focus.id, to: entry.id });
  });

  // Ring 2 — two-hop related, deduped against focus + ring 1, sorted by
  // (parent index in ring 1, id), capped. Each keeps its first-seen parent so
  // the edge is deterministic.
  const ring2Map = new Map(); // id → { entry, parentIdx, parentId }
  ring1Ids.forEach((parentId, parentIdx) => {
    const grand = (typeof getRelated === 'function') ? (getRelated(parentId) || []) : [];
    grand.forEach((entry) => {
      if (!entry) return;
      if (seen.has(entry.id)) return;         // excludes focus + all ring-1
      if (ring2Map.has(entry.id)) return;      // keep first-seen parent
      ring2Map.set(entry.id, { entry, parentIdx, parentId });
    });
  });

  const ring2 = Array.from(ring2Map.values()).sort((a, b) => {
    if (a.parentIdx !== b.parentIdx) return a.parentIdx - b.parentIdx;
    return a.entry.id < b.entry.id ? -1 : (a.entry.id > b.entry.id ? 1 : 0);
  }).slice(0, RING2_CAP);

  const n2 = ring2.length;
  ring2.forEach((item, i) => {
    const angle = (-Math.PI / 2) + (n2 > 0 ? (2 * Math.PI * i) / n2 : 0);
    const x = CENTER_X + RING2_RADIUS * Math.cos(angle);
    const y = CENTER_Y + RING2_RADIUS * Math.sin(angle);
    nodes.push(toNode(item.entry, x, y, 2));
    edges.push({ from: item.parentId, to: item.entry.id });
  });

  return { nodes, edges };
}

export const EGO_LAYOUT_VIEW = { width: VIEW_W, height: VIEW_H, cx: CENTER_X, cy: CENTER_Y };
