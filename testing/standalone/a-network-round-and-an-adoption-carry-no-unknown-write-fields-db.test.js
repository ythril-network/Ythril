/**
 * The behavioural twin of `the-unknown-write-fields-setting-is-never-replicated.test.js` (Q-320, bundle-128, design-v3 section 8.2 G9, T4).
 *
 * ## What it asks
 *
 * `unknownWriteFields` is THIS instance's answer to a top-level field a write does not take, and it is local: no network round carries
 * it out, no meta pull serves it, no space added to a network ships it, and nothing a peer sends can set it on this instance. The
 * structural tripwire asserts the PLACEMENT (a top-level space setting, in no replicated schema); this drives the doors with the key set
 * and reads what leaves and what arrives:
 *
 *   - a PATCH carrying a meta change and the key, on a networked space, opens a round: the round as a peer sees it (`roundForPeer`) and
 *     every pending round and layer of the network hold no `unknownWriteFields`, while the key IS stored on the space (the control: a
 *     fixture without it would pass about everything);
 *   - `GET /api/sync/meta`, the pull a subscriber or tree member adopts a space's schema from, answers a meta without it;
 *   - adding a space that refuses to a network puts a `space_addition` round on the wire whose schema (`pendingMeta`) carries no key;
 *   - a schema a peer sends that DOES carry the key (a hostile or newer peer) does not switch this instance's space to `refuse`: the
 *     adopted layer is a meta, and the setting lives on the space config, which no layer writes.
 *
 * It is a green control: on a build without the setting it cannot go red, which is why it is written beside the implementation.
 *
 * Run: node --test testing/standalone/a-network-round-and-an-adoption-carry-no-unknown-write-fields-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { bootInstance, tempInstanceDir, removeInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { NET_ID, SELF, P1 } from './_vote-round-sites.mjs';

const KEY = 'unknownWriteFields';
const dir = tempInstanceDir('ythril-unknown-write-fields-local-');
const skip = await mongoSkipReason();

const member = (instanceId) => ({ instanceId, label: `member ${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both' });
const carries = (value) => JSON.stringify(value).includes(KEY);

describe('a network round, a meta pull and an adoption carry no unknownWriteFields', { skip }, () => {
  before(async () => { await openTestMongo('unknown_write_fields_local'); });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  /** A club (one yes passes a round) carrying `notes`, where `notes` and `extra` both refuse unknown write fields. */
  const boot = () => bootInstance(dir, {
    instanceId: SELF,
    spaces: [
      { id: 'general', label: 'General', builtIn: true, folders: [] },
      { id: 'notes', label: 'Notes', folders: [], meta: { purpose: 'notes purpose' }, [KEY]: 'refuse' },
      { id: 'extra', label: 'Extra', folders: [], meta: { purpose: 'extra purpose' }, [KEY]: 'refuse' },
    ],
    networks: [{
      id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: ['notes'], votingDeadlineHours: 24,
      createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1)], pendingRounds: [],
    }],
    peerTokens: { [P1]: 'token-p1' },
  });

  it('a networked PATCH with a meta change and the key stores the key locally and puts it in no round and no layer', async () => {
    const loader = await boot();
    const { planSpaceMetaUpdate, applySpaceMetaUpdate } = await import('../../server/dist/spaces/meta-update.js');
    const { roundForPeer } = await import('../../server/dist/networks/round-local-state.js');
    const space = loader.getConfig().spaces.find(s => s.id === 'notes');
    const decision = planSpaceMetaUpdate({ spaceId: 'notes', space, body: { meta: { purpose: 'a new purpose' }, [KEY]: 'refuse' }, ifMatch: undefined });
    assert.equal(decision.ok, true, JSON.stringify(decision.refusal));
    await applySpaceMetaUpdate(decision.plan);

    assert.equal(loader.getConfig().spaces.find(s => s.id === 'notes')[KEY], 'refuse', 'control: the setting is stored on the space, so a carrier exists to be leaked');
    const net = loader.getConfig().networks.find(n => n.id === NET_ID);
    const round = net.pendingRounds.find(r => r.type === 'meta_change');
    assert.ok(round, 'no meta_change round was opened for a meta change on a networked space');
    assert.equal(carries(roundForPeer(round)), false, 'the round as a peer receives it carries the local setting');
    assert.equal(carries(net.pendingRounds), false, 'a pending round carries the local setting');
    assert.equal(carries(net.schemaLayers ?? {}), false, 'a network layer carries the local setting');
  });

  it('GET /api/sync/meta, the pull a member adopts a space\'s schema from, answers a meta without it', async () => {
    const loader = await boot();
    const { syncMetaRouter } = await import('../../server/dist/api/sync/meta.js');
    assert.equal(loader.getConfig().spaces.find(s => s.id === 'notes')[KEY], 'refuse', 'control: the space refuses');
    const res = await callRoute(syncMetaRouter, 'get', '/meta', {
      query: { spaceId: 'notes', networkId: NET_ID }, authToken: { peerInstanceId: P1, rights: { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' } } },
    });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.ok(res.body?.meta && typeof res.body.meta === 'object', `the pull answered no meta: ${JSON.stringify(res.body)}`);
    assert.equal(carries(res.body), false, 'the meta a peer pulls carries the local setting');
  });

  it('adding a space that refuses to a network puts a space_addition round on the wire whose schema carries no key', async () => {
    const loader = await boot();
    const { addNetworkSpaceAct } = await import('../../server/dist/networks/network-acts.js');
    const { roundForPeer } = await import('../../server/dist/networks/round-local-state.js');
    const result = await addNetworkSpaceAct({ rights: { instanceAdmin: true } }, NET_ID, { spaceId: 'extra' }); // async since bundle-106
    assert.ok([200, 202].includes(result.status), `the space was not added: ${JSON.stringify(result)}`);
    assert.equal(loader.getConfig().spaces.find(s => s.id === 'extra')[KEY], 'refuse', 'control: the added space refuses');
    const net = loader.getConfig().networks.find(n => n.id === NET_ID);
    const round = net.pendingRounds.find(r => r.type === 'space_addition');
    assert.ok(round, 'no space_addition round was opened for the space (a club round stays listed once it has passed)');
    assert.ok(round.pendingMeta?.purpose, 'control: the round carries the schema, so the absence below is about the key and not about an empty schema');
    assert.equal(carries(roundForPeer(round)), false, 'the space_addition round a peer receives carries the local setting');
    assert.equal(carries(net.schemaLayers ?? {}), false, 'a network layer carries the local setting');
    assert.equal(carries(result.body ?? {}), false, 'the answer to the add, which is also what a peer is shown, carries the local setting');
  });

  it('a schema a peer sends WITH the key does not switch this instance\'s space to refuse', async () => {
    const loader = await boot();
    const { acceptNetworkLayer } = await import('../../server/dist/sync/space-meta-pull.js');
    const { unknownWriteFieldsMode } = await import('../../server/dist/spaces/spaces.js');
    const spaces = loader.getConfig().spaces;
    spaces.push({ id: 'adopted', label: 'Adopted', folders: [], meta: { purpose: 'adopted' } });
    assert.equal(unknownWriteFieldsMode(spaces.find(s => s.id === 'adopted')), 'warn', 'control: the adopting space starts as warn');
    acceptNetworkLayer(NET_ID, 'adopted', { purpose: 'from a peer', [KEY]: 'refuse' }, 'a hostile peer');
    const after = loader.getConfig().spaces.find(s => s.id === 'adopted');
    assert.equal(Object.hasOwn(after, KEY), false, 'an adopted schema wrote the setting onto the space');
    assert.equal(unknownWriteFieldsMode(after), 'warn', 'a peer switched this instance\'s answer to an unknown write field');
  });
});
