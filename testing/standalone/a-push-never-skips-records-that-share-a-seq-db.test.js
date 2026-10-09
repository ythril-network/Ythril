/**
 * A PUSH never skips a record that shares its seq with the last record of the batch before it, never offers one twice,
 * never reports a run as delivered that it only began, and never puts a local-only field on the wire (bundle-52, `Q-277`).
 *
 * ## The defect
 *
 * `pushCollection` (`sync/engine.ts`) reads `seq > cursor` in batches of `PUSH_BATCH_SIZE` (200) and moves its cursor to the
 * LAST seq of a batch. Records from several authors share seqs, so a batch that ends inside a run of equal seqs leaves the
 * rest of the run behind the cursor — never offered to the peer, and `lastSeqPushed` then moves past it. The same cursor is
 * what the transfer reports as `deliveredThrough`, so a stop (a 5xx on the next batch) inside a run claims the whole run was
 * delivered. Separately, the read projects nothing, so `embedding`, `matchedText` and the retention stamps — fields the docs
 * promise never travel — go out on the wire (the receiver strips them; the sender should not send several hundred floats a record).
 *
 * ## The rules, each per replicated family (derived from `REPLICATED_FAMILIES`, floor 6) against a fake receiver
 *
 *  1. 201 local records whose last two share seq 200, the 200-record batch boundary between them: exactly 201 are offered,
 *     none twice, and `lastSeqPushed` reaches 200.
 *  2. A record the receiver refuses is counted refused ONCE — a fix that re-sends the run's first record at the boundary
 *     (`seq >=`) would be refused, and counted, twice.
 *  3. A 5xx on the second batch, which starts inside the run at seq 200, leaves `lastSeqPushed` at 199 (the last COMPLETE seq);
 *     the next cycle sends seq 200 whole.
 *  4. No field of `LOCAL_ONLY_FIELDS` is on the wire.
 *
 * ## What "red at base" is
 *
 * Rule 1 fails with the id of the record never offered; rule 2 fails because that record is never offered at all; rule 3 fails
 * with `lastSeqPushed` at 200 (the base reports the run as delivered); rule 4 fails with the field names it found.
 * File metadata already goes through `fileMetaForWire`, which keeps only the keys the receiver's schema declares, so rule 4 holds
 * for it at base.
 *
 * Template: `a-push-cycle-records-no-violation-for-a-target-later-in-it-db.test.js`.
 * Run: node --test testing/standalone/a-push-never-skips-records-that-share-a-seq-db.test.js (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { replicatedFixtureFamilies, tieRun, missingAndRepeated } from './_seq-tie-families.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'tiepush';
/** The sender's batch size (`PUSH_BATCH_SIZE` in `sync/engine.ts`): the fixtures put a run across it. */
const PUSH_BATCH = 200;
const families = await replicatedFixtureFamilies();

let door, LOCAL_ONLY_FIELDS, ME;

/** A value for each local-only field, so a record carries every one of them as a stored record does. */
const LOCAL_VALUE = {
  embedding: [0.1, 0.2, 0.3], embeddingModel: 'local-model', matchedText: 'the text a search matched',
  _expireAt: new Date('2030-01-01T00:00:00.000Z'), _contentExpireAt: new Date('2030-01-01T00:00:00.000Z'),
  syncBase: { somePeer: 'abc' },
  // bundle-51: who delivered the stored version — names a peer, so it never goes out.
  deliveredBy: 'some-peer',
  // Q-439: an edge's write guard - this instance's lock on a functional subject, never sent.
  _functionalGuard: '4:from5:label',
};

/** Store records as this instance's own writes would, so the engine's push cycle offers them. */
async function seedLocal(family, docs) {
  // A write guard is unique per edge (its index refuses two edges holding one), so a run seeded with one fixture value
  // gets it suffixed with each record's id; it is still seeded on every record, which is what the wire check needs.
  await door.mongo.col(`${S}_${family.collection}`).insertMany(docs.map(d => (
    typeof d._functionalGuard === 'string' ? { ...d, _functionalGuard: `${d._functionalGuard}:${d._id}` } : { ...d })));
  await door.bumpSeq(S, docs.reduce((m, d) => Math.max(m, d.seq), 0));
}

/** The ids offered to the receiver for a family, in request order, accepted or not. */
const offered = (family) => door.state.batchRequests.filter(r => r.key === family.payloadKey).flatMap(r => r.ids);

/** The `lastSeqPushed` of the member for the space. */
const watermark = () => door.member().lastSeqPushed?.[S] ?? 0;

describe('a push never skips a record that shares its seq', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tiepush', spaces: [S], direction: 'push' });
    ({ LOCAL_ONLY_FIELDS } = await import('../../server/dist/sync/local-only-fields.js'));
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset({ direction: 'push' }); });

  it('derives the replicated families and the local-only fields, so an empty set cannot pass', () => {
    assert.ok(families.length >= 6, `only ${families.length} families`);
    assert.ok(LOCAL_ONLY_FIELDS.size >= 5, `only ${LOCAL_ONLY_FIELDS.size} local-only fields — the derivation is broken`);
    // The field the wire row below must see seeded: were it missing from the set, "no local-only field is on the wire" would never look for it.
    assert.ok(LOCAL_ONLY_FIELDS.has('deliveredBy'), 'deliveredBy is not a local-only field: a record\'s deliverer (a peer\'s id) would be pushed to every other peer');
    for (const f of LOCAL_ONLY_FIELDS) assert.ok(f in LOCAL_VALUE, `no fixture value for the local-only field '${f}' — add one, or it is never checked on the wire`);
  });

  for (const family of families) {
    describe(family.payloadKey, () => {
      it('201 records with a tie at the batch boundary: exactly 201 are offered, none twice, and the watermark reaches the run', async () => {
        const run = tieRun(family, S, { before: PUSH_BATCH - 1, tie: 2, extra: { author: ME } });
        assert.equal(run.ids.length, PUSH_BATCH + 1);
        await seedLocal(family, run.docs);
        await door.sync();
        const { missing, repeated, unexpected } = missingAndRepeated(run.ids, offered(family));
        assert.deepEqual({ missing, repeated, unexpected }, { missing: [], repeated: [], unexpected: [] },
          `${family.payloadKey}: of ${run.ids.length} records, ${missing.length} were never offered to the peer (${missing.join(', ')}) and `
          + `${repeated.length} were offered twice (${repeated.join(', ')}); the batch ended inside the run at seq ${run.tieSeq}`);
        assert.equal(watermark(), run.tieSeq, `${family.payloadKey}: a finished push leaves lastSeqPushed at the run's seq`);
      });

      it('a record the receiver refuses is counted refused once, and the rest of its run is still offered', async () => {
        const run = tieRun(family, S, { before: PUSH_BATCH - 1, tie: 2, extra: { author: ME } });
        const refusedId = run.tieIds[0];
        await seedLocal(family, run.docs);
        // The receiver answers 200 and discards the first record of the run, wherever it is offered.
        door.state.batchUpsert = (key, items) => {
          const n = items.filter(d => d._id === refusedId).length;
          return n > 0 ? { body: { [key]: { rejected: n } } } : undefined;
        };
        const { lines } = await door.logsDuring(() => door.sync());
        const dropped = lines
          .filter(l => l.includes('DROPPED') && l.includes(`Batch push ${family.payloadKey}`))
          .map(l => Number(/(\d+) of \d+ record\(s\) DROPPED/.exec(l)?.[1] ?? 0));
        assert.equal(dropped.reduce((a, b) => a + b, 0), 1,
          `${family.payloadKey}: one record was refused and the warning counted ${dropped.join(' + ') || 'none'} — a record offered again at a batch boundary is refused, and counted, again`);
        const seen = missingAndRepeated(run.ids, offered(family));
        assert.deepEqual({ missing: seen.missing }, { missing: [] },
          `${family.payloadKey}: ${seen.missing.join(', ')} was never offered, so the refusal test proves nothing about the run`);
        assert.equal(offered(family).filter(id => id === refusedId).length, 1, `${family.payloadKey}: the refused record was offered more than once`);
      });

      it('a 5xx on the batch that starts inside a run leaves the watermark at S - 1, and the next cycle sends the run whole', async () => {
        // 199 distinct seqs, two records at seq 200, then two more: the second batch starts inside the run (or, from a
        // pager that drops the run's tail, just after it).
        const run = tieRun(family, S, { before: PUSH_BATCH - 1, tie: 2, after: 2, extra: { author: ME } });
        await seedLocal(family, run.docs);
        let seen = 0;
        door.state.batchUpsert = (key) => (key === family.payloadKey && ++seen === 2 ? { status: 503, body: { error: 'scripted' } } : undefined);
        await door.logsDuring(() => door.sync());
        assert.equal(seen, 2, `${family.payloadKey}: the sender made ${seen} request(s) for the family — the fixture does not reach a second batch`);
        assert.equal(watermark(), run.tieSeq - 1,
          `${family.payloadKey}: the push stopped inside the run at seq ${run.tieSeq} and left lastSeqPushed at ${watermark()}; `
          + `only seq ${run.tieSeq - 1} is complete, so a watermark at ${run.tieSeq} never offers the rest of the run again`);

        door.state.batchUpsert = null;
        door.state.batchRequests = [];
        await door.sync();
        const second = missingAndRepeated(run.tieIds, offered(family));
        assert.deepEqual({ missing: second.missing }, { missing: [] },
          `${family.payloadKey}: the next cycle did not send seq ${run.tieSeq} whole (never offered: ${second.missing.join(', ')})`);
        assert.equal(watermark(), run.tieSeq + 2, `${family.payloadKey}: the finished cycle reaches the last record`);
      });

      it('no local-only field is on the wire', async () => {
        const run = tieRun(family, S, { before: 3, tie: 2, extra: { author: ME, ...Object.fromEntries([...LOCAL_ONLY_FIELDS].map(f => [f, LOCAL_VALUE[f]])) } });
        await seedLocal(family, run.docs);
        await door.sync();
        const wire = door.state.pushedRecords.filter(r => r.key === family.payloadKey);
        assert.equal(wire.length, run.ids.length, `${family.payloadKey}: ${wire.length} of ${run.ids.length} records reached the receiver — the fixture is broken`);
        const leaked = new Set(wire.flatMap(d => [...LOCAL_ONLY_FIELDS].filter(f => f in d)));
        assert.deepEqual([...leaked], [], `${family.payloadKey}: the push sent ${[...leaked].join(', ')} — local-only fields the receiver would strip, and that never travel`);
      });
    });
  }
});
