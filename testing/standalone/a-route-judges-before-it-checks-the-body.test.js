/**
 * Every brain write route resolves its target, THEN judges an unknown field, THEN checks the body (Q-320, bundle-128, design-v3
 * section 3 and 8.2 G2).
 *
 * ## The rule
 *
 * Design-v3 3: the order on both doors is space existence, target resolution, the unknown-key judge, every other body check,
 * the writer. `If-Match` (and a file route's `path` query) is a transport or addressing precondition and stays ahead of the
 * judge; nothing that reads the BODY may. So a refusal for another reason (a missing required field, the "at least one" refusal,
 * a malformed id) still names the unknown fields, because the judge has already run, and an unknown field is judged against the
 * setting of the space the write actually lands in, because the target is already resolved.
 *
 * ## What is derived and what the failure looks like
 *
 * The subjects are the routes of `BRAIN_WRITE_PAIRS` minus bulk (whose body is judged per item inside the batch writer, where
 * the second case reads the module it takes the accepted set from). For each route, by SOURCE ORDER in the comment-stripped
 * handler:
 *   1. the judge call exists exactly once;
 *   2. the target resolution (`resolveWriteTarget(`; for a merge, which refuses a proxy instead, the `isProxySpace(` refusal)
 *      comes first;
 *   3. no read of the request body — a destructure, a helper handed the body — precedes the judge;
 *   4. no refusal precedes the judge except space-not-found, the target's own, an `If-Match` one, a file route's `path`
 *      addressing and a merge's proxy refusal. A merge's UUID checks on its PATH ids are addressing checks and follow the judge
 *      (the merge reorder, a CHANGELOG row).
 *
 * Seen red on the unchanged base: no route calls the judge at all (`answerUnknownWriteFields`, the plan's name), and a merge
 * answers its UUID 400s ahead of everything. The controls (synthetic handlers) prove each clause can fail, and pass on the base.
 *
 * Run: node --test testing/standalone/a-route-judges-before-it-checks-the-body.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { RECORD_PAIRS, restHandlerOf, readsOf } from './_brain-write-pairs.mjs';

const JUDGE = 'answerUnknownWriteFields';

/** The text of the statement that opens at `at`, up to the `;` that ends it. */
const statementAt = (src, at) => src.slice(at, src.indexOf(';', at) + 1);

/** A refusal that may legitimately precede the judge: it is about the space, the target, a transport header or addressing. */
const MAY_PRECEDE_THE_JUDGE = /not found|wt\.error|ifMatch\.error|If-Match|`path` query|proxy/i;

/** The ways this handler's order breaks the rule, as sentences; empty when it holds. */
function orderProblems(source, { merge = false } = {}) {
  const out = [];
  const calls = [...source.matchAll(new RegExp(`\\b${JUDGE}\\(`, 'g'))].map(m => m.index);
  if (calls.length !== 1) return [`the handler calls ${JUDGE}() ${calls.length} times, not once`];
  const judge = calls[0];
  const targetAt = (merge ? source.indexOf('isProxySpace(') : source.indexOf('resolveWriteTarget('));
  if (targetAt === -1) out.push(`the handler never resolves its target (${merge ? 'isProxySpace(' : 'resolveWriteTarget('})`);
  else if (targetAt > judge) out.push('the judge runs before the target is resolved, so it would read the wrong space\'s setting');
  // Every read of the body other than the judge's own argument.
  const before = source.slice(0, judge);
  const read = readsOf(before, 'req.body');
  const reads = [...read.keys, ...read.handed.map(h => `${h.callee}(…)`), ...read.problems];
  if (reads.length) out.push(`the body is read before the judge: ${reads.join(', ')}`);
  for (const m of before.matchAll(/res\s*\.\s*status\(\s*(\d{3})/g)) {
    const stmt = statementAt(before, m.index);
    // The refusal's own words may sit in the line above its `res.status` (an `if` condition naming the check); the window is
    // the statement and the condition that guards it.
    const guard = before.slice(Math.max(0, before.lastIndexOf('if (', m.index)), m.index);
    if (!MAY_PRECEDE_THE_JUDGE.test(stmt) && !MAY_PRECEDE_THE_JUDGE.test(guard)) {
      out.push(`a ${m[1]} is answered before the judge: ${stmt.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  return out;
}

describe('the instrument: each clause of the order can fail', () => {
  // CONTROLS. They pass on the unchanged base by design: they show the rule is not satisfiable by a handler that breaks it.
  const GOOD = `
    const wt = resolveWriteTarget(spaceId, req.query['targetSpace']);
    if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
    answerUnknownWriteFields(req.body, 'fact.create', wt.target, 'rest', res);
    const { fact } = req.body ?? {};
    if (!fact) { res.status(400).json({ error: 'fact required' }); return; }
  `;
  it('a handler in the right order has no problem', () => assert.deepEqual(orderProblems(GOOD), []));
  it('the judge below a body check fails', () => {
    const bad = GOOD.replace(/\n    answerUnknownWriteFields[^\n]*/, '') + '\n    answerUnknownWriteFields(req.body, \'x\', wt.target, \'rest\', res);';
    assert.match(orderProblems(bad).join('|'), /body is read before the judge/);
  });
  it('the judge before the target fails', () => {
    const bad = GOOD.split('\n').filter(l => l.includes('answerUnknown')).join('\n') + GOOD.split('\n').filter(l => !l.includes('answerUnknown')).join('\n');
    assert.match(orderProblems(bad).join('|'), /before the target is resolved/);
  });
  it('a refusal about the body ahead of the judge fails, and a handler with no judge fails', () => {
    assert.match(orderProblems(`const wt = resolveWriteTarget(a); if (!ok) { res.status(400).json({ error: 'bad id' }); return; } ${JUDGE}(x);`).join('|'), /answered before the judge/);
    assert.match(orderProblems('const wt = resolveWriteTarget(a);').join('|'), /0 times/);
  });
});

describe('every brain write route resolves its target, judges, then checks the body', () => {
  for (const pair of RECORD_PAIRS) {
    it(`${pair.method} ${pair.route}`, () => {
      const { source } = restHandlerOf(pair);
      assert.deepEqual(orderProblems(source, { merge: pair.op === 'entity.merge' }), []);
    });
  }

  it('the pairs were found (a floor: an empty list passes every loop)', () => {
    assert.ok(RECORD_PAIRS.length >= 10, `only ${RECORD_PAIRS.length} record pairs`);
  });
});

describe('the other two judging sites keep the same order', () => {
  it('the MCP dispatcher resolves the target and judges BEFORE it validates the arguments', () => {
    const src = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
    const judge = src.indexOf(`${JUDGE}(`);
    assert.ok(judge > -1, `callTool never calls ${JUDGE}(), so an unknown argument is still refused by the strict validator`);
    const ajv = src.search(/\.validate\(\s*tool|validatorFor\(/);
    assert.ok(ajv > -1, 'could not find the validator call in callTool — re-anchor this gate');
    assert.ok(judge < ajv, 'the judge runs after the strict argument validation, which would refuse the unknown argument first');
  });

  it('the bulk writer takes its item key set from the shared judge module', () => {
    const src = stripComments(readFileSync('server/src/brain/bulk.ts', 'utf8'));
    assert.match(src, /from '\.\.\/contract\/write-accepts\.js'/,
      'brain/bulk.ts does not import contract/write-accepts, so its items are judged against some other list');
  });
});