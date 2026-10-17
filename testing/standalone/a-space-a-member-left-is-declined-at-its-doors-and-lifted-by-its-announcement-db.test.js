/**
 * A subscriber that left a space answers the publisher's data doors `423 space_declined`; the publisher's record of the decline is lifted by that
 * member announcing the space again, on BOTH arrival paths; and a decline is never counted as a hold (bundle-106 R-D40b 423 half, R-X10a lift and
 * gauge; design v5 section 2.9 and 2.9 v5 (1)(2), amendment AM2).
 *
 * ## The rules this holds
 *
 * - **The doors (R-D40b).** A subscriber's deletion takes the space out of the network on its own record and adds the NETWORK's space id to
 *   `dismissedSpaces`. The publisher still pushes it (it stores subscribers as `push`), so every sync data door - push, pages, manifest, tombstones -
 *   answers a peer request for a space the network no longer carries here, but the member dismissed, `423 { code: 'space_declined' }` - not the `403`
 *   of a space nobody reaches, which the publisher counts as a failed transfer every cycle. The refusal is for a PEER on a DISMISSED space only: the
 *   carried space is served as ever, a space that was never carried keeps its `403`, and an instance-admin token is the operator's own tooling.
 * - **The lift (R-X10a, AM2).** The publisher keeps `declinedSpaces` on the member's record and stops asking for those spaces. A member that announces
 *   the space again lifts it. `adoptAnnouncedSpaces` discards a subscriber's announced list (it adopts only from an upstream), so the lift is its own
 *   helper called where a member's self-record ARRIVES - the announce route and the gossip read. Each path is driven with an announcement that lists
 *   the declined space (lifted) and one that does not (kept): the second is the twin that shows the first is the announced list and not a clear-all.
 * - **Not a hold (X10).** `ythril_space_exchange_held{network}` counts held pairs only; a declined pair is not one, so its alert never starts and never
 *   needs to end. Driven with a declined pair alone (0) and then with a held pair beside it (the twin: it counts the hold, not the decline).
 *
 * ## What is not here
 *
 * The publisher's cycle after a decline (one `423`, then no request, `declined` on the history row) is `a-refused-transfer-is-held-or-declined-never-failed-db`.
 * The file door's answer for a dismissed space is not asserted: the design says "a push, manifest or file call" but not where the guard sits for a
 * space that no longer exists locally, and the rights layer in front of the file door resolves the space first.
 *
 * ## Seen red
 *
 * On the base a dismissed, uncarried space is `403` on every door, nothing lifts a decline (the announce route keeps the field), and there is no
 * gauge. The controls (carried space, never-carried space, admin token, the keep rows, the declined-pair-alone gauge) pass on purpose. After the
 * fix, by hand: answer `space_held` for a dismissed space -> the door rows red; clear every decline on any announcement -> the keep rows red;
 * count a decline in the gauge -> the declined-alone row red.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-space-a-member-left-is-declined-at-its-doors-and-lifted-by-its-announcement-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_LABEL } from './_pull-door.mjs';
import { callRoute, startFakePeer, allowEngineToDialPrivatePeers, settled } from './_vote-round-instance.mjs';
import { metricSample } from './_space-act-harness.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const FREE = 'declinedfree';
const GONE = 'declinedgone';
const NEVER = 'declinednever';
const HELD = 'declinedheld';
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
/** The derived doors must number at least the document, tombstone and manifest routes the routers register: an empty derivation passes every loop. */
const DOOR_FLOOR = 20;

let door, loader, routers, fake;

/** Every data route of the routers that carries a space; `/meta` is the schema door (reach-only) and `members` carries no space; neither is asserted here. */
function doors() {
  const out = [];
  for (const [name, router] of Object.entries(routers)) {
    if (name === 'meta' || name === 'members') continue;
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) out.push({ router, name, method, path: layer.route.path, label: `${method.toUpperCase()} ${layer.route.path}` });
    }
  }
  return out;
}
async function ask(d, space, token) {
  const req = {
    params: { id: 'nothing' },
    query: { spaceId: space, networkId: door.NET, full: 'true', sinceSeq: '0', limit: '10' },
    body: { spaceId: space, networkId: door.NET, tombstones: [], facts: [build.fact(space, 'declined-f1', 7)] },
    authToken: token,
  };
  try { const { code, body } = await callRoute(d.router, d.method, d.path, req); return { code, body }; } catch (err) { return { code: -1, body: { error: String(err) } }; }
}
const isDeclined = (r) => r.code === 423 && r.body?.code === 'space_declined';
const net = () => loader.getConfig().networks.find(n => n.id === door.NET);

describe('a space a member left: declined at its doors, lifted by its announcement, never a hold', { skip }, () => {
  before(async () => {
    allowEngineToDialPrivatePeers();
    door = await openPullDoor({ suite: 'declined', spaces: [FREE, HELD], type: 'pubsub', direction: 'pull', files: true });
    loader = await import('../../server/dist/config/loader.js');
    routers = {
      docs: (await import('../../server/dist/api/sync/docs.js')).syncDocsRouter,
      tombstones: (await import('../../server/dist/api/sync/tombstones.js')).syncTombstonesRouter,
      manifest: (await import('../../server/dist/api/sync/manifest.js')).syncManifestRouter,
      meta: (await import('../../server/dist/api/sync/meta.js')).syncMetaRouter,
      members: (await import('../../server/dist/api/sync/members.js')).syncMembersRouter,
    };
    fake = await startFakePeer((method, url) => {
      if (method === 'POST' && /\/members$/.test(url)) return { status: 200, body: { status: 'ok', self: { instanceId: PEER, label: PEER_LABEL, spaces: fake.announces } } };
      if (method === 'GET' && /\/votes$/.test(url)) return { status: 200, body: { rounds: [] } };
      if (method === 'POST' && url === '/api/sync/warm') return { status: 200, body: { status: 'ok' } };
      return undefined;
    });
    fake.announces = [];
  });
  after(async () => { await fake?.close(); await door?.close(); });

  beforeEach(async () => {
    await door.reset();
    loader.mutateConfig((cfg) => {
      const n = cfg.networks.find(x => x.id === door.NET);
      n.pendingRounds = []; n.spaces = [FREE, HELD]; delete n.dismissedSpaces; delete n.members[0].declinedSpaces;
      delete cfg.pendingSpaceActs;
    });
  });

  describe('the subscriber\'s doors (R-D40b, 423 half)', () => {
    beforeEach(() => { loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).dismissedSpaces = [GONE]; }); });

    it('the derivation found the doors, at or above the floor', () => {
      const found = doors();
      assert.ok(found.length >= DOOR_FLOOR, `only ${found.length} sync route(s) found (floor ${DOOR_FLOOR}): ${found.map(d => d.label).join(', ')}`);
    });

    it('every data door answers a peer 423 space_declined for the dismissed space, and stores nothing', async () => {
      const peer = peerToken(PEER);
      const notDeclined = [];
      for (const d of doors()) { const r = await ask(d, GONE, peer); if (!isDeclined(r)) notDeclined.push(`${d.label} -> ${r.code} ${JSON.stringify(r.body).slice(0, 80)}`); }
      assert.deepEqual(notDeclined, [], 'these doors answered the publisher of a space this member left as a space nobody reaches (403), which the publisher counts as a failed transfer every cycle:\n  ' + notDeclined.join('\n  '));
      assert.equal(await door.coll(GONE, 'facts').findOne({ _id: 'declined-f1' }), null, 'a push into a space the member left was stored');
    });

    it('control: the carried space is not declined on any door, and a space that was never carried keeps its 403', async () => {
      const peer = peerToken(PEER);
      const declinedCarried = []; const neverNot403 = [];
      for (const d of doors()) {
        if (isDeclined(await ask(d, FREE, peer))) declinedCarried.push(d.label);
        const r = await ask(d, NEVER, peer);
        if (isDeclined(r) || r.code !== 403) neverNot403.push(`${d.label} -> ${r.code}`);
      }
      assert.deepEqual(declinedCarried, [], 'a carried space was declined');
      assert.deepEqual(neverNot403, [], 'a space that was never carried and never dismissed stopped answering 403: the decline is for a DISMISSED space only');
    });

    it('control: an instance-admin token (the operator\'s own tooling) is not answered space_declined', async () => {
      const declined = [];
      for (const d of doors().filter(x => x.method === 'get')) if (isDeclined(await ask(d, GONE, ADMIN_TOKEN))) declined.push(d.label);
      assert.deepEqual(declined, []);
    });
  });

  describe('the publisher\'s record of a decline (R-X10a lift)', () => {
    /** Both ways a member's self-record arrives, each driven with the announcement it is given. */
    const PATHS = {
      'the announce route': async (spaces) => {
        const res = await callRoute(routers.members, 'post', '/networks/:networkId/members', {
          params: { networkId: door.NET }, body: { instanceId: PEER, label: PEER_LABEL, spaces }, authToken: { peerInstanceId: PEER, rights: { instanceAdmin: false } },
        });
        assert.equal(res.code, 200, JSON.stringify(res.body));
      },
      'the gossip read of the member\'s answer': async (spaces) => {
        fake.announces = spaces; fake.seen.length = 0;
        loader.mutateConfig((cfg) => { const m = cfg.networks.find(n => n.id === door.NET).members[0]; m.url = fake.url; m.version = '1.0.0'; m.versionCheckedAt = new Date().toISOString(); });
        await (await import('../../server/dist/sync/engine.js')).runSyncForPeer(PEER);
        await settled(() => net().members[0].declinedSpaces ?? []);
        assert.ok(fake.seen.some(s => s.method === 'POST' && /\/members$/.test(s.url)), 'the cycle never gossiped with the member, so the rows below prove nothing');
      },
    };
    const declined = () => net().members[0].declinedSpaces ?? [];

    for (const [path, arrive] of Object.entries(PATHS)) {
      it(`${path}: a member announcing the space again lifts its decline`, async () => {
        loader.mutateConfig((cfg) => { const n = cfg.networks.find(x => x.id === door.NET); n.members[0].direction = 'push'; n.members[0].declinedSpaces = [FREE]; });
        assert.deepEqual(declined(), [FREE], 'control: the decline is on the record before the announcement');
        await arrive([FREE]);
        assert.deepEqual(declined(), [], `the member announced '${FREE}' and the publisher still holds its decline: the space is never exchanged with that member again`);
      });
      it(`${path} (twin): an announcement that does NOT list the declined space leaves the decline standing`, async () => {
        loader.mutateConfig((cfg) => { const n = cfg.networks.find(x => x.id === door.NET); n.members[0].direction = 'push'; n.members[0].declinedSpaces = [FREE]; });
        await arrive([HELD]);
        assert.deepEqual(declined(), [FREE], 'an announcement of another space cleared a decline: the lift must read the announced list, not clear everything');
      });
    }
  });

  describe('a decline is not a hold (X10, the gauge)', () => {
    const wipeRound = () => ({
      roundId: 'dh-w', type: 'space_wipe', spaceId: HELD, subjectInstanceId: door.instanceId, subjectLabel: 'x', subjectUrl: '',
      openedAt: iso(NOW - HOUR), deadline: iso(NOW + 23 * HOUR), votes: [{ instanceId: door.instanceId, vote: 'yes', castAt: iso(NOW - HOUR) }],
      concluded: true, passed: true, appliedHere: true, proposedHere: true,
    });
    it('a declined pair alone is not counted in ythril_space_exchange_held; beside a held pair the gauge counts the hold and not the decline (twin)', async () => {
      loader.mutateConfig((cfg) => { const n = cfg.networks.find(x => x.id === door.NET); n.members[0].declinedSpaces = [FREE]; });
      const held = () => metricSample('ythril_space_exchange_held', { network: door.NET });
      assert.equal(await held(), 0, 'a declined pair was counted as held: its alert would start and never end');
      loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).pendingRounds = [wipeRound()]; });
      assert.equal(await held(), 1, 'the twin: the held pair (a wipe applied here that the member has not concluded) is not counted, so the 0 above says nothing');
    });
  });
});
