/**
 * Reading a read spill: ONE act behind `GET /api/brain/spills/:id` and MCP `read_spill` (Q-92).
 *
 * ## Why the rights check lives here and not in a rights row
 *
 * A spill is found by its id alone, so neither door names a space. Which spaces it touches is a fact about a
 * STORED DOCUMENT — the member spaces the store derived from the spill's own records — and neither
 * `ROUTE_RIGHTS` nor the tool dispatcher can resolve a scope from a document. A `path`-scoped row would
 * resolve `:id` to no space at all, and an empty scope passes every per-space check: governance in name only.
 * So the route is `NOT_AREA_SCOPED`, and this act checks the whole rule:
 *
 * - the caller is the token that caused the spill, AND
 * - it holds knowledge read on EVERY member space — today, not when the spill was made, so a token that lost
 *   read on one of them since cannot read the records it can no longer see, AND
 * - on MCP, every member is inside the connection's accessible spaces.
 *
 * Anything else is the same 404 an unknown id gets, on both doors, so no token can probe for another's spill.
 *
 * ## One grammar
 *
 * `skip` and the budget (`maxChars`, `maxBytes`, `maxTokens`) resolve through the same functions every search
 * uses, so the doors cannot disagree about a value. The only difference is the default character budget, and
 * that is the sanctioned one (`defaultBudgetChars`): an agent pays for every byte from its own context.
 */
import type { TokenRights } from '../config/rights-shape.js';
import { holdsRungOnEvery } from '../auth/reachable-spaces.js';
import { readSpillPage } from './read-spill-store.js';
import { budgetFields, carriagesFor, defaultBudgetChars, resolveBudget, resolvePaging } from './result-budget.js';
import { spillIdFromPath } from './spill-path.js';

/** The two refusals a spill read can give, identical on both doors. */
export const SPILL_NOT_FOUND = 'Spill not found: unknown, expired, or not issued to this token';
export const SPILL_GONE = 'Spill evicted: this token\'s newer spills took its share. Repeat the search to make a new one';

export interface ReadSpillActInput {
  id: unknown;
  skip?: unknown;
  maxChars?: unknown;
  maxBytes?: unknown;
  maxTokens?: unknown;
  /** The caller's token id. */
  tokenId: string | null | undefined;
  rights: TokenRights | undefined;
  /** MCP only: the connection's accessible spaces. REST passes `null` — the request's rights are the scope. */
  accessibleSpaceIds: readonly string[] | null;
  transport: 'mcp' | 'rest';
}

export type ReadSpillActResult = { status: number; body: Record<string, unknown> };

/**
 * The files doors' half of the deprecated `path` (Q-92): a root `_tmp/graph-<id>.json` or
 * `_tmp/results-<id>.json` is read from the spill store, under the store's own rule, as its first window under the
 * door's default budget (continued with `read_spill` from `nextSkip`).
 * `null` when the path is not a spill's — the caller serves it as the file it is.
 *
 * Every such path resolves here, including one an older version really wrote to disk: that file was readable by
 * any files-read token on the space, which is the other half of the defect, and the sweep removes it.
 * Deprecated with `path`: removed at the next major.
 */
export async function readSpillByPath(
  filePath: string,
  who: Omit<ReadSpillActInput, 'id' | 'skip' | 'maxChars' | 'maxBytes' | 'maxTokens'>,
): Promise<ReadSpillActResult | null> {
  const id = spillIdFromPath(filePath);
  if (!id) return null;
  // The door's own default budget, not a whole-spill window: an MCP answer is trimmed to what an agent pays for
  // (the sanctioned divergence), and `nextSkip` names where `read_spill` continues.
  return readSpillAct({ ...who, id });
}

export async function readSpillAct(input: ReadSpillActInput): Promise<ReadSpillActResult> {
  if (typeof input.id !== 'string' || input.id.trim() === '') {
    return { status: 400, body: { error: '`id` must be the spillId an answer named' } };
  }
  const paging = resolvePaging({ skip: input.skip });
  if (!paging.ok) return { status: 400, body: { error: paging.error } };
  const budget = resolveBudget(
    { maxChars: input.maxChars, maxBytes: input.maxBytes, maxTokens: input.maxTokens },
    defaultBudgetChars(input.transport),
    carriagesFor(input.transport),
  );
  if (!budget.ok) return { status: 400, body: { error: budget.error } };

  const accessible = input.accessibleSpaceIds ? new Set(input.accessibleSpaceIds) : null;
  const mayRead = (members: readonly string[]): boolean =>
    (accessible === null || members.every(m => accessible.has(m)))
    && holdsRungOnEvery(input.rights, members, 'knowledge', 'read');

  const page = await readSpillPage({
    id: input.id.trim(), issuedTo: input.tokenId, skip: paging.skip,
    maxChars: budget.chars, maxBytes: budget.bytes, mayRead,
  });
  if (page.status === 404) return { status: 404, body: { error: SPILL_NOT_FOUND } };
  if (page.status === 410) return { status: 410, body: { error: SPILL_GONE } };

  // The size answer every search gives, from the one function that builds it: `returned`, `count` (the
  // whole spill), `truncated`, both budgets, both figures, and `nextSkip` exactly when there is more.
  const fields = budgetFields(
    { returned: page.items, remainder: [], charsReturned: page.charsReturned, bytesReturned: page.bytesReturned,
      truncated: page.truncated },
    page.total, budget, page.skip,
  );
  return {
    status: 200,
    body: {
      kind: page.kind, request: page.request, total: page.total, expiresAt: page.expiresAt,
      ...(page.ceilingHit ? { ceilingHit: true } : {}),
      items: page.items, skip: page.skip,
      ...fields,
    },
  };
}
