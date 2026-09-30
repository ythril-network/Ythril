/**
 * Every date the client shows goes through ONE formatter, the one that reads the viewer's chosen format (`Q-146`).
 *
 * Owner, 2026-09-29: *"we need a date-formatting setting so iso timestamps can be displayed that way everywhere on
 * ythril ui."* A setting only reaches the dates that ask it. Before this, twenty places formatted their own — the
 * Angular `date` pipe in five spellings (`dd.MM.yyyy HH:mm`, `yyyy-MM-dd HH:mm:ss`, `dd.MM.yy`, `medium`,
 * `mediumDate`), `toLocaleString()` and `toLocaleDateString()` — and the two shared components each had their own
 * `Intl` call, one pinned to `de-DE` for every language. The `medium` ones rendered US English in a German UI
 * (`Q-100`), because the app registers no Angular locale data and needs none once nothing uses the pipe.
 *
 * What counts as formatting a date yourself, matched in CODE with comments stripped: the `date` pipe, `DatePipe`,
 * `toLocaleString(` / `toLocaleDateString(` / `toLocaleTimeString(`, and constructing an `Intl.DateTimeFormat` or
 * `Intl.RelativeTimeFormat`. Exactly one file may do those things — `core/date-format.ts` — and every other file is
 * derived from `git ls-files`, so a component written next year is inside the net without anyone listing it.
 *
 * Out of scope, deliberately: `<input type="date">` and `datetime-local` controls. They are EDIT widgets the browser
 * renders in its own locale, and what they hold is a different question (local wall-clock for editing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';

const THE_MODULE = 'src/app/core/date-format.ts';

/** Each way a file can format a date itself, with the name the failure message uses. Built fresh per call. */
const selfFormatting = (): [string, RegExp][] => [
  ['the date pipe', /(?<!\|)\|\s*date\s*(?=[:)}\s])/g],
  ['DatePipe', /\bDatePipe\b/g],
  ['toLocale*String()', /\.toLocale(?:Date|Time)?String\s*\(/g],
  ['new Intl.DateTimeFormat / RelativeTimeFormat', /\bIntl\.(?:DateTimeFormat|RelativeTimeFormat)\b/g],
];

function offendersIn(path: string, code: string): string[] {
  const found: string[] = [];
  for (const [what, re] of selfFormatting()) {
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split('\n').length;
      found.push(`${path}:${line}  ${what}`);
    }
  }
  return found;
}

describe('one date formatter (Q-146)', () => {
  const files = trackedAppSources();

  it('the module every date goes through exists, and is the one place allowed to format', () => {
    expect(files, `${THE_MODULE} is not tracked — re-point this gate`).toContain(THE_MODULE);
    const own = stripComments(readFileSync(resolve(CLIENT_ROOT, THE_MODULE), 'utf8'));
    // A floor for the pattern itself: the module DOES construct Intl formatters, so if this matches nothing the
    // pattern has stopped matching what it is meant to, and the assertion below would pass about nothing.
    expect(offendersIn(THE_MODULE, own).length, 'the patterns no longer match the real formatter').toBeGreaterThan(0);
  });

  it('no other file formats a date itself', () => {
    const offenders: string[] = [];
    for (const path of files) {
      if (path === THE_MODULE) continue;
      offenders.push(...offendersIn(path, stripComments(readFileSync(resolve(CLIENT_ROOT, path), 'utf8'))));
    }
    expect(offenders, 'these format a date themselves, so the Date and time preference cannot reach them — use '
      + '<app-timestamp>, <app-relative-time> or the `instant` pipe from core/date-format.ts:\n  '
      + offenders.join('\n  ')).toEqual([]);
  });
});
