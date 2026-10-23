/**
 * The contradiction sweep judges the SEED's claims, read from its collection — `Q-442` round 5, bundle-101 verify drive.
 *
 * ## The defect it prevents
 *
 * `evalRecord` judged each neighbour against the seed, and read the claims of a fact or entity from the recall result's
 * `properties`. The seed is `findSimilar`'s `source`, which `getEntryEmbedding` reads with a projection that has no
 * `properties` — so the seed was judged with no claims at all, and the structured pass could never find a fact or entity
 * conflict. Observed on a drive: two facts differing only in `properties.port`, similarity 0.99, gave 0 candidates, while a
 * chrono pair (whose claims were already read from the collection) was found.
 *
 * ## What is held
 *
 * For a fact pair and an entity pair, a `findSimilar` that answers exactly as the real one does — a `source` without
 * `properties`, a neighbour with them — still yields the structured candidate, because the seed's claims come from the
 * collection. The public `similar` answer is not touched: the seam is `evalRecord`'s last parameter, defaulting to the real
 * `findSimilar`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-contradiction-scan-judges-the-seeds-own-claims-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';

const skip = await mongoSkipReason();
const SPACE = 'q442-scan-seed';
/** A space whose facts collection is a view whose reads fail, for the claims read that must not be settled as no-conflict. */
const READ_FAILS = 'q442-scan-readfail';

/** Each kind, with its collection, its builder, and the recall-result fields `findSimilar` hands back for it. */
const KINDS = {
  fact: { coll: 'facts', make: build.fact, text: (id) => ({ fact: `fact ${id}` }) },
  entity: { coll: 'entities', make: build.entity, text: (id) => ({ name: `entity ${id}` }) },
};

describe('the contradiction sweep judges the seed by its own stored claims', { skip }, () => {
  let door; let evalRecord;

  before(async () => {
    door = await openPushDoor({ suite: 'q442scanseed', spaces: [{ id: SPACE, label: 'scan seed', folders: [] }, { id: READ_FAILS, label: 'claims read fails', folders: [] }] });
    ({ evalRecord } = await import('../../server/dist/brain/contradiction-scanner.js'));
  });
  after(async () => { await door?.close(); });

  for (const [kind, k] of Object.entries(KINDS)) {
    it(`a ${kind} pair that differs only in one property is found, though the seed's recall source carries no properties`, { timeout: 60_000 }, async () => {
      const seed = `${kind}-seed`; const other = `${kind}-other`;
      await door.coll(SPACE, k.coll).insertOne(k.make(SPACE, seed, 10, { properties: { port: 8080 }, ...(kind === 'entity' ? { type: 'service' } : {}) }));
      await door.coll(SPACE, k.coll).insertOne(k.make(SPACE, other, 11, { properties: { port: 9090 }, ...(kind === 'entity' ? { type: 'service' } : {}) }));
      // As the real `findSimilar` answers: the source from `getEntryEmbedding`'s projection (no `properties`), the neighbour as
      // a recall result (with them).
      const similar = async () => ({
        source: { _id: seed, type: kind, spaceId: SPACE, seq: 10, ...k.text(seed) },
        results: [{ _id: other, type: kind, spaceId: SPACE, seq: 11, score: 0.99, properties: { port: 9090 }, ...k.text(other) }],
      });
      const out = await evalRecord(SPACE, kind, seed, 'structured', 0.9, undefined, similar);
      assert.equal(out.found, 1, `a ${kind} pair disagreeing on port was not found: ${JSON.stringify(out)}`);
      const cand = await door.coll(SPACE, 'contradiction_candidates').findOne({ type: kind });
      assert.equal(cand?.basis, 'structured-field', `no structured candidate stored for the ${kind} pair: ${JSON.stringify(cand)}`);
      assert.ok(cand.fields?.some(f => f.key === 'port'), `the candidate does not name the field: ${JSON.stringify(cand.fields)}`);
    });
  }

  /*
   * Round 6: a claims read that FAILS used to be swallowed (`fetchStructuredClaims` is best-effort), so the seed was judged with
   * no claims, its pairs settled as no-conflict, and the sweep moved on as if the pair had been checked. It must reach the
   * caller instead: `scanSpace`'s per-seed catch skips the seed this sweep and reports it, and the next full pass judges it.
   */
  it('a claims read that fails is not settled as no-conflict: it reaches the caller, and no pair is marked judged', { timeout: 60_000 }, async () => {
    const db = door.mongo.getDb();
    const seed = 'readfail-seed'; const other = 'readfail-other';
    // The source of the view: both facts, each with a field the view's stage cannot convert, so a read of either throws.
    await db.collection(`${READ_FAILS}_facts_src`).insertMany([
      build.fact(READ_FAILS, seed, 10, { properties: { port: 8080 }, bad: 'not-a-number' }),
      build.fact(READ_FAILS, other, 11, { properties: { port: 9090 }, bad: 'not-a-number' }),
    ]);
    const similar = async () => ({
      source: { _id: seed, type: 'fact', spaceId: READ_FAILS, seq: 10, fact: `fact ${seed}` },
      results: [{ _id: other, type: 'fact', spaceId: READ_FAILS, seq: 11, score: 0.99, properties: { port: 9090 }, fact: `fact ${other}` }],
    });
    const judged = new Set();
    let outcome;
    await withCollectionAsView(db, `${READ_FAILS}_facts`, `${READ_FAILS}_facts_src`, async () => {
      // The fault fires: a raw read of the view throws, so the test cannot pass on a read that never failed.
      await assert.rejects(db.collection(`${READ_FAILS}_facts`).find({ _id: seed }).toArray(), 'the view read did not fail: nothing was injected');
      outcome = await evalRecord(READ_FAILS, 'fact', seed, 'structured', 0.9, judged, similar).then(o => ({ ok: o }), e => ({ err: e }));
    }, { pipeline: [{ $addFields: { _x: { $toInt: '$bad' } } }] });
    assert.ok(outcome.err, `a failed claims read was settled as a judged seed: ${JSON.stringify(outcome.ok)}`);
    assert.equal(judged.size, 0, `a pair was marked judged on claims that were never read: ${[...judged]}`);
    assert.equal(await door.coll(READ_FAILS, 'contradiction_candidates').countDocuments({}), 0);
  });
});
