/**
 * What publishing a slice of pending file tombstones comes to — decided over rows already read, with no store behind it.
 *
 * ## The question it answers
 *
 * "Given the tombstones stored for these paths and the pending ones an act wants published, which is published, which is removed
 * with it, which is dropped because a publication already covers it, and which move's marker is handed on to what row?" The answer is data
 * ({@link SliceDecision}); `files/tombstones.ts` reads the rows before it and writes the decision after it (`publishOnePerPath`), so the
 * rule can be read, tested and changed without a collection behind it, and so the hold the write runs in contains the writes and nothing
 * else.
 *
 * ## What it prevents
 *
 * The rule's decision interleaved with its writes. `publishSlice` read, decided, handed markers over, wrote and deleted in one body of a
 * hundred lines, and the one question that needs the disk ({@link SliceContext.owed}, whether a move is still owed) was asked from the middle
 * of the loop. It is asked BEFORE, for the rows that could need it ({@link movesToAskAbout}), and passed in, so this module imports nothing
 * that does I/O (`the-shadow-rules-import-no-io`).
 *
 * @pure-rules  Its import closure reaches no code that does I/O: a decision over rows already read.
 */
import { moveKey } from './moved-paths.js';

/**
 * THE position of a tombstone: its own `positionAt`, or — for one stored before positions existed — its `deletedAt`, which
 * was the position then. What an acknowledgement, a prune and a page compare, and nothing else is. Pure. Named for the
 * tombstone because `util/seq-keyset.ts` and `sync/position-run-pager.ts` each read a position of their own kind.
 */
export const fileTombstonePosition = (t: { positionAt?: unknown; deletedAt?: unknown }): string | undefined =>
  typeof t.positionAt === 'string' ? t.positionAt : typeof t.deletedAt === 'string' ? t.deletedAt : undefined;

/** The part of a move's marker a publish reads: where it goes from and to, which is what two rows of one move share. */
export interface MoveOf { readonly from: string; readonly to: string }

/** A pending tombstone about to be published: while pending, `deletedAt` is when it was written. */
export interface PublishCandidate {
  readonly _id: string;
  readonly path: string;
  readonly deletedAt: string;
  readonly writtenAt?: string | undefined;
  readonly move?: MoveOf | undefined;
  readonly versionUnknown?: boolean | undefined;
  readonly rowSeq?: number | undefined;
}

/** What a publish reads of a tombstone already stored for one of its paths. */
export interface PublishStored {
  readonly _id: string;
  readonly path: string;
  readonly deletedAt: string;
  readonly positionAt?: string | undefined;
  readonly pending?: true | undefined;
  readonly rowSeq?: number | undefined;
  readonly writtenAt?: string | undefined;
  readonly origin?: 'own' | 'relayed' | undefined;
  readonly storedVia?: string | undefined;
  readonly move?: MoveOf | undefined;
  readonly issuer?: string | undefined;
}

/** What the decision is made against: who this instance is, and which moves are still owed (read before, by `movesStillOwed`). */
export interface SliceContext {
  /** This instance's id: a pending row published before `origin` existed counts as an own publication when it names this as its issuer. */
  readonly thisInstance: string | undefined;
  /** The keys ({@link moveKey}) of the moves that are still owed, for the rows {@link movesToAskAbout} named. */
  readonly owed: ReadonlySet<string>;
}

/** A step to run after the winners are published, in the order the rule produced them. */
export type AfterStep =
  /** A published row that covers a removed candidate takes the candidate's move marker, when it has none: the only thing that tells a retried move it is owed. */
  | { readonly kind: 'hand-over-marker'; readonly rowId: string; readonly move: MoveOf }
  /** Remove the pending rows of `path` written no later than the winner (`writtenAt`, or by `deletedAt` for a winner written before `writtenAt` existed), but not `keep`. */
  | { readonly kind: 'remove-pending'; readonly path: string; readonly winnerId: string; readonly writtenAt: string | undefined; readonly deletedAt: string; readonly keep: readonly string[] };

/** What a slice comes to. */
export interface SliceDecision<C extends PublishCandidate> {
  /** The candidates to publish, one per path, each carrying the marker of a move that goes with it. */
  readonly winners: readonly C[];
  /** What to do once they are published, in order. */
  readonly after: readonly AfterStep[];
  /** Candidates a publication already covers: pending rows to drop by id. */
  readonly superseded: readonly string[];
  /** How many candidates were not published (covered, or outranked by the winner of their path). */
  readonly dropped: number;
}

/** When a pending row was put: its `writtenAt`, or — for one written before it existed — its `deletedAt`. */
export const writtenOf = (t: { writtenAt?: string | undefined; deletedAt: string }): string => t.writtenAt ?? t.deletedAt;

/**
 * Whether `p` is a tombstone THIS instance published itself: stamped `origin: 'own'`, or — for a row published before `origin` existed
 * (bundle-71) — carrying no `origin` and no `storedVia` (nothing relayed it here) with this instance as its `issuer`. Without the second
 * form the leftover pending row of an act published before the upgrade was published a second time by the first settle after it.
 */
function isOwnPublication(p: PublishStored, thisInstance: string | undefined): boolean {
  if (p.pending || p.storedVia !== undefined) return false;
  if (p.origin !== undefined) return p.origin === 'own';
  return p.issuer !== undefined && p.issuer === thisInstance;
}

/**
 * Whether the published tombstone `p` COVERS the pending one `c`: this instance published it itself ({@link isOwnPublication}), after
 * `c` was written (both by this instance's own clock), and, by what each names of the version it erased (`rowSeq`):
 *
 * | `c`                          | `p`          | covers                                                                                |
 * |------------------------------|--------------|---------------------------------------------------------------------------------------|
 * | its version read failed      | any          | no: nobody knows which version `c` erased, so it is published                          |
 * | versioned                    | versioned    | when `p`'s version is not below `c`'s                                                 |
 * | versioned                    | none         | no: `p` was written when the path had no row, and `c` erases a version made since     |
 * | none (the path had no row)   | none         | yes: no version was uploaded between the two, they are one delete                     |
 * | none (the path had no row)   | versioned    | yes: `p` erased a file the path has not held since `c` was written                    |
 *
 * Only an own publication can cover: a relayed tombstone says a PEER deleted the path, which tells nobody that this instance's own
 * delete happened, and its position is its receive time.
 */
export function covers(p: PublishStored, c: PublishCandidate, thisInstance: string | undefined): boolean {
  if (!isOwnPublication(p, thisInstance)) return false;
  const at = fileTombstonePosition(p);
  if (at === undefined || at <= writtenOf(c)) return false;
  if (c.versionUnknown === true) return false;
  const named = (t: { rowSeq?: number | undefined }): t is { rowSeq: number } => typeof t.rowSeq === 'number' && t.rowSeq > 0;
  if (named(c)) return named(p) && p.rowSeq >= c.rowSeq;
  return true;
}

const newestFirst = (a: PublishCandidate, b: PublishCandidate): number =>
  Number(b.writtenAt !== undefined) - Number(a.writtenAt !== undefined) || writtenOf(b).localeCompare(writtenOf(a));

/** The candidates of `path` still to decide: those no published row of the same id has settled already, newest-written first. */
function candidatesOf<C extends PublishCandidate>(path: string, byPath: ReadonlyMap<string, readonly C[]>, alreadyPublished: ReadonlySet<string>): C[] {
  return (byPath.get(path) ?? []).filter(d => !alreadyPublished.has(d._id)).sort(newestFirst);
}

/**
 * The rows whose moves {@link decideSlice} may have to ask whether they are still owed: on a path whose candidates and pending rows name
 * MORE THAN ONE move, every row that names one. A path whose rows all name the same move (or none) has no row that goes with another
 * move's marker, so nothing there is asked — a directory move's thousand files cost no look at the disk for it. A superset of what the
 * decision uses, never a subset: asking one more costs a read, asking one fewer keeps a row that should go or removes one that should stay.
 */
export function movesToAskAbout<C extends PublishCandidate, S extends PublishStored>(
  stored: readonly S[], paths: readonly string[], byPath: ReadonlyMap<string, readonly C[]>,
): Array<{ move?: MoveOf | undefined }> {
  const out: Array<{ move?: MoveOf | undefined }> = [];
  for (const path of paths) {
    const rows = [...(byPath.get(path) ?? []), ...stored.filter(t => t.path === path && t.pending)].filter(r => r.move !== undefined);
    if (new Set(rows.map(r => moveKey(r.move!))).size > 1) out.push(...rows);
  }
  return out;
}

/**
 * Decide one slice of whole paths: per path, a pending tombstone a published OWN one covers is superseded ({@link covers}); of the rest
 * the latest written ({@link writtenOf}) wins and every pending row written no later than it (and every one written before `writtenAt`
 * existed) is removed — never one written after it, which is another act's. A move's marker on a row that goes is handed to the row that covers
 * it, when that row has none, or carried on by the winner. Pure: nothing is changed, the inputs included.
 */
export function decideSlice<C extends PublishCandidate, S extends PublishStored>(
  stored: readonly S[], paths: readonly string[], byPath: ReadonlyMap<string, readonly C[]>, ctx: SliceContext,
): SliceDecision<C> {
  const alreadyPublished = new Set(stored.filter(t => !t.pending).map(t => t._id));
  const winners: C[] = [];
  const after: AfterStep[] = [];
  const superseded: string[] = [];
  let dropped = 0;
  for (const path of paths) {
    const rows = stored.filter(t => t.path === path);
    const candidates = candidatesOf(path, byPath, alreadyPublished);
    const covering = new Map(candidates.map(c => [c._id, rows.find(p => covers(p, c, ctx.thisInstance))] as const));
    const live = candidates.filter(c => covering.get(c._id) === undefined);
    // A cover takes a marker once: a second candidate's does not replace what the first handed it.
    const handed = new Set<string>();
    for (const c of candidates) {
      const cover = covering.get(c._id);
      if (cover === undefined) continue;
      superseded.push(c._id);
      if (c.move && !cover.move && !handed.has(cover._id)) {
        handed.add(cover._id);
        after.push({ kind: 'hand-over-marker', rowId: cover._id, move: c.move });
      }
    }
    const winner = live[0];
    if (!winner) { dropped += candidates.length; continue; }
    // What goes with the winner, and the marker it may carry on: the other live candidates (their rows may be gone, so the doc
    // is read) and the pending rows the delete takes.
    const goes = winner.writtenAt !== undefined
      ? (t: S) => t.writtenAt === undefined || t.writtenAt <= (winner.writtenAt as string)
      : (t: S) => t.writtenAt === undefined && t.deletedAt <= winner.deletedAt;
    const removed: Array<{ _id: string; move?: MoveOf | undefined }> = [...live.slice(1), ...rows.filter(t => t.pending && t._id !== winner._id && goes(t))];
    const move = winner.move ?? removed.find(r => r.move)?.move;
    winners.push(move && !winner.move ? { ...winner, move } : winner);
    // The winner carries ONE marker on. A row that goes with another one — a different move's, still owed — is the only record of
    // that move, and is kept (pending, served to nobody) until the move ends.
    const elsewhere = removed.filter(r => r.move && (!move || moveKey(r.move) !== moveKey(move)));
    const keep = elsewhere.filter(r => ctx.owed.has(moveKey(r.move!))).map(r => r._id);
    after.push({ kind: 'remove-pending', path, winnerId: winner._id, writtenAt: winner.writtenAt, deletedAt: winner.deletedAt, keep });
    dropped += candidates.length - 1;
  }
  return { winners, after, superseded, dropped };
}
