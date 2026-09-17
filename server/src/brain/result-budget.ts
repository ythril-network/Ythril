/**
 * A BYTE BUDGET for a result set, replacing the record cap that collapsed a large answer to three.
 *
 * ## Why the record cap had to go, in one measurement
 *
 * The canary operator, 2026-08-17T1904Z, designed on the owner's instruction rather than proposed. The one
 * real overflow dump in their board space is 209,339 bytes; at their measured ~4 KB per record that is ~51
 * records. So a caller received **3 records inline plus a 204 KB file** — roughly 52k tokens to read in one
 * piece, because `read_file` takes no offset or limit. Twenty-five whole records inline would have been
 * ~100 KB.
 *
 * **The collapse to three did not reduce the caller's cost. It roughly doubled it** — or the caller
 * abandoned the remainder, which is the usual outcome and the one that looks like success.
 *
 * ## What is preserved, and it is the reason the old shape existed
 *
 * An earlier version truncated SILENTLY, and silent is worse than small. Everything here keeps that: the
 * response says `truncated`, says the budget it applied, says how many bytes it actually sent, and does so
 * on EVERY response rather than only when it bit — so absence never has to be interpreted.
 *
 * ## Bytes are the only limit, and that is deliberate
 *
 * No record count and no node count. Bytes already price a dense subtree higher than a sparse one, so
 * branching needs no separate term. A second limit would let two rules disagree about the same response,
 * which is this codebase's most-produced defect.
 */

/**
 * TWO DEFAULTS, ONE PER DOOR, and this is a deliberate divergence rather than a drift.
 *
 * ## Why the doors differ
 *
 * `CLAUDE.md`'s rule is that MCP and REST take the same parameters. They do: both accept `maxBytes`, with the
 * same floor, the same ceiling, the same refusal text. What differs is the number applied when the caller says
 * nothing, and it differs because the two doors have different physics.
 *
 * An MCP tool result meets a hard per-result ceiling INSIDE THE CLIENT, which the caller cannot raise. A REST
 * body lands in a buffer the caller allocated. So the same response is fine on one door and unusable on the
 * other, and a single default cannot be right for both.
 *
 * ## The measurement, and it is the canary operator's own
 *
 * 2026-08-20T0925Z, from the canary. A recall answered in-budget and fully specified:
 *
 *     bytesReturned: 98,356   budgetBytes: 100,000   truncated: true   returned 29 of 40
 *
 * **Their MCP client refused it outright and spilled it to a local file.** A caller reading over MCP got
 * nothing usable from a call the server answered perfectly.
 *
 * They proposed the 100 KB figure themselves and did not ask us to change it — they asked the narrower
 * question, whether a lower default on the MCP door was something we would consider. Their own diagnosis is
 * what makes the answer yes: *"the old 25-record cap had been acting as the de facto size guard on the MCP
 * door, and removing it removed that guard along with the cliff we were complaining about."* Neither of us
 * said that out loud when the budget was designed.
 *
 * ## Where 25 000 comes from, and what it is NOT
 *
 * ~6 whole records at their measured ~4 KB mean, ~7 000 tokens at 3.5 chars/token.
 *
 * It is **not** a measurement of any client's ceiling — we have exactly one data point, that 98,356 was
 * refused, and no number for where the limit actually is. So it is chosen from the safe side of the one
 * refusal we know about, far enough below it that a client with a tighter limit still works. A caller who
 * wants more passes `maxBytes` and gets it, up to `MAX_MAX_BYTES`, on either door.
 *
 * REST is **50 000 characters** (owner, 2026-08-30, down from the 100 000 that was already characters despite
 * being called bytes). MCP keeps 25 000, unchanged: it was chosen from the safe side of a measured client
 * refusal and nothing new argues with it.
 *
 * **These are the CHARACTER defaults, and `maxBytes` has none.** Giving the byte ceiling a default equal to
 * the character one would make it the binding constraint on every non-ASCII response, since bytes are always
 * ≥ characters — a silent tightening for exactly the callers this change exists to serve.
 */
export const DEFAULT_MAX_CHARS = 50_000;

/** The MCP door's default. See the note above `DEFAULT_MAX_CHARS` — lower, deliberately, and on one door. */
export const MCP_DEFAULT_MAX_CHARS = 25_000;

/**
 * Which default a call gets, decided from the door that received it — and the ONE place that is decided.
 *
 * ## The bug this closes, which was invisible from inside either door
 *
 * The two constants above were read at the call site, and every tool module reached for the MCP one because
 * MCP was the only door those modules had. Then `B-9` gave every tool a second: `POST /api/<tool-name>`,
 * plain HTTP, the same modules. A curl caller's default silently halved depending on which URL they typed —
 * 50 000 through `POST /api/brain/recall`, 25 000 through `POST /api/recall`, same server, same capability,
 * nothing in either response saying why.
 *
 * ## Why the TRANSPORT decides and not the route
 *
 * The lower number is not a property of the code that answers. It is a property of who pays for the bytes:
 * the canary operator's MCP client refused a 98 KB answer and spilled it to disk, because an agent carries
 * the response in its own context. A script does not, whatever path it used to ask. `ToolCaller.transport`
 * is already the one thing that records which door took the call, so the choice belongs to it — and a tool
 * handler, which cannot see the door, has no business making it.
 *
 * `CLAUDE.md` holds this divergence to three conditions, and this function is how the second is met: every
 * MCP call site resolves through it rather than one remembering to.
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
 * The realistic span across these payload shapes is 3.0–3.9: JSON scaffolding runs ~2.6 (a 36-char `_id` is
 * ~1.8, ISO timestamps ~2.0, a score float ~2.25) and English prose ~4.0, blending to 3.02 for a
 * structure-heavy graph node and 3.92 for a long description.
 *
 * **The customary 4.0 is wrong in the unsafe direction**: it UNDER-counts tokens, and it is worst exactly on
 * graph-heavy responses — the calls this budget exists to make usable. Undershooting a budget costs one
 * page; overshooting costs a blown context, and those are not symmetric.
 *
 * Figures are the canary operator's, established BPE ratios applied to a field inventory read off real
 * responses rather than a measured tokenisation, and flagged as such by them.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

export interface BudgetRequest {
  /**
   * A ceiling on the serialised response body in CHARACTERS, and the one that carries the defaults.
   *
   * This is what the budget has always measured. It was called `maxBytes`, which was true for ASCII and
   * wrong for everything else — see `applyBudget`.
   */
  maxChars?: unknown;
  /**
   * A ceiling on the serialised response body in real UTF-8 BYTES. **No default**, deliberately.
   *
   * One equal to the character default would make it the binding constraint on every non-ASCII response,
   * since bytes are always ≥ characters — a silent tightening. Opt-in, so a client whose limit really is in
   * bytes can say so and nobody else is affected.
   */
  maxBytes?: unknown;
  /**
   * A convenience, converted to CHARACTERS at a FIXED 3.5 per token. Never the authority.
   *
   * The ratio used to be a parameter, `charsPerToken`, and it was removed at 5.0. It did nothing unless
   * `maxTokens` was also set — a knob for a knob — and a caller who needs the ceiling to be exact should
   * state `maxChars`, which is the unit the budget is actually applied in. What the override bought was
   * the ability to make an estimate differently wrong.
   */
  maxTokens?: unknown;
}

/**
 * The parameter names above, at RUNTIME, for every door that has to admit them.
 *
 * ## Why this is exported rather than written out at each door
 *
 * A strict request body refuses what it does not name, which is the right failure — a silently dropped
 * budget is worse than a 400. It also means the allowed set has to widen in the same change as this
 * interface, and the vocabulary was written out THREE TIMES in `brain/query.ts` alone, once per read route.
 * A fifth budget parameter added here and accepted by `resolveBudget` would have been a 400 on three routes
 * that nothing described as not supporting it.
 *
 * The interface is erased at runtime, so this cannot be derived from it — but one list in the module that
 * OWNS the vocabulary is what the doors can share, and a name added here without a home in `resolveBudget`
 * is visible in this file rather than three routes away.
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
 * Resolve `maxChars` / `maxBytes` / `maxTokens` into TWO ceilings.
 *
 * ## Why two and not one
 *
 * Owner's decision, 2026-08-30: *"I need a way for both in reality. as with maxBytes and maxTokens: when both
 * (then: 2 or 3) are set: lower wins."*
 *
 * "Lower wins" is not a `Math.min` ACROSS the units. Characters and bytes are different scales — 50 000 of one
 * is not comparable with 50 000 of the other — so resolving them to a single number would be meaningless.
 * Both are carried, and `applyBudget` stops when EITHER would be exceeded. That is what "both apply" means,
 * and it is what the `maxTokens`/`maxChars` pair already does WITHIN one unit, where a minimum is meaningful.
 *
 * `maxTokens` resolves against CHARACTERS, which is where it always belonged: the conversion produces
 * characters, and it was only ever compared against a "byte" budget that was secretly counting them. That
 * half becomes correct by being named correctly.
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
 * `skip` and `remainderDump`, validated in ONE place for both doors.
 *
 * Kept beside `resolveBudget` rather than parsed per route for the reason `CLAUDE.md` names as this
 * codebase's most-produced defect: two implementations of one rule, and the weaker one winning. A `skip`
 * that 400s on one door and silently floors to zero on the other would make the behaviour depend on which
 * client the caller picked.
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
   * The unit being budgeted is therefore a match TOGETHER WITH its whole `_graph` subtree, and that is the
   * price of the guarantee: a match with a large subtree can push later matches out of the answer
   * entirely, so a deeper or wider expansion means fewer matches fit. They are absent rather than
   * shortened, which is the behaviour the owner ruled for on 2026-08-30 — a record arriving with half its
   * relationships is a worse answer than a shorter list of complete ones. Every surface that states the
   * guarantee states this alongside it; `expansion-costs-matches-and-says-so.test.js` holds the two
   * together.
   */
  returned: T[];
  /** The matches that did not fit, in rank order. Empty when nothing was cut. */
  remainder: T[];
  /** Serialised size of `returned`, in CHARACTERS — what `charsReturned` reports. */
  charsReturned: number;
  /**
   * Serialised size of `returned`, in real UTF-8 BYTES — what `bytesReturned` reports.
   *
   * Both are reported, always. Reporting one is most of why the unit confusion survived: a caller comparing
   * `bytesReturned` against their own byte limit was comparing it against a character count, and had no
   * second number to notice the difference with.
   */
  bytesReturned: number;
  /** True when at least one match was omitted. */
  truncated: boolean;
}

/**
 * Take the longest PREFIX of `results` whose serialised size fits the budget.
 *
 * ## Atomic at the match, and always a prefix
 *
 * The unit is one match plus its entire `_graph` subtree. The first match whose complete subtree would
 * exceed the remaining budget is omitted, **and so is every match after it** — even if a later, smaller one
 * would have fitted.
 *
 * That is not a missed optimisation. A prefix is the only shape that makes `skip` correct: the caller
 * continues from `returned` and receives the next prefix, with no overlap and no gap. Packing the gaps with
 * smaller matches would produce a set that no `skip` can continue from, and a ranked answer with holes in
 * it that the caller cannot detect.
 *
 * ## The measurement is of the SERIALISED form, in BOTH units
 *
 * Sizing the objects any other way would price a response differently from how it travels, and the budget
 * is about what arrives. The cost is one `JSON.stringify` per candidate; the loop stops at the first
 * overflow, so it is bounded by what fits plus one.
 *
 * **It used to measure `.length` and call the result bytes.** That is UTF-16 code units: equal to bytes for
 * ASCII and wrong for everything else — `Grüße aus Köln — ąćę` counts 31 against 39 real bytes, three emoji
 * count 17 against 23. A transport limit IS in bytes and this budget exists to stay under one, so a German
 * or Polish space overran its stated budget by about a quarter, which is exactly the failure the budget was
 * built to prevent. Both figures are measured now, and a row is admitted only if it fits under both.
 *
 * A single match larger than the whole budget is still returned, alone. Returning nothing would turn a
 * budget into a wall and leave a caller unable to read a record at all — and clause 3 of the specification
 * is that every returned record is whole.
 */
export function applyBudget<T>(results: readonly T[], budget: ResolvedBudget): BudgetOutcome<T> {
  const returned: T[] = [];
  // The envelope's own braces and the `results` key cost a little; charging it keeps the reported sizes
  // honest against the body the caller receives rather than against the array alone.
  let usedChars = 2;
  let usedBytes = 2;
  let i = 0;
  for (; i < results.length; i++) {
    const serialised = JSON.stringify(results[i]);
    const addChars = serialised.length + 1;                      // +1 for the separating comma
    const addBytes = Buffer.byteLength(serialised, 'utf8') + 1;
    // EITHER ceiling stops it. A caller who stated both meant both, and the tighter one is whichever bites
    // first for this content — which is the point of carrying two rather than reconciling them to a number.
    const overChars = usedChars + addChars > budget.chars;
    const overBytes = budget.bytes !== null && usedBytes + addBytes > budget.bytes;
    if (returned.length > 0 && (overChars || overBytes)) break;
    returned.push(results[i]!);
    usedChars += addChars;
    usedBytes += addBytes;
  }
  return {
    returned,
    remainder: results.slice(i) as T[],
    charsReturned: usedChars,
    bytesReturned: usedBytes,
    truncated: i < results.length,
  };
}

/**
 * The fields every budgeted response carries, truncated or not.
 *
 * **Always present, which is the point.** A field that appears only when it bit is a field whose absence has
 * to be interpreted, and the caller who most needs it is the one who does not know to look. `count` keeps
 * its existing meaning — the total number of matches — so a loop that summed `results.length` and a loop
 * that read `count` do not start disagreeing.
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
    /*
     * BOTH ceilings and BOTH figures, always.
     *
     * `budgetBytes` is `null` when the caller stated no byte ceiling — present rather than omitted, because a
     * field that appears only sometimes is a field whose absence has to be interpreted, which is the rule the
     * rest of this object already follows. Reporting only one unit is most of why a character count spent so
     * long being called a byte count.
     */
    budgetChars: budget.chars,
    budgetBytes: budget.bytes,
    charsReturned: outcome.charsReturned,
    bytesReturned: outcome.bytesReturned,
    /*
     * WHERE TO CONTINUE FROM, present exactly when there is somewhere to continue to.
     *
     * This is what makes the dump safe to make optional. Clause 6b of the specification turns the remainder
     * file into an opt-in, and 6a supplies `skip` — but the two must ship together, because an opt-in dump
     * with no stated continuation would leave a truncated caller with no way to reach the rest. That is
     * exactly the regression #969 shipped in its first cut and had to fix.
     *
     * Stated rather than derivable. `skip + returned` is arithmetic a caller could do, and a caller who has
     * to do arithmetic to find the next page is a caller who can get it wrong — off by one, or forgetting
     * that `skip` was already non-zero on this call. The server knows the answer; it says it.
     */
    ...(outcome.truncated ? { nextSkip: skip + outcome.returned.length } : {}),
  };
}

/**
 * The whole budgeted envelope for one response — the shape every result path returns.
 *
 * Eight call sites use this (recall and find-similar, plain and traversing, on both doors), and that is the
 * reason it exists rather than each building its own object: the old record cap was applied at four of those
 * eight and missing from the others until an E2E caught it, which is the same one-rule-several-places defect
 * this codebase produces most.
 *
 * `spillRemainder` is passed in rather than called here because only the caller knows the member space and
 * the request to describe the file with. **It receives ONLY the matches that did not fit** — the old dump
 * re-sent everything the caller already held, which is most of why the previous shape cost more than it
 * saved.
 */
export async function budgetedEnvelope<T, S>(opts: {
  results: readonly T[];
  /** BOTH ceilings, as `resolveBudget` produced them. See `ResolvedBudget`. */
  budget: ResolvedBudget;
  spillRemainder: (remainder: T[]) => Promise<S | null>;
  /** Offset this page began at, so the reported continuation is absolute. */
  skip?: number;
  /**
   * WRITE THE REMAINDER TO THE SPACE? Default NO — clause 6b, and the reason is that it is a WRITE ON A READ
   * PATH.
   *
   * Every truncated recall used to write a file whether anyone wanted it or not. On the canary operator's
   * instance those land in a store whose `storage_used_bytes` collector already takes ~22 s to walk, so a
   * read that overflows made an operator's metrics slower. And the common caller does not want the file at
   * all — it wants the next page, which `skip` now gives.
   *
   * **This may only be optional BECAUSE `nextSkip` exists.** An opt-in dump without a stated continuation
   * strands a truncated caller, which is precisely the regression #969 shipped in its first cut. The two
   * clauses land together for that reason and must not be separated again.
   */
  remainderDump?: boolean;
}): Promise<{ results: T[]; fields: Record<string, unknown> }> {
  // THE SLICE HAPPENS HERE, not at the eight call sites. A route that sliced its own array before calling
  // this would hand over a shortened list, and `count` — documented as the total number of matches — would
  // silently start reporting the total AFTER the skip. A caller paging through would watch `count` shrink
  // page by page and have nothing left that states how big the answer actually is.
  const skip = opts.skip ?? 0;
  const page = skip > 0 ? opts.results.slice(skip) : opts.results;
  const outcome = applyBudget(page, opts.budget);
  const fields = budgetFields(outcome, opts.results.length, opts.budget, skip);
  if (outcome.truncated && opts.remainderDump === true) {
    const spill = await opts.spillRemainder(outcome.remainder);
    if (spill) fields['remainder'] = spill;
  }
  return { results: outcome.returned, fields };
}
