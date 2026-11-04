/**
 * When a file's bytes are replaced, its OWN row stops matching by what the old bytes made, in the write that records the new
 * bytes: the machine-made description (and its `descriptionSource`), the excerpt, the vector, its model and `matchedText` go, and
 * the row is queued to re-embed from what remains. A description a person wrote stays, and the same bytes written again keep
 * everything (bundle-236, the drive of the parent row).
 *
 * ## The defect that bought it
 *
 * The bundle's clear removed the passage and caption rows of a replaced file (`#chunk`, `#media-chunk`) and nothing on the file's
 * own row. After `notes.md` was rewritten (a quokka sentence to a pangolin sentence) and converted again, the row kept the
 * description "Notes The quokka juggles..." (`descriptionSource: extracted`) and a `matchedText` holding the old text, so recall
 * for "quokka" still returned the file. The new run could not even replace it: `setDerivedDescriptionIfUnset` writes only where
 * no description is stored, so a derived description was never cleared and never refreshed. An image re-run kept the old caption as
 * the row's description, and a replacement the door skips (over `maxFileSizeBytes`) kept the old description and vector for good.
 *
 * ## The rules
 *
 *  1. A document rewritten with other text: right after the write the row holds no machine-made description, no excerpt, no vector
 *     and no `matchedText` of the old text, its re-embed is queued, and the text it re-embeds from does not hold the old sentence;
 *     the new run's description and excerpt then land.
 *  2. A description a person wrote survives a replacement.
 *  3. The same bytes written again keep the derived description, the excerpt and the vector.
 *  4. A replacement the door skips (over `maxFileSizeBytes`) drops the old derived description and vector too, and is re-embedded.
 *  5. An image replacement drops the caption-derived description.
 *  6. A peer's arrival of other bytes drops this instance's own derived fields (excerpt, vector, `matchedText`) and leaves the
 *     description, which is the publisher's and changes by the publisher's own write.
 *
 * ## Seen red
 *
 * On 0bf38055d rules 1, 4, 5 and 6 fail: the replaced row still carries the old description, excerpt and `matchedText`.
 *
 * Run: node --test testing/standalone/a-replaced-file-stops-matching-by-what-its-old-bytes-made-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openReplacedBytesDoor } from './_replaced-bytes-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'replacedrow';
const DOC = 'notes.md';
const OLD_DOC = '# Notes\n\nThe quokka juggles three oranges at dawn.\n';
const NEW_DOC = '# Notes\n\nThe pangolin hums a tune at dusk.\n';
const IMG = 'portrait.png';
const OLD_IMG = 'the bytes of the portrait before it was replaced';
const NEW_IMG = 'the bytes of the portrait that replaced it';

let d;
let fm;
let embedText;
let embedJobs;

/** Stand in for the embed job the model would run: the vector, its model, and the text it embedded. */
async function embedAs(path, text) {
  await d.files().updateOne({ _id: path }, { $set: { matchedText: text, embedding: [0.25, 0.5, 0.75], embeddingModel: 'test-model' } });
}

/** A run of the bytes at `path`: claim its job, derive a description (and an excerpt), embed, and settle it `complete`. */
async function runOf(path, { description, source, excerpt }) {
  const { claim } = await d.claimNow(path);
  assert.equal(await d.derived.setDerivedDescriptionIfUnset(SPACE, claim, path, description, source), true,
    'fixture check: the run stored its derived description');
  if (excerpt !== undefined) assert.equal(await d.derived.setDerivedExcerpt(SPACE, claim, path, excerpt), 'written', 'fixture check: the run stored its excerpt');
  await embedAs(path, [description, excerpt].filter(Boolean).join(' '));
  await d.settle(path, 'complete');
}

const row = (path) => d.files().findOne({ _id: path });

/** What the row would be re-embedded from now. */
async function textOf(path) {
  return embedText.buildEmbedText(SPACE, 'file', await row(path));
}

const queuedReembed = async (path) => (await embedJobs().countDocuments({ recordType: 'file', recordId: path })) > 0;

describe('a replaced file stops matching by what its old bytes made (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openReplacedBytesDoor({ suite: 'replacedrow', space: SPACE });
    fm = await import('../../server/dist/files/file-meta.js');
    embedText = await import('../../server/dist/brain/embed-record.js');
    const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
    embedJobs = () => d.door.mongo.col(spaceCollection(SPACE, 'embedJobs'));
  });
  after(async () => { d?.capMediaBytes(null); await d?.close(); });
  beforeEach(async () => { d.capMediaBytes(null); await d.reset(); await embedJobs().deleteMany({}); });

  it('a document rewritten with other text: the old derived description, excerpt and vector go in the write, and the new run\'s land', async () => {
    await d.put(DOC, OLD_DOC);
    await runOf(DOC, { description: 'Notes The quokka juggles three oranges at dawn.', source: 'extracted', excerpt: 'The quokka juggles three oranges at dawn.' });
    assert.match(await textOf(DOC), /quokka/, 'fixture check: the row embeds from the old text before the replacement');
    await embedJobs().deleteMany({});

    await d.put(DOC, NEW_DOC);
    const after = await row(DOC);
    assert.equal(after.description, undefined, `the machine-made description of the old bytes is still on the row: ${JSON.stringify(after.description)}`);
    assert.equal(after.descriptionSource, undefined, 'the marker of a description that is gone is still on the row');
    assert.equal(after.excerpt, undefined, `the excerpt of the old bytes is still on the row: ${JSON.stringify(after.excerpt)}`);
    assert.equal(after.matchedText, undefined, `the row still matches by the old text: ${JSON.stringify(after.matchedText)}`);
    assert.equal(after.embedding, undefined, 'the vector of the old text is still on the row');
    assert.equal(after.embeddingModel, undefined, 'the model of a vector that is gone is still on the row');
    assert.doesNotMatch(await textOf(DOC) ?? '', /quokka/, 'the row would be re-embedded from the old text');
    assert.ok(await queuedReembed(DOC), 'the row was not queued to re-embed from what remains');

    await runOf(DOC, { description: 'Notes The pangolin hums a tune at dusk.', source: 'extracted', excerpt: 'The pangolin hums a tune at dusk.' });
    const fresh = await row(DOC);
    assert.equal(fresh.description, 'Notes The pangolin hums a tune at dusk.');
    assert.equal(fresh.descriptionSource, 'extracted');
    assert.equal(fresh.excerpt, 'The pangolin hums a tune at dusk.');
  });

  it('a description a person wrote survives a replacement', async () => {
    await d.put(DOC, OLD_DOC);
    await fm.updateFileMeta(SPACE, DOC, { description: 'my reading notes' });
    await embedAs(DOC, 'my reading notes');
    await d.put(DOC, NEW_DOC);
    const after = await row(DOC);
    assert.equal(after.description, 'my reading notes', 'the replacement removed a description a person wrote');
    assert.equal(after.descriptionSource, undefined);
  });

  it('the same bytes written again keep the derived description, the excerpt and the vector', async () => {
    await d.put(DOC, OLD_DOC);
    await runOf(DOC, { description: 'Notes The quokka juggles three oranges at dawn.', source: 'extracted', excerpt: 'The quokka juggles three oranges at dawn.' });
    await d.put(DOC, OLD_DOC);
    const after = await row(DOC);
    assert.equal(after.description, 'Notes The quokka juggles three oranges at dawn.', 'identical bytes lost their derived description');
    assert.equal(after.descriptionSource, 'extracted');
    assert.equal(after.excerpt, 'The quokka juggles three oranges at dawn.', 'identical bytes lost their excerpt');
    assert.ok(Array.isArray(after.embedding), 'identical bytes lost their vector');
    assert.equal(after.embeddingStatus, 'complete', 'fixture check: identical settled bytes are left alone');
  });

  it('a replacement the door skips (over maxFileSizeBytes) drops the old derived description and vector, and is re-embedded', async () => {
    await d.put(IMG, OLD_IMG);
    await runOf(IMG, { description: 'A quokka on a red bicycle', source: 'generated' });
    await embedJobs().deleteMany({});
    d.capMediaBytes(10);
    await d.put(IMG, NEW_IMG);
    const after = await row(IMG);
    assert.equal(after.embeddingStatus, 'skipped', 'fixture check: the replacement was skipped');
    assert.equal(after.description, undefined, `the skipped replacement kept the caption of the old bytes: ${JSON.stringify(after.description)}`);
    assert.equal(after.matchedText, undefined, 'the skipped replacement kept the old matched text');
    assert.equal(after.embedding, undefined, 'the skipped replacement kept the old vector');
    assert.doesNotMatch(await textOf(IMG) ?? '', /quokka/);
    assert.ok(await queuedReembed(IMG), 'the skipped replacement was not queued to re-embed from what remains');
  });

  it('an image replacement drops the caption-derived description', async () => {
    await d.put(IMG, OLD_IMG);
    await runOf(IMG, { description: 'A quokka on a red bicycle', source: 'generated' });
    await d.put(IMG, NEW_IMG);
    const after = await row(IMG);
    assert.equal(after.embeddingStatus, 'pending', 'fixture check: the replacement is queued');
    assert.equal(after.description, undefined, `the caption of the old picture is still the row's description: ${JSON.stringify(after.description)}`);
    assert.equal(after.descriptionSource, undefined);
    assert.equal(after.matchedText, undefined);
  });

  it('a peer\'s arrival of other bytes drops this instance\'s derived fields and leaves the publisher\'s description', async () => {
    await d.put(DOC, OLD_DOC, { arrival: true });
    // What a peer's copy holds: the publisher's description (replicated) and this instance's own excerpt and vector.
    await d.files().updateOne({ _id: DOC }, { $set: { description: 'Notes The quokka juggles', descriptionSource: 'extracted', excerpt: 'The quokka juggles three oranges at dawn.' } });
    await embedAs(DOC, 'Notes The quokka juggles The quokka juggles three oranges at dawn.');
    await d.put(DOC, NEW_DOC, { arrival: true });
    const after = await row(DOC);
    assert.equal(after.excerpt, undefined, 'the arrival kept the excerpt this instance made from the old bytes');
    assert.equal(after.matchedText, undefined, 'the arrival kept the matched text of the old bytes');
    assert.equal(after.embedding, undefined, 'the arrival kept the vector of the old bytes');
    assert.equal(after.description, 'Notes The quokka juggles',
      'the arrival changed the publisher\'s description on this copy: a hashed field written here with no version diverges from the publisher for good');
    assert.equal(after.descriptionSource, 'extracted');
  });
});
