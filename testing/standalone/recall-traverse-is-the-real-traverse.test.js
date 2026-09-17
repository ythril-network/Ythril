/**
 * A recall's graph expansion narrows exactly as the standalone traverse does.
 *
 * ## The defect this pins
 *
 * `recall(traverse: n)` followed EVERY edge in BOTH directions, with no way for a caller to say otherwise —
 * while the standalone `traverse` tool, building the same Mongo query twenty lines away in the same file,
 * applied an `edgeLabels` filter and honoured `direction`. One rule, two implementations, and the one reachable
 * from a search had the weaker.
 *
 * That is not a missing convenience. On any corpus where a few nodes hold most of the edges — every real one —
 * an unnarrowed hop off a hub returns whichever neighbours the node cap happened to keep, and nothing in the
 * response distinguishes that from a deliberate answer.
 *
 * ## What is asserted, and why it is source-read
 *
 * Exercising it needs a populated graph and a running instance, which is what the Docker suites are for. What
 * can be pinned here is the property that broke and would break again the same way: **one query builder, one
 * parser, both doors**. A second copy is the whole defect; a test that checked only "recall accepts edgeLabels"
 * would pass on a second implementation that drifts next week.
 *
 * Run: node --test testing/standalone/recall-traverse-is-the-real-traverse.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeBody, delegatesCleanly } from './_delegating-routes.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, balancedFrom } from './_structural-window.mjs';

/*
 * Three files since A-4, and which one holds what is the point of the split: `frontierEdgeQuery` is the rule
 * BOTH traversals apply and went sideways into its own module; the recall walk moved; `traverseGraph` stayed.
 *
 * Read as one blob, because every assertion below is about whether the RULE exists in the traversal rather
 * than about which file it sits in — and joining them keeps this gate from having to be edited again the next
 * time one of the three moves.
 */
const EDGES = stripComments(
  readFileSync('server/src/brain/frontier-query.ts', 'utf8')
  + readFileSync('server/src/brain/recall-seed-traversal.ts', 'utf8')
  + readFileSync('server/src/brain/edges.ts', 'utf8'),
);
const SPILL = stripComments(readFileSync('server/src/brain/graph-spill.ts', 'utf8'));
const REST = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
const MCP = stripComments(readFileSync('server/src/mcp/tools/search.ts', 'utf8'));
const OPTION = stripComments(readFileSync('server/src/brain/traverse-option.ts', 'utf8'));

describe('ONE query builder, so the two traversals cannot drift again', () => {
  it('the frontier query is written once and exported', () => {
    assert.match(EDGES, /export function frontierEdgeQuery\(/,
      'the shared builder is gone — two traversals building their own predicate is the original defect');
  });

  it('it honours direction and edge labels', () => {
    const body = bodyOf(EDGES, 'frontierEdgeQuery');
    assert.match(body, /'outbound'/, 'no outbound branch');
    assert.match(body, /'inbound'/, 'no inbound branch');
    assert.match(body, /label: \{ \$in:/, 'no label filter — this is the half recall was missing');
  });

  it('NEITHER traversal builds its own frontier predicate any more', () => {
    /*
     * The assertion that actually prevents the regression. A `$or` over from/to written inline is exactly the
     * shape that was duplicated, and finding one outside the shared builder means the split is back.
     */
    const builderAt = EDGES.indexOf('export function frontierEdgeQuery');
    // Cut from where the BODY starts, not from the declaration. Slicing `builderAt + body.length` removes a
    // span shifted by the signature's own length, so it leaves the builder's `$or` in place and reports the
    // one predicate that is legitimately there — the gate accusing its own subject.
    const bodyStart = EDGES.indexOf('{', EDGES.indexOf(')', builderAt));
    const builder = balancedFrom(EDGES, bodyStart, 'frontierEdgeQuery');
    const withoutBuilder = EDGES.slice(0, bodyStart) + EDGES.slice(bodyStart + builder.length);
    const inlineOr = [...withoutBuilder.matchAll(/\$or:\s*\[\s*\{\s*from:\s*\{\s*\$in:/g)];
    assert.equal(inlineOr.length, 0,
      `${inlineOr.length} frontier predicate(s) built outside the shared builder — that is the split returning`);
  });
});

describe('ONE parser, so the two doors cannot disagree about a narrowing', () => {
  it('both doors call it', () => {
    for (const [name, src] of [['REST', REST], ['MCP', MCP]]) {
      assert.match(src, /parseTraverseOption\(/, `${name} parses traverse itself instead of using the shared parser`);
    }
  });

  it('neither door still hand-checks the number', () => {
    /*
     * The pre-fix shape, and the one a partial migration leaves behind: a door that kept its own
     * `typeof !== 'number'` check accepts the number and rejects the object, which is a parameter that means
     * different things on different doors — the defect one level up from the one being fixed.
     */
    for (const [name, src] of [['REST', REST], ['MCP', MCP]]) {
      assert.doesNotMatch(src, /typeof (?:traverse|a\['traverse'\]|traverseRaw) !== 'number'/,
        `${name} still validates traverse by hand, so the object form is refused there`);
    }
  });

  it('the parser refuses rather than coercing, in every direction', () => {
    const body = OPTION;
    for (const [what, pattern] of [
      ['a non-integer or out-of-range depth', /must be an integer between 0 and/],
      ['a wrong type entirely', /must be a number \(the depth\) or an object/],
      ['an unknown field inside the object', /unknown field\(s\)/],
      ['a bad edgeLabels', /edgeLabels must be an array of non-empty strings/],
      ['a bad direction', /direction must be one of/],
    ]) {
      assert.match(body, pattern, `the parser does not refuse ${what} — a silent default returns a different graph with a 200`);
    }
  });

  it('`limit` is refused inside the object, and the refusal says why', () => {
    // In a recall the node cap comes from topK and the byte budget. A traverse that could raise it would
    // overrule the budget governing the rest of the answer, so this is a deliberate omission and the error
    // message has to say so or the next caller reads it as an oversight.
    assert.doesNotMatch(OPTION, /TRAVERSE_OPTION_FIELDS = \[[^\]]*'limit'/,
      '`limit` is accepted, which lets traverse overrule the answer budget');
    assert.match(OPTION, /limit` is not accepted/, 'the refusal does not explain itself');
  });
});

describe('the narrowing reaches the database', () => {
  it('the spill builder PASSES it on, not merely accepts it', () => {
    /*
     * Bounded to the `traverseRecallSeeds` CALL, and that is the whole assertion.
     *
     * The first version searched the function body for the word `narrowing` and SURVIVED the mutant that
     * removes it from the call while leaving `narrowing?: TraverseNarrowing` in the signature — a parameter
     * accepted and dropped, which is precisely the defect this file exists to catch, passing its own gate.
     */
    const body = bodyOf(SPILL, 'buildGraphWithSpill');
    const callAt = body.indexOf('traverseRecallSeeds(');
    assert.ok(callAt > -1, 'buildGraphWithSpill no longer calls traverseRecallSeeds — re-anchor this gate');
    const args = balancedFrom(body, body.indexOf('(', callAt), 'the traverseRecallSeeds call');
    assert.match(args, /narrowing/,
      'buildGraphWithSpill accepts the narrowing and does not pass it on, so it never reaches the query');
  });

  it('every recall-side expansion passes it, at every site that still has one', () => {
    /*
     * Counted rather than spot-checked, because the failure mode is one call site left un-threaded — which
     * looks identical to the others in review and silently ignores the caller's narrowing on exactly one
     * path.
     *
     * The count is DERIVED. It was `2` per door — recall and find_similar — and `POST /api/brain/recall`
     * then collapsed onto `callTool`, so REST builds one response instead of two and expands one graph
     * instead of two. Writing `1` would make the same mistake with a later expiry date; the honest number
     * is *how many routes on this door still build a response of their own*.
     */
    for (const [name, src] of [['REST', REST], ['MCP', MCP]]) {
      const expected = name === 'MCP' ? 2 : ['/recall', '/similar']
        .filter(p => { const b = routeBody(src, p); return b && !delegatesCleanly(b, `POST ${p}`); }).length;
      const calls = [...src.matchAll(/buildGraphWithSpill\(/g)];
      assert.equal(calls.length, expected,
        `${name} should have ${expected} expansion call site(s), found ${calls.length}`);
      for (const m of calls) {
        const args = balancedFrom(src, src.indexOf('(', m.index), `${name} buildGraphWithSpill`);
        assert.match(args, /TraverseOpt|traverseOpt/,
          `${name} has an expansion that does not pass the narrowing: ${args.slice(0, 120)}`);
      }
    }
  });
});

describe('the response says what was actually walked', () => {
  it('every surface that builds a response echoes the traverse it applied', () => {
    /*
     * A narrowing the response does not mention is one the caller cannot verify was applied — and the whole
     * point of the parameter is that the caller stops having to trust an unnarrowed walk.
     *
     * Asserted on whichever surface BUILDS RECALL's response rather than on REST by name.
     * `POST /api/brain/recall` delegates now, so the echo a REST caller reads is the tool's — and demanding
     * `echoTraverse` in the REST file would be demanding that the duplicate come back.
     *
     * RECALL's, specifically: `similar` reports `traverseDepth` on both doors and never used this helper,
     * so a check written as "every response-builder echoes" fails on a route that was never in scope. That
     * was the first draft of this case, and it read as a finding.
     */
    const restBuild = routeBody(REST, '/recall');
    if (restBuild && !delegatesCleanly(restBuild, 'POST /recall')) {
      assert.match(REST, /traverse: echoTraverse\(/,
        'the REST recall builds its own response and does not echo the traverse');
    }
    assert.match(MCP, /traverse: echoTraverse\(/,
      'the response does not echo the traverse, so a caller cannot confirm their narrowing took effect');
  });

  it('the echo stays a NUMBER when nothing was narrowed, and an OBJECT when anything was', async () => {
    /*
     * Otherwise every existing caller's assertion on `traverse` changes shape for no behavioural reason.
     *
     * EXERCISED, not read. This asserted the literal `edgeLabels === undefined` and so pinned one SPELLING of
     * the rule: when the three link flags arrived the check became "no narrowing key is set", derived from
     * `TRAVERSE_OPTION_FIELDS`, and the gate went red against code that was more correct than what it wanted.
     * A hand-named pair is also exactly how the echo would have gone on reporting `traverse: 2` for a call
     * that asked for chrono.
     */
    const { echoTraverse } = await import('../../server/dist/brain/traverse-option.js');
    assert.equal(echoTraverse({ depth: 2 }), 2, 'a plain depth must echo as the number it was sent as');
    for (const narrowing of [
      { edgeLabels: ['owns'] }, { direction: 'outbound' },
      { includeChrono: true }, { includeMemories: true }, { includeFiles: true },
    ]) {
      const [key] = Object.keys(narrowing);
      assert.equal(typeof echoTraverse({ depth: 2, ...narrowing }), 'object',
        `${key} was applied and the echo still reported a bare depth, describing a walk that did not happen`);
    }
  });
});
