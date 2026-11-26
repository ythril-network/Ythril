/**
 * The swap of a triple index leaves the index whole, or read from the records and rebuilt, whatever fails or stops midway (bundle-273,
 * Q-764, review findings F2, F6, F10 and the unproven points U1 and U2 of the S4 review; design-r2 R5).
 *
 * ## The rules
 *
 * 1. **F2: a failure between the state write and the last rename is never served.** The swap's first transaction marks the index `stale`;
 *    only its last, fenced transaction sets `ready`. A rename that throws leaves a state no query reads and the follower does not touch,
 *    and the upkeep rebuilds it (`stale`). Before: the first transaction wrote `catching-up`, the follower then set `ready`, and the
 *    dictionary of one build answered for the statements of another.
 * 2. **U1: a builder that stalls past its lease cannot rename over a build that took its place.** Each rename is fenced, and a swap that
 *    fails after its state was written marks the index `stale` again: the renames of the stalled build may have landed between those of
 *    the build that took over.
 * 3. **F6: the lease is renewed before each index build.** Index builds that together outlast the lease make a finished swap report
 *    `RebuildFenced` and leave its status `catching-up`.
 * 4. **F10: the swap resets the verify row.** New term ids start below the old `termAfter`, so the verify's pass over the dictionary ended
 *    at once on the old counts and asked for one more rebuild.
 * 5. **U2: a swap on a space that is written all the time still lands.** It waits for the follower's lease between runs.
 *
 * ## Seen red
 *
 * On 42c51f330: case 1 fails at the state after the failed swap (`catching-up`, not `stale`); case 2 fails at the index equal to its
 * records (the index is `ready` over a mix of two builds); case 3 fails with `RebuildFenced`; case 4 at the verify row, which stays.
 * Case 5 passes there (U2 is settled: the follower's runs leave gaps the swap's polls find).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-swap-is-whole-or-unread-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { elapse } from '../_shared/sleep.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixw-swap';
const ADMIN = { id: 'tixw-swap-admin', admin: true, rights: { instanceAdmin: true } };
const NAMES = `SELECT ?n WHERE { ?s a <${baseOf(S)}vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> ?n } ORDER BY ?n`;
const PERSONS = 40;
let d;
const state = () => d.col(`${S}_rdf_state`).findOne({ _id: 'state' });
const wantNames = Array.from({ length: PERSONS }, (_, i) => `Person ${String(i).padStart(2, '0')}`);

/** Run NAMES on a fresh quad source over S: the source and the sorted names it answered. */
async function ask() {
  const engine = await import('../../server/dist/rdf/sparql-engine.js');
  const { createQuadSource } = await import('../../server/dist/rdf/quad-source.js');
  const { readAcrossSwaps } = await import('../../server/dist/rdf/read-across-swaps.js');
  const checked = await engine.checkSparqlAlgebra(NAMES);
  const deadline = Date.now() + 60_000;
  let last;
  const texts = await readAcrossSwaps(
    (recordsFor) => (last = createQuadSource({ members: [S], caller: ADMIN }, { deadline, recordsFor })),
    async (source) => (await (await engine.runSparql(checked.algebra, source, { deadline })).rows(100_000, 64 * 1024 * 1024)).map(r => r.n.value).sort());
  return { source: last, texts };
}

/** Land a record (type `robot`, which NAMES never selects) whose terms sort before every person's: the next build's term ids move. */
const landRobot = (id) => landAll(d, S, [['entities', entityDoc(S, id, `Robot ${id}`, 'robot')]]);

/** Replace `renameCollection` of the database by `make(original)` until the returned function is called. */
async function overRename(make) {
  const { getDb } = await import('../../server/dist/db/mongo.js');
  const db = getDb();
  db.renameCollection = make(db.renameCollection.bind(db));
  return () => { delete db.renameCollection; };
}

describe('the triple index swap leaves the index whole or unread', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixw-swap', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: PERSONS }, (_, i) => ['entities', entityDoc(S, `p${String(i).padStart(2, '0')}`, `Person ${String(i).padStart(2, '0')}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('F2: a rename that throws leaves a stale index that is read from the records and rebuilt by the upkeep', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const { upkeepTripleIndex, tripleIndexRebuildReason } = await verifyModule();
    await landRobot('a-robot-1');
    await followUntilReady(d, S);
    let calls = 0;
    const restore = await overRename((original) => async (...args) => {
      if (++calls === 2) throw new Error('planted: the second rename failed');
      return original(...args);
    });
    try { await assert.rejects(rebuildTripleIndex(S), /planted/); } finally { restore(); }
    assert.equal(calls >= 2, true, 'the swap reached its renames');
    assert.equal((await state()).status, 'stale', 'a swap that failed after its state was written leaves the index stale');
    // The follower runs after the failure, as the next write would run it: it must not make a half-swapped index ready.
    const { followTripleIndexNow } = await import('../../server/dist/rdf/triple-index/follow.js');
    await followTripleIndexNow(S);
    assert.equal((await state()).status, 'stale', 'the follower leaves a stale index alone');
    const read = await ask();
    assert.deepEqual(read.source.readPaths(), [{ space: S, path: 'records' }], 'a stale index is read from the records');
    assert.deepEqual(read.texts, wantNames, 'and answers what the records answer');
    assert.equal(await tripleIndexRebuildReason(S), 'stale', 'the upkeep asks for a rebuild');
    const up = await upkeepTripleIndex(S, { verify: false });
    assert.deepEqual([up.reason, up.rebuilt, up.outcome], ['stale', 'stale', 'built']);
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
    const again = await ask();
    assert.deepEqual(again.source.readPaths(), [{ space: S, path: 'index' }], 'the rebuilt index is read again');
    assert.deepEqual(again.texts, wantNames);
  });

  it('U1: a build stalled past its lease between two renames cannot leave a mix of two builds read', async () => {
    const { beginTripleIndexBuild, fillTripleIndexBuild, swapTripleIndexBuild, rebuildTripleIndex } = await rebuildModule();
    const build = await beginTripleIndexBuild(S, { leaseMs: 500 });
    assert.ok(build, 'the build row was free');
    await fillTripleIndexBuild(build);
    let calls = 0;
    let stalled; const stalledAt = new Promise(r => { stalled = r; });
    let open; const gate = new Promise(r => { open = r; });
    const restore = await overRename((original) => async (...args) => {
      const mine = ++calls;
      const done = await original(...args);
      // The first build's first rename has landed; the build stalls, as a process paused over its lease would.
      if (mine === 1) { stalled(); await gate; }
      return done;
    });
    let first;
    try {
      first = swapTripleIndexBuild(build).then(() => ({ ok: true }), (err) => ({ ok: false, name: err?.name }));
      await stalledAt;
      await elapse(800, 'ttl elapses: the stalled build\'s lease of 500 ms, and its hold of the follower\'s lease, run out');
      await landRobot('a-robot-2');
      assert.equal((await rebuildTripleIndex(S)).outcome, 'built', 'a second build takes the row and swaps');
      open();
      await first;
    } finally { open(); restore(); }
    const st = await state();
    if (st.status === 'ready') await assertIndexEqualsRecords(assert, d, S);
    const read = await ask();
    assert.deepEqual(read.texts, wantNames, 'whatever the state, a query answers what the records answer');
    // And whatever it stands at, the upkeep leads it to an index that states its records.
    const { upkeepTripleIndex } = await verifyModule();
    await upkeepTripleIndex(S, { verify: false });
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });

  it('F6: index builds that together outlast the lease do not fence a finished swap', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    const { getDb } = await import('../../server/dist/db/mongo.js');
    const proto = Object.getPrototypeOf(getDb().collection('probe'));
    const original = proto.createIndex;
    const live = new Set(['terms', 'quads', 'records', 'state', 'dirty'].map(p => `${S}_rdf_${p}`));
    proto.createIndex = async function slow(...args) {
      if (live.has(this.collectionName)) await elapse(600, 'simulated latency: an index build over a large collection takes its time');
      return original.apply(this, args);
    };
    try {
      // Six indexes of 600 ms each outlast a lease of 2 s; none alone does.
      const r = await rebuildTripleIndex(S, { leaseMs: 2_000 });
      assert.equal(r.outcome, 'built');
    } finally { proto.createIndex = original; }
    assert.equal((await state()).status, 'ready', 'the swap finished and said so');
    await followUntilReady(d, S);
  });

  it('F10: the swap deletes the verify row, whose term cursor belongs to the old dictionary', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    await d.col(`${S}_rdf_state`).updateOne({ _id: 'verify' }, { $set: { kind: 0, termAfter: 999_999, termsSeen: 10, termsUnused: 9 } }, { upsert: true });
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    assert.equal(await d.col(`${S}_rdf_state`).findOne({ _id: 'verify' }), null, 'the verify of the new index starts from its first term');
    await followUntilReady(d, S);
  });

  it('U2: a space that is written all the time is swapped in all the same', async () => {
    const { rebuildTripleIndex } = await rebuildModule();
    let writing = true;
    const writes = (async () => {
      let n = 0;
      while (writing) { await landRobot(`w${n}`); n++; }
      return n;
    })();
    let r;
    try { r = await rebuildTripleIndex(S); } finally { writing = false; }
    const n = await writes;
    assert.equal(r.outcome, 'built', `a rebuild under ${n} writes lands`);
    assert.ok(n >= 3, `writes were landing while it swapped: ${n}`);
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });
});
