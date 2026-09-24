/**
 * The Networks column on a live instance (`F-34`): tokens below instance admin create, see, change and leave
 * networks by the `networks` rung they hold on the spaces a network carries — and on EVERY one of them.
 *
 * Also the compatibility promise that made the column addable at all: a four-area matrix, minted by a client
 * written before `networks` existed, is still a 201 and reads back with `networks: none`.
 *
 * Run: node --test testing/integration/a-network-act-needs-the-networks-rung-on-every-space.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const S1 = `net-rights-a-${RUN}`;
const S2 = `net-rights-b-${RUN}`;
const FOUR = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

let admin;
const minted = {};

async function mint(name, perSpace) {
  const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `${name}-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace } });
  assert.equal(r.status, 201, `mint ${name}: ${JSON.stringify(r.body)}`);
  return r.body.plaintext;
}
const createNetwork = (token, spaces, label) => post(INSTANCES.a, token, '/api/networks', { label, type: 'closed', spaces, votingDeadlineHours: 24 });

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [S1, S2]) {
    const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  minted.writer = await mint('net-writer', { [S1]: { ...FOUR('none'), networks: 'write' }, [S2]: { ...FOUR('read'), networks: 'none' } });
  minted.reader = await mint('net-reader', { [S1]: { ...FOUR('none'), networks: 'read' } });
  minted.none = await mint('net-none', { [S1]: FOUR('write') });
});

after(async () => {
  const list = await get(INSTANCES.a, admin, '/api/networks');
  for (const n of list.body?.networks ?? []) if (n.label?.endsWith(`-${RUN}`)) await del(INSTANCES.a, admin, `/api/networks/${n.id}`).catch(() => {});
  for (const id of [S1, S2]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

describe('a four-area matrix still mints', () => {
  it('a client that never heard of networks gets a 201, and networks: none', async () => {
    const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `four-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: FOUR('read'), perSpace: { [S1]: FOUR('write') } } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.token?.rights?.floor?.networks, 'none');
    assert.equal(r.body.token?.rights?.perSpace?.[S1]?.networks, 'none');
  });
  it('an unknown area name is still refused', async () => {
    const r = await post(INSTANCES.a, admin, '/api/tokens', { name: `bad-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S1]: { ...FOUR('read'), brain: 'write' } } } });
    assert.equal(r.status, 400);
  });
});

describe('creating, seeing and leaving, by the rung on every space', () => {
  let own;

  it('write on every space creates; one space short is refused, naming it', async () => {
    const ok = await createNetwork(minted.writer, [S1], `own-${RUN}`);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    own = ok.body.id;
    const short = await createNetwork(minted.writer, [S1, S2], `short-${RUN}`);
    assert.equal(short.status, 403);
    assert.match(short.body.error, new RegExp(S2));
  });

  it('read sees it; no rung means it does not exist — a 404, never a 403', async () => {
    const listed = await get(INSTANCES.a, minted.reader, '/api/networks');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.networks.some(n => n.id === own), 'a reader of the space sees its network');
    const hidden = await get(INSTANCES.a, minted.none, '/api/networks');
    assert.ok(!hidden.body.networks.some(n => n.id === own), 'a token with no network rung sees none');
    assert.equal((await get(INSTANCES.a, minted.none, `/api/networks/${own}`)).status, 404);
  });

  it('MCP network_peers answers through the same filter', async () => {
    const session = await openMcpSession(minted.reader);
    const r = await session.callTool('network_peers', {});
    assert.ok(!r?.isError, `a reader was refused the tool: ${JSON.stringify(r)}`);
  });

  it('the settings need admin on every space — write is not enough', async () => {
    const r = await patch(INSTANCES.a, minted.writer, `/api/networks/${own}`, { label: `renamed-${RUN}` });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /admin/);
  });

  it('a membership another token established is not the writer\'s to end', async () => {
    const theirs = await createNetwork(admin, [S1], `theirs-${RUN}`);
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    const r = await del(INSTANCES.a, minted.writer, `/api/networks/${theirs.body.id}`);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /another token/);
  });

  it('its own is', async () => {
    const r = await del(INSTANCES.a, minted.writer, `/api/networks/${own}`);
    assert.ok([200, 204].includes(r.status), `leave: ${r.status} ${JSON.stringify(r.body)}`);
  });
});
