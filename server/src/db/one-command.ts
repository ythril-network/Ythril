/**
 * Slice a batch of operations so a bulk write of one slice is ONE wire command.
 *
 * ## The question it answers
 *
 * "How many of these can one bulk write carry without the driver turning it into several commands?" Asked by the writers
 * whose page is a peer's — `sync/arrivals.ts` (a chunk of documents of any size) and `sync/tombstone-apply.ts` (a page of
 * tombstones whose ids are text the peer chose).
 *
 * ## What it prevents
 *
 * The write bound (`db/write-bound.ts`) ends a plain write with the server's own deadline, `maxTimeMS`, and a client
 * backstop 500 ms after it. `maxTimeMS` is per WIRE COMMAND, and the driver splits a bulk write into several when the batch
 * passes the server's `maxBsonObjectSize` (16 MiB; `lib/bulk/common.js`) or its `maxWriteBatchSize`: each command is given
 * the same `maxTimeMS`, armed when THAT command reaches the server, while the backstop is armed once. A second command can
 * arrive after the caller was answered `503` and the hold released, with a deadline of its own, and land — the defect the
 * bound exists to close. A call that is one command cannot do that, so the writer makes it one — for a bulk of ONE operation
 * type. The driver sends an unordered bulk as a command per type (inserts, updates, deletes), so a bulk that mixes types is
 * several commands per slice unless the writer slices each type apart (`commandKindOf` of `writeInOneCommands`).
 *
 * ## The guard a hand-written copy would drop
 *
 * **A single operation over the limit goes alone** instead of being refused or glued to a neighbour: the driver sends such
 * an operation by itself, so it is one command either way, and a slicer that threw would fail a page the store takes.
 * **A count that is not a positive integer is refused**, not read as "no slicing" (the rule `inChunks` keeps).
 *
 * ## What it does not do
 *
 * It does not measure the operation for you (`bytesOf` is the caller's: the size of the operation as the command carries
 * it) and it does not decide what a chunk's failure means. It is not `inChunks` (`util/chunks.ts`), which slices by
 * COUNT alone; this slices by count AND bytes, and the second is the one that keeps a call to one command.
 */

import { BSON, MongoBulkWriteError } from 'mongodb';
import { classifyReadFailure } from '../brain/store-failure.js';
import { wrapsAThrownError } from './error-chain.js';
import { isWriteTimeout } from './write-timeout.js';

/** The BSON size of one operation (or any value) as a command would carry it. Not a document: it is measured inside one. */
export const operationBytes = (value: unknown): number => BSON.calculateObjectSize({ v: value } as never);

/** MongoDB's `maxBsonObjectSize`, which is also what the driver batches a bulk write by (and its fallback when a server reports none). */
const MAX_BSON_OBJECT_SIZE = 16 * 1024 * 1024;

/**
 * The most bytes of operations one bulk write may carry and stay one command: the driver's batch limit less room for the
 * command document around the operations (its `update`/`ordered`/`$db` fields, and the array keys, which it counts per operation).
 */
export const ONE_COMMAND_BYTES = MAX_BSON_OBJECT_SIZE - 256 * 1024;

/** The server's `hello.maxWriteBatchSize`: 100 000 on every server this product supports (MongoDB 4.2 to 8.x). Not what one command carries — see `ONE_COMMAND_MAX_OPERATIONS`. */
export const MONGO_MAX_WRITE_BATCH_SIZE = 100_000;

/**
 * The most operations one wire command carries: ONE FEWER than the server's `maxWriteBatchSize`. The driver opens a new batch
 * when `size + 1 >= maxWriteBatchSize` (mongodb 7.1.1 `lib/bulk/ordered.js:35`, `lib/bulk/unordered.js:49`), so a batch holds
 * at most `maxWriteBatchSize - 1` operations and a slice of exactly `maxWriteBatchSize` is two commands, the second with a
 * deadline of its own — the defect this module exists to close (round W, V1; the first version of this constant was the
 * server's number itself). Together with `ONE_COMMAND_BYTES` it is the WHOLE of the one-command property — not
 * `ROWS_PER_BULK_COMMAND` (1 000), which answers another question (how much one `$in` delete or hub-sized write should
 * carry), and which read here turned one insert into a hundred commands with the rows it replaces already deleted (round V,
 * S2). Pinned twice: against the driver's own bulk classes (`a-bounded-bulk-write-is-one-command`) and against a real server's report
 * (`a-bounded-bulk-write-is-one-command-db`), so a driver that batches differently fails a test instead of this comment.
 */
export const ONE_COMMAND_MAX_OPERATIONS = MONGO_MAX_WRITE_BATCH_SIZE - 1;

/**
 * A count that is not a positive integer is refused, whatever else the call carries and however many items it has: asked once
 * here so the two entry points cannot disagree (the empty list and the kind-sliced call both reached a loop that never
 * looked at it — round X, W5).
 */
function requireMaxItems(maxItems: number, caller: string): void {
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error(`${caller}: maxItems must be a positive integer, got ${maxItems}`);
}

/**
 * @param items the operations, in the order they are to be written
 * @param opts.maxItems the most operations in a slice (a positive integer)
 * @param opts.bytesOf the BSON size of one operation as the command carries it
 * @returns consecutive slices of `items`, none of more than `maxItems` operations or `ONE_COMMAND_BYTES` — except one
 *   operation that is over the limit by itself, which is a slice of its own
 */
export function inOneCommandChunks<T>(
  items: readonly T[], { maxItems, bytesOf }: { maxItems: number; bytesOf: (item: T) => number },
): T[][] {
  requireMaxItems(maxItems, 'inOneCommandChunks');
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = bytesOf(item);
    if (current.length > 0 && (current.length >= maxItems || bytes + size > ONE_COMMAND_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * The wire command a `bulkWrite` operation is sent in — `commandKindOf` for a bulk whose operations are the driver's
 * (`{ updateOne: ... }`, `{ deleteMany: ... }`): the driver batches by this (`lib/bulk/common.js`), so `updateOne`, `updateMany`
 * and `replaceOne` are one command type and `deleteOne` and `deleteMany` another. An operation this does not know is refused,
 * not read as a kind of its own: a new operation type would otherwise be sliced as if it were one command with its neighbours.
 */
export function bulkCommandOf(op: object): 'insert' | 'update' | 'delete' {
  const key = Object.keys(op)[0];
  switch (key) {
    case 'insertOne': return 'insert';
    case 'updateOne': case 'updateMany': case 'replaceOne': return 'update';
    case 'deleteOne': case 'deleteMany': return 'delete';
    default: throw new Error(`bulkCommandOf: not a bulkWrite operation: ${String(key)}`);
  }
}

/**
 * A per-OPERATION failure of a bulk write: the driver's `MongoBulkWriteError` carrying `writeErrors` (a duplicate key from a
 * racing upsert, a document the store refuses). It is the one failure an UNORDERED bulk write goes on past — the driver
 * runs every batch of an unordered bulk and raises one error at the end (`lib/bulk/common.js`, `unordered.js`) — and the
 * only one this module goes on past. A store that is down, a bound that ended the call (`isWriteTimeout`), a write concern
 * failure (a bulk error with no `writeErrors`) and the driver's own refusals are not the operation's: the next slice would
 * meet the same store, with a deadline of its own, so the writer stops there as the driver does.
 */
function isOperationFailure(err: unknown): boolean {
  return err instanceof MongoBulkWriteError && !wrapsAThrownError(err) && !isWriteTimeout(err)
    && ([] as unknown[]).concat(err.writeErrors ?? []).length > 0;
}

/**
 * What an UNORDERED `writeInOneCommands` raises when a slice failed: every slice's failure and what landed, as ONE error.
 *
 * `cause` is what ENDED the write when the store did — a bound (`isWriteTimeout`) or a store failure, the failure the write
 * stopped at — and otherwise the first per-operation failure (see `causeOfFailures`). `errorChain` follows `cause` only, so
 * it decides what a door that classifies the wrapper answers: a duplicate key followed by a timeout is a retryable `503`, not
 * the `400` that told a sender not to retry a write a retry would have landed. When nothing stopped the write every failure is
 * a per-operation one, and the first stands for them as the driver's own first error would. Every failure is still in
 * `failures`. (An earlier version took the first failure ALWAYS, because inside a transaction the slice after a failed one
 * fails with an aborted-transaction error that is its consequence; a write in a session is `ordered` now and stops at its
 * first failure, so no such consequence is ever a later slice's failure.)
 */
export class SlicedBulkWriteError extends Error {
  /** Every slice that failed, by its position in the write (0-based), in order. */
  readonly failures: ReadonlyArray<{ slice: number; error: unknown }>;
  /** Every slice that landed, by position, with what its write answered. */
  readonly landed: ReadonlyArray<{ slice: number; answer: unknown }>;
  /** How many slices the write had, attempted or not (a store failure ends the attempts). */
  readonly slices: number;

  constructor(failures: SlicedBulkWriteError['failures'], landed: SlicedBulkWriteError['landed'], slices: number, cause: unknown) {
    const first = failures[0]?.error;
    super(`${failures.length} of ${slices} slices of an unordered bulk write failed (slice ${failures.map(f => f.slice + 1).join(', ')}), `
      + `${landed.length} landed: ${first instanceof Error ? first.message : String(first)}`, { cause });
    this.name = 'SlicedBulkWriteError';
    this.failures = failures;
    this.landed = landed;
    this.slices = slices;
  }
}

/**
 * Write `ops` as consecutive bulk writes, each ONE wire command PER OPERATION TYPE, one after another; what each answered, in order.
 *
 * `write` is the caller's bulk call over a slice (`(slice, { ordered }) => coll.bulkWrite(asBulk(slice), { ordered, session })`,
 * `coll.insertMany(slice, { ordered })`), so what the caller needs from the driver — its options, its session, its result —
 * stays the caller's. The slicing is this module's: at most `ONE_COMMAND_MAX_OPERATIONS` operations and `ONE_COMMAND_BYTES`,
 * measured as the command carries them (`operationBytes`), unless the caller says otherwise. A bulk write that was a single
 * call of any size is now however many commands it takes, so it is no longer something the driver splits behind the caller's
 * back, with a deadline of its own for each part. Nothing is a no-op, never a call with an empty batch (the driver refuses one).
 *
 * ## `ordered` — required, and the caller's one value for both
 *
 * The same word the driver uses, and handed BACK to `write` so the bulk call and the slicing cannot disagree: a default here
 * would be a semantic the caller did not choose. An ordered write stops at the first slice that fails and rejects with its
 * own error: the slices before it landed, as they did when the driver split the batch. **An unordered write attempts every
 * slice**, as the driver does (it runs every batch of an unordered bulk and raises one error at the end), and rejects at
 * the end with ONE `SlicedBulkWriteError` naming every failed slice and what landed — a caller that promises "one collision
 * does not abandon the rest" keeps the promise across slices as well as inside one. Only a per-operation failure is gone past; a
 * failure of the store stops the write at once (see `isOperationFailure`), and is thrown as it is when nothing failed before it.
 *
 * **A write inside a transaction is `ordered: true`.** The server aborts a transaction at its first error, so an unordered
 * write would send the next slice into a dead transaction; the caller that passes a `session` says so
 * (`a-bounded-bulk-write-is-one-command` holds every such call to it).
 *
 * ## `commandKindOf` — one command per slice only for one kind
 *
 * The driver sends an UNORDERED bulk as one command per operation type (inserts, then updates, then deletes), so a slice of
 * mixed types is two or three commands, each with a deadline of its own. A caller whose operations mix types names the type
 * of each (`commandKindOf`, answering `insert`, `update` or `delete`) and the writer slices each type apart, the types in the
 * DRIVER's order — inserts, updates, deletes — whatever order they first appear in. Without it a slice is whatever the count
 * and the bytes make it, which is one command only for a bulk of one type. **It is refused together with `ordered: true`**:
 * an ordered write is a sequence the caller wrote for a reason, and regrouping it by kind would reorder it silently.
 *
 * It is the second site of the loop `sync/tombstone-apply.ts` wrote first; it keeps `inOneCommandChunks` for the writer that
 * has to size its slices itself (`sync/arrivals.ts`, which sizes by an operation that is not the one it stores).
 */
export async function writeInOneCommands<T, R>(
  ops: readonly T[], write: (slice: T[], opts: { ordered: boolean }) => Promise<R>,
  opts: { ordered: boolean; maxItems?: number; bytesOf?: (item: T) => number; commandKindOf?: (item: T) => CommandKind },
): Promise<R[]> {
  const ordered = opts?.ordered;
  if (typeof ordered !== 'boolean') throw new Error(`writeInOneCommands: ordered must be true or false (the value the bulk write is given), got ${String(ordered)}`);
  const { maxItems = ONE_COMMAND_MAX_OPERATIONS, bytesOf = operationBytes, commandKindOf } = opts;
  requireMaxItems(maxItems, 'writeInOneCommands');
  if (ordered && commandKindOf) {
    throw new Error('writeInOneCommands: ordered: true and commandKindOf contradict each other (an ordered write is a sequence; commandKindOf regroups the operations by kind). Say which one is meant.');
  }

  const slices = byKind(ops, commandKindOf).flatMap(group => inOneCommandChunks(group, { maxItems, bytesOf }));

  const landed: Array<{ slice: number; answer: R }> = [];
  const failures: Array<{ slice: number; error: unknown }> = [];
  let stopped = false;
  for (const [slice, items] of slices.entries()) {
    try {
      landed.push({ slice, answer: await write(items, { ordered }) });
    } catch (error) {
      if (ordered) throw error;
      failures.push({ slice, error });
      if (!isOperationFailure(error)) { stopped = true; break; }
    }
  }
  if (failures.length === 0) return landed.map(l => l.answer);
  // The store's failure with nothing before it is the store's failure, as it was before the write was sliced.
  if (failures.length === 1 && stopped) throw failures[0]!.error;
  throw new SlicedBulkWriteError(failures, landed, slices.length, causeOfFailures(failures, stopped));
}

/**
 * Which failure a door should answer for when a write failed in several slices: the one that STOPPED the write if it is the
 * store's (a bound that ended the call, or any failure the door answers as server-side: the store down, a pool cleared), else
 * the first. A stop is by construction the last failure, and it is the only one the next slice would also have met, so it is
 * what a retry has to be told about; the failures before it are the operations' own and are in the error beside it.
 */
function causeOfFailures(failures: ReadonlyArray<{ slice: number; error: unknown }>, stopped: boolean): unknown {
  const stopping = stopped ? failures[failures.length - 1]!.error : undefined;
  if (stopped && (isWriteTimeout(stopping) || classifyReadFailure(stopping).status >= 500)) return stopping;
  return failures[0]!.error;
}

/** The wire command types a bulk write is sent in, in the order the driver sends an unordered bulk's batches (`lib/bulk/common.js`). */
type CommandKind = 'insert' | 'update' | 'delete';
const DRIVER_COMMAND_ORDER: readonly CommandKind[] = ['insert', 'update', 'delete'];

/**
 * `items` apart by `kindOf`, the kinds in the driver's order (insert, update, delete) and each kind's items in their own order;
 * one group without a `kindOf`. A kind that is not one of the three is refused before anything is written.
 */
function byKind<T>(items: readonly T[], kindOf: ((item: T) => CommandKind) | undefined): Array<readonly T[]> {
  if (!kindOf) return [items];
  const groups = new Map<CommandKind, T[]>(DRIVER_COMMAND_ORDER.map(kind => [kind, []]));
  for (const item of items) {
    const kind = kindOf(item);
    const group = groups.get(kind);
    if (!group) throw new Error(`writeInOneCommands: commandKindOf must answer insert, update or delete, got ${String(kind)}`);
    group.push(item);
  }
  return DRIVER_COMMAND_ORDER.map(kind => groups.get(kind)!).filter(group => group.length > 0);
}
