/**
 * A stored address the RDF writer cannot spell is a named refusal on every door and both exports, and never holds an export slot
 * (bundle-269 review, findings 1 and 2).
 *
 * The doors now refuse such an address (`IriZ`, one rule with the writer), but a value stored before that rule was tightened is still read;
 * these spaces are given one directly in the configuration, as an older instance left it.
 *
 * ## What it holds
 *
 * - A space whose `meta.rdf.vocab` holds U+007F: the whole export fails while building the document's prefixes, before any byte, and
 *   answers `409 rdf_unwritable` naming the setting; the same token then exports another space at once (the slot was released on that exit,
 *   twice over).
 * - A space whose type maps to an address holding U+007F, with a record of that type behind a full store page: a page that reaches it is
 *   `409 rdf_unwritable` on REST and MCP, naming the record and the address (bounded); the schema export is `409 rdf_unwritable` naming the
 *   type; the whole stream, which met it after its first byte, ends in the incomplete form with the reason in its comment and
 *   `Ythril-Export-Complete: false`, and the independent parser refuses it.
 *
 * Run: node --test testing/standalone/a-stored-address-the-writer-refuses-is-a-named-refusal-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const GOOD = 'rdfgoodaddr';
const BAD_VOCAB = 'rdfbadvocab';
const BAD_TERM = 'rdfbadterm';
const DEL = '\x7f';
const ODD_IRI = `https://ex.org/odd${DEL}type`;

describe('a stored address the writer refuses is a named refusal', { skip, timeout: 300_000 }, () => {
  let d, admin, tok;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_bad_address', spaces: [
      { id: GOOD, meta: rdfMeta(GOOD) }, { id: BAD_VOCAB, meta: rdfMeta(BAD_VOCAB) }, { id: BAD_TERM, meta: rdfMeta(BAD_TERM) },
    ] });
    // As an older instance stored them, past the door's rule.
    d.loader.mutateConfig(c => {
      const v = c.spaces.find(s => s.id === BAD_VOCAB);
      v.meta.rdf.vocab = `https://ex.org/v${DEL}/`;
      const t = c.spaces.find(s => s.id === BAD_TERM);
      // The effective meta is recomputed from the space's own definitions, so both carry it.
      t.meta.typeSchemas = { entity: { Odd: { iri: ODD_IRI } } };
      if (t.ownMeta) t.ownMeta.typeSchemas = { entity: { Odd: { iri: ODD_IRI } } };
    });
    await d.seed(GOOD, 'entity', [{ _id: 'g1', name: 'Good' }]);
    await d.seed(BAD_VOCAB, 'entity', [{ _id: 'v1', name: 'Under a bad vocab' }]);
    await d.seed(BAD_TERM, 'entity', [
      ...Array.from({ length: 250 }, (_, i) => ({ _id: `a${String(i).padStart(4, '0')}`, name: `Plain ${i}` })),
      { _id: 'zodd', name: 'Odd one', type: 'Odd' },
    ]);
    admin = await d.mint('admin', {}, { admin: true });
    tok = await d.mint('reader', { [GOOD]: d.row({ knowledge: 'read' }), [BAD_VOCAB]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a whole export that cannot start is 409 rdf_unwritable naming the setting, and frees its slot', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await d.exportRest(tok.key, BAD_VOCAB, {});
      assert.equal(r.status, 409, r.text.slice(0, 300));
      assert.equal(r.body?.code, 'rdf_unwritable');
      assert.match(r.body?.error ?? '', /vocab|namespace/i, 'it names the setting to correct');
    }
    const next = await d.exportRest(tok.key, GOOD, {});
    assert.equal(next.status, 200, `the slot was released on the failed starts: ${next.text.slice(0, 200)}`);
  });

  it('a page that meets the address is 409 rdf_unwritable on both doors, naming the record and the address', async () => {
    const r = await d.exportRest(admin.key, BAD_TERM, { format: 'nquads', limit: 300, maxChars: 5_000_000 });
    assert.equal(r.status, 409, r.text.slice(0, 300));
    assert.equal(r.body?.code, 'rdf_unwritable');
    assert.match(r.body.error, /zodd/);
    assert.match(r.body.error, /odd/);
    const m = await d.exportMcp(admin.key, { space: BAD_TERM, limit: 300, maxChars: 5_000_000 });
    assert.equal(m.isError, true);
    assert.match(m.text, /rdf_unwritable/);
    assert.match(m.text, /zodd/);
  });

  it('the schema export is 409 rdf_unwritable naming the type', async () => {
    const r = await d.schemaRest(admin.key, BAD_TERM, {});
    assert.equal(r.status, 409, r.text.slice(0, 300));
    assert.equal(r.body?.code, 'rdf_unwritable');
    assert.match(r.body.error, /Odd/);
    const m = await d.schemaMcp(admin.key, { space: BAD_TERM });
    assert.equal(m.isError, true);
    assert.match(m.text, /rdf_unwritable/);
  });

  it('a whole stream that meets it after its first byte ends incomplete, with the reason', async () => {
    const r = await d.exportRest(admin.key, BAD_TERM, { format: 'nquads' });
    assert.equal(r.status, 200);
    assert.equal(r.trailers['ythril-export-complete'], 'false');
    assert.match(r.text, /INCOMPLETE[^\n]*(rdf_unwritable|cannot be written)/);
    await assert.rejects(parseRdf('nquads', r.text));
  });
});
