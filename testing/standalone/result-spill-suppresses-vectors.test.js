/**
 * A spilled result set carries no vectors, and the whole set spills — not just the graph.
 *
 * ## The correction this pins
 *
 * The first version spilled the GRAPH: the neighbours that did not fit inline. The owner's intent was the whole
 * result set — *"when someone recalls with topK=100 and traverse=2 he gets a real big file to download but only 3
 * full results back in the response"*. A recall cannot be paged, so a large answer has nowhere to go otherwise.
 *
 * ## Why the vector strip is a WRITE-time rule and not a projection
 *
 * Recall's own queries already exclude `embedding`, and `traverseFromSeeds` projects it away too. This is the belt
 * to that braces, and it is at the write because a spill is the one place a whole result set is serialised
 * verbatim into a file an operator can open: one future field that forgets the projection would put thousands of
 * floats in front of them. A rule at the write cannot be forgotten by a caller who never knew it.
 *
 * Run: node --test testing/standalone/result-spill-suppresses-vectors.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const {
  suppressEmbeddings, countGraphNodes, SPILL_TTL_DAYS,
} = await import('../../server/dist/brain/graph-spill.js');

const read = p => stripComments(readFileSync(p, 'utf8'));

describe('vectors never reach the file', () => {
  it('strips every vector key, at every depth', () => {
    const out = suppressEmbeddings({
      _id: 'a',
      embedding: [1, 2, 3],
      record: { vector: [4], name: 'x', nested: [{ embeddings: [9], contentEmbedding: [1], ok: 1 }] },
    });
    assert.equal(JSON.stringify(out).includes('embedding'), false, JSON.stringify(out));
    assert.equal(JSON.stringify(out).includes('vector'), false, JSON.stringify(out));
    assert.equal(out.record.name, 'x', 'and keeps everything else');
    assert.equal(out.record.nested[0].ok, 1);
  });

  it('does not mutate what it was given', () => {
    // The results are also the response the caller gets inline; deleting in place would thin both.
    const input = { embedding: [1], keep: 2 };
    suppressEmbeddings(input);
    assert.deepEqual(input, { embedding: [1], keep: 2 });
  });

  it('survives the awkward shapes', () => {
    assert.equal(suppressEmbeddings(null), null);
    assert.equal(suppressEmbeddings('x'), 'x');
    assert.deepEqual(suppressEmbeddings([{ embedding: [1] }, 2]), [{}, 2]);
  });

  it('is applied at the write, not left to the caller', () => {
    const src = read('server/src/brain/graph-spill.ts');
    const body = bodyOf(src, 'spillResultSet', 'the vector strip');
    assert.match(body, /JSON\.stringify\(suppressEmbeddings\(\{/,
      'the strip must wrap the whole payload at serialisation, not a field somebody remembered');
  });
});

describe('the remainder is written out, with a TTL', () => {
  it('the record count is taken from the payload, not passed in', () => {
    // It WAS passed in, as `opts.graphNodes`, and the route handed it the node total for the WHOLE result
    // set. Once the byte budget started handing this function the remainder alone, that number described a
    // different set of records from the one being written — and `records` is what a caller sizes the
    // download by. A count taken from the payload cannot disagree with the payload.
    const src = read('server/src/brain/graph-spill.ts');
    assert.match(src, /const graphNodes = countGraphNodes\(opts\.results\);/,
      'the node figure must be derived from what is being written');
    assert.match(src, /const records = opts\.results\.length \+ graphNodes;/);
    assert.doesNotMatch(src, /graphNodes: number;/,
      'a `graphNodes` parameter is a second source for one number, and the routes fed it the wrong set');
    // Counted at every depth: a nested node carries its own `_graph`, so a shallow count would understate a
    // depth-2 file by most of its content.
    assert.equal(countGraphNodes([{ _graph: [{ node: 1, _graph: [{ node: 2 }, { node: 3 }] }] }]), 3);
    assert.equal(countGraphNodes([{ record: { name: 'x' } }]), 0, 'no traversal, no nodes');
  });

  it('there is no threshold left here — the budget decides, and this always writes', () => {
    // The guard `if (records <= SPILL_RECORD_THRESHOLD) return null` survived the switch to the byte budget
    // and became a second rule about size. It cost exactly what a disagreeing second rule costs: a response
    // truncated at twenty records with five left over said `truncated: true` and carried NO link to the
    // five, because the remainder was under the old count. The caller was told there was more and given no
    // way to reach it.
    const src = read('server/src/brain/graph-spill.ts');
    assert.doesNotMatch(src, /SPILL_RECORD_THRESHOLD\s*=/, 'the record threshold must not come back');
    assert.doesNotMatch(src, /SPILL_INLINE_RESULTS\s*=/, 'nor the three-record sample it went with');
    /*
     * The window is the WHOLE function, and here that is not tidiness — the assertion below is a
     * `doesNotMatch`. A window that falls short of its subject passes by looking at less: a `return null` past
     * the old 1 800-character cap would have gone unseen, and this is the exact rule whose absence shipped a
     * truncated answer with nowhere to go.
     */
    const body = bodyOf(src, 'spillResultSet', 'the no-threshold rule');
    assert.doesNotMatch(body, /return null;/,
      'a spill asked for must be a spill written — a null here is a truncated answer with nowhere to go');
    assert.match(body, /\): Promise<ResultSpill> \{/,
      'and the type must say so, so no caller has to handle an absence that cannot happen');
    // `inline` described how many matches came back in the response. Under the budget that number is
    // `returned`, which the envelope already reports, and a copy on the file object could only disagree.
    assert.doesNotMatch(src, /inline: Math\.min/, 'the stale inline count must be gone from the spill object');
  });

  it('one-day TTL, through the record machinery', () => {
    assert.equal(SPILL_TTL_DAYS, 1);
    const src = read('server/src/brain/graph-spill.ts');
    assert.match(bodyOf(src, 'spillResultSet', 'the TTL'), /ttlDays: SPILL_TTL_DAYS/,
      'the file must expire with its record, like the graph spill beside it');
  });

  it('all four response sites use it', () => {
    // Two REST routes and two MCP tools. A site that skipped it would return the enormous answer this exists to
    // prevent, and nothing else would notice.
    const rest = read('server/src/api/brain/search.ts');
    const mcp = read('server/src/mcp/tools/search.ts');
    // TWO branches each: with and without `traverse`. The first version wired only the graph branch, so the
    // plainest large call — `topK: 100`, no traversal — returned everything. The E2E caught it; this counts it.
    //
    // MCP went 3 → 4 in 3.1.0. `similar` answered plain TEXT at `traverse: 0`, so it had nothing to
    // spill there and only its graph branch was wired; returning JSON at every depth gave the default depth
    // a size cap it had never had. That is the second time a "plainest large call" went uncapped, which is
    // why this counts sites rather than trusting that a new branch remembered.
    assert.equal((rest.match(/spillResultSet\(\{/g) ?? []).length, 4, 'REST recall + find-similar, both branches');
    assert.equal((mcp.match(/spillResultSet\(\{/g) ?? []).length, 4, 'MCP recall + find_similar, both branches each');
    // This used to assert `slice(0, SPILL_INLINE_RESULTS)` — the three-record sample. X-17 replaced that cap
    // with a byte budget, so the rule it was protecting has changed shape rather than gone: the response
    // must still be BOUNDED, and the spill must still receive what the caller did not get. The pinned detail
    // was the old mechanism; the rule is that neither door hands back an unbounded set.
    //
    // The `doesNotMatch` here does NOT name the old constant. It cannot: `SPILL_INLINE_RESULTS` is deleted,
    // so a pattern mentioning it can never match and the assertion would pass by looking at nothing. What
    // would actually reintroduce the shape is any fixed-count slice of the results before they are returned,
    // whatever the number is spelled as — so that is what is refused.
    for (const [name, src] of [['REST', rest], ['MCP', mcp]]) {
      assert.ok((src.match(/budgetedEnvelope\(\{/g) ?? []).length >= 4,
        `${name} must bound every result path through the shared budget rather than returning what it has`);
      // A CONSTANT second argument is the tell: `slice(0, SPILL_INLINE_RESULTS)` and `slice(0, 3)` both cut
      // the answer to a number nobody asked for, while `slice(0, safeTopK)` cuts it to what the caller did
      // ask for and is right. Screaming-snake or a bare digit, therefore — not any identifier.
      assert.doesNotMatch(src, /\.slice\(0,\s*(\d+|[A-Z][A-Z0-9_]{2,})\)/,
        `${name} cuts the results to a fixed count — a constant sample is the shape X-17 removed, and `
        + 'reintroducing it would restore the cost it roughly doubled');
    }
  });

  it('the spill receives ONLY what did not fit', () => {
    // The old dump re-sent the whole result set, including the records already returned inline — which is
    // most of why the previous shape cost more than it saved. `budgetedEnvelope` hands its `spillRemainder`
    // callback the remainder alone, so a spilled file is the continuation rather than a duplicate.
    const restSrc = read('server/src/api/brain/search.ts');
    const mcpSrc = read('server/src/mcp/tools/search.ts');
    for (const [name, src] of [['REST', restSrc], ['MCP', mcpSrc]]) {
      const callbacks = (src.match(/spillRemainder: remainder => spillResultSet\(\{/g) ?? []).length;
      const remainders = (src.match(/results: remainder,/g) ?? []).length;
      assert.equal(callbacks, 4, `${name}: expected four spill callbacks, found ${callbacks}`);
      assert.equal(remainders, 4,
        `${name} spills something other than the remainder on ${callbacks - remainders} path(s) — a dump that `
        + 'repeats what was already sent is the defect this replaced');
    }
  });

  it('every result path passes the paging through — all eight, on both doors', () => {
    /*
     * THE SAME SHAPE AS THE DEFECT THAT MADE THIS FILE, one clause later.
     *
     * The record cap was applied in four of eight result paths and missing from the others; an E2E found it,
     * because every rule the source gate checked was true in the branch it looked at. `skip` and
     * `remainderDump` are now the same kind of thing: eight sites, one rule, and a site that forgets them
     * silently serves page one to a caller asking for page two and writes a file nobody wanted.
     */
    for (const [name, src] of [['REST', read('server/src/api/brain/search.ts')],
                               ['MCP', read('server/src/mcp/tools/search.ts')]]) {
      const envelopes = (src.match(/budgetedEnvelope\(\{/g) ?? []).length;
      const skips = (src.match(/skip: paging\.skip,/g) ?? []).length;
      const dumps = (src.match(/remainderDump: paging\.remainderDump,/g) ?? []).length;
      assert.equal(skips, envelopes,
        `${name}: ${envelopes} budgeted paths but ${skips} pass \`skip\` — a path that drops it re-serves the `
        + 'first page to a caller who asked to continue');
      assert.equal(dumps, envelopes,
        `${name}: ${envelopes} budgeted paths but ${dumps} pass \`remainderDump\` — a path that drops it `
        + 'writes a file on a read that did not ask for one');
      // Validated in ONE place, not parsed per route: a `skip` that 400s on one door and floors to zero on
      // the other is this codebase's most-produced defect, and both doors call the same resolver for that
      // reason.
      assert.match(src, /resolvePaging\(/, `${name} must resolve paging through the shared validator`);
      assert.doesNotMatch(src, /Number\(\s*(req\.body|a)\[['"]skip['"]\]/,
        `${name} parses \`skip\` itself — the second implementation is the one that ends up weaker`);
    }
  });

  it('the continuation and the opt-in dump cannot be separated', () => {
    /*
     * The dump is only ALLOWED to be optional because there is another way to the remainder. That is one
     * dependency between two clauses, and it lives in `budgetFields`: `nextSkip` is emitted exactly when
     * `truncated`, unconditionally, with no flag of its own.
     *
     * Gated at the source because the failure is an omission. Making the dump opt-in is a one-line change and
     * looks complete on its own; the response it produces is a caller told there is more with nothing to act
     * on, which is the regression #969 shipped in its first cut and had to fix.
     */
    const budget = read('server/src/brain/result-budget.ts');
    assert.match(budget, /\.\.\.\(outcome\.truncated \? \{ nextSkip: skip \+ outcome\.returned\.length \} : \{\}\)/,
      'nextSkip must be emitted whenever the answer truncated, and be absolute rather than page-relative');
    assert.match(budget, /if \(outcome\.truncated && opts\.remainderDump === true\)/,
      'the dump must be gated on an explicit true — a truthy check would make any value opt in');
    // `count` is the FULL total on a skipped page, which requires slicing inside the envelope rather than at
    // the call sites. A route that shortened its own array would make `count` shrink page by page.
    assert.match(budget, /const page = skip > 0 \? opts\.results\.slice\(skip\) : opts\.results;/,
      'the skip must be applied inside the envelope, or `count` stops reporting the total');
    assert.match(budget, /budgetFields\(outcome, opts\.results\.length, opts\.budget, skip\)/,
      'and the total handed to budgetFields must be the pre-skip length');
  });

  it('`count` still reports the real total, not the sample', () => {
    // The sample is three; a caller who read `count: 3` would conclude the space holds three matching records.
    // `count` moved into `budgetFields`, which is the point: one definition instead of four sites each
    // spelling it out and one of them eventually spelling it wrong. The rule is unchanged — it is the TOTAL
    // number of matches, never the number returned — and `returned` is the new field for the other question.
    const budget = read('server/src/brain/result-budget.ts');
    assert.match(budget, /count: totalMatches,/, 'count must be the full set, not the returned prefix');
    assert.match(budget, /returned: outcome\.returned\.length,/,
      'and `returned` must report the prefix, so the two questions have two fields');
  });
});
