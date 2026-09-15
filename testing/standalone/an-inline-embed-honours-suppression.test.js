/**
 * A vector computed inline must consult `suppressEmbeddings` — the queue is the last chance, not the only one.
 *
 * ## The defect
 *
 * `suppressEmbeddings` is implemented **as the absence of a vector**: there is no read-time filter, so a
 * stored vector is not an inconsistency, it is the feature not working.
 *
 * `embedStoredRecord` consulted the flag and carried a comment saying it was *"the single place the flag has
 * any effect. Every writer of a vector reaches this function."* That was false. The four creators compute the
 * vector INLINE when a caller passes `waitForEmbedding`, `checkDuplicates` or `checkContradictions`, and then
 * skip the enqueue precisely because they already have one — so the only path that honoured suppression was
 * the one they had just bypassed. The vector was stored and nothing ever came back to remove it.
 *
 * **It was the default write, not an edge case.** `checkDuplicates` defaults to `true` on the MCP tools, so an
 * ordinary `remember` or `save_entity` into a suppressed space stored a vector every time, and the
 * operator's setting did nothing they could observe.
 *
 * ## What this gate does NOT assume
 *
 * Not a list of four filenames. Every site that STORES a vector under `server/src/brain` is found from
 * source — which is how a FIFTH site in `merge.ts` and FIVE more in `reindex.ts` turned up, none of which the
 * four-creator framing would have reached. A list is what let those drift from `embedStoredRecord`'s claim
 * in the first place.
 *
 * Run: node --test testing/standalone/an-inline-embed-honours-suppression.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, bodyOf, statementAround } from './_structural-window.mjs';

const { embeddingSuppressed } = await import('../../server/dist/brain/suppress-embeddings.js');

/** Brain sources, tracked AND untracked-but-not-ignored — a new creator must not be exempt on its own commit. */
function brainFiles() {
  const arg = 'server/src/brain/*.ts';
  const tracked = execFileSync('git', ['ls-files', arg], { encoding: 'utf8' });
  const fresh = execFileSync('git', ['ls-files', '--others', '--exclude-standard', arg], { encoding: 'utf8' });
  return [...new Set(`${tracked}\n${fresh}`.split(/\r?\n/))].filter(Boolean).map(p => p.replace(/\\/g, '/'));
}

/**
 * Every site that STORES a vector on a record.
 *
 * ## Storing, not embedding
 *
 * The first version scanned `await embed(` and was wrong in both directions: it caught `recall.ts` embedding
 * the QUERY — which has no record and no suppression to honour — while the thing that actually matters is
 * where a vector is written to a document. Scanning the STORE instead is exact, and it is what surfaced a
 * fifth site in `merge.ts` that the four-creator framing would never have reached.
 *
 * `embed-record.ts` is excluded because it IS the queue path: it consults suppression at the top of the
 * function and returns before storing, so the per-file count below does not describe it. It has its own
 * assertion instead.
 */
function vectorStores() {
  const out = [];
  for (const file of brainFiles()) {
    if (file.endsWith('/embed-record.ts')) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/embedding:\s*\w+\.vector\b/g)) {
      out.push({ file, at: m.index });
    }
  }
  return out;
}

describe('the three-tier resolution has exactly one implementation', () => {
  it('resolves record > schema > space, with absent falling through', () => {
    // Exercised as a function, because the ORDER is the whole rule and a source read cannot check it. Absent
    // must fall through rather than read as `false` — otherwise the space-wide switch does nothing for any
    // type that has a schema at all, which is every type worth suppressing.
    assert.equal(embeddingSuppressed({ record: false, schema: { suppressEmbeddings: true }, space: true }), false,
      'the record flag is the top tier and must win, even saying NO over two yeses');
    assert.equal(embeddingSuppressed({ schema: { suppressEmbeddings: false }, space: true }), false,
      'a schema saying no must beat the space saying yes');
    assert.equal(embeddingSuppressed({ space: true }), true, 'nothing stated above it — the space decides');
    assert.equal(embeddingSuppressed({}), false, 'nothing stated anywhere means embed');
  });

  it('nothing re-implements it — the resolver has exactly one caller', () => {
    /*
     * The defect this gate is about was one rule with two paths, where the second simply did not run the
     * check. A second COPY of the resolution would be the other half of the same failure, and it would look
     * completely reasonable in review: three lines of `??` in a creator.
     *
     * Asserted on the RESOLVER's call sites rather than by pattern-matching a fallback chain. A pattern
     * flagged `chrono.ts` and `edges.ts`, whose `??` chain was the legacy-spelling mirror and not this
     * rule at all — a gate that fires on correct code twice is one that gets deleted. That mirror went
     * with `D-6` in 4.0, so the example is history; the reason to assert on call sites is not, because
     * any `??` fallback near a suppression read will look like this one to a pattern.
     */
    const callers = brainFiles().filter(f =>
      !f.endsWith('/suppress-embeddings.ts')
      && /\bembeddingSuppressed\s*\(/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(
      callers, ['server/src/brain/reembed.ts'],
      'the record > schema > space order must exist in one place — `embeddingSuppressedFor`, in the module '
      + 'that owns the resolver. The re-embed sweep is the one other caller, resolving against a stored '
      + 'document for its own documented reasons. Anything else is a third copy of the order.',
    );
  });
});

describe('every inline embed honours suppression', () => {
  it('finds the vector stores, so an empty sweep cannot pass', () => {
    const found = vectorStores();
    assert.ok(
      found.length >= 5,
      `expected the four creators plus the merge survivor, found ${found.length}. The scan has broken, so `
      + 'nothing below is being checked.',
    );
  });

  it('every store is matched by a suppression check in the same file', () => {
    /*
     * COUNTED PER FILE, not resolved per site — and that is a deliberate retreat to a claim this can actually
     * make truthfully.
     *
     * The first version walked out to each store's enclosing `if` and read its condition. That models exactly
     * one of the five shapes. `entities.ts` guards on a `needsVectorNow` const that is itself computed from a
     * `suppressed` const (two hops); `memory.ts` stores through a ternary with no enclosing `if` at all; and
     * `reindex.ts` guards with an early `continue` BEFORE the store rather than a block around it. Following
     * conditions far enough to cover all four would be dataflow analysis, and a regex pretending to do it is
     * how a gate ends up confidently wrong.
     *
     * Counting is honest and still catches the defect that happened: `reindex.ts` had five stores and zero
     * checks, and a sixth store added to any of these files without its own check fails here.
     */
    const unguarded = [];
    for (const file of new Set(vectorStores().map(e => e.file))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const stores = (src.match(/embedding:\s*\w+\.vector\b/g) ?? []).length;
      const checks = (src.match(/embeddingSuppressedFor\(/g) ?? []).length;
      if (checks < stores) unguarded.push(`${file}: ${stores} vector store(s), ${checks} suppression check(s)`);
    }
    assert.deepEqual(
      unguarded, [],
      'An inline `embed()` that does not consult suppression stores a vector the flag forbids — and because '
      + 'the caller then skips the enqueue, nothing ever removes it. `suppressEmbeddings` IS the absence of a '
      + 'vector; there is no read-time filter to fall back on.',
    );
  });

  it('the `suppressed` consts are computed from the shared helper, not hand-rolled', () => {
    // `!suppressed` in a guard is only as good as what produced it.
    for (const file of brainFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const at = src.indexOf('const suppressed =');
      if (at === -1) continue;
      assert.match(
        statementAround(src, at, `${file} suppressed const`), /embeddingSuppressedFor\(/,
        `${file} computes \`suppressed\` without the shared resolution`,
      );
      /*
       * AND IT MUST BE READ. The per-file count above sees a check exist; it cannot see whether anything
       * consults it — a mutant that changed `if (!suppressed)` to `if (true)` walked straight through, which
       * is a check computed and discarded, this repo's own recurring shape.
       *
       * Occurrences beyond the declaration itself, which is the same test the 5xx-evidence gate uses on a
       * caught error: computing a value and never reading it is indistinguishable from not computing it.
       */
      const uses = src.split(/\bsuppressed\b/).length - 1;
      assert.ok(
        uses >= 2,
        `${file} computes \`suppressed\` and never reads it — the vector is stored regardless`,
      );
    }
  });

  it('an edge asks by LABEL, because that is where its schema is keyed', () => {
    /*
     * The trap `suppress-embeddings.ts` already names: edges key their type schema on `label` while every
     * other record keys on `type`. Passing `{ type }` for an edge looks correct, finds a schema that is never
     * there, and silently never suppresses — on the one record kind the flag was specifically widened to
     * cover. `schemaKeyFor` encodes it, but only if the caller hands over the right field.
     */
    const edges = stripComments(readFileSync('server/src/brain/edges.ts', 'utf8'));
    const at = edges.indexOf('embeddingSuppressedFor(');
    assert.notEqual(at, -1, 'edges.ts no longer consults suppression — re-point this gate');
    // The CALL's own arguments, not the statement around it: the statement continues into
    // `edgeEmbedText(… effectiveType …)`, so a `type` check over that window would read a word belonging to a
    // different call — the same mistake `merge-runs-the-write-paths-validators` records making.
    const args = argumentsOf(edges, at + 'embeddingSuppressedFor'.length, 'the edge suppression check').join(' ');
    // `label` PRESENT rather than the whole object matched: that object now also carries the record tier
    // (`suppressEmbeddings`), which a create could not state until 2026-09-02. An exact-shape match failed on
    // that addition while the property this case exists for — keyed by label, not type — was untouched.
    assert.match(args, /\blabel\b/, 'the edge must be identified by `label`');
    assert.doesNotMatch(args, /\btype\b/, 'passing `type` for an edge finds no schema and never suppresses');
    assert.match(args, /suppressEmbeddings/,
      'the RECORD tier is not stated, so a caller\'s own flag has nowhere to be read from and the type '
      + 'schema answers instead — silently, which is how it went unnoticed on all four creates');
  });

  it('the queue path still checks too — it is the last chance, not a replacement', () => {
    // Removing the check there because the creators now have one would leave sync ingest and every re-embed
    // unguarded, and would break the cleanup of a suppression toggled ON after records already exist.
    const rec = stripComments(readFileSync('server/src/brain/embed-record.ts', 'utf8'));
    const body = bodyOf(rec, 'embedStoredRecord');
    assert.match(body, /embeddingSuppressedFor\(/, 'the queue path must keep its own check');
    assert.match(
      body, /\$unset:\s*\{\s*embedding/,
      'and must UNSET a stale vector rather than only skipping — that is what cleans up a record embedded '
      + 'before the flag was set',
    );
  });
});
