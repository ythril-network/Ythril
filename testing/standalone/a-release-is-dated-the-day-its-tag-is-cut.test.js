/**
 * A release's CHANGELOG section is dated the day its tag is cut, on the Europe/Berlin calendar (`Q-717`).
 *
 * ## What it prevents
 *
 * Two releases in a row (6.4.0, 6.5.0) needed a follow-up commit because the section was dated the day the bump was written,
 * not the day the tag was cut. The date reaches the release notes, the GitHub Release and the npm package, and none of the three
 * can be taken back. The release gate checked that the section was dated, never which date.
 *
 * ## The rule
 *
 * - On the tag (the publish workflow), the section's date must be the tag's day in Europe/Berlin: anything else is a failure.
 * - Before the tag exists (the release branch, `--releasing` by hand), a date that is not today in Europe/Berlin is a warning:
 *   a bump may be written the evening before it is tagged, and the tag-time check is the one that refuses.
 * - The zone is Europe/Berlin, not UTC: v6.4.0 was tagged at 00:29 CET on 2026-11-03, which is still 2026-11-02 in UTC, and is
 *   dated 2026-11-03.
 *
 * The rule is a pure function held on a truth table here; the gate is held to calling it with the heading's date and the tag's
 * instant.
 *
 * Run: node --test testing/standalone/a-release-is-dated-the-day-its-tag-is-cut.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const mod = await import('../../scripts/_shared/release-date.mjs').catch((err) => ({ missing: err }));
const need = (name) => {
  assert.ok(!mod.missing, `scripts/_shared/release-date.mjs does not exist (${mod.missing?.message}): nothing checks a release's date`);
  assert.equal(typeof mod[name], 'function', `scripts/_shared/release-date.mjs exports no ${name}`);
  return mod[name];
};

describe('calendarDayIn: the day an instant falls on in Europe/Berlin', () => {
  const rows = [
    ['a CET tag between 00:00 and 01:00 is the next day in Berlin, still the day before in UTC', '2026-11-02T23:29:00Z', '2026-11-03'],
    ['the same instant written with its offset', '2026-11-03T00:29:00+01:00', '2026-11-03'],
    ['a CEST tag between 00:00 and 02:00 is the next day in Berlin', '2026-07-14T22:30:00Z', '2026-07-15'],
    ['an evening tag in CET stays that day', '2026-11-06T21:30:00Z', '2026-11-06'],
    ['the last second before midnight in Berlin', '2026-11-06T22:59:59Z', '2026-11-06'],
    ['midnight in Berlin', '2026-11-06T23:00:00Z', '2026-11-07'],
  ];
  for (const [name, instant, day] of rows) {
    it(name, () => {
      assert.equal(need('calendarDayIn')(new Date(instant)), day);
    });
  }
  it('the zone is Europe/Berlin, whatever zone the runner is in', () => {
    assert.equal(mod.RELEASE_ZONE, 'Europe/Berlin');
  });
});

describe('releaseDateProblem: on the tag a wrong date fails, before the tag it warns', () => {
  const tagInstant = new Date('2026-11-03T00:29:00+01:00');
  it('on the tag, a section dated the day before fails, naming both dates', () => {
    const p = need('releaseDateProblem')({ sectionDate: '2026-11-02', tagInstant, now: new Date('2026-11-03T08:00:00Z') });
    assert.equal(p?.level, 'fail');
    assert.match(p.why, /2026-11-02/);
    assert.match(p.why, /2026-11-03/);
  });
  it('on the tag, a section dated the tag\'s day in Berlin passes, though UTC says the day before', () => {
    assert.equal(need('releaseDateProblem')({ sectionDate: '2026-11-03', tagInstant, now: new Date('2026-11-03T08:00:00Z') }), null);
  });
  it('on the tag, the publish running the next day changes nothing: the tag\'s day decides, not the run\'s', () => {
    assert.equal(need('releaseDateProblem')({ sectionDate: '2026-11-03', tagInstant, now: new Date('2026-11-05T10:00:00Z') }), null);
  });
  it('before the tag, a section not dated today in Berlin is a warning, not a failure', () => {
    const p = need('releaseDateProblem')({ sectionDate: '2026-11-06', tagInstant: null, now: new Date('2026-11-06T23:30:00Z') });
    assert.equal(p?.level, 'warn');
    assert.match(p.why, /2026-11-07/);
  });
  it('before the tag, a section dated today in Berlin is clean', () => {
    assert.equal(need('releaseDateProblem')({ sectionDate: '2026-11-07', tagInstant: null, now: new Date('2026-11-06T23:30:00Z') }), null);
  });
  it('a section with no readable date is a failure, never a pass', () => {
    assert.equal(need('releaseDateProblem')({ sectionDate: undefined, tagInstant, now: new Date() })?.level, 'fail');
  });
});

describe('the release gate asks the rule with the heading\'s date and the tag\'s instant', () => {
  const gate = stripComments(readFileSync(new URL('../../scripts/release-gate.mjs', import.meta.url), 'utf8'));
  it('imports releaseDateProblem from the shared module, so the rule is spelled once', () => {
    assert.match(gate, /import\s*\{[^}]*\breleaseDateProblem\b[^}]*\}\s*from\s*['"]\.\/_shared\/release-date\.mjs['"]/,
      'release-gate.mjs does not import releaseDateProblem from ./_shared/release-date.mjs');
  });
  it('calls it with the date the heading carries and the tag\'s own date from git', () => {
    assert.match(gate, /releaseDateProblem\(\s*\{[^}]*sectionDate\s*:/, 'the gate does not pass the section\'s date');
    assert.match(gate, /creatordate/, 'the gate does not read the tag\'s date from git');
  });
});
