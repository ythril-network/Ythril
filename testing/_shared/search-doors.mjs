/**
 * Where the search family's two doors live — the question, answered once.
 *
 * ## Why this is a module and not a string in each gate
 *
 * Six gates named `server/src/mcp/tools/search.ts` as "the MCP door for `filter`". When `filter` moved into
 * its own file — `no-new-god-files` refused the next line added to `search.ts`, and the three tools there
 * were never one responsibility — all six went red at once, and each would have been fixed by editing a
 * literal. Six literals is six chances for the next move to leave one pointing at a file that no longer
 * holds what the gate is reading.
 *
 * A gate should name the RULE and derive the site. This is the derivation.
 *
 * ## The floors, which are the un-skippable part
 *
 * A path that stops existing, or a file that stops holding its tool, makes every `assert.match` over it
 * pass or fail for a reason that has nothing to do with the rule. So reading a door ASSERTS that the file
 * is there and that it declares the handler it is supposed to — a gate handed an empty string concludes
 * whatever its regex says about nothing.
 */
import { readFileSync, existsSync } from 'node:fs';

/** The `filter` tool: a predicate, no ranking. Moved out of `search.ts` 2026-09-18. */
export const MCP_FILTER = 'server/src/mcp/tools/filter.ts';
/** `recall` and `find_similar`: the two that RANK. */
export const MCP_RANKING = 'server/src/mcp/tools/search.ts';
/** Every search route — `recall`, `find_similar` and `filter` all answer from this one file. */
export const REST_SEARCH = 'server/src/api/brain/search.ts';

/**
 * The doors of `filter`. **There is one**, and the list stays a list on purpose.
 *
 * It held two until `B-9` step 3c deleted `POST /api/brain/filter` — a hand-written TWIN of the tool,
 * four hundred lines re-implementing what `callTool` already does. What serves REST now is the generic
 * `POST /api/<tool-name>` route, which has no per-tool code at all: it forwards the body and returns the
 * result, so there is no second source for a gate to compare against.
 *
 * **Every gate looping over this kept its assertions unchanged**, which is the point of leaving it a
 * list. They assert that the tool declares a parameter, refuses what it cannot mean and reaches the one
 * module that implements it — all still true, and now true in one place instead of two. A second entry
 * appearing here again is a second implementation, which is what `one-capability-is-one-shape` refuses.
 */
export const FILTER_DOORS = [MCP_FILTER];

/** Both doors of the RANKING tools. */
export const RANKING_DOORS = [MCP_RANKING, REST_SEARCH];

/** Every MCP source in the search family, for a gate whose subject is the tools rather than one tool. */
export const MCP_SEARCH_FAMILY = [MCP_RANKING, MCP_FILTER];

/** What each file must contain to be the thing a gate thinks it is reading. */
const MUST_DECLARE = {
  [MCP_FILTER]: /export const queryTool/,
  [MCP_RANKING]: /export const recallTool/,
  // `/recall`, not `/filter`: the filter route was deleted at `B-9` step 3c and this file's job is to
  // fail loudly when a door moves, not to keep naming one that has gone. What makes this file a door is
  // that it still registers a search route at all.
  [REST_SEARCH]: /searchRouter\.post\('\/recall'/,
};

/**
 * One door's source, with the floor applied.
 *
 * @param {string} file one of the paths exported above
 */
export function doorSource(file) {
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist — a gate reading it would assert about nothing`);
  }
  const src = readFileSync(file, 'utf8');
  const must = MUST_DECLARE[file];
  if (must && !must.test(src)) {
    throw new Error(`${file} no longer declares what makes it a door (${must}) — the split moved again`);
  }
  return src;
}

/** Several doors' sources, in the order given. */
export const doorSources = (files) => files.map(doorSource);
