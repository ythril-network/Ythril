/**
 * The files whose skips CI expects, and the one cause each may name (bundle-56, Q-272: nothing skips silently).
 *
 * ## The question this answers
 *
 * "May this skip stand in a green run?" — asked at two places, one of the SOURCE and one of the RUN:
 *
 *  - `testing/standalone/a-skip-that-expects-ci-lives-in-a-listed-file.test.js` reads test sources and refuses the
 *    `expected-in-ci:` prefix anywhere but in a listed file, naming a listed cause;
 *  - `scripts/unexpected-skips.mjs`, the aggregator's check, reads what a CI run reported and fails on every skipped test
 *    whose reason does not start with the prefix OR whose file is not listed.
 *
 * ## Why it is a module and not a table in the gate
 *
 * It was a constant inside the source gate. The run check needs the same answer, and a second copy of a list of
 * "files CI excuses" is the one list that must never disagree with itself: the source gate would refuse a file the
 * aggregator excuses, or the aggregator would excuse a file the source gate refuses and nobody would be told. One list,
 * two readers; neither keeps its own.
 *
 * ## What a row means
 *
 * A file here may carry `expected-in-ci:` skips whose reason is exactly one of its causes. Adding a row is a decision
 * about what CI is allowed not to run — write why, and make it a cause that is the ABSENCE of something CI never has
 * (a corpus fetched by URL), not of something it is supposed to bring up (a sidecar, an embedder, a built client: those
 * throw under CI instead of skipping, `testing/_shared/absent-input.mjs`).
 */

/** The prefix that marks a skip as expected on CI. A skip reason must START with it. */
export const EXPECTED_IN_CI_PREFIX = 'expected-in-ci:';

const CORPUS_WHY = 'the LoCoMo / LongMemEval corpora are fetched by URL against a pinned sha256 and never committed '
  + '(redistribution), so a CI runner that did not fetch them cannot run the sweep over them';

/** @type {Readonly<Record<string, { causes: string[], why: string }>>} */
export const EXPECTED_IN_CI = Object.freeze({
  'testing/standalone/an-extraction-describes-the-conversation-it-names.test.js': { causes: ['corpus not fetched'], why: CORPUS_WHY },
  'testing/standalone/the-extractor-finds-its-mentions.test.js': { causes: ['corpus not fetched'], why: CORPUS_WHY },
  'testing/standalone/the-extractor-shortlists-before-it-asks.test.js': { causes: ['corpus not fetched'], why: CORPUS_WHY },
  'testing/standalone/the-extractor-cannot-see-the-questions.test.js': { causes: ['corpus not fetched'], why: CORPUS_WHY },
});

/**
 * Whether a skip of `reason` recorded for `file` is one CI expects: the file is listed AND the reason starts with the
 * prefix. A reason that is not text (a skip given none) is never expected. `file` is repo-relative with forward slashes.
 *
 * @param {string} file
 * @param {string|null|undefined} reason
 */
export function isExpectedInCiSkip(file, reason) {
  return Object.hasOwn(EXPECTED_IN_CI, file) && typeof reason === 'string' && reason.startsWith(EXPECTED_IN_CI_PREFIX);
}
