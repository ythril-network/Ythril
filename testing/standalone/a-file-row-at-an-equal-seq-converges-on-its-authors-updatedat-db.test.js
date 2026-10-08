/**
 * A file row held at the same seq as an arriving copy converges on the AUTHOR's `updatedAt`, delivered BY the author, and
 * on nobody else's (bundle-89, Q-419, the heal half; plan rev 3 §E3 items 1-4).
 *
 * ## The rule
 *
 * `updatedAt` is hashed and replicates, and an equal-seq arrival of a file's row is skipped today, so a row whose
 * `updatedAt` drifted from the author's stays different for ever (a permanent `MERKLE_DIVERGENCE`). The plan lets the
 * receiver adopt the arriving `updatedAt` at an equal seq under ONE condition:
 *
 *     the stored copy and the arriving copy have the same author (`author.instanceId` only — the hashed `author` object
 *     also carries a mutable `instanceLabel`), the same authored content, THE DELIVERER IS THAT AUTHOR, and the author is
 *     not this instance.
 *
 * A relay serves ITS OWN stored value with the author field intact, so a non-author that adopted whatever arrived would
 * flip a, b, a, b between the author and a drifted relay — each flip a write, a divergence and a re-arm. Only the
 * author's own delivery is the author's value, and the author's own row is never adopted over.
 *
 * ## How it is asserted (pitfall-shape-gate-passes-a-wrong-rule)
 *
 * A row asserting "a verdict exists" would pass a wrong rule. So the TRUTH TABLE is GENERATED from its axes and every row is
 * decided by ONE independent predicate (`mustAdopt`, written from the sentence above and reading only the documents), then
 * driven through the real push door with a token that proves the deliverer. A wrong decision in ANY row fails, and the failure
 * names the row:
 *
 *   - deliverer: the author / a relay / a stranger / nobody (an admin token)
 *   - author: the same peer on both sides / this instance on both / a different stored author / none stored
 *   - content: identical / property key order / the stored row's local-only fields / author label only / one row per
 *     key of `FILE_HASH_PROJECTION` that differs (DERIVED from it, so a hashed key added later needs a variant here)
 *   - arriving `updatedAt`: earlier than the stored one / later
 *
 * and on every row the whole stored document is compared, so "writes `updatedAt` only" is asserted with it: seq, author,
 * deliveredBy and every local-only field stay as they were. A second table runs the same rule through the real PULL
 * (the member the cycle read from is the deliverer), because one rule with two doors is the defect class this repo makes.
 *
 * ## The content comparison
 *
 * `docLeaf` hashes `_id`, `seq` and `canonicalDocHash(doc)`, and `FILE_HASH_PROJECTION` INCLUDES `updatedAt` — so two rows
 * that differ only in `updatedAt` never compare equal through it, which is the pair the verdict must recognise. The rows
 * that decide it: stored local-only fields (`sizeBytes`, `sha256`, `excerpt`, ...) must not make the content differ, and a
 * differing hashed key must.
 *
 * ## The write guard
 *
 * The converge write stamps no seq (the counter is untouched), writes `updatedAt` only, does not rewrite `deliveredBy`,
 * never reaches `landed` (no embed job is queued per converged row, with a control that a newer arrival DOES queue one),
 * and carries the planned seq, the author, the stored `updatedAt` and `deletedAt` absent in its filter: each is raced by
 * changing the stored row between the plan and the write, with the write parked.
 *
 * ## Seen red
 *
 * On the base (429e6d25) every adopt row and every guard row fails: an equal-seq arrival is skipped, so the stored
 * `updatedAt` never moves. The rows that expect NO adoption pass on the base, so they were seen red under DELIBERATELY WRONG
 * branches patched into the (gitignored) built server, and the file was seen GREEN under a reference branch (27 of 27):
 *   - every deliverer adopts (rev 2's rule)       -> the truth table (56 rows), the relay orders, every hostile row, the pull rows;
 *   - no content comparison                       -> the truth table (14 rows: each differing hashed key);
 *   - content compared over the whole stored row  -> the truth table and every adopt-dependent case (local-only fields differ);
 *   - no "the author is not this instance" check  -> the truth table (8 rows) and the claims-this-instance case;
 *   - no ISO / length validation                  -> the six hostile-text cases;
 *   - no write filter / each clause dropped alone -> its own race case (updatedAt, seq, author, deletedAt), nothing else;
 *   - the write also sets deliveredBy / queues an embed job -> the converge-write case;
 *   - the LAST of two equal-seq copies wins       -> the page-collapse case.
 *
 * Run: node --test testing/standalone/a-file-row-at-an-equal-seq-converges-on-its-authors-updatedat-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'convergence';
const AUTHOR = Object.freeze({ instanceId: 'conv-author', instanceLabel: 'The author' });
const OTHER_AUTHOR = Object.freeze({ instanceId: 'conv-other-author', instanceLabel: 'Another author' });
const RELAY = 'conv-relay';
const STRANGER = 'conv-stranger';

/** All in the past, so "now" and "the future" cannot be confused with any of them. */
const CREATED_AT = '2026-08-01T00:00:00.000Z';
const STORED_AT = '2026-10-01T00:00:00.000Z';
const EARLIER = '2026-09-01T00:00:00.000Z';
const LATER = '2026-10-05T00:00:00.000Z';
const SEQ = 5;

let door, park, LOCAL_AUTHOR, FILE_HASH_PROJECTION;
let n = 0;
const files = () => door.coll(S, 'files');
const freshId = (tag) => `conv/${tag}-${++n}.md`;

/** What the receiver holds: the authored half and its own machinery (the bytes' size and hash, an excerpt, a delivery stamp). */
const storedRow = (id, extra = {}) => ({
  _id: id, spaceId: S, path: id, tags: ['t'], description: 'd', properties: { a: 1, b: 2 }, createdAt: CREATED_AT,
  updatedAt: STORED_AT, seq: SEQ, author: AUTHOR, deliveredBy: AUTHOR.instanceId, sizeBytes: 11, sha256: 'a'.repeat(64),
  excerpt: 'the opening prose', embeddingStatus: 'complete', ...extra,
});
/** What arrives: the wire shape only. */
const arrivingDoc = (id, extra = {}) => build.filemeta(S, id, SEQ, {
  tags: ['t'], description: 'd', properties: { a: 1, b: 2 }, createdAt: CREATED_AT, updatedAt: LATER, author: AUTHOR, ...extra,
});

const tokenOf = (who, arriving) => ({
  author: () => peerToken(arriving.author.instanceId), relay: () => peerToken(RELAY),
  stranger: () => peerToken(STRANGER), nobody: () => ADMIN_TOKEN,
})[who]();
/** The peer id a deliverer proves, or undefined. */
const provenId = (who, arriving) => ({ author: arriving.author?.instanceId, relay: RELAY, stranger: STRANGER, nobody: undefined })[who];

/**
 * THE RULE, once, from the documents alone: adopt the arriving `updatedAt` iff the deliverer proves it is the author named on
 * BOTH copies, that author is not this instance, the authored content is equal, and the instants differ. Written without
 * reference to how the table was generated, so a row's expectation cannot be read off the row's own label.
 */
function mustAdopt({ stored, arriving, deliverer, contentEqual }) {
  const proven = provenId(deliverer, arriving);
  const author = arriving.author?.instanceId;
  return proven !== undefined && proven === author
    && stored.author?.instanceId === author
    && author !== LOCAL_AUTHOR.instanceId
    && contentEqual
    && arriving.updatedAt !== stored.updatedAt;
}

const AUTHORSHIP = [
  { name: 'the same peer wrote both copies', stored: AUTHOR, arriving: AUTHOR },
  { name: 'this instance wrote both copies', stored: () => LOCAL_AUTHOR, arriving: () => LOCAL_AUTHOR },
  { name: 'the stored copy has another author', stored: OTHER_AUTHOR, arriving: AUTHOR },
  { name: 'the stored copy has no author', stored: undefined, arriving: AUTHOR },
];
const DELIVERERS = ['author', 'relay', 'stranger', 'nobody'];
const INSTANTS = [['earlier than the stored one', EARLIER], ['later than the stored one', LATER]];

/** Content variants that stay EQUAL after the hash projection with `updatedAt` blanked. */
const EQUAL_CONTENT = [
  { name: 'identical content', stored: {}, arriving: {} },
  { name: 'property keys in another order', stored: { properties: { a: 1, b: 2 } }, arriving: { properties: { b: 2, a: 1 } } },
  { name: 'the stored row carries local-only fields the wire never has', stored: { sizeBytes: 99, sha256: 'b'.repeat(64), excerpt: 'x', embeddingStatus: 'failed', syncBase: 'z' }, arriving: {} },
  { name: 'only the author\'s label differs', stored: {}, arriving: (a) => ({ author: { instanceId: a.instanceId, instanceLabel: 'Renamed since' } }) },
];

/** One variant per key of the hash projection, other than the ones the table's axes already vary: each is DIFFERENT content. */
const DIFFERENT_CONTENT = {
  path: (id) => ({ path: `${id}.elsewhere` }),
  description: () => ({ description: 'a different description' }),
  descriptionSource: () => ({ descriptionSource: 'generated' }),
  tags: () => ({ tags: ['t', 'u'] }),
  properties: () => ({ properties: { a: 1, b: 3 } }),
  suppressEmbeddings: () => ({ suppressEmbeddings: true }),
  createdAt: () => ({ createdAt: '2026-08-02T00:00:00.000Z' }),
};
const VARIED_ELSEWHERE = ['_id', 'author', 'updatedAt', 'seq'];

/** Every row of the table, generated: `{ name, seed, doc, deliverer, contentEqual }`. */
function tableRows() {
  const rows = [];
  const add = (authorship, deliverer, contentName, contentEqual, instant, storedExtra, arrivingExtra) => {
    const id = freshId('row');
    const resolve = (a) => (typeof a === 'function' ? a() : a);
    const storedAuthor = resolve(authorship.stored);
    const arrivingAuthor = resolve(authorship.arriving);
    const stored = storedRow(id, { ...(storedAuthor ? { author: storedAuthor } : {}), ...storedExtra });
    if (!storedAuthor) delete stored.author;
    const arriving = arrivingDoc(id, { author: arrivingAuthor, updatedAt: instant[1], ...arrivingExtra(id, arrivingAuthor) });
    rows.push({
      name: `${authorship.name}; delivered by ${deliverer}; ${contentName}; arriving updatedAt ${instant[0]}`,
      stored, arriving, deliverer, contentEqual,
    });
  };
  for (const authorship of AUTHORSHIP) {
    for (const deliverer of DELIVERERS) {
      for (const instant of INSTANTS) {
        for (const c of EQUAL_CONTENT) {
          add(authorship, deliverer, c.name, true, instant, c.stored, (id, a) => (typeof c.arriving === 'function' ? c.arriving(a) : c.arriving));
        }
      }
    }
  }
  // Differing content is asked of the one row that WOULD adopt were the content equal: the others decide "no" whatever it says.
  for (const key of Object.keys(FILE_HASH_PROJECTION).filter(k => !VARIED_ELSEWHERE.includes(k))) {
    const make = DIFFERENT_CONTENT[key];
    assert.ok(make, `FILE_HASH_PROJECTION hashes '${key}' and this table has no DIFFERENT-content variant for it: add one, or the key is unchecked`);
    for (const instant of INSTANTS) add(AUTHORSHIP[0], 'author', `only '${key}' differs`, false, instant, {}, (id) => make(id));
  }
  return rows;
}

/** Push one page through the real batch door as `token`, answering 200. */
async function pushAs(token, docs) {
  const r = await door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  await door.settled();
}
const read = (id) => files().findOne({ _id: id });

describe('an equal-seq file row converges on its author\'s updatedAt (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b89_e35_conv', spaces: [S] });
    LOCAL_AUTHOR = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
    ({ FILE_HASH_PROJECTION } = await import('../../server/dist/brain/merkle.js'));
    park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
  });
  after(async () => {
    park?.restore();
    await door?.close();
  });
  beforeEach(async () => { await door.reset(); });

  it('the table is derived: it has adopt rows AND refuse rows, and a variant for every hashed key', () => {
    assert.ok(Object.keys(FILE_HASH_PROJECTION).length >= 8, 'FILE_HASH_PROJECTION is empty or tiny — re-anchor');
    const rows = tableRows();
    const adopt = rows.filter(r => mustAdopt(r));
    assert.ok(adopt.length > 0, 'no row expects an adoption, so a rule that never adopts would pass');
    assert.ok(rows.length - adopt.length > adopt.length, 'fewer refuse rows than adopt rows, so a rule that always adopts would barely fail');
    assert.ok(rows.every(r => ['author', 'relay', 'stranger', 'nobody'].includes(r.deliverer)));
  });

  it('every row of the truth table, through the push door: adopt exactly when the rule says, and write nothing else', async () => {
    const wrong = [];
    const rows = tableRows();
    for (const row of rows) {
      await files().insertOne(row.stored);
      await pushAs(tokenOf(row.deliverer, row.arriving), [row.arriving]);
      const after = await read(row.stored._id);
      const want = mustAdopt(row) ? { ...row.stored, updatedAt: row.arriving.updatedAt } : row.stored;
      try { assert.deepStrictEqual(after, want); } catch {
        wrong.push(`${row.name}: want updatedAt ${want.updatedAt} (${mustAdopt(row) ? 'adopt' : 'keep'}), stored is ${JSON.stringify(after)}`);
      }
      await files().deleteOne({ _id: row.stored._id });
    }
    assert.deepEqual(wrong, [], `${wrong.length} of ${rows.length} rows decided wrongly`);
  });

  describe('both orders reach the author\'s value, and the result is a fixed point', () => {
    const RELAYS = { stored: STORED_AT, author: EARLIER, relay: LATER };
    const SEQUENCES = [['author', 'relay'], ['relay', 'author'], ['author', 'relay', 'author'], ['relay', 'author', 'relay', 'author'], ['author', 'author']];
    for (const order of SEQUENCES) {
      it(`delivered in the order: ${order.join(', ')}`, async () => {
        const id = freshId('order');
        await files().insertOne(storedRow(id, { updatedAt: RELAYS.stored, deliveredBy: RELAY }));
        for (const who of order) {
          // The author serves its own value; a relay serves ITS stored value with the author field intact.
          const arriving = arrivingDoc(id, { updatedAt: who === 'author' ? RELAYS.author : RELAYS.relay });
          await pushAs(who === 'author' ? peerToken(AUTHOR.instanceId) : peerToken(RELAY), [arriving]);
        }
        assert.equal((await read(id)).updatedAt, RELAYS.author,
          `after ${order.join(', ')} the row holds ${(await read(id)).updatedAt}, not the author's ${RELAYS.author}`);
      });
    }

    it('once converged, the author delivering again changes nothing at all', async () => {
      const id = freshId('fixed-point');
      await files().insertOne(storedRow(id, { updatedAt: STORED_AT }));
      await pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: EARLIER })]);
      const first = await read(id);
      assert.equal(first.updatedAt, EARLIER, 'the first delivery did not converge the row');
      await pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: EARLIER })]);
      assert.deepStrictEqual(await read(id), first);
    });

    it('two equal-seq copies of one id in one page collapse to the EARLIER copy before the verdict', async () => {
      const id = freshId('collapse');
      await files().insertOne(storedRow(id, { updatedAt: STORED_AT }));
      await pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: LATER }), arrivingDoc(id, { updatedAt: EARLIER })]);
      assert.equal((await read(id)).updatedAt, LATER, 'the page\'s first copy stands at an equal seq, as the one accept rule reads a page');
    });
  });

  describe('the converge write', () => {
    it('stamps no seq, rewrites no deliverer, queues no embed job, and writes updatedAt only', async () => {
      const id = freshId('write');
      const jobs = () => door.coll(S, 'embed_jobs').find({ recordId: id }).toArray();
      await door.setCounter(S, 100);
      await files().insertOne(storedRow(id, { updatedAt: STORED_AT, deliveredBy: 'the-earlier-deliverer' }));

      // The control, FIRST: a NEWER arrival of this very file queues a job, so "no job" below cannot be a query that looks elsewhere.
      await pushAs(peerToken(AUTHOR.instanceId), [{ ...arrivingDoc(id, { updatedAt: LATER }), seq: SEQ + 1 }]);
      assert.deepEqual((await jobs()).map(j => j.recordId), [id], 'control: a newer arrival queued no embed job, so the check below proves nothing');
      await door.coll(S, 'embed_jobs').deleteMany({});
      await files().replaceOne({ _id: id }, storedRow(id, { updatedAt: STORED_AT, deliveredBy: 'the-earlier-deliverer' }));
      await door.setCounter(S, 100);

      await pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: EARLIER })]);
      const after = await read(id);
      assert.equal(after.updatedAt, EARLIER, 'the author\'s delivery did not converge the row');
      assert.equal(after.seq, SEQ, 'the converge write stamped a seq');
      assert.equal(after.deliveredBy, 'the-earlier-deliverer', 'the converge write rewrote who delivered the version');
      assert.equal(await door.counter(S), 100, 'the converge write moved the space counter: it is no authored write');
      assert.deepEqual((await jobs()).map(j => j.recordId), [], 'a converged row was queued for embedding: it never reaches `landed`');
    });

    /** Race: the stored row changes AFTER the plan read it and BEFORE the write, with the write parked. */
    const RACES = [
      ['its updatedAt changed (another converge or an edit)', { updatedAt: '2026-10-02T00:00:00.000Z' }, 'updatedAt'],
      ['its seq rose (a newer version landed)', { seq: 50 }, 'seq'],
      ['its author changed', { author: OTHER_AUTHOR }, 'author'],
      ['it was soft-deleted (deletedAt set)', { deletedAt: '2026-10-03T00:00:00.000Z' }, 'deletedAt'],
    ];
    for (const [what, mutation, field] of RACES) {
      it(`does not overwrite the row when ${what} between the plan and the write`, async () => {
        const id = freshId('race');
        await files().insertOne(storedRow(id, { updatedAt: STORED_AT }));
        const held = park.arm(`${S}_files`);
        const run = pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: EARLIER })]);
        const intercepted = (await Promise.race([held.reached.then(() => true), run.then(() => false)])) === true;
        if (intercepted) await files().updateOne({ _id: id }, { $set: mutation });
        held.release();
        await run;
        assert.ok(intercepted, 'the writer made no write to the files collection for an equal-seq arrival of the author, so there was nothing to race: no converge write exists');
        const now = await read(id);
        assert.deepEqual(now[field], mutation[field], `the converge write clobbered the row's ${field}`);
        if (field !== 'updatedAt') assert.equal(now.updatedAt, STORED_AT, `the converge write landed on a row whose ${field} had changed`);
        else assert.equal(now.updatedAt, mutation.updatedAt, 'the converge write overwrote an updatedAt it had not read');
      });
    }

    it('refuses a row this instance flagged deleted, though the author delivers it', async () => {
      const id = freshId('flagged');
      await files().insertOne(storedRow(id, { deletedAt: '2026-10-03T00:00:00.000Z' }));
      await pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: EARLIER })]);
      assert.equal((await read(id)).updatedAt, STORED_AT);
    });
  });

  describe('hostile updatedAt text from a deliverer (it is a peer\'s string, and the verdict is a new write power)', () => {
    const LONG = '2026-09-01T00:00:00.000Z'.padEnd(200_000, '0');
    const HOSTILE = [
      ['non-ISO text', 'last tuesday'], ['a very long string', LONG], ['a non-comparable ISO spelling', '2026-09-01T00:00:00+02:00'],
      ['a date without the fixed-width Z form', '2026-09-01'], ['an object-shaped string', '{"$gt":""}'], ['the empty string', ''],
    ];
    for (const [what, text] of HOSTILE) {
      it(`the AUTHOR delivering ${what} does not become the stored updatedAt`, async () => {
        const id = freshId('hostile');
        await files().insertOne(storedRow(id, { updatedAt: STORED_AT }));
        await pushAs(peerToken(AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: text })]);
        const now = await read(id);
        assert.equal(now.updatedAt, STORED_AT, `a stored updatedAt of ${String(now.updatedAt).slice(0, 40)} (${String(now.updatedAt).length} chars) was adopted from ${what}`);
      });
    }

    it('a FUTURE date from a deliverer that is not the author is not adopted', async () => {
      const id = freshId('future');
      await files().insertOne(storedRow(id, { updatedAt: STORED_AT }));
      await pushAs(peerToken(RELAY), [arrivingDoc(id, { updatedAt: '2999-01-01T00:00:00.000Z' })]);
      assert.equal((await read(id)).updatedAt, STORED_AT);
    });

    it('a forged author — the relay names the author on the document — is not the author', async () => {
      const id = freshId('forged');
      await files().insertOne(storedRow(id, { updatedAt: STORED_AT }));
      await pushAs(peerToken('conv-attacker'), [arrivingDoc(id, { updatedAt: EARLIER, author: AUTHOR })]);
      assert.equal((await read(id)).updatedAt, STORED_AT, 'a deliverer adopted by NAMING the author in the document: the author field is the sender\'s text');
    });

    it('a deliverer that claims THIS instance as author converges nothing and writes nothing', async () => {
      const id = freshId('claims-local');
      await files().insertOne(storedRow(id, { author: LOCAL_AUTHOR, updatedAt: STORED_AT }));
      await pushAs(peerToken(LOCAL_AUTHOR.instanceId), [arrivingDoc(id, { updatedAt: EARLIER, author: LOCAL_AUTHOR })]);
      assert.equal((await read(id)).updatedAt, STORED_AT, 'a peer presenting this instance\'s id made the author adopt');
    });
  });

  describe('the same rule through the PULL (the member the cycle read from is the deliverer)', () => {
    // `THIS_INSTANCE` is resolved when the case runs: the door's own instance id is known only once it is open.
    const THIS_INSTANCE = Symbol('this instance');
    const PULL_ROWS = [
      ['the pulled-from member is the author of both copies', PEER_AUTHOR, true],
      ['the pulled-from member relays a third author\'s row', AUTHOR, false],
      ['this instance is the author, and the member relays it back', THIS_INSTANCE, false],
    ];
    for (const [what, who, adopts] of PULL_ROWS) {
      it(what, async () => {
        const id = freshId('pull');
        const author = who === THIS_INSTANCE ? LOCAL_AUTHOR : who;
        await files().insertOne(storedRow(id, { author, deliveredBy: PEER, updatedAt: STORED_AT }));
        door.state.records[S] = { filemeta: [arrivingDoc(id, { author, updatedAt: EARLIER })] };
        await door.sync();
        assert.equal((await read(id)).updatedAt, adopts ? EARLIER : STORED_AT,
          adopts ? 'the author\'s own pull did not converge the row' : 'a pull adopted a value from a deliverer that is not the author');
      });
    }
  });
});
