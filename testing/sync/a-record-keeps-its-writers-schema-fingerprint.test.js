/**
 * A record keeps the schema fingerprint its WRITER stamped it with, across the wire, and the fingerprint's schema can be fetched from the member that sent it
 * (bundle-265, Q-737 and Q-738).
 *
 * ## What is asserted
 *
 * Every record carries `schemaFingerprint`: the fingerprint of the variation of the space (its own definitions with each network's layer) its writer validated
 * it against. It replicates and is not hashed, and each member keeps every variation it has used privately, serving it by fingerprint to a member that asks.
 *
 * 1. **A closed network of A and B**, A with an own type `lead` and B with an own type `task`, so A's fingerprint X is not B's Y. A writes an entity: the answer
 *    carries X and B's copy carries X; the two Merkle roots agree (the stamp is not hashed); B fetched X's snapshot from A and serves it, and the text hashes to X.
 * 2. **B updates the entity**: A's copy carries Y, and A fetches Y from B.
 * 3. **A pub/sub network, C subscribing with no own types of its own**: C's fingerprint is the publisher's (a receiver that adds nothing stamps what its upstream
 *    serves), C's write is stamped with it, and C holds it as a LAYER row and no row of its own ("don't copy, just use").
 *
 * ## How it waits, and what it does not
 *
 * Every wait is `syncUntil` (polls, re-triggers, names what it waited for), never a sleep. The record's arrival is awaited first and its stamp asserted after,
 * so a base that stamps nothing fails on "arrived unstamped", not on a timeout. The snapshot route is asked with each instance's own SETUP admin token
 * (`createToken({ admin: true })`, migrated to an admin floor: `schema` at `admin`); `before` asserts that rung once, so a setup token that stops holding it fails
 * with that reason and not with a 403 in the middle of the case.
 *
 * ## Seen red
 *
 * Against the stack as it stood before the bundle (no stamp, no route): the space's meta carries no `schemaFingerprint`, the write answer carries none, the
 * copy on the other side carries none, and `GET /api/sync/schema-snapshot` answers 404 with no code.
 *
 * Run: node --test testing/sync/a-record-keeps-its-writers-schema-fingerprint.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, delWithBody, createTestSpace, mirroredNetwork, pubsubNetwork, syncUntil, readRecord } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const FINGERPRINT = /^[0-9a-f]{64}$/;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

let tokenA, tokenB, tokenC;
let closed, closedSpace, pubsub, pubsubSpace;

const typeSchemas = (name, property) => ({ entity: { [name]: { propertySchemas: { [property]: { type: 'string' } } } } });
const metaOf = async (base, token, space) => {
  const r = await get(base, token, `/api/spaces/${space}/meta`);
  assert.equal(r.status, 200, `GET meta of ${space} answered ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const snapshotOn = (base, token, space, networkId, fp) =>
  get(base, token, `/api/sync/schema-snapshot?spaceId=${encodeURIComponent(space)}&networkId=${encodeURIComponent(networkId)}&fp=${fp}`);
const rootOn = async (base, token, space) => (await get(base, token, `/api/sync/merkle?spaceId=${encodeURIComponent(space)}`)).body?.root;

/** The schema rung of an instance's setup token, asserted: the snapshot route and GET /api/sync/meta both ask `schema:read`. */
async function assertSchemaRung(base, token, who) {
  const me = await get(base, token, '/api/tokens/me');
  assert.equal(me.status, 200, `${who}: GET /api/tokens/me answered ${me.status}`);
  const rung = me.body?.rights?.floor?.schema;
  assert.ok(['read', 'write', 'admin'].includes(rung),
    `${who}'s setup token holds schema:${rung} (rights ${JSON.stringify(me.body?.rights)}): the snapshot route would answer 403 schema_rung, and this case would fail for that and not for what it is about`);
}

/** Poll (re-triggering `syncOn`'s sync) until `base` answers 200 for `fp`'s snapshot, then return it, naming the last answer when it never does. */
async function snapshotArrives({ syncOn, answerOn, space, networkId, fp, what }) {
  let last;
  await syncUntil(syncOn[0], syncOn[1], networkId, async () => {
    last = await snapshotOn(answerOn[0], answerOn[1], space, networkId, fp);
    return last.status === 200;
  }, what, { onTimeout: () => `the last answer of GET /api/sync/schema-snapshot on ${answerOn[0]} was ${last?.status} ${JSON.stringify(last?.body)}` });
  return last.body;
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();
  for (const [who, base, token] of [['A', INSTANCES.a, tokenA], ['B', INSTANCES.b, tokenB], ['C', INSTANCES.c, tokenC]]) await assertSchemaRung(base, token, who);
});

after(async () => {
  await closed?.remove?.();
  await pubsub?.remove?.();
  await closedSpace?.remove?.();
  await pubsubSpace?.remove?.();
});

describe('a closed network of two members that hold different schemas', () => {
  let SPACE, networkId, X, Y, entityId;

  before(async () => {
    closedSpace = await createTestSpace('fpwire', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    SPACE = closedSpace.id;
    // The own types are set BEFORE the network exists, so each space is a plain one and no round carries a layer: X and Y are the two members' own variations.
    const a = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { typeSchemas: typeSchemas('lead', 'stage') } });
    assert.ok(a.status < 300, `own type on A: ${a.status} ${JSON.stringify(a.body)}`);
    // B's variation also allows A's `lead`, so B's edit of A's lead (the last case) conforms on B and is stamped with B's fingerprint: a type outside B's
    // allowlist would be a violation there, and a write that does not conform is unstamped by design (a stamp means full conformance).
    const bTypes = typeSchemas('task', 'owner');
    bTypes.entity.lead = { propertySchemas: { stage: { type: 'string' }, priority: { type: 'string' } } };
    const b = await patch(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { meta: { typeSchemas: bTypes } });
    assert.ok(b.status < 300, `own type on B: ${b.status} ${JSON.stringify(b.body)}`);
    closed = await mirroredNetwork({ label: `fpwire-${RUN}`, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB], merkle: true });
    networkId = closed.networkId;
  });

  it('the snapshot route exists and refuses a malformed fingerprint with its own code', async () => {
    const r = await snapshotOn(INSTANCES.b, tokenB, SPACE, networkId, 'not-a-fingerprint');
    assert.equal(r.status, 400, `GET /api/sync/schema-snapshot answered ${r.status} ${JSON.stringify(r.body)}: the route does not exist on this build`);
    assert.equal(r.body?.code, 'bad_fingerprint', JSON.stringify(r.body));
  });

  it('each space\'s meta names its variation\'s fingerprint, and the two differ', async () => {
    X = (await metaOf(INSTANCES.a, tokenA, SPACE)).schemaFingerprint;
    Y = (await metaOf(INSTANCES.b, tokenB, SPACE)).schemaFingerprint;
    assert.match(String(X), FINGERPRINT, `A's meta carries no fingerprint: ${X}`);
    assert.match(String(Y), FINGERPRINT, `B's meta carries no fingerprint: ${Y}`);
    assert.notEqual(X, Y, 'two members with different own types report one fingerprint, so the stamp could not tell their records apart');
  });

  it('a record A writes is stamped with A\'s fingerprint, and B\'s copy carries it; the roots agree', async () => {
    // X is what the previous case read: an absent one would make every `equal` below compare undefined with undefined.
    assert.match(String(X), FINGERPRINT, 'the fingerprint of A\'s variation was not established by the previous case');
    const w = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${SPACE}/entities`, { name: `Lead ${RUN}`, type: 'lead', properties: { stage: 'new' } });
    assert.equal(w.status, 201, `write on A: ${JSON.stringify(w.body)}`);
    entityId = w.body._id;
    assert.equal(w.body.schemaFingerprint, X, 'the write\'s answer does not carry the fingerprint of the variation it was validated against');

    // Arrival first, stamp after: a base that stamps nothing fails here as "arrived unstamped", not as a timeout.
    let onB;
    await syncUntil(INSTANCES.b, tokenB, networkId, async () => { onB = await readRecord(INSTANCES.b, tokenB, SPACE, 'entities', entityId); return onB.status === 200; },
      `B to hold the entity A wrote (${entityId})`);
    assert.equal(onB.body.schemaFingerprint, X, `B's copy carries ${JSON.stringify(onB.body.schemaFingerprint)}, not the stamp its writer gave it`);
    const onA = await readRecord(INSTANCES.a, tokenA, SPACE, 'entities', entityId);
    assert.equal(onA.body.schemaFingerprint, X, 'A\'s own read of the record does not carry its stamp');

    let rootA, rootB;
    await syncUntil(INSTANCES.b, tokenB, networkId, async () => {
      [rootA, rootB] = [await rootOn(INSTANCES.a, tokenA, SPACE), await rootOn(INSTANCES.b, tokenB, SPACE)];
      return rootA !== undefined && rootA === rootB;
    }, 'A and B to report one Merkle root for the space', { onTimeout: () => `A ${rootA}, B ${rootB}` });
  });

  it('B fetched A\'s snapshot of X and serves it: the text hashes to X, and its links name A\'s own variation', async () => {
    assert.match(String(X), FINGERPRINT, 'the fingerprint of A\'s variation was not established');
    const body = await snapshotArrives({ syncOn: [INSTANCES.b, tokenB], answerOn: [INSTANCES.b, tokenB], space: SPACE, networkId, fp: X, what: `B to hold the schema snapshot ${X.slice(0, 12)} A stamped its record with` });
    assert.equal(body.fp, X);
    assert.equal(sha256(body.text), X, 'the served text does not hash to its fingerprint');
    assert.ok(Array.isArray(body.links?.layers) && Array.isArray(body.links?.served), `links are not the shape the design names: ${JSON.stringify(body.links)}`);
    if (body.links.layers.length === 0) assert.equal(body.links.own, X, 'with no layer, a variation\'s own fingerprint is the variation\'s');
  });

  it('B updates the entity: A\'s copy carries B\'s fingerprint, and A fetches it', async () => {
    assert.match(String(Y), FINGERPRINT, 'the fingerprint of B\'s variation was not established');
    assert.ok(entityId, 'the entity A wrote was not established by the earlier case');
    const u = await patch(INSTANCES.b, tokenB, `/api/brain/spaces/${SPACE}/entities/${entityId}`, { description: `edited on B ${RUN}` });
    assert.ok(u.status < 300, `update on B: ${u.status} ${JSON.stringify(u.body)}`);
    assert.equal(u.body.schemaFingerprint, Y, 'the update\'s answer does not carry the fingerprint of B\'s variation');

    let onA;
    await syncUntil(INSTANCES.a, tokenA, networkId, async () => { onA = await readRecord(INSTANCES.a, tokenA, SPACE, 'entities', entityId); return onA.status === 200 && onA.body.description === `edited on B ${RUN}`; },
      'A to hold B\'s edit of the entity');
    assert.equal(onA.body.schemaFingerprint, Y, `A's copy carries ${JSON.stringify(onA.body.schemaFingerprint)}, not the stamp B gave the version it wrote`);

    const body = await snapshotArrives({ syncOn: [INSTANCES.a, tokenA], answerOn: [INSTANCES.a, tokenA], space: SPACE, networkId, fp: Y, what: `A to hold the schema snapshot ${Y.slice(0, 12)} B stamped its edit with` });
    assert.equal(sha256(body.text), Y, 'the served text does not hash to its fingerprint');
    assert.notEqual(body.text, (await snapshotOn(INSTANCES.a, tokenA, SPACE, networkId, X)).body?.text, 'the two variations are served as one text');
  });
});

describe('a pub/sub subscriber that adds nothing stamps with its publisher\'s fingerprint, and holds it as the publisher\'s layer', () => {
  let SPACE, networkId, F;

  before(async () => {
    pubsubSpace = await createTestSpace('fpwire-ps', [[INSTANCES.a, tokenA]]);
    SPACE = pubsubSpace.id;
    const own = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { typeSchemas: typeSchemas('lead', 'stage') } });
    assert.ok(own.status < 300, `own type on the publisher: ${own.status} ${JSON.stringify(own.body)}`);
    pubsub = await pubsubNetwork({ label: `fpwire-ps-${RUN}`, spaces: [SPACE], publisher: [INSTANCES.a, tokenA, 'ythril-a'], subscriber: [INSTANCES.c, tokenC, 'ythril-c'] });
    networkId = pubsub.networkId;
    await pubsub.adopted(SPACE);
  });

  after(async () => {
    // The network first, or the subscriber adopts the space again on its next cycle; then the space on both ends (the subscriber got its copy by adoption, so
    // `createTestSpace`'s own removal does not reach it).
    await pubsub?.remove?.();
    await delWithBody(INSTANCES.c, tokenC, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
    await pubsubSpace?.remove?.();
  });

  it('the subscriber\'s fingerprint is the publisher\'s', async () => {
    const published = (await metaOf(INSTANCES.a, tokenA, SPACE)).schemaFingerprint;
    F = (await metaOf(INSTANCES.c, tokenC, SPACE)).schemaFingerprint;
    assert.match(String(published), FINGERPRINT, `the publisher's meta carries no fingerprint: ${published}`);
    assert.equal(F, published, 'a subscriber that adds nothing to its publisher\'s layer stamps a fingerprint of its own: one schema, two names');
  });

  it('its write is stamped with it, and it holds that fingerprint as a LAYER row, not a row of its own', async () => {
    assert.match(String(F), FINGERPRINT, 'the subscriber\'s fingerprint was not established by the previous case');
    const w = await post(INSTANCES.c, tokenC, `/api/brain/spaces/${SPACE}/entities`, { name: `Subscriber lead ${RUN}`, type: 'lead', properties: { stage: 'new' } });
    assert.equal(w.status, 201, `write on the subscriber: ${JSON.stringify(w.body)}`);
    assert.equal(w.body.schemaFingerprint, F, 'the subscriber\'s write is not stamped with the fingerprint its meta names');

    const body = await snapshotArrives({ syncOn: [INSTANCES.c, tokenC], answerOn: [INSTANCES.c, tokenC], space: SPACE, networkId, fp: F, what: `C to hold the schema snapshot ${F.slice(0, 12)} it stamped with` });
    assert.equal(sha256(body.text), F);
    assert.equal(body.layerOf, networkId, `the row is not the publisher's layer (layerOf ${JSON.stringify(body.layerOf)}): the subscriber copied a schema it only needed to use`);
    assert.equal(body.links ?? null, null, `a layer row names no links (this server cannot know what its upstream built it from), got ${JSON.stringify(body.links)}`);
  });
});
