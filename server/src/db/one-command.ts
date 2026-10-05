/**
 * Slice a batch of operations so a bulk write of one slice is ONE wire command.
 *
 * ## The question it answers
 *
 * "How many of these can one bulk write carry without the driver turning it into several commands?" Asked by the writer
 * whose page is a peer's (`sync/arrivals.ts`), which hands a bulk write up to a chunk of documents of any size.
 *
 * ## What it prevents
 *
 * The write bound (`db/write-bound.ts`) ends a plain write with the server's own deadline, `maxTimeMS`, and a client
 * backstop 500 ms after it. `maxTimeMS` is per WIRE COMMAND, and the driver splits a bulk write into several when the batch
 * passes the server's `maxBsonObjectSize` (16 MiB; `lib/bulk/common.js`) or its `maxWriteBatchSize`: each command is given
 * the same `maxTimeMS`, armed when THAT command reaches the server, while the backstop is armed once. A second command can
 * arrive after the caller was answered `503` and the hold released, with a deadline of its own, and land — the defect the
 * bound exists to close. A call that is one command cannot do that, so the writer makes it one.
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

import { BSON } from 'mongodb';

/** The BSON size of one operation (or any value) as a command would carry it. Not a document: it is measured inside one. */
export const operationBytes = (value: unknown): number => BSON.calculateObjectSize({ v: value } as never);

/** MongoDB's `maxBsonObjectSize`, which is also what the driver batches a bulk write by (and its fallback when a server reports none). */
const MAX_BSON_OBJECT_SIZE = 16 * 1024 * 1024;

/**
 * The most bytes of operations one bulk write may carry and stay one command: the driver's batch limit less room for the
 * command document around the operations (its `update`/`ordered`/`$db` fields, and the array keys, which it counts per operation).
 */
export const ONE_COMMAND_BYTES = MAX_BSON_OBJECT_SIZE - 256 * 1024;

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
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error(`inOneCommandChunks: maxItems must be a positive integer, got ${maxItems}`);
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
