/**
 * A record whose embedded text did not change is not re-embedded.
 *
 * ## The waste
 *
 * Every successful update enqueues an embed job, unconditionally — which is right: the enqueue is also how the
 * `excludeFromVectorSearch` toggle takes effect, and it replaced four inline embeds built from stale reads. But
 * most updates change something the vector does not depend on. Editing a tag, a property, a link or a status paid
 * for a model call that could only reproduce the vector already stored.
 *
 * ## Why this is lossless rather than a heuristic
 *
 * A vector is a pure function of (text, model). Every embed already writes `matchedText` — the exact text it
 * embedded — beside the vector, so the fingerprint needed no new field and no migration of synced data. When the
 * newly built text equals `matchedText`, a vector is present, and the configured model is the one that produced
 * it, the model call cannot produce anything different.
 *
 * All three conditions are asserted here, each on its own, because it is the CONJUNCTION that makes the skip safe
 * and any one of them alone would make it a guess.
 *
 * Run: node --test testing/standalone/unchanged-text-is-not-re-embedded-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = `reembed${Date.now()}`;

let mongo;
let embedStoredRecord;

before(async () => {
  if (skip) return;
  mongo = await openTestMongo('reembedskip');
  ({ embedStoredRecord } = await import('../../server/dist/brain/embed-record.js'));
});

after(async () => {
  if (skip) return;
  await mongo.col(`${SPACE}_entities`).drop().catch(() => {});
  await closeTestMongo(mongo);
});

/**
 * "It did not skip" is proven by "it tried to embed".
 *
 * This harness has no loaded config — deliberately, it is a database harness — so reaching `embed()` fails with a
 * recognisable error. That failure is the evidence: the guard fell through and the model call was attempted. The
 * alternative, loading a whole config and standing up an embedder, would test the embedder rather than the guard.
 *
 * The message is matched rather than merely "it threw", so a different fault cannot pass as proof.
 */
async function attemptedToEmbed(id) {
  try {
    const outcome = await embedStoredRecord(SPACE, 'entity', id);
    return { attempted: false, outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /Config not loaded/,
      `expected the model call to be reached and fail on the absent config, got: ${msg}`);
    return { attempted: true, outcome: null };
  }
}

/** An entity as the store holds one, with whatever embedding state the case needs. */
async function seed(id, over = {}) {
  const c = mongo.col(`${SPACE}_entities`);
  await c.deleteOne({ _id: id }).catch(() => {});
  await c.insertOne({
    _id: id, spaceId: SPACE, name: 'vault', type: 'service', description: 'rotates credentials',
    tags: [], properties: {}, seq: 1, createdAt: new Date().toISOString(),
    ...over,
  });
  return c;
}

describe('the skip fires only when re-embedding could not change anything', { skip }, () => {
  it('identical text, vector present, same model -> unchanged', async () => {
    const { buildEmbedText } = await import('../../server/dist/brain/embed-record.js');
    const c = await seed('e-same');
    const doc = await c.findOne({ _id: 'e-same' });
    const text = await buildEmbedText(SPACE, 'entity', doc);
    const { getEmbeddingConfig } = await import('../../server/dist/config/loader.js');
    let model;
    try { model = getEmbeddingConfig().model; } catch { return; }   // no config in this harness: nothing to assert
    await c.updateOne({ _id: 'e-same' },
      { $set: { embedding: [0.1, 0.2, 0.3], embeddingModel: model, matchedText: text } });

    const outcome = await embedStoredRecord(SPACE, 'entity', 'e-same');
    assert.equal(outcome, 'unchanged',
      'the text, the model and the vector are all the ones already stored — the call cannot differ');

    // And the stored vector is untouched, which is the whole claim.
    const after = await c.findOne({ _id: 'e-same' });
    assert.deepEqual(after.embedding, [0.1, 0.2, 0.3]);
  });

  it('a CHANGED text re-embeds', async () => {
    const c = await seed('e-changed');
    await c.updateOne({ _id: 'e-changed' },
      { $set: { embedding: [0.1], embeddingModel: 'whatever', matchedText: 'something else entirely' } });
    const { attempted } = await attemptedToEmbed('e-changed');
    assert.equal(attempted, true, 'a different text must not be skipped — that would leave a stale vector');
  });

  it('a MISSING vector re-embeds, even with a matching text', async () => {
    // The case that would silently leave a record invisible to recall for ever: `matchedText` present from an
    // earlier embed, the vector unset by an exclusion toggle or a failed write.
    const { buildEmbedText } = await import('../../server/dist/brain/embed-record.js');
    const c = await seed('e-novector');
    const doc = await c.findOne({ _id: 'e-novector' });
    const text = await buildEmbedText(SPACE, 'entity', doc);
    await c.updateOne({ _id: 'e-novector' }, { $set: { matchedText: text }, $unset: { embedding: '' } });
    const { attempted } = await attemptedToEmbed('e-novector');
    assert.equal(attempted, true, 'no vector means there is nothing to keep');
  });

  it('a DIFFERENT model re-embeds', async () => {
    // The reindex case. Skipping here would leave a space half-migrated after a model change, which is the exact
    // condition `needsReindex` exists to report.
    const { buildEmbedText } = await import('../../server/dist/brain/embed-record.js');
    const c = await seed('e-oldmodel');
    const doc = await c.findOne({ _id: 'e-oldmodel' });
    const text = await buildEmbedText(SPACE, 'entity', doc);
    await c.updateOne({ _id: 'e-oldmodel' },
      { $set: { embedding: [0.1], embeddingModel: 'a-model-nobody-configured', matchedText: text } });
    const { attempted } = await attemptedToEmbed('e-oldmodel');
    assert.equal(attempted, true, 'a vector from another model must be replaced');
  });
});

describe('the guard is a conjunction, in source', () => {
  it('all three conditions, and the fingerprint is the existing field', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    const src = strip(readFileSync('server/src/brain/embed-record.ts', 'utf8'));
    // The guard is the worker's classifier, `embedOwed` (Q-656: the backfill asks it too): each of the three conditions answers
    // `embed` BEFORE `unchanged` can be returned, so `unchanged` is their conjunction.
    const at = src.indexOf('export function embedOwed');
    assert.ok(at >= 0, 'embed-record.ts declares no embedOwed: re-anchor this gate');
    const owed = src.slice(at, src.indexOf('\n}\n', at));
    const unchangedAt = owed.indexOf("outcome: 'unchanged'");
    assert.ok(unchangedAt > 0, 'embedOwed never answers unchanged');
    for (const condition of [/!i\.vectorPresent\)/, /textIsStale\(\{ matchedText: i\.matchedText \}, i\.text\)/, /i\.embeddingModel !== i\.configuredModel\(\)/]) {
      const found = owed.match(condition);
      assert.ok(found && found.index < unchangedAt,
        `${condition} is not asked before unchanged: any one of the three alone would make this a guess rather than an identity`);
    }
    // `matchedText` is written by the embed itself, so no new field and no migration of synced data.
    assert.match(src, /matchedText: toEmbed/, 'the fingerprint must keep being written');
  });
});
