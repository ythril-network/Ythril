/**
 * A schema write on a space that sits in two or more networks answers, per network, what happened to it — on every door that
 * writes a schema, and only for a space in more than one network (`R5-1` (a), `R6-8`, Q-67).
 *
 * ## The rule
 *
 * A write to a networked space is a proposal, one round per network carrying the space (`applySpaceMetaUpdate`). On one
 * network the single outcome says it all. On two it does not: a club organiser's yes passes its round at once while a closed
 * network's waits for its members, so one write can be `applied` in one network and `vote_pending` in the other, and the single
 * word the door answered (`202 vote_pending`) hid which. The answer now carries, beside the existing outcome and `rounds`:
 *
 *     layers: [{ networkId, networkLabel, outcome: 'applied' | 'vote_pending' }]    one entry per network carrying the space
 *
 * on REST and MCP alike, whatever the status (202 while any round is open, 200 when every round passed). Later outcomes (a
 * round that fails, a layer that outranks the edit) are NOT in the write answer — they are on `space_schema_layers`.
 * A space in ONE network is answered exactly as before: no `layers` key at all.
 *
 * ## The doors
 *
 * Every route and tool that reaches `applySpaceMetaUpdate`, each one case titled with its door label, over the same fixture: A
 * organises a club (its own yes passes at once) and a closed network with one member it can never hear from (no round can pass
 * on A's yes alone), both carrying the space. The doors are not this file's to choose:
 * `testing/standalone/every-schema-write-door-answers-its-layers.test.js` derives them from the call graph and fails when a
 * door has no case here, so a schema-write door added later cannot go unasked.
 *
 * ## Stack-run
 *
 * Written, NOT run here: it needs the test stack's instance A (`npm run test:up`, then `node testing/sync/setup.js a`). It
 * waits on nothing asynchronous: every answer is read from the response of the write itself.
 *
 * Run: node --test testing/integration/a-multi-network-schema-write-answers-per-network-on-every-door.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { INSTANCES, post, put, patch, get, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const BOTH = `lay-both-${RUN}`;        // in the closed network and the club
const ONLY = `lay-only-${RUN}`;        // in the closed network alone: the single-network control
const CLUBS = `lay-clubs-${RUN}`;      // in two clubs: every round passes at once
const GROUP = `lay-group-${RUN}`;
const ENTRY = `lay-entry-${RUN}`;

let admin, mcp;
const nets = {};
const labels = {};

/** A closed network with one real member by the handshake, so no round can pass on this instance's yes alone. */
async function closedNetworkWithAMember(spaces, label) {
  const n = await post(INSTANCES.a, admin, '/api/networks', { label, type: 'closed', spaces });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId: n.body.id });
  const b = generateKeyPairSync('rsa', { modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const apply = await post(INSTANCES.a, '', '/api/invite/apply', { handshakeId: gen.body.handshakeId, networkId: n.body.id,
    instanceId: '44444444-4444-4444-8444-444444444444', instanceLabel: 'layers peer', instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const enc = publicEncrypt({ key: apply.body.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`)).toString('base64');
  assert.equal((await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: gen.body.handshakeId, encryptedTokenForA: enc })).status, 200);
  return n.body.id;
}
async function club(spaces, label) {
  const n = await post(INSTANCES.a, admin, '/api/networks', { label, type: 'club', spaces });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  return n.body.id;
}

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  for (const id of [BOTH, ONLY, CLUBS]) assert.equal((await post(INSTANCES.a, admin, '/api/spaces', { id, label: id })).status, 201);
  // A type to delete later, written while the spaces are in no network: that path still writes at once.
  for (const id of [BOTH, ONLY, CLUBS]) {
    const seed = await put(INSTANCES.a, admin, `/api/spaces/${id}/meta/typeSchemas/entity/seed`, {});
    assert.ok(seed.status < 300, `${seed.status} ${JSON.stringify(seed.body)}`);
  }
  labels.closed = `lay-closed-${RUN}`; labels.club = `lay-club-${RUN}`; labels.clubA = `lay-cluba-${RUN}`; labels.clubB = `lay-clubb-${RUN}`;
  nets.closed = await closedNetworkWithAMember([BOTH, ONLY], labels.closed);
  nets.club = await club([BOTH], labels.club);
  nets.clubA = await club([CLUBS], labels.clubA);
  nets.clubB = await club([CLUBS], labels.clubB);
  assert.equal((await post(INSTANCES.a, admin, '/api/schema-library', {
    name: ENTRY, knowledgeType: 'entity', typeName: `libtype${RUN}`, schema: { propertySchemas: { x: { type: 'string' } } }, schemaGroup: GROUP,
  })).status, 201);
  mcp = await openMcpSession(admin);
});

after(async () => {
  await mcp?.close?.();
  await del(INSTANCES.a, admin, `/api/schema-library/${encodeURIComponent(ENTRY)}`).catch(() => {});
  for (const id of Object.values(nets)) await del(INSTANCES.a, admin, `/api/networks/${id}`).catch(() => {});
  for (const id of [BOTH, ONLY, CLUBS]) await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

/** One entry per network carrying the space, each saying what became of the write there. */
function assertLayers(body, expected, door) {
  assert.ok(Array.isArray(body.layers), `${door}: no layers array beside the outcome: ${JSON.stringify(body)}`);
  assert.equal(body.layers.length, Object.keys(expected).length, `${door}: one entry per network carrying the space, not ${body.layers.length}: ${JSON.stringify(body.layers)}`);
  for (const [id, want] of Object.entries(expected)) {
    const got = body.layers.find(l => l.networkId === id);
    assert.ok(got, `${door}: no entry for network ${id}: ${JSON.stringify(body.layers)}`);
    assert.equal(got.outcome, want.outcome, `${door}: ${want.label} is ${want.outcome}, the answer says ${got.outcome}`);
    assert.equal(got.networkLabel, want.label, `${door}: the entry does not name the network`);
  }
}
const mixed = () => ({
  [nets.closed]: { outcome: 'vote_pending', label: labels.closed },
  [nets.club]: { outcome: 'applied', label: labels.club },
});

describe('a space in a closed network and a club: pending in one, applied in the other', () => {
  it('PATCH /api/spaces/:id', async () => {
    const r = await patch(INSTANCES.a, admin, `/api/spaces/${BOTH}`, { meta: { purpose: `purpose ${RUN}` } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.status, 'vote_pending');
    assert.equal(r.body.rounds.length, 1, 'the existing rounds list changed: it names the networks whose round is still open');
    assertLayers(r.body, mixed(), 'PATCH');
  });

  it('PUT /api/spaces/:id/schema', async () => {
    const r = await put(INSTANCES.a, admin, `/api/spaces/${BOTH}/schema`, { typeSchemas: { entity: { replaced: {} } } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assertLayers(r.body, mixed(), 'PUT /schema');
  });

  it('PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName', async () => {
    const r = await put(INSTANCES.a, admin, `/api/spaces/${BOTH}/meta/typeSchemas/entity/added`, {});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assertLayers(r.body, mixed(), 'type upsert');
  });

  it('DELETE /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName', async () => {
    const r = await del(INSTANCES.a, admin, `/api/spaces/${BOTH}/meta/typeSchemas/entity/seed`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assertLayers(r.body, mixed(), 'type delete');
  });

  it('POST /api/schema-library/groups/:group/apply', async () => {
    const r = await post(INSTANCES.a, admin, `/api/schema-library/groups/${encodeURIComponent(GROUP)}/apply`, { spaceId: BOTH });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assertLayers(r.body, mixed(), 'library group apply');
  });

  it('MCP schema_update', async () => {
    const r = await tool('schema_update', { space: BOTH, typeSchemas: { entity: { viaMcp: {} } } });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.body.outcome, 'vote_pending');
    assertLayers(r.body, mixed(), 'schema_update');
  });

  it('MCP update_space', async () => {
    const r = await tool('update_space', { space: BOTH, purpose: `purpose over mcp ${RUN}` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.body.outcome, 'vote_pending');
    assertLayers(r.body, mixed(), 'update_space');
  });

  it('the entries are the same on both doors for the same write', async () => {
    const rest = await patch(INSTANCES.a, admin, `/api/spaces/${BOTH}`, { meta: { usageNotes: `notes ${RUN} a` } });
    const viaMcp = await tool('schema_update', { space: BOTH, usageNotes: `notes ${RUN} b` });
    const shape = (layers) => [...layers].map(l => ({ networkId: l.networkId, networkLabel: l.networkLabel, outcome: l.outcome })).sort((x, y) => x.networkId.localeCompare(y.networkId));
    assert.deepEqual(shape(viaMcp.body.layers ?? []), shape(rest.body.layers ?? []));
  });
});

describe('a space in two clubs: every round passes at once', () => {
  it('answers 200 with an applied entry per network, on REST and on MCP', async () => {
    const r = await patch(INSTANCES.a, admin, `/api/spaces/${CLUBS}`, { meta: { purpose: `both clubs ${RUN}` } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertLayers(r.body, { [nets.clubA]: { outcome: 'applied', label: labels.clubA }, [nets.clubB]: { outcome: 'applied', label: labels.clubB } }, 'PATCH, all applied');
    const m = await tool('schema_update', { space: CLUBS, usageNotes: `both clubs, over mcp ${RUN}` });
    assert.equal(m.isError, false, m.text);
    assert.equal(m.body.outcome, 'applied');
    assertLayers(m.body, { [nets.clubA]: { outcome: 'applied', label: labels.clubA }, [nets.clubB]: { outcome: 'applied', label: labels.clubB } }, 'schema_update, all applied');
  });
});

describe('a space in ONE network is answered as before', () => {
  it('REST: 202 with its one round and no layers key', async () => {
    const r = await patch(INSTANCES.a, admin, `/api/spaces/${ONLY}`, { meta: { purpose: `one network ${RUN}` } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.rounds.length, 1);
    assert.equal('layers' in r.body, false, `a single-network answer grew a layers key: ${JSON.stringify(r.body)}`);
  });

  it('MCP: vote_pending with its one round and no layers key', async () => {
    const r = await tool('schema_update', { space: ONLY, usageNotes: `one network ${RUN}` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.body.outcome, 'vote_pending');
    assert.equal(r.body.rounds.length, 1);
    assert.equal('layers' in r.body, false, `a single-network answer grew a layers key: ${JSON.stringify(r.body)}`);
  });

  it('a space in no network: no layers key either', async () => {
    const lone = `lay-lone-${RUN}`;
    assert.equal((await post(INSTANCES.a, admin, '/api/spaces', { id: lone, label: lone })).status, 201);
    try {
      const r = await patch(INSTANCES.a, admin, `/api/spaces/${lone}`, { meta: { purpose: 'alone' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal('layers' in r.body, false);
      assert.equal((await get(INSTANCES.a, admin, `/api/spaces/${lone}/meta`)).body.purpose, 'alone');
    } finally {
      await delWithBody(INSTANCES.a, admin, `/api/spaces/${lone}`, { confirm: true }).catch(() => {});
    }
  });
});
