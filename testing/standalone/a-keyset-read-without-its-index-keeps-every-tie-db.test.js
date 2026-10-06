/**
 * A seq-keyset read answers in `(seq, _id)` order, every record exactly once, even while its collection's compound index is
 * still being built (bundle-52 pre-ship sweep).
 *
 * ## The defect this holds closed
 *
 * The compound `{ seq: 1, _id: 1 }` is built in the background after the first start, so for a while a collection has only
 * `{ seq: 1 }`. The read's fallback for that window read by seq alone, strictly above, while the routes went on handing out a
 * pair cursor (seq and record) that the client trusts — so the next page skipped the rest of a run of equal seqs, and the
 * tombstone transfer, which was tie-safe before the bundle, lost deletions during the build.
 *
 * ## The rule
 *
 * For every page size, paging a collection by the cursor each page ends at returns every record exactly once, in
 * `(seq, _id)` order, whether the compound exists or not — over every part that carries a seq (derived from
 * `SEQ_KEYSET_INDEXES`, floor 6).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-keyset-read-without-its-index-keeps-every-tie-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'keysetnoidx';
/** Runs of up to five records at one seq, with ids in an order the insertion does not follow, so arrival order is not the answer. */
const SEED = Array.from({ length: 23 }, (_, i) => ({ id: `r-${'zyxwvutsrqponmlkjihgfedcba'[i]}`, seq: 1 + Math.floor(i / 5) }));
const PAGE_SIZES = [1, 2, 3, 4, 5, 7, 50];

let door, mongo, keyset;
const coll = (part) => mongo.col(`${S}_${part}`);
const byPosition = (a, b) => a.seq - b.seq || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));

describe('a keyset read without its index keeps every tie', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'keysetnoidx', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    mongo = door.mongo;
    keyset = await import('../../server/dist/util/seq-keyset.js');
  });
  after(async () => { await door?.close(); });

  it('derives the parts that carry a seq, so an empty set cannot pass', () => {
    const parts = [...new Set(keyset.SEQ_KEYSET_INDEXES.map(ix => ix.part))];
    assert.ok(parts.length >= 6, `only ${parts.length} parts carry a keyset index`);
  });

  for (const ready of [false, true]) {
    it(`pages every record once, in (seq, _id) order, ${ready ? 'with' : 'WITHOUT'} the compound`, async () => {
      const parts = [...new Set(keyset.SEQ_KEYSET_INDEXES.map(ix => ix.part))];
      for (const part of parts) {
        const c = coll(part);
        await c.deleteMany({});
        await c.insertMany(SEED.map(r => ({ _id: r.id, spaceId: S, seq: r.seq, type: 'fact', from: `f-${r.id}`, to: `t-${r.id}`, label: 'rel' })));
        const indexes = (await c.listIndexes().toArray()).map(ix => ix.name).filter(n => n !== '_id_');
        for (const name of indexes) await c.dropIndex(name);
        await c.createIndex(ready ? { seq: 1, _id: 1 } : { seq: 1 });
        keyset.forgetKeysetReadiness();
        const want = [...SEED].sort(byPosition).map(r => r.id);
        for (const size of PAGE_SIZES) {
          const got = [];
          let after = { seq: 0 };
          for (let guard = 0; guard < 100; guard++) {
            const page = await keyset.readAfterSeq(S, part, after, { limit: size });
            if (page.length === 0) break;
            got.push(...page.map(d => d._id));
            const last = page[page.length - 1];
            after = { seq: last.seq, id: last._id };
          }
          assert.deepEqual(got, want, `${part}, page size ${size}, ${ready ? 'with' : 'without'} the compound`);
        }
      }
    });
  }
});
