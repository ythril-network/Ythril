/**
 * Every write of a space's meta sweeps what it suppresses, and writes that land together sweep ONCE, against the
 * meta the last of them wrote (bundle-30 stage I5, the diff pass's open question on `sweepAfterMetaWrite`).
 *
 * ## The two defects this holds closed
 *
 *  - **A meta change applied by a vote swept twice or more.** `spaces/meta-update.ts` swept after a round passed on
 *    the proposer's own vote, and the conclusion had already swept: it writes through `commitOwnMetaEdit` and
 *    `storeNetworkLayer`, both of which end in `recomputeEffectiveMeta`, which swept. A proposer holding a layer ran
 *    the recompute twice, so three sweeps of one change — each a pass over every collection of the space.
 *  - **A schema edit on a space no network carries swept nothing.** `PUT /schema`, the per-type upsert and delete,
 *    and the schema library's apply write through `commitOwnMetaEdit`, whose plain branch (no layer yet, so no
 *    `ownMeta`) was an `updateSpace` and nothing else. A type schema turning `suppressEmbeddings` on left every
 *    stored vector of that type in place, while the same edit on a layered space swept: one write, two outcomes,
 *    decided by whether a network had ever sent the space a layer.
 *
 * ## The rule, and where it lives
 *
 * `updateSpace` is the one writer of `space.meta` (`a-meta-write-goes-through-the-own-definitions` holds every
 * other meta write to it), so the sweep is asked for THERE, and nowhere else — and `sweepAfterMetaWrite` coalesces
 * per space: the sweep starts once the writes of this turn have landed, against the latest meta, and a write during
 * a running sweep queues one more.
 *
 * ## How "once" is seen
 *
 * A sweep that removes vectors issues one `update` on each collection it found them in. So two writes that each
 * suppress something, swept twice, issue two `update`s on the facts collection; swept once, one — counted from the
 * driver's command stream, which the polling below (reads) does not add to.
 *
 * ## Seen red
 *
 * On be27125e: `updateSpace` sweeps nothing, so both cases time out with the vectors in place.
 *
 * Run: node --test testing/standalone/a-meta-write-sweeps-once-wherever-it-lands-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'metasweep';

let door, spaces, effective;

const VECTOR = { embedding: [0.1, 0.2, 0.3], embeddingModel: 'test-model' };
const fact = (_id, type) => ({ _id, spaceId: S, type, fact: `fact ${_id}`, tags: [], seq: 1, ...VECTOR });
const suppressing = (...types) => ({
  typeSchemas: { fact: Object.fromEntries(types.map(t => [t, { suppressEmbeddings: true }])) },
});
const hasVector = async (id) => (await door.coll(S, 'facts').findOne({ _id: id }))?.embedding !== undefined;

/** Until `check` holds, or fail naming `what` — the sweep is not awaited by the write, by design. */
async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail(`${what} within ${ms} ms`);
}

describe('a meta write sweeps once, wherever it lands', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'metasweep', monitorCommands: true, spaces: [{ id: S, label: 'Meta sweep', folders: [], meta: {} }],
    });
    spaces = await import('../../server/dist/spaces/spaces.js');
    effective = await import('../../server/dist/spaces/effective-meta.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    spaces.updateSpace(S, { meta: {} });
    await new Promise(r => setTimeout(r, 200));
  });

  it('two meta writes in one turn sweep once, against the later meta', async () => {
    await door.coll(S, 'facts').insertMany([fact('fa', 'A'), fact('fb', 'B')]);
    const commands = await door.commandsDuring(async () => {
      spaces.updateSpace(S, { meta: suppressing('A') });
      spaces.updateSpace(S, { meta: suppressing('A', 'B') });
      await until(async () => !(await hasVector('fa')) && !(await hasVector('fb')),
        'the sweep did not remove both vectors');
      // Room for a second sweep to show itself, had one started.
      await new Promise(r => setTimeout(r, 500));
    });
    const updates = commands.filter(c => c === `update ${S}_facts`);
    assert.equal(updates.length, 1,
      `one change swept ${updates.length} times — every sweep is a pass over every collection of the space`);
  });

  it('a schema edit on a space no network carries sweeps what it suppresses', async () => {
    await door.coll(S, 'facts').insertMany([fact('fc', 'C'), fact('fd', 'D')]);
    assert.equal(effective.commitOwnMetaEdit(S, base => effective.withType(base, 'fact', 'C', { suppressEmbeddings: true }))?.id, S);
    await until(async () => !(await hasVector('fc')), 'a type schema turned suppression on and its stored vector stayed');
    assert.equal(await hasVector('fd'), true, 'a type the edit did not suppress lost its vector');
  });
});
