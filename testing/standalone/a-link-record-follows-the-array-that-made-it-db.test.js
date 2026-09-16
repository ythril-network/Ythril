/**
 * Writing one of the six array fields also writes the link RECORDS — and clearing it removes them.
 *
 * Runs in the OFFLINE subset like every other `-db` file here: it drives a real MongoDB through the
 * server's own data layer and needs no running instance.
 *
 * ## What slice 2a is, and what it deliberately is not
 *
 * Slice 1 gave a link record a collection, a hash, replication and a query door. **Nothing wrote one.** This
 * is the write half: every path that writes `fact.entityIds`, `chrono.entityIds`/`memoryIds` or
 * `file.entityIds`/`memoryIds`/`chronoIds` also maintains the matching link records.
 *
 * **No reader changes in 2a.** `the-link-baseline-3x-answered-db.test.js` must stay green with no edits — if
 * it needs one, this slice has changed an answer it was not supposed to touch. That is why the two files
 * exist as a pair.
 *
 * ## The properties, and why each is here rather than assumed
 *
 * **Deterministic ids.** `edgeIdFor` is a UUIDv5 over `(from, to, label, fromKind, toKind)`, so the same
 * connection always yields the same `_id`. That is what makes the conversion script idempotent and what
 * makes a re-write a no-op instead of a duplicate. Asserted by writing twice and counting.
 *
 * **Clearing the array removes the records.** The direction nobody tests, and the one that rots data: a link
 * record surviving the array that produced it is a connection the graph reports and the record denies.
 *
 * **`saveFact`'s converge path is its own case.** `brain/fact.ts` writes `entityIds` UNCONDITIONALLY when
 * a caller supplies an `id` that already exists, from a parameter defaulting to `[]` — so a retried
 * `saveFact` with no `entityIds` wipes the stored links. `createChrono`'s equivalent is guarded and this one
 * is not, so the link records have to follow that wipe rather than being left behind by it.
 *
 * **`updateChrono` writes through a COMPUTED KEY** — `$set[k] = v` over `Object.entries(updates)` — so no
 * grep for a field name finds it, in either spelling. It gets a case of its own for that reason alone.
 *
 * Run: node --test testing/standalone/a-link-record-follows-the-array-that-made-it-db.test.js
 * (requires `npm run test:up` and a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-link-write-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const E1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const E2 = 'aaaaaaaa-0000-4000-8000-000000000002';

let mongo, memoryMod, chronoMod, fileMetaMod, edgeIdMod;
/*
 * Imported in `before`, not at the top. `api/sync/_shared.js` reaches the config loader on the way in, and
 * at module scope that happens before `CONFIG_PATH` is set a few lines up — which takes every case in the
 * file down at once rather than failing the one that uses it.
 */
let IncomingLinkDoc;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const links = () => coll('links').find({}).toArray();

/** Every link record as `from>to` pairs, sorted — the shape an assertion can read. */
const linkPairs = async () => (await links()).map(l => `${l.fromKind}:${l.from}>${l.toKind}:${l.to}`).sort();

describe('a link record follows the array that made it', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('linkwrite');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'link-write-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    memoryMod = await import('../../server/dist/brain/fact.js');
    chronoMod = await import('../../server/dist/brain/chrono.js');
    fileMetaMod = await import('../../server/dist/files/file-meta.js');
    edgeIdMod = await import('../../server/dist/brain/edge-id.js');
    ({ IncomingLinkDoc } = await import('../../server/dist/api/sync/_shared.js'));
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files', 'links', 'tombstones']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertMany([
      { _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], seq: 1 },
      { _id: E2, spaceId: SPACE, name: 'Two', type: 'thing', tags: [], seq: 2 },
    ]);
  });

  it('the modules are the ones this gate thinks they are', () => {
    // Floors everything below: a renamed export makes each case throw rather than assert, and a file that
    // throws in `before` reports zero failures for the property it exists to pin.
    assert.equal(typeof memoryMod.saveFact, 'function', 'saveFact');
    assert.equal(typeof memoryMod.updateFact, 'function', 'updateFact');
    assert.equal(typeof chronoMod.createChrono, 'function', 'createChrono');
    assert.equal(typeof chronoMod.updateChrono, 'function', 'updateChrono');
    assert.equal(typeof fileMetaMod.updateFileMeta, 'function', 'updateFileMeta');
    assert.equal(typeof edgeIdMod.edgeIdFor, 'function', 'edgeIdFor');
  });

  it('remembering a memory that names two entities writes two link records', async () => {
    const m = await memoryMod.saveFact(SPACE, 'One and Two are related', [E1, E2]);
    assert.ok(m?._id, `remember returned nothing usable: ${JSON.stringify(m)}`);
    assert.deepEqual(await linkPairs(), [`fact:${m._id}>entity:${E1}`, `fact:${m._id}>entity:${E2}`]);
  });

  it('the link id is DERIVED, so the same connection is never stored twice', async () => {
    /*
     * The property the conversion script depends on. `edgeIdFor` is a UUIDv5 over the two records and the
     * class, so re-writing the same array cannot produce a second row — and the script can be re-run over a
     * space it has already converted without checking whether it has.
     */
    const m = await memoryMod.saveFact(SPACE, 'Stable', [E1]);
    const [first] = await links();
    assert.equal(first._id, edgeIdMod.edgeIdFor(m._id, E1, 'fact.entityIds', 'fact', 'entity'),
      'the id must come from `edgeIdFor`, or an idempotent re-run is impossible');

    await memoryMod.updateFact(SPACE, m._id, { entityIds: [E1] });
    const after = await links();
    assert.equal(after.length, 1, `re-writing the same link made ${after.length} rows`);
    assert.equal(after[0]._id, first._id, 'and the id did not move');
  });

  it('CLEARING the array removes the link records — the direction that rots data', async () => {
    // A link record surviving the array that produced it is a connection the graph reports and the record
    // denies. Nothing reads links yet in 2a, so this is the only place that failure would be visible.
    const m = await memoryMod.saveFact(SPACE, 'Then nothing', [E1, E2]);
    assert.equal((await links()).length, 2);
    await memoryMod.updateFact(SPACE, m._id, { entityIds: [] });
    assert.deepEqual(await linkPairs(), [], 'the links outlived the array that made them');
  });

  it('NARROWING the array removes only the link that went', async () => {
    const m = await memoryMod.saveFact(SPACE, 'Two then one', [E1, E2]);
    await memoryMod.updateFact(SPACE, m._id, { entityIds: [E2] });
    assert.deepEqual(await linkPairs(), [`fact:${m._id}>entity:${E2}`]);
  });

  it('remember\'s CONVERGE path takes the links with it when it wipes the array', async () => {
    /*
     * `brain/fact.ts` writes `entityIds` unconditionally on the converge-on-supplied-id branch, from a
     * parameter that defaults to `[]`. So a retried `saveFact` carrying the id and no entities wipes the
     * stored links — deliberate or not, the link records must follow, or they are left describing a
     * connection the memory no longer claims.
     *
     * `createChrono`'s equivalent branch is GUARDED and does not clear. The asymmetry is real, it is
     * recorded on the `M-2` row, and this case is what stops 2a papering over it.
     */
    const m = await memoryMod.saveFact(SPACE, 'Converge', [E1, E2]);
    assert.equal((await links()).length, 2);
    // The id is the ELEVENTH positional parameter, and its own docblock calls it the twelfth — so it is
    // spread rather than counted out by hand. `saveFact`'s comment already says the tail should have
    // become an options object; a test that miscounts it silently exercises the INSERT branch instead
    // and passes for the wrong reason, which is what happened on the first run of this case.
    await memoryMod.saveFact(SPACE, 'Converge', ...Array(8).fill(undefined), m._id);
    const stored = await coll('facts').findOne({ _id: m._id });
    assert.deepEqual(stored.entityIds, [], 'precondition: the converge path wiped the array');
    assert.deepEqual(await linkPairs(), [], 'so the link records must be gone with it');
  });

  it('a chrono entry writes BOTH its classes, and they are told apart by the to-kind', async () => {
    const m = await memoryMod.saveFact(SPACE, 'Named by a chrono', []);
    const ch = await chronoMod.createChrono(SPACE, {
      title: 'Incident', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
      entityIds: [E1], memoryIds: [m._id],
    });
    assert.ok(ch?._id, `createChrono returned nothing usable: ${JSON.stringify(ch)}`);
    assert.deepEqual(await linkPairs(),
      [`chrono:${ch._id}>entity:${E1}`, `chrono:${ch._id}>fact:${m._id}`].sort());
  });

  it('updateChrono maintains them too — the writer whose $set key is COMPUTED', async () => {
    // `$set[k] = v` inside `Object.entries(updates)`, so no field-name grep finds this path in either
    // spelling. It is the site most likely to be missed and therefore gets its own case.
    const ch = await chronoMod.createChrono(SPACE, {
      title: 'Moves', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', entityIds: [E1],
    });
    await chronoMod.updateChrono(SPACE, ch._id, { entityIds: [E2] });
    assert.deepEqual(await linkPairs(), [`chrono:${ch._id}>entity:${E2}`]);
  });

  it('a file\'s three classes are maintained by updateFileMeta', async () => {
    const m = await memoryMod.saveFact(SPACE, 'Named by a file', []);
    const ch = await chronoMod.createChrono(SPACE, {
      title: 'Also named', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
    });
    await coll('files').insertOne({
      _id: 'notes/a.md', spaceId: SPACE, path: 'notes/a.md', tags: [], sizeBytes: 3,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await fileMetaMod.updateFileMeta(SPACE, 'notes/a.md', {
      entityIds: [E1], memoryIds: [m._id], chronoIds: [ch._id],
    });
    assert.deepEqual(await linkPairs(), [
      `file:notes/a.md>chrono:${ch._id}`,
      `file:notes/a.md>entity:${E1}`,
      `file:notes/a.md>fact:${m._id}`,
    ].sort());
  });

  it('every link record carries what a REPLICATED document must', async () => {
    // set-claim: the same forbidden edge fields as the source-side case, asserted here against a real
    // stored record. What a link must not carry, not a copy of what it must.
    /*
     * `brain/merkle.ts` hashes every field of a link, so a field written here and missing from the ingest
     * schema is kept on pull and DELETED on push — same version, same document, one direction, no error.
     * The standing rule is that a hashed field replicates; this is the write side of it.
     *
     * **The fields are READ OUT OF `IncomingLinkDoc`, never written here.** They were written here, and the
     * count was in the comment as well: nine names beside a schema that has ten keys, one of them optional.
     * A field promoted from optional to required, or a new required field, would have left this case
     * asserting the old nine and reporting that a link record carries everything a replicated document must.
     */
    const m = await memoryMod.saveFact(SPACE, 'Complete', [E1]);
    const [l] = await links();
    const required = Object.entries(IncomingLinkDoc.shape)
      .filter(([, v]) => !v.isOptional())
      .map(([k]) => k);
    assert.ok(required.length >= 8,
      `only ${required.length} required field(s) on IncomingLinkDoc — the import is stale and this asserts `
      + 'nothing about a link record at all');
    for (const f of required) {
      assert.notEqual(l[f], undefined,
        `a link record is missing \`${f}\`, which its ingest schema REQUIRES — so this link is kept on pull `
        + `and refused or stripped on push: ${JSON.stringify(l)}`);
    }
    assert.equal(l.spaceId, SPACE);
    assert.equal(l.from, m._id);
    assert.ok(Number.isInteger(l.seq) && l.seq > 0, `seq must be a real counter, got ${l.seq}`);
    // And nothing it has no meaning for — a stored label is the degree of freedom the arrays never had.
    for (const f of ['label', 'type', 'weight', 'properties', 'embedding', 'suppressEmbeddings']) {
      assert.equal(l[f], undefined, `a link record must not carry \`${f}\``);
    }
  });

  it('and the READERS are untouched in 2a — the baseline still answers the old way', async () => {
    /*
     * The guard on the slice's scope. With link records now being written, a reader that had quietly started
     * preferring them would make `the-link-baseline-3x-answered-db.test.js` pass for a new reason — so this
     * asserts the array is still the thing the walk follows, from inside the slice that could break it.
     */
    const edges = await import('../../server/dist/brain/edges.js');
    const m = await memoryMod.saveFact(SPACE, 'Still arrays', [E1]);
    assert.equal((await links()).length, 1, 'precondition: a link record exists');

    // Memories are opt-in on the walk. With the flag OFF the memory must not be reached — which it would be
    // if the walk had started reading link records, because a link record has no include flag of its own.
    const off = await edges.traverseGraph([SPACE], E1, 'both', undefined, 2, 100, true, false, false);
    assert.ok(!off.nodes.some(n => n._id === m._id),
      'the walk reached a memory with `includeMemories` off — a reader is already following link records, '
      + 'which is slice 2b and not this one');
  });
});
