/**
 * What the filter's schema-version arguments are, and what a caller sent in them (bundle-267, Q-741; design r1 "Q-741", r3 §3).
 *
 * ## The question it answers
 *
 * "Which arguments ask for records by schema version, how are they described, and is what the caller sent one the filter can mean?" The
 * declarations and the read live here; what an ask resolves to in a member space is `brain/schema-version-filter.ts`. They are two modules
 * because the REST body's field list (`QUERY_BODY_FIELDS` in `brain/query.ts`) reads the names, and the resolution counts through
 * `brain/query.ts`: one module would be an import cycle.
 *
 * ## What it prevents
 *
 * - **A parameter on one door only.** {@link SCHEMA_VERSION_FILTER_KEYS} is spread into the REST body fields and
 *   {@link SCHEMA_VERSION_FILTER_SCHEMA} into the tool schema, so the two cannot take different names.
 * - **An argument the collection cannot mean, ignored.** `files` and `links` carry no stamp: `schemaVersion` there is refused by name, as
 *   are a malformed fingerprint and `schemaChanged` without `older` ({@link readSchemaVersionAsk}). Ignoring one would answer every
 *   record to a caller who believes they narrowed.
 */
import { STAMPED_COLLECTIONS, type StampedCollection } from '../spaces/schema-snapshot-carried.js';
import type { SchemaChangedMode } from '../spaces/schema-diff.js';
import { isSchemaFingerprint, SCHEMA_FINGERPRINT_FIELD } from '../spaces/schema-stamp.js';

/** The words `schemaVersion` takes besides a fingerprint. */
const VERSION_WORDS = ['current', 'older', 'unversioned'] as const;

/** What `schemaChanged` takes; `structural` when it is not sent. */
const CHANGE_MODES: readonly SchemaChangedMode[] = ['structural', 'any'];

/** The two arguments, as one list: the tool schema and the REST body fields read it, so neither door can take one the other refuses. */
export const SCHEMA_VERSION_FILTER_KEYS = ['schemaVersion', 'schemaChanged'] as const;

/** The two arguments' declarations, spread into the filter tool's input schema. */
export const SCHEMA_VERSION_FILTER_SCHEMA = {
  schemaVersion: {
    type: 'string',
    description: `Only records carrying this schema version (the \`${SCHEMA_FINGERPRINT_FIELD}\` stamp a conforming write leaves). \`current\`: `
      + 'the space\'s current version. A 64-hex fingerprint: that version. `unversioned`: records with no stamp here, that is no conforming '
      + 'checked write here since 6.6 and none arrived with a valid stamp; it reads the whole collection. `older`: records whose version '
      + 'differs from the current one for their type (see `schemaChanged`), plus records of a version this server does not hold or cannot '
      + 'classify; never an unversioned record. `older` reads the version index of each member\'s collection, plus the matching records; '
      + 'under a selective `filter` the default order can walk the collection\'s position index, bounded by `maxTimeMS`. Resolved per '
      + 'member: through a personal view each member answers against its own current version. The answer then carries '
      + '`schemaVersion: {members: [{spaceId, current, unclassified}]}`: `unclassified` counts the matching records, over the whole match, '
      + 'whose version is not held or not classifiable. A record that arrives mid-call with a new version can be missed by that call. '
      + 'Entities, facts, edges and chrono only: `files` and `links` carry no stamp and refuse it.',
  },
  schemaChanged: {
    type: 'string',
    enum: [...CHANGE_MODES],
    description: 'With `schemaVersion: "older"` only: which changes make a record older. `structural` (default): a change that can alter '
      + 'whether the record conforms (a property type, a pattern, a rule, a type or property added or removed). `any`: wording, write and '
      + 'lifecycle changes too. Per type either way: a type defined the same in both versions is never older.',
  },
} as const;

/** What the caller asked, read: a word or a fingerprint, and the change mode `older` uses. */
export type SchemaVersionAsk =
  | { readonly kind: 'current' | 'unversioned' }
  | { readonly kind: 'older'; readonly mode: SchemaChangedMode }
  | { readonly kind: 'fingerprint'; readonly fp: string };

/** Whether `collection`'s records carry a stamp. */
export const isStampedCollection = (collection: string): collection is StampedCollection => (STAMPED_COLLECTIONS as readonly string[]).includes(collection);

/**
 * The caller's `schemaVersion` / `schemaChanged`, read, or the refusal naming the argument: on a collection with no stamp, a value that is
 * neither a word nor a 64-hex fingerprint, and `schemaChanged` without `older`. `undefined` when neither was sent.
 */
export function readSchemaVersionAsk(collection: string, args: Record<string, unknown>): { ask: SchemaVersionAsk | undefined } | { error: string } {
  const version = args['schemaVersion'];
  const changed = args['schemaChanged'];
  if (version === undefined && changed === undefined) return { ask: undefined };
  if (version !== undefined && !isStampedCollection(collection)) {
    return { error: `schemaVersion applies to ${STAMPED_COLLECTIONS.join(', ')} only, not '${collection}': its records carry no schema version.` };
  }
  if (version !== undefined && (typeof version !== 'string' || !((VERSION_WORDS as readonly string[]).includes(version) || isSchemaFingerprint(version)))) {
    return { error: `schemaVersion must be ${VERSION_WORDS.join(', ')} or a schema fingerprint (64 lowercase hex characters).` };
  }
  if (changed !== undefined && version !== 'older') {
    return { error: 'schemaChanged applies with schemaVersion: "older" only: it says which changes make a record older.' };
  }
  if (changed !== undefined && !(CHANGE_MODES as readonly unknown[]).includes(changed)) {
    return { error: `schemaChanged must be one of: ${CHANGE_MODES.join(', ')}.` };
  }
  if (version === 'older') return { ask: { kind: 'older', mode: (changed as SchemaChangedMode | undefined) ?? 'structural' } };
  if (version === 'current' || version === 'unversioned') return { ask: { kind: version } };
  return { ask: { kind: 'fingerprint', fp: version as string } };
}
