/**
 * A directory delete reads the roots of what it holds in pages, not in one unlimited read (bundle-88, Q-412).
 *
 * ## The defect
 *
 * `rootsOfDirectory` read every live row under the directory in one `find` with no limit and a `distinct` of every parent a derived
 * row under it names: the answer grew with the directory and was held whole in memory, in a space of any size.
 *
 * ## The rule this file states
 *
 * Every read of the file rows by a path prefix during a directory delete carries a `limit` no larger than `READ_CHUNK`, and no
 * `distinct` of parents is issued: roots are paged by `_id` and parents by `parentFileId`, both keyset pages.
 *
 * ## Seen red
 *
 * On the base (1e430410c): one `find` by prefix with no limit, and a `distinct` on the files.
 *
 * Run: node --test testing/standalone/a-directory-delete-reads-its-roots-in-pages-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'dirroots';
const FILES = `${S}_files`;
const T0 = '2026-09-01T00:00:00.000Z';

let acts, READ_CHUNK, seen, listener;

describe('a directory delete reads its roots in pages', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'dirroots', space: S, monitorCommands: true });
    ({ READ_CHUNK } = await import('../../server/dist/db/read-by-id.js'));
    seen = [];
    listener = (ev) => { seen.push({ name: ev.commandName, command: ev.command }); };
    acts.door.mongo.getMongo().on('commandStarted', listener);
  });
  after(async () => { acts?.door.mongo.getMongo().off('commandStarted', listener); await acts?.close(); });
  beforeEach(async () => { await acts.reset(); seen.length = 0; });

  it('1 300 files under a directory: every read of its rows by prefix is limited to a chunk, and no distinct is issued', async () => {
    assert.ok(Number.isInteger(READ_CHUNK) && READ_CHUNK > 1, 'db/read-by-id.ts exports no READ_CHUNK');
    const n = 1_300;
    const paths = Array.from({ length: n }, (_, i) => `big/f${i}.txt`);
    fs.mkdirSync(path.join(acts.root(), 'big'), { recursive: true });
    for (const p of paths) fs.writeFileSync(path.join(acts.root(), p), 'x');
    await acts.door.coll(S, 'files').insertMany(paths.map(p => ({ _id: p, spaceId: S, path: p, sizeBytes: 1, tags: [], createdAt: T0, updatedAt: T0 })));
    // A derived row under the directory whose parent has no row: the orphan a directory's roots must still reach.
    await acts.door.coll(S, 'files').insertOne({ _id: 'big/gone.txt#chunk0', spaceId: S, path: 'big/gone.txt#chunk0', parentFileId: 'big/gone.txt',
      sizeBytes: 1, tags: [], createdAt: T0, updatedAt: T0 });
    seen.length = 0;
    const del = await acts.rest('DELETE', { path: 'big' }, { confirm: true });
    assert.ok(!acts.failed(del), `the delete was refused: ${JSON.stringify(del.body)}`);
    assert.equal(acts.onDisk('big'), false);
    assert.deepEqual(await acts.door.coll(S, 'files').find({}, { projection: { _id: 1 } }).toArray(), [], 'rows of the directory (or its orphan) survived');

    const byPrefix = seen.filter(c => c.name === 'find' && c.command.find === FILES
      && Object.entries(c.command.filter ?? {}).some(([k, v]) => (k === '_id' || k === 'parentFileId') && v && typeof v === 'object' && '$regex' in v));
    assert.ok(byPrefix.length > 0, 'no read of the file rows by prefix was seen: the case does not reach the roots read');
    const unlimited = byPrefix.filter(c => !(Number.isInteger(c.command.limit) && c.command.limit > 0 && c.command.limit <= READ_CHUNK));
    assert.equal(unlimited.length, 0, `${unlimited.length} reads of the rows by prefix carry no limit within ${READ_CHUNK}: ${JSON.stringify(unlimited.map(c => c.command.limit ?? null))}`);
    assert.equal(seen.filter(c => c.name === 'distinct' && c.command.distinct === FILES).length, 0, 'a distinct of the parents was issued: its answer is the whole directory');
  });
});
