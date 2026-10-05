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
 *    finished — here: while space A's first write is held, space B has not been touched.
 *  - **In pages.** The ids of a large space are read a page at a time, each page updated and its jobs retired before the
 *    next page is read, so a space of hundreds of thousands of records never holds every id (or one delete over them
 *    all) at once.
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
import { parkWrites } from './_write-faults.mjs';
import { MUTATORS } from './_space-writers.mjs';

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
const PAGE = 1_000;

let door, sweepEverySpaceAtBoot, log, proto, park;

const has = async (space, part, id) => 'embedding' in ((await door.coll(space, part).findOne({ _id: id })) ?? {});
const fact = (space, id, extra = {}) => ({ ...build.fact(space, id, 1), ...VEC, ...extra });
const file = (space, id, extra = {}) => ({ ...build.filemeta(space, id, 1), ...VEC, ...extra });

async function infoLines(fn) {
  const lines = [];
  const orig = log.info;
  log.info = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { log.info = orig; }
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
    ({ sweepEverySpaceAtBoot } = await import('../../server/dist/brain/suppression-sweep.js'));
    ({ log } = await import('../../server/dist/util/log.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => { for (const s of [A, B, C, P]) await door.wipe(s); });

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
    const lines = await infoLines(() => sweepEverySpaceAtBoot());
    assert.deepEqual(lines.sort(), [
      `Suppression sweep: removed 1 fact vector(s) in ${A}`,
      `Suppression sweep: removed 2 file vector(s) in ${A}`,
      `Suppression sweep: removed 1 fact vector(s) in ${B}`,
      `Suppression sweep: removed 2 file vector(s) in ${B}`,
    ].sort());
  });

  it('one space at a time: while the first space\'s write is held, the next has not been touched', async () => {
    await seedAll();
    park = parkWrites(proto);
    const held = park.arm(`${A}_facts`);
    const running = sweepEverySpaceAtBoot();
    await held.reached;
    await new Promise(r => setTimeout(r, 400));
    assert.equal(await has(B, 'facts', 'b-flagged'), true, 'space B was swept while space A\'s sweep was still in flight');
    held.release();
    await running;
    park.restore(); park = undefined;
    assert.equal(await has(B, 'facts', 'b-flagged'), false, 'space B was never swept');
  });

  it('a large space is read and updated in pages, each page\'s jobs retired before the next is written', async () => {
    const N = 2_500;
    const ids = Array.from({ length: N }, (_, i) => `p${String(i).padStart(4, '0')}`);
    await door.coll(P, 'facts').insertMany(ids.map(id => fact(P, id)));
    await door.coll(P, 'embed_jobs').insertMany(ids.map(id => ({ _id: `fact:${id}`, recordType: 'fact', recordId: id, status: 'pending' })));
    const events = [];
    const originals = {};
    for (const m of MUTATORS) {
      originals[m] = proto[m];
      proto[m] = function recording(...args) {
        if (this.collectionName === `${P}_facts`) events.push('write');
        else if (this.collectionName === `${P}_embed_jobs`) events.push('retire');
        return originals[m].apply(this, args);
      };
    }
    try { await sweepEverySpaceAtBoot(); } finally { for (const [m, f] of Object.entries(originals)) proto[m] = f; }
    assert.equal(await door.coll(P, 'facts').countDocuments({ embedding: { $exists: true } }), 0, 'a vector survived');
    assert.equal(await door.coll(P, 'embed_jobs').countDocuments({}), 0, 'a job survived');
    const writes = events.filter(e => e === 'write').length;
    assert.ok(writes >= Math.ceil(N / PAGE), `${N} records were written in ${writes} write(s); a page is ${PAGE}`);
    // Between two page writes the first page's jobs are retired.
    for (let i = 0, seen = 0; i < events.length; i++) {
      if (events[i] === 'write') { if (seen > 0) assert.equal(events[i - 1], 'retire', `page ${seen + 1} was written before page ${seen}'s jobs were retired: ${events.join(' ')}`); seen++; }
    }
  });
});