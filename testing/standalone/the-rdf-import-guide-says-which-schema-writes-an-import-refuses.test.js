/**
 * The guides say which schema writes an RDF import refuses and which it does not (bundle-270, tail finds T2 and T3).
 *
 * ## What it prevents
 *
 * The import's schema-write gate refuses a schema write a caller STARTS (the space PATCH, `schema_update`, the per-type routes, the library) with
 * `space_being_rdf_imported`, and applies a schema the NETWORK decided (a passed `meta_change` round, a layer arriving by sync, a space leaving a
 * network) while the import stands: the import commits against the schema it was planned with. The guides said "no schema write" without the
 * difference, so a reader took a round that passed meanwhile to be refused, and an operator's write to be allowed.
 *
 * ## What it holds
 *
 * The RDF import section of the exports page says both halves, naming the three things a network decides and the callers an operator starts; the
 * MCP page and the data-management page, which also describe the import, never say a bare "no schema write".
 *
 * Run: node --test testing/standalone/the-rdf-import-guide-says-which-schema-writes-an-import-refuses.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => fs.readFileSync(root + p, 'utf8').replaceAll('\r\n', '\n');

/** The RDF import section of the exports page: from its heading to the next second-level heading. */
function importSection() {
  const page = read('docs/integration-guide/06f-exports.md');
  const from = page.indexOf('\n## RDF import');
  assert.ok(from >= 0, 'the page has an RDF import section');
  const to = page.indexOf('\n## ', from + 1);
  return page.slice(from, to < 0 ? undefined : to);
}

describe('the guides say which schema writes an RDF import refuses', () => {
  it('the import section names what the network decides (applied) and what an operator starts (refused)', () => {
    const section = importSection();
    assert.ok(
      section.includes('A schema change the network decided (a passed `meta_change` round, a layer arriving by sync, a space leaving a network) is applied while an import stands; the import commits against the schema it was planned with.'),
      'the section says a decided schema is applied while the import stands',
    );
    assert.ok(
      section.includes('Only a schema write an operator starts (space PATCH, `schema_update`, the per-type routes, the library) is refused with `409 space_being_rdf_imported`.'),
      'the section says only an operator\'s schema write is refused, and with which code',
    );
    assert.ok(!section.includes('no schema write a caller starts'), 'the section still says the space takes no schema write at all');
  });

  it('the MCP page and the data-management page do not say a bare "no schema write"', () => {
    for (const page of ['docs/integration-guide/16-mcp.md', 'docs/integration-guide/12a-data-management-api.md']) {
      const text = read(page);
      assert.ok(!/no schema write(?! an operator starts)/.test(text), `${page} says a bare "no schema write" about the import`);
    }
  });
});
