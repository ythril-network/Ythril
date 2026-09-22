import type { RecallResult } from '../../brain/recall.js';
import { diagnosticFields, RECALL_RECORD_DIAGNOSTICS } from '../../brain/recall-shape.js';

/** Helpers shared by the MCP tool handlers (moved out of mcp/router.ts). */

// Re-exported from the canonical definition so there is exactly one copy in the codebase.
export { UUID_V4_RE, UUID_V4_PATTERN } from '../../brain/entity-refs.js';

/** JSON-schema fragment for the per-record TTL arg (F10), shared by every MCP write tool. */
export const TTL_DAYS_SCHEMA = {
  type: ['integer', 'null'],
  minimum: 0,
  maximum: 36500,
  description:
    'Auto-delete this record after N days. Retention resolves as RECORD > SCHEMA > SPACE: this field wins '
    + 'outright (a positive integer sets the expiry; 0 or null means never expire, overriding everything); '
    + 'omit it and the record type\'s own schema window applies; failing that, the space-wide window for THIS '
    + 'KIND of record (the space sets one per kind: entities, facts, edges, chrono, files). '
    + 'Setting it is how you keep one record that the space would otherwise expire, or expire one it would '
    + 'otherwise keep. For chrono types a schema may also drop a record\'s DETAIL earlier than the record '
    + 'itself, which removes it from semantic search while the fact that it happened remains.',
} as const;

/**
 * JSON-schema fragment for `suppressEmbeddings`, shared by all four MCP update tools.
 *
 * One copy because the four types had already diverged on it once: the flag was wired into all four update
 * FUNCTIONS and then reached the REST handlers for three types and the MCP handlers for none, so the same
 * capability existed, was documented, and could not be used from the surface an agent actually holds.
 *
 * The semantics are stated in the description rather than left to the field name, because the effect —
 * the vector is REMOVED — is not what any short name conveys on its own: recall cannot reach the record
 * even deliberately, while structured reads still return it in full.
 *
 * ## The field was called `excludeFromVectorSearch` until 3.1.0, and the name cost a question
 *
 * Owner, 2026-08-15: *"excludefromvector does also exclude from recalls traversal? ambigous and i want
 * entries to be findable via traversal even if they are not embedded themselves."*
 *
 * The answer is no, and the reason is structural rather than a policy anyone chose: recall's `traverse`
 * expansion walks EDGES out of a match, so it never consults a vector, and `recall-graph.ts` filters on
 * nothing but the edge. So both the `traverse` tool and `recall(traverse: n)` reach a suppressed record —
 * saying which two is what the sentence was missing, since a reader had to already know there were two.
 *
 * That is also why the field now shares the name the type schema and the space already used: one switch at
 * three tiers, and a reader who finds one has a reason to look for the others. The old spelling is still
 * ACCEPTED as an input alias — see `parseRecordSuppression` — and is deliberately not named here, because a
 * schema description is what a caller constructs arguments from and naming both would re-create the defect.
 */
/**
 * The retirement mark, described by the GUARANTEE it gives rather than by what it does to storage.
 *
 * A description that states a MECHANISM has to be revisited every time the mechanism gains a case, and
 * nobody does — which is how a caller came to read *"filter applied after vector search"* on `recall` and
 * build around a limitation that had never existed. So this says what a caller can rely on: the record
 * still ranks, and it comes back marked.
 */
export const SUPERSEDED_SCHEMA = {
  type: 'boolean',
  description:
    'Mark this record as NO LONGER TRUE. It keeps its vector and keeps ranking — a superseded record is '
    + 'still returned by recall, query, list, get and traverse, carrying `superseded: true` so you can see '
    + 'that it has been overtaken. Hiding it would make "where DID she work?" unanswerable in order to fix '
    + '"where DOES she work?", so retrieval marks rather than decides.\n\n'
    + 'It does NOT say what replaced it, and it does NOT schedule a deletion. Draw a `supersedes` edge from '
    + 'the new record to this one to say which replaced it — that edge is walked, so `graph_traverse` from '
    + 'either reaches the other. Leave the edge out when nothing replaced it: "she left and has no new job" '
    + 'is a retirement with no successor, and both are sayable.\n\n'
    + 'Not the same as `suppressEmbeddings`, which removes the vector and makes a record unrankable.',
} as const;

export const SUPPRESS_EMBEDDINGS_SCHEMA = {
  type: 'boolean',
  description:
    'Retire this record from semantic RANKING. Implemented as the ABSENCE of a vector, NOT a query-time '
    + 'filter: a suppressed record cannot be RANKED by recall even deliberately, because there is no vector '
    + 'to rank. Everything that does not rank still reaches it in full — filter, list, get, the `graph_traverse` '
    + 'tool, AND recall\'s own `traverse` expansion, which walks edges out of a match and never consults a '
    + 'vector. So a record suppressed here is still findable through its relationships; it just stops '
    + 'competing on meaning. May be the only field you send — retiring a record is a complete edit.\n\n'
    + 'THIS IS THE TOP OF THREE TIERS OF ONE SWITCH, ALL THREE SPELLED THE SAME. A type schema carries '
    + '`suppressEmbeddings`, and so does the space; they resolve `record > schema > space`, the same order '
    + '`ttlDays` uses. So when a record is unembedded and this field is not why, check `space_meta` — '
    + 'the tier below is answering.\n\n'
    + '`false` MEANS "NOT STATED", NOT "DO EMBED". It falls through to the tiers below rather than '
    + 'overriding them, so setting it false CANNOT re-embed a record whose type or space suppresses '
    + 'embedding — the suppression there still wins, and the write succeeds while nothing changes. On a '
    + 'record that no other tier suppresses, false does restore the vector.',
} as const;

/*
 * `LEGACY_SUPPRESS_EMBEDDINGS_SCHEMA` STOOD HERE and went with `D-6` in 4.0.
 *
 * It was a declared property whose entire description said *use the other name*. It existed because an
 * MCP tool schema is `additionalProperties: false` and the dispatcher validates BEFORE the handler — so
 * accepting a deprecated alias costs a real schema property; it cannot be a fallback in the handler,
 * which never runs, nor a comment.
 *
 * Which means removing the property is what makes the tools refuse the old spelling: here the refusal is
 * the absence. The note is left because the shape recurs, and because "the alias is gone" reads as a code
 * change when it is a deletion.
 */

/**
 * Parse + validate `ttlDays` from MCP tool args (F10): a non-negative integer ≤ 36500 sets an expiry,
 * `null` clears it, and absent → `undefined` (inherit the space default). Throws on a present-but-invalid
 * value so the MCP surface fails loud like REST rather than silently dropping the intent.
 */
export function ttlDaysFromArgs(args: Record<string, unknown>): number | null | undefined {
  const v = args['ttlDays'];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 36500) {
    throw new Error('ttlDays must be an integer number of days between 0 and 36500, or null to clear the expiry');
  }
  return v;
}

/**
 * Shared JSON-Schema fragments so `tools/list` fully describes every input (F1 self-describing surface).
 * The MCP dispatcher does not enforce inputSchema (handlers validate manually), so these keywords are the
 * machine-readable contract an agent reads to discover valid values/bounds — kept in lockstep with the
 * handler/brain validators they mirror.
 */

/** A UUID-v4 id argument (case-insensitive), matching `UUID_V4_RE`. */
const UUID_V4_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
export function uuidSchema(description: string) {
  return { type: 'string', pattern: UUID_V4_PATTERN, description } as const;
}

/** A 0.0–1.0 score/threshold argument. */
export function unitScoreSchema(description: string) {
  return { type: 'number', minimum: 0, maximum: 1, description } as const;
}

/**
 * A file-store path argument, shared by the five tools that take one.
 *
 * It was the same 37-character sentence copied four times — "File path relative to the space root." —
 * which is true and says nothing a caller could not read off the key. The three facts below are the ones
 * that actually decide whether a call works, and all three come from `files/sandbox.ts`:
 *
 * - a LEADING SLASH IS STRIPPED rather than refused, so `/a/b.md` and `a/b.md` are the same file. Browsers
 *   supply the first form and nothing warns you they are the same;
 * - paths are NFC-normalised, so two Unicode spellings of one accented name resolve to one path;
 * - a `..` that would leave the space is refused outright.
 *
 * `extra` carries what differs per tool — whether the path must exist, and what happens if it does.
 */
export function filePathSchema(extra: string) {
  return {
    type: 'string',
    minLength: 1,
    description: 'Path relative to the space root, exactly as `list_dir` and `recall` report it. ' + extra
      + ' A LEADING SLASH IS STRIPPED rather than refused, so `/notes/a.md` and `notes/a.md` name the same '
      + 'file; the path is Unicode-normalised, so two spellings of one accented name resolve together; and '
      + 'a `..` that would leave the space is refused.',
  } as const;
}

/**
 * The chrono `recurrence` block, shared by `save_chrono` and `update_chrono`.
 *
 * It was two near-identical literals differing only in the word "Optional", and `freq` — the one REQUIRED
 * field — had no description in either copy. Two copies of one schema is the shape this repo produces most,
 * so it is one function called twice rather than a second literal kept in step by hand.
 *
 * The trap is in the lead sentence and it is worth stating on both tools: the rule is STORED and validated
 * (`parseRecurrence`), and nothing anywhere expands it. It describes the entry; it does not generate more.
 */
export function recurrenceSchema(lead: string) {
  return {
    type: 'object',
    description: lead + ' e.g. { freq: "weekly", interval: 1, until: "2027-01-01T00:00:00Z" }. '
      + 'IT DESCRIBES THE ENTRY AND GENERATES NOTHING — no further entries are created from it, and no '
      + 'listing expands it into occurrences. If you need each occurrence to be findable by date, write '
      + 'each one.',
    properties: {
      freq: {
        type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'],
        description: 'How often the entry repeats. The only required field of the block, and the four values '
          + 'listed are the whole set — anything else is refused by name rather than ignored.',
      },
      interval: { type: 'integer', minimum: 1, default: 1, description: 'Repeat every N periods (positive integer, default 1).' },
      until: { type: 'string', description: 'Optional ISO 8601 date the repetition stops at. Omit for open-ended.' },
    },
    required: ['freq'],
    additionalProperties: false,
  } as const;
}

/** MongoDB operators the structured `query` filter accepts — mirrors `ALLOWED_OPERATORS` (brain/query.ts). */
export const QUERY_FILTER_OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not',
  '$exists', '$type', '$regex', '$options', '$all', '$elemMatch', '$size', '$mod',
] as const;

/*
 * `RECALL_FILTER_KEY_PATTERN` WAS HERE AND IS DELETED, not merely left unreferenced.
 *
 * It was a `propertyNames` pattern for the recall filter's keys, and its own comment carried the admission:
 * *"mirrors `ALLOWED_FILTER_KEY_PREFIXES` (brain/filter.ts)"*. One allowlist, two encodings, free to disagree
 * — and they did. The pattern also refused `$or`/`$and`/`$not` as keys, so a schema written to document the
 * legal keys ended up rejecting the raw-Mongo grammar the same tool's description promises and REST delivers.
 *
 * The resolver (`brain/recall-filter.ts`) enforces the allowlist RECURSIVELY, in either grammar, and is now
 * the only copy. Do not reintroduce a schema-side mirror: the dispatcher validates arguments before the
 * handler runs, so a mirror that drifts narrow becomes a refusal the resolver never gets to answer.
 */

/** Format a RecallResult as a single human-readable summary line. */
export function formatRecallSummary(r: RecallResult): string {
  switch (r.type) {
    case 'fact':
      return r.fact;
    case 'entity':
      return `${r.name} (${r.entityType})`;
    case 'edge':
      return `${r.from} → ${r.label} → ${r.to}`;
    case 'chrono':
      return r.description ? `${r.title}: ${r.description}` : r.title;
    case 'file':
      return r.description ? `${r.path}: ${r.description}` : r.path;
  }
}

/**
 * A recall result, shrunk for an MCP response.
 *
 * **Every field here is multiplied by `topK` and paid for in tokens by whoever called the tool.** That is
 * the whole reason this function exists rather than returning the result object: the REST caller is a
 * program and can afford detail, the MCP caller is a model's context window and cannot.
 *
 * Two things are dropped unconditionally because they carry no information a caller does not already
 * have, not to save space at the cost of usefulness:
 *
 *  - `embeddingModel` — identical for every record in a space. Instance configuration, not a per-record
 *    signal, and it was being repeated on every row.
 *  - `seq` — the per-space monotonic counter that sync orders replication by. It is not an input to any
 *    tool, nothing outside `sync/*` reads it, and it means nothing to a model. A caller that genuinely
 *    needs it can read the record by `_id`.
 *
 * `createdAt` / `updatedAt` deliberately STAY. They cost about the same as `seq` did and, unlike it,
 * answer a question a caller actually asks — whether what it just found is still current.
 *  - `matchedText` — the concatenated string that was fed to the embedding model. For a file chunk it is
 *    `headingText + ' ' + content`; for a media chunk it is byte-identical to `content`; for the other
 *    types it is a rendering of fields the record already carries. So it was returning the passage TWICE
 *    per result — measurably the largest single waste in the response — and the copy it duplicated is
 *    the better one: `content` is a named field with a defined meaning, `matchedText` is a blob. Owner,
 *    2026-07-29: *"I want the content if not flagged false. matched text does not interest me really."*
 *    Checked before removing: audio, video and image chunks all write the transcript/caption to BOTH
 *    `content` and `matchedText`, so nothing is only in the blob.
 *
 * `includeFileContent: false` additionally drops the passage body itself — see the tool schema.
 */
export function toRecallRecord(
  r: RecallResult,
  opts: { includeFileContent?: boolean; includeDiagnostics?: boolean } = {},
): Record<string, unknown> {
  const includeFileContent = opts.includeFileContent !== false;
  // The three RECORD-level diagnostics, off by default on both doors since 3.1.0 — see
  // `RECALL_RECORD_DIAGNOSTICS` for why they are withheld and why the list is shared. The ranking scores are
  // NOT added here: they describe how this result placed, not what the record is, so they sit beside `score`
  // on the result rather than inside it.
  const common: Record<string, unknown> = {
    _id: r._id,
    ...diagnosticFields(r as unknown as Record<string, unknown>,
      RECALL_RECORD_DIAGNOSTICS, opts.includeDiagnostics === true),
  };
  if (r.createdAt !== undefined) common['createdAt'] = r.createdAt;
  if (r.updatedAt !== undefined) common['updatedAt'] = r.updatedAt;
  if (r.tags !== undefined) common['tags'] = r.tags;
  if (r.description !== undefined) common['description'] = r.description;
  if (r.properties !== undefined) common['properties'] = r.properties;
  /*
   * THE RETIREMENT MARK IS NEVER TRIMMED, and it is the one field here that costs nothing to keep.
   *
   * Everything above is weighed against `topK` because it is paid for on every row. This is written only
   * onto a record somebody retired, so the common row does not carry it at all — and on the rare row that
   * does, dropping it is what leaves a caller holding two contradictory claims with nothing to choose
   * between them. That is the defect `Q-35` is about, so the saving would BE the bug.
   *
   * Only ever present when true: `superseded: false` says the same thing as its absence.
   */
  if (r.superseded === true) common['superseded'] = true;
  switch (r.type) {
    case 'fact':
      return { ...common, fact: r.fact };
    case 'entity':
      return { ...common, name: r.name, type: r.entityType };
    case 'edge':
      return { ...common, from: r.from, to: r.to, label: r.label, ...(r.weight !== undefined ? { weight: r.weight } : {}), ...(r.edgeType !== undefined ? { type: r.edgeType } : {}) };
    case 'chrono':
      return { ...common, title: r.title, type: r.chronoType, startsAt: r.startsAt, ...(r.status !== undefined ? { status: r.status } : {}) };
    case 'file': {
      // `content` is the passage. It is what a caller asked for unless they said otherwise.
      const keepContent = includeFileContent && r.content !== undefined;
      return { ...common, path: r.path, ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}), ...(r.parentFileId !== undefined ? { parentFileId: r.parentFileId } : {}), ...(r.chunkIndex !== undefined ? { chunkIndex: r.chunkIndex } : {}), ...(r.headingText !== undefined ? { headingText: r.headingText } : {}), ...(keepContent ? { content: r.content } : {}) };
    }
  }
}



