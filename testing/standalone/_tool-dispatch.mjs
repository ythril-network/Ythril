/**
 * Where a tool call is actually decided — the question, answered once.
 *
 * ## Why this module exists
 *
 * Nine gates read `server/src/mcp/router.ts` to assert something about dispatch: that the rung refusal is
 * returned rather than computed and dropped, that the audit recorder is called, that a store failure keeps
 * its classification, that the schema violation is attached once for every tool rather than per tool.
 *
 * All nine were right about the behaviour and wrong about the address the moment the dispatch moved into
 * `mcp/call-tool.ts` — the shared function both doors call. Nine gates naming a file is nine copies of one
 * fact, and a gate whose subject has moved does not fail: it reads a file that no longer contains what it
 * is looking for and says so in a way that looks like a regression, or, worse, matches something else.
 *
 * ## What it answers, and what it deliberately does not
 *
 * **One question: what source decides a tool call?** Today that is one file. It is a list rather than a
 * string so that a second one can be added without every caller changing, which is the shape the nine
 * copies were in.
 *
 * It does NOT answer *what are the doors* — `one-capability-is-one-shape.test.js` asks that, and it asks
 * the opposite thing of them (that they decide nothing). Merging the two would be one module answering two
 * questions with a flag to pick.
 *
 * ## The floor
 *
 * A gate handed an empty string passes every `doesNotMatch` written over it and fails every `match` with a
 * message about the wrong thing. This throws instead.
 */
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

/** The file(s) that gate, resolve and dispatch a tool call, whichever door it arrived at. */
export const DISPATCH_SOURCES = ['server/src/mcp/call-tool.ts'];

/**
 * The dispatch source, comments stripped — so a gate cannot match the docblock explaining the fix.
 *
 * Concatenated with a newline when there is more than one file. Callers assert on RULES rather than on
 * line numbers, so the join is not something anything depends on.
 */
export function dispatchSource() {
  const text = DISPATCH_SOURCES.map(p => stripComments(readFileSync(p, 'utf8'))).join('\n');
  if (text.length < 2000) {
    throw new Error(
      `the tool dispatch read as ${text.length} characters from ${DISPATCH_SOURCES.join(', ')} — the file `
      + 'moved or was emptied, and every assertion over it would be about nothing');
  }
  return text;
}
