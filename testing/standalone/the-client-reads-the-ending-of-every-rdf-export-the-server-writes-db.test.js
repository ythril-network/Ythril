/**
 * The ending of an RDF records export, as the server writes it and as the browser's export screen reads it (Q-942, verify finding L2.4).
 *
 * ## Why it runs the real writer
 *
 * The screen saves a streamed export only when the document's last lines say it is whole, and shows the record count and the values left out
 * from them (`client/src/app/core/rdf-export-ending.ts`). Its own spec reads hand-written endings; a writer that changed its closing comment or
 * its report node would pass that spec and make every real export read as cut off. So this holds the two together: the real door writes
 * each format, and the client's parser (its source, transpiled here, not a copy) reads what the door wrote.
 *
 * ## What it holds
 *
 * - A space with two values left out (a list and an object, planted by a direct write): Turtle, TriG, N-Quads and JSON-LD all read as
 *   complete, with the record count, the left-out count, each key and the reason as the client words it (`notPlain`).
 * - A personal view over members writes an ending the client reads as complete. So does a view with a SPARQL CONSTRUCT (a different code
 *   path, `export-construct.ts`), in Turtle, N-Quads and JSON-LD; its document cut before the ending, or half way, reads as no ending.
 * - Every reason the server words (`REASON_WORDS` in `export-act.ts`) is one the client words: none reads as `other`.
 * - A stream the server could not finish (the incomplete mark) is `complete: false` to the client.
 *
 * Run: node --test testing/standalone/the-client-reads-the-ending-of-every-rdf-export-the-server-writes-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfending';
const OTHER = 'rdfendingb';
const BIG = 5_000_000;
/** The tail the screen keeps of a document to read its ending from. */
const TAIL_BYTES = 256 * 1024;

/** The client's parser: its source file transpiled, so a change there is a change under test. */
async function clientParser() {
  const source = readFileSync(new URL('../../client/src/app/core/rdf-export-ending.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const tailOf = (text) => Buffer.from(text, 'utf8').subarray(-TAIL_BYTES).toString('utf8');

describe('the client reads the ending the server writes', { skip }, () => {
  let d, admin, parse;
  before(async () => {
    parse = (await clientParser()).rdfExportEnding;
    d = await openRdfExportDoors({ suite: 'rdf_export_ending', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }, { id: OTHER, meta: rdfMeta(OTHER) }] });
    await d.seed(SPACE, 'entity', [
      { _id: 'listy', name: 'Listy', properties: { colours: ['a', 'b'], height: 3 } },
      { _id: 'objy', name: 'Objy', properties: { shape: { x: 1 }, note: 'kept' } },
      { _id: 'plain', name: 'Plain', properties: { colour: 'red' } },
    ]);
    await d.seed(OTHER, 'entity', [{ _id: 'o1', name: 'One' }, { _id: 'o2', name: 'Two' }]);
    admin = await d.mint('admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
    it(`${format}: complete, with the record count and the two values left out, each named with its reason`, async () => {
      const r = await d.exportRest(admin.key, SPACE, { format, maxChars: BIG });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const e = parse(tailOf(r.text), format);
      assert.ok(e, `no ending read from the last lines:\n${r.text.slice(-600)}`);
      assert.equal(e.complete, true);
      assert.equal(e.records, 3);
      assert.equal(e.leftOutCount, 2);
      assert.deepEqual(e.leftOut.map(v => v.key).sort(), ['colours', 'shape']);
      assert.ok(e.leftOut.every(v => v.reason === 'notPlain'), JSON.stringify(e.leftOut));
      assert.deepEqual(e.leftOut.map(v => v.record.split('/').at(-1)).sort(), ['listy', 'objy']);
    });
  }

  const reads = (...spaces) => Object.fromEntries(spaces.map(s => [s, d.row({ knowledge: 'read', files: 'read' })]));

  for (const format of ['trig', 'nquads', 'jsonld']) {
    it(`a view of two spaces, ${format}: the ending reads as complete with the records of both`, async () => {
      const t = await d.mint(`view-${format}`, reads(SPACE, OTHER));
      const made = await d.rest(t.key, 'POST', '/api/views', { name: `ending-${format}`, members: [SPACE, OTHER] });
      assert.ok(made.status < 300, made.text.slice(0, 300));
      const r = await d.exportRest(t.key, `@ending-${format}`, { format, maxChars: BIG });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const e = parse(tailOf(r.text), format);
      assert.ok(e, `no ending read from the last lines:\n${r.text.slice(-600)}`);
      assert.equal(e.complete, true);
      assert.equal(e.records, 5);
    });
  }

  // A SPARQL view's export (`export-construct.ts`) is one document written by the same ending as every other export; found by this guard
  // when the CONSTRUCT page wrote the statements and no closing comment or report, so the screen read it as cut off and never saved it.
  for (const format of ['turtle', 'nquads', 'jsonld']) {
    it(`a view with a SPARQL CONSTRUCT, ${format}: the ending reads as complete, and a document cut before it does not`, async () => {
      const t = await d.mint(`construct-${format}`, reads(SPACE));
      const made = await d.rest(t.key, 'POST', '/api/views', { name: `ending-construct-${format}`, members: [SPACE], sparql: { query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }' } });
      assert.ok(made.status < 300, `${made.status} ${made.text.slice(0, 300)}`);
      const r = await d.exportRest(t.key, `@ending-construct-${format}`, { format, maxChars: BIG });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const e = parse(tailOf(r.text), format);
      assert.ok(e, `no ending read from the last lines:\n${r.text.slice(-600)}`);
      assert.equal(e.complete, true);
      assert.ok(e.records > 0, JSON.stringify(e));
      assert.equal(e.leftOutCount, 0);
      // The guard an ending must keep: the same document without its closing lines, or cut anywhere before them, is never read as whole.
      const lines = r.text.split('\n').filter(l => l.trim() !== '');
      const withoutEnding = lines.slice(0, format === 'jsonld' ? -3 : -1).join('\n');
      assert.equal(parse(withoutEnding, format), null, 'the document without its ending reads as whole');
      assert.equal(parse(lines.slice(0, Math.floor(lines.length / 2)).join('\n'), format), null, 'a document cut half way reads as whole');
    });
  }

  it('every reason the server words is one the client words', () => {
    const source = readFileSync(new URL('../../server/src/rdf/export-act.ts', import.meta.url), 'utf8');
    const block = /const REASON_WORDS[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    const words = [...block.matchAll(/'([^']+)'\s*,?\s*$/gm)].map(m => m[1]);
    assert.ok(words.length >= 3, `REASON_WORDS not read from export-act.ts: ${block}`);
    for (const w of words) {
      const e = parse(`# ythril-export: 1 records; complete, nothing is left; 1 property values left out: a (k: ${w})\n`, 'turtle');
      assert.notEqual(e?.leftOut[0]?.reason, 'other', `the client has no words for the server's reason '${w}'`);
    }
  });

  it('a document the server could not finish reads as incomplete', () => {
    const e = parse('# ythril-export: 5 records; INCOMPLETE, the export could not finish: store; 0 property values left out\n!ythril-export-incomplete\n', 'nquads');
    assert.equal(e?.complete, false);
  });
});
