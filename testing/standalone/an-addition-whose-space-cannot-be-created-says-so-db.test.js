/**
 * A space a network adds here that this instance cannot create says so, in every place that adds one - and an announcement still never loses the
 * exchange's other work (bundle-106 R-X16; design v5 section 1.4a, X16, INT S3).
 *
 * ## What was true before
 *
 * `addSpacesToNetwork` answered `string[]` and swallowed its own failure: a creation that failed (the store refused the space's collections) logged a
 * warning and returned `[]`, which every caller read as "nothing to do". The passed-addition path therefore answered a success that did nothing, and
 * v4 considered making the function THROW to fix that - which would have skipped the member-record update inside the sync exchange's `try`
 * (`sync/engine.ts`: *"so a bad heal cannot skip the member-record update below"*) and answered the announcing peer `500`.
 *
 * ## What holds now
 *
 * `addSpacesToNetwork` returns `{ added, failed? }` and never throws. Its callers each read it as their situation needs:
 *
 * - **an announcement** (`adoptAnnouncedSpaces`, reached from the sync cycle and from the announce route) ignores `failed`: the member-record update
 *   and the announce's answer are untouched (a control: green on the base, it is what the change must keep);
 * - **a passed addition** (`applySpaceAdditionRound`) settles `{ kind: 'add', ok: false, error }`, so the door that waits for it does not answer a
 *   success that did nothing;
 * - **the operator's accept of a pending space** answers `500` with the pending entry kept (green on the base: it already read the empty list).
 *
 * ## How the failure is made
 *
 * No hook exists for `createSpace`, and the rule is about what the real function does when the store refuses. A VIEW named `<space>_facts` makes
 * `initSpace` throw (`createIndex` on a view: *"is a view, not a collection"*) after it has decided the collection exists - the store's own refusal,
 * through the real creation path. The view is dropped after each case.
 *
 * ## Seen red
 *
 * On the base `addSpacesToNetwork` answers `[]`, so the shape rows read `undefined` for `added` and `failed`, and `settleRounds` does not exist, so the
 * passed-addition row fails for its absence. After the fix, by hand: make `addSpacesToNetwork` rethrow -> the announcement rows (record still updated,
 * `adoptAnnouncedSpaces` still resolves) red; drop the `failed` branch of `applySpaceAdditionRound` -> the `ok: false` row red.
 *
 * Run: node --test testing/standalone/an-addition-whose-space-cannot-be-created-says-so-db.test.js
 * (requires a prior server build, the test MongoDB and a private LAN address for the gossip row)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { removeInstanceDir, startFakePeer, allowEngineToDialPrivatePeers, settled } from './_vote-round-instance.mjs';
import { M1, ADMIN, tempInstance, networkOf, boot, requireExport, databaseTakesCollections, warmSpaceCreation } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-addition-fails-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();

describe('an addition whose space cannot be created says so', { skip }, () => {
  let mongo; let peer; let selfRecord;
  before(async () => {
    allowEngineToDialPrivatePeers();
    selfRecord = { instanceId: M1, label: 'renamed by its announcement', spaces: ['general', 'cannotcreate'] };
    peer = await startFakePeer((method, url) => {
      if (method === 'POST' && /\/members$/.test(url)) return { status: 200, body: { status: 'ok', self: selfRecord } };
      if (method === 'GET' && /\/votes$/.test(url)) return { status: 200, body: { rounds: [] } };
      if (method === 'POST' && url === '/api/sync/warm') return { status: 200, body: { status: 'ok' } };
      return undefined;
    });
    mongo = await openTestMongo('addition_fails');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await peer?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  /** Make the real `initSpace` of `id` throw: its facts collection is a view, so the index it creates is refused by the store. */
  const refuseSpace = async (id) => {
    const db = mongo.getDb();
    await db.createCollection(`${id}_source`);
    await db.createCollection(`${id}_facts`, { viewOn: `${id}_source`, pipeline: [] });
  };
  const allowSpace = async (id) => {
    const db = mongo.getDb();
    await db.collection(`${id}_facts`).drop().catch(() => {});
    await db.collection(`${id}_source`).drop().catch(() => {});
  };
  /** A token that could have joined the network: adoption and a round's addition are judged by it. */
  const joiner = async (loader, netId) => {
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { record } = await tokens.createToken({ name: 'joiner', admin: true });
    loader.mutateConfig(cfg => { cfg.networks.find(n => n.id === netId).joinedBy = record.id; });
    return record.id;
  };
  const noDriverText = (s) => assert.doesNotMatch(String(s), /is a view, not a collection|MongoServerError|E11000/, 'the answer carries the store\'s own text');

  it('addSpacesToNetwork answers { added, failed? }: the failed creation names a cause and adds nothing; a creatable space answers added alone (twin)', async () => {
    const loader = await boot(dir, { spaces: [], networks: [networkOf('club', [M1], { spaces: ['general'] })] });
    const { addSpacesToNetwork } = await import('../../server/dist/networks/network-spaces.js');
    await refuseSpace('cannotcreate');
    try {
      const failed = await addSpacesToNetwork('net-1', [{ networkId: 'cannotcreate', localId: 'cannotcreate' }], 'a test', { tokenId: null });
      assert.deepEqual(failed?.added, [], `the failed creation answered ${JSON.stringify(failed)}: nothing says WHICH answer is "could not" and which is "nothing to do"`);
      assert.equal(typeof failed?.failed, 'string', 'the failure has no sentence of its own: a caller cannot tell it from "nothing to do"');
      assert.ok(failed.failed.length > 0);
      noDriverText(failed.failed);
      assert.ok(!loader.getConfig().networks[0].spaces.includes('cannotcreate'), 'a space that could not be created was added to the network');
    } finally { await allowSpace('cannotcreate'); }
    const ok = await addSpacesToNetwork('net-1', [{ networkId: 'creatable', localId: 'creatable' }], 'a test', { tokenId: null });
    assert.deepEqual(ok?.added, ['creatable'], `the twin: a creatable space answered ${JSON.stringify(ok)}`);
    assert.equal(ok.failed, undefined, 'a success carries a failure sentence');
    assert.ok(loader.getConfig().networks[0].spaces.includes('creatable'));
  });

  it('an announcement of a space that cannot be created still resolves, and the member-record update of the same exchange still runs (control: the base never throws)', async () => {
    const loader = await boot(dir, { spaces: [], networks: [networkOf('pubsub', [M1], { spaces: ['general'], extra: { origin: 'joined' }, memberExtra: { direction: 'pull' } })] });
    await joiner(loader, 'net-1');
    const { adoptAnnouncedSpaces } = await import('../../server/dist/networks/network-spaces.js');
    await refuseSpace('cannotcreate');
    try {
      const adopted = await adoptAnnouncedSpaces('net-1', M1, ['general', 'cannotcreate']);
      assert.ok(!adopted.includes('cannotcreate'), `a space that could not be created was reported adopted: ${JSON.stringify(adopted)}`);
      // The exchange: the publisher's self-record names a new label and the space; the cycle updates the member record after the adoption.
      loader.getConfig().networks[0].members[0].url = peer.url;
      loader.getConfig().networks[0].members[0].version = '1.0.0';
      loader.getConfig().networks[0].members[0].versionCheckedAt = new Date().toISOString();
      peer.seen.length = 0;
      await (await import('../../server/dist/sync/engine.js')).runSyncForPeer(M1);
      await settled(() => loader.getConfig().networks[0].members[0].label);
      assert.ok(peer.seen.some(s => s.method === 'POST' && /\/members$/.test(s.url)), 'the cycle never gossiped with the publisher, so the row below proves nothing');
      assert.equal(loader.getConfig().networks[0].members[0].label, selfRecord.label, 'the member-record update was skipped after an adoption that failed');
    } finally { await allowSpace('cannotcreate'); }
  });

  it('a passed addition whose space cannot be created settles { kind: add, ok: false, error }, in our words', async () => {
    const settleRounds = await requireExport('../../server/dist/networks/round-conclusion.js', 'settleRounds', 'design v5 section 1.1: the one settle step, whose `settled` carries each act it started');
    const round = {
      roundId: 'add-fails', type: 'space_addition', spaceId: 'cannotcreate', networkSpaceId: 'cannotcreate', subjectInstanceId: M1, subjectLabel: 'm1', subjectUrl: '',
      openedAt: new Date(Date.now() - 60_000).toISOString(), deadline: new Date(Date.now() + 3_600_000).toISOString(),
      votes: [{ instanceId: M1, vote: 'yes', castAt: new Date().toISOString() }], concluded: false,
    };
    const loader = await boot(dir, { spaces: [], networks: [networkOf('club', [M1], { spaces: ['general'], extra: { pendingRounds: [round] } })] });
    await joiner(loader, 'net-1');
    await refuseSpace('cannotcreate');
    try {
      const cfg = loader.getConfig();
      const outcome = await settleRounds(cfg.networks[0], cfg, [cfg.networks[0].pendingRounds[0]], 'gossip', Date.now()).settled;
      const add = outcome.find(o => o.roundId === 'add-fails');
      assert.ok(add, `no settled entry for the addition: ${JSON.stringify(outcome)}`);
      assert.deepEqual([add.kind, add.ok], ['add', false], `the addition settled ${JSON.stringify(add)}: a success that did nothing`);
      assert.equal(typeof add.error, 'string');
      noDriverText(add.error);
      assert.ok(!loader.getConfig().networks[0].spaces.includes('cannotcreate'));
    } finally { await allowSpace('cannotcreate'); }
  });

  it('the operator\'s accept of a pending space that cannot be created answers 500 and keeps the proposal (control: the base already reads the empty list)', async () => {
    const pending = { networkId: 'cannotcreate', localId: 'cannotcreate', why: 'announced', from: M1, at: new Date().toISOString() };
    const loader = await boot(dir, { spaces: [], networks: [networkOf('pubsub', [M1], { spaces: ['general'], extra: { origin: 'joined', pendingSpaces: [pending] }, memberExtra: { direction: 'pull' } })] });
    await refuseSpace('cannotcreate');
    try {
      const { resolvePendingSpaceAct } = await import('../../server/dist/networks/network-acts.js');
      const res = await resolvePendingSpaceAct({ rights: ADMIN.rights }, 'net-1', { spaceId: 'cannotcreate', action: 'accept' });
      assert.equal(res.status, 500, JSON.stringify(res).slice(0, 300));
      noDriverText(res.error);
      assert.ok((loader.getConfig().networks[0].pendingSpaces ?? []).some(p => p.networkId === 'cannotcreate'), 'the proposal was lost with the failed accept');
    } finally { await allowSpace('cannotcreate'); }
  });
});
