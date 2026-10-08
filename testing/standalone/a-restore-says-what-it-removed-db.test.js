/**
 * A restore says how many authored keys it took off the file rows it replaced (bundle-48 sweep, finding 2).
 *
 * ## The defect
 *
 * A restore is a full record (`Q-256`): every authored key a backup row lacks is REMOVED from the row it replaces, a
 * description, its source, the properties, the tags and a suppression mark included. That is documented, and it was silent: the
 * import summary counted the flags it kept (`flagsKept`) and said nothing of what it removed, so an operator restoring an older
 * backup over newer edits learned of it from the missing text.
 *
 * ## The rule
 *
 *  1. the summary's `keysRemoved` is the number of authored keys that were ON a replaced row and are not on the backup row it was
 *     replaced by, summed over the rows that landed — a key the replaced row never had is not counted, and a row new here removes
 *     nothing
 *  2. it comes from the rule that decides what a restore removes (`removedFileMetaKeys`), so the count and the removal cannot
 *     disagree: the keys counted are exactly the keys gone from the stored rows
 *  3. it is absent when nothing was removed, as `flagsKept` is absent when nothing was kept
 *
 * ## Seen red
 *
 * On the base the summary has no `keysRemoved`. The control (a restore that removes nothing carries none) is green there.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27219 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-restore-says-what-it-removed-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'restoreremoved';
const T_OLD = '2026-09-01T00:00:00.000Z';
const T_NEW = '2026-10-01T00:00:00.000Z';
/** Everything authored a stored row can carry that the cases below remove from. */
const FULL = { description: 'described', descriptionSource: 'generated', tags: ['a'], properties: { k: 'v' }, suppressEmbeddings: true };
/** What this instance holds about its own bytes: never authored, never counted. */
const LOCAL = { sizeBytes: 12, sha256: 'e'.repeat(64) };

let door, importMod;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
const stored = (id, extra) => door.coll(S, 'files').insertOne({ ...build.filemeta(S, id, 5, { author: PEER_AUTHOR, updatedAt: T_OLD, ...LOCAL, ...extra }) });
/** A backup row: the row as it was exported, newer than the stored copy, carrying only what it keeps. */
const backup = (id, keep = {}) => ({ _id: id, spaceId: S, path: id, author: PEER_AUTHOR, createdAt: T_OLD, updatedAt: T_NEW, seq: 9, ...keep });
const AUTHORED = Object.keys(FULL);
const goneFrom = (row) => AUTHORED.filter(k => row?.[k] === undefined);

describe('a restore says how many authored keys it removed', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'restoreremoved', spaces: [S] });
    importMod = await import('../../server/dist/api/admin-import.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('counts the keys that were on the replaced row and are not on the backup row, and they are the keys gone', async () => {
    await stored('all-but-tags.md', FULL);
    await stored('only-description.md', { description: 'only this one' });
    const out = await importMod.importDocuments(S, { files: [backup('all-but-tags.md', { tags: ['a'] }), backup('only-description.md', { tags: [] })] });
    assert.equal(out.results.files.errors, 0, JSON.stringify(out.results.files));
    // The first row lost description, its source, the properties and the suppression mark (4) and kept its tags; the second lost its
    // description (1). Its other authored keys it never had, so they are not counted.
    assert.deepEqual(goneFrom(await rowOf('all-but-tags.md')), ['description', 'descriptionSource', 'properties', 'suppressEmbeddings'], 'fixture: the restore did not remove what the summary should count');
    assert.deepEqual((await rowOf('only-description.md')).description, undefined, 'fixture: the restore did not remove the description');
    assert.equal(out.results.files.keysRemoved, 5, `the summary says ${out.results.files.keysRemoved}: ${JSON.stringify(out.results.files)}`);
  });

  it('a row new here removes nothing, and counts nothing', async () => {
    const out = await importMod.importDocuments(S, { files: [backup('brand-new.md')] });
    assert.equal(out.results.files.inserted, 1, JSON.stringify(out.results.files));
    assert.equal(out.results.files.keysRemoved, undefined, 'a row that replaced nothing removed keys');
  });

  it('control: a restore that removes nothing carries no count, and the flags it keeps are still counted', async () => {
    await stored('same.md', { ...FULL, deletedAt: T_OLD });
    const out = await importMod.importDocuments(S, { files: [backup('same.md', { ...FULL, deletedAt: T_OLD })] });
    assert.equal(out.results.files.errors, 0, JSON.stringify(out.results.files));
    assert.equal(out.results.files.keysRemoved, undefined, 'a restore that removed nothing said it removed keys');
    assert.equal(out.results.files.flagsKept, 1);
  });
});
