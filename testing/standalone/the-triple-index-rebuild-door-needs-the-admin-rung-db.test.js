/**
 * An admin door rebuilds one space's triple index, on MCP (`space_rdf_rebuild`) and on REST (`POST /api/space_rdf_rebuild`), at the
 * knowledge area's admin rung, and the index's status is readable (`space_rdf_index`) (bundle-273, Q-764 slice S4; contract row 6).
 *
 * ## The rules
 *
 * 1. **The admin rung.** A token with `knowledge: write` on the space is refused the rebuild on both doors, and its index is not touched.
 * 2. **One space.** A token with `knowledge: admin` on the space starts a rebuild of that space alone on either door; the status read
 *    names the new build once it is swapped in and ready, and the other space's index keeps its build.
 *
 * ## Seen red
 *
 * On 65080cae3 (no door): the writer's refusal holds for the wrong reason (no such tool), and the admin's start fails at the first door
 * (`space_rdf_rebuild` is an unknown tool).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-rebuild-door-needs-the-admin-rung-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { elapse } from '../_shared/sleep.mjs';
import { waitForReading } from '../_shared/wait-for.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-door';
const OTHER = 'tixb-door-other';
let d;

/** `POST /api/<tool>` with `args`: status and the answer's data. */
async function toolDoor(key, tool, args) {
  const r = await fetch(`${d.server.url}/api/${tool}`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: body?.data ?? body, text };
}

const buildOf = async (space) => (await d.col(`${space}_rdf_state`).findOne({ _id: 'state' }))?.buildId;

/** Poll `space_rdf_index` on MCP until the index is ready on a build other than `was` and no rebuild runs; answers the status. */
async function readyAfter(key, space, was) {
  const read = async () => {
    const m = await d.toolCall(key, 'space_rdf_index', { space });
    assert.equal(m.isError, false, m.text);
    return m.structured;
  };
  const fresh = (s) => s.status === 'ready' && s.buildId && s.buildId !== was && s.rebuilding === false;
  return waitForReading(read, fresh, 10_000, 50, { what: `the index of ${space} ready on a build other than ${was}` });
}

describe('the triple index rebuild door needs the admin rung', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-door', spaces: [{ id: S, meta: rdfMeta(S) }, { id: OTHER, meta: rdfMeta(OTHER) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }, { id: OTHER }]);
    for (const space of [S, OTHER]) {
      await landAll(d, space, Array.from({ length: 10 }, (_, i) => ['entities', entityDoc(space, `p${i}`, `Person ${i}`, 'person')]));
      await followUntilReady(d, space);
    }
  });
  after(async () => { await d?.close(); });

  it('a token with knowledge: write is refused on both doors, and the index is not touched', async () => {
    const writer = await d.mint('tixb-door-writer', { [S]: d.row({ knowledge: 'write' }) });
    const was = await buildOf(S);
    const mcp = await d.toolCall(writer.key, 'space_rdf_rebuild', { space: S });
    assert.equal(mcp.isError, true, `MCP refuses the writer: ${mcp.text}`);
    assert.match(mcp.text, /admin/i, `the refusal names the rung: ${mcp.text}`);
    const rest = await toolDoor(writer.key, 'space_rdf_rebuild', { space: S });
    assert.equal(rest.status, 403, `REST refuses the writer: ${rest.text}`);
    await elapse(200, 'absence window: a rebuild the refused calls had started would have swapped in by now');
    assert.equal(await buildOf(S), was, 'the index was not rebuilt');
  });

  it('a token with knowledge: admin rebuilds that one space on either door, and the status names the new build', async () => {
    const owner = await d.mint('tixb-door-admin', { [S]: d.row({ knowledge: 'admin' }) });
    const other = await buildOf(OTHER);

    const was = await buildOf(S);
    const rest = await toolDoor(owner.key, 'space_rdf_rebuild', { space: S });
    assert.equal(rest.status, 200, rest.text);
    assert.equal(rest.body?.spaceId, S, rest.text);
    const first = await readyAfter(owner.key, S, was);
    assert.equal(first.spaceId, S);
    assert.equal(await buildOf(S), first.buildId, 'the status reads the stored build');

    const mcp = await d.toolCall(owner.key, 'space_rdf_rebuild', { space: S });
    assert.equal(mcp.isError, false, mcp.text);
    assert.equal(mcp.structured?.spaceId, S, mcp.text);
    const second = await readyAfter(owner.key, S, first.buildId);
    assert.notEqual(second.buildId, first.buildId, 'the MCP door rebuilt it again');

    assert.equal(await buildOf(OTHER), other, 'the other space keeps its build');
  });
});
