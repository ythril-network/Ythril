/**
 * No `return` in `callTool` after the unknown-field judge bypasses `withUnknownFieldRows` (Q-320, bundle-128, design-v3 section 4
 * step 4 and 8.2 G5).
 *
 * ## The rule, and why it is a source gate
 *
 * Design-v3 4: every answer to a judged MCP call names the unknown fields, whatever else happened: success, an Ajv refusal, a
 * handler error, every 4xx catch arm, the `ConnectionsNotWritten` arm. It is true because `callTool` ends in ONE exit
 * (`const outcome = await …; return withUnknownFieldRows(outcome, rows)`), and it stops being true the day someone adds a
 * `return` to a new catch arm: that arm answers without the rows and nothing fails, because the other arms still do. The
 * bundle-23 version of the same defect is recorded in the repo's own words as "the weaker one wins silently".
 *
 * So the gate reads the function: every `return` that comes AFTER the judge call is a `return withUnknownFieldRows(…)`, with one
 * reasoned exception — the store-failure arm, which leaves out the rows on purpose (nothing was stored and the cause is a 5xx,
 * `answerLeftARecord` is the predicate: design-v3 4 and 2a). That arm is recognised by what it returns (`storeFailure`), not by
 * its position, so a second arm cannot hide behind it.
 *
 * Seen red on the unchanged base: `callTool` calls no judge and no `withUnknownFieldRows`, so the first two cases fail. The
 * controls show the third rule firing on a synthetic bare `return`, and pass on the base.
 *
 * Run: node --test testing/standalone/every-callTool-exit-after-the-judge-carries-the-unknown-field-rows.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, bodyOfEndingWith, statementFrom } from './_structural-window.mjs';
import { maskStrings } from './_brain-write-pairs.mjs';

const JUDGE = 'answerUnknownWriteFields';
const WRAP = 'withUnknownFieldRows';

/** The returns after the judge that do not go through the wrapper and are not the store-failure arm. */
function bypasses(fnSource) {
  const masked = maskStrings(fnSource);
  const judgeAt = masked.search(new RegExp(`\\b${JUDGE}\\(`));
  if (judgeAt === -1) return { judge: false, returns: 0, bare: [] };
  const after = fnSource.slice(judgeAt);
  const maskedAfter = masked.slice(judgeAt);
  const bare = [];
  let returns = 0;
  for (const m of maskedAfter.matchAll(/\breturn\b/g)) {
    const stmt = statementFrom(after, m.index, 'a return after the judge').replace(/\s+/g, ' ');
    returns++;
    const body = stmt.replace(/^return\s*/, '');
    if (body.startsWith(`${WRAP}(`)) continue;
    if (/\bstoreFailure\b/.test(stmt)) continue;
    bare.push(stmt.slice(0, 120));
  }
  return { judge: true, returns, bare };
}

describe('the instrument: a bare return after the judge is found', () => {
  // CONTROLS (pass on the unchanged base by design).
  it('finds a return that skips the wrapper, accepts the wrapper, and accepts the store-failure arm', () => {
    const fn = `{ ${JUDGE}(a); try { return ${WRAP}(await run(), rows); } catch (e) { return { result: r, status: 400 }; } }`;
    assert.equal(bypasses(fn).bare.length, 1);
    const ok = `{ ${JUDGE}(a); return ${WRAP}(out, rows); }`;
    assert.deepEqual(bypasses(ok).bare, []);
    const store = `{ ${JUDGE}(a); if (s) { return { status: s.status, storeFailure: s }; } return ${WRAP}(out, rows); }`;
    assert.deepEqual(bypasses(store).bare, []);
  });

  it('does not count a return that is only a word in a string', () => {
    assert.equal(bypasses(`{ ${JUDGE}(a); const m = 'return soon'; return ${WRAP}(o, r); }`).bare.length, 0);
  });
});

describe('callTool answers every outcome of a judged call through withUnknownFieldRows', () => {
  const src = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
  // `callTool` is the wrapper that releases a peer's admission in a `finally`; the judge and every exit after it are in the body it hands the call to.
  const fn = bodyOfEndingWith(src, 'dispatchTool', 'status: 400, callSpace', 'the callTool dispatch');

  it('callTool answers what the dispatch answers, unchanged, so the exits judged below are the exits of the call', () => {
    assert.match(bodyOf(src, 'callTool', 'callTool'), /return\s+await\s+dispatchTool\(/, 'callTool no longer returns the dispatch\'s answer as it is');
  });

  it('callTool calls the judge, and routes at least one exit through the wrapper (a floor: no judge means nothing to check)', () => {
    const r = bypasses(fn);
    assert.equal(r.judge, true, `callTool never calls ${JUDGE}(), so an unknown argument is not judged on this door`);
    assert.ok(new RegExp(`\\breturn\\s+${WRAP}\\(`).test(fn.slice(fn.search(new RegExp(`\\b${JUDGE}\\(`)))),
      `callTool never returns ${WRAP}(…) after the judge: the rows are not carried on any exit`);
  });

  it('no return after the judge bypasses the wrapper, except the store-failure arm', () => {
    const r = bypasses(fn);
    assert.equal(r.judge, true, `callTool never calls ${JUDGE}()`);
    assert.deepEqual(r.bare, [], 'these exits answer a judged call without naming its unknown fields');
  });

  it('the wrapper is imported from, or declared in, the dispatcher\'s own module graph (it is not a name nothing defines)', () => {
    assert.match(src, new RegExp(`\\b${WRAP}\\b`), `${WRAP} is not mentioned in call-tool.ts at all`);
  });
});