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

  /**
   * What a caller reads about the FIRST unit when it sets a ceiling below it (bundle-231, Q-450): `maxChars` says "whole rows only", and the
   * first one is nevertheless admitted whole above the ceiling (or the item could never be read) - except `read_file`, whose window SPLITS a
   * first paragraph at the ceiling. Two engines, two truths, one description per tool that has to say which.
   *
   * The set is derived (every registered tool that advertises `maxChars`), the engine each tool pages with is read off its own schema (a tool
   * with a `markdownSkip` windows a document; every other pages rows through `applyBudget`), and the engine's behaviour is MEASURED with an item
   * past the 1000-character floor, so a description is held to what the code does and not to what another description says.
   */
  const WHOLE_SENTENCE = /the first [^.`]+ is returned whole even above the ceiling, with `truncated: true`/;
  const SPLIT_SENTENCE = /the first paragraph is split at the ceiling/;
  const maxCharsTools = () => [...TOOLS_BY_NAME.entries()]
    .map(([name, tool]) => ({ name, props: propertiesOf(tool) }))
    .filter(t => t.props.maxChars);

  it('the tools that advertise maxChars were found, and none is outside the budgeted set the scan derived', () => {
    const found = maxCharsTools().map(t => t.name);
    assert.ok(found.length >= 7, `only ${found.length} tool(s) advertise maxChars: ${found.join(', ')}`);
    for (const name of ['recall', 'similar', 'filter', 'read_spill', 'graph_traverse', 'schema_validate', 'read_file']) {
      assert.ok(found.includes(name), `${name} no longer advertises maxChars: ${found.join(', ')}`);
    }
  });

  it('the two engines do what the descriptions must say: rows admit the first whole, the document window splits', async () => {
    const { applyBudget, resolveBudget } = await import('../../server/dist/brain/result-budget.js');
    const { markdownWindow } = await import('../../server/dist/files/markdown-window.js');
    const big = 'x'.repeat(5000);
    const rows = applyBudget([{ text: big }, { text: 'second' }], resolveBudget({ maxChars: 1000 }));
    assert.equal(rows.returned.length, 1, 'fixture check: the first row is admitted');
    assert.ok(JSON.stringify(rows.returned[0]).length > 1000, 'the first row is returned whole even though it is over the 1000-character ceiling');
    assert.equal(rows.truncated, true, 'and the answer says it was truncated (the rest is behind it)');
    const win = markdownWindow(big, 0, 1000);
    assert.ok(win.markdown.length <= 1000, `the document window returned ${win.markdown.length} characters for a 1000 ceiling: the first paragraph is split`);
    assert.equal(win.truncated, true);
  });

  it('every tool\'s maxChars description declares its first-unit behaviour, and it is the behaviour of the engine the tool pages with', () => {
    const wrong = [];
    for (const { name, props } of maxCharsTools()) {
      const description = String(props.maxChars.description);
      const windows = Boolean(props.markdownSkip);
      const want = windows ? SPLIT_SENTENCE : WHOLE_SENTENCE;
      const other = windows ? WHOLE_SENTENCE : SPLIT_SENTENCE;
      if (!want.test(description)) wrong.push(`${name}: maxChars does not say ${windows ? 'that the first paragraph is split at the ceiling' : 'that the first item is returned whole even above the ceiling, with `truncated: true`'} (${description.slice(0, 160)}...)`);
      if (other.test(description)) wrong.push(`${name}: maxChars states the OTHER engine's first-unit behaviour`);
    }
    assert.deepEqual(wrong, [], `a size ceiling that does not say what happens to the unit that is itself over it:\n  ${wrong.join('\n  ')}`);
  });

  it('a tool\'s maxChars description names the continuation its own answer carries, not another tool\'s', () => {
    const wrong = [];
    for (const { name, props } of maxCharsTools()) {
      const description = String(props.maxChars.description);
      const names = [...description.matchAll(/`(nextSkip|markdownNextSkip|nextAfter)`/g)].map(m => m[1]);
      if (props.markdownSkip && !names.includes('markdownNextSkip')) wrong.push(`${name}: pages a document by markdownNextSkip but its maxChars names ${names.join(', ') || 'no continuation'}`);
      if (props.markdownSkip && names.includes('nextSkip')) wrong.push(`${name}: its maxChars names \`nextSkip\`, which its answer does not carry`);
      if (!props.markdownSkip && names.length === 0) wrong.push(`${name}: its maxChars names no continuation`);
    }
    assert.deepEqual(wrong, [], wrong.join('\n  '));
  });

  it('the paging schema is the size schema plus skip and remainderDump, never a second copy', () => {
    const p = pageBudgetSchema('match');
    assert.deepEqual(Object.keys(p).sort(), ['maxBytes', 'maxChars', 'maxTokens', 'remainderDump', 'skip']);
    for (const k of SIZE) assert.deepEqual(p[k], budgetSizeSchema('match')[k]);
  });

  it('a unit is pluralised as English does it: "matches", never "matchs" (bundle-231 drive read "whole matchs only")', () => {
    const wrong = [];
    for (const { name, props } of maxCharsTools()) {
      for (const k of ['maxChars', 'skip', 'remainderDump']) {
        const text = String(props[k]?.description ?? '');
        for (const m of text.matchAll(/\b\w*(?:ch|sh|x|ss)s\b/g)) wrong.push(`${name}.${k}: "${m[0]}"`);
      }
    }
    assert.deepEqual(wrong, [], wrong.join('\n  '));
    assert.match(String(budgetSizeSchema('match').maxChars.description), /whole matches only/);
  });
});
