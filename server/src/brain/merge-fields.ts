/**
 * The one merge rule for `tags` and `properties`, in one place.
 *
 * ## Why this file exists
 *
 * Every brain write that lands on an existing record has to answer the same question: what do the
 * stored `tags`/`properties` become once the incoming ones are applied? The answer is two lines —
 * a de-duplicated tag union and a shallow property merge — and it was written **eleven times** across
 * six files before this module: in the entity writer, the edge writer, the memory writer, the chrono
 * writer, three REST handlers and two MCP tools.
 *
 * A canonical version did exist (`mergedEntityWrite`, in `entities.ts`), and it was already generic —
 * its signature never mentioned an entity. It had two call sites. Everyone else re-derived it, because
 * **a helper named and placed for its first caller is invisible to the second**: nobody reaches into
 * `brain/entities.ts` to merge a chrono entry's properties. Two of the eleven copies were added hours
 * before the 2.4.0 docs promised that all four record types converge "matching the entity path".
 *
 * That promise is the reason this is correctness rather than tidiness. A stated guarantee with eleven
 * implementations is held together by nothing, and it was not in fact held: `update_fact`'s own tool
 * schema said `properties` were "to merge" while `updateMemory` **replaced** them, so an agent that
 * patched one property silently destroyed every other property on the record.
 *
 * ## The rule
 *
 * - **tags** — union, de-duplicated, stored order first. Adding a tag never removes one.
 * - **properties** — shallow merge, incoming wins per key. A patch that names one key keeps the rest.
 * - Removing either is `deleteFields`' job, never an absence.
 *
 * `*OrKeep` are the PATCH-shaped variants: `undefined` incoming means *do not touch*, which is a
 * different statement from an empty object and must not collapse into one.
 */

/** The value shape a brain record's `properties` map is allowed to hold. */
export type RecordProperties = Record<string, string | number | boolean>;

/** A record's mergeable fields — any of the five brain types, none of them named. */
export interface MergeableFields {
  tags?: string[];
  properties?: RecordProperties;
}

/**
 * The stored tags plus the incoming ones, de-duplicated, stored order first.
 *
 * Order matters more than it looks: it is what a caller sees echoed back, and a `Set` preserves
 * insertion order, so the stored tags keep their positions and new ones append.
 */
export function mergeTags(existing?: readonly string[] | null, incoming?: readonly string[]): string[] {
  return Array.from(new Set([...(existing ?? []), ...(incoming ?? [])]));
}

/** The stored properties with the incoming ones laid over — one level deep, incoming wins per key. */
export function mergeProperties(
  existing?: RecordProperties | null,
  incoming?: RecordProperties,
): RecordProperties {
  return { ...(existing ?? {}), ...(incoming ?? {}) };
}

/**
 * Both fields at once: what a write will actually store, given the record it lands on.
 *
 * `existing` is null/undefined for an insert, where the merge is the identity function. Schema
 * validation calls this so it can check the record that will EXIST rather than the payload — the
 * distinction that made a partial upsert of a conformant record fail in a strict space.
 */
export function mergeTagsAndProperties(
  existing: MergeableFields | null | undefined,
  incoming: MergeableFields,
): { tags: string[]; properties: RecordProperties } {
  return {
    tags: mergeTags(existing?.tags, incoming.tags),
    properties: mergeProperties(existing?.properties, incoming.properties),
  };
}

/**
 * `mergeProperties` for a PATCH: `undefined` incoming means the caller said nothing about properties,
 * so the stored map is returned untouched — `undefined` included, so a writer can tell "leave it out
 * of the `$set`" from "store an empty map".
 *
 * A copy is returned rather than the stored reference: `deleteFields` mutates what it is handed, and
 * aliasing the document just read from the driver is a defect waiting for the first caller that does
 * both in one request.
 */
export function mergePropertiesOrKeep(
  existing?: RecordProperties | null,
  incoming?: RecordProperties,
): RecordProperties | undefined {
  if (incoming === undefined) return existing == null ? undefined : { ...existing };
  return mergeProperties(existing, incoming);
}

/** `mergeTags` for a PATCH: `undefined` incoming leaves the stored tags alone. */
export function mergeTagsOrKeep(existing?: readonly string[] | null, incoming?: readonly string[]): string[] {
  if (incoming === undefined) return [...(existing ?? [])];
  return mergeTags(existing, incoming);
}
