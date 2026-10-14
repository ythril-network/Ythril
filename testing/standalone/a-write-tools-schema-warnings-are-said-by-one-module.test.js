/**
 * What a record write's MCP answer says about the schema violations it did not refuse is said by one module,
 * `mcp/schema-warnings.ts` — the text lines and the structured `warnings` field together (bundle-23 wave 0, extraction 4).
 *
 * ## The defect it prevents
 *
 * `save_entity`, `save_fact`, `save_edge` and `save_chrono` each wrote `⚠️ Schema: <field> — <reason>` behind their own
 * `validationMode === 'warn'` test, and each answered structurally its own way: edge as `violations` (the refusal key, on a
 * success, and filled even with validation off), the other three with nothing — while every REST twin answers `warnings`.
 * One rule four times with four answers, and bundle-23 was about to add a fifth.
 *
 * ## What it holds
 *
 * - The module's answer per mode: `warn` says one line per violation in the exact words the four copies used and puts the
 *   writer's `warnings` in the structured field; a `strict` write that went through (violations already stored) says no
 *   line and still reports them structurally; `off` says nothing either way.
 * - The structured key is the REST twin's: every REST record create route under `api/brain` puts its warnings under
 *   `warnings` (derived from the routes that read a classification's `warnings`, with a floor), and so does the module.
 * - Every MCP tool file that captures a writer's classification (`let …: UpdateValidation | undefined`) asks the module,
 *   and no other server source writes the `Schema: ${…}` sentence (comments stripped).
 *
 * ## Seen red
 *
 * By hand: the old `for (const v of edgeSchemaViolations) edgeMsg += \`\n⚠️ Schema: ${v.field} — ${v.reason}\`;` put back
 * into `mcp/tools/edge.ts` in place of the module's lines, run, red naming that file twice (a copy of the sentence, and a
 * capturing tool that no longer asks); removed by hand, green.
 *
 * Run: node --test testing/standalone/a-write-tools-schema-warnings-are-said-by-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/mcp/schema-warnings.ts';
const V1 = { field: 'properties.age', value: 11, reason: 'must be <= 10' };
const V2 = { field: 'properties.extra', value: 'x', reason: "property 'extra' is not declared on this type" };

describe('the module answers per mode', () => {
  const check = (all, warnings) => ({ blocked: false, introduced: [], preExisting: all, all, warnings, message: '' });

  it('warn: one line per violation in the words the four tools used, and the structured warnings', async () => {
    const { schemaWarningAnswer } = await import('../../server/dist/mcp/schema-warnings.js');
    const out = schemaWarningAnswer({ validationMode: 'warn' }, check([V1, V2], [V1, V2]));
    assert.deepEqual(out.lines, [
      '⚠️ Schema: properties.age — must be <= 10',
      "⚠️ Schema: properties.extra — property 'extra' is not declared on this type",
    ]);
    assert.deepEqual(out.structured, { warnings: [V1, V2] });
  });

  it('strict, a write that went through over stored violations: no line (as before), reported structurally', async () => {
    const { schemaWarningAnswer } = await import('../../server/dist/mcp/schema-warnings.js');
    const out = schemaWarningAnswer({ validationMode: 'strict' }, check([V1], [V1]));
    assert.deepEqual(out.lines, []);
    assert.deepEqual(out.structured, { warnings: [V1] });
  });

  it('off, no meta, no classification, nothing found: nothing said either way', async () => {
    const { schemaWarningAnswer } = await import('../../server/dist/mcp/schema-warnings.js');
    for (const [meta, c] of [[{ validationMode: 'off' }, check([V1], [])], [undefined, check([V1], [])],
      [{ validationMode: 'warn' }, undefined], [{ validationMode: 'warn' }, check([], [])]]) {
      const out = schemaWarningAnswer(meta, c);
      assert.deepEqual(out, { lines: [], structured: {} }, JSON.stringify({ meta, c }));
    }
  });
});

describe('every write tool says its schema warnings through the module', () => {
  const sources = readTrackedSources('server/src', { untracked: true })
    .map(({ file, text }) => ({ file, code: stripComments(text) }));
  const CAPTURES = /\blet\s+\w+\s*:\s*UpdateValidation\s*\|\s*undefined\b/;
  const SENTENCE = /Schema:\s*\$\{/;

  it('reads a tree worth reading, and finds the tools and routes it is about (the floors)', () => {
    assert.ok(sources.length >= 300, `only ${sources.length} server sources were read`);
    const tools = sources.filter(s => s.file.startsWith('server/src/mcp/') && CAPTURES.test(s.code));
    assert.ok(tools.length >= 4, `only ${tools.length} MCP tool file(s) capture a classification: ${tools.map(t => t.file).join(', ')}`);
  });

  it('the structured key is the REST twin\'s', () => {
    const routes = sources.filter(s => s.file.startsWith('server/src/api/brain/') && /\bcheck\??\.warnings\b|Check\??\.warnings\b/.test(s.code));
    assert.ok(routes.length >= 4, `only ${routes.length} REST record route file(s) read a classification's warnings`);
    const offKey = routes.filter(r => !/\[\s*'warnings'\s*\]\s*=|\bwarnings\s*:\s*\w*[wW]arnings\b|\{\s*\.\.\.updated,\s*warnings\s*\}/.test(r.code)).map(r => r.file);
    assert.deepEqual(offKey, [], `REST route(s) answer their warnings under another key than \`warnings\`, which the MCP module uses`);
    const mod = sources.find(s => s.file === MODULE);
    assert.ok(mod && /\{\s*warnings\s*\}/.test(mod.code), `${MODULE} no longer answers \`{ warnings }\``);
  });

  it('every tool that captures a classification asks the module', () => {
    const silent = sources.filter(s => s.file.startsWith('server/src/mcp/') && CAPTURES.test(s.code) && !/\bschemaWarningAnswer\s*\(/.test(s.code))
      .map(s => s.file);
    assert.deepEqual(silent, [], `MCP tool(s) capture the writer's classification and do not say it through ${MODULE}`);
  });

  it('no other server source writes the schema-warning sentence', () => {
    const copies = sources.filter(s => s.file !== MODULE && SENTENCE.test(s.code)).map(s => s.file);
    assert.deepEqual(copies, [], `a second copy of the schema-warning sentence — use schemaWarningAnswer (${MODULE}):\n  ${copies.join('\n  ')}`);
  });
});
