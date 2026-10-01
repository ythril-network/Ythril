/**
 * A reindex embeds the SAME text the write path embeds — because it embeds nothing itself.
 *
 * ## What this gate used to assert, and why that passed on the defect
 *
 * A reindex was five hand-written loops in `brain/reindex.ts`, and this file asserted that each one called the
 * `*EmbedText` builder its collection's write path calls. Every one did, and the gate was green — while the loops
 * skipped every record with `parentFileId` (text chunks, media chunks, captions), so after a model change those
 * kept vectors from the old model for ever; while the edge loop projected no `fromKind`/`toKind`, so an edge with a
 * fact or file end embedded that end's raw id; and while the file loop projected no `excerpt` though it passed one,
 * so every converted document re-embedded without its own text. A gate that pairs builder names with loops can only
 * see the loops that exist and the names they call; the projection each loop read was invisible to it.
 *
 * ## What it asserts now (Q-99 part 2, as carried into 5.6.x)
 *
 * A reindex rebuilds each record through `embedStoredRecord(..., { rebuild: true })`, which reads the WHOLE stored
 * document and builds its text in ONE place — `buildEmbedText` in `brain/embed-record.ts` — the same derivation a
 * queued write, a sync arrival and a backfill use. Whether that one place produces the creator's text is asserted
 * behaviourally, per kind and per derived record, in `a-rebuild-embeds-what-the-producer-embedded-db.test.js`.
 * What a source gate is still the right instrument for is the STRUCTURE that makes that test sufficient:
 *
 *  1. `reindex.ts` calls no `embed()` and no `*EmbedText` builder, and rebuilds through `embedStoredRecord` with
 *     `rebuild: true`. A loop grown back here would be a second text derivation the behavioural test never reaches.
 *  2. It walks every kind `embedStoredRecord` serves (derived from `COLLECTION`), and does not skip derived records.
 *  3. The route still delegates to `startReindex` and builds nothing.
 *  4. `pipeline.ts` builds a chunk's text only through `chunkEmbedText`, and so does `buildEmbedText`'s derived
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
  const work = reindex.slice(reindex.indexOf('export function startReindex'));

  it('the module is there and is not empty (the checks below cannot pass on nothing)', () => {
    assert.ok(reindex.length > 1000, `${REINDEX} is only ${reindex.length} chars after stripping comments — re-anchor this gate`);
    assert.ok(reindex.indexOf('export function startReindex') > 0,
      'startReindex is gone from reindex.ts — re-anchor this gate at wherever a reindex now starts');
  });

  it('calls no embed()', () => {
    assert.doesNotMatch(reindex, /\bembed\(/,
      'reindex.ts calls the model itself, so it is a second place a vector is built — one the behavioural test does not reach');
    assert.doesNotMatch(reindex, /import\s*\{[^}]*\bembed\b[^}]*\}\s*from '\.\/embedding\.js'/,
      'and must not import the embedder');
  });

  it('calls no *EmbedText builder', () => {
    assert.doesNotMatch(reindex, /\w+EmbedText\(/,
      'reindex.ts builds embed text itself — a second derivation that has drifted from the write path before');
    assert.doesNotMatch(reindex, /\bresolveEdgeEndpointNames\(/,
      'nor resolves an edge\'s endpoint names, which is the half of an edge\'s text a hand loop gets wrong');
  });

  it('rebuilds every record through embedStoredRecord, forced', () => {
    assert.ok(importedFrom(reindex, '\\./embed-record\\.js').includes('embedStoredRecord'),
      'reindex.ts must import embedStoredRecord from ./embed-record.js');
    const call = /\bembedStoredRecord\(([^)]*)\)/.exec(work);
    assert.ok(call, 'startReindex imports embedStoredRecord and never calls it — the import is decoration');
    assert.match(call[1], /rebuild:\s*true/,
      'a reindex must pass rebuild: true, or an unchanged text skips the model — which after a model change is every record');
  });

  it('walks every kind embedStoredRecord serves, derived records included', () => {
    assert.ok(importedFrom(reindex, '\\./embed-record\\.js').includes('COLLECTION'),
      'the kinds a reindex walks must come from COLLECTION, so a sixth kind is walked the day it is added');
    assert.doesNotMatch(work, /parentFileId/,
      'reindex.ts filters on parentFileId again — passages, captions and transcripts keep the old model\'s vectors for ever');
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
