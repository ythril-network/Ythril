/**
 * `retentionStampOf` is the one rule that says what a stored retention stamp may be: a `Date`, or nothing (Q-268, Q-223; bundle-40 plan R3).
 *
 * ## The defect it prevents
 *
 * An import landed whatever a backup carried in `_expireAt` / `_contentExpireAt`. `prepared()` (sync/arrivals.ts) turned a STRING into a
 * Date and let a number, an object (an EJSON `{"$date": ...}`) or a boolean through untouched, and a string it could not read was thrown
 * away by a rule that disagrees with the sweep's own comparison. A stored stamp that is not a BSON Date never matches the sweep's
 * `{ _expireAt: { $lte: now } }`: the record never expires, silently, for as long as it is stored. The plan gives the question ONE
 * module, `server/src/brain/retention-stamp.ts`, asked by the import (every family) and by the sweep's heal of stamps already stored.
 *
 * ## The rule (plan R3)
 *
 * `retentionStampOf(v)` returns a `Date` or `undefined` (the field is then dropped, and D-9 / D-13 stamp the record as they stamp an
 * unstamped one):
 *
 *  - a `Date` stays;
 *  - a string passes only when its components are valid (year, month 1-12, day within that month, hour 0-23, minute, second) AND it
 *    names an explicit zone, `Z` or `+hh:mm` / `-hh:mm`; it becomes the instant it names, whatever zone the runner is in;
 *  - everything else (number, object, boolean, null, a zone-less string, a rolled date such as 2020-02-30, `T24:00`) is `undefined`.
 *
 * ## Decisions the plan leaves to the component rule, stated here so the implementation builds against them
 *
 *  - **The basic-form offset `+hhmm` is refused.** The rule names the zone as `Z` or `+-hh:mm`; `+hhmm` is neither. (`Date.parse` takes it
 *    in V8, which is why the rule is components and not `Date.parse`.)
 *  - **Fractional seconds are accepted**, to the millisecond: `Date.prototype.toJSON` writes every exported stamp as `...:05.678Z`, so a
 *    rule that refused them would drop every stamp of every export this server ever made.
 *  - **A lowercase `z` is refused.** The plan's rule names `Z`; the stamps a server writes use the capital.
 *  - **A date with no time part is refused** (it names no zone).
 *
 * Instants are built with `Date.UTC`, never with a string the rule itself reads, and compared by `getTime()`: no assertion renders a date
 * in the runner's zone.
 *
 * ## Seen red
 *
 * On the base `server/src/brain/retention-stamp.ts` does not exist: this pure unit test of that module fails on its import, naming
 * `server/dist/brain/retention-stamp.js` (acceptable red for a unit test of a module the plan names, handover rule).
 *
 * Run: node --test testing/standalone/a-retention-stamp-is-a-date-or-nothing.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retentionStampOf } from '../../server/dist/brain/retention-stamp.js';

const U = Date.UTC;

/** [text, the instant it names]: a string with an explicit zone and valid components. */
const ACCEPTED = [
  ['2026-01-02T03:04:05Z', U(2026, 0, 2, 3, 4, 5)],
  ['2026-01-02T03:04:05+02:00', U(2026, 0, 2, 1, 4, 5)],
  ['2026-01-02T03:04:05-05:30', U(2026, 0, 2, 8, 34, 5)],
  ['2026-01-02T03:04:05+00:00', U(2026, 0, 2, 3, 4, 5)],
  // The instant crosses a month and a year boundary through the offset.
  ['2026-01-01T00:30:00+01:00', U(2025, 11, 31, 23, 30, 0)],
  ['2026-12-31T23:30:00-01:00', U(2027, 0, 1, 0, 30, 0)],
  // The shape `Date.prototype.toJSON` writes: what every export carries.
  ['2026-01-02T03:04:05.678Z', U(2026, 0, 2, 3, 4, 5, 678)],
  ['2026-01-02T03:04:05.5+02:00', U(2026, 0, 2, 1, 4, 5, 500)],
  // Leap day of a leap year.
  ['2024-02-29T00:00:00Z', U(2024, 1, 29, 0, 0, 0)],
  ['2000-02-29T12:00:00Z', U(2000, 1, 29, 12, 0, 0)],
  // Edges of every component.
  ['2026-12-31T23:59:59Z', U(2026, 11, 31, 23, 59, 59)],
  ['2026-01-01T00:00:00Z', U(2026, 0, 1, 0, 0, 0)],
];

/** [what is wrong, the string]: refused, so the field is dropped. */
const REFUSED_STRINGS = [
  ['zone-less, with a time', '2026-01-02T03:04:05'],
  ['zone-less, with fractional seconds', '2026-01-02T03:04:05.678'],
  ['a date with no time and no zone', '2026-01-02'],
  ['the basic-form offset +hhmm (the rule names Z or +-hh:mm)', '2026-01-02T03:04:05+0200'],
  ['the basic-form offset -hhmm', '2026-01-02T03:04:05-0530'],
  ['the hour-only offset +hh', '2026-01-02T03:04:05+02'],
  ['a lowercase z (the rule names Z)', '2026-01-02T03:04:05z'],
  ['a lowercase t between the parts', '2026-01-02t03:04:05Z'],
  ['a space between the parts', '2026-01-02 03:04:05Z'],
  ['Feb 29 of a year that is not a leap year (2023)', '2023-02-29T00:00:00Z'],
  ['Feb 29 of a century that is not a leap year (1900)', '1900-02-29T00:00:00Z'],
  ['Feb 30 (JS would roll it to Mar 1)', '2020-02-30T00:00:00Z'],
  ['Apr 31 (JS would roll it to May 1)', '2026-04-31T00:00:00Z'],
  ['month 13', '2026-13-01T00:00:00Z'],
  ['month 0', '2026-00-10T00:00:00Z'],
  ['day 0', '2026-01-00T00:00:00Z'],
  ['hour 24 (JS reads T24:00:00 as midnight of the next day)', '2026-01-02T24:00:00Z'],
  ['hour 25', '2026-01-02T25:00:00Z'],
  ['minute 60', '2026-01-02T03:60:00Z'],
  ['second 61', '2026-01-02T03:04:61Z'],
  ['text after the zone', '2026-01-02T03:04:05Z and more'],
  ['text before the date', 'at 2026-01-02T03:04:05Z'],
  ['leading whitespace', ' 2026-01-02T03:04:05Z'],
  ['an epoch number written as text', '1893456000000'],
  ['not a date at all', 'never'],
  ['the empty string', ''],
];

/** [what it is, the value]: not a Date and not a string. */
const REFUSED_OTHER = [
  ['a number', 1893456000000],
  ['zero', 0],
  ['NaN', NaN],
  ['null', null],
  ['undefined', undefined],
  ['a boolean true', true],
  ['a boolean false', false],
  ['an empty object', {}],
  ['an EJSON {"$date": "<iso>"} object', { $date: '2030-01-01T00:00:00.000Z' }],
  ['an EJSON {"$date": {"$numberLong": ...}} object', { $date: { $numberLong: '1893456000000' } }],
  ['an array holding an ISO string', ['2030-01-01T00:00:00.000Z']],
  ['a function', () => new Date()],
];

const shown = (got) => (got instanceof Date ? got.toISOString() : String(got));

describe('retentionStampOf: a stored retention stamp is a Date or nothing (Q-268, Q-223)', () => {
  it('the tables are not empty (a loop over nothing passes)', () => {
    assert.ok(ACCEPTED.length >= 10, `only ${ACCEPTED.length} accepted cases`);
    assert.ok(REFUSED_STRINGS.length >= 20, `only ${REFUSED_STRINGS.length} refused strings`);
    assert.ok(REFUSED_OTHER.length >= 10, `only ${REFUSED_OTHER.length} refused non-strings`);
    assert.equal(typeof retentionStampOf, 'function');
  });

  it('a Date is kept as the instant it holds', () => {
    const d = new Date(Date.UTC(2031, 5, 7, 8, 9, 10, 11));
    const got = retentionStampOf(d);
    assert.ok(got instanceof Date, `a Date came back as ${String(got)}`);
    assert.equal(got.getTime(), d.getTime());
  });

  it('a string with valid components and an explicit Z, +hh:mm or -hh:mm zone becomes the instant it names, in any runner zone', () => {
    const wrong = [];
    for (const [text, instant] of ACCEPTED) {
      const got = retentionStampOf(text);
      if (!(got instanceof Date)) wrong.push(`${text}: ${String(got)}, want ${new Date(instant).toISOString()}`);
      else if (got.getTime() !== instant) wrong.push(`${text}: ${got.toISOString()}, want ${new Date(instant).toISOString()}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('fractional seconds are kept to the millisecond (what Date#toJSON writes in every export)', () => {
    const exported = new Date(Date.UTC(2026, 8, 1, 12, 30, 45, 123)).toJSON();
    assert.equal(exported, '2026-09-01T12:30:45.123Z');
    assert.equal(retentionStampOf(exported)?.getTime?.(), Date.UTC(2026, 8, 1, 12, 30, 45, 123));
  });

  it('2024-02-29 is accepted (a real leap day) while 2023-02-29, 1900-02-29 and 2020-02-30 are refused (JS rolls them to the next month)', () => {
    assert.equal(retentionStampOf('2024-02-29T00:00:00Z')?.getTime?.(), Date.UTC(2024, 1, 29));
    for (const text of ['2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2020-02-30T00:00:00Z']) {
      assert.equal(retentionStampOf(text), undefined, `${text} was accepted: Date.parse rolls it to ${new Date(Date.parse(text)).toISOString()}`);
    }
  });

  it('T24:00 is refused, though Date.parse reads it as midnight of the next day', () => {
    assert.equal(retentionStampOf('2026-01-02T24:00:00Z'), undefined);
    assert.equal(retentionStampOf('2026-01-02T24:00:00+02:00'), undefined);
  });

  it('a zone-less string is refused, because its instant depends on the zone of the machine that reads it', () => {
    for (const text of ['2026-01-02T03:04:05', '2026-01-02T03:04:05.123', '2026-01-02']) {
      assert.equal(retentionStampOf(text), undefined, `${text} was read as ${shown(retentionStampOf(text))}`);
    }
  });

  it('the basic-form offset +hhmm, a lowercase z and a space for the T are refused (the component rule names Z and +-hh:mm)', () => {
    for (const text of ['2026-01-02T03:04:05+0200', '2026-01-02T03:04:05-0530', '2026-01-02T03:04:05z', '2026-01-02 03:04:05Z']) {
      assert.equal(retentionStampOf(text), undefined, `${text} was accepted as ${shown(retentionStampOf(text))}`);
    }
  });

  it('every other string that is not a real calendar instant with an explicit zone is refused', () => {
    const wrong = [];
    for (const [why, text] of REFUSED_STRINGS) {
      const got = retentionStampOf(text);
      if (got !== undefined) wrong.push(`${JSON.stringify(text)} (${why}): ${shown(got)}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('a number, null, an object (EJSON included) and a boolean are refused: the field is dropped, never stored', () => {
    const wrong = [];
    for (const [why, v] of REFUSED_OTHER) {
      const got = retentionStampOf(v);
      if (got !== undefined) wrong.push(`${why}: ${shown(got)}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('the answer is always a Date or undefined, never the input handed back', () => {
    for (const v of [...REFUSED_OTHER.map(([, x]) => x), ...REFUSED_STRINGS.map(([, s]) => s)]) {
      const got = retentionStampOf(v);
      assert.ok(got === undefined || got instanceof Date, `${String(v)} came back as ${typeof got}`);
    }
  });
});
