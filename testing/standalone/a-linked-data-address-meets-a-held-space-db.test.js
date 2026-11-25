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
 * ## The rules
 *
 * 1. A peer-bound token with the rung on a held space: `423 space_held` on the record, the file, the agent and the schema routes, as the
 *    export answers it (the control row).
 * 2. The same token on a space nothing holds, and an instance-admin token on the held space, are read (the operator's own tooling is no peer).
 * 3. A peer-bound token without the rung on the held space is answered the not-found problem body, not the hold.
 *
 * ## Seen red
 *
 * On ce62acbbb the held space's record answers 200 to the peer token (the export, 423). Mutation: `refuseHeldPeer` dropped from
 * `requireResolvedRung`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-linked-data-address-meets-a-held-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

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

  it('the export answers a peer token 423 on the held space (the control the address is held to)', async () => {
    const r = await get(`/api/brain/spaces/${HELD}/export/rdf`, keys.peer);
    assert.ok(isHeld(r), `the export of a held space for a peer token: ${fmt(r)}`);
  });

  it('a peer token with the rung is answered 423 at every address of the held space', async () => {
    const paths = [`/ld/${HELD}/entity/e1`, `/ld/${HELD}/file/${FILE_PATH}`, `/ld/${HELD}/agent/rdf-test-instance`, `/ld/${HELD}/schema/${'0'.repeat(64)}`, `/ld/${HELD}/vocab/entity/Person`];
    const notHeld = [];
    for (const p of paths) { const r = await get(p, keys.peer); if (!isHeld(r)) notHeld.push(`${p} -> ${fmt(r)}`); }
    assert.deepEqual(notHeld, [], `a peer token read a held space through /ld/:\n  ${notHeld.join('\n  ')}`);
  });

  it('controls: the same token on a free space and an instance-admin token on the held one are not held', async () => {
    const free = await get(`/ld/${FREE}/entity/e1`, keys.peer);
    assert.equal(free.status, 200, `a space nothing holds: ${fmt(free)}`);
    assert.ok(free.text.includes(`${baseOf(FREE)}entity/e1`));
    const admin = await get(`/ld/${HELD}/entity/e1`, keys.admin);
    assert.ok(!isHeld(admin), `an instance-admin token was held as if it were the exchange: ${fmt(admin)}`);
  });

  it('a peer token without the rung is told nothing of the hold: the one not-found answer', async () => {
    const r = await get(`/ld/${HELD}/entity/e1`, keys.peerNoRung);
    const missing = await get(`/ld/${FREE}/entity/nope`, keys.peer);
    assert.equal(r.status, 404, fmt(r));
    assert.equal(r.text, missing.text, 'a token without the rung learns the space is held');
  });
});
