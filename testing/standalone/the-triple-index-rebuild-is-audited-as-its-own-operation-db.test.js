/**
 * A rebuild of a space's triple index is audited as its own operation, `space.rdf.rebuild`, on every door, and the audit guide lists it
 * (bundle-273, Q-764 slice S4; contract row 6).
 *
 * ## The rules
 *
 * 1. **One operation, every door.** The MCP tool `space_rdf_rebuild`, the tool door `POST /api/space_rdf_rebuild` and the REST route
 *    `POST /api/brain/spaces/:spaceId/rdf-index/rebuild` each leave one audit row of `space.rdf.rebuild` for the space, and none of them is
 *    written under another rebuild's name (`space.reindex` re-embeds the space's records: an audit query for it must not find this).
 * 2. **The REST route is the tool's twin.** It answers what the tool answers (`status`, `spaceId`), needs the knowledge `admin` rung, and
 *    refuses a writer `403`.
 * 3. **The guide's audit table names it**, in the Space row of `docs/integration-guide/13-audit-log-api.md`.
 *
 * ## Seen red
 *
 * On 2b166cbe2 (the tool audited as `space.rdf.rebuild`, no REST route, the guide silent): rule 1 fails at the REST route (`404`).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-rebuild-is-audited-as-its-own-operation-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { waitForReading } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-audit';
const OP = 'space.rdf.rebuild';
const GUIDE = new URL('../../docs/integration-guide/13-audit-log-api.md', import.meta.url);
let d, owner;

/** `POST <path>` with a JSON body: status and the answer's data. */
async function post(key, path, args) {
  const r = await d.sparqlRest(key, 'POST', path, { body: JSON.stringify(args), headers: { 'Content-Type': 'application/json' } });
  return { status: r.status, body: r.body?.data ?? r.body, text: r.text };
}

/** Wait until no rebuild of S runs, so the next door starts one of its own. */
async function settled() {
  const read = async () => (await d.toolCall(owner.key, 'space_rdf_index', { space: S })).structured;
  await waitForReading(read, s => s?.rebuilding === false && s?.status === 'ready', 15_000, 50, { what: `the index of ${S} ready with no rebuild running` });
}

describe('a triple index rebuild is audited as its own operation', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-audit', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: 10 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    await followUntilReady(d, S);
    owner = await d.mint('tixb-audit-admin', { [S]: d.row({ knowledge: 'admin' }) });
  });
  after(async () => { await d?.close(); });

  it('the MCP tool, the tool door and the REST route each leave one space.rdf.rebuild row, and none another name', async () => {
    const was = (await auditRowsOf(d.door.mongo, { operation: OP })).length;
    const reindexWas = (await auditRowsOf(d.door.mongo, { operation: 'space.reindex' })).length;

    const mcp = await d.toolCall(owner.key, 'space_rdf_rebuild', { space: S });
    assert.equal(mcp.isError, false, mcp.text);
    await settled();
    const tool = await post(owner.key, '/api/space_rdf_rebuild', { space: S });
    assert.equal(tool.status, 200, tool.text);
    await settled();
    const rest = await post(owner.key, `/api/brain/spaces/${S}/rdf-index/rebuild`, {});
    assert.equal(rest.status, 200, rest.text);
    assert.equal(rest.body?.spaceId, S, rest.text);
    assert.ok(['started', 'running'].includes(rest.body?.status), rest.text);
    await settled();

    const rows = (await auditRowsOf(d.door.mongo, { operation: OP })).slice(was);
    assert.deepEqual(rows.map(r => r.method).sort(), ['MCP', 'POST', 'POST'], `rows of ${OP}: ${rows.map(r => `${r.method} ${r.path}`).join(', ')}`);
    assert.ok(rows.every(r => r.spaceId === S), `every row names the space: ${rows.map(r => r.spaceId).join(', ')}`);
    assert.equal((await auditRowsOf(d.door.mongo, { operation: 'space.reindex' })).length, reindexWas, 'a rebuild was written as a re-embed');
  });

  it('the REST route needs the knowledge admin rung', async () => {
    const writer = await d.mint('tixb-audit-writer', { [S]: d.row({ knowledge: 'write' }) });
    const r = await post(writer.key, `/api/brain/spaces/${S}/rdf-index/rebuild`, {});
    assert.equal(r.status, 403, r.text);
  });

  it('the guide\'s audit table names the operation in its Space row', () => {
    const row = readFileSync(GUIDE, 'utf8').split('\n').find(l => l.startsWith('| Space |'));
    assert.ok(row, 'the audit table has a Space row');
    assert.ok(row.includes(`\`${OP}\``), `the Space row names \`${OP}\``);
  });
});
