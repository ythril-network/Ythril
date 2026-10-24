/**
 * A pull never serves a position at or above one that is stamped but not yet committed, and its `through` never passes it
 * (bundle-81, Q-196's rule restated under the clock; plan rev 8 §1b, §6b, §9 test 14, decisions 8 and 30).
 *
 * Replaces `a-pull-never-passes-an-uncommitted-seq-db` (its case at `:304-325`, P4). The rule that file holds is unchanged and moves
 * from a seq to a position: a write takes its position BEFORE its record commits, a puller stores the highest `through` it is handed as
 * its mark, so a position handed out above an uncommitted one loses the uncommitted record for that peer for good.
 *
 * ## The rule this file holds
 *
 * **While a position is stamped and its write has not settled, no position-paged pull route serves a record at or above it, and the
 * `through` it answers is below it. Once the write settles, both records are served.** Three shapes of "not yet settled":
 *
 *  1. A single write parked between its stamp and its commit, on every route that pages by position.
 *  2. A TRANSACTION: a merge and an edge relabel parked inside `inHeldTransaction`. A write inside a session has not committed when it
 *     returns, so the hold is the transaction's (`withPositionFloorHeld`, decision 8), not the write's.
 *  3. The file-MOVE transaction (decision 30): it rebuilds file rows through `rebuiltFileRow`, which stamps a position, so it runs through
 *     `inHeldTransaction` and not through a bare bounded transaction.
 *
 * ## How a write is held, and what identifies it
 *
 * The REAL writer runs; the first write to the target collection whose arguments carry a numeric `pos` is parked
 * (`_b81c-park.mjs`), and `reached` hands back that number, which proves the hold sits between the stamp and the commit. A writer that
 * finishes without ever carrying a `pos` is reported as that: the code does not stamp a position. Records are identified by `_id` (a
 * position is local-only and is never on the wire), and `through` is the page's own number.
 *
 * ## Which routes: derived, never listed
 *
 * Every GET registration in `server/src/api/sync/*.ts` whose handler pages a collection (`pageBySeq`/`pageByPosition`, `readAfterSeq`/
 * `readAfterPosition`, `listTombstones`). Each needs a case below; a new one without a case fails the coverage test.
 *
 * Database `b81tC_pullpos`, dropped on entry and exit.
 *
 * Run: node --test testing/standalone/a-pull-never-passes-an-uncommitted-position-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor } from './_b81c-door.mjs';
import { parkPositionWrites } from './_b81c-park.mjs';
import { peerToken, build } from './_push-door.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom } from './_structural-window.mjs';

const skip = await mongoSkipReason();
const HOLD_TIMEOUT = 30_000;
const PEER = peerToken('b81c-puller');
const U = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENT_A = U(1), ENT_B = U(2), FACT_1 = U(11), FACT_2 = U(12);

/** The pull routes, derived from the sync doors: every GET whose handler pages a collection. */
function pagedRoutes() {
  const paged = /pageBySeq|pageByPosition|readAfterSeq\(|readAfterPosition\(|listTombstones\(/;
  const out = [];
  for (const file of execFileSync('git', ['ls-files', 'server/src/api/sync'], { encoding: 'utf8', cwd: new URL('../../', import.meta.url) }).trim().split('\n')) {
    if (!file.endsWith('.ts')) continue;
    const src = stripComments(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
    for (const m of src.matchAll(/(\w+Router)\.get\(\s*'([^']+)'/g)) {
      if (m[2].includes(':')) continue;
      // The whole registration, by structure (braces and the statement's end), not up to the first semicolon.
      if (paged.test(statementFrom(src, m.index, `${file} ${m[2]}`))) out.push({ file, path: m[2] });
    }
  }
  return out;
}
const ROUTES = pagedRoutes();

describe('a pull never passes an uncommitted position', { skip }, () => {
  let door, park, mods;
  const SPACES = ['h-facts', 'h-entities', 'h-edges', 'h-chrono', 'h-links', 'h-filemeta', 'h-tombstones', 'h-merge', 'h-relabel'];

  /** One case per paged route: the collection it serves, and two REAL writes into it. */
  const CASES = () => ({
    '/facts': { coll: 'facts', space: 'h-facts',
      first: () => mods.fact.saveFact('h-facts', 'held fact', [], [], undefined, undefined, 'note'),
      second: () => mods.fact.saveFact('h-facts', 'later fact', [], [], undefined, undefined, 'note') },
    '/entities': { coll: 'entities', space: 'h-entities',
      first: () => mods.ents.upsertEntity('h-entities', 'Held', 'concept', [], {}),
      second: () => mods.ents.upsertEntity('h-entities', 'Later', 'concept', [], {}) },
    '/edges': { coll: 'edges', space: 'h-edges',
      first: () => mods.edges.upsertEdge('h-edges', ENT_A, ENT_B, 'held'),
      second: () => mods.edges.upsertEdge('h-edges', ENT_A, ENT_B, 'later') },
    '/chrono': { coll: 'chrono', space: 'h-chrono',
      first: () => mods.chrono.createChrono('h-chrono', { title: 'held', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }),
      second: () => mods.chrono.createChrono('h-chrono', { title: 'later', type: 'event', startsAt: '2026-01-02T00:00:00.000Z' }) },
    '/links': { coll: 'links', space: 'h-links',
      first: () => mods.links.addLink('h-links', FACT_1, 'fact', ENT_A, 'entity'),
      second: () => mods.links.addLink('h-links', FACT_2, 'fact', ENT_A, 'entity') },
    '/filemeta': { coll: 'files', space: 'h-filemeta',
      first: () => mods.fileMeta.upsertFileMeta('h-filemeta', 'held.md', 10),
      second: () => mods.fileMeta.upsertFileMeta('h-filemeta', 'later.md', 10) },
    '/tombstones': { coll: 'tombstones', space: 'h-tombstones',
      first: () => mods.fact.deleteFact('h-tombstones', FACT_1),
      second: () => mods.fact.deleteFact('h-tombstones', FACT_2) },
  });

  before(async () => {
    door = await openB81cDoor({ name: 'pullpos', spaces: SPACES });
    mods = {
      fact: await import('../../server/dist/brain/fact.js'),
      ents: await import('../../server/dist/brain/entities.js'),
      edges: await import('../../server/dist/brain/edges.js'),
      chrono: await import('../../server/dist/brain/chrono.js'),
      links: await import('../../server/dist/brain/links.js'),
      fileMeta: await import('../../server/dist/files/file-meta.js'),
      merge: await import('../../server/dist/brain/merge.js'),
    };
  });
  after(async () => { park?.restore(); await door?.close(); });

  beforeEach(async () => {
    park?.restore();
    park = parkPositionWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    for (const s of SPACES) {
      await door.wipe(s);
      await door.coll(s, 'entities').insertMany([
        build.entity(s, ENT_A, 0), build.entity(s, ENT_B, 0),
      ]);
      await door.coll(s, 'facts').insertMany([build.fact(s, FACT_1, 0), build.fact(s, FACT_2, 0)]);
    }
  });

  /** What a page delivered, as ids, and its `through`. */
  const delivered = (body) => ({
    ids: (Array.isArray(body?.items) ? body.items : Object.values(body ?? {}).flat().filter(x => x && typeof x === 'object')).map(i => i._id),
    through: body?.through,
  });
  /** One pull of `route` from position 0, as a peer. */
  async function pullAll(route, space) {
    const r = await door.pull(route, { spaceId: space, afterPos: '0' }, PEER);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    return delivered(r.body);
  }

  it('the derivation finds the position-paged pull routes, so an empty set cannot pass', () => {
    assert.ok(ROUTES.length >= 6, `only ${ROUTES.length} paged route(s) derived — the sweep is broken: ${JSON.stringify(ROUTES)}`);
  });

  it('every derived paged route has a held-write case', () => {
    const missing = ROUTES.filter(r => !CASES()[r.path]).map(r => `${r.file} GET ${r.path}`);
    assert.deepEqual(missing, [], 'a position-paged pull route with no case here is one nobody checked for the hold');
  });

  for (const route of ROUTES) {
    it(`GET ${route.path}: a page stops below a held write, then serves both once it settles`, { timeout: HOLD_TIMEOUT }, async () => {
      const c = CASES()[route.path];
      if (!c) return; // reported by the coverage case above
      const hold = park.arm(`${c.space}_${c.coll}`);
      const firstWrite = c.first();
      const parked = await Promise.race([
        hold.reached,
        firstWrite.then(() => { throw new Error(`the first ${c.coll} write finished without a write carrying a numeric pos: this build stamps no position`); }),
      ]);
      assert.equal(typeof parked.pos, 'number');
      let during, later;
      try {
        await c.second();
        later = await door.coll(c.space, c.coll).find({ pos: { $gt: parked.pos } }).sort({ pos: 1 }).limit(1).next();
        assert.ok(later, `the second ${c.coll} write did not commit above the held position ${parked.pos}`);
        during = await pullAll(route.path, c.space);
      } finally {
        hold.release();
        await firstWrite;
      }
      assert.ok(!during.ids.includes(later._id),
        `GET ${route.path} served ${later._id} (position ${later.pos}) while position ${parked.pos} was stamped and uncommitted: `
        + 'a peer stores the highest `through` it is handed, so the held record is never pulled by that peer');
      assert.equal(typeof during.through, 'number', `GET ${route.path} answered no integer \`through\``);
      assert.ok(during.through < parked.pos, `GET ${route.path} answered through ${during.through}, at or past the uncommitted ${parked.pos}`);
      const settled = await pullAll(route.path, c.space);
      assert.ok(settled.ids.includes(later._id), `after it settled, ${later._id} is not served`);
      const heldRow = await door.coll(c.space, c.coll).findOne({ pos: parked.pos });
      assert.ok(heldRow && settled.ids.includes(heldRow._id), 'after it settled, the held record is not served');
    });
  }

  describe('a transaction holds the floor until it commits (decision 8)', () => {
    /** Park the first position-carrying write of `fn` that runs inside a session, serve a concurrent create, and pull. */
    async function heldInTransaction({ space, coll, route, fn, concurrent }) {
      const hold = park.arm(`${space}_${coll}`, { when: (m, args) => args.some(x => x && typeof x === 'object' && x.session !== undefined) });
      const run = fn();
      const parked = await Promise.race([
        hold.reached,
        run.then(() => { throw new Error(`${coll}: the operation ended without a session write carrying a numeric pos`); }),
      ]);
      let during;
      try {
        await concurrent();
        during = await pullAll(route, space);
      } finally { hold.release(); await run; }
      return { parked, during, settled: await pullAll(route, space) };
    }

    it('a merge parked inside inHeldTransaction is not paged past before it commits', { timeout: HOLD_TIMEOUT }, async () => {
      const r = await heldInTransaction({
        space: 'h-merge', coll: 'entities', route: '/entities',
        fn: () => mods.merge.mergeEntities('h-merge', ENT_A, ENT_B, []),
        concurrent: () => mods.ents.upsertEntity('h-merge', 'Concurrent', 'concept', [], {}),
      });
      const concurrent = await door.coll('h-merge', 'entities').findOne({ name: 'Concurrent' });
      assert.ok(concurrent, 'the concurrent create did not land');
      assert.ok(!r.during.ids.includes(concurrent._id), 'a create stamped above the merge\'s floor was served before the merge committed');
      assert.ok(typeof r.during.through === 'number' && r.during.through < r.parked.pos, `through ${r.during.through} passed the merge's uncommitted position ${r.parked.pos}`);
      assert.ok(r.settled.ids.includes(concurrent._id) && r.settled.ids.includes(ENT_A), 'after the commit, both are not served');
    });

    it('an edge relabel parked inside inHeldTransaction is not paged past before it commits', { timeout: HOLD_TIMEOUT }, async () => {
      const edge = await mods.edges.upsertEdge('h-relabel', ENT_A, ENT_B, 'before');
      const edgeId = edge._id ?? edge.id;
      const r = await heldInTransaction({
        space: 'h-relabel', coll: 'edges', route: '/edges',
        fn: () => mods.edges.updateEdgeById('h-relabel', edgeId, { label: 'after' }),
        concurrent: () => mods.edges.upsertEdge('h-relabel', ENT_B, ENT_A, 'concurrent'),
      });
      const concurrent = await door.coll('h-relabel', 'edges').findOne({ label: 'concurrent' });
      assert.ok(concurrent, 'the concurrent create did not land');
      assert.ok(!r.during.ids.includes(concurrent._id), 'a create stamped above the relabel\'s floor was served before the relabel committed');
      assert.ok(typeof r.during.through === 'number' && r.during.through < r.parked.pos, `through ${r.during.through} passed the relabel's uncommitted position ${r.parked.pos}`);
      assert.ok(r.settled.ids.includes(concurrent._id), 'after the commit, the concurrent edge is not served');
    });
  });

  describe('every transaction that stamps a position is held (decision 30)', () => {
    it('the file-move transaction (files/move-cascade.ts) runs through inHeldTransaction, not a bare bounded transaction', () => {
      const root = new URL('../../', import.meta.url);
      // Derived: the files that call `rebuiltFileRow` (the function that stamps the moved rows), other than its own module.
      const callers = execFileSync('git', ['grep', '-l', '-E', 'rebuiltFileRow\\(', '--', 'server/src'], { encoding: 'utf8', cwd: root })
        .trim().split('\n').filter(f => f && f !== 'server/src/files/move-plan.ts');
      assert.ok(callers.length >= 1, 'no caller of rebuiltFileRow found: the derivation is broken');
      for (const f of callers) {
        const src = stripComments(fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
        assert.match(src, /\binHeldTransaction\(/, `${f} stamps moved file rows but starts no inHeldTransaction: a reader can page past the uncommitted move`);
        assert.doesNotMatch(src, /\binBoundedTransaction\(/, `${f} starts a bare bounded transaction around a position-stamping write`);
      }
    });
  });
});
