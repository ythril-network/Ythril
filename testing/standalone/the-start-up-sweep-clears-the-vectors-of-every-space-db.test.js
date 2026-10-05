/**
 * The start-up suppression sweep: once per start, over EVERY concrete space, one space at a time, in pages
 * (Q-230; Q-361 item 11).
 *
 * ## Why a sweep at start
 *
 * Vectors stored before this version swept files, removed the model name, or heard of a network's suppression are
 * cleared by nothing else until the space's next meta write. The sweep is local derived state (no seq, nothing
 * replicates), idempotent, and starts once the server listens (`the-start-up-sweep-runs-after-the-server-listens`
 * holds the placement).
 *
 * ## The rules asserted here
 *
 *  - **Every space, whether or not it has a meta.** The record tier needs none: a record or file that carries its own
 *    `suppressEmbeddings` flag is suppressed in a space whose config states nothing. A sweep that walked "the
 *    suppressed spaces" would skip exactly the spaces the record tier reaches. A space nothing suppresses is not
 *    touched.
 *  - **Only what removed something is reported**, one INFO line per kind, `Suppression sweep: removed N <kind>
 *    vector(s) in <space>`; the file kind counts rows.
 *  - **One space at a time.** Each space's sweep is an unindexed scan per record kind; starting every space's at once
 *    put all of them in flight together on a large instance. The next space is not started until the one before has
 *    finished — here: while space A's first write is held, space B has not reached its own. **The walk is the order of
 *    `concreteSpaces()`, which is the configuration's**, so this case depends on the fixture declaring A before B; it
 *    asserts that order out of the server's own listing rather than assuming it.
 *  - **A space that fails does not stop the walk.** One space whose store refuses a kind is a warning for that space
 *    (`Suppression sweep failed for <space>`), and every space after it is swept anyway.
 *  - **In pages.** The ids of a large space are read a page at a time (`SWEEP_PAGE`, imported), each page updated and its
 *    jobs retired before the next page is read, so a space of hundreds of thousands of records never holds every id (or
 *    one delete over them all) at once. The READ is what is bounded: the size of every id read of the space is observed
 *    on the cursor, so an unbounded read that is then written in pages cannot pass for paging.
 *
 * The entry point is `sweepEverySpaceAtBoot` of `brain/suppression-sweep.ts` (main's name for it).
 *
 * Seen red on 6eb5a333 (5.6.3): the function does not exist, and nothing sweeps at start.
 *
 * Run: node --test testing/standalone/the-start-up-sweep-clears-the-vectors-of-every-space-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { parkWrites, withCollectionAsView, eventually } from './_write-faults.mjs';
import { MUTATORS } from './_space-writers.mjs';
import { within } from './_within.mjs';

const skip = await mongoSkipReason();

/** The space tier suppresses. */
const A = 'boot-a';
/** No meta at all: only a record's own flag suppresses. */
const B = 'boot-b';
/** Nothing suppresses. */
const C = 'boot-c';
/** A space too large for one page. */
const P = 'boot-p';
const VEC = { embedding: [0.25, 0.5, 0.75], embeddingModel: 'receiver-model', matchedText: 'the text it holds' };
/** How long space B is given to show it started while space A's write is held: an event waited for, not a pause. */
const STARTED_EARLY_WINDOW_MS = 500;

let door, sweepEverySpaceAtBoot, SWEEP_PAGE, concreteSpaces, log, proto, park;

const has = async (space, part, id) => 'embedding' in ((await door.coll(space, part).findOne({ _id: id })) ?? {});
const fact = (space, id, extra = {}) => ({ ...build.fact(space, id, 1), ...VEC, ...extra });
const file = (space, id, extra = {}) => ({ ...build.filemeta(space, id, 1), ...VEC, ...extra });

/** The sweep's own lines logged at `level` while `fn` runs. */
async function sweepLines(level, fn) {
  const lines = [];
  const orig = log[level];
  log[level] = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { log[level] = orig; }
  return lines.filter(l => /Suppression sweep/.test(l));
}

describe('the start-up suppression sweep', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'bootsweep',
      spaces: [
        { id: A, label: 'A', folders: [], meta: { suppressEmbeddings: true } },
        { id: B, label: 'B', folders: [] },
        { id: C, label: 'C', folders: [], meta: {} },
        { id: P, label: 'P', folders: [], meta: { suppressEmbeddings: true } },
      ],
    });
    ({ sweepEverySpaceAtBoot, SWEEP_PAGE } = await import('../../server/dist/brain/suppression-sweep.js'));
    ({ concreteSpaces } = await import('../../server/dist/spaces/proxy.js'));
    ({ log } = await import('../../server/dist/util/log.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => {
    for (const s of [A, B, C, P]) await door.wipe(s);
    await door.coll(A, 'facts_src').drop().catch(() => {});
  });

  async function seedAll() {
    await door.coll(A, 'facts').insertOne(fact(A, 'a-fact'));
    await door.coll(A, 'files').insertMany([file(A, 'docs/a.md'), { _id: 'docs/a.md#chunk0', spaceId: A, path: 'docs/a.md#chunk0', parentFileId: 'docs/a.md', content: 'x', tags: [], ...VEC }]);
    await door.coll(B, 'facts').insertMany([fact(B, 'b-flagged', { suppressEmbeddings: true }), fact(B, 'b-open')]);
    await door.coll(B, 'files').insertMany([
      file(B, 'docs/flagged.md', { suppressEmbeddings: true }),
      { _id: 'docs/flagged.md#chunk0', spaceId: B, path: 'docs/flagged.md#chunk0', parentFileId: 'docs/flagged.md', content: 'x', tags: [], ...VEC },
      file(B, 'docs/open.md'),
    ]);
    await door.coll(C, 'facts').insertOne(fact(C, 'c-fact'));
    await door.coll(C, 'files').insertOne(file(C, 'docs/c.md'));
    await door.coll(A, 'embed_jobs').insertOne({ _id: 'fact:a-fact', recordType: 'fact', recordId: 'a-fact', status: 'pending' });
  }

  it('every space is swept — the one with no meta by its records\' own flags — and a space nothing suppresses is not touched', async () => {
    await seedAll();
    assert.equal(typeof sweepEverySpaceAtBoot, 'function', 'brain/suppression-sweep.js exports no sweepEverySpaceAtBoot');
    await sweepEverySpaceAtBoot();
    const held = async (rows) => (await Promise.all(rows.map(async ([s, part, id]) => [`${s}/${part}/${id}`, await has(s, part, id)]))).filter(([, h]) => h).map(([k]) => k);
    assert.deepEqual(await held([[A, 'facts', 'a-fact'], [A, 'files', 'docs/a.md'], [A, 'files', 'docs/a.md#chunk0'],
      [B, 'facts', 'b-flagged'], [B, 'files', 'docs/flagged.md'], [B, 'files', 'docs/flagged.md#chunk0']]), [],
    'a vector a suppression covers survived the start-up sweep');
    assert.deepEqual(await held([[B, 'facts', 'b-open'], [B, 'files', 'docs/open.md'], [C, 'facts', 'c-fact'], [C, 'files', 'docs/c.md']]).then(h => h.sort()),
      [`${B}/facts/b-open`, `${B}/files/docs/open.md`, `${C}/facts/c-fact`, `${C}/files/docs/c.md`].sort(),
      'the sweep took a vector nothing suppresses');
    assert.equal(await door.coll(A, 'embed_jobs').countDocuments({}), 0, 'the queued job of a swept record was left to write its vector back');
    const model = await door.coll(A, 'facts').findOne({ _id: 'a-fact' });
    assert.deepEqual([model.embeddingModel, model.matchedText], [undefined, VEC.matchedText], 'the model goes with the vector; matchedText stays');
  });

  it('only what removed something is reported, one line per kind, the file kind counting rows', async () => {
    await seedAll();
    const lines = await sweepLines('info', () => sweepEverySpaceAtBoot());
    assert.deepEqual(lines.sort(), [
      `Suppression sweep: removed 1 fact vector(s) in ${A}`,
      `Suppression sweep: removed 2 file vector(s) in ${A}`,
      `Suppression sweep: removed 1 fact vector(s) in ${B}`,
      `Suppression sweep: removed 2 file vector(s) in ${B}`,
    ].sort());
  });

  it('one space at a time: while the first space\'s write is held, the next has not reached its own', async () => {
    const walk = concreteSpaces().map(s => s.id);
    assert.ok(walk.includes(A) && walk.indexOf(A) < walk.indexOf(B),
      `the walk is ${JSON.stringify(walk)}: this case holds A's write and expects B after it — re-order the fixture`);
    await seedAll();
    park = parkWrites(proto);
    const heldA = park.arm(`${A}_facts`);
    const heldB = park.arm(`${B}_facts`);
    let bReached = false;
    heldB.reached.then(() => { bReached = true; });
    const running = sweepEverySpaceAtBoot();
    try {
      await within(Promise.race([heldA.reached, running.then(() => { throw new Error('the sweep finished without writing space A'); })]),
        'space A\'s first write');
      // B's own write is an event, so a sweep that started the spaces together shows it here; a serial one does not.
      assert.equal(await eventually(() => bReached, STARTED_EARLY_WINDOW_MS, 10), false,
        'space B reached its write while space A\'s sweep was still in flight');
      heldA.release();
      await within(heldB.reached, 'space B\'s first write, after space A finished');
    } finally {
      heldA.release();
      heldB.release();
    }
    await within(running, 'the sweep finishing');
    park.restore(); park = undefined;
    assert.equal(await has(B, 'facts', 'b-flagged'), false, 'space B was never swept');
  });

  it('a space whose sweep fails does not stop the walk: the next space is swept and the failure is logged for the one that failed', async () => {
    await seedAll();
    await door.coll(A, 'facts_src').insertOne(fact(A, 'a-src'));
    let warnings;
    await withCollectionAsView(door.mongo.getDb(), `${A}_facts`, `${A}_facts_src`, async () => {
      warnings = await sweepLines('warn', () => sweepEverySpaceAtBoot());
    });
    for (const [part, id] of [['facts', 'b-flagged'], ['files', 'docs/flagged.md'], ['files', 'docs/flagged.md#chunk0']]) {
      assert.equal(await has(B, part, id), false, `${B}/${part}/${id} was not swept after ${A}'s sweep failed`);
    }
    assert.equal(await has(A, 'files', 'docs/a.md'), false, `${A}'s other kinds were left holding their vectors by the kind that failed`);
    assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], new RegExp(`failed for ${A}\\b`), 'the warning does not name the space whose sweep failed');
  });

  it('a large space is read and updated in pages, each page\'s jobs retired before the next is read', async () => {
    const N = SWEEP_PAGE * 2 + 500;
    const ids = Array.from({ length: N }, (_, i) => `p${String(i).padStart(5, '0')}`);
    await door.coll(P, 'facts').insertMany(ids.map(id => fact(P, id)));
    await door.coll(P, 'embed_jobs').insertMany(ids.map(id => ({ _id: `fact:${id}`, recordType: 'fact', recordId: id, status: 'pending' })));
    const events = [];
    const readSizes = [];
    const originals = {};
    for (const m of MUTATORS) {
      originals[m] = proto[m];
      proto[m] = function recording(...args) {
        if (this.collectionName === `${P}_facts`) events.push('write');
        else if (this.collectionName === `${P}_embed_jobs`) events.push('retire');
        return originals[m].apply(this, args);
      };
    }
    // The id READ is what is bounded: how many rows each read of the space's facts brought back, from the cursor itself.
    const originalFind = proto.find;
    proto.find = function recording(...args) {
      const cursor = originalFind.apply(this, args);
      if (this.collectionName !== `${P}_facts`) return cursor;
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => { const rows = await toArray(); readSizes.push(rows.length); events.push('read'); return rows; };
      return cursor;
    };
    try { await sweepEverySpaceAtBoot(); } finally {
      for (const [m, f] of Object.entries(originals)) proto[m] = f;
      proto.find = originalFind;
    }
    assert.ok(readSizes.length > 0, 'fixture check: the sweep read no id of the space');
    assert.ok(Math.max(...readSizes) <= SWEEP_PAGE, `one read of the space brought back ${Math.max(...readSizes)} ids; a page is ${SWEEP_PAGE}`);
    assert.equal(await door.coll(P, 'facts').countDocuments({ embedding: { $exists: true } }), 0, 'a vector survived');
    assert.equal(await door.coll(P, 'embed_jobs').countDocuments({}), 0, 'a job survived');
    const writes = events.filter(e => e === 'write').length;
    assert.ok(writes >= Math.ceil(N / SWEEP_PAGE), `${N} records were written in ${writes} write(s); a page is ${SWEEP_PAGE}`);
    // A page is read only after the one before it was written and its jobs retired.
    events.forEach((e, i) => {
      if (e === 'read' && i > 0) assert.equal(events[i - 1], 'retire', `a page was read before the one before it had its jobs retired: ${events.join(' ')}`);
    });
  });
});