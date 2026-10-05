/**
 * A test that needs the embedder SKIPS without one on a laptop and FAILS without one on CI.
 *
 * ## Why this is a module
 *
 * Every spill test in the stack suites (`Q-92`) is behind a vector search: a recall has to rank something
 * before it can spill it. The idiom they inherited was `if (!embeddingAvailable) return t.skip(...)`, and on
 * CI that turns a broken embedder into a green run — every assertion about "a search never writes" skipped,
 * reported as passing, on exactly the runs that were supposed to prove it. A copy of the idiom in each file
 * is a copy that can forget the CI half, so the CI half lives in `requireInput` (`absent-input.mjs`), which this
 * names for the one input it is asked about most.
 *
 * The un-skippable part: on CI (`runningUnderCi()`, as GitHub Actions always is) an unavailable
 * embedder is a failure, never a skip.
 *
 * @param {import('node:test').TestContext} t
 * @param {boolean} available  what the file's own seeding found
 * @param {string} [why]       what the seeding saw, for the message
 * @returns {boolean} true when the test may proceed; false when it has been skipped (locally only)
 */
import { requireInput } from './absent-input.mjs';

export function requireEmbedding(t, available, why = 'embedding unavailable') {
  return requireInput(t, available, why);
}
