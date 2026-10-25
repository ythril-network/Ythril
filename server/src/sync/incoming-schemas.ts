/**
 * The `Incoming*` schemas: every replicated document as a peer may send it, and the one table that says which schema a family is
 * validated with. THE SCHEMA LEAF (Q-624, design rev 4 section 2).
 *
 * ## Why they are a module of their own
 *
 * They lived in `api/sync/_shared.ts` (and the table in `sync/arrival-shape.ts`), a module that also re-exports the planner's
 * `MAX_FORK_DEPTH`. The body hash (`sync/authored-content.ts`) derives its field table from these schemas, and the space hash,
 * the planner and the writer all need the hash, so a hash that read the schemas through `_shared.ts` closed a cycle: merkle ->
 * arrival-shape -> `api/sync/_shared.ts` -> `sync/upsert-plan.ts` -> merkle, and every one of the server's entry modules failed to
 * load with a temporal-dead-zone error. Here they import only what a schema is made of (zod, the endpoint kinds, the record
 * bounds, the chrono statuses, the sequence ceiling and the machine-made description sources), and none of it imports the store,
 * the config loader, the space hash or the planner. `the-schema-leaf-imports-no-sync-machinery` holds that over the transitive
 * imports, and `every-server-entry-module-loads` holds what a cycle does.
 *
 * `api/sync/_shared.ts` and `sync/arrival-shape.ts` re-export what they held, so no importer changes.
 */
import { z } from 'zod';
import { isComparableIso } from '../util/comparable-iso.js';
import { REF_KINDS, type BrainCollection } from '../config/types-knowledge.js';
import { MAX_SYNC_SEQ } from '../util/seq-ceiling.js';
import { MACHINE_MADE_SOURCES } from '../files/machine-made-sources.js';
import { CHRONO_STATUSES } from '../config/chrono-statuses.js';
import { MAX_FACT_LENGTH, MAX_TAGS } from '../util/request-bounds.js';

// ── Incoming document schemas (Zod validation for peer-submitted docs) ─────

export const AuthorRefSchema = z.object({
  instanceId: z.string().min(1),
  instanceLabel: z.string().min(1),
});

export const IncomingFactDoc = z.object({
  _id: z.string().min(1),
  /*
   * Every `Incoming*` schema is a bare `z.object`, and zod STRIPS undeclared keys on push — so every
   * replicated (hashed) field must be declared, or push loses it while pull keeps it.
   *
   * The type selects the fact's type schema; stripped, the fact is validated against nothing and hashes
   * differently from the sender's copy for ever.
   */
  type: z.string().optional(),
  /*
   * The RECORD tier of suppression (`record > schema > space`; the other two tiers are the receiver's own
   * config). Stripped, a record its author kept out of meaning-ranked search would be embedded on every peer.
   * Optional: absent means included, and requiring it would drop suppressed facts from their batch silently.
   */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  fact: z.string().max(MAX_FACT_LENGTH),
  /** Defaulted like every forking family's, so a fact without tags and one with `[]` normalise alike and an equal pair does not fork against itself (Q-624, R10). */
  tags: z.array(z.string()).max(MAX_TAGS).default([]),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /**
   * The record this row is a FORK of: the other version of an equal-seq edit, kept beside it. Hashed, so it replicates, and declared on every
   * forking family. `.min(1)` because `''` would escape the partial identity index of an edge fork (`forkOf: null` is the identity's filter).
   */
  forkOf: z.string().min(1).optional(),
});

/** How many authored keys, and how long a key name, a peer's `authoredKeys` may carry (a file has a handful today). */
const MAX_AUTHORED_KEYS = 64;
const MAX_AUTHORED_KEY_LENGTH = 64;
/**
 * The longest an arriving file timestamp may be: an ISO instant in the comparable form is 24 characters, and this
 * leaves room for an offset spelling without leaving room for a payload. A bound as well as the format check, because
 * the refusal is cheaper than the regex on a megabyte of text a sender had no business sending.
 */
const MAX_TIMESTAMP_LENGTH = 40;

/**
 * A file's METADATA as a peer sends it — only the AUTHORED fields. Fields derived from the local blob
 * (`sizeBytes`, `sha256`, `excerpt`, `embedding`, `chunkCount`, `embeddingStatus`, `conversionError`,
 * `convertedFileId`, `mediaType`) are the receiver's own; chunk-only fields must not travel at all.
 *
 * `.strict()` deliberately: an undeclared key fails the push with a 400 instead of being stripped, because
 * a stripped `parentFileId` would turn a chunk into a top-level file.
 *
 * **A key the sender REMOVED is a key its document lacks, and absence says nothing on its own** (`Q-256`). The merge
 * only ever sets (`sync/file-meta-write.ts`), so an older sender's document means "these keys, and I have no word on
 * the others". `authoredKeys` is the word: the authored keys the SENDER'S version knows (`FILE_META_AUTHORED_KEYS`), so
 * a key listed and absent is a key removed, and a key it never heard of is left alone. It is wire control, never
 * stored and never re-served as stored: every sender computes it afresh from what it holds. A peer that predates it
 * REFUSES it (`.strict()`), which is why a push sends it only to a peer known to run the version that declares it
 * (`sync/push-family.ts`).
 *
 * `tags` is optional for the same reason: an operator who removes the tags leaves a row with no `tags` key, and
 * requiring one refused that file whole, so none of its other edits arrived either. An older receiver still requires
 * it, so a push to one carries `tags: []` for a row that has none.
 */
export const IncomingFileMetaDoc = z.object({
  // The path IS the id. Both are carried, as the document does.
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  descriptionSource: z.enum(MACHINE_MADE_SOURCES).optional(),
  tags: z.array(z.string()).max(MAX_TAGS).optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  /** The authored keys the sender's version knows — see above. Bounded: it is a peer's list, read once per document. */
  authoredKeys: z.array(z.string().max(MAX_AUTHORED_KEY_LENGTH)).max(MAX_AUTHORED_KEYS).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  /**
   * CHECKED, unlike every other family's, because a file row's timestamp became a write power (`Q-419`).
   *
   * At an equal seq a receiver adopts the author's own `updatedAt`, so this string can now change a stored row — and it
   * is a peer's string. A bare `z.string()` let a sender put anything in it: text that is not a date at all, a spelling
   * no comparison can order, or a megabyte of it. It must be an ISO instant in the fixed-width comparable form, and
   * bounded in length, before the convergence may write it.
   *
   * The other families keep `z.string()` deliberately: their `updatedAt` is replaced wholesale by a newer version and
   * is never read to decide a write, so a malformed one is the sender's own problem with its own record.
   */
  updatedAt: z.string().max(MAX_TIMESTAMP_LENGTH).refine(isComparableIso, 'not a comparable ISO timestamp'),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /** Present only on a CHUNK: `never()` so a chunk is refused rather than stripped into a file. */
  parentFileId: z.never().optional(),
}).strict();

/*
 * An arriving file's metadata is written by the arrival writer's files branch (`sync/arrivals.ts`, `Q-107` part 2):
 * a page of guarded `$set` upserts built by `sync/file-meta-write.ts`. `ingestFileMeta`, its per-document
 * predecessor, filtered on `_id` alone, so a newer copy written between the accept read and the merge was
 * overwritten by an older one.
 */

export const IncomingEntityDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  /** Defaulted as chrono's and edge's are (N8: `deleteFields` removes the key, and a record without tags failed this schema). */
  tags: z.array(z.string()).max(MAX_TAGS).default([]),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /** See `IncomingFactDoc`: the fork link, hashed and so replicated. */
  forkOf: z.string().min(1).optional(),
});

/**
 * The kinds an edge endpoint may declare, built from `REF_KINDS` so a new kind is not refused on the push
 * door alone.
 */
export const RefKindSchema = z.enum(REF_KINDS);

export const IncomingEdgeDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /**
   * Must be declared (zod strips undeclared keys on push), or a pushed edge would resolve its endpoints in
   * the wrong collection. Optional: absent means entity, as in the database.
   */
  fromKind: RefKindSchema.optional(),
  toKind: RefKindSchema.optional(),
  label: z.string(),
  type: z.string().optional(),
  weight: z.number().optional(),
  tags: z.array(z.string()).max(MAX_TAGS).default([]),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /** See `IncomingFactDoc`: the fork link, hashed and so replicated. An edge's is never added or removed once stored (`invalidFork`). */
  forkOf: z.string().min(1).optional(),
});

/**
 * A link record on the wire: two endpoints, their kinds, and replication bookkeeping — no suppression
 * marks, since a link has nothing to embed.
 *
 * Both kinds are REQUIRED (unlike an edge's): a link has no default kind, and an unknown endpoint kind
 * cannot be resolved.
 *
 * Every field of `LinkDoc` must be declared: all of them are hashed, and a hashed field that does not
 * replicate logs a `MERKLE_DIVERGENCE` every cycle for a space where nothing is wrong
 * (`a-replicated-field-reaches-its-incoming-schema.test.js` gates this).
 */
export const IncomingLinkDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  fromKind: RefKindSchema,
  to: z.string().min(1),
  toKind: RefKindSchema,
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

export const IncomingChronoDoc = z.object({
  _id: z.string().min(1),
  /*
   * The content-redaction marks replicate (and are hashed): they tell "never had a description" from "it
   * lapsed". The retention STAMP behind them (`_contentExpireAt`) deliberately does not travel — it comes
   * from each instance's own policy, and shipping it would let one peer decide when another deletes data.
   */
  contentRedacted: z.boolean().optional(),
  contentRedactedAt: z.string().optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  // The shared tuple, never a local copy: a wrong list here would refuse a valid status and hold the
  // sync watermark on it.
  status: z.enum(CHRONO_STATUSES),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).max(MAX_TAGS).default([]),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  recurrence: z.object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive(),
    until: z.string().optional(),
  }).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /** See `IncomingFactDoc`: the fork link, hashed and so replicated. */
  forkOf: z.string().min(1).optional(),
});

/** A family's wire key: the name its documents travel under in a page and in the push and pull routes. */
export type IncomingFamilyKey = BrainCollection | 'filemeta';

type SafeParser = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };

/**
 * The `Incoming*` schema each family is validated against: the one hand-written family table, because a schema is
 * a fact about the wire that no registry can derive. `sync/arrival-shape.ts` checks it at load against the derived family
 * list (`REPLICATED_FAMILIES`), so a family added there without a schema stops the server rather than being stored
 * unchecked; that check stays there because the registry is not something a leaf may import.
 */
export const INCOMING_SCHEMA_OF: Readonly<Partial<Record<IncomingFamilyKey, { schema: SafeParser & { shape: Record<string, z.ZodTypeAny> }; name: string; fill?: SafeParser }>>> = {
  facts: { schema: IncomingFactDoc, name: 'IncomingFactDoc' },
  entities: { schema: IncomingEntityDoc, name: 'IncomingEntityDoc' },
  edges: { schema: IncomingEdgeDoc, name: 'IncomingEdgeDoc' },
  chrono: { schema: IncomingChronoDoc, name: 'IncomingChronoDoc' },
  links: { schema: IncomingLinkDoc, name: 'IncomingLinkDoc' },
  // `.partial()` keeps `.strict()` and the `never` on `parentFileId`: only the requirement goes.
  filemeta: { schema: IncomingFileMetaDoc, name: 'IncomingFileMetaDoc', fill: IncomingFileMetaDoc.partial() },
};
