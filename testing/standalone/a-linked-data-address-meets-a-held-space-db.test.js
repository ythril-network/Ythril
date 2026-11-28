/**
 * A Linked Data address meets a held space as the export does: a peer token reading a space whose wipe only this side has applied is
 * answered `423 space_held`, never the record (bundle-271, Q-758, review of S3 finding 1; design v5 §3.3 v4 (5)).
 *
 * ## What it prevents
 *
 * `/ld/` resolves its space from the address and asks the area rung itself (`requireResolvedRung`), so the path guards that ask the hold
 * (`requireSpaceAuthScoped` -> `refuseHeldPeer`) never ran for it: a peer token whose rights reached the space read it through `/ld/`
 * while the export answered 423, outside the transfer fence. The hold is asked after the rung, so a token without the rung still gets
 * the one not-found answer and never learns the space is held.
 *
 * ## What holds now (bundle-47, Q-244)
 *
 * Q-244 confines a peer-bound token to the sync doors: token resolution answers it `403 { code: 'peer_door' }` on every route but `/api/sync/*`,
 * `GET`/`POST /api/files/:spaceId` and `POST /api/notify`. Neither `/ld/` nor the export is one of those, so a peer token never reaches the area
 * rung or the hold on either: the refusal comes first, on a held space and on a free one alike, and the hold's own answer (`423`) is no longer
 * what that token meets there.
 *
 * 1. A peer-bound token with the rung on a held space: `403 peer_door` on the record, the file, the agent, the schema and the vocabulary routes,
 *    and on the export (the control row the address is held to), never `423 space_held`.
 * 2. Controls: the same token on a space nothing holds is refused the same `403 peer_door` (the refusal is about the token kind, not the hold);
 *    an instance-admin token on the held space is read (the operator's own tooling is no peer).
 * 3. A peer-bound token without the rung on the held space is answered the same refusal as on a free space: it learns nothing of the hold.
 *
 * ## Seen red
 *
 * At the bundle-47 server the rows as Q-758 wrote them (`423` on the held space, a `200` record on the free one, the not-found problem body
 * without the rung) fail with the `peer_door` refusal. The hold on `/ld/` was seen red on ce62acbbb (record `200` to the peer token) by
 * mutation: `refuseHeldPeer` dropped from `requireResolvedRung`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-linked-data-address-meets-a-held-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';
import { isPeerDoorRefusal } from './_peer-door.mjs';

const skip = await mongoSkipReason();
const PUBLIC = 'https://rdf.example.org';
const HELD = 'ldheld';
const FREE = 'ldfree';
const PEER = 'ld-held-peer';
const NET = 'ld-held-net';
const HOUR = 3_600_000;
const FILE_PATH = 'docs/a.txt';
const STAMP = '2026-03-04T05:06:07.000Z';

let d;
const keys = {};
const previousPublic = process.env['PUBLIC_BASE_URL'];

/** A GET of `path` as N-Quads by `key`. */
async function get(path, key) {
  const r = await fetch(`${d.server.url}${path}`, { headers: { Accept: 'application/n-quads', Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, body };
}
const fmt = (r) => `${r.status} ${r.text.slice(0, 160)}`;
const isHeld = (r) => r.status === 423 && r.body?.code === 'space_held';
const isPeerDoor = isPeerDoorRefusal;

/** An applied wipe round of the held space with no evidence that the peer concluded it: the space is held for that peer. */
const wipeRound = (selfId) => {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  return {
    roundId: 'ld-w', type: 'space_wipe', spaceId: HELD, subjectInstanceId: selfId, subjectLabel: 'x', subjectUrl: '',
    openedAt: iso(-HOUR), deadline: iso(23 * HOUR), votes: [{ instanceId: selfId, vote: 'yes', castAt: iso(-HOUR) }],
    concluded: true, passed: true, appliedHere: true, proposedHere: true,
  };
};

describe('a linked data address meets a held space as the export does', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({
      suite: 'ld_held',
      spaces: [{ id: HELD, meta: rdfMeta(HELD) }, { id: FREE, meta: rdfMeta(FREE) }],
    });
    await d.seed(HELD, 'entity', [{ _id: 'e1', name: 'Held' }]);
    await d.seed(HELD, 'file', [{ _id: FILE_PATH, path: FILE_PATH, sizeBytes: 3, sha256: 'ab'.repeat(32), createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(FREE, 'entity', [{ _id: 'e1', name: 'Free' }]);
    const all = d.row({ knowledge: 'read', files: 'read', schema: 'read' });
    const peer = async (name, perSpace) => (await d.mint(name, perSpace, { peerInstanceId: PEER })).key;
    keys.peer = await peer('ld-held-peer', { [HELD]: all, [FREE]: all });
    keys.peerNoRung = await peer('ld-held-peer-norung', { [FREE]: all });
    keys.admin = (await d.mint('ld-held-admin', {}, { admin: true })).key;
    d.loader.mutateConfig((cfg) => {
      cfg.networks.push({
        id: NET, label: 'Held network', type: 'club', origin: 'joined', spaces: [HELD, FREE], votes: [], votingDeadlineHours: 24,
        members: [{ instanceId: PEER, label: 'Peer', url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'both' }],
        pendingRounds: [wipeRound(cfg.instanceId)],
      });
    });
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await d?.close();
  });

  it('the export answers a peer token 403 peer_door on the held space, not 423 (the control the address is held to)', async () => {
    const r = await get(`/api/brain/spaces/${HELD}/export/rdf`, keys.peer);
    assert.ok(isPeerDoor(r), `the export of a held space for a peer token: ${fmt(r)}`);
    assert.ok(!isHeld(r), `the export of a held space for a peer token was held, not refused as a peer: ${fmt(r)}`);
  });

  it('a peer token with the rung is answered 403 peer_door at every address of the held space, never 423 and never the record', async () => {
    const paths = [`/ld/${HELD}/entity/e1`, `/ld/${HELD}/file/${FILE_PATH}`, `/ld/${HELD}/agent/rdf-test-instance`, `/ld/${HELD}/schema/${'0'.repeat(64)}`, `/ld/${HELD}/vocab/entity/Person`];
    const notRefused = [];
    for (const p of paths) { const r = await get(p, keys.peer); if (!isPeerDoor(r)) notRefused.push(`${p} -> ${fmt(r)}`); }
    assert.deepEqual(notRefused, [], `a peer token was not refused as a peer through /ld/:\n  ${notRefused.join('\n  ')}`);
  });

  it('controls: the same token on a free space is refused the same words, and an instance-admin token reads both spaces, held or not', async () => {
    const free = await get(`/ld/${FREE}/entity/e1`, keys.peer);
    assert.ok(isPeerDoor(free), `a space nothing holds: ${fmt(free)}`);
    const held = await get(`/ld/${HELD}/entity/e1`, keys.peer);
    assert.equal(held.text, free.text, 'the peer token\'s answer on the held space differs from the one on a free space');
    const adminFree = await get(`/ld/${FREE}/entity/e1`, keys.admin);
    assert.equal(adminFree.status, 200, `the door does not answer an instance-admin token on a free space: ${fmt(adminFree)}`);
    assert.ok(adminFree.text.includes(`${baseOf(FREE)}entity/e1`));
    const admin = await get(`/ld/${HELD}/entity/e1`, keys.admin);
    assert.ok(!isHeld(admin), `an instance-admin token was held as if it were the exchange: ${fmt(admin)}`);
    assert.ok(!isPeerDoor(admin), `an instance-admin token was refused as a peer: ${fmt(admin)}`);
  });

  it('a peer token without the rung is told nothing of the hold: the same peer_door refusal as on a free space', async () => {
    const r = await get(`/ld/${HELD}/entity/e1`, keys.peerNoRung);
    const free = await get(`/ld/${FREE}/entity/nope`, keys.peer);
    assert.ok(isPeerDoor(r), fmt(r));
    assert.equal(r.text, free.text, 'a token without the rung learns the space is held');
  });
});
