/**
 * An MCP tool forwards the arguments its OWN schema declares — never a list written beside it.
 *
 * ## The defect this generalises
 *
 * `schema_update` built its payload from `['typeSchemas', 'validationMode', 'strictLinkage',
 * 'usageNotes', 'suppressEmbeddings']` — five names, sitting next to an `inputSchema` that declared six.
 * `whenDuePasses` was therefore DECLARED on the tool, accepted by the dispatcher, and silently dropped
 * before the write. REST stored it; MCP did not; nothing said so. `CLAUDE.md` names that shape as worse
 * than either door refusing, because the behaviour then depends on which client the caller picked.
 *
 * `save_space` had the same shape and was correct — six of seven, plus one translated name. Correct today
 * is what makes it worth a gate rather than a fix: two lists that must agree, and nothing making them.
 *
 * ## What this asserts
 *
 * Not "those two tools are fixed" — that a THIRD cannot be written. A handler that iterates a literal array
 * of quoted argument names to pick from `args` is the shape, and it is refused wherever it appears.
 *
 * Run: node --test testing/standalone/no-mcp-tool-picks-args-from-a-literal-array.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { blockAfter } from './_structural-window.mjs';

const files = trackedSources(['server/src/mcp/tools'], { floor: 5 });
const src = f => stripComments(readFileSync(f, 'utf8'));

describe('a tool forwards what its own schema declares', () => {
  it('found the tool sources', () => {
    // A floor: an empty scan passes the loop below while looking at nothing.
    assert.ok(files.length >= 10, `only ${files.length} tool sources found — the derivation is wrong`);
  });

  it('no handler picks argument names from a literal array', () => {
    /*
     * The shape: `for (const k of ['a', 'b']) { ... a[k] ... }`. Matched on the LOOP rather than on any
     * array literal, because tool files are full of legitimate string arrays — enums, status vocabularies,
     * the link classes. What is refused is iterating one to read `args`.
     */
    const offenders = [];
    for (const f of files) {
      const s = src(f);
      for (const m of s.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+\[\s*'/g)) {
        /*
         * The loop's own BODY, bounded by its braces — not `slice(at, at + 400)`.
         *
         * The first draft used a character count and `no-magic-windows` refused it, correctly: a loop longer
         * than the window would read as clean, which is the failure mode of every gate that guesses how much
         * of its subject it can see.
         */
        const body = blockAfter(s, m.index, `${f}: the arg loop`);
        if (new RegExp(`\[\s*${m[1]}\s*\]`).test(body)) {
          offenders.push(`${f}: for (const ${m[1]} of ['…']) reading args[${m[1]}]`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'these forward a hand-written list of argument names instead of the schema they publish, so the two '
      + `can disagree and the loser is silent:\n  ${offenders.join('\n  ')}`);
  });

  it('and the tools that had it now read their own schema', () => {
    // The positive half: the shape is gone AND the replacement is the schema, not a differently-spelled list.
    const s = src('server/src/mcp/tools/spaces.ts');
    assert.match(s, /function forwardedArgNames/, 'the shared helper is what both tools should use');
    assert.equal((s.match(/forwardedArgNames\(/g) ?? []).length >= 3, true,
      'declared once and used by both tools — a helper with one caller is a copy with extra steps');
  });
});
