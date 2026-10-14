/**
 * Where does a derived row's `parentFileId` chain end — the ONE walk UP it.
 *
 * ## The question it answers
 *
 * *"Following `parentFileId` from these rows, at most {@link MAX_ANCESTRY} levels, what is at the end of each chain?"* Asked three times
 * in this tree, each with its own loop and its own idea of what "the end" means: the suppression read (`ancestorSuppressed`: an
 * ancestor that is missing counts as suppressed, so nothing derived from a deleted file reaches an embedder), the move plan
 * (`holdsAtDestination`, `groupOf`: a chain that ends at an absent or flagged row is debris, one that ends at a live row elsewhere is
 * foreign) and the leaked-rows repair (`files/leaked-rows-repair.ts`: a chain that ends at an absent, flagged or foreign row is leaked,
 * one the walk cannot follow to its end is KEPT). Three loops that each bound the walk and each decide what the end means are three
 * chances for the weaker one to win silently: the repair deletes, and the move plan keeps what it cannot explain, so the repair
 * deciding on a reading of the chain that the plan would refuse is data loss with nothing to report it.
 *
 * ## What the walk answers, and what is left to the caller
 *
 * It answers WHAT the chain ended at ({@link ChainEnd}), never what that means:
 *
 *  - `top`: a live row that has no parent;
 *  - `gone`: a parent id with no LIVE row (absent, or the audit record of a deleted file — to a derived row the two are the same: its
 *    file is not there);
 *  - `too-deep`: {@link MAX_ANCESTRY} rows were read and the chain goes on. **The walk cannot say**, and a caller that deletes must
 *    read that as "keep" — a row that cannot be explained is not removed;
 *  - `stopped`: the caller's `stopWhen` held for an ancestor, and the walk read no further (the embed path asks about the flag on
 *    each ancestor, and the first one that carries it is the answer — so it pays no read for the levels above).
 *
 * The caller chooses the fields it reads of each ancestor (`fields`) and may stop early; one `$in` read serves each LEVEL for the whole
 * set of rows being walked, so a page of rows costs {@link MAX_ANCESTRY} reads, not that many times as many.
 *
 * ## Why the loop is here and nowhere else
 *
 * `the-ancestry-walk-up-parentfileid-is-one-module-and-the-repair-uses-it` finds every source file with an upward loop bounded by
 * `MAX_ANCESTRY` and holds the count to one, and holds the suppression read, the move plan and the repair to calling it. The walk
 * DOWN the same field (`rowsDerivedFrom`, which queries BY `parentFileId`) is another question and stays where it is.
 */
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { NOT_A_FLAGGED_ROW } from './live-file-row.js';

/**
 * How far up `parentFileId` a derived record looks for its owner. A caption chunk of an image extracted from a document is two levels
 * down; nothing is deeper.
 */
export const MAX_ANCESTRY = 3;

/** What a chain ended at. `at` is the id the walk was looking for when it ended (`gone`, `too-deep`) or the row it stopped at. */
export type ChainEnd =
  | { end: 'top'; at: string }
  | { end: 'gone'; at: string }
  | { end: 'too-deep'; at: string }
  | { end: 'stopped'; at: string };

/** One walked chain: the ancestors that were read, nearest first, and where it ended. */
export interface Chain<T> {
  ancestors: T[];
  result: ChainEnd;
}

/** An ancestor as {@link walkUpFileChains} reads it: its id and its parent, and whatever else the caller asked for in `fields`. */
export interface AncestorRow { _id: string; parentFileId?: string }

/** The ancestors that exist among `ids`, by id: how the walk reads one level. A row with no entry is `gone`. */
export type ReadAncestors<T> = (ids: string[]) => Promise<ReadonlyMap<string, T>>;

/**
 * Walk every chain in `starts` up to its end, one read per level for all of them.
 *
 * @param starts each chain by a key of the caller's (a row id), the id of the PARENT of the row whose chain it is (the walk reads
 *   ancestors, never the row it starts from, which the caller already holds)
 * @param read how one level is read; it is given the distinct ids still being looked for
 * @param stopWhen ends a chain at an ancestor it holds for (`stopped`), before that ancestor's own parent is read
 */
export async function walkUpParentChains<T extends { parentFileId?: unknown }>(
  starts: ReadonlyMap<string, string>,
  read: ReadAncestors<T>,
  stopWhen?: (ancestor: T) => boolean,
): Promise<Map<string, Chain<T>>> {
  const chains = new Map<string, Chain<T>>();
  const ancestorsOf = new Map<string, T[]>([...starts.keys()].map(key => [key, []]));
  let looking = new Map(starts);
  for (let level = 0; level < MAX_ANCESTRY && looking.size > 0; level++) {
    const rows = await read([...new Set(looking.values())]);
    const next = new Map<string, string>();
    for (const [key, at] of looking) {
      const row = rows.get(at);
      if (row === undefined) { chains.set(key, { ancestors: ancestorsOf.get(key)!, result: { end: 'gone', at } }); continue; }
      ancestorsOf.get(key)!.push(row);
      if (stopWhen?.(row)) chains.set(key, { ancestors: ancestorsOf.get(key)!, result: { end: 'stopped', at } });
      else if (typeof row.parentFileId === 'string') next.set(key, row.parentFileId);
      else chains.set(key, { ancestors: ancestorsOf.get(key)!, result: { end: 'top', at } });
    }
    looking = next;
  }
  for (const [key, at] of looking) chains.set(key, { ancestors: ancestorsOf.get(key)!, result: { end: 'too-deep', at } });
  return chains;
}

/**
 * {@link walkUpParentChains} over a space's `files` collection: each level one projected `$in` read (`readStoredById`) of the LIVE rows
 * among the ids, so a flagged row reads as absent — to a derived row, a file that was deleted is a file that is not there.
 *
 * @param fields what the caller reads of each ancestor besides `parentFileId`, which the walk always reads
 */
export function walkUpFileChains<T extends AncestorRow = AncestorRow>(
  spaceId: string,
  starts: ReadonlyMap<string, string>,
  opts: { fields?: Readonly<Record<string, 1>>; stopWhen?: (ancestor: T) => boolean } = {},
): Promise<Map<string, Chain<T>>> {
  const fields = { parentFileId: 1, ...opts.fields } as const;
  return walkUpParentChains<T>(
    starts,
    ids => readStoredById<T>(spaceCollection(spaceId, 'files'), ids, fields, { filter: NOT_A_FLAGGED_ROW }),
    opts.stopWhen,
  );
}
