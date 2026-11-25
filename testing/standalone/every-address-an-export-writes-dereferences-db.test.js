/**
 * Every address an RDF export writes dereferences under `/ld/` to at least the statements the export writes about it (bundle-271, Q-758;
 * design §3, r2 R1.3, R1.4).
 *
 * ## The rule
 *
 * The quad source's fixture (`_quad-source-fixture.mjs`: two spaces whose bases are `https://rdf.example.org/ld/<space>/`, records of every
 * kind, a file row, an edge with a property, an agent that wrote rows in both) is exported as N-Quads by the export door. Every subject of
 * that export under a space's base is an address: a record (entity, fact, chrono entry, edge), a file (whose path holds `/`), an agent, or a
 * chrono entry's `#start` and `#end` time nodes. With the instance's public URL at `https://rdf.example.org`, a `GET` of each address's path
 * (a fragment never travels, so the time nodes are read at their chrono entry's address) by a token with knowledge and files read answers
 * `200` with a body holding every statement the export writes with that address as subject. The address kinds read are asserted, so the
 * rule cannot pass over an export that lost a kind.
 *
 * ## Seen red
 *
 * On c647bd24f every address under `/ld/` answers the 404 placeholder, so no statement is read back. Mutation: the record body without the
 * chrono entry's `#start` and `#end` subjects (the chrono time-node statements are missing).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/every-address-an-export-writes-dereferences-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openQuadSourceFixture, A, B, baseOf } from './_quad-source-fixture.mjs';
import { parseRdf, termText } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
/** The public URL the fixture's bases are under: the default base of a space is `<public URL>/ld/<space>/`. */
const PUBLIC = 'https://rdf.example.org';

let f, readerKey;
const previousPublic = process.env['PUBLIC_BASE_URL'];

/** The path an address is read at: the address under the public URL, without its fragment. */
const pathOf = (address) => address.slice(PUBLIC.length).replace(/#.*$/, '');
const tripleText = (q) => `${termText(q.subject)} ${termText(q.predicate)} ${termText(q.object)}`;

describe('every address an export writes dereferences', { skip }, () => {
  before(async () => {
    f = await openQuadSourceFixture('ld-deref');
    // The reader of the fixture holds knowledge and files read on both spaces; a key of the same rights reads the addresses.
    readerKey = (await f.d.mint('ld-deref-key', { [A]: f.d.row({ knowledge: 'read', files: 'read' }), [B]: f.d.row({ knowledge: 'read', files: 'read' }) })).key;
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await f?.d.close();
  });

  it('each address answers at least the statements the export writes about it', async () => {
    const bases = [baseOf(A), baseOf(B)];
    const expected = new Map();
    for (const q of f.exported) {
      if (q.subject.termType !== 'NamedNode' || !bases.some(b => q.subject.value.startsWith(b))) continue;
      const path = pathOf(q.subject.value);
      if (!expected.has(path)) expected.set(path, new Set());
      expected.get(path).add(tripleText(q));
    }
    const kinds = new Set([...expected.keys()].map(p => p.split('/')[3]));
    for (const k of ['entity', 'fact', 'chrono', 'edge', 'file', 'agent']) assert.ok(kinds.has(k), `the export holds no ${k} address: ${[...kinds].join(', ')}`);
    assert.ok([...f.exported].some(q => q.subject.value.endsWith('#start')), 'the export holds a chrono time node');

    const missing = [];
    for (const [path, triples] of expected) {
      const r = await f.d.restGet(readerKey, path, { Accept: 'application/n-quads' });
      if (r.status !== 200) { missing.push(`${path}: ${r.status} ${r.text.slice(0, 160)}`); continue; }
      const got = new Set((await parseRdf('nquads', r.text)).map(tripleText));
      for (const t of triples) if (!got.has(t)) missing.push(`${path}: ${t}`);
    }
    assert.deepEqual(missing, [], `statements the export writes that the address does not answer (${missing.length} of them)`);
  });
});
