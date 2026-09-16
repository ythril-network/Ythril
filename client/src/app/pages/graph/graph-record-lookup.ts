/**
 * What to fetch when a graph selection is tapped — or why nothing can be.
 *
 * ## Why this is a decision and not just a fetch
 *
 * A graph carries four kinds of node and two kinds of edge, and only some of them name a stored record:
 *
 *   - an **entity, memory or chrono** node is a record, in its own collection. `loadNodeDetails` used to call
 *     `getEntity` for all of them, so tapping a memory or chrono node issued a request that 404s. It is
 *     caught, so nothing breaks visibly — the panel opens empty and says nothing.
 *   - a **file** node has a record, addressed by PATH. A graph node carries an id, so there is no request
 *     that could succeed.
 *   - a **synthetic edge** is derived at render time from a link and stored nowhere. Its id is
 *     `<label>:<from>:<to>`, which is what it was given when the id collision was fixed.
 *
 * An empty panel and an unfetchable record look identical to the person reading them, and only one of the two
 * is worth a retry. So the decision has a third outcome — *nothing, and here is why* — rather than being a
 * fetch that quietly fails.
 *
 * ## Why it lives outside the component
 *
 * `graph.component.ts` is a frozen file under `no-new-god-files.test.js`, and the gate's advice is the right
 * advice: *"every change lands in the same place because that is where the code already is."* This is also
 * the part worth testing on its own — a pure function over `(kind, id)` needs no TestBed, no cytoscape mock
 * and no signals to exercise every branch.
 */

// The kinds, from the client's one mirror of the API's shapes. This module had no imports at all — a leaf
// by construction — and one to a shape module cannot make a cycle, which is the property worth keeping.
import { KnowledgeType } from '../../core/api.types';

/** A stored record's id. Anything else in an edge's `_id` is synthetic. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a selection has no record to show. The value is the i18n key's suffix. */
export type Unavailable = 'file' | 'derived';

export type RecordLookup =
  | { fetch: KnowledgeType }
  | { unavailable: Unavailable };

/**
 * Which collection a tapped NODE's record lives in.
 *
 * `kind` is the node's own, from `TraverseNode.kind`; absent means an entity, which is every node the graph
 * carried before chrono/memory/file links became reachable.
 */
export function lookupForNode(kind: 'chrono' | 'fact' | 'file' | undefined): RecordLookup {
  if (kind === 'file') return { unavailable: 'file' };
  return { fetch: kind ?? 'entity' };
}

/**
 * Whether a tapped EDGE names a stored record.
 *
 * Decided by the id NOT being a UUID rather than by parsing the label out of it: a label is
 * operator-supplied text and may contain anything, colons included, so splitting on `:` would misread a real
 * edge whose label happens to have one.
 */
export function lookupForEdge(edgeId: string): RecordLookup {
  return UUID_RE.test(edgeId) ? { fetch: 'edge' } : { unavailable: 'derived' };
}
