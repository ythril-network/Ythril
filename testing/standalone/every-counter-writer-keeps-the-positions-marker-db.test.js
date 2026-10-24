/**
 * Every writer of a space's counter doc keeps the positions marker fields it does not own (bundle-81, design rev 8 §3 "The owed
 * marker", P34, P46).
 *
 * ## The finding this holds
 *
 * The space's `ythril_counters` doc now carries `positionsOwed` and `positionsReadyAt` (and `seqSeenBy6`), the one per-space
 * record that already moves with the space. A writer that rebuilds the doc from the seq alone erases them: `spaces/rename.ts`
 * does today (`replaceOne({_id: newId}, {_id: newId, seq})`, P34), so a renamed space would read as "neither field" and owe a
 * repair, or, worse, lose an owed marker and read as ready. The plan's answer is one module for the move
 * (`moveCounterDoc` in `sync/positions-owed.ts`) and a rule: no counter writer replaces the doc.
 *
 * ## What is derived, with a floor
 *
 * - **The writers:** every tracked `server/src` file (comments blanked) that names the counters collection (`ythril_counters`
 *   or a `COUNTERS` constant). Floor: 3 (`util/seq.ts`, `spaces/rename.ts`, `db/restore-act.ts` at 9a7ab3f7; the last writes
 *   through `bumpSeq`, so two of the three call a write method themselves).
 * - **The static rule:** among those files, `replaceOne(` and `findOneAndReplace(` are written only in `sync/positions-owed.ts`
 *   (which carries every marker field itself). A replacement is the one write shape that drops fields it does not name.
 * - **The runtime rule:** each writer a test can call is driven over a doc carrying `positionsOwed`, `positionsReadyAt` and
 *   `seqSeenBy6`, and the fields it does not own are read back. Drivers: the allocation (`withAllocatedSeqs`, or the plan's
 *   `versionsFor`), the raise (`bumpSeq`, or the plan's `raiseVersionTo`), and the move on a rename (`moveSpaceData` today,
 *   `moveCounterDoc` planned). At least three must run: a driver that cannot be found fails rather than being skipped.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: `spaces/rename.ts` replaces the counter doc (static rule) and `moveSpaceData` returns a counter with `seq`
 * and nothing else (runtime rule); `sync/positions-owed.ts` does not exist. Mutation for the newly covered part: make
 * `bumpSeq` build its update as a replacement and the allocation row names it. Restore by hand.
 *
 * Database prefix: `b81tE_`. Run: node --test testing/standalone/every-counter-writer-keeps-the-positions-marker-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openB81Mongo, closeB81Mongo, mongoSkipReason } from './_b81e-mongo.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const OWED_MODULE = 'server/src/sync/positions-owed.ts';
const NAMES_COUNTERS = /\bythril_counters\b|\bCOUNTERS\b/;
const WRITES = /\.(?:findOneAndUpdate|updateOne|updateMany|replaceOne|findOneAndReplace|insertOne|bulkWrite)\s*(?:<[^>]*>)?\s*\(/;
const REPLACES = /\.(?:replaceOne|findOneAndReplace)\s*(?:<[^>]*>)?\s*\(/;
const WRITER_FLOOR = 3;
const DRIVER_FLOOR = 3;

/** The drivers that ran to their assertion, in order: the floor below reads it. */
const ran = [];
const MARKERS = Object.freeze({ positionsOwed: 'repair', positionsReadyAt: '2026-10-01T00:00:00.000Z', seqSeenBy6: 41 });
const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
/** Files that name the counters collection: its writers, and the one that reads a backup's counter and writes through `bumpSeq`. */
const writers = () => trackedSources('server/src', { floor: 200 }).filter(f => NAMES_COUNTERS.test(codeOf(f)));
const writesDirectly = (f) => WRITES.test(codeOf(f));

let mongo;
before(async () => { if (!skip) mongo = await openB81Mongo('counters'); });
after(async () => { await closeB81Mongo(mongo); });

const counters = () => mongo.getDb().collection('ythril_counters');
/** Seed the doc for `id` with a seq and every marker field. */
const seed = (id, seq = 40) => counters().replaceOne({ _id: id }, { _id: id, seq, ...MARKERS }, { upsert: true });
/** The marker fields a doc holds, as a plain object (absent ones are absent). */
const markersOf = (doc) => Object.fromEntries(Object.keys(MARKERS).filter(k => doc && k in doc).map(k => [k, doc[k]]));

describe('every writer of a counter doc keeps the marker fields', () => {
  it('the writers are derived (at least three), and the plan\'s module is not among the replacers\' only home by accident', () => {
    const found = writers();
    assert.ok(found.length >= WRITER_FLOOR, `only ${found.length} counter writer file(s) derived (${found}): the derivation is broken`);
    assert.ok(found.filter(writesDirectly).length >= 2, 'fewer than two of them call a write method: the write pattern is broken');
    for (const must of ['server/src/util/seq.ts', 'server/src/spaces/rename.ts', 'server/src/db/restore-act.ts']) {
      assert.ok(found.includes(must), `${must} no longer writes the counters collection, or the pattern lost it (derived: ${found})`);
    }
  });

  it('no counter writer replaces the doc except the one module that carries every marker field', () => {
    const replacers = writers().filter(f => f !== OWED_MODULE && REPLACES.test(codeOf(f)));
    assert.deepEqual(replacers, [],
      'a counter writer REPLACES the doc, so every field it does not name is gone (P34: rename drops the marker fields): move it through `moveCounterDoc` in sync/positions-owed.ts');
  });

  it('sync/positions-owed.ts exists and exports moveCounterDoc', () => {
    assert.ok(existsSync(join(REPO_ROOT, OWED_MODULE)), `${OWED_MODULE} does not exist: no module owns the marker fields or the rename move`);
    assert.match(codeOf(OWED_MODULE), /export\s+(?:async\s+)?function\s+moveCounterDoc\b/, 'the module exports no moveCounterDoc');
  });

  describe('driven over a doc that carries the fields', { skip }, () => {
    it('the allocation keeps them', async () => {
      const space = 'b81e-alloc';
      await seed(space);
      const seqMod = await import('../../server/dist/util/seq.js');
      const stamp = await import('../../server/dist/util/version-stamp.js').catch(() => null);
      if (stamp?.versionsFor) await stamp.versionsFor(space, ['x']);
      else await seqMod.withAllocatedSeqs(space, 1, async () => undefined, 'b81e.test');
      assert.deepEqual(markersOf(await counters().findOne({ _id: space })), markersOf(MARKERS), 'the allocation dropped a marker field');
      ran.push('allocation');
    });

    it('the raise keeps them', async () => {
      const space = 'b81e-raise';
      await seed(space);
      const stamp = await import('../../server/dist/util/version-stamp.js').catch(() => null);
      if (stamp?.raiseVersionTo) await stamp.raiseVersionTo(space, 90);
      else await (await import('../../server/dist/util/seq.js')).bumpSeq(space, 90);
      const doc = await counters().findOne({ _id: space });
      assert.ok(doc.seq >= 90, `fixture: the raise did not run (seq ${doc.seq})`);
      assert.equal(doc.positionsOwed, MARKERS.positionsOwed);
      assert.equal(doc.positionsReadyAt, MARKERS.positionsReadyAt);
      ran.push('raise');
    });

    it('the move on a rename carries them', async () => {
      const [from, to] = ['b81e-old', 'b81e-new'];
      await seed(from, 40);
      const owed = await import('../../server/dist/sync/positions-owed.js').catch(() => null);
      if (owed?.moveCounterDoc) await owed.moveCounterDoc(from, to);
      else {
        const errors = await (await import('../../server/dist/spaces/rename.js')).moveSpaceData(from, to);
        assert.deepEqual(errors, [], 'fixture: the rename reported errors');
      }
      const moved = await counters().findOne({ _id: to });
      assert.ok(moved, 'the counter doc was not moved to the new id');
      assert.equal(moved.seq, 40);
      assert.deepEqual(markersOf(moved), markersOf(MARKERS),
        `the move kept ${JSON.stringify(markersOf(moved))} of ${JSON.stringify(MARKERS)}: a renamed space reads as having neither field`);
      ran.push('rename');
    });

    it('at least three drivers ran to their assertion: a driver that never ran would pass for nothing', () => {
      assert.ok(ran.length >= DRIVER_FLOOR, `only ${ran.length} driver(s) ran (${ran}): a case before this one failed or was removed`);
    });
  });
});
