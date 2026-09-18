/**
 * The `traverse` TOOL says how it differs from `recall(traverse: n)`, because the names collide.
 *
 * ## The collision
 *
 * Two things are called traversal and they answer different questions. Recall's expansion walks edges out of
 * whatever a SEARCH matched; this tool walks out of a node you already name. A caller who reads only one
 * schema has no way to learn the other exists, and the word gives no hint that it should look.
 *
 * That ambiguity has already cost one round trip in this repo — the owner asked whether
 * `excludeFromVectorSearch` hides a record from "recall's traversal", because the exclusion schema listed
 * "traverse" among the readers that still reach it and that sentence is true of both.
 *
 * ## The difference that actually decides which one you want
 *
 * `entityIds` references — a chrono entry, a memory or a file pointing AT an entity — are NOT edges. Recall's
 * expansion cannot reach them at any depth. This tool can, and that is what `includeChrono`,
 * `includeMemories` and `includeFiles` are for. A caller who does not know that will conclude the data is
 * missing rather than that they used the wrong walk.
 *
 * ## X-2, fourth tool
 *
 * The parameters here were already written to the standard. What was absent was the tool-level framing and
 * the response, which is the same gap every tool in this sweep has had.
 *
 * Run: node --test testing/standalone/traverse-tool-schema-distinguishes-itself.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('server/src/mcp/tools/edge.ts', 'utf8');
const TRAVERSE = (() => {
  const at = SRC.indexOf("name: 'graph_traverse'");
  assert.ok(at > 0, 'the traverse tool was not found — the scanner is wrong, not the code');
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
})();

describe('it names the other traversal', () => {
  it('says outright that it is not recall\'s expansion', () => {
    assert.match(TRAVERSE, /NOT THE SAME AS `recall\(traverse: n\)`/,
      'the two share a name and answer different questions; say so before anything else');
  });

  it('says the difference in STARTING POINT', () => {
    assert.match(TRAVERSE, /already know/i,
      'this starts from a node you name; recall starts from whatever a search matched');
  });

  it('names `entityIds` as the mechanism, and says how the two tools differ NOW', () => {
    /*
     * This asserted the literal *"unreachable from `recall`"* until 3.6, when recall gained the same three
     * flags. The claim was true when written and the sentence had to go with the capability — a caller told
     * they cannot do something does not report being able to, so a stale limit is invisible in a way a stale
     * feature is not.
     *
     * What is still worth pinning is the part a caller has to know: the mechanism is a FIELD rather than an
     * edge, and the two tools now differ by DEFAULT rather than by capability.
     */
    assert.match(TRAVERSE, /entityIds/, 'name the mechanism, not just "more kinds of record"');
    assert.doesNotMatch(TRAVERSE, /unreachable from `recall`/,
      'recall follows these since 3.6, so this sentence tells a caller not to try the thing that works');
    assert.match(TRAVERSE, /default/i,
      'the two tools differ by default now, and a caller choosing between them needs that stated');
  });
});

describe('it describes what comes back', () => {
  it('names the node fields including `kind` and `depth`', () => {
    assert.match(TRAVERSE, /`depth`/, 'a flat list with depths is a different shape from recall\'s nesting');
    /*
     * This pinned *"entity unless it arrived via one of the include flags"* until 5.0, and the change that
     * made the sentence FALSE is what re-pointed it: a node also arrives as a fact, chrono entry or file
     * when an explicit EDGE names one, with no flag involved. A gate pinned to the old wording would have
     * demanded the description keep saying something untrue.
     *
     * The rule it asserts is the one that has not changed: `kind` names the COLLECTION, and the
     * description has to say so, because that is what a caller reads while constructing arguments.
     */
    assert.match(TRAVERSE, /`kind` \("entity", or the collection it lives in/,
      '`kind` is how a caller tells an entity from a chrono/fact/file arrival, and the description must say so');
    assert.match(TRAVERSE, /through an explicit edge or through one of the include flags/,
      'and it must say BOTH ways a non-entity node arrives — an edge needs no flag');
  });

  it('warns that a truncated walk is a PARTIAL graph', () => {
    // The quiet failure: an impact assessment run on a cut walk answers a smaller question than it was asked,
    // and the answer looks complete.
    assert.match(TRAVERSE, /PARTIAL graph/,
      'a cut walk is not a short answer, it is a different answer');
  });

  it('distinguishes "no neighbours" from "no such node"', () => {
    assert.match(TRAVERSE, /depth 0/, 'startId comes back at depth 0, so a lone node is not an empty result');
    assert.match(TRAVERSE, /resolved to nothing/,
      'an empty `nodes` means the id matched nothing — a different answer from an isolated node');
  });
});
