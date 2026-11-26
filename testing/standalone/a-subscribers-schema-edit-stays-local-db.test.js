/**
 * On pub/sub a SUBSCRIBER's schema edit of a space the network carries is its own: it lands in this instance's own definitions, opens no round,
 * tells the publisher nothing, and the publisher's layer outranks it (Q-968; owner, 2026-11-26: "Keep it local ... a network-wide change is the
 * publisher operator's to make").
 *
 * ## What it prevents
 *
 * The schema doors opened a `meta_change` round on every network carrying the space, with no subscriber filter (the deletion and the wipe had
 * one). On pub/sub the subscriber's own yes passed that round at once, the publisher adopted it at its next sync and passed it too, and the
 * subscriber's edit became the network's schema on every member.
 *
 * ## What is held
 *
 * - by the space PATCH and by MCP `schema_update`: the answer is `applied`, no round is held, the publisher is never told;
 * - the edit is in the own definitions, the publisher's layer is untouched and its types still stand in the effective schema;
 * - a space the subscriber also shares in a club opens its round in the club only;
 * - a proposal to the pub/sub network's layer itself (`targetNetwork`) is refused: that layer is the publisher's.
 *
 * Run: node --test testing/standalone/a-subscribers-schema-edit-stays-local-db.test.js
 * (requires a prior server build, the test MongoDB and a private LAN address)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { removeInstanceDir, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { startVotesPeer } from './_vote-round-sites.mjs';
import { M1, M2, ADMIN, tempInstance, networkOf, boot, roundsOf, route, databaseTakesCollections } from './_round-open-fixtures.mjs';
import { elapse } from '../_shared/sleep.mjs';

const dir = tempInstance('ythril-pubsub-schema-local-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const str = { type: 'string' };
/** The pub/sub network's id, a real one: the body schema reads `targetNetwork` as a UUID, so a made-up id is refused for its shape and proves nothing about the network. */
const NET = 'bbbbbbbb-0000-4000-8000-00000000f1f1';
/** The publisher's layer for `notes`: one type, `Published`, whose `title` is a string. */
const LAYER = { typeSchemas: { entity: { Published: { propertySchemas: { title: str } } } } };

describe('pub/sub: a subscriber\'s schema edit stays local', { skip }, () => {
  let mongo; let publisher; let club;
  before(async () => {
    allowEngineToDialPrivatePeers();
    publisher = await startVotesPeer();
    club = await startVotesPeer();
    mongo = await openTestMongo('pubsub_schema_local');
    await databaseTakesCollections(mongo);
  });
  after(async () => { await publisher?.close(); await club?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  /** SELF subscribes to M1 (its publisher, pulled from) and holds the publisher's layer for `notes`. */
  const subscriberNet = () => {
    const net = networkOf('pubsub', [M1], { id: NET, extra: { origin: 'joined', schemaLayers: { notes: structuredClone(LAYER) } }, memberExtra: { direction: 'pull' } });
    net.members[0].url = publisher.url;
    return net;
  };
  const told = (peer) => peer.seen.filter(s => s.method === 'POST' && (s.url === '/api/notify' || /\/votes\//.test(s.url)));
  const spaceOf = (loader) => loader.getConfig().spaces.find(s => s.id === 'notes');
  /** Boot and lay the publisher's layer into the space's effective schema, as a received layer is. */
  async function bootWith(networks) {
    const loader = await boot(dir, { spaces: ['notes'], networks });
    const { recomputeEffectiveMeta } = await import('../../server/dist/spaces/effective-meta.js');
    recomputeEffectiveMeta('notes', true);
    assert.ok(spaceOf(loader).meta?.typeSchemas?.entity?.Published, 'precondition: the publisher\'s layer is in the effective schema');
    publisher.seen.length = 0; club.seen.length = 0;
    return loader;
  }
  const patchMeta = async (body) => {
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    return route(spacesRouter, 'patch', '/:id', { params: { id: 'notes' }, body, authToken: ADMIN });
  };
  const schemaUpdateTool = async (meta) => {
    const { schema_updateTool } = await import('../../server/dist/mcp/tools/spaces.js');
    const out = await schema_updateTool.handle({
      callSpace: 'notes', callSpaces: ['notes'], accessibleSpaceIds: ['notes'], viewReads: new Map(), args: { space: 'notes', ...meta }, rights: ADMIN.rights,
    });
    return { isError: out.isError === true, text: (out.content ?? []).map(c => c.text ?? '').join('\n') };
  };

  it('the space PATCH: applied, no round, the edit is the subscriber\'s own and the publisher\'s layer still stands', async () => {
    const loader = await bootWith([subscriberNet()]);
    const res = await patchMeta({ meta: { typeSchemas: { entity: { Mine: { propertySchemas: { note: str } } } } } });
    assert.equal(res.code, 200, `${res.code} ${JSON.stringify(res.body)?.slice(0, 300)}`);
    assert.notEqual(res.body?.status, 'vote_pending', 'a subscriber\'s edit was put to the network');
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), [], 'a subscriber opened a schema round on the pub/sub network');
    const space = spaceOf(loader);
    assert.ok(space.ownMeta?.typeSchemas?.entity?.Mine, `the edit is not in the own definitions: ${JSON.stringify(space.ownMeta)}`);
    assert.equal(space.ownMeta?.typeSchemas?.entity?.Published, undefined, 'the publisher\'s type was copied into the subscriber\'s own definitions');
    assert.ok(space.meta?.typeSchemas?.entity?.Mine, 'the edit is not in the effective schema');
    assert.ok(space.meta?.typeSchemas?.entity?.Published, 'the publisher\'s layer left the effective schema');
    assert.deepEqual(loader.getConfig().networks[0].schemaLayers?.notes, LAYER, 'the publisher\'s layer was changed by a subscriber\'s edit');
    await elapse(300, 'absence window: a notice the edit queued would have been sent by now');
    assert.deepEqual(told(publisher), [], 'the publisher was told of a subscriber\'s local edit');
  });

  it('MCP schema_update: the same edit, the same local outcome', async () => {
    const loader = await bootWith([subscriberNet()]);
    const out = await schemaUpdateTool({ typeSchemas: { entity: { ByTool: { propertySchemas: { note: str } } } } });
    assert.equal(out.isError, false, out.text);
    assert.ok(!/vote_pending/.test(out.text), `the tool answered a vote: ${out.text.slice(0, 300)}`);
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), [], 'schema_update opened a schema round on the pub/sub network');
    assert.ok(spaceOf(loader).ownMeta?.typeSchemas?.entity?.ByTool, 'the edit is not in the own definitions');
  });

  it('the publisher\'s layer outranks the subscriber\'s own edit of a type both define', async () => {
    const loader = await bootWith([subscriberNet()]);
    const res = await patchMeta({ meta: { typeSchemas: { entity: { Published: { propertySchemas: { title: { type: 'number' } } } } } } });
    assert.equal(res.code, 200, `${res.code} ${JSON.stringify(res.body)?.slice(0, 300)}`);
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), []);
    assert.equal(spaceOf(loader).meta?.typeSchemas?.entity?.Published?.propertySchemas?.title?.type, 'string', 'the subscriber\'s edit outranked the publisher\'s layer');
  });

  it('a space it also shares in a club opens its round in the club only', async () => {
    const clubNet = networkOf('club', [M2], { id: 'club-1', spaces: ['general', 'notes'] });
    clubNet.members[0].url = club.url;
    const loader = await bootWith([subscriberNet(), clubNet]);
    const res = await patchMeta({ meta: { typeSchemas: { entity: { Shared: { propertySchemas: { note: str } } } } } });
    assert.ok(res.code < 300, `${res.code} ${JSON.stringify(res.body)?.slice(0, 300)}`);
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), [], 'the pub/sub network got a schema round');
    assert.equal(roundsOf(loader, 'club-1', 'meta_change').length, 1, 'the club got no schema round: the twin that shows a round would be seen');
  });

  /** The refusal each case below asserts: that network's layer is the publisher's, so the proposal is refused whole before anything is merged or stored. */
  const REFUSED = 'network_layer_is_the_publishers';

  it('a proposal to the pub/sub network\'s own layer is refused, the publisher\'s layer held: nothing is copied into the own definitions', async () => {
    const loader = await bootWith([subscriberNet()]);
    const before = structuredClone(spaceOf(loader).ownMeta ?? null);
    const res = await patchMeta({ meta: { typeSchemas: { entity: { Forged: { propertySchemas: { note: str } } } } }, targetNetwork: NET });
    assert.equal(res.code, 400, `a subscriber's proposal to the publisher's layer answered ${res.code} ${JSON.stringify(res.body)?.slice(0, 300)}`);
    assert.equal(res.body?.code, REFUSED, JSON.stringify(res.body)?.slice(0, 300));
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), []);
    assert.equal(spaceOf(loader).meta?.typeSchemas?.entity?.Forged, undefined, 'the refused proposal landed');
    assert.deepEqual(spaceOf(loader).ownMeta ?? null, before, 'the refused proposal changed the own definitions (the publisher\'s layer was copied into them)');
    assert.deepEqual(loader.getConfig().networks[0].schemaLayers?.notes, LAYER);
  });

  it('the same with no layer held yet: the own schema is not wiped, nothing lands', async () => {
    const net = subscriberNet();
    delete net.schemaLayers;
    const loader = await boot(dir, { spaces: ['notes'], networks: [net] });
    const patched = await patchMeta({ meta: { typeSchemas: { entity: { Mine: { propertySchemas: { note: str } } } } } });
    assert.equal(patched.code, 200, `precondition: ${patched.code} ${JSON.stringify(patched.body)?.slice(0, 300)}`);
    assert.ok(spaceOf(loader).meta?.typeSchemas?.entity?.Mine, 'precondition: the own type is stored');
    const res = await patchMeta({ meta: { typeSchemas: { entity: { Forged: { propertySchemas: { note: str } } } } }, typeSchemasMode: 'replace', targetNetwork: NET });
    assert.equal(res.code, 400, `${res.code} ${JSON.stringify(res.body)?.slice(0, 300)}`);
    assert.equal(res.body?.code, REFUSED, JSON.stringify(res.body)?.slice(0, 300));
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), []);
    assert.ok(spaceOf(loader).meta?.typeSchemas?.entity?.Mine, 'a refused proposal wiped the subscriber\'s own schema');
    assert.equal(spaceOf(loader).meta?.typeSchemas?.entity?.Forged, undefined, 'the refused proposal landed');
  });

  it('MCP schema_update with targetNetwork: the same refusal', async () => {
    const loader = await bootWith([subscriberNet()]);
    const out = await schemaUpdateTool({ typeSchemas: { entity: { Forged: { propertySchemas: { note: str } } } }, targetNetwork: NET });
    assert.equal(out.isError, true, out.text);
    assert.deepEqual(roundsOf(loader, NET, 'meta_change').map(r => r.roundId), []);
    assert.equal(spaceOf(loader).ownMeta?.typeSchemas?.entity?.Forged, undefined, 'the refused proposal landed in the own definitions');
  });
});
