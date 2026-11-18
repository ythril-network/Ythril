#!/usr/bin/env node
/**
 * check-i-performance-deep-caps-match-both-doors: each capability's caps match on every API door: the tool's `maximum`, `maxLength` and
 * `maxItems` are the route validator's, bar the documented differences.
 *
 * Rule (the flow node's stated assertion): a script comparing each door's maxLength, maxItems and limit with the route's validator, minus the
 * documented exceptions list.
 *
 *   - Each capability (a row of the capability map: a tool and its REST route) is read by `_door-pairs.mjs`: the tool's `inputSchema` against the
 *     exported zod schemas the route's handler reaches through the call graph. A route that hands its body to the tool dispatcher agrees by
 *     construction (the tool's schema is its validator) and is counted; a route that validates by hand has no schema to compare and is counted
 *     too, as a MEASURE `unreadable` held to a ceiling that only goes down (a new hand-validated route with a capped tool fails).
 *   - Per parameter both doors have, `maximum`, `maxLength` and `maxItems` (an exclusive integer bound normalised to the inclusive one, a union to
 *     its loosest branch). Id `tool:param.attr`. The floors, `required`, enums and defaults are `check-i-integration-deep-parameters-match-both-doors`'s.
 *   - A parameter `BOUND_BY_FIELD` of `util/request-bounds.ts` names is held to one bound everywhere by `every-quantity-a-caller-sends-has-a-bound`
 *     and is left to it, so one assertion is not stated twice.
 *   - Exceptions live only in `check-i-performance-deep-caps-match-both-doors.allow.json` beside this file: `{ id, reason, reviewBy }` for a
 *     sanctioned difference, `{ id: 'unreadable', max, reason, reviewBy }` for the ceiling, through `_allow.mjs`. The verdict says how many it used.
 *   - A build older than its source, or missing, is `cannot answer` with the build command (`_built-registry.mjs`).
 *
 * The failure that bought it (Q-917): the flow node names the check and Q-876's quantities probe asks whether a ceiling EXISTS, not whether both
 * doors state the SAME one; "a 400 on one door and a silent default on the other is worse than either alone".
 *
 *     npm run build:server && node tools/flow-checks/check-i-performance-deep-caps-match-both-doors.mjs
 */
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, applyCeilings, today } from './_allow.mjs';
import { loadDoorWorld, capabilityPairs, attributeFindings, CAP_KEYS } from './_door-pairs.mjs';

export const UNREADABLE_ID = 'unreadable';

export function decide({ capPairs, boundByField }, allow, todayDate) {
  const { findings, compared, delegating, unreadable } = attributeFindings(capPairs, CAP_KEYS, boundByField);
  if (capPairs.length < 60) throw new CannotAnswer(`only ${capPairs.length} capability pair(s): the capability map was not read`);
  if (delegating < 3) throw new CannotAnswer('no route found delegating to the tool dispatcher: the detector broke');
  if (compared < 15) throw new CannotAnswer(`only ${compared} capability pair(s) resolved to a schema: the call-graph walk or the schema derivation broke`);
  const ceilings = allow.filter((e) => e.id === UNREADABLE_ID);
  const { problem, open, used } = applyAllow(findings, allow.filter((e) => e.id !== UNREADABLE_ID), todayDate);
  if (problem) return violated(problem);
  const measured = applyCeilings([{ id: UNREADABLE_ID, value: unreadable.length, text: `${unreadable.length} route(s) whose tool states a cap validate by hand` }], ceilings, todayDate);
  if (measured.problem) return violated(measured.problem);
  const tail = `${compared} capability pair(s) compared, ${delegating} delegating, ${unreadable.length} hand-validated, ${used + measured.used} exception(s) used`;
  if (measured.over.length) return violated(`${measured.over[0].text}, over its ceiling: give the route a schema this probe can read, or delegate it to the tool: ${unreadable.slice(0, 5).join('; ')} (${tail})`);
  return open.length
    ? violated(`${open.length} cap(s) differ by door: ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`every shared parameter carries the same maximum, maxLength and maxItems on both doors (${tail})`);
}

/** The real tree's input for {@link decide}. */
export async function realInput() {
  const world = await loadDoorWorld();
  return { capPairs: capabilityPairs(world), boundByField: world.BOUND_BY_FIELD };
}

if (isMain(import.meta.url)) {
  await answer(async () => decide(await realInput(), readAllow(allowFileFor(import.meta.url)), today()));
}
