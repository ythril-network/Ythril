/**
 * Every budgeted MCP tool takes its size and paging parameters from one schema (`Q-161`).
 *
 * `recall`, `similar`, `filter` and `read_spill` each spelled out `maxChars`, `maxBytes`, `maxTokens` (and the paging
 * pair) in their own `inputSchema`, four copies of one contract that all resolve through `brain/result-budget.ts`.
 * They had drifted from it and from each other: `read_spill` accepted `maxChars: 1` where the others refused anything
 * under 1000, `recall` said `maxTokens` converts onto `maxBytes` (it converts onto characters), and every copy refused
 * a `maxBytes` under 1000 that the resolver deliberately honours.
 *
 * The set of tools is DERIVED — every tool module whose handler calls `resolveBudget` — so a fifth budgeted tool is
 * checked on the commit that adds it.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-budgeted-tool-takes-its-size-parameters-from-one-schema.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { budgetSizeSchema, pageBudgetSchema } = await import('../../server/dist/mcp/tools/_page-budget-schema.js');
const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
const { MIN_MAX_BYTES, MAX_MAX_BYTES } = await import('../../server/dist/brain/result-budget.js');
const { toolSchemasFor, materialisedSchema } = await import('../../server/dist/mcp/tool-schema.js');

const SIZE = ['maxChars', 'maxBytes', 'maxTokens'];
const src = f => stripComments(readFileSync(`${REPO_ROOT}/${f}`, 'utf8'));

/** Tool modules whose handlers resolve a byte budget — the subject, derived. */
const budgeted = trackedSources(['server/src/mcp/tools'], { floor: 10, exclude: ['server/src/mcp/tools/_page-budget-schema.ts'] })
  .filter(f => /resolveBudget\(|readSpillAct\(/.test(src(f)));

/** Every tool's advertised properties, as `tools/list` would show them. */
function propertiesOf(tool) {
  return materialisedSchema(tool, toolSchemasFor(['a', 'b']), ['a', 'b']).properties ?? {};
}

describe('a budgeted tool takes its size parameters from one schema', () => {
  it('the scan found the budgeted tool modules', () => {
    assert.ok(budgeted.length >= 3, `only ${budgeted.length} budgeted tool module(s) found — the scan is broken: ${budgeted.join(', ')}`);
  });

  it('no budgeted tool module spells out a size parameter itself', () => {
    const offenders = budgeted.filter(f => /\bmax(Chars|Bytes|Tokens): \{/.test(src(f)));
    assert.deepEqual(offenders, [], `these spell out maxChars/maxBytes/maxTokens instead of taking them from _page-budget-schema.ts: ${offenders.join(', ')}`);
  });

  it('every budgeted tool advertises exactly the module\'s size parameters', () => {
    const expected = budgetSizeSchema('row');
    const names = ['recall', 'similar', 'filter', 'read_spill', 'graph_traverse'];
    for (const name of names) {
      const tool = TOOLS_BY_NAME.get(name);
      assert.ok(tool, `${name} is not a registered tool`);
      const props = propertiesOf(tool);
      for (const k of SIZE) {
        assert.ok(props[k], `${name} does not take ${k}`);
        const { description: _d, ...shape } = props[k];
        const { description: _e, ...want } = expected[k];
        assert.deepEqual(shape, want, `${name}.${k} is not the module's schema`);
      }
    }
  });

  it('the schema\'s floors are the resolver\'s, so a door never refuses what the rule accepts', () => {
    const s = budgetSizeSchema('row');
    // maxChars below the floor is RAISED to it by the resolver, not refused; maxBytes has no floor at all.
    assert.equal(s.maxChars.minimum, 1, 'a maxChars under the floor is raised by resolveBudget, so the schema must not refuse it');
    assert.equal(s.maxBytes.minimum, 1, 'resolveBudget honours any positive maxBytes — "a caller who states 500 bytes has a reason"');
    assert.equal(s.maxTokens.minimum, 1);
    assert.match(s.maxChars.description, new RegExp(String(MIN_MAX_BYTES)), 'the description names the floor it is raised to');
    assert.match(s.maxChars.description, new RegExp(String(MAX_MAX_BYTES)), 'and the ceiling');
  });

  it('the paging schema is the size schema plus skip and remainderDump, never a second copy', () => {
    const p = pageBudgetSchema('match');
    assert.deepEqual(Object.keys(p).sort(), ['maxBytes', 'maxChars', 'maxTokens', 'remainderDump', 'skip']);
    for (const k of SIZE) assert.deepEqual(p[k], budgetSizeSchema('match')[k]);
  });
});
