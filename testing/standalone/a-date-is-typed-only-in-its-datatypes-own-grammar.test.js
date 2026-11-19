/**
 * A temporal value is typed `xsd:date`, `xsd:dateTime` or `xsd:dateTimeStamp` only when its text is in that datatype's lexical space
 * (bundle-269 review, finding 5), so the export never writes an ill-typed literal the exported shapes then refuse. A value of a property
 * declared `date` that is in none of them does not fit its declared type: it is LEFT OUT and named (`does-not-fit-its-declared-type`), the
 * owner's rule for every declared type (bundle-269 drive, finding 6: the review's fix had made it a plain string, `born: "yesterday"`).
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
  if (out.kind === 'left-out') return `left out: ${out.reason}`;
  return out.kind === 'literal' ? (out.literal.datatype ?? 'plain').replace(XSD, 'xsd:') : out.kind;
};
/** What a date property's value that is no calendar date or time becomes. */
const MISFIT = 'left out: does-not-fit-its-declared-type';

describe('a date is typed only in its datatype\'s own grammar', () => {
  const cases = [
    ['yesterday', MISFIT, 'the drive\'s value: no calendar date at all'],
    ['2026-04-05T10:00', MISFIT, 'a date-time without seconds (secondFrag is required)'],
    ['02026-04-05', MISFIT, 'a five-digit year with a leading zero (yearFrag forbids it)'],
    ['2026-04-05', 'xsd:date', 'a date'],
    ['0000-01-01', 'xsd:date', 'year 0000 (XSD 1.1)'],
    ['-0044-03-15', 'xsd:date', 'a negative year'],
    ['12026-04-05', 'xsd:date', 'a five-digit year'],
    ['2026-04-05Z', 'xsd:date', 'a date with a zone'],
    ['2026-04-05T10:00:00', 'xsd:dateTime', 'a date-time without zone'],
    ['2026-04-05T10:00:00.5Z', 'xsd:dateTimeStamp', 'fractional seconds with a zone'],
    ['2026-04-05T10:00:00+14:00', 'xsd:dateTimeStamp', 'the largest zone'],
    ['2026-04-05T10:00:00-00:00', 'xsd:dateTimeStamp', 'the negative zero zone'],
    ['2026-04-05T10:00:00+14:30', MISFIT, 'a zone past +14:00'],
    ['2026-04-05T24:00:00', 'xsd:dateTime', 'the end of a day'],
    ['2026-04-05T24:00:01', MISFIT, 'past the end of a day'],
    ['2026-04-05T10:00:00.', MISFIT, 'a fraction without digits'],
    ['02026-04-05T10:00:00Z', MISFIT, 'a leading-zero year in a date-time'],
  ];
  for (const [text, want, why] of cases) {
    it(`${text}: ${want} (${why})`, () => assert.equal(typedAs(text), want));
  }

  it('every declared type leaves out what does not fit it, with the same reason, through the one literal function', () => {
    const misfits = [['string', 7], ['number', 'seven'], ['number', Number.NaN], ['boolean', 'yes'], ['date', 20260405], ['date', 'last spring']];
    for (const [declared, value] of misfits) {
      assert.deepEqual(literalForValue(value, declared), { kind: 'left-out', reason: 'does-not-fit-its-declared-type' }, `${declared}: ${String(value)}`);
    }
  });
});
