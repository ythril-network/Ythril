/**
 * A record save names its phases on every door and every record kind (bundle-378, Q-976 S3, contract rows 2 and 4).
 *
 * ## The rule
 *
 * A save took about 110 to 125 ms at BSBM 1 000 while a read took 3 to 8 ms, and its answer named only `auth`, `rate` and `door`: where
 * the time went could not be read from the answer. The phases are timed in the shared write path every record door passes
 * (`planAndCommit`, `commitPlans`, the position clock's settled hook, `assertConnections` and `applyConnections`), so a save of any kind,
 * on REST or MCP, names them:
 *
 *  - `read` the planner's read set, `decide` the planner, `version` the versions the write takes, `write` the write under its landing hold,
 *    `index` the triple index's follower after the hold settles, `after` the work after the write lands, `links` the door's relationships;
 *  - REST in its `Server-Timing` header, MCP in the tool result's `_meta` (`ythril/server-timing`).
 *
 * ## Seen red
 *
 * On 17dce733e a save names `auth`, `rate`, `door` and `total` only.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-record-save-names-its-phases-on-every-door-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { serverTimingOf, mcpTimingOf, mcpCallResult } from './_server-timing.mjs';

const skip = await mongoSkipReason();
const A = 'q976-save-phases';
const SAVE_PHASES = ['links', 'read', 'decide', 'version', 'write', 'index', 'after'];
/** An edge IS a relationship: its body names no links or inline edges, so it has no `links` phase of its own. */
const phasesOf = kind => (kind === 'edge' ? SAVE_PHASES.filter(p => p !== 'links') : SAVE_PHASES);
const JSON_TYPE = { 'Content-Type': 'application/json' };
const STARTS = '2026-03-04T05:06:07.000Z';

let d, writer;

describe('a record save names its phases on every door and kind', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q976-save-phases', spaces: [{ id: A }] });
    writer = await d.mint('q976-save-phases-writer', { [A]: d.row({ knowledge: 'write', files: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('every REST record create names the save phases in its Server-Timing', async () => {
    const e = await d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/entities`, { body: JSON.stringify({ name: 'Ada', type: 'Person' }), headers: JSON_TYPE });
    assert.equal(e.status, 201, e.text.slice(0, 300));
    const f = await d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/entities`, { body: JSON.stringify({ name: 'Bob', type: 'Person' }), headers: JSON_TYPE });
    const asks = {
      fact: () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/facts`, { body: JSON.stringify({ fact: 'timed fact', tags: [] }), headers: JSON_TYPE }),
      entity: () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/entities`, { body: JSON.stringify({ name: 'Cy', type: 'Person' }), headers: JSON_TYPE }),
      edge: () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/edges`, { body: JSON.stringify({ from: e.body._id, to: f.body._id, label: 'knows' }), headers: JSON_TYPE }),
      chrono: () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/chrono`, { body: JSON.stringify({ title: 'timed entry', type: 'event', startsAt: STARTS }), headers: JSON_TYPE }),
    };
    const missing = [];
    for (const [kind, ask] of Object.entries(asks)) {
      const r = await ask();
      assert.ok(r.status === 200 || r.status === 201, `${kind}: ${r.status} ${r.text.slice(0, 300)}`);
      const timing = serverTimingOf(r.headers['server-timing']);
      for (const phase of phasesOf(kind)) {
        if (!timing?.has(phase) || !Number.isFinite(timing.get(phase).dur)) missing.push(`${kind}: no ${phase} in ${r.headers['server-timing']}`);
      }
    }
    assert.deepEqual(missing, [], `REST saves without their phases:\n${missing.join('\n')}`);
  });

  it('every MCP record save carries the same phases in its result _meta', async () => {
    const asks = {
      save_fact: { space: A, fact: 'timed fact over mcp' },
      save_entity: { space: A, name: 'Dee', type: 'Person' },
      save_chrono: { space: A, title: 'timed entry over mcp', type: 'event', startsAt: STARTS },
    };
    const missing = [];
    for (const [tool, args] of Object.entries(asks)) {
      const result = await mcpCallResult(d.server.url, writer.key, tool, args);
      assert.ok(result && !result.isError && !result.error, `${tool} failed: ${JSON.stringify(result).slice(0, 300)}`);
      const timing = mcpTimingOf(result);
      for (const phase of SAVE_PHASES) if (!timing?.has(phase)) missing.push(`${tool}: no ${phase} in ${JSON.stringify(result._meta ?? null)}`);
    }
    assert.deepEqual(missing, [], `MCP saves without their phases:\n${missing.join('\n')}`);
  });
});
