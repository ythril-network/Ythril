/**
 * Two instances holding the same replicated data report the same Merkle root — whatever their local id for the
 * space, and whatever files each keeps for itself.
 *
 * ## The defect (`Q-307`)
 *
 * The root is what tells an operator whether two members of a `merkle: true` network hold the same data, and a
 * difference is logged as `MERKLE_DIVERGENCE` on every cycle. Two things that never replicate were hashed:
 *
 * - **The space's LOCAL id.** Every arrival is stored under the receiver's own id (`retagToLocalSpace` in the
 *   arrival writer), and under a `spaceMap` alias that id is not the sender's. `brain/merkle.ts` hashed `spaceId`
 *   in every leaf — through the exclusion list for five collections and the inclusion list for `files` — so an
 *   aliased space differed in every leaf, for ever, on identical content.
 * - **Instance-local files.** A conflict copy and a schema snapshot never travel (`isInstanceLocalFile`, `Q-66`), and
 *   the peer manifest leaves them out. The root hashed the unfiltered manifest, so any conflict copy, or any snapshot
 *   that differs between members, made the roots differ for ever.
 *
 * A permanent false alarm teaches an operator to ignore the one signal that means data really is missing.
 *
 * ## What is asserted
 *
 * - **Every brain collection, each on its own** (derived from `BRAIN_COLLECTIONS`): the same record stored in two
 *   spaces with different ids — stamped with each space's id by the arrival writer's own retag — gives equal roots.
 *   One collection at a time, so a fix that reaches the exclusion list and forgets the `files` inclusion list (or the
 *   reverse) names the collection it missed. The same file bytes on both sides are part of every comparison.
 * - **The instance-local files, written by their real writers**: a conflict copy named by `conflictCopyPath` and a
 *   schema snapshot written by `syncSchemaFiles`, each first shown to be what `isInstanceLocalFile` covers, leave the
 *   root where it was.
 * - **Sensitivity**, so "equal" means something: a changed record, and an ordinary added file, move the root.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-merkle-root-counts-only-what-replicates-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merkle-replicates-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

/** One space, held under two different local ids — what a `spaceMap` alias produces on two instances. */
const HERE = 'alpha';
const THERE = 'beta';
const NOTE = 'notes/a.md';
const NOTE_BYTES = 'the same note on both sides';

let mongo, merkle, spaceCollection, BRAIN_COLLECTIONS, retagToLocalSpace, files, conflictCopyPath, isInstanceLocalFile, syncSchemaFiles;

const root = async (space) => (await merkle.computeMerkleRoot(space)).root;

/** The same record for any collection, stored the way the arrival writer stores it: retagged to the local space. */
function storedCopy(collType, space, over = {}) {
  const doc = {
    _id: `rec-${collType}`, seq: 3, path: `rec-${collType}.md`, name: 'Same record', description: 'same content',
    tags: ['t'], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...over,
  };
  retagToLocalSpace([doc], space);
  return doc;
}

async function wipe(space) {
  for (const c of BRAIN_COLLECTIONS) await mongo.col(spaceCollection(space, c)).deleteMany({});
  await mongo.col(spaceCollection(space, 'fileHashes')).deleteMany({});
  fs.rmSync(path.join(tmpDir, 'files', space), { recursive: true, force: true });
  await files.writeFile(space, NOTE, NOTE_BYTES);
}

describe('a merkle root counts only what replicates', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('merkleidentity');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'merkle-identity-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: HERE, label: 'Here', folders: [] },
        { id: THERE, label: 'There', folders: [] },
      ],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    merkle = await import('../../server/dist/brain/merkle.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    ({ BRAIN_COLLECTIONS } = await import('../../server/dist/config/types-knowledge.js'));
    ({ retagToLocalSpace } = await import('../../server/dist/sync/upsert-plan.js'));
    files = await import('../../server/dist/files/files.js');
    ({ conflictCopyPath, isInstanceLocalFile } = await import('../../server/dist/sync/file-conflict.js'));
    ({ syncSchemaFiles } = await import('../../server/dist/spaces/_shared.js'));
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await wipe(HERE); await wipe(THERE); });

  it('derived the collections', () => {
    // A floor: an empty list passes the loop below while comparing nothing.
    assert.ok(BRAIN_COLLECTIONS.length >= 6 && BRAIN_COLLECTIONS.includes('files'),
      `BRAIN_COLLECTIONS is ${JSON.stringify(BRAIN_COLLECTIONS)} — re-anchor`);
  });

  it('the same records under two local space ids give the same root, in every collection', async () => {
    const differ = [];
    for (const collType of BRAIN_COLLECTIONS) {
      await wipe(HERE); await wipe(THERE);
      await mongo.col(spaceCollection(HERE, collType)).insertOne(storedCopy(collType, HERE));
      await mongo.col(spaceCollection(THERE, collType)).insertOne(storedCopy(collType, THERE));
      const [a, b] = [await root(HERE), await root(THERE)];
      if (a !== b) differ.push(collType);

      // Sensitivity, per collection: a different version of the record must move the root, or "equal" is vacuous.
      await mongo.col(spaceCollection(THERE, collType)).deleteMany({});
      await mongo.col(spaceCollection(THERE, collType)).insertOne(storedCopy(collType, THERE, { seq: 4, description: 'edited' }));
      assert.notEqual(await root(THERE), a, `a changed ${collType} record left the root where it was — the comparison sees nothing`);
    }
    assert.deepEqual(differ, [],
      'the root depends on the space\'s LOCAL id in these collections, so a space held under a spaceMap alias reports '
      + 'MERKLE_DIVERGENCE every cycle on identical content');
  });

  it('a conflict copy and a schema snapshot leave the root where it was', async () => {
    const before = await root(HERE);

    // Each written by the code that writes it in production, and shown to be what the predicate calls instance-local.
    const copy = conflictCopyPath(NOTE, 'peer-b', new Date('2026-09-02T10:11:12.345Z'));
    await files.writeFile(HERE, copy, 'the peer\'s version of the note');
    await syncSchemaFiles(HERE, { typeSchemas: { entity: { person: { propertySchemas: { born: { type: 'string' } } } } } });
    const snapshots = fs.readdirSync(path.join(tmpDir, 'files', HERE, 'schemas')).map(n => `schemas/${n}`);
    assert.ok(snapshots.length > 0, 'syncSchemaFiles wrote no snapshot — the fixture is not the thing under test');
    const local = [copy, ...snapshots];
    assert.deepEqual(local.filter(p => !isInstanceLocalFile(p)), [],
      'the fixture names files the predicate does not call instance-local — re-anchor it on file-conflict.ts');

    assert.equal(await root(HERE), before,
      `the root counts files that never leave this instance (${local.join(', ')}), so two members diverge for ever `
      + 'over a conflict copy or a schema snapshot');

    // Sensitivity: an ordinary file must still move the root.
    await files.writeFile(HERE, 'notes/b.md', 'another note');
    assert.notEqual(await root(HERE), before, 'an ordinary file left the root where it was — the comparison sees nothing');
  });
});
