/**
 * A file row flagged BEFORE the flag-time strip existed is stripped by one idempotent pass per space, isolated per space
 * (bundle-89, E2, Q-418; plan item 10).
 *
 * ## The defect it prevents
 *
 * The fix strips the derived fields in the same write that flags a deleted file's row, but that is forward-only: rows flagged by
 * an earlier release still hold the vector, the matched-text snippet, the excerpt, the content hash, the processing state and
 * a machine-made description — bytes' worth of the deleted file, for ever, on a space with no file window (the reap never
 * reaches it). The fields are LOCAL (`pitfall-migrating-synced-data-at-boot` does not bite), so a bounded pass over the flagged
 * rows of each space, through the housekeeping walk, repairs them.
 *
 * ## The rule
 *
 *  1. a flagged row loses `embedding`, `embeddingModel`, `matchedText`, `excerpt`, `sha256` and `embeddingStatus`
 *  2. a MACHINE-made description goes with its marker (`descriptionSource` `generated` or `extracted`); a person's description
 *     (no marker) stays, as do path, author, tags, properties and the flag itself
 *  3. a live row is not touched, field for field
 *  4. a second pass changes nothing
 *  5. ONE space failing does not stop the pass for the others
 *
 * ## The entry point driven, and why it is a guess
 *
 * The plan names no entry point for the pass. Every case runs it through `runPass()` below, which is the real TTL sweep cycle
 * (`sweepExpired`): the housekeeping tick that already carries bounded per-space local-state passes (`drainStrayFileMeta`).
 * A pass the implementation runs from somewhere else (a boot step, its own interval job) changes that one function.
 * The spaces carry NO file window, so the sweep reaps nothing and what changes is the strip alone.
 *
 * Run: node --test testing/standalone/a-row-flagged-before-the-strip-is-stripped-once-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** The failing space is FIRST in the config, so the walk reaches it before the healthy one. */
const BAD = 'b89e2dstripa';
const GOOD = 'b89e2dstripb';
const NOW = new Date('2026-10-01T00:00:00.000Z');
const FLAGGED_AT = '2026-06-01T00:00:00.000Z';

/** What bytes' worth of a deleted file a row held when it was flagged by a release before the strip. */
const DERIVED = ['embedding', 'embeddingModel', 'matchedText', 'excerpt', 'sha256', 'embeddingStatus'];
const derivedFields = () => ({
  embedding: [0.1, 0.2, 0.3], embeddingModel: 'old-model', matchedText: 'a snippet of the deleted file',
  excerpt: 'the opening prose of the deleted file', sha256: 'a'.repeat(64), embeddingStatus: 'complete',
});
const without = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

/** The rows of a space as seeded: three flagged (machine description, extracted description, a person's) and one live. */
function seedRows(space) {
  const flagged = (id, extra) => build.filemeta(space, id, 3, { deletedAt: FLAGGED_AT, sizeBytes: 12, tags: ['kept'], properties: { k: 'v' }, ...derivedFields(), ...extra });
  return [
    flagged('f/generated.txt', { description: 'machine text', descriptionSource: 'generated' }),
    flagged('f/extracted.txt', { description: 'opening prose', descriptionSource: 'extracted' }),
    flagged('f/human.txt', { description: 'written by a person' }),
    build.filemeta(space, 'f/live.txt', 4, { sizeBytes: 12, ...derivedFields(), description: 'machine text', descriptionSource: 'generated' }),
  ];
}
/** What each seeded row must be after the pass. */
function stripped(rows) {
  return rows.map(r => {
    if (r.deletedAt === undefined) return r;
    const machine = r.descriptionSource !== undefined;
    return without(r, [...DERIVED, ...(machine ? ['description', 'descriptionSource'] : [])]);
  });
}

let door, ttl;

const stored = async (space) => (await door.coll(space, 'files').find({}).toArray()).sort((a, b) => String(a._id).localeCompare(String(b._id)));
const byId = (rows) => [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id)));
/** The one place the pass is run. */
const runPass = () => ttl.sweepExpired(NOW);

/** Make every read and write on one space's `files` collection throw, while `fn` runs. */
async function whileFailing(space, fn) {
  const proto = Object.getPrototypeOf(door.mongo.col('probe'));
  const names = ['find', 'findOne', 'aggregate', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'bulkWrite',
    'replaceOne', 'findOneAndUpdate', 'deleteOne', 'deleteMany'];
  const originals = Object.fromEntries(names.map(n => [n, proto[n]]));
  for (const n of names) {
    proto[n] = function wrapped(...args) {
      if (this.collectionName === `${space}_files`) throw new Error(`injected: ${n} on ${space}_files refused`);
      return originals[n].apply(this, args);
    };
  }
  try { return await fn(); } finally { for (const n of names) proto[n] = originals[n]; }
}

describe('a row flagged before the strip existed is stripped by one idempotent pass per space', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'b89e2dstrip',
      spaces: [BAD, GOOD].map(id => ({ id, label: id, folders: [], meta: { suppressEmbeddings: true } })),
    });
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    for (const s of [BAD, GOOD]) {
      await door.coll(s, 'files').deleteMany({});
      await door.coll(s, 'files').insertMany(seedRows(s));
    }
  });

  it('strips the derived fields of every flagged row and a machine-made description with its marker, and keeps a person\'s', async () => {
    await runPass();
    for (const s of [BAD, GOOD]) {
      assert.deepEqual(byId((await stored(s)).filter(r => r.deletedAt !== undefined)),
        byId(stripped(seedRows(s)).filter(r => r.deletedAt !== undefined)),
        `${s}: the flagged rows after the pass (left side) are not the seeded rows minus [${DERIVED}] and a machine-made description with its marker`);
    }
  });

  it('leaves a live row exactly as it was', async () => {
    await runPass();
    for (const s of [BAD, GOOD]) {
      assert.deepEqual(await door.coll(s, 'files').findOne({ _id: 'f/live.txt' }), seedRows(s).find(r => r._id === 'f/live.txt'),
        `${s}: the pass changed a LIVE file's row`);
    }
  });

  it('a second pass changes nothing', async () => {
    await runPass();
    const first = { [BAD]: await stored(BAD), [GOOD]: await stored(GOOD) };
    assert.deepEqual(first[GOOD].find(r => r._id === 'f/generated.txt'), stripped(seedRows(GOOD))[0],
      'fixture: the first pass did not strip the row, so there is nothing for a second to leave alone');
    await runPass();
    assert.deepEqual({ [BAD]: await stored(BAD), [GOOD]: await stored(GOOD) }, first, 'a second pass wrote to rows the first had already stripped');
  });

  it('one space failing does not stop the pass for the space after it', async () => {
    await whileFailing(BAD, () => runPass());
    assert.deepEqual(byId((await stored(GOOD)).filter(r => r.deletedAt !== undefined)),
      byId(stripped(seedRows(GOOD)).filter(r => r.deletedAt !== undefined)),
      `${GOOD}: the pass was not run for the healthy space because ${BAD}, ahead of it in the walk, failed`);
    assert.deepEqual(byId(await stored(BAD)), byId(seedRows(BAD)), `${BAD}: its own rows must be as they were (nothing could be written)`);
  });
});
