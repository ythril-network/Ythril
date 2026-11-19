import { RULE_LIMITS } from './rule-limits';

/**
 * The bounds on a conversion's steps, as the step editor shows and enforces them (bundle-285, Q-747).
 *
 * The editor offers "add a step", "add a condition" and a map of values, and refuses past each bound. These numbers are a SECOND COPY of the
 * constants the server enforces in `schema/src/conversion-steps.ts` and `schema/src/space-meta.ts`, and a copy is acceptable only while
 * something compares it: `testing/client-limits-match-the-server.spec.ts` reads both and fails when they differ, so an editor cannot offer a
 * twenty-first case against a server that stops at twenty and then refuse the save (400 `bad_conversion_step`). Only bounds the server also
 * refuses are copied: everything else a step says is the server's to judge, and its sentence is shown under the row.
 *
 * The keys: `stepsMax` the most steps one conversion holds, `valuesMax` the most values one map holds, `casesMax` the most cases one split
 * holds, `typeNameMax` the longest type name a step may name, and `conditionMax` the longest condition: a split's `when` is judged as a
 * rule, so it is the rule limit itself, not a number of its own.
 */
const STEPS_MAX = 50;
const VALUES_MAX = 200;
const CASES_MAX = 20;
const TYPE_NAME_MAX = 200;

export const CONVERSION_LIMITS = {
  stepsMax: STEPS_MAX,
  valuesMax: VALUES_MAX,
  casesMax: CASES_MAX,
  typeNameMax: TYPE_NAME_MAX,
  conditionMax: RULE_LIMITS.ruleMax,
} as const;
