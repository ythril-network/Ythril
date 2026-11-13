/**
 * A schema version a server uses is kept as a row of a PRIVATE per-space collection, named by its fingerprint (Q-735, bundle-265), while a record
 * here carries it, or while it is current, a layer, or linked by a kept version (the sweep, bundle-266).
 *
 * ## What is kept, where, and why a collection
 *
 * `<space>_schema_snapshots`, `_id` = the fingerprint, one row `{ _id, text, origin, networkId?, links, at }` per schema text the space's server has been
 * a variation of or received as a network's layer. It is a collection and not a file because a file is visible and writable through the Files area, is
 * hashed, synced and tombstoned, and every file name is creatable by a user; a collection has none of that, and `_id` = fingerprint makes "write once" one
 * upsert. It never syncs (no sync door serves it as a family), carries no files row, no manifest entry and no Merkle leaf, survives a files wipe, moves with a
 * rename, goes with a delete, and is in a database backup.
 *
 * - **Content-addressed, written once.** `sha256(text) === _id`, and a row that exists is never rewritten (a second origin for the same text keeps the first).
 * - **"Don't copy, just use."** A variation that adds nothing to a network's layer has the layer's text, so it has the layer's fingerprint and writes no row of
 *   its own: the one row is the layer's (`origin: 'layer'`, `links: null`, because this server cannot know what the upstream built it from).
 * - **Links.** A row for a variation that is more than its layer says what it was built from: `{ own, layers: [{ networkId, fp }], served: [{ networkId, fp }] }`
 *   (`served` is what this member serves a network, which is NOT what it received, as soon as it has own types).
 * - **Who writes.** `updateSpace` (the one funnel of effective-meta writes, which replaces the per-type files), `storeNetworkLayer`, `createSpace`, a library
 *   save (for every space that links the entry), the housekeeping cycle, and the per-write backstop (a stamping write whose fingerprint is not known held). Each
 *   inside the space write gate and detached: a write never waits for its snapshot, and a refused gate writes nothing now and the cycle writes it later.
 *
 * ## Seen red
 *
 * On ce37b83a `SPACE_COLLECTIONS` has no `schemaSnapshots`, no module writes a row, and `syncSchemaFiles` writes the retired per-type FILES instead: every case
 * waits for a row that never comes (or throws at the part the collection name is built from).
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/a-schema-snapshot-is-kept-privately-db.test.js   (after `npm run build -w @ythril/server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { eventually } from './_write-faults.mjs';
import { callRoute } from './_vote-round-instance.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { sha256Hex, clone, PERSON_DEFINITION, personEntry } from './_schema-fingerprint.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b265snap';
const NET = 'net-snap';
const THEM = 'peer-snap-1';

const thing = { typeSchemas: { entity: { thing: { propertySchemas: { n: { type: 'string' } } } } } };
const OLD_LAYER = { typeSchemas: { entity: { shared: { propertySchemas: { s: { type: 'string' } } } } } };
const NEW_LAYER = { typeSchemas: { entity: { shared: { propertySchemas: { s: { type: 'string' }, t: { type: 'number' } } } } } };
const OWN = { typeSchemas: { entity: { mine: { propertySchemas: { m: { type: 'string' } } } } } };
const SPACE_IDS = ['snap', 'plain', 'libd', 'lay', 'mix', 'gated', 'backstop', 'rena', 'del', 'wiped', 'dumped', 'created', 'probe'];

let door, spaces, effective, lifecycle, stampMod, replicated, merkle, collections, loader;

const snaps = (id) => door.coll(id, 'schema_snapshots');
const rows = async (id) => (await snaps(id).find({}).toArray()).sort((a, b) => a._id.localeCompare(b._id));
const ids = async (id) => (await rows(id)).map(r => r._id);
const until = async (check, what, ms = 15_000) => assert.ok(await eventually(check, ms, 50), `${what} within ${ms} ms`);
/** The stamp of a meta, asked of the server on a scratch space (the only way it answers). */
const stampOf = (meta) => { loader.getConfig().spaces.find(s => s.id === 'probe').meta = clone(meta); return stampMod.readMetaForWrite('probe').stamp; };
const fpOf = (meta) => stampOf(meta).fp;
const member = (instanceId) => ({ instanceId, label: 'peer', url: 'https://peer-snap.example', tokenHash: 'h', direction: 'both' });

describe('a schema snapshot is kept privately, once, named by its content', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: SUITE,
      spaces: SPACE_IDS.map(id => ({
        id, label: id, folders: [],
        ...(id === 'lay' ? { meta: clone(OLD_LAYER), ownMeta: { purpose: 'mine' } } : {}),
        ...(id === 'mix' ? { meta: { typeSchemas: { entity: { ...OLD_LAYER.typeSchemas.entity, ...OWN.typeSchemas.entity } } }, ownMeta: clone(OWN) } : {}),
        ...(id === 'libd' ? { meta: { typeSchemas: { entity: { person: { $ref: 'library:person' } } } } } : {}),
      })),
      networks: [{
        id: NET, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: ['lay', 'mix'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', members: [member(THEM)], pendingRounds: [],
        schemaLayers: { lay: clone(OLD_LAYER), mix: clone(OLD_LAYER) },
      }],
    });
    loader = await import('../../server/dist/config/loader.js');
    await import('../../server/dist/spaces/library-ref-expansion.js');
    spaces = await import('../../server/dist/spaces/spaces.js');
    effective = await import('../../server/dist/spaces/effective-meta.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    stampMod = await import('../../server/dist/spaces/schema-stamp.js');
    replicated = await import('../../server/dist/sync/replicated-meta.js');
    merkle = await import('../../server/dist/brain/merkle.js');
    collections = await import('../../server/dist/db/space-collection.js');
    loader.saveSchemaLibrary([personEntry()]);
  });
  after(async () => { await door?.close(); });

  describe('the collection', () => {
    it('is one of a space\'s collections, named `<space>_schema_snapshots`, and is not a record family', async () => {
      assert.equal(collections.spaceCollection('snap', 'schemaSnapshots'), 'snap_schema_snapshots');
      assert.deepEqual(collections.parseSpaceCollection('snap_schema_snapshots'), { spaceId: 'snap', suffix: 'schema_snapshots' });
      const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types-knowledge.js');
      assert.equal(BRAIN_COLLECTIONS.includes('schemaSnapshots'), false, 'a snapshot is no brain collection: Merkle, sync and the wipe read BRAIN_COLLECTIONS');
    });
  });

  describe('who writes a row', () => {
    it('updateSpace: one row named by the fingerprint of the meta it stored, holding its text, built from itself', async () => {
      spaces.updateSpace('snap', { meta: clone(thing) });
      const stamp = stampOf(thing);
      await until(async () => (await ids('snap')).includes(stamp.fp), 'updateSpace wrote no snapshot row');
      const row = (await rows('snap')).find(r => r._id === stamp.fp);
      assert.equal(row.text, stamp.text);
      assert.equal(sha256Hex(row.text), row._id, 'the row is not named by the hash of its own text');
      assert.equal(row.origin, 'own');
      assert.deepEqual(row.links, { own: stamp.fp, layers: [], served: [] }, 'a space with no network layer is built from itself alone');
    });

    it('a label-only updateSpace writes nothing new, and a second write of the same schema leaves the first row exactly as it was', async () => {
      const before = await rows('snap');
      spaces.updateSpace('snap', { label: 'a new label' });
      spaces.updateSpace('snap', { meta: { ...clone(thing), purpose: 'a purpose is not the schema' } });
      // The positive control: a real change after them, awaited, so "nothing more was written" is a fact about a finished write.
      const next = { typeSchemas: { entity: { thing: { propertySchemas: { n: { type: 'string' }, extra: { type: 'number' } } } } } };
      spaces.updateSpace('snap', { meta: clone(next) });
      await until(async () => (await ids('snap')).includes(fpOf(next)), 'the control write left no row');
      const after = await rows('snap');
      assert.deepEqual(after.map(r => r._id).sort(), [...before.map(r => r._id), fpOf(next)].sort(), 'a label edit or a purpose edit wrote a row of its own');
      for (const row of before) assert.deepEqual(after.find(r => r._id === row._id), row, 'a row that existed was rewritten: a snapshot is written once');
    });

    it('createSpace with a meta', async () => {
      await lifecycle.createSpace({ id: 'created-new', label: 'Created', meta: clone(thing) }, { tokenId: null });
      try {
        await until(async () => (await ids('created-new')).includes(fpOf(thing)), 'createSpace wrote no snapshot row for the schema it created the space with');
      } finally { await lifecycle.removeSpace('created-new'); }
    });

    it('a library save, for every space that links the entry (and for none that holds it inline)', async () => {
      const { schemaLibraryRouter } = await import('../../server/dist/api/schema-library.js');
      const edited = { ...PERSON_DEFINITION, description: 'A human being, saved' };
      loader.getConfig().spaces.find(s => s.id === 'libd').meta = { typeSchemas: { entity: { person: { $ref: 'library:person' } } } };
      const answer = await callRoute(schemaLibraryRouter, 'put', '/:name', {
        params: { name: 'person' }, body: { knowledgeType: 'entity', typeName: 'person', schema: edited }, authToken: { rights: { instanceAdmin: true } },
      });
      assert.equal(answer.code, 200, JSON.stringify(answer.body));
      const stamp = stampMod.readMetaForWrite('libd').stamp;
      assert.equal(JSON.parse(stamp.text).typeSchemas.entity.person.description, 'A human being, saved', 'the library edit did not reach the stamp: the fixture is wrong');
      await until(async () => (await ids('libd')).includes(stamp.fp), 'a library save wrote no snapshot row for the space that links the entry');
      assert.deepEqual(await ids('plain'), [], 'a space that does not link the entry got a snapshot of the edit');
      loader.saveSchemaLibrary([personEntry()]);
    });

    it('the per-write backstop: a stamping write whose fingerprint no row holds keeps the snapshot of the very text it stamped', async () => {
      // A space whose schema was stored without any door that writes a snapshot (a space from before this release): no row exists for its fingerprint.
      loader.getConfig().spaces.find(s => s.id === 'backstop').meta = clone(thing);
      assert.deepEqual(await ids('backstop'), []);
      const stamp = stampMod.readMetaForWrite('backstop').stamp;
      const { upsertEntity } = await import('../../server/dist/brain/entities.js');
      await upsertEntity('backstop', 'a thing', 'thing', [], { n: 'x' });
      await until(async () => (await ids('backstop')).includes(stamp.fp), 'a stamping write kept no snapshot of the schema it stamped with');
      assert.equal((await rows('backstop')).find(r => r._id === stamp.fp).text, stamp.text);
    });

    it('concurrent writers of one schema leave one row', async () => {
      const { upsertEntity } = await import('../../server/dist/brain/entities.js');
      loader.getConfig().spaces.find(s => s.id === 'gated').meta = clone(thing);
      await Promise.all(Array.from({ length: 8 }, (_, i) => upsertEntity('gated', `concurrent ${i}`, 'thing', [], { n: String(i) })));
      await until(async () => (await ids('gated')).includes(fpOf(thing)), 'no writer kept the snapshot');
      assert.deepEqual(await ids('gated'), [fpOf(thing)], 'concurrent ensures of one fingerprint left more than that one row');
      await door.wipe('gated');
      await snaps('gated').deleteMany({});
    });
  });

  describe('a variation that adds nothing to a network layer uses the layer\'s row', () => {
    it('a space with no own definitions: one row, the layer\'s, with no links and no row of its own', async () => {
      assert.equal(effective.storeNetworkLayer(NET, 'lay', clone(NEW_LAYER)), true, 'the layer did not change the effective meta: the fixture is wrong');
      const layerFp = fpOf(NEW_LAYER);
      const variationFp = stampMod.readMetaForWrite('lay').stamp.fp;
      assert.equal(variationFp, layerFp, 'the fixture is wrong: a space with only a purpose of its own must have the layer\'s fingerprint');
      await until(async () => (await ids('lay')).includes(layerFp), 'storing a layer wrote no snapshot row');
      const all = await rows('lay');
      assert.deepEqual(all.map(r => r._id), [layerFp], 'the variation copied the layer: a second row, or a row of its own for the same text');
      assert.equal(all[0].origin, 'layer');
      assert.equal(all[0].networkId, NET);
      assert.equal(all[0].links, null, 'this server cannot know what the upstream built a layer from');
    });

    it('a space with an own type: the layer\'s row and its own, linked to each other', async () => {
      effective.storeNetworkLayer(NET, 'mix', clone(NEW_LAYER));
      const layerFp = fpOf(NEW_LAYER);
      const variationFp = stampMod.readMetaForWrite('mix').stamp.fp;
      assert.notEqual(variationFp, layerFp, 'the fixture is wrong: an own type must make the variation differ from the layer');
      await until(async () => { const got = await ids('mix'); return got.includes(layerFp) && got.includes(variationFp); }, 'the layer\'s row and the variation\'s were not both written');
      const held = await rows('mix');
      const layerRow = held.find(r => r._id === layerFp);
      const own = held.find(r => r._id === variationFp);
      assert.equal(layerRow.origin, 'layer');
      assert.equal(own.origin, 'own');
      const servedFp = fpOf(replicated.metaForNetwork(clone(OWN), { networkId: NET, meta: clone(NEW_LAYER) }));
      assert.deepEqual(own.links, {
        own: fpOf(OWN),
        layers: [{ networkId: NET, fp: layerFp }],
        served: [{ networkId: NET, fp: servedFp }],
      }, 'the own row does not say what it was built from: the own types, the layer it received, and what it serves back');
      assert.notEqual(servedFp, layerFp, 'the fixture is wrong: a member with own types serves a schema that is not the one it received');
      assert.equal(sha256Hex(own.text), own._id);
      assert.equal(sha256Hex(layerRow.text), layerRow._id);
    });
  });

  describe('a snapshot is nothing a peer or the Files area can see', () => {
    it('no files row, no file on disk, no manifest entry, no Merkle leaf', async () => {
      const rootBefore = (await merkle.computeMerkleRoot('snap')).root;
      const next = { typeSchemas: { entity: { thing: { propertySchemas: { n: { type: 'string' }, another: { type: 'boolean' } } } } } };
      spaces.updateSpace('snap', { meta: clone(next) });
      await until(async () => (await ids('snap')).includes(fpOf(next)), 'the schema change wrote no snapshot row');
      assert.equal(await door.coll('snap', 'files').countDocuments({}), 0, 'a snapshot has a files row: it would be listed, synced and tombstoned');
      const root = path.join(process.env['DATA_ROOT'], 'files', 'snap');
      assert.equal(fs.existsSync(path.join(root, 'schemas')), false, 'a schema change wrote a file under schemas/: the per-type files are retired and a snapshot is no file');
      assert.equal((await merkle.computeMerkleRoot('snap')).root, rootBefore, 'a snapshot moved the space\'s Merkle root');
    });
  });

  describe('the space write gate', () => {
    it('a space an act has closed gets nothing now, and the housekeeping cycle writes the row once the act is gone', async () => {
      const { sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js');
      await seedActEntry(loader, { kind: 'wipe', localId: 'gated', state: 'registered' });
      const closed = { typeSchemas: { entity: { gatedthing: { propertySchemas: { g: { type: 'string' } } } } } };
      try {
        spaces.updateSpace('gated', { meta: clone(closed) });
        // The positive control: a space not closed gets its row from the same kind of write, awaited, so "nothing was written" is a finished fact.
        spaces.updateSpace('wiped', { meta: clone(thing) });
        await until(async () => (await ids('wiped')).includes(fpOf(thing)), 'the control space got no row');
        assert.deepEqual(await ids('gated'), [], 'a snapshot was written into a space whose write gate was closed by an act');
      } finally { clearActEntries(loader); }
      await sweepExpired();
      await until(async () => (await ids('gated')).includes(fpOf(closed)), 'the housekeeping cycle did not write the snapshot the closed gate refused');
    });
  });

  describe('the collection goes where the space goes', () => {
    it('a files wipe keeps it', async () => {
      spaces.updateSpace('wiped', { meta: clone(thing) });
      await until(async () => (await ids('wiped')).includes(fpOf(thing)), 'no row to keep');
      await lifecycle.wipeSpace('wiped');
      assert.deepEqual(await ids('wiped'), [fpOf(thing)], 'a wipe of the space\'s data took its schema snapshots: the schema is not data');
    });

    it('a rename moves it with the space', async () => {
      spaces.updateSpace('rena', { meta: clone(thing) });
      await until(async () => (await ids('rena')).includes(fpOf(thing)), 'no row to move');
      const { renameSpace } = await import('../../server/dist/spaces/rename.js');
      await renameSpace('rena', 'renamed');
      assert.deepEqual(await ids('renamed'), [fpOf(thing)], 'the renamed space does not hold its snapshots');
      assert.deepEqual(await ids('rena'), [], 'the old id still holds the snapshots');
    });

    it('a delete drops it', async () => {
      spaces.updateSpace('del', { meta: clone(thing) });
      await until(async () => (await ids('del')).includes(fpOf(thing)), 'no row to drop');
      assert.equal(await lifecycle.removeSpace('del'), true);
      assert.deepEqual(await ids('del'), [], 'a deleted space left its snapshots behind: a space created again under the id would inherit them');
    });

    it('a database backup carries it', async () => {
      spaces.updateSpace('dumped', { meta: clone(thing) });
      await until(async () => (await ids('dumped')).includes(fpOf(thing)), 'no row to back up');
      const { dumpDatabase } = await import('../../server/dist/db/dump.js');
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-snapshot-dump-'));
      try {
        const manifest = await dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
        const held = manifest.collections.find(c => c.name === 'dumped_schema_snapshots');
        assert.ok(held && held.count === 1, `the backup does not carry dumped_schema_snapshots: ${JSON.stringify(manifest.collections.filter(c => c.name.startsWith('dumped_')))}`);
      } finally { fs.rmSync(dest, { recursive: true, force: true }); }
    });
  });

  describe('the meta answer names the fingerprint', () => {
    it('GET meta answers the fingerprint of the space\'s variation, and a PATCH of that answer is not refused for it', async () => {
      spaces.updateSpace('snap', { meta: clone(thing) });
      const { spaceMetaAnswer } = await import('../../server/dist/spaces/space-meta-answer.js');
      const space = loader.getConfig().spaces.find(s => s.id === 'snap');
      const answer = await spaceMetaAnswer({ spaceId: 'snap', space, memberIds: ['snap'], resolveRefs: true });
      assert.equal(answer.schemaFingerprint, stampMod.readMetaForWrite('snap').stamp.fp);
      const { stripServerOwnedMeta } = await import('../../schema/dist/internal.js');
      assert.equal('schemaFingerprint' in stripServerOwnedMeta(answer), false, 'the fingerprint the answer carries would be refused when the answer is PATCHed back: "do not return what you will not accept"');
    });
  });
});
