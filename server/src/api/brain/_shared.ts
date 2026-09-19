/**
 * Shared helpers for the /api/brain sub-routers.
 *
 * Extracted when the 1734-line api/brain.ts monolith was split by resource (A17.3). These are the
 * pieces every sub-router needs: webhook token attribution, space-meta lookup, the schema
 * validation gate, the fact list filter, and the UUID matcher.
 */
import { conveniencePredicate, conveniencesFrom } from '../../brain/list-conveniences.js';
import type express from 'express';
import { getConfig } from '../../config/loader.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';
import { parseRecordSuperseded } from '../../brain/record-flag.js';
import { resolveMetaRefs, type SchemaViolation } from '../../spaces/schema-validation.js';
import type { SpaceMeta } from '../../config/types.js';
import type { DupeCheckOpts } from '../../brain/write-options.js';
import { parseIfMatch } from '../../util/if-match.js';

/** Regex that matches a UUID v4 (case-insensitive). */
// Re-exported from the canonical definition so there is exactly one copy in the codebase.
export { UUID_V4_RE } from '../../brain/entity-refs.js';

// ── Webhook helper ────────────────────────────────────────────────────────

/** Extract token identification from the request for webhook payloads. */
export function webhookToken(req: express.Request): { tokenId?: string; tokenLabel?: string } {
  const t = req.authToken;
  if (!t) return {};
  return {
    tokenId: 'id' in t ? (t as { id: string }).id : undefined,
    tokenLabel: t.name,
  };
}

/**
 * Per-record TTL (F10) from a write body: a non-negative integer number of days to set an expiry,
 * `null` to explicitly clear it, or `undefined` (absent) to fall back to the space default.
 * Call `ttlDaysError` first — a present-but-invalid `ttlDays` is rejected there (fail-loud), so a typo
 * never silently degrades to "no expiry".
 */
export function ttlDaysFromBody(body: unknown): number | null | undefined {
  const v = (body as { ttlDays?: unknown })?.ttlDays;
  if (v === null) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 36500) return v;
  return undefined;
}

/**
 * Validate a write body's `ttlDays`: returns an error message when it is present but not `null` and not
 * an integer in `[0, 36500]`, else `null`. Absent (`undefined`) and `null` (clear) are both valid.
 * Mirrors the zod bound the space-wide `recordTtlDays` setting enforces, so the two TTL surfaces agree.
 */
export function ttlDaysError(body: unknown): string | null {
  const v = (body as { ttlDays?: unknown })?.ttlDays;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 36500) {
    return '`ttlDays` must be an integer number of days between 0 and 36500, or null to clear the expiry';
  }
  return null;
}

// ── Schema validation helpers ─────────────────────────────────────────────

/**
 * Both now live in `spaces/schema-validation.ts`, beside the validator they belong to, so that
 * `brain/` can reach them without importing `api/`. Re-exported here because every route already
 * imports them from `_shared` and there is no reason for those to change.
 */
export { getSpaceMeta, applyValidation } from '../../spaces/schema-validation.js';

/**
 * Build a MongoDB filter for the facts list route.
 *
 * The five common conveniences — `tag`, `type`, `description`, `properties`, `search` — go through
 * `conveniencePredicate`, the one module `filter` also calls, so the browser and an agent cannot come to
 * mean different things by `tag`. What stays here is the one name only a fact has: `entity`, an id
 * against the record's own link field.
 *
 * The refusal branch cannot fire for `facts` — it has searchable fields — so the throw is a structural
 * assertion rather than a path: reaching it would mean `facts` had left `SEARCHABLE_FIELDS`, and a
 * silent `{}` there is a full-collection read dressed as a filtered one.
 */
export function buildFactFilter(query: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  const entity = typeof query['entity'] === 'string' ? query['entity'] : undefined;
  if (entity) base['entityIds'] = entity;
  const merged = conveniencePredicate('facts', conveniencesFrom(query), base);
  if ('error' in merged) throw new Error(merged.error);
  return merged.predicate;
}

/**
 * Read the insert-time duplicate / contradiction flags from a REST write body.
 *
 * ## Why this exists
 *
 * The check itself is the same code MCP has always used — `upsertEntity`, `createMemory` and `createChrono`
 * all take a `DupeCheckOpts`, and the MCP tools fill it. REST simply never did, so the single best
 * knowledge-hygiene feature in the product was invisible to any client that speaks HTTP.
 *
 * An integrator reported it with the measurement that makes the case: their fleet is thirty n8n flows, n8n
 * speaks HTTP, so **every record they create is written over REST**. They also showed that recall cannot
 * stand in for it — the same pair scores 0.94 on the dedup check and 0.896 on recall, with unrelated topical
 * neighbours at 0.845, so no recall threshold separates a true near-duplicate from a coincidence.
 *
 * ## Why one reader rather than three
 *
 * Three record types take these flags, and three hand-written copies of "read, validate, default" is how the
 * surfaces drifted apart in the first place. One function means a fourth type is a one-line change and
 * cannot disagree with the others about what `dupeThreshold: "0.9"` means.
 *
 * ## Both flags are OPT-IN here, and that differs from MCP on purpose
 *
 * MCP's `save_fact` and `save_entity` default `checkDuplicates` ON. Copying that default to REST would be a
 * silent latency regression for every integration that exists today, because **the check implies
 * `waitForEmbedding`** — it needs the vector before the insert so the new record cannot match itself. Every
 * REST write would start paying the embedding model synchronously, including bulk loaders, without anyone
 * asking for it.
 *
 * The surfaces are asymmetric for a reason that survives stating: an MCP caller is an agent writing one
 * record and reading the answer, and REST is also how a fleet imports thousands. So the CAPABILITY is now
 * identical and the DEFAULT is not, which is documented rather than left to be discovered from a latency
 * graph.
 *
 * A REST caller that sends none of these gets today's behaviour, byte for byte.
 *
 * Returns an error string when a flag is present but the wrong type — never a coercion. `"false"` is truthy,
 * and a hygiene check that silently turns itself off is worse than one that was never asked for.
 */
// The record-suppression grammar lives in one place; this file only decides WHEN to read it.
export function dupeCheckOptsFromBody(body: unknown): { opts: DupeCheckOpts } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const opts: DupeCheckOpts = {};

  for (const key of ['checkDuplicates', 'checkContradictions'] as const) {
    const v = b[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { error: `\`${key}\` must be a boolean` };
    opts[key] = v;
  }

  if (b['dupeThreshold'] !== undefined) {
    const t = b['dupeThreshold'];
    // Bounded to the same 0..1 the score itself lives in. An out-of-range threshold is not a preference,
    // it is a caller who has misunderstood the scale — and 1.5 would silently mean "never warn".
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
      return { error: '`dupeThreshold` must be a number between 0 and 1' };
    }
    opts.dupeThreshold = t;
  }

  /*
   * The record tier of `record > schema > space`, read HERE rather than in each create route.
   *
   * It was in none of them: `suppressEmbeddings` was documented, worked on update, and was dropped on create,
   * so a caller who wanted a record retired from meaning-ranked search had to write it twice and live with a
   * window in between where it was searchable. Reported from outside on 2026-08-30.
   *
   * Both spellings, because `parseRecordSuppression` owns that grammar and the update paths already use it —
   * a create that took only the new name would be a third grammar for one switch, and the deprecated one is
   * what a 3.0-era caller is sending.
   */
  const sup = parseRecordSuppression(body);
  if (!sup.ok) return { error: sup.error };
  if (sup.value !== undefined) opts.suppressEmbeddings = sup.value;

  /*
   * The retirement mark, read here for the same reason as the tier above it: a create that could not state
   * it would force an agent correcting a fact to write the old one, then patch it, with a window in between
   * where a recall hands back a claim the caller already knows is stale.
   */
  const sus = parseRecordSuperseded(body);
  if (!sus.ok) return { error: sus.error };
  if (sus.value !== undefined) opts.superseded = sus.value;

  return { opts };
}

// ── Optimistic concurrency (If-Match) ─────────────────────────────────────

/**
 * The `If-Match` precondition for a brain-record PATCH, read off the request.
 *
 * `seq: undefined` with `ok: true` covers BOTH "no header" and `If-Match: *`. Neither constrains the
 * write: the absent header asks for no precondition at all, and `*` per RFC 9110 asks only that the
 * record exist, which the route has already established by reading it. Only an exact value becomes a
 * constraint on the write itself.
 *
 * A malformed value is an error rather than an ignored header — see `util/if-match.ts`. Answering 200
 * to a client that asked for a guarantee the server could not parse hands back the exact false safety
 * the header was sent to prevent.
 */
export function ifMatchFromRequest(req: express.Request): { ok: true; seq?: number } | { ok: false; error: string } {
  const parsed = parseIfMatch(req.get('If-Match'));
  switch (parsed.kind) {
    case 'none':
    case 'any':
      return { ok: true };
    case 'exact':
      return { ok: true, seq: parsed.value };
    case 'malformed':
      return {
        ok: false,
        error: `Malformed If-Match header: '${parsed.received}'. Expected the record's \`seq\`, e.g. If-Match: 41`,
      };
  }
}

/**
 * The body for a 412 on a brain record.
 *
 * `currentSeq` is re-read at failure time rather than reused from the read the route did before the
 * write — that value is already known to be stale, and handing a client a stale token to retry with
 * would send it round the same failure. Omitted when the record has since been deleted, which is a
 * real outcome of a precondition failure and not a 404: the client's condition was evaluated and not met.
 */
export function preconditionFailedBody(record: string, currentSeq?: number): Record<string, unknown> {
  return {
    error: currentSeq === undefined
      ? `This ${record} has been deleted since you read it. Re-read before writing.`
      : `This ${record} has changed since you read it. Re-read it and re-apply your change.`,
    ...(currentSeq === undefined ? {} : { currentSeq }),
  };
}

