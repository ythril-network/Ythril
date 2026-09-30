/**
 * Every quantity a caller sends has a bound, on the axis that costs — declared ONCE, read by every door (`Q-108`).
 *
 * ## Why one module
 *
 * A bound written into an MCP schema and forgotten in the REST validator is the parity defect `CLAUDE.md` names first:
 * the same call refused on one door and served on the other. The sync door had been refusing a record with more than
 * 100 tags since it was written, while all four write doors took any number — so a record saved on one instance with
 * 101 tags could never be pushed to a peer, and nothing said why. Each number below is the ONE value every schema
 * (`maxItems`) and every validator reads, and `every-quantity-a-caller-sends-has-a-bound.test.js` asserts that a field
 * named in `BOUND_BY_FIELD` carries exactly this bound wherever it is declared.
 *
 * ## What "the axis that costs" means
 *
 * A COUNT where the server does work per entry (a lookup per id, a link per target, a delete per path), BYTES where
 * the server holds what it was sent (the notify ring), a CHECK where the cost is a label rather than a size (a
 * metric's tool name). A bound on the wrong axis is no bound: a ring of 500 events held gigabytes when each event
 * could be ten megabytes.
 *
 * ## Refused, never clamped
 *
 * A caller over a bound gets a 400 naming the field and the bound (`tooManyError`). Serving fewer than were sent
 * answers a question the caller did not ask and makes it look answered.
 *
 * A leaf: no imports, so the sync schemas, the brain validators and the tool schemas all read it without a cycle.
 */

/** Characters in a fact's `fact` — on every write door AND the sync door, which took any length until `Q-108`. */
export const MAX_FACT_LENGTH = 50_000;

/** Tags on one record. The sync door's value since it existed — the write doors follow it, not the reverse. */
export const MAX_TAGS = 100;

/** Targets in one `link*` field (`linkEntities`, `linkFacts`, `linkChronos`). Each is resolved, then written as a link. */
export const MAX_LINKS_PER_KIND = 1_000;

/** Labelled edges written inline with one record (`edges`). The same count as one `save_bulk` array. */
export const MAX_INLINE_EDGES = 500;

/** Paths in one `deleteFields`. Each is its own `$unset` path, validated segment by segment. */
export const MAX_DELETE_FIELDS = 100;

/** Labels one traversal may narrow to (`edgeLabels`). Each is an `$in` entry on every hop's edge read. */
export const MAX_EDGE_LABELS = 100;

/** Space ids one call names (a network's spaces, a proxy's members, a webhook's spaces, a reorder). */
export const MAX_SPACE_IDS = 1_000;

/** Folders one space create makes. Each is a directory created on disk. */
export const MAX_CREATE_FOLDERS = 100;

/** Ids in one `POST /api/conflicts/bulk-resolve`: the most the conflict listing shows, which is what a caller selects from. */
export const MAX_CONFLICT_IDS = 2_000;

/** Bytes of one notify event's `data`, serialised. Every sender in this codebase sends a space id and a label. */
export const NOTIFY_DATA_MAX_BYTES = 8 * 1024;

/** Bytes the notify ring may hold across its events — the axis the ring costs on, beside its count. */
export const NOTIFY_RING_MAX_BYTES = 1024 * 1024;

/** Sessions in one `ingest` of a raw conversation. */
export const MAX_INGEST_SESSIONS = 1_000;

/** Turns across all the sessions of one `ingest`. Every turn is read by the model phases. */
export const MAX_INGEST_TURNS = 20_000;

/** `ingest` runs that may be unfinished at once, instance-wide. Each holds model calls for minutes. */
export const MAX_ACTIVE_INGEST_RUNS = 4;

/** Open Server-Sent Event streams per stream kind, instance-wide. */
export const MAX_SSE_CONNECTIONS = 200;

/** Bytes an SSE stream may have queued for a slow reader before it is closed (the client reconnects and re-reads). */
export const SSE_MAX_BUFFERED_BYTES = 256 * 1024;

/**
 * The bound a field of this NAME carries wherever it is declared — what the one-bound gate reads.
 *
 * Only names that mean one thing everywhere belong here. `spaces` does not: the same spelling is a network's space
 * list in one schema and an option in another, so it is bounded per schema instead.
 */
export const BOUND_BY_FIELD: Readonly<Record<string, number>> = Object.freeze({
  tags: MAX_TAGS,
  linkEntities: MAX_LINKS_PER_KIND,
  linkFacts: MAX_LINKS_PER_KIND,
  linkChronos: MAX_LINKS_PER_KIND,
  edges: MAX_INLINE_EDGES,
  deleteFields: MAX_DELETE_FIELDS,
  edgeLabels: MAX_EDGE_LABELS,
});

/** The refusal for a list over its bound — one wording, so a caller comparing the doors reads one sentence. */
export function tooManyError(field: string, got: number, max: number): string {
  return `\`${field}\` may hold at most ${max} entries (got ${got})`;
}

/** The refusal when `value` is an array longer than `max`, else null. Not-an-array is the caller's own check. */
export function countError(field: string, value: unknown, max: number): string | null {
  return Array.isArray(value) && value.length > max ? tooManyError(field, value.length, max) : null;
}

/** `tags` checked whole: an array of strings, at most `MAX_TAGS`. */
export function tagsError(value: unknown, field = 'tags'): string | null {
  if (!Array.isArray(value) || value.some(t => typeof t !== 'string')) return `\`${field}\` must be an array of strings`;
  return countError(field, value, MAX_TAGS);
}
