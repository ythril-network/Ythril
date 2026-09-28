/**
 * A SIZE BUDGET for a result set: an answer is cut to what fits, never to a record count.
 *
 * Silent truncation is worse than a small answer, so EVERY response states `truncated`, the budget applied and
 * the size actually sent — not only when it bit, so absence never has to be interpreted.
 *
 * Size is the only limit. It already prices a dense subtree above a sparse one, and a second limit (records,
 * nodes) would let two rules disagree about the same response.
 */
import { log } from '../util/log.js';

/**
 * TWO DEFAULTS, ONE PER DOOR — a sanctioned divergence, not drift (`CLAUDE.md`, "MCP and REST are ONE API").
 *
 * Both doors take the same parameters with the same floor, ceiling and refusals; only the number applied when
 * the caller says nothing differs. An MCP result lands in the agent's own context and meets a per-result
 * ceiling inside the client that the caller cannot raise (a ~98 KB in-budget answer was refused outright); a
 * REST body lands in a buffer the caller allocated.
 *
 * The divergence holds only under three conditions: MCP is genuinely the lower default, every MCP call site
 * resolves it through `defaultBudgetChars` rather than remembering to, and both doors disclose the number they
 * used (`budgetChars`).
 *
 * 25 000 is ~6 records at ~4 KB, ~7 000 tokens. It is NOT a measured client ceiling — only that one refusal is
 * known — so it sits well below it. A caller wanting more states `maxChars`, up to `MAX_MAX_BYTES`, on either door.
 *
 * These are CHARACTER defaults and `maxBytes` has none: a byte ceiling equal to the character default would bind
 * on every non-ASCII response (bytes ≥ characters), a silent tightening.
 */
export const DEFAULT_MAX_CHARS = 50_000;

/** The MCP door's default. See the note above `DEFAULT_MAX_CHARS` — lower, deliberately, and on one door. */
export const MCP_DEFAULT_MAX_CHARS = 25_000;

/**
 * Which default a call gets, decided from the door that received it — the ONE place that is decided.
 *
 * The TRANSPORT decides, not the module: tool modules are also served as plain HTTP (`POST /api/<tool-name>`),
 * so a module reading the MCP constant silently halves a script's default depending on the URL it used. The
 * lower number belongs to whoever carries the bytes in their context, and `ToolCaller.transport` is what records
 * the door. This is how the second of the three conditions above is met.
 */
export function defaultBudgetChars(transport: 'mcp' | 'rest'): number {
  return transport === 'mcp' ? MCP_DEFAULT_MAX_CHARS : DEFAULT_MAX_CHARS;
}

/** Floor and ceiling on what a caller may ask for. A budget of zero would be a response with no results. */
export const MIN_MAX_BYTES = 1_000;
export const MAX_MAX_BYTES = 5_000_000;

/**
 * Characters per token, for the `maxTokens` convenience. **3.5, and the match count rounds DOWN.**
 *
 * The realistic span for these payloads is 3.0–3.9 (JSON scaffolding ~2.6, English prose ~4.0). The customary
 * 4.0 UNDER-counts tokens, worst on graph-heavy responses; undershooting a budget costs a page, overshooting a
 * blown context. The figures are BPE estimates over a field inventory, not a measured tokenisation.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

export interface BudgetRequest {
  /** A ceiling on the serialised response body in CHARACTERS, and the one that carries the defaults. */
  maxChars?: unknown;
  /**
   * A ceiling on the serialised response body in real UTF-8 BYTES. **No default** (see `DEFAULT_MAX_CHARS`):
   * opt-in, for a client whose limit really is in bytes.
   */
  maxBytes?: unknown;
  /**
   * A convenience, converted to CHARACTERS at the fixed `DEFAULT_CHARS_PER_TOKEN`. Never the authority: a
   * caller who needs an exact ceiling states `maxChars`.
   */
  maxTokens?: unknown;
}

/**
 * The parameter names above, at RUNTIME, for every door that has to admit them.
 *
 * A strict request body refuses what it does not name, so every door admits this list rather than its own
 * copy — a parameter added here and missing from a copy would be a 400 on that route. The interface is erased
 * at runtime, so the list lives beside it; a name added here must also be handled in `resolveBudget`.
 */
export const BUDGET_REQUEST_FIELDS: readonly string[] = Object.freeze([
  'maxChars', 'maxBytes', 'maxTokens',
]);

/** The two ceilings a response is held to. `bytes` is `null` when the caller did not ask for one. */
export interface ResolvedBudget {
  chars: number;
  bytes: number | null;
}

/** What a caller's budget arguments resolve to, or the refusal text if they do not. */
export type BudgetResolution =
  | ({ ok: true } & ResolvedBudget)
  | { ok: false; error: string };

const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : null;

/**
 * Resolve `maxChars` / `maxBytes` / `maxTokens` into TWO ceilings; when several are set, the lower wins.
 *
 * "Lower wins" is not a `Math.min` ACROSS units — characters and bytes are different scales. Both ceilings are
 * carried and `applyBudget` stops when EITHER would be exceeded. Within one unit a minimum is meaningful, so
 * `maxTokens` (converted to characters) and `maxChars` resolve to their minimum.
 */
export function resolveBudget(req: BudgetRequest, operatorDefault = DEFAULT_MAX_CHARS): BudgetResolution {
  const { maxChars, maxBytes, maxTokens } = req;

  if (maxChars !== undefined && posInt(maxChars) === null) {
    return { ok: false, error: '`maxChars` must be a positive integer number of characters' };
  }
  if (maxBytes !== undefined && posInt(maxBytes) === null) {
    return { ok: false, error: '`maxBytes` must be a positive integer number of bytes' };
  }
  if (maxTokens !== undefined && posInt(maxTokens) === null) {
    return { ok: false, error: '`maxTokens` must be a positive integer number of tokens' };
  }
  const ratio = DEFAULT_CHARS_PER_TOKEN;
  const charCandidates: number[] = [];
  const mc = posInt(maxChars);
  const mt = posInt(maxTokens);
  if (mc !== null) charCandidates.push(mc);
  if (mt !== null) charCandidates.push(Math.floor(mt * ratio));
  if (charCandidates.length === 0) charCandidates.push(operatorDefault);

  const chosenChars = Math.min(...charCandidates);
  const mb = posInt(maxBytes);
  return {
    ok: true,
    chars: clampBudget(chosenChars),
    // No default, and no clamp to a MINIMUM either: a caller who states 500 bytes has a reason, and raising
    // it to 1000 on their behalf would defeat the ceiling they asked for. The upper bound still applies.
    bytes: mb === null ? null : Math.min(mb, MAX_MAX_BYTES),
  };
}

/** The floor and ceiling every stated CHARACTER budget is held between. */
const clampBudget = (n: number): number => Math.min(Math.max(n, MIN_MAX_BYTES), MAX_MAX_BYTES);

/**
 * A query-string value as the paging and budget grammar takes it, for the GET doors whose parameters arrive as
 * strings (`GET /api/brain/spills/:id`). Absent stays absent; a numeric string becomes its number; ANYTHING
 * else passes through unchanged, so `resolvePaging` / `resolveBudget` refuse it with the same message a JSON
 * body gets. Not `parseSkip`/`parseLimit` (`util/pagination.ts`): those fall back to a default, and a door
 * that silently floors `skip=abc` to 0 is the one that disagrees with its twin.
 */
export function queryInt(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/**
 * `skip` and `remainderDump`, validated in ONE place for both doors, so no door can 400 what another silently
 * floors to a default.
 */
export type PagingResolution =
  | { ok: true; skip: number; remainderDump: boolean }
  | { ok: false; error: string };

export function resolvePaging(req: { skip?: unknown; remainderDump?: unknown }): PagingResolution {
  const { skip, remainderDump } = req;
  // Zero IS valid, so `posInt` is the wrong test here — the first page is `skip: 0` and a caller looping on
  // `nextSkip` has no reason to special-case its first call.
  if (skip !== undefined
      && !(typeof skip === 'number' && Number.isInteger(skip) && skip >= 0)) {
    return { ok: false, error: '`skip` must be a non-negative integer number of matches to skip' };
  }
  if (remainderDump !== undefined && typeof remainderDump !== 'boolean') {
    return { ok: false, error: '`remainderDump` must be a boolean' };
  }
  return { ok: true, skip: typeof skip === 'number' ? skip : 0, remainderDump: remainderDump === true };
}

export interface BudgetOutcome<T> {
  /**
   * The prefix that fits. Every entry is WHOLE — never a partial record, never a partial subtree.
   *
   * The price: the unit is a match TOGETHER WITH its whole `_graph` subtree, so a deeper or wider expansion
   * means fewer matches fit. They are absent rather than shortened. Every surface stating the guarantee
   * states this beside it (`expansion-costs-matches-and-says-so.test.js`).
   */
  returned: T[];
  /** The matches that did not fit, in rank order. Empty when nothing was cut. */
  remainder: T[];
  /** Serialised size of `returned`, in CHARACTERS — what `charsReturned` reports. */
  charsReturned: number;
  /** Serialised size of `returned`, in real UTF-8 BYTES — what `bytesReturned` reports. Both units, always. */
  bytesReturned: number;
  /** True when at least one match was omitted. */
  truncated: boolean;
}

/**
 * Take the longest PREFIX of `results` whose serialised size fits the budget.
 *
 * Atomic at the match: the first match whose complete `_graph` subtree would exceed the remaining budget is
 * omitted, **and so is every match after it**, even a smaller one that would fit. Only a prefix makes `skip`
 * correct — no overlap, no gap, no undetectable holes in a ranked answer.
 *
 * Measured on the SERIALISED form, in both units: `.length` counts UTF-16 code units, which undercounts the
 * bytes of non-ASCII text (by about a quarter for German or Polish), and a transport limit is in bytes. A row is
 * admitted only if it fits under both ceilings. Cost is one `JSON.stringify` per candidate, up to the first
 * overflow.
 *
 * A single match larger than the whole budget is still returned, alone — otherwise that record could never be
 * read.
 */
export function applyBudget<T>(results: readonly T[], budget: ResolvedBudget): BudgetOutcome<T> {
  const returned: T[] = [];
  const meter = budgetMeter(budget);
  let i = 0;
  for (; i < results.length; i++) {
    if (!meter.admit(results[i])) break;
    returned.push(results[i]!);
  }
  return {
    returned,
    remainder: results.slice(i) as T[],
    charsReturned: meter.chars(),
    bytesReturned: meter.bytes(),
    truncated: i < results.length,
  };
}

/**
 * THE admission rule, one item at a time — for a reader that cannot hold the whole list, such as a spill whose
 * pages are decoded only as the window reaches them (`read-spill-store.ts`). `applyBudget` is this in a loop.
 *
 * Measured on the SERIALISED item, in both units; EITHER ceiling stops it; the FIRST item is always admitted,
 * however large, or it could never be read. The envelope's own braces cost 2, and each item a separating comma.
 */
export function budgetMeter(budget: { chars: number; bytes: number | null }): {
  admit(item: unknown): boolean; chars(): number; bytes(): number;
} {
  let usedChars = 2;
  let usedBytes = 2;
  let admitted = 0;
  return {
    admit(item) {
      const serialised = JSON.stringify(item);
      const addChars = serialised.length + 1;
      const addBytes = Buffer.byteLength(serialised, 'utf8') + 1;
      const overChars = usedChars + addChars > budget.chars;
      const overBytes = budget.bytes !== null && usedBytes + addBytes > budget.bytes;
      if (admitted > 0 && (overChars || overBytes)) return false;
      usedChars += addChars;
      usedBytes += addBytes;
      admitted++;
      return true;
    },
    chars: () => usedChars,
    bytes: () => usedBytes,
  };
}

/**
 * The fields every budgeted response carries, truncated or not — always present, so absence never has to be
 * interpreted. `count` is the total number of matches, not the returned prefix.
 */
export function budgetFields<T>(
  outcome: BudgetOutcome<T>,
  totalMatches: number,
  budget: ResolvedBudget,
  /** The offset this page started at, so `nextSkip` is absolute rather than relative to the page. */
  skip = 0,
): Record<string, unknown> {
  return {
    returned: outcome.returned.length,
    count: totalMatches,
    truncated: outcome.truncated,
    // BOTH ceilings and BOTH figures, always; `budgetBytes` is `null` (present, not omitted) when unstated.
    budgetChars: budget.chars,
    budgetBytes: budget.bytes,
    charsReturned: outcome.charsReturned,
    bytesReturned: outcome.bytesReturned,
    /*
     * WHERE TO CONTINUE FROM, present exactly when there is somewhere to continue to. This is what makes the
     * remainder dump safe to make optional: an opt-in dump with no stated continuation strands a truncated
     * caller. Stated rather than left to `skip + returned` arithmetic, which a caller can get wrong.
     */
    ...(outcome.truncated ? { nextSkip: skip + outcome.returned.length } : {}),
  };
}

/**
 * The whole budgeted envelope for one response — the shape every result path (recall and find-similar, plain
 * and traversing, both doors) returns, so no path can apply the budget differently or not at all.
 *
 * `spillRemainder` is passed in because only the caller knows its token and the request to describe the spill
 * with. **It receives ONLY the matches that did not fit**, never what the caller already holds.
 */
export async function budgetedEnvelope<T, S>(opts: {
  results: readonly T[];
  /** BOTH ceilings, as `resolveBudget` produced them. See `ResolvedBudget`. */
  budget: ResolvedBudget;
  spillRemainder: (remainder: T[]) => Promise<S | null>;
  /** Offset this page began at, so the reported continuation is absolute. */
  skip?: number;
  /**
   * KEEP THE REMAINDER as a read spill? Default NO: the common caller wants the next page (`skip`), not a
   * download. (It no longer writes the space — Q-92 moved spills to the instance's read-spill store.) **This may only be optional BECAUSE `nextSkip` exists** — an opt-in
   * dump without a stated continuation strands a truncated caller, so the two must not be separated.
   */
  remainderDump?: boolean;
}): Promise<{ results: T[]; fields: Record<string, unknown> }> {
  // THE SLICE HAPPENS HERE, not at the call sites: a route that sliced before calling would make `count`
  // report the total AFTER the skip instead of the size of the whole answer.
  const skip = opts.skip ?? 0;
  const page = skip > 0 ? opts.results.slice(skip) : opts.results;
  const outcome = applyBudget(page, opts.budget);
  const fields = budgetFields(outcome, opts.results.length, opts.budget, skip);
  if (outcome.truncated && opts.remainderDump === true) {
    // A spill NEVER fails the read (Q-92): the answer already holds everything that fit and says where to
    // continue, so a refused or failed spill costs the caller a convenience, not the answer.
    let spill: S | null;
    try {
      spill = await opts.spillRemainder(outcome.remainder);
    } catch (err) {
      // `spillResultSet` reports its own failures and never throws; this guards any other spiller handed in,
      // and says so rather than swallowing it.
      log.warn(`Result spill failed: ${err instanceof Error ? err.message : String(err)}`);
      spill = null;
      fields['spillRefused'] = 'failed';
    }
    if (spill && typeof spill === 'object' && 'spillRefused' in spill) {
      fields['spillRefused'] = (spill as { spillRefused: unknown }).spillRefused;
    } else if (spill) {
      fields['remainder'] = spill;
    }
  }
  return { results: outcome.returned, fields };
}
