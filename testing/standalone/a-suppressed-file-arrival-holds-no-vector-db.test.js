/**
 * A FILE this instance suppresses holds no vector after its metadata arrives, and neither do the rows derived from it
 * (Q-230, the file tier; Q-361 item 11).
 *
 * ## The rule
 *
 * A peer's file metadata is MERGED (`ingestFileMeta`: the authored keys are `$set`, nothing is replaced), so the
 * receiver's own vector, its model and `matchedText` stay on the row across the arrival. That is right for a file this
 * instance still embeds, and wrong for one it suppresses: the vector was derived from content that has just been
 * replaced, and it keeps the file in meaning-ranked search by exactly the mechanism suppression switches off. The same
 * holds for the file's chunk and passage rows (`parentFileId`), which are searched on their own vectors. The three
 * other record families already hold this (`a-suppressed-arrival-keeps-no-derived-field-db`, 5.6.3); the file family
 * was left out because it is merged, not replaced.
 *
 * So: when this instance suppresses the arriving file — decided from the ARRIVING record flag OR the STORED one
 * (a file has two tiers, its own flag and the space; no type, so no schema tier) — the file's derived fields
 * (`embedding`, `embeddingModel`, `matchedText`) are dropped with its row, and its chunk and passage rows lose their
 * `embedding` and `embeddingModel`. The chunk rows are cleared BEFORE the parent's row is written, so an arrival whose
 * row write fails has cleared them already and its re-fetch repeats the drop.
 *
 * A file this instance does NOT suppress keeps every derived field and its chunks keep theirs (pins, green before the
 * fix). Doors: the batch push (a file has no single route) and the real engine's pull.
 *
 * Seen red on 6eb5a333 (5.6.3): every suppressed row keeps its vector, model and matchedText, and every chunk its
 * vector.
 *
 * Run: node --test testing/standalone/a-suppressed-file-arrival-holds-no-vector-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { withValidator } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** No tier suppresses here but the record's own. */
const OPEN = 'filesup-open';
/** The SPACE suppresses. */
const QUIET = 'filesup-quiet';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const PARENT_DERIVED = ['embedding', 'embeddingModel', 'matchedText'];
const CHUNK_VECTOR = ['embedding', 'embeddingModel'];
const VALUES = { embedding: [0.25, 0.5, 0.75], embeddingModel: 'receiver-model', matchedText: 'what this instance embedded from the PREVIOUS content' };
const FILE = 'docs/a.md';

let door, recordArrivedFile;

/** A stored file row holding this instance's vector, with two derived rows (a chunk and a passage) holding theirs. */
async function seed(space, { storedFlag = false } = {}) {
  await door.coll(space, 'files').insertMany([
    { ...build.filemeta(space, FILE, 5, { author: { ...PEER_AUTHOR } }), ...VALUES, ...(storedFlag ? { suppressEmbeddings: true } : {}) },
    { _id: `${FILE}#chunk0`, spaceId: space, path: `${FILE}#chunk0`, parentFileId: FILE, content: 'a chunk', tags: [], ...VALUES },
    { _id: `${FILE}#passage0`, spaceId: space, path: `${FILE}#passage0`, parentFileId: FILE, content: 'a passage', tags: [], ...VALUES },
  ]);
}
const arrival = (space, extra = {}) => build.filemeta(space, FILE, 6, { author: { ...PEER_AUTHOR }, description: 'the new content', ...extra });

const DOORS = {
  async batch(space, doc) {
    const r = await door.push('/batch-upsert', { filemeta: [doc] }, { spaceId: space, networkId: door.NET, token: TOKEN });
    assert.equal(r.code, 200, JSON.stringify(r.body));
  },
  async pull(space, doc) {
    door.state.records[space] = { filemeta: [doc] };
    await door.sync();
  },
};

/** What a row holds, for an assertion message. */
const held = (row, fields) => fields.filter(f => f in (row ?? {}));

describe('a suppressed file arrival holds no vector (Q-230, file tier)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({
      suite: 'filesup', spaces: [OPEN, QUIET],
      spaceSettings: { [QUIET]: { meta: { suppressEmbeddings: true } } },
    });
    ({ recordArrivedFile } = await import('../../server/dist/files/file-meta.js'));
  });
  after(async () => { await door?.close(); });
  // (the import below runs after the door, which sets CONFIG_PATH)
  beforeEach(async () => { await door.reset(); });

  for (const via of Object.keys(DOORS)) {
    const cases = {
      'the ARRIVING record flag suppresses it': { space: OPEN, extra: { suppressEmbeddings: true }, storedFlag: false },
      'the STORED record flag suppresses it (the arrival does not carry the flag)': { space: OPEN, extra: {}, storedFlag: true },
      'the SPACE suppresses it': { space: QUIET, extra: {}, storedFlag: false },
    };
    for (const [why, c] of Object.entries(cases)) {
      it(`${via}: ${why}: the row holds no embedding, model or matchedText, and its chunk and passage rows no vector`, async () => {
        await seed(c.space, { storedFlag: c.storedFlag });
        await DOORS[via](c.space, arrival(c.space, c.extra));
        const parent = await door.coll(c.space, 'files').findOne({ _id: FILE });
        assert.equal(parent?.seq, 6, `fixture check: the arrival did not land (${JSON.stringify(parent)})`);
        assert.deepEqual(held(parent, PARENT_DERIVED), [],
          `${via}: the file kept ${held(parent, PARENT_DERIVED)} from the content it replaced`);
        const derived = await door.coll(c.space, 'files').find({ parentFileId: FILE }).toArray();
        assert.equal(derived.length, 2, 'fixture check: the derived rows are gone');
        assert.deepEqual(derived.flatMap(r => held(r, CHUNK_VECTOR).map(f => `${r._id}.${f}`)), [],
          `${via}: derived rows of a file this instance suppresses still hold a vector`);
      });
    }

    it(`PIN ${via}: a file nothing suppresses keeps its vector and its derived rows keep theirs`, async () => {
      await seed(OPEN);
      await DOORS[via](OPEN, arrival(OPEN));
      const parent = await door.coll(OPEN, 'files').findOne({ _id: FILE });
      assert.equal(parent?.seq, 6, 'fixture check: the arrival did not land');
      assert.deepEqual(held(parent, PARENT_DERIVED), PARENT_DERIVED, 'the receiver\'s own vector was erased by a peer\'s edit');
      const derived = await door.coll(OPEN, 'files').find({ parentFileId: FILE }).toArray();
      assert.deepEqual(derived.map(r => held(r, CHUNK_VECTOR).length), [2, 2]);
    });
  }

  it('PIN bytes for a file this instance suppresses are still QUEUED: the embed worker\'s excluded branch is what removes a vector', async () => {
    // Queuing a suppressed file is correct at 5.6.3 and stays (the queue is not where suppression is decided; the worker
    // is, and it unsets the vector and model). The fix for the file tier is the arrival and the sweep, not the queue.
    const queued = async (id) => !!(await door.coll(OPEN, 'embed_jobs').findOne({ _id: `file:${id}` }));
    await door.coll(OPEN, 'files').insertMany([
      { ...build.filemeta(OPEN, 'quiet.md', 5, { author: { ...PEER_AUTHOR } }), suppressEmbeddings: true, ...VALUES },
      build.filemeta(OPEN, 'loud.md', 5, { author: { ...PEER_AUTHOR } }),
    ]);
    await recordArrivedFile(OPEN, 'quiet.md', 10, 'hash-quiet', PEER_AUTHOR);
    await recordArrivedFile(OPEN, 'loud.md', 10, 'hash-loud', PEER_AUTHOR);
    assert.equal(await queued('loud.md'), true, 'control: a file nothing suppresses is queued when its bytes land');
    assert.equal(await queued('quiet.md'), true, 'a suppressed file\'s job is no longer queued — the worker would never remove its vector');
  });

  it('a row write that fails has cleared the derived rows already, and the retry lands with the file clean', async () => {
    await seed(OPEN);
    // The store refuses a file row written at seq 6 (code 121); the derived rows carry no seq, so only the parent's write fails.
    await withValidator(door.mongo.getDb(), `${OPEN}_files`, { seq: { $ne: 6 } }, async () => {
      const r = await door.push('/batch-upsert', { filemeta: [arrival(OPEN, { suppressEmbeddings: true })] },
        { spaceId: OPEN, networkId: door.NET, token: TOKEN });
      assert.notEqual(r.code, 200, 'fixture check: the store accepted the write the validator refuses');
    });
    const parent = await door.coll(OPEN, 'files').findOne({ _id: FILE });
    assert.equal(parent?.seq, 5, 'fixture check: the refused row landed');
    const derived = await door.coll(OPEN, 'files').find({ parentFileId: FILE }).toArray();
    assert.deepEqual(derived.flatMap(r => held(r, CHUNK_VECTOR).map(f => `${r._id}.${f}`)), [],
      'the arrival failed after clearing nothing: its re-fetch would find the derived rows still holding vectors of replaced content');
    // The retry (a re-sent page) lands, and the file itself is clean.
    await DOORS.batch(OPEN, arrival(OPEN, { suppressEmbeddings: true }));
    const landed = await door.coll(OPEN, 'files').findOne({ _id: FILE });
    assert.deepEqual([landed?.seq, held(landed, PARENT_DERIVED)], [6, []]);
  });
});