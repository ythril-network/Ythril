/**
 * One line of text made safe to STORE or PUBLISH: the first line only, token shapes masked, home directories masked, and
 * a cap on its length.
 *
 * ## The question it answers
 *
 * "What of this message may be written to the instance, or into an artifact on a public repository?" Asked by the
 * recorder (`scripts/test-times.mjs`: a failure line, a skip reason, a test name, a path outside the checkout) and by the
 * client-report mask (`scripts/mask-client-report.mjs`: every failure message of the Vitest report).
 *
 * ## What it prevents
 *
 * The mask script imported the whole recorder, a command line with its own `main`, for this one function: a change to the
 * recorder's imports or load-time work became the mask step's, and the mask step is the one whose failure leaves a raw
 * report to be uploaded. It has a module of its own so the question has one home and no caller carries a command with it.
 *
 * ## What it is made of
 *
 * - the ONE list of token shapes (`testing/_shared/secret-masking.mjs`), applied to the first line BEFORE the cap (a
 *   credential cut in two by the cap would be neither whole enough to match nor absent from the output);
 * - home directories, which are this module's own: where a file lives is not a token shape. A Windows drive path under
 *   `Users` / `Documents and Settings`, a POSIX `/home/x` or `/Users/x`, and root's home, each written `<home>`. The patterns
 *   are built fresh per use, never shared between calls (a global regex keeps its `lastIndex`);
 * - the cap the timing reporter applies to the same kind of line (`MESSAGE_CAP`, one number for both).
 *
 * `a-secret-is-masked-by-one-list.test.js` holds it to the masking list's truth table, and to linear time over a long
 * line; `a-client-report-is-masked-before-upload.test.js` holds that nothing that is a command line is imported for it.
 */
import { maskSecrets } from '../../testing/_shared/secret-masking.mjs';
import { MESSAGE_CAP } from '../../testing/_shared/timing-reporter.mjs';

/** Home directories in a message: a Windows drive path, a POSIX home, root's. Built fresh per use. */
const HOME_PATHS = [
  ['[A-Za-z]:[\\\\/]+(?:Users|Documents and Settings)[\\\\/]+[^\\\\/\\s]+(?:[\\\\/]+\\S*)?', 'gi'],
  ['/(?:home|Users)/[^/\\s]+(?:/\\S*)?', 'g'],
  ['/root(?=[/\\s]|$)(?:/\\S*)?', 'g'],
];

/**
 * A line of text safe to store: first line only, secrets (the ONE list) and home paths masked, at most `MESSAGE_CAP`
 * characters. Takes any value; `null` and `undefined` are the empty line.
 */
export function maskText(text) {
  let out = maskSecrets(String(text ?? '').split(/\r?\n/)[0]);
  for (const [source, flags] of HOME_PATHS) out = out.replace(new RegExp(source, flags), '<home>');
  return out.slice(0, MESSAGE_CAP);
}
