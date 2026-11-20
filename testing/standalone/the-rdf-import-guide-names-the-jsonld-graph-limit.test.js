/**
 * The import guide tells a caller what the reader will not take (bundle-270 slice S6, finding H6).
 *
 * ## What it prevents
 *
 * The streaming JSON-LD reader holds a top-level `@graph` array whole (the library cannot release its nodes one by one), so a JSON-LD document
 * over `RDF_MAX_UNPARSED_CHARS` with that shape is refused as `rdf_jsonld_not_streamable`, and the product's own JSON-LD export has exactly
 * that shape. A caller who meets the refusal must find, in the page that describes the import, that it is the format's limit and which formats
 * have none: without the sentence the refusal looks like a defect of the file.
 *
 * ## What it holds
 *
 * The RDF import section of the exports page names the code, the bound by its name, and says that Turtle, TriG and N-Quads have no such
 * limit; the bound it names is one the reader exports under that name, and the code is one the reader throws.
 *
 * Run: node --test testing/standalone/the-rdf-import-guide-names-the-jsonld-graph-limit.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => fs.readFileSync(root + p, 'utf8');

/** The RDF import section of the page: from its heading to the next second-level heading. */
function importSection() {
  const page = read('docs/integration-guide/06f-exports.md');
  const from = page.indexOf('\n## RDF import');
  assert.ok(from >= 0, 'the page has an RDF import section');
  const to = page.indexOf('\n## ', from + 1);
  return page.slice(from, to < 0 ? undefined : to);
}

describe('the import guide names the JSON-LD @graph limit', () => {
  it('names the code, the bound, and the formats that have no such limit', () => {
    const section = importSection();
    assert.ok(section.includes('`rdf_jsonld_not_streamable`'), 'the section names the refusal code');
    assert.ok(section.includes('`RDF_MAX_UNPARSED_CHARS`'), 'the section names the bound');
    assert.ok(section.includes('`@graph`'), 'the section names the shape that meets it');
    assert.match(section, /Turtle, TriG and N-Quads have no such limit/);
  });

  it('the code and the bound it names are the reader\'s own', () => {
    const parser = read('server/src/rdf/parse.ts');
    assert.match(parser, /export const RDF_MAX_UNPARSED_CHARS\b/);
    assert.match(parser, /new RdfParseError\('rdf_jsonld_not_streamable'/);
  });
});
