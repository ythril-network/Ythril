/**
 * The change feed refuses what it cannot serve, the same way on both doors, and answers each refusal without telling the caller
 * anything it was not allowed to know (bundle-255; plan `design-final.md` item 4 "Rights", vet-returns challenge 5, vet-privacy, vet-returns
 * security and testing).
 *
 * ## The rule
 *
 * Every refusal below is answered on BOTH doors (`GET /api/files/:spaceId/changes` and the tool `file_changes`), and the same read made by
 * a caller who may make it (the control in each case) is served, so a refusal is never a build that has no feed:
 *
 *  1. A VIEW id is refused with the same not-found an unknown space gets (one cursor cannot cover several spaces' streams, and a
 *     different answer would say which ids are views: no existence oracle).
 *  2. A token without files read on the space is refused.
 *  3. A PEER-bound token is refused: a peer reads deletions as tombstones on its own protocol, so the feed's deletion paths reach
 *     clients only.
 *  4. A forged cursor (not ours, malformed, a query operator) is refused `400` and is never a `cursor_expired`.
 *  5. A cursor minted for another space is refused: a position is only meaningful in the stream it came from.
 *  6. A `prefix` is text, never a pattern: regex metacharacters match only themselves, and none makes the read fail.
 *  7. `limit` is bounded: zero, negative and past-the-maximum are refused `400`, a valid one is served.
 *
 * Database `ythril_harness_frefuse`.
 *
 * Red on d9e2738d: the route answers 404 for everyone and the tool is unknown, so each control fails with "the feed is not served".
 *
 * Run: node --test testing/standalone/the-file-change-feed-refuses-what-it-cannot-serve-db.test.js
 * (requires the harness Mongo and a prior `npm run build -w server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFeedDoors, DOORS, pathsOf } from './_file-change-feed.mjs';
import { viewOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const S = 'frefuse';
const OTHER = 'frefuse-other';
const enc = encodeURIComponent;

let d, meta, readers, noFiles, peer, operatorWithPeerRights;

/** The REST status of a refusal, or null on MCP (its failure is `isError`). */
const refused = (a, via, what) => {
  assert.ok(a.failed, `${via}: ${what} was served: ${JSON.stringify(a.body)?.slice(0, 160)}`);
  return via === 'REST' ? a.status : null;
};
/** An answer's text with a caller-chosen id made anonymous, so two refusals can be compared for being the same sentence. */
const anon = (text, id) => String(text).split(id).join('<id>');

describe('the file change feed refuses what it cannot serve (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openFeedDoors({ suite: 'frefuse', spaces: [S, OTHER] });
    meta = await import('../../server/dist/files/file-meta.js');
    readers = await d.mint('feed-reader', { [S]: d.row({ files: 'read' }) });
    noFiles = await d.mint('feed-no-files', { [S]: d.row({ knowledge: 'read' }) });
    peer = await d.mint('feed-peer', { [S]: d.row({ files: 'read', knowledge: 'read' }) }, { peerInstanceId: 'frefuse-peer-instance' });
    operatorWithPeerRights = await d.mint('feed-operator', { [S]: d.row({ files: 'read', knowledge: 'read' }) });
    await meta.upsertFileMeta(S, 'seed/one.md', 5);
    await meta.upsertFileMeta(OTHER, 'seed/other.md', 5);
  });
  after(async () => { await d?.close(); });

  for (const via of DOORS) {
    it(`${via}: control: a token with files read on the space is served`, async () => {
      const body = await d.page(via, { space: S }, readers.key);
      assert.ok(pathsOf(body.items).includes('seed/one.md'));
    });

    it(`${via}: a view id answers the same not-found as an unknown space, and a real space is served beside it`, async () => {
      await d.page(via, { space: S });   // control
      const created = await d.rest(d.admin.key, 'POST', '/api/views', { name: `frefuse-view-${via.toLowerCase()}`, members: [S] });
      assert.equal(created.status, 201, `fixture: the view was not created: ${created.text.slice(0, 200)}`);
      const id = viewOf(created).id;
      assert.match(id, /^@/);
      const asView = await d.read(via, { space: id });
      const asUnknown = await d.read(via, { space: 'frefuse-no-such-space' });
      const viewStatus = refused(asView, via, 'a view id');
      const unknownStatus = refused(asUnknown, via, 'an unknown space');
      assert.equal(viewStatus, unknownStatus, `${via}: a view id answered ${viewStatus} and an unknown space ${unknownStatus}: an existence oracle`);
      if (via === 'REST') assert.equal(viewStatus, 404);
      assert.equal(anon(asView.error || asView.text, id), anon(asUnknown.error || asUnknown.text, 'frefuse-no-such-space'),
        `${via}: the view's refusal is not the unknown space's sentence`);
    });

    it(`${via}: a token without files read is refused, and one with it is served`, async () => {
      await d.page(via, { space: S }, readers.key);   // control
      const status = refused(await d.read(via, { space: S }, noFiles.key), via, 'a token without files read');
      if (via === 'REST') assert.equal(status, 403);
    });

    it(`${via}: a peer-bound token is refused, and an operator token with the same rights is served`, async () => {
      await d.page(via, { space: S }, operatorWithPeerRights.key);   // control
      const status = refused(await d.read(via, { space: S }, peer.key), via, 'a peer-bound token');
      if (via === 'REST') assert.equal(status, 403);
    });

    it(`${via}: a forged cursor is refused 400 and is never a cursor_expired`, async () => {
      await d.page(via, { space: S });   // control
      const notNumber = `p1.${Buffer.from('notanumber:x').toString('base64url')}`;
      for (const cursor of ['garbage', 'p1.', 'p1.!!!', notNumber]) {
        const a = await d.read(via, { space: S, cursor });
        const status = refused(a, via, `the forged cursor ${JSON.stringify(cursor)}`);
        if (via === 'REST') assert.equal(status, 400, `REST: the forged cursor ${JSON.stringify(cursor)} answered ${status}`);
        assert.notEqual(a.code, 'cursor_expired', `${via}: a forged cursor ${JSON.stringify(cursor)} was called expired: a client would re-list instead of stopping`);
      }
    });

    it(`${via}: a cursor minted for another space is refused`, async () => {
      await d.page(via, { space: S });   // control
      const foreign = (await d.drain(via, { space: OTHER })).cursor;
      assert.equal(typeof foreign, 'string', 'fixture: the other space gave no cursor');
      const status = refused(await d.read(via, { space: S, cursor: foreign }), via, 'a cursor from another space');
      if (via === 'REST') assert.equal(status, 400);
    });

    it(`${via}: a prefix is text: regex metacharacters match only themselves and none fails the read`, async () => {
      const dirs = ['a.b', 'aXb', 'a+b', '(c)', '[d]', 'a|b', 'x$', '^y', 'e*'];
      for (const dir of dirs) await meta.upsertFileMeta(S, `meta-${via}/${dir}/f.md`, 5);
      for (const dir of dirs) {
        const r = await d.drain(via, { space: S, prefix: `meta-${via}/${dir}/` });
        assert.deepEqual(pathsOf(r.items), [`meta-${via}/${dir}/f.md`], `${via}: the prefix ${JSON.stringify(dir)} matched ${JSON.stringify(pathsOf(r.items))}`);
      }
      for (const broken of ['(', '[', '\\', '*', '+']) {
        const a = await d.read(via, { space: S, prefix: broken });
        assert.ok(!a.failed, `${via}: the prefix ${JSON.stringify(broken)} failed the read (${a.status ?? 'tool error'}): a pattern, not text`);
        assert.deepEqual(a.body.items, [], `${via}: the prefix ${JSON.stringify(broken)} matched files`);
      }
    });

    it(`${via}: limit is bounded: zero, negative and past the maximum are refused 400; one is served`, async () => {
      const one = await d.page(via, { space: S, limit: 1 });
      assert.ok(one.items.length <= 1);
      for (const limit of [0, -5, 1_000_000_000]) {
        const status = refused(await d.read(via, { space: S, limit }), via, `limit ${limit}`);
        if (via === 'REST') assert.equal(status, 400, `REST: limit ${limit} answered ${status}`);
      }
    });
  }

  it('REST: a cursor sent as a query operator (cursor[$ne]=x) is refused 400', async () => {
    await d.page('REST', { space: S });   // control
    const a = await d.rest(d.admin.key, 'GET', `/api/files/${enc(S)}/changes?cursor[$ne]=x`);
    assert.equal(a.status, 400, `a cursor operator answered ${a.status}: ${a.text.slice(0, 200)}`);
  });
});
