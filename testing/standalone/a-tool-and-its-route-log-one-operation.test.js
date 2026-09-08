/**
 * A capability is audited under ONE operation name, whichever door it came through.
 *
 * ## The defect
 *
 * `find_similar` over MCP logged `entity.list`. `POST /api/brain/spaces/:id/find-similar` logged
 * `brain.find_similar`. Same capability, two names, chosen by which door the caller happened to use — so an
 * operator filtering the audit log for `brain.find_similar` saw only REST calls, and one filtering
 * `entity.list` found similarity searches mixed in with entity listings.
 *
 * Neither reading of the log is wrong-looking. That is what makes it expensive: the answer is plausible on
 * both sides, and the only way to notice is to compare the two tables, which is what this does.
 *
 * The comment justifying the odd mapping read *"a vector-similarity search over existing entries — a read of
 * the same records `entity.list` covers"*, which is true and beside the point: `brain.find_similar` already
 * existed, and every sibling already used its own (`query`, `recall`, `traverse`, `get_stats`, `er_model`).
 * A reason that does not know about the alternative is not a decision.
 *
 * ## The rule, and why it is stated this way
 *
 * **If a route operation's last segment names a tool, that tool logs that operation.** Derived from both
 * tables, so a tool or a route added next year is covered without anybody remembering this file.
 *
 * `retry_embedding` is the case that shapes it: the name appears under TWO prefixes, `file.retry_embedding`
 * and `brain.retry_embedding`, and there are two tools — `retry_embedding` for the file one and
 * `retry_record_embedding` for the brain one. Both are right. So an ambiguous suffix is skipped rather than
 * guessed at, and the count of skips is asserted so the exemption cannot quietly grow to cover everything.
 *
 * A tool with NO operation is not this gate's business — `audit-map.ts` carries the reason for each, and a
 * capability that is not audited at all is a different question from one audited twice.
 *
 * Run: node --test testing/standalone/a-tool-and-its-route-log-one-operation.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ROUTE_RULES } = await import('../../server/dist/audit/middleware.js');
const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

/** Route operations grouped by their last segment: `brain.find_similar` → `find_similar`. */
function operationsBySuffix() {
  const bySuffix = new Map();
  for (const rule of ROUTE_RULES) {
    const suffix = rule.operation.split('.').slice(1).join('.');
    if (!suffix) continue;
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, new Set());
    bySuffix.get(suffix).add(rule.operation);
  }
  return bySuffix;
}

describe('a tool and its route log one operation', () => {
  const bySuffix = operationsBySuffix();
  const toolNames = new Set(ALL_TOOLS.map(t => t.name));

  /** Suffixes that name a tool: `[toolName, Set<operation>]`. */
  const candidates = [...bySuffix].filter(([suffix]) => toolNames.has(suffix));

  it('the two tables were both read', () => {
    // A floor. If either import came back empty the loop below would pass having compared nothing, which
    // is the failure mode this repo names most.
    assert.ok(ROUTE_RULES.length > 50, `only ${ROUTE_RULES.length} route rules — the import is wrong`);
    assert.ok(toolNames.size > 30, `only ${toolNames.size} tools — the import is wrong`);
    assert.ok(candidates.length > 5,
      `only ${candidates.length} route operations name a tool — the suffix match is wrong, not the code`);
  });

  it('a tool named by a route operation logs that operation', () => {
    const disagree = [];
    for (const [toolName, operations] of candidates) {
      if (operations.size !== 1) continue;              // ambiguous — see the docblock
      const [operation] = operations;
      const declared = MCP_TOOL_OPERATIONS[toolName];
      if (declared === undefined) continue;             // not audited at all is a different question
      if (declared !== operation) {
        disagree.push(`${toolName} logs '${declared}', its route logs '${operation}'`);
      }
    }
    assert.deepEqual(disagree, [],
      'one capability audited under two names, chosen by which door the caller used — an operator filtering '
      + `the log finds half of what happened:\n  ${disagree.join('\n  ')}`);
  });

  it('and the ambiguous suffixes stay the handful they are', () => {
    /*
     * `retry_embedding` is the only one today: `file.retry_embedding` and `brain.retry_embedding`, with a
     * tool for each. The number is asserted because the skip above is a hole — a naming convention that
     * started reusing suffixes would widen it silently until this gate compared nothing.
     */
    const ambiguous = candidates.filter(([, ops]) => ops.size > 1).map(([name]) => name);
    assert.ok(ambiguous.length <= 1,
      `${ambiguous.length} tool names match more than one route operation, up from 1: ${ambiguous.join(', ')}. `
      + 'Each one is skipped by the case above, so this hole must not grow.');
  });
});
