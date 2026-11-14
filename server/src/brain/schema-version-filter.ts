/**
 * What predicate does the filter's `schemaVersion` argument mean in one member space, and how many of its matches cannot be classified
 * (bundle-267, Q-741; design r1 "Q-741", r2 "Filter meaning", r3 §3)?
 *
 * ## The question it answers
 *
 * A caller asks for records by the schema version they carry (their stamp); `brain/schema-version-args.ts` declares and reads the ask.
 * It is resolved PER MEMBER, because "current" is a member's own: through a personal view each member answers against its own current
 * version. Per member M, with current version C (read from the config, never from a row that can lag):
 *
 * - `current`: stamped C. `<fingerprint>`: stamped with it. `unversioned`: no stamp here.
 * - `older`: per stamp F the collection carries, F not C, the records of the types the diff of F against C changes in the asked class
 *   (`spaces/schema-diff.ts`, with its space-rule and allowlist reach), plus every F this server (or a peer-bound caller) does not hold or
 *   cannot classify; placed by the one standing pass (`spaces/type-standing.ts`), so the type history's older mark reads the same stamps.
 *   Shaped fingerprint-first and left unhinted, so the stamp index serves it (probe 2, E2).
 * - `sameAs:<fp>` (bundle-268): the records stamped `fp`, and per other stamp the records whose type it defines as `fp` does (`any`).
 *
 * ## What it prevents (the forgettable parts, kept inside)
 *
 * - **`older` widened to unversioned records.** Every branch of it names a stamp, so a record without one is never matched: it has no
 *   version to be older than, and `unversioned` is the ask for it.
 * - **A version resolved once for a view.** {@link schemaVersionResolver} resolves per member and memoises per member for one call, so
 *   the read, the total and the echo use one resolution and two members never share one current version.
 * - **A predicate merged by assignment.** The resolution is a clause ANDed with the caller's (`andPredicates`, `db/and-predicates.ts`), never keys spread over
 *   the caller's filter, which would replace a caller's own stamp clause or `$or`.
 * - **"Older" silently meaning "older or unknown".** {@link schemaVersionEcho} counts, per member and over the whole match (not the page),
 *   the matches whose version is not held or not classifiable.
 * - **A version's text read on every call.** Whether a version is held is read without its text (`heldVersionsKept`); a stamp's placement is
 *   memoised by the standing pass, so a text is read only for a stamp not placed yet (design r3 §5.3).
 * - **A record whose type no reader can name left out.** A stamp a record of which has a type that is not a string (`unnamed`, R2) is older
 *   and unclassified whole, counted in the echo, never dropped.
 * - **A caller's scope left out.** The resolver takes the networks a peer-bound caller shares each member in: a version it may not have is
 *   not held for it.
 * - **A store failure answered as "no match".** Every read here throws on failure, a missing stamp index as 503 `schema_index_building`, a
 *   placement past `maxTimeMS` as 503 `schema_versions_busy`; nothing is caught.
 */
import type { BrainCollection } from '../config/types.js';
import { andPredicates } from '../db/and-predicates.js';
import { stampTypeFieldOf, type StampedCollection } from '../spaces/schema-snapshot-carried.js';
import { heldVersionsKept } from '../spaces/schema-version-text.js';
import type { SchemaChangedMode } from '../spaces/schema-diff.js';
import { kindStandingsIn, passTimeLeft, type PassScope } from '../spaces/type-standing.js';
import { variationOf, EMPTY_SCHEMA_FINGERPRINT, SCHEMA_FINGERPRINT_FIELD } from '../spaces/schema-stamp.js';
import { isStampedCollection, type SchemaVersionAsk } from './schema-version-args.js';
import { countBrain } from './query.js';

/** One member's resolution: the clause to AND, the member's current version, and the fingerprints among its matches it cannot classify. */
export interface SchemaVersionResolution {
  readonly clause: Record<string, unknown>;
  readonly current: string;
  readonly unclassified: readonly string[];
}

/** A clause no record matches, answered from the stamp index like the rest. */
const NOTHING = { [SCHEMA_FINGERPRINT_FIELD]: { $in: [] } };

/** A clause of `branches`: none matches nothing, one is itself, more are an `$or`. */
const anyOf = (branches: Record<string, unknown>[]): Record<string, unknown> =>
  (branches.length === 0 ? NOTHING : branches.length === 1 ? branches[0]! : { $or: branches });

/**
 * The `older` clause of one member, off the shared standing pass (`spaces/type-standing.ts`, design r4 §3.1): every stamp that is `all`,
 * `unclassified` or `notHeld` whole, and per stamp with a changed set its records of those types. Fingerprint-first branches, every one naming
 * a stamp, so no unversioned record is matched. A type in a changed set with no record under the stamp matches nothing, so no carried-types
 * read is needed. While the stamp index may hold an array type, a type branch is guarded (an array that holds a changed name is no record of
 * it); a stamp with such a record is unclassified anyway, by R2.
 */
async function olderIn(spaceId: string, collection: StampedCollection, mode: SchemaChangedMode, current: string, scope: PassScope): Promise<SchemaVersionResolution> {
  const { fps, mayHoldArrays } = await kindStandingsIn(spaceId, collection, current, mode, scope);
  const typeField = stampTypeFieldOf(collection);
  const whole: string[] = [];
  const unclassified: string[] = [];
  const branches: Record<string, unknown>[] = [];
  for (const [fp, s] of fps) {
    if (s === 'notHeld' || s === 'unclassified') { whole.push(fp); unclassified.push(fp); continue; }
    if (s === 'all') { whole.push(fp); continue; }
    if (s === 'same') continue;
    branches.push({ [SCHEMA_FINGERPRINT_FIELD]: fp, [typeField]: { $in: [...s].sort(), ...(mayHoldArrays ? { $not: { $type: 'array' } } : {}) } });
  }
  if (whole.length > 0) branches.push({ [SCHEMA_FINGERPRINT_FIELD]: { $in: whole.sort() } });
  return { clause: anyOf(branches), current, unclassified: unclassified.sort() };
}

/**
 * The `sameAs:<fp>` clause of one member (design r3 §1 `sameAsIn`, r4 §3.2): the records stamped `fp` itself, and per other stamp the records
 * whose type that stamp defines as `fp` does under `any` - a stamp standing `same` whole, one with a changed set its records of every other
 * type (untyped ones included). A version this caller may not have, or this server does not hold, decides nothing: as the anchor it matches
 * only its own records (and is counted unclassified), as a stamp it matches none.
 */
async function sameAsIn(spaceId: string, collection: StampedCollection, anchor: string, current: string, scope: PassScope): Promise<SchemaVersionResolution> {
  const { anchorHeld, fps } = await kindStandingsIn(spaceId, collection, anchor, 'any', scope);
  const typeField = stampTypeFieldOf(collection);
  const whole: string[] = [anchor];
  const branches: Record<string, unknown>[] = [];
  for (const [fp, s] of fps) {
    if (s === 'same') whole.push(fp);
    else if (typeof s !== 'string') branches.push({ [SCHEMA_FINGERPRINT_FIELD]: fp, [typeField]: { $nin: [...s].sort() } });
  }
  branches.push({ [SCHEMA_FINGERPRINT_FIELD]: { $in: whole.sort() } });
  return { clause: anyOf(branches), current, unclassified: anchorHeld ? [] : [anchor] };
}

/** One member's resolution of `ask` on `collection`. Throws on any store failure; never answers a failed read as an empty clause. */
async function resolveIn(
  spaceId: string, collection: StampedCollection, ask: SchemaVersionAsk, maxTimeMS: number, shared: ReadonlySet<string> | undefined,
): Promise<SchemaVersionResolution> {
  const current = variationOf(spaceId)?.stamp.fp ?? EMPTY_SCHEMA_FINGERPRINT;
  const scope = (): PassScope => ({ shared, timeLeft: passTimeLeft(spaceId, maxTimeMS) });
  switch (ask.kind) {
    case 'current': return { clause: { [SCHEMA_FINGERPRINT_FIELD]: current }, current, unclassified: [] };
    case 'unversioned': return { clause: { [SCHEMA_FINGERPRINT_FIELD]: { $exists: false } }, current, unclassified: [] };
    case 'fingerprint': {
      // Held is all this asks: the text is left out of the read.
      const held = (await heldVersionsKept(spaceId, [ask.fp])).has(ask.fp);
      return { clause: { [SCHEMA_FINGERPRINT_FIELD]: ask.fp }, current, unclassified: held ? [] : [ask.fp] };
    }
    case 'older': return olderIn(spaceId, collection, ask.mode, current, scope());
    case 'sameAs': return sameAsIn(spaceId, collection, ask.fp, current, scope());
  }
}

/**
 * A per-call resolver: each member is resolved once (the read, the total and the echo share it), and every member on its own, for the caller
 * `sharedOf` names per member (the networks a peer-bound token shares that member in; `undefined` for a local caller: required, so no door
 * resolves `older` or `sameAs` out of its caller's scope). The collection must be one `readSchemaVersionAsk` admitted.
 */
export function schemaVersionResolver(
  collection: string, ask: SchemaVersionAsk, maxTimeMS: number, sharedOf: (spaceId: string) => ReadonlySet<string> | undefined,
): (spaceId: string) => Promise<SchemaVersionResolution> {
  if (!isStampedCollection(collection)) throw new Error(`schemaVersion applies to a collection whose records carry a stamp, not '${collection}'.`);
  const memo = new Map<string, Promise<SchemaVersionResolution>>();
  return (spaceId) => {
    let held = memo.get(spaceId);
    if (!held) { held = resolveIn(spaceId, collection, ask, maxTimeMS, sharedOf(spaceId)); memo.set(spaceId, held); }
    return held;
  };
}

/** The answer's `schemaVersion`: per member, its current version and how many of its matches carry a version it cannot classify. */
export interface SchemaVersionEcho {
  readonly members: { spaceId: string; current: string; unclassified: number }[];
}

/**
 * The echo for `members`, each counted over its WHOLE match (`predicateFor`, the predicate its rows were read with) narrowed to the
 * fingerprints it cannot classify; no count is run for a member with none.
 */
export async function schemaVersionEcho(
  members: readonly string[], collection: BrainCollection, resolve: (spaceId: string) => Promise<SchemaVersionResolution>,
  predicateFor: (spaceId: string) => Promise<Record<string, unknown>>, maxTimeMS: number,
): Promise<SchemaVersionEcho> {
  return { members: await Promise.all(members.map(async (spaceId) => {
    const { current, unclassified: fps } = await resolve(spaceId);
    const unknown = { [SCHEMA_FINGERPRINT_FIELD]: { $in: [...fps] } };
    const unclassified = fps.length === 0 ? 0 : await countBrain(spaceId, collection, andPredicates(await predicateFor(spaceId), unknown) ?? {}, maxTimeMS);
    return { spaceId, current, unclassified };
  })) };
}
