/**
 * Database-level test: the link conversion walks each space on its own and says WHICH spaces failed (Q-274; bundle-53 G19).
 *
 * ## What it pins
 *
 * `convertAllLinks` (the operator's script) and `convertLinksOnBoot` (every start) both convert each space and mark the ones that
 * finished clean. Two things were wrong with the walk.
 *
 * - **A space that THREW stopped it.** `convertAllLinks` had no catch at all: a space whose collection could not be read ended
 *   the loop, so every space after it was left unconverted and unmarked, and the script died with a stack trace. The boot walk had
 *   a catch of its own; the two were the same rule written twice, and the weaker one is the one an operator met.
 * - **The answer to "which failed" was lost.** `convertAllLinks` returned reports only, so a space that failed to convert left no
 *   trace in what it returned: a caller could not tell "converted" from "never reached". Now it returns
 *   `{ reports, failedSpaces }`, a space that is not converted is named in `failedSpaces` WITH ITS REASON, and the boot ERROR line
 *   is built from the same list.
 * - **A hung space cost a bound per document.** The per-document catch swallowed every failure, a timeout included, so a space whose
 *   store stopped answering paid one bound for each document it walked. A timeout (or a store that is down) now ends the SPACE.
 *
 * ## How the failures are made, and why they are real
 *
 * - **A space that cannot be read** is a VIEW named like its facts collection, over a source document its pipeline cannot convert.
 *   The source document matches the reader's filter (`{}`), because a view's stage only runs on documents that reach it.
 * - **A document that cannot be reconciled** is a `bulkWrite` on the space's links collection that throws (`failWrites`), with a real
 *   entity for the arrays to name: an entry naming a record that is not there makes no link and writes nothing.
 * - **A hung read** is `withStalledReads`, ended by the housekeeping figure.
 *
 * Run: `npm run test:up` first, then  node --test testing/standalone/convert-all-links-isolates-a-failing-space-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { failWrites, setWriteBoundForTest, withStalledReads } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-g19-convert-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
// The loader reads CONFIG_PATH when it is first imported: set before any import below.
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SOURCE = 'g19_src';
const ENTITY = 'aaaaaaaa-0000-4000-8000-000000000019';
const AUTHOR = { instanceId: 'g19-test', instanceLabel: 'test' };

let mongo; let loader; let conversion; let onBoot; let signals;
let faults;
let restoreBound = () => {};
const lines = [];
let unsubscribe = () => {};

/** Write the config with exactly these spaces (none marked) and read it, so the walk sees them. */
function configure(ids) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'g19-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: ids.map(id => ({ id, label: id, folders: [] })),
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

/** A space with `n` facts that each name one real entity: the conversion has one link to write for each. */
async function seedSpace(id, n = 1) {
  const db = mongo.getDb();
  await db.collection(`${id}_entities`).insertOne({ _id: ENTITY, spaceId: id, name: 'E', type: 'thing', tags: [], seq: 1 });
  await db.collection(`${id}_facts`).insertMany(Array.from({ length: n }, (_, i) => ({
    _id: `${id}-fact-${i}`, spaceId: id, fact: `fact ${i}`, type: '', tags: [], entityIds: [ENTITY], author: AUTHOR, seq: 2 + i,
  })));
}

const failingView = (name) =>
  mongo.getDb().createCollection(name, { viewOn: SOURCE, pipeline: [{ $addFields: { _x: { $toInt: '$a' } } }] });

const linkCount = (id) => mongo.getDb().collection(`${id}_links`).countDocuments({});
const marked = (id) => loader.getConfig().spaces.find(s => s.id === id)?.completeLinkage === true;
const said = (re) => lines.filter(l => re.test(l));

describe('the link conversion isolates a failing space and names it (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('g19convert');
    loader = await import('../../server/dist/config/loader.js');
    configure(['boot']);
    conversion = await import('../../server/dist/brain/links-conversion.js');
    onBoot = await import('../../server/dist/brain/links-convert-on-boot.js');
    await import('../../server/dist/db/drop-link-arrays.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines(l => lines.push(l));
    faults = failWrites(Object.getPrototypeOf(mongo.col('probe')), ['bulkWrite']);
  });

  after(async () => {
    faults?.restore();
    restoreBound();
    unsubscribe();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => { lines.length = 0; faults.clear(); });

  it('the step is declared, so its failures are counted from zero', () => {
    assert.ok(signals.declaredSteps().includes('Link conversion'), `declared steps: ${signals.declaredSteps().join(', ')}`);
    assert.ok(signals.declaredSteps().includes('Link array drop'), `declared steps: ${signals.declaredSteps().join(', ')}`);
  });

  describe('convertAllLinks over a space that cannot be read and a space whose documents cannot be reconciled', () => {
    const BAD = 'g19bad';
    const SOFT = 'g19soft';
    const GOOD = 'g19good';
    let outcome;

    before(async () => {
      const db = mongo.getDb();
      await db.collection(SOURCE).insertOne({ _id: 's1', a: 'not-a-number' });
      await failingView(`${BAD}_facts`);
      await seedSpace(SOFT, 3);
      await seedSpace(GOOD, 2);
      // The bad space is FIRST: a walk that stops at the first throw never reaches the others.
      configure([BAD, SOFT, GOOD]);
      faults.fail('bulkWrite', `${SOFT}_links`, new Error('g19 simulated: the link write was refused'), { times: 50 });
      lines.length = 0;
      outcome = await conversion.convertAllLinks();
    });

    it('returns the reports and the failed spaces, in the order the spaces were given', () => {
      assert.ok(outcome && !Array.isArray(outcome), `convertAllLinks returned ${Array.isArray(outcome) ? 'an array' : typeof outcome}: the failure of a space has nowhere to go`);
      assert.deepEqual(outcome.failedSpaces.map(f => f.spaceId), [BAD, SOFT]);
      assert.ok(outcome.reports.every(r => typeof r.spaceId === 'string'));
    });

    it('names each failed space with its reason: a read that failed, and a count of documents that did not reconcile', () => {
      const [bad, soft] = outcome.failedSpaces;
      assert.ok(typeof bad.reason === 'string' && bad.reason.length > 0, 'the space that could not be read has no reason');
      assert.match(soft.reason, /3 document\(s\) failed to reconcile/);
    });

    it('the space after the failures is converted and marked, and the failed ones are not marked', async () => {
      assert.equal(await linkCount(GOOD), 2, 'the space after the failing one was never converted');
      assert.equal(marked(GOOD), true);
      assert.equal(marked(BAD), false, 'a space that could not be read was marked complete');
      assert.equal(marked(SOFT), false, 'a space with documents that did not reconcile was marked complete');
      assert.equal(outcome.reports.find(r => r.spaceId === GOOD).failed, 0);
      assert.equal(outcome.reports.find(r => r.spaceId === SOFT).failed, 3);
    });

    it('each failure is said by the walk\'s reporter, the unreadable space once and each document of the other by name', () => {
      const bad = said(new RegExp(`Link conversion failed for space '${BAD}'`));
      assert.equal(bad.length, 1, `expected one line for the unreadable space, got:\n${bad.join('\n')}`);
      assert.match(bad[0], /retried next boot/);
      for (let i = 0; i < 3; i++) {
        assert.equal(said(new RegExp(`Link conversion failed for space '${SOFT}' \\(facts/${SOFT}-fact-${i}\\)`)).length, 1,
          `the document ${i} that did not reconcile is not named once:\n${lines.join('\n')}`);
      }
      assert.deepEqual(said(new RegExp(`Link conversion failed for space '${GOOD}'`)), []);
    });

    it('convertLinksOnBoot says ONE ERROR line naming both, with their reasons and the remedy, and marks nothing it must not', async () => {
      faults.fail('bulkWrite', `${SOFT}_links`, new Error('g19 simulated: the link write was refused'), { times: 50 });
      lines.length = 0;
      await onBoot.convertLinksOnBoot();
      const errors = said(/Link conversion FAILED/);
      assert.equal(errors.length, 1, `expected one ERROR summary, got:\n${errors.join('\n')}`);
      assert.match(errors[0], new RegExp(`${BAD} \\(.+\\)`), 'the unreadable space is not named with its reason');
      assert.match(errors[0], new RegExp(`${SOFT} \\(3 document\\(s\\) failed to reconcile\\)`));
      assert.doesNotMatch(errors[0], new RegExp(GOOD), 'a converted space is named as failed');
      assert.match(errors[0], /The next boot retries/);
      assert.equal(marked(BAD), false);
      assert.equal(marked(SOFT), false);
    });
  });

  describe('a timeout inside a document ends the SPACE, not one document', () => {
    it('names the space with the bound as the reason, and the next space is converted', async () => {
      const { StoreTimeout } = await import('../../server/dist/db/write-timeout.js');
      const TO = 'g19timeout';
      const NEXT = 'g19after';
      await seedSpace(TO, 3);
      await seedSpace(NEXT, 1);
      configure([TO, NEXT]);
      faults.fail('bulkWrite', `${TO}_links`, new StoreTimeout('g19 simulated write'), { times: 50 });
      lines.length = 0;
      const outcome = await conversion.convertAllLinks();
      assert.deepEqual(outcome.failedSpaces.map(f => f.spaceId), [TO]);
      assert.match(outcome.failedSpaces[0].reason, /ran past its time bound/,
        `the reason is "${outcome.failedSpaces[0].reason}": the timeout was counted as one document that did not reconcile, and the next two documents paid a bound each`);
      assert.equal(await linkCount(NEXT), 1, 'the space after the timed-out one was not converted');
      assert.equal(said(new RegExp(`Link conversion failed for space '${TO}'`)).length, 1);
    });
  });

  describe('a hung read', () => {
    it('ends at the housekeeping figure, names the space, and the next space is converted', async () => {
      const db = mongo.getDb();
      const HUNG = 'g19hung';
      const NEXT = 'g19next';
      await db.collection(`${HUNG}_facts`).insertOne({ _id: 'x' });
      await seedSpace(NEXT, 1);
      configure([HUNG, NEXT]);
      restoreBound = await setWriteBoundForTest({ writeTimeoutMs: 30_000, housekeepingOpMs: 1_000 });
      try {
        await withStalledReads(db, `${HUNG}_facts`, SOURCE, { ms: 3_000 }, async () => {
          lines.length = 0;
          const started = Date.now();
          const outcome = await conversion.convertAllLinks();
          const ms = Date.now() - started;
          assert.ok(ms < 2_400, `the conversion took ${ms}ms: a read that stalls 3000ms was not ended at the 1000ms housekeeping figure`);
          assert.deepEqual(outcome.failedSpaces.map(f => f.spaceId), [HUNG]);
          assert.match(outcome.failedSpaces[0].reason, /time bound of 1000 ms/);
          assert.equal(await linkCount(NEXT), 1, 'the space after the hung one was not converted');
          assert.equal(marked(HUNG), false);
          assert.equal(said(new RegExp(`Link conversion failed for space '${HUNG}'`)).length, 1);
        });
      } finally { restoreBound(); }
    });
  });

  describe('a walk that is stopped before it reaches a space does not call it converted', () => {
    it('a space no walk reached is a failed space with the reason', async () => {
      // Three timeouts on distinct spaces stop the walk (K = 3), so the fourth space is never reached.
      const { StoreTimeout } = await import('../../server/dist/db/write-timeout.js');
      const ids = ['g19k1', 'g19k2', 'g19k3', 'g19k4'];
      for (const id of ids) await seedSpace(id, 1);
      configure(ids);
      for (const id of ids.slice(0, 3)) faults.fail('bulkWrite', `${id}_links`, new StoreTimeout('g19 simulated write'), { times: 50 });
      const outcome = await conversion.convertAllLinks();
      assert.deepEqual(outcome.failedSpaces.map(f => f.spaceId), ids,
        'the space the walk never reached is missing from the failed spaces, so the caller reads it as converted');
      assert.match(outcome.failedSpaces[3].reason, /not reached/);
      assert.equal(marked('g19k4'), false);
    });
  });
});
