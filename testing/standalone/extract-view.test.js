/**
 * The Extract endpoint answers "what did the pipeline get out of this file?" (B.6).
 *
 * ## Why it exists
 *
 * `_converted/` and `_extracted/` are hidden from browsing — the docs promised it and the reporter asked for
 * it. But that hidden folder was the only place to SEE what conversion produced, so the fix removed the only
 * answer to the first question anyone asks when a document answers queries badly. Their words: hide them
 * from browsing, not from inspection.
 *
 * ## What this pins
 *
 * The route's SHAPE and its bounds, which is what a source-level gate can honestly establish here: the
 * handler needs Mongo and a file store, and the tests that drive those live in the integration suite
 * (`@needs-instance`). What matters and is checkable offline:
 *
 *  - a chunk is identified by carrying a `chunkIndex`, not by its path — text chunks are `#chunk<n>` and
 *    audio chunks are `#media-chunk<n>`, two spellings of one thing, and a path-shape test would quietly
 *    cover only half the pipeline;
 *  - the derived records are partitioned, so an extracted image can never be listed as a chunk;
 *  - everything is bounded: chunks paginate, the Markdown is capped and says when it was cut, and the
 *    derived query has a ceiling. A diagnostic view over a 500-page document must not be the thing that
 *    takes the page down.
 *
 * Run: node --test testing/standalone/extract-view.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = 'server/src/api/brain/file-meta.ts';
const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const src = strip(readFileSync(SRC, 'utf8'));

/** The handler body, so an assertion cannot accidentally match a neighbouring route. */
const handler = (() => {
  const start = src.indexOf("fileMetaRouter.get('/spaces/:spaceId/files/extract'");
  assert.ok(start > 0, 'the extract route must exist');
  // Up to the next route registration, or the end of file.
  const next = src.indexOf('fileMetaRouter.', start + 10);
  return src.slice(start, next > 0 ? next : undefined);
})();

describe('the extract route', () => {
  it('is authenticated per space and rate limited, like its siblings', () => {
    assert.match(handler, /globalRateLimit/);
    assert.match(handler, /requireSpaceAuth/);
  });

  it('is a GET — it inspects, it never rewrites what conversion produced', () => {
    // Also why it needs no audit entry: the audit-coverage gate governs mutating verbs.
    assert.match(src, /fileMetaRouter\.get\('\/spaces\/:spaceId\/files\/extract'/);
  });

  it('requires a path and 404s a file it cannot find', () => {
    assert.match(handler, /`path` query parameter required/);
    assert.match(handler, /File metadata record not found/);
  });

  it('identifies a chunk by its chunkIndex, not by its path shape', () => {
    // `#chunk<n>` for text and `#media-chunk<n>` for audio: matching on the path would have covered one
    // pipeline and silently missed the other.
    assert.match(handler, /chunkIndex: \{ \$exists: true \}/);
    assert.match(handler, /sort\(\{ chunkIndex: 1 \}\)/);
  });

  it('partitions the derived records, so an image is never listed as a chunk', () => {
    assert.match(handler, /chunkIndex: \{ \$exists: false \}/);
    assert.match(handler, /startsWith\('_extracted\/'\)/);
    assert.match(handler, /startsWith\('_converted\/'\)/);
  });

  it('bounds every list it returns', () => {
    // A 500-page document has thousands of chunks and megabytes of Markdown. An unbounded diagnostic is
    // the thing that takes the page down while someone is trying to work out why recall is poor.
    assert.match(handler, /parseLimit\(req\.query\['limit'\]/);
    assert.match(handler, /parseSkip\(req\.query\['skip'\]\)/);
    assert.match(handler, /limit\(MAX_DERIVED_RECORDS\)/);
    assert.match(handler, /slice\(0, MAX_CONVERTED_BYTES\)/);
    assert.match(src, /const MAX_CONVERTED_BYTES = 256 \* 1024/);
  });

  it('says when the Markdown was cut rather than returning a silently short document', () => {
    assert.match(handler, /truncated: text\.length > MAX_CONVERTED_BYTES/);
  });

  it('returns the total so the client can tell one page from all of them', () => {
    assert.match(handler, /countDocuments/);
    assert.match(handler, /chunkTotal/);
  });

  it('resolves the member and KEEPS it', () => {
    // On a proxy space the derived records live in the same member collection as their parent. Looking
    // them up in another member's collection returns nothing, with no error — the failure mode that made
    // `pipeline-status` report every index missing on a working instance.
    // Q-6 narrowed this fan-out: the members are now the ones the CALLER may see, not every member of the proxy.
    // The property this test is about is unchanged — it iterates members and keeps the one it found the record in —
    // and pinning the narrowed form keeps it honest, since reverting to the unnarrowed call would fail here too.
    assert.match(handler, /for \(const mid of memberSpacesForRequest\(req, spaceId\)\)/);
    assert.match(handler, /member = mid/);
    assert.match(handler, /col<FileMetaDoc>\(spaceCollection\(member, 'files'\)\)/);
  });

  it('reports a missing sidecar as its own state, not as an empty document', () => {
    // A record whose bytes are gone is exactly the drift this view exists to make visible; swallowing it
    // into `markdown: ''` would hide it behind something that looks like an empty conversion.
    assert.match(handler, /could not read/);
  });

  it('carries the caption provenance through', () => {
    // The same claim the file detail pane makes: "generated" is a claim about who wrote the text.
    assert.match(handler, /descriptionSource: d\.descriptionSource \?\? null/);
  });
});
