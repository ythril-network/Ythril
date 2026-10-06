/**
 * Database-level test: one space that cannot be read does not blank the scrape-time gauges of the others (Q-274, Q-358,
 * bundle-53 G22).
 *
 * ## What it pins
 *
 * Every per-space gauge with an async `collect()` (the four brain totals, the three media-job counts and the phase gauge)
 * walked the spaces in ONE `try`: the first space whose collection could not be read threw, `withCollectBudget` swallowed it
 * ("a collector that throws keeps its previous values"), and every space AFTER it kept a value from the last scrape that
 * happened to work. One broken space made the gauges of all the later ones stale, with nothing saying so.
 *
 * Now each space is read on its own: the others refresh, the failed one keeps its last value (the same contract a whole
 * collector had), and the failure is said ONCE per collector per window, naming every space it could not read.
 *
 * ## How the failure is made, and why it is real
 *
 * A VIEW named like the space's collection, over a source holding a document its pipeline cannot convert: every read of it
 * (`estimatedDocumentCount`, `countDocuments`, `find`) is refused by the server with a conversion error (code 241) while the
 * store answers every other call. That is a space that fails and a store that does not — the case a walk must tell apart.
 *
 * **The gauges are POISONED before each scrape** (a sentinel in every series), never reset: a reset reads 0, and 0 is also a
 * correct answer for an empty space, so a collector that wrote nothing would pass. A series still holding the sentinel after the
 * scrape was not written by it — which is the assertion for the failed spaces ("keeps its last value") and, inverted, the
 * assertion for the healthy ones.
 *
 * The subjects are derived from `TIMED_COLLECTORS` (every budgeted collector whose metric carries a `space` label), with a
 * floor, and a collector this file has no expectation for fails the file rather than being skipped.
 *
 * Mutations seen red (restored by hand): the per-space catch removed from one collector, the line said per space, the line
 * said on every scrape, a store-unreachable error carried on past the first space.
 *
 * Run: `npm run test:up` first, then  node --test testing/standalone/a-failing-space-does-not-blank-the-gauges-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoNetworkError, MongoServerError } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const POISON = 777_777;
const HEALTHY = 'bravo';
const FAILING = ['alpha', 'charlie'];
const SPACES = [FAILING[0], HEALTHY, FAILING[1]];
const TEMP_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-g22-collectors-config.json');
// The loader reads CONFIG_PATH when it is first imported, and the registry imports it: set before any import below.
process.env['CONFIG_PATH'] = TEMP_CONFIG;

/** What the healthy space holds, per collector: distinct numbers, so a value from the wrong collector is visible. */
const EXPECTED = {
  facts_total: 4, entities_total: 5, edges_total: 6, chrono_entries_total: 7,
  media_jobs_pending: 1, media_jobs_processing: 2, media_jobs_failed: 3,
};
/** The phase gauge is keyed by step too: the two processing jobs are both in `embed`. */
const PHASE = 'media_job_phase';

let mongo;
let registry;
const lines = [];
let unsubscribe = () => {};

/** Every sample of a metric in a scrape: `space` (or `space/step`) to value. */
function seriesOf(text, metric) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith(metric + '{')) continue;
    const m = /^[a-z_]+\{(.*)\}\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = Object.fromEntries([...m[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map(l => [l[1], l[2]]));
    out.set(labels.step === undefined ? labels.space : `${labels.space}/${labels.step}`, Number(m[2]));
  }
  return out;
}

/** The per-space collectors: every budgeted one whose metric is labelled by space. Derived, with a floor. */
function perSpaceCollectors() {
  const names = registry.TIMED_COLLECTORS.filter(name => {
    const metric = registry.register.getSingleMetric(`ythril_${name}`);
    return metric && metric.labelNames.includes('space');
  });
  assert.ok(names.length >= 8, `only ${names.length} per-space collectors derived`);
  return names;
}

/** Put the sentinel in every series a collector writes, for every space. */
function poisonEverything() {
  for (const name of perSpaceCollectors()) {
    const metric = registry.register.getSingleMetric(`ythril_${name}`);
    for (const space of SPACES) {
      if (name === PHASE) for (const step of registry.KNOWN_JOB_STEPS) metric.set({ space, step }, POISON);
      else metric.set({ space }, POISON);
    }
  }
}

/** One scrape through the window the route opens. */
async function scrape() {
  registry.beginScrape();
  try { return await registry.register.metrics(); } finally { registry.endScrape(); }
}

const warnLinesFor = (collector) => lines.filter(l => l.includes('WARN') && l.includes(`'${collector}'`));

describe('a collector with nothing connected', () => {
  it('stops without a word at the first space: a store that was never up is the normal start, not a failure', async () => {
    registry = await import('../../server/dist/metrics/registry.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    const seen = [];
    const out = [];
    const off = subscribeLogLines(l => out.push(l));
    try {
      await registry.collectEachSpace('facts_total', async (id) => { seen.push(id); throw new Error('never reached the store'); }, [{ id: 'a' }, { id: 'b' }]);
    } finally { off(); }
    assert.deepEqual(seen, ['a'], 'the loop went on past a store that was never connected');
    assert.deepEqual(out.filter(l => l.includes('WARN') || l.includes('ERROR')), [], 'a store that is not up yet was said as a failure');
  });
});

describe('a space that cannot be read does not blank the gauges of the others', { skip }, () => {
  before(async () => {
    fs.writeFileSync(TEMP_CONFIG, JSON.stringify({
      instanceId: 'g22-collectors', instanceName: 'G22', tokens: [], networks: [],
      spaces: SPACES.map(id => ({ id, name: id })),
    }));
    mongo = await openTestMongo('g22collectors');
    registry = await import('../../server/dist/metrics/registry.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines(l => lines.push(l));
    (await import('../../server/dist/config/loader.js')).loadConfig();

    const db = mongo.getDb();
    const seed = async (name, docs) => { if (docs.length) await db.collection(name).insertMany(docs); };
    const n = (count, extra = {}) => Array.from({ length: count }, (_, i) => ({ _id: `${i}-${Math.random()}`, ...extra }));
    await seed(`${HEALTHY}_facts`, n(EXPECTED.facts_total));
    await seed(`${HEALTHY}_entities`, n(EXPECTED.entities_total));
    await seed(`${HEALTHY}_edges`, n(EXPECTED.edges_total));
    await seed(`${HEALTHY}_chrono`, n(EXPECTED.chrono_entries_total));
    await seed(`${HEALTHY}_media_jobs`, [
      ...n(EXPECTED.media_jobs_pending, { status: 'pending' }),
      ...n(EXPECTED.media_jobs_processing, { status: 'processing', progress: { step: 'embed' } }),
      ...n(EXPECTED.media_jobs_failed, { status: 'failed' }),
    ]);

    // The source a failing view reads: one document whose `a` the pipeline cannot turn into a number.
    await db.collection('g22_src').insertOne({ _id: 1, a: 'not-a-number' });
    for (const space of FAILING) {
      for (const suffix of ['facts', 'entities', 'edges', 'chrono', 'media_jobs']) {
        await db.createCollection(`${space}_${suffix}`, { viewOn: 'g22_src', pipeline: [{ $project: { x: { $toInt: '$a' } } }] });
      }
    }
  });

  after(async () => {
    unsubscribe();
    await closeTestMongo();
    try { fs.unlinkSync(TEMP_CONFIG); } catch { /* already gone */ }
  });

  it('the healthy space refreshes on every collector; the failed ones keep what they had (poisoned, never reset)', async () => {
    lines.length = 0;
    poisonEverything();
    const text = await scrape();
    for (const name of perSpaceCollectors()) {
      const series = seriesOf(text, `ythril_${name}`);
      const key = name === PHASE ? `${HEALTHY}/embed` : HEALTHY;
      const expected = name === PHASE ? 2 : EXPECTED[name];
      assert.notEqual(expected, undefined, `no expectation for the collector ${name}: this file must say what it reads`);
      assert.equal(series.get(key), expected, `${name}: the healthy space was not refreshed (read ${series.get(key)}) — the failing one before it blanked it`);
      for (const space of FAILING) {
        const kept = name === PHASE ? `${space}/embed` : space;
        assert.equal(series.get(kept), POISON, `${name}: the failed space '${space}' no longer holds its last value (${series.get(kept)})`);
      }
    }
  });

  it('says it ONCE per collector (the first scrape above plus a second), naming every space it could not read and not the one it could', async () => {
    poisonEverything();
    await scrape();
    for (const name of perSpaceCollectors()) {
      const said = warnLinesFor(name);
      assert.equal(said.length, 1, `${name}: ${said.length} warning lines over two scrapes, expected one:\n${said.join('\n')}`);
      for (const space of FAILING) assert.ok(said[0].includes(`'${space}'`), `${name}: the line does not name '${space}': ${said[0]}`);
      assert.ok(!said[0].includes(`'${HEALTHY}'`), `${name}: the line names the healthy space: ${said[0]}`);
    }
  });

  it('says it again once the collector has read every space, and the space fails again', async () => {
    // The SAME set of spaces fails again, so only the collector having been clean in between can make the line news.
    const db = mongo.getDb();
    for (const space of FAILING) {
      await db.collection(`${space}_facts`).drop();
      await db.collection(`${space}_facts`).insertOne({ _id: 'x' });
    }
    await scrape();
    lines.length = 0;
    for (const space of FAILING) {
      await db.collection(`${space}_facts`).drop();
      await db.createCollection(`${space}_facts`, { viewOn: 'g22_src', pipeline: [{ $project: { x: { $toInt: '$a' } } }] });
    }
    await scrape();
    const said = warnLinesFor('facts_total');
    assert.equal(said.length, 1, `a condition that cleared and returned was not said again: ${said.join(' | ')}`);
    for (const space of FAILING) assert.ok(said[0].includes(`'${space}'`));
  });

  it('a store that cannot be reached stops the collector at the first space, quietly', async () => {
    lines.length = 0;
    const seen = [];
    await registry.collectEachSpace('facts_total', async (id) => {
      seen.push(id);
      throw new MongoNetworkError('connect ECONNREFUSED');
    }, SPACES.map(id => ({ id })));
    assert.deepEqual(seen, [SPACES[0]], 'a collector went on asking a store that is not answering');
    assert.deepEqual(lines.filter(l => l.includes('WARN') || l.includes('ERROR')), [], 'an unreachable store was said as a space failure');
  });

  it('the same error behind a wrapper is still the store, and a space fault of its own is not', async () => {
    lines.length = 0;
    const wrapped = [];
    await registry.collectEachSpace('edges_total', async (id) => {
      wrapped.push(id);
      throw new Error('read failed', { cause: new MongoNetworkError('socket closed') });
    }, SPACES.map(id => ({ id })));
    assert.deepEqual(wrapped, [SPACES[0]], 'a wrapped network error was read as one space\'s fault');

    const seen = [];
    await registry.collectEachSpace('chrono_entries_total', async (id) => {
      seen.push(id);
      if (id === HEALTHY) throw new MongoServerError({ message: 'Executor error', code: 241 });
    }, SPACES.map(id => ({ id })));
    assert.deepEqual(seen, SPACES, 'a space\'s own failure stopped the others');
    const said = warnLinesFor('chrono_entries_total');
    assert.equal(said.length, 1);
    assert.ok(said[0].includes(`'${HEALTHY}'`));
  });
});
