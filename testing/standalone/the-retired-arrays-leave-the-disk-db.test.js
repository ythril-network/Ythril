/**
 * The boot migration clears the 4.x link arrays off disk — AFTER the conversion has read them.
 *
 * Runs in the OFFLINE subset, like every other `-db` file here: it drives a real MongoDB through the
 * server's own data layer and needs no running instance.
 *
 * ## Why undeclaring the fields is not enough, and the reason is the HASH
 *
 * 5.0 removes the six arrays from the document types, the ingest schemas and every reader. A key already
 * on disk survives all of that — TypeScript describes what the code expects, not what Mongo holds. And
 * `brain/merkle.ts` hashes facts and chrono entries by EXCLUSION, so a leftover `entityIds` is still part
 * of a space's hash: two peers holding identical data, one upgraded from 4.x and one not, would disagree
 * on every space hash and log `MERKLE_DIVERGENCE` every cycle, permanently, about nothing. The check is
 * advisory, so nothing ever contradicts it — and a permanent false alarm teaches an operator to ignore the
 * one signal that means data really is missing.
 *
 * ## The ORDER is the dangerous half
 *
 * `convertLinksOnBoot` reads those arrays to create the link records that replace them. Run the clear
 * first and it deletes the only copy of an unconverted space's pre-upgrade links — silently, because an
 * empty array and a converted array look identical to everything downstream. So the clear runs last, and
 * only over spaces the conversion has MARKED.
 *
 * Both halves are asserted here: what it clears, and what it refuses to touch.
 *
 * Run: node --test testing/standalone/the-retired-arrays-leave-the-disk-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-drop-arrays-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

/** Converted — the conversion has walked it cleanly, so its arrays are a duplicate of its link records. */
const DONE = 'general';
/** NOT converted — its arrays are still the only copy of its links. */
const LEFT = 'stranded';

const ENT = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const MEM = 'aaaaaaaa-0000-4000-8000-0000000000m1'.replace('m', '1');
const CHR = 'aaaaaaaa-0000-4000-8000-0000000000c1'.replace('c', '1');

let mongo, loader, drop;

const coll = (space, name) => mongo.col(`${space}_${name}`);

describe('the retired link arrays leave the disk', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('droparrays');
    loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'drop-arrays-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: DONE, label: 'General', builtIn: true, folders: [], completeLinkage: true },
        { id: LEFT, label: 'Stranded', folders: [] },
      ],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    drop = await import('../../server/dist/db/drop-link-arrays.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /**
   * Raw inserts, on purpose: this is the 4.x shape, and no writer in the tree can produce it any more.
   *
   * The fields are gone from the document types, so the only way to stand up the state an upgraded space
   * is actually in is to write it behind the types — which is exactly what an upgrade is.
   */
  beforeEach(async () => {
    for (const space of [DONE, LEFT]) {
      for (const c of ['facts', 'chrono', 'files']) await coll(space, c).deleteMany({});
      await coll(space, 'facts').insertOne({ _id: 'f-1', spaceId: space, fact: 'a fact', entityIds: [ENT], seq: 1 });
      await coll(space, 'chrono').insertOne({
        _id: 'c-1', spaceId: space, title: 'an entry', entityIds: [ENT], memoryIds: [MEM], seq: 2,
      });
      await coll(space, 'files').insertOne({
        _id: 'notes/a.md', spaceId: space, path: 'notes/a.md',
        entityIds: [ENT], memoryIds: [MEM], chronoIds: [CHR], seq: 3,
      });
    }
  });

  it('clears all six keys off a CONVERTED space, and reports what it cleared', async () => {
    const out = await drop.dropLinkArrays();

    for (const [c, id] of [['facts', 'f-1'], ['chrono', 'c-1'], ['files', 'notes/a.md']]) {
      const doc = await coll(DONE, c).findOne({ _id: id });
      for (const key of ['entityIds', 'memoryIds', 'chronoIds']) {
        assert.ok(!(key in doc), `${c}.${key} survived the clear: ${JSON.stringify(doc)}`);
      }
    }
    // Counted per collection, because "it ran" and "it changed something" are different claims and a
    // migration that reports nothing cannot be told from one that did nothing.
    assert.equal(out.cleared[`${DONE}_facts`], 1);
    assert.equal(out.cleared[`${DONE}_chrono`], 1);
    assert.equal(out.cleared[`${DONE}_files`], 1);
  });

  it('and leaves the record otherwise untouched — this clears a field, it does not rewrite a row', async () => {
    await drop.dropLinkArrays();
    const fact = await coll(DONE, 'facts').findOne({ _id: 'f-1' });
    assert.equal(fact.fact, 'a fact');
    /*
     * `seq` is the sync cursor. Bumping it would make every record in every space look newer than its
     * copy on a peer that has also migrated, dragging a full re-pull of the corpus behind a change that
     * moved no data.
     */
    assert.equal(fact.seq, 1, 'the seq moved, so every peer will re-pull a record whose content is identical');
  });

  it('REFUSES to touch a space the conversion has not marked, and names it', async () => {
    /*
     * The order this migration exists to respect. An unconverted space holds its pre-upgrade links in
     * those arrays and nowhere else, so clearing them is the one irreversible thing in this file — and an
     * empty array and a converted array look identical to everything downstream, so nothing would report
     * it afterwards.
     */
    const out = await drop.dropLinkArrays();
    const doc = await coll(LEFT, 'facts').findOne({ _id: 'f-1' });
    assert.deepEqual(doc.entityIds, [ENT],
      'an unconverted space lost the only copy of its links');
    assert.ok(out.unconverted.includes(LEFT),
      `the skipped space must be named so an operator can act on it: ${JSON.stringify(out.unconverted)}`);
    assert.equal(out.cleared[`${LEFT}_facts`], undefined, 'it reported clearing a space it must not touch');
  });

  it('is idempotent: a second boot finds nothing to clear', async () => {
    await drop.dropLinkArrays();
    const second = await drop.dropLinkArrays();
    assert.equal(second.cleared[`${DONE}_facts`], undefined,
      'the second run reported work, so the first did not finish or the query matches a cleared record');
  });
});
