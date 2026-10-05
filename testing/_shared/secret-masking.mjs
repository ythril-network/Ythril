/**
 * The ONE list of token shapes the maintainer scripts and the test tooling mask, and the one function that applies it.
 *
 * ## The question it answers
 *
 * "What of this text may not be stored or printed because it looks like a credential?" - asked by the timing reporter
 * (a failure message, a test name, a skip reason: the file it writes is uploaded as a public CI artifact), by the
 * recorder before a `Test-Run` is written (`scripts/test-times.mjs`), and by the Ythril client before an error carries
 * the server's sentence (`scripts/_shared/ythril-api.mjs`).
 *
 * ## What it prevents
 *
 * Three copies of the same four families with different length floors, applied one after the other. A family added to
 * one was silently unmasked by the others, and the looser floors of the reporter meant a credential the recorder would
 * have masked was already on disk, and in the artifact, before the recorder saw it. The floors here are the LOWEST of
 * the three, because a floor decides what is not masked: a real `ythril_` token is base62 and 43 characters, but the
 * ones a person types into a test or an environment variable are not, and a mask that waits for the real length leaks
 * every shorter one.
 *
 * - `Authorization:` and its value (with a scheme word, `Bearer` or `Basic`, in front of it), written `Authorization: ***`.
 * - `ythril_` + 8 or more of `A-Za-z0-9_-`; `gh[pousr]_` + 16 or more of `A-Za-z0-9`; `github_pat_` + 16 or more of
 *   `A-Za-z0-9_`. Not anchored to a word start: a token glued to a name is still a token.
 * - `Bearer` and the next word, whatever it is, written `Bearer ***` (the word stays, to say what kind of thing was masked).
 * - A JWT: three dot-separated runs of 8 or more, the first starting `eyJ`.
 *
 * Everything masked becomes `***`, and nothing around it changes. Masking is idempotent: masked text is masked text.
 *
 * ## What it costs, said once
 *
 * A test NAME that only starts like a credential is masked too (`ythril_http_requests_total`, a metric name). That is
 * the price of a floor low enough to catch a typed token, and the recorder already paid it for every `Test-Run` it
 * wrote.
 *
 * ## What it is not
 *
 * Not the server's `redactSecrets` (`server/src/util/log.ts`): that answers "what must not reach a server log line"
 * (URL userinfo, credential query parameters, a `Bearer` value), runs linear-time over untrusted peer text, and ships
 * in the server image, which holds no `testing/`. And not a home-path scrub (`scripts/test-times.mjs` keeps that: it
 * is about where a file lives, not about a secret).
 *
 * `a-secret-is-masked-by-one-list.test.js` pins every floor with a truth table and fails on a token-family pattern
 * written anywhere else under `scripts/`, `testing/` or `benchmarks/`.
 */

/**
 * `[pattern, replacement]` pairs, applied in order. Order matters in one place: `Authorization:` first, so that its
 * scheme word is masked with its value instead of being left for the `Bearer` rule to half-consume.
 */
const SHAPES = Object.freeze([
  [/\bAuthorization:\s*(?:(?:Bearer|Basic|Digest|Token)\s+)?\S+/gi, 'Authorization: ***'],
  [/ythril_[A-Za-z0-9_-]{8,}/g, '***'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/github_pat_[A-Za-z0-9_]{16,}/g, '***'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***'],
]);

/** `text` with every token-shaped string masked, and nothing around it changed. Takes any value; never throws on one. */
export function maskSecrets(text) {
  let out = String(text);
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  return out;
}
