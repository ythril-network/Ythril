/**
 * Only an instance administrator binds a token to a peer at `POST /api/tokens`, and the audit row says which peer (bundle-47, Q-243).
 *
 * ## What was true before
 *
 * The mint route is guarded by the space-administrator gate, which the administrator of ONE space passes, and it took
 * `peerInstanceId` as any uuid. A token bound to peer P is P to every sync door: it can rewrite P's address in a network's member
 * list (the next sync cycle then sends this instance's credential for P to that address) and cast an unsigned vote as P. So the
 * administrator of one space could become any peer.
 *
 * ## What holds now
 *
 * - a space administrator naming `peerInstanceId` is answered `403`, and no token bound to that peer exists afterwards;
 * - the same administrator minting a token WITHOUT a peer binding is not refused (the control: the refusal is about the binding);
 * - an instance administrator naming it gets `201`, and the `token.create` audit row records the bound peer id.
 *
 * The invite and join handshakes bind their tokens through `createToken` directly and never pass this route.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-binding-is-minted-only-by-an-instance-admin-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { auditRowsOf } from './_audit-rows.mjs';

const skip = await mongoSkipReason();
const S = 'peermint';

let door; let server; let adminKey; let spaceAdminKey; let mongo; let loader;

async function mint(key, body) {
  const r = await fetch(`${server.url}/api/tokens`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const boundTo = (peer) => loader.getConfig().tokens.filter(t => t.peerInstanceId === peer);
let AREAS = [];
/** A whole matrix (the route takes no partial one): `knowledge: read` on the space, nothing else. */
const readRights = () => ({
  instanceAdmin: false, createSpaces: false, floor: null,
  perSpace: { [S]: Object.fromEntries(AREAS.map(a => [a, a === 'knowledge' ? 'read' : 'none'])) },
});

describe('only an instance administrator binds a token to a peer', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'peermint', spaces: [{ id: S, label: S, folders: [] }] });
    mongo = await import('../../server/dist/db/mongo.js');
    loader = await import('../../server/dist/config/loader.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    AREAS = [...SPACE_AREAS];
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    spaceAdminKey = (await tokens.createToken({
      name: 'space-admin',
      rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: area }, spaceAdmin: { floor: false, spaces: [S] } },
    })).plaintext;
    server = await listenApp();
  });
  after(async () => { await server?.close(); await door?.close(); });

  it('a space administrator naming peerInstanceId is refused 403 and no token is bound to that peer', async () => {
    const peer = randomUUID();
    const a = await mint(spaceAdminKey, { name: 'claims-a-peer', peerInstanceId: peer, rights: readRights() });
    assert.equal(a.status, 403, `a space administrator bound a token to a peer: ${JSON.stringify(a.body)}`);
    assert.deepEqual(boundTo(peer), [], 'a refused mint left a token bound to the peer');
  });

  it('the same space administrator minting without a peer binding is not refused (control)', async () => {
    const a = await mint(spaceAdminKey, { name: 'plain', rights: readRights() });
    assert.equal(a.status, 201, `the space administrator's plain mint was refused: ${JSON.stringify(a.body)}`);
  });

  it('an instance administrator binds a token to a peer, and the token.create audit row names the peer', async () => {
    const peer = randomUUID();
    const a = await mint(adminKey, { name: 'manual-peer', peerInstanceId: peer, rights: readRights() });
    assert.equal(a.status, 201, `the instance administrator's peer mint was refused: ${JSON.stringify(a.body)}`);
    assert.equal(boundTo(peer).length, 1, 'no token is bound to the peer after a 201');
    const rows = (await auditRowsOf(mongo, { operation: 'token.create' })).filter(r => r.status === 201);
    const row = rows.find(r => (r.changes ?? []).some(c => c.field === 'peerInstanceId' && c.to === peer));
    assert.ok(row, `no token.create row records the bound peer: ${JSON.stringify(rows.map(r => r.changes))}`);
  });
});
