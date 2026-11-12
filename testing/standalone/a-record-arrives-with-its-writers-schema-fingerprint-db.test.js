/**
 * A record's schema stamp (`schemaFingerprint`, bundle-265 Q-737) is the WRITER's claim, and every door a record arrives by keeps it as the writer sent it.
 *
 * ## What it holds, beside the push and pull rows
 *
 * `push-and-pull-decide-alike-db` holds the batch push, the single push and the pull (its rows carry a fingerprint, and the doors must store the same row).
 * This file holds the doors that are not a sync cycle, and the two sides of the wire that file cannot see:
 *
 *  1. **The admin import** (`importDocuments`, the restore of an export): a record lands with the stamp it carries; it replaces the stored copy's stamp
 *     with its own, and a record that carries none leaves none (the replaced copy's stamp described the replaced copy). The import does not parse a record
 *     with the `Incoming*` schemas (it records what it is handed and refuses only what the writer's preconditions refuse, `sync/space-import.ts`), so a
 *     malformed stamp is not read as none here the way it is on the sync doors; that is not asserted, because the design does not say it.
 *  2. **The backup restore** (`restoreDatabase`, the raw `backupLoader`): a dump holds the stamp and a restore stores it back, unchanged, for every
 *     record family, and the space's Merkle root is the same before the dump and after the restore.
 *  3. **The page a peer is served** carries the stamp: the sender's read must not project it away (it is replicated, not local-only), or a pulling member
 *     receives every record unstamped.
 *  4. **The Merkle root leaves it out**: the same record in two spaces, stamped differently or not at all, gives one root; a changed record still moves it.
 *
 * ## Seen red
 *
 * On the base (ce37b83a) only the root rows are red: the stamp is hashed, so two spaces holding one record under different stamps report different roots. The
 * import, the backup restore and the served page store and read the stamp as a plain stored field, which the base already does (the import writer does not
 * parse with the `Incoming*` schemas, the loader is a raw insert, the sender's read projects only the local-only fields), so they PASS there and are pins:
 * the change that declares the stamp, classes it and leaves it out of the hash must not make the import drop it, the restore re-validate it or the sender's
 * read project it away. The stored stamps they use are seeded directly: nothing stamps a record until a writer lands in this bundle.
 *
 * Run: node --test testing/standalone/a-record-arrives-with-its-writers-schema-fingerprint-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'fp-arrives';
const S2 = 'fp-arrives-twin';
const SUITE = 'tsfpwire';
const fp = (word) => createHash('sha256').update(`schema ${word}`, 'utf8').digest('hex');
const X = fp('X');
const Y = fp('Y');

/** The record families, by the key a payload and a collection name them by, and the builder of each. */
const FAMILIES = Object.freeze({ facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono' });

let door, importMod, merkle, dump, restore, BRAIN;

const idOf = (family, tag) => `${family}-${tag}`;
const make = (family, space, tag, seq, extra = {}) => build[FAMILIES[family]](space, idOf(family, tag), seq, extra);
const stored = (family, space, tag) => door.coll(space, family).findOne({ _id: idOf(family, tag) });
const hasStamp = (d) => d !== null && 'schemaFingerprint' in d;

describe('a record keeps its writer\'s schema fingerprint on every door it arrives by', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: SUITE, spaces: [S, S2] });
    importMod = await import('../../server/dist/sync/space-import.js');
    merkle = await import('../../server/dist/brain/merkle.js');
    dump = await import('../../server/dist/db/dump.js');
    restore = await import('../../server/dist/db/restore.js');
    ({ BRAIN_COLLECTIONS: BRAIN } = await import('../../server/dist/config/types-knowledge.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); await door.wipe(S); await door.wipe(S2); });

  it('the record families are derived: the brain collections less links and files', () => {
    const records = BRAIN.filter(c => c !== 'links' && c !== 'files');
    assert.deepEqual(records.sort(), Object.keys(FAMILIES).sort(), 'the record families changed: give the new one a fixture before trusting this file');
  });

  describe('1. the admin import', () => {
    for (const family of Object.keys(FAMILIES)) {
      it(`${family}: lands with the stamp it carries, over the stored copy's, and a copy with none leaves none`, async () => {
        // Nothing stored: the stamp the record carries.
        await importMod.importDocuments(S, { [family]: [make(family, S, 'fresh', 40, { schemaFingerprint: X })] });
        const fresh = await stored(family, S, 'fresh');
        assert.ok(fresh, `${family}: the import did not land the record`);
        assert.equal(fresh.schemaFingerprint, X, `${family}: an imported record lost its writer's stamp (stored ${JSON.stringify(fresh.schemaFingerprint)})`);

        // A stored copy at a lower version with another stamp: replaced, the stamp with it.
        await door.coll(S, family).insertOne({ ...make(family, S, 'over', 39), schemaFingerprint: Y, deliveredBy: '' });
        await importMod.importDocuments(S, { [family]: [make(family, S, 'over', 40, { schemaFingerprint: X })] });
        const over = await stored(family, S, 'over');
        assert.equal(over?.seq, 40, `${family}: fixture check, the import did not replace the stored copy`);
        assert.equal(over.schemaFingerprint, X, `${family}: the import kept the replaced copy's stamp ${JSON.stringify(over.schemaFingerprint)}, not the record's own`);

        // A record that carries none: no stamp, whatever the replaced copy carried (it described the replaced version).
        await door.coll(S, family).insertOne({ ...make(family, S, 'none', 39), schemaFingerprint: Y, deliveredBy: '' });
        await importMod.importDocuments(S, { [family]: [make(family, S, 'none', 40)] });
        const none = await stored(family, S, 'none');
        assert.equal(none?.seq, 40, `${family}: fixture check, the import did not replace the stored copy`);
        assert.equal(hasStamp(none), false, `${family}: an unstamped record was stored with the replaced copy's stamp ${JSON.stringify(none.schemaFingerprint)}`);
      });

    }
  });

  describe('2. the backup restore', () => {
    it('a dump holds the stamp and a restore stores it back unchanged, for every record family; the Merkle root is the same after', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-fpwire-'));
      try {
        for (const family of Object.keys(FAMILIES)) {
          await door.coll(S, family).insertMany([
            positioned({ ...make(family, S, 'stamped', 5, { schemaFingerprint: X }), deliveredBy: 'a-peer' }),
            positioned({ ...make(family, S, 'unstamped', 5), deliveredBy: 'a-peer' }),
          ]);
        }
        const rootBefore = (await merkle.computeMerkleRoot(S)).root;
        const uri = testMongoUri(`ythril_harness_${SUITE}`);
        await dump.dumpDatabase(uri, dir);
        // What the restore must overwrite: the stamps as they stood are changed after the dump was taken.
        for (const family of Object.keys(FAMILIES)) {
          await door.coll(S, family).updateOne({ _id: idOf(family, 'stamped') }, { $set: { schemaFingerprint: Y } });
          await door.coll(S, family).updateOne({ _id: idOf(family, 'unstamped') }, { $set: { schemaFingerprint: Y } });
        }
        await restore.restoreDatabase(uri, dir);
        for (const family of Object.keys(FAMILIES)) {
          const a = await stored(family, S, 'stamped');
          const b = await stored(family, S, 'unstamped');
          assert.equal(a?.schemaFingerprint, X, `${family}: a restore did not store the backup's stamp (stored ${JSON.stringify(a?.schemaFingerprint)})`);
          assert.equal(hasStamp(b), false, `${family}: a restore gave an unstamped record the stamp ${JSON.stringify(b?.schemaFingerprint)}`);
        }
        merkle.forgetMerkleLeaves(S);
        assert.equal((await merkle.computeMerkleRoot(S)).root, rootBefore, 'a restored space has a different Merkle root from the one it was dumped with');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('3. the page a peer is served', () => {
    for (const family of Object.keys(FAMILIES)) {
      it(`${family}: a stamped record is served with its stamp, an unstamped one without`, async () => {
        await door.coll(S, family).insertMany([
          positioned({ ...make(family, S, 'served', 3, { schemaFingerprint: X }), deliveredBy: 'a-peer' }),
          positioned({ ...make(family, S, 'bare', 3), deliveredBy: 'a-peer' }),
        ]);
        await door.raiseVersionTo(S, 10);
        const body = await door.pull(`/${family}`, { spaceId: S, afterPos: '0' });
        const byId = new Map(body.items.map(d => [d._id, d]));
        assert.ok(byId.has(idOf(family, 'served')) && byId.has(idOf(family, 'bare')), `${family}: the page did not serve both records, so the check proves nothing: ${JSON.stringify(body).slice(0, 200)}`);
        assert.equal(byId.get(idOf(family, 'served')).schemaFingerprint, X, `${family}: the sender's read projects the stamp away, so every pulled record arrives unstamped`);
        assert.equal(hasStamp(byId.get(idOf(family, 'bare'))), false, `${family}: the page invented a stamp`);
      });
    }
  });

  describe('4. the Merkle root', () => {
    for (const family of Object.keys(FAMILIES)) {
      it(`${family}: the same record stamped differently, or not at all, gives one root; a changed record moves it`, async () => {
        await door.coll(S, family).insertOne(positioned({ ...make(family, S, 'r', 5, { schemaFingerprint: X }), deliveredBy: 'a-peer' }));
        await door.coll(S2, family).insertOne(positioned({ ...make(family, S2, 'r', 5, { schemaFingerprint: Y }), deliveredBy: 'a-peer' }));
        const [a, b] = [(await merkle.computeMerkleRoot(S)).root, (await merkle.computeMerkleRoot(S2)).root];
        assert.equal(a, b, `${family}: two members that stamped one version with different schemas report different roots: MERKLE_DIVERGENCE every cycle over metadata about the write`);

        // And with no stamp at all: what an older member holds after it drops the stamp on arrival.
        await door.coll(S2, family).deleteMany({});
        await door.coll(S2, family).insertOne(positioned({ ...make(family, S2, 'r', 5), deliveredBy: 'a-peer' }));
        merkle.forgetMerkleLeaves(S2);
        assert.equal((await merkle.computeMerkleRoot(S2)).root, a, `${family}: an unstamped copy and a stamped one report different roots`);

        // Sensitivity: a different version of the record moves the root, or "equal" is vacuous.
        await door.coll(S2, family).deleteMany({});
        await door.coll(S2, family).insertOne(positioned({ ...make(family, S2, 'r', 6), deliveredBy: 'a-peer' }));
        merkle.forgetMerkleLeaves(S2);
        assert.notEqual((await merkle.computeMerkleRoot(S2)).root, a, `${family}: a changed record left the root where it was, so the comparison sees nothing`);
      });
    }
  });
});
