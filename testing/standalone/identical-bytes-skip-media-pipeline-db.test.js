/**
 * Re-uploading identical bytes does not re-run vision or speech-to-text over them.
 *
 * ## The waste
 *
 * `enqueueMediaJob` resets a terminal job on purpose — its own comment says "reset so re-upload triggers
 * re-processing" — because until now the pipeline had no way to tell a corrected file from the same file sent
 * twice. Every re-upload therefore paid for a full vision or speech-to-text pass, which is the single most
 * expensive thing this instance does, to reproduce a caption it already had.
 *
 * ## Why this is lossless rather than a heuristic
 *
 * The guard is an identity, not a guess: the same bytes (SHA-256, computed by the writer that just wrote them)
 * through the same pipeline produce the same analysis. It fires only on the conjunction of three conditions, and
 * every one of them is asserted separately below, because each alone would make it a guess:
 *
 *   - the CALLER supplied a hash — an unknown hash processes rather than assumes;
 *   - the STORED hash matches it;
 *   - the stored `embeddingStatus` is `complete` — anything else (failed, partial, pending, skipped) is retried.
 *
 * The wrong direction here is invisible in a way the right one is not: a file silently never embedded is
 * discovered only when someone searches for it and it is not there. So every uncertain case processes.
 *
 * Run: node --test testing/standalone/identical-bytes-skip-media-pipeline-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = `mediaskip${Date.now()}`;
const FILE = 'clip.png';
const HASH = 'a'.repeat(64);

let mongo;
let dispatchFileProcessing;

before(async () => {
  if (skip) return;
  mongo = await openTestMongo('mediaskip');
  ({ dispatchFileProcessing } = await import('../../server/dist/files/dispatch.js'));
});

after(async () => {
  if (skip) return;
  await mongo.col(`${SPACE}_files`).drop().catch(() => {});
  await closeTestMongo(mongo);
});

/**
 * "It did not skip" is proven by "it went on to the pipeline".
 *
 * The guard sits immediately above `getMediaEmbeddingConfig()`, and this is a database harness with no config
 * loaded — so falling through raises a recognisable error. That failure IS the evidence. Matching the message
 * rather than merely catching means an unrelated fault cannot pass as proof.
 */
async function ranThePipeline(input) {
  try {
    const result = await dispatchFileProcessing(SPACE, FILE, input);
    return { processed: false, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /Config not loaded/,
      `expected the media pipeline to be reached and fail on the absent config, got: ${msg}`);
    return { processed: true, result: null };
  }
}

/** A file metadata record as an upload leaves one. */
async function seed(over = {}) {
  const c = mongo.col(`${SPACE}_files`);
  await c.deleteOne({ _id: FILE }).catch(() => {});
  await c.insertOne({
    _id: FILE, spaceId: SPACE, path: FILE, sizeBytes: 1024, mediaType: 'image',
    sha256: HASH, embeddingStatus: 'complete', createdAt: new Date().toISOString(),
    ...over,
  });
  return c;
}

describe('the media pipeline is skipped only when re-running it could not change anything', { skip }, () => {
  it('same hash, already complete -> skipped, and the record is left alone', async () => {
    const c = await seed();
    const before = await c.findOne({ _id: FILE });

    const { processed, result } = await ranThePipeline({ bytes: 1024, sha256: HASH });
    assert.equal(processed, false, 'identical bytes that already embedded must not be analysed again');
    assert.equal(result.embeddingStatus, 'complete',
      'the caller is told the truth about the file, not a status describing work that did not happen');

    // Nothing was reset — the point of the change is that the completed job SURVIVES the re-upload.
    assert.deepEqual(await c.findOne({ _id: FILE }), before);
  });

  it('a DIFFERENT hash re-processes', async () => {
    await seed();
    const { processed } = await ranThePipeline({ bytes: 1024, sha256: 'b'.repeat(64) });
    assert.equal(processed, true, 'new bytes are a new file — skipping would leave the old caption in place');
  });

  it('NO caller hash re-processes, even against a stored hash', async () => {
  // set-claim: the NON-terminal media statuses -- everything except `complete`, which is the one that may
  // skip. A partition stated by its larger half, not a copy of the status list.
    // A writer that does not compute one is the pre-upgrade case, and every record written before this
    // shipped. Unknown must mean "process it".
    await seed();
    const { processed } = await ranThePipeline({ bytes: 1024 });
    assert.equal(processed, true, 'an unknown hash must process rather than assume');
  });

  for (const status of ['failed', 'partial', 'pending', 'skipped', 'processing']) {
    it(`same hash but status "${status}" re-processes`, async () => {
      // These are exactly the states a retry exists for. Skipping here would make a failed analysis
      // permanent and a re-upload — the obvious human fix — do nothing at all.
      await seed({ embeddingStatus: status });
      const { processed } = await ranThePipeline({ bytes: 1024, sha256: HASH });
      assert.equal(processed, true, `"${status}" is not a finished analysis`);
    });
  }

  it('NO stored hash re-processes', async () => {
    // Every media record that exists today. The field is optional and self-healing precisely so this case
    // behaves like it always did.
    await seed({ sha256: undefined });
    const { processed } = await ranThePipeline({ bytes: 1024, sha256: HASH });
    assert.equal(processed, true, 'a record that never stored a hash cannot claim identity');
  });
});

describe('the writers supply the hash, or the guard is dead code', () => {
  it('every upload path passes sha256 to both the meta write and the dispatch', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

    // The guard can only ever fire if the three writers that compute a hash also hand it over. Each of these
    // computed one already — for the response body and the webhook — and threw it away.
    /*
     * The UPLOAD route's file, which stopped being `api/files.ts` when G-4 moved it to `files-upload.ts`. Read
     * from where the writers are rather than from where they used to be: pointed at the old file these four
     * assertions would all fail at once, which reads as four broken writers instead of one moved module.
     */
    //
    // The sequence now lives ONCE, in `files/store-file.ts`, and every door goes through it — so the hand-over
    // is asserted there, and each door is asserted to have no private copy of the sequence to forget it in.
    const store = strip(readFileSync('server/src/files/store-file.ts', 'utf8'));
    assert.match(store, /upsertFileMeta\(spaceId, filePath, sizeBytes, \{.*, sha256 \}\)/,
      'the shared sequence must store the hash it was handed');
    assert.match(store, /dispatchFileProcessing\(spaceId, filePath, \{[^}]*sha256,/,
      'the shared sequence must pass the hash to the dispatcher');
    assert.match(store, /const \{ sha256 \} = await writeFileBytes\(/, 'storeFile must use the hash of the bytes it wrote');

    const doors = {
      'server/src/api/files-upload.ts': /recordStoredFile\(\s*targetSpace, filePath, range\.total, sha256,/,
      'server/src/mcp/tools/file.ts': null,
    };
    for (const [file, chunked] of Object.entries(doors)) {
      const src = strip(readFileSync(file, 'utf8'));
      assert.doesNotMatch(src, /\b(upsertFileMeta|dispatchFileProcessing)\(/,
        `${file} writes metadata or dispatches itself — a private copy of the sequence is where the hash gets dropped`);
      assert.match(src, /\bstoreFile\(/, `${file} must store through files/store-file.ts`);
      if (chunked) assert.match(src, chunked, 'chunked assembly must hand over the hash it computed');
    }
  });

  it('the stored hash is never erased by a writer that does not have one', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    const meta = strip(readFileSync('server/src/files/file-meta.ts', 'utf8'));
    // An unconditional `$set` would turn "unknown" into a permanent state — a `PATCH` of a description would
    // silently disarm the skip for that file for ever.
    assert.match(meta, /if \(opts\.sha256 !== undefined\) \$set\['sha256'\] = opts\.sha256;/,
      'the hash is written only when the caller states one');
  });

  it('the guard is a conjunction, in source', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    const src = strip(readFileSync('server/src/files/dispatch.ts', 'utf8'));
    assert.match(src, /prior\?\.sha256 === input\.sha256 && prior\?\.embeddingStatus === 'complete'/,
      'either condition alone would skip work that still needs doing');
    // And it must sit above the enqueue it is meant to prevent, not after it. Anchored on the CALL: the
    // import of the same name is at the top of the file and would make this pass no matter where the guard is.
    const guardAt = src.indexOf('prior?.sha256 === input.sha256');
    const enqueueAt = src.indexOf('await enqueueMediaJob(');
    assert.ok(enqueueAt > 0, 'the enqueue call moved or was renamed — this ordering check now proves nothing');
    assert.ok(guardAt > 0 && guardAt < enqueueAt, 'a guard after the enqueue prevents nothing');
  });
});
