/**
 * Every operation the audit log can record is named in the guide's operations table.
 *
 * ## What was wrong
 *
 * `docs/integration-guide/13-audit-log-api.md` opens by promising *"an append-only, immutable audit log
 * of every authenticated API operation … a full access trail for compliance and security review"*, and
 * then lists the operations in a table. Measured 2026-09-22: the table named **53 of the 115** the code
 * records. 62 were missing — every `conflict.*` and `contradiction.*`, all of `data.*` (backup, restore,
 * maintenance, migrate), all of `schema_library.*`, `token.update`, `token.regenerate`, `link.create`
 * and `link.delete` among them.
 *
 * An integrator building an audit query works from that table, so **an operation absent from it is a
 * filter nobody writes** — and the absence is invisible from both ends: the log contains the entries, and
 * the page looks complete.
 *
 * ## Why this is a gate rather than a corrected table
 *
 * The table was last correct at a release nobody can name. Completing it by hand produces the same defect
 * with a later date, which is this repo's most-repeated shape — see *A count in prose is the fastest rot*
 * and *A gate concludes about MORE than it checks*. The set is derivable from the two places that decide
 * it, so it is derived.
 *
 * It was found the way it should be found: `Q-37` changed which operation one tool records, and checking
 * that its two names were documented meant deriving the set. The two were missing.
 *
 * ## The two sources, and why both
 *
 * An operation reaches the log through exactly one of them:
 *
 *  - `ROUTE_RULES` in `audit/middleware.ts` — the REST half, matched per request by method and path.
 *  - `AUTH_FAILED_OPERATION` — the one entry no route rule produces, because a rejected credential is
 *    refused before any handler and so has no route to match. It was found by this gate's own
 *    phantom check reporting it as documented-but-unrecordable, which is the check earning its
 *    place: two sources looked like all of them.
 *  - `MCP_TOOL_OPERATIONS` in `mcp/audit-map.ts` — the tool half, which the dispatch writes for both
 *    doors. A LIST there names a capability whose REST half is more than one route, and **every member
 *    of the list is reachable**, so all of them are documented rather than the first.
 *
 * Reading one would conclude about both, which is the failure this file's own rule warns against.
 *
 * ## The window is the TABLE, and that is the trap
 *
 * Several operations are named in that page's PROSE — `space.update` in the `changes` section,
 * `brain.find_similar` in the paragraph about the one pair that differs, `audit.export` in its own
 * paragraph. A substring check over the whole file therefore passes while the table stays short, which is
 * exactly the reassurance this gate exists to withhold.
 *
 * So the window is the contiguous run of table rows under the `### Tracked operations` heading, found
 * structurally — by heading and by the `|` that starts a row — never by a character offset, which lands
 * on a different line on a CRLF working copy than in CI's LF checkout.
 *
 * Run: node --test testing/standalone/every-audited-operation-is-documented.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GUIDE = 'docs/integration-guide/13-audit-log-api.md';
const HEADING = '### Tracked operations';

let ROUTE_RULES, AUTH_FAILED_OPERATION, CONFIG_RELOAD_OPERATIONS, MCP_TOOL_OPERATIONS;

/**
 * The rows of the operations table, as one string.
 *
 * Structural on both ends: it starts at the heading and takes the contiguous run of lines beginning with
 * `|`, so prose above or below the table is outside the window by construction rather than by a count of
 * characters somebody has to keep right.
 */
function operationsTable(src) {
  const lines = src.split(/\r?\n/);
  const at = lines.findIndex(l => l.trim() === HEADING);
  assert.ok(at >= 0, `${GUIDE} has no "${HEADING}" heading — this gate measures nothing`);

  const rows = [];
  let seen = false;
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('|')) { rows.push(line); seen = true; continue; }
    if (seen) break;                       // the run has ended; prose after it is not the table
  }
  return rows.join('\n');
}

/** Every operation either door can write, derived from the two places that decide it. */
function auditedOperations() {
  const ops = new Set();
  for (const rule of ROUTE_RULES) if (rule.operation) ops.add(rule.operation);
  ops.add(AUTH_FAILED_OPERATION);
  for (const op of Object.values(CONFIG_RELOAD_OPERATIONS)) ops.add(op);
  for (const value of Object.values(MCP_TOOL_OPERATIONS)) {
    if (!value) continue;                  // `null` is "deliberately not an audited operation"
    for (const op of (Array.isArray(value) ? value : [value])) ops.add(op);
  }
  return ops;
}

describe('every audited operation is documented', () => {
  before(async () => {
    ({ ROUTE_RULES, AUTH_FAILED_OPERATION, CONFIG_RELOAD_OPERATIONS } = await import('../../server/dist/audit/middleware.js'));
    ({ MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js'));
  });

  it('finds both sources and the table (the check itself works)', () => {
    /*
     * Three floors, because each half can fail to nothing independently and an empty set passes every
     * loop written over it. The numbers are floors rather than counts on purpose — a count here is a
     * second copy of a fact the code already holds, and it is the assertion that goes stale first.
     */
    assert.ok(Array.isArray(ROUTE_RULES) && ROUTE_RULES.length >= 80,
      `expected the REST audit rules, found ${ROUTE_RULES?.length}`);
    assert.ok(Object.keys(MCP_TOOL_OPERATIONS ?? {}).length >= 25,
      `expected the MCP audit map, found ${Object.keys(MCP_TOOL_OPERATIONS ?? {}).length}`);
    assert.ok(auditedOperations().size >= 100,
      `expected the operations both doors record, found ${auditedOperations().size}`);

    const table = operationsTable(readFileSync(GUIDE, 'utf8'));
    assert.ok(table.split('\n').length >= 10, 'the operations table has almost no rows in it');
  });

  it('names every one of them IN THE TABLE, not merely somewhere on the page', () => {
    const table = operationsTable(readFileSync(GUIDE, 'utf8'));
    const missing = [...auditedOperations()].filter(op => !table.includes(`\`${op}\``)).sort();

    assert.deepEqual(missing, [],
      `${missing.length} operation(s) the code records are not in the guide's table. An integrator `
      + 'builds an audit query from that table, so an operation absent from it is a filter nobody '
      + 'writes — and the gap is invisible from both ends, because the log holds the entries and the '
      + 'page looks complete.\n      Add each to its category row, in backticks.');
  });

  it('and names nothing the code cannot record, so the table is not aspirational either', () => {
    /*
     * The other direction, and it is the half that would otherwise rot silently. A removed capability
     * leaves its operation in the table, and an integrator filters for an entry that can never appear —
     * which reads as "this never happens here" rather than as a stale document.
     *
     * Scoped to the operation SHAPE (`a.b`, lowercase, dots and underscores) so a row's prose is not
     * mistaken for a claim about an operation.
     */
    const table = operationsTable(readFileSync(GUIDE, 'utf8'));
    const ops = auditedOperations();
    const named = [...table.matchAll(/`([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)`/g)].map(m => m[1]);
    assert.ok(named.length >= 50, `the table names ${named.length} operations — it has stopped matching`);

    const phantom = [...new Set(named.filter(op => !ops.has(op)))].sort();
    assert.deepEqual(phantom, [],
      'the table names operation(s) no route rule and no tool records. Either the capability was removed '
      + 'and its row outlived it, or the name is a typo — both read to an integrator as an entry that '
      + 'simply never occurs on this instance.');
  });
});
