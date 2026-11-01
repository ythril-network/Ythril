/**
 * The knowledge-schema vocabulary: what a type schema IS, and the space meta that carries them.
 *
 * Split out of `types.ts` to keep that file off the god-file ratchet; new per-type schema fields belong here.
 * Re-exported from `types.ts`.
 *
 * **A leaf: it must import nothing of the server.** A cycle through `types.ts`'s re-export makes TypeScript silently degrade
 * the types involved to `any` while everything compiles clean. Same reason as `config/rights-shape.ts`. The one import is
 * `@ythril/schema`, which imports nothing of the server either.
 */

// ── Space meta / schema types ──────────────────────────────────────────────

/*
 * The schema vocabulary — the merge functions, `PropertySchema`, `TypeSchema`, the rules, `KNOWLEDGE_TYPES` and `SpaceMeta` — is
 * `@ythril/schema`'s (`schema/src/vocabulary.ts`), so an app that writes a schema imports the definition instead of copying it.
 * Re-exported here so every server module keeps reaching it by this path; `KNOWLEDGE_TYPES` is imported as well, because the
 * tuples below are built from it.
 */
import { KNOWLEDGE_TYPES } from '@ythril/schema';
import type { KnowledgeType } from '@ythril/schema';
export { NUMERIC_MERGE_FNS, BOOLEAN_MERGE_FNS, MERGE_FNS, KNOWLEDGE_TYPES } from '@ythril/schema';
export type {
  NumericMergeFn, BooleanMergeFn, MergeFn, PropertySchema, TypeSchema, SchemaRule, SpaceSchemaRule, ValidationMode, KnowledgeType,
  DatePassedPolicy, SpaceMeta,
} from '@ythril/schema';

/**
 * Every kind of record that can be embedded, recalled or retained — the knowledge types PLUS `file`.
 *
 * A file is not a knowledge type: it has no type field, so it can have no type schema and no schema-tier
 * retention window. It is still embedded, searched and retained at space level, hence two tuples.
 * Recall's result order does not depend on this tuple's order.
 */
export const RECORD_TYPES = [...KNOWLEDGE_TYPES, 'file'] as const;

/** A record kind, including `file`. Derived, so it cannot drift from the tuple. */
export type RecordType = typeof RECORD_TYPES[number];

/**
 * Where a knowledge type's documents live — the collection suffix, keyed by the singular type name.
 *
 * `KnowledgeType` is singular (`entity`) and the collection is plural (`<space>_entities`). Import this map
 * rather than open-coding it; it lives in this leaf so any module can import it without a cycle.
 */
// `as const satisfies` and not an annotation: the annotation widens every value to `string`, and then
// `BRAIN_COLLECTIONS` derives as `string[]` — which compiles and silently stops being a literal union, so
// every `Record<BrainCollection, X>` downstream loses its keys.
export const COLLECTION_SUFFIX = {
  entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono',
} as const satisfies Record<KnowledgeType, string>;

/**
 * The kinds of thing a record TOMBSTONE can be for — the knowledge types plus `link`, and never `file`.
 *
 * The key sets differ while the values look alike, so a map written for one reads as a map for any:
 *
 *   - `KnowledgeType` — carries a type schema.
 *   - `RecordType` — can be embedded, recalled or retained: the knowledge types plus `file`.
 *   - `TombstoneType` — this one: plus `link`, NOT `file` (a deleted file has `FileTombstoneDoc` and its own
 *     wire protocol with no `seq`).
 *
 * A link is deleted and must tombstone, or a peer undoes the delete next cycle; it is not a `RecordType`
 * because it is never embedded, recalled or retained. Keyed maps over this tuple matter: a
 * `Record<string, string>` let a link tombstone find no entry, delete nothing, and report success.
 */
export const TOMBSTONE_TYPES = [...KNOWLEDGE_TYPES, 'link'] as const;

/** What a record tombstone is for. Derived, so it cannot drift from the tuple. */
export type TombstoneType = typeof TOMBSTONE_TYPES[number];

/**
 * Where a TOMBSTONE's underlying document lives — derived from the knowledge map, like `RECORD_COLLECTION`.
 */
export const TOMBSTONE_COLLECTION = {
  ...COLLECTION_SUFFIX,
  link: 'links',
} as const satisfies Record<TombstoneType, string>;

/**
 * The inverse: a COLLECTION name back to the tombstone type stored in it.
 *
 * A wipe knows the collection (`facts`) and clears tombstones by `type` (`fact`). Derived, so the two
 * directions cannot disagree; `files`, with no tombstone type, is simply absent.
 */
export const TOMBSTONE_TYPE_OF = Object.fromEntries(
  TOMBSTONE_TYPES.map(t => [TOMBSTONE_COLLECTION[t], t]),
) as Record<string, TombstoneType | undefined>;

/**
 * The same map over RECORD types — the knowledge collections plus `files`.
 *
 * A separate map because a file has a collection but no type schema. Scanners and lexical search key by
 * record type; retention and the schema tier by knowledge type.
 */
export const RECORD_COLLECTION = {
  ...COLLECTION_SUFFIX,
  file: 'files',
} as const satisfies Record<RecordType, string>;

/**
 * Every collection a space's KNOWLEDGE lives in — the one shared list, and it derives from the map above.
 *
 * Not to be confused with:
 *
 *   - `SPACE_COLLECTIONS` (`spaces/_shared.ts`) — every collection a space OWNS, machinery included; the one
 *     that creates them.
 *   - `VECTOR_INDEXED_COLLECTIONS` (`spaces/vector-index.ts`) — this list minus anything never embedded, so
 *     it excludes `links` (no content to embed).
 *
 * `one-definition-of-the-collections.test.js` holds the rule: derive from here, or say in your own comment
 * that you are a deliberate subset and why.
 *
 * `links` is APPENDED rather than derived because a link is not a `RecordType` (never embedded, recalled or
 * retained); adding it there would hand it an embed builder, lexical field, recall projection and retention
 * bucket. `todo/_LINKS-AND-SCHEMA-TODOS.md` records this as the owner's to overturn.
 */
export const BRAIN_COLLECTIONS = [...RECORD_TYPES.map(t => RECORD_COLLECTION[t]), 'links'] as const;

/** One knowledge collection. */
export type BrainCollection = (typeof BRAIN_COLLECTIONS)[number];

/**
 * What kind of record a reference points AT.
 *
 * Deliberately not {@link KnowledgeType}, and the difference is not cosmetic: nothing points at an `edge`,
 * while a `file` is pointed at constantly and has no type schema. Three members are shared; each union has
 * one the other must not gain.
 *
 * Lives in `config/` because `EdgeDoc` needs it and `config/` must not import from `brain/`;
 * `brain/entity-refs.ts` re-exports it. The runtime list is the definition (the sync schema needs it) and the
 * type derives from it.
 */
export const REF_KINDS = ['entity', 'fact', 'chrono', 'file'] as const;

/** @see REF_KINDS — derived, never written out a second time. */
export type RefKind = typeof REF_KINDS[number];

/**
 * Is this a reference kind? The one membership test — a door, the batch and the contradiction surface each
 * spelled it as a cast-and-`includes`, and a copy that drops the `typeof` check reads any truthy value as a kind.
 */
export function isRefKind(value: unknown): value is RefKind {
  return typeof value === 'string' && (REF_KINDS as readonly string[]).includes(value);
}

/**
 * The WRITE FIELD a caller uses to link to each kind — `entity` → `linkEntities`, derived from the kind
 * vocabulary so a new kind gets its field on the day it is declared.
 *
 * Used by `write-connections.ts` (every door's schema) and by `brain/links.ts` (field names in refusals);
 * never build the name by hand — `link${kind}` yields `linkentity`, which no door accepts.
 */
export const LINK_INPUT_FIELDS: Readonly<Record<RefKind, string>> = Object.freeze(
  Object.fromEntries(REF_KINDS.map(k => {
    const capital = k.charAt(0).toUpperCase() + k.slice(1);
    return [k, `link${capital.endsWith('y') ? `${capital.slice(0, -1)}ies` : `${capital}s`}`];
  })) as Record<RefKind, string>,
);



/**
 * A recorded disagreement between a record's own timestamp and the server's write time.
 *
 * Present on a record ONLY when the disagreement exceeded the space's threshold, so
 * `{ stampSkew: { $exists: true } }` is a cheap integrity query. See `brain/stamp-skew.ts`.
 */
export interface StampSkew {
  /** The property the stamp came from, so a warning can name it. */
  property: string;
  /** The stamp as the caller wrote it — quoted back verbatim, because the point is that it LOOKS right. */
  stamp: string;
  /** Signed: negative means the caller's stamp is EARLIER than the server's write. */
  skewMs: number;
  /** The threshold that was applied, so a stored record carries what it was judged against. */
  thresholdMs: number;
}

/**
 * Carried by every record type the stamp check runs on — facts, entities, edges and chrono.
 *
 * Extend this rather than copying the field: a new record type that forgot the field would look exactly like
 * a record whose stamp agreed.
 */
export interface StampSkewable {
  /**
   * Set only when this record's own timestamp property disagreed with the server's `createdAt` beyond the space's
   * threshold. ABSENT means agreed, not checked, or the check is off — presence is the signal, which is what makes
   * `{ stampSkew: { $exists: true } }` a useful query. See `brain/stamp-skew.ts`.
   */
  stampSkew?: StampSkew;
}
