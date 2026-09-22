/**
 * What a recall answer spends the caller's byte budget on.
 *
 * ## The measurement this exists because of
 *
 * `maxChars` is a contract: it is how much of their context window a caller is willing to give to fact.
 * Measured on a real corpus, **30% of what came back was content** — 3,314 characters of JSON carrying 986
 * characters of remembered fact. The rest described the record's place in the store: when it was written,
 * when it was last touched, the ids of everything it links to, and empty collections saying nothing.
 *
 * At the budgets this competes at that is not a rounding error. A caller asking for 2,600 characters of
 * fact got about a thousand characters of what they came for and paid for the rest.
 *
 * ## Two rules, and only one of them is a choice
 *
 * **An empty collection is never worth sending.** `"tags":[]` and `"properties":{}` say nothing their
 * absence does not, and a caller reading `result.tags?.length` cannot tell the two apart. There is no
 * reading under which the empty version is the useful one, so this needs no flag and takes nothing away.
 *
 * **Storage bookkeeping is opt-in.** `createdAt` and `updatedAt` describe the record rather than what it
 * says. `createdAt` is the worse of them: it is routinely read as when the remembered thing happened,
 * which is not what it means — that lives in the record's own properties, put there by whoever wrote it.
 * A caller who needs either asks for it; the common case, reading fact in order to answer something,
 * does not.
 *
 * **The link-id arrays were the third of these and are GONE, not hidden.** A record's connections are
 * link records since 5.0, so no result carries them at any setting of the flag. What a caller wants them
 * FOR — the records on the other end — is `traverse`, which returns the records rather than ids to look
 * up one at a time, or a `filter` over the `links` collection.
 *
 * ## What is deliberately never dropped
 *
 * The content and the things needed to act on it: the record's own text, its `properties`, its `_id`, its
 * `type`, and the scores. A saving that loses the answer is not a saving — and the scores in particular are
 * the number that decided the result's position, which an owner ruling already says a caller must be able
 * to read.
 */

/** The fields that describe where a record SITS rather than what it says. Opt-in via `includeRecordMeta`. */
export const RECORD_META_KEYS = ['createdAt', 'updatedAt'] as const;

/** Collections whose empty form carries nothing a caller can act on. */
const COLLECTION_KEYS = ['tags', 'properties'] as const;

function isEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * A copy of `record` without its storage bookkeeping, applied at every depth of a graph expansion.
 *
 * COPIES rather than deleting in place. The same result objects are handed to the audit trail and to the
 * duplicate check as well as to the response, and editing one underneath those would change what they saw —
 * a bug that reads as a different subsystem being wrong.
 *
 * Recursive because a `traverse` answer is where the bytes actually are. A rule applied to the top level
 * only would leave the expensive half untouched while the numbers looked better, which is the shape of
 * every optimisation nobody measured.
 */
export function stripRecordMeta<T extends object>(
  record: T,
  opts: { includeRecordMeta?: boolean | undefined },
): Record<string, unknown> {
  const keep = opts.includeRecordMeta === true;
  const src = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (!keep && (RECORD_META_KEYS as readonly string[]).includes(key)) continue;
    if ((COLLECTION_KEYS as readonly string[]).includes(key) && isEmptyCollection(value)) continue;
    if (key === '_graph' && Array.isArray(value)) {
      out[key] = value.map(entry => stripGraphEntry(entry as Record<string, unknown>, opts));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** One `{ edges, node, paths, _graph }` wrapper, with the same rule applied to the node and its children. */
function stripGraphEntry(
  entry: Record<string, unknown>,
  opts: { includeRecordMeta?: boolean | undefined },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (out['node'] && typeof out['node'] === 'object') {
    out['node'] = stripRecordMeta(out['node'] as object, opts);
  }
  if (Array.isArray(out['_graph'])) {
    out['_graph'] = (out['_graph'] as unknown[])
      .map(child => stripGraphEntry(child as Record<string, unknown>, opts));
  }
  return out;
}
