/**
 * `readsDuring` (testing/standalone/_schema-version-fixtures.mjs) counts the read commands ITS call sends, never a read some earlier
 * step left running on the same collection.
 *
 * Bought by main's CI run 43499981804 (shard 3, 2026-11-13). "fingerprintsCarriedIn ... is answered from the index without reading a
 * record" saw 2 commands where its call sends 1. Saving a schema version calls `updateSpace`, which starts the snapshot sweep detached
 * (`sweepAfterMetaWrite`, server/src/spaces/spaces.ts). The sweep reads the same collection through `fingerprintsCarriedIn`, and when its
 * read overlapped the measured call, the count took both. The Full run on the same tree had passed: a race, not a defect of the reader.
 *
 * The rule: the helper first waits until the collection has been quiet (no read command from this client) for a settle window, and only
 * then runs the call and counts. A background reader that is still going when the call starts is waited out, not counted.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { readsDuring } from './_schema-version-fixtures.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const SPACE = 'readcount';

describe('a read count sees only the call it measures (real MongoDB)', { skip }, () => {
  let door, client;
  before(async () => {
    door = await openToolDoor({ suite: 'readcount', monitorCommands: true, spaces: [{ id: SPACE, label: SPACE, folders: [], meta: {} }] });
    client = door.mongo.getMongo();
    await door.coll(SPACE, 'entities').insertOne({ _id: 'one', spaceId: SPACE, name: 'one' });
  });
  after(async () => { await door?.close(); });

  it('a reader still running from an earlier step is waited out, and the call\'s own one command is all that is counted', async () => {
    const coll = door.coll(SPACE, 'entities');
    // An earlier step's background reader: a read every 20 ms for 300 ms, not awaited, as the detached sweep is not.
    // A fixed count of reads 20 ms apart, so it is still reading when the measured call is asked for.
    let stop = false;
    const background = (async () => {
      for (let k = 0; k < 15 && !stop; k++) { await coll.find({ name: 'one' }).toArray(); await elapse(20, 'pacing: a background reader issues one read every 20 ms'); }
    })();
    try {
      const { result, sent } = await readsDuring(client, `${SPACE}_entities`, () => coll.find({ _id: 'one' }).toArray());
      assert.deepEqual(result.map(r => r._id), ['one'], 'the measured call did not read its record');
      assert.equal(sent.length, 1, `the count took reads the call did not send: ${sent.map(s => JSON.stringify(s.command.filter)).join(' ')}`);
      assert.deepEqual(sent[0].command.filter, { _id: 'one' }, 'the one counted command is not the call\'s');
    } finally { stop = true; await background; }
  });
});
