/**
 * The space-schema vocabulary: what a type schema IS, the space meta that carries them, and the tuples every schema door reads.
 *
 * Moved out of the server (`server/src/config/types-knowledge.ts`, which re-exports every name here) so an app that WRITES a
 * schema — a template, a flow, a generator — imports the definition instead of hand-copying it. A copy kept in step by a comment is
 * the defect this repository produces most; a copy kept in step across two repositories is that defect with no test that can see it.
 *
 * **A leaf: it must import nothing.** A cycle through a re-export makes TypeScript silently degrade the types involved to `any`
 * while everything compiles clean.
 */

// ── Space meta / schema types ──────────────────────────────────────────────

/**
 * The merge functions, as RUNTIME lists with the types derived from them, so every enumeration (the
 * `brain/merge.ts` validator, the space-schema `z.enum`) reads one list; a function the schema accepts and
 * the validator does not know is a merge that refuses a value the UI offered.
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
  /**
   * What this property MEANS, in the operator's own words — free text, never parsed. Read by an agent
   * constructing a write or a filter (e.g. retry budget vs retry count, where the type says only "number").
   */
  description?: string;
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

/** Schema definition for a single entity type, edge label, fact type, or chrono type. */
export interface TypeSchema {
  /**
   * What this TYPE is for, in the operator's own words — free text, never parsed.
   *
   * Prose rather than an ontology: it serves a MODEL reader fully, and a formal vocabulary nothing enforces
   * would look machine-checked while being advisory. Build a structured form only when an engine consumer
   * will act on it.
   */
  description?: string;
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
   * How long records of this type are kept. The middle tier of **record > schema > space**, so one space
   * can prune one kind of record while keeping another.
   *
   * - `days` — delete records of this type after this many days, through the normal delete path, so the
   *   deletion tombstones and propagates to peers.
   * - `contentDays` — **chrono only.** Drop the bulky, recallable part (`description`, `matchedText`,
   *   `properties` and the embedding) while keeping the record, and set `contentRedacted: true`; with no
   *   vector it stops competing in semantic search. Rejected on other collections rather than silently ignored.
   *
   * A per-record `ttlDays` on the write still wins over both, including `0`/`null` for "never expire".
   *
   * Lives in space meta, so the policy is replicated and agreed across a network; each instance expires its
   * own copy locally.
   */
  retention?: { days?: number; contentDays?: number };
  /**
   * **Chrono only.** What a PASSED due moment means for records of this type.
   *
   * `overdue` (the default) derives `overdue` on read once the due moment is behind us. `nothing` returns
   * the STORED status instead — for types whose records are events that occurred rather than deadlines.
   *
   * Tier order **schema > space**; no record tier on purpose, since the meaning of a past date belongs to the
   * kind of thing. Resolved in `brain/chrono-date-policy.ts`.
   */
  whenDuePasses?: DatePassedPolicy;
  /** Property key → JSON Schema subset for value validation and merge hints. */
  propertySchemas?: Record<string, PropertySchema>;
  /**
   * Skip embedding records of this type. Absent means **not stated**, which falls through to the space-wide
   * setting — it does NOT mean `false`.
   *
   * If absent read as "do not suppress", `SpaceMeta.suppressEmbeddings` would do nothing for any type with a
   * schema. Resolution is record > schema > space, owned by `brain/suppress-embeddings.ts`. Meant for records
   * that are state rather than prose, re-written often and never searched by meaning.
   *
   * **Turning it off does not backfill.** Records written while it was on have no vector until re-embedded
   * (`POST /api/spaces/:id/reembed`).
   */
  suppressEmbeddings?: boolean;
  /**
   * What KIND of thing may sit at each end of an edge with this label. **Edge collection only** — rejected on
   * entity, fact and chrono the way `retention.contentDays` is rejected off chrono, rather than silently
   * ignored.
   *
   * Each side is independently optional; absent means unconstrained (`{ from: ['person'] }` pins only the
   * subject).
   *
   * Two arrays mean the CROSS PRODUCT: `from: ['document', 'person'], to: ['project', 'team']` also permits
   * `document -> team`. A caller needing exactly one pair declares a label per pair. **Do not add a pairs
   * form**: it was considered and declined by the owner.
   *
   * Members are entity type names as `er_model` prints them, plus an explicit `UNTYPED` bucket. A member may be
   * written `entity:<type>` (a bare name means `entity:`); any other `KnowledgeType` prefix is refused at the
   * Zod layer, leaving room to widen the grammar later.
   */
  endpoints?: { from?: string[]; to?: string[] };
  /**
   * At most one edge with this label per subject: one `(from, label)` may hold one `to`.
   *
   * The established sense of "functional property" (e.g. `reports_to`, one manager). Not per `(from, to)`,
   * which the unique edge index already guarantees, and not per `to`, which is the inverse relation.
   *
   * Reported or refused per the space's `validationMode`, like every other schema rule. **Existing violating
   * edges are not rewritten**: the conflict is reported on the next write and in the `validate-schema` dry run.
   */
  functional?: boolean;
  /**
   * F-46: rules every record of this type must satisfy — a CEL expression over the record's view (`self`) and the message a
   * violation carries, by rule name. Part of the type: replaced with it. Checked when saved and evaluated by `spaces/schema-rules.ts`.
   */
  rules?: Record<string, SchemaRule>;
}

/** One schema rule: a CEL expression that must answer true for a record, and what a record that breaks it is told. */
export interface SchemaRule {
  rule: string;
  message: string;
}

/** A space-level rule: a {@link SchemaRule} and the knowledge types it governs (absent or empty: every kind). */
export interface SpaceSchemaRule extends SchemaRule {
  kinds?: KnowledgeType[];
}

/** Validation mode for write operations against a space's schema. */
export type ValidationMode = 'off' | 'warn' | 'strict';

/**
 * The kinds of record a space holds — the ONE enumeration, and the tuple is the declaration.
 *
 * It decides which kinds can hold a type schema, which the schema library accepts, the audit summary, the
 * retention buckets and the redaction sweep — and a copy that misses a member fails silently in each. A
 * tuple so it can be iterated; the union derives from it. `one-definition-of-the-knowledge-types.test.js`
 * refuses copies.
 *
 * **Order is meaningful**: the order every UI lists them in.
 *
 * Not to be confused with {@link RefKind}, which is what a reference points AT and deliberately differs.
 */
export const KNOWLEDGE_TYPES = ['entity', 'fact', 'edge', 'chrono'] as const;

/** Knowledge type keys used in typeSchemas. Derived, so it cannot drift from the tuple above. */
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];

/**
 * What a passed due moment may mean. Declared here because both `SpaceMeta` and `TypeSchema` carry it and
 * this module imports nothing; `server/src/brain/chrono-date-policy.ts` re-exports the tuple, so the
 * vocabulary has one home and the policy has one resolver.
 */
export type DatePassedPolicy = 'overdue' | 'nothing';

/**
 * What a passed due moment may mean, as a runtime tuple. Two, and the absence of a third is a decision — see
 * `server/src/brain/chrono-date-policy.ts`.
 *
 * Exported so the admin PATCH schema, the MCP tool schema and the gate all read one tuple. A second copy of
 * a vocabulary is the defect this repository produces most.
 */
export const DATE_PASSED_VALUES = ['overdue', 'nothing'] as const satisfies readonly DatePassedPolicy[];

/** Structured schema and metadata for a space — all fields optional. */
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
   * The outer tier of **schema > space**; absent means `overdue`. Resolved in `brain/chrono-date-policy.ts`.
   */
  whenDuePasses?: DatePassedPolicy;
  /**
   * Per-type schemas for each knowledge collection.
   * Keys of typeSchemas.entity are the allowed entity type values (allowlist).
   * Keys of typeSchemas.edge are the allowed edge label values (allowlist).
   * Keys of typeSchemas.fact / .chrono are the allowed type values.
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
   * Absent means `false`: suppression is opt-in, because getting it backwards silently drops records from
   * recall. **It does not backfill when switched off** — see `TypeSchema.suppressEmbeddings`.
   */
  suppressEmbeddings?: boolean;
  /**
   * Stamp-integrity check: compare a record's OWN timestamp property against the server's `createdAt` on write, and
   * warn when they disagree beyond `warnMinutes`.
   *
   * Catches estimated timestamps written as if measured, which only the store can compare.
   *
   * Absent means the default 40 minutes. `warnMinutes: 0` DISABLES the check; it does not mean "warn on any
   * difference", which would fire on every record.
   *
   * It never refuses a write: legitimately backdated records (imports, backfills) exist.
   */
  stampSkew?: {
    /** Warn beyond this many minutes of disagreement. Default 40. `0` disables. */
    warnMinutes?: number;
    /** Property names to check, first parseable one wins. Default `['stampedAt', 'postedAt']`. */
    properties?: string[];
  };
  /**
   * F-46: rules every record of the space must satisfy, beside each type's own — by rule name, each naming the kinds it governs.
   * A top-level field replaced whole by every merge (`spaces/meta-fields.ts`): send the map without a rule to delete it.
   */
  rules?: Record<string, SpaceSchemaRule>;
  /** ISO8601 timestamp of the last meta update. */
  updatedAt?: string;
  /** History of previous meta versions (most recent first, capped). */
  previousVersions?: Array<{ version: number; meta: Omit<SpaceMeta, 'previousVersions'>; updatedAt: string }>;
}
