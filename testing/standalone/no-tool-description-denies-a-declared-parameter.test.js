/**
 * No tool description denies a parameter its own schema declares (Q-555).
 *
 * ## What was believed, and what it cost
 *
 * An MCP tool's `inputSchema` description is what a caller reads WHILE constructing arguments, and the y-flows convention `convention-ythril-a-tool-description-promises-the-guarantee-and-its-cost` says to treat it as
 * code. `filter` told its caller *"there is no sort parameter, but `skip` pages through that order"* for as long as the schema
 * declared `sort` and `dir`. A caller who read the sentence believed it, and nobody reports a capability they were told they did not
 * have, so the sentence stayed wrong until a reviewer read it against the schema. It is the same defect as the `recall` description
 * that said the filter was applied after the vector search: the sentence and the schema were two statements of one fact.
 *
 * ## What this holds
 *
 * Every description in every tool's schema — the tool's own and every property's, nested ones included — is read for the phrases
 * that DENY a parameter (*"there is no X"*, *"has no X parameter"*, *"does not accept an X"*), and the name each one denies is
 * looked up in the parameters THAT tool's schema declares. A denial of a declared parameter fails, naming the tool and the property
 * whose description says it.
 *
 * ## What it does not hold
 *
 * That a description is TRUE. It catches one shape of wrong sentence, the one that contradicts the schema it sits beside; a
 * description that is stale in a way the schema does not contradict is outside it. The phrases are a list because prose has no
 * grammar to derive them from, so the last case feeds the checker the very sentence that went wrong and requires it to be seen:
 * a gate whose patterns drifted into matching nothing would otherwise pass for ever. (Floors: most tools scanned, and at least one
 * denial phrase found in the real descriptions, because an empty scan passes every loop written over it.)
 *
 * Run: node --test testing/standalone/no-tool-description-denies-a-declared-parameter.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

/** Every description string in a tool: the tool's own, then each property's at any depth, with where it sits. */
function descriptionsOf(tool) {
  const out = [{ at: '(tool)', text: String(tool.description ?? '') }];
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.description === 'string' && at) out.push({ at, text: node.description });
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, at ? `${at}.${k}` : k);
    if (node.items) walk(node.items, `${at}[]`);
    for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) walk(alt, at);
  };
  walk(tool.inputSchema({}), '');
  return out;
}

/**
 * The phrasings of a denial, each capturing the name denied. A list because prose has no grammar to derive them from; the
 * fixture case below is what shows a pattern still matches the sentence that motivated it.
 */
const DENIALS = [
  /\bthere is no [`'"]?([A-Za-z_]\w*)[`'"]?/gi,
  /\b(?:has|takes|accepts) no [`'"]?([A-Za-z_]\w*)[`'"]? (?:parameter|argument|option)/gi,
  /\bno [`'"]?([A-Za-z_]\w*)[`'"]? (?:parameter|argument|option)\b/gi,
  /\b(?:does not|doesn't|cannot) (?:take|accept) (?:a |an )?[`'"]?([A-Za-z_]\w*)[`'"]?/gi,
];

/** The names a text denies. */
function denied(text) {
  const names = new Set();
  for (const re of DENIALS) for (const m of text.matchAll(re)) names.add(m[1]);
  return names;
}

const declaredBy = tool => new Set(Object.keys(tool.inputSchema({}).properties ?? {}));

/** Every `tool at: 'name'` where a description denies a name its tool declares, and how many denial phrases were read in all. */
function scan(tools) {
  const hits = [];
  let phrases = 0;
  let scanned = 0;
  for (const tool of tools) {
    const declared = declaredBy(tool);
    scanned++;
    for (const { at, text } of descriptionsOf(tool)) {
      for (const name of denied(text)) {
        phrases++;
        if (declared.has(name)) hits.push(`${tool.name} ${at} denies '${name}', which its schema declares`);
      }
    }
  }
  return { hits, phrases, scanned };
}

describe('no tool description denies a parameter its schema declares', () => {
  const result = scan(ALL_TOOLS);

  it('read most of the tools, and found denial phrases to judge', () => {
    // An absolute floor first: a share of an empty tool list is zero, and zero passes a share.
    assert.ok(ALL_TOOLS.length >= 40, `only ${ALL_TOOLS.length} tools were found to scan — the tool list is broken, not clean`);
    assert.ok(result.scanned >= ALL_TOOLS.length * 0.8,
      `only ${result.scanned} of ${ALL_TOOLS.length} tools were scanned — the sweep is broken, not clean`);
    assert.ok(result.phrases >= 1,
      'no denial phrase matched anywhere in any description: the patterns no longer match the prose, and an empty scan passes every loop');
  });

  it('no description says there is no parameter the schema beside it declares', () => {
    assert.deepEqual(result.hits, [],
      'a caller constructs arguments from these sentences and believes them — fix the sentence, or remove the parameter:\n  '
      + result.hits.join('\n  '));
  });

  it('the checker sees the sentence that was wrong: filter said there is no `sort` while declaring it', () => {
    const filter = ALL_TOOLS.find(t => t.name === 'filter');
    assert.ok(filter, 'no `filter` tool');
    const old = 'Results are ordered seq/updatedAt/createdAt descending — there is no sort parameter, but \'skip\' pages through that order.';
    const fixture = { name: 'filter', description: old, inputSchema: filter.inputSchema };
    const found = scan([fixture]).hits;
    assert.deepEqual(found, ["filter (tool) denies 'sort', which its schema declares"],
      'the pre-83cf128cc sentence must be caught against the real `filter` schema');
  });

  it('filter names `dir` wherever it names `sort`, so a caller who reads one learns the other', () => {
    /*
     * The half of Q-555 a denial gate cannot see: the false sentence was gone, but two descriptions still said results are
     * ordered "unless you pass `sort`" and stopped there, so the direction control (`dir`, default desc) was reachable only by
     * reading the property list. Both statements of the order are held to name it.
     */
    const filter = ALL_TOOLS.find(t => t.name === 'filter');
    const missing = descriptionsOf(filter)
      // The descriptions that STATE THE ORDER ("ordered … unless you pass `sort`"), not every mention of the word:
      // `collection` names `sort` to say which fields are legal, and that says nothing about a direction.
      .filter(d => d.at !== 'sort' && d.at !== 'dir' && /\bunless\b[^.]*\bsort\b/.test(d.text) && !/\bdir\b/.test(d.text))
      .map(d => d.at);
    assert.deepEqual(missing, [], `these descriptions name \`sort\` without \`dir\`: ${missing.join(', ')}`);
  });
});
