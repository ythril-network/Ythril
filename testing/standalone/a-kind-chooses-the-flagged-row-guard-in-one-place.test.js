/**
 * Whether a read must skip soft-deleted file records is decided from the record's kind in ONE function,
 * `notFlaggedIfFile` (`files/live-file-row.ts`) — never by a conditional written at the read (bundle-89 pre-ship pass,
 * architecture lens).
 *
 * ## What it prevents
 *
 * The question "this read may be of a file record — does it carry `NOT_A_FLAGGED_ROW`?" was answered by a ternary
 * written out at ten reads, keyed on four different names for the kind (`kind`, `recordType`, `entryType`,
 * `knowledgeType`) and two spellings of it (`'file'`, the collection suffix `'files'`). Each copy was right. The next
 * one is the one that tests `'files'` where the variable holds `'file'`, and the guard silently never applies: a
 * deleted file comes back as a result, a link target or a graph node, which is exactly what bundle-89 removed.
 *
 * ## The rule, derived rather than listed
 *
 * No tracked server source other than the module itself compares a kind with `'file'` or `'files'` to pick
 * `NOT_A_FLAGGED_ROW`. Found with
 * comments stripped, over `git ls-files`, with a floor on the number of files that use the predicate at all, and the
 * function itself is checked against both spellings and against a kind that is not a file.
 *
 * Run: node --test testing/standalone/a-kind-chooses-the-flagged-row-guard-in-one-place.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/files/live-file-row.ts';

describe('a kind chooses the flagged-row guard in one place', () => {
  const users = trackedSources('server/src')
    .filter(f => f !== MODULE)
    .map(f => ({ f, src: stripComments(readFileSync(f, 'utf8')) }))
    .filter(x => /\bNOT_A_FLAGGED_ROW\b|\bnotFlaggedIfFile\b/.test(x.src));

  it('finds the reads it is about (floor)', () => {
    assert.ok(users.length >= 10, `only ${users.length} files use the flagged-row guard — re-anchor`);
  });

  it('no read picks NOT_A_FLAGGED_ROW in a conditional of its own', () => {
    const inline = users.flatMap(({ f, src }) =>
      // A comparison against the file kind, by either spelling, choosing the guard. (`tier === 'top-level' ?` in
      // `derived-fields.ts` is a different question — which ROW a write is about — and is not this one.)
      [...src.matchAll(/===\s*['"]files?['"]\s*\?\s*\{?\s*(?:\.\.\.)?\s*NOT_A_FLAGGED_ROW\b/g)].map(m => `${f}: ${src.slice(Math.max(0, src.lastIndexOf('\n', m.index) + 1), src.indexOf('\n', m.index)).trim()}`));
    assert.deepEqual(inline, [], `${inline.length} read(s) decide the guard themselves — use notFlaggedIfFile(kind)`);
  });

  it('notFlaggedIfFile answers the guard for a file by either spelling, and nothing for any other kind', async () => {
    const { notFlaggedIfFile, NOT_A_FLAGGED_ROW } = await import('../../server/dist/files/live-file-row.js');
    assert.equal(notFlaggedIfFile('file'), NOT_A_FLAGGED_ROW);
    assert.equal(notFlaggedIfFile('files'), NOT_A_FLAGGED_ROW);
    for (const k of ['fact', 'facts', 'entity', 'edges', 'chrono', 'links', undefined]) {
      assert.equal(notFlaggedIfFile(k), undefined, `${k} is not a file, so no guard`);
    }
  });
});
