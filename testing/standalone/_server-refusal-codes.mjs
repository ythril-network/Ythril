/**
 * The codes the server can answer a request with, read from its own source (bundle-270, second review F13).
 *
 * ## What it prevents
 *
 * The client words a refusal as `<prefix>.<code>` for whatever code the server sends (`refusalText`), so no client file spells the key, and the
 * unused-translation-keys check (`tools/flow-checks/check-i-accessibility-i18n-deep-untranslated-and-unused.mjs`) counted every key under a refusal
 * prefix as used (H7). That made a dead sentence invisible: a code the server stopped sending kept its words under all eight prefixes in three
 * languages, and nothing named them. A key under a prefix is used only when its last part is a code the server can answer, and this is the one
 * reader of what the server can answer: a string literal of the server's code that has the shape of a code (an identifier, as a snake_case or
 * UPPER_CASE code is, or one word such as `failed`).
 *
 * It is the reader `data-acts-have-words.spec.ts` holds its own write-closed codes to (each must be among these), so the two never name different
 * sets: the spec derives the write-closed codes from the act kinds' table, this derives every code, and a write-closed code the spec reads that this
 * does not find fails the spec.
 *
 * ## What the answer is, and what it is not
 *
 * Every identifier-shaped string literal of the given sources, comments out: a superset of the codes a door answers with, because a code is spelled as
 * a literal at the door that answers it (`code: 'path_blocked'`), in a table (`NETWORK_REFUSAL_CODES`) or in a union, and no pattern of those four
 * spellings is complete. A retired code's literal is gone from the server with the code, which is what the check needs; a key whose last part is
 * a word the server spells for another reason is still counted used, a miss the check accepts over naming a live sentence.
 *
 * It throws when the sources hold fewer than {@link CODE_FLOOR} distinct literals: a scan that read the wrong folder would call every refusal
 * sentence dead.
 */
import { stripComments } from './_strip-comments.mjs';

/** The fewest distinct literals a read of the server's code may find before it is not a read of the server. */
export const CODE_FLOOR = 30;

/**
 * @param {string[]} sources the texts of the server's code (`SERVER_CODE_ROOTS`, specs out), comments in
 * @returns {string[]} the distinct identifier-shaped string literals, sorted
 */
export function serverRefusalCodes(sources) {
  const found = new Set();
  for (const text of sources) {
    for (const m of stripComments(text).matchAll(/['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g)) found.add(m[1]);
  }
  if (found.size < CODE_FLOOR) {
    throw new Error(`the server source holds only ${found.size} identifier literals (fewer than ${CODE_FLOOR}): the sources were not read, and a check over them would call every refusal sentence dead`);
  }
  return [...found].sort();
}
