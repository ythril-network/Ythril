/**
 * The remainder of a search answer, kept as a read spill — only when the caller asked for it.
 *
 * ## What used to be here, and why it went (Q-126)
 *
 * This file also held `buildGraphWithSpill`, which walked every matched record's neighbourhood together, cut
 * it to an inline node cap and — on every call whose neighbourhood was larger — wrote the complete graph to a
 * spill and returned a SHORTENED `_graph` beside a `graphComplete` link. That was the owner's ruling of
 * 2026-08-13: *"write the whole thing to the space's tmp files as JSON and hand back a download link with a
 * 1-day TTL instead of truncating it"*.
 *
 * The owner reversed it on 2026-09-28: *"i only want whole results and the rest gets truncated except if a flag
 * is set that says rest goes to a file"*, and *"if the requested graph doesnt fit the whole resultrow including
 * the root should be not returned"*. So a traversing answer now carries every row with its WHOLE graph or names
 * the row as left out (`row-graphs.ts`, `traversed-answer.ts`), and nothing is written unless
 * `remainderDump: true` — the one spill below. Graph spills issued before the change stay readable until they
 * expire; the store still knows the `graph` kind.
 *
 * ## What stands from the earlier decisions
 *
 * - **The spill lives in the instance's read-spill store, never in a space** (Q-92). It used to be a file under
 *   the space's `_tmp/`, which made a SEARCH a write. `read-spill-store.ts` holds it outside every space, for
 *   the token that caused it, for a day — and derives who may read it from the records inside.
 * - **The link is the spill route**, `GET /api/brain/spills/:id` (MCP `read_spill`), which checks the issuer and
 *   knowledge read on every member space.
 * - **A spill never fails the read.** A refusal or a store failure is reported as `spillRefused: <reason>`; the
 *   caller still has everything that fit, and `nextSkip` still reaches the rest.
 */
import { spillPathFor } from './spill-path.js';
import {
  putSpill, type PutSpillInput, type PutSpillResult, SPILL_TTL_DAYS, suppressEmbeddings,
} from './read-spill-store.js';
import { log } from '../util/log.js';

// Re-exported: the lifetime and the vector strip belong to the store, which applies both itself.
export { SPILL_TTL_DAYS, suppressEmbeddings };

/** The spill route for one spill. The one spelling of the link. */
export function spillDownload(id: string): string {
  return `/api/brain/spills/${encodeURIComponent(id)}`;
}

/** A refusal's short code (`over-share`, `instance-ceiling`, ...), which is what an answer carries. */
function refusalCode(refused: string): string {
  return refused.split(':')[0]!.trim();
}

/**
 * Hand one spill to the store, and never let it fail the read: a refusal is returned as its code, and a store
 * that THROWS is logged and reported as `failed`. The caller keeps its answer either way.
 */
async function keepSpill(
  kind: PutSpillInput['kind'],
  pending: Promise<PutSpillResult>,
): Promise<{ id: string; expiresAt: string } | { spillRefused: string }> {
  try {
    const r = await pending;
    if ('refused' in r) {
      log.info(`Read spill (${kind}) not kept: ${r.refused}`);
      return { spillRefused: refusalCode(r.refused) };
    }
    return r;
  } catch (err) {
    log.warn(`Read spill (${kind}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return { spillRefused: 'failed' };
  }
}

/**
 * WHO DECIDES A RESULT SET IS TOO BIG — and it is not this file.
 *
 * `SPILL_INLINE_RESULTS = 3` and `SPILL_RECORD_THRESHOLD = 25` used to live here: past 25 records a response
 * collapsed to three inline matches plus a download of the WHOLE set. X-17 replaced that with the byte budget
 * in `result-budget.ts`, and both constants are gone rather than kept for reference, because a threshold left
 * in the file that writes the spill is a second rule about size that can disagree with the first — this
 * codebase's most-produced defect, and it did disagree. The graph node cap that lived here until Q-126 was the
 * same defect again, one layer down: a second size rule, below the budget, that shortened rows the budget had
 * promised were whole.
 *
 * So `spillResultSet` does not ask whether to spill. It is called only when the budget has already cut
 * something and the caller asked for the remainder, and it always writes what it is handed.
 */

/**
 * Where a spilled result set went — or, when it could not be kept, why. The refused form still says how much
 * was cut, and the answer beside it still carries `truncated` and `nextSkip`, so the caller can page instead.
 */
export type ResultSpill =
  | {
    /** Matches in the spill — the ones that did not fit the budget, never the ones already returned inline. */
    matches: number;
    /** Every record in the spill, matches and their traversed nodes together. */
    records: number;
    spillId: string;
    /** Deprecated `_tmp/results-<spillId>.json`. No such file exists; kept additively, removed at the next major. */
    path: string;
    download: string;
    expiresAt: string;
  }
  | { matches: number; records: number; spillRefused: string };

/**
 * Count the traversed nodes a payload actually carries, at every depth and on either door.
 *
 * A count taken from the payload cannot disagree with the payload. It walks for `_graph` at any depth, which is
 * also what makes it work on both doors without knowing either shape: REST puts `_graph` beside the record's
 * own fields, MCP beside `record`, and a nested node carries its own `_graph` again.
 */
export function countGraphNodes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countGraphNodes(v), 0);
  if (value === null || typeof value !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '_graph' && Array.isArray(v)) n += v.length;
    n += countGraphNodes(v);
  }
  return n;
}

/**
 * Write out the matches that did not fit the budget, and say where they went.
 *
 * **It does not decide anything.** The byte budget in `result-budget.ts` decides, and calls this only with a
 * non-empty remainder the caller asked for — so there is no "it fits" branch here and no `null` return.
 *
 * No space is named: the store derives who may read the spill from the `spaceId` every match carries, so a
 * cross-space or proxy recall is read-checked against every space its remainder came from.
 */
export async function spillResultSet(opts: {
  /** The calling token's id. The spill is readable by it alone; none means no spill. */
  issuedTo: string | null | undefined;
  /** The matches that did not fit, with their whole `_graph` trees attached. */
  results: unknown[];
  /** What the caller asked for, echoed into the spill so it is self-describing a day later. */
  request: Record<string, unknown>;
}): Promise<ResultSpill> {
  const graphNodes = countGraphNodes(opts.results);
  const records = opts.results.length + graphNodes;

  const kept = await keepSpill('results', putSpill({
    kind: 'results',
    issuedTo: opts.issuedTo,
    items: opts.results,
    request: { ...opts.request, matches: opts.results.length, graphNodes, records },
  }));
  if ('spillRefused' in kept) return { matches: opts.results.length, records, spillRefused: kept.spillRefused };
  return {
    matches: opts.results.length,
    records,
    spillId: kept.id,
    path: spillPathFor('results', kept.id),
    download: spillDownload(kept.id),
    expiresAt: kept.expiresAt,
  };
}
