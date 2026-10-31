/**
 * A file this instance suppresses is given its own text with no vector beside it, its passages' vectors included (Q-656).
 *
 * ## The defect it prevents
 *
 * `embedArrivedFiles` (`sync/embed-arrived-files.ts`) wrote a suppressed file's `matchedText` from the `set` of
 * `derivedFieldsForWrite` and dropped its `unset`. `dropFileVectors` runs just before the text is written, and a vector that
 * lands between the two (an embed job that was already running, a stray fill) stayed beside the new text: neither repair walk sees
 * the row afterwards (its text is current and it holds a vector), so a suppressed file stayed in meaning-ranked search for good.
 * The text write has to remove the vector itself, as every other writer of a suppressed record's text does.
 *
 * A page of such rows is also built in one batch, and one row with a wrong-typed field (`tags: 'x'`, which a pull can store) failed
 * the whole batch: none of its neighbours was given its text either.
 *
 * ## What is asked, against a real MongoDB
 *
 * - a suppressed row that held a vector (and passages that did) is left with its own text and no vector, and a row this
 *   instance embeds is not touched;
 * - a vector that is back AFTER the drop ran: the text write's own `unset` removes it. The window is made real by a hook on the
 *   collection's `updateOne` that lands the vector just before the text write, since the drop of the same call already ran;
 * - a page with one wrong-typed row stores the text of the others.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-suppressed-file-keeps-no-vector-beside-its-text-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-suppressed-file-vector-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const NOW = '2026-01-01T00:00:00.000Z';
const VEC = [0.1, 0.2, 0.3, 0.4];
const row = (id, extra = {}) => ({ _id: id, spaceId: SPACE, path: id, tags: [], createdAt: NOW, updatedAt: NOW, sizeBytes: 3, seq: 1, ...extra });

let mongo, arrived, embedRecord;
const files = () => mongo.col(`${SPACE}_files`);

describe('a suppressed file keeps no vector beside its text', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('suppressedfilevector');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'suppressed-file-vector-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    arrived = await import('../../server/dist/sync/embed-arrived-files.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a suppressed row that held a vector is left with its own text and no vector, and so are its passages', async () => {
    await files().deleteMany({});
    await files().insertMany([
      row('docs/quiet.md', { suppressEmbeddings: true, description: 'newly kept out', embedding: VEC, embeddingModel: 'm', matchedText: 'old text' }),
      row('docs/quiet.md#chunk0', { parentFileId: 'docs/quiet.md', chunkIndex: 0, content: 'a passage', embedding: VEC, embeddingModel: 'm' }),
      row('docs/loud.md', { description: 'embedded', embedding: VEC, embeddingModel: 'm', matchedText: 'loud text' }),
    ]);
    await arrived.embedArrivedFiles(SPACE, ['docs/quiet.md', 'docs/loud.md']);

    const quiet = await files().findOne({ _id: 'docs/quiet.md' });
    assert.equal(quiet.matchedText, await embedRecord.buildEmbedText(SPACE, 'file', quiet), 'the row was not given its own text');
    assert.equal(quiet.embedding, undefined, 'the suppressed row keeps a vector beside its new text');
    assert.equal(quiet.embeddingModel, undefined, 'the suppressed row keeps its vector\'s model');
    assert.equal((await files().findOne({ _id: 'docs/quiet.md#chunk0' })).embedding, undefined, 'a passage of the suppressed file keeps its vector');

    const loud = await files().findOne({ _id: 'docs/loud.md' });
    assert.deepEqual([loud.embedding, loud.matchedText], [VEC, 'loud text'], 'a row this instance embeds was touched');
  });

  it('a vector that is back after the drop is removed by the text write itself', async () => {
    // The drop and the text write are two statements, and a vector can land between them. The suppression sweep's drop is replaced here by
    // what a landing job does: the vector is written AFTER `embedArrivedFiles` has dropped, by a collection hook on the first text write.
    // The hook is the collection's own `updateOne`, called by `writeDerivedFields` for the text; it puts the vector back first, so a
    // text write that does not remove the vector leaves the pair standing.
    await files().deleteMany({});
    await files().insertOne(row('docs/late.md', { suppressEmbeddings: true, description: 'kept out', matchedText: 'old text' }));
    const real = mongo.col(`${SPACE}_files`);
    const proto = Object.getPrototypeOf(real);
    const originalUpdateOne = proto.updateOne;
    let landed = false;
    proto.updateOne = async function (filter, update, ...rest) {
      const touchesText = update?.$set && 'matchedText' in update.$set;
      if (!landed && touchesText && this.collectionName === `${SPACE}_files`) {
        landed = true;
        await originalUpdateOne.call(this, { _id: 'docs/late.md' }, { $set: { embedding: VEC, embeddingModel: 'm' } });
      }
      return originalUpdateOne.call(this, filter, update, ...rest);
    };
    try {
      await arrived.embedArrivedFiles(SPACE, ['docs/late.md']);
    } finally {
      proto.updateOne = originalUpdateOne;
    }
    assert.ok(landed, 'the text write never ran: this case asks nothing');
    const late = await files().findOne({ _id: 'docs/late.md' });
    assert.equal(late.matchedText, await embedRecord.buildEmbedText(SPACE, 'file', late), 'the row was not given its own text');
    assert.equal(late.embedding, undefined, 'the vector that landed before the text write stands beside the new text');
    assert.equal(late.embeddingModel, undefined, 'the model of that vector stands beside the new text');
  });

  it('a page with one wrong-typed row still stores the text of the others (Q-656)', async () => {
    await files().deleteMany({});
    await files().insertMany([
      row('docs/ok-1.md', { suppressEmbeddings: true, description: 'first' }),
      row('docs/bad.md', { suppressEmbeddings: true, tags: 'x' }),
      row('docs/ok-2.md', { suppressEmbeddings: true, description: 'second' }),
    ]);
    await arrived.embedArrivedFiles(SPACE, ['docs/ok-1.md', 'docs/bad.md', 'docs/ok-2.md']);
    for (const id of ['docs/ok-1.md', 'docs/ok-2.md']) {
      const doc = await files().findOne({ _id: id });
      assert.equal(doc.matchedText, await embedRecord.buildEmbedText(SPACE, 'file', doc), `${id} was not given its text because a neighbour on the page could not be built`);
    }
    assert.equal((await files().findOne({ _id: 'docs/bad.md' })).matchedText, undefined, 'a row whose text cannot be built was given one');
  });
});
