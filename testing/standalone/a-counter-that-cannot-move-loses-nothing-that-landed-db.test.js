/**
 * A counter bump that fails after records LANDED loses nothing that landed — on every door an arrival comes
 * through: the push batch, a push single route, the pull page and the admin import (`Q-224`, bundle-30 plan §E).
 *
 * ## The defect
 *
 * `writeArrivals` (`sync/arrivals.ts`) ends each chunk in a `finally` that bumps the counter, THEN books what
 * landed into the outcome, THEN queues it for embedding. A bump that throws (a counter row the store refuses, a
 * step-down) exits the `finally` at its first line:
 *
 *  - the records that landed are never QUEUED, so they sit in the store unembedded until something else touches
 *    them — searchable by nothing that ranks by meaning;
 *  - they are never BOOKED, so the outcome says nothing landed;
 *  - and the bump's error REPLACES whatever the write threw. An `ArrivalWriteError` carries `partial` — what
 *    committed before the fault — and the import reads it to report landed records as landed; replaced by the
 *    counter's error, the import calls every document of the family refused, over records it wrote.
 *
 * The push door's own `finally` (`acceptPushedPage`, `docs.ts`) has the same shape: its bump over everything
 * RECEIVED replaces the error the page's write threw.
 *
 * ## The rule, as the plan writes it (the model is `tombstone-apply.ts`'s post-step)
 *
 * Each step of a `finally` — bump, bookkeeping, enqueue — in its own `try`; a bump failure is LOGGED (warn, the
 * space and the seq) and marks the counter behind; **the original error and its `partial` always win**; the writer
 * always attaches `partial`; a counter left behind with no other error still fails the call (500 on a push door,
 * a held `deliveredThrough` on pull, a per-family error on import).
 *
 * ## Which bump fails, per door — the trap this file is built around
 *
 * A push bumps twice: the writer over what it was HANDED, the door over everything RECEIVED. Whenever the page's
 * top seq rides on a document the writer was handed, the writer's bump fails first. So:
 *
 *  - the writer's failure is seen on every door with the top seq on a landed record (push batch, push single,
 *    pull, import);
 *  - the DOOR's failure, alone, needs the top seq on a document the planner never hands the writer — a
 *    TOMBSTONED one — while the writer's own bump (under the ceiling) succeeds.
 *
 * Faults are REAL (`_write-faults.mjs`): a validator on `ythril_counters` refusing a seq above a ceiling for one
 * space, and a view where `<space>_facts` should be.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-counter-that-cannot-move-loses-nothing-that-landed-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { withCounterCeiling, withCollectionAsView } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/** Records land here; its counter is refused above CEILING. */
const S = 'ctrbehind';
/** Facts here are a view while a case runs — a write that fails with no per-document shape. */
const V = 'ctrbehindview';
const CEILING = 100;
const TOP = 500;

let door, importMod, unsubscribe;
const lines = [];

const queued = async (space, type, id) => !!(await door.coll(space, 'embed_jobs').findOne({ _id: `${type}:${id}` }));
const linesSince = (n) => lines.slice(n);

describe('a counter that cannot move loses nothing that landed', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ctrbehind', spaces: [S, V] });
    importMod = await import('../../server/dist/api/admin-import.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines(l => { lines.push(l); });
    await door.bumpSeq('ctrbehind-probe', 1); // the counter collection must exist for collMod
  });
  after(async () => { unsubscribe?.(); await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('the faults are real: the ceiling refuses a bump above it, the view refuses a write', async () => {
    const { bumpSeq } = await import('../../server/dist/util/seq.js');
    await withCounterCeiling(door.mongo.getDb(), S, CEILING, async () => {
      await bumpSeq(S, CEILING - 1);
      await assert.rejects(bumpSeq(S, TOP), /validation/i);
    });
    await withCollectionAsView(door.mongo.getDb(), `${V}_facts`, `${V}_entities`, async () => {
      await assert.rejects(door.coll(V, 'facts').insertOne(build.fact(V, 'probe', 1)), /view/i);
    });
  });

  describe('the writer\'s bump fails after its records landed: they are still queued and booked', () => {
    for (const [label, send] of [
      ['push POST /batch-upsert', (doc) => door.push('/batch-upsert', { facts: [doc] }, { spaceId: S })],
      ['push POST /facts', (doc) => door.push('/facts', doc, { spaceId: S })],
    ]) {
      it(label, async () => {
        const doc = build.fact(S, `landed-${label.length}`, TOP);
        const r = await withCounterCeiling(door.mongo.getDb(), S, CEILING, () => send(doc));
        assert.ok(await door.coll(S, 'facts').findOne({ _id: doc._id }), 'fixture: the record did not land, so nothing was lost');
        assert.equal(r.code, 500, `${label} answered ${r.code} over a counter it could not move: ${JSON.stringify(r.body)}`);
        assert.ok(await queued(S, 'fact', doc._id),
          `${label}: the record landed and the counter bump after it failed — and the record was never queued for `
          + 'embedding. The bump threw out of the writer\'s finally before the enqueue, so it stays unembedded');
      });
    }

    it('pull: the landed record is queued, and the page is not marked delivered', async () => {
      const doc = { ...build.fact(S, 'pulled-landed', TOP), author: PEER_AUTHOR };
      door.state.records[S] = { facts: [doc] };
      await withCounterCeiling(door.mongo.getDb(), S, CEILING, () => door.sync());
      assert.ok(await door.coll(S, 'facts').findOne({ _id: doc._id }), 'fixture: the pulled record did not land');
      // The pull's answer to a page it could not finish is a HELD watermark (the cycle's `errors` does not count it).
      const through = door.member().lastSeqReceived?.[S] ?? 0;
      assert.ok(through < TOP, `the pull moved its watermark to ${through} over a counter left behind ${TOP}`);
      assert.ok(await queued(S, 'fact', doc._id),
        'pull: the record landed and was never queued for embedding — the counter bump threw out of the writer\'s finally first');
    });

    it('import: every landed record is reported landed and queued', async () => {
      const docs = [1, 2, 3].map(i => build.fact(S, `restored-${i}`, TOP - 3 + i));
      const out = await withCounterCeiling(door.mongo.getDb(), S, CEILING, () => importMod.importDocuments(S, { facts: docs }));
      const stored = (await door.coll(S, 'facts').find({ _id: { $in: docs.map(d => d._id) } }).toArray()).map(d => d._id).sort();
      assert.deepEqual(stored, docs.map(d => d._id).sort(), 'fixture: the restore did not store all three');
      const r = out.results.facts;
      assert.equal(r.inserted + r.updated, 3,
        `an import that stored all three reported ${JSON.stringify({ inserted: r.inserted, updated: r.updated, errors: r.errors, refused: r.refused })}: `
        + 'the counter\'s error replaced the writer\'s, lost its partial, and every document was called refused');
      const refusedLanded = (r.refused ?? []).map(x => x._id).filter(id => stored.includes(id));
      assert.deepEqual(refusedLanded, [], 'a record the import stored is reported refused');
      const unqueued = [];
      for (const d of docs) if (!(await queued(S, 'fact', d._id))) unqueued.push(d._id);
      assert.deepEqual(unqueued, [], 'restored records that landed were never queued for embedding');
      // The promise `admin-import.ts` makes beside the result (bundle-30 I8): a counter left behind what it restored
      // is SAID, because the next local write would take a seq a restored record already holds.
      assert.equal(r.counterBehind, true, `the import does not say its counter is behind what it restored: ${JSON.stringify(r)}`);
    });
  });

  describe('the original write error survives a bump that also fails', () => {
    it('import: the family is refused for the write\'s reason, not the counter\'s', async () => {
      const out = await withCollectionAsView(door.mongo.getDb(), `${V}_facts`, `${V}_entities`,
        () => withCounterCeiling(door.mongo.getDb(), V, CEILING, () => importMod.importDocuments(V, { facts: [build.fact(V, 'never-lands', TOP)] })));
      const reason = out.results.facts.refused?.[0]?.reason ?? '';
      assert.match(reason, /record write failed/,
        `the import names the failure as '${reason}': the counter's error replaced the write's, so the operator is `
        + 'told to look at the counter when the records are what failed');
    });

    it('push batch: the door\'s own bump fails (top seq on a TOMBSTONED document) and the write\'s error is the one reported', async () => {
      /*
       * `written` (seq 50, under the ceiling) is handed to the writer and fails on the view — the writer's own
       * bump over 50 succeeds. `buried` (seq 500) is tombstoned at 600, so the planner never hands it over and
       * only the door's bump over what it RECEIVED reaches 500, and fails.
       */
      await door.coll(V, 'tombstones').insertOne(build.tombstone(V, 'buried', 'fact', 600));
      const from = lines.length;
      const r = await withCollectionAsView(door.mongo.getDb(), `${V}_facts`, `${V}_entities`,
        () => withCounterCeiling(door.mongo.getDb(), V, CEILING, () => door.push('/batch-upsert',
          { facts: [build.fact(V, 'written', 50), build.fact(V, 'buried', TOP)] }, { spaceId: V })));
      assert.equal(r.code, 500, `the batch answered ${r.code}: ${JSON.stringify(r.body)}`);
      const report = linesSince(from).filter(l => /sync POST batch-upsert failed with a 5xx/.test(l));
      assert.equal(report.length, 1, `expected one 5xx report, the ring held: ${JSON.stringify(linesSince(from).map(l => l.slice(0, 160)))}`);
      assert.match(report[0], /record write failed/,
        `the 5xx is reported as '${report[0].slice(0, 200)}': the door's counter error replaced the write's`);
      assert.ok(linesSince(from).some(l => /\[WARN \]/.test(l) && l.includes(V) && l.includes(String(TOP))),
        `no warning names the space '${V}' and the seq ${TOP} the counter could not reach: `
        + JSON.stringify(linesSince(from).map(l => l.slice(0, 160))));
    });
  });
});
