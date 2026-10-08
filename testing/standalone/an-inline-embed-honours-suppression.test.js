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
 * ordinary `saveFact` or `save_entity` into a suppressed space stored a vector every time, and the
 * operator's setting did nothing they could observe.
 *
 * ## What this gate does NOT assume
 *
 * Not a list of four filenames. Every site that STORES a vector under `server/src` is found from
 * source — which is how a FIFTH site in `merge.ts` and FIVE more in `reindex.ts` turned up, none of which the
 * four-creator framing would have reached. A list is what let those drift from `embedStoredRecord`'s claim
 * in the first place.
 *
 * ## It read `server/src/brain` only, and four vector stores lived outside it (Q-255, bundle-48)
 *
 * The scan was scoped to `server/src/brain/*.ts`, so its title ("every inline embed honours suppression") was a
 * claim about a directory. A file's conversion chunks (`files/converters/pipeline.ts`) and its image, audio and video
 * chunks (`files/media/*-embedder.ts`) are vector stores in the same sense — each calls `embed()` and writes
 * `embedding: <result>.vector` onto a row — and none consulted suppression, so a file the operator had retired from
 * meaning-ranked search kept a vector on every one of its passages. The queue path only repaired that LATER, and
 * only for chunks it was asked to re-embed. The scan now covers every source under `server/src`; a file that
 * is exempt carries its reason in `EXEMPT`, never a bare skip.
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
import { suppressionResolvers, resolverCallPattern } from './_suppression-resolvers.mjs';
import { trackedSources } from './_sources.mjs';

const { embeddingSuppressed } = await import('../../server/dist/brain/suppress-embeddings.js');

/**
 * Every server source, tracked AND untracked-but-not-ignored, with comments stripped — read once.
 *
 * The question is "what does the server store a vector from", and it is asked of the whole tree: a scan scoped to one
 * directory concludes about that directory (Q-255). `trackedSources` carries the floor, so an empty listing throws
 * instead of passing every loop below.
 */
let serverSourceCache;
function serverSources() {
  if (!serverSourceCache) {
    serverSourceCache = new Map(trackedSources('server/src', { untracked: true, floor: 300 })
      .map(file => [file, stripComments(readFileSync(file, 'utf8'))]));
  }
  return serverSourceCache;
}

/**
 * Files that store a vector and are allowed not to consult suppression themselves, each with the reason.
 *
 * A bare skip is how a site stays outside a gate for ever, so an entry is a reason a reviewer can disagree with, and
 * `every exemption still names a vector store` below fails when the file stops being one.
 */
const EXEMPT = {
  'server/src/brain/embed-record.ts':
    'the queue path itself: it consults suppression at the top of embedStoredRecord and returns before storing, so a '
    + 'per-file count does not describe it. Asserted on its own at the bottom of this file.',
};

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
 * The files in {@link EXEMPT} are left out (the queue path, which has its own assertion). Everything else under
 * `server/src` is scanned, not only `brain/`: a conversion chunk and a media chunk store a vector the same way a
 * fact does.
 */
function vectorStores() {
  const out = [];
  for (const [file, src] of serverSources()) {
    if (file in EXEMPT) continue;
    for (const m of src.matchAll(/embedding:\s*\w+\.vector\b/g)) {
      out.push({ file, at: m.index });
    }
  }
  return out;
}

/**
 * The calls that count as consulting suppression — `embeddingSuppressedFor` and every exported wrapper that
 * reaches it, derived in `_suppression-resolvers.mjs` (the write planners ask through `vectorBeforeWrite`, which
 * asks through `suppressedAfterWrite`, `Q-194`).
 */
/**
 * The shared question, asked from OUTSIDE `brain/` as well.
 *
 * `suppressionResolvers()` reads two modules. A wrapper exported from a third (a file's own question, which joins the
 * record flag, the space setting and the ancestor walk) would not be in it, so a caller of that wrapper would count
 * as having no check. Extended here by the same rule the module uses — an exported function counts when it CALLS one
 * that does, followed one hop at a time — over every server source, narrowed to functions NAMED for suppression so
 * that `embedStoredRecord`, which merely contains a check, does not make every caller of it look like one.
 */
function sharedResolvers() {
  const names = [...suppressionResolvers()];
  const candidates = [];
  for (const [file, src] of serverSources()) {
    for (const m of src.matchAll(/^export (?:async )?function (\w*[Ss]uppress\w*)/gm)) {
      candidates.push({ file, name: m[1], src });
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const c of candidates) {
      if (names.includes(c.name)) continue;
      const body = bodyOf(c.src, c.name).replace(/^[^\n]*\n/, '');
      if (new RegExp(`\\b(?:${names.join('|')})\\s*\\(`).test(body)) { names.push(c.name); grew = true; }
    }
  }
  return names;
}
const RESOLVERS = sharedResolvers();
const resolverCall = () => resolverCallPattern(RESOLVERS);

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
      callers, [],
      'the record > schema > space order must exist in one place — `embeddingSuppressedFor`, in the module '
      + 'that owns the resolver. The embed sweep was the last other caller, with a hand-written copy of that '
      + 'function; it now calls `embeddingSuppressedFor` itself. Anything here is a second copy of the order.',
    );
  });
});

describe('every inline embed honours suppression', () => {
  it('finds the vector stores, so an empty sweep cannot pass', () => {
    // By IDENTITY rather than a count: the four creators store through one shared step since `Q-99` part 3, so
    // a count would have to be rewritten each time stores merge, and a count cannot say WHICH store is missing.
    const files = new Set(vectorStores().map(e => e.file));
    const known = [
      'server/src/brain/write-plan/plan-steps.ts', 'server/src/brain/merge.ts',
      // Outside `brain/` (Q-255): a file's conversion chunks and its image, audio and video chunks.
      'server/src/files/converters/pipeline.ts',
      'server/src/files/media/image-embedder.ts', 'server/src/files/media/audio-embedder.ts',
      'server/src/files/media/video-embedder.ts',
    ];
    for (const file of known) {
      assert.ok(files.has(file),
        `the scan no longer finds the vector store in ${file}, so it has broken and nothing below is checked`);
    }
    assert.ok([...files].some(f => !f.startsWith('server/src/brain/')),
      'every vector store found is under server/src/brain: the scan is scoped to one directory again (Q-255)');
  });

  it('every exemption still names a file that stores a vector, and says why', () => {
    // An exemption outlives the reason it was written for unless something re-reads it: a file that stopped storing
    // a vector, or moved, would stay on the list for ever and read as a decision.
    const sources = serverSources();
    assert.ok(Object.keys(EXEMPT).length >= 1, 'no exemption left, so the queue path is being scanned as a creator');
    for (const [file, reason] of Object.entries(EXEMPT)) {
      assert.ok(sources.has(file), `${file} is exempt but is no longer a server source`);
      assert.match(sources.get(file), /embedding:\s*\w+\.vector\b/, `${file} is exempt but stores no vector now`);
      assert.ok(reason.length >= 40, `${file} is exempt with no real reason`);
    }
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
      const src = serverSources().get(file);
      const stores = (src.match(/embedding:\s*\w+\.vector\b/g) ?? []).length;
      const checks = (src.match(resolverCall()) ?? []).length;
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
    // The brain, plus every file outside it that stores a vector: a `suppressed` const in a file that stores nothing
    // (sync's arrival writer has one that is a Set of ids) is a different question and is not this rule's subject.
    const stores = new Set(vectorStores().map(e => e.file));
    for (const [file, src] of serverSources()) {
      if (!file.startsWith('server/src/brain/') && !stores.has(file)) continue;
      const at = src.indexOf('const suppressed =');
      if (at === -1) continue;
      assert.match(
        statementAround(src, at, `${file} suppressed const`), resolverCall(),
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
    // The edge's inline embed is decided by its PLANNER since Q-99 part 3; `upsertEdge` and bulk both run it.
    const edges = bodyOf(stripComments(readFileSync('server/src/brain/write-plan/plan-edge.ts', 'utf8')), 'planEdge');
    const call = resolverCall().exec(edges);
    assert.ok(call, 'planEdge no longer consults suppression — re-point this gate');
    // The CALL's own arguments, not the statement around it: the statement continues into
    // `edgeEmbedText(… effectiveType …)`, so a `type` check over that window would read a word belonging to a
    // different call — the same mistake `merge-runs-the-write-paths-validators` records making.
    const args = argumentsOf(edges, call.index + call[0].length - 1, 'the edge suppression check').join(' ');
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
    // Re-anchored for bundle-30 `R12`: the removal is the one constant `UNSET_VECTOR` (its fields are pinned by
    // `suppress-embeddings-wiring`), not a hand-spelled `$unset` of `embedding`.
    assert.match(
      body, /\$unset:\s*UNSET_VECTOR\b/,
      'and must UNSET a stale vector rather than only skipping — that is what cleans up a record embedded '
      + 'before the flag was set',
    );
  });
});
