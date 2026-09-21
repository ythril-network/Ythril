/**
 * A capability is audited under ONE operation name, whichever door it came through.
 *
 * ## The defect
 *
 * `similar` over MCP logged `entity.list`. `POST /api/brain/spaces/:id/find-similar` logged
 * `brain.find_similar`. Same capability, two names, chosen by which door the caller happened to use — so an
 * operator filtering the audit log for `brain.find_similar` saw only REST calls, and one filtering
 * `entity.list` found similarity searches mixed in with entity listings.
 *
 * Neither reading of the log is wrong-looking. That is what makes it expensive: the answer is plausible on
 * both sides, and the only way to notice is to compare the two tables, which is what this does.
 *
 * The comment justifying the odd mapping read *"a vector-similarity search over existing entries — a read of
 * the same records `entity.list` covers"*, which is true and beside the point: `brain.find_similar` already
 * existed, and every sibling already used its own (`query`, `recall`, `traverse`, `space_stats`, `er_model`).
 * A reason that does not know about the alternative is not a decision.
 *
 * ## The rule, and why it is stated this way
 *
 * **If a route operation's last segment names a tool, that tool logs that operation.** Derived from both
 * tables, so a tool or a route added next year is covered without anybody remembering this file.
 *
 * `retry_embed_file` is the case that shapes it: the name appears under TWO prefixes, `file.retry_embedding`
 * and `brain.retry_embedding`, and there are two tools — `retry_embed_file` for the file one and
 * `retry_embed_record` for the brain one. Both are right. So an ambiguous suffix is skipped rather than
 * guessed at, and the count of skips is asserted so the exemption cannot quietly grow to cover everything.
 *
 * A tool with NO operation is not this gate's business — `audit-map.ts` carries the reason for each, and a
 * capability that is not audited at all is a different question from one audited twice.
 *
 * ## A ROUTE DELETION is the other way this breaks, and it is the quiet one
 *
 * A tool's operation is only shared with its REST half while the route recording it still exists.
 * `network_sync` was paired with `sync.trigger`, the operation `POST /api/notify/trigger` recorded; 5.0
 * removed that route, and without moving the pairing the name would have become one only the MCP door ever
 * writes. An operator filtering by what REST records sees no agent traffic, and the cross-door PARAMETER
 * parity gate reports nothing either, because an unpaired tool is skipped there. A gate that skips is a
 * gate that passes. The first case below is what refuses it.
 *
 * Run: node --test testing/standalone/a-tool-and-its-route-log-one-operation.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ROUTE_RULES } = await import('../../server/dist/audit/middleware.js');
const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

/** Route operations grouped by their last segment: `brain.find_similar` → `similar`. */
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

  /*
   * THE JOIN IS THE DECLARED MAP, NOT A STRING COINCIDENCE.
   *
   * This paired a route operation to a tool when the operation's SUFFIX equalled the tool's name —
   * `space.reindex` to `reindex`, `brain.wipe_space` to `wipe_space`. That held only while tools were named
   * after the verb alone. A-1 renamed them to the verb-first scheme (`space_reindex`,
   * `delete_space_data`), the suffixes stopped matching, and the gate reported "the suffix match is wrong,
   * not the code" — correctly, about itself.
   *
   * `MCP_TOOL_OPERATIONS` is the authoritative statement of which operation a tool logs, and the suffix was
   * always a heuristic standing in for it. Joining through the map instead means the gate survives any
   * naming scheme, which is the property it should have had: the RULE is that one capability is audited
   * under one name, and neither half of that rule mentions spelling.
   */
  /*
   * A VALUE MAY BE A LIST, and every name in it has to be real rather than just the first.
   *
   * One capability's REST half can be more than one route: `network_sync` runs a full cycle or syncs one
   * named peer, and REST spells those apart because a path has to name its subject. Flattened here, so the
   * comparison below is against each operation and not against a joined array — which reported
   * `'network.sync_trigger,peer.sync_trigger'` as a name no route emits, a finding that reads as the gate
   * being broken rather than as the thing it is for.
   */
  const candidates = Object.entries(MCP_TOOL_OPERATIONS)
    .filter(([tool, op]) => op && toolNames.has(tool))
    .flatMap(([tool, op]) => (Array.isArray(op) ? op : [op]).map(one => [tool, one]));

  /** Every operation any ROUTE logs, so a tool's declared one can be checked against reality. */
  const routeOperations = new Set(ROUTE_RULES.map(r => r.operation));

  it('the two tables were both read', () => {
    // A floor. If either import came back empty the loop below would pass having compared nothing, which
    // is the failure mode this repo names most.
    assert.ok(ROUTE_RULES.length > 50, `only ${ROUTE_RULES.length} route rules — the import is wrong`);
    assert.ok(toolNames.size > 30, `only ${toolNames.size} tools — the import is wrong`);
    assert.ok(candidates.length > 20,
      `only ${candidates.length} tools declare an audited operation — the map is not being read`);
  });

  it('every operation a tool declares is one a ROUTE actually logs', () => {
    /*
     * The rule, and the reason it is worth a gate: one capability must be audited under ONE name whichever
     * door the caller used. A tool declaring an operation no route emits means the same act appears in the
     * log under two names, and an operator filtering for one of them finds half of what happened.
     *
     * Asserted through `MCP_TOOL_OPERATIONS` rather than by matching an operation's SUFFIX against a tool
     * name, which is what this did before. That worked only while tools were named after the verb alone —
     * `space.reindex` to `reindex` — and A-1's verb-first rename broke it, correctly reporting that the
     * suffix match was wrong rather than the code. Spelling was never the rule.
     */
    const orphans = candidates
      .filter(([, op]) => !routeOperations.has(op))
      .map(([tool, op]) => `${tool} logs '${op}', which no route emits`);
    assert.deepEqual(orphans, [],
      `a capability audited under a name only one door uses:\n  ${orphans.join('\n  ')}`);
  });

  it('and no two tools claim the same operation unless they are the same capability', () => {
    /*
     * The other direction. Two tools logging one operation is legitimate when they ARE one capability
     * behind two spellings — the file and record embed retries were the standing example — and a defect
     * when they are not, because the log then cannot distinguish them.
     *
     * Counted rather than named, because the count is the thing that must not grow quietly; each addition
     * is a decision somebody should have to make on purpose.
     */
    const byOperation = new Map();
    for (const [tool, op] of candidates) {
      byOperation.set(op, [...(byOperation.get(op) ?? []), tool]);
    }
    const shared = [...byOperation].filter(([, tools]) => tools.length > 1);
    assert.ok(shared.length <= 3,
      `${shared.length} operations are claimed by more than one tool, up from at most 3: `
      + shared.map(([op, tools]) => `${op} <- ${tools.join(', ')}`).join('; '));
  });
});
