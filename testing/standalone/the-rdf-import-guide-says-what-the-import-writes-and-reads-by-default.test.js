/**
 * The RDF import's guide says what the import now does (bundle-270, fix round 4, findings R1 to R4).
 *
 * ## What it prevents
 *
 * The guide said `sourceBase` defaults to the file's one data graph, which the code did not do (R2); it did not say a record that already says what the
 * file states is not written (R3), named neither the order the kinds are written in nor the reason a link the commit could not write is answered with (R1),
 * and said the base check is made at the door only (R4). A guide sentence that drifts from the code is a promise the next reader acts on.
 *
 * ## What it holds
 *
 * - Every reason code the import's report builder spells as its own constant (`export const <NAME> = '<code>'` in `rdf/import-report.ts`, derived from the
 *   source, never a list here) is named in the import section as a `recorded` reason.
 * - The kinds are written in `IMPORT_OP_ORDER`'s order (read from the source), and the section says that order.
 * - The parameters table says TriG, N-Quads and JSON-LD default `sourceBase` to the file's one data graph and Turtle to none, and the section says when the
 *   default applies; the section says an unchanged record is not written and is counted in `unchanged`; the status table says the base check is also made
 *   before the first window.
 *
 * Run: node --test testing/standalone/the-rdf-import-guide-says-what-the-import-writes-and-reads-by-default.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => fs.readFileSync(root + p, 'utf8').replaceAll('\r\n', '\n');

function importSection() {
  const page = read('docs/integration-guide/06f-exports.md');
  const from = page.indexOf('\n## RDF import');
  assert.ok(from >= 0, 'the page has an RDF import section');
  const to = page.indexOf('\n## ', from + 1);
  return page.slice(from, to < 0 ? undefined : to);
}

describe('the RDF import section says what the import writes and reads by default', () => {
  it('names every reason code the report builder owns, as a recorded reason', () => {
    const source = read('server/src/rdf/import-report.ts');
    const codes = [...source.matchAll(/^export const [A-Z_]+ = '([a-z_]+)';$/gm)].map(m => m[1]);
    assert.ok(codes.includes('stored_record_gone') && codes.includes('links_not_written'), `the constants found: ${codes.join(', ')}`);
    const section = importSection();
    for (const code of codes) assert.ok(section.includes(`coded \`${code}\``), `the section names the reason \`${code}\``);
  });

  it('says the order the kinds are written in, which is the source\'s', () => {
    const source = read('server/src/rdf/import-report.ts');
    const order = /IMPORT_OP_ORDER: readonly OpKind\[\] = \[([^\]]+)\]/.exec(source)?.[1]?.replaceAll("'", '').split(',').map(s => s.trim());
    assert.deepEqual(order, ['entity', 'fact', 'chrono', 'edge'], 'what a record points at is written first');
    assert.ok(importSection().includes('what a record points at first (entities, facts, chrono entries, edges)'), 'the section says it');
  });

  it('says when sourceBase defaults, and that an unchanged record is not written', () => {
    const section = importSection();
    assert.ok(section.includes('| TriG, N-Quads, JSON-LD: the file\'s one data graph; Turtle: none |'), 'the table says which formats default');
    assert.ok(section.includes('exactly one data graph, no statement outside it and no `graphBase`'), 'the section says when the default applies');
    assert.ok(section.includes('is **not written at all**'), 'the section says an unchanged record is not written');
    assert.ok(section.includes('in `converged` and in `unchanged`'), 'and where the report counts it');
    assert.ok(section.includes('after the import was registered and before its first window'), 'the status table says the base is checked before the first window too');
  });
});
