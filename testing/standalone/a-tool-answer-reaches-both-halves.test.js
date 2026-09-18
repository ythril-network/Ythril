/**
 * A tool that SUCCEEDS answers in BOTH halves — `content` and `structuredContent`.
 *
 * ## The report, and why it needed a sweep rather than a fix
 *
 * The canary operator reported it against `query`: the rows were in `content` alone, so a client that
 * surfaces `structuredContent` in preference saw `{"count":15,"total":40}` and not a single row.
 * `filter`'s schema description still carries the incident in its own words.
 *
 * It was answered on the tool they named. **Nothing swept the siblings.** Measured 2026-09-18,
 * thirty-three successful returns across eleven tool files answered with no structured half at all — over
 * MCP `structuredContent` was absent, and over HTTP `data` was `null`, because `api/tools.ts` maps one to
 * the other. `graph_traverse` returned `{"ok":true,"text":"{\"nodes\":[…]}","data":null}` throughout.
 *
 * ## Two classes, and the second is the one a source gate misses
 *
 * The first were returns whose text is `JSON.stringify(x)` — the object existed and was dropped. The
 * second were returns whose text is a SENTENCE with the answer inside it: `save_entity` answered
 * `Entity 'Ada' (person) upserted (ID 9f2…).` and nothing else, so a caller had to pull an id out of
 * English before it could write anything next.
 *
 * **The first version of this gate keyed on `JSON.stringify` and put the second class out of scope** — its
 * docblock said a return whose text is a sentence "has nothing to structure". That was wrong, and the wire
 * test is what said so: `one-call-two-doors`' `graph_traverse` case could not get an id out of
 * `save_entity` to walk from. A source gate cannot see a defect whose whole shape is an absence unless the
 * rule it asserts is about presence.
 *
 * So the rule here is not *"if you serialise, carry it"*. It is **a successful return carries a structured
 * half**, and nothing about the text is consulted at all.
 *
 * ## A gate already claimed this, and could not see it
 *
 * `mcp-structured-content-carries-its-payload.test.js` was written for the same rule and was green
 * throughout. Its subject is every `structuredContent: { … }` literal — so a return carrying none matches
 * nothing and is outside it. It refuses the lesser defect (metadata with no answer) and is blind to the
 * greater one (no answer at all). The pair is the rule; neither half is it.
 *
 * ## Seen red
 *
 * Written against the thirty-three and listing every one by file and line before any was fixed. Re-checked
 * after the fix by removing the structured half from `entity-cascade` and watching it name
 * `entity-cascade.ts:54`.
 *
 * Run: node --test testing/standalone/a-tool-answer-reaches-both-halves.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/**
 * Returns allowed to answer in `content` alone, with the reason each is not this defect.
 *
 * **IT IS EMPTY, and a row added here is a regression rather than a plan** — the same standing this repo
 * gives `REST_ONLY_CAPABILITIES`. It stays because the shape of the escape hatch is what keeps the next
 * author from widening the rule instead: an exemption that does not say why is a hole, since the gate then
 * goes green and the divergence reads as approved.
 *
 * `network_peers` was nearly the first row and it should not have been. Its recorded decision refuses an
 * ENVELOPE — the text half is a bare array a caller indexes, and wrapping it breaks them. That says nothing
 * about a structured half, which must be an object and had never existed, so there was no caller to break.
 * An exemption drawn from a decision about the other half of the same return is how a rule loses its first
 * case.
 */
const CONTENT_ONLY = new Map(Object.entries({}));

/** From the `{` at `open`, the matching close. */
function balanced(s, open) {
  let d = 0;
  for (let j = open; j < s.length; j++) {
    d += (s[j] === '{' ? 1 : 0) - (s[j] === '}' ? 1 : 0);
    if (d === 0) return j;
  }
  throw new Error('unbalanced');
}

/**
 * Every `return { content: [...] }` that is not a refusal, as `{file, line, structured}`.
 *
 * `isError: true` written as a LITERAL is the refusal marker. An `isError` computed from an outcome
 * (`isError: totalErrors > 0`) is NOT one — it is a report that may have gone badly, and it has an answer
 * to carry either way. That distinction is deliberate: reading any `isError` as "refusal" would have
 * excused both of `network_sync`'s returns, which were two of the thirty-three.
 */
function successReturns() {
  const found = [];
  // `server/src/mcp`, not `server/src/mcp/tools` — a handler written one directory up answers the same
  // callers and would be outside a sweep scoped to where the tools happen to live today.
  for (const { file, text } of readTrackedSources('server/src/mcp', { floor: 15, untracked: true })) {
    const src = stripComments(text);
    for (const m of src.matchAll(/return\s*\{/g)) {
      const i = src.indexOf('{', m.index);
      const j = balanced(src, i);
      const blk = src.slice(i, j + 1);
      if (!blk.includes('content:') || !blk.includes('text:')) continue;
      if (/isError:\s*true/.test(blk)) continue;
      found.push({
        file: file.replace(/\\/g, '/').split('/').pop(),
        line: src.slice(0, i).split('\n').length,
        structured: blk.includes('structuredContent'),
      });
    }
  }
  return found;
}

describe('a tool answer reaches both halves', () => {
  it('the sweep finds a real population, so an empty one cannot pass', () => {
    // A regex that stopped matching reports no offenders and looks identical to a clean surface.
    const all = successReturns();
    assert.ok(all.length >= 25,
      `only ${all.length} successful tool returns found — the sweep is broken, not the code`);
    assert.ok(all.some(r => r.structured), 'not one return carries a structured half — the scan is wrong');
  });

  it('every successful return also answers in `structuredContent`', () => {
    const offenders = successReturns()
      .filter(r => !r.structured && !CONTENT_ONLY.has(r.file))
      .map(r => `${r.file}:${r.line}`);
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} tool return(s) succeed and carry nothing in \`structuredContent\`:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + '\n\n      A client that surfaces `structuredContent` gets `null`, and over HTTP so does `data` —'
      + '\n      `api/tools.ts` maps one to the other. It then has to parse prose to recover an answer it'
      + '\n      just asked for. The MCP spec frames the two as the structured and textual forms of the SAME'
      + '\n      result, not as a result and a sidecar. Carry the record the tool wrote, or the identity of'
      + '\n      what it acted on; if it genuinely cannot, add its file to CONTENT_ONLY with the reason.',
    );
  });

  it('every exemption says why, and is a REAL file', () => {
    const files = new Set(successReturns().map(r => r.file));
    for (const [file, why] of CONTENT_ONLY) {
      assert.ok(why.length > 100, `${file} is exempt with no reason worth reading`);
      assert.ok(files.has(file),
        `${file} is exempt and has no successful return any more — delete the exemption rather than `
        + 'leaving it to teach the next reader that answering in one half is fine');
    }
  });
});
