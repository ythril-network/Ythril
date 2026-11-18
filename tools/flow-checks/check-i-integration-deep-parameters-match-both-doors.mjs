#!/usr/bin/env node
/**
 * check-i-integration-deep-parameters-match-both-doors: for each capability, the parameters the REST route accepts are the ones the MCP tool
 * declares, with the same requiredness, enum, default and floor.
 *
 * Rule (the flow node's stated assertion): per capability, the route's accepted keys against the tool's inputSchema keys, defaults, caps and
 * refusal text, diffed; a diff line is a finding.
 *
 *   - The pairs, the keys each route accepts and the schemas each route parses with are read by `_door-pairs.mjs` from the code (audit operations,
 *     the capability map, the handlers, the exported zod schemas): none is listed here. See that module for what an unreadable or delegating route
 *     means: it leaves the key comparison and is counted in the verdict.
 *   - KEYS: a key the tool declares and none of its routes accepts (the route drops it silently), and a key a readable route accepts and the tool
 *     does not declare (a REST caller can say what an MCP caller cannot). Id `tool:param`.
 *   - SHAPE of a parameter both doors have: `required`, `enum`, `default`, and the floors (`minimum`, `minLength`, `minItems`). Id `tool:param.attr`.
 *     The caps (`maximum`, `maxLength`, `maxItems`) are `check-i-performance-deep-caps-match-both-doors`'s, so the two do not state one assertion twice.
 *   - The refusal TEXT is not compared here: `a-schema-refusal-has-one-body-on-every-door` pins one body for every door, and a text read from a
 *     handler is the second parser of what that test runs.
 *   - Exceptions live only in `check-i-integration-deep-parameters-match-both-doors.allow.json` beside this file (`{ id, reason, reviewBy }`),
 *     through `_allow.mjs`; the verdict says how many it used. A `KEEP_PAIRING` row that keeps nothing is a problem.
 *   - A build older than its source, or missing, is `cannot answer` with the build command (`_built-registry.mjs`).
 *
 * The failure that bought it (Q-917): the flow node names the check and Q-876's twin-parity probe left parameters, defaults and caps out ("the
 * half that hides"); `schema_update` declared `whenDuePasses`, the dispatcher accepted it and the handler dropped it while REST stored it.
 *
 *     npm run build:server && node tools/flow-checks/check-i-integration-deep-parameters-match-both-doors.mjs
 */
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { loadDoorWorld, keyPairs, keyFindings, capabilityPairs, attributeFindings, staleKeepRows, FLOOR_KEYS } from './_door-pairs.mjs';

/** The attributes of a shared parameter this probe compares: the rest of what a bound or a shape says. */
export const SHAPE_ATTRIBUTES = ['required', 'enum', 'default', ...FLOOR_KEYS];

/** The pure part: `{ keys, attributes, stale }` from `_door-pairs` pairs; `[{ id, text }]` findings and the counts. */
export function parameterFindings({ pairs, capPairs, boundByField, stale = [] }) {
  const keys = keyFindings(pairs);
  const attrs = attributeFindings(capPairs, SHAPE_ATTRIBUTES, boundByField);
  return { findings: [...keys.findings, ...attrs.findings], keys, attrs, stale };
}

export function decide(input, allow, todayDate) {
  const { findings, keys, attrs, stale } = parameterFindings(input);
  if (stale.length) return violated(`a pairing the subtraction would drop is kept for nothing: ${stale.join(', ')}`);
  if (keys.compared < input.pairs.length * 0.4) throw new CannotAnswer(`only ${keys.compared} of ${input.pairs.length} tools reached a route whose parameters could be read: the reader is wrong, not the code`);
  if (attrs.compared < 15) throw new CannotAnswer(`only ${attrs.compared} capability pair(s) resolved to a schema: the call-graph walk or the schema derivation broke`);
  const { problem, open, used } = applyAllow(findings, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${keys.compared} tool(s) compared on keys (${keys.unreadable} with a route that cannot be read, ${keys.delegating} delegating), ${attrs.compared} capability pair(s) on shape (${attrs.delegating} delegating), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} door difference(s): ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`every tool and its route take the same parameters, requiredness, enums, defaults and floors (${tail})`);
}

/** The real tree's input for {@link decide}. */
export async function realInput() {
  const world = await loadDoorWorld();
  return { pairs: keyPairs(world), capPairs: capabilityPairs(world), boundByField: world.BOUND_BY_FIELD, stale: staleKeepRows(world) };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
