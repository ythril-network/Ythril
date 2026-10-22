/**
 * The stray file-metadata drain reads its pages by `_id` the way the one pager does: no trailing read after a short page, no page
 * spent on an empty read, and only the fields it uses (`Q-481`, design rev 4 items 4 and 9).
 *
 * ## What is held
 *
 * The drain (`sync/stray-filemeta-drain.ts`) reads `<space>_filemeta` in two passes (fresh records, then those already waiting),
 * sharing one `maxPages` across both. Its hand loop read again after every page until a read came back EMPTY, so a pass whose last
 * page was short paid one more round trip for nothing, and it read whole stored rows although it hands on only the wire keys.
 *
 *  - **A short page ends its pass**: the fresh pass over fewer rows than a page sends ONE find, and over a page and a half sends
 *    two, with no trailing empty read. Counted on the driver's own command events, per pass, by the pass's filter.
 *  - **An empty page spends no `maxPages`**: with `maxPages: 1`, an empty fresh pass still leaves the waiting pass its one page.
 *    This holds at the base already (`pages++` follows the empty check) and is GREEN there by nature: it is here so the conversion
 *    cannot lose it, not to be seen red.
 *  - **The projection is the wire keys plus `keptSince`**, derived from the exported `FILE_META_WIRE_KEYS`
 *    (`api/sync/_shared.ts`), never typed out: the drain hands `admitArrivals` the record through `fileMetaForWire`, which keeps
 *    only those keys, and reads `keptSince` itself (the wait clock). A key the schema gains travels without an edit here.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-stray-drain-reads-by-the-id-pager-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const SUITE = 'straypager';
const SPACE = 'stray-pager';
const LOCAL = { instanceId: `${SUITE}-receiver`, instanceLabel: 'Receiver' };
const PEER = { instanceId: 'stray-pager-peer', instanceLabel: 'Peer' };
const STAMPED_AT = '2025-01-01T00:00:00.000Z';
const STRAY = `${SPACE}_filemeta`;

let door, drainStrayFileMeta, shared;
/** Every `find` the server's client sent on the stray collection, as the driver handed it over. */
const finds = [];

/** The file row this instance made by default, and the stray record a 4.0-5.6.1 pull stored for it (as the hung-space test seeds). */
const row = (id) => build.filemeta(SPACE, id, 900, { author: LOCAL, createdAt: STAMPED_AT, updatedAt: STAMPED_AT, sizeBytes: 11, sha256: 'receiver-hash' });
const stray = (id, extra = {}) => ({ ...build.filemeta(SPACE, id, 20, { author: PEER }), sizeBytes: 999, sha256: 'sender-hash', description: `recovered for ${id}`, tags: ['t'], ...extra });
const strayExists = async () => (await door.mongo.getDb().listCollections({ name: STRAY }).toArray()).length > 0;

/** Which pass a find belongs to, read off its filter: the fresh pass asks for no `keptSince`, the waiting pass for an older one. */
function passOf(command) {
  const f = JSON.stringify(command.filter ?? {});
  if (f.includes('"keptSince":{"$exists":false}')) return 'fresh';
  if (f.includes('"keptSince":{"$lt":')) return 'waiting';
  return 'other';
}

async function seed(ids, extra = {}) {
  await door.coll(SPACE, 'files').insertMany(ids.map(row));
  await door.coll(SPACE, 'filemeta').insertMany(ids.map(id => stray(id, extra)));
}

describe('the stray drain pages as the id pager does', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [{ id: SPACE, label: SPACE, folders: [] }], monitorCommands: true });
    door.mongo.getMongo().on('commandStarted', (ev) => {
      if (ev.commandName === 'find' && ev.command?.find === STRAY) finds.push(ev.command);
    });
    ({ drainStrayFileMeta } = await import('../../server/dist/sync/stray-filemeta-drain.js'));
    shared = await import('../../server/dist/api/sync/_shared.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.coll(SPACE, 'files').deleteMany({});
    await door.mongo.getDb().collection(STRAY).drop().catch(() => {});
    finds.length = 0;
  });

  it('a pass over fewer rows than a page sends one find, not a trailing empty one', async () => {
    await seed(['a.md', 'b.md', 'c.md']);
    finds.length = 0;
    await drainStrayFileMeta({ pageSize: 10, maxPages: 20 });
    assert.equal(await strayExists(), false, 'the three records were not drained: the case says nothing about how they were read');
    const fresh = finds.filter(c => passOf(c) === 'fresh');
    assert.equal(fresh.length, 1,
      `the fresh pass sent ${fresh.length} finds for 3 rows at a page of 10: a page shorter than asked for is the end of the pass, `
      + 'and the read after it can only come back empty');
  });

  it('a pass over a page and a half sends two finds, the second one short and the last', async () => {
    await seed(['a.md', 'b.md', 'c.md']);
    finds.length = 0;
    await drainStrayFileMeta({ pageSize: 2, maxPages: 20 });
    assert.equal(await strayExists(), false, 'the three records were not drained');
    const fresh = finds.filter(c => passOf(c) === 'fresh');
    assert.equal(fresh.length, 2, `the fresh pass sent ${fresh.length} finds for 3 rows at a page of 2: expected 2 (full, short) and no trailing read`);
    assert.ok(finds.every(c => passOf(c) !== 'other'), `a find on the stray collection belongs to neither pass: ${JSON.stringify(finds.map(c => c.filter))}`);
  });

  it('an empty page spends no maxPages: an empty fresh pass leaves the waiting pass its page (green at base by nature)', async () => {
    // Waiting since before this cycle, with its file row here: the waiting pass fills it and the record is answered.
    await seed(['w.md'], { keptSince: '2026-01-01T00:00:00.000Z' });
    await drainStrayFileMeta({ pageSize: 10, maxPages: 1 });
    assert.equal((await door.coll(SPACE, 'files').findOne({ _id: 'w.md' }))?.description, 'recovered for w.md',
      'the waiting record was not read: the empty fresh page used up the one page of maxPages');
    assert.equal(await strayExists(), false);
  });

  it('reads the wire keys and keptSince, derived from the exported FILE_META_WIRE_KEYS', async () => {
    assert.ok(Array.isArray(shared.FILE_META_WIRE_KEYS),
      'FILE_META_WIRE_KEYS is not exported from api/sync/_shared: the drain\'s projection cannot be derived from the list fileMetaForWire filters by');
    assert.ok(shared.FILE_META_WIRE_KEYS.length >= 5, `FILE_META_WIRE_KEYS holds ${shared.FILE_META_WIRE_KEYS.length} key(s): the derivation is broken`);
    await seed(['p.md']);
    finds.length = 0;
    await drainStrayFileMeta({ pageSize: 10, maxPages: 20 });
    assert.ok(finds.length >= 1, 'the drain sent no find on the stray collection: the command monitor sees nothing');
    const want = [...new Set([...shared.FILE_META_WIRE_KEYS, 'keptSince'])].sort();
    for (const c of finds) {
      assert.ok(c.projection && typeof c.projection === 'object',
        'a page of the stray collection was read with no projection: every stored key of the old pull\'s rows is read for the wire keys alone');
      const got = Object.keys(c.projection).filter(k => k !== '_id' || want.includes('_id')).sort();
      assert.deepEqual(got, want, 'the projection is not the wire keys plus keptSince');
      assert.ok(Object.values(c.projection).every(v => v === 1), `the projection excludes rather than names: ${JSON.stringify(c.projection)}`);
    }
  });
});
