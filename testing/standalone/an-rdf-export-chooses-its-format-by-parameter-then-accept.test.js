/**
 * An RDF export chooses its format by one rule on both doors (Q-750, Q-751; owner 2026-11-19; standards review rows 8 and 17): the `format`
 * parameter wins; with none, the REST `Accept` header is read with its q-values; with neither (or `*\/*`), the default for the scope. Over a
 * scope of several members only a format that holds several graphs fits (TriG, then N-Quads, then JSON-LD); Turtle holds one.
 *
 * ## What it holds
 *
 * - Each format's registered media type, the parameter `version=1.2` only when given a version, and the file extension.
 * - The parameter over the header; a q-value ordering two of the four; `*\/*` and an empty header take the default; a type range
 *   (`application/*`) reaches only the formats under it; `q=0` refuses one; a parameter on a media range (a JSON-LD `profile`) is ignored.
 * - Over several members: the default is TriG; an Accept that prefers Turtle gets the best format that fits (Jena's header gets TriG);
 *   `format=turtle` is 406 `rdf_format_not_acceptable` listing what fits, and so is an Accept naming nothing that fits.
 * - A `format` that is no format is 400 `rdf_bad_format`; a header naming only an unknown type is 406.
 * - The schema export offers only Turtle and JSON-LD: the same rule over its own list.
 * - The attachment's file name: a name with quotes, slashes, backslashes, control characters and non-ASCII letters gives a quoted
 *   ASCII `filename` that holds none of them and an RFC 8187 `filename*` that keeps the letters.
 *
 * Run: node --test testing/standalone/an-rdf-export-chooses-its-format-by-parameter-then-accept.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../server/dist/rdf/export-format.js').catch(() => ({}));

const need = (name) => {
  assert.equal(typeof mod[name], 'function', `${name} is not exported by server/src/rdf/export-format.ts`);
  return mod[name];
};
const choose = (input) => need('chooseRdfFormat')(input);
const ok = (input) => {
  const r = choose(input);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.format;
};
const JENA = 'text/turtle,application/n-triples;q=0.9,application/rdf+xml;q=0.7,application/trig,application/n-quads;q=0.9,application/ld+json;q=0.8,*/*;q=0.5';

describe('an RDF export chooses its format by parameter, then Accept, then the scope', () => {
  it('each format has its registered media type and extension', () => {
    assert.deepEqual(mod.RDF_MEDIA_TYPES, { turtle: 'text/turtle', trig: 'application/trig', nquads: 'application/n-quads', jsonld: 'application/ld+json' });
    assert.deepEqual(mod.RDF_FILE_EXTENSIONS, { turtle: 'ttl', trig: 'trig', nquads: 'nq', jsonld: 'jsonld' });
    assert.equal(need('rdfContentType')('turtle', '1.2'), 'text/turtle; version=1.2');
    assert.equal(need('rdfContentType')('jsonld', undefined), 'application/ld+json');
  });

  it('one member: the default is Turtle; each media type alone gives its format', () => {
    assert.equal(ok({ members: 1 }), 'turtle');
    assert.equal(ok({ members: 1, accept: '*/*' }), 'turtle');
    assert.equal(ok({ members: 1, accept: '' }), 'turtle');
    assert.equal(ok({ members: 1, accept: 'text/turtle' }), 'turtle');
    assert.equal(ok({ members: 1, accept: 'application/trig' }), 'trig');
    assert.equal(ok({ members: 1, accept: 'application/n-quads' }), 'nquads');
    assert.equal(ok({ members: 1, accept: 'application/ld+json' }), 'jsonld');
    assert.equal(ok({ members: 1, accept: 'application/ld+json; profile="http://www.w3.org/ns/json-ld#expanded"' }), 'jsonld', 'a profile is ignored');
  });

  it('the parameter wins over the header, and says where the choice came from', () => {
    const r = choose({ members: 1, format: 'nquads', accept: 'text/turtle' });
    assert.deepEqual([r.ok, r.format, r.from], [true, 'nquads', 'parameter']);
    assert.equal(choose({ members: 1, accept: 'application/trig' }).from, 'accept');
    assert.equal(choose({ members: 1 }).from, 'default');
  });

  it('q-values order two of the four; q=0 refuses one; a range reaches only its own types', () => {
    assert.equal(ok({ members: 1, accept: 'text/turtle;q=0.4, application/n-quads;q=0.9' }), 'nquads');
    assert.equal(ok({ members: 1, accept: 'text/turtle;q=0.9, application/n-quads;q=0.4' }), 'turtle');
    assert.equal(ok({ members: 1, accept: '*/*;q=0.5, text/turtle;q=0' }), 'trig', 'turtle refused, the rest at 0.5, in the scope\'s order');
    assert.equal(ok({ members: 1, accept: 'application/*' }), 'trig');
    assert.equal(ok({ members: 1, accept: 'text/*' }), 'turtle');
  });

  it('a header naming only an unknown type is 406 rdf_format_not_acceptable, listing the formats that fit', () => {
    const r = choose({ members: 1, accept: 'application/rdf+xml' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 406);
    assert.equal(r.code, 'rdf_format_not_acceptable');
    assert.deepEqual(r.formats, ['turtle', 'trig', 'nquads', 'jsonld']);
  });

  it('a format that is no format is 400 rdf_bad_format', () => {
    const r = choose({ members: 1, format: 'rdfxml' });
    assert.deepEqual([r.ok, r.status, r.code], [false, 400, 'rdf_bad_format']);
    assert.equal(choose({ members: 1, format: 7 }).code, 'rdf_bad_format');
  });

  it('several members: TriG by default, the best format that fits for an Accept, 406 for Turtle', () => {
    assert.equal(ok({ members: 2 }), 'trig');
    assert.equal(ok({ members: 2, accept: JENA }), 'trig');
    assert.equal(ok({ members: 2, accept: 'text/turtle, application/ld+json;q=0.5' }), 'jsonld');
    assert.equal(ok({ members: 3, accept: 'text/turtle, */*;q=0.1' }), 'trig');
    const turtle = choose({ members: 2, format: 'turtle' });
    assert.deepEqual([turtle.ok, turtle.status, turtle.code], [false, 406, 'rdf_format_not_acceptable']);
    assert.deepEqual(turtle.formats, ['trig', 'nquads', 'jsonld']);
    assert.match(turtle.error, /Turtle/);
    const onlyTurtle = choose({ members: 2, accept: 'text/turtle' });
    assert.deepEqual([onlyTurtle.ok, onlyTurtle.status, onlyTurtle.code], [false, 406, 'rdf_format_not_acceptable']);
  });

  it('the schema export offers Turtle and JSON-LD over the same rule', () => {
    const offered = ['turtle', 'jsonld'];
    assert.equal(ok({ members: 1, offered }), 'turtle');
    assert.equal(ok({ members: 1, offered, accept: 'application/ld+json' }), 'jsonld');
    assert.equal(ok({ members: 1, offered, accept: 'application/trig, application/ld+json;q=0.2' }), 'jsonld');
    const trig = choose({ members: 1, offered, format: 'trig' });
    assert.deepEqual([trig.ok, trig.status, trig.code], [false, 400, 'rdf_bad_format']);
    assert.deepEqual(choose({ members: 1, offered, accept: 'application/trig' }).formats, ['turtle', 'jsonld']);
  });

  it('the attachment names the file safely: ASCII quoted, the letters kept in filename*', () => {
    const disposition = need('rdfContentDisposition');
    assert.equal(disposition('space-1', 'turtle'), 'attachment; filename="space-1.ttl"; filename*=UTF-8\'\'space-1.ttl');
    const hostile = disposition('a"b/c\\d\r\nÜber ström', 'nquads');
    const ascii = /filename="([^"]*)"/.exec(hostile)?.[1];
    assert.ok(ascii !== undefined, hostile);
    assert.doesNotMatch(ascii, /["/\\\r\n]|[^\x20-\x7e]/, `the quoted name holds only safe ASCII: ${ascii}`);
    assert.match(ascii, /\.nq$/);
    const star = /filename\*=UTF-8''(\S+)$/.exec(hostile)?.[1];
    assert.ok(star !== undefined, hostile);
    assert.doesNotMatch(star, /["/\\\s]/, star);
    assert.match(decodeURIComponent(star), /Über_ström\.nq$|Über ström\.nq$/u, 'the letters survive in filename*');
    assert.match(disposition('@my-view', 'trig'), /filename="my-view\.trig"|filename="_my-view\.trig"/);
    assert.match(disposition('...', 'jsonld'), /filename="export\.jsonld"/, 'a name of dots alone gives a plain name');
  });
});
