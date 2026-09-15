/**
 * Every MCP tool is classified for the audit log, and every mutating one produces an entry.
 *
 * ## What was wrong
 *
 * MCP tool calls were not audited at all. `remember`, `save_entity`, `save_bulk`, `delete_space_data` — every
 * write an agent made left the audit log unchanged, while the REST equivalent of each wrote an entry. For
 * a product whose primary write path is an agent, that was most of the trail missing, and the integration
 * guide promised the opposite: *"every authenticated API operation … a full access trail for compliance
 * and security review"*.
 *
 * It was not an oversight nobody had considered. The HTTP audit middleware explicitly admits `/mcp` and
 * then drops it, because no route rule matches. What kept it unnoticed was `audit-route-coverage`, whose
 * `/mcp` exemption read *"MCP has its own tool-level audit path"* — a path that did not exist.
 *
 * ## Why this test is shaped as an EXHAUSTIVE map rather than a list of things to check
 *
 * The original gap survived because the absence of a rule was the default. A tool nobody thought about
 * was silently unaudited. So the map must name **every** registered tool: adding one fails here until it
 * is classified, and `null` — "deliberately not an audited operation" — has to be written down with a
 * reason rather than achieved by omission.
 *
 * That is the same discipline the route gates use for exemptions. Two of those reasons turned out to be
 * false when checked this week (`/api/mfa`, `/mcp`), which is why the reasons here are written to be
 * checkable against the code rather than taken on trust.
 *
 * Run: node --test testing/standalone/mcp-audit-coverage.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

let MCP_TOOL_OPERATIONS, mcpAuditOperation, isMcpReadOperation;
let ALL_TOOLS;

const MIDDLEWARE = 'server/src/audit/middleware.ts';
const ROUTER = 'server/src/mcp/router.ts';

describe('MCP audit coverage', () => {
  before(async () => {
    ({ MCP_TOOL_OPERATIONS, mcpAuditOperation, isMcpReadOperation } =
      await import('../../server/dist/mcp/audit-map.js'));
    ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
  });

  it('finds the tools (the check itself works)', () => {
    // A registry that failed to import would make every assertion below vacuous — the exact failure mode
    // this whole file exists to close.
    assert.ok(Array.isArray(ALL_TOOLS) && ALL_TOOLS.length >= 25,
      `expected the MCP tool registry, found ${ALL_TOOLS?.length}`);
  });

  it('classifies every registered tool — no more, no fewer', () => {
    const registered = ALL_TOOLS.map(t => t.name).sort();
    const classified = Object.keys(MCP_TOOL_OPERATIONS).sort();
    assert.deepEqual(classified, registered,
      'Every MCP tool must be classified in audit-map.ts — with an operation, or with `null` and the ' +
      'reason it is not one. A tool missing from the map is silently unaudited, which is exactly how the ' +
      'entire MCP surface came to be unaudited in the first place.');
  });

  it('every MUTATING tool records an operation', () => {
    const silent = ALL_TOOLS.filter(t => t.mutating && !mcpAuditOperation(t.name)).map(t => t.name);
    assert.deepEqual(silent, [],
      'These tools change data and produce no audit entry. A mutation must be attributable.');
  });

  it('no mutating tool is recorded as a read', () => {
    // A mutation classified as a read would be logged only when `logReads` is on — which is off by
    // default, so it would be silent on almost every instance. Worse than unmapped, because the map
    // would look complete.
    const misfiled = ALL_TOOLS
      .filter(t => t.mutating)
      .map(t => [t.name, mcpAuditOperation(t.name)])
      .filter(([, op]) => op && isMcpReadOperation(op))
      .map(([name, op]) => `${name} → ${op}`);
    assert.deepEqual(misfiled, [], 'a mutating tool must not map to a read operation');
  });

  it('every operation it names is one the REST surface already uses', () => {
    // The point of reusing the vocabulary: the same act through two transports must read the same in the
    // log. An operation that exists only for MCP would split every compliance query in two.
    // `_` is in the character class because operation names contain it — `file.retry_embedding` and
    // `file.retry_embedding_all` are both real REST operations. Without it this regex captured `file.retry`,
    // so the set of "operations REST uses" held a name nothing uses and lacked the two that exist. It went
    // unnoticed because no MCP tool had mapped to an underscored operation yet: a comparison that cannot
    // express part of its own vocabulary reports a mismatch the moment something legitimate arrives.
    const restOperations = new Set(
      [...readFileSync(MIDDLEWARE, 'utf8').matchAll(/operation: '([a-z][a-zA-Z._]+)'/g)].map(m => m[1]),
    );
    // Proof the parse works, rather than trusting a green result: an operation known to exist must be found.
    assert.ok(restOperations.has('file.retry_embedding'),
      'the REST operation parse is broken — it cannot see an operation that is plainly there');
    const invented = [...new Set(Object.values(MCP_TOOL_OPERATIONS))]
      .filter(op => op && !restOperations.has(op));
    assert.deepEqual(invented, [],
      'these operations exist only on the MCP side — reuse the REST vocabulary so entries are comparable');
  });

  it('the dispatcher actually calls the recorder', () => {
    // The map is inert on its own. This is the wiring, and it is the line a refactor would drop.
    const src = readFileSync(ROUTER, 'utf8');
    assert.match(src, /recordToolCall\(name, callSpace, result\?\.isError \? 422 : 200/,
      'the tool dispatcher must record every call, with the status taken from the RESULT');
    assert.match(src, /function recordToolCall\(/, 'the recorder must exist in the dispatcher');
  });

  it('a tool that fails is not recorded as a success', () => {
    // MCP answers 200 at the transport layer even when a tool refuses, so a status read from the HTTP
    // response would log every rejected write as successful. The status has to come from `isError`.
    const src = readFileSync(ROUTER, 'utf8');
    const at = src.indexOf('recordToolCall(name, callSpace');
    assert.ok(at > 0);
    /*
     * The call expression, bounded by its own closing paren. This is the shape where a magic window is at its most
     * dangerous: the assertion is that something is ABSENT, so a window falling short passes by looking at less.
     */
    const call = balancedFrom(src, at, 'the recordToolCall call');
    assert.ok(!/status: 200/.test(call), 'status must not be hardcoded to 200');
  });
});
