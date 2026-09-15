/**
 * A record retired from semantic ranking is still reachable through its edges — including by recall's own
 * `traverse` expansion — and every surface that says so must keep saying it.
 *
 * ## The question this exists because of
 *
 * Owner, 2026-08-15: *"excludefromvector does also exclude from recalls traversal? ambigous and i want
 * entries to be findable via traversal even if they are not embedded themselves."*
 *
 * The answer is no, and it is structural rather than a policy anyone chose: `suppressEmbeddings` is
 * implemented as the ABSENCE of a vector (`brain/embed-record.ts`), not as a query-time filter. Recall's
 * `traverse` expansion walks EDGES out of a match, so it never consults a vector, and `recall-graph.ts`
 * filters on nothing but the edge.
 *
 * ## Why the question had to be asked at all
 *
 * The schema description listed `traverse` among the readers that still reach an excluded record. That is
 * true of BOTH traversals — the `traverse` tool and `recall(traverse: n)` — and reads as neither, because a
 * reader has to already know there are two before the word tells them anything.
 *
 * `help()` says the tool schema is the authoritative reference, and CLAUDE.md records what a stale sentence
 * there already cost: The fleet integrator read *"filter applied after vector search"*, believed it, and built a skill
 * that avoided filtered recall. An ambiguous sentence is cheaper than a wrong one and not by much.
 *
 * ## What is gated
 *
 * That the behaviour stays absent from the read path — no query-time filter creeping in — and that both
 * surfaces keep naming both traversals. A doc that stops saying it is how the question gets asked again.
 *
 * Run: node --test testing/standalone/exclusion-does-not-hide-from-traversal.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
/** Line comments first, then block — a block-open inside a line comment otherwise swallows real code. */
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the exclusion is a missing vector, never a read-time filter', () => {
  it('the graph walk does not consult the flag', () => {
    // If this ever grew a filter on the record tier, a suppressed record would silently vanish from
    // `_graph` — the exact behaviour the owner asked us NOT to have, and invisible from any single result.
    const src = strip(read('server/src/brain/recall-graph.ts'));
    assert.doesNotMatch(src, /suppressEmbeddings|excludeFromVectorSearch|recordSuppression/,
      'traversal must reach a suppressed record; it walks edges and must not read the flag under EITHER '
      + 'spelling, nor through the shared reader');
  });

  it('only the embed path reads it, which is what makes it a missing vector', () => {
    // One writer, no readers. The flag has meaning exactly once — when deciding whether to store a vector.
    //
    // Read from `suppress-embeddings.ts`, which is where the resolution moved when the record creators needed
    // it before their inline embed. Keeping it in `embed-record.ts` would have put six brain modules in a
    // runtime import cycle, since that file imports `edges.ts`.
    const embed = strip(read('server/src/brain/suppress-embeddings.ts'));
    assert.match(embed, /recordSuppression\(doc\)/, 'the embed path is where the flag is honoured');
    /*
     * THE VECTOR REMOVAL IS IN `embed-record.ts`, and this asserted it in the wrong file.
     *
     * It matched any `$unset` in `suppress-embeddings.ts` — which was `mirrorLegacySuppression`'s, keeping
     * the pre-3.1.0 key in step, and had nothing to do with a vector. `D-6` deleted that function and the
     * gate went red over a property that still holds, which is how a match on the wrong thing announces
     * itself: only when the thing it was really matching disappears.
     */
    const store = strip(read('server/src/brain/embed-record.ts'));
    assert.match(store, /\$unset: \{ embedding/,
      'setting it must REMOVE the vector, not mark the record');
  });
});

describe('both surfaces name both traversals', () => {
  // "traverse" alone is the ambiguity that produced the question. Each surface has to distinguish the tool
  // from recall's expansion, in whatever words it uses.
  it('the MCP schema description does', () => {
    const d = read('server/src/mcp/tools/shared.ts');
    assert.match(d, /traverse` tool/, 'name the traverse TOOL');
    assert.match(d, /traverse` expansion/, "name recall's own expansion");
    assert.match(d, /walks\s*'?\s*\+?\s*'?edges|walks edges/,
      'say WHY it still reaches — it walks edges and never consults a vector');
  });

  it('the integration guide does', () => {
    /*
     * `04f-write-semantics.md` since A-5: "retiring a record from semantic search" moved there with the rest
     * of the write-and-read rules, which apply to every record type rather than to memories. Read from where
     * the section IS — a gate left pointing at the old page fails all three assertions at once and reads as
     * three missing sentences rather than one moved file.
     */
    const g = read('docs/integration-guide/04f-write-semantics.md');
    assert.match(g, /recall\(traverse: n\)/, 'the guide must name recall.s expansion explicitly');
    assert.match(g, /the `graph_traverse` tool/, 'and the tool, as a separate row');
    assert.match(g, /still findable through its relationships/i,
      'state the consequence, which is the half the owner actually wanted');
  });
});
