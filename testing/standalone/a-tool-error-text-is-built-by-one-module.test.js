/**
 * The text of a tool's error is built by one module, which owns the leading `Error: `: no other file of the server writes that prefix by
 * hand (`mcp/tool-error-text.ts`, Q-339).
 *
 * ## The finding
 *
 * Forty-odd sites wrote `Error: <sentence>` or `Error (<status>): <sentence>` themselves, in `callTool`, the rights guard and a dozen tool
 * modules, and the one kind of answer that needed it and lacked it (a store failure) was the one nobody wrote. Where a prefix is a
 * convention of every site, a site added next month is the one that forgets it, or spells it `Error -` or `ERROR:`, and an agent that
 * reads the text first (`isError` and the text are all an MCP client sees of a refusal) then meets two grammars for one kind of answer.
 *
 * ## What is derived, and from where
 *
 *  - **The scan**: every tracked `.ts` file of the server's code roots (`SERVER_CODE_ROOTS`), listed by git, with a floor on the count.
 *  - **The literals**: found in the syntax tree, so a comment that explains the prefix neither fails the gate nor satisfies it. A string
 *    literal, a template, or the first operand of a `+` chain, whose text starts with `Error: ` or `Error (`.
 *  - **The rule**: such a literal exists in `mcp/tool-error-text.ts` and nowhere else; and the function it exports is called from at
 *    least {@link FLOOR_CALLS} sites, so a scan that reads the wrong place, or sites that were never moved, cannot pass for nothing.
 *  - **No built text inside a thrown error**: the dispatcher writes the prefix of what a tool throws, so `new Error(toolErrorText(...))`
 *    answers two prefixes. `update_space` did that for its face-width refusal; the line is planted and flagged.
 *
 * ## Proven
 *
 * A planted copy, taken off the module's own line, is flagged in another file with the line of the plant, and is not flagged left in a
 * comment. The module's text is also asked directly: the two spellings come out as the sites wrote them.
 *
 * Run: node --test testing/standalone/a-tool-error-text-is-built-by-one-module.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { parseSource, ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const MODULE = 'server/src/mcp/tool-error-text.ts';
/** The exports of the module a site calls to build a text, and a whole error result. */
const BUILDERS = ['toolErrorText', 'toolErrorResult'];
/** The sites that call a builder: the scan found fewer than this and either it reads the wrong place or the sites were not moved. */
const FLOOR_CALLS = 30;

/** The words a hand-written prefix starts with: `Error: ` and `Error (<status>): ` (the status is a value, so only its opening is fixed). */
const PREFIX = /^Error(?:: | \()/;

/** The text a literal-ish node starts with, or null when it does not start with a literal. */
function leadingText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

/** Every literal of the source that starts with the prefix, as { line, text }; comments are not code and never reach the tree. */
function handWrittenPrefixes(file, source) {
  const sf = parseSource(file, source);
  const found = [];
  walkEveryNode(sf, (n) => {
    const text = leadingText(n);
    if (text === null || !PREFIX.test(text)) return;
    found.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
  });
  return found;
}

/** The calls of a builder in the source. */
function builderCalls(file, source) {
  const sf = parseSource(file, source);
  let n = 0;
  walkEveryNode(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && BUILDERS.includes(node.expression.text)) n += 1;
  });
  return n;
}

/**
 * The lines where a built tool text is handed to a constructor (`new Error(toolErrorText(...))`). A thrown error is answered by the
 * dispatcher, which writes the prefix itself, so a text built before the throw comes out with two (`Error: Error (409): ...`) and with
 * the status of an unknown failure. A refusal with its own status is thrown as a `ToolRefusal(status, sentence)`.
 */
function builtTextsHandedToAConstructor(file, source) {
  const sf = parseSource(file, source);
  const found = [];
  walkEveryNode(sf, (node) => {
    if (!ts.isNewExpression(node)) return;
    const built = (node.arguments ?? []).some(a => ts.isCallExpression(a) && ts.isIdentifier(a.expression) && BUILDERS.includes(a.expression.text));
    if (built) found.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  });
  return found;
}

const files = trackedSources(SERVER_CODE_ROOTS, { floor: 300 });
const sources = new Map(files.map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));

describe('a tool error text is built by one module', () => {
  it('the scan reads the module and finds its own spellings and the sites that call it', () => {
    assert.ok(sources.has(MODULE), `${MODULE} is not among the tracked server sources`);
    const own = handWrittenPrefixes(MODULE, sources.get(MODULE));
    assert.ok(own.length >= 2, `${MODULE} holds ${own.length} prefix literal(s): the module must spell both \`Error: \` and \`Error (<status>): \``);
    const calls = [...sources].reduce((n, [f, s]) => n + (f === MODULE ? 0 : builderCalls(f, s)), 0);
    assert.ok(calls >= FLOOR_CALLS, `only ${calls} call(s) of ${BUILDERS.join(' or ')} (floor ${FLOOR_CALLS}): the sites were not moved onto the module`);
  });

  it('no other file writes the prefix by hand', () => {
    const open = [];
    for (const [f, s] of sources) {
      if (f === MODULE) continue;
      for (const h of handWrittenPrefixes(f, s)) open.push(`${f}:${h.line} ${JSON.stringify(h.text.slice(0, 40))}`);
    }
    assert.deepEqual(open, [], 'a tool error text is written with its prefix by hand: build it with toolErrorText(message, status?) or toolErrorResult(message, status?)');
  });

  it('no built text is thrown inside an error, where the dispatcher would write the prefix a second time', () => {
    const open = [];
    for (const [f, s] of sources) for (const line of builtTextsHandedToAConstructor(f, s)) open.push(`${f}:${line}`);
    assert.deepEqual(open, [], 'a built tool text is the message of a thrown error: throw new ToolRefusal(status, sentence) and let the dispatcher write the prefix');
    // The line `update_space` had for its face-width refusal is flagged at its line, and the form that replaced it is not.
    assert.deepEqual(builtTextsHandedToAConstructor('server/src/x.ts', 'const a = 1;\nif (r) throw new Error(toolErrorText(r.reason, r.status));\n'), [2]);
    assert.deepEqual(builtTextsHandedToAConstructor('server/src/x.ts', 'if (r) throw new ToolRefusal(r.status, r.reason);\n// throw new Error(toolErrorText(a))\n'), []);
  });

  describe('a planted copy, taken off the module\'s own line', () => {
    const own = () => handWrittenPrefixes(MODULE, sources.get(MODULE));
    const lineOfModule = () => sources.get(MODULE).split('\n')[own()[0].line - 1];

    it('is flagged in another file, at the line of the plant', () => {
      const literal = lineOfModule().match(/`Error[^`]*`/)?.[0];
      assert.ok(literal, 'the module\'s first prefix line holds no template literal to copy');
      const planted = `export const a = 1;\nexport const planted = (message: string, status: number) => ${literal};\n`;
      const hits = handWrittenPrefixes('server/src/x.ts', planted);
      assert.equal(hits.length, 1, `the planted prefix was ${hits.length === 0 ? 'not flagged' : 'flagged more than once'}: ${planted}`);
      assert.equal(hits[0].line, 2, 'the finding names a line other than the planted one');
    });

    it('is not flagged left in a comment', () => {
      const planted = `// ${lineOfModule().trim()}\n/* ${lineOfModule().trim()} */\nexport const a = 1;\n`;
      assert.deepEqual(handWrittenPrefixes('server/src/x.ts', planted), [], 'a comment was read as code');
    });

    it('a string literal and a "+" chain are flagged too', () => {
      assert.equal(handWrittenPrefixes('server/src/x.ts', "export const a = 'Error: ' + b;\n").length, 1, 'a string literal was not flagged');
      assert.equal(handWrittenPrefixes('server/src/x.ts', 'export const a = `Error (${s}): ${b}`;\n').length, 1, 'the status spelling was not flagged');
      assert.equal(handWrittenPrefixes('server/src/x.ts', "export const a = 'an Error: is not a prefix';\n").length, 0, 'a literal that only mentions the word was flagged');
    });
  });

  describe('the module\'s text', () => {
    it('is `Error: <message>` without a status and `Error (<status>): <message>` with one', async () => {
      const { toolErrorText, toolErrorResult } = await import('../../server/dist/mcp/tool-error-text.js');
      assert.equal(toolErrorText('a sentence'), 'Error: a sentence');
      assert.equal(toolErrorText('a sentence', 403), 'Error (403): a sentence');
      assert.deepEqual(toolErrorResult('a sentence'), { content: [{ type: 'text', text: 'Error: a sentence' }], isError: true });
      assert.deepEqual(toolErrorResult('a sentence', 409), { content: [{ type: 'text', text: 'Error (409): a sentence' }], isError: true });
    });
  });
});
