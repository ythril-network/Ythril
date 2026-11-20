/**
 * The Turtle library reports its tokens to the reader, so the token-level checks run (bundle-270 review U1, slice S1).
 *
 * ## The doubt
 *
 * The reader's checks on an address (a relative one before any base, the token bound) live in a callback it hands the Turtle library. If the
 * library never called it, a relative address before a base and an over-long token would pass in silence. These cases hold that the callback is
 * called, by the refusals only it can make: each refusal below is made at a token, with its place.
 *
 * ## What it holds
 *
 * In Turtle and TriG: a relative address used BEFORE a base the same document declares later is refused (the base does not reach back), a
 * relative base is refused, an address made longer than the token bound by a prefix is refused as RDF_MAX_TOKEN_CHARS at its token, and a
 * relative address AFTER a declared base is read against it (the control, so the refusals are the order's).
 *
 * Run: node --test testing/standalone/the-rdf-import-parser-checks-every-token.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule, readQuads, refusalOf, sourceOf, pieces, placeOf } from './_rdf-parse-doors.mjs';

describe('the token checks run', () => {
  for (const format of ['turtle', 'trig']) {
    const wrap = (body) => (format === 'trig' ? `<http://g> { ${body} }` : body);

    it(`${format}: a relative address used before a later @base is refused at its token`, async () => {
      const text = `${wrap('<s> <http://a/p> "x" .')}\n@base <http://b/dir/> .\n`;
      const err = await refusalOf(format, sourceOf(pieces(text, 5)));
      assert.equal(err.code, 'rdf_relative_iri', `${err.code}: ${err.message}`);
      assert.equal(err.address, 's');
      assert.deepEqual(err.place, placeOf(text, '<s>'));
    });

    it(`${format}: a relative address after the base is read against it`, async () => {
      const text = `@base <http://b/dir/> .\n${wrap('<s> <http://a/p> "x" .')}\n`;
      const quads = await readQuads(format, sourceOf(pieces(text, 5)));
      assert.equal(quads[0].subject.value, 'http://b/dir/s');
    });

    it(`${format}: a relative base is refused (a base is itself an address and nothing resolves it)`, async () => {
      const text = `@base <rel/> .\n${wrap('<http://a/s> <http://a/p> "x" .')}\n`;
      const err = await refusalOf(format, sourceOf(pieces(text, 5)));
      assert.equal(err.code, 'rdf_relative_iri');
      assert.equal(err.address, 'rel/');
    });

    it(`${format}: an address a prefix makes longer than the token bound is refused at its token`, async () => {
      const max = parseModule.RDF_MAX_TOKEN_CHARS;
      const prefix = `http://p/${'a'.repeat(max - 'http://p/'.length)}`;
      const text = `@prefix p: <${prefix}> .\n${wrap('p:s p:x p:o .')}\n`;
      const err = await refusalOf(format, sourceOf(pieces(text, 1024)));
      assert.equal(err.code, 'rdf_bound_exceeded');
      assert.equal(err.bound, 'RDF_MAX_TOKEN_CHARS', `${err.bound}: ${err.message}`);
    });
  }
});
