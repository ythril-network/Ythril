/**
 * Moving keyed rows onto new ids, all or nothing — one implementation for the edges a merge re-keys and the file rows a move
 * carries (bundle-44, Q-342; plan rev 3 D1).
 *
 * ## The question it answers
 *
 * *"Move these rows to these new ids so that, whatever fails, each is wholly at its old id or wholly at its new one, and no row of
 * anything else is touched."* A document's `_id` is immutable, so a re-key is a delete and an insert. Written by hand that is four
 * private copies (the file row, a directory's rows, the derived rows, the jobs), and each lost the rows when the insert failed after
 * the delete: a destination that was already taken made the insert fail `E11000` after the source row was gone, and the moved
 * file's record was nowhere (pinned as a "known limit" until this bundle).
 *
 * ## What it guarantees, and what a hand-written copy drops
 *
 *  - **The destination is read FIRST** ({@link assertNewIdsFree}), and any row at a new id that is not itself moving, and that the
 *    caller did not name as replaced, is refused before anything is written. The guard is the part both callers share: the edges'
 *    `EdgeIdentityTaken` and a move's `DestinationTakenByOther` are one rule with two refusals, not two rules.
 *  - **It runs inside the caller's transaction** ({@link rekeyRows} takes the session), so the delete, the replacement of what the
 *    caller named and the insert commit together or not at all. A row that appeared at a new id since the caller planned fails the
 *    insert (`E11000`) and the whole batch rolls back — the caller's transaction (`db/bounded-transaction.ts`) answers it, never
 *    this module half-way.
 *  - **The rows are READ here, by id, in the session** (`readStoredById`, every stored field, the vector included), so what is
 *    re-inserted is what is stored NOW: a derived write that landed after the caller planned is carried, not overwritten by a copy
 *    read earlier. The delete asserts it removed exactly the rows read, so a row that went away between the read and the delete is
 *    a failure that rolls back, not a silent short insert.
 *
 * ## What is the caller's
 *
 * The row builder (`rebuild`): which fields a re-keyed row keeps and which it restamps differs by kind (an edge keeps its stored
 * document and takes a seq; a file row keeps its seq and its `updatedAt`; a job is local state and is a plain spread). The seq,
 * the tombstones and the wake of whatever reads the rows are the caller's too.
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { writeInOneCommands } from '../db/one-command.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';

/** One row to move: its id now, and the id it is to have. */
export interface RowMove { from: string; to: string }

/**
 * The plan the caller made no longer holds, found inside the transaction: a row it meant to replace is not what it expected, or the
 * rows to move are not what it read. The transaction rolls back; the caller plans again.
 */
export class StaleRekeyPlan extends Error {
  override readonly name = 'StaleRekeyPlan';
}

/** What a row at a new id may be: the caller named it as replaced, or it is itself being moved. */
export interface RekeyReplacements {
  /** Rows to delete by id, whatever they are: the occupant a move replaces. A row that is not there is not an error. */
  readonly replaced?: readonly string[];
  /** Rows to delete by id only while they carry `deletedAt` (a soft delete's audit record): a row that was revived meanwhile is NOT deleted and the plan is stale. */
  readonly flagged?: readonly string[];
}

/**
 * Refuse a re-key whose new ids are taken: read the rows at every new id (in the caller's session when it has one) and throw
 * `refuse(to, from)` for any that exists and is neither moving itself nor named by the caller as replaced. Two moves onto ONE id
 * are the same refusal: the second insert would hit the unique index.
 *
 * Exported for the caller that writes its own rows (the edge re-key allocates a seq block and writes tombstones, so it cannot use
 * {@link rekeyRows}) and must not have a second guard.
 */
export async function assertNewIdsFree(
  collName: string, moves: readonly RowMove[], refuse: (to: string, from: string) => Error,
  opts: { session?: ClientSession; replacements?: RekeyReplacements } = {},
): Promise<void> {
  const moving = new Set(moves.map(m => m.from));
  const allowed = new Set([...(opts.replacements?.replaced ?? []), ...(opts.replacements?.flagged ?? [])]);
  const claimed = new Set<string>();
  for (const m of moves) {
    if (claimed.has(m.to)) throw refuse(m.to, m.from);
    claimed.add(m.to);
  }
  const wanted = moves.map(m => m.to).filter(to => !moving.has(to) && !allowed.has(to));
  const taken = await readStoredById<{ _id: string }>(collName, wanted, { _id: 1 }, opts.session ? { session: opts.session } : {});
  for (const m of moves) if (taken.has(m.to)) throw refuse(m.to, m.from);
}

/**
 * Move the rows of `moves` onto their new ids inside `session` — see the module docblock. Returns how many rows moved (the rows
 * that were there to read; an id with no row is not moved and not an error).
 *
 * @param rebuild the row as it is to be stored at `to`: given the row as it is stored now, and its new id.
 */
export async function rekeyRows<T extends { _id: string }>(
  collName: string, session: ClientSession,
  plan: { moves: readonly RowMove[]; rebuild: (row: T, to: string) => object; refuse: (to: string, from: string) => Error; replacements?: RekeyReplacements },
): Promise<number> {
  const coll = col<{ _id: string }>(collName);
  await assertNewIdsFree(collName, plan.moves, plan.refuse, { session, ...(plan.replacements ? { replacements: plan.replacements } : {}) });
  const stored = await readStoredById<T>(collName, plan.moves.map(m => m.from), 'carried', { session });
  const rows = plan.moves.filter(m => stored.has(m.from));
  if (rows.length === 0) return 0;

  let deleted = 0;
  for (const part of inChunks(rows.map(m => m.from), READ_CHUNK)) {
    deleted += (await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: part } }), { session })).deletedCount ?? 0;
  }
  if (deleted !== rows.length) throw new StaleRekeyPlan(`${rows.length} rows were read to be re-keyed and ${deleted} were deleted`);

  const flagged = plan.replacements?.flagged ?? [];
  let flaggedDeleted = 0;
  for (const part of inChunks([...flagged], READ_CHUNK)) {
    flaggedDeleted += (await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: part }, deletedAt: { $exists: true } }), { session })).deletedCount ?? 0;
  }
  if (flaggedDeleted !== flagged.length) throw new StaleRekeyPlan(`${flagged.length} audit rows were to be replaced and ${flaggedDeleted} were still flagged`);
  for (const part of inChunks([...(plan.replacements?.replaced ?? [])], READ_CHUNK)) {
    await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: part } }), { session });
  }

  const rebuilt = rows.map(m => asDoc<{ _id: string }>(plan.rebuild(stored.get(m.from)!, m.to) as { _id: string }));
  await writeInOneCommands(rebuilt, (slice, { ordered }) => coll.insertMany(slice, { ordered, session }), { ordered: true });
  return rows.length;
}
