/**
 * A bulk write the write bound covers is ONE wire command (`Q-372`, pre-ship finding F2) — held at the one writer whose
 * page size is a peer's, and pinned at the caps that keep every other bounded bulk under the limit.
 *
 * ## The limit the bound's guarantee has
 *
 * `maxTimeMS` is per WIRE COMMAND. The driver splits a bulk write into several commands when its batch passes the server's
 * `maxBsonObjectSize` (16 MiB — `lib/bulk/common.js`: `maxBatchSizeBytes = maxBsonObjectSize`; the finding's 48 MB was the
 * message size, which is not what the driver batches by) or `maxWriteBatchSize` operations. Each command gets the SAME
 * `maxTimeMS`, armed when THAT command reaches the server, while the client backstop is armed once, at the call. A second
 * command can therefore arrive after the backstop has answered the caller `503` and released the hold, with a fresh
 * deadline, and land. "A write the bound ended never lands" holds for one command, not for a call that becomes several.
 *
 * ## What is held, and where it stops being true
 *
 * - `inOneCommandChunks` (`db/one-command.ts`) slices a batch of operations so each slice is under `ONE_COMMAND_BYTES`
 *   (derived from the driver's limit, with room for the command's own framing) and under a stated count, and a single
 *   operation over the limit goes alone (the driver sends it alone as well);
 * - `writeArrivals` (`sync/arrivals.ts`) writes its page through it. It is the bounded bulk whose size is a PEER's: a
 *   pulled page has no body cap, and 500 documents of 32 KiB are already 16 MiB;
 * - the other bounded bulk writers take a quantity a caller's request caps: a request body is at most 10 MiB
 *   (`express.json` in `app.ts`), a bulk save at most `BULK_MAX_PER_TYPE` items per array, and their own chunks are
 *   `ROWS_PER_BULK_COMMAND` rows or fewer. BSON is not JSON, and a body of scalar properties inflates to about twice its
 *   size, so those caps keep a request-fed bulk under 16 MiB for any real record and NOT for an adversarial one. That is a
 *   stated limit (`db/write-bound.ts`), not a proof; the caps are pinned here so that raising one is a decision.
 *
 * Run: node --test testing/standalone/a-bounded-bulk-write-is-one-command.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BSON } from 'mongodb';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { ONE_COMMAND_BYTES, inOneCommandChunks } from '../../server/dist/db/one-command.js';
import { ROWS_PER_BULK_COMMAND } from '../../server/dist/util/chunks.js';
import { READ_CHUNK } from '../../server/dist/db/read-by-id.js';
import { BULK_MAX_PER_TYPE } from '../../server/dist/brain/bulk.js';

const MIB = 1024 * 1024;
const bytes = (doc) => BSON.calculateObjectSize(doc);
const docOf = (id, size) => ({ _id: String(id), text: 'x'.repeat(size) });
const MAX_BSON_OBJECT_SIZE = 16 * MIB; // MongoDB's, and the driver's fallback when a server reports none

describe('inOneCommandChunks', () => {
  const chunk = (items, maxItems = 500) => inOneCommandChunks(items, { maxItems, bytesOf: bytes });

  it('the limit is under the driver\'s batch limit, with room for the command\'s own framing', () => {
    assert.ok(ONE_COMMAND_BYTES < MAX_BSON_OBJECT_SIZE, 'a batch at the driver\'s own limit splits once the command\'s framing is added');
    assert.ok(MAX_BSON_OBJECT_SIZE - ONE_COMMAND_BYTES >= 64 * 1024, 'less than 64 KiB of room for the command document around the operations');
    assert.ok(ONE_COMMAND_BYTES > MAX_BSON_OBJECT_SIZE / 2, 'a limit under half the driver\'s sends more commands than it has to');
  });

  it('a page under the limit is one chunk, in order', () => {
    const items = Array.from({ length: 50 }, (_, i) => docOf(i, 1000));
    assert.deepEqual(chunk(items), [items]);
  });

  it('a page over the limit is split, every chunk is under it, and nothing is lost or reordered', () => {
    const items = Array.from({ length: 20 }, (_, i) => docOf(i, MIB)); // 20 MiB
    const chunks = chunk(items);
    assert.ok(chunks.length >= 2, `${chunks.length} chunk(s) for 20 MiB`);
    for (const c of chunks) assert.ok(c.reduce((n, d) => n + bytes(d), 0) <= ONE_COMMAND_BYTES, 'a chunk is over the one-command limit');
    assert.deepEqual(chunks.flat(), items);
  });

  it('the count limit splits too', () => {
    const items = Array.from({ length: 1201 }, (_, i) => docOf(i, 10));
    assert.deepEqual(chunk(items, 500).map(c => c.length), [500, 500, 201]);
  });

  it('one operation over the limit goes alone, and its neighbours are not swallowed with it', () => {
    const big = docOf('big', ONE_COMMAND_BYTES + 1000);
    const chunks = chunk([docOf(1, 100), big, docOf(2, 100)]);
    assert.deepEqual(chunks.map(c => c.map(d => d._id)), [['1'], ['big'], ['2']]);
  });

  it('nothing is no chunk; a count that is not a positive integer is refused, not read as "no slicing"', () => {
    assert.deepEqual(chunk([]), []);
    for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => chunk([docOf(1, 1)], bad), /maxItems/);
  });
});

describe('the writer whose page size is a peer\'s writes through it', () => {
  const code = stripComments(readFileSync(join(REPO_ROOT, 'server/src/sync/arrivals.ts'), 'utf8'));

  it('writeArrivals chunks its bulk write by bytes as well as by count', () => {
    assert.match(code, /\binOneCommandChunks\(/, 'sync/arrivals.ts no longer slices its page with inOneCommandChunks');
    assert.doesNotMatch(code, /\binChunks\(\s*toWrite\b/, 'sync/arrivals.ts slices the page to write by count alone again');
  });
});

describe('the caps that keep every other bounded bulk under one command are pinned', () => {
  it('a request body is at most 10 MiB, a bulk save at most BULK_MAX_PER_TYPE per array, a chunk ROWS_PER_BULK_COMMAND', () => {
    const app = stripComments(readFileSync(join(REPO_ROOT, 'server/src/app.ts'), 'utf8'));
    const limits = [...app.matchAll(/express\.json\(\s*\{\s*limit:\s*'(\d+)mb'/g)].map(m => Number(m[1]));
    assert.ok(limits.length >= 1, 'app.ts no longer sets a JSON body limit the analysis rests on');
    for (const l of limits) assert.ok(l <= 10, `the JSON body limit is ${l} MiB; the analysis in db/write-bound.ts rests on 10 MiB at most`);
    assert.ok(BULK_MAX_PER_TYPE <= 500, `a bulk save takes ${BULK_MAX_PER_TYPE} items per array`);
    assert.ok(ROWS_PER_BULK_COMMAND <= 1000 && READ_CHUNK <= 500, 'a chunk of rows grew past what the analysis assumes');
  });
});
