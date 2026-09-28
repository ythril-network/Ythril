/**
 * What a read SPILL is on the wire: the complete answer a search did not fit inline, and how it is read back.
 *
 * ## Why this is its own module
 *
 * Two answers point at a spill, the results remainder (`remainder`) and the whole graph (`graphComplete`),
 * and they had each described it separately, as a file in the space. Since Q-92 a search writes nothing into a
 * space: the spill is held by the instance, belongs to the token that ran the search, and is read back page by
 * page through `GET /api/brain/spills/:id` (MCP `read_spill`). One description, so the two halves cannot drift
 * apart about what the link means or how long it lasts.
 *
 * ## The promise, and what it is not
 *
 * The complete result, readable by the same token for up to a day. "Up to": a spill can be evicted earlier
 * (the token's own older spills make room for newer ones), which is a 410 rather than a 404.
 */

/** A spill, as a search answer points at it. */
export interface SpillLink {
  /** The spill's id. Read it with `GET /api/brain/spills/<id>` or MCP `read_spill`. */
  spillId: string;
  /** `/api/brain/spills/<id>`: one page per request, so a whole download follows `nextSkip`. */
  download: string;
  /** ISO timestamp after which the spill is gone. It may be evicted earlier. */
  expiresAt: string;
  /**
   * @deprecated The pre-Q-92 file path (`_tmp/graph-<id>.json`, `_tmp/results-<id>.json`), kept so an older
   * MCP caller's `read_file` still resolves it. Due for removal at the next major; read `spillId` instead.
   */
  path: string;
}

/** The results remainder: the matches that did not fit the budget, a continuation rather than a copy. */
export interface ResultSpillLink extends SpillLink {
  /** Matches in the spill. */
  matches: number;
  /** Matches plus their traversed nodes. */
  records: number;
}

/**
 * Why a spill that was asked for (or that a short graph would have produced) was not kept. The answer then
 * carries no `remainder` / `graphComplete`, and falls back to `truncated` + `nextSkip` or `graphTruncated`.
 * Open-ended on purpose: a newer server's reason is shown as it arrives rather than dropped.
 */
/**
 * The refusal codes this client has words for (`brain.query.spillRefused.reason.<code>` in every locale). A spec
 * reads the server's producing code and fails when the server can send one missing here.
 */
export const SPILL_REFUSAL_CODES = ['over-share', 'instance-ceiling', 'no-token', 'unattributed', 'empty', 'failed'] as const;

export type SpillRefusal = (typeof SPILL_REFUSAL_CODES)[number] | (string & {});

/** The spill half of a recall or find-similar answer. */
export interface SpillReport {
  spillRefused?: SpillRefusal;
}

/** One page of a spill, as `GET /api/brain/spills/:id` returns it. */
export interface SpillPage {
  kind: 'results' | 'graph';
  /** The search that produced it, as it was asked. */
  request?: unknown;
  /** Items in the whole spill. */
  total?: number;
  expiresAt: string;
  /** The graph walk hit its own ceiling, so even the spill is not the whole graph. */
  ceilingHit?: boolean;
  /** This page: result records, or graph nodes. */
  items: unknown[];
  skip: number;
  /** Present exactly when there is more: send it back as `skip`. */
  nextSkip?: number;
  truncated: boolean;
}

/** A whole spill, every page assembled: what the page saves as one JSON file. */
export type WholeSpill = Omit<SpillPage, 'skip' | 'nextSkip' | 'truncated'>;

/**
 * The two refusals a spill read gives that mean different things to the reader, and the sentence for each:
 * 404 is unknown, expired or another token's (one answer, so a stranger learns nothing); 410 is the reader's
 * own spill, evicted before its day was up. Anything else is an ordinary failed download.
 */
/** The translation key for a refusal code's words, or null for a code from a newer server, shown as it arrived. */
export function spillRefusalKey(code: string): string | null {
  return (SPILL_REFUSAL_CODES as readonly string[]).includes(code) ? `brain.query.spillRefused.reason.${code}` : null;
}

export const SPILL_FAILURE_KEYS: Readonly<Partial<Record<number, string>>> = {
  404: 'brain.query.spill.notFound',
  410: 'brain.query.spill.gone',
};

/**
 * The widest window the server serves (`MAX_MAX_BYTES` in `server/src/brain/result-budget.ts`), in both units:
 * the REST door's character default is far lower, so a whole download states both to keep round trips few.
 */
export const SPILL_PAGE_MAX = 5_000_000;
