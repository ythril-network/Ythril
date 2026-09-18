/**
 * Resolving an edge's endpoints to the names a reader — or an embedding model — sees.
 *
 * ## Why it is its own module
 *
 * `edges.ts` is one of the largest files in the server and is frozen at its current size by
 * `no-new-god-files.test.js`, whose message is the reason rather than the rule: *"the failure mode of a
 * god-file is not its size on any given day — it is that every change lands in the same place because that is
 * where the code already is."* This is new behaviour about endpoints, so it goes beside that file rather than
 * inside it.
 *
 * ## What it is for
 *
 * An edge embeds `from label to` and nothing else, with the endpoints resolved to names: `ServiceA depends_on
 * ServiceB` IS the edge's content, which is why an edge resolves its endpoints while a fact deliberately
 * does not resolve the entities it links (measured at 1.5 points of strict evidence recall — see
 * `entity-names-are-not-in-the-embed-text.test.js`).
 *
 * Four paths reach this, and that is the whole risk: the inline upsert, the queued embed job, the reindex job,
 * and the edge list route. It used to be one function called `resolveEdgeEntityNames` that looked both ends
 * up in the entities collection — right while every endpoint was an entity, and the reason `reindex` once
 * embedded raw entity IDs while the writer embedded names. One function, four callers, and the kind travels
 * with the endpoint.
 */
import { col, asFilter } from '../db/mongo.js';
import { collectionForRefKind, edgeEndpointKind, endpointNameField } from './entity-refs.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import type { ResolvedEdgeEnds } from '../spaces/schema-validation.js';
import type { EdgeDoc } from '../config/types.js';
import type { RefKind } from '../config/types-knowledge.js';
import { spaceCollection } from '../db/space-collection.js';
import { recordDisplayName, recordDisplayType } from './link-frontier.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import type { ChronoEntry, FactDoc, FileMetaDoc } from '../config/types.js';

/**
 * How much of an endpoint's name reaches the edge's embedding.
 *
 * An entity name and a chrono title are short by nature; a fact's `fact` is a sentence or several. An edge
 * embeds `from label to` and nothing else, so an untruncated fact at one end would make the edge's vector
 * mostly that fact — the edge would then be recalled for queries about the fact rather than about the
 * relationship, which is the same dilution that cost 1.5 points when facts embedded their entity names.
 */
export const ENDPOINT_NAME_MAX = 200;

/**
 * Resolve one endpoint to the string that stands for it.
 *
 * A file needs no lookup: its `_id` IS its path, which is also the best thing to call it.
 *
 * Falls back to the raw id, as this has always done: an endpoint pointing at a record that is not there still
 * has to produce an embedding rather than throw, because the edge is already stored by the time this runs.
 */
export async function resolveEndpointName(spaceId: string, id: string, kind: RefKind): Promise<string> {
  if (kind === 'file') return id;
  const field = endpointNameField(kind);
  const doc = await col<Record<string, unknown>>(`${spaceId}_${collectionForRefKind(kind)}`)
    .findOne(asFilter<Record<string, unknown>>({ _id: id }), { projection: { [field]: 1 } });
  const value = doc?.[field];
  if (typeof value !== 'string' || !value.trim()) return id;
  return value.trim().slice(0, ENDPOINT_NAME_MAX);
}

/**
 * What a write needs to know about an edge's endpoints before a schema rule can be checked.
 *
 * ## Why the write path resolves rather than the validator
 *
 * `validateEdge` is pure and synchronous — two gates import it from `dist` and call it with plain objects — so
 * it cannot look anything up. The caller resolves and hands over what it FOUND, and an absent field is never a
 * violation. That split is what lets the bulk importer, which legitimately cannot resolve a forward reference,
 * use the same validator without being told its payload is wrong.
 *
 * ## `null` is not `undefined` here
 *
 * `null` means the entity is there and has no type, which an `endpoints` list matches with `UNTYPED`.
 * `undefined` means it could not be resolved at all — a dangling reference, which `strictLinkage: false` makes a
 * deliberate state with its own report. Collapsing them lets every untyped entity past every endpoint rule.
 *
 * ## The count excludes the edge being written
 *
 * An edge is not its own duplicate. Without the exclusion a `functional` label can be written once and never
 * touched again, because every later upsert on the same triplet reports the stored edge against itself.
 */
export async function resolveEdgeEndsForWrite(
  spaceId: string,
  from: string,
  to: string,
  label: string,
  kinds: { fromKind?: RefKind; toKind?: RefKind } = {},
): Promise<ResolvedEdgeEnds> {
  const out: ResolvedEdgeEnds = {};

  /*
   * Types only for ENTITY endpoints. `endpoints` is a vocabulary of entity types plus `UNTYPED`, and a fact,
   * chrono entry or file has no `type` in that vocabulary — so resolving one would invent a value the schema
   * cannot express. Left unresolved, which is never a violation.
   */
  const wanted: Array<['fromType' | 'toType', string]> = [];
  if (edgeEndpointKind(kinds.fromKind) === 'entity') wanted.push(['fromType', from]);
  if (edgeEndpointKind(kinds.toKind) === 'entity') wanted.push(['toType', to]);

  if (wanted.length > 0) {
    // ONE query for both ends, and only the type is projected: the ids are already in hand.
    const ids = [...new Set(wanted.map(([, id]) => id))];
    const docs = await col<{ _id: string; type?: string }>(spaceCollection(spaceId, 'entities'))
      .find(asFilter<{ _id: string; type?: string }>({ _id: { $in: ids } }), { projection: { _id: 1, type: 1 } })
      .toArray() as Array<{ _id: string; type?: string }>;
    const typeOf = new Map(docs.map(d => [String(d._id), d.type ?? null]));
    for (const [field, id] of wanted) {
      if (typeOf.has(id)) out[field] = typeOf.get(id) as string | null;
    }
  }

  /*
   * How many OTHER edges carry this label from this subject. A COUNT rather than a fetch: the rule needs the
   * number, and one hub could hold a great many.
   *
   * Counted only when the space declares the label functional, which is the common case being cheap: an
   * unconstrained label pays nothing for a rule it does not have.
   */
  const functional = getSpaceMeta(spaceId)?.typeSchemas?.edge?.[label]?.functional;
  if (functional) {
    out.otherEdgesFromSubject = await col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
      .countDocuments(asFilter<EdgeDoc>({ from, label, to: { $ne: to } } as never));
  }
  return out;
}

/**
 * Resolve an edge's two endpoints, each according to the KIND it declares.
 *
 * An omitted kind means `entity`, read here through `edgeEndpointKind` rather than with a `?? 'entity'` at
 * this call site — the coalesce lives in one place so the fifth caller cannot be the one that forgets it.
 */
export async function resolveEdgeEndpointNames(
  spaceId: string,
  fromId: string,
  toId: string,
  fromKind?: RefKind,
  toKind?: RefKind,
): Promise<[string, string]> {
  return await Promise.all([
    resolveEndpointName(spaceId, fromId, edgeEndpointKind(fromKind)),
    resolveEndpointName(spaceId, toId, edgeEndpointKind(toKind)),
  ]) as [string, string];
}

/** One edge, as far as endpoint-name resolution cares: two ids and the kind each one is. */
export interface EdgeEndpoints {
  from: string;
  to: string;
  fromKind?: RefKind;
  toKind?: RefKind;
}

/**
 * Give a PAGE of edges the display names of both endpoints, batched.
 *
 * ## Why this is a module and not four lines in the route
 *
 * It was inline in `GET .../edges` and nowhere else, so `filter` with `collection: 'edges'` answered with
 * bare UUIDs — a capability the browser had and an agent did not, and one that step 3 of `B-9` would have
 * deleted along with the route without anybody noticing, because a decoration applied AFTER the query does
 * not look like a parameter and nothing compares it.
 *
 * ## What a hand-written copy drops, and it is not the query
 *
 * **The grouping by KIND.** A single lookup in `<space>_entities` was right while every endpoint was an
 * entity, and shows a bare UUID for a chrono or fact endpoint now that they can be one. The kind also
 * decides which FIELD carries the name — an entity has `name`, a chrono entry `title`, a fact `fact` — so
 * one query could not have served them anyway.
 *
 * **And a file needs no lookup at all**: its id IS its path, so the name is left ABSENT rather than
 * resolved, and a client falls back to showing that path. A copy that queried `<space>_files` for a `name`
 * field would find nothing and silently blank the column.
 *
 * Returns the rows with `fromName`/`toName` spread on, rather than the map, so a caller cannot apply one
 * and forget the other.
 */
export async function withEndpointNames<T extends EdgeEndpoints>(
  spaceId: string,
  edges: readonly T[],
  /** Reads one member's collection — injected because a proxy space resolves across its members. */
  readAcrossMembers: (read: (memberId: string) => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>,
): Promise<Array<T & { fromName?: string; toName?: string }>> {
  const byKind = new Map<'entity' | 'fact' | 'chrono', Set<string>>();
  for (const e of edges) {
    for (const [id, kind] of [[e.from, edgeEndpointKind(e.fromKind)], [e.to, edgeEndpointKind(e.toKind)]] as const) {
      if (kind === 'file') continue;
      if (!byKind.has(kind)) byKind.set(kind, new Set());
      byKind.get(kind)!.add(id);
    }
  }

  const nameMap = new Map<string, string>();
  for (const [kind, ids] of byKind) {
    if (ids.size === 0) continue;
    const field = endpointNameField(kind);
    const docs = await readAcrossMembers(async mid =>
      await col<Record<string, unknown>>(spaceCollection(mid, collectionForRefKind(kind)))
        .find(asFilter<Record<string, unknown>>({ _id: { $in: [...ids] } }), { projection: { _id: 1, [field]: 1 } })
        .toArray());
    for (const d of docs) {
      const value = d[field];
      if (typeof value === 'string' && value.trim()) nameMap.set(String(d['_id']), value.trim());
    }
  }

  return edges.map(e => ({ ...e, fromName: nameMap.get(e.from), toName: nameMap.get(e.to) }));
}

/** The node shape a graph walk emits. Structural only — `TraverseNode` in `edges.ts` is the public name.
 *  Declared here rather than imported so this module does not depend on the walk it serves. */
export interface TraverseNodeShape {
  _id: string; name: string; type: string; depth: number;
  kind?: 'fact' | 'chrono' | 'file'; description?: string; tags?: string[];
}

/** A non-entity endpoint's stored document — whichever of the three collections it lives in. */
export type EndpointDoc = ChronoEntry | FactDoc | FileMetaDoc;

/** One resolved non-entity endpoint: the record, and the collection it came from. */
export interface EndpointRecord {
  doc: EndpointDoc;
  kind: 'fact' | 'chrono' | 'file';
}

/**
 * Resolve an EXPLICIT edge's non-entity endpoints into the records a graph walk emits as nodes.
 *
 * ## The defect this exists for
 *
 * An edge may declare `fromKind`/`toKind` of `entity`, `fact`, `chrono` or `file`, the writer refuses a kind
 * that does not match the record, and the edge is then stored, hashed and replicated. **And the walk looked
 * every neighbour up in `<space>_entities` and dropped whatever was not there** — no flag, no truncation
 * marker, just a stored edge that no retrieval path reached. That is report `#695`'s *"a link that is
 * stored, returned, and points at nothing traversable"* arriving by a different route.
 *
 * ## TWO walks call this, and that is the point rather than a convenience
 *
 * `traverseGraph` and `recall`'s seed expansion each have their own BFS, and each had the same
 * `entityMap.get(id)` line. The comment in `recall-seed-traversal.ts` records what happened the last time
 * they diverged: *"One rule, two implementations, and the one reachable from a search had the weaker."*
 * Fixing only the standalone walk would also have made `graph_traverse`'s own description false, which
 * tells a caller that *"the difference between the two tools is the default, not the capability."*
 *
 * ## What a hand-written copy drops
 *
 * **The grouping by KIND** — one lookup in one collection is right only while every endpoint is an entity.
 * It returns the RECORD rather than a rendered node, because the two callers shape it differently: the
 * standalone walk wants `name`/`type` (through `recordDisplayName`/`recordDisplayType`) and recall nests
 * the whole document. Rendering here would have forced one of them to unpick it.
 *
 * It lives beside `withEndpointNames` because that is the same question — *what is this endpoint, given its
 * kind* — and the grouping rule belongs in one file rather than in one file and two loops.
 *
 * **A file IS looked up here, unlike in `withEndpointNames` above.** There, only a name was wanted and a
 * file's `_id` already is its path. A node carries `description` and `tags` as well, so skipping the read
 * would silently drop them — and the link scan, which reaches the same files the other way, does read them.
 * Meta only: never chunk text, for the reason `TraverseNode.description` gives.
 *
 * @param memberIds   Space IDs to search, so a proxy space resolves across its members.
 * @param wanted      The endpoints to resolve, each with the kind its edge declared. `entity` is ignored:
 *                    both walks already batch-fetch those and this must not read them twice.
 * @returns A record per id that RESOLVED. An id that resolves to nothing is absent rather than invented — an
 *          edge can outlive the record it points at, and a placeholder node would be a fact the walk made up.
 */
export async function endpointRecordsByKind(
  memberIds: readonly string[],
  wanted: ReadonlyArray<{ id: string; kind: RefKind }>,
): Promise<Map<string, EndpointRecord>> {
  const out = new Map<string, EndpointRecord>();
  const byKind = new Map<'fact' | 'chrono' | 'file', Set<string>>();
  for (const { id, kind } of wanted) {
    const k = edgeEndpointKind(kind);
    if (k === 'entity') continue;
    if (!byKind.has(k)) byKind.set(k, new Set());
    byKind.get(k)!.add(id);
  }

  for (const [kind, ids] of byKind) {
    for (const mid of memberIds) {
      const docs = await col<Record<string, unknown>>(spaceCollection(mid, collectionForRefKind(kind)))
        .find(asFilter<Record<string, unknown>>({ _id: { $in: [...ids] }, spaceId: mid }),
          { projection: NEVER_RETURNED_PROJECTION })
        .toArray();
      for (const d of docs) out.set(String(d['_id']), { doc: d as unknown as EndpointDoc, kind });
    }
  }
  return out;
}

/**
 * Every new neighbour of a hop, resolved to the node a walk emits — whatever collection it lives in.
 *
 * ## Why it is here rather than in the walk
 *
 * `edges.ts` is frozen at its current size by `no-new-god-files.test.js`, whose message is the reason
 * rather than the rule: *"the failure mode of a god-file is not its size on any given day — it is that
 * every change lands in the same place because that is where the code already is."* Following a non-entity
 * endpoint is new behaviour about endpoints, so it goes beside that file.
 *
 * ## What a hand-written copy drops
 *
 * **That an entity node carries NO `kind`.** Every node was one until chrono entries became reachable, and
 * the absence is what keeps an existing response byte-identical. A copy that stamped `kind: 'entity'` for
 * symmetry would change every answer this product has ever given.
 *
 * **And the file extras.** A file node carries `description` and `tags` when set, and never chunk text.
 *
 * An id that resolves to nothing is ABSENT from the result rather than given a placeholder: an edge can
 * outlive the record it points at, and a made-up node is worse than a missing one.
 */
export async function neighbourNodes(
  memberIds: readonly string[],
  ids: readonly string[],
  /** The kind each id's edge declared, positionally. An omitted kind means `entity`. */
  kinds: readonly (RefKind | undefined)[],
  depth: number,
): Promise<Map<string, TraverseNodeShape>> {
  const out = new Map<string, TraverseNodeShape>();
  if (ids.length === 0) return out;

  for (const mid of memberIds) {
    const entities = await col<Record<string, unknown>>(spaceCollection(mid, 'entities'))
      .find(asFilter<Record<string, unknown>>({ _id: { $in: [...ids] }, spaceId: mid }),
        { projection: NEVER_RETURNED_PROJECTION })
      .toArray();
    // No `kind` on an entity — see the docblock. This is the field whose ABSENCE is the contract.
    for (const e of entities) {
      out.set(String(e['_id']),
        { _id: String(e['_id']), name: String(e['name'] ?? ''), type: String(e['type'] ?? ''), depth });
    }
  }

  const others = await endpointRecordsByKind(memberIds, ids.map((id, i) => ({ id, kind: edgeEndpointKind(kinds[i]) })));
  for (const [id, rec] of others) {
    if (out.has(id)) continue;   // an entity already answered for it; an id is one record
    const file = rec.kind === 'file' ? rec.doc as FileMetaDoc : undefined;
    out.set(id, {
      _id: id, depth, kind: rec.kind,
      // The same two functions the link scan renders with, so one record reached two ways is described
      // one way.
      name: recordDisplayName(rec.kind, rec.doc), type: recordDisplayType(rec.kind, rec.doc),
      ...(file?.description ? { description: file.description } : {}),
      ...(file?.tags && file.tags.length > 0 ? { tags: file.tags } : {}),
    });
  }
  return out;
}

/**
 * The node a walk STARTS from, when nobody has told us which collection it is in.
 *
 * ## Why the kind is unknown here and known everywhere else
 *
 * A neighbour arrives through an edge, and an edge DECLARES the kind at each end. A `startId` arrives
 * from the caller as a bare id — `graph_traverse` takes one argument, not two — so the only way to know
 * what it names is to look.
 *
 * ## Entity first, and the order is the contract rather than a guess
 *
 * An id is one record, so at most one collection answers. Entity is tried first because it is what a
 * start node almost always is, and because an entity node carries NO `kind` — resolving one as anything
 * else would add a field to the commonest answer in the product.
 *
 * Returns `undefined` when nothing answers, and that is load-bearing: `graph_traverse` promises that an
 * empty `nodes` means the id resolved to nothing. Inventing a placeholder would make every walk
 * non-empty and destroy the one distinction the promise is for.
 */
export async function startNode(
  memberIds: readonly string[],
  id: string,
): Promise<TraverseNodeShape | undefined> {
  // Every kind, for the one id. `neighbourNodes` keys its result by id and lets the entity lookup win,
  // so this asks all four questions in one call rather than re-implementing the precedence here.
  const found = await neighbourNodes(
    memberIds, [id, id, id, id], [undefined, 'fact', 'chrono', 'file'], 0);
  return found.get(id);
}
