/**
 * The entity-delete tools never tell a caller there is no cascade — because there is one (`Q-107` part 3b, a
 * description pin).
 *
 * ## The sentence
 *
 * `delete_entity`'s description ends its refusal paragraph with *"There is no cascade."* — written before `P-29`
 * gave the delete a cascade (`delete_entity_preview` mints a token; `cascadeToken` on the delete quotes it back).
 * The parameter list two screens further down says the opposite, so the tool now describes one behaviour two ways,
 * and the one an agent reads first is the wrong one. `CLAUDE.md`: a schema description is the authoritative
 * reference, and nobody reports a capability they were told they did not have — the integrator who designed around a
 * stale `recall` sentence is the precedent.
 *
 * ## What is asserted
 *
 * Over every tool that takes or names a cascade token (derived from the served tools, not listed), the whole text a
 * caller reads — the description and every parameter description, as the dispatcher serves them — never says there
 * is no cascade. And the delete tool's own description, not only its parameter list, names the token that makes it a
 * cascade: the description is what a caller reads to decide whether to look further.
 *
 * Run: node --test testing/standalone/delete-entity-states-its-cascade.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS } from '../../server/dist/mcp/tools/index.js';
import { toolSchemasFor } from '../../server/dist/mcp/tool-schema.js';

const schemas = toolSchemasFor(['general']);

/** Every description string in a schema, however deeply it is nested. */
function descriptionsIn(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) descriptionsIn(n, out); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      else descriptionsIn(v, out);
    }
  }
  return out;
}

const served = ALL_TOOLS.map(t => {
  const schema = typeof t.inputSchema === 'function' ? t.inputSchema(schemas) : t.inputSchema;
  return { name: t.name, description: t.description, schema, text: [t.description, ...descriptionsIn(schema)].join('\n') };
});

/** The tools a cascade concerns: those that take a `cascadeToken`, and those that tell a caller about one. */
const CASCADE_TOOLS = served.filter(t => t.schema?.properties?.cascadeToken || /cascadeToken/.test(t.text));
const DENIAL = /\bthere is no cascade\b|\bno cascade\b|\bdoes not cascade\b|\bnever cascades\b/i;

describe('the entity-delete tools state their cascade', () => {
  it('the tools a cascade concerns are found, and one of them takes the token', () => {
    assert.ok(served.length >= 40, `only ${served.length} tools were read — the listing is broken`);
    assert.ok(CASCADE_TOOLS.length >= 2, `only ${CASCADE_TOOLS.map(t => t.name)} concern a cascade — the derivation is broken`);
    assert.ok(CASCADE_TOOLS.some(t => t.schema?.properties?.cascadeToken), 'no tool takes a cascadeToken');
  });

  for (const t of CASCADE_TOOLS) {
    it(`${t.name}: nothing it says denies the cascade`, () => {
      const hit = t.text.split(/(?<=[.!?])\s+/).find(s => DENIAL.test(s));
      assert.equal(hit, undefined,
        `${t.name} tells a caller "${hit}" — and the cascade exists (\`cascadeToken\`): a caller that reads the description `
        + 'first is told it cannot do what the parameter list offers');
    });
  }

  it('the tool that takes the token names it in its description, not only in its parameters', () => {
    for (const t of CASCADE_TOOLS.filter(x => x.schema?.properties?.cascadeToken)) {
      assert.match(t.description, /cascadeToken/,
        `${t.name}'s description never mentions \`cascadeToken\`; a caller deciding from the description is not told the cascade exists`);
    }
  });
});
