/**
 * The ONE reading of a release's date: the day a release is dated by, and whether a CHANGELOG section carries it (`Q-717`).
 *
 * ## What it prevents
 *
 * Two releases in a row (6.4.0, 6.5.0) were dated the day their bump was written, not the day their tag was cut, and each needed a
 * follow-up commit. The date reaches the release notes, the GitHub Release and the npm package, and none of the three can be taken
 * back. The release gate checked that the section had a date, never which.
 *
 * ## The rule
 *
 *  - A release is dated by the Europe/Berlin calendar (`RELEASE_ZONE`): v6.4.0 was tagged at 00:29 CET on 2026-11-03, which is
 *    still 2026-11-02 in UTC, and is dated 2026-11-03.
 *  - On the tag, the section's date must be the tag's day there: anything else fails (the publish workflow runs the gate on the tag,
 *    so a wrong date stops before anything is pushed).
 *  - Before the tag exists, a date that is not today there is a warning: a bump may be written the evening before it is tagged,
 *    and the tag-time check is the one that refuses.
 *
 * ## What it does not do
 *
 * It is pure: no git, no clock, no environment. The gate hands in the heading's date, the tag's instant and now, so every branch is
 * a table row (`testing/standalone/a-release-is-dated-the-day-its-tag-is-cut.test.js`).
 */

/** The zone whose calendar a release is dated by. */
export const RELEASE_ZONE = 'Europe/Berlin';

/**
 * The calendar day, `YYYY-MM-DD`, an instant falls on in `zone`. Independent of the zone the process runs in.
 *
 * @param {Date | number | string} instant
 * @param {string} [zone]
 */
export function calendarDayIn(instant, zone = RELEASE_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instant));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * What is wrong with a release section's date, or `null` when nothing is.
 *
 * @param {{ sectionDate: string | undefined, tagInstant: Date | number | string | null | undefined, now: Date | number }} o
 *   `sectionDate` is the heading's `YYYY-MM-DD`; `tagInstant` is when the release's tag was cut, or nothing before it exists.
 * @returns {{ level: 'fail' | 'warn', why: string } | null}
 */
export function releaseDateProblem({ sectionDate, tagInstant, now }) {
  if (typeof sectionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sectionDate)) {
    return { level: 'fail', why: `the release section's date is not readable (${String(sectionDate)}); a release heading reads "## [x.y.z] — YYYY-MM-DD"` };
  }
  if (tagInstant !== null && tagInstant !== undefined) {
    const tagDay = calendarDayIn(tagInstant);
    return sectionDate === tagDay ? null : {
      level: 'fail',
      why: `the section is dated ${sectionDate}, but its tag was cut on ${tagDay} (${RELEASE_ZONE}). A release is dated the day its `
        + 'tag is cut: correct the heading, then cut the tag again.',
    };
  }
  const today = calendarDayIn(now);
  return sectionDate === today ? null : {
    level: 'warn',
    why: `the section is dated ${sectionDate}, and today is ${today} (${RELEASE_ZONE}). The publish refuses a date that is not the `
      + 'day the tag is cut: date it the day you tag.',
  };
}
