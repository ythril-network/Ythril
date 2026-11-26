/**
 * What a space's schema alone says about reading it as RDF (its term clashes, the first address no document can carry), computed once per
 * schema version and read from a bounded cache by every caller of `rdfSpaceState` (bundle-378, Q-976, S1).
 *
 * ## The question it answers
 *
 * "Has this schema version's RDF verdict been computed already?", asked by `rdfSpaceState` for each member of every SPARQL query and
 * Update, RDF export, Linked Data read and SPARQL view's CONSTRUCT, and by the schema export, the imports and the triple index's follower.
 * A probe at BSBM 1 000 measured about 44 ms of a 81 ms query in these checks (two resolutions of 22 ms each, most of it the term-clash
 * check), all CPU on a schema that had not changed.
 *
 * ## What it prevents
 *
 * - **A verdict of an older schema.** The key is a hash of everything the verdict reads: the resolved type schemas (library `$ref`s
 *   inlined), the space's RDF names (`meta.rdf`: base and vocab decide which addresses clash) and the instance's library namespaces. Any
 *   change of one is a different key, however it was made (a meta write, a library save, a peer's round, a change in place); the space's
 *   entry is replaced (one entry per space), so the old verdict is dropped, never kept beside the new.
 * - **A verdict of one caller handed to another.** Nothing here depends on who asks: may the caller read the space, its files, which
 *   networks a refusal may name are asked by `rdfMembers` and `rdfSpaceState` on every call, never cached.
 * - **A cache that grows with the instance.** At most {@link RDF_SCHEMA_VERDICT_CAP} spaces are held, the least recently asked dropped
 *   first.
 *
 * ## Why not the schema fingerprint
 *
 * The fingerprint (`spaces/schema-stamp.ts`) covers the type schemas and rules but not `meta.rdf` nor the namespaces, which the verdict
 * reads; that module sits in the server's largest import cycle (`rdf-space-state.ts` says why it is handed in); and one caller (the triple
 * index's follower) hands `rdfSpaceState` no fingerprint at all. Hashing what the verdict reads costs well under a millisecond on a BSBM
 * schema and needs none of the three.
 */
import type { SpaceMeta } from '@ythril-network/schema';
import { LruMap } from '../util/lru-map.js';
import { sha256Hex } from '../util/sha256-hex.js';
import { timePhase } from '../http/phase-timer.js';

/** The most spaces whose verdict is held. A verdict is a few small objects; an instance with more RDF spaces than this recomputes the rest. */
export const RDF_SCHEMA_VERDICT_CAP = 256;

/** A library group namespace, as the verdict reads it. */
export interface VerdictNamespace { prefix: string; iri: string }

interface Held { key: string; verdict: unknown }

const held = new LruMap<string, Held>(RDF_SCHEMA_VERDICT_CAP);
let hits = 0;
let misses = 0;

/**
 * The verdict of `spaceId`'s schema: the held one when it was computed for the same resolved type schemas, RDF names and namespaces, else
 * `compute(resolved, namespaces)`, held in place of the space's old entry. `resolved` is the space's meta with its library `$ref`s inlined
 * (what `compute` reads). A computation is timed as the request's `schema` phase.
 */
export function cachedSchemaVerdict<V>(
  spaceId: string, resolved: SpaceMeta, namespaces: readonly VerdictNamespace[],
  compute: (resolved: SpaceMeta, namespaces: readonly VerdictNamespace[]) => V,
): V {
  const key = sha256Hex(JSON.stringify([resolved.typeSchemas ?? null, resolved.rdf ?? null, namespaces.map(n => [n.prefix, n.iri])]));
  const entry = held.get(spaceId);
  if (entry?.key === key) {
    hits++;
    return entry.verdict as V;
  }
  misses++;
  const verdict = timePhase('schema', () => compute(resolved, namespaces));
  held.set(spaceId, { key, verdict });
  return verdict;
}

/** How the cache has answered since the process started, and how many spaces it holds: for an operator's question and a spec's. */
export function rdfSchemaVerdictStats(): { hits: number; misses: number; size: number; cap: number } {
  return { hits, misses, size: held.size, cap: RDF_SCHEMA_VERDICT_CAP };
}
