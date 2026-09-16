/**
 * The knowledge-schema vocabulary: what a type schema IS, and the space meta that carries them.
 *
 * ## Why this is its own file, and why it imports nothing
 *
 * Split out of `types.ts` (Q-3). That file is the config contract for every subsystem — spaces, networks, media,
 * embedding, auth, sync — and it took FOUR god-file ratchet raises in two days, each individually correct and
 * each one line of honest type. A file that keeps growing is not fixed by raising its ceiling a fifth time;
 * `no-new-god-files.test.js` says so in as many words.
 *
 * **A leaf, deliberately.** Nothing here imports anything, which is the whole point: the first attempt at this
 * split moved the network types out and re-exported them, and `NetworkConfig` references `SpaceMeta`. With
 * `types.ts` re-exporting the new file and the new file importing `SpaceMeta` back, that is a module cycle —
 * TypeScript resolved it by degrading `NetworkConfig` to `any`, and `api/invite.ts` lost the types on three
 * `members` callbacks while both moved files compiled clean. A leaf cannot be half of a cycle.
 *
 * Same reasoning as `config/rights-shape.ts`, which exists for exactly this and for the same reason.
 *
 * ## What lives here
 *
 * The vocabulary a schema is written in — merge functions, `PropertySchema`, `TypeSchema` — plus
 * `ValidationMode`, `KnowledgeType`, and `SpaceMeta`, which is the thing that holds the schemas. This is also
 * where per-type schema fields now GROW: the next one is `suppressEmbeddings` (Q-2), and it lands here rather
 * than adding a fifth raise to `types.ts`.
 *
 * Re-exported from `types.ts`, so no importer changes.
 */

// ── Space meta / schema types ──────────────────────────────────────────────

/**
 * The merge functions, as RUNTIME lists with the types derived from them.
 *
 * A union is erased, so every place that has to enumerate these wrote them out again -- and three did: the
 * validator in `brain/merge.ts` kept two `Set`s of them, and the space-schema body kept a `z.enum`. Four
 * copies of a seven-word vocabulary, and the one that matters is the validator: a function accepted by the
 * schema and unknown to it is a merge that refuses a value the UI offered.
 *
 * The list is the declaration and the type follows it, the same way `RUNGS` works in `auth/space-rights.ts`.
 */
export const NUMERIC_MERGE_FNS = ['avg', 'min', 'max', 'sum'] as const;

/** Boolean merge functions available for `type: "boolean"` properties. */
export const BOOLEAN_MERGE_FNS = ['and', 'or', 'xor'] as const;

/** Every merge function, in the order the two families are offered. */
export const MERGE_FNS = [...NUMERIC_MERGE_FNS, ...BOOLEAN_MERGE_FNS] as const;

/** Numeric merge functions available for `type: "number"` properties. */
export type NumericMergeFn = (typeof NUMERIC_MERGE_FNS)[number];

/** Boolean merge functions available for `type: "boolean"` properties. */
export type BooleanMergeFn = (typeof BOOLEAN_MERGE_FNS)[number];

/** All merge functions (numeric + boolean). */
export type MergeFn = NumericMergeFn | BooleanMergeFn;

/** Subset of JSON Schema used for property value validation. */
export interface PropertySchema {
  /** Declared value type. 'date' is stored as ISO string; UI renders a date picker. */
  type?: 'string' | 'number' | 'boolean' | 'date';
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  /** Merge function applied when two entities are merged and both have this property.
   *  Numeric: avg, min, max, sum. Boolean: and, or, xor.
   *  Must be compatible with the declared `type`. */
  mergeFn?: MergeFn;
  /** When true, writes that omit this property are flagged as a schema violation. */
  required?: boolean;
  /** Default value applied on write when the property is absent. */
  default?: string | number | boolean;
}

/** Schema definition for a single entity type, edge label, memory type, or chrono type. */
export interface TypeSchema {
  /**
   * Reference to an instance-level schema library entry.
   * Format: `"library:<name>"` (e.g. `"library:service-v1"`).
   * When present, the library entry's schema is used for validation instead of any
   * inline fields.  Inline fields on the same object are ignored when `$ref` is set.
   */
  $ref?: string;
  /**
   * @internal Set by resolveMetaRefs() when a `$ref` cannot be resolved to a library entry.
   * Never present in stored config; only exists on in-memory resolved copies.
   * Causes validate* functions to emit a schema_ref_unresolved violation.
   */
  _unresolvedRef?: string;
  /** Regex pattern for entity.name validation (entity collection only). */
  namingPattern?: string;
  /**
   * How long records of this type are kept. The middle tier of **record > schema > space**
   * (owner decision, 2026-08-02).
   *
   * A space-wide `recordTtlDays` cannot express a space that holds two kinds of thing. The case that drove
   * it: one space with deploy `event` chronos — content-free by design, so they cluster tightly and
   * **displace real answers in recall** — next to `health-snapshot` records that exist to be trended and must
   * outlive any prune window. Putting the window on the TYPE puts it where the type is already defined,
   * rather than in a second parallel map an operator has to know exists.
   *
   * - `days` — delete records of this type after this many days, through the normal delete path, so the
   *   deletion tombstones and propagates to peers.
   * - `contentDays` — **chrono only.** Drop the bulky, recallable part (`description`, `matchedText`,
   *   `properties` and the embedding) while keeping the record, and set `contentRedacted: true`. That a
   *   deploy happened stays true; the detail does not, and it stops competing in semantic search because a
   *   record with no vector cannot win one. Rejected on other collections rather than silently ignored.
   *
   * A per-record `ttlDays` on the write still wins over both, including `0`/`null` for "never expire".
   *
   * **This lives in space meta, so it is governed and replicated** like the rest of the schema: in a network
   * the policy is agreed, and each instance then expires its own copy locally. That is deliberate — the
   * alternative (a local-only setting) lets two members of one network disagree about what the space keeps.
   */
  retention?: { days?: number; contentDays?: number };
  /**
   * **Chrono only.** What a PASSED due moment means for records of this type. Absent is today's behaviour.
   *
   * `overdue` (the default) derives `overdue` on read once the due moment is behind us. `nothing` returns
   * the STORED status instead — for a type whose records are events that OCCURRED rather than deadlines,
   * where a past date is the normal condition and means the opposite of late.
   *
   * The middle tier of **schema > space**, matching `retention` and `suppressEmbeddings`. There is no record
   * tier on purpose: the meaning of a past date belongs to the KIND of thing, not to one instance of it.
   *
   * `brain/chrono-date-policy.ts` owns the resolution and says why the value is a string rather than a
   * boolean, and why a multi-rung ladder was considered and not built.
   */
  whenDuePasses?: DatePassedPolicy;
  /** Property key → JSON Schema subset for value validation and merge hints. */
  propertySchemas?: Record<string, PropertySchema>;
  /**
   * Skip embedding records of this type. Absent means **not stated**, which falls through to the space-wide
   * setting — it does NOT mean `false`.
   *
   * That distinction is the whole design. If absent read as "do not suppress", `SpaceMeta.suppressEmbeddings`
   * would do nothing for any type that had a schema at all, which is every type worth suppressing. The
   * resolution order is record > schema > space, matching `retention` rather than inventing a second order;
   * `brain/suppress-embeddings.ts` owns it and is tested against exactly this case.
   *
   * Asked for by an operator whose records are **state rather than prose**: a queue row whose name and
   * description never change, whose weight is PATCHed every tick, and which nobody will ever search for by
   * meaning. Each write re-embedded byte-identical text to produce a vector that already existed.
   *
   * **Turning it back on does not backfill.** Records written while it was on have no vector, and nothing
   * revisits them — see the `POST /api/spaces/:id/reembed` note in the API docs. Stated here because an
   * operator flipping this off would otherwise reasonably assume recall recovers on its own.
   */
  suppressEmbeddings?: boolean;
  /**
   * What KIND of thing may sit at each end of an edge with this label. **Edge collection only** — rejected on
   * entity, memory and chrono the way `retention.contentDays` is rejected off chrono, rather than silently
   * ignored.
   *
   * ## Each side is independently optional, and that is what keeps it usable
   *
   * Absent means unconstrained. `{ from: ['person'] }` pins the subject of `likes` and leaves the object open,
   * which is the ordinary case: in our own fourteen-label benchmark model `likes`/`dislikes` permit seven of
   * nine types on `to`, and a rule that has to enumerate seven of nine is not a rule — it is a list somebody
   * will forget to extend.
   *
   * ## Two arrays mean the CROSS PRODUCT, and that is the semantics rather than a gap
   *
   * Owner ruling, 2026-08-31. `belongs_to` may be `document -> project` and `person -> team` in one space, and
   * declaring `from: ['document', 'person'], to: ['project', 'team']` also permits `document -> team`. The
   * owner: *"no need for restriction. thats obvious logic during definition. if they really want to make sure
   * 1-1 they need to define multiple edge schemas."*
   *
   * So a caller who needs exactly one pair declares a label per pair, which they can already do. **Do not add
   * a pairs form**: it was considered and declined, and reopening it needs a new reason rather than this one.
   *
   * ## The member vocabulary
   *
   * Entity type names, in exactly the vocabulary `er_model` prints — plus an explicit `UNTYPED` bucket, because
   * untyped entities are real and must be admissible by SAYING so rather than by being refused in silence.
   *
   * A member may be written `entity:<type>`; a bare name means `entity:`. Any other `KnowledgeType` prefix is
   * refused at the Zod layer with a message naming why, so the set can widen if memory or chrono links ever
   * become edges without the grammar having to change.
   */
  endpoints?: { from?: string[]; to?: string[] };
  /**
   * At most one edge with this label per subject: one `(from, label)` may hold one `to`.
   *
   * ## Why that meaning and not one of the other two
   *
   * The word is borrowed from its established sense — a functional property has at most one value per subject —
   * and the two alternatives do not survive contact with this schema. *Per `(from, to)`* is already guaranteed
   * by the unique index on edge identity, so declaring it would mean nothing. *Per `to`* is the inverse
   * relation, which has its own name everywhere it exists, and conflating the two would leave an operator
   * unable to say which they meant.
   *
   * The case: `reports_to` is functional (one manager) while `works_with` is not, and today nothing can express
   * the difference — so a second `reports_to` from the same person stores silently beside the first and both
   * are returned as fact.
   *
   * ## Reported or refused follows the space, like every other schema rule
   *
   * Not a new switch. `validationMode` already decides `off` / `warn` / `strict` for every rule in this object,
   * and a cardinality rule is not special enough to invent a second control an operator has to find. `warn` is
   * what the deferred consumer expects: `_REFERENCE.md` holds insert-time contradiction warnings for edges on
   * exactly this trigger — *"edges land when edge labels can declare functional-ness"*.
   *
   * **Existing edges that violate it are not rewritten**, which is the same answer every other rule here gives.
   * A space that declares this on a label it has already used twice reports the conflict on the next write and
   * in the `validate-schema` dry run; nothing deletes an edge because a schema changed under it.
   *
   * Shipped WITH `endpoints` deliberately: they are two attributes of one missing capability, and shipping them
   * apart pays the five-places tax twice on the same object.
   */
  functional?: boolean;
}

/** Validation mode for write operations against a space's schema. */
export type ValidationMode = 'off' | 'warn' | 'strict';

/**
 * The kinds of record a space holds — the ONE enumeration, and the tuple is the declaration.
 *
 * This list decides considerably more than a type union: which kinds a space can hold a type schema for,
 * which the schema library accepts, which appear in an audit summary, which have a retention bucket, and
 * which collections a redaction sweep walks. It was written out 43 times across `server/src` and
 * `client/src` before `M-2` — which adds a fifth — needed to add one member.
 *
 * **Each of those copies fails differently and none of them throws.** A schema library that refuses the new
 * kind. An audit summary with a kind missing. A retention bucket that never expires anything because nothing
 * maps the kind to a collection. That is the same shape as a capability shipped on one door of two.
 *
 * A tuple rather than a union, because a union cannot be iterated: `z.enum`, a `Set`, a `for` loop and a
 * `Record` key list all need the VALUES. The union is derived from it, so the two can never disagree.
 * `one-definition-of-the-knowledge-types.test.js` refuses the forty-fourth copy.
 *
 * **Order is meaningful and this is it**: entity, memory, edge, chrono — the order every UI already lists
 * them in, so an iteration over the tuple renders the way the product already reads.
 *
 * Not to be confused with {@link RefKind}, which is what a reference points AT and deliberately differs.
 */
export const KNOWLEDGE_TYPES = ['entity', 'fact', 'edge', 'chrono'] as const;

/** Knowledge type keys used in typeSchemas. Derived, so it cannot drift from the tuple above. */
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];

/**
 * Every kind of record that can be embedded, recalled or retained — the knowledge types PLUS `file`.
 *
 * A file is not a knowledge type: it has no type field, so it can have no type schema and no schema-tier
 * retention window. It is a record all the same, so it is embedded, it is searched, and it has a space-level
 * retention bucket. That is the whole of the difference, and it is why there are two tuples rather than one.
 *
 * **This set had FIVE names for it** — `RecallKnowledgeType`, `BrainEmbedRecordType`, `DupeScanType`,
 * `TtlBucket` and `EMBED_RECORD_TYPES` — and sixteen sites writing the members out, four of them zod enums
 * and two of them JSON-schema enums an MCP caller reads. Only `TtlBucket` was already derived.
 *
 * **The order changed when this was extracted, and that was checked rather than assumed.** Most sites wrote
 * `memory` first; the retention buckets wrote `entity` first and said the order was the one the UI shows.
 * Deriving makes every one of them entity-first. Verified before the change: recall's fan-out sorts by score
 * with a deterministic tiebreak and caps PER TYPE, so its result order does not depend on this; a JSON-schema
 * `enum` is a set, so no caller behaviour depends on it; and the one visible list — the Brain query tab's
 * type chips — now matches the order every other list in the product already used.
 */
export const RECORD_TYPES = [...KNOWLEDGE_TYPES, 'file'] as const;

/** A record kind, including `file`. Derived, so it cannot drift from the tuple. */
export type RecordType = typeof RECORD_TYPES[number];

/**
 * Where a knowledge type's documents live — the collection suffix, keyed by the singular type name.
 *
 * `KnowledgeType` is singular (`entity`) and the collection is plural (`<space>_entities`). `ttl.ts`'s
 * copy of this map carried the note that it *"was open-coded in five places and is the sort of thing a fifth
 * caller gets wrong once"* — and there were still FIVE local copies beside it, in `dupe-scanner`,
 * `contradiction-scanner`, `lexical-search`, `candidate-prune` and `structured-claims`. An extraction that
 * leaves the copies in place reads, later, as an extraction that held.
 *
 * It lives in this LEAF because a vocabulary has to be importable from anywhere without a cycle: `ttl.ts` is
 * a leaf on the delete path and half of those five callers could not import it.
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
 * ## A fourth key set, and it is the same trap one level down
 *
 * `A-10` found three collection SETS wearing one shape. The maps have the same problem: the key sets differ
 * and the values do not, so a map written for one reads as a map for any of them. There are three:
 *
 *   - `KnowledgeType` — carries a type schema. Four members.
 *   - `RecordType` — can be embedded, recalled or retained. The four plus `file`.
 *   - `TombstoneType` — this one. The four plus `link`, and NOT `file`, because a deleted file has
 *     `FileTombstoneDoc` and a wire protocol of its own with no `seq` in it.
 *
 * **A link is here and not in `RecordType`, and both halves matter.** A link record is deleted — when its
 * endpoint goes, or when the array it came from loses an entry — and a delete that does not tombstone is a
 * delete a peer undoes on the next cycle. It is not a `RecordType` because it is never embedded, recalled or
 * retained.
 *
 * The failure it removes was live and silent: `brain/tombstones.ts` mapped tombstone type to collection with
 * a `Record<string, string>` — a map with no keys — so a link tombstone would have found no entry, stored
 * itself, deleted nothing, and reported success. Two of exactly that shape were removed by `A-10`; this was
 * the third.
 */
export const TOMBSTONE_TYPES = [...KNOWLEDGE_TYPES, 'link'] as const;

/** What a record tombstone is for. Derived, so it cannot drift from the tuple. */
export type TombstoneType = typeof TOMBSTONE_TYPES[number];

/**
 * Where a TOMBSTONE's underlying document lives.
 *
 * Derived from the knowledge map plus the one member that is not a knowledge type, exactly as
 * `RECORD_COLLECTION` is — two projections of one vocabulary rather than two lists to keep in step.
 */
export const TOMBSTONE_COLLECTION = {
  ...COLLECTION_SUFFIX,
  link: 'links',
} as const satisfies Record<TombstoneType, string>;

/**
 * The inverse: a COLLECTION name back to the tombstone type stored in it.
 *
 * Both directions are asked, so both exist — but only one is written down. A wipe knows the collection
 * (`memories`) and has to clear tombstones by their `type` (`memory`), and `wipeSpace` carried its own
 * four-entry copy of exactly this, in the same function as a SECOND copy for the review findings. That is
 * the seventh and eighth copies of one mapping; `A-10` removed five and the shape kept coming back.
 *
 * Derived rather than typed, so the two can never disagree — and a collection with no tombstone type,
 * `files`, is simply absent rather than being a name somebody remembered to leave out.
 */
export const TOMBSTONE_TYPE_OF = Object.fromEntries(
  TOMBSTONE_TYPES.map(t => [TOMBSTONE_COLLECTION[t], t]),
) as Record<string, TombstoneType | undefined>;

/**
 * The same map over RECORD types — the knowledge collections plus `files`.
 *
 * Two maps rather than one because the two key sets differ: a file has no type schema, so it is not a
 * knowledge type, and it has a collection all the same. The scanners and lexical search are keyed by record
 * type; retention and the schema tier are keyed by knowledge type.
 */
export const RECORD_COLLECTION = {
  ...COLLECTION_SUFFIX,
  file: 'files',
} as const satisfies Record<RecordType, string>;

/**
 * Every collection a space's KNOWLEDGE lives in — the one shared list, and it derives from the map above.
 *
 * ## Three sets wore one shape, because it has had four members
 *
 * This is set 2 of three, and the other two are NOT spellings of it:
 *
 *   - `SPACE_COLLECTIONS` (`spaces/_shared.ts`) is every collection a space OWNS, machinery included —
 *     tombstones, conflicts, and the two candidate queues. It is what CREATES them, and nothing else does.
 *   - `VECTOR_INDEXED_COLLECTIONS` (`spaces/vector-index.ts`) is this list MINUS anything never embedded.
 *
 * `M-2` is what separated them, and `links` below is it: a link record is stored in its own collection,
 * so it joins `SPACE_COLLECTIONS` and this one — and it stays OUT of the vector-indexed set, because a link
 * has no content to embed and a content-free record in a ranked list is the hazard that migration is
 * written around.
 *
 * `one-definition-of-the-collections.test.js` holds the rule: derive from here, or say in your own comment
 * that you are a deliberate subset and why.
 *
 * ## Why `links` is APPENDED rather than derived like the rest
 *
 * The other five come from `RECORD_COLLECTION`, which is keyed by `RecordType` — and a link is not one.
 * That tuple means *can be embedded, recalled or retained*, and a link is none of the three: it has no
 * content, it is never a recall result, and its lifetime is its endpoints'. Adding it there to save a line
 * here would hand it an embed-text builder, a lexical field, a recall projection and a retention bucket,
 * which is the same mistake as making it a fifth `KnowledgeType`. FIFTEEN of that tuple's sixteen consumers
 * outside this module use it to mean *carries a type schema* — the schema library's enum, the per-type
 * schema routes' guard, `SCHEMA_KTS`, the schema audit summary, the chrono redaction sweep, and three
 * schema SCREENS in the client. The sixteenth was the tombstone `type` enum, which is not about schemas and
 * DID need links, so it got its own tuple (`TOMBSTONE_TYPES`) rather than widening this one.
 *
 * Decided on that count. It goes against the owner's literal wording from 2026-08-30, so
 * `todo/_LINKS-AND-SCHEMA-TODOS.md` records it as his to overturn, with what the alternative costs.
 *
 * So: five derived, one appended, and the append is the whole statement that a link is a collection and
 * nothing more.
 */
export const BRAIN_COLLECTIONS = [...RECORD_TYPES.map(t => RECORD_COLLECTION[t]), 'links'] as const;

/** One knowledge collection. */
export type BrainCollection = (typeof BRAIN_COLLECTIONS)[number];

/**
 * What kind of record a reference points AT.
 *
 * Deliberately not {@link KnowledgeType}, and the difference is not cosmetic. That union names the four things
 * a type schema can govern, and `edge` is one of them — an edge is a record with a schema of its own, but
 * nothing ever points at an edge. This union names the collections a reference can resolve in, so it includes
 * `file`, whose meta record is pointed at constantly and has no type schema at all.
 *
 * Two overlapping unions is how this repo's most expensive class of defect starts, so the overlap is stated
 * rather than left to be noticed: three members are shared, each union has one the other must not gain.
 *
 * It lives here, in `config/`, because `EdgeDoc` needs it and `config/` must not import from `brain/`.
 * `brain/entity-refs.ts` re-exports it, which is where it used to be defined and where every caller still
 * expects to find it.
 *
 * The runtime list is the definition and the type is derived from it, rather than the other way round. A hand
 * written union plus a hand written array is two lists, and the sync schema needs the array — so the two would
 * drift at exactly the moment a kind is added, with the compiler silent because both are individually valid.
 * This is the first runtime value in an otherwise type-only module for that reason alone.
 */
export const REF_KINDS = ['entity', 'fact', 'chrono', 'file'] as const;

/** @see REF_KINDS — derived, never written out a second time. */
export type RefKind = typeof REF_KINDS[number];


/** Structured schema and metadata for a space — all fields optional. */
/**
 * A recorded disagreement between a record's own timestamp and the server's write time.
 *
 * Present on a record ONLY when the disagreement exceeded the space's threshold, which is what makes
 * `{ stampSkew: { $exists: true } }` the cheap integrity query the canary operator asked for rather than a report that
 * matches everything. See `brain/stamp-skew.ts` for the eight-hour incident behind it.
 */
export interface StampSkew {
  /** The property the stamp came from, so a warning can name it. */
  property: string;
  /** The stamp as the caller wrote it — quoted back verbatim, because the point is that it LOOKS right. */
  stamp: string;
  /** Signed: negative means the caller's stamp is EARLIER than the server's write. Theirs were eight hours negative. */
  skewMs: number;
  /** The threshold that was applied, so a stored record carries what it was judged against. */
  thresholdMs: number;
}

/**
 * Carried by every record type the stamp check runs on — memories, entities, edges and chrono.
 *
 * Declared once here rather than as a field repeated in four interfaces, and not only to keep `config/types.ts` off the
 * god-file ratchet: a fifth record type added later gets the check by extending this, where a copied field would be
 * forgotten and the omission would look exactly like a record whose stamp agreed.
 */
export interface StampSkewable {
  /**
   * Set only when this record's own timestamp property disagreed with the server's `createdAt` beyond the space's
   * threshold. ABSENT means agreed, not checked, or the check is off — presence is the signal, which is what makes
   * `{ stampSkew: { $exists: true } }` a useful query. See `brain/stamp-skew.ts`.
   */
  stampSkew?: StampSkew;
}

/**
 * What a passed due moment may mean. Declared here because both `SpaceMeta` and `TypeSchema` carry it and
 * this module imports nothing; `brain/chrono-date-policy.ts` re-exports the tuple it is derived from, so the
 * vocabulary has one home and the policy has one resolver.
 */
export type DatePassedPolicy = 'overdue' | 'nothing';

export interface SpaceMeta {
  /** Version counter — auto-incremented on every meta change. */
  version?: number;
  /** Short directive injected into MCP instructions at handshake. Max 4 000 chars. */
  purpose?: string;
  /** Extended Markdown prose — naming conventions, examples, links. Shown in UI only. */
  usageNotes?: string;
  /** Validation enforcement level. Default: 'off'. */
  validationMode?: ValidationMode;
  /**
   * **Chrono only.** What a PASSED due moment means across this space, for types whose own schema is silent.
   *
   * The outer tier of **schema > space**. Absent is today's behaviour (`overdue`), so an instance that
   * upgrades and changes nothing sees nothing change. Set `nothing` on a space whose chrono entries are
   * mostly records of events that happened, and override per type where a real deadline lives.
   *
   * See `brain/chrono-date-policy.ts` for the resolution and for why there is no per-record tier.
   */
  whenDuePasses?: DatePassedPolicy;
  /**
   * Per-type schemas for each knowledge collection.
   * Keys of typeSchemas.entity are the allowed entity type values (allowlist).
   * Keys of typeSchemas.edge are the allowed edge label values (allowlist).
   * Keys of typeSchemas.memory / .chrono are the allowed type values.
   * When a collection's map is empty, all type/label values are accepted.
   */
  typeSchemas?: Partial<Record<KnowledgeType, Record<string, TypeSchema>>>;
  /** When true, all reference fields (edge from/to, entityIds, memoryIds) must be
   *  valid UUID v4 values, and entity deletion is blocked while inbound backlinks exist. */
  strictLinkage?: boolean;
  /**
   * Space-wide default for skipping embeddings. The **lowest** tier: any type schema that states
   * `suppressEmbeddings` overrides it, and a per-record value overrides both.
   *
   * Absent means `false` — embedding is the default, and suppression is opt-in. The failure direction of
   * getting that backwards is records silently missing from recall, which nobody reports because there is
   * nothing to see.
   *
   * Lives in the Danger Zone in the UI, alongside the other space-wide switches, because it changes what
   * happens to data on write rather than how it is displayed. **It does not backfill when switched off** —
   * see `TypeSchema.suppressEmbeddings`.
   */
  suppressEmbeddings?: boolean;
  /**
   * Stamp-integrity check: compare a record's OWN timestamp property against the server's `createdAt` on write, and
   * warn when they disagree beyond `warnMinutes`.
   *
   * The canary operator corrected three board posts whose `postedAt` was eight hours early — not clock drift, but a
   * measured stamp followed by three EXTRAPOLATED ones. Their sentence for why nothing caught it: *"an estimated
   * timestamp looks exactly like a measured one once it is written down."* The comparison is available to the store and
   * not to the author, which is what makes it ours.
   *
   * Absent means the default 40 minutes — the board protocol's own assumed clock tolerance. `warnMinutes: 0` disables
   * the check; it does NOT mean "warn on any difference", because a caller's stamp and the server's clock never agree
   * to the millisecond and that reading would fire on every record.
   *
   * It never refuses a write. A legitimately backdated record exists — a historical import, a backfilled letter — and
   * what is being reported is a wrong number, not a corrupt record.
   */
  stampSkew?: {
    /** Warn beyond this many minutes of disagreement. Default 40. `0` disables. */
    warnMinutes?: number;
    /** Property names to check, first parseable one wins. Default `['stampedAt', 'postedAt']`. */
    properties?: string[];
  };
  /** ISO8601 timestamp of the last meta update. */
  updatedAt?: string;
  /** History of previous meta versions (most recent first, capped). */
  previousVersions?: Array<{ version: number; meta: Omit<SpaceMeta, 'previousVersions'>; updatedAt: string }>;
}
