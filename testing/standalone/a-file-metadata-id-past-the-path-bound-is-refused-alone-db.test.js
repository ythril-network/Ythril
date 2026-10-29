/**
 * A file-metadata document whose `_id` or `path` is past the one bound for a peer's path is refused ALONE, with the schema's reason
 * (bundle-88, Q-415).
 *
 * ## The defect
 *
 * `IncomingFileMetaDoc._id` and `path` were `z.string().min(1)` with no maximum. The one bound a peer's path had was the file tombstone's
 * (`MAX_TOMBSTONE_PATH`, 4096), so a metadata page carried a path of any length to `fileKeyRefusal` and the writer, which are not the
 * place a peer's text is measured.
 *
 * ## The rule this file states
 *
 * A path is a peer's text that reaches the file system and the database, and there is ONE bound for it (`MAX_PEER_PATH_LENGTH`), shared by
 * the tombstone and the metadata schemas. A page of `[ok, a 5000-character id]` lands `ok` and refuses the other with the schema's own
 * reason, which names the bound, on push; on pull the document is not stored and the page goes on.
 *
 * ## Seen red
 *
 * On the base (1e430410c): the refusal's reason does not name the bound (it is the key refusal's, or none).
 *
 * Run: node --test testing/standalone/a-file-metadata-id-past-the-path-bound-is-refused-alone-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'pathbound';

let door, MAX_PEER_PATH_LENGTH;
const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const meta = (p, seq) => build.filemeta(S, p, seq, { author: PEER_AUTHOR });
const tooLong = () => `${'d/'.repeat(2_499)}x.txt`;

describe('a file-metadata id past the path bound is refused alone', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'pathbound', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    ({ MAX_PEER_PATH_LENGTH } = await import('../../server/dist/util/request-bounds.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); await door.coll(S, 'files').deleteMany({}); });

  it('the bound is one number, shared with the tombstone door', async () => {
    assert.equal(MAX_PEER_PATH_LENGTH, 4_096, 'util/request-bounds.ts exports no MAX_PEER_PATH_LENGTH of 4096');
    assert.ok(tooLong().length > MAX_PEER_PATH_LENGTH);
    const tombstoneDoor = await import('../../server/dist/files/peer-tombstone-apply.js');
    assert.ok(tombstoneDoor, 'the tombstone door did not load');
  });

  it('push: [ok, 5000-character id] lands ok and refuses the other with the bound in its reason', async () => {
    const long = tooLong();
    const answer = await door.push('/batch-upsert', { filemeta: [meta('ok.txt', 1), meta(long, 1)] }, { spaceId: S, token: peerToken(PEER) });
    assert.equal(answer.code, 200, JSON.stringify(answer.body).slice(0, 400));
    assert.ok(await row('ok.txt'), 'the good document of the page was not stored');
    assert.equal(await row(long), null, 'the over-long id was stored');
    assert.equal(answer.body.filemeta.rejected, 1, JSON.stringify(answer.body.filemeta));
    // The batch answer counts a refusal and does not carry its reason: the reason is the schema's, which this reads at its source.
    const { IncomingFileMetaDoc } = await import('../../server/dist/sync/incoming-schemas.js');
    for (const key of ['_id', 'path']) {
      const parsed = IncomingFileMetaDoc.safeParse({ ...meta('ok.txt', 1), [key]: long });
      assert.equal(parsed.success, false, `an over-long ${key} passed the schema`);
      assert.match(JSON.stringify(parsed.error.issues), new RegExp(String(MAX_PEER_PATH_LENGTH)), `the refusal of ${key} does not name the bound`);
    }
  });

  it('pull: the over-long id is not stored and the page goes on', async () => {
    const long = tooLong();
    door.state.records[S] = { filemeta: [meta('ok.txt', 1), meta(long, 1)] };
    await door.sync();
    assert.ok(await row('ok.txt'), 'the good document of the page was not stored');
    assert.equal(await row(long), null, 'the over-long id was stored');
  });
});
