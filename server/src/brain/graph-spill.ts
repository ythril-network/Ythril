/**
 * A truncated graph traversal used to be indistinguishable from a complete one. Now it is never truncated
 * silently: the caller either gets the whole neighbourhood inline, or gets a link to the whole neighbourhood.
 *
 * ## The defect
 *
 * `traverseRecallSeeds` ends with `collected.slice(0, limit)` and the response said nothing about it. Sorting
 * by hops before truncating is right — near neighbours survive — but `graphNodes: 7` at `topK: 1, traverse: 1`
 * might be the whole neighbourhood or the first 7 of 40, and no field distinguished them.
 *
 * `degraded` does not cover it: that reports recall-stage degradation, a member that failed or timed out, not
 * the traversal cap.
 *
 * **Worse here than on a list.** A caller paging a list can compare against `total`. There is no total for a
 * neighbourhood, and the natural reading of a short graph is *"this record has few relationships"* — a wrong
 * conclusion about the DATA rather than about the request. The cap, `topK * (traverse + 1) * 4`, is also not
 * something a caller can predict from the parameters they set.
 *
 * ## Owner ruling, 2026-08-13 — a flag is not the answer
 *
 * *"Report the SIZE, and when a result exceeds a threshold, write the whole thing to the space's tmp files as
 * JSON and hand back a download link with a 1-day TTL instead of truncating it."*
 *
 * And that is the better answer: a flag tells a caller their graph was cut and leaves them no way to get the
 * rest, which on a neighbourhood is the same dead end the paging cap was on a list.
 *
 * ## The decisions, and what each is grounded in
 *
 * - **The threshold is the ROW COUNT**, using the existing cap formula, so today's truncation point becomes
 *   the spill point. It is the number the caller reasoned about when they set `topK` and `traverse`; a byte
 *   size is not.
 * - **The spill lives in the instance's read-spill store, never in a space** (Q-92). It used to be a file
 *   under the space's `_tmp/`, which made a SEARCH a write: a blob, a `<space>_files` record, a seq bump that
 *   synced it to every peer, an embed job. `read-spill-store.ts` holds it outside every space, for the token
 *   that caused it, for a day — and derives who may read it from the records inside.
 * - **The link is the spill route**, `GET /api/brain/spills/:id` (MCP `read_spill`), which checks the issuer
 *   and knowledge read on every member space. The files route was `files: read` on one space, so a
 *   knowledge-only token got a link it could not fetch and any files-read token could read every spill.
 * - **A spill never fails the read.** A refusal or a store failure degrades to today's truncated answer plus
 *   `spillRefused: <reason>`; the caller still has everything that fit and still knows it was cut.
 *
 * ## The ceiling, which is the part a spill could get wrong
 *
 * "Write the whole thing" cannot be unbounded — one hub with a hundred thousand edges would turn a bounded
 * read into an unbounded one. So the walk is bounded at `SPILL_CEILING_MULTIPLE ×` the inline cap, and when
 * even that is reached the spill file and the response BOTH say so (`ceilingHit`). A second silent truncation
 * hiding inside the fix for the first one is the failure this file exists to avoid.
 */
import { traverseRecallSeeds, type SeedTraverseNeighbor } from './recall-seed-traversal.js';
import { type TraverseNarrowing } from './frontier-query.js';
import { nestNeighbours, type RecallGraph } from './recall-graph.js';
import { spillPathFor } from './spill-path.js';
import {
  putSpill, type PutSpillInput, type PutSpillResult, SPILL_TTL_DAYS, suppressEmbeddings,
} from './read-spill-store.js';
import { log } from '../util/log.js';

// Re-exported: the lifetime and the vector strip belong to the store, which applies both itself.
export { SPILL_TTL_DAYS, suppressEmbeddings };

/**
 * How far past the inline cap a spill is allowed to walk.
 *
 * 20× turns a cap of 8 into 160 rows and a cap of 200 into 4000 — large enough that the spill is the complete
 * neighbourhood in every graph anyone has, small enough that one dense hub cannot make a read unbounded.
 */
export const SPILL_CEILING_MULTIPLE = 20;

/** Where the complete graph went, for a caller who received a truncated one inline. */
export interface GraphSpill {
  /** How many traversed nodes the spill holds. */
  nodes: number;
  /** The spill's id — what `read_spill` and `GET /api/brain/spills/:id` take. */
  spillId: string;
  /**
   * `_tmp/graph-<spillId>.json`. Deprecated and kept additively: no such file exists, but `read_file` and the
   * files download resolve it against the store for the issuer. Removed at the next major.
   */
  path: string;
  /** The spill route. Only the token that caused the spill can read it. */
  download: string;
  /** ISO timestamp after which the spill is gone. It may be evicted earlier by its owner's own newer spills. */
  expiresAt: string;
  /** Present and true when even the spill walk hit its ceiling, so the spill itself is not the whole graph. */
  ceilingHit?: boolean;
}

/** The spill route for one spill. The one spelling of the link, for both kinds. */
export function spillDownload(id: string): string {
  return `/api/brain/spills/${encodeURIComponent(id)}`;
}

/** A refusal's short code (`over-share`, `instance-ceiling`, ...), which is what an answer carries. */
function refusalCode(refused: string): string {
  return refused.split(':')[0]!.trim();
}

/**
 * Hand one spill to the store, and never let it fail the read: a refusal is returned as its code, and a store
 * that THROWS is logged and reported as `failed`. The caller keeps its truncated answer either way.
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
 * One graph node as a spill item: flat, so a single seed's tree can page. `via` names the hop that reached it;
 * `paths` keeps every route, so the tree can be rebuilt from the items.
 */
function spillNode(n: SeedTraverseNeighbor): Record<string, unknown> {
  return {
    id: n._id,
    spaceId: n.spaceId,
    depth: n.hops,
    seedId: n.idPath[0],
    via: { edgeId: n.edges[0]?._id ?? null, from: n.parentId },
    edges: n.edges,
    paths: [n.idPath, ...n.altPaths],
    ...(n.altPathsTruncated ? { pathsTruncated: true } : {}),
    record: n.record,
  };
}

export interface GraphWithSpill {
  /** The tree to return inline — capped exactly as before. */
  graph: RecallGraph;
  /** Present only when the inline tree is short of the real neighbourhood AND the complete one was kept. */
  spill: GraphSpill | null;
  /** Present when the inline tree is short and the complete one could NOT be kept: why. */
  spillRefused?: string;
  /**
   * The inline tree is short of the real neighbourhood, whether or not a complete copy exists.
   *
   * **These are two different facts and only one of them used to be reported.** A spill implies truncation,
   * so before this the flag could be derived from `spill` — but a link scan that stopped reading produces a
   * short graph with NO complete version to write, because the records it did not read are exactly the ones
   * missing. Deriving the flag from the file meant that case was reported as complete.
   */
  truncated: boolean;
}

/**
 * Expand the seeds, and if the neighbourhood is bigger than the inline cap, write the whole thing out.
 *
 * ONE walk, at the ceiling: a small graph exhausts itself long before the higher limit matters, so the extra
 * budget costs nothing on the calls that do not need it, and the calls that do are precisely the ones the
 * owner ruled must come back complete.
 */
export async function buildGraphWithSpill(
  memberIds: string[],
  seeds: { _id: string; spaceId: string }[],
  maxDepth: number,
  inlineCap: number,
  /**
   * Which labels to follow and which way — a recall's expansion narrows exactly as the standalone `traverse`
   * does. Absent means every label, both directions, which is what this always did.
   */
  narrowing?: TraverseNarrowing,
  /** The calling token's id: the spill is kept for it and readable by nobody else. None means no spill. */
  issuedTo?: string | null,
): Promise<GraphWithSpill> {
  const seedIds = seeds.map(s => s._id);
  if (inlineCap < 1 || maxDepth < 1 || seeds.length === 0) {
    return { graph: nestNeighbours([], seedIds), spill: null, truncated: false };
  }

  const ceiling = inlineCap * SPILL_CEILING_MULTIPLE;
  const { neighbours: flat, scanCapped } = await traverseRecallSeeds(memberIds, seeds, maxDepth, ceiling, narrowing);

  if (flat.length <= inlineCap) {
    /*
     * The whole neighbourhood fits — UNLESS a link scan stopped reading, in which case it fits only because
     * records were never read. There is no complete copy to write: the missing records are precisely the ones
     * the scan did not reach, so a spill file would be the same short graph under a name that promises
     * otherwise. `graphTruncated` alone is the honest answer, and it is why that flag no longer implies
     * `graphComplete`.
     */
    return { graph: nestNeighbours(flat, seedIds), spill: null, truncated: scanCapped };
  }

  const graph = nestNeighbours(flat.slice(0, inlineCap), seedIds);
  // No write space: the store derives the spill's member spaces from its nodes, so a proxy call, a cross-space
  // traversal and a single-space one are all read-checked against exactly the spaces their records came from.
  const ceilingHit = flat.length >= ceiling || scanCapped;
  // Stated in the spill as well as the response: whoever reads it a day later has only the spill, and a
  // partial graph that does not say so is the defect this whole module is about.
  const kept = await keepSpill('graph', putSpill({
    kind: 'graph',
    issuedTo,
    items: flat.map(spillNode),
    request: { seeds: seedIds, depth: maxDepth, ...(ceilingHit ? { ceiling: flat.length } : {}) },
    ceilingHit,
  }));
  if ('spillRefused' in kept) return { graph, spill: null, spillRefused: kept.spillRefused, truncated: true };
  return {
    graph,
    spill: {
      nodes: flat.length,
      spillId: kept.id,
      path: spillPathFor('graph', kept.id),
      download: spillDownload(kept.id),
      expiresAt: kept.expiresAt,
      ...(ceilingHit ? { ceilingHit: true } : {}),
    },
    truncated: true,
  };
}

/**
 * WHO DECIDES A RESULT SET IS TOO BIG — and it is no longer this file.
 *
 * `SPILL_INLINE_RESULTS = 3` and `SPILL_RECORD_THRESHOLD = 25` used to live here: past 25 records a response
 * collapsed to three inline matches plus a download of the WHOLE set. X-17 replaced that with the byte budget
 * in `result-budget.ts`, and both constants are gone rather than kept for reference, because a threshold left
 * in the file that writes the spill is a second rule about size that can disagree with the first — this
 * codebase's most-produced defect, and it did disagree: the guard `if (records <= 25) return null` was still
 * here after the budget started deciding, so a response truncated at twenty records with five left over said
 * `truncated: true` and carried NO link to the five. The caller was told there was more and given no way to
 * reach it.
 *
 * So `spillResultSet` no longer asks whether to spill. It is called only when the budget has already cut
 * something, and it always writes what it is handed.
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
    /** Deprecated `_tmp/results-<spillId>.json`; see `GraphSpill.path`. */
    path: string;
    download: string;
    expiresAt: string;
  }
  | { matches: number; records: number; spillRefused: string };

/**
 * Count the traversed nodes a payload actually carries, at every depth and on either door.
 *
 * **This replaces a `graphNodes` number the routes passed in, and the difference is the whole point.** That
 * number was the node total for the WHOLE result set. Under the byte budget the file holds only the matches
 * that did not fit, so the figure described a different set of records from the one being written — and
 * `records` is what a caller sizes the download by. A twenty-node answer truncated at its last match would
 * have advertised a file of twenty-odd records holding one.
 *
 * A count taken from the payload cannot disagree with the payload. It walks for `_graph` at any depth, which
 * is also what makes it work on both doors without knowing either shape: REST puts `_graph` beside the
 * record's own fields, MCP beside `record`, and a nested node carries its own `_graph` again.
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
 * non-empty remainder — so there is no "it fits" branch here and no `null` return. See the note above the
 * `ResultSpill` interface for the guard that used to be here and what it silently cost.
 *
 * No space is named: the store derives who may read the spill from the `spaceId` every match carries, so a
 * cross-space or proxy recall is read-checked against every space its remainder came from.
 */
export async function spillResultSet(opts: {
  /** The calling token's id. The spill is readable by it alone; none means no spill. */
  issuedTo: string | null | undefined;
  /** The matches that did not fit, with their `_graph` trees attached. */
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
