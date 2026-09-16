/**
 * The one definition of what a reference between brain records looks like.
 *
 * Every link field — a memory's `entityIds`, an edge's `from`/`to`, a chrono entry's
 * `entityIds`/`memoryIds`, a file's `entityIds`/`chronoIds`/`memoryIds` — names another record by its
 * `_id`. For every record type but one that is a UUID v4 (`brain/entities.ts` assigns `uuidv4()` on insert);
 * a FILE's `_id` is its space-relative path, so `RefKind` decides which shape is meant. Anything else is not
 * a reference, it is a string that happens to be stored in a reference field.
 *
 * This module exists because the regex previously had three separate copies (MCP tools, brain/bulk,
 * the REST helpers) and the validation was applied inconsistently across the call sites that used
 * them: some checked, some checked only under a flag, and some never checked at all. A dropped link in
 * a graph store is invisible — the record saves, the write returns success, and the gap only surfaces
 * later as a traversal that quietly returns nothing. One definition and one assert make "did we
 * validate this?" answerable by grep rather than by reading every handler.
 */
import { col, asFilter } from '../db/mongo.js';
import { REF_KINDS } from '../config/types-knowledge.js';
import type { RefKind } from '../config/types-knowledge.js';

/** Canonical UUID v4 matcher. The only copy — import it, never re-declare it. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Same pattern as a string, for embedding in a published JSON schema. */
export const UUID_V4_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

/**
 * What kind of record a reference field points at.
 *
 * Defined in `config/types-knowledge.ts` and re-exported here, because `EdgeDoc` needs it and `config/` may
 * not import from `brain/`. Re-exported rather than moved outright so the ~dozen call sites that import it
 * from here keep working — the point of the move is one definition, not a rename.
 */
export type { RefKind };

const REF_NOUN: Record<RefKind, string> = {
  entity: 'entity ID',
  fact: 'memory ID',
  chrono: 'chrono ID',
  file: 'file path',
};

/**
 * A file is identified by its space-relative PATH, and every other kind by a UUID v4 — so the format check
 * branches, and this is the one place that knows which is which.
 *
 * It is not a stylistic difference. Widening {@link RefKind} with `file` and leaving the UUID check in place
 * would refuse every legitimate file reference, which is worse than not supporting them: the field would be
 * documented, accepted by the schema, and rejected at the write.
 *
 * The path rule here validates a REFERENCE, and deliberately does not call `files/sandbox.ts`'s
 * `resolveSafePath` — that one resolves against the data root and answers "where on disk", which needs config
 * loaded and answers a different question. What a stored reference has to satisfy is narrower: it must be the
 * same string shape `FileMetaDoc._id` is ("space-relative path, normalised to forward slashes"), because the
 * existence check below looks the value up as an `_id` verbatim. A backslash or a leading slash would simply
 * never match, and `..` must not be storable at all.
 */
export function isSpaceRelativeFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\x00') || value.includes('\\') || value.startsWith('/')) return false;
  return !value.split('/').includes('..');
}

/**
 * Is this value the right SHAPE to be a reference to a record of this kind?
 *
 * Exported because it was being written a third time. `api/sync/_shared.ts` carried its own copy of
 * `UUID_V4_RE` and tested an edge's `from`/`to` against it directly — correct while both ends were always
 * entities, and silently wrong the moment one could be a file, because it would record every legitimate
 * file-ended edge as a link violation. One rule with two implementations, the weaker winning quietly, is the
 * defect class this repo produces most; the fix is to have one.
 */
export function isWellFormedRef(kind: RefKind, value: unknown): boolean {
  return kind === 'file' ? isSpaceRelativeFilePath(value) : isUuidV4(value);
}

/** The values of a reference field that are the wrong SHAPE for the kind it points at. */
function malformedRefs(kind: RefKind, values: readonly string[]): string[] {
  return values.filter(v => !isWellFormedRef(kind, v));
}

/**
 * Check one reference field. Returns `null` when every value has the right shape for its kind, otherwise a
 * message that names the field AND the offending values.
 *
 * The message matters as much as the check: the caller is usually an LLM agent, and "invalid
 * reference" tells it nothing it can act on, while "`entityIds` expects entity IDs (UUID v4), got
 * 'Traefik'" tells it exactly what to fix and how. Listing the bad values (not just the count) is what
 * makes the error self-correcting.
 */
export function invalidRefsMessage(field: string, kind: RefKind, values: readonly string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  const bad = malformedRefs(kind, values);
  if (bad.length === 0) return null;
  const shown = bad.slice(0, 5).map(v => JSON.stringify(v)).join(', ');
  const more = bad.length > 5 ? ` (+${bad.length - 5} more)` : '';
  // The UUID wording is byte-for-byte what it has always been: several suites assert that literal, and a
  // reworded refusal breaks them in waves — an assertion on its ABSENCE going vacuous rather than red.
  if (kind === 'file') {
    return `\`${field}\` expects ${REF_NOUN[kind]}s (space-relative, forward slashes), got ${shown}${more}. ` +
      `A file is referenced by its path inside the space, without a leading slash and without '..'.`;
  }
  return `\`${field}\` expects ${REF_NOUN[kind]}s (UUID v4), got ${shown}${more}. ` +
    `Look the record up by name first and pass its id — a name is not a reference.`;
}

/** Throwing form, for the MCP handlers whose errors surface to the agent as `isError` text. */
export function assertRefs(field: string, kind: RefKind, values: readonly string[] | undefined): void {
  const msg = invalidRefsMessage(field, kind, values);
  if (msg) throw new Error(msg);
}

const COLLECTION_FOR: Record<RefKind, string> = {
  entity: 'entities',
  fact: 'facts',
  chrono: 'chrono',
  // A file's meta record, keyed by the same space-relative path the reference carries — which is why the
  // existence check below works unchanged for files: it is still one `$in` on `_id`.
  file: 'files',
};

/**
 * The collection a reference of this kind resolves in, as a suffix on the space id.
 *
 * Exported for the same reason as {@link isWellFormedRef}: sync's link-violation check looked every edge
 * endpoint up in `${spaceId}_entities` by name, so the collection to search was decided in two places. It is
 * decided here.
 */
export function collectionForRefKind(kind: RefKind): string {
  return COLLECTION_FOR[kind];
}

/**
 * The published JSON schema for one edge endpoint's kind, for the MCP tools.
 *
 * Built here, from `REF_KINDS`, and shared by `save_edge` and `update_edge` — because the same four
 * strings written out in two tool schemas is how `traverse` came to accept three flags on one tool and refuse
 * them on the other, with `additionalProperties: false` turning the omission into a refused call that REST
 * answered 200 for. The description is part of the shared definition for the same reason: a tool's schema
 * description is what a caller reads while constructing arguments, so two copies means one of them is the
 * stale one somebody believes.
 */
export function edgeEndpointKindSchema(endpoint: 'from' | 'to'): Record<string, unknown> {
  return {
    type: 'string',
    enum: [...REF_KINDS],
    description:
      `What kind of record \`${endpoint}\` points at. Omit for an entity, which is what it has always meant `
      + 'and what almost every edge means — an omitted value is stored as nothing at all, not as "entity". '
      + 'Set it to link a memory, a chrono entry or a file: the meta record of a party photo can point at '
      + 'the people in '
      + `it (entity), the party (chrono) and what happened there (memory). An \`${endpoint}\` of kind \`file\` `
      + 'is the space-relative PATH, not a UUID; every other kind is a UUID v4. A kind that is stated and '
      + 'wrong is refused at the write rather than stored as a dead link.',
  };
}

/**
 * The human-readable field of each kind of record — what a reader would call it.
 *
 * `file` is absent because a file's `_id` IS its path, so there is nothing to look up. The type says so, which
 * is why every caller has to rule `file` out before asking.
 */
const NAME_FIELD: Record<Exclude<RefKind, 'file'>, string> = {
  entity: 'name',
  fact: 'fact',
  chrono: 'title',
};

/**
 * The field to project when resolving a reference to something a person can read.
 *
 * Here rather than beside its first caller because it has two: the edge embedder, which turns endpoints into
 * the text an edge is embedded from, and the edge list route, which turns them into what the Edges table
 * shows. The list route used to project `name` from the entities collection for both endpoints — correct
 * while every endpoint was an entity, and a bare UUID on screen once one could be a chrono entry.
 */
export function endpointNameField(kind: Exclude<RefKind, 'file'>): string {
  return NAME_FIELD[kind];
}

/**
 * The value to STORE for an endpoint kind: `undefined` for an entity, the kind itself otherwise.
 *
 * One canonical representation, and it is not cosmetic. `absent means entity` is the reading everywhere, so a
 * stored explicit `'entity'` and an absent field describe the same edge — and three separate things then
 * disagree about whether they are one row:
 *
 *  - `edgeIdFor` derives ONE id for both, which is correct, so storing both is a duplicate key on `_id`;
 *  - the unique index on `(from, to, label, fromKind, toKind)` sees `null` and `'entity'` as different keys,
 *    so it would happily hold both;
 *  - `findEdgeByTriplet` filters on `null`, which matches a missing field and not an explicit `'entity'`, so an
 *    upsert would read one row and write the other.
 *
 * Normalising on the way in removes the disagreement at its source rather than teaching each of the three to
 * tolerate it.
 */
export function storedEdgeKind(kind: RefKind | undefined): RefKind | undefined {
  return kind === undefined || kind === 'entity' ? undefined : kind;
}

/** Read an edge endpoint's kind. Absent means `entity` — the one place that reading lives. */
export function edgeEndpointKind(kind: RefKind | undefined): RefKind {
  return kind ?? 'entity';
}

/**
 * Format check PLUS an existence check: every value must be the right SHAPE for its kind (a UUID v4, or a
 * space-relative path for a file) *and* name a record that is actually there.
 *
 * Format alone is not enough to satisfy "an unresolvable reference must be an error". A well-formed
 * UUID that points at nothing stores exactly as silently as a name did — the write succeeds, the link
 * dangles, and the only symptom is a traversal that later comes back empty. Checking existence is one
 * batched `$in` per field, which is a fair price on a single-record write for the guarantee that a
 * stored reference resolves.
 *
 * Deliberately NOT used by the bulk path: a bulk payload may legitimately reference a record created
 * earlier in the same payload, so checking against the database would reject valid forward references.
 * Bulk keeps the format check, and the `strictLinkage: false` escape hatch covers staged imports.
 */
export async function assertRefsResolve(
  spaceId: string,
  field: string,
  kind: RefKind,
  values: readonly string[] | undefined,
): Promise<void> {
  assertRefs(field, kind, values);
  if (!values || values.length === 0) return;
  const unique = [...new Set(values)];
  const docs = await col<{ _id: string }>(`${spaceId}_${COLLECTION_FOR[kind]}`)
    .find(asFilter<{ _id: string }>({ _id: { $in: unique } }), { projection: { _id: 1 } })
    .toArray();
  const found = new Set(docs.map(d => d._id));
  const missing = unique.filter(id => !found.has(id));
  if (missing.length === 0) return;
  const shown = missing.slice(0, 5).map(v => JSON.stringify(v)).join(', ');
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
  throw new Error(
    `\`${field}\` references ${missing.length} ${REF_NOUN[kind]}${missing.length === 1 ? '' : 's'} that ` +
    `do${missing.length === 1 ? 'es' : ''} not exist in space '${spaceId}': ${shown}${more}. ` +
    `Create the record first, then link it — the write was refused rather than stored with a dead link.`,
  );
}
