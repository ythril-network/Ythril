/**
 * The RDF export pages by keyset on both doors, stable under writes (Q-750, design r4 §5.4-§5.5 [S8]; standards review row 11).
 *
 * ## What it holds
 *
 * - REST: `limit` records a page; while records are left the answer carries `Link: <...after=X>; rel="next"` (RFC 8288), known before the
 *   status line; the last page carries none. Following the links reads every record exactly once.
 * - MCP: the same pages, `nextAfter` carrying the same cursors as the REST links, `complete` on the last.
 * - Records written while the pages are read (ids before and after the cursor) are either wholly in or wholly out, and no record is read
 *   twice.
 * - The byte budget cuts a page at a whole record, the first record whole even above it; the budget used is disclosed on both doors
 *   (`budgetChars`; REST `Ythril-Budget-Chars`), the one default the doors differ on.
 * - Refusals: an `after` this export did not give is 400 `rdf_bad_after`, `limit=0` 400 `rdf_bad_limit`, `edgeDetails=rdf12` with JSON-LD
 *   400 `rdf_bad_edge_details`, alike on both doors.
 *
 * Run: node --test testing/standalone/an-rdf-export-pages-by-keyset-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfpages';
const BIG = 5_000_000;
const id = (i) => `p${String(i).padStart(3, '0')}`;

describe('an RDF export pages by keyset on both doors', { skip }, () => {
  let d, admin;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_pages', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: 40 }, (_, i) => ({ _id: id(i * 2), name: `Page record ${i}` })));
    await d.seed(SPACE, 'fact', [{ _id: 'f1', fact: 'one fact' }]);
    admin = await d.mint('admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  // The records' own subjects: an entity or a fact address (an agent node is stated again on each page that names it).
  const record = new RegExp(`^${baseOf(SPACE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:entity|fact)/[^/#]+$`);
  const subjectsOf = async (format, text) => (await parseRdf(format, text))
    .filter(q => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && record.test(q.subject.value))
    .map(q => q.subject.value);
  const nextOf = (link) => {
    const m = /^<([^>]*)>;\s*rel="next"$/.exec(String(link ?? ''));
    return m ? m[1] : null;
  };

  it('REST: Link rel=next until the last page, every record once, writes during the walk wholly in or out', async () => {
    const seen = [];
    let path = `/api/brain/spaces/${SPACE}/export/rdf?format=nquads&limit=7&maxChars=${BIG}`;
    let pages = 0;
    const afters = [];
    while (path) {
      const r = await d.restGet(admin.key, path);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      seen.push(...new Set(await subjectsOf('nquads', r.text)));
      pages++;
      if (pages === 2) {
        // Written while the export is paged: one id behind the cursor, one ahead of it.
        await d.seed(SPACE, 'entity', [{ _id: id(1), name: 'Behind' }, { _id: id(79), name: 'Ahead' }]);
      }
      const next = nextOf(r.headers['link']);
      if (next) {
        assert.match(next, /^\/api\/brain\/spaces\/rdfpages\/export\/rdf\?/);
        assert.match(next, /format=nquads/);
        afters.push(new URL(next, 'http://x').searchParams.get('after'));
      }
      path = next;
      assert.ok(pages < 20, 'the walk ends');
    }
    assert.equal(new Set(seen).size, seen.length, 'no record was read twice');
    const ids = seen.map(s => s.slice(s.lastIndexOf('/') + 1));
    assert.ok(ids.includes(id(79)), 'a record written ahead of the cursor is read');
    assert.ok(!ids.includes(id(1)), 'a record written behind the cursor is not');
    assert.ok(ids.includes('f1'));
    assert.equal(seen.length, 40 + 1 + 1);

    // MCP over the same pages (the space as it is now): the same cursors.
    const mcpAfters = [];
    let after;
    for (;;) {
      const m = await d.exportMcp(admin.key, { space: SPACE, format: 'nquads', limit: 7, maxChars: BIG, ...(after ? { after } : {}) });
      assert.equal(m.isError, false, m.text.slice(0, 300));
      if (m.structured.complete) { assert.equal(m.structured.nextAfter, undefined); break; }
      mcpAfters.push(m.structured.nextAfter);
      after = m.structured.nextAfter;
    }
    const restAgain = [];
    path = `/api/brain/spaces/${SPACE}/export/rdf?format=nquads&limit=7&maxChars=${BIG}`;
    while (path) {
      const r = await d.restGet(admin.key, path);
      const next = nextOf(r.headers['link']);
      if (next) restAgain.push(new URL(next, 'http://x').searchParams.get('after'));
      path = next;
    }
    assert.deepEqual(mcpAfters, restAgain, 'both doors page alike');
  });

  it('the byte budget cuts at a whole record, the first one whole, and is disclosed', async () => {
    const m = await d.exportMcp(admin.key, { space: SPACE, format: 'nquads', maxChars: 1000 });
    assert.equal(m.isError, false, m.text.slice(0, 300));
    assert.equal(m.structured.complete, false);
    assert.equal(m.structured.truncated, true);
    assert.equal(m.structured.budgetChars, 1000);
    assert.deepEqual(m.structured.budgetBoundBy, ['maxChars']);
    assert.ok(m.structured.records >= 1);
    const r = await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: 1000 });
    assert.equal(r.headers['ythril-budget-chars'], '1000');
    assert.ok(nextOf(r.headers['link']), 'a cut page links the next');
    const defaults = await d.exportMcp(admin.key, { space: SPACE, format: 'nquads' });
    assert.equal(defaults.structured.budgetChars, 25000, 'the MCP default');
    const restDefault = await d.exportRest(admin.key, SPACE, { format: 'nquads' });
    assert.equal(restDefault.headers['ythril-budget-chars'], '50000', 'the REST default');
  });

  it('a bad after, limit or edge form is refused by its own code on both doors', async () => {
    const cases = [
      [{ after: 'not-a-cursor' }, 'rdf_bad_after'],
      [{ limit: 0 }, 'rdf_bad_limit'],
      [{ format: 'jsonld', edgeDetails: 'rdf12' }, 'rdf_bad_edge_details'],
      [{ edgeDetails: 'rdf13' }, 'rdf_bad_edge_details'],
    ];
    for (const [params, code] of cases) {
      const r = await d.exportRest(admin.key, SPACE, params);
      assert.equal(r.status, 400, `${JSON.stringify(params)}: ${r.text.slice(0, 200)}`);
      assert.equal(r.body?.code, code);
      const m = await d.exportMcp(admin.key, { space: SPACE, ...params });
      assert.equal(m.isError, true, JSON.stringify(params));
      assert.match(m.text, new RegExp(code));
    }
  });
});
