/**
 * Database-level test: the chrono retention sweep isolates a failing or hung space, and each half of a space on its own (Q-274,
 * Q-358, Q-317 latch; bundle-53 G13).
 *
 * ## What it pins
 *
 * `sweepChronoRetention` is two halves per space: the BACKFILL (stamps a missing expiry across all four typed collections) and the
 * REDACTION (drops the detail of a chrono entry past its content window). It used to wrap both in one `try`, so a backfill
 * that failed in a space skipped that space's redaction as well, said it as `Chrono retention (<space>): <message>` on every
 * sweep, and a read that HUNG held the whole sweep, and the next tick with it, for as long as the driver waited.
 *
 * Now the sweep walks the spaces (`eachSpace`) and the two halves are two units inside one (`eachUnit`): a half that fails is
 * said once, naming the half, and the other half of the space still runs; a hung read ends at the housekeeping figure
 * (`YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS`) and the next space is swept.
 *
 * ## How the failures are made, and why they are real
 *
 * - **A failing half** is a VIEW named like the space's collection, over a source document its pipeline cannot convert. The
 *   source document MATCHES the reader's filter, because a view's stage only runs on documents that reach it: a document the filter
 *   excludes would leave the read clean and the fault unarmed.
 * - **A hung half** is `withStalledReads`. Its own default seed documents are `{ _id }` only and do NOT match the backfill's filter, so
 *   the stall would be skipped by a read that can short-circuit on the filter; this file passes `readerFilter` (the backfill's own read,
 *   `backfillReaderFilter`) and `seed` documents that match it, none with a valid `createdAt`, so the backfill reads them, sleeps once per
 *   document and has nothing to write (a write to a view fails, and that failure is not the one this case is about).
 *
 * Run: `npm run test:up` first, then  node --test testing/standalone/chrono-retention-isolates-a-failing-space-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { setWriteBoundForTest, withStalledReads } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const DAY = 86_400_000;
const TEMP_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-g13-chrono-retention-config.json');
// The loader reads CONFIG_PATH when it is first imported: set before any import below.
process.env['CONFIG_PATH'] = TEMP_CONFIG;

const SOURCE = 'g13_src';

let mongo;
let sweepChronoRetention;
let loadConfig;
let restoreBound = () => {};
const lines = [];
let unsubscribe = () => {};

const ago = (days) => new Date(Date.now() - days * DAY);

const SCHEMAS = {
  entity: { ticket: { retention: { days: 365 } } },
  fact: { note: { retention: { days: 30 } } },
  chrono: { event: { retention: { days: 90, contentDays: 14 } } },
};
const policy = (...kinds) => ({ typeSchemas: Object.fromEntries(kinds.map(k => [k, SCHEMAS[k]])) });

/** Write the config with exactly these spaces (id, optional policy) and read it, so `concreteSpaces()` is them. */
function configure(spaces) {
  fs.writeFileSync(TEMP_CONFIG, JSON.stringify({
    instanceId: 'g13-chrono', instanceName: 'G13', tokens: [], networks: [],
    spaces: spaces.map(({ id, kinds = [] }) => ({ id, name: id, meta: policy(...kinds) })),
  }));
  loadConfig();
}

const entity = (space, id) => ({
  _id: id, spaceId: space, name: id, type: 'ticket', tags: [],
  createdAt: ago(100).toISOString(), updatedAt: ago(100).toISOString(), seq: 1, author: { instanceId: 'self' },
});
const lapsedChrono = (space, id) => ({
  _id: id, spaceId: space, type: 'event', title: id, description: 'deployed to production', startsAt: ago(60).toISOString(),
  status: 'done', tags: [], entityIds: [], memoryIds: [], createdAt: ago(60).toISOString(), updatedAt: ago(60).toISOString(),
  seq: 1, author: { instanceId: 'self' }, _expireAt: ago(-300), _contentExpireAt: ago(1),
});

const failingView = (name, viewOn) =>
  mongo.getDb().createCollection(name, { viewOn, pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });

const sweepLines = (space, from = lines) => from.filter(l => l.includes('Chrono retention') && l.includes(`'${space}'`) && /WARN|ERROR/.test(l));

/**
 * What the sweep's first read of `space`'s chrono asks for: the backfill's (`backfillTypedExpiry`, `brain/chrono-redaction.ts`) - the
 * policed types of THIS space's config, and no stamp of either kind yet. The types come from the module's own `policedTypes` over the
 * config the sweep reads, so the filter the stall is checked against moves with the sweep and not with this file's seeds.
 */
async function backfillReaderFilter(space) {
  const { policedTypes } = await import('../../server/dist/brain/chrono-redaction.js');
  const { TYPE_FIELD } = await import('../../server/dist/brain/ttl.js');
  const { getConfig } = await import('../../server/dist/config/loader.js');
  const config = getConfig().spaces.find((s) => s.id === space);
  return { [TYPE_FIELD['chrono']]: { $in: policedTypes(config, 'chrono') }, _expireAt: { $exists: false }, _contentExpireAt: { $exists: false } };
}

async function sweepWithin() {
  const started = Date.now();
  const result = await sweepChronoRetention(new Date());
  return { result, ms: Date.now() - started };
}

describe('the chrono retention sweep isolates a failing space and each half of it (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(TEMP_CONFIG, JSON.stringify({ instanceId: 'g13-chrono', instanceName: 'G13', tokens: [], networks: [], spaces: [] }));
    ({ loadConfig } = await import('../../server/dist/config/loader.js'));
    configure([{ id: 'boot' }]);
    mongo = await openTestMongo('g13chrono');
    ({ sweepChronoRetention } = await import('../../server/dist/brain/chrono-redaction.js'));
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines(l => lines.push(l));
  });

  after(async () => {
    restoreBound();
    unsubscribe();
    await closeTestMongo();
    try { fs.unlinkSync(TEMP_CONFIG); } catch { /* already gone */ }
  });

  beforeEach(() => { lines.length = 0; });

  describe('a half that fails', () => {
    const SPACES = [
      // The BACKFILL fails (the fact collection cannot be read); its redaction must still run.
      { id: 'g13backfailing', kinds: ['fact', 'chrono'] },
      // The REDACTION fails (the chrono collection cannot be read); its backfill must still have run.
      { id: 'g13redactfailing', kinds: ['entity'] },
      { id: 'g13healthy', kinds: ['entity'] },
    ];
    let first;
    let firstLines;

    before(async () => {
      const db = mongo.getDb();
      // The source holds one document per reader's filter: the backfill's (a `note` fact with no expiry) and the redaction's (a
      // lapsed content window, not yet redacted). `a` cannot be converted to a number.
      await db.collection(SOURCE).insertMany([
        { _id: 'f', type: 'note', a: 'not-a-number' },
        { _id: 'c', type: 'event', a: 'not-a-number', _contentExpireAt: ago(1) },
      ]);
      await failingView('g13backfailing_facts', SOURCE);
      await failingView('g13redactfailing_chrono', SOURCE);

      await db.collection('g13backfailing_chrono').insertOne(lapsedChrono('g13backfailing', 'b-c'));
      // A chrono event with no stamp yet and a content window still open: only the chrono BACKFILL of the same space, which comes
      // AFTER the failing facts backfill in the walk's order, can stamp it.
      const fresh = ago(5).toISOString();
      const unstamped = { ...lapsedChrono('g13backfailing', 'b-n'), createdAt: fresh, updatedAt: fresh, startsAt: fresh };
      delete unstamped._expireAt;
      delete unstamped._contentExpireAt;
      await db.collection('g13backfailing_chrono').insertOne(unstamped);
      await db.collection('g13redactfailing_entities').insertOne(entity('g13redactfailing', 'r-e'));
      await db.collection('g13healthy_entities').insertOne(entity('g13healthy', 'h-e'));
      await db.collection('g13healthy_chrono').insertOne(lapsedChrono('g13healthy', 'h-c'));

      configure(SPACES);
      lines.length = 0;
      first = await sweepChronoRetention(new Date());
      firstLines = [...lines];
    });

    it('the redaction of a space whose backfill failed still ran', async () => {
      const doc = await mongo.getDb().collection('g13backfailing_chrono').findOne({ _id: 'b-c' });
      assert.equal(doc.contentRedacted, true,
        'the backfill failed in this space and the redaction after it never ran: the two halves share one try');
      assert.equal(doc.description, undefined);
    });

    it('a collection whose backfill failed does not starve the backfill of the next collection in the same space', async () => {
      const doc = await mongo.getDb().collection('g13backfailing_chrono').findOne({ _id: 'b-n' });
      assert.ok(doc._expireAt instanceof Date,
        'the facts backfill failed and the chrono backfill after it never ran: the collections share one unit');
    });

    it('the backfill of a space whose redaction failed still ran', async () => {
      const doc = await mongo.getDb().collection('g13redactfailing_entities').findOne({ _id: 'r-e' });
      assert.ok(doc._expireAt instanceof Date, 'the half before the failing one did not run');
    });

    it('the space after both is swept, and the result counts exactly what was done', async () => {
      const db = mongo.getDb();
      assert.ok((await db.collection('g13healthy_entities').findOne({ _id: 'h-e' }))._expireAt instanceof Date);
      assert.equal((await db.collection('g13healthy_chrono').findOne({ _id: 'h-c' })).contentRedacted, true);
      assert.deepEqual(first, { stamped: 3, redacted: 2 });
    });

    it('each failure is said ONCE, in the walk\'s words, naming the half; the healthy space is not named', () => {
      const back = sweepLines('g13backfailing', firstLines);
      const redact = sweepLines('g13redactfailing', firstLines);
      assert.equal(back.length, 1, `expected one line for the failed backfill, got:\n${back.join('\n')}`);
      assert.equal(redact.length, 1, `expected one line for the failed redaction, got:\n${redact.join('\n')}`);
      assert.match(back[0], /Chrono retention failed for space 'g13backfailing' \(backfill: fact\): .* — retried next cycle/);
      assert.doesNotMatch(back[0], /backfill: (entity|edge|chrono)/, 'the line names a collection that did not fail');
      assert.match(redact[0], /Chrono retention failed for space 'g13redactfailing' \(redaction: chrono\): .* — retried next cycle/);
      assert.deepEqual(sweepLines('g13healthy', firstLines), []);
    });

    it('the next sweep, the same failures, says nothing again', async () => {
      lines.length = 0;
      await sweepChronoRetention(new Date());
      assert.deepEqual(lines.filter(l => l.includes('Chrono retention') && /WARN|ERROR/.test(l)), [],
        'a failure that repeats every cycle was said again');
    });
  });

  describe('a half that hangs', () => {
    it('ends at the housekeeping figure, reports the space once, and the next space is swept', async () => {
      // The stalled view is the backfill's chrono read; its matching documents are the ones that cost the sleep.
      const db = mongo.getDb();
      await db.collection(SOURCE).deleteMany({});   // the failing-half case's own source documents
      const seed = Array.from({ length: 15 }, (_, i) => ({ _id: `m${i}`, type: 'event' }));
      await db.collection('g13hungcut_chrono').insertOne({ _id: 'x' });
      await db.collection('g13nextcut_entities').insertOne(entity('g13nextcut', 'n-e'));
      configure([{ id: 'g13hungcut', kinds: ['chrono'] }, { id: 'g13nextcut', kinds: ['entity'] }]);
      const readerFilter = await backfillReaderFilter('g13hungcut');
      restoreBound = await setWriteBoundForTest({ writeTimeoutMs: 30_000, housekeepingOpMs: 1_000 });
      try {
        await withStalledReads(db, 'g13hungcut_chrono', SOURCE, { ms: 3_000, readerFilter, seed }, async () => {
          lines.length = 0;
          const { ms } = await sweepWithin();
          assert.ok(ms < 2_400, `the sweep took ${ms}ms: a read that stalls 3000ms was not ended at the 1000ms housekeeping figure`);
          const said = sweepLines('g13hungcut');
          assert.equal(said.length, 1, `expected the hung space reported once, got:\n${said.join('\n')}`);
          assert.match(said[0], /Chrono retention failed for space 'g13hungcut'.* — retried after quarantine/);
          assert.ok((await db.collection('g13nextcut_entities').findOne({ _id: 'n-e' }))._expireAt instanceof Date,
            'the space after the hung one was not swept');
        });
      } finally { restoreBound(); }
    });

    it('a scan slower than the write figure but under the housekeeping figure is NOT cut', async () => {
      const db = mongo.getDb();
      await db.collection(SOURCE).deleteMany({});
      const seed = Array.from({ length: 10 }, (_, i) => ({ _id: `m${i}`, type: 'event' }));
      await db.collection('g13slow_chrono').insertOne({ _id: 'x' });
      configure([{ id: 'g13slow', kinds: ['chrono'] }]);
      const readerFilter = await backfillReaderFilter('g13slow');
      restoreBound = await setWriteBoundForTest({ writeTimeoutMs: 1_000, housekeepingOpMs: 8_000 });
      try {
        await withStalledReads(db, 'g13slow_chrono', SOURCE, { ms: 2_000, readerFilter, seed }, async () => {
          lines.length = 0;
          const { ms } = await sweepWithin();
          assert.ok(ms >= 1_500, `the sweep took ${ms}ms: the read was cut at the 1000ms write figure, or it never stalled past it (then this case proves nothing)`);
          assert.deepEqual(sweepLines('g13slow'), [],
            'a slow healthy backfill scan was cut at the write figure (or failed): the bound for "hung" is the housekeeping one');
        });
      } finally { restoreBound(); }
    });
  });

  describe('the announcement', () => {
    it('is said once per space, collection and type, and again after it is forgotten', async () => {
      const mod = await import('../../server/dist/brain/chrono-redaction.js');
      const db = mongo.getDb();
      configure([{ id: 'g13announce', kinds: ['entity'] }]);
      const said = () => lines.filter(l => l.includes('Retention:') && l.includes(`'g13announce'`));
      const addOne = async (id) => { await db.collection('g13announce_entities').insertOne(entity('g13announce', id)); };

      await addOne('a1');
      lines.length = 0;
      await sweepChronoRetention(new Date());
      assert.equal(said().length, 1, `the first stamp was not announced exactly once: ${said().join(' | ')}`);

      await addOne('a2');
      lines.length = 0;
      await sweepChronoRetention(new Date());
      assert.equal(said().length, 0, 'a second stamp for the same space and type was announced again');

      mod.retentionAnnounced.forget(mod.retentionAnnouncementKey('g13announce', 'entity', 'ticket'));
      await addOne('a3');
      lines.length = 0;
      await sweepChronoRetention(new Date());
      assert.equal(said().length, 1, 'after the announcement was forgotten the next stamp was not announced');
    });
  });
});
