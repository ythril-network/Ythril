/**
 * A reindex embeds the SAME text the write path embeds — because it embeds nothing itself.
 *
 * ## What this gate used to assert, and why that passed on the defect
 *
 * A reindex was five hand-written loops in `brain/reindex.ts`, and this file asserted that each one called the
 * `*EmbedText` builder its collection's write path calls. Every one did, and the gate was green — while the loops
 * skipped every record with `parentFileId` (text chunks, media chunks, captions), so after a model change those
 * kept vectors from the old model for ever. A gate that pairs builder names with loops can only see the loops that
 * exist; the missing kinds were invisible to it by construction.
 *
 * ## What it asserts now (Q-99 part 2)
 *
 * The rebuild goes through the embed queue, so the text is built in ONE place — `buildEmbedText` in
 * `brain/embed-record.ts` — for a reindex, a queued write, a sync arrival and a backfill alike. Whether that one
 * place produces the creator's text is asserted behaviourally, per kind and per derived record, in
 * `a-rebuild-embeds-what-the-producer-embedded-db.test.js`. What a source gate is still the right instrument for is
 * the STRUCTURE that makes that test sufficient:
 *
 *  1. `reindex.ts` calls no `embed()` and no `*EmbedText` builder, and delegates to the queue sweep. A loop grown
 *     back here would be a second text derivation the behavioural test never reaches.
 *  2. The route still delegates to `startReindex` and builds nothing.
 *  3. `pipeline.ts` builds a chunk's text only through `chunkEmbedText`, and so does `buildEmbedText`'s derived
 *     branch — so the text a chunk was stored with and the text it is rebuilt from cannot drift.
 *
 * Comments are stripped before matching, so a docblock that mentions `embed(` can neither satisfy nor fail a check.
 *
 * Run: node --test testing/standalone/reindex-embeds-the-same-text.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const REINDEX = 'server/src/brain/reindex.ts';
const PIPELINE = 'server/src/files/converters/pipeline.ts';
const EMBED_RECORD = 'server/src/brain/embed-record.ts';

/** Every name a file imports from a given module, so a check can ask "is any of them CALLED". */
function importedFrom(source, modulePattern) {
  const names = [];
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${modulePattern}'`, 'g');
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && !name.startsWith('type ')) names.push(name);
    }
  }
  return names;
}

describe('a reindex embeds nothing itself', () => {
  const reindex = src(REINDEX);

  it('the module is there and is not empty (the checks below cannot pass on nothing)', () => {
    assert.ok(reindex.length > 1000, `${REINDEX} is only ${reindex.length} chars after stripping comments — re-anchor this gate`);
    assert.match(reindex, /export\s+async\s+function\s+startReindex\b|export\s+function\s+startReindex\b/,
      'startReindex is gone from reindex.ts — re-anchor this gate at wherever a reindex now starts');
  });

  it('calls no embed()', () => {
    assert.doesNotMatch(reindex, /\bembed\(/,
      'reindex.ts calls the model itself, so it is a second place a vector is built — one the behavioural test does not reach');
    // The embedder's `embed` is the thing that must not be reachable; the module's pure helpers (the effective
    // prefix scheme a run is stamped with) are not a second place a vector is built.
    assert.doesNotMatch(reindex, /import\s*\{[^}]*\bembed\b[^}]*\}\s*from '\.\/embedding\.js'/,
      'and must not import the embedder');
  });

  it('calls no *EmbedText builder', () => {
    assert.doesNotMatch(reindex, /\w+EmbedText\(/,
      'reindex.ts builds embed text itself — a second derivation that has drifted from the write path before');
    assert.doesNotMatch(reindex, /\bresolveEdgeEndpointNames\(/,
      'nor resolves an edge\'s endpoint names, which is the half of an edge\'s text a hand loop gets wrong');
  });

  it('delegates to the queue sweep', () => {
    const sweepNames = importedFrom(reindex, '\\./queue-embed-sweep\\.js');
    assert.ok(sweepNames.length > 0, 'reindex.ts must import the shared sweep from ./queue-embed-sweep.js');
    const called = sweepNames.filter(n => new RegExp(`\\b${n}\\(`).test(reindex));
    assert.ok(called.length > 0,
      `reindex.ts imports ${sweepNames.join(', ')} from the sweep and calls none of them — the import is decoration`);
  });

  it('the ROUTE still delegates, rather than growing its own loop back', () => {
    const route = src('server/src/api/brain/search.ts');
    const at = route.indexOf("searchRouter.post('/spaces/:spaceId/reindex'");
    assert.ok(at > 0, 'the reindex route is gone — if it moved, re-point this assertion too');
    const next = route.indexOf('searchRouter.', at + 20);
    const handlerSrc = route.slice(at, next > 0 ? next : route.length);
    assert.match(handlerSrc, /startReindex\(/, 'the route must delegate the work');
    assert.doesNotMatch(handlerSrc, /\bembed\(/, 'the route must not embed anything itself');
    assert.doesNotMatch(handlerSrc, /EmbedText\(/, 'nor build embed text — that is the shared module\u2019s job');
  });
});

describe('a chunk\'s text has one builder', () => {
  it('pipeline.ts imports chunkEmbedText from embed-text.js and calls it', () => {
    const pipeline = src(PIPELINE);
    assert.ok(importedFrom(pipeline, '[^\']*embed-text\\.js').includes('chunkEmbedText'),
      'pipeline.ts must take its chunk text from brain/embed-text.js');
    assert.match(pipeline, /\bchunkEmbedText\(/, 'and must call it for every text chunk');
  });

  it('pipeline.ts does not assemble a chunk\'s text inline', () => {
    // The shape it had: `chunk.headingText ? \`${chunk.headingText} ${chunk.content}\` : chunk.content`. Any
    // template or concatenation that splices headingText is that same derivation written a second time.
    const pipeline = src(PIPELINE);
    assert.doesNotMatch(pipeline, /\$\{\s*[\w.]*headingText\s*\}/,
      'pipeline.ts splices headingText into a template itself — the rebuild would build the chunk text differently');
    assert.doesNotMatch(pipeline, /headingText\s*\+/, 'nor by concatenation');
  });

  it('buildEmbedText\'s derived branch uses the same builder', () => {
    const record = src(EMBED_RECORD);
    assert.ok(importedFrom(record, '\\./embed-text\\.js').includes('chunkEmbedText'),
      'embed-record.ts must import chunkEmbedText, or a rebuilt chunk is embedded from different text than it was stored with');
    assert.match(record, /\bchunkEmbedText\(/, 'and call it');
  });
});
