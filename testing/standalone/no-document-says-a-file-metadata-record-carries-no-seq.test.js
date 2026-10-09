/**
 * Nothing in the repository says a file's METADATA RECORD carries no `seq` — it does (bundle-89, E1 / Q-424).
 *
 * ## The claim, and why it is stale
 *
 * A file-metadata row is stamped with the space seq on every authored write (`upsertFileMeta`, `updateFileMeta`,
 * `setDerivedDescriptionIfUnset`: `P-32`), it pages to peers by that seq, and the merkle hash covers it. Four places still
 * said the opposite, each written before `P-32` and each believed by whoever read it:
 *
 *   - `docs/integration-guide/04f-write-semantics.md` (the integrator's reference: "they carry no `seq` to condition a write on")
 *   - `server/src/api/brain/file-meta.ts`, twice: a comment, and the TEXT OF A USER-FACING 400
 *   - `server/src/files/file-meta.ts` (a comment in `updateFileMeta`)
 *   - `testing/integration/brain-if-match.test.js` (a test title; the plan listed three and this is the fourth file)
 *
 * ## What this gate must NOT match, and it is the half that makes it a gate
 *
 * `sync/file-sync.ts` ("a file has no `seq`, so a differing hash cannot be resolved by last-writer-wins") and
 * `sync/file-conflict.ts` say the same words about the BYTES, which genuinely have no version. They are TRUE as written;
 * "correcting" them would introduce a falsehood. So the claim is matched by its SUBJECT: a sentence naming file metadata
 * (or a file-meta record) that says it carries or has no seq. A gate that matched the words "no seq" would delete the true
 * ones with the stale ones, and a gate that only asserted absence could not tell "all clean" from "looked in the wrong place":
 * the self-test below reads the real true claims and asserts they exist and are not matched.
 *
 * ## What it reads
 *
 * Raw text, comments included, because two of the stale claims ARE comments. History is exempt: `changelog/` and
 * `CHANGELOG.md` record what was true when each entry was written. The gate's own file is exempt, as it quotes the claim.
 *
 * ## Wording the fix needs
 *
 * The 400 on `PATCH /api/brain/spaces/:spaceId/files` keeps refusing `If-Match`; only its stated reason changes. It must keep
 * the opening "`If-Match` is not supported on file metadata" (the prefix `brain-if-match.test.js` pins, so that pin does not
 * move), and its reason must not be that the records carry no `seq`.
 *
 * Run: node --test testing/standalone/no-document-says-a-file-metadata-record-carries-no-seq.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';

const SELF = 'testing/standalone/no-document-says-a-file-metadata-record-carries-no-seq.test.js';

/**
 * A fresh matcher per use (a shared global regex under-scans). A sentence (no full stop between) that names file metadata
 * and then says it carries or has no seq. `file-meta`, `file metadata`, `file-metadata` and `filemeta` all name it.
 */
// The window between the subject and the claim is bounded by the SENTENCE — `[^.]` cannot cross a full stop — so
// there is no character count to guess at. It carried a capped gap of a hundred-odd characters, which was a guess at
// how long such a sentence is and would have missed a longer one in silence.
const staleClaim = () => /\bfile[- ]?meta(?:data)?\b[^.]*?\b(?:carr(?:y|ies)|ha(?:s|ve))\s+no\s+`?seq\b/gi;

/** Every "has/carries no seq", whatever its subject: the population the claim is picked out of. */
const anyNoSeq = () => /\b(?:carr(?:y|ies)|ha(?:s|ve))\s+no\s+`?seq\b/gi;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every stale claim in the tracked text of the repository, as `file:line`. */
function staleClaims() {
  const found = [];
  for (const { file, text } of readTrackedSources(['.'], { ext: ['.ts', '.md', '.js', '.mjs', '.html', '.yml'], floor: 500 })) {
    if (file === SELF || file === 'CHANGELOG.md' || file.startsWith('changelog/')) continue;
    for (const m of text.matchAll(staleClaim())) found.push(`${file}:${lineOf(text, m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  return found;
}

describe('no document says a file-metadata record carries no seq', () => {
  it('the matcher picks the claim out by its subject: the stale phrasings match, the true ones do not', () => {
    for (const stale of [
      'File-metadata records are not covered, and say so: they carry no `seq` to condition a write on',
      '// File-metadata records have no `seq` that a precondition can be checked against',
      "error: '`If-Match` is not supported on file metadata: these records carry no `seq` to condition a write on.'",
      '// was nothing to notice it with: file-meta records carry no `seq`, so there is no precondition',
      "it('file metadata refuses it, because those records carry no seq', async () => {",
    ]) assert.match(stale, staleClaim(), `a stale phrasing is not matched: ${stale}`);
    for (const fine of [
      'a file has no `seq`, so a differing hash cannot be resolved by last-writer-wins the way records are',
      'File tombstones carry no `seq`, so their retention floor is built from acknowledgement',
      'a copy that has no seq (file metadata from before 4.0) beats nothing held',
      'file bytes carry no `seq` or version',
    ]) assert.doesNotMatch(fine, staleClaim(), `a true statement is matched: ${fine}`);
  });

  it('the true claims about the bytes exist in the repository, and the matcher leaves every one of them alone', () => {
    // Derived from the files themselves, so a reworded sentence fails here ("re-anchor") instead of making the check vacuous.
    const BLOB_CLAIMS = ['server/src/sync/file-sync.ts', 'server/src/sync/file-conflict.ts'];
    const sources = new Map(readTrackedSources(['server/src/sync'], { ext: ['.ts'], floor: 20 }).map(s => [s.file, s.text]));
    for (const file of BLOB_CLAIMS) {
      const text = sources.get(file);
      assert.ok(text, `${file} is not tracked: re-anchor this check`);
      const claims = [...text.matchAll(anyNoSeq())];
      assert.ok(claims.length >= 1, `${file} no longer says a file has no seq: re-anchor this check, the true claim it protects has moved`);
      assert.deepEqual([...text.matchAll(staleClaim())].map(m => m[0]), [],
        `${file} states a TRUE claim about a file's bytes and the stale-claim matcher reads it as a claim about the metadata record`);
    }
  });

  it('the scan reads the repository, so an empty set cannot pass', () => {
    const files = readTrackedSources(['.'], { ext: ['.ts', '.md', '.js', '.mjs', '.html', '.yml'], floor: 500 });
    assert.ok(files.some(f => f.file === 'docs/integration-guide/04f-write-semantics.md'), 'the integration guide is not in the scan');
    assert.ok(files.some(f => f.file === 'server/src/files/file-meta.ts'), 'the server source is not in the scan');
    assert.ok(files.some(f => f.file === 'testing/integration/brain-if-match.test.js'), 'the integration tests are not in the scan');
  });

  it('no tracked file says a file-metadata record carries no seq', () => {
    assert.deepEqual(staleClaims(), [],
      'these say file metadata carries no `seq`; it is stamped on every authored write (P-32). Correct the claim; the 400\'s opening '
      + '"`If-Match` is not supported on file metadata" stays, because brain-if-match.test.js pins that prefix.');
  });
});
