/**
 * A record the absent-bytes sweep has stamped (`bytesAbsentSince`: its bytes are gone, it is waiting out its window) is not counted as a file,
 * is reported as awaiting bytes on both doors, and its stamp never leaves this instance (bundle-70, Q-337, slice S4).
 *
 * ## What it prevents
 *
 * **A count the listing cannot show.** The Files tab counts a record whose bytes are gone and lists no row for it, so a person cannot delete it
 * (the defect the owner answered). While the record waits out its window the count doors must say what the listing says, and must say WHY
 * the number is lower than the records: `filesAwaitingBytes`. A door that counts it, or one that does not report it, leaves the badge and the
 * page disagreeing again. Every reader of the files collection declares whether a stamped row counts: `COUNTED_FILE_ROW` (no stamp) for counts,
 * `LIVE_FILE_ROW` for the brain (a record waiting for its bytes stays searchable until it is removed).
 *
 * **A local field that travels.** `bytesAbsentSince` says "THIS disk lacks the bytes". Sent to a peer, it would make the peer think the file is
 * absent for everybody; kept by an arrival, it would outlive the bytes' return. It is local: the pull serve path is a DENYLIST (`LOCAL_ONLY_FIELDS`),
 * so a field not named there is served (the push allowlist alone proved nothing: pitfall-one-mechanism-checked-all-concluded). One case per way out.
 *
 * ## What is held, one case each
 *
 *  - the four count doors: REST stats, MCP `space_stats`, `space_meta` and the completeness facts count the files that can be listed; `affected`
 *    never exceeds `total`; `LIVE_FILE_ROW` still reads the stamped row;
 *  - `filesAwaitingBytes` on REST stats and on MCP `space_stats`, equal, counting the stamped rows;
 *  - after a real pass the badge already matches the listing (the stamp is what the sweep writes);
 *  - the stamp does not leave: the pull page a peer reads, the merkle leaf and root, the arrival strip and the sender's projection, a reader's rows.
 *
 * Red on 8ee92312: the stamp is an unknown field, so the doors count the row and report nothing, and every egress path carries it.
 *
 * Run: node --test testing/standalone/a-record-waiting-for-its-bytes-is-not-counted-and-never-leaves-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { NOW, SHA_PRESENT, THE_TWO_PASSES, runPass, orphan, fileRow } from './_absent-bytes-sweep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'absentcounts';
const STAMP = NOW.toISOString();

let acts, ADMIN, searchRouter;
const rows = () => acts.door.coll(S, 'files');

/** A REST route's own handler, past rate limit and auth. */
function routeHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} on its router — re-anchor this test`);
  return layer.route.stack.at(-1).handle;
}
async function restStats() {
  const handler = routeHandler(searchRouter, 'get', '/spaces/:spaceId/stats');
  const req = { method: 'GET', params: { spaceId: S }, query: {}, body: {}, ip: '127.0.0.1', get: () => undefined, headers: {}, authToken: { id: 't', name: 'test', rights: ADMIN } };
  const res = { code: 200, body: undefined, headersSent: false, status(c) { this.code = c; return this; }, setHeader() { return this; }, json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handler(req, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body;
}
/** Two healthy files and two records waiting for their bytes (stamped by hand: the stamp is what the sweep writes, read here by the doors). */
async function twoAndTwo() {
  await acts.seed('ok0.txt', { sha256: SHA_PRESENT, seq: 1 });
  await acts.seed('ok1.txt', { sha256: SHA_PRESENT, seq: 1 });
  await rows().insertMany([orphan(S, 'wait0.txt', { bytesAbsentSince: STAMP }), orphan(S, 'wait1.txt', { bytesAbsentSince: STAMP })]);
}

describe('a record waiting for its bytes is not counted, is reported, and never leaves this instance (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'absentcounts', space: S });
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    ({ searchRouter } = await import('../../server/dist/api/brain/search.js'));
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  describe('the counts', () => {
    it('REST stats, MCP space_stats and space_meta count the 2 files that can be listed, not the 2 records waiting for bytes', async () => {
      await twoAndTwo();
      const rest = await restStats();
      const stats = await acts.mcp('space_stats', {});
      const meta = await acts.mcp('space_meta', {});
      assert.deepEqual({ rest: rest.files, 'space_stats': stats.sc?.files, 'space_meta': meta.sc?.stats?.files }, { rest: 2, 'space_stats': 2, 'space_meta': 2 },
        'a files count includes records whose bytes are gone: the badge says more files than the listing can show, and none of them can be deleted from the page');
    });

    it('both doors report filesAwaitingBytes, the number of records waiting, so the lower count is explained', async () => {
      await twoAndTwo();
      const rest = await restStats();
      const stats = await acts.mcp('space_stats', {});
      assert.equal(rest.filesAwaitingBytes, 2, `REST stats answers filesAwaitingBytes ${JSON.stringify(rest.filesAwaitingBytes)}`);
      assert.equal(stats.sc?.filesAwaitingBytes, 2, `MCP space_stats answers filesAwaitingBytes ${JSON.stringify(stats.sc?.filesAwaitingBytes)} (both doors, convention-ythril-both-doors-same-parameters)`);
    });

    it('the completeness facts count the same files, and affected never exceeds total', async () => {
      const { gatherCompletenessFacts } = await import('../../server/dist/spaces/completeness.js');
      await twoAndTwo();
      const facts = await gatherCompletenessFacts([S]);
      assert.equal(facts.files, 2, 'the completeness total counts records waiting for bytes');
      assert.ok(facts.filesNotRecallable <= facts.files, `affected (${facts.filesNotRecallable}) exceeds total (${facts.files}): a stamped row is counted on one side only`);
      assert.equal(facts.filesNotRecallable, 2, 'the stamped rows (no vector) are counted as not recallable: the two healthy ones are the whole answer');
    });

    it('the brain still reads the stamped rows (LIVE_FILE_ROW keeps them searchable until they are removed), and COUNTED_FILE_ROW is the files that can be listed', async () => {
      const live = await import('../../server/dist/files/live-file-row.js');
      await twoAndTwo();
      assert.equal(await rows().countDocuments({ ...live.LIVE_FILE_ROW }), 4, 'a record waiting for its bytes left the brain before the sweep removed it');
      assert.ok(live.COUNTED_FILE_ROW, 'files/live-file-row.ts exports no COUNTED_FILE_ROW (LIVE_FILE_ROW and no bytesAbsentSince): the count doors have no one filter to ask');
      assert.equal(await rows().countDocuments({ ...live.COUNTED_FILE_ROW }), 2);
    });

    it('after a real pass the badge already matches the listing and the waiting record is reported', async () => {
      await acts.seed('ok0.txt', { sha256: SHA_PRESENT, seq: 1 });
      await acts.seed('ok1.txt', { sha256: SHA_PRESENT, seq: 1 });
      await rows().insertOne(orphan(S, 'gone.txt'));

      await runPass(NOW);

      const rest = await restStats();
      assert.equal((await rows().findOne({ _id: 'gone.txt' }))?.bytesAbsentSince, STAMP, 'fixture: the pass did not stamp the record');
      assert.equal(rest.files, 2, 'the badge still counts the record the pass found without bytes');
      assert.equal(rest.filesAwaitingBytes, 1);
    });
  });

  describe('the stamp never leaves this instance', () => {
    it('the pull page a peer reads carries the row and no stamp', async () => {
      await twoAndTwo();
      // The pull pages by POSITION: a row with none is not served, whatever it carries.
      for (const [i, id] of ['ok0.txt', 'ok1.txt', 'wait0.txt', 'wait1.txt'].entries()) await rows().updateOne({ _id: id }, { $set: { pos: 1000 + i, posAtSeq: 1 } });
      const page = await acts.door.pull('/filemeta', { spaceId: S });
      const said = JSON.stringify(page);
      assert.ok(said.includes('wait0.txt') && said.includes('ok0.txt'), `fixture: the page does not serve the rows: ${said.slice(0, 300)}`);
      assert.ok(!said.includes('bytesAbsentSince'), 'the pull serve path (a denylist, LOCAL_ONLY_FIELDS) serves bytesAbsentSince: a peer would learn that THIS disk lacks the bytes and take it for the file\'s state');
    });

    it('the merkle leaf and root do not move when a row is stamped (a stamp is no difference between two instances)', async () => {
      const { docLeaf, computeMerkleRoot, forgetMerkleLeaves } = await import('../../server/dist/brain/merkle.js');
      const plain = fileRow(S, 'm.txt', { sha256: SHA_PRESENT });
      assert.equal(docLeaf('files', { ...plain, bytesAbsentSince: STAMP }), docLeaf('files', plain), 'the leaf of a stamped row differs: two instances would read a divergence');
      await rows().insertOne(plain);
      forgetMerkleLeaves(S);
      const before = await computeMerkleRoot(S);
      await rows().updateOne({ _id: 'm.txt' }, { $set: { bytesAbsentSince: STAMP } });
      forgetMerkleLeaves(S);
      assert.equal((await computeMerkleRoot(S)).root, before.root, 'the space\'s merkle root moved when a local stamp was written');
    });

    it('the arrival strips it and the sender\'s projection excludes it', async () => {
      const { LOCAL_ONLY_FIELDS, LOCAL_ONLY_EXCLUSION, stripLocalOnly } = await import('../../server/dist/sync/local-only-fields.js');
      assert.ok(LOCAL_ONLY_FIELDS.has('bytesAbsentSince'), 'bytesAbsentSince is not a local-only field: every path that derives from the set (arrival strip, pull projection, merkle blanking) carries it');
      const arrived = stripLocalOnly({ _id: 'a.txt', path: 'a.txt', bytesAbsentSince: STAMP });
      assert.equal('bytesAbsentSince' in arrived, false, 'an arriving row keeps the stamp a peer sent');
      assert.equal(LOCAL_ONLY_EXCLUSION['bytesAbsentSince'], 0, 'the sender\'s projection reads the stamp');
    });

    it('a reader of the files collection (MCP filter) is not shown the stamp', async () => {
      await twoAndTwo();
      const out = await acts.mcp('filter', { collection: 'files', limit: 100 });
      const said = `${out.text} ${JSON.stringify(out.sc)}`;
      assert.ok(said.includes('wait0.txt') || said.includes('ok0.txt'), `fixture: the filter answered no file row: ${said.slice(0, 300)}`);
      assert.ok(!said.includes('bytesAbsentSince'), 'a reader projection of a file row carries bytesAbsentSince: local bookkeeping shown to a client');
    });
  });
});
