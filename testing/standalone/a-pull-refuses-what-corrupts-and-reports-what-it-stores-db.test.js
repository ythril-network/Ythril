/**
 * A pull refuses only a document that would CORRUPT the receiver, and reports every document it stores that does not
 * match its schema (Q-225, the 5.6.x half; Q-361 item 19).
 *
 * ## The decision this test holds, and what it deliberately does not do
 *
 * A push refuses a document that fails its `Incoming*` schema (the receiver knows who sent it and answers the sender). A
 * PULL cannot tell its sender apart from what the sender's own copy was, and 5.6.3 stored what it was served. On 5.6.x
 * the owner's decision D-10 is "fixes only, nothing else", so a pull that suddenly refused documents 5.6.3 stored would be
 * a behaviour change. So on this line the pull:
 *
 *  - **refuses a shape that corrupts the receiver**: a file row whose `parentFileId` is present and not a string (it turns a
 *    file into a half-derived row the derived-row queries misread), a `_id` that is not a non-empty string, a `seq` that is
 *    not a plausible integer — skipped and counted, the position advancing past it as it does for a skipped document;
 *  - **stores everything else AS RECEIVED** — not the parse output: an extra key a peer's newer version added stays, and a
 *    document that fails its schema is stored exactly as 5.6.3 stored it;
 *  - **reports** each document it stored that failed its schema, in ONE line per page naming the count, the ids and the
 *    reasons (bounded: a peer's text is rendered through the one bounded renderer), distinct from the refused ones;
 *  - **admits a real peer's file row**: a stored file row carries the sender's local machinery (`sizeBytes`, `sha256`,
 *    `excerpt`, the vector…), which the receiver never takes from a peer; the row is admitted for its authored keys.
 *
 * ## Pins (green before the fix and held after it)
 *
 * Wrong-typed `_id` and `seq` are already refused by the writer; a schema-failing document is already stored; a file row
 * with sender machinery already lands without it; an unknown key on a file row never reaches the stored row (5.6.3
 * strips it through `fileMetaForWire`; it is not newly refused — D-10).
 *
 * Seen red on 6eb5a333 (5.6.3): a non-string `parentFileId` is stored, and a stored schema-failing document is not
 * reported anywhere.
 *
 * Run: node --test testing/standalone/a-pull-refuses-what-corrupts-and-reports-what-it-stores-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, buildOf } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'pullval';
let door;

/**
 * The family key a pull page is served under, the collection it is stored in, and the builder of a valid document — one row
 * per replicated family, read out of `REPLICATED_FAMILIES` (so a family added there is a case here, or `buildOf` throws).
 */
const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
const FAMILIES = Object.fromEntries(REPLICATED_FAMILIES.map(({ payloadKey, collection }) => [payloadKey, {
  coll: collection,
  /** A file's id is its path; every other family's is any string. */
  id: (name) => (payloadKey === 'filemeta' ? `docs/${name}.md` : name),
  make: (id, seq, x) => buildOf(payloadKey)(S, id, seq, { author: { ...PEER_AUTHOR }, ...x }),
}]));
assert.ok(Object.keys(FAMILIES).length >= 6, `only ${Object.keys(FAMILIES).length} replicated families found — the list is broken`);
const watermark = () => door.member().lastSeqReceived?.[S] ?? 0;
const storedIds = async (coll) => (await door.coll(S, coll).find({}).sort({ _id: 1 }).toArray()).map(d => d._id);
/** The lines of a sync that name `id`. */
const naming = (lines, id) => lines.filter(l => l.includes(id));
const SCHEMA_LINE = /Pull from .*'pullval': stored (\d+) document\(s\) that do not match their schema: /;

async function pull(family, docs) {
  door.state.records[S] = { [family]: docs };
  return door.logsDuring(() => door.sync());
}

describe('a pull refuses what corrupts and reports what it stores', { skip }, () => {
  before(async () => { door = await openPullDoor({ suite: 'pullval', spaces: [S] }); });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  describe('what corrupts the receiver is refused, and the position advances past it', () => {
    // One id per case: a refused id is named once per window (`refusalIsNews`), and the cases share the process.
    for (const [n, bad] of [5, 0, false, null, {}, ['x']].entries()) {
      it(`a file row whose parentFileId is ${JSON.stringify(bad)} is not stored; the rest of the page is`, async () => {
        const { lines } = await pull('filemeta', [
          FAMILIES.filemeta.make(`docs/bad-${n}.md`, 8, { parentFileId: bad }),
          FAMILIES.filemeta.make('docs/ok.md', 9),
        ]);
        assert.deepEqual(await storedIds('files'), ['docs/ok.md'], 'a corrupt parentFileId was stored, or the control was not');
        assert.ok(naming(lines, `docs/bad-${n}.md`).length >= 1, `nothing names the refused row: ${JSON.stringify(lines)}`);
        assert.ok(watermark() >= 9, `the position stayed at ${watermark()}: a refused document holds the transfer`);
      });
    }

    it('a refused document moves the position and is named once per window, not by every cycle that is offered it', async () => {
      const page = [FAMILIES.filemeta.make('docs/offered-twice.md', 12, { parentFileId: 5 })];
      const first = await pull('filemeta', page);
      assert.ok(naming(first.lines, 'docs/offered-twice.md').length >= 1, `not named the first time: ${JSON.stringify(first.lines)}`);
      assert.ok(watermark() >= 12, `the position stayed at ${watermark()}: a refused document holds the transfer`);
      const again = await pull('filemeta', page);
      assert.deepEqual(naming(again.lines, 'docs/offered-twice.md'), [], 'named again within the window');
    });

    for (const [why, doc] of [
      ['a numeric _id', { _id: 12345, spaceId: S, fact: 'x', tags: [], author: PEER_AUTHOR, seq: 7 }],
      ['a string seq', { ...build.fact(S, 'badseq', 0), seq: '7' }],
      ['a negative seq', build.fact(S, 'negseq', -1)],
      ['a fractional seq', build.fact(S, 'fracseq', 1.5)],
    ]) {
      it(`PIN ${why} is refused and the rest of the page is stored`, async () => {
        await pull('facts', [doc, FAMILIES.facts.make('ok', 9)]);
        assert.deepEqual(await storedIds('facts'), ['ok']);
        assert.ok(watermark() >= 9, `the position stayed at ${watermark()}`);
      });
    }
  });

  describe('a document that fails its schema is stored as received, and reported once per page', () => {
    for (const [family, f] of Object.entries(FAMILIES)) {
      it(`${family}: stored exactly as received, and named in the one summary line`, async () => {
        const doc = f.make(f.id('odd'), 8, { author: 'not an author block' });
        const { lines } = await pull(family, [doc, f.make(f.id('fine'), 9)]);
        const stored = await door.coll(S, f.coll).findOne({ _id: doc._id });
        assert.ok(stored, `${family}: a document 5.6.3 stored was refused`);
        assert.equal(stored.author, 'not an author block', `${family}: what was stored is not what was received`);
        const mine = lines.filter(l => SCHEMA_LINE.test(l));
        assert.equal(mine.length, 1, `${family}: expected one summary line, got ${JSON.stringify(lines)}`);
        assert.equal(SCHEMA_LINE.exec(mine[0])[1], '1', `${family}: the line does not count what it names: ${mine[0]}`);
        assert.ok(mine[0].includes(doc._id), `${family}: the line does not name the document: ${mine[0]}`);
        assert.ok(!mine[0].includes(f.id('fine')), `${family}: the line names a document that matched`);
      });
    }

    it('PIN a document that matches its schema is stored as received, with a key a newer peer added, and is not reported', async () => {
      const { lines } = await pull('facts', [FAMILIES.facts.make('extra', 8, { addedByANewerPeer: 'kept' })]);
      assert.equal((await door.coll(S, 'facts').findOne({ _id: 'extra' })).addedByANewerPeer, 'kept', 'the parse output was stored, not the document');
      assert.deepEqual(lines.filter(l => SCHEMA_LINE.test(l)), []);
    });

    it('a refused document and a stored schema-failing one are reported apart, each by its own line', async () => {
      const { lines } = await pull('filemeta', [
        FAMILIES.filemeta.make('docs/corrupt.md', 7, { parentFileId: 5 }),
        FAMILIES.filemeta.make('docs/odd.md', 8, { author: 'not an author block' }),
      ]);
      const schema = lines.filter(l => SCHEMA_LINE.test(l));
      assert.equal(schema.length, 1, JSON.stringify(lines));
      assert.ok(schema[0].includes('docs/odd.md') && !schema[0].includes('docs/corrupt.md'), `the schema line mixes the two: ${schema[0]}`);
      assert.deepEqual(await storedIds('files'), ['docs/odd.md']);
    });

    it('the line says which field failed and how, and carries none of the outside value that failed', async () => {
      const outside = `OUTSIDE-VALUE-${'x'.repeat(50_000)}`;
      const { lines } = await pull('links', [FAMILIES.links.make('docs-link', 8, { fromKind: outside })]);
      const mine = lines.filter(l => SCHEMA_LINE.test(l));
      assert.equal(mine.length, 1, JSON.stringify(lines.map(l => l.slice(0, 120))));
      assert.match(mine[0], /fromKind: [a-z_]+/, `the line does not name the failing field: ${mine[0].slice(0, 200)}`);
      assert.ok(!mine[0].includes('OUTSIDE-VALUE'), `the line carries the peer's value: ${mine[0].slice(0, 200)}`);
    });
  });

  describe('a real peer\'s file row', () => {
    it('PIN a row carrying the sender\'s own machinery is admitted for its authored keys, and none of the machinery is taken', async () => {
      const row = FAMILIES.filemeta.make('docs/real.md', 8, {
        description: 'what the author wrote', tags: ['a'],
        sizeBytes: 123456, sha256: 'a'.repeat(64), excerpt: 'the sender extracted this', chunkCount: 9, embeddingStatus: 'done',
        embedding: [0.1, 0.2], embeddingModel: 'sender-model', matchedText: 'sender text',
      });
      const { lines } = await pull('filemeta', [row]);
      const stored = await door.coll(S, 'files').findOne({ _id: 'docs/real.md' });
      assert.ok(stored, 'a real peer\'s file row was refused');
      assert.deepEqual([stored.description, stored.tags], ['what the author wrote', ['a']]);
      const taken = ['sizeBytes', 'sha256', 'excerpt', 'chunkCount', 'embeddingStatus', 'embedding', 'embeddingModel', 'matchedText'].filter(k => k in stored);
      assert.deepEqual(taken, [], 'the receiver took the sender\'s machinery for bytes it does not hold');
      assert.deepEqual(lines.filter(l => SCHEMA_LINE.test(l)), [], 'a real peer\'s row was reported as not matching its schema');
    });

    it('PIN an unknown key on a file row never reaches the stored row (stripped, as 5.6.3 strips it)', async () => {
      await pull('filemeta', [FAMILIES.filemeta.make('docs/inject.md', 8, { injectedByThePeer: 'x', $where: 'sleep(1)' })]);
      const stored = await door.coll(S, 'files').findOne({ _id: 'docs/inject.md' });
      assert.ok(stored, 'the row was not stored at all, so nothing was asserted about its keys');
      assert.deepEqual(['injectedByThePeer', '$where'].filter(k => k in stored), [], 'an undeclared key reached the stored row');
    });
  });
});