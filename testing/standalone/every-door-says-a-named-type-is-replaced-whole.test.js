/**
 * Every door that says `schema_update` / `PATCH` MERGES also says what a named type does: it is replaced whole.
 *
 * ## The failure that bought it
 *
 * The merge is two levels deep and the second level replaces: a knowledge type you do not name is kept, a type name you do
 * not name inside one is kept, and a type you DO name has its whole definition replaced by what you sent
 * (`spaces/meta-write-base.ts`, `{ ...(had[kt] ?? {}), ...ktMap }`; pinned by
 * `a-meta-field-keeps-its-merge-kind-through-every-merge.test.js`). The `schema_update` tool description said only
 * "MERGES by default: types you do not mention are preserved, so editing one type does not require resending the others".
 * An agent read that as a property-level merge, sent one `propertySchemas` entry for a type, and dropped the type's other
 * properties. The REST page and the MCP page carried the same half-sentence, and `06a-schema-api.md` alone said it right.
 *
 * ## What it holds
 *
 * - The MCP text (the tool's description and its `typeSchemasMode` description) is read from the tool object, not from source.
 * - Every paragraph or table row in `docs/` that makes the merge claim (the phrases in CLAIMS, found by reading every doc,
 *   not a list of pages) says the rule: a sentence that names a type, says its definition, and says it is replaced whole.
 * - A floor on the doors read, so a reader that stopped finding them cannot pass over nothing.
 * - The control: each door with its rule sentences removed (a copy of the repository's own text, not a retyped one) is
 *   refused by the same check.
 *
 * The rule itself (what the merge does) is not asserted here; the merge test above pins it.
 *
 * Run: node --test testing/standalone/every-door-says-a-named-type-is-replaced-whole.test.js (needs server/dist built).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_ROOT, docFiles } from './_docs.mjs';

/** The phrases by which a doc says the typeSchemas write merges (read after emphasis and code marks are removed). */
const CLAIMS = /deep-merges|merges by default|defaults to merge\b|PATCH merge\b|merges over the network's layer/i;
/** Tool text is all about the one write, so any use of the word is a claim. */
const MERGE_WORD = /\bmerg(?:e|es|ed)\b/i;

const plain = (text) => text.replace(/[*`_|]/g, '').replace(/\s+/g, ' ').trim();
const sentencesOf = (text) => plain(text).split(/(?<=[.!?])\s+/).filter(Boolean);

/** One sentence that names a type, says its definition, and says it is replaced whole. */
const sentenceStatesRule = (s) => /\b(?:nam(?:e|es|ed|ing)|mention(?:s|ed|ing)?)\b/i.test(s) && /\btype\b/i.test(s)
  && /\bdefinition\b/i.test(s) && /\breplac(?:e|es|ed|ing)\b/i.test(s) && /\b(?:whole|wholesale|entire|entirely)\b/i.test(s);
const statesRule = (text) => sentencesOf(text).some(sentenceStatesRule);
const withoutRule = (text) => sentencesOf(text).filter(s => !sentenceStatesRule(s)).join(' ');

/** Paragraphs of a page, a table split into its rows. */
function unitsOf(page) {
  return page.split(/\r?\n\s*\r?\n/).flatMap(p => (p.trimStart().startsWith('|') ? p.split(/\r?\n/) : [p])).filter(u => u.trim());
}

/** Every doc unit that makes the merge claim: `{ where, text }`. */
function docDoors() {
  const out = [];
  for (const rel of docFiles()) {
    for (const u of unitsOf(readFileSync(join(DOCS_ROOT, rel), 'utf8'))) {
      if (CLAIMS.test(plain(u))) out.push({ where: `docs/${rel}: ${plain(u).slice(0, 50)}…`, text: u, claim: CLAIMS });
    }
  }
  return out;
}

async function mcpDoors() {
  const { schema_updateTool } = await import('../../server/dist/mcp/tools/spaces.js');
  const props = schema_updateTool.inputSchema({ requiredSpace: { type: 'string' } }).properties;
  return [
    { where: 'MCP schema_update description', text: schema_updateTool.description, claim: MERGE_WORD },
    { where: 'MCP schema_update typeSchemasMode', text: props.typeSchemasMode.description, claim: MERGE_WORD },
  ];
}

/** The doors that claim a merge and do not say the rule. */
const lacking = (doors) => doors.filter(d => d.claim.test(plain(d.text)) && !statesRule(d.text)).map(d => d.where);

describe('every door that says a type schema write merges says a named type is replaced whole', () => {
  it('the rule sentence is told from the sentences around it (truth table)', () => {
    const yes = [
      'Naming a type replaces its whole definition in the layer written.',
      'a type name you **do** mention has its definition object **replaced wholesale**, not merged.',
    ];
    const no = [
      'MERGES by default: types you do not mention are preserved, so editing one type does not require resending the others.',
      'RULES (`rules`, and a type\'s own `rules`) are replaced whole with their owner.',
      '`replace` makes the payload authoritative, so types absent from it are REMOVED.',
      'Send the type definition complete.',
    ];
    for (const s of yes) assert.ok(statesRule(s), `not told as the rule: ${s}`);
    for (const s of no) assert.ok(!statesRule(s), `told as the rule though it is not: ${s}`);
  });

  it('reads the doors: the MCP text and every doc paragraph making the merge claim', async () => {
    const mcp = await mcpDoors();
    const docs = docDoors();
    for (const d of mcp) assert.ok(d.text && d.text.length > 50, `${d.where} came back empty`);
    assert.ok(docs.length >= 4, `only ${docs.length} doc paragraphs make the merge claim; the reader or the claim phrases stopped finding them`);
    for (const f of ['06-spaces-api.md', '16-mcp.md', '06a-schema-api.md']) {
      assert.ok(docs.some(d => d.where.includes(f)), `no door found in ${f}`);
    }
  });

  it('none of them states the merge without the rule', async () => {
    const doors = [...await mcpDoors(), ...docDoors()];
    assert.deepEqual(lacking(doors), [],
      'these doors say the write merges but not that a named type is replaced whole: an agent reading only the door drops the type\'s other properties');
  });

  it('control: each door with its rule sentences removed is refused', async () => {
    const doors = [...await mcpDoors(), ...docDoors()];
    const planted = doors.map(d => ({ ...d, text: withoutRule(d.text) }));
    const stillClaims = planted.filter(d => d.claim.test(plain(d.text)));
    assert.ok(stillClaims.length >= 3, `only ${stillClaims.length} planted copies still claim a merge; the control proves too little`);
    assert.deepEqual(lacking(stillClaims).sort(), stillClaims.map(d => d.where).sort(), 'a planted door without the rule was not refused');
  });
});
