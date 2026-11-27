/**
 * An MCP tool answer's raw text with the timing durations set aside, and the phases it names: the one way a spec compares two MCP answers
 * word for word (`Q-976`).
 *
 * ## What it prevents
 *
 * Every MCP result carries `_meta` `ythril/server-timing` (`server/src/http/phase-timer.ts`): one `{ dur, count }` per phase. The durations differ between
 * any two requests, so two answers that must be indistinguishable (another token's view against an id that never existed) can never be equal as raw
 * text, and a spec that compares them failed in CI the day the figures arrived (Full run 45986715572). Dropping the comparison would lose the spec's
 * promise; dropping the whole `_meta` would let a phase that only a real view runs go unseen. Here only the `dur` numbers are set to 0: the phase
 * names and their counts stay in the text, and {@link mcpPhasesOf} names them for a spec that wants them said on their own.
 *
 * ## What holds it so
 *
 * {@link mcpPhasesOf} throws when the text carries no `ythril/server-timing` object, so a spec that asserts the phases cannot pass on an answer
 * that has none (a missing block is never "the same phases").
 */

/** The `_meta` key an MCP tool result carries its figures under (the server's `MCP_TIMING_META`; also `benchmarks/rdf/server-timing.mjs`). */
const TIMING_KEY = 'ythril/server-timing';

/** The key and its object: phases are one level deep (`{"total":{"dur":1,"count":1},...}`), so one nested brace level is the whole object. */
const TIMING_BLOCK = /("ythril\/server-timing":)(\{(?:[^{}]|\{[^{}]*\})*\})/g;

/** A phase's duration inside the block: a JSON number. */
const DURATION = /("dur":)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * The answer's text with every `dur` of its `ythril/server-timing` phases set to 0 and nothing else changed (an answer with no such block comes back as it went in).
 * @param {string} text the raw body of a `POST /mcp` answer, JSON or event-stream
 * @returns {string}
 */
export function mcpAnswerSansDurations(text) {
  return text.replace(TIMING_BLOCK, (_whole, key, block) => key + block.replace(DURATION, (_m, head) => `${head}0`));
}

/**
 * The phases an MCP answer names, as `name:count` in the server's order, taken from the first `ythril/server-timing` object in its text.
 * @param {string} text the raw body of a `POST /mcp` answer, JSON or event-stream
 * @returns {string[]}
 * @throws when the text carries no `ythril/server-timing` object, or it is not a list of phases
 */
export function mcpPhasesOf(text) {
  const block = new RegExp(TIMING_BLOCK.source).exec(text);
  if (!block) throw new Error(`the answer carries no ${TIMING_KEY} in its _meta: ${text.slice(0, 200)}`);
  const phases = Object.entries(JSON.parse(/** @type {string} */ (block[2])));
  if (phases.length === 0) throw new Error(`the answer's ${TIMING_KEY} names no phase`);
  return phases.map(([name, figure]) => `${name}:${figure?.count ?? 1}`);
}
