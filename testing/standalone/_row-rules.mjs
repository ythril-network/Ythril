/**
 * Every rule of a test row is reported, not only the first one broken: the question "which halves of this rule does the code not hold", answered
 * once for every row that is one rule with several observable halves (bundle-106, act-in-the-middle-of-a-transfer rows).
 *
 * ## What it prevents
 *
 * A row written as a run of `assert` calls stops at the first failure. On the build that does not hold the rule that is the cheapest assertion to
 * fail (usually a fixture-adjacent one), and the red output then says one thing about a rule that is broken in four places. The rows here are red
 * BY DESIGN before the code exists, and the red output is what the implementation is built against, so each row says everything it found.
 *
 * ## What it does not do
 *
 * It collects `that(condition, message)` and fails once in `done()`. A FIXTURE failure (the scenario did not happen, a twin did not hold) is not a
 * rule and stays a plain `assert` before the collector is used: a rule judged over a scenario that never happened would be a lie in either direction.
 */
import assert from 'node:assert/strict';

export function rowRules() {
  const broken = [];
  return {
    /** Record `message` when `condition` is false. */
    that(condition, message) { if (!condition) broken.push(message); },
    /** Fail once, naming every broken rule. */
    done() { assert.deepEqual(broken, [], 'the rules of this row the code does not hold:'); },
  };
}
