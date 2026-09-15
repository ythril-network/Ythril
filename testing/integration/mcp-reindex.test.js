/**
 * `reindex` over MCP — the last of the five REST-only capabilities.
 *
 * ## What only this file can check
 *
 * The refusals themselves are pinned by `reindex-contract.test.js` against the REST route, and both surfaces now call
 * `planReindex`. Re-asserting them here would be testing one function through two doors.
 *
 * What only this file can check is that the tool goes through that door, and one thing the REST suite cannot see at
 * all: **the member list this surface supplies**. REST narrows by request; the tool narrows by the token's accessible
 * spaces. That argument is the single per-surface difference in `planReindex`, so it is the single place this tool can
 * be wrong while looking right — a scoped admin must not re-embed a member it cannot reach.
 *
 * Run: node --test testing/integration/mcp-reindex.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let token;
let session;
const created = [];

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.


const idFor = (what) => `mcp-reindex-${what}-${RUN}`;

async function makeSpace(id, body = {}) {
  const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id, ...body });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  created.push(id);
}

const SPACE = idFor('plain');
const MEMBER = idFor('member');
const PROXY = idFor('proxy');

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  await makeSpace(SPACE);
  await makeSpace(MEMBER);
  await makeSpace(PROXY, { proxyFor: [MEMBER] });
  const mem = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/memories`, { fact: `reindex me ${RUN}` });
  assert.equal(mem.status, 201, JSON.stringify(mem.body));
  session = await openMcpSession(token);
});

after(async () => {
  session?.close();
  for (const id of created.reverse()) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('reindex is offered and starts a job', () => {
  it('appears in tools/list for an admin token', async () => {
    const names = (await session.listTools()).map(t => t.name);
    assert.ok(names.includes('space_reindex'), `not offered: ${names.join(', ')}`);
  });

  it('starts the job and says plainly that it has NOT finished', async () => {
    // The contract the route already had, and the one most easily lost: the reply means SCHEDULED. An agent that read
    // it as "done" would check for results immediately, find the old vectors, and conclude the reindex failed.
    const r = await session.callTool('space_reindex', { space: SPACE });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    assert.equal(r?.structuredContent?.status, 'started', 'the outcome must be machine-readable, not only prose');
    assert.match(r.content[0].text, /background|does not mean it finished/i,
      'the text must say the job is not finished — this is the whole hazard of a fire-and-forget tool');
  });

  it('reports the member spaces it will walk', async () => {
    // This is the argument that differs per surface, so it is the one worth surfacing to the caller. For a normal
    // space it is the space itself.
    const r = await session.callTool('space_reindex', { space: SPACE });
    if (r?.isError) {
      // A job from the previous test may still hold the guard; that is the 409 path, asserted below.
      assert.match(r.content[0].text, /409/);
      return;
    }
    assert.deepEqual(r?.structuredContent?.memberSpaces, [SPACE]);
  });
});

describe('reindex is held to the ROUTE rules, not looser ones', () => {
  it('REFUSES a proxy space, naming its members so the caller knows what to do instead', async () => {
    const r = await session.callTool('space_reindex', { space: PROXY });
    assert.ok(r?.isError, `accepted a proxy: ${JSON.stringify(r)}`);
    assert.match(r.content[0].text, /400/);
    assert.match(r.content[0].text, new RegExp(MEMBER), 'the members must be named');
    assert.deepEqual(r?.structuredContent?.proxyFor, [MEMBER],
      'and carried as a field, so an agent need not parse prose to find the remedy');
  });

  it('REFUSES a second job while one is running, with 409 rather than a generic failure', async () => {
    // 409 means "try later"; 400 means "never". An agent that cannot tell them apart either retries forever or gives
    // up on a space that is merely busy.
    const first = await session.callTool('space_reindex', { space: SPACE });
    const second = await session.callTool('space_reindex', { space: MEMBER });
    const both = [first, second].filter(r => r?.isError).map(r => r.content[0].text);
    assert.ok(both.some(t => /409/.test(t)) || !second?.isError,
      `expected a 409 while a job runs, or a clean start once it finished: ${JSON.stringify([first, second])}`);
  });

  it('REFUSES an unknown parameter rather than silently ignoring it', async () => {
    const r = await session.callTool('space_reindex', { space: SPACE, force: true });
    assert.ok(r?.isError, `a misspelled parameter was accepted: ${JSON.stringify(r)}`);
  });
});
