/**
 * A record that arrives by PUSH is offered to this instance's embedder by this instance's rules — on both push
 * doors, for every family that embeds (`Q-107` part 1, and the owner's ruling recorded in `CLAUDE.md`, *What a
 * receiver does after the write*).
 *
 * ## The defect this file was written red for
 *
 * The single `POST /api/sync/entities` route writes a NEW entity with a raw `$setOnInsert` and only reaches
 * `ingestBrainDoc` when the incoming seq is HIGHER than the copy it has just inserted — which it never is. So a
 * new entity pushed singly is stored and never queued: no vector on this instance, absent from every
 * meaning-ranked search, and nothing reports it. The other three single routes and the batch door queue.
 *
 * ## The rule, as a truth table per door
 *
 * Whether to queue is `record > schema > space`, resolved against THIS instance's configuration
 * (`embeddingSuppressedFor`). Asserted per door and per family, because a rule held on one door is the defect this
 * repo produces most. (5.6.x has no embed-queue lanes, so unlike main's version nothing here asserts a priority.)
 *
 * | space        | record mark | type schema            | queued? |
 * |--------------|-------------|------------------------|---------|
 * | open         | —           | none                   | yes     |
 * | open         | true        | none                   | no      |
 * | open         | —           | quiet (suppress: true) | no      |
 * | open         | false       | quiet (suppress: true) | no      |  (`false` is "not stated")
 * | muted        | —           | none                   | no      |
 * | muted        | —           | loud (suppress: false) | yes     |
 *
 * Every row is a NEW record, so the single /entities defect shows on the two "yes" rows and nowhere else.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-pushed-record-is-queued-by-the-receivers-rules-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = await mongoSkipReason();

const OPEN = 'emb-open';
const MUTED = 'emb-muted';
/** The family's type field, as the suppression resolver keys the schema tier (`TYPE_FIELD`): an edge keys on label. */
const TYPE_KEY = { fact: 'type', entity: 'type', edge: 'label', chrono: 'type' };
/*
 * A space that declares chrono types allows ONLY those (plus nothing of the built-in vocabulary), so the default
 * `event` is declared too, with no suppression of its own — otherwise the untyped rows would be refused as an
 * unknown type rather than testing the space tier.
 */
const schemas = (name, suppressEmbeddings) =>
  Object.fromEntries(Object.keys(TYPE_KEY).map(t => [t, { [name]: { suppressEmbeddings }, ...(t === 'chrono' ? { event: {} } : {}) }]));

const ROWS = [
  { space: OPEN,  mark: undefined, type: undefined, queued: true,  label: 'open space, nothing stated' },
  { space: OPEN,  mark: true,      type: undefined, queued: false, label: 'record marked never-embed' },
  { space: OPEN,  mark: undefined, type: 'quiet',   queued: false, label: 'type schema suppresses' },
  { space: OPEN,  mark: false,     type: 'quiet',   queued: false, label: 'record false is not stated; the schema decides' },
  { space: MUTED, mark: undefined, type: undefined, queued: false, label: 'space suppresses' },
  { space: MUTED, mark: undefined, type: 'loud',    queued: true,  label: 'type schema overrides a suppressed space' },
];

const EMBEDDING_FAMILIES = Object.entries(FAMILIES).filter(([, f]) => f.single && f.type).map(([key, f]) => ({ key, ...f }));

let door;
let n = 0;

function arrival(fam, row) {
  const id = `${fam.type}-${++n}`;
  const extra = {};
  if (row.mark !== undefined) extra.suppressEmbeddings = row.mark;
  if (row.type !== undefined) extra[TYPE_KEY[fam.type]] = row.type;
  return build[fam.type](row.space, id, 10 + n, extra);
}

describe('a pushed record is queued for embedding by the receiver\'s rules', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushembed', spaces: [
      { id: OPEN, label: 'Open', folders: [], meta: { typeSchemas: schemas('quiet', true) } },
      { id: MUTED, label: 'Muted', folders: [], meta: { suppressEmbeddings: true, typeSchemas: schemas('loud', false) } },
    ] });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(OPEN); await door.wipe(MUTED); });

  it('the family set is the four that embed, so an empty table cannot pass', () => {
    assert.deepEqual(EMBEDDING_FAMILIES.map(f => f.type).sort(), Object.keys(TYPE_KEY).sort());
  });

  it('a NEW entity pushed on the single /entities route is queued (the headline defect)', async () => {
    const doc = build.entity(OPEN, 'e-new', 7);
    const r = await door.push('/entities', doc, { spaceId: OPEN });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.ok(await door.coll(OPEN, 'entities').findOne({ _id: 'e-new' }), 'the entity was not stored');
    const job = await door.coll(OPEN, 'embed_jobs').findOne({ _id: 'entity:e-new' });
    assert.ok(job,
      'a new entity pushed singly was stored and never queued: it has no vector on this instance and is absent '
      + 'from every meaning-ranked search, with nothing to report it');
  });

  for (const door_ of ['single', 'batch']) {
    describe(`${door_} door`, () => {
      for (const fam of EMBEDDING_FAMILIES) {
        for (const row of ROWS) {
          it(`${fam.type}: ${row.label} -> ${row.queued ? 'queued' : 'not queued'}`, async () => {
            const doc = arrival(fam, row);
            const r = door_ === 'single'
              ? await door.push(fam.single, doc, { spaceId: row.space })
              : await door.push('/batch-upsert', { [fam.key]: [doc] }, { spaceId: row.space });
            assert.equal(r.code, 200, JSON.stringify(r.body));
            assert.ok(await door.coll(row.space, fam.coll).findOne({ _id: doc._id }), `the ${fam.type} was not stored`);
            const job = await door.coll(row.space, 'embed_jobs').findOne({ _id: `${fam.type}:${doc._id}` });
            if (row.queued) {
              assert.ok(job, `${door_} ${fam.type} (${row.label}) was stored and not queued for embedding`);
            } else {
              assert.equal(job, null, `${door_} ${fam.type} (${row.label}) was queued against the receiver's suppression`);
            }
          });
        }
      }
    });
  }

  /*
   * E1 of the 5.6.2 plan (filed against main as Q-224): the side effects that follow a landed write run whatever
   * the one before them did, and a failure in either is LOGGED. A counter bump that throws must not cost the landed
   * records their embed jobs — a record stored and never queued is absent from meaning-ranked search with nothing
   * to report it — and a failed enqueue must say so, where 5.6.1's `enqueueEmbedJob` swallows it silently.
   *
   * The faults are injected below the driver API, on the one collection each side effect writes, and every
   * injected promise is awaited before the case reads anything, so a fire-and-forget side effect cannot land
   * after the assertion (or on the next case).
   */
  describe('E1: one failed side effect neither skips the next nor goes unlogged', () => {
    const WRITES = ['updateOne', 'updateMany', 'bulkWrite', 'insertOne', 'insertMany', 'findOneAndUpdate', 'replaceOne'];

    /** Run `fn` with every write to `collectionName` failing; resolve once every injected failure has settled. */
    async function failingWritesTo(collectionName, fn) {
      const proto = Object.getPrototypeOf(door.mongo.col('probe'));
      const originals = Object.fromEntries(WRITES.map(m => [m, proto[m]]));
      const injected = [];
      for (const m of WRITES) {
        proto[m] = function faulty(...args) {
          if (this.collectionName !== collectionName) return originals[m].apply(this, args);
          const p = Promise.reject(new Error(`injected: ${collectionName} ${m} failed`));
          injected.push(p.catch(() => {}));
          return p;
        };
      }
      const lines = [];
      const { subscribeLogLines } = await import('../../server/dist/util/log.js');
      const stop = subscribeLogLines((l) => lines.push(l));
      try {
        const r = await fn();
        // A side effect started after the answer (5.6.1's bump) may not have reached the driver yet.
        for (let i = 0; i < 50 && injected.length === 0; i++) await new Promise(res => setImmediate(res));
        await Promise.all(injected);
        return { r, lines, injected: injected.length };
      } finally {
        stop();
        Object.assign(proto, originals);
      }
    }

    it('the counter bump throws: the landed records are still queued, and the failure is logged', async () => {
      const docs = [build.fact(OPEN, 'e1-bump-a', 31), build.fact(OPEN, 'e1-bump-b', 32)];
      const { lines, injected } = await failingWritesTo('ythril_counters',
        () => door.push('/batch-upsert', { facts: docs }, { spaceId: OPEN }));
      assert.ok(injected > 0, 'fixture check: the counter was never written, so no bump failed');
      for (const d of docs) {
        assert.ok(await door.coll(OPEN, 'facts').findOne({ _id: d._id }), `fixture check: ${d._id} did not land`);
        assert.ok(await door.coll(OPEN, 'embed_jobs').findOne({ _id: `fact:${d._id}` }),
          `${d._id} landed and was never queued because the counter bump before the enqueue threw`);
      }
      assert.ok(lines.some(l => /injected: ythril_counters/.test(l)),
        'the failed counter bump was not logged: the counter stays behind what was received and nothing says so. '
        + `Logged:\n${lines.join('\n')}`);
    });

    it('the enqueue fails: the records still land, and the failed enqueue is logged', async () => {
      const docs = [build.fact(OPEN, 'e1-queue-a', 41), build.fact(OPEN, 'e1-queue-b', 42)];
      const { lines, injected } = await failingWritesTo(`${OPEN}_embed_jobs`,
        () => door.push('/batch-upsert', { facts: docs }, { spaceId: OPEN }));
      assert.ok(injected > 0, 'fixture check: the embed queue was never written, so no enqueue failed');
      for (const d of docs) assert.ok(await door.coll(OPEN, 'facts').findOne({ _id: d._id }), `${d._id} did not land`);
      assert.ok(lines.some(l => /injected: .*_embed_jobs/.test(l)),
        'a failed enqueue was swallowed: the records are stored with no vector and no job, and nothing says so. '
        + `Logged:\n${lines.join('\n')}`);
    });
  });
});
