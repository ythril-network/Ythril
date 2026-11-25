/**
 * Every MCP tool text that names `rdf_base_shared` also names `rdf_base_nested` (bundle-271, Q-758, lens-2 I1 and lens-3 D1).
 *
 * ## What it prevents
 *
 * Two spaces whose bases are equal are refused `409 rdf_base_shared`; two whose bases start one another, `409 rdf_base_nested`: one rule
 * (no two spaces' addresses may meet), two codes, written in the same save, import and export refusals. `space_create` and `update_space`
 * named the first and not the second, so an agent reading the description met a refusal it had not been told of. A text that names one
 * names both, found by reading every tool's description and every parameter description of the built registry, never from a list here.
 *
 * ## Seen red
 *
 * On d78b20280: `update_space` and `space_create` name `rdf_base_shared` and not `rdf_base_nested`.
 * Mutation: `rdf_base_nested` removed from the `update_space` text.
 *
 * Run: node --test testing/standalone/a-tool-description-naming-a-shared-rdf-base-names-the-nested-one.test.js (a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

const SHARED = 'rdf_base_shared';
const NESTED = 'rdf_base_nested';
const SPACE_SCHEMAS = { requiredSpace: { type: 'string', description: 'Space.' }, optionalSpace: { type: 'string', description: 'Space.' } };

/** Every text of a schema, at any depth: the descriptions of its properties. */
function textsOf(schema, out = []) {
  if (Array.isArray(schema)) { schema.forEach(s => textsOf(s, out)); return out; }
  if (schema === null || typeof schema !== 'object') return out;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') out.push(value);
    else textsOf(value, out);
  }
  return out;
}

/** `{ where, text }` for the description of each tool and each description inside its input schema. */
function allTexts() {
  const found = [];
  for (const tool of ALL_TOOLS) {
    found.push({ where: `${tool.name} (description)`, text: String(tool.description ?? '') });
    const schema = typeof tool.inputSchema === 'function' ? tool.inputSchema(SPACE_SCHEMAS) : tool.inputSchema;
    for (const text of textsOf(schema)) found.push({ where: `${tool.name} (a parameter)`, text });
  }
  return found;
}

describe('a tool text that names a shared RDF base names the nested one', () => {
  it('the registry is read (a floor, so a scan that finds nothing is not a clean one)', () => {
    assert.ok(ALL_TOOLS.length >= 50, `only ${ALL_TOOLS.length} tools`);
    assert.ok(allTexts().filter(t => t.text.includes(SHARED)).length >= 2, `no text names ${SHARED}: the scan is broken`);
  });

  it(`every text that names ${SHARED} also names ${NESTED}`, () => {
    const lacking = allTexts().filter(t => t.text.includes(SHARED) && !t.text.includes(NESTED)).map(t => t.where);
    assert.deepEqual(lacking, [], `these texts name ${SHARED} and not ${NESTED}`);
  });
});
