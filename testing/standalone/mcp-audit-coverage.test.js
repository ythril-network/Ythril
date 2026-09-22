/**
 * Every MCP tool is classified for the audit log, and every mutating one produces an entry.
 *
 * ## What was wrong
 *
 * MCP tool calls were not audited at all. `saveFact`, `save_entity`, `save_bulk`, `delete_space_data` — every
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
import { DISPATCH_SOURCES } from './_tool-dispatch.mjs';
import { readFileSync } from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

let MCP_TOOL_OPERATIONS, MCP_OPERATION_SUBJECTS, mcpAuditOperation, isMcpReadOperation;
let ALL_TOOLS;

const MIDDLEWARE = 'server/src/audit/middleware.ts';
/*
 * The DISPATCH, not the door. `recordToolCall` moved into `mcp/call-tool.ts` when both doors started
 * calling one function — and an audit entry written by the dispatch is what makes a tool call logged
 * identically whichever door it arrived at.
 */
const ROUTER = DISPATCH_SOURCES[0];

describe('MCP audit coverage', () => {
  before(async () => {
    ({ MCP_TOOL_OPERATIONS, MCP_OPERATION_SUBJECTS, mcpAuditOperation, isMcpReadOperation } =
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

  /*
   * A CAPABILITY WITH TWO SUBJECTS IS AUDITED UNDER THE SUBJECT OF THE CALL, NOT THE FIRST NAME IN ITS
   * LIST — `Q-37`.
   *
   * A list in the map says which REST operations one capability is reachable through, and the first
   * entry was what every call was written under. `network_sync` with a `peerId` does exactly what
   * `POST /api/networks/peers/:peerId/sync` does, and that route records `peer.sync_trigger`; the tool
   * recorded `network.sync_trigger` for both subjects, because the resolver only ever saw the tool NAME.
   *
   * So an operator filtering the audit log for `peer.sync_trigger` saw the browser's peer syncs and none
   * of the agent's — the defect `a-tool-and-its-route-log-one-operation` exists for, one level down, and
   * invisible to it because the tool's first operation IS a name a route records.
   *
   * These cases assert the RULE rather than the one tool: every chooser resolves within its own list,
   * for every tool that has one, and a chooser that throws falls back rather than dropping the entry.
   */
  it('every tool with a chooser resolves to one of its OWN declared operations', () => {
    const choosers = Object.keys(MCP_OPERATION_SUBJECTS);
    assert.ok(choosers.length >= 1, 'no chooser is declared — this case is measuring nothing');

    for (const tool of choosers) {
      const declared = MCP_TOOL_OPERATIONS[tool];
      assert.ok(Array.isArray(declared),
        `${tool} has a chooser and a single operation. A chooser picks BETWEEN the names a capability is `
        + 'reachable through, so the map entry has to be the list it picks from');

      // Both shapes a real call takes, and the empty one a caller may send.
      for (const args of [undefined, {}, { peerId: 'a-peer' }, { networkId: 'a-network' }]) {
        const op = mcpAuditOperation(tool, args);
        assert.ok(declared.includes(op),
          `${tool} resolved to "${op}" for ${JSON.stringify(args)}, which is not one of its declared `
          + `operations ${JSON.stringify(declared)} — an audit name no route records is unqueryable`);
      }
    }
  });

  it('a chooser that throws falls back to the first name, because an UNAUDITED call is worse', () => {
    /*
     * The direction this must not fail in. Handing the arguments to the resolver turns a static table
     * into a function of untrusted input; a chooser that throws on a shape nobody anticipated must not
     * take the audit entry with it. Exercised with a value that is not an object at all.
     */
    for (const tool of Object.keys(MCP_OPERATION_SUBJECTS)) {
      const first = MCP_TOOL_OPERATIONS[tool][0];
      for (const hostile of [null, 'a string', 42, [], Object.create(null)]) {
        assert.equal(mcpAuditOperation(tool, hostile), first,
          `${tool} did not fall back to "${first}" for ${JSON.stringify(hostile)}`);
      }
    }
  });

  it('syncing ONE peer is audited under the operation that route records', () => {
    // The site, kept as ONE case beside the rule above: the rule cannot say which subject is which, and
    // a chooser that returned the wrong member of its own list would satisfy every assertion but this.
    assert.equal(mcpAuditOperation('network_sync', { peerId: 'p1' }), 'peer.sync_trigger');
    assert.equal(mcpAuditOperation('network_sync', {}), 'network.sync_trigger');
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
    // Flattened: a value may be a LIST when one capability's REST half is more than one route. Comparing
    // an array against the vocabulary reports the array itself as invented, which reads as a broken parse.
    const invented = [...new Set(Object.values(MCP_TOOL_OPERATIONS).flat())]
      .filter(op => op && !restOperations.has(op));
    assert.deepEqual(invented, [],
      'these operations exist only on the MCP side — reuse the REST vocabulary so entries are comparable');
  });

  it('the dispatcher actually calls the recorder', () => {
    // The map is inert on its own. This is the wiring, and it is the line a refactor would drop.
    const src = readFileSync(ROUTER, 'utf8');
    assert.match(src, /const status = result\?\.isError \? 422 : 200;/,
      'the audit status must be taken from the RESULT, not from the transport');
    assert.match(src, /recordToolCall\(caller, name, callSpace, status,/,
      'the dispatch must record every call, whichever door it arrived at');
    assert.match(src, /function recordToolCall\(/, 'the recorder must exist in the dispatch');
  });

  it('a tool that fails is not recorded as a success', () => {
    // MCP answers 200 at the transport layer even when a tool refuses, so a status read from the HTTP
    // response would log every rejected write as successful. The status has to come from `isError`.
    const src = readFileSync(ROUTER, 'utf8');
    const at = src.indexOf('recordToolCall(caller, name, callSpace');
    assert.ok(at > 0);
    /*
     * The call expression, bounded by its own closing paren. This is the shape where a magic window is at its most
     * dangerous: the assertion is that something is ABSENT, so a window falling short passes by looking at less.
     */
    const call = balancedFrom(src, at, 'the recordToolCall call');
    assert.ok(!/status: 200/.test(call), 'status must not be hardcoded to 200');
  });
});
