/**
 * Every path that writes one of the six link arrays also reconciles the link records.
 *
 * ## Why a source gate and not only the behaviour test beside it
 *
 * `a-link-record-follows-the-array-that-made-it-db.test.js` exercises the three WRITER functions against a
 * real database, which is the right way to prove the reconcile works. It cannot prove that a *new* write
 * path calls it — and four of the paths that write these arrays deliberately bypass all three writers by
 * replacing the whole document.
 *
 * **Those four are the ones that would be forgotten**, and each fails silently rather than loudly:
 *
 *   - `api/sync/_shared.ts` — a record PUSHED by a peer. The sender may be on a build with no links at all.
 *   - `sync/engine.ts` — a record PULLED from a peer. A separate `bulkWrite`, so the hook exists twice, and
 *     this is the copy nobody thinks about because push is the one people picture.
 *   - `api/admin-import.ts` — reaches the same ingest function, which is why one hook covers both.
 *   - `files/file-meta.ts`'s rename pair — deletes and re-inserts under a NEW `_id`. A file's id IS its
 *     path, so a rename moves the identity every `file.*` link hangs off, and the three arrays ride across
 *     by object spread: **their field names never appear in that function at all.**
 *
 * The last one is why this gate matches on the reconcile CALL rather than on the array field names. A sweep
 * for `entityIds` would report the rename path as clean, in both the dotted and the bracketed spelling,
 * because the code that carries the arrays never names them.
 *
 * ## A link ROW has exactly two writers, and the second is the other half of the rule
 *
 * `reconcileLinks` writes a link this instance DERIVED from an array. `ingestBrainDoc` writes a link a PEER
 * sent, verbatim — its id was derived by the sender, and re-deriving it here would be a second opinion about
 * a settled value. That function is the ingest router's only write door by design, which is what keeps the
 * count at two.
 *
 * **The first version of this check got that wrong**, asserting only `brain/links.ts` may NAME a links
 * collection. It caught four sites: three that legitimately name it without writing a row — the collection's
 * own creation and indexes, the space wipe, the page served to a peer — and one that is the second writer.
 * A rule stated as "one writer" would have been tightened around the truth rather than describing it.
 *
 * A third writer would not fail. It would produce rows whose id is not derived — breaking the idempotence
 * the conversion script depends on — and no tombstone on removal, so a delete would undo itself on the next
 * pull from any peer that still held the row.
 *
 * Run: node --test testing/standalone/every-array-writer-reconciles-its-links.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();
const code = (f) => stripComments(readFileSync(f, 'utf8'));

/** The one module allowed to write a links collection. */
const OWNER = 'server/src/brain/links.ts';

/**
 * Every path that writes one of the six arrays, and what makes each one a path.
 *
 * Named individually rather than swept, because "writes an array" is not greppable: the rename pair carries
 * them by spread and `updateChrono` writes them through a computed key. A derived list would miss exactly
 * the two that matter.
 */
const WRITERS = {
  'server/src/brain/fact.ts': 'saveFact(both branches), updateFact, and deleteFact\'s cascade',
  'server/src/brain/chrono.ts': 'createChrono (both branches), updateChrono, and deleteChrono\'s cascade',
  'server/src/files/file-meta.ts': 'updateFileMeta — the only writer of a file\'s three arrays — and rename',
  'server/src/api/sync/_shared.ts': 'ingestBrainDoc: a record PUSHED by a peer, and the admin importer',
  'server/src/sync/engine.ts': 'the PULL applier, which does not go through ingestBrainDoc',
};

function sourceFiles() {
  return trackedSources('server/src');
}

describe('every array writer reconciles its links', () => {
  it('the owner module exports what the writers call', () => {
    // Floors the sweep below: if these were renamed, every `reconcileLinks(` match would be a match on a
    // function that no longer exists and the gate would pass on nothing.
    const src = code(OWNER);
    assert.match(src, /export async function reconcileLinks\(/, 'reconcileLinks');
    assert.match(src, /export async function removeLinksFrom\(/, 'removeLinksFrom');
    assert.match(src, /export const linkIdFor/, 'linkIdFor — the derived id the script also needs');
  });

  /**
   * Any entry point into the links module.
   *
   * Four names and not one, because the whole-document paths call a wrapper rather than `reconcileLinks`
   * itself — and this gate broke the moment that wrapper was extracted, which is the right failure to have
   * had: a check naming ONE function is checking a spelling, not a rule. The rule is that a writer reaches
   * this module at all.
   */
  const LINKS_CALL = /\b(reconcileLinks|reconcileLinksForDocument|reconcileLinksForPage|removeLinksFrom)\(/;

  it('each of the five writing modules calls it', () => {
    for (const [f, why] of Object.entries(WRITERS)) {
      assert.match(code(f), LINKS_CALL, `${f} writes one of the six arrays and never reconciles — ${why}`);
    }
  });

  it('BOTH sync directions do, not just the one people picture', () => {
    // Asserted apart from the loop above because they are one rule with two implementations, which is the
    // shape this codebase gets wrong most. Push lands in the ingest router; pull lands in the engine.
    assert.match(code('server/src/api/sync/_shared.ts'), LINKS_CALL, 'the PUSH ingest path');
    assert.match(code('server/src/sync/engine.ts'), LINKS_CALL, 'the PULL applier');
  });

  it('the RENAME path reconciles, and it is matched on the call because the fields are invisible there', () => {
    /*
     * `renameFileMeta` spreads the existing document into a new `_id`, so `entityIds`, `memoryIds` and
     * `chronoIds` never appear in it. A field-name sweep reports it clean — in both spellings — while every
     * link it holds still names a path that no longer exists.
     */
    const src = code('server/src/files/file-meta.ts');
    const at = src.indexOf('export async function renameFileMeta');
    assert.ok(at > 0, 'renameFileMeta not found — re-anchor');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.match(body, /removeLinksFrom\(/, 'the links must leave the old path');
    assert.match(body, /reconcileLinks\(/, 'and be created under the new one');
  });

  it('a link ROW is written by exactly two things, and every other mention is a read or the collection itself', () => {
    /*
     * The rule, stated correctly on the second attempt. The first version of this case asserted that only
     * `brain/links.ts` may NAME a links collection, and it caught three sites that are all legitimate — plus
     * one that is a second writer and has to be.
     *
     * **Two writers, and the second is not an exception to the rule but the other half of it:**
     *
     *   - `reconcileLinks` writes a link this instance DERIVED from an array, with an id from `edgeIdFor`
     *     and a tombstone when it goes.
     *   - `ingestBrainDoc` writes a link a PEER sent, verbatim. Its id was derived by the sender, and
     *     re-deriving it here would be a second opinion about a value that is already settled. That
     *     function is the ingest router's only write door by design, which is what keeps this at two.
     *
     * Everything else may name the collection and must not write a row into it. Each is listed with its
     * reason, so an exemption cannot be silent — the same derive-or-declare shape the collection-list gate
     * uses.
     */
    const WRITE = /\.(insertOne|insertMany|replaceOne|updateOne|updateMany|bulkWrite|findOneAndUpdate)\(/;
    const ALLOWED_TO_WRITE = {
      'server/src/brain/links.ts': 'derives and reconciles — the local half',
      'server/src/api/sync/_shared.ts': 'ingestBrainDoc: a link a peer sent, id already derived by the sender',
    };
    const MAY_NAME_NOT_WRITE = {
      'server/src/api/sync/docs.ts': 'reads the stored seq to compare against an arriving link, then writes through ingestBrainDoc',
      'server/src/spaces/lifecycle.ts': 'CREATES the collection and its indexes, and clears it on a space wipe — whole-collection, never a row',
      'server/src/sync/engine.ts': 'pages the collection to a peer, and reconciles PULLED records; it writes rows only through reconcileLinks',
      'server/src/brain/links-conversion.ts': 'COUNTS the rows on one record before and after, to report what a conversion added; it creates them only through reconcileLinksForDocument',
      'server/src/brain/link-adjacency.ts': 'READS the collection for every adjacency question in the server — `linkedFromIds` and `linkedToPairs` are the two indexed lookups the five readers share, and neither writes',
    };

    // The floor, and `gates-cannot-pass-vacuously.test.js` is what asked for it — correctly. Everything
    // below asserts an EMPTY offender list over a run-time walk, so a walk that returned nothing would
    // report clean about a rule it never checked.
    const files = sourceFiles();
    assert.ok(files.length > 200, `only walked ${files.length} source files — the enumeration is broken`);

    const offenders = [];
    for (const f of files) {
      if (f in ALLOWED_TO_WRITE) continue;
      const src = code(f);
      if (!/_links`/.test(src)) continue;
      if (f in MAY_NAME_NOT_WRITE) {
        // Named ones still may not gain a row write. This is the half that would rot: a file already on the
        // list is the easiest place to add one, because the collection name is already there.
        for (const line of src.split(/\r?\n/)) {
          if (/_links`/.test(line) && WRITE.test(line)) offenders.push(`${f} — writes a row: ${line.trim().slice(0, 70)}`);
        }
        continue;
      }
      offenders.push(`${f} — names a links collection and is on neither list`);
    }
    assert.deepEqual(offenders, [],
      `${offenders.length} site(s) touch a links collection outside the rule:\n  `
      + offenders.join('\n  ')
      + '\n\n  Route a locally-derived link through `reconcileLinks`. A row written any other way has an id'
      + '\n  that is not derived and leaves no tombstone when it goes — so a delete undoes itself on the'
      + '\n  next pull from any peer that still holds it.');
  });
});
