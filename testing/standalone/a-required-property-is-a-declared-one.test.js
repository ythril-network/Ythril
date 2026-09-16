/**
 * Every name a tool's `required` list holds must be a property that tool actually declares.
 *
 * ## The defect this exists for, and why nothing else caught it
 *
 * `space_stats` shipped with `required: ['space', 'confirm']` and no `confirm` property — an edit meant for
 * `delete_space_data` that landed one tool higher. Combined with `additionalProperties: false`, which every
 * tool here declares, that made the tool **impossible to call on either door**: omit `confirm` and the
 * validator says it is missing; pass it and the validator says it is unexpected. The cheapest read in the
 * product, dead, on both surfaces.
 *
 * **It compiled, and it passed every schema gate we had.** `mcp-tool-schemas.test.js` checks that each tool
 * advertises a closed object schema; `mcp-args-validation.test.js` exercises a handful of tools by name and
 * `space_stats` was not one of them. The contradiction is between two parts of ONE schema, so nothing that
 * looks at either part alone can see it — and ajv will not complain either, because requiring an undeclared
 * property is legal JSON Schema. It is only absurd.
 *
 * ## Why this is the shape to gate rather than the instance
 *
 * A gate naming `space_stats` would be a gate for a bug that has been fixed. What recurs is the class: a
 * `required` list and a `properties` object edited apart, in a file where forty-five tools have the same
 * two keys three lines apart. The sweep derives its subjects from the registry, so a tool written next year
 * is covered without anybody remembering this.
 *
 * Run: node --test testing/standalone/a-required-property-is-a-declared-one.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let ALL_TOOLS;
let schemas;

before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
  const { toolSchemasFor } = await import('../../server/dist/mcp/call-tool.js');
  // The same builder the dispatch validates against, so this reads the schema a caller is actually held to
  // rather than one assembled here. Two spaces so a `space` enum exists to be required.
  schemas = toolSchemasFor(['general', 'work']);
});

describe('a required property is a declared property', () => {
  it('found the tools (an empty sweep would pass everything)', () => {
    assert.ok(ALL_TOOLS.length > 30, `expected the tool registry, got ${ALL_TOOLS?.length}`);
  });

  it('every name in `required` is declared in `properties`', () => {
    const offenders = [];
    for (const tool of ALL_TOOLS) {
      const schema = tool.inputSchema(schemas);
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const name of schema.required ?? []) {
        if (!declared.has(name)) offenders.push(`${tool.name}: requires '${name}', which it does not declare`);
      }
    }
    assert.deepEqual(offenders, [],
      'a tool demands a property it does not declare. With `additionalProperties: false` that tool cannot '
      + 'be called at all — omitting the property fails as missing and passing it fails as unexpected:\n  '
      + offenders.join('\n  '));
  });

  it('and the tools that close their schema are the ones this matters for', () => {
    /*
     * The assertion above is fatal only because the schemas are closed. Asserted rather than assumed, so
     * that if a tool ever opens its schema the reader knows the check above became advisory for it — and
     * so an empty `properties` object cannot make the sweep vacuous.
     */
    const open = ALL_TOOLS.filter(t => t.inputSchema(schemas).additionalProperties !== false).map(t => t.name);
    assert.deepEqual(open, [],
      `these tools do not close their schema, so an undeclared required property is merely unreachable `
      + `rather than fatal: ${open.join(', ')}`);
  });
});
