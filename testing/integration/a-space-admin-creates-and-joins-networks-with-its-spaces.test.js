/**
 * A space admin creates, invites into and joins networks with the spaces it administers (`F-37`), live across two
 * instances: A creates and invites, B joins.
 *
 * Owner, 2026-09-25: *"Space admin may create networks for his space and join network mapped onto his space; or a
 * new space if he also has can create space"* — plural when it administers several. No Networks column is granted
 * to any token here: space administration alone is what is being tested. Everything else stays as it was, so a
 * space it does not administer is refused and named, and a network carrying one is invisible to it.
 *
 * Run: node --test testing/integration/a-space-admin-creates-and-joins-networks-with-its-spaces.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const S1 = `f37-one-${RUN}`;
const S2 = `f37-two-${RUN}`;
const OTHER = `f37-other-${RUN}`;
const FRESH = `f37-fresh-${RUN}`;

let adminA, adminB;
const cleanup = { a: [], b: [] };

before(async () => {
  adminA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  adminB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const id of [S1, S2, OTHER, FRESH]) {
    const r = await post(INSTANCES.a, adminA, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  for (const id of [S1, S2]) {
    const r = await post(INSTANCES.b, adminB, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});

after(async () => {
  for (const id of cleanup.a) await del(INSTANCES.a, adminA, `/api/networks/${id}`).catch(() => {});
  for (const id of cleanup.b) await del(INSTANCES.b, adminB, `/api/networks/${id}`).catch(() => {});
  for (const id of [S1, S2, OTHER, FRESH]) {
    await delWithBody(INSTANCES.a, adminA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, adminB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

/** A token that administers `spaces` and holds nothing else — no Networks column, no floor. */
async function spaceAdmin(inst, admin, name, spaces, over = {}) {
  const r = await post(inst, admin, '/api/tokens', { name: `${name}-${RUN}`, rights: {
    instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces }, ...over } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.plaintext;
}

describe('on the inviting instance', () => {
  let owner, networkId;
  before(async () => { owner = await spaceAdmin(INSTANCES.a, adminA, 'f37-owner', [S1, S2]); });

  it('creates a network carrying several of its spaces', async () => {
    const r = await post(INSTANCES.a, owner, '/api/networks', { label: `f37-${RUN}`, type: 'closed', spaces: [S1, S2], votingDeadlineHours: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    networkId = r.body.id;
    cleanup.a.push(networkId);
  });
  it('sees the network it created', async () => {
    const r = await get(INSTANCES.a, owner, `/api/networks/${networkId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  it('generates the invite that makes it joinable', async () => {
    const r = await post(INSTANCES.a, owner, '/api/invite/generate', { networkId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  it('is refused a network carrying a space it does not administer, and that space is named', async () => {
    const r = await post(INSTANCES.a, owner, '/api/networks', { label: `f37-mixed-${RUN}`, type: 'closed', spaces: [S1, OTHER], votingDeadlineHours: 1 });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(OTHER));
  });
  it('cannot see, or invite into, a network carrying a space it does not administer', async () => {
    const n = await post(INSTANCES.a, adminA, '/api/networks', { label: `f37-foreign-${RUN}`, type: 'closed', spaces: [S1, OTHER], votingDeadlineHours: 1 });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    cleanup.a.push(n.body.id);
    assert.equal((await get(INSTANCES.a, owner, `/api/networks/${n.body.id}`)).status, 404);
    assert.equal((await post(INSTANCES.a, owner, '/api/invite/generate', { networkId: n.body.id })).status, 404);
  });
});

describe('on the joining instance', () => {
  async function invite(spaces) {
    const net = await post(INSTANCES.a, adminA, '/api/networks', { label: `f37-join-${RUN}-${spaces.join('+')}`, type: 'closed', spaces, votingDeadlineHours: 1 });
    assert.equal(net.status, 201, JSON.stringify(net.body));
    cleanup.a.push(net.body.id);
    const gen = await post(INSTANCES.a, adminA, '/api/invite/generate', { networkId: net.body.id });
    assert.equal(gen.status, 201, JSON.stringify(gen.body));
    return { ...gen.body, inviteUrl: 'http://ythril-a:3200/api/invite/apply', networkId: net.body.id };
  }
  const join = (token, b) => post(INSTANCES.b, token, '/api/networks/join-remote', {
    handshakeId: b.handshakeId, inviteUrl: b.inviteUrl, rsaPublicKeyPem: b.rsaPublicKeyPem, networkId: b.networkId, myUrl: 'http://ythril-b:3200',
  });

  it('joins a network mapped onto several spaces it administers', async () => {
    const t = await spaceAdmin(INSTANCES.b, adminB, 'f37-joiner', [S1, S2]);
    const b = await invite([S1, S2]);
    const r = await join(t, b);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cleanup.b.push(b.networkId);
  });
  it('joins onto a NEW space when it may also create spaces', async () => {
    const t = await spaceAdmin(INSTANCES.b, adminB, 'f37-creator', [S1], { createSpaces: true });
    const b = await invite([FRESH]);
    const r = await join(t, b);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cleanup.b.push(b.networkId);
  });
  it('is refused a new space without createSpaces, and nothing is created', async () => {
    const t = await spaceAdmin(INSTANCES.b, adminB, 'f37-nocreate', [S1]);
    const b = await invite([OTHER]);
    const r = await join(t, b);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /create/);
    const spaces = await get(INSTANCES.b, adminB, '/api/spaces');
    assert.ok(!JSON.stringify(spaces.body).includes(OTHER), 'the refused join created the space anyway');
  });
});
