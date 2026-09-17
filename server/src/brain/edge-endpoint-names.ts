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
