/**
 * A restore does not bring back a record THIS instance deleted after the backup, lands one a PEER's deletion covers, and forgets what the space
 * received so the next sync converges like an instance back from being offline (bundle-40 slice b, `Q-266`, `Q-275`, D-69; plan 2R R5 and 2R3 R5a).
 *
 * ## The rules this file holds, each over every family the import accepts
 *
 * Owner, 2026-11-01 (D-69): "update restores the state of what it was when the update was taken ... from a network perspective it is like someone
 * connecting after being offline since the backup, so the sync updates to the current state of the network after backup."
 *
 *  1. **Own deletion skip.** A document whose held tombstone was issued HERE (`issuedHere`) at a seq at or above the document's is NOT landed and is
 *     named in `deletedOnRestore` (with `deletedOnRestoreTotal`); below the document's seq it lands. Nothing lands, so no tombstone is made or moved.
 *     No issuer or author is compared: only the `issuedHere` bit and two seqs.
 *  2. **The same for a file row,** against its path's held file tombstone (`rowSeq`); a file row with no seq counts as 0.
 *  3. **A PEER's held deletion does not stop the record:** it lands and is named in `restoredOverTombstone`, and the next sync settles it by the
 *     deletion rule.
 *  4. **The import forgets the space's RECEIVE marks** (`lastPosReceived`, `tombstoneRereadAt`, `fileMetaRereadAt`) so the next sync re-reads every
 *     member from the start, keeps `lastPosPushed` (a restore does not undo what was sent), and touches no other space.
 *
 * ## What is red on the base, and what is a PIN
 *
 * The base writes whatever it is handed (rule 1 and 2 red: the own-deleted record lands and is not named) and forgets no mark (rule 4 red). Rule 3's
 * "lands and is named" is a PIN (`an-import-restores-what-the-export-wrote-db` holds it for every family; here it rides the door beside the marks).
 *
 * Families are DERIVED from `REPLICATED_FAMILIES` with a floor; a family with no fixture fails rather than going unchecked.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-restore-drops-what-this-instance-deleted-after-the-backup-and-forgets-what-it-received-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openImportDoor, exportText } from './_import-door.mjs';
import { netFixture, untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'deletedrestore';
const OTHER = 'deletedrestore-other';
const T = { timeout: 60_000 };
const T0 = '2026-06-01T00:00:00.000Z';
const author = { instanceId: 'origin', instanceLabel: 'Origin' };

const member = (instanceId, space) => ({
  instanceId, label: instanceId, url: `http://${instanceId}.invalid`, tokenHash: 'x', joinedAt: '2026-01-01T00:00:00.000Z',
  lastPosReceived: { [space]: 9, [OTHER]: 9 }, lastPosPushed: { [space]: 8, [OTHER]: 8 }, lastPosServed: { [space]: 7 },
  lastFileTombstoneAckedAt: { [space]: '2026-02-02T00:00:00.000Z' }, tombstoneRereadAt: { [space]: 'done' }, fileMetaRereadAt: { [space]: 'done' },
});

let door, runner, importMod, families, recordTypeOf;

/** One exported document per collection. A FIXTURE, literal on purpose; the derivation decides one is owed. */
function fixture(collection, id, seq) {
  const common = { _id: id, spaceId: 'elsewhere', tags: [], author, createdAt: T0, updatedAt: T0, ...(seq === undefined ? {} : { seq }) };
  const shapes = {
    facts: { fact: `fact ${id}` },
    entities: { name: `Entity ${id}`, type: 'concept', properties: {} },
    edges: { from: `from-${id}`, to: `to-${id}`, label: `rel_${id.replace(/\W/g, '_')}` },
    chrono: { title: `chrono ${id}`, type: 'event', startsAt: T0, status: 'upcoming' },
    links: { from: `src-${id}`, fromKind: 'fact', to: `dst-${id}`, toKind: 'entity', label: 'mentions' },
    files: { path: id },
  };
  assert.ok(shapes[collection], `no exported-document fixture for collection '${collection}': add one`);
  return { ...common, ...shapes[collection] };
}

/** A held record tombstone: `own` is one this instance issued. */
const tombstone = (collection, id, seq, own) => ({
  _id: id, type: recordTypeOf[collection] ?? 'link', spaceId: SPACE, deletedAt: T0, seq,
  instanceId: own ? door.instanceId() : 'peer-a', ...(own ? { issuedHere: true } : {}),
});

/** A published file tombstone for a path, as a delete here (or a peer's) leaves it. */
const fileTombstone = (path, rowSeq, own) => ({
  _id: randomUUID(), spaceId: SPACE, path, deletedAt: T0, positionAt: T0, writtenAt: T0, origin: own ? 'own' : 'relayed',
  issuer: own ? door.instanceId() : 'peer-a', rowSeq, ...(own ? { issuedHere: true } : {}),
});

/** Every named entry of `deletedOnRestore` for one family's result, as ids. */
const deletedNames = (result) => (result?.deletedOnRestore ?? []).map(e => (typeof e === 'string' ? e : e?._id ?? e?.id));
const overNames = (result) => (result?.restoredOverTombstone ?? []).map(e => (typeof e === 'string' ? e : e?._id ?? e?.id));

describe('a restore drops what this instance deleted after the backup and forgets what it received (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openImportDoor({
      suite: 'deletedrestore', spaces: [{ id: SPACE, label: 'Restore', folders: [] }, { id: OTHER, label: 'Other', folders: [] }],
      networks: [{ ...netFixture('n-restore', { spaces: [SPACE, OTHER] }), members: [member('peer-a', SPACE)] }],
    });
    importMod = await import('../../server/dist/api/admin-import.js');
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    const kinds = await import('../../server/dist/config/types-knowledge.js');
    recordTypeOf = Object.fromEntries(families.map(f => [f.collection,
      Object.entries(kinds.RECORD_COLLECTION).find(([, c]) => c === f.collection)?.[0] ?? null]));
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(SPACE); await door.coll(SPACE, 'tombstones').deleteMany({}); await door.coll(SPACE, 'file_tombstones').deleteMany({}); });

  it('a record whose tombstone this instance issued at a seq at or above its own is not landed and is named in deletedOnRestore; below it, it lands', T, async () => {
    const recordFamilies = families.map(f => f.collection).filter(c => c !== 'files');
    assert.ok(recordFamilies.length >= 5, `only ${recordFamilies.length} record families derived: the registry moved`);
    const SCENARIOS = [
      { tag: 'above', docSeq: 10, tombSeq: 30, lands: false },
      { tag: 'equal', docSeq: 10, tombSeq: 10, lands: false },
      { tag: 'below', docSeq: 10, tombSeq: 5, lands: true },
    ];
    const payload = {};
    for (const c of recordFamilies) {
      payload[c] = [];
      for (const s of SCENARIOS) {
        const id = `own-${s.tag}-${c}`;
        payload[c].push(fixture(c, id, s.docSeq));
        await door.coll(SPACE, 'tombstones').insertOne(tombstone(c, id, s.tombSeq, true));
      }
    }
    const tombstonesBefore = await door.coll(SPACE, 'tombstones').find({}).sort({ _id: 1 }).toArray();
    const out = await importMod.importDocuments(SPACE, payload);
    const wrong = [];
    for (const c of recordFamilies) {
      const stored = new Set((await door.coll(SPACE, c).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id));
      const named = new Set(deletedNames(out.results[c]));
      for (const s of SCENARIOS) {
        const id = `own-${s.tag}-${c}`;
        if (stored.has(id) !== s.lands) wrong.push(`${c}/${id}: ${stored.has(id) ? 'LANDED' : 'not landed'}, want ${s.lands ? 'landed' : 'not landed'}`);
        if (named.has(id) === s.lands) wrong.push(`${c}/${id}: ${named.has(id) ? 'named' : 'not named'} in deletedOnRestore, want ${s.lands ? 'not named' : 'named'}`);
      }
      const want = SCENARIOS.filter(s => !s.lands).length;
      if (out.results[c].deletedOnRestoreTotal !== want) wrong.push(`${c}: deletedOnRestoreTotal ${out.results[c].deletedOnRestoreTotal}, want ${want}`);
    }
    assert.deepEqual(wrong, [], 'a restore brought back a record this instance deleted after the backup (or dropped one it should have landed): it is the '
      + 'state of what the backup was, minus what this instance itself removed since');
    assert.deepEqual(await door.coll(SPACE, 'tombstones').find({}).sort({ _id: 1 }).toArray(), tombstonesBefore,
      'the restore issued, moved or removed a tombstone (nothing landed, so nothing is to be re-deleted)');
  });

  it('a file row whose path tombstone this instance issued at a seq at or above its own is not landed and is named; a row with no seq counts as 0', T, async () => {
    const CASES = [
      { id: 'own/above.md', seq: 10, tombSeq: 30, lands: false },
      { id: 'own/equal.md', seq: 10, tombSeq: 10, lands: false },
      { id: 'own/below.md', seq: 10, tombSeq: 5, lands: true },
      { id: 'own/no-seq-above.md', seq: undefined, tombSeq: 3, lands: false },
      { id: 'own/no-seq-below-nothing.md', seq: undefined, tombSeq: undefined, lands: true }, // no tombstone at all
    ];
    for (const c of CASES) if (c.tombSeq !== undefined) await door.coll(SPACE, 'file_tombstones').insertOne(fileTombstone(c.id, c.tombSeq, true));
    const out = await importMod.importDocuments(SPACE, { files: CASES.map(c => fixture('files', c.id, c.seq)) });
    const stored = new Set((await door.coll(SPACE, 'files').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id));
    const named = new Set(deletedNames(out.results.files));
    const wrong = [];
    for (const c of CASES) {
      if (stored.has(c.id) !== c.lands) wrong.push(`${c.id}: ${stored.has(c.id) ? 'LANDED' : 'not landed'}, want ${c.lands ? 'landed' : 'not landed'}`);
      if (named.has(c.id) === c.lands) wrong.push(`${c.id}: ${named.has(c.id) ? 'named' : 'not named'} in deletedOnRestore, want ${c.lands ? 'not named' : 'named'}`);
    }
    assert.deepEqual(wrong, [], 'a file this instance deleted after the backup came back with the restore');
    assert.equal(out.results.files.deletedOnRestoreTotal, 3, 'deletedOnRestoreTotal does not count the three skipped file rows');
  });

  it('a record under a PEER\'s held deletion lands and is named in restoredOverTombstone, and the space\'s receive marks are forgotten (lastPosPushed kept)', T, async () => {
    // One record per family, each under a tombstone a peer issued at a seq above its own: it is restored, not skipped.
    const payload = {};
    for (const f of families.map(x => x.collection).filter(c => c !== 'files')) {
      const id = `peer-${f}`;
      payload[f] = [fixture(f, id, 10)];
      await door.coll(SPACE, 'tombstones').insertOne(tombstone(f, id, 30, false));
    }
    const res = await door.post(SPACE, exportText(payload, { envelope: { instanceId: door.instanceId(), spaceId: SPACE } }));
    assert.equal(res.status, 200, `the import answered ${res.status}: ${res.text.slice(0, 200)}`);
    await untilRunnerIdle(runner, door.loader);
    const wrong = [];
    for (const f of Object.keys(payload)) {
      const id = `peer-${f}`;
      if (await door.coll(SPACE, f).countDocuments({ _id: id }) !== 1) wrong.push(`${f}/${id}: did not land`);
      if (!overNames(res.json?.results?.[f]).includes(id)) wrong.push(`${f}/${id}: not named in restoredOverTombstone`);
    }
    assert.deepEqual(wrong, [], 'a record under a peer\'s deletion must land and be named: the next sync, not the restore, judges the peer\'s deletion');
    const m = door.loader.getConfig().networks.find(n => n.id === 'n-restore').members[0];
    const RECEIVED = ['lastPosReceived', 'tombstoneRereadAt', 'fileMetaRereadAt'];
    assert.deepEqual(RECEIVED.filter(k => m[k]?.[SPACE] !== undefined), [],
      'the import left this space\'s receive marks, so the next sync resumes after the backup instead of re-reading every member from the start');
    assert.equal(m.lastPosPushed?.[SPACE], 8, 'the import forgot lastPosPushed, which a restore must keep (it re-sends restored rows whose deletions peers pruned)');
    assert.equal(m.lastPosReceived?.[OTHER], 9, 'the import forgot another space\'s receive mark');
  });
});
