/**
 * One page of a list, whole rows only, and the answer saying when it was cut (`bundle-34`).
 *
 * Owner rule, 2026-09-28: *"if i get a result i want to be sure i get what i asked for"*. Lists stopped at a number
 * with nothing saying so — the notify event list at 200 and the schema dry-run's violations at 500 among them — each
 * with its own `.slice`, and not one of them answering `truncated`, a `total` or a way to reach the rest. The rule is
 * written once here and every such list answers through it; `filter` and the recall paths already answer this way
 * through `result-budget.ts`, whose budget and fields this reuses rather than restates.
 *
 * **What it guarantees, and what a hand-written copy drops.**
 * - Rows are WHOLE: a page stops at the first row that does not fit, never inside one.
 * - The cut is REPORTED: `truncated` on every answer, `total` for the whole list, `nextSkip` exactly when there is
 *   more. A limit held to a ceiling is echoed as the limit that applied, so a caller asking for 10000 is told 500.
 * - A bad `skip` or `limit` is REFUSED with a sentence, never floored to a default — the door that silently turns
 *   `skip=abc` into 0 is the one that disagrees with its twin.
 *
 * It pages an array the caller already holds. A list too large to hold pages at the database instead
 * (`spaces/page-across-members.ts`) and reports through `listPageFields`, so the fields stay one shape.
 */
import { applyBudget, budgetFields, resolveBudget, queryInt, DEFAULT_MAX_CHARS, type BudgetRequest } from './result-budget.js';

export interface ListPageRequest extends BudgetRequest {
  limit?: unknown;
  skip?: unknown;
}

export interface ListPageOptions {
  /** The page size when the caller states none. */
  defaultLimit: number;
  /** The largest page this list serves; a larger `limit` is held to it, and the answer says so. */
  maxLimit?: number;
  /** The character budget when the caller states none — the door's default (`defaultBudgetChars`). */
  budgetChars?: number;
}

export type ListPage<T> =
  | { ok: true; rows: T[]; fields: Record<string, unknown> }
  | { ok: false; error: string };

/** `limit` and `skip`, read the same on every door: a numeric query string counts, anything else is refused. */
export function resolveListPaging(req: ListPageRequest, opts: ListPageOptions):
  { ok: true; limit: number; skip: number } | { ok: false; error: string } {
  const limitRaw = queryInt(req.limit);
  const skipRaw = queryInt(req.skip);
  if (limitRaw !== undefined && !(typeof limitRaw === 'number' && Number.isInteger(limitRaw) && limitRaw > 0)) {
    return { ok: false, error: '`limit` must be a positive integer number of rows' };
  }
  if (skipRaw !== undefined && !(typeof skipRaw === 'number' && Number.isInteger(skipRaw) && skipRaw >= 0)) {
    return { ok: false, error: '`skip` must be a non-negative integer number of rows to skip' };
  }
  const asked = typeof limitRaw === 'number' ? limitRaw : opts.defaultLimit;
  return { ok: true, limit: opts.maxLimit ? Math.min(asked, opts.maxLimit) : asked, skip: typeof skipRaw === 'number' ? skipRaw : 0 };
}

/**
 * The fields of a page the caller built itself (a database-side page): the same shape `pageList` answers, so a
 * list's fields never depend on whether it paged in memory or at the database.
 */
export function listPageFields(opts: { page: readonly unknown[]; returned: number; total: number; limit: number; skip: number;
  budgetFields: Record<string, unknown> }): Record<string, unknown> {
  const { count: _budgetCount, nextSkip: budgetNext, truncated: budgetCut, ...budget } = opts.budgetFields;
  // Cut by the budget inside the page, or by the page itself ending before the list does.
  const more = budgetCut === true || opts.skip + opts.returned < opts.total;
  return {
    ...budget,
    count: opts.returned,
    total: opts.total,
    limit: opts.limit,
    skip: opts.skip,
    truncated: more,
    ...(more ? { nextSkip: typeof budgetNext === 'number' ? budgetNext : opts.skip + opts.returned } : {}),
  };
}

/** One page of `all`, whole rows, under `limit` and the byte budget, with the fields that say where it stands. */
export function pageList<T>(all: readonly T[], req: ListPageRequest, opts: ListPageOptions): ListPage<T> {
  const paging = resolveListPaging(req, opts);
  if (!paging.ok) return paging;
  const budget = resolveBudget({
    ...(req.maxChars !== undefined ? { maxChars: queryInt(req.maxChars) } : {}),
    ...(req.maxBytes !== undefined ? { maxBytes: queryInt(req.maxBytes) } : {}),
    ...(req.maxTokens !== undefined ? { maxTokens: queryInt(req.maxTokens) } : {}),
  } as BudgetRequest, opts.budgetChars ?? DEFAULT_MAX_CHARS);
  if (!budget.ok) return budget;
  const page = all.slice(paging.skip, paging.skip + paging.limit);
  const outcome = applyBudget(page, budget);
  return {
    ok: true,
    rows: outcome.returned,
    fields: listPageFields({
      page, returned: outcome.returned.length, total: all.length, limit: paging.limit, skip: paging.skip,
      budgetFields: budgetFields(outcome, all.length, budget, paging.skip),
    }),
  };
}
