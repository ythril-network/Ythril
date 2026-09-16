/**
 * What the ARRAY-based link walk answers today — captured before `M-2` slice 2 replaces it.
 *
 * Runs in the OFFLINE subset, like every other `-db` file here: it drives a real MongoDB through the
 * server's own data layer and needs no running instance. Do NOT write the words that preflight's
 * exclusion regex matches into this header — it is anchored to a header line, so even a sentence
 * SAYING the file does not need an instance would exclude it, and a test nobody runs locally is a test
 * whose failures arrive from CI.
 *
 * ## Why this file exists, and why now rather than later
 *
 * Owner-directed, 2026-09-03: *"4.0 is a big change thanks to links and other stuff — it should not break or
 * have worse performance than 3.x — we want to excite everyone."* And, an hour later, the correction that
 * shapes it: *"must not be different is not correct — its getting better by design."*
 *
 * **The baseline is perishable.** Slice 2 switches every adjacency reader from array fields to link records.
 * The moment it does, "what did 3.x answer?" is unrecoverable from the code — so it is written down here,
 * from a real database, while it is still true. `Q-7` in `QA-TODO.md` is the whole item.
 *
 * ## It pins TWO different things, and conflating them is the mistake to avoid
 *
 * **1. What must not change.** Three link classes have a reader today — `fact.entityIds`,
 * `chrono.entityIds`, `file.entityIds`. For those, this file is a characterization test in the strict sense:
 * the exact set reached, from the exact seed, through the real query. Slice 2 must reproduce it. A different
 * answer here is a regression, full stop.
 *
 * **2. What must GET BETTER — recorded as a gap, never asserted as correct.** The other three —
 * `chrono.memoryIds`, `file.memoryIds`, `file.chronoIds` — are accepted, resolvability-checked, stored,
 * replicated and documented, and **no walk has ever read them**: `link-adjacency.ts` names `entityIds`
 * fifteen times and those two field names zero.
 *
 * So the assertions in the second half deliberately state a DEFICIT, and each one says out loud that slice 2
 * is expected to invert it. **Inverting them is the deliverable, not a break.** They are written to fail
 * loudly rather than to be quietly deleted: each asserts BOTH that the data says the two records are
 * connected AND that the walk does not see it, so nobody can satisfy it by removing the seed.
 *
 * That distinction is the owner's correction made mechanical. A gate asserting "same answer as 3.x" across
 * all six classes would pin the poorer behaviour and fail on the improvement.
 *
 * Run: node --test testing/standalone/the-link-baseline-3x-answered-db.test.js
 * (requires `npm run test:up` and a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-link-baseline-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';

/** One corpus that exercises all six link classes at once, so nothing is measured in isolation. */
const ENT = 'aaaaaaaa-0000-4000-8000-00000000000e';
const MEM = 'aaaaaaaa-0000-4000-8000-00000000000m'.replace('m', '1');
const CHR = 'aaaaaaaa-0000-4000-8000-00000000000c'.replace('c', '2');
const FILE = 'notes/spec.md';

let mongo, edgesMod, entitiesMod, erMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('the 3.x link baseline — what the array walk answered', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('linkbaseline');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'link-baseline-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    edgesMod = await import('../../server/dist/brain/edges.js');
    entitiesMod = await import('../../server/dist/brain/entities.js');
    erMod = await import('../../server/dist/brain/er-model.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files', 'links']) await coll(c).deleteMany({});

    // ONE entity, and three records that name it and each other — every one of the six classes, once.
    await coll('entities').insertOne({
      _id: ENT, spaceId: SPACE, name: 'Vault', type: 'service', tags: [], seq: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await coll('facts').insertOne({
      _id: MEM, spaceId: SPACE, fact: 'Vault rotates its credentials nightly', tags: [],
      entityIds: [ENT], seq: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await coll('chrono').insertOne({
      _id: CHR, spaceId: SPACE, title: 'Credential rotation incident', type: 'event',
      startsAt: '2026-01-02T00:00:00.000Z', status: 'completed', tags: [],
      entityIds: [ENT], memoryIds: [MEM], seq: 3,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await coll('files').insertOne({
      _id: FILE, spaceId: SPACE, path: FILE, tags: [], sizeBytes: 10,
      entityIds: [ENT], memoryIds: [MEM], chronoIds: [CHR], seq: 4,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    /*
     * A CHUNK of that file, carrying the same entity link — and it is in the seed because a mutation proved
     * the corpus needed it.
     *
     * Chunk records share the files collection with the file they came from and are distinguished only by
     * `parentFileId`, which is why the file link class carries a `scope` the other two do not. Pointing the
     * file half of the backlink scan at the MEMORY class — which has no scope — survived every assertion in
     * this file, because with no chunk in the corpus the scope could not matter. A forty-passage document
     * counted forty times is the defect that scope exists for, and it was untested here.
     */
    await coll('files').insertOne({
      _id: `${FILE}#0`, spaceId: SPACE, path: `${FILE}#0`, tags: [], sizeBytes: 4,
      parentFileId: FILE, chunkIndex: 0, entityIds: [ENT], seq: 5,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('the modules are the ones this file thinks they are', () => {
    // Floors every case below. A renamed export would make each one throw rather than assert, and a file
    // that throws in `before` reports zero failures for the property it exists to pin.
    assert.equal(typeof edgesMod.traverseGraph, 'function', 'traverseGraph');
    assert.equal(typeof entitiesMod.findEntityReferences, 'function', 'findEntityReferences');
    assert.equal(typeof erMod.buildErModel, 'function', 'buildErModel');
  });

  it('the seed is a corpus, not an empty database — the check before every property', async () => {
    // The whole file would pass vacuously against an empty space: every "reaches nothing" assertion in the
    // second half would be true for the wrong reason.
    assert.equal(await coll('entities').countDocuments({}), 1);
    assert.equal(await coll('facts').countDocuments({}), 1);
    assert.equal(await coll('chrono').countDocuments({}), 1);
    assert.equal(await coll('files').countDocuments({}), 2, 'the file AND one chunk of it');
    assert.equal(await coll('files').countDocuments({ parentFileId: { $exists: true } }), 1,
      'exactly one of the two is a chunk — the scope the file link class carries has something to exclude');
    assert.equal(await coll('links').countDocuments({}), 0, 'no link RECORD exists yet — that is slice 2');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // PART ONE — what must not change. Exact sets, from the real query.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('BASELINE: chrono.entityIds is followed by default, memories and files are not', async () => {
    /*
     * The default shape, and the asymmetry is deliberate rather than an oversight: chrono is on because a
     * chrono entry is otherwise unreachable and sparse; memories are off because a memory-heavy space would
     * fill the node budget and truncate away the entities the caller traversed for.
     *
     * Slice 2 must reproduce this exactly. If the defaults change, that is a product decision and belongs in
     * the CHANGELOG, not in a quietly different test.
     */
    const res = await edgesMod.traverseGraph([SPACE], ENT, 'both', undefined, 2, 100);
    const kinds = res.nodes.map(n => n.kind ?? 'entity').sort();
    assert.deepEqual(kinds, ['chrono'],
      `default traverse reached ${JSON.stringify(kinds)} — chrono on, memory and file off is the 3.x default`);
    assert.ok(res.nodes.some(n => n._id === CHR), 'the chrono entry naming this entity must be reached');
  });

  it('BASELINE: each toggle adds exactly its own class and nothing else', async () => {
    // One assertion per flag, because a flag that turns on two classes is indistinguishable from a working
    // one when they are tested together.
    const kindsWith = async (chrono, mem, file) => {
      const r = await edgesMod.traverseGraph([SPACE], ENT, 'both', undefined, 2, 100, chrono, mem, file);
      return r.nodes.map(n => n.kind ?? 'entity').sort();
    };
    // MEASURED, not assumed — and my first draft of this file assumed wrong, which is the argument for
    // writing it against a real database rather than from the signature.
    assert.deepEqual(await kindsWith(false, false, false), [], 'all off reaches NOTHING from a lone entity');
    assert.deepEqual(await kindsWith(true, false, false), ['chrono'], 'chrono only');
    assert.deepEqual(await kindsWith(false, true, false), ['fact'], 'memories only');
    assert.deepEqual(await kindsWith(false, false, true), ['file'], 'files only');
    assert.deepEqual(await kindsWith(true, true, true), ['chrono', 'fact', 'file'], 'all three');
  });

  it('BASELINE: the START NODE is not in `nodes` — `nodes` is what was REACHED', async () => {
    /*
     * Pinned on its own because it is the shape most likely to change by accident when the reader is
     * rewritten, and because it is invisible in the signature: my first draft of this file expected the
     * entity to be there and was wrong three assertions in a row for one reason.
     *
     * With every toggle off, a traverse from a lone entity with no edges reaches NOTHING — not itself. A
     * slice-2 reader that included the origin would make every count in every client one larger, silently.
     */
    const off = await edgesMod.traverseGraph([SPACE], ENT, 'both', undefined, 2, 100, false, false, false);
    assert.deepEqual(off.nodes, [], 'a walk from a lone entity reaches nothing, and does not report itself');
    const on = await edgesMod.traverseGraph([SPACE], ENT, 'both', undefined, 2, 100, true, true, true);
    assert.ok(!on.nodes.some(n => n._id === ENT), 'the origin must not appear among what was reached');
  });

  it('BASELINE: the synthetic edge carries the class as its label', async () => {
    // The label is what lets `edgeLabels` include or exclude a derived link like any modelled one, and what
    // lets a reader tell a modelled relationship from a derived one. Slice 2 keeps it DERIVED from the two
    // endpoint kinds rather than storing it — so this is the string that must not move.
    const res = await edgesMod.traverseGraph([SPACE], ENT, 'both', undefined, 2, 100, true, true, true);
    const labels = [...new Set(res.edges.map(e => e.label))].sort();
    assert.deepEqual(labels, ['chrono.entityIds', 'fact.entityIds', 'file.entityIds'],
      `the three derived labels are the contract: got ${JSON.stringify(labels)}`);
  });

  it('BASELINE: the entity backlink scan finds all three classes that name the entity', async () => {
    // This is the scan that REFUSES an entity delete under strict linkage, so its coverage is a data-safety
    // property rather than a convenience: a class it cannot see is a delete it cannot block.
    /*
     * Asserted on the IDENTITY of what came back, not on its label — and a mutation is what forced that.
     *
     * The first version compared the set of `type` values. Pointing the FILE half of the scan at the MEMORY
     * class survived it: the query then read the memories collection while the surrounding block still
     * stamped `type: 'file'` on the result, so the label set was unchanged and the test passed on the wrong
     * data. A label is what the code CLAIMS it found; the `_id` is what it found.
     */
    const refs = await entitiesMod.findEntityReferences(SPACE, ENT);
    const found = refs.map(r => `${r.type}:${r._id}`).sort();
    assert.deepEqual(found, [`chrono:${CHR}`, `fact:${MEM}`, `file:${FILE}`],
      `the backlink scan returned ${JSON.stringify(found)} — each of the three collections must be read, and`
      + ' each must return the record from ITS OWN collection');
  });

  it('BASELINE: the ER model counts the entity type\'s inbound links per collection', async () => {
    // A STRING, not [SPACE]. `buildErModel` takes one space id; the array worked only because a template
    // literal coerces it, and `spaceCollection` refuses it. The old spelling made a JS caller
    // type-safe by accident, which is one of the things routing the name through a function buys.
    const er = await erMod.buildErModel(SPACE);
    const svc = er.entityTypes?.find(t => t.type === 'service');
    assert.ok(svc, `the seeded entity type is absent from the ER model: ${JSON.stringify(er.entityTypes)}`);
    assert.deepEqual(
      { facts: svc.linkedFrom?.facts ?? 0, chrono: svc.linkedFrom?.chrono ?? 0, files: svc.linkedFrom?.files ?? 0 },
      { facts: 1, chrono: 1, files: 1 },
      'one of each names the one entity, and the ER model reports all three',
    );
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // PART TWO — the deficit. Every assertion here is EXPECTED TO INVERT at slice 2.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('CLOSED: chrono.memoryIds is read — a traverse from the memory reaches the chrono entry naming it', async () => {
    /*
     * **Inverted at slice 2b, which is what the deficit version of this case asked for in as many words.**
     * It read `assert.ok(!res.nodes.some(...))` with the message "SLICE 2 HAS LANDED. Invert this assertion
     * rather than deleting it". This is that inversion, and the case keeps its number and its seed so the
     * before and after are the same question asked twice.
     *
     * Both halves are still asserted. The first proves the DATA says they are connected, so the second
     * cannot be satisfied by seeding differently — which is the only way a reachability test can be quietly
     * made to pass.
     */
    const chrono = await coll('chrono').findOne({ _id: CHR });
    assert.deepEqual(chrono.memoryIds, [MEM], 'the data says this chrono entry names that memory');

    const res = await edgesMod.traverseGraph([SPACE], MEM, 'both', undefined, 2, 100, true, true, true);
    assert.ok(res.nodes.some(n => n._id === CHR),
      'a traverse from the memory does not reach the chrono entry that names it. `chrono.memoryIds` has been '
      + 'stored, resolvability-checked, replicated and documented since 3.x with no reader at all; 2b is what '
      + 'gives it one.');
  });

  it('CLOSED: file.memoryIds is read', async () => {
    // Same shape, same inversion. See the case above for why both halves are asserted.
    const file = await coll('files').findOne({ _id: FILE });
    assert.deepEqual(file.memoryIds, [MEM], 'the data says this file names that memory');

    const res = await edgesMod.traverseGraph([SPACE], MEM, 'both', undefined, 2, 100, true, true, true);
    assert.ok(res.nodes.some(n => n._id === FILE),
      'a traverse from the memory does not reach the file that names it');
  });

  it('CLOSED: file.chronoIds is read', async () => {
    const file = await coll('files').findOne({ _id: FILE });
    assert.deepEqual(file.chronoIds, [CHR], 'the data says this file names that chrono entry');

    const res = await edgesMod.traverseGraph([SPACE], CHR, 'both', undefined, 2, 100, true, true, true);
    assert.ok(res.nodes.some(n => n._id === FILE),
      'a traverse from the chrono entry does not reach the file that names it');
  });

  it('CLOSED: the scan that blocks a DELETE sees a reference to a MEMORY', async () => {
    /*
     * The consequence an operator actually meets, and it is a BEHAVIOUR CHANGE rather than a new feature:
     * until 2b nothing blocked deleting a memory that a chrono entry named, even under strict linkage,
     * because that link had no reader. It is refused now.
     *
     * A running script can hit this, which is why the six-field deprecation row announces the behaviour and
     * not only the fields.
     */
    assert.equal(typeof entitiesMod.findEntityReferences, 'function');

    // ASKED FOR THE RIGHT KIND. A memory id is not an entity id, so the two-argument call below still
    // correctly answers nothing — the kind is a parameter and not a guess, because a UUID cannot say which
    // collection it belongs to and inferring it would be a scan of four collections hoping for one hit.
    const refs = await entitiesMod.findEntityReferences(SPACE, MEM, 'fact');
    assert.deepEqual(refs.map(r => `${r.type}:${r._id}`).sort(), [`chrono:${CHR}`, `file:${FILE}`].sort(),
      'the scan still cannot see what references a memory. Asserted on IDENTITY rather than on a count, '
      + 'because a scan pointed at the wrong collection returns a plausible number.');

    // And the DEFAULT has not moved. Every existing caller passes two arguments and means entities; a
    // default that had quietly widened would make an entity delete start reporting blockers of other kinds.
    assert.deepEqual(await entitiesMod.findEntityReferences(SPACE, MEM), [],
      'the two-argument call is asking what references this id AS AN ENTITY, and nothing does');
  });
});
