import { withEndpointNames } from './edge-endpoint-names.js';
import { attachJobProgress } from '../files/file-job-progress.js';
import { conveniencePredicate, conveniencesFrom } from './list-conveniences.js';
import { filePathPredicate } from './file-path-arg.js';
import { checkCallerFilter, composedByServer } from './filter-sanitizer.js';
import { withDerivedStatusForPage, chronoStatusPredicate } from './chrono.js';
import { typesWhereDatePassedMeansNothing } from './chrono-date-policy.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';

/**
 * What does a page of this collection gain AFTER the query?
 *
 * ## The gap this closes, and why it was invisible
 *
 * Two of the nine per-collection list routes do work on their rows once the query has returned, and
 * `filter` — the one shape meant to replace all nine — did neither:
 *
 * | collection | what the list route adds | what `filter` returned |
 * |---|---|---|
 * | `edges` | `fromName` / `toName`, resolved per member and batched by endpoint kind | bare UUIDs |
 * | `files` | the embedding job's STEP PROGRESS, for rows still in flight | nothing, so a stage indicator never resolves |
 *
 * A decoration is not a parameter. It does not appear in a body allowlist, an `inputSchema` or a
 * capability map, so nothing compared the two doors and nobody reported the difference — and step 3 of
 * `B-9` deletes those routes, which would have taken both with it silently.
 *
 * ## Two functions, because there are two questions
 *
 * A file's progress is joined against the job collection of the member that OWNS the row, so it has to
 * run before a proxy page is merged and the member is forgotten. An edge's endpoint names are resolved
 * across every member at once, which is cheaper on the whole page than per slice. Folding the two into
 * one call taking a `perMember` flag would make every caller depend on the other caller's shape.
 *
 * ## What a hand-written copy drops
 *
 * Both of these are no-ops for most collections, and a copy that simply returned its rows for the
 * unknown case would be correct on the day it was written. These dispatch on the collection instead, so
 * a seventh collection with a decoration of its own has ONE place to declare it — and a caller cannot
 * apply the edge half and forget the file half, because it never sees either.
 */


/**
 * Rewrite a chrono predicate's `status` clause so it means the DERIVED status.
 *
 * ## Why `deriveStatus` has to reach the predicate and not just the rows
 *
 * `B-19`. `B-8` made the DISPLAYED status askable; this is the half that changes WHICH RECORDS COME
 * BACK. The chrono list route puts the clock in its status query, so `status: "active"` excludes what is
 * now derived-overdue. `filter` took the caller's predicate literally, so the same question returned a
 * fortnight-old episode through one door and not the other — and `status: "overdue"` found derived ones
 * through the route and only hand-typed ones through `filter`.
 *
 * So a caller who says `deriveStatus: true` is saying *this whole call speaks in derived terms*, and a
 * predicate that still matched stored values would make the flag mean half of itself.
 *
 * ## TOP LEVEL ONLY, and the refusal is the point
 *
 * A `status` nested inside `$or`/`$and` is REFUSED rather than rewritten. Rewriting arbitrary nesting is
 * where this would start being subtly wrong — the replacement clause is itself an `$or` in two of the
 * three cases, so folding it into a caller's disjunction changes what their disjunction means. A refusal
 * naming the problem costs a caller one edit; a silent half-rewrite costs them the answer.
 *
 * Returns the predicate unchanged when there is no `status` to interpret.
 */
export function derivedStatusPredicate(
  base: Record<string, unknown>,
  now: Date,
  datePassedExempt: readonly string[] | null,
): { predicate: Record<string, unknown> } | { error: string } {
  const nested = JSON.stringify(base['$and'] ?? '') + JSON.stringify(base['$or'] ?? '');
  if (nested.includes('"status"')) {
    return {
      error: '`deriveStatus` cannot interpret a `status` inside `$or` or `$and` — the derived clause is '
        + 'itself a disjunction, so folding it into yours would change what yours means. Put `status` at '
        + 'the top level of `filter`, or drop `deriveStatus` and match the stored value.',
    };
  }
  const raw = base['status'];
  if (typeof raw !== 'string') return { predicate: base };

  const { clause } = chronoStatusPredicate(raw, now, datePassedExempt);
  const rest = { ...base };
  delete rest['status'];
  /*
   * ANDed rather than spread, for the reason `conveniencePredicate` accumulates: the clause can carry its
   * own `$or` or `$expr`, and so can the caller's predicate. Assigning either over the other is the
   * silent-widening failure this codebase produces most.
   */
  return { predicate: Object.keys(rest).length ? { $and: [rest, clause] } : clause };
}


/**
 * The predicate a call should actually run, from the arguments it arrived with.
 *
 * ONE call rather than a sequence each door performs for itself. Both were doing the same three
 * things in the same order — merge the conveniences, resolve which chrono types are exempt from the
 * clock, apply the derived status — and each step had its own refusal to remember. Two checks is two
 * chances to handle the first and forget the second, and the forgotten one is a 200 carrying a
 * predicate nobody validated.
 *
 * It also takes the ORDER out of the doors. Conveniences before the derived status is not arbitrary:
 * the status rewrite looks for a top-level `status`, and a convenience can put one there.
 *
 * `spaceId` is the space whose META decides the policy. On a proxy call it is the named space, which
 * is the same one the list route reads.
 */
export function resolvePredicate(
  collection: string,
  args: Record<string, unknown>,
  rawFilter: Record<string, unknown>,
  spaceId: string,
): { predicate: Record<string, unknown> } | { error: string } {
  /*
   * The file `path` goes in FIRST, as part of what the caller asked for, so everything after it composes
   * with it: the conveniences accumulate under `$and` and the status rewrite reads the merged predicate.
   * Applying it last would mean spreading a key over whatever the conveniences had already built, which
   * is the silent-widening failure the accumulation exists to prevent.
   */
  const byPath = filePathPredicate(collection, args['path']);
  if (byPath && 'error' in byPath) return byPath;
  /*
   * Both spellings at once is REFUSED rather than resolved, which is the same call `recall` made about its
   * two filter grammars. Spreading the argument over the predicate lets the normalised path win silently;
   * ANDing them returns nothing whenever the caller's raw spelling was the un-normalised one, which reads
   * as "no such file" for a file that is right there. Neither is an answer, so neither is given.
   */
  if (byPath && 'path' in rawFilter) {
    return {
      error: 'Send `path` or a `filter` on `path`, not both — they are two spellings of one question and '
        + 'only the argument is normalised, so together they would silently disagree.',
    };
  }
  /*
   * THE CALLER'S FILTER IS CHECKED HERE, which is the only place it is still identifiable as theirs.
   *
   * `MAX_FILTER_DEPTH` bounds what a CALLER may ask for, and it used to be enforced at the last moment
   * before Mongo — by then the caller's filter and the server's composed clauses were one object counted
   * against one budget. The budget was already spent: a derived chrono `overdue` clause is itself depth
   * 8, so `deriveStatus` plus any convenience composed to 9 and was refused, naming a depth the caller
   * had not used. See `CallerCheckedFilter`.
   */
  const checked = checkCallerFilter(rawFilter);
  if ('error' in checked) return checked;
  const withPath = byPath ? { ...checked.predicate, ...byPath.predicate } : checked.predicate;

  /*
   * THE STATUS REWRITE READS THE CALLER'S OWN FILTER, BEFORE THE CONVENIENCES — and the order used to be
   * the other way round, which refused a combination the list route served.
   *
   * `derivedStatusPredicate` refuses a `status` nested inside `$or`/`$and`, for a real reason: the derived
   * clause is itself a disjunction, so folding it into the caller's changes what theirs means. But the
   * conveniences accumulate UNDER `$and`, so running them first buried a perfectly top-level `status` in
   * one — and the refusal then fired on the server's own transformation. `?status=overdue&search=needle`
   * worked on the route and was a 400 here, with an error telling the caller to do what they had done.
   *
   * The comment that used to be here said conveniences must come first because a convenience can put a
   * `status` at the top level. None can: they are `tag`, `type`, `description`, `properties` and `search`,
   * and the only field any of them writes under its own name is `type`. That was a reason nobody checked.
   *
   * So: derive against what the CALLER wrote, then let the conveniences accumulate around the result. The
   * derived clause is a value in the `$and` like any other, and it keeps its own meaning.
   */
  const withStatus = args['deriveStatus'] === true
    ? derivedStatusPredicate(withPath, new Date(), typesWhereDatePassedMeansNothing(getSpaceMeta(spaceId)))
    : { predicate: withPath };
  if ('error' in withStatus) return withStatus;
  const merged = conveniencePredicate(collection, conveniencesFrom(args), withStatus.predicate);
  if ('error' in merged) return merged;
  return { predicate: composedByServer(merged.predicate) };
}
/** Rows still inside their member's slice, before a proxy page is merged and the owner forgotten. */
export async function decorateMemberRows(
  collection: string,
  memberId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  /*
   * Files only, and only for rows in flight — `attachJobProgress` issues NO query at all when the slice
   * holds nothing pending, which is most slices. That property is the reason it is called rather than
   * re-implemented: a copy that looked the ids up unconditionally would put a query on the common path.
   */
  if (collection !== 'files') return rows;
  return attachJobProgress(memberId, rows);
}

/** The merged page, once every member has contributed. */
/** What the CALLER asked for, as distinct from what the collection always gets. */
export interface PageDecorationAsks {
  /**
   * Present a chrono entry's DERIVED status rather than the stored one — `overdue` where a due moment
   * has passed, unless the type's `whenDuePasses` says otherwise.
   *
   * Opt-in, and default OFF, so every existing `filter` caller sees exactly what it saw before. The list
   * route derives unconditionally, so the client asks for `true` and its tab is unchanged too. Nothing
   * moves for anybody who does not ask — which is what makes surfacing the difference safe rather than
   * a behaviour change dressed as a feature.
   */
  deriveStatus?: boolean;
}

export async function decoratePage<T extends object>(
  collection: string,
  _spaceId: string,
  rows: readonly T[],
  readAcrossMembers: (read: (memberId: string) => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>,
  asks: PageDecorationAsks = {},
): Promise<T[]> {
  if (rows.length === 0) return rows as T[];
  // One `now` for the page, so two rows in one answer cannot straddle the instant that flips a status.
  if (collection === 'chrono') {
    return asks.deriveStatus ? withDerivedStatusForPage(rows) : rows as T[];
  }
  if (collection !== 'edges') return rows as T[];
  // The cast is the shape `withEndpointNames` needs and the rows already have: an edge row carries
  // `from`/`to`, and the optional kinds decide which collection holds each endpoint's name.
  return await withEndpointNames(
    rows as unknown as Array<{ from: string; to: string }>,
    readAcrossMembers,
  ) as unknown as T[];
}

/**
 * The page-decoration asks as JSON-Schema properties, spread into `filter`'s `inputSchema`.
 *
 * DECLARED HERE rather than in the tool, so the name, what it means and what applies it live in one
 * file. A tool spelling its own description is a second account of this module's behaviour — and a
 * description is what a caller reads while constructing arguments, which makes it the copy that rots
 * without anybody reporting it.
 */
export const PAGE_DECORATION_SCHEMA: Readonly<Record<string, { type: 'boolean'; default: boolean; description: string }>> = {
  deriveStatus: {
    type: 'boolean',
    default: false,
    description: 'CHRONO ONLY. Present the DERIVED status of each entry instead of the stored one: `overdue` where its due moment has passed, unless `whenDuePasses` on that type says a passed date means nothing. Default false, so this tool answers with what the COLLECTION holds — which is what you want when repairing data, and why the two are not the same question. The per-collection chrono list route derives unconditionally, so until 5.0 the meaning of `status` depended on which door you used and nothing said so. Sending it on any other collection is refused rather than ignored.',
  },
  includeDiagnostics: {
    type: 'boolean',
    default: false,
    description: 'Add back the two fields a listed record carries for the SYSTEM rather than for you: `matchedText` (the pre-embedding source string, which for a file chunk is the passage a SECOND time) and `embeddingModel` (identical for every record in a space). Default false on both doors, and false is what you want almost always. It was honoured by the per-collection list routes and by neither door of this tool, so a caller could ask and be answered without it — silently.',
  },
};
