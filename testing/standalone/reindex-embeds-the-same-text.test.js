/**
 * A reindex embeds the SAME text the normal write path embeds — asserted from source, because nothing else can.
 *
 * ## The gap this fills, stated precisely
 *
 * `reindex-contract.test.js` proves every collection comes out with an embedding. It cannot prove the embedding came
 * from the right text: the reindex loop writes `embedding` and `embeddingModel` and deliberately does not write
 * `matchedText`, so from outside the API a vector built from `edgeEmbedText(from, label, to, …)` and one built from
 * `edgeEmbedText(label, from, to, …)` are indistinguishable. Both are 768 floats and both make the record findable
 * by *something*.
 *
 * That is the failure an extraction of five near-identical loops is most likely to introduce, and the failure nobody
 * would notice: recall would keep returning results, just slightly wrong ones, for the records reindexed after the
 * refactor and not for the ones written before it.
 *
 * So this reads the source. A source gate is the weaker instrument in general, and here it is the only one that can
 * see the thing at all — which is the whole argument for having both files.
 *
 * ## What is actually asserted
 *
 * Each of the five branches must call the `*EmbedText` builder that its collection's WRITE path calls. Derived by
 * pairing collection → builder rather than by counting call sites, so a sixth collection added later is covered on
 * the day it is written, and a branch that quietly starts building its own string fails.
 *
 * The `excerpt` argument on the file branch is asserted by name, and it has a specific history: without it a reindex
 * re-embeds every converted document WITHOUT the document's own text, dropping exactly the phrases a reader
 * searches for. The file's own comment says so; this is that comment with a test attached.
 *
 * Run: node --test testing/standalone/reindex-embeds-the-same-text.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stripComments = (t) => t.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The five loops, wherever they live.
 *
 * They were inline in the route handler and now sit in `brain/reindex.ts`, so this reads the module. The route's own
 * obligation — that it still DELEGATES rather than growing its own loop back — is a separate assertion below, because
 * re-pointing a gate at moved code and forgetting the place it moved from is how a check quietly covers half of what
 * it used to.
 */
const WORK = 'server/src/brain/reindex.ts';

function reindexLoops() {
  const src = stripComments(readFileSync(WORK, 'utf8'));
  const start = src.indexOf('export function startReindex');
  assert.ok(start > 0, `the reindex work moved out of ${WORK} — re-point this gate at wherever the loops now live`);
  return src.slice(start);
}

/**
 * collection → the embed-text builder its WRITE path uses.
 *
 * Not a list of what the reindex currently calls — that would agree with the code by construction. Each pairing is
 * the one the record's own write path uses, so the assertion is *the reindex reproduces the write*, which is the
 * property that matters.
 */
const BUILDERS = [
  ['facts', 'factEmbedText'],
  ['entities', 'entityEmbedText'],
  ['edges', 'edgeEmbedText'],
  ['chrono', 'chronoEmbedText'],
  ['files', 'fileEmbedText'],
];

describe('a reindex reproduces what the write path embedded', () => {
  const handler = reindexLoops();

  it('found the loops, and they are the whole job rather than a stub', () => {
    // Floors it: if the slice were empty or tiny, every check below would pass on nothing. The five loops are
    // hundreds of lines, which is why they were extracted rather than duplicated for a second surface.
    assert.ok(handler.length > 3000, `the sliced work is only ${handler.length} chars — the slice is wrong`);
  });

  it('every collection is re-embedded through its own write-path builder', () => {
    const missing = BUILDERS.filter(([, builder]) => !new RegExp(`\\b${builder}\\(`).test(handler))
      .map(([collection, builder]) => `${collection} → ${builder}()`);
    assert.deepEqual(missing, [],
      'these collections are reindexed without calling the builder their write path uses, so their vectors are '
      + 'built from different text than the records written normally — recall keeps working and quietly disagrees '
      + `with itself:\n  ${missing.join('\n  ')}`);
  });

  it('the builders come from the shared module, not re-implemented locally', () => {
    // The other way to break the pairing above: keep the name, declare it here. A local `const edgeEmbedText = …`
    // would satisfy the regex and embed whatever it liked.
    const src = readFileSync(WORK, 'utf8');
    for (const [, builder] of BUILDERS) {
      assert.match(src, new RegExp(`import \\{[^}]*\\b${builder}\\b[^}]*\\} from '[^']*embed-text\\.js'`, 's'),
        `${builder} must be imported from brain/embed-text.js, not declared alongside the loops`);
    }
  });

  it('the ROUTE still delegates, rather than growing its own loop back', () => {
    // The other half of re-pointing this gate. Everything above now reads `brain/reindex.ts`, so a handler that
    // re-implemented the re-embed inline would satisfy all of it while embedding whatever it liked. Asserted where the
    // route is: it must call `startReindex`, and must build no embed text of its own.
    const route = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    const at = route.indexOf("searchRouter.post('/spaces/:spaceId/reindex'");
    assert.ok(at > 0, 'the reindex route is gone — if it moved, re-point this assertion too');
    const next = route.indexOf('searchRouter.', at + 20);
    const handlerSrc = route.slice(at, next > 0 ? next : route.length);
    assert.match(handlerSrc, /startReindex\(/, 'the route must delegate the work');
    assert.doesNotMatch(handlerSrc, /\bembed\(/, 'the route must not embed anything itself');
    assert.doesNotMatch(handlerSrc, /EmbedText\(/, 'nor build embed text — that is the shared module’s job');
  });

  it('the file branch passes `excerpt`, or a reindex drops every document body', () => {
    // Specific and paid for: without `excerpt` a reindex re-embeds a converted document WITHOUT the document's own
    // text, so the phrases a reader actually searches for disappear from the vector while the record still looks
    // indexed. The route carries a comment saying exactly this; a comment is not a check.
    const call = /fileEmbedText\(([^)]*)\)/.exec(handler);
    assert.ok(call, 'the file branch no longer calls fileEmbedText');
    assert.match(call[1], /excerpt/, 'fileEmbedText must be given the excerpt — see the comment at the call site');
  });

  it('chunk records are excluded, so a chunk is not re-embedded as a file', () => {
    // Chunks carry `parentFileId` and have their own embedding logic. Re-embedding one here would overwrite a
    // passage vector with a file-metadata vector, which is how a document becomes unsearchable by its own contents.
    assert.match(handler, /parentFileId/,
      'the files branch must still exclude chunk records (parentFileId set) from the file re-embed');
  });
});
