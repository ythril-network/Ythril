/**
 * A SIZE BUDGET for a result set: an answer is cut to what fits, never to a record count.
 *
 * Silent truncation is worse than a small answer, so EVERY response states `truncated`, the budget applied and
 * the size actually sent — not only when it bit, so absence never has to be interpreted.
 *
 * Size is the only limit. It already prices a dense subtree above a sparse one, and a second limit (records,
 * nodes) would let two rules disagree about the same response.
 */
import { log, peerText } from '../util/log.js';

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
 * The sentence a tool schema states the two defaults in — here, so no schema module names either constant (`Q-161`).
 * The door decides which applies; a caller reading one door's schema still has to learn the other's number.
 */
export function budgetDefaultsSentence(): string {
  return `Default ${MCP_DEFAULT_MAX_CHARS} on MCP and ${DEFAULT_MAX_CHARS} on REST — the one default the two doors `
    + 'deliberately differ on, because an MCP result meets a ceiling inside your client that you cannot raise. RAISE IT '
    + 'IF YOUR CLIENT CAN TAKE MORE.';
}

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
  /** What ONE carriage of the answer may hold — the stated budget divided by `carriagesFor(transport)`. */
  chars: number;
  bytes: number | null;
  /**
   * The budget as the caller stated it (or the door's default), before it was shared between carriages — what an
   * answer DISCLOSES as `budgetChars` / `budgetBytes`. Absent on a hand-built budget, which then discloses its own.
   */
  stated?: { chars: number; bytes: number | null };
  /**
   * The parameter that SET the character ceiling — `maxTokens` when its conversion was the lower, `maxChars`
   * otherwise. Absent when neither was sent: the door's default, which a caller raises by stating `maxChars`.
   * What `budgetBoundBy` names when the character ceiling is the one that cut an answer (`Q-116`).
   */
  charsFrom?: 'maxChars' | 'maxTokens';
}

/** The size parameters a budget-truncated answer can name as the one to raise (`budgetBoundBy`). */
export type BudgetParameter = 'maxChars' | 'maxTokens' | 'maxBytes';

/** Which of the two ceilings refused the row that ended an answer. */
export interface CeilingRefusal { chars: boolean; bytes: boolean }

/**
 * The PARAMETERS to raise for an answer the budget cut, named from the ceilings that refused the next row
 * (`Q-116`). A form with three "Max response size" fields, or an agent with three parameters, cannot act on
 * "truncated: budget" alone; only the meter knows which ceiling it was, so it is said here rather than inferred
 * from `budgetChars`/`budgetBytes` by every reader — an inference that cannot tell when both are set and the byte
 * ceiling is the larger. Both are named when the row would have passed both: raising one would not admit it.
 */
export function budgetBoundBy(refusal: CeilingRefusal, budget: ResolvedBudget): BudgetParameter[] {
  const out: BudgetParameter[] = [];
  if (refusal.chars) out.push(budget.charsFrom ?? 'maxChars');
  if (refusal.bytes) out.push('maxBytes');
  return out;
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
export function resolveBudget(
  req: BudgetRequest,
  operatorDefault = DEFAULT_MAX_CHARS,
  /**
   * How many times the door carries the body — `carriagesFor(transport)`. The stated budget bounds what crosses the
   * wire, so a door that sends the rows twice holds each copy to its share (`Q-111`). The answer still DISCLOSES the
   * stated figure (`stated`), which is what the caller asked for and what `budgetChars` reports.
   */
  carriages = 1,
): BudgetResolution {
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
  // A tie is named `maxChars`: it is the unit the ceiling is counted in.
  const charsFrom: ResolvedBudget['charsFrom'] = mt !== null && (mc === null || Math.floor(mt * ratio) < mc)
    ? 'maxTokens' : mc !== null ? 'maxChars' : undefined;
  const mb = posInt(maxBytes);
  const stated = {
    chars: clampBudget(chosenChars),
    // No default, and no clamp to a MINIMUM either: a caller who states 500 bytes has a reason, and raising
    // it to 1000 on their behalf would defeat the ceiling they asked for. The upper bound still applies.
    bytes: mb === null ? null : Math.min(mb, MAX_MAX_BYTES),
  };
  const share = Math.max(1, Math.floor(carriages));
  return {
    ok: true,
    chars: Math.floor(stated.chars / share),
    bytes: stated.bytes === null ? null : Math.floor(stated.bytes / share),
    stated,
    ...(charsFrom ? { charsFrom } : {}),
  };
}

/**
 * How many times a door carries an answer's body (`Q-111`), which is what the stated budget is divided by.
 *
 * **MCP carries it twice, and cannot carry it once.** A tool result is `content` text AND `structuredContent`, and a
 * client may read either alone: the specification asks for the JSON in `content` for clients that do not read
 * structured results, and a client that SURFACES `structuredContent` showed a page with no rows when only `content`
 * held them (the rule in `mcp/tools/types.ts`). Dropping either loses the answer for some client, so both stay and
 * each is held to half — a 25 000-character budget used to arrive as about 52 KB.
 *
 * **REST carries it once.** The tool door answers `data` and a one-line `text` (`api/tools.ts`), and every dedicated
 * route answers one JSON body.
 */
export function carriagesFor(transport: 'mcp' | 'rest'): number {
  return transport === 'mcp' ? 2 : 1;
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
  /** Which ceiling refused the first omitted match — present exactly when the METER cut the answer. */
  refusedBy?: CeilingRefusal;
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
  const refusedBy = meter.refusedBy();
  return {
    returned,
    remainder: results.slice(i) as T[],
    charsReturned: meter.chars(),
    bytesReturned: meter.bytes(),
    truncated: i < results.length,
    ...(refusedBy ? { refusedBy } : {}),
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
  admit(item: unknown): boolean; charge(item: unknown): void; chars(): number; bytes(): number;
  /** Which ceiling(s) refused the last refused item, or null when nothing was refused (`Q-116`). */
  refusedBy(): CeilingRefusal | null;
} {
  let usedChars = 2;
  let usedBytes = 2;
  let admitted = 0;
  let refused: CeilingRefusal | null = null;
  return {
    /**
     * Count something the answer carries that is NOT a row — a named left-out row (Q-126). Never refused: it
     * describes rows already consumed, and leaving it out would make the answer silent about them. It still
     * spends the budget, so the rows after it pay for it.
     */
    charge(item) {
      const serialised = JSON.stringify(item);
      usedChars += serialised.length + 1;
      usedBytes += Buffer.byteLength(serialised, 'utf8') + 1;
    },
    admit(item) {
      const serialised = JSON.stringify(item);
      const addChars = serialised.length + 1;
      const addBytes = Buffer.byteLength(serialised, 'utf8') + 1;
      const overChars = usedChars + addChars > budget.chars;
      const overBytes = budget.bytes !== null && usedBytes + addBytes > budget.bytes;
      if (admitted > 0 && (overChars || overBytes)) {
        refused = { chars: overChars, bytes: overBytes };
        return false;
      }
      usedChars += addChars;
      usedBytes += addBytes;
      admitted++;
      return true;
    },
    chars: () => usedChars,
    bytes: () => usedBytes,
    refusedBy: () => refused,
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
    // The STATED budget — what the caller asked for, whichever share of it one carriage was held to.
    budgetChars: budget.stated?.chars ?? budget.chars,
    budgetBytes: budget.stated ? budget.stated.bytes : budget.bytes,
    charsReturned: outcome.charsReturned,
    bytesReturned: outcome.bytesReturned,
    // WHICH size parameter to raise, when the meter is what cut it (`Q-116`) — never on a page that stopped for
    // another reason (a row limit, a walk that ran out), where raising a size would not help.
    ...(outcome.refusedBy ? { budgetBoundBy: budgetBoundBy(outcome.refusedBy, budget) } : {}),
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
    await keepRemainder(fields, () => opts.spillRemainder(outcome.remainder));
  }
  return { results: outcome.returned, fields };
}

/**
 * Keep a remainder and report it on the answer's `fields` — as `remainder`, or as `spillRefused` with its reason.
 *
 * **A spill NEVER fails the read** (Q-92): the answer already holds everything that fit and says where to continue,
 * so a refused or failed spill costs the caller a convenience, not the answer. That guard is the part a hand-written
 * copy drops, which is why both envelopes reach it here rather than each writing its own try/catch.
 */
async function keepRemainder<S>(fields: Record<string, unknown>, spill: () => Promise<S | null>): Promise<void> {
  let kept: S | null;
  try {
    kept = await spill();
  } catch (err) {
    // `spillResultSet` reports its own failures and never throws; this guards any other spiller handed in,
    // and says so rather than swallowing it.
    log.warn(`Result spill failed: ${peerText(err)}`);
    kept = null;
    fields['spillRefused'] = 'failed';
  }
  if (kept && typeof kept === 'object' && 'spillRefused' in kept) {
    fields['spillRefused'] = (kept as { spillRefused: unknown }).spillRefused;
  } else if (kept) {
    fields['remainder'] = kept;
  }
}

/** A result row that was left out because it could not be delivered whole, named so the caller is told. */
export interface IncompleteRow {
  _id: string;
  spaceId: string;
  type: string;
  /** Its name, title or a one-line summary — what a reader recognises it by. */
  name: string;
  reason: string;
}

/** At most this many left-out rows are named in one answer; `incompleteCount` counts them all. */
export const MAX_NAMED_INCOMPLETE_ROWS = 50;

/**
 * The same admission rule, for rows that are BUILT one at a time — a traversal's rows, whose graphs are walked
 * only while the budget can still take them (Q-126). One meter, so there is one statement of what fits.
 *
 * Row by row, in rank order from `skip`:
 * - a whole row is admitted while it fits, and the answer stops at the first that does not (`truncatedBy:
 *   'budget'`) — the first row of a page always fits, exactly as in `applyBudget`;
 * - a row that cannot be delivered whole is consumed and NAMED (`incompleteRows`, `incompleteCount`), never
 *   shortened — the naming is charged to the budget;
 * - a row the call's work bounds did not reach ends the answer (`truncatedBy: 'walk_budget' | 'deadline'`).
 *
 * `nextSkip` is always the index of the first row not consumed, so `returned + incompleteCount +
 * (count - nextSkip) = count - skip` holds on every page and paging always moves forward.
 *
 * With `remainderDump: true` and a budget cut, the rows after the cut are built too, within the same work
 * bounds, and handed to `spillRemainder` — whole rows only, with the left-out ones named beside them.
 */
export async function budgetedRowsEnvelope<T, S>(opts: {
  total: number;
  budget: ResolvedBudget;
  skip?: number;
  remainderDump?: boolean;
  build: (index: number, first: boolean) => Promise<{ row: T } | { incomplete: IncompleteRow } | { stop: string }>;
  spillRemainder: (remainder: T[], about: { incompleteRows: IncompleteRow[]; incompleteCount: number; stoppedAt?: number })
    => Promise<S | null>;
}): Promise<{ results: T[]; fields: Record<string, unknown> }> {
  const skip = opts.skip ?? 0;
  const meter = budgetMeter(opts.budget);
  const returned: T[] = [];
  const named: IncompleteRow[] = [];
  let incompleteCount = 0;
  let nextSkip: number | undefined;
  let truncatedBy: string | undefined;
  let pending: T | undefined;

  for (let i = skip; i < opts.total; i++) {
    const built = await opts.build(i, i === skip);
    if ('stop' in built) { nextSkip = i; truncatedBy = built.stop; break; }
    if ('incomplete' in built) {
      incompleteCount++;
      if (named.length < MAX_NAMED_INCOMPLETE_ROWS) { named.push(built.incomplete); meter.charge(built.incomplete); }
      continue;
    }
    if (!meter.admit(built.row)) { nextSkip = i; truncatedBy = 'budget'; pending = built.row; break; }
    returned.push(built.row);
  }

  const fields: Record<string, unknown> = {
    returned: returned.length,
    count: opts.total,
    truncated: nextSkip !== undefined,
    budgetChars: opts.budget.stated?.chars ?? opts.budget.chars,
    budgetBytes: opts.budget.stated ? opts.budget.stated.bytes : opts.budget.bytes,
    charsReturned: meter.chars(),
    bytesReturned: meter.bytes(),
    ...(nextSkip !== undefined ? { nextSkip, truncatedBy } : {}),
    // The same naming `budgetFields` gives, from the same meter, and only for a budget cut (`Q-116`).
    ...(truncatedBy === 'budget' && meter.refusedBy() ? { budgetBoundBy: budgetBoundBy(meter.refusedBy()!, opts.budget) } : {}),
    ...(incompleteCount > 0 ? { incompleteCount, incompleteRows: named } : {}),
  };

  if (pending !== undefined && opts.remainderDump === true && nextSkip !== undefined) {
    const remainder: T[] = [pending];
    const remNamed: IncompleteRow[] = [];
    let remIncomplete = 0;
    let stoppedAt: number | undefined;
    for (let j = nextSkip + 1; j < opts.total; j++) {
      const built = await opts.build(j, false);
      if ('stop' in built) { stoppedAt = j; break; }
      if ('incomplete' in built) {
        remIncomplete++;
        if (remNamed.length < MAX_NAMED_INCOMPLETE_ROWS) remNamed.push(built.incomplete);
        continue;
      }
      remainder.push(built.row);
    }
    await keepRemainder(fields, () => opts.spillRemainder(remainder, {
      incompleteRows: remNamed, incompleteCount: remIncomplete, ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    }));
  }
  return { results: returned, fields };
}
