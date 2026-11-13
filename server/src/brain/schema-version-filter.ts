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
 * - `older`: each (stamp F, type T) pair the collection carries, F not C, where the diff of F against C changes T in the asked class
 *   (`spaces/schema-diff.ts`, with its space-rule and allowlist reach), plus every F this server does not hold or cannot classify. Shaped
 *   fingerprint-first and left unhinted, so the stamp index serves it (probe 2, E2).
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
 * - **A store failure answered as "no match".** Every read here throws on failure (`fingerprintTypesIn`, `heldVersions`, the count), a
 *   missing stamp index as 503 `schema_index_building`; nothing is caught.
 */
import type { BrainCollection } from '../config/types.js';
import { andPredicates } from '../db/and-predicates.js';
import { stampedKindOf, stampTypeFieldOf, fingerprintTypesIn, type StampedCollection } from '../spaces/schema-snapshot-carried.js';
import { heldVersions } from '../spaces/schema-version-text.js';
import { typesDifferingUnder, type SchemaChangedMode } from '../spaces/schema-diff.js';
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

/** The `older` clause of one member: fingerprint-first branches, every one naming a stamp, so no unversioned record is matched. */
async function olderIn(spaceId: string, collection: StampedCollection, mode: SchemaChangedMode, current: string, maxTimeMS: number): Promise<SchemaVersionResolution> {
  const pairs = await fingerprintTypesIn(spaceId, collection, { maxTimeMS });
  const typesOf = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (p.fp === current) continue;
    const types = typesOf.get(p.fp) ?? new Set<string>();
    if (p.type !== null) types.add(p.type);
    typesOf.set(p.fp, types);
  }
  const held = await heldVersions(spaceId, [current, ...typesOf.keys()]);
  const currentText = held.get(current)?.text;
  const kind = stampedKindOf(collection);
  const typeField = stampTypeFieldOf(collection);
  const whole: string[] = [];
  const unclassified: string[] = [];
  const branches: Record<string, unknown>[] = [];
  for (const [fp, present] of typesOf) {
    const text = held.get(fp)?.text;
    const differ = text !== undefined && currentText !== undefined ? typesDifferingUnder(text, currentText, mode) : undefined;
    if (!differ || differ.unclassified) { whole.push(fp); unclassified.push(fp); continue; }
    const types = differ.kinds.get(kind);
    if (types === undefined) continue;
    if (types === 'all') { whole.push(fp); continue; }
    const named = [...present].filter(t => types.has(t)).sort();
    if (named.length > 0) branches.push({ [SCHEMA_FINGERPRINT_FIELD]: fp, [typeField]: { $in: named } });
  }
  if (whole.length > 0) branches.push({ [SCHEMA_FINGERPRINT_FIELD]: { $in: whole.sort() } });
  const clause = branches.length === 0 ? NOTHING : branches.length === 1 ? branches[0]! : { $or: branches };
  return { clause, current, unclassified };
}

/** One member's resolution of `ask` on `collection`. Throws on any store failure; never answers a failed read as an empty clause. */
async function resolveIn(spaceId: string, collection: StampedCollection, ask: SchemaVersionAsk, maxTimeMS: number): Promise<SchemaVersionResolution> {
  const current = variationOf(spaceId)?.stamp.fp ?? EMPTY_SCHEMA_FINGERPRINT;
  switch (ask.kind) {
    case 'current': return { clause: { [SCHEMA_FINGERPRINT_FIELD]: current }, current, unclassified: [] };
    case 'unversioned': return { clause: { [SCHEMA_FINGERPRINT_FIELD]: { $exists: false } }, current, unclassified: [] };
    case 'fingerprint': {
      const held = (await heldVersions(spaceId, [ask.fp])).has(ask.fp);
      return { clause: { [SCHEMA_FINGERPRINT_FIELD]: ask.fp }, current, unclassified: held ? [] : [ask.fp] };
    }
    case 'older': return olderIn(spaceId, collection, ask.mode, current, maxTimeMS);
  }
}

/**
 * A per-call resolver: each member is resolved once (the read, the total and the echo share it), and every member on its own. The
 * collection must be one `readSchemaVersionAsk` admitted.
 */
export function schemaVersionResolver(collection: string, ask: SchemaVersionAsk, maxTimeMS: number): (spaceId: string) => Promise<SchemaVersionResolution> {
  if (!isStampedCollection(collection)) throw new Error(`schemaVersion applies to a collection whose records carry a stamp, not '${collection}'.`);
  const memo = new Map<string, Promise<SchemaVersionResolution>>();
  return (spaceId) => {
    let held = memo.get(spaceId);
    if (!held) { held = resolveIn(spaceId, collection, ask, maxTimeMS); memo.set(spaceId, held); }
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
