/**
 * A retired proxy id answers 410 Gone, code `space_retired`, with one sentence, on every door and to every caller (Q-531, bundle-100,
 * plan rev 3.2 integration vet 9).
 *
 * ## The rule
 *
 * After the upgrade a pre-6.0 proxy id is reserved in `retiredSpaceIds`. It was public before (anyone who could list spaces saw it) and
 * it is not a view, so no privacy rule applies: every caller who names it is told what happened to it, in these words -
 * `'<id>' was a shared proxy and is now personal views; ask the instance admin` - with status 410 and code `space_retired`, on:
 *
 * - every REST route whose path names a space (`ROUTE_RIGHTS` path rows with `:spaceId`, derived, floor; the held-open event stream is
 *   asked through its ticket door),
 * - the body-scoped search routes (`POST /api/brain/recall`, `POST /api/brain/similar`) and the tool door (`POST /api/<tool>`) for every
 *   `TOOL_RIGHTS` tool,
 * - MCP for every `TOOL_RIGHTS` tool (an error result carrying the sentence).
 *
 * The tool set leaves out the `admin`-rung tools: whether a caller may see a tool at all is decided before any space is named, and
 * that is not this rule.
 *
 * The callers are an instance admin, a row-scoped token (which gets 403 for an unknown id today) and a floor token: the answer must
 * not depend on which.
 *
 * ## Seen red at 18e8d598
 *
 * Every door answers the unknown-space answer (`404 Space '<id>' not found`, or 403 for the row-scoped token): `retiredSpaceIds` is a
 * key nothing reads.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-retired-proxy-id-answers-gone-on-every-door-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vr-qa';
const RETIRED = 'vr-team';
const SENTENCE = `'${RETIRED}' was a shared proxy and is now personal views; ask the instance admin`;

let d, callers, ROUTE_RIGHTS, TOOL_RIGHTS;
const fmt = (a) => `${a.status ?? ''} ${(a.text ?? '').slice(0, 160)}`;

describe('a retired proxy id answers 410 space_retired on every door (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-retired-id', spaces: [QA] });
    ({ ROUTE_RIGHTS, TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js'));
    const admin = await d.mint('vr-admin', {}, { admin: true });
    const row = await d.mint('vr-row', { [QA]: d.row({ knowledge: 'write', files: 'write', schema: 'write' }) });
    const floor = await d.tokens.createToken({ name: 'vr-floor', rights: { instanceAdmin: false, createSpaces: false, floor: d.row({ knowledge: 'write', files: 'write' }), perSpace: {} } });
    callers = { admin, row, floor: { key: floor.plaintext, id: floor.record.id } };
    d.loader.mutateConfig(cfg => { cfg.retiredSpaceIds = [RETIRED]; });
  });
  after(async () => { await d?.close(); });

  const gone = (a) => a.status === 410 && a.body?.code === 'space_retired' && a.error === SENTENCE;

  it('every REST route whose path names a space', async () => {
    const paths = ROUTE_RIGHTS.filter(r => r.scope === 'path' && r.route.includes(':spaceId') && !(r.method === 'GET' && r.route.endsWith('/events')));
    assert.ok(paths.length >= 25, `derived ${paths.length} path route(s): the derivation is broken`);
    const wrong = [];
    for (const [who, c] of Object.entries(callers)) {
      for (const r of paths) {
        const url = r.route.replace(':spaceId', RETIRED).replace(/:\w+/g, 'x');
        const a = await d.rest(c.key, r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
        if (!gone(a)) wrong.push(`${who} ${r.method} ${r.route}: ${fmt(a)}`);
      }
    }
    assert.deepEqual(wrong, [], 'path routes that do not answer 410 space_retired with the sentence');
  });

  it('the body-scoped search routes and the tool door for every tool', async () => {
    const tools = TOOL_RIGHTS.filter(r => r.tool !== 'read_spill' && r.needs !== 'admin');
    assert.ok(tools.length >= 25, `derived ${tools.length} tool(s): the derivation is broken`);
    const wrong = [];
    for (const [who, c] of Object.entries(callers)) {
      for (const [url, body] of [['/api/brain/recall', { query: 'x', space: RETIRED }], ['/api/brain/similar', { entryId: 'x', entryType: 'entity', space: RETIRED }]]) {
        const a = await d.rest(c.key, 'POST', url, body);
        if (!gone(a)) wrong.push(`${who} POST ${url}: ${fmt(a)}`);
      }
      for (const t of tools) {
        const a = await d.rest(c.key, 'POST', `/api/${t.tool}`, { space: RETIRED });
        if (!gone(a)) wrong.push(`${who} POST /api/${t.tool}: ${fmt(a)}`);
      }
    }
    assert.deepEqual(wrong, [], 'body doors that do not answer 410 space_retired with the sentence');
  });

  it('MCP for every tool: an error carrying the sentence', async () => {
    const tools = TOOL_RIGHTS.filter(r => r.tool !== 'read_spill' && r.needs !== 'admin');
    const wrong = [];
    for (const [who, c] of Object.entries(callers)) {
      for (const t of tools) {
        const a = await d.mcp(c.key, t.tool, { space: RETIRED });
        if (!(a.isError && a.text.includes(SENTENCE))) wrong.push(`${who} ${t.tool}: ${a.text.slice(0, 160)}`);
      }
    }
    assert.deepEqual(wrong, [], 'MCP tools that do not answer the retired sentence');
  });
});
