/**
 * A page of FILE METADATA costs the same number of database commands whatever its size — pushed or pulled
 * (`Q-107` part 2, performance).
 *
 * ## Why a second file and not an edit of the first
 *
 * `a-push-page-costs-the-same-at-any-size-db.test.js` holds the five brain families to this rule and leaves file
 * metadata out, in so many words, "until `Q-107` part 2". This is part 2: the same rule over the family that was
 * excluded, on BOTH doors that hand a page of it to the one writer (`writeArrivals`). The old file stays as it is,
 * so its five families keep their own evidence and this one can be read red on its own.
 *
 * ## What it costs today
 *
 * The writer's files branch merges each document through `ingestFileMeta`: a `findOne` for the stored copy's
 * hashes and an `updateOne` upsert — `2N` commands on the files collection, on top of the page's one accept read.
 * A 200-document page is 400 commands where the page form is a handful, and a pull of a large tree pays it on
 * every page of every cycle.
 *
 * ## The rule
 *
 * A page of 200 new file-metadata documents issues EXACTLY as many commands as a page of 20, once the collection
 * is warm, through the push door (`POST /api/sync/batch-upsert`) and through the pull (`runSyncForPeer` against a
 * peer serving the page). Both sizes sit inside one write chunk (500), so a chunked writer cannot make them differ.
 *
 * Counted: the commands addressed to the files collection, the tombstones, the embed queue and the counter —
 * what the page itself costs. No blob is held, so no file is queued for embedding (a queue write per file
 * would show up in this scope too, and the planned single batched enqueue would not).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-metadata-page-costs-the-same-at-any-size-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, FAMILIES } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'filemetacost';
/** The family under test, read from the push door's table so its body key and collection are not re-spelled. */
const FILEMETA = Object.entries(FAMILIES).find(([, f]) => f.coll === 'files');

let door, searchIndexPresenceSettled;
let seq = 0;
/** New, distinct, top-level files (no `parentFileId`): what a peer offers. Seqs rise so every one is newer. */
const page = (n, tag) => Array.from({ length: n }, (_, i) =>
  build.filemeta(S, `docs/${tag}/file-${i}.md`, ++seq, { author: PEER_AUTHOR }));

/** The commands a page cost in the page's own scope, through `deliver` (push or pull). */
async function cost(deliver, n, tag) {
  const scope = new Set([`${S}_files`, `${S}_tombstones`, `${S}_embed_jobs`, 'ythril_counters']);
  const docs = page(n, tag);
  const seen = await door.commandsDuring(async () => {
    await deliver(docs);
    await door.settled();
    // The presence reconcile a write schedules runs after it; awaited inside the window so every page counts it
    // alike (see the brain-family twin of this file for the 7-versus-8 it otherwise produces).
    await searchIndexPresenceSettled(S);
  });
  // Every document landed: a page that wrote nothing would cost the same at any size and pass vacuously.
  const stored = await door.coll(S, 'files').countDocuments({ _id: { $in: docs.map(d => d._id) } });
  assert.equal(stored, n, `${tag}: ${stored} of ${n} file-metadata documents landed`);
  return seen.filter(c => scope.has(c.split(' ')[1]));
}

const viaPush = async (docs) => {
  const res = await door.push('/batch-upsert', { [FILEMETA[0]]: docs }, { spaceId: S });
  assert.equal(res.code, 200, JSON.stringify(res.body));
};
const viaPull = async (docs) => {
  door.state.records[S] = { [FILEMETA[0]]: docs };
  await door.sync();
};

describe('a page of file metadata costs the same at any size', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'filemetacost', spaces: [S], monitorCommands: true });
    ({ searchIndexPresenceSettled } = await import('../../server/dist/spaces/search-index-presence.js'));
  });
  after(async () => { await door?.close(); });

  it('the family is the files collection and monitoring sees its commands', async () => {
    assert.ok(FILEMETA, 'the push door has no family stored in the files collection — re-anchor this test');
    const seen = await cost(viaPush, 2, 'probe');
    assert.ok(seen.some(c => c.endsWith(` ${S}_files`)),
      'command monitoring recorded nothing on the files collection, so every comparison below would pass vacuously');
  });

  for (const [door_, deliver] of [['push', viaPush], ['pull', viaPull]]) {
    it(`${door_}: a 200-document file-metadata page issues as many commands as a 20-document page`, async () => {
      await cost(deliver, 5, `${door_}-warm`);
      const small = await cost(deliver, 20, `${door_}-small`);
      const large = await cost(deliver, 200, `${door_}-large`);
      assert.equal(large.length, small.length,
        `${door_}: 20 file-metadata documents cost ${small.length} commands and 200 cost ${large.length} — the page `
        + `is written one document at a time. First commands of the large page: ${large.slice(0, 6).join('; ')}`);
    });
  }
});
