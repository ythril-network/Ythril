/**
 * A temporal value is typed `xsd:date`, `xsd:dateTime` or `xsd:dateTimeStamp` only when its text is in that datatype's lexical space
 * (bundle-269 review, finding 5). Otherwise it stays a plain string and is counted (`untypedTemporal`), so the export never writes an
 * ill-typed literal the exported shapes then refuse.
 *
 * The grammar is XSD 1.1 Part 2 (https://www.w3.org/TR/xmlschema11-2/): `yearFrag ::= '-'? (([1-9] digit digit digit+)) | ('0' digit digit
 * digit))` (§D.3.1): a year of five or more digits has no leading zero, and year 0000 is allowed; `timezoneFrag ::= 'Z' | ('+' | '-')
 * (('0' digit | '1' [0-3]) ':' minuteFrag | '14:00')` (so `-00:00` and `+14:00` are in, `+14:30` and `+15:00` out); `hourFrag` 00 to 23,
 * with `24:00:00` alone as the end of a day (`endOfDayFrag`); `secondFrag` two digits with an optional fraction of at least one digit.
 *
 * Run: node --test testing/standalone/a-date-is-typed-only-in-its-datatypes-own-grammar.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { literalForValue } = await import('../../server/dist/rdf/literals.js');
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const typedAs = (text) => {
  const out = literalForValue(text, 'date');
  return out.kind === 'literal' ? (out.literal.datatype ?? 'plain').replace(XSD, 'xsd:') : out.kind;
};

describe('a date is typed only in its datatype\'s own grammar', () => {
  const cases = [
    ['02026-04-05', 'plain', 'a five-digit year with a leading zero (yearFrag forbids it)'],
    ['2026-04-05', 'xsd:date', 'a date'],
    ['0000-01-01', 'xsd:date', 'year 0000 (XSD 1.1)'],
    ['-0044-03-15', 'xsd:date', 'a negative year'],
    ['12026-04-05', 'xsd:date', 'a five-digit year'],
    ['2026-04-05Z', 'xsd:date', 'a date with a zone'],
    ['2026-04-05T10:00:00', 'xsd:dateTime', 'a date-time without zone'],
    ['2026-04-05T10:00:00.5Z', 'xsd:dateTimeStamp', 'fractional seconds with a zone'],
    ['2026-04-05T10:00:00+14:00', 'xsd:dateTimeStamp', 'the largest zone'],
    ['2026-04-05T10:00:00-00:00', 'xsd:dateTimeStamp', 'the negative zero zone'],
    ['2026-04-05T10:00:00+14:30', 'plain', 'a zone past +14:00'],
    ['2026-04-05T24:00:00', 'xsd:dateTime', 'the end of a day'],
    ['2026-04-05T24:00:01', 'plain', 'past the end of a day'],
    ['2026-04-05T10:00:00.', 'plain', 'a fraction without digits'],
    ['02026-04-05T10:00:00Z', 'plain', 'a leading-zero year in a date-time'],
  ];
  for (const [text, want, why] of cases) {
    it(`${text}: ${want} (${why})`, () => assert.equal(typedAs(text), want));
  }
});
