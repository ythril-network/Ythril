/**
 * The lower MCP byte budget belongs to the TRANSPORT that received the call — never to the module that
 * answers it.
 *
 * ## The defect, which shipped and was invisible from inside
 *
 * `CLAUDE.md` sanctions exactly one default that differs between the doors: an answer is trimmed to 25 000
 * characters on MCP and 50 000 on REST, because *an agent pays for every byte in its own context while a
 * REST caller does not*. That is a fact about who is reading, and it was implemented as a fact about which
 * FILE was running — `server/src/mcp/tools/*.ts` named `MCP_DEFAULT_MAX_CHARS` at each `resolveBudget` call
 * because MCP was the only door those modules had.
 *
 * Then `B-9` gave every tool a second door: `POST /api/<tool-name>`, plain HTTP, the same modules. A curl
 * caller's default silently halved depending on which URL they typed —
 *
 *     POST /api/brain/recall   ->  budgetChars 50000
 *     POST /api/recall         ->  budgetChars 25000
 *
 * — same server, same capability, same parameters, and nothing in either response saying why. The exception
 * had migrated onto the wrong axis, which is how a sanctioned divergence turns into the defect this repo
 * produces most: one rule, two implementations, and the weaker one wins for whoever guessed the other path.
 *
 * ## Why this asserts the RULE and not the three sites
 *
 * Naming the three `resolveBudget` calls in `search.ts` would pass for ever and say nothing about the fourth
 * tool module somebody writes next year — which will be written by copying one of these three. The rule that
 * survives that is: **`MCP_DEFAULT_MAX_CHARS` has exactly one reader, and it is the function that asks which
 * door this is.** A module that names the constant has made the choice itself, in a file that cannot see
 * the answer.
 *
 * The floor matters as much as the sweep: an empty file list passes every loop written over it, so a broken
 * pathspec would report clean about a rule nobody had checked.
 *
 * Run: node --test testing/standalone/the-byte-budget-follows-the-door-not-the-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

/**
 * The module that OWNS the two constants and the choice between them. Everything else is a caller.
 *
 * An exact repo-relative path, because `trackedSources`'s `exclude` is `Array.includes` and not a regex —
 * a pattern here matches nothing and the owner sweeps itself.
 */
const OWNER = 'server/src/brain/result-budget.ts';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/**
 * Every tracked server source except the owner — derived, because the point is the file nobody has written
 * yet. `git ls-files` through `trackedSources` so a path with a space is not silently dropped and an empty
 * result throws instead of passing.
 */
function callers() {
  return trackedSources(['server/src'], { exclude: [OWNER] });
}

describe('the door decides the budget default, and it decides it once', () => {
  const files = callers();

  it('found the sources to sweep', () => {
    assert.ok(files.length >= 100, `only ${files.length} server sources found — the sweep is broken, not clean`);
  });

  it('no module outside result-budget.ts names the MCP default', () => {
    /*
     * The whole gate. `defaultBudgetChars(transport)` is the one reader, and `ToolCaller.transport` is the
     * one thing that knows which door took the call — so a tool module has no business naming either
     * constant. It does not have the fact the choice depends on.
     */
    const offenders = files.filter(f => /MCP_DEFAULT_MAX_CHARS/.test(src(f)));
    assert.deepEqual(offenders, [],
      'these choose the MCP byte budget themselves instead of asking which door called: '
      + `${offenders.join(', ')} — pass defaultBudgetChars(ctx.transport) to resolveBudget`);
  });

  it('nor the REST one, which is the same mistake in the other direction', () => {
    // A module hard-coding 50 000 would hand an agent a REST-sized answer over MCP: the same defect with the
    // sign flipped, and the one that costs an agent its context rather than costing a script a page.
    const offenders = files.filter(f => /\bDEFAULT_MAX_CHARS\b/.test(src(f).replace(/MCP_DEFAULT_MAX_CHARS/g, '')));
    assert.deepEqual(offenders, [],
      `these name the REST byte budget directly: ${offenders.join(', ')}`);
  });

  it('nor slips one past as a bare number in the call', () => {
    /*
     * The way round the two checks above, and the only one worth gating: `resolveBudget(args, 25_000)`.
     *
     * Scoped to the CALL rather than to the numbers, deliberately. A sweep for `25_000` and `50_000`
     * anywhere in the server matches eleven files that have nothing to do with budgets — a request size
     * cap, a bulk chunk size, a description length — and a gate whose failures are mostly false is a gate
     * that gets its assertion deleted rather than its subject fixed.
     */
    const offenders = files.filter(f => /resolveBudget\([^)]*,\s*[0-9]/.test(src(f)));
    assert.deepEqual(offenders, [],
      `these pass a budget default as a bare number: ${offenders.join(', ')}`);
  });
});

describe('the transport reaches the modules that need it', () => {
  it('a tool context carries which door called', () => {
    /*
     * Derived rather than asserted about one file: `defaultBudgetChars` is useless to a tool handler that
     * cannot see the transport, so the type that handlers receive has to carry it. Without this, the gate
     * above is satisfiable by deleting the capability rather than by fixing it.
     */
    const [types] = trackedSources(['server/src/mcp/tools'], { floor: 5 })
      .filter(f => /types\.ts$/.test(f));
    assert.ok(types, 'server/src/mcp/tools/types.ts not found');
    assert.match(src(types), /transport:\s*'mcp'\s*\|\s*'rest'/,
      'ToolContext must carry the calling door, or a handler cannot resolve its own budget default');
  });
});
